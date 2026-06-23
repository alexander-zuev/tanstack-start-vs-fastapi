# Benchmark spec — Cloudflare Workers vs FastAPI

Single-core, apples-to-apples, local. This document is the source of truth for *what* we
measure and *how*. The report (`report/report.html`) renders the results.

## 1. The one question

> If you build the same API **the way you'd actually ship it** on each platform — a **TanStack Start**
> route on Cloudflare vs a **FastAPI** route on Python — how much can a **single CPU core** serve, and
> does the framework's runtime still matter once a database is in the path?

You don't hand-roll a `fetch` handler for a real API, and you don't pick the API layer à la carte under
Start — the framework comes as a unit. So the contenders are the **whole stacks you'd deploy**, not bare
runtimes. This is a **stack comparison**, scoped to one core. It is **not**:
- "V8 vs Python" — everything differs (runtime, HTTP server, **framework + router**, driver).
- A scalability test — real Workers auto-scales to thousands of isolates; we cage it to one core.
- A production-topology test — local `workerd`, direct DB, no Hyperdrive, no edge/network.

The honest headline we expect: a **real but smaller `/echo` edge** for Start than workerd's bare-V8
ceiling — the framework layer eats into it (the raw-`fetch` **floor**, §6.3/§7, quantifies that ceiling)
— and a **statistical tie on `/db`.** The exact `/echo` ratio is what we measure.

## 2. Contenders (exact stacks)

| | Blue (workerd) | Red (FastAPI) |
|---|---|---|
| Runtime | V8 via `workerd serve` (raw, no wrangler) | CPython 3.13 |
| HTTP server | workerd built-in | `uvicorn[standard]` (uvloop + httptools), **1 worker** |
| Framework | **TanStack Start** server route + **Zod** | FastAPI + **Pydantic v2** |
| Serialization | native `JSON.stringify` | `ORJSONResponse` |
| DB driver | `postgres.js` over `cloudflare:sockets` | `asyncpg` |
| Routes | Start `ServerRoute` (`async`) | `async def` |

Both are the stacks you'd actually deploy, fully tuned — the framework is part of each (you don't swap the
API layer under Start). No wrangler in the request path (it wraps workerd in a Node proxy → measures the proxy).

**Floor (reference, not a contender):** the raw `fetch` handler + Zod on the *same* workerd — the bare-V8
ceiling, probed once (§6.3, §7) to show what Start's routing/server layer costs on top.

## 3. Endpoints (exact semantics — mirror TechEmpower)

Each endpoint is a **framework route on both sides** — a TanStack Start server route (Blue) and a FastAPI
route (Red), plus the raw-`fetch` floor — not a hand-rolled handler. Same contract, byte-identical output
across all three.

### `/echo` ≡ TechEmpower `/json`
- Accept a fixed JSON body, **validate** it (Zod / Pydantic — equal work).
- **Serialize per request** (no pre-baked constant buffer).
- Return byte-identical JSON on both sides.
- No I/O. Isolates request handling + validation + JSON cost.

### `/db` ≡ TechEmpower `/db`
- One **random primary-key** lookup against a 10,000-row `world` table.
- Read the **full row** (`id`, `randomnumber`), return `{"id":N,"randomNumber":M}`.
- **No row cache.** New random id per request.
- Warmed connection **pool size 10** on both sides.

## 4. Fairness rules (the validity lives here)

1. **Byte-identical responses** on both sides for each endpoint.
2. **Equal work** — both validate `/echo` exactly once; both do exactly one query for `/db`.
3. **Warm pool, size 10** held at module/app scope — never connect per request (else we
   benchmark Postgres handshakes).
