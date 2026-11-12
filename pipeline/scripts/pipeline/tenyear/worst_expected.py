import pyarrow.parquet as pq, json, numpy as np
R='/Users/daanwalter/wind-atlas-T068/results'; D='/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T068/deployment/data'
cfg=json.load(open(D+'/configs.json'))['configs']
add={s['id']:s['configs'] for s in json.load(open(D+'/addon.json'))['sets']}
def locs(n): return np.unique(pq.read_table(f'{R}/per_year_{n}.parquet',columns=['location_id']).column(0).to_numpy())
def pick(name, loc, j):
    t=pq.read_table(f'{R}/per_year_{name}.parquet', filters=[('location_id','=',int(loc)),('config','=',j)]).to_pandas()
    ys=[c for c in t.columns if c.startswith('cf_2')]; v=t[ys].iloc[0].to_numpy()
    return round(float(v.min()),4), 2015+int(np.argmin(v))
out=[]; dl=locs('dense')
for loc,i in ((dl[100],500),(dl[2500],3215),(dl[-1],0)):
    c=cfg[i]; w,y=pick('dense',loc,i)
    out.append(dict(row=dict(location_id=int(loc),solar_gw=c['solar'],wind_gw=c['wind'],batt_gwh=c['batt'],wind_surface=c['surface']),cf=w,year=y))
L=locs('wind_mix')[300]; c=add['wind_mix'][700]; w,y=pick('wind_mix',L,700)
out.append(dict(row=dict(location_id=int(L),solar_gw=c['solar'],wind_gw=c['on']+c['off'],batt_gwh=c['batt'],wind_surface='both',wind_on_gw=c['on'],wind_off_gw=c['off']),cf=w,year=y))
L=locs('large')[700]; c=add['large'][100]; w,y=pick('large',L,100)
out.append(dict(row=dict(location_id=int(L),solar_gw=c['solar'],wind_gw=0,batt_gwh=c['batt'],wind_surface='on',addon='large'),cf=w,year=y))
print(json.dumps(out))
