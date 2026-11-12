# Wind + Solar + Battery Atlas

An interactive web-based tool that simulates and visualizes the feasibility of achieving 24/7 baseload power supply using solar photovoltaics, onshore or offshore wind, and battery storage across thousands of locations worldwide.

## Overview

The Wind + Solar + Battery Atlas answers a fundamental question: **Can solar, wind and battery storage alone provide constant "baseload" power 24/7/365?**

This tool simulates a 1 GW constant load at thousands of locations worldwide, calculating:
- How much solar capacity (GW_DC), wind capacity (GW, onshore or offshore) and battery storage (GWh) is needed to meet that load
- The resulting **Capacity Factor**: the share of the constant 1 GW load's annual energy that the build supplies
- The **Levelized Cost of Energy (LCOE)** for each configuration
- Supply-demand matching based on population density or existing fossil fuel infrastructure

## Data Sources

### 1. Solar Irradiance & Weather Data
- **Source**: NASA POWER (Prediction Of Worldwide Energy Resources)
- **Data Type**: Hourly solar irradiance, temperature, and meteorological data
- **Coverage**: Global grid with ~0.5° resolution
- **Purpose**: Calculate realistic solar generation profiles for each location

### 2. Wind Resource Data
- **Source**: Global Wind Atlas 4 (DTU Wind Energy and the World Bank) for siting and long-run capacity factor, and ERA5 100 m winds for the hourly shape, as set out in the app's info panel (`index.html`, "Data Sources")
- **Method** (D-134, D-135): eligible land excludes the World Bank/ESMAP masks, every designated or inscribed WDPA protected area (October 2026; offshore, every marine protected area) and every GHSL settlement cell at least 10% built. Each region's wind level (`on_cf_best`) is the mean net capacity factor of the windiest 20% of its eligible land, at least 500 km² (all of it, if it has less). The headline level (`on_cf_target`) is that mean times a level factor calibrated to IRENA new-build capacity factors: ×0.879 onshore in Europe by location (including Russia west of 60°E), 1.0 onshore elsewhere, ×0.777 offshore everywhere (fitted on four countries). There is no cut-off (D-123): every region with eligible land gets that wind, however weak. The same rule applies offshore, on eligible sea (fixed-bottom depths)
- **Cap**: each hourly profile is ERA5 100 m wind speed scaled by one factor k to reach that headline level, with k capped at 1.8. Where the cap binds, the simulation runs below the headline level: 698 of the 4,380 onshore regions, 304 of them below 15% and 386 below 20% (Bogotá: 18% headline, 11% simulated), and 10 of the 1,235 offshore regions, one below 15% and one below 20%
- **File**: `data/voronoi_wind_resource.csv` - per-region onshore (`on_*`) and offshore (`off_*`) siting results, including viability (`on_viable`, `off_viable`), the windiest-fifth mean (`on_cf_best`, `off_cf_best`), the level factors (`on_level_factor`, `off_level_factor`), the headline level (`on_cf_target`, `off_cf_target`, the mean times the factor), the simulated capacity factor (`on_final_cf`, `off_final_cf`) and whether the cap binds (`on_clamped`, `off_clamped`)
- **Wind costs**: built per cell by `scripts/wind_costs/build_wind_costs.py` (stdlib Python, deterministic, about 5 seconds). Method, sources, checksums and re-run steps are in `scripts/wind_costs/README.md`; the reasoning is in `team/evidence/wind-costs.md`
  - `data/voronoi_local_capex.csv`: onshore (`wind_on_*`) and offshore (`wind_off_*`) CAPEX in $/kW for 2024, 2035 and 2050, and O&M in $/kW/yr (`wind_on_om_*`, `wind_off_om_*`). Onshore starts from IRENA's installed cost, the 2023–25 mean (D-064) where IRENA lists the country and IRENA's 2025 regional figure otherwise (*Renewable Power Generation Costs in 2025*). Offshore starts from the IRENA country or regional average and is scaled to each cell's site by the Danish Energy Agency cost function for water depth and distance to shore. The site is fixed-bottom, or floating beyond 60 m depth (`wind_off_class`); `wind_off_*` follows that class and the `wind_off_fixed_*` and `wind_off_float_*` columns give both. The 2035 and 2050 values scale the 2024 anchor: onshore by IRENA's projected cost path, offshore by the DEA catalogue's ratios
  - `data/voronoi_wacc_wind.csv`: onshore (`wind_on_wacc_percent`) and offshore (`wind_off_wacc_percent`) cost of capital, plus the fixed and floating offshore values, for 2024, 2035 and 2050. All come from Hatton et al. v3 (Zenodo, February 2026), 2025 values, read as real rates. A country with no Hatton value takes one donor country: its land neighbour with the most overlapping cells, else the nearest country. `wind_wacc_source` records the source and donor for each row
  - `data/voronoi_wacc.csv`: solar cost of capital from the same Hatton v3 vintage, so solar and wind share one source
  - Local mode reads the CAPEX, O&M and cost-of-capital columns. Floating sites take the floating CAPEX, O&M and cost of capital only when both CAPEX and WACC are set to Local; otherwise every offshore site is priced as fixed-bottom. Global mode prices wind O&M as a share of CAPEX (below)

