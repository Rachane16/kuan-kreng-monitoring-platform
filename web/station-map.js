/* Map-only AirThai integration. Uses the platform's public verified snapshots. */
window.KKStationMap={create({map,grid,boundary,bounds,projection,readJson,onChange,insideGeometry,dateText,timeText,format}){
const $=id=>document.getElementById(id),M=KKStationModel;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q=new URLSearchParams(location.search),cache=new Map(),surfaces=new Map();
let catalog={stations:[],days:[]},day=null,date=null,requested=q.get('station_hour'),idwOn=q.get('station_idw')==='1',markersOn=q.get('stations')!=='0',loading=false,job=0,paintJob=0,markerLayer=null,surfaceLayer=null,frame=null,fetchError=false,lastRenderKey='',popupOpen=false;
const inside=coordinate=>boundary.features.some(f=>insideGeometry([coordinate[1],coordinate[0]],f.geometry));
const hourText=hour=>hour?timeText(hour.start_utc)+'–'+new Date(hour.end_utc).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hour12:false})+' น.':'ไม่มีข้อมูลรายชั่วโมงของวันที่เลือก';
function recompute(){const hour=M.selectHour(catalog,day,date,{requested,inside});frame=M.frame(catalog,hour,grid,{inside,project:coordinate=>projection.forward([coordinate[1],coordinate[0]])});lastRenderKey='';}
function popup(s){
 const value=frame?.hour?.values?.[s.id],valid=Number.isFinite(value)&&value>=0,within=s.coordinate&&inside(s.coordinate);
 const online=s.online===true?'Active':s.online===false?'Inactive':'ไม่ทราบ';
 return `<div class="popup-heading">${escape(s.name)}</div><div class="popup-stat"><span>PM₂.₅ จากสถานี · ค่าเฉลี่ยรายชั่วโมง</span><strong>${valid?format(value,2):'—'}<small>µg/m³</small></strong><div class="popup-meta">${escape(hourText(frame?.hour))}${valid?'':' · ไม่มีค่าในชั่วโมงนี้'}</div></div>`+
 `<div class="station-popup-details"><p>เครื่องมือ: ${escape(s.model||'API ไม่ระบุรุ่น')}</p><p>ตำแหน่ง: ${s.coordinate?format(s.coordinate[0],5)+', '+format(s.coordinate[1],5):'ไม่ทราบ'}</p><p>${within?'อยู่ในขอบเขตพรุควนเคร็ง': 'อยู่นอกขอบเขต · ไม่ใช้คำนวณ IDW'}</p><p>สถานะอุปกรณ์ล่าสุด: ${online}${s.catalog_state!=='ok'?' · เมทาดาทาที่รับไว้ก่อนหน้า':''}</p><p>อุปกรณ์ติดต่อครั้งล่าสุด: ${escape(s.device_last_seen_utc?timeText(s.device_last_seen_utc)+' น.':'ไม่มีเวลา')}</p><p>ชั่วโมงล่าสุดที่มี PM₂.₅: ${escape(s.latest_hour_end_utc?timeText(s.latest_hour_end_utc)+' น. (เวลาสิ้นสุด)':'ไม่มีข้อมูล')}</p><p>รับข้อมูลสำเร็จ: ${escape(s.last_success_utc?timeText(s.last_success_utc)+' น.':'ยังไม่สำเร็จ')}${s.fetch_state!=='ok'?' · ใช้ข้อมูลเดิมที่รับไว้':''}</p></div><a class="station-source-link" href="https://airthai.in.th/th/devices/dust_sensors?project_id=65bfa9705d10c350c04f0bd9&device_id=${encodeURIComponent(s.id)}&api_id=65bfaf5584b7f59060a1bfcd" target="_blank" rel="noopener">ที่มา: AirThai · ศูนย์วิจัยมลพิษทางอากาศ ม.อ.</a>`;
}
function drawMarkers(){
 if(markerLayer){map.removeLayer(markerLayer);markerLayer=null;}
 markerLayer=L.layerGroup();
 for(const s of catalog.stations){if(!s.coordinate?.every(Number.isFinite))continue;
  const value=frame?.hour?.values?.[s.id],valid=Number.isFinite(value)&&value>=0,hex=valid?KKData.color(value,'pm25'):'#dce3dc',within=inside(s.coordinate),label=s.name+' · '+(valid?format(value,1)+' µg/m³':'ไม่มีค่าในชั่วโมงนี้');
  const marker=L.marker(s.coordinate,{pane:'stations',keyboard:true,title:label,icon:L.divIcon({className:'airthai-marker',iconSize:[43,36],iconAnchor:[21,18],html:`<span class="station-map-pin${within?'':' outside'}" style="--station-color:${hex}">${valid?format(value,1):'—'}</span>`})}).bindPopup(popup(s),{maxWidth:350,maxHeight:430,className:'airthai-station-popup',autoPanPaddingTopLeft:[20,100],autoPanPaddingBottomRight:[20,20]}).bindTooltip(escape(s.name),{direction:'top',offset:[0,-20]});
  marker.on('add',()=>{const el=marker.getElement();if(el)el.setAttribute('aria-label','สถานี AirThai '+label);});
  markerLayer.addLayer(marker);s._marker=marker;
 }
 if(markersOn)markerLayer.addTo(map);
}
function renderPanel(){
 $('station-markers').checked=markersOn;$('station-idw').checked=idwOn;
 const select=$('station-hour');select.replaceChildren();
 const auto=document.createElement('option');auto.value='auto';auto.textContent='ชั่วโมงล่าสุดที่ใช้ได้';select.append(auto);
 for(const h of M.validHours(day,date)){const option=document.createElement('option');option.value=h.end_utc;option.textContent=hourText(h);select.append(option);}
 select.value=requested||'auto';select.disabled=loading||select.options.length===1;
 $('station-idw-status').textContent=loading?'กำลังโหลดสถานีของวันที่เลือก…':frame?.status==='available'?`IDW พร้อม · ${frame.pointCount} สถานีในขอบเขต · ชั่วโมงเดียวกัน`:frame?.status==='insufficient'?`มี ${frame.pointCount} สถานีที่ใช้ได้ · IDW ต้องมีอย่างน้อย 3 จุดที่ไม่อยู่ในแนวเดียวกัน`:'ไม่มีชั่วโมงที่ใช้ได้ของวันที่เลือก';
 $('station-frame-time').textContent=hourText(frame?.hour);
 $('station-sync-time').textContent=fetchError?'รับข้อมูลไม่สำเร็จ · คงข้อมูลเดิม':catalog.generated_at_utc?'รับจาก API '+timeText(catalog.generated_at_utc)+' น.'+(catalog.state==='ok'?'':' · บางสถานียังรับไม่สำเร็จ'):'ยังไม่ได้รับข้อมูล AirThai';
 const holder=$('station-list');holder.replaceChildren();
 for(const s of catalog.stations){const button=document.createElement('button');button.type='button';button.className='station-list-item';const value=frame?.hour?.values?.[s.id];
  const text=document.createElement('span');text.textContent=s.name;const number=document.createElement('strong');number.textContent=Number.isFinite(value)?format(value,1):'—';button.append(text,number);button.disabled=!s._marker;
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
 const key=date+'|'+(frame?.hour?.end_utc||'none')+'|'+catalog.generated_at_utc+'|'+markersOn;
 if(key!==lastRenderKey){drawMarkers();renderPanel();lastRenderKey=key;}
 paint(showAir).catch(()=>{$('station-idw-status').textContent='สร้างผืนสีสถานีไม่สำเร็จ';});
}
async function loadDate(next,force=false){
 const mine=++job;if(date&&date!==next)requested=null;date=next;loading=true;day=null;frame=null;lastRenderKey='';paintJob++;if(surfaceLayer){map.removeLayer(surfaceLayer);surfaceLayer=null;}
 renderPanel();
 try{if(catalog.days.some(row=>row.date===next)){day=!force&&cache.has(next)?cache.get(next):await readJson('stations/daily/'+next+'.json',true);if(mine!==job)return;cache.set(next,day);if(cache.size>8)cache.delete(cache.keys().next().value);}else day={hours:[]};fetchError=false;}
 catch(error){if(mine!==job)return;day=cache.get(next)||{hours:[]};fetchError=true;}
 if(mine===job){loading=false;recompute();onChange();}
}
async function refresh(){try{const updated=await readJson('stations/index.json',true);if(updated){catalog=updated;await loadDate(date,true);}else{fetchError=true;renderPanel();}}catch(error){fetchError=true;renderPanel();}}
$('station-markers').addEventListener('change',()=>{markersOn=$('station-markers').checked;lastRenderKey='';onChange();});
$('station-idw').addEventListener('change',()=>{idwOn=$('station-idw').checked;onChange({stationActivated:idwOn});});
$('station-hour').addEventListener('change',()=>{requested=$('station-hour').value==='auto'?null:$('station-hour').value;recompute();onChange();});
$('station-refresh').addEventListener('click',refresh);
map.on('popupopen popupclose',event=>{if(event.popup?.options?.className==='airthai-station-popup'){popupOpen=event.type==='popupopen';$('map').closest('.map-wrap').classList.toggle('station-popup-open',popupOpen);onChange({popupOnly:true});}});
setInterval(()=>{if(!document.hidden&&(markersOn||idwOn)&&date===KKData.thaiDay())refresh();},300000);
return {
 async init(){try{catalog=await readJson('stations/index.json',true)||catalog;}catch(error){fetchError=true;}},loadDate,render,
 get popupOpen(){return popupOpen;},get active(){return idwOn;},get summary(){return frame;},get timeLabel(){return hourText(frame?.hour);},
 deactivate(){idwOn=false;$('station-idw').checked=false;},
 sample(airId,latlng){if(!frame?.sampler)return null;if(latlng){const [x,y]=projection.forward([latlng.lng,latlng.lat]);return frame.sampler(x,y).value;}return frame.values.get(airId)??null;},
 query(){return {stations:markersOn?'1':'0',station_idw:idwOn?'1':'0',station_hour:requested||''};}
};
}};
