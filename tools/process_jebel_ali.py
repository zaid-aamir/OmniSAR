"""
Jebel Ali case: measure what changed between June and October 2026 from NISAR radar images.

Run (from the repo folder):   py tools/process_jebel_ali.py
Re-run any time: when new passes finish downloading, or after Teammate A fills in the photo check.

What it does, in order:
  1. Finds the finished NISAR GCOV files for track 056, ascending, frame 014 (mode 4005) and
     sorts them into BEFORE (18 Jun - 12 Jul) and AFTER (4 - 28 Oct). Never opens .h5.part files.
  2. Reads only the Jebel Ali box (HH, HV, mask) and filters speckle: 3x3 block mean in linear
     power -> 30 m pixels.
  3. Interference check: samples the whole frame to see whether one date has a broad bright or
     dark patch (e.g. radio interference) over our box.
  4. Median of each side, then LOCAL NORMALISATION: each side's smooth background (2 km tiles)
     is removed, so a regional brightness offset can't look like change.
  5. Classifies change with the rules in METHOD (written down before any result was seen),
     groups changed pixels into hotspots, and keeps the 10 biggest.
  6. Photo-check kit (outside the repo): NISAR + NASA HLS photo crops for each hotspot and a
     photo_check.csv for Teammate A. If that CSV is filled in, counts "X of 10 confirmed".
  7. Writes cases/jebel-ali.numbers.json (with full provenance), a transparent overlay PNG and a
     grid JSON for the case terrain, then runs tools/update_results.py.

Every threshold is in METHOD below. Never change one to make a result look better: if a result is
weak or empty, that IS the verdict.
"""

import csv
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import sys
import time
import warnings

import h5py
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import nisar_io as nio
import terrain
import update_results

warnings.filterwarnings("ignore", category=RuntimeWarning)    # all-NaN tiles etc. are handled explicitly

SCRIPT_VERSION = "1.3"   # 1.3: passes flagged by our interference check are excluded from the change rule (QC_EXCLUSIONS, declared 14 Nov 05:50 + 12:35, METHOD unchanged); 1.2.1: script fingerprints taken with LF line endings (as stored in git); 1.1: display rule, terrain heights, per-pass medians; 1.2: single-pass cross-checks, NaN-safe JSON (METHOD unchanged)
CASE = "jebel-ali"
GRID = "/science/LSAR/GCOV/grids/frequencyA"
DATA_DIR = os.path.join(nio.PROJECT, "data", "gcov")
KIT_DIR = os.path.join(nio.PROJECT, "research", "checks", CASE)          # outside the repo
ASSET_DIR = os.path.join(nio.REPO, "assets", "cases", CASE)
NUMBERS = os.path.join(nio.REPO, "cases", f"{CASE}.numbers.json")
FILE_PATTERN = "_056_A_014_4005_"

# ---------------------------------------------------------------------------------------------
# METHOD - fixed BEFORE looking at any change result (logged in why_log.md, Sat 14 Nov 03:33).
# Copied word for word into the numbers file so anyone can check what we did.
# ---------------------------------------------------------------------------------------------
METHOD = {
    "declared": "2026-11-14T03:33+04:00, before any change map was computed (first run 03:39)",
    "inputs": "NISAR L2 GCOV, track 056, ascending, frame 014, mode 4005 (10 m), finished files only",
    "before_window": ["2026-06-18", "2026-07-12"],
    "after_window": ["2026-10-04", "2026-10-28"],
    "layers": ["HHHH", "HVHV", "mask"],
    "valid_pixel": "mask is a subswath number (1-254), HH > 0 and HV > 0",
    "speckle_filter": "3x3 block mean in linear power (multilook) -> 30 m pixels; a block is valid only if all 9 pixels are valid",
    "multilook": 3,
    "side_value": "per-pixel median in dB of all passes inside the window (N < 3 per side = 'median not robust': one bad date can't be outvoted)",
    "interference_check": "sample the whole frame on a 40x40 grid of 32x32-pixel windows; compare each pass with the first before-pass; anomaly over the box if |box median change - frame median change| >= 1.5 dB in HH or HV",
    "interference_limit_db": 1.5,
    "channel_for_rules": "HH only (HV is shown but not used, because the regional anomaly is strongest in HV)",
    "local_normalisation": "each side's background = median dB of 2 km x 2 km tiles (66 x 66 pixels), bilinear between tile centres; delta = (after - background_after) - (before - background_before). Removes smooth regional offsets (processing version, interference); can only hide changes wider than ~2 km, never invent them",
    "tile_px": 66,
    "gain_check": "in every tile, delta of the darkest quarter minus delta of the brightest quarter of unchanged pixels; if the median over tiles is beyond +/-2 dB the brightness difference is not a simple gain -> radar quality check fails",
    "gain_limit_db": 2.0,
    "sea_window": {"lon": [54.956, 54.980], "lat": [25.042, 25.056], "chosen_from": "NASA HLS photo of 18 Jun 2026 (open sea, away from the Palm)"},
    "land_window": {"lon": [54.960, 54.995], "lat": [24.935, 24.950], "chosen_from": "NASA HLS photo of 18 Jun 2026 (open desert sand)"},
    "water_level": "T_water = 90th percentile of the sea window (before image)",
    "land_level": "T_land = 10th percentile of the desert window (before image)",
    "separable": "water and land can be told apart only if T_water < T_land; otherwise water<->land classes are 'not separable' (trap 11) and not reported",
    "X_db": 3.0,
    "X_reason": "3 dB is about 3 sigma of speckle noise on a difference of two 30 m pixels (~42 looks each), and new walls, roofs and fill typically raise L-band HH by 3-10 dB",
    "classes": {
        "water-to-land": "before <= T_water and after (brightness-matched) >= T_land and delta >= +X",
        "land-to-water": "before >= T_land and after <= T_water and delta <= -X",
        "new-structures": "delta >= +X and after >= T_land (and not water-to-land)",
    },
    "hotspots": "8-connected clusters of one class, at least 12 pixels (1.08 ha); top 10 by area",
    "min_cluster_px": 12,
    "photo_dates": "clearest NASA HLS (S30 or L30) day within +/-10 days of the first before pass and the last after pass; score = valid share x (1 - white-cloud share); ties (within 0.02) -> nearest date",
    "badge_rule": "Strong if >= 7 of 10 hotspots are photo-confirmed; Moderate if radar only (photo check not done) or 4-6 confirmed; Weak otherwise. 'Radar only' counts as Moderate only if the radar quality checks pass and at least one hotspot exists; otherwise Weak.",
    "coherence_check": "UAE interferograms on hand are track 128 frame 015, which start ~25.2 N, north of this box (top edge 25.06 N): no coherence check for Jebel Ali",
}

