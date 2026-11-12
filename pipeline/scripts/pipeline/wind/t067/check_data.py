"""T067 fix 1 proof: per region, every wind slice, the daily file and the add-on against
the T063 deployed data. A region's rows may differ only if its profile inputs changed
(resource: site, target, viability, k), and every such region must be in the prediction
(t067/results/T067_expected_regions.csv); every other region must be bit-identical.

  python3 -I check_data.py --old <T063 deployment/data> --new <new filtered data> \
      --expected <csv> --out <txt>
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

ON = ["summary_w1", "summary_w2", "summary_w3", "summary_w4", "summary_w5", "summary_w6", "summary_w8"]
OFF = ["summary_wo1", "summary_wo2", "summary_wo3", "summary_wo4", "summary_wo5", "summary_wo6", "summary_wo8"]


def region_equal(a: pd.DataFrame, b: pd.DataFrame, keys) -> pd.Series:
    a = a.sort_values(keys, kind="stable").reset_index(drop=True)
    b = b.sort_values(keys, kind="stable").reset_index(drop=True)
    assert len(a) == len(b) and (a[keys].to_numpy() == b[keys].to_numpy()).all(), "row sets differ"
    eq = np.ones(len(a), bool)
    for c in a.columns:
        x, y = a[c].to_numpy(), b[c].to_numpy()
        if x.dtype.kind == "f":
            eq &= (x.view(f"u{x.itemsize}") == y.view(f"u{y.itemsize}")) | (np.isnan(x) & np.isnan(y))
        else:
            eq &= x == y
    return pd.Series(eq).groupby(a["location_id"].to_numpy()).all()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", type=Path, required=True)
    ap.add_argument("--new", type=Path, required=True)
    ap.add_argument("--expected", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    exp = set(pd.read_csv(a.expected).location_id)
    ro = pd.read_csv(a.old / "voronoi_wind_resource.csv").set_index("location_id")
    rn = pd.read_csv(a.new / "voronoi_wind_resource.csv").set_index("location_id")
    assert ro.index.equals(rn.index)
    prof = {}
    for t in ("on", "off"):
        cols = [f"{t}_site_lat", f"{t}_site_lon", f"{t}_cf_target", f"{t}_viable", f"{t}_k", f"{t}_final_cf"]
        x, y = ro[cols], rn[cols]
        prof[t] = set(rn.index[~((x == y) | (x.isna() & y.isna())).all(axis=1)])
    lines = [f"deployed regions {len(rn)}; profile inputs changed: onshore {len(prof['on'])}, offshore {len(prof['off'])}; "
             f"predicted (any change) {len(exp)}",
             f"profile-changed regions outside the prediction: {sorted((prof['on'] | prof['off']) - exp)}"]
    bad = bool((prof["on"] | prof["off"]) - exp)
    for names, t in ((ON, "on"), (OFF, "off")):
        for s in names:
            o = pd.read_parquet(a.old / f"{s}.parquet")
            n = pd.read_parquet(a.new / f"{s}.parquet")
            eq = region_equal(o, n, ["location_id", "solar_gw", "batt_gwh", "wind_gw"] if "wind_gw" in o else ["location_id"])
            ch = set(eq.index[~eq])
            ok = ch == prof[t] & set(eq.index) or (ch <= prof[t])
            lines.append(f"{s}: changed {len(ch)}, identical {int(eq.sum())}; changed outside {t}-profile set "
                         f"{sorted(ch - prof[t])[:10]}; profile-changed but identical {len(prof[t] - ch)} -> {'PASS' if ch <= prof[t] else 'FAIL'}")
            bad |= not ch <= prof[t]
    o = pd.read_parquet(a.old / "daily_cf_2024.parquet")
    n = pd.read_parquet(a.new / "daily_cf_2024.parquet")
    keys = [c for c in ("location_id", "date", "day") if c in o.columns]
    for col, t in (("solar", None), ("wind_on", "on"), ("wind_off", "off")):
        cc = [c for c in o.columns if c.startswith(col)] if col != "solar" else [c for c in o.columns if c.startswith("solar")]
        eq = region_equal(o[keys + cc], n[keys + cc], keys)
        ch = set(eq.index[~eq])
        allowed = prof[t] if t else set()
        lines.append(f"daily {col}: changed {len(ch)} -> {'PASS' if ch <= allowed else 'FAIL ' + str(sorted(ch - allowed)[:10])}")
        bad |= not ch <= allowed
    for f in ("addon_wind_mix", "addon_large"):
        p_old, p_new = a.old / f"{f}.parquet", a.new / f"{f}.parquet"
        if not p_new.exists():
            lines.append(f"{f}: not in --new (skipped)")
            continue
        o, n = pd.read_parquet(p_old), pd.read_parquet(p_new)
        so, sn = set(o.location_id), set(n.location_id)
        common = so & sn
        k = ["location_id", "cfg"]
        eq = region_equal(o[o.location_id.isin(common)], n[n.location_id.isin(common)], k)
        ch = set(eq.index[~eq]) | (so ^ sn)
        allowed = prof["on"] | prof["off"]
        lines.append(f"{f}: regions {len(so)} -> {len(sn)}; changed or added/removed {len(ch)} -> "
                     f"{'PASS' if ch <= allowed else 'FAIL ' + str(sorted(ch - allowed)[:10])}")
        bad |= not ch <= allowed
    lines.append("ALL PASS" if not bad else "FAIL")
    a.out.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
