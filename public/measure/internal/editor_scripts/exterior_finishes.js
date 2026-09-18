/* Metric texture coordinates and shared neutral maps, tinted by the finish color. */
(function(root){'use strict';
const cache=new Map();
const defaults={material:'unassigned',color:'#80868b',trimColor:'#f5f3ef'};
function resolve(face={},settings=root.WallMode?.finishDefaults||{}){
 const normal=face.normal||(face.points&&root.WallSolidGeometry?.faceFrame(face)?.n),d={...defaults,...settings},source=face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':normal?.z<-.5?'soffit':'default'),type=source==='default'?d.material:source;
 return {material:type==='default'?'unassigned':type,color:face.finishColor||face.color||((face.trim||type.startsWith('trim-')||type==='opening-trim')?d.trimColor:source==='chimney-top'?'#d4d0c8':source==='shingles'?'#74777a':d.color)};
}
function texture(type){
 if(cache.has(type))return cache.get(type);
 const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const c=canvas.getContext('2d');
 c.fillStyle='#eee';c.fillRect(0,0,256,256);
 const vertical=type.includes('vertical'),trim=type.startsWith('trim'),siding=type==='siding'||type.startsWith('siding-');
 if(vertical){c.translate(256,0);c.rotate(Math.PI/2);}
 if(siding){const grad=c.createLinearGradient(0,0,0,64);grad.addColorStop(0,'#aaa');grad.addColorStop(.09,'#dedede');grad.addColorStop(.16,'#f5f5f5');grad.addColorStop(1,'#e1e1e1');for(let y=0;y<256;y+=64){c.save();c.translate(0,y);c.fillStyle=grad;c.fillRect(0,0,256,64);c.fillStyle='#888';c.fillRect(0,0,256,2);c.restore();}}
 if(siding||trim){c.strokeStyle=trim?'#d6d6d6':'#d0d0d0';c.lineWidth=.5;for(let y=5;y<256;y+=7){c.beginPath();c.moveTo(0,y);c.bezierCurveTo(80,y+2,180,y-2,256,y);c.stroke();}}
 if(type==='opening-trim'){const g=c.createLinearGradient(0,0,0,256);for(const [at,color]of [[0,'#929292'],[.035,'#b6b6b6'],[.09,'#fafafa'],[.18,'#eeeeee'],[.84,'#e8e8e8'],[.94,'#cccccc'],[1,'#888888']])g.addColorStop(at,color);c.fillStyle=g;c.fillRect(0,0,256,256);c.strokeStyle='#00000008';c.lineWidth=.5;for(let y=28;y<224;y+=9){c.beginPath();c.moveTo(0,y);c.bezierCurveTo(80,y+1,180,y-1,256,y);c.stroke();}}
 if(type==='soffit'){for(let x=0;x<256;x+=32){c.fillStyle='#9ca0a2';c.fillRect(x,0,2,256);c.fillStyle='#fafafa';c.fillRect(x+2,0,2,256);for(let y=8;y<256;y+=12){c.fillStyle='#9ca0a2';c.fillRect(x+13,y,2,2);c.fillRect(x+19,y,2,2);}}}
 if(type==='shingles'){c.fillStyle='#d3d3d3';c.fillRect(0,0,256,256);for(let row=0;row<4;row++){const y=row*64;for(let col=-1;col<4;col++){const x=col*85+(row%2?42:0);c.fillStyle=['#c6c6c6','#dedede','#cecece'][(col+row+3)%3];c.fillRect(x,y,84,63);c.fillStyle='#777';c.fillRect(x,y+61,85,3);c.fillStyle='#a0a0a0';c.fillRect(x,y,1,61);}}for(let i=0;i<8000;i++){c.fillStyle=i%2?'#ffffff18':'#00000018';c.fillRect((i*73)%256,(i*139+Math.floor(i/256)*31)%256,1,1);}}
 if(type==='brick'||type==='masonry'){c.strokeStyle='#a0a0a0';c.lineWidth=3;for(let y=0;y<256;y+=32){c.beginPath();c.moveTo(0,y);c.lineTo(256,y);for(let x=(y%64?32:0);x<=256;x+=64){c.moveTo(x,y);c.lineTo(x,y+32);}c.stroke();}}
 if(['stucco','stone','other'].includes(type)){for(let i=0;i<1800;i++){const x=(i*137)%256,y=(i*73+Math.floor(i/256)*17)%256;c.fillStyle=i%2?'#dadada':'#f8f8f8';c.fillRect(x,y,type==='stone'?7:1,type==='stone'?5:1);}}
 const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.RepeatWrapping;if(type==='opening-trim')t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=4;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;cache.set(type,t);return t;
}
// Opening maps cover one whole opening instead of repeating wall-sized tiles.
const openingMaps=new Map();
function openingTexture(finish){
 const type=finish.featureType,w=Math.max(.25,Math.round(finish.width*4)/4),h=Math.max(.25,Math.round(finish.height*4)/4),color=finish.color||({window:'#e8e7e1',skylight:'#41494e',door:'#c8c3b9',garage:'#deddd6',vent:'#d5d5ce'})[type]||'#deddd6',key=[type,w,h,color].join(':');
 if(openingMaps.has(key)){const t=openingMaps.get(key);openingMaps.delete(key);openingMaps.set(key,t);return t;}
 const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const c=canvas.getContext('2d'),N=512;
 const fill=(x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
 const gradient=(x,y,w,h,stops,vertical=true)=>{const g=c.createLinearGradient(x,y,vertical?x:x+w,vertical?y+h:y);for(const [at,color]of stops)g.addColorStop(at,color);fill(x,y,w,h,g);};
 const bevel=(x,y,w,h,b=5)=>{fill(x,y,w,h,'#777d7c');fill(x+b,y+b,w-2*b,h-2*b,color);fill(x+1,y+1,w-2,Math.max(1,b/2),'#ffffffa0');fill(x+1,y+1,Math.max(1,b/2),h-2,'#ffffff70');fill(x+b,y+h-b,w-b,b,'#00000036');fill(x+w-b,y+b,b,h-b,'#00000028');};
 const bx=Math.min(40,Math.max(5,.045/w*N)),by=Math.min(40,Math.max(5,.045/h*N));
 fill(0,0,N,N,'#343a3c');fill(bx*.4,by*.4,N-bx*.8,N-by*.8,color);
 if(type==='window'||type==='skylight'){
  const cols=type==='skylight'?1:Math.max(1,Math.min(4,Math.round(w/.95))),rows=type==='skylight'?1:h>1.05?2:1,gx=bx*.8,gy=by*.8,inner={x:bx*1.6,y:by*1.6,w:N-bx*3.2,h:N-by*3.2};
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const x=inner.x+col*inner.w/cols+gx/2,y=inner.y+row*inner.h/rows+gy/2,pw=inner.w/cols-gx,ph=inner.h/rows-gy;
   fill(x-3,y-3,pw+6,ph+6,'#616c6e');
   gradient(x,y,pw,ph,[[0,'#314958'],[.42,'#718c98'],[.64,'#536c74'],[1,'#233b42']]);
   // Soft sky reflections, shaded interior, and a restrained grazing highlight.
   c.save();c.beginPath();c.rect(x,y,pw,ph);c.clip();
   gradient(x,y,pw,ph,[[0,'#b4d7e01a'],[.48,'#d9e8e82e'],[.52,'#c2d7d60a'],[1,'#071419a0']]);
   for(let k=0;k<4;k++){c.fillStyle='#dce9e714';c.beginPath();c.ellipse(x+pw*(.1+k*.3),y+ph*.22,pw*.3,ph*.065,0,0,Math.PI*2);c.fill();}
   c.save();c.filter='blur(3px)';c.fillStyle='#172f3024';for(let k=0;k<22;k++){const tx=x+pw*k/21,ty=y+ph*(.82+.05*Math.sin(k*1.7+col));c.beginPath();c.ellipse(tx,ty,pw*.08,ph*(.035+.018*(1+Math.sin(k*2.1))),0,0,Math.PI*2);c.fill();}c.restore();
   c.fillStyle='#ffffff14';c.beginPath();c.moveTo(x+pw*.55,y);c.lineTo(x+pw*.8,y);c.lineTo(x+pw*.3,y+ph);c.lineTo(x+pw*.05,y+ph);c.fill();c.restore();
   fill(x,y,2,ph,'#101e2355');fill(x,y,pw,2,'#101e2366');fill(x+pw-1,y,1,ph,'#d5e6e977');
  }
  gradient(bx, N-by*1.5,N-bx*2,by,[[0,'#ffffff88'],[.3,'#ffffff22'],[1,'#00000055']]);
  if(rows===2){fill(N/2-8,N/2-2,16,4,'#a5a8a5');fill(N/2-4,N/2-4,8,3,'#ebede6');}
 }else if(type==='door'){
  const leaves=w>1.35?2:1;for(let leaf=0;leaf<leaves;leaf++){
   const x0=bx+leaf*(N-2*bx)/leaves,lw=(N-2*bx)/leaves;
   fill(x0,by,lw-1,N-by*2,color);const margin=Math.max(bx,lw*.12),gap=lw*.075,pw=(lw-2*margin-gap)/2;
   for(let row=0;row<3;row++)for(let col=0;col<2;col++){
    const heights=[.18,.32,.29],starts=[.08,.32,.69],x=x0+margin+col*(pw+gap),y=N*starts[row],ph=N*heights[row];bevel(x,y,pw,ph,Math.max(3,bx*.38));
    gradient(x+bx*.5,y+by*.6,pw-bx,ph-by*1.2,[[0,'#0000001e'],[.1,'#ffffff0a'],[1,'#ffffff26']]);
   }
   const hx=leaves===2?(leaf===0?x0+lw-bx*.75:x0+bx*.75):x0+lw-bx*.85,hy=N*.53;
   c.fillStyle='#262a2c';c.beginPath();c.ellipse(hx+2,hy+3,6,9,0,0,Math.PI*2);c.fill();
   gradient(hx-4,hy-9,8,18,[[0,'#e5e5df'],[.4,'#899295'],[.55,'#f4f3eb'],[1,'#444c51']],false);
   gradient(hx-4,hy-2,Math.min(25,lw*.12),5,[[0,'#626c70'],[.45,'#f0efe4'],[1,'#727d80']]);
   fill(x0,by,1,N-by*2,'#00000055');
  }
  gradient(bx,N-by,N-2*bx,by*.7,[[0,'#8c9292'],[.3,'#e2e0d7'],[1,'#565e62']]);
 }else if(type==='garage'){
  const rows=Math.max(3,Math.min(6,Math.round(h/.52))),cols=Math.max(2,Math.min(8,Math.round(w/.65))),left=bx*.6,top=by*.6,iw=N-left*2,ih=N-top*2;
  fill(left,top,iw,ih,color);
  for(let row=0;row<rows;row++){
   const y=top+row*ih/rows,rh=ih/rows;gradient(left,y,iw,rh,[[0,'#ffffff40'],[.08,'#ffffff12'],[.9,'#00000008'],[1,'#0000003a']]);
   for(let col=0;col<cols;col++){const cw=iw/cols;bevel(left+col*cw+cw*.12,y+rh*.19,cw*.76,rh*.6,3);}
   fill(left,y+rh-2,iw,2,'#454b4a');fill(left,y+rh,iw,1,'#faf9ef');
  }
  for(const x of [N*.46,N*.54]){fill(x-2,N*.77,4,14,'#535957');fill(x-1,N*.77,1,13,'#c5ccc8');}
 }else{
  fill(bx,by,N-2*bx,N-2*by,'#3c4748');const rows=Math.max(5,Math.min(16,Math.round(h/.065)));for(let i=0;i<rows;i++){const y=by+i*(N-2*by)/rows,rh=(N-2*by)/rows;fill(bx,y,N-2*bx,rh*.78,color);gradient(bx,y,N-2*bx,rh*.78,[[0,'#ffffff66'],[.2,'#ffffff0a'],[1,'#00000066']]);}
 }
 // Subpixel paint variation prevents broad frame surfaces looking perfectly flat.
 for(let i=0;i<2200;i++){c.fillStyle=i%2?'#ffffff05':'#00000005';c.fillRect((i*137)%N,(i*73+Math.floor(i/N)*17)%N,1,1);}
 const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=4;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;t.userData||={};t.userData.exteriorFinishShared=true;t.userData.users=0;openingMaps.set(key,t);return t;
}
function pruneOpeningMaps(){for(const [key,t]of openingMaps){if(openingMaps.size<=48)break;if(!t.userData.users){openingMaps.delete(key);t.dispose();}}}
function bindOpeningMap(material,map){
 material.userData||={};const data=material.userData;if(data.openingMap!==map){if(data.openingMap)data.openingMap.userData.users--;data.openingMap=map;if(map)map.userData.users++;}
 if(!data.openingMapRelease&&material.addEventListener){data.openingMapRelease=true;material.addEventListener('dispose',()=>{if(data.openingMap){data.openingMap.userData.users--;data.openingMap=null;}pruneOpeningMaps();});}material.map=map;pruneOpeningMaps();
}
function prepare(mesh,face,points,parameters){
 if(!mesh.geometry?.setAttribute||!points?.length)return;
 if(face.feature)mesh.userData.renderedOpening={points:face.points||points,feature:face.feature,color:face.finishColor||null};
 const W=root.WallSolidGeometry;
 if(face.feature&&['window','skylight','door','garage','vent'].includes(face.feature.type)){
  const d=root.WallFeatures?.dimensions(face.points||points,face.feature);if(d){const uv=points.flatMap(p=>{const q=W.inFrame(d.frame,p);return [(q.x-d.bounds.left)/Math.max(1e-8,d.bounds.right-d.bounds.left),(q.y-d.bounds.bottom)/Math.max(1e-8,d.bounds.top-d.bounds.bottom)];});mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));mesh.userData.exteriorFinish={feature:true,featureType:face.feature.type,width:d.width*.3048,height:d.height*.3048,color:face.finishColor||null,normal:d.frame.n};return;}
 }
 if(face.openingTrim){
  const fr=W.faceFrame(face),a=face.points[0],b=face.points[1],length=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length,z:(b.z-a.z)/length},v={x:fr.n.y*u.z-fr.n.z*u.y,y:fr.n.z*u.x-fr.n.x*u.z,z:fr.n.x*u.y-fr.n.y*u.x},dot=(p,axis)=>(p.x-a.x)*axis.x+(p.y-a.y)*axis.y+(p.z-a.z)*axis.z,ys=points.map(p=>dot(p,v)),lo=Math.min(...ys),span=Math.max(...ys)-lo;
  mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(points.flatMap((p,i)=>[dot(p,u)/.6096,(ys[i]-lo)/Math.max(1e-8,span)]),2));mesh.userData.exteriorFinish={material:'opening-trim',trim:true,color:face.finishColor||null,normal:fr.n};mesh.userData.openingTrim=true;return;
 }
 const frame=W.faceFrame({points:face.points||points});let u=frame?.u||{x:1,y:0,z:0};
 if(frame&&Math.abs(frame.n.z)<.999){const length=Math.hypot(frame.n.x,frame.n.y);u={x:-frame.n.y/length,y:frame.n.x/length,z:0};}
 // Curved walls use arc length rather than a flattened projection, so boards
 // keep their width around the bend. Sampling here belongs only to rendering.
 let arcAt=null;const curve=face.curvedSurface?.start||face.curvedSurface?.curve;if(curve&&parameters){const K=root.ExteriorGeometry,lengths=[0];let previous=K.curvePoint(curve,0);for(let i=1;i<=128;i++){const p=K.curvePoint(curve,i/128);lengths.push(lengths.at(-1)+Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z));previous=p;}arcAt=t=>{const q=Math.max(0,Math.min(128,t*128)),i=Math.min(127,Math.floor(q));return lengths[i]+(lengths[i+1]-lengths[i])*(q-i);};}
 let axes=face.textureAxes;if(['shingles','soffit'].includes(face.material)&&frame){const n=frame.n.z<0?{x:-frame.n.x,y:-frame.n.y,z:-frame.n.z}:frame.n,l=Math.hypot(n.x,n.y),a=l>1e-8?{x:-n.y/l,y:n.x/l,z:0}:{x:1,y:0,z:0};axes={u:a,v:{x:n.y*a.z-n.z*a.y,y:n.z*a.x-n.x*a.z,z:n.x*a.y-n.y*a.x}};}const dot=(p,a)=>p.x*a.x+p.y*a.y+p.z*a.z;
 const horizontal=Math.abs(frame?.n.z||0)>.999,uv=points.flatMap((p,i)=>[(axes?dot(p,axes.u):arcAt?arcAt(parameters[i].x):p.x*u.x+p.y*u.y+p.z*u.z)/(face.material==='shingles'?.9144:.6096),(axes?dot(p,axes.v):horizontal?p.x*(frame?.v.x||0)+p.y*(frame?.v.y||1):p.z)/.6096]);
 mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));mesh.userData.exteriorFinish={material:face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':frame?.n.z<-.5?'soffit':'default'),color:face.finishColor||null,feature:!!face.feature,trim:!!face.trim,normal:frame?.n};
}
// Roof features stay in the roof model. These derived surfaces are presentation-only.
function roofSkylights(roof){
 const K=root.ExteriorGeometry,nodes=new Map(),edges=new Set();
 const key=p=>[p.x,p.y,p.z].map(v=>Math.round(v*10000)).join(':');
 for(const c of roof?.connections||[]){
  if((c.type?.id||c.type)!=='skylight')continue;
  const a=roof.points[c.startIdx],b=roof.points[c.endIdx];if(!K.finite3(a)||!K.finite3(b))continue;
  const ak=key(a),bk=key(b),edge=[ak,bk].sort().join('|');if(ak===bk||edges.has(edge))continue;edges.add(edge);
  for(const [k,p,other]of [[ak,a,bk],[bk,b,ak]]){if(!nodes.has(k))nodes.set(k,{point:{...p},neighbors:[]});nodes.get(k).neighbors.push(other);}
 }
 const visited=new Set(),out=[];
 for(const start of nodes.keys()){
  if(visited.has(start))continue;
  const component=[],stack=[start];while(stack.length){const k=stack.pop();if(visited.has(k))continue;visited.add(k);component.push(k);stack.push(...nodes.get(k).neighbors);}
  // Never invent missing edges or guess through a branch.
  if(component.length<3||component.some(k=>nodes.get(k).neighbors.length!==2))continue;
  const points=[];let previous=null,current=start;
  do{const node=nodes.get(current);points.push(node.point);const next=node.neighbors.find(k=>k!==previous);previous=current;current=next;}while(current!==start&&points.length<=component.length);
  if(current!==start||points.length!==component.length)continue;
  try{K.validateFace({points});}catch(_){continue;}
  const n=K.normal(points);if(!n||Math.abs(n.z)<.01)continue;if(n.z<0)points.reverse();
  const a=points[0],b=points[1];out.push({points,feature:{type:'skylight',axis:{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}}});
 }
 return out;
}
function roofPresentation(roof){
 const skylights=roofSkylights(roof),K=root.ExteriorGeometry,W=root.WallSolidGeometry;
 if(!skylights.length)return {faces:roof.faces,skylights};
 const faces=(roof.faces||[]).flatMap(face=>{
  const frame=W.faceFrame(face);if(!frame||Math.abs(frame.n.z)<.01)return [face];
  const cuts=skylights.filter(s=>s.points.every(p=>Math.abs(K.local(frame,p).z)<.15));
  if(!cuts.length||!K.intersection([face],cuts).length)return [face];
  const lift=p=>({...p,z:frame.origin.z-(frame.n.x*(p.x-frame.origin.x)+frame.n.y*(p.y-frame.origin.y))/frame.n.z});
  return K.difference(face,cuts).map(part=>({...face,points:part.points.map(lift),holes:(part.holes||[]).map(r=>r.map(lift))}));
 });
 return {faces,skylights};
}
function skylightMesh(face,vector){
 const geometry=new THREE.BufferGeometry().setFromPoints(face.points.map(vector));
 geometry.setIndex(root.ExteriorGeometry.triangles(face.points).triangles.flat());
 const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#88a5ad',side:THREE.DoubleSide}));
 mesh.name='roof-skylight';mesh.userData.pickLayer='roof';mesh.userData.exteriorFeature=true;
 prepare(mesh,face,face.points);return mesh;
}
function roofMeshes(face,vector,textured){
 const rings=[face.points,...(face.holes||[])],points=rings.flat(),positions=points.map(vector),projected=rings.map(r=>r.map(p=>new THREE.Vector2(p.x,p.y)));
 const triangles=THREE.ShapeUtils.triangulateShape(projected[0],projected.slice(1)).map(ids=>{const [a,b,c]=ids.map(i=>positions[i]),rise=vector({...points[ids[0]],z:points[ids[0]].z+1}),u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z},dot=(u.y*v.z-u.z*v.y)*(rise.x-a.x)+(u.z*v.x-u.x*v.z)*(rise.y-a.y)+(u.x*v.y-u.y*v.x)*(rise.z-a.z);return dot<0?[ids[0],ids[2],ids[1]]:ids;});
 return (textured?[false,true]:[false]).map(underside=>{
  const geometry=new THREE.BufferGeometry().setFromPoints(positions);geometry.setIndex(triangles.flat());
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#54cf86',side:textured?(underside?THREE.BackSide:THREE.FrontSide):THREE.DoubleSide,transparent:true,opacity:.1,depthWrite:false}));mesh.userData.pickLayer='roof';mesh.userData.roofUnderside=underside;
  prepare(mesh,{...face,material:underside?(face.soffitMaterial||'soffit'):'shingles',finishColor:underside?face.soffitColor:face.finishColor,textureAxes:face.textureAxes},points);return mesh;
 });
}
// r128 leaves CSS colors in sRGB, while tile visibility changes renderer output.
// Finish maps and tints use linear light internally and always emit display sRGB.
// A uniform restores the normal renderer policy when leaving textured mode.
function colorManagedFinish(material){
 material.userData||={};
 let enabled=material.userData.exteriorFinishColorManaged;
 if(!enabled){
  enabled=material.userData.exteriorFinishColorManaged={value:0};
  const compile=material.onBeforeCompile,key=material.customProgramCacheKey;
  material.onBeforeCompile=function(shader,renderer){
   compile?.call(this,shader,renderer);
   shader.uniforms.exteriorFinishColorManaged=enabled;
   shader.fragmentShader='uniform float exteriorFinishColorManaged;\n'+shader.fragmentShader.replace('#include <encodings_fragment>', 'if (exteriorFinishColorManaged > 0.5) { gl_FragColor = LinearTosRGB(gl_FragColor); } else {\n#include <encodings_fragment>\n}');
  };
  material.customProgramCacheKey=function(){return (key?.call(this)||'')+':exterior-finish-srgb-v1';};
  material.needsUpdate=true;
 }
 enabled.value=1;
}
function reset(material){const enabled=material.userData?.exteriorFinishColorManaged;if(enabled)enabled.value=0;}
function apply(mesh,material){
 const finish=mesh.userData.exteriorFinish||((mesh.userData.pickLayer==='walls'||mesh.userData.pickLayer==='base'||mesh.userData.baseId!==undefined)?{material:'default'}:null);
 if(!finish)return;if(finish.feature){if(finish.featureType){colorManagedFinish(material);material.color.set('#ffffff');bindOpeningMap(material,openingTexture(finish));}return;}
 // The construction base has its own neutral default, independent of cladding.
 const base=(mesh.userData.baseId!==undefined||mesh.userData.pickLayer==='base')&&!finish.trim&&['default','unassigned',undefined].includes(finish.material);
 const resolved=base?{material:'unassigned',color:finish.color||'#b3afa7'}:resolve(finish);
 colorManagedFinish(material);
 material.color.set(resolved.color);material.color.convertSRGBToLinear?.();
 const n=finish.normal;if(n)material.color.multiplyScalar(.78+.22*Math.abs(n.x*.37+n.y*.53+n.z*.76));
 material.map=['unassigned','chimney-top'].includes(resolved.material)?null:texture(resolved.material);
}
root.ExteriorFinishes={prepare,apply,reset,resolve,defaults,roofMeshes,roofSkylights,roofPresentation,skylightMesh};
})(window);
