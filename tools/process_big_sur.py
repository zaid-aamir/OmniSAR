"""
Big Sur case: which burned slopes above Highway 1 lost their cover, and how much rain has fallen on them?

Run (from the repo folder):   py tools/process_big_sur.py
Re-run when the 21 Oct pass finishes downloading (it joins only if the METHOD's dry-soil rule allows).

What it does, in order:
  1. Finds the finished NISAR GCOV files for track 135, ascending, frame 020 (mode 4005):
     BEFORE = 17 Jul 2026 (before both fires), AFTER = 15 Sep (+ 21 Oct if allowed). Never opens .h5.part.
  2. Reads only the Big Sur box in strips (memory stays small), filters speckle 3x3 -> 30 m.
  3. Interference check on the whole frame (same test as Jebel Ali).
  4. HV change (after - before), smoothed 3x3. Burned = HV fell by 2 dB or more, in patches >= 5 ha.
  5. Radar geometry (trap 9): works out layover, shadow and steep slopes facing away from the
     satellite from the file's look direction + Terrarium heights; those pixels are kept apart.
  6. Slope >= 23 degrees from Terrarium (the USGS debris-flow model's slope term).
  7. Independent check: NIFC fire perimeters (Timber + Plaskett) -> badge.
  8. Highway 1 from OpenStreetMap (Overpass): burned steep areas ranked by distance to the road.
  9. Rain and surface wetness since the fire from NASA POWER (regional, not per slope).
 10. Writes cases/big-sur.numbers.json (full provenance), images for the evidence cards and toggles,
     a grid for the case terrain, fills the images/captions into cases/big-sur.json, runs update_results.

Every threshold is in METHOD. Never change one to make a result look better: a weak result IS the verdict.
"""

import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import warnings

import h5py
import numpy as np
from PIL import Image, ImageDraw

import nisar_io as nio
import terrain
import update_results
from process_jebel_ali import GRID, frame_sample, diverging, font, sha256, fmt_date, log
from evidence_jebel_ali import nearest_with_data, RTC_LAYER
from evidence_jebel_ali import caption_strip as _caption_strip, side_by_side as _side_by_side

warnings.filterwarnings("ignore", category=RuntimeWarning)

SCRIPT_VERSION = "1.1"   # 1.1: per-fire medians in the check text, ASCII image text (METHOD unchanged)
CASE = "big-sur"
DATA_DIR = os.path.join(nio.PROJECT, "data", "gcov")
KIT_DIR = os.path.join(nio.PROJECT, "research", "checks", CASE)          # outside the repo
CACHE = os.path.join(nio.PROJECT, "research", "cache")
ASSET_DIR = os.path.join(nio.REPO, "assets", "cases", CASE)
NUMBERS = os.path.join(nio.REPO, "cases", f"{CASE}.numbers.json")
MYSTERY = os.path.join(nio.REPO, "cases", f"{CASE}.json")
PERIMETERS = os.path.join(nio.PROJECT, "research", "bigsur_fire_perimeters_NIFC.geojson")
FILE_PATTERN = "_135_A_020_4005_"
FIRES = ("Timber", "Plaskett")
CENTRE = (36.075, -121.55)          # lat, lon of the box centre (POWER point)
TODAY = dt.date.today().isoformat()

# ---------------------------------------------------------------------------------------------
# METHOD - fixed BEFORE looking at any result (logged in why_log.md, Sat 14 Nov 04:50).
# ---------------------------------------------------------------------------------------------
METHOD = {
    "declared": "2026-11-14T04:50+04:00, before any Big Sur change map was computed",
    "inputs": "NISAR L2 GCOV, track 135, ascending, frame 020, mode 4005 (10 m), finished files only",
    "before": "2026-07-17 (NIFC discovery dates: Timber 9 Aug 2026, Plaskett 26 Aug 2026)",
    "after": "2026-09-15; 2026-10-21 joins only if finished AND NASA POWER rain in the 7 days before it is < 5 mm (wet soil brightens HV and would hide burn); otherwise it is shown as an exhibit, not used",
    "wet_rule_mm": 5.0,
    "after_value": "per-pixel median in dB of the usable after passes",
    "layers": ["HHHH", "HVHV", "mask"],
    "valid_pixel": "mask 1-254, HH > 0, HV > 0; land = AWS Terrarium height > 0 m (sea left out)",
    "multilook": 3,
    "speckle_filter": "3x3 block mean in linear power -> 30 m pixels; then the HV change (dB) is smoothed with a 3x3 moving mean that needs >= 5 of 9 valid pixels",
    "burn_rule": "smoothed HV change (after - before) <= -2.0 dB",
    "burn_db": -2.0,
    "burn_reason": "about 6 sigma of the smoothed noise (~0.3 dB); L-band HV falls where canopy is lost (Tanase et al. 2010, IEEE TGRS 48(10))",
    "min_patch_px": 56,
    "min_patch": "8-connected patches of burn pixels >= 56 px (5.04 ha); patches found over all land, then split into unflagged (headline) and flagged (low confidence)",
    "interference_check": "whole frame sampled on a 40x40 grid of 32x32-pixel windows; an after pass is flagged if |box median change - frame median change| >= 1.5 dB in HH or HV vs the before pass; a flagged after pass is not used",
    "interference_limit_db": 1.5,
    "geometry": "GCOV has no layover/shadow layer (shadowMaskingApplied = False). LOS unit vector + incidence angle from the file's radarGrid (0 m height layer, nearest cell); Terrarium heights on the 30 m grid; s = dh/du, u = horizontal direction toward the satellite. Layover if atan(-s) >= incidence; shadow if atan(s) >= 90 - incidence; steep facing away if atan(s) >= 20 deg. Flagged pixels are left out of the headline area and the check; their burn is reported separately as low confidence (trap 9)",
    "facing_away_deg": 20.0,
    "steep_deg": 23.0,
    "steep_source": "USGS post-fire debris-flow likelihood model: 'proportion of upslope area classified as high or moderate soil burn severity and with gradients >= 23 deg' (USGS Landslide Hazards Program, Scientific Background; Staley et al. 2016, USGS OFR 2016-1106; Staley et al. 2017, Geomorphology 278:149-162)",
    "slope_from": "AWS Terrarium zoom-12 heights (~31 m here) sampled at each 30 m pixel centre; central differences",
    "check": "NIFC perimeters (Timber + Plaskett) rasterised on the 30 m grid (pixel centre inside), over valid unflagged land. A = % of our burn inside the perimeters; B = % of the perimeter area we detect",
    "badge_rule": "Strong if A >= 60% and B >= 60%; Moderate if one of them is >= 60%; Weak otherwise",
    "badge_limit": 0.60,
    "highway": "OpenStreetMap via the Overpass API: highway ways whose ref is CA 1 / SR 1 inside the box; line densified to <= 15 m",
    "steep_areas": "8-connected clusters of burned AND steep pixels >= 56 px (5 ha), ranked by the shortest distance from any of their pixels to Highway 1; top 3 reported",
    "rain": "NASA POWER daily PRECTOTCORR (mm/day) and GWETTOP (0-1) at the box centre (36.075 N, 121.55 W), 1 Jul -> today; totals since 26 Aug. Labelled 'NASA POWER (MERRA-2), regional, not per slope' (trap 17). Measured rain only, never a forecast",
    "power_label": "NASA POWER (MERRA-2), regional, not per slope",
}

