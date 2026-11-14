"""
Al Ain case: which centre-pivot farms went quiet, and is that normal?

Run (from the repo folder):   py tools/process_al_ain.py
Re-run when the 30 Jun / 16 Oct passes finish, or when the AppEEARS HLS files arrive.

What it does, in order:
  1. Finds the finished NISAR GCOV files for track 056, ascending, frame 014 (mode 4005), 18 Jun - 28 Oct.
  2. Interference check (same whole-frame test as Jebel Ali): a pass with a patch over Al Ain is left out.
  3. Reads only the Al Ain box (10 m), measures HV in a 300 m disk at each logged pivot and at a desert
     control point, and classes each pivot Active / Fallow / Newly cleared (rules in METHOD).
  4. 26-year history: MODIS NDVI (NASA ORNL DAAC web service, public) per point -> "quiet this summer"
     vs "quiet for years".
  5. Independent check against HLS NDVI: PENDING until the AppEEARS files are downloaded.
  6. Writes cases/al-ain.numbers.json (full provenance), images, terrain grid, fills cases/al-ain.json.
"""

import datetime as dt
import json
import math
import os
import sys
import time
import urllib.request
import warnings

import h5py
import numpy as np
from PIL import Image, ImageDraw

import nisar_io as nio
import terrain
import update_results
from process_jebel_ali import GRID, frame_sample, font, sha256, fmt_date, log
from process_big_sur import caption_strip, side_by_side, grey, to_img, mask_rgb, diverging
from evidence_jebel_ali import nearest_with_data, RTC_LAYER

warnings.filterwarnings("ignore", category=RuntimeWarning)

SCRIPT_VERSION = "1.1"   # 1.1: parallel MODIS download; MODIS value nearest each pass shown beside the radar class (METHOD unchanged)
CASE = "al-ain"
DATA_DIR = os.path.join(nio.PROJECT, "data", "gcov")
KIT_DIR = os.path.join(nio.PROJECT, "research", "checks", CASE)
CACHE = os.path.join(nio.PROJECT, "research", "cache", "modis_ornl")
APPEEARS_HLS = os.path.join(nio.PROJECT, "research", "AppEEARS", "AlAin_HLS_2026")
ASSET_DIR = os.path.join(nio.REPO, "assets", "cases", CASE)
NUMBERS = os.path.join(nio.REPO, "cases", f"{CASE}.numbers.json")
MYSTERY = os.path.join(nio.REPO, "cases", f"{CASE}.json")
FILE_PATTERN = "_056_A_014_4005_"
POINTS = [  # from the 28 Oct 2026 AppEEARS request log (handover archive)
    {"id": "pivot_dark", "name": "Pivot A", "lat": 24.49083455, "lon": 55.58140118, "kind": "pivot"},
    {"id": "pivot_dark2", "name": "Pivot B", "lat": 24.49705499, "lon": 55.57581644, "kind": "pivot"},
    {"id": "pivot_brown", "name": "Pivot C", "lat": 24.47625597, "lon": 55.52696285, "kind": "pivot"},
    {"id": "pivot_old", "name": "Pivot D", "lat": 24.48999604, "lon": 55.52484753, "kind": "pivot"},
    {"id": "desert", "name": "Desert control", "lat": 24.46468191, "lon": 55.52715393, "kind": "control"},
]

