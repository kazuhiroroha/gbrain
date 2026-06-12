/**
 * v0.41.8.0 — narrow force-exit gate for the cli.ts op-dispatch finally.
 *
 * The cli.ts caller fires `process.exit(0)` ONLY when:
 *   1. The op-dispatch drain timed out (drainResult.outcome === 'timeout')
 *   2. AND this function returns true (i.e. the command is NOT a daemon)
 *
 * The function lives in its own module — not inline in cli.ts — so tests
 * can import + drive it without triggering cli.ts's top-level main() side
 * effect (cli.ts is a script entrypoint). Mirrors PR #1337's
 * `shouldForceExitAfterMain` guard, but narrower in scope: this wave
 * only force-exits after the drain timed out, NOT unconditionally for
 * every non-serve command.
 *
 * Daemon list: `serve` (stdio + HTTP) and `watch` (stdin-follow push
 * transport, v0.43 #2095 — interactive TTY sessions stay alive until
 * Ctrl-C; its piped/EOF path exits via its own drain-then-exit lifecycle,
 * not this gate). If a future long-running command is added (e.g.
 * `gbrain daemon`), add it here.
 */

const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['serve', 'watch']);

export function shouldForceExitAfterMain(
  argv: string[] = process.argv.slice(2),
): boolean {
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (!command) return true;
  return !DAEMON_COMMANDS.has(command);
}

/**
 * v0.43 (#2084) — deliberate exit after bounded teardown.
 *
 * Lingering sockets (embedding-provider fetch keep-alive, PgBouncer txn-mode
 * sockets `endPoolBounded` raced past) keep Bun's event loop alive after
 * teardown RESOLVES, so the CLI used to ride the 10s hard-deadline backstop
 * on every `gbrain query`. The fix is to exit on purpose the moment main()
 * resolves — but only after stdout/stderr have actually drained: incident
 * #1959 (see src/core/db.ts) was a force-exit truncating piped stdout
 * mid-payload.
 *
 * Flush contract: a stream is drained when `writableLength === 0` — bytes
 * queued in the JS-side buffer are the only ones `process.exit()` can lose
 * (the kernel owns anything already written to the fd). `writableNeedDrain`
 * is NOT sufficient (it only says "below high-water mark"). We wake on
 * 'drain' when it fires, and poll on a short tick because 'drain' is only
 * emitted after a write() returned false — a small queued chunk can flush
 * without ever signalling. A blocked pipe (reader stopped consuming) is
 * bounded by `guardMs`: partial output to a stalled reader is unavoidable,
 * hanging the process is not.
 */
export interface FlushableStream {
  writableLength?: number;
  once(event: 'drain', listener: () => void): unknown;
  off?(event: 'drain', listener: () => void): unknown;
  removeListener?(event: 'drain', listener: () => void): unknown;
}

export async function flushStdoutThenExit(
  code: number,
  deps?: {
    streams?: FlushableStream[];
    exit?: (code: number) => void;
    guardMs?: number;
  },
): Promise<void> {
  const streams = deps?.streams ?? [
    process.stdout as unknown as FlushableStream,
    process.stderr as unknown as FlushableStream,
  ];
  const exit = deps?.exit ?? ((c: number) => process.exit(c));
  const guardMs = deps?.guardMs ?? 2000;
  const deadline = Date.now() + guardMs;

  for (const stream of streams) {
    while ((stream.writableLength ?? 0) > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          clearTimeout(tick);
          resolve();
        };
        // Poll tick: 'drain' only fires after a backpressured write, so a
        // buffer that empties without one needs the re-check. unref'd so the
        // wait itself never holds the loop open.
        const tick = setTimeout(() => {
          (stream.off ?? stream.removeListener)?.call(stream, 'drain', onDrain);
          resolve();
        }, 25);
        (tick as { unref?: () => void }).unref?.();
        stream.once('drain', onDrain);
      });
    }
  }
  exit(code);
}
