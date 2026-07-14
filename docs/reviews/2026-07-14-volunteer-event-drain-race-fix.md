# Volunteer Event Drain Race Fix Review

Date: 2026-07-14

## Root cause

`logDeliveredReflexPointers()` returned before its dynamic import registered
the INSERT promise in the volunteer-event pending set. An immediately following
drain could observe an empty set and disconnect the engine before telemetry was
written.

## RED evidence

```text
bun test test/retrieval-reflex.test.ts --test-name-pattern 'logs channel=reflex events through the drained sink'
```

Before the production change the test failed with `Expected: 1`, `Received: 0`.

## Implementation

- `volunteer-event-write-tracker.ts` exclusively owns the private pending set,
  bounded drainer, registration function, and test seams.
- `volunteer-events.ts` re-exports the existing drain/test API and returns its
  internally tracked INSERT promise from the fire-and-forget function.
- `retrieval-reflex.ts` synchronously registers a wrapper promise that spans
  dynamic module loading and the returned INSERT promise.
- DB-dependent volunteer-event code remains lazily imported; the private set is
  not exposed.

## GREEN evidence

The same single-test command passed with one event row. The complete
retrieval-reflex file then reported 31 passed and one Unix-socket bind failure;
the failing IPC server test is outside the changed tracking path and the sandbox
returned `null` from `startResolveIpcServer`.

Additional verification:

- routing and access policy: 34 passed;
- shadow observer: 11 passed;
- background-work plus retrieval-reflex: 37 passed, with the same single
  sandbox Unix-socket failure;
- llms bundle freshness: 12 passed;
- exports baseline: 20 entries matched;
- trailing-newline and `git diff --check`: clean.

The repository-wide parallel verifier could not produce a valid aggregate in
the current sandbox: all 30 children exited together with code 2. Sequential
`check:all` progressed normally, then stopped at the unchanged HEAD violation
`test/extract-takes.test.ts:132` (rule R3: `PGLiteEngine` constructed in
`beforeEach`). A direct `bun test` run started and passed many suites but the
execution wrapper terminated before Bun emitted a final summary. These are
recorded as incomplete gates, not as passing results.

Outside-sandbox verification on the same candidate worktree established:

- `bun test test/context/resolve-ipc.test.ts test/retrieval-reflex.test.ts`:
  45 passed, 0 failed, 104 assertions;
- `bun run verify`: 29 of 30 checks passed; the only failure was the same
  unchanged rule-R3 violation in `test/extract-takes.test.ts:132`;
- full `bun test`: exited 1 after extensive passing output. Observed unrelated
  failures included CLI/search and hybrid-search timeouts, live-workspace
  auto-detection affecting `check-resolvable-cli`, one LLM-intent expectation,
  skillpack-check expectations, and a late lifecycle-hook timeout. The runner's
  final aggregate line was not retained by the execution wrapper, so no total
  pass/fail count is asserted here.

The deterministic repository gate blocker was then removed without changing
production code: the second `PGLiteEngine` fixture in
`test/extract-takes.test.ts` now initializes once in its local `beforeAll` and
disconnects in `afterAll`, while Gateway state is still reset around each test.
Fresh verification after that test-only lifecycle correction:

- `bun test test/extract-takes.test.ts`: 6 passed, 0 failed, 19 assertions;
- `bun run check:test-isolation`: OK, 946 non-serial unit files scanned;
- `bun run verify`: 30 passed, 0 failed, all checks green in 40 seconds.

## Baseline test hardening

The previously observed full-suite failures were reproduced unchanged in a
detached `37d00f56` worktree before correction. Their causes were test-harness
leaks, not the routing or volunteer-write implementation:

- hybrid-search and facts-backstop inherited live embedding configuration and
  attempted provider work despite their keyword-only/stubbed contracts;
- check-resolvable inherited the operator's real `HOME` and selected the live
  OpenClaw workspace instead of its documented install-path fallback;
- CLI subprocess integration tests allowed the child 45 seconds but left Bun's
  outer test timeout at 5 seconds, while clean PGLite bootstrap takes 5-6
  seconds on this host.

The tests now explicitly configure an unavailable embedding provider, isolate
`HOME` for resolver fallback checks, and give only the subprocess integration
cases a matching 45-second outer timeout. Fresh focused results: CLI dispatch
3/3, hybrid search 9/9, facts backstop 13/13, check-resolvable 22/22, and
typecheck exit 0. A final `bun run verify` remained 30/30 green.

Raw monolithic `bun test` is not a viable repository gate on this host: it was
SIGKILLed with exit 137 after repeatedly initializing PGLite. The canonical
four-shard `bun run test` also had one shard SIGKILLed under concurrent PGLite
load. A sequential four-shard diagnostic avoided the memory kill and continued
passing, but was stopped because migration/performance tests make that local
mode take hours. No all-unit success is claimed.

To make that final gate executable on the single available server,
`scripts/run-unit-low-memory.sh` and the `bun run test:low-memory` package
command now split the 941 non-E2E, non-slow, non-serial unit files into fresh
sequential Bun processes (20 files per batch by default, concurrency 1), then
run the existing serial suite. The runner preserves a non-zero batch exit,
stops at the first failure, and stores per-batch logs plus a summary under
`.context/test-low-memory/`. Its contract tests pass 2/2; real discovery
reports 48 batches in dry-run. Typecheck exits 0 and repository verification
remains 30/30 green after adding the runner.

The live low-memory gate was then completed end to end. During diagnostic
resumes it exposed additional pre-existing test hermeticity gaps: facts,
notability-eval, relational A/B, brain-tool put-page, and hybrid-meta tests
were relying on inherited Gateway state; a facts embedding fixture hardcoded
1536 dimensions without pinning its schema; and two structural source-text
assertions encoded obsolete formatting/module ownership. Each test now pins
its intended Gateway/schema state, and the volunteer-events structural pin
checks the synchronous tracker module plus its import from the enqueue owner.
The runner also accepts `--start-batch N` for diagnostic resumes; its contract
suite is 3/3.

Final acceptance evidence from a clean start at batch 1:

- `bun run test:low-memory`: exit 0; all 48/48 batches covering 941 ordinary
  unit test files passed, followed by all 73/73 serial files;
- `bun run typecheck`: exit 0;
- `bun run verify`: 30 passed, 0 failed, all checks green in 37 seconds.

This closes the previously missing full-unit exit-0 gate on the single server.
The production GBrain Postgres database was not used or changed: PGLite was
only the isolated in-process database used by repository tests.

## Boundary

This is a local candidate-worktree fix. It was not deployed, merged into the
live GBrain checkout, or applied to Gateway/runtime configuration.
