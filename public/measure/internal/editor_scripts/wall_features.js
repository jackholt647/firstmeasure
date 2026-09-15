/* Exterior feature catalog and face-local geometry. Sizes are in feet; geometry is metres. */

(function(root){

'use strict';

const W=typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):root.WallSolidGeometry;

const FT=.3048,defs=new Map(),register=def=>{if(!def.id||!def.sizes?.length)throw Error('Feature needs an id and sizes.');defs.set(def.id,Object.freeze(def));};

register({id:'window',name:'Window',key:'w',color:'#55c7f3',icon:'▦',sizes:[[3,4],[3,5],[4,4],[4,5],[4,6],[6,4],[2,3]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'door',name:'Door',key:'d',color:'#efaa65',icon:'▯',floor:true,sizes:[[3,6+8/12],[2+8/12,6+8/12],[3,7],[3,8],[6,6+8/12]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'garage',name:'Garage door',color:'#b89aea',icon:'▤',floor:true,sizes:[[16,7],[9,7],[8,7],[16,8],[18,7],[18,8],[10,8]].map(([w,h])=>({w,h,shape:'rectangle'}))});

register({id:'vent',name:'Gable vent',color:'#75d5a0',icon:'◉',sizes:[{w:1.5,h:2,shape:'rectangle'},{w:2,h:2,shape:'rectangle'},{w:2,h:2,shape:'circle'}]});

const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});

function frame(points){const n=W.normal(points);if(!n)throw Error('Select a planar face.');let v={x:-n.z*n.x,y:-n.z*n.y,z:1-n.z*n.z},l=Math.hypot(v.x,v.y,v.z);if(l<1e-6){v={x:0,y:1,z:0};l=1;}v={x:v.x/l,y:v.y/l,z:v.z/l};return {origin:points[0],u:cross(v,n),v,n};}

// Orient face-local movement from the current screen projection, independent of winding.

// Keep horizontal wall motion level and vertical motion upright; only the viewed side changes.

function viewFrame(points,screen){const f=frame(points);if(!screen)return f;const center=points.reduce((s,p)=>({x:s.x+p.x/points.length,y:s.y+p.y/points.length,z:s.z+p.z/points.length}),{x:0,y:0,z:0}),project=v=>{const a=screen({x:center.x-v.x*.01,y:center.y-v.y*.01,z:center.z-v.z*.01}),b=screen({x:center.x+v.x*.01,y:center.y+v.y*.01,z:center.z+v.z*.01});return {x:b.x-a.x,y:b.y-a.y};},u=project(f.u),v=project(f.v),flip=(axis,sign)=>({x:axis.x*sign,y:axis.y*sign,z:axis.z*sign});

 if(![u.x,u.y,v.x,v.y].every(Number.isFinite))throw Error('Turn the camera toward the face before nudging.');

 return {...f,u:flip(f.u,u.x<0?-1:1),v:flip(f.v,v.y>0?-1:1)};

}

function orientedFrame(points,axis){const f=frame(points);let u=axis;if(!u){const edges=points.map((p,i)=>sub(points[(i+1)%points.length],p)).filter(v=>Math.hypot(v.x,v.y,v.z)>1e-6);edges.sort((a,b)=>Math.abs(dot(b,f.u))/Math.hypot(b.x,b.y,b.z)-Math.abs(dot(a,f.u))/Math.hypot(a.x,a.y,a.z));u=edges[0];}if(!u)return f;const off=dot(u,f.n);u={x:u.x-off*f.n.x,y:u.y-off*f.n.y,z:u.z-off*f.n.z};const l=Math.hypot(u.x,u.y,u.z);if(l<1e-6)return f;u={x:u.x/l,y:u.y/l,z:u.z/l};if(dot(u,f.u)<-1e-6)u={x:-u.x,y:-u.y,z:-u.z};return {...f,u,v:cross(f.n,u)};}

function bounds(points){return {left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),bottom:Math.min(...points.map(p=>p.y)),top:Math.max(...points.map(p=>p.y))};}

function dimensions(points,feature){const f=feature?.axis?orientedFrame(points,feature.axis):frame(points),b=bounds(points.map(p=>W.inFrame(f,p)));return {width:(b.right-b.left)/FT,height:(b.top-b.bottom)/FT,frame:f,bounds:b};}

