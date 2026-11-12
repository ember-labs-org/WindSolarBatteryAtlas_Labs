#!/bin/zsh
# T064: fetch ERA5 2015-2023 at the T061 points, three lanes in parallel. Each year is
# retried (resuming from its checkpoint) up to 8 times with growing waits if the process
# exits (DNS drops etc.; read_hour itself also backs off per slice). Stop if free disk < 15 GB.
cd ~/wind-atlas-T064
lane() {
  for y in "$@"; do
    for attempt in 1 2 3 4 5 6 7 8; do
      [[ -f raw/era5/era5_speed_$y.npz ]] && break
      free=$(df -g ~ | tail -1 | awk '{print $4}')
      echo "$(date '+%F %T') year $y attempt $attempt, free disk ${free} GB"
      if (( free < 15 )); then echo "STOP: free disk below 15 GB"; return 1; fi
      /usr/bin/time -l python3 -I scripts/fetch_era5_year.py --year $y --resource work/resource_fetchpoints.csv --workers 16 2>&1 \
        | grep --line-buffered -E "wrote|resuming|retry|real|peak memory|Error|error|Traceback" | uniq
      [[ -f raw/era5/era5_speed_$y.npz ]] || sleep $(( 60 * attempt ))
    done
    [[ -f raw/era5/era5_speed_$y.npz ]] || { echo "STOP: $y failed 8 times"; return 1; }
    echo "$(date '+%F %T') year $y fetched"
  done
}
lane 2015 2018 2021 > logs/fetch_lane1.log 2>&1 &
lane 2016 2019 2022 > logs/fetch_lane2.log 2>&1 &
lane 2017 2020 2023 > logs/fetch_lane3.log 2>&1 &
wait
echo "$(date '+%F %T') all lanes finished" >> logs/fetch_lane1.log
