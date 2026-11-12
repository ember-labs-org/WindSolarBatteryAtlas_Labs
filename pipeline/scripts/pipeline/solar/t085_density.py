#!/usr/bin/env python3
"""T085: solar potential at the default ground-mount density.

Rewrites deployment/data/voronoi_pvout_potential.csv in place (run once, from the repo root):

  python3 pipeline/scripts/pipeline/solar/t085_density.py [--check]

Ground-mount generation is linear in the density: pvout_levelN_twh_y = area x mean PVOUT x density.
The file was built at 40 MW/km2; every ground column is scaled by DENSITY / the file's own
assumed_mw_per_km2, so the script is idempotent and 40 reproduces the old file exactly.

- DENSITY = 50 MW/km2 (DC): a central judgement (human, D-156) between whole-park footprints of
  large parks (about 26-44 MW/km2) and LBNL's array-area medians for 2019 US plants (Bolinger and
  Bolinger 2022, IEEE JPV: 0.24 MWdc/acre tracking = 59.3 MWdc/km2, 0.35 fixed-tilt = 86.5).
- Rooftop is unchanged: Joshi et al., 100 MW/km2 of building footprint. No suitable-roof case (D-157):
  the columns an earlier T085 step added are removed if present.

--check only verifies (no write): the file's ground columns equal twh_per_mw_km2 x density within
the 6-decimal rounding and totals equal ground + rooftop.
"""
import csv
import sys
from pathlib import Path

DENSITY = 50.0
PATH = Path('deployment/data/voronoi_pvout_potential.csv')
LEVELS = ('level1', 'level2')
DROP = ('rooftop_suitable_mw_per_km2', 'rooftop_suitable_twh_y')   # D-157


def fmt(x):
    return f'{x:.6f}'


def main():
    check_only = '--check' in sys.argv
    with PATH.open(newline='') as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames)
        rows = list(reader)
    if check_only:
        assert not any(c in fields for c in DROP), 'suitable-roof columns still present (D-157)'
    fields = [c for c in fields if c not in DROP]
    worst = 0.0
    for r in rows:
        for c in DROP:
            r.pop(c, None)
        old_d = float(r['assumed_mw_per_km2'])
        roof = float(r['rooftop_twh_y'] or 0)
        for lv in LEVELS:
            g = float(r[f'pvout_{lv}_twh_y'])
            per = float(r[f'pvout_{lv}_twh_per_mw_km2'])
            # The ground column is area x PVOUT x density; its per-density column is rounded to 6 dp.
            worst = max(worst, abs(per * old_d - g) - old_d * 5e-7)
            if check_only:
                assert abs(float(r[f'total_{lv}_twh_y']) - g - roof) < 2e-6, (r['location_id'], lv)
            else:
                g = g * DENSITY / old_d
                r[f'pvout_{lv}_twh_y'] = fmt(g)
                r[f'total_{lv}_twh_y'] = fmt(g + roof)
        if check_only:
            assert float(r['assumed_mw_per_km2']) == DENSITY
        else:
            r['assumed_mw_per_km2'] = fmt(DENSITY)
    assert worst < 1e-6, f'ground column does not equal per-density x density (worst {worst})'
    tot = {lv: sum(float(r[f'total_{lv}_twh_y']) for r in rows) for lv in LEVELS}
    roof = sum(float(r['rooftop_twh_y']) for r in rows)
    print(f'{len(rows)} rows; density {DENSITY:g} MW/km2; total level1 {tot["level1"]:,.1f} TWh, level2 {tot["level2"]:,.1f} TWh; '
          f'rooftop {roof:,.1f} TWh')
    if not check_only:
        with PATH.open('w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=fields, lineterminator='\n')
            w.writeheader()
            w.writerows(rows)


if __name__ == '__main__':
    main()