const format=n=>String(Math.round(n*100)/100),label=(points,feature)=>{const d=dimensions(points,feature);return format(d.width)+' × '+format(d.height)+' ft';};

function shape(box,kind='rectangle'){const {left:l,right:r,bottom:b,top:t}=box;if(kind==='circle')return Array.from({length:48},(_,i)=>{const a=i*Math.PI/24;return {x:(l+r)/2+(r-l)/2*Math.cos(a),y:(b+t)/2+(t-b)/2*Math.sin(a),z:0};});return [{x:l,y:b,z:0},{x:r,y:b,z:0},{x:r,y:t,z:0},{x:l,y:t,z:0}];}

function anchors(points,boundaries,tolerance=1e-4){const b=bounds(points),out={};for(const [key,value]of Object.entries(b)){const axis=key==='left'||key==='right'?'x':'y',other=axis==='x'?'y':'x',lo=axis==='x'?b.bottom:b.left,hi=axis==='x'?b.top:b.right;for(const r of boundaries)for(let i=0;i<r.length;i++){const a=r[i],c=r[(i+1)%r.length];if(Math.abs(a[axis]-value)<tolerance&&Math.abs(c[axis]-value)<tolerance&&Math.min(hi,Math.max(a[other],c[other]))-Math.max(lo,Math.min(a[other],c[other]))>1e-5)out[key]=true;}}return out;}

function resized(points,preset,anchor={}){const b=bounds(points),w=preset.w*FT,h=preset.h*FT,cx=(b.left+b.right)/2,cy=(b.bottom+b.top)/2;let left=anchor.left?b.left:anchor.right?b.right-w:cx-w/2,bottom=anchor.bottom?b.bottom:anchor.top?b.top-h:cy-h/2;

 // Two opposite anchors cannot both survive a size change: keep the lower/left one.

 return shape({left,right:left+w,bottom,top:bottom+h},preset.shape);}

function place(center,preset,boundaries,screen,radius=12){let points=shape({left:center.x-preset.w*FT/2,right:center.x+preset.w*FT/2,bottom:center.y-preset.h*FT/2,top:center.y+preset.h*FT/2},preset.shape),b=bounds(points);const offsets={x:null,y:null};

 for(const ring of boundaries)for(let i=0;i<ring.length;i++){const a=ring[i],c=ring[(i+1)%ring.length];for(const axis of ['x','y']){const other=axis==='x'?'y':'x';if(Math.abs(a[axis]-c[axis])>1e-5)continue;const low=axis==='x'?b.bottom:b.left,high=axis==='x'?b.top:b.right;if(Math.min(high,Math.max(a[other],c[other]))<Math.max(low,Math.min(a[other],c[other]))-1e-5)continue;for(const value of axis==='x'?[b.left,b.right]:[b.bottom,b.top]){const from={x:(b.left+b.right)/2,y:(b.bottom+b.top)/2,z:0};from[axis]=value;const to={...from,[axis]:a[axis]},p=screen(from),q=screen(to),distance=Math.hypot(q.x-p.x,q.y-p.y);if(Number.isFinite(distance)&&distance<=radius&&(!offsets[axis]||distance<offsets[axis].distance))offsets[axis]={distance,delta:a[axis]-value};}}}

 return points.map(p=>({...p,x:p.x+(offsets.x?.delta||0),y:p.y+(offsets.y?.delta||0)}));}

function containsShape(points,outlines){const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);return W.subtract({points},outlines.map(points=>({points}))).reduce((s,p)=>s+area(p),0)<1e-7;}

function validate(points,outlines,others=[]){if(points.length<3||!points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)))throw Error('Feature geometry is invalid.');const b=bounds(points);if(b.right-b.left<.01||b.top-b.bottom<.01)throw Error('Keep the shape at least 0.4 inches wide and high.');if(!containsShape(points,outlines))throw Error('That size or position extends beyond the supporting face.');const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);for(const f of others)if(area(points)-W.subtract({points},[{points:f.points}]).reduce((s,r)=>s+area(r),0)>1e-7)throw Error('That position overlaps another feature.');}

const api={FT,defs,register,frame,viewFrame,orientedFrame,bounds,dimensions,label,anchors,resized,shape,place,validate,containsShape};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallFeatures=api;

})(typeof window!=='undefined'?window:globalThis);

