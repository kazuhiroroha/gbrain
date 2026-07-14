import { registerBackgroundWorkDrainer } from '../background-work.ts';

// Single owner for every volunteer-event promise that must settle before CLI
// teardown disconnects the engine. Callers get only the narrow tracking API.
const pendingVolunteerEventWrites = new Set<Promise<unknown>>();

export function trackVolunteerEventWrite(promise: Promise<unknown>): void {
  pendingVolunteerEventWrites.add(promise);
  void promise.finally(() => pendingVolunteerEventWrites.delete(promise));
}

/** Drain pending event writes (bounded). Same snapshot semantics as last-retrieved. */
export async function awaitPendingVolunteerEventWrites(
  timeoutMs = 5_000,
): Promise<{ unfinished: number }> {
  if (pendingVolunteerEventWrites.size === 0) return { unfinished: 0 };
  const snapshot = Array.from(pendingVolunteerEventWrites);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const drain = Promise.allSettled(snapshot).then(() => 'drained' as const);
  const outcome = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const unfinished = pendingVolunteerEventWrites.size;
    for (const promise of snapshot) pendingVolunteerEventWrites.delete(promise);
    return { unfinished };
  }
  return { unfinished: 0 };
}

// Order 4 — after facts / last-retrieved / search-cache / eval-capture.
registerBackgroundWorkDrainer({
  name: 'volunteer-events',
  order: 4,
  drain: (ms) => awaitPendingVolunteerEventWrites(ms),
});

export function _resetPendingVolunteerEventWritesForTests(): void {
  pendingVolunteerEventWrites.clear();
}

export function _peekPendingVolunteerEventWritesForTests(): number {
  return pendingVolunteerEventWrites.size;
}
