#!/bin/zsh
# T081 rebuild driver: onshore profiles re-simulated, everything without onshore wind reused from
# T068 (read in place by symlink, never written). Stages leave done/<stage>; a rerun skips them.
#   run_t081.sh <stage>...   stages: inputs wind link run24 daily run10 resource final
#   env: R (worktree), RES (T081 full 4,998-row resource csv), MIX (mixture npz)
set -u
RUN=$HOME/wind-atlas-T081
T68=$HOME/wind-atlas-T068
cd $RUN
export TENYEAR_ROOT=$RUN NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-5} NUMBA_CACHE_DIR=$RUN/work/numba
: ${R:?worktree} ; : ${RES:?resource csv} ; : ${MIX:?mixture npz}
S=$R/pipeline/scripts/pipeline/tenyear
mkdir -p logs done work/wind
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB" | tee -a logs/run_t081.log; }
die() { log "FAILED: $*"; exit 1; }
diskok() { (( $(df -g ~ | tail -1 | awk '{print $4}') >= 12 )) || die "free disk below 12 GB"; }
T() { /usr/bin/time -l "$@"; }
PY=(python3 -I)

stage_inputs() {
  for f in voronoi_points.csv solar_ids.npy solar_points.csv solar_2024_u16.npy solar; do
    ln -sfn $T68/work/$f work/$f
  done
  cp $RES work/resource_t081.csv
  rm -rf work/data_in; cp -Rp $R/deployment/data work/data_in
}

stage_wind() {
  diskok
  T $PY $S/build_wind_t081.py --repo $R --resource work/resource_t081.csv --mixture $MIX \
    --era5 $T68/raw/era5 --out work/wind --procs 5 >> logs/build_wind.log 2>&1 || die wind
  for f in $T68/work/wind/off_*.npy $T68/work/wind/k_off.npz; do ln -sf $f work/wind/; done
}

stage_link() {
  # parts that contain no onshore wind are the T068 parts: solar-only (wind 0) and offshore
  # dense configurations, and the solar-only large set. Linked, read only.
  for P in parts10 parts24; do
    mkdir -p work/$P/dense work/$P/large work/$P/wind_mix
    $PY - $R $T68/work/$P/dense work/$P/dense <<'PY' || exit 1
import sys, os
sys.path.insert(0, sys.argv[1] + "/pipeline")
from scripts.pipeline.config import build_config_list
src, dst = sys.argv[2], sys.argv[3]
n = 0
for idx, sf, s, w, b in build_config_list():
    if sf == "off" or w == 0:
        t = os.path.join(dst, f"{idx}.npz")
        if not os.path.lexists(t):
            os.symlink(os.path.join(src, f"{idx}.npz"), t)
        n += 1
print("linked", n, "dense parts from", src)
PY
    for f in $T68/work/$P/large/*.npz; do ln -sf $f work/$P/large/; done
    cp $T68/work/$P/large/regions.json work/$P/large/regions.json
  done
}

stage_run24() {
  T $PY $S/run10.py --repo $R --set dense --years 2024 --parts work/parts24 >> logs/run24_dense.log 2>&1 || die "run24 dense"
  T $PY $S/run10.py --repo $R --set wind_mix --years 2024 --parts work/parts24 --data work/data_in >> logs/run24_addon.log 2>&1 || die "run24 mix"
  $PY $S/assemble.py --repo $R --parts work/parts24 --out work/out24 --sets dense --years 2024 \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json >> logs/assemble24.log 2>&1 || die "assemble24 dense"
  T $PY $S/run10.py --repo $R --set large --years 2024 --parts work/parts24 --w0 work/out24/summary_w0.parquet --cyclic >> logs/run24_addon.log 2>&1 || die "run24 large"
  $PY $S/assemble.py --repo $R --parts work/parts24 --out work/out24 --sets dense,wind_mix,large --years 2024 \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json --large-start cyclic --detail work/detail24 >> logs/assemble24.log 2>&1 || die "assemble24"
}

stage_daily() {
  $PY $S/daily_npy.py --repo $R --root $RUN --out work/out24/daily_cf_2024.parquet >> logs/daily.log 2>&1 || die daily
}

stage_run10() {
  diskok
  T $PY $S/run10.py --repo $R --set dense --parts work/parts10 >> logs/run10_dense.log 2>&1 || die "run10 dense"
  T $PY $S/run10.py --repo $R --set wind_mix --parts work/parts10 --data work/data_in >> logs/run10_mix.log 2>&1 || die "run10 mix"
  $PY $S/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json >> logs/assemble10.log 2>&1 || die "assemble10 dense"
  T $PY $S/run10.py --repo $R --set large --parts work/parts10 --w0 work/out10/summary_w0.parquet --cyclic >> logs/run10_large.log 2>&1 || die "run10 large"
  $PY $S/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense,wind_mix,large \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json --large-start cyclic --detail results >> logs/assemble10.log 2>&1 || die "assemble10"
}

stage_resource() {
  $PY $R/pipeline/scripts/pipeline/wind/t081/resource_out.py --deployed work/data_in/voronoi_wind_resource.csv \
    --site work/resource_t081.csv --diag work/wind/t081_diag.csv --rows work/wind/on_rows.npy \
    --out work/out10/voronoi_wind_resource.csv >> logs/resource.log 2>&1 || die resource
}

stage_final() {
  rm -rf work/data_final work/data_2024
  cp -Rp work/data_in work/data_final
  rm -rf work/data_final/worst
  cp -p work/out10/*.parquet work/out10/addon.json work/out10/voronoi_wind_resource.csv work/data_final/
  cp -p work/out24/daily_cf_2024.parquet work/data_final/
  $PY $S/worst.py --detail results --data work/data_final --out work/data_final >> logs/worst.log 2>&1 || die worst
  mkdir -p work/data_2024; cp -p work/out24/summary_*.parquet work/out24/addon_*.parquet work/out24/addon.json work/data_2024/
  $PY $S/check68.py work/data_in work/data_final > logs/check_schema.txt 2>&1
  log "schema: $(tail -1 logs/check_schema.txt)"
}

for s in "$@"; do
  [[ -f done/$s ]] && { log "skip $s (done)"; continue; }
  diskok; log "start $s"
  stage_$s || die $s
  touch done/$s; log "done $s"
done
