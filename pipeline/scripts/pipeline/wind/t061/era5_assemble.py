"""Check the fresh ERA5 2024 fetch against the workspace file and install it (T061 Phase D).

Every point whose (parked) coordinates are unchanged between the old and new
resource CSVs must be bit-identical to the workspace era5_speed_2024.npz (same
store, same bilinear weights, same float32 arithmetic). Only then is the fresh
file installed as <ws_D>/outputs/wind/era5_speed_2024.npz (a real file, same keys).
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C


def parked(df, tag):
    la = df[f"{tag}_site_lat"].to_numpy().copy()
    lo = df[f"{tag}_site_lon"].to_numpy().copy()
    bad = ~np.isfinite(la) | ~np.isfinite(lo)
    la[bad] = df["latitude"].to_numpy()[bad]
    lo[bad] = df["longitude"].to_numpy()[bad]
    return la, lo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", type=Path, required=True)
    ap.add_argument("--workspace-npz", type=Path, required=True)
    ap.add_argument("--old-resource", type=Path, required=True)
    ap.add_argument("--new-resource", type=Path, required=True)
    ap.add_argument("--install", type=Path, required=True)
    a = ap.parse_args()
    f, w = dict(np.load(a.fresh)), dict(np.load(a.workspace_npz))   # decompress once
    old, new = pd.read_csv(a.old_resource), pd.read_csv(a.new_resource)
    assert (f["location_id"] == w["location_id"]).all() and (old.location_id == new.location_id).all()
    assert (f["location_id"] == new.location_id.to_numpy()).all() and int(f["hour0"]) == int(w["hour0"])
    bad = 0
    print("centre: identical" if np.array_equal(f["centre"], w["centre"]) else "centre: DIFFERS")
    bad += not np.array_equal(f["centre"], w["centre"])
    for tag in ("on", "off"):
        lo_, la_ = parked(old, tag), parked(new, tag)
        same = (lo_[0] == la_[0]) & (lo_[1] == la_[1])
        eq = np.array([np.array_equal(f[tag][:, i], w[tag][:, i]) for i in range(len(new))])
        print(f"{tag}: points with unchanged coordinates {same.sum()}, of which bit-identical {int((eq & same).sum())}; "
              f"moved {int((~same).sum())}, of which still identical {int((eq & ~same).sum())}")
        bad += int((same & ~eq).sum())
    if bad:
        raise SystemExit("fresh fetch does not reproduce the workspace file at unchanged points")
    dst = C.guard_write(a.install)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(a.fresh, dst)
    print(f"installed {dst}")


if __name__ == "__main__":
    main()
