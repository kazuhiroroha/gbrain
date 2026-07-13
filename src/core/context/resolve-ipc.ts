/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own and must NOT shell out to
 * a subprocess (that would force-steal the lock past the 5-min staleness window
 * and crash the brain — see plan D9 rejected option). Instead, `serve`
 * optionally listens on a local unix-domain socket and answers a NARROW request
 * — candidates in, pointers out — using the connection it already owns. Both
 * ends are gbrain code; raw SQL never crosses the wire (closes the trust hole).
 *
 * Protocol: newline-delimited JSON. One request line, one response line.
 *   req:  { candidates, requesterContext, priorContextText?, maxPointers?, ipcToken? }
 *   resp: { ok: true, block: PointerBlock | null } | { ok: false, error }
 *
 * Local-only (unix socket on the brain's data dir, mode 0600) — no network
 * surface. Same-UID socket access is not private-source authorization: the
 * server recomputes requester policy and separately verifies the IPC token.
 */

import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityCandidate } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';
import { resolveSourceAccess, type RequesterContext } from './source-access-policy.ts';

const SOCK_NAME = '.gbrain-resolve.sock';
const CLIENT_TIMEOUT_MS = 250;
const MAX_MSG_BYTES = 256 * 1024;

/** Marker the client returns when no server is reachable (vs. a real null result). */
export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

export interface ResolveRequest {
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceIds: readonly string[];
  requesterContext: Readonly<RequesterContext>;
  /** v0.43 (#2095, codex D7): suppression mode — 'slug-only' under windowing. */
  suppression?: 'slug-and-title' | 'slug-only';
}

export interface ResolveWireRequest {
  candidates: EntityCandidate[];
  requesterContext: Readonly<RequesterContext>;
  priorContextText?: string;
  maxPointers?: number;
  suppression?: 'slug-and-title' | 'slug-only';
  ipcToken?: string;
}

const WIRE_KEYS = new Set(['candidates', 'requesterContext', 'priorContextText', 'maxPointers', 'suppression', 'ipcToken']);
const REQUESTER_KEYS = new Set(['messageChannel', 'messageProvider', 'chatType', 'senderId', 'senderIsOwner', 'groupId', 'agentAccountId', 'trigger']);
const SHARED = ['business-shared', 'business-evidence'] as const;
const MAX_TOKEN_BYTES = 512;

function validToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && Buffer.byteLength(token) <= MAX_TOKEN_BYTES;
}

function tokenMatches(got: unknown, expected: string): boolean {
  if (!validToken(got) || !validToken(expected)) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Validate an untrusted socket payload and recompute authorization server-side.
 * The 0600 same-UID Unix socket is transport confinement, not private-source
 * authorization; private/episodic access additionally requires the shared IPC token.
 */
export function authorizeResolveRequest(
  input: unknown,
  principalsRaw = process.env.GBRAIN_OPENCLAW_PRINCIPALS_JSON,
  serverToken = process.env.GBRAIN_REFLEX_IPC_TOKEN,
): ResolveRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !WIRE_KEYS.has(key))) return null;
  if (!Array.isArray(raw.candidates) || raw.candidates.length > 12) return null;
  const candidates: EntityCandidate[] = [];
  for (const candidate of raw.candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const c = candidate as Record<string, unknown>;
    if (Object.keys(c).some((key) => key !== 'display' && key !== 'query')) return null;
    if (typeof c.display !== 'string' || typeof c.query !== 'string' || !c.display || !c.query || c.display.length > 256 || c.query.length > 256) return null;
    candidates.push({ display: c.display, query: c.query });
  }
  if (!raw.requesterContext || typeof raw.requesterContext !== 'object' || Array.isArray(raw.requesterContext)) return null;
  const requester = raw.requesterContext as Record<string, unknown>;
  if (Object.keys(requester).some((key) => !REQUESTER_KEYS.has(key))) return null;
  for (const [key, value] of Object.entries(requester)) {
    if (key === 'senderIsOwner') { if (typeof value !== 'boolean') return null; }
    else if (typeof value !== 'string' || value.length > 256) return null;
  }
  if (raw.priorContextText !== undefined && (typeof raw.priorContextText !== 'string' || raw.priorContextText.length > 20_000)) return null;
  if (raw.suppression !== undefined && raw.suppression !== 'slug-and-title' && raw.suppression !== 'slug-only') return null;
  if (raw.maxPointers !== undefined && (!Number.isInteger(raw.maxPointers) || (raw.maxPointers as number) < 1 || (raw.maxPointers as number) > 20)) return null;
  if (raw.ipcToken !== undefined && !validToken(raw.ipcToken)) return null;

  const requesterContext = requester as Readonly<RequesterContext>;
  const access = resolveSourceAccess(requesterContext, principalsRaw);
  if (!access.sourceIds.length) return null;
  const needsPrivate = access.sourceIds.some((id) => !SHARED.includes(id as typeof SHARED[number]));
  let sourceIds = access.sourceIds;
  if (needsPrivate) {
    if (!validToken(serverToken)) sourceIds = SHARED;
    else if (!tokenMatches(raw.ipcToken, serverToken)) return null;
  }
  return { candidates, requesterContext, sourceIds, priorContextText: raw.priorContextText as string | undefined,
    maxPointers: raw.maxPointers as number | undefined, suppression: raw.suppression as ResolveRequest['suppression'] };
}

