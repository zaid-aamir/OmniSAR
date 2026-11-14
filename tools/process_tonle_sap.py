"""
Tonle Sap case: how much forest went underwater that ordinary water maps missed?

Run (from the repo folder):   py tools/process_tonle_sap.py
Re-run whenever another track-083 pass finishes downloading: every finished pass is used.

What it does, in order:
  1. Finds the finished NISAR GCOV files for track 083, ascending, frame 008 (mode 2005). Never .h5.part.
  2. Reads only the Tonle Sap box, filters speckle to ~60 m pixels.
  3. Per pass: open water (HH and HV both very dark) and flooded forest (forest on 19 Jun whose HH
     jumped up from the trunk-water "double bounce"). Rules in METHOD, fixed before any result.
  4. Independent check: NASA OPERA DSWx-S1 water map (Sentinel-1, C-band) from GIBS for the nearest
     date: open-water agreement, and how much of our flooded forest the C-band map calls "not water".
  5. Rain from NASA POWER (regional). Writes cases/tonle-sap.numbers.json (full provenance), images,
     a grid for the case terrain, fills cases/tonle-sap.json, runs update_results.
"""

import datetime as dt
import json
import math
import os
import sys
import time
import warnings

import h5py
import numpy as np
from PIL import Image, ImageDraw

import nisar_io as nio
import terrain
import update_results
from process_jebel_ali import GRID, font, sha256, fmt_date, log
from process_big_sur import caption_strip, side_by_side, fetch_json, grey, to_img, mask_rgb, rain_between, T

warnings.filterwarnings("ignore", category=RuntimeWarning)

SCRIPT_VERSION = "1.0"
CASE = "tonle-sap"
DATA_DIR = os.path.join(nio.PROJECT, "data", "gcov")
KIT_DIR = os.path.join(nio.PROJECT, "research", "checks", CASE)
ASSET_DIR = os.path.join(nio.REPO, "assets", "cases", CASE)
NUMBERS = os.path.join(nio.REPO, "cases", f"{CASE}.numbers.json")
MYSTERY = os.path.join(nio.REPO, "cases", f"{CASE}.json")
PASSES_JSON = os.path.join(nio.REPO, "cases", "passes.json")
FILE_PATTERN = "_083_A_008_2005_"
CENTRE = (12.80, 104.20)
DSWX = "OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1"
DSWX_COLOURS = {(255, 255, 255): 0, (0, 0, 255): 1, (0, 255, 0): 3, (200, 200, 200): 250, (128, 128, 128): 251}

METHOD = {
    "declared": "2026-11-14T05:12+04:00, before any Tonle Sap radar file was read",
    "inputs": "NISAR L2 GCOV, track 083, ascending, frame 008, mode 2005, every finished pass",
    "layers": ["HHHH", "HVHV", "mask"],
    "valid_pixel": "mask 1-254, HH > 0, HV > 0",
    "speckle_filter": "k x k block mean in linear power, k = round(60 m / native pixel spacing) -> ~60 m pixels",
    "target_pixel_m": 60,
    "open_water": "HH <= -16 dB AND HV <= -22 dB",
    "water_hh_db": -16.0, "water_hv_db": -22.0,
    "forest_at_start": "first pass (19 Jun): HV >= -16 dB and not open water (radar-only, declared)",
    "forest_hv_db": -16.0,
    "flooded_forest": "forest-at-start pixel with HH >= -5 dB on that pass (trunk-water double bounce)",
    "flooded_hh_db": -5.0,
    "check": "NASA OPERA DSWx-S1 (GIBS WMS layer OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1), nearest date within +/-6 days with >= 50% of the box valid (tie -> earlier), sampled at our pixel centres",
    "dswx_window_days": 6,
    "dswx_colour_table": "GIBS colormap OPERA_Dynamic_Surface_Water_Extent_S1.xml v1.3: 255,255,255 = 0 not water; 0,0,255 = 1 open water; 0,255,0 = 3 inundated vegetation; 200,200,200 = 250 HAND masked; 128,128,128 = 251 layover/shadow masked; transparent = no data",
    "agreement": "% of pixels (both valid, DSWx class 0/1/3) where NISAR open water and DSWx class 1 give the same yes/no; IoU and both one-way shares also reported",
    "missed": "NISAR flooded forest where DSWx-S1 says 0 (not water)",
    "badge_rule": "Open water: Strong if agreement >= 80% on >= 2 dates, Moderate if >= 80% on 1 date, Weak otherwise. Case badge capped at Moderate: flooded forest is L-band only by definition (no independent check)",
    "rain": "NASA POWER daily PRECTOTCORR at the box centre (12.80 N, 104.20 E), 1 May -> today; regional, not per field",
    "power_label": "NASA POWER (MERRA-2), regional",
}

