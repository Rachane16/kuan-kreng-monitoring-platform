const {test}=require('node:test');
const assert=require('node:assert/strict');
const {layout}=require('../web/charts.js');
test('zero remains on the baseline and a missing day receives no point',()=>{
  const p=layout([{date:'2026-11-17',value:0},{date:'2026-11-18',value:null},{date:'2026-11-19',value:20}]);
  assert.equal(p.points[0].y,p.base);assert.equal(p.points[1].y,null);assert.ok(p.points[2].y<p.base);
  assert.ok(p.points[1].x>p.points[0].x&&p.points[2].x>p.points[1].x);
});
test('drop-line values use a proportional zero-based scale and integer count ticks',()=>{
  const p=layout([{value:10},{value:20}],720,240);assert.ok(Math.abs((p.base-p.points[1].y)-2*(p.base-p.points[0].y))<1e-9);
  const empty=layout([{value:0}],720,240,true);assert.equal(empty.maximum,4);assert.equal(empty.points[0].y,empty.base);
});
