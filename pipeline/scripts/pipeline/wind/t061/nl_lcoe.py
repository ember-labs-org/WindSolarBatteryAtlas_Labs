"""Onshore wind LCOE at local costs (2026) for given regions, old vs new data (T061).

The app's formula for a wind-only MWh with Capex and WACC both Local
(app.js precomputeLcoePerLocation): capex = local wind_on capex interpolated to
2026 between the 2024 and 2035 anchors; O&M = local wind_on_om / capex; WACC =
wind_on_wacc_percent; 25-year life; 0.2%/yr degradation as a levelised factor;
CF = the region's simulated onshore CF (<tag>_final_cf, the profile the app uses).

  LCOE = capex x (CRF + om_share) / (8.76 x CF x degradation)   [$/MWh]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

YEAR, LIFE, DEG = 2026, 25, 0.002


def crf(r, n):
    return r / (1 - (1 + r) ** -n) if r > 0 else 1 / n


def lgm(g, r, n):
    # utils.js levelizedGrowthMultiplier, operation for operation
    ratio = (1 + g) / (1 + r)
    pv = n / (1 + r) if abs(ratio - 1) < 1e-12 else (1 / (1 + g)) * ratio * (1 - ratio ** n) / (1 - ratio)
    return pv * crf(r, n)


def interp(v24, v35, year=YEAR):
    return v24 + (v35 - v24) * (year - 2024) / (2035 - 2024)


def lcoe(capex_row, wacc_row, cf):
    cap = interp(capex_row.wind_on_2024, capex_row.wind_on_2035)
    om = interp(capex_row.wind_on_om_2024, capex_row.wind_on_om_2035)
    r = wacc_row.wind_on_wacc_percent / 100
    return cap * (crf(r, LIFE) + om / cap) / (8.76 * cf * lgm(-DEG, r, LIFE)), cap, om, r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="deployment/data (costs)")
    ap.add_argument("--old", type=Path, required=True)
    ap.add_argument("--new", type=Path, required=True)
    ap.add_argument("--ids", default="4894,3508")
    a = ap.parse_args()
    cx = pd.read_csv(a.data / "voronoi_local_capex.csv").set_index("location_id")
    wc = pd.read_csv(a.data / "voronoi_wacc_wind.csv").set_index("location_id")
    old = pd.read_csv(a.old).set_index("location_id")
    new = pd.read_csv(a.new).set_index("location_id")
    for i in [int(x) for x in a.ids.split(",")]:
        lo, cap, om, r = lcoe(cx.loc[i], wc.loc[i], old.on_final_cf[i])
        ln, *_ = lcoe(cx.loc[i], wc.loc[i], new.on_final_cf[i])
        print(f"{i} ({cx.country_iso3[i]}): capex {cap:.0f} $/kW, O&M {om:.1f} $/kW/yr, WACC {100*r:.2f}%; "
              f"onshore CF {100*old.on_final_cf[i]:.1f}% -> {100*new.on_final_cf[i]:.1f}%; "
              f"LCOE ${lo:.1f} -> ${ln:.1f}/MWh")


if __name__ == "__main__":
    main()
