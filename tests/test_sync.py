"""Data boundary checks: pinned content, atomic snapshots, and grid correspondence."""
from __future__ import annotations
import copy
import gzip
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('platform_sync', Path(__file__).resolve().parents[1]/'scripts'/'sync_data.py')
syncer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(syncer)


def feature(grid_id, **properties):
    return {'type':'Feature','properties':{'grid_id':grid_id,**properties},
            'geometry':{'type':'Polygon','coordinates':[[[100,8],[100.01,8],[100.01,8.01],[100,8.01],[100,8]]]}}


def collection(features):
    return {'type':'FeatureCollection','features':features}


def air_fixture(root):
    target=root/'docs'/'data'
    target.mkdir(parents=True)
    grid=collection([feature(f'E{(604+i)*1000}_N0908000', sample_x=604500+i*1000,sample_y=908500,coverage_fraction=1)
                     for i in range(1052)])
    cam=collection([feature('CAMS_8.0_100.0',overlap_m2=1e6)])
    row={'date':'2026-11-17','status':'Available','available_cells':1,'mean_pm25':20,
         'cells':[['E604000_N0908000',.1,20,'2026-11-17T02:00:00Z',1]]}
    history={'generated_at_utc':'2026-11-18T01:00:00Z','start_date':'2026-11-17','end_date':'2026-11-17','grid_count':1052,'days':[row]}
    cams=copy.deepcopy(history);cams['grid_count']=1;cams['days'][0]['cells']=[['CAMS_8.0_100.0',.1,20,24]]
    base=syncer.iso_time('2026-11-17T00:00:00Z')
    forecast={'generated_at_utc':'2026-11-18T01:00:00Z','forecast_base_time':base.isoformat(),
              'grid_count':1,'resolution_degrees':.4,'hours':[]}
    for h in range(121):
        forecast['hours'].append({'valid_time':(base+syncer.timedelta(hours=h)).isoformat(),
            'forecast_base_time':base.isoformat(),'lead_time_hours':[h,h],
            'status':'Available','available_cells':1,'mean_pm25':20,'cells':[['CAMS_8.0_100.0',.1,20,1]]})
    for name,payload in {'grid.geojson':grid,'boundary.geojson':collection([feature('boundary')]),
                         'cams_grid.geojson':cam,'history.json':history,'cams_history.json':cams,'cams_forecast.json':forecast}.items():
        syncer.write_json(target/name,payload)
    return target


