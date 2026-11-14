"""
Unverified tips for the globe: natural events from NASA EONET (Earth Observatory Natural Event Tracker).

Run (from the repo folder):   py tools/fetch_eonet.py
Writes cases/eonet.json, a small saved snapshot, so the app never depends on EONET being online.

Rule (fixed before looking at the events): categories wildfires, floods, severe storms, volcanoes;
events active between 1 Jun and 10 Nov 2026; at most 10 per category (so 40 at most), picked evenly
spread in time within each category so the tips appear all along the timeline. Each tip keeps its
title, first date in the window, first location, category, and the source links EONET lists.
These are TIPS: OmniSAR has not checked any of them.
"""

import datetime as dt
import json
import os
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "cases", "eonet.json")
START, END = "2026-06-01", "2026-11-10"
CATEGORIES = {"wildfires": "Wildfire", "floods": "Flood", "severeStorms": "Severe storm", "volcanoes": "Volcano"}
PER_CATEGORY = 10
URL = ("https://eonet.gsfc.nasa.gov/api/v3/events?start={s}&end={e}&category={c}&status=all").format(
    s=START, e=END, c=",".join(CATEGORIES))


def first_point(geoms):
    """Earliest geometry inside the window: (date, lat, lon). Polygons use the mean of their corners."""
    for g in sorted(geoms, key=lambda g: g["date"]):
        day = g["date"][:10]
        if not (START <= day <= END):
            continue
        c = g["coordinates"]
        if g["type"] == "Point":
            lon, lat = c[0], c[1]
        else:
            ring = np.array(c[0], dtype=float)
            lon, lat = ring[:, 0].mean(), ring[:, 1].mean()
        return day, float(lat), float(lon)
    return None


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "OmniSAR-processing/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
    by_cat = {k: [] for k in CATEGORIES}
    for ev in data["events"]:
        cat = next((c["id"] for c in ev["categories"] if c["id"] in CATEGORIES), None)
        p = first_point(ev.get("geometry", []))
        if not cat or not p:
            continue
        by_cat[cat].append({
            "id": ev["id"], "title": ev["title"], "category": CATEGORIES[cat], "date": p[0],
            "lat": round(p[1], 3), "lon": round(p[2], 3), "link": ev.get("link"),
            "sources": [{"id": s.get("id"), "url": s.get("url")} for s in ev.get("sources", [])],
        })
    tips, counts = [], {}
    for cat, evs in by_cat.items():
        evs.sort(key=lambda e: (e["date"], e["id"]))
        counts[cat] = len(evs)
        if len(evs) > PER_CATEGORY:
            idx = np.unique(np.round(np.linspace(0, len(evs) - 1, PER_CATEGORY)).astype(int))
            evs = [evs[i] for i in idx]
        tips += evs
    tips.sort(key=lambda e: e["date"])
    out = {
        "about": "Unverified tips: natural events from NASA EONET, saved by tools/fetch_eonet.py. Not checked by OmniSAR.",
        "source": "NASA EONET API v3 (eonet.gsfc.nasa.gov)",
        "query": URL,
        "fetched": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "rule": f"active {START} to {END}; categories {', '.join(CATEGORIES)}; at most {PER_CATEGORY} per category, evenly spread in time",
        "events_in_window": counts,
        "events": tips,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f"eonet.json: {len(tips)} tips from {counts}")


if __name__ == "__main__":
    main()
