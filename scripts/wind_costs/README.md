# Local wind costs (T024)

Builds per-cell onshore and offshore wind capex, O&M and WACC, and solar WACC, for the atlas's cells (4,926 when built; the shipped files keep 4,399 since T057 dropped Antarctica and Greenland with `pipeline/scripts/exclude_regions/`, which runs after this script). Method: `team/evidence/wind-costs.md` section 7 as amended by decisions D-054 to D-059 (section 9 of the evidence file). Every value carries a source tag; source IDs resolve in `team/evidence/wind-costs.md`.

## Re-run

```
# 1. only if the offshore sites change: downloads, then sampling (needs numpy + h5py)
curl -L -o <dl>/ETOPO_2022_v1_60s_N90W180_bed.nc \
  https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc
curl -L -o <dl>/ne_10m_coastline.zip https://naciscdn.org/naturalearth/10m/physical/ne_10m_coastline.zip && unzip -d <dl> <dl>/ne_10m_coastline.zip
curl -L -o <dl>/ne_10m_land.zip https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip && unzip -d <dl> <dl>/ne_10m_land.zip
python3 -I scripts/wind_costs/sample_offshore_sites.py --etopo <dl>/ETOPO_2022_v1_60s_N90W180_bed.nc \
    --coast <dl>/ne_10m_coastline.shp --land <dl>/ne_10m_land.shp

# 2. the dataset (stdlib only; about 5 s)
python3 scripts/wind_costs/build_wind_costs.py            # options: --floating-depth-m 60 --anchor-years 3 --ac-dc-km 100

# 3. cross-checks (needs openpyxl; changes no dataset value)
python3 scripts/wind_costs/crosscheck.py
# independent shore-distance spot-check (OSM land polygons, ODbL; needs numpy)
curl -L -o <dl>/osm.zip https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip && unzip -d <dl> <dl>/osm.zip
python3 -I scripts/wind_costs/verify_shore_distance.py --osm <dl>/simplified-land-polygons-complete-3857/simplified_land_polygons.shp
```

Downloads used on 26 Oct 2026: ETOPO file 491,284,376 bytes, sha256 `d92483407c6a8f87be6fc8a47e4809332357e2d40c90a49de2e91c39cce08c54` (US federal government data, NOAA NCEI; cite doi:10.25921/fd45-gt74). Natural Earth coastline zip sha256 `bfa04cdbcbef07ef90dfca1dabb48062eca29900a113df0f389303e255484017` (VERSION 5.0.0-pre9) and land zip sha256 `e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc` (VERSION 5.1.1), both public domain. Neither is committed; `inputs/offshore_sites.csv` holds the sampled values.

## Inputs (`inputs/`)

