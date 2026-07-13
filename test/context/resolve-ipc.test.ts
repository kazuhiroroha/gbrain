/**
 * Retrieval Reflex resolve IPC round-trip tests (#1981, T3/T5).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSocketPath,
  startResolveIpcServer,
  resolveViaIpc,
  IPC_UNAVAILABLE,
  authorizeResolveRequest,
} from '../../src/core/context/resolve-ipc.ts';
import type { PointerBlock } from '../../src/core/context/retrieval-reflex.ts';
import { withEnv } from '../helpers/with-env.ts';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rr-ipc-'));
}

describe('resolve IPC', () => {
  const principals = JSON.stringify({ version: 1, principals: { 'telegram:111': 'han' } });
  const routing = (state: 'old' | 'shadow' = 'old') => JSON.stringify({ version: 1, state, roles: {
    'business-shared': 'business-shared', 'business-evidence': 'business-evidence',
    'openclaw-episodic': 'openclaw-episodic', 'owner-han-private': 'owner-han-private',
    'owner-hamid-private': 'owner-hamid-private',
    'owner-admin-450544615-private': 'owner-admin-450544615-private',
  } });
  const direct = { chatType: 'direct', messageProvider: 'telegram', senderId: '111' };

  test('pure authorization recomputes sources and requires matching token for private direct access', () => {
    const req = authorizeResolveRequest({
      candidates: [{ display: 'Alice', query: 'Alice' }], requesterContext: direct, ipcToken: 'secret-token',
    }, principals, 'secret-token', routing());
    expect(req?.sourceIds).toEqual(['business-shared', 'business-evidence', 'openclaw-episodic', 'owner-han-private']);
    expect(authorizeResolveRequest({ candidates: [{ display: 'Alice', query: 'Alice' }], requesterContext: direct }, principals, 'secret-token', routing())).toBeNull();
    expect(authorizeResolveRequest({ candidates: [{ display: 'Alice', query: 'Alice' }], requesterContext: direct, ipcToken: 'wrong' }, principals, 'secret-token', routing())).toBeNull();
  });

  test('tokenless server narrows direct access to shared while groups remain shared-only', () => {
    expect(authorizeResolveRequest({ candidates: [{ display: 'A', query: 'A' }], requesterContext: direct }, principals, undefined, routing())?.sourceIds)
      .toEqual(['business-shared', 'business-evidence']);
    expect(authorizeResolveRequest({ candidates: [{ display: 'A', query: 'A' }], requesterContext: { chatType: 'group' } }, principals, 'configured', routing())?.sourceIds)
      .toEqual(['business-shared', 'business-evidence']);
  });

  test('server routing alone authorizes v2 shadow and malformed routing retrieves nothing', () => {
    const wire = { candidates: [{ display: 'A', query: 'A' }], requesterContext: { chatType: 'group' } };
    expect(authorizeResolveRequest(wire, principals, undefined, routing('shadow'))).toMatchObject({
      sourceIds: ['business-shared', 'business-evidence'], shadowSource: 'business-shared-v2', routingState: 'shadow',
    });
    expect(authorizeResolveRequest(wire, principals, undefined, '{')).toBeNull();
    expect(authorizeResolveRequest({ ...wire, sourceIds: ['business-shared-v2'] }, principals, undefined, routing('shadow'))).toBeNull();
  });

  test.each([
    {},
    { candidates: 'Alice', requesterContext: direct },
    { candidates: [{ display: 'A', query: 'A' }], requesterContext: direct, priorContextText: 7 },
    { candidates: [{ display: 'A', query: 'A' }], requesterContext: direct, suppression: 'all' },
    { candidates: [{ display: 'A', query: 'A' }], requesterContext: direct, maxPointers: 0 },
    { candidates: [{ display: 'A', query: 'A' }], requesterContext: direct, sourceIds: ['owner-han-private'] },
  ])('pure validation rejects malformed or client-authoritative request %#', (wire) => {
    expect(authorizeResolveRequest(wire, principals, undefined, routing())).toBeNull();
  });

  test('round-trip: client gets the pointer block the server returns', async () => {
    await withEnv({ GBRAIN_OPENCLAW_PRINCIPALS_JSON: principals, GBRAIN_OPENCLAW_SOURCE_ROUTING_JSON: routing() }, async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const block: PointerBlock = {
      pointers: [{ display: 'Alice', slug: 'people/alice', source_id: 'business-shared', synopsis: 'x', arm: 'alias', confidence: 0.9 }],
      text: 'BLOCK',
    };
    const server = await startResolveIpcServer(sock, async (req) => {
      expect(req.candidates[0].query).toBe('Alice');
      expect(req.sourceIds).toEqual(['business-shared', 'business-evidence']);
      return block;
    });
    expect(server).not.toBeNull();
    servers.push(server!);

    const got = await resolveViaIpc(sock, { candidates: [{ display: 'Alice', query: 'Alice' }], requesterContext: { chatType: 'group' } });
    expect(got).not.toBe(IPC_UNAVAILABLE);
    expect((got as PointerBlock).text).toBe('BLOCK');
    rmSync(dir, { recursive: true, force: true });
    });
  });

  test('absent socket → IPC_UNAVAILABLE (caller falls through ladder)', async () => {
    const dir = tmpDir();
    const got = await resolveViaIpc(resolveSocketPath(dir), { candidates: [{ display: 'A', query: 'A' }], requesterContext: { chatType: 'group' } });
    expect(got).toBe(IPC_UNAVAILABLE);
    rmSync(dir, { recursive: true, force: true });
  });

  test('server returning null relays as null (resolved, nothing found)', async () => {
    await withEnv({ GBRAIN_OPENCLAW_PRINCIPALS_JSON: principals, GBRAIN_OPENCLAW_SOURCE_ROUTING_JSON: routing() }, async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, async () => null);
    servers.push(server!);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }], requesterContext: { chatType: 'group' } });
    expect(got).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    });
  });

  test('stale socket file is cleaned up so a fresh server can bind', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const s1 = await startResolveIpcServer(sock, async () => null);
    servers.push(s1!);
    s1!.close();
    // bind again at the same path — startResolveIpcServer must unlink the stale file
    const s2 = await startResolveIpcServer(sock, async () => null);
    expect(s2).not.toBeNull();
    servers.push(s2!);
    expect(existsSync(sock)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
