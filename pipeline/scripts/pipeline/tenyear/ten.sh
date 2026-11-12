#!/bin/zsh
# T064: per-year ERA5 checks and wind builds (as each year lands), then the ten-year runs.
cd ~/wind-atlas-T064
export NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-5}
R=/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T064
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB, used $(du -sg ~/wind-atlas-T064 | cut -f1) GB" >> logs/ten.log; }
log "ten start"
for y in 2015 2016 2017 2018 2019 2020 2021 2022 2023; do
  [[ -f work/wind_done_$y ]] && continue
  until [[ -f raw/era5/era5_speed_$y.npz && ! -f raw/era5/era5_$y.progress.txt ]]; do
    (( $(df -g ~ | tail -1 | awk '{print $4}') < 15 )) && { log "STOP: free disk below 15 GB"; exit 1; }
    grep -q "STOP" logs/fetch_lane*.log && { log "STOP: fetch failed"; exit 1; }
    sleep 30; done
  sleep 5
  python3 -I scripts/era5_check.py --repo $R --year $y >> logs/era5_check.txt 2>&1 || { log "ERA5 check $y FAILED"; exit 1; }
  ATLAS_WORKSPACE_DIR=$HOME/wind-atlas-T064/work python3 -I scripts/build_wind_years.py --repo $R \
     --resource work/resource_t064.csv --year $y --speeds raw/era5/era5_speed_$y.npz >> logs/build_wind.log 2>&1 || { log "build $y FAILED"; exit 1; }
  python3 -I -c "
import numpy as np, sys
from datetime import date
y=$y; h=(date(y+1,1,1)-date(y,1,1)).days*24; ok=True
for t,n in (('on',4419),('off',1270)):
    m=np.load(f'work/wind/{t}_{y}.npy', mmap_mode='r')
    good = m.shape==(n,h) and np.isfinite(m).all() and m.min()>=0 and m.max()<=1 and 0.05<m.mean()<0.6
    print(y,t,m.shape,'mean',round(float(m.mean()),4),'ok' if good else 'BAD'); ok&=good
sys.exit(0 if ok else 1)" >> logs/build_wind.log 2>&1 && touch work/wind_done_$y || { log "validate $y FAILED"; exit 1; }
  log "year $y checked and built"
done
log "all inputs ready"
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set dense --parts work/parts10 >> logs/run10_dense.log 2>&1 || { log "dense FAILED"; exit 1; }
log "dense done"
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set wind_mix --parts work/parts10 --data $R/deployment/data >> logs/run10_mix.log 2>&1 || { log "wind_mix FAILED"; exit 1; }
log "wind_mix done"
python3 -I scripts/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense --points work/voronoi_points.csv >> logs/assemble10.log 2>&1 || { log "assemble dense FAILED"; exit 1; }
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set large --parts work/parts10 --w0 work/out10/summary_w0.parquet >> logs/run10_large.log 2>&1 || { log "large FAILED"; exit 1; }
log "large done"
python3 -I scripts/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense,wind_mix,large --points work/voronoi_points.csv --detail results >> logs/assemble10.log 2>&1 || { log "assemble FAILED"; exit 1; }
rm -rf work/data_10y; mkdir -p work/data_10y; cp -p $R/deployment/data/* work/data_10y/; cp -p work/out10/* work/data_10y/
python3 -I scripts/check_schema.py $R/deployment/data work/data_10y > logs/check_schema.txt 2>&1
log "assembled; schema: $(tail -1 logs/check_schema.txt)"
python3 -I scripts/gate_b2.py $R > logs/gate_b2.txt 2>&1
log "B2: $(tail -1 logs/gate_b2.txt); TEN DONE"
