/* Exterior feature catalog and face-local geometry. Sizes are in feet; geometry is metres. */

(function(root){

'use strict';

const W=typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):root.WallSolidGeometry;

const FT=.3048,defs=new Map(),register=def=>{if(!def.id||!def.sizes?.length)throw Error('Feature needs an id and sizes.');defs.set(def.id,Object.freeze(def));};

register({id:'window',name:'Window',key:'w',color:'#55c7f3',icon:'▦',sizes:[[3,4],[3,5],[4,4],[4,5],[4,6],[6,4],[2,3]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'door',name:'Door',key:'d',color:'#efaa65',icon:'▯',floor:true,sizes:[[3,6+8/12],[2+8/12,6+8/12],[3,7],[3,8],[6,6+8/12]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'garage',name:'Garage door',key:'g',defaultPreset:2,color:'#b89aea',icon:'▤',floor:true,sizes:[[16,7],[9,7],[8,7],[16,8],[18,7],[18,8],[10,8]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'vent',name:'Gable vent',color:'#75d5a0',icon:'◉',sizes:[{w:1.5,h:2,shape:'rectangle'},{w:2,h:2,shape:'rectangle'},{w:2,h:2,shape:'circle'}]});

// Append new presets rather than reorder: saved faces reference catalog indices.
for(const [id,widths,heights]of [['window',[1,2,3,4,5,6],[1,2,3,4,5,6]],['door',[2,2.5,3,4,5,6],[7,8]],['garage',[8,9,10,12,14,16,18,20],[7,8,9,10]],['vent',[1,2,3],[1,2,3]]]){
 const sizes=defs.get(id).sizes;for(const h of heights)for(const w of widths)if(!sizes.some(s=>s.w===w&&s.h===h&&s.shape==='rectangle'))sizes.push({w,h,shape:'rectangle'});
}

// Presentation is curated independently of the stable, saved preset indices.
const sizeGroups=new Map();
const doorGroup=(label,dimensions)=>({label,indices:dimensions.map(([w,h])=>{const sizes=defs.get('door').sizes;let index=sizes.findIndex(s=>Math.abs(s.w-w)<1e-8&&Math.abs(s.h-h)<1e-8&&s.shape==='rectangle');if(index<0){index=sizes.length;sizes.push({w,h,shape:'rectangle'});}return index;})});
sizeGroups.set('door',[
 doorGroup('Single doors · 6′8″ high',[28,30,32,34,36].map(w=>[w/12,80/12])),
 doorGroup('Double doors · 6′8″ high',[60,64,72].map(w=>[w/12,80/12])),
 doorGroup('Wider doors · 6′8″ high',[42,44].map(w=>[w/12,80/12])),
 doorGroup('Taller doors',[[3,7],[3,8]])
]);
sizeGroups.set('vent',[{label:'Gable vents',indices:[0,1,2]}]);
const pickerGroups=id=>sizeGroups.get(id)||null;
const nextPreset=(id,current=-1)=>{const indices=pickerIndices(id).slice().sort((a,b)=>a-b);return indices[(indices.indexOf(current)+1)%indices.length];};
const pickerIndices=id=>pickerGroups(id)?.flatMap(g=>g.indices)||defs.get(id)?.sizes.map((_,i)=>i)||[];

const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});

function frame(points){const n=W.normal(points);if(!n)throw Error('Select a planar face.');let v={x:-n.z*n.x,y:-n.z*n.y,z:1-n.z*n.z},l=Math.hypot(v.x,v.y,v.z);if(l<1e-6){v={x:0,y:1,z:0};l=1;}v={x:v.x/l,y:v.y/l,z:v.z/l};return {origin:points[0],u:cross(v,n),v,n};}

// Orient face-local movement from the current screen projection, independent of winding.

// Keep horizontal wall motion level and vertical motion upright; only the viewed side changes.

function viewFrame(points,screen){const f=frame(points);if(!screen)return f;const center=points.reduce((s,p)=>({x:s.x+p.x/points.length,y:s.y+p.y/points.length,z:s.z+p.z/points.length}),{x:0,y:0,z:0}),project=v=>{const a=screen({x:center.x-v.x*.01,y:center.y-v.y*.01,z:center.z-v.z*.01}),b=screen({x:center.x+v.x*.01,y:center.y+v.y*.01,z:center.z+v.z*.01});return {x:b.x-a.x,y:b.y-a.y};},u=project(f.u),v=project(f.v),flip=(axis,sign)=>({x:axis.x*sign,y:axis.y*sign,z:axis.z*sign});

 if(![u.x,u.y,v.x,v.y].every(Number.isFinite))throw Error('Turn the camera toward the face before nudging.');

 return {...f,u:flip(f.u,u.x<0?-1:1),v:flip(f.v,v.y>0?-1:1)};

}

function orientedFrame(points,axis){const f=frame(points);let u=axis;if(!u){const edges=points.map((p,i)=>sub(points[(i+1)%points.length],p)).filter(v=>Math.hypot(v.x,v.y,v.z)>1e-6);edges.sort((a,b)=>Math.abs(dot(b,f.u))/Math.hypot(b.x,b.y,b.z)-Math.abs(dot(a,f.u))/Math.hypot(a.x,a.y,a.z));u=edges[0];}if(!u)return f;const off=dot(u,f.n);u={x:u.x-off*f.n.x,y:u.y-off*f.n.y,z:u.z-off*f.n.z};const l=Math.hypot(u.x,u.y,u.z);if(l<1e-6)return f;u={x:u.x/l,y:u.y/l,z:u.z/l};if(dot(u,f.u)<-1e-6)u={x:-u.x,y:-u.y,z:-u.z};return {...f,u,v:cross(f.n,u)};}

function bounds(points){return {left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),bottom:Math.min(...points.map(p=>p.y)),top:Math.max(...points.map(p=>p.y))};}

function dimensions(points,feature){const f=feature?.axis?orientedFrame(points,feature.axis):frame(points),b=bounds(points.map(p=>W.inFrame(f,p)));return {width:(b.right-b.left)/FT,height:(b.top-b.bottom)/FT,frame:f,bounds:b};}

const format=n=>String(Math.round(n*100)/100),label=(points,feature)=>{const d=dimensions(points,feature);return format(d.width)+' × '+format(d.height)+' ft';};

function shape(box,kind='rectangle'){const {left:l,right:r,bottom:b,top:t}=box;if(kind==='circle')return Array.from({length:48},(_,i)=>{const a=i*Math.PI/24;return {x:(l+r)/2+(r-l)/2*Math.cos(a),y:(b+t)/2+(t-b)/2*Math.sin(a),z:0};});return [{x:l,y:b,z:0},{x:r,y:b,z:0},{x:r,y:t,z:0},{x:l,y:t,z:0}];}

function anchors(points,boundaries,tolerance=1e-4){const b=bounds(points),out={};for(const [key,value]of Object.entries(b)){const axis=key==='left'||key==='right'?'x':'y',other=axis==='x'?'y':'x',lo=axis==='x'?b.bottom:b.left,hi=axis==='x'?b.top:b.right;for(const r of boundaries)for(let i=0;i<r.length;i++){const a=r[i],c=r[(i+1)%r.length];if(Math.abs(a[axis]-value)<tolerance&&Math.abs(c[axis]-value)<tolerance&&Math.min(hi,Math.max(a[other],c[other]))-Math.max(lo,Math.min(a[other],c[other]))>1e-5)out[key]=true;}}return out;}

function resized(points,preset,anchor={}){const b=bounds(points),w=preset.w*FT,h=preset.h*FT,cx=(b.left+b.right)/2,cy=(b.bottom+b.top)/2;let left=anchor.left?b.left:anchor.right?b.right-w:cx-w/2,bottom=anchor.bottom?b.bottom:anchor.top?b.top-h:cy-h/2;

 // Two opposite anchors cannot both survive a size change: keep the lower/left one.

 return shape({left,right:left+w,bottom,top:bottom+h},preset.shape);}

function place(center,preset,boundaries,screen,radius=12,regions=boundaries.filter(r=>r.length>=3).map(points=>({points}))){return placeGroup([shape({left:center.x-preset.w*FT/2,right:center.x+preset.w*FT/2,bottom:center.y-preset.h*FT/2,top:center.y+preset.h*FT/2},preset.shape)],boundaries,screen,radius,regions)[0];}
function placeGroup(shapes,boundaries,screen,radius=12,regions=boundaries.filter(r=>r.length>=3).map(points=>({points}))){let points=shapes.flat(),b=bounds(points);const offsets={x:null,y:null},original=points[0];
 // Establish the unsnapped, contained position first. Rank snaps by the
 // translation from this position, never by target-to-cursor distance.
 const initialFit=W.boundedTranslation(points,regions,{x:0,y:0},{axis:'y'})||W.boundedTranslation(points,regions,{x:0,y:0});
 if(!initialFit)throw Error('That size does not fit inside the supporting face.');
 points=points.map(p=>({...p,x:p.x+initialFit.x,y:p.y+initialFit.y}));b=bounds(points);const snapBounds=[b,...(shapes.length>1?shapes.map(r=>bounds(r.map(p=>({...p,x:p.x+initialFit.x,y:p.y+initialFit.y})))):[])];

 for(const ring of boundaries)for(let i=0;i<ring.length;i++){const a=ring[i],c=ring[(i+1)%ring.length];for(const axis of ['x','y']){if(a.alignmentAxes&&!a.alignmentAxes.includes(axis))continue;if(Math.abs(a[axis]-c[axis])>1e-5)continue;for(const value of snapBounds.flatMap(b=>a.alignmentCenter?[axis==='x'?(b.left+b.right)/2:(b.bottom+b.top)/2]:axis==='x'?[b.left,b.right]:[b.bottom,b.top])){const from={x:(b.left+b.right)/2,y:(b.bottom+b.top)/2,z:0};from[axis]=value;const to={...from,[axis]:a[axis]},p=screen(from),q=screen(to),distance=Math.hypot(q.x-p.x,q.y-p.y);const delta=a[axis]-value,travel=Math.abs(delta),previous=offsets[axis];if(Number.isFinite(distance)&&distance<=radius&&(!previous||travel<previous.travel-1e-9||Math.abs(travel-previous.travel)<1e-9&&distance<previous.distance))offsets[axis]={distance,travel,delta};}}}

 points=points.map(p=>({...p,x:p.x+(offsets.x?.delta||0),y:p.y+(offsets.y?.delta||0)}));
 // Snapping is a proximity preference; fitting is a containment constraint.
 // Keep the pointer's horizontal position when a vertical adjustment can fit.
 const fit=W.boundedTranslation(points,regions,{x:0,y:0},{axis:'y'})||W.boundedTranslation(points,regions,{x:0,y:0});
 if(!fit)throw Error('That size does not fit inside the supporting face.');
 const delta={x:points[0].x+fit.x-original.x,y:points[0].y+fit.y-original.y};return shapes.map(r=>r.map(p=>({...p,x:p.x+delta.x,y:p.y+delta.y})));}

function containsShape(points,outlines){const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);return W.subtract({points},outlines.map(points=>({points}))).reduce((s,p)=>s+area(p),0)<1e-7;}

