"""Turbine power curves for the atlas.

We do not have licence to redistribute manufacturers' measured power curves, so
the atlas uses the standard synthetic curve used in the global wind-modelling
literature, parameterised by *specific power* (rated watts per square metre of
rotor). This is the approach of Ryberg et al. (2019) and RESKit, and it
reproduces measured curves closely because specific power is what sets the
rated wind speed.

Base curve, with v_ci = 3 m/s cut-in and v_co = 25 m/s cut-out:

    P(v)/P_rated = 0                                   v < v_ci
                 = (v^3 - v_ci^3)/(v_r^3 - v_ci^3)     v_ci <= v < v_r
                 = 1                                   v_r <= v <= v_co
                 = 0                                   v > v_co

with the rated speed implied by specific power through the actuator-disc
relation  SP = 0.5 * rho0 * Cp * v_r^3,  Cp = 0.45, rho0 = 1.225 kg/m3.

The base curve is then convolved with a Gaussian of standard deviation
0.2 * v, following Staffell and Pfenninger (2016). That smoothing represents
turbulence and the spatial spread of a wind farm, and it is what turns a
single-turbine curve into a farm curve: without it the knee at rated speed is
far too sharp and the annual output of a windy site is overstated.

Specific powers assumed for the three Global Wind Atlas onshore classes (4.2 MW
rated, rotors 117/136/150 m, 100 m hub) and for the offshore reference turbine.
"""

from __future__ import annotations

import numpy as np

RHO0 = 1.225
CP = 0.45
V_CUT_IN = 3.0
V_CUT_OUT = 25.0
SIGMA_FRACTION = 0.2          # Gaussian smoothing, Staffell & Pfenninger (2016)

V_GRID = np.arange(0.0, 40.0 + 1e-9, 0.05)


def specific_power(rated_kw: float, rotor_m: float) -> float:
    area = np.pi * (rotor_m / 2.0) ** 2
    return rated_kw * 1000.0 / area


def rated_speed(sp_w_m2: float) -> float:
    return float((sp_w_m2 / (0.5 * RHO0 * CP)) ** (1.0 / 3.0))


def base_curve(v: np.ndarray, v_rated: float) -> np.ndarray:
    p = np.zeros_like(v, dtype="float64")
    ramp = (v >= V_CUT_IN) & (v < v_rated)
    p[ramp] = (v[ramp] ** 3 - V_CUT_IN**3) / (v_rated**3 - V_CUT_IN**3)
    p[(v >= v_rated) & (v <= V_CUT_OUT)] = 1.0
    return np.clip(p, 0.0, 1.0)


def smoothed_curve(v_rated: float, v: np.ndarray = V_GRID) -> np.ndarray:
    """Gaussian-convolved power curve on `v`, normalised to 1.0 at rated."""
    base = base_curve(v, v_rated)
    out = np.zeros_like(v)
    for i, vi in enumerate(v):
        if vi <= 0:
            continue
        sigma = SIGMA_FRACTION * vi
        w = np.exp(-0.5 * ((v - vi) / sigma) ** 2)
        w /= w.sum()
        out[i] = float((w * base).sum())
    return np.clip(out, 0.0, 1.0)


class PowerCurve:
    def __init__(self, name: str, rated_kw: float, rotor_m: float, hub_m: float):
        self.name = name
        self.rated_kw = rated_kw
        self.rotor_m = rotor_m
        self.hub_m = hub_m
        self.specific_power = specific_power(rated_kw, rotor_m)
        self.v_rated = rated_speed(self.specific_power)
        self.v = V_GRID
        self.p = smoothed_curve(self.v_rated, self.v)

    def __repr__(self) -> str:
        return (f"PowerCurve({self.name}, {self.rated_kw:.0f} kW, rotor {self.rotor_m:.0f} m, "
                f"SP {self.specific_power:.0f} W/m2, v_rated {self.v_rated:.1f} m/s)")

    def output(self, speed: np.ndarray) -> np.ndarray:
        """Capacity factor (0-1) for an array of hub-height wind speeds."""
        return np.interp(speed, self.v, self.p, left=0.0, right=0.0).astype("float32")


# Onshore classes matching the GWA4 capacity-factor layers, and the offshore
# reference turbine matching cf_offshore_cog_150m.
CURVES = {
    1: PowerCurve("IEC1 4.2MW/117m", 4200, 117, 100),
    2: PowerCurve("IEC2 4.2MW/136m", 4200, 136, 100),
    3: PowerCurve("IEC3 4.2MW/150m", 4200, 150, 100),
    "offshore": PowerCurve("Offshore 8MW/167m", 8000, 167, 150),
}


if __name__ == "__main__":
    for k, c in CURVES.items():
        print(k, c)
        for v in (4, 6, 8, 10, 12, 15, 20):
            print(f"    {v:2d} m/s -> {c.output(np.array([float(v)]))[0]:.3f}")
