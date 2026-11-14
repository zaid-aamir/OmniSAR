"""
Trap Lab "try it" exhibits that the case files don't already have. Everything is drawn from data we
already processed (research/checks/jebel-ali/arrays.npz, written by process_jebel_ali.py, and its
numbers file) plus one fresh run of the existing zoom-10 tile test. No new measurement rule.

Run (from the repo folder, after process_jebel_ali.py):   py tools/build_traplab.py

  #8  interference: raw HH change 18 Jun -> 28 Oct (the flagged pass) vs 18 Jun -> 16 Oct
  #11 calm sea vs dry desert: the two reference windows from the 18 Jun image, with their real medians
  #2  zoom-10 map tiles: the same NASA NISAR tile address requested twice, both answers shown
Other traps' "try it" toggles (#9, #10, #13, #15, ...) are the real toggles already in the case files;
js/traplab.js finds those itself.

Writes assets/traplab/*.png and cases/traplab.json.
"""

import datetime as dt
import json
import os
import sys

import numpy as np
from PIL import Image

import nisar_io as nio
from process_jebel_ali import diverging, fmt_date
from evidence_jebel_ali import caption_strip, grey, zoom10_test, HH_SHOW

OUT = os.path.join(nio.REPO, "assets", "traplab")
JA = os.path.join(nio.PROJECT, "research", "checks", "jebel-ali", "arrays.npz")
NUMBERS = os.path.join(nio.REPO, "cases", "jebel-ali.numbers.json")


def save(img, name):
    img.save(os.path.join(OUT, name), optimize=True)
    return f"assets/traplab/{name}"


def big(img, w=520):
    return img.resize((w, round(img.height * w / img.width)), Image.NEAREST)


