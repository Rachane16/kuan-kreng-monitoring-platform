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
