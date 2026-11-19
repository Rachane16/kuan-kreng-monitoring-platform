import importlib.util,json,tempfile,unittest
from pathlib import Path
from datetime import datetime,timedelta
from shapely.geometry import Polygon
spec=importlib.util.spec_from_file_location('stations',Path(__file__).resolve().parents[1]/'scripts/sync_stations.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
class StationSyncTests(unittest.TestCase):
 def test_hour_end_labels_exclude_future_and_keep_real_zero(self):
  now=S.instant('2026-11-19T08:30:00Z');start=S.instant('2026-11-18T17:00:00Z')
  rows=[['2026-11-19T07:00:00Z',0],['2026-11-19T08:00:00Z',12],['2026-11-19T09:00:00Z',99],['2026-11-19T06:00:00Z',-2],['2026-11-19T05:00:00Z',True]]
  out=S.normalize({'sensors':{'pm_2_5':{'data':rows}}},start,now+S.HOUR,now)
  self.assertEqual(out,{'2026-11-19T07:00:00Z':0.0,'2026-11-19T08:00:00Z':12.0})
 def test_conflicting_hour_is_missing_without_losing_other_hours(self):
  now=S.instant('2026-11-19T08:30:00Z');issues=[]
  out=S.normalize({'sensors':{'pm_2_5':{'data':[['2026-11-19T07:00:00Z',9],['2026-11-19T07:00:00Z',11],['2026-11-19T08:00:00Z',20]]}}},now-timedelta(days=1),now,now,issues)
  self.assertEqual(out,{'2026-11-19T08:00:00Z':20.0});self.assertEqual(issues,['2026-11-19T07:00:00Z'])
 def test_timezone_and_hour_alignment_are_required(self):
  now=S.instant('2026-11-19T08:30:00Z')
  for timestamp in ['2026-11-19T07:00:00','2026-11-19T07:20:00Z']:
   with self.assertRaises(ValueError):S.normalize({'sensors':{'pm_2_5':{'data':[[timestamp,5]]}}},now-timedelta(days=1),now,now)
 def test_real_boundary_hole_excludes_station_and_heartbeat_is_not_measurement(self):
  poly=Polygon([(100,7),(101,7),(101,9),(100,9)],holes=[[(100.1,8),(100.3,8),(100.3,8.3),(100.1,8.3)]])
  row={'coordinate':[8.1,100.2],'device_status':{'status':True,'last_update':'2026-11-19T08:30:00Z'}}
  meta=S.metadata(S.STATIONS[0][0],'station',row,{},poly)
  self.assertFalse(meta['inside_boundary']);self.assertTrue(meta['online']);self.assertNotIn('pm25',meta)
 def fixture(self,path):
  air=path/'air';air.mkdir()
  S.write(air/'boundary.geojson',{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[[[100,7],[100.2,7],[100.2,9],[100,9],[100,7]]]}}]})
 def fake(self,calls,empty=False):
  def get(endpoint,params):
   calls.append((endpoint,dict(params)))
   if endpoint=='/devices/locations':return {**{did:{'coordinate':[8,100.3 if i==3 else 100.1],'device_status':{'status':i!=2,'last_update':'2026-11-19T08:20:00Z'}} for i,(did,_) in enumerate(S.STATIONS)},'unrequested-station':{'coordinate':[8,100.1]}}
   if endpoint=='/devices/detail':return [{'model':'AeroSURE I'}]
   if endpoint=='/sensors/data/hourly/devices':return {'sensors':{'pm_2_5':{'data':[] if empty else [['2026-11-18T17:00:00Z',10],['2026-11-19T08:00:00Z',20]]}}}
   raise AssertionError(endpoint)
  return get
 def test_only_six_stations_and_pm25_are_requested_and_midnight_belongs_to_previous_day(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d);self.fixture(path);calls=[];result=S.sync(path,S.instant('2026-11-19T08:30:00Z'),2,self.fake(calls))
   self.assertEqual({s['id'] for s in result['stations']},S.IDS)
   self.assertEqual([x['date'] for x in result['days']],['2026-11-18','2026-11-19'])
   self.assertFalse(result['stations'][3]['inside_boundary'])
   for endpoint,params in calls:
    if 'device_id' in params:self.assertIn(params['device_id'],S.IDS)
    if 'sensor_type' in params:self.assertEqual(params['sensor_type'],'pm_2_5')
   self.assertEqual(S.load(path/'stations/daily/2026-11-18.json')['hours'][0]['start_utc'],'2026-11-18T16:00:00Z')
 def test_api_failure_retains_actual_observations_and_original_success_time(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d);self.fixture(path);first=S.sync(path,S.instant('2026-11-19T08:30:00Z'),2,self.fake([]));before=(path/'stations/daily/2026-11-19.json').read_bytes()
   def fail(*args):raise OSError('offline')
   after=S.sync(path,S.instant('2026-11-19T09:30:00Z'),2,fail)
   self.assertEqual((path/'stations/daily/2026-11-19.json').read_bytes(),before);self.assertEqual(after['state'],'partial')
   self.assertTrue(all(s['fetch_state']=='stale' for s in after['stations']));self.assertEqual(after['stations'][0]['last_success_utc'],first['stations'][0]['last_success_utc'])
 def test_successful_empty_requery_clears_values_instead_of_inventing_zero(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d);self.fixture(path);S.sync(path,S.instant('2026-11-19T08:30:00Z'),2,self.fake([]));after=S.sync(path,S.instant('2026-11-19T09:30:00Z'),2,self.fake([],empty=True))
   self.assertEqual(after['days'],[]);self.assertTrue(all(s['latest_hour_end_utc'] is None for s in after['stations']))
if __name__=='__main__':unittest.main()
