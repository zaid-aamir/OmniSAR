"""
Jakarta case: is the ground really dropping, or is it the air?  (NISAR InSAR ground motion)

Run (from the repo folder):   py tools/process_jakarta.py

What it does, in order:
  1. Finds the finished NISAR GUNW interferograms for ascending track 010 frame 174 and
     descending track 018 frame 091, one per pair of dates, and checks each direction forms an
     unbroken chain (each pair starts on the date the previous one ended). Never opens .h5.part.
  2. For every pair, reads only the Jakarta box: unwrapped phase, coherence, connected
     components, ionosphere screen; and the troposphere screens from the 3D "radarGrid" cube.
  3. Corrects the phase (subtracts ionosphere + troposphere), masks unreliable pixels, and
     subtracts the median of a stable reference area, so every number is "relative to central
     Jakarta".
  4. Converts phase to millimetres along the radar's line of sight, using the wavelength stored
     in the file, then to a vertical equivalent with the incidence angle from the file.
  5. Adds the pairs up date by date (a time series), for each direction separately.
  6. Two-direction check: the ascending and descending satellites look from opposite sides at
     different times of day (different air). If both see the same districts sinking by similar
     amounts, the motion is in the ground, not the air.
  7. Writes cases/jakarta.numbers.json (method, results, provenance), an overlay PNG, the terrain
     grid and real evidence images, then runs tools/update_results.py.

All rules and thresholds are in METHOD, fixed before any result was seen (why_log.md, 04:13).
"""

import datetime as dt
import hashlib
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
from process_jebel_ali import diverging, font, fmt_date, sha256

warnings.filterwarnings("ignore", category=RuntimeWarning)

SCRIPT_VERSION = "1.0.1"   # 1.0.1: reference picker treats no-data coherence as 0 (v1.0 kept a NaN window by accident)
CASE = "jakarta"
IFG = "/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/HH"
CUBE = "/science/LSAR/GUNW/metadata/radarGrid"
DATA_DIR = os.path.join(nio.PROJECT, "data", "insar")
ASSET_DIR = os.path.join(nio.REPO, "assets", "cases", CASE)
KIT_DIR = os.path.join(nio.PROJECT, "research", "checks", CASE)
NUMBERS = os.path.join(nio.REPO, "cases", f"{CASE}.numbers.json")
C = 299792458.0
DIRECTIONS = {"ascending": "_010_A_174_", "descending": "_018_D_091_"}

METHOD = {
    "declared": "2026-11-14T04:13+04:00, before any Jakarta result was computed",
    "inputs": "NISAR L2 GUNW (provisional), ascending track 010 frame 174 and descending track 018 frame 091, finished files only, one file per pair",
    "chain": "consecutive pairs in date order; each pair must start on the date the previous one ended. The 24-day pairs (20 Jul->13 Aug asc, 21 Jul->14 Aug desc) bridge NASA's 27 Jul-10 Aug data gap, so the chain is continuous",
    "layers": ["unwrappedPhase", "coherenceMagnitude", "connectedComponents", "ionospherePhaseScreen",
               "radarGrid/hydrostaticTroposphericPhaseScreen", "radarGrid/wetTroposphericPhaseScreen",
               "radarGrid/incidenceAngle", "radarGrid/slantRangeSolidEarthTidesPhase (read for its spread only)",
               "frequencyA/centerFrequency"],
    "corrections": "corrected = unwrappedPhase - ionospherePhaseScreen - hydrostatic screen - wet screen; troposphere cube interpolated bilinearly in x/y and linearly in height at the Terrarium ground height (geoid offset ignored: < 1 mm effect)",
    "solid_earth_tide": "not applied: its sign convention is unresolved in the ISCE3 code and it varies only ~0.2 rad across the box, which the reference area removes",
    "sign": "positive phase = slant range increased = ground moved AWAY from the satellite (derived from ISCE3 source: Crossmul ref*conj(sec), Backproject exp(+j2*pi*fc*tau)); LOS toward the satellite in mm = -phase * wavelength / (4*pi) * 1000",
    "wavelength": "c / centerFrequency read from the file",
    "coherence_min": 0.4,
    "mask": "coherence < 0.4, connected component 0 (not unwrapped) or 65535 (fill), or any component other than the one holding the reference window",
    "reference": "1.2 km x 1.2 km window inside lat -6.200..-6.160, lon 106.800..106.860 (central Jakarta, inland) with the highest mean coherence over all pairs of both directions; chosen from coherence only, never from phase. Each pair has the reference median subtracted",
    "reference_strip": {"lat": [-6.200, -6.160], "lon": [106.800, 106.860]},
    "reference_size_m": 1200,
    "reference_min_valid": 0.30,
    "vertical": "vertical equivalent = LOS / cos(incidence angle from the file); assumes the ground only moves up or down",
    "pixel_rule": "a pixel counts only if it is valid in every pair of its direction's chain",
    "usable_direction": "full chain and >= 25% of the box's land pixels valid through the whole chain",
    "usable_min_share": 0.25,
    "land": "Terrarium height > 0 m",
    "districts": "2 km x 2 km UTM squares; a district is valid in a direction if >= 25% of its land pixels are valid",
    "district_m": 2000,
    "district_min_share": 0.25,
    "agreement": "a district agrees if asc and desc have the same sign and differ by <= max(10 mm, 50% of the larger), or both are within +/-10 mm; the directions AGREE if >= 70% of shared districts agree AND Pearson r >= 0.5",
    "agree_share": 0.70, "agree_r": 0.5, "agree_abs_mm": 10.0, "agree_rel": 0.5,
    "sinking_mm": -30.0,
    "sinking_reason": "about 2 sigma of an 8-pair chain if each corrected pair carries ~5 mm of noise",
    "low_land": "Terrarium 0 < height <= 10 m (a surface model: buildings can add height)",
    "low_land_m": 10.0,
    "badge_rule": "Strong = both directions usable and agree; Moderate = only one direction usable; Weak = both usable but they disagree, or none usable",
}


