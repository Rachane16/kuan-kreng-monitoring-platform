/* Pure selection and concentration calculations shared with the tests. */
(function(root){
  const labels={pm25:'PM₂.₅',pm1:'PM₁',pm01:'PM₀.₁'};
  const breaks={pm25:[15,25,37.5,75],pm1:[12,20,30,60],pm01:[2.25,3.75,5.63,11.25]};
  const palette=['#95dcff','#beea8f','#ffe593','#ffc295','#da8b85'];
  function color(value,pollutant='pm25'){
    if(!Number.isFinite(value)||value<0)return null;
    const index=breaks[pollutant].findIndex(limit=>value<=limit);
    return palette[index<0?4:index];
  }
  function concentration(pm25,pollutant='pm25'){
    if(!Number.isFinite(pm25)||pm25<0)return null;
    const value=pollutant==='pm1'?.8*pm25-.71:pollutant==='pm01'?.14*pm25-.4:pm25;
    // Do not silently replace negative empirical predictions with zero.
    return value>=0?value:null;
  }
  function thaiDay(value=new Date()){
    return new Date(new Date(value).getTime()+7*3600000).toISOString().slice(0,10);
  }
  function nearest(hours,now=new Date()){
    const time=+new Date(now);
    return hours.filter(h=>h.status==='Available').reduce((best,h)=>{
      const delta=Math.abs(+new Date(h.valid_time)-time);
      return !best||delta<Math.abs(+new Date(best.valid_time)-time)||
        (delta===Math.abs(+new Date(best.valid_time)-time)&&h.valid_time<best.valid_time)?h:best;
    },null);
  }
  function sourceForDay(preference,maiacDay){
    return preference==='auto'?(maiacDay?.available_cells>0?'maiac':'cams'):preference;
  }
  function areaMean(cells,weights,pollutant='pm25'){
    let total=0,sum=0;
    for(const c of cells){
      const value=concentration(c[2],pollutant),weight=weights.get(c[0]);
      if(value===null||!Number.isFinite(weight)||weight<=0)continue;
      total+=weight;sum+=value*weight;
    }
    return total?sum/total:null;
  }
  const api={labels,breaks,palette,color,concentration,thaiDay,nearest,sourceForDay,areaMean};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KKData=api;
})(typeof globalThis==='undefined'?this:globalThis);
