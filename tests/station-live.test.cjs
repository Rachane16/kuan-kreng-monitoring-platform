const {test}=require('node:test'),assert=require('node:assert/strict');
const Live=require('../web/station-live.js'),M=require('../web/station-model.js');
const ids=Live.STATIONS.map(s=>s[0]),now=Date.parse('2026-11-20T08:25:00Z'),date='2026-11-20';
const payload=(id,data)=>({device_id:id,sensors:{pm_2_5:{data}}});
const hour=(end,values)=>({end_utc:end,start_utc:new Date(Date.parse(end)-3600000).toISOString(),values});

test('minute observations preserve real zero, reject future/no-timezone/conflicting samples, and use measurement time',()=>{
 const rows=[['2026-11-20T08:23:00Z',2],['2026-11-20T08:23:00Z',3],['2026-11-20T08:24:00Z',0],['2026-11-20T08:24:30',99],['2026-11-20T08:25:01Z',80],['2026-11-20T08:24:40Z',true],['2026-11-20T08:24:50Z',-1]];
 const r=Live.minuteReading(payload(ids[0],rows),ids[0],date,now);
 assert.equal(r.value,0);assert.equal(r.time_utc,'2026-11-20T08:24:00.000Z');assert.equal(r.kind,'minute');
 assert.deepEqual(Live.freshness(r,now),{state:'fresh',ageMinutes:1});
 assert.equal(Live.minuteReading(payload(ids[0],[['2026-11-20T05:00:00Z',9]]),ids[0],date,now),null);
 assert.equal(Live.freshness({...r,time_utc:'2026-11-20T08:00:00Z'},now).state,'stale');
 assert.throws(()=>Live.minuteReading(payload(ids[0],[]),'unrequested',date,now));
});
test('hourly observations exclude the unfinished hour and retain the correct Thai day at midnight',()=>{
 const rows=[['2026-11-20T08:00:00Z',4],['2026-11-20T09:00:00Z',99],['2026-11-19T17:00:00Z',8],['2026-11-20T07:10:00Z',5]];
 assert.deepEqual(Live.hourlyValues(payload(ids[0],rows),ids[0],date,now),[{end_utc:'2026-11-20T08:00:00.000Z',value:4}]);
 assert.equal(Live.hourlyValues(payload(ids[0],rows),ids[0],'2026-11-19',now)[0].value,8);
});
test('a heartbeat cannot create a PM2.5 measurement and a response cannot change its requested device',()=>{
 const p={device_id:ids[0],device_status:{status:true,last_update:'2026-11-20T08:25:00Z'},sensors:{}};
 assert.equal(Live.minuteReading(p,ids[0],date,now),null);
 assert.throws(()=>Live.minuteReading(payload(ids[1],[['2026-11-20T08:24:00Z',9]]),ids[0],date,now));
});
test('successful empty station hours clear corrected data; failed requests preserve prior values; unknown devices never enter IDW',()=>{
 const old={hours:[hour('2026-11-20T07:00:00Z',{[ids[0]]:10,[ids[1]]:20,unrequested:999})]};
 const merged=Live.mergeHours(old,[{id:ids[0],state:'ok',values:[]},{id:ids[1],state:'error',values:[]}],date,now);
 assert.deepEqual(merged.hours[0].values,{[ids[1]]:20});assert.equal(old.hours[0].values[ids[0]],10);
});
test('direct API client requests only six PM2.5 devices, omits credentials and reports actual minute/hour sources',async()=>{
 const calls=[];
 const fetcher=async(url,options)=>{const u=new URL(url),id=u.searchParams.get('device_id');calls.push({u,options});
  const body=u.pathname.endsWith('/devices/locations')?Object.fromEntries([...ids,'unrequested'].map(id=>[id,{coordinate:[8,100],device_status:{status:true,last_update:'2026-11-20T08:25:00Z'}}])):payload(id,u.pathname.includes('/minute/')?[['2026-11-20T08:24:00Z',1]]:[['2026-11-20T08:00:00Z',4],['2026-11-20T09:00:00Z',99]]);
  return {ok:true,json:async()=>body};};
 const r=await Live.createClient(fetcher).read({date,now});
 assert.equal(r.catalog.stations.length,6);assert.equal(r.readings.size,6);assert.equal(r.errors,0);
 assert.equal(r.day.hours.length,1);assert.equal(r.day.hours[0].end_utc,'2026-11-20T08:00:00.000Z');
 assert.equal(r.readings.get(ids[0]).time_utc,'2026-11-20T08:24:00.000Z');
 for(const {u,options}of calls){assert.equal(u.hostname,'things.airthai.in.th');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');if(u.searchParams.has('device_id')){assert.ok(ids.includes(u.searchParams.get('device_id')));assert.equal(u.searchParams.get('sensor_type'),'pm_2_5');}}
});
test('API outages retain the original observation time and old hourly support without inventing fresh values',async()=>{
 const previous={value:5,time_utc:'2026-11-20T08:00:00Z',kind:'minute'},day={hours:[hour('2026-11-20T08:00:00Z',{[ids[0]]:4})]};
 const r=await Live.createClient(async()=>{throw Error('offline');}).read({date,now,day,readings:new Map([[ids[0],previous]]),metadata:false});
 assert.equal(r.readings.get(ids[0]).time_utc,previous.time_utc);assert.equal(r.readings.get(ids[0]).fetch_failed,true);
 assert.equal(Live.freshness(r.readings.get(ids[0]),now).state,'stale');assert.equal(r.day.hours[0].values[ids[0]],4);assert.equal(r.successes,0);assert.equal(r.errors,12);
});
test('IDW uses one completed common interval even when station minute observations have newer individual times',async()=>{
 const c={stations:ids.slice(0,3).map((id,i)=>({id,coordinate:[[0,0],[0,1000],[1000,0]][i]}))};
 const readings=new Map(c.stations.map((s,i)=>[s.id,{value:100+i,time_utc:'2026-11-20T08:24:00Z',kind:'minute'}]));
 const day={hours:[hour('2026-11-20T08:00:00Z',Object.fromEntries(c.stations.map((s,i)=>[s.id,10+i])))]};
 const selected=M.selectHour(c,day,date,{now});const f=M.frame(c,selected,{features:[]},{project:p=>[p[1],p[0]]});
 assert.equal(f.sampler(0,0).value,10);assert.equal(readings.get(ids[0]).value,100);assert.equal(f.hour.end_utc,'2026-11-20T08:00:00Z');
});
test('historical requests never query current minute observations and date bounds prevent future queries',async()=>{
 const seen=[];const client=Live.createClient(async url=>{seen.push(url);return {ok:true,json:async()=>payload(new URL(url).searchParams.get('device_id'),[])};});
 await client.read({date:'2026-11-19',now,metadata:false});assert.equal(seen.length,6);assert.ok(seen.every(url=>url.includes('/hourly/')));
 await assert.rejects(client.read({date:'2026-11-21',now}));
});