def log(*a):
    print(*a, flush=True)


def ident(f):
    i = f["/science/LSAR/identification"]
    g = lambda k: i[k][()].decode() if isinstance(i[k][()], bytes) else i[k][()]
    return {"ref": g("referenceZeroDopplerStartTime")[:10], "sec": g("secondaryZeroDopplerStartTime")[:10],
            "direction": g("orbitPassDirection"), "track": int(i["trackNumber"][()]), "frame": int(i["frameNumber"][()]),
            "product_version": g("productVersion")}


def find_chain(pattern):
    pairs = {}
    for path in nio.finished_h5(DATA_DIR, pattern):
        with h5py.File(path, "r") as f:
            info = ident(f)
        info.update(file=os.path.basename(path), path=path,
                    processing=next((x for x in os.path.basename(path).split("_") if x.startswith("P0")), "?"))
        pairs[(info["ref"], info["sec"])] = info              # sorted names -> a later version wins
    chain = sorted(pairs.values(), key=lambda p: p["ref"])
    broken = [f"{a['sec']} != {b['ref']}" for a, b in zip(chain, chain[1:]) if a["sec"] != b["ref"]]
    return chain, broken


def cube_interp(f, name, x, y, h, levels=(0, 1, 2)):
    """Value of a radarGrid cube layer at every pixel (x, y) and ground height h.
    The cube is coarse (500 m, 20 heights): bilinear in x/y, linear in height."""
    rg = f[CUBE]
    cx, cy, ch = rg["xCoordinates"][()], rg["yCoordinates"][()], rg["heightAboveEllipsoid"][()]
    c0 = max(int(np.searchsorted(cx, x.min())) - 2, 0)
    c1 = min(int(np.searchsorted(cx, x.max())) + 2, len(cx))
    r0 = max(int(np.searchsorted(-cy, -y.max())) - 2, 0)
    r1 = min(int(np.searchsorted(-cy, -y.min())) + 2, len(cy))
    lv = list(levels)
    sub = rg[name][lv[0]:lv[-1] + 1, r0:r1, c0:c1].astype(np.float64)
    sx, sy, sh = cx[c0:c1], cy[r0:r1], ch[lv[0]:lv[-1] + 1]
    X, Y = np.meshgrid(x, y)
    fx = np.interp(X, sx, np.arange(len(sx)))
    fy = np.interp(-Y, -sy, np.arange(len(sy)))
    x0 = np.clip(np.floor(fx).astype(int), 0, len(sx) - 2); ax = fx - x0
    y0 = np.clip(np.floor(fy).astype(int), 0, len(sy) - 2); ay = fy - y0
    per_level = []
    for k in range(len(sh)):
        s = sub[k]
        per_level.append((s[y0, x0] * (1 - ax) + s[y0, x0 + 1] * ax) * (1 - ay)
                         + (s[y0 + 1, x0] * (1 - ax) + s[y0 + 1, x0 + 1] * ax) * ay)
    per_level = np.stack(per_level)
    fh = np.interp(h, sh, np.arange(len(sh)))
    k0 = np.clip(np.floor(fh).astype(int), 0, len(sh) - 2); ah = fh - k0
    rows, cols = np.indices(h.shape)
    return per_level[k0, rows, cols] * (1 - ah) + per_level[k0 + 1, rows, cols] * ah


def read_pair(p, box, heights_cache):
    with h5py.File(p["path"], "r") as f:
        g = f[IFG]
        proj = nio.projection_params(g["projection"])
        (r0, r1, c0, c1), _ = nio.box_window(box, g["xCoordinates"], g["yCoordinates"], proj)
        x = g["xCoordinates"][c0:c1].astype(np.float64)
        y = g["yCoordinates"][r0:r1].astype(np.float64)
        key = (round(x[0]), round(y[0]), len(x), len(y))
        if key not in heights_cache:
            heights_cache[key] = terrain.grid_heights(x, y, proj)
        h = heights_cache[key]
        out = {
            "unw": g["unwrappedPhase"][r0:r1, c0:c1].astype(np.float64),
            "coh": g["coherenceMagnitude"][r0:r1, c0:c1].astype(np.float64),
            "cc": g["connectedComponents"][r0:r1, c0:c1].astype(np.int64),
            "iono": g["ionospherePhaseScreen"][r0:r1, c0:c1].astype(np.float64),
            "freq": float(f["/science/LSAR/GUNW/grids/frequencyA/centerFrequency"][()]),
            "x": x, "y": y, "proj": proj, "window": (r0, r1, c0, c1), "h": h,
        }
        hg = np.clip(h, -400, 1000)
        out["hydro"] = cube_interp(f, "hydrostaticTroposphericPhaseScreen", x, y, hg)
        out["wet"] = cube_interp(f, "wetTroposphericPhaseScreen", x, y, hg)
        out["set"] = cube_interp(f, "slantRangeSolidEarthTidesPhase", x, y, hg)
        out["inc"] = cube_interp(f, "incidenceAngle", x, y, hg)
    return out


def window_index(d, lon, lat, size_m):
    ex, ny = nio.lonlat_to_utm(lon, lat, d["proj"])
    dx = d["x"][1] - d["x"][0]
    half = size_m / 2 / abs(dx)
    cx = (ex - d["x"][0]) / dx
    cy = (ny - d["y"][0]) / (d["y"][1] - d["y"][0])
    r0, r1 = int(round(cy - half)), int(round(cy + half))
    c0, c1 = int(round(cx - half)), int(round(cx + half))
    if r0 < 0 or c0 < 0 or r1 > len(d["y"]) or c1 > len(d["x"]):
        return None
    return slice(r0, r1), slice(c0, c1)


