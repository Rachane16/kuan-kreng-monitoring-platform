"""Mirror only six public AirThai stations, PM2.5 hourly mass concentration (ug/m3).
No credentials. API timestamps are hour END labels; incomplete hours are excluded.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
import hashlib,json,math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from shapely.geometry import Point,shape
from shapely.ops import unary_union

BASE='https://things.airthai.in.th/api/v1'
PROJECT='5fbcd21e875dc20cc990253f'
STATIONS=(
 ('68061839a24374609f4df379','โรงเรียนชะอวดเคร่งธรรมวิทยา'),
 ('5ffd7fc17bbb6491822283e9','สถานีควบคุมไฟป่าทะเลน้อย'),
 ('5ffd7fab73efe7b21cb18402','สถานีควบคุมไฟป่าพรุควนเคร็ง'),
 ('5ffe66fbee2238b3ab4463fe','เทศบาลตำบลหัวไทร'),
 ('6423b286477bb557f7de1ca9','เขตห้ามล่าสัตว์ป่าบ่อล้อ'),
 ('5ffd7fbceefb0ccacd581373','โรงเรียนวัดบ่อล้อ'),
)
IDS={s[0] for s in STATIONS}
UTC=timezone.utc
THAI=timezone(timedelta(hours=7))
HOUR=timedelta(hours=1)

def stamp(t):return t.astimezone(UTC).isoformat().replace('+00:00','Z')
def instant(t):
 if not isinstance(t,str):raise ValueError('Invalid observation time')
 dt=datetime.fromisoformat(t.replace('Z','+00:00'))
 if dt.utcoffset() is None:raise ValueError('Observation time needs a timezone')
 return dt.astimezone(UTC)
def number(v):return isinstance(v,(float,int)) and not isinstance(v,bool) and math.isfinite(v)
def load(path,default=None):return json.loads(Path(path).read_text(encoding='utf-8')) if Path(path).exists() else default

def write(path,data):
 path=Path(path);raw=(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode()
 if path.exists() and path.read_bytes()==raw:return
 path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_bytes(raw);tmp.replace(path)

def fetch(endpoint,params):
 url=BASE+endpoint+'?'+urlencode(params)
 req=Request(url,headers={'User-Agent':'KuanKrengMonitoringPlatform/1.0','Accept':'application/json'})
 with urlopen(req,timeout=35) as response:
  raw=response.read(6*1024*1024+1)
 if len(raw)>6*1024*1024:raise ValueError('Station response exceeds size bound')
 return json.loads(raw,parse_constant=lambda v:(_ for _ in ()).throw(ValueError('Non-finite response')))

def normalize(payload,start,end,now,issues=None):
 if not isinstance(payload,dict) or not isinstance(payload.get('sensors'),dict) or 'detail' in payload:raise ValueError('Invalid hourly response')
 sensor=payload['sensors'].get('pm_2_5')
 if sensor is None:return {}
 if not isinstance(sensor,dict) or not isinstance(sensor.get('data'),list):raise ValueError('Invalid PM2.5 series')
 result={};conflicts=set()
 for pair in sensor['data']:
  if not isinstance(pair,list) or len(pair)!=2:raise ValueError('Invalid hourly observation')
  t=instant(pair[0]);value=pair[1]
  if t.minute or t.second or t.microsecond:raise ValueError('Hourly timestamp is not aligned')
  # AirThai bins have right-edge labels. A completed bin [t-1h,t) belongs to
  # the Thai calendar day of t-1h, including the hour ending at midnight.
  if t-HOUR<start or t>end or t>now:continue
  if not number(value) or value<0:continue
  key=stamp(t)
  if key in conflicts:continue
  if key in result and result[key]!=value:
   conflicts.add(key);result.pop(key)
   if issues is not None:issues.append(key)
   continue
  result[key]=float(value)
 return result

def metadata(did,name,row,old,boundary):
 result={k:old.get(k) for k in ['model','model_checked_utc','coordinate','device_last_seen_utc','online']}
 result.update(id=did,name=name,excluded_hour_ends_utc=old.get('excluded_hour_ends_utc',[]))
 if row is not None:
  if not isinstance(row,dict):raise ValueError('Invalid station metadata')
  coord=row.get('coordinate')
  if not isinstance(coord,list) or len(coord)!=2 or not all(number(v) for v in coord) or not(-90<=coord[0]<=90 and -180<=coord[1]<=180):raise ValueError('Invalid station coordinates')
  result['coordinate']=coord
  status=row.get('device_status',{})
  if not isinstance(status,dict):status={}
  result['online']=status.get('status') if isinstance(status.get('status'),bool) else None
  seen=status.get('last_update') or row.get('last_update')
  try:result['device_last_seen_utc']=stamp(instant(seen))
  except (ValueError,TypeError):result['device_last_seen_utc']=None
 coord=result.get('coordinate')
 result['inside_boundary']=bool(coord and boundary.covers(Point(coord[1],coord[0])))
 return result

def sync(data_root,now=None,days=92,fetcher=fetch):
 now=(now or datetime.now(UTC)).astimezone(UTC);today=now.astimezone(THAI).date()
 start=datetime.combine(today-timedelta(days=days-1),datetime.min.time(),THAI).astimezone(UTC)
 output=Path(data_root)/'stations';old=load(output/'index.json',{}) or {}
 old_catalog={s['id']:s for s in old.get('stations',[]) if s.get('id') in IDS}
 boundary_path=Path(data_root)/'air'/'boundary.geojson';boundary_json=load(boundary_path)
 boundary=unary_union([shape(f['geometry']) for f in boundary_json['features']])
 cached={did:{} for did in IDS}
 for row in old.get('days',[]):
  if row.get('date','')<start.astimezone(THAI).date().isoformat():continue
  day=load(output/'daily'/(row['date']+'.json'),{}) or {}
  for hour in day.get('hours',[]):
   for did,value in hour.get('values',{}).items():
    if did in IDS and number(value) and value>=0:cached[did][hour['end_utc']]=value
 try:
  locations=fetcher('/devices/locations',{'project_id':PROJECT})
  if not isinstance(locations,dict) or 'detail' in locations:raise ValueError('Invalid station catalogue')
  location_state='ok'
 except Exception:
  locations={};location_state='stale' if old_catalog else 'missing'

 def update(item):
  did,name=item;previous=old_catalog.get(did,{})
  row=locations.get(did)
  try:record=metadata(did,name,row,previous,boundary)
  except ValueError:row=None;record=metadata(did,name,None,previous,boundary)
  record['catalog_state']='ok' if row is not None and record.get('coordinate') else 'stale' if record.get('coordinate') else 'missing'
  if not previous.get('model_checked_utc') or now-instant(previous['model_checked_utc'])>timedelta(days=7):
   try:
    detail=fetcher('/devices/detail',{'device_id':did})
    if not isinstance(detail,list) or not detail:raise ValueError('Invalid device detail')
    record['model']=str(detail[0].get('model') or '').strip() or None
    record['model_checked_utc']=stamp(now)
   except Exception:pass
  last=previous.get('last_success_utc')
  window=max(start,instant(last)-timedelta(hours=48)) if last else start
  points=dict(cached[did])
  try:
   payload=fetcher('/sensors/data/hourly/devices',{'device_id':did,'sensor_type':'pm_2_5','started_datetime':stamp(window-HOUR),'ended_datetime':stamp(now+HOUR)})
   issues=[];fresh=normalize(payload,window,now+HOUR,now,issues)
   record['excluded_hour_ends_utc']=sorted(set(k for k in previous.get('excluded_hour_ends_utc',[]) if instant(k)-HOUR<window).union(issues))
   points={k:v for k,v in points.items() if instant(k)-HOUR<window}
   points.update(fresh)
   record.update(fetch_state='ok',last_success_utc=stamp(now))
  except Exception:
   record.update(fetch_state='stale' if points else 'missing',last_success_utc=last)
  points={k:v for k,v in points.items() if start<=instant(k)-HOUR and instant(k)<=now}
  record['latest_hour_end_utc']=max(points) if points else None
  return record,points
 with ThreadPoolExecutor(max_workers=2) as executor:results=list(executor.map(update,STATIONS))
 grouped={}
 for station,points in results:
  for end,value in points.items():
   date=(instant(end)-HOUR).astimezone(THAI).date().isoformat()
   grouped.setdefault(date,{}).setdefault(end,{})[station['id']]=value
 days_out=[]
 for date,hours in sorted(grouped.items()):
  rows=[{'start_utc':stamp(instant(end)-HOUR),'end_utc':end,'values':values} for end,values in sorted(hours.items())]
  payload={'schema_version':1,'date':date,'unit':'ug/m3','pollutant':'pm25','hours':rows}
  write(output/'daily'/(date+'.json'),payload)
  inside={s['id'] for s,_ in results if s['inside_boundary']}
  days_out.append({'date':date,'hours':len(rows),'max_inside_stations':max(sum(did in inside for did in h['values']) for h in rows)})
 states=[r['fetch_state'] for r,_ in results]
 catalog={'schema_version':1,'provider':'AirThai / Air Pollution Research Center, PSU','source_url':'https://airthai.in.th/th/','api_base':BASE,'project_id':PROJECT,
  'unit':'ug/m3','pollutant':'pm25','hour_labels':'end','time_zone':'Asia/Bangkok','generated_at_utc':stamp(now),
  'state':'ok' if all(s=='ok' for s in states) and location_state=='ok' and all(r['catalog_state']=='ok' for r,_ in results) else 'partial' if any(s!='missing' for s in states) else 'missing',
  'boundary_sha256':hashlib.sha256(boundary_path.read_bytes()).hexdigest(),'start_date':start.astimezone(THAI).date().isoformat(),'end_date':today.isoformat(),
  'stations':[r for r,_ in results],'days':days_out}
 write(output/'index.json',catalog)
 print('AirThai: six allowlisted stations; '+str(len(days_out))+' days; '+catalog['state'])
 return catalog

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--data',type=Path,default=Path('web/data'));args=parser.parse_args();sync(args.data)
