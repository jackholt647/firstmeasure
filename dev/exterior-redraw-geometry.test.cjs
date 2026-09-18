const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
// Frozen pre-optimization overlap test: independent oracle for tolerance behavior.
function reference(a,b,faces){const sub=(p,q)=>({x:p.x-q.x,y:p.y-q.y,z:p.z-q.z}),dot=(p,q)=>p.x*q.x+p.y*q.y+p.z*q.z,mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),u=sub(b,a),l2=dot(u,u);if(l2<1e-12)return [];const intervals=[];
 for(const face of faces.filter(f=>!f.deleted))for(const ring of [face.points,...(face.holes||[])])for(let i=0;i<ring.length;i++){const c=ring[i],d=ring[(i+1)%ring.length],ts=[c,d].map(p=>dot(sub(p,a),u)/l2);if([c,d].some((p,j)=>Math.hypot(...Object.values(sub(p,mix(a,b,ts[j]))))>1e-5))continue;ts.sort((x,y)=>x-y);const lo=Math.max(0,ts[0]),hi=Math.min(1,ts[1]);if(hi-lo>1e-7)intervals.push([lo,hi]);}
 intervals.sort((a,b)=>a[0]-b[0]);const merged=[];for(const pair of intervals){const last=merged.at(-1);if(last&&pair[0]<=last[1]+1e-7)last[1]=Math.max(last[1],pair[1]);else merged.push(pair);}return merged;}
test('overlap broad phase preserves reversed, partial, near-collinear, hole and deleted-edge contacts',()=>{
 let seed=93;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 for(let n=0;n<800;n++){
 const a={x:random()*1000,y:random()*1000,z:random()*100},b={x:a.x+random()*12,y:a.y+random()*12,z:a.z+random()*12},at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
 const faces=Array.from({length:15},(_,i)=>{const p=at(random()*3-1),q=at(random()*3-1);if(i%3===0)p.x+=i%2?1.01e-5:.99e-5;if(i%4===0){p.y+=100;q.y+=100;}return {points:i%2?[q,p]:[p,q],deleted:i%7===0,holes:i%5===0?[[at(.2),at(.4)]]:[]};});
 assert.deepEqual(W.sharedIntervals(a,b,faces),reference(a,b,faces));assert.deepEqual(W.sharedIntervals(b,a,faces),reference(b,a,faces));
 }
 const p=(x,y=0,z=0)=>({x,y,z});for(const offset of [0,0.999e-5,1e-5,1.001e-5]){const faces=[{points:[p(-1,offset),p(3,offset)]}];assert.deepEqual(W.sharedIntervals(p(0),p(2),faces),reference(p(0),p(2),faces));}assert.deepEqual(W.sharedIntervals(p(0),p(0),[]),[]);
});
test('structural index agrees with the original classifier on rotated and distant faces',()=>{
 const faces=Array.from({length:50},(_,i)=>{const x=i*7,z=i%3,points=[{x,y:i,z},{x:x+4,y:i+2,z},{x:x+4,y:i+2,z:z+3},{x,y:i,z:z+3}];return {points,deleted:i===7,drafted:i===9};}),index=W.structuralIndex(faces),live=faces.filter(f=>!f.deleted&&!f.drafted);
 for(const f of faces)for(let i=0;i<4;i++){const a=f.points[i],b=f.points[(i+1)%4];for(const off of [0,.000001,.001,100]){const p={...a,z:a.z+off},q={...b,z:b.z+off};assert.equal(index.edge(p,q),reference(p,q,live).length>0);assert.equal(index.edge(q,p),reference(q,p,live).length>0);}}
});
test('chimney redraw snapshots match uncached visibility and expire after edits and exceptions',()=>{
 const state={chimneys:{items:[{id:'c',points:[{x:1,y:-1},{x:3,y:-1},{x:3,y:1},{x:1,y:1}]}]},wallEdits:{}},a={x:0,y:0,z:0},b={x:4,y:0,z:0};
 const before=C.visibleSegments(a,b,state);let cached;
 C.withVisibilitySnapshot(state,()=>{cached=C.visibleSegments(a,b,state);C.withVisibilitySnapshot(state,()=>assert.deepEqual(C.visibleSegments(a,b,state),before));});assert.deepEqual(cached,before);
 state.chimneys.items[0].points.forEach(p=>p.x+=20);assert.notDeepEqual(C.visibleSegments(a,b,state),before);assert.deepEqual(C.withVisibilitySnapshot(state,()=>C.visibleSegments(a,b,state)),C.visibleSegments(a,b,state));
 assert.throws(()=>C.withVisibilitySnapshot(state,()=>{C.visibleSegments(a,b,state);throw Error('cancel');}),/cancel/);state.chimneys.items[0].points.forEach(p=>p.x-=20);assert.deepEqual(C.withVisibilitySnapshot(state,()=>C.visibleSegments(a,b,state)),before);
});
