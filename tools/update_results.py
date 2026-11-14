"""
Write cases/results.json: the list of cases whose measurements are finished.
Run:  py tools/update_results.py      (every processing script also calls it at the end)

Why this file exists: the app needs to know which cases have real numbers. It could ask the
server for each cases/<id>.numbers.json, but a missing file shows up as a red 404 error in the
browser console. Instead, this script looks at the folder and writes down what is really there,
and the app reads this one file. The status is still worked out from the files, never typed.
"""

import datetime as dt
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CASES_DIR = os.path.normpath(os.path.join(HERE, "..", "cases"))


def _reject(name):
    raise ValueError(f"{name} is not valid JSON for a browser - fix the script that wrote this file")


def update():
    measured = {}
    for path in sorted(glob.glob(os.path.join(CASES_DIR, "*.numbers.json"))):
        with open(path, encoding="utf-8") as f:
            json.load(f, parse_constant=_reject)           # refuse a file that isn't valid JSON (incl. NaN)
        case_id = os.path.basename(path)[: -len(".numbers.json")]
        measured[case_id] = "cases/" + os.path.basename(path)

    out = {
        "about": "Cases whose numbers file exists. Written by tools/update_results.py - do not edit by hand.",
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "measured": measured,
    }
    with open(os.path.join(CASES_DIR, "results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"results.json: {len(measured)} measured case(s)", list(measured) or "")


if __name__ == "__main__":
    update()
