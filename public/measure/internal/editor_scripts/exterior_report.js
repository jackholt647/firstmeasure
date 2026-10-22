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
/* House orientation: the north-up footprint inside a dial. Dragging anywhere on the dial (or the
 slider, the number or the arrow keys) turns the front. While dragging only the arrow, bar and labels
 move, once per animation frame; the bearing is saved and 'house-orientation-change' fires on
 release. Near a dominant wall direction (within 3 degrees) the drag snaps to it; Shift turns the
 snap off, and the number field takes any angle. */
const bearingOf=v=>{const n=Number(v);return n>=0&&n<360?n:((n%360)+360)%360;};
function orientationSnaps(report,count=8){
 const byKey=new Map();for(const wall of report?.walls||[]){const n=wall.normal;if(!n||Math.hypot(n.x,n.y)<.5)continue;const b=bearingOf(Math.atan2(n.x,-n.y)*180/Math.PI),key=Math.round(b)%360,entry=byKey.get(key)||{bearing:b,weight:0};entry.weight+=wall.gross||1;byKey.set(key,entry);}
 return [...byKey.values()].sort((a,b)=>b.weight-a.weight).slice(0,count).map(e=>e.bearing);
}
function snapBearing(value,snaps,tolerance=3){const d=a=>Math.abs(((value-a+540)%360)-180);let best=null;for(const a of snaps||[])if(best===null||d(a)<d(best))best=a;return best!==null&&d(best)<=tolerance?best:bearingOf(value);}
let houseOrientationCount=0;
function renderHouseOrientation(container,state,{fill=false}={}){
 const PDF=window.ExteriorPDF,settings=state.exteriorSettings||={},card=document.createElement('section');card.dataset.houseOrientation='';card.style.cssText='border:1px solid #dce3eb;background:#f7f9fc;border-radius:12px;padding:16px;margin:12px 0 20px'+(fill?';display:flex;flex-direction:column;flex:1 1 auto;min-height:0;margin:0':'');container.appendChild(card);
 const title=document.createElement('h3');title.textContent='House orientation';title.style.margin='0 0 6px';card.appendChild(title);
 const hint=document.createElement('p');hint.textContent='Drag the dial or the slider to turn the front of the house. Left and right are as seen while standing outside facing the front door. Hold Shift while dragging to turn off snapping to the walls.';hint.style.cssText='font-size:12px;color:#586779;margin:0 0 10px';card.appendChild(hint);
 const C=200,R=164,id='hoArrow'+(++houseOrientationCount),shapes=PDF.planShapes(state.exteriorReport),all=shapes.flat(),minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y)),scale=R*.95/Math.max(maxX-minX,maxY-minY,.01);
 const at=p=>({x:C+(p.x-(minX+maxX)/2)*scale,y:C+(p.y-(minY+maxY)/2)*scale}),pts=all.map(at),snaps=orientationSnaps(state.exteriorReport);
 const picture=document.createElement('div');picture.style.cssText=fill?'flex:1 1 auto;min-height:240px;display:flex;align-items:center;justify-content:center':'max-width:420px;margin:auto';card.appendChild(picture);
 const compass=[['N',0,'#bd2135'],['E',90,'#7b8c9d'],['S',180,'#7b8c9d'],['W',270,'#7b8c9d']].map(([t,b,c])=>`<text x="${C+Math.sin(b*Math.PI/180)*(R-14)}" y="${C-Math.cos(b*Math.PI/180)*(R-14)+5}" text-anchor="middle" font-size="14" font-weight="700" fill="${c}">${t}</text>`).join('');
 picture.innerHTML=`<svg data-orientation-dial viewBox="-58 -4 516 408" tabindex="0" role="slider" aria-label="Front of the house: drag to rotate" aria-valuemin="0" aria-valuemax="359" style="width:100%;height:${fill?'100%':'auto'};max-height:${fill?'min(62vh,640px)':'none'};touch-action:none;cursor:grab;user-select:none;outline:none"><defs><marker id="${id}" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto"><path d="M0 0 L5 3 L0 6Z" fill="#d22e40"/></marker></defs><circle cx="${C}" cy="${C}" r="${R}" fill="white" stroke="#dce3eb" stroke-width="2"/>${compass}${shapes.map(ps=>`<polygon points="${ps.map(p=>{const q=at(p);return q.x+','+q.y;}).join(' ')}" fill="#b8c9d8" stroke="#6c8396" stroke-width="1.3"/>`).join('')}<line data-front-bar stroke="#d22e40" stroke-width="6" stroke-linecap="round"/><line data-front-arrow stroke="#d22e40" stroke-width="3.5" marker-end="url(#${id})"/><circle data-front-knob r="10" fill="#d22e40" stroke="white" stroke-width="3"/>${['front','back','left','right'].map(k=>`<text data-side="${k}" text-anchor="middle" font-size="${k==='front'?18:15}" font-weight="${k==='front'?800:600}" fill="${k==='front'?'#bd2135':'#516375'}">${k[0].toUpperCase()+k.slice(1)}</text>`).join('')}</svg>`;
 const svg=picture.firstElementChild,q=s=>svg.querySelector(s),bar=q('[data-front-bar]'),arrow=q('[data-front-arrow]'),knob=q('[data-front-knob]'),sides=Object.fromEntries(['front','back','left','right'].map(k=>[k,q(`[data-side="${k}"]`)]));
 const row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px';card.appendChild(row);
 const label=document.createElement('label');label.textContent='Front bearing ';const input=document.createElement('input');input.type='number';input.min=0;input.max=359.9;input.step='any';input.setAttribute('aria-label','Front bearing in degrees clockwise from north');input.style.cssText='width:70px;padding:6px';label.append(input,document.createTextNode('°'));row.appendChild(label);
 const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=359.9;slider.step=.1;slider.style.cssText='flex:1;min-width:140px';slider.setAttribute('aria-label','Rotate front direction');row.appendChild(slider);
 const status=document.createElement('div');status.dataset.frontReadout='';status.style.cssText='margin-top:8px;color:#2c333c;font-size:13px;line-height:1.4;min-height:2.8em';/* fixed height: the dial must not shift while dragging */card.appendChild(status);
 const names=['north','northeast','east','southeast','south','southwest','west','northwest'],shown=b=>String(Math.round(b*10)/10);
 // Move only what turns: the bar on the front side, the arrow to the knob on the dial, and the four side labels.
 function paint(b,committed){
  const a=b*Math.PI/180,ux=Math.sin(a),uy=-Math.cos(a),px=-uy,py=ux,along=pts.length?Math.max(...pts.map(p=>(p.x-C)*ux+(p.y-C)*uy)):0,across=pts.map(p=>(p.x-C)*px+(p.y-C)*py),lo=(pts.length?Math.min(...across):0)-6,hi=(pts.length?Math.max(...across):0)+6,reach=Math.min(along+9,R-34);
  const attrs=(el,v)=>{for(const k in v)el.setAttribute(k,v[k]);};
  attrs(bar,{x1:C+ux*reach+px*lo,y1:C+uy*reach+py*lo,x2:C+ux*reach+px*hi,y2:C+uy*reach+py*hi});attrs(arrow,{x1:C+ux*(reach+5),y1:C+uy*(reach+5),x2:C+ux*(R-16),y2:C+uy*(R-16)});attrs(knob,{cx:C+ux*R,cy:C+uy*R});
  // Side labels sit just outside the dial, anchored away from it so they never cover the knob.
  for(const [k,offset,r]of [['front',0,R+16],['back',180,R+12],['left',90,R+12],['right',-90,R+12]]){const s=(b+offset)*Math.PI/180,sx=Math.sin(s),sy=-Math.cos(s);attrs(sides[k],{x:C+sx*r,y:C+sy*r+6+sy*8,'text-anchor':sx>.45?'start':sx<-.45?'end':'middle'});}
  svg.setAttribute('aria-valuenow',shown(b));svg.setAttribute('aria-valuetext','Front faces '+names[Math.round(b/45)%8]+', '+shown(b)+' degrees');
  status.innerHTML=committed===false||Number.isFinite(settings.frontBearing)?`<strong>${shown(b)}°</strong> · the front faces <strong>${names[Math.round(b/45)%8]}</strong> (clockwise from north; the diagram is north-up)`:'Front not set. Drag the dial or the slider to set it.';
 }
 let frame=0,pending=null,dragging=null;
 const sync=b=>{input.value=shown(b);slider.value=b;};
 // During a drag or slider move: repaint at most once per animation frame; nothing is saved.
 const preview=b=>{pending=bearingOf(b);if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint(pending,false);sync(pending);});};
 // On release (or a typed value): save, repaint and tell listeners (the textured cover re-renders, debounced).
 const commit=value=>{if(!Number.isFinite(Number(value)))return;if(frame){cancelAnimationFrame(frame);frame=0;}const b=bearingOf(value);settings.frontBearing=b;pending=null;sync(b);touchElevationSettings(settings);paint(b);card.dispatchEvent(new CustomEvent('house-orientation-change',{bubbles:true,detail:{frontBearing:b}}));};
 const pointerBearing=e=>{const r=svg.getBoundingClientRect();return bearingOf(Math.atan2(e.clientX-(r.left+r.width/2),-(e.clientY-(r.top+r.height/2)))*180/Math.PI);};
 const dragBearing=e=>e.shiftKey?pointerBearing(e):snapBearing(pointerBearing(e),snaps);
 svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();dragging=e.pointerId;try{svg.setPointerCapture(e.pointerId);}catch(err){}svg.style.cursor='grabbing';svg.focus({preventScroll:true});preview(dragBearing(e));});
 svg.addEventListener('pointermove',e=>{if(dragging===e.pointerId)preview(dragBearing(e));});
 const release=e=>{if(dragging!==e.pointerId)return;dragging=null;svg.style.cursor='grab';commit(e.type==='pointercancel'?(pending??PDF.frontBearing(settings)):dragBearing(e));};
 svg.addEventListener('pointerup',release);svg.addEventListener('pointercancel',release);
 svg.addEventListener('keydown',e=>{const step={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1}[e.key];if(!step)return;e.preventDefault();commit(PDF.frontBearing(settings)+step*(e.shiftKey?15:1));});
 slider.oninput=()=>preview(Number(slider.value));slider.onchange=()=>commit(Number(slider.value));input.onchange=()=>commit(input.value);
 const start=PDF.frontBearing(settings);sync(start);paint(start);
}
function renderExteriorReportConfig(container,state){
 /* The Exteriors tab is only the house orientation, filling the tab. Report parameters stay in data and
  keep working when set there, with no control here: exteriorSettings.include (default on; a customer
  full-house PDF always includes the pages), exteriorSettings.dimensionContext (default: the
  organization's Company > Reports setting) and exteriorSettings.notes (wall notes page). */
 state.exteriorSettings||={};container.style.padding='16px';container.style.display='flex';container.style.flexDirection='column';container.style.minHeight='100%';container.style.boxSizing='border-box';
 renderHouseOrientation(container,state,{fill:true});
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
/* Report configuration warns while any wall face has no material, naming the faces; Assign in Walls
 opens Wall materials with colors on. (The Exteriors tab no longer lists faces.) */
function assignWallMaterials(){
 window.closeReportConfig?.();
 if(!window.WallMode?.enabled)document.getElementById('wall-mode-toggle')?.click();
 setTimeout(()=>{const trigger=document.getElementById('wall-material-toggle');if(trigger&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();const colors=document.querySelector('#wall-material-picker input[type=checkbox]');if(colors&&!colors.checked){colors.checked=true;colors.dispatchEvent(new Event('change'));}},400);
}
function renderUnassignedMaterialWarning(state){
 const panel=document.getElementById('report-config-panel'),warning=window.ExteriorReportModel?.materialWarning(state?.exteriorReport);let box=document.getElementById('report-unassigned-warning');
 if(!panel||!warning){box?.remove();return null;}
 if(!box){box=document.createElement('div');box.id='report-unassigned-warning';box.dataset.unassignedWarning='';box.setAttribute('role','alert');box.style.cssText='display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:#fff4e5;border-bottom:1px solid #f0c36d;color:#5c3c00;font-size:12px;line-height:1.45;flex:0 0 auto';(panel.querySelector('#reportPreviewContent')||panel.lastChild)?.before(box);}
 const icon=document.createElement('i');icon.className='fas fa-exclamation-triangle';icon.setAttribute('aria-hidden','true');icon.style.cssText='margin-top:2px;color:#b26a00';
 const body=document.createElement('div');body.style.flex='1';const title=document.createElement('strong');title.textContent='Unassigned materials. ';body.append(title,document.createTextNode(warning.text));
 const actions=document.createElement('div');actions.style.cssText='display:flex;gap:6px;margin-top:6px;flex-wrap:wrap';
 const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='padding:4px 10px;border:1px solid #d9a441;border-radius:4px;background:#fff;color:#5c3c00;font-weight:700;cursor:pointer;font-size:12px';b.onclick=fn;actions.appendChild(b);return b;};
 button('Assign in Walls',assignWallMaterials);body.appendChild(actions);box.replaceChildren(icon,body);return warning;
}
window.renderUnassignedMaterialWarning=renderUnassignedMaterialWarning;
window.ExteriorReportOrientation={orientationSnaps,snapBearing,renderHouseOrientation};
