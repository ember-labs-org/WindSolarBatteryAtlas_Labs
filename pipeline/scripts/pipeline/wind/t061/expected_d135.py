"""D-135 expectations, stated before the rerun (T061).

Only the onshore level factor changes, in the regions listed by comparing the
D-134 and D-135 factor files. Siting does not read the factor, so sites, areas,
cf_best and the ERA5 columns are unchanged. Predicts the new cf_target, k and
simulated CF (same solve_k as build_wind_profiles), and the identity sets.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from .expected_d import predict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--d134-resource", type=Path, required=True, help="D-134 run CSV with k diagnostics (unfiltered)")
    ap.add_argument("--f134", type=Path, required=True)
    ap.add_argument("--f135", type=Path, required=True)
    ap.add_argument("--speeds", type=Path, required=True)
    ap.add_argument("--excluded", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    old = pd.read_csv(a.d134_resource)
    f4 = pd.read_csv(a.f134).set_index("location_id").reindex(old.location_id)
    f5 = pd.read_csv(a.f135).set_index("location_id").reindex(old.location_id)
    sp = dict(np.load(a.speeds))
    excl = {r["location_id"] for r in json.loads(a.excluded.read_text())["regions"]}
    dep = ~old.location_id.isin(excl).to_numpy()
    chg = (f4.on_level_factor.to_numpy() != f5.on_level_factor.to_numpy())
    # cf_best at full precision from the pixel table (equals site_selection's to 6 dp,
    # D_site_checks.txt), then written as site_selection writes it (%.6f)
    from . import run_bc as RB
    px = C.load_pixels()
    el, _ = RB.variant_elig(px, RB.Layers(px), RB.VARIANTS["new0"], cap_pa=True)
    w = C.weights(px, "on", el); m = w > 0
    best, _ = C.share_mean_by_zone(px["on_zone"][m], px["on_cf"][m], w[m], len(old), 0.2, 500.0)
    assert np.nanmax(np.abs(np.round(best, 6) - old.on_cf_best.to_numpy())) < 1e-9
    new = old.copy()
    tgt = np.round(best * f5.on_level_factor.to_numpy(), 6)
    assert np.array_equal(np.nan_to_num(tgt[~chg], nan=-1), np.nan_to_num(old.on_cf_target.to_numpy()[~chg], nan=-1))
    new["on_cf_target"] = tgt
    k_o, fin_o, cl_o = predict(old, sp, "on")
    k_n, fin_n, cl_n = predict(new, sp, "on")
    prof_o, prof_n = np.isfinite(k_o), np.isfinite(k_n)
    ident = (~prof_o & ~prof_n) | (prof_o & prof_n & (k_o == k_n))
    assert ident[~chg].all(), "a region whose factor is unchanged is predicted to change"
    P = pd.DataFrame({"location_id": old.location_id, "deployed": dep, "factor_changed": chg,
                      "factor_d134": f4.on_level_factor.to_numpy(), "factor_d135": f5.on_level_factor.to_numpy(),
                      "country_iso3": f5.country_iso3.to_numpy(),
                      "cf_target_d134": old.on_cf_target.to_numpy(), "cf_target_d135": new.on_cf_target.to_numpy(),
                      "k_d134": k_o, "k_d135": k_n, "final_d134": fin_o, "final_d135": fin_n,
                      "clamped_d135": cl_n, "on_identical": ident})
    P.to_csv(C.guard_write(a.out), index=False, float_format="%.6f")
    print("D-135 expectations (stated before the rerun)")
    for lab, m in (("all 4,998", np.ones(len(P), bool)), ("deployed 4,465", dep)):
        c = chg & m
        print(f"[{lab}] factor changes in {int(c.sum())} regions "
              f"({', '.join(f'{k} {v}' for k, v in P[c].groupby(['country_iso3', 'factor_d135']).size().items())}); "
              f"with a profile {int((c & prof_n).sum())}; onshore profiles identical {int((ident & m).sum())}, changed {int((~ident & m).sum())}; "
              f"clamped at k = 1.8 {int(((cl_o == 1) & (k_o >= 1.8) & m).sum())} -> {int(((cl_n == 1) & (k_n >= 1.8) & m).sum())}")
    ch = P[~P.on_identical & P.deployed]
    print(f"changed regions (deployed): median cf_target {100*ch.cf_target_d134.median():.1f}% -> {100*ch.cf_target_d135.median():.1f}%; "
          f"median simulated {100*ch.final_d134.median():.1f}% -> {100*ch.final_d135.median():.1f}%")
    print("changed regions, location_id: cf_target D-134 -> D-135 (simulated):")
    for r in P[~P.on_identical].itertuples():
        print(f"  {r.location_id} {r.country_iso3} dep={int(r.deployed)}: {r.cf_target_d134:.6f} -> {r.cf_target_d135:.6f} "
              f"(sim {r.final_d134:.6f} -> {r.final_d135:.6f}, k {r.k_d134:.4f} -> {r.k_d135:.4f})")
    unch = P[P.factor_changed & P.on_identical]
    print(f"factor changed but profile identical (clamped at k = 1.8 both times or no profile): {len(unch)} "
          f"{unch.location_id.tolist()}")
    res = pd.read_csv(a.d134_resource)
    wm = dep & (res.on_area_km2 > 0).to_numpy() & (res.off_area_km2 > 0).to_numpy()
    print(f"addon_wind_mix: regions whose rows change = combined-wind regions with a changed onshore profile: "
          f"{int((wm & ~P.on_identical.to_numpy()).sum())} of {int(wm.sum())}")


if __name__ == "__main__":
    main()
