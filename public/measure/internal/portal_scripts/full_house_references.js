/* Customer-origin references for the private full-house ordering workflow. */
(() => {
 'use strict';
 const host=document.getElementById('order-references');if(!host)return;
 const slots=[['front','Front'],['back','Back'],['left','Left'],['right','Right'],['front-left','Front Left'],['front-right','Front Right'],['back-left','Back Left'],['back-right','Back Right']];
 const photos='.jpg,.jpeg,.png,.webp,.avif,.gif',videos='.mp4,.webm,.mov',items=new Map(),complete=new Set();
 let locked=false;
 const style=document.createElement('style');style.textContent=`
 #order-references{margin-top:28px;border-top:1px solid #dbe2e8;padding-top:16px}
 #order-references h2{font-size:21px;margin:8px 0}#order-references p{font-size:14px;line-height:1.5;color:#526575}
 #order-references .reference-drop{border:2px dashed #b6cbd5;background:#f5fafc;border-radius:12px;padding:24px;text-align:center;transition:background .15s}
 #order-references .reference-drop.dragging{background:#e0f3fa;border-color:#1e5269}
 #order-references button{display:inline-block;font:600 13px system-ui;border:0;border-radius:7px;padding:9px 13px;margin:0;background:#eaf1f5;color:#294d60;cursor:pointer}
 #order-references .reference-add{background:#1e5269;color:white;padding:11px 20px}
 #order-references button:disabled,#order-references select:disabled{opacity:.55;cursor:not-allowed}
 #order-references .reference-views{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 18px}
 #order-references .reference-view{font-size:12px;border-radius:20px;padding:5px 9px;background:#f1f3f5;color:#526575}
 #order-references .reference-view.assigned{background:#e0f2e9;color:#236746}
 #order-references .reference-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
 #order-references .reference-card{border:1px solid #dbe2e8;border-radius:10px;overflow:hidden;background:white;min-width:0}
 #order-references .reference-preview{display:block;width:100%;height:140px;object-fit:contain;background:#edf2f5}
 #order-references .reference-info{padding:12px}#order-references .reference-name{font-size:13px;font-weight:600;overflow-wrap:anywhere;margin-bottom:10px}
 #order-references .reference-info label{display:block;font-size:12px;color:#526575;margin-bottom:5px}
 #order-references select{box-sizing:border-box;width:100%;font:14px system-ui;border:1px solid #b6cbd5;border-radius:6px;padding:8px;background:white;color:#233443}
 #order-references .reference-remove{font-size:12px;background:transparent;margin-top:8px;padding:4px 0;color:#7d3940}
 #order-references .reference-video{margin-top:22px;padding:16px;background:#f5f7f9;border-radius:10px}
 #order-references .reference-video h3{font-size:15px;margin:0 0 8px}#order-references .reference-video input{max-width:100%}
 #order-references .reference-error{color:#ad2828}#order-references [hidden]{display:none!important}
 @media(max-width:640px){#order-references .reference-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
 @media(max-width:380px){#order-references .reference-grid{grid-template-columns:1fr}}
 `;document.head.append(style);
 host.innerHTML=`<h2>Customer references</h2><p>Add your photos together, then assign the eight house views. Anything left unassigned is saved as an additional reference.</p>
 <div class="reference-drop"><button type="button" class="reference-add">Add photos</button><input id="order-reference-photos" type="file" accept="${photos}" multiple hidden><p>Choose a batch or drag photos here<br><small>JPG, PNG, WebP, AVIF or GIF</small></p></div>
 <p class="reference-summary" aria-live="polite"></p><div class="reference-views"></div><div class="reference-grid"></div>
 <p>Left and right are as seen standing outside facing the front entrance. Choosing an occupied view swaps the assignments. Missing views won’t block a test project.</p>
 <div class="reference-video"><h3>Walkthrough video <small>· optional</small></h3><input id="order-reference-video" aria-label="Reference video" type="file" accept="${videos}"><div class="reference-video-file"></div></div><p class="reference-error" role="alert"></p>`;
 const error=host.querySelector('.reference-error'),grid=host.querySelector('.reference-grid'),input=host.querySelector('#order-reference-photos'),drop=host.querySelector('.reference-drop');
 function item(file){const id=crypto.randomUUID();return {id,file,slot:null,name:'internal-resource-v2-'+id+'-'+(file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-42)||'file'),preview:valid(file,photos)?URL.createObjectURL(file):null};}
 function valid(file,accept){return file.size>0&&accept.split(',').includes('.'+file.name.split('.').pop().toLowerCase());}
 function discard(key){const old=items.get(key);if(old?.preview)URL.revokeObjectURL(old.preview);items.delete(key);}
 function summary(){const assigned=new Set([...items.values()].map(entry=>entry.slot).filter(Boolean)),count=[...items.values()].filter(entry=>entry.preview).length;host.querySelector('.reference-summary').textContent=`${count} photo${count===1?'':'s'} added · ${assigned.size} of 8 views assigned`;const views=host.querySelector('.reference-views');views.replaceChildren();for(const [id,title]of slots){const badge=document.createElement('span');badge.className='reference-view'+(assigned.has(id)?' assigned':'');badge.textContent=(assigned.has(id)?'✓ ':'')+title;views.append(badge);}}
 function render(){grid.replaceChildren();for(const [key,entry]of items){if(!entry.preview)continue;const card=document.createElement('div');card.className='reference-card';const img=document.createElement('img');img.className='reference-preview';img.src=entry.preview;img.alt=entry.file.name;const info=document.createElement('div');info.className='reference-info';const name=document.createElement('div');name.className='reference-name';name.textContent=entry.file.name;const label=document.createElement('label');label.htmlFor='view-'+entry.id;label.textContent='House view';const select=document.createElement('select');select.id=label.htmlFor;select.setAttribute('aria-label','House view for '+entry.file.name);select.append(new Option('Additional photo',''));for(const [id,title]of slots)select.append(new Option(title,id));select.value=entry.slot||'';select.disabled=locked;
 select.onchange=()=>{if(locked)return;const displaced=[...items.values()].find(other=>other!==entry&&other.slot&&other.slot===select.value);if(displaced)displaced.slot=entry.slot;entry.slot=select.value||null;render();document.getElementById(select.id)?.focus();};
 const remove=document.createElement('button');remove.type='button';remove.className='reference-remove';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+entry.file.name);remove.disabled=locked;remove.onclick=()=>{if(locked)return;discard(key);render();};info.append(name,label,select,remove);card.append(img,info);grid.append(card);}summary();}
 function addPhotos(files){if(locked)return;let rejected=0;for(const file of files){if(!valid(file,photos)){rejected++;continue;}if([...items.values()].some(entry=>entry.file.name===file.name&&entry.file.size===file.size&&entry.file.lastModified===file.lastModified))continue;const entry=item(file);items.set(entry.id,entry);}error.textContent=rejected?'Some files were skipped. Choose nonempty JPG, PNG, WebP, AVIF or GIF photos.':'';render();}
 host.querySelector('.reference-add').onclick=()=>{if(!locked)input.click();};input.onchange=()=>{addPhotos([...input.files]);input.value='';};
 for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();if(!locked)drop.classList.add('dragging');});
 drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragging');addPhotos([...e.dataTransfer.files]);});
 const video=host.querySelector('#order-reference-video'),videoFile=host.querySelector('.reference-video-file');
 video.onchange=()=>{if(locked)return;const file=video.files[0];if(!file)return;if(!valid(file,videos)){error.textContent='Choose a nonempty MP4, WebM or MOV video.';video.value='';return;}error.textContent='';discard('video');const entry=item(file);items.set('video',entry);videoFile.replaceChildren();const name=document.createElement('p');name.textContent=file.name;const remove=document.createElement('button');remove.type='button';remove.textContent='Remove video';remove.onclick=()=>{if(locked)return;discard('video');video.value='';videoFile.replaceChildren();};videoFile.append(name,remove);};
 render();
 async function post(project,name,body,csrf,extra={}){const response=await fetch('project_resources.php?'+new URLSearchParams({project,name}),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Resource-Request':'1','X-Resource-Origin':'customer-order','X-Full-House-CSRF':csrf,...extra},body});const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Reference upload failed ('+response.status+').');return data;}
 window.FullHouseReferences={lock(value){locked=value;for(const el of host.querySelectorAll('input,button,select'))el.disabled=value;},async upload(project,csrf,status){
 const chunkSize=8*1024*1024,entries=[...items.values()];for(let i=0;i<entries.length;i++){const entry=entries[i];if(complete.has(entry.id))continue;const {file,id,name,slot}=entry,parts=Math.ceil(file.size/chunkSize),sha256=[];
 for(let part=0;part<parts;part++){status('Uploading '+file.name+' Â· '+(i+1)+' of '+entries.length+' Â· '+Math.floor(part/parts*100)+'%');const chunk=file.slice(part*chunkSize,Math.min(file.size,(part+1)*chunkSize)),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await chunk.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');sha256.push(digest);const result=await post(project,'internal-markup-part-'+id+'-'+String(part).padStart(8,'0')+'.bin',chunk,csrf,{'X-Resource-SHA256':digest});if(result.sha256!==digest)throw Error('Could not verify '+file.name+'. Retry the upload.');}
 await post(project,name,JSON.stringify({format:'firstmeasure-resource-chunks-v1',id,size:file.size,chunkSize,parts,sha256,original_name:file.name,content_type:file.type,...(slot?{elevation_view:slot}:{})}),csrf);complete.add(id);
 }status('References saved. Opening editorâ€¦');}};
})();
