/* Align nearly flush generated exterior walls to an authoritative chimney side. */
(function(root){
'use strict';
const common=typeof module==='object'&&module.exports;
const G=common?require('./wall_geometry.js'):root.WallGeometry;
const R=common?require('./wall_rake_cleanup.js'):root.WallRakeCleanup;
const copy=v=>JSON.parse(JSON.stringify(v)),sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const dot=(a,b)=>a.x*b.x+a.y*b.y,cross=(a,b)=>a.x*b.y-a.y*b.x;
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const at=(p,a,b)=>dot(sub(p,a),sub(b,a))/dot(sub(b,a),sub(b,a));
const TOLERANCE=6*.0254,EPS=1e-6;
function floorAt(ground,p){
 if(typeof ground==='number')return ground;
 for(const ids of ground?.faces||[]){const points=ids.map(i=>ground.points[i]),plane=G.plane(points);if(plane&&G.contains({points},p))return plane.dx*p.x+plane.dy*p.y+plane.k;}
 return null;
}
function inward(w,sources){
 const s=sources.find(s=>s.id===w.sourceId);if(!s?.originalA||!s.originalB||s.setback<=0)return null;
 const v=sub(s.originalB,s.originalA),l=Math.hypot(v.x,v.y),n={x:-v.y/l,y:v.x/l};
 if(dot(sub(s.a,s.originalA),n)<0){n.x*=-1;n.y*=-1;}return n;
}
function cleanup(walls,sources,chimneys,ground,excluded=[]){
 let result=copy(walls);const blocked=new Set(excluded),alignments=[],patches=[],visited=new Set();
 // A whole connected coplanar run moves, including subdivisions at roof ridges.
 for(const seed of result){
  if(visited.has(seed.id)||seed.chimney||seed.kind!=='perimeter')continue;
  const normal=inward(seed,sources);if(!normal)continue;
  const group=[seed],ids=new Set([seed.id]);
  for(let i=0;i<group.length;i++)for(const w of result){
   if(ids.has(w.id)||w.chimney)continue;
   if(!w.bottom.every(p=>Math.abs(dot(sub(p,seed.bottom[0]),normal))<.001))continue;
   if(!w.bottom.some(p=>group[i].bottom.some(q=>dist(p,q)<.002)))continue;
   ids.add(w.id);group.push(w);
  }
  group.forEach(w=>visited.add(w.id));
  if(group.some(w=>blocked.has(w.id)||w.bottom.some(p=>{const z=floorAt(ground,p);return z===null||Math.abs(z-p.z)>.02;})))continue;
  const candidates=[];
  for(const chimney of chimneys)for(let side=0;side<chimney.points.length;side++){
   const a=chimney.points[side],b=chimney.points[(side+1)%chimney.points.length],v=sub(b,a),length=dist(a,b);
   if(length<.05)continue;
   const orientation=Math.sign(chimney.points.reduce((s,p,i)=>s+cross(p,chimney.points[(i+1)%chimney.points.length]),0));
   const n={x:-v.y/length*orientation,y:v.x/length*orientation};
   if(dot(n,normal)<Math.cos(2*Math.PI/180))continue;
   const offsets=group.flatMap(w=>w.bottom.map(p=>dot(sub(a,p),n)));
   // Increase the soffit only. An outward-projecting chimney is not a drafting return.
   if(Math.min(...offsets)<-EPS||Math.max(...offsets)>TOLERANCE+EPS||Math.max(...offsets)<EPS)continue;
   const overlap=group.reduce((sum,w)=>{const ts=w.bottom.map(p=>at(p,a,b)).sort((a,b)=>a-b);return sum+Math.max(0,Math.min(1,ts[1])-Math.max(0,ts[0]))*length;},0);
   if(overlap<.05)continue;
   candidates.push({chimneyId:chimney.id,side,a,b,n,offset:Math.max(...offsets)});
  }
  if(!candidates.length)continue;
  const target=candidates.sort((a,b)=>a.offset-b.offset)[0];
  // Conflicting nearby chimneys are evidence that the side is not one common plane.
  if(candidates.some(c=>[c.a,c.b].some(p=>Math.abs(dot(sub(p,target.a),target.n))>.002)))continue;
  const moves=[],columns=[];let valid=true;
  for(const w of group)for(let j=0;j<2;j++){
   const p=w.bottom[j];if(columns.some(q=>dist(p,q)<.002))continue;columns.push(p);
   const members=result.flatMap(w=>w.bottom.map((p,j)=>({w,j,p}))).filter(c=>dist(c.p,p)<.002&&Math.abs(c.p.z-p.z)<.02&&Math.abs(c.w.top[c.j].z-w.top[j].z)<.02);
   if(members.some(c=>blocked.has(c.w.id))){valid=false;break;}
   const stationary=members.filter(c=>!ids.has(c.w.id)),amount=dot(sub(target.a,p),target.n);
   let point={...p,x:p.x+target.n.x*amount,y:p.y+target.n.y*amount};const hits=[];
   for(const c of stationary){
    const v=sub(c.w.bottom[1],c.w.bottom[0]),den=dot(v,target.n);if(Math.abs(den)<EPS){valid=false;break;}
    const t=dot(sub(target.a,c.w.bottom[0]),target.n)/den,hit=mix(...c.w.bottom,t),len=dist(...c.w.bottom);
    if((c.j===0&&t>=1-.005/len)||(c.j===1&&t<=.005/len)||dist(hit,p)>TOLERANCE+.002){valid=false;break;}hits.push(hit);
   }
   if(!valid)break;
   if(hits.length){point=hits[0];if(hits.some(q=>dist(q,point)>.002)){valid=false;break;}}
   const moved=members.filter(c=>ids.has(c.w.id));
   const top=stationary.length?Math.min(...stationary.map(c=>mix(...c.w.top,at(point,...c.w.bottom)).z)):
    Math.min(...moved.map(c=>{const plane=sources.find(s=>s.id===c.w.sourceId)?.sourcePlane;return c.w.top[c.j].z+(plane?plane.dx*(point.x-c.p.x)+plane.dy*(point.y-c.p.y):0);}));
   const bottom=floorAt(ground,point);if(bottom===null||top-bottom<.02){valid=false;break;}
   moves.push({members,bottom:{...point,z:bottom},top:{...point,z:top}});
  }
  if(!valid)continue;
  const prior=group.map(w=>({id:w.id,bottom:copy(w.bottom)}));
  for(const move of moves)for(const c of move.members){c.w.bottom[c.j]=copy(move.bottom);c.w.top[c.j]=copy(move.top);}
  for(const old of prior){const w=result.find(w=>w.id===old.id);patches.push({oldPath:old.bottom,points:[...old.bottom,...copy(w.bottom).reverse()]});}
  alignments.push({chimneyId:target.chimneyId,side:target.side,wallIds:[...ids],sourceIds:group.map(w=>w.sourceId),maxShift:target.offset});
 }
 if(alignments.length){result.forEach(w=>delete w.mergeGroup);result=G.mergeCoplanar(result,excluded).walls;}
 return {walls:result,report:{version:1,tolerance:TOLERANCE,alignments,paths:[],foundationPatches:patches}};
}
// After chimney clipping, join the now-coplanar lower side with its wall.
// Keep editable records/IDs; only their common rendered boundary is merged.
function compose(walls,report,excluded=[]){
 const result=copy(walls),blocked=id=>excluded.some(k=>id===k||id.startsWith(k+':'));
 for(const a of report?.alignments||[]){
  const batches=new Map();
  for(const w of result){
   if(blocked(w.id)||!(a.sourceIds.includes(w.sourceId)||w.chimney?.id===a.chimneyId&&w.chimney.side===a.side))continue;
   const key=JSON.stringify([w.material||'default',w.color||null]);
   if(!batches.has(key))batches.set(key,[]);batches.get(key).push(w);
  }
  for(const batch of batches.values())for(const w of G.mergeCoplanar(batch).walls)Object.assign(result.find(p=>p.id===w.id),w);
 }
 return result;
}
const api={cleanup,compose,foundation:R.foundation,TOLERANCE};if(common)module.exports=api;else root.WallChimneyCleanup=api;
})(typeof window!=='undefined'?window:globalThis);
