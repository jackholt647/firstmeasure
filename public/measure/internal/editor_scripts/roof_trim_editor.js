/* Editable roof fascia for wall mode. */
(function(root){'use strict';
root.createRoofTrimEditor=function(host){
 let selected=new Set(),panels=[],before=null,buffer='',control=null,open=false,announced=false;
 let openingType=null;let materialIds=[],materialSignature='';const materialChoices=new Map();
 // Trim settings wait for Apply: null/undefined is "keep what each piece has"; a colour of null is "back to the default".
 let pendingWidth=null,pendingColor=undefined,pendingSignature=null;
 const chosenMaterials=()=>materialIds.filter(id=>materialChoices.get(id));
 const copy=o=>JSON.parse(JSON.stringify(o||{}));
 const metric=()=>!!root.ReportUnits?.current().metric, fromInput=n=>Number(n)/(metric()?25.4:1), toInput=n=>Number(n)*(metric()?25.4:1);
 function mount(){const parent=document.querySelector('#exterior-main-toolbar [aria-label="Rebuild building"]')||document.querySelector('#three-container .enh-control-panel');if(!parent)return;if(control){if(control.parentElement!==parent)parent.insertBefore(control,document.getElementById('base-rebuild-grade')?.parentElement===parent?document.getElementById('base-rebuild-grade'):null);return;}
  // A light panel, like the toolbar it opens from (exterior_toolbar.js styles the toolbar's controls).
  const O='#roof-trim-control #roof-trim-options',style=document.createElement('style');style.textContent='body:not(.wall-mode-active) #roof-trim-control{display:none!important}#roof-trim-control{position:relative;display:flex;align-items:center}'
   +O+'{position:absolute;left:0;right:auto;top:35px;width:390px;max-width:calc(100vw - 28px);max-height:calc(100vh - 170px);overflow:auto;box-sizing:border-box;padding:2px 14px 12px;background:#fff;color:#394150;border:1px solid #ccd2d9;border-radius:8px;box-shadow:0 5px 18px #0002;font:12px system-ui;z-index:2700}'+O+'[hidden]{display:none}'
   +O+' .trim-section{padding:10px 0;border-top:1px solid #dfe3e8}'+O+' .trim-section:first-child{border-top:0}'+O+' .trim-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}'+O+' .trim-head strong{font-size:13px;color:#202124}'+O+' .trim-head button{margin-left:auto}'
   +'#trim-selection-count{color:#9a6700;font-weight:600}#trim-selection-count.empty{color:#98a2b3;font-weight:400}'
   +O+' .trim-section .trim-row,'+O+' .trim-section .trim-row+.trim-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:4px 0;padding:0;border:0}'+O+' .trim-label{width:68px;flex:0 0 68px;color:#667085}'
   +O+' .trim-width-buttons{display:inline-flex;gap:4px}'+O+' .trim-width-buttons button{min-width:32px}'+O+' input[type=number]{width:72px}'+O+' input[type=color]{width:40px;height:28px;padding:2px;cursor:pointer}'
   +O+' .trim-note{margin:6px 0 0;font-size:11px;color:#667085;line-height:1.45}#trim-selection-color-state{color:#667085;font-style:italic}'
   +O+' #trim-apply{background:#ffd84d;color:#202124;border:1px solid #e0b400;font-weight:700;padding:4px 20px}'+O+' #trim-apply:disabled{background:#f2f4f7;color:#98a2b3;border-color:#dfe3e8;font-weight:400}'+O+' button:disabled{opacity:.55;cursor:default}'
   +O+' #trim-defaults .trim-defaults-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}'+O+' #trim-defaults label{display:flex;flex-direction:column;align-items:stretch;gap:4px;color:#667085;text-align:center}'+O+' #trim-defaults input[type=color]{width:100%;height:30px}';document.head.appendChild(style);
  const widths=[2,3,4,6,8].map(n=>'<button type="button" data-width="'+n+'">'+n+'</button>').join('');
  control=document.createElement('div');control.id='roof-trim-control';control.innerHTML='<button id="roof-trim-tool" title="Roof and wall trim" aria-pressed="false"><i class="fas fa-cut" aria-hidden="true"></i><span>Trim</span></button><section id="roof-trim-options" hidden aria-label="Trim">'
   +'<section id="trim-selection" class="trim-section" aria-label="Selection"><div class="trim-head"><strong>Selection</strong><span id="trim-selection-count"></span><button id="trim-selection-clear" type="button">Clear</button></div>'
   +'<div class="trim-row"><span class="trim-label">Roof</span><button id="roof-trim-eaves" type="button">Eaves</button><button id="roof-trim-rakes" type="button">Rakes</button></div>'
   +'<div class="trim-row"><span class="trim-label">Openings</span><button type="button" data-opening="window">Windows</button><button type="button" data-opening="door">Doors</button><button type="button" data-opening="garage">Garages</button></div>'
   +'<div class="trim-row"><span class="trim-label">Walls</span><button id="wall-trim-select" type="button">All walls</button><button id="wall-trim-untrimmed" type="button">Untrimmed walls</button></div>'
   +'<div class="trim-row"><span class="trim-label">Ground</span><button id="wall-trim-ground" type="button">All ground</button><button id="wall-trim-ground-untrimmed" type="button">Untrimmed ground</button></div>'
   +'<div class="trim-row" aria-label="Trim target materials"><span class="trim-label">Materials</span><button id="trim-material-default" type="button">Default</button><button id="trim-material-all" type="button">All</button><button id="trim-material-none" type="button">None</button></div><div class="trim-row"><span class="trim-label"></span><div id="trim-material-grid" role="group" aria-label="Wall materials that walls and ground pick"></div></div>'
   +'<p class="trim-note">Each pick adds to the selection. Click lines, faces, eaves, rakes or openings in the view to add or remove them.</p></section>'
   +'<section id="trim-settings" class="trim-section" aria-label="Trim settings"><div class="trim-head"><strong>Trim settings</strong></div>'
   +'<div class="trim-row"><span class="trim-label" id="trim-selection-width-label">Width (in)</span><div id="trim-selection-width" class="trim-width-buttons" role="group" aria-label="Trim width">'+widths+'</div><input id="trim-selection-custom" type="number" min="0.25" step="0.25" placeholder="Other" aria-label="Trim width in inches"></div>'
   +'<div class="trim-row"><span class="trim-label">Colour</span><input id="trim-selection-color" type="color" value="#f5f3ef" aria-label="Trim color"><button id="trim-color-default" type="button" title="Use the default colour for each kind of trim">Default</button><span id="trim-selection-color-state"></span></div>'
   +'<div class="trim-row"><span class="trim-label"></span><button id="trim-apply" type="button">Apply</button><button id="trim-selection-remove" type="button">Remove trim</button></div><div id="trim-selection-note" class="trim-note"></div></section>'
   +'<section id="trim-defaults" class="trim-section" aria-label="Default trim colours"><div class="trim-head"><strong>Default colours</strong><span class="trim-note" style="margin:0">Also in Wall materials</span></div><div class="trim-defaults-grid">'
   +[['wall','Walls'],['roof','Roof'],['window','Windows'],['door','Doors'],['garage','Garages']].map(([k,l])=>'<label>'+l+'<input type="color" data-default="'+k+'" aria-label="Default '+l.toLowerCase()+' trim color"></label>').join('')
   +'</div><p class="trim-note">Trim without a colour of its own uses these.</p></section></section>';
  parent.insertBefore(control,document.getElementById('base-rebuild-grade')?.parentElement===parent?document.getElementById('base-rebuild-grade'):null);
  control.querySelector('#roof-trim-tool').onclick=()=>{if(open){finish();clear();}else {open=true;update();}};
  control.querySelector('#roof-trim-eaves').onclick=()=>selectAll('eave');control.querySelector('#roof-trim-rakes').onclick=()=>selectAll('rake');
  for(const b of control.querySelectorAll('[data-opening]'))b.onclick=()=>{finish();openingType=b.dataset.opening;host.selectOpeningTrim?.(b.dataset.opening);update();};
  for(const [id,kind]of [['wall-trim-select','walls'],['wall-trim-ground','ground'],['wall-trim-untrimmed','walls-untrimmed'],['wall-trim-ground-untrimmed','ground-untrimmed']])control.querySelector('#'+id).onclick=()=>{finish();buffer='';openingType=null;host.selectWallTrim?.(kind,chosenMaterials());update();};
  for(const mode of ['default','all','none'])control.querySelector('#trim-material-'+mode).onclick=()=>{for(const id of materialIds)materialChoices.set(id,mode==='all'||mode==='default'&&root.WallTrim.defaultMaterial(id));refreshMaterials();};
  for(const input of control.querySelectorAll('[data-default]'))input.onchange=()=>{host.setTrimDefault?.(input.dataset.default,input.value);update();host.redraw?.();};
  setupSelection();
  for(const input of control.querySelectorAll('input,select'))input.addEventListener('keydown',e=>e.stopPropagation());
  for(const event of ['pointerdown','mousedown','mouseup','click','dblclick','wheel'])control.addEventListener(event,e=>e.stopPropagation());
 }
 // Selection: whatever trim-able things are selected (wall lines, faces, roof
 // sides, openings) get one width and colour through Apply, as one undo step; a
 // setting left untouched keeps what each piece has.
 const ROOF_COLOR='#b9b6ae',LABELS={line:['wall line','wall lines'],face:['face (inside trim)','faces (inside trim)'],eave:['eave','eaves'],rake:['rake','rakes'],window:['window','windows'],door:['door','doors'],garage:['garage','garages']};
 // Read from the saved settings, which a change updates before the next render.
 function roofItems(){const edges=host.settings?.()?.edges||{};return panels.filter(p=>selected.has(p.id)).map(p=>{const saved=edges[p.id],h=Number.isFinite(saved?.height)&&saved.height>1e-6?saved.height/root.RoofTrim.INCH:0;return {kind:p.type==='rake'?'rake':'eave',id:p.id,width:h,raw:saved?.finishColor||undefined,color:h?(saved?.finishColor||host.roofTrimColor?.()||ROOF_COLOR):null};});}
 function selectionItems(){return [...(host.selectionTrimItems?.()||[]),...roofItems()];}
 function summary(items=selectionItems()){
  const counts={};for(const i of items)counts[i.kind]=(counts[i.kind]||0)+1;
  const widths=[...new Set(items.map(i=>Math.round(i.width*1000)/1000))],colors=[...new Set(items.filter(i=>i.width>0&&i.color).map(i=>i.color.toLowerCase()))];
  return {items,total:items.length,counts,missing:items.some(i=>!(i.width>0)),width:widths.length===1?widths[0]:null,color:colors.length===1?colors[0]:colors.length?'mixed':null,text:items.length+' selected'+Object.keys(LABELS).filter(k=>counts[k]).map(k=>' · '+counts[k]+' '+LABELS[k][counts[k]===1?0:1]).join('')};
 }
 // How one item changes: null leaves it alone, otherwise its new width (in) and raw colour.
 function decider(change){return (kind,width,raw,effective)=>{
  if(change.remove)return width>0?{width:0}:null;
  if(!(width>0)){const fill=change.missing?.(kind);if(fill)return fill;if(change.width==null)return null;return {width:change.width,color:change.color??change.fallback};}
  if(change.missing)return null;const w=change.width??width;if(Math.abs(w-width)<1e-6&&(change.color==null||change.color.toLowerCase()===String(effective||'').toLowerCase()))return null;return {width:w,color:change.color??raw};
 };}
 // One undoable step across every type; each type goes through its own writer.
 function applySelection(change){finish();const decide=change.decide||decider(change),roof=roofItems();
  const run=()=>{let next=copy(host.settings()),changed=false;for(const i of roof){const t=decide(i.kind,i.width,i.raw,i.color);if(!t)continue;changed=true;next=root.RoofTrim.setHeight(next,[i.id],t.width);if(t.width>0&&t.color!==undefined)next=root.RoofTrim.setColor(next,[i.id],t.color);}
   if(changed){const original=copy(host.settings());host.set(next);host.commit(original);}
   return host.applySelectionTrim?host.applySelectionTrim(decide)!==false:true;};
  const ok=host.trimTransaction?host.trimTransaction(run):run();host.redraw?.();update();return ok;
 }
 // Trim a piece gets when it has none: a width per kind and its kind's default colour.
 function defaults(){const wall=host.wallWidth?.()||6;return kind=>({width:kind==='eave'||kind==='rake'?6:['window','door','garage'].includes(kind)?2:wall});}
 // Apply: the width and colour set in Trim settings; a piece without trim gets its kind's width.
 function applySettings(){const w=pendingWidth,c=pendingColor,fill=defaults();
  const ok=applySelection({decide:(kind,width,raw)=>{const now=width>0,nw=w??(now?width:fill(kind).width),nc=c===undefined?(now?raw:undefined):c;if(now&&Math.abs(nw-width)<1e-6&&(c===undefined||(nc||null)===(raw||null)))return null;return {width:nw,color:nc};}});
  if(ok!==false){pendingWidth=null;pendingColor=undefined;pendingSignature=null;}update();return ok;}
 function setupSelection(){
  const group=control.querySelector('#trim-selection-width'),custom=control.querySelector('#trim-selection-custom'),color=control.querySelector('#trim-selection-color');
  if(metric()){control.querySelector('#trim-selection-width-label').textContent='Width (mm)';custom.step='1';custom.min='1';custom.setAttribute('aria-label','Trim width in millimetres');for(const b of group.querySelectorAll('[data-width]'))b.textContent=toInput(Number(b.dataset.width)).toFixed(1);}
  for(const b of group.querySelectorAll('[data-width]'))b.onclick=()=>{pendingWidth=Number(b.dataset.width);custom.value='';update();};
  custom.oninput=()=>{const n=fromInput(custom.value);pendingWidth=custom.value.trim()&&Number.isFinite(n)&&n>0?n:null;update();};
  custom.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){custom.blur();applySettings();}if(e.key==='Escape'){custom.value='';pendingWidth=null;custom.blur();update();}};
  color.oninput=color.onchange=()=>{pendingColor=color.value.toLowerCase();update();};
  control.querySelector('#trim-color-default').onclick=()=>{pendingColor=null;update();};
  control.querySelector('#trim-apply').onclick=()=>applySettings();
  control.querySelector('#trim-selection-remove').onclick=()=>{applySelection({remove:true});pendingWidth=null;pendingColor=undefined;update();};
  control.querySelector('#trim-selection-clear').onclick=()=>{finish();selected.clear();openingType=null;host.clearSelection?.();update();host.redraw?.();};
 }
 function refreshSelection(){const s=summary(),count=control.querySelector('#trim-selection-count');
  // A different selection starts from its own values.
  if(pendingSignature!==s.text){pendingSignature=s.text;pendingWidth=null;pendingColor=undefined;}
  count.textContent=s.total?s.text:'Nothing selected';count.classList.toggle('empty',!s.total);control.querySelector('#trim-selection-clear').disabled=!s.total;
  const custom=control.querySelector('#trim-selection-custom'),color=control.querySelector('#trim-selection-color'),shown=pendingWidth??(s.width>0?s.width:null),buttons=[...control.querySelector('#trim-selection-width').querySelectorAll('[data-width]')],onButton=buttons.some(b=>shown!=null&&Math.abs(Number(b.dataset.width)-shown)<1e-6);
  for(const b of buttons)b.setAttribute('aria-pressed',String(shown!=null&&Math.abs(Number(b.dataset.width)-shown)<1e-6));
  if(document.activeElement!==custom){custom.value=shown!=null&&!onButton?String(Math.round(toInput(shown)*1000)/1000):'';custom.placeholder=s.total&&s.width==null&&pendingWidth==null?'Mixed':'Other';}
  // With no colour chosen the swatch shows the selection's own colour, else its kind's default.
  const d=host.trimDefaults?.()||{},kindDefault=[...new Set(Object.keys(s.counts).map(k=>d[k==='eave'||k==='rake'?'roof':k==='line'||k==='face'?'wall':k]))];
  if(document.activeElement!==color){if(typeof pendingColor==='string')color.value=pendingColor;else if(pendingColor===undefined&&s.color&&s.color!=='mixed')color.value=s.color;else if(kindDefault.length===1&&kindDefault[0])color.value=kindDefault[0];}
  control.querySelector('#trim-selection-color-state').textContent=pendingColor===null?'Default colours':typeof pendingColor==='string'?'':s.color==='mixed'?'Mixed: kept':s.color?'':'Default colours';
  control.querySelector('#trim-apply').disabled=!s.total||pendingWidth==null&&pendingColor===undefined&&!s.missing;
  control.querySelector('#trim-selection-remove').disabled=!s.items.some(i=>i.width>0);
  control.querySelector('#trim-selection-note').textContent=s.total?(s.missing?'Pieces without trim get '+(pendingWidth!=null?'this width':'2 in (openings), 6 in (eaves, rakes, walls)')+'. ':'')+(s.counts.eave||s.counts.rake?'Eaves and rakes take the width as their height. ':'')+(s.counts.face?'Face trim runs inside the face. ':''):'Pick above or click in the view, then Apply.';
  for(const input of control.querySelectorAll('[data-default]')){const v=d[input.dataset.default];input.closest('label').hidden=!v;if(v&&document.activeElement!==input)input.value=v;}
 }
 function refreshMaterials(){
  const ids=host.wallMaterials?.()||[];materialIds=ids;for(const id of ids)if(!materialChoices.has(id))materialChoices.set(id,root.WallTrim?.defaultMaterial(id)??true);
  const grid=control.querySelector('#trim-material-grid'),signature=JSON.stringify(ids);
  if(signature!==materialSignature){materialSignature=signature;grid.replaceChildren();for(const id of ids){const def=root.ExteriorMaterials?.[id],button=document.createElement('button');button.type='button';button.dataset.material=id;button.textContent=def?.label||id;button.style.setProperty('--material-color',def?.color||'#c1ccd5');button.onclick=()=>{materialChoices.set(id,!materialChoices.get(id));refreshMaterials();};grid.appendChild(button);}}
  for(const button of grid.querySelectorAll('button'))button.setAttribute('aria-pressed',String(materialChoices.get(button.dataset.material)));
 }
 // The host follows the menu: while it is open, the views select lines for trim.
 function update(){if(announced!==open){announced=open;host.openChanged?.(open);}mount();if(!control)return;if(open){refreshMaterials();refreshSelection();}
  control.hidden=!(host.enabled?.()??host.visible());control.style.display=control.hidden?'none':'flex';control.querySelector('#roof-trim-options').hidden=!open;control.querySelector('#roof-trim-tool').setAttribute('aria-pressed',String(open));}
 function refresh(roof){panels=root.RoofTrim.panels(roof,host.settings());selected=new Set([...selected].filter(id=>panels.some(p=>p.id===id)));update();return panels;}
 function clear(){openingType=null;selected.clear();buffer='';open=false;update();host.redraw();}
 function selectAll(type){openingType=null;finish();host.prepare?.();const keep=open;selected=new Set([...(keep?selected:[]),...panels.filter(p=>!type||p.type===type).map(p=>p.id)]);open=keep||!!selected.size;buffer='';if(!keep)host.clearSelection?.();update();host.redraw();}
 function preview(inches){if(!selected.size||!Number.isFinite(inches)||inches<0)return;before??=copy(host.settings());host.set(root.RoofTrim.setHeight(before,[...selected],inches));host.redraw();}
 function finish(){if(before){const original=before;before=null;if(JSON.stringify(original)!==JSON.stringify(host.settings()))host.commit(original);}buffer='';update();}
 function cancel(){if(before){host.set(before);before=null;buffer='';host.redraw();}else clear();update();}
 function remove(){finish();if(!selected.size)return;const original=copy(host.settings());host.set(root.RoofTrim.setHeight(original,[...selected],0));host.commit(original);host.redraw();update();}
 // A number typed with the menu open sets the selection's width (in) at once,
 // one undo step per number; T straight after it keeps it. A roof-only
 // selection keeps its own height entry below.
 let typing={token:{},key:null,signature:null},typings=0;
 function restartTyping(){typing={token:{},key:'trim-menu:'+(++typings),signature:null};}
 function distanceInput(){if(!open)return null;const s=summary();if(!s.total||s.items.every(i=>i.kind==='eave'||i.kind==='rake'))return null;
  if(typing.signature!==s.text){restartTyping();typing.signature=s.text;}const t=typing,fallback=typeof pendingColor==='string'?pendingColor:undefined;
  return {token:t.token,label:'Trim width',unit:'inches',unitsPerInput:.0254,quiet:true,allowZero:true,amount:(s.width||0)*.0254,set(value){if(value==null||value<0||typing!==t)return;const width=Math.round(value/.0254*1e6)/1e6,run=()=>applySelection({width,fallback});if(host.groupEdits)host.groupEdits(t.key,run);else run();t.signature=summary().text;}};}
 function pick(e,group,vector){restartTyping();if(!host.visible()||!e.target.closest?.('#three-view-wrapper'))return false;
  const front=root.wallNearestSurface?.(group,e);let id=front?.object.userData.roofTrimId;
  if(!id){let nearest=9;for(const p of panels){const a=host.screen(p.a),b=host.screen(p.b);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l2)):0,dist=Math.hypot(e.clientX-a.x-dx*t,e.clientY-a.y-dy*t);if(dist<nearest&&root.wallLinePickVisible?.(group,vector(p.a),vector(p.b),e)!==false){id=p.id;nearest=dist;}}}
  if(!id)return false;finish();if(open){if(e.ctrlKey||e.metaKey||selected.has(id))selected.delete(id);else selected.add(id);update();host.redraw();return true;}if(e.shiftKey){if(selected.has(id))selected.delete(id);else selected.add(id);}else selected=new Set([id]);open=!!selected.size;host.clearSelection?.();update();host.redraw();return true;
 }
 function key(e){const owner=distanceInput();if(owner){if(root.ExteriorDistanceInput?.key(e,owner))return true;if(e.key.toLowerCase()==='t'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&root.ExteriorDistanceInput?.typed(owner)){if(!e.repeat)restartTyping();e.preventDefault();e.stopImmediatePropagation();return true;}}if(open&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&['t','delete'].includes(e.key.toLowerCase())){const s=summary(),k=e.key.toLowerCase(),openings=Object.keys(s.counts).every(kind=>['window','door','garage'].includes(kind))&&Object.keys(s.counts).length===1;if(s.total&&!(openings&&openingType===Object.keys(s.counts)[0]&&(k==='delete'||!s.missing))){if(!e.repeat){if(k==='delete')applySelection({remove:true});else if(s.missing){restartTyping();const t=typing,run=()=>applySelection({missing:defaults()});if(host.groupEdits)host.groupEdits(t.key,run);else run();t.signature=summary().text;}}e.preventDefault();e.stopImmediatePropagation();return true;}}if(open&&openingType&&!selected.size&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const items=(host.openingTrimItems?.(openingType)||[]).filter(i=>i.selected),k=e.key.toLowerCase();if(items.length&&['t','delete','escape'].includes(k)){if(!e.repeat){if(k==='escape')clear();else{const sizes=[0,2,3,4,6],current=Math.round(items[0].width*100)/100,width=k==='delete'?0:sizes.find(n=>n>current+1e-6)??0;host.applyOpeningTrim?.(openingType,width,typeof pendingColor==='string'?pendingColor:undefined);update();}}e.preventDefault();e.stopImmediatePropagation();return true;}}if(!selected.size||!host.visible())return false;const k=e.key;if(e.ctrlKey||e.metaKey){if(['z','y'].includes(k.toLowerCase())){if(before)cancel();else host.undo?.(k.toLowerCase()==='y'||e.shiftKey);}else return false;}
  else if(k==='Delete')remove();else if(k==='Escape')cancel();else if(k==='Enter')finish();else if(/^\d$/.test(k)||k==='.'||k==='Backspace'){if(k==='Backspace')buffer=buffer.slice(0,-1);else if(k!=='.'||!buffer.includes('.'))buffer+=k;if(buffer&&Number.isFinite(Number(buffer)))preview(fromInput(buffer));update();}else return false;
  e.preventDefault();e.stopImmediatePropagation();return true;
 }
 return {selectionSnapshot:()=>({selected:[...selected]}),restoreSelection(value){selected=new Set(value?.selected||[]);open=open||selected.size>0;update();},distanceInput,reset(){before=null;buffer='';selected.clear();open=false;materialIds=[];materialSignature='';materialChoices.clear();control?.querySelector('#trim-material-grid')?.replaceChildren();update();},refresh,pick,key,finish,cancel,clear,selectAll,update,applySelection,applySettings,summary,selected:id=>selected.has(id),hasSelection:()=>selected.size>0,busy:()=>!!before};
};
})(window);
