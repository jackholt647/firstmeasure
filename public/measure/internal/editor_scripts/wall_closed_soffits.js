/* Editable roof-owned undersides; generated wall tops remain reversible. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports,G=node?require('./wall_geometry.js'):root.WallGeometry,K=node?require('./exterior_geometry.js'):root.ExteriorGeometry,M=()=>node?require('./exterior_model.js'):root.ExteriorModel;
const EPS=.002,COLOR='#a9c9bd',copy=v=>JSON.parse(JSON.stringify(v));
function build(state,walls,trim=[]){
 const faces=[];
 for(const w of walls){
  if(w.chimney||!w.top||w.top.length!==2)continue;
  const s=(state.sources||[]).find(s=>s.kind==='perimeter'&&!s.referenceOnly&&['eave','rake'].includes(s.type)&&s.setback>EPS&&s.originalA&&s.originalB&&w.top.every(p=>G.onEdge(p,s.a,s.b,.01)));
  if(!s)continue;
  const a=s.originalA,b=s.originalB,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<EPS*EPS)continue;
  const outer=w.top.map(p=>{const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;return {x:a.x+dx*t,y:a.y+dy*t,z:a.z+(b.z-a.z)*t};});
  const fascia=trim.find(f=>outer.every(p=>G.onEdge(p,f.a,f.b,.02))),drop=fascia?.height||0;
  outer.forEach(p=>p.z-=drop);
  const inner=w.top.map((p,i)=>({...p,z:outer[i].z}));
  if(inner.some((p,i)=>p.z>w.top[i].z+EPS||p.z<=w.bottom[i].z+EPS))continue;
  const f={id:'closed-soffit:'+w.id,closedSoffit:{wallId:w.id,sourceId:s.id},roofLayer:true,material:'soffit',finishColor:COLOR,points:[inner[0],inner[1],outer[1],outer[0]],holes:[]};
  if(K.area(f)>EPS*EPS)faces.push(f);
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
function active(state){const edits=state?.wallEdits;if(!edits||!((edits.$surfaces||[]).some(f=>f.closedSoffit)||Object.values(edits.$drafts||{}).some(d=>d.closedSoffit)))return [];return M().collect(state).filter(f=>f.closedSoffit&&!f.deleted&&!f.drafted);}
function apply(walls,state){
 const panels=active(state);if(!panels.length)return walls;
 return walls.flatMap(w=>{
  const matches=panels.filter(f=>f.closedSoffit.wallId===w.id);if(!matches.length)return [w];
  const a=w.top[0],b=w.top[1],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<EPS*EPS)return [w];
  const at=(pair,t)=>({x:pair[0].x+(pair[1].x-pair[0].x)*t,y:pair[0].y+(pair[1].y-pair[0].y)*t,z:pair[0].z+(pair[1].z-pair[0].z)*t});
  const cuts=[0,1];for(const f of matches)for(const r of [f.points,...(f.holes||[])])for(const p of r){const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;if(t>1e-7&&t<1-1e-7)cuts.push(t);}
  const ts=[...new Set(cuts.map(t=>Math.round(t*1e8)/1e8))].sort((a,b)=>a-b),parts=[];
  for(let i=1;i<ts.length;i++){
   const lo=ts[i-1],hi=ts[i],mid=at(w.top,(lo+hi)/2),f=matches.find(f=>G.contains(f,mid)),plane=f&&G.plane(f.points),top=[at(w.top,lo),at(w.top,hi)],bottom=[at(w.bottom,lo),at(w.bottom,hi)];
   if(plane)top.forEach((p,j)=>p.z=Math.max(bottom[j].z,Math.min(p.z,plane.dx*p.x+plane.dy*p.y+plane.k)));
   const previous=parts.at(-1),length=pair=>Math.hypot(pair[1].x-pair[0].x,pair[1].y-pair[0].y),slope=pair=>(pair[1].z-pair[0].z)/length(pair);
   if(previous&&Math.abs(previous.top[1].z-top[0].z)<1e-6&&Math.abs(slope(previous.top)-slope(top))<1e-6){previous.top[1]=top[1];previous.bottom[1]=bottom[1];}
   else parts.push({...w,top,bottom});
  }
  return parts.map((p,i)=>({...p,id:parts.length===1?w.id:w.id+':soffit-'+i}));
 });
}
const api={build,apply,active,COLOR};if(node)module.exports=api;else root.WallClosedSoffits=api;
})(typeof window==='undefined'?globalThis:window);
