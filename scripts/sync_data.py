"""Mirror validated processed data from the two public upstream repositories.

No NASA/FIRMS/ADS credentials or scientific models are required by this hub.
Source files are pinned to a single upstream commit, verified by Git blob SHA,
and swapped only after the complete source batch passes validation.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCES = {
    'air': {'repository': 'Rachane16/kuan-kreng-maiac-pm25', 'prefix': 'docs/data/',
            'required': ['history.json', 'grid.geojson', 'boundary.geojson', 'cams_history.json',
                         'cams_grid.geojson', 'cams_forecast.json']},
    'fire': {'repository': 'Rachane16/kuan-kreng-grid-emission', 'prefix': 'web/data/',
             'required': ['project.json', 'parameters.json', 'index.json', 'status.json',
                          'study_area.geojson', 'study_grid.geojson.gz', 'landuse_layers.geojson.gz']},
}
MAX_FILE_BYTES = 25 * 1024 * 1024
EXPECTED_GRID_COUNT = 1052


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def iso_day(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError('Invalid ISO calendar date')
    return value


def iso_time(value):
    if not isinstance(value, str):
        raise ValueError('Missing timestamp')
    timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp.utcoffset() is None:
        raise ValueError('Timestamp lacks timezone')
    return timestamp.astimezone(timezone.utc)


def read_json(path):
    data = Path(path).read_bytes()
    if str(path).endswith('.gz'):
        data = gzip.decompress(data)
    return json.loads(data.decode('utf-8-sig'), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON value')))


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'))+'\n', encoding='utf-8')
    temporary.replace(path)


def coordinates(geometry):
    if not isinstance(geometry, dict) or geometry.get('type') not in ('Polygon', 'MultiPolygon', 'Point', 'MultiPoint', 'LineString', 'MultiLineString'):
        raise ValueError('Unsupported or missing geometry')
    def flatten(value):
        if not isinstance(value, list) or not value:
            raise ValueError('Empty geometry coordinates')
        if isinstance(value[0], (int, float)):
            if len(value) < 2 or not all(is_number(v) for v in value) or not (-180 <= value[0] <= 180 and -90 <= value[1] <= 90):
                raise ValueError('Invalid WGS84 coordinate')
            yield value[:2]
        else:
            for part in value:
                yield from flatten(part)
    return list(flatten(geometry.get('coordinates')))


def feature_collection(data, allow_empty=True):
    if not isinstance(data, dict) or data.get('type') != 'FeatureCollection' or not isinstance(data.get('features'), list):
        raise ValueError('Expected GeoJSON FeatureCollection')
    if not allow_empty and not data['features']:
        raise ValueError('Empty spatial dataset')
    for feature in data['features']:
        if feature.get('type') != 'Feature' or not isinstance(feature.get('properties'), dict):
            raise ValueError('Invalid GeoJSON feature')
        coordinates(feature.get('geometry'))
    return data['features']


def geometry_signature(feature):
    # Direction/start-vertex agnostic; authoritative grids use identical vertices.
    return sorted(tuple(round(v, 9) for v in point) for point in coordinates(feature['geometry']))


def grid_ids(grid, expected_count=EXPECTED_GRID_COUNT):
    features = feature_collection(grid, allow_empty=False)
    if any(f['geometry']['type'] not in ('Polygon', 'MultiPolygon') for f in features):
        raise ValueError('Study grid cells must be polygon geometries')
    ids = [f['properties'].get('grid_id') for f in features]
    if any(not isinstance(v, str) or not v for v in ids) or len(set(ids)) != len(ids):
        raise ValueError('Missing or duplicate grid IDs')
    if expected_count is not None and len(ids) != expected_count:
        raise ValueError(f'Expected {expected_count} study cells, got {len(ids)}')
    return set(ids)


def cell_key(grid_id, source):
    pattern = r'E(\d+)_N(\d+)' if source == 'air' else r'KK47_E(\d+)_N(\d+)'
    match = re.fullmatch(pattern, grid_id)
    if not match:
        raise ValueError('Unrecognized study grid ID')
    east, north = map(int, match.groups())
    if source == 'air':
        if east % 1000 or north % 1000:
            raise ValueError('Air grid origin is not aligned to 1 km')
        east, north = east//1000, north//1000
    return east, north


def validate_grid_pair(air, fire, expected_count=EXPECTED_GRID_COUNT):
    grid_ids(air, expected_count)
    grid_ids(fire, expected_count)
    by_key = {cell_key(f['properties']['grid_id'], 'fire'): f for f in fire['features']}
    air_keys = {cell_key(f['properties']['grid_id'], 'air') for f in air['features']}
    if len(air_keys) != len(air['features']) or len(by_key) != len(fire['features']):
        raise ValueError('Duplicate physical UTM cell origin')
    if air_keys != set(by_key):
        raise ValueError('Air/fire UTM cell origins differ')
    rows = []
    for feature in air['features']:
        key = cell_key(feature['properties']['grid_id'], 'air')
        other = by_key[key]
        if geometry_signature(feature) != geometry_signature(other):
            raise ValueError('Air/fire clipped grid geometry differs')
        area = other['properties'].get('area_ha')
        coverage = feature['properties'].get('coverage_fraction')
        if not is_number(area) or area <= 0 or not is_number(coverage) or coverage < 0 or abs(area/100-coverage) > .00011:
            raise ValueError('Grid clipped area/coverage differs')
        rows.append({'air_id': feature['properties']['grid_id'], 'fire_id': other['properties']['grid_id'],
                     'column': key[0], 'row': key[1]})
    return {'state': 'matched', 'air_count': len(rows), 'fire_count': len(rows), 'matching_cells': len(rows),
            'crs': 'EPSG:32647', 'grid_size_m': 1000, 'geometry_tolerance_degrees': 1e-9,
            'area_ha': sum(f['properties']['area_ha'] for f in fire['features']), 'cells': rows}


def validate_air_records(records, ids, allowed_states, forecast=False):
    seen = set()
    for row in records:
        key = row.get('valid_time') if forecast else row.get('date')
        iso_time(key) if forecast else iso_day(key)
        if key in seen:
            raise ValueError('Duplicate air time/date')
        seen.add(key)
        if row.get('status') not in allowed_states or not isinstance(row.get('cells'), list):
            raise ValueError('Invalid air state or cells')
        cells = row['cells']
        if row.get('available_cells') != len(cells):
            raise ValueError('Air available_cells differs from data')
        present = set()
        for cell in cells:
            if not isinstance(cell, list) or len(cell) < 3 or cell[0] not in ids or cell[0] in present:
                raise ValueError('Invalid, duplicate, or unknown air cell')
            present.add(cell[0])
            if not all(is_number(v) and v >= 0 for v in cell[1:3]):
                raise ValueError('Invalid AOD or PM2.5 value')
        if cells:
            if row['status'] != 'Available' or not is_number(row.get('mean_pm25')) or row['mean_pm25'] < 0:
                raise ValueError('Air data and state/mean disagree')
        elif row.get('mean_pm25') is not None:
            raise ValueError('Missing air data has a numeric mean')
    return seen


def validate_air(root):
    grid = read_json(root/'grid.geojson')
    ids = grid_ids(grid)
    for f in grid['features']:
        p = f['properties']
        if not all(is_number(p.get(k)) for k in ('sample_x', 'sample_y', 'coverage_fraction')) or not 0 <= p['coverage_fraction'] <= 1.0001:
            raise ValueError('Invalid air sampling point or clipped weight')
    feature_collection(read_json(root/'boundary.geojson'), allow_empty=False)
    cams_ids = grid_ids(read_json(root/'cams_grid.geojson'), expected_count=None)
    if not 1 <= len(cams_ids) <= 9:
        raise ValueError('Unexpected CAMS study-area native grid count')
    updates, coverages = [], {}
    for name in ('history', 'cams_history'):
        payload = read_json(root/f'{name}.json')
        if payload.get('grid_count') != len(ids if name == 'history' else cams_ids):
            raise ValueError('Air history grid metadata differs')
        day_ids = validate_air_records(payload.get('days', []), ids if name == 'history' else cams_ids,
                                      {'Available', 'NoData', 'NotPublished', 'NotChecked', 'Incomplete'})
        if not day_ids or payload.get('start_date') != min(day_ids) or payload.get('end_date') != max(day_ids) or len(day_ids) != (date.fromisoformat(max(day_ids))-date.fromisoformat(min(day_ids))).days+1:
            raise ValueError('Air history coverage metadata differs')
        updates.append(payload['generated_at_utc']);iso_time(updates[-1])
        coverages['maiac' if name == 'history' else 'cams_daily'] = {'start_date': min(day_ids), 'end_date': max(day_ids), 'days': len(day_ids)}
    payload = read_json(root/'cams_forecast.json')
    hours = payload.get('hours', [])
    validate_air_records(hours, cams_ids, {'Available', 'NoData'}, forecast=True)
    base = iso_time(payload.get('forecast_base_time'))
    if len(hours) != 121 or payload.get('grid_count') != len(cams_ids) or payload.get('resolution_degrees') != .4:
        raise ValueError('Incomplete or changed native CAMS forecast cycle')
    for index, row in enumerate(hours):
        if iso_time(row['valid_time']) != base+timedelta(hours=index) or iso_time(row.get('forecast_base_time')) != base or row.get('lead_time_hours') != [index, index]:
            raise ValueError('CAMS forecast valid time/reference/lead differs')
    updates.append(payload['generated_at_utc']);iso_time(updates[-1])
    coverages['forecast'] = {'start_time': hours[0]['valid_time'], 'end_time': hours[-1]['valid_time'], 'base_time': payload['forecast_base_time'], 'hours': len(hours)}
    return {'upstream_updated_at_utc': max(updates, key=iso_time), 'coverage': coverages,
            'grid_count': len(ids), 'cams_grid_count': len(cams_ids)}


def nonnegative(row, keys):
    for key in keys:
        if not is_number(row.get(key)) or row[key] < 0:
            raise ValueError(f'Invalid fire numeric field {key}')


def validate_fire(root):
    project = read_json(root/'project.json')
    if project.get('model_id') != 'full_grid_1km_v1' or project.get('grid_size_m') != 1000 or project.get('grid_origin_utm') != [0, 0] or project.get('timezone') != 'Asia/Bangkok':
        raise ValueError('Fire model/grid/timezone changed')
    ids = grid_ids(read_json(root/'study_grid.geojson.gz'))
    feature_collection(read_json(root/'study_area.geojson'), allow_empty=False)
    feature_collection(read_json(root/'landuse_layers.geojson.gz'), allow_empty=False)
    parameters = read_json(root/'parameters.json')
    if not isinstance(parameters.get('fuels'), list) or len(parameters['fuels']) != 6:
        raise ValueError('Expected the six original fire fuel parameter sets')
    index = read_json(root/'index.json')
    if index.get('model_id') != 'full_grid_1km_v1' or index.get('timezone') != 'Asia/Bangkok':
        raise ValueError('Fire index metadata differs')
    dates = index.get('dates', [])
    if not dates or len(set(dates)) != len(dates) or dates != sorted(dates):
        raise ValueError('Invalid or unsorted fire dates')
    rows = {row['date']: row for row in index.get('daily', [])}
    if set(rows) != set(dates):
        raise ValueError('Fire dates and daily index disagree')
    for day in dates:
        iso_day(day)
        daily = read_json(root/'daily'/f'{day}.json')
        if daily.get('date') != day or daily.get('timezone') != 'Asia/Bangkok' or daily.get('model_id') != 'full_grid_1km_v1' or daily.get('full_grid_scenario') is not True:
            raise ValueError('Fire daily date/model metadata differs')
        iso_time(daily['generated_utc'])
        if daily.get('data_state') not in ('ok', 'partial', 'error', 'awaiting_key'):
            raise ValueError('Unknown fire coverage state')
        hotspots = feature_collection(daily.get('hotspots'))
        if any(f['geometry']['type'] != 'Point' or f['properties'].get('grid_id') not in ids for f in hotspots):
            raise ValueError('Hotspot has unknown study grid')
        for source, summary in daily.get('by_source', {}).items():
            nonnegative(summary, ('emission_kg', 'emission_without_peat_kg', 'peat_emission_kg', 'ground_area_ha', 'observation_count', 'grid_count', 'cluster_count'))
            if abs(summary['emission_kg']-summary['emission_without_peat_kg']-summary['peat_emission_kg']) > max(1e-6, summary['emission_kg']*1e-9):
                raise ValueError('Fire emission components disagree')
            cells = feature_collection(summary.get('cells'))
            feature_collection(summary.get('clusters'))
            present = [f['properties'].get('grid_id') for f in cells]
            if len(cells) != summary['grid_count'] or len(set(present)) != len(present) or set(present)-ids:
                raise ValueError('Fire active cells disagree with study grid/count')
            if source == 'ALL' and summary['observation_count'] != len(hotspots):
                raise ValueError('Fire observation count differs from hotspot points')
            for feature in cells:
                nonnegative(feature['properties'], ('emission_kg', 'emission_without_peat_kg', 'ground_area_ha'))
        if 'ALL' not in daily.get('by_source', {}):
            raise ValueError('Missing combined fire summary')
        if rows[day].get('grid_count') != daily['by_source']['ALL']['grid_count']:
            raise ValueError('Fire index and full daily grid count disagree')
    status = read_json(root/'status.json')
    updates = [index.get('generated_utc'), status.get('last_success_utc'), status.get('last_partial_success_utc')]
    updates = [value for value in updates if value]
    for value in updates:iso_time(value)
    return {'upstream_updated_at_utc': max(updates, key=iso_time),
            'coverage': {'start_date': dates[0], 'end_date': dates[-1], 'days': len(dates)},
            'grid_count': len(ids), 'observation_state': status.get('state'),
            'model_id': project['model_id']}


def selected_paths(source, tree):
    config = SOURCES[source]
    prefix = config['prefix']
    selected = {}
    for item in tree:
        if item.get('type') != 'blob' or not item.get('path', '').startswith(prefix):
            continue
        relative = item['path'][len(prefix):]
        curated = relative in config['required']
        if source == 'fire':
            curated = curated or relative == 'import_status.json' or bool(re.fullmatch(r'daily/\d{4}-\d{2}-\d{2}\.json', relative))
        if not curated:
            continue
        if item.get('size', 0) > MAX_FILE_BYTES:
            raise ValueError('Upstream curated file exceeds size limit')
        selected[relative] = {'blob_sha': item['sha'], 'size': item.get('size', 0)}
    missing = set(config['required'])-set(selected)
    if missing:
        raise ValueError('Missing required upstream files: '+', '.join(sorted(missing)))
    if source == 'fire' and not any(p.startswith('daily/') for p in selected):
        raise ValueError('Missing fire daily payloads')
    return selected


def fetch_bytes(url, token=None):
    headers = {'User-Agent': 'Kuan-Kreng-Monitoring-Platform/1.0'}
    if url.startswith('https://api.github.com/'):
        headers['Accept'] = 'application/vnd.github+json'
        if token:headers['Authorization'] = 'Bearer '+token
    last_error = None
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=60) as response:
                data = response.read(MAX_FILE_BYTES+1)
            if len(data) > MAX_FILE_BYTES:
                raise ValueError('Remote file exceeds size limit')
            return data
        except (HTTPError, URLError, TimeoutError) as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code in (401, 403, 404):break
            time.sleep(2**attempt)
    # Never include credential headers or raw upstream response bodies in errors.
    code = getattr(last_error, 'code', None)
    raise RuntimeError('GitHub data request failed'+(f' (HTTP {code})' if code else '')) from None


def remote_inventory(source, token):
    repository = SOURCES[source]['repository']
    commit = json.loads(fetch_bytes(f'https://api.github.com/repos/{repository}/commits/main', token))
    sha = commit['sha']
    tree_sha = commit['commit']['tree']['sha']
    tree = json.loads(fetch_bytes(f'https://api.github.com/repos/{repository}/git/trees/{tree_sha}?recursive=1', token))
    if tree.get('truncated'):
        raise ValueError('Upstream repository tree was truncated')
    return sha, selected_paths(source, tree['tree'])


def local_inventory(source, local_root):
    prefix = SOURCES[source]['prefix']
    tree = []
    for path in (local_root/prefix).rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            tree.append({'path': path.relative_to(local_root).as_posix(), 'type': 'blob',
                         'sha': git_blob_sha(data), 'size': len(data)})
    selected = selected_paths(source, tree)
    digest = hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()
    return 'offline-'+digest, selected


def stage_source(source, output, previous, token=None, local_root=None):
    config = SOURCES[source]
    sha, files = local_inventory(source, local_root) if local_root else remote_inventory(source, token)
    # Stage under the output parent: same filesystem for directory rename/rollback.
    stage = Path(tempfile.mkdtemp(prefix=f'.sync-{source}-', dir=output.parent))
    current = output/source
    changed = []
    try:
        def prepare(item):
            relative, details = item
            target = stage/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            old = current/relative
            if old.is_file():
                data = old.read_bytes()
                if git_blob_sha(data) == details['blob_sha']:
                    target.write_bytes(data)
                    return
            if local_root:
                data = (local_root/config['prefix']/relative).read_bytes()
            else:
                data = fetch_bytes(f"https://raw.githubusercontent.com/{config['repository']}/{sha}/{config['prefix']}{relative}")
            if git_blob_sha(data) != details['blob_sha']:
                raise ValueError('Downloaded data does not match its pinned Git blob SHA')
            target.write_bytes(data)
            changed.append(relative)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(prepare, files.items()))
        details = validate_air(stage) if source == 'air' else validate_fire(stage)
        record = {'repository': config['repository'], 'ref': 'main', 'commit_sha': sha,
                  'state': 'ok', 'mode': 'offline' if local_root else 'github',
                  'last_attempt_utc': utc_now(), 'synced_at_utc': utc_now(),
                  'files': files, 'file_count': len(files), **details}
        return stage, record, changed
    except Exception:
        safe_remove(stage, output.parent)
        raise


def safe_remove(path, allowed_parent):
    path = Path(path).resolve()
    allowed_parent = Path(allowed_parent).resolve()
    if path == allowed_parent or not path.is_relative_to(allowed_parent):
        raise ValueError('Refusing recursive cleanup outside the intended output parent')
    if path.exists():shutil.rmtree(path)


def commit_stage(stage, target):
    target = Path(target).resolve()
    stage = Path(stage).resolve()
    if not stage.name.startswith('.sync-') or stage.parent != target.parent.parent:
        raise ValueError('Unexpected staging directory')
    backup = target.with_name('.previous-'+target.name)
    if backup.exists():
        raise RuntimeError('An interrupted previous sync needs inspection before continuing')
    if target.exists():target.replace(backup)
    try:
        stage.replace(target)
    except Exception:
        if backup.exists():backup.replace(target)
        raise
    safe_remove(backup, target.parent)


def sync(output, token=None, local_roots=None):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output/'manifest.json'
    previous = read_json(manifest_path) if manifest_path.exists() else {}
    manifest = {'schema_version': 1, 'generated_at_utc': utc_now(), 'sources': {}}
    stages, changed = {}, {}
    local_roots = local_roots or {}
    for source in SOURCES:
        old = previous.get('sources', {}).get(source, {})
        try:
            stages[source], record, changed[source] = stage_source(source, output, old, token, local_roots.get(source))
            manifest['sources'][source] = record
        except Exception as error:
            record = dict(old)
            record.update(repository=SOURCES[source]['repository'], state='stale' if (output/source).exists() else 'unavailable',
                          last_attempt_utc=utc_now(), error=str(error).replace(token, '[REDACTED]') if token else str(error))
            manifest['sources'][source] = record
            print(f'{source}: validation/fetch failed; previous snapshot retained', flush=True)
    roots = {source: stages.get(source, output/source) for source in SOURCES}
    pair = None
    try:
        if all(root.exists() for root in roots.values()):
            pair = validate_grid_pair(read_json(roots['air']/'grid.geojson'), read_json(roots['fire']/'study_grid.geojson.gz'))
    except Exception as error:
        for source, stage in stages.items():
            safe_remove(stage, output.parent)
            record = dict(previous.get('sources', {}).get(source, {}))
            record.update(repository=SOURCES[source]['repository'], state='stale' if (output/source).exists() else 'unavailable',
                          last_attempt_utc=utc_now(), error='Cross-source study grid validation failed')
            manifest['sources'][source] = record
        stages.clear()
        roots = {source: output/source for source in SOURCES}
        if all(root.exists() for root in roots.values()):
            pair = validate_grid_pair(read_json(roots['air']/'grid.geojson'), read_json(roots['fire']/'study_grid.geojson.gz'))
    for source, stage in stages.items():
        commit_stage(stage, output/source)
        print(f"{source}: {manifest['sources'][source]['file_count']} validated files, {len(changed[source])} downloaded/changed", flush=True)
    if pair:
        rows = pair.pop('cells')
        write_json(output/'grid_crosswalk.json', {'schema_version': 1, 'crs': 'EPSG:32647', 'grid_size_m': 1000, 'cells': rows})
        manifest['grid_validation'] = pair
    else:
        manifest['grid_validation'] = {'state': 'unavailable', 'matching_cells': 0}
    manifest['state'] = 'ok' if all(r['state'] == 'ok' for r in manifest['sources'].values()) and pair else 'partial'
    write_json(manifest_path, manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('web/data'))
    parser.add_argument('--offline-source-root-air', type=Path)
    parser.add_argument('--offline-source-root-fire', type=Path)
    args = parser.parse_args()
    local_roots = {key: path.resolve() for key, path in {'air': args.offline_source_root_air, 'fire': args.offline_source_root_fire}.items() if path}
    result = sync(args.output, token=os.getenv('GH_TOKEN') or os.getenv('GITHUB_TOKEN'), local_roots=local_roots)
    print('Platform data sync: '+result['state'], flush=True)
    if not all((args.output/source).exists() for source in SOURCES):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
