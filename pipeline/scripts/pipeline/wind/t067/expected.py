"""T067 expectations for the land-mask rerun, written before the harness runs.

From the old (T061) and new eligibility rasters alone, predicts which regions'
siting rows can change:
  on_changed   onshore eligibility changes inside the region's onshore zone
               (published land-clipped Voronoi cell) -> on_* columns change
  off_changed  an eligible or formerly eligible sea pixel nearest to the
               region's point changes -> off_* columns change
  float_changed  floating (report-only) area changes for the region's point ->
               off_floating_area_km2 only (added after the first site run: the
               first version missed this column; disclosed in the report)
  focal_only   no eligibility change in the zone, but a changed pixel lies within
               the focal window (2 px) of a zone pixel: the site *may* move
Every other region's resource row must be byte-identical, and so must its
profiles, summary slices, daily rows and add-on rows.

  python3 -I -m t067.expected --run ~/wind-atlas-T067
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .landmask import grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, default=Path.home() / "wind-atlas-T067")
    ap.add_argument("--ws", type=Path, default=Path.home() / "wind-atlas-T061" / "ws_mirror")
    a = ap.parse_args()
    G = grid()
    from rasterio import features
    from scipy import ndimage
    from scipy.spatial import cKDTree
    z = np.load(a.run / "cache" / "landmask_diff.npz")
    pts = pd.read_csv(a.ws / "outputs" / "voronoi_points.csv")
    ids = pts["location_id"].to_numpy()
    idx = {int(v): i for i, v in enumerate(ids)}
    gj = json.loads((a.ws / "outputs" / "voronoi_cells.geojson").read_text())
    zone_on = features.rasterize([(f["geometry"], idx[int(f["properties"]["location_id"])] + 1)
                                  for f in gj["features"] if int(f["properties"]["location_id"]) in idx],
                                 out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH), transform=G.grid_transform(),
                                 fill=0, dtype="int32")
    d_on = z["on_old"] != z["on_new"]
    d_off = z["off_old"] != z["off_new"]
    on_reg = set(np.unique(zone_on[d_on]).tolist()) - {0}
    r, c = np.nonzero(d_off)
    lat = G.GRID_NORTH - (r + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (c + 0.5) * G.GRID_RES
    _, nn = cKDTree(pts[["longitude", "latitude"]].to_numpy()).query(np.column_stack([lon, lat]), k=1, workers=4)
    off_reg = set((nn + 1).tolist())
    r, c = np.nonzero(z["fl_old"] != z["fl_new"])
    _, nn = cKDTree(pts[["longitude", "latitude"]].to_numpy()).query(
        np.column_stack([G.GRID_WEST + (c + 0.5) * G.GRID_RES, G.GRID_NORTH - (r + 0.5) * G.GRID_RES]), k=1, workers=4)
    fl_reg = set((nn + 1).tolist())
    # focal window 4 px, centred: changed pixels within 2 px of a zone pixel
    near_on = ndimage.binary_dilation(d_on, structure=np.ones((5, 5), bool))
    focal_on = set(np.unique(zone_on[near_on]).tolist()) - {0} - on_reg
    excl = {r["location_id"] for r in json.loads(
        (Path(__file__).resolve().parents[3] / "exclude_regions" / "excluded_regions.json").read_text())["regions"]}
    rows = []
    for k in sorted(on_reg | off_reg | focal_on | fl_reg):
        lid = int(ids[k - 1])
        m_on = zone_on == k if k in on_reg else None
        rows.append({"location_id": lid, "excluded": int(lid in excl),
                     "on_changed": int(k in on_reg), "off_changed": int(k in off_reg),
                     "focal_only": int(k in focal_on),
                     "float_changed": int(k in fl_reg)})
    df = pd.DataFrame(rows)
    out = a.run / "results" / "T067_expected_regions.csv"
    df.to_csv(out, index=False)
    dep = df[df.excluded == 0]
    print(f"regions with any predicted change: {len(df)} ({len(dep)} deployed)")
    print(f"  deployed on_changed {int(dep.on_changed.sum())}, off_changed {int(dep.off_changed.sum())}, "
          f"focal_only {int(dep.focal_only.sum())}, floating {int(dep.float_changed.sum())}")
    print(f"  excluded (Antarctica/Greenland) {int(df.excluded.sum())}")


if __name__ == "__main__":
    main()
