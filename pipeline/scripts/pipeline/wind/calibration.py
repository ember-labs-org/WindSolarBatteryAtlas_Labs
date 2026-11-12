"""Wind calibration benchmark (T061, standing check, D-133).

Compares the atlas's wind capacity factors with observed ones, per country, for
onshore and offshore wind. Every later wind change reports this table.

Per country with meaningful wind (onshore >= 1 GW, offshore >= 0.5 GW):
  fleet_cf      observed fleet CF: generation / mean capacity over the year,
                mean of 2022-2024. IRENA Renewable Energy Statistics 2026
                (on/offshore split); Ember yearly data (Sept 2026, all wind)
                where IRENA's onshore series is unusable (see FLEET_FALLBACK).
  newbuild_cf   IRENA Renewable Power Generation Costs in 2025: weighted-average
                CF of projects commissioned in 2023-2025 (onshore, fig. 2.8) or
                2024-2025 (offshore, fig. 4.7), where published.
  atlas_cf      the atlas level of the regions where the country's wind is,
                under the rule being tested (default: the resource CSV's
                <tag>_cf_target, i.e. the current best-500 km2 rule).
  sim_cf        what the app simulates: the hourly profile's annual mean
                (<tag>_final_cf), below atlas_cf where k = 1.8 binds (T061 audit F3).
  median_cf     area-weighted median net CF of eligible land (<tag>_cf_p50).
  plant_cf      GWA net CF (same IEC-class layers and 12% loss as the atlas) at
                the pixels of the country's operating wind farms (GEM, Sept 2025):
                what the atlas's resource layer says the existing fleet should
                produce. plant_cf_new uses farms starting 2020 or later.

Weighting regions to country: by the operating wind capacity (GEM Global
Integrated Power Tracker, Sept 2025, operating units, onshore/offshore by GEM
technology) that each region holds in that country. That is the weighting that
makes atlas_cf comparable with fleet CF (generation / capacity). Countries with
no GEM capacity of that surface fall back to eligible-area weighting over the
regions whose main country it is.

Comparability: fleet CF includes old, short turbines, curtailment and outages,
so it is a lower bound. New-build CF is the fairer target. The atlas is net of
12% losses at IEC-class turbines at 100 m hub (offshore 150 m).

Usage (as a script, reading a resource CSV; writes only to --out):
  python3 -I calibration.py --resource <voronoi_wind_resource.csv> --out <dir> [--label baseline]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
OBSERVED_CSV = HERE / "data" / "calibration_observed.csv"
MIN_GW = {"on": 1.0, "off": 0.5}
# IRENA statistics onshore generation for these is unusable: use Ember all-wind (no
# offshore there). South Africa (0.3 TWh for 3.2 GW, about 1% CF; Ember 10.8 TWh) has its
# IRENA generation dropped from calibration_observed.csv since T068 (D-146), so it takes
# the no-IRENA fallback; it stays listed here as a guard.
FLEET_FALLBACK = {"ZAF"}
# excluded from metrics: fleet output dominated by war damage
EXCLUDE = {"UKR"}
# (iso3, surface) rows excluded from the standing check's metrics (T068, D-146 follow-up):
# IRENA's China offshore fleet CF (24.5%) is implausible (an apportioning artefact, T061 audit
# F10) and no public replacement exists (no CEC offshore utilisation-hours figure found).
# Reporting only: the fitted level factors (x0.879, x0.777) are unchanged.
EXCLUDE_ROWS = {("CHN", "off")}
TABLE_ISO = ["NLD", "DEU", "GBR", "DNK", "ESP", "FRA", "POL", "SWE", "USA", "CHN",
             "IND", "BRA", "AUS", "ZAF", "TUR", "MEX"]
GEM_NAME_FIX = {"United States": "USA", "Türkiye": "TUR", "Dominican Republic": "DOM",
                "Israel": "ISR", "Bosnia and Herzegovina": "BIH", "Czech Republic": "CZE",
                "Kosovo": "XKX", "Luxembourg": "LUX", "Western Sahara": "ESH"}


def load_observed() -> pd.DataFrame:
    o = pd.read_csv(OBSERVED_CSV, comment="#")
    use_ember = o["iso3"].isin(FLEET_FALLBACK) & (o["surface"] == "on") & (o["ember_has_offshore"] == 0)
    no_irena = o["irena_fleet_cf"].isna() & (o["surface"] == "on") & (o["ember_has_offshore"] == 0)
    o["fleet_cf"] = np.where(use_ember | no_irena, o["ember_wind_cf"], o["irena_fleet_cf"])
    o["fleet_twh"] = np.where(use_ember | no_irena, o["ember_wind_twh"], o["irena_twh"])
    o["fleet_source"] = np.where(use_ember | no_irena, "Ember 2022-24 (all wind)",
                                 np.where(o["irena_fleet_cf"].notna(), "IRENA stats 2022-24", ""))
    o["fleet_gw"] = o["irena_gw"]
    return o


def gem_operating(gem_parquet: Path, country_names: dict) -> pd.DataFrame:
    g = pd.read_parquet(gem_parquet)
    g = g[(g["Status"] == "operating") & g["Latitude"].notna() & g["Longitude"].notna()].copy()
    g["surface"] = np.where(g["Technology"].str.startswith("Offshore"), "off", "on")
    g["iso3"] = g["Country/area"].map(lambda n: GEM_NAME_FIX.get(n, country_names.get(n)))
    g["mw"] = g["Capacity (MW)"].astype(float)
    return g


def country_atlas(plants: pd.DataFrame, region_val: dict, region_area: dict,
                  main_country: pd.Series) -> pd.DataFrame:
    """Capacity-weighted (GEM) country means of region values; area fallback.

    plants: columns iso3, surface, mw, region (0-based point index), plant_cf.
    region_val[(tag, name)] -> array over regions; region_area[tag] -> eligible km2.
    """
    out = []
    for tag in ("on", "off"):
        p = plants[(plants["surface"] == tag) & (plants["region"] >= 0)]
        names = [k[1] for k in region_val if k[0] == tag]
        for iso, grp in p.groupby("iso3"):
            r = grp["region"].to_numpy()
            w = grp["mw"].to_numpy()
            row = {"iso3": iso, "surface": tag, "gem_gw": w.sum() / 1e3, "weighting": "GEM capacity"}
            for nm in names:
                v = region_val[(tag, nm)][r]
                ok = np.isfinite(v)
                row[nm] = np.sum(v[ok] * w[ok]) / w[ok].sum() if ok.any() else np.nan
                row[f"{nm}__covered"] = w[ok].sum() / w.sum()
            pc = grp["plant_cf"].to_numpy()
            ok = np.isfinite(pc)
            row["plant_cf"] = np.sum(pc[ok] * w[ok]) / w[ok].sum() if ok.any() else np.nan
            new = (grp["Start year"] >= 2020).to_numpy() & ok
            row["plant_cf_new"] = np.sum(pc[new] * w[new]) / w[new].sum() if new.any() else np.nan
            row["gem_gw_new"] = w[new].sum() / 1e3
            out.append(row)
        # area fallback for countries without GEM capacity of this surface
        have = {o["iso3"] for o in out if o["surface"] == tag}
        a = region_area[tag]
        for iso, idx in main_country.groupby(main_country).groups.items():
            if iso in have:
                continue
            ii = np.asarray(list(idx))
            ww = a[ii]
            if not np.nansum(ww) > 0:
                continue
            row = {"iso3": iso, "surface": tag, "gem_gw": 0.0, "weighting": "eligible area"}
            for nm in names:
                v = region_val[(tag, nm)][ii]
                ok = np.isfinite(v) & (ww > 0)
                row[nm] = np.sum(v[ok] * ww[ok]) / ww[ok].sum() if ok.any() else np.nan
            out.append(row)
    return pd.DataFrame(out)


def metrics(t: pd.DataFrame, col: str, ref: str, weight: str = "fleet_twh") -> dict:
    dropped = pd.Series([(i, sf) in EXCLUDE_ROWS for i, sf in zip(t["iso3"], t["surface"])], index=t.index) \
        if "surface" in t.columns else False
    s = t[t[col].notna() & t[ref].notna() & ~t["iso3"].isin(EXCLUDE) & ~dropped]
    r = s[col] / s[ref]
    w = s[weight].fillna(0)
    return {"n": len(s),
            "gen_weighted_ratio": float(np.sum(r * w) / w.sum()) if w.sum() > 0 else np.nan,
            "median_ratio": float(r.median()) if len(s) else np.nan,
            "share_within_10pct": float((np.abs(r - 1) <= 0.10).mean()) if len(s) else np.nan}


def build_table(country: pd.DataFrame, observed: pd.DataFrame) -> pd.DataFrame:
    t = country.merge(observed, on=["iso3", "surface"], how="outer")
    t["fleet_gw_any"] = t["fleet_gw"].fillna(t["gem_gw"])
    keep = ((t["surface"] == "on") & (t["fleet_gw_any"] >= MIN_GW["on"])) | \
           ((t["surface"] == "off") & (t["fleet_gw_any"] >= MIN_GW["off"]))
    return t[keep].sort_values(["surface", "fleet_twh"], ascending=[True, False])
