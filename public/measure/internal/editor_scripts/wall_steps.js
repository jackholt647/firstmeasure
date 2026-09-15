/* Equal-rise staircase boundaries in a supporting face's plane. Metres. */
(function(root){
'use strict';
const W=typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):root.WallSolidGeometry;
const B=typeof module!=='undefined'&&module.exports?require('./base_geometry.js'):root.BaseGeometry;
const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
const EPS=1e-7,sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const length=p=>Math.hypot(p.x,p.y,p.z),distance=(a,b)=>length(sub(a,b)),scale=(v,k)=>({x:v.x*k,y:v.y*k,z:v.z*k}),cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const at=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function pattern(pair,frame,count=1,anchor=null,sizeScale=1){
 if(!Number.isSafeInteger(count)||count<1)throw Error('The step count must be a positive whole number.');
 if(!frame?.n||pair.length!==2||pair.some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Select a line on a planar face.');
 let up=sub({x:0,y:0,z:1},scale(frame.n,frame.n.z));if(length(up)<EPS)up={x:0,y:1,z:0};up=scale(up,1/length(up));let horizontal=cross(up,frame.n);horizontal=scale(horizontal,1/length(horizontal));
 if((Math.abs(horizontal.x)>EPS?horizontal.x:horizontal.y)<0)horizontal=scale(horizontal,-1);
 let [a,b]=pair;if(dot(sub(b,a),horizontal)<0)[a,b]=[b,a];const delta=sub(b,a),run=dot(delta,horizontal),rise=dot(delta,up);
 if(run<1e-5||Math.abs(rise)<1e-5)throw Error('Select a diagonal line; horizontal and vertical lines cannot be stepped.');
 if(Math.abs(dot(delta,frame.n))>1e-5)throw Error('The selected line must lie in its supporting face.');
 if(!Number.isFinite(sizeScale)||sizeScale<=0)throw Error('Step width must be positive.');
 const endMargin=Math.max(1e-4,run*1e-6),sections=count+1,spacing=Math.min(run/sections*sizeScale,count>1?(run-2*endMargin)/(count-1):run);
 if(Math.min(spacing,Math.abs(rise)/count)<1e-6)throw Error('These steps are smaller than the geometry precision. Escape resets the tool.');
 const reference=anchor==null?1/sections:typeof anchor==='number'?clamp(anchor,0,1):clamp(dot(sub(anchor,a),delta)/dot(delta,delta),0,1),scaled=reference*sections;
 let phase=scaled-Math.floor(scaled);if(phase<1e-9&&scaled>0)phase=1;if(scaled>count+1e-9)phase=Math.min(2,phase+1);
 // Keep the same reference riser while resizing. Recomputing its index from
 // the new spacing jumps the entire pattern by a tread at each index boundary.
 // End treads absorb the remaining run; original anchors keep their run position.
 let first=spacing*phase;
 if(sizeScale!==1){const referenceX=reference*run,index=clamp(Math.round(scaled-phase),0,count-1);first=clamp(referenceX-index*spacing,endMargin,run-spacing*(count-1)-endMargin);}
 const points=[],push=p=>{if(!points.length||distance(points[points.length-1],p)>EPS)points.push({...p});},point=(x,y)=>({x:a.x+horizontal.x*x+up.x*y,y:a.y+horizontal.y*x+up.y*y,z:a.z+horizontal.z*x+up.z*y});
 push(a);for(let i=0;i<count;i++){const x=first+spacing*i;push(point(x,rise*i/count));push(point(x,rise*(i+1)/count));}push(b);
 const distances=[0];for(let i=1;i<points.length;i++)distances.push(distances[i-1]+distance(points[i-1],points[i]));
 return {a:{...a},b:{...b},horizontal,up,run,rise,count,sections,spacing,sizeScale,phase,reference,anchor:at(a,b,reference),points,distances};
}
function wheelScale(value,e){const delta=Number(e.deltaY)*(e.deltaMode===1?16:e.deltaMode===2?800:1);return clamp((value||1)*Math.exp(-clamp(Number.isFinite(delta)?delta:0,-240,240)*.0001),.05,20);}
function parameter(p,t){const d=sub(t.b,t.a);return dot(sub(p,t.a),d)/dot(d,d);}
function onLine(p,t){const u=parameter(p,t);return u>=-EPS&&u<=1+EPS&&distance(p,at(t.a,t.b,u))<1e-5;}
function mapPoint(p,t){
 if(!onLine(p,t))return {point:{...p},progress:null};
 if(distance(p,t.a)<EPS)return {point:{...p,x:t.a.x,y:t.a.y,z:t.a.z},progress:0};if(distance(p,t.b)<EPS)return {point:{...p,x:t.b.x,y:t.b.y,z:t.b.z},progress:t.distances.at(-1)};
 const x=clamp(dot(sub(p,t.a),t.horizontal),0,t.run);let best=null;
 for(let i=1;i<t.points.length;i++){const a=t.points[i-1],b=t.points[i],xa=dot(sub(a,t.a),t.horizontal),xb=dot(sub(b,t.a),t.horizontal);if(x<Math.min(xa,xb)-EPS||x>Math.max(xa,xb)+EPS)continue;const v=sub(b,a),fraction=Math.abs(xb-xa)>EPS?clamp((x-xa)/(xb-xa),0,1):clamp(dot(sub(p,a),v)/dot(v,v),0,1),q=at(a,b,fraction),d=distance(p,q);if(!best||d<best.distance)best={point:{...p,...q},progress:t.distances[i-1]+fraction*length(v),distance:d};}
 return best;
}
function rewriteEdge(c,d,t){const output=[],push=p=>{if(!output.length||distance(output.at(-1),p)>EPS)output.push({...p});},tc=parameter(c,t),td=parameter(d,t);push(mapPoint(c,t).point);
 if(distance(c,at(t.a,t.b,tc))<1e-5&&distance(d,at(t.a,t.b,td))<1e-5&&Math.abs(tc-td)>EPS){const lo=Math.max(0,Math.min(tc,td)),hi=Math.min(1,Math.max(tc,td));if(hi-lo>EPS){
  const start=mapPoint(at(t.a,t.b,tc<td?lo:hi),t),end=mapPoint(at(t.a,t.b,tc<td?hi:lo),t),forward=end.progress>=start.progress;
  push(start.point);const indices=t.points.map((_,i)=>i).filter(i=>t.distances[i]>Math.min(start.progress,end.progress)+EPS&&t.distances[i]<Math.max(start.progress,end.progress)-EPS);if(!forward)indices.reverse();for(const i of indices)push(t.points[i]);push(end.point);
 }}push(mapPoint(d,t).point);return output;
}
function rewriteRing(ring,t){const out=[];for(let i=0;i<ring.length;i++)for(const p of rewriteEdge(ring[i],ring[(i+1)%ring.length],t))if(!out.length||distance(out.at(-1),p)>EPS)out.push(p);if(out.length>1&&distance(out[0],out.at(-1))<EPS)out.pop();return out;}
function validate(face){const frame=W.faceFrame(face);if(!frame)throw Error('Stepping would remove an adjoining face.');const rings=[face.points,...(face.holes||[])];
 for(const ring of rings){if(ring.some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>1e-5))throw Error('That step pattern would bend an adjoining face out of plane.');const local=ring.map(p=>W.inFrame(frame,p));try{B.validate({points:local});}catch{throw Error('These steps would cross another edge of the face. Add more steps or shift the reference point.');}}
 const local={points:face.points.map(p=>W.inFrame(frame,p))},holes=(face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p))),side=(a,b,p)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x),crosses=(a,b,c,d)=>side(a,b,c)*side(a,b,d)<-1e-12&&side(c,d,a)*side(c,d,b)<-1e-12;
 for(let k=0;k<holes.length;k++){const hole=holes[k];if(hole.some(p=>!G.contains(local,p))||[local.points,...holes.slice(0,k)].some(other=>hole.some((p,i)=>other.some((q,j)=>crosses(p,hole[(i+1)%hole.length],q,other[(j+1)%other.length])))))throw Error('The steps would cross an opening in the face.');}
}
function apply(faces,t){const affected=[],moves=[];const next=faces.map(f=>{
 if(f.deleted||f.snapOnly)return f;const points=rewriteRing(f.points,t),holes=(f.holes||[]).map(r=>rewriteRing(r,t)),retainedPoints=(f.retainedPoints||[]).map(p=>mapPoint(p,t).point);
 if(JSON.stringify(points)===JSON.stringify(f.points)&&JSON.stringify(holes)===JSON.stringify(f.holes||[])&&JSON.stringify(retainedPoints)===JSON.stringify(f.retainedPoints||[]))return f;
 const result={...f,points,holes,retainedPoints,stepOverrides:[...(f.stepOverrides||[]),{count:t.count,reference:t.reference,sizeScale:t.sizeScale,points:t.points.map(p=>({...p}))}]};validate(result);affected.push(f.id);for(const p of [...f.points,...(f.holes||[]).flat(),...(f.retainedPoints||[])])if(onLine(p,t)){const q=mapPoint(p,t).point;if(distance(p,q)>EPS&&!moves.some(m=>distance(m.from,p)<EPS))moves.push({from:p,to:q});}return result;
 });return {faces:next,affected,moves};}

