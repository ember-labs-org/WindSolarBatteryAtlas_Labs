"""Sensitivity: the ten-year large builds started warm instead of empty.

Re-runs every large configuration on the continuous 2015-2024 series starting
from the charge the cold run ended 2024 with (as if 2014 had ended like 2024),
one pass. Writes work/parts10w/large/<j>.npz (wind_mix linked from parts10) for
assemble.py, so a full data folder can be made and searched like the real one.
  python3 -I large_warm.py
"""
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run10 as R  # noqa: E402
import sim10 as S  # noqa: E402

src = S.ROOT / "work/parts10/large"
dst = S.ROOT / "work/parts10w/large"
dst.mkdir(parents=True, exist_ok=True)
mix = S.ROOT / "work/parts10w/wind_mix"
if not mix.exists():
    mix.symlink_to(S.ROOT / "work/parts10/wind_mix")
ids = S.solar_ids()
z0 = np.load(src / "0.npz")
sel = z0["location_id"]
rows = np.searchsorted(ids, sel)
sol = S.load_solar(S.YEARS, rows)
zero = np.zeros_like(sol)
ys = S.year_starts()
t0 = time.time()
for c in R.large_configs():
    p = dst / f"{c['j']}.npz"
    if p.exists():
        continue
    z = np.load(src / f"{c['j']}.npz")
    cf, curt, ycf, end = S.run(sol, zero, c["solar"], 0.0, c["batt"], ys, z["end_soc"].astype("float64"))
    R.save(p, sel, cf, curt, ycf, {"end_soc": end, "start_soc": z["end_soc"]})
print(f"warm large set done in {time.time() - t0:.0f} s")
