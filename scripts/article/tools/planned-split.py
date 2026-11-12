#!/usr/bin/env python3
"""planned-split.py – planned coal and planned gas per region, in the summary's region order, for the charts-only
article's section 6 histogram (T091 round 6, the human: "a version of the histogram chart from the tool": planned coal
and gas by the cost of 90% solar, wind and batteries with gas backup for the rest).

story-cells.json carries only their sum ('planned', build_story_cells.py: GEM announced coal + oil and gas, GW). This
writes the two parts from the same file (deployment/data/voronoi_gem_capacity.csv) and checks that they add up to it,
region by region, and to the summary's s6.planned.coal.gw and s6.planned.gas.gw.

usage (repo root): python3 scripts/article/tools/planned-split.py [--check]
"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SC = ROOT / 'deployment/scrollytelling/data'
OUT = SC / 'story-planned.json'
summary = json.loads((SC / 'article-summary.json').read_text())
cells = json.loads((SC / 'story-cells.json').read_text())

ids, x = [], 0
for d in summary['cells']['idDelta']:
    x += d
    ids.append(x)
gem = {}
with open(ROOT / 'deployment/data/voronoi_gem_capacity.csv') as f:
    for r in csv.DictReader(f):
        gem[int(r['location_id'])] = (float(r['coal_Announced'] or 0) / 1000, float(r['oil_gas_Announced'] or 0) / 1000)
coal = [round(gem.get(i, (0, 0))[0], 3) for i in ids]
gas = [round(gem.get(i, (0, 0))[1], 3) for i in ids]

bad = [k for k, (c, g, p) in enumerate(zip(coal, gas, cells['planned'])) if abs(c + g - p) > 0.002]
V = summary['values']
tot = {'s6.planned.coal.gw': sum(coal), 's6.planned.gas.gw': sum(gas)}
off = {k: (v, V[k]) for k, v in tot.items() if abs(v - V[k]) > 0.05}
if bad or off or len(ids) != cells['n']:
    raise SystemExit(f'planned split does not match: {len(bad)} regions off story-cells planned; totals {off}; n {len(ids)} vs {cells["n"]}')
doc = {'source': 'scripts/article/tools/planned-split.py from deployment/data/voronoi_gem_capacity.csv (GEM announced coal; oil and gas), GW, summary cell order',
       'n': len(ids), 'coal': coal, 'gas': gas}
text = json.dumps(doc, separators=(',', ':'))
if '--check' in sys.argv:
    ok = OUT.exists() and OUT.read_text() == text
    print('story-planned.json is current' if ok else 'story-planned.json differs from the data')
    raise SystemExit(0 if ok else 1)
OUT.write_text(text)
print(f'wrote {OUT.relative_to(ROOT)}: {len(ids)} regions, coal {sum(coal):.1f} GW, gas {sum(gas):.1f} GW')
