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
 return {walls:result,report:{version:2,paths,setbackCorrections:restored.corrections,foundationPatches:restored.patches,skippedEdited:skippedEdited.size,removed:paths.reduce((n,p)=>n+p.removedIds.length-1,0)}};
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
