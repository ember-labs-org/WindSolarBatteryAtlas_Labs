"""T081 identity proof B: build_wind_t081.py --scalar-only on the T068 resource reproduces T068's
onshore profiles byte for byte (all ten years), its rows and its ten-year k.

  python3 -I identity_b.py <new work/wind dir> <T068 work/wind dir>
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

new, old = Path(sys.argv[1]), Path(sys.argv[2])
ok = True
r1, r0 = np.load(new / "on_rows.npy"), np.load(old / "on_rows.npy")
print("rows identical:", np.array_equal(r1, r0), len(r1)); ok &= np.array_equal(r1, r0)
for y in range(2015, 2025):
    same = (new / f"on_{y}.npy").read_bytes() == (old / f"on_{y}.npy").read_bytes()
    print(y, "byte-identical" if same else "DIFFERS"); ok &= same
k1, k0 = np.load(new / "k_on.npz"), np.load(old / "k_on.npz")
kk = np.array_equal(k1["k"][k1["rows"]], k0["k"][k0["rows"]])
print("k identical:", kk); ok &= kk
d = pd.read_csv(new / "t081_diag.csv").set_index("location_id")
o = pd.read_csv(old / "k10_diag.csv").set_index("location_id").loc[r1]
fc = np.array_equal(d.loc[r1, "on_final_cf"].to_numpy(), o["on_final_cf"].to_numpy())
cl = np.array_equal(d.loc[r1, "on_clamped"].to_numpy(), o["on_clamped"].to_numpy())
print("final_cf identical:", fc, " clamped identical:", cl, " clamped n =", int(d.on_clamped.sum()))
ok &= fc and cl
print("IDENTITY B", "PASS" if ok else "FAIL")