METHOD = {
    "declared": "2026-11-14T05:18+04:00, before any pivot was classified",
    "inputs": "NISAR L2 GCOV, track 056, ascending, frame 014, mode 4005 (10 m): finished passes from 18 Jun to 28 Oct 2026",
    "window": ["2026-06-18", "2026-10-28"],
    "layers": ["HHHH", "HVHV", "mask"],
    "valid_pixel": "mask 1-254, HH > 0, HV > 0",
    "interference_check": "whole frame sampled on a 40x40 grid of 32x32-pixel windows; a pass is flagged if |Al Ain box median change - frame median change| >= 1.5 dB in HH or HV vs 18 Jun; a flagged pass is excluded and the reason shown",
    "interference_limit_db": 1.5,
    "pivots": "HLS-NDVI pivot finding is pending (AppEEARS files not downloaded), so the four logged pivots and the desert control from the 28 Oct AppEEARS request are used",
    "points": [{k: p[k] for k in ("id", "lat", "lon", "kind")} for p in POINTS],
    "disk_radius_m": 300,
    "pivot_value": "mean linear HV (and HH) of 10 m pixels within 300 m of the centre (circles are ~800 m across), in dB",
    "relative_hv": "rHV = HV(pivot) - HV(desert control), same pass",
    "crop_present_db": 3.0,
    "classes": {
        "Active": "crop present (rHV >= 3 dB) on the latest usable pass",
        "Newly cleared": "present on the first pass, absent on the latest, and rHV fell by >= 3 dB",
        "Fallow": "otherwise absent on the latest pass",
    },
    "history": "MODIS MOD13Q1 16-day NDVI from the NASA ORNL DAAC MODIS web service (public, no login; same product as the AppEEARS order), centre pixel of each point, 18 Feb 2000 -> latest; active year = yearly max NDVI >= 0.30; 'quiet for years' = no active year in 2024-2026 after >= 3 earlier active years; 'quiet this summer only' = 2026 Jun-Oct max < 0.30 with an active year in 2023-2025. History only, not the check (250 m pixels).",
    "ndvi_active": 0.30,
    "check": "PENDING until the AppEEARS HLS files arrive: HLS NDVI, Fmask cloud-masked; Active if median NDVI within +/-16 days of the latest pass >= 0.30; Newly cleared if >= 0.30 within +/-16 days of the first pass and < 0.30 at the latest; Fallow otherwise",
    "badge_rule": "Strong if >= 75% of pivots agree with the HLS class; Moderate 50-74%; Weak otherwise. Until the check exists: 'Unchecked (radar only)'",
}


def db(a):
    return nio.power_to_db(a)


def find_passes():
    out = []
    for path in nio.finished_h5(DATA_DIR, FILE_PATTERN):
        with h5py.File(path, "r") as f:
            ident = f["/science/LSAR/identification"]
            start = ident["zeroDopplerStartTime"][()].decode()
            out.append({"file": os.path.basename(path), "path": path, "date": start[:10], "start": start,
                        "direction": ident["orbitPassDirection"][()].decode(), "track": int(ident["trackNumber"][()]),
                        "frame": int(ident["frameNumber"][()]), "product_version": ident["productVersion"][()].decode(),
                        "processing": next((x for x in os.path.basename(path).split("_") if x.startswith("P0")), "?")})
    w0, w1 = METHOD["window"]
    out = [p for p in out if w0 <= p["date"] <= w1]
    for p in out:
        if not p["direction"].lower().startswith("a"):
            raise SystemExit(f"{p['file']} is not ascending - refusing to mix directions (trap 7)")
    return sorted(out, key=lambda p: p["date"])


def read_box(p, window=None):
    with h5py.File(p["path"], "r") as f:
        g = f[GRID]
        proj = nio.projection_params(g["projection"])
        x, y = g["xCoordinates"], g["yCoordinates"]
        (r0, r1, c0, c1), _ = nio.box_window(nio.case_box(CASE), x, y, proj)
        if window and window != (r0, r1, c0, c1):
            raise SystemExit("files are on different grids - refusing to compare them")
        hh = g["HHHH"][r0:r1, c0:c1].astype(np.float32)
        hv = g["HVHV"][r0:r1, c0:c1].astype(np.float32)
        m = g["mask"][r0:r1, c0:c1]
        xs, ys = x[c0:c1].astype(np.float64), y[r0:r1].astype(np.float64)
    bad = (m == 0) | (m == 255) | ~(hh > 0) | ~(hv > 0)
    hh[bad] = np.nan
    hv[bad] = np.nan
    return {"hh": hh, "hv": hv, "window": (r0, r1, c0, c1), "proj": proj, "x": xs, "y": ys, "valid_share": float(np.mean(~bad))}


