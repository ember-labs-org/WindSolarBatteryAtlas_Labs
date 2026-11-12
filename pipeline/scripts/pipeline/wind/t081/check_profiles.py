"""T081: the rebuilt onshore profiles differ from T068's exactly in the quantile-mapped rows.

  python3 -I check_profiles.py <T081 work/wind> <T068 work/wind>
Per year: rows with on_method == scalar are bit-identical to T068; qm rows differ; ten-year mean of
every qm row equals its target (< 1e-6); offshore files are the T068 files.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

new, old = Path(sys.argv[1]), Path(sys.argv[2])
rows = np.load(new / "on_rows.npy")
assert np.array_equal(rows, np.load(old / "on_rows.npy"))
d = pd.read_csv(new / "t081_diag.csv", keep_default_na=False).set_index("location_id").loc[rows]
qm = (d.on_method == "qm").to_numpy()
ok = True
tot = np.zeros(len(rows)); hrs = 0
for y in range(2015, 2025):
    a, b = np.load(new / f"on_{y}.npy"), np.load(old / f"on_{y}.npy")
    same = (a == b).all(axis=1)
    good = same[~qm].all() and not same[qm].any()
    print(y, f"scalar rows identical {same[~qm].sum()}/{(~qm).sum()}, qm rows changed {(~same[qm]).sum()}/{qm.sum()}")
    ok &= bool(good)
    tot += a.astype("float64").sum(axis=1); hrs += a.shape[1]
for f in sorted(old.glob("off_*.npy")) + [old / "k_off.npz"]:
    s = (new / f.name).resolve() == f.resolve() or (new / f.name).read_bytes() == f.read_bytes()
    ok &= s
print("offshore files are T068's:", ok)
fc = pd.to_numeric(d.on_final_cf).to_numpy()
err = np.abs(tot / hrs - fc)
print(f"ten-year mean vs diag final_cf: max |err| {err.max():.2e}")
print("PROFILE CHECK", "PASS" if ok else "FAIL")
