/* House-relative elevation assignments are saved with the project's PDF settings. */
const reportImageCatalogCache=new WeakMap();
async function prepareReportImageryConfig(state,refresh=false){
 const metadata=window.currentProjectLoadedAppMetadata?.pdfConfig?.exteriorSettings;
 if(String(state.folderId)===String(window.currentProjectId)&&Number(metadata?.photoSettingsUpdatedAt)>Number(state.exteriorSettings?.photoSettingsUpdatedAt||0))Object.assign(state.exteriorSettings||={},JSON.parse(JSON.stringify(metadata)));
 const settings=state.exteriorSettings||={};
 window.ExteriorPDF.initializePhotoSlots(settings);
 if(!refresh&&reportImageCatalogCache.has(state))return reportImageCatalogCache.get(state);
 const files=await window.ProjectResources.reportImages(state.folderId);reportImageCatalogCache.set(state,files);window.ExteriorPDF.initializePhotoSlots(settings,files);
 for(const entry of Object.values(settings.photoSlots)){if(entry.image)entry.image.unavailable=!entry.image.dataUrl&&!files.some(f=>f.key===entry.image.key||f.resourceName&&f.resourceName===entry.image.resourceName||f.url&&f.url===entry.image.url);}
 return files;
}
function touchElevationSettings(settings){settings.photoSettingsUpdatedAt=Date.now();}
function renderHouseOrientation(container,state){
 const PDF=window.ExteriorPDF,settings=state.exteriorSettings||={},card=document.createElement('section');card.style.cssText='border:1px solid #dce3eb;background:#f7f9fc;border-radius:12px;padding:16px;margin:12px 0 20px';container.appendChild(card);
 const title=document.createElement('h3');title.textContent='House orientation';title.style.margin='0 0 6px';card.appendChild(title);
 const hint=document.createElement('p');hint.textContent='Set the front entrance side. Left and right are as seen while standing outside facing the front door.';hint.style.cssText='font-size:12px;color:#586779;margin:0 0 10px';card.appendChild(hint);
 const picture=document.createElement('div');picture.style.cssText='max-width:490px;margin:auto';card.appendChild(picture);
 const row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap';card.appendChild(row);
 const label=document.createElement('label');label.textContent='Front bearing ';const input=document.createElement('input');input.type='number';input.min=0;input.max=359;input.step=1;input.value=Math.round(PDF.frontBearing(settings));input.setAttribute('aria-label','Front bearing in degrees clockwise from north');input.style.cssText='width:65px;padding:6px';label.append(input,document.createTextNode('°'));row.appendChild(label);
 const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=359;slider.value=input.value;slider.style.cssText='flex:1;min-width:130px';slider.setAttribute('aria-label','Rotate front direction');row.appendChild(slider);
 const confirm=document.createElement('button');confirm.type='button';confirm.textContent='Set front';confirm.style.cssText='padding:7px 10px';confirm.onclick=()=>set(input.value);row.appendChild(confirm);
 const walls=document.createElement('select');walls.setAttribute('aria-label','Choose the front wall');walls.style.cssText='max-width:100%;padding:7px';const placeholder=document.createElement('option');placeholder.textContent='Or choose the front wall…';placeholder.value='';walls.appendChild(placeholder);
 for(const wall of state.exteriorReport?.walls||[]){if(/trim/i.test(wall.material))continue;const option=document.createElement('option');option.value=wall.id;option.textContent=wall.id+' — '+wall.material;walls.appendChild(option);}row.appendChild(walls);
 const status=document.createElement('small');status.style.cssText='display:block;margin-top:8px;color:#586779';card.appendChild(status);
 function draw(){
  const shapes=PDF.planShapes(state.exteriorReport),all=shapes.flat(),minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y)),scale=108/Math.max(maxX-minX,maxY-minY,.01),a=PDF.frontBearing(settings)*Math.PI/180;
  const marker=(offset,name,color)=>{const angle=a+offset*Math.PI/180,x=142+Math.sin(angle)*87,y=116-Math.cos(angle)*87;return `<text x="${x}" y="${y+4}" text-anchor="middle" font-size="12" font-weight="600" fill="${color}">${name}</text>`;};
  picture.innerHTML=`<svg viewBox="0 0 440 225" role="img" aria-label="House footprint with front and back markers and a north-up compass"><defs><marker id="frontArrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto"><path d="M0 0 L5 3 L0 6Z" fill="#d22e40"/></marker></defs><circle cx="142" cy="116" r="70" fill="white" stroke="#dce3eb" stroke-dasharray="3 4"/>${shapes.map(ps=>`<polygon points="${ps.map(p=>`${142+(p.x-(minX+maxX)/2)*scale},${116+(p.y-(minY+maxY)/2)*scale}`).join(' ')}" fill="#b8c9d8" stroke="#6c8396" stroke-width="1.3"/>`).join('')}<line x1="${142+Math.sin(a)*43}" y1="${116-Math.cos(a)*43}" x2="${142+Math.sin(a)*70}" y2="${116-Math.cos(a)*70}" stroke="#d22e40" stroke-width="3" marker-end="url(#frontArrow)"/>${marker(0,'Front','#bd2135')}${marker(180,'Back','#516375')}<g transform="translate(338 116)"><circle r="47" fill="white" stroke="#dce3eb"/><path d="M0 -32 L0 32 M-32 0 L32 0" stroke="#7b8c9d" stroke-width="1.5"/><path d="M0 -37 L-5 -24 L5 -24Z" fill="#d22e40"/><text y="-53" text-anchor="middle" fill="#bd2135" font-size="14" font-weight="700">N</text><text y="64" text-anchor="middle" fill="#516375" font-size="12">S</text><text x="-59" y="4" text-anchor="middle" fill="#516375" font-size="12">W</text><text x="59" y="4" text-anchor="middle" fill="#516375" font-size="12">E</text></g></svg>`;
  status.textContent=Number.isFinite(settings.frontBearing)?'Front faces '+Math.round(PDF.frontBearing(settings))+'° clockwise from north.':'Choose the front wall or set its bearing. The diagram is north-up.';
 }
 const set=value=>{if(!Number.isFinite(Number(value)))return;settings.frontBearing=((Number(value)%360)+360)%360;input.value=slider.value=Math.round(settings.frontBearing);touchElevationSettings(settings);draw();card.dispatchEvent(new CustomEvent('house-orientation-change',{bubbles:true}));};input.onchange=()=>set(input.value);slider.oninput=()=>set(slider.value);walls.onchange=()=>{const wall=state.exteriorReport?.walls.find(w=>w.id===walls.value);if(wall)set(Math.atan2(wall.normal.x,-wall.normal.y)*180/Math.PI);};draw();
}
function renderExteriorReportConfig(container,state){
 const m=state.exteriorReport,s=state.exteriorSettings||={};container.style.padding='24px';
 const heading=document.createElement('h2');heading.textContent='Exterior report';container.appendChild(heading);
 const summary=document.createElement('p');summary.textContent=`${m.walls.length} wall regions / ${m.openings.length} openings / ${m.totals.net.toFixed(1)} sq ft net. Eight house-relative elevations, wall and trim dimensions, opening schedule, quantities and allowances.`;container.appendChild(summary);
 const toggle=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=s.include!==false;input.onchange=()=>{s.include=input.checked;};toggle.append(input,document.createTextNode(' Include exterior pages in full PDF'));container.appendChild(toggle);
 renderHouseOrientation(container,state);
 const table=document.createElement('table');table.style.cssText='width:100%;font-size:12px;border-collapse:collapse';const head=table.insertRow();['Wall','Side','Net sq ft','Material'].forEach(t=>{const th=document.createElement('th');th.textContent=t;th.style.textAlign='left';head.appendChild(th);});
 m.walls.forEach(w=>{const row=table.insertRow();[w.id+(w.chimney?' (chimney)':''),window.ExteriorPDF.relativeSide(w.normal,s),w.net.toFixed(1),w.material||'Unassigned'].forEach(t=>row.insertCell().textContent=t);});container.appendChild(table);
 container.addEventListener('house-orientation-change',()=>{m.walls.forEach((w,i)=>{table.rows[i+1].cells[1].textContent=window.ExteriorPDF.relativeSide(w.normal,s);});});
 const notes=document.createElement('textarea');notes.placeholder='Wall / structure notes. Use wall IDs (for example W01) to reference the diagrams.';notes.setAttribute('aria-label','Wall and structure notes');notes.maxLength=1600;notes.value=s.notes||'';notes.style.cssText='width:100%;min-height:80px;margin-top:16px';notes.oninput=()=>{s.notes=notes.value;};container.appendChild(notes);
}
async function renderReportImageryConfig(container,state){
 const settings=state.exteriorSettings||={};container.style.padding='24px';const heading=document.createElement('h2');heading.textContent='Elevation photos';container.appendChild(heading);
 const hint=document.createElement('p');hint.textContent='Assign one photo to each standard view. Customer assignments fill these slots automatically. Front, Back, Left and Right are included by default; add corner views when available. Missing photos do not prevent you from continuing.';container.appendChild(hint);
 renderHouseOrientation(container,state);
 const status=document.createElement('p');container.appendChild(status);let files;
 try{files=await prepareReportImageryConfig(state);}catch(error){status.textContent='Could not load Resources: '+error.message;const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=async()=>{await prepareReportImageryConfig(state,true).catch(()=>{});container.replaceChildren();renderReportImageryConfig(container,state);};container.appendChild(retry);return;}
 const update=()=>{const selected=window.ExteriorPDF.selectedPhotos(settings),missing=selected.filter(s=>s.missing).length;status.textContent=`${selected.length-missing} of ${selected.length} included views assigned`+(missing?' — you can continue and fill the remaining views later.':' — this step will be under Settings next time.');};update();
 const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px';container.appendChild(grid);
 for(const slot of window.ExteriorPDF.photoSlots){
  const entry=settings.photoSlots[slot.id],card=document.createElement('section');card.dataset.elevationSlot=slot.id;card.style.cssText='border:1px solid #d7dce4;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px';grid.appendChild(card);
  const header=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=entry.enabled;header.style.fontWeight='600';header.append(check,document.createTextNode(' '+slot.name));card.appendChild(header);
  const image=document.createElement('img');image.style.cssText='width:100%;height:140px;object-fit:contain;background:#f4f6f8';image.alt=slot.name+' elevation photo';card.appendChild(image);
  const empty=document.createElement('div');empty.textContent='No photo assigned';empty.style.cssText='height:140px;display:grid;place-items:center;background:#f4f6f8;color:#718096';card.appendChild(empty);
  const select=document.createElement('select');select.setAttribute('aria-label','Photo for '+slot.name);select.style.cssText='width:100%;padding:8px;border:1px solid #cbd1d9;border-radius:5px';const none=document.createElement('option');none.textContent='Choose a photo…';none.value='';select.appendChild(none);
  const choices=[...files];if(entry.image&&!choices.some(f=>f.key===entry.image.key))choices.push({...entry.image,unavailable:true});
  for(const role of ['customer','tech','qa']){const group=document.createElement('optgroup');group.label=({customer:'Customer photos',tech:'Tech references',qa:'QA references'})[role];for(const file of choices.filter(f=>(f.role||'tech')===role)){const option=document.createElement('option');option.value=file.key;option.textContent=file.label+(file.unavailable?' (unavailable)':'');group.appendChild(option);}if(group.children.length)select.appendChild(group);}select.value=entry.image?.key||'';card.appendChild(select);
  const origin=document.createElement('small');card.appendChild(origin);
  const preview=()=>{const file=choices.find(f=>f.key===entry.image?.key);image.hidden=!file;empty.style.display=file?'none':'grid';if(file)image.src=file.dataUrl||file.url||('project_resources.php?'+new URLSearchParams({project:state.folderId,name:file.resourceName}));origin.textContent=file?({customer:'Customer photo',tech:'Tech reference',qa:'QA reference'}[file.role]||'Tech reference')+(file.frame?' / Saved video frame':''):'';};preview();
  check.onchange=()=>{entry.enabled=check.checked;entry.assignment='manual';touchElevationSettings(settings);update();};
  select.onchange=()=>{const file=choices.find(f=>f.key===select.value);entry.assignment='manual';entry.image=file?{key:file.key,resourceName:file.resourceName,url:file.resourceName?undefined:file.url,label:file.label,role:file.role,frame:file.frame}:null;if(file){entry.enabled=true;check.checked=true;}touchElevationSettings(settings);preview();update();};
 }
}
