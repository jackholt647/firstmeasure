/* Reusable image presentation. The caller owns authorized media resolution. */
export function mount(root,{url,alt='Image',initialState={}}={}) {
  if(!document.getElementById('fm-image-viewer-style')){
    const style=document.createElement('style');style.id='fm-image-viewer-style';
    style.textContent='.fm-image-viewer{position:relative;width:100%;height:100%;min-height:240px;overflow:hidden;background:#eef1f5;color:#344054}.fm-image-canvas{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:grab;outline-offset:-3px}.fm-image-canvas:focus-visible{outline:2px solid var(--primary,#d93025)}.fm-image-canvas.is-dragging{cursor:grabbing}.fm-image-canvas img{position:absolute;left:50%;top:50%;max-width:none;max-height:none;user-select:none;pointer-events:none;transform-origin:center}.fm-image-tools{position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:4px;padding:4px;background:#fffe;border:1px solid #d0d5dd;border-radius:8px;box-shadow:0 2px 8px #0001}.fm-image-tools button{border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:15px;padding:4px 8px}.fm-image-tools button:hover{background:#eaecf0}.fm-image-tools output{font-size:11px;min-width:36px;text-align:center}.fm-image-hint{position:absolute;bottom:10px;left:10px;right:10px;font-size:10px;text-align:center;color:#667085;pointer-events:none}.fm-image-status{position:absolute;inset:0;display:grid;place-items:center;font-size:12px;color:#667085}';document.head.append(style);
  }
  root.innerHTML='<div class="fm-image-viewer"><div class="fm-image-canvas" tabindex="0" role="group" aria-label="Image viewer. Scroll to zoom, drag to pan, or use arrow keys."><img draggable="false"></div><div class="fm-image-tools" role="toolbar" aria-label="Image controls"><button type="button" data-image-out aria-label="Zoom out">−</button><output aria-label="Zoom level">100%</output><button type="button" data-image-in aria-label="Zoom in">+</button><button type="button" data-image-fit aria-label="Fit image">Fit</button></div><div class="fm-image-hint">Scroll to zoom · Drag to move</div><div class="fm-image-status" role="status">Loading image…</div></div>';
  const viewer=root.firstElementChild,canvas=viewer.querySelector('.fm-image-canvas'),img=viewer.querySelector('img'),output=viewer.querySelector('output'),status=viewer.querySelector('.fm-image-status');
  img.alt=alt;
  let zoom=Math.min(12,Math.max(1,Number(initialState.zoom)||1)),x=Number(initialState.x)||0,y=Number(initialState.y)||0,fit=1,drag=null,alive=true;
  const paint=()=>{
    if(!alive||!img.naturalWidth||!canvas.clientWidth||!canvas.clientHeight)return;
    fit=Math.min(canvas.clientWidth/img.naturalWidth,canvas.clientHeight/img.naturalHeight);
    const w=img.naturalWidth*fit*zoom,h=img.naturalHeight*fit*zoom;
    x=Math.max(-Math.max(0,(w-canvas.clientWidth)/2),Math.min(Math.max(0,(w-canvas.clientWidth)/2),x));
    y=Math.max(-Math.max(0,(h-canvas.clientHeight)/2),Math.min(Math.max(0,(h-canvas.clientHeight)/2),y));
    img.style.width=w+'px';img.style.height=h+'px';img.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`;output.value=Math.round(zoom*100)+'%';
    viewer.querySelector('[data-image-out]').disabled=zoom<=1;viewer.querySelector('[data-image-in]').disabled=zoom>=12;
  };
  const zoomAt=(next,cx=canvas.clientWidth/2,cy=canvas.clientHeight/2)=>{next=Math.max(1,Math.min(12,next));const ratio=next/zoom;x=(x-(cx-canvas.clientWidth/2))*ratio+(cx-canvas.clientWidth/2);y=(y-(cy-canvas.clientHeight/2))*ratio+(cy-canvas.clientHeight/2);zoom=next;paint();};
  canvas.addEventListener('wheel',event=>{event.preventDefault();const r=canvas.getBoundingClientRect(),delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?canvas.clientHeight:1);zoomAt(zoom*Math.exp(-Math.max(-200,Math.min(200,delta))*.002),event.clientX-r.left,event.clientY-r.top);},{passive:false});
  canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);canvas.classList.add('is-dragging');canvas.focus({preventScroll:true});event.preventDefault();});
  canvas.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;x+=event.clientX-drag.x;y+=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;paint();});
  const stop=()=>{drag=null;canvas.classList.remove('is-dragging');};for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,stop);
  const reset=()=>{zoom=1;x=0;y=0;paint();};
  canvas.addEventListener('dblclick',reset);
  canvas.addEventListener('keydown',event=>{if(!['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();if(event.key==='0')reset();else if(['+','=','-'].includes(event.key))zoomAt(zoom*(event.key==='-'?1/1.25:1.25));else{x+=event.key==='ArrowLeft'?40:event.key==='ArrowRight'?-40:0;y+=event.key==='ArrowUp'?40:event.key==='ArrowDown'?-40:0;paint();}});
  viewer.querySelector('[data-image-in]').onclick=()=>zoomAt(zoom*1.25);viewer.querySelector('[data-image-out]').onclick=()=>zoomAt(zoom/1.25);viewer.querySelector('[data-image-fit]').onclick=reset;
  img.onload=()=>{status.remove();paint();};img.onerror=()=>{status.textContent='This image could not load.';};img.src=url;
  const observer=new ResizeObserver(paint);observer.observe(canvas);
  return {serialize:()=>({zoom,x,y}),resize:paint,setVisible(value){if(value)paint();},destroy(){alive=false;observer.disconnect();img.onload=null;img.onerror=null;root.replaceChildren();}};
}
