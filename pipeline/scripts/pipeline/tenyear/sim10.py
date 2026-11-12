"""T060 dispatch on the continuous 2015-2024 series.

The kernel is simulation3d.simulate_config's dispatch, expression for expression
(float32 generation, float64 state, the same clamps), with three differences:
  * no sample-window output;
  * a starting state of charge per region (0 = the pipeline's cold start);
  * unserved energy, curtailment and generation are also summed per calendar
    year (year_starts), so each year's CF can be read off the same run. The
    battery state simply carries over the year boundary.
The whole-run CF is (hours - total unserved) / hours, the same expression as the
pipeline's; on a single year it is the pipeline's annual_cf exactly (gate B1).

Profiles (work/): solar uint16 x 1e4 per year (lossless at the shipped 4 dp),
wind float32 per year for the rows that have a profile (others are zero).
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / "work" / "numba"))
from numba import njit, prange  # noqa: E402

YEARS = list(range(2015, 2025))
EFF = float(np.sqrt(0.90))


def year_hours(years=YEARS):
    return np.array([(date(y + 1, 1, 1) - date(y, 1, 1)).days * 24 for y in years], dtype=np.int64)


def year_starts(years=YEARS):
    h = year_hours(years)
    return np.concatenate([[0], np.cumsum(h)[:-1]]).astype(np.int64)


@njit(cache=True, parallel=True, fastmath=False)
def simulate(solar_m, wind_m, solar_gw, wind_gw, batt_gwh, ce, de, soc0, ystarts,
             out_cf, out_curt, out_ycf, out_soc):
    n_loc = solar_m.shape[0]
    length = solar_m.shape[1]
    ny = ystarts.shape[0]
    total_demand = length * 1.0
    for i in prange(n_loc):
        current_soc = soc0[i]
        total_unserved = 0.0
        total_curtailed = 0.0
        y_uns = np.zeros(ny)
        s32 = np.float32(solar_gw)
        w32 = np.float32(wind_gw)
        one = np.float32(1.0)
        y = 0
        for idx in range(length):
            if y + 1 < ny and idx == ystarts[y + 1]:
                y += 1
            gen = solar_m[i, idx] * s32 + wind_m[i, idx] * w32
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
            y_uns[y] += unserved
        served = total_demand - total_unserved
        out_cf[i] = served / total_demand
        gen_total = 0.0
        for idx in range(length):
            gen_total += float(solar_m[i, idx] * s32 + wind_m[i, idx] * w32)
        out_curt[i] = total_curtailed / gen_total if gen_total > 0 else 0.0
        for yy in range(ny):
            hy = (ystarts[yy + 1] if yy + 1 < ny else length) - ystarts[yy]
            out_ycf[i, yy] = (hy - y_uns[yy]) / hy
        out_soc[i] = current_soc


def run(solar_m, wind_m, s_gw, w_gw, b_gwh, ystarts, soc0=None):
    n = solar_m.shape[0]
    cf = np.zeros(n); curt = np.zeros(n); ycf = np.zeros((n, len(ystarts))); soc = np.zeros(n)
    s0 = np.zeros(n) if soc0 is None else soc0
    simulate(solar_m, wind_m, float(s_gw), float(w_gw), float(b_gwh), EFF, EFF, s0,
             np.asarray(ystarts, dtype=np.int64), cf, curt, ycf, soc)
    return cf, curt, ycf, soc


# --------------------------------------------------------------------------- loading
def solar_ids():
    return np.load(ROOT / "work" / "solar_ids.npy")


def load_solar(years=YEARS, rows=None):
    parts = []
    for y in years:
        u = np.load(ROOT / "work" / ("solar_2024_u16.npy" if y == 2024 else f"solar/solar_{y}_u16.npy"),
                    mmap_mode="r")
        u = u if rows is None else u[rows]
        parts.append((np.asarray(u, dtype=np.float64) / 1e4).astype(np.float32))
    return np.ascontiguousarray(np.concatenate(parts, axis=1))


def load_wind(tag, years=YEARS, ids=None):
    """float32 [len(ids), hours]; ids default = solar ids (sorted)."""
    ids = solar_ids() if ids is None else ids
    wrows = np.load(ROOT / "work" / "wind" / f"{tag}_rows.npy")
    hrs = year_hours(years)
    out = np.zeros((len(ids), int(hrs.sum())), dtype=np.float32)
    pos = np.searchsorted(ids, wrows)
    hit = (pos < len(ids)) & (ids[np.minimum(pos, len(ids) - 1)] == wrows)
    col = 0
    for y, h in zip(years, hrs):
        m = np.load(ROOT / "work" / "wind" / f"{tag}_{y}.npy", mmap_mode="r")
        out[pos[hit], col:col + h] = m[hit]
        col += h
    return out
