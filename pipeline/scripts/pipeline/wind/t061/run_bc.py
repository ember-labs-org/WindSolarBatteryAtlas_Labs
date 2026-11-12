"""Phase B report and Phase C sweep (T061). Writes only under the run directory.

  python3 -I -m t061.run_bc --baseline <deployment/data/voronoi_wind_resource.csv>
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from . import sweep as W

# name -> (protected areas on?, settlement threshold index or None, setback index or None)
# thresholds (exclusions.SETTLEMENT_MIN_SHARE): 0 = 10% of a 3" cell built, 1 = 20%
# setbacks (exclusions.SETBACKS_M): 0 = 0 m, 1 = 500 m, 2 = 1 km
VARIANTS = {
    "current": (False, None, None),
    "pa": (True, None, None),
    "new0": (True, 0, 0),
    "new500": (True, 0, 1),
    "new1000": (True, 0, 2),
    "new500_t20": (True, 1, 1),
    "new1000_t20": (True, 1, 2),
}


class Layers:
    def __init__(self, px):
        S, G = C.import_siting()
        z = np.load(C.CACHE / "setback_excl_pct_002deg.npz")
        ex = z["excl_pct"]
        self.sb = {(t, k): ex[t, k].ravel()[px["on_flat"]] for t in range(ex.shape[0]) for k in range(ex.shape[1])}
        del ex
        pa = np.load(C.CACHE / "pa_share_002deg.npz")
        a_on = pa["pa_all"].ravel()[px["on_flat"]].astype("float32") / 100
        i_on = pa["pa_iucn"].ravel()[px["on_flat"]].astype("float32") / 100
        # extra PA beyond ESMAP's IUCN layer, as a share of what ESMAP left
        self.pa_all_on = a_on
        self.pa_add_on = np.clip(np.divide(a_on - i_on, 1 - i_on, out=np.ones_like(a_on), where=i_on < 1), 0, 1)
        self.pa_off = pa["pa_all"].ravel()[px["off_flat"]].astype("float32") / 100


def variant_elig(px, L, spec, cap_pa: bool = True):
    """New eligible share (uint8 per cent) per pixel of the pixel table.

    cap_pa (audit F3, D-134): the eligible share never exceeds 1 - the pixel's
    share inside any kept 2026 protected area, because ESMAP's older IUCN layer
    missed some newer IUCN area that the (all - iucn) adjustment assumed gone.
    """
    pa_on, t, k = spec
    if not pa_on and t is None:
        return None, None
    on = px["on_elig"].astype("float32")
    off = px["off_elig"].astype("float32")
    if pa_on:
        on = on * (1 - L.pa_add_on)
        off = off * (1 - L.pa_off)
    if t is not None:
        on = on * (1 - L.sb[(t, k)].astype("float32") / 100)
    if pa_on and cap_pa:
        on = np.minimum(on, 100.0 * (1 - L.pa_all_on))
    return np.rint(on).astype("uint8"), np.rint(off).astype("uint8")


def phase_b(ctx, eligs, out: Path) -> pd.DataFrame:
    px = ctx.px
    cidx, codes = C.pixel_country()
    rows = []
    for v, (on, off) in eligs.items():
        w = C.weights(px, "on", on)
        a = np.bincount(cidx[cidx >= 0], weights=w[cidx >= 0], minlength=len(codes))
        rows.append(pd.Series(a, index=codes, name=v))
    t = pd.concat(rows, axis=1)
    t = t[t["current"] > 0]
    for v in eligs:
        if v != "current":
            t[f"{v}_change_pct"] = 100 * (t[v] / t["current"] - 1)
    t.sort_values("current", ascending=False).to_csv(out / "B_eligible_area_by_country.csv", float_format="%.1f")
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=C.RUN_DIR / "results")
    a = ap.parse_args()
    out = C.guard_write(a.out)
    ctx = W.Ctx(a.baseline)
    L = Layers(ctx.px)
    eligs = {v: variant_elig(ctx.px, L, spec) for v, spec in VARIANTS.items()}
    eligs["current"] = (ctx.px["on_elig"], ctx.px["off_elig"])
    del L
    phase_b(ctx, eligs, out)
    eligs["current"] = (None, None)
    recs, bands, tabs = [], [], []
    for v, (el_on, el_off) in eligs.items():
        for sh in [None] + W.SHARES:
            r, b, t = W.evaluate(ctx, v, el_on, el_off, sh)
            recs.append(r); bands.append(b); tabs.append(t)
            print(v, sh, round(r["on_ratio_newbuild_cf_genw"], 3), flush=True)
    R = pd.DataFrame(recs)
    R.to_csv(out / "C_sweep.csv", index=False, float_format="%.5f")
    pd.concat(bands).to_csv(out / "C_bands.csv", index=False, float_format="%.3f")
    T = pd.concat(tabs)
    T.to_csv(out / "C_country_tables.csv", index=False, float_format="%.4f")
    # level-correction option on every combination
    lv = []
    for (v, sh), t in T.groupby(["variant", "share"], sort=False):
        for tag in ("on", "off"):
            fg = W.fit_factor(t, tag, by_region=False)
            fr = W.fit_factor(t, tag, by_region=True) if tag == "on" else None
            s = t[t["surface"] == tag].copy()
            row = {"variant": v, "share": sh, "surface": tag, "factor_global": fg,
                   "equiv_losses_global": 1 - fg * (1 - C.LOSSES)}
            for lab, f in (("global", fg), ("regional", fr)):
                if f is None:
                    continue
                if isinstance(f, dict):
                    ff = s["iso3"].map(W.ISO_BROAD).fillna("other").map(lambda b: f.get(b, f["other"]))
                else:
                    ff = f
                s2 = s.assign(atlas_cf=s["atlas_cf"] * ff)
                for ref in ("newbuild_cf", "fleet_cf"):
                    m = W.K.metrics(s2, "atlas_cf", ref)
                    row[f"{lab}_{ref}_genw"] = m["gen_weighted_ratio"]
                    row[f"{lab}_{ref}_within10"] = m["share_within_10pct"]
                    row[f"{lab}_{ref}_median"] = m["median_ratio"]
            if fr:
                for k, x in fr.items():
                    row[f"factor_region:{k}"] = x
            lv.append(row)
    pd.DataFrame(lv).to_csv(out / "C_level_correction.csv", index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
