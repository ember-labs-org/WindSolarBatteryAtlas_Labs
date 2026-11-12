#!/bin/zsh
# T068 integrated rebuild driver. Stages run in order; each leaves done/<stage> and is skipped
# on a rerun. Logs in ~/wind-atlas-T068/logs. Nothing is written into the repo or OneDrive.
#   run_t068.sh <stage>...   stages: inputs era5 solar k10 wind run24 daily run10 resource final
#   env: R (worktree), T067_RES (T067 full 4,998-row resource CSV), SOLAR_SRC (T066 work dir)
set -u
RUN=$HOME/wind-atlas-T068
cd $RUN
export TENYEAR_ROOT=$RUN NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-5} NUMBA_CACHE_DIR=$RUN/work/numba
: ${R:?worktree} ; : ${SOLAR_SRC:=$HOME/wind-atlas-T066/work}
T64=$HOME/wind-atlas-T064
YEARS=(2015 2016 2017 2018 2019 2020 2021 2022 2023 2024)
mkdir -p logs done work/wind
log() { echo "$(date '+%F %T') $* | free $(df -g ~ | tail -1 | awk '{print $4}') GB" | tee -a logs/run_t068.log; }
die() { log "FAILED: $*"; exit 1; }
diskok() { (( $(df -g ~ | tail -1 | awk '{print $4}') >= 15 )) || die "free disk below 15 GB"; }
T() { /usr/bin/time -l "$@"; }
PY=(python3 -I)

stage_inputs() {
  : ${T067_RES:?T067 full resource csv}
  rm -rf scripts; cp -R $R/pipeline/scripts/pipeline/tenyear scripts
  cp $T067_RES work/resource_t068.csv
  cp $T64/work/voronoi_points.csv $T64/work/solar_ids.npy $T64/work/solar_points.csv work/
  rm -rf work/data_in; cp -Rp $R/deployment/data work/data_in
  $PY - <<'PY' || exit 1
import pandas as pd, numpy as np
a = pd.read_csv("work/resource_t068.csv"); b = pd.read_csv("/Users/daanwalter/wind-atlas-T064/work/resource_t064.csv")
kd = {f"{t}_{c}" for t in ("on", "off") for c in ("k", "raw_cf", "final_cf", "clamped")}
assert set(b.columns) - kd <= set(a.columns) and len(a) == len(b) == 4998, (a.shape, b.shape)
assert (a.location_id.values == b.location_id.values).all()
d = pd.read_csv("work/data_in/voronoi_wind_resource.csv")
print("inputs: resource 4998 rows; deployed csv", len(d), "rows")
for t in ("on", "off"):
    mv = ~(np.isclose(a[f"{t}_site_lat"], b[f"{t}_site_lat"], equal_nan=True) & np.isclose(a[f"{t}_site_lon"], b[f"{t}_site_lon"], equal_nan=True))
    print(f"{t}: moved sites {mv.sum()}, viable {int(a[f'{t}_viable'].sum())} (T064 {int(b[f'{t}_viable'].sum())}), "
          f"target changed {(~np.isclose(a[f'{t}_cf_target'], b[f'{t}_cf_target'], equal_nan=True)).sum()}")
PY
}

