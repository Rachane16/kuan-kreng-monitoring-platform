/* IDW in metres (EPSG:32647), p=2, up to 12 nearest neighbours. */
(function (root) {
  "use strict";
  function interpolate(points, targets) {
    const unique = new Map();
    for (const p of points) {
      if ([p.x, p.y, p.value].every(Number.isFinite)) unique.set(`${p.x},${p.y}`, p);
    }
    const source = [...unique.values()];
    if (source.length < 3) return {status: "insufficient", values: []};
    const a = source[0], b = source[1];
    const baseline = Math.hypot(b.x - a.x, b.y - a.y);
    // Three distinct points must span an area, rather than a single line.
    if (!source.some(p => Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)) / baseline > 1)) {
      return {status: "insufficient", values: []};
    }
    const values = targets.map(t => {
      const neighbours = source.map(p => ({p, d2: (p.x-t.x)**2 + (p.y-t.y)**2}))
        .sort((a,b) => a.d2-b.d2).slice(0,12);
      if (neighbours[0].d2 < 1e-6) return {id:t.id, value:neighbours[0].p.value, distance:0, neighbours:1};
      // Relative weights avoid large intermediate numbers at short distances.
      let sum = 0, weight = 0;
      for (const n of neighbours) { const w=neighbours[0].d2/n.d2; sum+=w*n.p.value; weight+=w; }
      return {id:t.id, value:sum/weight, distance:Math.sqrt(neighbours[0].d2), neighbours:neighbours.length};
    });
    return {status:"available", values};
  }
  // Reusable nearest-neighbour index for dense display rasters and map clicks.
  function createSampler(points) {
    if (interpolate(points, []).status !== "available") return null;
    const source=[...new Map(points.filter(p=>[p.x,p.y,p.value].every(Number.isFinite)).map(p=>[`${p.x},${p.y}`,p])).values()];
    function build(list,depth=0) {
      if (!list.length) return null;
      const axis=depth%2?'y':'x'; list.sort((a,b)=>a[axis]-b[axis]);
      const mid=Math.floor(list.length/2);
      return {p:list[mid],axis,left:build(list.slice(0,mid),depth+1),right:build(list.slice(mid+1),depth+1)};
    }
    const tree=build(source);
    return (x,y)=>{
      const near=[];
      function visit(node) {
        if (!node) return;
        const d2=(node.p.x-x)**2+(node.p.y-y)**2;
        if (near.length<12 || d2<near[near.length-1].d2) {
          near.push({p:node.p,d2});near.sort((a,b)=>a.d2-b.d2);if(near.length>12)near.pop();
        }
        const delta=(node.axis==='x'?x:y)-node.p[node.axis];
        visit(delta<0?node.left:node.right);
        if(near.length<12 || delta*delta<=near[near.length-1].d2)visit(delta<0?node.right:node.left);
      }
      visit(tree);
      if(near[0].d2<1e-6)return {value:near[0].p.value,distance:0,neighbours:1};
      let sum=0,weight=0;
      for(const n of near){const w=near[0].d2/n.d2;sum+=w*n.p.value;weight+=w;}
      return {value:sum/weight,distance:Math.sqrt(near[0].d2),neighbours:near.length};
    };
  }
  const api = {interpolate, createSampler};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KKIDW = api;
})(typeof window !== "undefined" ? window : this);
