#!/usr/bin/env python3
"""Aggregate raw k6 JSON into the report's DATA block.

DRAFT — wire up the field extraction to match k6's --summary-export shape and
whatever CPU/RSS capture run.sh writes. Emits report/results.js.

Usage: python scripts/analyze.py
"""
import glob
import json
import os
import statistics as st

OUT = "results"
REPORT_JS = "report/results.js"


def med_iqr(xs):
    xs = sorted(xs)
    if not xs:
        return {"med": None, "lo": None, "hi": None}
    n = len(xs)
    q1 = xs[max(0, n // 4 - 1)]
    q3 = xs[min(n - 1, (3 * n) // 4)]
    return {"med": round(st.median(xs), 3), "lo": round(q1, 3), "hi": round(q3, 3)}


def load(pattern, picker):
    """Collect one metric across all runs matching pattern."""
    vals = []
    for f in glob.glob(os.path.join(OUT, pattern)):
        with open(f) as fh:
            try:
                vals.append(picker(json.load(fh)))
            except (KeyError, TypeError):
                continue
    return vals


def main():
    # TODO: map these pickers to the real k6 summary structure, e.g.
    #   metrics.http_reqs.rate          -> achieved RPS
    #   metrics.http_req_duration.{med,p(99),p(99.9)}
    # knee max RPS = highest stage rate where p99 stayed under SLA (compute from knee files)
    def rps(j):  # placeholder
        return j["metrics"]["http_reqs"]["rate"]

    data = {
        "illustrative": False,
        "env": {  # TODO: fill from `uname -a`, lscpu, versions
            "CPU": "TODO", "OS / kernel": "TODO", "Turbo / governor": "off / performance",
            "runs": "20 interleaved",
        },
        "echo": {
            "rps": {
                "worker": med_iqr(load("worker_echo_*_knee.json", rps)),
                "fastapi": med_iqr(load("fastapi_echo_*_knee.json", rps)),
            },
            # TODO: dist (percentiles), err, knee curve
        },
        "db": {
            "rps": {
                "worker": med_iqr(load("worker_db_*_knee.json", rps)),
                "fastapi": med_iqr(load("fastapi_db_*_knee.json", rps)),
            },
        },
        # TODO: mem, cpuMsPerReq from cgroup captures
    }

    os.makedirs("report", exist_ok=True)
    with open(REPORT_JS, "w") as fh:
        fh.write("const DATA = " + json.dumps(data, indent=2) + ";\n")
    print(f"wrote {REPORT_JS}")
    print("NOTE: report.html currently inlines DATA. Either swap it to <script src='results.js'> "
          "or paste this block in. (Decide before publishing.)")


if __name__ == "__main__":
    main()
