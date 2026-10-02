/* Read-only report geometry and media. No editor runtime or write endpoints. */
(function(){
  const styles = {
    RIDGE:['#FF0000','Ridge'], HIP:['#E67300','Hip'], VALLEY:['#800080','Valley'], RAKE:['#006400','Rake'], EAVE:['#FFD400','Eave'],
    HEAD_WALL:['#A0522D','Headwall flashing'], SIDE_WALL:['#FF00FF','Sidewall flashing'], STEPFLASH:['#FF00FF','Step flashing'],
    TRANS:['#808080','Transition'], PARAPET:['#5C2E0C','Parapet'], PROTRUSION:['#589BA6','Protrusion'],
    CHIMNEY_BACK:['#00008B','Chimney back pan'], CHIMNEY_EDGE:['#007bff','Chimney step'], CHIMNEY_FRONT:['#ADD8E6','Chimney apron'], SKYLIGHT:['#00FFFF','Skylight'], NONE:['#64748b','Unclassified']
  };
  let libraries, solarLibrary;
  function script(src){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.onload=resolve;el.onerror=()=>{el.remove();reject(new Error('The 3D viewer library could not load.'));};document.head.append(el);});}
  function loadLibraries(){return libraries ||= (async()=>{
    if(!window.THREE)await script('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
    if(!window.THREE.OrbitControls)await script('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
  })().catch(e=>{libraries=null;throw e;});}
  function parseModel(xml){
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('This report has invalid roof geometry.');
    const roofs=[];
    for(const roof of doc.querySelectorAll('ROOF')){
      const points=new Map(),lines=new Map(),faces=[];
      for(const p of roof.querySelectorAll('POINT')){const xyz=(p.getAttribute('data')||'').split(',').map(Number);if(xyz.length===3&&xyz.every(Number.isFinite))points.set(p.getAttribute('id'),xyz);}
      for(const l of roof.querySelectorAll('LINE')){const ids=(l.getAttribute('path')||'').split(',').map(x=>x.trim());if(ids.length===2&&ids.every(id=>points.has(id)))lines.set(l.getAttribute('id'),{ids,type:(l.getAttribute('type')||'NONE').toUpperCase()});}
      for(const polygon of roof.querySelectorAll('FACE POLYGON')){
        const edges=(polygon.getAttribute('path')||'').split(',').map(id=>lines.get(id.trim()));
        if(edges.length<3||edges.some(e=>!e))continue;
        // Walk undirected boundary edges; stored directions need not agree.
        const pending=edges.slice(1),path=[...edges[0].ids];
        while(pending.length){const end=path[path.length-1],i=pending.findIndex(e=>e.ids.includes(end));if(i<0)break;const [e]=pending.splice(i,1);path.push(e.ids[0]===end?e.ids[1]:e.ids[0]);}
        if(!pending.length&&path[0]===path[path.length-1])faces.push(path.slice(0,-1).map(id=>points.get(id)));
      }
      if(points.size)roofs.push({points,lines,faces});
    }
    if(!roofs.length)throw new Error('No saved roof geometry is available for this report.');
    return roofs;
  }
  function injectStyle(){
    if(document.getElementById('fm-roof-viewer-style'))return;
    const el=document.createElement('style');el.id='fm-roof-viewer-style';el.textContent=`
      .fm-roof-gallery{height:100%;min-height:360px;display:grid;grid-template-columns:minmax(200px,38%) minmax(0,1fr);gap:12px;padding:12px;box-sizing:border-box;container-type:inline-size;background:#f5f6f8}
      .fm-roof-gallery *{box-sizing:border-box}.fm-roof-gallery [hidden]{display:none!important}
      .fm-roof-stage{position:relative;min-width:0;min-height:300px;overflow:hidden;background:#eef1f5;border:1px solid #e4e7ec;border-radius:12px;grid-column:2;grid-row:1}
      .fm-roof-canvas{position:absolute;inset:0}.fm-roof-canvas canvas{width:100%;height:100%;display:block;touch-action:none}
      .fm-roof-tools{position:absolute;left:12px;top:12px;display:flex;gap:6px;z-index:2;flex-wrap:wrap}
      .fm-roof-tools button,.fm-roof-thumb{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#344054;border-radius:8px;padding:8px 12px;font-size:12px}
      .fm-roof-tools button[aria-pressed=true]{background:#344054;color:white}.fm-roof-key{position:absolute;z-index:3;top:58px;left:12px;background:#fff;padding:12px;border-radius:10px;box-shadow:0 6px 24px #0002;max-height:70%;overflow:auto;font-size:12px;display:grid;gap:8px}.fm-roof-key span{display:flex;align-items:center;gap:8px}.fm-roof-key i{width:24px;height:3px;display:inline-block}
      .fm-roof-library{grid-column:1;grid-row:1;min-width:0;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:8px}
      .fm-roof-thumb{padding:0;overflow:hidden;text-align:left;min-width:0}.fm-roof-thumb img,.fm-roof-thumb video{width:100%;height:120px;object-fit:cover;display:block}.fm-roof-thumb span{display:block;padding:9px}.fm-roof-thumb[aria-pressed=true]{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025)}
      .fm-roof-media{width:100%;height:100%;object-fit:contain;position:absolute;inset:0;background:#101828}.fm-roof-message{position:absolute;inset:0;display:grid;place-content:center;padding:28px;text-align:center;color:#667085;pointer-events:none}.fm-roof-hint{position:absolute;bottom:12px;left:12px;font-size:11px;color:#667085;pointer-events:none}
      .fm-roof-gallery.is-compact{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(300px,1fr) 112px}.fm-roof-gallery.is-compact .fm-roof-stage{grid-column:1;grid-row:1}.fm-roof-gallery.is-compact .fm-roof-library{grid-column:1;grid-row:2;display:flex;overflow-x:auto;overflow-y:hidden}.fm-roof-gallery.is-compact .fm-roof-thumb{flex:0 0 120px}.fm-roof-gallery.is-compact .fm-roof-thumb img,.fm-roof-gallery.is-compact .fm-roof-thumb video{height:66px}.fm-roof-gallery.is-compact .fm-roof-thumb span{padding:6px;font-size:11px}
    `;document.head.append(el);
  }
  function mount(root,{xmlUrl,media=[]}){
    injectStyle();let disposed=false,renderer,controls,scene,camera,observer,geometryGroup,lineGroup,texture,selection='model',geometryMode=false;
    let modelLoaded=false;const controller=new AbortController();const objects=[];const ownedUrls=[];
    root.innerHTML='<div class="fm-roof-gallery"><div class="fm-roof-library" aria-label="Roof model and report media"></div><div class="fm-roof-stage"><div class="fm-roof-canvas"></div><div class="fm-roof-tools"><button type="button" data-mode aria-pressed="false">Geometry</button><button type="button" data-key aria-expanded="false">Line key</button><button type="button" data-reset>Reset view</button></div><div class="fm-roof-key" hidden></div><div class="fm-roof-message" role="status">Loading roof model…</div><div class="fm-roof-hint">Drag to orbit · Scroll to zoom</div></div></div>';
    const gallery=root.firstElementChild,stage=root.querySelector('.fm-roof-stage'),canvas=root.querySelector('.fm-roof-canvas'),library=root.querySelector('.fm-roof-library'),tools=root.querySelector('.fm-roof-tools'),key=root.querySelector('.fm-roof-key'),message=root.querySelector('.fm-roof-message'),hint=root.querySelector('.fm-roof-hint');
    const entries=[{id:'model',label:'3D roof model'},...media.map((m,i)=>({...m,id:'media-'+i}))];
    function draw(){if(!disposed&&renderer&&selection==='model')renderer.render(scene,camera);}
    function resize(){if(disposed)return;gallery.classList.toggle('is-compact',gallery.clientWidth<800);if(renderer){renderer.setSize(stage.clientWidth,stage.clientHeight);const aspect=stage.clientWidth/Math.max(1,stage.clientHeight);camera.position.sub(controls.target).multiplyScalar(Math.max(1,1/aspect)/Math.max(1,1/camera.aspect)).add(controls.target);camera.aspect=aspect;camera.updateProjectionMatrix();draw();}}
    function select(entry){
      selection=entry.id; stage.querySelector('.fm-roof-media')?.remove();
      const model=selection==='model';canvas.hidden=!model;tools.hidden=!model;hint.hidden=!model;key.hidden=true;tools.querySelector('[data-key]').setAttribute('aria-expanded','false');message.hidden=!model||modelLoaded;
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
    function reset(){if(!camera)return;const aspect=stage.clientWidth/Math.max(1,stage.clientHeight);camera.position.set(1,1,1.3).normalize().multiplyScalar(190*Math.max(1,1/aspect));controls.target.set(0,0,0);controls.update();draw();}
    tools.querySelector('[data-mode]').onclick=e=>{geometryMode=!geometryMode;e.currentTarget.setAttribute('aria-pressed',String(geometryMode));e.currentTarget.textContent=geometryMode?'Textured':'Geometry';if(geometryGroup)geometryGroup.visible=!geometryMode;if(lineGroup)lineGroup.visible=geometryMode;draw();};
    tools.querySelector('[data-key]').onclick=e=>{key.hidden=!key.hidden;e.currentTarget.setAttribute('aria-expanded',String(!key.hidden));};tools.querySelector('[data-reset]').onclick=reset;
    observer=new ResizeObserver(resize);observer.observe(gallery);resize();
    (async()=>{
      if(!xmlUrl)throw new Error('The completed report does not contain a roof model yet.');
      const [response]=await Promise.all([fetch(xmlUrl,{credentials:'same-origin',signal:controller.signal}),loadLibraries()]);
      if(!response.ok)throw new Error('The roof model could not be loaded.');
      const roofs=parseModel(await response.text());if(disposed)return;
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
        for(const face of roof.faces){const vertices=face.map(point);const triangles=T.ShapeUtils.triangulateShape(face.map(p=>new T.Vector2(p[0],p[1])),[]);const pos=[],uv=[];for(const tri of triangles)for(const i of tri){pos.push(...vertices[i].toArray());uv.push(face[i][0]/12,face[i][1]/12);}const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.computeVertexNormals();const mat=new T.MeshStandardMaterial({map:texture,side:T.DoubleSide,roughness:1});geometryGroup.add(new T.Mesh(geo,mat));objects.push(geo,mat);}
        for(const line of roof.lines.values()){const type=styles[line.type]?line.type:'NONE';types.add(type);const geo=new T.BufferGeometry().setFromPoints(line.ids.map(id=>point(roof.points.get(id))));const mat=new T.LineBasicMaterial({color:styles[type][0]});lineGroup.add(new T.Line(geo,mat));objects.push(geo,mat);}
      }
      if(!geometryGroup.children.length){geometryMode=true;tools.querySelector('[data-mode]').disabled=true;hint.textContent='Saved roof lines · Drag to orbit · Scroll to zoom';}
      geometryGroup.visible=!geometryMode;lineGroup.visible=geometryMode;
      for(const type of types){const row=document.createElement('span'),swatch=document.createElement('i');swatch.style.background=styles[type][0];row.append(swatch,document.createTextNode(styles[type][1]));key.append(row);}
      modelLoaded=true;message.hidden=true;resize();reset();
    })().catch(error=>{if(!disposed){message.textContent=error.message;message.hidden=selection!=='model';tools.hidden=true;hint.hidden=true;}});
    return {destroy(){disposed=true;controller.abort();observer.disconnect();controls?.dispose();objects.forEach(o=>o.dispose());texture?.dispose();renderer?.dispose();ownedUrls.forEach(URL.revokeObjectURL);root.replaceChildren();}};
  }
  window.FirstMeasureRoofViewer={mount,parseModel};
})();
