"""T088 -> T087: the per-region week-long drought frequencies for the story's drought maps.

Reads ~/wind-atlas-T088/out/regions.csv (written by analyse.py: 4,310 regions with hourly profiles) and writes
deployment/scrollytelling/data/t088_regions.csv: location_id and, over 2015-2024, the share of 7-day windows with
solar below 50% of its ten-year mean (w7_t50_ps), the same for onshore wind (w7_t50_pw) and both at once
(w7_t50_pboth). The first line names the source.

usage (repo root): python3 pipeline/scripts/pipeline/t088/export_story.py [--src ~/wind-atlas-T088/out/regions.csv]
"""
import argparse
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
ap = argparse.ArgumentParser()
ap.add_argument('--src', default=str(Path.home() / 'wind-atlas-T088/out/regions.csv'))
args = ap.parse_args()
COLS = ['w7_t50_ps', 'w7_t50_pw', 'w7_t50_pboth']
out = ROOT / 'deployment/scrollytelling/data/t088_regions.csv'
with open(args.src) as f, open(out, 'w', newline='') as g:
    g.write('# source: T088 pipeline/scripts/pipeline/t088/analyse.py regions.csv, 2015-2024 hourly profiles, 7-day windows below 50% of the ten-year mean\n')
    w = csv.writer(g)
    w.writerow(['location_id'] + COLS)
    n = 0
    for r in csv.DictReader(f):
        w.writerow([r['location_id']] + [f'{float(r[c]):.4f}' if r[c] not in ('', 'nan') else '' for c in COLS])
        n += 1
print(f'wrote {out.relative_to(ROOT)}: {n} regions')