def disk(b, lat, lon, radius):
    X, Y = nio.lonlat_to_utm(lon, lat, b["proj"])
    c = int(np.argmin(np.abs(b["x"] - X)))
    r = int(np.argmin(np.abs(b["y"] - Y)))
    n = int(radius / 10) + 1
    rr, cc = np.mgrid[r - n:r + n + 1, c - n:c + n + 1]
    inside = ((rr - r) ** 2 + (cc - c) ** 2) * 100 <= radius ** 2
    rr, cc = rr[inside], cc[inside]
    ok = (rr >= 0) & (rr < b["hh"].shape[0]) & (cc >= 0) & (cc < b["hh"].shape[1])
    return rr[ok], cc[ok], (r, c)


def modis_history(pt):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{pt['id']}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    base = "https://modis.ornl.gov/rst/api/v1/MOD13Q1"
    get = lambda u: json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "OmniSAR-processing/1.0"}), timeout=90).read())
    dates = [d["modis_date"] for d in get(f"{base}/dates?latitude={pt['lat']}&longitude={pt['lon']}")["dates"]]
    from concurrent.futures import ThreadPoolExecutor

    def fetch(chunk):          # the service returns at most 10 composites per request
        url = (f"{base}/subset?latitude={pt['lat']}&longitude={pt['lon']}&band=250m_16_days_NDVI"
               f"&startDate={chunk[0]}&endDate={chunk[-1]}&kmAboveBelow=0&kmLeftRight=0")
        for _ in range(4):
            try:
                return get(url)
            except Exception:
                time.sleep(3)
        raise SystemExit(f"MODIS history download failed for {pt['id']}")

    rows = []
    with ThreadPoolExecutor(max_workers=8) as pool:      # many small requests at once: latency, not data, is the slow part
        results = list(pool.map(fetch, [dates[i:i + 10] for i in range(0, len(dates), 10)]))
    for js in results:
        scale = float(js.get("scale", 0.0001))
        for s in js["subset"]:
            v = s["data"][0]
            rows.append({"date": s["calendar_date"], "ndvi": None if v <= -3000 else round(v * scale, 4)})
    rows.sort(key=lambda r: r["date"])
    out = {"source": "NASA ORNL DAAC MODIS web service, MOD13Q1 250m_16_days_NDVI", "url_base": base, "point": pt,
           "downloaded": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "series": rows}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    return out


def history_summary(series):
    years = {}
    summer26 = []
    for r in series:
        if r["ndvi"] is None:
            continue
        y = int(r["date"][:4])
        years[y] = max(years.get(y, -1), r["ndvi"])
        if r["date"][:4] == "2026" and "06" <= r["date"][5:7] <= "10":
            summer26.append(r["ndvi"])
    lim = METHOD["ndvi_active"]
    active = sorted(y for y, v in years.items() if v >= lim)
    s26 = max(summer26) if summer26 else None
    recent = [y for y in active if y >= 2024]
    if not recent and len([y for y in active if y < 2024]) >= 3:
        label = "quiet for years"
    elif s26 is not None and s26 < lim and any(2023 <= y <= 2025 for y in active):
        label = "quiet this summer only"
    elif s26 is not None and s26 >= lim:
        label = "green this summer"
    elif not active:
        label = "never green in the record"
    else:
        label = "mixed"
    return {"yearly_max": [{"date": f"{y}-07-01", "year": y, "ndvi_max": round(v, 3)} for y, v in sorted(years.items())],
            "active_years": active, "summer_2026_max": s26, "label": label,
            "last_active_year": active[-1] if active else None}


def save(img, name):
    img.save(os.path.join(ASSET_DIR, name), optimize=True)
    return f"assets/cases/{CASE}/{name}"