function validate(points,outlines,others=[]){if(points.length<3||!points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)))throw Error('Feature geometry is invalid.');const b=bounds(points);if(b.right-b.left<.01||b.top-b.bottom<.01)throw Error('Keep the shape at least 0.4 inches wide and high.');if(!containsShape(points,outlines))throw Error('That size or position extends beyond the supporting face.');const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);for(const f of others)if(area(points)-W.subtract({points},[{points:f.points}]).reduce((s,r)=>s+area(r),0)>1e-7)throw Error('That position overlaps another feature.');}

// Trim is derived from the opening, so edits and copies cannot leave orphan strips.
const trimSizes=[0,2,3,4,6];
function setTrim(feature,inches,color='#f5f3ef'){
 if(!['window','door'].includes(feature?.type))return feature;
 if(!Number.isFinite(inches)||inches<0)throw Error('Enter a nonnegative trim width.');
 const next={...feature};if(inches===0)delete next.trim;else next.trim={width:inches*.0254,color};return next;
}
function trimFaces(points,feature){
 const width=feature?.trim?.width;if(!(width>0)||!['window','door'].includes(feature.type))return [];
 const fr=orientedFrame(points,feature.axis),ps=points.map(p=>W.inFrame(fr,p)),b=bounds(ps),area=ps.reduce((sum,p,i)=>{const q=ps[(i+1)%ps.length];return sum+p.x*q.y-q.x*p.y;},0),sign=area>=0?1:-1;
 const edges=ps.map((p,i)=>{const q=ps[(i+1)%ps.length],dx=q.x-p.x,dy=q.y-p.y,l=Math.hypot(dx,dy),bottom=feature.type==='door'&&Math.abs(p.y-b.bottom)<1e-5&&Math.abs(q.y-b.bottom)<1e-5;return {x:sign*dy/(l||1),y:-sign*dx/(l||1),width:bottom?0:width};});
 const outer=ps.map((p,i)=>{const a=edges[(i+ps.length-1)%ps.length],b=edges[i],det=a.x*b.y-a.y*b.x;if(Math.abs(det)<1e-8)return {...p,x:p.x+b.x*b.width,y:p.y+b.y*b.width};return {...p,x:p.x+(a.width*b.y-a.y*b.width)/det,y:p.y+(a.x*b.width-a.width*b.x)/det};});
 return ps.flatMap((p,i)=>{if(!edges[i].width)return [];const j=(i+1)%ps.length;return [{points:[p,ps[j],outer[j],outer[i]].map(p=>W.fromFrame(fr,p)),trim:true,finishColor:feature.trim.color||'#f5f3ef',material:Math.abs(ps[j].y-p.y)>Math.abs(ps[j].x-p.x)?'trim-vertical':'trim-horizontal'}];});
}
// Divided stickers use real faces with a shared identity. Geometry, rather than
// a saved list of cuts, defines the current sections and their internal seams.
const kernel=()=>typeof module!=='undefined'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
let identitySequence=0;
const divisionId=()=> 'sticker-'+(root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+(++identitySequence)+'-'+Math.random().toString(36).slice(2));
const clone=value=>JSON.parse(JSON.stringify(value));
function divisionMembers(faces,seed){
 const id=seed.feature?.divisionGroup;if(!id)return [seed];
 const fr=W.faceFrame(seed);return faces.filter(f=>!f.deleted&&!f.drafted&&!f.solidId&&f.feature?.divisionGroup===id&&f.feature.type===seed.feature.type&&f.points.every(p=>Math.abs(W.inFrame(fr,p).z)<1e-5));
}
function divisionLayout(faces,fr){
 if(!faces.length||faces.some(f=>!f.feature||f.curvedSurface?.logical))throw Error('Select a planar window or door section.');
 fr ||= orientedFrame(faces[0].points,faces[0].feature.axis);
 const regions=faces.map(f=>({points:f.points.map(p=>W.inFrame(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(fr,p)))}));
 const box=bounds(regions.flatMap(f=>f.points));return {frame:fr,bounds:box,regions,width:box.right-box.left,height:box.top-box.bottom};
}
function divisionSegments(faces){
 const seams=new Map(),groups=new Map();for(const f of faces){const id=f.feature?.divisionGroup;if(id){if(!groups.has(id))groups.set(id,[]);groups.get(id).push(f);}}
 for(const members of groups.values())for(let i=0;i<members.length;i++){const a=members[i],peers=divisionMembers(members.slice(i+1),a);
  for(const b of peers)for(let j=0;j<a.points.length;j++){const p=a.points[j],q=a.points[(j+1)%a.points.length],at=t=>({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,z:p.z+(q.z-p.z)*t});
   for(const [lo,hi]of W.sharedIntervals(p,q,[b]))if(hi-lo>1e-6){const pair=[at(lo),at(hi)],key=W.edgeKey(...pair);seams.set(key,{pair,group:a.feature.divisionGroup,faces:[a.id,b.id]});}
  }
 }return [...seams.values()];
}
function divideSticker(faces,orientation,amount,{frame:fr,groupId,operationId}={}){
 const K=kernel(),layout=divisionLayout(faces,fr),b=layout.bounds,horizontal=orientation==='horizontal',size=horizontal?layout.height:layout.width;
 if(!Number.isFinite(amount)||amount<=1e-5||amount>=size-1e-5)throw Error('Place the divider inside the window or door.');
 const group=groupId||faces[0].feature.divisionGroup||divisionId(),op=operationId||divisionId(),axis=horizontal?'y':'x',value=horizontal?b.top-amount:b.left+amount;
 const low={...b},high={...b};low[horizontal?'top':'right']=value;high[horizontal?'bottom':'left']=value;
 let splits=0;const result=faces.flatMap((face,i)=>{
  const pieces=[low,high].flatMap(box=>K.intersection([layout.regions[i]],[{points:shape(box)}])).filter(r=>K.area(r)>1e-9);
  if(pieces.length>1)splits++;
  return pieces.map((r,j)=>{const out={...clone(face),id:j?op+'-'+i+'-'+j:face.id,points:r.points.map(p=>W.fromFrame(layout.frame,p)),holes:r.holes.map(r=>r.map(p=>W.fromFrame(layout.frame,p))),feature:{...clone(face.feature),preset:null,shape:'custom',divisionGroup:group,divisionSection:pieces.length>1?op+'-'+i+'-'+j:face.feature.divisionSection||op+'-'+i}};
   // The clipped polygon is authoritative; old triangulations and retained
   // interior anchors must not reintroduce an erased section boundary.
   delete out.curves;delete out.curvedSurface;delete out.retainedPoints;return out;
  });
 });
 if(!splits)throw Error('A divider already exists at that position.');
 const seams=divisionSegments(result).filter(s=>s.pair.every(p=>Math.abs(W.inFrame(layout.frame,p)[axis]-value)<1e-5));
 return {faces:result,seams,layout,amount,remaining:size-amount,orientation};
}
function mergeStickerDivider(faces,pair){
 const seam=divisionSegments(faces).find(s=>W.sharedIntervals(...pair,[{points:s.pair}]).reduce((sum,[lo,hi])=>sum+hi-lo,0)>.99999);
 if(!seam)return null;
 const members=faces.filter(f=>seam.faces.includes(f.id)),fr=W.faceFrame(members[0]),K=kernel(),regions=K.union(members.map(f=>({points:f.points.map(p=>W.inFrame(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(fr,p)))})));
 if(regions.length!==1)throw Error('Only adjacent sections of one sticker can be merged.');
 const r=regions[0],merged={...clone(members[0]),points:r.points.map(p=>W.fromFrame(fr,p)),holes:r.holes.map(r=>r.map(p=>W.fromFrame(fr,p))),feature:{...clone(members[0].feature),preset:null,shape:'custom',divisionSection:divisionId()}};
 delete merged.retainedPoints;return {removed:members.map(f=>f.id),face:merged};
}
function remapDivisionGroups(faces){const groups=new Map();return faces.map(f=>{const out=clone(f),old=f.feature?.divisionGroup;if(old){if(!groups.has(old))groups.set(old,divisionId());out.feature.divisionGroup=groups.get(old);out.feature.divisionSection=divisionId();}return out;});}
function groupedStickers(faces){
 const result=[],seen=new Set(),K=kernel();
 for(const face of faces){if(seen.has(face))continue;if(!face.feature?.divisionGroup){result.push(face);continue;}
  const members=divisionMembers(faces,face);members.forEach(f=>seen.add(f));const layout=divisionLayout(members),fr=layout.frame;
  for(const region of K.union(layout.regions)){const sections=members.filter((f,i)=>K.intersection([region],[layout.regions[i]]).some(r=>K.area(r)>1e-9));
   result.push({...face,points:region.points.map(p=>W.fromFrame(fr,p)),holes:region.holes.map(r=>r.map(p=>W.fromFrame(fr,p))),sections:sections.map(f=>({points:clone(f.points),holes:clone(f.holes||[])})),dividers:divisionSegments(sections).map(s=>s.pair)});
  }
 }return result;
}
const api={divisionId,divisionMembers,divisionLayout,divisionSegments,divideSticker,mergeStickerDivider,remapDivisionGroups,groupedStickers,trimSizes,setTrim,trimFaces,nextPreset,pickerGroups,pickerIndices,FT,defs,register,frame,viewFrame,orientedFrame,bounds,dimensions,label,anchors,resized,shape,place,placeGroup,validate,containsShape};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallFeatures=api;

})(typeof window!=='undefined'?window:globalThis);

