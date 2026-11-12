"""T058 study (d): size of the candidate add-on files, written the way run3d.py
writes the summary slices (zstd 9), from the study outputs in T058_OUT:
  b_cf.npz      -> addon_large.parquet     (rows for regions < 0.99 today)
  <tag>_a_cf.npz -> addon_wind_mix.parquet (all 21 and the lean 9)
Columns: location_id int32, cfg uint16 (add-on config id), annual_cf float32
(4 dp, as the slices), curtailed_share float32 (here a placeholder of the right
type and entropy is not available from the studies, so it is reported both
without it and with the slices' measured bytes/row for that column).
Also reports the in-memory size of the sparse arrays the worker would hold.

  T058_OUT=<scratch>/T058 python3 -I measure_addon.py --tag t059
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from common import OUT, DATA

P_SOLAR = [25, 30, 40, 50, 70, 100]
P_BATT = [48, 72, 96, 144, 192, 288, 384, 576, 768, 1152, 1536, 2304, 3072, 4608]
LEAN9 = [(a, b) for a in (1, 2, 3, 4) for b in (1, 2, 3) if a + b <= 5]


def write(name, loc, cfg, cf):
    order = np.lexsort((loc, cfg))       # by config, then location: one config's rows are contiguous
    t = pa.table({"location_id": pa.array(loc[order].astype("int32")),
                  "cfg": pa.array(cfg[order].astype("uint16")),
                  "annual_cf": pa.array(cf[order].astype("float32"))})
    p = OUT / name
    pq.write_table(t, p, compression="zstd", compression_level=9)
    return p.stat().st_size, len(loc)


def curt_bytes_per_row():
    t = pq.ParquetFile(DATA / "summary_w2.parquet")
    md = t.metadata
    tot = {}
    for rg in range(md.num_row_groups):
        for c in range(md.num_columns):
            col = md.row_group(rg).column(c)
            tot[col.path_in_schema] = tot.get(col.path_in_schema, 0) + col.total_compressed_size
    return tot.get("curtailed_share", 0) / md.num_rows, tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="t059")
    ap.add_argument("--large-max", type=float, default=0.99)
    args = ap.parse_args()
    cb, cols = curt_bytes_per_row()
    print(f"summary_w2 compressed bytes/row by column: " +
          ", ".join(f"{k} {v / 1.04e6:.2f}" for k, v in cols.items()))

    b = np.load(OUT / "b_cf.npz")
    ids, solar, batt, cold = b["ids"], list(b["solar"]), list(b["batt"]), b["cold"]
    import common as C
    w0 = C.summary("summary_w0.parquet")
    mx = w0.groupby("location_id").annual_cf.max().loc[ids].values
    for thr in (0.99, 0.995, 0.999):
        keep = mx < thr
        loc, cfg, cf = [], [], []
        j = 0
        for s in P_SOLAR:
            for bb in P_BATT:
                v = cold[solar.index(s), batt.index(bb)][keep]
                loc.append(ids[keep]); cfg.append(np.full(keep.sum(), j)); cf.append(v)
                j += 1
        size, rows = write(f"addon_large_lt{thr}.parquet", np.concatenate(loc), np.concatenate(cfg), np.concatenate(cf))
        print(f"large builds, regions < {thr} today ({keep.sum()}): {rows} rows, {size/1e6:.2f} MB "
              f"(+ curtailed_share ~{rows*cb/1e6:.2f} MB); in memory {rows*6/1e6:.1f} MB (uint16 cfg + float32 cf)")

    a_path = OUT / f"{args.tag}_a_cf.npz"
    if a_path.exists():
        a = np.load(a_path)
        ids, combos, cf = a["ids"], [tuple(x) for x in a["combos"]], a["cf"]
        for name, sel in (("all 21", combos), ("lean 9", LEAN9)):
            loc, cfg, vals = [], [], []
            j = 0
            for c in sel:
                ci = combos.index(c)
                for si in range(cf.shape[1]):
                    for bi in range(cf.shape[2]):
                        loc.append(ids); cfg.append(np.full(len(ids), j)); vals.append(cf[ci, si, bi]); j += 1
            size, rows = write(f"addon_wind_{name.replace(' ', '')}.parquet", np.concatenate(loc),
                               np.concatenate(cfg), np.concatenate(vals))
            print(f"wind combinations, {name} ({len(ids)} regions): {rows} rows, {size/1e6:.2f} MB "
                  f"(+ curtailed_share ~{rows*cb/1e6:.2f} MB); in memory {rows*6/1e6:.1f} MB")
    else:
        print(f"{a_path.name} not found: run study_a first")
    total = sum(p.stat().st_size for p in DATA.glob("summary_*.parquet"))
    print(f"today: 15 summary slices {total/1e6:.1f} MB; matrix in the worker 4,998 x 3,216 float32 = "
          f"{4998*3216*4/1e6:.0f} MB")


if __name__ == "__main__":
    main()