def main():
    os.makedirs(OUT, exist_ok=True)
    a = np.load(JA)
    num = json.load(open(NUMBERS, encoding="utf-8"))
    res = num["results"]
    first = [d["date"] for d in res["pass_medians"] if d["side"] == "before"][0]
    rows = {r["pass"]: r for r in res["interference"]}
    tries = {}

    # ---- #8: two single-date differences, nothing removed ----
    pair = {}
    for d in sorted(rows):
        r = rows[d]
        img = Image.fromarray(diverging(a[f"hh_{d}"] - a[f"hh_{first}"], 8.0))
        flag = "FLAGGED by our interference check" if r["HH"]["anomaly_over_box"] else "HH not flagged"
        pair[d] = {"src": save(caption_strip(big(img), [f"HH {fmt_date(d)} minus {fmt_date(first)}, raw (blue -8, white 0, red +8 dB)",
                                                         f"Box moved {r['HH']['box_median_change_db']:+.1f} dB, whole frame {r['HH']['frame_median_change_db']:+.1f} dB: {flag}"]),
                               f"t8-{d}.png"),
                   "label": f"{fmt_date(d)} vs {fmt_date(first)} (box {r['HH']['box_median_change_db']:+.1f} dB, frame {r['HH']['frame_median_change_db']:+.1f} dB)"}
    flagged = [d for d in sorted(rows) if rows[d]["HH"]["anomaly_over_box"]]
    clean = [d for d in sorted(rows) if not rows[d]["HH"]["anomaly_over_box"]]
    if flagged and clean:
        tries["8"] = {"case": "jebel-ali", "off": pair[clean[0]], "on": pair[flagged[0]],
                      "offWord": "Clean pass", "onWord": "Flagged pass",
                      "note": f"The same comparison, two different after-dates. On {fmt_date(flagged[0])} the whole Jebel Ali box seems to brighten while the rest of the frame doesn't: "
                              "interference, not construction. A median of three passes per side would outvote one bad date; we only have one clean pass per side so far."}

    # ---- #11: sea and desert windows from the same image ----
    s_r0, s_r1, s_c0, s_c1 = [int(v) for v in a["sea_rc"]]
    l_r0, l_r1, l_c0, l_c1 = [int(v) for v in a["land_rc"]]
    th = res["thresholds"]
    sea = big(grey(a[f"hh_{first}"][s_r0:s_r1, s_c0:s_c1], HH_SHOW), 420)
    land = big(grey(a[f"hh_{first}"][l_r0:l_r1, l_c0:l_c1], HH_SHOW), 420)
    tries["11"] = {"case": "jebel-ali",
                   "off": {"src": save(caption_strip(sea, [f"Open sea, NISAR HH {fmt_date(first)}: median {th['sea_before_median_db']:.1f} dB"]), "t11-sea.png"),
                           "label": f"Open sea: {th['sea_before_median_db']:.1f} dB"},
                   "on": {"src": save(caption_strip(land, [f"Desert sand, NISAR HH {fmt_date(first)}: median {th['desert_before_median_db']:.1f} dB"]), "t11-desert.png"),
                          "label": f"Desert sand: {th['desert_before_median_db']:.1f} dB"},
                   "offWord": "Sea", "onWord": "Desert",
                   "note": f"Both reflect the beam away like a mirror, so both come back dark: {th['sea_before_median_db']:.1f} dB vs {th['desert_before_median_db']:.1f} dB. "
                           "Radar alone can't tell calm water from smooth sand here."}

    # ---- #2: one zoom-10 tile address, requested twice ----
    after = [d["date"] for d in res["pass_medians"] if d["side"] == "after"][-1]
    url, results = zoom10_test(24.99, 55.02, after, tries=2)
    fetched = dt.datetime.now(dt.timezone(dt.timedelta(hours=4))).strftime("%d %b %Y %H:%M UAE")
    # every answer is shown as it came back: an image, or the error the server returned
    from PIL import ImageDraw
    from process_jebel_ali import font
    shots = []
    for i, r in enumerate(results):
        if r["data"]:
            p = os.path.join(OUT, f"t2-raw{i}.png")
            open(p, "wb").write(r["data"])
            im = Image.open(p).convert("RGB")
            os.remove(p)
            line, label = f"Request {i + 1}, {fetched}: image, fingerprint {r['sha']}", f"Request {i + 1}: image {r['sha']}"
        else:
            im = Image.new("RGB", (256, 256), (20, 22, 28))
            ImageDraw.Draw(im).text((24, 116), f"No picture: server answered {r['status']}", fill=(224, 122, 95), font=font(13))
            line, label = f"Request {i + 1}, {fetched}: error {r['status']}, no picture", f"Request {i + 1}: error {r['status']}"
        shots.append({"src": save(caption_strip(big(im, 420), [line]), f"t2-request{i + 1}.png"), "label": label})
    if len(shots) == 2:
        same = results[0]["sha"] and results[0]["sha"] == results[1]["sha"]
        tries["2"] = {"case": "jebel-ali", "off": shots[0], "on": shots[1], "offWord": "Request 1", "onWord": "Request 2",
                      "note": (f"The same NASA NISAR map-tile address at zoom 10, asked twice on {fetched}: "
                               + ("the two answers were identical this time; earlier tests got different images." if same else
                                  ("two different images came back for one address (fingerprints " + " and ".join(r["sha"] for r in results) + ")."
                                   if all(r["sha"] for r in results) else
                                   "one answer was an error instead of a picture (" + ", ".join(str(r["status"]) for r in results) + ")."))
                               + " Map tiles are pictures; our numbers come from the science files."),
                      "url": url, "statuses": [r["status"] for r in results], "fingerprints": [r["sha"] for r in results]}

    out = {"about": "Trap Lab 'try it' exhibits built by tools/build_traplab.py from our processed data (no new rules).",
           "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "tryIts": tries}
    with open(os.path.join(nio.REPO, "cases", "traplab.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print("try-its:", list(tries))


if __name__ == "__main__":
    sys.exit(main())
