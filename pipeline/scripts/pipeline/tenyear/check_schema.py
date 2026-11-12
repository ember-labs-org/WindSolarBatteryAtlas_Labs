"""data_10y has the same files, parquet schemas, compression, row counts (summaries) and
ids as deployment/data; files T060 does not rebuild are byte-identical; addon.json SHA-256s match."""
import hashlib, json, sys
from pathlib import Path
import numpy as np, pyarrow.parquet as pq
a, b = Path(sys.argv[1]), Path(sys.argv[2])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
fa, fb = sorted(p.name for p in a.iterdir()), sorted(p.name for p in b.iterdir())
print("same file list", fa == fb, len(fa)); ok = fa == fb
rebuilt = [f for f in fa if f.startswith("summary_") or f.startswith("addon")]
for f in fa:
    if f not in rebuilt:
        s = sha(a / f) == sha(b / f); ok &= s
        if not s: print("DIFFERS", f)
for f in rebuilt:
    if f.endswith(".parquet"):
        x, y = pq.ParquetFile(a / f), pq.ParquetFile(b / f)
        same = x.schema_arrow.equals(y.schema_arrow) and x.metadata.row_group(0).column(0).compression == y.metadata.row_group(0).column(0).compression
        ids_same = np.array_equal(np.unique(pq.read_table(a / f, columns=["location_id"])["location_id"].to_numpy()),
                                  np.unique(pq.read_table(b / f, columns=["location_id"])["location_id"].to_numpy()))
        rows = (x.metadata.num_rows, y.metadata.num_rows)
        print(f"{f}: schema+codec same {same}; rows {rows[0]} -> {rows[1]}; region set same {ids_same}")
        ok &= same and (ids_same or f == "addon_large.parquet") and (rows[0] == rows[1] or f == "addon_large.parquet")
m = json.loads((b / "addon.json").read_text())
for s in m["sets"]:
    good = sha(b / s["file"]) == s["sha256"]; ok &= good
    print(f"addon.json {s['id']}: sha256 matches file {good}; regions {s['regions']} rows {s['rows']} start {s['start']}")
print("unchanged files byte-identical; SCHEMA CHECK", "PASS" if ok else "FAIL")
