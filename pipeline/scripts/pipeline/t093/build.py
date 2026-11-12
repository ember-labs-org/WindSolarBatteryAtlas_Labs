"""T093: per-region solar/wind droughts and complementarity for the tool's Complementarity tab.

Input: T088's daily series, <daily>/daily.npz (pipeline/scripts/pipeline/t088/daily.py): daily mean
capacity factor 2015-2024 (3,650 UTC days, 29 Feb dropped) for solar and onshore wind.
Regions and definitions follow T088 (team/handoffs/T088.md, analyse.py) so the tool and the article agree:
  regions   an onshore profile with a ten-year mean CF of at least 2%, and solar above 0
  drought   W-day trailing mean below 50% of the source's own ten-year mean; share of all W-day windows
            W = 7 (week, as T088 and the article) and W = 30 (month, the human's choice 6 Nov 2026)
  both      both sources in drought in the same window
Complementarity (the human, 6 Nov 2026): (1 - r) / 2 with r the Pearson correlation of the raw capacity
factors (seasons included), at three levels: daily values; non-overlapping 7-day means (521 weeks);
calendar-month means (120 months). 1 = perfectly anti-correlated, 0.5 = unrelated, 0 = move together.

Writes deployment/data/complementarity.csv (location_id plus nine columns, 4 decimals).

  python3 -I build.py --daily ~/wind-atlas-T088/out --out <worktree>/deployment/data/complementarity.csv
"""
import argparse
from pathlib import Path

import numpy as np

NDAY = 3650
MONTH_DAYS = np.array([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])


def wmeans(x, w):
    """trailing W-day means along axis 1 (float64 cumsum), as T088 analyse.py."""
    c = np.concatenate([np.zeros((x.shape[0], 1)), np.cumsum(x, axis=1, dtype=np.float64)], axis=1)
    return (c[:, w:] - c[:, :-w]) / w


def rowcorr(a, b):
    a = a - a.mean(1, keepdims=True)
    b = b - b.mean(1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        return (a * b).sum(1) / np.sqrt((a * a).sum(1) * (b * b).sum(1))


def weeks(x):
    n = x.shape[1] // 7 * 7
    return x[:, :n].reshape(x.shape[0], -1, 7).mean(2)


def months(x):
    edges = np.concatenate([[0], np.cumsum(np.tile(MONTH_DAYS, NDAY // 365))])
    return np.stack([x[:, edges[i]:edges[i + 1]].mean(1) for i in range(len(edges) - 1)], axis=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    D = np.load(a.daily / "daily.npz")
    s_pos = {int(r): i for i, r in enumerate(D["solar_ids"])}
    ids = np.array([int(r) for r in D["on_rows"] if int(r) in s_pos])
    on_pos = {int(r): i for i, r in enumerate(D["on_rows"])}
    S = D["solar"][[s_pos[i] for i in ids]].astype(np.float64)
    W = D["on"][[on_pos[i] for i in ids]].astype(np.float64)
    assert S.shape[1] == NDAY and W.shape[1] == NDAY
    keep = (W.mean(1) >= 0.02) & (S.mean(1) > 0)
    ids, S, W = ids[keep], S[keep], W[keep]
    order = np.argsort(ids)
    ids, S, W = ids[order], S[order], W[order]
    s1, w1 = S / S.mean(1, keepdims=True), W / W.mean(1, keepdims=True)
    cols = {}
    for tag, w in (("wk", 7), ("mo", 30)):
        ds, dw = wmeans(s1, w) < 0.5, wmeans(w1, w) < 0.5
        cols[f"{tag}_solar"], cols[f"{tag}_wind"], cols[f"{tag}_both"] = ds.mean(1), dw.mean(1), (ds & dw).mean(1)
    for tag, f in (("day", lambda x: x), ("week", weeks), ("month", months)):
        cols[f"c_{tag}"] = (1 - rowcorr(f(S), f(W))) / 2
    for k, v in cols.items():
        assert np.isfinite(v).all(), k
    names = list(cols)
    with open(a.out, "w", newline="\n") as fh:
        fh.write("# source: T093 pipeline/scripts/pipeline/t093/build.py from T088 daily.npz (2015-2024 daily CF, "
                 "solar and onshore wind); drought = trailing 7- or 30-day mean below 50% of the ten-year mean; "
                 "complementarity = (1 - Pearson r of raw CF) / 2 on daily, weekly and calendar-month means\n")
        fh.write("location_id," + ",".join(names) + "\n")
        for i, lid in enumerate(ids):
            fh.write(f"{lid}," + ",".join(f"{cols[k][i]:.4f}" for k in names) + "\n")
    print(f"{len(ids)} regions written to {a.out}")
    for k in names:
        v = cols[k]
        print(f"  {k:9s} p10 {np.percentile(v, 10):.3f}  median {np.median(v):.3f}  p90 {np.percentile(v, 90):.3f}  max {v.max():.3f}")


if __name__ == "__main__":
    main()
