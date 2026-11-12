# Data pipeline (partial copy)

Supplied by Daan Walter on 26 October 2026 as `workspace.zip` and committed as received, for documentation. It is **incomplete**: it cannot regenerate the app's data on its own.

## What is here
- `scripts/pipeline/run3d.py` – the solar × wind × battery simulation that writes the hourly sample shards (`samples_gen_solar_s{S}`, `samples_gen_wind_{on|off}_w{W}`, `samples_s{S}[_w{W}|_wo{W}]_b{B}`), the summary slices, `configs.json` and `sample_timestamps.json`.
- `scripts/pipeline/simulation3d.py` (the dispatch kernel `run3d.py` imports) and `config.py` (paths, configuration grid; T054 replaced the older solar-only version with the workspace's). Paths can be pointed elsewhere with `ATLAS_WORKSPACE_DIR` and `ATLAS_DOCS_DATA_DIR`.
- `scripts/pipeline/run.py`, `simulation.py` – the earlier solar + battery pipeline.
- `scripts/pipeline/wind/` – wind siting and profiles: `build_eligibility.py` (onshore and offshore eligibility), `site_selection.py` (viability and headline CF, below), `build_wind_profiles.py` (hourly CF from ERA5, scaled to the headline), `power_curves.py`, `gwa_sources.py` (Global Wind Atlas sources), `validate_wind.py`.
- `scripts/pipeline/wind/t054_sensitivity/` – the T054 rule study and the harness that ran the T054 rebuild (below).
- `scripts/helpers/` – one-off probes and inspections from development.
- `input_data/wind/*.tif` – eligibility rasters on the 0.02° grid (onshore and offshore eligible share, land mask). Derived from World Bank/ESMAP Global PV Potential masks (CC BY 4.0) and NOAA ETOPO 2022 (public domain).

## What is missing to regenerate the data
- The Global Wind Atlas rasters, ERA5 speeds (`era5_speed_2024.npz`), Voronoi cells and points, and the hourly input profiles (solar from NASA POWER; onshore and offshore wind shaped from ERA5) and the floating and depth rasters.
- The generated hourly sample shards (`outputs/samples`, about 2.3 GB), which Sample Weeks needs (see `team/ESCALATIONS.md`).

## Eligibility rules (from `build_eligibility.py`)
- **Onshore:** excludes built-up areas, IUCN protected areas, water bodies with a 2 km buffer and severe terrain (elevation range > 300 m within the pixel). Forest and cropland are not excluded by default (`--exclude-forest`, `--exclude-cropland` for sensitivity tests).
- **Offshore:** below sea level, water depth ≤ 60 m (fixed-bottom) and ≥ 10 km from shore; 60–1,000 m recorded as floating but not simulated. The 200 km limit comes from the Global Wind Atlas extent.

## Wind viability and headline CF (T054, T059; D-109 to D-114, D-123)
For each region and surface (onshore land, offshore sea), every ~2 km pixel of eligible area gets a net capacity factor from the Global Wind Atlas (IEC class by mean speed onshore, the 150 m offshore layer offshore; 12% losses). The region's **headline net CF is the area-weighted mean of its best 500 km² of eligible area** (all of it if it has less); pixels are ranked by CF and the last one counts fractionally. A region is **viable iff it has eligible area** (land onshore, sea offshore): there is no CF floor and no minimum area (D-123, T059; T054 used a 15% floor, D-113, and 20% before that). Weak regions keep their real, low headline. Potential (`<tag>_viable_area_km2`, and `<tag>_room_gw` at 5 MW/km² onshore and 4 MW/km² offshore) counts only eligible area at ≥ 15% net CF (D-114, kept by D-123), so a weak region has wind in the simulation but may have no potential (288 onshore and 116 offshore regions in the deployed data). In the code the two lines are separate: `VIABLE_CF_THRESHOLD = 0` (`--viable-cf`) and `AREA_CF_THRESHOLD = 0.15` (`--area-cf`). The hourly ERA5 profile is scaled to the headline (column `<tag>_cf_target`) with a speed multiplier k capped at 0.6–1.8; where k = 1.8 is not enough the profile stays below the headline (`<tag>_clamped = 1`; 969 onshore and 116 offshore regions in the deployed 4,465-region data). Regions without eligible area get an all-zero profile.

Before T054 (data up to 27 Oct 2026) the headline was the area-weighted P90 and a region also needed 200 km² clearing 20%; `site_selection.py --rule p90` rebuilds that data byte for byte (its area line stays at 20%). P50 and P90 are still written as diagnostics.

October 2026 effect (4,998 regions): onshore viable regions 3,442 → 3,988 (T054, 15% floor) → 4,424 (T059, no floor), offshore 884 → 1,186 → 1,324; onshore potential over viable regions 342 → 405 TW. On the deployed 4,465 regions (Antarctica and Greenland out, T057): onshore 4,385, offshore 1,277, no wind at all 13. See `team/contracts/T054.md`, `team/handoffs/T054.md` and `team/handoffs/T059.md`.

## Rebuilding the wind data without writing into the workspace (T054)
`scripts/pipeline/wind/t054_sensitivity/harness.py` runs this repo's code against a workspace from a scratch run directory: inputs are symlinked and only read, every output is a real file in the run directory, and it refuses to start with under 10 GB free disk or with any write target under `~/Library/CloudStorage`, and checks afterwards that nothing in the workspace changed:

```
python3 -I pipeline/scripts/pipeline/wind/t054_sensitivity/harness.py --workspace <workspace> --repo . \
    --run-dir <scratch>/run --rule best-area --steps site,profiles,run3d,daily --configs 290:3216
python3 -I pipeline/scripts/pipeline/wind/t054_sensitivity/compare_runs.py --run <scratch>/run \
    --shipped deployment/data --ws-input <workspace>/input_data
```
Siting takes about 1.5 min and an 11 GB peak memory footprint; profiles 1.5 min; run3d over the 2,926 wind configurations 5 min (`--skip-samples`); the daily extract 20 s; about 0.5 GB of disk. Configurations 0–289 are the solar-only `summary_w0` and do not depend on wind.

The pipeline is otherwise not run in this repo; no checks depend on it.

## Sample Days daily extract (T051)
`scripts/sample_days/build_daily_cf.py` builds `deployment/data/daily_cf_2024.parquet`, the data behind the Sample Days tab: the daily mean capacity factor for 2024 per region (4,998 regions × 366 days as built; 4,465 once Antarctica and Greenland are dropped, below) for solar, onshore wind and offshore wind (columns `location_id`, `date`, `solar`, `wind_on`, `wind_off`; 4 dp; zstd). Offshore is null in the regions with no eligible sea (3,674 of 4,998 since T059, which dropped the CF floor; 3,188 of 4,465 after T057).

- **Input:** the hourly profiles above (`solar_profiles.parquet`, `wind_profiles_on.parquet`, `wind_profiles_off.parquet`; not in the repo). Solar output comes from NASA POWER, as credited in the app's Data Sources panel (confirmed by Daan Walter, 27 Oct 2026; the Renewables.ninja entry in `workspace/input_data/sources.txt` does not apply to these profiles). The hourly wind shape comes from ERA5 100 m winds (Copernicus Climate Change Service, Hersbach et al. 2020). 8,784 hours; hour 0 = 2024-01-01 00:00 **local solar time**: the solar profiles peak at about 11:30 at every longitude, and `build_wind_profiles.py` shifts ERA5 (UTC) by round(longitude / 15) hours onto that clock.
- **Days** are local solar days (midnight to midnight on that clock). Because the wind shift wraps round the year, 1 January and 31 December in the far east and west hold up to about 12 hours from the other end of 2024.
- **Check built in:** the script stops if any profile has missing or duplicate hours, if the three files cover different regions, or if the annual mean of the stored (4 dp) daily values is half a unit or more away from the hourly annual mean.
- **Same data as the app:** for builds without a battery, these profiles reproduce the shipped `annual_cf` in the summary slices to within 0.00005 in every region (T051 audit).
- **Run** (from the repo root, with the profiles in `workspace/input_data/`): `python3 pipeline/scripts/sample_days/build_daily_cf.py`. Takes about 15 s and writes a 7.7 MB file. Use `--input-dir` and `--out` to read and write elsewhere.

## Antarctica and Greenland are left out (T057, D-120)
The pipeline builds 4,998 regions; the atlas maps 4,465. `scripts/exclude_regions/` drops the other 533 and their land:

- `excluded_regions.json` – the list and its rule: the 443 regions whose primary country (`voronoi_overlapping_countries.csv` `country_iso3`) is ATA, the 84 whose primary country is GRL, and the 6 regions with no country row whose site lies on Antarctic land; cells shared with another country follow their primary country (the two CAN|GRL cells with Canada primary stay). Also the 124 `world.geojson` polygons that go: 107 wholly south of 60°S and 17 nearer Greenland than any other country (Natural Earth 110m admin-0), each identified by the SHA-256 of its line. Written once by `derive_excluded.py` from the unfiltered data.
- `apply_exclusion.py` – drops those rows from every `summary_*.parquet`, `daily_cf_2024.parquet` and `voronoi_*.csv` (population by site coordinates, the rest by `location_id`) and the polygons from `world.geojson`. Parquet files are rewritten with the pipeline's own writer settings, which reproduce an unfiltered file byte for byte. It is idempotent and stops on any file in `deployment/data` it does not know. **Run it after any step that rewrites `deployment/data`**: `python3 -I pipeline/scripts/exclude_regions/apply_exclusion.py`.
- `verify_exclusion.py --old <unfiltered data>` – proves every file equals the old one minus exactly those rows, value for value, with the same schema, compression and encodings, and that every other file is byte-identical.

Run every pipeline step on the unfiltered data and the exclusion last. It matters most for `scripts/wind_potential/build_offshore_potential.py`, which assigns sea to the nearest site: without the Greenland sites their sea would go to Iceland's and Canada's cells. Whether `scripts/wind_costs/build_wind_costs.py` (WACC donors are chosen from overlapping cells) gives the same values on the filtered data has not been checked.

## Crimea and Sevastopol are part of Ukraine (T079)
Natural Earth's default admin-0 edition (v5.1.1, the "de facto" view) draws Crimea and Sevastopol inside Russia, and every workspace step that gives a cell its country joins to it (`voronoi_overlapping_countries.py`, `voronoi_wacc.py`, `voronoi_gas_prices.py`, `voronoi_diesel_prices.py`, `voronoi_local_capex.py`; centroid in polygon). Until T079 the atlas therefore put regions 212 (south-west Crimea, Sevastopol) and 4165 (Kerch peninsula) in Russia. The atlas follows international law (UN General Assembly resolution 68/262): Crimea and Sevastopol are Ukraine.

- `scripts/country_overrides/ukraine_crimea.py` – `reassign_crimea(countries)` moves the Crimea polygon from Russia to Ukraine in any Natural Earth admin-0 layer (Crimea = Natural Earth 1:10m admin-1 UA-43 + UA-40, stored as `crimea_sevastopol_ne10m.geojson`). **Any rebuild of the workspace country steps must pass the admin-0 layer through it straight after reading it.** Those scripts are not in this repo, so the step below is the guard.
- `scripts/country_overrides/apply_crimea_override.py --cells <workspace>/outputs/voronoi_cells.geojson --admin0 <workspace>/input_data/ne_110m_admin_0_countries.shp` – redoes the upstream country step for the cells that touch Crimea (after checking that the upstream rule on the uncorrected layer reproduces the shipped rows), gives cells that move the country-level gas, diesel, solar and battery capex values their new country's other cells carry, and rewrites only those rows. Then run `python3 scripts/wind_costs/build_wind_costs.py` (WACC, wind capex and O&M by country). **Run both after any step that rewrites these files from the workspace**, before `apply_exclusion.py`. Idempotent.
- Natural Earth publishes a Ukraine point-of-view edition (`ne_10m_admin_0_countries_ukr`, v5.1.1) only at 1:10m; there is no 1:110m or 1:50m `_ukr` file. Switching to it would redraw every border at 1:10m and move country shares in border cells worldwide, so the pipeline keeps 1:110m with this explicit override.
- Wind capacity factors do not depend on it: the onshore Europe level factor is by location and Ukraine is in its country list (D-135). Raster-based layers (demand, population, grid reliability, PV and offshore potential, fossil and GEM capacity) carry no country.

## D-134 wind rule (T061, Oct 2026)
Since T061 the headline is the **mean net CF of the best 20% of a region's eligible land or sea, with a 500 km² floor** (`site_selection.py --rule share --share 20`). It is multiplied by a calibration factor: **×0.879 onshore in European regions, ×0.777 offshore** (`--level-factors`, columns `on_level_factor` / `off_level_factor`). Eligibility adds all designated or inscribed WDPA areas (October 2026) and GHSL settlement cells ≥ 10% built, capped at 1 − the protected share (`t061/eligibility.py`). `--rule best500` and `--rule p90` still rebuild the older data byte for byte. The standing check is `wind/calibration.py` (observed fleet and IRENA new-build CFs in `wind/data/calibration_observed.csv`). See `team/reports/T061-site-rule.md` and `T061-phase-d.md`.
