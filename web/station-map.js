/* Map-only AirThai: live minute markers and separate same-hour IDW. */
window.KKStationMap={create({map,grid,boundary,bounds,projection,readJson,onChange,insideGeometry,dateText,timeText,format}){
const $=id=>document.getElementById(id),M=KKStationModel,Live=KKStationLive,client=Live.createClient();
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q=new URLSearchParams(location.search),cache=new Map(),surfaces=new Map();
let catalog={stations:[],days:[]},day=null,date=null,requested=q.get('station_hour')||null,idwOn=q.get('station_idw')==='1',markersOn=q.get('stations')==='1';
let loading=false,refreshing=false,job=0,paintJob=0,markerLayer=null,surfaceLayer=null,frame=null,fetchError=false,lastRenderKey='',popupOpen=false;
let readings=new Map(),liveResult=null,liveBusy=null,pendingLive=false,lastAttempt=0,lastHours=0,lastMetadata=0,liveDate=null;
const inside=coordinate=>Array.isArray(coordinate)&&boundary.features.some(f=>insideGeometry([coordinate[1],coordinate[0]],f.geometry));
const autoToday=()=>!requested&&date===KKData.thaiDay(),liveMarkers=()=>autoToday()&&!idwOn;
const hourText=hour=>hour?timeText(hour.start_utc)+'–'+new Date(hour.end_utc).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hour12:false})+' น.':'ไม่มีข้อมูลรายชั่วโมงของวันที่เลือก';
function recompute(){const hour=M.selectHour(catalog,day,date,{requested,inside});frame=M.frame(catalog,hour,grid,{inside,project:coordinate=>projection.forward([coordinate[1],coordinate[0]])});lastRenderKey='';}
function markerReading(s){
 if(liveMarkers()){
  const minute=readings.get(s.id);if(minute&&KKData.thaiDay(minute.time_utc)===date)return minute;
  const hour=M.validHours(day,date).findLast(h=>Number.isFinite(h.values[s.id])&&h.values[s.id]>=0);
  return hour?{value:hour.values[s.id],time_utc:hour.end_utc,start_utc:hour.start_utc,kind:'hourly',source:'hourly_fallback'}:null;
 }
 const value=frame?.hour?.values?.[s.id];
 return Number.isFinite(value)&&value>=0?{value,time_utc:frame.hour.end_utc,start_utc:frame.hour.start_utc,kind:'hourly',source:'selected_hour'}:null;
}
function readingText(reading){return !reading?'ไม่มีค่าตรวจวัดที่ใช้ได้':reading.kind==='minute'?timeText(reading.time_utc)+' น. · ค่ารายนาที':hourText({start_utc:reading.start_utc,end_utc:reading.time_utc})+' · ค่าเฉลี่ยรายชั่วโมง';}
function ageText(reading){
 const fresh=Live.freshness(reading);
 if(fresh.state==='missing')return 'ไม่มีเวลาตรวจวัดที่ใช้ได้';
 if(!liveMarkers())return requested||date!==KKData.thaiDay()?'กำลังดูชั่วโมงย้อนหลัง':'ชั่วโมงที่ครบแล้วสำหรับ IDW';
 const label=fresh.state==='fresh'?'ข้อมูลล่าสุด':fresh.state==='delayed'?'ข้อมูลล่าช้า':fresh.state==='hourly'?'สำรองจากค่าเฉลี่ยรายชั่วโมง':'ข้อมูลเก่า';
 return label+' · '+fresh.ageMinutes+' นาที'+(reading.fetch_failed?' · ดึง API รอบใหม่ไม่สำเร็จ':'');
}
function popup(s){
 const reading=markerReading(s),valid=!!reading,within=s.coordinate&&inside(s.coordinate),online=s.online===true?'Active':s.online===false?'Inactive':'ไม่ทราบ';
 return `<div class="popup-heading">${escape(s.name)}</div><div class="popup-stat"><span>PM₂.₅ จากสถานี · ${reading?.kind==='minute'?'ค่ารายนาทีล่าสุด':'ค่าเฉลี่ยรายชั่วโมง'}</span><strong>${valid?format(reading.value,2):'—'}<small>µg/m³</small></strong><div class="popup-meta">${escape(readingText(reading))}</div><div class="station-freshness ${Live.freshness(reading).state}">${escape(ageText(reading))}</div></div>`+
 `<div class="station-popup-details"><p>เครื่องมือ: ${escape(s.model||'API ไม่ระบุรุ่น')}</p><p>ตำแหน่ง: ${s.coordinate?format(s.coordinate[0],5)+', '+format(s.coordinate[1],5):'ไม่ทราบ'}</p><p>${within?'อยู่ในขอบเขตพรุควนเคร็ง':'อยู่นอกขอบเขต · ไม่ใช้คำนวณ IDW'}</p><p>สถานะอุปกรณ์ล่าสุด: ${online}</p><p>อุปกรณ์ติดต่อครั้งล่าสุด: ${escape(s.device_last_seen_utc?timeText(s.device_last_seen_utc)+' น.':'ไม่มีเวลา')} (แยกจากเวลาตรวจวัดฝุ่น)</p><p>รับข้อมูลย้อนหลังไว้: ${escape(s.last_success_utc?timeText(s.last_success_utc)+' น.':'ยังไม่สำเร็จ')}</p></div><a class="station-source-link" href="https://airthai.in.th/th/devices/dust_sensors?project_id=65bfa9705d10c350c04f0bd9&device_id=${encodeURIComponent(s.id)}&api_id=65bfaf5584b7f59060a1bfcd" target="_blank" rel="noopener">ที่มา: AirThai · ศูนย์วิจัยมลพิษทางอากาศ ม.อ.</a>`;
}
function drawMarkers(){
 const opened=catalog.stations.find(s=>s._marker?.isPopupOpen())?.id;
 if(markerLayer){map.removeLayer(markerLayer);markerLayer=null;}
 markerLayer=L.layerGroup();
 for(const s of catalog.stations){if(!s.coordinate?.every(Number.isFinite))continue;
  const reading=markerReading(s),valid=!!reading,fresh=Live.freshness(reading),old=liveMarkers()&&fresh.state==='stale',hex=valid&&!old?KKData.color(reading.value,'pm25'):'#dce3dc',within=inside(s.coordinate),label=s.name+' · '+(valid?format(reading.value,1)+' µg/m³ · '+readingText(reading):'ไม่มีค่าที่ใช้ได้');
  const marker=L.marker(s.coordinate,{pane:'stations',keyboard:true,title:label,icon:L.divIcon({className:'airthai-marker',iconSize:[43,36],iconAnchor:[21,18],html:`<span class="station-map-pin${within?'':' outside'}${old?' stale':''}" style="--station-color:${hex}">${valid?format(reading.value,1):'—'}</span>`})}).bindPopup(popup(s),{maxWidth:350,maxHeight:430,className:'airthai-station-popup',autoPanPaddingTopLeft:[20,100],autoPanPaddingBottomRight:[20,20]}).bindTooltip(escape(s.name+' · '+(reading?.kind==='minute'?'รายนาที':'รายชั่วโมง')),{direction:'top',offset:[0,-20]});
  marker.on('add',()=>{const el=marker.getElement();if(el)el.setAttribute('aria-label','สถานี AirThai '+label);});
  markerLayer.addLayer(marker);s._marker=marker;
 }
 if(markersOn)markerLayer.addTo(map);
 if(opened&&markersOn)catalog.stations.find(s=>s.id===opened)?._marker?.openPopup();
}
function renderPanel(){
 $('station-markers').checked=markersOn;$('station-idw').checked=idwOn;
 const select=$('station-hour');select.replaceChildren();
 const auto=document.createElement('option');auto.value='auto';auto.textContent=liveMarkers()?'ล่าสุดอัตโนมัติ · ค่ารายนาที':'ล่าสุดอัตโนมัติ · ชั่วโมงที่ครบแล้ว';select.append(auto);
 for(const h of M.validHours(day,date)){const option=document.createElement('option');option.value=h.end_utc;option.textContent=hourText(h);select.append(option);}
 if(requested&&![...select.options].some(o=>o.value===requested)){const option=document.createElement('option');option.value=requested;option.textContent='ชั่วโมงที่เลือก · ยังไม่มีข้อมูล';select.append(option);}
 select.value=requested||'auto';select.disabled=loading;
 const historical=!!requested||date!==KKData.thaiDay();
 $('station-frame-time').textContent=liveMarkers()?'หมุด: ค่ารายนาทีล่าสุดของแต่ละสถานี':(historical?'กำลังดูย้อนหลัง · ':'หมุดและ IDW · ')+hourText(frame?.hour);
 $('station-idw-status').textContent=loading?'กำลังโหลดสถานีของวันที่เลือก…':frame?.status==='available'?`IDW พร้อม · ${frame.pointCount} สถานีในขอบเขต · ${hourText(frame.hour)}`:frame?.status==='insufficient'?`มี ${frame.pointCount} สถานีที่ใช้ได้ · IDW ต้องมีอย่างน้อย 3 จุดที่ไม่อยู่ในแนวเดียวกัน`:'ยังไม่มีชั่วโมงร่วมที่ใช้ทำ IDW ได้';
 const status=$('station-live-status');
 status.className='station-live-status'+(liveResult?.errors||fetchError?' delayed':'');
 status.textContent=refreshing?'กำลังดึงค่าจาก AirThai โดยตรง…':liveResult?`ตรวจ API ${timeText(liveResult.checkedAt)} น.${liveResult.errors?' · บางสถานีดึงไม่สำเร็จ ใช้ข้อมูลเดิมพร้อมเวลา':''}${date===KKData.thaiDay()?' · ตรวจใหม่ทุก 1 นาทีเมื่อเปิดดู':''}`:date===KKData.thaiDay()?'เปิดสถานีเพื่อดึงค่าล่าสุดจาก AirThai โดยตรง':'ข้อมูลชั่วโมงย้อนหลังของวันที่เลือก';
 $('station-sync-time').textContent=catalog.generated_at_utc?'ข้อมูลสำรองย้อนหลังจาก GitHub: '+timeText(catalog.generated_at_utc)+' น.':'ยังไม่มีข้อมูลสำรองย้อนหลัง';
 $('station-refresh').textContent=date===KKData.thaiDay()?'กลับสู่ค่าล่าสุด / ดึงจาก AirThai':'ดึงข้อมูลวันที่เลือกจาก AirThai';$('station-refresh').disabled=refreshing||date>KKData.thaiDay();
 const holder=$('station-list');holder.replaceChildren();
 for(const s of catalog.stations){const button=document.createElement('button');button.type='button';button.className='station-list-item';const reading=markerReading(s),copy=document.createElement('span'),name=document.createElement('span'),stamp=document.createElement('small');
  name.textContent=s.name;stamp.textContent=reading?readingText(reading)+' · '+ageText(reading):'ไม่มีค่าตรวจวัดที่ใช้ได้';stamp.className='station-reading-time';copy.append(name,stamp);
  const number=document.createElement('strong');number.textContent=reading?format(reading.value,1):'—';button.append(copy,number);button.disabled=!s._marker;
  button.addEventListener('click',()=>{markersOn=true;markerLayer.addTo(map);$('station-markers').checked=true;$('map-stations-panel').hidden=true;$('map-stations-toggle').setAttribute('aria-expanded','false');map.panTo(s.coordinate);s._marker.openPopup();s._marker.getElement()?.focus({preventScroll:true});});holder.append(button);
 }
}
async function paint(showAir){
 const thisJob=++paintJob;if(surfaceLayer){map.removeLayer(surfaceLayer);surfaceLayer=null;}
 if(!idwOn||!showAir||!frame?.available)return;
 const key=date+'|'+frame.hour.end_utc+'|'+JSON.stringify(frame.hour.values);let result=surfaces.get(key);
 if(!result){result=await KKSurface.render(grid,bounds,frame.sampler,projection,()=>thisJob!==paintJob,value=>{const hex=KKData.color(value,'pm25');return hex?[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)):null;});if(!result||thisJob!==paintJob)return;surfaces.set(key,result);if(surfaces.size>5)surfaces.delete(surfaces.keys().next().value);}
 if(thisJob===paintJob)surfaceLayer=L.imageOverlay(result.url,bounds,{pane:'air',opacity:.64,interactive:false}).addTo(map);
}
function render(showAir){
 const key=date+'|'+(frame?.hour?.end_utc||'none')+'|'+(liveResult?.checkedAt||catalog.generated_at_utc)+'|'+markersOn+'|'+idwOn+'|'+requested+'|'+Math.floor(Date.now()/60000);
 if(key!==lastRenderKey){drawMarkers();renderPanel();lastRenderKey=key;}
 paint(showAir).catch(()=>{$('station-idw-status').textContent='สร้างผืนสีสถานีไม่สำเร็จ';});
}
function enabled(){return markersOn||idwOn||!$('map-stations-panel').hidden;}
async function refresh(force=false){
 if(!date||date>KKData.thaiDay())return;
 if(liveBusy){pendingLive=true;return liveBusy;}
 const now=Date.now();if(!force&&liveDate===date&&now-lastAttempt<45000)return;
 const selected=date,mine=job;lastAttempt=now;refreshing=true;renderPanel();
 const needHours=force||liveDate!==date||now-lastHours>=300000,needMetadata=force||now-lastMetadata>=300000;
 liveBusy=(async()=>{
  try{
   const result=await client.read({date:selected,catalog,day:day||{hours:[]},readings,now,minutes:selected===KKData.thaiDay(),hours:needHours,metadata:needMetadata});
   if(mine!==job||date!==selected)return;
   catalog=result.catalog;day=result.day;readings=result.readings;liveResult=result;liveDate=selected;fetchError=false;cache.set(selected,day);
   if(needHours&&result.hourUpdates.every(r=>r.state==='ok'))lastHours=now;
   if(needMetadata&&!result.metadataError)lastMetadata=now;
   recompute();
  }catch{if(mine===job){fetchError=true;lastRenderKey='';}}
  finally{if(mine===job){refreshing=false;onChange();}}
 })().finally(()=>{liveBusy=null;if(pendingLive){pendingLive=false;if(enabled())refresh();}});
 return liveBusy;
}
async function loadDate(next,force=false){
 const mine=++job;if(date&&date!==next){requested=null;liveResult=null;}date=next;loading=true;refreshing=false;day=null;frame=null;lastRenderKey='';paintJob++;if(surfaceLayer){map.removeLayer(surfaceLayer);surfaceLayer=null;}
 renderPanel();
 try{if(catalog.days.some(row=>row.date===next)||cache.has(next)){day=!force&&cache.has(next)?cache.get(next):await readJson('stations/daily/'+next+'.json',true);if(mine!==job)return;cache.set(next,day);if(cache.size>8)cache.delete(cache.keys().next().value);}else day={hours:[]};fetchError=false;}
 catch{if(mine!==job)return;day=cache.get(next)||{hours:[]};fetchError=true;}
 if(mine===job){loading=false;recompute();onChange();if(enabled())refresh();}
}
$('station-markers').addEventListener('change',()=>{markersOn=$('station-markers').checked;lastRenderKey='';onChange();if(markersOn)refresh();});
$('station-idw').addEventListener('change',()=>{idwOn=$('station-idw').checked;lastRenderKey='';onChange({stationActivated:idwOn});if(idwOn)refresh();});
$('station-hour').addEventListener('change',()=>{requested=$('station-hour').value==='auto'?null:$('station-hour').value;recompute();onChange();if(!requested)refresh();});
$('station-refresh').addEventListener('click',()=>{requested=null;recompute();onChange();refresh(true);});
map.on('popupopen popupclose',event=>{if(event.popup?.options?.className==='airthai-station-popup'){popupOpen=event.type==='popupopen';$('map').closest('.map-wrap').classList.toggle('station-popup-open',popupOpen);onChange({popupOnly:true});}});
setInterval(()=>{if(!document.hidden&&enabled()&&date===KKData.thaiDay())refresh();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&enabled()&&date===KKData.thaiDay())refresh();});
return {
 async init(){try{catalog=await readJson('stations/index.json',true)||catalog;}catch{fetchError=true;}
  const old=new Map((catalog.stations||[]).map(s=>[s.id,s]));catalog.stations=Live.STATIONS.map(([id,name])=>({...old.get(id),id,name}));
 },loadDate,render,refresh,
 get popupOpen(){return popupOpen;},get active(){return idwOn;},get summary(){return frame;},get timeLabel(){return hourText(frame?.hour);},
 deactivate(){idwOn=false;$('station-idw').checked=false;lastRenderKey='';},
 sample(airId,latlng){if(!frame?.sampler)return null;if(latlng){const [x,y]=projection.forward([latlng.lng,latlng.lat]);return frame.sampler(x,y).value;}return frame.values.get(airId)??null;},
 query(){return {stations:markersOn?'1':'0',station_idw:idwOn?'1':'0',station_hour:requested||''};}
};
}};
