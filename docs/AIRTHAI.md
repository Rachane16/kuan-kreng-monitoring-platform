# AirThai ground-station PM2.5 on the map

The integration reads the public API used by https://airthai.in.th/th/, with live browser observations and a separate hourly archive. No authentication or new GitHub secret is required. Only project `5fbcd21e875dc20cc990253f` and the six exact System Device IDs in `scripts/sync_stations.py` are requested. No countrywide station feed or other station measurements are mirrored.

Verified public endpoints:
- `GET https://things.airthai.in.th/api/v1/devices/locations?project_id=5fbcd21e875dc20cc990253f`
- `GET /devices/detail?device_id=<allowlisted System Device ID>`
- `GET /sensors/data/hourly/devices?device_id=<ID>&sensor_type=pm_2_5&started_datetime=<UTC ISO>&ended_datetime=<UTC ISO>`

All values are atmospheric PM2.5 mass concentration in µg/m³. They are neither emission mass in kg nor AOD. Do not apply the satellite Extra Trees model, cross-instrument calibration, or the empirical PM1/PM0.1 equations to these observations. The six requested locations currently identify AeroSURE I models for five devices; the school device `68061839a24374609f4df379` has no model string in the API, so the popup says the model is unspecified. Do not label an unknown device DustTrak.

## Time and validity

The hourly endpoint uses hour-END timestamps. This was checked against the published chart code and a bounded minutely query: the observation labeled 07:00 UTC equals the 06:00–06:59 UTC minute mean. The API can return the not-yet-completed hour with a future right-edge label. We exclude records ending after retrieval time. Stored records carry both explicit start/end UTC timestamps; the Thai calendar date is the date of the interval START. Thus a bin ending at midnight Thai time belongs to the preceding date. Timestamp offsets are required; a device heartbeat is never substituted for an observation time.

The first sync requests at most 92 Thai calendar days for each of the six stations. Subsequent updates requery the most recent 48 hours. Successful corrections replace that window; failed requests retain original values and original successful-fetch time with a stale/missing status. Null/negative/non-finite measurements are not zero. Genuine zero is retained. Identical duplicate hour values collapse; conflicting duplicates invalidate only that station/hour. A real conflicting school observation at 2026-08-19T21:00:00Z was excluded. Snapshots retain these exclusions in metadata.

`web/data/stations/index.json` has a sanitized six-station catalogue, current device connectivity/heartbeat (separate from historical observations), source freshness, actual polygon membership, and daily availability. `daily/YYYY-MM-DD.json` has exact same-hour station values grouped by interval. Historical popups display observations from the selected day/hour and clearly label the device's latest connectivity separately.

## IDW

Use only finite nonnegative PM2.5 values at the SAME completed hourly interval and only stations covered by the supplied study-boundary polygons, including holes. The Hua Sai municipal station is outside that polygon: show its requested marker and popup, but exclude it from IDW. Available inputs vary by interval; do not hardcode which stations are currently reporting. Active device connectivity alone does not imply a usable PM2.5 reading.

Coordinates are projected to EPSG:32647 metres. IDW uses power 2 and at most 12 nearest inputs. At least three distinct non-collinear input points are required. Values use the original six-station feed, not interpolated values reused as observations. The existing 100 m display mesh is clipped to the exact study-boundary grid, with holes preserved. This is a display spacing, not a claim of 100 m observation resolution. The area mean uses original clipped-grid coverage weights. IDW outside the input triangle is extrapolation and is not a measurement at every location. No surface is drawn when inputs are insufficient or missing.

For today, the IDW auto mode picks the latest completed common hour with enough in-boundary inputs within two hours of current time; the marker-only auto mode shows latest minute observations with individual measurement times. Explicit past hourly selection remains available for exploration. Other dates remain confined to the chosen Thai day. The default satellite view stays unchanged; the station IDW checkbox selects an alternate PM2.5 color layer only on the map. Satellite controls provide a return action. Page cards/charts keep their named MAIAC/CAMS or fire meanings. No additional page section or metric card is added. Existing grid CSV export identifies AirThai, the exact interval, input station IDs, PM2.5 units and station-IDW spatial support when that map layer is selected.

GitHub's existing :17/:47 schedule and the separate station-only15minute workflow archive hourly station records and deploy the site (GitHub may delay or skip schedules). The open browser checks the public API every minute and completed hourly data every five minutes, independently of the snapshot. Archival does not require the user's computer to remain open. Attribution to AirThai / the Air Pollution Research Center, Prince of Songkla University remains in the map tool and station popups.


## Live map values (20 November 2026)

The existing station panel now calls the public API directly, with `credentials: omit`, only while markers, station IDW or the panel are in use. Today's automatic mode fetches `/sensors/data/minute/devices` for the six allowlisted devices every60seconds and presents each station's latest finite nonnegative observation with its actual measurement timestamp. This is a minute observation, not the `pm_2_5_hourly_avg` field on the provider's overview map. Device heartbeat is metadata and never substitutes for a PM measurement timestamp. Minute timestamps after retrieval time, outside the selected Thai date, or older than the2hour query are excluded; conflicting timestamp values are missing. Age labels distinguish observations within5minutes,5–15minutes, and older data.

The same client refreshes completed hourly observations every5minutes (or on an explicit refresh/date change). IDW still requires at least3 non-collinear stations inside the polygon, all in the same completed interval. While IDW is selected, markers show that common interval too. The latest minute reading is never used as an hourly IDW input. Explicit historical selections are visibly labeled; the existing refresh button returns today's view to automatic/latest. Historical dates use their own bounded hourly API query and never borrow current values.

API errors retain prior observations and their real times; failed fetches do not make those readings fresh. Successful empty hourly queries remove corrected values for that station. The GitHub snapshot remains an explicit hourly fallback. Browser live values work even if GitHub's scheduler is delayed; a visibility change also rechecks latest values when viewing today.

The station-only `.github/workflows/stations.yml` archives and publishes every15minutes at UTC minutes8/23/38/53 and shares the existing Pages concurrency lock. GitHub schedules can be delayed or skipped, so this is not a real-time guarantee; browser observations do not rely on it. The regular platform workflow remains a second archival path. Neither requires a local computer to remain on for archival. The browser must be open to show direct live updates.

Checks: `node --test tests/station-live.test.cjs tests/stations.test.cjs` and the existing `tests/test_stations.py`.
