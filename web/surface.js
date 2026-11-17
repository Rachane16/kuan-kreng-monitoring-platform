/* Render a 100 m display mesh in Web Mercator, evaluating IDW in UTM metres.
   Clip against the existing boundary-clipped polygons, including holes/islands. */
window.KKSurface = {
  async render(grid, bounds, sampler, project, cancelled, paint) {
    const mercator=L.CRS.EPSG3857;
    const sw=mercator.project(bounds.getSouthWest()),ne=mercator.project(bounds.getNorthEast());
    const centreLat=bounds.getCenter().lat*Math.PI/180;
    const spacing=100/Math.cos(centreLat);
    const width=Math.ceil((ne.x-sw.x)/spacing),height=Math.ceil((ne.y-sw.y)/spacing);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    // All polygons are individually filled, so shared grid boundaries leave no seams.
    ctx.fillStyle='#fff';
    for(const feature of grid.features){
      const polygons=feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[feature.geometry.coordinates];
      for(const polygon of polygons){
        ctx.beginPath();
        for(const ring of polygon){
          ring.forEach(([lng,lat],i)=>{
            const p=mercator.project(L.latLng(lat,lng));
            const x=(p.x-sw.x)/(ne.x-sw.x)*width,y=(ne.y-p.y)/(ne.y-sw.y)*height;
            if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
          });ctx.closePath();
        }
        ctx.fill('evenodd');
      }
    }
    const image=ctx.getImageData(0,0,width,height),data=image.data;
    for(let row=0;row<height;row++){
      if(row%8===0){await new Promise(requestAnimationFrame);if(cancelled())return null;}
      const my=ne.y-(row+.5)/height*(ne.y-sw.y);
      for(let col=0;col<width;col++){
        const offset=4*(row*width+col);if(!data[offset+3])continue;
        const mx=sw.x+(col+.5)/width*(ne.x-sw.x);
        const latlng=mercator.unproject(L.point(mx,my));
        const [x,y]=project.forward([latlng.lng,latlng.lat]);
        const rgb=paint(sampler(x,y).value);
        if(!rgb){data[offset+3]=0;continue;}
        data[offset]=rgb[0];data[offset+1]=rgb[1];data[offset+2]=rgb[2];
        data[offset+3]=255;
      }
    }
    ctx.putImageData(image,0,0);
    return {url:canvas.toDataURL('image/png'),width,height};
  }
};
