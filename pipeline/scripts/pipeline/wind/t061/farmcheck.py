"""Existing-farm sanity bound for exclusion variants (T061, audit F6).

Two measures, onshore GEM operating units (Sept 2025):

1. Points (`points`): distance from each exact-location farm point to the nearest
   GHSL settlement 3" cell, for several built-share thresholds; reported as the
   share of capacity within 0 / 500 / 1,000 m (B_farm_check.txt).
2. Pixels (`pixels`): at each farm's 0.02 deg pixel, the share of today's eligible
   land a variant removes, 1 - new/old, capacity-weighted. Reported two ways:
   over all farm pixels, treating the variant's own exclusion share as the
   removal where old = 0 (the gate C report's "54%"), and over farm pixels with
   old > 0 only (the audit's "61%"). Also capacity on 0%-eligible pixels today.

  cd pipeline/scripts/pipeline/wind && python3 -m t061.farmcheck   (not -I: it needs the cwd on sys.path)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import common as C
from . import exclusions as E

ISO = ["ALL", "NLD", "DEU", "GBR", "DNK", "FRA", "ESP", "POL", "SWE", "USA", "CHN", "IND", "BRA", "AUS", "ZAF", "TUR", "MEX"]


def points(ghsl_tif) -> str:
    g = pd.read_parquet(C.CACHE / "gem_plants_t061.parquet")
    g = g[(g.surface == "on") & (g["Location accuracy"] == "exact") & g.iso3.notna()]
    d = E.farm_check(ghsl_tif, g)
    d.to_csv(C.guard_write(C.RUN_DIR / "results" / "B_farm_distances.csv"), index=False)
    L = [f"{len(d)} exact-location onshore farm units, {d.mw.sum()/1e3:.0f} GW",
         "Share of existing onshore capacity (GEM Sept 2025, exact locations) whose point lies within d of a settlement cell"]
    for th in (0.01, 0.05, 0.10, 0.20):
        rows = []
        for iso in ISO:
            x = d if iso == "ALL" else d[d.iso3 == iso]
            if len(x) == 0:
                continue
            f = lambda dd: (x.mw * (x[f"d_{th}"] <= dd)).sum() / x.mw.sum()
            rows.append(f"{iso} {f(0):.0%}/{f(500):.0%}/{f(1000):.0%}")
        L.append(f"threshold {th:.0%} of cell built  (setback 0 / 500 m / 1 km): " + "; ".join(rows))
    return "\n".join(L)


def variant_shares(row, col, old_pct, cap_pa: bool = True) -> dict:
    """New eligible share (0..1) at given pixels for each variant, from the cached layers."""
    sb = np.load(C.CACHE / "setback_excl_pct_002deg.npz")["excl_pct"]
    pa = np.load(C.CACHE / "pa_share_002deg.npz")
    a = pa["pa_all"][row, col] / 100.0
    i = pa["pa_iucn"][row, col] / 100.0
    add = np.clip(np.divide(a - i, 1 - i, out=np.ones_like(a), where=i < 1), 0, 1)
    old = old_pct / 100.0
    out = {"pa": old * (1 - add)}
    for t, tn in ((0, "t10"), (1, "t20")):
        for k, kn in ((0, "0"), (1, "500"), (2, "1000")):
            out[f"new{kn}_{tn}"] = old * (1 - add) * (1 - sb[t, k][row, col] / 100.0)
    if cap_pa:
        out = {k: np.minimum(v, 1 - a) for k, v in out.items()}
    return out


def pixels() -> str:
    import rasterio
    S, G = C.import_siting()
    g = pd.read_parquet(C.CACHE / "gem_plants_t061.parquet")
    g = g[(g.surface == "on") & g.iso3.notna()]
    with rasterio.open(S.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        el = s.read(1)[g.row.to_numpy(), g.col.to_numpy()].astype(float)
    L = ["Existing onshore farms (GEM Sept 2025, operating, all units) at their 0.02 deg pixel.",
         f"Capacity on pixels 0% eligible today: " + ", ".join(
             f"{iso} {((g.iso3 == iso) & (el == 0)).mul(g.mw).sum() / g.mw[g.iso3 == iso].sum():.0%}"
             for iso in ISO[1:6]) + f"; World {(g.mw * (el == 0)).sum() / g.mw.sum():.0%}"]
    for cap in (False, True):
        V = variant_shares(g.row.to_numpy(), g.col.to_numpy(), el, cap_pa=cap)
        V1 = variant_shares(g.row.to_numpy(), g.col.to_numpy(), np.full(len(g), 100.0), cap_pa=cap)
        for basis in ("all", "eligible"):
            rows = []
            for iso in ISO:
                m = np.ones(len(g), bool) if iso == "ALL" else (g.iso3 == iso).to_numpy()
                if basis == "eligible":
                    m &= el > 0
                w = g.mw.to_numpy()[m]
                r = {"iso3": iso, "GW": round(w.sum() / 1e3, 1)}
                for k in V:
                    if basis == "all":
                        rem = 1 - V1[k][m]            # the variant's own exclusion share at the pixel
                    else:
                        rem = 1 - V[k][m] / (el[m] / 100.0)
                    r[k] = f"{np.average(rem, weights=w):.0%}" if w.sum() > 0 else "–"
                rows.append(r)
            L.append(f"\nShare of land removed at farm pixels, capacity-weighted; basis = {basis} "
                     f"({'variant exclusion share at every farm pixel, as the gate C report' if basis == 'all' else '1 - new/old over farm pixels eligible today, as the audit'}); "
                     f"PA cap (F3) {'on' if cap else 'off'}")
            L.append(pd.DataFrame(rows).to_string(index=False))
    return "\n".join(L)


if __name__ == "__main__":
    print(pixels())
