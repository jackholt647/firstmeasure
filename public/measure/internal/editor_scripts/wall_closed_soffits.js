/* Editable roof-owned undersides; generated wall tops remain reversible. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports,G=node?require('./wall_geometry.js'):root.WallGeometry,K=node?require('./exterior_geometry.js'):root.ExteriorGeometry,M=()=>node?require('./exterior_model.js'):root.ExteriorModel;
const EPS=.002,COLOR='#a9c9bd',copy=v=>JSON.parse(JSON.stringify(v));
function build(state,walls){
 const faces=[],tops=new Map();
 for(const w of walls){
  if(w.chimney||!w.top||w.top.length!==2)continue;
  const s=(state.sources||[]).find(s=>s.kind==='perimeter'&&!s.referenceOnly&&['eave','rake'].includes(s.type)&&s.setback>EPS&&s.originalA&&s.originalB&&w.top.every(p=>G.onEdge(p,s.a,s.b,.01)));
  if(!s)continue;
  const a=s.originalA,b=s.originalB,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<EPS*EPS)continue;
  const outer=w.top.map(p=>{const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;return {x:a.x+dx*t,y:a.y+dy*t,z:a.z+(b.z-a.z)*t};});
  const inner=w.top.map((p,i)=>({...p,z:outer[i].z}));
  if(inner.some((p,i)=>p.z>w.top[i].z+EPS||p.z<=w.bottom[i].z+EPS))continue;
  const f={id:'closed-soffit:'+w.id,closedSoffit:{wallId:w.id,sourceId:s.id,roofId:s.parentId},roofLayer:true,material:'soffit',finishColor:COLOR,points:[inner[0],inner[1],outer[1],outer[0]],holes:[]};
  if(K.area(f)>EPS*EPS){faces.push(f);tops.set(f,w.top);}
 }
 // Strips of one wall run meet at survey stations that the wall outline does
 // not show (the shared clean-up in G.topology removed them). Their panels
 // join there too, so the soffit has no points where the wall has none.
 if(faces.length>1){
  // Strips can meet a fraction of a millimetre apart (the outline welds them),
  // and one straight eave can be split into collinear sources of one roof.
  const kept=G.topology(walls).points,station=p=>!kept.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<.0011&&Math.abs(q.z-p.z)<.0011),same=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<=.001;
  const line=f=>(state.sources||[]).find(s=>s.id===f.closedSoffit.sourceId),onLine=(p,s)=>{const a=s.originalA,b=s.originalB,dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz,t=((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy,p.z-a.z-t*dz)<=.001;};
  const sameEave=(a,b)=>b.closedSoffit.sourceId===a.closedSoffit.sourceId||b.closedSoffit.roofId===a.closedSoffit.roofId&&[b.points[2],b.points[3]].every(p=>onLine(p,line(a)));
  for(let merged=true;merged;){merged=false;
   for(const a of faces){const b=faces.find(b=>b!==a&&sameEave(a,b)&&same(a.points[1],b.points[0])&&same(tops.get(a)[1],tops.get(b)[0]));
    if(!b||!station(tops.get(a)[1]))continue;
    const points=[a.points[0],b.points[1],b.points[2],a.points[3]],chord=(p,s,e)=>{const dx=e.x-s.x,dy=e.y-s.y,dz=e.z-s.z,l2=dx*dx+dy*dy+dz*dz,t=l2?((p.x-s.x)*dx+(p.y-s.y)*dy+(p.z-s.z)*dz)/l2:0;return Math.hypot(p.x-s.x-t*dx,p.y-s.y-t*dy,p.z-s.z-t*dz);};
    if(chord(a.points[1],points[0],points[1])>.05||chord(a.points[2],points[3],points[2])>.05)continue;
    a.points=points;a.closedSoffit.wallIds=[...(a.closedSoffit.wallIds||[a.closedSoffit.wallId]),...(b.closedSoffit.wallIds||[b.closedSoffit.wallId])];tops.set(a,[tops.get(a)[0],tops.get(b)[1]]);
    faces.splice(faces.indexOf(b),1);merged=true;break;
   }
  }
 }
 // Runs sharing an inset wall corner share the outer roof corner too. This
 // closes the triangular gaps left by independent perpendicular projections.
 for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++){
  const a=faces[i],b=faces[j];
  for(let ai=0;ai<2;ai++)for(let bi=0;bi<2;bi++){
   const p=a.points[ai],q=b.points[bi];if(Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)>EPS)continue;
   const x=a.points[3],y=a.points[2],u=b.points[3],v=b.points[2],dx=y.x-x.x,dy=y.y-x.y,ex=v.x-u.x,ey=v.y-u.y,den=dx*ey-dy*ex;if(Math.abs(den)<1e-8)continue;
   const t=((u.x-x.x)*ey-(u.y-x.y)*ex)/den,r=((u.x-x.x)*dy-(u.y-x.y)*dx)/den,z=x.z+(y.z-x.z)*t;
   if(Math.abs(z-(u.z+(v.z-u.z)*r))>EPS)continue;
   const join={x:x.x+dx*t,y:x.y+dy*t,z};a.points[3-ai]={...join};b.points[3-bi]={...join};
  }
 }
 return faces;
}
let snapshot=null;
function withSnapshot(state,run){const previous=snapshot,panels=active(state);snapshot={state,panels};try{return run();}finally{snapshot=previous;}}
function active(state){if(snapshot?.state===state)return snapshot.panels;if(state?.closedSoffits===false)return [];const edits=state?.wallEdits;if(!edits||!((edits.$surfaces||[]).some(f=>f.closedSoffit)||Object.values(edits.$drafts||{}).some(d=>d.closedSoffit)))return [];return M().collect(state).filter(f=>f.closedSoffit&&!f.deleted&&!f.drafted);}
// Construction classification is a presentation/takeoff operation only.
// Editing and dimensions always retain the original full-height wall.
function presentation(face,state,panels=active(state)){
 if(face.closedSoffit)return state?.closedSoffits===false?[]:[face];
 if(face.roofLayer||face.curvedSurface||!panels.length)return [face];
 const frame=K.frame(face);if(!frame||Math.abs(frame.n.z)>.05)return [face];
 const n=frame.n,len=Math.hypot(n.x,n.y),u={x:-n.y/len,y:n.x/len},origin=face.points[0],local=p=>({x:(p.x-origin.x)*u.x+(p.y-origin.y)*u.y,y:p.z,z:0}),world=p=>({x:origin.x+u.x*p.x,y:origin.y+u.y*p.x,z:p.y});
 const polygon={points:face.points.map(local),holes:(face.holes||[]).map(r=>r.map(local))},xs=polygon.points.map(p=>p.x),lo=Math.min(...xs),hi=Math.max(...xs),top=Math.max(...face.points.map(p=>p.z))+1,masks=[];
 const at=t=>({x:origin.x+u.x*(lo+(hi-lo)*t),y:origin.y+u.y*(lo+(hi-lo)*t)}),a=at(0),b=at(1);
 for(const panel of panels){
  const plane=G.plane(panel.points);if(!plane)continue;
  const source=state.sources?.find(s=>s.id===panel.closedSoffit.sourceId),roof=state.roof?.faces?.find(f=>f.id===(panel.closedSoffit.roofId??source?.parentId)),upper=source?.sourcePlane||(roof&&G.plane(roof.points));
  const ts=G.splitParameters(a,b,[panel]);
  for(let i=1;i<ts.length;i++){const l=ts[i-1],r=ts[i];if(r-l<1e-8||!G.contains(panel,at((l+r)/2)))continue;
   const ps=[at(l),at(r)],bottom=ps.map(p=>plane.dx*p.x+plane.dy*p.y+plane.k),ceiling=ps.map(p=>upper?upper.dx*p.x+upper.dy*p.y+upper.k:top),x=[lo+(hi-lo)*l,lo+(hi-lo)*r];
   if(ceiling.every((z,j)=>z<=bottom[j]+1e-6))continue;
   masks.push({points:[{x:x[0],y:bottom[0]},{x:x[1],y:bottom[1]},{x:x[1],y:Math.max(bottom[1],ceiling[1])},{x:x[0],y:Math.max(bottom[0],ceiling[0])}]});
  }
 }
 if(!masks.length)return [face];
 const enclosed=K.intersection([polygon],masks);if(!enclosed.length)return [face];
 const map=(p,constructionOnly)=>({...face,constructionOnly,points:p.points.map(world),holes:p.holes.map(r=>r.map(world))});
 return [...K.difference(polygon,masks).map(p=>map(p,false)),...enclosed.map(p=>map(p,true))];
}
const apply=walls=>walls;
const api={build,apply,active,presentation,withSnapshot,COLOR};if(node)module.exports=api;else root.WallClosedSoffits=api;
})(typeof window==='undefined'?globalThis:window);
