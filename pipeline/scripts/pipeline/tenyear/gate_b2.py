"""Gate B2: for builds without a battery the ten-year CF equals the mean of the
ten single-year CFs (no state crosses a year boundary, so it must).

For every battery-0 dense configuration (and the battery-0 wind_mix ones):
  (a) the run's ten-year CF equals the hour-weighted mean of its own per-year CFs;
  (b) each per-year CF equals an independent numpy computation on that year's
      profiles alone: mean over the year of min(1, solar x S + wind x W) in float32
      generation (the kernel's arithmetic), for a sample of configs over all regions;
  (c) the ten-year CF equals the hour-weighted mean of the independent (b) values.
Also reports the plain (unweighted) mean of the ten years against the ten-year CF.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sim10 as S  # noqa: E402

repo = Path(sys.argv[1])
sys.path.insert(0, str(repo / "pipeline"))
from scripts.pipeline.config import build_config_list  # noqa: E402

P = S.ROOT / "work/parts10/dense"
hrs = S.year_hours()
hw = hrs / hrs.sum()
cfgs = [c for c in build_config_list() if c[4] == 0]
worst_a = 0.0
for idx, sf, s, w, b in cfgs:
    z = np.load(P / f"{idx}.npz")
    worst_a = max(worst_a, float(np.abs(z["ycf"].astype("float64") @ hw - z["cf"]).max()))
print(f"(a) {len(cfgs)} battery-0 dense configs: max |ten-year CF - hour-weighted mean of years| = {worst_a:.2e} "
      f"(per-year CFs are stored as float32)")

ids = S.solar_ids()
sample = [c for c in cfgs if (c[0] % 7 == 0) or c[2] in (1, 20) or c[3] in (8,)]
starts = S.year_starts()
worst_b = worst_c = worst_u = 0.0
by_surface = {}
for j, y in enumerate(S.YEARS):
    sol = S.load_solar([y])
    for surface in ("on", "off"):
        wind = S.load_wind(surface, [y])
        for idx, sf, s, w, b in sample:
            if sf != surface:
                continue
            gen = sol * np.float32(s) + wind * np.float32(w)
            ycf = np.minimum(gen.astype("float64"), 1.0).mean(axis=1)
            by_surface.setdefault(idx, np.zeros((len(ids), len(S.YEARS))))[:, j] = ycf
        del wind
    del sol
for idx, arr in by_surface.items():
    z = np.load(P / f"{idx}.npz")
    worst_b = max(worst_b, float(np.abs(arr - z["ycf"]).max()))
    worst_c = max(worst_c, float(np.abs(arr @ hw - z["cf"]).max()))
    worst_u = max(worst_u, float(np.abs(arr.mean(axis=1) - z["cf"]).max()))
print(f"(b) {len(by_surface)} sampled configs x {len(ids)} regions x 10 years: max |kernel year CF - independent| = {worst_b:.2e}")
print(f"(c) max |ten-year CF - hour-weighted mean of independent year CFs| = {worst_c:.2e}")
print(f"    (plain unweighted mean of the ten years differs by at most {worst_u:.2e}: leap years carry 24 h more)")
ok = worst_a < 1e-6 and worst_b < 1e-6 and worst_c < 1e-6
print("GATE B2", "PASS" if ok else "FAIL")
