"""Derive exact satellite-subset fire views from mirrored processed datasets.

Scientific cell values remain upstream values. Selecting several satellites unions
activated cells and unique observation IDs; it never adds per-source totals.
"""
from __future__ import annotations
import argparse
import copy
import gzip
import hashlib
from itertools import combinations
import json
import math
from pathlib import Path
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

SATELLITES = ('MODIS_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT')
NUMERIC = ('ground_area_ha', 'surface_unclassified_ha', 'emission_without_peat_kg', 'peat_emission_kg', 'emission_kg')
COUNTS = ('observation_count', 'grid_count', 'cluster_count')
SCHEMA_VERSION = 1
EDGE_TOLERANCE_DEGREES = 1e-12


def read_json(path):
    data=Path(path).read_bytes()
    if str(path).endswith('.gz'):data=gzip.decompress(data)
    return json.loads(data)


def digest(data):return hashlib.sha256(data).hexdigest()

def canonical(selected):return '|'.join(sorted(set(selected)))

def collection(features=()):return {'type':'FeatureCollection','features':list(features)}

def encoded(payload):return (json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode('utf-8')

def write_changed(path,data):
    path=Path(path)
    if path.exists() and path.read_bytes()==data:return False
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.tmp');temporary.write_bytes(data);temporary.replace(path)
    return True


def key_for(feature):
    p=feature['properties']
    return int(p['column']),int(p['row'])


def build_adjacency(grid):
    """Four-neighbor candidates must share an actual positive clipped boundary."""
    features=grid['features'];positions={key_for(f):f['properties']['grid_id'] for f in features}
    geometries={f['properties']['grid_id']:shape(f['geometry']) for f in features}
    adjacency={grid_id:[] for grid_id in geometries}
    for (col,row),grid_id in sorted(positions.items()):
        for key in ((col+1,row),(col,row+1)):
            other=positions.get(key)
            if other is None:continue
            shared=geometries[grid_id].boundary.intersection(geometries[other].boundary)
            if shared.length>EDGE_TOLERANCE_DEGREES:
                adjacency[grid_id].append(other);adjacency[other].append(grid_id)
    return {key:sorted(value) for key,value in adjacency.items()},geometries


def connected_groups(ids,adjacency):
    remaining=set(ids);groups=[]
    while remaining:
        seed=min(remaining);remaining.remove(seed);group=[seed];queue=[seed]
        while queue:
            current=queue.pop()
            for other in adjacency.get(current,[]):
                if other in remaining:
                    remaining.remove(other);group.append(other);queue.append(other)
        groups.append(sorted(group))
    return groups


def selected_observations(day,selected):
    result={}
    for feature in day.get('hotspots',{}).get('features',[]):
        record=feature['properties']
        if record.get('source') not in selected:continue
        identity=record.get('id')
        if not identity:raise ValueError('Selected hotspot is missing its observation ID')
        if identity in result and result[identity]!=record:raise ValueError('Conflicting duplicate observation ID')
        result[identity]=record
    return [result[key] for key in sorted(result)]


def selection_state(day,selected,observations):
    states=[day.get('source_status',{}).get(source,{}).get('state','missing') for source in selected]
    available=bool(observations) or any(state in ('ok','partial') for state in states)
    if not available:return 'missing'
    if len(selected)==len(SATELLITES):
        state=day.get('data_state','partial')
        return 'ok' if state=='ok' else 'partial'
    return 'ok' if all(state=='ok' for state in states) else 'partial'


def aggregate(cell_properties,parameters):
    result={key:math.fsum(p[key] for p in cell_properties) for key in NUMERIC}
    fuels=[]
    for parameter in parameters['fuels']:
        code=parameter['code'];parts=[]
        for props in cell_properties:
            matches=[f for f in props['fuels'] if f['code']==code]
            if len(matches)!=1:raise ValueError('Cell fuel rows do not match upstream parameters')
            parts.append(matches[0])
        fuel={'code':code,'rho':parameter['rho'],'eta':parameter['eta'],'ef_pm25':parameter['ef_pm25'],
              'area_ha':math.fsum(f['area_ha'] for f in parts),'emission_kg':math.fsum(f['emission_kg'] for f in parts),
              'peat_scenario':code=='PEAT' or bool(parameter.get('scenario'))}
        fuels.append(fuel)
    result['fuels']=fuels
    return result


def verify_scientific_cell(left,right):
    for key in NUMERIC:
        if not math.isclose(left[key],right[key],rel_tol=1e-11,abs_tol=1e-8):
            raise ValueError('Shared grid has conflicting scientific values')
    a={f['code']:f for f in left['fuels']};b={f['code']:f for f in right['fuels']}
    if a.keys()!=b.keys():raise ValueError('Shared grid has conflicting fuel pools')
    for code in a:
        for key in ('area_ha','emission_kg','rho','eta','ef_pm25'):
            if not math.isclose(a[code][key],b[code][key],rel_tol=1e-11,abs_tol=1e-8):
                raise ValueError('Shared grid has conflicting fuel values')


def missing_summary():
    return {**{key:None for key in (*NUMERIC,*COUNTS)},'fuels':[],
            'model_id':'full_grid_1km_v1','full_grid_scenario':True,
            'burned_geometry':None,'cells':collection(),'clusters':collection(),'_state':'missing'}


def summarize_selection(day,selected,adjacency,geometries,parameters):
    selected=tuple(sorted(set(selected)))
    if not selected or set(selected)-set(SATELLITES):raise ValueError('Select a nonempty supported satellite subset')
    observations=selected_observations(day,selected)
    coverage=selection_state(day,selected,observations)
    if coverage=='missing':return missing_summary()
    by_cell={}
    for source in selected:
        for feature in day.get('by_source',{}).get(source,{}).get('cells',{}).get('features',[]):
            props=feature['properties'];grid_id=props['grid_id']
            if grid_id in by_cell:verify_scientific_cell(by_cell[grid_id],props)
            else:by_cell[grid_id]=props
    obs_by_cell={}
    for obs in observations:obs_by_cell.setdefault(obs['grid_id'],[]).append(obs)
    if set(by_cell)!=set(obs_by_cell):raise ValueError('Selected raw hotspots and selected active grid union disagree')
    if set(by_cell)-set(geometries):raise ValueError('Selected active grid is outside the reference study grid')
    ids=sorted(by_cell,key=lambda grid_id:(by_cell[grid_id]['column'],by_cell[grid_id]['row']))
    groups=connected_groups(ids,adjacency);cluster_for={};clusters=[]
    def metadata(records):
        return {'observation_count':len(records),'sources':sorted({r['source'] for r in records}),
                'first_acquired_utc':min(r['acquired_utc'] for r in records),
                'last_acquired_utc':max(r['acquired_utc'] for r in records)}
    for group in groups:
        group=sorted(group,key=lambda grid_id:(by_cell[grid_id]['column'],by_cell[grid_id]['row']))
        cluster_id='KG-'+day['date'].replace('-','')+'-'+hashlib.sha256('|'.join(group).encode()).hexdigest()[:8]
        for grid_id in group:cluster_for[grid_id]=cluster_id
        records=[r for grid_id in group for r in obs_by_cell[grid_id]]
        props={**aggregate([by_cell[grid_id] for grid_id in group],parameters),
               'cluster_id':cluster_id,'cell_ids':group,'grid_count':len(group),
               **metadata(records),'full_grid_scenario':True}
        clusters.append({'type':'Feature','geometry':mapping(unary_union([geometries[grid_id] for grid_id in group])),'properties':props})
    cells=[]
    for grid_id in ids:
        props=copy.deepcopy(by_cell[grid_id]);props.update(metadata(obs_by_cell[grid_id]),cluster_id=cluster_for[grid_id])
        cells.append({'type':'Feature','geometry':mapping(geometries[grid_id]),'properties':props})
    return {**aggregate([by_cell[grid_id] for grid_id in ids],parameters),
            'observation_count':len(observations),'grid_count':len(ids),'cluster_count':len(groups),
            'model_id':day['model_id'],'full_grid_scenario':True,
            'burned_geometry':mapping(unary_union([geometries[grid_id] for grid_id in ids])) if ids else None,
            'cells':collection(cells),'clusters':collection(clusters),'_state':coverage}


def verify_native(derived,native):
    if derived['_state']=='missing':return
    for key in (*NUMERIC,*COUNTS):
        if not math.isclose(derived[key],native[key],rel_tol=1e-10,abs_tol=1e-7):
            raise ValueError('Derived selection does not match native '+key)
    native_fuels={f['code']:f for f in native['fuels']}
    for fuel in derived['fuels']:
        for key in ('area_ha','emission_kg'):
            if not math.isclose(fuel[key],native_fuels[fuel['code']][key],rel_tol=1e-10,abs_tol=1e-7):
                raise ValueError('Derived fuel totals differ from native')
    own_groups={tuple(sorted(f['properties']['cell_ids'])) for f in derived['clusters']['features']}
    original_groups={tuple(sorted(f['properties']['cell_ids'])) for f in native['clusters']['features']}
    if own_groups!=original_groups:raise ValueError('Derived connected groups differ from native groups')


def compact(summary):
    return {key:value for key,value in summary.items() if key not in ('cells','clusters','burned_geometry')}


def build_day(day,adjacency,geometries,parameters):
    selections={}
    for count in range(1,len(SATELLITES)+1):
        for selected in combinations(SATELLITES,count):
            derived=summarize_selection(day,selected,adjacency,geometries,parameters)
            native_key=selected[0] if count==1 else 'ALL' if count==len(SATELLITES) else None
            if native_key:
                native=day['by_source'][native_key];verify_native(derived,native)
                if derived['_state']!='missing':
                    state=derived['_state'];derived=copy.deepcopy(native);derived['_state']=state
            selections[canonical(selected)]=derived
    return {'date':day['date'],'selections':selections}


def build(data_root):
    data_root=Path(data_root);fire=data_root/'fire';output=data_root/'ui';output.mkdir(parents=True,exist_ok=True)
    grid_path=fire/'study_grid.geojson.gz';grid_sha=digest(grid_path.read_bytes())
    algorithm_sha=digest(Path(__file__).read_bytes())
    cache_path=output/'build-cache.json';cache=read_json(cache_path) if cache_path.exists() else {}
    adjacency_path=output/'adjacency.json';adjacency_cache=read_json(adjacency_path) if adjacency_path.exists() else {}
    grid=read_json(grid_path)
    if adjacency_cache.get('grid_sha256')==grid_sha and adjacency_cache.get('algorithm_sha256')==algorithm_sha:
        adjacency=adjacency_cache['adjacency'];geometries={f['properties']['grid_id']:shape(f['geometry']) for f in grid['features']}
    else:
        adjacency,geometries=build_adjacency(grid)
        write_changed(adjacency_path,encoded({'grid_sha256':grid_sha,'algorithm_sha256':algorithm_sha,'adjacency':adjacency}))
    parameters=read_json(fire/'parameters.json');parameter_sha=digest((fire/'parameters.json').read_bytes())
    index=read_json(fire/'index.json');index_path=output/'fire_index.json'
    old_rows={r['date']:r for r in read_json(index_path).get('daily',[])} if index_path.exists() else {}
    new_cache={'schema_version':SCHEMA_VERSION,'algorithm_sha256':algorithm_sha,'grid_sha256':grid_sha,'parameter_sha256':parameter_sha,'daily':{}}
    unchanged_cache=all(cache.get(k)==new_cache[k] for k in ('schema_version','algorithm_sha256','grid_sha256','parameter_sha256'))
    rows=[];changed=0
    for day in index['dates']:
        source=fire/'daily'/f'{day}.json';source_sha=digest(source.read_bytes());target=output/'fire'/f'{day}.json.gz'
        if unchanged_cache and cache.get('daily',{}).get(day)==source_sha and target.exists() and day in old_rows:
            rows.append(old_rows[day])
        else:
            derived=build_day(read_json(source),adjacency,geometries,parameters)
            write_changed(target,gzip.compress(encoded(derived),compresslevel=9,mtime=0))
            rows.append({'date':day,'selections':{key:compact(summary) for key,summary in derived['selections'].items()}})
            changed+=1
        new_cache['daily'][day]=source_sha
    payload={'schema_version':SCHEMA_VERSION,'satellites':list(SATELLITES),'daily':rows}
    write_changed(index_path,encoded(payload));write_changed(cache_path,encoded(new_cache))
    print(f'UI fire selections: {len(rows)} dates, 15 subsets/date, {changed} rebuilt',flush=True)
    return payload


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--data',type=Path,default=Path('web/data'));args=parser.parse_args();build(args.data)

if __name__=='__main__':main()
