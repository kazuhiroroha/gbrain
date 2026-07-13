import { describe, expect, test } from 'bun:test';
import { LOGICAL_SOURCE_ROLES, parseSourceRouting, resolvePhysicalSources } from '../../src/core/context/source-routing.ts';

const roleMap = (shared = 'business-shared') => ({
  'business-shared': shared,
  'business-evidence': 'business-evidence',
  'openclaw-episodic': 'openclaw-episodic',
  'owner-han-private': 'owner-han-private',
  'owner-hamid-private': 'owner-hamid-private',
  'owner-admin-450544615-private': 'owner-admin-450544615-private',
});

const routingJson = (state: string, shared?: string) => JSON.stringify({ version: 1, state, roles: roleMap(shared) });

describe('logical source routing', () => {
  test('defines exactly the six authorization roles', () => {
    expect(LOGICAL_SOURCE_ROLES).toEqual([
      'business-shared', 'business-evidence', 'openclaw-episodic',
      'owner-han-private', 'owner-hamid-private', 'owner-admin-450544615-private',
    ]);
    expect(LOGICAL_SOURCE_ROLES).not.toContain('business-shared-v2');
    expect(Object.isFrozen(LOGICAL_SOURCE_ROLES)).toBe(true);
  });

  test.each(['old', 'rollback'] as const)('%s routes shared to the old physical source', (state) => {
    const routing = parseSourceRouting(routingJson(state));
    expect(routing).toEqual({ version: 1, state, roles: roleMap(), shadow: null });
    expect(resolvePhysicalSources(['business-shared', 'business-evidence'], routing))
      .toEqual(['business-shared', 'business-evidence']);
  });

  test('shadow keeps the old primary and derives the v2 shadow route', () => {
    const routing = parseSourceRouting(routingJson('shadow'));
    expect(routing).toEqual({
      version: 1, state: 'shadow', roles: roleMap(),
      shadow: { logicalRole: 'business-shared', physicalSourceId: 'business-shared-v2' },
    });
    expect(resolvePhysicalSources(['business-shared'], routing)).toEqual(['business-shared']);
    expect(Object.isFrozen(routing)).toBe(true);
    expect(Object.isFrozen(routing?.roles)).toBe(true);
    expect(Object.isFrozen(routing?.shadow)).toBe(true);
  });

  test('switched routes shared to v2 without granting v2 as a logical role', () => {
    const routing = parseSourceRouting(routingJson('switched', 'business-shared-v2'));
    expect(routing?.shadow).toBeNull();
    expect(resolvePhysicalSources(['business-shared', 'owner-han-private'], routing))
      .toEqual(['business-shared-v2', 'owner-han-private']);
  });

  test.each([
    undefined, '', '{',
    JSON.stringify({ version: 2, state: 'old', roles: roleMap() }),
    JSON.stringify({ version: 1, state: 'invalid', roles: roleMap() }),
    JSON.stringify({ version: 1, state: 'old', roles: roleMap(), extra: true }),
    JSON.stringify({ version: 1, state: 'old', roles: { ...roleMap(), extra: 'extra' } }),
    JSON.stringify({ version: 1, state: 'old', roles: { 'business-shared': 'business-shared' } }),
    routingJson('old', 'business-shared-v2'),
    routingJson('switched', 'business-shared'),
    JSON.stringify({ version: 1, state: 'old', roles: { ...roleMap(), 'business-evidence': 'other' } }),
    `{"version":1,"state":"old","state":"shadow","roles":${JSON.stringify(roleMap())}}`,
    `{"version":1,"state":"old","roles":{"business-shared":"business-shared","business-shared":"business-shared-v2","business-evidence":"business-evidence","openclaw-episodic":"openclaw-episodic","owner-han-private":"owner-han-private","owner-hamid-private":"owner-hamid-private","owner-admin-450544615-private":"owner-admin-450544615-private"}}`,
    ' '.repeat(64 * 1024 + 1),
  ])('invalid, incomplete, duplicate, mismatched, or oversized routing fails closed', (raw) => {
    expect(parseSourceRouting(raw)).toBeNull();
  });

  test('null routing and unknown logical roles resolve to an immutable empty list', () => {
    const emptyFromNull = resolvePhysicalSources(['business-shared'], null);
    const emptyFromUnknown = resolvePhysicalSources(['business-shared-v2' as never], parseSourceRouting(routingJson('old')));
    expect(emptyFromNull).toEqual([]);
    expect(emptyFromUnknown).toEqual([]);
    expect(Object.isFrozen(emptyFromNull)).toBe(true);
    expect(Object.isFrozen(emptyFromUnknown)).toBe(true);
  });
});
