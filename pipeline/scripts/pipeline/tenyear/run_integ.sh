#!/bin/zsh
# Integration T081 + T082 driver (run dir ~/wind-atlas-integ). Onshore profiles and parts are
# T081's, solar-only and large parts T068's (symlinks, read only); offshore matrices get T082's
# 19 zone rows (wind/t081/integ_offshore.py); offshore dense configurations and the add-on mix
# set are re-run. Stages leave done/<stage>.   run_integ.sh <stage>...
#   stages: inputs wind link daily run10 final        env: R (worktree)
set -u
RUN=$HOME/wind-atlas-integ; T68=$HOME/wind-atlas-T068; T81=$HOME/wind-atlas-T081; T82=$HOME/wind-atlas-T082
mkdir -p $RUN; cd $RUN
export TENYEAR_ROOT=$RUN NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-5} NUMBA_CACHE_DIR=$RUN/work/numba
: ${R:?worktree}
S=$R/pipeline/scripts/pipeline/tenyear
mkdir -p logs done work/wind
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB" | tee -a logs/run_integ.log; }
die() { log "FAILED: $*"; exit 1; }
diskok() { (( $(df -g ~ | tail -1 | awk '{print $4}') >= 10 )) || die "free disk below 10 GB"; }
PY=(python3 -I)

stage_inputs() {
  for f in voronoi_points.csv solar_ids.npy solar_points.csv solar_2024_u16.npy solar; do ln -sfn $T68/work/$f work/$f; done
  rm -rf work/data_in; cp -Rp $R/deployment/data work/data_in
}

stage_wind() {
  for f in $T81/work/wind/on_*.npy $T81/work/wind/k_on.npz $T81/work/wind/t081_diag.csv; do ln -sf $f work/wind/; done
  $PY $R/pipeline/scripts/pipeline/wind/t081/integ_offshore.py --old-wind $T68/work/wind --zone-dir $T82/zones \
    --order $T81/work/resource_t081.csv --deployed-in $R/deployment/data/voronoi_wind_resource.csv \
    --deployed-out work/data_in/voronoi_wind_resource.csv --out-wind work/wind >> logs/wind.log 2>&1 || die wind
}

stage_link() {
  mkdir -p work/parts10/dense work/parts10/large work/parts10/wind_mix
  $PY - $R $T68/work/parts10/dense $T81/work/parts10/dense work/parts10/dense <<'PY' || exit 1
import sys, os
sys.path.insert(0, sys.argv[1] + "/pipeline")
from scripts.pipeline.config import build_config_list
t68, t81, dst = sys.argv[2:5]
n = {"solar": 0, "on": 0}
for idx, sf, s, w, b in build_config_list():
    if sf == "off" and w > 0:
        continue                      # offshore wind: re-run (zone rows)
    src = os.path.join(t68 if w == 0 else os.path.realpath(t81), f"{idx}.npz")
    if w > 0:
        src = os.path.realpath(os.path.join(t81, f"{idx}.npz"))
    t = os.path.join(dst, f"{idx}.npz")
    if not os.path.lexists(t):
        os.symlink(src, t)
    n["solar" if w == 0 else "on"] += 1
print("linked", n)
PY
  for f in $T68/work/parts10/large/*.npz; do ln -sf $f work/parts10/large/; done
  cp $T68/work/parts10/large/regions.json work/parts10/large/regions.json
}

stage_daily() {
  mkdir -p work/out24
  $PY $S/daily_npy.py --repo $R --root $RUN --out work/out24/daily_cf_2024.parquet >> logs/daily.log 2>&1 || die daily
}

stage_run10() {
  diskok
  $PY $S/run10.py --repo $R --set dense --parts work/parts10 >> logs/run10_dense.log 2>&1 || die "run10 dense"
  $PY $S/run10.py --repo $R --set wind_mix --parts work/parts10 --data work/data_in >> logs/run10_mix.log 2>&1 || die "run10 mix"
  $PY $S/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json >> logs/assemble10.log 2>&1 || die "assemble10 dense"
  $PY $S/run10.py --repo $R --set large --parts work/parts10 --w0 work/out10/summary_w0.parquet --cyclic >> logs/run10_large.log 2>&1 || die "run10 large"
  $PY $S/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense,wind_mix,large \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json --large-start cyclic --detail results >> logs/assemble10.log 2>&1 || die "assemble10"
}

stage_final() {
  rm -rf work/data_final; cp -Rp work/data_in work/data_final; rm -rf work/data_final/worst
  cp -p work/out10/*.parquet work/out10/addon.json work/data_final/
  cp -p work/out24/daily_cf_2024.parquet work/data_final/
  $PY $S/worst.py --detail results --data work/data_final --out work/data_final >> logs/worst.log 2>&1 || die worst
}

for s in "$@"; do
  [[ -f done/$s ]] && { log "skip $s (done)"; continue; }
  diskok; log "start $s"
  stage_$s || die $s
  touch done/$s; log "done $s"
done
