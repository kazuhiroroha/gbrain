import { describe, expect, test } from 'bun:test';
import { normalizeSourceIds, resolveSourceAccess } from '../../src/core/context/source-access-policy.ts';

const policy = JSON.stringify({
  version: 1,
  principals: {
    'telegram:111': 'han',
    'telegram:222': 'hamid',
    'telegram:450544615': 'admin',
  },
});

describe('OpenClaw source access policy', () => {
  test.each([
    ['han', '111', ['business-shared', 'business-evidence', 'openclaw-episodic', 'owner-han-private']],
    ['hamid', '222', ['business-shared', 'business-evidence', 'owner-hamid-private']],
    ['admin', '450544615', ['business-shared', 'business-evidence', 'owner-admin-450544615-private']],
  ] as const)('maps direct %s to its exact ordered sources', (principal, senderId, sourceIds) => {
    const got = resolveSourceAccess({ chatType: 'direct', messageProvider: ' Telegram ', senderId }, policy);
    expect(got).toEqual({ principal, contextKind: 'direct', sourceIds, reason: 'direct-principal-mapped' });
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.sourceIds)).toBe(true);
  });

  test.each(['group', 'channel', 'thread'] as const)('%s is shared-only independent of sender', (chatType) => {
    expect(resolveSourceAccess({ chatType, messageProvider: 'telegram', senderId: '111' }, policy)).toEqual({
      principal: null, contextKind: 'group-like', sourceIds: ['business-shared', 'business-evidence'], reason: 'group-like-shared',
    });
  });

  test('unknown, missing, and unsupported contexts fail closed', () => {
    expect(resolveSourceAccess({ chatType: 'direct', messageProvider: 'telegram', senderId: '999' }, policy).sourceIds).toEqual([]);
    expect(resolveSourceAccess({ chatType: 'direct', messageProvider: 'telegram' }, policy).sourceIds).toEqual([]);
    expect(resolveSourceAccess({ chatType: 'broadcast', messageProvider: 'telegram', senderId: '111' }, policy).sourceIds).toEqual([]);
  });

  test('source validation deduplicates without reordering and drops unsafe IDs', () => {
    expect(normalizeSourceIds(['business-shared', '../private', 'business-shared', '', 'owner-han-private']))
      .toEqual(['business-shared', 'owner-han-private']);
  });

  test.each([
    '{',
    '{"version":2,"principals":{}}',
    '{"version":1,"principals":{},"extra":true}',
    '{"version":1,"principals":{"telegram:111":"root"}}',
    '{"version":1,"principals":{"Telegram:111":"han"}}',
    '{"version":1,"principals":{"telegram:111":"han","telegram:111":"hamid"}}',
  ])('malformed policy fails closed even for groups', (raw) => {
    expect(resolveSourceAccess({ chatType: 'group', messageProvider: 'telegram', senderId: '111' }, raw).sourceIds).toEqual([]);
  });
});
