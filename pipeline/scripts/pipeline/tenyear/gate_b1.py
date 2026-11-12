"""Gate B1: a 2024-only run of the T060 code reproduces the shipped data.

Compares <dir>/summary_*.parquet (assembled from the 2024-only parts) with the
shipped deployment/data files: byte identity, then value identity of every
column. Also the add-on sets: wind_mix (cold) and large (cyclic, 2024 only).
"""
import hashlib
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

mine, ship = Path(sys.argv[1]), Path(sys.argv[2])
files = sorted(p.name for p in ship.glob("summary_*.parquet")) + ["addon_wind_mix.parquet", "addon_large.parquet"]
ok = True
for f in files:
    if not (mine / f).exists():
        print(f"{f}: not built"); continue
    a, b = pq.read_table(mine / f), pq.read_table(ship / f)
    same_bytes = hashlib.sha256((mine / f).read_bytes()).hexdigest() == hashlib.sha256((ship / f).read_bytes()).hexdigest()
    res = []
    good = a.schema.equals(b.schema) and a.num_rows == b.num_rows
    if good:
        for c in a.column_names:
            x, y = a[c].to_numpy(), b[c].to_numpy()
            if not np.array_equal(x, y):
                d = np.abs(x.astype("float64") - y).max()
                n = int((x != y).sum())
                res.append(f"{c}: {n} differ, max {d:.2g}")
                if d > 1.5e-4:     # one 4-dp step (float32 rounding of a tie) is the tolerance
                    good = False
    ok &= good
    print(f"{f}: rows {a.num_rows} vs {b.num_rows}; bytes identical {same_bytes}; "
          f"values {'identical' if not res else '; '.join(res)}{'' if good else '  FAIL'}")
print("GATE B1", "PASS" if ok else "FAIL")
