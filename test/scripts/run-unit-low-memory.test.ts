import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'run-unit-low-memory.sh');
const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-low-memory-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'run-unit-low-memory.sh'));
  chmodSync(join(root, 'scripts', 'run-unit-low-memory.sh'), 0o755);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('run-unit-low-memory.sh', () => {
  it('dry-run splits unit files into bounded sequential batches', () => {
    const root = fixture();
    for (const name of ['a.test.ts', 'b.test.ts', 'c.test.ts']) {
      writeFileSync(join(root, 'test', name), 'import { it } from "bun:test"; it("ok", () => {});\n');
    }
    writeFileSync(join(root, 'test', 'ignored.serial.test.ts'), '');
    const r = spawnSync('bash', ['scripts/run-unit-low-memory.sh', '--batch-size', '2', '--dry-run'], { cwd: root, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('batch 1/2: 2 files');
    expect(r.stdout).toContain('batch 2/2: 1 files');
    expect(r.stdout).not.toContain('ignored.serial.test.ts');
  });

  it('stops and exits non-zero when a batch fails', () => {
    const root = fixture();
    writeFileSync(join(root, 'test', 'a-pass.test.ts'), 'import { expect, it } from "bun:test"; it("pass", () => expect(1).toBe(1));\n');
    writeFileSync(join(root, 'test', 'b-fail.test.ts'), 'import { expect, it } from "bun:test"; it("fail", () => expect(1).toBe(2));\n');
    const r = spawnSync('bash', ['scripts/run-unit-low-memory.sh', '--batch-size', '1', '--skip-serial'], { cwd: root, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('batch 2/2 failed');
  });

  it('can resume diagnostics from a selected batch', () => {
    const root = fixture();
    for (const name of ['a.test.ts', 'b.test.ts', 'c.test.ts']) {
      writeFileSync(join(root, 'test', name), 'import { it } from "bun:test"; it("ok", () => {});\n');
    }
    const r = spawnSync(
      'bash',
      ['scripts/run-unit-low-memory.sh', '--batch-size', '1', '--start-batch', '2', '--dry-run'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('batch 1/3');
    expect(r.stdout).toContain('batch 2/3');
    expect(r.stdout).toContain('batch 3/3');
  });
});
