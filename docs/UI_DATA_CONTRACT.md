# Exact multi-satellite UI data

Run `python scripts/build_ui_data.py --data web/data` after the public-source mirror and before publication. The script uses Python standard library plus Shapely 2.x. It performs no API calls and reads no credentials/models.

## Files and canonical keys

- `web/data/ui/fire/YYYY-MM-DD.json.gz`: `{date,selections:{key:summary}}`.
- `web/data/ui/fire_index.json`: `{schema_version:1,satellites:[...],daily:[{date,selections:{key:compactSummary}}]}`.
- Keys are the lexicographically sorted selected satellite IDs joined by `|`. The supported families are MODIS_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT, VIIRS_SNPP_NRT. All 15 nonempty subsets are present for each source date. ALL means the key formed from all four IDs. Empty selection is not a valid key and must not display an inferred zero.

Summary fields follow the existing fire `by_source.ALL` contract: `observation_count`, `grid_count`, `cluster_count`, `ground_area_ha`, `surface_unclassified_ha`, `emission_kg`, `emission_without_peat_kg`, `peat_emission_kg`, six `fuels` rows, `model_id`, `full_grid_scenario`, `cells`, `clusters`, `burned_geometry`, and `_state`. Compact summaries omit the three geometry fields only; chart rows therefore retain the same totals/fuels/state as map rows.

## Exact unions and conservation

Selected hotspot records are deduplicated by original observation `id`. A shared active `grid_id` is included once, regardless of how many selected satellites observed it. Existing per-grid area, fuel and emission values are copied from the selected native source cells. Conflicting copies of the same grid are rejected; no scientific value is recalculated from a different fuel model. Observation count, source families, first/last acquisition times and cluster IDs are recomputed from only the selected records.

Clusters are connected components of active four-neighbor cells whose *actual clipped geometries* share positive-length boundaries. Diagonal contacts, nominal grid neighbours separated by boundary gaps, and unselected connector cells do not join groups. WGS84 clipped boundary intersection uses a numerical tolerance of 1e-12 degrees; no buffer, hull, or gap fill is applied. Cluster geometry is the Shapely union of only its active member cells.

Every day is independently checked against all four native single-source summaries and native ALL: observation/grid/cluster counts, total areas/emission components, all fuel area/emission totals, and exact connected component memberships must match. Those five native summaries are then retained exactly (with `_state` appended). The remaining ten pair/triple summaries are derived using the same conservation rules. `emission_kg = emission_without_peat_kg + peat_emission_kg`; peat inclusion remains a display choice on these preserved components.

## Coverage state

- `_state:"ok"`: all selected sources have successful coverage (or native ALL has `data_state:"ok"`). A genuinely queried zero has numeric 0.
- `_state:"partial"`: some selected source/window coverage is missing, while at least one selected source has queried coverage or selected observations. A partial zero is valid only for the data actually received and must not imply no fires in unavailable sources.
- `_state:"missing"`: no selected source has usable queried coverage or observations. All numeric totals/counts are null, fuel rows are empty, and geometries are empty. Never relabel these as zero.

Single-source states follow the native source coverage. ALL preserves the native aggregate day state while still refusing an all-missing false zero.

## Cache and freshness

`ui/build-cache.json` records input daily SHA-256 values, grid hash, parameter hash and algorithm hash. `ui/adjacency.json` caches the study-grid graph by grid/algorithm hash. Unchanged days are reused. Deterministic gzip uses mtime 0, and unchanged files are never rewritten. There are no generated timestamps that make unchanged data appear newly observed. Observation and source freshness remain the mirrored original timestamps and platform manifest.

Validation: `python -m unittest discover -s tests -p test_ui_data.py -v` covers overlapping satellite observations, shared grids, peat totals, missing/partial/zero distinctions, diagonal/gap exclusions, source-value conflicts, all real native combinations, and stable incremental caching.
