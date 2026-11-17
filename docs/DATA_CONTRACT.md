# Platform data contract

The hub mirrors only already-public, processed datasets. It never downloads NASA/ADS/FIRMS source imagery, models, API keys, or private files. The upstream applications remain the scientific processing authorities.

## Published paths

- `web/data/air/history.json`: original MAIAC history (NASA product date in UTC). `days[].cells` arrays are `[grid_id,aod470,pm25,overpass_time_utc,valid_overpasses]`.
- `web/data/air/cams_history.json`: original 24-hour Thai-calendar-day AOD550 mean followed by the trusted PM2.5 model. Cells are `[native_grid_id,aod550,pm25,24]`.
- `web/data/air/cams_forecast.json`: original single complete forecast run, 121 valid hours from lead 0 to 120. Each hour preserves `valid_time`, `forecast_base_time`, `lead_time_hours`, and cell values.
- `web/data/air/grid.geojson`, `boundary.geojson`, `cams_grid.geojson`: original display shapes/weights/sample coordinates. Native CAMS resolution remains 0.4 degrees.
- `web/data/fire/index.json`: source daily index and per-satellite summaries. `dates` lists days with downloadable payloads. Missing source coverage must not be interpreted as no fires.
- `web/data/fire/daily/YYYY-MM-DD.json`: original hotspot points, `by_source.ALL` / satellite summaries, active `cells` and `clusters` FeatureCollections, fuel rows, and original coverage states/times. The day timezone is Asia/Bangkok.
- `web/data/fire/project.json`, `parameters.json`, `status.json`: model assumptions, six original fuel parameter sets, and source-by-source availability.
- `web/data/fire/study_area.geojson`, `study_grid.geojson.gz`, `landuse_layers.geojson.gz`: original study boundary, full reference grid, and display-only fuel polygons.
- `web/data/fire/import_status.json`: optional original import state when published upstream.

Files are copied without transforming scientific values, original dates, observation timestamps, or IDs. PM2.5 concentration is µg/m³; emissions are kg per independent daily full-grid burning scenario. They are not interchangeable measures. IDW/empirical particle conversions are viewer operations on the preserved PM2.5 values.

## Shared grid correspondence

`grid_crosswalk.json` has `{schema_version:1,crs:"EPSG:32647",grid_size_m:1000,cells:[...]}`. Each row is `{air_id,fire_id,column,row}`. Air ID `E604000_N0908000` maps to fire ID `KK47_E604_N908`. The UTM cell origin and clipped WGS84 geometry must agree, not just the count. All 1,052 cells are checked. Air `coverage_fraction` is rounded to four decimals upstream; two tiny positive-area boundary cells can therefore have zero rounded weight. No nonzero weight is invented for them.

## Sync manifest and freshness

`manifest.json` has `schema_version`, `generated_at_utc`, `state`, `sources.air`, `sources.fire`, and `grid_validation`.

Each source records its public `repository`, `ref`, pinned `commit_sha`, mode (`github` or explicitly requested offline bootstrap), `state`, `last_attempt_utc`, `synced_at_utc`, `upstream_updated_at_utc`, `coverage`, `grid_count`, `file_count`, and a `files` mapping of relative path to Git blob SHA/size. Air coverage has `maiac`, `cams_daily`, and `forecast` subrecords. Fire coverage has `start_date`, `end_date`, `days`; `observation_state` retains the original aggregate source availability.

- `ok`: the whole source batch was validated successfully. It does **not** mean observations exist in every cell or all satellite products are available.
- `stale`: fetching/validating failed, and the previously published source snapshot remains. Its old commit, sync time, upstream timestamp, and scientific values remain unchanged; only attempt/error status changes.
- `unavailable`: no validated snapshot exists for that source yet.

The root `generated_at_utc` is a hub sync-attempt time, not a new observation or forecast time. Display original individual dataset times and per-source availability. Preserve missing/partial states; never silently relabel old data as current.

## Integrity and failure handling

Each source is pinned to one upstream Git commit; its curated files are downloaded at that SHA and checked against the Git blob hashes from that commit tree. Unchanged local blobs are reused, so later syncs do not redownload all historical dates or fuel geometry. A whole source batch is staged before schema/count/date/numeric checks and cross-source grid checks. Invalid staged data never replaces an existing source directory. Directory swaps use a rollback backup on the same volume. Staging and cleanup paths are constrained to the selected output parent.

The CLI uses Python 3.12 standard library only. `GH_TOKEN` or `GITHUB_TOKEN` may optionally authorize public repository metadata reads in GitHub Actions; it is never stored in data or sent to raw-content URLs. The hub needs no NASA Earthdata token, ADS token, FIRMS MAP_KEY, or model-decryption key.

```text
python scripts/sync_data.py
python -m unittest discover -s tests -p test_sync.py -v
```

For explicit local bootstrap only, `--offline-source-root-air` and `--offline-source-root-fire` accept the original checked-out project directories. Offline provenance is identified as `offline-<digest>` and must not be presented as a pinned GitHub commit.
