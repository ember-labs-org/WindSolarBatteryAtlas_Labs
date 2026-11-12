#!/bin/zsh
# T068: ERA5 2015-2024 at the T067 sites, three lanes (T064 fetcher, unchanged). Downloads are
# kept in ~/wind-atlas-T068/raw/era5. Each year retries from its checkpoint up to 8 times.
# Stops if free disk < 15 GB. Usage: fetch_lanes68.sh   (needs work/resource_t068.csv)
cd ~/wind-atlas-T068
export TENYEAR_ROOT=$HOME/wind-atlas-T068
mkdir -p logs raw/era5
lane() {
  for y in "$@"; do
    for attempt in 1 2 3 4 5 6 7 8; do
      [[ -f raw/era5/era5_speed_$y.npz ]] && break
      free=$(df -g ~ | tail -1 | awk '{print $4}')
      echo "$(date '+%F %T') year $y attempt $attempt, free disk ${free} GB"
      if (( free < 15 )); then echo "STOP: free disk below 15 GB"; return 1; fi
      /usr/bin/time -l python3 -I scripts/fetch_era5_year.py --year $y --resource work/resource_t068.csv --workers 16 2>&1 \
        | grep --line-buffered -E "wrote|resuming|retry|real|peak memory|Error|error|Traceback" | uniq
      [[ -f raw/era5/era5_speed_$y.npz ]] || sleep $(( 60 * attempt ))
    done
    [[ -f raw/era5/era5_speed_$y.npz ]] || { echo "STOP: $y failed 8 times"; return 1; }
    echo "$(date '+%F %T') year $y fetched"
  done
}
# With arguments: one lane over those years (log fetch_lane_<first year>.log), then exit.
if (( $# )); then lane "$@" > logs/fetch_lane_$1.log 2>&1; exit; fi
# 2024 is not fetched here: T067 fetches 2024 at the same points (lead, 1 Nov); the run reuses
# ~/wind-atlas-T067/raw/era5/era5_speed_2024.npz after checking points and shape.
lane 2017 2020 2023 > logs/fetch_lane1.log 2>&1 &
lane 2015 2018 2021 > logs/fetch_lane2.log 2>&1 &
lane 2016 2019 2022 > logs/fetch_lane3.log 2>&1 &
wait
echo "$(date '+%F %T') all lanes finished" >> logs/fetch_lane1.log
