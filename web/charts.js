/* SVG drop-line charts with true zero baselines and explicit missing days. */
(function(root){
  'use strict';
  const NS='http://www.w3.org/2000/svg';
  function layout(rows,width=720,height=240,count=false){
    const left=57,right=18,top=17,base=height-48,inner=width-left-right;
    const observed=rows.map(r=>r.value).filter(v=>Number.isFinite(v)&&v>=0);
    const largest=Math.max(count?4:1,...observed),power=10**Math.floor(Math.log10(largest)),scaled=largest/power;
    const maximum=count?Math.ceil(largest/4)*4:(scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;
    return {width,height,left,right,top,base,maximum,step:inner/Math.max(1,rows.length),points:rows.map((r,i)=>({date:r.date,x:left+(i+.5)*inner/Math.max(1,rows.length),y:Number.isFinite(r.value)&&r.value>=0?base-r.value/maximum*(base-top):null,row:r}))};
  }
  function svg(tag,attrs={},text){const el=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,value);if(text!==undefined)el.textContent=text;return el;}
  function render(holder,rows,{unit='',selectedDate='',color='#6f9e69',onSelect=()=>{},onInspect=()=>{},dateText=d=>d,format=n=>String(n)}={}){
    holder.replaceChildren();
    const width=Math.max(640,holder.clientWidth,rows.length*9),height=240,l=layout(rows,width,height,unit==='รายการ');
    const axis=svg('svg',{width:57,height,viewBox:`0 0 57 ${height}`,class:'plot-y-axis','aria-hidden':'true'});
    const chart=svg('svg',{width,height,viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':holder.getAttribute('aria-label')||'กราฟข้อมูลรายวัน'});
    for(let tick=0;tick<=4;tick++){
      const value=l.maximum*tick/4,y=l.base-tick/4*(l.base-l.top);
      chart.append(svg('line',{x1:l.left,x2:width-l.right,y1:y,y2:y,class:'plot-grid'}));
      axis.append(svg('text',{x:l.left-10,y:y+4,'text-anchor':'end',class:'plot-axis-label'},new Intl.NumberFormat('en-US',{maximumFractionDigits:value<10?1:0,notation:value>=100000?'compact':'standard'}).format(value)));
    }
    l.points.forEach((point,index)=>{
      const r=point.row,known=point.y!==null,title=`${dateText(r.date)} · ${known?format(r.value):'ไม่มีข้อมูล'}${known?' '+unit:''}${r.source?' · '+r.source.toUpperCase():''}${r.state==='partial'?' · ข้อมูลบางส่วน':''}`;
      const group=svg('g',{class:`drop-point${r.date===selectedDate?' selected':''}${r.state==='partial'?' partial':''}`,'data-date':r.date,role:'button',tabindex:'0','aria-label':title,'aria-pressed':String(r.date===selectedDate)});
      group.append(svg('title',{},title));group.append(svg('rect',{x:point.x-l.step/2,y:l.top,width:l.step,height:l.base-l.top+10,class:'plot-hitbox'}));
      if(known){group.append(svg('line',{x1:point.x,x2:point.x,y1:point.y,y2:l.base,class:'drop-line',stroke:color}));group.append(svg('circle',{cx:point.x,cy:point.y,r:r.date===selectedDate?4.5:3.3,fill:color}));}
      else group.append(svg('text',{x:point.x,y:l.base+4,'text-anchor':'middle',class:'plot-empty-label'},'–'));
      group.addEventListener('click',()=>onSelect(r.date));group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(r.date);}});
      group.addEventListener('focus',()=>onInspect(title));group.addEventListener('mouseenter',()=>onInspect(title));
      chart.append(group);
      const every=Math.max(1,Math.ceil(rows.length/6));
      if(index===0||index===rows.length-1||index%every===0){
        const short=new Date(r.date+'T00:00:00Z').toLocaleDateString('th-TH',{timeZone:'UTC',day:'numeric',month:'short'});
        chart.append(svg('text',{x:point.x,y:height-12,'text-anchor':index===0?'start':index===rows.length-1?'end':'middle',class:'plot-date-label'},short));
      }
    });
    const scroll=document.createElement('div');scroll.className='plot-scroll';scroll.append(chart);holder.append(scroll,axis);
    const selected=l.points.find(p=>p.date===selectedDate);scroll.scrollLeft=selected?Math.max(0,selected.x-holder.clientWidth*.65):Math.max(0,width-holder.clientWidth);
  }
  function select(holder,date){for(const point of holder.querySelectorAll('.drop-point')){const active=point.dataset.date===date;point.classList.toggle('selected',active);point.setAttribute('aria-pressed',String(active));const circle=point.querySelector('circle');if(circle)circle.setAttribute('r',active?'4.5':'3.3');}}
  const api={layout,render,select};if(typeof module==='object'&&module.exports)module.exports=api;else root.DropLineChart=api;
})(typeof globalThis==='undefined'?this:globalThis);
