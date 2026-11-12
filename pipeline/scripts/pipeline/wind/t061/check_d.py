"""Phase D proofs against the stated expectations (T061).

Per wind slice and the daily file: which deployed regions' rows are exactly
equal to the shipped data, compared with the predicted identical set
(D_expected_regions.csv). Also profile diagnostics vs prediction, the profile
files' region identity, and the resource CSV's column changes.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

SLICES_ON = ["summary_w1", "summary_w2", "summary_w3", "summary_w4", "summary_w5", "summary_w6", "summary_w8"]
SLICES_OFF = ["summary_wo1", "summary_wo2", "summary_wo3", "summary_wo4", "summary_wo5", "summary_wo6", "summary_wo8"]


def per_region_equal(a: pd.DataFrame, b: pd.DataFrame, key="location_id") -> pd.Series:
    """True per location_id when every row of that region is identical (bitwise for floats)."""
    a = a.sort_values(list(a.columns[:0]) + [key], kind="stable").reset_index(drop=True)
    b = b.sort_values([key], kind="stable").reset_index(drop=True)
    assert len(a) == len(b) and (a[key].to_numpy() == b[key].to_numpy()).all()
    eq = np.ones(len(a), bool)
    for c in a.columns:
        x, y = a[c].to_numpy(), b[c].to_numpy()
        if x.dtype.kind == "f":
            eq &= (x.view(f"u{x.itemsize}") == y.view(f"u{y.itemsize}")) | (np.isnan(x) & np.isnan(y))
        else:
            eq &= (x == y)
    return pd.Series(eq).groupby(a[key].to_numpy()).all()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", type=Path, required=True, help="filtered new data")
    ap.add_argument("--old", type=Path, required=True, help="shipped deployment/data")
    ap.add_argument("--expected", type=Path, required=True)
    ap.add_argument("--new-resource-unfiltered", type=Path, required=True)
    a = ap.parse_args()
    E = pd.read_csv(a.expected).set_index("location_id")
    E = E[E.deployed]
    bad = 0
    for tag, slices in (("on", SLICES_ON), ("off", SLICES_OFF)):
        exp_id = set(E.index[E[f"{tag}_identical"]])
        for s in slices:
            o = pd.read_parquet(a.old / f"{s}.parquet")
            n = pd.read_parquet(a.new / f"{s}.parquet")
            # same row order within region: sort by all config columns via stable index
            o = o.sort_values(["location_id"], kind="stable"); n = n.sort_values(["location_id"], kind="stable")
            eq = per_region_equal(n, o)
            got = set(eq.index[eq])
            ok = got == exp_id
            bad += not ok
            print(f"{s}: identical regions {len(got)} (expected {len(exp_id)}); "
                  f"unexpectedly identical {len(got - exp_id)}, unexpectedly changed {len(exp_id - got)} -> {'PASS' if ok else 'FAIL'}")
    od = pd.read_parquet(a.old / "daily_cf_2024.parquet").sort_values(["location_id", "date"], kind="stable")
    nd = pd.read_parquet(a.new / "daily_cf_2024.parquet").sort_values(["location_id", "date"], kind="stable")
    assert (od.location_id.to_numpy() == nd.location_id.to_numpy()).all()
    for col, tag in (("solar", None), ("wind_on", "on"), ("wind_off", "off")):
        x, y = od[col].to_numpy(), nd[col].to_numpy()
        same = pd.Series((x == y) | (np.isnan(x) & np.isnan(y))).groupby(od.location_id.to_numpy()).all()
        got = set(same.index[same])
        exp = set(E.index) if tag is None else set(E.index[E[f"{tag}_identical"]])
        ok = got == exp
        bad += not ok
        print(f"daily {col}: identical regions {len(got)} (expected {len(exp)}) -> {'PASS' if ok else 'FAIL'}; "
              f"null regions {int(pd.Series(np.isnan(y)).groupby(nd.location_id.to_numpy()).all().sum())}")
    r = pd.read_csv(a.new_resource_unfiltered).set_index("location_id")
    Eall = pd.read_csv(a.expected).set_index("location_id")
    for tag in ("on", "off"):
        m = np.isfinite(Eall[f"{tag}_k_pred"])
        dk = np.nanmax(np.abs(r.loc[m.index[m], f"{tag}_k"] - Eall.loc[m, f"{tag}_k_pred"]))
        df = np.nanmax(np.abs(r.loc[m.index[m], f"{tag}_final_cf"] - Eall.loc[m, f"{tag}_final_pred"]))
        cl = int(r[f"{tag}_clamped"].sum())
        print(f"{tag}: k vs prediction max |diff| {dk:.1e}; final_cf vs prediction {df:.1e}; clamped {cl} "
              f"(predicted {int(Eall[f'{tag}_clamped_pred'].sum())}); unclamped final_cf vs target max |diff| "
              f"{np.nanmax(np.abs((r[f'{tag}_final_cf'] - r[f'{tag}_cf_target'])[(r[f'{tag}_clamped'] == 0) & r[f'{tag}_viable'].eq(1)])):.1e}")
    print("ALL PASS" if not bad else f"{bad} FAIL")


if __name__ == "__main__":
    main()