(function(){if(typeof window==='undefined')return;const F=window.WallFeatures;

F.mountUI=function(command,selection,busy=()=>false,materials={}){
 if(typeof document==='undefined')return;
 const style=document.createElement('style');style.textContent=`
 body:not(.wall-mode-active) .exterior-sticker-bar,body:not(.wall-mode-active) #wall-material-toggle,body:not(.wall-mode-active) #wall-material-picker,body:not(.wall-mode-active) #wall-face-options{display:none!important}
 .exterior-sticker-bar{max-width:100%;background:transparent}
 .exterior-sticker-bar .ss-strip{min-width:0;overflow-x:auto}
 .exterior-sticker-bar [hidden],.exterior-sticker-menu[hidden]{display:none!important}
 .exterior-sticker-bar .ss-tile svg{color:var(--feature-color,#5f6368)}
 .exterior-sticker-bar .ss-tile.active{border-color:var(--feature-color,var(--primary));background:#f0f5fa}
 .exterior-sticker-menu{background:rgba(255,255,255,.95);padding:10px;border-radius:8px;box-shadow:0 2px 10px #0003;border:1px solid #ccc;color:#444;font:11px sans-serif;box-sizing:border-box}
 .exterior-selection{position:absolute;bottom:68px;right:12px;width:560px;max-width:calc(100% - 24px);max-height:var(--exterior-menu-height,320px);overflow:auto;z-index:10001;background:#fff}
 .exterior-sticker-menu h4{margin:0 0 10px;font-size:12px;border-bottom:1px solid #ccc;padding-bottom:5px;color:#333}
 .exterior-sticker-menu .exterior-option{display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px;font:11px sans-serif;margin-bottom:2px;border-radius:4px;background:#f8f9fa;border:1px solid #eee;width:100%;text-align:left;color:#444}
 .exterior-sticker-menu .exterior-option:hover{background:#e0e0e0}
 .exterior-sticker-menu .exterior-option[aria-pressed=true]{background:#e8f0fe;border-color:#1a73e8}
 .exterior-sticker-menu button:disabled{opacity:.45;cursor:default}
 .exterior-sticker-menu button:focus-visible,.exterior-sticker-bar button:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
 .exterior-swatch{width:12px;height:12px;border:1px solid #0002;border-radius:2px;flex-shrink:0;box-sizing:border-box}
 .exterior-selection p{margin:0 0 10px;line-height:1.4}
 .exterior-face-toggle{display:flex;align-items:center;gap:8px;flex-shrink:0;height:44px;padding:0 10px;border:1px solid #ccc;border-radius:5px;background:#fff;color:#444;font:600 11px sans-serif;cursor:pointer}
 .exterior-face-toggle:hover,.exterior-face-toggle[aria-expanded=true]{background:#e8f0fe;border-color:#1a73e8;color:#1a73e8}
 .exterior-face-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
 .exterior-face-heading h4{border:0;padding:0;margin:0}
 .exterior-face-heading button{border:0;background:transparent;font:18px sans-serif;color:#666;cursor:pointer}
 .exterior-face-table{width:100%;border-collapse:collapse;table-layout:fixed;font:11px sans-serif;text-align:left}
 .exterior-face-table th,.exterior-face-table td{border-bottom:1px solid #e1e5e8;padding:8px 6px;vertical-align:top}
 .exterior-face-table thead th{font-size:10px;color:#737b83;font-weight:600;padding-top:4px}
 .exterior-face-table th:first-child{width:92px}
 .exterior-face-table tbody th{font-weight:600;color:#444}
 .exterior-face-type{display:flex;align-items:center;gap:6px;padding-top:6px}
 .exterior-size-options{display:flex;flex-wrap:wrap;gap:4px}
 .exterior-size-options button{padding:5px 7px;border:1px solid #dce1e5;border-radius:4px;background:#fff;color:#444;cursor:pointer;font:11px sans-serif;white-space:nowrap;font-variant-numeric:tabular-nums}
 .exterior-size-options button:hover{background:#f1f5f9;border-color:#9cabb8}
 .exterior-size-options button[aria-pressed=true]{background:#e8f0fe;border-color:#1a73e8;color:#1a73e8}
 .exterior-size-options button:disabled{opacity:.55}

 #wall-placement-options{width:max-content;max-width:calc(100% - 24px)}#wall-placement-options[hidden]{display:none}
 #wall-placement-options .placement-current{margin:8px 0;color:#596579;font-size:11px}
 .placement-size-table{overflow:auto}.placement-matrix{border-collapse:separate;border-spacing:3px;font:11px sans-serif}.placement-matrix th{color:#596579;font-weight:600;text-align:center;padding:4px}.placement-matrix th:first-child{max-width:64px;font-size:10px}.placement-matrix td{text-align:center;color:#9aa3b0}
 .placement-matrix button{min-width:43px;padding:7px 5px;border:1px solid #dce1e5;border-radius:4px;background:#fff;color:#394150;font:11px sans-serif;cursor:pointer;white-space:nowrap}.placement-matrix button:hover{background:#f1f5f9;border-color:#9cabb8}.placement-matrix button[aria-pressed=true]{background:#e8f0fe;color:#1a73e8;border-color:#1a73e8;font-weight:600}
 .placement-other h5{margin:10px 0 6px;font-size:11px;color:#596579}.placement-other{max-width:480px}
 #wall-material-picker .exterior-material-options{display:grid;grid-template-columns:1fr 1fr;gap:4px}#wall-material-picker .exterior-option{width:100%;text-align:left}#wall-material-picker .exterior-finish-controls{margin-top:12px}#wall-material-picker .exterior-color-options{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}#wall-material-picker .exterior-palette-heading{font-size:10px;color:#596579;margin-top:9px}#wall-material-picker .exterior-color-swatch{width:30px;height:30px;flex:0 0 30px;padding:0;border:1px solid #929da8;border-radius:5px;cursor:pointer;box-shadow:inset 0 0 0 2px #ffffff70}#wall-material-picker .exterior-color-swatch:hover,#wall-material-picker .exterior-color-swatch:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}#wall-material-picker .exterior-color-reset{display:flex;align-items:center;justify-content:center;color:#394150;background:#f5f7f9;font-size:15px}#wall-material-picker .exterior-palette-empty{font-size:10px;color:#777;line-height:30px}#wall-material-picker input[type=color]{width:38px;height:27px;padding:2px;border:1px solid #aab3ba;border-radius:4px;margin-left:auto}#wall-material-picker{position:absolute;top:60px;left:10px;width:300px;max-width:calc(100% - 20px);max-height:calc(100% - 80px);overflow:auto;z-index:2600}
 #wall-material-picker .exterior-picker-heading{display:flex;align-items:baseline;justify-content:space-between}
 #wall-material-picker .exterior-default-finishes{padding:10px;background:#f5f7f9;border:1px solid #dce1e5;border-radius:6px;margin:8px 0 14px}#wall-material-picker .exterior-default-finishes h4{margin:0 0 10px}#wall-material-picker .default-texture-toggle{display:flex;align-items:center;gap:7px;margin:5px 0 8px}#wall-material-picker .default-texture-label{flex:1}#default-texture-menu{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px;padding:6px;background:white;border:1px solid #cbd3dc;border-radius:5px}#default-texture-menu[hidden]{display:none}
 #wall-material-picker .exterior-picker-heading button{border:0;background:none;color:#666;cursor:pointer;font-size:18px}
 #wall-material-picker p{font-size:10px;line-height:1.4;color:#666;margin:10px 0}
 #wall-material-picker label{display:flex;align-items:center;gap:6px;border-top:1px solid #ddd;padding-top:10px}
 `;document.head.appendChild(style);
 const parent=document.getElementById('three-view-wrapper');if(!parent)return;
 const sizeMenu=()=>parent.style.setProperty('--exterior-menu-height',Math.max(80,parent.clientHeight-80)+'px');sizeMenu();if(typeof ResizeObserver!=='undefined')new ResizeObserver(sizeMenu).observe(parent);
 const svg=path=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';
 const paths={window:'M4 3h16v18H4zM12 3v18M4 12h16',door:'M6 21V3h12v18M3 21h18M14 12h1',garage:'M3 21V5h18v16M6 21V8h12v13M6 12h12M6 16h12',vent:'M4 20V9l8-6 8 6v11zM8 10h8M8 14h8M8 18h8',none:'M4 4h16v16H4zM8 12h8M12 8v8'};
 const bar=document.createElement('div');bar.className='exterior-sticker-bar';bar.setAttribute('aria-label','Exterior sticker library');
 const strip=document.createElement('div');strip.className='ss-strip';bar.appendChild(strip);
 const tile=(name,path,color)=>{const b=document.createElement('button');b.type='button';b.className='ss-tile';b.style.setProperty('--feature-color',color||'#5f6368');b.innerHTML=svg(path)+'<span class="ss-name">'+name+'</span>';strip.appendChild(b);return b;};
 const placementTiles=new Map(),lastPlacementSizes=new Map();
 for(const def of F.defs.values()){const b=tile(def.name,paths[def.id]||paths.none,def.color);b.title=def.name+(def.key?' ('+def.key.toUpperCase()+')':'')+' — place on a face'+(['window','door','garage'].includes(def.id)?'; L divides the selected sticker':'');b.onclick=()=>{command(def.id,lastPlacementSizes.get(def.id)??def.defaultPreset??0,true);placementPanel.hidden=false;F.refreshUI();};placementTiles.set(def.id,b);b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-controls','wall-placement-options');}
 const face=document.createElement('button');face.type='button';face.className='exterior-face-toggle';face.innerHTML='Face type <span aria-hidden="true">▴</span>';face.title='Choose a face type and size';face.setAttribute('aria-label','Face type');face.setAttribute('aria-haspopup','dialog');face.setAttribute('aria-expanded','false');face.setAttribute('aria-controls','wall-face-options');bar.appendChild(face);
 const panel=document.createElement('div');panel.id='wall-face-options';panel.className='exterior-selection exterior-sticker-menu';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Face type and dimensions');panel.innerHTML='<div class="exterior-face-heading"><h4>FACE TYPE &amp; SIZE</h4><button type="button" aria-label="Close face types">×</button></div><p role="status"></p><table class="exterior-face-table"><thead><tr><th scope="col">Type</th><th scope="col">Width × height</th></tr></thead><tbody></tbody></table>';parent.appendChild(panel);
 const closeFace=()=>{panel.hidden=true;face.setAttribute('aria-expanded','false');};
 face.onclick=()=>{placementPanel.hidden=true;panel.hidden=!panel.hidden;face.setAttribute('aria-expanded',String(!panel.hidden));};
 panel.querySelector('.exterior-face-heading button').onclick=()=>{closeFace();face.focus();};
 // Build the complete catalog once so opening never waits on a render or rebuild.
 const choices=[],feet=n=>{const inches=Math.round(n*12),f=Math.floor(inches/12),i=inches%12;return f+'′'+(i?i+'″':'');};
 const addChoice=(container,type,preset,label)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.type=type;b.dataset.preset=preset===null?'current':String(preset);b.setAttribute('aria-label',(F.defs.get(type)?.name||'Untyped face')+' · '+label);b.onclick=()=>{if(busy())return;const place=!selection();if(place&&preset===null)return;if(place){command(type,preset,true);closeFace();}else command(type,preset);F.refreshUI();};container.appendChild(b);choices.push({b,type,preset});};
 for(const def of [{id:'none',name:'Untyped face',color:'#c1ccd5',sizes:[]},...F.defs.values()]){
  const row=document.createElement('tr'),heading=document.createElement('th'),cell=document.createElement('td'),options=document.createElement('div');heading.scope='row';const name=document.createElement('span');name.className='exterior-face-type';const swatch=document.createElement('span');swatch.className='exterior-swatch';swatch.style.background=def.color;name.append(swatch,document.createTextNode(def.name));heading.appendChild(name);options.className='exterior-size-options';cell.appendChild(options);row.append(heading,cell);panel.querySelector('tbody').appendChild(row);
  addChoice(options,def.id,null,def.id==='none'?'Remove type':'Keep size');
  F.pickerIndices(def.id).forEach(i=>{const size=def.sizes[i];addChoice(options,def.id,i,feet(size.w)+' × '+feet(size.h)+(size.shape==='circle'?' · Round':''));});
 }
 const placementPanel=document.createElement('div');placementPanel.id='wall-placement-options';placementPanel.className='exterior-selection exterior-sticker-menu';placementPanel.hidden=true;placementPanel.setAttribute('role','dialog');placementPanel.setAttribute('aria-label','Feature placement size');placementPanel.innerHTML='<div class="exterior-face-heading"><h4></h4><button type="button" aria-label="Close placement sizes">\u00d7</button></div><p class="placement-current" role="status"></p><div class="placement-size-table"></div><div class="placement-other"></div>';parent.appendChild(placementPanel);
 placementPanel.querySelector('.exterior-face-heading button').onclick=()=>{placementPanel.hidden=true;};
 let placementKey='',placementChoices=[];
 function refreshPlacement(){
  const active=materials.placement?.();for(const [type,b]of placementTiles){const chosen=active?.type===type;b.classList.toggle('active',chosen);b.setAttribute('aria-expanded',String(chosen&&!placementPanel.hidden));}
  if(!active){placementKey='';placementPanel.hidden=true;return;}
  const def=F.defs.get(active.type);if(!def)return;lastPlacementSizes.set(active.type,active.index);
  const key=active.session+':'+active.type;
  if(key!==placementKey){placementKey=key;closeFace();placementPanel.hidden=false;placementChoices=[];placementPanel.querySelector('h4').textContent=def.name+' sizes';
   const main=placementPanel.querySelector('.placement-size-table'),other=placementPanel.querySelector('.placement-other');main.replaceChildren();other.replaceChildren();
   const add=(container,index,text)=>{const size=def.sizes[index],b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.preset=String(index);b.setAttribute('aria-label',def.name+' \u00b7 '+feet(size.w)+' wide \u00d7 '+feet(size.h)+' tall'+(size.shape==='circle'?' \u00b7 Round':''));b.title=b.getAttribute('aria-label');b.onclick=()=>{command(active.type,index,true);F.refreshUI();};container.appendChild(b);placementChoices.push({b,index});};
   const groups=F.pickerGroups(def.id);
   if(groups){main.className='placement-size-table placement-other';for(const group of groups){const heading=document.createElement('h5');heading.textContent=group.label;main.appendChild(heading);const options=document.createElement('div');options.className='exterior-size-options';main.appendChild(options);for(const index of group.indices){const size=def.sizes[index];add(options,index,feet(size.w)+' \u00d7 '+feet(size.h)+(size.shape==='circle'?' \u00b7 Round':''));}}}
   else{main.className='placement-size-table';
   const standard=def.sizes.map((s,index)=>({...s,index})).filter(s=>s.shape==='rectangle'&&Number.isInteger(s.w)&&Number.isInteger(s.h)),widths=[...new Set(standard.map(s=>s.w))].sort((a,b)=>a-b),heights=[...new Set(standard.map(s=>s.h))].sort((a,b)=>a-b);
   const table=document.createElement('table');table.className='placement-matrix';const head=document.createElement('thead'),tr=document.createElement('tr'),corner=document.createElement('th');corner.textContent='Height / Width';tr.appendChild(corner);for(const w of widths){const th=document.createElement('th');th.scope='col';th.textContent=feet(w);tr.appendChild(th);}head.appendChild(tr);table.appendChild(head);const body=document.createElement('tbody');table.appendChild(body);main.appendChild(table);

   for(const h of heights){const row=document.createElement('tr'),th=document.createElement('th');th.scope='row';th.textContent=feet(h);row.appendChild(th);for(const w of widths){const cell=document.createElement('td'),size=standard.find(s=>s.w===w&&s.h===h);if(size)add(cell,size.index,w+' \u00d7 '+h);else cell.textContent='\u2014';row.appendChild(cell);}body.appendChild(row);}
   const extras=def.sizes.map((s,index)=>({...s,index})).filter(s=>!standard.some(v=>v.index===s.index));if(extras.length){const heading=document.createElement('h5');heading.textContent='Other sizes & shapes';other.appendChild(heading);const options=document.createElement('div');options.className='exterior-size-options';other.appendChild(options);for(const s of extras)add(options,s.index,feet(s.w)+' \u00d7 '+feet(s.h)+(s.shape==='circle'?' \u00b7 Round':''));}
   }
  }
  const size=def.sizes[active.index];placementPanel.querySelector('.placement-current').textContent='Selected: '+feet(size.w)+' wide \u00d7 '+feet(size.h)+' tall'+(size.shape==='circle'?' \u00b7 Round':'')+(['window','door'].includes(active.type)?' · Trim: '+(active.trimInches?active.trimInches+' in':'off')+' · T cycles trim.':'')+'. Click the wall to place.';
  for(const {b,index}of placementChoices)b.setAttribute('aria-pressed',String(index===active.index));
 }
 const toggle=document.createElement('button');toggle.className='exterior-sticker-toggle';toggle.innerHTML='<i class="fas fa-chevron-right" aria-hidden="true"></i>';toggle.title='Hide wall stickers';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded','true');toggle.onclick=()=>{strip.hidden=!strip.hidden;closeFace();placementPanel.hidden=true;toggle.innerHTML='<i class="fas fa-chevron-'+(strip.hidden?'left':'right')+'" aria-hidden="true"></i>';toggle.title=strip.hidden?'Show wall stickers':'Hide wall stickers';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded',String(!strip.hidden));};bar.appendChild(toggle);parent.appendChild(bar);
 const picker=document.createElement('section');picker.id='wall-material-picker';picker.className='exterior-sticker-menu';picker.hidden=true;picker.setAttribute('aria-label','Wall materials');picker.innerHTML='<div class="exterior-picker-heading"><h4>WALL MATERIALS</h4><button type="button" aria-label="Close wall materials">×</button></div><div class="exterior-material-options"></div><p>Select a face to edit its finish, or choose a material first and click sections to paint. Escape finishes painting.</p><div class="exterior-finish-controls"><label>Finish color<input type="color" value="#f5f3ef" aria-label="Finish color"></label><div class="exterior-palette-heading">Common</div><div class="exterior-color-options" data-palette="common" role="group" aria-label="Common colors"></div><div class="exterior-palette-heading">In this project · most used first</div><div class="exterior-color-options" data-palette="project" role="group" aria-label="Project colors"></div><div class="exterior-palette-heading">Recent</div><div class="exterior-color-options" data-palette="recent" role="group" aria-label="Recent colors"></div><p>Color is independent of material. Choose a color to update the selected face.</p></div><label><input type="checkbox">Colors in plain modes</label>';parent.appendChild(picker);
 const trigger=document.createElement('button');trigger.id='wall-material-toggle';trigger.className='toolbar-btn';trigger.innerHTML='<i class="fas fa-palette" aria-hidden="true"></i>';trigger.title='Wall materials';trigger.setAttribute('aria-label','Wall materials');trigger.setAttribute('aria-controls',picker.id);trigger.setAttribute('aria-expanded','false');document.getElementById('btnToggleTypes')?.after(trigger);
 const closeMaterials=()=>{closeDefaultTexture();picker.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.classList.remove('active');materials.finish?.();};
 trigger.onclick=()=>{if(!picker.hidden){closeMaterials();return;}picker.hidden=false;trigger.setAttribute('aria-expanded','true');trigger.classList.add('active');refreshMaterials();refreshPalette();};picker.querySelector('.exterior-picker-heading button').onclick=closeMaterials;
 const option=(parent,label,color,active,fn,disabled=false)=>{const b=document.createElement('button');b.type='button';b.className='exterior-option';b.disabled=disabled;b.setAttribute('aria-pressed',String(active));if(color){const swatch=document.createElement('span');swatch.className='exterior-swatch';swatch.style.background=color;b.appendChild(swatch);}b.appendChild(document.createTextNode(label));b.onclick=fn;parent.appendChild(b);return b;};
 const materialButtons=[];for(const [id,def]of Object.entries(window.ExteriorMaterials||{})){const b=option(picker.querySelector('.exterior-material-options'),def.label,def.color,false,()=>{materials.paint?.(id);refreshMaterials();});materialButtons.push([id,b]);}
 const colorInput=picker.querySelector('input[type=color]'),commonColors=['#f5f3ef','#e8dcc3','#8c9296','#3e454b','#53758a','#6d8071'];
 const normalizeColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():null;
 const recentByProject=new Map(),paletteRows=new Map();
 const paletteKey=()=>String(materials.projectId?.()||window.currentProjectId||'');
 function recentColors(){const key=paletteKey();if(!recentByProject.has(key)){let saved=[];try{saved=JSON.parse(localStorage.getItem('exterior-finish-colors:'+key)||'[]');}catch(_){}recentByProject.set(key,[...new Set((Array.isArray(saved)?saved:[]).map(normalizeColor).filter(Boolean))].slice(0,12));}return recentByProject.get(key);}
 function rememberColor(value){const color=normalizeColor(value);if(!color)return;const key=paletteKey(),recent=[color,...recentColors().filter(c=>c!==color)].slice(0,12);recentByProject.set(key,recent);try{localStorage.setItem('exterior-finish-colors:'+key,JSON.stringify(recent));}catch(_){} }
 function chooseColor(color){colorInput.value=color;materials.color?.(color);rememberColor(color);refreshPalette();}
 function fillPalette(kind,values){const row=picker.querySelector('[data-palette="'+kind+'"]'),colors=[...new Set(values.map(normalizeColor).filter(Boolean))],signature=colors.join(',');if(paletteRows.get(kind)===signature)return;paletteRows.set(kind,signature);row.replaceChildren();
  for(const color of colors){const b=document.createElement('button');b.type='button';b.className='exterior-color-swatch';b.style.backgroundColor=color;b.dataset.color=color;b.title=color;b.setAttribute('aria-label','Use color '+color);b.onclick=()=>{chooseColor(color);row.querySelector('[data-color="'+color+'"]')?.focus({preventScroll:true});};row.appendChild(b);}
  if(kind==='common'){const reset=document.createElement('button');reset.type='button';reset.className='exterior-color-swatch exterior-color-reset';reset.innerHTML='<i class="fas fa-undo" aria-hidden="true"></i>';reset.title='Use default finish color';reset.setAttribute('aria-label',reset.title);reset.onclick=()=>materials.color?.('default');row.appendChild(reset);}
  else if(!colors.length){const empty=document.createElement('span');empty.className='exterior-palette-empty';empty.textContent=kind==='recent'?'Colors you choose appear here':'No project colors yet';row.appendChild(empty);}
 }
 // Inventory only at UI boundaries, never in the per-frame refresh path.
 function refreshPalette(){fillPalette('common',commonColors);fillPalette('project',materials.projectColors?.()||[]);fillPalette('recent',recentColors());}
 picker.addEventListener('pointerenter',refreshPalette);
 picker.addEventListener('focusin',e=>{if(!picker.contains(e.relatedTarget))refreshPalette();});
 colorInput.oninput=()=>materials.color?.(colorInput.value);
 colorInput.onchange=()=>{rememberColor(colorInput.value);refreshPalette();};
 const colors=picker.querySelector('input[type=checkbox]');colors.onchange=()=>materials.colors?.(colors.checked);
 const defaultsPanel=document.createElement('section');defaultsPanel.className='exterior-finish-controls exterior-default-finishes';defaultsPanel.setAttribute('aria-label','Default finishes');defaultsPanel.innerHTML='<h4>Default finishes</h4><div>Default texture<button type="button" class="exterior-option default-texture-toggle" aria-label="Default texture" aria-haspopup="menu" aria-expanded="false" aria-controls="default-texture-menu"><span class="exterior-swatch"></span><span class="default-texture-label"></span><span aria-hidden="true">▾</span></button><div id="default-texture-menu" role="menu" aria-label="Default texture" hidden></div></div><label>Default color<input type="color" aria-label="Default color"></label><label>Default trim color<input type="color" aria-label="Default trim color"></label><p>Applies to current and future faces without an individual override.</p>';picker.querySelector('.exterior-picker-heading').after(defaultsPanel);
 const defaultTexture=defaultsPanel.querySelector('.default-texture-toggle'),textureMenu=defaultsPanel.querySelector('[role=menu]'),defaultColors=defaultsPanel.querySelectorAll('input[type=color]'),textureButtons=[];let defaultMaterial='unassigned';
 function closeDefaultTexture(){textureMenu.hidden=true;defaultTexture.setAttribute('aria-expanded','false');}
 const updateDefaults=()=>materials.defaults?.({material:defaultMaterial,color:defaultColors[0].value,trimColor:defaultColors[1].value});
 for(const [id,def]of Object.entries(window.ExteriorMaterials||{})){if(id==='default'||id==='chimney-top'||id.startsWith('trim-'))continue;const b=option(textureMenu,def.label,def.color,false,()=>{defaultMaterial=id;updateDefaults();refreshMaterials();closeDefaultTexture();defaultTexture.focus();});b.setAttribute('role','menuitemradio');textureButtons.push([id,b]);}
 defaultTexture.onclick=()=>{textureMenu.hidden=!textureMenu.hidden;defaultTexture.setAttribute('aria-expanded',String(!textureMenu.hidden));if(!textureMenu.hidden)(textureButtons.find(([id])=>id===defaultMaterial)||textureButtons[0])?.[1].focus();};
 textureMenu.onkeydown=e=>{const buttons=textureButtons.map(([,b])=>b),i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}};
 document.addEventListener('pointerdown',e=>{if(!defaultsPanel.contains(e.target))closeDefaultTexture();},true);
 for(const input of defaultColors)input.onchange=()=>{updateDefaults();rememberColor(input.value);refreshPalette();};
 function refreshMaterials(){const d=materials.defaults?.()||{material:'unassigned',color:'#80868b',trimColor:'#f5f3ef'};defaultMaterial=d.material;const def=window.ExteriorMaterials?.[d.material];defaultTexture.querySelector('.default-texture-label').textContent=def?.label||'Smooth';defaultTexture.querySelector('.exterior-swatch').style.background=def?.color||d.color;for(const [id,b]of textureButtons){b.setAttribute('aria-checked',String(id===d.material));b.setAttribute('aria-pressed',String(id===d.material));}defaultColors.forEach((input,i)=>{if(document.activeElement!==input)input.value=i?d.trimColor:d.color;});const activeMaterial=materials.active?.();for(const [id,b]of materialButtons)b.setAttribute('aria-pressed',String(activeMaterial===id));colors.checked=materials.colors?.()!==false;}
 for(const el of [bar,picker,panel,placementPanel])for(const event of ['pointerdown','mousedown','mouseup','click','dblclick','wheel'])el.addEventListener(event,e=>e.stopPropagation());
 F.closeUI=()=>{closeFace();closeMaterials();placementPanel.hidden=true;};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!textureMenu.hidden){e.preventDefault();e.stopImmediatePropagation();closeDefaultTexture();defaultTexture.focus();}else F.closeUI();}},true);
 let last='';F.refreshUI=function(){refreshMaterials();refreshPlacement();const ref=selection(),locked=busy(),type=ref?.feature?.type||'none',label=ref?(F.defs.get(type)?.name||'Untyped face')+' · '+F.label(ref.points,ref.feature):'Choose a size to place a new feature on a face.',signature=JSON.stringify([label,type,ref?.feature?.preset,locked]);if(signature===last)return;last=signature;
 panel.querySelector('p').textContent=locked?'Finish the current tool to change a face.':label;
 for(const choice of choices){choice.b.disabled=locked||(!ref&&choice.preset===null);choice.b.setAttribute('aria-pressed',String(!!ref&&type===choice.type&&(ref.feature?.preset??null)===choice.preset));}
 };F.refreshUI();
};F.formatSize=n=>String(Math.round(n*100)/100);

})();



if(typeof window!=='undefined')window.ExteriorMaterials={default:{label:'Default',color:'#c1ccd5'},unassigned:{label:'Smooth',color:'#c1ccd5'},'chimney-top':{label:'Chimney top',color:'#d4d0c8'},siding:{label:'Horizontal siding',color:'#749dbd'},'siding-vertical':{label:'Vertical siding',color:'#83a7b7'},soffit:{label:'Soffit',color:'#bcc8cb'},'trim-horizontal':{label:'Horizontal trim',color:'#d7c7a8',finishColor:'#f5f3ef'},'trim-vertical':{label:'Vertical trim',color:'#b8c8ce',finishColor:'#f5f3ef'},brick:{label:'Brick',color:'#b87965'},masonry:{label:'Masonry',color:'#a79c86'},stucco:{label:'Stucco',color:'#c7ba94'},stone:{label:'Stone',color:'#899889'},other:{label:'Other',color:'#a291b8'}};
