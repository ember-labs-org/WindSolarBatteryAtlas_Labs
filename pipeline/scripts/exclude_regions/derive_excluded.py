"""Derive the regions and land polygons the atlas leaves out (T057, D-120).

The atlas does not map Antarctica or Greenland. This script writes
`excluded_regions.json` next to it, which `apply_exclusion.py` then uses to drop
those regions from every per-region data file and the land polygons from
`world.geojson`. Run it once, on the UNFILTERED pipeline outputs (it needs the
Antarctic and Greenland land that apply_exclusion.py removes):

    python3 -I pipeline/scripts/exclude_regions/derive_excluded.py \
        --data <unfiltered deployment/data> \
        --countries <ne_110m_admin_0_countries.shp>

Rule
----
Land polygons (world.geojson, Natural Earth 50m land as simplified in T006):
  * Antarctic: every polygon lying wholly south of 60°S (the Antarctic Treaty
    area; no other land lies there).
  * Greenland: every polygon whose representative point is within 3° of
    Greenland in Natural Earth 110m admin-0 (ADM0_A3 GRL) and nearer to
    Greenland than to any other country there. 110m drops Greenland's small
    islands, hence the nearest-country test rather than containment.
Regions (Voronoi sites):
  * the primary country (voronoi_overlapping_countries.csv country_iso3) is ATA
    or GRL; cells shared with another country keep their primary country's
    verdict (e.g. CAN|GRL with CAN primary stays, GRL|CAN with GRL primary goes);
  * a region with no row in voronoi_overlapping_countries.csv goes if its site
    lies on the Antarctic or Greenland land polygons above.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
from shapely.geometry import Point, shape
from shapely.ops import unary_union

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / 'excluded_regions.json'
PRIMARY = {'ATA': 'Antarctica', 'GRL': 'Greenland'}


def feature_id(line: str) -> str:
    """SHA-256 of one feature's line in world.geojson, without the trailing comma."""
    return hashlib.sha256(line.rstrip('\n').rstrip(',').encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', type=Path, default=ROOT / 'deployment' / 'data')
    ap.add_argument('--countries', type=Path, required=True, help='ne_110m_admin_0_countries.shp')
    args = ap.parse_args()
    import geopandas as gpd

    # ---- land polygons ----
    lines = (args.data / 'world.geojson').read_text().split('\n')
    feats = [(i, ln) for i, ln in enumerate(lines) if ln.startswith('{"type":"Feature"')]
    ne = gpd.read_file(args.countries)
    grl = ne[ne.ADM0_A3 == 'GRL'].geometry.iloc[0]
    others = ne[ne.ADM0_A3 != 'GRL']
    land = []
    shapes = {'Antarctica': [], 'Greenland': []}
    for _, ln in feats:
        g = shape(json.loads(ln.rstrip(','))['geometry'])
        minx, miny, maxx, maxy = g.bounds
        why = None
        if maxy < -60:
            why = 'Antarctica'
        else:
            rp = g.representative_point()
            dg = grl.distance(rp)
            if dg < 3 and dg < others.distance(rp).min():
                why = 'Greenland'
        if why:
            shapes[why].append(g)
            land.append({'sha256': feature_id(ln), 'land': why,
                         'bbox': [round(v, 3) for v in (minx, miny, maxx, maxy)]})
    union = {k: unary_union(v) for k, v in shapes.items()}

    # ---- regions ----
    s = pq.read_table(args.data / 'summary_w0.parquet', columns=['location_id', 'latitude', 'longitude'])
    s = s.to_pandas().drop_duplicates('location_id').sort_values('location_id')
    oc = pd.read_csv(args.data / 'voronoi_overlapping_countries.csv',
                     usecols=['location_id', 'country_iso3', 'country_iso3s'], keep_default_na=False)
    m = s.merge(oc, on='location_id', how='left')
    regions = []
    for r in m.itertuples(index=False):
        lat, lon = float(r.latitude), float(r.longitude)
        if isinstance(r.country_iso3, str) and r.country_iso3 in PRIMARY:
            reason = f'primary country {r.country_iso3}'
            land_of = PRIMARY[r.country_iso3]
        elif not isinstance(r.country_iso3, str):
            p = Point(lon, lat)
            land_of = next((k for k, u in union.items() if u.contains(p)), None)
            if not land_of:
                continue
            reason = f'no country row; site on {land_of} land'
        else:
            continue
        regions.append({'location_id': int(r.location_id), 'latitude': lat, 'longitude': lon,
                        'land': land_of, 'reason': reason,
                        'country_iso3s': r.country_iso3s if isinstance(r.country_iso3s, str) else ''})
    assert all(math.isfinite(x['latitude']) for x in regions)

    doc = {
        'note': 'Regions and land polygons the atlas leaves out (T057, D-120). Written by derive_excluded.py '
                'from the unfiltered data; applied by apply_exclusion.py. Coordinates are the summary '
                'slices\' float32 site values.',
        'rule': {
            'land': 'world.geojson polygons wholly south of 60°S (Antarctica), and polygons whose representative '
                    'point is within 3° of Greenland in Natural Earth 110m admin-0 and nearer to it than to any '
                    'other country (Greenland)',
            'regions': 'primary country (voronoi_overlapping_countries.csv country_iso3) ATA or GRL; or no country '
                       'row and the site lies on the Antarctic or Greenland land above. Cells shared with another '
                       'country follow their primary country.',
        },
        'counts': {
            'regions': len(regions),
            'by_reason': {k: sum(1 for x in regions if x['reason'] == k) for k in sorted({x['reason'] for x in regions})},
            'land_polygons': {k: sum(1 for x in land if x['land'] == k) for k in ('Antarctica', 'Greenland')},
        },
        'regions': regions,
        'land': land,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f"wrote {OUT.relative_to(ROOT)}: {len(regions)} regions {doc['counts']['by_reason']}, "
          f"land polygons {doc['counts']['land_polygons']}")


if __name__ == '__main__':
    main()
