"""T068: Sample Days daily_cf_2024.parquet from the ten-year pipeline's 2024 matrices.

Runs pipeline/scripts/sample_days/build_daily_cf.py unchanged (its checks, rounding and
writer), with its profile reader swapped for one that reads the run directory's matrices:
  solar  work/solar_2024_u16.npy (uint16 x 1e4, rows in work/solar_ids.npy order)
  wind   work/wind/<on|off>_2024.npy (float32, rows in work/wind/<tag>_rows.npy; others zero)
Then the excluded regions are dropped as apply_exclusion does. Identity proof: on T064's inputs
it must reproduce the shipped daily_cf_2024.parquet byte for byte.

  python3 -I daily_npy.py --repo <wt> --root <run dir> --out <file>
"""
import argparse
import sys
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--repo", type=Path, required=True)
ap.add_argument("--root", type=Path, required=True)
ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
sys.path.insert(0, str(a.repo / "pipeline/scripts/sample_days"))
import build_daily_cf as B  # noqa: E402

ids = np.load(a.root / "work/solar_ids.npy")


def load_matrix(path, time_col):
    name = Path(path).name
    if name == "solar_profiles.parquet":
        m = np.load(a.root / "work/solar_2024_u16.npy").astype(np.float64).T / 1e4
    else:
        tag = "on" if name.endswith("_on.parquet") else "off"
        rows = np.load(a.root / f"work/wind/{tag}_rows.npy")
        w = np.load(a.root / f"work/wind/{tag}_2024.npy")
        m = np.zeros((B.N_HOURS, len(ids)))
        m[:, np.searchsorted(ids, rows)] = w.T.astype(np.float64)
        assert np.array_equal(ids[np.searchsorted(ids, rows)], rows)
    assert m.shape == (B.N_HOURS, len(ids)), m.shape
    return ids, m


B.load_matrix = load_matrix
sys.argv = ["build_daily_cf.py", "--input-dir", str(a.root / "work"), "--out", str(a.out)]
B.main()

# The shipped file has the excluded regions dropped (apply_exclusion's own filter and writer).
sys.path.insert(0, str(a.repo / "pipeline/scripts/exclude_regions"))
import apply_exclusion as AE  # noqa: E402
_, excl_ids, _, _ = AE.load_spec()
n0, dropped = AE.filter_parquet(a.out, excl_ids, daily=True)
print(f"{a.out.name}: {n0} rows, dropped {dropped} (excluded regions)")
