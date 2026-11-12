"""Phase C: share-of-land sweep x exclusion variant, CF levels only (no simulation).

For each exclusion variant (eligibility per pixel) and share X, computes every
region's onshore and offshore level (mean net CF of the best max(X%, 500 km2) of
eligible area), then the calibration metrics, the change against the shipped
best-500 km2 levels by CF band and latitude band, the 15 curve cities and the NL
regions, the viable-region count and potential (area at >= 15% x 5 MW/km2).

Also the level-correction option (lead, 30 Oct): a multiplicative factor on net
CF, global or by broad region, fitted so that the generation-weighted atlas /
new-build ratio is 1; reported as the equivalent loss assumption.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from . import plants as P

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calibration as K  # noqa: E402

SHARES = [5, 10, 20, 30, 50, 100]
CITIES = [('Tromsø', 69.65, 18.96), ('Stockholm', 59.33, 18.07), ('Edinburgh', 55.95, -3.19),
          ('Berlin', 52.52, 13.40), ('London', 51.51, -0.13), ('Chicago', 41.88, -87.63),
          ('Madrid', 40.42, -3.70), ('Beijing', 39.90, 116.40), ('Dallas', 32.78, -96.80),
          ('Delhi', 28.61, 77.21), ('Lagos', 6.52, 3.38), ('Jakarta', -6.21, 106.85),
          ('Johannesburg', -26.20, 28.05), ('Buenos Aires', -34.60, -58.38),
          ('Melbourne', -37.81, 144.96)]
NL_IDS = [4894, 3508]
AREA_CF = 0.15
MW_KM2 = {"on": 5.0, "off": 4.0}
# broad regions for the regional level factor (by country iso3)
BROAD = {
    "Europe": "AUT BEL BGR HRV CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX NLD NOR POL PRT ROU SRB SVK SVN ESP SWE CHE GBR UKR BIH",
    "North America": "USA CAN MEX",
    "China": "CHN TWN",
    "India & South Asia": "IND PAK LKA",
    "Latin America": "BRA ARG CHL PER URY CRI DOM PAN HND",
    "Oceania": "AUS NZL",
    "East & SE Asia": "JPN KOR VNM THA PHL LAO",
    "Africa & Middle East": "ZAF EGY MAR KEN ETH JOR TUN SAU ISR IRN TUR",
    "Central Asia & Russia": "KAZ UZB RUS",
}
ISO_BROAD = {iso: b for b, s in BROAD.items() for iso in s.split()}


def hav(a, b, c, d):
    a, b, c, d = map(np.radians, (a, b, c, d))
    return 2 * 6371 * np.arcsin(np.sqrt(np.sin((c - a) / 2) ** 2 + np.cos(a) * np.cos(c) * np.sin((d - b) / 2) ** 2))


class Ctx:
    def __init__(self, baseline_csv: Path):
        self.S, self.G = C.import_siting()
        self.pts = pd.read_csv(self.S.POINTS_CSV)
        self.n = len(self.pts)
        self.px = C.load_pixels()
        self.plants = P.build()
        self.obs = K.load_observed()
        oc = pd.read_csv(self.S.OUTPUTS_DIR / "voronoi_overlapping_countries.csv").set_index("location_id")
        self.main_ctry = oc.reindex(self.pts["location_id"])["country_iso3"].reset_index(drop=True)
        b = pd.read_csv(baseline_csv).set_index("location_id").reindex(self.pts["location_id"]).reset_index()
        self.base = {t: b[f"{t}_cf_target"].to_numpy(float) for t in ("on", "off")}
        self.base_area = {t: b[f"{t}_area_km2"].fillna(0).to_numpy(float) for t in ("on", "off")}
        self.shipped = b.notna().any(axis=1).to_numpy() & b["on_area_km2"].notna().to_numpy()
        self.lat = self.pts["latitude"].to_numpy()
        lon = self.pts["longitude"].to_numpy()
        self.city_idx = {nm: int(np.argmin(hav(la, lo, self.lat, lon))) for nm, la, lo in CITIES}
        ids = self.pts["location_id"].to_numpy()
        self.nl_idx = {i: int(np.nonzero(ids == i)[0][0]) for i in NL_IDS}

    def levels(self, tag: str, share: float | None, elig_pct: np.ndarray | None = None):
        px = self.px
        w = C.weights(px, tag, elig_pct)
        m = w > 0
        z, v, w = px[f"{tag}_zone"][m], px[f"{tag}_cf"][m], w[m]
        lev, tot = C.share_mean_by_zone(z, v, w, self.n, 0.0 if share is None else share / 100.0, 500.0)
        good = np.bincount(z[v >= AREA_CF], weights=w[v >= AREA_CF], minlength=self.n)
        return lev, tot, good


def evaluate(ctx: Ctx, variant: str, elig_on: np.ndarray | None, elig_off: np.ndarray | None,
             share: float | None, factor: dict | float = 1.0) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    vals, areas, rec = {}, {}, {"variant": variant, "share": "best500" if share is None else share}
    lv = {}
    for tag, el in (("on", elig_on), ("off", elig_off)):
        lev, tot, good = ctx.levels(tag, share, el)
        if isinstance(factor, dict):
            f = ctx.main_ctry.map(lambda i: factor.get(ISO_BROAD.get(i, "other"), factor.get("other", 1.0))).to_numpy(float)
        else:
            f = np.full(ctx.n, float(factor))
        lev = lev * f
        lv[tag] = lev
        vals[(tag, "atlas_cf")] = lev
        areas[tag] = tot
        rec[f"{tag}_viable_regions"] = int((tot > 0).sum())
        rec[f"{tag}_viable_regions_shipped_set"] = int(((tot > 0) & ctx.shipped).sum())
        rec[f"{tag}_eligible_km2"] = float(tot.sum())
        lost = (ctx.base_area[tag] > 0) & (tot <= 0) & ctx.shipped
        rec[f"{tag}_regions_lost_all_land"] = int(lost.sum())
        rec[f"{tag}_regions_lost_ids"] = " ".join(str(i) for i in ctx.pts["location_id"].to_numpy()[lost][:60])
        rec[f"{tag}_potential_tw"] = float(good[tot > 0].sum() * MW_KM2[tag] / 1e6)
        rec[f"{tag}_potential_tw_shipped_set"] = float(good[(tot > 0) & ctx.shipped].sum() * MW_KM2[tag] / 1e6)
    ctry = K.country_atlas(ctx.plants, vals, areas, ctx.main_ctry)
    t = K.build_table(ctry, ctx.obs)
    for tag in ("on", "off"):
        s = t[t["surface"] == tag]
        for ref in ("newbuild_cf", "fleet_cf"):
            m = K.metrics(s, "atlas_cf", ref)
            rec[f"{tag}_ratio_{ref}_genw"] = m["gen_weighted_ratio"]
            rec[f"{tag}_ratio_{ref}_median"] = m["median_ratio"]
            rec[f"{tag}_within10_{ref}"] = m["share_within_10pct"]
            rec[f"{tag}_n_{ref}"] = m["n"]
    # change against shipped levels, regions with a level in both, by band
    rows = []
    for tag in ("on", "off"):
        b, a = ctx.base[tag], lv[tag]
        ok = np.isfinite(b) & np.isfinite(a)
        d = (a - b)[ok] * 100
        cfb = pd.cut(b[ok], [0, .2, .3, .4, .5, 1.01], labels=["<20%", "20-30%", "30-40%", "40-50%", ">=50%"])
        latb = pd.cut(np.abs(ctx.lat[ok]), [0, 15, 30, 45, 60, 91], right=False,
                      labels=["0-15", "15-30", "30-45", "45-60", "60+"])
        for kind, band in (("cf", cfb), ("lat", latb)):
            g = pd.Series(d).groupby(np.asarray(band))
            for k, s in g:
                rows.append({"variant": variant, "share": rec["share"], "surface": tag, "band_kind": kind,
                             "band": k, "n": len(s), "median_pp": s.median(), "p10_pp": s.quantile(.1),
                             "p90_pp": s.quantile(.9)})
        rec[f"{tag}_change_median_pp"] = float(np.median(d)) if d.size else np.nan
    for nm, i in ctx.city_idx.items():
        rec[f"city_on:{nm}"] = lv["on"][i]
        rec[f"city_off:{nm}"] = lv["off"][i]
    for lid, i in ctx.nl_idx.items():
        rec[f"nl_on:{lid}"] = lv["on"][i]
        rec[f"nl_off:{lid}"] = lv["off"][i]
    t = t.assign(variant=variant, share=rec["share"])
    return rec, pd.DataFrame(rows), t


def fit_factor(t: pd.DataFrame, tag: str = "on", by_region: bool = False) -> dict | float:
    """Factor on net CF that makes the generation-weighted atlas/new-build ratio 1."""
    s = t[(t["surface"] == tag) & t["atlas_cf"].notna() & t["newbuild_cf"].notna() & ~t["iso3"].isin(K.EXCLUDE)]
    def one(x):
        w = x["fleet_twh"].fillna(0)
        r = (x["atlas_cf"] / x["newbuild_cf"] * w).sum() / w.sum()
        return 1.0 / r
    if not by_region:
        return one(s)
    s = s.assign(broad=s["iso3"].map(ISO_BROAD).fillna("other"))
    f = {b: one(x) for b, x in s.groupby("broad")}
    f["other"] = one(s)
    return f
