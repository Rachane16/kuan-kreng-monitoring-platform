"""Behavior checks for exact satellite unions, fuel conservation and connectivity."""
from __future__ import annotations
import contextlib
import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from shapely.geometry import box,mapping

SPEC=importlib.util.spec_from_file_location('ui_data',Path(__file__).resolve().parents[1]/'scripts'/'build_ui_data.py')
ui=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(ui)
A,B,C,D=ui.SATELLITES
PARAMETERS={'fuels':[{'code':'GRASS','rho':1,'eta':1,'ef_pm25':1},{'code':'PEAT','rho':1,'eta':1,'ef_pm25':1,'scenario':True}]}


def grid_feature(col,row,geometry=None):
    return {'type':'Feature','geometry':mapping(geometry if geometry is not None else box(col,row,col+1,row+1)),
            'properties':{'grid_id':f'g{col}_{row}','column':col,'row':row}}


def stats(grid_id,col,row):
    surface=10+col;peat=20+row
    return {'grid_id':grid_id,'column':col,'row':row,'grid_count':1,'nominal_area_ha':100,
            'ground_area_ha':100,'surface_unclassified_ha':20,'emission_without_peat_kg':surface,
            'peat_emission_kg':peat,'emission_kg':surface+peat,'full_grid_scenario':True,
            'fuels':[{'code':'GRASS','rho':1,'eta':1,'ef_pm25':1,'area_ha':surface,'emission_kg':surface,'peat_scenario':False},
                     {'code':'PEAT','rho':1,'eta':1,'ef_pm25':1,'area_ha':peat,'emission_kg':peat,'peat_scenario':True}]}


def fixture():
    grid=ui.collection([grid_feature(0,0),grid_feature(1,0),grid_feature(2,0),grid_feature(3,1)])
    points=[('one',A,'g0_0'),('two',B,'g0_0'),('three',B,'g1_0'),('four',C,'g2_0')]
    features={f['properties']['grid_id']:f for f in grid['features']}
    hotspots=[]
    for identity,source,grid_id in points:
        hotspots.append({'type':'Feature','geometry':{'type':'Point','coordinates':[0.5,0.5]},
                         'properties':{'id':identity,'source':source,'grid_id':grid_id,'acquired_utc':'2026-11-18T03:00:00Z'}})
    day={'date':'2026-11-18','model_id':'full_grid_1km_v1','full_grid_scenario':True,
         'data_state':'ok','source_status':{source:{'state':'ok'} for source in ui.SATELLITES},
         'hotspots':ui.collection(hotspots),'by_source':{}}
    for source in ui.SATELLITES:
        ids={f['properties']['grid_id'] for f in hotspots if f['properties']['source']==source}
        cells=[]
        for grid_id in sorted(ids):
            original=features[grid_id];props=original['properties']
            cells.append({'type':'Feature','geometry':original['geometry'],'properties':stats(grid_id,props['column'],props['row'])})
        day['by_source'][source]={'cells':ui.collection(cells)}
    return grid,day


