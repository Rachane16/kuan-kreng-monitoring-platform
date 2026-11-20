const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const M=require('../web/model.js');
const fc=features=>({type:'FeatureCollection',features});
const shape=(id,x,y,weight=1)=>({type:'Feature',properties:{grid_id:id,sample_x:x,sample_y:y,coverage_fraction:weight},geometry:{type:'Polygon',coordinates:[]}});
const grid=fc([shape('a',0,0),shape('b',1000,0),shape('c',0,1000),shape('d',1000,1000,3)]);
const camsGrid=fc(['x','y'].map((id,i)=>({type:'Feature',properties:{grid_id:id,overlap_m2:i?3:1},geometry:{type:'Polygon',coordinates:[]}})));
const bundle={maiac:grid,cams:camsGrid};
const maiac={date:'2026-09-15',status:'Available',available_cells:3,cells:[['a',.1,10],['b',.2,20],['c',.3,30]]};
const cams={...maiac,cells:[['x',.1,10,24],['y',.2,30,24]],available_cells:2};

test('date selection prefers actual MAIAC samples and manual source preserves the calendar date',()=>{
 const data={maiac:{days:[maiac]},cams:{days:[cams]},forecast:{hours:[]}};
 let selected=M.selectAir(data,{date:maiac.date,now:'2026-11-18T00:00:00Z'});
 assert.equal(selected.source,'maiac');assert.equal(selected.period,'daily');assert.equal(selected.day.date,maiac.date);
 selected=M.selectAir(data,{date:maiac.date,source:'cams',now:'2026-11-18T00:00:00Z'});
 assert.equal(selected.source,'cams');assert.equal(selected.day.date,maiac.date);assert.equal(selected.period,'daily');
 selected=M.selectAir(data,{date:'2026-09-16'});assert.equal(selected.source,'cams');assert.equal(selected.day.status,'NotPublished');
 assert.equal(M.selectAir({maiac:{days:[{...maiac,available_cells:99,cells:[]}]}},{date:maiac.date}).source,'cams');
});
test('hourly selection stays inside the selected Thai day and honors explicit valid time',()=>{
 const make=t=>({valid_time:t,status:'Available',cells:[['x',.1,10]],forecast_base_time:'2026-11-17T00:00:00Z'});
 const hours=[make('2026-11-17T16:00:00Z'),make('2026-11-17T17:00:00Z'),make('2026-11-17T18:00:00Z')];
 const data={maiac:{days:[]},cams:{days:[]},forecast:{hours}};
 let selected=M.selectAir(data,{date:'2026-11-18',now:'2026-11-17T16:50:00Z'});
 assert.equal(selected.period,'hourly');assert.equal(selected.selectedTime,hours[1].valid_time);assert.equal(selected.day.date,'2026-11-18');
 selected=M.selectAir(data,{date:'2026-11-18',validTime:hours[2].valid_time,now:'2026-11-17T17:00:00Z'});
 assert.equal(selected.selectedTime,hours[2].valid_time);
 selected=M.selectAir(data,{date:'2026-11-19',now:'2026-11-17T17:00:00Z'});
 assert.equal(selected.selectedTime,null);assert.deepEqual(selected.day.cells,[]);assert.equal(selected.day.date,'2026-11-19');
});
test('IDW mean is weighted by clipped reporting area and sparse data remains partial source data',()=>{
 const result=M.airSummary({source:'maiac',period:'daily',day:maiac},bundle);
 assert.equal(result.mode,'idw');assert.equal(result.sourceCount,3);assert.equal(result.values.get('d'),22);
 assert.equal(result.mean,21);assert.equal(result.coverageFraction,1);assert.equal(result.partial,false);
 const empirical=M.airSummary({source:'maiac',period:'daily',day:maiac},bundle,'pm1');
 assert.ok(Math.abs(empirical.mean-16.09)<1e-12);
 const sparse=M.airSummary({source:'maiac',period:'daily',day:{...maiac,cells:maiac.cells.slice(0,2)}},bundle);
 assert.equal(sparse.mode,'source');assert.equal(sparse.sampler,null);assert.equal(sparse.mean,15);assert.equal(sparse.partial,true);
 const native=M.airSummary({source:'cams',period:'daily',day:cams},bundle);
 assert.equal(native.mean,25);assert.equal(native.mode,'cams');assert.equal(native.partial,false);
});
test('daily air comparison requires full-area IDW and falls back to native CAMS rather than sparse-source means',()=>{
 const data={maiac:{days:[{...maiac,cells:maiac.cells.slice(0,2)}]},cams:{days:[cams]}};
 let series=M.airDailySeries(data,bundle,maiac.date,'2026-09-16');
 assert.equal(series[0].source,'cams');assert.equal(series[0].value,25);assert.equal(series[1].value,null);
 series=M.airDailySeries(data,bundle,maiac.date,maiac.date,'pm25','maiac');
 assert.equal(series[0].value,null);
 data.maiac.days=[maiac];series=M.airDailySeries(data,bundle,maiac.date,maiac.date);
 assert.equal(series[0].source,'maiac');assert.equal(series[0].value,21);
});
const totals={observation_count:0,grid_count:0,cluster_count:0,ground_area_ha:0,emission_kg:0,emission_without_peat_kg:0,fuels:[],cells:fc([]),clusters:fc([])};
test('fire zero observations remains different from unavailable and partial source coverage',()=>{
 let day={data_state:'ok',by_source:{ALL:totals},source_status:{},hotspots:fc([])};
 let summary=M.fireSummary(day);assert.equal(summary.available,true);assert.equal(summary.emissionKg,0);assert.equal(summary.partial,false);
 summary=M.fireSummary({...day,data_state:'partial'});assert.equal(summary.available,true);assert.equal(summary.partial,true);assert.equal(summary.emissionKg,0);
 summary=M.fireSummary({...day,data_state:'error'});assert.equal(summary.available,false);assert.equal(summary.emissionKg,null);
 summary=M.fireSummary(null);assert.equal(summary.available,false);assert.equal(summary.observations,null);
});
test('satellite and peat selection preserve source totals and raw features without mutation',()=>{
 const cells=fc([{properties:{grid_id:'fire-a',emission_kg:100}}]);
 const summary={...totals,observation_count:2,grid_count:1,emission_kg:100,emission_without_peat_kg:20,fuels:[{code:'GRASS',peat_scenario:false,emission_kg:20},{code:'PEAT',peat_scenario:true,emission_kg:80}],cells};
 const day={data_state:'partial',by_source:{ALL:summary,A:summary,B:totals},source_status:{A:{state:'error'},B:{state:'unavailable'}},hotspots:fc([{properties:{source:'A'}},{properties:{source:'B'}}])};
 const selected=M.fireSummary(day,'A',false);
 assert.equal(selected.available,true);assert.equal(selected.partial,true);assert.equal(selected.emissionKg,20);
 assert.equal(selected.fuels.length,1);assert.equal(selected.hotspots.features.length,1);assert.equal(selected.cells,cells);
 assert.equal(cells.features[0].properties.emission_kg,100);
 assert.equal(M.fireSummary(day,'B').emissionKg,null);
});
test('emission series preserves calendar gaps, source status and daily independent totals',()=>{
 const index={daily:[{date:'2026-11-16',data_state:'ok',emission_kg:10,emission_without_peat_kg:2,observations:3,by_source:{A:{emission_kg:5,emission_without_peat_kg:1,observations:1}},source_status:{A:'ok'}},
 {date:'2026-11-18',data_state:'partial',emission_kg:0,emission_without_peat_kg:0,observations:0,by_source:{A:{emission_kg:0,observations:0}},source_status:{A:'unavailable'}}]};
 const all=M.emissionSeries(index,'2026-11-16','2026-11-18','ALL',false);
 assert.deepEqual(all.map(r=>r.value),[2,null,0]);assert.deepEqual(all.map(r=>r.state),['ok','missing','partial']);
 const source=M.emissionSeries(index,'2026-11-16','2026-11-18','A');assert.deepEqual(source.map(r=>r.value),[5,null,null]);
 assert.throws(()=>M.emissionSeries(index,'2026-11-18','2026-11-16'));
});
const dataRoot=path.resolve(__dirname,'../web/data');
test('published real air snapshots retain source values and native area weighting',{skip:!fs.existsSync(path.join(dataRoot,'air/history.json'))},()=>{
 const read=file=>JSON.parse(fs.readFileSync(path.join(dataRoot,file),'utf8'));
 const real={maiac:read('air/history.json'),cams:read('air/cams_history.json'),forecast:read('air/cams_forecast.json')};
 const grids={maiac:read('air/grid.geojson'),cams:read('air/cams_grid.geojson')};
 const day=real.maiac.days.find(d=>d.cells.length>=3);
 const selected=M.selectAir(real,{date:day.date,source:'maiac'}),result=M.airSummary(selected,grids);
 if(result.mode==='idw')for(const point of result.sourcePoints)assert.equal(result.sampler(point.x,point.y).value,point.value);
 const c=real.cams.days.find(d=>d.status==='Available'),native=M.airSummary({source:'cams',period:'daily',day:c},grids);
 assert.ok(Math.abs(native.mean-c.mean_pm25)<.02);assert.equal(native.partial,false);
});
test('published real fire summary matches saved unique-grid totals',{skip:!fs.existsSync(path.join(dataRoot,'fire/index.json'))},()=>{
 const index=JSON.parse(fs.readFileSync(path.join(dataRoot,'fire/index.json'),'utf8'));
 const row=index.daily.find(d=>d.observations>0);
 const day=JSON.parse(fs.readFileSync(path.join(dataRoot,`fire/daily/${row.date}.json`),'utf8'));
 const summary=M.fireSummary(day),without=M.fireSummary(day,'ALL',false);
 assert.equal(summary.observations,row.observations);assert.equal(summary.gridCount,row.grid_count);
 assert.equal(summary.emissionKg,row.emission_kg);assert.equal(without.emissionKg,row.emission_without_peat_kg);
 assert.equal(new Set(summary.cells.features.map(f=>f.properties.grid_id)).size,summary.gridCount);
});


