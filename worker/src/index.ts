// workerd fetch handler — /echo and /db.
import postgres from "postgres";
import { z } from "zod";

interface Env {
  // Injected via a capnp `fromEnvironment` binding (see workerd.capnp), not a hardcoded string.
  DATABASE_URL: string;
}

// The pool is a module-scope singleton, created lazily on the first request. In Workers `env`
// is not available at module-init time, so we cache the pool in the isolate and reuse it across
// every request. The ~30s warmup (SPEC §9) connects it before any measured load — we never
// connect per request (SPEC §4.3). Direct TCP to local Postgres over cloudflare:sockets.
let pool: ReturnType<typeof postgres> | undefined;
function db(env: Env) {
  if (!pool) {
    // ssl:false — local, non-TLS (SPEC §4.4). prepare:true mirrors asyncpg's prepared statements.
    pool = postgres(env.DATABASE_URL, { max: 10, prepare: true, ssl: false });
  }
  return pool;
}

// Equal-work validation to mirror FastAPI's Pydantic on /echo: validate once, serialize once.
const EchoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tags: z.array(z.string()),
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/echo") {
      const body = EchoSchema.parse(await req.json()); // validate per request
      return Response.json(body);                       // serialize per request
    }

    if (url.pathname === "/db") {
      const id = 1 + Math.floor(Math.random() * 10000); // random PK, no cache
      const [row] = await db(env)`select id, randomnumber from world where id = ${id}`;
      return Response.json({ id: row.id, randomNumber: row.randomnumber });
    }

    return new Response("not found", { status: 404 });
  },
};