stage_era5() {
  # 2024 comes from T067's fetch at the same points (lead, 1 Nov); copied, then checked below
  # like every year (shape, location order, unmoved columns bit-identical to T061's 2024 fetch).
  T67E=$HOME/wind-atlas-T067/raw/era5/era5_speed_2024.npz
  if [[ ! -f raw/era5/era5_speed_2024.npz ]]; then
    [[ -f $T67E && ! -f $HOME/wind-atlas-T067/raw/era5/era5_2024.progress.txt ]] || die "T067 2024 ERA5 not ready"
    cp -p $T67E raw/era5/era5_speed_2024.npz
    $PY - <<'PY' || die "T067 2024 npz shape/points"
import numpy as np, pandas as pd
z = np.load("raw/era5/era5_speed_2024.npz"); ids = pd.read_csv("work/resource_t068.csv").location_id.to_numpy()
assert np.array_equal(z["location_id"], ids), "location order"
for k in ("centre", "on", "off"): assert z[k].shape == (8784, len(ids)) and z[k].dtype == np.float32, (k, z[k].shape)
print("T067 2024 npz: shape and location order ok")
PY
  fi
  mv_args=(); [[ -n ${MOVED:-} ]] && mv_args=(--moved $MOVED)
  for y in $YEARS; do
    [[ -f raw/era5/era5_speed_$y.npz ]] || die "ERA5 $y not fetched (run fetch_lanes68.sh)"
    old=$T64/raw/era5/era5_speed_$y.npz; [[ $y == 2024 ]] && old=$T64/work/era5_speed_2024.npz
    $PY scripts/era5_check68.py --year $y --new raw/era5/era5_speed_$y.npz --old $old \
      --new-res work/resource_t068.csv --old-res $T64/work/resource_t064.csv \
      $mv_args >> logs/era5_check68.txt 2>&1 || die "ERA5 check $y"
  done
}

stage_solar() {
  mkdir -p work/solar
  for y in $YEARS; do
    src=$SOLAR_SRC/solar/solar_${y}_u16.npy; dst=work/solar/solar_${y}_u16.npy
    [[ $y == 2024 ]] && { src=$SOLAR_SRC/solar_2024_u16.npy; dst=work/solar_2024_u16.npy; }
    cp -p $src $dst || die "solar $y missing"
  done
  cmp $SOLAR_SRC/solar_ids.npy work/solar_ids.npy || die "solar ids differ from T064"
  $PY - <<'PY' >> logs/solar_check.txt 2>&1 || exit 1
import numpy as np
from datetime import date
ids = np.load("work/solar_ids.npy")
for y in range(2015, 2025):
    m = np.load("work/solar_2024_u16.npy" if y == 2024 else f"work/solar/solar_{y}_u16.npy", mmap_mode="r")
    h = (date(y + 1, 1, 1) - date(y, 1, 1)).days * 24
    assert m.dtype == np.uint16 and m.shape == (len(ids), h), (y, m.dtype, m.shape)
    assert int(m.max()) <= round(1 / 1.3 * 0.985 * 1e4) + 1, (y, int(m.max()))
    print(y, m.shape, "mean CF", round(float(m.mean()) / 1e4, 5), "max", int(m.max()))
PY
}

stage_k10() {
  T $PY scripts/solve_k10.py --repo $R --resource work/resource_t068.csv --era5 raw/era5 \
    --years 2015-2024 --out work/wind --procs 5 >> logs/k10.log 2>&1 || die k10
}

stage_wind() {
  for y in $YEARS; do
    diskok
    T $PY scripts/build_wind_years.py --repo $R --resource work/resource_t068.csv --year $y \
      --speeds raw/era5/era5_speed_$y.npz --k-fixed >> logs/build_wind.log 2>&1 || die "wind $y"
  done
  $PY - <<'PY' >> logs/build_wind.log 2>&1 || exit 1
import numpy as np, pandas as pd
from datetime import date
res = pd.read_csv("work/resource_t068.csv")
for t in ("on", "off"):
    rows = np.load(f"work/wind/{t}_rows.npy"); tot = 0.0; hrs = 0
    for y in range(2015, 2025):
        m = np.load(f"work/wind/{t}_{y}.npy", mmap_mode="r")
        h = (date(y + 1, 1, 1) - date(y, 1, 1)).days * 24
        assert m.shape == (len(rows), h) and np.isfinite(m).all() and m.min() >= 0 and m.max() <= 1, (t, y)
        tot = tot + m.astype("float64").sum(axis=1); hrs += h
    mean = tot / hrs
    tgt = res.set_index("location_id").loc[rows, f"{t}_cf_target"].to_numpy()
    k = np.load(f"work/wind/k_{t}.npz"); cl = (k["k"][k["rows"]] >= 1.8 - 1e-9) | (k["k"][k["rows"]] <= 0.6 + 1e-9)
    err = np.abs(mean - tgt)[~cl]
    print(f"{t}: {len(rows)} profiles; ten-year mean vs target, unclamped max |err| {err.max():.2e}; clamped {cl.sum()}")
    assert err.max() < 1e-4
PY
  [[ $? == 0 ]] || die "wind validation"
}

