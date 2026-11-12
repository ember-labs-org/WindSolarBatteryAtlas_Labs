"""T068 gate: the assembled data folder against the input (post-T067) data folder.

- every non-weather file byte-identical; the files the rebuild writes are listed;
- rebuilt parquet files: same columns, dtypes and compression; summaries keep row counts
  and region ids; add-on SHA-256s match addon.json;
- voronoi_wind_resource.csv: only the eight k-diagnostic columns differ;
- worst/: one block per 128 ids covering every app region.

  python3 -I check68.py <data_in> <data_final>
"""
import csv
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

a, b = Path(sys.argv[1]), Path(sys.argv[2])
REBUILT_PREFIX = ("summary_", "addon")
REBUILT = {"daily_cf_2024.parquet", "voronoi_wind_resource.csv"}
KDIAG = {f"{t}_{c}" for t in ("on", "off") for c in ("k", "raw_cf", "final_cf", "clamped")}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
ok = True
fa = sorted(p.name for p in a.iterdir() if p.is_file())
fb = sorted(p.name for p in b.iterdir() if p.is_file())
print("same file list", fa == fb, len(fb)); ok &= fa == fb
for f in fa:
    rebuilt = f.startswith(REBUILT_PREFIX) or f in REBUILT
    same = (a / f).read_bytes() == (b / f).read_bytes()
    if not rebuilt:
        print(f"{'identical' if same else 'DIFFERS  '} {f}"); ok &= same
        continue
    if f.endswith(".parquet"):
        ma, mb = pq.ParquetFile(a / f), pq.ParquetFile(b / f)
        sa, sb = ma.schema_arrow, mb.schema_arrow
        ca = ma.metadata.row_group(0).column(0).compression; cb = mb.metadata.row_group(0).column(0).compression
        msg = f"rebuilt   {f}: schema {'same' if sa == sb else 'DIFFERS'}, compression {ca}/{cb}, rows {ma.metadata.num_rows} -> {mb.metadata.num_rows}"
        good = sa == sb and ca == cb
        if f.startswith("summary_") or f.startswith("daily"):
            ia = np.unique(pq.read_table(a / f, columns=["location_id"]).column(0).to_numpy())
            ib = np.unique(pq.read_table(b / f, columns=["location_id"]).column(0).to_numpy())
            good &= ma.metadata.num_rows == mb.metadata.num_rows and np.array_equal(ia, ib)
            msg += f", ids {'same' if np.array_equal(ia, ib) else 'DIFFER'}"
        print(msg); ok &= good
    elif f == "voronoi_wind_resource.csv":
        ra = list(csv.reader(open(a / f))); rb = list(csv.reader(open(b / f)))
        good = ra[0] == rb[0] and len(ra) == len(rb)
        cols = set()
        for x, y in zip(ra[1:], rb[1:]):
            for h, p, q in zip(ra[0], x, y):
                if p != q: cols.add(h)
        print(f"rebuilt   {f}: columns changed {sorted(cols)}"); ok &= good and cols <= KDIAG
    elif f == "addon.json":
        m = json.loads((b / f).read_text())
        for s in m["sets"]:
            g = sha(b / s["file"]) == s["sha256"]
            print(f"rebuilt   addon.json set {s['id']}: sha {'matches' if g else 'MISMATCH'}, start {s.get('start')}, regions {s['regions']}"); ok &= g
w = b / "worst"
ids = np.unique(pq.read_table(b / "summary_w0.parquet", columns=["location_id"]).column(0).to_numpy())
need = set((ids >> 7).tolist()); have = {int(p.stem[2:]) for p in w.glob("w_*.bin")} if w.exists() else set()
print(f"worst blocks {len(have)}, needed {len(need)}, total {sum(p.stat().st_size for p in w.glob('*.bin'))/1e6:.1f} MB")
ok &= have == need
print("CHECK68", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
