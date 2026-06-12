/**
 * v0.43 (#2084 drain hoist, closes TODOS P3) — drainThenDisconnect unit tests.
 *
 * One helper owns every CLI owner-disconnect: drain the background-work
 * registry FIRST, then disconnect (best-effort), bounded by the unref'd
 * hard-deadline. Pre-hoist, six bare sites (search dashboard, doctor
 * remediation, ze-switch, dream, read-only timeout path) skipped the drain —
 * an in-flight fire-and-forget write was killed at disconnect/exit.
 */

import { describe, test, expect } from 'bun:test';
import { drainThenDisconnect } from '../src/cli.ts';
import { __registerDrainerForTest } from '../src/core/background-work.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeEngine(events: string[], opts?: { throwOnDisconnect?: boolean }): BrainEngine {
  return {
    disconnect: async () => {
      events.push('disconnect');
      if (opts?.throwOnDisconnect) throw new Error('disconnect blew up');
    },
  } as unknown as BrainEngine;
}

describe('drainThenDisconnect — drain registry, then disconnect, bounded', () => {
  test('drains registered sinks BEFORE engine.disconnect()', async () => {
    const events: string[] = [];
    const unregister = __registerDrainerForTest({
      name: 'test-sink-order',
      order: 99,
      drain: async () => {
        events.push('drain');
        return { unfinished: 0 };
      },
    });
    try {
      await drainThenDisconnect(makeEngine(events));
    } finally {
      unregister();
    }
    expect(events.indexOf('drain')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('disconnect')).toBeGreaterThan(events.indexOf('drain'));
  });

  test('a pending fire-and-forget write survives (drained, not killed)', async () => {
    // Simulates the search-stats path: a cache write is in flight when the
    // command finishes. The hoisted drain must let it settle before teardown.
    const events: string[] = [];
    let settled = false;
    const pending = new Promise<void>((r) =>
      setTimeout(() => {
        settled = true;
        events.push('write-settled');
        r();
      }, 30),
    );
    const unregister = __registerDrainerForTest({
      name: 'test-sink-pending-write',
      order: 99,
      drain: async () => {
        await pending;
        return { unfinished: 0 };
      },
    });
    try {
      await drainThenDisconnect(makeEngine(events));
    } finally {
      unregister();
    }
    expect(settled).toBe(true);
    expect(events).toEqual(['write-settled', 'disconnect']);
  });

  test('disconnect failure is swallowed (best-effort; kernel reclaims on exit)', async () => {
    const events: string[] = [];
    await expect(
      drainThenDisconnect(makeEngine(events, { throwOnDisconnect: true })),
    ).resolves.toBeUndefined();
    expect(events).toEqual(['disconnect']);
  });

  test('honors the per-site drain timeout passthrough', async () => {
    const seen: number[] = [];
    const unregister = __registerDrainerForTest({
      name: 'test-sink-timeout',
      order: 99,
      drain: async (timeoutMs: number) => {
        seen.push(timeoutMs);
        return { unfinished: 0 };
      },
    });
    try {
      await drainThenDisconnect(makeEngine([]), { drainTimeoutMs: 1000 });
    } finally {
      unregister();
    }
    expect(seen).toEqual([1000]);
  });
});