WATER_RGBA = (40, 110, 220, 235)
FLOOD_RGBA = (102, 252, 160, 235)
FOREST_RGBA = (40, 90, 50, 120)


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
        spacing = abs(float(g["xCoordinateSpacing"][()]))
        k = max(1, round(METHOD["target_pixel_m"] / spacing))
        hh = g["HHHH"][r0:r1, c0:c1].astype(np.float64)
        hv = g["HVHV"][r0:r1, c0:c1].astype(np.float64)
        m = g["mask"][r0:r1, c0:c1]
        xs, ys = x[c0:c1].astype(np.float64), y[r0:r1].astype(np.float64)
        looks = float(np.nanmedian(g["numberOfLooks"][r0:r1:16, c0:c1:16]))
    bad = (m == 0) | (m == 255) | ~(hh > 0) | ~(hv > 0)
    hh[bad] = np.nan
    hv[bad] = np.nan
    H, V = nio.multilook(hh, k), nio.multilook(hv, k)
    nr, nc = H.shape
    return {"hh": db(H), "hv": db(V), "window": (r0, r1, c0, c1), "proj": proj, "k": k, "spacing": spacing,
            "x": xs[:nc * k].reshape(nc, k).mean(axis=1), "y": ys[:nr * k].reshape(nr, k).mean(axis=1),
            "looks": looks, "valid_share": float(np.mean(~bad))}


def dswx_for(date, grid, shape):
    """Nearest DSWx-S1 picture (+/- 6 days, >= 50% valid), decoded to classes at our pixel centres."""
    X, Y = np.meshgrid(grid["x"], grid["y"])
    lon, lat = nio.utm_to_lonlat(X, Y, grid["proj"])
    w, s, e, n = float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())
    W, H = 900, round(900 * (n - s) / (e - w))
    t = dt.date.fromisoformat(date)
    tried = []
    for off in sorted(range(-METHOD["dswx_window_days"], METHOD["dswx_window_days"] + 1), key=lambda o: (abs(o), o)):
        day = (t + dt.timedelta(days=off)).isoformat()
        try:
            img, url = nio.gibs_wms(DSWX, day, w, s, e, n, W, H)
        except Exception as ex:
            tried.append({"date": day, "error": str(ex)[:80]})
            continue
        a = np.asarray(img)
        col = np.clip(((lon - w) / (e - w) * W).astype(int), 0, W - 1)
        row = np.clip(((n - lat) / (n - s) * H).astype(int), 0, H - 1)
        px = a[row, col]
        cls = np.full(shape, 255, np.uint8)
        alpha = px[..., 3] > 0
        unknown = 0
        for rgb, c in DSWX_COLOURS.items():
            hit = alpha & (px[..., 0] == rgb[0]) & (px[..., 1] == rgb[1]) & (px[..., 2] == rgb[2])
            cls[hit] = c
        unknown = int((alpha & (cls == 255)).sum())
        valid = float(np.isin(cls, (0, 1, 3)).mean())
        tried.append({"date": day, "valid_share": round(valid, 3), "unknown_colour_px": unknown})
        if valid >= 0.5:
            flat = Image.new("RGB", img.size, (0, 0, 0))
            flat.paste(img, mask=img.split()[3])
            return {"date": day, "url": url, "cls": cls, "image": flat, "tried": tried, "unknown_colour_px": unknown}
    return {"date": None, "tried": tried}


