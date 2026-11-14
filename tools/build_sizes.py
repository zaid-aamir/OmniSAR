"""
Real sizes of the NASA files behind each verdict, for the "From gigabytes to your browser" panel.

Run (from the repo folder, after the case scripts):   py tools/build_sizes.py

For every file in each case's chain of custody (cases/<case>.numbers.json -> provenance.nasa_files),
it looks for the finished file in data/gcov or data/insar and records its size in bytes. A file
that isn't on this laptop gets null, and the app shows "not measured" for it. Writes
cases/nasa_file_sizes.json.
"""

import datetime as dt
import json
import os

import nisar_io as nio

CASES = ["jebel-ali", "big-sur", "tonle-sap", "jakarta", "al-ain"]
FOLDERS = [os.path.join(nio.PROJECT, "data", "gcov"), os.path.join(nio.PROJECT, "data", "insar")]


def main():
    out = {"about": "Byte sizes of the NASA NISAR files listed in each case's chain of custody, measured on the team laptop "
                    "(os.path.getsize of the finished .h5). null = file not on the laptop. Written by tools/build_sizes.py.",
           "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "cases": {}}
    for case in CASES:
        n = json.load(open(os.path.join(nio.REPO, "cases", f"{case}.numbers.json"), encoding="utf-8"))
        files = {}
        for f in n["provenance"]["nasa_files"]:
            name = f["file"]
            path = next((os.path.join(d, name) for d in FOLDERS if os.path.isfile(os.path.join(d, name))), None)
            files[name] = os.path.getsize(path) if path else None
        out["cases"][case] = {"files": files, "total_bytes": sum(v for v in files.values() if v),
                              "missing": [k for k, v in files.items() if v is None]}
        print(case, f"{out['cases'][case]['total_bytes'] / 1e9:.2f} GB", "missing:", out["cases"][case]["missing"])
    with open(os.path.join(nio.REPO, "cases", "nasa_file_sizes.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()