### 3. Population Data
- **Source**: NASA SEDAC (Socioeconomic Data and Applications Center)
- **Dataset**: Population density for 2020
- **Purpose**: Map demand centers and analyze supply-demand matching
- **File**: `data/voronoi_population_2020.csv`

### 4. Fossil Fuel Infrastructure
- **Source**: Global Energy Monitor coal, oil & gas, bioenergy and nuclear plant trackers (December 2024 release, CC BY 4.0)
- **Data**: Location and capacity of coal, gas, and oil power plants
- **Purpose**: Analyze potential replacement scenarios for existing fossil infrastructure
- **Files**: 
  - `data/fossil_plants.csv` - Individual plant locations and capacities
  - `data/voronoi_fossil_capacity.csv` - Aggregated capacity by Voronoi cell

### 5. Technical Potential (Potential view)
- **Solar**: `data/voronoi_pvout_potential.csv`, PVOUT from the Global Solar Atlas (World Bank Group / Solargis) with ground-mount at 50 MW/km² (DC) on suitable land (cases 40 and 60; T085) and rooftop at 100 MW/km² on building footprints (Joshi et al. 2024, SSP2 2020; an upper estimate, no suitable-roof share applied, D-157), under World Bank/ESMAP and Solargis (2020) Level 1 (technical) or stricter Level 2 (policy) land limits; `pipeline/scripts/pipeline/solar/t085_density.py` sets the density
- **Onshore wind**: the atlas's own siting (`data/voronoi_wind_resource.csv`), at 5 MW/km² (low case 3 MW/km²) on eligible land that reaches at least a 15% net capacity factor (weaker land gets its wind in the simulation but is not counted as potential). Eligibility uses the World Bank / ESMAP Global PV Potential masks
- **Offshore wind**: `data/voronoi_wind_potential_offshore.csv`, from World Bank Group / ESMAP, *Global Offshore Wind Technical Potential* (2021, CC BY 4.0), reallocated to the atlas's cells by `scripts/wind_potential/build_offshore_potential.py` (see its README). ESMAP assumes 3 MW/km² at 7–8 m/s and 4 MW/km² above 8 m/s, within 200 km of shore, and splits fixed-bottom (0–50 m) from floating (50–1,000 m) at 50 m. The atlas's own simulation and costing split at 60 m, so sites between 50 and 60 m are floating in the Potential view but fixed-bottom in the Capacity Factor and LCOE views. Floating is not costed
- **Use**: technical potential only: the capacity that could physically fit, not what is likely to be built. Generation is capacity × the cell's capacity factor × 8,760 hours

