"""T081: standing calibration check (calibration.py via t061.phase_a), Europe refit, leave-one-out,
and the broad-region acceptance table.

  T061_WORKSPACE=<ws> T061_RUN_DIR=<calib_run> python3 -I calib.py --resource <csv> --label <name> \
      --out <dir> [--sim <csv with location_id,on_final_cf>] [--refit]

--refit: the Europe onshore factor as fitted at T061 gate C (t061.sweep.fit_factor): the
generation-weighted (IRENA fleet TWh 2022-24) mean of atlas / IRENA new-build over the European
fit set is 1, on the UNSCALED level (on_cf_best). Leave-one-out: refit without each European
country and report that country's out-of-sample ratio.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parents[3]))
from scripts.pipeline.wind.t061 import phase_a as A  # noqa: E402
from scripts.pipeline.wind.t061 import sweep as W  # noqa: E402
import calibration as K  # noqa: E402


def broad_table(t: pd.DataFrame, col: str) -> pd.DataFrame:
    s = t[(t.surface == "on") & t[col].notna() & t.newbuild_cf.notna() & ~t.iso3.isin(K.EXCLUDE)].copy()
    s["broad"] = s.iso3.map(W.ISO_BROAD).fillna("other")
    rows = []
    for b, x in list(s.groupby("broad")) + [("World", s)]:
        w = x.fleet_twh.fillna(0)
        rows.append({"region": b, "n": len(x), "countries": " ".join(x.iso3),
                     "ratio": float((x[col] / x.newbuild_cf * w).sum() / w.sum()) if w.sum() > 0 else np.nan})
    return pd.DataFrame(rows)


def fit(s: pd.DataFrame) -> float:
    w = s.fleet_twh.fillna(0)
    return float(1.0 / ((s.atlas_cf / s.newbuild_cf * w).sum() / w.sum()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--sim", type=Path, help="csv location_id,on_final_cf overriding the resource's")
    ap.add_argument("--refit", action="store_true")
    a = ap.parse_args()
    res = a.resource
    if a.sim is not None:
        r = pd.read_csv(a.resource)
        s = pd.read_csv(a.sim).set_index("location_id")
        r["on_final_cf"] = s.reindex(r.location_id)["on_final_cf"].to_numpy()
        res = a.out / f"_resource_{a.label}.csv"
        a.out.mkdir(parents=True, exist_ok=True)
        r.to_csv(res, index=False)
    t = A.run(res, a.out, a.label)
    md = [A.report(t, a.label), "", "## Broad regions, onshore (generation-weighted, IRENA new-build countries)", ""]
    cols = [c for c in ("atlas_cf", "sim_cf") if c in t.columns]
    bt = None
    for c in cols:
        b = broad_table(t, c).rename(columns={"ratio": f"{c}/newbuild"})
        bt = b if bt is None else bt.merge(b[["region", f"{c}/newbuild"]], on="region")
    md.append(bt.to_markdown(index=False, floatfmt=".3f"))
    bt.to_csv(a.out / f"broad_{a.label}.csv", index=False, float_format="%.4f")
    if a.refit:
        # unscaled level: re-run the table with atlas_cf = on_cf_best
        r = pd.read_csv(a.resource)
        r["on_cf_target"] = r["on_cf_best"]
        p = a.out / f"_unscaled_{a.label}.csv"
        r.to_csv(p, index=False)
        u = A.run(p, a.out, f"{a.label}_unscaled")
        on = u[(u.surface == "on") & u.atlas_cf.notna() & u.newbuild_cf.notna() & ~u.iso3.isin(K.EXCLUDE)]
        eu = on[on.iso3.map(W.ISO_BROAD) == "Europe"]
        f = fit(eu)
        loo = []
        for iso in eu.iso3:
            fi = fit(eu[eu.iso3 != iso])
            x = eu[eu.iso3 == iso].iloc[0]
            loo.append({"iso3": iso, "factor_without": fi, "out_of_sample_ratio": x.atlas_cf * fi / x.newbuild_cf,
                        "in_sample_ratio": x.atlas_cf * f / x.newbuild_cf, "fleet_twh": x.fleet_twh})
        loo = pd.DataFrame(loo)
        loo.to_csv(a.out / f"loo_{a.label}.csv", index=False, float_format="%.4f")
        md += ["", f"## Europe onshore factor refit (T061 rule, unscaled level): **{f:.4f}**", "",
               f"European fit set: {' '.join(eu.iso3)} (n = {len(eu)})", "",
               f"Leave-one-out: within ±10% out of sample {100*(np.abs(loo.out_of_sample_ratio-1)<=0.10).mean():.0f}% "
               f"(in sample {100*(np.abs(loo.in_sample_ratio-1)<=0.10).mean():.0f}%); factor range "
               f"{loo.factor_without.min():.4f}–{loo.factor_without.max():.4f}", "",
               loo.to_markdown(index=False, floatfmt=".3f")]
        (a.out / f"factor_{a.label}.txt").write_text(f"{f:.6f}\n")
    (a.out / f"report_{a.label}.md").write_text("\n".join(md) + "\n")
    print("\n".join(md[-40:]))


if __name__ == "__main__":
    main()
