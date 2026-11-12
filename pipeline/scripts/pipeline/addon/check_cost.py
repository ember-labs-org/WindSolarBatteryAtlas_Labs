"""T058: prove the Python cost model (common.precompute / lcoe_full, used by the
studies and by the add-on oracle) equals the app's LCOE in every pricing mode:
Global, local WACC (solar + wind), local capex (incl. wind O&M), timeline year
2035, backup on (diesel / gas, local and global prices) and their mixtures; for
single-surface rows against the worker's own computeLcoeMetrics, for
combinations against comboLcoe (check_cost_vs_js.mjs), and for combinations with
one surface at 0 against the worker again. Also the default-mode vectorised
Cost class. Fractional batteries and CF = target (interpolated rows) included.

  python3 -I check_cost.py     (exit 0 = pass)
"""
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from common import Cost, REPO, precompute, lcoe_full

rng = np.random.default_rng(58)
rows = []
for i in range(6000):
    mode = i % 6   # 0 global, 1 local wacc, 2 local capex 2035, 3 backup local, 4 backup global prices, 5 all local + backup
    kind = rng.choice(["solar", "on", "off", "combo", "combo0", "large"])
    on = off = 0
    if kind == "on": on = int(rng.choice([1, 2, 3, 4, 5, 6, 8]))
    if kind == "off": off = int(rng.choice([1, 2, 3, 4, 5, 6, 8]))
    if kind == "combo": on, off = int(rng.integers(1, 5)), int(rng.integers(1, 4))
    if kind == "combo0": on, off = (int(rng.integers(1, 5)), 0) if rng.random() < .5 else (0, int(rng.integers(1, 4)))
    solar = int(rng.integers(0 if (on or off) else 1, 11))
    batt = float(rng.choice([0, 2, 18, 36]))
    if kind == "large":
        solar = int(rng.choice([20, 25, 50, 100, 200])); batt = float(rng.uniform(36, 4608))
    r = dict(solar_gw=solar, batt_gwh=batt, wind_on_gw=on, wind_off_gw=off,
             annual_cf=float(np.float32(rng.uniform(0.02, 1))), ucf_s=float(rng.uniform(0.05, 0.3)),
             ucf_on=float(rng.choice([rng.uniform(0.05, 0.6), 0.0])), ucf_off=float(rng.uniform(0.05, 0.6)),
             year=2035 if mode in (2, 5) else 2026, backup=mode in (3, 4, 5))
    if mode in (1, 5):
        r["localWacc"] = float(rng.uniform(0.03, 0.15))
        r["windWacc"] = {"on": float(rng.uniform(0.03, 0.15)), "off": float(rng.uniform(0.04, 0.16))}
    if mode in (2, 5):
        r["localCapex"] = {"solar": float(rng.uniform(300, 1200)), "battery": float(rng.uniform(60, 250)),
                           "windOn": float(rng.uniform(700, 2000)), "windOff": float(rng.uniform(1800, 5000)),
                           "windOnOm": float(rng.uniform(20, 60)), "windOffOm": float(rng.uniform(50, 180))}
    if mode in (3, 5):
        r["diesel"] = {"rawPrice": float(rng.uniform(0.3, 2.5))}
        r["gas"] = {"available": bool(rng.random() < .6), "rawPrice": float(rng.uniform(2, 15))}
    if mode == 4:
        r["paramsOverride"] = {"dieselPriceMode": "global", "gasPriceMode": "global"}
        r["gas"] = {"available": bool(rng.random() < .6)}
    rows.append(r)

res = json.loads(subprocess.run(["node", str(REPO / "pipeline/scripts/pipeline/addon/check_cost_vs_js.mjs"), str(REPO)],
                                input=json.dumps(rows), capture_output=True, text=True, check=True).stdout)
js = np.array([np.inf if v is None else v for v in res["out"]], dtype=float)
BACKUP = dict(includeDieselBackup=True, dieselCapex=300, dieselEfficiency=0.35, dieselLife=20, dieselPrice=1.20,
              dieselPriceMode="local", gasCapex=800, gasEfficiency=0.35, gasLife=25, gasPrice=4.88, gasPriceMode="local")
py = []
for r in rows:
    params = {**res["params"], **(BACKUP if r["backup"] else {}), **r.get("paramsOverride", {})}
    mult = res["mult2035"] if r["year"] == 2035 else {"solar": 1, "battery": 1, "wind": 1, "windOff": 1}
    pre = precompute(params, mult, r.get("localWacc"), r.get("localCapex"), r.get("diesel"), r.get("gas"),
                     r.get("windWacc"), {"solar": r["ucf_s"], "on": r["ucf_on"], "off": r["ucf_off"]})
    py.append(lcoe_full(pre, r["annual_cf"], r["solar_gw"], r["batt_gwh"], r["wind_on_gw"], r["wind_off_gw"]))
py = np.array(py)
both_inf = np.isinf(py) & np.isinf(js)
rel = np.where(both_inf, 0, np.abs(py - js) / np.abs(js))
ok = True
names = ["global", "local WACC", "local capex 2035", "backup local", "backup global prices", "all local 2035 + backup"]
for m in range(6):
    sel = np.arange(len(rows)) % 6 == m
    kinds = {k: int(sum(1 for i in np.where(sel)[0] if (rows[i]["wind_on_gw"] > 0) + (rows[i]["wind_off_gw"] > 0) == k)) for k in (0, 1, 2)}
    print(f"  {names[m]:<26} rows {sel.sum()} (no wind {kinds[0]}, one surface {kinds[1]}, both {kinds[2]}): "
          f"max relative difference {rel[sel].max():.1e}; infinite in both {int(both_inf[sel].sum())}")
    ok &= rel[sel].max() < 1e-12
# vectorised default-mode class
d = [i for i in range(0, len(rows), 6)]
c = Cost()
vec = np.array([c.lcoe(rows[i]["annual_cf"], rows[i]["solar_gw"], rows[i]["batt_gwh"], rows[i]["wind_on_gw"],
                       rows[i]["wind_off_gw"], rows[i]["ucf_s"], rows[i]["ucf_on"], rows[i]["ucf_off"]).item() for i in d])
rv = np.abs(vec - js[d]) / js[d]
print(f"  Cost (vectorised, default mode): max relative difference {rv.max():.1e}")
ok &= rv.max() < 1e-12
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
