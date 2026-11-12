"""T067 fix 2 and D-146 tests on the rebuilt wind cost files.

  python3 -I test_costs.py <repo root>
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
D = ROOT / "deployment/data"
cap = pd.read_csv(D / "voronoi_local_capex.csv").set_index("location_id")
res = pd.read_csv(D / "voronoi_wind_resource.csv").set_index("location_id")
sites = pd.read_csv(ROOT / "scripts/wind_costs/inputs/offshore_sites.csv").set_index("location_id")
fails = 0


def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m)
    fails += not c


# fix 2
ok((sites.shore_method == "area_weighted_best20").all(), f"all {len(sites)} offshore cost sites are area-weighted best-20% means")
ok(not cap.wind_off_class.str.startswith("floating").any(), "no floating class (the priced area is screened at <= 60 m)")
v = res.index[res.off_viable == 1].intersection(cap.index)
ok(cap.loc[v, "wind_off_class"].ne("none").all(), f"every viable offshore cell in the cost file is priced ({len(v)})")
for lid in (3508, 4894):
    ok(abs(cap.at[lid, "wind_off_shore_km"] - sites.at[lid, "shore_km"]) < 0.06,
       f"NL {lid}: priced at {cap.at[lid, 'wind_off_shore_km']} km, {cap.at[lid, 'wind_off_depth_m']} m ({cap.at[lid, 'wind_off_class']})")
ok((sites.depth_m <= 60.05).all(), "area-mean depth inside the <= 60 m screen")
near = sites[sites.shore_km < 10]
print(f"INFO {len(near)} zones have an area-mean distance to the Natural Earth coast < 10 km (the 10 km screen uses the "
      f"ETOPO shoreline; costing clamps distance to >= 10 km): {near.index.tolist()[:12]}")
# D-146 onshore
iso = cap.wind_iso3
ok((cap.loc[iso == "CHN", "wind_on_2024"] == 789.1).all(), "China onshore = IRENA 2025 single year 789.1")
ok((cap.loc[iso.isin(["SAU", "ARE", "QAT", "OMN", "KWT", "BHR", "TKM", "KGZ", "TJK"]), "wind_on_2024"] == 1377.0).all(),
   "Gulf and Central Asia without own IRENA value = mean(EGY 1396.3, UZB 1382.0, KAZ 1352.6) = 1377.0")
ok((cap.loc[iso == "KAZ", "wind_on_2024"] == 1352.6).all() and (cap.loc[iso == "UZB", "wind_on_2024"] == 1305.6).all(),
   "KAZ and UZB keep their own IRENA values")
# D-146 offshore
ok(cap.wind_cost_src[iso == "KOR"].str.contains("f4.4:KOR").all(), "Korea offshore on IRENA fig 4.4 (4,637 $/kW, 2025)")
for y in (2024, 2035, 2050):
    ok((cap[f"wind_off_fixed_{y}"] >= 1.5 * cap[f"wind_on_{y}"] - 0.11).all(), f"offshore >= 1.5 x onshore everywhere, {y}")
ok((cap.loc[iso == "JPN", "wind_off_flags"].fillna("").str.contains("offshore_floor")).all(), "Japan offshore at the floor (no METI value sourced)")
print("ALL PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
