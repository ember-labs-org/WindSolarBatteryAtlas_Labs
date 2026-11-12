"""T081: the app's voronoi_wind_resource.csv from the T081 siting run and profile diagnostics.

Rows and column order are the deployed file's (excluded regions stay dropped). Siting columns
take the T081 siting run's text; onshore k diagnostics come from build_wind_t081.py's
t081_diag.csv (%.6f, as before); the offshore k diagnostics keep the deployed text. New columns
are appended: on_class_rule, on_site_v50, on_market, on_rated_kw, on_rotor_m, on_hub_m,
on_method, on_qm_trim. Asserts every offshore cell keeps its exact text.

  python3 -I resource_out.py --deployed <csv> --site <csv> --diag <csv> --rows <on_rows.npy> --out <csv>
"""
import argparse
import csv
from pathlib import Path

import numpy as np
import pandas as pd

ap = argparse.ArgumentParser()
for k in ("deployed", "site", "diag", "rows", "out"):
    ap.add_argument(f"--{k}", type=Path, required=True)
a = ap.parse_args()


def read(p):
    with open(p, newline="") as f:
        rd = csv.reader(f)
        h = next(rd)
        return h, {int(r[0]): r for r in rd}


dh, dep = read(a.deployed)
sh, site = read(a.site)
assert dh[0] == sh[0] == "location_id"
diag = pd.read_csv(a.diag, keep_default_na=False).set_index("location_id")
have = set(np.load(a.rows).tolist())
kd = {"on_k", "on_raw_cf", "on_final_cf", "on_clamped", "off_k", "off_raw_cf", "off_final_cf", "off_clamped"}
new_cols = [c for c in sh if c not in dh] + ["on_method", "on_qm_trim"]
head = dh + new_cols
si = {c: i for i, c in enumerate(sh)}
out, changed = [], {}
for lid, r in dep.items():
    s = site[lid]
    row = dict(zip(dh, r))
    for c in dh:
        if c in kd:
            continue
        if row[c] != s[si[c]]:
            assert not c.startswith("off_"), (lid, c, row[c], s[si[c]])
            changed[c] = changed.get(c, 0) + 1
            row[c] = s[si[c]]
    for c in new_cols[:-2]:
        row[c] = s[si[c]]
    row["on_method"], row["on_qm_trim"] = "", ""
    if lid in have:
        d = diag.loc[lid]
        for c, v in (("on_k", f"{float(d.on_k):.6f}"), ("on_raw_cf", f"{float(d.on_raw_cf):.6f}"),
                     ("on_final_cf", f"{float(d.on_final_cf):.6f}"), ("on_clamped", str(int(d.on_clamped)))):
            if row[c] != v:
                changed[c] = changed.get(c, 0) + 1
                row[c] = v
        row["on_method"] = d.on_method
        row["on_qm_trim"] = f"{float(d.on_qm_trim):.6f}" if d.on_method == "qm" else ""
    out.append([row[c] for c in head])
with open(a.out, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(head)
    w.writerows(out)
print(f"{a.out.name}: {len(out)} rows; changed cells by column: {changed}; appended {new_cols}")
