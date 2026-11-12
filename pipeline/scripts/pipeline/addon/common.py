"""T058 add-on studies: shared loading, dispatch and cost code.

Everything here only reads the workspace and the repo's deployment/data; the
studies write to the directory given by T058_OUT (a scratch folder, never
under OneDrive).

* Dispatch is the pipeline's own kernel (simulation3d.simulate_config): battery
  90% round trip, starting empty, float32 generation. `simulate_soc` is a copy
  that takes the starting state of charge, used only for the warm-start
  (cyclic year) sensitivity; with soc0 = 0 it equals simulate_config exactly
  (checked by study_b_large_builds.py before it uses it).
* Cost is the app's LCOE engine (deployment/js/workers/lcoe-worker.js,
  computeLcoeMetrics / fillLocationLcoe) with the app's default parameters:
  Global capex and WACC, no backup, base year 2026, both wind surfaces
  (scripts/article/tools/model.js LCOE_PARAMS). check_cost_vs_js.mjs checks this
  Python copy against the worker's own functions.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "pipeline"))
os.environ.setdefault("NUMBA_CACHE_DIR", os.environ.get("T058_OUT", "/tmp") + "/numba")

from scripts.pipeline import simulation3d as S  # noqa: E402
from scripts.pipeline.config import N_HOURS, BATTERY_ROUND_TRIP_EFFICIENCY  # noqa: E402

DATA = Path(os.environ.get("T058_DATA") or REPO / "deployment" / "data")
WORKSPACE = Path(os.environ.get("ATLAS_WORKSPACE_DIR") or "")
OUT = Path(os.environ.get("T058_OUT") or "/tmp/T058")
OUT.mkdir(parents=True, exist_ok=True)
if OUT.resolve().is_relative_to((Path.home() / "Library" / "CloudStorage").resolve()):
    raise SystemExit("T058_OUT must not be under OneDrive")

try:
    from numba import njit, prange
except ImportError:  # pragma: no cover
    raise SystemExit("numba is required")


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def excluded_ids() -> set[int]:
    """Regions whose primary country is Antarctica or Greenland (T057, D-120)."""
    import pandas as pd
    oc = pd.read_csv(DATA / "voronoi_overlapping_countries.csv")
    return set(int(x) for x in oc.loc[oc.country_iso3.isin(["ATA", "GRL"]), "location_id"])


class _TenYearSolar:
    """Rows of the 2015-2024 solar series, read on demand (T068): each year's
    uint16 x 1e4 matrix, as float32 like _solar_matrix.npy, joined end to end."""

    def __init__(self, root: Path, years=range(2015, 2025)):
        self.paths = [root / ("solar_2024_u16.npy" if y == 2024 else f"solar/solar_{y}_u16.npy") for y in years]

    def __getitem__(self, rows):
        return np.concatenate([(np.load(p, mmap_mode="r")[rows] / 1e4).astype(np.float32) for p in self.paths], axis=1)


def load_solar():
    """The cached solar matrix run3d.py uses (location order = _solar_ids.npy). With
    T058_SOLAR_TENYEAR=<run dir>/work (T068: the app's data are the ten-year run), the
    2015-2024 series from that run instead, so a cyclic simulation repeats the decade."""
    ten = os.environ.get("T058_SOLAR_TENYEAR")
    if ten:
        return np.load(Path(ten) / "solar_ids.npy"), _TenYearSolar(Path(ten))
    d = WORKSPACE / "outputs" / "wind"
    ids = np.load(d / "_solar_ids.npy")
    mat = np.load(d / "_solar_matrix.npy", mmap_mode="r")
    return ids, mat


def load_wind(path: Path, ids: np.ndarray, want: np.ndarray | None = None):
    """Wind profile matrix in `ids` order (rows for `want` only, if given)."""
    import duckdb
    con = duckdb.connect()
    con.execute("SET threads=4")
    con.execute("SET memory_limit='1GB'")
    sel = ids if want is None else want
    con.register("w", __import__("pandas").DataFrame({"location_id": sel.astype("int32")}))
    tbl = con.execute(
        f"SELECT p.location_id, p.kwh_per_kw FROM '{path}' p JOIN w USING (location_id) "
        "ORDER BY p.location_id, p.hour_index").fetch_arrow_table()
    got = np.unique(tbl["location_id"].to_numpy())
    mat = tbl["kwh_per_kw"].to_numpy().astype("float32").reshape(len(got), N_HOURS)
    if not np.array_equal(got, np.sort(sel)):
        raise SystemExit(f"{path.name}: missing locations")
    return got, mat


def summary(name: str):
    import pyarrow.parquet as pq
    return pq.read_table(DATA / name).to_pandas()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
def efficiencies():
    return S.efficiencies()


def simulate(solar_m, wind_m, s_gw, w_gw, b_gwh):
    """Pipeline kernel; returns (cf float64, curtailed share float64)."""
    n = solar_m.shape[0]
    cf, curt, samp = S.make_buffers(n)
    ec, ed = efficiencies()
    S.simulate_config(np.ascontiguousarray(solar_m), np.ascontiguousarray(wind_m),
                      float(s_gw), float(w_gw), float(b_gwh), ec, ed, S.SEASON_STARTS, cf, curt, samp)
    return cf, curt


@njit(cache=True, parallel=True, fastmath=False)
def _simulate_soc(solar_m, wind_m, solar_gw, wind_gw, batt_gwh, ce, de, soc0, out_cf, out_curt, out_soc):
    # Same expressions as simulation3d.simulate_config, but starting from soc0[i]
    # and reporting the state of charge at the end of the year.
    n_loc = solar_m.shape[0]
    length = solar_m.shape[1]
    total_demand = length * 1.0
    for i in prange(n_loc):
        current_soc = soc0[i]
        total_unserved = 0.0
        total_curtailed = 0.0
        s32 = np.float32(solar_gw)
        w32 = np.float32(wind_gw)
        one = np.float32(1.0)
        gen_total = 0.0
        for idx in range(length):
            gen = solar_m[i, idx] * s32 + wind_m[i, idx] * w32
            gen_total += float(gen)
            nl = float(one - gen)
            unserved = 0.0
            curtailed = 0.0
            if nl > 0.0:
                max_deliverable = current_soc * de
                discharge = nl if nl < max_deliverable else max_deliverable
                if de > 0.0:
                    current_soc -= discharge / de
                if current_soc < 0.0 and current_soc > -1e-9:
                    current_soc = 0.0
                unserved = nl - discharge
            else:
                available_storage = batt_gwh - current_soc
                if available_storage < 0.0:
                    available_storage = 0.0
                max_charge_input = available_storage / ce if ce > 0.0 else 0.0
                excess = -nl
                charge = excess if excess < max_charge_input else max_charge_input
                current_soc += charge * ce
                if current_soc > batt_gwh and current_soc < batt_gwh + 1e-9:
                    current_soc = batt_gwh
                curtailed = excess - charge
            total_unserved += unserved
            total_curtailed += curtailed
        out_cf[i] = (total_demand - total_unserved) / total_demand
        out_curt[i] = total_curtailed / gen_total if gen_total > 0 else 0.0
        out_soc[i] = current_soc


@njit(cache=True, parallel=True, fastmath=False)
def _simulate_rows(solar_m, wind_m, row_loc, s_arr, w_arr, b_arr, ce, de, soc0, out_cf, out_soc):
    # One build per row (row_loc indexes the profile rows): lets bisection and
    # sampled checks step many (region, build) pairs at once. Same expressions
    # as simulation3d.simulate_config, starting from soc0[r] (0 = the pipeline's cold start).
    length = solar_m.shape[1]
    for r in prange(row_loc.shape[0]):
        i = row_loc[r]
        batt_gwh = b_arr[r]
        current_soc = soc0[r]
        total_unserved = 0.0
        s32 = np.float32(s_arr[r])
        w32 = np.float32(w_arr[r])
        one = np.float32(1.0)
        for idx in range(length):
            gen = solar_m[i, idx] * s32 + wind_m[i, idx] * w32
            nl = float(one - gen)
            if nl > 0.0:
                max_deliverable = current_soc * de
                discharge = nl if nl < max_deliverable else max_deliverable
                if de > 0.0:
                    current_soc -= discharge / de
                if current_soc < 0.0 and current_soc > -1e-9:
                    current_soc = 0.0
                total_unserved += nl - discharge
            else:
                available_storage = batt_gwh - current_soc
                if available_storage < 0.0:
                    available_storage = 0.0
                max_charge_input = available_storage / ce if ce > 0.0 else 0.0
                excess = -nl
                charge = excess if excess < max_charge_input else max_charge_input
                current_soc += charge * ce
                if current_soc > batt_gwh and current_soc < batt_gwh + 1e-9:
                    current_soc = batt_gwh
        out_cf[r] = (length - total_unserved) / length
        out_soc[r] = current_soc


def simulate_rows(solar_m, wind_m, row_loc, s_arr, w_arr, b_arr, cyclic=False, max_pass=50):
    """cyclic=True: repeat the year from the end-of-year charge until it settles."""
    n = len(row_loc)
    out = np.zeros(n)
    soc = np.zeros(n)
    end = np.zeros(n)
    ec, ed = efficiencies()
    args = (np.ascontiguousarray(solar_m), np.ascontiguousarray(wind_m),
            np.asarray(row_loc, dtype=np.int64), np.asarray(s_arr, dtype=np.float64),
            np.asarray(w_arr, dtype=np.float64), np.asarray(b_arr, dtype=np.float64), ec, ed)
    for _ in range(max_pass if cyclic else 1):
        _simulate_rows(*args, soc, out, end)
        if not cyclic or np.allclose(end, soc, rtol=0, atol=1e-6):
            break
        soc = end.copy()
    else:
        raise RuntimeError(f"cyclic year did not converge in {max_pass} passes")
    return out


def simulate_soc(solar_m, wind_m, s_gw, w_gw, b_gwh, soc0=None, cyclic=False, max_pass=50):
    """Kernel copy with a starting charge. cyclic=True iterates soc0 <- end-of-year
    charge until it stops changing (a year that repeats itself)."""
    n = solar_m.shape[0]
    solar_m = np.ascontiguousarray(solar_m)
    wind_m = np.ascontiguousarray(wind_m)
    soc = np.zeros(n) if soc0 is None else np.asarray(soc0, dtype=np.float64).copy()
    cf = np.zeros(n)
    curt = np.zeros(n)
    end = np.zeros(n)
    ec, ed = efficiencies()
    for _ in range(max_pass if cyclic else 1):
        _simulate_soc(solar_m, wind_m, float(s_gw), float(w_gw), float(b_gwh), ec, ed, soc, cf, curt, end)
        if not cyclic or np.allclose(end, soc, rtol=0, atol=1e-6):
            break
        soc = end.copy()
    else:
        raise RuntimeError(f"cyclic year did not converge in {max_pass} passes "
                           f"({int((~np.isclose(end, soc, atol=1e-6)).sum())} rows)")
    return cf, curt, end


# ---------------------------------------------------------------------------
# Cost: the app's default LCOE (lcoe-worker.js), vectorised
# ---------------------------------------------------------------------------
def crf(rate, years):
    if rate == 0:
        return 1 / years
    p = (1 + rate) ** years
    return rate * p / (p - 1)


def lgm(growth, rate, years):
    """levelizedGrowthMultiplier."""
    c = crf(rate, years)
    ratio = (1 + growth) / (1 + rate)
    if abs(ratio - 1) < 1e-12:
        pv = years / (1 + rate)
    else:
        pv = (1 / (1 + growth)) * ratio * (1 - ratio ** years) / (1 - ratio)
    return pv * c


class Cost:
    """App defaults (scripts/article/tools/model.js LCOE_PARAMS, base year 2026)."""
    wacc = 0.07
    ilr = 1.3
    solar_capex = 720.0
    battery_capex = 120.0
    wind_on_capex = 1085.0      # Math.round(WIND_GLOBAL_CAPEX.on[2024])
    wind_off_capex = 2931.0     # Math.round(WIND_GLOBAL_CAPEX.off[2024])

    def __init__(self):
        w = self.wacc
        won, woff = w + 0.0, w + 0.0092
        self.solar_per_kw = self.solar_capex / self.ilr
        self.s_ann = self.solar_per_kw * crf(w, 30) + self.solar_per_kw * 0.015      # $/kW/yr
        self.b_ann = self.battery_capex * crf(w, 20) + self.battery_capex * 0.02     # $/kWh/yr
        self.on_ann = self.wind_on_capex * crf(won, 25) + self.wind_on_capex * 0.025
        self.off_ann = self.wind_off_capex * crf(woff, 25) + self.wind_off_capex * 0.035
        self.deg_s = lgm(-0.005, w, 30)
        self.deg_on = lgm(-0.002, won, 25)
        self.deg_off = lgm(-0.002, woff, 25)

    def lcoe(self, cf, solar, batt, w_on=0.0, w_off=0.0, ucf_s=np.nan, ucf_on=np.nan, ucf_off=np.nan):
        """$/MWh. Annual cost terms are summed in the worker's order only to
        ~1e-15 relative; studies compare builds, not tie-breaks.
        Degradation: energy-weighted blend over the sources present (the
        worker's blendedDegradation, extended to three sources for combinations;
        with one wind surface it is the worker's formula)."""
        cf = np.asarray(cf, dtype=np.float64)
        cost = (self.s_ann * solar + self.b_ann * batt + self.on_ann * w_on + self.off_ann * w_off) * 1e6
        if np.any(np.asarray(w_on) > 0) or np.any(np.asarray(w_off) > 0):
            es = solar * ucf_s
            eon = w_on * ucf_on
            eoff = w_off * ucf_off
            tot = es + eon + eoff
            # capacity shares stand in where unit CFs are unknown (worker rule)
            bad = np.logical_not(np.asarray(tot) > 0)   # not ~: tot may be a Python float
            es = np.where(bad, solar, es); eon = np.where(bad, w_on, eon); eoff = np.where(bad, w_off, eoff)
            tot = es + eon + eoff
            deg = (es * self.deg_s + eon * self.deg_on + eoff * self.deg_off) / tot
        else:
            deg = self.deg_s
        energy = cf * 8760 * 1000 * deg
        with np.errstate(divide="ignore", invalid="ignore"):
            out = np.where(cf > 0, cost / energy, np.nan)
        return out


def unit_cfs():
    """Per-location CF of 1 GW of solar / onshore / offshore alone (the worker's unitCfg)."""
    import pandas as pd
    s = summary("summary_w0.parquet")
    s = s[(s.solar_gw == 1) & (s.batt_gwh == 0)].set_index("location_id").annual_cf
    on = summary("summary_w1.parquet")
    on = on[(on.solar_gw == 0) & (on.batt_gwh == 0)].set_index("location_id").annual_cf
    off = summary("summary_wo1.parquet")
    off = off[(off.solar_gw == 0) & (off.batt_gwh == 0)].set_index("location_id").annual_cf
    return pd.DataFrame({"s": s, "on": on, "off": off})


# ---------------------------------------------------------------------------
# Full cost model: every mode the app prices in (Global / local WACC, local
# capex, timeline year, backup on), as the worker's precomputeLcoePerLocation
# and computeLcoeMetrics, extended to a build with BOTH wind surfaces.
# Operation order follows the worker, so single-surface results are bit-equal
# in practice (check_cost.py: <= 1e-12 relative, every mode).
# ---------------------------------------------------------------------------
DIESEL_KWH_PER_L = 10.0
DIESEL_FLOOR = 0.80
MMBTU_PER_MWH = 3.412


def _fin(x):
    return x is not None and isinstance(x, (int, float)) and np.isfinite(x)


def precompute(params, mult, local_wacc=None, local_capex=None, diesel=None, gas=None,
               wind_wacc=None, unit_cf=None):
    """precomputeLcoePerLocation. local_capex: {solar, battery, windOn, windOff, windOnOm,
    windOffOm}; wind_wacc: {on, off}; diesel: {rawPrice}; gas: {available, rawPrice}."""
    lc = local_capex or {}
    ww = wind_wacc or {}
    wacc = local_wacc if _fin(local_wacc) else params["wacc"]
    ilr = params["ilr"] if _fin(params.get("ilr")) and params["ilr"] > 0 else 1
    solar_base = lc["solar"] if _fin(lc.get("solar")) else params["solarCapex"] * (mult.get("solar") or 1)
    batt_base = lc["battery"] if _fin(lc.get("battery")) else params["batteryCapex"] * (mult.get("battery") or 1)
    on_base = lc["windOn"] if _fin(lc.get("windOn")) else params["windCapex"] * (mult.get("wind") or 1)
    off_base = lc["windOff"] if _fin(lc.get("windOff")) else params["windOffCapex"] * (mult.get("windOff") or 1)
    on_opex = lc["windOnOm"] / on_base if _fin(lc.get("windOn")) and _fin(lc.get("windOnOm")) else params["windOpexPct"]
    off_opex = lc["windOffOm"] / off_base if _fin(lc.get("windOff")) and _fin(lc.get("windOffOm")) else params["windOffOpexPct"]
    on_wacc = ww["on"] if _fin(ww.get("on")) else wacc + (params.get("windWaccPremium") or 0)
    off_wacc = ww["off"] if _fin(ww.get("off")) else wacc + (params.get("windOffWaccPremium") or 0)
    pre = dict(
        backup=bool(params.get("includeDieselBackup")),
        solar_per_kw=solar_base / ilr, batt_base=batt_base, on_base=on_base, off_base=off_base,
        on_crf=crf(on_wacc, params["windLife"]), off_crf=crf(off_wacc, params["windOffLife"]),
        on_opex=on_opex, off_opex=off_opex,
        solar_crf=crf(wacc, params["solarLife"]), batt_crf=crf(wacc, params["batteryLife"]),
        solar_opex=params["solarOpexPct"], batt_opex=params["batteryOpexPct"],
        deg_s=lgm(-(params.get("solarDegradationPct") or 0), wacc, params["solarLife"]),
        deg_on=lgm(-(params.get("windDegradationPct") or 0), on_wacc, params["windLife"]),
        deg_off=lgm(-(params.get("windOffDegradationPct") or 0), off_wacc, params["windOffLife"]),
        ucf_s=(unit_cf or {}).get("solar", np.nan), ucf_on=(unit_cf or {}).get("on", np.nan),
        ucf_off=(unit_cf or {}).get("off", np.nan),
        diesel_fuel=0.0, diesel_capex_ann=0.0, gas_ok=False, gas_fuel=np.inf, gas_capex_ann=0.0)
    if pre["backup"]:
        if params.get("dieselPriceMode") == "global":
            dp = params.get("dieselPrice") if _fin(params.get("dieselPrice")) else None
        else:
            raw = (diesel or {}).get("rawPrice")
            dp = max(raw, DIESEL_FLOOR) if _fin(raw) else None
        eff = params.get("dieselEfficiency")
        pre["diesel_fuel"] = dp * 1000 / (eff * DIESEL_KWH_PER_L) if (_fin(dp) and _fin(eff) and eff > 0) else np.inf
        pre["diesel_capex_ann"] = 1000 * 1000 * params["dieselCapex"] * crf(wacc, params["dieselLife"])
        pre["gas_ok"] = bool((gas or {}).get("available"))
        if pre["gas_ok"]:
            gp = params.get("gasPrice") if params.get("gasPriceMode") == "global" else (gas or {}).get("rawPrice")
            geff = params.get("gasEfficiency")
            pre["gas_fuel"] = gp * MMBTU_PER_MWH / geff if (_fin(gp) and _fin(geff) and geff > 0) else np.inf
            pre["gas_capex_ann"] = 1000 * 1000 * params["gasCapex"] * crf(wacc, params["gasLife"])
    return pre


def lcoe_full(pre, cf, solar, batt, w_on=0.0, w_off=0.0):
    """computeLcoeMetrics(...).lcoe for one build; w_on and w_off may both be > 0
    (a combination). batt may be fractional (an interpolated large build), cf is
    then the target. Scalars."""
    solar_kw, batt_kwh = solar * 1_000_000, batt * 1_000_000
    on_kw, off_kw = w_on * 1_000_000, w_off * 1_000_000
    cfc = 0.0 if not np.isfinite(cf) else max(0.0, min(1.0, cf))
    solar_capex = pre["solar_per_kw"] * solar_kw
    batt_capex = pre["batt_base"] * batt_kwh
    on_capex = pre["on_base"] * on_kw
    off_capex = pre["off_base"] * off_kw
    # worker order: solarAnnual + batteryAnnual + windAnnual + solarOpex + batteryOpex + windOpex;
    # with two surfaces windAnnual = onAnnual + offAnnual and windOpex = onOpex + offOpex
    # (one surface: the other term is exactly 0, so the sums are unchanged).
    wind_ann = on_capex * pre["on_crf"] + off_capex * pre["off_crf"] if (on_kw and off_kw) else \
        (off_capex * pre["off_crf"] if off_kw else on_capex * pre["on_crf"])
    wind_opex = on_capex * pre["on_opex"] + off_capex * pre["off_opex"] if (on_kw and off_kw) else \
        (off_capex * pre["off_opex"] if off_kw else on_capex * pre["on_opex"])
    cost = (solar_capex * pre["solar_crf"] + batt_capex * pre["batt_crf"] + wind_ann
            + solar_capex * pre["solar_opex"] + batt_capex * pre["batt_opex"] + wind_opex)
    energy = cfc * 8760 * 1000
    if on_kw > 0 or off_kw > 0:
        s = solar_kw * pre["ucf_s"]; a = on_kw * pre["ucf_on"]; o = off_kw * pre["ucf_off"]
        if not (on_kw and off_kw):
            # worker blendedDegradation(solarKw, windKw, solarCf, windCf, ...)
            wkw, wcf, wm = (off_kw, pre["ucf_off"], pre["deg_off"]) if off_kw else (on_kw, pre["ucf_on"], pre["deg_on"])
            s2, w2 = solar_kw * pre["ucf_s"], wkw * wcf
            if not (s2 + w2 > 0):
                s2, w2 = solar_kw, wkw
            energy *= (s2 * pre["deg_s"] + w2 * wm) / (s2 + w2)
        else:
            if not (s + a + o > 0):
                s, a, o = solar_kw, on_kw, off_kw
            energy *= (s * pre["deg_s"] + a * pre["deg_on"] + o * pre["deg_off"]) / (s + a + o)
    else:
        energy *= pre["deg_s"]
    if pre["backup"]:
        # the renewables deliver their degraded energy; the backup serves the rest of the full load
        full = 8760 * 1000
        backup_mwh = max(0.0, full - energy)
        energy = full
        d = pre["diesel_capex_ann"] + backup_mwh * pre["diesel_fuel"] if np.isfinite(pre["diesel_fuel"]) else np.inf
        g = pre["gas_capex_ann"] + backup_mwh * pre["gas_fuel"] if (pre["gas_ok"] and np.isfinite(pre["gas_fuel"])) else np.inf
        b = g if g < d else d
        if not np.isfinite(b):
            return np.inf
        cost += b
    if not np.isfinite(energy) or energy <= 0:
        return np.inf
    return cost / energy
