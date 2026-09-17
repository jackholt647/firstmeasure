/* Customer-origin references for the private full-house ordering workflow. */
(() => {
 'use strict';
 const host=document.getElementById('order-references');if(!host)return;
 const slots=[['front','Front'],['back','Back'],['left','Left'],['right','Right'],['front-left','Front Left'],['front-right','Front Right'],['back-left','Back Left'],['back-right','Back Right']];
 const photos='.jpg,.jpeg,.png,.webp,.avif,.gif',videos='.mp4,.webm,.mov',items=new Map(),complete=new Set();
 let locked=false;
 let picked=null;
 const dragType='application/x-firstmeasure-reference';
 const style=document.createElement('style');style.textContent=`
 body main{max-width:1600px;margin:32px auto}
 #order-references{margin-top:28px;border-top:1px solid #dbe2e8;padding-top:16px}
 #order-references h2{font-size:22px;margin:8px 0}#order-references h3{font-size:16px;margin:0 0 12px}
 #order-references p{font-size:14px;line-height:1.5;color:#526575}
 #order-references button{font:600 13px system-ui;border:0;border-radius:8px;margin:0;cursor:pointer}
 #order-references button:disabled{opacity:.55;cursor:not-allowed}
 #order-references .reference-workspace{display:grid;grid-template-columns:minmax(0,3fr) minmax(300px,2fr);gap:28px;align-items:start}
 #order-references .reference-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
 #order-references .reference-slot{position:relative;min-width:0;border:1px dashed #aebfc9;border-radius:12px;background:#f6f9fb;overflow:hidden}
 #order-references .reference-slot.assigned{border:1px solid #87b6a3;background:#eff8f3}
 #order-references .reference-target{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;height:180px;padding:12px;color:#38596a;background:transparent}
 #order-references .reference-target img{width:100%;height:115px;object-fit:contain;min-height:0}
 #order-references .reference-target small{font-weight:400;color:#677f8c}
 #order-references .reference-clear{position:absolute;right:5px;top:5px;padding:4px 8px;background:#fff;color:#6d4247;box-shadow:0 1px 5px #0002}
 #order-references .reference-house{display:flex;flex-direction:column;justify-content:center;align-items:center;color:#29566c;background:#edf4f8;border-radius:12px;text-align:center;padding:12px}
 #order-references .reference-house svg{width:105px;max-width:75%;height:100px}#order-references .reference-house span{font-size:12px;margin-top:5px}
 #order-references .reference-bank{background:#f5f8fa;border:1px solid #dbe2e8;padding:18px;border-radius:12px;min-width:0}
 #order-references .reference-bank-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
 #order-references .reference-bank-header h3{margin:0}#order-references .reference-add{background:#1e5269;color:white;padding:10px 16px}
 #order-references .reference-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-height:650px;overflow:auto;padding:3px}
 #order-references .reference-card{border:1px solid #dbe2e8;border-radius:9px;background:white;min-width:0;overflow:hidden}
 #order-references .reference-card.picked{outline:3px solid #2386ab;outline-offset:-3px}
 #order-references .reference-photo{display:block;width:100%;padding:0;background:white;color:#233443;text-align:left}
 #order-references .reference-preview{display:block;width:100%;height:105px;object-fit:contain;background:#e8eef2}
 #order-references .reference-name{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:9px 10px 3px}
 #order-references .reference-assignment{display:block;font-size:12px;color:#367553;padding:0 10px 8px}
 #order-references .reference-remove{background:transparent;color:#7d3940;font-size:12px;padding:4px 10px 8px}
 #order-references .reference-slot.dragging,#order-references .reference-bank.dragging{outline:3px solid #2386ab;background:#e4f3fa}
 #order-references button:focus-visible{outline:3px solid #2386ab;outline-offset:-3px}
 #order-references .reference-empty{padding:35px 15px;text-align:center;border:1px dashed #b6cbd5;border-radius:8px}
 #order-references .reference-video{margin-top:22px;padding:16px;background:#f5f7f9;border-radius:10px}
 #order-references .reference-video input{max-width:100%}#order-references .reference-video button{padding:8px 12px;background:#eaf1f5;color:#294d60}
 #order-references .reference-error{color:#ad2828}#order-references [hidden]{display:none!important}
 @media(min-width:1450px){#order-references .reference-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
 @media(max-width:1000px){#order-references .reference-workspace{grid-template-columns:1fr}#order-references .reference-grid{grid-template-columns:repeat(3,minmax(0,1fr));max-height:none}}
 @media(max-width:600px){body main{padding:0 12px}body form{padding:16px}#order-references .reference-board{gap:6px}#order-references .reference-target{height:130px;padding:6px;font-size:12px}#order-references .reference-target img{height:72px}#order-references .reference-target small{font-size:10px}#order-references .reference-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#order-references .reference-bank{padding:12px}}
 `;document.head.append(style);
 host.innerHTML=`<h2>Customer references</h2><p>Drag photos from the bank into the matching house views. You can also select a photo, then click a slot.</p>
 <p class="reference-summary" aria-live="polite"></p>
 <div class="reference-workspace"><section><h3>Arrange around the house</h3><div class="reference-board"></div><p>Front entrance is at the bottom. Left and right are as seen facing the front entrance. Drop onto an occupied slot to swap views, or back into the photo bank to unassign.</p></section>
 <section class="reference-bank" aria-label="Photo bank"><div class="reference-bank-header"><h3>Photo bank</h3><button type="button" class="reference-add">Add photos</button><input id="order-reference-photos" type="file" accept="${photos}" multiple hidden></div><p>Add a batch or drop files here. Unassigned photos are saved as additional references.</p><div class="reference-grid"></div><p class="reference-empty">Drop your photos here to get started<br><small>JPG, PNG, WebP, AVIF or GIF</small></p></section></div>
 <p>Missing views won’t block a test project.</p>
 <div class="reference-video"><h3>Walkthrough video <small>· optional</small></h3><input id="order-reference-video" aria-label="Reference video" type="file" accept="${videos}"><div class="reference-video-file"></div></div><p class="reference-error" role="alert"></p>`;
 const error=host.querySelector('.reference-error'),grid=host.querySelector('.reference-grid'),input=host.querySelector('#order-reference-photos'),drop=host.querySelector('.reference-bank'),board=host.querySelector('.reference-board');
 function item(file){const id=crypto.randomUUID();return {id,file,slot:null,name:'internal-resource-v2-'+id+'-'+(file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-42)||'file'),preview:valid(file,photos)?URL.createObjectURL(file):null};}
 function valid(file,accept){return file.size>0&&accept.split(',').includes('.'+file.name.split('.').pop().toLowerCase());}
 function discard(key){const old=items.get(key);if(old?.preview)URL.revokeObjectURL(old.preview);items.delete(key);}
 function summary(){const assigned=new Set([...items.values()].map(entry=>entry.slot).filter(Boolean)),count=[...items.values()].filter(entry=>entry.preview).length;host.querySelector('.reference-summary').textContent=`${count} photos added · ${assigned.size} of 8 views assigned`+(picked?' · Photo selected — choose a view':'');host.querySelector('.reference-empty').hidden=count>0;}
 function assign(key,slot){if(locked)return;const entry=items.get(key);if(!entry?.preview)return;const displaced=slot&&[...items.values()].find(other=>other!==entry&&other.slot===slot);if(displaced)displaced.slot=entry.slot;entry.slot=slot;picked=null;render();}
 function draggable(el,entry){el.draggable=!locked;el.ondragstart=e=>{if(locked){e.preventDefault();return;}e.dataTransfer.setData(dragType,entry.id);e.dataTransfer.effectAllowed='move';};el.ondragend=()=>host.querySelectorAll('.dragging').forEach(target=>target.classList.remove('dragging'));}
 function dropTarget(el,slot){el.ondragover=e=>{if(!locked&&e.dataTransfer.types.includes(dragType)){e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';el.classList.add('dragging');}};el.ondragleave=()=>el.classList.remove('dragging');el.ondrop=e=>{if(!e.dataTransfer.types.includes(dragType))return;e.preventDefault();e.stopPropagation();el.classList.remove('dragging');assign(e.dataTransfer.getData(dragType),slot);};}
 function render(){
 board.replaceChildren();
 for(const id of ['back-left','back','back-right','left',null,'right','front-left','front','front-right']){
  if(!id){const house=document.createElement('div');house.className='reference-house';house.innerHTML='<svg viewBox="0 0 120 110" role="img" aria-label="House viewed from above, front entrance at bottom"><rect x="20" y="12" width="80" height="76" rx="5" fill="#7194a6"/><path d="M20 12L60 40L100 12M20 88L60 62L100 88M60 40V62" fill="none" stroke="#d8e8f0" stroke-width="3"/><rect x="49" y="82" width="22" height="14" rx="2" fill="#1e5269"/><path d="M60 100v8m-5-5l5 5 5-5" stroke="#1e5269" stroke-width="2" fill="none"/></svg><strong>House</strong><span>Front entrance ↓</span>';board.append(house);continue;}
  const title=slots.find(([value])=>value===id)[1],entry=[...items.values()].find(entry=>entry.slot===id),cell=document.createElement('div');cell.className='reference-slot'+(entry?' assigned':'');cell.dataset.slot=id;const target=document.createElement('button');target.type='button';target.className='reference-target';target.disabled=locked;target.setAttribute('aria-label',title+(entry?': '+entry.file.name:': empty')+'. Assign selected photo');
  const label=document.createElement('strong');label.textContent=title;target.append(label);
  if(entry){const img=document.createElement('img');img.src=entry.preview;img.alt=entry.file.name;img.draggable=false;target.append(img);draggable(target,entry);}else{const hint=document.createElement('small');hint.textContent='Drop photo here';target.append(hint);}
  target.onclick=()=>{if(locked)return;if(picked){assign(picked,id);board.querySelector('[data-slot="'+id+'"] button')?.focus();}else if(entry){picked=entry.id;render();}};cell.append(target);
  if(entry){const clear=document.createElement('button');clear.type='button';clear.className='reference-clear';clear.textContent='×';clear.setAttribute('aria-label','Unassign '+title);clear.disabled=locked;clear.onclick=()=>assign(entry.id,null);cell.append(clear);}dropTarget(cell,id);board.append(cell);
 }
 grid.replaceChildren();for(const [key,entry]of items){if(!entry.preview)continue;const card=document.createElement('div');card.className='reference-card'+(picked===key?' picked':'');card.dataset.photo=entry.file.name;const photo=document.createElement('button');photo.type='button';photo.className='reference-photo';photo.disabled=locked;photo.setAttribute('aria-label','Select '+entry.file.name);photo.setAttribute('aria-pressed',String(picked===key));draggable(photo,entry);
 const img=document.createElement('img');img.className='reference-preview';img.src=entry.preview;img.alt='';img.draggable=false;const name=document.createElement('span');name.className='reference-name';name.textContent=entry.file.name;name.title=entry.file.name;const badge=document.createElement('span');badge.className='reference-assignment';badge.textContent=slots.find(([id])=>id===entry.slot)?.[1]||'Additional photo';photo.append(img,name,badge);photo.onclick=()=>{if(locked)return;picked=picked===key?null:key;render();grid.querySelector('[data-photo='+CSS.escape(entry.file.name)+'] .reference-photo')?.focus();};
 const remove=document.createElement('button');remove.type='button';remove.className='reference-remove';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+entry.file.name);remove.disabled=locked;remove.onclick=()=>{if(locked)return;discard(key);if(picked===key)picked=null;render();};card.append(photo,remove);grid.append(card);}summary();
 }
 function addPhotos(files){if(locked)return;let rejected=0;for(const file of files){if(!valid(file,photos)){rejected++;continue;}if([...items.values()].some(entry=>entry.file.name===file.name&&entry.file.size===file.size&&entry.file.lastModified===file.lastModified))continue;const entry=item(file);items.set(entry.id,entry);}error.textContent=rejected?'Some files were skipped. Choose nonempty JPG, PNG, WebP, AVIF or GIF photos.':'';render();}
 host.querySelector('.reference-add').onclick=()=>{if(!locked)input.click();};input.onchange=()=>{addPhotos([...input.files]);input.value='';};
 dropTarget(drop,null);
 drop.addEventListener('dragover',e=>{if(!locked&&e.dataTransfer.types.includes('Files')){e.preventDefault();drop.classList.add('dragging');}});
 drop.addEventListener('drop',e=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();drop.classList.remove('dragging');addPhotos([...e.dataTransfer.files]);});
 const video=host.querySelector('#order-reference-video'),videoFile=host.querySelector('.reference-video-file');
 video.onchange=()=>{if(locked)return;const file=video.files[0];if(!file)return;if(!valid(file,videos)){error.textContent='Choose a nonempty MP4, WebM or MOV video.';video.value='';return;}error.textContent='';discard('video');const entry=item(file);items.set('video',entry);videoFile.replaceChildren();const name=document.createElement('p');name.textContent=file.name;const remove=document.createElement('button');remove.type='button';remove.textContent='Remove video';remove.onclick=()=>{if(locked)return;discard('video');video.value='';videoFile.replaceChildren();};videoFile.append(name,remove);};
 render();
 async function post(project,name,body,csrf,extra={}){const response=await fetch('project_resources.php?'+new URLSearchParams({project,name}),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Resource-Request':'1','X-Resource-Origin':'customer-order','X-Full-House-CSRF':csrf,...extra},body});const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Reference upload failed ('+response.status+').');return data;}
 window.FullHouseReferences={lock(value){locked=value;picked=null;render();for(const el of host.querySelectorAll('input,button,select'))el.disabled=value;},async upload(project,csrf,status){
 const chunkSize=8*1024*1024,entries=[...items.values()];for(let i=0;i<entries.length;i++){const entry=entries[i];if(complete.has(entry.id))continue;const {file,id,name,slot}=entry,parts=Math.ceil(file.size/chunkSize),sha256=[];
 for(let part=0;part<parts;part++){status('Uploading '+file.name+' Â· '+(i+1)+' of '+entries.length+' Â· '+Math.floor(part/parts*100)+'%');const chunk=file.slice(part*chunkSize,Math.min(file.size,(part+1)*chunkSize)),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await chunk.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');sha256.push(digest);const result=await post(project,'internal-markup-part-'+id+'-'+String(part).padStart(8,'0')+'.bin',chunk,csrf,{'X-Resource-SHA256':digest});if(result.sha256!==digest)throw Error('Could not verify '+file.name+'. Retry the upload.');}
 await post(project,name,JSON.stringify({format:'firstmeasure-resource-chunks-v1',id,size:file.size,chunkSize,parts,sha256,original_name:file.name,content_type:file.type,...(slot?{elevation_view:slot}:{})}),csrf);complete.add(id);
 }status('References saved. Opening editorâ€¦');}};
})();
