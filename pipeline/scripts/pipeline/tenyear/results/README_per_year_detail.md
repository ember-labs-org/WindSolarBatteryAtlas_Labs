# T064 per-year detail (not for the tool)

Ten-year weather run, 2015–2024, at the T061 sites and levels (D-134/D-135; task/T061 25dd2fa). Deployed regions only (4,465; Antarctica and Greenland excluded). Same layout as T060's ~/wind-atlas-T060/results.

- `per_year_dense.parquet`: every slider configuration. location_id, config (index in configs.json), cf_2015 … cf_2024 (that calendar year's CF from the continuous run, battery state carried across years), cf_mean (ten-year CF = served ÷ demand over 87,672 h, unrounded; the app's annual_cf is this rounded to 4 dp).
- `per_year_wind_mix.parquet`: the same for the combined onshore + offshore add-on (config = j in addon.json).
- `per_year_large.parquet`: the same for the large solar + battery add-on (cold start 1 Jan 2015). Byte-for-byte the same inputs as T060 (solar only), so T060's warm-start sensitivity (large_sensitivity*.json there) still applies.
- `profile_cf_by_region_year.parquet`: the hourly input profiles' mean CF per region, technology and year (wind with the 2024 k).
- `cf_ratio_by_region.csv`: ten-year mean ÷ 2024 per region and technology.
- `weather_by_band.csv`, `weather_cities.csv`: weather by latitude band and for the 15 cities.
- `report_t064.md` / `.json`: the report tables (report_t064.py).
- `shots/`: app screenshots on data_10y.

Years are local-solar-time calendar years (the profiles' clock; A-T060-1 wrap). Hours per year: 8,760, or 8,784 in 2016, 2020 and 2024.
Raw ERA5 (all nine years, T061 points) is in `../raw/era5/`; per-year profiles in `../work/{solar,wind}/`; run parts in `../work/parts10`, `../work/parts24`.
