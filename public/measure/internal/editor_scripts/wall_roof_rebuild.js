/* Smart rebuild: follow a changed roof while keeping the wall work. Pure; see docs/architecture/exterior-roof-rebuild.md. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports;
const K=node?require('./exterior_geometry.js'):root.ExteriorGeometry,S=()=>node?require('./base_sketch_geometry.js'):root.BaseSketchGeometry,T=()=>node?require('./roof_trim.js'):root.RoofTrim;
// Roof points are captured from the same pixels; anything that moved by less than this has not moved.
const SAME=1e-4,PLANE=.004,STAGES=['extruded','deduplicated','gapRepaired','mergedWalls','cleanedWalls','alignedWalls'],REPORTS=['extrusionWarnings','removed','gapReport','mergeReport','rakeCleanupReport','chimneyCleanupReport'];
const copy=v=>v===undefined?v:JSON.parse(JSON.stringify(v)),d2=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),d3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),unit=v=>{const l=Math.hypot(v.x,v.y);return l>1e-9?{x:v.x/l,y:v.y/l}:null;};
const family=t=>['head_wall','side_wall','roof_to_wall','headwall','sidewall','roof-to-wall'].includes(t)?'flashing':['eave','rake','parapet','skylight'].includes(t)?'perimeter':/chimney/.test(t||'')?'chimney':'interior';
const lineId=(c,i)=>c.id||'R'+(i+1),number=id=>{const m=/^R(\d+)$/.exec(id||'');return m?Number(m[1]):0;};
const centroid=ps=>ps.reduce((s,p)=>({x:s.x+p.x/ps.length,y:s.y+p.y/ps.length}),{x:0,y:0});
function segment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
function inside(p,ring){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;}

// 1. Which roof lines and faces are the same ones as before. Identity comes from
// the editor's own point and line objects when it has them (hints), then from
// unchanged positions, then from geometry: a line that kept an endpoint and its
// direction, or a parallel overlapping line nearby, is the same line moved.
// The returned roof keeps every known line's id and order, so walls built from
// it keep their ids; new lines get ids no earlier roof used.
function identify(before,after,hints={}){
 const op=before?.points||[],np=after?.points||[],oc=before?.connections||[],nc=after?.connections||[];
 const pmap=new Map(),pused=new Set(),link=(n,o)=>{if(n==null||o==null||pmap.has(n)||pused.has(o)||!op[o]||!np[n])return;pmap.set(n,o);pused.add(o);};
 for(const [n,o] of hints.points||[])link(n,o);
 np.forEach((p,n)=>{if(pmap.has(n))return;const o=op.findIndex((q,i)=>!pused.has(i)&&d3(p,q)<SAME);if(o>=0)link(n,o);});
 const cmap=new Map(),cused=new Set(),pair=(n,o)=>{if(n==null||o==null||cmap.has(n)||cused.has(o)||!oc[o]||!nc[n])return;cmap.set(n,o);cused.add(o);};
 for(const [n,o] of hints.connections||[])pair(n,o);
 // Two lines can join the same points (a ridge over a head wall): match the same type first.
 for(const sameType of [true,false])nc.forEach((c,n)=>{if(cmap.has(n))return;const a=pmap.get(c.startIdx),b=pmap.get(c.endIdx);if(a===undefined||b===undefined)return;const o=oc.findIndex((k,i)=>!cused.has(i)&&(!sameType||k.type===c.type)&&(k.startIdx===a&&k.endIdx===b||k.startIdx===b&&k.endIdx===a));if(o>=0)pair(n,o);});
 const candidates=[];
 nc.forEach((c,n)=>{if(cmap.has(n))return;const s={a:np[c.startIdx],b:np[c.endIdx]};if(!s.a||!s.b)return;const ls=d2(s.a,s.b);if(ls<.01)return;
  oc.forEach((k,o)=>{if(cused.has(o))return;const t={a:op[k.startIdx],b:op[k.endIdx]};if(!t.a||!t.b)return;const lt=d2(t.a,t.b);if(lt<.01)return;
   const u={x:(t.b.x-t.a.x)/lt,y:(t.b.y-t.a.y)/lt},v={x:(s.b.x-s.a.x)/ls,y:(s.b.y-s.a.y)/ls},angle=Math.acos(Math.min(1,Math.abs(u.x*v.x+u.y*v.y)));
   const shared=[c.startIdx,c.endIdx].some(i=>{const m=pmap.get(i);return m!==undefined&&(m===k.startIdx||m===k.endIdx);});
   const along=p=>(p.x-t.a.x)*u.x+(p.y-t.a.y)*u.y,overlap=Math.max(0,Math.min(lt,Math.max(along(s.a),along(s.b)))-Math.max(0,Math.min(along(s.a),along(s.b))))/Math.min(lt,ls);
   const mid=mix(s.a,s.b,.5),offset=Math.abs((mid.x-t.a.x)*-u.y+(mid.y-t.a.y)*u.x);
   if(!(shared&&angle<.45&&Math.min(lt,ls)/Math.max(lt,ls)>.33||angle<.14&&overlap>.5&&offset<2))return;
   candidates.push({n,o,score:offset+2*angle+(c.type===k.type?0:.5)+(family(c.type)===family(k.type)?0:1)-(shared?.5:0)});
  });
 });
 candidates.sort((a,b)=>a.score-b.score);for(const c of candidates)pair(c.n,c.o);
 // A moved line's endpoints are the same points, moved.
 for(const [n,o] of cmap){const c=nc[n],k=oc[o];if(!np[c.startIdx]||!np[c.endIdx]||!op[k.startIdx]||!op[k.endIdx])continue;
  const flip=pmap.get(c.startIdx)===k.endIdx||pmap.get(c.endIdx)===k.startIdx||!(pmap.get(c.startIdx)===k.startIdx||pmap.get(c.endIdx)===k.endIdx)&&d3(np[c.startIdx],op[k.endIdx])+d3(np[c.endIdx],op[k.startIdx])<d3(np[c.startIdx],op[k.startIdx])+d3(np[c.endIdx],op[k.endIdx]);
  link(c.startIdx,flip?k.endIdx:k.startIdx);link(c.endIdx,flip?k.startIdx:k.endIdx);}
 const order=(list,map)=>[...list.keys()].sort((a,b)=>(map.has(a)?map.get(a):1e9+a)-(map.has(b)?map.get(b):1e9+b));
 const porder=order(np,pmap),pindex=new Map(porder.map((n,i)=>[n,i])),points=porder.map(n=>copy(np[n]));
 let next=oc.reduce((m,k,i)=>Math.max(m,number(lineId(k,i))),0);
 const lines=[],connections=order(nc,cmap).filter(n=>pindex.has(nc[n].startIdx)&&pindex.has(nc[n].endIdx)).map(n=>{
  const c=nc[n],o=cmap.get(n),out={...copy(c),startIdx:pindex.get(c.startIdx),endIdx:pindex.get(c.endIdx)};
  if(o===undefined){out.id='R'+(++next);lines.push({class:'added',id:out.id,to:c.type});return out;}
  const k=oc[o],a=np[c.startIdx],b=np[c.endIdx],x=op[k.startIdx],y=op[k.endIdx],same=a&&b&&x&&y&&(d3(a,x)<SAME&&d3(b,y)<SAME||d3(a,y)<SAME&&d3(b,x)<SAME);
  out.id=lineId(k,o);lines.push({class:same?(c.type===k.type?'unchanged':'type'):'moved',id:out.id,from:k.type,to:c.type,typeChanged:c.type!==k.type});return out;
 });
 oc.forEach((k,o)=>{if(!cused.has(o))lines.push({class:'removed',id:lineId(k,o),from:k.type});});
 // Faces: the same outline, else the face that covers the same place.
 const of=before?.faces||[],nf=after?.faces||[],fmap=new Map(),fused=new Set(),ring=f=>[f.points,...(f.holes||[])].map(r=>r.map(p=>[p.x,p.y,p.z].map(v=>Math.round(v/SAME)).join(',')).sort().join(';')).sort().join('|');
 const okeys=of.map(ring);nf.forEach((f,n)=>{const key=ring(f),o=okeys.findIndex((k,i)=>!fused.has(i)&&k===key);if(o>=0){fmap.set(n,o);fused.add(o);}});
 const area=f=>Math.abs(K.signedArea(f.points)),fc=[];
 nf.forEach((f,n)=>{if(fmap.has(n)||f.points.length<3)return;const c=centroid(f.points);of.forEach((g,o)=>{if(fused.has(o)||g.points.length<3)return;const e=centroid(g.points);if(!inside(c,g.points)&&!inside(e,f.points))return;fc.push({n,o,score:Math.abs(area(f)-area(g))/Math.max(area(f),area(g),1e-9)+d2(c,e)});});});
 fc.sort((a,b)=>a.score-b.score);const faceLinks=new Map();for(const c of fc)if(!faceLinks.has(c.n)&&![...faceLinks.values()].includes(c.o)&&!fused.has(c.o))faceLinks.set(c.n,c.o);
 for(const [n,o] of faceLinks){fmap.set(n,o);fused.add(o);}
 let nextFace=of.reduce((m,f,i)=>Math.max(m,Number.isFinite(f.id)?f.id:i),-1);
 const faceClasses=[],faces=order(nf,fmap).map(n=>{const o=fmap.get(n),f=copy(nf[n]);if(o===undefined){f.id=++nextFace;faceClasses.push({class:'added',id:f.id});}else{f.id=of[o].id??o;faceClasses.push({class:faceLinks.has(n)?'changed':'unchanged',id:f.id});}return f;});
 of.forEach((f,o)=>{if(!fused.has(o))faceClasses.push({class:'removed',id:f.id??o});});
 const changed=lines.some(l=>l.class!=='unchanged')||faceClasses.some(f=>f.class!=='unchanged')||np.length!==op.length||np.some((p,n)=>!pmap.has(n)||d3(p,op[pmap.get(n)])>=SAME);
 return {roof:{...copy(after),points,connections,faces},lines,faces:faceClasses,changed,counts:count(lines),faceCounts:count(faceClasses)};
}
function count(items){const out={};for(const i of items)out[i.class]=(out[i.class]||0)+1;return out;}

// 2. Generated walls. Both inputs come from the same generator run on the old and the
// new roof, so any difference between them is the roof change. Walls keep their ids.
const quad=w=>[...(w.bottom||[]),...(w.top||[])];
function direction(w){return unit({x:w.bottom[1].x-w.bottom[0].x,y:w.bottom[1].y-w.bottom[0].y})||unit({x:w.top[1].x-w.top[0].x,y:w.top[1].y-w.top[0].y});}
const root_=w=>String(w.sourceId||'').replace(/\.\d+$/,'');
function diffWalls(A,B){
 // Pair by place, not by id: the generator numbers pieces of a base edge or roof line in
 // order, so a change can renumber walls it did not move. Identical walls pair first
 // (their own id preferred), then walls of the same roof line that overlap where they stand.
 const pairs=new Map(),usedA=new Set(),usedB=new Set(),rename=new Map(),shape=w=>stable([w.kind,quad(w)]),link=(x,y)=>{usedA.add(x);usedB.add(y);if(y.id!==x.id)rename.set(y.id,x.id);pairs.set(x.id,{a:x,b:y,same:stable(x)===stable({...y,id:x.id})});};
 const byShape=new Map();for(const y of B||[]){const k=shape(y);if(!byShape.has(k))byShape.set(k,[]);byShape.get(k).push(y);}
 for(const pass of [0,1])for(const x of A||[]){if(usedA.has(x))continue;const y=(byShape.get(shape(x))||[]).find(y=>!usedB.has(y)&&(pass||y.id===x.id));if(y)link(x,y);}
 const cands=[];
 for(const x of A||[]){if(usedA.has(x))continue;for(const y of B||[]){
  if(usedB.has(y)||x.kind!==y.kind||root_(x)!==root_(y))continue;const u=direction(x),v=direction(y);if(!u||!v||Math.abs(u.x*v.x+u.y*v.y)<.985)continue;
  const o=x.bottom[0],len=d2(x.bottom[0],x.bottom[1]),t=p=>(p.x-o.x)*u.x+(p.y-o.y)*u.y,lo=Math.max(0,Math.min(t(y.bottom[0]),t(y.bottom[1]))),hi=Math.min(len,Math.max(t(y.bottom[0]),t(y.bottom[1])));
  const overlap=(hi-lo)/Math.max(1e-6,Math.min(len,d2(y.bottom[0],y.bottom[1]))),offset=Math.abs((y.bottom[0].x-o.x)*-u.y+(y.bottom[0].y-o.y)*u.x);
  if(overlap>.3&&offset<3)cands.push({x,y,score:offset+(1-overlap)-(x.id===y.id?.25:0)});
 }}
 cands.sort((p,q)=>p.score-q.score);for(const {x,y} of cands)if(!usedA.has(x)&&!usedB.has(y))link(x,y);
 const removed=(A||[]).filter(x=>!usedA.has(x)),taken=new Set([...(A||[]),...(B||[])].map(w=>w.id));
 // A new wall must never inherit the edits of a different wall that had its id.
 const added=(B||[]).filter(y=>!usedB.has(y)).map(y=>{if(!(A||[]).some(x=>x.id===y.id)&&!rename.has(y.id))return y;let i=1;while(taken.has(y.id+'~'+i))i++;const id=y.id+'~'+i;taken.add(id);rename.set(y.id,id);return {...y,id};});
 const names=w=>{if(!w.mergeGroup)return w;const ids=String(w.mergeGroup).split('|').map(id=>rename.get(id)||id);return {...w,mergeGroup:ids.slice().sort().join('|')};};
 for(const [id,p] of pairs){const b=names({...p.b,id});p.b=b;p.same=stable(p.a)===stable(b);}
 return {pairs,removed,added:added.map(names),rename};
}
// current + (new - old): the change the roof made, applied to the wall as it is now.
// Rounding noise between the two runs (down to 1e-15 m, up to 1e-8 m where a changed face is
// re-intersected) is no change: anything under a micron is the same place.
const at=(v,d)=>Math.abs(d)<1e-6?v:v+d,stable=v=>JSON.stringify(v,(k,x)=>typeof x==='number'?Math.round(x*1e6)/1e6:x);
function shift(c,a,b){
 const out=copy(c);
 for(const k of new Set([...Object.keys(a),...Object.keys(b)])){if(['id','bottom','top'].includes(k))continue;if(stable(a[k])!==stable(b[k])){if(b[k]===undefined)delete out[k];else out[k]=copy(b[k]);}}
 for(const e of ['bottom','top'])out[e]=c[e]?.length===a[e]?.length&&a[e]?.length===b[e]?.length?c[e].map((p,i)=>({...p,x:at(p.x,b[e][i].x-a[e][i].x),y:at(p.y,b[e][i].y-a[e][i].y),z:at(p.z,b[e][i].z-a[e][i].z)})):copy(b[e]);
 return out;
}
// A point on wall a, at the same place on wall b (along the bottom, then up the face).
function follow(p,a,b){
 const u={x:a.bottom[1].x-a.bottom[0].x,y:a.bottom[1].y-a.bottom[0].y},l2=u.x*u.x+u.y*u.y,s=l2>1e-12?((p.x-a.bottom[0].x)*u.x+(p.y-a.bottom[0].y)*u.y)/l2:0;
 const lo=mix(a.bottom[0],a.bottom[1],s),hi=mix(a.top[0],a.top[1],s),t=Math.abs(hi.z-lo.z)>1e-9?(p.z-lo.z)/(hi.z-lo.z):0,L=mix(b.bottom[0],b.bottom[1],s),H=mix(b.top[0],b.top[1],s);
 return {...p,x:L.x+(p.x-lo.x),y:L.y+(p.y-lo.y),z:L.z+(H.z-L.z)*t};
}
function patchWalls(current,A,B,diff=diffWalls(A,B)){
 const removedIds=new Set(diff.removed.map(w=>w.id)),walls=[],moved=[],removed=[];
 for(const c of current||[]){
  const p=diff.pairs.get(c.id),parent=String(c.id).replace(/(-grade-\d+)+$/,''),q=!p&&parent!==c.id?diff.pairs.get(parent):null;
  if(p){if(p.same){walls.push(c);continue;}const n=shift(c,p.a,p.b);if(JSON.stringify(n)===JSON.stringify(c)){walls.push(c);continue;}walls.push(n);if(quad(n).some((v,i)=>d3(v,quad(c)[i])>1e-7))moved.push({before:c,after:n});continue;}
  if(removedIds.has(c.id)||!q&&parent!==c.id&&removedIds.has(parent)){removed.push(c);continue;}
  if(q&&!q.same){const n={...copy(c),bottom:c.bottom.map(v=>follow(v,q.a,q.b)),top:c.top.map(v=>follow(v,q.a,q.b))};walls.push(n);moved.push({before:c,after:n});continue;}
  walls.push(c);
 }
 const ids=new Set(walls.map(w=>w.id)),added=[];
 for(const w of diff.added){let id=w.id,i=1;while(ids.has(id))id=w.id+'~'+(i++);const n=id===w.id?w:{...w,id};ids.add(id);walls.push(n);added.push(n);}
 return {walls,moved,removed,added};
}

// 3. Chimneys are found from the roof; keep each one's id (drafts and volumes use it)
// when the new roof describes the same footprint, or one in the same place.
function matchChimneys(before,detected){
 if(!detected)return {chimneys:before,removed:[]};
 const old=before?.items||[],items=[],used=new Set();
 const same=(a,b)=>a.points.length===b.points.length&&a.points.every(p=>b.points.some(q=>d2(p,q)<.02));
 for(const c of detected.items||[]){
  let o=old.find(x=>!used.has(x.id)&&same(x,c));if(o){used.add(o.id);items.push(copy(o));continue;}
  o=old.find(x=>!used.has(x.id)&&(inside(centroid(c.points),x.points)||inside(centroid(x.points),c.points)));
  if(o){used.add(o.id);items.push({...copy(c),id:o.id,...(Number.isFinite(c.dsmTop)?{}:Number.isFinite(o.dsmTop)?{dsmTop:o.dsmTop}:{})});continue;}
  let id=c.id,i=1;while(old.some(x=>x.id===id)||items.some(x=>x.id===id))id=c.id+'~'+(i++);items.push({...copy(c),id});
 }
 const removed=old.filter(x=>!used.has(x.id)).map(x=>x.id);
 if(!removed.length&&items.length===old.length&&items.every((c,i)=>JSON.stringify(c)===JSON.stringify(old[i])))return {chimneys:before,removed};
 return {chimneys:{...copy(before||{}),...copy(detected),items},removed};
}

// 4. Moving a wall: turn about the end that moved least, then shift along the new
// normal. Its points keep their place along the wall; the draft follow (reflow)
// stretches its outline to the new ends.
function motion(b,a){
 const p=b.bottom,q=a.bottom,u=direction(b),v=direction(a);if(!u||!v)return null;
 const end=d2(p[0],q[0])<=d2(p[1],q[1])?0:1,pivot=p[end],theta=Math.atan2(v.y,v.x)-Math.atan2(u.y,u.x),n={x:-v.y,y:v.x},s=(q[end].x-pivot.x)*n.x+(q[end].y-pivot.y)*n.y;
 const T={theta:Math.atan2(Math.sin(theta),Math.cos(theta)),pivot:{x:pivot.x,y:pivot.y},shift:{x:n.x*s,y:n.y*s}};T.identity=Math.abs(T.theta)<1e-7&&Math.hypot(T.shift.x,T.shift.y)<1e-7;return T;
}
function move(T,p){if(!T||T.identity)return p;const c=Math.cos(T.theta),s=Math.sin(T.theta),x=p.x-T.pivot.x,y=p.y-T.pivot.y;return {...p,x:T.pivot.x+c*x-s*y+T.shift.x,y:T.pivot.y+s*x+c*y+T.shift.y};}
function turn(T,v){if(!T||!v)return v;const c=Math.cos(T.theta),s=Math.sin(T.theta);return {...v,x:c*v.x-s*v.y,y:s*v.x+c*v.y};}
const STILL={theta:0,pivot:{x:0,y:0},shift:{x:0,y:0},identity:true};
// Two walls move together when they land on the same line; how far along it is the follow's to settle.
const sameMotion=(a,b,probe,u={x:1,y:0})=>{a=a||STILL;b=b||STILL;if(Math.abs(a.theta-b.theta)>=1e-4)return false;const p=move(a,probe),q=move(b,probe),n=turn(a,{x:-u.y,y:u.x});return Math.abs((p.x-q.x)*n.x+(p.y-q.y)*n.y)<.002;};
function onWall(p,w,tol=PLANE){
 const a=w.bottom[0],b=w.bottom[1],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<1e-6)return false;
 const s=((p.x-a.x)*dx+(p.y-a.y)*dy)/(len*len);if(Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/len>tol||s<-tol/len||s>1+tol/len)return false;
 const lo=Math.min(mix(a,b,s).z,w.top[0].z+(w.top[1].z-w.top[0].z)*s),hi=Math.max(mix(a,b,s).z,w.top[0].z+(w.top[1].z-w.top[0].z)*s);return p.z>=lo-tol&&p.z<=hi+tol;
}
const keyOf=p=>[p.x,p.y,p.z].map(v=>Math.round(v*1000)).join(':');
function mapFace(f,fn){const out={...f,points:f.points.map(fn),...(f.holes?{holes:f.holes.map(r=>r.map(fn))}:{}),...(f.retainedPoints?{retainedPoints:f.retainedPoints.map(fn)}:{})};if(K?.mapCurveData&&(f.curves||f.curvedSurface||f.trimData||f.joinedChimneys))Object.assign(out,K.mapCurveData(f,fn));return out;}
const parseKey=k=>{const [x,y,z]=String(k).split(',').map(Number);return [x,y,z].every(Number.isFinite)?{x,y,z}:null;},vertexKey=p=>Number(p.x).toFixed(6)+','+Number(p.y).toFixed(6)+','+Number(p.z).toFixed(6);
const features=d=>(d?.faces||[]).filter(f=>f.feature&&!f.solidId);
const featureName=f=>{const t=String(f.feature?.type||f.feature?.kind||'sticker').toLowerCase();return /door/.test(t)?'door':/window/.test(t)?'window':'sticker';};
function dropFeature(d,f){
 const ids=new Set(f.points.map(p=>p.nodeId).filter(Boolean));d.faces=d.faces.filter(x=>x!==f);if(!d.sketch)return;
 d.sketch.edges=d.sketch.edges.filter(e=>e.fixed||!(ids.has(e.a)&&ids.has(e.b)));const used=new Set(d.sketch.edges.flatMap(e=>[e.a,e.b]));
 d.sketch.nodes=d.sketch.nodes.filter(n=>n.fixed||!ids.has(n.id)||used.has(n.id));
}

// 5. Carry the edits across. Only edits that touch a moved or removed wall change.
function carry(edits,ctx){
 const e=copy(edits||{}),report={drafts:{followed:0,split:0,removed:0,rebuilt:0},features:[],surfaces:{moved:0,removed:0},chimneys:ctx.removedChimneys?.length||0,parapets:0,closedSoffits:0};
 const motions=new Map(),before=new Map((ctx.before||[]).map(w=>[w.id,w])),after=new Map((ctx.after||[]).map(w=>[w.id,w]));
 for(const m of ctx.moved||[])motions.set(m.before.id,{before:m.before,after:m.after,T:motion(m.before,m.after)});
 const removed=new Set((ctx.removed||[]).map(w=>w.id)),chimneys=new Set(ctx.removedChimneys||[]),lost=f=>report.features.push(featureName(f));
 // A wall whose foot did not move (only its top followed the roof) holds still.
 const staticWalls=(ctx.after||[]).filter(w=>before.has(w.id)&&(!motions.has(w.id)||motions.get(w.id).T?.identity)).map(w=>before.get(w.id)),removedWalls=(ctx.removed||[]);
 for(const id of removed)delete e[id];
 if(e.$merges)e.$merges=e.$merges.map(g=>g.filter(id=>!removed.has(id))).filter(g=>g.length>1);
 if(e.$joints)e.$joints=e.$joints.filter(pair=>!pair.some(v=>removed.has(v?.id)));
 // Walls drafted into faces follow their walls. A face whose walls now disagree splits:
 // each part keeps the walls that moved together and the windows that sit on them.
 const shapeIn=(o,u)=>w=>[w.bottom[0],w.bottom[1],w.top[1],w.top[0]].map(p=>({x:(p.x-o.x)*u.x+(p.y-o.y)*u.y,y:p.z})),near=(p,q)=>inside(p,q)||q.some((a,i)=>segment(p,a,q[(i+1)%q.length])<.02);
 function part(d,key,g,members){
  const T=g.T&&!g.T.identity?g.T:null,o=d.origin,u=d.u,o2=T?move(T,o):o,u2=T?turn(T,u):u,was=shapeIn(o,u),now=shapeIn(o2,u2);
  const own=[...g.ids.map(id=>before.get(id)).filter(Boolean).map(was),...g.ids.map(id=>motions.get(id)?.after||after.get(id)).filter(Boolean).map(now)];
  const others=members.filter(id=>!g.ids.includes(id)).map(id=>before.get(id)).filter(Boolean).map(was);
  // Sketch points only the other walls carried leave with them; the follow outlines the rest.
  if(others.length&&d.sketch){const drop=new Set(d.sketch.nodes.filter(n=>others.some(q=>near(n,q))&&!own.some(q=>near(n,q))).map(n=>n.id));if(drop.size){d.sketch.nodes=d.sketch.nodes.filter(n=>!drop.has(n.id));d.sketch.edges=d.sketch.edges.filter(x=>!drop.has(x.a)&&!drop.has(x.b));}}
  if(T){d.origin=o2;d.u=u2;}
  d.members=g.ids.slice();
  const old=g.ids.map(id=>{const w=before.get(id)||after.get(id);return w&&T?{...w,bottom:w.bottom.map(p=>move(T,p)),top:w.top.map(p=>move(T,p))}:w;}).filter(Boolean),current=g.ids.map(id=>motions.get(id)?.after||after.get(id)||before.get(id)).filter(Boolean);
  if(ctx.reflow&&current.length)ctx.reflow(old,current,{$drafts:{[key]:d}});
  // A window, door or sticker stays only on the walls of its part.
  const quads=current.map(shapeIn(d.origin,d.u));for(const f of features(d))if(!quads.some(q=>near(centroid(f.points),q)))dropFeature(d,f);
  return d.faces?.length&&d.members.length?d:null;
 }
 for(const [key,d] of Object.entries(e.$drafts||{})){
  if(d.frame||d.mergedInto||!Array.isArray(d.members))continue;
  if(d.chimney&&chimneys.has(d.chimney.id)||[...chimneys].some(id=>key.startsWith(id+':'))){features(d).forEach(lost);delete e.$drafts[key];report.drafts.removed++;continue;}
  const members=d.members,gone=members.filter(id=>removed.has(id)),movers=members.filter(id=>motions.has(id));if(!gone.length&&!movers.length)continue;
  const had=features(d),original=copy(d),probe=d.origin||{x:0,y:0},groups=[];delete e.$drafts[key];
  for(const id of members.filter(id=>!removed.has(id))){const T=motions.get(id)?.T||null,g=groups.find(g=>sameMotion(g.T,T,probe,d.u)),w=before.get(id),area=w?d2(w.bottom[0],w.bottom[1])*Math.abs((w.top[0].z+w.top[1].z-w.bottom[0].z-w.bottom[1].z)/2):0;if(g){g.ids.push(id);g.area+=area;}else groups.push({T,ids:[id],area});}
  // Every wall it drew is gone: the face goes with them.
  if(!groups.length){had.forEach(lost);report.drafts.removed++;continue;}
  // Without the draft follow a face cannot reshape to fewer walls; those walls are rebuilt.
  const split=gone.length>0||groups.length>1;if(split&&!ctx.reflow){had.forEach(lost);report.drafts.rebuilt++;continue;}
  groups.sort((a,b)=>b.area-a.area);const parts=[];
  for(const [i,g] of groups.entries()){
   let k=i?g.ids.slice().sort().join('|'):key;for(let n=1;e.$drafts[k]||parts.some(p=>p.key===k);n++)k=g.ids.slice().sort().join('|')+'~'+n;
   try{const d2=part(i?copy(original):d,k,g,members);if(d2)parts.push({key:k,d:d2});}catch(error){if(!split){const d3=copy(original),T=g.T&&!g.T.identity?g.T:null;if(T){d3.origin=move(T,d3.origin);d3.u=turn(T,d3.u);}parts.push({key:k,d:d3});}}
  }
  for(const p of parts)e.$drafts[p.key]=p.d;
  // Every window, door or sticker no part holds is reported.
  const held=new Set(parts.flatMap(p=>features(p.d).map(f=>f.id)));for(const f of had)if(!held.has(f.id))lost(f);
  if(!parts.length)report.drafts.rebuilt++;else if(split)report.drafts.split++;else report.drafts.followed++;
 }
 // Faces drawn, extruded or pasted in world space go with the wall they sit on.
 // A point at a corner shared with a wall that holds still is ambiguous and holds still.
 const vote=p=>{let moving=null;for(const [id,m] of motions)if(m.T&&!m.T.identity&&onWall(p,m.before)){moving=id;break;}if(staticWalls.some(w=>onWall(p,w)))return {kind:'stay'};if(moving)return {kind:'move',id:moving};return removedWalls.some(w=>onWall(p,w))?{kind:'remove'}:null;};
 const decide=points=>{const tally=new Map();for(const p of points){const v=vote(p);if(!v)continue;const k=v.kind+':'+(v.id||'');tally.set(k,(tally.get(k)||0)+1);}const top=[...tally].sort((a,b)=>b[1]-a[1]||(a[0].startsWith('stay')?-1:1))[0];if(!top)return null;const [kind,id]=top[0].split(/:(.*)/s);return {kind,id};};
 const surfaces=e.$surfaces||[],choice=new Map(),regenerated=f=>f.closedSoffit||f.parapet||f.chimney;
 for(const f of surfaces){if(f.chimney&&chimneys.has(f.chimney.id)){choice.set(f,{kind:'remove'});continue;}if(regenerated(f))continue;const c=decide([f.points,...(f.holes||[])].flat());if(c)choice.set(f,c);}
 // Faces off the wall (an extrusion's cap) go with the faces they are joined to.
 const byKey=new Map();for(const f of surfaces)if(!regenerated(f))for(const p of f.points){const k=keyOf(p);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(f);}
 for(let grew=true;grew;){grew=false;for(const f of surfaces){if(choice.has(f)||regenerated(f))continue;for(const p of f.points){const n=(byKey.get(keyOf(p))||[]).find(g=>choice.has(g)&&choice.get(g).kind!=='stay');if(n){choice.set(f,choice.get(n));grew=true;break;}}}}
 const dropped=new Set();
 e.$surfaces=surfaces.flatMap(f=>{const c=choice.get(f);if(!c||c.kind==='stay')return [f];if(c.kind==='remove'){dropped.add(f.id);if(f.feature)lost(f);report.surfaces.removed++;return [];}const T=motions.get(c.id)?.T;if(!T||T.identity)return [f];report.surfaces.moved++;return [{...mapFace(f,p=>move(T,p)),_moved:c.id}];});
 // Generated parapets and closed soffits are rebuilt for the walls and lines that changed.
 const affectedSources=new Set(ctx.affectedSources||[]),affectedWalls=new Set([...motions.keys(),...removed]);
 e.$surfaces=e.$surfaces.filter(f=>{
  if(f.parapet&&affectedSources.has(f.parapet.sourceId)){dropped.add(f.id);return false;}
  if(f.closedSoffit&&[f.closedSoffit.wallId,...(f.closedSoffit.wallIds||[])].some(id=>affectedWalls.has(id))){dropped.add(f.id);return false;}
  return true;
 });
 if(ctx.parapets&&affectedSources.size){const fresh=ctx.parapets().filter(f=>affectedSources.has(f.parapet?.sourceId)&&!e.$surfaces.some(g=>g.id===f.id));e.$surfaces.push(...fresh);report.parapets=fresh.length;}
 if(ctx.closedSoffits){const walls=[...[...motions.values()].map(m=>m.after),...(ctx.added||[])];const fresh=walls.length?ctx.closedSoffits(walls).filter(f=>!e.$surfaces.some(g=>g.id===f.id)):[];e.$surfaces.push(...fresh);report.closedSoffits=fresh.length;}
 // Faces moved into frame drafts (and construction planes) go with their face.
 for(const [key,d] of Object.entries(e.$drafts||{})){
  if(!d.frame)continue;
  if(d.solidHost&&dropped.has(d.solidHost)||d.chimney&&chimneys.has(d.chimney.id)){features(d).forEach(lost);delete e.$drafts[key];report.drafts.removed++;continue;}
  const host=d.solidHost&&e.$surfaces.find(f=>f.id===d.solidHost),c=host?._moved?{kind:'move',id:host._moved}:host?null:decide([d.frame.origin]);
  const Tm=c?.kind==='move'?motions.get(c.id)?.T:null;
  if(c?.kind==='remove'&&!host){features(d).forEach(lost);delete e.$drafts[key];report.drafts.removed++;continue;}
  if(Tm&&!Tm.identity){d.frame={...d.frame,origin:move(Tm,d.frame.origin),u:turn(Tm,d.frame.u),v:turn(Tm,d.frame.v),n:turn(Tm,d.frame.n)};report.drafts.followed++;}
 }
 for(const f of e.$surfaces)delete f._moved;
 // Loose lines and hidden points sit on walls too.
 const at=p=>{const c=vote(p);return c?.kind==='move'?move(motions.get(c.id).T,p):p;};
 if(e.$loose){if(e.$loose.points)e.$loose.points=e.$loose.points.map(at);if(e.$loose.edges)e.$loose.edges=e.$loose.edges.map(pair=>pair.map(at));}
 const rekey=k=>{const p=parseKey(k);return p?vertexKey(at(p)):k;};
 if(e.$removedSurfacePoints)e.$removedSurfacePoints=e.$removedSurfacePoints.map(rekey);
 if(e.$removedSurfaceEdges)e.$removedSurfaceEdges=e.$removedSurfaceEdges.map(k=>String(k).includes('|')?String(k).split('|').map(rekey).sort().join('|'):k);
 for(const id of chimneys){if(e.$chimneyVolumes)delete e.$chimneyVolumes[id];if(e.$chimneys)delete e.$chimneys[id];}
 return {edits:e,report};
}

// Roof trim settings are keyed by their ends; a moved line takes its settings along.
function roofTrim(settings,before,after,lines){
 const R=T();if(!R||!settings?.edges||!lines?.some(l=>l.class==='moved'))return settings;
 const oldEdges=R.perimeter(before),newEdges=R.perimeter(after),next=copy(settings);
 const on=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1e-12)return null;const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;return Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/Math.sqrt(l2)<.01&&t>-1e-3&&t<1+1e-3?t:null;};
 const conn=(roof,id)=>{const i=roof.connections.findIndex((c,j)=>lineId(c,j)===id);return i<0?null:{a:roof.points[roof.connections[i].startIdx],b:roof.points[roof.connections[i].endIdx]};};
 for(const l of lines.filter(l=>l.class==='moved')){
  const x=conn(before,l.id),y=conn(after,l.id);if(!x||!y)continue;
  const span=(edge,c)=>{const s=on(edge.a,c.a,c.b),t=on(edge.b,c.a,c.b);return s===null||t===null?null:[Math.min(s,t),Math.max(s,t)];};
  for(const o of oldEdges){const saved=settings.edges[o.id];if(!saved)continue;const so=span(o,x);if(!so)continue;
   const best=newEdges.map(n=>({n,s:span(n,y)})).filter(c=>c.s).map(c=>({...c,overlap:Math.min(c.s[1],so[1])-Math.max(c.s[0],so[0])})).sort((a,b)=>b.overlap-a.overlap)[0];
   if(best&&best.overlap>0&&!next.edges[best.n.id])next.edges[best.n.id]=copy(saved);}
 }
 return next;
}

// 6. The whole step. run(roof, chimneys) is the wall generator in a fresh,
// edit-free context; the same generator runs on the old and the new roof.
function rebuild({state,roof,hints,run,detect,reflow,parapets,closedSoffits}){
 const identity=identify(state.roof,roof,hints);if(!identity.changed)return {state:{...state,roof:identity.roof},report:{unchanged:true,lines:identity.counts},changed:false};
 const lineChanged=identity.lines.some(l=>l.class!=='unchanged'&&[l.from,l.to].some(t=>family(t)==='chimney'));
 const chimneys=matchChimneys(state.chimneys,lineChanged&&detect?detect(identity.roof):null);
 const A=run(state.roof,state.chimneys),B=run(identity.roof,chimneys.chimneys),next={...state};
 const finalKey=[...STAGES].reverse().find(k=>state[k])||'alignedWalls';let final={walls:[],moved:[],removed:[],added:[]};
 for(const key of STAGES){if(!state[key])continue;const p=patchWalls(state[key],A[key]||[],B[key]||[]);next[key]=p.walls;if(key===finalKey)final=p;}
 next.roof=identity.roof;next.sources=B.sources;next.warnings=B.warnings;next.chimneys=chimneys.chimneys;
 for(const k of REPORTS)if(JSON.stringify(A[k])!==JSON.stringify(B[k])){if(B[k]===undefined)delete next[k];else next[k]=copy(B[k]);}
 const oldSources=new Map((A.sources||[]).map(s=>[s.id,JSON.stringify(s)])),affectedSources=[...new Set([...(B.sources||[]).filter(s=>oldSources.get(s.id)!==JSON.stringify(s)).map(s=>s.id),...[...oldSources.keys()].filter(id=>!(B.sources||[]).some(s=>s.id===id))])];
 const carried=carry(state.wallEdits,{before:state[finalKey]||[],after:final.walls,moved:final.moved,removed:final.removed,added:final.added,reflow,removedChimneys:chimneys.removed,affectedSources,parapets:parapets&&(()=>parapets(next.roof,next.sources,final.walls)),closedSoffits:closedSoffits&&(walls=>closedSoffits({...next,wallEdits:{}},walls))});
 next.wallEdits=carried.edits;next.roofTrim=roofTrim(state.roofTrim,state.roof,identity.roof,identity.lines);
 const report={lines:identity.counts,faces:identity.faceCounts,walls:{moved:final.moved.length,removed:final.removed.length,added:final.added.length,kept:final.walls.length-final.moved.length-final.added.length},movedWalls:final.moved.map(m=>m.after.id),removedWalls:final.removed.map(w=>w.id),addedWalls:final.added.map(w=>w.id),...carried.report};
 return {state:next,report,changed:true};
}
function summary(r){
 if(!r||r.unchanged)return '';
 const n=(k,one,many=one+'s')=>k?k+' '+(k===1?one:many):'',list=parts=>parts.filter(Boolean).join(', ');
 const lines=list([n(r.lines?.type,'line changed type','lines changed type'),n(r.lines?.moved,'line moved','lines moved'),n(r.lines?.added,'line added','lines added'),n(r.lines?.removed,'line removed','lines removed')]);
 const walls=list([n(r.walls?.moved,'wall moved','walls moved'),n(r.walls?.removed,'wall removed','walls removed'),n(r.walls?.added,'new wall','new walls')]);
 const lostCounts={};for(const f of r.features||[])lostCounts[f]=(lostCounts[f]||0)+1;
 const lost=list(Object.entries(lostCounts).map(([k,v])=>n(v,k)));
 const edited=list([r.drafts?.removed?n(r.drafts.removed,'edited wall was','edited walls were')+(r.drafts.removed===1?' removed with its roof line':' removed with their roof lines'):'',r.drafts?.rebuilt?n(r.drafts.rebuilt,'edited wall was','edited walls were')+' rebuilt from the roof':'',r.drafts?.split?n(r.drafts.split,'edited wall was','edited walls were')+' split where the roof moved part of it':'']);
 return 'Roof change applied to the walls'+(lines?' ('+lines+')':'')+': '+(walls||'no walls changed')+'; everything else was kept.'+(edited?' '+edited[0].toUpperCase()+edited.slice(1)+'.':'')+(lost?' Removed with them: '+lost+'.':'')+' Undo restores the previous walls.';
}
const api={identify,diffWalls,patchWalls,matchChimneys,motion,carry,roofTrim,rebuild,summary,STAGES};if(node)module.exports=api;else root.WallRoofRebuild=api;
})(typeof window==='undefined'?globalThis:window);
