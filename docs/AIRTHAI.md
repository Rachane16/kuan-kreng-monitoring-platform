# AirThai ground-station PM2.5 on the map

The integration reads the public API used by https://airthai.in.th/th/. No authentication or new GitHub secret is required. Only project `5fbcd21e875dc20cc990253f` and the six exact System Device IDs in `scripts/sync_stations.py` are requested. No countrywide station feed or other station measurements are mirrored.

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

Use only finite nonnegative PM2.5 values at the SAME completed hourly interval and only stations covered by the supplied study-boundary polygons, including holes. The Hua Sai municipal station is outside that polygon: show its requested marker and popup, but exclude it from IDW. As of integration, the school, Wat Bo Lo school, and Bo Lo non-hunting area provide the current three in-boundary inputs; the two fire-control stations have no current PM2.5 values. Active device connectivity alone does not imply a usable PM2.5 reading.

Coordinates are projected to EPSG:32647 metres. IDW uses power 2 and at most 12 nearest inputs. At least three distinct non-collinear input points are required. Values use the original six-station feed, not interpolated values reused as observations. The existing 100 m display mesh is clipped to the exact study-boundary grid, with holes preserved. This is a display spacing, not a claim of 100 m observation resolution. The area mean uses original clipped-grid coverage weights. IDW outside the input triangle is extrapolation and is not a measurement at every location. No surface is drawn when inputs are insufficient or missing.

For today, auto mode picks the latest completed common hour with enough in-boundary inputs within two hours of current time; it never labels a days-old observation current. Explicit past hourly selection remains available for exploration. Other dates remain confined to the chosen Thai day. The default satellite view stays unchanged; the station IDW checkbox selects an alternate PM2.5 color layer only on the map. Satellite controls provide a return action. Page cards/charts keep their named MAIAC/CAMS or fire meanings. No additional page section or metric card is added. Existing grid CSV export identifies AirThai, the exact interval, input station IDs, PM2.5 units and station-IDW spatial support when that map layer is selected.

GitHub's existing :17/:47 hourly schedule mirrors new station records and deploys the site (GitHub may delay schedules). An open browser checks the mirrored station snapshot every five minutes. Neither requires the user's computer to remain open. Attribution to AirThai / the Air Pollution Research Center, Prince of Songkla University remains in the map tool and station popups.
