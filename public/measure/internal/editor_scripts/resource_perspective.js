// Perspective correction for Resources images (project_resources.js).
// Four corners placed on something rectangular in the photo are mapped to a rectangle; the whole photo is warped
// with that projective transform. `crop` keeps only the largest upright rectangle that the warped photo fills, so
// the result has no empty corners. Pure functions plus one renderer; no editor state.
(function(root){
 'use strict';
 const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

 // Corners in reading order (top-left, top-right, bottom-right, bottom-left) however they were dragged.
 function orderQuad(points){
  const c={x:points.reduce((s,p)=>s+p.x,0)/4,y:points.reduce((s,p)=>s+p.y,0)/4};
  const ring=[...points].sort((a,b)=>Math.atan2(a.y-c.y,a.x-c.x)-Math.atan2(b.y-c.y,b.x-c.x));
  const start=ring.reduce((best,p,i)=>p.x+p.y<ring[best].x+ring[best].y?i:best,0);
  return [0,1,2,3].map(i=>ring[(start+i)%4]);
 }

 // True when the four corners make a convex quadrilateral with some area (a usable rectangle in perspective).
 function usableQuad(q){
  let sign=0;
  for(let i=0;i<4;i++){const a=q[i],b=q[(i+1)%4],c=q[(i+2)%4],z=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);if(Math.abs(z)<1e-6)return false;const s=Math.sign(z);if(sign&&s!==sign)return false;sign=s;}
  return Math.min(dist(q[0],q[1]),dist(q[1],q[2]),dist(q[2],q[3]),dist(q[3],q[0]))>4;
 }

 // 3x3 homography (row-major, h33 = 1) taking each from[i] to to[i].
 function homography(from,to){
  const A=[],b=[];
  for(let i=0;i<4;i++){const {x,y}=from[i],{x:u,y:v}=to[i];A.push([x,y,1,0,0,0,-u*x,-u*y]);b.push(u);A.push([0,0,0,x,y,1,-v*x,-v*y]);b.push(v);}
  for(let col=0;col<8;col++){
   let pivot=col;for(let r=col+1;r<8;r++)if(Math.abs(A[r][col])>Math.abs(A[pivot][col]))pivot=r;
   if(Math.abs(A[pivot][col])<1e-12)throw Error('These corners do not describe a rectangle.');
   [A[col],A[pivot]]=[A[pivot],A[col]];[b[col],b[pivot]]=[b[pivot],b[col]];
   for(let r=0;r<8;r++){if(r===col)continue;const f=A[r][col]/A[col][col];if(!f)continue;for(let k=col;k<8;k++)A[r][k]-=f*A[col][k];b[r]-=f*b[col];}
  }
  return [...b.map((v,i)=>v/A[i][i]),1];
 }
 const apply=(H,p)=>{const w=H[6]*p.x+H[7]*p.y+H[8];return{x:(H[0]*p.x+H[1]*p.y+H[2])/w,y:(H[3]*p.x+H[4]*p.y+H[5])/w,w};};

 // Largest all-true axis-aligned rectangle in a row-major boolean grid (histogram method).
 // `must` ({x0,y0,x1,y1} in cells, exclusive ends) limits it to rectangles that contain that block.
 function largestRect(mask,cols,rows,must=null){
  const heights=new Int32Array(cols);let best={area:0,x:0,y:0,w:0,h:0};
  for(let r=0;r<rows;r++){
   for(let c=0;c<cols;c++)heights[c]=mask[r*cols+c]?heights[c]+1:0;
   const stack=[];
   for(let c=0;c<=cols;c++){
    const h=c<cols?heights[c]:0;
    while(stack.length&&heights[stack.at(-1)]>=h){const top=stack.pop(),height=heights[top],left=stack.length?stack.at(-1)+1:0,width=c-left,area=height*width;if(area>best.area&&(!must||left<=must.x0&&c>=must.x1&&r-height+1<=must.y0&&r+1>=must.y1))best={area,x:left,y:r-height+1,w:width,h:height};}
    stack.push(c);
   }
  }
  return best;
 }

 // Where the corrected picture lies, in output-rectangle units, and the pixel size it is drawn at.
 function plan({width,height,corners,crop=false,maxSide=6000,maxPixels=32e6}){
  const q=orderQuad(corners);if(!usableQuad(q))throw Error('Drag the four corners onto the corners of something rectangular.');
  const w=Math.max(1,(dist(q[0],q[1])+dist(q[3],q[2]))/2),h=Math.max(1,(dist(q[0],q[3])+dist(q[1],q[2]))/2);
  const rect=[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];
  const forward=homography(q,rect),inverse=homography(rect,q);
  const side=apply(inverse,{x:w/2,y:h/2}).w>0?1:-1;
  // The photo's own corners give its warped outline; a corner past the horizon makes it unbounded, so the domain
  // is limited to a generous margin around the rectangle either way.
  const margin=2*Math.max(w,h),limit={x0:-margin,y0:-margin,x1:w+margin,y1:h+margin};
  const mapped=[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}].map(p=>apply(forward,p));
  let box=limit;
  if(mapped.every(p=>p.w*side>0)){const xs=mapped.map(p=>p.x),ys=mapped.map(p=>p.y);box={x0:Math.max(limit.x0,Math.min(...xs)),y0:Math.max(limit.y0,Math.min(...ys)),x1:Math.min(limit.x1,Math.max(...xs)),y1:Math.min(limit.y1,Math.max(...ys))};}
  // Sample which parts of the domain the photo covers.
  const long=480,bw=box.x1-box.x0,bh=box.y1-box.y0,cell=Math.max(bw,bh)/long,cols=Math.max(1,Math.ceil(bw/cell)),rows=Math.max(1,Math.ceil(bh/cell)),mask=new Uint8Array(cols*rows);
  let minC=cols,minR=rows,maxC=-1,maxR=-1;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const s=apply(inverse,{x:box.x0+(c+.5)*cell,y:box.y0+(r+.5)*cell});if(s.w*side>0&&s.x>=0&&s.y>=0&&s.x<=width&&s.y<=height){mask[r*cols+c]=1;minC=Math.min(minC,c);maxC=Math.max(maxC,c);minR=Math.min(minR,r);maxR=Math.max(maxR,r);}}
  if(maxC<0)throw Error('The corrected image would be empty. Move the corners closer together.');
  let area;
  if(crop){
   // Cells are tested at their centres, so drop one cell on each side to keep empty slivers out of the edge.
   // The straightened rectangle stays in the picture: the crop must contain it (when the photo covers all of it).
   const must={x0:Math.floor(-box.x0/cell),y0:Math.floor(-box.y0/cell),x1:Math.ceil((w-box.x0)/cell),y1:Math.ceil((h-box.y0)/cell)};
   let best=largestRect(mask,cols,rows,{x0:must.x0-1,y0:must.y0-1,x1:must.x1+1,y1:must.y1+1});if(!best.area)best=largestRect(mask,cols,rows);
   const inset=best.w>4&&best.h>4?1:0;
   area={x0:box.x0+(best.x+inset)*cell,y0:box.y0+(best.y+inset)*cell,x1:box.x0+(best.x+best.w-inset)*cell,y1:box.y0+(best.y+best.h-inset)*cell};
  }else area={x0:box.x0+minC*cell,y0:box.y0+minR*cell,x1:box.x0+(maxC+1)*cell,y1:box.y0+(maxR+1)*cell};
  const aw=area.x1-area.x0,ah=area.y1-area.y0,scale=Math.min(1,maxSide/Math.max(aw,ah),Math.sqrt(maxPixels/(aw*ah)));
  return {inverse,side,area,scale,width:Math.max(1,Math.round(aw*scale)),height:Math.max(1,Math.round(ah*scale)),rect:{w,h},corners:q};
 }

 // The photo's pixels, optionally scaled down so its longer side is at most `maxSide` (for the live view).
 function pixels(source,maxSide=Infinity){
  const nw=source.naturalWidth||source.width,nh=source.naturalHeight||source.height,k=Math.min(1,maxSide/Math.max(nw,nh)),sw=Math.max(1,Math.round(nw*k)),sh=Math.max(1,Math.round(nh*k));
  const read=document.createElement('canvas');read.width=sw;read.height=sh;const rc=read.getContext('2d',{willReadFrequently:true});rc.drawImage(source,0,0,sw,sh);
  try{return {data:rc.getImageData(0,0,sw,sh).data,width:sw,height:sh,scale:k};}
  catch{throw Error('This image comes from another site and cannot be corrected here. Upload a copy to the project first.');}
  finally{read.width=read.height=0;}
 }
 // Fills rows [from, to) of `dst` (RGBA, p.width wide) from `src` pixels: bilinear, transparent where the photo does not reach.
 function warpRows(src,sw,sh,p,dst,from,to){
  const H=p.inverse,step=1/p.scale,side=p.side,dx=H[0]*step,dy=H[3]*step,dw=H[6]*step;
  for(let v=from;v<to;v++){
   const y=p.area.y0+(v+.5)*step,x=p.area.x0+.5*step;
   let X=H[0]*x+H[1]*y+H[2],Y=H[3]*x+H[4]*y+H[5],W=H[6]*x+H[7]*y+H[8],o=v*p.width*4;
   for(let u=0;u<p.width;u++,X+=dx,Y+=dy,W+=dw,o+=4){
    if(W*side<=0)continue;
    const sx=X/W-.5,sy=Y/W-.5;
    if(sx<-.5||sy<-.5||sx>sw-.5||sy>sh-.5)continue;
    const x0=Math.max(0,Math.floor(sx)),y0=Math.max(0,Math.floor(sy)),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),fx=Math.min(1,Math.max(0,sx-x0)),fy=Math.min(1,Math.max(0,sy-y0));
    const a=(y0*sw+x0)*4,b=(y0*sw+x1)*4,c=(y1*sw+x0)*4,d=(y1*sw+x1)*4,wa=(1-fx)*(1-fy),wb=fx*(1-fy),wc=(1-fx)*fy,wd=fx*fy;
    dst[o]=src[a]*wa+src[b]*wb+src[c]*wc+src[d]*wd;dst[o+1]=src[a+1]*wa+src[b+1]*wb+src[c+1]*wc+src[d+1]*wd;
    dst[o+2]=src[a+2]*wa+src[b+2]*wb+src[c+2]*wc+src[d+2]*wd;dst[o+3]=src[a+3]*wa+src[b+3]*wb+src[c+3]*wc+src[d+3]*wd;
   }
  }
 }
 const newCanvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
 // Draws the corrected picture into a new canvas at full resolution, yielding between bands of rows.
 async function render(source,p,{onProgress}={}){
  const {data:src,width:sw,height:sh}=pixels(source);
  const out=newCanvas(p.width,p.height),oc=out.getContext('2d'),image=oc.createImageData(p.width,p.height);
  for(let v=0;v<p.height;v+=48){warpRows(src,sw,sh,p,image.data,v,Math.min(p.height,v+48));onProgress?.(v/p.height);await new Promise(resolve=>setTimeout(resolve));}
  oc.putImageData(image,0,0);onProgress?.(1);
  return out;
 }
 // Synchronous small version for the live view: `px` from pixels(source, n), corners in full-size photo pixels.
 function renderLive(px,{corners,crop,maxSide}){
  const p=plan({width:px.width,height:px.height,corners:corners.map(c=>({x:c.x*px.scale,y:c.y*px.scale})),crop,maxSide,maxPixels:maxSide*maxSide});
  const out=newCanvas(p.width,p.height),oc=out.getContext('2d'),image=oc.createImageData(p.width,p.height);
  warpRows(px.data,px.width,px.height,p,image.data,0,p.height);oc.putImageData(image,0,0);
  return out;
 }

 root.ResourcePerspective={orderQuad,usableQuad,homography,apply,largestRect,plan,pixels,render,renderLive};
})(typeof window==='undefined'?globalThis:window);
