"""
Shared helpers for reading NISAR HDF5 files (GCOV radar images and GUNW interferograms).
Used by tools/inspect_gcov.py and tools/inspect_gunw.py, and later by the Stage 2 pipeline.

The idea: NISAR files are huge (2-6 GB) but stored in 512 x 512 pixel chunks. If we work out
which rows and columns cover our case box, h5py only reads (and unzips) the chunks we need,
so reading one case box takes seconds and a few MB of memory instead of the whole file.

Needs: numpy, h5py, Pillow (py -m pip install numpy h5py pillow). No pyproj needed.
"""

import json
import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))


def _find_project():
    """The hackathon folder that holds data\\ and research\\ (normally two levels above the repo).
    We walk up from the repo until we find a folder containing both, so the scripts still work
    from a copy of the repo somewhere else. Set OMNISAR_PROJECT to point at it explicitly."""
    if os.environ.get("OMNISAR_PROJECT"):
        return os.environ["OMNISAR_PROJECT"]
    d = REPO
    while True:
        if os.path.isdir(os.path.join(d, "data")) and os.path.isdir(os.path.join(d, "research")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.normpath(os.path.join(REPO, "..", ".."))
        d = parent


PROJECT = _find_project()


def case_box(case_id):
    """Return (west, south, east, north) in degrees for a case, from cases/index.json
    (the one place case boxes are written down, so scripts and the app never disagree)."""
    with open(os.path.join(REPO, "cases", "index.json"), encoding="utf-8") as f:
        for case in json.load(f)["cases"]:
            if case["id"] == case_id:
                return tuple(case["box"])
    raise KeyError(f"no case '{case_id}' in cases/index.json")


def finished_h5(folder, must_contain=""):
    """List finished .h5 files in a folder, sorted by name. Files still downloading end in
    .h5.part and are never opened (they are incomplete and would crash or give wrong data)."""
    names = [n for n in os.listdir(folder) if n.endswith(".h5") and must_contain in n]
    return [os.path.join(folder, n) for n in sorted(names)]


def projection_params(proj_ds):
    """Read the map projection stored in a NISAR 'projection' dataset.
    Its value is the EPSG code (e.g. 32640 = WGS 84 / UTM zone 40N); its attributes hold the
    transverse Mercator settings. If an attribute is missing we work it out from the EPSG code."""
    epsg = int(proj_ds[()])
    a = proj_ds.attrs
    if not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
        raise ValueError(f"EPSG {epsg} is not a UTM zone; this helper only handles UTM")
    zone = epsg % 100
    return {
        "epsg": epsg,
        "lon0": float(a.get("longitude_of_central_meridian", zone * 6 - 183)),
        "k0": float(a.get("scale_factor_at_central_meridian", 0.9996)),
        "false_easting": float(a.get("false_easting", 500000.0)),
        "false_northing": float(a.get("false_northing", 10000000.0 if epsg > 32700 else 0.0)),
    }


def lonlat_to_utm(lon, lat, p):
    """Convert one lon/lat point (degrees, WGS 84) to UTM easting/northing in metres.
    This is the standard Krueger series for the transverse Mercator projection (the same maths
    map libraries use); it is accurate to well under a millimetre inside a UTM zone."""
    a = 6378137.0                      # WGS 84 equator radius (m)
    f = 1 / 298.257223563              # WGS 84 flattening
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    alpha = (n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16,
             13 * n ** 2 / 48 - 3 * n ** 3 / 5,
             61 * n ** 3 / 240)
    phi = math.radians(lat)
    lam = math.radians(lon - p["lon0"])
    c = 2 * math.sqrt(n) / (1 + n)
    t = math.sinh(math.atanh(math.sin(phi)) - c * math.atanh(c * math.sin(phi)))
    xi = math.atan2(t, math.cos(lam))
    eta = math.atanh(math.sin(lam) / math.sqrt(1 + t * t))
    e = eta + sum(alpha[j] * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j in range(3))
    nn = xi + sum(alpha[j] * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j in range(3))
    return p["false_easting"] + p["k0"] * A * e, p["false_northing"] + p["k0"] * A * nn


def utm_to_lonlat(x, y, p):
    """The reverse of lonlat_to_utm: UTM easting/northing (m) -> (lon, lat) in degrees.
    Same Krueger series run backwards; works on single numbers or numpy arrays."""
    a = 6378137.0
    f = 1 / 298.257223563
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    beta = (n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96,
            n ** 2 / 48 + n ** 3 / 15,
            17 * n ** 3 / 480)
    delta = (2 * n - 2 * n ** 2 / 3 - 2 * n ** 3,
             7 * n ** 2 / 3 - 8 * n ** 3 / 5,
             56 * n ** 3 / 15)
    xi = (np.asarray(y, dtype=np.float64) - p["false_northing"]) / (p["k0"] * A)
    eta = (np.asarray(x, dtype=np.float64) - p["false_easting"]) / (p["k0"] * A)
    xi2 = xi - sum(beta[j] * np.sin(2 * (j + 1) * xi) * np.cosh(2 * (j + 1) * eta) for j in range(3))
    eta2 = eta - sum(beta[j] * np.cos(2 * (j + 1) * xi) * np.sinh(2 * (j + 1) * eta) for j in range(3))
    chi = np.arcsin(np.sin(xi2) / np.cosh(eta2))
    lat = chi + sum(delta[j] * np.sin(2 * (j + 1) * chi) for j in range(3))
    lon = np.radians(p["lon0"]) + np.arctan2(np.sinh(eta2), np.cos(xi2))
    return np.degrees(lon), np.degrees(lat)


def multilook(power, k):
    """Speckle filter: average each k x k block of LINEAR power into one pixel (a 'boxcar' or
    'multilook' filter). A block counts only if all k*k pixels are valid, so edges and gaps stay
    empty instead of being half-averaged. Returns the smaller array."""
    h, w = (power.shape[0] // k) * k, (power.shape[1] // k) * k
    blocks = power[:h, :w].reshape(h // k, k, w // k, k)
    return blocks.mean(axis=(1, 3))          # any NaN in a block makes that block NaN


def label_clusters(flag):
    """Group touching True pixels into clusters (8-connected: diagonals count as touching).
    Returns a list of clusters, each a numpy array of (row, col) pairs. Written without scipy:
    a simple flood fill that only visits the flagged pixels, so it is fast when change is rare."""
    flag = np.asarray(flag, dtype=bool)
    seen = np.zeros_like(flag)
    rows, cols = flag.shape
    clusters = []
    for r0, c0 in zip(*np.nonzero(flag)):
        if seen[r0, c0]:
            continue
        seen[r0, c0] = True
        stack, members = [(r0, c0)], []
        while stack:
            r, c = stack.pop()
            members.append((r, c))
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < rows and 0 <= cc < cols and flag[rr, cc] and not seen[rr, cc]:
                        seen[rr, cc] = True
                        stack.append((rr, cc))
        clusters.append(np.array(members))
    return clusters


GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"


def gibs_wms(layer, date, west, south, east, north, width, height):
    """Download one picture from NASA GIBS (public, no login) for a lon/lat box and a date.
    Returns (PIL RGBA image, the exact URL). WMS 1.3.0 with EPSG:4326 wants the box as
    south,west,north,east (latitude first)."""
    import io
    import urllib.parse
    import urllib.request
    from PIL import Image
    q = urllib.parse.urlencode({
        "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": layer,
        "CRS": "EPSG:4326", "BBOX": f"{south},{west},{north},{east}",
        "WIDTH": int(width), "HEIGHT": int(height), "FORMAT": "image/png", "TIME": date,
    })
    url = f"{GIBS_WMS}?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "OmniSAR-processing/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        img = Image.open(io.BytesIO(r.read())).convert("RGBA")
    return img, url


def box_window(box, x_coords, y_coords, p):
    """Find the rows/columns of a grid that cover a lon/lat box.
    A lon/lat box is slightly tilted on a UTM map, so we convert points all along its four edges
    and take the smallest UTM rectangle that contains them (so nothing in the box is cut off).
    Returns (row0, row1, col0, col1) for slicing [row0:row1, col0:col1], plus the UTM rectangle."""
    w, s, e, n = box
    pts = []
    for i in range(21):
        u = i / 20
        lon = w + (e - w) * u
        lat = s + (n - s) * u
        pts += [(lon, s), (lon, n), (w, lat), (e, lat)]
    xy = [lonlat_to_utm(lon, lat, p) for lon, lat in pts]
    xmin, xmax = min(q[0] for q in xy), max(q[0] for q in xy)
    ymin, ymax = min(q[1] for q in xy), max(q[1] for q in xy)

    x = np.asarray(x_coords)
    y = np.asarray(y_coords)
    if not (x[0] < x[-1] and y[0] > y[-1]):
        raise ValueError("expected x increasing (west to east) and y decreasing (north to south)")
    col0 = int(np.searchsorted(x, xmin, side="left"))
    col1 = int(np.searchsorted(x, xmax, side="right"))
    row0 = int(np.searchsorted(-y, -ymax, side="left"))     # y goes down, so search on -y
    row1 = int(np.searchsorted(-y, -ymin, side="right"))
    if col1 <= col0 or row1 <= row0:
        raise ValueError("the case box is outside this file's grid")
    return (row0, row1, col0, col1), (xmin, ymin, xmax, ymax)


def power_to_db(power):
    """Radar backscatter is stored as linear power; decibels = 10 * log10(power).
    Zero or negative values have no dB value and become NaN (not a number)."""
    power = np.asarray(power, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(power > 0, 10 * np.log10(power), np.nan)


def block_mean(arr, k):
    """Shrink an image k times by averaging each k x k block, ignoring NaN pixels.
    Averaging (rather than skipping pixels) also smooths radar speckle in the preview."""
    if k <= 1:
        return arr
    h, w = (arr.shape[0] // k) * k, (arr.shape[1] // k) * k
    blocks = arr[:h, :w].reshape(h // k, k, w // k, k)
    with np.errstate(invalid="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)   # all-NaN blocks -> NaN
            return np.nanmean(blocks, axis=(1, 3))


def stretch(arr, lo, hi):
    """Map values lo..hi onto 0..255 for a picture (fixed limits, so two dates are comparable).
    NaN becomes 0 (black)."""
    out = (np.asarray(arr, dtype=np.float64) - lo) / (hi - lo)
    out = np.clip(np.nan_to_num(out, nan=0.0), 0, 1)
    return (out * 255).round().astype(np.uint8)


def print_tree(group, indent="  ", max_depth=None, _depth=0):
    """Print the groups and datasets under an HDF5 group: name, shape, type, chunking."""
    import h5py
    for name, obj in group.items():
        if isinstance(obj, h5py.Dataset):
            extra = f" chunks={obj.chunks}" if obj.chunks else ""
            print(f"{indent * (_depth + 1)}{name}  {obj.shape} {obj.dtype}{extra}")
        else:
            print(f"{indent * (_depth + 1)}{name}/")
            if max_depth is None or _depth + 1 < max_depth:
                print_tree(obj, indent, max_depth, _depth + 1)


def describe(label, arr, unit=""):
    """One line of statistics for a layer: valid share, min, max, percentiles."""
    arr = np.asarray(arr, dtype=np.float64)
    ok = np.isfinite(arr)
    if not ok.any():
        print(f"  {label}: no valid pixels")
        return
    v = arr[ok]
    p1, p50, p99 = np.percentile(v, [1, 50, 99])
    print(f"  {label}: valid {ok.mean():.1%} | min {v.min():.4g} max {v.max():.4g} | "
          f"1% {p1:.4g}  median {p50:.4g}  99% {p99:.4g} {unit}")