| File | Source | How it was extracted |
|---|---|---|
| `hatton_v3_wacc.csv` | SRC-HATTON-V3-2026 (CC BY 4.0) | futures `hatton.hatton_cost_of_capital_long`, `iso3 IS NOT NULL`, technologies Floating Offshore, Offshore Wind, Onshore Wind, Solar PV, years 2024, 2025, 2035, 2036 (174 countries). Verified against the database by per-column sums and an iso3-weighted checksum (all 16 match) |
| `irena_onshore_country_tic.csv` | SRC-IRENA-RPGC-2025 fig 2.4 | futures `irena_costs_full.f_2_4_onshore_wind_weighted_average_tics_in_selected`, 30 countries, 2010–2025, 2025 USD/kW. Verified by total, weighted sum and value count |
| `irena_onshore_region_tic.csv` | SRC-IRENA-RPGC-2025 table 2.1 | futures `irena_costs.onshore_wind_cost_ranges_long`, `metric = 'total_installed_cost'`, 2025 |
| `irena_onshore_projection.csv` | SRC-IRENA-RPGC-2025 fig 1.7 | futures `irena_costs_full.f_1_7_weighted_average_tics_of_onshore_wind_systems`: Historical 2023–24, 2025 observed, Refined 2025/2030/2035 |
| `irena_offshore_tic.csv` | SRC-IRENA-RPGC-2025 figs 4.4 and 4.3 | futures `irena_costs_full.f_4_4_…` (2020–2025 by country/region) and `f_4_3_…` (global weighted average) |
| `irena_offshore_sites.csv` | SRC-IRENA-RPGC-2025 fig 4.2 | published 2025 capacity-weighted sites (China, Europe, Other) from `f_4_2_…`; the Global row is the capacity-weighted average of the 29 projects of 2025 in the same table |
| `irena_om.csv` | SRC-IRENA-RPGC-2025 tables A3, A5 (= annex table A6, offshore; SRC-IRENA-RPGC-2025-ANNEX) | futures `irena_costs_full.t_a3_…` and `t_a5_…` (2025 USD/kW/yr), plus the annex's printed values (2024 USD, annex pp. 12 and 15) |
| `irena_lcoe_reference.csv` | SRC-IRENA-RPGC-2025 table 2.3, fig 4.10 | for the LCOE sanity check only |
| `dea_offshore.csv` | SRC-DEA-TC-2026 (CC BY 4.0) | table 7 cost function (2023 prices), table 6 price factor, data sheets 20 and 21 (2020 prices), data sheet sha256 `afb78ded…2704bb9` |
| `country_map.csv` | SRC-IRENA-RPGC-2025-ANNEX Annex II, SRC-OECD-MEMBERS (World Bank `region/OED` list) | each of the 167 cell country codes: IRENA region, OECD flag, data key (SOL→SOM); 11 codes not in Annex II assigned by geography or nearest cell (see `note`) |
| `offshore_sites.csv` | SRC-ETOPO-2022, SRC-NE-COAST-10M | T067 (T065-05): `pipeline/scripts/pipeline/wind/t067/offshore_area.py` – the area-weighted depth (eligibility depth raster, ETOPO 2022 60" at 0.02°, Caspian from its −28 m surface) and great-circle distance to the 10 m coastline over exactly the pixels and weights of the cell's simulated CF level (best 20% of eligible sea, 500 km² floor); `shore_method = area_weighted_best20`; min/max columns for the spread. Proof in the script: the same weights reproduce `off_cf_best` for all 1,234 zones |
| `offshore_zone_sites.csv` | SRC-EMODNET-WINDFARMS-2025, SRC-ETOPO-2022, SRC-NE-COAST-10M | T082: `pipeline/scripts/pipeline/wind/offshore_zones.py sites` – for the 15 regions with at least 100 km² of eligible sea inside their own country's designated or tendered zones (EMODnet Human Activities wind-farm polygons, downloaded 3 Nov 2026, sha256 `7c2271c8…f402b2e`; NL, DE, DK, BE, FR, GB; statuses Production, Construction, Approved, Planned), the area-weighted depth and coast distance over all those pixels (`shore_method = zone_emodnet_2025`). These rows replace the region's `offshore_sites.csv` row |
| `national_offshore_capex.csv` | SRC-METI-SANTEII-059-2020, SRC-MOEA-FIT-113-2023, SRC-FRED-2026 | T082: Japan 51.2 万円/kW (METI committee meeting 59, 15 Sept 2020, bottom-fixed, incl. part of the grid connection), Taiwan NT$150,700/kW (MOEA FY2024 tariff review, wind group meeting 3, 14 Sept 2023); converted at the price year's FRED annual exchange rate and US CPI-U (2025: mean of the 11 published months) |
| `offshore_sites_point_t061.csv` | as above | the point file used until T067: depth and distance at the single `off_site` (arg-max of the 10 km focal mean), from `sample_offshore_sites.py`; kept for the before/after |

The cell keys come from `deployment/data/voronoi_overlapping_countries.csv` (the only file with a country for every cell) and offshore viability from `voronoi_wind_resource.csv` (SRC-ATLAS-DATA).

## Method

- **Country key:** overlapping-countries `country_iso3`, SOL→SOM. Countries without data get one donor country each (D-065):
  - ATA and ATF have no IRENA region; 21 codes have no Hatton value.
  - The donor is the data country sharing the most overlapping cells with it (`country_iso3s`, a land neighbour).
  - Failing that, the data country holding the nearest cell for most of its cells.
  - Ties go to the smaller minimum cell distance. The tag is `donor:…(land_neighbour|majority_nearest)`, and `source = nearest_country` in the WACC files.
- **Onshore capex, "2024" anchor (D-058: IRENA 2025 data):** mean of fig 2.4 values in 2023–2025 for the 30 listed countries; otherwise IRENA table 2.1 region (Annex II grouping; Middle East → Other Asia; Central America and Caribbean, Canada, Mexico → Other North America).
- **Onshore 2035 (D-064):** anchor × Refined 2035 / the mean of the matching fig 1.7 series over the anchor's own years (Historical 2023–24 and observed 2025; 2025 alone for regional anchors). Series: China, India, US, Brazil, Europe for Annex II Europe, else Global. **2050:** 2035 × (Refined 2035 / Refined 2025)^1.5.
- **Offshore capex, 2024:** (T067: priced at the area its CF comes from, `offshore_sites.csv` above; no site is floating since the area is screened at ≤ 60 m) base = fig 4.4 mean of 2023–2025 for CHN, KOR, GBR, DEU, FRA, USA; Europe or Asia (ex-China) region for other Annex II Europe/Asia countries; else IRENA global 2025, $2,930.95/kW (D-057). Site multiplier M = C(cell) / C(reference site, fixed AC), DEA table 7: C_fixed = 0.20 + 1.35 + 0.45 + 0.005·depth + 0.05 + sub + cable·km; C_float = 0.25 + 1.35 + 2.65 + 0.05 + sub + cable·km (no depth term); sub = 0.65 (AC) or 1.20 (DC) m€/MW; cable = 0.00505 (AC) or 0.0036 (DC) m€/MW/km. Reference site: China 21 m/24 km, Europe 39/27, Other 35/18, Global 26.44/24.17 (IRENA fig 4.2).
- **Site class:** floating if ETOPO depth > 60 m (D-064), else fixed; DC beyond 100 km. Distance clamped to 10–250 km and fixed depth to 10–60 m (DEA's fixed range ends at 50 m; 50–60 m is extrapolated), flagged. Flags in `wind_off_flags`: `dist_clamped`, `depth_clamped`, `fixed_depth_beyond_dea_50m` (fixed sites at 50–60 m), `depth_beyond_dea_range`, `etopo_land` (ETOPO z ≥ 0 at the site), `site_inland_ne` (inside a Natural Earth land polygon: lakes incl. the Caspian and Great Lakes, below-sea-level land such as the Caspian depression and Lake Eyre, and Greenland's ice-sheet bed; these sites are costed like open sea and are indicative only), `site_not_viable`, `no_site`. Cells without an `off_site` (3,658) get class `none` and the value at the reference site (M = 1).
- **National offshore capex (T082):** Japan and Taiwan take their regulator's capex (`national_offshore_capex.csv`, about $5,998 and $5,140/kW in 2025 USD) as the base at the IRENA "Other" reference site (35 m/18 km), then the same DEA site multiplier; the 1.5× onshore floor (D-146) is not applied to them. Flag `national_capex`.
- **Designated zones (T082):** where `offshore_zone_sites.csv` has a row, the cost site is the zone (flag `zone_site`); the CF level and profiles for those regions come from the same zone pixels (`offshore_zones.py profiles`).
- **Generator / export split (T082):** export system = DEA substation + export cable × distance at the cell's site; share of the site cost 23–43%, held over the years. Written raw as `wind_off_{fixed,float}_{gen,export}_{y}`.
- **TSO export life (T082):** where the grid operator owns the export system (cells of NLD, DEU, DNK, BEL, FRA inside 35–72° N, 15° W–35° E; `wind_off_tso = 1`, flag `tso_export_40y`) it is annualised over 40 years at the cell's Hatton 2025 offshore WACC: `wind_off_fixed_{y}` = generator + export × CRF(w, 40)/CRF(w, 30), the capex with the same annual cost over the app's 30-year wind life. In Global WACC mode the app applies its own WACC to this capex, so the 40-year saving is off by a fraction of a per cent there.
- **Offshore 2035/2050:** fixed × DEA fixed sheet ratio (AC 0.809/0.714, DC 0.838/0.742); floating × DEA floating sheet value / table 7 floating cost at the sheet site in 2020 EUR (AC 0.641/0.498, DC 0.685/0.548).
- **O&M ($/kW/yr):** futures values, except where a value differs from the annex print by more than 3% after the table's median 2024→2025 factor. Then the annex value × that factor is used, tagged `annexA3x1.0250`; this applies only to A3 "Other OECD" (46.1) and "Other non-OECD" (38.9). Onshore A3 by country, else Other OECD / Other non-OECD; × DEA onshore fixed O&M ratio 0.958 (2035, DEA 2030 column) and 0.897 (2050). Offshore A5 likewise; fixed × 0.727 (2035), 0.636 (2050); floating × 2.0 (2024), 0.955 (2035), 0.636 (2050).
- **WACC (D-054, D-055):** Hatton v3 2025, real: Onshore Wind, Offshore Wind (fixed and `none`), Floating Offshore (floating), Solar PV. Year columns 2024, 2035, 2050 (= 2036).

## Outputs

`deployment/data/voronoi_local_capex.csv` – existing columns unchanged except `wind_on_2024/2035/2050` and `wind_off_2024/2035/2050` (refilled; `wind_off_*` follows the cell's class). New: `wind_iso3`, `wind_off_class`, `wind_off_depth_m`, `wind_off_shore_km`, `wind_off_flags`, `wind_off_fixed_{y}`, `wind_off_float_{y}`, `wind_on_om_{y}`, `wind_off_om_{y}` (by class), `wind_off_fixed_om_{y}`, `wind_off_float_om_{y}`, `wind_cost_src`.

`deployment/data/voronoi_wacc_wind.csv` – same columns, refilled (`country_iso3` now from the overlapping-countries key, so France and Norway are no longer blank); new `wind_off_class`, `wind_off_fixed_wacc_percent`, `wind_off_float_wacc_percent`, `{wind_on,wind_off_fixed,wind_off_float}_wacc_{2024,2035,2050}`.

`deployment/data/voronoi_wacc.csv` – same columns, `wacc_percent` = Hatton v3 2025 Solar PV; new `wacc_source`.

`out/country_anchor_history.csv` (D-057 history, trend, variance, flags `thin` and `high_variance`: SD of year-to-year log change > 0.15), `out/summary_by_country.csv`, `out/wind_cost_provenance.csv` (long source text per cell), `out/crosscheck_*.csv`, `out/verify_shore_distance.csv`.

## Not used

NREL ATB 2025 (SRC-NREL-ATB-2025) is read by `crosscheck.py` for the site gradient and floating premium only. IEA data: not read by these scripts and no value from it is used anywhere (D-059). BNEF and Wood Mackenzie-derived figures (IRENA figs 2.9, 4.8): not used (D-058).