(function(){if(typeof window==='undefined')return;const F=window.WallFeatures;

F.mountUI=function(command,selection,busy=()=>false,materials={}){
 if(typeof document==='undefined')return;
 const style=document.createElement('style');style.textContent=`
 body:not(.wall-mode-active) .exterior-sticker-bar,body:not(.wall-mode-active) #wall-material-toggle,body:not(.wall-mode-active) #wall-material-picker,body:not(.wall-mode-active) #wall-face-options{display:none!important}
 .exterior-sticker-bar{max-width:100%;background:transparent}
 .exterior-sticker-bar .ss-strip{min-width:0;overflow-x:auto}
 .exterior-sticker-bar [hidden],.exterior-sticker-menu[hidden]{display:none!important}
 .exterior-sticker-bar .ss-tile svg{color:var(--feature-color,#5f6368)}
 .exterior-sticker-bar .ss-tile.active{border-color:var(--feature-color,var(--primary));background:#f0f5fa}
 .exterior-sticker-menu{background:rgba(255,255,255,.95);padding:10px;border-radius:8px;box-shadow:0 2px 10px #0003;border:1px solid #ccc;color:#444;font:11px sans-serif;box-sizing:border-box}
 .exterior-selection{position:absolute;bottom:68px;right:12px;width:560px;max-width:calc(100% - 24px);max-height:var(--exterior-menu-height,320px);overflow:auto;z-index:10001;background:#fff}
 .exterior-sticker-menu h4{margin:0 0 10px;font-size:12px;border-bottom:1px solid #ccc;padding-bottom:5px;color:#333}
 .exterior-sticker-menu .exterior-option{display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px;font:11px sans-serif;margin-bottom:2px;border-radius:4px;background:#f8f9fa;border:1px solid #eee;width:100%;text-align:left;color:#444}
 .exterior-sticker-menu .exterior-option:hover{background:#e0e0e0}
 .exterior-sticker-menu .exterior-option[aria-pressed=true]{background:#e8f0fe;border-color:#1a73e8}
 .exterior-sticker-menu button:disabled{opacity:.45;cursor:default}
 .exterior-sticker-menu button:focus-visible,.exterior-sticker-bar button:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
 .exterior-swatch{width:12px;height:12px;border:1px solid #0002;border-radius:2px;flex-shrink:0;box-sizing:border-box}
 .exterior-selection p{margin:0 0 10px;line-height:1.4}
 .exterior-face-toggle{display:flex;align-items:center;gap:8px;flex-shrink:0;height:44px;padding:0 10px;border:1px solid #ccc;border-radius:5px;background:#fff;color:#444;font:600 11px sans-serif;cursor:pointer}
 .exterior-face-toggle:hover,.exterior-face-toggle[aria-expanded=true]{background:#e8f0fe;border-color:#1a73e8;color:#1a73e8}
 .exterior-face-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
 .exterior-face-heading h4{border:0;padding:0;margin:0}
 .exterior-face-heading button{border:0;background:transparent;font:18px sans-serif;color:#666;cursor:pointer}
 .exterior-face-table{width:100%;border-collapse:collapse;table-layout:fixed;font:11px sans-serif;text-align:left}
 .exterior-face-table th,.exterior-face-table td{border-bottom:1px solid #e1e5e8;padding:8px 6px;vertical-align:top}
 .exterior-face-table thead th{font-size:10px;color:#737b83;font-weight:600;padding-top:4px}
 .exterior-face-table th:first-child{width:92px}
 .exterior-face-table tbody th{font-weight:600;color:#444}
 .exterior-face-type{display:flex;align-items:center;gap:6px;padding-top:6px}
 .exterior-size-options{display:flex;flex-wrap:wrap;gap:4px}
 .exterior-size-options button{padding:5px 7px;border:1px solid #dce1e5;border-radius:4px;background:#fff;color:#444;cursor:pointer;font:11px sans-serif;white-space:nowrap;font-variant-numeric:tabular-nums}
 .exterior-size-options button:hover{background:#f1f5f9;border-color:#9cabb8}
 .exterior-size-options button[aria-pressed=true]{background:#e8f0fe;border-color:#1a73e8;color:#1a73e8}
 .exterior-size-options button:disabled{opacity:.55}

 #wall-material-picker .exterior-material-options{display:grid;grid-template-columns:1fr 1fr;gap:4px}#wall-material-picker .exterior-option{width:100%;text-align:left}#wall-material-picker .exterior-finish-controls{margin-top:12px}#wall-material-picker .exterior-color-options{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:8px}#wall-material-picker input[type=color]{width:38px;height:27px;padding:2px;border:1px solid #aab3ba;border-radius:4px;margin-left:auto}#wall-material-picker{position:absolute;top:60px;left:10px;width:300px;max-width:calc(100% - 20px);max-height:calc(100% - 80px);overflow:auto;z-index:2600}
 #wall-material-picker .exterior-picker-heading{display:flex;align-items:baseline;justify-content:space-between}
 #wall-material-picker .exterior-picker-heading button{border:0;background:none;color:#666;cursor:pointer;font-size:18px}
 #wall-material-picker p{font-size:10px;line-height:1.4;color:#666;margin:10px 0}
 #wall-material-picker label{display:flex;align-items:center;gap:6px;border-top:1px solid #ddd;padding-top:10px}
 `;document.head.appendChild(style);
 const parent=document.getElementById('three-view-wrapper');if(!parent)return;
 const sizeMenu=()=>parent.style.setProperty('--exterior-menu-height',Math.max(80,parent.clientHeight-80)+'px');sizeMenu();if(typeof ResizeObserver!=='undefined')new ResizeObserver(sizeMenu).observe(parent);
 const svg=path=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';
 const paths={window:'M4 3h16v18H4zM12 3v18M4 12h16',door:'M6 21V3h12v18M3 21h18M14 12h1',garage:'M3 21V5h18v16M6 21V8h12v13M6 12h12M6 16h12',vent:'M4 20V9l8-6 8 6v11zM8 10h8M8 14h8M8 18h8',none:'M4 4h16v16H4zM8 12h8M12 8v8'};
 const bar=document.createElement('div');bar.className='exterior-sticker-bar';bar.setAttribute('aria-label','Exterior sticker library');
 const strip=document.createElement('div');strip.className='ss-strip';bar.appendChild(strip);
 const tile=(name,path,color)=>{const b=document.createElement('button');b.type='button';b.className='ss-tile';b.style.setProperty('--feature-color',color||'#5f6368');b.innerHTML=svg(path)+'<span class="ss-name">'+name+'</span>';strip.appendChild(b);return b;};
 for(const def of F.defs.values()){const b=tile(def.name,paths[def.id]||paths.none,def.color);b.title=def.name+(def.key?' ('+def.key.toUpperCase()+')':'')+' — place on a face';b.onclick=()=>command(def.id,undefined,true);}
 const face=document.createElement('button');face.type='button';face.className='exterior-face-toggle';face.innerHTML='Face type <span aria-hidden="true">▴</span>';face.title='Choose a face type and size';face.setAttribute('aria-label','Face type');face.setAttribute('aria-haspopup','dialog');face.setAttribute('aria-expanded','false');face.setAttribute('aria-controls','wall-face-options');bar.appendChild(face);
 const panel=document.createElement('div');panel.id='wall-face-options';panel.className='exterior-selection exterior-sticker-menu';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Face type and dimensions');panel.innerHTML='<div class="exterior-face-heading"><h4>FACE TYPE &amp; SIZE</h4><button type="button" aria-label="Close face types">×</button></div><p role="status"></p><table class="exterior-face-table"><thead><tr><th scope="col">Type</th><th scope="col">Width × height</th></tr></thead><tbody></tbody></table>';parent.appendChild(panel);
 const closeFace=()=>{panel.hidden=true;face.setAttribute('aria-expanded','false');};
 face.onclick=()=>{panel.hidden=!panel.hidden;face.setAttribute('aria-expanded',String(!panel.hidden));};
 panel.querySelector('.exterior-face-heading button').onclick=()=>{closeFace();face.focus();};
 // Build the complete catalog once so opening never waits on a render or rebuild.
 const choices=[],feet=n=>{const inches=Math.round(n*12),f=Math.floor(inches/12),i=inches%12;return f+'′'+(i?i+'″':'');};
 const addChoice=(container,type,preset,label)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.type=type;b.dataset.preset=preset===null?'current':String(preset);b.setAttribute('aria-label',(F.defs.get(type)?.name||'Untyped face')+' · '+label);b.onclick=()=>{if(busy())return;const place=!selection();if(place&&preset===null)return;if(place){command(type,preset,true);closeFace();}else command(type,preset);F.refreshUI();};container.appendChild(b);choices.push({b,type,preset});};
 for(const def of [{id:'none',name:'Untyped face',color:'#c1ccd5',sizes:[]},...F.defs.values()]){
  const row=document.createElement('tr'),heading=document.createElement('th'),cell=document.createElement('td'),options=document.createElement('div');heading.scope='row';const name=document.createElement('span');name.className='exterior-face-type';const swatch=document.createElement('span');swatch.className='exterior-swatch';swatch.style.background=def.color;name.append(swatch,document.createTextNode(def.name));heading.appendChild(name);options.className='exterior-size-options';cell.appendChild(options);row.append(heading,cell);panel.querySelector('tbody').appendChild(row);
  addChoice(options,def.id,null,def.id==='none'?'Remove type':'Keep size');
  def.sizes.forEach((size,i)=>addChoice(options,def.id,i,feet(size.w)+' × '+feet(size.h)+(size.shape==='circle'?' · Round':'')));
 }
 const toggle=document.createElement('button');toggle.className='exterior-sticker-toggle';toggle.innerHTML='<i class="fas fa-chevron-right" aria-hidden="true"></i>';toggle.title='Hide wall stickers';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded','true');toggle.onclick=()=>{strip.hidden=!strip.hidden;closeFace();toggle.innerHTML='<i class="fas fa-chevron-'+(strip.hidden?'left':'right')+'" aria-hidden="true"></i>';toggle.title=strip.hidden?'Show wall stickers':'Hide wall stickers';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded',String(!strip.hidden));};bar.appendChild(toggle);parent.appendChild(bar);
 const picker=document.createElement('section');picker.id='wall-material-picker';picker.className='exterior-sticker-menu';picker.hidden=true;picker.setAttribute('aria-label','Wall materials');picker.innerHTML='<div class="exterior-picker-heading"><h4>WALL MATERIALS</h4><button type="button" aria-label="Close wall materials">×</button></div><div class="exterior-material-options"></div><p>Select a face to edit its finish, or choose a material first and click sections to paint. Escape finishes painting.</p><div class="exterior-finish-controls"><label>Finish color<input type="color" value="#f5f3ef" aria-label="Finish color"></label><div class="exterior-color-options"></div><p>Color is independent of material. Choose a color to update the selected face.</p></div><label><input type="checkbox">Colors in plain modes</label>';parent.appendChild(picker);
 const trigger=document.createElement('button');trigger.id='wall-material-toggle';trigger.className='toolbar-btn';trigger.innerHTML='<i class="fas fa-palette" aria-hidden="true"></i>';trigger.title='Wall materials';trigger.setAttribute('aria-label','Wall materials');trigger.setAttribute('aria-controls',picker.id);trigger.setAttribute('aria-expanded','false');document.getElementById('btnToggleTypes')?.after(trigger);
 const closeMaterials=()=>{picker.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.classList.remove('active');materials.finish?.();};
 trigger.onclick=()=>{if(!picker.hidden){closeMaterials();return;}picker.hidden=false;trigger.setAttribute('aria-expanded','true');trigger.classList.add('active');refreshMaterials();};picker.querySelector('.exterior-picker-heading button').onclick=closeMaterials;
 const option=(parent,label,color,active,fn,disabled=false)=>{const b=document.createElement('button');b.type='button';b.className='exterior-option';b.disabled=disabled;b.setAttribute('aria-pressed',String(active));if(color){const swatch=document.createElement('span');swatch.className='exterior-swatch';swatch.style.background=color;b.appendChild(swatch);}b.appendChild(document.createTextNode(label));b.onclick=fn;parent.appendChild(b);return b;};
 const materialButtons=[];for(const [id,def]of Object.entries(window.ExteriorMaterials||{})){const b=option(picker.querySelector('.exterior-material-options'),def.label,def.color,false,()=>{materials.paint?.(id);refreshMaterials();});materialButtons.push([id,b]);}
 const colorInput=picker.querySelector('input[type=color]');colorInput.oninput=()=>materials.color?.(colorInput.value);for(const [label,color]of [['White','#f5f3ef'],['Cream','#e8dcc3'],['Gray','#8c9296'],['Charcoal','#3e454b'],['Blue','#53758a'],['Green','#6d8071']]){const b=option(picker.querySelector('.exterior-color-options'),label,color,false,()=>{colorInput.value=color;materials.color?.(color);});b.title=label;}const colors=picker.querySelector('input[type=checkbox]');colors.onchange=()=>materials.colors?.(colors.checked);
 const inheritColor=option(picker.querySelector('.exterior-color-options'),'Default',null,false,()=>materials.color?.('default'));
 const defaultsPanel=document.createElement('details');defaultsPanel.className='exterior-finish-controls';defaultsPanel.innerHTML='<summary>Default finishes</summary><label>Default texture<select aria-label="Default texture"></select></label><label>Default color<input type="color" aria-label="Default color"></label><label>Default trim color<input type="color" aria-label="Default trim color"></label><p>Applies to current and future faces without an individual override.</p>';picker.appendChild(defaultsPanel);
 const defaultTexture=defaultsPanel.querySelector('select'),defaultColors=defaultsPanel.querySelectorAll('input[type=color]');
 for(const [id,def]of Object.entries(window.ExteriorMaterials||{})){if(id==='default'||id.startsWith('trim-'))continue;const o=document.createElement('option');o.value=id;o.textContent=def.label;defaultTexture.appendChild(o);}
 const updateDefaults=()=>materials.defaults?.({material:defaultTexture.value,color:defaultColors[0].value,trimColor:defaultColors[1].value});defaultTexture.onchange=updateDefaults;for(const input of defaultColors)input.onchange=updateDefaults;
 function refreshMaterials(){const d=materials.defaults?.()||{material:'unassigned',color:'#80868b',trimColor:'#f5f3ef'};if(document.activeElement!==defaultTexture)defaultTexture.value=d.material;defaultColors.forEach((input,i)=>{if(document.activeElement!==input)input.value=i?d.trimColor:d.color;});for(const [id,b]of materialButtons)b.setAttribute('aria-pressed',String(materials.active?.()===id));colors.checked=materials.colors?.()!==false;}
 for(const el of [bar,picker,panel])for(const event of ['pointerdown','mousedown','mouseup','click','dblclick','wheel'])el.addEventListener(event,e=>e.stopPropagation());
 F.closeUI=()=>{closeFace();closeMaterials();};
 document.addEventListener('keydown',e=>{if(e.key==='Escape')F.closeUI();},true);
 let last='';F.refreshUI=function(){refreshMaterials();const ref=selection(),locked=busy(),type=ref?.feature?.type||'none',label=ref?(F.defs.get(type)?.name||'Untyped face')+' · '+F.label(ref.points,ref.feature):'Choose a size to place a new feature on a face.',signature=JSON.stringify([label,type,ref?.feature?.preset,locked]);if(signature===last)return;last=signature;
 panel.querySelector('p').textContent=locked?'Finish the current tool to change a face.':label;
 for(const choice of choices){choice.b.disabled=locked||(!ref&&choice.preset===null);choice.b.setAttribute('aria-pressed',String(!!ref&&type===choice.type&&(ref.feature?.preset??null)===choice.preset));}
 };F.refreshUI();
};F.formatSize=n=>String(Math.round(n*100)/100);

})();



if(typeof window!=='undefined')window.ExteriorMaterials={default:{label:'Default',color:'#c1ccd5'},unassigned:{label:'Smooth',color:'#c1ccd5'},siding:{label:'Horizontal siding',color:'#749dbd'},'siding-vertical':{label:'Vertical siding',color:'#83a7b7'},soffit:{label:'Soffit',color:'#bcc8cb'},'trim-horizontal':{label:'Horizontal trim',color:'#d7c7a8',finishColor:'#f5f3ef'},'trim-vertical':{label:'Vertical trim',color:'#b8c8ce',finishColor:'#f5f3ef'},brick:{label:'Brick',color:'#b87965'},masonry:{label:'Masonry',color:'#a79c86'},stucco:{label:'Stucco',color:'#c7ba94'},stone:{label:'Stone',color:'#899889'},other:{label:'Other',color:'#a291b8'}};
