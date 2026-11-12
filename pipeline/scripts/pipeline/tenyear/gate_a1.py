"""Gate A1: the year-parameterised wind builder reproduces the shipped 2024 profiles.

Shipped = the T059 harness output (the profiles behind deployment/data):
<T059 run>/ws/input_data/wind_profiles_{on,off}.parquet, 4,998 regions x 8,784 h.
"""
import os
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
ship_dir = Path(sys.argv[1])
ok = True
for tag in ("on", "off"):
    t = pq.read_table(ship_dir / f"wind_profiles_{tag}.parquet")
    loc = t["location_id"].to_numpy(); hi = t["hour_index"].to_numpy(); v = t["kwh_per_kw"].to_numpy()
    o = np.lexsort((hi, loc))
    ids = np.unique(loc)
    ship = v[o].reshape(len(ids), 8784)
    rows = np.load(ROOT / f"work/wind/{tag}_rows.npy")
    mine = np.zeros_like(ship)
    mine[np.searchsorted(ids, rows)] = np.load(ROOT / f"work/wind/{tag}_2024.npy")
    eq = np.array_equal(ship, mine)
    d = np.abs(ship.astype("float64") - mine).max()
    nz = int((ship.max(axis=1) > 0).sum())
    print(f"{tag}: regions {len(ids)}, with profile shipped {nz} / rebuilt {len(rows)}; "
          f"bit-identical {eq}; max |diff| {d:.3g}; mean CF {ship.mean():.6f} vs {mine.mean():.6f}")
    ok &= eq or d <= 1e-7
print("GATE A1", "PASS" if ok else "FAIL")
