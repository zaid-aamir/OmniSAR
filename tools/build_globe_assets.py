"""
Build the small data files the blocky globe needs. Run once per resolution:
  py tools/build_globe_assets.py                      -> 1.0 degree cells, Terrarium zoom 3, assets/globe/1p0/
  py tools/build_globe_assets.py --cell 0.5 --zoom 4  -> 0.5 degree cells, Terrarium zoom 4, assets/globe/0p5/
(The globe loads 0p5 by default and falls back to 1p0 on a slow computer: js/globe.js.)

What it does
  1. Downloads NASA's Blue Marble picture of Earth from GIBS (one image, whole world, no login).
  2. Downloads the AWS Terrarium elevation tiles (64 at zoom 3, 256 at zoom 4; heights in metres, in RGB).
  3. Puts both on the SAME grid: one cell per CELL_DEG degrees of latitude/longitude.
     Colour = average colour of the cell. Height = average height of the cell, with sea and
     anything below sea level set to 0 (oceans are drawn flat).
  4. Saves into assets/globe/<1p0 or 0p5>/:
       colour.png   one pixel per cell (row 0 = 90N, column 0 = 180W)
       height.bin   one 16-bit whole number (metres) per cell, same order as colour.png
       globe.json   grid size, height exaggeration, and where the data came from

Needs: numpy, Pillow   (py -m pip install numpy pillow)
"""

import argparse
import io
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image

CELL_DEG = 1.0              # grid cell size in degrees (2.0 if the globe is too slow)
HEIGHT_EXAGGERATION = 40    # mountains drawn this many times taller than real, so they show up
TERRARIUM_ZOOM = 3          # 8 x 8 tiles of 256 px = 2048 px around the world (~20 km at the equator);
                            # zoom 4 (4096 px, ~10 km) for 0.5 degree cells

GIBS_URL = (
    "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap"
    "&VERSION=1.3.0&LAYERS=BlueMarble_ShadedRelief_Bathymetry&CRS=EPSG:4326"
    "&BBOX=-90,-180,90,180&WIDTH=1440&HEIGHT=720&FORMAT=image/png"
)
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "assets", "globe", "1p0")


def download(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def block_average(arr, rows, cols):
    """Average a (H, W, ...) array down to (rows, cols, ...) by equal blocks."""
    h, w = arr.shape[:2]
    return arr.reshape(rows, h // rows, cols, w // cols, *arr.shape[2:]).mean(axis=(1, 3))


def build_colour(rows, cols):
    print("Downloading Blue Marble from NASA GIBS ...")
    img = Image.open(io.BytesIO(download(GIBS_URL))).convert("RGB")
    rgb = np.asarray(img, dtype=np.float64)          # 720 x 1440 x 3, row 0 = 90N
    return np.round(block_average(rgb, rows, cols)).astype(np.uint8)


def build_height(rows, cols):
    """Mosaic the Terrarium tiles (Web Mercator) and average them into lat/lon cells."""
    n = 2 ** TERRARIUM_ZOOM
    size = 256 * n
    mosaic = np.zeros((size, size), dtype=np.float64)
    print(f"Downloading {n * n} Terrarium tiles (zoom {TERRARIUM_ZOOM}) ...")
    for ty in range(n):
        print(f"  tile row {ty + 1} of {n}", flush=True)
        for tx in range(n):
            png = download(TERRARIUM_URL.format(z=TERRARIUM_ZOOM, x=tx, y=ty))
            t = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.float64)
            metres = t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768
            mosaic[ty * 256:(ty + 1) * 256, tx * 256:(tx + 1) * 256] = metres

    land = np.maximum(mosaic, 0)   # sea floor and below-sea-level land -> flat at 0

    # Which mosaic row holds each latitude? (Web Mercator stops at about 85.05 N/S;
    # cells nearer the poles reuse the last row.)
    def merc_row(lat):
        lat = max(min(lat, 85.0511), -85.0511)
        y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2
        return min(int(y * size), size - 1)

    # Longitude is evenly spaced in Mercator, so each grid column covers a fixed slice of
    # mosaic columns (2048 / 360 is not a whole number, so slices are 5 or 6 columns wide).
    col_starts = (np.arange(cols) * size) // cols
    col_widths = np.diff(np.append(col_starts, size))

    heights = np.zeros((rows, cols), dtype=np.float64)
    for r in range(rows):
        north = 90 - r * CELL_DEG
        south = north - CELL_DEG
        top, bottom = merc_row(north), merc_row(south)
        band = land[top:max(bottom, top + 1), :].mean(axis=0)   # average of the rows inside this cell
        heights[r] = np.add.reduceat(band, col_starts) / col_widths
    return np.round(heights).astype("<i2")


def main():
    global CELL_DEG, TERRARIUM_ZOOM, OUT_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=float, default=CELL_DEG, help="cell size in degrees (1.0 or 0.5)")
    ap.add_argument("--zoom", type=int, default=TERRARIUM_ZOOM, help="Terrarium zoom (3 for 1.0, 4 for 0.5)")
    args = ap.parse_args()
    CELL_DEG, TERRARIUM_ZOOM = args.cell, args.zoom
    OUT_DIR = os.path.join(HERE, "..", "assets", "globe", "1p0" if CELL_DEG == 1.0 else str(CELL_DEG).replace(".", "p"))
    rows, cols = int(180 / CELL_DEG), int(360 / CELL_DEG)
    os.makedirs(OUT_DIR, exist_ok=True)

    colour = build_colour(rows, cols)
    Image.fromarray(colour, "RGB").save(os.path.join(OUT_DIR, "colour.png"), optimize=True)

    height = build_height(rows, cols)
    height.tofile(os.path.join(OUT_DIR, "height.bin"))

    meta = {
        "cellDeg": CELL_DEG,
        "rows": rows,
        "cols": cols,
        "order": "row 0 = northernmost (90N), column 0 = westernmost (180W)",
        "heightFile": "height.bin (little-endian int16, metres, sea and below-sea-level = 0)",
        "heightExaggeration": HEIGHT_EXAGGERATION,
        "maxHeightM": int(height.max()),
        "sources": {
            "colour": "NASA GIBS, BlueMarble_ShadedRelief_Bathymetry (WMS, EPSG:4326)",
            "height": f"AWS Terrain Tiles (Terrarium), zoom {TERRARIUM_ZOOM}, cell-averaged",
        },
        "resolution": f"{CELL_DEG} degree cells ({rows} x {cols})",
    }
    with open(os.path.join(OUT_DIR, "globe.json"), "w") as f:
        json.dump(meta, f, indent=2)

    total = sum(os.path.getsize(os.path.join(OUT_DIR, p)) for p in os.listdir(OUT_DIR))
    print(f"Done: {rows} x {cols} cells, highest cell {meta['maxHeightM']} m, {total / 1024:.0f} KB in {os.path.relpath(OUT_DIR, os.path.join(HERE, '..'))}")


if __name__ == "__main__":
    main()
