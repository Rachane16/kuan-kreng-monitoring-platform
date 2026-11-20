/* Public AirThai observations: six allowlisted devices, no credentials. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./station-model.js'));
 else root.KKStationLive=factory(root.KKStationModel);
})(typeof globalThis==='undefined'?this:globalThis,function(M){
'use strict';
const BASE='https://things.airthai.in.th/api/v1',PROJECT='5fbcd21e875dc20cc990253f',HOUR=3600000;
const STATIONS=Object.freeze([
 ['68061839a24374609f4df379','โรงเรียนชะอวดเคร่งธรรมวิทยา'],
 ['5ffd7fc17bbb6491822283e9','สถานีควบคุมไฟป่าทะเลน้อย'],
 ['5ffd7fab73efe7b21cb18402','สถานีควบคุมไฟป่าพรุควนเคร็ง'],
 ['5ffe66fbee2238b3ab4463fe','เทศบาลตำบลหัวไทร'],
 ['6423b286477bb557f7de1ca9','เขตห้ามล่าสัตว์ป่าบ่อล้อ'],
 ['5ffd7fbceefb0ccacd581373','โรงเรียนวัดบ่อล้อ']
]);
const IDS=new Set(STATIONS.map(s=>s[0])),numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const iso=t=>new Date(t).toISOString();
function pairs(payload,id){
 if(!payload||typeof payload!=='object'||payload.detail||!payload.sensors||typeof payload.sensors!=='object'||payload.device_id&&payload.device_id!==id)throw Error('Invalid station response');
 const sensor=payload.sensors.pm_2_5;if(sensor==null)return [];
 if(!sensor||!Array.isArray(sensor.data))throw Error('Invalid PM2.5 series');
 const values=new Map(),conflicts=new Set();
 for(const row of sensor.data){
  if(!Array.isArray(row)||row.length!==2)continue;
  const t=M.time(row[0]),v=row[1];if(!Number.isFinite(t)||!numeric(v)||conflicts.has(t))continue;
  if(values.has(t)&&values.get(t)!==v){values.delete(t);conflicts.add(t);}else values.set(t,v);
 }
 return [...values].sort((a,b)=>a[0]-b[0]);
}
function minuteReading(payload,id,date,now=Date.now()){
 if(!IDS.has(id))throw Error('Station is not allowlisted');
 const entries=pairs(payload,id).filter(([t])=>t<=now&&t>=now-2*HOUR&&M.thaiDay(t)===date);
 const latest=entries.at(-1);return latest?{value:latest[1],time_utc:iso(latest[0]),kind:'minute',source:'airthai_api',checked_at_utc:iso(now),fetch_failed:false}:null;
}
function hourlyValues(payload,id,date,now=Date.now()){
 if(!IDS.has(id))throw Error('Station is not allowlisted');
 return pairs(payload,id).filter(([t])=>t%HOUR===0&&t<=now&&M.thaiDay(t-HOUR)===date).map(([t,value])=>({end_utc:iso(t),value}));
}
function mergeHours(day,updates,date,now=Date.now()){
 const hours=new Map();
 for(const row of M.validHours(day,date,now))hours.set(iso(M.time(row.end_utc)),{...row,values:Object.fromEntries(Object.entries(row.values).filter(([id,v])=>IDS.has(id)&&numeric(v)))});
 for(const item of updates){
  if(!IDS.has(item.id)||item.state!=='ok')continue;
  // A successful empty query clears this station's old values. Failure retains them.
  for(const row of hours.values())delete row.values[item.id];
  for(const point of item.values){
   const key=iso(M.time(point.end_utc)),row=hours.get(key)||{start_utc:iso(M.time(key)-HOUR),end_utc:key,values:{}};
   row.values[item.id]=point.value;hours.set(key,row);
  }
 }
 return {schema_version:1,date,unit:'ug/m3',pollutant:'pm25',hours:[...hours.values()].filter(h=>Object.keys(h.values).length).sort((a,b)=>M.time(a.end_utc)-M.time(b.end_utc))};
}
function freshness(reading,now=Date.now()){
 if(!reading||!numeric(reading.value)||!Number.isFinite(M.time(reading.time_utc)))return {state:'missing',ageMinutes:null};
 const age=(now-M.time(reading.time_utc))/60000;
 if(age<0)return {state:'missing',ageMinutes:null};
 return {state:reading.kind==='minute'?(age<=5?'fresh':age<=15?'delayed':'stale'):(age<=120?'hourly':'stale'),ageMinutes:Math.floor(age)};
}
async function pool(items,worker){
 let index=0;const output=new Array(items.length);
 await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{while(index<items.length){const i=index++;output[i]=await worker(items[i]);}}));return output;
}
function createClient(fetcher=(...args)=>fetch(...args)){
 async function get(endpoint,params){
  if(!['/devices/locations','/sensors/data/minute/devices','/sensors/data/hourly/devices'].includes(endpoint)||params.device_id&&!IDS.has(params.device_id))throw Error('Unexpected AirThai request');
  const url=new URL(BASE+endpoint);for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetcher(url.href,{credentials:'omit',cache:'no-store',mode:'cors',signal:controller.signal});if(!response.ok)throw Error('AirThai HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}
 }
 async function read({date,catalog={stations:[]},day={hours:[]},readings=new Map(),now=Date.now(),minutes=true,hours=true,metadata=true}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||iso(Date.parse(date+'T00:00:00Z')).slice(0,10)!==date||date>M.thaiDay(now)||Date.parse(date)<now-367*24*HOUR)throw Error('Invalid station date');
  const previous=new Map((catalog.stations||[]).map(s=>[s.id,s]));
  let stations=STATIONS.map(([id,name])=>({...previous.get(id),id,name})),locations=null,metadataError=false;
  if(metadata){try{locations=await get('/devices/locations',{project_id:PROJECT});if(!locations||typeof locations!=='object'||locations.detail)throw Error('Invalid station catalogue');}catch{metadataError=true;}}
  if(locations)stations=stations.map(s=>{const row=locations[s.id],coord=row?.coordinate;
   if(!row||!Array.isArray(coord)||coord.length!==2||!coord.every(Number.isFinite)||Math.abs(coord[0])>90||Math.abs(coord[1])>180)return {...s,catalog_state:'stale'};
   const seen=M.time(row.device_status?.last_update||row.last_update);
   return {...s,coordinate:coord,online:typeof row.device_status?.status==='boolean'?row.device_status.status:null,device_last_seen_utc:Number.isFinite(seen)?iso(seen):null,catalog_state:'ok'};
  });
  const minuteUpdates=minutes&&date===M.thaiDay(now)?await pool(STATIONS,async([id])=>{try{
   const payload=await get('/sensors/data/minute/devices',{device_id:id,sensor_type:'pm_2_5',started_datetime:iso(now-2*HOUR),ended_datetime:iso(now)});
   return {id,state:'ok',reading:minuteReading(payload,id,date,now)};
  }catch{return {id,state:'error'};}}):[];
  const nextReadings=new Map(readings);
  for(const item of minuteUpdates){if(item.state==='ok'){if(item.reading)nextReadings.set(item.id,item.reading);else nextReadings.delete(item.id);}else if(nextReadings.has(item.id))nextReadings.set(item.id,{...nextReadings.get(item.id),fetch_failed:true});}
  const start=Date.parse(date+'T00:00:00+07:00'),end=start+24*HOUR;
  const hourUpdates=hours?await pool(STATIONS,async([id])=>{try{
   const payload=await get('/sensors/data/hourly/devices',{device_id:id,sensor_type:'pm_2_5',started_datetime:iso(start-HOUR),ended_datetime:iso(Math.min(end+HOUR,now+HOUR))});
   return {id,state:'ok',values:hourlyValues(payload,id,date,now)};
  }catch{return {id,state:'error',values:[]};}}):[];
  const merged=mergeHours(day,hourUpdates,date,now),attempts=[...minuteUpdates,...hourUpdates];
  return {catalog:{...catalog,stations},day:merged,readings:nextReadings,checkedAt:iso(now),
   minuteUpdates,hourUpdates,metadataError,errors:attempts.filter(r=>r.state!=='ok').length+(metadataError?1:0),successes:attempts.filter(r=>r.state==='ok').length};
 }
 return {read};
}
return {STATIONS,minuteReading,hourlyValues,mergeHours,freshness,createClient};
});