def class_map(hh, hv, forest0):
    water = (hh <= METHOD["water_hh_db"]) & (hv <= METHOD["water_hv_db"])
    flooded = forest0 & (hh >= METHOD["flooded_hh_db"]) & ~water
    return water, flooded


def save(img, name):
    img.save(os.path.join(ASSET_DIR, name), optimize=True)
    return f"assets/cases/{CASE}/{name}"


def gap_chart():
    """NISAR passes over this box from NASA's catalogue, with the 27 Jul - 10 Aug data gap (trap 14)."""
    with open(PASSES_JSON, encoding="utf-8") as f:
        pj = json.load(f)
    dates = sorted({p["date"] for p in pj["cases"][CASE]["passes"]})
    W, Hh, L = 640, 120, 20
    im = Image.new("RGB", (W, Hh), (20, 22, 28))
    d = ImageDraw.Draw(im)
    d0, d1 = dt.date(2026, 6, 1), dt.date(2026, 11, 10)
    span = (d1 - d0).days
    px = lambda iso: L + (dt.date.fromisoformat(iso) - d0).days / span * (W - 2 * L)
    d.rectangle([px("2026-07-27"), 30, px("2026-08-10"), 80], fill=(80, 60, 30))
    d.text((px("2026-07-27"), 84), "NASA data gap", fill=(230, 180, 90), font=font(11))
    d.line([L, 55, W - L, 55], fill=(120, 120, 120))
    for iso in dates:
        d.rectangle([px(iso) - 2, 40, px(iso) + 2, 70], fill=(102, 252, 241))
    for m in range(6, 12):
        iso = f"2026-{m:02d}-01"
        d.text((px(iso), 100), dt.date.fromisoformat(iso).strftime("%b"), fill=(170, 170, 170), font=font(11))
    d.text((L, 8), f"NISAR passes over Tonle Sap, 1 Jun - 10 Nov 2026 ({len(dates)} days), NASA CMR catalogue", fill=(225, 225, 225), font=font(12))
    return im, dates


