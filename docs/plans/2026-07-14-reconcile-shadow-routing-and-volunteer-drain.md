# Shadow Routing Reconciliation And Volunteer Drain Race Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the existing source-routing and shadow-retrieval commits with the approved Task 6 design, then eliminate the volunteer-event teardown race without changing runtime routing.

**Architecture:** Keep `a7f29d86` and `37d00f56` as the candidate implementation. Preserve the lazy dynamic import in `logDeliveredReflexPointers`, but extract background-write tracking into a small `volunteer-event-write-tracker.ts` module that alone owns the private set, drainer registration, and narrow `trackVolunteerEventWrite(promise)` API. The wrapper promise covering import plus enqueue is added to that set synchronously before `logDeliveredReflexPointers` returns; DB-dependent volunteer-event code remains lazy and runtime deployment remains out of scope.

**Tech Stack:** TypeScript, Bun, PGLite, bun:test, Markdown review receipts.

---

### Task 1: Reconcile The Existing Candidate

**Files:**
- Review: `src/core/context/source-routing.ts`
- Review: `src/core/context/shadow-observer.ts`
- Review: `src/core/context/reflex.ts`
- Review: `src/core/context-engine.ts`
- Review: `src/core/context/resolve-ipc.ts`
- Review: `src/mcp/server.ts`
- Create: `docs/reviews/2026-07-14-source-routing-shadow-reconciliation.md`

- [ ] **Step 1: Record commit provenance and the retained implementation boundary**

Run: `git log --format='%H %aI %an %s' 0a27c4e8..37d00f56`

Expected: exactly `a7f29d86` and `37d00f56`, both before the handoff commit time.

- [ ] **Step 2: Verify the fail-closed routing contract**

Run: `bun test test/context/source-routing.test.ts test/context/source-access-policy.test.ts`

Expected: PASS; missing or invalid routing never broadens allowed sources, and `switched` alone maps the shared logical role to `business-shared-v2`.

- [ ] **Step 3: Verify the shadow non-injection contract**

Run: `bun test test/context/shadow-observer.test.ts test/context/resolve-ipc.test.ts`

Expected: PASS; the primary block remains the only prompt payload and shadow output is reduced to safe source-qualified slugs in the observation sink.

- [ ] **Step 4: Write the reconciliation receipt**

Create `docs/reviews/2026-07-14-source-routing-shadow-reconciliation.md` with commit provenance, files reviewed, invariants checked, focused commands and results, and an explicit statement that no runtime switch or source registration occurred.

### Task 2: Pin The Immediate Log-To-Drain Race With A RED Test

**Files:**
- Modify: `test/retrieval-reflex.test.ts`

- [ ] **Step 1: Strengthen the existing regression test**

Keep the production call sequence consecutive and explicit:

```ts
logDeliveredReflexPointers(engine, block!.pointers);
const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
expect(unfinished).toBe(0);
```

The test must query `context_volunteer_events` immediately after the drain and require exactly one `channel='reflex'` row.

- [ ] **Step 2: Run the single test and verify RED**

Run: `bun test test/retrieval-reflex.test.ts --test-name-pattern 'logs channel=reflex events through the drained sink'`

Expected: FAIL with `expected 1, received 0` before production code changes.

### Task 3: Track The Entire Lazy Import And Write Lifecycle

**Files:**
- Create: `src/core/context/volunteer-event-write-tracker.ts`
- Modify: `src/core/context/volunteer-events.ts`
- Modify: `src/core/context/retrieval-reflex.ts`

- [ ] **Step 1: Add the narrow tracking API**

Create `volunteer-event-write-tracker.ts` as the sole owner of the set and drainer. Its narrow enqueue API is:

```ts
export function trackVolunteerEventWrite(promise: Promise<unknown>): void {
  pendingVolunteerEventWrites.add(promise);
  void promise.finally(() => pendingVolunteerEventWrites.delete(promise));
}
```

Move `awaitPendingVolunteerEventWrites`, the test reset hook, and the `registerBackgroundWorkDrainer` call into this module without changing their public contracts. Re-export them from `volunteer-events.ts` for compatibility. Make `logVolunteerEventsFireAndForget` call `trackVolunteerEventWrite` for its insert promise instead of owning the set.

- [ ] **Step 2: Register the wrapper promise synchronously**

In `logDeliveredReflexPointers`, statically import only `trackVolunteerEventWrite` from the lightweight tracker module. Pass it the dynamic-import wrapper promise before returning. The wrapper must include module resolution and the call that enqueues the DB insert, swallow telemetry errors, and preserve the function's `void` API.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `bun test test/retrieval-reflex.test.ts --test-name-pattern 'logs channel=reflex events through the drained sink'`

Expected: PASS with one event row.

- [ ] **Step 4: Run the complete retrieval-reflex file**

Run: `bun test test/retrieval-reflex.test.ts`

Expected: all tests PASS, including empty-pointer no-op and IPC delivery logging.

### Task 4: Verify And Record The Race Fix

**Files:**
- Create: `docs/reviews/2026-07-14-volunteer-event-drain-race-fix.md`
- Update: `docs/architecture/KEY_FILES.md`

- [ ] **Step 1: Update current-state architecture documentation**

Update the context entry to name `volunteer-event-write-tracker.ts` as the single owner of the pending set and state that the synchronously tracked promise spans lazy module loading plus enqueue, so CLI teardown cannot observe an empty sink between delivery and registration.

- [ ] **Step 2: Run type and focused verification**

Run: `bun run typecheck`

Expected: exit 0.

Run: `bun test test/retrieval-reflex.test.ts test/core/background-work.test.ts`

Expected: all tests PASS.

- [ ] **Step 3: Run repository verification**

Run: `bun run verify`

Expected: exit 0. Because `KEY_FILES.md` changed, also run `bun run build:llms` and then `bun test test/build-llms.test.ts` until the generated documentation freshness check passes.

- [ ] **Step 4: Write the race-fix receipt**

Record the root cause, RED evidence, implementation boundary, GREEN evidence, full verification results, and unchanged runtime state in `docs/reviews/2026-07-14-volunteer-event-drain-race-fix.md`.

### Task 5: Final Reconciliation Gate

**Files:**
- Review: all changed files from Tasks 1-4

- [ ] **Step 1: Inspect the exact diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only the race fix, its regression coverage, current-state documentation, plan, and receipts are changed.

- [ ] **Step 2: Run the full local unit suite once**

Run: `bun test`

Expected: exit 0 with no unexplained failure. Do not classify any failure as pre-existing without reproducing it against the relevant parent commit.

- [ ] **Step 3: Stop before runtime apply**

Do not merge into `~/gbrain`, register `business-shared-v2`, switch routing state, restart Gateway, or alter production configuration. Those remain separate owner-gated operations.