### 6. Simulation Results
- **Pre-computed**: Capacity factor results for 3,216 solar, wind and battery configurations, listed in `data/configs.json`
- **Format**: Apache Parquet (compressed columnar format)
- **Main Files**: one summary slice per wind level and surface: `data/summary_w0.parquet` (no wind), `data/summary_w{wind}.parquet` (onshore) and `data/summary_wo{wind}.parquet` (offshore)
- **Complementarity data**: `data/complementarity.csv`, per region (4,349 regions with an onshore wind profile averaging at least 2%): the share of 7-day (`wk_*`) and 30-day (`mo_*`) windows in which solar, onshore wind or both at once average less than half their 2015–2024 mean, and the complementarity score (1 − r)/2 at day, week and calendar-month level (`c_day`, `c_week`, `c_month`). Built by `pipeline/scripts/pipeline/t093/build.py` from T088's daily series (`pipeline/scripts/pipeline/t088/daily.py`)

## Mathematical Model

### Core Simulation Logic

The model is based on **pre-computed simulation results** stored in Parquet files. The actual hourly simulation was performed offline (likely in Python) using NASA POWER solar irradiance data and the hourly wind profiles described above.

#### 1. Pre-computed Data

The browser application loads pre-computed results that include:
- **Capacity Factor** (`annual_cf`): the share of the constant 1 GW load's annual energy that the system supplies
- **Configuration Matrix**: Results for 3,216 solar, wind and battery combinations per location (`data/configs.json`)
  - No wind: solar 1-20 GW_DC and battery 0-36 GWh in 2 GWh steps (290 combinations). Solar above 10 GW_DC was only simulated with 18 GWh or more of storage
  - With wind: 1, 2, 3, 4, 5, 6 or 8 GW of wind, onshore or offshore, each with solar 0-10 GW_DC and battery 0-36 GWh in 2 GWh steps (209 combinations per wind level and surface)

**Note**: The solar and wind generation calculations (weather → power output) were done during the offline simulation phase. The browser only displays and analyzes the pre-computed results.

#### 2. Battery Dispatch Logic (from pre-computed simulation)

The offline simulation used the following battery dispatch logic:

**Energy Balance:**
```
Battery_SOC(t+1) = Battery_SOC(t) + Charge(t) - Discharge(t)
```

**Constraints:**
- `0 ≤ Battery_SOC(t) ≤ Battery_Capacity` (GWh)
- Charge rate limited by excess solar and wind generation
- Discharge rate limited by demand gap and battery capacity
- Round-trip efficiency: 90% (modeled explicitly as symmetric charge/discharge losses)

**Dispatch Priority:**
1. Solar and wind directly meet the 1 GW load when available
2. Excess generation charges battery (if not full)
3. Battery discharges to meet shortfall (if available)
4. Unmet demand recorded as "other" (system failure to meet load)

#### 3. Capacity Factor (Pre-computed)

The **Capacity Factor** in the data is the share of the constant 1 GW load's annual energy that the simulated system supplies (`annual_cf` in `simulation.py`):

```
Capacity_Factor = Energy_Served / Energy_Demanded
                = (Demand - Unserved_Energy) / Demand
```

Where, over the simulated year:
- `Demand` = 1 GW × the hours in the year (8,784 GWh: the 2024 weather year is a leap year; `hours` in `data/configs.json`)
- `Unserved_Energy` = the sum over all hours of the load left after solar and wind output and battery discharge, in GWh

A capacity factor of 90% means solar, wind and batteries supply 90% of the energy that a flat 1 GW load would use over the year. It is an energy share, not a count of hours: an hour that is only partly served counts for the part that is served, so the share of hours with the load fully met is lower than the capacity factor. The article uses the same definition, which it calls uptime.

**Note**: This was calculated during the offline simulation. The browser simply displays the pre-computed `annual_cf` value from the Parquet files.

### Economic Model (LCOE)

The **Levelized Cost of Energy (LCOE)** represents the average cost per MWh of electricity produced over the system lifetime.

**Important**: Unlike capacity factor, LCOE **IS calculated in the browser** in real-time. The browser takes the pre-computed `annual_cf` values and applies user-defined economic parameters to calculate LCOE on-the-fly.

#### Capital Recovery Factor