SEQ = [(13, 8, 135), (33, 102, 172), (32, 164, 160), (122, 209, 81), (253, 231, 37)]
BURN_RGBA = (242, 92, 43, 235)          # fixed data colours (not palette colours)
STEEP_RGBA = (255, 209, 102, 245)
FLAG_RGBA = (190, 120, 230, 200)


# ------------------------------------------------------------------ small helpers
# The small built-in image font has no >=, ->, superscript-2 or +/- signs: write them in plain text on images.
ASCII = {"≥": ">=", "≤": "<=", "→": "->", "²": "2", "±": "+/-", "—": "-"}


def T(text):
    for k, v in ASCII.items():
        text = text.replace(k, v)
    return text


def caption_strip(img, lines, width=None):
    return _caption_strip(img, [T(x) for x in lines], width)


def side_by_side(items, title=None):
    return _side_by_side([(im, T(label)) for im, label in items], T(title) if title else None)


def db(a):
    return nio.power_to_db(a)


def sequential(v, lo, hi):
    t = np.clip(np.nan_to_num((v - lo) / (hi - lo), nan=0.0), 0, 1) * (len(SEQ) - 1)
    i = np.minimum(np.floor(t).astype(int), len(SEQ) - 2)
    f = (t - i)[..., None]
    s = np.array(SEQ, dtype=float)
    rgb = (s[i] + (s[i + 1] - s[i]) * f).clip(0, 255).astype(np.uint8)
    rgb[np.isnan(v)] = (40, 40, 40)
    return rgb


def grey(v, lo, hi):
    g = nio.stretch(v, lo, hi)
    rgb = np.stack([g, g, g], axis=-1)
    rgb[np.isnan(v)] = (40, 40, 40)
    return rgb


def mean3(a):
    """3x3 moving mean that ignores NaN; needs >= 5 of 9 valid pixels."""
    v = np.isfinite(a)
    z = np.where(v, a, 0.0)
    R, C = a.shape
    P, N = np.pad(z, 1), np.pad(v.astype(np.float32), 1)
    s = sum(P[1 + i:1 + i + R, 1 + j:1 + j + C] for i in (-1, 0, 1) for j in (-1, 0, 1))
    n = sum(N[1 + i:1 + i + R, 1 + j:1 + j + C] for i in (-1, 0, 1) for j in (-1, 0, 1))
    return np.where(n >= 5, s / np.maximum(n, 1), np.nan)


def fetch_json(url, cache_name, data=None):
    """Download JSON once and keep a copy outside the repo (research\\cache)."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f), path, True
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "OmniSAR-processing/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read()
    with open(path, "wb") as f:
        f.write(raw)
    return json.loads(raw), path, False


# ------------------------------------------------------------------ 1. passes
def find_passes():
    passes = []
    for path in nio.finished_h5(DATA_DIR, FILE_PATTERN):
        with h5py.File(path, "r") as f:
            ident = f["/science/LSAR/identification"]
            start = ident["zeroDopplerStartTime"][()].decode()
            passes.append({
                "file": os.path.basename(path), "path": path, "date": start[:10], "start": start,
                "direction": ident["orbitPassDirection"][()].decode(), "track": int(ident["trackNumber"][()]),
                "frame": int(ident["frameNumber"][()]), "product_version": ident["productVersion"][()].decode(),
                "processing": next((x for x in os.path.basename(path).split("_") if x.startswith("P0")), "?"),
            })
    for p in passes:
        if not p["direction"].lower().startswith("a"):
            raise SystemExit(f"{p['file']} is not ascending - refusing to mix directions (trap 7)")
    before = [p for p in passes if p["date"] == "2026-07-17"]
    after = [p for p in passes if p["date"] in ("2026-09-15", "2026-10-21")]
    return before, after


# ------------------------------------------------------------------ 2. read the box in strips
def read_box(p, window=None):
    k = METHOD["multilook"]
    with h5py.File(p["path"], "r") as f:
        g = f[GRID]
        proj = nio.projection_params(g["projection"])
        x, y = g["xCoordinates"], g["yCoordinates"]
        (r0, r1, c0, c1), _ = nio.box_window(nio.case_box(CASE), x, y, proj)
        if window and window != (r0, r1, c0, c1):
            raise SystemExit("files are on different grids - refusing to compare them")
        nr, nc = (r1 - r0) // k, (c1 - c0) // k
        hh = np.full((nr, nc), np.nan, np.float32)
        hv = np.full((nr, nc), np.nan, np.float32)
        bad_n = 0
        step = k * 170
        for a in range(0, nr * k, step):
            b = min(a + step, nr * k)
            H = g["HHHH"][r0 + a:r0 + b, c0:c0 + nc * k].astype(np.float64)
            V = g["HVHV"][r0 + a:r0 + b, c0:c0 + nc * k].astype(np.float64)
            M = g["mask"][r0 + a:r0 + b, c0:c0 + nc * k]
            bad = (M == 0) | (M == 255) | ~(H > 0) | ~(V > 0)
            bad_n += int(bad.sum())
            H[bad] = np.nan
            V[bad] = np.nan
            hh[a // k:b // k] = nio.multilook(H, k)
            hv[a // k:b // k] = nio.multilook(V, k)
        xs = x[c0:c0 + nc * k].astype(np.float64).reshape(nc, k).mean(axis=1)
        ys = y[r0:r0 + nr * k].astype(np.float64).reshape(nr, k).mean(axis=1)
        looks = float(np.nanmedian(g["numberOfLooks"][r0:r1:64, c0:c1:64]))
    return {"hh": hh, "hv": hv, "window": (r0, r1, c0, c1), "proj": proj, "x": xs, "y": ys,
            "looks": looks, "valid_share": 1 - bad_n / (nr * k * nc * k)}


def read_raw_hv(p, window, rr, cc):
    """A small window of native 10 m HV (for the speckle exhibit)."""
    r0, _, c0, _ = window
    with h5py.File(p["path"], "r") as f:
        v = f[GRID]["HVHV"][r0 + rr[0]:r0 + rr[1], c0 + cc[0]:c0 + cc[1]].astype(np.float64)
    v[~(v > 0)] = np.nan
    return db(v)


def interference(ref, others, boxes):
    ref_s, _ = frame_sample(ref)
    rows = []
    for p in others:
        s, _ = frame_sample(p)
        d = s - ref_s
        row = {"pass": p["date"], "compared_with": ref["date"]}
        for k, ch in enumerate(("HH", "HV")):
            frame_med = float(np.nanmedian(d[:, :, k]))
            box_med = float(np.nanmedian(db(boxes[p["date"]][ch.lower()])) - np.nanmedian(db(boxes[ref["date"]][ch.lower()])))
            row[ch] = {"box_median_change_db": round(box_med, 2), "frame_median_change_db": round(frame_med, 2),
                       "anomaly_over_box": bool(abs(box_med - frame_med) >= METHOD["interference_limit_db"])}
        row["anomaly_over_box"] = row["HH"]["anomaly_over_box"] or row["HV"]["anomaly_over_box"]
        rows.append(row)
    return rows


# ------------------------------------------------------------------ 5. radar geometry
def look_geometry(p, grid):
    """LOS (target -> satellite) east/north components and incidence angle for every 30 m pixel,
    from the file's radarGrid cube (0 m height layer, nearest cell, ~500 m spacing)."""
    with h5py.File(p["path"], "r") as f:
        rg = f["/science/LSAR/GCOV/metadata/radarGrid"]
        iz = int(np.argmin(np.abs(rg["heightAboveEllipsoid"][:])))
        gx, gy = rg["xCoordinates"][:], rg["yCoordinates"][:]
        j = np.clip(np.searchsorted(gx, grid["x"]), 0, len(gx) - 1)
        i = np.clip(np.searchsorted(-gy, -grid["y"]), 0, len(gy) - 1)
        i0, i1, j0, j1 = int(i.min()), int(i.max()) + 1, int(j.min()), int(j.max()) + 1
        lx = rg["losUnitVectorX"][iz, i0:i1, j0:j1]
        ly = rg["losUnitVectorY"][iz, i0:i1, j0:j1]
        inc = rg["incidenceAngle"][iz, i0:i1, j0:j1]
    I, J = np.meshgrid(i - i0, j - j0, indexing="ij")
    return lx[I, J].astype(np.float64), ly[I, J].astype(np.float64), inc[I, J].astype(np.float64)