stage_run24() {
  T $PY scripts/run10.py --repo $R --set dense --years 2024 --parts work/parts24 >> logs/run24_dense.log 2>&1 || die "run24 dense"
  T $PY scripts/run10.py --repo $R --set wind_mix --years 2024 --parts work/parts24 --data work/data_in >> logs/run24_addon.log 2>&1 || die "run24 mix"
  $PY scripts/assemble.py --repo $R --parts work/parts24 --out work/out24 --sets dense --years 2024 \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json >> logs/assemble24.log 2>&1 || die "assemble24 dense"
  T $PY scripts/run10.py --repo $R --set large --years 2024 --parts work/parts24 --w0 work/out24/summary_w0.parquet --cyclic >> logs/run24_addon.log 2>&1 || die "run24 large"
  $PY scripts/assemble.py --repo $R --parts work/parts24 --out work/out24 --sets dense,wind_mix,large --years 2024 \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json --large-start cyclic --detail work/detail24 >> logs/assemble24.log 2>&1 || die "assemble24"
}

stage_daily() {
  $PY scripts/daily_npy.py --repo $R --root $RUN --out work/out24/daily_cf_2024.parquet >> logs/daily.log 2>&1 || die daily
}

stage_run10() {
  diskok
  T $PY scripts/run10.py --repo $R --set dense --parts work/parts10 >> logs/run10_dense.log 2>&1 || die "run10 dense"
  T $PY scripts/run10.py --repo $R --set wind_mix --parts work/parts10 --data work/data_in >> logs/run10_mix.log 2>&1 || die "run10 mix"
  $PY scripts/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json >> logs/assemble10.log 2>&1 || die "assemble10 dense"
  T $PY scripts/run10.py --repo $R --set large --parts work/parts10 --w0 work/out10/summary_w0.parquet --cyclic >> logs/run10_large.log 2>&1 || die "run10 large"
  $PY scripts/assemble.py --repo $R --parts work/parts10 --out work/out10 --sets dense,wind_mix,large \
    --points work/voronoi_points.csv --manifest work/data_in/addon.json --large-start cyclic --detail results >> logs/assemble10.log 2>&1 || die "assemble10"
}

stage_resource() {
  $PY scripts/update_resource68.py --csv work/data_in/voronoi_wind_resource.csv --diag work/wind/k10_diag.csv \
    --root $RUN --out work/out10/voronoi_wind_resource.csv >> logs/resource.log 2>&1 || die resource
}

stage_final() {
  rm -rf work/data_final work/data_2024
  cp -Rp work/data_in work/data_final
  rm -rf work/data_final/worst
  cp -p work/out10/*.parquet work/out10/addon.json work/out10/voronoi_wind_resource.csv work/data_final/
  cp -p work/out24/daily_cf_2024.parquet work/data_final/
  $PY scripts/worst.py --detail results --data work/data_final --out work/data_final >> logs/worst.log 2>&1 || die worst
  mkdir -p work/data_2024; cp -p work/out24/summary_*.parquet work/out24/addon_*.parquet work/out24/addon.json work/data_2024/
  $PY $R/pipeline/scripts/pipeline/tenyear/check68.py work/data_in work/data_final > logs/check_schema.txt 2>&1
  log "schema: $(tail -1 logs/check_schema.txt)"
}

for s in "$@"; do
  [[ -f done/$s ]] && { log "skip $s (done)"; continue; }
  diskok; log "start $s"
  stage_$s || die $s
  touch done/$s; log "done $s"
done
