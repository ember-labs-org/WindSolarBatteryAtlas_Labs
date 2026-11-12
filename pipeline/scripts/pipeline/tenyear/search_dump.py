"""Per-region search results at 80/90/99% (article engine, add-on on, base year 2026,
global costs) on one data folder, for the report's region-level comparisons.
  python3 -I search_dump.py <repo> <data dir> <out.npz>
"""
import sys
from pathlib import Path

import numpy as np

repo, data, outp = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(repo / 'scripts/article'))
import engine  # noqa: E402
engine.DATA = data
import analyse  # noqa: E402
analyse.DATA = data
m = engine.load_matrix()
lcoe, cf = engine.lcoe_matrix(m)
cells = analyse.cell_table(m['ids'])
out = dict(ids=m['ids'], lat=cells.lat.to_numpy(), pop=cells['pop'].to_numpy(), dem=cells.demand_twh.to_numpy())
for T in (80, 90, 99):
    r = engine.search(m, lcoe, cf, T / 100)
    for k in ('meets', 'lcoe', 'cf', 'solar_gw', 'wind_gw', 'batt_gwh', 'nowind_lcoe', 'nowind_meets',
              'nowind_std_meets', 'nowind_large', 'nowind_solar', 'nowind_batt', 'saving'):
        out[f'{k}_{T}'] = np.asarray(r[k], dtype=float)
    out[f'surface_{T}'] = np.asarray(r['surface']).astype(str)
    out[f'addon_{T}'] = np.asarray([x or '' for x in r['addon']]).astype(str)
np.savez(outp, **out)
print('wrote', outp)
