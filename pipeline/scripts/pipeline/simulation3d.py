"""Dispatch simulation over the solar x wind x battery configuration space.

The battery dispatch is the original atlas kernel, unchanged expression for
expression, so that a wind capacity of zero reproduces the published solar +
battery results exactly. The only additions are:

  * generation is solar x solar_gw + wind x wind_gw rather than solar alone;
  * curtailment (surplus that the battery cannot absorb) is now counted, which
    the original silently discarded.

Everything is vectorised across locations with numba's parallel loop, which is a
much better fit than the original process pool: the profiles stay in shared
memory instead of being pickled to workers once per location.
"""

from __future__ import annotations

import numpy as np

from .config import BASELOAD_GW, BATTERY_ROUND_TRIP_EFFICIENCY, N_HOURS, SAMPLE_DURATION_HOURS

try:
    from numba import njit, prange
    HAVE_NUMBA = True
except ImportError:  # pragma: no cover
    HAVE_NUMBA = False
    prange = range

    def njit(*a, **k):
        def deco(f):
            return f
        return deco


# 2024 is a leap year; these are the hour offsets of 1 January, 1 April,
# 1 July and 1 October, matching the original SEASONS definition.
SEASON_NAMES = ("winter", "spring", "summer", "fall")
SEASON_STARTS = np.array([0, 2184, 4368, 6576], dtype=np.int64)

SAMPLE_SCALE = 1000.0     # series are stored as int16 in units of 1/1000 GW

# Only battery flow is stored per configuration. Solar and wind generation are a
# function of capacity alone (profile x GW), so they are written once per
# capacity level and recombined in the browser; unserved energy is then
# 1 - min(1, solar + wind + discharge). That keeps the sample archive at about
# 3 GB instead of 12 GB and makes each user interaction a smaller download.


@njit(cache=True, parallel=True, fastmath=False)
def simulate_config(
    solar_m, wind_m, solar_gw, wind_gw, batt_gwh,
    charge_efficiency, discharge_efficiency,
    season_starts, out_cf, out_curt, out_samples,
):
    n_loc = solar_m.shape[0]
    length = solar_m.shape[1]
    total_demand = length * BASELOAD_GW

    for i in prange(n_loc):
        current_soc = 0.0
        total_unserved = 0.0
        total_curtailed = 0.0

        s32 = np.float32(solar_gw)
        w32 = np.float32(wind_gw)
        one = np.float32(BASELOAD_GW)
        for idx in range(length):
            # float32 here, deliberately: the original atlas computed generation
            # and net load in float32, so keeping the same precision makes the
            # wind = 0 slice reproduce the published results bit for bit.
            gen = solar_m[i, idx] * s32 + wind_m[i, idx] * w32
            nl = float(one - gen)
            flow = 0.0
            unserved = 0.0
            curtailed = 0.0

            if nl > 0.0:
                max_deliverable = current_soc * discharge_efficiency
                discharge = nl if nl < max_deliverable else max_deliverable
                flow = discharge
                if discharge_efficiency > 0.0:
                    current_soc -= discharge / discharge_efficiency
                if current_soc < 0.0 and current_soc > -1e-9:
                    current_soc = 0.0
                unserved = nl - discharge
            else:
                available_storage = batt_gwh - current_soc
                if available_storage < 0.0:
                    available_storage = 0.0
                max_charge_input = (
                    available_storage / charge_efficiency if charge_efficiency > 0.0 else 0.0
                )
                excess = -nl
                charge = excess if excess < max_charge_input else max_charge_input
                flow = -charge
                current_soc += charge * charge_efficiency
                if current_soc > batt_gwh and current_soc < batt_gwh + 1e-9:
                    current_soc = batt_gwh
                curtailed = excess - charge

            total_unserved += unserved
            total_curtailed += curtailed

            # sample windows: battery flow only (see note above)
            for s in range(season_starts.shape[0]):
                st = season_starts[s]
                if idx >= st and idx < st + SAMPLE_DURATION_HOURS:
                    out_samples[i, s, idx - st] = np.int16(round(flow * SAMPLE_SCALE))

        served = total_demand - total_unserved
        out_cf[i] = served / total_demand if total_demand > 0 else 0.0
        gen_total = 0.0
        for idx in range(length):
            gen_total += float(solar_m[i, idx] * s32 + wind_m[i, idx] * w32)
        out_curt[i] = total_curtailed / gen_total if gen_total > 0 else 0.0


def make_buffers(n_loc: int):
    return (
        # float64 for the capacity factor: rounding a float32 to four decimals
        # flips a handful of exact-tie values relative to the original atlas.
        np.zeros(n_loc, dtype=np.float64),
        np.zeros(n_loc, dtype=np.float64),
        np.zeros((n_loc, len(SEASON_STARTS), SAMPLE_DURATION_HOURS), dtype=np.int16),
    )


def efficiencies() -> tuple[float, float]:
    e = float(np.sqrt(BATTERY_ROUND_TRIP_EFFICIENCY))
    return e, e