export type ResolveHandler = (req: ResolveRequest) => Promise<PointerBlock | null>;

/** Canonical socket path for a PGLite data dir. */
export function resolveSocketPath(dataDir: string): string {
  return join(dataDir, SOCK_NAME);
}

/**
 * Client: ship candidates to a running serve, get pointers back. Returns
 * IPC_UNAVAILABLE when no server is listening (caller falls through the ladder);
 * a real PointerBlock | null otherwise. Never throws — fail-soft to UNAVAILABLE.
 */
export async function resolveViaIpc(
  socketPath: string,
  req: ResolveWireRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  if (!existsSync(socketPath)) return IPC_UNAVAILABLE;
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: PointerBlock | null | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    sock.setTimeout(CLIENT_TIMEOUT_MS);
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_MSG_BYTES) return finish(IPC_UNAVAILABLE);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const resp = JSON.parse(buf.slice(0, nl));
        if (resp && resp.ok) return finish(resp.block ?? null);
        return finish(IPC_UNAVAILABLE);
      } catch {
        return finish(IPC_UNAVAILABLE);
      }
    });
    // Any error (ENOENT, ECONNREFUSED, stale socket), timeout, or close before
    // a response → treat as unavailable, fall through the ladder.
    sock.on('timeout', () => finish(IPC_UNAVAILABLE));
    sock.on('error', () => finish(IPC_UNAVAILABLE));
    sock.on('close', () => finish(IPC_UNAVAILABLE));
  });
}

/**
 * Server: start a resolve listener on `socketPath`. Cleans up a stale socket
 * left by a dead owner first. Returns the net.Server (caller closes on
 * shutdown). Errors are swallowed (best-effort feature) — returns null if the
 * socket can't be bound.
 */
export async function startResolveIpcServer(
  socketPath: string,
  handler: ResolveHandler,
  /**
   * v0.43 (#2095, red-team): fired ONLY after the response was successfully
   * written to the client — the accept-side seam for reflex-channel feedback
   * logging. A block the client never received (timeout, dead socket) was
   * never injected into a prompt and must not count as "volunteered".
   */
  onDelivered?: (block: PointerBlock, req: ResolveRequest) => void,
): Promise<net.Server | null> {
  // Remove a stale socket file if present (a previous serve that didn't clean up).
  cleanupStaleSocket(socketPath);

  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', async (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_MSG_BYTES) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let resp: string;
        let delivered: { block: PointerBlock; req: ResolveRequest } | null = null;
        try {
          const req = authorizeResolveRequest(JSON.parse(line));
          if (!req) throw new Error('invalid resolve request');
          const block = await handler(req);
          resp = JSON.stringify({ ok: true, block });
          if (block) delivered = { block, req };
        } catch (e) {
          resp = JSON.stringify({ ok: false, error: (e as Error).message });
        }
        try {
          conn.write(resp + '\n');
          // Write accepted — the client (250ms budget) may still have hung
          // up, but this is the closest observable delivery point.
          if (delivered && onDelivered) {
            try { onDelivered(delivered.block, delivered.req); } catch { /* telemetry only */ }
          }
        } catch { /* client gone — do NOT log undelivered pointers */ }
        conn.end();
      });
      conn.on('error', () => { try { conn.destroy(); } catch { /* noop */ } });
    });
    server.on('error', () => resolve(null));
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}

/** Remove a socket file whose owning process is gone (or any leftover file). */
export function cleanupStaleSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      // A unix socket shows up as a socket file; unlink unconditionally — if a
      // live server holds it, listen() below would fail and we return null.
      const st = statSync(socketPath);
      if (st.isSocket() || st.isFIFO() || st.isFile()) unlinkSync(socketPath);
    }
  } catch {
    /* best effort */
  }
}