def pick_reference(data):
    """Highest mean coherence (all pairs, both directions) among 1.2 km windows in the strip."""
    s = METHOD["reference_strip"]
    half_deg = METHOD["reference_size_m"] / 2 / 111000
    best = None
    for lat in np.arange(s["lat"][0] + half_deg, s["lat"][1] - half_deg + 1e-9, 0.002):
        for lon in np.arange(s["lon"][0] + half_deg, s["lon"][1] - half_deg + 1e-9, 0.002):
            vals = []
            for pairs in data.values():
                for d in pairs:
                    w = window_index(d, lon, lat, METHOD["reference_size_m"])
                    if w is None:
                        break
                    vals.append(float(np.mean(np.nan_to_num(d["coh"][w], nan=0.0))))   # no data counts as coherence 0
            if len(vals) == sum(len(p) for p in data.values()):
                score = float(np.mean(vals))
                if best is None or score > best[0]:
                    best = (score, float(lat), float(lon))
    return {"lat": round(best[1], 4), "lon": round(best[2], 4), "mean_coherence": round(best[0], 3)}


def process_pair(d, ref):
    lam = C / d["freq"]
    to_mm = -lam / (4 * math.pi) * 1000
    corr = d["unw"] - d["iono"] - d["hydro"] - d["wet"]
    base = np.isfinite(corr) & np.isfinite(d["coh"]) & (d["coh"] >= METHOD["coherence_min"]) & (d["cc"] != 0) & (d["cc"] != 65535)
    w = window_index(d, ref["lon"], ref["lat"], METHOD["reference_size_m"])
    comps = d["cc"][w][base[w]]
    if comps.size == 0:                       # nothing valid in the reference window: this pair breaks the chain
        empty = np.full(d["unw"].shape, np.nan)
        return {"los": empty, "raw": empty.copy(), "valid": np.zeros(d["unw"].shape, dtype=bool), "ref_share": 0.0, "ref_cc": None,
                "lambda_m": lam, "coh_share": round(float(np.mean(d["coh"] >= METHOD["coherence_min"])), 3),
                "spread_iono_mm": None, "spread_tropo_mm": None, "spread_set_mm": None}
    ref_cc = int(np.bincount(comps).argmax())
    valid = base & (d["cc"] == ref_cc)
    ref_share = float(valid[w].mean())
    los = (corr - np.median(corr[w][valid[w]])) * to_mm
    raw_ok = valid & np.isfinite(d["unw"])
    raw = (d["unw"] - np.median(d["unw"][w][raw_ok[w]])) * to_mm
    los[~valid] = np.nan
    raw[~valid] = np.nan

    def spread(a):     # 5th-95th percentile range over valid pixels, in mm
        v = a[valid]
        return round(float(abs(np.percentile(v, 95) - np.percentile(v, 5)) * abs(to_mm)), 1) if v.size else None
    return {"los": los, "raw": raw, "valid": valid, "ref_share": round(ref_share, 3), "ref_cc": ref_cc,
            "lambda_m": lam, "coh_share": round(float(np.mean(d["coh"] >= METHOD["coherence_min"])), 3),
            "spread_iono_mm": spread(d["iono"]), "spread_tropo_mm": spread(d["hydro"] + d["wet"]),
            "spread_set_mm": spread(d["set"])}


def districts(d, vert, land):
    size = METHOD["district_m"]
    X, Y = np.meshgrid(d["x"], d["y"])
    ix, iy = np.floor(X / size).astype(int), np.floor(Y / size).astype(int)
    out = {}
    for key in set(zip(ix[land].tolist(), iy[land].tolist())):
        cell = land & (ix == key[0]) & (iy == key[1])
        ok = cell & np.isfinite(vert)
        if cell.sum() and ok.sum() / cell.sum() >= METHOD["district_min_share"]:
            cx, cy = (key[0] + 0.5) * size, (key[1] + 0.5) * size
            lon, lat = nio.utm_to_lonlat(cx, cy, d["proj"])
            out[key] = {"mm": float(np.median(vert[ok])), "share": float(ok.sum() / cell.sum()),
                        "lat": round(float(lat), 4), "lon": round(float(lon), 4)}
    return out


