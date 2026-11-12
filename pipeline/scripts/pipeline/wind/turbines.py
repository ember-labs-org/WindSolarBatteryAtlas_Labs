"""Turbine choice and hub height (T081).

Three pieces, each on its own public source:

1. IEC class by 50-year extreme wind (IEC 61400-1 ed. 4, 2019, table 1):
   class I for Vref = 50 m/s, II for 42.5 m/s, III for 37.5 m/s. A site needs
   the lowest class whose Vref is at least the site's 50-year 10-min wind at hub
   height (V50). V50 comes from DTU's Global Atlas of Siting Parameters V1
   (2021, CC BY 4.0) at 100 m and 150 m. Where GASP has no value the old
   mean-speed rule (gwa_sources.IEC_SPEED_BREAKS) is kept.

2. Market turbines (rated power, rotor, hub height of recent new build) where a
   national register or report publishes them: data/market_turbines.csv. Each
   becomes a synthetic power curve by the atlas's existing method
   (power_curves.PowerCurve: Ryberg et al. 2019 / Staffell and Pfenninger 2016).
   Elsewhere the three Global Wind Atlas reference turbines at 100 m stay.

3. Hub height: the GWA4 Weibull A and k at 100 m and 150 m are interpolated in
   log height (power law for A, i.e. the local shear exponent; linear in
   ln(z) for k). Heights outside 100-150 m extrapolate the same law.

A market turbine changes a pixel's CF by the ratio of the Weibull-integrated
CF of the market curve at hub height to that of the pixel's GWA reference
class curve at 100 m, both through the atlas's own synthetic curves and the
same air-density correction: the level stays anchored on the GWA CF layer.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from scripts.pipeline.wind.power_curves import CURVES, PowerCurve, RHO0

HERE = Path(__file__).resolve().parent
MARKET_CSV = HERE / "data" / "market_turbines.csv"
# IEC 61400-1 ed. 4 (2019) table 1, reference wind speed Vref (m/s)
IEC_VREF = {1: 50.0, 2: 42.5, 3: 37.5}

A_GRID = np.arange(0.2, 30.0 + 1e-9, 0.05)
K_GRID = np.arange(0.5, 8.0 + 1e-9, 0.02)
V_EDGES = np.arange(0.0, 45.0 + 1e-9, 0.05)


def class_from_v50(v50: np.ndarray) -> np.ndarray:
    """IEC class 3/2/1 for a V50 at hub height; 0 where V50 is missing."""
    c = np.where(v50 <= IEC_VREF[3], 3, np.where(v50 <= IEC_VREF[2], 2, 1)).astype("uint8")
    c[~np.isfinite(v50)] = 0
    return c


def interp_height(x100: np.ndarray, x150: np.ndarray, hub: np.ndarray | float, law: str) -> np.ndarray:
    """Value at hub height from the 100 m and 150 m layers (power law or log-linear)."""
    f = np.log(np.asarray(hub, dtype="float64") / 100.0) / np.log(1.5)
    if law == "power":
        with np.errstate(divide="ignore", invalid="ignore"):
            return x100 * np.power(x150 / x100, f)
    return x100 + (x150 - x100) * f


def weibull_cf_table(curve: PowerCurve) -> np.ndarray:
    """Gross CF of `curve` for a Weibull(A, k) speed distribution, on (A_GRID, K_GRID)."""
    vm = 0.5 * (V_EDGES[1:] + V_EDGES[:-1])
    p = curve.output(vm).astype("float64")
    out = np.empty((A_GRID.size, K_GRID.size))
    for j, k in enumerate(K_GRID):
        F = 1.0 - np.exp(-np.power(V_EDGES[None, :] / A_GRID[:, None], k))
        out[:, j] = (np.diff(F, axis=1) * p[None, :]).sum(axis=1)
    return out


class WeibullCF:
    """Bilinear lookup of the Weibull-integrated CF for one curve."""

    def __init__(self, curve: PowerCurve):
        from scipy.interpolate import RegularGridInterpolator
        self.curve = curve
        self.f = RegularGridInterpolator((A_GRID, K_GRID), weibull_cf_table(curve),
                                         bounds_error=False, fill_value=None)

    def __call__(self, A: np.ndarray, k: np.ndarray, dens: np.ndarray) -> np.ndarray:
        # density correction as build_wind_profiles: speed x (rho/rho0)^(1/3), i.e. A scaled
        a = A * np.power(np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0) / RHO0, 1.0 / 3.0)
        pts = np.column_stack([np.clip(a, A_GRID[0], A_GRID[-1]), np.clip(k, K_GRID[0], K_GRID[-1])])
        return self.f(pts)


def load_market(path: Path = MARKET_CSV) -> pd.DataFrame:
    m = pd.read_csv(path, comment="#")
    need = {"iso3", "rated_kw", "rotor_m", "hub_m", "source"}
    assert need <= set(m.columns), f"{path}: needs {need}"
    return m.set_index("iso3")


def market_curve(row) -> PowerCurve:
    return PowerCurve(f"{row.name} {row.rated_kw/1000:.2f}MW/{row.rotor_m:.0f}m/{row.hub_m:.0f}m",
                      float(row.rated_kw), float(row.rotor_m), float(row.hub_m))


def region_curve(r: pd.Series) -> PowerCurve:
    """The power curve the profile builder uses for one resource-CSV row."""
    if "on_rotor_m" in r.index and np.isfinite(r.get("on_rotor_m", np.nan)) and r.get("on_market", "") not in ("", None) \
            and isinstance(r.get("on_market"), str):
        return PowerCurve(f"{r['on_market']} market", float(r["on_rated_kw"]), float(r["on_rotor_m"]),
                          float(r["on_hub_m"]))
    c = int(r["on_site_iec_class"]) if np.isfinite(r["on_site_iec_class"]) else 0
    return CURVES[c] if c in CURVES else CURVES["offshore"]
