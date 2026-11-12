"""(T061 copy of T060's city_curves.py.) City LCOE curves 70-99% (global costs, base year 2026) for the 15 cities of
scratchpad/curves/curves.py, with the article engine (add-on included) on one data folder.
  python3 -I city_curves.py <repo> <data dir> <out.json>
"""
import json, sys
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq
repo, data, outp = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(repo / 'scripts/article'))
import engine
engine.DATA = data
m = engine.load_matrix(); lcoe, cf = engine.lcoe_matrix(m)
ids = m['ids']
pos = pq.read_table(data / 'summary_w0.parquet', columns=['location_id', 'latitude', 'longitude']).to_pandas() \
    .drop_duplicates('location_id').set_index('location_id').reindex(ids)
lat = pos.latitude.to_numpy(); lon = pos.longitude.to_numpy()
cities = [('Tromsø', 69.65, 18.96), ('Stockholm', 59.33, 18.07), ('Edinburgh', 55.95, -3.19), ('Berlin', 52.52, 13.40),
          ('London', 51.51, -0.13), ('Chicago', 41.88, -87.63), ('Madrid', 40.42, -3.70), ('Beijing', 39.90, 116.40),
          ('Dallas', 32.78, -96.80), ('Delhi', 28.61, 77.21), ('Lagos', 6.52, 3.38), ('Jakarta', -6.21, 106.85),
          ('Johannesburg', -26.20, 28.05), ('Buenos Aires', -34.60, -58.38), ('Melbourne', -37.81, 144.96)]
def hav(a, b, c, d):
    a, b, c, d = map(np.radians, (a, b, c, d))
    return 2 * 6371 * np.arcsin(np.sqrt(np.sin((c - a) / 2) ** 2 + np.cos(a) * np.cos(c) * np.sin((d - b) / 2) ** 2))
idx = [int(np.argmin(hav(la, lo, lat, lon))) for _, la, lo in cities]
T = [round(0.70 + 0.01 * k, 2) for k in range(30)]
out = {n: {'lat': float(lat[i]), 'id': int(ids[i]), 'w': [], 'sb': [], 'build': [], 'sb_build': []} for (n, _, _), i in zip(cities, idx)}
for t in T:
    r = engine.search(m, lcoe, cf, t)
    for (n, _, _), i in zip(cities, idx):
        o = out[n]
        o['w'].append(float(r['lcoe'][i]) if r['meets'][i] else None)
        o['sb'].append(float(r['nowind_lcoe'][i]) if r['nowind_meets'][i] else None)
        o['build'].append(f"s{r['solar_gw'][i]:g} w{r['wind_gw'][i]:g}{r['surface'][i] if r['wind_gw'][i] else ''} b{r['batt_gwh'][i]:g}")
    print(t, file=sys.stderr)
json.dump({'targets': T, 'data': str(data), 'cities': out}, open(outp, 'w'))
