"""FastAPI contender — /echo and /db. Stub; no deps installed yet.

Run (once deps installed):
    uvicorn app:app --workers 1 --loop uvloop --http httptools --port 8000 \
        --no-access-log --log-level warning
"""
import os
import random
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/bench"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm pool, size 10 — matches the worker. Never connect per request.
    app.state.pool = await asyncpg.create_pool(DATABASE_URL, min_size=10, max_size=10)
    yield
    await app.state.pool.close()


# ORJSONResponse as the default so /echo serialization is the fast path.
app = FastAPI(default_response_class=ORJSONResponse, lifespan=lifespan)


class Echo(BaseModel):
    id: int
    name: str
    tags: list[str]


# No `-> Echo` response annotation: it would make FastAPI re-validate the response (response_model),
# i.e. validate twice vs the worker's once. Validate once on input, serialize once. (SPEC §4.2)
@app.post("/echo")
async def echo(body: Echo):  # Pydantic validates per request
    return body


@app.get("/db")
async def db():
    pk = random.randint(1, 10000)  # random PK, no cache
    async with app.state.pool.acquire() as con:
        row = await con.fetchrow("select id, randomnumber from world where id = $1", pk)
    return {"id": row["id"], "randomNumber": row["randomnumber"]}
