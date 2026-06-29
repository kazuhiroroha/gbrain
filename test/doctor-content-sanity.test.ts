import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ContentSanityAuditEvent } from '../src/core/audit/content-sanity-audit.ts';
import { summarizeActiveContentSanityEvents } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('business-shared', 'Business Shared', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
});

function event(overrides: Partial<ContentSanityAuditEvent>): ContentSanityAuditEvent {
  return {
    ts: '2026-06-29T00:00:00.000Z',
    event_type: 'warn',
    slug: 'reports/old-big-report',
    source_id: 'business-shared',
    bytes: 600_000,
    junk_pattern_matches: [],
    literal_substring_matches: [],
    reason_messages: ['PAGE_OVERSIZED: body 600000 bytes exceeds threshold'],
    ...overrides,
  };
}

describe('doctor content-sanity active audit summary', () => {
  test('resolved old oversize audit events are ignored when current page is split or below warn threshold', async () => {
    await engine.putPage('reports/old-big-report/part-001', {
      type: 'note',
      title: 'part',
      compiled_truth: 'small current replacement',
      timeline: '',
    }, { sourceId: 'business-shared' });

    const summary = await summarizeActiveContentSanityEvents(engine, [
      event({ event_type: 'soft_block', slug: 'reports/old-big-report' }),
      event({ event_type: 'warn', slug: 'reports/old-big-report/part-001', bytes: 600_000 }),
    ], { bytesWarn: 50_000, bytesBlock: 500_000 });

    expect(summary.events).toHaveLength(0);
    expect(summary.resolved_count).toBe(2);
  });

  test('current oversize or marked pages remain active audit events', async () => {
    await engine.putPage('reports/still-big', {
      type: 'note',
      title: 'big',
      compiled_truth: 'x'.repeat(60_000),
      timeline: '',
    }, { sourceId: 'business-shared' });
    await engine.putPage('reports/marked', {
      type: 'note',
      title: 'marked',
      compiled_truth: 'small',
      timeline: '',
      frontmatter: { content_flag: 'oversized' },
    }, { sourceId: 'business-shared' });

    const summary = await summarizeActiveContentSanityEvents(engine, [
      event({ event_type: 'warn', slug: 'reports/still-big', bytes: 60_000 }),
      event({ event_type: 'flag', slug: 'reports/marked', bytes: 10 }),
    ], { bytesWarn: 50_000, bytesBlock: 500_000 });

    expect(summary.events.map(e => e.slug).sort()).toEqual(['reports/marked', 'reports/still-big']);
    expect(summary.resolved_count).toBe(0);
  });

  test('hard audit events stay active even if the page never landed', async () => {
    const summary = await summarizeActiveContentSanityEvents(engine, [
      event({ event_type: 'reject', slug: 'reports/rejected-junk' }),
    ], { bytesWarn: 50_000, bytesBlock: 500_000 });

    expect(summary.events).toHaveLength(1);
    expect(summary.events[0].slug).toBe('reports/rejected-junk');
  });
});
