"""T054 phase 1: per-region onshore wind statistics for the best-area rule options.

Reuses site_selection.py's own code paths (imported, not re-implemented) for the
GWA layers, the IEC class choice, losses, eligibility weighting, the zone raster
and the area-weighted P90, so the current on_cf_p90 / on_viable can be reproduced
and the new statistics are on exactly the same pixels.

New statistic: for each region and best-area size A, the area-weighted mean net CF
of the best A km2 of eligible land (pixels sorted by net CF, highest first; the
last pixel counted fractionally). If the region has less than A km2 of eligible
land, all of it is used (D-110).

Writes only to --out (a CSV); reads the laptop workspace via the stub config.

Usage (writes only to --scratch; the workspace is read):
    python3 -I onshore_best_area.py --workspace <laptop workspace> --scratch <dir>
Writes <scratch>/region_stats.csv.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd
import rasterio
from rasterio import features


AREAS_KM2 = (100, 200, 500, 1000, 2500, 5000)
EXTRA_THRESHOLDS = (0.15,)


def best_area_means(zi, cfv, wgt, n_zones, areas):
    """Area-weighted mean of cfv over the best `A` km2 of weight in each zone."""
    order = np.lexsort((-cfv, zi))           # by zone, then CF descending
    z, v = zi[order], cfv[order].astype("float64")
    w = wgt[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    starts = np.zeros(n_zones + 1)
    starts[1:] = np.cumsum(total)
    cum_before = np.cumsum(w) - w - starts[z]   # weight above this pixel in its zone
    out = {}
    for a in areas:
        take = np.clip(a - cum_before, 0.0, w)   # fractional last pixel
        num = np.bincount(z, weights=take * v, minlength=n_zones)
        den = np.bincount(z, weights=take, minlength=n_zones)
        out[a] = np.divide(num, den, out=np.full(n_zones, np.nan), where=den > 0)
    best_px = np.full(n_zones, np.nan)
    first = np.ones(z.size, dtype=bool)
    first[1:] = z[1:] != z[:-1]
    best_px[z[first]] = v[first]
    return out, best_px


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", type=Path, required=True)
    ap.add_argument("--scratch", type=Path, required=True)
    ap.add_argument("--losses", type=float, default=0.12)
    args = ap.parse_args()
    from _stub import ensure_pkg
    ensure_pkg(args.workspace, args.scratch)
    global SS, G
    from scripts.pipeline.wind import site_selection as SS
    from scripts.pipeline.wind import gwa_sources as G
    assert args.losses == SS.DEFAULT_LOSSES
    out_csv = args.scratch / "region_stats.csv"
    t0 = time.time()

    points = pd.read_csv(SS.POINTS_CSV)
    n_pts = len(points)
    loc_ids = points["location_id"].to_numpy()
    id_to_idx = {int(v): i for i, v in enumerate(loc_ids)}

    # --- onshore CF layer: verbatim from site_selection.run() ---
    speed = SS._u16_to_float(SS._read_u16("gwa4_wind_speed_100m_002deg.tif"), 100)
    cf = np.full_like(speed, np.nan)
    b1, b2 = G.IEC_SPEED_BREAKS
    for cls, lo, hi in ((3, -np.inf, b1), (2, b1, b2), (1, b2, np.inf)):
        layer = G.IEC_CLASSES[cls]["layer"]
        band = SS._u16_to_float(SS._read_u16(f"gwa4_{layer}_002deg.tif"), 10000)
        sel = (speed > lo) & (speed <= hi) & np.isfinite(band)
        cf[sel] = band[sel]
        del band, sel
    del speed
    with rasterio.open(SS.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        elig_on = s.read(1).astype("float32") / 100.0
    print(f"layers loaded {time.time()-t0:.0f}s", flush=True)

    area = SS.pixel_area_km2()[:, None]
    keep = 1.0 - args.losses

    with open(SS.CELLS_GEOJSON) as fh:
        gj = json.load(fh)
    shapes = [(f["geometry"], id_to_idx[int(f["properties"]["location_id"])] + 1)
              for f in gj["features"] if int(f["properties"]["location_id"]) in id_to_idx]
    zone = features.rasterize(shapes, out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                              transform=G.grid_transform(), fill=0, dtype="int32",
                              all_touched=False)
    print(f"zones rasterised {time.time()-t0:.0f}s", flush=True)

    # --- zonal arrays: verbatim from site_selection.run() ---
    m = (zone > 0) & (elig_on > 0) & np.isfinite(cf)
    zi = (zone[m] - 1).astype("int64")
    cfv = (cf[m] * keep).astype("float32")
    wgt = (elig_on[m] * np.broadcast_to(area, zone.shape)[m]).astype("float32")
    del zone, cf, elig_on, m

    tot_area = np.bincount(zi, weights=wgt, minlength=n_pts)
    good = cfv >= SS.CF_THRESHOLD
    good_area = np.bincount(zi[good], weights=wgt[good], minlength=n_pts)
    qs = SS.weighted_quantiles_by_zone(zi, cfv, wgt, n_pts, qs=(0.5, 0.9))
    out = pd.DataFrame({
        "location_id": loc_ids,
        "latitude": points["latitude"].to_numpy(),
        "longitude": points["longitude"].to_numpy(),
        "on_area_km2": tot_area,
        "on_viable_area_km2": good_area,
        "on_cf_p50": qs[0.5],
        "on_cf_p90": qs[0.9],
        "on_viable_repro": ((qs[0.9] >= SS.CF_THRESHOLD) & (good_area >= SS.MIN_VIABLE_AREA_KM2)).astype("int8"),
    })
    for t in EXTRA_THRESHOLDS:
        g = cfv >= t
        out[f"area_ge_{int(t*100)}_km2"] = np.bincount(zi[g], weights=wgt[g], minlength=n_pts)
    means, best_px = best_area_means(zi, cfv, wgt, n_pts, AREAS_KM2)
    for a, v in means.items():
        out[f"best{a}_cf"] = v
    out["best_pixel_cf"] = best_px
    out.to_csv(out_csv, index=False, float_format="%.6f")
    print(f"wrote {out_csv} ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
