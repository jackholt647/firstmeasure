/* Screen-space photo reference. Never inserted into model or report geometry. */
(() => {
 'use strict';
 let layer, panel, photo, owner='', source='', width=0, height=0, x=0, y=0, scale=1, opacity=.65, ticket=0, drag=null, binding=null, observer=null;
 const icon='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>';
 function build(){
  const container=document.getElementById('three-container');if(!container)return false;
  if(!layer){
   layer=document.createElement('div');layer.className='resource-3d-background';layer.hidden=true;layer.setAttribute('aria-hidden','true');photo=document.createElement('img');photo.alt='';photo.draggable=false;layer.append(photo);
   panel=document.createElement('section');panel.id='resource-3d-controls';panel.hidden=true;panel.setAttribute('aria-label','3D photo reference');
   panel.innerHTML=`<header>${icon}<strong>Photo reference</strong><button data-photo="remove" aria-label="Remove photo reference" title="Remove photo reference">×</button></header><div class="photo-name"></div><div class="photo-position"><div class="photo-pad"><button data-photo="up" aria-label="Move photo up">↑</button><button data-photo="left" aria-label="Move photo left">←</button><button data-photo="drag" aria-label="Drag to move photo" title="Drag to move the photo without moving the model">✥</button><button data-photo="right" aria-label="Move photo right">→</button><button data-photo="down" aria-label="Move photo down">↓</button></div><div class="photo-position-help">Drag to position<button data-photo="fit">Fit / reset</button></div></div><label>Size <output data-value="size">100%</output><input data-photo="size" type="range" min="10" max="500" step="1" value="100" aria-label="Photo size"></label><label>Opacity <output data-value="opacity">65%</output><input data-photo="opacity" type="range" min="0" max="100" step="1" value="65" aria-label="Photo opacity"></label>`;
   panel.addEventListener('click',e=>{const a=e.target.closest('[data-photo]')?.dataset.photo,step=e.shiftKey?1:10;if(a==='remove')remove();if(a==='fit'){x=0;y=0;scale=1;}if(a==='left')x-=step;if(a==='right')x+=step;if(a==='up')y-=step;if(a==='down')y+=step;layout();});
   panel.addEventListener('input',e=>{if(e.target.dataset.photo==='size')scale=Number(e.target.value)/100;if(e.target.dataset.photo==='opacity')opacity=Number(e.target.value)/100;layout();});
   observer=new ResizeObserver(layout);
  }
  if(layer.parentNode!==container){container.prepend(layer);container.append(panel);observer.disconnect();observer.observe(container);}
  return true;
 }
 function layout(){
  if(!layer||!source)return;const c=layer.parentNode,w=c.clientWidth,h=c.clientHeight,fit=Math.min(w/width,h/height);
  Object.assign(photo.style,{width:width*fit*scale+'px',height:height*fit*scale+'px',left:w/2+x+'px',top:h/2+y+'px',opacity:String(opacity)});
  panel.querySelector('[data-photo="size"]').value=String(scale*100);panel.querySelector('[data-value="size"]').textContent=Math.round(scale*100)+'%';panel.querySelector('[data-photo="opacity"]').value=String(opacity*100);panel.querySelector('[data-value="opacity"]').textContent=Math.round(opacity*100)+'%';
 }
 function attach(scene,renderer){
  if(!scene||!renderer||!build())return;
  if(binding?.scene!==scene){restore();binding={scene,renderer,background:scene.background,alpha:renderer.getClearAlpha(),color:renderer.getClearColor().clone()};}
  if(source){if(scene.background)binding.background=scene.background;scene.background=null;renderer.setClearColor(0x111111,0);layer.hidden=false;panel.hidden=false;renderer.domElement.classList.add('resource-3d-model-canvas');layout();}
 }
 function restore(){if(!binding)return;const {scene,renderer,background,alpha,color}=binding;scene.background=background;renderer.setClearColor(color,alpha);renderer.domElement.classList.remove('resource-3d-model-canvas');binding=null;}
 function remove(){ticket++;drag=null;source='';owner='';if(photo)photo.removeAttribute('src');if(layer)layer.hidden=true;if(panel)panel.hidden=true;restore();if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl='';}window.dispatchEvent(new CustomEvent('resource-3d-overlay-change'));}
 let objectUrl='';
 async function show({image,label,project}){
  if(!image?.naturalWidth&&!image?.width)throw Error('Open a still image first.');if(!build())throw Error('The 3D view is unavailable.');const token=++ticket;
  const canvas=document.createElement('canvas'),ratio=Math.min(1,4096/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));canvas.width=Math.max(1,Math.round((image.naturalWidth||image.width)*ratio));canvas.height=Math.max(1,Math.round((image.naturalHeight||image.height)*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(token!==ticket||String(window.currentProjectId||'')!==String(project||''))return;if(!blob)throw Error('The photo could not be prepared.');
  if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);source=label||'Photo';owner=String(project||'');width=canvas.width;height=canvas.height;x=y=0;scale=1;opacity=.65;photo.src=objectUrl;panel.querySelector('.photo-name').textContent=source;panel.querySelector('.photo-name').title=source;
  window.refreshResource3DOverlay?.();layer.hidden=false;panel.hidden=false;layout();window.dispatchEvent(new CustomEvent('resource-3d-overlay-change'));
 }
 // Capture controls before editor shortcuts and picking. The model canvas keeps
 // its normal orbit, selection, and drawing gestures; only the drag pad moves the photo.
 window.addEventListener('pointerdown',e=>{if(!e.target.closest?.('#resource-3d-controls'))return;if(e.target.closest('[data-photo="drag"]')&&e.button===0){drag={id:e.pointerId,cx:e.clientX,cy:e.clientY,x,y};e.target.setPointerCapture(e.pointerId);e.preventDefault();}e.stopImmediatePropagation();},true);
 window.addEventListener('pointermove',e=>{if(!drag){if(e.target.closest?.('#resource-3d-controls'))e.stopImmediatePropagation();return;}if(e.pointerId!==drag.id)return;x=drag.x+e.clientX-drag.cx;y=drag.y+e.clientY-drag.cy;layout();e.preventDefault();e.stopImmediatePropagation();},true);
 const finish=e=>{if(drag&&e.pointerId===drag.id){drag=null;e.stopImmediatePropagation();}};window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',finish,true);window.addEventListener('blur',()=>drag=null);
 for(const type of ['keydown','keyup','wheel','dblclick'])window.addEventListener(type,e=>{if(e.target.closest?.('#resource-3d-controls'))e.stopImmediatePropagation();},true);
 setInterval(()=>{if(source&&owner!==String(window.currentProjectId||''))remove();},500);
 window.Resource3DOverlay={show,remove,attach,get active(){return !!source;}};
})();
