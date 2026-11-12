#!/bin/zsh
# Build each year's wind profiles as soon as its ERA5 npz lands; verify; keep the npz (human, 30 Oct: keep every cache).
cd ~/wind-atlas-T060
REPO=/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T060
for y in 2015 2016 2017 2018 2019 2020 2021 2022 2023; do
  [[ -f work/wind_done_$y ]] && continue
  while [[ ! -f raw/era5/era5_speed_$y.npz || -f raw/era5/era5_$y.progress.txt ]]; do sleep 30; done
  sleep 5
  echo "$(date '+%F %T') building $y"
  ATLAS_WORKSPACE_DIR=$HOME/wind-atlas-T060/work /usr/bin/time -l python3 -I scripts/build_wind_years.py --repo $REPO \
     --resource work/resource_t059.csv --year $y --speeds raw/era5/era5_speed_$y.npz 2>&1 | grep -E "^20|real|peak|Error|error"
  python3 -I -c "
import numpy as np, sys
from datetime import date
y=$y; h=(date(y+1,1,1)-date(y,1,1)).days*24
ok=True
for t,n in (('on',4424),('off',1324)):
    m=np.load(f'work/wind/{t}_{y}.npy', mmap_mode='r')
    good = m.shape==(n,h) and np.isfinite(m).all() and m.min()>=0 and m.max()<=1 and 0.05<m.mean()<0.6
    print(y,t,m.shape,'mean',round(float(m.mean()),4),'ok' if good else 'BAD'); ok&=good
sys.exit(0 if ok else 1)
" && touch work/wind_done_$y && echo "$(date '+%F %T') $y verified, raw npz kept; free $(df -g ~ | tail -1 | awk '{print $4}') GB"
done