4. **Identical transport** — HTTP/1.1, keep-alive, no TLS, host networking, **identical k6 config for
   both**. Connections scale with offered load (open model — VUs aren't fixed); we *record* peak active
   connections rather than claim a fixed count.
5. **One core each** — `taskset`/`--cpuset-cpus`; Postgres and k6 on *other* cores.
6. **One contender at a time** — never concurrently (they'd fight over Postgres + page cache).

## 5. Environment & isolation

- Local Ubuntu PC (single box — disclosed as the known compromise vs TechEmpower's separate machines).
- CPU governor `performance`, **turbo disabled** (`intel_pstate/no_turbo=1`).
- Core map (adjust to the actual machine): SUT → core 0, Postgres → cores 2–3, k6 → cores 4–7.
- Box quiesced (load average ~0). Placement verified with `mpstat` during the run.
- **Enforced, not hoped:** a preflight **fails the run** unless governor=`performance`, turbo off, and
  SUT / Postgres / k6 affinities match the core map. Pin Postgres explicitly (`taskset` the postmaster);
  launch `workerd` and `uvicorn` as **direct pinned binaries** — not via `pnpm`/a subshell — so the
  pinned *and* measured PID is the real server process, not a wrapper.
- workerd egress: capnp `network` service `allow = ["public", "local", "private"]` so `connect()`
  can reach `127.0.0.1` (default is `["public"]` → SSRF-blocks loopback).

## 6. Build & run each stand

Neither runtime is compiled from source — both are **prebuilt artifacts**; we build our own *app* (Start
via Vite, the floor via esbuild) and run FastAPI's source directly. The asymmetry is real and unbiased:
the build is one-time setup; we measure the **running server under load**, warmed (§9), never the build.
Pin every server with `taskset -c $SUT_CORE`. The fairness leaks live in this section.

### 6.1 FastAPI (Red) — wheels, run directly
- **Get it:** `uv sync` pulls wheels (CPython 3.13, uvicorn, uvloop, httptools, asyncpg, orjson,
  pydantic). No build step.
- **Run (one process, one core):**
  ```
  uvicorn app:app --workers 1 --loop uvloop --http httptools \
    --port 8000 --no-access-log --log-level warning
  ```
- **Traps that silently tax Red:**
  - `--no-access-log` is **mandatory** — per-request access logging costs ~10%+ throughput.
  - `/echo` must validate **once**. A `-> Echo` return annotation makes FastAPI *re-validate* the
    response (response_model) → two validations vs the worker's one. Drop the annotation (or
    `response_model=None`) and return `body` so each side validates once.
  - `--workers 1` = single process, single event loop. asyncpg keeps its prepared-statement cache
    on (direct DB, no pgbouncer) — matches the worker's `prepare:true`.

### 6.2 TanStack Start (Blue) — build the app, serve the output raw
- **The binary:** the `workerd` npm dep pulls a **prebuilt release binary** (`@cloudflare/workerd-linux-64`;
  needs glibc ≥ 2.35 and SSE4.2+CLMUL — any modern x86-64). We never compile workerd.
- **The app:** a **minimal** Start app — two **server routes** (`/echo`, `/db`), no real UI (we measure the
  API path, not a React render). Deps: `@tanstack/react-start`, `@tanstack/react-router`, `react`, `vite`,
  the **Cloudflare target** for Start (the Cloudflare Vite plugin / your Start version's CF preset), plus
  `postgres` + `zod`. The route returns a plain `Response.json(...)` so serialization stays native.
- **Build (mandatory — TS/JSX can't run on workerd):** `vite build` against the Cloudflare target → emits a
  **module Worker** bundle (Vite + the CF preset resolve `cloudflare:sockets` + node compat for us). Output
  path is preset-specific (`.output/server/index.mjs` or `dist/_worker.js`) — **pin it in §6.5.**
- **Serve (raw):** point `workerd serve` (capnp `modules`) at the **built bundle**, binds `:8787`. wrangler
  may be a build/dev dep but **never serves** — the measured runtime is pure workerd (§2).
- **DB URL via binding + `cloudflare:sockets`** (same wiring as the floor, §6.3): capnp
  `bindings = [(name = "DATABASE_URL", fromEnvironment = "DATABASE_URL")]`; the route reads it and calls
  `postgres(url, { max: 10, prepare: true, ssl: false })`. Needs `nodejs_compat` + compat date ≥ 2024-09-23.
- **Integration risk (retire FIRST, §6.5):** that Start's CF build output runs under **raw** workerd with no
  wrangler in the path. It's a standard module Worker, so it should — but prove it before any number.

### 6.3 Raw `fetch` (Floor) — bare-V8 reference, probed once
- **Stand:** the existing `worker/src/index.ts` (`export default { fetch }` + Zod + postgres.js) — the
  zero-framework handler. Same DB wiring as §6.2.
- **Bundle `src/index.ts` → `dist/index.js`.** postgres.js imports `cloudflare:sockets` + node built-ins a
  naive esbuild **can't resolve → build fails**. Two paths: **(A, recommended)** `wrangler deploy --dry-run
  --outdir dist` (correct export condition, externalizes `cloudflare:sockets`, node compat; wrangler never
  serves); **(B)** raw esbuild + `--external:cloudflare:sockets --conditions=workerd,worker`. Serve raw:
  `workerd serve workerd.capnp`.
- **Probed once, not swept (§7):** a single Stage-A knee on `/echo` → RPS/core + p99 + cpu-ms. Anchors what
  Start's server route costs on top of bare workerd. Context, not a contender.

### 6.4 Postgres (shared) — one instance, off-SUT
One local instance, `world` seeded (`db/schema.sql` + `db/seed.sql`), pinned to cores **2–3**, cache
warmed before runs. Same instance serves both contenders; never run the two at once (§4.6).

### 6.5 Prove the stand before trusting any number (run once, pre-bouts)
0. **Start serves under raw workerd:** the `vite build` output responds on `:8787` via `workerd serve` with
   **no wrangler process** running — retires the §6.2 integration risk. Do this before anything else.
1. **Byte-identical:** `curl` `/echo` and `/db` on all three (Start, FastAPI, floor) → `diff` bodies, must match incl. key order.
   `/db` returns a *random* row, so the diff needs a fixed one: handlers accept a **preflight-only**
   `?id=` (e.g. `/db?id=1234`), used *only here*, never in benchmark runs (those use a random PK).
2. **Worker DB wired:** `/db` returns a real row, not a 500 → postgres.js actually reached Postgres
   over `cloudflare:sockets`. The single biggest "does it even run" risk.
3. **One query per request:** during a sample `/db` run, `pg_stat_statements` shows exactly **one**
   SELECT per request and **no reconnects** — catches postgres.js `fetch_types` round-trips, asyncpg
   re-prepares, or accidental double queries (fairness §4.2).
4. **Pinned:** `taskset -cp <pid>` shows the SUT on its one core; `mpstat -P ALL 1` shows load only on
   SUT / Postgres / k6 cores.
5. **Warm pool:** `pg_stat_activity` holds a steady 10 connections — warm the worker's *lazy* pool with
   `/db` traffic first (§9), then confirm; no per-request connect.

## 7. Load model (k6)

Open model (`arrival-rate` executors) — offered load is independent of response time → no coordinated
omission. Two stages, so the rigorous-but-slow knee isn't repeated 20×.

**SLA — pre-committed before any run** (so "sustainable" can't move after seeing data):
- `/echo`: **p99 ≤ 5 ms** · `/db`: **p99 ≤ 15 ms** (higher — it includes the Postgres round-trip).

**Stage A — Knee (calibration), ≈ 5 interleaved rounds.** Discrete **constant-arrival-rate steps** at
rising offered RPS (*not* one ramp), each held ~30–45 s. Per step record offered RPS · **achieved** RPS
· p99 · `dropped_iterations` · error rate — this *is* the knee curve. **Sustainable RPS = the highest
step with p99 ≤ SLA, `dropped_iterations == 0`, and errors < 0.1%.** Report median ± IQR across rounds.
(A ramp's aggregate RPS is meaningless for this; `load/knee.js` does discrete steps.)

**Stage B — Latency (the bulk), ≈ 15 interleaved rounds.** `constant-arrival-rate`, 60 s, at **50% of
each contender's *own* knee** (sub-saturation; the rate is *derived* from Stage A, never guessed) → the
clean p50/p90/p99/p99.9 tail as median ± IQR. The **same-absolute-RPS** comparison (both at one shared
rate) is read straight off the Stage-A knee curves — no extra run. CPU-ms + RSS captured here.

**Floor — one probe, not the sweep.** The raw-`fetch` stand (§6.3) runs a **single Stage-A knee on `/echo`
only** (RPS/core + p99 + cpu-ms) — no Stage B, no `/db` (DB-bound; the floor there is Postgres). Context for
the framework-overhead delta, not a contender — minutes, not rounds.

**Invalid-run criteria — discard *before* analysis, re-run, log as discarded (never explain after):**
- `dropped_iterations > 0` · error rate > 0.1% · any non-200.
- achieved RPS < 99% of offered on a Stage-B run (it wasn't really sub-saturation).
- pin / governor / turbo drift (re-checked post-run, §5).

## 8. Metrics (what we report)

Per endpoint × contender, as **median ± IQR** across rounds (RPS & latency are per *single core*):
- **Sustainable RPS / core** — the headline comparable (§7), reported with the **ratio** (workerd ÷ FastAPI).
- **Latency** — p50 / p90 / p99 / p99.9 + max (Stage B).
- **CPU-time per request** — cgroup CPU ÷ requests served; *what CF bills*. With ratio.
- **Idle RSS** — cgroup, warm, before load.
- **Errors, made visible (never hidden):** HTTP error rate · `dropped_iterations` · non-200 count ·
  discarded/re-run count. Anything over the §7 thresholds invalidates the run — it's not a footnote.

## 9. Protocol

1. **Preflight (§5):** assert governor / turbo / affinity or **fail the run**; quiesce box.
2. Start contender as a **direct pinned binary**; **readiness-gate** — poll `/echo` and `/db` until 200
   + DB-connected — then **warm with real traffic ~30 s** (must hit `/db`, to build & warm the worker's
   lazy pool + JIT), confirm p99 flat, **discard** the warmup.
3. Run the scheduled stage (A = knee steps, B = latency) → record raw k6 JSON + CPU-ms/RSS sidecar.
4. Stop contender. Switch. **Alternate within-round order (AB, BA, AB, …)** so first-mover effects
   cancel. Stage A ≈ 5 rounds, Stage B ≈ 15 rounds.
5. `analyze.py` → median ± IQR per metric → emits `report/results.js` (the `DATA` block).

**Run ops.** Two-stage sweep ≈ **2–2.5 h**: Stage A (knee) ≈ 5 rounds × 2 contenders × 2 endpoints ×
(~20 s warm + ~150 s steps) ≈ 45 min; Stage B (latency) ≈ 15 rounds × 2 × 2 × (~20 s warm + 60 s) ≈
80 min. Round counts are the dominant lever; bump Stage B if the `/db` tie IQRs overlap-but-wide.
**Resumable** via the ledger. Watch the **first 1–2 rounds live** (`K6_WEB_DASHBOARD=true` + `mpstat -P
ALL 1` for placement); run the rest **headless**, one compact line per run (round · contender ·
endpoint · achieved RPS · p99 · err% · ok/fail).

**Storage & resumability.**
- Immutable per-run k6 summary JSON in `results/` — the durable source of truth (one file per
  contender × endpoint × phase × round). Never deleted/rewritten.
- `results/env.json` once: `lscpu`, kernel, governor + turbo state, k6 / workerd / python / uv
  versions, harness git commit — provenance, so any number is reproducible.
- `results/runs.db` (SQLite) ledger: one row per *completed* run; the orchestrator skips tuples
  already present → the sweep is **resumable** after any interruption (it's a 4h job; it will get
  interrupted). `sqlite3` is Python stdlib — no deps, written from a non-SUT core.
- CPU-ms + RSS captured per run as a sidecar keyed to the same tag (the §8 cost metrics).
- **Never** store results in the SUT's Postgres — writing to the system under test contaminates its
  page cache and cores.

## 10. Reporting

`report/report.html` renders everything from one `DATA` object:
- 3-card scorecard (echo RPS ratio · db RPS tie · **CPU-ms/req**, the billing unit), winner-colored.
- Per round: RPS bar (with IQR error bars + value labels), percentile tail (log-y), knee curve.
- Footprint: idle RSS + CPU-ms/req.
- Full numbers table, methodology + disclosure, caveats.

**How `DATA` is populated** (the mechanism to build when real numbers exist):
`analyze.py` reads the per-run JSON (indexed via the ledger), takes **median ± IQR across the 20
rounds** per (contender × endpoint), and emits `report/results.js` as `const DATA = {…}` in the shape
the page consumes:
- `*.rps` ← `metrics.http_reqs.rate`; knee → peak sustainable = highest stage rate where p99 ≤ SLA.
- `*.dist` ← `metrics.http_req_duration.values["p(50)"|"p(90)"|"p(99)"|"p(99.9)"]` (latency run).
- `*.knee` ← the per-step `(offered RPS, achieved RPS, p99, dropped, errors)` from Stage A — each step
  is its own constant-rate summary, so the curve falls out directly (no time-series hack).
- `mem`, `cpuMsPerReq` ← the sysstat sidecars.

`report.html` then loads it via `<script src="results.js"></script>`. **Today it inlines a placeholder
`DATA` (`illustrative:true`)**; the publish step is the script-src split + regenerating `results.js`
with `illustrative:false`. Leave the stub `DATA` untouched until real numbers exist.

### TechEmpower anchor (port the discipline, not the UI)
One compact summary table gives readers the familiar TE reference without pretending we ran the suite:

| Test | TE analogue | Metric | workerd | FastAPI | Ratio | Errors |
|---|---|---|---|---|---|---|
| `/echo` | JSON-style **+ validation** | sustainable RPS/core | … | … | … | … |
| `/echo` | JSON-style + validation | p99 (ms) | … | … | … | … |
| `/db` | Single query | sustainable RPS/core | … | … | … | … |
| `/db` | Single query | p99 (ms) | … | … | … | … |

`/echo` is labelled **"JSON-style + validation (TechEmpower-`json` inspired)"** — it validates a body,
so it does *more* than TE's "return JSON"; `/db` maps cleanly to TE **single query**.

**Stack-metadata block** (port the info, not the tiny coloured cells): runtime · HTTP server ·
framework/router · validation lib · serializer · DB driver · pool size · DB · OS/kernel · CPU + core
map · all versions — sourced from §2 + `env.json`.

**Don't port:** the giant ranked table (we have 2 contenders), TE's DB-admin visual style, their literal
concurrency columns (our open-model **knee curve** is the equivalent: offered RPS · achieved RPS · p99 ·
dropped · errors), or any hint of suite-level breadth (2 endpoint classes, not 7 families × 300+
frameworks). The **"framework overhead"** view needs baselines (Gate 1 ladder) → appendix only, later.

## 11. Caveats (printed in the report)

- Stack comparison, not a language shootout. We compare the **frameworks you'd ship** (Start vs FastAPI);
  the raw-`fetch` floor (§6.3) isolates how much of any `/echo` gap is runtime vs framework.
- **Why FastAPI runs natively, not on Cloudflare.** Cloudflare can run Python on Workers (CPython→WASM via
  Pyodide), but it's a young runtime: slower than native CPython, heavy cold starts, a curated package
  subset, no native `asyncpg` (so the `/db` path can't run as-is). Nobody ships production FastAPI+Postgres
  there, so measuring it on Python Workers would benchmark Pyodide's immaturity, not FastAPI. We run FastAPI
  on native CPython + uvicorn; both contenders still share the **same pinned core** (hardware controlled).
- workerd standalone is a conservative **lower bound**: the default build isn't perf-tuned (~2× headroom
  from compiler flags + allocator; release build is `--config=thin-lto`) — verify the served binary is
  optimized (§6.2/§6.3). It also has **no external single-core reference** to check against (§12).
- Per-core efficiency, not scalability. Local workerd ≠ production. Direct DB ≠ prod topology.
- 2 of 6 TechEmpower tests (no writes, templating, multi-query, plaintext).
- `/db` partly benchmarks the drivers. The DB tie is the headline finding, not a footnote.

## 12. Sense-checking — is a number real, or meaningless?

The run spits out thousands of numbers. We can't trust any **absolute** against the outside world
(different box = different scale). We **can** trust four on-box checks. A result is real only if it
clears all of them.

### Gate 1 — ratios on our own box (run the ladder FIRST)

Before the A/B, run these on the **same single core**, same k6. Ratios are portable across machines;
absolutes aren't.

| Rung | Run (1 core) | Ballpark RPS* | Expected ratio |
|---|---|---|---|
| Ceiling | Go `net/http` `/json` | 150k–300k | = 1.0 (this core's ceiling) |
| ASGI floor | raw Starlette `/json` | 20k–50k | 0.15–0.30 × ceiling |
| **Red SUT** | our FastAPI `/echo` | 10k–30k | **0.4–0.7 × Starlette** |
| **Blue floor** | raw workerd `fetch` `/echo` | 30k–80k | bare-V8 ceiling, **2–3 × FastAPI** |
| **Blue SUT** | our TanStack Start `/echo` | measure | **between Red SUT and Blue floor** ← the headline |

*Rough, for a modern desktop core. **Trust = the ratios land in band.** If FastAPI is only a few %
of Starlette → bug in our app, not the platform. Start should land **below its own raw floor** (that's the
framework cost we're pricing) yet **above FastAPI**; if Start ≥ the floor the floor isn't really
zero-framework, if Start ≤ FastAPI suspect Start's build (Gate 3).

### Gate 2 — absolute bands (tripwires)

If a SUT number falls outside its band, it's our setup, not the result:

| Metric | Real range | Headline target |
|---|---|---|
| `/echo` (each) | 2k–200k | raw floor ≈ **3×** FastAPI; **Start above FastAPI, below the floor** |
| `/db` (each) | 3k–15k | the two **converge within ~15%** (statistical tie) |
| Idle RSS | FastAPI 40–80 MB · workerd lower | workerd noticeably leaner |

Below 2k or above 200k on `/echo` = not really exercising the route. A 3×+ gap on `/db` = driver
misuse, not platform.

### Gate 3 — parity (are we benchmarking the same work?)

- **FastAPI:** vendor TFB's `frameworks/Python/fastapi/app.py`, run it on our cage. Our `/echo` should
  sit within ~15% of it, minus our extra Pydantic validation (TFB `/json` has none → expect ours
  slightly lower). Confirm both do one query, read the full row, hold a module-scope warm pool.
- **workerd:** verify the `pnpm`-installed `workerd` binary is an **optimized release** (default
  source build is ~2× slower; release flag `--config=thin-lto`). If Blue looks weak, suspect the
  build before the platform.
- **TanStack Start:** confirm Blue serves a **production `vite build`** bundle (minified, not the dev
  server) and that the route does one query / one validation, same as the floor. A dev-mode bundle taxes
  Blue unfairly.

### Gate 4 — cross-source direction (confirms ordering, never magnitude)

No public suite is single-core, and none measures standalone workerd — so use them only to check
we're pointed the right way, not to match a number:
- **TechEmpower**, **the-benchmarker/web-frameworks**, **Sharkbench**, and **okami101 (2026)** all
  rank FastAPI the same: fast for Python (~5× Flask), below raw Starlette, far below compiled-language
  frameworks (Go/Rust ~5–15×). If our FastAPI lands outside "fast-for-Python, mid-pack overall,"
  suspect the rig.
- Every suite puts **V8 runtimes (Node / workerd-class) above CPython on JSON**. So our expected
  **workerd > FastAPI on `/echo` is the cross-source consensus** — if Blue came out *below* Red on
  `/echo`, that contradicts every public ranking → red flag, recheck the build (Gate 3) first.
- The **magnitude** (exact echo ratio, the `/db` tie) is **ours to measure** — there is no external
  number to match, by design (§1).

### Report honestly

State it plainly: **only FastAPI has an external reference (TechEmpower).** workerd standalone has
none — we trust it via internal fairness + it being a conservative floor (prod Workers adds request
scheduling + GC tuning we don't have).

### References
- TechEmpower: <https://www.techempower.com/benchmarks/> · FastAPI impl (canonical):
  <https://github.com/TechEmpower/FrameworkBenchmarks/tree/master/frameworks/Python/fastapi>
- the-benchmarker (single-machine req/s ranking): <https://github.com/the-benchmarker/web-frameworks>
- Sharkbench (single-container per-framework): <https://sharkbench.dev/web>
- okami101 2026 web API benchmarks: <https://www.okami101.io/blog/web-api-benchmarks-2026/>
- workerd build/perf: <https://github.com/cloudflare/workerd> ·
  <https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/>
- postgres.js on Workers (`cloudflare:sockets`, `nodejs_compat`): <https://github.com/porsager/postgres>

## 13. Open knobs (decide before running)

- [ ] Actual core IDs for SUT / Postgres / k6 on this machine.
- [ ] `isolcpus` at boot (stronger isolation) vs `taskset` only (lighter, no reboot).
- [ ] Stage A / Stage B round counts — default **5 / 15 ≈ 2–2.5 h**; bump if the `/db` tie is unresolved.
- [ ] Whether to also run an `orjson`-disabled FastAPI variant (footnote).
- [ ] Verify the npm `workerd` binary is an optimized (thin-lto) release, not baseline (§6.2/§6.3, Gate 3).
- [ ] **Smoke-test that Start's CF `vite build` output serves under raw `workerd serve`, no wrangler (§6.5).**
- [ ] Pin Start's CF build preset + exact module-Worker output path (§6.2).
- [ ] Vendor + run TFB's `fastapi/app.py` on the cage as a parity check (Gate 3).
- [ ] Build the ladder servers: Go/Rust `/json` ceiling + raw Starlette `/json` (Gate 1).
