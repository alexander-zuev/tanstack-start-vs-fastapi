# Runbook — execution order

`SPEC.md` says *what* we measure and *how*. This says *in what order*, and tracks where we are.
Each act ends in a **gate** that must pass before the next. The sweep (Act 3) is resumable: the
SQLite ledger lets the orchestrator skip completed runs after any interruption.

Rule: **retire the biggest unknown first.** Here that is the TanStack Start build serving under raw
`workerd` (Act 1.1). Everything downstream assumes it works, so we prove it before investing in the rest.

## Act 0 — Build the stands (one-time)
- [ ] Postgres up, `world` seeded (`db/schema.sql` + `db/seed.sql`), pinned cores 2–3 (§6.4).
- [ ] FastAPI: `uv sync` (§6.1).
- [ ] Floor: bundle `worker/src/index.ts`, serve with `workerd serve` (§6.3).
- [ ] **TanStack Start: scaffold the minimal app — two server routes (`/echo`, `/db`), no UI —
      and `vite build` for the Cloudflare target (§6.2).** ← the new, untested build.
- [ ] Gate-1 ladder servers: Go `net/http` `/json` + raw Starlette `/json` (§12, Gate 1).
- [ ] Lockfiles committed; `results/env.json` written (§9).

## Act 1 — Prove the stands (§6.5)
- [ ] **1.1 Start serves under raw workerd, no wrangler in the path** — `curl /echo` on `:8787`.
      This is the make-or-break unknown; no Postgres needed. Do it before anything else.
- [ ] 1.2 Byte-identical `/echo` + `/db` across Start, FastAPI, floor (preflight `?id=`).
- [ ] 1.3 Worker `/db` returns a real row (postgres.js over `cloudflare:sockets` is wired).
- [ ] 1.4 One query per request (`pg_stat_statements`), warm pool of 10, server pinned (`mpstat`).
- **GATE:** all four pass, or stop and fix. If 1.1 fails, the whole approach is re-examined.

## Act 2 — Gate-1 ladder (§12) — is the rig sane?
- [ ] Run Go → raw Starlette → FastAPI → floor → Start on the one core, same k6.
- [ ] Ratios land in band: FastAPI 0.4–0.7× Starlette; floor 2–3× FastAPI; Start above FastAPI, below floor.
- **GATE:** ratios in band, or the rig is wrong — fix before trusting any measured number.

## Act 3 — The sweep (§7, §9) — the real numbers
- [ ] Preflight (governor / turbo / affinity) or fail the run (§5).
- [ ] Stage A knee ≈ 5 rounds (discrete constant-arrival-rate steps), AB/BA alternation.
- [ ] Stage B latency ≈ 15 rounds at 50% of each contender's own knee, AB/BA.
- [ ] CPU-ms + RSS sidecars; immutable per-run JSON; ledger rows.
- **GATE:** invalid-run criteria clean (§7). ≈ 2–2.5 h; resumable via the ledger.

## Act 4 — Analyze + publish (§10)
- [ ] `analyze.py` → median ± IQR → `report/results.js` (`illustrative:false`).
- [ ] Sanity-check against Gate 2 absolute bands + Gate 4 cross-source direction (§12).
- [ ] Report renders the real numbers.

## Harness still to build (code, before Act 1)
- [ ] minimal TanStack Start app (2 server routes).
- [ ] `load/knee.js` — discrete constant-arrival-rate steps.
- [ ] `load/latency.js` — rate derived from Stage A.
- [ ] `scripts/run.sh` — AB/BA order, readiness gate, warm-with-traffic, cgroup CPU/RSS capture.
- [ ] `scripts/analyze.py` — JSON → ledger → `results.js`, fail-hard on invalid runs.
- [ ] Gate-1 ladder servers (Go `/json`, raw Starlette `/json`).
