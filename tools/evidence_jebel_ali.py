"""
Jebel Ali evidence cards and toggle images, made from OUR processed data (never invented).

Run after tools/process_jebel_ali.py:    py tools/evidence_jebel_ali.py

Reads:  research\\checks\\jebel-ali\\arrays.npz (outside the repo, written by process_jebel_ali.py),
        cases/jebel-ali.numbers.json, cases/passes.json, and NASA GIBS pictures (public, no login).
Writes: assets/cases/jebel-ali/ev-*.png and tg-*.png, and fills in cases/jebel-ali.json:
        each evidence card's image, caption numbers and correct answer ("real" or "trap"), and each
        toggle's two images (or the reason it is switched off). Cards whose evidence doesn't exist
        yet get src null, which the app shows as "Evidence pending".
"""

import datetime as dt
import hashlib
import io
import json
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

import nisar_io as nio
from process_jebel_ali import KIT_DIR, ASSET_DIR, NUMBERS, CASE, diverging, font, fmt_date

MYSTERY = os.path.join(nio.REPO, "cases", f"{CASE}.json")
PASSES = os.path.join(nio.REPO, "cases", "passes.json")
HH_SHOW, HV_SHOW = (-25.0, 5.0), (-32.0, -10.0)
NISAR_TILE = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/NISAR_L2_Geocoded_Polarimetric_Covariance/"
              "default/{date}/GoogleMapsCompatible_Level13/{z}/{y}/{x}.png")
RTC_LAYER = "OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1"
BG = (20, 22, 28)


def utm_params(epsg):
    zone = epsg % 100
    return {"epsg": epsg, "lon0": zone * 6 - 183, "k0": 0.9996, "false_easting": 500000.0,
            "false_northing": 10000000.0 if epsg > 32700 else 0.0}


def grey(arr, lim):
    return Image.fromarray(nio.stretch(arr, *lim), "L").convert("RGB")


def caption_strip(img, lines, width=None):
    """Put dark caption lines under an image (all text is drawn from our numbers)."""
    w = width or img.width
    h = 18 * len(lines) + 12
    out = Image.new("RGB", (w, img.height + h), BG)
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    for i, line in enumerate(lines):
        d.text((8, img.height + 6 + 18 * i), line, fill=(215, 215, 215), font=font(13))
    return out


def side_by_side(items, title=None):
    gap = 12
    top = 30 if title else 0
    w = sum(im.width for im, _ in items) + gap * (len(items) + 1)
    h = max(im.height for im, _ in items) + top + 34
    out = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(out)
    if title:
        d.text((gap, 8), title, fill=(240, 240, 240), font=font(15))
    x = gap
    for im, label in items:
        out.paste(im, (x, top))
        d.text((x, top + im.height + 8), label, fill=(200, 200, 200), font=font(12))
        x += im.width + gap
    return out


def fit(img, max_w):
    if img.width <= max_w:
        return img
    return img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)


def save(img, name):
    path = os.path.join(ASSET_DIR, name)
    img.save(path, optimize=True)
    return f"assets/cases/{CASE}/{name}"


def box_lonlat_extent(x, y, p):
    lons, lats = zip(*[nio.utm_to_lonlat(xx, yy, p) for xx in (x[0], x[-1]) for yy in (y[0], y[-1])])
    return float(min(lons)), float(min(lats)), float(max(lons)), float(max(lats))


def nearest_with_data(layer, target, extent, size, days=12):
    """Nearest date (+/- days) on which a GIBS layer has a picture of the extent; tie -> earlier."""
    t = dt.date.fromisoformat(target)
    for off in sorted(range(-days, days + 1), key=lambda o: (abs(o), o)):
        day = (t + dt.timedelta(days=off)).isoformat()
        img, url = nio.gibs_wms(layer, day, *extent, *size)
        if (np.asarray(img)[:, :, 3] > 0).mean() > 0.5:
            flat = Image.new("RGB", img.size, (0, 0, 0))
            flat.paste(img, mask=img.split()[3])
            return day, flat, url
    return None, None, None


