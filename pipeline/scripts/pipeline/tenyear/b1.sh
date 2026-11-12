#!/bin/zsh
# T064 gate B1: 2024-only runs of the ten-year code against this branch's deployment/data (T061).
cd ~/wind-atlas-T064
export NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-5}
R=/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T064
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB" >> logs/b1.log; }
log "B1 start"
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set dense --years 2024 --parts work/parts24 >> logs/b1_dense.log 2>&1 || { log "dense FAILED"; exit 1; }
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set wind_mix --years 2024 --parts work/parts24 --data $R/deployment/data >> logs/b1_addon.log 2>&1 || { log "mix FAILED"; exit 1; }
/usr/bin/time -l python3 -I scripts/run10.py --repo $R --set large --years 2024 --parts work/parts24 --w0 $R/deployment/data/summary_w0.parquet --cyclic >> logs/b1_addon.log 2>&1 || { log "large FAILED"; exit 1; }
python3 -I scripts/assemble.py --repo $R --parts work/parts24 --out work/b1_out --years 2024 --points work/voronoi_points.csv >> logs/b1_assemble.log 2>&1 || { log "assemble FAILED"; exit 1; }
python3 -I scripts/gate_b1.py work/b1_out $R/deployment/data > logs/gate_b1.txt 2>&1
for f in addon.json; do cmp work/b1_out/$f $R/deployment/data/$f && echo "$f: bytes identical" >> logs/gate_b1.txt || echo "$f: DIFFERS" >> logs/gate_b1.txt; done
log "B1 done: $(grep GATE logs/gate_b1.txt)"
