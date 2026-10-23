/* Shared exterior report rendering. Geometry is metric; measurements are feet. */
(function(root){
'use strict';
const reportText=(value,values={})=>root.ReportUnits?.current().text(value,values)??String(value).replace(/\{(\w+)\}/g,(all,key)=>Object.hasOwn(values,key)?String(values[key]):all);
const metric=()=>!!root.ReportUnits?.current().metric;
const measure=(value,kind,legacy,withUnit=true)=>metric()?(withUnit?root.ReportUnits.current().quantity(value,kind):root.ReportUnits.current().number(value,kind)):legacy;
const unit=(kind,legacy)=>metric()?root.ReportUnits.current().unit(kind):reportText(legacy);

const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const directions=[['North',0,-1],['Northeast',Math.SQRT1_2,-Math.SQRT1_2],['East',1,0],['Southeast',Math.SQRT1_2,Math.SQRT1_2],['South',0,1],['Southwest',-Math.SQRT1_2,Math.SQRT1_2],['West',-1,0],['Northwest',-Math.SQRT1_2,-Math.SQRT1_2]].map(([name,x,y])=>({name,x,y}));
// Left/right are as seen while standing outside facing the front entrance.
const photoSlots=[['front','Front',0],['back','Back',180],['left','Left',90],['right','Right',-90],['front-right','Front Right',-45],['front-left','Front Left',45],['back-right','Back Right',-135],['back-left','Back Left',135]].map(([id,name,offset])=>({id,name,offset}));
const bearing=value=>((Number(value)||0)%360+360)%360;
const frontBearing=settings=>bearing(settings?.frontBearing);
function houseDirections(settings){return photoSlots.map(s=>{const angle=bearing(frontBearing(settings)+s.offset)*Math.PI/180;return {...s,x:Math.sin(angle),y:-Math.cos(angle)};});}
function relativeSide(normal,settings){const angle=bearing(Math.atan2(normal.x,-normal.y)*180/Math.PI),delta=a=>Math.abs(((angle-a+540)%360)-180);return houseDirections(settings).reduce((a,b)=>delta(frontBearing(settings)+a.offset)<delta(frontBearing(settings)+b.offset)?a:b).name;}
function slotFromName(value){const name=String(value||'').toLowerCase().replace(/\.(png|jpe?g|webp|avif)$/,'').replace(/[_-]+/g,' ').trim();return photoSlots.slice().sort((a,b)=>b.name.length-a.name.length).find(s=>name===s.name.toLowerCase()||name.startsWith(s.name.toLowerCase()+' '))?.id;}
function initializePhotoSlots(settings,files=[]){
 if(!settings.photoSlots){
  settings.photoSlots=Object.fromEntries(photoSlots.map((s,i)=>[s.id,{enabled:i<4,image:null}]));
  for(const item of settings.images||[]){
   let slot=slotFromName(item.slot||item.direction);const compass=directions.find(d=>d.name===item.direction);
   if(!slot&&compass&&Number.isFinite(settings.frontBearing))slot=houseDirections(settings).find(s=>s.name===relativeSide(compass,settings))?.id;
   if(slot)settings.photoSlots[slot]={enabled:item.include!==false,image:{...item},assignment:'manual'};
  }
 }
 for(const slot of photoSlots){
  settings.photoSlots[slot.id]||={enabled:false,image:null};const entry=settings.photoSlots[slot.id];
  const file=files.slice().sort((a,b)=>(a.role==='customer'?0:1)-(b.role==='customer'?0:1)).find(f=>slotFromName(f.slot||f.label)===slot.id);
  if(entry.assignment==='manual'||entry.image&&(entry.assignment!=='auto'||entry.image.role==='customer'||file?.role!=='customer'))continue;
  if(file){entry.image={key:file.key,resourceName:file.resourceName,url:file.resourceName?undefined:file.url,label:file.label,role:file.role,frame:file.frame};entry.enabled=true;entry.assignment='auto';}
 }
 return settings.photoSlots;
}
function selectedPhotos(settings){
 if(!settings?.photoSlots)return (settings?.images||[]).filter(i=>i.include!==false);
 return photoSlots.filter(s=>settings.photoSlots[s.id]?.enabled).map(s=>({...settings.photoSlots[s.id].image,slot:s.id,direction:s.name,missing:!settings.photoSlots[s.id].image||!!settings.photoSlots[s.id].image.unavailable}));
}
function photosComplete(settings){return !!settings?.photoSlots&&selectedPhotos(settings).every(s=>!s.missing);}
function planShapes(model){return (model?.roof?.length?model.roof:model?.walls||[]).filter(f=>f.points?.length>2).map(f=>f.points);}
function drawOrientationKey(doc,model,settings,rect){
 const {text}=writer(doc),ps=planShapes(model),all=ps.flat(),cx=rect.x+rect.w*.25,cy=rect.y+rect.h*.48,r=rect.h*.25;
 const minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y)),scale=r*1.6/Math.max(maxX-minX,maxY-minY,.01);
 doc.setFillColor(215,223,230);doc.setDrawColor(125,140,153);doc.setLineWidth(.2);
 for(const shape of ps){const q=shape.map(p=>({x:cx+(p.x-(minX+maxX)/2)*scale,y:cy+(p.y-(minY+maxY)/2)*scale}));doc.lines(q.slice(1).concat(q[0]).map((p,i)=>[p.x-q[i].x,p.y-q[i].y]),q[0].x,q[0].y,[1,1],'FD',true);}
 const a=frontBearing(settings)*Math.PI/180,ux=Math.sin(a),uy=-Math.cos(a);doc.setDrawColor(196,40,45);doc.setLineWidth(.7);doc.line(cx+ux*r*.65,cy+uy*r*.65,cx+ux*r*1.3,cy+uy*r*1.3);text(reportText('Front'),cx+ux*r*1.8-3,cy+uy*r*1.8+1,5.5,true,[196,40,45]);text(reportText('Back'),cx-ux*r*1.8-3,cy-uy*r*1.8+1,5.5,true);
 drawCompass(doc,rect.x+rect.w*.72,cy,r*.75);
 text(Number.isFinite(settings?.frontBearing)?reportText('Front ')+Math.round(frontBearing(settings))+reportText(' deg / North up'):reportText('Front direction not set'),rect.x+1,rect.y+rect.h,6);
}
function drawCompass(doc,cx,cy,r){
 const {text}=writer(doc);doc.setDrawColor(75,87,100);doc.setLineWidth(.25);doc.line(cx,cy-r,cx,cy+r);doc.line(cx-r,cy,cx+r,cy);doc.setFillColor(196,40,45);doc.triangle(cx,cy-r-.6,cx-1,cy-r+1.6,cx+1,cy-r+1.6,'F');
 text(reportText('N'),cx-.9,cy-r-1.6,5,true,[196,40,45]);text(reportText('S'),cx-.8,cy+r+2.4,5);text(reportText('W'),cx-r-2.6,cy+.9,5);text(reportText('E'),cx+r+.7,cy+.9,5);
}
/* Elevation pages carry a small key in the header beside the page title: the footprint, north-up,
 with the side this elevation looks at marked by a bar (the viewing plane) and an arrow toward the
 house, and a small compass. */
