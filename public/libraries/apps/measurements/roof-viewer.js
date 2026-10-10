/* Read-only report geometry and media. No editor runtime or write endpoints. */
(function(){
  const styles = {
    RIDGE:['#FF0000','Ridge'], HIP:['#E67300','Hip'], VALLEY:['#800080','Valley'], RAKE:['#006400','Rake'], EAVE:['#FFD400','Eave'],
    HEAD_WALL:['#A0522D','Headwall Flashing'], SIDE_WALL:['#FF00FF','Sidewall Flashing'],
    TRANS:['#808080','Transition'], PARAPET:['#5C2E0C','Parapet Wall'], PROTRUSION:['#589BA6','Protrusion'],
    CHIMNEY_BACK:['#00008B','Chimney Back Pan'], CHIMNEY_EDGE:['#007bff','Chimney Step'], CHIMNEY_FRONT:['#ADD8E6','Chimney Apron'], SKYLIGHT:['#00FFFF','Skylight'], UNKNOWN:['#000000','Unknown']
  };
  function lineType(value){const type=String(value||'').toUpperCase().replace(/[\s-]+/g,'_');return ({STEPFLASH:'SIDE_WALL',STEP_FLASHING:'SIDE_WALL',SIDEWALL:'SIDE_WALL',HEADWALL:'HEAD_WALL',TRANSITION:'TRANS',FLASHING:'UNKNOWN',NONE:'UNKNOWN'})[type] || (styles[type]?type:'UNKNOWN');}
  let libraries, solarLibrary;
  function script(src){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.onload=resolve;el.onerror=()=>{el.remove();reject(new Error('The 3D viewer library could not load.'));};document.head.append(el);});}
  function loadLibraries(){return libraries ||= (async()=>{
    if(!window.THREE)await script('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
    if(!window.THREE.OrbitControls)await script('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
  })().catch(e=>{libraries=null;throw e;});}
  function parseModel(xml,edgeTypes=[]){
    const classified=new Map(edgeTypes.map(edge=>[String(edge.path),lineType(edge.type)]));
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('This report has invalid roof geometry.');
    const roofs=[];
    for(const roof of doc.querySelectorAll('ROOF')){
      const points=new Map(),lines=new Map(),faces=[];
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
        }
        faces.push({points:boundary,holes});
      }
      if(points.size)roofs.push({points,lines,faces});
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
  function injectStyle(){
    if(document.getElementById('fm-roof-viewer-style'))return;
    const el=document.createElement('style');el.id='fm-roof-viewer-style';el.textContent=`
      .fm-roof-gallery{height:100%;min-height:360px;display:grid;grid-template-columns:minmax(200px,38%) minmax(0,1fr);gap:12px;padding:12px;box-sizing:border-box;container-type:inline-size;background:#f5f6f8}
      .fm-roof-gallery.is-single{display:block;padding:0}.fm-roof-gallery.is-single .fm-roof-stage{height:100%;min-height:280px}
      .fm-roof-gallery *{box-sizing:border-box}.fm-roof-gallery [hidden]{display:none!important}
      .fm-roof-stage{position:relative;min-width:0;min-height:300px;overflow:hidden;background:#eef1f5;border:1px solid #e4e7ec;border-radius:12px;grid-column:2;grid-row:1;display:flex;flex-direction:column}
      .fm-roof-canvas{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}.fm-roof-canvas canvas{width:100%;height:100%;display:block;touch-action:none}
      .fm-roof-tools{position:absolute;left:12px;top:12px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;z-index:2;max-width:calc(100% - 24px);max-height:calc(100% - 52px)}.fm-roof-control-row{display:flex;gap:6px;flex:none}.fm-roof-tools button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px}.fm-roof-tools button.fm-roof-icon{width:34px;padding:7px}.fm-roof-tools svg{width:18px;height:18px;display:block}.fm-roof-tools button:focus-visible{outline:2px solid #175cd3;outline-offset:2px}
      .fm-roof-tools button,.fm-roof-thumb{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#344054;border-radius:8px;padding:8px 12px;font-size:12px}
      .fm-roof-tools button[aria-pressed=true]{background:#344054;color:white}.fm-roof-legend{flex:0 0 auto;background:#fffe;border-top:1px solid #d5deeb;padding:5px 8px;max-height:45%;overflow:auto}.fm-roof-legend>button{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:0;background:none;color:#475467;cursor:pointer;font:inherit;font-size:10px;padding:3px}.fm-roof-legend>button svg{height:12px;width:12px;transition:transform .15s}.fm-roof-legend>button[aria-expanded=false] svg{transform:rotate(180deg)}.fm-roof-legend>button:focus-visible{outline:2px solid var(--primary,#d93025)}.fm-roof-key{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;font-size:10px;padding:4px 0}.fm-roof-key span{display:flex;align-items:center;gap:5px;min-width:0;padding:4px;background:#f8f9fb;border:1px solid #e4e7ec;border-radius:3px;line-height:1.2}.fm-roof-key i{width:9px;height:9px;border-radius:1px;display:inline-block;flex:0 0 9px}

      .fm-roof-library{grid-column:1;grid-row:1;min-width:0;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:8px}
      .fm-roof-thumb{padding:0;overflow:hidden;text-align:left;min-width:0}.fm-roof-thumb img,.fm-roof-thumb video{width:100%;height:120px;object-fit:cover;display:block}.fm-roof-thumb span{display:block;padding:9px}.fm-roof-thumb[aria-pressed=true]{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025)}
      .fm-roof-media{width:100%;height:100%;object-fit:contain;position:absolute;inset:0;background:#101828}.fm-roof-message{position:absolute;inset:0;display:grid;place-content:center;padding:28px;text-align:center;color:#667085;pointer-events:none}.fm-roof-hint{position:absolute;bottom:12px;left:12px;font-size:11px;color:#667085;pointer-events:none}
      .fm-roof-gallery.is-compact{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(300px,1fr) 112px}.fm-roof-gallery.is-compact .fm-roof-stage{grid-column:1;grid-row:1}.fm-roof-gallery.is-compact .fm-roof-library{grid-column:1;grid-row:2;display:flex;overflow-x:auto;overflow-y:hidden}.fm-roof-gallery.is-compact .fm-roof-thumb{flex:0 0 120px}.fm-roof-gallery.is-compact .fm-roof-thumb img,.fm-roof-gallery.is-compact .fm-roof-thumb video{height:66px}.fm-roof-gallery.is-compact .fm-roof-thumb span{padding:6px;font-size:11px}
    `;document.head.append(el);
  }
  function mount(root,{xmlUrl,edgeTypes=[],media=[],standalone=false,initialState={}}){
    injectStyle();let disposed=false,renderer,controls,scene,camera,observer,geometryGroup,lineGroup,texture,selection='model',textureEnabled=initialState.texture!==false,coloredLinesEnabled=initialState.lines!==false,keyVisible=initialState.key!==false;
    let modelLoaded=false;const controller=new AbortController();const objects=[];const ownedUrls=[];
    root.innerHTML='<div class="fm-roof-gallery"><div class="fm-roof-library" aria-label="Roof model and report media"></div><div class="fm-roof-stage"><div class="fm-roof-canvas"></div><div class="fm-roof-tools"><div class="fm-roof-control-row"><button type="button" class="fm-roof-icon" data-texture aria-label="Texture" title="Texture" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18v16H3zM3 9h18M3 14h18M8 4v5m8-5v5M6 9v5m8-5v5m-4 0v6m8-6v6"/></svg></button><button type="button" class="fm-roof-icon" data-lines aria-label="Colored lines" title="Colored lines" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 18 5-10 6 6 7-10"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/><circle cx="14" cy="14" r="2" fill="currentColor" stroke="none"/></svg></button><button type="button" class="fm-roof-icon" data-reset aria-label="Reset view" title="Reset view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.5 9M3 4v6h6"/></svg></button></div></div><div class="fm-roof-legend"><button type="button" data-key aria-expanded="true">Key<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="fm-roof-key"></div></div><div class="fm-roof-message" role="status">Loading roof model…</div><div class="fm-roof-hint">Drag to orbit · Scroll to zoom</div></div></div>';
    const gallery=root.firstElementChild,stage=root.querySelector('.fm-roof-stage'),canvas=root.querySelector('.fm-roof-canvas'),library=root.querySelector('.fm-roof-library'),tools=root.querySelector('.fm-roof-tools'),key=root.querySelector('.fm-roof-key'),legend=root.querySelector('.fm-roof-legend'),keyToggle=root.querySelector('[data-key]'),message=root.querySelector('.fm-roof-message'),hint=root.querySelector('.fm-roof-hint');
    if(standalone){gallery.classList.add('is-single');library.hidden=true;}
    canvas.append(hint);key.hidden=!keyVisible;keyToggle.setAttribute('aria-expanded',String(keyVisible));keyToggle.setAttribute('aria-label',keyVisible?'Collapse key':'Expand key');
    const entries=[{id:'model',label:'3D roof model'},...media.map((m,i)=>({...m,id:'media-'+i}))];
    function draw(){if(!disposed&&renderer&&selection==='model')renderer.render(scene,camera);}
    function resize(){if(disposed)return;gallery.classList.toggle('is-compact',gallery.clientWidth<800);const columns=stage.clientWidth>=720?5:stage.clientWidth>=360?4:stage.clientWidth>=260?3:2;key.style.gridTemplateColumns=`repeat(${columns},minmax(0,1fr))`;if(renderer&&canvas.clientWidth&&canvas.clientHeight){renderer.setSize(canvas.clientWidth,canvas.clientHeight);const aspect=canvas.clientWidth/canvas.clientHeight;camera.position.sub(controls.target).multiplyScalar(Math.max(1,1/aspect)/Math.max(1,1/camera.aspect)).add(controls.target);camera.aspect=aspect;camera.updateProjectionMatrix();draw();}}

    function select(entry){
      selection=entry.id; stage.querySelector('.fm-roof-media')?.remove();
      const model=selection==='model';canvas.hidden=!model;tools.hidden=!model;hint.hidden=!model;legend.hidden=!model;key.hidden=!keyVisible;keyToggle.setAttribute('aria-expanded',String(keyVisible));message.hidden=!model||modelLoaded;
      library.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.id===entry.id)));
      if(!model){const el=document.createElement(entry.video?'video':'img');el.className='fm-roof-media';el.src=entry.url;el.alt=entry.label;if(entry.video){el.controls=true;el.playsInline=true;}el.onerror=()=>{message.hidden=false;message.textContent='This media could not load.';};stage.append(el);}else resize();
    }
    for(const entry of entries){const button=document.createElement('button');button.type='button';button.className='fm-roof-thumb';button.dataset.id=entry.id;button.setAttribute('aria-pressed',String(entry.id==='model'));
      if(entry.id==='model'){const icon=document.createElement('div');icon.style.cssText='height:66px;display:grid;place-items:center;color:#667085;font-size:32px';icon.textContent='⬡';icon.setAttribute('aria-hidden','true');button.append(icon);}
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
    function reset(){if(!camera)return;const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);camera.position.set(1,1,1.3).normalize().multiplyScalar(190*Math.max(1,1/aspect));controls.target.set(0,0,0);controls.update();draw();}
    function applyAppearance(){
      geometryGroup?.children.forEach(mesh=>{const mat=mesh.material;mat.map=textureEnabled?texture:null;mat.color.set(textureEnabled?'#ffffff':'#cbd5e1');mat.transparent=!textureEnabled;mat.opacity=textureEnabled?1:.62;mat.depthWrite=textureEnabled;mat.needsUpdate=true;});
      if(lineGroup)lineGroup.visible=coloredLinesEnabled;
      tools.querySelector('[data-texture]').setAttribute('aria-pressed',String(textureEnabled));
      tools.querySelector('[data-lines]').setAttribute('aria-pressed',String(coloredLinesEnabled));draw();
    }
    tools.querySelector('[data-texture]').onclick=()=>{textureEnabled=!textureEnabled;applyAppearance();};
    tools.querySelector('[data-lines]').onclick=()=>{coloredLinesEnabled=!coloredLinesEnabled;applyAppearance();};
    keyToggle.onclick=()=>{keyVisible=!keyVisible;key.hidden=!keyVisible;keyToggle.setAttribute('aria-expanded',String(keyVisible));keyToggle.setAttribute('aria-label',keyVisible?'Collapse key':'Expand key');resize();};tools.querySelector('[data-reset]').onclick=reset;
    observer=new ResizeObserver(resize);observer.observe(gallery);resize();
    (async()=>{
      if(!xmlUrl)throw new Error('The completed report does not contain a roof model yet.');
      const [response]=await Promise.all([fetch(xmlUrl,{credentials:'same-origin',signal:controller.signal}),loadLibraries()]);
      if(!response.ok)throw new Error('The roof model could not be loaded.');
      const roofs=parseModel(await response.text(),edgeTypes);if(disposed)return;
      const T=window.THREE;scene=new T.Scene();scene.background=new T.Color('#eef1f5');camera=new T.PerspectiveCamera(42,1,.1,3000);
      renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));canvas.append(renderer.domElement);
      controls=new T.OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.addEventListener('change',draw);
      scene.add(new T.HemisphereLight(0xffffff,0x687080,.8));const light=new T.DirectionalLight(0xffffff,.45);light.position.set(30,80,40);scene.add(light);
      const all=roofs.flatMap(r=>[...r.points.values()]),min=[0,1,2].map(i=>Math.min(...all.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...all.map(p=>p[i]))),scale=100/Math.max(...max.map((v,i)=>v-min[i]),1);
      const point=p=>new T.Vector3((p[0]-(min[0]+max[0])/2)*scale,(p[2]-(min[2]+max[2])/2)*scale,-(p[1]-(min[1]+max[1])/2)*scale);
      const tile=document.createElement('canvas');tile.width=128;tile.height=128;const ctx=tile.getContext('2d');ctx.fillStyle='#706e69';ctx.fillRect(0,0,128,128);for(let y=0;y<128;y+=16){ctx.fillStyle=y%32?'#777570':'#696863';ctx.fillRect(0,y,128,15);ctx.strokeStyle='#454541';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(128,y);for(let x=y%32?16:0;x<128;x+=32){ctx.moveTo(x,y);ctx.lineTo(x,y+16);}ctx.stroke();}
      texture=new T.CanvasTexture(tile);texture.wrapS=texture.wrapT=T.RepeatWrapping;
      geometryGroup=new T.Group();lineGroup=new T.Group();scene.add(geometryGroup,lineGroup);const types=new Set();
      for(const roof of roofs){
        for(const face of roof.faces){const rings=[face.points,...face.holes],flat=rings.flat(),vertices=flat.map(point),faceUVs=faceTextureUVs(face.points,flat);const project=ring=>ring.map(p=>new T.Vector2(p[0],p[1]));const triangles=T.ShapeUtils.triangulateShape(project(face.points),face.holes.map(project));const pos=[],uv=[];for(const tri of triangles)for(const i of tri){pos.push(...vertices[i].toArray());uv.push(...faceUVs[i]);}const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.computeVertexNormals();const mat=new T.MeshStandardMaterial({map:texture,side:T.DoubleSide,roughness:1,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});geometryGroup.add(new T.Mesh(geo,mat));objects.push(geo,mat);}
        for(const line of roof.lines.values()){const type=lineType(line.type);types.add(type);const geo=new T.BufferGeometry().setFromPoints(line.ids.map(id=>point(roof.points.get(id))));const mat=new T.LineBasicMaterial({color:styles[type][0]});const edge=new T.Line(geo,mat);edge.renderOrder=2;lineGroup.add(edge);objects.push(geo,mat);}
      }
      if(!geometryGroup.children.length){textureEnabled=false;tools.querySelector('[data-texture]').disabled=true;hint.textContent='Saved roof lines · Drag to orbit · Scroll to zoom';}
      applyAppearance();
      for(const type of Object.keys(styles)){const row=document.createElement('span'),swatch=document.createElement('i');swatch.style.background=styles[type][0];row.append(swatch,document.createTextNode(styles[type][1]));key.append(row);}
      modelLoaded=true;message.hidden=true;resize();reset();
    })().catch(error=>{if(!disposed){message.textContent=error.message;message.hidden=selection!=='model';tools.hidden=true;legend.hidden=true;hint.hidden=true;}});
    return {serialize(){return {texture:textureEnabled,lines:coloredLinesEnabled,key:keyVisible};},setVisible(value){if(value)resize();},destroy(){disposed=true;controller.abort();observer.disconnect();controls?.dispose();objects.forEach(o=>o.dispose());texture?.dispose();renderer?.dispose();ownedUrls.forEach(URL.revokeObjectURL);root.replaceChildren();}};
  }
  window.FirstMeasureRoofViewer={mount,parseModel,faceTextureUVs};
})();
