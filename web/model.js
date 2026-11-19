/* Pure data rules shared by the platform UI and its regression checks. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./data-utils.js'),require('./idw.js'));
  else root.PlatformModel=factory(root.KKData,root.KKIDW);
})(typeof globalThis==='undefined'?this:globalThis,function(D,IDW){
  'use strict';
  const EMPTY=()=>({type:'FeatureCollection',features:[]});
  const DAY=86400000;
  const satellites=Object.freeze(['MODIS_NRT','VIIRS_SNPP_NRT','VIIRS_NOAA20_NRT','VIIRS_NOAA21_NRT']);
  function selectionInfo(selection='ALL'){
    if(selection!==null&&typeof selection!=='string'&&!Array.isArray(selection))throw Error('Invalid satellite selection');
    const input=Array.isArray(selection)?selection:selection===null?[]:[selection];
    const ids=[...new Set(input.flatMap(value=>value==='ALL'?satellites:typeof value==='string'?value.split('|').filter(Boolean):[]))].sort();
    return {ids,key:ids.join('|'),all:ids.length===satellites.length&&satellites.every(id=>ids.includes(id))};
  }
  function sourceKey(selection='ALL'){return selectionInfo(selection).key;}
  const validDate=date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
  function dates(first,last){
    if(!validDate(first)||!validDate(last)||last<first)throw Error('Invalid calendar date range');
    if((Date.parse(last)-Date.parse(first))/DAY>366)throw Error('Calendar range exceeds 367 days');
    const values=[];for(let t=Date.parse(first+'T00:00:00Z');t<=Date.parse(last+'T00:00:00Z');t+=DAY)values.push(new Date(t).toISOString().slice(0,10));return values;
  }
  const validCell=cell=>Array.isArray(cell)&&typeof cell[0]==='string'&&Number.isFinite(cell[2])&&cell[2]>=0;
  const cells=day=>(day?.cells||[]).filter(validCell);
  const findDay=(dataset,date)=>dataset?.days?.find(day=>day.date===date)||null;
  const blank=date=>({date,status:'NotPublished',available_cells:0,mean_pm25:null,cells:[]});
  function selectAir(data,options){
    const {date,source='auto',period='auto',validTime=null,now=Date.now()}=options||{};
    if(!validDate(date))throw Error('Invalid selected calendar date');
    const maiac=findDay(data.maiac,date),selected=source==='auto'?(cells(maiac).length?'maiac':'cams'):source;
    if(!['maiac','cams'].includes(selected))throw Error('Invalid air source');
    if(!['auto','daily','hourly'].includes(period))throw Error('Invalid air period');
    const mode=selected==='maiac'?'daily':period==='auto'?(date>=D.thaiDay(now)?'hourly':'daily'):period;
    const availableHours=(data.forecast?.hours||[]).filter(hour=>hour.valid_time&&D.thaiDay(hour.valid_time)===date&&hour.status==='Available'&&cells(hour).length).sort((a,b)=>Date.parse(a.valid_time)-Date.parse(b.valid_time));
    if(mode==='hourly'){
      const hour=availableHours.find(h=>h.valid_time===validTime)||D.nearest(availableHours,now);
      return {source:selected,period:mode,day:hour?{...hour,date}:blank(date),availableHours,selectedTime:hour?.valid_time||null};
    }
    return {source:selected,period:mode,day:(selected==='maiac'?maiac:findDay(data.cams,date))||blank(date),availableHours,selectedTime:null};
  }
  const geometryCache=new WeakMap(),idwCache=new WeakMap();
  function gridInfo(grid){
    if(!grid?.features)return {targets:[],weights:new Map(),totalWeight:0};
    if(geometryCache.has(grid))return geometryCache.get(grid);
    const targets=grid.features.map(f=>({id:f.properties.grid_id,x:f.properties.sample_x,y:f.properties.sample_y,
      weight:Number.isFinite(f.properties.coverage_fraction)?f.properties.coverage_fraction:f.properties.overlap_m2}));
    const weights=new Map(targets.filter(t=>Number.isFinite(t.weight)&&t.weight>0).map(t=>[t.id,t.weight]));
    const result={targets,weights,totalWeight:[...weights.values()].reduce((a,b)=>a+b,0)};geometryCache.set(grid,result);return result;
  }
  function grids(bundle){return bundle?.features?{maiac:bundle,cams:null}:bundle||{};}
  function interpolation(day,grid){
    let cache=idwCache.get(grid);if(!cache){cache=new WeakMap();idwCache.set(grid,cache);}
    if(cache.has(day))return cache.get(day);
    const {targets}=gridInfo(grid),samples=new Map(cells(day).map(c=>[c[0],c]));
    const points=targets.filter(t=>samples.has(t.id)&&[t.x,t.y].every(Number.isFinite)).map(t=>({...t,value:samples.get(t.id)[2]}));
    const sampler=IDW.createSampler(points),values=new Map();
    if(sampler)for(const target of targets)if([target.x,target.y].every(Number.isFinite))values.set(target.id,sampler(target.x,target.y).value);
    const result={points,sampler,values};cache.set(day,result);return result;
  }
  function airSummary(selection,bundle,pollutant='pm25',view='idw'){
    const group=grids(bundle),native=selection.source==='cams',grid=native?group.cams:group.maiac;
    const info=gridInfo(grid),samples=cells(selection.day),sourceValues=new Map(samples.map(c=>[c[0],c[2]]));
    let values=sourceValues,sourcePoints=[],sampler=null,mode=native?'cams':'source';
    if(!native&&grid){
      const indexed=interpolation(selection.day,grid);sourcePoints=indexed.points;
      if(view==='idw'&&indexed.sampler){values=indexed.values;sampler=indexed.sampler;mode='idw';}
    }
    const active=[...values].filter(([id,value])=>info.weights.has(id)&&D.concentration(value,pollutant)!==null);
    const weight=active.reduce((sum,[id])=>sum+info.weights.get(id),0);
    const mean=D.areaMean(active.map(([id,value])=>[id,null,value]),info.weights,pollutant);
    const fraction=info.totalWeight?Math.min(1,weight/info.totalWeight):0;
    return {mean,sourcePoints,sampler,values,mode,available:active.length>0,partial:fraction<1-1e-6,
      sourceCount:samples.length,coverageFraction:fraction,source:selection.source,period:selection.period};
  }
  function stateName(value){return typeof value==='string'?value:value?.state;}
  const unavailableState=name=>['error','unavailable','not_configured','awaiting_key','missing'].includes(name);
  function selectedFire(item,selection='ALL',compact=false){
    const info=selectionInfo(selection);
    if(!info.ids.length)return {...info,summary:null,state:'missing',derived:false};
    const derived=item?.selections?.[info.key];
    if(derived)return {...info,summary:derived,state:stateName(derived._state),derived:true};
    // Mixed subsets require the backend's union of active cells. Adding satellite
    // totals would count a shared burning cell more than once.
    const originalKey=info.all?'ALL':info.ids.length===1?info.ids[0]:null;
    const summary=originalKey?(item?.by_source?.[originalKey]||(compact&&originalKey==='ALL'?item:null)):null;
    const state=originalKey==='ALL'?stateName(item?.data_state):stateName(item?.source_status?.[originalKey]);
    return {...info,summary,state,derived:false};
  }
  function fireAssessment(picked){
    const {summary,state,derived}=picked,count=summary?.observation_count??summary?.observations;
    const available=!!summary&&!(derived&&state==='missing')&&!(unavailableState(state)&&!(count>0));
    return {count,available,partial:available&&state!=='ok'};
  }
  function fireSummary(day,source='ALL',peat=true){
    const picked=selectedFire(day,source),{summary}=picked,{count,available,partial}=fireAssessment(picked);
    const fc=value=>value?.type==='FeatureCollection'&&Array.isArray(value.features)?value:EMPTY();
    return {available,partial,observations:available?(count??null):null,gridCount:available?(summary.grid_count??null):null,
      clusterCount:available?(summary.cluster_count??null):null,areaHa:available?(summary.ground_area_ha??summary.area_ha??null):null,
      emissionKg:available?(peat?summary.emission_kg:summary.emission_without_peat_kg)??null:null,
      fuels:available?(summary.fuels||[]).filter(f=>peat||!f.peat_scenario):[],
      cells:available?fc(summary.cells):EMPTY(),clusters:available?fc(summary.clusters):EMPTY(),
      hotspots:available?{type:'FeatureCollection',features:fc(day.hotspots).features.filter(f=>picked.all||picked.ids.includes(f.properties?.source))}:EMPTY(),
      source,sources:picked.ids,state:available?(partial?'partial':'ok'):'missing'};
  }
  function fireTimeSeries(index,first,last,source='ALL',peat=true,metric='emission'){
    if(!['emission','observations','hotspots','count'].includes(metric))throw Error('Invalid fire chart metric');
    const saved=new Map((index?.daily||[]).map(row=>[row.date,row]));
    return dates(first,last).map(date=>{
      const picked=selectedFire(saved.get(date),source,true),{summary}=picked,{count,available,partial}=fireAssessment(picked);
      const value=!available?null:metric==='emission'?(peat?summary.emission_kg:summary.emission_without_peat_kg):count;
      return {date,value:Number.isFinite(value)?value:null,state:available?(partial?'partial':'ok'):'missing',observations:available?(count??null):null};
    });
  }
  function emissionSeries(index,first,last,source='ALL',peat=true){return fireTimeSeries(index,first,last,source,peat,'emission');}
  function calendarAvailability({date,view='overview',airSource='auto',airPeriod='auto',air={},fireIndex,fireSources='ALL',now=Date.now()}){
    const selected=selectAir(air,{date,source:airSource,period:airPeriod,now}),airCount=cells(selected.day).length;
    const airAvailable=selected.day.status==='Available'&&airCount>0;
    const gridCount=(selected.source==='maiac'?air.maiac:air.cams)?.grid_count;
    const airPartial=airAvailable&&Number.isFinite(gridCount)&&airCount<gridCount;
    const row=fireIndex?.daily?.find(r=>r.date===date),picked=selectedFire(row,fireSources,true);
    const {count,available:fireAvailable,partial:firePartial}=fireAssessment(picked);
    const positive=fireAvailable&&Number.isFinite(count)&&count>0,zero=fireAvailable&&count===0;
    const relevantFire=positive||zero;
    const available=view==='air'?airAvailable:view==='fire'?relevantFire:airAvailable||relevantFire;
    const partial=view==='air'?airPartial:view==='fire'?firePartial:(airAvailable&&airPartial)||(relevantFire&&firePartial);
    return {air:airAvailable,fire:positive,fireZero:zero,partial,available,forecast:airAvailable&&selected.source==='cams'&&selected.period==='hourly'};
  }
  function airDailySeries(data,bundle,first,last,pollutant='pm25',source='auto'){
    const group=grids(bundle);
    return dates(first,last).map(date=>{
      const maiac=findDay(data.maiac,date),cams=findDay(data.cams,date);
      if(source!=='cams'&&maiac&&cells(maiac).length&&group.maiac){
        const summary=airSummary({source:'maiac',period:'daily',day:maiac},group,pollutant,'idw');
        if(summary.mode==='idw'&&!summary.partial&&summary.mean!==null)return {date,value:summary.mean,source:'maiac',state:'ok',mode:'idw'};
        if(source==='maiac')return {date,value:null,source:'maiac',state:'missing',mode:summary.mode};
      }
      if(source!=='maiac'&&cams&&group.cams){
        const summary=airSummary({source:'cams',period:'daily',day:cams},group,pollutant,'source');
        if(!summary.partial&&summary.mean!==null)return {date,value:summary.mean,source:'cams',state:'ok',mode:'cams'};
      }
      return {date,value:null,source:source==='maiac'?'maiac':'cams',state:'missing',mode:null};
    });
  }
  return {selectAir,airSummary,fireSummary,emissionSeries,airDailySeries,dates,sourceKey,satellites,fireTimeSeries,calendarAvailability};
});
