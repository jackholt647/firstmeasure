/* Shared exterior report rendering. Geometry is metric; measurements are feet. */
(function(root){
'use strict';
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
 const a=frontBearing(settings)*Math.PI/180,ux=Math.sin(a),uy=-Math.cos(a);doc.setDrawColor(196,40,45);doc.setLineWidth(.7);doc.line(cx+ux*r*.65,cy+uy*r*.65,cx+ux*r*1.3,cy+uy*r*1.3);text('Front',cx+ux*r*1.8-3,cy+uy*r*1.8+1,5.5,true,[196,40,45]);text('Back',cx-ux*r*1.8-3,cy-uy*r*1.8+1,5.5,true);
 const compassX=rect.x+rect.w*.72;doc.setDrawColor(75,87,100);doc.setLineWidth(.3);doc.line(compassX,cy-r,compassX,cy+r);doc.line(compassX-r,cy,compassX+r,cy);
 text('N',compassX-1,cy-r-1.5,6,true,[196,40,45]);text('S',compassX-1,cy+r+3,6);text('W',compassX-r-4,cy+1,6);text('E',compassX+r+1,cy+1,6);
 text(Number.isFinite(settings?.frontBearing)?'Front '+Math.round(frontBearing(settings))+' deg / North up':'Front direction not set',rect.x+1,rect.y+rect.h,6);
}
const number=v=>v>0&&v<.05?'<0.1':Number(v||0).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const isTrim=a=>a.trim||/^trim-/.test(a.materialKey||'')||/\btrim\b/i.test(a.material||'');
const centroid=ps=>ps.reduce((a,p)=>({x:a.x+p.x/ps.length,y:a.y+p.y/ps.length,z:a.z+(p.z||0)/ps.length}),{x:0,y:0,z:0});

// Rows occupy sixths of a page. Optimize across pages to avoid stranded faces.
function dimensionPages(faces){
 const ordered=faces.slice().sort((a,b)=>b.gross-a.gross||a.id.localeCompare(b.id)),max=Math.max(0,...ordered.map(a=>a.gross));
 const columns=a=>a.gross>=Math.max(80,max*.55)?1:a.gross>=Math.max(30,max*.18)?2:3,memo=new Map();
 function solve(start){
  if(start===ordered.length)return {score:0,pages:[]};if(memo.has(start))return memo.get(start);
  let best={score:Infinity,pages:[]};
  function extend(at,rows,used,penalty){
   if(rows.length){const tail=solve(at),score=100+(6-used)*.2+penalty+tail.score;if(score<best.score)best={score,pages:[rows,...tail.pages]};}
   if(at>=ordered.length)return;const cols=columns(ordered[at]),units=cols===3?2:3;if(used+units>6)return;
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
function surfaceColor(face){
 const hex=/^#?([0-9a-f]{6})$/i.exec(face.finishColor||'');
 let color=hex?[0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16)):face.surface==='roof'?[193,204,215]:face.chimney?[213,197,192]:/brick/i.test(face.material)?[219,185,174]:/stone|masonry/i.test(face.material)?[210,204,192]:/stucco/i.test(face.material)?[230,219,190]:isTrim(face)?[233,229,217]:[210,226,238];
 if(face.featureType)color=/door|garage/i.test(face.featureType)?[225,198,155]:/vent/i.test(face.featureType)?[181,210,181]:[150,194,212];
 const n=face.normal||K.normal(face.points),shade=face.featureType?1:n?.z>.7?1:Math.max(.76,Math.min(1,.9+(n?.x||0)*.07-(n?.y||0)*.05));
 // Keep white finishes distinguishable from the diagram background in print.
 return color.map(v=>Math.round(Math.min(239,v)*shade));
}
// Resolve depth at each pixel, including holes, openings and curved triangles.
// A single average depth per wall cannot resolve intersecting/overlapping faces.
function rasterScene(faces,view,width,height,iso=false,pad=30){
 const angle=iso?35*Math.PI/180:0,len=Math.hypot(view.x,view.y),nx=view.x/len,ny=view.y/len;
 const project=p=>({x:p.x*ny-p.y*nx,y:-p.z*Math.cos(angle)+(p.x*nx+p.y*ny)*Math.sin(angle),z:(p.x*nx+p.y*ny)*Math.cos(angle)+p.z*Math.sin(angle)});
 const surfaces=faces.flatMap(face=>[face,...(face.openings||[]).map(o=>({...o,featureType:o.type,normal:face.normal})),...(face.openings||[]).flatMap(o=>(o.trimFaces||[]).map(t=>({...t,id:'',normal:face.normal,openingTrim:true}))) ]),meshes=surfaces.map(mesh);
 const pixels=new Uint8ClampedArray(width*height*4),depth=new Float64Array(width*height).fill(-Infinity),owners=new Int32Array(width*height).fill(-1);
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(const m of meshes)for(const p of m.positions){const q=project(p);minX=Math.min(minX,q.x);maxX=Math.max(maxX,q.x);minY=Math.min(minY,q.y);maxY=Math.max(maxY,q.y);}
 if(!Number.isFinite(minX)){minX=minY=0;maxX=maxY=1;}
 const scale=Math.min((width-2*pad)/Math.max(maxX-minX,.01),(height-2*pad)/Math.max(maxY-minY,.01));
 const at=p=>{const q=project(p);return {x:width/2+(q.x-(minX+maxX)/2)*scale,y:height/2+(q.y-(minY+maxY)/2)*scale,z:q.z};};
 for(let i=0;i<pixels.length;i+=4){pixels[i]=249;pixels[i+1]=250;pixels[i+2]=252;pixels[i+3]=255;}
 surfaces.forEach((face,id)=>{
  const m=meshes[id],ps=m.positions.map(at),color=surfaceColor(face),bias=face.openingTrim?2e-4:face.featureType?1e-4:0;
  for(const tri of m.triangles){
   const [a,b,c]=tri.map(i=>ps[i]),den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(den)<1e-8)continue;
   const x0=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x))),x1=Math.min(width-1,Math.ceil(Math.max(a.x,b.x,c.x))),y0=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y))),y1=Math.min(height-1,Math.ceil(Math.max(a.y,b.y,c.y)));
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const u=((b.y-c.y)*(x+.5-c.x)+(c.x-b.x)*(y+.5-c.y))/den,v=((c.y-a.y)*(x+.5-c.x)+(a.x-c.x)*(y+.5-c.y))/den;
    if(u< -1e-9||v< -1e-9||u+v>1+1e-9)continue;
    const z=u*a.z+v*b.z+(1-u-v)*c.z+bias,index=y*width+x;
    if(z>depth[index]+1e-8){depth[index]=z;owners[index]=id;const n=index*4;pixels[n]=color[0];pixels[n+1]=color[1];pixels[n+2]=color[2];}
   }
  }
 });
 const counts=new Array(surfaces.length).fill(0),sums=surfaces.map(()=>({x:0,y:0}));
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const index=y*width+x,id=owners[index];if(id<0)continue;counts[id]++;sums[id].x+=x;sums[id].y+=y;
  if((x+1<width&&owners[index+1]!==id)||(y+1<height&&owners[index+width]!==id))pixels.set([102,115,127,255],index*4);
 }
 // Draw grouped opening divisions after depth resolution. Dashes remain
 // visible on the opening, but never bleed through a closer wall or roof.
 surfaces.forEach((face,id)=>{for(const pair of face.dividers||[]){const [a,b]=pair.map(at),length=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.ceil(length*2);for(let i=0;i<=steps;i++){if(Math.floor(i/2/6)%2)continue;const t=steps?i/steps:0,x=Math.round(a.x+(b.x-a.x)*t),y=Math.round(a.y+(b.y-a.y)*t);if(x<0||x>=width||y<0||y>=height)continue;const index=y*width+x;if(owners[index]===id)pixels.set([72,85,97,255],index*4);}}});
 const labels=surfaces.map((face,id)=>({face,count:counts[id],point:null,distance:Infinity}));
 for(let y=8;y<height-8;y+=4)for(let x=12;x<width-12;x+=4){
  const id=owners[y*width+x];if(id<0||!surfaces[id].id)continue;
  if(![-10,0,10].every(dx=>[-6,0,6].every(dy=>owners[(y+dy)*width+x+dx]===id)))continue;
  const d=(x-sums[id].x/counts[id])**2+(y-sums[id].y/counts[id])**2;
  if(d<labels[id].distance){labels[id].point={x,y};labels[id].distance=d;}
 }
 return {width,height,pixels,depth,owners,surfaces,counts,labels,at};
}
function writer(doc,colors){
 const x=25,w=doc.internal.pageSize.getWidth()-40,bottom=doc.internal.pageSize.getHeight()-22,accent=colors?.primary||{r:200,g:40,b:40};
 const text=(value,px,py,size=9,bold=false,color=[44,51,60])=>{doc.setFont('Montserrat',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(...color);doc.text(Array.isArray(value)?value:String(value),px,py);};
 const note=(value,y,width=w,px=x)=>{doc.setFont('Montserrat','normal');doc.setFontSize(8);const lines=doc.splitTextToSize(String(value),width);text(lines,px,y,8);return y+lines.length*4;};
 const table=(headers,rows,y,widths)=>{
  const weights=widths||headers.map(()=>1),cols=weights.map(v=>v/weights.reduce((a,b)=>a+b,0)*w);doc.setFillColor(accent.r,accent.g,accent.b);doc.roundedRect(x,y,w,9,1.5,1.5,'F');let px=x;
  headers.forEach((h,i)=>{text(h,px+2,y+5.8,7.5,true,[255,255,255]);px+=cols[i];});y+=9;
  rows.forEach((row,r)=>{if(r%2===0){doc.setFillColor(245,247,250);doc.rect(x,y,w,8,'F');}let px=x;row.forEach((v,i)=>{let str=String(v);doc.setFontSize(8);while(doc.getTextWidth(str)>cols[i]-4&&str.length>1)str=str.slice(0,-2)+'~';text(str,px+2,y+5.3,8);px+=cols[i];});y+=8;});return y;
 };
 const paginate=(begin,heading,headers,rows,widths,description)=>{let index=0;do{begin(heading+(index?' - continued':''));let y=38;if(description)y=note(description,y)+5;const count=Math.max(1,Math.floor((bottom-y-9)/8));if(rows.length)table(headers,rows.slice(index,index+count),y,widths);else note('No modeled openings are present in this snapshot.',y+12);index+=count;}while(index<rows.length);};
 return {x,w,bottom,accent,text,note,table,paginate};
}
function drawDiagram(doc,faces,rect,view,{dimensions=false,iso=false,labels=true}={}){
 const density=8,width=Math.ceil(rect.w*density),height=Math.ceil(rect.h*density),scene=rasterScene(faces,view,width,height,iso,(dimensions?9:5)*density);
 if(root.document){const canvas=root.document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),data=ctx.createImageData(width,height);data.data.set(scene.pixels);ctx.putImageData(data,0,0);doc.addImage(canvas.toDataURL('image/png'),'PNG',rect.x,rect.y,rect.w,rect.h,undefined,'FAST');}
 const {text}=writer(doc),at=p=>{const q=scene.at(p);return {x:rect.x+q.x/density,y:rect.y+q.y/density};};
 if(labels&&!dimensions)for(const label of scene.labels){
  if(!label.point||label.count<150)continue;const p={x:rect.x+label.point.x/density,y:rect.y+label.point.y/density},size=label.face.featureType?5.5:7;doc.setFont('Montserrat','bold');doc.setFontSize(size);const tw=doc.getTextWidth(label.face.id);
  const px=Math.round(label.point.x),py=Math.round(label.point.y),half=Math.ceil(tw*density/2)+3,id=scene.surfaces.indexOf(label.face);
  if([-half,0,half].some(dx=>scene.owners[py*width+px+dx]!==id))continue;
  doc.setFillColor(249,250,252);doc.roundedRect(p.x-tw/2-.7,p.y-2.2,tw+1.4,3.3,.5,.5,'F');text(label.face.id,p.x-tw/2,p.y,size,true);
 }
 if(dimensions)for(const face of faces){const ps=face.points.map(at),c=centroid(ps);for(let i=0;i<ps.length;i++){
  const p=ps[i],q=ps[(i+1)%ps.length];if(Math.hypot(q.x-p.x,q.y-p.y)<12)continue;
  const feet=Math.hypot(...['x','y','z'].map(k=>face.points[i][k]-face.points[(i+1)%ps.length][k]))/.3048,label=number(feet)+"'",mx=(p.x+q.x)/2,my=(p.y+q.y)/2,horizontal=Math.abs(q.x-p.x)>Math.abs(q.y-p.y);doc.setFontSize(6.5);const tw=doc.getTextWidth(label);text(label,mx+(horizontal?-tw/2:mx>c.x?2:-tw-2),my+(horizontal?(my>c.y?3.5:-2):1),6.5);
 }}
 return scene;
}
const houseFaces=model=>[...model.walls,...(model.returns||[]).map(f=>({...f,id:'',openings:[]})),...(model.roof||[]).map(f=>({...f,id:'',surface:'roof',openings:[]}))];
function coverView(model){const principal=model.walls.reduce((a,b)=>b.gross>a.gross?b:a,model.walls[0]).normal,angle=Math.atan2(principal.y,principal.x)+Math.PI/4;return {x:Math.cos(angle),y:Math.sin(angle)};}
function drawExteriorCover(doc,model,rect,settings={}){drawDiagram(doc,houseFaces(model),{...rect,h:rect.h-28},coverView(model),{iso:true,labels:false});drawOrientationKey(doc,model,settings,{x:rect.x+rect.w/2-28,y:rect.y+rect.h-27,w:56,h:24});}
function drawRoofElevations(doc,model,settings,begin,colors){
 const {x,w,bottom,text}=writer(doc,colors),gap=6,ww=(w-gap)/2,hh=(bottom-37-gap)/2;begin('Roof Elevations');
 houseDirections(settings).slice(4).forEach((view,i)=>{const xx=x+i%2*(ww+gap),yy=37+Math.floor(i/2)*(hh+gap);text(view.name,xx+2,yy+5,10,true);drawDiagram(doc,(model.roof||[]).map(f=>({...f,surface:'roof',id:''})),{x:xx,y:yy+10,w:ww,h:hh-12},view,{iso:true,labels:false});});
}
function drawExteriorReportPages(doc,model,settings,begin,colors){
 const {x,w,bottom,text,note,table,paginate}=writer(doc,colors),material=a=>a.material||'Unassigned';
 begin('Exterior Summary');let y=38;
 [['Net wall area',number(model.totals.net)+' sq ft'],['Gross wall area',number(model.totals.gross)+' sq ft'],['Openings',String(model.openings.length)]].forEach(([label,value],i)=>{const bx=x+i*(w+3)/3;doc.setFillColor(242,245,249);doc.roundedRect(bx,y,(w-6)/3,23,2,2,'F');text(label,bx+4,y+7,8);text(value,bx+4,y+17,12,true);});
 drawDiagram(doc,houseFaces(model),{x,y:68,w,h:111},coverView(model),{iso:true});
 table(['Measurement','Quantity'],[['Wall regions',model.walls.length],['Opening area',number(model.totals.openingArea)+' sq ft'],['Opening perimeter',number(model.totals.openingPerimeter)+' ft'],['Horizontal returns',number(model.totals.returns)+' sq ft']],188,[2,1]);note('Wall IDs connect the diagrams, dimensions, opening schedule and notes.',240);
 for(const direction of houseDirections(settings)){
  begin(direction.name+' Elevation');drawOrientationKey(doc,model,settings,{x:x+w-58,y:31,w:56,h:27});const scene=drawDiagram(doc,model.walls.concat(model.returns||[]),{x,y:63,w,h:85},direction);
  const visible=new Set(scene.surfaces.filter((f,i)=>!f.featureType&&scene.counts[i]>20).map(f=>f.id)),walls=model.walls.filter(a=>visible.has(a.id));
  y=note('Visible walls are listed below. Areas are measured on each wall plane; the diagram is an orthographic projection.',155)+3;let index=0;
  do{if(index){begin(direction.name+' Elevation - continued');y=note('Wall data continued. See the first '+direction.name.toLowerCase()+' elevation page for the diagram.',38)+5;}
   const count=Math.max(1,Math.floor((bottom-y-9)/8));if(walls.length)table(['Wall','Material','Gross ft2','Open ft2','Net ft2'],walls.slice(index,index+count).map(a=>[a.id,material(a),number(a.gross),number(a.openingArea),number(a.net)]),y,[1,2.1,1.5,1.5,1.5]);else note('No wall surface is visible from this direction.',y+10);index+=count;
  }while(index<walls.length);
 }
 for(const [heading,faces]of [['Wall Dimensions',model.walls.filter(a=>!isTrim(a))],['Trim Dimensions',model.walls.filter(isTrim)]]){
  dimensionPages(faces).forEach((page,i)=>{begin(heading+(i?' - continued':''));page.forEach(panel=>{
   const a=panel.face,xx=x+panel.x*w+1,yy=36+panel.y*(bottom-36),ww=panel.w*w-3,hh=panel.h*(bottom-36)-4;
   text(a.id+' / '+relativeSide(a.normal,settings),xx+1,yy+5,ww<60?8:10,true);text(number(a.net)+' sq ft net',xx+1,yy+10,7.5);drawDiagram(doc,[a],{x:xx,y:yy+13,w:ww,h:hh-25},a.normal,{dimensions:true});
   text('W '+number(a.width)+"'  x  H "+number(a.height)+"'",xx+2,yy+hh-5,7);doc.setFontSize(6.5);text(doc.splitTextToSize(material(a)+(a.chimney?' / Chimney':''),ww-4)[0],xx+2,yy+hh,6.5);
  });});
 }
 paginate(begin,'Opening Schedule',['Opening','Type','Wall','W x H (ft)','Area ft2','Trim ft'],model.openings.map(o=>[o.id,o.label,o.wall,number(o.width)+' x '+number(o.height),number(o.area),number(o.perimeter)]),[1.4,1.9,1,2,1.3,1.3],'Dimensions are drawn extents, not manufacturer or rough-opening sizes. Trim ft is the opening perimeter.');
 const byMaterial={};model.walls.forEach(a=>byMaterial[material(a)]=(byMaterial[material(a)]||0)+a.net);
 begin('Exterior Quantities');text('Measured lengths',x,38,12,true);y=table(['Quantity','Feet'],[['Top of walls',number(model.totals.top)],['Bottom of walls',number(model.totals.bottom)],['Inside corners',number(model.totals.inside)],['Outside corners',number(model.totals.outside)],['Opening perimeter',number(model.totals.openingPerimeter)],['Material transitions',number(model.totals.transitions)],['Exposed vertical terminations',number(model.totals.terminations)]],44,[3,1]);
 const materialRows=Object.entries(byMaterial).map(([k,v])=>[k,number(v),number(v/100)]);text('Net area by material',x,y+12,12,true);y+=18;
 for(let i=0;i<materialRows.length;){const count=Math.max(1,Math.floor((bottom-y-9)/8));table(['Material','Area (sq ft)','Squares'],materialRows.slice(i,i+count),y,[2,1,1]);i+=count;if(i<materialRows.length){begin('Exterior Quantities - continued');y=38;}}
 const waste=[0,5,10,15,20];
 for(const [label,divisor]of [['Area including waste (sq ft)',1],['Squares including waste',100]]){
  const rows=Object.entries(byMaterial).map(([k,v])=>[k,...waste.map(p=>number(v*(1+p/100)/divisor))]);
  if(divisor===1){begin('Material Allowances');y=38;}if(y+16+rows.length*8>bottom&&y>38){begin('Material Allowances - continued');y=38;}
  text(label,x,y,12,true);y+=7;let i=0;while(i<rows.length){const count=Math.max(1,Math.floor((bottom-y-9)/8));y=table(['Material',...waste.map(v=>v+'%')],rows.slice(i,i+count),y,[2,1,1,1,1,1]);i+=count;if(i<rows.length){begin('Material Allowances - continued');y=38;}}y+=14;
 }
 if(y+12>bottom){begin('Material Allowances - continued');y=38;}note('Waste percentages are comparison allowances applied to net wall area. Horizontal returns are measured separately.',y);
}
function drawExteriorNotes(doc,model,settings,begin,colors){
 const {x,w,bottom,text}=writer(doc,colors);begin('Wall Notes');const gridHeight=(bottom-37)*.65,gap=4,ww=(w-gap)/2,hh=(gridHeight-gap)/2;
 houseDirections(settings).slice(0,4).forEach((view,i)=>{const xx=x+i%2*(ww+gap),yy=37+Math.floor(i/2)*(hh+gap);text(view.name,xx+2,yy+4,9,true);drawDiagram(doc,model.walls.concat(model.returns||[]),{x:xx,y:yy+7,w:ww,h:hh-8},view);});
 let y=37+gridHeight+6;text('STRUCTURE NOTES / WALL REFERENCES',x+3,y,9,true);y+=7;const notes=String(settings.notes||'').trim(),paragraphs=[...(notes?[notes]:[]),...(model.warnings||[]).map(n=>'Review: '+n)];
 for(const paragraph of paragraphs){doc.setFontSize(8);const lines=doc.splitTextToSize(paragraph,w-6);for(const line of lines){if(y>bottom-8){begin('Wall Notes - continued');y=38;}text(line,x+3,y,8);y+=4;}y+=3;}
 doc.setDrawColor(220,228,240);doc.setLineWidth(.25);for(let lineY=y+6;lineY<bottom;lineY+=8)doc.line(x+3,lineY,x+w-3,lineY);
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
async function drawReportImagery(doc,state,begin,colors){
 const selected=selectedPhotos(state.exteriorSettings),order=photoSlots.map(s=>s.name);
 const images=selected.slice().sort((a,b)=>{const rank=i=>order.includes(i.direction)?order.indexOf(i.direction):8;return rank(a)-rank(b);}),{x,w,bottom,text}=writer(doc,colors),gap=6,ww=(w-gap)/2,hh=(bottom-38-gap)/2;
 for(let i=0;i<images.length;i+=4){begin('Exterior Images'+(images.length>4?' - '+(i/4+1):''));for(const [j,item]of images.slice(i,i+4).entries()){
  const xx=x+j%2*(ww+gap),yy=38+Math.floor(j/2)*(hh+gap);
  if(item.missing){text(item.direction,xx,yy+4,10,true);doc.setFillColor(246,248,250);doc.roundedRect(xx,yy+9,ww,hh-22,2,2,'F');text('Photo not assigned',xx+5,yy+hh/2,9);continue;}
  const img=await loadReportImage(item,state);
  text(item.direction||'Reference image',xx,yy+4,10,true);const boxH=hh-22,scale=Math.min(ww/img.naturalWidth,boxH/img.naturalHeight),iw=img.naturalWidth*scale,ih=img.naturalHeight*scale;
  doc.addImage(item.dataUrl||reportImageData(img),'JPEG',xx+(ww-iw)/2,yy+9+(boxH-ih)/2,iw,ih);doc.setFontSize(7);text(doc.splitTextToSize(item.label||'Untitled frame',ww).slice(0,2),xx,yy+hh-8,7);
 }}
}
const api={directions,photoSlots,houseDirections,relativeSide,initializePhotoSlots,selectedPhotos,photosComplete,planShapes,frontBearing,dimensionPages,rasterScene,drawDiagram,drawOrientationKey,drawRoofElevations,drawExteriorCover,drawExteriorReportPages,drawExteriorNotes,drawReportImagery,prepareImagerySnapshot};
if(typeof module==='object'&&module.exports)module.exports=api;else {root.ExteriorPDF=api;Object.assign(root,{drawExteriorReportPages,drawExteriorNotes,drawExteriorCover,drawReportImagery});}
})(typeof window==='undefined'?globalThis:window);