class UIDataTests(unittest.TestCase):
    def setUp(self):
        self.grid,self.day=fixture();self.adjacency,self.geometries=ui.build_adjacency(self.grid)

    def test_overlapping_satellites_union_grid_and_keep_all_unique_observations(self):
        summary=ui.summarize_selection(self.day,[B,A],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(summary['grid_count'],2)
        self.assertEqual(summary['observation_count'],3)
        self.assertEqual(summary['cluster_count'],1)
        self.assertEqual(summary['ground_area_ha'],200)
        self.assertEqual(summary['emission_without_peat_kg'],21)
        self.assertEqual(summary['peat_emission_kg'],40)
        self.assertEqual(summary['emission_kg'],61)
        shared=next(f['properties'] for f in summary['cells']['features'] if f['properties']['grid_id']=='g0_0')
        self.assertEqual(shared['observation_count'],2)
        self.assertEqual(shared['sources'],[A,B])
        self.assertEqual(shared['emission_kg'],30)
        # Repeated identical raw IDs are counted once, without changing grid values.
        self.day['hotspots']['features'].append(copy.deepcopy(self.day['hotspots']['features'][0]))
        repeated=ui.summarize_selection(self.day,[A,B],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(repeated['observation_count'],3)
        self.assertEqual(repeated['emission_kg'],61)

    def test_unselected_connector_grid_never_bridges_a_cluster_gap(self):
        summary=ui.summarize_selection(self.day,[A,C],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(summary['grid_count'],2)
        self.assertEqual(summary['cluster_count'],2)
        self.assertEqual({tuple(f['properties']['cell_ids']) for f in summary['clusters']['features']},{('g0_0',),('g2_0',)})
        for feature in summary['clusters']['features']:
            ids=feature['properties']['cell_ids']
            expected=ui.unary_union([self.geometries[grid_id] for grid_id in ids])
            self.assertTrue(ui.shape(feature['geometry']).equals(expected))

    def test_adjacency_excludes_diagonal_contact_and_clipped_edge_gaps(self):
        # Nominally adjacent cells 0/1 have a real gap after clipping; 1/2 touch only at a point.
        clipped=ui.collection([grid_feature(0,0,box(0,0,.8,1)),grid_feature(1,0,box(1.2,0,2,1)),grid_feature(2,1,box(2,1,3,2))])
        adjacency,_=ui.build_adjacency(clipped)
        self.assertTrue(all(not neighbours for neighbours in adjacency.values()))
        self.assertEqual(len(ui.connected_groups(adjacency,adjacency)),3)

    def test_confirmed_zero_partial_zero_and_missing_are_distinct(self):
        missing=copy.deepcopy(self.day);missing['source_status'][D]['state']='unavailable'
        summary=ui.summarize_selection(missing,[D],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(summary['_state'],'missing');self.assertIsNone(summary['emission_kg'])
        self.assertIsNone(summary['observation_count']);self.assertEqual(summary['cells']['features'],[])
        zero=ui.summarize_selection(self.day,[D],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(zero['_state'],'ok');self.assertEqual(zero['emission_kg'],0)
        partial=copy.deepcopy(missing);partial['source_status'][C]['state']='ok'
        # Select one successfully queried zero source and one unavailable zero source.
        partial['hotspots']['features']=[]
        for source in (C,D):partial['by_source'][source]['cells']=ui.collection()
        result=ui.summarize_selection(partial,[C,D],self.adjacency,self.geometries,PARAMETERS)
        self.assertEqual(result['_state'],'partial');self.assertEqual(result['emission_kg'],0)
        with self.assertRaises(ValueError):ui.summarize_selection(self.day,[],self.adjacency,self.geometries,PARAMETERS)

    def test_disagreement_of_shared_grid_scientific_values_is_rejected(self):
        self.day['by_source'][B]['cells']['features'][0]['properties']['emission_kg']+=1
        with self.assertRaisesRegex(ValueError,'conflicting scientific'):ui.summarize_selection(self.day,[A,B],self.adjacency,self.geometries,PARAMETERS)

    def test_real_days_match_native_all_and_singles_and_cache_is_stable(self):
        data=Path(__file__).resolve().parents[1]/'web'/'data';fire=data/'fire'
        if not (fire/'index.json').exists():self.skipTest('Mirrored real source data not included')
        grid=ui.read_json(fire/'study_grid.geojson.gz');adjacency,geometries=ui.build_adjacency(grid);parameters=ui.read_json(fire/'parameters.json')
        index=ui.read_json(fire/'index.json')
        for date in index['dates']:
            day=ui.read_json(fire/'daily'/f'{date}.json')
            with self.subTest(date=date):
                result=ui.build_day(day,adjacency,geometries,parameters)
                self.assertEqual(len(result['selections']),15)
                for selected in [[source] for source in ui.SATELLITES]+[list(ui.SATELLITES)]:
                    derived=result['selections'][ui.canonical(selected)]
                    native=day['by_source']['ALL' if len(selected)==4 else selected[0]]
                    if derived['_state']!='missing':
                        for key in (*ui.NUMERIC,*ui.COUNTS):self.assertEqual(derived[key],native[key])
        # A second unchanged build rewrites neither data nor caches/timestamps.
        with contextlib.redirect_stdout(io.StringIO()):ui.build(data)
        paths=[data/'ui'/'fire_index.json',data/'ui'/'build-cache.json',data/'ui'/'adjacency.json',data/'ui'/'fire'/f"{index['dates'][0]}.json.gz"]
        before={str(path):(path.read_bytes(),path.stat().st_mtime_ns) for path in paths}
        with contextlib.redirect_stdout(io.StringIO()) as output:ui.build(data)
        self.assertIn('0 rebuilt',output.getvalue())
        for path in paths:self.assertEqual((path.read_bytes(),path.stat().st_mtime_ns),before[str(path)])


if __name__=='__main__':unittest.main()
