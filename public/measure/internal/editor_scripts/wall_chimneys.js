/* Roof-derived chimney volumes. World coordinates and tolerances are metres. */
(function(root){
'use strict';
const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const EPS=1e-6, COLOR='#cf967a', TYPES=new Set(['chimney_back','chimney_edge','chimney_front']);
const scenes=new WeakMap();
const copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),cross=(a,b)=>a.x*b.y-a.y*b.x;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:(a.z||0)+((b.z||0)-(a.z||0))*t});
const area=ps=>ps.reduce((s,p,i)=>s+cross(p,ps[(i+1)%ps.length]),0)/2;
// Clipping uses geometric precision, not the editor's 2 mm picking tolerance.
function contains(face,p){const inside=ring=>{let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if(G.onEdge(p,a,b,Math.max(1e-7,2*K.GRID)))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;};return inside(face.points)&&!(face.holes||[]).some(inside);}
function clean(ps,closed){const out=ps.map(p=>({...p}));let changed=true;while(changed&&out.length>(closed?3:2)){changed=false;for(let i=closed?0:1;i<(closed?out.length:out.length-1);i++){const a=out[(i+out.length-1)%out.length],b=out[i],c=out[(i+1)%out.length];if(dist(a,b)<EPS||Math.abs(cross(sub(b,a),sub(c,b)))<EPS*dist(a,c)){out.splice(i,1);changed=true;break;}}}return out;}
function breaks(a,b,rings){const v=sub(b,a),l2=v.x*v.x+v.y*v.y,ts=[0,1];if(l2<EPS*EPS)return ts;
 for(const ring of rings)for(let i=0;i<ring.length;i++){const c=ring[i],d=ring[(i+1)%ring.length],w=sub(d,c),q=sub(c,a),den=cross(v,w);if(Math.abs(den)>EPS){const t=cross(q,w)/den,u=cross(q,v)/den;if(t>EPS&&t<1-EPS&&u>=-EPS&&u<=1+EPS)ts.push(t);}else if(Math.abs(cross(q,v))<EPS*Math.sqrt(l2)){for(const p of [c,d]){const t=((p.x-a.x)*v.x+(p.y-a.y)*v.y)/l2;if(t>EPS&&t<1-EPS)ts.push(t);}}}
 return ts.sort((a,b)=>a-b).filter((t,i,all)=>!i||t-all[i-1]>EPS);
}
// Height inference is a generation-time operation; only its result is saved.
// Do not clamp off-image samples to an edge pixel or turn missing data into zero.
function heightSampler(data,ctx,origin=ctx){
 if(!ctx||!origin||!(ctx.mpp>0)||!Number.isInteger(ctx.width)||!Number.isInteger(ctx.height)||!data||data.length!==ctx.width*ctx.height)return null;
 const dx=((origin.lng||0)-(ctx.lng||0))*111132*Math.cos((ctx.lat||0)*Math.PI/180),dy=((ctx.lat||0)-(origin.lat||0))*111132;
 return p=>{const x=Math.round(ctx.width/2+(p.x+dx)/ctx.mpp),y=Math.round(ctx.height/2+(p.y+dy)/ctx.mpp);if(x<0||y<0||x>=ctx.width||y>=ctx.height)return null;const z=data[y*ctx.width+x];return Number.isFinite(z)&&z>-9000&&z<9000?z:null;};
}
function heightExtension(roof,path,options){
 const {sampleHeight,resolution}=options;
 if(typeof sampleHeight!=='function'||!Number.isFinite(resolution)||resolution<=0)return null;
 const [a,b,c,d]=path,depth=dist(a,b),width=dist(b,c),step=Math.max(.025,resolution),out={x:(a.x-b.x)/depth,y:(a.y-b.y)/depth};
 // A coarse raster cannot resolve this footprint reliably.
 if(depth<2*step||width<3*step)return null;
 const edgeDistance=(p,ring)=>Math.min(...ring.map((a,i)=>{const b=ring[(i+1)%ring.length],v=sub(b,a),l2=v.x*v.x+v.y*v.y,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*v.x+(p.y-a.y)*v.y)/l2)):0;return dist(p,mix(a,b,t));}));
 // Adjacent roof planes supply the pitched reference, including at a ridge.
 // Unrelated overlapping roof faces must not supply the chimney's baseline.
 const faces=(roof.faces||[]).map(f=>({f,plane:G.plane(f.points)})).filter(({f,plane})=>plane&&path.filter(p=>edgeDistance(p,f.points)<.03&&Math.abs(p.z-(plane.dx*p.x+plane.dy*p.y+plane.k))<.15).length>=2);
 if(!faces.length)return null;
 const roofHeight=p=>{let best=null;for(const v of faces){const distance=contains(v.f,p)?0:edgeDistance(p,v.f.points);if(!best||distance<best.distance)best={...v,distance};}return best.plane.dx*p.x+best.plane.dy*p.y+best.plane.k;};
 const median=values=>{const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;};
 const edges=[],limit=Math.min(6,Math.max(1.5,3*depth,1.5*width));
 for(const u of [.2,.35,.5,.65,.8]){
  const start=mix(a,d,u),point=t=>({x:start.x+out.x*t,y:start.y+out.y*t});
  const residual=t=>{const p=point(t),z=sampleHeight(p);return Number.isFinite(z)&&z>-9000&&z<9000?z-roofHeight(p):null;};
  const seed=[.25,.5,.75].map(t=>residual(-depth*t));
  if(seed.some(z=>z===null))continue;
  const signal=median(seed);if(signal<.25)continue;
  const threshold=Math.max(.12,Math.min(.3,signal*.3));
  let previous=null,drop=null,lows=0;
  for(let t=-depth/2;t<=limit;t+=step){
   const value=residual(t);if(value===null)break; // No bridging missing data.
   if(value>threshold){previous={t,value};drop=null;lows=0;continue;}
   if(!previous)break;
   if(drop===null)drop=previous.t+(t-previous.t)*(previous.value-threshold)/(previous.value-value);
   if(++lows>=Math.max(2,Math.ceil(.15/step))){edges.push(drop);break;}
  }
 }
 if(edges.length<3)return null;
 const measured=median(edges),agreement=Math.max(.15,2*step),consistent=edges.filter(t=>Math.abs(t-measured)<=agreement);
 if(consistent.length<3)return null;
 const distance=median(consistent),snapTolerance=Math.min(.3,Math.max(.1,2*resolution));
 // The open ends are the measured roof crossing. Never shorten the known
 // interior; an edge within raster uncertainty is snapped to that crossing.
 if(distance< -snapTolerance)return null;
 return {method:'height-map',distance:Math.abs(distance)<=snapTolerance?0:distance,measuredDistance:distance,snappedToRoof:Math.abs(distance)<=snapTolerance,resolution,rays:consistent.length};
}
function detect(roof,options={}){
 const nodes=[],edges=[],warnings=[],seen=new Set();
 const node=p=>{let i=nodes.findIndex(q=>dist(p,q.p)<.002);if(i<0){i=nodes.length;nodes.push({p:{...p},edges:[]});}return i;};
 for(let i=0;i<(roof?.connections||[]).length;i++){const e=roof.connections[i];if(!TYPES.has(e.type))continue;const p=roof.points[e.startIdx],q=roof.points[e.endIdx];if(!p||!q||![p.x,p.y,p.z,q.x,q.y,q.z].every(Number.isFinite)||dist(p,q)<.002)continue;const a=node(p),b=node(q),key=[a,b].sort((a,b)=>a-b).join(':');if(seen.has(key))continue;seen.add(key);const index=edges.length;edges.push({a,b,index:i});nodes[a].edges.push(index);nodes[b].edges.push(index);}
 const used=new Set(),chimneys=[];
 for(let seed=0;seed<edges.length;seed++){if(used.has(seed))continue;const component=[],stack=[seed],vertices=new Set();while(stack.length){const i=stack.pop();if(used.has(i))continue;used.add(i);component.push(i);for(const n of [edges[i].a,edges[i].b]){vertices.add(n);stack.push(...nodes[n].edges.filter(e=>!used.has(e)));}}
  const ends=[...vertices].filter(n=>nodes[n].edges.length===1),closed=!ends.length;
  if([...vertices].some(n=>nodes[n].edges.length>2)||(!closed&&ends.length!==2)){warnings.push('A branched chimney outline needs a closed outline or three connected rectangle sides.');continue;}
  let n=ends[0]??[...vertices][0],previous=-1;const path=[];
  for(let i=0;i<=component.length;i++){path.push(nodes[n].p);const next=nodes[n].edges.find(e=>e!==previous);if(next===undefined)break;const edge=edges[next];previous=next;n=edge.a===n?edge.b:edge.a;if(closed&&n===[...vertices][0])break;}
  let points=clean(path,closed),inferred=false,roofCrossing=null,extension=null;
  if(!closed){
   if(points.length!==4){warnings.push('An open chimney needs three rectangle sides before its outside half can be inferred.');continue;}
   const [a,b,c,d]=points,u=sub(c,b),v=sub(a,b),w=sub(d,c),lu=dist(b,c),lv=dist(a,b),lw=dist(c,d);
   if(Math.min(lu,lv,lw)<.02||Math.abs(u.x*v.x+u.y*v.y)>lu*lv*.03||Math.abs(cross(v,w))>lv*lw*.03||v.x*w.x+v.y*w.y<=0||Math.abs(lv-lw)>Math.max(.03,lv*.05)){warnings.push('The open chimney is not rectangular; its missing side was not guessed.');continue;}
   // Without a reliable height drop, retain the established mirrored fallback.
   const depth={x:(v.x+w.x)/2,y:(v.y+w.y)/2};extension=heightExtension(roof,points,options);const scale=extension?extension.distance/Math.hypot(depth.x,depth.y):1;
   roofCrossing={a:{...a},b:{...d},outward:depth,plane:G.plane(points)};points=extension?[b,c,{x:d.x+scale*depth.x,y:d.y+scale*depth.y,z:d.z},{x:a.x+scale*depth.x,y:a.y+scale*depth.y,z:a.z}]:[b,c,{x:c.x+2*depth.x,y:c.y+2*depth.y,z:d.z},{x:b.x+2*depth.x,y:b.y+2*depth.y,z:a.z}];inferred=true;
  }
  if(points.length<3||Math.abs(area(points))<.0004||!convex(points)){warnings.push('A chimney outline must enclose a simple convex footprint.');continue;}
  if(area(points)<0)points.reverse();
  chimneys.push({id:'roof-chimney-'+component.map(i=>edges[i].index).sort((a,b)=>a-b).join('-'),points:copy(points),inferred,roofCrossing,...(extension?{extension}:{}),sourceConnections:component.map(i=>edges[i].index).sort((a,b)=>a-b)});
 }
 return {version:1,items:chimneys,warnings};
}
function convex(ps){const sign=Math.sign(area(ps));return ps.every((p,i)=>cross(sub(ps[(i+1)%ps.length],p),sub(ps[(i+2)%ps.length],ps[(i+1)%ps.length]))*sign>EPS);}
function definitions(state,strict=false){return (state.chimneys?.items||[]).map(original=>{
 const c={...original,points:copy(state.wallEdits?.$chimneys?.[original.id]?.points||original.points)},surfaces=(state.wallEdits?.$surfaces||[]).filter(f=>f.chimney?.id===c.id&&f.chimney.drivesFootprint).reverse();
 const planes=c.points.map((a,i)=>{const b=c.points[(i+1)%c.points.length],v=sub(b,a),length=dist(a,b),n={x:v.y/length,y:-v.x/length};let k=n.x*a.x+n.y*a.y;const f=surfaces.find(f=>f.chimney.side===i);if(f&&f.points.every(p=>Math.abs(n.x*p.x+n.y*p.y-(n.x*f.points[0].x+n.y*f.points[0].y))<.00001))k=n.x*f.points[0].x+n.y*f.points[0].y;return {...n,k};});
 const points=c.points.map((p,i)=>{const a=planes[(i+planes.length-1)%planes.length],b=planes[i],den=cross(a,b);return Math.abs(den)<EPS?p:{...p,x:(a.k*b.y-a.y*b.k)/den,y:(a.x*b.k-a.k*b.x)/den};});
 if(convex(points)&&area(points)>.0004&&points.every((p,i)=>dist(p,points[(i+1)%points.length])>=.02))c.points=points;else if(strict)throw Error('The chimney must retain a closed footprint at least 2 cm wide.');return c;
 });}
