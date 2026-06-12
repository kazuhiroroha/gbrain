/**
 * v0.43 (#2084) — CRITICAL regression: piped stdout is never truncated by the
 * deliberate flush-exit (eng-review D3; the incident #1959 class).
 *
 * Two layers:
 *  1. A subprocess that writes 256KB to a REAL pipe (4x the 64KB kernel pipe
 *     buffer, so write() backpressures and bytes sit in the JS-side stream
 *     buffer) and then calls the production `flushStdoutThenExit`. If the
 *     flush gate is wrong, the tail of the payload is sheared off — this is
 *     exactly how incident #1959 presented ("relational query came back
 *     empty" — output truncated by a force-exit).
 *  2. The real CLI (`bun src/cli.ts --tools-json`, engine-free) over a pipe:
 *     parseable, byte-stable across runs, and exits deliberately (well under
 *     the 10s backstop).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');

const PAYLOAD_BYTES = 256 * 1024;

describe('cli pipe truncation — deliberate exit flushes piped stdout (#2084)', () => {
  test('256KB through a real pipe survives flushStdoutThenExit byte-exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-flush-'));
    const script = join(dir, 'flush-child.ts');
    try {
      writeFileSync(
        script,
        [
          `import { flushStdoutThenExit } from ${JSON.stringify(join(REPO, 'src', 'core', 'cli-force-exit.ts'))};`,
          `const payload = 'x'.repeat(${PAYLOAD_BYTES}) + 'END\\n';`,
          // No await — mirrors the cli.ts entrypoint, which fires the flush
          // exit as a dangling promise after main() resolves.
          `process.stdout.write(payload);`,
          `void flushStdoutThenExit(0);`,
        ].join('\n'),
      );
      const res = spawnSync('bun', [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(res.status).toBe(0);
      const out = res.stdout ?? '';
      expect(Buffer.byteLength(out, 'utf-8')).toBe(PAYLOAD_BYTES + 4);
      expect(out.endsWith('END\n')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('exit code survives the flush (errored command stays non-zero)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-flush-code-'));
    const script = join(dir, 'flush-code-child.ts');
    try {
      writeFileSync(
        script,
        [
          `import { flushStdoutThenExit } from ${JSON.stringify(join(REPO, 'src', 'core', 'cli-force-exit.ts'))};`,
          `process.stdout.write('partial output before failure\\n');`,
          `void flushStdoutThenExit(3);`,
        ].join('\n'),
      );
      const res = spawnSync('bun', [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(res.status).toBe(3);
      expect(res.stdout).toBe('partial output before failure\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('real CLI: --tools-json over a pipe is complete, parseable, byte-stable, and prompt', () => {
    const run = () => {
      const t0 = Date.now();
      const res = spawnSync('bun', [CLI, '--tools-json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: res.stdout ?? '', status: res.status, ms: Date.now() - t0 };
    };
    const first = run();
    expect(first.status).toBe(0);
    expect(Buffer.byteLength(first.stdout, 'utf-8')).toBeGreaterThan(16 * 1024);
    // Truncated JSON does not parse — the strongest single-run completeness check.
    const parsed = JSON.parse(first.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // Deliberate exit, not the 10s hard-deadline backstop.
    expect(first.ms).toBeLessThan(9_000);

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  }, 180_000);
});
