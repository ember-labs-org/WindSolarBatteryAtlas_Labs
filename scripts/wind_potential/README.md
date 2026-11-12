# Offshore wind technical potential per cell (T031)

`build_offshore_potential.py` writes `deployment/data/voronoi_wind_potential_offshore.csv`. That file gives fixed-bottom and floating offshore wind technical potential for each of the atlas's 4,926 Potential-map cells, from the World Bank/ESMAP polygons. Since T057 the shipped file keeps 4,399 of them (Antarctica and Greenland dropped by `pipeline/scripts/exclude_regions/`); run this script on the unfiltered sites, then the exclusion, because sea goes to the nearest site. Method and evidence: `team/evidence/wind-potential.md` §8 (source SRC-ESMAP-OWTP-2021). It is not yet used by the app; T014 wires it in.

## Run

```
python3 -m venv /path/to/venv && /path/to/venv/bin/pip install -r scripts/wind_potential/requirements.txt
/path/to/venv/bin/python scripts/wind_potential/build_offshore_potential.py --cache /path/to/empty/dir --download
/path/to/venv/bin/python scripts/wind_potential/verify_offshore_potential.py --cache /path/to/same/dir
```

- `--download` fetches the nine files in `inputs/esmap_files.csv` (54 MB) from `datacatalogfiles.worldbank.org`. The script refuses any file whose SHA-256 differs from the manifest; if ESMAP republishes, stop and report rather than update the hashes silently.
- Keep the cache outside the repo, or in `scripts/wind_potential/cache/` (git-ignored). The downloads are only read as data, with pyshp and openpyxl.
- The build takes about 75 s and its outputs are byte-identical across runs with the pinned `requirements.txt`. The verifier takes several minutes; `--skip-zoom` drops the zoom runs.

## Inputs

World Bank Group / ESMAP, *Global Offshore Wind Technical Potential* (2021; catalogue record of 26 August 2025). Licence: CC BY 4.0. Attribution: "Source: World Bank Group / ESMAP, Global Offshore Wind Technical Potential (2021), CC BY 4.0".
- **Shapefiles:** one per WBG region and depth class, 14 files in 7 zips, 64,467 features.
- **Feature fields:** EEZ, territory, depth class (−50 = fixed 0–50 m; −1000 = floating 50–1,000 m), wind class (7 = 7–8 m/s at 100 m, 3 MW/km²; 8 = above 8 m/s, 4 MW/km²), `Area_skm` and `InstallCap` (GW).
- **Country file and metadata xlsx:** used only for checks and documentation.

## Cells: the app's own geometry

The Potential map draws `voronoi_pvout_potential.csv` (4,926 rows) through `renderVoronoi` → `voronoi-canvas.js` `ensureGeometry`:
- **Sites:** each site goes through Leaflet 1.9.4 `map.latLngToLayerPoint`. That is EPSG:3857 spherical Mercator, R = 6,378,137 m, latitude clamped to ±85.0511287798°, then `_round()` to whole pixels.
- **Voronoi:** `d3.Delaunay.from(pts).voronoi(bounds)`, where the bounds are the whole projected world plus 1 px. This is a planar Voronoi in Mercator coordinates, with no wrap at the antimeridian.
- **Land mask:** world.geojson is applied only when painting (`ctx.fill(landPath)`). The cells themselves cover the sea, so offshore area belongs to whichever cell's Voronoi region contains it, as on the map's hit-test.

The script rebuilds this geometry with `shapely.voronoi_polygons` on the same Mercator coordinates, clipped to the world square. One difference is deliberate: the app rounds sites to whole pixels at the current zoom, so its cells shift slightly with the zoom (a pixel is 39 km at the equator at zoom 2, the default world view). The script uses the unrounded sites, which every zoom approaches. `verify_offshore_potential.py` measures the error against zooms 2–4 (`out/verify_zoom.csv`).

