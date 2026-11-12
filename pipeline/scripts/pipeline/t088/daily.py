"""T088 step 1: daily mean CF per region, 2015-2024, from the atlas's hourly ten-year profiles.

Reads in place (never writes there):
  solar  ~/wind-atlas-T068/work/solar/solar_<y>_u16.npy (2015-2023), work/solar_2024_u16.npy;
         uint16 x 1e4, rows in work/solar_ids.npy order (as sim10.load_solar)
  on     ~/wind-atlas-T081/work/wind/on_<y>.npy, rows on_rows.npy (float32)
  off    ~/wind-atlas-integ/work/wind/off_<y>.npy, rows off_rows.npy (float32)
Writes <out>/daily.npz: solar, on, off as float32 [rows, 3650] (UTC days, 29 Feb dropped),
plus solar_ids, on_rows, off_rows. One year in memory at a time.

  python3 -I daily.py --out ~/wind-atlas-T088/out
"""
import argparse
from pathlib import Path

import numpy as np

H = Path.home()
SOLAR = H / "wind-atlas-T068/work"
ON = H / "wind-atlas-T081/work/wind"
OFF = H / "wind-atlas-integ/work/wind"
YEARS = range(2015, 2025)


def daily(m):
    """[rows, hours] -> [rows, 365] daily means; leap years drop 29 Feb (day index 59)."""
    n = m.shape[1]
    assert n in (8760, 8784), n
    d = np.asarray(m, dtype=np.float32).reshape(m.shape[0], n // 24, 24).mean(axis=2, dtype=np.float64)
    if n == 8784:
        d = np.delete(d, 59, axis=1)
    return d.astype(np.float32)


def solar_year(y):
    p = SOLAR / ("solar_2024_u16.npy" if y == 2024 else f"solar/solar_{y}_u16.npy")
    u = np.load(p, mmap_mode="r")
    out = np.empty((u.shape[0], 365), np.float32)
    for i in range(0, u.shape[0], 1000):  # chunked to keep memory small
        out[i:i + 1000] = daily(np.asarray(u[i:i + 1000], dtype=np.float32) / 1e4)
    return out


def wind_year(root, tag, y):
    m = np.load(root / f"{tag}_{y}.npy", mmap_mode="r")
    out = np.empty((m.shape[0], 365), np.float32)
    for i in range(0, m.shape[0], 1000):
        out[i:i + 1000] = daily(m[i:i + 1000])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    res = {"solar_ids": np.load(SOLAR / "solar_ids.npy"),
           "on_rows": np.load(ON / "on_rows.npy"), "off_rows": np.load(OFF / "off_rows.npy")}
    for key, fn in (("solar", solar_year), ("on", lambda y: wind_year(ON, "on", y)),
                    ("off", lambda y: wind_year(OFF, "off", y))):
        parts = []
        for y in YEARS:
            parts.append(fn(y))
            print(key, y, parts[-1].shape, f"mean {parts[-1].mean():.4f}", flush=True)
        res[key] = np.concatenate(parts, axis=1)
    np.savez(a.out / "daily.npz", **res)
    print({k: v.shape for k, v in res.items()})


if __name__ == "__main__":
    main()
