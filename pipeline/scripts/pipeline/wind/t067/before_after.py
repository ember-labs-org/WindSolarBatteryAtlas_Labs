"""T067 before/after tables per affected region (CSV, plus summary lines for the report).

  python3 -I before_after.py --before <T063 data> --after <T067 data> --run ~/wind-atlas-T067 --out <dir>

Writes:
  T067_fix1_regions.csv   every region whose wind resource row changed (fix 1): onshore/offshore area,
                          level, simulated CF, site, viability
  T067_fix2_offshore.csv  every offshore cell: cost depth/distance/class/capex before and after
  (fix 3's table is scripts/wind_costs/out/local_capex_mapping_t067.csv)
  T067_unit_lcoe.csv      every region: Local standalone LCOE 2026 before and after (all fixes)
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", type=Path, required=True)
    ap.add_argument("--after", type=Path, required=True)
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    out = a.out
    oc = pd.read_csv(a.after / "voronoi_overlapping_countries.csv").set_index("location_id")[["country_iso3", "country_name"]]
    # ---------------- fix 1
    rb = pd.read_csv(a.before / "voronoi_wind_resource.csv").set_index("location_id")
    ra = pd.read_csv(a.after / "voronoi_wind_resource.csv").set_index("location_id")
    lines_b = (a.before / "voronoi_wind_resource.csv").read_text().splitlines()[1:]
    lines_a = (a.after / "voronoi_wind_resource.csv").read_text().splitlines()[1:]
    ch = [int(x.split(",")[0]) for x, y in zip(lines_b, lines_a) if x != y]
    cols = ["on_area_km2", "on_cf_target", "on_final_cf", "on_viable", "on_site_lat", "on_site_lon",
            "off_area_km2", "off_cf_target", "off_final_cf", "off_viable", "off_site_lat", "off_site_lon", "off_floating_area_km2"]
    t = pd.concat({"before": rb.loc[ch, cols], "after": ra.loc[ch, cols]}, axis=1)
    t.columns = [f"{c}_{w}" for w, c in t.columns]
    t = oc.reindex(ch).join(t)
    t.to_csv(out / "T067_fix1_regions.csv", float_format="%.4f")
    s = [f"fix 1: {len(ch)} deployed regions' resource rows change"]
    for tag in ("on", "off"):
        gained = ((t[f"{tag}_viable_before"] == 0) & (t[f"{tag}_viable_after"] == 1)).sum()
        lost = ((t[f"{tag}_viable_before"] == 1) & (t[f"{tag}_viable_after"] == 0)).sum()
        d = (t[f"{tag}_area_km2_after"] - t[f"{tag}_area_km2_before"])
        s.append(f"  {tag}: viable gained {gained}, lost {lost}; eligible area {d.sum():+,.0f} km2 "
                 f"(regions up {int((d > 0.5).sum())}, down {int((d < -0.5).sum())})")
    # ---------------- unit LCOE (all fixes)
    ub = pd.read_csv(a.run / "results/unit_lcoe_before.csv").set_index("location_id")
    ua = pd.read_csv(a.run / "results/unit_lcoe_after.csv").set_index("location_id")
    u = ub.join(ua, lsuffix="_before", rsuffix="_after")
    u.to_csv(out / "T067_unit_lcoe.csv", float_format="%.4f")
    for c in ("solar", "on", "off"):
        r = (u[f"lcoe_{c}_local_after"] / u[f"lcoe_{c}_local_before"]).replace([np.inf, -np.inf], np.nan).dropna()
        s.append(f"Local standalone LCOE 2026 {c}: median after/before {r.median():.3f}; changed (>0.05%) in {int(((r - 1).abs() > 5e-4).sum())} regions")
    # ---------------- fix 2
    cb = pd.read_csv(a.before / "voronoi_local_capex.csv").set_index("location_id")
    ca = pd.read_csv(a.after / "voronoi_local_capex.csv").set_index("location_id")
    k = ["wind_off_class", "wind_off_depth_m", "wind_off_shore_km", "wind_off_2024", "wind_off_flags"]
    f2 = oc.join(cb[k].add_suffix("_before")).join(ca[k].add_suffix("_after"))
    f2 = f2[(f2.wind_off_class_before != "none") | (f2.wind_off_class_after != "none")]
    f2["capex_change_pct"] = (f2.wind_off_2024_after / f2.wind_off_2024_before - 1) * 100
    f2.to_csv(out / "T067_fix2_offshore.csv", float_format="%.2f")
    s.append("fix 2 classes before " + str(cb.wind_off_class.value_counts().to_dict()) + " after " + str(ca.wind_off_class.value_counts().to_dict()))
    dc = f2[f2.wind_off_class_before == "fixed_dc"]
    s.append(f"fix 2: the {len(dc)} fixed_dc cells after: {dc.wind_off_class_after.value_counts().to_dict()}; "
             f"median shore {dc.wind_off_shore_km_before.median():.0f} -> {dc.wind_off_shore_km_after.median():.0f} km; "
             f"median capex change {dc.capex_change_pct.median():+.1f}%")
    both = f2[(f2.wind_off_class_before != "none") & (f2.wind_off_class_after != "none")]
    s.append(f"fix 2: {len(both)} cells priced both times: median capex change {both.capex_change_pct.median():+.1f}%, "
             f"p10 {both.capex_change_pct.quantile(.1):+.1f}%, p90 {both.capex_change_pct.quantile(.9):+.1f}%")
    (out / "T067_before_after_summary.txt").write_text("\n".join(s) + "\n")
    print("\n".join(s))


if __name__ == "__main__":
    main()
