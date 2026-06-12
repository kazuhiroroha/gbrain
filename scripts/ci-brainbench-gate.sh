#!/usr/bin/env bash
# BrainBench CI gate (Cathedral 2, decision 4) — local parity with the
# .github/workflows/test.yml `brainbench` job.
#
# Governance: the gate compares HEAD's run against MAIN's copy of the
# committed baseline (git show origin/master:...), NEVER the working tree's —
# a PR cannot rewrite the thing it is compared against. Two modes resolve
# automatically inside `eval brainbench --compare`:
#   same fixtures_hash  → count-aware gate (any newly-failed gold item fails)
#   different hash      → corpus-bless (the PR's committed baseline must
#                         exactly match HEAD's run; regressions vs main need
#                         a `justification` in the committed baseline)
#
# Exit codes pass through: 0 pass · 1 regression · 2 error/inconclusive.

set -euo pipefail

BASELINE_PATH="evals/brainbench/baselines/main.json"
MAIN_REF="${BRAINBENCH_MAIN_REF:-origin/master}"
OUT="${BRAINBENCH_OUT:-/tmp/brainbench-result.json}"
MAIN_BASELINE="$(mktemp /tmp/brainbench-main-baseline-XXXXXX.json)"
trap 'rm -f "$MAIN_BASELINE"' EXIT

if git show "${MAIN_REF}:${BASELINE_PATH}" > "$MAIN_BASELINE" 2>/dev/null; then
  echo "[brainbench-gate] comparing against ${MAIN_REF}:${BASELINE_PATH}"
  bun src/cli.ts eval brainbench --compare "$MAIN_BASELINE" --out "$OUT"
else
  # First landing: main has no baseline yet. Run without a gate so the PR
  # that introduces BrainBench can commit the initial baseline.
  echo "[brainbench-gate] no baseline on ${MAIN_REF} yet — running ungated (initial-landing path)"
  bun src/cli.ts eval brainbench --out "$OUT"
fi
