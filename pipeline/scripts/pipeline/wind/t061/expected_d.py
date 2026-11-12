"""Phase D expectations, stated before the profile / run3d / daily / add-on runs (T061, D-134).

From the new siting CSV and the fresh ERA5 speeds, predicts per region and surface
what build_wind_profiles.py will do (same solve_k, curves, density, class) and
which regions must come out identical to today:

  identical profile  <=>  viable both times, same ERA5 column, same curve and
                          density, and the same k (same target, or clamped at the
                          same bound), or non-viable both times (all-zero).

Identical profile => identical summary_w*/wo* rows and daily column. Writes the
prediction table to the run directory and prints the counts.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C


def predict(df: pd.DataFrame, speeds: dict, tag: str, losses=0.12):
    import sys
    S, G = C.import_siting()
    from scripts.pipeline.wind.build_wind_profiles import solve_k, RHO0
    from scripts.pipeline.wind.power_curves import CURVES
    n = len(df)
    keep = 1 - losses
    k = np.full(n, np.nan); fin = np.full(n, np.nan); cl = np.zeros(n, "int8")
    viable = df[f"{tag}_viable"].to_numpy() == 1
    tgt = df[f"{tag}_cf_target"].to_numpy()
    dens = df["on_site_air_density"].to_numpy() if tag == "on" else np.full(n, RHO0)
    dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
    cls = df["on_site_iec_class"].to_numpy() if tag == "on" else None
    for i in range(n):
        if not viable[i] or not np.isfinite(tgt[i]) or tgt[i] <= 0:
            continue
        curve = CURVES[int(cls[i])] if tag == "on" and int(cls[i]) in CURVES else CURVES["offshore"]
        v = speeds[tag][:, i].astype("float64")
        if not np.isfinite(v).all() or v.max() <= 0:
            continue
        v = v * (dens[i] / RHO0) ** (1.0 / 3.0)
        kk, c = solve_k(v, curve, float(tgt[i]) / keep)
        k[i], cl[i] = kk, c
        fin[i] = float((curve.output(v * kk) * keep).mean())
    return k, fin, cl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-resource", type=Path, required=True, help="baseline CSV with k diagnostics")
    ap.add_argument("--new-resource", type=Path, required=True)
    ap.add_argument("--old-speeds", type=Path, required=True)
    ap.add_argument("--new-speeds", type=Path, required=True)
    ap.add_argument("--population", type=Path, required=True)
    ap.add_argument("--excluded", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    import json
    old, new = pd.read_csv(a.old_resource), pd.read_csv(a.new_resource)
    so, sn = dict(np.load(a.old_speeds)), dict(np.load(a.new_speeds))   # decompress once
    excl = {r["location_id"] for r in json.loads(a.excluded.read_text())["regions"]}
    dep = ~new.location_id.isin(excl).to_numpy()
    rows = {"location_id": new.location_id.to_numpy(), "deployed": dep}
    print("Phase D expectations (stated before the profile run)")
    for tag in ("on", "off"):
        k, fin, cl = predict(new, sn, tag)
        same_col = np.array([np.array_equal(sn[tag][:, i], so[tag][:, i]) for i in range(len(new))])
        same_curve = np.ones(len(new), bool)
        if tag == "on":
            same_curve = (new.on_site_iec_class.to_numpy() == old.on_site_iec_class.to_numpy()) & \
                         ((new.on_site_air_density.to_numpy() == old.on_site_air_density.to_numpy()) |
                          (np.isnan(new.on_site_air_density.to_numpy()) & np.isnan(old.on_site_air_density.to_numpy())))
        vo, vn = old[f"{tag}_viable"].to_numpy() == 1, new[f"{tag}_viable"].to_numpy() == 1
        # old k at full precision from the same predictor on the old inputs (the CSV
        # keeps only 6 dp, so comparing against it misses equal k: correction made
        # after the first run, see T061-phase-d-expectations.md)
        ko_csv = old[f"{tag}_k"].to_numpy()
        ko, _, _ = predict(old, so, tag)
        assert np.allclose(ko[np.isfinite(ko_csv)], ko_csv[np.isfinite(ko_csv)], atol=5e-7, rtol=0)
        prof_o = vo & np.isfinite(ko)
        prof_n = vn & np.isfinite(k)
        same_k = (k == ko)
        ident = (~prof_o & ~prof_n) | (prof_o & prof_n & same_col & same_curve & same_k)
        rows.update({f"{tag}_k_pred": k, f"{tag}_final_pred": fin, f"{tag}_clamped_pred": cl,
                     f"{tag}_identical": ident, f"{tag}_same_col": same_col})
        for lab, m in (("all 4,998", np.ones(len(new), bool)), ("deployed 4,465", dep)):
            fo, fn = old[f"{tag}_final_cf"].to_numpy(), fin
            both = prof_o & prof_n & m
            d = (fn - fo)[both] * 100
            print(f"{tag} [{lab}]: profiles {int((prof_o & m).sum())} -> {int((prof_n & m).sum())}; "
                  f"capped at k=1.8 {int(((old[f'{tag}_clamped'] == 1) & (ko >= 1.8) & m).sum())} -> {int(((cl == 1) & (k >= 1.8) & m).sum())}; "
                  f"at k=0.6 {int(((ko <= 0.6) & m).sum())} -> {int(((cl == 1) & (k <= 0.6) & m).sum())}; "
                  f"identical {int((ident & m).sum())} (no profile both {int((~prof_o & ~prof_n & m).sum())}, "
                  f"same column+k {int((ident & prof_o & m).sum())}); changed {int((~ident & m).sum())}; "
                  f"simulated CF change, both: median {np.median(d):+.2f} pp [p10 {np.percentile(d, 10):+.2f}, p90 {np.percentile(d, 90):+.2f}]; "
                  f"median final CF {np.nanmedian(old[f'{tag}_final_cf'][prof_o & m]):.3f} -> {np.nanmedian(fin[prof_n & m]):.3f}")
    P = pd.DataFrame(rows)
    # wind_mix add-on regions: deployed with land and sea
    wm_o = dep & (old.on_area_km2 > 0).to_numpy() & (old.off_area_km2 > 0).to_numpy()
    wm_n = dep & (new.on_area_km2 > 0).to_numpy() & (new.off_area_km2 > 0).to_numpy()
    wm_ident = wm_o & wm_n & P.on_identical.to_numpy() & P.off_identical.to_numpy()
    print(f"addon_wind_mix regions {int(wm_o.sum())} -> {int(wm_n.sum())} (lost {int((wm_o & ~wm_n).sum())}); "
          f"regions whose rows must be identical (both profiles identical) {int(wm_ident.sum())}; addon_large: byte-identical (reads no wind)")
    print(f"off_viable changes (deployed): {int(((old.off_viable != new.off_viable).to_numpy() & dep).sum())} "
          f"-> voronoi_local_capex wind_off_flags may change only there")
    nl = new.location_id.isin([4894, 3508]).to_numpy()
    for i in np.nonzero(nl)[0]:
        print(f"NL {new.location_id[i]}: on target {old.on_cf_target[i]:.4f} -> {new.on_cf_target[i]:.4f}; "
              f"final {old.on_final_cf[i]:.4f} -> {P.on_final_pred[i]:.4f} (k {P.on_k_pred[i]:.3f}); "
              f"off final {old.off_final_cf[i]:.4f} -> {P.off_final_pred[i]:.4f}")
    P.to_csv(C.guard_write(a.out), index=False, float_format="%.6f")


if __name__ == "__main__":
    main()
