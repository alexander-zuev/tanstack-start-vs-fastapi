// k6 latency run — constant-arrival-rate at a fixed SUB-saturation rate.
// Run: k6 run -e BASE_URL=... -e ENDPOINT=/echo -e RATE=15000 --summary-export=out.json load/latency.js
//
// RATE should be ~50% of the knee found by knee.js. Open model → honest tail percentiles.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:8787";
const ENDPOINT = __ENV.ENDPOINT || "/echo";
const RATE = parseInt(__ENV.RATE || "15000", 10);
const PAYLOAD = JSON.stringify({ id: 1, name: "bench", tags: ["a", "b"] });
const PARAMS = { headers: { "Content-Type": "application/json" } };

export const options = {
  discardResponseBodies: true,
  scenarios: {
    latency: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 500,
      maxVUs: 4000,
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"], // if this fails, RATE is above saturation
    http_req_failed: ["rate<0.001"],
    // report the full tail
    http_req_duration: ["p(50)<9999", "p(99)<9999", "p(99.9)<9999"],
  },
};

export default function () {
  const res =
    ENDPOINT === "/echo"
      ? http.post(BASE + ENDPOINT, PAYLOAD, PARAMS)
      : http.get(BASE + ENDPOINT);
  check(res, { ok: (r) => r.status === 200 });
}
