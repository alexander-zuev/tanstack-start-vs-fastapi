# tanstack-start-vs-fastapi

A single-core, apples-to-apples HTTP benchmark of the API stack you'd actually ship:
a **TanStack Start** route on Cloudflare Workers (`workerd`) versus a **FastAPI** route on
Python (CPython + uvicorn). Both pinned to one CPU core, hitting the same local Postgres,
serving byte-identical responses.

> **The question:** if you build the same API the way you'd actually ship it, how much can a
> single core serve, and does the framework's runtime even matter once a database is in the path?
> **Expected shape:** a real but smaller edge on pure JSON than the bare-V8 ceiling (the framework
> eats into it), and a statistical tie on a real query.

A raw `fetch` handler on the same `workerd` is measured as a **floor** (the zero-framework ceiling),
not a contender. See [`SPEC.md`](./SPEC.md) for the methodology, [`RUNBOOK.md`](./RUNBOOK.md) for the
execution order, and [`report/report.html`](./report/report.html) for the results.

## Status

Bootstrapped. **No dependencies installed yet**, and the TanStack Start app plus the harness are
still to build (see RUNBOOK.md). Source files are stubs.

## Layout

```
report/    report.html          published report (renders from results.js)
           chart.umd.min.js      vendored Chart.js (offline)
worker/    src/index.ts          raw fetch floor: /echo, /db (Zod + postgres.js)
           workerd.capnp         workerd serve config (egress allow + nodejs_compat)
fastapi/   app.py                FastAPI: /echo, /db (Pydantic + asyncpg)
db/        schema.sql, seed.sql  10k-row world table
load/      knee.js               k6 discrete constant-arrival-rate steps (find the knee)
           latency.js            k6 constant-arrival-rate (percentiles, no coordinated omission)
scripts/   run.sh                pin cores, turbo off, warmup, AB/BA interleaved bouts
           analyze.py            raw k6 JSON to median/IQR to report/results.js
```

The minimal TanStack Start app, the real Blue contender, is not scaffolded yet (RUNBOOK Act 0).

## Quickstart (once built)

```bash
# 1. DB
#    createdb bench && psql bench < db/schema.sql && psql bench < db/seed.sql
# 2. Build the Start app + floor bundle, install FastAPI deps (see RUNBOOK.md)
# 3. Run
./scripts/run.sh
python scripts/analyze.py     # writes report/results.js
# 4. open report/report.html
```

## Toolchain (declared, not installed)

- TanStack Start: `pnpm` · `@tanstack/react-start` · `vite` · `workerd` · `postgres` (porsager) · `zod`
- FastAPI: `uv` · `fastapi` · `uvicorn[standard]` · `asyncpg` · `orjson` · `pydantic`
- Load: `k6` · `mpstat` (sysstat)
