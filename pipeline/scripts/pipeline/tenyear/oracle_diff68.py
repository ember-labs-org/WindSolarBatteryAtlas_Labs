"""T068: attribute every changed regress-oracle row to a named change.

Three oracles of the same keys:
  old  - T067's (task/T068 before the rebuild: 2024 weather, flat solar, 2024 k, 25-year wind life)
  mid  - recorded on the T068 data with the wind life set back to 25 years (~/wind-atlas-T068/rec25)
  new  - recorded on the T068 tree (T068 data, 30-year wind life)
A row that differs old -> mid is the data rebuild (R: T066 solar, k on the ten-year mean,
ten-year view, cyclic large start); mid -> new is the 30-year wind life (W, D-146). A row
changed by neither is unchanged; there is no third cause, so 'unexplained' must be 0.

  python3 -I oracle_diff68.py <old oracle.json> <mid oracle.json> <new oracle.json>
"""
import json
import sys

old, mid, new = (json.load(open(p)) for p in sys.argv[1:4])
print("| Oracle key | Rows | Changed | R data rebuild | W wind life 30 y | both | Unexplained |")
print("|---|---|---|---|---|---|---|")
tot_un = 0
for k in new:
    if not isinstance(new[k], list):
        continue
    o = dict(r.split("|", 1) for r in old.get(k, []))
    m = dict(r.split("|", 1) for r in mid.get(k, []))
    n = dict(r.split("|", 1) for r in new[k])
    ids = set(o) | set(m) | set(n)
    ch = [i for i in ids if o.get(i) != n.get(i)]
    r = {i for i in ids if o.get(i) != m.get(i)}
    w = {i for i in ids if m.get(i) != n.get(i)}
    un = [i for i in ch if i not in r and i not in w]
    tot_un += len(un)
    print(f"| `{k}` | {len(n)} | {len(ch)} | {len(r & set(ch))} | {len(w & set(ch))} | {len(r & w & set(ch))} | {len(un)} |")
print(f"\nunexplained rows in all keys: {tot_un}")
