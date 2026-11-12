"""Turn ERA5 hourly wind speed into hourly capacity factors per Voronoi cell.

Three things happen here.

1. Air-density correction. Power scales with density, so the speed is adjusted
   by (rho/rho0)^(1/3) using the Global Wind Atlas air density at the site.
   This matters on high plateaus, where thin air costs real output.

2. Bias correction to the Global Wind Atlas. ERA5 at 0.25 degrees cannot see a
   ridge or a coastal jet, so its wind speed is systematically wrong at any
   specific site. We keep ERA5's *shape* through the year and take the *level*
   from the atlas: a single scalar multiplier k is found by bisection so that
   the 2024 annual mean capacity factor equals the cell's Global Wind Atlas
   target. This is the standard approach and the one the RESKit global
   validation uses; k is clamped to [0.6, 1.8] and clamped cells are flagged.

3. Clock alignment. This is easy to get wrong and would quietly ruin the
   dispatch model. The atlas's solar profiles are labelled timestamp_utc but are
   in fact in local solar time: their daily peak sits at ~11.5 in the labels at
   every longitude. ERA5 is genuinely UTC. So the wind series is shifted by
   round(longitude/15) hours onto the solar clock before it is written. Without
   this, wind and solar would be misaligned by up to twelve hours and every
   diurnal complementarity result would be wrong.

Non-viable cells (no eligible land or sea; see site_selection.py) are written as
all zeros, so wind simply adds nothing there. Since D-123 there is no CF floor,
so weak sites get their real, low profile.

Output: workspace/input_data/wind_profiles_on.parquet and
        workspace/input_data/wind_profiles_off.parquet
        columns location_id int32, hour_index int16, kwh_per_kw float32
plus diagnostic columns appended to voronoi_wind_resource.csv.

Usage:
    cd workspace && python3 -m scripts.pipeline.wind.build_wind_profiles
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from scripts.pipeline.config import DOCS_DATA_DIR, INPUTS_DIR, OUTPUTS_DIR
from scripts.pipeline.wind.power_curves import CURVES

WIND_OUT = OUTPUTS_DIR / "wind"
RESOURCE_CSV = OUTPUTS_DIR / "voronoi_wind_resource.csv"
N_HOURS = 8784
RHO0 = 1.225
K_MIN, K_MAX = 0.6, 1.8


def solve_k(speed: np.ndarray, curve, target_cf: float) -> tuple[float, bool]:
    """Scalar wind-speed multiplier that makes the annual mean CF hit target."""
    lo, hi = K_MIN, K_MAX
    if curve.output(speed * hi).mean() < target_cf:
        return hi, True
    if curve.output(speed * lo).mean() > target_cf:
        return lo, True
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if curve.output(speed * mid).mean() < target_cf:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi), False


def build_surface(
    tag: str,
    speeds: np.ndarray,      # [hours, n_points] ERA5 speed at the site, UTC
    df: pd.DataFrame,
    losses: float,
) -> tuple[np.ndarray, pd.DataFrame]:
    n = len(df)
    out = np.zeros((n, N_HOURS), dtype="float32")
    keep = 1.0 - losses
    diag = {c: np.full(n, np.nan) for c in ("k", "raw_cf", "final_cf")}
    diag["clamped"] = np.zeros(n, dtype="int8")

    viable = df[f"{tag}_viable"].to_numpy() == 1
    # the level site_selection chose (best-500 km2 mean since T054); files
    # written before T054 have only the P90
    tcol = f"{tag}_cf_target" if f"{tag}_cf_target" in df.columns else f"{tag}_cf_p90"
    target_net = df[tcol].to_numpy()
    dens = df["on_site_air_density"].to_numpy() if tag == "on" else np.full(n, RHO0)
    dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
    cls = df["on_site_iec_class"].to_numpy() if tag == "on" else None
    lons = df["longitude"].to_numpy()

    n_done = 0
    for i in range(n):
        if not viable[i] or not np.isfinite(target_net[i]) or target_net[i] <= 0:
            continue
        curve = CURVES[int(cls[i])] if tag == "on" and int(cls[i]) in CURVES else CURVES["offshore"]
        v = speeds[:, i].astype("float64")
        if not np.isfinite(v).all() or v.max() <= 0:
            continue
        # density correction, then bias correction to the atlas
        v = v * (dens[i] / RHO0) ** (1.0 / 3.0)
        target_gross = float(target_net[i]) / keep
        raw_cf = float(curve.output(v).mean())
        k, clamped = solve_k(v, curve, target_gross)
        cf_hourly = curve.output(v * k) * keep

        # UTC -> the solar profiles' local-solar clock
        shift = int(round(lons[i] / 15.0))
        out[i] = np.roll(cf_hourly, shift).astype("float32")

        diag["k"][i] = k
        diag["raw_cf"][i] = raw_cf * keep
        diag["final_cf"][i] = float(cf_hourly.mean())
        diag["clamped"][i] = int(clamped)
        n_done += 1
        if n_done % 500 == 0:
            print(f"    {tag}: {n_done} sites", flush=True)

    d = pd.DataFrame({f"{tag}_{k}": v for k, v in diag.items()})
    return out, d


def write_parquet(path: Path, loc_ids: np.ndarray, mat: np.ndarray) -> None:
    n, h = mat.shape
    tbl = pa.table({
        "location_id": pa.array(np.repeat(loc_ids.astype("int32"), h), type=pa.int32()),
        "hour_index": pa.array(np.tile(np.arange(h, dtype="int16"), n), type=pa.int16()),
        "kwh_per_kw": pa.array(mat.reshape(-1), type=pa.float32()),
    })
    pq.write_table(tbl, path, compression="zstd", compression_level=9, row_group_size=1_000_000)
    print(f"  wrote {path.name}  ({path.stat().st_size/1e6:.0f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--speeds", type=Path, default=WIND_OUT / "era5_speed_2024.npz")
    ap.add_argument("--losses", type=float, default=0.12)
    args = ap.parse_args()

    df = pd.read_csv(RESOURCE_CSV)
    z = np.load(args.speeds)
    assert (z["location_id"] == df["location_id"].to_numpy()).all(), "point order mismatch"
    print(f"ERA5 speeds: {z['on'].shape[0]} hours x {z['on'].shape[1]} points")

    results = {}
    for tag in ("on", "off"):
        print(f"Building {tag}shore profiles ...")
        mat, diag = build_surface(tag, z[tag], df, args.losses)
        results[tag] = mat
        for c in diag.columns:
            df[c] = diag[c].to_numpy()
        ok = np.isfinite(df[f"{tag}_final_cf"])
        print(f"  {ok.sum()} profiles; median final CF {df.loc[ok, f'{tag}_final_cf'].median():.3f}; "
              f"median k {df.loc[ok, f'{tag}_k'].median():.3f}; clamped {int(df[f'{tag}_clamped'].sum())}")

    write_parquet(INPUTS_DIR / "wind_profiles_on.parquet", df["location_id"].to_numpy(), results["on"])
    write_parquet(INPUTS_DIR / "wind_profiles_off.parquet", df["location_id"].to_numpy(), results["off"])

    df.to_csv(RESOURCE_CSV, index=False, float_format="%.6f")
    df.to_csv(DOCS_DATA_DIR / RESOURCE_CSV.name, index=False, float_format="%.6f")
    print(f"updated {RESOURCE_CSV.name} with k / raw_cf / final_cf diagnostics")


if __name__ == "__main__":
    main()
