"""Hourly fixed-tilt PV model on NASA POWER hourly inputs (T066). Runs in the pvlib venv.

Per hour (LST label h = the hour [h, h+1) local; LST = UTC + round(lon/15) h, checked in the pilot):
- sun geometry at six 10-minute sub-steps; hour-integrated beam ratio
  Rb = sum max(cos AOI, 0) / sum max(cos Z, 0) over sunlit sub-steps (Duffie-Beckman hourly form);
- beam on the plane = (GHI - DHI) x Rb; DNI for the Perez indices = (GHI - DHI) / mean cos Z;
- sky diffuse: Perez 1990 (allsitescomposite1990), circumsolar term with the same Rb;
- ground reflected: GHI x albedo x (1 - cos tilt) / 2, albedo = daily daytime mean of
  POWER ALLSKY_SRF_ALB (0.2 where missing), clipped to [0.05, 0.9];
- incidence-angle modifier: ASHRAE b0 = 0.05 on beam/circumsolar, Marion integrals on diffuse;
- cell temperature: Faiman, u0 = 26.9, u1 = 6.2 (PVGIS free-standing c-Si), 10 m wind;
- DC: PVWatts, gamma = -0.35 %/K, DC losses 5 %;
- inverter: PVWatts part-load curve, eta_nom 0.975; AC losses 1.5 %;
- level factor k (GSA calibration, capped at 1.10, D-145) multiplies DC output; the inverter
  curve and the AC cap at 1/ILR (ILR 1.3) per kW DC then act on the calibrated level.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pvlib

ILR = 1.3
GAMMA = -0.0035
LOSS_DC = 0.05
LOSS_AC = 0.015
ETA_NOM = 0.975
ETA_REF = 0.9637
U0, U1 = 26.9, 6.2
ALB_DEFAULT = 0.2
NSUB = 6
RB_CAP = 10.0


def opt_tilt(lat: float) -> float:
    """Latitude-optimal fixed tilt, Jacobson & Jadhav (2018, Solar Energy 169) polynomial fits."""
    f = float(lat)
    if f >= 0:
        t = 1.3793 + f * (1.2011 + f * (-0.014404 + f * 0.000080509))
    else:
        t = -0.41657 + f * (1.4216 + f * (0.024051 + f * 0.00021828))
    return round(float(np.clip(abs(t), 0.0, 60.0)), 1)


def lst_offset(lon: float) -> int:
    return int(np.round(lon / 15.0))


def daily_albedo(alb: np.ndarray) -> np.ndarray:
    a = np.where(alb < 0, np.nan, alb).reshape(-1, 24)
    with np.errstate(all="ignore"):
        d = np.nanmean(a, axis=1)
    d = np.where(np.isfinite(d), d, ALB_DEFAULT)
    return np.repeat(np.clip(d, 0.05, 0.9), 24)


def geometry(time_lst: np.ndarray, lat: float, lon: float, tilt: float):
    """Hour-integrated geometry. Returns Rb, mean cos Z over the hour, effective zenith/azimuth/AOI."""
    n = len(time_lst)
    k = lst_offset(lon)
    start = pd.DatetimeIndex(time_lst - np.timedelta64(k, "h")).tz_localize("UTC")
    off = (np.arange(NSUB) * 60 // NSUB + 30 // NSUB)  # minutes 5, 15, ..., 55
    t = (start.values[:, None] + off[None, :].astype("timedelta64[m]")).ravel()
    sp = pvlib.solarposition.get_solarposition(pd.DatetimeIndex(t).tz_localize("UTC"), lat, lon,
                                               method="nrel_numpy")
    z = np.radians(sp["apparent_zenith"].to_numpy()).reshape(n, NSUB)
    a = np.radians(sp["azimuth"].to_numpy()).reshape(n, NSUB)
    cz = np.cos(z)
    lit = cz > 0
    sx, sy = np.sin(z) * np.sin(a), np.sin(z) * np.cos(a)
    b = np.radians(tilt)
    g = np.radians(180.0 if lat >= 0 else 0.0)
    nx, ny, nz = np.sin(b) * np.sin(g), np.sin(b) * np.cos(g), np.cos(b)
    ca = sx * nx + sy * ny + cz * nz
    scz = np.where(lit, cz, 0).sum(1)
    sca = np.where(lit, np.maximum(ca, 0), 0).sum(1)
    up = scz / NSUB > 0.01                     # sun meaningfully above the horizon this hour
    rb = np.where(up, np.minimum(sca / np.where(up, scz, 1), RB_CAP), 0.0)
    w = np.where(lit, cz, 0)
    vx, vy, vz = (sx * w).sum(1), (sy * w).sum(1), (cz * w).sum(1)
    nrm = np.sqrt(vx ** 2 + vy ** 2 + vz ** 2)
    nrm = np.where(nrm > 0, nrm, 1)
    zen = np.degrees(np.arccos(np.clip(vz / nrm, -1, 1)))
    azi = np.degrees(np.arctan2(vx, vy)) % 360
    aoi = np.degrees(np.arccos(np.clip((vx * nx + vy * ny + vz * nz) / nrm, -1, 1)))
    return dict(rb=rb, mcz=scz / NSUB, up=up, zen=zen, azi=azi, aoi=aoi)


_PEREZ = None


def perez_f(eps, delta, zen_rad):
    global _PEREZ
    if _PEREZ is None:
        _PEREZ = pvlib.irradiance._get_perez_coefficients("allsitescomposite1990")
    F1c, F2c = _PEREZ
    bins = np.digitize(eps, [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2], right=False)
    F1 = np.maximum(F1c[bins, 0] + F1c[bins, 1] * delta + F1c[bins, 2] * zen_rad, 0)
    F2 = F2c[bins, 0] + F2c[bins, 1] * delta + F2c[bins, 2] * zen_rad
    return F1, F2


def poa(inp: dict, geo: dict, tilt: float, time_lst: np.ndarray) -> dict:
    ghi = np.maximum(inp["ALLSKY_SFC_SW_DWN"], 0)
    dhi = np.minimum(np.maximum(inp["ALLSKY_SFC_SW_DIFF"], 0), ghi)
    bh = ghi - dhi
    up = geo["up"]
    dni_x = pvlib.irradiance.get_extra_radiation(pd.DatetimeIndex(time_lst)).to_numpy()
    dni = np.where(up, np.minimum(bh / np.where(up, geo["mcz"], 1), dni_x), 0.0)
    # hours with GHI but no sun above 0.6 deg on average: all diffuse, isotropic
    dhi = np.where(up, dhi, ghi)
    beam = np.where(up, bh * geo["rb"], 0.0)
    zr = np.radians(geo["zen"])
    am = pvlib.atmosphere.get_relative_airmass(np.minimum(geo["zen"], 89.9), "kastenyoung1989")
    am = np.nan_to_num(am, nan=38.0)
    kap = 1.041
    with np.errstate(all="ignore"):
        eps = np.where(dhi > 0, ((dhi + dni) / dhi + kap * zr ** 3) / (1 + kap * zr ** 3), 1.0)
    delta = dhi * am / dni_x
    F1, F2 = perez_f(eps, delta, zr)
    F1 = np.where(up, F1, 0); F2 = np.where(up, F2, 0)
    b = np.radians(tilt)
    iso = dhi * (1 - F1) * (1 + np.cos(b)) / 2
    circ = dhi * F1 * geo["rb"]
    hor = dhi * F2 * np.sin(b)
    alb = daily_albedo(inp["ALLSKY_SRF_ALB"])
    gnd = ghi * alb * (1 - np.cos(b)) / 2
    total = np.maximum(beam + circ + iso + hor + gnd, 0)
    iam_b = pvlib.iam.ashrae(geo["aoi"], b=0.05)
    m = pvlib.iam.marion_diffuse("ashrae", tilt, b=0.05)
    eff = (beam + circ) * iam_b + iso * m["sky"] + hor * m["horizon"] + gnd * m["ground"]
    return dict(poa=total, eff=np.maximum(eff, 0), beam=beam, diffuse=circ + iso + hor, ground=gnd,
                dni_model=dni)


def ac_unclipped(eff: np.ndarray, poa_global: np.ndarray, t2m: np.ndarray, ws: np.ndarray) -> np.ndarray:
    """Inverter AC output per kW DC before the AC cap (kW), PVWatts DC and part-load curve."""
    tc = pvlib.temperature.faiman(poa_global, t2m, np.maximum(ws, 0), u0=U0, u1=U1)
    pdc = eff / 1000.0 * (1 + GAMMA * (tc - 25.0)) * (1 - LOSS_DC)
    pdc = np.maximum(pdc, 0)
    pac0 = 1.0 / ILR
    pdc0 = pac0 / ETA_NOM
    zeta = pdc / pdc0
    with np.errstate(all="ignore"):
        eta = ETA_NOM / ETA_REF * (-0.0162 * zeta - 0.0059 / zeta + 0.9858)
    pac = np.where(pdc > 0, np.maximum(eta, 0) * pdc, 0.0)
    return pac, tc


def run_region(inp: dict, lat: float, lon: float, tilt: float | None = None) -> dict:
    tilt = opt_tilt(lat) if tilt is None else tilt
    tl = inp["time"]
    geo = geometry(tl, lat, lon, tilt)
    p = poa(inp, geo, tilt, tl)
    pac, tc = ac_unclipped(p["eff"], p["poa"], inp["T2M"], inp["WS10M"])
    return dict(tilt=tilt, pac=pac, tc=tc, **p)


def dc_power(eff: np.ndarray, poa_global: np.ndarray, t2m: np.ndarray, ws: np.ndarray) -> np.ndarray:
    """DC output per kW DC (kW) after temperature and DC losses, before the level factor."""
    tc = pvlib.temperature.faiman(poa_global, t2m, np.maximum(ws, 0), u0=U0, u1=U1)
    return np.maximum(eff / 1000.0 * (1 + GAMMA * (tc - 25.0)) * (1 - LOSS_DC), 0)


def inverter(pdc: np.ndarray, clip: bool = True) -> np.ndarray:
    """PVWatts part-load curve; AC cap 1/ILR when clip; AC losses applied. kWh per kW DC per hour."""
    pac0 = 1.0 / ILR
    zeta = pdc / (pac0 / ETA_NOM)
    with np.errstate(all="ignore"):
        eta = ETA_NOM / ETA_REF * (-0.0162 * zeta - 0.0059 / zeta + 0.9858)
    pac = np.where(pdc > 0, np.maximum(eta, 0) * pdc, 0.0)
    if clip:
        pac = np.minimum(pac, pac0)
    return pac * (1 - LOSS_AC)


def finish(pac: np.ndarray, k: float) -> tuple[np.ndarray, np.ndarray]:
    """Calibrated, clipped hourly kWh per kW DC (after AC losses), and the unclipped equivalent."""
    raw = k * pac * (1 - LOSS_AC)
    return np.minimum(k * pac, 1.0 / ILR) * (1 - LOSS_AC), raw
