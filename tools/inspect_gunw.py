"""
Look inside one NISAR GUNW interferogram (InSAR) and read only the Jakarta case box.

Run (from the repo folder):
    py tools/inspect_gunw.py                  -> first finished Jakarta ascending file (track 010, frame 174)
    py tools/inspect_gunw.py path\\to\\file.h5  -> just that file

An interferogram compares two radar passes 12 days apart. Its layers:
  unwrappedPhase      - how much the radar distance changed between the two passes, in radians.
                        One full cycle (2 pi) = half a wavelength (~12 cm) of movement toward or
                        away from the satellite - but it also contains air (atmosphere) delay.
  coherenceMagnitude  - 0..1: how similar the ground looked on both dates. Low = the phase is noise.
  connectedComponents - islands of pixels that were unwrapped together. 0 = not unwrapped (don't trust);
                        phase can only be compared between pixels inside the same island.

What it prints: layer tree, projection, pixel size, box shapes, value ranges, share of the box
with coherence above 0.4, and the connected-component islands.
What it saves: a preview (phase | coherence | components) in NASA hackathon\\research\\previews\\.
No displacement numbers are computed here - that is Stage 2.
"""

import argparse
import math
import os
import time

import h5py
import numpy as np
from PIL import Image, ImageDraw

import nisar_io as nio

FREQ = "/science/LSAR/GUNW/grids/frequencyA"
UNW = FREQ + "/unwrappedInterferogram/HH"
DATA_DIR = os.path.join(nio.PROJECT, "data", "insar")
OUT_DIR = os.path.join(nio.PROJECT, "research", "previews")
COHERENCE_MIN = 0.4


def diverging(t):
    """t from -1..1 -> blue (-1), white (0), red (+1). NaN -> black. For the phase panel."""
    t = np.clip(np.asarray(t, dtype=np.float64), -1, 1)
    nan = ~np.isfinite(t)
    t = np.nan_to_num(t)
    blue, red, white = np.array([33, 102, 172]), np.array([178, 24, 43]), np.array([247, 247, 247])
    a = np.abs(t)[..., None]
    end = np.where((t < 0)[..., None], blue, red)
    rgb = (white * (1 - a) + end * a).round().astype(np.uint8)
    rgb[nan] = 0
    return rgb


def components_rgb(cc):
    """Each island gets its own colour; 0 (not unwrapped) and 65535 (no data) stay black."""
    rng = np.random.default_rng(7)
    lut = rng.integers(60, 256, size=(65536, 3), dtype=np.uint8)
    lut[0] = 0
    lut[65535] = 0
    return lut[cc]


