# Deployment & performance notes

This app is a fully static site with no backend and no build step. The folder
`deployment/` is served as is: `deployment/index.html` is the atlas (the Ember Labs copy has no article). The JS is plain ES modules
(unminified, no bundler), and `css/tailwind.css` is a pre-built file committed to
the repo. This repo has no `package.json`, no build script, no `netlify.toml`
and no other build config, so there is nothing to install or run before
deploying. The one host file is `deployment/_headers` (cache rules, see below).

Slowness on weak machines comes from **client-side work** (decoding and searching
the cost grid, drawing the map), not from the server. Hosting choice only affects
load time. The interaction work is tracked in `BACKLOG.md` §1.

## TL;DR

Publish the `deployment/` folder to a static host that applies Brotli and a CDN.

- **Cloudflare Pages:** build command empty (none), output directory `deployment`.
- Nothing is hosted elsewhere: every file a page reads is in `deployment/`.

---

## Hosting options

| | GitHub Pages | Cloudflare Pages |
|---|---|---|
| Brotli compression | ❌ gzip only | ✅ automatic |
| Global CDN edge cache | partial | ✅ |
| HTTP/2/3 | limited | ✅ |
| Published-site size limit | ~1 GB (the app fits) | the app fits |
| `deployment/_headers` cache rules | ignored | ✅ applied |

Because the JS ships unminified, host-side Brotli is the main load-time saving.

## The data (no separate hosting)

Everything the atlas reads is committed under `deployment/` (`deployment/data` is about
70 MB: the 15 `summary_*.parquet` cost-grid files, the voronoi CSVs,
`world.geojson`, `complementarity.csv`) and ships with the app.

The Complementarity tab reads `data/complementarity.csv` (0.3 MB): per region, the share of weeks and
months in drought (solar, onshore wind, both) and the complementarity score by day, week and month,
2015–2024, built by `pipeline/scripts/pipeline/t093/build.py` from T088's daily series. It is fetched
only when the tab is first opened. No object storage or base-URL setting is needed.

The old hourly sample files (`deployment/data/samples/`, about 2.3 GB, listed in
`.gitignore`) are no longer read by any page; Sample Days (since replaced by
Complementarity, T093) replaced the Sample Weeks tab that needed them. `samples_light/` (15 MB) and
`simulation_results_summary.parquet` (3.7 MB), which no page reads, are not in this copy.

Chart.js is the one library loaded on demand rather than with the page, on first
use of the population charts: `chart.js@4.4.1` from
jsDelivr, pinned to that version with an integrity hash (`CHART_JS_URL` and
`CHART_JS_SRI` in `js/constants.js`, loaded by `loadChartJs()` in `js/utils.js`).
If it cannot be fetched, those charts say so and the rest of the atlas works.


---

## Cloudflare Pages (recommended; R2 keeps it one vendor)

1. Connect the repo in the Cloudflare dashboard → **Pages** → Create.
2. Build settings:
   - **Build command:** leave empty (none)
   - **Output directory:** `deployment`
3. Deploy. `deployment/_headers` sits at the publish root, so Pages applies its
   cache rules automatically.

## GitHub Pages

The original setup (see `README.md`): copy `deployment/` to the deployment repo
and push. It works, but without Brotli or the `_headers` cache rules.

---

## Measuring performance

**Perf HUD.** Append `?perf=1` to the atlas URL to show an on-screen HUD with
per-operation timings (`render-voronoi`, `summary-load`, `lcoe-prepare`, `lcoe-cf-at-target`). It is loaded only on the
`?perf` path, so normal visitors never fetch it. Hit **copy** to grab the numbers.

**Benchmarks.** The repeatable numbers come from `checks/` (`node checks/run_all.mjs`,
headless Chromium). The benchmark (`checks/bench.mjs`) runs at 4× CPU throttle;
the smoke and regression checks run unthrottled. Baselines and targets are in
`team/ACCEPTANCE.md`. The map itself is drawn on a single `<canvas>`
(`js/voronoi-canvas.js`, `FEATURE_VORONOI_CANVAS`), not ~5,000 SVG paths, so the
old SVG render timings no longer apply. On the original code the worst freezes
came from the cost-grid search, e.g. about 23 s when moving the LCOE target
slider (`BACKLOG.md` §1).