def history_chart(hist):
    W, H, L, B, T = 640, 260, 40, 30, 34
    im = Image.new("RGB", (W, H), (20, 22, 28))
    d = ImageDraw.Draw(im)
    cols = {"pivot_dark": (122, 209, 81), "pivot_dark2": (32, 164, 160), "pivot_brown": (253, 231, 37), "pivot_old": (242, 142, 43), "desert": (170, 170, 170)}
    px = lambda yr: L + (yr - 2000) / 26.5 * (W - L - 10)
    py = lambda v: H - B - (v / 0.9) * (H - B - T)
    d.line([L, H - B, W - 10, H - B], fill=(150, 150, 150))
    d.line([L, py(0.3), W - 10, py(0.3)], fill=(90, 90, 90))
    d.text((W - 120, py(0.3) - 14), "0.30 = green", fill=(150, 150, 150), font=font(11))
    for yr in (2000, 2005, 2010, 2015, 2020, 2025):
        d.text((px(yr) - 12, H - B + 6), str(yr), fill=(170, 170, 170), font=font(11))
    d.text((4, py(0.9) - 4), "0.9", fill=(170, 170, 170), font=font(11))
    d.text((4, py(0) - 8), "0", fill=(170, 170, 170), font=font(11))
    lx = L + 4
    for pid, h in hist.items():
        pts = [(px(r["year"] + 0.5), py(max(0, r["ndvi_max"]))) for r in h["yearly_max"]]
        if len(pts) > 1:
            d.line(pts, fill=cols[pid], width=2)
        name = next(p["name"] for p in POINTS if p["id"] == pid)
        d.text((lx, 18), name, fill=cols[pid], font=font(11))
        lx += 105
    d.text((L, 2), "Greenest NDVI each year, MODIS 250 m (NASA ORNL DAAC), 2000-2026", fill=(225, 225, 225), font=font(12))
    return im


