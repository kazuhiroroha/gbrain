# Source Routing And Shadow Retrieval Reconciliation

Date: 2026-07-14

## Decision

Retain `a7f29d86` and `37d00f56` as the existing candidate implementation. Do
not rewrite mapping or shadow retrieval from scratch. The commits are a
numbered continuation of `0a27c4e8`, share the same author, and predate the
workspace handoff that accidentally described their work as still pending.

## Files reviewed

- `src/core/context/source-routing.ts`
- `src/core/context/shadow-observer.ts`
- `src/core/context/reflex.ts`
- `src/core/context-engine.ts`
- `src/core/context/resolve-ipc.ts`
- `src/mcp/server.ts`
- corresponding routing, policy, shadow, IPC, and retrieval-reflex tests

## Verified invariants

- Invalid, incomplete, duplicate, mismatched, or oversized mappings fail
  closed.
- `old`, `shadow`, and `rollback` keep the shared primary on
  `business-shared`; only `switched` maps it to `business-shared-v2`.
- Shadow retrieval is separate from the primary block. Shadow content is not
  returned as prompt text.
- Shadow observations contain only validated source-qualified slugs and are
  fenced from primary retrieval failures.

## Evidence

- Commit range: exactly `a7f29d86` and `37d00f56` after `0a27c4e8`.
- Routing and access policy: 34 passed, 0 failed.
- Shadow observer: 11 passed, 0 failed.
- Resolve IPC combined run: 10 authorization/validation tests passed; 3
  Unix-socket bind cases failed because the sandbox returned a null server.
  This is an environment limitation, not evidence against the pure routing or
  shadow contracts.
- Retrieval-reflex file after the race fix: 31 passed; the only failure was the
  same Unix-socket server-bind case.

## Boundary

No merge into the live GBrain checkout, source registration, routing switch,
Gateway restart, production configuration change, or external delivery was
performed.
