/* Screen-space photo reference. Never inserted into model or report geometry. */
(() => {
 'use strict';
 let layer, panel, photo, owner='', source='', width=0, height=0, x=0, y=0, scale=1, rotation=0, opacity=.65, ticket=0, drag=null, binding=null, observer=null, imageName='', seenProject='', saveTimer=null;
 const icon='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>';
 const validName=name=>typeof name==='string'&&/^internal-resource-[a-zA-Z0-9._-]+\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
 const resourceUrl=(project,name)=>'project_resources.php?'+new URLSearchParams({project,name});
 const cacheKey=(project,name)=>'firstmeasure:photo-overlay:'+project+':'+name;
 const queues=new Map();
 async function recordName(name){return 'internal-markup-overlay-'+(name==='active'?'active':[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(name)))].map(b=>b.toString(16).padStart(2,'0')).join(''))+'.json';}
 function cached(project,name){try{return JSON.parse(localStorage.getItem(cacheKey(project,name))||'null');}catch{return null;}}
 function cache(project,name,value){try{localStorage.setItem(cacheKey(project,name),JSON.stringify(value));}catch{}}
 async function readRecord(project,name){const local=cached(project,name);try{const response=await fetch(resourceUrl(project,await recordName(name)),{cache:'no-store'});if(!response.ok){if(local)writeRecord(project,name,local);return local;}const remote=await response.json();if(remote?.version!==1)return local;const value=local?.updatedAt>remote.updatedAt?local:remote;cache(project,name,value);if(value===local)writeRecord(project,name,local);return value;}catch{return local;}}
 function writeRecord(project,name,value){
  cache(project,name,value);const key=cacheKey(project,name),previous=queues.get(key)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const response=await fetch(resourceUrl(project,await recordName(name)),{method:'POST',headers:{'X-Resource-Request':'1','Content-Type':'application/octet-stream'},body:JSON.stringify(value),keepalive:true});if(!response.ok)throw Error('Alignment kept in this browser; project save failed.');});
  queues.set(key,next);next.then(()=>{if(queues.get(key)===next){queues.delete(key);if(owner===project&&panel)panel.querySelector('.photo-save-status').textContent='';}},error=>{if(owner===project&&panel)panel.querySelector('.photo-save-status').textContent=error.message;});
 }
 function settings(){const c=layer.parentNode;return {version:1,updatedAt:Date.now(),x:x/Math.max(1,c.clientWidth),y:y/Math.max(1,c.clientHeight),scale,rotation,opacity};}
 function saveSettings(){if(!owner||!validName(imageName))return;clearTimeout(saveTimer);const project=owner,name=imageName,value=settings();cache(project,name,value);saveTimer=setTimeout(()=>{saveTimer=null;writeRecord(project,name,value);},200);}
 function flushSettings(){if(saveTimer&&owner&&validName(imageName)){clearTimeout(saveTimer);saveTimer=null;writeRecord(owner,imageName,settings());}}
 async function restoreProject(project){const generation=ticket,active=await readRecord(project,'active');if(generation!==ticket||String(window.currentProjectId||'')!==project||source||!validName(active?.name))return;const img=new Image();img.onload=()=>{if(generation===ticket&&String(window.currentProjectId||'')===project&&!source)show({image:img,label:active.label||active.name,project,name:active.name,restoring:true}).catch(()=>{});};img.src=resourceUrl(project,active.name);}
 window.addEventListener('pagehide',flushSettings);
 function build(){
  const container=document.getElementById('three-container');if(!container)return false;
  if(!layer){
   layer=document.createElement('div');layer.className='resource-3d-background';layer.hidden=true;layer.setAttribute('aria-hidden','true');photo=document.createElement('img');photo.alt='';photo.draggable=false;layer.append(photo);
   panel=document.createElement('section');panel.id='resource-3d-controls';panel.hidden=true;panel.setAttribute('aria-label','3D photo reference');
   panel.innerHTML=`<header>${icon}<strong>Photo reference</strong><button data-photo="remove" aria-label="Remove photo reference" title="Remove photo reference">×</button></header><div class="photo-save-status" role="status"></div><div class="photo-name"></div><div class="photo-position"><div class="photo-pad"><button data-photo="up" aria-label="Move photo up">↑</button><button data-photo="left" aria-label="Move photo left">←</button><button data-photo="drag" aria-label="Drag to move photo" title="Drag to move the photo without moving the model">✥</button><button data-photo="right" aria-label="Move photo right">→</button><button data-photo="down" aria-label="Move photo down">↓</button></div><div class="photo-position-help">Drag to position · Scroll to zoom<button data-photo="fit">Fit / reset</button></div></div><label>Size <output data-value="size">100%</output><input data-photo="size" type="range" min="10" max="500" step="1" value="100" aria-label="Photo size"></label><label>Rotation <output data-value="rotation">0.0°</output><input data-photo="rotation" type="range" min="-15" max="15" step="0.1" value="0" aria-label="Photo rotation"></label><label>Opacity <output data-value="opacity">65%</output><input data-photo="opacity" type="range" min="0" max="100" step="1" value="65" aria-label="Photo opacity"></label>`;
   panel.addEventListener('click',e=>{const a=e.target.closest('[data-photo]')?.dataset.photo,step=e.shiftKey?1:10;if(a==='remove'){remove();return;}if(a==='fit'){x=0;y=0;scale=1;rotation=0;}if(a==='left')x-=step;if(a==='right')x+=step;if(a==='up')y-=step;if(a==='down')y+=step;layout();saveSettings();});
   panel.addEventListener('input',e=>{if(e.target.dataset.photo==='size')scale=Number(e.target.value)/100;if(e.target.dataset.photo==='rotation')rotation=Number(e.target.value);if(e.target.dataset.photo==='opacity')opacity=Number(e.target.value)/100;layout();saveSettings();});
   observer=new ResizeObserver(layout);
  }
  if(layer.parentNode!==container){container.prepend(layer);container.append(panel);observer.disconnect();observer.observe(container);}
  return true;
 }
 function layout(){
  if(!layer||!source)return;const c=layer.parentNode,w=c.clientWidth,h=c.clientHeight,fit=Math.min(w/width,h/height);
  Object.assign(photo.style,{width:width*fit*scale+'px',height:height*fit*scale+'px',left:w/2+x+'px',top:h/2+y+'px',opacity:String(opacity),transform:'translate(-50%,-50%) rotate('+rotation+'deg)',transformOrigin:'center'});
  panel.querySelector('[data-photo="rotation"]').value=String(rotation);panel.querySelector('[data-value="rotation"]').textContent=rotation.toFixed(1)+'°';
  panel.querySelector('[data-photo="size"]').value=String(scale*100);panel.querySelector('[data-value="size"]').textContent=Math.round(scale*100)+'%';panel.querySelector('[data-photo="opacity"]').value=String(opacity*100);panel.querySelector('[data-value="opacity"]').textContent=Math.round(opacity*100)+'%';
 }
 function attach(scene,renderer){
  if(!scene||!renderer||!build())return;
  if(binding?.scene!==scene){restore();binding={scene,renderer,background:scene.background,alpha:renderer.getClearAlpha(),color:renderer.getClearColor().clone()};}
  if(source){if(scene.background)binding.background=scene.background;scene.background=null;renderer.setClearColor(0x111111,0);layer.hidden=false;panel.hidden=false;renderer.domElement.classList.add('resource-3d-model-canvas');layout();}
 }
 function restore(){if(!binding)return;const {scene,renderer,background,alpha,color}=binding;scene.background=background;renderer.setClearColor(color,alpha);renderer.domElement.classList.remove('resource-3d-model-canvas');binding=null;}
 function remove(persist=true){flushSettings();if(persist&&owner&&imageName)writeRecord(owner,'active',{version:1,updatedAt:Date.now(),name:null});ticket++;drag=null;source='';owner='';imageName='';if(photo)photo.removeAttribute('src');if(layer)layer.hidden=true;if(panel)panel.hidden=true;restore();if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl='';}window.dispatchEvent(new CustomEvent('resource-3d-overlay-change'));}
 let objectUrl='';
 async function show({image,label,project,name,restoring=false}){
  flushSettings();
  if(!image?.naturalWidth&&!image?.width)throw Error('Open a still image first.');if(!build())throw Error('The 3D view is unavailable.');const token=++ticket;
  const canvas=document.createElement('canvas'),ratio=Math.min(1,4096/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));canvas.width=Math.max(1,Math.round((image.naturalWidth||image.width)*ratio));canvas.height=Math.max(1,Math.round((image.naturalHeight||image.height)*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const saved=validName(name)?await readRecord(String(project),name):null;const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(token!==ticket||String(window.currentProjectId||'')!==String(project||''))return;if(!blob)throw Error('The photo could not be prepared.');
  if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);source=label||'Photo';owner=String(project||'');imageName=validName(name)?name:'';seenProject=owner;width=canvas.width;height=canvas.height;x=y=0;scale=1;rotation=0;opacity=.65;if(saved){const c=layer.parentNode;x=Number.isFinite(saved.x)?saved.x*c.clientWidth:0;y=Number.isFinite(saved.y)?saved.y*c.clientHeight:0;scale=Number.isFinite(saved.scale)?Math.max(.1,Math.min(5,saved.scale)):1;rotation=Number.isFinite(saved.rotation)?Math.max(-15,Math.min(15,saved.rotation)):0;opacity=Number.isFinite(saved.opacity)?Math.max(0,Math.min(1,saved.opacity)):.65;}photo.src=objectUrl;panel.querySelector('.photo-save-status').textContent='';panel.querySelector('.photo-name').textContent=source;panel.querySelector('.photo-name').title=source;
  if(imageName&&!restoring){writeRecord(owner,'active',{version:1,updatedAt:Date.now(),name:imageName,label:source});saveSettings();}window.refreshResource3DOverlay?.();layer.hidden=false;panel.hidden=false;layout();window.dispatchEvent(new CustomEvent('resource-3d-overlay-change'));
 }
 // Capture controls before editor shortcuts and picking. The model canvas keeps
 // its normal orbit, selection, and drawing gestures; only the drag pad moves the photo.
 window.addEventListener('pointerdown',e=>{if(!e.target.closest?.('#resource-3d-controls'))return;if(e.target.closest('[data-photo="drag"]')&&e.button===0){drag={id:e.pointerId,cx:e.clientX,cy:e.clientY,x,y};e.target.setPointerCapture(e.pointerId);e.preventDefault();}e.stopImmediatePropagation();},true);
 window.addEventListener('pointermove',e=>{if(!drag){if(e.target.closest?.('#resource-3d-controls'))e.stopImmediatePropagation();return;}if(e.pointerId!==drag.id)return;x=drag.x+e.clientX-drag.cx;y=drag.y+e.clientY-drag.cy;layout();saveSettings();e.preventDefault();e.stopImmediatePropagation();},true);
 const finish=e=>{if(drag&&e.pointerId===drag.id){drag=null;e.stopImmediatePropagation();}};window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',finish,true);window.addEventListener('blur',()=>drag=null);
 // Wheel zoom belongs only to the controls; the entire model canvas stays free.
 window.addEventListener('wheel',e=>{
  if(!source||panel?.hidden||!e.target.closest?.('#resource-3d-controls'))return;
  const c=layer.parentNode;
  e.preventDefault();e.stopImmediatePropagation();
  const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?c.clientHeight:1);if(!Number.isFinite(delta)||!delta)return;
  scale=Math.max(.1,Math.min(5,scale*Math.exp(-Math.max(-500,Math.min(500,delta))*.0015)));layout();saveSettings();
 },{capture:true,passive:false});
 for(const type of ['keydown','keyup','dblclick'])window.addEventListener(type,e=>{if(e.target.closest?.('#resource-3d-controls'))e.stopImmediatePropagation();},true);
 setInterval(()=>{const project=String(window.currentProjectId||'');if(project===seenProject)return;if(source)remove(false);seenProject=project;if(project)restoreProject(project);},500);
 window.Resource3DOverlay={show,remove,attach,get active(){return !!source;},get imageName(){return imageName;}};
})();
