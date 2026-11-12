#!/bin/zsh
# T060: wind builds for the remaining years (raw npz kept), then phase B simulation.
# Replaces the tail of resume_all.sh after the human's keep-every-cache instruction (30 Oct).
cd ~/wind-atlas-T060
R=/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T060
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB, used $(du -sg ~/wind-atlas-T060 | cut -f1) GB" >> logs/resume.log; }
log "resume_b start (wind builds keep raw npz)"
scripts/build_wind_all.sh >> logs/build_wind.log 2>&1
for y in 2015 2016 2017 2018 2019 2020 2021 2022 2023; do
  [[ -f work/wind_done_$y && -f work/solar/solar_${y}_u16.npy ]] || { log "STOP: inputs for $y missing"; exit 1; }
done
log "all inputs ready"
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set dense --parts work/parts10 >> logs/run10_dense.log 2>&1 || { log "dense FAILED"; exit 1; }
log "dense done"
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set wind_mix --parts work/parts10 --data $R/deployment/data >> logs/run10_mix.log 2>&1 || { log "wind_mix FAILED"; exit 1; }
log "wind_mix done"
python3 -I scripts/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense --points work/voronoi_points.csv >> logs/assemble10.log 2>&1 || { log "assemble dense FAILED"; exit 1; }
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set large --parts work/parts10 --w0 work/out10/summary_w0.parquet >> logs/run10_large.log 2>&1 || { log "large FAILED"; exit 1; }
log "large done; phase B simulation complete"
