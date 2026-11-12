#!/usr/bin/env python3
"""refresh-classic.py – rewrites the static text of every bound number in scrollytelling/classic.html from the summary.

classic.html is the previous article (unlinked, still checked by verify-article). Its numbers are <span data-n data-f>
whose static text must read as the summary's value; the page rewrites them on load (article.js bindNumbers), and the
check fails on any that differ. When the summary changes (T091: the article moved to one 7% cost of capital), this
brings the static text in line, with the formats of js/format.js. Words around the numbers are not touched: the
number-word checks in verify-article still decide whether they hold.

usage (repo root): python3 scripts/article/tools/refresh-classic.py [--check]
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PAGE = ROOT / 'deployment/scrollytelling/classic.html'
V = json.loads((ROOT / 'deployment/scrollytelling/data/article-summary.json').read_text())['values']
rnd = lambda x: math.floor(x + 0.5)            # JS Math.round
nf = lambda x: f'{rnd(x):,}'
FMT = {                                         # js/format.js FORMATS
    'pct': lambda v: f'{rnd(v * 100)}%', 'pctnum': lambda v: f'{rnd(v * 100)}', 'pct1': lambda v: f'{rnd(v * 1000) / 10:.1f}%',
    'usd': lambda v: f'${nf(v)}', 'int': nf, 'floor': lambda v: f'{math.floor(v):,}', 'pwh': lambda v: nf(v / 1000),
    'r10': lambda v: f'{rnd(v / 10) * 10:,}', 'd1': lambda v: f'{rnd(v * 10) / 10:.1f}', 'pts': lambda v: f'{v * 100:.2f}',
    'corr': lambda v: f'{"−" if v < 0 else ""}{abs(v):.2f}', 'x2': lambda v: f'{v:.2f}×'}
html = PAGE.read_text()
changed = []


def fix(m):
    key, f, text = m.group(2), m.group(3), m.group(5)
    if key not in V or f not in FMT:
        return m.group(0)
    want = FMT[f](V[key])
    if want != text.strip():
        changed.append((key, text.strip(), want))
    return m.group(1) + want + m.group(6)


out = re.sub(r'(<span\b[^>]*?data-n="([^"]+)"[^>]*?data-f="([^"]+)"([^>]*)>)([^<]*)(</span>)', fix, html)
if '--check' in sys.argv:
    print(f'{len(changed)} bound numbers in classic.html differ from the summary')
    raise SystemExit(1 if changed else 0)
PAGE.write_text(out)
for k, a, b in changed:
    print(f'  {k}: {a} -> {b}')
print(f'refreshed {len(changed)} bound numbers in {PAGE.relative_to(ROOT)}')
