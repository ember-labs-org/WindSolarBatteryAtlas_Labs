"""T067 before/after: per-region standalone CF and LCOE (1 GW, no battery) at the app's
default year 2026, in Local mode (local capex + local WACC) and Global mode (app defaults).

Formula as T065's b_unit_lcoe.py (app.js precomputeLcoePerLocation / computeLcoeMetricsFast):
  LCOE = capex x (CRF + O&M) / (CF x 8,760 x degradation multiplier)
Local capex interpolation anchor: --anchor 2024 (before T067: the files' first column is a 2024
cost) or 2026 (T067: it is the 2026 cost). Offshore is floating-priced only for floating classes
(both modes Local).

  python3 -I unit_lcoe.py <data dir> <out csv> --anchor 2024|2026
"""
import argparse

import duckdb
import numpy as np
import pandas as pd

YEAR = 2026
GLOBAL = dict(solar=720.0, wacc=0.07, on=1085.0, off=2931.0, on_om=None, off_prem=0.0092)


def crf(r, n):
    return r * (1 + r) ** n / ((1 + r) ** n - 1)


def lgm(g, r, n):
    ratio = (1 + g) / (1 + r)
    pv = (1 / (1 + g)) * ratio * (1 - ratio ** n) / (1 - ratio)
    return pv * crf(r, n)


def interp(year, a, b, c, y0):
    a, b, c = (np.asarray(x, float) for x in (a, b, c))
    if year <= y0:
        return a
    if year <= 2035:
        return a + (b - a) * (year - y0) / (2035 - y0)
    return b + (c - b) * (year - 2035) / 15


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("out")
    ap.add_argument("--anchor", type=int, required=True)
    a = ap.parse_args()
    D = a.data
    con = duckdb.connect()
    sol = con.sql(f"select location_id, annual_cf solar_cf from '{D}/summary_w0.parquet' where solar_gw=1 and batt_gwh=0").df()
    on = con.sql(f"select location_id, annual_cf on_cf from '{D}/summary_w1.parquet' where solar_gw=0 and batt_gwh=0 and wind_gw=1").df()
    off = con.sql(f"select location_id, annual_cf off_cf from '{D}/summary_wo1.parquet' where solar_gw=0 and batt_gwh=0 and wind_gw=1").df()
    df = sol.merge(on, on="location_id", how="left").merge(off, on="location_id", how="left")
    cap = pd.read_csv(f"{D}/voronoi_local_capex.csv").drop(columns=["latitude", "longitude"])
    w = pd.read_csv(f"{D}/voronoi_wacc.csv")[["location_id", "wacc_percent"]]
    ww = pd.read_csv(f"{D}/voronoi_wacc_wind.csv")[["location_id", "wind_on_wacc_percent", "wind_off_fixed_wacc_percent",
                                                     "wind_off_float_wacc_percent"]]
    df = df.merge(cap, on="location_id", how="left").merge(w, on="location_id", how="left").merge(ww, on="location_id", how="left")
    y0, Y = a.anchor, YEAR
    r = df.wacc_percent / 100
    sc = interp(Y, df.solar_2024, df.solar_2035, df.solar_2050, y0)
    df["capex_solar"] = sc
    df["lcoe_solar_local"] = sc / 1.3 * (crf(r, 30) + 0.015) * 1000 / (df.solar_cf * 8760 * lgm(-0.005, r, 30))
    ro = df.wind_on_wacc_percent / 100
    oc = interp(Y, df.wind_on_2024, df.wind_on_2035, df.wind_on_2050, y0)
    oom = interp(Y, df.wind_on_om_2024, df.wind_on_om_2035, df.wind_on_om_2050, y0)
    df["capex_on"] = oc
    df["lcoe_on_local"] = (oc * crf(ro, 25) + oom) * 1000 / (df.on_cf * 8760 * lgm(-0.002, ro, 25))
    fl = df.wind_off_class.fillna("").str.startswith("floating").to_numpy()
    rf = np.where(fl, df.wind_off_float_wacc_percent, df.wind_off_fixed_wacc_percent) / 100

    def col(p):
        return np.where(fl, df[f"wind_off_float{p}"], df[f"wind_off_fixed{p}"])
    fc = interp(Y, col("_2024"), col("_2035"), col("_2050"), y0)
    fom = interp(Y, col("_om_2024"), col("_om_2035"), col("_om_2050"), y0)
    df["capex_off"] = fc
    df["lcoe_off_local"] = (fc * crf(rf, 25) + fom) * 1000 / (df.off_cf * 8760 * lgm(-0.002, rf, 25))
    for c in ("on", "off"):
        df.loc[~(df[f"{c}_cf"] > 0), f"lcoe_{c}_local"] = np.nan
    keep = ["location_id", "country_iso3", "region", "solar_cf", "on_cf", "off_cf", "capex_solar", "capex_on", "capex_off",
            "wind_off_class", "wind_off_depth_m", "wind_off_shore_km", "lcoe_solar_local", "lcoe_on_local", "lcoe_off_local"]
    df[keep].to_csv(a.out, index=False, float_format="%.4f")
    print(f"wrote {len(df)} regions to {a.out}")


if __name__ == "__main__":
    main()