// Terrace along the slope, aligned to a nearby foundation axis when available. Keep the smooth
// supporting plane as the editable pattern, and materialize horizontal treads.
function basePattern(base,faceId,count=1,anchor=null,sizeScale=1,{alignToBoundary=true}={}){
 const K=typeof module!=='undefined'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry,S=typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):root.BaseSketchGeometry,copy=v=>JSON.parse(JSON.stringify(v));
 const selected=base.faces.find(f=>f.id===faceId);if(!selected)throw Error('Select a base face first.');
 const id=selected.baseStepId||selected.id,previous=base.stepPatterns?.[id],source=previous?.source||selected,pl=G.plane(source.points),grade=pl&&Math.hypot(pl.dx,pl.dy);
 if(!grade||grade<1e-6)throw Error('Pitch the base first, then press S to turn its slope into steps.');
 const downhill={x:pl.dx/grade,y:pl.dy/grade},alignment=alignToBoundary&&B.boundaryAxis(source,downhill),u=alignment?alignment.direction:downhill,slope=pl.dx*u.x+pl.dy*u.y,c=B.center(source),intercept=pl.dx*c.x+pl.dy*c.y+pl.k-slope*(c.x*u.x+c.y*u.y);
 const members=base.faces.filter(f=>f.id===faceId||f.baseStepId===id),regions=K.union(members),v={x:-u.y,y:u.x},all=regions.flatMap(f=>f.points),xs=all.map(p=>p.x*u.x+p.y*u.y),ys=all.map(p=>p.x*v.x+p.y*v.y),lo=Math.min(...xs),hi=Math.max(...xs),low=Math.min(...ys)-1,high=Math.max(...ys)+1;
 const point=(x,y,z)=>({x:u.x*x+v.x*y,y:u.y*x+v.y*y,z:z??slope*x+intercept}),pair=[point(lo,0),point(hi,0)],t=pattern(pair,{n:{x:v.x,y:v.y,z:0}},count,anchor,sizeScale);
 const pieces=[];
 for(let i=1;i<t.points.length;i++){const a=t.points[i-1],b=t.points[i];if(Math.abs(a.z-b.z)>1e-7)continue;const x0=a.x*u.x+a.y*u.y,x1=b.x*u.x+b.y*u.y;if(Math.abs(x1-x0)<1e-6)continue;
  const band={points:[point(Math.min(x0,x1),low),point(Math.max(x0,x1),low),point(Math.max(x0,x1),high),point(Math.min(x0,x1),high)]};for(const region of K.intersection(regions,[band])){
   for(const ring of K.pieces([region]))pieces.push({...copy(selected),id:pieces.length?id+':step-'+pieces.length:faceId,baseStepId:id,points:ring.map(p=>({x:p.x,y:p.y,z:a.z})),holes:[]});
  }
 }
 if(!pieces.length)throw Error('The step pattern does not intersect the base.');
 const area=fs=>fs.reduce((n,f)=>n+K.area(f),0);if(Math.abs(area(pieces)-area(regions))>Math.max(1e-6,area(regions)*1e-7))throw Error('The steps must cover the whole base.');
 const next=copy(base),ids=new Set(members.map(f=>f.id));next.faces=[...next.faces.filter(f=>!ids.has(f.id)),...pieces];next.stepPatterns||={};next.stepPatterns[id]={source:copy(source),count,reference:t.reference,sizeScale:t.sizeScale};
 // Map old anchors onto all new supporting treads, never across their risers.
 const before=copy(base);for(const f of before.faces.filter(f=>ids.has(f.id)))f.id=id;
 const transfer=copy(next);for(const f of transfer.faces.filter(f=>f.baseStepId===id))f.id=id;
 // Rebind uses face IDs for ownership; keep original IDs after transfer.
 const names=next.faces.map(f=>f.id);S.rebind(before,transfer);transfer.faces.forEach((f,i)=>f.id=names[i]);transfer.stepPatterns=next.stepPatterns;
 return {base:transfer,pattern:t,alignedToBoundary:!!alignment};
}
const api={wheelScale,basePattern,pattern,apply,mapPoint,rewriteEdge,rewriteRing,onLine};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallSteps=api;
})(typeof window!=='undefined'?window:globalThis);
