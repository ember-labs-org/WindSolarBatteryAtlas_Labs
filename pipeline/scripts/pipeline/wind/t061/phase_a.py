"""Phase A: baseline calibration table on the shipped data."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C
from . import plants as P

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calibration as K  # noqa: E402


def region_frame(resource_csv: Path, points: pd.DataFrame) -> pd.DataFrame:
    d = pd.read_csv(resource_csv).set_index("location_id")
    return d.reindex(points["location_id"]).reset_index()


def main_country(points: pd.DataFrame, S) -> pd.Series:
    oc = pd.read_csv(S.OUTPUTS_DIR / "voronoi_overlapping_countries.csv").set_index("location_id")
    return oc.reindex(points["location_id"])["country_iso3"].reset_index(drop=True)


def run(resource_csv: Path, out_dir: Path, label: str = "baseline") -> pd.DataFrame:
    S, G = C.import_siting()
    pts = pd.read_csv(S.POINTS_CSV)
    r = region_frame(resource_csv, pts)
    plants = P.build()
    vals = {}
    for tag in ("on", "off"):
        vals[(tag, "atlas_cf")] = r[f"{tag}_cf_target"].to_numpy(float)
        vals[(tag, "median_cf")] = r[f"{tag}_cf_p50"].to_numpy(float)
        vals[(tag, "p90_cf")] = r[f"{tag}_cf_p90"].to_numpy(float)
        # what the app simulates (the profile's annual mean; below the level where k = 1.8 binds)
        if f"{tag}_final_cf" in r.columns:
            vals[(tag, "sim_cf")] = r[f"{tag}_final_cf"].to_numpy(float)
    areas = {t: r[f"{t}_area_km2"].fillna(0).to_numpy(float) for t in ("on", "off")}
    ctry = K.country_atlas(plants, vals, areas, main_country(pts, S))
    t = K.build_table(ctry, K.load_observed())
    out_dir = C.guard_write(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t.to_csv(out_dir / f"calibration_{label}.csv", index=False, float_format="%.4f")
    return t


def report(t: pd.DataFrame, label: str) -> str:
    L = [f"# Calibration benchmark – {label}", ""]
    for tag in ("on", "off"):
        s = t[t["surface"] == tag]
        L.append(f"## {'Onshore' if tag == 'on' else 'Offshore'}")
        for col in ("atlas_cf", "sim_cf", "median_cf", "plant_cf", "plant_cf_new"):
            if col not in s.columns:
                continue
            for ref in ("newbuild_cf", "fleet_cf"):
                if col == "plant_cf_new" and ref == "fleet_cf":
                    continue
                m = K.metrics(s, col, ref)
                L.append(f"- {col} / {ref}: n = {m['n']}, generation-weighted ratio {m['gen_weighted_ratio']:.3f}, "
                         f"median {m['median_ratio']:.3f}, within ±10%: {100*m['share_within_10pct']:.0f}%")
        L.append("")
        L.append("| Country | Fleet CF 2022–24 (source) | New-build CF (IRENA, years) | Atlas CF (headline, cf_target) | Simulated CF | Median eligible | GWA at existing farms | at farms ≥ 2020 | Atlas ÷ new-build | Simulated ÷ new-build | Atlas ÷ fleet | Weighting |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for _, x in s.iterrows():
            f = lambda v: "–" if pd.isna(v) else f"{100*v:.1f}%"
            q = lambda a, b: "–" if pd.isna(a) or pd.isna(b) else f"{a/b:.2f}"
            L.append(f"| {x.iso3} | {f(x.fleet_cf)} ({x.fleet_source if isinstance(x.fleet_source,str) else '–'}) | "
                     f"{f(x.newbuild_cf)} ({x.newbuild_years if isinstance(x.newbuild_years,str) else '–'}) | {f(x.atlas_cf)} | "
                     f"{f(getattr(x, 'sim_cf', np.nan))} | {f(x.median_cf)} | {f(x.plant_cf)} | {f(x.plant_cf_new)} | {q(x.atlas_cf,x.newbuild_cf)} | "
                     f"{q(getattr(x, 'sim_cf', np.nan),x.newbuild_cf)} | "
                     f"{q(x.atlas_cf,x.fleet_cf)} | {x.weighting if isinstance(x.weighting,str) else '–'} |")
        L.append("")
    return "\n".join(L)
