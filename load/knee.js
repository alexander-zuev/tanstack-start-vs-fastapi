// k6 knee sweep — ramping-arrival-rate to find saturation (where p99 turns vertical).
// Run: k6 run -e BASE_URL=http://127.0.0.1:8787 -e ENDPOINT=/echo load/knee.js
//
// Open model: arrival rate is independent of response time → no coordinated omission.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:8787";
const ENDPOINT = __ENV.ENDPOINT || "/echo";
const PAYLOAD = JSON.stringify({ id: 1, name: "bench", tags: ["a", "b"] });
const PARAMS = { headers: { "Content-Type": "application/json" } };

export const options = {
  discardResponseBodies: true,
  scenarios: {
    knee: {
      executor: "ramping-arrival-rate",
      startRate: 2000,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 2000, // oversized so k6 can always hold the rate
      stages: [
        { target: 5000, duration: "20s" },
        { target: 10000, duration: "20s" },
        { target: 20000, duration: "20s" },
        { target: 40000, duration: "20s" },
        { target: 70000, duration: "20s" },
      ],
    },
  },
  thresholds: {
    // fail loud if we silently drop load (CO sneaking back in)
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate<0.001"],
  },
};

export default function () {
  const res =
    ENDPOINT === "/echo"
      ? http.post(BASE + ENDPOINT, PAYLOAD, PARAMS)
      : http.get(BASE + ENDPOINT);
  check(res, { ok: (r) => r.status === 200 });
}
