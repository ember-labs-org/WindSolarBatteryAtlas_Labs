"""Gap decomposition and capped regional level factor (T061 Phase C, lead's option c).

Onshore, per country with an IRENA new-build CF, the baseline gap
atlas(current exclusions, best 500 km2) / new-build splits multiplicatively into
  (c) level       plant_cf_new / new-build: the atlas's own net-CF layer at farms
                  built since 2020, against what new farms report;
  (b) exclusions  atlas(current) / atlas(variant), same rule: land the stronger
                  exclusions remove;
  (a) site choice atlas(variant) / plant_cf_new: the rule's land against where
                  farms are actually built.
Shares are of the log gap.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calibration as K  # noqa: E402
from . import sweep as W  # noqa: E402


def decompose(T: pd.DataFrame, variant: str, share: str = "best500") -> pd.DataFrame:
    on = T[T["surface"] == "on"]
    base = on[(on["variant"] == "current") & (on["share"] == share)].set_index("iso3")
    var = on[(on["variant"] == variant) & (on["share"] == share)].set_index("iso3")
    d = pd.DataFrame({"newbuild": base["newbuild_cf"], "plant_new": base["plant_cf_new"].fillna(base["plant_cf"]),
                      "atlas_current": base["atlas_cf"], "atlas_variant": var["atlas_cf"],
                      "fleet_twh": base["fleet_twh"]}).dropna(subset=["newbuild", "atlas_current"])
    d["gap"] = d["atlas_current"] / d["newbuild"]
    d["level"] = d["plant_new"] / d["newbuild"]
    d["exclusions"] = d["atlas_current"] / d["atlas_variant"]
    d["site"] = d["atlas_variant"] / d["plant_new"]
    lg = np.log(d["gap"])
    for k in ("level", "exclusions", "site"):
        d[f"{k}_share_of_gap"] = np.where(np.abs(lg) > 0.01, np.log(d[k]) / lg, np.nan)
    return d.drop(index=list(K.EXCLUDE), errors="ignore")


def total(d: pd.DataFrame) -> dict:
    w = d["fleet_twh"].fillna(0)
    out = {k: float(np.exp(np.sum(np.log(d[k]) * w) / w.sum())) for k in ("gap", "level", "exclusions", "site")}
    lg = np.log(out["gap"])
    out.update({f"{k}_share_of_gap": float(np.log(out[k]) / lg) for k in ("level", "exclusions", "site")})
    return out


def capped_regional(T: pd.DataFrame, variant: str, share: str, cap: float = 1.0):
    """Regional factor fitted to new-build, applied only downwards (factor <= cap)."""
    t = T[(T["variant"] == variant) & (T["share"].astype(str) == share)]
    f = W.fit_factor(t, "on", by_region=True)
    f = {k: min(v, cap) for k, v in f.items()}
    s = t[t["surface"] == "on"].copy()
    ff = s["iso3"].map(W.ISO_BROAD).fillna("other").map(lambda b: f.get(b, f["other"]))
    s["atlas_cf"] = s["atlas_cf"] * ff
    return f, s, {ref: K.metrics(s, "atlas_cf", ref) for ref in ("newbuild_cf", "fleet_cf")}
