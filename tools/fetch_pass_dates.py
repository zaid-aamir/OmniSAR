"""
Find every real NISAR pass over our five case boxes, 1 Jun - 10 Nov 2026, and save them
to cases/passes.json for the timeline.   Run:  py tools/fetch_pass_dates.py

Where the dates come from: NASA's Common Metadata Repository (CMR), the public catalogue
of every NASA data file. No login needed - we only read the list of files, not the files.

  GCOV (radar images)      collections C2854338529-ASF + C3622241360-ASF  -> Jebel Ali, Big Sur, Tonle Sap, Al Ain
  GUNW (interferograms)    collection  C2854335566-ASF                    -> Jakarta

A file name such as
  NISAR_L2_PR_GCOV_023_056_A_014_4005_DHDH_A_20260618T014305_..._001
holds: cycle 023, track 056, direction A(scending), frame 014, mode 4005, start time.
The same pass can exist in two modes (2005 and 4005), so we count one pass per
(date, track, direction, frame) and list its modes.

A GUNW file compares two passes (reference -> secondary), so for Jakarta both dates are passes.
"""

import datetime as dt
import json
import os
import re
import urllib.parse
import urllib.request

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
START, END = "2026-06-01T00:00:00Z", "2026-11-10T23:59:59Z"
GCOV = ["C2854338529-ASF", "C3622241360-ASF"]
GUNW = ["C2854335566-ASF"]

# id: (name, product, collections, box W,S,E,N) - boxes from CLAUDE.md BUILD NOTES
CASES = {
    "jebel-ali": ("Jebel Ali, Dubai", "GCOV", GCOV, (54.95, 24.93, 55.12, 25.06)),
    "big-sur":   ("Big Sur, California", "GCOV", GCOV, (-121.85, 35.80, -121.25, 36.35)),
    "tonle-sap": ("Tonle Sap, Cambodia", "GCOV", GCOV, (104.0, 12.6, 104.4, 13.0)),
    "jakarta":   ("Jakarta, Indonesia", "GUNW", GUNW, (106.70, -6.20, 107.00, -6.05)),
    "al-ain":    ("Al Ain, UAE", "GCOV", GCOV, (55.45, 24.40, 55.65, 24.58)),
}

GCOV_NAME = re.compile(r"GCOV_(\d{3})_(\d{3})_([AD])_(\d{3})_(\d{4})_\w+?_(\d{8})T")
GUNW_NAME = re.compile(r"GUNW_\d{3}_(\d{3})_([AD])_(\d{3})_\d{3}_(\d{4})_\w+?_(\d{8})T\d{6}_\d{8}T\d{6}_(\d{8})T")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "cases", "passes.json")


def iso(yyyymmdd):
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"


def list_granules(collection, box):
    """All file names in one collection that touch the box during our window (follows CMR paging)."""
    params = {
        "collection_concept_id": collection,
        "bounding_box": ",".join(str(v) for v in box),
        "temporal": f"{START},{END}",
        "page_size": 2000,
    }
    names, search_after = [], None
    while True:
        req = urllib.request.Request(CMR + "?" + urllib.parse.urlencode(params))
        if search_after:
            req.add_header("CMR-Search-After", search_after)
        with urllib.request.urlopen(req, timeout=60) as r:
            entries = json.load(r)["feed"]["entry"]
            search_after = r.headers.get("CMR-Search-After")
        names += [e["title"] for e in entries]
        if not entries or not search_after:
            return names


def gcov_passes(names):
    passes = {}
    for n in names:
        m = GCOV_NAME.search(n)
        if not m:
            continue
        _cycle, track, direction, frame, mode, day = m.groups()
        key = (iso(day), track, direction, frame)
        p = passes.setdefault(key, {"date": iso(day), "track": track, "direction": direction,
                                    "frame": frame, "modes": []})
        if mode not in p["modes"]:
            p["modes"].append(mode)
    return sorted(passes.values(), key=lambda p: (p["date"], p["track"]))


def gunw_passes(names):
    passes, pairs = {}, []
    for n in names:
        m = GUNW_NAME.search(n)
        if not m:
            continue
        track, direction, frame, mode, ref, sec = m.groups()
        pairs.append({"reference": iso(ref), "secondary": iso(sec), "track": track,
                      "direction": direction, "frame": frame, "mode": mode})
        for day in (ref, sec):
            key = (iso(day), track, direction, frame)
            p = passes.setdefault(key, {"date": iso(day), "track": track, "direction": direction,
                                        "frame": frame, "modes": []})
            if mode not in p["modes"]:
                p["modes"].append(mode)
    # keep only dates inside our window (a pair can start before 1 Jun)
    inside = [p for p in passes.values() if START[:10] <= p["date"] <= END[:10]]
    unique_pairs = {json.dumps(p, sort_keys=True): p for p in pairs}.values()
    return (sorted(inside, key=lambda p: (p["date"], p["track"])),
            sorted(unique_pairs, key=lambda p: (p["reference"], p["track"], p["frame"])))


def main():
    out = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "window": {"start": START[:10], "end": END[:10]},
        "source": "NASA CMR granule search (cmr.earthdata.nasa.gov), public metadata, no login",
        "cases": {},
    }
    for case_id, (name, product, collections, box) in CASES.items():
        names = []
        for c in collections:
            names += list_granules(c, box)
        entry = {"name": name, "product": product, "collections": collections, "box": box,
                 "files": len(set(names))}
        if product == "GCOV":
            entry["passes"] = gcov_passes(names)
        else:
            entry["passes"], entry["pairs"] = gunw_passes(names)
        out["cases"][case_id] = entry
        tracks = sorted({f"{p['track']}{p['direction']}/{p['frame']}" for p in entry["passes"]})
        print(f"{case_id:10s} {entry['files']:3d} files -> {len(entry['passes']):3d} passes, "
              f"{len({p['date'] for p in entry['passes']}):3d} dates   tracks/frames: {', '.join(tracks)}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("Saved", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
