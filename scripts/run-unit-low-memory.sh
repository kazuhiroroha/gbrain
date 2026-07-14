#!/usr/bin/env bash
# Sequential low-memory unit runner for hosts that cannot keep several PGLite
# WASM instances alive concurrently. Each bounded batch runs in a fresh Bun
# process, so its memory is returned before the next batch starts.

set -uo pipefail
cd "$(dirname "$0")/.."

BATCH_SIZE="${GBRAIN_TEST_LOW_MEMORY_BATCH_SIZE:-20}"
DRY_RUN=0
SKIP_SERIAL=0
START_BATCH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    --batch-size=*) BATCH_SIZE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-serial) SKIP_SERIAL=1; shift ;;
    --start-batch) START_BATCH="$2"; shift 2 ;;
    --start-batch=*) START_BATCH="${1#*=}"; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$BATCH_SIZE" | grep -qE '^[0-9]+$' || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "ERROR: invalid batch size: $BATCH_SIZE" >&2
  exit 2
fi
if ! printf '%s' "$START_BATCH" | grep -qE '^[0-9]+$' || [ "$START_BATCH" -lt 1 ]; then
  echo "ERROR: invalid start batch: $START_BATCH" >&2
  exit 2
fi

files=()
while IFS= read -r file; do files+=("$file"); done < <(
  find test -name '*.test.ts' \
    -not -path 'test/e2e/*' \
    -not -name '*.slow.test.ts' \
    -not -name '*.serial.test.ts' | sort
)

total_files=${#files[@]}
total_batches=$(( (total_files + BATCH_SIZE - 1) / BATCH_SIZE ))
if [ "$START_BATCH" -gt "$total_batches" ]; then
  echo "ERROR: start batch $START_BATCH exceeds total batches $total_batches" >&2
  exit 2
fi
log_dir=".context/test-low-memory"
mkdir -p "$log_dir"
rm -f "$log_dir"/batch-*.log "$log_dir"/summary.txt 2>/dev/null
: > "$log_dir/summary.txt"

echo "[unit-low-memory] files=$total_files batch-size=$BATCH_SIZE batches=$total_batches concurrency=1"

for ((batch=START_BATCH - 1; batch<total_batches; batch++)); do
  start=$((batch * BATCH_SIZE))
  count=$BATCH_SIZE
  remaining=$((total_files - start))
  [ "$remaining" -lt "$count" ] && count=$remaining
  number=$((batch + 1))
  batch_files=("${files[@]:start:count}")
  echo "[unit-low-memory] batch $number/$total_batches: $count files"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  %s\n' "${batch_files[@]}"
    continue
  fi

  log="$log_dir/batch-$number.log"
  bun test --max-concurrency=1 --timeout=60000 "${batch_files[@]}" > "$log" 2>&1
  rc=$?
  printf 'batch %s/%s: files=%s rc=%s\n' "$number" "$total_batches" "$count" "$rc" >> "$log_dir/summary.txt"
  if [ "$rc" -ne 0 ]; then
    echo "[unit-low-memory] batch $number/$total_batches failed; log=$log" >&2
    cat "$log" >&2
    exit "$rc"
  fi
done

if [ "$DRY_RUN" = "1" ]; then exit 0; fi

if [ "$SKIP_SERIAL" = "0" ]; then
  echo "[unit-low-memory] running serial-only files"
  bash scripts/run-serial-tests.sh || exit $?
fi

echo "[unit-low-memory] all batches passed"
