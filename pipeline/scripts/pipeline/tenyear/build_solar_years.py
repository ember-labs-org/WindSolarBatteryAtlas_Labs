"""Solar kwh_per_kw 2015-2023 per year from the cached NASA POWER responses (T060).

kwh_per_kw = round(ALLSKY_SFC_SW_DWN x 0.0008, 4), stored as uint16 x 1e4
(lossless at 4 dp) in work/solar/solar_<year>_u16.npy, rows in solar_ids order.
Checks: every region present, LST time standard, strictly hourly with no missing
or duplicate hours, 8,760 / 8,784 hours per year, no fill values (-999).
"""
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

import power as P

Y0, Y1 = 2015, 2023
ids = np.load(P.ROOT / "work/solar_ids.npy")
hrs = [P.hours_in(y, y) for y in range(Y0, Y1 + 1)]
starts = np.concatenate([[0], np.cumsum(hrs)])
out = {y: np.zeros((len(ids), h), dtype="uint16") for y, h in zip(range(Y0, Y1 + 1), hrs)}
fills = 0; neg = 0
for r, loc in enumerate(ids):
    p = P.cache_path(f"{Y0}_{Y1}", int(loc))
    d = json.loads(gzip.decompress(p.read_bytes()))
    assert d["header"]["time_standard"] == "LST", loc
    g, _ = P.series(d, Y0, Y1)          # raises on missing / duplicate / out-of-order hours
    fills += int((g == -999).sum())
    neg += int((g < 0).sum())
    k = P.to_kwh(np.where(g < 0, 0.0, g))
    for j, y in enumerate(range(Y0, Y1 + 1)):
        out[y][r] = np.rint(k[starts[j]:starts[j + 1]] * 1e4).astype("uint16")
    if r % 1000 == 0:
        print(r, flush=True)
(P.ROOT / "work/solar").mkdir(exist_ok=True)
for y in out:
    np.save(P.ROOT / f"work/solar/solar_{y}_u16.npy", out[y])
    print(y, out[y].shape, "mean CF", round(float(out[y].mean() / 1e4), 5))
print(f"regions {len(ids)}; fill values {fills}; negative values {neg}; hours per year {hrs}")