def inspect(path, case_id):
    t0 = time.time()
    print("=" * 78)
    print(os.path.basename(path))
    with h5py.File(path, "r") as f:
        ident = f["/science/LSAR/identification"]
        ref = ident["referenceZeroDopplerStartTime"][()].decode()
        sec = ident["secondaryZeroDopplerStartTime"][()].decode()
        print(f"pair {ref[:10]} -> {sec[:10]} | {ident['orbitPassDirection'][()].decode()} | "
              f"track {int(ident['trackNumber'][()])} frame {int(ident['frameNumber'][()])}")

        print(f"\nLayers in {FREQ}/unwrappedInterferogram:")
        nio.print_tree(f[FREQ + "/unwrappedInterferogram"])

        f_hz = float(f[FREQ + "/centerFrequency"][()])
        wavelength = 299792458.0 / f_hz
        print(f"\nCentre frequency {f_hz / 1e9:.4f} GHz -> wavelength {wavelength * 100:.2f} cm "
              f"(one 2-pi phase cycle = {wavelength / 2 * 100:.2f} cm along the line of sight)")

        g = f[UNW]
        p = nio.projection_params(g["projection"])
        dx = float(g["xCoordinateSpacing"][()])
        dy = float(g["yCoordinateSpacing"][()])
        print(f"Projection: EPSG:{p['epsg']} (UTM, central meridian {p['lon0']} deg, "
              f"false northing {p['false_northing']:.0f} m -> southern hemisphere)")
        print(f"Pixel size: {dx:g} m x {abs(dy):g} m")

        box = nio.case_box(case_id)
        (r0, r1, c0, c1), utm = nio.box_window(box, g["xCoordinates"], g["yCoordinates"], p)
        print(f"\nCase box '{case_id}' {box} (W,S,E,N degrees)")
        print(f"  -> UTM rectangle x {utm[0]:.0f}..{utm[2]:.0f}  y {utm[1]:.0f}..{utm[3]:.0f} m")
        print(f"  -> rows {r0}:{r1}, columns {c0}:{c1} of the full {g['unwrappedPhase'].shape} grid")

        phase = g["unwrappedPhase"][r0:r1, c0:c1].astype(np.float64)
        coh = g["coherenceMagnitude"][r0:r1, c0:c1].astype(np.float64)
        cc = g["connectedComponents"][r0:r1, c0:c1]
        iono = g["ionospherePhaseScreen"][r0:r1, c0:c1].astype(np.float64)

    print(f"\nBox array shape: {phase.shape} (rows x columns) = "
          f"{phase.shape[0] * abs(dy) / 1000:.1f} km x {phase.shape[1] * dx / 1000:.1f} km")
    nio.describe("unwrapped phase", phase, "rad")
    nio.describe("coherence", coh)
    nio.describe("ionosphere phase screen (stored, NOT applied)", iono, "rad")

    valid = np.isfinite(coh)
    good = valid & (coh > COHERENCE_MIN)
    print(f"  coherence > {COHERENCE_MIN}: {good.sum() / phase.size:.1%} of the box "
          f"({good.sum() / max(valid.sum(), 1):.1%} of pixels that have data)")

    ids, counts = np.unique(cc, return_counts=True)
    named = {int(i): int(c) for i, c in zip(ids, counts)}
    big = sorted(((c, i) for i, c in named.items() if i not in (0, 65535)), reverse=True)
    print(f"  connected components: {len(big)} island(s); "
          f"not unwrapped (0): {named.get(0, 0) / cc.size:.1%}; no data (65535): {named.get(65535, 0) / cc.size:.1%}")
    for c, i in big[:5]:
        print(f"    island {i}: {c / cc.size:.1%} of the box")

    # Preview: three panels side by side, each upscaled 2x so 80 m pixels are visible.
    rel = phase - np.nanmedian(phase)                  # phase relative to the box's median
    panel_phase = diverging(rel / (2 * math.pi))       # +-2 pi (one cm-scale cycle each way) = full colour
    panel_coh = np.repeat(nio.stretch(coh, 0, 1)[..., None], 3, axis=2)
    panel_cc = components_rgb(cc)
    gap = np.zeros((phase.shape[0], 6, 3), dtype=np.uint8)
    img = np.hstack([panel_phase, gap, panel_coh, gap, panel_cc])
    im = Image.fromarray(img, "RGB").resize((img.shape[1] * 2, img.shape[0] * 2), Image.NEAREST)
    draw = ImageDraw.Draw(im)
    w = (phase.shape[1] + 6) * 2
    for k, label in enumerate(["phase vs median (blue -2pi .. red +2pi)", "coherence 0..1",
                               "connected components (black = 0)"]):
        draw.rectangle([k * w + 2, 2, k * w + 6 + 6 * len(label), 14], fill=(0, 0, 0))
        draw.text((k * w + 4, 3), label, fill=(255, 255, 255))
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"gunw_{case_id}_{ref[:10]}_{sec[:10]}.png")
    im.save(out)
    print(f"\nPreview ({im.width} x {im.height} px): {out}")
    print(f"Done in {time.time() - t0:.1f} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="GUNW .h5 files (default: first finished Jakarta ascending file)")
    ap.add_argument("--case", default="jakarta", help="case id from cases/index.json")
    args = ap.parse_args()
    files = args.files or nio.finished_h5(DATA_DIR, "_010_A_174_")[:1]
    if not files:
        raise SystemExit(f"No finished track 010 / frame 174 GUNW files in {DATA_DIR}")
    for path in files:
        if path.endswith(".part"):
            raise SystemExit(f"Refusing to open an unfinished download: {path}")
        inspect(path, args.case)


if __name__ == "__main__":
    main()
