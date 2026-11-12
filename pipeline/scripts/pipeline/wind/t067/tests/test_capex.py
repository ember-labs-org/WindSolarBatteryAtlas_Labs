"""T067 fix 3 tests: deployment/data/voronoi_local_capex.csv against the T063 version (b627a51).

  python3 -I test_capex.py <repo root>
"""
import csv
import io
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
P = "deployment/data/voronoi_local_capex.csv"
old = list(csv.DictReader(io.StringIO(subprocess.run(["git", "-C", str(ROOT), "show", f"b627a51:{P}"],
                                                     capture_output=True, text=True, check=True).stdout)))
new = list(csv.DictReader(open(ROOT / P)))
oc = {r["location_id"]: r["country_iso3"] for r in csv.DictReader(open(ROOT / "deployment/data/voronoi_overlapping_countries.csv"))}
fails = 0


def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m)
    fails += not c


by = {}
for r in new:
    by.setdefault(oc[r["location_id"]], []).append(r)
reg = lambda iso: Counter(r["region"] for r in by.get(iso, []))
ok(all(r["country_iso3"] for r in new), "no blank country_iso3")
ok(reg("FRA") == Counter({"Europe": 19}) and reg("NOR") == Counter({"Europe": 20}), f"France/Norway on Europe: {reg('FRA')} {reg('NOR')}")
ok(all(float(r["solar_2024"]) == 779.0 and float(r["battery_2024"]) == 128.0 for r in by["FRA"] + by["NOR"]), "France/Norway $779/kW, $128/kWh")
for iso in ("AUS", "NZL", "PNG", "SLB", "NCL", "FJI", "VUT"):
    ok(set(reg(iso)) == {"Oceania"}, f"{iso} on Oceania")
ok(all(float(r["solar_2024"]) == 966.9 for r in by["AUS"]), "Oceania solar $966.9/kW (IRENA RPGC 2025 fig 3.2, Australia 2024)")
ok(reg("CAN") == Counter({"United States": 359}) and {r["region_method"] for r in by["CAN"]} == {"north_america_proxy"},
   f"all Canada one way: {reg('CAN')}")
ok(set(reg("SAU")) == {"Saudi Arabia"} and all(float(r["solar_2024"]) == 733.1 for r in by["SAU"]), "Saudi Arabia own IRENA row $733.1")
for iso in ("ARE", "QAT", "KWT", "OMN"):
    ok({r["region_method"] for r in by[iso]} == {"gcc_proxy"}, f"{iso} on the Saudi row as GCC proxy")
ok({r["region_method"] for r in by["TWN"]} == {"high_income_asia_proxy"} and set(reg("TWN")) == {"Korea (Rep. of Korea)"}, "Taiwan on high-income Asia proxy (Korea row)")
ok(set(reg("SOL")) == {"Africa"}, "Somaliland on Africa")
left = Counter(oc[r["location_id"]] for r in new if r["region"] == "Global average")
ok(left == Counter({"ATF": 1}), f"only Fr. S. Antarctic Lands left on Global average: {dict(left)}")
# only the mapping columns change; wind columns untouched by fix 3
allowed = {"country_iso3", "country_name", "region", "region_method", "capex_source", "solar_2024", "solar_2035", "solar_2050",
           "battery_2024", "battery_2035", "battery_2050"}
wind = lambda k: k.startswith("wind_")
o = {r["location_id"]: r for r in old}
bad = Counter(k for r in new for k in r if not wind(k) and k not in allowed and r[k] != o[r["location_id"]][k])
ok(not bad, f"no other non-wind column changes {dict(bad)}")
ok(len(new) == len(old), f"{len(new)} rows")
print("ALL PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
