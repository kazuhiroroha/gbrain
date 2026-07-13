export type OpenClawPrincipal = 'han' | 'hamid' | 'admin';

export interface RequesterContext {
  messageChannel?: string;
  messageProvider?: string;
  chatType?: string;
  senderId?: string;
  senderIsOwner?: boolean;
  groupId?: string;
  agentAccountId?: string;
  trigger?: string;
}

export interface SourceAccessDecision {
  readonly principal: OpenClawPrincipal | null;
  readonly contextKind: 'direct' | 'group-like' | 'unsupported';
  readonly sourceIds: readonly string[];
  readonly reason: string;
}

const DIRECT_SOURCES: Record<OpenClawPrincipal, readonly string[]> = {
  han: ['business-shared', 'business-evidence', 'openclaw-episodic', 'owner-han-private'],
  hamid: ['business-shared', 'business-evidence', 'owner-hamid-private'],
  admin: ['business-shared', 'business-evidence', 'owner-admin-450544615-private'],
};
const SHARED_SOURCES = ['business-shared', 'business-evidence'] as const;
const GROUP_LIKE = new Set(['group', 'channel', 'thread']);
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SENDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function normalizeSourceIds(sourceIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of sourceIds) {
    if (typeof id !== 'string' || !SOURCE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function decision(
  principal: OpenClawPrincipal | null,
  contextKind: SourceAccessDecision['contextKind'],
  sourceIds: readonly string[],
  reason: string,
): SourceAccessDecision {
  return Object.freeze({ principal, contextKind, sourceIds: Object.freeze([...sourceIds]), reason });
}

function parsePolicy(raw: string | undefined): ReadonlyMap<string, OpenClawPrincipal> | null {
  if (!raw || raw.length > 64 * 1024) return null;
  try {
    // JSON.parse silently keeps the last duplicate. Reject duplicate object keys
    // before parsing so an owner-gated policy cannot be reinterpreted.
    const keys = [...raw.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    if (new Set(keys).size !== keys.length) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const top = value as Record<string, unknown>;
    if (Object.keys(top).length !== 2 || top.version !== 1 || !('principals' in top)) return null;
    if (!top.principals || typeof top.principals !== 'object' || Array.isArray(top.principals)) return null;
    const entries = Object.entries(top.principals as Record<string, unknown>);
    const result = new Map<string, OpenClawPrincipal>();
    for (const [key, principal] of entries) {
      const colon = key.indexOf(':');
      if (colon <= 0 || colon !== key.lastIndexOf(':')) return null;
      const provider = key.slice(0, colon);
      const senderId = key.slice(colon + 1);
      if (!PROVIDER_RE.test(provider) || !SENDER_RE.test(senderId)) return null;
      if (principal !== 'han' && principal !== 'hamid' && principal !== 'admin') return null;
      result.set(key, principal);
    }
    return result;
  } catch {
    return null;
  }
}

export function resolveSourceAccess(
  requester: RequesterContext | undefined,
  rawPolicy: string | undefined = process.env.GBRAIN_OPENCLAW_PRINCIPALS_JSON,
): SourceAccessDecision {
  const principals = parsePolicy(rawPolicy);
  const chatType = requester?.chatType?.trim().toLowerCase();
  const kind = chatType === 'direct' ? 'direct' : GROUP_LIKE.has(chatType ?? '') ? 'group-like' : 'unsupported';
  if (!principals) return decision(null, kind, [], 'policy-invalid');
  if (kind === 'group-like') return decision(null, kind, SHARED_SOURCES, 'group-like-shared');
  if (kind !== 'direct') return decision(null, kind, [], 'context-unsupported');

  const provider = requester?.messageProvider?.trim().toLowerCase();
  const senderId = requester?.senderId?.trim();
  if (!provider || !senderId || !PROVIDER_RE.test(provider) || !SENDER_RE.test(senderId)) {
    return decision(null, 'direct', [], 'requester-invalid');
  }
  const principal = principals.get(`${provider}:${senderId}`) ?? null;
  return principal
    ? decision(principal, 'direct', DIRECT_SOURCES[principal], 'direct-principal-mapped')
    : decision(null, 'direct', [], 'principal-unmapped');
}