def main():
    t0 = time.time()
    passes = find_passes()
    log(f"finished passes: {[p['date'] for p in passes]}")
    if not passes:
        raise SystemExit("No finished track-083 GCOV file yet - Tonle Sap stays 'evidence pending'.")
    os.makedirs(ASSET_DIR, exist_ok=True)
    os.makedirs(KIT_DIR, exist_ok=True)

    boxes, window = {}, None
    for p in passes:
        boxes[p["date"]] = read_box(p, window)
        window = boxes[p["date"]]["window"]
        b = boxes[p["date"]]
        log(f"  read {p['date']}  valid {b['valid_share']:.1%}  spacing {b['spacing']} m  k {b['k']}  ({time.time() - t0:.0f} s)")
    first = passes[0]["date"]
    grid = boxes[first]
    shape = grid["hh"].shape
    pix_m = grid["spacing"] * grid["k"]
    px_km2 = pix_m * pix_m / 1e6
    hh0, hv0 = grid["hh"], grid["hv"]
    water0 = (hh0 <= METHOD["water_hh_db"]) & (hv0 <= METHOD["water_hv_db"])
    forest0 = (hv0 >= METHOD["forest_hv_db"]) & ~water0 & np.isfinite(hh0)
    log(f"  forest at start {forest0.sum() * px_km2:.1f} km2")

    rows, per = [], {}
    for p in passes:
        b = boxes[p["date"]]
        water, flooded = class_map(b["hh"], b["hv"], forest0)
        dsw = dswx_for(p["date"], grid, shape)
        row = {"date": p["date"], "open_water_km2": round(float(water.sum() * px_km2), 1),
               "flooded_forest_km2": round(float(flooded.sum() * px_km2), 1),
               "valid_km2": round(float(np.isfinite(b["hh"]).sum() * px_km2), 1),
               "hh_median_db": round(float(np.nanmedian(b["hh"])), 2), "hv_median_db": round(float(np.nanmedian(b["hv"])), 2),
               "dswx_date": dsw["date"]}
        if dsw["date"]:
            c = dsw["cls"]
            ok = np.isin(c, (0, 1, 3)) & np.isfinite(b["hh"])
            dw = c == 1
            agree = float(((water == dw) & ok).sum() / max(ok.sum(), 1))
            inter = (water & dw & ok).sum()
            union = ((water | dw) & ok).sum()
            row.update({
                "agreement": round(agree, 3), "iou": round(float(inter / max(union, 1)), 3),
                "dswx_water_we_call_water": round(float(inter / max((dw & ok).sum(), 1)), 3),
                "our_water_dswx_calls_water": round(float(inter / max((water & ok).sum(), 1)), 3),
                "dswx_open_water_km2": round(float((dw & ok).sum() * px_km2), 1),
                "dswx_inundated_veg_km2": round(float(((c == 3) & ok).sum() * px_km2), 1),
                "flooded_forest_missed_km2": round(float((flooded & (c == 0)).sum() * px_km2), 1),
                "flooded_forest_dswx_inundated_veg_km2": round(float((flooded & (c == 3)).sum() * px_km2), 1),
                "flooded_forest_dswx_open_water_km2": round(float((flooded & (c == 1)).sum() * px_km2), 1),
                "dswx_unknown_colour_px": dsw["unknown_colour_px"],
            })
        row["dswx_tried"] = dsw["tried"]
        rows.append(row)
        per[p["date"]] = {"water": water, "flooded": flooded, "dswx": dsw}
        log("  ", json.dumps({k: v for k, v in row.items() if k != "dswx_tried"}))

    checked = [r for r in rows if r.get("agreement") is not None]
    good = [r for r in checked if r["agreement"] >= 0.80]
    ow_badge = "Strong" if len(good) >= 2 else "Moderate" if len(good) == 1 else "Weak"
    badge = "Moderate" if ow_badge in ("Strong", "Moderate") else "Weak"
    if not checked:
        badge_reason = "no DSWx-S1 picture within ±6 days of any finished NISAR pass yet, so open water has no independent check; flooded forest is L-band only"
    else:
        badge_reason = (f"open water: {len(good)} of {len(checked)} checked date(s) agree ≥ 80% with DSWx-S1 → {ow_badge}; "
                        "case capped at Moderate because flooded forest is L-band only")

    # rain
    end = dt.date.today().strftime("%Y%m%d")
    url = ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG"
           f"&longitude={CENTRE[1]}&latitude={CENTRE[0]}&start=20260501&end={end}&format=JSON")
    pdata, ppath, _ = fetch_json(url, f"power_tonlesap_{end}.json")
    pp = pdata["properties"]["parameter"]["PRECTOTCORR"]
    days = [{"date": f"{k[:4]}-{k[4:6]}-{k[6:]}", "precip_mm": None if v is None or v < -900 else round(float(v), 2)} for k, v in sorted(pp.items())]
    monthly = {}
    for d_ in days:
        if d_["precip_mm"] is not None:
            monthly.setdefault(d_["date"][:7], 0.0)
            monthly[d_["date"][:7]] += d_["precip_mm"]
    monthly_list = [{"date": m + "-15", "month": m, "rain_mm": round(v, 1)} for m, v in sorted(monthly.items())]
    rain_total = rain_between(days, "2026-05-01", dt.date.today().isoformat())
    log(f"  rain since 1 May {rain_total}")

    # ---------- images ----------
    made = {}
    last = passes[-1]["date"]
    base = grey(hh0, -25, 0)
    for p in passes:
        dte = p["date"]
        im = to_img(mask_rgb(grey(boxes[dte]["hh"], -25, 0), [(forest0, FOREST_RGBA), (per[dte]["water"], WATER_RGBA), (per[dte]["flooded"], FLOOD_RGBA)]))
        made[f"pass-{dte}"] = save(caption_strip(im, [f"NISAR {fmt_date(dte)} 2026: blue = open water, bright green = flooded forest, dark green = forest on {fmt_date(first)}",
                                                     f"open water {[r for r in rows if r['date'] == dte][0]['open_water_km2']} km2 - flooded forest {[r for r in rows if r['date'] == dte][0]['flooded_forest_km2']} km2"]),
                                  f"ev-pass-{dte}.png")
    made["ev-pulse"] = made[f"pass-{last}"]
    gi, gdates = gap_chart()
    made["ev-gap"] = save(gi, "ev-gap.png")
    best = max(checked, key=lambda r: r["date"]) if checked else None
    if best:
        dsw = per[best["date"]]["dswx"]
        ours = to_img(mask_rgb(grey(boxes[best["date"]]["hh"], -25, 0), [(per[best["date"]]["water"], WATER_RGBA), (per[best["date"]]["flooded"], FLOOD_RGBA)]), 300)
        theirs = fit_to(dsw["image"], ours.size)
        made["tg-lband"] = save(caption_strip(to_img(mask_rgb(grey(boxes[best["date"]]["hh"], -25, 0), [(per[best["date"]]["water"], WATER_RGBA), (per[best["date"]]["flooded"], FLOOD_RGBA)])),
                                              [f"NISAR L-band {fmt_date(best['date'])}: blue = open water, green = flooded forest (our rules)"]), "tg-lband.png")
        made["tg-cband"] = save(caption_strip(fit_to(dsw["image"], (620, round(620 * shape[0] / shape[1]))),
                                              [f"OPERA DSWx-S1 (C-band) picture {fmt_date(dsw['date'])}: blue = open water, green = inundated vegetation, white = not water"]), "tg-cband.png")
        made["ev-check"] = save(side_by_side([(ours, f"NISAR L-band {fmt_date(best['date'])}"), (theirs, f"OPERA DSWx-S1 C-band {fmt_date(dsw['date'])}")],
                                             f"Open water agreement {best['agreement']:.0%}. Flooded forest the C-band map calls 'not water': {best['flooded_forest_missed_km2']} km2"), "ev-check.png")
        cb = dsw["cls"]
        wind = (cb == 1) & ~per[best["date"]]["water"] & np.isfinite(boxes[best["date"]]["hh"]) & (boxes[best["date"]]["hh"] > METHOD["water_hh_db"])
        made["ev-wind"] = save(caption_strip(to_img(mask_rgb(grey(boxes[best["date"]]["hh"], -25, 0), [(wind, (255, 120, 60, 230))])),
                                             [f"Orange: water on the C-band map that NISAR saw too bright in HH to call water ({wind.sum() * px_km2:.1f} km2)",
                                              "Wind ripples (or plants poking through) roughen water, so it no longer looks dark."]), "ev-wind.png")
        best["wind_or_rough_km2"] = round(float(wind.sum() * px_km2), 1)

    # ---------- grid for the case terrain ----------
    rows_n, cols_n = shape
    m = max(1, math.ceil(math.sqrt(rows_n * cols_n / 60000)))
    R, C = rows_n // m, cols_n // m
    mm = lambda a: np.nanmean(a[:R * m, :C * m].reshape(R, m, C, m), axis=(1, 3))
    q = lambda a: [None if not np.isfinite(v) else int(round(v * 10)) for v in a.ravel()]
    bx = grid["x"][:C * m].reshape(C, m).mean(axis=1)
    by = grid["y"][:R * m].reshape(R, m).mean(axis=1)
    elev = terrain.grid_heights(bx, by, grid["proj"])
    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (C * m - 1, 0), "sw": (0, R * m - 1), "se": (C * m - 1, R * m - 1)}.items():
        lon, lat = nio.utm_to_lonlat(grid["x"][cx], grid["y"][cy], grid["proj"])
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]
    layers = []
    for p in passes:
        dte = p["date"]
        layers.append({"id": f"hh-{dte}", "label": f"HH {fmt_date(dte)} 2026", "date": dte, "kind": "sequential", "unit": "dB", "scale": [-25, 0],
                       "what": "NISAR HH backscatter (water dark, flooded forest very bright)", "source": f"NISAR L2 GCOV, track 083 ascending, {dte}", "values": q(mm(boxes[dte]["hh"]))})
        layers.append({"id": f"water-{dte}", "label": f"Water share {fmt_date(dte)} (open water + flooded forest)", "date": dte, "kind": "sequential", "unit": "%",
                       "scale": [0, 100], "what": "Share of each block that our rules call open water or flooded forest", "source": f"NISAR L2 GCOV, {dte}",
                       "values": q(mm(np.where(np.isfinite(boxes[dte]["hh"]), (per[dte]["water"] | per[dte]["flooded"]).astype(float) * 100, np.nan)))})
    grid_out = {"about": "Blocky case terrain grid for Tonle Sap. Values x10 integers (null = no data); row 0 = north. Written by tools/process_tonle_sap.py.",
                "case": CASE, "rows": R, "cols": C, "merge": m, "pixel_m": pix_m, "block_m": pix_m * m,
                "block_text": f"one block = {m}×{m} filtered pixels of {pix_m:.0f} m ≈ {pix_m * m:.0f} m",
                "corners_latlon": corners, "layers": layers, "default_layer": f"water-{last}",
                "elev_dm": [int(round(v * 10)) for v in elev.ravel()], "height_source": terrain.SOURCE}
    with open(os.path.join(ASSET_DIR, "grid.json"), "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(grid_out), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

    # ---------- numbers ----------
    lr = rows[-1]
    measured = [{"label": f"Open water {fmt_date(r['date'])}", "value": r["open_water_km2"], "unit": "km²",
                 "note": "NISAR HH ≤ −16 dB and HV ≤ −22 dB" + (f"; agreement with DSWx-S1 ({fmt_date(r['dswx_date'])}): {r['agreement']:.0%}" if r.get("agreement") is not None else "; no DSWx-S1 picture within ±6 days")} for r in rows]
    measured += [{"label": f"Flooded forest {fmt_date(r['date'])} (L-band only)", "value": r["flooded_forest_km2"], "unit": "km²",
                  "note": "Forest on 19 Jun whose HH rose to ≥ −5 dB (double bounce). Moderate by definition: no independent check sees under trees."
                          + (f" The C-band water map calls {r['flooded_forest_missed_km2']} km² of it 'not water'." if r.get("agreement") is not None else "")} for r in rows]
    measured.append({"label": "Passes analysed", "value": len(passes), "unit": "",
                     "note": ", ".join(fmt_date(p["date"]) for p in passes) + ". More passes (30 Aug, 17 Oct) give the pulse curve when they finish downloading." if len(passes) < 3 else ", ".join(fmt_date(p["date"]) for p in passes)})
    measured.append({"label": "Rain since 1 May", "value": rain_total[0], "unit": "mm", "note": f"{METHOD['power_label']}; {rain_total[1]} days with data."})
    if checked:
        check_text = "; ".join(f"{fmt_date(r['date'])} vs DSWx-S1 {fmt_date(r['dswx_date'])}: {r['agreement']:.0%} agree on open water (IoU {r['iou']:.0%})" for r in checked)
    else:
        check_text = ("Check pending: NASA OPERA DSWx-S1 has no picture of this box within ±6 days of the finished NISAR pass(es) "
                      f"({', '.join(fmt_date(r['date']) for r in rows)}). DSWx-S1 pictures exist for 30 Aug and 17 Oct, which match passes still downloading.")
    numbers = {
        "case": CASE, "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured, "check": {"label": "Independent check", "text": check_text},
        "badge": badge, "badge_reason": badge_reason, "sources": [p["file"] for p in passes],
        "method": METHOD,
        "results": {"pulse": rows, "forest_at_start_km2": round(float(forest0.sum() * px_km2), 1), "pixel_m": pix_m,
                    "open_water_badge": ow_badge, "rain": {"label": METHOD["power_label"], "since_1_may_mm": rain_total[0], "monthly": monthly_list},
                    "catalogue_pass_days": len(gdates)},
        "files": {"grid": f"assets/cases/{CASE}/grid.json"},
        "provenance": {
            "nasa_files": [{k: p[k] for k in ("file", "date", "start", "direction", "track", "frame", "product_version", "processing")} for p in passes],
            "collection": "NISAR L2 GCOV (ASF DAAC)", "layers": [f"{GRID}/{n}" for n in METHOD["layers"]],
            "box_lonlat": list(nio.case_box(CASE)), "box_rows_cols": list(window), "projection_epsg": grid["proj"]["epsg"],
            "pixel_m_after_filter": pix_m, "number_of_looks_native": grid["looks"],
            "other_sources": {"check": f"NASA OPERA DSWx-S1 via GIBS WMS ({DSWX})", "rain": f"NASA POWER daily API, {url}", "heights": terrain.SOURCE,
                              "mekong": "Chua et al. 2022, Hydrol. Earth Syst. Sci. 26:609-625, doi:10.5194/hess-26-609-2022"},
            "steps": ["read only the box", "mask invalid pixels", f"{grid['k']}x{grid['k']} multilook (linear power)", "dB",
                      "forest at start from the first pass", "open water and flooded forest per pass", "DSWx-S1 nearest date, colours decoded", "agreement -> badge"],
            "script": "tools/process_tonle_sap.py", "script_version": SCRIPT_VERSION,
            "script_sha256": sha256(os.path.abspath(__file__)), "helpers_sha256": sha256(os.path.join(nio.HERE, "nisar_io.py")),
        },
    }
    with open(NUMBERS, "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(numbers), f, indent=1, ensure_ascii=False, allow_nan=False)
    log(f"wrote {NUMBERS} badge={badge}")

    # ---------- mystery file ----------
    with open(MYSTERY, encoding="utf-8") as f:
        mys = json.load(f)
    ev = {e["id"]: e for e in mys["evidence"]}
    r0 = rows[0]
    ev["pulse"].update(src=made["ev-pulse"], pending=False,
                       caption=f"NISAR on {fmt_date(last)}: {lr['open_water_km2']} km² of open water and {lr['flooded_forest_km2']} km² of flooded forest in our box."
                       + (" Only one pass is processed so far, so the pulse curve has one point." if len(passes) == 1 else ""))
    ev["gap"].update(src=made["ev-gap"], pending=False,
                     caption=f"NASA's catalogue lists {len(gdates)} NISAR pass days over Tonle Sap from 1 Jun to 10 Nov, with nothing from 27 Jul to 10 Aug. A pulse curve has to skip that gap, not draw a line through it as if it were measured.")
    if best:
        ev["check"].update(src=made["ev-check"], pending=False,
                           caption=f"{fmt_date(best['date'])}: NISAR and the C-band OPERA DSWx-S1 map ({fmt_date(best['dswx_date'])}) agree on open water at {best['agreement']:.0%} of pixels. Of our flooded forest, {best['flooded_forest_missed_km2']} km² is 'not water' on the C-band map.")
        ev["wind"].update(src=made["ev-wind"], pending=False,
                          caption=f"{best['wind_or_rough_km2']} km² that the C-band map calls open water looked too bright to NISAR to count as water. Rough water (wind ripples, floating plants) scatters the beam back, so 'not dark' doesn't always mean 'not water'.")
        tg = {t["id"]: t for t in mys["toggles"]}
        tg["band"]["layers"] = {"off": {"src": made["tg-lband"], "label": f"NISAR L-band {fmt_date(best['date'])}"},
                                "on": {"src": made["tg-cband"], "label": f"OPERA DSWx-S1 C-band {fmt_date(best['dswx_date'])}"}}
        for n_ in mys["graph"]["nodes"]:
            if n_["id"] in ("openwater", "missed"):
                n_["opens"]["layer"] = made["ev-check"]
    with open(MYSTERY, "w", encoding="utf-8") as f:
        json.dump(mys, f, indent=2, ensure_ascii=False)
        f.write("\n")
    np.savez_compressed(os.path.join(KIT_DIR, "arrays.npz"), forest0=forest0, x=grid["x"], y=grid["y"],
                        **{f"hh_{d}": boxes[d]["hh"] for d in boxes}, **{f"hv_{d}": boxes[d]["hv"] for d in boxes})
    update_results.update()
    log(f"done in {time.time() - t0:.0f} s")


def fit_to(img, size):
    return img.resize(size, Image.NEAREST)


if __name__ == "__main__":
    sys.exit(main())