test('satellite keys are canonical without duplicating ALL, array order or repeated IDs',()=>{
 const [a,b]=M.satellites;
 assert.equal(M.sourceKey([b,a,a]),[a,b].sort().join('|'));
 assert.equal(M.sourceKey(a),a);assert.equal(M.sourceKey([]),'');
 assert.equal(M.sourceKey('ALL'),[...M.satellites].sort().join('|'));
 assert.equal(M.sourceKey([...M.satellites].reverse()),M.sourceKey('ALL'));
});
function overlapFixture(){
 const [a,b,c,d]=M.satellites,key=M.sourceKey([a,b]);
 const feature={type:'Feature',properties:{grid_id:'shared-cell',emission_kg:100},geometry:{type:'Polygon',coordinates:[]}};
 const one={...totals,observation_count:1,grid_count:1,cluster_count:1,ground_area_ha:100,emission_kg:100,emission_without_peat_kg:20,cells:fc([feature]),clusters:fc([feature])};
 const union={...one,observation_count:2,_state:'ok'};
 const day={date:'2026-11-16',data_state:'ok',by_source:{ALL:union,[a]:one,[b]:one,[c]:totals,[d]:totals},source_status:{[a]:'ok',[b]:'ok',[c]:'ok',[d]:'ok'},
  selections:{[key]:union},hotspots:fc([a,b,c].map((source,i)=>({type:'Feature',properties:{source,grid_id:'shared-cell',id:i},geometry:{type:'Point',coordinates:[100,8]}})))};
 return {a,b,c,d,key,day,union};
}
test('multi-satellite summary uses derived shared-cell union and never adds component emission totals',()=>{
 const {a,b,c,key,day}=overlapFixture();
 const selected=M.fireSummary(day,[b,a]);
 assert.equal(selected.emissionKg,100);assert.equal(selected.gridCount,1);assert.equal(selected.observations,2);
 assert.equal(selected.hotspots.features.length,2);assert.deepEqual(selected.sources,[a,b].sort());
 assert.equal(M.fireSummary(day,[a,b],false).emissionKg,20);
 assert.equal(M.fireSummary({...day,selections:{}},[a,b]).available,false);
 assert.equal(M.fireSummary(day,[c]).emissionKg,0);
 const original=day.selections[key].cells.features[0].properties.emission_kg;
 assert.equal(original,100);assert.notEqual(selected.emissionKg,day.by_source[a].emission_kg+day.by_source[b].emission_kg);
});
test('empty satellite selection remains missing rather than displaying ALL or invented zero',()=>{
 const {day}=overlapFixture(),selected=M.fireSummary(day,[]);
 assert.equal(selected.available,false);assert.equal(selected.emissionKg,null);assert.equal(selected.observations,null);
 assert.deepEqual(selected.sources,[]);assert.deepEqual(selected.cells.features,[]);
 const series=M.fireTimeSeries({daily:[{date:day.date,...day}]},day.date,day.date,[],true,'hotspots');
 assert.equal(series[0].value,null);assert.equal(series[0].state,'missing');
});
test('array-of-one and array-of-all preserve legacy results when no derived cache is provided',()=>{
 const {a,day}=overlapFixture();delete day.selections;
 assert.equal(M.fireSummary(day,[a]).emissionKg,M.fireSummary(day,a).emissionKg);
 assert.equal(M.fireSummary(day,M.satellites).emissionKg,M.fireSummary(day,'ALL').emissionKg);
});
test('fire chart switches metrics but preserves confirmed zero and missing coverage',()=>{
 const {a,b,key,union}=overlapFixture();
 const zero={...totals,_state:'partial'},missing={...totals,observation_count:null,emission_kg:null,_state:'missing'};
 const index={daily:[{date:'2026-11-16',selections:{[key]:union}},{date:'2026-11-17',selections:{[key]:zero}},{date:'2026-11-18',selections:{[key]:missing}}]};
 const sources=[a,b];
 assert.deepEqual(M.fireTimeSeries(index,'2026-11-16','2026-11-19',sources,true,'hotspots').map(r=>r.value),[2,0,null,null]);
 assert.deepEqual(M.emissionSeries(index,'2026-11-16','2026-11-19',sources,false).map(r=>r.value),[20,0,null,null]);
 assert.deepEqual(M.fireTimeSeries(index,'2026-11-16','2026-11-18',sources,false,'count').map(r=>r.state),['ok','partial','missing']);
});
test('calendar marks positive fire, observed zero and unavailable dates separately for the selected satellites',()=>{
 const {a,b,key,union}=overlapFixture(),sources=[a,b];
 const fireIndex={daily:[{date:'2026-11-16',selections:{[key]:union}},{date:'2026-11-17',selections:{[key]:{...totals,_state:'partial'}}}]};
 const options={view:'fire',fireIndex,fireSources:sources};
 let result=M.calendarAvailability({...options,date:'2026-11-16'});
 assert.equal(result.fire,true);assert.equal(result.fireZero,false);assert.equal(result.available,true);assert.equal(result.partial,false);
 result=M.calendarAvailability({...options,date:'2026-11-17'});
 assert.equal(result.fire,false);assert.equal(result.fireZero,true);assert.equal(result.available,true);assert.equal(result.partial,true);
 result=M.calendarAvailability({...options,date:'2026-11-18'});
 assert.equal(result.fire,false);assert.equal(result.fireZero,false);assert.equal(result.available,false);
 result=M.calendarAvailability({...options,date:'2026-11-16',fireSources:[]});assert.equal(result.available,false);
});
test('calendar air availability follows source, period and actual valid samples without moving dates',()=>{
 const air={maiac:{grid_count:4,days:[maiac]},cams:{grid_count:2,days:[cams]},forecast:{hours:[{valid_time:'2026-11-18T18:00:00Z',status:'Available',cells:[['x',.1,10],['y',.2,20]]}]}};
 const base={view:'air',air,now:'2026-11-18T19:00:00Z'};
 let result=M.calendarAvailability({...base,date:'2026-09-15',airSource:'maiac'});
 assert.equal(result.air,true);assert.equal(result.partial,true);assert.equal(result.forecast,false);
 result=M.calendarAvailability({...base,date:'2026-09-15',airSource:'cams',airPeriod:'daily'});
 assert.equal(result.air,true);assert.equal(result.partial,false);
 result=M.calendarAvailability({...base,date:'2026-11-19',airSource:'maiac'});assert.equal(result.available,false);
 result=M.calendarAvailability({...base,date:'2026-11-19',airSource:'cams'});assert.equal(result.air,true);assert.equal(result.forecast,true);
 result=M.calendarAvailability({...base,date:'2026-11-19',airSource:'cams',airPeriod:'daily'});assert.equal(result.available,false);
 result=M.calendarAvailability({...base,date:'2026-09-16',airSource:'maiac'});assert.equal(result.air,false);
});

