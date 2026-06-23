#!/usr/bin/env bash
# Orchestrates the benchmark. DRAFT — fill in the machine-specific bits (core IDs) first.
# Runs one contender at a time, A/B/A/B interleaved, raw k6 JSON per run into results/.
set -euo pipefail

# ── machine config (EDIT THESE) ──────────────────────────────────────────────
SUT_CORE=0            # core the server under test is pinned to
LOADGEN_CORES="4-7"   # cores for k6 (must not overlap SUT or Postgres)
RUNS=20               # interleaved bouts
WARMUP=30             # seconds, discarded
WORKER_URL="http://127.0.0.1:8787"
FASTAPI_URL="http://127.0.0.1:8000"
OUT="results"
# Sub-saturation latency rates (≈50% of each knee — set after a first knee pass)
ECHO_RATE=15000
DB_RATE=4500
# ─────────────────────────────────────────────────────────────────────────────

mkdir -p "$OUT"

# Bundle the worker once (wrangler as bundler only; served by raw workerd). SPEC §6.2.
( cd worker && pnpm run build )

echo "[setup] governor=performance, turbo off  (needs sudo; comment out if not available)"
# sudo cpupower frequency-set -g performance
# echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo

start_worker() {
  ( cd worker && taskset -c "$SUT_CORE" pnpm run serve ) &  # workerd serve
  echo $!
}
start_fastapi() {
  # --no-access-log is mandatory: per-request access logging costs ~10%+ throughput (SPEC §6.1).
  taskset -c "$SUT_CORE" uvicorn --app-dir fastapi app:app \
    --workers 1 --loop uvloop --http httptools --port 8000 \
    --no-access-log --log-level warning &
  echo $!
}

bench() {  # bench <name> <base_url> <echo_rate> <db_rate> <run_idx>
  local name=$1 base=$2 erate=$3 drate=$4 i=$5
  for ep in /echo /db; do
    local rate; [ "$ep" = /echo ] && rate=$erate || rate=$drate
    local tag="${name}_${ep//\//}_run${i}"
    taskset -c "$LOADGEN_CORES" k6 run -e BASE_URL="$base" -e ENDPOINT="$ep" \
      load/knee.js --summary-export="$OUT/${tag}_knee.json" >/dev/null
    taskset -c "$LOADGEN_CORES" k6 run -e BASE_URL="$base" -e ENDPOINT="$ep" -e RATE="$rate" \
      load/latency.js --summary-export="$OUT/${tag}_lat.json" >/dev/null
    # TODO: capture cgroup CPU + RSS of the SUT pid during the latency run
  done
}

for i in $(seq 1 "$RUNS"); do
  echo "[run $i/$RUNS] workerd"
  pid=$(start_worker); sleep "$WARMUP"; bench worker "$WORKER_URL" "$ECHO_RATE" "$DB_RATE" "$i"; kill "$pid"

  echo "[run $i/$RUNS] fastapi"
  pid=$(start_fastapi); sleep "$WARMUP"; bench fastapi "$FASTAPI_URL" "$ECHO_RATE" "$DB_RATE" "$i"; kill "$pid"
done

echo "[done] raw results in $OUT/  →  run: python scripts/analyze.py"