def main():
    t0 = time.time()
    passes = find_passes()
    log(f"finished passes: {[p['date'] for p in passes]}")
    if len(passes) < 2:
        raise SystemExit("Need at least two finished passes - Al Ain stays 'evidence pending'.")
    os.makedirs(ASSET_DIR, exist_ok=True)
    os.makedirs(KIT_DIR, exist_ok=True)
    boxes, window = {}, None
    for p in passes:
        boxes[p["date"]] = read_box(p, window)
        window = boxes[p["date"]]["window"]
        log(f"  read {p['date']}  valid {boxes[p['date']]['valid_share']:.1%}")
    ref = passes[0]
    ref_s, _ = frame_sample(ref)
    inter, excluded = [], []
    for p in passes[1:]:
        s, _ = frame_sample(p)
        dd = s - ref_s
        row = {"pass": p["date"], "compared_with": ref["date"]}
        for k, ch in enumerate(("HH", "HV")):
            fm = float(np.nanmedian(dd[:, :, k]))
            bm = float(np.nanmedian(db(boxes[p["date"]][ch.lower()])) - np.nanmedian(db(boxes[ref["date"]][ch.lower()])))
            row[ch] = {"box_median_change_db": round(bm, 2), "frame_median_change_db": round(fm, 2),
                       "anomaly_over_box": bool(abs(bm - fm) >= METHOD["interference_limit_db"])}
        row["anomaly_over_box"] = row["HH"]["anomaly_over_box"] or row["HV"]["anomaly_over_box"]
        inter.append(row)
        log("  interference", json.dumps(row))
        if row["anomaly_over_box"]:
            excluded.append({"pass": p["date"], "reason": f"interference check flagged it over Al Ain (box HH {row['HH']['box_median_change_db']:+.1f} vs frame {row['HH']['frame_median_change_db']:+.1f} dB; HV {row['HV']['box_median_change_db']:+.1f} vs {row['HV']['frame_median_change_db']:+.1f} dB)"})
    used = [p for p in passes if not any(x["pass"] == p["date"] for x in excluded)]
    if len(used) < 2:
        raise SystemExit("Fewer than two usable passes after the interference check - Al Ain stays 'evidence pending'.")
    first, last = used[0]["date"], used[-1]["date"]

    # pivot values
    vals = {}
    for pt in POINTS:
        vals[pt["id"]] = {}
        for p in used:
            b = boxes[p["date"]]
            rr, cc, _ = disk(b, pt["lat"], pt["lon"], METHOD["disk_radius_m"])
            vals[pt["id"]][p["date"]] = {"hv_db": round(float(db(np.nanmean(b["hv"][rr, cc]))), 2),
                                         "hh_db": round(float(db(np.nanmean(b["hh"][rr, cc]))), 2), "pixels": int(np.isfinite(b["hv"][rr, cc]).sum())}
    lim = METHOD["crop_present_db"]
    pivots = []
    for pt in POINTS:
        if pt["kind"] != "pivot":
            continue
        series = [{"date": p["date"], "hv_db": vals[pt["id"]][p["date"]]["hv_db"],
                   "rhv_db": round(vals[pt["id"]][p["date"]]["hv_db"] - vals["desert"][p["date"]]["hv_db"], 2)} for p in used]
        r_first, r_last = series[0]["rhv_db"], series[-1]["rhv_db"]
        if r_last >= lim:
            cls = "Active"
        elif r_first >= lim and (r_first - r_last) >= lim:
            cls = "Newly cleared"
        else:
            cls = "Fallow"
        pivots.append({"id": pt["id"], "name": pt["name"], "lat": pt["lat"], "lon": pt["lon"], "class": cls, "series": series})
        log(f"  {pt['name']}: {cls}  rHV {r_first:+.1f} -> {r_last:+.1f} dB")

    # history
    log("MODIS history (NASA ORNL DAAC)...")
    hist, hist_meta, near = {}, {}, {}
    for pt in POINTS:
        h = modis_history(pt)
        near[pt["id"]] = {}
        for p in used:      # MODIS composite nearest each radar pass (within 16 days): context, not the check
            t = dt.date.fromisoformat(p["date"])
            cand = [r for r in h["series"] if r["ndvi"] is not None and abs((dt.date.fromisoformat(r["date"]) - t).days) <= 16]
            best = min(cand, key=lambda r: abs((dt.date.fromisoformat(r["date"]) - t).days)) if cand else None
            near[pt["id"]][p["date"]] = best
        hist[pt["id"]] = history_summary(h["series"])
        hist_meta[pt["id"]] = {"composites": len(h["series"]), "first": h["series"][0]["date"], "last": h["series"][-1]["date"], "downloaded": h["downloaded"]}
        log(f"  {pt['id']}: {hist[pt['id']]['label']}  active years {hist[pt['id']]['active_years'][:3]}...{hist[pt['id']]['active_years'][-3:]}  summer 2026 max {hist[pt['id']]['summer_2026_max']}")
    for pv in pivots:
        pv["history"] = hist[pv["id"]]["label"]
        pv["last_active_year"] = hist[pv["id"]]["last_active_year"]
        pv["summer_2026_ndvi_max"] = hist[pv["id"]]["summer_2026_max"]
        pv["modis_near_passes"] = near[pv["id"]]
        nl = near[pv["id"]].get(last)
        pv["modis_near_latest"] = nl
        pv["modis_disagrees"] = bool(nl and ((nl["ndvi"] >= METHOD["ndvi_active"]) != (pv["class"] == "Active")))

    hls_files = os.listdir(APPEEARS_HLS) if os.path.isdir(APPEEARS_HLS) else []
    check_status = "pending" if not hls_files else "files present but reader not written yet"
    badge = "Unchecked (radar only)"

    # ---------- images ----------
    made = {}
    bf, bl = boxes[first], boxes[last]
    crops = []
    for pv in pivots:
        _, _, (r, c) = disk(bf, pv["lat"], pv["lon"], 300)
        half = 100
        for dte, b in ((first, bf), (last, bl)):
            sub = db(b["hv"][max(r - half, 0):r + half, max(c - half, 0):c + half])
            im = Image.fromarray(grey(sub, -30, -10)).resize((200, 200), Image.BILINEAR)
            ImageDraw.Draw(im).ellipse([100 - 60, 100 - 60, 100 + 60, 100 + 60], outline=(255, 90, 60), width=2)
            crops.append((im, f"{pv['name']} {fmt_date(dte)}"))
    rows_img = [side_by_side(crops[i:i + 4]) for i in range(0, len(crops), 4)]
    W = max(r.width for r in rows_img)
    canvas = Image.new("RGB", (W, sum(r.height for r in rows_img)), (20, 22, 28))
    yy = 0
    for r in rows_img:
        canvas.paste(r, (0, yy))
        yy += r.height
    made["ev-pivots"] = save(caption_strip(canvas, ["NISAR HV (crop echo), 2 km squares, -30 to -10 dB; red circle = 300 m measuring disk",
                                                    "; ".join(f"{p['name']}: {p['class']}" for p in pivots)]), "ev-pivots.png")
    made["ev-history"] = save(history_chart(hist), "ev-history.png")
    pa = pivots[0]
    _, _, (r, c) = disk(bf, pa["lat"], pa["lon"], 300)
    sub = db(bf["hv"][r - 100:r + 100, c - 100:c + 100])
    fine = Image.fromarray(grey(sub, -30, -10)).resize((280, 280), Image.NEAREST)
    lin = bf["hv"][r - 112:r + 112, c - 112:c + 112]
    coarse = db(np.nanmean(lin.reshape(8, 28, 8, 28), axis=(1, 3)))
    coarse_img = Image.fromarray(grey(coarse, -30, -10)).resize((280, 280), Image.NEAREST)
    made["ev-tile"] = save(side_by_side([(fine, "NISAR science file, 10 m pixels"), (coarse_img, "Same place at 280 m (map-tile zoom 9)")],
                                        f"{pa['name']}, {fmt_date(first)}: an 800 m field is about 3 map-tile pixels wide"), "ev-tile.png")
    hh30 = db(nio.multilook(bf["hh"].astype(np.float64), 3))
    hv30 = db(nio.multilook(bf["hv"].astype(np.float64), 3))
    lake_rule = (hh30 <= -16) & (hv30 <= -22)
    lake_km2 = float(lake_rule.sum() * 0.0009)
    made["ev-dark"] = save(caption_strip(to_img(mask_rgb(grey(hh30, -25, 0), [(lake_rule, (40, 110, 220, 230))])),
                                         [f"Blue: desert pixels a lake rule (HH <= -16 dB and HV <= -22 dB) would call 'water': {lake_km2:.1f} km2.",
                                          "There is almost no open water here: it is smooth sand. Dark is not the same as wet."]), "ev-dark.png")
    made["tg-hh"] = save(caption_strip(to_img(grey(db(nio.multilook(bl["hh"].astype(np.float64), 3)), -25, 0)), [f"HH (direct echo), {fmt_date(last)}"]), "tg-hh.png")
    made["tg-hv"] = save(caption_strip(to_img(grey(db(nio.multilook(bl["hv"].astype(np.float64), 3)), -30, -10)), [f"HV (crop echo), {fmt_date(last)}"]), "tg-hv.png")
    made["tg-10m"] = save(caption_strip(fine, ["10 m science-file pixels"]), "tg-10m.png")
    made["tg-280m"] = save(caption_strip(coarse_img, ["280 m map-tile pixels"]), "tg-280m.png")

    # terrain grid
    hv_layers = {p["date"]: db(nio.multilook(boxes[p["date"]]["hv"].astype(np.float64), 3)) for p in used}
    gx = boxes[first]["x"][: (len(boxes[first]["x"]) // 3) * 3].reshape(-1, 3).mean(axis=1)
    gy = boxes[first]["y"][: (len(boxes[first]["y"]) // 3) * 3].reshape(-1, 3).mean(axis=1)
    rows_n, cols_n = hv_layers[first].shape
    m = max(1, math.ceil(math.sqrt(rows_n * cols_n / 60000)))
    R, C = rows_n // m, cols_n // m
    mmdb = lambda a: 10 * np.log10(np.nanmean((10 ** (a / 10))[:R * m, :C * m].reshape(R, m, C, m), axis=(1, 3)))
    q = lambda a: [None if not np.isfinite(v) else int(round(v * 10)) for v in a.ravel()]
    bx = gx[:C * m].reshape(C, m).mean(axis=1)
    by = gy[:R * m].reshape(R, m).mean(axis=1)
    proj = boxes[first]["proj"]
    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (C * m - 1, 0), "sw": (0, R * m - 1), "se": (C * m - 1, R * m - 1)}.items():
        lon, lat = nio.utm_to_lonlat(gx[cx], gy[cy], proj)
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]
    layers = [{"id": f"hv-{d}", "label": f"HV {fmt_date(d)} 2026", "date": d, "kind": "sequential", "unit": "dB", "scale": [-30, -10],
               "what": "NISAR HV backscatter (crops and plants raise it)", "source": f"NISAR L2 GCOV, track 056 ascending, {d}", "values": q(mmdb(v))}
              for d, v in hv_layers.items()]
    layers.append({"id": "change", "label": f"HV change {fmt_date(first)} → {fmt_date(last)}", "date": f"{first} → {last}", "kind": "diverging",
                   "unit": "dB", "scale": [-6, 6], "what": "HV change (red = more crop echo, blue = less)", "source": "NISAR L2 GCOV, track 056 ascending",
                   "lowWord": "less", "highWord": "more", "values": q(mmdb(hv_layers[last]) - mmdb(hv_layers[first]))})
    elev = terrain.grid_heights(bx, by, proj)
    with open(os.path.join(ASSET_DIR, "grid.json"), "w", encoding="utf-8") as f:
        json.dump(nio.clean_json({"about": "Blocky case terrain grid for Al Ain. Values x10 integers; row 0 = north. Written by tools/process_al_ain.py.",
                                  "case": CASE, "rows": R, "cols": C, "merge": m, "pixel_m": 30.0, "block_m": 30.0 * m,
                                  "block_text": f"one block = {m}×{m} filtered pixels of 30 m = {3 * m}×{3 * m} NISAR 10 m pixels ≈ {30 * m} m",
                                  "corners_latlon": corners, "layers": layers, "default_layer": f"hv-{last}",
                                  "elev_dm": [int(round(v * 10)) for v in elev.ravel()], "height_source": terrain.SOURCE}),
                  f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

    # numbers
    measured = [{"label": f"{p['name']}", "value": p["class"], "unit": "",
                 "note": f"Crop echo vs desert: {p['series'][0]['rhv_db']:+.1f} dB on {fmt_date(first)} → {p['series'][-1]['rhv_db']:+.1f} dB on {fmt_date(last)} (crop present if ≥ +3 dB). "
                         f"26-year MODIS record: {p['history']}" + (f" (last green year {p['last_active_year']})" if p["last_active_year"] else "") + "."} for p in pivots]
    dis = [p for p in pivots if p["modis_disagrees"]]
    if dis:
        measured.append({"label": "Warning: MODIS disagrees", "value": f"{len(dis)} of {len(pivots)} pivots", "unit": "",
                         "note": "; ".join(f"{p['name']}: radar says {p['class'].lower()}, but MODIS NDVI was {p['modis_near_latest']['ndvi']:.2f} on {fmt_date(p['modis_near_latest']['date'])}"
                                           for p in dis)
                                 + ". MODIS is our history source, not the formal check (its 250 m pixels are a third of a circle), but it suggests our 3 dB radar rule misses some green crops. "
                                   "We don't change a rule after seeing results; the HLS check will decide."})
    measured.append({"label": "Passes used", "value": f"{len(used)} of {len(passes)}", "unit": "",
                     "note": ", ".join(fmt_date(p["date"]) for p in used) + (". Left out: " + "; ".join(f"{fmt_date(x['pass'])} ({x['reason']})" for x in excluded) if excluded else ". The interference check found no patch over Al Ain on any pass.")})
    numbers = {
        "case": CASE, "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured,
        "check": {"label": "Independent check", "text": "Pending: the NASA HLS photo-based NDVI check needs the AppEEARS files, which haven't been downloaded yet. Until then the classes are radar only."},
        "badge": badge, "badge_reason": "HLS NDVI check pending (rule: ≥ 75% of pivots agree = Strong, 50–74% = Moderate, below = Weak)",
        "sources": [p["file"] for p in used],
        "method": METHOD,
        "results": {"pivots": pivots, "desert": vals["desert"], "point_values": vals, "interference": inter, "excluded_passes": excluded,
                    "history": hist, "history_meta": hist_meta, "check_status": check_status, "appeears_hls_files": len(hls_files),
                    "lake_rule_desert_km2": round(lake_km2, 2),
                    "history_series": {pid: h["yearly_max"] for pid, h in hist.items()}, "modis_near_passes": near},
        "files": {"grid": f"assets/cases/{CASE}/grid.json"},
        "provenance": {
            "nasa_files": [{k: p[k] for k in ("file", "date", "start", "direction", "track", "frame", "product_version", "processing")} for p in passes],
            "collection": "NISAR L2 GCOV (ASF DAAC)", "layers": [f"{GRID}/{n}" for n in METHOD["layers"]],
            "box_lonlat": list(nio.case_box(CASE)), "box_rows_cols": list(window), "projection_epsg": proj["epsg"],
            "other_sources": {"history": "MODIS MOD13Q1 NDVI via NASA ORNL DAAC MODIS web service (modis.ornl.gov/rst/api/v1)", "heights": terrain.SOURCE},
            "steps": ["read only the box at 10 m", "mask invalid pixels", "interference check (whole-frame sample)", "300 m disk means (linear) at each point",
                      "rHV vs desert control, classes (method.classes)", "MODIS 26-year history per point", "HLS check (pending)"],
            "script": "tools/process_al_ain.py", "script_version": SCRIPT_VERSION,
            "script_sha256": sha256(os.path.abspath(__file__)), "helpers_sha256": sha256(os.path.join(nio.HERE, "nisar_io.py")),
        },
    }
    with open(NUMBERS, "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(numbers), f, indent=1, ensure_ascii=False, allow_nan=False)
    log(f"wrote {NUMBERS}")

    with open(MYSTERY, encoding="utf-8") as f:
        mys = json.load(f)
    ev = {e["id"]: e for e in mys["evidence"]}
    ev["pivots"].update(src=made["ev-pivots"], pending=False,
                        caption=f"NISAR HV at four farm circles, {fmt_date(first)} vs {fmt_date(last)}: " + "; ".join(f"{p['name']} {p['class'].lower()}" for p in pivots) + ". Classes are radar only until the photo-based NDVI check is done.")
    ev["history"].update(src=made["ev-history"], pending=False,
                         caption="26 years of NASA MODIS greenness: " + "; ".join(f"{p['name']}: {p['history']}" for p in pivots) + ". One quiet summer is not the same as a farm left for years.")
    ev["tile"].update(src=made["ev-tile"], pending=False,
                      caption="An 800 m farm circle at NISAR's 10 m science resolution, and the same place at 280 m, the sharpest NISAR map tiles that work. On the tile, the circle is a blur of about three pixels.")
    ev["dark"].update(src=made["ev-dark"], pending=False,
                      caption=f"A simple 'dark = water' rule would call {lake_km2:.1f} km² of this desert 'water'. It's smooth sand. In a desert, dark alone can't tell sand from water.")
    tg = {t["id"]: t for t in mys["toggles"]}
    tg["channel"]["layers"] = {"off": {"src": made["tg-hh"], "label": "HH"}, "on": {"src": made["tg-hv"], "label": "HV"}}
    tg["pixel"]["layers"] = {"off": {"src": made["tg-10m"], "label": "10 m science file"}, "on": {"src": made["tg-280m"], "label": "280 m map tile"}}
    with open(MYSTERY, "w", encoding="utf-8") as f:
        json.dump(mys, f, indent=2, ensure_ascii=False)
        f.write("\n")
    update_results.update()
    log(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
