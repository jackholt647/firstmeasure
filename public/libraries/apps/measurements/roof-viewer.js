/* Read-only report geometry and media. No editor runtime or write endpoints.
   Roof reports draw model_data.xml. Full-house reports also draw the published exterior model (walls, openings,
   wall edges, base, fascia) with the editor's own finishes (ExteriorFinishes), in the XML's feet frame. */
(function(){
  const styles = {
    RIDGE:['#FF0000','Ridge'], HIP:['#E67300','Hip'], VALLEY:['#800080','Valley'], RAKE:['#006400','Rake'], EAVE:['#FFD400','Eave'],
    HEAD_WALL:['#A0522D','Headwall Flashing'], SIDE_WALL:['#FF00FF','Sidewall Flashing'],
    TRANS:['#808080','Transition'], PARAPET:['#5C2E0C','Parapet Wall'], PROTRUSION:['#589BA6','Protrusion'],
    CHIMNEY_BACK:['#00008B','Chimney Back Pan'], CHIMNEY_EDGE:['#007bff','Chimney Step'], CHIMNEY_FRONT:['#ADD8E6','Chimney Apron'], SKYLIGHT:['#00FFFF','Skylight'], UNKNOWN:['#000000','Unknown']
  };
  // Wall edges as exterior_report_model.js classifies them; seams are drawn but never measured.
  const wallEdges = {
    'Top':['#7a5af8','Top of walls','wallTopLf'], 'Bottom':['#12b76a','Bottom of walls','wallBottomLf'],
    'Inside corner':['#2e90fa','Inside corners','insideCornersLf'], 'Outside corner':['#f04438','Outside corners','outsideCornersLf'],
    'Termination':['#f79009','Terminations','wallTerminationsLf'], 'Material transition':['#ee46bc','Material transitions','wallTransitionsLf'],
    'Seam':['#98a2b3','Seams',null], 'Edge':['#98a2b3','Other edges',null]
  };
  const openingKinds = {window:['Windows','Window'], door:['Doors','Door'], garage:['Garage doors','Garage door'], vent:['Vents','Gable vent']};
  const openingKind = type => ({garageDoor:'garage','garage-door':'garage',gableVent:'vent','gable-vent':'vent'})[type] || type;
  const flatOpening = {window:'#9fb4c4', door:'#c8c3b9', garage:'#deddd6', vent:'#d5d5ce'};
  const FT = 3.28084;
  function lineType(value){const type=String(value||'').toUpperCase().replace(/[\s-]+/g,'_');return ({STEPFLASH:'SIDE_WALL',STEP_FLASHING:'SIDE_WALL',SIDEWALL:'SIDE_WALL',HEADWALL:'HEAD_WALL',TRANSITION:'TRANS',FLASHING:'UNKNOWN',NONE:'UNKNOWN'})[type] || (styles[type]?type:'UNKNOWN');}
  let libraries, solarLibrary, finishesLibrary;
  const scriptBase = document.currentScript?.src || location.href;
  function script(src){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.onload=resolve;el.onerror=()=>{el.remove();reject(new Error('The 3D viewer library could not load.'));};document.head.append(el);});}
  function loadLibraries(){return libraries ||= (async()=>{
    if(!window.THREE)await script('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
    if(!window.THREE.OrbitControls)await script('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
  })().catch(e=>{libraries=null;throw e;});}
  // The editor's own exterior kernel and finishes, loaded in the editor's order, so the customer model is built and
  // textured by the same code as the editor's Textured view (and the report cover).
  const editorScripts=[['ClipperLib','vendor/clipper-lib-6.4.2-clipper.js'],['earcut','vendor/earcut-3.2.3-earcut.dev.js'],['ExteriorGeometry','exterior_geometry.js'],['WallSolidGeometry','wall_solid_geometry.js'],['WallFeatures','wall_features.js'],['RoofTrim','roof_trim.js'],['ExteriorFinishes','exterior_finishes.js'],['ExteriorRendered','exterior_rendered.js']];
  function loadFinishes(){return finishesLibrary ||= (async()=>{for(const [name,file] of editorScripts)if(!window[name])await script(new URL('../../../measure/internal/editor_scripts/'+file+'?v=20261022-viewer',scriptBase).href);return window.ExteriorFinishes&&window.WallSolidGeometry&&window.ExteriorGeometry?window.ExteriorFinishes:null;})().catch(()=>{finishesLibrary=null;return null;});}
  function parseModel(xml,edgeTypes=[]){
    const classified=new Map(edgeTypes.map(edge=>[String(edge.path),lineType(edge.type)]));
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('This report has invalid roof geometry.');
    const roofs=[];
    for(const roof of doc.querySelectorAll('ROOF')){
      const points=new Map(),lines=new Map(),faces=[],openings=[];
      for(const p of roof.querySelectorAll('POINT')){const xyz=(p.getAttribute('data')||'').split(',').map(Number);if(xyz.length===3&&xyz.every(Number.isFinite))points.set(p.getAttribute('id'),xyz);}
      for(const l of roof.querySelectorAll('LINE')){const ids=(l.getAttribute('path')||'').split(',').map(x=>x.trim());if(ids.length===2&&ids.every(id=>points.has(id)))lines.set(l.getAttribute('id'),{ids,type:classified.get(ids.slice().sort().join(',')) || lineType(l.getAttribute('type'))});}
      function ring(polygon){
        const edges=(polygon?.getAttribute('path')||'').split(',').map(id=>lines.get(id.trim()));
        if(edges.length<3||edges.some(e=>!e))return null;
        // Walk undirected boundary edges; stored directions need not agree.
        const pending=edges.slice(1),path=[...edges[0].ids];
        while(pending.length){const end=path[path.length-1],i=pending.findIndex(e=>e.ids.includes(end));if(i<0)break;const [e]=pending.splice(i,1);path.push(e.ids[0]===end?e.ids[1]:e.ids[0]);}
        return !pending.length&&path[0]===path[path.length-1]?path.slice(0,-1).map(id=>points.get(id)):null;
      }
      // FACE ids are local to each ROOF. Penetrations describe voids, never roof surfaces.
      const records=[...roof.querySelectorAll('FACE')],byId=new Map(records.map(face=>[face.getAttribute('id'),face]));
      for(const face of records){
        const type=(face.getAttribute('type')||'ROOF').toUpperCase();
        if(type!=='ROOF')continue;
        const boundary=ring(face.querySelector('POLYGON'));if(!boundary)continue;
        const holes=[];
        for(const id of (face.getAttribute('children')||'').split(',').map(id=>id.trim()).filter(Boolean)){
          const child=byId.get(id);
          if(!child||(child.getAttribute('type')||'').toUpperCase()!=='WALLPENETRATION')continue;
          const hole=ring(child.querySelector('POLYGON'));
          if(!hole)throw new Error('This report contains an invalid roof opening.');
          holes.push(hole);
          if(!openings.some(item=>item.id===id)){const boundary=(child.querySelector('POLYGON')?.getAttribute('path')||'').split(',').map(key=>lines.get(key.trim())?.type);const kind=boundary.includes('SKYLIGHT')?'skylight':boundary.some(type=>['CHIMNEY_BACK','CHIMNEY_EDGE','CHIMNEY_FRONT'].includes(type))?'chimney':'opening';openings.push({id,kind,points:hole});}
        }
        const pitchText=face.querySelector('POLYGON')?.getAttribute('pitch');
        const size=face.querySelector('POLYGON')?.getAttribute('size');
        faces.push({points:boundary,holes,area:size!==null&&size!==undefined&&Number.isFinite(Number(size))?Math.max(0,Number(size)):null,pitch:pitchText!==null&&pitchText!==undefined&&Number.isFinite(Number(pitchText))?Math.max(0,Number(pitchText)):null});
      }
      if(points.size)roofs.push({points,lines,faces,openings});
    }
    if(!roofs.length)throw new Error('No saved roof geometry is available for this report.');
    return roofs;
  }
  // Build a face-local surface basis: shingle courses run across the slope.
  function faceTextureUVs(face,samples=face){
    const n=[0,0,0];
    face.forEach((p,i)=>{const q=face[(i+1)%face.length];n[0]+=(p[1]-q[1])*(p[2]+q[2]);n[1]+=(p[2]-q[2])*(p[0]+q[0]);n[2]+=(p[0]-q[0])*(p[1]+q[1]);});
    const norm=v=>{const length=Math.hypot(...v)||1;return v.map(x=>x/length);};
    const normal=norm(n[2]<0?n.map(x=>-x):n);
    const across=Math.hypot(normal[0],normal[1])>1e-8?norm([-normal[1],normal[0],0]):[1,0,0];
    const uphill=norm([normal[1]*across[2]-normal[2]*across[1],normal[2]*across[0]-normal[0]*across[2],normal[0]*across[1]-normal[1]*across[0]]);
    return samples.map(p=>{const d=p.map((v,i)=>v-face[0][i]);return [across,uphill].map(axis=>d.reduce((sum,v,i)=>sum+v*axis[i],0)/12);});
  }
  // Pole of inaccessibility: maximize clearance from every outer/hole edge.
  // This stays in the largest usable region of concave faces with openings.
  function faceLabelAnchor(face){
    const rings=[face.points,...face.holes],outer=face.points;
    const min=[0,1].map(i=>Math.min(...outer.map(p=>p[i]))),max=[0,1].map(i=>Math.max(...outer.map(p=>p[i])));
    function distance(x,y){let inside=false,best=Infinity;for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)));best=Math.min(best,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy));
    }return (inside?1:-1)*best;}
    const cell=(x,y,h)=>{const d=distance(x,y);return {x,y,h,d,max:d+h*Math.SQRT2};};
    let best=cell((min[0]+max[0])/2,(min[1]+max[1])/2,0);const size=Math.min(max[0]-min[0],max[1]-min[1]);
    if(!(size>0))return null;
    const queue=[];for(let x=min[0];x<max[0];x+=size)for(let y=min[1];y<max[1];y+=size)queue.push(cell(x+size/2,y+size/2,size/2));
    const tolerance=Math.max(max[0]-min[0],max[1]-min[1])/256;
    for(let count=0;queue.length&&count<12000;count++){queue.sort((a,b)=>a.max-b.max);const current=queue.pop();if(current.d>best.d)best=current;if(current.max-best.d<=tolerance)continue;const h=current.h/2;for(const dx of [-h,h])for(const dy of [-h,h])queue.push(cell(current.x+dx,current.y+dy,h));}
    if(best.d<=0)return null;
    const n=[0,0,0];outer.forEach((p,i)=>{const q=outer[(i+1)%outer.length];n[0]+=(p[1]-q[1])*(p[2]+q[2]);n[1]+=(p[2]-q[2])*(p[0]+q[0]);n[2]+=(p[0]-q[0])*(p[1]+q[1]);});
    if(Math.abs(n[2])<1e-8)return null;
    const z=outer[0][2]-(n[0]*(best.x-outer[0][0])+n[1]*(best.y-outer[0][1]))/n[2];
    const planArea=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
    const area=face.area??Math.max(0,planArea(outer)-face.holes.reduce((sum,hole)=>sum+planArea(hole),0))*Math.hypot(...n)/Math.abs(n[2]);
    return {area,point:[best.x,best.y,z],pitch:face.pitch??Math.round(Math.hypot(n[0],n[1])/Math.abs(n[2])*120)/10,clearance:best.d};
  }
  // ---- Full-house geometry helpers (metres in, feet frame out) ----
  const newell=points=>{const n=[0,0,0];points.forEach((p,i)=>{const q=points[(i+1)%points.length];n[0]+=(p[1]-q[1])*(p[2]+q[2]);n[1]+=(p[2]-q[2])*(p[0]+q[0]);n[2]+=(p[0]-q[0])*(p[1]+q[1]);});const l=Math.hypot(...n);return l>1e-12?n.map(v=>v/l):null;};
  const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  // The exported XML is the same roof in feet, centred, with y flipped. Fit that frame from both roofs so walls
  // and roof lines coincide; a mismatch falls back to a centred frame and the model's own roof.
  function exteriorFrame(model,roofs){
    const metric=(model.roof||[]).flatMap(f=>f.points),source=metric.length?metric:(model.walls||[]).flatMap(w=>w.points);if(!source.length)return null;
    const box=points=>[0,1,2].map(i=>[Math.min(...points.map(p=>p[i])),Math.max(...points.map(p=>p[i]))]),m=box(source),mid=b=>(b[0]+b[1])/2;
    const xml=roofs?roofs.flatMap(r=>[...r.points.values()]):[];
    const frame=(origin,sign)=>({sign,toFeet:p=>[(p[0]-mid(m[0]))*FT+origin[0],sign*(p[1]-mid(m[1]))*FT+origin[1],(p[2]-m[2][0])*FT+origin[2]],toMetres:q=>[(q[0]-origin[0])/FT+mid(m[0]),(q[1]-origin[1])/(sign*FT)+mid(m[1]),(q[2]-origin[2])/FT+m[2][0]]});
    if(xml.length&&metric.length){
      const x=box(xml),origin=[mid(x[0]),mid(x[1]),x[2][0]],sample=metric.filter((_,i)=>i%Math.max(1,Math.floor(metric.length/40))===0);
      for(const sign of [-1,1]){const f=frame(origin,sign),error=sample.reduce((sum,p)=>{const q=f.toFeet(p);return sum+Math.min(...xml.map(r=>Math.hypot(r[0]-q[0],r[1]-q[1],r[2]-q[2])));},0)/sample.length;if(error<.5)return {...f,matchesXml:true};}
    }
    return {...frame([0,0,0],-1),matchesXml:false};
  }
  // ExteriorFinishes.prepare's planar texture coordinates (metric tiles), without the editor's face-frame module.
  function finishUVs(points,material,roof,F){
    const n=newell(points)||[0,0,1],tile=material==='shingles'?(F?.roofMaterials?.[roof?.category]||F?.roofMaterials?.shingles||{tile:[1,.572]}).tile:[.6096,.6096];
    let u,v,useZ=false;
    if(material==='shingles'||material==='soffit'){const up=n[2]<0?n.map(x=>-x):n,l=Math.hypot(up[0],up[1]);u=l>1e-8?[-up[1]/l,up[0]/l,0]:[1,0,0];v=cross3(up,u);}
    else if(Math.abs(n[2])>.999){u=[1,0,0];v=[0,1,0];}
    else{const l=Math.hypot(n[0],n[1]);u=[-n[1]/l,n[0]/l,0];useZ=true;}
    return points.map(p=>[dot3(p,u)/tile[0],(useZ?p[2]:dot3(p,v))/tile[1]]);
  }
  function openingUVs(points){
    const n=newell(points)||[0,1,0],l=Math.hypot(n[0],n[1])||1,u=l>1e-8?[-n[1]/l,n[0]/l,0]:[1,0,0],v=Math.abs(n[2])<.999?[0,0,1]:cross3(n,u);
    const xy=points.map(p=>[dot3(p,u),dot3(p,v)]),min=[0,1].map(i=>Math.min(...xy.map(p=>p[i]))),max=[0,1].map(i=>Math.max(...xy.map(p=>p[i])));
    return xy.map(p=>[(p[0]-min[0])/Math.max(1e-8,max[0]-min[0]),(p[1]-min[1])/Math.max(1e-8,max[1]-min[1])]);
  }
  const ftIn=ft=>{const inches=Math.round(Math.abs(ft)*12),f=Math.floor(inches/12),i=inches%12;return f?`${f}′ ${i}″`:`${i}″`;};
  const decimal=(value,digits=1)=>Number(value.toFixed(digits)).toLocaleString('en-US',{maximumFractionDigits:digits});
  const measurementKeys={RIDGE:'ridgesLf',HIP:'hipsLf',VALLEY:'valleyLf',RAKE:'rakesLf',EAVE:'eavesLf',HEAD_WALL:'headWallLf',SIDE_WALL:'sideWallLf',TRANS:'transitionsLf',PARAPET:'parapetLf',PROTRUSION:'protrusionLf',CHIMNEY_BACK:'chimneyBackLf',CHIMNEY_EDGE:'chimneyStepLf',CHIMNEY_FRONT:'chimneyApronLf',SKYLIGHT:'skylightLf',UNKNOWN:'unknownLf'};
  const shortNames={HEAD_WALL:'Head wall',SIDE_WALL:'Side wall',PARAPET:'Parapet',CHIMNEY_BACK:'Back pan',CHIMNEY_EDGE:'Chimney',CHIMNEY_FRONT:'Chimney'};
  const icon=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  function injectStyle(){
    if(document.getElementById('fm-roof-viewer-style'))return;
    const el=document.createElement('style');el.id='fm-roof-viewer-style';el.textContent=`
      .fm-roof-gallery{height:100%;min-height:360px;display:grid;grid-template-columns:minmax(200px,38%) minmax(0,1fr);gap:12px;padding:12px;box-sizing:border-box;container-type:inline-size;background:#f5f6f8}
      .fm-roof-gallery.is-single{display:block;padding:0}.fm-roof-gallery.is-single .fm-roof-stage{height:100%;min-height:280px;border:0;border-radius:0}
      .fm-roof-gallery *{box-sizing:border-box}.fm-roof-gallery [hidden]{display:none!important}
      .fm-roof-stage{position:relative;min-width:0;min-height:300px;overflow:hidden;background:#eef1f5;border:1px solid #e4e7ec;border-radius:12px;grid-column:2;grid-row:1;display:flex;flex-direction:column}
      .fm-roof-canvas{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}.fm-roof-canvas canvas{width:100%;height:100%;display:block;touch-action:none}.fm-roof-canvas.is-measuring canvas{cursor:crosshair}
      .fm-roof-tools{position:absolute;left:12px;top:12px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;z-index:2;max-width:calc(100% - 24px);max-height:calc(100% - 52px)}.fm-roof-control-row{display:flex;gap:6px;flex:none;flex-wrap:wrap}.fm-roof-tools button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px}.fm-roof-tools button.fm-roof-icon{width:34px;padding:7px}.fm-roof-tools svg{width:18px;height:18px;display:block}.fm-roof-tools button:focus-visible{outline:2px solid #175cd3;outline-offset:2px}
      .fm-roof-tools button,.fm-roof-thumb{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#344054;border-radius:8px;padding:8px 12px;font-size:12px}
      .fm-roof-tools button[aria-pressed=true]{background:#344054;color:white}
      .fm-roof-layers{display:inline-flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff}.fm-roof-tools .fm-roof-layers button{border:0;border-radius:0;height:32px;padding:6px 10px;font-weight:500}.fm-roof-tools .fm-roof-layers button+button{border-left:1px solid #e4e7ec}.fm-roof-tools .fm-roof-layers button[aria-pressed=false]{color:#98a2b3;text-decoration:line-through}.fm-roof-tools .fm-roof-layers button[aria-pressed=true]{background:#fff;color:#344054}
      .fm-roof-measure-bar{display:flex;align-items:center;gap:6px;background:#101828e0;color:#fff;border-radius:8px;padding:5px 6px 5px 10px;font-size:11px}.fm-roof-tools .fm-roof-measure-bar button{height:26px;padding:4px 9px;font-size:11px;border-color:transparent;background:#ffffff26;color:#fff}
      .fm-roof-card{position:absolute;right:12px;top:12px;z-index:3;width:min(250px,calc(100% - 24px));background:#fffffff2;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 4px 16px #1018281f;padding:10px 12px;font-size:12px;color:#344054}.fm-roof-card header{display:flex;align-items:center;gap:8px;margin-bottom:6px}.fm-roof-card header i{width:10px;height:10px;border-radius:2px;flex:none}.fm-roof-card strong{font-size:13px;color:#101828;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-roof-card header button{border:0;background:none;color:#667085;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px}.fm-roof-card header button:focus-visible{outline:2px solid var(--primary,#175cd3)}.fm-roof-card dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}.fm-roof-card dt{color:#667085}.fm-roof-card dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
      .fm-roof-legend{flex:0 0 auto;background:#fffe;border-top:1px solid #d5deeb;padding:5px 8px;max-height:45%;overflow:auto}.fm-roof-legend>button{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:0;background:none;color:#475467;cursor:pointer;font:inherit;font-size:10px;padding:3px}.fm-roof-legend>button svg{height:12px;width:12px;transition:transform .15s}.fm-roof-legend>button[aria-expanded=false] svg{transform:rotate(180deg)}.fm-roof-legend>button:focus-visible{outline:2px solid var(--primary,#d93025)}.fm-roof-key-tray{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows 260ms cubic-bezier(.2,.8,.2,1),opacity 200ms ease}.fm-roof-key-tray>.fm-roof-key-body{min-height:0;overflow:hidden}.fm-roof-legend.is-collapsed .fm-roof-key-tray{grid-template-rows:0fr;opacity:0}.fm-roof-legend.is-collapsed .fm-roof-key{padding-top:0;padding-bottom:0}@media(prefers-reduced-motion:reduce){.fm-roof-key-tray{transition:none}}.fm-roof-measure-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}.fm-roof-measure-tabs button{font:inherit;font-size:10px;cursor:pointer;padding:5px 7px;border:0;background:transparent;color:#667085;white-space:nowrap}.fm-roof-measure-tabs button[aria-selected=true]{color:var(--primary,#344054);box-shadow:inset 0 -2px var(--primary,#344054)}.fm-roof-measure-tabs [data-key]{margin-left:auto}.fm-roof-measure-tabs svg{width:12px;height:12px;transition:transform 200ms}.fm-roof-measure-tabs [aria-expanded=false] svg{transform:rotate(180deg)}.fm-roof-measure-tabs button:focus-visible{outline:2px solid var(--primary,#344054)}.fm-roof-pitches{overflow-x:auto;scrollbar-width:thin}.fm-roof-pitches table{width:100%;border-collapse:collapse;font-size:11px}.fm-roof-pitches th{font-weight:400;text-align:right;padding:7px 10px;white-space:nowrap}.fm-roof-pitches th[scope=row]{width:1%;padding-left:2px;padding-right:14px;text-align:left;font-size:10px;font-weight:600;color:#667085}.fm-roof-pitches tr:first-child th{border-bottom:1px solid #d0d5dd}.fm-roof-pitches td{text-align:right;padding:5px 4px}.fm-roof-pitches input{width:100%;min-width:46px;box-sizing:border-box;text-align:right;font:inherit;border:1px solid transparent;background:transparent;border-radius:3px;padding:4px 6px}.fm-roof-pitches input:not([readonly]):hover{border-color:#cbd5e1}.fm-roof-pitches input:focus{outline:2px solid var(--primary,#344054)}.fm-roof-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px;padding:5px 0;font-size:11px}.fm-roof-summary>div{display:flex;justify-content:space-between;gap:8px}.fm-roof-summary>h4{grid-column:1/-1;margin:6px 0 0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#667085}.fm-roof-summary strong{font-weight:500;font-variant-numeric:tabular-nums}.fm-roof-key,.fm-roof-keys{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;font-size:10px;padding:4px 0}.fm-roof-key-row{display:flex;align-items:center;gap:3px;min-width:0;background:#f8f9fb;border:1px solid #e4e7ec;border-radius:3px;padding:3px}.fm-roof-key-row button{display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow:hidden;font:inherit;font-size:10px;background:transparent;border:0;padding:2px 0;cursor:pointer;color:#344054}.fm-roof-key-row button[aria-pressed=true]{color:var(--primary,#175cd3);font-weight:600}.fm-roof-key-row:has(button[aria-pressed=true]){border-color:var(--primary,#175cd3);background:#fff}.fm-roof-key-row button:focus-visible{outline:2px solid var(--primary,#175cd3)}.fm-roof-key-row input{width:37px;min-width:0;font:inherit;font-size:10px;font-variant-numeric:tabular-nums;text-align:right;border:1px solid transparent;background:transparent;border-radius:2px;padding:2px}.fm-roof-key-row input:not([readonly]):hover{border-color:#cbd5e1}.fm-roof-key-row input:focus{outline:2px solid var(--primary,#175cd3);background:white}.fm-roof-key-row small,.fm-roof-key-row output{font-size:9px;color:#667085}.fm-roof-key-row output{font-size:10px;color:#344054;font-variant-numeric:tabular-nums;white-space:nowrap}.fm-roof-key span,.fm-roof-keys span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;min-width:0;line-height:1.2}.fm-roof-key i,.fm-roof-keys i{width:9px;height:9px;border-radius:1px;display:inline-block;flex:0 0 9px}
      .fm-roof-key-group{grid-column:1/-1;margin:4px 0 0;font-size:10px;font-weight:600;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .fm-roof-measures{display:grid;gap:4px;font-size:11px;padding:4px 0}.fm-roof-measures>div{display:flex;align-items:center;gap:8px}.fm-roof-measures span{flex:1}.fm-roof-measures strong{font-weight:500;font-variant-numeric:tabular-nums}.fm-roof-measures button{border:0;background:none;color:#667085;cursor:pointer;font:inherit;padding:2px 4px}
      .fm-roof-section-title{display:none}.fm-roof-design-bar{position:absolute;right:12px;top:12px;z-index:3;display:flex;gap:6px;align-items:center}.fm-roof-design-bar .fm-roof-layers button{border:0;border-radius:0;height:32px;padding:6px 11px;font:inherit;font-size:12px;font-weight:500;background:#fff;color:#475467;cursor:pointer}.fm-roof-design-bar .fm-roof-layers button+button{border-left:1px solid #e4e7ec}.fm-roof-design-bar .fm-roof-layers button[aria-pressed=true]{background:#344054;color:#fff}.fm-roof-design-open{display:inline-flex;align-items:center;gap:6px;height:34px;padding:6px 11px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:12px;font-weight:500;cursor:pointer}.fm-roof-design-open svg{width:16px;height:16px}.fm-roof-design-open[aria-pressed=true]{border-color:var(--primary,#175cd3);color:var(--primary,#175cd3)}.fm-roof-design-bar button:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}.fm-roof-stage.has-design .fm-roof-card{top:56px}.fm-roof-stage.has-design-open .fm-roof-card{right:336px}.fm-roof-design{position:absolute;right:12px;top:56px;bottom:12px;width:min(312px,calc(100% - 24px));z-index:4;overflow:auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 6px 24px #1018281f;padding:12px 14px;font-size:12px;color:#344054}.fm-roof-design header{display:flex;align-items:center;gap:8px;margin-bottom:6px}.fm-roof-design header strong{font-size:14px;color:#101828}.fm-design-status{flex:1;color:#667085;font-size:11px;text-align:right}.fm-design-close{border:0;background:none;color:#667085;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}.fm-roof-design section{border-top:1px solid #f2f4f7;padding:8px 0}.fm-roof-design h4{margin:4px 0 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#475467}.fm-roof-design h5{margin:10px 0 6px;font-size:12px;font-weight:600;color:#101828}.fm-design-chips{display:flex;flex-wrap:wrap;gap:6px}.fm-design-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}.fm-design-chip i{width:10px;height:10px;border-radius:50%;display:inline-block}.fm-design-chip[aria-pressed=true]{border-color:var(--primary,#175cd3);background:color-mix(in srgb,var(--primary,#175cd3) 8%,white);color:var(--primary,#175cd3);font-weight:600}.fm-design-color{display:flex;align-items:center;gap:8px;margin:6px 0}.fm-design-color span{flex:1}.fm-design-color input{width:40px;height:26px;padding:0;border:1px solid #d0d5dd;border-radius:6px;background:#fff;cursor:pointer}.fm-design-link{border:0;background:none;color:var(--primary,#175cd3);font:inherit;font-size:11px;cursor:pointer;padding:2px}.fm-design-swatches{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}.fm-design-swatch{width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #d0d5dd;cursor:pointer;padding:0}.fm-design-swatch[aria-pressed=true]{box-shadow:0 0 0 2px var(--primary,#175cd3)}.fm-design-note{margin:4px 0;color:#667085;line-height:1.45}.fm-design-face{margin:0 0 6px;font-weight:600;color:#101828}.fm-roof-design footer{display:flex;flex-direction:column;gap:6px;border-top:1px solid #f2f4f7;padding-top:10px}.fm-design-primary,.fm-design-secondary{font:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:8px 10px;cursor:pointer}.fm-design-primary{border:0;background:var(--primary,#175cd3);color:#fff}.fm-design-primary:disabled{opacity:.5;cursor:not-allowed}.fm-design-secondary{border:1px solid #d0d5dd;background:#fff;color:#344054}.fm-design-result{margin:8px 0 0;color:#475467;line-height:1.45}@media(max-width:640px){.fm-roof-design{left:12px;width:auto}.fm-roof-stage.has-design-open .fm-roof-card{display:none}}#exterior-graphics{display:none!important}
      /* Side layout: every panel stacked in a left column beside a full-height model. */
      .fm-roof-gallery.is-side{display:grid;grid-template-columns:clamp(260px,30%,340px) minmax(0,1fr);gap:0;padding:0}
      .fm-roof-gallery.is-side .fm-roof-stage{grid-column:2;border:0;border-radius:0}
      .fm-roof-gallery.is-side>.fm-roof-legend{grid-column:1;grid-row:1;max-height:none;height:100%;border-top:0;border-right:1px solid #d5deeb;padding:12px 14px;background:#fff}
      .fm-roof-gallery.is-side .fm-roof-measure-tabs,.fm-roof-gallery.is-side .fm-roof-legend>button{display:none}
      .fm-roof-gallery.is-side .fm-roof-key-tray{display:block;opacity:1}.fm-roof-gallery.is-side [data-key-panel]{display:grid!important}.fm-roof-gallery.is-side .fm-roof-pitches[data-key-panel]{display:block!important}.fm-roof-gallery.is-side .fm-roof-measures[data-key-panel][data-empty]{display:none!important}
      .fm-roof-gallery.is-side .fm-roof-section-title{display:block;grid-column:1/-1;margin:14px 0 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#475467}.fm-roof-gallery.is-side .fm-roof-key-body>:first-child .fm-roof-section-title,.fm-roof-gallery.is-side .fm-roof-key-body>.fm-roof-section-title:first-child{margin-top:0}
      .fm-roof-gallery.is-side .fm-roof-key,.fm-roof-gallery.is-side .fm-roof-keys{grid-template-columns:1fr!important;gap:3px}.fm-roof-gallery.is-side .fm-roof-key-row{padding:5px 6px;border-radius:6px}.fm-roof-gallery.is-side .fm-roof-key-row button,.fm-roof-gallery.is-side .fm-roof-key-row input,.fm-roof-gallery.is-side .fm-roof-key-row output{font-size:12px}.fm-roof-gallery.is-side .fm-roof-key-row input{width:58px}.fm-roof-gallery.is-side .fm-roof-key i,.fm-roof-gallery.is-side .fm-roof-keys i{width:11px;height:11px;flex-basis:11px;border-radius:2px}.fm-roof-gallery.is-side .fm-roof-summary{grid-template-columns:1fr;font-size:12px}.fm-roof-gallery.is-side .fm-roof-pitches tbody{display:grid;grid-auto-flow:column;grid-template-rows:repeat(var(--rows,2),auto);grid-template-columns:auto 1fr;align-items:center;font-size:12px}.fm-roof-gallery.is-side .fm-roof-pitches tr{display:contents}.fm-roof-gallery.is-side .fm-roof-pitches th,.fm-roof-gallery.is-side .fm-roof-pitches td{border:0!important;border-bottom:1px solid #f2f4f7!important;padding:4px 6px;text-align:left}.fm-roof-gallery.is-side .fm-roof-pitches td input{text-align:right;padding:2px 6px}.fm-roof-gallery.is-side .fm-roof-pitches th[scope=row]{font-size:10px}.fm-roof-gallery.is-side .fm-roof-measures{font-size:12px}
      .fm-roof-library{grid-column:1;grid-row:1;min-width:0;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:8px}
      .fm-roof-thumb{padding:0;overflow:hidden;text-align:left;min-width:0}.fm-roof-thumb img,.fm-roof-thumb video{width:100%;height:120px;object-fit:cover;display:block}.fm-roof-thumb span{display:block;padding:9px}.fm-roof-thumb[aria-pressed=true]{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025)}
      .fm-roof-media{width:100%;height:100%;object-fit:contain;position:absolute;inset:0;background:#101828}.fm-roof-message{position:absolute;inset:0;display:grid;place-content:center;padding:28px;text-align:center;color:#667085;pointer-events:none}.fm-roof-hint{position:absolute;bottom:12px;left:12px;font-size:11px;color:#667085;pointer-events:none}
      .fm-roof-gallery.is-compact{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(300px,1fr) 112px}.fm-roof-gallery.is-compact .fm-roof-stage{grid-column:1;grid-row:1}.fm-roof-gallery.is-compact .fm-roof-library{grid-column:1;grid-row:2;display:flex;overflow-x:auto;overflow-y:hidden}.fm-roof-gallery.is-compact .fm-roof-thumb{flex:0 0 120px}.fm-roof-gallery.is-compact .fm-roof-thumb img,.fm-roof-gallery.is-compact .fm-roof-thumb video{height:66px}.fm-roof-gallery.is-compact .fm-roof-thumb span{padding:6px;font-size:11px}
    `;document.head.append(el);
  }
  function mount(root,{xmlUrl,exteriorUrl,designUrl='',materialsUrl='',edgeTypes=[],media=[],standalone=false,layout='auto',initialState={},measurements={},getMeasurements,onMeasurementChange,subscribeMeasurements}={}){
    injectStyle();let disposed=false,renderer,controls,scene,camera,observer,geometryGroup,lineGroup,texture,selection='model',textureEnabled=initialState.texture!==false,coloredLinesEnabled=initialState.lines!==false,keyVisible=initialState.key!==false,pitchEnabled=initialState.pitch===true,pitchGroup,areaEnabled=initialState.area===true,keyTab=initialState.keyTab||'lines';
    let selectedCategory=initialState.category||(initialState.selectedType?'line:'+initialState.selectedType:null),lengthsEnabled=initialState.lengths===true,layers={roof:initialState.layers?.roof!==false,walls:initialState.layers?.walls!==false,base:initialState.layers?.base!==false};
    let modelLoaded=false,exterior=null,finishes=null,frame=null,scale=1,picked=null,hovered=null,exteriorVector=null,rebuildRoofCaps=null,reportRoofFaces=[],gradeMesh=null,renderedKey='',ownsWallMode=false,measuring=false,measureStart=null,measurePreview=null,sideLayout=false;
    const controller=new AbortController();const objects=[];const ownedUrls=[];const lengths={},faceMetrics=[],openingGroups=[],items=[],measures=[];let unsubscribeMeasurements,syncMeasurements;
    const groups={};
    root.innerHTML=`<div class="fm-roof-gallery"><div class="fm-roof-library" aria-label="Roof model and report media"></div><div class="fm-roof-stage"><div class="fm-roof-canvas"></div><div class="fm-roof-tools"><div class="fm-roof-control-row"><button type="button" class="fm-roof-icon" data-texture aria-label="Texture" title="Texture" aria-pressed="true">${icon('<path d="M3 4h18v16H3zM3 9h18M3 14h18M8 4v5m8-5v5M6 9v5m8-5v5m-4 0v6m8-6v6"/>')}</button><button type="button" class="fm-roof-icon" data-lines aria-label="Colored lines" title="Colored lines" aria-pressed="true">${icon('<path d="m3 18 5-10 6 6 7-10"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/><circle cx="14" cy="14" r="2" fill="currentColor" stroke="none"/>')}</button><button type="button" class="fm-roof-icon" data-pitch aria-label="Pitch labels" title="Pitch labels" aria-pressed="false">${icon('<path d="M3 19h18V7z"/><path d="M17 19v-3h4"/>')}</button><button type="button" class="fm-roof-icon" data-area aria-label="Area labels" title="Area labels (roofing squares, wall square feet)" aria-pressed="false">${icon('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16"/>')}</button><button type="button" class="fm-roof-icon" data-lengths aria-label="Line lengths" title="Line lengths" aria-pressed="false">${icon('<path d="M4 17h16M4 14v6M20 14v6"/><path d="M8 9h8M8 9l2-2M8 9l2 2M16 9l-2-2M16 9l-2 2"/>')}</button><button type="button" class="fm-roof-icon" data-measure aria-label="Measure" title="Measure: click two points on the model" aria-pressed="false">${icon('<path d="m3 17 14-14 4 4L7 21z"/><path d="m7 13 2 2m1-5 2 2m1-5 2 2"/>')}</button><button type="button" class="fm-roof-icon" data-reset aria-label="Reset view" title="Reset view">${icon('<path d="M3 10a9 9 0 1 1 2.5 9M3 4v6h6"/>')}</button></div><div class="fm-roof-control-row" data-layer-row hidden><div class="fm-roof-layers" role="group" aria-label="Layers"><button type="button" data-layer="roof" aria-pressed="true">Roof</button><button type="button" data-layer="walls" aria-pressed="true">Walls</button><button type="button" data-layer="base" aria-pressed="true">Base</button></div></div><div class="fm-roof-measure-bar" data-measure-bar hidden><span data-measure-status>Click a point on the model</span><button type="button" data-measure-clear hidden>Clear</button><button type="button" data-measure-done>Done</button></div></div><div class="fm-roof-card" data-card hidden></div><div class="fm-roof-design-bar" data-design-bar hidden><div class="fm-roof-layers" role="group" aria-label="Design"><button type="button" data-design-mode="built" aria-pressed="true" title="The house as it was measured">As built</button><button type="button" data-design-mode="projected" aria-pressed="false" title="The finishes you are trying">Projected</button></div><button type="button" class="fm-roof-design-open" data-design-open aria-pressed="false" title="Choose colors and materials">${icon('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>')}Design</button></div><aside class="fm-roof-design" data-design-panel hidden aria-label="Projected design"></aside><div class="fm-roof-legend"><div class="fm-roof-measure-tabs" role="tablist" aria-label="Roof measurements"><button type="button" role="tab" data-key-tab="lines" aria-selected="true">Line types</button><button type="button" role="tab" data-key-tab="walls" aria-selected="false" hidden>Walls</button><button type="button" role="tab" data-key-tab="openings" aria-selected="false" hidden>Openings</button><button type="button" role="tab" data-key-tab="pitches" aria-selected="false">Pitches</button><button type="button" role="tab" data-key-tab="summary" aria-selected="false">Summary</button><button type="button" role="tab" data-key-tab="measures" aria-selected="false" hidden>Measured</button><button type="button" data-key aria-expanded="true">${icon('<path d="m6 9 6 6 6-6"/>')}</button></div><div class="fm-roof-key-tray"><div class="fm-roof-key-body"><div class="fm-roof-key" data-key-panel="lines" role="tabpanel"></div><div class="fm-roof-keys" data-key-panel="walls" role="tabpanel" hidden></div><div class="fm-roof-keys" data-key-panel="openings" role="tabpanel" hidden></div><div class="fm-roof-pitches" data-key-panel="pitches" role="tabpanel" hidden></div><div class="fm-roof-summary" data-key-panel="summary" role="tabpanel" hidden></div><div class="fm-roof-measures" data-key-panel="measures" role="tabpanel" hidden data-empty></div></div></div></div><div class="fm-roof-message" role="status">Loading roof model…</div><div class="fm-roof-hint">Drag to orbit · Scroll to zoom · Click to inspect</div></div></div>`;
    const gallery=root.firstElementChild,stage=root.querySelector('.fm-roof-stage'),canvas=root.querySelector('.fm-roof-canvas'),library=root.querySelector('.fm-roof-library'),tools=root.querySelector('.fm-roof-tools'),key=root.querySelector('.fm-roof-key'),legend=root.querySelector('.fm-roof-legend'),keyToggle=root.querySelector('[data-key]'),message=root.querySelector('.fm-roof-message'),hint=root.querySelector('.fm-roof-hint'),card=root.querySelector('[data-card]'),measureBar=root.querySelector('[data-measure-bar]');
    const panel=name=>legend.querySelector(`[data-key-panel="${name}"]`);
    if(standalone){gallery.classList.add('is-single');library.hidden=true;}
    canvas.append(hint);legend.classList.toggle('is-collapsed',!keyVisible);keyToggle.setAttribute('aria-expanded',String(keyVisible));keyToggle.setAttribute('aria-label',keyVisible?'Collapse key':'Expand key');
    const entries=[{id:'model',label:'3D roof model'},...media.map((m,i)=>({...m,id:'media-'+i}))];
    let drawQueued=false;
    function draw(){if(disposed||!renderer||selection!=='model')return;declutter();
      if(renderedKey&&window.ExteriorRendered?.render(renderer,scene,camera)){overlayPass();return;}
      renderer.render(scene,camera);}
    // Over the rendered scene (whose depth is kept): every line, label and measure, and a translucent wash over
    // the hovered, selected or highlighted surfaces. House surfaces themselves are drawn by ExteriorRendered.
    let washes;
    function overlayPass(){
      const T=window.THREE;washes||={picked:wash(T,.42),category:wash(T,.3),hovered:wash(T,.16)};
      const swapped=[],background=scene.background;scene.background=null;
      for(const item of items){if(!item.mesh||item.roofOnly)continue;const tone=picked===item?'picked':item.category===selectedCategory?'category':hovered===item?'hovered':null;
        for(const mesh of meshesOf(item)){swapped.push([mesh,mesh.material,mesh.visible]);if(tone)mesh.material=washes[tone];else mesh.visible=false;}}
      const clear=renderer.autoClear;renderer.autoClear=false;
      try{renderer.render(scene,camera);}finally{renderer.autoClear=clear;scene.background=background;for(const [mesh,material,visible] of swapped){mesh.material=material;mesh.visible=visible;}}
    }
    function wash(T,opacity){const m=new T.MeshBasicMaterial({color:'#2e90fa',transparent:true,opacity,depthWrite:false,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4});objects.push(m);return m;}
    // The editor's Textured view: rebuilt only when the texture mode or a layer changes, never on hover.
    function syncRendered(){
      const R=window.ExteriorRendered;if(!exterior||!R||!finishes||!scene)return;
      const key=textureEnabled?JSON.stringify(layers):'';if(key===renderedKey)return;renderedKey=key;
      try{if(key){if(gradeMesh)gradeMesh.visible=layers.base!==false;R.update(scene,{enabled:true,scene,vector:exteriorVector});R.assetsReady?.().then(()=>drawSoon());}else R.update(null,{enabled:false});}
      catch(_){renderedKey='';try{R.update(null,{enabled:false});}catch(__){}}
      finally{if(gradeMesh)gradeMesh.visible=false;}
    }
    // Length pills: the house hides the ones behind it, and a smaller pill yields to a larger one it overlaps.
    function declutter(){
      const wanted=items.filter(item=>item.lengthLabel&&item.lengthWanted);if(!wanted.length)return;
      const width=canvas.clientWidth,height=canvas.clientHeight,k=height/(2*Math.tan(camera.fov*Math.PI/360)),v=new window.THREE.Vector3(),placed=[];
      wanted.sort((a,b)=>(b===picked)-(a===picked)||(b.category===selectedCategory)-(a.category===selectedCategory)||b.length-a.length);
      for(const item of wanted){const sprite=item.lengthLabel,anchor=sprite.userData.anchor;sprite.position.copy(anchor).add(v.copy(camera.position).sub(anchor).normalize().multiplyScalar(1.6));
        const distance=sprite.position.distanceTo(camera.position);v.copy(sprite.position).project(camera);if(v.z>1){sprite.visible=false;continue;}
        const x=(v.x+1)/2*width,y=(1-v.y)/2*height,w=sprite.scale.x*k/distance/2+3,h=sprite.scale.y*k/distance/2+2,box=[x-w,x+w,y-h,y+h];
        sprite.visible=item===picked||!placed.some(p=>p[0]<box[1]&&box[0]<p[1]&&p[2]<box[3]&&box[2]<p[3]);if(sprite.visible)placed.push(box);}
    }
    function drawSoon(){if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;draw();});}
    // A standalone viewer wide enough for a column shows every panel beside the model; narrower panes keep the tray.
    function placeLegend(){const side=standalone&&layout!=='stacked'&&(layout==='side'||gallery.clientWidth>=900);if(side===sideLayout&&legend.parentElement===(side?gallery:stage))return;sideLayout=side;gallery.classList.toggle('is-side',side);gallery.classList.toggle('is-single',standalone&&!side);if(side)gallery.prepend(legend);else stage.append(legend);}
    function resize(){if(disposed)return;placeLegend();gallery.classList.toggle('is-compact',!standalone&&gallery.clientWidth<800);const columns=stage.clientWidth>=850?5:stage.clientWidth>=620?4:stage.clientWidth>=360?3:2;for(const grid of legend.querySelectorAll('.fm-roof-key,.fm-roof-keys'))grid.style.gridTemplateColumns=`repeat(${grid.dataset.keyPanel==='lines'?columns:Math.max(2,columns-2)},minmax(0,1fr))`;if(renderer&&canvas.clientWidth&&canvas.clientHeight){renderer.setSize(canvas.clientWidth,canvas.clientHeight);const aspect=canvas.clientWidth/canvas.clientHeight;camera.position.sub(controls.target).multiplyScalar(Math.max(1,1/aspect)/Math.max(1,1/camera.aspect)).add(controls.target);camera.aspect=aspect;camera.updateProjectionMatrix();draw();}}

    function select(entry){
      selection=entry.id; stage.querySelector('.fm-roof-media')?.remove();
      const model=selection==='model';canvas.hidden=!model;tools.hidden=!model;hint.hidden=!model;legend.hidden=!model;card.hidden=!model||!picked;legend.classList.toggle('is-collapsed',!keyVisible);keyToggle.setAttribute('aria-expanded',String(keyVisible));message.hidden=!model||modelLoaded;
      library.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.id===entry.id)));
      if(!model){const el=document.createElement(entry.video?'video':'img');el.className='fm-roof-media';el.src=entry.url;el.alt=entry.label;if(entry.video){el.controls=true;el.playsInline=true;}el.onerror=()=>{message.hidden=false;message.textContent='This media could not load.';};stage.append(el);}else resize();
    }
    for(const entry of entries){const button=document.createElement('button');button.type='button';button.className='fm-roof-thumb';button.dataset.id=entry.id;button.setAttribute('aria-pressed',String(entry.id==='model'));
      if(entry.id==='model'){const tile=document.createElement('div');tile.style.cssText='height:66px;display:grid;place-items:center;color:#667085;font-size:32px';tile.textContent='⬡';tile.setAttribute('aria-hidden','true');button.append(tile);}
      if(entry.url&&!entry.solar){const img=document.createElement(entry.video?'video':'img');img.src=entry.url;if(entry.video){img.muted=true;img.preload='metadata';}else{img.alt='';img.loading='lazy';}button.append(img);}
      if(entry.solar){
        const source=entry.url;entry.url='';
        (async()=>{
          if(!window.GeoTIFF)await (solarLibrary ||= script('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js').catch(e=>{solarLibrary=null;throw e;}));
          const response=await fetch(source,{credentials:'same-origin',signal:controller.signal});if(!response.ok)throw new Error('Solar image unavailable.');
          const tiff=await window.GeoTIFF.fromArrayBuffer(await response.arrayBuffer()),image=await tiff.getImage();
          const factor=Math.min(1,1600/Math.max(image.getWidth(),image.getHeight())),width=Math.round(image.getWidth()*factor),height=Math.round(image.getHeight()*factor);
          const rgb=await image.readRGB({width,height,interleave:true});if(disposed)return;
          const target=document.createElement('canvas');target.width=width;target.height=height;const context=target.getContext('2d'),pixels=context.createImageData(width,height);
          const channels=rgb.length/(width*height);for(let i=0;i<width*height;i++){for(let c=0;c<3;c++)pixels.data[i*4+c]=rgb[i*channels+c];pixels.data[i*4+3]=255;}context.putImageData(pixels,0,0);
          const blob=await new Promise(resolve=>target.toBlob(resolve,'image/png'));if(disposed||!blob)return;
          entry.url=URL.createObjectURL(blob);ownedUrls.push(entry.url);const thumbnail=document.createElement('img');thumbnail.src=entry.url;thumbnail.alt='';button.prepend(thumbnail);if(selection===entry.id)select(entry);
        })().catch(()=>{if(!disposed){button.disabled=true;button.title='Solar image could not load';}});
      }
      const label=document.createElement('span');label.textContent=entry.label;button.append(label);button.onclick=()=>{if(entry.solar&&!entry.url){message.textContent='Loading solar image…';message.hidden=false;return;}select(entry);};library.append(button);
    }
    function reset(){if(!camera)return;const aspect=canvas.clientWidth&&canvas.clientHeight?canvas.clientWidth/canvas.clientHeight:1;camera.position.set(1,1,1.3).normalize().multiplyScalar(190*Math.max(1,1/aspect));controls.target.set(0,0,0);controls.update();draw();}
    // ---- Labels: one painter for pitch, area and length pills ----
    function paintLabel(sprite,parts){
      const canvas=sprite.userData.canvas,c=canvas.getContext('2d'),font='600 26px Arial';
      const pad=9,size=18,gap=5,divider=15,height=40;c.font=font;let width=pad*2+divider*(parts.length-1);for(const part of parts){part.width=c.measureText(part.text).width;width+=(part.icon?size+gap:0)+part.width;}
      const span=Math.ceil(width);canvas.width=span*2;canvas.height=height*2;c.scale(2,2);c.font=font;c.textAlign='left';c.textBaseline='middle';c.lineJoin='round';
      const radius=13,tone=sprite.userData.tone;c.beginPath();c.moveTo(radius,1);c.arcTo(span-1,1,span-1,height-1,radius);c.arcTo(span-1,height-1,1,height-1,radius);c.arcTo(1,height-1,1,1,radius);c.arcTo(1,1,span-1,1,radius);c.closePath();c.fillStyle=tone==='measure'?'#f79009':tone==='selected'?'#101828':'rgba(255,255,255,.78)';c.fill();c.strokeStyle='rgba(29,41,57,.28)';c.lineWidth=1.5;c.stroke();
      const ink=tone==='measure'||tone==='selected'?'#ffffff':'#101828';
      let x=pad;parts.forEach((part,index)=>{if(index){c.strokeStyle='rgba(29,41,57,.3)';c.lineWidth=1.5;c.beginPath();c.moveTo(x+divider/2,9);c.lineTo(x+divider/2,height-9);c.stroke();x+=divider;}
        if(part.icon){c.strokeStyle=ink==='#ffffff'?'#ffffff':'#475467';c.lineWidth=2;c.beginPath();if(part.icon==='pitch'){c.moveTo(x+1,28);c.lineTo(x+size-1,28);c.lineTo(x+size-1,13);c.closePath();}else if(part.icon==='area')c.rect(x+2,13,14,14);else{c.moveTo(x+1,20);c.lineTo(x+size-1,20);c.moveTo(x+1,15);c.lineTo(x+1,25);c.moveTo(x+size-1,15);c.lineTo(x+size-1,25);}c.stroke();x+=size+gap;}
        c.fillStyle=ink;c.fillText(part.text,x,height/2+1);x+=part.width;});
      sprite.material.map.dispose();sprite.material.map.needsUpdate=true;const world=sprite.userData.size||2.4;sprite.scale.set(world*span/height,world,1);
    }
    function labelSprite(position,data={},owner=objects){const T=window.THREE,label=document.createElement('canvas');label.width=160;label.height=40;const image=new T.CanvasTexture(label),material=new T.SpriteMaterial({map:image,depthTest:false,depthWrite:false,transparent:true}),sprite=new T.Sprite(material);sprite.renderOrder=20;sprite.position.copy(position);sprite.userData={canvas:label,...data};owner.push(image,material);return sprite;}
    // ---- Categories and highlighting ----
    const categoryOf=item=>item.category;
    const visibleLayer=item=>layers[item.layer]!==false;
    function categoryItems(category){return items.filter(item=>item.category===category);}
    function applyAppearance(){
      geometryGroup?.children.forEach(mesh=>{if(mesh.userData.roofOnlyMaterial){const mat=mesh.material;mat.map=textureEnabled?texture:null;mat.color.set(textureEnabled?'#ffffff':'#cbd5e1');mat.transparent=!textureEnabled;mat.opacity=textureEnabled?1:.62;mat.depthWrite=textureEnabled;mat.needsUpdate=true;}});
      for(const item of items)if(item.mesh)(item.roofOnly?glow(item):finishMaterial(item));
      for(const [name,group] of Object.entries(groups))group.visible=layers[name]!==false;
      if(lineGroup)lineGroup.visible=layers.roof!==false;
      for(const item of items){
        if(!item.line)continue;const inCategory=item.category===selectedCategory,isPicked=picked===item,isHovered=hovered===item&&!isPicked,lit=inCategory||isPicked,dim=(!!selectedCategory||!!picked)&&!lit&&!isHovered;
        const base=item.layer==='walls'?wallEdges[item.edgeType][0]:styles[item.type][0];
        item.line.material.color.set(isPicked||isHovered?'#fdb022':inCategory?'#ffffff':base);item.line.material.transparent=dim||isHovered;item.line.material.opacity=dim?.18:isHovered?.6:1;item.line.material.depthTest=!(lit||isHovered);item.line.renderOrder=lit||isHovered?5:2;
        item.line.visible=coloredLinesEnabled||lit||isHovered||!!selectedCategory;
      }
      for(const item of items)if(item.lengthLabel){const solid=picked===item||lengthsEnabled;item.lengthLabel.material.opacity=solid?1:.62;item.lengthWanted=visibleLayer(item)&&(picked===item||hovered===item||lengthsEnabled&&(item.category===selectedCategory||!selectedCategory&&item.length>=2&&(item.kind!=='wallEdge'||!!wallEdges[item.edgeType][2])));item.lengthLabel.visible=item.lengthWanted;}
      if(pitchGroup){pitchGroup.visible=layers.roof!==false&&(pitchEnabled||areaEnabled);if(pitchEnabled||areaEnabled)pitchGroup.children.forEach(sprite=>{const squares=sprite.userData.area/100,parts=[];
        if(pitchEnabled)parts.push({icon:'pitch',text:sprite.userData.pitch+'/12'});if(areaEnabled)parts.push({icon:'area',text:(squares>0&&squares<.05?'<0.1':squares.toFixed(1))+' sq'});paintLabel(sprite,parts);});}
      if(groups.wallLabels){groups.wallLabels.visible=layers.walls!==false;groups.wallLabels.children.forEach(sprite=>{const item=sprite.userData.item;sprite.visible=areaEnabled&&(item.area>=12||picked===item||item.category===selectedCategory)||picked===item||hovered===item;sprite.material.opacity=areaEnabled||picked===item?1:.62;});}
      // Roof faces and openings show their measurement while hovered (faint) or selected.
      for(const item of items)if(item.faceLabel){item.faceLabel.visible=visibleLayer(item)&&(picked===item||hovered===item);item.faceLabel.material.opacity=picked===item?1:.62;}
      legend.querySelectorAll('[data-category]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.category===selectedCategory)));
      key.querySelectorAll('[data-edge-select]').forEach(button=>button.setAttribute('aria-pressed',String('line:'+button.dataset.edgeSelect===selectedCategory)));
      for(const [name,on] of [['area',areaEnabled],['pitch',pitchEnabled],['texture',textureEnabled],['lines',coloredLinesEnabled],['lengths',lengthsEnabled],['measure',measuring]])tools.querySelector(`[data-${name}]`).setAttribute('aria-pressed',String(on));
      tools.querySelectorAll('[data-layer]').forEach(button=>button.setAttribute('aria-pressed',String(layers[button.dataset.layer]!==false)));
      syncRendered();renderCard();renderDesignPanel();drawSoon();
    }
    // Faces: the editor's finish when textured, its flat color otherwise; a selected face or category glows.
    const meshesOf=item=>item.meshes||[item.mesh];
    // Unlit editor materials have no emissive: a selected face blends toward the highlight from its own finish color.
    function glow(item){const lit=picked===item?.55:item.category===selectedCategory?.35:hovered===item?.18:0;for(const mesh of meshesOf(item)){const m=mesh.material;if(m.emissive&&item.roofOnly){m.emissive.set(lit?'#2e90fa':'#000000');m.emissiveIntensity=lit;continue;}if(!mesh.userData.baseColor)continue;m.color.copy(mesh.userData.baseColor);if(lit)m.color.lerp(highlight(),lit);}}
    let highlightColor;const highlight=()=>highlightColor||=new window.THREE.Color('#2e90fa').convertSRGBToLinear();
    // Textured is exactly the editor's Textured view (ExteriorFinishes.apply); untextured keeps its flat finish colors,
    // shaded by facing as apply() shades them.
    function finishMaterial(item){
      const F=finishes,textured=!!(textureEnabled&&F&&item.finish);
      if(item.textured!==textured){item.textured=textured;
        for(const mesh of meshesOf(item)){const m=mesh.material;
          if(textured){F.reset?.(m);F.apply(mesh,m);}
          else{F?.reset?.(m);m.map=null;m.color.set(item.flat||'#d0d5dd');m.color.convertSRGBToLinear?.();const n=mesh.userData.exteriorFinish?.normal;if(n)m.color.multiplyScalar(.78+.22*Math.abs(n.x*.37+n.y*.53+n.z*.76));}
          mesh.userData.baseColor=m.color.clone();m.needsUpdate=true;}}
      glow(item);
    }
    tools.querySelector('[data-area]').onclick=()=>{areaEnabled=!areaEnabled;applyAppearance();};
    tools.querySelector('[data-pitch]').onclick=()=>{pitchEnabled=!pitchEnabled;applyAppearance();};
    tools.querySelector('[data-texture]').onclick=()=>{textureEnabled=!textureEnabled;applyAppearance();};
    tools.querySelector('[data-lines]').onclick=()=>{coloredLinesEnabled=!coloredLinesEnabled;applyAppearance();};
    tools.querySelector('[data-lengths]').onclick=()=>{lengthsEnabled=!lengthsEnabled;ensureLengthLabels();applyAppearance();};
    tools.querySelectorAll('[data-layer]').forEach(button=>button.onclick=()=>{layers[button.dataset.layer]=layers[button.dataset.layer]===false;if(picked&&!visibleLayer(picked))picked=null;applyAppearance();});
    tools.querySelector('[data-measure]').onclick=()=>setMeasuring(!measuring);
    measureBar.querySelector('[data-measure-done]').onclick=()=>setMeasuring(false);
    measureBar.querySelector('[data-measure-clear]').onclick=()=>{for(const m of measures)m.group.parent?.remove(m.group);measures.length=0;cancelMeasure();renderMeasures();applyAppearance();};
    keyToggle.onclick=()=>{keyVisible=!keyVisible;legend.classList.toggle('is-collapsed',!keyVisible);keyToggle.setAttribute('aria-expanded',String(keyVisible));keyToggle.setAttribute('aria-label',keyVisible?'Collapse key':'Expand key');resize();};tools.querySelector('[data-reset]').onclick=reset;
    const keyTabs=()=>[...legend.querySelectorAll('[data-key-tab]')].filter(b=>!b.hidden);
    function showKeyTab(next,expand=false){if(!keyTabs().some(b=>b.dataset.keyTab===next))next='lines';keyTab=next;for(const panel of legend.querySelectorAll('[data-key-panel]'))panel.hidden=panel.dataset.keyPanel!==keyTab;for(const button of legend.querySelectorAll('[data-key-tab]')){const active=button.dataset.keyTab===keyTab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}if(expand&&!keyVisible)keyToggle.click();resize();}
    legend.querySelectorAll('[data-key-tab]').forEach(button=>{button.onclick=()=>showKeyTab(button.dataset.keyTab,true);button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=keyTabs(),index=tabs.indexOf(button),next=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.click();next.focus();}};});showKeyTab(keyTab);
    function selectCategory(category){selectedCategory=selectedCategory===category?null:category;if(selectedCategory&&lengthsEnabled)ensureLengthLabels();applyAppearance();}
    // ---- Selection card ----
    function renderCard(){
      if(!picked||selection!=='model'){card.hidden=true;card.replaceChildren();return;}
      const item=picked,rows=item.details();card.hidden=false;card.innerHTML='';
      const header=document.createElement('header'),swatch=document.createElement('i'),title=document.createElement('strong'),close=document.createElement('button');
      swatch.style.background=item.swatch||'#98a2b3';title.textContent=item.title;title.title=item.title;close.type='button';close.textContent='×';close.setAttribute('aria-label','Clear selection');close.onclick=()=>{picked=null;applyAppearance();};header.append(swatch,title,close);
      const list=document.createElement('dl');for(const [name,value] of rows){if(value==null||value==='')continue;const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;list.append(dt,dd);}
      card.append(header,list);
    }
    // ---- Picking and measuring ----
    let raycaster,pointer,hoverEvent=null,hoverQueued=false;
    // Hover previews exactly what a click would select, fainter than the selection.
    function setHovered(item){if(item===hovered)return;hovered=item;if(item?.line)addLengthLabel(item);if(item)ensureFaceLabel(item);if(renderer)renderer.domElement.style.cursor=item?'pointer':'';applyAppearance();}
    function ensureFaceLabel(item){if(item.faceLabel||!item.labelAnchor||!item.labelParts)return;const sprite=labelSprite(item.labelAnchor,{size:2.1});paintLabel(sprite,item.labelParts());(item.layer==='roof'?groups.roof:groups.walls).add(sprite);item.faceLabel=sprite;}
    const pickables=()=>items.filter(item=>visibleLayer(item)&&(item.mesh||item.line)).flatMap(item=>item.mesh?meshesOf(item):[item.line]);
    function ndc(event){const box=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);raycaster.setFromCamera(pointer,camera);raycaster.params.Line.threshold=camera.position.distanceTo(controls.target)*.012;}
    function pick(event){
      ndc(event);const hits=raycaster.intersectObjects(pickables(),false);if(!hits.length)return null;
      const surface=hits.find(hit=>hit.object.isMesh),line=hits.find(hit=>hit.object.isLine);
      if(line&&(!surface||line.distance<=surface.distance+raycaster.params.Line.threshold))return line.object.userData.item;
      // Openings and fascia sit on their wall plane; at equal depth the feature wins.
      const near=hits.filter(hit=>hit.object.isMesh&&hit.distance<=surface.distance+.05).map(hit=>hit.object.userData.item);
      return near.sort((a,b)=>(b.priority||0)-(a.priority||0))[0]||null;
    }
    function surfacePoint(event){
      ndc(event);const hit=raycaster.intersectObjects(items.filter(item=>item.mesh&&visibleLayer(item)).flatMap(meshesOf).concat(geometryGroup?.children.filter(m=>m.userData.roofOnlyMaterial)||[]),false)[0];if(!hit)return null;
      // Snap to the nearest model corner within the line pick radius.
      let best=hit.point.clone(),distance=raycaster.params.Line.threshold*1.5;
      for(const item of items)if(item.ends&&visibleLayer(item))for(const end of item.ends){const d=end.distanceTo(hit.point);if(d<distance){distance=d;best=end.clone();}}
      return best;
    }
    function measureLine(a,b,group,owner=objects){const T=window.THREE,geo=new T.BufferGeometry().setFromPoints([a,b]),mat=new T.LineBasicMaterial({color:'#f79009',depthTest:false,transparent:true});const line=new T.Line(geo,mat);line.renderOrder=30;owner.push(geo,mat);group.add(line);const dotGeo=new T.SphereGeometry(.45,12,8),dotMat=new T.MeshBasicMaterial({color:'#f79009',depthTest:false});owner.push(dotGeo,dotMat);for(const p of [a,b]){const dot=new T.Mesh(dotGeo,dotMat);dot.position.copy(p);dot.renderOrder=30;group.add(dot);}const ft=a.distanceTo(b)/scale,sprite=labelSprite(a.clone().add(b).multiplyScalar(.5),{tone:'measure',size:2.6},owner);sprite.position.y+=1.2;paintLabel(sprite,[{icon:'length',text:ftIn(ft)}]);group.add(sprite);return ft;}
    let previewOwned=[];function clearPreview(){measurePreview?.parent?.remove(measurePreview);measurePreview=null;previewOwned.forEach(o=>o.dispose());previewOwned=[];}
    function cancelMeasure(){measureStart=null;clearPreview();measureBar.querySelector('[data-measure-status]').textContent='Click a point on the model';}
    function setMeasuring(on){measuring=on;canvas.classList.toggle('is-measuring',on);measureBar.hidden=!on;if(!on)cancelMeasure();if(on){picked=null;}applyAppearance();}
    function renderMeasures(){const host=panel('measures');host.replaceChildren();host.toggleAttribute('data-empty',!measures.length);legend.querySelector('[data-key-tab="measures"]').hidden=!measures.length;measureBar.querySelector('[data-measure-clear]').hidden=!measures.length;
      const title=document.createElement('h4');title.className='fm-roof-section-title';title.textContent='Measured';host.append(title);
      measures.forEach((m,i)=>{const row=document.createElement('div'),name=document.createElement('span'),value=document.createElement('strong'),remove=document.createElement('button');name.textContent='Measurement '+(i+1);value.textContent=`${ftIn(m.ft)} (${decimal(m.ft,2)} ft)`;remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Remove measurement '+(i+1));remove.onclick=()=>{m.group.parent?.remove(m.group);measures.splice(i,1);renderMeasures();drawSoon();};row.append(name,value,remove);host.append(row);});
      if(!measures.length&&keyTab==='measures')showKeyTab('lines');
    }
    function measureClick(event){
      const point=surfacePoint(event);if(!point)return;
      if(!measureStart){measureStart=point;measureBar.querySelector('[data-measure-status]').textContent='Click the second point';return;}
      const group=new window.THREE.Group();groups.measures.add(group);const ft=measureLine(measureStart,point,group);measures.push({group,ft});cancelMeasure();measureBar.querySelector('[data-measure-status]').textContent=`${ftIn(ft)} · click to measure again`;renderMeasures();drawSoon();
    }
    function measureMove(event){
      if(!measuring||!measureStart)return;const point=surfacePoint(event);clearPreview();if(!point){drawSoon();return;}
      measurePreview=new window.THREE.Group();groups.measures.add(measurePreview);const ft=measureLine(measureStart,point,measurePreview,previewOwned);measureBar.querySelector('[data-measure-status]').textContent=ftIn(ft);drawSoon();
    }
    // ---- Line length labels (lazy: hundreds of edges on a full house) ----
    let lengthLabelsBuilt=false;
    function ensureLengthLabels(){if(lengthLabelsBuilt||!scene)return;lengthLabelsBuilt=true;for(const item of items)if(item.line&&item.length>0)addLengthLabel(item);}
    function addLengthLabel(item){if(item.lengthLabel)return;const [a,b]=item.ends,middle=a.clone().add(b).multiplyScalar(.5),sprite=labelSprite(middle,{size:1.9,anchor:middle.clone()});sprite.material.depthTest=true;paintLabel(sprite,[{text:ftIn(item.length)}]);(item.layer==='walls'?groups.walls:groups.roof).add(sprite);item.lengthLabel=sprite;}
    observer=new ResizeObserver(resize);observer.observe(gallery);observer.observe(canvas);resize();
    (async()=>{
      if(!xmlUrl)throw new Error('The completed report does not contain a roof model yet.');
      const [response,exteriorResult]=await Promise.all([fetch(xmlUrl,{credentials:'same-origin',signal:controller.signal}),exteriorUrl?fetch(exteriorUrl,{credentials:'same-origin',signal:controller.signal}).then(r=>r.ok?r.json():null).catch(()=>null):null,loadLibraries()]);
      if(!response.ok)throw new Error('The roof model could not be loaded.');
      const roofs=parseModel(await response.text(),edgeTypes);if(disposed)return;
      exterior=exteriorResult?.model&&Array.isArray(exteriorResult.model.walls)&&exteriorResult.model.walls.length?exteriorResult.model:null;
      if(exterior){finishes=await loadFinishes();frame=exteriorFrame(exterior,roofs);if(disposed)return;
        // ExteriorFinishes and ExteriorRendered read the editor's finish defaults from WallMode; the portal has no editor.
        if(finishes&&(!window.WallMode||window.WallMode.viewerShim)){window.WallMode={viewerShim:true,finishDefaults:exterior.finishDefaults||{}};ownsWallMode=true;}}
      const T=window.THREE;scene=new T.Scene();scene.background=new T.Color('#eef1f5');camera=new T.PerspectiveCamera(42,1,1,3000);
      renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));canvas.append(renderer.domElement);
      controls=new T.OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.minDistance=4;controls.addEventListener('change',draw);
      raycaster=new T.Raycaster();pointer=new T.Vector2();
      scene.add(new T.HemisphereLight(0xffffff,0x687080,.8));const light=new T.DirectionalLight(0xffffff,.45);light.position.set(30,80,40);scene.add(light);
      const exteriorPoints=exterior?[...exterior.walls.flatMap(w=>w.points),...(exterior.base||[]).flatMap(f=>f.points)].map(frame.toFeet):[];
      const all=[...roofs.flatMap(r=>[...r.points.values()]),...exteriorPoints],min=[0,1,2].map(i=>Math.min(...all.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...all.map(p=>p[i])));scale=100/Math.max(...max.map((v,i)=>v-min[i]),1);
      const point=p=>new T.Vector3((p[0]-(min[0]+max[0])/2)*scale,(p[2]-(min[2]+max[2])/2)*scale,-(p[1]-(min[1]+max[1])/2)*scale);
      const tile=document.createElement('canvas');tile.width=128;tile.height=128;const ctx=tile.getContext('2d');ctx.fillStyle='#706e69';ctx.fillRect(0,0,128,128);for(let y=0;y<128;y+=16){ctx.fillStyle=y%32?'#777570':'#696863';ctx.fillRect(0,y,128,15);ctx.strokeStyle='#454541';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(128,y);for(let x=y%32?16:0;x<128;x+=32){ctx.moveTo(x,y);ctx.lineTo(x,y+16);}ctx.stroke();}
      texture=new T.CanvasTexture(tile);texture.wrapS=texture.wrapT=T.RepeatWrapping;
      geometryGroup=new T.Group();lineGroup=new T.Group();pitchGroup=new T.Group();groups.roof=new T.Group();groups.walls=new T.Group();groups.base=new T.Group();groups.measures=new T.Group();groups.wallLabels=new T.Group();
      groups.roof.add(geometryGroup,lineGroup,pitchGroup);groups.walls.add(groups.wallLabels);scene.add(groups.roof,groups.walls,groups.base,groups.measures);const types=new Set();
      // Triangulate a planar polygon with holes in its own plane.
      function polygonGeometry(rings,uvs){const outer=rings[0],n=newell(outer)||[0,0,1],u=Math.abs(n[2])<.9?cross3([0,0,1],n):[1,0,0],ul=Math.hypot(...u),uu=u.map(x=>x/ul),vv=cross3(n,uu),flat=rings.flat(),project=ring=>ring.map(p=>new T.Vector2(dot3(p,uu),dot3(p,vv)));
        const triangles=T.ShapeUtils.triangulateShape(project(outer),rings.slice(1).map(project)),pos=[],uv=[],feet=flat.map(frame?frame.toFeet:(p=>p));
        for(const tri of triangles)for(const i of tri){pos.push(...point(feet[i]).toArray());if(uvs)uv.push(...uvs[i]);}
        const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));if(uvs)geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.computeVertexNormals();objects.push(geo);return geo;}
      const fullHouse=!!exterior,roofFinish=exterior?.roofFinish||null,defaults=exterior?.defaults||{};
      // Full-house roofs share the walls' depth order: roof wins ties with walls, fascia with roof, openings with all.
      const surfaceMaterial=offset=>{const mat=new T.MeshStandardMaterial({side:T.DoubleSide,roughness:1,polygonOffset:true,polygonOffsetFactor:offset,polygonOffsetUnits:offset});objects.push(mat);return mat;};
      for(const roof of roofs){
        const near=(a,b)=>a.some(p=>b.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<.05)),found=[];
        for(const opening of roof.openings){if(opening.kind==='opening')continue;const touching=found.filter(group=>group.kind===opening.kind&&near(group.points,opening.points));const points=[...opening.points,...touching.flatMap(group=>group.points)];touching.forEach(group=>found.splice(found.indexOf(group),1));found.push({kind:opening.kind,points});}
        for(const group of found){let rectangle=null;for(let i=0;i<group.points.length;i++){const p=group.points[i],q=group.points[(i+1)%group.points.length],angle=Math.atan2(q[1]-p[1],q[0]-p[0]),cos=Math.cos(angle),sin=Math.sin(angle),xy=group.points.map(([x,y])=>[x*cos+y*sin,-x*sin+y*cos]);const width=Math.max(...xy.map(p=>p[0]))-Math.min(...xy.map(p=>p[0])),height=Math.max(...xy.map(p=>p[1]))-Math.min(...xy.map(p=>p[1]));if(!rectangle||width*height<rectangle.area)rectangle={area:width*height,width:Math.min(width,height),height:Math.max(width,height)};}if(rectangle)openingGroups.push({...group,...rectangle});}
        for(const face of roof.faces){const rings=[face.points,...face.holes],flat=rings.flat(),vertices=flat.map(point),faceUVs=faceTextureUVs(face.points,flat);const project=ring=>ring.map(p=>new T.Vector2(p[0],p[1]));const triangles=T.ShapeUtils.triangulateShape(project(face.points),face.holes.map(project));const pos=[],uv=[];
          // A full house textures its roof with the editor's covering in metres; the roof-only shingle tile stays as it was.
          const metric=fullHouse&&frame.matchesXml?flat.map(frame.toMetres):null,roofUVs=metric?finishUVs(metric,'shingles',roofFinish,finishes):null;
          for(const tri of triangles)for(const i of tri){pos.push(...vertices[i].toArray());uv.push(...(roofUVs?roofUVs[i]:faceUVs[i]));}
          const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.computeVertexNormals();objects.push(geo);
          const anchor=faceLabelAnchor(face);
          if(fullHouse)reportRoofFaces.push({center:[0,1,2].map(i=>face.points.reduce((sum,p)=>sum+p[i],0)/face.points.length),pitch:anchor?.pitch??face.pitch,area:anchor?.area??face.area});
          if(fullHouse&&finishes){}
          else if(fullHouse){const mat=surfaceMaterial(1),mesh=new T.Mesh(geo,mat),n=newell(face.points)||[0,0,1];geometryGroup.add(mesh);const area=anchor?.area??face.area,pitch=anchor?.pitch??face.pitch;
            const item={kind:'roofFace',layer:'roof',category:'roof',mesh,priority:1,area,pitch,swatch:roofFinish?.color||'#4a4c4f',flat:'#9aa4b2',finish:true,title:'Roof face',details:()=>[['Pitch',pitch!=null?pitch+'/12':null],['Area',area!=null?`${decimal(area,0)} sq ft (${decimal(area/100,2)} sq)`:null],['Covering',roofFinish?finishes?.roofMaterials?.[roofFinish.category]?.label||roofFinish.category:null]]};
            mesh.userData={item,exteriorFinish:{material:'shingles',color:roofFinish?.color||null,roofMaterial:roofFinish||undefined,normal:{x:n[0],y:n[1],z:n[2]}}};items.push(item);}
          else{const mat=new T.MeshStandardMaterial({map:texture,side:T.DoubleSide,roughness:1,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});const mesh=new T.Mesh(geo,mat);mesh.userData.roofOnlyMaterial=true;const area=anchor?.area??face.area,pitch=anchor?.pitch??face.pitch;const item={kind:'roofFace',layer:'roof',category:'roof',mesh:null,area,pitch,title:'Roof face',swatch:'#706e69',details:()=>[['Pitch',pitch!=null?pitch+'/12':null],['Area',area!=null?`${decimal(area,0)} sq ft (${decimal(area/100,2)} sq)`:null]]};mesh.userData.item=item;item.pickMesh=mesh;geometryGroup.add(mesh);objects.push(mat);items.push(item);}
          if(anchor){faceMetrics.push(anchor);const sprite=labelSprite(point(anchor.point),{pitch:anchor.pitch,area:anchor.area,anchor:anchor.point});sprite.position.y+=.5;pitchGroup.add(sprite);}
        }
        for(const line of roof.lines.values()){const type=lineType(line.type);types.add(type);const ends=line.ids.map(id=>roof.points.get(id)),length=Math.hypot(...ends[0].map((value,i)=>value-ends[1][i]));lengths[type]=(lengths[type]||0)+length;const geo=new T.BufferGeometry().setFromPoints(line.ids.map(id=>point(roof.points.get(id))));const mat=new T.LineBasicMaterial({color:styles[type][0]});const edge=new T.Line(geo,mat);edge.renderOrder=2;edge.userData.type=type;lineGroup.add(edge);objects.push(geo,mat);
          const item={kind:'roofLine',layer:'roof',category:'line:'+type,type,line:edge,length,ends:ends.map(point),swatch:styles[type][0],title:styles[type][1],details:()=>[['Length',`${ftIn(length)} (${decimal(length)} ft)`],['Type','Roof line']]};edge.userData.item=item;items.push(item);}
      }
      // Roof-only meshes are picked through their item without the full-house finish path.
      for(const item of items)if(item.pickMesh){item.mesh=item.pickMesh;delete item.pickMesh;item.roofOnly=true;}
      if(fullHouse)buildExterior({T,point,polygonGeometry,surfaceMaterial,defaults});
      if(!geometryGroup.children.length&&!fullHouse){textureEnabled=false;tools.querySelector('[data-texture]').disabled=true;hint.textContent='Saved roof lines · Drag to orbit · Scroll to zoom';}
      if(fullHouse){if(initialState.lines===undefined)coloredLinesEnabled=false;tools.querySelector('[data-layer-row]').hidden=false;legend.querySelector('[data-key-tab="lines"]').textContent='Roof';for(const tab of ['walls','openings'])legend.querySelector(`[data-key-tab="${tab}"]`).hidden=false;legend.setAttribute('aria-label','Model measurements');}
      applyAppearance();
      syncMeasurements=function(){const values={...measurements,...(getMeasurements?.()||{})};for(const input of legend.querySelectorAll('[data-edge-measure]')){if(input===document.activeElement)continue;const measureKey=input.dataset.measureKey,row=values[measureKey],value=typeof row==='number'?row:row?.value,fallback=input.dataset.wallEdge?wallLengths[input.dataset.wallEdge]:lengths[input.dataset.edgeMeasure];input.value=Number.isFinite(value)?Number(value.toFixed(1)).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:1}):fallback!=null?Number(fallback.toFixed(1)).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:1}):'';}renderMetrics(values);};
      const wallLengths={};for(const item of items)if(item.kind==='wallEdge')wallLengths[item.edgeType]=(wallLengths[item.edgeType]||0)+item.length;
      function renderMetrics(values){
        const number=value=>Number(value.toFixed(2)).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:2}),value=key=>typeof values[key]==='number'?values[key]:values[key]?.value;
        let pitches=Object.entries(values).filter(([key,row])=>/^pitch\d+(?:\.\d+)?Squares$/.test(key)&&Number(typeof row==='number'?row:row?.value)>0).map(([key,row])=>({key,pitch:Number(key.match(/[\d.]+/)[0]),squares:typeof row==='number'?row:row.value}));
        if(!pitches.length){const byPitch=new Map();for(const face of faceMetrics)byPitch.set(face.pitch,(byPitch.get(face.pitch)||0)+face.area/100);pitches=[...byPitch].map(([pitch,squares])=>({key:`pitch${pitch}Squares`,pitch,squares}));}pitches.sort((a,b)=>a.pitch-b.pitch);
        const host=panel('pitches');host.replaceChildren();const heading=document.createElement('h4');heading.className='fm-roof-section-title';heading.textContent='Pitches';host.append(heading);const table=document.createElement('table'),body=document.createElement('tbody'),pitchRow=document.createElement('tr'),squareRow=document.createElement('tr');pitchRow.innerHTML='<th scope="row">Pitch</th>';squareRow.innerHTML='<th scope="row" title="1 roofing square = 100 square feet">Squares</th>';body.append(pitchRow,squareRow);body.style.setProperty('--rows',String(pitches.length+1));table.append(body);host.append(table);
        for(const row of pitches){const name=document.createElement('th');name.scope='col';name.textContent=row.pitch+'/12';name.title='Pitch is rise per 12 inches of horizontal run.';const cell=document.createElement('td'),input=document.createElement('input');input.type='text';input.inputMode='decimal';input.value=number(row.squares);input.setAttribute('aria-label',row.pitch+'/12 pitch squares');input.readOnly=!onMeasurementChange;let valid=input.value;input.oninput=()=>{if(!/^\d*(?:\.\d*)?$/.test(input.value))input.value=valid;else valid=input.value;};input.onkeydown=event=>{if(['e','E','+','-'].includes(event.key))event.preventDefault();};input.onchange=()=>{if(input.value!==''&&/^\d+(?:\.\d*)?$|^\.\d+$/.test(input.value)&&Number.isFinite(Number(input.value))){const next=Number(input.value);measurements={...measurements,[row.key]:{value:next}};onMeasurementChange?.(row.key,next);syncMeasurements();}else input.value=valid;};cell.append(input);pitchRow.append(name);squareRow.append(cell);}
        const summary=panel('summary');summary.replaceChildren();const title=document.createElement('h4');title.className='fm-roof-section-title';title.textContent='Summary';summary.append(title);const row=(name,content,tooltip='')=>{const item=document.createElement('div'),label=document.createElement('span'),data=document.createElement('strong');label.textContent=name;data.textContent=content;if(tooltip)item.title=tooltip;item.append(label,data);summary.append(item);};const group=name=>{if(!exterior)return;const h=document.createElement('h4');h.textContent=name;summary.append(h);};
        group('Roof');const dominant=pitches.reduce((best,pitch)=>!best||pitch.squares>best.squares?pitch:best,null);row('Predominant pitch',dominant?dominant.pitch+'/12':'—');row('Roof squares',number(value('roofSquares')??pitches.reduce((sum,pitch)=>sum+pitch.squares,0)),'1 roofing square = 100 square feet.');
        for(const [kind,name,countKey] of [['chimney','Chimneys','chimneysEa'],['skylight','Skylights','skylightsEa']]){const openings=openingGroups.filter(group=>group.kind===kind),dimensions=new Map();row(name,value(countKey)!=null?String(value(countKey)):openings.length?String(openings.length):'—','Count of classified saved model openings; an em dash means unavailable.');for(const opening of openings){const key=number(opening.width)+' × '+number(opening.height)+' ft';dimensions.set(key,(dimensions.get(key)||0)+1);}for(const [dimension,count] of dimensions)row(dimension,count+' '+(kind==='chimney'?(count===1?'chimney':'chimneys'):(count===1?'skylight':'skylights')),'Horizontal opening footprint dimensions from the saved model. These are not nominal product sizes.');if(!dimensions.size)row(name+' dimensions','—','No classified opening dimensions are available in this saved report.');}
        if(exterior){const totals=exterior.totals||{},sf=v=>Number.isFinite(v)?decimal(v,0)+' sq ft':'—',lf=v=>Number.isFinite(v)?decimal(v)+' ft':'—';
          group('Walls');row('Net wall area',sf(value('wallNetArea')??totals.net),'Wall area minus openings.');row('Gross wall area',sf(value('wallGrossArea')??totals.gross));row('Opening area',sf(value('wallOpeningArea')??totals.openingArea));row('Opening perimeter',lf(value('wallOpeningPerimeter')??totals.openingPerimeter));
          const counts={};for(const item of items)if(item.kind==='opening')counts[item.openingType]=(counts[item.openingType]||0)+1;group('Openings');for(const [type,[plural]] of Object.entries(openingKinds))row(plural,String(counts[type]||0));}
      }
      function keyRow(host,{category,color,name,title,measureKey,wallEdge,edgeType,valueText,unit}){
        const row=document.createElement('div');row.className='fm-roof-key-row';row.title=title||name;const button=document.createElement('button');button.type='button';button.dataset.category=category;if(edgeType)button.dataset.edgeSelect=edgeType;button.title=title||name;button.setAttribute('aria-label','Highlight '+(title||name));button.setAttribute('aria-pressed',String(selectedCategory===category));const swatch=document.createElement('i');swatch.style.background=color;const label=document.createElement('span');label.textContent=name;button.append(swatch,label);button.onclick=()=>selectCategory(category);row.append(button);
        if(measureKey){const input=document.createElement('input');input.type='text';input.inputMode='decimal';input.dataset.edgeMeasure=edgeType||wallEdge;input.dataset.measureKey=measureKey;if(wallEdge)input.dataset.wallEdge=wallEdge;input.setAttribute('aria-label',(title||name)+' length');input.placeholder='—';input.title=(title||name)+' · feet';input.readOnly=!onMeasurementChange;const small=document.createElement('small');small.textContent='ft';row.append(input,small);let valid='';input.onfocus=()=>{valid=input.value;};input.oninput=()=>{if(!/^\d*(?:\.\d*)?$/.test(input.value))input.value=valid;else valid=input.value;};input.onkeydown=event=>{if(['e','E','+','-'].includes(event.key))event.preventDefault();};input.onchange=()=>{if(!/^\d+(?:\.\d*)?$|^\.\d+$/.test(input.value)||!Number.isFinite(Number(input.value))){input.value=valid;return;}const value=Number(input.value);measurements={...measurements,[measureKey]:{value}};onMeasurementChange?.(measureKey,value);input.value=Number(value.toFixed(1)).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:1});valid=input.value;};}
        else if(valueText){const output=document.createElement('output');output.textContent=valueText;row.append(output);if(unit){const small=document.createElement('small');small.textContent=unit;row.append(small);}}
        host.append(row);return row;
      }
      const sectionTitle=(host,text)=>{const h=document.createElement('h4');h.className='fm-roof-section-title';h.textContent=text;host.append(h);};
      sectionTitle(key,exterior?'Roof lines':'Line types');
      const savedValues={...measurements,...(getMeasurements?.()||{})};
      for(const type of Object.keys(styles))if(!exterior||lengths[type]!=null||savedValues[measurementKeys[type]]!=null)keyRow(key,{category:'line:'+type,color:styles[type][0],name:shortNames[type]||styles[type][1],title:styles[type][1],measureKey:measurementKeys[type],edgeType:type});
      if(exterior){
        const walls=panel('walls'),openingsPanel=panel('openings'),group=(host,text)=>{const h=document.createElement('h4');h.className='fm-roof-key-group';h.textContent=text;host.append(h);};
        sectionTitle(walls,'Walls');group(walls,'Surfaces');
        const surfaces=new Map();for(const item of items)if(item.kind==='wall'){const entry=surfaces.get(item.category)||{area:0,swatch:item.swatch,name:item.categoryName};entry.area+=item.area;surfaces.set(item.category,entry);}
        for(const [category,entry] of [...surfaces].sort((a,b)=>b[1].area-a[1].area))keyRow(walls,{category,color:entry.swatch,name:entry.name,valueText:decimal(entry.area,0),unit:'sq ft'});
        if(items.some(item=>item.kind==='trim'))keyRow(walls,{category:'trim',color:defaults.trimColor||'#f5f3ef',name:'Fascia',title:'Roof trim (fascia)',valueText:'',unit:''});
        group(walls,'Edges');for(const [type,[color,name,measureKey]] of Object.entries(wallEdges))if(measureKey&&items.some(item=>item.edgeType===type))keyRow(walls,{category:'edge:'+type,color,name,measureKey,wallEdge:type});
        sectionTitle(openingsPanel,'Openings');
        for(const [type,[plural]] of Object.entries(openingKinds)){const list=items.filter(item=>item.kind==='opening'&&item.openingType===type);if(!list.length)continue;keyRow(openingsPanel,{category:'opening:'+type,color:flatOpening[type],name:plural,valueText:`${list.length} · ${decimal(list.reduce((s,i)=>s+i.area,0),0)}`,unit:'sq ft'});
          const sizes=new Map();for(const item of list){const key=`${ftIn(item.width)} × ${ftIn(item.height)}`;sizes.set(key,(sizes.get(key)||0)+1);}
          for(const [size,count] of [...sizes].sort((a,b)=>b[1]-a[1])){const row=document.createElement('div');row.className='fm-roof-key-row';row.style.cssText='background:transparent;border-color:transparent';const name=document.createElement('span');name.textContent=size;name.style.cssText='flex:1;padding-left:14px;color:#475467';const output=document.createElement('output');output.textContent='×'+count;row.append(name,output);openingsPanel.append(row);}}
        if(!items.some(item=>item.kind==='opening')){const empty=document.createElement('p');empty.style.cssText='grid-column:1/-1;margin:4px 0;color:#667085;font-size:11px';empty.textContent='No windows, doors or vents were drawn on this report.';openingsPanel.append(empty);}
      }
      syncMeasurements();unsubscribeMeasurements=subscribeMeasurements?.(syncMeasurements);renderMeasures();showKeyTab(keyTab);applyAppearance();
      // Click (not drag) selects; in measure mode it places points.
      let down=null;renderer.domElement.tabIndex=-1;renderer.domElement.style.outline='none';renderer.domElement.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY};renderer.domElement.focus({preventScroll:true});});
      renderer.domElement.addEventListener('pointerup',event=>{if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>6){down=null;return;}down=null;if(measuring){measureClick(event);return;}picked=pick(event);if(picked?.line)addLengthLabel(picked);if(picked)ensureFaceLabel(picked);applyAppearance();});
      renderer.domElement.addEventListener('pointermove',event=>{if(measuring&&!event.buttons){measureMove(event);return;}if(event.buttons)return;hoverEvent=event;if(!hoverQueued){hoverQueued=true;requestAnimationFrame(()=>{hoverQueued=false;if(disposed||!hoverEvent)return;setHovered(pick(hoverEvent));});}});
      renderer.domElement.addEventListener('pointerleave',()=>{hoverEvent=null;setHovered(null);});
      root.addEventListener('keydown',event=>{if(event.key==='Escape'){if(measuring&&measureStart){cancelMeasure();drawSoon();}else if(measuring)setMeasuring(false);else if(picked){picked=null;applyAppearance();}}});
      modelLoaded=true;message.hidden=true;resize();reset();loadDesign();
    })().catch(error=>{if(!disposed){message.textContent=error.message;message.hidden=selection!=='model';tools.hidden=true;legend.hidden=true;hint.hidden=true;}});
    // ---- Full-house surfaces, openings and edges from the published exterior model ----
    // ---- Full-house surfaces, openings and edges: built and textured by the editor's own code ----
    function buildExterior({T,point,defaults}){
      const F=finishes,toScene=p=>point(frame.toFeet(p)),obj=a=>({x:a[0],y:a[1],z:a[2]}),vector=p=>point(frame.toFeet([p.x,p.y,p.z])),roofFinish=exterior.roofFinish||null;
      const labelFor=key=>({siding:'Horizontal siding','siding-vertical':'Vertical siding',soffit:'Soffit','trim-horizontal':'Horizontal trim','trim-vertical':'Vertical trim',brick:'Brick',masonry:'Masonry',stucco:'Stucco',stone:'Stone',other:'Other',unassigned:'Unassigned'})[key]||'Unassigned';
      const flatColor=(key,color)=>color||({brick:'#a65d4b',stone:'#9a948a',stucco:'#e0d8c8',masonry:'#a39f96',soffit:'#eceae4','trim-horizontal':defaults.trimColor||'#f5f3ef','trim-vertical':defaults.trimColor||'#f5f3ef'})[key]||defaults.color||'#b9bec6';
      // Solid display as the editor's exteriorSurfaceDisplay sets it: opaque, depth-written, features and fascia in front.
      const solid=(mesh,offset=1,order=0)=>{const m=mesh.material;Object.assign(m,{opacity:1,transparent:false,depthWrite:true,depthTest:true,polygonOffset:true,polygonOffsetFactor:offset,polygonOffsetUnits:offset});mesh.renderOrder=order;objects.push(m);return mesh;};
      // The organization's finish defaults, which the editor reads from its own state.
      // Finish defaults come from WallMode.finishDefaults, exactly as in the editor.
      const withDefaults=mesh=>mesh;exteriorVector=vector;
      // No grade: the editor draws its grade only when the drafter shows it, and reports do not carry it.
      // A face triangulated in its own frame (as the editor triangulates wall parts), then prepared by ExteriorFinishes.
      const editorMesh=(face,{offset=1,order=0,part='static',key=''}={})=>{
        const K=window.ExteriorGeometry,W=window.WallSolidGeometry,rings=[face.points,...(face.holes||[])],flat=rings.flat(),frame3=W.faceFrame({points:face.points}),local=p=>W.inFrame(frame3,p);
        const points=K.triangles(rings[0].map(local),rings.slice(1).map(r=>r.map(local))).triangles.flat().map(i=>flat[i]);
        const geo=new T.BufferGeometry().setFromPoints(points.map(vector));geo.computeVertexNormals();objects.push(geo);
        const mesh=new T.Mesh(geo,new T.MeshBasicMaterial({side:T.DoubleSide}));F.prepare(mesh,face,points);mesh.userData.designSource={face,points,part,key};return withDefaults(solid(mesh,offset,order));
      };
      const own=(item,meshes,layer)=>{item.meshes=meshes;item.mesh=meshes[0];item.layer=layer;item.finish=true;for(const mesh of meshes){mesh.userData.item=item;groups[layer].add(mesh);}items.push(item);return item;};
      const ring=r=>r.map(obj),faceOf=f=>({points:ring(f.points),holes:(f.holes||[]).map(ring)});
      const safe=(fn,fallback)=>{try{return fn();}catch(_){return fallback;}};
      const chimneyCaps=(exterior.caps||[]).map((face,index)=>{const xs=face.points.map(p=>p[0]),ys=face.points.map(p=>p[1]);return {face,id:'viewer-chimney-'+index,box:[Math.min(...xs)-.15,Math.max(...xs)+.15,Math.min(...ys)-.15,Math.max(...ys)+.15],center:[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2]};});
      const chimneyOf=wall=>{if(!wall.chimney||!chimneyCaps.length)return null;const c=wall.points.reduce((a,p)=>[a[0]+p[0]/wall.points.length,a[1]+p[1]/wall.points.length],[0,0]);
        return (chimneyCaps.find(cap=>c[0]>=cap.box[0]&&c[0]<=cap.box[1]&&c[1]>=cap.box[2]&&c[1]<=cap.box[3])||chimneyCaps.reduce((best,cap)=>Math.hypot(cap.center[0]-c[0],cap.center[1]-c[1])<Math.hypot(best.center[0]-c[0],best.center[1]-c[1])?cap:best)).id;};
      const allWallPoints=exterior.walls.flatMap(w=>w.points),houseCenter=allWallPoints.reduce((a,p)=>a.map((v,i)=>v+p[i]/allWallPoints.length),[0,0,0]);
      for(const wall of exterior.walls){
        const category=wall.chimney?'chimney':'material:'+wall.materialKey,swatch=flatColor(wall.materialKey,wall.finishColor);
        const item={kind:'wall',category,categoryName:wall.chimney?'Chimneys':labelFor(wall.materialKey),area:wall.net,swatch,flat:swatch,title:`${wall.chimney?'Chimney':'Wall'} ${wall.id}`,
          details:()=>[['Elevation',wall.elevation],['Material',item.mesh?labelFor(F.resolve(item.mesh.userData.exteriorFinish||{}).material):wall.material],['Net area',`${decimal(wall.net,0)} sq ft`],['Gross area',wall.openingArea>0?`${decimal(wall.gross,0)} sq ft`:null],['Openings',wall.openings.length?String(wall.openings.length):null],['Height',wall.height?ftIn(wall.height):null],['Width',wall.width?ftIn(wall.width):null]]};
        const builtMaterial=exterior.finishDefaults?.material||'unassigned',followsDefault=wall.materialKey==='unassigned'||wall.materialKey===builtMaterial;
        const chimneyId=chimneyOf(wall),mesh=safe(()=>editorMesh({...faceOf(wall),material:followsDefault?'default':wall.materialKey,finishColor:wall.finishColor,...(wall.chimney?{chimney:{id:chimneyId}}:{})},{part:'wall',key:wall.key||wall.id}),null);if(!mesh)continue;own(item,[mesh],'walls');
        // Wall area pills sit just off the face, outside its holes.
        const anchor=wallAnchor(wall);if(anchor){const sprite=labelSprite(toScene(anchor),{item,size:2.1});paintLabel(sprite,[{icon:'area',text:decimal(wall.net,0)+' sf'}]);groups.wallLabels.add(sprite);}
        const wallCenter=wall.points.reduce((a,p)=>a.map((v,i)=>v+p[i]/wall.points.length),[0,0,0]),savedNormal=Array.isArray(wall.normal)&&Math.hypot(...wall.normal)>.5?wall.normal:null,wallNormal=savedNormal||newell(wall.points)||[0,0,0],outward=savedNormal?1:dot3(wallNormal,wallCenter.map((v,i)=>v-houseCenter[i]))<0?-1:1;
        for(const opening of wall.openings){const type=openingKind(opening.type);if(!openingKinds[type])continue;
          const proud=opening.points.map(p=>p.map((v,i)=>v+wallNormal[i]*outward*.03)),openingKey=opening.points.map(p=>p.map(v=>Math.round(v*100)).join(':')).join('|');
          const feature=safe(()=>editorMesh({points:ring(proud),feature:{type}},{offset:-1,order:1,part:'feature',key:openingKey}),null);if(!feature)continue;feature.userData.exteriorFeature=true;
          // Sticker trim (door and window casing): opening-trim finish in the sticker's trim colour, in front of the wall.
          const trims=(opening.trimFaces||[]).map(face=>{const mesh=safe(()=>editorMesh({points:ring(face.points.map(p=>p.map((v,i)=>v+wallNormal[i]*outward*.03))),openingTrim:true,trim:true,stickerType:face.stickerType,trimOwnColor:face.ownColor||null},{offset:-2,order:2,part:'trim',key:openingKey}),null);if(mesh){mesh.userData.openingTrim=true;Object.assign(mesh.userData.exteriorFinish||{},{stickerType:face.stickerType});}return mesh;}).filter(Boolean);
          const on=newell(opening.points)||[0,0,0],middle=opening.points.reduce((a,p)=>a.map((v,i)=>v+p[i]/opening.points.length),[0,0,0]);
          own({kind:'opening',labelAnchor:toScene(middle.map((v,i)=>v+on[i]*.2)),labelParts:()=>[{text:`${ftIn(opening.width)} × ${ftIn(opening.height)}`}],category:'opening:'+type,openingType:type,priority:3,area:opening.area,width:opening.width,height:opening.height,swatch:flatOpening[type],flat:flatOpening[type],title:`${openingKinds[type][1]} ${opening.id}`,
            details:()=>[['Size',`${ftIn(opening.width)} × ${ftIn(opening.height)}`],['Area',`${decimal(opening.area,1)} sq ft`],['Perimeter',`${decimal(opening.perimeter,1)} ft`],['Wall',`${wall.id} · ${wall.elevation}`]]},[feature,...trims],'walls');}
      }
      // A plain cap carries no material, as in the editor: prepare marks it chimney-top and links it to its chimney.
      for(const {face,id} of chimneyCaps){const mesh=safe(()=>editorMesh({...faceOf(face),...(face.materialKey&&face.materialKey!=='chimney-top'?{material:face.materialKey}:{}),finishColor:face.finishColor,chimney:{id,cap:true}}),null);if(mesh)own({kind:'cap',category:'chimney',categoryName:'Chimneys',area:0,swatch:'#d4d0c8',flat:'#d4d0c8',title:'Chimney top',details:()=>[]},[mesh],'walls');}
      for(const face of exterior.returns||[]){const mesh=safe(()=>editorMesh({...faceOf(face),material:face.materialKey,finishColor:face.finishColor}),null);if(mesh)own({kind:'return',category:'material:'+face.materialKey,categoryName:labelFor(face.materialKey),area:0,swatch:flatColor(face.materialKey,face.finishColor),flat:flatColor(face.materialKey,face.finishColor),title:'Horizontal return',details:()=>[['Material',labelFor(face.materialKey)]]},[mesh],'walls');}
      for(const face of exterior.base||[]){const mesh=safe(()=>editorMesh({...faceOf(face),material:'default'}),null);if(!mesh)continue;mesh.userData.baseId=0;mesh.userData.pickLayer='base';own({kind:'base',category:'base',area:0,swatch:'#b3afa7',flat:'#b3afa7',title:'Base',details:()=>[['Footprint',`${decimal(planArea(face.points)*FT*FT,0)} sq ft`]]},[mesh],'base');}
      // Roof: the editor's roof meshes (covering and soffit underside), ridge and hip caps, and skylights.
      const roofModel={points:(exterior.sourceRoof?.points||[]).map(obj),connections:exterior.sourceRoof?.connections||[],faces:(exterior.roof||[]).map(faceOf)};
      const presentation=safe(()=>F.roofPresentation(roofModel),{faces:roofModel.faces,skylights:[]});
      for(const face of presentation.faces){
        const meshes=safe(()=>F.roofMeshes(face,vector,true),[]).map((mesh,underside)=>{objects.push(mesh.geometry);mesh.userData.designSource={part:'roof',points:[face.points,...(face.holes||[])].flat(),face:{...face,material:underside?(face.soffitMaterial||'soffit'):'shingles',finishColor:underside?face.soffitColor:face.finishColor,textureAxes:face.textureAxes}};return withDefaults(solid(mesh,1));});if(!meshes.length)continue;
        const n=newell(face.points.map(p=>[p.x,p.y,p.z]))||[0,0,1],feet=face.points.map(p=>frame.toFeet([p.x,p.y,p.z])),center=[0,1,2].map(i=>feet.reduce((sum,p)=>sum+p[i],0)/feet.length),
          // Never contradict the report: the matching report face's pitch and area, measured only when none matches.
          published=reportRoofFaces.reduce((best,f)=>{const d=Math.hypot(...f.center.map((v,i)=>v-center[i]));return d<(best?.d??3)?{...f,d}:best;},null),
          area=published?.area??(area3(face.points)-(face.holes||[]).reduce((sum,hole)=>sum+area3(hole),0))*FT*FT,pitch=published?published.pitch:Math.abs(n[2])>1e-6?Math.round(Math.hypot(n[0],n[1])/Math.abs(n[2])*12):null;
        const roofAnchor=faceLabelAnchor({points:face.points.map(p=>[p.x,p.y,p.z]),holes:(face.holes||[]).map(r=>r.map(p=>[p.x,p.y,p.z])),area:1,pitch:0});
        own({kind:'roofFace',category:'roof',priority:1,area,pitch,labelAnchor:roofAnchor?toScene([roofAnchor.point[0],roofAnchor.point[1],roofAnchor.point[2]+.25]):null,labelParts:()=>[...(pitch!=null?[{icon:'pitch',text:pitch+'/12'}]:[]),{icon:'area',text:`${decimal(area,0)} sf`}],swatch:roofFinish?.color||'#4a4c4f',flat:'#9aa4b2',title:'Roof face',details:()=>[['Pitch',pitch!=null?pitch+'/12':null],['Area',`${decimal(area,0)} sq ft (${decimal(area/100,2)} sq)`],['Covering',F.roofMaterials?.[F.resolveRoof(effectiveDefaults().roof).category]?.label||null]]},meshes,'roof');
      }
      for(const face of presentation.skylights||[]){const mesh=safe(()=>F.skylightMesh(face,vector),null);if(!mesh)continue;objects.push(mesh.geometry);solid(mesh,-1,1);mesh.userData.exteriorFeature=true;own({kind:'skylight',category:'line:SKYLIGHT',area:0,swatch:styles.SKYLIGHT[0],flat:'#88a5ad',title:'Skylight',details:()=>[]},[mesh],'roof');}
      const capsItem={kind:'caps',category:'roof',area:0,flat:'#8a929e',title:'Ridge caps',details:()=>[]};
      const makeCaps=category=>{const caps=safe(()=>F.roofCaps?.(roofModel,vector,category),null);if(caps){objects.push(caps.geometry);solid(caps,1);}return caps;};
      {const caps=makeCaps(roofFinish?.category);if(caps)own(capsItem,[caps],'roof');}
      // Caps are built for one covering: a projected covering gets its own.
      rebuildRoofCaps=()=>{const category=F.resolveRoof(effectiveDefaults().roof).category;if(capsItem.category_built===category)return;capsItem.category_built=category;for(const mesh of capsItem.meshes||[])mesh.parent?.remove(mesh);const caps=makeCaps(category);if(!caps){capsItem.meshes=[];capsItem.mesh=null;return;}caps.userData.item=capsItem;groups.roof.add(caps);capsItem.meshes=[caps];capsItem.mesh=caps;if(!items.includes(capsItem))items.push(capsItem);};
      capsItem.category_built=F.resolveRoof(roofFinish||undefined).category;
      // Fascia: the report's own panels, or rebuilt by the editor's RoofTrim for reports saved before panels were stored.
      const trim=exterior.reportHasTrim?(exterior.roofTrim||[]).map(f=>({...faceOf(f),finishColor:f.finishColor})):safe(()=>window.RoofTrim&&roofModel.points.length?window.RoofTrim.panels(roofModel,exterior.roofTrimSettings||{}).filter(p=>!p.deleted):[],[]);
      for(const panel of trim){const mesh=safe(()=>editorMesh({points:panel.points,holes:panel.holes||[],material:'trim-horizontal',trim:true,finishColor:panel.finishColor||null},{offset:-2,order:2}),null);if(!mesh)continue;mesh.userData.roofTrimId=1;own({kind:'trim',category:'trim',priority:2,area:0,swatch:defaults.trimColor||'#f5f3ef',flat:defaults.trimColor||'#f5f3ef',title:'Fascia',details:()=>[['Material','Roof trim']]},[mesh],'roof');}
      for(const edge of exterior.edges||[]){const style=wallEdges[edge.type];if(!style)continue;const ends=[toScene(edge.a),toScene(edge.b)],geo=new T.BufferGeometry().setFromPoints(ends),mat=new T.LineBasicMaterial({color:style[0]}),line=new T.Line(geo,mat);line.renderOrder=2;objects.push(geo,mat);groups.walls.add(line);
        const item={kind:'wallEdge',layer:'walls',category:'edge:'+edge.type,edgeType:edge.type,line,length:edge.length,ends,swatch:style[0],title:style[1].replace(/s$/,''),details:()=>[['Length',`${ftIn(edge.length)} (${decimal(edge.length)} ft)`],['Walls',edge.walls.join(', ')]]};line.userData.item=item;items.push(item);}
    }
    // Planar polygon area (metres squared) from its vector area.
    const area3=points=>{const p=points.map(q=>Array.isArray(q)?q:[q.x,q.y,q.z]),n=[0,0,0];p.forEach((a,i)=>{const b=p[(i+1)%p.length];n[0]+=a[1]*b[2]-a[2]*b[1];n[1]+=a[2]*b[0]-a[0]*b[2];n[2]+=a[0]*b[1]-a[1]*b[0];});return Math.hypot(...n)/2;};
    const planArea=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
    // A point inside a vertical wall, away from its holes, nudged off the face along its normal.
    function wallAnchor(wall){const n=newell(wall.points);if(!n)return null;const l=Math.hypot(n[0],n[1]);if(l<.5)return null;const u=[-n[1]/l,n[0]/l,0],o=wall.points[0],to2=p=>[dot3([p[0]-o[0],p[1]-o[1],p[2]-o[2]],u),p[2]-o[2],0];
      const anchor=faceLabelAnchor({points:wall.points.map(to2),holes:(wall.holes||[]).map(r=>r.map(to2)),area:1,pitch:0});if(!anchor)return null;const [s,h]=anchor.point;return [o[0]+u[0]*s+n[0]*.15,o[1]+u[1]*s+n[1]*.15,o[2]+h];}
    // ---- Projected design: the customer's finish choices layered over the as-built report (full house only) ----
    const WALL_CHOICES=[['unassigned','Smooth'],['siding','Horizontal siding'],['siding-vertical','Vertical siding'],['brick','Brick'],['masonry','Masonry'],['stucco','Stucco'],['stone','Stone'],['other','Other']];
    const blankDesign=()=>({version:1,mode:'built',defaults:{},walls:{},openings:{},source:null});
    let design=blankDesign(),designMode='built',designOpen=false,designStatus='',saveTimer=null,designPanelKey='',designSaving=Promise.resolve();
    const designBar=root.querySelector('[data-design-bar]'),designPanel=root.querySelector('[data-design-panel]');
    const asBuiltDefaults=()=>exterior?.finishDefaults||{};
    // The editor's finish defaults with the projected choices over them (WallMode.finishDefaults shape).
    function effectiveDefaults(){
      const built=asBuiltDefaults();if(designMode!=='projected')return built;const d=design.defaults||{};
      return {...built,...(d.material?{material:d.material}:{}),...(d.color?{color:d.color}:{}),...(d.trimColor?{trimColor:d.trimColor}:{}),roof:{...(built.roof||{}),...(d.roof||{})},stickers:{...(built.stickers||{}),...(d.stickers||{})}};
    }
    // A face as the editor would see it under the current mode.
    function effectiveFace(source){
      const projected=designMode==='projected',face={...source.face};
      if(source.part==='wall'){const o=projected?design.walls?.[source.key]:null;if(o?.material)face.material=o.material;if(o?.color)face.finishColor=o.color;}
      if(source.part==='feature'){const o=projected?design.openings?.[source.key]:null;if(o?.color)face.finishColor=o.color;}
      if(source.part==='trim'){const o=projected?design.openings?.[source.key]:null;if(o?.trimColor)face.trimOwnColor=o.trimColor;}
      return face;
    }
    function applyDesign(){
      if(!exterior||!finishes)return;const F=finishes;
      if(window.WallMode?.viewerShim)window.WallMode.finishDefaults=effectiveDefaults();
      for(const item of items)for(const mesh of (item.meshes||[])){const source=mesh.userData.designSource;if(!source)continue;
        try{F.prepare(mesh,effectiveFace(source),source.points);}catch(_){continue;}
        if(source.part==='trim'){mesh.userData.openingTrim=true;Object.assign(mesh.userData.exteriorFinish||{},{stickerType:source.face.stickerType});}
        if(source.part==='feature')mesh.userData.exteriorFeature=true;
        if(source.part==='wall'&&mesh===item.mesh){const r=F.resolve(mesh.userData.exteriorFinish||{});if(r?.color)item.flat=r.color;}}
      rebuildRoofCaps?.();
      for(const item of items)item.textured=undefined;renderedKey='';applyAppearance();
    }
    // Auto-save: debounced, one request in flight at a time.
    function saveDesign(){
      if(!designUrl)return;clearTimeout(saveTimer);designStatus='Saving…';renderDesignStatus();
      saveTimer=setTimeout(()=>{const body=JSON.stringify({design:{...design,mode:designMode}});
        designSaving=designSaving.then(async()=>{try{const response=await fetch(designUrl,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json',...csrfHeader()},body});if(!response.ok)throw Error();designStatus='Saved';}catch(_){designStatus='Couldn’t save — your changes stay on this screen';}renderDesignStatus();});},700);
    }
    function csrfHeader(){const name=String(window.__APP?.platformSessionCookieName||window.Portal?.cfg?.platformSessionCookieName||'fm_platform_session');if(!/^[A-Za-z0-9_-]{1,80}$/.test(name))return {};const part=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(encodeURIComponent(name+'_csrf')+'='));if(!part)return {};try{return {'X-Platform-CSRF':decodeURIComponent(part.slice(part.indexOf('=')+1))};}catch(_){return {};}}
    function setDesignMode(mode){if(designMode===mode)return;designMode=mode;applyDesign();renderDesignBar();if(designOpen)renderDesignPanel(true);saveDesign();}
    // Any edit shows the projected design.
    function changeDesign(mutate){mutate(design);if(designMode!=='projected')designMode='projected';applyDesign();renderDesignBar();renderDesignPanel(true);saveDesign();}
    function renderDesignBar(){
      if(!designBar)return;designBar.hidden=!exterior||!finishes;stage.classList.toggle('has-design',!designBar.hidden);stage.classList.toggle('has-design-open',designOpen&&!designBar.hidden);
      designBar.querySelectorAll('[data-design-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.designMode===designMode)));
      designBar.querySelector('[data-design-open]').setAttribute('aria-pressed',String(designOpen));designPanel.hidden=!designOpen||designBar.hidden;
    }
    function renderDesignStatus(){const el=designPanel?.querySelector('[data-design-status]');if(el)el.textContent=designStatus;}
    const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;return node;};
    function chips(options,current,onPick,label){const row=el('div','fm-design-chips');row.setAttribute('role','group');row.setAttribute('aria-label',label);for(const [id,text,swatch] of options){const b=el('button','fm-design-chip');b.type='button';if(swatch){const dot=el('i');dot.style.background=swatch;b.append(dot);}b.append(text);b.setAttribute('aria-pressed',String(id===current));b.onclick=()=>onPick(id);row.append(b);}return row;}
    function colorRow(label,value,onPick,{reset}={}){const row=el('label','fm-design-color');row.append(el('span','',label));const input=el('input');input.type='color';input.value=value||'#80868b';input.setAttribute('aria-label',label);input.onchange=()=>onPick(input.value.toLowerCase());row.append(input);if(reset){const b=el('button','fm-design-link','Default');b.type='button';b.onclick=e=>{e.preventDefault();reset();};row.append(b);}return row;}
    function renderDesignPanel(force=false){
      if(!designPanel||!designOpen||!exterior||!finishes)return;
      const key=JSON.stringify([picked?.title||'',designMode]);if(!force&&key===designPanelKey)return;designPanelKey=key;
      const F=finishes,d=effectiveDefaults(),roof=F.resolveRoof(d.roof),scroll=designPanel.scrollTop;designPanel.replaceChildren();
      const head=el('header');const title=el('strong','',designMode==='projected'?'Projected design':'As built');const status=el('span','fm-design-status',designStatus);status.dataset.designStatus='';const close=el('button','fm-design-close','×');close.type='button';close.setAttribute('aria-label','Close design');close.onclick=()=>{designOpen=false;renderDesignBar();};head.append(title,status,close);designPanel.append(head);
      if(designMode!=='projected'){const note=el('p','fm-design-note','You are looking at the house as it was measured. Any change below switches to the projected design.');designPanel.append(note);}
      // Defaults: what every face uses unless it has its own choice.
      const defaults=el('section');defaults.append(el('h4','','Defaults'));
      defaults.append(el('h5','','Walls'),chips(WALL_CHOICES.map(([id,text])=>[id,text,window.ExteriorMaterials?.[id]?.color]),d.material||'unassigned',id=>changeDesign(x=>{x.defaults={...x.defaults,material:id};}),'Wall material'));
      defaults.append(colorRow('Wall color',d.color,v=>changeDesign(x=>{x.defaults={...x.defaults,color:v};})),colorRow('Trim and fascia',d.trimColor,v=>changeDesign(x=>{x.defaults={...x.defaults,trimColor:v};})));
      defaults.append(el('h5','','Roof'),chips(Object.entries(F.roofMaterials).map(([id,spec])=>[id,spec.label,spec.colors[0].color]),roof.category,id=>changeDesign(x=>{x.defaults={...x.defaults,roof:{category:id,color:F.roofMaterials[id].colors[0].color}};}),'Roof type'));
      const swatches=el('div','fm-design-swatches');for(const preset of F.roofMaterials[roof.category].colors){const b=el('button','fm-design-swatch');b.type='button';b.style.background=preset.color;b.title=preset.label;b.setAttribute('aria-label',preset.label);b.setAttribute('aria-pressed',String(preset.color===roof.color));b.onclick=()=>changeDesign(x=>{x.defaults={...x.defaults,roof:{category:roof.category,color:preset.color}};});swatches.append(b);}
      defaults.append(swatches,colorRow('Custom roof color',roof.color,v=>changeDesign(x=>{x.defaults={...x.defaults,roof:{category:roof.category,color:v}};})));
      const sticker=id=>(d.stickers||{})[id]||F.stickerDefaults?.(d)?.[id];
      defaults.append(el('h5','','Doors and windows'));
      for(const [id,label] of [['doorMain','Doors'],['doorTrim','Door trim'],['garageMain','Garage doors'],['windowTrim','Window trim']])defaults.append(colorRow(label,sticker(id),v=>changeDesign(x=>{x.defaults={...x.defaults,stickers:{...(x.defaults.stickers||{}),[id]:v}};})));
      designPanel.append(defaults);
      // Selected face: its own choices over the defaults.
      const selected=el('section');selected.append(el('h4','','Selected face'));
      const item=picked,source=item&&meshesOf(item).map(m=>m.userData.designSource).find(Boolean);
      if(!item)selected.append(el('p','fm-design-note','Select a face to see more details.'));
      else{selected.append(el('p','fm-design-face',item.title));
        if(item.kind==='wall'&&source?.key){const own=design.walls?.[source.key]||{},set=patch=>changeDesign(x=>{const next={...(x.walls?.[source.key]||{}),...patch};for(const k of Object.keys(next))if(next[k]==null)delete next[k];x.walls={...x.walls};if(Object.keys(next).length)x.walls[source.key]=next;else delete x.walls[source.key];});
          selected.append(chips([['',`Default (${(WALL_CHOICES.find(([id])=>id===(d.material||'unassigned'))||[])[1]||'Smooth'})`],...WALL_CHOICES],designMode==='projected'?own.material||'':'',id=>set({material:id||null}),'Face material'));
          selected.append(colorRow('Face color',(designMode==='projected'&&own.color)||F.resolve(item.mesh.userData.exteriorFinish||{}).color,v=>set({color:v}),{reset:()=>set({color:null})}));}
        else if(item.kind==='opening'){const openingKey=source?.key,own=(designMode==='projected'&&design.openings?.[openingKey])||{},set=patch=>changeDesign(x=>{const next={...(x.openings?.[openingKey]||{}),...patch};for(const k of Object.keys(next))if(next[k]==null)delete next[k];x.openings={...x.openings};if(Object.keys(next).length)x.openings[openingKey]=next;else delete x.openings[openingKey];});
          if(item.openingType!=='window'&&item.openingType!=='vent')selected.append(colorRow(item.openingType==='garage'?'Garage door color':'Door color',own.color||sticker(item.openingType==='garage'?'garageMain':'doorMain'),v=>set({color:v}),{reset:()=>set({color:null})}));
          if(item.openingType!=='vent')selected.append(colorRow('Trim color',own.trimColor||sticker(item.openingType==='garage'?'garageTrim':item.openingType==='window'?'windowTrim':'doorTrim'),v=>set({trimColor:v}),{reset:()=>set({trimColor:null})}));}
        else if(item.kind==='roofFace'||item.kind==='caps')selected.append(el('p','fm-design-note','The roof covering is the whole roof: change it under Defaults.'));
        else selected.append(el('p','fm-design-note','This part follows the defaults.'));}
      designPanel.append(selected);
      const actions=el('footer');const generate=el('button','fm-design-primary','Generate from materials');generate.type='button';generate.disabled=!materialsUrl;generate.title=materialsUrl?'Use the roof, siding, trim and door products on this project’s material lists':'Open this from a project to use its material lists';generate.onclick=()=>generateFromMaterials(generate);
      const reset=el('button','fm-design-secondary','Reset to as built');reset.type='button';reset.onclick=()=>changeDesign(x=>{Object.assign(x,blankDesign());});actions.append(generate,reset);designPanel.append(actions);
      const result=el('p','fm-design-result');result.dataset.designResult='';designPanel.append(result);designPanel.scrollTop=scroll;
    }
    // Generate from the project's material lists: roof covering type and color from the covering line's name and its
    // selected color option; siding, trim, doors and garage doors from lines named for them.
    async function generateFromMaterials(button){
      const out=designPanel.querySelector('[data-design-result]');button.disabled=true;out.textContent='Reading material lists…';
      try{
        const response=await fetch(materialsUrl,{credentials:'same-origin',headers:{Accept:'application/json'}});if(!response.ok)throw Error('The material lists could not be read.');
        const data=await response.json(),lists=data.material_lists||data.lists||[],lines=lists.filter(l=>!l.resource_type||l.resource_type==='material').flatMap(l=>l.current_items||l.items||[]);
        const found=materialsDesign(lines);if(!found.applied.length){out.textContent='No roof, siding, trim or door products with a color were found on this project’s material lists.';return;}
        changeDesign(x=>{x.defaults={...x.defaults,...found.defaults,stickers:{...(x.defaults.stickers||{}),...(found.defaults.stickers||{})}};x.source='materials';});
        designPanel.querySelector('[data-design-result]').textContent='From materials: '+found.applied.join(' · ');
      }catch(error){out.textContent=error.message||'The material lists could not be read.';}finally{button.disabled=!materialsUrl;}
    }
    function materialsDesign(lines){
      const F=finishes,text=line=>[line.name,line.description,line.product_selection?.item_type_name,line.product_selection?.variant_name,line.pricebook_snapshot?.item?.name].filter(Boolean).join(' '),qty=line=>Number(line.quantity)||0;
      const colorOf=line=>{const id=String(line.selected_options?.color||line.pricebook_ref?.selected_options?.color||'');if(!id)return null;
        const pools=[...(line.pricebook_snapshot?.item?.variant_dimensions||[]).flatMap(dim=>dim.values||[]),...(line.pricebook_snapshot?.option_definitions||[]).flatMap(o=>o.values||o.choices||o.options||[])];
        const hit=pools.find(v=>String(v.id)===id||String(v.value)===id);const hex=String(hit?.hex||hit?.color||'');return {id,label:hit?.label||id.replace(/[_-]+/g,' '),hex:/^#[0-9a-f]{6}$/i.test(hex)?hex.toLowerCase():null};};
      const out={defaults:{},applied:[]};const pick=re=>lines.filter(l=>re.test(text(l))).sort((a,b)=>qty(b)-qty(a));
      const covering=lines.filter(l=>(l.category==='shingle_roofs'||/shingle|shake|slate|standing seam|metal roof/i.test(text(l)))&&!/hip|ridge|starter|underlayment|drip|vent|nail|cap|flashing|ice|leak/i.test(text(l))).sort((a,b)=>qty(b)-qty(a))[0];
      if(covering){const t=text(covering),category=/shake/i.test(t)?'shake':/slate/i.test(t)?'slate':/metal|standing seam/i.test(t)?'metal':'shingles',c=colorOf(covering),norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
        const preset=c&&F.roofMaterials[category].colors.find(p=>norm(p.label)===norm(c.label)||norm(p.id)===norm(c.id));const color=c?.hex||preset?.color||F.roofMaterials[category].colors[0].color;
        out.defaults.roof={category,color};out.applied.push(`Roof: ${covering.name||F.roofMaterials[category].label}${c?' · '+c.label:''}`);}
      const siding=pick(/siding|board.?and.?batten|lap\b/i)[0];if(siding){const t=text(siding),c=colorOf(siding);out.defaults.material=/vertical|board.?and.?batten/i.test(t)?'siding-vertical':'siding';if(c?.hex)out.defaults.color=c.hex;out.applied.push(`Walls: ${siding.name}${c?' · '+c.label:''}`);}
      else{for(const [re,material] of [[/brick/i,'brick'],[/stucco/i,'stucco'],[/stone/i,'stone']]){const line=pick(re)[0];if(line){const c=colorOf(line);out.defaults.material=material;if(c?.hex)out.defaults.color=c.hex;out.applied.push(`Walls: ${line.name}${c?' · '+c.label:''}`);break;}}}
      const trim=pick(/\btrim\b|fascia/i).find(l=>colorOf(l)?.hex);if(trim){out.defaults.trimColor=colorOf(trim).hex;out.applied.push(`Trim: ${trim.name} · ${colorOf(trim).label}`);}
      const garage=pick(/garage door/i).find(l=>colorOf(l)?.hex);if(garage){(out.defaults.stickers||={}).garageMain=colorOf(garage).hex;out.applied.push(`Garage doors: ${colorOf(garage).label}`);}
      const door=pick(/\bdoor\b/i).filter(l=>!/garage/i.test(text(l))).find(l=>colorOf(l)?.hex);if(door){(out.defaults.stickers||={}).doorMain=colorOf(door).hex;out.applied.push(`Doors: ${colorOf(door).label}`);}
      return out;
    }
    async function loadDesign(){
      renderDesignBar();if(!designUrl||!exterior||!finishes)return;
      try{const response=await fetch(designUrl,{credentials:'same-origin',headers:{Accept:'application/json'}});if(!response.ok)return;const data=await response.json();if(disposed||!data?.design)return;
        design={...blankDesign(),...data.design};designMode=data.design.mode==='projected'?'projected':'built';if(designMode==='projected')applyDesign();renderDesignBar();renderDesignPanel(true);}catch(_){}
    }
    designBar?.querySelectorAll('[data-design-mode]').forEach(b=>b.onclick=()=>setDesignMode(b.dataset.designMode));
    designBar?.querySelector('[data-design-open]')?.addEventListener('click',()=>{designOpen=!designOpen;renderDesignBar();renderDesignPanel(true);});
    for(const name of ['pointerdown','wheel','keydown'])designPanel?.addEventListener(name,e=>e.stopPropagation());
    return {serialize(){return {texture:textureEnabled,lines:coloredLinesEnabled,key:keyVisible,keyTab,pitch:pitchEnabled,area:areaEnabled,lengths:lengthsEnabled,layers:{...layers},category:selectedCategory,selectedType:selectedCategory?.startsWith('line:')?selectedCategory.slice(5):null};},setVisible(value){if(value)resize();},destroy(){disposed=true;clearPreview?.();if(renderedKey){try{window.ExteriorRendered?.update(null,{enabled:false});}catch(_){}}if(ownsWallMode&&window.WallMode?.viewerShim)delete window.WallMode;unsubscribeMeasurements?.();controller.abort();observer.disconnect();controls?.dispose();objects.forEach(o=>o.dispose());texture?.dispose();renderer?.dispose();ownedUrls.forEach(URL.revokeObjectURL);root.replaceChildren();}};
  }
  window.FirstMeasureRoofViewer={mount,parseModel,faceTextureUVs,faceLabelAnchor,exteriorFrame,finishUVs};
})();