# Quality control, declared in why_log.md (Sat 14 Nov 05:50, repeated 12:35) BEFORE this version ran.
# Not a METHOD change: every threshold above stays the same. A listed pass is still read (so the
# interference check can show it, and it stays the Trap #8 exhibit) but is left out of the change
# rule. The script refuses to run if a listed pass is NOT flagged by the interference check.
QC_EXCLUSIONS = {
    "2026-10-28": "flagged by our own interference check (box HH +6.3 dB while the whole frame moved +0.1 dB on 14 Nov 05:40); kept as the Trap #8 exhibit",
}
QC_DECLARED = "2026-11-14T05:50+04:00 (why_log.md), repeated 12:35 before the v1.3 run; thresholds unchanged"

CLASS_CODES = {"none": 0, "new-structures": 1, "water-to-land": 2, "land-to-water": 3}
CLASS_NAMES = {1: "New structures (HH rose)", 2: "Water to land", 3: "Land to water"}
# Fixed data colours (same in every palette): warm = brighter, cool = darker
CLASS_RGBA = {1: (242, 142, 43, 230), 2: (255, 209, 102, 230), 3: (78, 155, 214, 230)}
NODATA = 255
HH_SHOW = (-25.0, 5.0)        # greyscale limits for NISAR crops in the photo kit (dB)


def fmt_date(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.day} {d.strftime('%b')}"


def log(*a):
    print(*a, flush=True)