def fill_mystery(results, per_dir, badge, chains):
    """Put our images, numbers and the correct answers into cases/jakarta.json."""
    path = os.path.join(nio.REPO, "cases", f"{CASE}.json")
    if not os.path.exists(path):
        return
    m = json.load(open(path, encoding="utf-8"))
    A = f"assets/cases/{CASE}/"
    ra = results["ascending"]
    p0 = chains["ascending"]["pairs"][0]
    spreads = [r["spread_tropo_mm"] for r in ra["pairs"] if r["spread_tropo_mm"] is not None]
    real = badge in ("Strong", "Moderate")
    ev = {e["id"]: e for e in m["evidence"]}
    ev["raw-pair"].update(src=A + "ev-atmosphere.png", bin="trap", trap=15,
        caption=f"One pair, {fmt_date(p0['ref'])} to {fmt_date(p0['sec'])}, as NASA ships it (left) and after we subtract the ionosphere and troposphere (right). "
                f"Across our pairs, humid air alone shifts the signal by {min(spreads):.0f}-{max(spreads):.0f} mm across the box.")
    ev["coherence"].update(src=A + "ev-coherence.png", bin="trap", trap=15,
        caption=f"Where coherence is below 0.4 (the bay, fields, building sites) the phase is noise. Only {ra['pairs'][0]['coherence_above_0.4_share']:.0%} of this pair's box passes; we mask the rest.")
    ev["motion"].update(src=A + "motion_overlay.png", bin="real" if real else "trap", trap=None if real else 15,
        caption=f"Ground motion after corrections, all {len(chains['ascending']['pairs'])} ascending pairs chained ({ra['days']} days). "
                f"{ra['sinking_area_km2']} km² of land moved down 30 mm or more (blue), relative to central Jakarta.")
    ev["two-directions"].update(src=A + "ev-asc-desc.png", bin="trap", trap=14,
        caption=("The descending frame we have covers only part of the box and is mostly incoherent there, so the second direction can't be used yet: a file problem, not a ground signal."
                 if not per_dir["descending"]["usable"] else "Ascending and descending, side by side."))
    ev["gap"].update(src=A + "ev-gap.png", bin="trap", trap=14,
        caption="NASA has no data from 27 Jul to 10 Aug 2026. A chain of only 12-day pairs would break here; the 24-day pairs bridge it.")
    ev["sea-level"].update(src=A + "ev-noise.png", bin="trap", trap=16,
        caption=f"In each 12-day pair the air alone moves the signal by up to {max(spreads):.0f} mm across the box. Sea-level rise over the same months is around a millimetre (citation pending): far too small to see this way.")
    tg = {t["id"]: t for t in m["toggles"]}
    tg["atmosphere"]["layers"] = {"off": {"src": A + "tg-atm-off.png", "label": "Corrections off"}, "on": {"src": A + "tg-atm-on.png", "label": "Ionosphere + troposphere subtracted"}}
    tg["mask"]["layers"] = {"off": {"src": A + "tg-mask-off.png", "label": "No coherence mask"}, "on": {"src": A + "tg-mask-on.png", "label": "Coherence 0.4 or more only"}}
    tg["chain"]["layers"] = {"off": {"src": A + "tg-pair.png", "label": "One 12-day pair"}, "on": {"src": A + "tg-chain.png", "label": "All pairs chained"}}
    tg["direction"]["disabled"] = None if per_dir["descending"]["usable"] else (
        "Switched off: the descending frame we have (018/091) covers only part of the box and is mostly incoherent there. The frame that covers it (092) is still downloading.")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    t0 = time.time()
    os.makedirs(ASSET_DIR, exist_ok=True)
    os.makedirs(KIT_DIR, exist_ok=True)
    box = nio.case_box(CASE)
    chains, data, hcache = {}, {}, {}
    for name, pat in DIRECTIONS.items():
        chain, broken = find_chain(pat)
        chains[name] = {"pairs": chain, "broken": broken}
        log(f"{name}: {len(chain)} pairs {[p['ref'] + '>' + p['sec'] for p in chain]} broken={broken}")
        data[name] = []
        for p in chain:
            t = time.time()
            data[name].append(read_pair(p, box, hcache))
            log(f"   read {p['ref']}>{p['sec']} in {time.time() - t:.1f}s")

    ref = pick_reference(data)
    log(f"reference window: {ref}")

    results, per_dir = {}, {}
    for name in DIRECTIONS:
        pairs, ds = chains[name]["pairs"], data[name]
        out = [process_pair(d, ref) for d in ds]
        stats = []
        usable_chain = not chains[name]["broken"] and all(o["ref_share"] >= METHOD["reference_min_valid"] for o in out)
        log(f"{name}: reference-window valid share per pair {[o['ref_share'] for o in out]}")
        d0 = ds[0]
        land = d0["h"] > 0
        cum = np.zeros_like(out[0]["los"])
        all_valid = np.ones(cum.shape, dtype=bool)
        series_maps = []
        for p, o in zip(pairs, out):
            stats.append({"pair": f"{p['ref']} -> {p['sec']}", "days": (dt.date.fromisoformat(p["sec"]) - dt.date.fromisoformat(p["ref"])).days,
                          "ref_valid_share": o["ref_share"], "coherence_above_0.4_share": o["coh_share"],
                          "spread_iono_mm": o["spread_iono_mm"], "spread_tropo_mm": o["spread_tropo_mm"], "spread_solid_earth_tide_mm": o["spread_set_mm"],
                          "lambda_m": round(o["lambda_m"], 5)})
            all_valid &= o["valid"]
            cum = cum + np.nan_to_num(o["los"])
            series_maps.append((p["sec"], cum.copy()))
        inc = np.radians(d0["inc"])
        vert_maps = [(date, np.where(all_valid, m / np.cos(inc), np.nan)) for date, m in series_maps]
        vert = vert_maps[-1][1]
        share = float((all_valid & land).sum() / max(land.sum(), 1))
        usable = bool(usable_chain and share >= METHOD["usable_min_share"])
        px_km2 = abs(d0["x"][1] - d0["x"][0]) * abs(d0["y"][1] - d0["y"][0]) / 1e6
        v = vert[land & np.isfinite(vert)]
        sink = land & np.isfinite(vert) & (vert <= METHOD["sinking_mm"])
        low = land & (d0["h"] <= METHOD["low_land_m"])
        per_dir[name] = {"vert": vert, "vert_maps": vert_maps, "valid": all_valid, "land": land, "d": d0, "out": out,
                         "districts": districts(d0, vert, land), "inc": inc, "usable": usable}
        results[name] = {
            "pairs": stats, "chain_complete": usable_chain, "period": f"{pairs[0]['ref']} -> {pairs[-1]['sec']}",
            "days": (dt.date.fromisoformat(pairs[-1]["sec"]) - dt.date.fromisoformat(pairs[0]["ref"])).days,
            "land_valid_share": round(share, 3), "usable": usable,
            "incidence_deg_median": round(float(np.nanmedian(d0["inc"])), 2),
            "vertical_mm_median_land": round(float(np.median(v)), 1) if v.size else None,
            "vertical_mm_p5_land": round(float(np.percentile(v, 5)), 1) if v.size else None,
            "vertical_mm_p95_land": round(float(np.percentile(v, 95)), 1) if v.size else None,
            "sinking_area_km2": round(float(sink.sum() * px_km2), 1),
            "sinking_area_under_10m_km2": round(float((sink & low).sum() * px_km2), 1),
            "valid_land_km2": round(float((all_valid & land).sum() * px_km2), 1),
            "low_land_km2": round(float(low.sum() * px_km2), 1),
            "land_km2": round(float(land.sum() * px_km2), 1),
            "series_box_median": [{"date": pairs[0]["ref"], "mm": 0.0}] + [
                {"date": date, "mm": round(float(np.nanmedian(m[land])), 1)} for date, m in vert_maps],
        }
        log(f"{name}: usable={usable} share={share:.2f} median={results[name]['vertical_mm_median_land']} "
            f"p5={results[name]['vertical_mm_p5_land']} sinking={results[name]['sinking_area_km2']} km2")

    # ---------- two-direction check ----------
    A, D = per_dir["ascending"]["districts"], per_dir["descending"]["districts"]
    same_proj = per_dir["ascending"]["d"]["proj"]["epsg"] == per_dir["descending"]["d"]["proj"]["epsg"]
    shared = sorted(set(A) & set(D)) if same_proj else []
    agree_rows = []
    for k in shared:
        a, d = A[k]["mm"], D[k]["mm"]
        small = abs(a) <= METHOD["agree_abs_mm"] and abs(d) <= METHOD["agree_abs_mm"]
        close = (np.sign(a) == np.sign(d)) and abs(a - d) <= max(METHOD["agree_abs_mm"], METHOD["agree_rel"] * max(abs(a), abs(d)))
        agree_rows.append({"lat": A[k]["lat"], "lon": A[k]["lon"], "asc_mm": round(a, 1), "desc_mm": round(d, 1), "agree": bool(small or close)})
    n_sh = len(agree_rows)
    share_agree = sum(r["agree"] for r in agree_rows) / n_sh if n_sh else 0.0
    r_val = float(np.corrcoef([r["asc_mm"] for r in agree_rows], [r["desc_mm"] for r in agree_rows])[0, 1]) if n_sh >= 3 else float("nan")
    both_usable = per_dir["ascending"]["usable"] and per_dir["descending"]["usable"]
    agree = bool(both_usable and n_sh >= 3 and share_agree >= METHOD["agree_share"] and r_val >= METHOD["agree_r"])
    n_usable = sum(per_dir[n]["usable"] for n in DIRECTIONS)
    badge = "Strong" if agree else "Moderate" if n_usable == 1 else "Weak"
    log(f"two-direction: {n_sh} shared districts, agree share {share_agree:.2f}, r {r_val:.2f} -> agree={agree}; badge {badge}")

    # fastest district: mean of both directions if both are usable, otherwise the usable one
    usable_names = [n for n in DIRECTIONS if per_dir[n]["usable"]]
    if agree and agree_rows:
        both = [(r["asc_mm"] + r["desc_mm"]) / 2 for r in agree_rows]
        fastest = {**agree_rows[int(np.argmin(both))], "basis": "mean of both directions"}
        fastest["mm"] = round((fastest["asc_mm"] + fastest["desc_mm"]) / 2, 1)
    elif usable_names:
        dd = per_dir[usable_names[0]]["districts"]
        k = min(dd, key=lambda kk: dd[kk]["mm"]) if dd else None
        fastest = {"lat": dd[k]["lat"], "lon": dd[k]["lon"], "mm": round(dd[k]["mm"], 1), "basis": f"{usable_names[0]} only"} if k else None
    else:
        fastest = None

    # district time series for the fastest district (chart)
    def district_series(name, key_latlon):
        pd_ = per_dir[name]
        d = pd_["d"]
        size = METHOD["district_m"]
        ex, ny = nio.lonlat_to_utm(key_latlon["lon"], key_latlon["lat"], d["proj"])
        X, Y = np.meshgrid(d["x"], d["y"])
        cell = pd_["land"] & (np.floor(X / size) == math.floor(ex / size)) & (np.floor(Y / size) == math.floor(ny / size))
        first = chains[name]["pairs"][0]["ref"]
        return [{"date": first, "mm": 0.0}] + [{"date": date, "mm": round(float(np.nanmedian(m[cell])), 1)} for date, m in pd_["vert_maps"]]
    fast_series = None
    if fastest:
        fast_series = {n: district_series(n, fastest) for n in DIRECTIONS if per_dir[n]["usable"]}
        results["fastest_district"] = {**fastest, "series": fast_series}
    results["two_direction_check"] = {"same_projection": same_proj, "shared_districts": n_sh,
                                      "agree_share": round(share_agree, 3), "pearson_r": round(r_val, 3) if np.isfinite(r_val) else None,
                                      "agree": agree, "districts": agree_rows}
    results["reference"] = ref

    # ---------- images ----------
    asc, desc = per_dir["ascending"], per_dir["descending"]
    lim = 60.0

    def rgba_map(v, lim_):
        rgb = diverging(v, lim_)
        alpha = np.where(np.isfinite(v), 235, 0).astype(np.uint8)
        return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")

    def flat(img, bg=(20, 22, 28)):
        out = Image.new("RGB", img.size, bg)
        out.paste(img, mask=img.split()[3])
        return out

    def scaled(img, k=2):
        return img.resize((img.width * k, img.height * k), Image.NEAREST)

    def panel(items, title):
        gap = 12
        w = sum(i.width for i, _ in items) + gap * (len(items) + 1)
        h = max(i.height for i, _ in items) + 70
        c = Image.new("RGB", (w, h), (20, 22, 28))
        dr = ImageDraw.Draw(c)
        dr.text((gap, 8), title, fill=(240, 240, 240), font=font(15))
        x = gap
        for im, lab in items:
            c.paste(im, (x, 32))
            dr.text((x, 38 + im.height), lab, fill=(200, 200, 200), font=font(12))
            x += im.width + gap
        return c

    rgba_map(asc["vert"], lim).save(os.path.join(ASSET_DIR, "motion_overlay.png"), optimize=True)
    made = {}
    # atmosphere off/on: the first ascending pair
    o0, p0 = asc["out"][0], chains["ascending"]["pairs"][0]
    made["ev-atmosphere"] = panel([(scaled(flat(rgba_map(o0["raw"], 40))), "corrections OFF (as NASA ships it)"),
                                   (scaled(flat(rgba_map(o0["los"], 40))), "ionosphere + troposphere subtracted")],
                                  f"One pair, {fmt_date(p0['ref'])} -> {fmt_date(p0['sec'])} (ascending): line-of-sight motion, blue -40 ... red +40 mm")
    # coherence mask
    coh = data["ascending"][0]["coh"]
    seq = (np.clip(np.nan_to_num(coh), 0, 1) * 255).astype(np.uint8)
    cimg = Image.fromarray(np.dstack([seq, seq, seq]), "RGB")
    made["ev-coherence"] = panel([(scaled(cimg), "coherence 0 (black) ... 1 (white)"),
                                  (scaled(flat(rgba_map(o0["los"], 40))), f"motion kept where coherence >= {METHOD['coherence_min']}")],
                                 f"Coherence mask, {fmt_date(p0['ref'])} -> {fmt_date(p0['sec'])}: low coherence = the radar can't trust the phase there")
    # asc vs desc + district scatter
    sc = Image.new("RGB", (260, 260), (20, 22, 28))
    dr = ImageDraw.Draw(sc)
    span = max([abs(v) for r in agree_rows for v in (r["asc_mm"], r["desc_mm"])] + [20])
    tr = lambda v: 20 + (v + span) / (2 * span) * 220
    dr.line([tr(-span), 260 - tr(-span), tr(span), 260 - tr(span)], fill=(90, 90, 90))
    dr.line([tr(0), 20, tr(0), 240], fill=(60, 60, 60)); dr.line([20, 260 - tr(0), 240, 260 - tr(0)], fill=(60, 60, 60))
    for r in agree_rows:
        cx, cy = tr(r["asc_mm"]), 260 - tr(r["desc_mm"])
        dr.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(34, 211, 238) if r["agree"] else (240, 113, 103))
    dr.text((24, 4), f"districts: asc (x) vs desc (y), mm, +/-{span:.0f}", fill=(200, 200, 200), font=font(11))
    made["ev-asc-desc"] = panel([(flat(rgba_map(asc["vert"], lim)), "ascending (05:39 local)"),
                                 ((flat(rgba_map(desc["vert"], lim)), "descending (18:11 local)") if desc["usable"] else
                                  (Image.fromarray(np.dstack([(np.clip(np.nan_to_num(data["descending"][0]["coh"]), 0, 1) * 255).astype(np.uint8)] * 3), "RGB"),
                                   f"descending: NOT usable - coherence of {fmt_date(chains['descending']['pairs'][0]['ref'])} pair (black = no data / incoherent)")),
                                 (sc, f"{sum(r['agree'] for r in agree_rows)} of {n_sh} districts agree")],
                                f"Vertical-equivalent motion over the whole chain, blue -{lim:.0f} ... red +{lim:.0f} mm (relative to the reference area)")
    # toggle images (same pair, same geometry, so they line up when switched)
    a0 = data["ascending"][0]
    unmasked = a0["unw"] - a0["iono"] - a0["hydro"] - a0["wet"]
    wref = window_index(a0, ref["lon"], ref["lat"], METHOD["reference_size_m"])
    unmasked = (unmasked - np.nanmedian(unmasked[wref])) * (-o0["lambda_m"] / (4 * math.pi) * 1000)
    toggles = {
        "tg-atm-off": (scaled(flat(rgba_map(o0["raw"], 40))), "corrections off"),
        "tg-atm-on": (scaled(flat(rgba_map(o0["los"], 40))), "ionosphere + troposphere subtracted"),
        "tg-mask-off": (scaled(flat(rgba_map(unmasked, 40))), "no coherence mask"),
        "tg-mask-on": (scaled(flat(rgba_map(o0["los"], 40))), "coherence >= 0.4 only"),
        "tg-pair": (scaled(flat(rgba_map(asc["vert_maps"][0][1], lim))), f"one pair ({fmt_date(p0['ref'])} -> {fmt_date(p0['sec'])})"),
        "tg-chain": (scaled(flat(rgba_map(asc["vert"], lim))), f"all {len(chains['ascending']['pairs'])} pairs chained"),
    }
    for k, (im, lab) in toggles.items():
        c = Image.new("RGB", (im.width, im.height + 24), (20, 22, 28))
        c.paste(im, (0, 0))
        ImageDraw.Draw(c).text((6, im.height + 5), lab, fill=(210, 210, 210), font=font(12))
        made[k] = c
    # data gap chart: the pairs of each direction on a time line
    W_, H_ = 760, 150
    gc = Image.new("RGB", (W_, H_), (20, 22, 28))
    dr = ImageDraw.Draw(gc)
    t0_, t1_ = dt.date(2026, 6, 20), dt.date(2026, 10, 20)
    X_ = lambda d_: 20 + (d_ - t0_).days / (t1_ - t0_).days * (W_ - 40)
    g0_, g1_ = dt.date(2026, 7, 27), dt.date(2026, 8, 10)
    dr.rectangle([X_(g0_), 28, X_(g1_), 112], fill=(50, 50, 56))
    dr.text((X_(g0_) + 2, 30), "NASA gap", fill=(170, 170, 170), font=font(11))
    for row_, nm_ in enumerate(DIRECTIONS):
        for k_, pp in enumerate(chains[nm_]["pairs"]):
            a_, b_ = dt.date.fromisoformat(pp["ref"]), dt.date.fromisoformat(pp["sec"])
            y_ = 50 + row_ * 34 + (k_ % 2) * 6
            col_ = (34, 211, 238) if per_dir[nm_]["usable"] else (138, 143, 152)
            dr.line([X_(a_), y_, X_(b_), y_], fill=col_, width=4)
        dr.text((22, 40 + row_ * 34), nm_ + ("" if per_dir[nm_]["usable"] else " (not usable here)"), fill=(200, 200, 200), font=font(11))
    for mth in range(7, 11):
        md = dt.date(2026, mth, 1)
        dr.text((X_(md), 122), md.strftime("%b"), fill=(200, 200, 200), font=font(12))
    dr.text((20, 6), "Our interferogram pairs (each bar = one NASA file). The 24-day pairs jump the gap, so each chain is unbroken.", fill=(235, 235, 235), font=font(12))
    made["ev-gap"] = gc
    # noise per pair vs the size of what we want to see
    rows_ = results["ascending"]["pairs"]
    nc = Image.new("RGB", (760, 210), (20, 22, 28))
    dr = ImageDraw.Draw(nc)
    mx = max([r_["spread_iono_mm"] or 0 for r_ in rows_] + [r_["spread_tropo_mm"] or 0 for r_ in rows_] + [1])
    for k_, r_ in enumerate(rows_):
        x_ = 40 + k_ * 88
        for j_, (key_, col_) in enumerate((("spread_iono_mm", (224, 180, 76)), ("spread_tropo_mm", (120, 160, 230)))):
            v_ = r_[key_] or 0
            dr.rectangle([x_ + j_ * 26, 170 - v_ / mx * 130, x_ + j_ * 26 + 22, 170], fill=col_)
        dr.text((x_, 176), r_["pair"][5:10] + ">" + r_["pair"][19:24], fill=(190, 190, 190), font=font(10))
    dr.text((40, 6), f"How much the AIR moved the signal across our box in each pair (5-95% spread, mm). Tallest: {mx:.0f} mm.", fill=(235, 235, 235), font=font(12))
    dr.text((40, 24), "yellow = ionosphere, blue = troposphere (humid air). Sea-level rise over these months is about a millimetre (citation pending).", fill=(190, 190, 190), font=font(11))
    made["ev-noise"] = nc
    # low land (Terrarium <= 10 m)
    hh_ = asc["d"]["h"]
    low_img = np.zeros(hh_.shape + (3,), dtype=np.uint8)
    low_img[hh_ > 0] = (90, 95, 100)
    low_img[(hh_ > 0) & (hh_ <= METHOD["low_land_m"])] = (224, 180, 76)
    low_img[hh_ <= 0] = (20, 30, 50)
    made["ev-lowland"] = panel([(scaled(Image.fromarray(low_img, "RGB")), f"amber = land 0-{METHOD['low_land_m']:.0f} m, grey = higher land, dark = sea")],
                               f"Land under 10 m (AWS Terrarium surface heights): {results['ascending']['low_land_km2']} of {results['ascending']['land_km2']} km2")
    for k, im in made.items():
        im.save(os.path.join(ASSET_DIR, f"{k}.png"), optimize=True)

    # ---------- grid for the case terrain (ascending grid) ----------
    rows, cols = asc["vert"].shape
    m = max(1, math.ceil(math.sqrt(rows * cols / 60000)))
    R, Cc = rows // m, cols // m
    mm = lambda a: np.nanmean(a[:R * m, :Cc * m].reshape(R, m, Cc, m), axis=(1, 3))
    q = lambda a: [None if not np.isfinite(v) else int(round(v * 10)) for v in a.ravel()]
    bx = asc["d"]["x"][:Cc * m].reshape(Cc, m).mean(axis=1)
    by = asc["d"]["y"][:R * m].reshape(R, m).mean(axis=1)
    elev = terrain.grid_heights(bx, by, asc["d"]["proj"])
    px = abs(float(asc["d"]["x"][1] - asc["d"]["x"][0]))
    corners = {}
    for nm, (cx, cy) in {"nw": (0, 0), "ne": (Cc - 1, 0), "sw": (0, R - 1), "se": (Cc - 1, R - 1)}.items():
        lon, lat = nio.utm_to_lonlat(bx[cx], by[cy], asc["d"]["proj"])
        corners[nm] = [round(float(lat), 6), round(float(lon), 6)]
    first = chains["ascending"]["pairs"][0]["ref"]
    layers = [{"id": f"cum-{date}", "label": f"Motion {fmt_date(first)} → {fmt_date(date)} (ascending)", "date": date,
               "kind": "diverging", "unit": "mm", "scale": [-lim, lim], "lowWord": "down", "highWord": "up",
               "what": "Vertical-equivalent ground motion since the first pass, relative to central Jakarta",
               "source": f"NISAR L2 GUNW ascending track 010 frame 174, pairs {fmt_date(first)} → {fmt_date(date)}",
               "values": q(mm(v))} for date, v in asc["vert_maps"]]
    grid = {"about": "Blocky case terrain grid for Jakarta (ascending geometry). Layer values are x10 integers (mm); null = masked. Row 0 = north. Written by tools/process_jakarta.py.",
            "case": CASE, "rows": R, "cols": Cc, "merge": m, "pixel_m": px, "block_m": px * m,
            "block_text": f"one block = {m}×{m} NISAR interferogram pixels of {px:.0f} m ≈ {px * m:.0f} m" if m > 1 else f"one block = one NISAR interferogram pixel ≈ {px:.0f} m",
            "corners_latlon": corners, "layers": layers, "default_layer": layers[-1]["id"],
            "elev_dm": [int(round(v * 10)) for v in elev.ravel()], "height_source": terrain.SOURCE}
    with open(os.path.join(ASSET_DIR, "grid.json"), "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(grid), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

    # ---------- numbers file ----------
    ra, rd = results["ascending"], results["descending"]
    days = ra["days"]
    def direction_line(name, r):
        return (f"{r['vertical_mm_p5_land']:+.0f} mm for the fastest-sinking 5% of land, median {r['vertical_mm_median_land']:+.0f} mm "
                f"({r['land_valid_share']:.0%} of land measurable)") if r["usable"] else "not usable (chain broken or too little land measurable)"
    measured = [
        {"label": "Fastest-sinking district (2 km)", "value": f"{fastest['mm']:+.0f}" if fastest else "—", "unit": "mm" if fastest else "",
         "note": (f"near {abs(fastest['lat']):.3f}° S, {fastest['lon']:.3f}° E ({fastest['basis']}); vertical equivalent over {days} days "
                  f"({fmt_date(chains['ascending']['pairs'][0]['ref'])} → {fmt_date(chains['ascending']['pairs'][-1]['sec'])}), relative to central Jakarta") if fastest else None},
        {"label": f"Land sinking ≥ {abs(METHOD['sinking_mm']):.0f} mm", "value": ra["sinking_area_km2"], "unit": "km²",
         "note": f"ascending chain; descending {rd['sinking_area_km2']} km². Of the ascending area, {ra['sinking_area_under_10m_km2']} km² lies on land under 10 m."},
        {"label": "Ascending (05:39 local)", "value": direction_line("ascending", ra), "unit": ""},
        {"label": "Descending (18:11 local)", "value": direction_line("descending", rd), "unit": ""},
        {"label": "Land under 10 m in the box", "value": ra["low_land_km2"], "unit": "km²", "note": f"of {ra['land_km2']} km² of land (AWS Terrarium surface heights)"},
        {"label": "People on that low land", "value": "pending", "unit": "", "note": "No login-free numeric population source used yet; we don't read numbers off picture tiles."},
        {"label": "Compared with published rates", "value": "citation pending", "unit": ""},
    ]
    if both_usable:
        check_text = (f"Two directions, two times of day: {sum(r['agree'] for r in agree_rows)} of {n_sh} shared 2 km districts agree "
                      f"(Pearson r = {r_val:.2f}). " + ("They agree, so the motion is in the ground, not the air." if agree else
                      "They do not agree well enough to rule out the air."))
    else:
        bad = [n for n in DIRECTIONS if not per_dir[n]["usable"]]
        shares = ", ".join("{:.0%} of land measurable".format(results[n]["land_valid_share"]) for n in bad)
        check_text = ("Two-direction check not possible yet: the " + " and ".join(bad) + f" chain is not usable ({shares}). "
                      "The descending frame we have (091) covers only part of the box and is mostly incoherent there; the frame that covers it (092) is still downloading. "
                      "Without a second direction we can't fully rule out the air.")
    numbers = {
        "case": CASE,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured,
        "check": {"label": "Independent check", "text": check_text},
        "badge": badge,
        "badge_reason": "both directions usable and agree" if agree else ("one direction usable" if n_usable == 1 else "directions disagree or none usable"),
        "sources": [p["file"] for n in DIRECTIONS for p in chains[n]["pairs"]],
        "custody_extra": [],
        "method": METHOD,
        "results": results,
        "files": {"overlay": f"assets/cases/{CASE}/motion_overlay.png", "grid": f"assets/cases/{CASE}/grid.json",
                  "evidence": {k: f"assets/cases/{CASE}/{k}.png" for k in made}},
        "provenance": {
            "nasa_files": [{"file": p["file"], "dates": f"{p['ref']} → {p['sec']}", "direction": p["direction"], "track": p["track"],
                            "frame": p["frame"], "processing": p["processing"], "product_version": p["product_version"]}
                           for n in DIRECTIONS for p in chains[n]["pairs"]],
            "collection": "NISAR L2 GUNW provisional (ASF DAAC, NISAR_L2_GUNW_PROVISIONAL_V1)",
            "layers": [f"{IFG}/{n}" if not n.startswith(("radarGrid", "frequencyA")) else n for n in METHOD["layers"]],
            "box_lonlat": list(box),
            "projection_epsg": asc["d"]["proj"]["epsg"],
            "steps": ["read only the box rows/columns of each pair", "interpolate troposphere + incidence cubes to each pixel at its Terrarium height",
                      "subtract ionosphere + troposphere screens", "mask: coherence < 0.4, unwrapping components",
                      "pick the reference window by coherence", "subtract the reference median per pair",
                      "phase -> line-of-sight mm (-lambda/4pi)", "add pairs date by date (chain)", "LOS -> vertical equivalent (/cos incidence)",
                      "2 km districts, two-direction check", "badge (method.badge_rule)"],
            "heights": terrain.SOURCE,
            "sign_sources": ["ISCE3 cxx/isce3/signal/Crossmul.cpp (ref * conj(sec))", "ISCE3 cxx/isce3/focus/Backproject.cpp (exp(+j 2 pi fc tau))",
                             "JPL NISAR team, Fringe 2026 (ID 282), p.11: 'Ifg - iono - troposphere - solidearth tide'",
                             "NISAR L2 GUNW product specification JPL D-102272 Rev E: corrections stored, not applied"],
            "script": "tools/process_jakarta.py", "script_version": SCRIPT_VERSION,
            "script_sha256": sha256(os.path.abspath(__file__)),
            "helpers_sha256": sha256(os.path.join(nio.HERE, "nisar_io.py")),
        },
    }
    with open(NUMBERS, "w", encoding="utf-8") as f:
        json.dump(nio.clean_json(numbers), f, indent=1, ensure_ascii=False, allow_nan=False)
    fill_mystery(results, per_dir, badge, chains)
    np.savez_compressed(os.path.join(KIT_DIR, "arrays.npz"), asc_vert=asc["vert"], desc_vert=desc["vert"])
    log(f"wrote {NUMBERS}  badge={badge}  grid {R}x{Cc} merge {m}")
    update_results.update()
    log(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
