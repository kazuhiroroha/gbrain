export const LOGICAL_SOURCE_ROLES = Object.freeze([
  'business-shared',
  'business-evidence',
  'openclaw-episodic',
  'owner-han-private',
  'owner-hamid-private',
  'owner-admin-450544615-private',
] as const);

export type LogicalSourceRole = (typeof LOGICAL_SOURCE_ROLES)[number];
export type SourceRoutingState = 'old' | 'shadow' | 'switched' | 'rollback';

export interface SourceRouting {
  readonly version: 1;
  readonly state: SourceRoutingState;
  readonly roles: Readonly<Record<LogicalSourceRole, string>>;
  readonly shadow: Readonly<{ logicalRole: 'business-shared'; physicalSourceId: 'business-shared-v2' }> | null;
}

const MAX_ROUTING_BYTES = 64 * 1024;
const ROLE_SET = new Set<string>(LOGICAL_SOURCE_ROLES);
const STATE_SET = new Set<string>(['old', 'shadow', 'switched', 'rollback']);
const EMPTY_SOURCES: readonly string[] = Object.freeze([]);

function hasDuplicateObjectKeys(raw: string): boolean {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(raw[offset] ?? '')) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(raw.slice(start, offset)) as string;
    }
    throw new Error('unterminated string');
  };
  const value = (): boolean => {
    whitespace();
    if (raw[offset] === '{') {
      offset++;
      const keys = new Set<string>();
      whitespace();
      if (raw[offset] === '}') { offset++; return false; }
      while (true) {
        whitespace();
        if (raw[offset] !== '"') throw new Error('object key expected');
        const key = string();
        if (keys.has(key)) return true;
        keys.add(key);
        whitespace();
        if (raw[offset++] !== ':') throw new Error('colon expected');
        if (value()) return true;
        whitespace();
        const separator = raw[offset++];
        if (separator === '}') return false;
        if (separator !== ',') throw new Error('comma expected');
      }
    }
    if (raw[offset] === '[') {
      offset++;
      whitespace();
      if (raw[offset] === ']') { offset++; return false; }
      while (true) {
        if (value()) return true;
        whitespace();
        const separator = raw[offset++];
        if (separator === ']') return false;
        if (separator !== ',') throw new Error('comma expected');
      }
    }
    if (raw[offset] === '"') { string(); return false; }
    const match = raw.slice(offset).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
    if (!match) throw new Error('value expected');
    offset += match[0].length;
    return false;
  };
  const duplicate = value();
  whitespace();
  if (offset !== raw.length) throw new Error('trailing input');
  return duplicate;
}

export function parseSourceRouting(raw: string | undefined): SourceRouting | null {
  if (!raw || raw.length > MAX_ROUTING_BYTES || new TextEncoder().encode(raw).byteLength > MAX_ROUTING_BYTES) return null;
  try {
    if (hasDuplicateObjectKeys(raw)) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const top = parsed as Record<string, unknown>;
    if (Object.keys(top).length !== 3 || top.version !== 1 || !STATE_SET.has(String(top.state))) return null;
    if (!top.roles || typeof top.roles !== 'object' || Array.isArray(top.roles)) return null;
    const entries = Object.entries(top.roles as Record<string, unknown>);
    if (entries.length !== LOGICAL_SOURCE_ROLES.length || entries.some(([role]) => !ROLE_SET.has(role))) return null;

    const state = top.state as SourceRoutingState;
    const roles = top.roles as Record<LogicalSourceRole, unknown>;
    for (const role of LOGICAL_SOURCE_ROLES) {
      const expected = role === 'business-shared' && state === 'switched' ? 'business-shared-v2' : role;
      if (roles[role] !== expected) return null;
    }
    const frozenRoles = Object.freeze({ ...roles }) as Readonly<Record<LogicalSourceRole, string>>;
    const shadow = state === 'shadow'
      ? Object.freeze({ logicalRole: 'business-shared' as const, physicalSourceId: 'business-shared-v2' as const })
      : null;
    return Object.freeze({ version: 1, state, roles: frozenRoles, shadow });
  } catch {
    return null;
  }
}

export function resolvePhysicalSources(
  logicalRoles: readonly LogicalSourceRole[],
  routing: SourceRouting | null,
): readonly string[] {
  if (!routing || logicalRoles.some((role) => !ROLE_SET.has(role))) return EMPTY_SOURCES;
  return Object.freeze(logicalRoles.map((role) => routing.roles[role]));
}
