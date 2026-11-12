#!/usr/bin/env python3
"""charts-artifact.py – packages scrollytelling/charts.html as a self-contained folder for a claude.ai page (T091).

The page and every file it loads go into OUT at the paths the page uses. Files the site serves from outside
scrollytelling/ (../../js/constants.js, ../../data/world.geojson) are copied into the folder and their imports
rewritten to point there, because a claude.ai page has no parent folder. The page itself loses its document wrapper
(the host adds one). Nothing else changes: the same text, numbers, charts and maps as charts.html.

usage (repo root): python3 scripts/article/tools/charts-artifact.py OUT_DIR
Then publish OUT_DIR/harnessing-the-winds.html with root OUT_DIR and every other file in OUT_DIR as `files`.
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SITE = ROOT / 'deployment'
ART = SITE / 'scrollytelling'
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)

# The page, unwrapped
html = (ART / 'charts.html').read_text()
head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
body = re.search(r'<body[^>]*>(.*?)</body>', html, re.S).group(1)
title = re.search(r'<title>.*?</title>', head).group(0).replace(' | Solar + Wind + Battery Atlas', '')
meta = re.search(r'<meta name="description"[^>]*>', head).group(0)
links = '\n'.join(re.findall(r'<link rel="stylesheet"[^>]*>', head))
(OUT / 'harnessing-the-winds.html').write_text(
    f'{title}\n{meta}\n<!-- Packaged from deployment/scrollytelling/charts.html by scripts/article/tools/charts-artifact.py (T091); '
    f'light-only by design (Ember report style). -->\n{links}\n<div class="story story--charts">\n{body}\n</div>\n')

# What the page loads: its stylesheets, scripts (and their imports), d3, fonts and data
files = ['css/story.css', 'css/charts-page.css', 'vendor/d3.v7.9.0.min.js', 'data/article-summary.json', 'data/story-cells.json', 'data/story-cartogram.json', 'data/story-localwacc.json', 'data/story-planned.json']
files += [f'fonts/{p.name}' for p in sorted((ART / 'fonts').glob('*.woff2'))]
todo, seen = ['js/charts-page.js'], set()
while todo:
    f = todo.pop()
    if f in seen:
        continue
    seen.add(f)
    src = (ART / f).read_text()
    for imp in re.findall(r"from '(\./[^']+)'", src):
        todo.append('js/' + imp[2:])
    files.append(f)
for f in files:
    (OUT / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ART / f, OUT / f)

# From outside scrollytelling/: the colour registry and the land outline, with the paths that reach them rewritten
shutil.copyfile(SITE / 'js/constants.js', OUT / 'js/constants.js')
shutil.copyfile(SITE / 'data/world.geojson', OUT / 'data/world.geojson')
for f in OUT.glob('js/*.js'):
    s = f.read_text()
    t = s.replace("'../../js/constants.js'", "'./constants.js'").replace("'../../data/world.geojson'", "'../data/world.geojson'")
    if t != s:
        f.write_text(t)
left = [str(f.relative_to(OUT)) for f in OUT.glob('js/*.js') if '../../' in f.read_text()]
if left:
    raise SystemExit(f'charts-artifact: paths outside the folder remain in {left}')
print('\n'.join(sorted(str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file())))
