"""T068: every bound article number (data-n spans in the scrollytelling page), old -> new.

Reads the page's spans at two git revisions (or the working tree) and the two summaries.
  python3 -I number_moves.py <old rev> <out.md>
"""
import json
import re
import subprocess
import sys
from pathlib import Path

rev, out = sys.argv[1], Path(sys.argv[2])
PAGE = "deployment/scrollytelling/classic.html"
SUM = "deployment/scrollytelling/data/article-summary.json"
old_html = subprocess.run(["git", "show", f"{rev}:{PAGE}"], capture_output=True, text=True, check=True).stdout
new_html = Path(PAGE).read_text()
old_v = json.loads(subprocess.run(["git", "show", f"{rev}:{SUM}"], capture_output=True, text=True, check=True).stdout)["values"]
new_v = json.loads(Path(SUM).read_text())["values"]
span = re.compile(r'<span[^>]*\bdata-n="([^"]+)"[^>]*>(.*?)</span>', re.S)
def spans(h):
    return [(k, re.sub(r"<[^>]+>", "", t).strip()) for k, t in span.findall(h)]
so, sn = spans(old_html), spans(new_html)
rows, moved = [], 0
seen = set()
for i, (k, tn) in enumerate(sn):
    to = so[i][1] if i < len(so) and so[i][0] == k else "?"
    ch = to != tn
    moved += ch
    key = (k, to, tn)
    if key in seen:
        continue
    seen.add(key)
    ov, nv = old_v.get(k), new_v.get(k)
    f = lambda v: "–" if v is None else (f"{v:.4g}" if isinstance(v, (int, float)) else str(v))
    rows.append(f"| `{k}` | {to} | {tn} | {f(ov)} | {f(nv)} | {'**moved**' if ch else 'same'} |")
L = [f"# T068 – bound article numbers, old → new",
     "",
     f"Old: `{rev}` (T067 data, 2024 weather). New: this tree (T068 ten-year data, T066 solar, k on the ten-year mean, cyclic large start, 30-year wind life, weak wind on the calibrated level). "
     f"Text as rendered in the page's bound spans after `headline.mjs --apply`; values from `article-summary.json`. "
     f"{len(sn)} bound spans, {moved} with changed text. Prose around them is not changed here (writer).",
     "",
     "| Key | Old text | New text | Old value | New value | |",
     "|---|---|---|---|---|---|"] + rows
out.write_text("\n".join(L) + "\n")
print(f"{len(sn)} spans, {moved} moved; written {out}")
