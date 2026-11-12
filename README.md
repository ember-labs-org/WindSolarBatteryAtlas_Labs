# Wind + Solar + Battery Atlas

An interactive map of how well wind, solar and batteries together can supply a constant 1 GW of electricity at 4,465 locations worldwide, over ten years of hourly weather (2015–2024). It shows what that costs, how much wind and solar could be built, and how often the two resources fall short at the same time.

Published on Ember Labs. Developed by the Ember Futures team. It extends the [Solar + Battery Atlas](https://github.com/ember-labs-org/SolarBatteryAtlas_Labs) with onshore and offshore wind.

## Repository layout

| Path | What it is |
| --- | --- |
| `deployment/` | The app: HTML, CSS, JavaScript and the data it loads (about 80 MB). This is what gets published. |
| `pipeline/` | A partial copy of the data pipeline (simulation and wind siting), kept for documentation. See `pipeline/README.md`. |
| `scripts/` | Builders for the wind costs (`wind_costs/`) and the offshore wind potential (`wind_potential/`) |
| `checks/` | Automated checks of the app's calculations. |
| `DEPLOYMENT.md` | How the app is structured and deployed. |
| `README-upstream.md` | The README of the Ember Futures repository this copy was taken from. |

## Running locally

There is no build step. Serve `deployment/` as a static site, for example:

```bash
cd deployment
python3 -m http.server 8000
```

Then open http://localhost:8000. All the data the app needs is in `deployment/data/`.

## Data sources and method

The **Info** panel in the app lists the data sources and explains the method. `README-upstream.md` and `DEPLOYMENT.md` give more detail.

## About this copy

This is a snapshot of the Ember Futures repository (`Ember-Futures/WindSolarBatteryAtlas`, commit `0a74c19`, 11 November 2026) without its internal project files and history. The Ember Labs copy is the tool only: the article "Harnessing the Winds" (`deployment/scrollytelling/`, `scripts/article/`), its Article button and tour mention, and the data file only the article used (`daily_cf_2024.parquet`) are removed.
