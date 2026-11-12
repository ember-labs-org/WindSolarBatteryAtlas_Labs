# SolarMap2

This repo splits the experience into:

- `deployment/` – everything that gets deployed as a static site (Cloudflare Pages, output directory `deployment`), including the interactive atlas and the article "Harnessing the Winds" at `deployment/scrollytelling/` (its numbers are built and checked by `scripts/article/tools/`, see the README there).
- `pipeline/` – a partial copy of the data pipeline (simulation and wind siting), kept for documentation. It cannot regenerate `deployment/data` on its own; `pipeline/README.md` lists what is here and what is missing.
- `scripts/` – reproducible builders and checks: `wind_costs/` (per-cell wind costs), `wind_potential/` (offshore technical potential) and `article/` (the article's analysis and tools).

## What’s new in the Atlas

- **Capacity Factor, LCOE, and Transmission views** now pick the lowest-cost build per location, support reference comparisons, and keep legend scales locked when needed.
- **Population view** includes a “Map vs. Charts” toggle: Map mode overlays CF or LCOE on the population cells while Charts summarize the chosen metric by population percentile and latitude buckets. The charts also keep the sidebar controls and a metric selector in sync, and the helper copy clarifies how to keep tuning solar, wind and storage.
- **Wind**: separate onshore and offshore sliders (0–8 MW per MW of baseload, at the simulated levels) in the Capacity Factor view and the Supply-Demand supply panel. Combined onshore and offshore builds are not simulated, so raising one slider resets the other to zero. The LCOE view has no wind sliders: once all wind levels have loaded, it searches every level, onshore and offshore, and keeps the cheaper build where the target is met. An *Include offshore wind* tick box restricts that search to onshore. Both sliders at zero reproduce the solar and battery atlas. The Potential view covers solar, onshore wind and offshore wind.
- The **Complementarity** tab (T093) shows how solar and onshore wind droughts line up over ten years of weather (2015–2024): the share of weeks or months in which solar, wind, or both at once make less than half their ten-year average, and a 0–1 complementarity score, (1 − r)/2 from the correlation of their daily, weekly or monthly output (1 opposite, 0.5 unrelated, 0 together). It reads `deployment/data/complementarity.csv` (built by `pipeline/scripts/pipeline/t093/build.py` from T088's ten-year daily series) only when the tab opens.
- **Info panel** and helper text now explain the latest UX, datasets, and how to read the maps/charts.

## Typical workflow

1. Deploy `deployment/` as it stands. There is no build step: Cloudflare Pages serves the directory as a static site (see `DEPLOYMENT.md`).
2. To rebuild the wind costs or the offshore potential, run the scripts in `scripts/wind_costs/` or `scripts/wind_potential/`; each README gives the inputs, checksums and run steps.
3. The simulation that produces the capacity-factor slices is only partly in this repo (`pipeline/`, see `pipeline/README.md`). The slices and configuration manifest in `deployment/data` are the committed result. The Complementarity data is rebuilt by `pipeline/scripts/pipeline/t093/build.py` from the ten-year daily series (T088); nothing needs hosting outside `deployment/` (see `DEPLOYMENT.md`).

## Data sources

- **Solar/weather inputs:** NASA/POWER Surface Meteorology and Solar Energy data (https://power.larc.nasa.gov) sampled per location and converted to hourly solar output. The hourly input profiles are not in this repo.
- **Wind inputs:** wind resource data (see `deployment/data/voronoi_wind_resource.csv`); the app's info panel cites Global Wind Atlas 4 for siting and ERA5 100 m winds for hourly shape. The wind siting scripts are in `pipeline/scripts/pipeline/wind/` (partial; see `pipeline/README.md`). The hourly wind profiles and the code that builds the wind summary slices are not in this repo.
- **Wind costs:** per-cell onshore and offshore CAPEX (2024, 2035, 2050) and O&M in `deployment/data/voronoi_local_capex.csv`, and cost of capital in `deployment/data/voronoi_wacc_wind.csv`. They are built by `scripts/wind_costs/build_wind_costs.py` from IRENA *Renewable Power Generation Costs in 2025*, the Danish Energy Agency offshore cost function (depth and distance to shore) and Hatton et al. v3 cost of capital. The solar cost of capital in `deployment/data/voronoi_wacc.csv` uses the same Hatton v3 vintage. Method, sources and re-run steps: `scripts/wind_costs/README.md`.
- **Population totals:** NASA SEDAC Gridded Population of the World, Version 4 (GPWv4) 2020 raster, summed per Voronoi cell in `deployment/data/voronoi_population_2020.csv`. The script that builds it is not in this repo.
- **Offshore wind potential:** `deployment/data/voronoi_wind_potential_offshore.csv`, built by `scripts/wind_potential/build_offshore_potential.py` from World Bank Group / ESMAP, *Global Offshore Wind Technical Potential* (2021, CC BY 4.0), reallocated to the atlas's cells. Onshore eligibility uses the World Bank / ESMAP Global PV Potential masks.

## Pipeline overview

What is in the repo (partial; `pipeline/README.md` has the detail):

1. `pipeline/scripts/pipeline/wind/` builds onshore and offshore eligibility and judges each region by the mean net capacity factor of the windiest 20% of its eligible land or sea, at least 500 km² (Global Wind Atlas sources; eligibility excludes WDPA protected areas and GHSL settlements, D-134), scaled by a level factor calibrated to IRENA new-build capacity factors (×0.879 onshore in Europe, ×0.777 offshore, D-135), with no cut-off (D-123): every region with eligible land (onshore) or sea (offshore) gets that wind however weak, and only regions without either have no wind; potential counts eligible land or sea at ≥ 15% before calibration. Hourly profiles are scaled to that level, with the scaling capped (k ≤ 1.8), so 698 of 4,380 onshore regions simulate below it, 304 of them below 15%.
2. `pipeline/scripts/pipeline/run3d.py` runs the solar × wind × battery simulation against a constant 1 GW load and writes the summary slices, the hourly samples and `configs.json`. It needs the hourly profiles and Global Wind Atlas inputs from the workspace, which are not in the repo (`pipeline/README.md` says how T054 ran it).
3. `pipeline/scripts/pipeline/run.py` and `simulation.py` are the earlier solar and battery pipeline (90% battery round-trip efficiency). `simulation.py` defines the capacity factor as served energy divided by constant-load demand.
4. `scripts/wind_costs/build_wind_costs.py` and `scripts/wind_potential/build_offshore_potential.py` rebuild the cost and offshore potential tables; they run on their own.
5. `pipeline/scripts/exclude_regions/apply_exclusion.py` leaves out Antarctica and Greenland (T057): it drops their 533 regions from every per-region file in `deployment/data` and their land from `world.geojson`, leaving 4,465 regions. Run it after any step above that rewrites `deployment/data`; `verify_exclusion.py` proves each file equals the old one minus those rows.

Not in the repo: the scripts that select locations, build the Voronoi population, fossil-capacity and solar-potential tables, and fetch the power plant data.