```
CRF(r, n) = [r × (1 + r)^n] / [(1 + r)^n - 1]
```

Where:
- `r` = WACC (Weighted Average Cost of Capital), default 7%; in Global mode wind uses the WACC plus a premium (default +0 points onshore, +0.92 points offshore, from Hatton et al. v3)
- `n` = Asset lifetime (30 years for solar, 25 years for wind, 20 years for batteries)

#### Annual Costs

**Solar Component:**

`Solar_CAPEX` is quoted per AC watt; it is divided by the ILR (DC:AC ratio) to convert
to a per-DC-watt cost before multiplying by the DC capacity (`Solar_Capacity_kW` is DC).

```
Solar_CAPEX_DC   = Solar_CAPEX / ILR
Solar_Annual_Cost = Solar_Capacity_kW × Solar_CAPEX_DC × CRF(WACC, Solar_Life)
                  + Solar_Capacity_kW × Solar_CAPEX_DC × Solar_OPEX_Pct
```

**Battery Component:**
```
Battery_Annual_Cost = Battery_Capacity_kWh × Battery_CAPEX × CRF(WACC, Battery_Life)
                    + Battery_Capacity_kWh × Battery_CAPEX × Battery_OPEX_Pct
```

**Wind Component:**

Onshore and offshore wind each have their own CAPEX and O&M share. In Local mode they use each cell's own CAPEX, O&M (in $/kW/yr) and cost of capital.
```
Wind_Annual_Cost = Wind_Capacity_kW × Wind_CAPEX × CRF(Wind_WACC, Wind_Life)
                 + Wind_Capacity_kW × Wind_CAPEX × Wind_OPEX_Pct
```

**Total Annual Cost:**
```
Total_Annual_Cost = Solar_Annual_Cost + Wind_Annual_Cost + Battery_Annual_Cost
```

Output degradation reduces the energy delivered: 0.5%/yr for solar and 0.2%/yr for onshore and offshore wind by default, each levelised over its own lifetime and cost of capital and weighted by the source's share of the build's potential output (capacity × its own capacity factor). Battery degradation is not modelled. There is no O&M escalation.

#### LCOE Calculation

```
LCOE = Total_Annual_Cost / Annual_Energy_Delivered

Where:
Annual_Energy_Delivered = Capacity_Factor × 8,760 hours × 1,000 MW × degradation factor
```

The LCOE uses a standard 8,760-hour year, while the capacity factors come from the 8,784-hour 2024 simulation (D-089). It reads the capacity factor as the share of a standard year's constant-load energy that is delivered, so it is applied to 8,760 hours without adjusting for the leap day; this was kept on purpose.

**Default Economic Parameters:**
- Solar CAPEX: $720/kW_AC (÷ ILR 1.3 ≈ $554/kW_DC)
- ILR (AC→DC): 1.3
- Battery CAPEX: $120/kWh
- Solar OPEX: 1.5% of CAPEX annually
- Battery OPEX: 2.0% of CAPEX annually
- Solar Lifetime: 30 years
- Battery Lifetime: 20 years
- Solar degradation: 0.5%/yr
- Wind CAPEX: $1,085/kW onshore (IRENA's 2023–2025 global mean) and $2,931/kW offshore (IRENA's 2025 global weighted average)
- Wind OPEX: 2.5% of CAPEX annually onshore, 3.5% offshore
- Wind Lifetime: 25 years
- Wind degradation: 0.2%/yr onshore and offshore (Hamilton et al., *Joule*, 2020)
- WACC: 7%, plus 0.92 points for offshore wind

**Browser Implementation**: See `computeLcoeMetrics()` in `js/workers/lcoe-worker.js`, and `computeLcoeMetricsFast()` in `js/app.js` for the main-thread fallback.

### Transmission Cost Analysis

When a reference location is selected in LCOE mode, the browser calculates transmission economics in real-time:

#### Breakeven Transmission Cost

For each location, the model calculates how much could be spent on transmission infrastructure while remaining cost-competitive with the reference location:

