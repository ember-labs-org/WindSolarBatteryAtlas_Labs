"""Pick a representative good wind site inside every Voronoi cell.

The problem this solves: wind is local. A single reanalysis point at the centre
of a Belgium-sized cell is usually a mediocre site and would understate what a
developer would actually build. So instead of sampling the centre, we score
every ~2 km patch of eligible ground in the cell against the Global Wind Atlas
and take the region's best land as its wind resource.

Method, per cell and per surface (onshore, offshore):
  1. Restrict to eligible area (see build_eligibility.py).
  2. Onshore, choose the IEC turbine class per pixel from the GWA long-run mean
     wind speed at 100 m, then read that class's capacity factor. Offshore, use
     the GWA offshore layer (150 m hub).
  3. Net capacity factor = gross x (1 - losses); losses default to 12 per cent
     for wake, availability and electrical losses.
  4. The cell's headline resource is the area-weighted mean net capacity factor
     of its best 500 km2 of eligible area (all of it if the cell has less):
     pixels are ranked by net CF and the last one counted fractionally. That is
     a farm-scale good site (about 2.5 GW at 5 MW/km2) rather than the average
     patch of ground, and it is the target the hourly series is scaled to
     (column <tag>_cf_target, = <tag>_cf_best).
  5. The site coordinates are the arg-max of a 10 km focal mean of eligible
     capacity factor, so the chosen point sits inside a contiguous good area
     rather than on an isolated pixel.
  6. A cell is viable if it has any eligible area (land onshore, sea offshore):
     there is no capacity-factor floor and no minimum area (D-123; T054 used a
     15 per cent floor, D-113, and 20 per cent before that). Weak sites keep
     their real, low headline. Cells without eligible area get an all-zero
     wind profile downstream. Onshore and offshore follow the same rule.

  `--rule share --share X` (T061, D-133 candidate) takes instead the mean of
  the best X per cent of the cell's eligible area, with BEST_AREA_KM2 as the
  floor (all of it if the cell has less); the last pixel counts fractionally.
  It adds one column, share_of_land, at the end; the other rules write exactly
  what they wrote before.

  `--level-factors <csv>` (T061, D-134; columns location_id, on_level_factor,
  off_level_factor) multiplies each cell's level by a calibration factor
  against observed new-build CFs: <tag>_cf_target = <tag>_cf_best x factor.
  P50, P90, site CF, viability and potential stay on the unscaled net CF. The
  two factor columns are appended at the end; without the option nothing is
  written differently.

  Until T054 (Oct 2026) the headline was the area-weighted P90 and a cell also
  needed 200 km2 clearing 20 per cent; `--rule p90` reproduces that rule (and
  the data shipped before T054) exactly, whatever --viable-cf/--area-cf say.
  P50 and P90 are still written as diagnostics. <tag>_viable_area_km2 and
  <tag>_room_gw (potential) count the eligible area clearing AREA_CF_THRESHOLD
  (15 per cent, D-114 / D-123; 20 per cent under --rule p90).

Onshore zones are the published land-clipped Voronoi cells, so the numbers match
the polygons the atlas draws. Offshore zones are the sea assigned to the nearest
simulation point, which is the same planar-degree Voronoi rule the atlas already
uses, extended over water.

Usage:
    cd workspace && python3 -m scripts.pipeline.wind.site_selection [--rule p90]
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio import features
from scipy import ndimage
from scipy.spatial import cKDTree

from scripts.pipeline.config import DOCS_DATA_DIR, INPUTS_DIR, OUTPUTS_DIR
from scripts.pipeline.wind import gwa_sources as G

WIND_INPUTS = INPUTS_DIR / "wind"
CELLS_GEOJSON = OUTPUTS_DIR / "voronoi_cells.geojson"
POINTS_CSV = OUTPUTS_DIR / "voronoi_points.csv"

DEFAULT_LOSSES = 0.12
CF_THRESHOLD = 0.20            # old rule (--rule p90): viability floor and area line
VIABLE_CF_THRESHOLD = 0.0      # best-area rule: viability floor on the best-500 km2 mean;
                               # none since D-123 (was 0.15, D-113)
AREA_CF_THRESHOLD = 0.15       # best-area rule: area line for <tag>_viable_area_km2 /
                               # room_gw, i.e. potential (D-114, kept by D-123)
MIN_VIABLE_AREA_KM2 = 200.0    # old rule only (--rule p90)
BEST_AREA_KM2 = 500.0          # headline = mean net CF of the best 500 km2 (D-111)
FOCAL_KM = 10.0                # site is the centre of the best ~10 km patch
ONSHORE_MW_PER_KM2 = 5.0
OFFSHORE_MW_PER_KM2 = 4.0
EARTH_R_M = 6371007.181


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _read_u16(name: str) -> np.ndarray:
    with rasterio.open(WIND_INPUTS / name) as src:
        a = src.read(1)
    return a


def _u16_to_float(a: np.ndarray, scale: int) -> np.ndarray:
    out = a.astype("float32") / scale
    out[a == G.NODATA_U16] = np.nan
    return out


def pixel_area_km2() -> np.ndarray:
    """Exact spherical area of one grid pixel, per row (km^2)."""
    lat_top = G.GRID_NORTH - np.arange(G.GRID_HEIGHT) * G.GRID_RES
    lat_bot = lat_top - G.GRID_RES
    dlon = np.deg2rad(G.GRID_RES)
    a = (EARTH_R_M**2) * dlon * (
        np.sin(np.deg2rad(lat_top)) - np.sin(np.deg2rad(lat_bot))
    )
    return (a / 1e6).astype("float32")


def weighted_quantiles_by_zone(
    zone: np.ndarray, value: np.ndarray, weight: np.ndarray, n_zones: int, qs=(0.5, 0.9)
) -> dict[float, np.ndarray]:
    """Area-weighted quantiles of `value` within each zone. zone is 0-based."""
    order = np.lexsort((value, zone))
    z, v = zone[order], value[order]
    # float64 throughout: a float32 running sum saturates once the cumulative
    # area passes ~1e8 km2, which silently truncates every later zone.
    w = weight[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    csum = np.cumsum(w)
    # cumulative weight at the start of each zone
    starts = np.zeros(n_zones + 1, dtype="float64")
    starts[1:] = np.cumsum(total.astype("float64"))
    base = starts[z]
    frac = np.divide(csum - base, total[z], out=np.zeros_like(csum), where=total[z] > 0)
    out: dict[float, np.ndarray] = {}
    for q in qs:
        res = np.full(n_zones, np.nan, dtype="float32")
        # first index in each zone whose cumulative fraction reaches q
        hit = frac >= q
        idx = np.where(hit)[0]
        if idx.size:
            zz = z[idx]
            # keep the first occurrence per zone
            first = np.ones(idx.size, dtype=bool)
            first[1:] = zz[1:] != zz[:-1]
            res[zz[first]] = v[idx[first]]
        out[q] = res
    return out


def best_area_mean_by_zone(
    zone: np.ndarray, value: np.ndarray, weight: np.ndarray, n_zones: int, area_km2: float
) -> np.ndarray:
    """Weighted mean of `value` over the best `area_km2` of weight in each zone.

    Pixels are ranked by value, highest first; the pixel that crosses area_km2
    counts only for the part that fits. A zone with less weight than area_km2
    uses all of it. NaN where a zone has no weight.
    """
    order = np.lexsort((-value, zone))
    z, v = zone[order], value[order].astype("float64")
    w = weight[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    starts = np.zeros(n_zones + 1, dtype="float64")
    starts[1:] = np.cumsum(total)
    above = np.cumsum(w) - w - starts[z]          # weight ranked above this pixel
    take = np.clip(area_km2 - above, 0.0, w)
    num = np.bincount(z, weights=take * v, minlength=n_zones)
    den = np.bincount(z, weights=take, minlength=n_zones)
    return np.divide(num, den, out=np.full(n_zones, np.nan), where=den > 0)


def share_mean_by_zone(
    zone: np.ndarray, value: np.ndarray, weight: np.ndarray, n_zones: int,
    share: float, floor_km2: float
) -> np.ndarray:
    """Weighted mean of `value` over the best max(share x zone weight, floor_km2)
    of weight in each zone (T061). share = 0 is best_area_mean_by_zone(floor_km2).
    """
    order = np.lexsort((-value, zone))
    z, v = zone[order], value[order].astype("float64")
    w = weight[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    starts = np.zeros(n_zones + 1, dtype="float64")
    starts[1:] = np.cumsum(total)
    above = np.cumsum(w) - w - starts[z]
    target = np.maximum(share * total, floor_km2)[z]
    take = np.clip(target - above, 0.0, w)
    num = np.bincount(z, weights=take * v, minlength=n_zones)
    den = np.bincount(z, weights=take, minlength=n_zones)
    return np.divide(num, den, out=np.full(n_zones, np.nan), where=den > 0)


def argmax_by_zone(zone: np.ndarray, value: np.ndarray, n_zones: int) -> np.ndarray:
    """Index (into the flat arrays) of the largest value in each zone, or -1."""
    order = np.lexsort((value, zone))
    z = zone[order]
    last = np.ones(z.size, dtype=bool)
    last[:-1] = z[:-1] != z[1:]
    res = np.full(n_zones, -1, dtype="int64")
    res[z[last]] = order[last]
    return res


def focal_mean_masked(value: np.ndarray, weight: np.ndarray, size: int) -> np.ndarray:
    """Mean of `value` over a size x size window, counting only weighted pixels."""
    v = np.where(np.isfinite(value), value, 0.0).astype("float32") * weight
    num = ndimage.uniform_filter(v, size=size, mode="nearest")
    den = ndimage.uniform_filter(weight.astype("float32"), size=size, mode="nearest")
    return np.divide(num, den, out=np.full_like(num, np.nan), where=den > 1e-6)


def share_take_by_zone(
    zone: np.ndarray, value: np.ndarray, weight: np.ndarray, n_zones: int,
    share: float, floor_km2: float
) -> np.ndarray:
    """The weight each pixel contributes to share_mean_by_zone (same ranking), in input order."""
    order = np.lexsort((-value, zone))
    z = zone[order]
    w = weight[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    starts = np.zeros(n_zones + 1, dtype="float64")
    starts[1:] = np.cumsum(total)
    above = np.cumsum(w) - w - starts[z]
    target = np.maximum(share * total, floor_km2)[z]
    take = np.empty_like(w)
    take[order] = np.clip(target - above, 0.0, w)
    return take


# ---------------------------------------------------------------------------
# T081: IEC class by 50-year wind, market turbines, hub height (turbines.py)
# ---------------------------------------------------------------------------
V_MIX = np.arange(0.0, 45.0 + 1e-9, 0.1)     # speed grid of the stored mixture CDFs


def _t081_onshore(zone_on, speed, density, loc_ids, class_rule, market, countries_csv):
    from scripts.pipeline.wind import turbines as T
    from scripts.pipeline.wind.power_curves import CURVES

    n = len(loc_ids)
    A100 = _u16_to_float(_read_u16("gwa4_weib_A_100m_002deg.tif"), 100)
    A150 = _u16_to_float(_read_u16("gwa4_weib_A_150m_002deg.tif"), 100)
    k100 = _u16_to_float(_read_u16("gwa4_weib_k_100m_002deg.tif"), 1000)
    k150 = _u16_to_float(_read_u16("gwa4_weib_k_150m_002deg.tif"), 1000)
    region = {"on_market": np.full(n, "", dtype=object), "on_rated_kw": np.full(n, np.nan),
              "on_rotor_m": np.full(n, np.nan), "on_hub_m": np.full(n, 100.0)}
    hub = np.full(zone_on.shape, 100.0, dtype="float32")
    mk = None
    if market is not None:
        mk = T.load_market(market)
        oc = pd.read_csv(countries_csv).set_index("location_id")["country_iso3"]
        iso = oc.reindex(loc_ids).to_numpy()
        for c, row in mk.iterrows():
            sel = iso == c
            region["on_market"][sel] = c
            region["on_rated_kw"][sel] = row.rated_kw
            region["on_rotor_m"][sel] = row.rotor_m
            region["on_hub_m"][sel] = row.hub_m
        hub_of_zone = np.concatenate([[100.0], region["on_hub_m"]]).astype("float32")
        hub = hub_of_zone[zone_on]
    # 50-year wind at hub height and the IEC class it calls for
    if class_rule == "v50":
        v100 = _u16_to_float(_read_u16("gasp_v50_100m_002deg.tif"), 100)
        v150 = _u16_to_float(_read_u16("gasp_v50_150m_002deg.tif"), 100)
        v50 = np.where(hub == 100.0, v100, T.interp_height(v100, v150, hub, "power")).astype("float32")
        del v100, v150
        iec = T.class_from_v50(v50)
    else:
        v50 = np.full(zone_on.shape, np.nan, dtype="float32")
        iec = np.zeros(zone_on.shape, dtype="uint8")
    b1, b2 = G.IEC_SPEED_BREAKS
    old = np.where(speed <= b1, 3, np.where(speed <= b2, 2, 1)).astype("uint8")
    iec = np.where(iec == 0, old, iec).astype("uint8")
    cf = np.full(speed.shape, np.nan, dtype="float32")
    for cls in (1, 2, 3):
        band = _u16_to_float(_read_u16(f"gwa4_{G.IEC_CLASSES[cls]['layer']}_002deg.tif"), 10000)
        sel = (iec == cls) & np.isfinite(band) & np.isfinite(speed)
        cf[sel] = band[sel]
        del band
    iec[~np.isfinite(cf)] = 0
    print(f"  T081 classes ({class_rule}): " + ", ".join(
        f"{c}: {int(((iec == c) & (zone_on > 0)).sum())}" for c in (1, 2, 3)) +
        f" onshore pixels (mean-speed rule: " + ", ".join(
        f"{c}: {int(((old == c) & (zone_on > 0) & np.isfinite(cf)).sum())}" for c in (1, 2, 3)) + ")", flush=True)
    A_hub = np.where(hub == 100.0, A100, T.interp_height(A100, A150, hub, "power")).astype("float32")
    k_hub = np.where(hub == 100.0, k100, T.interp_height(k100, k150, hub, "log")).astype("float32")
    del A150, k150
    if mk is not None:
        # market turbine: CF ratio, both Weibull-integrated through the atlas's curves
        refs = {c: T.WeibullCF(CURVES[c]) for c in (1, 2, 3)}
        for c, row in mk.iterrows():
            zs = np.nonzero(region["on_market"] == c)[0] + 1
            sel = np.isin(zone_on, zs) & np.isfinite(cf) & np.isfinite(A_hub) & np.isfinite(k_hub) \
                & np.isfinite(A100) & np.isfinite(k100)
            wm = T.WeibullCF(T.market_curve(row))
            num = wm(A_hub[sel], k_hub[sel], density[sel])
            den = np.zeros_like(num)
            ic = iec[sel]
            for cls, w in refs.items():
                q = ic == cls
                den[q] = w(A100[sel][q], k100[sel][q], density[sel][q])
            ratio = np.where(den > 1e-6, num / np.maximum(den, 1e-6), 1.0)
            cf[sel] = np.clip(cf[sel] * ratio, 0.0, 1.0).astype("float32")
            print(f"  T081 market {c}: {sel.sum()} pixels, CF ratio median {np.median(ratio):.3f} "
                  f"(p10 {np.quantile(ratio, .1):.3f}, p90 {np.quantile(ratio, .9):.3f})", flush=True)
    return {"cf": cf, "iec": iec, "A_hub": A_hub, "k_hub": k_hub, "v50_hub": v50, "region": region}


def _kept_sites(path, loc_ids, tag):
    k = pd.read_csv(path).set_index("location_id").reindex(loc_ids)
    lat, lon = k[f"{tag}_site_lat"].to_numpy(), k[f"{tag}_site_lon"].to_numpy()
    ok = np.isfinite(lat) & np.isfinite(lon)
    r = np.round((G.GRID_NORTH - np.where(ok, lat, 0)) / G.GRID_RES - 0.5).astype("int64")
    c = np.round((np.where(ok, lon, 0) - G.GRID_WEST) / G.GRID_RES - 0.5).astype("int64")
    return np.where(ok, r * G.GRID_WIDTH + c, -1)


def _write_mixture(path, zi, take, A, k, n_pts, loc_ids):
    """Per region: the take-weighted mixture of the selected pixels' Weibull CDFs on V_MIX."""
    sel = (take > 0) & np.isfinite(A) & np.isfinite(k) & (A > 0) & (k > 0)
    z, w, a, kk = zi[sel], take[sel], A[sel].astype("float64"), k[sel].astype("float64")
    den = np.bincount(z, weights=w, minlength=n_pts)
    cdf = np.zeros((n_pts, V_MIX.size), dtype="float64")
    for j, v in enumerate(V_MIX):
        if v > 0:
            cdf[:, j] = np.bincount(z, weights=w * (1.0 - np.exp(-np.power(v / a, kk))), minlength=n_pts)
    cdf = np.divide(cdf, den[:, None], out=np.full_like(cdf, np.nan), where=den[:, None] > 0)
    cover = np.divide(den, np.bincount(zi, weights=take, minlength=n_pts),
                      out=np.zeros(n_pts), where=den > 0)
    np.savez_compressed(path, location_id=loc_ids, v=V_MIX, cdf=cdf.astype("float32"), weight_km2=den,
                        covered=cover)
    print(f"  mixture CDFs for {(den > 0).sum()} regions -> {path}", flush=True)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def run(losses: float, out_csv: Path, rule: str = "best-area",
        best_area_km2: float = BEST_AREA_KM2,
        viable_cf: float = VIABLE_CF_THRESHOLD,
        area_cf_line: float = AREA_CF_THRESHOLD,
        share: float | None = None,
        level_factors: Path | None = None,
        class_rule: str = "speed",
        market: Path | None = None,
        countries_csv: Path | None = None,
        keep_sites: Path | None = None,
        mixture_out: Path | None = None) -> pd.DataFrame:
    if rule == "best500":
        rule = "best-area"
    if rule == "share" and share is None:
        raise SystemExit("--rule share needs --share (per cent of eligible area)")
    t0 = time.time()
    points = pd.read_csv(POINTS_CSV)
    n_pts = len(points)
    loc_ids = points["location_id"].to_numpy()
    id_to_idx = {int(v): i for i, v in enumerate(loc_ids)}
    print(f"{n_pts} simulation points")

    print("Loading GWA layers ...")
    speed = _u16_to_float(_read_u16("gwa4_wind_speed_100m_002deg.tif"), 100)
    cf = np.full_like(speed, np.nan)
    iec = np.zeros(speed.shape, dtype="uint8")
    b1, b2 = G.IEC_SPEED_BREAKS
    for cls, lo, hi in ((3, -np.inf, b1), (2, b1, b2), (1, b2, np.inf)):
        layer = G.IEC_CLASSES[cls]["layer"]
        band = _u16_to_float(_read_u16(f"gwa4_{layer}_002deg.tif"), 10000)
        sel = (speed > lo) & (speed <= hi) & np.isfinite(band)
        cf[sel] = band[sel]
        iec[sel] = cls
        del band
    density = _u16_to_float(_read_u16("gwa4_air_density_100m_002deg.tif"), 1000)
    cf_off = _u16_to_float(_read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    with rasterio.open(WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        elig_on = s.read(1).astype("float32") / 100.0
    with rasterio.open(WIND_INPUTS / "eligible_offshore_002deg.tif") as s:
        elig_off = s.read(1).astype("float32") / 100.0
    with rasterio.open(WIND_INPUTS / "floating_offshore_002deg.tif") as s:
        elig_float = s.read(1).astype("float32") / 100.0
    print(f"  loaded in {time.time()-t0:.0f}s")

    area = pixel_area_km2()[:, None]
    keep = 1.0 - losses

    # ---------------- zones ----------------
    print("Rasterising onshore Voronoi cells ...")
    import json

    with open(CELLS_GEOJSON) as fh:
        gj = json.load(fh)
    shapes = []
    for feat in gj["features"]:
        lid = int(feat["properties"]["location_id"])
        if lid in id_to_idx:
            shapes.append((feat["geometry"], id_to_idx[lid] + 1))
    zone_on = features.rasterize(
        shapes,
        out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
        transform=G.grid_transform(),
        fill=0,
        dtype="int32",
        all_touched=False,
    )
    print(f"  {len(shapes)} cells rasterised, {100*(zone_on>0).mean():.1f}% of grid")

    print("Assigning offshore sea to the nearest simulation point ...")
    zone_off = np.zeros_like(zone_on)
    sea = elig_off > 0
    rows, cols = np.nonzero(sea)
    if rows.size:
        lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
        lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
        tree = cKDTree(points[["longitude", "latitude"]].to_numpy())
        _, nn = tree.query(np.column_stack([lon, lat]), k=1, workers=-1)
        zone_off[rows, cols] = nn + 1
    print(f"  {rows.size/1e6:.1f}M eligible sea pixels")

    t081 = None
    if class_rule == "v50" or market is not None or mixture_out is not None:
        t081 = _t081_onshore(zone_on, speed, density, loc_ids, class_rule, market, countries_csv)
        cf, iec = t081["cf"], t081["iec"]

    # ---------------- focal means for site picking ----------------
    fsize = max(3, int(round(FOCAL_KM / (G.GRID_RES * 111.32))))
    print(f"Focal mean window {fsize} px (~{fsize*G.GRID_RES*111.32:.0f} km)")
    focal_on = focal_mean_masked(cf, np.where(zone_on > 0, elig_on, 0.0), fsize)
    focal_off = focal_mean_masked(cf_off, np.where(zone_off > 0, elig_off, 0.0), fsize)

    lat_row = (G.GRID_NORTH - (np.arange(G.GRID_HEIGHT) + 0.5) * G.GRID_RES).astype("float32")
    lon_col = (G.GRID_WEST + (np.arange(G.GRID_WIDTH) + 0.5) * G.GRID_RES).astype("float32")

    out = pd.DataFrame({
        "location_id": loc_ids,
        "latitude": points["latitude"].to_numpy(),
        "longitude": points["longitude"].to_numpy(),
    })

    factors = None
    if level_factors is not None:
        lf = pd.read_csv(level_factors).set_index("location_id").reindex(loc_ids)
        if lf[["on_level_factor", "off_level_factor"]].isna().any().any():
            raise SystemExit(f"{level_factors}: a level factor is missing for some location_id")
        factors = {t: lf[f"{t}_level_factor"].to_numpy("float64") for t in ("on", "off")}

    extra: dict[str, np.ndarray] = {}
    for tag, zone, cf_layer, elig, focal, mw_km2 in (
        ("on", zone_on, cf, elig_on, focal_on, ONSHORE_MW_PER_KM2),
        ("off", zone_off, cf_off, elig_off, focal_off, OFFSHORE_MW_PER_KM2),
    ):
        print(f"Zonal statistics [{tag}] ...")
        m = (zone > 0) & (elig > 0) & np.isfinite(cf_layer)
        zi = (zone[m] - 1).astype("int64")
        cfv = (cf_layer[m] * keep).astype("float32")          # net capacity factor
        wgt = (elig[m] * np.broadcast_to(area, zone.shape)[m]).astype("float32")

        tot_area = np.bincount(zi, weights=wgt, minlength=n_pts)
        # area line: what counts as good land for potential (room_gw) and, in
        # the old rule, for the 200 km2 test
        area_cf = CF_THRESHOLD if rule == "p90" else area_cf_line
        good = cfv >= area_cf
        good_area = np.bincount(zi[good], weights=wgt[good], minlength=n_pts)
        qs = weighted_quantiles_by_zone(zi, cfv, wgt, n_pts, qs=(0.5, 0.9))
        best = best_area_mean_by_zone(zi, cfv, wgt, n_pts, best_area_km2)
        if rule == "share":
            best = share_mean_by_zone(zi, cfv, wgt, n_pts, share / 100.0, best_area_km2)
        if tag == "on" and mixture_out is not None:
            if rule != "share" or t081 is None:
                raise SystemExit("--mixture-out needs --rule share and the T081 options")
            take = share_take_by_zone(zi, cfv, wgt, n_pts, share / 100.0, best_area_km2)
            _write_mixture(mixture_out, zi, take, t081["A_hub"][m], t081["k_hub"][m], n_pts, loc_ids)

        # site = arg-max of the focal mean, restricted to eligible in-zone pixels
        fm = np.where(m, focal, np.nan)
        fmv = fm[m]
        valid = np.isfinite(fmv)
        site_flat = np.full(n_pts, -1, dtype="int64")
        if valid.any():
            idx_map = np.nonzero(m.ravel())[0]
            sub = argmax_by_zone(zi[valid], fmv[valid], n_pts)
            has = sub >= 0
            site_flat[has] = idx_map[np.nonzero(valid)[0][sub[has]]]

        if keep_sites is not None:
            site_flat = _kept_sites(keep_sites, loc_ids, tag)
            if (site_flat >= 0).sum() != (tot_area > 0).sum() or (~m.ravel()[site_flat[site_flat >= 0]]).any():
                raise SystemExit(f"--keep-sites: {tag} sites do not match the eligible in-zone pixels")
        srow = np.where(site_flat >= 0, site_flat // G.GRID_WIDTH, -1)
        scol = np.where(site_flat >= 0, site_flat % G.GRID_WIDTH, -1)
        site_lat = np.where(srow >= 0, lat_row[np.clip(srow, 0, None)], np.nan)
        site_lon = np.where(scol >= 0, lon_col[np.clip(scol, 0, None)], np.nan)
        flat_cf = (cf_layer * keep).ravel()
        site_cf = np.where(site_flat >= 0, flat_cf[np.clip(site_flat, 0, None)], np.nan)

        out[f"{tag}_area_km2"] = tot_area
        out[f"{tag}_viable_area_km2"] = good_area
        out[f"{tag}_cf_p50"] = qs[0.5]
        out[f"{tag}_cf_p90"] = qs[0.9]
        out[f"{tag}_site_lat"] = site_lat
        out[f"{tag}_site_lon"] = site_lon
        out[f"{tag}_site_cf"] = site_cf
        out[f"{tag}_room_gw"] = good_area * mw_km2 / 1000.0
        if rule == "p90":
            target = qs[0.9]
            viable = (qs[0.9] >= CF_THRESHOLD) & (good_area >= MIN_VIABLE_AREA_KM2)
        else:
            target = best
            # with no floor (viable_cf = 0) any eligible area makes a cell viable
            viable = (tot_area > 0) & (best >= viable_cf)
        out[f"{tag}_viable"] = viable.astype("int8")
        if factors is not None and rule != "p90":
            target = best * factors[tag]
        extra[f"{tag}_cf_best"] = best
        extra[f"{tag}_cf_target"] = target

        if tag == "on":
            site_flat_on = site_flat
            flat_speed, flat_dens, flat_iec = speed.ravel(), density.ravel(), iec.ravel()
            sf = np.clip(site_flat, 0, None)
            out["on_site_speed_100m"] = np.where(site_flat >= 0, flat_speed[sf], np.nan)
            out["on_site_air_density"] = np.where(site_flat >= 0, flat_dens[sf], np.nan)
            out["on_site_iec_class"] = np.where(site_flat >= 0, flat_iec[sf], 0).astype("int8")

    # floating potential, reported only
    print("Floating potential area ...")
    mfl = (zone_off > 0) & (elig_float > 0)
    # floating pixels are outside the fixed-bottom zone raster, so assign again
    rows, cols = np.nonzero(elig_float > 0)
    fl_area = np.zeros(n_pts)
    if rows.size:
        lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
        lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
        tree = cKDTree(points[["longitude", "latitude"]].to_numpy())
        _, nn = tree.query(np.column_stack([lon, lat]), k=1, workers=-1)
        w = np.broadcast_to(area, elig_float.shape)[rows, cols] * elig_float[rows, cols]
        fl_area = np.bincount(nn, weights=w, minlength=n_pts)
    out["off_floating_area_km2"] = fl_area

    # centre-of-cell capacity factor, for the "why not just take the centre" chart
    ci = np.clip(((G.GRID_NORTH - out["latitude"].to_numpy()) / G.GRID_RES).astype(int), 0, G.GRID_HEIGHT - 1)
    cj = np.clip(((out["longitude"].to_numpy() - G.GRID_WEST) / G.GRID_RES).astype(int), 0, G.GRID_WIDTH - 1)
    out["centre_cf"] = (cf[ci, cj] * keep).astype("float32")

    out["losses_applied"] = losses
    # T054 columns go after the pre-T054 ones so their order is unchanged
    for k, v in extra.items():
        out[k] = v
    out["best_area_km2"] = best_area_km2
    out["viability_rule"] = rule
    out["viable_cf_threshold"] = CF_THRESHOLD if rule == "p90" else viable_cf
    out["area_cf_threshold"] = CF_THRESHOLD if rule == "p90" else area_cf_line
    if rule == "share":
        out["share_of_land"] = share / 100.0
    if factors is not None and rule != "p90":
        out["on_level_factor"] = factors["on"]
        out["off_level_factor"] = factors["off"]
    if t081 is not None and (class_rule == "v50" or market is not None):
        sf = np.clip(site_flat_on, 0, None)
        out["on_class_rule"] = class_rule
        out["on_site_v50"] = np.where(site_flat_on >= 0, t081["v50_hub"].ravel()[sf], np.nan)
        for c in ("on_market", "on_rated_kw", "on_rotor_m", "on_hub_m"):
            out[c] = t081["region"][c]
    out.to_csv(out_csv, index=False, float_format="%.6f")
    docs = DOCS_DATA_DIR / out_csv.name
    out.to_csv(docs, index=False, float_format="%.6f")
    print(f"wrote {out_csv} and {docs}  ({time.time()-t0:.0f}s total)")
    return out


def summarise(df: pd.DataFrame) -> None:
    n = len(df)
    on_v, off_v = df["on_viable"] == 1, df["off_viable"] == 1
    print("\n--- summary ---")
    print(f"onshore viable      {on_v.sum():5d} / {n}  ({100*on_v.mean():.1f}%)")
    print(f"offshore viable     {off_v.sum():5d} / {n}  ({100*off_v.mean():.1f}%)")
    print(f"either              {(on_v|off_v).sum():5d} ({100*(on_v|off_v).mean():.1f}%)")
    print(f"neither             {(~on_v&~off_v).sum():5d} ({100*(~on_v&~off_v).mean():.1f}%)")
    v = df.loc[on_v]
    print(f"\nonshore headline net CF ({df['viability_rule'].iat[0]}): median {v['on_cf_target'].median():.3f} "
          f"p10 {v['on_cf_target'].quantile(.1):.3f} p90 {v['on_cf_target'].quantile(.9):.3f}")
    gap = (v["on_cf_target"] - v["centre_cf"]).dropna()
    print(f"good-site minus cell-centre CF: median {gap.median():+.3f} "
          f"(centre understates by {100*gap.median():.1f} points)")
    print(f"share of viable cells where the centre would fail the 20% test: "
          f"{100*(v['centre_cf'] < 0.20).mean():.1f}%")
    o = df.loc[off_v]
    if len(o):
        print(f"\noffshore headline net CF: median {o['off_cf_target'].median():.3f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--losses", type=float, default=DEFAULT_LOSSES)
    ap.add_argument("--out", type=Path, default=OUTPUTS_DIR / "voronoi_wind_resource.csv")
    ap.add_argument("--rule", choices=("best-area", "best500", "p90", "share"), default="best-area",
                    help="best-area (= best500; default, T054), p90 (the rule before T054) "
                         "or share (best --share per cent of eligible area, floor --best-area-km2; T061)")
    ap.add_argument("--level-factors", type=Path, default=None,
                    help="CSV location_id, on_level_factor, off_level_factor (T061): cf_target = cf_best x factor")
    ap.add_argument("--share", type=float, default=None,
                    help="share rule only: per cent of each cell's eligible area to average")
    ap.add_argument("--best-area-km2", type=float, default=BEST_AREA_KM2)
    ap.add_argument("--viable-cf", type=float, default=VIABLE_CF_THRESHOLD,
                    help="best-area rule only: viability floor on the best-area mean net CF (0 = none)")
    ap.add_argument("--area-cf", type=float, default=AREA_CF_THRESHOLD,
                    help="best-area rule only: CF line for viable_area_km2 / room_gw (potential)")
    ap.add_argument("--class-rule", choices=("speed", "v50"), default="speed",
                    help="T081: IEC class by GWA mean speed (default) or by GASP 50-year wind (IEC 61400-1 Vref)")
    ap.add_argument("--market", type=Path, default=None,
                    help="T081: market turbines CSV (wind/data/market_turbines.csv); needs --countries")
    ap.add_argument("--countries", type=Path, default=None,
                    help="T081: voronoi_overlapping_countries.csv giving each region's country")
    ap.add_argument("--keep-sites", type=Path, default=None,
                    help="T081: resource CSV whose on/off site coordinates are kept (no ERA5 refetch)")
    ap.add_argument("--mixture-out", type=Path, default=None,
                    help="T081: write the onshore Weibull mixture CDF of each region's selected land (npz)")
    args = ap.parse_args()
    df = run(args.losses, args.out, args.rule, args.best_area_km2, args.viable_cf, args.area_cf,
             args.share, args.level_factors, args.class_rule, args.market, args.countries,
             args.keep_sites, args.mixture_out)
    summarise(df)


if __name__ == "__main__":
    main()
