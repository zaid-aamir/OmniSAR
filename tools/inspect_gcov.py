"""
Look inside one NISAR GCOV radar image and read only the Jebel Ali case box.

Run (from the repo folder):
    py tools/inspect_gcov.py                 -> every finished Jebel Ali file (track 056, frame 014)
    py tools/inspect_gcov.py path\\to\\file.h5 -> just that file
    py tools/inspect_gcov.py --case al-ain   -> same files, Al Ain box

What it prints: the layer tree, the map projection, the pixel size, the box's array shape,
value ranges, and the median brightness in decibels (dB) for HH and HV.
What it saves: a small colour preview of the box in NASA hackathon\\research\\previews\\
(outside the repo): HH in red and blue, HV in green - the same colours NASA/ASF use.

This is an inspection tool only: it does not compute any verdict numbers (that is Stage 2).
"""

import argparse
import os
import time

import h5py
import numpy as np
from PIL import Image

import nisar_io as nio

GRID = "/science/LSAR/GCOV/grids/frequencyA"
DATA_DIR = os.path.join(nio.PROJECT, "data", "gcov")
OUT_DIR = os.path.join(nio.PROJECT, "research", "previews")

# Fixed preview colour limits in dB, the same for every date so two pictures can be compared.
HH_DB = (-25.0, 0.0)     # calm water about -25, sand about -15 to -10, buildings 0 and brighter
HV_DB = (-32.0, -10.0)   # HV (cross-pol) is weaker; it is brightest over vegetation and rough rubble


def inspect(path, case_id):
    t0 = time.time()
    print("=" * 78)
    print(os.path.basename(path))
    with h5py.File(path, "r") as f:
        ident = f["/science/LSAR/identification"]
        start = ident["zeroDopplerStartTime"][()].decode()
        print(f"pass start {start} | {ident['orbitPassDirection'][()].decode()} | "
              f"track {int(ident['trackNumber'][()])} frame {int(ident['frameNumber'][()])}")
        # The processing version is the 'P0xxxx' part of the name. Files made by different
        # processor versions may not be calibrated the same way - check before comparing dates.
        version = [part for part in os.path.basename(path).split("_") if part.startswith("P0")]
        print(f"processing version {version[0] if version else '?'} | "
              f"product version {ident['productVersion'][()].decode()}")

        print("\nTop-level groups:")
        nio.print_tree(f["/science/LSAR"], max_depth=2)
        print(f"\nLayers in {GRID}:")
        nio.print_tree(f[GRID])

        g = f[GRID]
        p = nio.projection_params(g["projection"])
        dx = float(g["xCoordinateSpacing"][()])
        dy = float(g["yCoordinateSpacing"][()])
        print(f"\nProjection: EPSG:{p['epsg']} (UTM, central meridian {p['lon0']} deg)")
        print(f"Pixel size: {dx:g} m east-west x {abs(dy):g} m north-south "
              f"(y spacing is {dy:g}: rows go from north to south)")
        print("Polarisations:", [s.decode() for s in g["listOfPolarizations"][()]])

        box = nio.case_box(case_id)
        (r0, r1, c0, c1), utm = nio.box_window(box, g["xCoordinates"], g["yCoordinates"], p)
        print(f"\nCase box '{case_id}' {box} (W,S,E,N degrees)")
        print(f"  -> UTM rectangle x {utm[0]:.0f}..{utm[2]:.0f}  y {utm[1]:.0f}..{utm[3]:.0f} m")
        print(f"  -> rows {r0}:{r1}, columns {c0}:{c1} of the full {g['HHHH'].shape} grid")

        # Only these slices are read from disk: h5py unzips just the 512x512 chunks they touch.
        hh = g["HHHH"][r0:r1, c0:c1].astype(np.float64)
        hv = g["HVHV"][r0:r1, c0:c1].astype(np.float64)
        mask = g["mask"][r0:r1, c0:c1]
        exc = g["inputDataExceptionMask"][r0:r1, c0:c1]

    print(f"\nBox array shape: {hh.shape} (rows x columns) = "
          f"{hh.shape[0] * abs(dy) / 1000:.1f} km x {hh.shape[1] * dx / 1000:.1f} km")
    vals, counts = np.unique(mask, return_counts=True)
    print("Mask values in box (subswath number; 0 = not fully focused, 255 = outside swath):",
          {int(v): f"{c / mask.size:.1%}" for v, c in zip(vals, counts)})
    # inputDataExceptionMask is a set of on/off bits. Bit value 2 = a known instrument glitch
    # ("sample slip"). Newer files also switch ON bit 256 (HH) and 512 (HV) when the data is
    # fully focused, so 768 = 256 + 512 means "HH and HV both fine", NOT an error.
    vals, counts = np.unique(exc, return_counts=True)
    print("Input-data exception codes in box:",
          {int(v): f"{c / exc.size:.1%}" for v, c in zip(vals, counts)},
          f"| pixels with the glitch bit (2): {np.mean((exc & 2) > 0):.1%}")

    print("\nLinear power (gamma-nought, terrain-corrected backscatter):")
    nio.describe("HH", hh)
    nio.describe("HV", hv)
    hh_db, hv_db = nio.power_to_db(hh), nio.power_to_db(hv)
    print("In decibels (10 x log10):")
    nio.describe("HH dB", hh_db, "dB")
    nio.describe("HV dB", hv_db, "dB")
    print(f"  MEDIAN  HH {np.nanmedian(hh_db):.2f} dB   HV {np.nanmedian(hv_db):.2f} dB")

    # Preview: average k x k blocks in linear power (smooths speckle), then dB, then fixed colours.
    k = max(1, max(hh.shape) // 1000 + 1)
    r = nio.stretch(nio.power_to_db(nio.block_mean(hh, k)), *HH_DB)
    gch = nio.stretch(nio.power_to_db(nio.block_mean(hv, k)), *HV_DB)
    rgb = np.dstack([r, gch, r])                               # red = HH, green = HV, blue = HH
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"gcov_{case_id}_{start[:10]}.png")
    Image.fromarray(rgb, "RGB").save(out)
    print(f"\nPreview ({rgb.shape[1]} x {rgb.shape[0]} px, {k}x{k} averaged; "
          f"HH {HH_DB} dB, HV {HV_DB} dB): {out}")
    print(f"Done in {time.time() - t0:.1f} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="GCOV .h5 files (default: finished Jebel Ali files)")
    ap.add_argument("--case", default="jebel-ali", help="case id from cases/index.json")
    args = ap.parse_args()
    files = args.files or nio.finished_h5(DATA_DIR, "_056_A_014_4005_")
    if not files:
        raise SystemExit(f"No finished track 056 / frame 014 GCOV files in {DATA_DIR}")
    for path in files:
        if path.endswith(".part"):
            raise SystemExit(f"Refusing to open an unfinished download: {path}")
        inspect(path, args.case)


if __name__ == "__main__":
    main()