```
Annual_Savings = (LCOE_ref - LCOE_location) × Annual_Energy_Delivered
Breakeven_TX_Investment = Annual_Savings / CRF(TX_WACC, TX_Life)
Breakeven_Per_GW_km = Breakeven_TX_Investment / Distance_km
```

Where:
- `TX_WACC` = 6% (transmission infrastructure discount rate)
- `TX_Life` = 50 years (transmission line lifetime)
- `Distance_km` = Haversine distance between locations

This metric shows the maximum justifiable transmission cost per GW-km to economically transport power from a cheaper location.

**Browser Implementation**: See `computeTransmissionMetrics()` function in `js/app.js`.

## Visualization Modes

### 1. Capacity Factor Map
Shows the achievable capacity factor for a given solar, wind and battery configuration at each location. Warmer colors indicate higher reliability. Wind has two sliders, onshore and offshore (0-8 MW per MW of baseload, at the simulated levels only). Combined onshore and offshore builds are not simulated, so raising one slider resets the other to zero. With both at zero the map is the solar and battery atlas.

### 2. Complementarity
How solar and onshore wind make up for each other, over ten years of weather (2015–2024, the same hourly profiles as the simulation, averaged by day). Two views:
- **Droughts**: the share of weeks (7-day windows) or months (30-day windows) in which a source makes less than half its own ten-year average (T088's definition, as in the article). *Solar*, *Wind* or *Both* (both in drought at once); one colour scale for all three, so where the two rarely fail together the Both map is nearly empty. Hovering a region lists all three shares and how often both would be in drought at once if they were unrelated.
- **Complementarity**: (1 − r)/2, where r is the Pearson correlation of the raw solar and wind capacity factors, by day, by week (non-overlapping 7-day means) or by calendar month. 1 = they move in opposite directions, 0.5 = unrelated, 0 = they rise and fall together. The seasons are included, so at month level the score mostly reflects sunny summers and windy winters.

The tab does not depend on the sliders. Regions without an onshore wind profile averaging at least 2% are hatched. Mixing solar and wind cuts how often a drought happens far more than how deep the worst one is: it does not remove the need for storage or backup (T088).

### 3. LCOE Map
For a target capacity factor (e.g., 90%), shows the minimum LCOE achievable at each location. Once every wind configuration has loaded, the cheapest build is searched across all wind levels, onshore and offshore, as well as builds with no wind; until then, cost maps cover solar and batteries only. The *Include offshore wind* tick box (on by default) restricts the search to onshore wind. Where the target is met each region takes the cheaper surface; where it is missed, the build with the highest capacity factor. Includes:
- **Absolute LCOE**: Cost per MWh at each location
- **Delta Mode**: Cost difference relative to a selected reference location
- **Transmission Mode**: Breakeven transmission cost per GW-km

### 4. Supply-Demand Matching
Overlays capacity factor or LCOE data on either:
- **Population density**: Showing where people live vs. where solar, wind and storage are most viable
- **Fossil plant capacity**: Showing replacement potential for existing infrastructure

Includes analytical charts showing metrics by:
- Population percentile
- Latitude bands
- Geographic distribution

## Data Processing Pipeline

### Offline Simulation (Pre-computation)

The following steps were performed offline to generate the Parquet data files:

1. **Voronoi Tessellation**: Divide the globe into ~3,000-5,000 Voronoi cells for uniform spatial sampling. Antarctica and Greenland are then left out (533 regions; `pipeline/scripts/exclude_regions/`), so the data holds 4,465 regions and `data/world.geojson` has no land there
2. **Solar Data Collection**: Load hourly solar irradiance data from NASA POWER for each cell centre (8,784 hours in 2024)
3. **Wind Siting and Profiles**: Choose a good wind site in each region and build its hourly wind profile (see Wind Resource Data)
4. **Configuration Matrix**: For each location, simulate the 3,216 solar, wind and battery combinations in `data/configs.json`
5. **Hourly Simulation**: 
   - Calculate solar generation from irradiance, and wind generation from the wind profile
   - Simulate battery operation with dispatch logic
   - Track state of charge, charging, discharging
   - Calculate capacity factor and energy metrics
6. **Data Export**: Store results in compressed Parquet format

### Browser Application (Real-time)

The browser performs only these operations:

1. **Load Pre-computed Data**: Read Parquet files using WebAssembly
2. **LCOE Calculation**: Calculate levelized costs using the pre-computed capacity factors and user-defined economic parameters
3. **Transmission Analysis**: Calculate distance-based transmission economics when reference location selected
4. **Visualization**: Render maps, charts, and time-series animations
5. **Aggregation**: Compute statistics by population percentile, latitude, etc.

## File Structure

```
deployment/
├── index.html                          # Main application interface
├── css/
│   └── style.css                       # Styling
├── js/
│   ├── app.js                          # Main application logic
│   ├── map.js                          # Leaflet map rendering
│   ├── complementarity.js              # Complementarity tab (droughts and the 0–1 score)
│   ├── voronoi-canvas.js               # Canvas renderer for the Voronoi map
│   ├── data.js                         # Data loading utilities
│   ├── utils.js                        # Shared helpers, incl. the Chart.js loader
│   ├── workers/lcoe-worker.js          # LCOE search off the main thread
│   ├── parquet_wasm.js                 # Parquet reader (WebAssembly)
│   └── apache-arrow.js                 # Arrow data format support
└── data/
    ├── configs.json                         # Every simulated configuration
    ├── summary_w0.parquet                   # Pre-computed CF results, no wind
    ├── summary_w{wind}.parquet              # ... onshore wind, one per level
    ├── summary_wo{wind}.parquet             # ... offshore wind, one per level
    ├── voronoi_wind_resource.csv            # Wind siting result by cell
    ├── voronoi_local_capex.csv              # Regional CAPEX and O&M by cell, incl. wind
    ├── voronoi_wacc.csv                     # Solar cost of capital by cell
    ├── voronoi_wacc_wind.csv                # Wind cost of capital by cell
    ├── voronoi_pvout_potential.csv          # Solar technical potential by cell
    ├── voronoi_wind_potential_offshore.csv  # Offshore wind technical potential by cell (ESMAP)
    ├── voronoi_population_2020.csv          # Population by cell
    ├── voronoi_fossil_capacity.csv          # Fossil capacity by cell
    ├── fossil_plants.csv                    # Individual plant data
    ├── complementarity.csv                  # Droughts and complementarity per region, 2015–2024
```

## Technical Implementation

### Frontend Technologies
- **HTML5/CSS3/JavaScript**: Core web technologies
- **Leaflet.js**: Interactive map rendering
- **D3.js**: Voronoi geometry and color scales; the cells are drawn on one `<canvas>` (`js/voronoi-canvas.js`, `FEATURE_VORONOI_CANVAS`) rather than ~5,000 SVG paths. `?canvas=0` forces the SVG path for comparison
- **Chart.js** (4.4.1, pinned): the population charts, loaded on first use
- **Tailwind CSS**: Utility-first styling framework

### Data Formats
- **Apache Parquet**: Columnar storage for efficient compression and fast queries
- **Apache Arrow**: In-memory columnar format for zero-copy data access
- **WebAssembly**: High-performance Parquet parsing in the browser
- **GeoJSON**: Vector geographic data for map boundaries
- **CSV**: Simple tabular data for population and plant locations

### Performance Optimizations
- Pre-computed simulation results (no real-time simulation in browser)
- Compressed Parquet summary slices (about 3-4.5 MB each), loaded one wind level at a time
- Lazy loading of the Complementarity data (only when the tab opens)
- Voronoi cells drawn on a single canvas, with geometry reused across pans and recolours
- Debounced UI updates to prevent excessive re-rendering

## Usage

1. **Select View Mode**: Choose between Capacity Factor, Complementarity, Potential, LCOE, or Supply-Demand Matching
2. **Select Configuration**: Use sliders to choose from pre-computed solar capacity (1–20 GW_DC per GW of load), wind capacity (0–8 GW per GW, onshore or offshore, set by separate sliders) and battery storage (0–36 GWh per GW) combinations; the sliders show the same ratios as MW per MW. The Potential view covers solar, onshore and offshore wind
3. **Explore the Map**: Click locations to see detailed metrics for the selected configuration
4. **Analyze Economics**: In LCOE mode, adjust economic parameters (CAPEX, OPEX, WACC) to see how costs change
5. **Compare Locations**: Select a reference location to see relative costs and transmission economics
6. **Compare Solar and Wind**: In Complementarity, switch between solar, wind and both to see how often they are in drought together, or read the 0–1 score by day, week or month

**Note**: Changing the solar, wind or battery sliders loads different pre-computed simulation results, not re-running the simulation.

## Key Insights

The tool reveals several important patterns:

1. **Geographic Variation**: Equatorial regions achieve higher capacity factors due to consistent solar resources
2. **Battery Requirements**: With solar and batteries alone, 3,444 of the 4,465 locations can reach a 90% capacity factor within the simulated range (up to 20 GW_DC of solar per GW of load). None does so with less than 12 GWh of storage per GW, and about three-quarters of them (2,559) need 12–14 GWh (`data/summary_w0.parquet`)
3. **Seasonal Effects**: Higher latitudes show strong seasonal variation in solar availability
4. **Economic Trade-offs**: LCOE varies by 2-5× between best and worst locations
5. **Transmission Economics**: Long-distance transmission can be economically justified for locations with significantly lower LCOE

## Limitations & Assumptions

### About the Browser Application

1. **Pre-computed Results**: The browser displays pre-computed simulation results. It does not run the actual hourly energy simulation - that was done offline.
2. **No Real-time Simulation**: Changing sliders loads different pre-computed configurations, not re-running simulations.
3. **Limited Configurations**: Only the 3,216 pre-computed solar, wind and battery combinations in `data/configs.json` are available.

### About the Offline Simulation (assumptions)

Based on the data structure, the offline simulation likely made these assumptions:

1. **Simplified Dispatch**: Assumes optimal dispatch with perfect foresight (real systems need forecasting)
2. **No Degradation in the Simulation**: Capacity factors are for new equipment. The LCOE applies solar (0.5%/yr) and wind (0.2%/yr) output degradation afterwards; battery degradation is not modelled
3. **Fixed Efficiency**: Uses constant efficiency factors (real systems vary with temperature, age, etc.)
4. **No Grid Integration**: Models isolated systems, ignoring grid interconnection benefits
5. **Historical Weather**: Based on NASA POWER historical data (may not represent future climate)
6. **Simplified Economics**: LCOE calculations use simplified model without financing structures, taxes, or incentives

## Credits

**Created by**: the Electrotech Revolution team, 2026 (as in the app's info panel).

**Data Sources**, as cited in the app's info panel:
- NASA POWER (solar and weather)
- Global Wind Atlas 4 (DTU Wind Energy and the World Bank) and ERA5 (wind resource); World Bank / ESMAP Global PV Potential masks (land eligibility); ETOPO 2022 (NOAA, bathymetry)
- IRENA, *Renewable Power Generation Costs in 2025*, and the Danish Energy Agency Technology Catalogue (wind costs); Hatton et al. v3 (cost of capital)
- World Bank Group / ESMAP, *Global Offshore Wind Technical Potential* (2021, CC BY 4.0); Global Solar Atlas (World Bank Group / Solargis); Joshi et al. 2024 (rooftop solar); Bolinger and Bolinger 2022, LBNL (solar power density)
- NASA SEDAC GPWv4 (population); Chen et al. 2022 (electricity consumption); HREA, University of Michigan (grid reliability and access)
- Global Energy Monitor trackers, December 2024 (power plants)
- World Bank / GlobalPetrolPrices (diesel prices)

**Open Source Libraries**:
- Leaflet.js, D3.js, Chart.js
- Apache Arrow, Apache Parquet (parquet-wasm)
- Tailwind CSS
