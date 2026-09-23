/* Independent wall-mode terrain editing. Never swaps or mutates roof geometry. */
(function(){
    'use strict';
    const T=window.GroundGeometry,COLOR='#67c9ef',copy=v=>JSON.parse(JSON.stringify(v));
    window.createGroundEditor=function(host){
        let project='',message='',busy=false,surface3D=null,sourceRequest=0,sampling=false,samplingImageVisible=null;
        const state=()=>host.getState(),ground=()=>state()?.ground;
        const $=id=>document.getElementById('ground-'+id);
        function commit(next,fitBase=false){const grade=T.reference(next,state().roof);grade.visible=true;if(host.commitGround)host.commitGround(grade,fitBase);else{state().ground=grade;host.changed();}}
        function restoreSamplingImage(){const visible=samplingImageVisible;samplingImageVisible=null;if(typeof visible==='boolean')window.toggle3DImage?.(visible);}
        function stopSampling(){if(!sampling)return;sampling=false;restoreSamplingImage();host.samplingChanged?.(false);host.redraw?.();render();}
        function startSampling(){
            if(sampling){message='DSM point selection cancelled.';stopSampling();return;}
            sourceRequest++;host.prepareSampling?.();samplingImageVisible=window.get3DImageVisible?.()??null;sampling=true;
            window.toggle3DSurfaceMode?.('height');window.toggle3DImage?.(true);
            message='Click exposed ground on the DSM to set flat grade. Escape cancels.';
            host.samplingChanged?.(true);host.redraw?.();render();
        }
        function down(e){
            if(!sampling)return false;
            try{
                const view=e.target.closest?.('#three-view-wrapper')?'3d':'2d';
                let pixel;if(view==='2d')pixel=pixelPosition(e);else{const p=position(e,'3d',0,'dsm');if(!p)throw Error('Click on the DSM surface to choose ground height.');pixel=host.toPixel(p);}
                const p=T.sampleDSMPoint(layerData.dsm?.[0],host.context?.()||state().context,pixel,state().context);
                const next=planeMesh({dx:0,dy:0,k:p.z},{source:'DSM point',sampledPoint:p,stats:{samples:1,grade:0}});
                commit(next,true);message='Ground height set to '+p.z.toFixed(2)+' m from DSM. Selection complete.';stopSampling();
            }catch(error){reportError(error);}
            return true;
        }
        function planeMesh(p,extra){return T.fromPlane(T.bounds(state().roof),p,{visible:true,simpleGrade:1,...extra});}
        function fitDSM(){
            const s=state(),samples=T.sampleDSM(layerData.dsm?.[0],s.context,s.roof),r=T.fit(samples);
            const candidate=planeMesh(r.plane,{source:'DSM',stats:r.stats});
            s.groundCandidates={...s.groundCandidates,dsm:copy(candidate)};return candidate;
        }
        function reportError(e){message=e.message;render();}
        function setup(container){
            const box=document.createElement('div');box.innerHTML=`<hr><div class="wall-heading"><h3>Reference grade</h3>
            <button id="ground-visible">Grade</button>
            <div class="wall-row"><button id="ground-dsm">DSM</button><button id="ground-usgs">USGS</button><button id="ground-flat">Flat</button></div></div>
            <label id="ground-flat-control">Elevation (m)<input id="ground-flat-z" type="number" step="0.1"></label>
            <p id="ground-status" role="status"></p>`;
            container.appendChild(box);
            const action=fn=>()=>{try{if(!host.ensureState())return;message='';fn();}catch(e){reportError(e);}};
            $('visible').onclick=action(()=>{ground().visible=ground().visible===false;host.changed(false);});
            $('dsm').onclick=action(startSampling);$('dsm').title='Click a DSM ground point to set flat grade';
            const flat=()=>{stopSampling();sourceRequest++;const z=Number($('flat-z').value);if(!Number.isFinite(z))throw Error('Enter a finite elevation.');commit(planeMesh({dx:0,dy:0,k:z},{source:'Flat'}));};
            $('flat').onclick=action(flat);$('flat-z').onchange=action(flat);
            $('usgs').onclick=action(()=>{stopSampling();sourceRequest++;const candidate=state().groundCandidates?.usgs;if(candidate)commit(copy(candidate));else void fetchUSGS(sourceRequest);});
        }
        async function fetchUSGS(request){
            if(busy)return;const s=state(),original=ground(),b=T.bounds(s.roof),center={x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2};
            const reference=T.height(original,center)??s.options.ground;
            busy=true;message='Fetching nine USGS terrain samples…';render();
            try{
                const samples=[];let resolution=0;
                for(let j=0;j<3;j++){
                    const row=await Promise.all([0,1,2].map(async i=>{
                        const x=b.x0+i*(b.x1-b.x0)/2,y=b.y0+j*(b.y1-b.y0)/2;
                        const lat=s.context.lat-y/111132,lng=s.context.lng+x/(111132*Math.cos(s.context.lat*Math.PI/180));
                        const query=new URLSearchParams({x:String(lng),y:String(lat),units:'Meters',wkid:'4326',includeDate:'true'});
                        const r=await fetch('https://epqs.nationalmap.gov/v1/json?'+query,{signal:AbortSignal.timeout(15000)});
                        if(!r.ok)throw Error('USGS elevation service is unavailable.');
                        const data=await r.json(),z=Number(data.value);if(data.value==null||!Number.isFinite(z)||z<=-9000)throw Error('USGS has no terrain coverage here. Use the solar DSM fit.');
                        resolution=Math.max(resolution,Number(data.resolution)||0);return {x,y,z};
                    }));samples.push(...row);
                }
                if(state()!==s)return;
                const raw=window.WallGeometry.plane(samples);if(!raw)throw Error('USGS samples could not define a plane.');
                const rawCenter=T.at(raw,center),offset=reference-rawCenter,p={...raw,k:raw.k+offset};
                s.groundCandidates={...s.groundCandidates,usgs:T.fromPlane(b,p,{visible:true,source:'USGS grade',stats:{samples:9,grade:Math.hypot(p.dx,p.dy)*100,resolution,rawCenter,offset},samples})};
                if(request===sourceRequest){message='USGS grade (center elevation aligned to DSM/flat reference).';commit(copy(s.groundCandidates.usgs));}else host.changed(false);
            }catch(e){if(state()===s&&request===sourceRequest)message=`USGS unavailable: ${e.message}`;}
            finally{busy=false;if(state()===s)render();}
        }
        function render(){
            if(!$('status'))return;
            const s=state(),g=ground(),id=host.projectId();if(id!==project){project=id;sourceRequest++;sampling=false;restoreSamplingImage();host.samplingChanged?.(false);message='';}
            $('visible').setAttribute('aria-pressed',String(g?.visible!==false));
            for(const name of ['dsm','usgs','flat'])$(name).setAttribute('aria-pressed',String(name==='dsm'&&sampling||(g?.source||'').toLowerCase().startsWith(name)));
            $('dsm').textContent=sampling?'Picking DSM…':'DSM';
            $('usgs').disabled=busy;$('flat-control').hidden=g?.source!=='Flat'&&!g?.sampledPoint;
            const b=s?.roof?T.bounds(s.roof):null,center=b?{x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2}:null;
            if(document.activeElement!==$('flat-z'))$('flat-z').value=(center&&g?T.height(g,center):s?.options.ground??0)?.toFixed(2)||'0';
            $('status').textContent=message||(g?`${g.source} · ${(Math.hypot(g.plane?.dx||0,g.plane?.dy||0)*100).toFixed(1)}% grade`:'Flat grade is available when wall mode starts.');
        }
        function draw2D(rot,svgEl,inv){
            const g=ground();if(!g||g.visible===false)return;
            const coords=g.points.map(p=>host.toPixel(p));svgEl('polygon',{points:coords.map(p=>`${p.x},${p.y}`).join(' '),fill:COLOR,'fill-opacity':.09,stroke:COLOR,'stroke-width':inv,'pointer-events':'none'},rot);
        }
        function draw3D(group,vector){
            surface3D=null;const g=ground();if(!g||g.visible===false)return;
            const vectors=g.points.map(vector),positions=vectors.flatMap(v=>[v.x,v.y,v.z]);
            const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setIndex(g.faces.flat());geo.computeVertexNormals();
            const surface=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:COLOR,side:THREE.DoubleSide,transparent:true,opacity:.15,depthWrite:false}));surface.userData.pickLayer='grade';group.add(surface);surface3D=surface;
            const outline=new THREE.BufferGeometry().setFromPoints([...vectors,vectors[0]]);group.add(new THREE.Line(outline,new THREE.LineBasicMaterial({color:COLOR,transparent:true,opacity:.65})));
        }
        function basis(){
            const o=getVector3(host.toPixel({x:0,y:0,z:0})),x=getVector3(host.toPixel({x:1,y:0,z:0})).sub(o),y=getVector3(host.toPixel({x:0,y:1,z:0})).sub(o),z=getVector3(host.toPixel({x:0,y:0,z:1})).sub(o);
            const matrix=new THREE.Matrix4().makeBasis(x,y,z);matrix.setPosition(o);return {matrix,inverse:matrix.clone().invert(),normal:x.clone().cross(y).normalize()};
        }
        function pixelPosition(e){
            if(typeof screenToImage==='function')return screenToImage(e.clientX,e.clientY);
            const svg=document.getElementById('geoSvg'),v=svg.createSVGPoint();v.x=e.clientX;v.y=e.clientY;return v.matrixTransform(document.getElementById('geo-rotation-group').getScreenCTM().inverse());
        }
        function position(e,view,z,onSurface=false){
            if(view==='2d'){const p=pixelPosition(e);return host.toMetric({x:p.x,y:p.y,z},state().context);}
            const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster(),b=basis();
            ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);
            if(onSurface==='dsm'){const dsm=window.groundDSMSurface?.();if(!dsm?.visible)return null;dsm.updateMatrixWorld(true);const hit=ray.intersectObject(dsm)[0];if(!hit)return null;const p=hit.point.clone().applyMatrix4(b.inverse);return {x:p.x,y:p.y,z:p.z};}
            if(onSurface&&surface3D){surface3D.updateMatrixWorld(true);const hit=ray.intersectObject(surface3D)[0];if(hit){const p=hit.point.clone().applyMatrix4(b.inverse);return {x:p.x,y:p.y,z:p.z};}}
            const hit=ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(b.normal,new THREE.Vector3(0,0,z).applyMatrix4(b.matrix)),new THREE.Vector3());
            if(!hit)return null;const p=hit.applyMatrix4(b.inverse);return {x:p.x,y:p.y,z};
        }
        return {setup,render,draw2D,draw3D,down,sampling:()=>sampling,interaction:()=>sampling?'Pick DSM ground point':null,keyDown(e){if(!sampling)return false;if(e.key==='Escape'||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z')){message='DSM point selection cancelled.';stopSampling();}e.preventDefault();e.stopImmediatePropagation();return true;},leave(){sourceRequest++;message='';stopSampling();},fitDSM,position,setEditing(){render();}};
    };
})();
