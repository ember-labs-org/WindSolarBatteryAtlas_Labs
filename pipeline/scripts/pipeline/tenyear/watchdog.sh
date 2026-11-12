#!/bin/zsh
# Every 2 min: log free disk, T060 disk use and memory; if free disk < 3 GB, stop all T060 jobs.
cd ~/wind-atlas-T060
while true; do
  free=$(df -m ~ | tail -1 | awk '{print $4}')
  used=$(du -sm ~/wind-atlas-T060 | cut -f1)
  rss=$(ps -axo rss,command | grep -E "scripts/(run10|fetch_|build_|assemble)" | grep -v grep | awk '{s+=$1} END {print int(s/1024)}')
  pf=$(vm_stat | awk '/Pages free/ {gsub("\\.","",$3); print int($3*16/1024)}')
  echo "$(date '+%F %T') free_disk_MB=$free t060_MB=$used t060_rss_MB=$rss free_mem_MB=$pf" >> logs/disk_mem.log
  if (( free < 3072 )); then
    echo "$(date '+%F %T') STOP: free disk ${free} MB < 3 GB, killing T060 jobs" >> logs/disk_mem.log
    pkill -f "wind-atlas-T060/scripts/resume_all.sh"; pkill -f "scripts/fetch_era5_all.sh"; pkill -f "scripts/build_wind_all.sh"
    pkill -f "scripts/fetch_era5_year.py"; pkill -f "scripts/fetch_solar_bulk.py"; pkill -f "scripts/run10.py"
    exit 1
  fi
  T=$(( $(date +%s) + 120 )); until [ $(date +%s) -ge $T ]; do sleep 10; done
done