def sha256(path):
    """Fingerprint of a script, taken with LF line endings, which is exactly how git stores it.
    (Windows checks files out with CRLF line endings; without this, the fingerprint made on a
    Windows laptop would never match the same file on GitHub.) Used by every processing script."""
    with open(path, "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


# ------------------------------------------------------------------ 1. find the passes
def find_passes():
    passes = []
    for path in nio.finished_h5(DATA_DIR, FILE_PATTERN):
        with h5py.File(path, "r") as f:
            ident = f["/science/LSAR/identification"]
            start = ident["zeroDopplerStartTime"][()].decode()
            passes.append({
                "file": os.path.basename(path),
                "path": path,
                "date": start[:10],
                "start": start,
                "direction": ident["orbitPassDirection"][()].decode(),
                "track": int(ident["trackNumber"][()]),
                "frame": int(ident["frameNumber"][()]),
                "product_version": ident["productVersion"][()].decode(),
                "processing": next((x for x in os.path.basename(path).split("_") if x.startswith("P0")), "?"),
            })
    for p in passes:
        if not p["direction"].lower().startswith("a"):
            raise SystemExit(f"{p['file']} is not ascending - refusing to mix directions (trap 7)")
    b0, b1 = METHOD["before_window"]
    a0, a1 = METHOD["after_window"]
    before = [p for p in passes if b0 <= p["date"] <= b1]
    after = [p for p in passes if a0 <= p["date"] <= a1]
    return before, after


# ------------------------------------------------------------------ 2. read + speckle filter
def read_box(p, window=None):
    """Read HH and HV for the case box, set invalid pixels to NaN, multilook 3x3.
    Returns linear-power arrays at 30 m plus the grid info."""
    with h5py.File(p["path"], "r") as f:
        g = f[GRID]
        proj = nio.projection_params(g["projection"])
        x, y = g["xCoordinates"], g["yCoordinates"]
        (r0, r1, c0, c1), _ = nio.box_window(nio.case_box(CASE), x, y, proj)
        if window and window != (r0, r1, c0, c1):
            raise SystemExit("files are on different grids - refusing to compare them")
        xs = x[c0:c1].astype(np.float64)
        ys = y[r0:r1].astype(np.float64)
        hh = g["HHHH"][r0:r1, c0:c1].astype(np.float64)
        hv = g["HVHV"][r0:r1, c0:c1].astype(np.float64)
        mask = g["mask"][r0:r1, c0:c1]
        looks = float(np.nanmedian(g["numberOfLooks"][r0:r1, c0:c1][::16, ::16])) if "numberOfLooks" in g else None
    bad = (mask == 0) | (mask == 255) | ~(hh > 0) | ~(hv > 0)
    hh[bad] = np.nan
    hv[bad] = np.nan
    k = METHOD["multilook"]
    hh_ml, hv_ml = nio.multilook(hh, k), nio.multilook(hv, k)
    n_r, n_c = hh_ml.shape
    return {"hh": hh_ml, "hv": hv_ml, "window": (r0, r1, c0, c1), "proj": proj,
            "x": xs[: n_c * k].reshape(n_c, k).mean(axis=1),
            "y": ys[: n_r * k].reshape(n_r, k).mean(axis=1),
            "looks": looks, "valid_share": float(np.mean(~bad))}


# ------------------------------------------------------------------ 3. interference check
def frame_sample(p, n=40, size=32):
    """Median HH and HV dB in an n x n grid of small windows spread over the whole frame.
    Windows start at the corner of a 512 x 512 storage chunk, so each unzips only one chunk."""
    out = np.full((n, n, 2), np.nan)
    with h5py.File(p["path"], "r") as f:
        g = f[GRID]
        H, W = g["HHHH"].shape
        for i in range(n):
            for j in range(n):
                r = int((i + 0.5) * H / n) // 512 * 512
                c = int((j + 0.5) * W / n) // 512 * 512
                out[i, j, 0] = np.nanmedian(nio.power_to_db(g["HHHH"][r:r + size, c:c + size]))
                out[i, j, 1] = np.nanmedian(nio.power_to_db(g["HVHV"][r:r + size, c:c + size]))
    return out, (H, W)


def interference_check(passes, boxes):
    ref = passes[0]
    ref_sample, shape = frame_sample(ref)
    lim = METHOD["interference_limit_db"]
    results = []
    for p in passes[1:]:
        s, _ = frame_sample(p)
        d = s - ref_sample
        row = {"pass": p["date"], "compared_with": ref["date"]}
        for k, ch in enumerate(("HH", "HV")):
            frame_med = float(np.nanmedian(d[:, :, k]))
            box_med = float(np.nanmedian(nio.power_to_db(boxes[p["date"]][ch.lower()]))
                            - np.nanmedian(nio.power_to_db(boxes[ref["date"]][ch.lower()])))
            row[ch] = {
                "box_median_change_db": round(box_med, 2),
                "frame_median_change_db": round(frame_med, 2),
                "frame_share_beyond_3db": round(float(np.nanmean(np.abs(d[:, :, k][np.isfinite(d[:, :, k])]) >= 3)), 3),
                "anomaly_over_box": bool(abs(box_med - frame_med) >= lim),
            }
        row["anomaly_over_box"] = row["HH"]["anomaly_over_box"] or row["HV"]["anomaly_over_box"]
        row["picture"] = f"interference_{ref['date']}_vs_{p['date']}.png"
        results.append(row)
        save_interference_png(d, shape, boxes[p["date"]]["window"], ref["date"], p["date"],
                              os.path.join(KIT_DIR, row["picture"]))
    return results


def diverging(v, lim):
    """Fixed diverging colour scale: blue = darker, white = no change, orange-red = brighter."""
    t = np.clip(np.nan_to_num(v / lim, nan=0.0), -1, 1)
    up = np.array([214, 96, 77], dtype=float)       # brighter end
    down = np.array([67, 147, 195], dtype=float)    # darker end
    white = np.array([247, 247, 247], dtype=float)
    a = np.abs(t)[..., None]
    rgb = np.where(t[..., None] > 0, white + (up - white) * a, white + (down - white) * a)
    rgb = rgb.clip(0, 255).astype(np.uint8)
    rgb[np.isnan(v)] = (40, 40, 40)
    return rgb


def save_interference_png(d, shape, window, d0, d1, out):
    cell = 12
    tiles = []
    for k, ch in enumerate(("HH", "HV")):
        img = Image.fromarray(diverging(d[:, :, k], 8.0)).resize((d.shape[1] * cell, d.shape[0] * cell), Image.NEAREST)
        dr = ImageDraw.Draw(img)
        r0, r1, c0, c1 = window
        sy, sx = d.shape[0] * cell / shape[0], d.shape[1] * cell / shape[1]
        dr.rectangle([c0 * sx, r0 * sy, c1 * sx, r1 * sy], outline=(0, 0, 0), width=3)
        tiles.append((ch, img))
    w = sum(t.width for _, t in tiles) + 30
    canvas = Image.new("RGB", (w, tiles[0][1].height + 60), (20, 22, 28))
    dr = ImageDraw.Draw(canvas)
    x = 10
    for ch, t in tiles:
        canvas.paste(t, (x, 50))
        dr.text((x, 8), f"{ch} change {d1} minus {d0} (dB), whole NISAR frame", fill=(230, 230, 230), font=font(14))
        dr.text((x, 28), "blue -8 dB ... white 0 ... red +8 dB   black box = Jebel Ali case", fill=(170, 170, 170), font=font(12))
        x += t.width + 10
    canvas.save(out)


# ------------------------------------------------------------------ 4. medians + normalisation
def side_median(boxes, side):
    return np.nanmedian(np.stack([nio.power_to_db(boxes[p["date"]]["hh"]) for p in side]), axis=0)


def background(img, t):
    """Smooth background: median of each t x t tile, then bilinear between tile centres."""
    rows, cols = img.shape
    nr, nc = math.ceil(rows / t), math.ceil(cols / t)
    med = np.full((nr, nc), np.nan)
    for i in range(nr):
        for j in range(nc):
            tile = img[i * t:(i + 1) * t, j * t:(j + 1) * t]
            if np.isfinite(tile).mean() >= 0.25:
                med[i, j] = np.nanmedian(tile)
    for _ in range(nr + nc):                       # fill empty tiles from their neighbours
        if not np.isnan(med).any():
            break
        pad = np.pad(med, 1, constant_values=np.nan)
        neigh = np.stack([pad[1 + di:1 + di + nr, 1 + dj:1 + dj + nc]
                          for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj])
        med = np.where(np.isnan(med), np.nanmean(neigh, axis=0), med)
    cy = (np.arange(nr) + 0.5) * t - 0.5
    cx = (np.arange(nc) + 0.5) * t - 0.5
    across = np.stack([np.interp(np.arange(cols), cx, med[i]) for i in range(nr)])
    return np.stack([np.interp(np.arange(rows), cy, across[:, j]) for j in range(cols)], axis=1)


def window_pixels(win, grid):
    """Row/column slices of the 30 m grid covering a lon/lat window."""
    pts = [nio.lonlat_to_utm(lon, lat, grid["proj"]) for lon in win["lon"] for lat in win["lat"]]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    c0, c1 = int(np.searchsorted(grid["x"], min(xs))), int(np.searchsorted(grid["x"], max(xs)))
    r0, r1 = int(np.searchsorted(-grid["y"], -max(ys))), int(np.searchsorted(-grid["y"], -min(ys)))
    return slice(r0, r1), slice(c0, c1)


# ------------------------------------------------------------------ 5. classify + hotspots
def classify(before, after_n, delta, t_water, t_land, separable):
    X = METHOD["X_db"]
    cls = np.zeros(before.shape, dtype=np.uint8)
    valid = np.isfinite(before) & np.isfinite(after_n) & np.isfinite(delta)
    w2l = np.zeros_like(valid)
    if separable:
        w2l = valid & (before <= t_water) & (after_n >= t_land) & (delta >= X)
        l2w = valid & (before >= t_land) & (after_n <= t_water) & (delta <= -X)
        cls[l2w] = 3
        cls[w2l] = 2
    new = valid & (delta >= X) & (after_n >= t_land) & ~w2l
    cls[new] = 1
    cls[~valid] = NODATA
    return cls


def hotspots(cls, grid):
    found = []
    px_m = abs(grid["x"][1] - grid["x"][0])
    for code in (1, 2, 3):
        for members in nio.label_clusters(cls == code):
            if len(members) < METHOD["min_cluster_px"]:
                continue
            r, c = members[:, 0], members[:, 1]
            x = np.interp(c.mean(), np.arange(len(grid["x"])), grid["x"])
            y = np.interp(r.mean(), np.arange(len(grid["y"])), grid["y"])
            lon, lat = nio.utm_to_lonlat(x, y, grid["proj"])
            found.append({
                "class": [k for k, v in CLASS_CODES.items() if v == code][0],
                "pixels": int(len(members)),
                "area_ha": round(len(members) * px_m * px_m / 10000, 2),
                "lat": round(float(lat), 5), "lon": round(float(lon), 5),
                "rows": [int(r.min()), int(r.max())], "cols": [int(c.min()), int(c.max())],
                "_members": members,
            })
    found.sort(key=lambda h: -h["pixels"])
    for i, h in enumerate(found):
        h["id"] = f"H{i + 1:02d}"
    return found


# ------------------------------------------------------------------ 6. photo-check kit
def pick_photo_date(target, box):
    """Clearest HLS day near a date (rule in METHOD['photo_dates'])."""
    w, s, e, n = box
    t = dt.date.fromisoformat(target)
    best, tried = None, []
    for layer in ("HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "HLS_L30_Nadir_BRDF_Adjusted_Reflectance"):
        for off in range(-10, 11):
            day = (t + dt.timedelta(days=off)).isoformat()
            try:
                img, _ = nio.gibs_wms(layer, day, w, s, e, n, 310, 240)
            except Exception as ex:                                  # network hiccup: note it, skip that day
                tried.append({"layer": layer, "date": day, "error": str(ex)[:80]})
                continue
            a = np.asarray(img)
            valid = a[:, :, 3] > 0
            if valid.mean() < 0.05:
                continue
            rgb = a[:, :, :3].astype(int)
            white = (rgb.min(axis=2) >= 225) & (rgb.max(axis=2) - rgb.min(axis=2) <= 20) & valid
            score = float(valid.mean() * (1 - white.sum() / max(valid.sum(), 1)))
            tried.append({"layer": layer, "date": day, "score": round(score, 3)})
            key = (round(score / 0.02), -abs(off))
            if best is None or key > best[0]:
                best = (key, {"layer": layer, "date": day, "score": round(score, 3)})
    return (best[1] if best else None), tried


def crop_grey(img_db, r0, r1, c0, c1, scale):
    sub = img_db[r0:r1, c0:c1]
    g = nio.stretch(sub, *HH_SHOW)
    return Image.fromarray(g, "L").convert("RGB").resize((sub.shape[1] * scale, sub.shape[0] * scale), Image.NEAREST)


def build_kit(spots, before, after_n, grid, photo_before, photo_after, before_dates, after_dates):
    rows, cols = before.shape
    for h in spots:
        r, c = h["_members"][:, 0], h["_members"][:, 1]
        half = max(20, int(max(np.ptp(r), np.ptp(c)) * 0.8) + 6)        # crops at least 1.2 km wide
        cr, cc = int(round(r.mean())), int(round(c.mean()))
        r0, r1 = max(cr - half, 0), min(cr + half, rows)
        c0, c1 = max(cc - half, 0), min(cc + half, cols)
        scale = max(1, 300 // max(r1 - r0, c1 - c0))
        tiles = []
        for label, img in ((f"NISAR HH before ({', '.join(before_dates)})", before),
                           (f"NISAR HH after ({', '.join(after_dates)}), brightness-matched", after_n)):
            t = crop_grey(img, r0, r1, c0, c1, scale)
            d = ImageDraw.Draw(t)
            mem = set(map(tuple, h["_members"].tolist()))
            for (rr, ccx) in mem:                                        # outline only the cluster's edge pixels
                if all((rr + a, ccx + b) in mem for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    continue
                x0, y0 = (ccx - c0) * scale, (rr - r0) * scale
                d.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], outline=(255, 60, 60))
            tiles.append((label, t))
        xs = [grid["x"][c0], grid["x"][c1 - 1]]
        ys = [grid["y"][r0], grid["y"][r1 - 1]]
        lons, lats = zip(*[nio.utm_to_lonlat(x, y, grid["proj"]) for x in xs for y in ys])
        bbox = (float(min(lons)), float(min(lats)), float(max(lons)), float(max(lats)))
        size = tiles[0][1].size
        for label, ph in (("NASA HLS photo before", photo_before), ("NASA HLS photo after", photo_after)):
            if ph is None:
                t = Image.new("RGB", size, (40, 40, 40))
                ImageDraw.Draw(t).text((10, 10), "no clear photo found", fill=(220, 220, 220), font=font(14))
                tiles.append((label + " - none", t))
                continue
            img, _ = nio.gibs_wms(ph["layer"], ph["date"], *bbox, size[0], size[1])
            t = Image.new("RGB", img.size, (0, 0, 0))
            t.paste(img, mask=img.split()[3])
            # where the hotspot sits inside the photo (same fractions as in the radar crop)
            fy0, fy1 = (r.min() - r0) / (r1 - r0), (r.max() + 1 - r0) / (r1 - r0)
            fx0, fx1 = (c.min() - c0) / (c1 - c0), (c.max() + 1 - c0) / (c1 - c0)
            ImageDraw.Draw(t).rectangle([fx0 * size[0], fy0 * size[1], fx1 * size[0], fy1 * size[1]], outline=(255, 60, 60), width=2)
            tiles.append((f"{label} {ph['date']} ({ph['layer'][4:7]})", t))
        W = sum(t.width for _, t in tiles) + 10 * (len(tiles) + 1)
        canvas = Image.new("RGB", (W, size[1] + 110), (20, 22, 28))
        d = ImageDraw.Draw(canvas)
        d.text((10, 8), f"{h['id']}  {CLASS_NAMES[CLASS_CODES[h['class']]]}  {h['area_ha']} ha  "
                        f"centre {h['lat']:.4f} N, {h['lon']:.4f} E", fill=(240, 240, 240), font=font(18))
        d.text((10, 34), "Question for the checker: do the two photos show a change inside the red outline / red "
                         "rectangle (new buildings, new land, cleared or filled ground)?", fill=(180, 180, 180), font=font(13))
        x = 10
        for label, t in tiles:
            canvas.paste(t, (x, 60))
            d.text((x, 64 + t.height), label, fill=(210, 210, 210), font=font(11))
            x += t.width + 10
        canvas.save(os.path.join(KIT_DIR, f"{h['id']}.png"))


def kit_signature(spots):
    return hashlib.sha256(json.dumps([(h["class"], h["pixels"], h["lat"], h["lon"]) for h in spots]).encode()).hexdigest()[:16]


def read_photo_check(spots):
    """Read Teammate A's answers. Returns (confirmed, answers, total), or None if not filled in.
    If the hotspots changed since the template was made (e.g. new passes), the old answers are
    moved to a backup and NOT used, because they would describe different places."""
    path = os.path.join(KIT_DIR, "photo_check.csv")
    sig_path = os.path.join(KIT_DIR, "kit_signature.txt")
    sig = kit_signature(spots)
    if os.path.exists(path):
        old = open(sig_path).read().strip() if os.path.exists(sig_path) else ""
        if old != sig:
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M")
            shutil.move(path, os.path.join(KIT_DIR, f"photo_check_OLD_{stamp}.csv"))
            log("  hotspots changed since the last photo check -> old answers backed up, not used")
    if not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["hotspot", "confirmed", "note"])
            for h in spots:
                w.writerow([h["id"], "", ""])
        with open(sig_path, "w") as f:
            f.write(sig)
        return None
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    answers = {(r.get("hotspot") or "").strip(): (r.get("confirmed") or "").strip().lower() for r in rows}
    ids = [h["id"] for h in spots]
    if not ids or any(answers.get(i, "") not in ("yes", "no", "unclear") for i in ids):
        return None                                   # not completely filled in yet
    return sum(answers[i] == "yes" for i in ids), {i: answers[i] for i in ids}, len(ids)


# ------------------------------------------------------------------ 7. outputs for the app
def save_overlay(cls):
    rgba = np.zeros(cls.shape + (4,), dtype=np.uint8)
    for code, col in CLASS_RGBA.items():
        rgba[cls == code] = col
    Image.fromarray(rgba, "RGBA").save(os.path.join(ASSET_DIR, "change_overlay.png"), optimize=True)


def save_grid(grid, passes_db, delta, cls, before_dates, after_dates, change_note=None):
    """Grid for the blocky case terrain. If there are more than ~60,000 pixels, m x m pixels are
    merged into one block (mean in linear power), and the true block size is written down."""
    rows, cols = delta.shape
    m = max(1, math.ceil(math.sqrt(rows * cols / 60000)))
    R, C = rows // m, cols // m

    def merge_db(a):
        lin = 10 ** (a[:R * m, :C * m] / 10)
        return 10 * np.log10(np.nanmean(lin.reshape(R, m, C, m), axis=(1, 3)))

    def merge_mean(a):
        return np.nanmean(a[:R * m, :C * m].reshape(R, m, C, m), axis=(1, 3))

    def q(a):          # dB x 10 as integers; null where there is no data
        return [None if not np.isfinite(v) else int(round(v * 10)) for v in a.ravel()]

    cb = cls[:R * m, :C * m].reshape(R, m, C, m).transpose(0, 2, 1, 3).reshape(R, C, m * m)
    block_cls = np.zeros((R, C), dtype=int)
    for code in (1, 2, 3):
        share = (cb == code).mean(axis=2)
        block_cls[share >= 1 / 3] = code          # a block shows a class if >= 1/3 of its pixels have it
    px = abs(float(grid["x"][1] - grid["x"][0]))
    bx = grid["x"][:C * m].reshape(C, m).mean(axis=1)
    by = grid["y"][:R * m].reshape(R, m).mean(axis=1)
    elev = terrain.grid_heights(bx, by, grid["proj"])
    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (C * m - 1, 0), "sw": (0, R * m - 1), "se": (C * m - 1, R * m - 1)}.items():
        lon, lat = nio.utm_to_lonlat(grid["x"][cx], grid["y"][cy], grid["proj"])
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]
    pass_layers = [{
        "id": f"pass-{d}", "label": f"Pass {fmt_date(d)} 2026 ({s})", "date": d, "side": s,
        "kind": "sequential", "unit": "dB", "scale": [-25, 5],
        "what": "NISAR HH backscatter (how much of the radar beam came back)",
        "source": f"NISAR L2 GCOV, track 056 ascending, {d}",
        "values": q(merge_db(passes_db[d])),
    } for s, ds in (("before", before_dates), ("after", after_dates)) for d in ds]
    change_layer = {
        "id": "change", "label": "Change: after vs before (background removed)", "date": f"{before_dates[0]} → {after_dates[-1]}",
        "kind": "diverging", "unit": "dB", "scale": [-6, 6],
        "what": "HH change after removing each side's smooth 2 km background (method in the numbers file)",
        "source": "NISAR L2 GCOV, track 056 ascending; median of " + f"{len(before_dates)} before / {len(after_dates)} after passes",
        "note": change_note,
        "values": q(merge_mean(delta)),
    }
    out = {
        "about": "Blocky case terrain grid for Jebel Ali. Layer values are x10 integers (null = no data); row 0 = north; corners are block centres. Written by tools/process_jebel_ali.py.",
        "case": CASE,
        "rows": R, "cols": C,
        "merge": m,
        "pixel_m": round(px, 1),
        "block_m": round(px * m, 1),
        "block_text": f"one block = {m}×{m} filtered pixels of {round(px)} m = {3 * m}×{3 * m} NISAR 10 m pixels ≈ {round(px * m)} m",
        "corners_latlon": corners,
        "layers": pass_layers + [change_layer],
        "default_layer": "change",
        "class": block_cls.ravel().tolist(),
        "class_names": {str(k): v for k, v in CLASS_NAMES.items()},
        "elev_dm": [int(round(v * 10)) for v in elev.ravel()],
        "height_source": terrain.SOURCE,
    }
    with open(os.path.join(ASSET_DIR, "grid.json"), "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(out), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return out


# ------------------------------------------------------------------ main
def analyse(boxes, before, after, grid, quiet=False):
    """The whole change analysis (METHOD) for one set of before/after passes. Used for the
    verdict and, unchanged, for the single-pass cross-checks."""
    log_ = (lambda *a: None) if quiet else log
    before_db = side_median(boxes, before)
    after_db = side_median(boxes, after)
    t = METHOD["tile_px"]
    bg_b, bg_a = background(before_db, t), background(after_db, t)
    delta = (after_db - bg_a) - (before_db - bg_b)
    after_n = after_db - bg_a + bg_b                       # after, brightness-matched to before

    sea = window_pixels(METHOD["sea_window"], grid)
    land = window_pixels(METHOD["land_window"], grid)
    t_water = float(np.nanpercentile(before_db[sea], 90))
    t_land = float(np.nanpercentile(before_db[land], 10))
    separable = t_water < t_land
    refs = {
        "sea_before_median_db": round(float(np.nanmedian(before_db[sea])), 2),
        "desert_before_median_db": round(float(np.nanmedian(before_db[land])), 2),
        "sea_after_matched_median_db": round(float(np.nanmedian(after_n[sea])), 2),
        "desert_after_matched_median_db": round(float(np.nanmedian(after_n[land])), 2),
        "sea_after_raw_median_db": round(float(np.nanmedian(after_db[sea])), 2),
        "desert_after_raw_median_db": round(float(np.nanmedian(after_db[land])), 2),
        "sea_pixels": int(np.isfinite(before_db[sea]).sum()), "desert_pixels": int(np.isfinite(before_db[land]).sum()),
    }
    log_(f"T_water {t_water:.2f} dB  T_land {t_land:.2f} dB  separable={separable}  refs {refs}")

    cls = classify(before_db, after_n, delta, t_water, t_land, separable)
    spots = hotspots(cls, grid)
    top = spots[:10]

    # gain-consistency check on unchanged pixels (rule in METHOD['gain_check'])
    diffs = []
    rows, cols = delta.shape
    for i in range(0, rows, t):
        for j in range(0, cols, t):
            b = before_db[i:i + t, j:j + t]
            d = delta[i:i + t, j:j + t]
            ok = np.isfinite(b) & np.isfinite(d) & (cls[i:i + t, j:j + t] == 0)
            if ok.sum() < 500:
                continue
            lo, hi = np.percentile(b[ok], [25, 75])
            diffs.append(float(np.median(d[ok & (b <= lo)]) - np.median(d[ok & (b >= hi)])))
    gain_med = float(np.median(diffs)) if diffs else float("nan")
    gain_ok = bool(np.isfinite(gain_med) and abs(gain_med) <= METHOD["gain_limit_db"])
    log_(f"gain check: median dark-minus-bright delta {gain_med:.2f} dB over {len(diffs)} tiles -> ok={gain_ok}")

    px_ha = abs(float(grid["x"][1] - grid["x"][0])) ** 2 / 10000
    kept = np.zeros_like(cls)
    for h in spots:
        kept[h["_members"][:, 0], h["_members"][:, 1]] = CLASS_CODES[h["class"]]
    area = {name: round(float((kept == code).sum() * px_ha), 1) for name, code in CLASS_CODES.items() if code}
    raw_area = {name: round(float((cls == code).sum() * px_ha), 1) for name, code in CLASS_CODES.items() if code}
    log_(f"area in hotspots (ha): {area}   before the 1 ha cluster filter: {raw_area}   hotspots: {len(spots)}")
    return {"before_db": before_db, "after_db": after_db, "after_n": after_n, "delta": delta, "t_water": t_water,
            "t_land": t_land, "separable": separable, "refs": refs, "cls": cls, "spots": spots, "top": top,
            "gain_med": gain_med, "gain_ok": gain_ok, "diffs": diffs, "kept": kept, "area": area, "raw_area": raw_area,
            "sea": sea, "land": land, "t": t}


def main():
    t0 = time.time()
    before, after = find_passes()
    log(f"before passes: {[p['date'] for p in before]}  after passes: {[p['date'] for p in after]}")
    if not before or not after:
        raise SystemExit("Need at least one finished pass on each side - the case stays 'evidence pending'.")
    passes = before + after
    os.makedirs(KIT_DIR, exist_ok=True)
    os.makedirs(ASSET_DIR, exist_ok=True)

    boxes, window = {}, None
    for p in passes:
        boxes[p["date"]] = read_box(p, window)
        window = boxes[p["date"]]["window"]
        log(f"  read {p['date']}  valid {boxes[p['date']]['valid_share']:.1%}  looks {boxes[p['date']]['looks']}")
    grid = boxes[passes[0]["date"]]

    log("interference check (whole frame)...")
    interference = interference_check(passes, boxes)
    for row in interference:
        log("  ", json.dumps(row))

    # quality control (QC_EXCLUSIONS): flagged passes stay out of the change rule
    for d, why in QC_EXCLUSIONS.items():
        row = next((r for r in interference if r["pass"] == d), None)
        if row is not None and not row["anomaly_over_box"]:
            raise SystemExit(f"{d} is listed in QC_EXCLUSIONS but the interference check did not flag it - stop, do not exclude")
    excluded = [p for p in passes if p["date"] in QC_EXCLUSIONS]
    all_after = after
    before = [p for p in before if p["date"] not in QC_EXCLUSIONS]
    after = [p for p in after if p["date"] not in QC_EXCLUSIONS]
    log(f"used for the change rule: before {[p['date'] for p in before]}  after {[p['date'] for p in after]}  excluded {[p['date'] for p in excluded]}")
    if not before or not after:
        raise SystemExit("After quality control there is no clean pass on one side - the case stays 'evidence pending'.")

    pass_medians = [{"date": p["date"], "side": "excluded (quality control)" if p in excluded else "before" if p in before else "after",
                     "hh_box_median_db": round(float(np.nanmedian(nio.power_to_db(boxes[p["date"]]["hh"]))), 2),
                     "hv_box_median_db": round(float(np.nanmedian(nio.power_to_db(boxes[p["date"]]["hv"]))), 2)} for p in passes]
    A = analyse(boxes, before, after, grid)
    (before_db, after_db, after_n, delta, t_water, t_land, separable, refs, cls, spots, top, gain_med, gain_ok, diffs,
     kept, area, raw_area, sea, land) = (A[k] for k in ("before_db", "after_db", "after_n", "delta", "t_water", "t_land",
     "separable", "refs", "cls", "spots", "top", "gain_med", "gain_ok", "diffs", "kept", "area", "raw_area", "sea", "land"))
    px_ha = abs(float(grid["x"][1] - grid["x"][0])) ** 2 / 10000

    # Cross-checks (same METHOD, nothing tuned): each after-pass on its own against the first
    # before-pass, so a contaminated date can be told apart from a clean one.
    cross_checks = []
    if len(all_after) > 1 or len(before) > 1:
        for p_after in all_after:                       # including excluded passes: this is how they are shown
            C = analyse(boxes, before[:1], [p_after], grid, quiet=True)
            row = next((r for r in interference if r["pass"] == p_after["date"]), None)
            cross_checks.append({"before": before[0]["date"], "after": p_after["date"],
                                 "interference_over_box": row["anomaly_over_box"] if row else None,
                                 "box_hh_change_db": row["HH"]["box_median_change_db"] if row else None,
                                 "frame_hh_change_db": row["HH"]["frame_median_change_db"] if row else None,
                                 "gain_check_db": round(C["gain_med"], 2), "gain_ok": C["gain_ok"],
                                 "candidate_new_structures_ha": C["area"]["new-structures"],
                                 "patches": sum(h["class"] == "new-structures" for h in C["spots"]),
                                 "separable": C["separable"]})
            log("  cross-check", json.dumps(cross_checks[-1]))

    # photo-check kit
    box = nio.case_box(CASE)
    log("choosing photo dates...")
    photo_before, tried_b = pick_photo_date(before[0]["date"], box)
    photo_after, tried_a = pick_photo_date(after[-1]["date"], box)
    log(f"  photo before {photo_before}  after {photo_after}")
    build_kit(top, before_db, after_n, grid, photo_before, photo_after,
              [p["date"] for p in before], [p["date"] for p in after])
    with open(os.path.join(KIT_DIR, "hotspots.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["hotspot", "class", "area_ha", "lat", "lon", "picture"])
        for h in top:
            w.writerow([h["id"], h["class"], h["area_ha"], h["lat"], h["lon"], f"{h['id']}.png"])
    photo = read_photo_check(top)

    # badge (rule fixed in METHOD)
    radar_ok = gain_ok and len(top) > 0
    if photo:
        confirmed, answers, total = photo
        badge = "Strong" if confirmed >= 7 else "Moderate" if confirmed >= 4 else "Weak"
        check_text = f"{confirmed} of {total} hotspots confirmed in NASA HLS photos (judged by eye by a team member)."
    else:
        confirmed, answers, total = None, None, len(top)
        badge = "Moderate" if radar_ok else "Weak"
        check_text = "Photo check pending: a team member is comparing each hotspot with NASA HLS photos."

    n_b, n_a = len(before), len(after)
    robust = n_b >= 3 and n_a >= 3
    any_anomaly = any(r["anomaly_over_box"] for r in interference)
    save_overlay(kept)
    passes_db = {p["date"]: nio.power_to_db(boxes[p["date"]]["hh"]) for p in passes}
    grid_out = save_grid(grid, passes_db, delta, kept, [p["date"] for p in before], [p["date"] for p in after],
                         change_note=None if gain_ok else "Includes a contaminated pass (see the verdict): not a reliable change map yet.")

    corners = {}
    for name, (cx, cy) in {"nw": (0, 0), "ne": (-1, 0), "sw": (0, -1), "se": (-1, -1)}.items():
        lon, lat = nio.utm_to_lonlat(grid["x"][cx], grid["y"][cy], grid["proj"])
        corners[name] = [round(float(lat), 6), round(float(lon), 6)]

    n_new = sum(h["class"] == "new-structures" for h in spots)
    # Display rule (Zaid, 14 Nov 03:54): a radar-only area is shown ONLY if the radar quality check
    # passes. Otherwise the verdict says the pass is contaminated and the area appears only in the
    # chain of custody, labelled "contaminated candidate area".
    if gain_ok:
        measured = [{"label": "New structures (HH rose ≥ 3 dB)", "value": area["new-structures"], "unit": "ha",
                     "note": f"in {n_new} patches of 1 ha or more"}]
    else:
        bad = next((r for r in interference if r["anomaly_over_box"]), interference[-1] if interference else None)
        txt = (f"The {fmt_date(bad['pass'])} pass is contaminated by interference, most likely radio interference "
               f"(box HH {bad['HH']['box_median_change_db']:+.1f} dB while the frame moved {bad['HH']['frame_median_change_db']:+.1f} dB). "
               "A radar-only area isn't reliable yet") if bad else "A radar-only area isn't reliable yet"
        txt += ("; a median of three passes per side is pending." if not (len(before) >= 3 and len(after) >= 3)
                else ", even with a median of three passes per side.")
        measured = [{"label": "New structures", "value": "not reliable yet", "unit": "", "note": txt}]
    if separable:
        measured += [
            {"label": "Water → land", "value": area["water-to-land"], "unit": "ha"},
            {"label": "Land → water", "value": area["land-to-water"], "unit": "ha"},
        ]
    else:
        measured.append({"label": "Water ↔ land", "value": "not separable", "unit": "",
                         "note": "In these images open sea and desert sand are about equally dark in HH (trap 11), so radar alone can't say where water became land."})
    # Passes the interference check flags that are still used: reported, never hidden
    flagged_used = [{"pass": r["pass"], "channels_flagged": [ch for ch in ("HH", "HV") if r[ch]["anomaly_over_box"]],
                     "hh_box_vs_frame_db": [r["HH"]["box_median_change_db"], r["HH"]["frame_median_change_db"]],
                     "hv_box_vs_frame_db": [r["HV"]["box_median_change_db"], r["HV"]["frame_median_change_db"]]}
                    for r in interference if r["anomaly_over_box"] and r["pass"] not in QC_EXCLUSIONS]
    measured.append({"label": "Passes compared", "value": f"{n_b} before · {n_a} after", "unit": "",
                     "note": (f"{', '.join(fmt_date(p['date']) for p in before)} vs {', '.join(fmt_date(p['date']) for p in after)}. "
                              + ("Median of several passes per side." if robust else
                                 "Fewer than 3 passes per side, so a bad date can't be outvoted yet; more passes are downloading.")
                              + (f" Left out: {', '.join(fmt_date(p['date']) for p in excluded)}, flagged by our interference check (quality control, declared before this run)." if excluded else "")
                              + "".join(f" Warning: {fmt_date(f['pass'])} is also flagged, in {' and '.join(f['channels_flagged'])} only "
                                        f"(HV box {f['hv_box_vs_frame_db'][0]:+.1f} dB vs frame {f['hv_box_vs_frame_db'][1]:+.1f} dB); the change rule uses HH, where it moved "
                                        f"{f['hh_box_vs_frame_db'][0]:+.1f} dB vs the frame's {f['hh_box_vs_frame_db'][1]:+.1f} dB, so it is used — but treat this result with care."
                                        for f in flagged_used if "HH" not in f["channels_flagged"]))})
    if any_anomaly:
        flagged = [r for r in interference if r["anomaly_over_box"]]
        measured.append({"label": "Interference check", "value": f"{len(flagged)} of {len(interference)} passes flagged", "unit": "",
                         "note": "; ".join(f"{fmt_date(r['pass'])}: box HH {r['HH']['box_median_change_db']:+.1f} dB vs whole frame "
                                           f"{r['HH']['frame_median_change_db']:+.1f} dB (compared with {fmt_date(r['compared_with'])})" for r in flagged)
                                 + ". We use HH only and remove each date's smooth background."})
    measured.append({"label": "Radar quality check", "value": "passed" if gain_ok else "failed", "unit": "",
                     "note": (f"After removing the background, dark and bright ground changed by similar amounts ({gain_med:+.1f} dB apart)." if gain_ok else
                              f"After removing the background, dark ground still brightened {gain_med:.1f} dB more than bright ground, so the patch adds "
                              "brightness rather than scaling it, and background removal can't fully undo it. Radar alone is not enough here; the photo check decides.")})

    numbers = {
        "case": CASE,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured,
        "check": {"label": "Independent check", "text": check_text},
        "badge": badge,
        "badge_reason": (f"photo check: {confirmed} of {total} confirmed" if photo else
                         "radar only (photo check pending); " + ("radar quality checks passed" if radar_ok else
                          "no hotspots found" if gain_ok else "radar quality check failed (gain check)")),
        "sources": [p["file"] for p in passes],
        "custody_extra": [] if gain_ok else [{"label": "Contaminated candidate area", "value": area["new-structures"], "unit": "ha",
                                              "note": f"pixels where HH rose >= 3 dB, in {n_new} patches >= 1 ha; not shown in the verdict because the radar quality check failed"}],
        "method": METHOD,
        "quality_control": {"excluded_passes": {p["date"]: QC_EXCLUSIONS[p["date"]] for p in excluded}, "declared": QC_DECLARED,
                            "rule": "only the passes listed in excluded_passes (named before this run) are left out of the change rule; they are still read and shown",
                            "flagged_but_used": flagged_used},
        "results": {
            "thresholds": {"T_water_db": round(t_water, 2), "T_land_db": round(t_land, 2), "separable": separable, **refs},
            "area_ha_in_hotspots": area,
            "area_shown_in_verdict": bool(gain_ok),
            "contaminated_candidate_area_ha": None if gain_ok else area["new-structures"],
            "pass_medians": pass_medians,
            "area_ha_before_cluster_filter": raw_area,
            "hotspot_count": len(spots),
            "top10": [{k: v for k, v in h.items() if not k.startswith("_")} for h in top],
            "interference": interference,
            "gain_check": {"median_dark_minus_bright_db": round(gain_med, 2), "tiles": len(diffs), "ok": gain_ok},
            "median_robust": robust,
            "cross_checks": cross_checks,
            "photo_check": {"status": "done" if photo else "pending", "confirmed": confirmed, "total": total,
                            "answers": answers, "before": photo_before, "after": photo_after},
            "coherence_check": "not available: no NISAR interferogram on hand covers this box",
        },
        "files": {"overlay": "assets/cases/jebel-ali/change_overlay.png", "overlay_corners_latlon": corners,
                  "grid": "assets/cases/jebel-ali/grid.json"},
        "provenance": {
            "nasa_files": [{k: p[k] for k in ("file", "date", "start", "direction", "track", "frame", "product_version", "processing")} for p in passes],
            "collection": "NISAR L2 GCOV (ASF DAAC)",
            "layers": [f"{GRID}/{n}" for n in METHOD["layers"]],
            "box_lonlat": list(box), "box_rows_cols": list(window),
            "projection_epsg": grid["proj"]["epsg"], "pixel_m_after_filter": abs(float(grid["x"][1] - grid["x"][0])),
            "number_of_looks_native": grid["looks"],
            "steps": ["read only the box rows/columns", "mask invalid pixels", "3x3 multilook (linear power)", "dB",
                      "interference check (whole-frame sample)", "leave out passes flagged by the interference check (quality_control)", "median per side", "2 km tile background removed",
                      "classify (method.classes)", "8-connected clusters >= 12 px", "top 10 by area",
                      "photo kit from NASA GIBS HLS", "badge (method.badge_rule)"],
            "photo_layers": [photo_before, photo_after],
            "photo_dates_tried": {"before": tried_b, "after": tried_a},
            "script": "tools/process_jebel_ali.py", "script_version": SCRIPT_VERSION,
            "script_sha256": sha256(os.path.abspath(__file__)),
            "helpers_sha256": sha256(os.path.join(nio.HERE, "nisar_io.py")),
        },
    }
    with open(NUMBERS, "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(numbers), f, indent=1, ensure_ascii=False, allow_nan=False)
    log(f"wrote {NUMBERS}  badge={badge}  grid {grid_out['rows']}x{grid_out['cols']} merge {grid_out['merge']}")

    # arrays kept OUTSIDE the repo so checkpoint C can draw evidence images from the same numbers
    np.savez_compressed(os.path.join(KIT_DIR, "arrays.npz"), before_db=before_db, after_db=after_db,
                        after_n=after_n, delta=delta, cls=cls, kept=kept,
                        hv_before=nio.power_to_db(boxes[before[0]["date"]]["hv"]),
                        hv_after=nio.power_to_db(boxes[after[-1]["date"]]["hv"]),
                        x=grid["x"], y=grid["y"], epsg=grid["proj"]["epsg"],
                        sea_rc=np.array([sea[0].start, sea[0].stop, sea[1].start, sea[1].stop]),
                        land_rc=np.array([land[0].start, land[0].stop, land[1].start, land[1].stop]),
                        t_water=t_water, t_land=t_land,
                        dates=np.array([p["date"] for p in passes]),
                        **{f"hh_{p['date']}": nio.power_to_db(boxes[p["date"]]["hh"]) for p in passes})
    update_results.update()
    log(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