def tile_xy(lat, lon, z):
    import math
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    lr = math.radians(lat)
    y = int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n)
    return x, y


def zoom10_test(lat, lon, date, tries=5):
    """Fetch the SAME NISAR map-tile address several times and compare the answers."""
    x, y = tile_xy(lat, lon, 10)
    url = NISAR_TILE.format(date=date, z=10, y=y, x=x)
    results = []
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "OmniSAR-processing/1.0", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            results.append({"status": 200, "sha": hashlib.sha256(data).hexdigest()[:12], "data": data})
        except urllib.error.HTTPError as e:
            results.append({"status": e.code, "sha": None, "data": None})
        except Exception as e:                       # timeouts etc.
            results.append({"status": str(e)[:40], "sha": None, "data": None})
    return url, results


def main():
    a = np.load(os.path.join(KIT_DIR, "arrays.npz"))
    num = json.load(open(NUMBERS, encoding="utf-8"))
    mystery = json.load(open(MYSTERY, encoding="utf-8"))
    res = num["results"]
    p = utm_params(int(a["epsg"]))
    dates = [str(d) for d in a["dates"]]
    before = [d["date"] for d in res["pass_medians"] if d["side"] == "before"]
    after = [d["date"] for d in res["pass_medians"] if d["side"] == "after"]
    first, last = before[0], after[-1]
    robust = res["median_robust"]
    quality_ok = res["gain_check"]["ok"]
    extent = box_lonlat_extent(a["x"], a["y"], p)
    H, W = a["before_db"].shape
    os.makedirs(ASSET_DIR, exist_ok=True)
    made = {}
    log = []

    # ---------- 1. Two single dates (trap 8): raw HH difference, nothing removed ----------
    flagged = [r for r in res["interference"] if r["anomaly_over_box"]]
    worst = flagged[0] if flagged else res["interference"][-1]
    raw = a[f"hh_{worst['pass']}"] - a[f"hh_{worst['compared_with']}"]
    left = Image.fromarray(diverging(raw, 8.0))
    frame = Image.open(os.path.join(KIT_DIR, worst["picture"])).convert("RGB")
    frame = frame.crop((0, 0, frame.width // 2, frame.height))          # HH half of the whole-frame map
    frame = fit(frame, left.width)
    made["tg-single"] = save(caption_strip(left, [f"HH {fmt_date(worst['pass'])} minus {fmt_date(worst['compared_with'])}, raw (blue -8 dB, white 0, red +8 dB)"]), "tg-single.png")
    made["ev-two-date"] = save(side_by_side(
        [(left, f"Jebel Ali box: HH {fmt_date(worst['pass'])} minus {fmt_date(worst['compared_with'])}, raw"),
         (frame, "Whole NISAR frame, same two dates")],
        f"Box HH {worst['HH']['box_median_change_db']:+.1f} dB while the whole frame moved {worst['HH']['frame_median_change_db']:+.1f} dB"),
        "ev-two-date.png")

    # ---------- 2. Median change (real only if the median is robust and the quality check passes) ----------
    if robust:
        img = Image.fromarray(diverging(a["delta"], 6.0))
        made["tg-median"] = save(caption_strip(img, [f"Median of {len(before)} before vs {len(after)} after passes, background removed (blue -6, red +6 dB)"]), "tg-median.png")
        made["ev-median"] = made["tg-median"]
    # ---------- 3. Sea vs desert (trap 11) ----------
    s_r0, s_r1, s_c0, s_c1 = [int(v) for v in a["sea_rc"]]
    l_r0, l_r1, l_c0, l_c1 = [int(v) for v in a["land_rc"]]
    sea_db = a[f"hh_{first}"][s_r0:s_r1, s_c0:s_c1]
    land_db = a[f"hh_{first}"][l_r0:l_r1, l_c0:l_c1]
    sea_med, land_med = float(np.nanmedian(sea_db)), float(np.nanmedian(land_db))
    scale = 4
    crops = []
    for name, sub, (r0, r1, c0, c1), med in (("Open sea", sea_db, (s_r0, s_r1, s_c0, s_c1), sea_med),
                                            ("Desert sand", land_db, (l_r0, l_r1, l_c0, l_c1), land_med)):
        g = grey(sub, HH_SHOW)
        g = g.resize((g.width * scale, g.height * scale), Image.NEAREST)
        lon0, lat1 = nio.utm_to_lonlat(a["x"][c0], a["y"][r0], p)
        lon1, lat0 = nio.utm_to_lonlat(a["x"][c1 - 1], a["y"][r1 - 1], p)
        ph, _ = nio.gibs_wms(num["results"]["photo_check"]["before"]["layer"], num["results"]["photo_check"]["before"]["date"],
                             float(lon0), float(lat0), float(lon1), float(lat1), g.width, g.height)
        flat = Image.new("RGB", ph.size, (0, 0, 0))
        flat.paste(ph, mask=ph.split()[3])
        crops.append((g, f"{name}: NISAR HH median {med:.1f} dB"))
        crops.append((flat, f"{name}: NASA HLS photo {num['results']['photo_check']['before']['date']}"))
    made["ev-sea-desert"] = save(side_by_side(crops, f"Same darkness, different ground ({fmt_date(first)}): sea {sea_med:.1f} dB vs desert {land_med:.1f} dB"), "ev-sea-desert.png")

    # ---------- 4. NISAR map tile at zoom 10 (trap 2) ----------
    fetched = dt.datetime.now(dt.timezone(dt.timedelta(hours=4))).strftime("%d %b %Y %H:%M UAE")
    url, results = zoom10_test(24.99, 55.02, last)
    distinct = [r for i, r in enumerate(results) if r["data"] and r["sha"] not in [q["sha"] for q in results[:i]]]
    errors = [r for r in results if r["status"] != 200]
    tiles = []
    for i, r in enumerate(distinct[:4]):
        im = Image.open(io.BytesIO(r["data"])).convert("RGB").resize((256, 256), Image.NEAREST)
        tiles.append((im, f"answer {i + 1} (fingerprint {r['sha']})"))
    summary = (f"{len(results)} requests for one zoom-10 address, {fetched}: {len(distinct)} different image(s), "
               f"{len(errors)} error(s)")
    if tiles:
        made["ev-zoom10"] = save(side_by_side(tiles, summary), "ev-zoom10.png")
    log.append({"zoom10_url": url, "fetched": fetched, "statuses": [r["status"] for r in results],
                "fingerprints": [r["sha"] for r in results]})

    # ---------- 5. No NISAR passes before 18 June (trap 6) ----------
    pj = json.load(open(PASSES, encoding="utf-8"))
    win0, win1 = dt.date.fromisoformat(pj["window"]["start"]), dt.date.fromisoformat(pj["window"]["end"])
    span = (win1 - win0).days
    Wc, Hc, L, R = 760, 190, 40, 20
    chart = Image.new("RGB", (Wc, Hc), BG)
    d = ImageDraw.Draw(chart)
    xof = lambda day: L + (day - win0).days / span * (Wc - L - R)
    first_pass = min(dt.date.fromisoformat(q["date"]) for q in pj["cases"][CASE]["passes"])
    d.rectangle([xof(win0), 40, xof(first_pass), 130], fill=(60, 50, 30))
    d.text((xof(win0) + 4, 44), "no NISAR passes", fill=(224, 180, 76), font=font(12))
    gap0, gap1 = dt.date(2026, 7, 27), dt.date(2026, 8, 10)
    for xx in range(int(xof(gap0)), int(xof(gap1)), 5):
        d.line([xx, 130, xx + 8, 40], fill=(70, 70, 76))
    d.text((xof(gap0) - 6, 26), "NASA data gap", fill=(150, 150, 150), font=font(11))
    for q in pj["cases"][CASE]["passes"]:
        xx = xof(dt.date.fromisoformat(q["date"]))
        y0, y1 = (50, 88) if q["direction"] == "A" else (92, 128)
        d.line([xx, y0, xx, y1], fill=(34, 211, 238) if q["direction"] == "A" else (120, 160, 230), width=2)
    d.text((L, 134), "ascending passes (top) · descending (bottom)", fill=(180, 180, 180), font=font(11))
    m = dt.date(win0.year, win0.month, 1)
    while m <= win1:
        if m >= win0:
            d.line([xof(m), 130, xof(m), 150], fill=(120, 120, 120))
            d.text((xof(m) + 3, 152), m.strftime("%b"), fill=(200, 200, 200), font=font(12))
        m = dt.date(m.year + (m.month == 12), m.month % 12 + 1, 1)
    d.text((L, 6), f"NISAR passes over the Jebel Ali box listed in NASA's catalogue (CMR), {win0:%d %b} to {win1:%d %b %Y}: first pass {first_pass:%d %b}",
           fill=(235, 235, 235), font=font(13))
    made["ev-passes"] = save(chart, "ev-passes.png")

    # ---------- 6. HLS photo pair (real) ----------
    pb, pa = res["photo_check"]["before"], res["photo_check"]["after"]
    size = (W, H)
    pair = []
    for ph in (pb, pa):
        img, _ = nio.gibs_wms(ph["layer"], ph["date"], *extent, *size)
        flat = Image.new("RGB", img.size, (0, 0, 0))
        flat.paste(img, mask=img.split()[3])
        pair.append((flat, f"NASA HLS {ph['layer'][4:7]} {ph['date']}"))
    made["ev-hls"] = save(side_by_side(pair, "Satellite photos of the same box, June vs October"), "ev-hls.png")

    # ---------- toggles: L-band vs C-band, HH vs HV ----------
    made["tg-lband"] = save(caption_strip(grey(a[f"hh_{first}"], HH_SHOW), [f"NISAR L-band (24 cm) HH, {fmt_date(first)}, our GCOV processing"]), "tg-lband.png")
    rtc_day, rtc_img, rtc_url = nearest_with_data(RTC_LAYER, first, extent, size)
    if rtc_img is not None:
        made["tg-cband"] = save(caption_strip(rtc_img, [f"Sentinel-1 C-band (5.6 cm), NASA OPERA RTC picture tile, {rtc_day} (nearest date)"]), "tg-cband.png")
    made["tg-hh"] = save(caption_strip(grey(a[f"hh_{first}"], HH_SHOW), [f"NISAR HH (direct echo), {fmt_date(first)}, -25 to +5 dB"]), "tg-hh.png")
    made["tg-hv"] = save(caption_strip(grey(a["hv_before"], HV_SHOW), [f"NISAR HV (rough and leafy echo), {fmt_date(first)}, -32 to -10 dB"]), "tg-hv.png")

    # ---------- write into the mystery file ----------
    ev = {e["id"]: e for e in mystery["evidence"]}
    i8 = worst
    ev["two-date"].update(src=made["ev-two-date"], bin="trap", trap=8,
        caption=f"Change between just two NISAR images, {fmt_date(i8['compared_with'])} and {fmt_date(i8['pass'])}, with nothing removed. "
                f"Our box reads {i8['HH']['box_median_change_db']:+.1f} dB brighter in HH while the whole NISAR frame moved "
                f"{i8['HH']['frame_median_change_db']:+.1f} dB: a broad patch over Dubai, not new buildings everywhere.")
    if robust:
        ev["median-change"].update(src=made["ev-median"], pending=False,
            bin="real" if quality_ok else "trap", trap=None if quality_ok else 8,
            caption=(f"Median of {len(before)} passes before vs {len(after)} after, same direction, smooth background removed. "
                     + ("Changes that last stay; one-day patches drop out." if quality_ok else
                        "Even the median still carries the interference patch, so this map is not reliable.")))
    else:
        ev["median-change"].update(src=None, pending=True,
            caption=f"Median of three passes per side: pending. We have {len(before)} before and {len(after)} after; with fewer than three, one bad date can't be outvoted.")
    ev["no-data-before-june"].update(src=made["ev-passes"], kind="image", bin="trap", trap=6,
        caption=f"NASA's catalogue lists the first NISAR pass over this box on {fmt_date(str(first_pass))} 2026. The empty weeks before it mean 'not imaged', not 'nothing there'.")
    ev["dark-inland"].update(src=made["ev-sea-desert"], bin="trap", trap=11, title="Two dark patches",
        caption=f"Open sea and desert sand from the same NISAR image ({fmt_date(first)}): {sea_med:.1f} dB vs {land_med:.1f} dB in HH. Radar alone can't tell them apart here.")
    if "ev-zoom10" in made:
        ev["zoom-tile"].update(src=made["ev-zoom10"], bin="trap", trap=2,
            caption=f"One NASA NISAR map-tile address at zoom 10, requested {len(results)} times on {fetched}: "
                    f"{len(distinct)} different image(s) came back" + (f", {len(errors)} request(s) failed." if errors else ".")
                    + " Map tiles are pictures; our numbers come from the science files.")
    ev["photo-check"].update(src=made["ev-hls"], bin="real", trap=None,
        caption=f"NASA HLS photos of the same box, {pb['date']} and {pa['date']}. Compare the port basin and the Palm: some ground clearly changed between them.")

    tg = {t["id"]: t for t in mystery["toggles"]}
    tg["median"].update(
        layers={"off": {"src": made["tg-single"], "label": "Two single dates"},
                "on": {"src": made.get("tg-median"), "label": "Median of several passes"}},
        disabled=None if robust else f"The median needs three passes per side; we have {len(before)} before and {len(after)} after so far (more are downloading).")
    tg["channel"].update(layers={"off": {"src": made["tg-hh"], "label": "HH"}, "on": {"src": made["tg-hv"], "label": "HV"}}, disabled=None)
    tg["direction"].update(layers={"off": None, "on": None},
        disabled="Switched off for Jebel Ali: we only analyse ascending track 056. Comparing passes from opposite directions is trap 7.")
    band = {"id": "band", "label": "L-band (NISAR) ↔ C-band (Sentinel-1)", "trap": 13,
            "explains": "Longer L-band waves pass through plants and dry sand that stop shorter C-band waves, so the same place looks different. The C-band image is a NASA picture tile (trap 13), shown for comparison only.",
            "layers": {"off": {"src": made["tg-lband"], "label": "L-band NISAR"},
                       "on": {"src": made.get("tg-cband"), "label": f"C-band Sentinel-1 ({rtc_day})" if rtc_day else "C-band"}},
            "disabled": None if rtc_img is not None else "No Sentinel-1 picture within 12 days of the NISAR pass."}
    coh = {"id": "coherence", "label": "Coherence mask off ↔ on", "trap": 15, "layers": {"off": None, "on": None},
           "explains": "Coherence shows where the radar signal stayed stable between two passes.",
           "disabled": "Switched off for Jebel Ali: none of our NISAR interferograms cover this box (the UAE ones, track 128, start about 25.2° N)."}
    order = ["median", "band", "channel", "coherence", "direction"]
    allt = {**tg, "band": band, "coherence": coh}
    mystery["toggles"] = [allt[k] for k in order]
    with open(MYSTERY, "w", encoding="utf-8") as f:
        json.dump(mystery, f, indent=2, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(KIT_DIR, "evidence_log.json"), "w", encoding="utf-8") as f:
        json.dump({"made": made, "zoom10": log, "rtc": {"date": rtc_day, "url": rtc_url}}, f, indent=1)
    print(json.dumps({"made": list(made), "zoom10": summary, "rtc_day": rtc_day, "sea": sea_med, "desert": land_med}, indent=1))


if __name__ == "__main__":
    main()
