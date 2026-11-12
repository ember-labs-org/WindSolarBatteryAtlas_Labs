#!/bin/zsh
T=/private/tmp/claude-501/-Users-daanwalter-Library-CloudStorage-OneDrive-Ember-2-ember-futures---Documents-03-Research-2026-97-Ideas-WIND-ATLAS/43b874d4-4271-4297-b5a4-b3d287b19fe1/scratchpad/wt-T066/pipeline/scripts/pipeline/tenyear
while pgrep -f fetch_pv_bulk.py >/dev/null; do sleep 60; done
tail -3 ~/wind-atlas-T066/logs/fetch_pv_bulk.log
n=$(ls ~/wind-atlas-T066/raw/power_pv/2015_2019 | wc -l); m=$(ls ~/wind-atlas-T066/raw/power_pv/2020_2024 | wc -l)
echo "spans: $n $m"
[ $n -ge 4998 ] && [ $m -ge 4998 ] || { echo "FETCH INCOMPLETE"; exit 1; }
cd $T && ~/wind-atlas-T066/venv/bin/python build_solar_t066.py > ~/wind-atlas-T066/logs/build.log 2>&1 || { echo BUILD FAIL; tail ~/wind-atlas-T066/logs/build.log; exit 1; }
~/wind-atlas-T066/venv/bin/python gate_t066.py > ~/wind-atlas-T066/logs/gate_t066.txt 2>&1; echo "gate exit $?"
