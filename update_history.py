#!/usr/bin/env python3
"""Lifenz MM2 feed — history updater.

Appends the current values.json snapshot to history.json so the calculator can
draw per-item trend sparklines. Honest by construction:

  * Existing series are scrubbed against the item's CURRENT value: any point
    more than 4x away is a scale artifact (e.g. "126K" recorded as 126), not a
    market move, and is dropped.
  * A brand-new item is seeded with two REAL points: its previous value
    (current - change, as published by Supreme) and its current value. If no
    change is known, it starts with a single point and grows on later runs.
  * Idempotent: re-running without a value change appends nothing.
  * Items no longer present in values.json are dropped from history.
  * Series are capped at the most recent MAX_POINTS entries.

Usage (repo root):  python3 update_history.py
Reads  ./values.json and ./history.json (if present); writes ./history.json.
Zero dependencies (stdlib only).
"""
import json, os, sys

RATIO = 4.0        # scale-artifact threshold, mirrors the calculator's histSeries()
MAX_POINTS = 60    # per-item series cap

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0

def main(root="."):
    vpath, hpath = os.path.join(root, "values.json"), os.path.join(root, "history.json")
    with open(vpath, encoding="utf-8") as f:
        values = json.load(f)
    old = {}
    if os.path.exists(hpath):
        try:
            with open(hpath, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and isinstance(loaded.get("values"), dict):
                old = loaded["values"]
        except (json.JSONDecodeError, OSError) as e:
            print(f"[history] existing history.json unreadable ({e}); rebuilding", file=sys.stderr)

    out, seeded, appended, scrubbed, dropped_ids = {}, 0, 0, 0, 0
    for it in values.get("items", []):
        iid = it.get("id")
        cur = it.get("supreme") if num(it.get("supreme")) else it.get("mm2")
        if not iid or not num(cur):
            continue                                # placeholder items carry no series
        raw = old.get(iid, [])
        series = [v for v in raw if num(v) and v / cur <= RATIO and cur / v <= RATIO]
        scrubbed += len([v for v in raw if v not in series]) if raw else 0
        if not series:
            chg = it.get("change")
            prev = cur - chg if isinstance(chg, (int, float)) and not isinstance(chg, bool) and num(cur - chg) else None
            series = [prev, cur] if prev is not None else [cur]
            seeded += 1
        elif series[-1] != cur:
            series.append(cur)
            appended += 1
        out[iid] = series[-MAX_POINTS:]
    dropped_ids = len([k for k in old if k not in out])

    body = '{\n"updatedAt": ' + json.dumps(values.get("updatedAt", "")) + ',\n"values": {\n' + \
        ',\n'.join(json.dumps(k) + ': ' + json.dumps(v, separators=(",", ":")) for k, v in out.items()) + \
        '\n}\n}\n'
    with open(hpath, "w", encoding="utf-8") as f:
        f.write(body)
    print(f"[history] {len(out)} series | seeded {seeded}, appended {appended}, "
          f"scrubbed {scrubbed} artifact point(s), dropped {dropped_ids} stale id(s)")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
