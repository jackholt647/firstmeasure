/* Project photo presentation; all metadata reads retain the host's authorization. */
import {mount as mountImage} from './image-viewer.js?v=20261010-interactive';
export function mount(root,{context={},initialState={}}={}){
 if(!document.getElementById('fm-photo-gallery-style')){
  const style=document.createElement('style');style.id='fm-photo-gallery-style';
  style.textContent=`.fm-photo-gallery{position:absolute;inset:0;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) 7px var(--photo-tray-height,116px);overflow:hidden;min-height:0;background:#eef1f5}.fm-photo-stage{position:relative;min-width:0;min-height:0;overflow:hidden}.fm-photo-stage>.fm-image-viewer{height:100%;min-height:0}.fm-photo-empty{position:absolute;inset:0;display:grid;place-items:center;font-size:12px;color:#667085;padding:12px;text-align:center}.fm-photo-divider{cursor:row-resize;touch-action:none;background:#f8fafc;display:grid;place-items:center;border-top:1px solid #d0d5dd;border-bottom:1px solid #d0d5dd;outline-offset:-2px}.fm-photo-divider:after{content:'';height:2px;width:36px;background:#98a2b3;border-radius:1px}.fm-photo-divider:hover:after,.fm-photo-divider:focus-visible:after{background:var(--primary,#344054)}.fm-photo-thumbnails{display:flex;gap:8px;padding:6px;overflow-x:auto;overflow-y:hidden;min-width:0;min-height:0;align-items:stretch;background:#f8fafc;scrollbar-width:thin}.fm-photo-thumbnails.is-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));grid-auto-rows:96px;align-content:start;overflow-y:auto;overflow-x:hidden}.fm-photo-thumb{flex:0 0 136px;min-width:0;padding:0;display:flex;flex-direction:column;border:2px solid transparent;border-radius:4px;overflow:hidden;background:#e4e7ec;cursor:pointer;color:#344054;font:inherit}.fm-photo-thumb[aria-pressed=true]{border-color:var(--primary,#344054)}.fm-photo-thumb:focus-visible{outline:2px solid var(--primary,#344054);outline-offset:-2px}.fm-photo-thumb img{display:block;width:100%;flex:1;min-height:0;object-fit:cover}.fm-photo-thumb span{display:block;padding:3px 5px;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:#fff;flex:none}`;
  document.head.append(style);
 }
 root.innerHTML='<div class="fm-photo-gallery"><div class="fm-photo-stage"><div class="fm-photo-empty" role="status">Loading photos…</div></div><div class="fm-photo-divider" role="separator" aria-orientation="horizontal" aria-label="Resize photo thumbnails" tabindex="0"></div><div class="fm-photo-thumbnails" role="group" aria-label="Project photos"></div></div>';
 const gallery=root.firstElementChild,stage=gallery.querySelector('.fm-photo-stage'),divider=gallery.querySelector('.fm-photo-divider'),tray=gallery.querySelector('.fm-photo-thumbnails');
 let alive=true,visible=true,items=[],selected=null,viewer=null,drag=null,preferredHeight=Number(initialState.trayHeight)||116;
 const states={...initialState.images};
 const maximum=()=>Math.max(60,Math.min(gallery.clientHeight*.7,gallery.clientHeight-107));
 const resize=()=>{if(!alive||!gallery.clientHeight)return;const height=Math.max(60,Math.min(maximum(),preferredHeight));gallery.style.setProperty('--photo-tray-height',height+'px');tray.classList.toggle('is-grid',height>=210);divider.setAttribute('aria-valuenow',String(Math.round(height)));divider.setAttribute('aria-valuemin','60');divider.setAttribute('aria-valuemax',String(Math.round(maximum())));viewer?.resize?.();};
 const setHeight=height=>{preferredHeight=Math.max(60,Math.min(maximum(),height));resize();};
 divider.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={id:event.pointerId,y:event.clientY,height:parseFloat(gallery.style.getPropertyValue('--photo-tray-height'))||116};divider.setPointerCapture(event.pointerId);event.preventDefault();});
 divider.addEventListener('pointermove',event=>{if(drag?.id===event.pointerId)setHeight(drag.height+drag.y-event.clientY);});
 for(const name of ['pointerup','pointercancel','lostpointercapture'])divider.addEventListener(name,()=>{drag=null;});
 divider.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();setHeight(event.key==='Home'?116:event.key==='End'?maximum():preferredHeight+(event.key==='ArrowUp'?20:-20));});
 function select(item){
  if(!alive||selected===item.id)return;
  if(viewer&&selected)states[selected]=viewer.serialize();viewer?.destroy();selected=item.id;
  viewer=mountImage(stage,{url:item.url,alt:item.label,initialState:states[selected]||{}});viewer.setVisible(visible);
  for(const button of tray.children)button.setAttribute('aria-pressed',String(button.dataset.photoId===selected));
 }
 const safeUrl=value=>{try{const url=String(value||'');if(/^data:image\/(jpeg|png|webp);base64,/i.test(url))return url;const parsed=new URL(url,location.href);return url&&['http:','https:'].includes(parsed.protocol)&&parsed.origin===location.origin?parsed.href:null;}catch{return null;}};
 const target=context.target||{},orgId=target.organizationId,projectId=target.projectId;
 async function reportData(){
  if(context.data&&Object.hasOwn(context.data,'reports.photo'))return context.data['reports.photo'];
  if(!orgId||!projectId)return {};
  const read=context.read||((source,target)=>window.PlatformAPI.publication.read(orgId,{...source,target}));
  const result=await read({provider:'project-widgets',export:'report'},target);
  return result.status==='ready'?result.value:{};
 }
 async function photoData(){
  if(Array.isArray(context.photos))return context.photos;
  if(!orgId||!projectId||!window.PlatformAPI?.media)return [];
  const result=await window.PlatformAPI.media.list(orgId,{projectId});return Array.isArray(result?.media)?result.media:[];
 }
 const ready=Promise.allSettled([reportData(),photoData()]).then(results=>{
  if(!alive)return;
  const report=results[0].status==='fulfilled'?results[0].value:{},photos=results[1].status==='fulfilled'?results[1].value:[];
  const candidates=(report?.media||[]).filter(row=>!row.video).map((row,index)=>({id:'report:'+index,url:row.url,thumbnail:row.url,label:row.label||'Report photo',aerial:row.label==='Aerial view'}));
  for(const row of photos){
   const kind=String(row.kind||row.media_type||row.type||'').toLowerCase(),mime=String(row.content_type||row.mime_type||'').toLowerCase();
   if(kind!=='image'&&!mime.startsWith('image/'))continue;
   const id=row.media_id||row.mediaId||row.id;
   candidates.push({id:'photo:'+id,url:row.url||(id&&orgId?window.PlatformAPI?.media.fileUrl(orgId,id,'original'):null),thumbnail:row.thumbnail_url||(id&&orgId?window.PlatformAPI?.media.thumbnailUrl(orgId,id,320):row.url),label:row.name||row.filename||row.original_filename||'Project photo'});
  }
  const seen=new Set();items=candidates.sort((a,b)=>Number(!!b.aerial)-Number(!!a.aerial)).filter(item=>{item.url=safeUrl(item.url);item.thumbnail=safeUrl(item.thumbnail)||item.url;if(!item.url||seen.has(item.url))return false;seen.add(item.url);return true;});
  for(const item of items){const button=document.createElement('button');button.type='button';button.className='fm-photo-thumb';button.dataset.photoId=item.id;button.title=item.label;button.setAttribute('aria-label',item.label);button.setAttribute('aria-pressed','false');const image=document.createElement('img');image.src=item.thumbnail;image.alt='';image.loading='lazy';const label=document.createElement('span');label.textContent=item.label;button.append(image,label);button.onclick=()=>select(item);tray.append(button);}
  if(items.length)select(items.find(item=>item.id===initialState.selected)||items[0]);
  else stage.firstElementChild.textContent=results.some(result=>result.status==='rejected')?'Photos could not load.':'No project photos yet.';
  resize();
 });
 const observer=new ResizeObserver(resize);observer.observe(gallery);resize();
 return {ready,serialize(){if(viewer&&selected)states[selected]=viewer.serialize();return {selected,trayHeight:preferredHeight,images:{...states}};},setVisible(value){visible=value;viewer?.setVisible(value);if(value)resize();},destroy(){alive=false;observer.disconnect();viewer?.destroy();root.replaceChildren();}};
}
