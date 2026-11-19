/* Hour-aligned ground-station PM2.5 only; no AOD or emission quantities. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./idw.js'));else root.KKStationModel=factory(root.KKIDW);})(typeof globalThis==='undefined'?this:globalThis,function(IDW){
'use strict';
const HOUR=3600000;
const time=t=>typeof t==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(t)?Date.parse(t):NaN;
const thaiDay=t=>new Date(t+7*HOUR).toISOString().slice(0,10);
function validHours(day,date,now=Date.now()){
 return (day?.hours||[]).filter(h=>Number.isFinite(time(h.end_utc))&&time(h.start_utc)===time(h.end_utc)-HOUR&&time(h.end_utc)<=now&&thaiDay(time(h.start_utc))===date&&h.values&&typeof h.values==='object').sort((a,b)=>time(a.end_utc)-time(b.end_utc));
}
function insideValues(catalog,hour,inside){return (catalog?.stations||[]).filter(s=>s.coordinate?.length===2&&s.coordinate.every(Number.isFinite)&&inside(s.coordinate)&&Number.isFinite(hour?.values?.[s.id])&&hour.values[s.id]>=0);}
function selectHour(catalog,day,date,{requested=null,now=Date.now(),inside=s=>true}={}){
 const hours=validHours(day,date,now);
 if(requested)return hours.find(h=>h.end_utc===requested)||null;
 const candidates=thaiDay(now)===date?hours.filter(h=>now-time(h.end_utc)<=2*HOUR):hours;
 return candidates.findLast(h=>insideValues(catalog,h,inside).length>=3)||candidates.at(-1)||null;
}
function frame(catalog,hour,grid,{inside=s=>true,project=coordinate=>[coordinate[1],coordinate[0]]}={}){
 const valid=insideValues(catalog,hour,inside);
 const points=valid.map(s=>{const [x,y]=project(s.coordinate);return {id:s.id,x,y,value:hour.values[s.id]};});
 const sampler=IDW.createSampler(points),values=new Map();let sum=0,weight=0;
 if(sampler)for(const feature of grid?.features||[]){const p=feature.properties,w=p.coverage_fraction??p.overlap_m2;
  if(![p.sample_x,p.sample_y].every(Number.isFinite))continue;
  const value=sampler(p.sample_x,p.sample_y).value;values.set(p.grid_id,value);if(Number.isFinite(w)&&w>0){sum+=w*value;weight+=w;}
 }
 return {hour,pointCount:points.length,ids:valid.map(s=>s.id),sampler,values,mean:weight?sum/weight:null,available:!!sampler&&weight>0,status:!hour?'missing':sampler?'available':'insufficient'};
}
return {validHours,selectHour,frame,thaiDay,time};
});
