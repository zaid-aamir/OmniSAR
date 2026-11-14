"""
Ground heights for the blocky case terrain, from AWS Terrarium elevation tiles (public, no login).

Terrarium tiles are ordinary PNG map tiles where each pixel's colour encodes a height:
    height in metres = R * 256 + G + B / 256 - 32768
We download the zoom-12 tiles that cover a case (about 30-38 m per pixel), keep a copy in
NASA hackathon\\research\\cache\\terrarium\\ (outside the repo) so re-runs don't download again,
and read the height at each block centre with bilinear interpolation.

Note: Terrarium in cities is mostly SRTM, a SURFACE model, so tall buildings can add height.
"""

import io
import math
import os
import urllib.request

import numpy as np
from PIL import Image

import nisar_io as nio

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CACHE = os.path.join(nio.PROJECT, "research", "cache", "terrarium")
SOURCE = "AWS Terrarium elevation tiles, zoom 12 (s3.amazonaws.com/elevation-tiles-prod)"


def _tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": "OmniSAR-processing/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768


def heights(lats, lons, z=12):
    """Height in metres at each (lat, lon). Works on numpy arrays of any shape."""
    lats = np.asarray(lats, dtype=np.float64)
    lons = np.asarray(lons, dtype=np.float64)
    n = 2 ** z
    # Web-Mercator pixel position (256-pixel tiles)
    px = (lons + 180) / 360 * n * 256
    lat_r = np.radians(lats)
    py = (1 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / math.pi) / 2 * n * 256
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256) + 1
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256) + 1
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = _tile(z, tx, ty)
    # bilinear sample (pixel centres at +0.5)
    fx = px - tx0 * 256 - 0.5
    fy = py - ty0 * 256 - 0.5
    x0 = np.clip(np.floor(fx).astype(int), 0, mosaic.shape[1] - 2)
    y0 = np.clip(np.floor(fy).astype(int), 0, mosaic.shape[0] - 2)
    ax = np.clip(fx - x0, 0, 1)
    ay = np.clip(fy - y0, 0, 1)
    top = mosaic[y0, x0] * (1 - ax) + mosaic[y0, x0 + 1] * ax
    bot = mosaic[y0 + 1, x0] * (1 - ax) + mosaic[y0 + 1, x0 + 1] * ax
    return top * (1 - ay) + bot * ay


def grid_heights(x_centres, y_centres, proj):
    """Heights for every block of a UTM grid (x = column centres, y = row centres)."""
    X, Y = np.meshgrid(np.asarray(x_centres, dtype=np.float64), np.asarray(y_centres, dtype=np.float64))
    lon, lat = nio.utm_to_lonlat(X, Y, proj)
    return heights(lat, lon)
