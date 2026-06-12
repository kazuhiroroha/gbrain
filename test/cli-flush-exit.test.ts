/**
 * v0.43 (#2084) — flushStdoutThenExit unit tests.
 *
 * The deliberate-exit path must never truncate buffered output (incident
 * #1959: a force-exit cut piped stdout mid-payload) and must never hang on
 * a blocked pipe. Streams + exit are injected so the tests drive both
 * properties without killing the test process.
 */

import { describe, test, expect } from 'bun:test';
import { flushStdoutThenExit, type FlushableStream } from '../src/core/cli-force-exit.ts';

/** Minimal fake of the stdout/stderr surface flushStdoutThenExit touches. */
function makeStream(initialLength: number): FlushableStream & {
  setLength(n: number): void;
  emitDrain(): void;
  drainListeners(): number;
} {
  let length = initialLength;
  const listeners: Array<() => void> = [];
  return {
    get writableLength() {
      return length;
    },
    once(_event: 'drain', listener: () => void) {
      listeners.push(listener);
      return this;
    },
    off(_event: 'drain', listener: () => void) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
      return this;
    },
    setLength(n: number) {
      length = n;
    },
    emitDrain() {
      const current = listeners.splice(0, listeners.length);
      for (const l of current) l();
    },
    drainListeners() {
      return listeners.length;
    },
  };
}

describe('flushStdoutThenExit — deliberate exit after output drains', () => {
  test('exits immediately with the given code when both streams are drained', async () => {
    const calls: number[] = [];
    await flushStdoutThenExit(0, {
      streams: [makeStream(0), makeStream(0)],
      exit: (c) => calls.push(c),
    });
    expect(calls).toEqual([0]);
  });

  test('honors a non-zero exit code (errored op sets process.exitCode=1)', async () => {
    const calls: number[] = [];
    await flushStdoutThenExit(1, {
      streams: [makeStream(0)],
      exit: (c) => calls.push(c),
    });
    expect(calls).toEqual([1]);
  });

  test('waits for a pending buffer to drain before exiting', async () => {
    const stream = makeStream(4096);
    const calls: number[] = [];
    const done = flushStdoutThenExit(0, {
      streams: [stream],
      exit: (c) => calls.push(c),
      guardMs: 5000,
    });
    // Not exited while bytes are queued.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    stream.setLength(0);
    stream.emitDrain();
    await done;
    expect(calls).toEqual([0]);
  });

  test('drains stdout AND stderr — stderr alone can hold the exit', async () => {
    const stdout = makeStream(0);
    const stderr = makeStream(2048);
    const calls: number[] = [];
    const done = flushStdoutThenExit(1, {
      streams: [stdout, stderr],
      exit: (c) => calls.push(c),
      guardMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    stderr.setLength(0);
    stderr.emitDrain();
    await done;
    expect(calls).toEqual([1]);
  });

  test('poll tick drains without a drain event ("drain" only fires after backpressure)', async () => {
    const stream = makeStream(512);
    const calls: number[] = [];
    const done = flushStdoutThenExit(0, {
      streams: [stream],
      exit: (c) => calls.push(c),
      guardMs: 5000,
    });
    // Buffer empties WITHOUT an emitted drain event — the 25ms poll must see it.
    setTimeout(() => stream.setLength(0), 30);
    await done;
    expect(calls).toEqual([0]);
  });

  test('blocked pipe: the guard deadline exits anyway (never hangs)', async () => {
    const stream = makeStream(65536); // reader stopped consuming; never drains
    const calls: number[] = [];
    const t0 = Date.now();
    await flushStdoutThenExit(0, {
      streams: [stream],
      exit: (c) => calls.push(c),
      guardMs: 120,
    });
    expect(calls).toEqual([0]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('removes its drain listener when the poll tick wins (no listener leak)', async () => {
    const stream = makeStream(256);
    const calls: number[] = [];
    const done = flushStdoutThenExit(0, {
      streams: [stream],
      exit: (c) => calls.push(c),
      guardMs: 5000,
    });
    setTimeout(() => stream.setLength(0), 30);
    await done;
    expect(stream.drainListeners()).toBe(0);
  });
});
