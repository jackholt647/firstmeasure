/* Roof-owned fascia. Dimensions are vertical metres; roof faces are never edited. */
(function(root){'use strict';
const common=typeof module!=='undefined'&&module.exports,K=common?require('./exterior_geometry.js'):root.ExteriorGeometry;
const INCH=.0254,DEFAULT=0,key=(a,b)=>[K.pointKey(a),K.pointKey(b)].sort().join('|');
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,unit=a=>{const l=Math.hypot(a.x,a.y,a.z);return {x:a.x/l,y:a.y/l,z:a.z/l};};
function perimeter(roof){
 const seen=new Set(),faces=(roof?.faces||[]).filter(f=>f.points?.length>=3).filter(f=>{const signature=[f.points,...(f.holes||[])].map(r=>r.map(K.pointKey).sort().join('|')).sort().join(';');if(seen.has(signature))return false;seen.add(signature);return true;}).map((f,i)=>({...f,id:i}));
 const graph=K.topology(faces),boundary=[...graph.edges.values()].filter(e=>e.faces.size===1).map(e=>({a:graph.vertices[e.a].point,b:graph.vertices[e.b].point})).filter(e=>Math.hypot(e.b.x-e.a.x,e.b.y-e.a.y)>K.CONTACT);
 // Only classified eave/rake portions of the perimeter carry fascia. Split
 // at classification endpoints even when the roof polygon has no vertex there.
 const allowed=(roof?.connections||[]).filter(c=>['eave','rake'].includes(c.type)).map(c=>({a:roof.points?.[c.startIdx],b:roof.points?.[c.endIdx],type:c.type})).filter(e=>e.a&&e.b);
 const portions=new Map();
 for(const edge of boundary){const axis=unit(sub(edge.b,edge.a)),length=Math.hypot(...Object.values(sub(edge.b,edge.a)));
  for(const c of allowed){const project=p=>dot(sub(p,edge.a),axis),on=p=>{const v=sub(p,edge.a),t=project(p);return Math.hypot(v.x-axis.x*t,v.y-axis.y*t,v.z-axis.z*t)<=K.CONTACT;};if(!on(c.a)||!on(c.b))continue;
   const lo=Math.max(0,Math.min(project(c.a),project(c.b))),hi=Math.min(length,Math.max(project(c.a),project(c.b)));if(hi-lo<=K.CONTACT)continue;
   const point=t=>({x:edge.a.x+axis.x*t,y:edge.a.y+axis.y*t,z:edge.a.z+axis.z*t}),a=point(lo),b=point(hi);portions.set(key(a,b),{a,b,type:c.type});
  }
 }
 const edges=[...portions.values()];
 // Collinear graph anchors do not turn a continuous fascia into multiple panels.
 let changed=true;while(changed){changed=false;outer:for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){
  const a=edges[i],b=edges[j];if(a.type!==b.type)continue;for(const [p,q]of [[a.a,a.b],[a.b,a.a]]){const r=K.pointKey(p)===K.pointKey(b.a)?b.b:K.pointKey(p)===K.pointKey(b.b)?b.a:null;if(!r)continue;const u=unit(sub(q,p)),v=unit(sub(r,p));if(dot(u,v)>-1+1e-9)continue;edges[i]={a:q,b:r,type:a.type};edges.splice(j,1);changed=true;break outer;}
 }}
 return edges.map(e=>({...e,id:key(e.a,e.b)})).sort((a,b)=>a.id.localeCompare(b.id));
}
function panels(roof,settings={}){return perimeter(roof).map(edge=>{
 const saved=settings.edges?.[edge.id],height=Number.isFinite(saved?.height)?Math.max(0,saved.height):DEFAULT,a=edge.a,b=edge.b,u=unit(sub(b,a)),down={x:0,y:0,z:-1},along=dot(down,u),v=unit({x:down.x-u.x*along,y:down.y-u.y*along,z:down.z-u.z*along});
 return {...edge,height,deleted:height<=K.CONTACT,material:'trim-horizontal',finishColor:saved?.finishColor||null,textureAxes:{u,v},points:[a,b,{...b,z:b.z-height},{...a,z:a.z-height}],holes:[]};
});}
function setHeight(settings,ids,inches){if(!Number.isFinite(inches)||inches<0)throw Error('Enter a roof trim height of zero inches or more.');const next={...JSON.parse(JSON.stringify(settings||{}))};next.edges={...(next.edges||{})};for(const id of ids)next.edges[id]={...(next.edges[id]||{}),height:inches*INCH};return next;}
const api={INCH,DEFAULT,perimeter,panels,setHeight};if(common)module.exports=api;else root.RoofTrim=api;
})(typeof window!=='undefined'?window:globalThis);