function drawElevationKey(doc,model,settings,rect,view,colors){
 const {text,accent}=writer(doc,colors),ps=planShapes(model),all=ps.flat();if(!all.length)return;
 const size=rect.h,cx=rect.x+size/2,cy=rect.y+size/2,minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y)),scale=size*.42/Math.max(maxX-minX,maxY-minY,.01);
 const len=Math.hypot(view.x,view.y)||1,vx=view.x/len,vy=view.y/len,px=-vy,py=vx,map=p=>({x:cx+(p.x-(minX+maxX)/2)*scale,y:cy+(p.y-(minY+maxY)/2)*scale}),pts=all.map(map);
 doc.setFillColor(215,223,230);doc.setDrawColor(125,140,153);doc.setLineWidth(.15);
 for(const shape of ps){const q=shape.map(map);doc.lines(q.slice(1).concat(q[0]).map((p,i)=>[p.x-q[i].x,p.y-q[i].y]),q[0].x,q[0].y,[1,1],'FD',true);}
 const along=pts.map(p=>(p.x-cx)*vx+(p.y-cy)*vy),across=pts.map(p=>(p.x-cx)*px+(p.y-cy)*py),reach=Math.max(...along)+1.4,lo=Math.min(...across)-1,hi=Math.max(...across)+1;
 doc.setDrawColor(accent.r,accent.g,accent.b);doc.setLineWidth(.8);doc.line(cx+vx*reach+px*lo,cy+vy*reach+py*lo,cx+vx*reach+px*hi,cy+vy*reach+py*hi);
 const tail=reach+4.2,tip=reach+.9,mid=(lo+hi)/2,ax=cx+px*mid,ay=cy+py*mid;doc.setLineWidth(.45);doc.line(ax+vx*tail,ay+vy*tail,ax+vx*(tip+1.4),ay+vy*(tip+1.4));doc.setFillColor(accent.r,accent.g,accent.b);
 doc.triangle(ax+vx*tip,ay+vy*tip,ax+vx*(tip+1.8)+px*1.1,ay+vy*(tip+1.8)+py*1.1,ax+vx*(tip+1.8)-px*1.1,ay+vy*(tip+1.8)-py*1.1,'F');
 drawCompass(doc,rect.x+rect.w-5,cy,3.6);
 if(!Number.isFinite(settings?.frontBearing))text(reportText('Front not set'),rect.x+size+1,rect.y+rect.h-.5,4.5,false,[150,150,150]);
}
const number=v=>v>0&&v<.05?'<0.1':Number(v||0).toLocaleString(root.ReportUnits?.current().language||'en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const isTrim=a=>a.trim||/^trim-/.test(a.materialKey||'')||/\btrim\b/i.test(a.material||'');
const centroid=ps=>ps.reduce((a,p)=>({x:a.x+p.x/ps.length,y:a.y+p.y/ps.length,z:a.z+(p.z||0)/ps.length}),{x:0,y:0,z:0});

// Rows occupy sixths of a page. Optimize across pages to avoid stranded faces.
// Portrait: a row of three small faces takes a third of the page (three such rows per page). Landscape
// pages are wide and short, so every row takes half the page: at most two rows, the same columns.
function dimensionPages(faces,{landscape=false}={}){
 const ordered=faces.slice().sort((a,b)=>b.gross-a.gross||a.id.localeCompare(b.id)),max=Math.max(0,...ordered.map(a=>a.gross));
 const columns=a=>a.gross>=Math.max(80,max*.55)?1:a.gross>=Math.max(30,max*.18)?2:3,memo=new Map();
 function solve(start){
  if(start===ordered.length)return {score:0,pages:[]};if(memo.has(start))return memo.get(start);
  let best={score:Infinity,pages:[]};
  function extend(at,rows,used,penalty){
   if(rows.length){const tail=solve(at),score=100+(6-used)*.2+penalty+tail.score;if(score<best.score)best={score,pages:[rows,...tail.pages]};}
   if(at>=ordered.length)return;const cols=columns(ordered[at]),units=cols===3&&!landscape?2:3;if(used+units>6)return;
   for(let count=1;count<=Math.min(cols,ordered.length-at);count++)extend(at+count,[...rows,{faces:ordered.slice(at,at+count),units}],used+units,penalty+(cols-count)*.5);
  }
  extend(start,[],0,0);memo.set(start,best);return best;
 }
 return solve(0).pages.map(rows=>{const extra=6-rows.reduce((s,r)=>s+r.units,0);let y=0;return rows.flatMap((row,i)=>{const height=(row.units+(i===0?extra:0))/6,panels=row.faces.map((face,j)=>({face,x:j/row.faces.length,y,w:1/row.faces.length,h:height}));y+=height;return panels;});});
}
function mesh(face){
 if(face.curvedSurface?.logical)return K.surfaceMesh(face,.002);
 const frame=K.frame(face);if(!frame)return {positions:[],triangles:[]};
 const tri=K.triangles(face.points.map(p=>K.local(frame,p)),(face.holes||[]).map(r=>r.map(p=>K.local(frame,p))));
 return {positions:tri.points.map(p=>K.world(frame,p)),triangles:tri.triangles};
}
// Diagrams print light faces with dark edges on white. The finish color is only a tint, so a dark
// siding color still reads as a light face; shading by how squarely a face meets the viewer keeps
// adjacent planes apart. Muted faces (counted on another elevation) are paler still.
function surfaceColor(face,camera,muted=false){
 const hex=/^#?([0-9a-f]{6})$/i.exec(face.finishColor||'');
 let color=hex?[0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16)):face.surface==='roof'?[193,204,215]:face.chimney?[213,197,192]:/brick/i.test(face.material)?[219,185,174]:/stone|masonry/i.test(face.material)?[210,204,192]:/stucco/i.test(face.material)?[230,219,190]:isTrim(face)?[233,229,217]:[210,226,238];
 if(face.featureType)color=/door|garage/i.test(face.featureType)?[225,198,155]:/vent/i.test(face.featureType)?[181,210,181]:[150,194,212];
 const n=face.normal||K.normal(face.points),len=n?Math.hypot(n.x,n.y,n.z||0)||1:1,facing=n&&camera?Math.abs(n.x*camera.x+n.y*camera.y+(n.z||0)*camera.z)/len:1;
 const tint=muted?.1:face.featureType?.55:face.surface==='roof'?.34:.42,shade=muted?.98+.02*facing:.84+.16*facing;
 return color.map(v=>Math.round(Math.min(246,255-(255-v)*tint)*shade));
}
const EDGE=[34,41,49,255],BACKGROUND=255,CONTEXT_FACE=[243,244,246],CONTEXT_EDGE=[203,207,212,255];
// Colors, edges and dividers come from the owner buffer, so a scene can be repainted
// (for example to mute faces counted elsewhere) without rasterizing it again.
function paintScene(scene,muted=null){
 const {width,height,owners,surfaces,camera,at}=scene,pixels=scene.pixels,dim=scene.dim,colors=surfaces.map((face,id)=>dim?.[id]?CONTEXT_FACE:surfaceColor(face,camera,!!muted&&!!face.id&&!face.featureType&&muted(face)));
 for(let index=0;index<width*height;index++){const id=owners[index],n=index*4;if(id<0){pixels[n]=pixels[n+1]=pixels[n+2]=BACKGROUND;}else{const c=colors[id];pixels[n]=c[0];pixels[n+1]=c[1];pixels[n+2]=c[2];}pixels[n+3]=255;}
 // Two-pixel edges wherever the visible surface changes, including the silhouette. In a context
 // render, edges between context surfaces (or context and background) are light; any edge of the
 // measured face stays dark and wins.
 const dark=dim?new Uint8Array(width*height):null,faint=id=>id<0||dim[id],edge=(i,j)=>{if(!dim||!faint(owners[i])||!faint(owners[j])){pixels.set(EDGE,i*4);pixels.set(EDGE,j*4);if(dark)dark[i]=dark[j]=1;}else{if(!dark[i])pixels.set(CONTEXT_EDGE,i*4);if(!dark[j])pixels.set(CONTEXT_EDGE,j*4);}};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const index=y*width+x,id=owners[index];
  if(x+1<width&&owners[index+1]!==id)edge(index,index+1);
  if(y+1<height&&owners[index+width]!==id)edge(index,index+width);
 }
 // Draw grouped opening divisions after depth resolution. Dashes remain
 // visible on the opening, but never bleed through a closer wall or roof.
 surfaces.forEach((face,id)=>{if(dim?.[id])return;for(const pair of face.dividers||[]){const [a,b]=pair.map(at),length=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.ceil(length*2);for(let i=0;i<=steps;i++){if(Math.floor(i/2/6)%2)continue;const t=steps?i/steps:0,x=Math.round(a.x+(b.x-a.x)*t),y=Math.round(a.y+(b.y-a.y)*t);if(x<0||x>=width||y<0||y>=height)continue;const index=y*width+x;if(owners[index]===id)pixels.set([72,85,97,255],index*4);}}});
 return scene;
}
/* PDF-only depth bias, like polygon offset. A wall top drawn in (or a few centimetres through) the
 roof plane would win the depth test along soffit lines and print as a dotted line on the roof. The
 roof and roof trim win any depth comparison with a non-roof surface within ROOF_DEPTH_BIAS metres
 plus ROOF_SLOPE_PX pixels of their own depth slope (capped), so those wall tops stay under the
 roof. Roof against roof compares exact depths, so overlapping roof layers never fight. The editor keeps the
 exact geometry. Depth z is metres toward the viewer; x and y are pixels. */
const ROOF_DEPTH_BIAS=.04,ROOF_SLOPE_PX=1.5,ROOF_SLOPE_CAP=.3;
function roofDepthBias(a,b,c,den){
 const gx=((b.y-c.y)*(a.z-c.z)+(c.y-a.y)*(b.z-c.z))/den,gy=((c.x-b.x)*(a.z-c.z)+(a.x-c.x)*(b.z-c.z))/den;
 return ROOF_DEPTH_BIAS+Math.min(ROOF_SLOPE_CAP,ROOF_SLOPE_PX*Math.max(Math.abs(gx),Math.abs(gy)));
}
// Resolve depth at each pixel, including holes, openings and curved triangles.
// A single average depth per wall cannot resolve intersecting/overlapping faces.
/* `focus` (a count) makes a context render: the first `focus` faces are framed and drawn as usual;
 the faces after them are a dimmed context, kept only behind the focus faces' frontmost depth (so
 nothing between the camera and the measured face can hide it) and clipped to the frame. */
