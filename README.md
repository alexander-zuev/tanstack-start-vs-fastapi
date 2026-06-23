# cf-vs-fastapi

A single-core, apples-to-apples HTTP benchmark: **Cloudflare Workers (`workerd`) vs FastAPI**,
both pinned to one CPU core, hitting the same local Postgres, serving byte-identical responses.

> **The question:** build the same API endpoint the normal way on each platform — how much can
> one core serve, and does the runtime matter once a database is involved?
> **Expected finding:** ~3× on pure JSON, a statistical tie on a real query.

See [`SPEC.md`](./SPEC.md) for the full methodology. Results render in
[`report/report.html`](./report/report.html) (open in a browser).

## Status

Bootstrapped. **No dependencies installed yet.** Source files are stubs to be filled in.

## Layout

```
report/    report.html        — the published report (renders from results.js)
worker/    src/index.ts       — fetch handler: /echo, /db (Zod + postgres.js)
           workerd.capnp      — workerd serve config (egress allow + nodejs_compat)
fastapi/   app.py             — FastAPI: /echo, /db (Pydantic + asyncpg)
db/        schema.sql, seed.sql — 10k-row `world` table
load/      knee.js            — k6 ramping-arrival-rate (find saturation)
           latency.js         — k6 constant-arrival-rate (percentiles, no CO)
scripts/   run.sh             — pin cores, turbo off, warmup, 20 interleaved bouts
           analyze.py         — raw k6 JSON → median/IQR → report/results.js
```

## Quickstart (once deps are installed — not yet)

```bash
# 1. DB
#    createdb bench && psql bench < db/schema.sql && psql bench < db/seed.sql
# 2. Build worker bundle + install fastapi deps  (TODO: see worker/, fastapi/)
# 3. Run
./scripts/run.sh
python scripts/analyze.py     # writes report/results.js
# 4. open report/report.html
```

## Toolchain (declared, not installed)

- Worker: `pnpm` · esbuild · `workerd` · `postgres` (porsager) · `zod`
- FastAPI: `uv` · `fastapi` · `uvicorn[standard]` · `asyncpg` · `orjson` · `pydantic`
- Load: `k6` · `mpstat` (sysstat)
