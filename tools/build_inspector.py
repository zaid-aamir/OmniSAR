"""
"What did the radar hit?" inspector data: HH and HV (dB) for every block of a case terrain, for
every NISAR pass listed in that case's chain of custody.

Run (from the repo folder, AFTER the case scripts):   py tools/build_inspector.py [case ...]

Nothing new is measured here and no rule is applied: this only re-reads the same NASA files with
each case script's own reader, then merges pixels into blocks exactly like that case's terrain
grid (same block size, same averaging), so a block's numbers match the terrain under it.
The bounce-type rule is applied in the browser (js/inspector.js) and declared in why_log.md
(Sat 14 Nov 13:00) before this script was first run.

Writes assets/cases/<case>/inspect.json  ({"passes": [...], "hh": {date: [x10 ints]}, "hv": {...}}).
Jakarta has no HH/HV (it is InSAR): its inspector uses the terrain grid's millimetre layers only.
"""

import json
import os
import sys

import numpy as np

import nisar_io as nio

HERE = os.path.dirname(os.path.abspath(__file__))


def q(a):
    return [None if not np.isfinite(v) else int(round(float(v) * 10)) for v in a.ravel()]


def merge_db_linear(a_db, R, C, m):
    """Block value = mean in linear power, back to dB (Jebel Ali / Al Ain grids)."""
    lin = 10 ** (a_db[:R * m, :C * m] / 10)
    return 10 * np.log10(np.nanmean(lin.reshape(R, m, C, m), axis=(1, 3)))


def merge_db_mean(a_db, R, C, m):
    """Block value = mean of dB values (Big Sur / Tonle Sap grids)."""
    return np.nanmean(a_db[:R * m, :C * m].reshape(R, m, C, m), axis=(1, 3))


def numbers(case):
    return json.load(open(os.path.join(nio.REPO, "cases", f"{case}.numbers.json"), encoding="utf-8"))


def grid(case):
    return json.load(open(os.path.join(nio.REPO, "assets", "cases", case, "grid.json"), encoding="utf-8"))


def custody_dates(case):
    return sorted({f["date"] for f in numbers(case)["provenance"]["nasa_files"]})


def build(case):
    g = grid(case)
    R, C, m = g["rows"], g["cols"], g["merge"]
    dates = custody_dates(case)
    hh, hv = {}, {}
    if case == "tonle-sap":
        a = np.load(os.path.join(nio.PROJECT, "research", "checks", case, "arrays.npz"))
        for d in dates:
            hh[d] = merge_db_mean(a[f"hh_{d}"], R, C, m)
            hv[d] = merge_db_mean(a[f"hv_{d}"], R, C, m)
        merge = "mean of dB values, like the terrain grid"
    else:
        sys.path.insert(0, HERE)
        mod = __import__({"jebel-ali": "process_jebel_ali", "big-sur": "process_big_sur", "al-ain": "process_al_ain"}[case])
        found = mod.find_passes()
        passes = [p for side in found for p in side] if isinstance(found, tuple) else found
        passes = [p for p in passes if p["date"] in dates]
        window = None
        for p in passes:
            b = mod.read_box(p, window)
            window = b["window"]
            if case == "al-ain":                       # 10 m native -> 3x3 multilook, as the grid does
                H = nio.power_to_db(nio.multilook(b["hh"].astype(np.float64), 3))
                V = nio.power_to_db(nio.multilook(b["hv"].astype(np.float64), 3))
            else:                                      # readers already return 30 m linear power
                H = nio.power_to_db(b["hh"].astype(np.float64))
                V = nio.power_to_db(b["hv"].astype(np.float64))
            f = merge_db_linear if case in ("jebel-ali", "al-ain") else merge_db_mean
            hh[p["date"]], hv[p["date"]] = f(H, R, C, m), f(V, R, C, m)
            print(f"  {case} {p['date']}: blocks {R}x{C} (merge {m})", flush=True)
            del b, H, V
        merge = ("mean in linear power, back to dB, like the terrain grid" if case in ("jebel-ali", "al-ain")
                 else "mean of dB values, like the terrain grid")
    out = {
        "about": "HH and HV (dB x10, null = no data) for every terrain block and every NISAR pass in this case's chain of custody. "
                 "Written by tools/build_inspector.py; same block size and averaging as grid.json.",
        "case": case, "rows": R, "cols": C, "merge": m, "block_merge": merge,
        "passes": sorted(hh), "hh": {d: q(v) for d, v in sorted(hh.items())}, "hv": {d: q(v) for d, v in sorted(hv.items())},
        "source": "NISAR L2 GCOV (ASF DAAC); files listed in cases/%s.numbers.json" % case,
    }
    path = os.path.join(nio.REPO, "assets", "cases", case, "inspect.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(nio.clean_json(out), fh, separators=(",", ":"), allow_nan=False)
    print(f"wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB), passes {out['passes']}", flush=True)


if __name__ == "__main__":
    for c in sys.argv[1:] or ["jebel-ali", "tonle-sap", "big-sur", "al-ain"]:
        build(c)
