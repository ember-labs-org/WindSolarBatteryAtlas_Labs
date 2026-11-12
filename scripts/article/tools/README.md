# Harnessing the Winds: how the article's numbers are made and checked

The article is `deployment/scrollytelling/index.html`, built by `story-build.py` from the approved text (`team/reports/T087-article-v2.md`) and the summary; edit the builder, not the page. Its map data beyond the summary is `data/story-cells.json` (`scripts/article/analysis/t087/`) and `data/t088_regions.csv`. The previous article is `classic.html` (headline.mjs and verify-article still check it). These tools sit here, outside
`deployment/`, so they are not published with the site.

The page runs no model. It loads one small file, `deployment/scrollytelling/data/article-summary.json`
(about 460 KB, about 150 KB gzipped), with every number the text and charts show and the
map data for each take. The page also loads its own scripts, `../js/constants.js`,
`../data/world.geojson` for the basemap, and Leaflet and d3 from their CDNs. It loads no
summary slices, no LCOE worker and no parquet decoder.

## What the summary holds

1. **Atlas numbers, from the atlas's own model.** `model.js` loads the atlas's data
   (`deployment/data/`) and runs the main app's LCOE worker (`deployment/js/workers/lcoe-worker.js`)
   with the app's default parameters (Capex and WACC Global, no backup, both wind surfaces, no
   O&M escalation, wind degradation 0.2%/yr), the base year pinned to 2026. That is 14 searches:
   8 targets, onshore-only at 80% and 90%, and 2030, 2035, 2040 and 2050 at 90%. It aggregates
   the results as `scripts/article/analyse.py` (T040) does.
2. **Embedded numbers** the model cannot compute: Ember monthly generation (take 3, `data/`),
   IRENA learning rates and cost declines, Ember's 2025 world demand, the Local-cost
   sensitivity and the solar potential total. `build-snapshot.mjs` reads these, and the
   analysis values for everything else, from `scripts/article/out`, `scripts/article/inputs`
   and `data/`, each with its source row.
3. **Wind potential by definition (T083):** `deployment/data/voronoi_wind_potential_defs.csv`, the app's
   own file, per map cell, from `pipeline/scripts/pipeline/wind/t083/potential_defs.py`: onshore
   conservative (T078, D-150: calibrated CF, 3 MW/km², 20% cut-off) and offshore on the World Bank/ESMAP
   and IEA (2019) definitions, fixed-bottom and floating each from its own sea. Onshore technical
   (5 MW/km²) is model.js's own formula. Rerun the script whenever the wind data or level factors change.
4. **Derived numbers and model constants:** potential multiples, ranges across years, IRENA
   cost falls, and capex and cost of capital from `model.js`.
5. **Map data** for the map states that read the atlas: the onshore capacity factor, wind
   potential over local demand, and the 90% builds for 2026, 2035 and 2050 (met or not, the
   cost with and without wind, the saving and the wind share). Each column is rounded to the
   fewest decimals that keep every tooltip figure, legend bucket and colour as the model gives
   them. Site coordinates are the summary slice's own float32 values, so the Voronoi cells are
   the app's. The format is documented in `deployment/scrollytelling/js/summary.js`.

The map states themselves (colours, tooltips, legends) are in `deployment/scrollytelling/js/layers.js`.
The page and the check both use that file.

## Regenerate

```
# Ember monthly data (take 3): run the three queries in ember_monthly.sql on Ember's futures
# MotherDuck share and write their results to the three CSVs in data/.
# Then rebuild the summary (about 15 s, pinned Chromium from checks/lib.mjs):
node scripts/article/tools/build-summary.mjs            # or --out <file> to write elsewhere
node scripts/article/tools/build-snapshot.mjs           # lists the analysis values, with sources
```

Rebuild the summary whenever the model, its data, `app.js` defaults or `scripts/article/out`
change. Then run the check below and re-read the prose. Number words ("two-thirds", "a quarter
to a third", "halves"...) are checked against the values, but only within the ranges listed in
the check.

## Check

```
node scripts/article/tools/verify-article.mjs [--shots <dir>] [--table <file.md>]
```

It serves `ATLAS_SITE` (default `deployment/`) with the pinned Chromium from `checks/lib.mjs`.
It runs the live model itself (the page does not) and fails on any of these:

- a copied app default that no longer appears in `app.js` or `map.js`, or an em dash;
- a value from the live model that differs from the committed analysis beyond its rounding,
  or an analysis value the model no longer computes;
- a committed summary that differs from the one this run of the model gives, in any value or
  map cell;
- a page error or a failed request;
- a request for a `summary_*.parquet` slice, the LCOE worker or the parquet decoder, or any
  Worker started by the page;
- a value on the page that differs from the live model;
- a number in a bound span that does not read as its value, or an unbound number;
- a map cell whose colour or tooltip differs from the same map state drawn from the live
  model's own results (4,998 cells, six states);
- a digit typed as plain text outside a bound span that is not on the structural allowlist
  (targets, build sizes, years, latitude thresholds, citations);
- a number word outside a checked or allowlisted phrase, or a checked phrase whose values
  fall outside its range;
- a take that does not set its map state, or sideways scrolling at 1440 or 390 px.

Self-tests: a copy of the summary with one changed value and one changed cell must show
both differences. In the page, five text faults are planted (a typed "(70%)", the words
"A fifth", a wrong value behind "two-thirds", "two-thirds of people" and a bound 95% replaced
by typed "80%"). A second page load serves a summary with one changed value and one changed
cell. The check fails unless every fault is caught.

## Not verified by the check
Structural numbers that define a claim – uptime targets ("90% uptime"), latitudes ("North of 45°N") and years – are accepted in their allowed contexts but not checked against the bound value beside them. Changing "90% uptime" to "80% uptime" next to a value bound at 90%, or "2035" to "2045", would pass. Review these by eye when editing the text (T041 audit, final round).
