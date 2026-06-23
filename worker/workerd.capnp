# workerd serve config. Build src/index.ts -> dist/index.js (esbuild) before serving.
# Run:  workerd serve workerd.capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    # Egress gate for connect(). Default allow is ["public"] which SSRF-blocks 127.0.0.1.
    # "local" = 127.0.0.0/8, "private" = RFC1918 — needed to reach local Postgres.
    (name = "internet", network = (allow = ["public", "local", "private"])),
  ],
  sockets = [
    (name = "http", address = "*:8787", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "index.js", esModule = embed "dist/index.js") ],
  compatibilityDate = "2024-09-23",
  compatibilityFlags = ["nodejs_compat"],   # required by postgres.js
  bindings = [ (name = "DATABASE_URL", fromEnvironment = "DATABASE_URL") ],  # → env.DATABASE_URL
  globalOutbound = "internet",              # route fetch/connect egress through the allow-list
);
