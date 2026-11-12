"""T067: compare the new siting rows with T061's, line by line, against the
expectations; write the moved-site list for the ERA5 fetches.

  python3 -I check_site.py <old resource csv> <new resource csv> <expected csv> <out dir>
"""
import csv
import sys
from pathlib import Path

old_p, new_p, exp_p, out = map(Path, sys.argv[1:5])
# The siting step writes the first columns; the profiles step appends k/raw/final/clamped.
# Compare the columns both files have, as text (byte-identical fields).
hdr_o, hdr_n = old_p.read_text().splitlines()[0], new_p.read_text().splitlines()[0]
n_common = min(len(hdr_o.split(",")), len(hdr_n.split(",")))
assert hdr_o.split(",")[:n_common] == hdr_n.split(",")[:n_common]
cut = lambda l: ",".join(l.split(",")[:n_common])
old = {l.split(",", 1)[0]: cut(l) for l in old_p.read_text().splitlines()[1:]}
new = {l.split(",", 1)[0]: cut(l) for l in new_p.read_text().splitlines()[1:]}
hdr_n = ",".join(hdr_n.split(",")[:n_common])
assert old.keys() == new.keys()
exp = {r["location_id"]: r for r in csv.DictReader(open(exp_p))}
changed = sorted((k for k in new if new[k] != old[k]), key=int)
unexpected = [k for k in changed if k not in exp]
cols = hdr_n.split(",")
moved = []
for k in changed:
    o = dict(zip(cols, next(csv.reader([old[k]]))))
    n = dict(zip(cols, next(csv.reader([new[k]]))))
    for t in ("on", "off"):
        if (o[f"{t}_site_lat"], o[f"{t}_site_lon"]) != (n[f"{t}_site_lat"], n[f"{t}_site_lon"]):
            moved.append({"location_id": k, "technology": "onshore" if t == "on" else "offshore",
                          "old_lat": o[f"{t}_site_lat"], "old_lon": o[f"{t}_site_lon"],
                          "new_lat": n[f"{t}_site_lat"], "new_lon": n[f"{t}_site_lon"],
                          "old_viable": o[f"{t}_viable"], "new_viable": n[f"{t}_viable"],
                          "excluded": exp[k]["excluded"] if k in exp else ""})
with open(out / "moved_sites.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(moved[0].keys()), lineterminator="\n")
    w.writeheader(); w.writerows(moved)
lines = [f"rows {len(new)}; changed {len(changed)}; predicted {len(exp)}; changed but not predicted {len(unexpected)} {unexpected[:10]}",
         f"predicted but unchanged: {len(set(exp) - set(changed))}",
         f"moved sites: onshore {sum(m['technology']=='onshore' for m in moved)}, offshore {sum(m['technology']=='offshore' for m in moved)} "
         f"(deployed: onshore {sum(m['technology']=='onshore' and m['excluded']=='0' for m in moved)}, "
         f"offshore {sum(m['technology']=='offshore' and m['excluded']=='0' for m in moved)})",
         f"identical rows: {len(new) - len(changed)}"]
(out / "check_site.txt").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
if unexpected:
    sys.exit("FAIL: rows changed outside the prediction")
