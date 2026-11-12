"""T088 step 4: sampling uncertainty of the pooled coincidence ratio (7-day windows) by year-block bootstrap.

Each 7-day window is assigned to the year of its last day. A bootstrap draw resamples the ten years
with replacement (same draw for every region, so shared weather stays shared) and recomputes
P(solar), P(wind), P(both) per region from the drawn years' window counts, then the pooled,
demand-weighted ratio sum w*P(both) / sum w*P(solar)*P(wind). Thresholds (50% of the ten-year mean;
the region's 5th-percentile window) stay at their full-sample values. 1,000 draws, seed 88.

  python3 -I boot.py --out ~/wind-atlas-T088/out
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from analyse import EUROPE, wmeans  # same windows and region list

ap = argparse.ArgumentParser()
ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
r = pd.read_csv(a.out / "regions.csv")
D = np.load(a.out / "daily.npz")
s_pos = {int(v): i for i, v in enumerate(D["solar_ids"])}
on_pos = {int(v): i for i, v in enumerate(D["on_rows"])}
S = D["solar"][[s_pos[i] for i in r.location_id]].astype(np.float64)
W = D["on"][[on_pos[i] for i in r.location_id]].astype(np.float64)
s1, w1 = S / S.mean(1, keepdims=True), W / W.mean(1, keepdims=True)
rs, rw = wmeans(s1, 7), wmeans(w1, 7)
year = (np.arange(rs.shape[1]) + 6) // 365  # year index of each window's last day
groups = {"World": np.ones(len(r), bool), "Europe": r.country_iso3.isin(EUROPE).to_numpy(),
          "North America (USA+CAN)": r.country_iso3.isin(["USA", "CAN"]).to_numpy(),
          "Germany": (r.country_iso3 == "DEU").to_numpy()}
rng = np.random.default_rng(88)
draws = rng.integers(0, 10, size=(1000, 10))
rows = []
for kind in ("t50", "p5"):
    if kind == "t50":
        ds, dw = rs < 0.5, rw < 0.5
    else:
        ds = rs <= np.quantile(rs, 0.05, axis=1, keepdims=True)
        dw = rw <= np.quantile(rw, 0.05, axis=1, keepdims=True)
    # per region, per year: windows, solar, wind, both counts
    cnt = np.stack([np.stack([(year == y).sum() * np.ones(len(r)), ds[:, year == y].sum(1), dw[:, year == y].sum(1),
                              (ds & dw)[:, year == y].sum(1)], 1) for y in range(10)], 0)  # [10, n, 4]
    for g, m in groups.items():
        wt = r.demand_twh.to_numpy() * m
        vals = []
        for d in draws:
            c = cnt[d].sum(0)
            ps, pw, pb = c[:, 1] / c[:, 0], c[:, 2] / c[:, 0], c[:, 3] / c[:, 0]
            den = (wt * ps * pw).sum()
            vals.append((wt * pb).sum() / den if den > 0 else np.nan)
        c = cnt.sum(0)
        full = (wt * c[:, 3] / c[:, 0]).sum() / (wt * (c[:, 1] / c[:, 0]) * (c[:, 2] / c[:, 0])).sum()
        lo, hi = np.nanpercentile(vals, [5, 95])
        rows.append(dict(definition=f"w7_{kind}", group=g, pooled_ratio=full, p05=lo, p95=hi))
out = pd.DataFrame(rows)
out.to_csv(a.out / "bootstrap_ratio.csv", index=False, float_format="%.3f")
print(out.round(3).to_string(index=False))