function rasterScene(faces,view,width,height,iso=false,pad=30,{focus=null}={}){
 const angle=iso?35*Math.PI/180:0,len=Math.hypot(view.x,view.y),nx=view.x/len,ny=view.y/len,camera={x:nx*Math.cos(angle),y:ny*Math.cos(angle),z:Math.sin(angle)};
 const project=p=>({x:p.x*ny-p.y*nx,y:-p.z*Math.cos(angle)+(p.x*nx+p.y*ny)*Math.sin(angle),z:(p.x*nx+p.y*ny)*Math.cos(angle)+p.z*Math.sin(angle)});
 const parents=[],surfaces=faces.flatMap((face,i)=>{const list=[face,...(face.openings||[]).map(o=>({...o,featureType:o.type,normal:face.normal})),...(face.openings||[]).flatMap(o=>(o.trimFaces||[]).map(t=>({...t,id:'',normal:face.normal,openingTrim:true})))];for(const s of list)parents.push(i);return list;}),meshes=surfaces.map(mesh);
 const pixels=new Uint8ClampedArray(width*height*4),depth=new Float64Array(width*height).fill(-Infinity),owners=new Int32Array(width*height).fill(-1),dim=surfaces.map((s,i)=>focus!=null&&parents[i]>=focus);
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,front=-Infinity;
 for(const [i,m]of meshes.entries()){if(dim[i])continue;for(const p of m.positions){const q=project(p);minX=Math.min(minX,q.x);maxX=Math.max(maxX,q.x);minY=Math.min(minY,q.y);maxY=Math.max(maxY,q.y);front=Math.max(front,q.z);}}
 const clip=front+1e-3,FOCUS_BIAS=1,roofOwner=new Uint8Array(width*height),roofBias=new Float32Array(width*height);
 if(!Number.isFinite(minX)){minX=minY=0;maxX=maxY=1;}
 const scale=Math.min((width-2*pad)/Math.max(maxX-minX,.01),(height-2*pad)/Math.max(maxY-minY,.01));
 const at=p=>{const q=project(p);return {x:width/2+(q.x-(minX+maxX)/2)*scale,y:height/2+(q.y-(minY+maxY)/2)*scale,z:q.z};};
 surfaces.forEach((face,id)=>{
  const m=meshes[id],ps=m.positions.map(at),roofish=face.surface==='roof'||!!face.roofTrim,context=dim[id],lift=focus!=null&&!context?FOCUS_BIAS:0,bias=roofish?0:lift+(face.openingTrim?2e-4:face.featureType?1e-4:0);
  for(const tri of m.triangles){
   const [a,b,c]=tri.map(i=>ps[i]),den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(den)<1e-8)continue;
   // The roof bias applies only against non-roof surfaces; roof against roof compares exact depths.
   const rb=roofish?roofDepthBias(a,b,c,den):0;
   const x0=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x))),x1=Math.min(width-1,Math.ceil(Math.max(a.x,b.x,c.x))),y0=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y))),y1=Math.min(height-1,Math.ceil(Math.max(a.y,b.y,c.y)));
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const u=((b.y-c.y)*(x+.5-c.x)+(c.x-b.x)*(y+.5-c.y))/den,v=((c.y-a.y)*(x+.5-c.x)+(a.x-c.x)*(y+.5-c.y))/den;
    if(u< -1e-9||v< -1e-9||u+v>1+1e-9)continue;
    const raw=u*a.z+v*b.z+(1-u-v)*c.z;if(context&&raw>clip)continue;
    const z=raw+bias,index=y*width+x,other=owners[index]<0?roofish:roofOwner[index]===1;
    if(roofish===other?z>depth[index]+1e-8:roofish?z+rb>depth[index]+1e-8:z>depth[index]+roofBias[index]+1e-8){depth[index]=z;owners[index]=id;roofOwner[index]=roofish?1:0;roofBias[index]=rb;}
   }
  }
 });
 const counts=new Array(surfaces.length).fill(0),sums=surfaces.map(()=>({x:0,y:0})),bounds=surfaces.map(()=>({x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity}));
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const index=y*width+x,id=owners[index];if(id<0)continue;counts[id]++;sums[id].x+=x;sums[id].y+=y;const b=bounds[id];if(x<b.x0)b.x0=x;if(x>b.x1)b.x1=x;if(y<b.y0)b.y0=y;if(y>b.y1)b.y1=y;
 }
 const labels=surfaces.map((face,id)=>({face,count:counts[id],point:null,distance:Infinity}));
 for(let y=8;y<height-8;y+=4)for(let x=12;x<width-12;x+=4){
  const id=owners[y*width+x];if(id<0||!surfaces[id].id)continue;
  if(![-10,0,10].every(dx=>[-6,0,6].every(dy=>owners[(y+dy)*width+x+dx]===id)))continue;
  const d=(x-sums[id].x/counts[id])**2+(y-sums[id].y/counts[id])**2;
  if(d<labels[id].distance){labels[id].point={x,y};labels[id].distance=d;}
 }
 return paintScene({width,height,pixels,depth,owners,surfaces,counts,sums,bounds,labels,at,scale,camera,dim:focus!=null?dim:null});
}
const isLandscape=doc=>doc.internal.pageSize.getWidth()>doc.internal.pageSize.getHeight();
// Landscape elevations put the drawing on the left and a side panel on the right only as wide as its
// table needs (writer sideWidth), between SIDE_MIN and SIDE_MAX of the content width. The drawing is
// inset DRAWING_INSET mm from the content edge and SIDE_GAP mm from the panel.
const SIDE_MIN=.24,SIDE_MAX=.34,SIDE_GAP=8,DRAWING_INSET=5;
// pdf.js drawReportTemplate puts the footer address baseline 16 mm above the page bottom (8 pt, about
// 2.2 mm tall). A single-page portrait elevation ends its tables as far above the address as the
// address is above the page edge, so the page feels even.
const FOOTER_BASELINE=16,FOOTER_TEXT=2.2;
const evenBottom=doc=>doc.internal.pageSize.getHeight()-FOOTER_BASELINE-FOOTER_TEXT-FOOTER_BASELINE;
function writer(doc,colors){
 const x=25,w=doc.internal.pageSize.getWidth()-40,bottom=doc.internal.pageSize.getHeight()-22,accent=colors?.primary||{r:200,g:40,b:40};
 const text=(value,px,py,size=9,bold=false,color=[44,51,60])=>{doc.setFont('Montserrat',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(...color);doc.text(Array.isArray(value)?value:String(value),px,py);};
 const note=(value,y,width=w,px=x)=>{doc.setFont('Montserrat','normal');doc.setFontSize(8);const lines=doc.splitTextToSize(String(value),width);text(lines,px,y,8);return y+lines.length*4;};
 // A page's fine print at the bottom, just above the footer address, styled like the note under the
 // roof ventilation page (pdf.js drawVentilationPage): 6 pt grey, full width, its last line 7 mm
 // above the footer address as that note's is. Returns the top of the note.
 const footnote=value=>{const H=doc.internal.pageSize.getHeight(),lineH=6*1.15*.352778;doc.setFont('Montserrat','normal');doc.setFontSize(6);const lines=doc.splitTextToSize(String(value),w),y=H-FOOTER_BASELINE-7-(lines.length-1)*lineH;text(lines,x,y,6,false,[90,90,90]);return y-2.2;};
 // Every exterior table is a full-width boxed table (boxTable below) with the same columns and values;
 // columns whose values are all numbers are right-aligned. `rowsFit(y)` is how many rows fit from y down.
 const table=(headers,rows,y,widths)=>boxTable(headers.map(h=>reportText(h)),rows,x,y,w,widths,numericColumns(headers,rows));
 const paginate=(begin,heading,headers,rows,widths,description)=>{let index=0;do{begin(reportText(heading)+(index?reportText(' - continued'):''));let y=38;if(description)y=note(description,y)+5;const count=rowsFit(y);if(rows.length)table(headers,rows.slice(index,index+count),y,widths);else note(reportText('No modeled openings are present in this snapshot.'),y+12);index+=count;}while(index<rows.length);};
 /* Boxed tables in the roof pages' style (drawSummaryBox in pdf.js): a white rounded box with a
  shadow and the accent bar on its left, bold headers over a rule, plain rows. */
 const panel=(bx,by,bw,bh)=>{doc.setFillColor(230,230,230);doc.roundedRect(bx+1.5,by+1.5,bw,bh,3,3,'F');doc.setFillColor(255,255,255);doc.setDrawColor(220,220,220);doc.setLineWidth(.3);doc.roundedRect(bx,by,bw,bh,3,3,'FD');
  const r=3,bar=2,k=r*.55228;doc.setFillColor(accent.r,accent.g,accent.b);doc.lines([[r-bar,0],[-k,0,-r,r-k,-r,r],[0,bh-r*2],[0,k,r-k,r,r,r],[-(r-bar),0],[0,-bh]],bx+bar,by,[1,1],'F',false);};
 const fit=(value,width,size,bold=false)=>{let str=String(value);doc.setFont('Montserrat',bold?'bold':'normal');doc.setFontSize(size);while(doc.getTextWidth(str)>width&&str.length>1)str=str.slice(0,-2)+'~';return str;};
 const cell=(value,px,py,width,right,size=8,bold=false)=>{const str=fit(value,width,size,bold);doc.setFont('Montserrat',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(...(bold?[44,51,60]:[60,66,74]));right?doc.text(str,px+width,py,{align:'right'}):doc.text(str,px,py);};
 const ROW=5.5,HEAD=12.5,FOOT=2.5,boxHeight=n=>HEAD+n*ROW+FOOT,rowsFit=y=>Math.max(1,Math.floor((bottom-y-HEAD-FOOT)/ROW));
 const numericColumns=(headers,rows)=>headers.map((h,i)=>i>0&&rows.length>0&&rows.every(r=>/^(-|<?[\d.,]+( x [\d.,]+)?( ?(sq ft|ft|m²|m))?)$/.test(String((r.cells||r)[i]).trim())));
 // `right` says which columns are right-aligned (default: columns 2+). A row {span:true,cells} spans its first two columns.
 // `rowH` (default ROW) lets a side panel tighten its rows; below 5.2 mm the row text is 7.5 pt.
 const boxTable=(headers,rows,bx,by,bw,widths,right=headers.map((h,i)=>i>1),rowH=ROW)=>{
  const inner=bw-10,weights=widths||headers.map(()=>1),cols=weights.map(v=>v/weights.reduce((a,b)=>a+b,0)*inner),left=cols.map((c,i)=>bx+6+cols.slice(0,i).reduce((a,b)=>a+b,0)),bh=HEAD+rows.length*rowH+FOOT,size=rowH<5.2?7.5:8;panel(bx,by,bw,bh);
  headers.forEach((h,i)=>{let size=7.5;doc.setFont('Montserrat','bold');while(size>5.5&&(doc.setFontSize(size),doc.getTextWidth(h)>cols[i]-1.5))size-=.5;cell(h,left[i]+(right[i]?1.5:0),by+7,cols[i]-1.5,right[i],size,true);});
  doc.setDrawColor(200,205,212);doc.setLineWidth(.25);doc.line(bx+6,by+9,bx+bw-4,by+9);
  rows.forEach((row,r)=>{const cells=row.cells||row,py=by+HEAD+r*rowH+1.5;cells.forEach((v,i)=>{if(row.span&&i===1)return;const width=row.span&&i===0?cols[0]+cols[1]-1.5:cols[i]-1.5;cell(v,left[i]+(right[i]?1.5:0),py,width,right[i],size);});});
  return by+bh;
 };
 // Two side-by-side boxes: rows fill the left box, then the right (split evenly on the last page),
 // and the totals box spans both columns under them. `more()` starts a continuation page.
 // Without a `total` there is no totals box. `right` passes column alignment through to boxTable.
 const columns=(headers,rows,y,widths,total,more,right)=>{
  const gap=5,cw=(w-gap)/2,totalH=total?10:-4;let index=0;
  for(;;){const capacity=Math.max(1,Math.floor((bottom-y-totalH-4-HEAD-FOOT)/ROW)),rest=rows.length-index,last=rest<=2*capacity,leftCount=last?Math.ceil(rest/2):capacity,rightCount=last?rest-leftCount:capacity;
   const a=rows.slice(index,index+leftCount),b=rows.slice(index+leftCount,index+leftCount+rightCount);let end=boxTable(headers,a,x,y,cw,widths,right);if(b.length)end=Math.max(end,boxTable(headers,b,x+cw+gap,y,cw,widths,right));index+=a.length+b.length;
   if(index>=rows.length&&!total)return end;
   if(index>=rows.length)return totalBox(total,x,end+4,w);
   y=more();
  }
 };
 // The totals box: one line across a wide box; in a narrow box (a landscape side panel) the label
 // and then each figure on its own line, right-aligned. Returns the box's bottom.
 const TOTAL_LINE=4.5,totalLines=(total,tw)=>tw>=140?1:total.length,totalHeight=(total,tw)=>totalLines(total,tw)===1?10:3.8+total.length*TOTAL_LINE;
 const totalBox=(total,tx,ty,tw)=>{const th=totalHeight(total,tw);panel(tx,ty,tw,th);
  if(totalLines(total,tw)===1){cell(total[0],tx+6,ty+6.5,40,false,8.5,true);const parts=total.slice(1);let px=tx+tw-4;for(let i=parts.length-1;i>=0;i--){const str=String(parts[i]);doc.setFont('Montserrat',i===parts.length-1?'bold':'normal');doc.setFontSize(8);const sw=doc.getTextWidth(str);cell(str,px-sw,ty+6.5,sw+.5,false,8,i===parts.length-1);px-=sw+6;}}
  else total.forEach((str,i)=>cell(str,tx+6,ty+5.8+i*TOTAL_LINE,tw-10,i>0,i===0?8.5:8,i===0||i===total.length-1));
  return ty+th;};
 // A single boxed table in a side panel (landscape elevations): as many rows as fit above its totals
 // box; any rest continues on `more()` pages in two columns. Returns the bottom of what it drew last.
 // Rows tighten to SIDE_MIN_ROW mm before the table continues on another page, and open up to
 // SIDE_MAX_ROW when there is room. A table that fits is centred in the height from y to the bottom,
 // beside the drawing (which is centred in the same height), rather than hanging from the top.
 const SIDE_MIN_ROW=4.3,SIDE_MAX_ROW=5.6;
 const sideTable=(headers,rows,px,y,pw,widths,total,more)=>{
  const room=bottom-y-totalHeight(total,pw)-4-HEAD-FOOT,rowH=Math.min(SIDE_MAX_ROW,room/Math.max(1,rows.length));
  if(rowH>=SIDE_MIN_ROW){const block=HEAD+rows.length*rowH+FOOT+4+totalHeight(total,pw),top=y+Math.max(0,(bottom-y-block)/2);return totalBox(total,px,boxTable(headers,rows,px,top,pw,widths,undefined,rowH)+4,pw);}
  const first=Math.min(rows.length-1,Math.max(1,Math.floor((bottom-y-HEAD-FOOT)/SIDE_MIN_ROW)));boxTable(headers,rows.slice(0,first),px,y,pw,widths,undefined,SIDE_MIN_ROW);
  return columns(headers,rows.slice(first),more(),widths,total,more);
 };
 // The side panel's width and its column widths (mm, for boxTable) from what the table holds: each
 // column as wide as its header and its widest cell plus a small gap, a spanning row across the first two
 // columns, and every line of the narrow totals box. The panel is clamped to [min, max] mm; spare width
 // goes to the second (text) column, and a text column wider than SIDE_TEXT_MAX mm is cut with "~".
 const SIDE_TEXT_MAX=40,COLUMN_GAP=3.5;
 const sideWidth=(headers,rows,total,min,max)=>{
  const wide=(v,size,bold)=>{doc.setFont('Montserrat',bold?'bold':'normal');doc.setFontSize(size);return doc.getTextWidth(String(v));};
  const cols=headers.map((h,i)=>Math.max(wide(h,7.5,true),...rows.filter(r=>!(r.span&&i<2)).map(r=>wide((r.cells||r)[i],8,false)))+COLUMN_GAP);
  if(cols.length>1)cols[1]=Math.min(cols[1],SIDE_TEXT_MAX);
  const span=Math.max(0,...rows.filter(r=>r.span).map(r=>wide(r.cells[0],8,false)+1.5));if(span>cols[0]+cols[1])cols[1]=span-cols[0];
  const totals=total?Math.max(...total.map((t,i)=>wide(t,i===0?8.5:8,i===0||i===total.length-1))):0;
  const pw=Math.min(max,Math.max(min,cols.reduce((a,b)=>a+b,0)+10,totals+10)),spare=pw-10-cols.reduce((a,b)=>a+b,0);
  if(spare>0)cols[Math.min(1,cols.length-1)]+=spare;else cols.forEach((c,i)=>cols[i]=c*(pw-10)/(pw-10-spare));
  return {pw,widths:cols};
 };
 // A narrow table (at most three columns) longer than LONG_TABLE rows reads better as two columns.
 // Otherwise one full-width box per page. Either way `more()` starts a continuation page and returns its top.
 const autoTable=(headers,rows,y,widths,more)=>{headers=headers.map(h=>reportText(h));const right=numericColumns(headers,rows);if(headers.length<=3&&rows.length>LONG_TABLE)return columns(headers,rows,y,widths,null,more,right);
  let end=y;for(let i=0;i<rows.length;){const count=rowsFit(y);end=boxTable(headers,rows.slice(i,i+count),x,y,w,widths,right);i+=count;if(i<rows.length)y=more();}return end;};
 return {x,w,bottom,accent,text,note,footnote,table,paginate,panel,fit,boxTable,columns,autoTable,rowsFit,boxHeight,totalHeight,totalBox,sideTable,sideWidth,numericColumns};
}
const DENSITY=8,LONG_TABLE=10;
// Room under a wall dimension drawing for its size and material lines.
const DIMENSION_TEXT=8;
// Label placement. With `ids`, every listed face gets a label: inside the face when it fits
// (full size, then smaller), otherwise beside it with a leader line to a visible point of the
// face. Labels never overlap each other. Without `ids` (overview diagrams), faces large
// enough for an inside label are labeled and the rest are left to the elevation pages.
function placeLabels(doc,scene,rect,ids=null){
 const {width,height,owners,counts,sums,bounds,surfaces}=scene,density=DENSITY,boxes=[],placed=[],mm=(x,y)=>({x:rect.x+x/density,y:rect.y+y/density});
 const targets=surfaces.map((face,id)=>({face,id})).filter(({face,id})=>face.id&&counts[id]>0&&(ids?ids.has(face.id)&&!face.featureType:counts[id]>=150)).sort((a,b)=>counts[b.id]-counts[a.id]);
 const measureBox=(label,size)=>{doc.setFont('Montserrat','bold');doc.setFontSize(size);return {w:(doc.getTextWidth(label)+1.4)*density,h:3.3*size/7*density};};
 const box=(cx,cy,{w,h})=>({x0:Math.round(cx-w/2),y0:Math.round(cy-h/2),x1:Math.round(cx+w/2),y1:Math.round(cy+h/2)});
 const inImage=b=>b.x0>=1&&b.y0>=1&&b.x1<width-1&&b.y1<height-1,clear=(b,gap=density*.6)=>boxes.every(q=>b.x1+gap<q.x0||q.x1+gap<b.x0||b.y1+gap<q.y0||q.y1+gap<b.y0);
 const inside=(b,id)=>{if(!inImage(b))return false;for(let y=b.y0;y<=b.y1;y+=2)for(let x=b.x0;x<=b.x1;x+=2)if(owners[y*width+x]!==id)return false;return owners[b.y1*width+b.x1]===id&&owners[b.y1*width+b.x0]===id&&owners[b.y0*width+b.x1]===id;};
 const draw=(face,b,size,leader)=>{const p=mm(b.x0,b.y0),w=(b.x1-b.x0)/density,h=(b.y1-b.y0)/density;doc.setFillColor(255,255,255);if(leader){doc.setDrawColor(...EDGE.slice(0,3));doc.setLineWidth(.15);doc.roundedRect(p.x,p.y,w,h,.5,.5,'FD');}else doc.roundedRect(p.x,p.y,w,h,.5,.5,'F');
  doc.setFont('Montserrat','bold');doc.setFontSize(size);doc.setTextColor(...EDGE.slice(0,3));doc.text(face.id,p.x+.7,p.y+h*.7);boxes.push(b);placed.push({id:face.id,box:b,size,leader:!!leader});};
 const pending=[];
 for(const target of targets){
  const {face,id}=target,b=bounds[id],cx=sums[id].x/counts[id],cy=sums[id].y/counts[id],step=Math.max(2,density>>1),candidates=[];
  for(let y=b.y0;y<=b.y1;y+=step)for(let x=b.x0;x<=b.x1;x+=step)if(owners[y*width+x]===id)candidates.push({x,y,d:(x-cx)**2+(y-cy)**2});
  candidates.sort((p,q)=>p.d-q.d);target.anchor=candidates[0]||{x:Math.round(cx),y:Math.round(cy)};
  if(!candidates.length)for(let y=b.y0;y<=b.y1;y++)for(let x=b.x0;x<=b.x1;x++)if(owners[y*width+x]===id){const d=(x-cx)**2+(y-cy)**2;if(target.anchor.d==null||d<target.anchor.d)target.anchor={x,y,d};}
  let done=false;
  for(const size of face.featureType?[5.5]:ids?[7,5.5,4.5]:[7]){const dims=measureBox(face.id,size);for(const c of candidates){const r=box(c.x,c.y,dims);if(inside(r,id)&&clear(r)){draw(face,r,size,false);done=true;break;}}if(done)break;}
  if(!done&&ids)pending.push(target);
 }
 const sample=(b,fn)=>{let n=0;for(let y=Math.max(0,b.y0);y<=Math.min(height-1,b.y1);y+=4)for(let x=Math.max(0,b.x0);x<=Math.min(width-1,b.x1);x+=4)n+=fn(owners[y*width+x]);return n;};
 const labeled=new Set(targets.map(t=>t.id));
 for(const {face,id,anchor}of pending){
  const size=5.5,dims=measureBox(face.id,size);let best=null;
  for(const relaxed of [false,true]){
   for(const radius of [5,7,9,12,15,19,24,30,38,48,60,75]){
    for(let k=0;k<24;k++){const angle=-Math.PI/2+k*Math.PI/12,cx=anchor.x+Math.cos(angle)*radius*density,cy=anchor.y+Math.sin(angle)*radius*density,r=box(cx,cy,dims);
     if(!inImage(r)||!relaxed&&!clear(r))continue;
     const covers=sample(r,o=>o===id?6:labeled.has(o)?3:o>=0?1:0),overlap=relaxed?boxes.filter(q=>!(r.x1<q.x0||q.x1<r.x0||r.y1<q.y0||q.y1<r.y0)).length*100:0,score=radius+covers*.4+overlap;
     if(!best||score<best.score)best={score,r};}
    if(best&&best.score<radius+8)break;
   }
   if(best)break;
  }
  const r=best?.r||box(anchor.x,anchor.y,dims),a=mm(anchor.x,anchor.y),q=mm(Math.max(r.x0,Math.min(anchor.x,r.x1)),Math.max(r.y0,Math.min(anchor.y,r.y1)));
  doc.setDrawColor(...EDGE.slice(0,3));doc.setLineWidth(.2);doc.line(a.x,a.y,q.x,q.y);doc.setFillColor(...EDGE.slice(0,3));doc.circle(a.x,a.y,.5,'F');draw(face,r,size,true);
 }
 return placed;
}
// `context` faces are drawn dimmed behind `faces` (see rasterScene `focus`), never measured or labeled.
function drawDiagram(doc,faces,rect,view,{dimensions=false,iso=false,labels=true,labelIds=null,scene:given=null,context=null}={}){
 const density=DENSITY,width=Math.ceil(rect.w*density),height=Math.ceil(rect.h*density),scene=given||(context?.length?rasterScene([...faces,...context],view,width,height,iso,(dimensions?9:5)*density,{focus:faces.length}):rasterScene(faces,view,width,height,iso,(dimensions?9:5)*density));
 if(root.document){const canvas=root.document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),data=ctx.createImageData(width,height);data.data.set(scene.pixels);ctx.putImageData(data,0,0);doc.addImage(canvas.toDataURL('image/png'),'PNG',rect.x,rect.y,rect.w,rect.h,undefined,'FAST');}
 const {text}=writer(doc),at=p=>{const q=scene.at(p);return {x:rect.x+q.x/density,y:rect.y+q.y/density};};
 scene.placed=labels&&!dimensions?placeLabels(doc,scene,rect,labelIds):[];
 if(dimensions)for(const face of faces){const ps=face.points.map(at),c=centroid(ps);for(let i=0;i<ps.length;i++){
  const p=ps[i],q=ps[(i+1)%ps.length];if(Math.hypot(q.x-p.x,q.y-p.y)<12)continue;
  const feet=Math.hypot(...['x','y','z'].map(k=>face.points[i][k]-face.points[(i+1)%ps.length][k]))/.3048,label=measure(feet,"ft",number(feet)+"'"),mx=(p.x+q.x)/2,my=(p.y+q.y)/2,horizontal=Math.abs(q.x-p.x)>Math.abs(q.y-p.y);doc.setFontSize(6.5);const tw=doc.getTextWidth(label);text(reportText(label),mx+(horizontal?-tw/2:mx>c.x?2:-tw-2),my+(horizontal?(my>c.y?3.5:-2):1),6.5);
 }}
 return scene;
}
// Everything the editor shows of the house: walls, returns, chimney tops, roof trim and the roof.
// Only walls carry ids; the rest is drawn but never labeled or counted.
const roofTrimFaces=model=>(model.roofTrim||[]).map(f=>({...f,id:'',roofTrim:true,trim:true,openings:[]}));
const houseFaces=model=>[...model.walls,...(model.returns||[]).map(f=>({...f,id:'',openings:[]})),...(model.caps||[]).map(f=>({...f,id:'',chimney:true,openings:[]})),...roofTrimFaces(model),...(model.roof||[]).map(f=>({...f,id:'',surface:'roof',openings:[]}))];
// The cover and summary views look down at the house from the configured front: the same front as
// the Front elevation and the orientation key, never a direction derived from the geometry.
function coverView(settings){const {x,y}=houseDirections(settings)[0];return {x,y};}
function drawExteriorCover(doc,model,rect,settings={}){const box={...rect,h:rect.h-28},cover=model.coverRender;/* Textured render captured with the snapshot (exterior_cover.js); first cover page only, and only for the front it was rendered from. */if(cover?.image&&cover.width>0&&cover.height>0&&Math.abs(bearing(cover.bearing)-frontBearing(settings))<.01){const s=Math.min(box.w/cover.width,box.h/cover.height),w=cover.width*s,h=cover.height*s;doc.addImage(cover.image,'JPEG',box.x+(box.w-w)/2,box.y+(box.h-h)/2,w,h);}else drawDiagram(doc,houseFaces(model),box,coverView(settings),{iso:true,labels:false});drawOrientationKey(doc,model,settings,{x:rect.x+rect.w/2-28,y:rect.y+rect.h-27,w:56,h:24});}
function drawRoofElevations(doc,model,settings,begin,colors){
 const {x,w,bottom,text}=writer(doc,colors),gap=6,ww=(w-gap)/2,hh=(bottom-37-gap)/2;begin(reportText('Roof Elevations'));
 houseDirections(settings).slice(4).forEach((view,i)=>{const xx=x+i%2*(ww+gap),yy=37+Math.floor(i/2)*(hh+gap);text(reportText(view.name),xx+2,yy+5,10,true);drawDiagram(doc,[...roofTrimFaces(model),...(model.roof||[]).map(f=>({...f,surface:'roof',id:''}))],{x:xx,y:yy+10,w:ww,h:hh-12},view,{iso:true,labels:false});});
}
/* The one-page Exterior Summary: the full report opens its exterior pages with it, and a full-house customer Summary.pdf carries only it. */
/* Header stats: one compact card per figure in the report's header-stat style (the left accent bar card
 of the roof Ventilation Summary and the Layer Details boxes), the label as a card title and the figure
 under it. Every card has the same width and height and every title and figure the same type size (the
 largest that fits the longest), so the cells read as one strip. `perRow` cards to a row; a short last
 row keeps the same cell width, aligned to the grid. Returns the bottom of the last row. */
const STAT_H=14,STAT_GAP=3,STAT_PAD=4.8;
function drawStatGrid(doc,stats,x,y,w,colors,perRow=stats.length){
 const {panel,fit,accent}=writer(doc,colors),cw=(w-STAT_GAP*(perRow-1))/perRow,inner=cw-STAT_PAD-2,rows=Math.ceil(stats.length/perRow);
 const largest=(texts,size,min)=>{doc.setFont('Montserrat','bold');while(size>min&&texts.some(t=>(doc.setFontSize(size),doc.getTextWidth(t)>inner)))size-=.25;return size;};
 const titles=stats.map(([label])=>String(label).toUpperCase()),values=stats.map(([,value])=>String(value)),titleSize=largest(titles,7,5),valueSize=largest(values,11,7.5);
 stats.forEach((s,i)=>{const bx=x+i%perRow*(cw+STAT_GAP),by=y+Math.floor(i/perRow)*(STAT_H+STAT_GAP);panel(bx,by,cw,STAT_H);
  doc.setTextColor(150,150,150);doc.text(fit(titles[i],inner,titleSize,true),bx+STAT_PAD,by+5.6);
  doc.setTextColor(accent.r,accent.g,accent.b);doc.text(fit(values[i],inner,valueSize,true),bx+STAT_PAD,by+11.2);});
 doc.setTextColor(0,0,0);return y+rows*STAT_H+(rows-1)*STAT_GAP;
}
function drawExteriorSummaryPage(doc,model,settings,begin,colors){
 const {x,w,footnote}=writer(doc,colors);
 begin(reportText('Exterior Summary'));
 // Seven figures across the top (one row in landscape, four then three in portrait, every cell the
 // same size), the house under them at full width and the note about wall IDs at the foot of the page.
 const first=[[reportText('Net wall area'),measure(model.totals.net,"sf",number(model.totals.net)+' sq ft')],[reportText('Gross wall area'),measure(model.totals.gross,"sf",number(model.totals.gross)+' sq ft')],[reportText('Openings'),String(model.openings.length)]];
 const second=[[reportText('Wall regions'),String(model.walls.length)],[reportText('Opening area'),measure(model.totals.openingArea,"sf",number(model.totals.openingArea)+' sq ft')],[reportText('Opening perimeter'),measure(model.totals.openingPerimeter,"ft",number(model.totals.openingPerimeter),false)+' '+unit('ft','ft')],[reportText('Horizontal returns'),measure(model.totals.returns,"sf",number(model.totals.returns)+' sq ft')]];
 const top=drawStatGrid(doc,[...first,...second],x,35,w,colors,isLandscape(doc)?7:4)+5;
 const noteTop=footnote(reportText('Wall IDs connect the diagrams, dimensions, opening schedule and notes. Each wall face is counted once, on one of the four elevations (front, back, left, right) or as a hidden face, so those totals add up to the gross wall area.'));
 drawDiagram(doc,houseFaces(model),{x,y:top,w,h:noteTop-4-top},coverView(settings),{iso:true});
}
/* There are four elevations: Front, Back, Left and Right, looking from the configured front bearing
 and from it turned by 180, 90 and -90 degrees. Which elevation counts each wall face: a face is
 counted once, on the elevation that looks most directly at it among those where it faces the
 viewer (within 60 degrees) and at least a quarter of it is visible. A face that no elevation shows
 that well goes to the elevation that shows most of it, and a face no elevation shows at all is
 listed as hidden. Faces under 1 sq ft are not separate rows: they are summed as small pieces on
 the elevation they face. */
const SMALL_PIECE_SF=1,FACING_MIN=.5,VISIBLE_SHARE=.25,MIN_PIXELS=24;
const elevationViews=settings=>houseDirections(settings).filter(v=>['front','back','left','right'].includes(v.id));
// An elevation drawing is only as tall as the house needs at full width (plus room for leader
// labels), so a wide, low house leaves more of the page to its tables. `rect.h` is the maximum.
// Wall dimension drawings use it with their 9 mm label margin, no leader room and a lower floor.
function fitHeight(faces,view,rect,pad=5,extra=8,floor=40){
 const len=Math.hypot(view.x,view.y)||1,nx=view.x/len,ny=view.y/len;let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;
 for(const f of faces)for(const p of f.points||[]){const u=p.x*ny-p.y*nx;x0=Math.min(x0,u);x1=Math.max(x1,u);z0=Math.min(z0,p.z||0);z1=Math.max(z1,p.z||0);}
 if(!Number.isFinite(x0))return rect.h;return Math.max(Math.min(rect.h,floor),Math.min(rect.h,(z1-z0)*(rect.w-2*pad)/Math.max(x1-x0,.01)+2*pad+extra));
}
function elevationPlan(model,settings,rect,{fit=true}={}){
 const faces=houseFaces(model);
 const views=elevationViews(settings).map(view=>{const r={...rect,h:fit?fitHeight(faces,view,rect):rect.h};return {view,rect:r,scene:rasterScene(faces,view,Math.ceil(r.w*DENSITY),Math.ceil(r.h*DENSITY),false,5*DENSITY),ids:[],small:[]};}),hidden=[];
 for(const wall of model.walls){
  const n=wall.normal||{x:0,y:0},len=Math.hypot(n.x,n.y)||1,options=views.map(({view,scene},i)=>{const id=scene.surfaces.indexOf(wall),facing=(n.x*view.x+n.y*view.y)/len,count=id<0?0:scene.counts[id],expected=wall.net*.09290304*Math.max(facing,0)*scene.scale**2;return {i,facing,count,share:expected>0?count/expected:0};});
  const nearest=list=>list.sort((a,b)=>b.facing-a.facing||a.i-b.i)[0];
  if(wall.gross<SMALL_PIECE_SF){views[nearest(options.slice()).i].small.push(wall.id);continue;}
  const pick=nearest(options.filter(o=>o.facing>=FACING_MIN&&o.count>=MIN_PIXELS&&o.share>=VISIBLE_SHARE))||options.filter(o=>o.facing>0&&o.count>=MIN_PIXELS).sort((a,b)=>b.count-a.count||a.i-b.i)[0];
  if(pick)views[pick.i].ids.push(wall.id);else hidden.push(wall.id);
 }
 return {views,hidden};
}
/* Wall dimension drawings show the rest of the house, dimmed, behind the measured face. The
 organization turns this off with report_settings.general.exterior_dimension_context = false
 (Company > Reports); a report can override it with exteriorSettings.dimensionContext. Default on. */
function dimensionContext(settings){
 if(typeof settings?.dimensionContext==='boolean')return settings.dimensionContext;
 return root.projectOrganization?.report_settings?.general?.exterior_dimension_context!==false;
}
// The PDF's page orientation for these settings: this report's exteriorSettings.orientation, else the
// organization default report_settings.general.report_orientation, else portrait (pdf.js
// resolvePdfOrientation applies the same order after a render override).
function reportOrientation(settings){const pick=v=>v==='landscape'||v==='portrait'?v:null;return pick(settings?.orientation)||pick(root.projectOrganization?.report_settings?.general?.report_orientation)||'portrait';}
// The elevation key sits in the page header, just left of the right-aligned page title (pdf.js drawReportTemplate: 12pt bold, 20 mm from the right edge, baseline 18 mm).
function headerKeyRect(doc,title){doc.setFont('Montserrat','bold');doc.setFontSize(12);const tw=Number(doc.getTextWidth(title))||0,kw=40;return {x:doc.internal.pageSize.getWidth()-20-tw-6-kw,y:5,w:kw,h:25};}
function drawExteriorReportPages(doc,model,settings,begin,colors){
 const {x,w,bottom,text,note,table,paginate,columns,autoTable,boxHeight,sideTable,sideWidth}=writer(doc,colors),material=a=>reportText(!a.material||a.material==='Unassigned'?'Not assigned':a.material),landscape=isLandscape(doc);
 const area=v=>measure(v,"sf",number(v),false),openings=v=>v>0?area(v):'-',sum=(list,key)=>list.reduce((s,a)=>s+a[key],0),byId=new Map(model.walls.map(a=>[a.id,a]));
 // Each elevation lists its faces in two boxed columns (Wall, Material, Gross, Openings) with one totals box under both.
 const sq=metric()?' m²':' ft²',headers=[reportText('Wall'),reportText('Material'),reportText('Gross')+sq,reportText('Openings')+sq],widths=[1,2.2,1.4,1.4];
 // Faces under SMALL_PIECE_SF are one short row ("2 pieces < 1 ft²") so the label never widens the table.
 const smallRow=pieces=>({span:true,cells:[reportText(pieces.length===1?'{value1} piece < {value2}':'{value1} pieces < {value2}',{value1:pieces.length,value2:measure(SMALL_PIECE_SF,'sf','1 ft²')}),'',area(sum(pieces,'gross')),openings(sum(pieces,'openingArea'))]});
 const totalRow=list=>[reportText('Total')+'  ·  '+reportText('{value1} faces',{value1:list.length}),reportText('Gross ')+area(sum(list,'gross'))+sq,reportText('Openings ')+(sum(list,'openingArea')>0?area(sum(list,'openingArea'))+sq:'-'),reportText('Net ')+area(sum(list,'net'))+sq];
 drawExteriorSummaryPage(doc,model,settings,begin,colors);let y;
 /* Elevation page layouts.
  Landscape: the faces are one boxed table with its totals box in a panel on the right, only as wide as
  the widest elevation's table needs (the same width on every elevation page), and the drawing fills
  the rest at full height, inset from the content edge.
  Portrait, when everything fits on one page: the table block (two columns and the totals box) sits
  at the bottom, ending as far above the footer address as the address is above the page edge
  (evenBottom), and the drawing is as large as fits in the space above it, centred there.
  Otherwise (portrait, many faces): the drawing at the top and the tables flowing onto
  continuation pages. */
 const MIN_DRAWING=70,sideGap=landscape?SIDE_GAP:6,faceRow=a=>[a.id,material(a),area(a.gross),openings(a.openingArea)],tiny=model.walls.filter(a=>a.gross<SMALL_PIECE_SF);
 const side=landscape?sideWidth(headers,[...model.walls.map(faceRow),...(tiny.length?[smallRow(tiny)]:[])],totalRow(model.walls),w*SIDE_MIN,w*SIDE_MAX):null,drawW=landscape?w-side.pw-sideGap:w;
 const diagram=landscape?{x:x+DRAWING_INSET,y:33,w:drawW-DRAWING_INSET,h:bottom-33}:{x,y:33,w,h:110},plan=elevationPlan(model,settings,diagram,{fit:!landscape}),elevationOf=new Map(plan.hidden.map(id=>[id,'Hidden']));
 for(const {view:direction,rect:planned,scene:plannedScene,ids,small}of plan.views){
  for(const id of [...ids,...small])elevationOf.set(id,direction.name);
  const counted=new Set(ids),walls=ids.map(id=>byId.get(id)).sort((a,b)=>a.id.localeCompare(b.id)),pieces=small.map(id=>byId.get(id)),all=walls.concat(pieces),title=reportText(direction.name)+reportText(' Elevation');
  const rows=walls.map(faceRow);
  if(pieces.length)rows.push(smallRow(pieces));
  const more=()=>{begin(title+reportText(' - continued'));return note(reportText('Wall data continued. See the first ')+reportText(direction.name)+reportText(' elevation page for the diagram.'),38)+4;};
  const blockTop=evenBottom(doc)-(boxHeight(Math.ceil(rows.length/2))+4+10),even=!landscape&&rows.length>0&&blockTop-sideGap-33>=MIN_DRAWING;
  let drawing=planned,scene=plannedScene;
  if(even){drawing={x,y:33,w,h:blockTop-sideGap-33};scene=rasterScene(houseFaces(model),direction,Math.ceil(drawing.w*DENSITY),Math.ceil(drawing.h*DENSITY),false,5*DENSITY);}
  begin(title);drawElevationKey(doc,model,settings,headerKeyRect(doc,title),direction,colors);
  paintScene(scene,face=>!counted.has(face.id));drawDiagram(doc,houseFaces(model),drawing,direction,{scene,labelIds:counted});
  if(!rows.length){note(reportText('No wall face is counted on this elevation. Its walls are counted on the neighboring elevations that face them more directly.'),landscape?33:drawing.y+drawing.h+10,landscape?w-drawW-sideGap:w,landscape?x+drawW+sideGap:x);continue;}
  if(landscape)sideTable(headers,rows,x+drawW+sideGap,33,side.pw,side.widths,totalRow(all),more);
  else columns(headers,rows,even?blockTop:drawing.y+drawing.h+4,widths,totalRow(all),more);
 }
 if(plan.hidden.length){const hidden=plan.hidden.map(id=>byId.get(id)).sort((a,b)=>a.id.localeCompare(b.id)),heading=reportText('Hidden Wall Faces'),intro=reportText('These faces are not visible in any elevation drawing because other walls or the roof cover them. They are listed here so every face is counted once.');
  begin(heading);columns(headers,hidden.map(a=>[a.id,material(a),area(a.gross),openings(a.openingArea)]),note(intro,38)+4,widths,totalRow(hidden),()=>{begin(heading+reportText(' - continued'));return 38;});}
 const house=dimensionContext(settings)?houseFaces(model):null;
 for(const [heading,faces]of [['Wall Dimensions',model.walls.filter(a=>!isTrim(a))],['Trim Dimensions',model.walls.filter(isTrim)]]){
  // The panels are page fractions; a landscape page has at most two rows (dimensionPages), so its
  // panels are as tall as they are wide and the faces draw large. Each drawing is only as tall as its
  // face needs at the panel's width (fitHeight), and the size and material sit right under it.
  dimensionPages(faces,{landscape}).forEach((page,i)=>{begin(reportText(heading)+(i?reportText(' - continued'):''));page.forEach(panel=>{
   const a=panel.face,xx=x+panel.x*w+1,yy=36+panel.y*(bottom-36),ww=panel.w*w-3,hh=panel.h*(bottom-36)-4,frame={x:xx,y:yy+13,w:ww,h:hh-13-DIMENSION_TEXT};
   frame.h=fitHeight([a],a.normal,frame,9,0,Math.min(frame.h,24));
   text(a.id+' / '+reportText(elevationOf.get(a.id)||relativeSide(a.normal,settings)),xx+1,yy+5,ww<60?8:10,true);text(measure(a.net,'sf',number(a.net)+' sq ft')+reportText(' net'),xx+1,yy+10,7.5);drawDiagram(doc,[a],frame,a.normal,{dimensions:true,context:house&&house.filter(f=>f!==a)});
   const ty=frame.y+frame.h+2;text(reportText('W ')+measure(a.width,"ft",number(a.width)+"'")+reportText("  x  H ")+measure(a.height,"ft",number(a.height)+"'"),xx+2,ty,7);doc.setFontSize(6.5);text(doc.splitTextToSize(material(a)+(a.chimney?' / Chimney':''),ww-4)[0],xx+2,ty+4.5,6.5);
  });});
 }
 paginate(begin,reportText('Opening Schedule'),[reportText('Opening'),reportText('Type'),reportText('Wall'),(metric()?'W x H (m)':'W x H (ft)'),(metric()?'Area m²':'Area ft2'),(metric()?'Trim m':'Trim ft')],model.openings.map(o=>[o.id,reportText(o.label),o.wall,measure(o.width,"ft",number(o.width),false)+' x '+measure(o.height,"ft",number(o.height),false),measure(o.area,"sf",number(o.area),false),measure(o.perimeter,"ft",number(o.perimeter),false)]),[1.4,1.9,1,2,1.3,1.3],reportText('Dimensions are drawn extents, not manufacturer or rough-opening sizes. Trim {value1} is the opening perimeter.', {value1:unit('ft','ft')}));
 const byMaterial={};model.walls.forEach(a=>byMaterial[material(a)]=(byMaterial[material(a)]||0)+a.net);
 begin(reportText('Exterior Quantities'));text(reportText('Measured lengths'),x,38,12,true);y=table([reportText('Quantity'),unit('ft','Feet')],[[reportText('Top of walls'),measure(model.totals.top,"ft",number(model.totals.top),false)],[reportText('Bottom of walls'),measure(model.totals.bottom,"ft",number(model.totals.bottom),false)],[reportText('Inside corners'),measure(model.totals.inside,"ft",number(model.totals.inside),false)],[reportText('Outside corners'),measure(model.totals.outside,"ft",number(model.totals.outside),false)],[reportText('Opening perimeter'),measure(model.totals.openingPerimeter,"ft",number(model.totals.openingPerimeter),false)],[reportText('Material transitions'),measure(model.totals.transitions,"ft",number(model.totals.transitions),false)],[reportText('Exposed vertical terminations'),measure(model.totals.terminations,"ft",number(model.totals.terminations),false)]],44,[3,1]);
 const materialRows=Object.entries(byMaterial).map(([k,v])=>metric()?[k,measure(v,"sf",number(v),false)]:[k,number(v),number(v/100)]);if(y+40>bottom){begin(reportText('Exterior Quantities - continued'));y=26;}text(reportText('Net area by material'),x,y+12,12,true);y+=18;
 y=autoTable(metric()?[reportText('Material'),reportText('Area (m²)')]:[reportText('Material'),reportText('Area (sq ft)'),reportText('Squares')],materialRows,y,[2,1,1],()=>{begin(reportText('Exterior Quantities - continued'));return 38;});
 // Keep measured quantities above; material allowances require imperial estimates.
 if(metric())return;
 const waste=[0,5,10,15,20];
 for(const [label,divisor]of (metric()?[['Area including waste (m²)',1]]:[['Area including waste (sq ft)',1],['Squares including waste',100]])){
  const rows=Object.entries(byMaterial).map(([k,v])=>[k,...waste.map(p=>measure(v*(1+p/100)/divisor,"sf",number(v*(1+p/100)/divisor),false))]);
  if(divisor===1){begin(reportText('Material Allowances'));y=38;}if(y+22+rows.length*5.5>bottom&&y>38){begin(reportText('Material Allowances - continued'));y=38;}
  text(label,x,y,12,true);y+=7;y=autoTable([reportText('Material'),...waste.map(v=>v+'%')],rows,y,[2,1,1,1,1,1],()=>{begin(reportText('Material Allowances - continued'));return 38;})+14;
 }
 if(y+12>bottom){begin(reportText('Material Allowances - continued'));y=38;}note(reportText('Waste percentages are comparison allowances applied to net wall area. Horizontal returns are measured separately.'),y);
}
/* The Wall Notes page has the Roof Notes page's layout and notes card (pdf.js pdfNotesLayout and
 drawPdfNotesCard): the four elevations as reference images (2 x 2) on the left, the ruled notes card
 on the right in landscape; stacked in portrait. The report's notes and model warnings are written on
 the card's rules; whatever does not fit continues on a page with a full notes card. */
function drawExteriorNotes(doc,model,settings,begin,colors){
 const {text}=writer(doc,colors),heading=reportText('Wall Notes');begin(heading);
 const {cells,notes}=root.pdfNotesLayout(doc,4);
 houseDirections(settings).slice(0,4).forEach((view,i)=>{const c=cells[i];root.drawPdfCard(doc,c.x,c.y,c.w,c.h);text(reportText(view.name),c.x+4,c.y+6,9,true);drawDiagram(doc,houseFaces(model),{x:c.x+2,y:c.y+8,w:c.w-4,h:c.h-10},view);});
 const written=String(settings.notes||'').trim(),paragraphs=[...(written?[written]:[]),...(model.warnings||[]).map(n=>reportText('Review: ')+reportText(n))];
 let rest=root.drawPdfNotesCard(doc,notes,paragraphs,colors);
 while(rest.length){begin(heading+reportText(' - continued'));rest=root.drawPdfNotesCard(doc,root.pdfNotesLayout(doc,0).page,rest,colors);}
}
async function loadReportImage(item,state){
 const img=new Image();img.crossOrigin='anonymous';
 const src=item.dataUrl||item.url||(item.resourceName?'/measure/internal/project_resources.php?'+new URLSearchParams({project:state.folderId,name:item.resourceName}):'');
 await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Unable to load selected PDF image: '+(item.label||item.resourceName)));img.src=src;});
 return img;
}
function reportImageData(img){
 const canvas=document.createElement('canvas'),resize=Math.min(1,1800/Math.max(img.naturalWidth,img.naturalHeight));canvas.width=Math.round(img.naturalWidth*resize);canvas.height=Math.round(img.naturalHeight*resize);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
 return canvas.toDataURL('image/jpeg',.88);
}
// Freeze the chosen images into the render snapshot, just like roof imagery.
// Server workers do not share the editor's resource session or local URL.
async function prepareImagerySnapshot(snapshot){
 if(!selectedPhotos(snapshot.exteriorSettings).length)return snapshot;
 const result=JSON.parse(JSON.stringify(snapshot));
 const images=result.exteriorSettings.photoSlots?Object.values(result.exteriorSettings.photoSlots).filter(s=>s.enabled&&s.image&&!s.image.unavailable).map(s=>s.image):result.exteriorSettings.images;
 for(const item of images){if(item.include===false||item.dataUrl)continue;item.dataUrl=reportImageData(await loadReportImage(item,result));}
 return result;
}
/* Exterior Images pages: a justified mosaic. Photos keep their own aspect ratios (phone shots are
 often portrait beside landscape ones) and are laid out in rows, in slot order, every image in a row
 the same height and each row filling the width; if the rows are too tall for the page they all
 shrink together and are centred. Each photo's label sits on it, just above its top-left corner.
 mosaicLayout tries every split of the images into rows and keeps the one whose images are largest
 overall (sum of the square roots of their areas, so no photo is left tiny to make another huge). */
const MOSAIC_GAP=5,MOSAIC_LABEL=6,MOSAIC_PER_PAGE=6,MOSAIC_MIN_HEIGHT=45;
function mosaicLayout(aspects,box,{gap=MOSAIC_GAP,label=MOSAIC_LABEL}={}){
 const n=aspects.length;let best=null;if(!n)return {rects:[],score:0,minHeight:0};
 for(let mask=0;mask<1<<(n-1);mask++){
  const rows=[];let row=[0];for(let i=1;i<n;i++){if(mask&1<<(i-1)){rows.push(row);row=[i];}else row.push(i);}rows.push(row);
  const heights=rows.map(r=>(box.w-gap*(r.length-1))/r.reduce((s,i)=>s+aspects[i],0)),room=box.h-rows.length*label-gap*(rows.length-1),s=Math.min(1,room/heights.reduce((a,b)=>a+b,0));
  if(!(s>0))continue;const score=rows.reduce((t,r,k)=>t+r.reduce((u,i)=>u+heights[k]*s*Math.sqrt(aspects[i]),0),0);
  if(!best||score>best.score+1e-9)best={score,rows,heights:heights.map(h=>h*s)};
 }
 const total=best.heights.reduce((a,b)=>a+b,0)+best.rows.length*label+gap*(best.rows.length-1);let y=box.y+Math.max(0,(box.h-total)/2);const rects=[];
 best.rows.forEach((r,k)=>{const h=best.heights[k],rowW=r.reduce((s,i)=>s+aspects[i]*h,0)+gap*(r.length-1);let x=box.x+(box.w-rowW)/2;y+=label;for(const i of r){rects[i]={x,y,w:aspects[i]*h,h};x+=aspects[i]*h+gap;}y+=h+gap;});
 return {rects,score:best.score,minHeight:Math.min(...best.heights)};
}
// Images per page: as few pages as keep every photo at least MOSAIC_MIN_HEIGHT tall, at most
// MOSAIC_PER_PAGE a page, spread evenly over the pages.
function mosaicPages(aspects,box){
 for(let pages=Math.ceil(aspects.length/MOSAIC_PER_PAGE);;pages++){
  const groups=[];let at=0;for(let p=0;p<pages;p++){const count=Math.ceil((aspects.length-at)/(pages-p));groups.push(aspects.slice(at,at+count).map((a,k)=>at+k));at+=count;}
  const layouts=groups.map(g=>({indexes:g,...mosaicLayout(g.map(i=>aspects[i]),box)}));
  if(pages>=aspects.length||layouts.every(l=>l.minHeight>=MOSAIC_MIN_HEIGHT))return layouts;
 }
}
async function drawReportImagery(doc,state,begin,colors){
 const selected=selectedPhotos(state.exteriorSettings),order=photoSlots.map(s=>s.name);
 const images=selected.slice().sort((a,b)=>{const rank=i=>order.includes(i.direction)?order.indexOf(i.direction):8;return rank(a)-rank(b);}),{x,w,bottom,text}=writer(doc,colors);
 if(!images.length)return;
 const loaded=[];for(const item of images)loaded.push(item.missing?null:await loadReportImage(item,state));
 const aspects=loaded.map(img=>img&&img.naturalWidth>0&&img.naturalHeight>0?img.naturalWidth/img.naturalHeight:4/3),pages=mosaicPages(aspects,{x,y:36,w,h:bottom-36});
 for(const [p,layout]of pages.entries()){begin(reportText('Exterior Images')+(pages.length>1?' - '+(p+1):''));layout.indexes.forEach((index,k)=>{
  const item=images[index],img=loaded[index],r=layout.rects[k];
  text(reportText(item.direction)||reportText('Reference image'),r.x,r.y-1.8,9,true);
  if(!img){doc.setFillColor(246,248,250);doc.roundedRect(r.x,r.y,r.w,r.h,2,2,'F');doc.setFont('Montserrat','normal');doc.setFontSize(9);const label=reportText('Photo not assigned');text(label,r.x+(r.w-doc.getTextWidth(label))/2,r.y+r.h/2,9);return;}
  doc.addImage(item.dataUrl||reportImageData(img),'JPEG',r.x,r.y,r.w,r.h);
 });}
}
const api={directions,photoSlots,houseDirections,relativeSide,initializePhotoSlots,selectedPhotos,photosComplete,planShapes,frontBearing,dimensionPages,mosaicLayout,mosaicPages,fitHeight,rasterScene,paintScene,placeLabels,elevationPlan,elevationViews,houseFaces,roofDepthBias,ROOF_DEPTH_BIAS,dimensionContext,reportOrientation,evenBottom,writer,coverView,drawDiagram,drawOrientationKey,drawElevationKey,drawRoofElevations,drawExteriorCover,drawExteriorSummaryPage,drawExteriorReportPages,drawExteriorNotes,drawReportImagery,prepareImagerySnapshot};
if(typeof module==='object'&&module.exports)module.exports=api;else {root.ExteriorPDF=api;Object.assign(root,{drawExteriorReportPages,drawExteriorNotes,drawExteriorCover,drawReportImagery});}
})(typeof window==='undefined'?globalThis:window);
