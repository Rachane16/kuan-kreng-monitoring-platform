/* Kuan Kreng Monitoring Platform — processed public snapshots, no API credentials. */
(() => {
'use strict';
const $=id=>document.getElementById(id),D=KKData,M=PlatformModel;
const SOURCE_NAMES={ALL:'ทุกดาวเทียม',MODIS_NRT:'MODIS Terra / Aqua',VIIRS_SNPP_NRT:'VIIRS S-NPP',VIIRS_NOAA20_NRT:'VIIRS NOAA-20',VIIRS_NOAA21_NRT:'VIIRS NOAA-21'};
const FUELS={GRASS:['หญ้า','#a3ae63'],LEPIRONIA:['กระจูด','#56a894'],M_CAJU_SURFACE_LOWLAND:['เชื้อเพลิงผิวดินในป่าเสม็ด','#4b7955'],M_CAJU_LEAVES_BARK_LOWLAND:['ใบและเปลือกเสม็ดขาว','#9abc8e'],M_CAJU:['เสม็ดขาว','#608a5e'],PADDY:['ข้าว','#d0b05b'],PEAT:['ดินพรุ 0–10 ซม.','#ab8565']};
const VIEWS={overview:['OVERVIEW','ภาพรวมพรุควนเคร็ง','เชื่อมข้อมูลฝุ่นในอากาศ จุดความร้อน และการปล่อยฝุ่นไว้ในพื้นที่เดียว'],air:['AIR CONCENTRATION','ฝุ่นในอากาศ','ค่าประเมินจาก MAIAC และ CAMS พร้อมผืนสีต่อเนื่องและพยากรณ์ล่วงหน้า'],fire:['FIRE & EMISSION','ไฟและการปล่อยฝุ่น','จุดความร้อนจากดาวเทียมและสถานการณ์การปล่อย PM₂.₅ จากเชื้อเพลิง'],compare:['INTEGRATED MAP','แผนที่ข้อมูลร่วม','สำรวจข้อมูลสองระบบผ่านกริดเดียวกัน โดยคงหน่วย เวลา และความละเอียดต้นทาง'],about:['ABOUT THE DATA','เกี่ยวกับข้อมูล','ทำความเข้าใจแหล่งข้อมูล แบบจำลอง และขอบเขตการตีความ']};
const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(value,d=2)=>Number.isFinite(value)?new Intl.NumberFormat('en-US',{maximumFractionDigits:d,minimumFractionDigits:0}).format(value):'—';
const dateText=date=>new Date(date+'T00:00:00Z').toLocaleDateString('th-TH',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
const timeText=time=>time?new Date(time).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const query=new URLSearchParams(location.search),initialView=location.hash.slice(1);
const state={view:VIEWS[initialView]?initialView:'overview',date:query.get('date')||D.thaiDay(),airChoice:['maiac','cams'].includes(query.get('source'))?query.get('source'):'auto',pollutant:['pm1','pm01'].includes(query.get('pollutant'))?query.get('pollutant'):'pm25',airView:query.get('display')==='source'?'source':'idw',period:['daily','hourly'].includes(query.get('period'))?query.get('period'):'auto',validTime:query.get('at'),fireSource:SOURCE_NAMES[query.get('satellite')]?query.get('satellite'):'ALL',peat:query.get('peat')!=='0',followNow:!query.has('at')};
let data,gridBundle,airSelection,airSummary,fireDay,fireSummary,airSeries=[],fireSeries=[];
let map,referenceLayer,camsLayer,fireLayer,hotspotLayer,fuelLayer,surfaceLayer,baseLayer,baseLayers,projection;
let dates=[],gridById,crossByAir,crossByFire,fireCells=new Map(),dayCache=new Map(),surfaceCache=new Map();
let dayJob=0,surfaceJob=0,loadFuelPromise=null,toastTimer=null,rendering=false;

async function readJson(path,optional=false){
  const response=await fetch('./data/'+path,{cache:'no-store'});
  if(!response.ok){if(optional&&response.status===404)return null;throw Error('โหลดข้อมูล '+path+' ไม่สำเร็จ ('+response.status+')');}
  if(path.endsWith('.gz')){
    if(!window.DecompressionStream)throw Error('โปรดใช้เบราว์เซอร์รุ่นใหม่เพื่อเปิดชั้นเชื้อเพลิง');
    return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  }
  return response.json();
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},4200);}
function color(pm25){return D.color(D.concentration(pm25,state.pollutant),state.pollutant)||'#c6d1c6';}
function showLayer(layer,visible){if(!layer)return;if(visible&&!map.hasLayer(layer))layer.addTo(map);else if(!visible&&map.hasLayer(layer))map.removeLayer(layer);}
function withinRing(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function withinGeometry(point,geometry){const polygons=geometry.type==='MultiPolygon'?geometry.coordinates:[geometry.coordinates];return polygons.some(rings=>withinRing(point,rings[0])&&!rings.slice(1).some(r=>withinRing(point,r)));}
function rawValueAt(airId,latlng){
  if(!airSummary)return null;
  if(airSelection.source==='maiac'){
    if(airSummary.sampler&&latlng){const [x,y]=projection.forward([latlng.lng,latlng.lat]);return airSummary.sampler(x,y)?.value??null;}
    return airSummary.values.get(airId)??null;
  }
  let point;
  if(latlng)point=[latlng.lng,latlng.lat];else{const p=gridById.get(airId)?.properties;if(!p)return null;point=projection.inverse([p.sample_x,p.sample_y]);}
  const feature=data.camsGrid.features.find(f=>withinGeometry(point,f.geometry));
  return feature?airSummary.values.get(feature.properties.grid_id)??null:null;
}
function popup(airId,latlng,providedFire=null,cluster=false){
  const cross=crossByAir.get(airId),p=providedFire||fireCells.get(cross?.fire_id);
  const raw=rawValueAt(airId,latlng),value=D.concentration(raw,state.pollutant);
  const fireValue=p?(state.peat?p.emission_kg:p.emission_without_peat_kg):fireSummary?.available?0:null;
  const source=airSelection.source.toUpperCase(),airTime=airSelection.period==='hourly'?timeText(airSelection.selectedTime)+' น.':dateText(state.date)+(source==='MAIAC'?' · วันผลิตภัณฑ์ UTC':' · วันไทย');
  const rows=(p?.fuels||[]).filter(f=>f.area_ha>0&&(state.peat||!f.peat_scenario)).map(f=>`<tr><td>${safe(FUELS[f.code]?.[0]||f.code)}</td><td>${fmt(f.emission_kg,2)} kg</td></tr>`).join('');
  return `<div class="popup-heading">${cluster?'กลุ่มกริดไฟและตำแหน่งที่เลือก':'ข้อมูล ณ ตำแหน่งที่เลือก'}</div><div class="popup-grid">${safe(airId||'')}${p?.grid_id?' / '+safe(p.grid_id):''}${cluster?' / '+safe(p.cluster_id):''}</div>`+
    `<div class="popup-stat"><span>${D.labels[state.pollutant]} ประเมิน · ${source}${airSummary.mode==='idw'?' / IDW':''}</span><strong>${fmt(value,2)}<small>µg/m³</small></strong><div class="popup-meta">${safe(airTime)}</div></div>`+
    `<div class="popup-stat"><span>PM₂.₅ ที่คาดว่าปล่อย · ${cluster?'กลุ่มกริด':'กริด'}นี้</span><strong>${fmt(fireValue,2)}<small>kg</small></strong><div class="popup-meta">วันไทย ${dateText(state.date)} · ${p?.observation_count??(fireSummary?.available?0:'—')} รายการตรวจพบ${fireSummary?.partial?' · ข้อมูลบางส่วน':''}</div></div>`+
    (rows?`<table class="popup-table"><tbody>${rows}</tbody></table>`:'')+
    `<div class="popup-warning">การปล่อยเป็นสถานการณ์สมมติเผาเต็มกริด${state.peat?' รวมดินพรุ 0–10 ซม.':''} ไม่ใช่ค่าฝุ่นในอากาศที่เกิดจากกริดนี้โดยตรง${source==='MAIAC'?' · วัน UTC และวันไทยต่างช่วงเวลา':''}</div>`;
}
function openGrid(airId,event,fire=null,cluster=false){L.popup({maxWidth:360,minWidth:250,maxHeight:420}).setLatLng(event.latlng).setContent(popup(airId,event.latlng,fire,cluster)).openOn(map);}
function configureMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:true,scrollWheelZoom:true});
  L.control.zoom({position:'bottomright'}).addTo(map);
  for(const [name,z]of [['air',400],['fuels',410],['grid',430],['fire',480],['hotspots',550],['boundary',590]]){map.createPane(name);map.getPane(name).style.zIndex=z;}
  map.getPane('boundary').style.pointerEvents='none';map.getPane('fuels').style.pointerEvents='none';
  baseLayers={osm:L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,opacity:.86,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}),imagery:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics, GIS User Community'}),topo:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'Tiles &copy; Esri — Esri, USGS, NOAA, GIS User Community'})};
  baseLayer=baseLayers.osm.addTo(map);
  referenceLayer=L.geoJSON(data.airGrid,{pane:'grid',renderer:L.svg({pane:'grid'}),style:{weight:0,fillOpacity:0},onEachFeature(f,layer){
    layer.on('click',e=>openGrid(f.properties.grid_id,e));
    layer.on('add',()=>{const element=layer.getElement();if(!element)return;element.setAttribute('role','button');element.setAttribute('tabindex','0');element.setAttribute('aria-label','กริด '+f.properties.grid_id);
      element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();const [lng,lat]=projection.inverse([f.properties.sample_x,f.properties.sample_y]);openGrid(f.properties.grid_id,{latlng:L.latLng(lat,lng)});}});
    });
  }}).addTo(map);
  camsLayer=L.geoJSON(data.camsGrid,{pane:'air',interactive:false,style:{weight:.5,color:'#688a77',fillOpacity:.62}});
  const line={fill:false,dashArray:'8 6',pane:'boundary',interactive:false,lineCap:'round',lineJoin:'round'};
  L.geoJSON(data.boundary,{pane:'boundary',interactive:false,style:{...line,color:'#fff',weight:4.5,opacity:.9}}).addTo(map);
  L.geoJSON(data.boundary,{pane:'boundary',interactive:false,style:{...line,color:'#315d45',weight:2,opacity:1}}).addTo(map);
  map.fitBounds(referenceLayer.getBounds(),{padding:[25,25]});
}
async function drawSurface(){
  const job=++surfaceJob;if(surfaceLayer){map.removeLayer(surfaceLayer);surfaceLayer=null;}
  if(!$('show-air').checked||airSummary.mode!=='idw')return;
  const key=state.date+':'+state.pollutant,chosen=state.pollutant;
  let rendered=surfaceCache.get(key);
  if(!rendered){
    try{rendered=await KKSurface.render(data.airGrid,referenceLayer.getBounds(),airSummary.sampler,projection,()=>job!==surfaceJob,pm25=>{const hex=D.color(D.concentration(pm25,chosen),chosen);return hex?[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)):null;});}
    catch(error){if(job===surfaceJob)toast('สร้างผืนสี IDW ไม่สำเร็จ กรุณาลองเลือกวันที่อีกครั้ง');return;}
    if(!rendered||job!==surfaceJob)return;surfaceCache.set(key,rendered);if(surfaceCache.size>4)surfaceCache.delete(surfaceCache.keys().next().value);
  }
  if(job!==surfaceJob)return;
  surfaceLayer=L.imageOverlay(rendered.url,referenceLayer.getBounds(),{pane:'air',opacity:.64,interactive:false,className:'idw-surface'}).addTo(map);
}
function drawMap(){
  if(!map)return;map.closePopup();
  const airOn=$('show-air').checked,gridOn=$('show-grid').checked,maiac=airSelection.source==='maiac';
  referenceLayer.eachLayer(layer=>{
    const raw=airSummary.values.get(layer.feature.properties.grid_id),valid=D.concentration(raw,state.pollutant)!==null;
    const fill=airOn&&maiac&&airSummary.mode==='source';
    layer.setStyle({color:'#6e8b70',weight:gridOn?.65:fill?.45:0,opacity:gridOn?.55:.35,fillColor:color(raw),fillOpacity:fill?(valid?.73:.16):0});
  });
  camsLayer.eachLayer(layer=>{const raw=airSummary.values.get(layer.feature.properties.grid_id);layer.setStyle({fillColor:color(raw),fillOpacity:D.concentration(raw,state.pollutant)!==null?.62:.15});});
  showLayer(camsLayer,airOn&&!maiac);drawSurface();
  if(fireLayer)map.removeLayer(fireLayer);if(hotspotLayer)map.removeLayer(hotspotLayer);fireLayer=null;hotspotLayer=null;
  fireCells=new Map((fireSummary?.cells?.features||[]).map(f=>[f.properties.grid_id,f.properties]));
  if(fireSummary?.available){
    const clusters=$('fire-view').value==='clusters',collection=clusters?fireSummary.clusters:fireSummary.cells;
    fireLayer=L.geoJSON(collection,{pane:'fire',style:{color:clusters?'#a36530':'#c97c3e',weight:clusters?2.1:1.3,fillColor:'#e6a562',fillOpacity:.34},onEachFeature(f,layer){layer.on('click',event=>{
      let airId=crossByFire.get(f.properties.grid_id)?.air_id;
      if(!airId){const hit=data.airGrid.features.find(g=>withinGeometry([event.latlng.lng,event.latlng.lat],g.geometry));airId=hit?.properties.grid_id;}
      openGrid(airId,event,f.properties,clusters);
    });}});
    hotspotLayer=L.geoJSON(fireSummary.hotspots,{pane:'hotspots',pointToLayer:(f,ll)=>L.circleMarker(ll,{pane:'hotspots',radius:4,color:'#b24d2e',weight:1,fillColor:'#ee6c3d',fillOpacity:.95}),onEachFeature(f,layer){layer.on('click',event=>{
      const airId=crossByFire.get(f.properties.grid_id)?.air_id;
      const content=`<div class="popup-heading">จุดความร้อน · ${safe(SOURCE_NAMES[f.properties.source])}</div><div class="popup-meta">${safe(timeText(f.properties.acquired_utc))} น. · จุดศูนย์กลางดาวเทียม</div>`+popup(airId,event.latlng);
      L.popup({maxWidth:360,maxHeight:440}).setLatLng(event.latlng).setContent(content).openOn(map);
    });}});
  }
  showLayer(fireLayer,$('show-fire').checked);showLayer(hotspotLayer,$('show-hotspots').checked);
  showLayer(fuelLayer,$('show-fuels').checked);
  $('air-legend').hidden=!airOn;$('fire-legend').hidden=!$('show-fire').checked&&!$('show-hotspots').checked;
  const showEmpty=(!airOn||!airSummary.available)&&(!$('show-fire').checked&&!$('show-hotspots').checked||!fireSummary?.available||!fireSummary.gridCount);
  $('map-empty').hidden=!showEmpty;
  $('map-empty').textContent=dayJobLoading?'กำลังโหลดข้อมูลไฟของวันที่เลือก…':!airSummary.available&&!fireSummary?.available?'ไม่มีข้อมูลที่ใช้ได้สำหรับวันที่เลือก':fireSummary?.available&&!fireSummary.gridCount?'ไม่พบจุดความร้อนในข้อมูลที่ได้รับ'+(fireSummary.partial?' · บางแหล่งข้อมูลยังไม่ครบ':''):'เปิดชั้นข้อมูลเพื่อดูแผนที่';
  $('map-source-badge').textContent=[airOn?airSelection.source.toUpperCase()+(airSummary.mode==='idw'?' / IDW':''):'',$('show-fire').checked?'FIRMS / EMISSION':''].filter(Boolean).join(' · ');
  $('map-date-label').textContent=airOn&&airSelection.period==='hourly'&&airSelection.selectedTime?timeText(airSelection.selectedTime)+' น.':dateText(state.date);
}
function renderLegend(){
  const limits=D.breaks[state.pollutant],label=D.labels[state.pollutant],health=['ดีมาก','ดี','ปานกลาง','เริ่มมีผลต่อสุขภาพ','มีผลต่อสุขภาพ'];
  $('legend-title').textContent=`ความเข้มข้น ${label} · µg/m³`;
  $('legend-bands').innerHTML=D.palette.map((hex,i)=>`<span><i style="background:${hex}"></i>${state.pollutant==='pm25'?health[i]+' ':''}${i===0?'0–'+limits[0]:i===4?'>'+limits[3]:'>'+limits[i-1]+'–'+limits[i]}</span>`).join('');
  $('legend-note').textContent=state.pollutant==='pm25'?'สีเทียบช่วงความเข้มข้นอ้างอิงกรมควบคุมมลพิษ ไม่ใช่การรายงาน AQI จากสถานี':
    'รหัสสีของ PM₁ และ PM₀.₁ เป็นรหัสสีเบื้องต้น ยังไม่สามารถใช้ในการเชื่อมโยงกับผลกระทบต่อสุขภาพได้ในขณะนี้ ขอบเขตของรหัสสีคำนวณจากสัดส่วนของ PM₁ (80%) และ PM₀.₁ (15%) ของ PM₂.₅ ที่ได้จากค่าเฉลี่ยจากการวิจัยระยะยาวในหลายภูมิภาคและหลายประเทศในเอเชียตะวันออกเฉียงใต้ ส่วนการกำหนดสีของ PM₁ และ PM₀.₁ กับผลกระทบต่อสุขภาพอยู่ระหว่างการวิจัย';
}
function renderControls(){
  $('date-input').value=state.date;$('prev-day').disabled=state.date===dates[0];$('next-day').disabled=state.date===dates.at(-1);
  $('selected-day').textContent=dateText(state.date);
  $('time-context').textContent=airSelection.source==='maiac'?'MAIAC: วันผลิตภัณฑ์ UTC · ข้อมูลไฟ: วันไทย':'CAMS และข้อมูลไฟ: วันไทย (UTC+7)';
  $('air-source').value=airSelection.source;
  $('air-view').innerHTML=airSelection.source==='cams'?'<option value="cams">กริด CAMS ต้นทาง</option>':'<option value="idw">ผืนสีต่อเนื่อง (IDW)</option><option value="source">กริดข้อมูลต้นทาง</option>';
  if(airSelection.source!=='cams')$('air-view').value=state.airView;
  $('air-view').disabled=airSelection.source==='cams';
  $('forecast-controls').hidden=airSelection.source!=='cams'||state.view==='fire';$('cams-period').value=airSelection.period;$('forecast-label').hidden=airSelection.period!=='hourly';
  const select=$('forecast-time');select.replaceChildren();
  for(const hour of airSelection.availableHours){const option=document.createElement('option');option.value=hour.valid_time;option.textContent=timeText(hour.valid_time);select.appendChild(option);}
  if(!airSelection.availableHours.length){const option=document.createElement('option');option.textContent='ไม่มีพยากรณ์ในวันที่เลือก';select.appendChild(option);}else select.value=airSelection.selectedTime;
  select.disabled=!airSelection.availableHours.length;
  $('nearest-now').disabled=!data.air.forecast.hours.some(h=>h.status==='Available');
  $('forecast-reference').textContent=airSelection.day.forecast_base_time?'รอบพยากรณ์ '+timeText(airSelection.day.forecast_base_time)+' น. · ล่วงหน้า '+(airSelection.day.lead_time_hours||[]).join('–')+' ชม. · อัปเดตชุด '+timeText(airSelection.period==='hourly'?data.air.forecast.generated_at_utc:data.air.cams.generated_at_utc)+' น.':'ยังไม่มีช่วงข้อมูล CAMS ที่ใช้ได้ของวันที่เลือก';
  $('fire-source').value=state.fireSource;$('include-peat').checked=state.peat;
  document.querySelector(`input[name="pollutant"][value="${state.pollutant}"]`).checked=true;
}
function renderMetrics(){
  $('air-metric-title').textContent=`ค่าประมาณ ${D.labels[state.pollutant]} ${airSummary.partial?'ของช่องที่มีข้อมูล':'เฉลี่ยพื้นที่'}`;
  $('metric-pm').textContent=fmt(airSummary.mean,2);
  $('metric-pm-note').textContent=airSelection.source.toUpperCase()+' · '+(airSelection.period==='hourly'?(timeText(airSelection.selectedTime)+' น.'):
    airSummary.mode==='idw'?'IDW ทั้งพื้นที่':airSummary.mode==='source'?'เฉพาะกริดที่มี AOD':'AOD เฉลี่ย 24 ชม.')+(state.pollutant!=='pm25'?' · CALLAB':'');
  $('metric-hotspots').textContent=fmt(fireSummary.observations,0);$('metric-emission').textContent=fmt(fireSummary.emissionKg,2);$('metric-grids').textContent=fmt(fireSummary.gridCount,0);
  $('metric-hotspots-note').textContent=dayJobLoading?'กำลังโหลดข้อมูลวันที่เลือก':!fireSummary.available?'ยังไม่มีข้อมูลของวันที่เลือก':(fireSummary.partial?'บางแหล่งข้อมูลยังไม่ครบ':'ข้อมูลตามดาวเทียมที่เลือก')+' · อาจซ้ำรอบผ่าน';
  $('metric-hotspots-note').classList.toggle('warning',fireSummary.partial);
  $('metric-emission-note').textContent='สมมติเผาเต็มกริด · '+(state.peat?'รวมดินพรุ 0–10 ซม.':'ไม่รวมดินพรุ');
  $('metric-grids-note').textContent=fireSummary.available?`${fmt(fireSummary.areaHa,2)} ha · ${fmt(fireSummary.clusterCount,0)} กลุ่มกริด`:'กริด 1 กม. ภายในขอบเขตศึกษา';
  $('export-csv').disabled=!airSummary.available&&!fireSummary.available;
}
function renderStatus(){
  const manifest=data.manifest,air=manifest.sources.air,fire=manifest.sources.fire,selectedFire=fireDay||data.fireStatus,fireState=fireDay?.data_state||data.fireStatus.state;
  $('sync-time').textContent='รวมข้อมูลล่าสุด '+timeText(manifest.generated_at_utc)+' น.';
  $('area-size').textContent=fmt((manifest.grid_validation.area_ha||93105.27)/100,2);
  const rows=[['MAIAC / CAMS',air.state,air.upstream_updated_at_utc,'ข้อมูลต้นทาง'],['FIRMS / EMISSION',fire.state==='ok'?(fireState==='ok'?'ok':'partial'):fire.state,fire.upstream_updated_at_utc,'ข้อมูลต้นทาง']];
  $('source-status').innerHTML=rows.map(([name,status,time,label])=>`<div class="source-status-row"><div><b>${name}</b><span class="status-pill ${status==='ok'?'':status==='partial'?'partial':'stale'}">${status==='ok'?'รับข้อมูลแล้ว':status==='partial'?'ข้อมูลบางส่วน':'ใช้ชุดเดิม'}</span></div><small>${label} ${safe(timeText(time))} น.</small></div>`).join('')+
    Object.entries(selectedFire.source_status||selectedFire.sources||{}).map(([source,q])=>`<div class="source-status-row"><div><b>${safe(SOURCE_NAMES[source]||source)}</b><span class="status-pill ${q.state==='ok'?'':'partial'}">${q.state==='ok'?'โหลดแล้ว':q.state==='partial'?'ข้อมูลบางส่วน':q.state==='error'?'ขัดข้อง':'ยังไม่มีข้อมูล'}</span></div>${q.max_date?'<small>ผลิตภัณฑ์ล่าสุด '+safe(q.max_date)+'</small>':''}</div>`).join('');
  $('source-status-tag').textContent=manifest.state==='ok'?'SYNCED':'PARTIAL SYNC';
  $('grid-join-status').textContent=`ตรวจจับคู่ตำแหน่งกริด ${fmt(manifest.grid_validation.matching_cells,0)} / ${fmt(manifest.grid_validation.air_count,0)} ช่องแล้ว · เวลาอัปเดตแยกตามแหล่งข้อมูล`;
  const stale=manifest.state!=='ok',partial=fireState!=='ok';
  $('load-banner').hidden=!stale&&!partial;
  $('load-banner').classList.toggle('error',stale);
  $('load-banner').textContent=stale?'การรับข้อมูลบางชุดขัดข้อง กำลังแสดงข้อมูลล่าสุดที่ตรวจสอบแล้ว โปรดดูเวลาอัปเดตแยกแหล่ง':
    'FIRMS บางแหล่งยังไม่มีข้อมูลใหม่ ค่าศูนย์หมายถึงไม่พบในข้อมูลที่ได้รับ และไม่ได้ยืนยันว่าไม่มีไฟในพื้นที่';
}
function chartBars(id,rows,unit){
  const holder=$(id);holder.replaceChildren();const max=Math.max(1,...rows.map(r=>r.value??0));
  for(const row of rows){const button=document.createElement('button');button.type='button';button.className='chart-bar'+(row.value===null?' missing':'')+(row.state==='partial'?' partial':'')+(row.date===state.date?' selected':'');button.dataset.date=row.date;
    button.style.setProperty('--height',`${row.value===null?3:Math.max(4,100*row.value/max)}px`);
    button.title=`${dateText(row.date)} · ${fmt(row.value,2)} ${unit}${row.source?' · '+row.source.toUpperCase():''}${row.state==='partial'?' · ข้อมูลบางส่วน':''}${row.state==='missing'?' · ไม่มีข้อมูล':''}`;
    button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(row.date===state.date));button.addEventListener('click',()=>chooseDate(row.date));holder.appendChild(button);}
}
function renderCharts(rebuild=false){
  if(rebuild){
    airSeries=M.airDailySeries(data.air,gridBundle,data.air.maiac.start_date,data.air.maiac.end_date,state.pollutant,state.airChoice);
    const last=[state.date,D.thaiDay(),data.fireIndex.dates.at(-1)].sort()[0],first=[shift(last,-Number($('chart-days').value)+1),data.fireIndex.dates[0]].sort().at(-1);
    fireSeries=first<=last?M.emissionSeries(data.fireIndex,first,last,state.fireSource,state.peat):[];
    chartBars('air-chart',airSeries,'µg/m³');chartBars('fire-chart',fireSeries,'kg');
    $('air-chart-start').textContent=dateText(data.air.maiac.start_date);$('air-chart-end').textContent=dateText(data.air.maiac.end_date);
    $('fire-chart-start').textContent=fireSeries.length?dateText(fireSeries[0].date):'—';$('fire-chart-end').textContent=fireSeries.length?dateText(fireSeries.at(-1).date):'—';
  }
  for(const bar of document.querySelectorAll('.chart-bar')){const selected=bar.dataset.date===state.date;bar.classList.toggle('selected',selected);bar.setAttribute('aria-pressed',String(selected));}
  const a=airSeries.find(r=>r.date===state.date),f=fireSeries.find(r=>r.date===state.date);
  $('air-chart-title').textContent=`${D.labels[state.pollutant]} เฉลี่ยทั้งพื้นที่ย้อนหลัง`;
  $('air-chart-note').textContent=state.airChoice==='maiac'?'MAIAC ที่มีจุดเพียงพอสำหรับ IDW ทั้งพื้นที่':state.airChoice==='cams'?'CAMS จาก AOD เฉลี่ยครบ 24 ชั่วโมงตามเวลาไทย':'ใช้ MAIAC ที่ทำ IDW ได้ก่อน แล้วใช้ CAMS รายวันทดแทน';
  $('air-chart-readout').textContent=a?`${dateText(a.date)} · ${fmt(a.value,2)} µg/m³ · ${a.source.toUpperCase()}${a.mode==='idw'?' / IDW':''}`:`ย้อนหลังถึง ${dateText(data.air.maiac.end_date)} · เลือกแท่งเพื่อดูค่าเฉลี่ยรายวัน`;
  $('fire-chart-readout').textContent=f?`${dateText(f.date)} · ${fmt(f.value,2)} kg${f.state==='partial'?' · ข้อมูลบางส่วน':f.state==='missing'?' · ไม่มีข้อมูล':''}`:'เลือกแท่งเพื่อดูค่ารายวัน';
}
function renderFuels(){
  const fuels=fireSummary.fuels||[],total=fireSummary.emissionKg;
  $('fuel-table').innerHTML=data.parameters.fuels.map(parameter=>{const fuel=fuels.find(f=>f.code===parameter.code),excluded=parameter.code==='PEAT'&&!state.peat,label=FUELS[parameter.code]||[parameter.code,'#9cad8c'];
    const width=total>0&&fuel?100*fuel.emission_kg/total:0;
    return `<tr class="${excluded?'excluded':''}"><td><i class="fuel-bullet" style="background:${label[1]}"></i>${safe(label[0])}</td><td>${fmt(fuel?.area_ha,2)}</td><td>${excluded?'ไม่รวม':fmt(fuel?.emission_kg,2)}</td><td><span class="fuel-track"><i style="width:${width}%;background:${label[1]}"></i></span></td></tr>`;
  }).join('');
}
function writeUrl(){const url=new URL(location.href);url.hash=state.view;for(const [name,value]of Object.entries({date:state.date,source:state.airChoice,pollutant:state.pollutant,display:state.airView,period:state.period,satellite:state.fireSource,peat:state.peat?'1':'0'}))url.searchParams.set(name,value);if(airSelection.selectedTime)url.searchParams.set('at',airSelection.selectedTime);else url.searchParams.delete('at');window.history.replaceState(null,'',url);}
function refresh(charts=false){
  if(!data)return;
  airSelection=M.selectAir(data.air,{date:state.date,source:state.airChoice,period:state.period,validTime:state.validTime});
  airSummary=M.airSummary(airSelection,gridBundle,state.pollutant,state.airView);
  fireSummary=M.fireSummary(fireDay,state.fireSource,state.peat);
  renderControls();renderMetrics();renderLegend();renderStatus();renderCharts(charts);renderFuels();drawMap();writeUrl();
}
let dayJobLoading=false;
async function loadDay(){
  const job=++dayJob,date=state.date;fireDay=null;dayJobLoading=true;refresh(true);
  if(!data.fireIndex.dates.includes(date)){dayJobLoading=false;refresh();return;}
  try{let day=dayCache.get(date);if(!day){day=await readJson('fire/daily/'+date+'.json');dayCache.set(date,day);}if(job!==dayJob)return;fireDay=day;}
  catch(error){if(job!==dayJob)return;toast('โหลดข้อมูลไฟวันที่เลือกไม่สำเร็จ กรุณาลองใหม่');}
  if(job===dayJob){dayJobLoading=false;refresh();}
}
async function chooseDate(date){if(!dates.includes(date))return;state.date=date;state.airChoice='auto';state.period='auto';state.validTime=null;state.followNow=date===D.thaiDay();await loadDay();}
function setView(view,initial=false){
  if(!VIEWS[view])return;state.view=view;
  const [eyebrow,title,description]=VIEWS[view];$('view-eyebrow').textContent=eyebrow;$('page-title').textContent=title;$('page-description').textContent=description;
  document.title=title+' | Kuan Kreng Monitoring Platform';
  for(const button of document.querySelectorAll('[data-view]')){const active=button.dataset.view===view;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  $('workspace').hidden=view==='about';$('about-page').hidden=view!=='about';$('date-toolbar').hidden=view==='about';$('comparison-note').hidden=view!=='compare';
  $('air-controls').hidden=view==='fire';
  if(!initial){$('show-air').checked=view!=='fire';$('show-fire').checked=view!=='air';$('show-hotspots').checked=view!=='air';}
  $('map-title').textContent={overview:'แผนที่สถานการณ์',air:'ค่าประมาณฝุ่นในอากาศ',fire:'จุดความร้อนและการปล่อยฝุ่น',compare:'ข้อมูลร่วมบนกริดเดียวกัน',about:'แผนที่สถานการณ์'}[view];
  if(data){refresh();requestAnimationFrame(()=>map.invalidateSize());}
}
async function fuelImage(geo){
  // Paint the display-only fuel shapes once; Leaflet then moves a lightweight image.
  // The numerical emission model and its full-precision geometries stay upstream.
  const bounds=referenceLayer.getBounds(),crs=L.CRS.EPSG3857,sw=crs.project(bounds.getSouthWest()),ne=crs.project(bounds.getNorthEast());
  const width=640,height=Math.ceil(width*(ne.y-sw.y)/(ne.x-sw.x));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d'),mask=document.createElement('canvas');mask.width=width;mask.height=height;const mc=mask.getContext('2d');
  const point=([lng,lat])=>{const p=crs.project(L.latLng(lat,lng));return [(p.x-sw.x)/(ne.x-sw.x)*width,(ne.y-p.y)/(ne.y-sw.y)*height];};
  function polygon(context,rings){context.beginPath();for(const ring of rings){ring.forEach((coordinate,i)=>{const [x,y]=point(coordinate);i?context.lineTo(x,y):context.moveTo(x,y);});context.closePath();}context.fill('evenodd');}
  let count=0;
  for(const feature of geo.features){ctx.fillStyle=FUELS[feature.properties.landuse_code]?.[1]||'#97a979';
    const polygons=feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[feature.geometry.coordinates];
    for(const rings of polygons){polygon(ctx,rings);if(++count%32===0)await new Promise(requestAnimationFrame);}
  }
  mc.fillStyle='#fff';for(const feature of data.boundary.features){const polygons=feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[feature.geometry.coordinates];for(const rings of polygons)polygon(mc,rings);}
  ctx.globalCompositeOperation='destination-in';ctx.drawImage(mask,0,0);
  return L.imageOverlay(canvas.toDataURL('image/png'),bounds,{pane:'fuels',interactive:false,opacity:.35});
}
async function loadFuel(){
  if(fuelLayer){showLayer(fuelLayer,$('show-fuels').checked);return;}
  if(!loadFuelPromise)loadFuelPromise=readJson('fire/landuse_layers.geojson.gz').then(fuelImage).then(layer=>{fuelLayer=layer;});
  try{$('layer-note').textContent='กำลังเตรียมภาพชั้นเชื้อเพลิง…';await loadFuelPromise;showLayer(fuelLayer,$('show-fuels').checked);$('layer-note').textContent='ชั้นเชื้อเพลิงเพื่อแสดงผล ตัดตามขอบเขตจริง ไม่ใช้รูปภาพคำนวณการปล่อย';}
  catch(error){loadFuelPromise=null;$('show-fuels').checked=false;$('layer-note').textContent='ชั้นเชื้อเพลิงโหลดไม่สำเร็จ';toast(error.message);}
}
function exportCsv(){
  const rows=[['selected_date','air_grid_id','fire_grid_id','air_source','air_period','air_valid_time_utc','maiac_product_day_utc','fire_day_thailand','pollutant','air_concentration_ug_m3','air_spatial_support','air_resolution_degrees','emission_pm25_kg','observations','fire_coverage_state','include_peat_0_10cm']];
  for(const cross of data.crosswalk.cells){const raw=rawValueAt(cross.air_id),value=D.concentration(raw,state.pollutant),fire=fireCells.get(cross.fire_id),emission=fire?(state.peat?fire.emission_kg:fire.emission_without_peat_kg):fireSummary.available?0:null;
    rows.push([state.date,cross.air_id,cross.fire_id,airSelection.source,airSelection.period,airSelection.selectedTime||'',airSelection.source==='maiac'?state.date:'',state.date,state.pollutant,value===null?'':value,airSelection.source==='cams'?'native_cams_at_grid_sample':airSummary.mode==='idw'?'idw_at_grid_sample':'maiac_source_grid',airSelection.source==='cams'?0.4:'',emission===null?'':emission,fire?.observation_count??(fireSummary.available?0:''),fireSummary.state,state.peat?1:0]);}
  const csv='\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`kuan-kreng-${state.date}-${state.pollutant}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('ดาวน์โหลดข้อมูล 1,052 กริด พร้อมหน่วยและช่วงเวลาแล้ว');
}
async function init(){
  try{
    const paths=['manifest.json','air/history.json','air/cams_history.json','air/cams_forecast.json','air/grid.geojson','air/cams_grid.geojson','air/boundary.geojson','fire/index.json','fire/status.json','fire/project.json','fire/parameters.json','grid_crosswalk.json'];
    const r=await Promise.all(paths.map(p=>readJson(p)));
    data={manifest:r[0],air:{maiac:r[1],cams:r[2],forecast:r[3]},airGrid:r[4],camsGrid:r[5],boundary:r[6],fireIndex:r[7],fireStatus:r[8],project:r[9],parameters:r[10],crosswalk:r[11]};
    gridBundle={maiac:data.airGrid,cams:data.camsGrid};gridById=new Map(data.airGrid.features.map(f=>[f.properties.grid_id,f]));crossByAir=new Map(data.crosswalk.cells.map(c=>[c.air_id,c]));crossByFire=new Map(data.crosswalk.cells.map(c=>[c.fire_id,c]));
    if(data.manifest.grid_validation.state!=='matched'||crossByAir.size!==data.airGrid.features.length)throw Error('กริดสองแหล่งไม่ตรงกัน กรุณาตรวจชุดข้อมูลก่อนแสดงร่วมกัน');
    const first=[data.air.maiac.start_date,data.fireIndex.dates[0]].sort()[0],last=[D.thaiDay(),data.fireIndex.dates.at(-1),...data.air.forecast.hours.map(h=>D.thaiDay(h.valid_time))].sort().at(-1);
    dates=M.dates(first,last);if(!dates.includes(state.date))state.date=D.thaiDay();$('date-input').min=dates[0];$('date-input').max=dates.at(-1);
    projection=proj4('EPSG:4326','+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs');configureMap();
    setView(state.view,true);if(state.view==='air'){$('show-fire').checked=false;$('show-hotspots').checked=false;}if(state.view==='fire')$('show-air').checked=false;
    await loadDay();
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
    window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(VIEWS[view]&&view!==state.view)setView(view);});
    $('date-input').addEventListener('change',()=>chooseDate($('date-input').value));$('prev-day').addEventListener('click',()=>chooseDate(shift(state.date,-1)));$('next-day').addEventListener('click',()=>chooseDate(shift(state.date,1)));$('today-button').addEventListener('click',()=>chooseDate(D.thaiDay()));
    $('air-source').addEventListener('change',()=>{state.airChoice=$('air-source').value;refresh(true);});$('air-view').addEventListener('change',()=>{state.airView=$('air-view').value;refresh();});
    document.querySelectorAll('input[name="pollutant"]').forEach(input=>input.addEventListener('change',()=>{state.pollutant=input.value;refresh(true);}));
    $('cams-period').addEventListener('change',()=>{state.period=$('cams-period').value;state.validTime=null;state.followNow=false;refresh();});$('forecast-time').addEventListener('change',()=>{state.validTime=$('forecast-time').value;state.followNow=false;refresh();});
    $('nearest-now').addEventListener('click',async()=>{const hour=D.nearest(data.air.forecast.hours);if(!hour)return;state.date=D.thaiDay(hour.valid_time);state.airChoice='cams';state.period='hourly';state.validTime=hour.valid_time;state.followNow=true;await loadDay();});
    $('fire-source').addEventListener('change',()=>{state.fireSource=$('fire-source').value;refresh(true);});$('include-peat').addEventListener('change',()=>{state.peat=$('include-peat').checked;refresh(true);});$('fire-view').addEventListener('change',drawMap);
    for(const id of ['show-air','show-fire','show-hotspots','show-grid'])$(id).addEventListener('change',drawMap);
    $('show-fuels').addEventListener('change',()=>{$('fuel-legend').hidden=!$('show-fuels').checked;$('show-fuels').checked?loadFuel():showLayer(fuelLayer,false);});
    $('basemap').addEventListener('change',()=>{map.removeLayer(baseLayer);baseLayer=baseLayers[$('basemap').value].addTo(map);});$('fit-map').addEventListener('click',()=>map.fitBounds(referenceLayer.getBounds(),{padding:[25,25]}));
    $('expand-map').addEventListener('click',()=>{const expanded=$('map-card').classList.toggle('expanded');$('expand-map').setAttribute('aria-pressed',String(expanded));$('expand-map').setAttribute('aria-label',expanded?'ย่อแผนที่':'ขยายแผนที่');document.body.style.overflow=expanded?'hidden':'';map.invalidateSize();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('map-card').classList.contains('expanded'))$('expand-map').click();});
    $('chart-days').addEventListener('change',()=>renderCharts(true));$('export-csv').addEventListener('click',exportCsv);
    $('date-input').disabled=false;
    setInterval(()=>{if(state.followNow&&airSelection.source==='cams'&&airSelection.period==='hourly'&&!document.hidden){const nearest=D.nearest(data.air.forecast.hours);if(nearest&&D.thaiDay(nearest.valid_time)===state.date&&nearest.valid_time!==airSelection.selectedTime){state.validTime=nearest.valid_time;refresh();}}},60000);
  }catch(error){$('load-banner').hidden=false;$('load-banner').classList.add('error');$('load-banner').textContent=error.message+' · โปรดลองโหลดหน้าใหม่';console.error(error);}
}
setView(state.view,true);init();
})();
