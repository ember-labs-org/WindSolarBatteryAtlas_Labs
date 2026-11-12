# Numbers for "Harnessing the Winds" (T040)

Scripts and output tables behind `team/evidence/harnessing-the-winds.md`. Everything is computed from the atlas's committed data in `deployment/data/` with the app's own LCOE search at app defaults. External figures (IRENA, OWID, Ember) sit in `inputs/external_figures.csv`, transcribed from Ember's futures database with the queries in `sql/futures_queries.sql`.

## Run

```
python3 -m venv /path/to/venv && /path/to/venv/bin/pip install -r scripts/article/requirements.txt
/path/to/venv/bin/python scripts/article/validate_engine.py   # engine = app, row for row (exit 0)
/path/to/venv/bin/python scripts/article/analyse.py           # writes out/*.csv, out/summary.json (~35 s)
/path/to/venv/bin/python scripts/article/take3_inventory.py   # writes out/take3_inventory.json
node scripts/article/drive_app.mjs                            # optional: re-records out/app/*.csv from the live app (~5 min)
/path/to/venv/bin/python scripts/article/compare_app.py       # engine vs app draws; writes out/local_sensitivity.csv
```

`analyse.py` output is byte-identical across runs. `drive_app.mjs` uses `checks/lib.mjs` (pinned Chromium, `?debug` draw records) and takes the machine-wide lock in shared mode, as `checks/regress.mjs` does.

## The engine and how it is proven

`engine.py` ports the worker's full-grid search (`deployment/js/workers/lcoe-worker.js` `fillLocationLcoe`, `computeBestLcoeMatrix`) and `app.js` `precomputeLcoePerLocation` for the app's default state: Capex Global, WACC Global (7%, offshore +0.92 points), no backup, both wind surfaces, base year 2026. It keeps the worker's float32 CF matrix and its order of floating-point operations, so winners and tie-breaks are the app's.

- `validate_engine.py` compares the engine's answers with the app's own recorded draws in `checks/oracle.json` (`lcoe_t90`, `lcoe_t80`, `lcoe_t80_onshore`, digest format of `checks/digest.mjs`): 4,465 of 4,465 rows identical on each key. Until the lead re-records `checks/oracle.json` after T057 (Antarctica and Greenland removed) the script FAILs by row count (4,465 engine rows against 4,998 oracle rows); on the filtered data the engine's rows equal the oracle's minus the 533 excluded ids on all three keys (checked in T057). It also fails if any ported constant no longer appears verbatim in `app.js` or `constants.js`.
- `compare_app.py` compares the engine with draws recorded from the live app by `drive_app.mjs`, at target 95% and at 80% in 2035 (the cost path): every field equal on all 4,465 rows (since T057; 4,998 before). Note: the script currently reports FAIL on floating-point noise (max abs diff 5.7e-14 in a few hundred rows), on main before T057 as well.
- Local cost mode is not ported. Its numbers come straight from the app's draws (`out/app/local_*.csv`).

**Base year.** The app anchors today's costs to the calendar year (`LCOE_TIME_ANCHORS.baseYear`). The engine fixes it at 2026. From 1 January 2027 the live app's 2030 and 2040 interpolations, and its "today", shift; the oracle keys then need re-recording anyway.

## Outputs (`out/`)

| File | What |
|---|---|
| `take1_by_target.csv` | By target CF (50–99%), surfaces (both, onshore only) and weight (cells, people, demand): shares where wind is the cheaper route, the only route, no gain, unmet; like-for-like medians (`*_both_reach`) and the share solar + battery reaches; median saving where wind is cheaper |
| `take1_weak_wind.csv` | Cells with weak wind (T063, W1): the windiest fifth of eligible land, and of eligible sea (500 km² at least), averages below 15% net CF before the level factors (`on_cf_best`, `off_cf_best`; `WEAK_WIND_CF` in `analyse.py` and `tools/model.js`); by country (≥ 20 million people): people, demand, median 100 m wind speed and median-site CF |
| `take1_cells.csv` | Per cell at 80/90/95%: class, cheapest build (`solar|wind[:surface]|battery`), its LCOE and whether it meets the target, the cheapest solar + battery LCOE and whether it meets, saving. For T041 |
| `take2_potential.csv`, `take2_by_lat.csv` | Wind technical potential (T014 Potential-map conventions) against demand, globally and by latitude band |
| `take3_inventory.json` | Every data file scanned for time-resolved generation by source |
| `take4_by_lat.csv`, `take4_countries.csv` | By latitude band and by country (dominant country per cell): reach and cost of 80/90/95% uptime with and without wind |
| `take5_by_year.csv` | 2026–2050 on the atlas's cost paths: medians and the share of people and demand whose cheapest build includes wind |
| `local_sensitivity.csv` | The headline shares and like-for-like medians under Capex Local + WACC Local, against defaults |
| `local_onshore_capex.csv` | The app's Local onshore capex (2024 anchor), people-weighted medians, against the Global anchor |
| `app/*.csv` | The app's drawn LCOE rows for the five scenarios in `drive_app.mjs` |
| `summary.json` | Totals quoted in the evidence file |

## Definitions

- **Cheapest build meeting a target:** the app's rule – among simulated builds (solar 0–10 GW with wind 1–8 GW, or solar 1–20 GW without wind; battery 0–36 GWh, all per GW of baseload) whose annual CF reaches the target, the lowest LCOE; ties to the first in config order. "Solar + battery only" is the same search without wind (`noWindLcoe` in the app).
- **Classes (per cell, per target):** `wind_cheaper` – the cheaper route: the cheapest build has wind and a solar + battery build also meets the target; `wind_only` – the only route: met, but by no solar + battery build in the grid (nothing to compare, so never counted as "cheaper"); `no_gain` – met, cheapest build has no wind; `unmet`.
- **Weights:** cells (4,465 engine cells; Antarctica and Greenland are left out since T057); people (GPW v4 2020, joined on the app's 2-decimal coordinate key; all 4,465 matched, 7.76 billion); demand (the atlas's layer, Chen et al. 2022, 4,399 map cells, 20,676 TWh/yr).
- **Cost comparisons are like for like (D-084):** `*_both_reach` medians use only the cells where both the cheapest build with wind and the best solar + battery build reach the target, with the same weights, and `median_cut_both_reach` = 1 − with wind / solar + battery. `share_met_solar_battery_only` gives the share left out. The plain `median_lcoe_*` columns count unreachable cells as +infinity (blank when over half the weight is unmet); they mix reach with cost and are not used for cost comparisons.
