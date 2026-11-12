#!/usr/bin/env python3
"""build_backup95.py – the cost of power every hour with backup from 95% uptime, per region, for the charts-only
article's section 6 histogram (T091 round 6, the human: "a 95% uptime version").

Reads run_backup95.mjs's runs (the atlas model, 2026 costs, the article's cost mode: solar, wind and batteries for the
target uptime, the app's diesel or gas backup for the rest) and writes deployment/scrollytelling/data/story-backup95.json:
the cheapest cost per region from 95%, in the summary's region order (null where the target is not met).

Control: the run's 90% costs must equal story-cells.json c100 (the article's own backup costs, from t087/run_story.mjs)
to 0.01 $/MWh, region by region, or nothing is written.

usage (repo root): python3 scripts/article/analysis/t091/build_backup95.py RUNS.json [--check]
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SC = ROOT / 'deployment/scrollytelling/data'
OUT = SC / 'story-backup95.json'
R = json.loads(Path(sys.argv[1]).read_text())
summary = json.loads((SC / 'article-summary.json').read_text())
cells = json.loads((SC / 'story-cells.json').read_text())
ids, x = [], 0
for d in summary['cells']['idDelta']:
    x += d
    ids.append(x)


def best(key):
    r = R['runs'][key]
    pos = {lid: i for i, lid in enumerate(r['location_id'])}
    out = []
    for i in ids:
        j = pos.get(i)
        ok = j is not None and r['meetsTarget'][j] and r['lcoe'][j] is not None and math.isfinite(r['lcoe'][j])
        out.append(round(r['lcoe'][j], 2) if ok else None)
    return out


c90, c95 = best('all_bk_90'), best('all_bk_95')
off = [k for k, (a, b) in enumerate(zip(c90, cells['c100'])) if (a is None) != (b is None) or (a is not None and abs(a - b) > 0.01)]
if off:
    raise SystemExit(f'control failed: {len(off)} regions where the 90% backup cost differs from story-cells c100, e.g. {[(k, c90[k], cells["c100"][k]) for k in off[:5]]}')
gaps = sum(p for p, c in zip(cells['planned'], c95) if p > 0 and c is None)
doc = {'source': 'scripts/article/analysis/t091/run_backup95.mjs + build_backup95.py: cheapest build for 95% uptime from solar, wind and batteries, '
                 'diesel or gas backup for the rest, 2026 costs, the article cost mode; $/MWh, summary cell order',
       'n': len(ids), 'c95': c95}
text = json.dumps(doc, separators=(',', ':'))
print(f'control: 90% backup costs equal story-cells c100 in all {len(ids)} regions; planned GW with no 95% cost: {gaps:.3f}')
if '--check' in sys.argv:
    ok = OUT.exists() and OUT.read_text() == text
    print('story-backup95.json is current' if ok else 'story-backup95.json differs from the runs')
    raise SystemExit(0 if ok else 1)
OUT.write_text(text)
print(f'wrote {OUT.relative_to(ROOT)}')
