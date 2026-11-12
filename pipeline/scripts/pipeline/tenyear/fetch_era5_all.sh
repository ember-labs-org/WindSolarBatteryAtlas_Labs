#!/bin/zsh
# Fetch ERA5 2015-2023 one year at a time; each year is retried (resuming from its
# checkpoint) up to 6 times if the fetch process exits; stop if free disk < 3 GB.
cd ~/wind-atlas-T060
for y in 2015 2016 2017 2018 2019 2020 2021 2022 2023; do
  for attempt in 1 2 3 4 5 6; do
    if [[ -f work/wind_done_$y || -f raw/era5/era5_speed_$y.npz ]]; then break; fi
    free=$(df -g ~ | tail -1 | awk '{print $4}')
    echo "$(date '+%F %T') year $y attempt $attempt, free disk ${free} GB"
    if (( free < 3 )); then echo "STOP: free disk below 3 GB"; exit 1; fi
    /usr/bin/time -l python3 -I scripts/fetch_era5_year.py --year $y --resource work/resource_fetchpoints.csv --workers 24 2>&1 \
      | grep --line-buffered -E "wrote|resuming|retry|real|peak memory|Error|error|Traceback" | uniq
    [[ -f raw/era5/era5_speed_$y.npz ]] || sleep 300
  done
  if [[ ! -f work/wind_done_$y && ! -f raw/era5/era5_speed_$y.npz ]]; then echo "STOP: $y failed 6 times"; exit 1; fi
  echo "$(date '+%F %T') year $y fetched"
done
