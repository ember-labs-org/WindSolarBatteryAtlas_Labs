"""T068: worst-year capacity factor per region and build, for the app's tooltip (D-142).

Reads the per-year detail that assemble.py --detail writes (per_year_{dense,wind_mix,large}.parquet:
location_id, config, cf_<year>..., cf_mean) and writes one gzip file per block of 128 location
ids, <out>/worst/w_<location_id >> 7>.bin (read by deployment/js/worst.js). Little-endian:

  Uint32[6]  magic 0x54535257 ('WRST'), version 1, nLoc, nDense, nMix, nLarge
  Int32[nLoc]   location ids, ascending
  Uint8[nLoc]   flags (bit 0: has the wind_mix add-on, bit 1: has the large add-on), zero-padded to 4 bytes
  Uint8[nRows]  high byte of worst_e4, then Uint8[nRows] low byte, then Uint8[nRows] worst year - 2015

Rows run location by location: the nDense dense configs (index i in configs.json), then nMix
wind_mix configs (j in addon.json) if flagged, then nLarge large configs if flagged.
worst_e4 = round(min over years of that calendar year's CF x 1e4); the year is the first year at
the minimum. Only regions in the app's summary_w0.parquet are kept.

  python3 -I worst.py --detail <dir with per_year_*.parquet> --data <deployment data dir> --out <dir>
"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

SETS = ("dense", "wind_mix", "large")
BLOCK_SHIFT = 7
Y0 = 2015
MAGIC = 0x54535257


def load(detail: Path, name: str, dep: np.ndarray, n_cfg: int):
    """{location_id: (e4 uint16 [n_cfg], year uint8 [n_cfg])} for one set."""
    t = pq.read_table(detail / f"per_year_{name}.parquet")
    ycols = sorted(c for c in t.column_names if c.startswith("cf_") and c[3:].isdigit())
    assert ycols[0] == f"cf_{Y0}" and len(ycols) >= 1, ycols
    loc = t["location_id"].to_numpy()
    cfg = t["config"].to_numpy()
    keep = np.isin(loc, dep)
    y = np.stack([t[c].to_numpy() for c in ycols], axis=1)[keep]
    loc, cfg = loc[keep], cfg[keep]
    arg = np.argmin(y, axis=1)
    e4 = np.rint(np.clip(y[np.arange(len(y)), arg].astype("float64"), 0, 1) * 1e4).astype("uint16")
    order = np.lexsort((cfg, loc))
    loc, cfg, e4, arg = loc[order], cfg[order], e4[order], arg[order].astype("uint8")
    ul, start = np.unique(loc, return_index=True)
    out = {}
    for k, l in enumerate(ul):
        s = slice(start[k], start[k + 1] if k + 1 < len(ul) else len(loc))
        assert np.array_equal(cfg[s], np.arange(n_cfg)), f"{name}: region {l} lacks a full config set"
        out[int(l)] = (e4[s], arg[s])
    print(f"{name}: {len(ul)} regions x {n_cfg} configs, {len(ycols)} years", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--detail", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    dep = np.unique(pq.read_table(a.data / "summary_w0.parquet", columns=["location_id"]).column(0).to_numpy())
    n = {"dense": len(json.loads((a.data / "configs.json").read_text())["configs"])}
    for s in json.loads((a.data / "addon.json").read_text())["sets"]:
        n[s["id"]] = len(s["configs"])
    sets = {name: load(a.detail, name, dep, n[name]) for name in SETS}
    assert set(sets["dense"]) == set(int(x) for x in dep), "dense detail must cover every app region"
    d = a.out / "worst"
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    total, files, rows_all = 0, 0, 0
    for b in np.unique(dep >> BLOCK_SHIFT):
        locs = dep[(dep >> BLOCK_SHIFT) == b].astype("int32")
        flags = np.array([(1 if int(l) in sets["wind_mix"] else 0) | (2 if int(l) in sets["large"] else 0)
                          for l in locs], dtype="uint8")
        e4, yr = [], []
        for l, f in zip(locs, flags):
            for name, bit in (("dense", 0), ("wind_mix", 1), ("large", 2)):
                if name == "dense" or f & bit:
                    e4.append(sets[name][int(l)][0]); yr.append(sets[name][int(l)][1])
        e4 = np.concatenate(e4); yr = np.concatenate(yr)
        pad = (-len(locs)) % 4
        body = (np.array([MAGIC, 1, len(locs), n["dense"], n["wind_mix"], n["large"]], dtype="<u4").tobytes()
                + locs.astype("<i4").tobytes() + flags.tobytes() + bytes(pad)
                + (e4 >> 8).astype("u1").tobytes() + (e4 & 255).astype("u1").tobytes() + yr.tobytes())
        p = d / f"w_{int(b)}.bin"
        p.write_bytes(gzip.compress(body, compresslevel=9, mtime=0))
        total += p.stat().st_size; files += 1; rows_all += len(e4)
    print(f"worst: {rows_all} rows, {len(dep)} regions in {files} files, {total/1e6:.1f} MB")


if __name__ == "__main__":
    main()