class SyncTests(unittest.TestCase):
    def test_crosswalk_preserves_original_ids_and_rejects_spatial_mismatch(self):
        a=collection([feature('E604000_N0908000',coverage_fraction=.25), feature('E605000_N0908000',coverage_fraction=1)])
        f=collection([feature('KK47_E604_N908',area_ha=25), feature('KK47_E605_N908',area_ha=100)])
        result=syncer.validate_grid_pair(a,f,expected_count=2)
        self.assertEqual(result['matching_cells'],2)
        self.assertEqual(result['cells'][0],{'air_id':'E604000_N0908000','fire_id':'KK47_E604_N908','column':604,'row':908})
        # Same IDs/counts alone are insufficient: actual clipped geometry must match.
        f['features'][0]['geometry']['coordinates'][0][0][0]+=0.001
        with self.assertRaisesRegex(ValueError,'geometry differs'):syncer.validate_grid_pair(a,f,expected_count=2)

    def test_curated_inventory_cannot_mirror_secrets_or_models(self):
        tree=[{'type':'blob','path':'docs/data/'+p,'sha':'abc','size':10} for p in syncer.SOURCES['air']['required']]
        tree.extend([{'type':'blob','path':p,'sha':'secret','size':1} for p in
                     ['.env','models/model.pkl','docs/data/token.json','docs/data/raw.hdf','docs/data/../key.json']])
        self.assertEqual(set(syncer.selected_paths('air',tree)),set(syncer.SOURCES['air']['required']))

    def test_air_forecast_rejects_missing_hours_negative_values_and_duplicate_days(self):
        with tempfile.TemporaryDirectory() as directory:
            root=air_fixture(Path(directory));syncer.validate_air(root)
            forecast=syncer.read_json(root/'cams_forecast.json');forecast['hours'].pop()
            syncer.write_json(root/'cams_forecast.json',forecast)
            with self.assertRaisesRegex(ValueError,'Incomplete'):syncer.validate_air(root)
            root=air_fixture(Path(directory)/'next')
            history=syncer.read_json(root/'history.json');history['days'][0]['cells'][0][2]=-1
            syncer.write_json(root/'history.json',history)
            with self.assertRaisesRegex(ValueError,'Invalid AOD or PM2.5'):syncer.validate_air(root)
            history['days'][0]['cells'][0][2]=20;history['days'].append(copy.deepcopy(history['days'][0]))
            syncer.write_json(root/'history.json',history)
            with self.assertRaisesRegex(ValueError,'Duplicate air'):syncer.validate_air(root)

    def test_unchanged_pinned_files_are_reused_and_bad_batch_never_replaces_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);upstream=air_fixture(home/'upstream');output=home/'web'/'data'
            output.mkdir(parents=True);shutil.copytree(upstream,output/'air')
            _,files=syncer.local_inventory('air',home/'upstream')
            with patch.object(syncer,'remote_inventory',return_value=('a'*40,files)),patch.object(syncer,'fetch_bytes',side_effect=AssertionError('Unchanged blob should not download')):
                stage,record,changed=syncer.stage_source('air',output,{})
            self.assertEqual(changed,[]);self.assertEqual(record['commit_sha'],'a'*40)
            syncer.safe_remove(stage,output.parent)
            original=(output/'air'/'history.json').read_bytes()
            invalid=json.loads(original);invalid['days'][0]['cells'][0][2]=-2
            invalid=json.dumps(invalid).encode();changed_files=copy.deepcopy(files)
            changed_files['history.json']={'blob_sha':syncer.git_blob_sha(invalid),'size':len(invalid)}
            with patch.object(syncer,'remote_inventory',return_value=('b'*40,changed_files)),patch.object(syncer,'fetch_bytes',return_value=invalid):
                with self.assertRaisesRegex(ValueError,'Invalid AOD or PM2.5'):syncer.stage_source('air',output,{})
            self.assertEqual((output/'air'/'history.json').read_bytes(),original)
            self.assertEqual(list(output.parent.glob('.sync-*')),[])

    def test_failure_manifest_does_not_turn_old_source_time_into_current_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'web'/'data';(output/'air').mkdir(parents=True)
            (output/'air'/'saved.txt').write_text('known-good',encoding='utf-8')
            old={'state':'ok','commit_sha':'a'*40,'synced_at_utc':'2026-11-16T00:00:00Z','upstream_updated_at_utc':'2026-11-15T00:00:00Z','coverage':{'end_date':'2026-11-15'}}
            syncer.write_json(output/'manifest.json',{'sources':{'air':old}})
            with patch.object(syncer,'stage_source',side_effect=ValueError('Invalid upstream batch')):
                result=syncer.sync(output)
            source=result['sources']['air']
            self.assertEqual(source['state'],'stale')
            self.assertEqual(source['upstream_updated_at_utc'],old['upstream_updated_at_utc'])
            self.assertEqual(source['synced_at_utc'],old['synced_at_utc'])
            self.assertEqual(source['commit_sha'],old['commit_sha'])
            self.assertEqual((output/'air'/'saved.txt').read_text(),'known-good')
            self.assertEqual(result['sources']['fire']['state'],'unavailable')

    def test_cleanup_guard_prevents_removing_output_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):syncer.safe_remove(directory,directory)


if __name__=='__main__':unittest.main()
