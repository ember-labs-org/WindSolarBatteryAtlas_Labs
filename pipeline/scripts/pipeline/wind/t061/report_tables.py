"""Collect the numbers for team/reports/T061-site-rule.md and the HTML before/after."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from . import sweep as W
from . import decompose as X

REC = ("new500_t20", "20")
ALTS = [("current", "best500", "none", "Today"),
        ("current", "20", "none", "Share only"),
        ("new500_t20", "20", "none", "Exclusions + share"),
        ("new500_t20", "20", "capped", "Recommended: exclusions + share + level"),
        ("new0", "30", "none", "Light exclusions, 30%"),
        ("new500_t20", "best500", "capped", "Exclusions + level, keep 500 km²")]
ISO16 = ["NLD", "DEU", "GBR", "DNK", "ESP", "FRA", "POL", "SWE", "USA", "CHN", "IND", "BRA", "AUS", "ZAF", "TUR", "MEX"]


def build(res: Path) -> dict:
    S, G = C.import_siting()
    R = pd.read_csv(res / "C_sweep.csv", dtype={"share": str})
    T = pd.read_csv(res / "C_country_tables.csv", dtype={"share": str})
    B = pd.read_csv(res / "C_bands.csv", dtype={"share": str})
    pts = pd.read_csv(S.POINTS_CSV)
    oc = pd.read_csv(S.OUTPUTS_DIR / "voronoi_overlapping_countries.csv").set_index("location_id")
    ctry = oc.reindex(pts["location_id"])["country_iso3"].to_numpy()
    out = {"alts": [], "countries": {}, "cities": [], "bands": {}}
    for v, s, lvl, label in ALTS:
        r = R[(R.variant == v) & (R.share == s)].iloc[0]
        t = T[(T.variant == v) & (T.share == s)]
        if lvl == "capped":
            f, so, m = X.capped_regional(T, v, s)
        else:
            f, so = None, t[t.surface == "on"]
            m = {ref: W.K.metrics(so, "atlas_cf", ref) for ref in ("newbuild_cf", "fleet_cf")}
        out["alts"].append({"label": label, "variant": v, "share": s, "level": lvl,
                            "factors": {k: round(float(x), 3) for k, x in (f or {}).items()},
                            "nb": m["newbuild_cf"], "fl": m["fleet_cf"],
                            "pot": float(r["on_potential_tw"]), "elig": float(r["on_eligible_km2"]),
                            "nl": [float(r["nl_on:4894"]) * (f or {}).get("Europe", 1.0),
                                   float(r["nl_on:3508"]) * (f or {}).get("Europe", 1.0)]})
        out["countries"][label] = so.set_index("iso3")["atlas_cf"].reindex(ISO16).round(4).to_dict()
        if lvl == "capped" or (v, s) == ("current", "best500"):
            for nm, la, lo in W.CITIES:
                i = int(np.argmin(W.hav(la, lo, pts["latitude"].to_numpy(), pts["longitude"].to_numpy())))
                fac = (f or {}).get(W.ISO_BROAD.get(ctry[i], "other"), (f or {}).get("other", 1.0)) if f else 1.0
                out["cities"].append({"alt": label, "city": nm, "id": int(pts["location_id"][i]),
                                      "on": float(r[f"city_on:{nm}"]) * fac,
                                      "off": float(r[f"city_off:{nm}"])})
    b = B[(B.variant == REC[0]) & (B.share == REC[1])]
    out["bands"] = b.to_dict(orient="records")
    base = pd.read_csv(res / "calibration_baseline.csv")
    out["base"] = base[["surface", "iso3", "fleet_cf", "newbuild_cf", "atlas_cf", "median_cf", "plant_cf",
                        "plant_cf_new", "fleet_source", "newbuild_years", "fleet_twh"]].to_dict(orient="records")
    off = R[(R.share.isin(["best500", "20"]))][["variant", "share", "off_ratio_newbuild_cf_genw",
                                                   "off_ratio_fleet_cf_genw", "off_potential_tw",
                                                   "off_regions_lost_all_land"]]
    out["off"] = off.to_dict(orient="records")
    L = pd.read_csv(res / "C_level_correction.csv", dtype={"share": str})
    out["off_level"] = L[(L.surface == "off") & (L.variant == REC[0]) & (L.share == REC[1])].iloc[0].to_dict()
    d = X.decompose(T, REC[0])
    out["decomp"] = d.reset_index().to_dict(orient="records")
    out["decomp_total"] = X.total(d)
    return out


if __name__ == "__main__":
    res = C.RUN_DIR / "results"
    o = build(res)
    (C.guard_write(res / "C_report_numbers.json")).write_text(json.dumps(o, indent=1, default=float))
    for a in o["alts"]:
        print(a["label"], a["variant"], a["share"], a["level"], {k: (round(v, 3) if isinstance(v, float) else v) for k, v in a["nb"].items()},
              "fleet", round(a["fl"]["gen_weighted_ratio"], 3), "pot", round(a["pot"], 1), "NL", [round(x, 3) for x in a["nl"]])
