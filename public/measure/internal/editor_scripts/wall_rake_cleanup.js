/* Final generated-wall simplification. Never changes the roof drawing. */
(function(root){
'use strict';
const common=typeof module==='object'&&module.exports;
const G=common?require('./wall_geometry.js'):root.WallGeometry;
const K=common?require('./exterior_geometry.js'):root.ExteriorGeometry;
const copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),cross=(a,b)=>a.x*b.y-a.y*b.x;
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const at=(p,a,b)=>{const v=sub(b,a);return ((p.x-a.x)*v.x+(p.y-a.y)*v.y)/(v.x*v.x+v.y*v.y);};
function groundAt(ground,p){
 if(typeof ground==='number')return ground;
 for(const ids of ground?.faces||[]){const points=ids.map(i=>ground.points[i]),plane=G.plane(points);if(plane&&G.contains({points},p))return plane.dx*p.x+plane.dy*p.y+plane.k;}
 return null;
}
function parallel(a,b){return Math.abs(cross(sub(a.b,a.a),sub(b.b,b.a)))/(dist(a.a,a.b)*dist(b.a,b.b))<.02;}
// Assemble floor-contact runs, splitting overlaps before collapsing only
// collinear degree-two junctions. Roof-height subdivisions are not corners.
function runs(walls,ground){
 const floor=walls.filter(w=>!w.chimney&&w.bottom.every(p=>{const z=groundAt(ground,p);return z!==null&&Math.abs(z-p.z)<.02;}));
 const nodes=[],node=p=>{let i=nodes.findIndex(q=>dist(p,q)<.002);if(i<0){i=nodes.length;nodes.push(copy(p));}return i;};
 for(const w of floor)w.bottom.forEach(node);
 const edges=new Map();
 for(const w of floor){const cuts=nodes.map((p,i)=>({i,t:at(p,...w.bottom),p})).filter(c=>c.t>=-1e-6&&c.t<=1+1e-6&&dist(c.p,mix(...w.bottom,c.t))<.002).sort((a,b)=>a.t-b.t);
  for(let i=1;i<cuts.length;i++){const a=cuts[i-1].i,b=cuts[i].i;if(a===b)continue;const key=[a,b].sort((a,b)=>a-b).join(':');if(edges.has(key))edges.get(key).ids.add(w.id);else edges.set(key,{a,b,ids:new Set([w.id])});}
 }
 let list=[...edges.values()],changed=true;
 while(changed){changed=false;for(let n=0;n<nodes.length;n++){
  const joined=list.filter(e=>e.a===n||e.b===n);if(joined.length!==2)continue;
  const [a,b]=joined,x=a.a===n?a.b:a.a,y=b.a===n?b.b:b.a;
  if(x===y||!G.onEdge(nodes[n],nodes[x],nodes[y],.002))continue;
  list=list.filter(e=>e!==a&&e!==b);list.push({a:x,b:y,ids:new Set([...a.ids,...b.ids])});changed=true;break;
 }}
 return list.map(e=>({a:nodes[e.a],b:nodes[e.b],ids:[...e.ids]}));
}
// Once a return is removed, its flashing can no longer establish the soffit
// for an entire gable. Re-infer that run without the discarded evidence, then
// move its plane and intersect both adjoining walls with the corrected plane.
function restoreSoffits(walls,sources,removedSources,ground,blocked){
 const result=copy(walls),corrections=[],patches=[],pending=[];
 for(const s of sources){const next=G.soffitWithoutSources(s,sources,removedSources);
  if(!next)continue;
  // Collinear source runs can change roof pitch at the ridge.
  const matching=pending.find(g=>Math.abs(g.before-s.setback)<.002&&
   [s.originalA,s.originalB].every(p=>Math.abs((p.x-g.source.originalA.x)*g.normal.x+(p.y-g.source.originalA.y)*g.normal.y)<.002)&&
   g.normal.x*next.normal.x+g.normal.y*next.normal.y>.9999);
  if(matching){matching.sources.push(s);matching.choices.push({...next,source:s});}
  else pending.push({source:s,sources:[s],choices:[{...next,source:s}],before:s.setback,normal:next.normal});
 }
 for(const group of pending){
  const authority=group.choices.sort((a,b)=>Number(b.inferred)-Number(a.inferred)||dist(b.source.originalA,b.source.originalB)-dist(a.source.originalA,a.source.originalB))[0];
  group.after=authority.setback;if(Math.abs(group.after-group.before)<.002)continue;
  const ids=new Set(group.sources.map(s=>s.id)),affected=result.filter(w=>ids.has(w.sourceId));if(!affected.length)continue;
  const delta={x:group.normal.x*(group.after-group.before),y:group.normal.y*(group.after-group.before)},columns=[],moves=[];
  let valid=true;
  for(const w of affected)for(let i=0;i<2;i++){
   const p=w.bottom[i];if(columns.some(c=>dist(c.p,p)<.002))continue;
   const members=result.flatMap(w=>w.bottom.map((p,j)=>({w,j,p}))).filter(c=>dist(c.p,p)<.002&&Math.abs(c.p.z-p.z)<.02&&Math.abs(c.w.top[c.j].z-w.top[i].z)<.02);
   columns.push({p,members});
  }
  for(const {p,members}of columns){
   if(members.some(c=>blocked.has(c.w.id))){valid=false;break;}
   const moved=members.filter(c=>ids.has(c.w.sourceId)),stationary=members.filter(c=>!ids.has(c.w.sourceId));
   const line=moved[0].w.bottom.map(p=>({...p,x:p.x+delta.x,y:p.y+delta.y})),u=sub(line[1],line[0]);
   let point={...p,x:p.x+delta.x,y:p.y+delta.y},hits=[];
   for(const c of stationary){const v=sub(c.w.bottom[1],c.w.bottom[0]),den=cross(u,v);if(Math.abs(den)<1e-8){valid=false;break;}
    const t=cross(sub(c.w.bottom[0],line[0]),v)/den,hit=mix(...line,t),q=at(hit,...c.w.bottom),len=dist(...c.w.bottom);
    if((c.j===0&&q>=1-.005/len)||(c.j===1&&q<=.005/len)||dist(hit,p)>4*Math.hypot(delta.x,delta.y)+.01){valid=false;break;}hits.push(hit);
   }
   if(!valid)break;
   if(hits.length){point=hits[0];if(hits.some(q=>dist(point,q)>.002)){valid=false;break;}}
   const top=stationary.length?Math.min(...stationary.map(c=>mix(...c.w.top,at(point,...c.w.bottom)).z)):
    Math.min(...moved.map(c=>{const plane=group.sources.find(s=>s.id===c.w.sourceId)?.sourcePlane;return c.w.top[c.j].z+(plane?plane.dx*(point.x-c.p.x)+plane.dy*(point.y-c.p.y):0);}));
   const bottom=groundAt(ground,point);if(bottom===null||top-bottom<.02){valid=false;break;}
   moves.push({members,bottom:{...point,z:bottom},top:{...point,z:top}});
  }
  if(!valid)continue;
  const prior=affected.map(w=>({id:w.id,bottom:copy(w.bottom)}));
  for(const move of moves)for(const c of move.members){c.w.bottom[c.j]=copy(move.bottom);c.w.top[c.j]=copy(move.top);}
  for(const old of prior){const w=result.find(w=>w.id===old.id);patches.push({oldPath:old.bottom,points:[...old.bottom,...copy(w.bottom).reverse()]});}
  corrections.push({sourceIds:[...ids],before:group.before,after:group.after});
 }
 return {walls:result,corrections,patches};
}
function cleanup(walls,sources,ground,excluded=[]){
 let result=copy(walls);const paths=[],skippedEdited=new Set(),blocked=new Set(excluded),source=new Map(sources.map(s=>[s.id,s]));
 const sourceOf=w=>source.get(w.sourceId),members=r=>result.filter(w=>r.ids.includes(w.id));
 // A short measured return can disappear entirely after setback clipping.
 // Reconnect staggered parallel runs only when the original flashing chain
 // proves they were neighbors and the missing cross-edge fits in the soffit.
 let openRuns=runs(result,ground);
 const endOpen=p=>openRuns.filter(r=>[r.a,r.b].some(q=>dist(p,q)<.002)).length===1;
 const normal=s=>{const v=sub(s.originalB,s.originalA),len=dist(s.originalA,s.originalB),n={x:-v.y/len,y:v.x/len};if((s.a.x-s.originalA.x)*n.x+(s.a.y-s.originalA.y)*n.y<0){n.x*=-1;n.y*=-1;}return n;};
 const guides=[...new Map([...sources.filter(s=>s.kind==='flashing'),...sources.flatMap(s=>s.outerEnvelope?.returnGuides||[])].map(s=>[s.id,s])).values()];
 const usedRuns=new Set();
 // Measured roof returns can also clip a short hole out of one continuous
 // source. Bridge that hole only with matching source provenance and a nearby
 // flashing guide; never infer a connection across arbitrary open wall ends.
 for(let i=0;i<openRuns.length;i++)for(let j=i+1;j<openRuns.length;j++){
  const a=openRuns[i],b=openRuns[j];if(usedRuns.has(a)||usedRuns.has(b))continue;
  const am=members(a),bm=members(b),pairs=am.flatMap(w=>bm.map(v=>({w,v,s:sourceOf(w),t:sourceOf(v)})));
  const match=pairs.find(({s,t})=>s?.originalA&&s.originalB&&t?.originalA&&t.originalB&&s.setback>0&&[s.originalA,s.originalB].every(p=>[t.originalA,t.originalB].some(q=>dist(p,q)<.002)));
  if(!match)continue;
  const pair=[a.a,a.b].flatMap(p=>[b.a,b.b].map(q=>({p,q,d:dist(p,q)}))).sort((a,b)=>a.d-b.d)[0],{p,q}=pair,limit=match.s.setback;
  if(pair.d<.005||pair.d>limit||!endOpen(p)||!endOpen(q))continue;
  const len=dist(a.a,a.b);if(Math.abs(cross(sub(p,a.a),sub(a.b,a.a)))/len>.002||Math.abs(cross(sub(q,a.a),sub(a.b,a.a)))/len>.002)continue;
  const farA=dist(p,a.a)<.002?a.b:a.a,farB=dist(q,b.a)<.002?b.b:b.a;
  if((farA.x-p.x)*(q.x-p.x)+(farA.y-p.y)*(q.y-p.y)>=0||(farB.x-q.x)*(p.x-q.x)+(farB.y-q.y)*(p.y-q.y)>=0)continue;
  const nearby=(p,g)=>dist(p,mix(g.a,g.b,Math.max(0,Math.min(1,at(p,g.a,g.b)))))<=limit;
  if(!guides.some(g=>g.parentId===match.s.parentId&&nearby(p,g)&&nearby(q,g)))continue;
  if([...am,...bm].some(w=>blocked.has(w.id))){skippedEdited.add([a.ids[0],b.ids[0]].sort().join('|'));continue;}
  const wa=am.find(w=>G.onEdge(p,...w.bottom,.002)),wb=bm.find(w=>G.onEdge(q,...w.bottom,.002));if(!wa||!wb)continue;
  const bridge={...copy(wa),id:wa.id+':source-gap',bottom:[copy(p),copy(q)],top:[{...p,z:mix(...wa.top,at(p,...wa.bottom)).z},{...q,z:mix(...wb.top,at(q,...wb.bottom)).z}],soffitReturn:true};
  result.push(bridge);usedRuns.add(a);usedRuns.add(b);paths.push({coveredSourceGap:true,removedIds:[],oldPath:[copy(p),copy(q)],intersection:mix(p,q,.5),soffit:limit});
 }
 // A covered gap can join two fragments of the next return candidate.
 openRuns=runs(result,ground);usedRuns.clear();
 for(let i=0;i<openRuns.length;i++)for(let j=i+1;j<openRuns.length;j++){
  let a=openRuns[i],b=openRuns[j];if(usedRuns.has(a)||usedRuns.has(b))continue;
  let sa=sourceOf(members(a).find(w=>sourceOf(w)?.originalA)||{}),sb=sourceOf(members(b).find(w=>sourceOf(w)?.originalA)||{});
  if(!sa?.originalA||!sa.originalB||!sb?.originalA||!sb.originalB||sa.setback<=0||sb.setback<=0||!parallel(sa,sb))continue;
  const na=normal(sa),nb=normal(sb);if(na.x*nb.x+na.y*nb.y<.999)continue;
  // Keep the longer run when choosing where the closing return joins.
  // This trims an endpoint only; it never changes either soffit plane.
  if(dist(sa.originalA,sa.originalB)>dist(sb.originalA,sb.originalB)){[a,b]=[b,a];[sa,sb]=[sb,sa];}
  const pair=[a.a,a.b].flatMap(p=>[b.a,b.b].map(q=>({p,q,d:dist(p,q)}))).sort((a,b)=>a.d-b.d)[0],{p,q}=pair,limit=Math.min(sa.setback,sb.setback);
  if(pair.d<.005||pair.d>Math.SQRT2*limit+.002||!endOpen(p)||!endOpen(q))continue;
  const h=mix(a.a,a.b,at(q,a.a,a.b)),t=at(h,a.a,a.b);
  if(t<=.005/dist(a.a,a.b)||t>=1-.005/dist(a.a,a.b)||dist(h,q)<.005||dist(h,q)>limit||dist(p,h)>limit+.002)continue;
  const farA=dist(p,a.a)<.002?a.b:a.a,farB=dist(q,b.a)<.002?b.b:b.a;
  const u=sub(p,farA),v=sub(q,farB);if((u.x*v.x+u.y*v.y)/(dist(p,farA)*dist(q,farB))>-.999)continue;
  const start=[sa.originalA,sa.originalB].sort((x,y)=>dist(x,p)-dist(y,p))[0],end=[sb.originalA,sb.originalB].sort((x,y)=>dist(x,q)-dist(y,q))[0];
  // The original roof return includes the offset between these wall planes.
  // Bound each leg of the new join separately, allowing a diagonal corner.
  const chainQueue=[{point:start,ids:[]}];let chain=null;
  for(let k=0;k<chainQueue.length&&k<64;k++){
   const step=chainQueue[k],d=dist(step.point,end);
   if(step.ids.length&&d>.005&&d<=limit+dist(h,q)+.01&&Math.abs((step.point.x-end.x)*u.x+(step.point.y-end.y)*u.y)/dist(p,farA)<.02){chain=step.ids;break;}
   for(const g of guides){if(step.ids.includes(g.id))continue;for(const [x,y]of [[g.a,g.b],[g.b,g.a]])if(dist(x,step.point)<.01&&Math.abs(x.z-step.point.z)<.05)chainQueue.push({point:y,ids:[...step.ids,g.id]});}
  }
  if(!chain)continue;
  const affected=members(a),discard=result.filter(w=>chain.includes(w.sourceId)),transaction=[...affected,...members(b),...discard];
  if(transaction.some(w=>blocked.has(w.id))){skippedEdited.add([a.ids[0],b.ids[0]].sort().join('|'));continue;}
  const support=affected.find(w=>G.onEdge(h,...w.bottom,.002)),other=members(b).find(w=>G.onEdge(q,...w.bottom,.002));if(!support||!other)continue;
  const z=groundAt(ground,h);if(z===null)continue;
  const top=mix(...support.top,at(h,...support.bottom)),qTop=mix(...other.top,at(q,...other.bottom));
  const keep=p=>((p.x-h.x)*(farA.x-h.x)+(p.y-h.y)*(farA.y-h.y))>=-1e-8;
  const replacement=[];for(const w of affected){const next=copy(w),side=next.bottom.map(keep);if(!side.some(Boolean))continue;for(let k=0;k<2;k++)if(!side[k]){next.bottom[k]={...h,z};next.top[k]={...h,z:top.z};}replacement.push(next);}
  const removedIds=[...affected,...discard].map(w=>w.id),remove=new Set(removedIds);
  const bridge={...copy(support),id:support.id+':soffit-return',kind:'return',bottom:[{...h,z},copy(q)],top:[{...h,z:top.z},{...q,z:qTop.z}],soffitReturn:true};
  result=result.filter(w=>!remove.has(w.id));result.push(...replacement,bridge);usedRuns.add(a);usedRuns.add(b);
  paths.push({parallelReturn:true,removedIds,oldPath:[copy(p),copy(q)],intersection:copy(h),soffit:limit});
 }
 // A larger explicit setback can carry the main inset run across the outer
 // rake before extrusion. The little eave/inner-rake return is then a spur,
 // not a degree-two detour. Recognize that same roof-edge pattern by provenance.
 const samePoint=(a,b)=>a&&b&&dist(a,b)<.01&&Math.abs(a.z-b.z)<.05;
 const original=s=>[s.originalA,s.originalB];
 const sameRun=(a,b)=>a.originalA&&b.originalA&&original(a).every(p=>original(b).some(q=>samePoint(p,q)));
 for(const eave of sources.filter(s=>s.type==='eave'&&s.setback>0&&s.originalA)){
  const limit=eave.setback;if(dist(eave.a,eave.b)>limit+.002)continue;
  const incident=sources.filter(s=>s.type==='rake'&&s.setback>0&&s.originalA&&original(s).some(p=>original(eave).some(q=>samePoint(p,q))));
  for(const outer of incident){
   if(dist(...original(outer))<Math.max(.5,2*limit))continue;
   const inner=incident.find(s=>!sameRun(s,outer)&&parallel(s,outer)&&dist(...original(s))<=2*limit&&dist(s.a,s.b)<=limit+.002);if(!inner)continue;
   const n=sub(outer.a,outer.originalA),outerCorner=[outer.a,outer.b].sort((a,b)=>Math.min(dist(a,eave.a),dist(a,eave.b))-Math.min(dist(b,eave.a),dist(b,eave.b)))[0];
   if((inner.a.x-outer.a.x)*n.x+(inner.a.y-outer.a.y)*n.y<=.00001)continue;
   const outerWalls=result.filter(w=>sameRun(sourceOf(w)||{},outer)&&w.bottom.every(p=>Math.abs(cross(sub(p,outer.a),sub(outer.b,outer.a)))/dist(outer.a,outer.b)<.01));
   for(const anchor of sources.filter(s=>s.kind==='perimeter'&&s.originalA&&!sameRun(s,outer)&&!sameRun(s,inner)&&dist(...original(s))>Math.max(.5,2*limit))){
    const u=sub(anchor.b,anchor.a),v=sub(outer.b,outer.a),den=cross(u,v);if(Math.abs(den)<1e-8)continue;
    const t=cross(sub(outer.a,anchor.a),v)/den,hit=mix(anchor.a,anchor.b,t);if(dist(hit,outerCorner)>limit+.002)continue;
    const anchorWalls=result.filter(w=>sameRun(sourceOf(w)||{},anchor)&&w.bottom.every(p=>Math.abs(cross(sub(p,anchor.a),u))/dist(anchor.a,anchor.b)<.01));
    if(!anchorWalls.length||!outerWalls.length)continue;
    // This pass handles an already crossed run only. The detour walk below
    // handles genuine extensions; do not guess across disconnected walls.
    const span=anchorWalls.flatMap(w=>w.bottom).map(p=>at(p,anchor.a,anchor.b));if(t<Math.min(...span)-.002/dist(anchor.a,anchor.b)||t>Math.max(...span)+.002/dist(anchor.a,anchor.b))continue;
    const far=anchorWalls.flatMap(w=>w.bottom.map((p,i)=>({w,i,p}))).sort((a,b)=>dist(b.p,hit)-dist(a.p,hit))[0];
    const target=outerWalls.find(w=>G.onEdge(hit,...w.bottom,.01));if(!target||dist(far.p,hit)<Math.max(.5,2*limit))continue;
    const near=1-far.i,di=dist(target.bottom[0],outerCorner)<dist(target.bottom[1],outerCorner)?0:1;
    const removed=new Set(result.filter(w=>sameRun(sourceOf(w)||{},eave)||sameRun(sourceOf(w)||{},inner)).map(w=>w.id));
    for(const w of anchorWalls)removed.add(w.id);
    for(const w of result)if(w.kind==='flashing'&&w.sourceRoofId===eave.parentId&&w.targetId===far.w.sourceRoofId&&w.bottom.every(p=>dist(p,outerCorner)<2*limit))removed.add(w.id);
    if([...removed,target.id].some(id=>blocked.has(id))){skippedEdited.add([far.w.id,target.id].sort().join('|'));continue;}
    const z=groundAt(ground,hit),top=mix(...target.top,at(hit,...target.bottom)).z;if(z===null||top-z<.02)continue;
    const nextA=copy(far.w),nextD=copy(target);nextA.bottom[near]={...hit,z};nextA.top[near]={...hit,z:top};nextD.bottom[di]={...hit,z};nextD.top[di]={...hit,z:top};
    nextA.rakeCleanup={targetSource:target.sourceId,removed:[...removed]};
    const innerEnds=[inner.a,inner.b].sort((a,b)=>Math.min(dist(b,eave.a),dist(b,eave.b))-Math.min(dist(a,eave.a),dist(a,eave.b)));
    paths.push({rakeSource:outer.id,extendedSource:far.w.sourceId,oldPath:[...innerEnds,outerCorner].map(p=>({...p,z:groundAt(ground,p)??z})),intersection:{...hit,z},soffit:limit,removedIds:[...removed],crossed:true});
    result=result.filter(w=>!removed.has(w.id)&&w.id!==target.id);result.push(nextA,nextD);break;
   }
  }
 }
 // Every accepted pass removes a return. The bound also handles malformed
 // graphs without unbounded searches or repeatedly changing a corner.
 for(let pass=0;pass<walls.length;pass++){
  const graph=runs(result,ground);let change=null;
  search:for(const a0 of graph)for(const reverse of [false,true]){
   const a=reverse?{...a0,a:a0.b,b:a0.a}:a0;
   let end=a.b,previous=a0,chain=[],visited=new Set([a0]);
   for(let i=0;i<8;i++){
    const neighbors=graph.filter(r=>r!==previous&&!visited.has(r)&&(dist(r.a,end)<.002||dist(r.b,end)<.002));if(neighbors.length!==1)break;
    const raw=neighbors[0],d=dist(raw.a,end)<.002?raw:{...raw,a:raw.b,b:raw.a};visited.add(raw);
    const rake=members(d).map(sourceOf).filter(s=>s?.type==='rake'&&s.setback>0).sort((x,y)=>Math.min(dist(x.a,d.a),dist(x.b,d.a))-Math.min(dist(y.a,d.a),dist(y.b,d.a)))[0],limit=rake?.setback;
    if(chain.length>=2&&rake&&dist(d.a,d.b)>Math.max(.5,2*limit)&&dist(a.a,a.b)>Math.max(.5,2*limit)){
     const u=sub(a.b,a.a),v=sub(d.b,d.a),den=cross(u,v);if(Math.abs(den)<1e-8)break;
     const t=cross(sub(d.a,a.a),v)/den,q=cross(sub(d.a,a.a),u)/den,hit=mix(a.a,a.b,t);
     const oldPath=[a.b,...chain.map(r=>r.b)];
     const normal=rake.originalA?{x:-(rake.b.y-rake.a.y),y:rake.b.x-rake.a.x}:null;
     if(normal){const shift=sub(rake.a,rake.originalA);if(shift.x*normal.x+shift.y*normal.y<0){normal.x*=-1;normal.y*=-1;}}
     const inner=chain.find(r=>parallel(r,d)&&members(r).some(w=>sourceOf(w)?.type==='rake')&&normal&&
      ((r.a.x-d.a.x)*normal.x+(r.a.y-d.a.y)*normal.y)>1e-5);
     if(t<=1+1e-6||q<0||q>=1||!inner||dist(a.b,hit)>limit+.002||dist(d.a,hit)>limit+.002||
       chain.some(r=>dist(r.a,r.b)>limit+.002)||oldPath.some(p=>dist(p,hit)>limit+.002))break;
     const anchor=members(a).filter(w=>w.kind==='perimeter'&&sourceOf(w)&&dist(...w.bottom)>Math.max(.5,limit)).sort((x,y)=>Math.min(...x.bottom.map(p=>dist(p,a.b)))-Math.min(...y.bottom.map(p=>dist(p,a.b))))[0];
     const target=members(d).find(w=>G.onEdge(hit,...w.bottom,.002));if(!anchor||!target)break;
     const near=dist(anchor.bottom[0],a.b)<dist(anchor.bottom[1],a.b)?0:1,far=anchor.bottom[1-near];
     const removed=new Set(chain.flatMap(r=>r.ids));
     for(const w of result){
      if(w.bottom.every(p=>G.onEdge(p,far,a.b,.002)))removed.add(w.id);
      // Discard only the small flashing from this roof return into the
      // extended wall. Unrelated roof intersections remain intact.
      if(w.kind==='flashing'&&w.targetId===anchor.sourceRoofId&&chain.some(r=>members(r).some(m=>m.sourceRoofId===w.sourceRoofId))&&
        w.bottom.every(p=>dist(p,a.b)<=limit+.01))removed.add(w.id);
     }
     if([...removed,target.id].some(id=>blocked.has(id))){skippedEdited.add([anchor.id,target.id].sort().join('|'));break;}
     const z=groundAt(ground,hit);if(z===null)break;
     const targetAt=at(hit,...target.bottom),top=mix(...target.top,targetAt).z;if(top-z<.02)break;
     const nextA=copy(anchor),nextD=copy(target),di=dist(target.bottom[0],d.a)<dist(target.bottom[1],d.a)?0:1;
     nextA.bottom[near]={...hit,z};nextA.top[near]={...hit,z:top};nextD.bottom[di]={...hit,z};nextD.top[di]={...hit,z:top};
     nextA.rakeCleanup={targetSource:target.sourceId,removed:[...removed]};
     change={removed,nextA,nextD,path:{rakeSource:rake.id,extendedSource:anchor.sourceId,oldPath,intersection:{...hit,z},soffit:limit,removedIds:[...removed]}};break search;
    }
    if(dist(d.a,d.b)>2||chain.length>=7)break;
    chain.push(d);previous=raw;end=d.b;
   }
  }
  if(!change)break;
  result=result.filter(w=>!change.removed.has(w.id)&&w.id!==change.nextD.id);result.push(change.nextA,change.nextD);paths.push(change.path);
 }
 const removedSources=[...new Set(paths.flatMap(p=>p.removedIds).map(id=>walls.find(w=>w.id===id)).filter(w=>w?.kind==='flashing').map(w=>w.sourceId))];
 const restored=restoreSoffits(result,sources,removedSources,ground,blocked);result=restored.walls;
 for(const path of paths){const patch=restored.patches.find(p=>p.oldPath.some(q=>dist(q,path.intersection)<.002));
  path.finalIntersection=patch?copy(patch.points[3-patch.oldPath.findIndex(q=>dist(q,path.intersection)<.002)]):copy(path.intersection);
 }
 if(paths.length){for(const w of result)delete w.mergeGroup;result=G.mergeCoplanar(result,excluded).walls;}
 return {walls:result,report:{version:2,paths,setbackCorrections:restored.corrections,foundationPatches:restored.patches,skippedEdited:skippedEdited.size,removed:paths.reduce((n,p)=>n+Math.max(0,p.removedIds.length-1),0)}};
}
// Apply the same local replacement to the foundation, preserving its planes,
// materials, chimney provenance and any independent sketch geometry.
function foundation(base,report){
 if(!base)return base;
 if(!report.paths.length&&!report.foundationPatches?.length)return copy(base);
 const next=copy(base);
 for(const path of [...report.paths,...(report.foundationPatches||[])]){const patch={points:path.points||[...path.oldPath,path.intersection]};if(K.area(patch)<1e-7)continue;
  const mid=patch.points.reduce((a,p)=>({x:a.x+p.x/patch.points.length,y:a.y+p.y/patch.points.length}),{x:0,y:0});
  for(let i=0;i<next.faces.length;i++){const f=next.faces[i],pl=G.plane(f.points);if(!pl||!path.oldPath.every(p=>G.contains(f,p)||f.points.some((a,j)=>G.onEdge(p,a,f.points[(j+1)%f.points.length],.02))))continue;
   const pieces=G.contains(f,mid)?K.difference(f,[patch]):K.union([f,patch]);
   if(pieces.length!==1||pieces[0].holes.length)continue;
   next.faces[i]={...f,points:pieces[0].points.map(p=>({...p,z:pl.dx*p.x+pl.dy*p.y+pl.k}))};break;
  }
 }
 const S=common?require('./base_sketch_geometry.js'):root.BaseSketchGeometry;
 if(S){
  const prior=copy(base);
  if(prior.sketch){
   prior.sketch.edges=prior.sketch.edges.filter(e=>!e.fixed);
   const used=new Set(prior.sketch.edges.flatMap(e=>[e.a,e.b]));
   prior.sketch.nodes=prior.sketch.nodes.filter(p=>used.has(p.id)||!p.fixed||p.userDraftPoint);
  }
  S.rebind(prior,next);
 }else delete next.sketch;
 return next;
}
const api={cleanup,foundation};if(common)module.exports=api;else root.WallRakeCleanup=api;
})(typeof window!=='undefined'?window:globalThis);