# ------------------------------------------------------------------ 7. perimeters
def load_perimeters():
    with open(PERIMETERS, encoding="utf-8") as f:
        gj = json.load(f)
    fires = []
    for ft in gj["features"]:
        name = ft["properties"].get("poly_IncidentName")
        if name not in FIRES:
            continue
        g = ft["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        fires.append({"name": name, "polys": polys, "acres": ft["properties"].get("poly_GISAcres"),
                      "discovered": dt.datetime.fromtimestamp(ft["properties"]["attr_FireDiscoveryDateTime"] / 1000, dt.timezone.utc).date().isoformat(),
                      "perimeter_date": dt.datetime.fromtimestamp(ft["properties"]["poly_DateCurrent"] / 1000, dt.timezone.utc).date().isoformat()})
    return fires


def to_px(lon, lat, grid):
    X, Y = nio.lonlat_to_utm(lon, lat, grid["proj"])
    return (X - grid["x"][0]) / 30.0 + 0.5, (grid["y"][0] - Y) / 30.0 + 0.5


def rasterise(fires, grid, shape):
    img = Image.new("L", (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    rings_px = []
    for fire in fires:
        for poly in fire["polys"]:
            for k, ring in enumerate(poly):
                pts = [to_px(lon, lat, grid) for lon, lat in ring[:: max(1, len(ring) // 4000)]]
                d.polygon(pts, fill=1 if k == 0 else 0)
                rings_px.append(pts)
    return np.asarray(img, dtype=bool), rings_px


# ------------------------------------------------------------------ 8. Highway 1
def highway(grid):
    w, s, e, n = nio.case_box(CASE)
    q = (f'[out:json][timeout:90];way["highway"]["ref"~"(^|;) *(CA|SR) *1 *(;|$)"]({s},{w},{n},{e});out geom;')
    data, path, cached = fetch_json("https://overpass-api.de/api/interpreter",
                                    "osm_highway1_bigsur.json", data=urllib.parse.urlencode({"data": q}).encode())
    lines = []
    for el in data.get("elements", []):
        pts = [nio.lonlat_to_utm(g["lon"], g["lat"], grid["proj"]) for g in el.get("geometry", [])]
        if len(pts) > 1:
            lines.append(pts)
    dense = []
    for pts in lines:
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            m = max(1, int(math.ceil(math.hypot(x1 - x0, y1 - y0) / 15)))
            for t in range(m):
                dense.append((x0 + (x1 - x0) * t / m, y0 + (y1 - y0) * t / m))
        dense.append(pts[-1])
    return {"query": q, "cache": os.path.relpath(path, nio.PROJECT), "from_cache": cached,
            "osm_timestamp": data.get("osm3s", {}).get("timestamp_osm_base"), "ways": len(lines),
            "lines": lines, "points": np.array(dense) if dense else np.zeros((0, 2))}


def min_dist(xs, ys, road):
    best = np.inf
    for a in range(0, len(xs), 2000):
        dx = xs[a:a + 2000, None] - road[None, :, 0]
        dy = ys[a:a + 2000, None] - road[None, :, 1]
        best = min(best, float(np.sqrt(dx * dx + dy * dy).min()))
    return best


# ------------------------------------------------------------------ 9. NASA POWER
def power():
    lat, lon = CENTRE
    end = (dt.date.today()).strftime("%Y%m%d")
    url = ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,GWETTOP&community=AG"
           f"&longitude={lon}&latitude={lat}&start=20260701&end={end}&format=JSON")
    data, path, cached = fetch_json(url, f"power_bigsur_{end}.json")
    par = data["properties"]["parameter"]
    fill = data.get("header", {}).get("fill_value", -999)
    days = []
    for k in sorted(par["PRECTOTCORR"]):
        p, w = par["PRECTOTCORR"][k], par["GWETTOP"].get(k)
        days.append({"date": f"{k[:4]}-{k[4:6]}-{k[6:]}",
                     "precip_mm": None if p is None or p <= fill + 1 else round(float(p), 2),
                     "gwettop": None if w is None or w <= fill + 1 else round(float(w), 3)})
    return {"url": url, "cache": os.path.relpath(path, nio.PROJECT), "from_cache": cached, "days": days,
            "version": data.get("header", {}).get("sources") or data.get("header", {}).get("title")}


def rain_between(days, d0, d1):
    v = [d["precip_mm"] for d in days if d0 <= d["date"] <= d1 and d["precip_mm"] is not None]
    return (round(sum(v), 1), len(v))


# ------------------------------------------------------------------ images
def to_img(rgb, width=620):
    im = Image.fromarray(rgb)
    return im.resize((width, round(im.height * width / im.width)), Image.BILINEAR)


def draw_lines(im, rings_px, shape, colour=(255, 255, 255), width=2, road=None, grid=None):
    sx, sy = im.width / shape[1], im.height / shape[0]
    d = ImageDraw.Draw(im)
    for pts in rings_px:
        d.line([(x * sx, y * sy) for x, y in pts] + [(pts[0][0] * sx, pts[0][1] * sy)], fill=colour, width=width)
    if road is not None:
        for line in road:
            d.line([(((X - grid["x"][0]) / 30 + 0.5) * sx, ((grid["y"][0] - Y) / 30 + 0.5) * sy) for X, Y in line],
                   fill=(255, 255, 255), width=3)
            d.line([(((X - grid["x"][0]) / 30 + 0.5) * sx, ((grid["y"][0] - Y) / 30 + 0.5) * sy) for X, Y in line],
                   fill=(30, 30, 30), width=1)
    return im


def mask_rgb(base_rgb, masks):
    out = base_rgb.astype(float).copy()
    for m, rgba in masks:
        a = rgba[3] / 255
        out[m] = out[m] * (1 - a) + np.array(rgba[:3]) * a
    return out.clip(0, 255).astype(np.uint8)


def save(img, name):
    img.save(os.path.join(ASSET_DIR, name), optimize=True)
    return f"assets/cases/{CASE}/{name}"


def rain_chart(days, radar_dates, fire_dates):
    W, H, L, B, T = 640, 220, 46, 34, 30
    im = Image.new("RGB", (W, H), (20, 22, 28))
    d = ImageDraw.Draw(im)
    vals = [x["precip_mm"] or 0 for x in days]
    top = max(10.0, max(vals) * 1.1)
    n = len(days)
    bw = (W - L - 10) / n
    for i, x in enumerate(days):
        if x["precip_mm"] is None:
            continue
        h = (H - B - T) * (x["precip_mm"] / top)
        d.rectangle([L + i * bw, H - B - h, L + (i + 1) * bw - 1, H - B], fill=(67, 147, 195))
    d.line([L, H - B, W - 10, H - B], fill=(150, 150, 150))
    d.line([L, T, L, H - B], fill=(150, 150, 150))
    d.text((L - 40, T - 4), f"{top:.0f} mm", fill=(180, 180, 180), font=font(11))
    d.text((L - 20, H - B - 8), "0", fill=(180, 180, 180), font=font(11))
    idx = {x["date"]: i for i, x in enumerate(days)}
    for date, label, col in [(r, f"NISAR {fmt_date(r)}", (102, 252, 241)) for r in radar_dates] + \
                            [(f, lab, (242, 142, 43)) for f, lab in fire_dates]:
        if date in idx:
            xx = L + (idx[date] + 0.5) * bw
            d.line([xx, T, xx, H - B], fill=col)
            d.text((xx + 2, T - 14 if col[0] == 102 else T), label, fill=col, font=font(10))
    d.text((L, H - B + 6), f"{fmt_date(days[0]['date'])} 2026", fill=(180, 180, 180), font=font(11))
    d.text((W - 110, H - B + 6), f"{fmt_date(days[-1]['date'])} 2026", fill=(180, 180, 180), font=font(11))
    d.text((L, 6), "Daily rain at the box centre (mm). " + METHOD["power_label"], fill=(225, 225, 225), font=font(12))
    return im


# ------------------------------------------------------------------ main
def main():
    t0 = time.time()
    before, after_all = find_passes()
    log(f"before {[p['date'] for p in before]}  after (finished) {[p['date'] for p in after_all]}")
    if not before or not any(p["date"] == "2026-09-15" for p in after_all):
        raise SystemExit("Need the finished 17 Jul and 15 Sep passes - the case stays 'evidence pending'.")
    os.makedirs(KIT_DIR, exist_ok=True)
    os.makedirs(ASSET_DIR, exist_ok=True)

    log("NASA POWER rain...")
    pw = power()
    days = pw["days"]

    # 21 Oct dry-soil rule (declared before results)
    after, excluded = [], []
    for p in after_all:
        if p["date"] == "2026-10-21":
            r7, n7 = rain_between(days, "2026-10-14", "2026-10-20")
            if n7 < 7 or r7 >= METHOD["wet_rule_mm"]:
                excluded.append({"pass": p["date"], "reason": f"rain in the 7 days before: {r7} mm over {n7} days with data (rule: < {METHOD['wet_rule_mm']} mm)"})
                continue
        after.append(p)
    passes = before + after
    boxes, window = {}, None
    for p in passes:
        boxes[p["date"]] = read_box(p, window)
        window = boxes[p["date"]]["window"]
        log(f"  read {p['date']}  valid {boxes[p['date']]['valid_share']:.1%}  looks {boxes[p['date']]['looks']:.1f}  ({time.time() - t0:.0f} s)")
    grid = boxes[before[0]["date"]]
    shape = grid["hv"].shape

    log("interference check...")
    inter = interference(before[0], after, boxes)
    for r in inter:
        log("  ", json.dumps(r))
        if r["anomaly_over_box"]:
            excluded.append({"pass": r["pass"], "reason": "interference check flagged this pass"})
    after = [p for p in after if not any(x["pass"] == p["date"] for x in excluded)]
    if not after:
        raise SystemExit("No usable after pass - the case stays 'evidence pending'.")

    hv_b = db(boxes[before[0]["date"]]["hv"])
    hh_b = db(boxes[before[0]["date"]]["hh"])
    hv_a = np.nanmedian(np.stack([db(boxes[p["date"]]["hv"]) for p in after]), axis=0)
    hh_a = np.nanmedian(np.stack([db(boxes[p["date"]]["hh"]) for p in after]), axis=0)
    d_hv = mean3(hv_a - hv_b)
    d_hh = mean3(hh_a - hh_b)

    log("heights + slope + geometry...")
    elev = terrain.grid_heights(grid["x"], grid["y"], grid["proj"])
    land = elev > 0
    dh_de = np.gradient(elev, 30.0, axis=1)
    dh_dn = -np.gradient(elev, 30.0, axis=0)
    slope = np.degrees(np.arctan(np.hypot(dh_de, dh_dn)))
    lx, ly, inc = look_geometry(before[0], grid)
    hn = np.hypot(lx, ly)
    s = dh_de * lx / hn + dh_dn * ly / hn            # rise toward the satellite (m per m)
    layover = np.degrees(np.arctan(-s)) >= inc
    shadow = np.degrees(np.arctan(s)) >= 90 - inc
    away = np.degrees(np.arctan(s)) >= METHOD["facing_away_deg"]
    flag = land & (layover | shadow | away)
    steep = slope >= METHOD["steep_deg"]
    valid = land & np.isfinite(d_hv)
    log(f"  land {land.mean():.1%}  flagged {flag[land].mean():.1%} of land (layover {layover[land].sum()} shadow {shadow[land].sum()} away {away[land].sum()} px)  incidence {np.nanmin(inc):.1f}-{np.nanmax(inc):.1f}")

    log("burn patches...")
    cand = valid & (d_hv <= METHOD["burn_db"])
    burn_all = np.zeros(shape, bool)
    for members in nio.label_clusters(cand):
        if len(members) >= METHOD["min_patch_px"]:
            burn_all[members[:, 0], members[:, 1]] = True
    burn = burn_all & ~flag
    burn_low = burn_all & flag
    px_km2 = 30 * 30 / 1e6
    log(f"  candidate {cand.sum() * px_km2:.1f} km2, burn (unflagged) {burn.sum() * px_km2:.2f} km2, low-confidence {burn_low.sum() * px_km2:.2f} km2")

    log("perimeter check...")
    fires = load_perimeters()
    perim, rings_px = rasterise(fires, grid, shape)
    usable = valid & ~flag
    inside = burn & perim
    A = inside.sum() / max(burn.sum(), 1)
    B = inside.sum() / max((perim & usable).sum(), 1)
    lim = METHOD["badge_limit"]
    badge = "Strong" if (A >= lim and B >= lim) else "Moderate" if (A >= lim or B >= lim) else "Weak"
    log(f"  A (our burn inside perimeters) {A:.1%}  B (perimeter detected) {B:.1%}  -> {badge}")
    per_fire = []
    for fire in fires:
        pm, _ = rasterise([fire], grid, shape)
        per_fire.append({"fire": fire["name"], "discovered": fire["discovered"], "perimeter_date": fire["perimeter_date"],
                         "nifc_acres": round(fire["acres"]), "perimeter_km2_usable": round(float((pm & usable).sum() * px_km2), 1),
                         "detected_km2": round(float((burn & pm).sum() * px_km2), 1),
                         "detected_share": round(float((burn & pm).sum() / max((pm & usable).sum(), 1)), 3),
                         "median_hv_change_db": round(float(np.nanmedian(d_hv[pm & usable])), 2),
                         "median_hv_before_db": round(float(np.nanmedian(hv_b[pm & usable])), 2)})

    log("Highway 1 (OpenStreetMap)...")
    hw = highway(grid)
    log(f"  {hw['ways']} ways, {len(hw['points'])} points (osm {hw['osm_timestamp']})")
    bs = burn & steep
    areas = []
    for members in nio.label_clusters(bs):
        if len(members) < METHOD["min_patch_px"]:
            continue
        r, c = members[:, 0], members[:, 1]
        X, Y = grid["x"][c], grid["y"][r]
        dist = min_dist(X, Y, hw["points"]) if len(hw["points"]) else None
        lon, lat = nio.utm_to_lonlat(X.mean(), Y.mean(), grid["proj"])
        areas.append({"area_ha": round(len(members) * 0.09, 1), "lat": round(float(lat), 5), "lon": round(float(lon), 5),
                      "distance_to_hwy1_m": None if dist is None else round(dist), "mean_slope_deg": round(float(slope[r, c].mean()), 1),
                      "mean_hv_change_db": round(float(d_hv[r, c].mean()), 2),
                      "inside_perimeter_share": round(float(perim[r, c].mean()), 2), "_m": members})
    areas.sort(key=lambda a: (a["distance_to_hwy1_m"] is None, a["distance_to_hwy1_m"] or 0))
    for i, a in enumerate(areas):
        a["id"] = f"S{i + 1:02d}"
    top3 = areas[:3]
    log("  top 3:", [(a["id"], a["distance_to_hwy1_m"], a["area_ha"]) for a in top3])

    since_fire = [d for d in days if d["date"] >= "2026-08-26"]
    rain_total, rain_n = rain_between(days, "2026-08-26", TODAY)
    dry_check = rain_between(days, "2026-07-17", "2026-09-15")
    cum, series = 0.0, []
    for d in since_fire:
        if d["precip_mm"] is not None:
            cum += d["precip_mm"]
        series.append({**d, "cumulative_mm": round(cum, 1)})
    last_wet = next((d for d in reversed(days) if d["gwettop"] is not None), None)
    last_rain = next((d["date"] for d in reversed(since_fire) if d["precip_mm"] is not None), "?")
    wet_days = sum(1 for d in since_fire if (d["precip_mm"] or 0) >= 10)
    log(f"  rain since 26 Aug {rain_total} mm over {rain_n} days; 17 Jul-15 Sep {dry_check}; last GWETTOP {last_wet}")

    # ---------------- images ----------------
    log("images...")
    made = {}
    land_nan = lambda a: np.where(land, a, np.nan)
    im = draw_lines(to_img(diverging(land_nan(d_hv), 6.0)), rings_px, shape, colour=(20, 20, 20))
    made["ev-hv-drop"] = save(caption_strip(im, [f"NISAR HV change {fmt_date(before[0]['date'])} → {', '.join(fmt_date(p['date']) for p in after)} (blue = fell, red = rose, ±6 dB)",
                                                 "Black outlines: NIFC fire perimeters (Timber north, Plaskett south). Sea left out."]), "ev-hv-drop.png")
    base = grey(land_nan(hv_a), -30, -8)
    im = draw_lines(to_img(mask_rgb(base, [(burn, BURN_RGBA), (burn_low, FLAG_RGBA)])), rings_px, shape)
    made["ev-check"] = save(caption_strip(im, [f"Orange: our burn (HV fell ≥ 2 dB, patches ≥ 5 ha). Purple: burn on radar-distorted slopes (low confidence).",
                                               f"White: NIFC perimeters. {A:.0%} of our burn is inside them; we detect {B:.0%} of their area."]), "ev-check.png")
    im = to_img(mask_rgb(grey(land_nan(hv_b), -30, -8), [(flag, FLAG_RGBA)]))
    made["ev-geometry"] = save(caption_strip(im, [f"Purple: slopes where the radar view is distorted ({flag[land].mean():.0%} of land): layover, shadow,",
                                                  f"or steep slopes facing away from the satellite (it looks from the east, at {np.nanmedian(inc):.0f}° from vertical)."]), "ev-geometry.png")
    # dark != burned
    dark_lim = float(np.nanpercentile(hv_a[usable], 10))
    dark = usable & (hv_a <= dark_lim)
    dark_out = float((dark & ~perim).sum() / max(dark.sum(), 1))
    dark_unburned = float((dark & ~burn).sum() / max(dark.sum(), 1))
    im = draw_lines(to_img(mask_rgb(grey(land_nan(hv_a), -30, -8), [(dark, (67, 147, 195, 200))])), rings_px, shape)
    made["ev-dark"] = save(caption_strip(im, [f"Blue: the darkest tenth of land in HV on {fmt_date(after[0]['date'])} (≤ {dark_lim:.1f} dB). White: fire perimeters.",
                                              f"{dark_out:.0%} of these dark pixels are OUTSIDE the perimeters, and {dark_unburned:.0%} did not get darker since July."]), "ev-dark.png")
    # speckle: raw 10 m change vs filtered, in a 600 x 600 px window centred on the biggest burn patch inside Plaskett
    rr, cc = np.nonzero(burn & perim)
    cr, ccn = (int(np.median(rr)), int(np.median(cc))) if len(rr) else (shape[0] // 2, shape[1] // 2)
    half = 100
    w0r, w0c = max(cr - half, 0), max(ccn - half, 0)
    raw_b = read_raw_hv(before[0], window, (w0r * 3, (w0r + 2 * half) * 3), (w0c * 3, (w0c + 2 * half) * 3))
    raw_a = read_raw_hv(after[0], window, (w0r * 3, (w0r + 2 * half) * 3), (w0c * 3, (w0c + 2 * half) * 3))
    raw_d = raw_a - raw_b
    filt = d_hv[w0r:w0r + 2 * half, w0c:w0c + 2 * half]
    calm = ~perim[w0r:w0r + 2 * half, w0c:w0c + 2 * half] & usable[w0r:w0r + 2 * half, w0c:w0c + 2 * half]
    calm10 = np.kron(calm, np.ones((3, 3), bool))[:raw_d.shape[0], :raw_d.shape[1]]
    sd_raw = float(np.nanstd(raw_d[calm10])) if calm10.any() else float("nan")
    sd_f = float(np.nanstd(filt[calm])) if calm.any() else float("nan")
    a_img = Image.fromarray(diverging(raw_d, 6.0)).resize((300, 300), Image.NEAREST)
    b_img = Image.fromarray(diverging(filt, 6.0)).resize((300, 300), Image.NEAREST)
    made["ev-speckle"] = save(side_by_side([(a_img, f"Raw 10 m pixels, one pass each (spread {sd_raw:.1f} dB)"),
                                            (b_img, f"Filtered 30 m + smoothed (spread {sd_f:.1f} dB)")],
                                           "Same 6 km square, same two passes: HV change outside the fire"), "ev-speckle.png")
    # steep burned areas near Highway 1
    top_mask = np.zeros(shape, bool)
    for a in top3:
        top_mask[a["_m"][:, 0], a["_m"][:, 1]] = True
    im = to_img(mask_rgb(grey(land_nan(elev), 0, 1500), [(burn, (242, 142, 43, 140)), (bs, BURN_RGBA), (top_mask, STEEP_RGBA)]))
    im = draw_lines(im, [], shape, road=hw["lines"], grid=grid)
    d = ImageDraw.Draw(im)
    for a in top3:
        r, c = a["_m"][:, 0].mean(), a["_m"][:, 1].mean()
        d.text((c * im.width / shape[1] + 6, r * im.height / shape[0] - 6), a["id"], fill=(255, 255, 255), font=font(14))
    made["ev-steep-hwy"] = save(caption_strip(im, ["Grey = ground height (Terrarium). Orange = burned; red = burned on slopes ≥ 23°;",
                                                   "yellow = the 3 burned steep areas nearest Highway 1 (white line, OpenStreetMap)."]), "ev-steep-hwy.png")
    made["ev-rain"] = save(rain_chart(days, [p["date"] for p in passes], [("2026-08-09", "Timber"), ("2026-08-26", "Plaskett")]), "ev-rain.png")
    # toggles
    made["tg-hh"] = save(caption_strip(draw_lines(to_img(diverging(land_nan(d_hh), 6.0)), rings_px, shape, colour=(20, 20, 20)),
                                       ["HH change (direct echo), same passes, ±6 dB"]), "tg-hh.png")
    made["tg-hv"] = save(caption_strip(draw_lines(to_img(diverging(land_nan(d_hv), 6.0)), rings_px, shape, colour=(20, 20, 20)),
                                       ["HV change (canopy echo), same passes, ±6 dB"]), "tg-hv.png")
    made["tg-raw"] = save(caption_strip(a_img, [f"Raw 10 m, spread {sd_raw:.1f} dB"]), "tg-raw.png")
    made["tg-filtered"] = save(caption_strip(b_img, [f"Filtered + smoothed, spread {sd_f:.1f} dB"]), "tg-filtered.png")
    g_off = to_img(mask_rgb(grey(land_nan(hv_a), -30, -8), [(burn_all, BURN_RGBA)]))
    g_on = to_img(mask_rgb(grey(land_nan(hv_a), -30, -8), [(burn, BURN_RGBA), (burn_low, FLAG_RGBA)]))
    made["tg-geom-off"] = save(caption_strip(g_off, [f"Every burn patch: {burn_all.sum() * px_km2:.1f} km²"]), "tg-geom-off.png")
    made["tg-geom-on"] = save(caption_strip(g_on, [f"Distorted slopes set apart (purple): {burn.sum() * px_km2:.1f} km² kept"]), "tg-geom-on.png")
    made["tg-lband"] = save(caption_strip(to_img(grey(land_nan(hv_a), -30, -8)), [f"NISAR L-band (24 cm) HV, {fmt_date(after[0]['date'])}, our GCOV processing"]), "tg-lband.png")
    lons, lats = zip(*[nio.utm_to_lonlat(xx, yy, grid["proj"]) for xx in (grid["x"][0], grid["x"][-1]) for yy in (grid["y"][0], grid["y"][-1])])
    extent = (float(min(lons)), float(min(lats)), float(max(lons)), float(max(lats)))
    try:
        rtc_day, rtc_img, rtc_url = nearest_with_data(RTC_LAYER, after[0]["date"], extent, (620, round(620 * shape[0] / shape[1])))
    except Exception as ex:
        log("  C-band picture failed:", ex)
        rtc_day, rtc_img, rtc_url = None, None, None
    if rtc_img is not None:
        made["tg-cband"] = save(caption_strip(rtc_img, [f"Sentinel-1 C-band (5.6 cm), NASA OPERA RTC picture tile, {rtc_day} (nearest date)"]), "tg-cband.png")

    # overlay + terrain grid
    ov = np.zeros(shape + (4,), np.uint8)
    ov[burn] = BURN_RGBA
    ov[bs] = (214, 60, 40, 245)
    ov[burn_low] = FLAG_RGBA
    Image.fromarray(ov, "RGBA").save(os.path.join(ASSET_DIR, "burn_overlay.png"), optimize=True)
    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (-1, 0), "sw": (0, -1), "se": (-1, -1)}.items():
        lon, lat = nio.utm_to_lonlat(grid["x"][cx], grid["y"][cy], grid["proj"])
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]
    grid_out = save_grid(grid, elev, land, hv_b, hv_a, d_hv, slope, burn, bs, burn_low, before, after)

    # ---------------- numbers ----------------
    hw_km = lambda m: f"{m / 1000:.1f} km" if m is not None and m >= 1000 else f"{m} m"
    measured = [
        {"label": "Burned (NISAR HV fell ≥ 2 dB)", "value": round(float(burn.sum() * px_km2), 1), "unit": "km²",
         "note": f"Patches of 5 ha or more, {fmt_date(before[0]['date'])} vs {', '.join(fmt_date(p['date']) for p in after)}. Radar-distorted slopes are counted separately below."},
        {"label": "Burned on slopes ≥ 23°", "value": round(float(bs.sum() * px_km2), 1), "unit": "km²",
         "note": "23° is the slope term of the USGS post-fire debris-flow likelihood model (Staley et al. 2016, 2017). Slope from Terrarium heights (~30 m)."},
        {"label": "Burn on radar-distorted slopes (low confidence)", "value": round(float(burn_low.sum() * px_km2), 1), "unit": "km²",
         "note": f"Layover, shadow or steep slopes facing away from the satellite ({flag[land].mean():.0%} of land). Trap 9: not counted above."},
    ]
    for a in top3:
        measured.append({"label": f"{a['id']}: burned steep area near Highway 1", "value": hw_km(a["distance_to_hwy1_m"]), "unit": "from the road",
                         "note": f"{a['area_ha']} ha, mean slope {a['mean_slope_deg']}°, HV {a['mean_hv_change_db']:+.1f} dB, centre {a['lat']:.4f} N, {abs(a['lon']):.4f} W"})
    measured.append({"label": "Rain on the scar since 26 Aug", "value": rain_total, "unit": "mm",
                     "note": f"{wet_days} day(s) with ≥ 10 mm, 26 Aug to {last_rain} ({rain_n} days with data). {METHOD['power_label']}. Measured rain, not a forecast."})
    if last_wet:
        measured.append({"label": "Surface wetness (GWETTOP)", "value": last_wet["gwettop"], "unit": "(0 = dry, 1 = saturated)",
                         "note": f"Latest day with data: {last_wet['date']}. {METHOD['power_label']}."})
    measured.append({"label": "Passes compared", "value": f"{len(before)} before · {len(after)} after", "unit": "",
                     "note": "; ".join(f"{fmt_date(x['pass'])} not used: {x['reason']}" for x in excluded) or "Single passes per side: the 3×3 filtering and 5 ha patch rule keep speckle out."})
    check_text = (f"NIFC fire perimeters (Timber + Plaskett): {A:.0%} of our burned area lies inside them, and we detect {B:.0%} of the "
                  f"perimeter area (on land the radar sees without distortion). "
                  + " ".join(f"{f['fire']}: {f['detected_share']:.0%} detected, median HV change inside {f['median_hv_change_db']:+.1f} dB"
                             f" (perimeter mapped {f['perimeter_date']})." for f in per_fire)
                  + " Where HV barely changed, our radar rule finds no canopy loss; the radar alone can't say why (for example a low-severity"
                  " fire that left the canopy standing, or a fire that grew after our 15 Sep pass).")
    numbers = {
        "case": CASE,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured,
        "check": {"label": "Independent check", "text": check_text},
        "badge": badge,
        "badge_reason": f"A = {A:.0%} of our burn inside the perimeters, B = {B:.0%} of the perimeters detected (rule: both ≥ 60% Strong, one Moderate)",
        "sources": [p["file"] for p in passes],
        "custody_extra": [{"label": "Passes not used", "value": len(excluded), "unit": "", "note": json.dumps(excluded)}] if excluded else [],
        "method": METHOD,
        "results": {
            "burn_km2": round(float(burn.sum() * px_km2), 2), "burn_steep_km2": round(float(bs.sum() * px_km2), 2),
            "burn_low_confidence_km2": round(float(burn_low.sum() * px_km2), 2), "burn_all_patches_km2": round(float(burn_all.sum() * px_km2), 2),
            "candidate_pixels_km2_before_patch_rule": round(float(cand.sum() * px_km2), 2),
            "check": {"A_burn_inside_perimeters": round(float(A), 3), "B_perimeter_detected": round(float(B), 3), "per_fire": per_fire},
            "geometry": {"flagged_share_of_land": round(float(flag[land].mean()), 3), "layover_px": int((layover & land).sum()),
                         "shadow_px": int((shadow & land).sum()), "facing_away_px": int((away & land).sum()),
                         "incidence_deg": [round(float(np.nanmin(inc)), 1), round(float(np.nanmax(inc)), 1)],
                         "los_east_north_median": [round(float(np.nanmedian(lx)), 3), round(float(np.nanmedian(ly)), 3)]},
            "steep_areas_top3": [{k: v for k, v in a.items() if not k.startswith("_")} for a in top3],
            "steep_areas_count": len(areas),
            "interference": inter, "excluded_passes": excluded,
            "pass_medians": [{"date": p["date"], "hv_box_median_db": round(float(np.nanmedian(db(boxes[p["date"]]["hv"])[land])), 2),
                              "hh_box_median_db": round(float(np.nanmedian(db(boxes[p["date"]]["hh"])[land])), 2)} for p in passes],
            "dark_not_burned": {"dark_limit_db": round(dark_lim, 2), "dark_outside_perimeters": round(dark_out, 3), "dark_not_darker_since_july": round(dark_unburned, 3)},
            "speckle": {"raw_10m_spread_db": round(sd_raw, 2), "filtered_spread_db": round(sd_f, 2)},
            "rain": {"label": METHOD["power_label"], "since_26_aug_mm": rain_total, "days_with_data": rain_n, "days_ge_10mm": wet_days,
                     "rain_17jul_15sep_mm": dry_check[0], "latest_gwettop": last_wet, "series": series},
            "highway": {k: v for k, v in hw.items() if k not in ("lines", "points")},
            "cband_picture": {"date": rtc_day, "url": rtc_url, "note": "picture tile for comparison only (trap 13)"},
        },
        "files": {"overlay": f"assets/cases/{CASE}/burn_overlay.png", "overlay_corners_latlon": corners, "grid": f"assets/cases/{CASE}/grid.json"},
        "provenance": {
            "nasa_files": [{k: p[k] for k in ("file", "date", "start", "direction", "track", "frame", "product_version", "processing")} for p in passes],
            "collection": "NISAR L2 GCOV (ASF DAAC)",
            "layers": [f"{GRID}/{n}" for n in METHOD["layers"]] + ["/science/LSAR/GCOV/metadata/radarGrid/{losUnitVectorX,losUnitVectorY,incidenceAngle}"],
            "box_lonlat": list(nio.case_box(CASE)), "box_rows_cols": list(window), "projection_epsg": grid["proj"]["epsg"],
            "pixel_m_after_filter": 30.0, "number_of_looks_native": grid["looks"],
            "other_sources": {
                "perimeters": "research/bigsur_fire_perimeters_NIFC.geojson (NIFC WFIGS interagency perimeters: Timber, Plaskett)",
                "heights": terrain.SOURCE,
                "highway": f"OpenStreetMap contributors, Overpass API (ODbL); query in results.highway.query; OSM data as of {hw['osm_timestamp']}",
                "rain": f"NASA POWER daily API, {pw['url']}",
            },
            "steps": ["read only the box rows/columns, in strips", "mask invalid pixels", "3x3 multilook (linear power)", "dB",
                      "interference check (whole-frame sample)", "HV change after - before", "3x3 moving mean", "Terrarium heights -> slope, land mask",
                      "radar geometry from the file's LOS vector -> layover / shadow / facing-away flags", "burn = HV change <= -2 dB, patches >= 5 ha",
                      "NIFC perimeter check -> badge", "Highway 1 distance ranking", "NASA POWER rain since the fire"],
            "script": "tools/process_big_sur.py", "script_version": SCRIPT_VERSION,
            "script_sha256": sha256(os.path.abspath(__file__)),
            "helpers_sha256": sha256(os.path.join(nio.HERE, "nisar_io.py")),
        },
    }
    with open(NUMBERS, "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(numbers), f, indent=1, ensure_ascii=False, allow_nan=False)
    log(f"wrote {NUMBERS}  badge={badge}  grid {grid_out['rows']}x{grid_out['cols']}")

    fill_mystery(made, numbers, A, B, flag, land, inc, dark_out, dark_unburned, dark_lim, sd_raw, sd_f, rain_total, dry_check, top3, rtc_day, after, before, excluded)
    update_results.update()
    log(f"done in {time.time() - t0:.0f} s")


def save_grid(grid, elev, land, hv_b, hv_a, d_hv, slope, burn, bs, burn_low, before, after):
    rows, cols = d_hv.shape
    m = max(1, math.ceil(math.sqrt(rows * cols / 60000)))
    R, C = rows // m, cols // m

    def mm(a):
        return np.nanmean(a[:R * m, :C * m].reshape(R, m, C, m), axis=(1, 3))

    def q(a):
        return [None if not np.isfinite(v) else int(round(v * 10)) for v in a.ravel()]

    L = lambda a: np.where(land, a, np.nan)
    share = lambda b: b[:R * m, :C * m].reshape(R, m, C, m).mean(axis=(1, 3))
    cls = np.zeros((R, C), int)
    cls[share(burn) >= 1 / 3] = 1
    cls[share(bs) >= 1 / 3] = 2
    cls[share(burn_low) >= 1 / 3] = 3
    bx = grid["x"][:C * m].reshape(C, m).mean(axis=1)
    by = grid["y"][:R * m].reshape(R, m).mean(axis=1)
    el = terrain.grid_heights(bx, by, grid["proj"])
    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (C * m - 1, 0), "sw": (0, R * m - 1), "se": (C * m - 1, R * m - 1)}.items():
        lon, lat = nio.utm_to_lonlat(grid["x"][cx], grid["y"][cy], grid["proj"])
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]
    src = "NISAR L2 GCOV, track 135 ascending"
    burn_layer = np.where(land, 0.0, np.nan)
    out = {
        "about": "Blocky case terrain grid for Big Sur. Layer values are x10 integers (null = no data); row 0 = north. Written by tools/process_big_sur.py.",
        "case": CASE, "rows": R, "cols": C, "merge": m, "pixel_m": 30.0, "block_m": 30.0 * m,
        "block_text": f"one block = {m}×{m} filtered pixels of 30 m = {3 * m}×{3 * m} NISAR 10 m pixels ≈ {30 * m} m",
        "corners_latlon": corners,
        "layers": [
            {"id": "hv-before", "label": f"HV {fmt_date(before[0]['date'])} 2026 (before both fires)", "date": before[0]["date"], "kind": "sequential",
             "unit": "dB", "scale": [-30, -8], "what": "NISAR HV backscatter (canopy echo)", "source": f"{src}, {before[0]['date']}", "values": q(mm(L(hv_b)))},
            {"id": "hv-after", "label": f"HV {', '.join(fmt_date(p['date']) for p in after)} 2026 (after)", "date": after[-1]["date"], "kind": "sequential",
             "unit": "dB", "scale": [-30, -8], "what": "NISAR HV backscatter (canopy echo)", "source": f"{src}, {', '.join(p['date'] for p in after)}", "values": q(mm(L(hv_a)))},
            {"id": "change", "label": "HV change: after vs before", "date": f"{before[0]['date']} → {after[-1]['date']}", "kind": "diverging",
             "unit": "dB", "scale": [-6, 6], "what": "HV change (blue = canopy echo fell)", "source": src, "lowWord": "fell", "highWord": "rose", "values": q(mm(L(d_hv)))},
            {"id": "burn", "label": "Burned share of each block", "date": f"{before[0]['date']} → {after[-1]['date']}", "kind": "sequential",
             "unit": "%", "scale": [0, 100], "what": "Share of the block our rule calls burned (HV fell ≥ 2 dB, patches ≥ 5 ha)", "source": src,
             "values": q(mm(np.where(land, burn.astype(float) * 100, np.nan)))},
            {"id": "slope", "label": "Slope (≥ 23° = steep)", "date": "", "kind": "sequential", "unit": "°", "scale": [0, 45],
             "what": "Ground slope from Terrarium heights", "source": terrain.SOURCE, "values": q(mm(L(slope)))},
        ],
        "default_layer": "change",
        "class": cls.ravel().tolist(),
        "class_names": {"1": "Burned", "2": "Burned, slope ≥ 23°", "3": "Burned, radar-distorted slope (low confidence)"},
        "elev_dm": [int(round(max(v, -1e4) * 10)) for v in el.ravel()],
        "height_source": terrain.SOURCE,
    }
    with open(os.path.join(ASSET_DIR, "grid.json"), "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(out), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return out


def fill_mystery(made, numbers, A, B, flag, land, inc, dark_out, dark_unburned, dark_lim, sd_raw, sd_f, rain_total, dry_check, top3, rtc_day, after, before, excluded):
    """Write the images, caption numbers and correct answers into cases/big-sur.json (answers come from the analysis)."""
    with open(MYSTERY, encoding="utf-8") as f:
        mys = json.load(f)
    r = numbers["results"]
    aft = ", ".join(fmt_date(p["date"]) for p in after)
    ev = {e["id"]: e for e in mys["evidence"]}
    ev["hv-drop"].update(src=made["ev-hv-drop"], bin="real", trap=None, pending=False,
                         caption=f"NISAR HV (the canopy echo) fell by 2 dB or more over {r['burn_km2']:.0f} km² between {fmt_date(before[0]['date'])} and {aft}. {A:.0%} of that lies inside the official fire perimeters.")
    ev["geometry"].update(src=made["ev-geometry"], bin="trap", trap=9, pending=False,
                          caption=f"On {flag[land].mean():.0%} of the land the radar's view is distorted: slopes facing away from the satellite, radar shadow or layover. Brightness changes there can be geometry, not fire, so we set them apart ({r['burn_low_confidence_km2']:.1f} km² of 'burn').")
    ev["dark"].update(src=made["ev-dark"], bin="trap", trap=11, pending=False,
                      caption=f"The darkest tenth of land in HV after the fire (≤ {dark_lim:.0f} dB): {dark_out:.0%} of it is outside the fire perimeters, and {dark_unburned:.0%} did not get darker since July. Dark ground is often just smooth or bare, not burned; only the change counts. "
                              + (f"Both dates were dry ({dry_check[0]} mm of rain between them, NASA POWER), so wet soil didn't change the brightness either."
                                 if dry_check[0] < METHOD["wet_rule_mm"] else f"Note: {dry_check[0]} mm of rain fell between the two dates (NASA POWER), so soil wetness may also differ."))
    ev["speckle"].update(src=made["ev-speckle"], bin="trap", trap=10, pending=False,
                         caption=f"Outside the fire, single 10 m pixels from one pass each 'change' with a spread of {sd_raw:.1f} dB, enough to fake a burn. Filtered to 30 m and smoothed, the spread drops to {sd_f:.1f} dB.")
    ev["steep-hwy"].update(src=made["ev-steep-hwy"], bin="real", trap=None, pending=False,
                           caption=(f"{r['burn_steep_km2']:.0f} km² of the burn is on slopes of 23° or more. Nearest to Highway 1: "
                                    + "; ".join(f"{a['id']} {a['distance_to_hwy1_m']} m away ({a['area_ha']} ha)" for a in top3) + "."))
    ev["rain"].update(src=made["ev-rain"], bin="real", trap=None, pending=False,
                      caption=f"{rain_total} mm of rain has fallen at the box centre since Plaskett started on 26 Aug (NASA POWER, regional, not per slope). Measured rain only, not a forecast.")
    tg = {t["id"]: t for t in mys["toggles"]}
    tg["channel"]["layers"] = {"off": {"src": made["tg-hh"], "label": "HH change"}, "on": {"src": made["tg-hv"], "label": "HV change"}}
    tg["speckle"]["layers"] = {"off": {"src": made["tg-raw"], "label": "Raw 10 m pixels"}, "on": {"src": made["tg-filtered"], "label": "Filtered + smoothed"}}
    tg["geometry"]["layers"] = {"off": {"src": made["tg-geom-off"], "label": "All burn patches"}, "on": {"src": made["tg-geom-on"], "label": "Distorted slopes set apart"}}
    if "tg-cband" in made:
        tg["band"]["layers"] = {"off": {"src": made["tg-lband"], "label": "L-band NISAR"}, "on": {"src": made["tg-cband"], "label": f"C-band Sentinel-1 ({rtc_day})"}}
        tg["band"]["disabled"] = None
    else:
        tg["band"]["disabled"] = "No C-band picture tile with data was found within 12 days of the after pass."
    with open(MYSTERY, "w", encoding="utf-8") as f:
        json.dump(mys, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