test('real NOAA-20/21 overlap uses six unique burning grids instead of seven component grids',{skip:!fs.existsSync(path.join(dataRoot,'ui/fire_index.json'))},()=>{
 const zlib=require('node:zlib'),date='2026-08-13',sources=['VIIRS_NOAA20_NRT','VIIRS_NOAA21_NRT'];
 const index=JSON.parse(fs.readFileSync(path.join(dataRoot,'ui/fire_index.json'),'utf8'));
 const native=JSON.parse(fs.readFileSync(path.join(dataRoot,`fire/daily/${date}.json`),'utf8'));
 const derived=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataRoot,`ui/fire/${date}.json.gz`))).toString('utf8'));
 const day={...native,selections:derived.selections},selected=M.fireSummary(day,sources),key=M.sourceKey(sources);
 const row=index.daily.find(r=>r.date===date),expected=row.selections[key];
 assert.equal(selected.gridCount,6);assert.equal(selected.cells.features.length,6);
 assert.equal(selected.emissionKg,expected.emission_kg);
 assert.ok(selected.emissionKg<row.selections[sources[0]].emission_kg+row.selections[sources[1]].emission_kg);
 assert.equal(M.fireTimeSeries(index,date,date,sources,true,'hotspots')[0].value,selected.observations);
 assert.equal(M.calendarAvailability({date,view:'fire',fireIndex:index,fireSources:sources}).fire,true);
});

