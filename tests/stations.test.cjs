const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const M=require('../web/station-model.js');
const catalog={stations:[{id:'a',coordinate:[0,0]},{id:'b',coordinate:[0,1000]},{id:'c',coordinate:[1000,0]},{id:'outside',coordinate:[500,5000]}]};
const inside=coordinate=>coordinate[1]<2000,project=coordinate=>[coordinate[1],coordinate[0]];
const grid={features:[{properties:{grid_id:'one',sample_x:0,sample_y:0,coverage_fraction:1}},{properties:{grid_id:'two',sample_x:500,sample_y:500,coverage_fraction:.5}}]};
const h=(end,values)=>({end_utc:end,start_utc:new Date(Date.parse(end)-3600000).toISOString(),values});
test('station IDW uses a single common hour, excludes outside stations and preserves zero',()=>{
 const hour=h('2026-11-19T07:00:00Z',{a:0,b:20,c:40,outside:999});const f=M.frame(catalog,hour,grid,{inside,project});
 assert.equal(f.available,true);assert.deepEqual(f.ids,['a','b','c']);assert.equal(f.values.get('one'),0);assert.ok(f.mean>=0&&f.mean<=40);assert.equal(f.sampler(0,0).value,0);
});
test('missing readings and collinear or fewer than three stations never produce a surface',()=>{
 assert.equal(M.frame(catalog,h('2026-11-19T07:00:00Z',{a:5,b:10,outside:100}),grid,{inside,project}).available,false);
 const line={stations:[{id:'a',coordinate:[0,0]},{id:'b',coordinate:[0,1000]},{id:'c',coordinate:[0,2000]}]};
 assert.equal(M.frame(line,h('2026-11-19T07:00:00Z',{a:5,b:10,c:15}),grid,{project}).sampler,null);
});
test('latest completed contemporaneous IDW hour is selected without mixing station latest values',()=>{
 const old=h('2026-11-19T06:00:00Z',{a:10,b:20,c:30}),latest=h('2026-11-19T07:00:00Z',{a:100,b:200}),future=h('2026-11-19T09:00:00Z',{a:1,b:2,c:3});
 const selected=M.selectHour(catalog,{hours:[old,latest,future]},'2026-11-19',{now:Date.parse('2026-11-19T07:30:00Z'),inside});
 assert.equal(selected.end_utc,old.end_utc);assert.equal(M.frame(catalog,selected,grid,{inside,project}).sampler(0,0).value,10);
});
test('stale latest data is not presented as current, while explicit historical hours remain selectable',()=>{
 const hour=h('2026-11-19T01:00:00Z',{a:1,b:2,c:3}),options={now:Date.parse('2026-11-19T08:00:00Z'),inside};
 assert.equal(M.selectHour(catalog,{hours:[hour]},'2026-11-19',options),null);
 assert.equal(M.selectHour(catalog,{hours:[hour]},'2026-11-19',{...options,requested:hour.end_utc}),hour);
});
test('hour ending at Thai midnight belongs to the preceding day; future observations never leak',()=>{
 const hour=h('2026-11-18T17:00:00Z',{a:1}),now=Date.parse('2026-11-19T08:00:00Z');
 assert.equal(M.validHours({hours:[hour]},'2026-11-18',now).length,1);assert.equal(M.validHours({hours:[hour]},'2026-11-19',now).length,0);
 assert.equal(M.validHours({hours:[h('2026-11-19T09:00:00Z',{a:1})]},'2026-11-19',now).length,0);
});
test('real six-station snapshot produces concentration over exactly the clipped reporting grid',()=>{
 const base=path.join(__dirname,'../web/data'),c=JSON.parse(fs.readFileSync(path.join(base,'stations/index.json'),'utf8'));
 const example=c.days.findLast(d=>d.max_inside_stations>=3);if(!example){assert.ok(c.days.every(d=>d.max_inside_stations<3));return;}
 const date=example.date,day=JSON.parse(fs.readFileSync(path.join(base,'stations/daily',date+'.json'),'utf8'));
 const g=JSON.parse(fs.readFileSync(path.join(base,'air/grid.geojson'),'utf8')),proj4=require('../web/vendor/proj4.js'),p=proj4('EPSG:4326','+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs');
 const predicate=coordinate=>c.stations.find(s=>s.coordinate[0]===coordinate[0]&&s.coordinate[1]===coordinate[1]).inside_boundary;
 const hour=M.validHours(day,date,Date.parse(c.generated_at_utc)).findLast(h=>c.stations.filter(s=>s.inside_boundary&&Number.isFinite(h.values[s.id])).length>=3),f=M.frame(c,hour,g,{inside:predicate,project:coordinate=>p.forward([coordinate[1],coordinate[0]])});
 assert.equal(c.stations.length,6);assert.equal(f.available,true);assert.equal(f.values.size,1052);assert.ok(!f.ids.includes('5ffe66fbee2238b3ab4463fe'));
 const readings=f.ids.map(id=>hour.values[id]);assert.ok(f.mean>=Math.min(...readings)&&f.mean<=Math.max(...readings));
});
