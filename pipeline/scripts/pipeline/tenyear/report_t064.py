"""T064 report numbers: T060 data_10y (old sites) -> T064 data_10y (T061 sites), and
T064 2024 (deployment/data) -> T064 ten-year. Prints markdown tables; writes
results/report_t064.json.

Inputs (T064 run dir unless noted):
  article/{model,curves,search}_{2024,10y}.*   T064, made on deployment/data and data_10y
  ~/wind-atlas-T060/article/{model,curves}_10y.* T060 (read only)
  results/per_year_dense.parquet, results/profile_cf_by_region_year.parquet (weather.py)
  ~/wind-atlas-T060/results/profile_cf_by_region_year.parquet (read only)
  python3 -I report_t064.py <repo>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))
OLD = Path.home() / "wind-atlas-T060"
repo = Path(sys.argv[1]).resolve()
A, OA = ROOT / "article", OLD / "article"
D24, D10 = repo / "deployment/data", repo / "deployment/data_10y"
OUT = {}
key = ["location_id", "solar_gw", "wind_gw", "batt_gwh"]
pct = lambda v: "–" if v is None else f"{v * 100:.1f}%"  # noqa: E731
usd = lambda v: "–" if v is None else f"${v:,.0f}"  # noqa: E731

# ------------------------------------------------------------- 1. slices, T060 10y -> T064 10y
print("## Slices: mean annual_cf, T060 data_10y -> T064 data_10y (deployed rows)\n")
print("| File | T060 10y | T064 10y | Change | Predicted | T064 2024 | Rows changed |")
print("|---|---|---|---|---|---|---|")
ref = ROOT / "work/ref"
rows = []
for f in sorted(p.name for p in D10.glob("summary_*.parquet")):
    o = pd.read_parquet(ref / "t060_10y" / f).set_index(key).annual_cf.astype("float64")
    n = pd.read_parquet(D10 / f).set_index(key).annual_cf.astype("float64")
    c = pd.read_parquet(D24 / f).set_index(key).annual_cf.astype("float64")
    m = pd.read_parquet(ref / "main" / f).set_index(key).annual_cf.astype("float64")
    o = o.reindex(n.index); pred = (c - m.reindex(c.index)).reindex(n.index)
    r = dict(file=f, old=o.mean(), new=n.mean(), d=(n - o).mean(), pred=pred.mean(), y24=c.reindex(n.index).mean(),
             changed=int((n != o).sum()), n=len(n), resid=float((n - o - pred).abs().mean()))
    rows.append(r)
    print(f"| {f} | {pct(r['old'])} | {pct(r['new'])} | {r['d']*100:+.2f} pts | {r['pred']*100:+.2f} pts | "
          f"{pct(r['y24'])} | {r['changed']:,} of {r['n']:,} |")
OUT["slices"] = rows

# ------------------------------------------------------------- 2. profiles
print("\n## Profiles: mean CF of the hourly inputs, deployed regions with a profile\n")
pn = pd.read_parquet(ROOT / "results/profile_cf_by_region_year.parquet")
po = pd.read_parquet(OLD / "results/profile_cf_by_region_year.parquet")
res = pd.read_csv(D24 / "voronoi_wind_resource.csv").set_index("location_id")
yrs = [f"cf_{y}" for y in range(2015, 2025)]
print("| Tech | T060 2024 | T060 10y | T064 2024 | T064 10y | Median 10y ÷ 2024, T060 → T064 | 2024 rank (1 = best), T060 → T064 | Level gap 10y ÷ target |")
print("|---|---|---|---|---|---|---|---|")
prof = {}
for tech in ("solar", "wind_on", "wind_off"):
    a = pn[pn.tech == tech].set_index("location_id").dropna(subset=["cf_2024"])
    b = po[po.tech == tech].set_index("location_id").dropna(subset=["cf_2024"])
    if tech != "solar":
        a = a[a.cf_2024 > 0]; b = b[b.cf_2024 > 0]
    rk = lambda d: int((d[yrs].mean() >= d["cf_2024"].mean()).sum())  # noqa: E731
    gap = ""
    if tech != "solar":
        t = tech[5:]
        tg = res[f"{t}_cf_target"].reindex(a.index)
        gap = f"{float(np.nanmedian(a.cf_mean / tg)):.3f} (2024: {float(np.nanmedian(a.cf_2024 / tg)):.3f})"
    prof[tech] = dict(o24=b.cf_2024.mean(), o10=b.cf_mean.mean(), n24=a.cf_2024.mean(), n10=a.cf_mean.mean(),
                      oratio=float((b.cf_mean / b.cf_2024).median()), nratio=float((a.cf_mean / a.cf_2024).median()),
                      orank=rk(b), nrank=rk(a), n=len(a))
    p = prof[tech]
    print(f"| {tech} | {pct(p['o24'])} | {pct(p['o10'])} | {pct(p['n24'])} | {pct(p['n10'])} | "
          f"{p['oratio']:.4f} → {p['nratio']:.4f} | {p['orank']} → {p['nrank']} | {gap} |")
OUT["profiles"] = prof

# ------------------------------------------------------------- 3. cities
c_o = json.loads((OA / "curves_10y.json").read_text())
c_24 = json.loads((A / "curves_2024.json").read_text())
c_10 = json.loads((A / "curves_10y.json").read_text())
c_m24 = json.loads((OA / "curves_2024.json").read_text())
T = c_10["targets"]
print("\n## City curves (cheapest build with wind, $/MWh, global costs 2026)\n")
print("| City (id) | Target | T060 10y | T064 2024 | T064 10y | 10y change T060 → T064 | T061's 2024 change | Build at target, T064 10y |")
print("|---|---|---|---|---|---|---|---|")
cities = {}
for n in c_10["cities"]:
    o, x, y, m = c_o["cities"][n], c_24["cities"][n], c_10["cities"][n], c_m24["cities"][n]
    cities[n] = {}
    for t in (0.8, 0.9, 0.99):
        i = T.index(t)
        vo, vx, vy, vm = o["w"][i], x["w"][i], y["w"][i], m["w"][i]
        d = None if vo is None or vy is None else vy - vo
        d24 = None if vm is None or vx is None else vx - vm
        cities[n][str(t)] = dict(t060_10y=vo, t064_24=vx, t064_10y=vy, build=y["build"][i])
        print(f"| {n} ({y['id']}) | {round(t*100)}% | {usd(vo)} | {usd(vx)} | {usd(vy)} | "
              f"{'–' if d is None else f'{d:+.0f}'} | {'–' if d24 is None else f'{d24:+.0f}'} | {y['build'][i]} |")
OUT["cities"] = cities

# ------------------------------------------------------------- 4. headline / article numbers
mo = json.loads((OA / "model_10y.json").read_text())
m24 = json.loads((A / "model_2024.json").read_text())
m10 = json.loads((A / "model_10y.json").read_text())
print("\n## Headline model values\n")
print("| Key | T060 10y | T064 2024 | T064 10y |")
print("|---|---|---|---|")
keys = [k for k in m10["modelValues"] if k.startswith(("hw.lower.", "hw.lowerStd.", "t1.cut.people.9", "t1.cut.people.8"))
        and k.split(".")[-1] in ("80", "90", "99")]
for k in sorted(keys):
    vals = [d["modelValues"].get(k) for d in (mo, m24, m10)]
    print(f"| {k} | " + " | ".join(pct(v) for v in vals) + " |")


def bound(d):
    return {b["key"]: b["text"] for b in d["bound"]}


bo, b24, b10 = bound(mo), bound(m24), bound(m10)
ks = sorted(set(b10))
ch24 = [k for k in ks if b24.get(k) != b10.get(k)]
cho = [k for k in ks if bo.get(k) != b10.get(k)]
print(f"\nBound article numbers: {len(ks)} distinct keys. T064 2024 → T064 10y: {len(ch24)} read differently; "
      f"T060 10y → T064 10y: {len(cho)} read differently.\n")
print("| Key | T060 10y | T064 2024 | T064 10y |")
print("|---|---|---|---|")
for k in ch24:
    print(f"| {k} | {bo.get(k)} | {b24.get(k)} | {b10.get(k)} |")
OUT["bound_changes_2024_to_10y"] = {k: [bo.get(k), b24.get(k), b10.get(k)] for k in ch24}
OUT["bound_changes_t060_to_t064_10y"] = {k: [bo.get(k), b24.get(k), b10.get(k)] for k in cho}

# ------------------------------------------------------------- 5. worst year of the cheapest ten-year builds
sys.path.insert(0, str(repo / "pipeline"))
from scripts.pipeline.config import build_config_list  # noqa: E402
cfg_index = {(sf, s, w, b): idx for idx, sf, s, w, b in build_config_list()}
s10 = np.load(A / "search_10y.npz", allow_pickle=False)
py = pd.read_parquet(ROOT / "results/per_year_dense.parquet").set_index(["location_id", "config"])
print("\n## Worst year of the cheapest ten-year slider builds (target met on the ten-year average)\n")
print("| Target | Regions (slider build) | Short in ≥ 1 year | Median worst year | Median years short | Short in > 1 year of 10 |")
print("|---|---|---|---|---|---|")
wy = {}
for Tt in (80, 90, 99):
    ids = s10["ids"]; meets = s10[f"meets_{Tt}"] > 0; addon = s10[f"addon_{Tt}"]
    sel = []
    for i, lid in enumerate(ids):
        if not meets[i] or addon[i]:
            continue
        w = s10[f"wind_gw_{Tt}"][i]
        sf = s10[f"surface_{Tt}"][i] if w else "on"
        k = (sf if sf in ("on", "off") else "on", int(s10[f"solar_gw_{Tt}"][i]), int(w), int(s10[f"batt_gwh_{Tt}"][i]))
        if k in cfg_index:
            sel.append((int(lid), cfg_index[k]))
    yc = py.loc[sel, yrs].to_numpy()
    short = yc < Tt / 100 - 1e-9
    worst = yc.min(axis=1)
    wy[Tt] = dict(n=len(sel), share_short=float(short.any(axis=1).mean()), med_worst=float(np.median(worst)),
                  med_years=float(np.median(short.sum(axis=1))), share_gt1=float((short.sum(axis=1) > 1).mean()))
    w_ = wy[Tt]
    print(f"| {Tt}% | {w_['n']:,} | {w_['share_short']*100:.0f}% | {w_['med_worst']*100:.1f}% | {w_['med_years']:.0f} | "
          f"{w_['share_gt1']*100:.0f}% |")
OUT["worst_year"] = wy
(ROOT / "results/report_t064.json").write_text(json.dumps(OUT, indent=1, default=float))