**Measured error of that choice** (`out/verify_zoom.csv`, against the app's pixel-rounded sites):

| Zoom | Pixel at equator | Capacity in a different cell (fixed / floating) | Cells changing by more than 5% (fixed) |
|---|---|---|---|
| 2 (default) | 39 km | 2.2% / 2.0% | 417 of 1,014 |
| 3 | 20 km | 1.2% / 1.2% | 249 of 1,006 |
| 4 | 10 km | 0.6% / 0.6% | 130 of 1,004 |

So at the default zoom a coastal cell's value can differ by tens of per cent from what the drawn cell would hold (the largest change is 15 GW fixed), while the global split moves about 2%. Per-cell numbers are therefore exact for the zoom-independent cell definition, and approximate (as above) for the cell drawn at any one zoom.

**Consistency with the pipeline.** On these cells, the land area from `world.geojson` matches the pipeline's `zone_area_km2` with a median ratio of 0.9996 (5th–95th percentile 0.81–1.16, because world.geojson is simplified). The median stays near 1 in every 15° latitude band up to 75° (0.93 above 75°). That is consistent with the pipeline using these cells for its solar potential, but it does not prove it: a spherical Voronoi could give similar medians (`out/verify_pipeline_context.csv`).

## Method

1. **Load.** Read each feature. A feature whose ring crosses 180° in one piece (New Zealand, Fiji) is unwrapped to 0–360° before any repair, then cut at 180°. Invalid geometry (652 features, mostly self-touching rings) is repaired with `make_valid`.
2. **Screen.** These checks are reported in `out/excluded_features.csv`, not silently applied:
   - **Artifact parts.** A part with an edge longer than 5° is dropped. Genuine edges are at most ~3.3°, along the 81.5° N limit of the wind data. Only two Alaska floating features (#176 and #180) have such parts. Most of them are drawing errors: bands about 0.01–1.4° high running from the Aleutians to −114° (inland Alberta) and to 156° E. A feature that loses parts keeps ESMAP's own density (`InstallCap / Area_skm`) on the area left. Feature #176 goes from 1,313.1 GW to 85.5 GW; #180 goes from 6.7 GW to 0.
     - **One dropped ring is probably genuine sea:** 174.7–180° E, 52.15–52.67° N, 12,641 km² equal-area (13,415 km² geodesic). It does not overlap world.geojson land; its top edge is a straight cut at 52°40′ N, which is what puts it over the 5° threshold. At the feature's 3 MW/km² it would hold about 38 GW. Keeping it would add that to the cells near the western Aleutians; dropping it is the cautious reading of a broken feature.
     - **The KML is no clean repair.** The publisher's NA floating KML has no counterparts for #176 or #180, and the T031 audit found that its extra Alaska area overlaps land by 19,454 km².
   - **Exact duplicates.** Identical geometry in the same depth class is counted once. Joint-regime areas repeat national EEZ polygons, for example Argentina/Uruguay, Jan Mayen and UK/Faroe. The national EEZ is kept, then file order. This removes 110.4 GW fixed and 74.4 GW floating (596 features).
   - **Partial overlaps are not removed.** Kept, non-duplicate features that overlap without being identical still double-count about 15.7 GW fixed (5,220 km²) and 14.9 GW floating (4,394 km²), 0.08% and 0.03% of the totals. Most of it is a Canada ws7 self-overlap (15.2 GW fixed, 4.9 floating), Curaçao (6.2 floating), Saint-Barthélemy (2.7) and Russia ws7/ws8 (0.4); the rest is small. These are left as published; a union-based dedupe would change the allocation design for 0.05% of capacity.
3. **Cut.** Densify each part's edges every 0.01° and project to Mercator. Then intersect with the cells (STRtree).
4. **Measure.** Densify each piece every 2 km of Mercator distance (Voronoi edges are straight in Mercator), unproject, and measure its area on EPSG:6933, the WGS 84 cylindrical equal-area projection. Across all 64,467 features, the pieces sum to the whole feature to within 3.5e-5.
5. **Allocate.** Share each feature's capacity by piece area, then sum per cell, depth class and wind class.

**Capacity versus area.** Capacity is ESMAP's own `InstallCap` shared by area, so the cells reproduce ESMAP's GW. Area is our equal-area measurement, which differs from ESMAP's `Area_skm`: ESMAP measured some regions in UTM zones far from their central meridian. For example, LAC uses UTM 16N for the whole Caribbean, which inflates `Area_skm` and InstallCap by up to ~20% in the eastern Caribbean (−1.7% for LAC overall). So `gw / area_km2` in a cell can differ from exactly 3 or 4 MW/km².

## Outputs

`deployment/data/voronoi_wind_potential_offshore.csv`: one row per cell, in the row order of `voronoi_pvout_potential.csv`.

| Column | Unit | Meaning |
|---|---|---|
| `location_id`, `latitude`, `longitude` | – | As in `voronoi_pvout_potential.csv` (same text) |
| `fixed_gw`, `fixed_area_km2` | GW, km² | Fixed-bottom (0–50 m) potential and area, both wind classes |
| `floating_gw`, `floating_area_km2` | GW, km² | Floating (50–1,000 m) |
| `{fixed,floating}_ws7_gw`, `…_ws7_area_km2` | GW, km² | Wind class 7–8 m/s at 100 m (3 MW/km²) |
| `{fixed,floating}_ws8_gw`, `…_ws8_area_km2` | GW, km² | Wind class above 8 m/s (4 MW/km²) |

GW are written to 4 decimals and km² to 2. Cells with no potential hold zeros. The by-class columns sum to the totals within rounding.

`out/`:
- `totals.csv`: global totals, with what is not allocated and why.
- `esmap_by_eez.csv`: per EEZ and depth class, the country file against the polygons against the cells.
- `cell_eez.csv`: per cell, EEZ territory, depth and wind class. It gives country attribution without cell-edge effects.
- `excluded_features.csv`: duplicates and trimmed features.
- `verify_*.csv`: verifier results.

## Known gaps in the ESMAP release

- **US EEZ (lower 48) floating: 1,488.7 GW is missing from the published polygons.** The country file says 2,786.8 GW, but the shapefile holds 1,298.1 GW (`Area_skm` 359,513 km²). The publisher's NA floating KML is not pinned in the manifest (sha256 `be6e6a0e72eaeb6f4d70a6ff22dc9ea0432c3f70f0eae767428e347b49be2d69`, fetched 2026-10-26). It carries no attributes, but its US geometry covers the same area: 359,527 km² geodesic by my measurement; the T031 audit measured 361,030 km². So the gap is not a shapefile export fault, and the missing capacity cannot be placed in any cell. Fixed-bottom US figures agree. Caveat text for T014: "US floating shown at 1,298 GW against ESMAP's 2,787 GW (the rest is missing from ESMAP's published polygons)."
- **Kuwait floating:** the country file says 0.099 GW and the polygons 0.050 GW. Together with the US, this makes up the whole floating gap between the country file and the polygons (1,488.77 GW).
- **Alaska fixed-bottom sits under the main US EEZ name.** ESMAP files about 1,530 GW of Alaska fixed-bottom potential (Bering and Chukchi shelves, about 54–71° N; 1,538 GW by feature centroid north of 50° N and west of 140° W) under "United States Exclusive Economic Zone". The country file gives Alaska fixed as #N/A. Anyone using `out/cell_eez.csv` for country totals should split it by location, not by territory name.
- **NA floating shapefile:** ships without a `.prj`. Its coordinates are degrees, read as WGS 84 like every other file. The KML's geometry (measured in a scratch check, not pinned) gives areas within 0.6% of the shapefile's `Area_skm` for the US, Hawaii and Canada.
- **Mis-encoded names:** some EEZ names are double-encoded (`CuraÃƒÆ’Ã‚Â§aoan`). They are repaired for output and joins.
- **Density errors:** five ws8 features use 3 MW/km² instead of 4: Alaska #175, #176 and #180, and Azerbaijan #5198 and #5199. These are kept as published.
