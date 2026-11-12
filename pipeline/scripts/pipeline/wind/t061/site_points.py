"""How many of today's chosen site pixels a variant makes (partly) ineligible
(T061, audit F6; produced C_site_points_note.txt at gate C).

  cd pipeline/scripts/pipeline/wind && \
  python3 -m t061.site_points --variant new500_t20 --no-cap --resource <deployment/data/voronoi_wind_resource.csv>
(not with -I: isolated mode drops the current directory from sys.path, so t061 is not found).
The gate C note was made before the F3 cap, hence --no-cap; "reduced" counts sites whose
eligible share fell at all (952 without the cap; 1,116 with it, as the audit found).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from . import run_bc as RB


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="new500_t20")
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--no-cap", action="store_true", help="as at gate C (before the F3 cap)")
    a = ap.parse_args()
    S, G = C.import_siting()
    px = C.load_pixels()
    L = RB.Layers(px)
    on, off = RB.variant_elig(px, L, RB.VARIANTS[a.variant], cap_pa=not a.no_cap)
    d = pd.read_csv(a.resource)
    for tag, el, old in (("on", on, px["on_elig"]), ("off", off, px["off_elig"])):
        r = ((G.GRID_NORTH - d[f"{tag}_site_lat"]) / G.GRID_RES - 0.5).round().astype("Int64")
        c = ((d[f"{tag}_site_lon"] - G.GRID_WEST) / G.GRID_RES - 0.5).round().astype("Int64")
        ok = r.notna()
        flat = (r[ok].astype(int) * G.GRID_WIDTH + c[ok].astype(int)).to_numpy()
        pos = np.clip(np.searchsorted(px[f"{tag}_flat"], flat), 0, len(px[f"{tag}_flat"]) - 1)
        found = px[f"{tag}_flat"][pos] == flat
        ne = np.where(found, el[pos], 0)
        oe = np.where(found, old[pos], 0)
        print(f"{tag}: {ok.sum()} sites; site pixel found in table {found.sum()}; "
              f"new eligibility 0 at site: {(ne == 0).sum()}; reduced: {(ne < oe).sum()}")


if __name__ == "__main__":
    main()