// Older base rebinds associated every side of a chimney with the same draft.
// Repair ownership metadata without changing user geometry or discarding nodes.
function normalizeDrafts(edits){
 for(const [key,d] of Object.entries(edits?.$drafts||{})){if(!d.chimney||d.frame)continue;
  // Mixed wall/chimney groups are one building plane. Older selection stored
  // the clicked chimney's identity and then pruned the wall owners on reload.
  const group=key.includes('|')&&d.members.every(id=>key.split('|').includes(id))?[...new Set([...d.members,...key.split('|')])]:d.members;
  if(group.some(id=>!id.startsWith(d.chimney.id+':'))){
   d.members=group;d.joinedChimneys=[...new Set([...(d.joinedChimneys||[]),d.chimney.id])];delete d.chimney;continue;
  }
  const prefix=d.chimney.id+':side-'+d.chimney.side,fragmented=(d.members||[]).some(id=>id.startsWith(prefix+':part-'));
  d.members=(d.members||[]).filter(id=>id===prefix||id.startsWith(prefix+':part-'));
  if(!fragmented)continue;
  for(const n of d.sketch?.nodes||[]){if(n.fixed||n.userDraftPoint||d.sketch.edges.some(e=>e.a===n.id||e.b===n.id))continue;
   if(d.sketch.outlines.some(r=>r.some((a,i)=>G.onEdge(n,a,r[(i+1)%r.length],1e-6))))n.generatedBoundary=true;
  }
 }
}
const foundationCache=new WeakMap();
function buildingBase(state){
 const base=state.wallEdits?.$base||state.base;if(!base)return [];
 const faces=base.faces.filter(f=>!f.chimneyFoundation),parts=base.chimneyFoundationParts||[];if(!parts.length)return faces;
 const key=JSON.stringify([faces,parts]),cached=foundationCache.get(base);if(cached?.key===key)return cached.faces;
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null);
 const result=faces.flatMap(f=>{const plane=G.plane(f.points),lift=p=>({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k});return K.difference(f,parts).map((r,i)=>({...f,id:i?f.id+':house-'+i:f.id,points:r.points.map(lift),holes:r.holes.map(r=>r.map(lift))}));});
 foundationCache.set(base,{key,faces:result});return result;
}
function floorAt(state,p,fallback=0){
 const faces=buildingBase(state);let best=null;
 for(const f of faces){const plane=G.plane(f.points);if(!plane)continue;if(contains(f,p))return plane.dx*p.x+plane.dy*p.y+plane.k;let distance=Infinity;for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length],v=sub(b,a),l2=v.x*v.x+v.y*v.y,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*v.x+(p.y-a.y)*v.y)/l2)):0;distance=Math.min(distance,dist(p,mix(a,b,t)));}if(!best||distance<best.distance)best={plane,distance};}
 if(best)return best.plane.dx*p.x+best.plane.dy*p.y+best.plane.k;
 const g=state.ground;if(g?.faces&&g.points){for(const ids of g.faces){const ps=ids.map(i=>g.points[i]);if(contains({points:ps},p)){const q=G.plane(ps);return q.dx*p.x+q.dy*p.y+q.k;}}const q=g.plane||G.plane(g.points);if(q)return q.dx*p.x+q.dy*p.y+q.k;}
 return Number.isFinite(fallback)?fallback:state.options?.ground||0;
}
function intervals(a,b,polygons,keepInside,offset={x:0,y:0}){const ts=breaks(a,b,polygons.flatMap(f=>[f.points,...(f.holes||[])])),out=[];for(let i=1;i<ts.length;i++){const lo=ts[i-1],hi=ts[i],inside=polygons.some(f=>contains(f,{...mix(a,b,(lo+hi)/2),x:mix(a,b,(lo+hi)/2).x+offset.x,y:mix(a,b,(lo+hi)/2).y+offset.y}));if(inside===keepInside){const last=out[out.length-1];if(last&&Math.abs(last[1]-lo)<EPS)last[1]=hi;else out.push([lo,hi]);}}return out;}
function sliceWall(w,lo,hi,id){return {...w,id,bottom:[mix(...w.bottom,lo),mix(...w.bottom,hi)],top:[mix(...w.top,lo),mix(...w.top,hi)]};}
function capHeight(c,p){const r=c.roofCrossing;let q=p;if(r?.plane){const d=r.outward,l2=d.x*d.x+d.y*d.y,t=((p.x-r.a.x)*d.x+(p.y-r.a.y)*d.y)/l2;if(t>0)q={x:p.x-d.x*t,y:p.y-d.y*t};return r.plane.dx*q.x+r.plane.dy*q.y+r.plane.k;}const plane=G.plane(c.points);return plane?plane.dx*p.x+plane.dy*p.y+plane.k:Math.max(...c.points.map(p=>p.z));}
function volumeIntervals(a,b,c){return intervals(a,b,[{points:c.points}],true).flatMap(([lo,hi])=>{const ts=c.roofCrossing?breaks(mix(a,b,lo),mix(a,b,hi),[[c.roofCrossing.a,c.roofCrossing.b]]):[0,1];return ts.slice(1).map((t,i)=>[lo+(hi-lo)*ts[i],lo+(hi-lo)*t]);});}
function cutWall(w,c,state){
 const outside=intervals(...w.bottom,[{points:c.points}],false).map(([lo,hi])=>sliceWall(w,lo,hi,w.id)),inside=volumeIntervals(...w.bottom,c),above=[];
 for(const [lo,hi] of inside){const ts=[lo,hi];for(const edge of [w.bottom,w.top]){const a=mix(...edge,lo),b=mix(...edge,hi),da=a.z-occlusionHeight(c,a,state),db=b.z-occlusionHeight(c,b,state);if(da*db<0)ts.push(lo+(hi-lo)*da/(da-db));}ts.sort((a,b)=>a-b);
  for(let i=1;i<ts.length;i++){const a=ts[i-1],b=ts[i],mid=mix(...w.top,(a+b)/2);if(mid.z<=occlusionHeight(c,mid,state)+EPS)continue;const part=sliceWall(w,a,b,w.id);part.bottom=part.bottom.map(p=>({...p,z:Math.max(p.z,occlusionHeight(c,p,state))}));above.push(part);}}
 return [...outside,...above];
}
// A wall-only recess can expose a chimney above an unchanged foundation.
// Classify horizontal sections against the edited wall fabric in that case.
function updateScene(walls,state,cs){
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null),edits=state.wallEdits||{},surfaces=(edits.$surfaces||[]).filter(f=>!f.chimney&&!f.deleted&&!f.drafted);
 const generated=state.options?.roofContacts&&!surfaces.length&&!Object.keys(edits.$drafts||{}).length&&!edits.$base;
 if(!W||(!surfaces.length&&!generated)){scenes.delete(state);return;}
 const drafts=Object.values(edits.$drafts||{}).filter(d=>!d.chimney&&!d.mergedInto),claimed=new Set(drafts.flatMap(d=>d.members||[]).map(id=>id.split(':chimney-cut-')[0]));
 const world=(d,p)=>d.frame?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y},faces=[...surfaces];
 for(const d of drafts)for(const f of d.faces||[]){const signature=f.points.map(p=>p.nodeId).sort().join('|');if(f.boundaryHole||f.solidId||(d.deletedFaces||[]).includes(signature))continue;faces.push({...f,points:f.points.map(p=>world(d,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(d,p)))});}
 for(const w of walls){const face={points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]};if(!claimed.has(w.id)){faces.push(face);continue;}
  // Drafts created on either side of a chimney omit its covered siding.
  // Restore that covered interval solely for the building-inside query.
  for(const c of cs)for(const [lo,hi]of volumeIntervals(...w.bottom,c)){const p=sliceWall(w,lo,hi,w.id);faces.push({points:[p.bottom[0],p.bottom[1],p.top[1],p.top[0]]});}}
 if(generated)faces.push(...(state.roof?.faces||[]).map(f=>({...f,holes:[]})));
 const vertical=faces.map(f=>({f,frame:W.faceFrame(f)})).filter(v=>v.frame&&(generated||Math.abs(v.frame.n.z)<1e-5)).map(v=>({...v,local:{points:v.f.points.map(p=>W.inFrame(v.frame,p)),holes:(v.f.holes||[]).map(r=>r.map(p=>W.inFrame(v.frame,p)))}}));
 scenes.set(state,{W,generated,faces:vertical,z:[...new Set(vertical.flatMap(v=>v.f.points.map(p=>p.z)))].sort((a,b)=>a-b)});
}
function inBuilding(state,p){const scene=scenes.get(state);if(!scene)return (buildingBase(state)).some(f=>contains(f,p));
 if(scene.generated&&buildingBase(state).some(f=>contains(f,p))){
  const ceilings=(state.roof?.faces||[]).filter(f=>G.contains({...f,holes:[]},p)).map(f=>G.plane(f.points)).filter(Boolean).map(f=>f.dx*p.x+f.dy*p.y+f.k);
  if(ceilings.length&&p.z<Math.min(...ceilings)-EPS)return true;
 }
 const direction={x:1,y:.3713906763541037,z:0},hits=[];
 for(const {frame,local}of scene.faces){if(scene.generated&&Math.abs(frame.n.z)>1e-5)continue;const den=frame.n.x*direction.x+frame.n.y*direction.y;if(Math.abs(den)<1e-8)continue;const t=(frame.n.x*(frame.origin.x-p.x)+frame.n.y*(frame.origin.y-p.y))/den;if(t<=1e-7)continue;const hit={x:p.x+direction.x*t,y:p.y+direction.y*t,z:p.z};if(contains(local,scene.W.inFrame(frame,hit)))hits.push(t);}
 hits.sort((a,b)=>a-b);return hits.filter((t,i)=>!i||t-hits[i-1]>1e-5).length%2===1;
}
function exposureBands(a,b,state,offset,bottom,top,other=[]){const scene=scenes.get(state);if(!scene)return null;
 const ts=breaks(a,b,scene.faces.flatMap(v=>[v.f.points,...(v.f.holes||[])])),zs=[bottom,...scene.z.filter(z=>z>bottom+EPS&&z<top-EPS),top],result=[];
 for(let k=1;k<zs.length;k++){const z=(zs[k]+zs[k-1])/2,spans=[];for(let i=1;i<ts.length;i++){const q=mix(a,b,(ts[i]+ts[i-1])/2),p={x:q.x+offset.x,y:q.y+offset.y,z};if(inBuilding(state,p)||other.some(f=>contains(f,p)))continue;const last=spans[spans.length-1];if(last&&Math.abs(last[1]-ts[i-1])<EPS)last[1]=ts[i];else spans.push([ts[i-1],ts[i]]);}for(const span of spans){
   // Other walls contribute height samples too. They are not chimney seams.
   const previous=result.findLast(b=>Math.abs(b.top-zs[k-1])<EPS&&Math.abs(b.span[0]-span[0])<EPS&&Math.abs(b.span[1]-span[1])<EPS);
   if(previous)previous.top=zs[k];else result.push({span,bottom:zs[k-1],top:zs[k]});
  }}
 return result;
}
// Intersect the generated building with a chimney side in (side distance,
// elevation). Splitting at actual surface planes preserves sloped roof seams;
// a lower support only hides masonry below its roof, never the full shaft.
function generatedSide(c,side,state){
 if(c.points.every(p=>buildingBase(state).some(f=>contains(f,p))))return [];
 const scene=scenes.get(state),a=c.points[side],b=c.points[(side+1)%c.points.length],length=dist(a,b),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length},n={x:u.y,y:-u.x};
 const world=p=>({x:a.x+u.x*p.x,y:a.y+u.y*p.x,z:p.y}),lines=[],seen=new Set();
 for(const {f,frame}of scene.faces){
  const hits=[];for(let i=0;i<f.points.length;i++){const p=f.points[i],q=f.points[(i+1)%f.points.length],dp=(p.x-a.x)*n.x+(p.y-a.y)*n.y,dq=(q.x-a.x)*n.x+(q.y-a.y)*n.y;
   if(Math.abs(dp)<.002)hits.push(p);if(dp*dq<0)hits.push(mix(p,q,dp/(dp-dq)));
  }
  if(hits.length<2)continue;const xs=hits.map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y);if(Math.max(...xs)<-EPS||Math.min(...xs)>length+EPS)continue;
  let A=frame.n.x*u.x+frame.n.y*u.y,B=frame.n.z,D=frame.n.x*(a.x-frame.origin.x)+frame.n.y*(a.y-frame.origin.y)-frame.n.z*frame.origin.z;
  const norm=Math.hypot(A,B);if(norm<1e-8)continue;A/=norm;B/=norm;D/=norm;if(A<0||(Math.abs(A)<EPS&&B<0)){A=-A;B=-B;D=-D;}const key=[A,B,D].map(x=>x.toFixed(6)).join(':');if(!seen.has(key)){seen.add(key);lines.push({A,B,D});}
 }
 const clip=(ps,line,sign)=>{const out=[];for(let i=0;i<ps.length;i++){const p=ps[i],q=ps[(i+1)%ps.length],dp=sign*(line.A*p.x+line.B*p.y+line.D),dq=sign*(line.A*q.x+line.B*q.y+line.D);if(dp>=-1e-9)out.push(p);if(dp*dq<0){const t=dp/(dp-dq);out.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}}return out;};
 const ts=breaks(a,b,(state.roof?.faces||[]).flatMap(f=>[f.points,...(f.holes||[])])),result=[],visible=[];
 for(let k=1;k<ts.length;k++){
  const p=mix(a,b,ts[k-1]),q=mix(a,b,ts[k]);let cells=[[{x:ts[k-1]*length,y:floorAt(state,p)},{x:ts[k]*length,y:floorAt(state,q)},{x:ts[k]*length,y:roofContact(c,q,state)},{x:ts[k-1]*length,y:roofContact(c,p,state)}]];
  for(const line of lines)cells=cells.flatMap(ps=>{const ds=ps.map(p=>line.A*p.x+line.B*p.y+line.D);return Math.min(...ds)<-1e-8&&Math.max(...ds)>1e-8?[clip(ps,line,1),clip(ps,line,-1)]:[ps];});
  for(const ps of cells){if(Math.abs(area(ps))<1e-9)continue;const mid=ps.reduce((s,p)=>({x:s.x+p.x/ps.length,y:s.y+p.y/ps.length}),{x:0,y:0}),sample=world(mid);sample.x+=n.x*.00001;sample.y+=n.y*.00001;
   if(inBuilding(state,sample)||definitions(state).some(o=>o.id!==c.id&&contains({points:o.points},sample)))continue;
   visible.push({points:ps});
  }
 }
 // Union before panelization so intersection cuts cannot leave doubled seams
 // or dangling edges when the editor merges a chimney side into one face.
 for(const region of K.union(visible)){
  const rings=[region.points,...region.holes],xs=[...new Set(rings.flat().map(p=>p.x))].sort((a,b)=>a-b);
  for(let j=1;j<xs.length;j++){
   const lo=xs[j-1],hi=xs[j];if(hi-lo<EPS)continue;const x=(lo+hi)/2,edges=rings.flatMap(ps=>ps.map((p,i)=>[p,ps[(i+1)%ps.length]])).filter(([p,q])=>x>Math.min(p.x,q.x)&&x<Math.max(p.x,q.x)),at=(edge,x)=>edge[0].y+(edge[1].y-edge[0].y)*(x-edge[0].x)/(edge[1].x-edge[0].x);edges.sort((a,b)=>at(a,x)-at(b,x));
   for(let k=1;k<edges.length;k+=2){
    const bottom=[lo,hi].map(x=>world({x,y:at(edges[k-1],x)})),top=[lo,hi].map(x=>world({x,y:at(edges[k],x)}));if(top.every((p,i)=>p.z-bottom[i].z<EPS))continue;
    result.push({id:c.id+':side-'+side+':cell-'+result.length,mergeGroup:c.id+':side-'+side,chimney:{id:c.id,side,inferred:c.inferred,exposureClipped:true},sourceId:c.id,type:'chimney',targetId:'ground:chimney',bottom,top});
   }
  }
 }
 return result;
}
// Foundation additions are editable base faces, but must not count as house
// interior when deciding which chimney walls are exposed.
function buildFoundation(state){
 const base=state.wallEdits?.$base||state.base,W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null),B=root.BaseGeometry||(typeof module!=='undefined'&&module.exports?require('./base_geometry.js'):null);
 if(!base||!W||!B)return;
 const cs=definitions(state),house=buildingBase(state),signature=JSON.stringify([cs.map(c=>[c.id,c.points]),house.map(f=>[f.id,f.points,f.holes])]);
 if(base.chimneyFoundationKey===signature)return;
 const shape=f=>JSON.stringify(f.points.map(p=>[p.x,p.y,p.z]));
 // Leave manually reshaped foundation pieces alone.
 const overridden=new Set(base.faces.filter(f=>f.chimneyFoundation&&f.chimneyFoundationShape!==shape(f)).map(f=>f.chimneyFoundation));
 const kept=base.faces.filter(f=>!f.chimneyFoundation||overridden.has(f.chimneyFoundation)),added=[];
 for(const c of cs){if(overridden.has(c.id))continue;
  const points=c.points.map(p=>({...p,z:floorAt(state,p)}));
  const pieces=W.joinFragments(W.subtract({points},[...kept,...added])).flatMap(f=>f.holes?.length?W.subtract(f,f.holes.map(points=>({points}))):[f.points]);
  pieces.forEach((ring,i)=>{if(Math.abs(area(ring))<1e-8)return;const f={id:c.id+':foundation-'+i,chimneyFoundation:c.id,points:clean(ring,true).map(p=>({...p,z:floorAt(state,p)}))};B.validate(f);f.chimneyFoundationShape=shape(f);added.push(f);});
 }
 base.faces=[...kept,...added];base.chimneyFoundationKey=signature;
 if(base.sketch){
  const sketch=base.sketch;sketch.edges=sketch.edges.filter(e=>!e.chimneyFoundation||overridden.has(e.chimneyFoundation));
  const used=new Set([...sketch.edges.flatMap(e=>[e.a,e.b]),...kept.flatMap(f=>f.points.map(p=>p.nodeId))]);
  sketch.nodes=sketch.nodes.filter(n=>!n.chimneyFoundation||used.has(n.id));
  const id=prefix=>{let value;do{value=prefix+sketch.next++;}while(sketch.nodes.some(n=>n.id===value)||sketch.edges.some(e=>e.id===value));return value;};
  for(const f of added){for(const p of f.points){let n=sketch.nodes.find(n=>dist(n,p)<1e-6&&Math.abs(n.z-p.z)<1e-6);if(!n){n={...p,id:id('p'),fixed:true,chimneyFoundation:f.chimneyFoundation};sketch.nodes.push(n);}p.nodeId=n.id;}
   f.points.forEach((p,i)=>{const q=f.points[(i+1)%f.points.length];if(!sketch.edges.some(e=>(e.a===p.nodeId&&e.b===q.nodeId)||(e.b===p.nodeId&&e.a===q.nodeId)))sketch.edges.push({id:id('e'),a:p.nodeId,b:q.nodeId,fixed:true,chimneyFoundation:f.chimneyFoundation});});
  }
  sketch.outlines=B.boundary(base.faces.map(f=>f.points));
 }
}
// The generated footprint is part of the normal base. Keep provenance out of
// the editable graph so an internal bookkeeping seam cannot split it again.
function syncFoundation(state,{force=false}={}){
 const base=state.wallEdits?.$base||state.base;if(!base)return;
 // Ignore floating-point roundoff from repeated volume projections when deciding
 // whether to rebuild the foundation and replace its editable node IDs.
 const cs=definitions(state),key=JSON.stringify(cs,(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v);if(!force&&base.chimneyVolumeKey===key&&base.chimneyFoundationVersion===2)return;
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null),S=root.BaseSketchGeometry||(typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):null);
 if(!W||!S)return;
 // Older sketch resolution discarded generated-face metadata. Recover only
 // the reserved generated IDs so those footprints can join their host base.
 for(const f of base.faces)if(!f.chimneyFoundation&&!f.feature){const c=cs.find(c=>String(f.id).startsWith(c.id+':foundation-'));if(c){f.chimneyFoundation=c.id;f.chimneyFoundationShape=JSON.stringify(f.points.map(p=>[p.x,p.y,p.z]));delete base.chimneyFoundationKey;}}
 if(base.chimneyFoundationParts?.length){const house=buildingBase(state);base.faces=[...house,...copy(base.chimneyFoundationParts)];delete base.chimneyFoundationParts;delete base.chimneyFoundationKey;}
 buildFoundation(state);
 const old=base.sketch,parts=base.faces.filter(f=>f.chimneyFoundation),faces=base.faces.filter(f=>!f.chimneyFoundation).map(copy),mergedParts=[];
 for(const part of parts){let joined=false;for(const face of faces){const pl=G.plane(face.points);if(!pl||!part.points.every(p=>Math.abs(p.z-pl.dx*p.x-pl.dy*p.y-pl.k)<1e-5))continue;
   const union=W.unionPlanar([face.points,part.points]);if(union.length!==1||union[0].holes?.length)continue;
   face.points=union[0].points.map(p=>({...p,z:pl.dx*p.x+pl.dy*p.y+pl.k}));mergedParts.push(copy(part));joined=true;break;
  }if(!joined)faces.push(copy(part));
 }
 if(mergedParts.length){
  base.faces=faces;base.chimneyFoundationParts=mergedParts;delete base.sketch;
  // Reconstruct boundaries from the joined faces; only intentional sketch
  // geometry is transferred, never the generated foundation's former seam.
  const source={...copy(base),sketch:old};
  if(old){const generated=parts.flatMap(f=>f.points.map((p,i)=>[p,f.points[(i+1)%f.points.length]]));source.sketch=copy(old);source.sketch.edges=source.sketch.edges.filter(e=>{if(e.fixed||e.chimneyFoundation)return false;const a=old.nodes.find(n=>n.id===e.a),b=old.nodes.find(n=>n.id===e.b);return !generated.some(pair=>W.sharedIntervals(a,b,[{points:pair}]).length);});}
  S.rebind(source,base);
 }
 base.chimneyFoundationVersion=2;base.chimneyVolumeKey=key;delete base.chimneyMergedKey;
}
// Persist the shaft as normal surfaces so face editing, materials and undo share
// the same geometry as every other part of the building. Never regenerate an
// edited or deleted shaft on a redraw or reload.
function fittedRoofContact(c,p,state){const heights=(state.roof?.faces||[]).filter(f=>contains(f,p)).map(f=>{const plane=G.plane(f.points);return plane?plane.dx*p.x+plane.dy*p.y+plane.k:null;}).filter(Number.isFinite);return heights.length?Math.max(...heights):capHeight(c,p);}
function roofContact(c,p,state){
 const anchor=c.points.find(a=>dist(a,p)<K.CONTACT);if(anchor)p={...p,x:anchor.x,y:anchor.y};
 const heights=[];for(const f of state.roof?.faces||[]){
  const boundaries=[f.points,...(f.holes||[])].flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]])).filter(([a,b])=>dist(a,b)>EPS&&G.onEdge(p,a,b,K.CONTACT));
  // Roof openings own measured contact edges. Their boundary is not empty
  // space, and its measured height wins over a least-squares plane fit.
  if(boundaries.length){for(const [a,b]of boundaries){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));heights.push(mix(a,b,t).z);}continue;}
  if(contains(f,p)){const plane=G.plane(f.points);if(plane)heights.push(plane.dx*p.x+plane.dy*p.y+plane.k);}
 }
 return heights.length?Math.max(...heights):capHeight(c,p);
}
// The roof is the join between lower and upper chimney faces, not the end
// of the occupied volume. Clip ordinary wall fill and wire up to the current
// editable cap; a deleted cap still leaves the shaft's side walls standing.
function occlusionHeight(c,p,state){
 const edits=state.wallEdits||{},faces=(edits.$surfaces||[]).filter(f=>f.chimney?.id===c.id&&f.chimney.volume&&!f.deleted&&!f.drafted);
 const W=root.WallSolidGeometry||(commonModule()?require('./wall_solid_geometry.js'):null);
 for(const d of Object.values(edits.$drafts||{})){
  if(d.mergedInto||d.chimney?.id!==c.id||!d.chimney.volume)continue;
  for(const f of d.faces||[]){
   const signature=f.points.map(p=>p.nodeId).sort().join('|');
   if(f.boundaryHole||f.solidId||(d.deletedFaces||[]).includes(signature)||f.points.some(p=>(d.removedPoints||[]).includes(p.nodeId)))continue;
   faces.push({...f,chimney:d.chimney,points:f.points.map(p=>d.frame&&W?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y})});
  }
 }
 const roof=roofContact(c,p,state),caps=faces.filter(f=>f.chimney.cap).map(f=>G.plane(f.points)).filter(Boolean);
 if(caps.length)return Math.max(roof,...caps.map(f=>f.dx*p.x+f.dy*p.y+f.k));
 return Math.max(roof,...faces.flatMap(f=>f.points.map(p=>p.z)));
}
function commonModule(){return typeof module==='object'&&module.exports;}
function upperSide(c,side,height,state){const a=c.points[side],b=c.points[(side+1)%c.points.length],ts=breaks(a,b,(state.roof?.faces||[]).flatMap(f=>[f.points,...(f.holes||[])])),bottom=ts.map(t=>{const p=mix(a,b,t);return {...p,z:roofContact(c,p,state)};});return [...bottom,{...b,z:height},{...a,z:height}];}
// Upgrade vertices made by former reference-plane and fitted-plane clips.
// Match those old contact heights at the footprint, not a general weld radius.
// V creates an intentional patch, even where generated walls would be cut away.
// Record only intersecting chimney cutouts so downstream picks and edits agree.
function preserveFilledFace(face,state){
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null);if(!W)return;
 const frame=W.faceFrame(face);if(!frame)return;
 const measure=f=>Math.abs(area(f.points.map(p=>W.inFrame(frame,p))))-(f.holes||[]).reduce((sum,r)=>sum+Math.abs(area(r.map(p=>W.inFrame(frame,p)))),0),original=measure(face);
 for(const c of state.chimneys?.items||[]){if(face.joinedChimneys?.includes(c.id))continue;const candidate={...state,chimneys:{...state.chimneys,items:[c]}};
  if(visibleParts(face,candidate).reduce((sum,f)=>sum+measure(f),0)<original-1e-8)face.joinedChimneys=[...(face.joinedChimneys||[]),c.id];
 }
}
function alignRoofContacts(state){
 const edits=state?.wallEdits;if(!edits)return;const cs=definitions(state);if(!cs.length)return;
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null);if(!W)return;
 const fit=p=>{for(const c of cs){if(!c.points.some((a,i)=>G.onEdge(p,a,c.points[(i+1)%c.points.length],K.CONTACT)))continue;const anchor=c.points.find(a=>dist(a,p)<1e-5),q=anchor?{...p,x:anchor.x,y:anchor.y}:p,old=capHeight(c,q),fit=fittedRoofContact(c,q,state),z=roofContact(c,q,state);if(Math.abs(p.z-old)<K.CONTACT||Math.abs(p.z-fit)<K.CONTACT)return {...q,z};}return p;};
 for(const f of edits.$surfaces||[]){if(f.deleted||f.curvedSurface)continue;const n=W.normal(f.points);if(!n||Math.abs(n.z)>1e-5)continue;f.points=f.points.map(fit);if(f.holes)f.holes=f.holes.map(r=>r.map(fit));if(f.retainedPoints)f.retainedPoints=f.retainedPoints.map(fit);}
 for(const d of Object.values(edits.$drafts||{})){if(d.frame&&Math.abs(d.frame.n.z)>1e-5)continue;const fix=p=>{const w=d.frame?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y},q=fit(w);if(q===w)return p;return {...p,...(d.frame?W.inFrame(d.frame,q):{x:p.x,y:q.z,z:0})};};
  for(const f of d.faces||[]){f.points=f.points.map(fix);if(f.holes)f.holes=f.holes.map(r=>r.map(fix));}if(d.sketch){d.sketch.nodes=d.sketch.nodes.map(fix);d.sketch.outlines=d.sketch.outlines.map(r=>r.map(fix));}
 }
}
function defaultCapFinish(face,chimney=face.chimney){
 if(!chimney?.cap||face.trim||Math.abs(K.frame(face)?.n.z||0)<.5)return;
 if(!face.material||['default','unassigned'].includes(face.material))face.material='chimney-top';
 if(face.trimData?.base&&(!face.trimData.base.material||['default','unassigned'].includes(face.trimData.base.material)))face.trimData.base.material='chimney-top';
}
function syncVolumes(state){
 // Upgrade only implicit finishes, including subdivided/drafted saved caps.
 for(const f of state?.wallEdits?.$surfaces||[])defaultCapFinish(f);
 for(const d of Object.values(state?.wallEdits?.$drafts||{}))for(const f of d.faces||[])defaultCapFinish(f,f.chimney||d.chimney);
 if(!state)return;for(const f of state.wallEdits?.$surfaces||[])if(!f.deleted&&f.id?.startsWith('filled-face-'))preserveFilledFace(f,state);alignRoofContacts(state);const cs=definitions(state);if(!cs.length)return;
 const edits=state.wallEdits||={};edits.$chimneyVolumes||={};edits.$surfaces||=[];
 for(const c of cs){const prior=edits.$chimneyVolumes[c.id];if(prior?.version>=2)continue;
  if(prior){
   // Upgrade old full-height shaft faces in place, retaining IDs, finishes,
   // cap height and deletion state. Lower exposed walls use the normal shell.
   for(const f of edits.$surfaces.filter(f=>f.chimney?.id===c.id&&f.chimney.volume&&!f.chimney.cap&&!f.drafted)){const height=Math.max(...f.points.map(p=>p.z));f.points=upperSide(c,f.chimney.side,height,state);f.holes=[];}
   edits.$chimneyVolumes[c.id]={...prior,version:2,mode:'upper'};continue;
  }
  const footprint={points:c.points},contacts=c.points.map(p=>roofContact(c,p,state));
  for(const face of state.roof?.faces||[]){const plane=G.plane(face.points);if(!plane)continue;for(const piece of K.intersection([face],[footprint]))for(const p of piece.points)contacts.push(plane.dx*p.x+plane.dy*p.y+plane.k);}
  const height=Math.max(...contacts)+.3048,top=c.points.map(p=>({...p,z:height}));
  for(let side=0;side<c.points.length;side++)edits.$surfaces.push({id:c.id+':volume-side-'+side,chimney:{id:c.id,side,volume:true,drivesFootprint:true},points:upperSide(c,side,height,state),holes:[]});
  edits.$surfaces.push({id:c.id+':cap',material:'chimney-top',chimney:{id:c.id,volume:true,cap:true},points:top,holes:[]});edits.$chimneyVolumes[c.id]={version:2,mode:'upper'};
 }
}
const roofOpeningCache=new WeakMap();
function roofWithOpenings(state){
 const roof=state?.roof;if(!roof)return roof;
 const cs=definitions(state);if(!cs.length)return roof;
 const key=JSON.stringify(cs.map(c=>c.points)),cached=roofOpeningCache.get(roof);if(cached?.key===key)return cached.roof;
 const cuts=cs.map(c=>({points:c.points})),faces=(roof.faces||[]).flatMap(face=>{
  const plane=G.plane(face.points);if(!plane||!K.intersection([face],cuts).length)return [face];
  const originals=[face.points,...(face.holes||[])].flat(),lift=p=>({...p,z:originals.find(q=>dist(p,q)<EPS)?.z??(plane.dx*p.x+plane.dy*p.y+plane.k)});
  return K.difference(face,cuts).map((part,i)=>({...face,id:(face.id||'roof')+':opening-'+i,points:part.points.map(lift),holes:(part.holes||[]).map(r=>r.map(lift))}));
 });
 const result={...roof,faces};roofOpeningCache.set(roof,{key,roof:result});return result;
}
function compose(walls,state){
 const chimneys=definitions(state);if(!chimneys.length)return walls;
 updateScene(walls,state,chimneys);
 const base=buildingBase(state),normal=[];
 for(const w of walls){let pieces=[w];for(const c of chimneys)pieces=pieces.flatMap(p=>cutWall(p,c,state));pieces.forEach((p,i)=>normal.push({...p,id:i?w.id+':chimney-cut-'+i:w.id}));}
 const shell=[];
 for(const c of chimneys.filter(c=>!state.wallEdits?.$chimneyVolumes?.[c.id]||state.wallEdits.$chimneyVolumes[c.id].mode==='upper'))for(let side=0;side<c.points.length;side++){
  if(scenes.get(state)?.generated){shell.push(...generatedSide(c,side,state));continue;}
  const a=c.points[side],b=c.points[(side+1)%c.points.length],len=dist(a,b),outward={x:(b.y-a.y)/len,y:-(b.x-a.x)/len};
  // Sample just outside the volume so a side coincident with a building edge is exposed.
  const spans=intervals(a,b,[...base,...chimneys.filter(o=>o.id!==c.id).map(o=>({points:o.points}))],false,{x:outward.x*.00001,y:outward.y*.00001});
  const bands=exposureBands(a,b,state,{x:outward.x*.00001,y:outward.y*.00001},Math.min(floorAt(state,a),floorAt(state,b)),Math.max(roofContact(c,a,state),roofContact(c,b,state)),chimneys.filter(o=>o.id!==c.id).map(o=>({points:o.points})));
  // Wall drafts can temporarily leave the editable shell open. Ray parity
  // may refine exposed heights, but cannot expose material inside the house.
  const exposed=bands?bands.flatMap(b=>spans.map(([lo,hi])=>({...b,span:[Math.max(lo,b.span[0]),Math.min(hi,b.span[1])]})).filter(b=>b.span[1]-b.span[0]>EPS)):spans.map(span=>({span,bottom:-Infinity,top:Infinity}));
  let part=0;for(const {span:[lo,hi],bottom:bandBottom,top:bandTop}of exposed){const ts=breaks(mix(a,b,lo),mix(a,b,hi),[...base.flatMap(f=>[f.points,...(f.holes||[])]),...(state.roof?.faces||[]).flatMap(f=>[f.points,...(f.holes||[])]),...(c.roofCrossing?[[c.roofCrossing.a,c.roofCrossing.b]]:[])]);
   for(let k=1;k<ts.length;k++){const t0=lo+(hi-lo)*ts[k-1],t1=lo+(hi-lo)*ts[k],top=[mix(a,b,t0),mix(a,b,t1)].map(p=>({...p,z:Math.min(bandTop,roofContact(c,p,state))})),bottom=top.map(p=>({...p,z:Math.max(bandBottom,floorAt(state,p))}));if(top.every((p,i)=>p.z-bottom[i].z<=EPS))continue;for(let i=0;i<2;i++)top[i].z=Math.max(top[i].z,bottom[i].z);
    shell.push({id:c.id+':side-'+side+(part?':part-'+part:''),...(bands?{mergeGroup:c.id+':side-'+side}:{}),chimney:{id:c.id,side,inferred:c.inferred},sourceId:c.id,type:'chimney',targetId:'ground:chimney',bottom,top});part++;
   }
  }
 }
 return [...normal,...shell];
}
function moveSide(state,chimney,delta){
 const c=definitions(state).find(c=>c.id===chimney.id);if(!c)throw Error('The source chimney is no longer available.');
 const side=chimney.side,a=c.points[side],b=c.points[(side+1)%c.points.length],v=sub(b,a),len=dist(a,b);
 if(Math.abs(delta.x*v.x+delta.y*v.y)>len*1e-5||Math.abs(delta.z||0)>1e-5)throw Error('Move a chimney side perpendicular to its plane.');
 for(const i of [side,(side+1)%c.points.length]){c.points[i].x+=delta.x;c.points[i].y+=delta.y;}
 if(!convex(c.points)||area(c.points)<.0004||c.points.some((p,i)=>dist(p,c.points[(i+1)%c.points.length])<.02))throw Error('The chimney must keep a closed footprint at least 2 cm wide.');
 state.wallEdits||={};state.wallEdits.$chimneys||={};state.wallEdits.$chimneys[c.id]={points:c.points};return c;
}
// Read-only redraw scope: resolve chimney footprints once for the whole view.
// Never retain this cache between edits, cancellation, undo, or project loads.
const visibilitySnapshots=new WeakMap();
function withVisibilitySnapshot(state,fn){
 if(!state||visibilitySnapshots.has(state))return fn();
 visibilitySnapshots.set(state,{definitions:null});try{return fn();}finally{visibilitySnapshots.delete(state);}
}
function visibilityDefinitions(state){const snapshot=visibilitySnapshots.get(state);if(!snapshot)return definitions(state);return snapshot.definitions||(snapshot.definitions=definitions(state));}
function visibleParts(face,state){
 if(face.chimney?.volume||(face.chimney?.exposureClipped&&scenes.get(state)?.generated))return [face];
 const W=root.WallSolidGeometry||(typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):null),cs=visibilityDefinitions(state).filter(c=>!face.joinedChimneys?.includes(c.id));if(!W||!cs.length)return [face];
 const frame=W.faceFrame(face);if(!frame||Math.abs(frame.n.z)>1e-5)return [face];
 const ps=face.points,origin=ps[0],u={x:-frame.n.y,y:frame.n.x},ts=ps.map(p=>(p.x-origin.x)*u.x+(p.y-origin.y)*u.y),lo=Math.min(...ts),hi=Math.max(...ts),bottom=Math.min(...ps.map(p=>p.z))-1,top=Math.max(...ps.map(p=>p.z))+1;
 if(hi-lo<EPS)return [face];const a={x:origin.x+u.x*lo,y:origin.y+u.y*lo,z:0},b={x:origin.x+u.x*hi,y:origin.y+u.y*hi,z:0};
 const polygons=face.chimney?[...(buildingBase(state)),...cs.filter(c=>c.id!==face.chimney.id).map(c=>({points:c.points}))]:cs.map(c=>({points:c.points}));
 let start=a,end=b;if(face.chimney){const c=cs.find(c=>c.id===face.chimney.id),i=face.chimney.side;if(c){const v=sub(c.points[(i+1)%c.points.length],c.points[i]),l=Math.hypot(v.x,v.y);start={...a,x:a.x+v.y/l*.00001,y:a.y-v.x/l*.00001};end={...b,x:b.x+v.y/l*.00001,y:b.y-v.x/l*.00001};}}
 const spans=intervals(a,b,polygons,true,{x:start.x-a.x,y:start.y-a.y});if(!spans.length&&!(face.chimney&&scenes.has(state)))return [face];
 const bandOffset={x:start.x-a.x,y:start.y-a.y},bands=face.chimney&&exposureBands(a,b,state,bandOffset,bottom,top,cs.filter(c=>c.id!==face.chimney.id).map(c=>({points:c.points})));
 const bandCuts=[];if(bands){const zs=[bottom,...new Set(bands.flatMap(b=>[b.bottom,b.top])),top].sort((a,b)=>a-b);for(let k=1;k<zs.length;k++){if(zs[k]-zs[k-1]<EPS)continue;const visible=bands.filter(b=>b.bottom<=zs[k-1]+EPS&&b.top>=zs[k]-EPS).map(b=>b.span).sort((a,b)=>a[0]-b[0]);let lo=0;for(const [start,end]of [...visible,[1,1]]){if(start-lo>EPS)bandCuts.push({span:[lo,start],lower:zs[k-1],upper:zs[k]});lo=Math.max(lo,end);}}}
 const cuts=(face.chimney?[...spans.map(span=>({span})),...(bands?bandCuts:[])]:cs.flatMap(c=>volumeIntervals(a,b,c).map(span=>({span,c})))).map(({span:[lo,hi],c,lower=bottom,upper=top})=>{const p=mix(a,b,lo),q=mix(a,b,hi);return {points:[{...p,z:lower},{...q,z:lower},{...q,z:c?Math.max(lower,occlusionHeight(c,q,state)):upper},{...p,z:c?Math.max(lower,occlusionHeight(c,p,state)):upper}].map(p=>W.inFrame(frame,p))};}).filter(c=>Math.abs(area(c.points))>EPS);
 if(!cuts.length)return [face];
 const local={points:ps.map(p=>W.inFrame(frame,p)),holes:(face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))};
 const pieces=W.subtract(local,[...cuts,...local.holes.map(points=>({points}))]).map(r=>clean(r.map(p=>({...p,x:Math.round(p.x*1e8)/1e8,y:Math.round(p.y*1e8)/1e8})),true)).filter(r=>r.length>=3&&Math.abs(area(r))>1e-12);
 return W.joinFragments(pieces).map(f=>({...face,points:f.points.map(p=>W.fromFrame(frame,p)),holes:f.holes.map(r=>r.map(p=>W.fromFrame(frame,p)))}));
}
function visibleSegments(a,b,state,chimney,joinedChimneys=[]){
 if(chimney?.volume||(chimney?.exposureClipped&&scenes.get(state)?.generated))return [[a,b]];
 const cs=visibilityDefinitions(state).filter(c=>!joinedChimneys.includes(c.id));if(!cs.length)return [[a,b]];
 const polygons=chimney?[...(buildingBase(state)),...cs.filter(c=>c.id!==chimney.id).map(c=>({points:c.points}))]:cs.map(c=>({points:c.points}));let offset={x:0,y:0};
 if(chimney){const c=cs.find(c=>c.id===chimney.id);if(c){const v=sub(c.points[(chimney.side+1)%c.points.length],c.points[chimney.side]),len=Math.hypot(v.x,v.y);offset={x:v.y/len*.00001,y:-v.x/len*.00001};}}
 if(chimney){const scene=scenes.get(state);if(!scene)return intervals(a,b,polygons,false,offset).map(([lo,hi])=>[mix(a,b,lo),mix(a,b,hi)]);
  const ts=breaks(a,b,[...scene.faces.flatMap(v=>[v.f.points,...(v.f.holes||[])]),...polygons.map(f=>f.points)]);if(Math.abs(b.z-a.z)>EPS)for(const z of scene.z){const t=(z-a.z)/(b.z-a.z);if(t>EPS&&t<1-EPS)ts.push(t);}ts.sort((a,b)=>a-b);const out=[];for(let i=1;i<ts.length;i++){const q=mix(a,b,(ts[i-1]+ts[i])/2),p={...q,x:q.x+offset.x,y:q.y+offset.y};if(ts[i]-ts[i-1]>EPS&&!polygons.some(f=>contains(f,p))&&!(inBuilding(state,p)&&inBuilding(state,{...p,z:p.z-.00001})&&inBuilding(state,{...p,z:p.z+.00001}))&&!cs.some(c=>c.id!==chimney.id&&contains({points:c.points},p)))out.push([mix(a,b,ts[i-1]),mix(a,b,ts[i])]);}return out;}

 const cuts=[];for(const c of cs)for(let [lo,hi]of volumeIntervals(a,b,c)){const p=mix(a,b,lo),q=mix(a,b,hi),da=p.z-occlusionHeight(c,p,state),db=q.z-occlusionHeight(c,q,state);if(da>EPS&&db>EPS)continue;if(da>EPS)lo=lo+(hi-lo)*da/(da-db);else if(db>EPS)hi=lo+(hi-lo)*da/(da-db);cuts.push([lo,hi]);}
 cuts.sort((a,b)=>a[0]-b[0]);let start=0;const out=[];for(const [lo,hi]of [...cuts,[1,1]]){if(lo-start>EPS)out.push([mix(a,b,start),mix(a,b,lo)]);start=Math.max(start,hi);}return out;
}
const api={heightSampler,withVisibilitySnapshot,preserveFilledFace,alignRoofContacts,syncVolumes,roofWithOpenings,buildingBase,syncFoundation,normalizeDrafts,capHeight,visibleSegments,visibleParts,COLOR,detect,definitions,compose,moveSide,floorAt,intervals};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallChimneys=api;
})(typeof window!=='undefined'?window:globalThis);