test('VIIRS is daily observed data, keeps the selected day, and never borrows CAMS forecast hours',()=>{
 const observed={date:'2026-11-19',status:'Available',available_cells:1,cells:[['v',.3,30,2]]};
 const data={maiac:{days:[]},cams:{days:[]},viirs:{days:[observed]},forecast:{hours:[{valid_time:'2026-11-19T08:00:00Z',status:'Available',cells:[['x',.9,90]]}]}};
 const selected=M.selectAir(data,{date:observed.date,source:'viirs',period:'hourly',now:'2026-11-19T08:00:00Z'});
 assert.equal(selected.source,'viirs');assert.equal(selected.period,'daily');assert.equal(selected.selectedTime,null);assert.deepEqual(selected.day.cells,observed.cells);
 const missing=M.selectAir(data,{date:'2026-11-18',source:'viirs'});assert.equal(missing.day.date,'2026-11-18');assert.equal(missing.day.status,'NotPublished');assert.deepEqual(missing.day.cells,[]);
 assert.equal(M.selectAir(data,{date:observed.date}).source,'cams');
 assert.equal(M.airSourceName('viirs'),'VIIRS NOAA');
});
test('VIIRS uses clipped 6 km reporting areas, marks partial coverage and retains zero',()=>{
 const native=fc(['v','w'].map((id,i)=>({type:'Feature',properties:{grid_id:id,overlap_m2:i?3:1},geometry:{type:'Polygon',coordinates:[]}})));
 const day={date:'2026-11-19',status:'Available',available_cells:1,cells:[['v',0,0,1]]};
 const grids={...bundle,viirs:native};
 const selected=M.selectAir({viirs:{days:[day]}},{date:day.date,source:'viirs'});
 const summary=M.airSummary(selected,grids);
 assert.equal(summary.mode,'viirs');assert.equal(summary.mean,0);assert.equal(summary.coverageFraction,.25);assert.equal(summary.partial,true);assert.equal(summary.sampler,null);
 const series=M.airDailySeries({viirs:{days:[day]}},grids,day.date,'2026-11-20','pm25','viirs');
 assert.deepEqual(series.map(row=>row.value),[0,null]);assert.equal(series[0].state,'partial');assert.equal(series[0].coverageFraction,.25);
 const marks=M.calendarAvailability({date:day.date,view:'air',airSource:'viirs',air:{viirs:{grid_count:2,days:[day]}},now:'2026-11-19T08:00:00Z'});
 assert.equal(marks.air,true);assert.equal(marks.partial,true);assert.equal(marks.forecast,false);
});
