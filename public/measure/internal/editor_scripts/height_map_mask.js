/* Display-only DSM mask. Image-space pixels; source elevations stay untouched. */
(function(root){'use strict';
function create(width,height,runs=[]){
 const data=new Uint8Array(width*height);
 function load(spans){data.fill(0);for(const span of spans||[]){if(!Array.isArray(span))continue;const [start,count]=span;if(Number.isInteger(start)&&Number.isInteger(count)&&start>=0&&count>0&&start+count<=data.length)data.fill(1,start,start+count);}}
 function serialize(){const spans=[];for(let i=0;i<data.length;){if(!data[i]){i++;continue;}const start=i;while(i<data.length&&data[i])i++;spans.push([start,i-start]);}return spans;}
 function paint(a,b,radius,erase=false,rectangle=false){
  if(![a.x,a.y,b.x,b.y,radius].every(Number.isFinite))return;
  const r=rectangle?0:Math.max(.5,radius),x0=Math.max(0,Math.floor(Math.min(a.x,b.x)-r)),x1=Math.min(width-1,Math.ceil(Math.max(a.x,b.x)+r)),y0=Math.max(0,Math.floor(Math.min(a.y,b.y)-r)),y1=Math.min(height-1,Math.ceil(Math.max(a.y,b.y)+r));
  const dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const t=len?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/len)):0;
   if(rectangle||Math.hypot(x-a.x-dx*t,y-a.y-dy*t)<=r)data[y*width+x]=erase?0:1;
  }
 }
 load(runs);return {width,height,data,load,serialize,paint};
}
// Remove triangles instead of flattening them: invisible hedges must not remain
// as pickable curtains or obscure the ground when viewed from the side.
function visibleIndices(index,data){
 const result=new index.constructor(index.length);let count=0;
 for(let i=0;i<index.length;i+=3)if(!data[index[i]]&&!data[index[i+1]]&&!data[index[i+2]]){result[count++]=index[i];result[count++]=index[i+1];result[count++]=index[i+2];}
 return result.subarray(0,count);
}
if(typeof module==='object'&&module.exports){module.exports={create,visibleIndices};return;}
let model=null,project='',context=null,savedAt=0,active=false,mode='draw',shape='brush',size=40,gesture=null,hover=null,undo=[],redo=[],bar,overlay,tint,stamp=0,tintStamp=-1,timer=null;
const originalIndices=new WeakMap(),copy=v=>JSON.parse(JSON.stringify(v));
const getContext=()=>({width:Number(imageWidth)||0,height:Number(imageHeight)||0,lat:Number(mapCenterLat)||0,lng:Number(mapCenterLng)||0,mpp:Number(root.getMetersPerPx?.())||0});
const key=id=>'firstmeasure:height-mask:v1:'+location.origin+':'+id;
const same=(a,b)=>a&&b&&Object.keys(b).every(k=>Math.abs(Number(a[k])-b[k])<1e-8);
const wallMode=()=>!!root.WallMode?.enabled;
function ensure(){
 const next=getContext();if(!next.width||!next.height)return false;
 const id=String(root.currentProjectId||'');
 if(!model||project!==id||!same(context,next)){project=id;context=next;model=create(next.width,next.height);savedAt=0;undo=[];redo=[];stamp++;}
 return true;
}
function serialize(){if(!ensure())return null;return {version:1,context:copy(context),runs:model.serialize(),savedAt};}
function save(){savedAt=Math.max(Date.now(),savedAt+1);try{if(project)localStorage.setItem(key(project),JSON.stringify(serialize()));status('Mask updated. Save the project to keep it across devices.');}catch{status('Local backup unavailable. Save the project to keep this mask.');}}
function refreshMesh(){timer=null;if(typeof update3DCrop==='function')update3DCrop();root.requestEditorRender?.();}
function changed(final=false){stamp++;render();if(final){if(timer)clearTimeout(timer);refreshMesh();}else if(!timer)timer=setTimeout(refreshMesh,100);}
function commit(before){const after=model.serialize();if(JSON.stringify(before)===JSON.stringify(after))return;undo.push(before);if(undo.length>20)undo.shift();redo=[];save();changed(true);}
function history(back){cancel();const from=back?undo:redo,to=back?redo:undo;if(!from.length)return;to.push(model.serialize());model.load(from.pop());save();changed(true);}
function cancel(){if(!gesture)return;model.load(gesture.before);gesture=null;changed(true);}
function status(text){const el=document.getElementById('height-mask-status');if(el)el.textContent=text;}
function setActive(on){cancel();active=!!on&&wallMode()&&ensure();hover=null;if(active)root.WallMode?.prepareHeightMask?.();render();}
function render(){
 if(!bar)return;bar.hidden=!wallMode();if(!wallMode()&&active){cancel();active=false;}
 const button=document.getElementById('height-mask-toggle');button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-expanded',String(active));
 document.getElementById('height-mask-tools').hidden=!active;
 for(const value of ['draw','erase'])document.getElementById('height-mask-'+value).setAttribute('aria-pressed',String(mode===value));
 for(const value of ['brush','rectangle'])document.getElementById('height-mask-'+value).setAttribute('aria-pressed',String(shape===value));
 document.getElementById('height-mask-undo').disabled=!undo.length;document.getElementById('height-mask-redo').disabled=!redo.length;
 document.getElementById('height-mask-size').disabled=shape!=='brush';
 if(!ensure())return;
 const parent=document.getElementById('zoom-layer');if(!parent)return;
 if(!overlay||overlay.parentNode!==parent){overlay=document.createElement('canvas');overlay.id='height-mask-overlay';overlay.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:20;transform-origin:center';parent.appendChild(overlay);}
 overlay.hidden=!active;overlay.style.transform=`rotate(${typeof viewRotation==='number'?viewRotation:0}rad)`;
 if(overlay.width!==model.width||overlay.height!==model.height){overlay.width=model.width;overlay.height=model.height;}
 if(!active)return;
 if(!tint||tint.width!==model.width||tint.height!==model.height){tint=document.createElement('canvas');tint.width=model.width;tint.height=model.height;tintStamp=-1;}
 if(tintStamp!==stamp){const ctx=tint.getContext('2d'),pixels=ctx.createImageData(model.width,model.height);for(let i=0;i<model.data.length;i++)if(model.data[i]){pixels.data[i*4]=185;pixels.data[i*4+1]=75;pixels.data[i*4+2]=230;pixels.data[i*4+3]=105;}ctx.putImageData(pixels,0,0);tintStamp=stamp;}
 const ctx=overlay.getContext('2d');ctx.clearRect(0,0,overlay.width,overlay.height);ctx.drawImage(tint,0,0);ctx.lineWidth=1.5/Math.max(.01,currentZoom);ctx.strokeStyle=mode==='erase'?'#ffffff':'#ffca57';
 if(gesture&&shape==='rectangle'){ctx.strokeRect(gesture.start.x,gesture.start.y,gesture.last.x-gesture.start.x,gesture.last.y-gesture.start.y);}
 else if(hover&&shape==='brush'){ctx.beginPath();ctx.arc(hover.x,hover.y,size/(2*Math.max(.01,currentZoom)),0,Math.PI*2);ctx.stroke();}
}
function applyGeometry(geometry){
 if(!geometry?.index)return;
 let entry=originalIndices.get(geometry);if(!entry){entry={index:geometry.index,stamp:-1,model:null,on:null};originalIndices.set(geometry,entry);}
 const on=wallMode()&&ensure()&&geometry.attributes.position.count===model.data.length;
 if(entry.on===on&&entry.stamp===stamp&&entry.model===model)return;
 if(on&&model.data.includes(1)){
  const indices=visibleIndices(entry.index.array,model.data);geometry.setIndex(new entry.index.constructor(indices,1));
 }else geometry.setIndex(entry.index);
 entry.on=on;entry.stamp=stamp;entry.model=model;
}
function restore(id,value){
 cancel();project=String(id||'');context=getContext();model=create(context.width,context.height);savedAt=0;undo=[];redo=[];active=false;
 let local=null;try{local=JSON.parse(localStorage.getItem(key(project))||'null');}catch{}
 const saved=[value,local].filter(v=>v?.version===1&&same(v.context,context)&&Array.isArray(v.runs)).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0))[0];
 if(saved){model.load(saved.runs);savedAt=saved.savedAt||0;}changed(true);
}
function reset(){cancel();active=false;project='';context=null;model=null;undo=[];redo=[];savedAt=0;stamp++;if(timer)clearTimeout(timer);timer=null;if(overlay)overlay.hidden=true;}
function initialize(){
 const parent=document.getElementById('tab-view2d');if(!parent)return;
 const style=document.createElement('style');style.textContent=`#height-mask-header{flex-shrink:0;display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 8px;background:#252b31;color:#e8edf2;font:12px Arial,sans-serif;border-bottom:1px solid #4b5660}#height-mask-header[hidden],#height-mask-tools[hidden]{display:none!important}#height-mask-tools{display:flex;align-items:center;flex-wrap:wrap;gap:5px}#height-mask-header button{background:#39434d;color:inherit;border:1px solid #65717e;border-radius:4px;padding:4px 8px;cursor:pointer}#height-mask-header button[aria-pressed=true]{background:#67528c;border-color:#c7a7ed}#height-mask-header button:disabled{opacity:.45;cursor:default}#height-mask-header input{width:75px;vertical-align:middle}#height-mask-status{flex-basis:100%;font-size:11px;color:#c4ced7}.wall-mode-active #tab-view2d{display:flex;flex-direction:column;min-height:0}.wall-mode-active #tab-view2d:not(.active){display:none}.wall-mode-active #tab-view2d #viewport{flex:1;min-height:0;height:auto}`;document.head.appendChild(style);
 bar=document.createElement('div');bar.id='height-mask-header';bar.hidden=true;
 bar.innerHTML='<strong>2D</strong><button type="button" id="height-mask-toggle" aria-pressed="false" aria-expanded="false" aria-controls="height-mask-tools">Mask height map</button><div id="height-mask-tools" hidden><button type="button" id="height-mask-draw" aria-pressed="true">Draw</button><button type="button" id="height-mask-erase" aria-pressed="false">Erase</button><button type="button" id="height-mask-brush" aria-pressed="true">Brush</button><button type="button" id="height-mask-rectangle" aria-pressed="false">Rectangle</button><label>Size <input id="height-mask-size" aria-label="Mask brush size" type="range" min="4" max="160" value="40"></label><button type="button" id="height-mask-undo">Undo</button><button type="button" id="height-mask-redo">Redo</button><button type="button" id="height-mask-clear">Clear mask</button><span id="height-mask-status" role="status">Draw over trees or hedges to hide their height mesh. Erase restores it. Esc finishes.</span></div>';
 parent.insertBefore(bar,parent.firstChild);
 document.getElementById('height-mask-toggle').onclick=()=>setActive(!active);
 for(const value of ['draw','erase'])document.getElementById('height-mask-'+value).onclick=()=>{cancel();mode=value;render();};
 for(const value of ['brush','rectangle'])document.getElementById('height-mask-'+value).onclick=()=>{cancel();shape=value;render();};
 document.getElementById('height-mask-size').oninput=e=>{size=Number(e.target.value);render();};
 document.getElementById('height-mask-clear').onclick=()=>{cancel();const before=model.serialize();model.load([]);commit(before);};
 document.getElementById('height-mask-undo').onclick=()=>history(true);document.getElementById('height-mask-redo').onclick=()=>history(false);
 render();
}
const inside=e=>e.target.closest?.('#viewport'),stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
// Register before wall-mode input handlers, including capture listeners.
root.addEventListener('pointerdown',e=>{
 if(!active||!wallMode()||!inside(e)||e.button!==0||!ensure())return;
 stop(e);const p=screenToImage(e.clientX,e.clientY);gesture={id:e.pointerId,before:model.serialize(),start:p,last:p,radius:size/(2*Math.max(.01,currentZoom))};hover=p;
 if(shape==='brush')model.paint(p,p,gesture.radius,mode==='erase');changed();
},true);
root.addEventListener('pointermove',e=>{
 if(!active||!wallMode()||(!gesture&&!inside(e)))return;
 const p=screenToImage(e.clientX,e.clientY);hover=p;
 if(gesture&&e.pointerId===gesture.id){stop(e);if(shape==='rectangle'){model.load(gesture.before);model.paint(gesture.start,p,0,mode==='erase',true);}else model.paint(gesture.last,p,gesture.radius,mode==='erase');gesture.last=p;changed();}else render();
},true);
root.addEventListener('pointerup',e=>{if(!gesture||e.pointerId!==gesture.id)return;stop(e);const before=gesture.before;gesture=null;commit(before);render();},true);
root.addEventListener('pointercancel',()=>cancel(),true);root.addEventListener('blur',()=>cancel());
for(const type of ['mousedown','mouseup','click','dblclick'])root.addEventListener(type,e=>{if(active&&wallMode()&&inside(e)&&e.button===0)stop(e);},true);
root.addEventListener('keydown',e=>{
 if(!active||!wallMode()||e.target.closest?.('input,textarea,select,[contenteditable=true]'))return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s')return;
 if(e.key==='Tab')return;
 stop(e);if(e.key==='Escape'){if(gesture)cancel();else setActive(false);}else if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase()))history(e.key.toLowerCase()==='z'&&!e.shiftKey);
},true);
root.HeightMapMask={serialize,restore,reset,render,applyGeometry,setActive,restoreGeometryIndex(geometry){const entry=originalIndices.get(geometry);if(entry){geometry.setIndex(entry.index);entry.stamp=-1;}},get active(){return active;},syncMode(){if(!wallMode())setActive(false);render();refreshMesh();}};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})(typeof window==='undefined'?globalThis:window);
