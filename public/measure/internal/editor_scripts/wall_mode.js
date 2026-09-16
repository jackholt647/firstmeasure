/* Exteriors prototype UI, rendering, and versioned editor-metadata persistence. */
(function () {
    'use strict';
    const G=window.WallGeometry, GREEN='#54cf86', YELLOW='#ffd84d', NS='http://www.w3.org/2000/svg';
    const ENGINE='exterior-kernel-2',GAP_COLOR='#ff4ca0';
    let gapHighlights=true,gapCacheKey='',gapCache=[];
    let enabled=false, roofVisible=true, state=null, projectId='', stage=1, selected=null, group3D=null, lastScene=null;
    let storageError='', panel, menu, badge, details, status, warning, stageButtons, sourceContext=null;
    const hiddenRoofObjects=new Map();
    let orbitLimitOwner=null,roofOrbitLimit=null;
    let roofSurfaceVisible=null,roofTrimEditor=null,roofTrimGroup=null,roofTrimOnly={},roofTrimHistory=[],roofTrimFuture=[],roofTrimPointer=false,roofTrimVisibility=null;
    const disabledRoofControls=new Map();
    let groundEditor=null,baseEditor=null,wallEditor=null,editingLayer='base',wallsVisible=true,baseTerrainCache=null,baseTerrainKey='';
    // One chronological history for the building, independent of selection layer.
    let editHistory=[],editFuture=[],pendingEdit=null,nudgeEpoch=0,nudgeKey=null;
    const historyKeys=['finishDefaults','roofTrim','base','wallEdits','chimneys','extruded','deduplicated','extrusionWarnings','gapRepaired','gapReport','mergedWalls','mergeReport','cleanedWalls','rakeCleanupReport','preCleanupBase','cleanedBase','baseCleanupApplied','alignedWalls','chimneyCleanupReport','preAlignmentBase','alignedBase','baseAlignmentApplied'];
    const editSnapshot=()=>{const value=JSON.parse(JSON.stringify(Object.fromEntries(historyKeys.map(k=>[k,k==='wallEdits'?(state?.[k]||{}):state?.[k]]))));return window.EditorHistory?.share(editHistory.at(-1)?.after,value)||value;};
    let stableSelection=null,pendingSelection=null,selectionTimer=null,selectionRevision=0,restoringHistory=false,gestureSelection=null,selectionInputType='';
    const selectionSnapshot=()=>copy({layer:editingLayer,selected,base:baseEditor?.selectionSnapshot?.(),walls:wallEditor?.selectionSnapshot?.(),trim:roofTrimEditor?.selectionSnapshot?.()});
    function selectionCounts(){
        const unique=items=>new Set(items||[]).size;
        if(editingLayer==='base'){const s=baseEditor?.selectionSnapshot?.()||{},points=unique(s.sketch?.selected)+unique(s.points),lines=unique(s.sketch?.lines);return {points,lines,faces:points||lines?0:unique(s.selectedFaces?.length?s.selectedFaces:s.selectedFace?[s.selectedFace]:[])};}
        const s=wallEditor?.selectionSnapshot?.()||{},d=s.draft||{},points=Math.max(wallEditor?.pointSelection?.().length||0,unique(d.workingPlane?.selection),unique(s.indices)),lines=unique(d.pickedLines)+unique(d.solidEdges)+unique((d.lineSelection||[]).map(l=>l.id));
        const refs=d.faceSelection?.length?d.faceSelection:d.selectedSolid?[{solid:d.selectedSolid}]:d.selectedRegion?[d.selectedRegion]:[];
        return {points,lines,faces:points||lines?0:unique(refs.map(r=>r.solid?'solid:'+r.solid:r.draft+':'+r.face))};
    }
    const selectionBusy=()=>baseEditor?.busy()||wallEditor?.busy()||roofTrimEditor?.busy();
    function restoreSelection(value){
        if(!value)return;editingLayer=value.layer||'base';selected=value.selected||null;
        baseEditor?.restoreSelection?.(value.base);wallEditor?.restoreSelection?.(value.walls);roofTrimEditor?.restoreSelection?.(value.trim);
    }
    // Commit selection at input boundaries, never during a drag/preview. The
    // stable selection remains the pre-tool selection until its edit commits.
    function flushSelectionHistory(){
        if(selectionTimer!==null){clearTimeout(selectionTimer);selectionTimer=null;}
        if(!enabled||!state||restoringHistory)return;
        const after=selectionSnapshot();if(!stableSelection){stableSelection=after;return;}
        if(pendingSelection){pendingSelection.afterSelection=after;stableSelection=after;pendingSelection=null;gestureSelection=null;return;}
        if(selectionBusy()){gestureSelection??=copy(['pointerdown','mousedown'].includes(selectionInputType)?after:stableSelection);return;}
        gestureSelection=null;
        if(JSON.stringify(stableSelection)!==JSON.stringify(after)){
            editHistory.push({selectionOnly:true,beforeSelection:stableSelection,afterSelection:after});editFuture=[];selectionRevision++;baseEditor?.render();
        }
        stableSelection=after;
    }
    function watchSelectionInput(event){
        if(!enabled||!state)return;flushSelectionHistory();selectionInputType=event?.type||'';
        selectionTimer=setTimeout(()=>{selectionTimer=null;flushSelectionHistory();},0);
    }
    function recordEdit(before){if(!state)return;pendingEdit={...editSnapshot(),...JSON.parse(JSON.stringify(before))};}
    function finishEdit(){
        if(!pendingEdit)return;const before=pendingEdit;pendingEdit=null;const after=editSnapshot();if(JSON.stringify(before)===JSON.stringify(after))return;
        const beforeSelection=copy(gestureSelection||stableSelection||selectionSnapshot()),afterSelection=selectionSnapshot(),last=editHistory.at(-1);
        if(nudgeKey&&last?.nudgeKey===nudgeKey&&!last.selectionOnly&&last.selectionRevision===selectionRevision&&JSON.stringify(last.after)===JSON.stringify(before)){
            last.after=after;last.afterSelection=afterSelection;pendingSelection=last;
        }else{const entry={before,after,nudgeKey,selectionRevision,beforeSelection,afterSelection};editHistory.push(entry);pendingSelection=entry;}
        editFuture=[];
    }
    function undoEdit(redo=false){
        if(!state&&!editHistory.length&&!editFuture.length)return false;
        if(roofTrimEditor?.busy()){if(!redo)roofTrimEditor.cancel();return true;}
        // Ctrl-Z cancels a live preview before consuming a committed operation.
        if(baseEditor?.busy()||wallEditor?.busy()){if(!redo){baseEditor?.leave();wallEditor?.clear();restoreSelection(gestureSelection||stableSelection);gestureSelection=null;stableSelection=selectionSnapshot();render();}return true;}
        flushSelectionHistory();
        const from=redo?editFuture:editHistory,to=redo?editHistory:editFuture;
        let index=from.length-1;if(state?.undoSelections===false)while(index>=0&&from[index].selectionOnly)index--;
        if(index<0){if(status)status.textContent=redo?'Nothing to redo':'Nothing to undo in this session';return true;}
        // Move skipped entries as well, preserving their chronological order
        // so enabling selection undo later can still revisit them.
        while(from.length-1>index)to.push(from.pop());const entry=from.pop();
        restoringHistory=true;
        try{
            roofTrimEditor?.reset();baseEditor?.clearSelection();wallEditor?.clear();
            if(!entry.selectionOnly){const value=copy(redo?entry.after:entry.before);if(entry.full){const undoSelections=state?.undoSelections;state=value.state;if(state&&undoSelections!==undefined)state.undoSelections=undoSelections;stage=value.stage;sourceContext=state?.context||null;}else for(const k of historyKeys){if(k in value)state[k]=value[k];else delete state[k];}}
            restoreSelection(redo?entry.afterSelection:entry.beforeSelection);to.push(entry);pendingEdit=null;pendingSelection=null;gestureSelection=null;nudgeEpoch++;nudgeKey=null;baseTerrainKey='';persist();render();stableSelection=selectionSnapshot();
        }finally{restoringHistory=false;}
        return true;
    }
    const layerVisibilityButtons=new Map();
    // Every layer registers its existing visibility button here, preserving its
    // own toggle/save behavior while sharing one pinned toolbar.
    function registerLayerVisibility(button){
        if(!button?.id)return;
        layerVisibilityButtons.set(button.id,button);
        const row=document.getElementById('wall-layer-visibility');
        if(row)row.appendChild(button);
    }
    function baseState(){return state&&new Proxy(state,{get:(s,k)=>k==='base'?(s.wallEdits?.$base||s.base):s[k],set:(s,k,v)=>{if(k==='base'&&s.wallEdits?.$base)s.wallEdits.$base=v;else s[k]=v;return true;}});}
    function wallFloor(){
        if(!state?.base||!window.BaseGeometry)return state?.ground??state?.options.ground??0;
        const key=JSON.stringify((state.wallEdits?.$base||state.base).faces);
        if(key!==baseTerrainKey){baseTerrainKey=key;baseTerrainCache=BaseGeometry.terrain(state.wallEdits?.$base||state.base);}
        return baseTerrainCache;
    }
    function initializeBase(){
        if(state&&!state.base&&window.BaseGeometry){
            const extruded=G.extrude(state.roof,state.sources,state.ground).walls;
            const walls=window.WallGaps.repair(G.deduplicate(extruded,state.options.tolerance).walls,state.ground).walls;
            state.base=BaseGeometry.fromRoof(state.roof,state.ground,walls);invalidateWalls();
        }
    }
    const copy=v=>JSON.parse(JSON.stringify(v));
    const key=id=>`firstmeasure:exteriors:walls:v1:${location.origin}:${id}`;
    const currentId=()=>String(window.currentProjectId||'');
    // View choice exists independently of generated wall geometry.
    let viewSavedAt=0;
    const viewSnapshot=()=>({enabled,savedAt:viewSavedAt});
    function persistView(){
        if(!projectId)return;
        viewSavedAt=Math.max(Date.now(),viewSavedAt+1);
        try{localStorage.setItem(key(projectId)+':view',JSON.stringify(viewSnapshot()));}catch(e){}
    }
    function restoreView(metadata,localWalls){
        let localView=null;try{localView=JSON.parse(localStorage.getItem(key(projectId)+':view')||'null');}catch(e){}
        const candidates=[metadata?.exteriorsView,localView].filter(v=>typeof v?.enabled==='boolean'&&Number.isFinite(v.savedAt)).sort((a,b)=>b.savedAt-a.savedAt);
        const view=candidates[0]||state||[metadata?.exteriorsWalls,localWalls].filter(valid).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0))[0];
        enabled=!!view?.enabled;viewSavedAt=view?.savedAt||0;
    }
    const currentContext=()=>({lat:Number(mapCenterLat)||0,lng:Number(mapCenterLng)||0,width:imageWidth,height:imageHeight,mpp:Number(window.getMetersPerPx())});
    function toMetric(p,ctx) {
        let z=Number(p.z);
        if(p.z==null || !Number.isFinite(z)) {
            const ix=Math.max(0,Math.min(imageWidth-1,Math.round(p.x))),iy=Math.max(0,Math.min(imageHeight-1,Math.round(p.y)));
            z=Number(layerData.dsm?.[0]?.[iy*imageWidth+ix]);
        }
        if(!Number.isFinite(z)||z<-9000)throw new Error('Roof points need valid elevations before generating walls.');
        return {x:(p.x-ctx.width/2)*ctx.mpp,y:(p.y-ctx.height/2)*ctx.mpp,z};
    }
    function toPixel(p,origin=sourceContext) {
        const ctx=currentContext(),ref=origin||ctx;
        const dx=(ref.lng-ctx.lng)*111132*Math.cos(ctx.lat*Math.PI/180),dy=(ctx.lat-ref.lat)*111132;
        return {x:ctx.width/2+(p.x+dx)/ctx.mpp,y:ctx.height/2+(p.y+dy)/ctx.mpp,z:p.z};
    }
    function roofSignature() {
        const points=activeGeometry?.points||[];
        return JSON.stringify({context:currentContext(),points:points.map(p=>[p.x,p.y,p.z]),connections:(activeGeometry?.connections||[]).map(c=>[points.indexOf(c.start),points.indexOf(c.end),c.type]),manualFaces:(activeGeometry?.manualFaces||[]).map(f=>({points:f.points,holes:f.holes}))});
    }
    function captureRoof(force=false) {
        if(!activeGeometry?.points?.length)throw new Error('Finish the roof points and resolved faces first.');
        const ctx=currentContext(); if(!(ctx.mpp>0))throw new Error('Load calibrated project imagery first.');
        // Snapshot the current line choices before asking the face resolver to run.
        const connections=activeGeometry.connections.map(c=>({startIdx:activeGeometry.points.indexOf(c.start),endIdx:activeGeometry.points.indexOf(c.end),type:c.type})).filter(c=>c.startIdx>=0&&c.endIdx>=0);
        let resolved=window.altFaceResolver?.getRenderFaces?.(force)||window.lastResolvedFacesCache||[];
        if(!resolved.length)resolved=activeGeometry.manualFaces||[];
        const points=activeGeometry.points.map(p=>toMetric(p,ctx));
        const faces=resolved.map((f,i)=>({id:i,points:(f.points||[]).map(p=>toMetric(p,ctx)),holes:(f.holes||[]).map(h=>h.map(p=>toMetric(p,ctx)))})).filter(f=>f.points.length>=3);
        if(!faces.length)throw new Error('Resolve the roof faces before using Auto wall.');
        return {context:ctx,roof:{points,connections,faces}};
    }
    function estimateGround() {
        // DSM minimum is an explicit, editable starting estimate, not surveyed terrain.
        return Number.isFinite(dsmMin)?dsmMin:0;
    }
    function initializeGround(){
        if(state&&!state.ground&&window.GroundGeometry)state.ground=GroundGeometry.fromPlane(GroundGeometry.bounds(state.roof),{dx:0,dy:0,k:state.options.ground},{visible:true,source:'Flat'});
        if(state?.ground&&window.GroundGeometry&&state.ground.simpleGrade!==1)state.ground=GroundGeometry.reference(state.ground,state.roof);
    }
    function groundChanged(rebuild=true){
        if(rebuild){window.WallChimneys?.normalizeDrafts(state?.wallEdits);const prior=currentWalls();invalidateWalls();calculateStage(stage);const next=currentWalls();for(const d of Object.values(state?.wallEdits?.$drafts||{})){if(d.frame)continue;const source=w=>w.chimney?w.chimney.id+':side-'+w.chimney.side:w.sourceId,sources=new Set(prior.filter(w=>d.members.includes(w.id)).map(source).filter(Boolean));if(sources.size)d.members=[...new Set([...d.members,...next.filter(w=>sources.has(source(w))).map(w=>w.id)])];}selected=null;persist();render();}
        else {persist();render();}
    }
    function invalidateWalls(){for(const k of ['extruded','deduplicated','extrusionWarnings','gapRepaired','gapReport','mergedWalls','mergeReport','cleanedWalls','rakeCleanupReport','preCleanupBase','cleanedBase','baseCleanupApplied','alignedWalls','chimneyCleanupReport','preAlignmentBase','alignedBase','baseAlignmentApplied'])delete state[k];}
    function upgradeEngine(){
        if(!state||state.engineVersion===ENGINE)return false;
        if(state.base&&!Object.keys(state.wallEdits||{}).length&&window.BaseGeometry?.repairInitial){
            const legacy=G.buildSources(state.roof,state.options).sources;
            const walls=window.WallGaps.repair(G.deduplicate(G.extrude(state.roof,legacy,state.ground).walls,state.options.tolerance).walls,state.ground).walls;
            state.base=BaseGeometry.repairInitial(state.base,state.roof,state.ground,walls);
        }
        const r=G.buildSources(state.roof,state.options);state.sources=r.sources;state.warnings=r.warnings;state.engineVersion=ENGINE;invalidateWalls();return true;
    }
    function calculateStage(next){
        // Stage comparisons swap complete base snapshots as well as walls.
        if(next<7&&state.baseAlignmentApplied){state.alignedBase=state.base;state.base=state.preAlignmentBase;state.baseAlignmentApplied=false;baseTerrainKey='';}
        if(next<6&&state.baseCleanupApplied){state.cleanedBase=state.base;state.base=state.preCleanupBase;state.baseCleanupApplied=false;baseTerrainKey='';}
        if(next>=6&&state.cleanedWalls&&state.cleanedBase&&!state.baseCleanupApplied){state.base=state.cleanedBase;state.baseCleanupApplied=true;baseTerrainKey='';}
        if(next>=7&&state.alignedWalls&&state.alignedBase&&!state.baseAlignmentApplied){state.base=state.alignedBase;state.baseAlignmentApplied=true;baseTerrainKey='';}
        initializeBase();
        if(window.WallChimneys&&!state.chimneys)state.chimneys=WallChimneys.detect(state.roof);
        window.BaseSketchGeometry?.upgrade(state.wallEdits?.$base||state.base);
        window.WallChimneys?.syncFoundation(state);
        if(next>=2){window.WallChimneys?.syncVolumes(state);window.WallChimneys?.syncFoundation(state);}
        if(next>=2&&!state.extruded){const r=G.extrude(state.roof,state.sources,wallFloor());state.extruded=r.walls;state.extrusionWarnings=r.warnings;}
        if(next>=3&&!state.deduplicated){const r=G.deduplicate(state.extruded,state.options.tolerance);state.deduplicated=r.walls;state.removed=r.removed;}
        if(next>=4&&(!state.gapRepaired||state.gapReport?.cleanupVersion!==2)){const r=window.WallGaps.repair(state.deduplicated,wallFloor(),{sliverWidth:Math.min(.25,Math.max(.03,2*state.context.mpp))});state.gapRepaired=r.walls;state.gapReport={cleanupVersion:2,sliversRemoved:r.sliversRemoved.length,paths:r.paths,before:r.before.length,remaining:r.gaps.length,added:r.added.length};}
        if(next>=5&&!state.mergedWalls){
            const edits=state.wallEdits||{},protectedIds=[...Object.keys(edits).filter(k=>!k.startsWith('$')),...Object.values(edits.$drafts||{}).flatMap(d=>d.members||[])];
            const r=G.mergeCoplanar(state.gapRepaired,protectedIds);state.mergedWalls=r.walls;state.mergeReport={removed:r.removed};
        }
        if(next>=6&&!state.cleanedWalls){
            const edits=state.wallEdits||{},protectedIds=[...Object.keys(edits).filter(k=>!k.startsWith('$')),...Object.values(edits.$drafts||{}).flatMap(d=>d.members||[])];
            const r=window.WallRakeCleanup.cleanup(state.mergedWalls,state.sources,wallFloor(),protectedIds);
            state.cleanedWalls=r.walls;state.rakeCleanupReport=r.report;
            if(state.base&&r.report.paths.length&&!edits.$base){
                state.preCleanupBase=copy(state.base);state.base=window.WallRakeCleanup.foundation(state.base,r.report);
                state.cleanedBase=state.base;state.baseCleanupApplied=true;baseTerrainKey='';
            }
        }
        if(next>=7&&!state.alignedWalls){
            const edits=state.wallEdits||{},protectedIds=[...Object.keys(edits).filter(k=>!k.startsWith('$')),...Object.values(edits.$drafts||{}).flatMap(d=>d.members||[])];
            const r=window.WallChimneyCleanup.cleanup(state.cleanedWalls,state.sources,WallChimneys.definitions(state),wallFloor(),edits.$base?state.cleanedWalls.map(w=>w.id):protectedIds);
            state.alignedWalls=r.walls;state.chimneyCleanupReport=r.report;
            if(state.base&&r.report.alignments.length&&!edits.$base){
                state.preAlignmentBase=copy(state.base);state.base=window.WallChimneyCleanup.foundation(state.base,r.report);
                state.alignedBase=state.base;state.baseAlignmentApplied=true;baseTerrainKey='';
            }
        }
    }
    function snapshot() {
        if(!state)return null;
        return {...copy(state),stage,roofVisible,wallsVisible,editingLayer,gapHighlights,enabled,schemaVersion:1,geometry:G.topology(currentWalls())};
    }
    function persist(touch=true) {
        if(!projectId)return;
        if(!state){try{localStorage.setItem(key(projectId),'null');}catch(e){}return;}
        if(touch)state.savedAt=Date.now();
        try{const existing=JSON.parse(localStorage.getItem(key(projectId))||'null');if(!touch&&existing?.savedAt>state.savedAt)return;if(touch)state.savedAt=Math.max(state.savedAt,(existing?.savedAt||0)+1);localStorage.setItem(key(projectId),JSON.stringify(snapshot()));storageError='';}
        catch(e){storageError='Local backup unavailable. Use Save to store wall data with the project.';}
    }
    function exportState() {return projectId===currentId()?snapshot():null;}
    function serializeHistory(){
        finishEdit();flushSelectionHistory();
        return {version:1,undo:editHistory.map(e=>({...e})),redo:editFuture.map(e=>({...e})),selection:selectionSnapshot(),trimUndo:roofTrimHistory.slice(),trimRedo:roofTrimFuture.slice()};
    }
    function restoreHistory(history,serverState){
        if(!history)return;
        if(history.version!==1||!Array.isArray(history.undo)||!Array.isArray(history.redo))throw Error('Unsupported wall undo history.');
        editHistory=history.undo;editFuture=history.redo;roofTrimHistory=history.trimUndo||[];roofTrimFuture=history.trimRedo||[];
        // Local geometry may be newer than the last project Save. Keep it and
        // make its difference from the saved model an undoable recovery step.
        const content=s=>JSON.stringify(historyKeys.map(k=>s?.[k]));
        if(state&&serverState&&(state.savedAt||0)>(serverState.savedAt||0)&&content(state)!==content(serverState)){
            editHistory.push({full:true,before:{state:copy(serverState),stage:serverState.stage||1},after:{state:copy(state),stage},beforeSelection:history.selection,afterSelection:selectionSnapshot()});editFuture=[];
        }else restoreSelection(history.selection);
        stableSelection=selectionSnapshot();pendingEdit=null;pendingSelection=null;gestureSelection=null;nudgeKey=null;nudgeEpoch++;
        selectionRevision=editHistory.reduce((n,e)=>Math.max(n,e.selectionRevision||0),0);selectionRevision=editFuture.reduce((n,e)=>Math.max(n,e.selectionRevision||0),selectionRevision)+1;
        render();
    }

    function valid(s) {return s?.schemaVersion===1 && s.roof?.points?.length && Array.isArray(s.sources) && Number.isFinite(s.options?.ground) && s.context?.mpp>0;}
    function restore(id,metadata,history=null) {
        editHistory=[];editFuture=[];pendingEdit=null;nudgeKey=null;nudgeEpoch++;
        roofTrimEditor?.reset();roofTrimHistory=[];roofTrimFuture=[];projectId=String(id||'');roofTrimOnly=copy(metadata?.exteriorsRoofTrim||{});try{const localTrim=JSON.parse(localStorage.getItem(key(projectId)+':roof-trim')||'null');if(localTrim&&(localTrim.savedAt||0)>(roofTrimOnly.savedAt||0))roofTrimOnly=localTrim;}catch(e){}state=null;sourceContext=null;selected=null;stage=1;
        let local=null;try{local=JSON.parse(localStorage.getItem(key(projectId))||'null');}catch(e){storageError='Local wall backup could not be read.';}
        const server=metadata?.exteriorsWalls;
        const candidates=[server,local].filter(valid).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
        if(candidates.length){state=copy(candidates[0]);sourceContext=state.context;stage=Math.max(1,Math.min(7,state.stage||1));roofVisible=state.roofVisible!==false;gapHighlights=state.gapHighlights!==false;initializeGround();}
        if(state&&!state.roofTrim)state.roofTrim=copy(roofTrimOnly);wallsVisible=state?.wallsVisible!==false;editingLayer=state?.editingLayer||'base';
        const upgraded=upgradeEngine();window.WallChimneys?.normalizeDrafts(state?.wallEdits);window.normalizeWallDraftOwnership?.(state?.wallEdits);window.WallBaseBinding?.upgrade(state?.wallEdits);window.WallSolidGeometry?.cleanupSweepRemnants(state?.wallEdits);if(state)calculateStage(stage);
        restoreView(metadata,local);if(upgraded)persist();setModeUI();render();stableSelection=selectionSnapshot();pendingSelection=null;gestureSelection=null;restoreHistory(history,metadata?.exteriorsWalls);
    }
    function beforeProjectLoad() {roofTrimEditor?.finish();roofTrimEditor?.reset();if(roofTrimGroup){roofTrimGroup.parent?.remove(roofTrimGroup);disposeObject3D(roofTrimGroup);roofTrimGroup=null;}roofTrimOnly={};editHistory=[];editFuture=[];pendingEdit=null;stableSelection=null;pendingSelection=null;gestureSelection=null;groundEditor?.leave();persist(false);enabled=false;state=null;sourceContext=null;projectId='';setModeUI();disposeGroup();syncVisibility();}
    function ensureStage(next) {
        if(!state)return;
        if(state.roofSignature!==roofSignature()&&!generate(state.options.soffit))return;
        upgradeEngine();calculateStage(next);
        stage=next;selected=null;persist();render();
    }
    function generate(soffit,resetBase=false) {
        let before=null;const beforeSelection=selectionSnapshot();
        try {
            const signature=roofSignature(),captured=captureRoof(true);
            const options={soffit,ground:state?.options.ground??estimateGround(),tolerance:state?.options.tolerance??18*G.INCH};
            const r=G.buildSources(captured.roof,options);
            roofTrimEditor?.finish();roofTrimEditor?.reset();wallEditor?.leave?.();baseEditor?.leave?.();baseEditor?.clearSelection?.();pendingEdit=null;nudgeKey=null;nudgeEpoch++;
            before={state:copy(state),stage};baseTerrainKey=null;baseTerrainCache=null;
            const finishDefaults=copy(state?.finishDefaults||{}),roofTrim=copy(state?.roofTrim||roofTrimOnly),ground=state?.ground,groundCandidates=state?.groundCandidates,base=resetBase?undefined:state?.base,wallCenters=state?.wallCenters!==false,displayMode=state?.displayMode,translucent=state?.translucent!==false,boundExtrusionToRoof=state?.boundExtrusionToRoof!==false,undoSelections=state?.undoSelections!==false,wallTrimWidthInches=state?.wallTrimWidthInches===8?8:6;
            state={schemaVersion:1,engineVersion:ENGINE,...captured,roofSignature:signature,options,sources:r.sources,warnings:r.warnings,savedAt:Date.now(),ground,groundCandidates,base,wallCenters,translucent,displayMode,boundExtrusionToRoof,undoSelections,wallTrimWidthInches,roofTrim,finishDefaults};
            initializeGround();
            if(!ground&&groundEditor){try{state.ground=groundEditor.fitDSM();}catch(e){state.warnings.push(`Ground: ${e.message} Flat fallback retained.`);}}
            initializeBase();
            sourceContext=state.context;projectId=currentId();calculateStage(7);stage=7;selected=null;menu.hidden=true;document.getElementById('wall-auto').setAttribute('aria-expanded','false');
            details.textContent='';persist();render();
            if(before){const entry={full:true,before,after:{state:copy(state),stage},beforeSelection,afterSelection:selectionSnapshot()};editHistory.push(entry);pendingSelection=entry;}editFuture=[];return true;
        }catch(e){if(before){state=before.state;stage=before.stage;sourceContext=state?.context||null;baseTerrainKey='';persist();render();}status.textContent=`Could not rebuild walls: ${e.message}`;return false;}
    }
    function setEnabled(on) {
        if(on&&!currentId()){alert('Load a project before entering wall mode.');return;}
        roofTrimEditor?.finish();roofTrimEditor?.reset();if(!on){window.WallFeatures?.closeUI?.();groundEditor?.leave();baseEditor?.leave();wallEditor?.leave();}
        enabled=!!on;
        if(enabled){
            if(typeof exitMeasurementMode==='function')exitMeasurementMode();
            selectedPoints.clear();selectedLines.clear();if(typeof tempPoint!=='undefined')tempPoint=null;
        }
        persistView();setModeUI();persist();render();
        if(panel&&enabled&&state&&state.roofSignature!==roofSignature())generate(state.options.soffit);
        stableSelection=selectionSnapshot();pendingSelection=null;
        if(!enabled){window.renderGeometry2D?.();if(typeof renderGeometry3D==='function')renderGeometry3D();if(typeof apply3DSurfaceVisibility==='function')apply3DSurfaceVisibility();}
    }
    function setModeUI() {
        document.body.classList.toggle('wall-mode-active',enabled);
        window.updateExteriorHeaderLayout?.();
        const toggle=document.getElementById('wall-mode-toggle');
        if(toggle){toggle.textContent=enabled?'Return to roof':'Wall mode';toggle.setAttribute('aria-pressed',String(enabled));}
        if(panel)panel.hidden=!enabled;
        if(enabled){
            // Also close it when wall mode is restored from a saved project.
            if(typeof isMeasurementMode!=='undefined'&&isMeasurementMode&&typeof exitMeasurementMode==='function')exitMeasurementMode();
            document.getElementById('measurement-panel')?.remove();
            document.querySelectorAll('#global-toolbar [data-roof-only], #layer-controls-group button').forEach(button=>{
                if(!disabledRoofControls.has(button))disabledRoofControls.set(button,button.disabled);
                button.disabled=true;
            });
        }else{
            for(const [button,disabled]of disabledRoofControls)button.disabled=disabled;
            disabledRoofControls.clear();
        }
        syncVisibility();
    }
    let wallSceneDepth=0,wallSceneSnapshot=null;
    function withWallScene(fn){const outer=wallSceneDepth++===0;try{return fn();}finally{wallSceneDepth--;if(outer)wallSceneSnapshot=null;}}
    function currentWalls(){if(wallSceneDepth&&wallSceneSnapshot)return wallSceneSnapshot;const result=composeCurrentWalls();if(wallSceneDepth)wallSceneSnapshot=result;return result;}
    function composeCurrentWalls(){const walls=!state||stage===1?[]:stage===2?(state.extruded||[]):stage===3?(state.deduplicated||[]):stage===4?(state.gapRepaired||[]):stage===5?(state.mergedWalls||[]):stage===6?(state.cleanedWalls||[]):(state.alignedWalls||[]);const applied=wallEditor?.apply(walls)||walls;if(!state||stage<2||!window.WallChimneys)return applied;const composed=WallChimneys.compose(applied,state);const final=[...composed.filter(w=>!w.chimney),...(wallEditor?.apply(composed.filter(w=>w.chimney))||composed.filter(w=>w.chimney))];const edits=state.wallEdits||{},protectedIds=[...Object.keys(edits).filter(k=>!k.startsWith('$')),...Object.values(edits.$drafts||{}).flatMap(d=>d.members||[])];return stage>=7?WallChimneyCleanup.compose(final,state.chimneyCleanupReport,protectedIds):final;}
    function currentGaps(){const walls=currentWalls(),ground=wallFloor();const key=JSON.stringify([walls,ground]);if(key!==gapCacheKey){gapCacheKey=key;gapCache=window.WallGaps?.detect(walls,ground)||[];}return gapCache;}
    function svgEl(type,attrs,parent){const el=document.createElementNS(NS,type);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);parent.appendChild(el);return el;}
    function render2D(){return withWallScene(render2DContent);}
    function render2DContent() {
        const svg=document.getElementById('geoSvg');if(!svg)return;
        let rot=document.getElementById('geo-rotation-group');if(!rot){rot=svgEl('g',{id:'geo-rotation-group'},svg);}rot.replaceChildren();
        rot.setAttribute('transform',`rotate(${(viewRotation||0)*180/Math.PI},${imageWidth/2},${imageHeight/2})`);
        const inv=1/Math.max(.01,currentZoom||1);
        let roof=state?.roof,ctx=state?.context;
        if(!roof){try{const c=captureRoof();roof=c.roof;ctx=c.context;}catch(e){
            const c=currentContext();ctx=c;roof={points:(activeGeometry?.points||[]).map(p=>({x:(p.x-c.width/2)*c.mpp,y:(p.y-c.height/2)*c.mpp,z:Number(p.z)||0})),connections:(activeGeometry?.connections||[]).map(l=>({startIdx:activeGeometry.points.indexOf(l.start),endIdx:activeGeometry.points.indexOf(l.end)})),faces:[]};
        }}
        const line=(a,b,color,width=2,dashed=false)=>{a=toPixel(a,ctx);b=toPixel(b,ctx);return svgEl('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:color,'stroke-width':width*inv,...(dashed?{'stroke-dasharray':`${6*inv} ${4*inv}`}:{})},rot);};
        if(roofVisible&&roof) {
            for(const f of (window.WallChimneys?.roofWithOpenings(state)||roof).faces){const d=[f.points,...(f.holes||[])].map(r=>r.map((p,i)=>{const q=toPixel(p,ctx);return (i?'L':'M')+q.x+','+q.y;}).join(' ')+' Z').join(' ');svgEl('path',{d,fill:GREEN,'fill-opacity':.1,'fill-rule':'evenodd','pointer-events':'none'},rot);}
            for(const c of roof.connections){const a=roof.points[c.startIdx],b=roof.points[c.endIdx];if(a&&b)line(a,b,GREEN,1.5);}
        }
        if(!state)return;
        groundEditor?.draw2D(rot,svgEl,inv);
        const baseGroup=svgEl('g',{},rot);
        if(wallsVisible&&stage>=2){
            const defs=svgEl('defs',{},rot),mask=svgEl('mask',{id:'wall-base-mask',maskUnits:'userSpaceOnUse',x:-imageWidth,y:-imageHeight,width:imageWidth*3,height:imageHeight*3},defs);
            svgEl('rect',{x:-imageWidth,y:-imageHeight,width:imageWidth*3,height:imageHeight*3,fill:'white'},mask);
            for(const w of currentWalls())for(const edge of [w.bottom,w.top]){const a=toPixel(edge[0],ctx),b=toPixel(edge[1],ctx);svgEl('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'black','stroke-width':14*inv,'stroke-linecap':'round'},mask);}
            baseGroup.setAttribute('mask','url(#wall-base-mask)');
        }
        baseEditor?.draw2D(baseGroup,svgEl,inv);
        if(wallsVisible&&stage===1) for(const s of state.sources){
            const el=line(s.a,s.b,selected===s.id?'#fff':YELLOW,3,s.direction==='up');
            el.style.pointerEvents='stroke';el.style.cursor='pointer';el.addEventListener('click',()=>inspect(s.id));
            const title=svgEl('title',{},el);title.textContent=`${s.id}: ${s.kind==='return'?'lower wall return':s.type} → ${s.direction}${s.joins?`, joins ${s.joins}`:`, soffit ${(s.setback/G.INCH).toFixed(1)} in`}`;
        }
        else if(wallsVisible) {
            const geo=G.topology(currentWalls());
            for(const c of geo.connections)line(geo.points[c.startIdx],geo.points[c.endIdx],YELLOW,2.5);
            // Top and bottom vertices can share x/y; they remain distinct 3D points.
            const seen=new Set();for(const p of geo.points){const q=toPixel(p,ctx),k=`${q.x.toFixed(3)},${q.y.toFixed(3)}`;if(seen.has(k))continue;seen.add(k);svgEl('circle',{cx:q.x,cy:q.y,r:3*inv,fill:YELLOW,stroke:'#202124','stroke-width':inv},rot);}
        }
        wallEditor?.draw2D(rot,svgEl,inv);
        drawLineCenters2D(rot,inv);
        if(wallsVisible&&gapHighlights&&stage>=2)for(const gap of currentGaps()){
            const q=toPixel(gap.bottom),el=svgEl('circle',{cx:q.x,cy:q.y,r:6*inv,fill:GAP_COLOR,stroke:'#fff','stroke-width':inv,'pointer-events':'all'},rot);
            const label=`Ground-contact open edge: ${gap.bottom.z.toFixed(2)}–${gap.top.z.toFixed(2)} m (${(gap.top.z-gap.bottom.z).toFixed(2)} m high)`;
            svgEl('title',{},el).textContent=label;el.addEventListener('click',()=>{details.textContent=label;});
        }
    }
    // Use the same centerpoint toggle as the roof canvas. These are view markers,
    // not extra model vertices; zoom keeps their size constant on screen.
    function drawLineCenters2D(rot,inv){
        if(typeof showCenterpoints==='undefined'||!showCenterpoints)return;
        const seen=new Set(),segments=[];
        for(const el of rot.querySelectorAll?.('line,polygon,polyline')||[]){
            if(el.closest('defs,mask')||el.getAttribute('stroke')==='none'||!el.getAttribute('stroke')||el.hasAttribute('stroke-dasharray')||el.hasAttribute('data-curve-guide'))continue;
            const ps=el.tagName.toLowerCase()==='line'?[['x1','y1'],['x2','y2']].map(pair=>pair.map(k=>Number(el.getAttribute(k)))):(el.getAttribute('points')||'').trim().split(/\s+/).map(pair=>pair.split(',').map(Number));
            if(el.tagName.toLowerCase()==='polygon'&&ps.length)ps.push(ps[0]);
            for(let i=1;i<ps.length;i++)segments.push([ps[i-1],ps[i],el.getAttribute('stroke')]);
        }
        for(const [a,b,color]of segments){if(![...a,...b].every(Number.isFinite)||Math.hypot(b[0]-a[0],b[1]-a[1])<12*inv)continue;
            const x=(a[0]+b[0])/2,y=(a[1]+b[1])/2,key=x.toFixed(3)+','+y.toFixed(3);if(seen.has(key))continue;seen.add(key);
            svgEl('circle',{'data-wall-line-center':'',cx:x,cy:y,r:2.5*inv,fill:color,stroke:'#fff','stroke-width':inv,'pointer-events':'none'},rot);
        }
    }
    function disposeGroup() {if(group3D){disposeObject3D(group3D);group3D.parent?.remove(group3D);group3D=null;}lastScene=null;}
    function roofTrimVisible(){return enabled&&roofVisible;}
    function persistRoofTrim(){const value=state?.roofTrim||roofTrimOnly;value.savedAt=Date.now();if(projectId)try{localStorage.setItem(key(projectId)+':roof-trim',JSON.stringify(value));}catch(e){} }
    function roofTrimPickGroup(){return {traverse(fn){roofTrimGroup?.traverse(fn);if(typeof facesGroup!=='undefined')facesGroup?.traverse(o=>{if(o.isMesh){o.userData.pickLayer='roof';}fn(o);});}};}
    function drawRoofTrim(group,roof,vector){if(!window.RoofTrim)return;const panels=roofTrimEditor?.refresh(roof)||RoofTrim.panels(roof,state?.roofTrim||roofTrimOnly);for(const f of panels){if(f.deleted)continue;const geometry=new THREE.BufferGeometry().setFromPoints(f.points.map(vector));geometry.setIndex([0,1,2,0,2,3]);const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:roofTrimEditor?.selected(f.id)?'#ffd84d':'#b9b6ae',side:THREE.DoubleSide,transparent:false,opacity:1,depthWrite:true}));mesh.userData.pickLayer='roof';mesh.userData.roofTrimId=f.id;window.ExteriorFinishes?.prepare(mesh,f,f.points);group.add(mesh);}}
    // Compatibility hook for the roof renderer: exterior trim only renders in wall mode.
    function renderRoofTrim3D(){if(roofTrimGroup){roofTrimGroup.parent?.remove(roofTrimGroup);disposeObject3D(roofTrimGroup);roofTrimGroup=null;}roofTrimEditor?.update();}
    let editorRenderFrame=null,editorRenderFull=false;
    function requestEditorRender(full=false){
        editorRenderFull ||= full;
        if(editorRenderFrame!==null)return;
        const flush=()=>{editorRenderFrame=null;const full=editorRenderFull;editorRenderFull=false;withWallScene(()=>{if(full)render();else{render2D();render3D();}});};
        if(typeof requestAnimationFrame==='undefined'){flush();return;}
        editorRenderFrame=requestAnimationFrame(flush);
    }
    function render3D(){return withWallScene(render3DFrame);}
    function render3DFrame() {
        if(typeof scene==='undefined'||!scene||!window.THREE)return;
        const previous=group3D,previousScene=lastScene;
        try{render3DContent();scene.add(group3D);if(previous){previous.parent?.remove(previous);disposeObject3D(previous);}}
        catch(error){if(group3D&&group3D!==previous){group3D.parent?.remove(group3D);disposeObject3D(group3D);}group3D=previous;lastScene=previousScene;throw error;}
    }
    function render3DContent() {
        if(typeof scene==='undefined'||!scene||!window.THREE)return;
        lastScene=scene;group3D=new THREE.Group();group3D.name='exteriors-wall-preview';
        if(!enabled){syncVisibility();return;}
        if(roofTrimGroup){roofTrimGroup.parent?.remove(roofTrimGroup);disposeObject3D(roofTrimGroup);roofTrimGroup=null;}
        const vector=p=>getVector3(toPixel(p));
        const addLines=(points,connections,color)=>{const vertices=[];for(const c of connections){for(const i of [c.startIdx,c.endIdx]){const v=vector(points[i]);vertices.push(v.x,v.y,v.z);}}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));const obj=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color,depthTest:false,transparent:true,opacity:.95}));obj.renderOrder=10;group3D.add(obj);};
        let roof=state?.roof;
        if(!roof){try{const c=captureRoof();roof=c.roof;sourceContext=c.context;}catch(e){syncVisibility();return;}}
        if(roofVisible){
            addLines(roof.points,roof.connections,GREEN);
            for(const f of (window.WallChimneys?.roofWithOpenings(state)||roof).faces)for(const mesh of window.ExteriorFinishes.roofMeshes(f,vector,state?.displayMode==='textured'))group3D.add(mesh);
            drawRoofTrim(group3D,roof,vector);
        }
        if(wallsVisible&&state&&stage===1){const ps=[],cs=[];for(const s of state.sources){const i=ps.length;ps.push(s.a,s.b);cs.push({startIdx:i,endIdx:i+1});}addLines(ps,cs,YELLOW);}
        if(wallsVisible&&state&&stage>=2){
            // Form merged boundaries before choosing a presentation color. A
            // common wall/chimney plane must not be split back into source types.
            const geo=G.topology(currentWalls().filter(w=>!wallEditor?.hasDraft(w.id))),openings=window.ExteriorModel.indexOpenings(window.ExteriorModel.collect(state).filter(f=>f.feature));
            for(const f of geo.faces){
                const color=f.chimney?(window.WallChimneys?.COLOR||'#cf967a'):YELLOW;
                const boundary=f.boundary||f.pointIndices.map((id,i)=>[id,f.pointIndices[(i+1)%f.pointIndices.length]]);
                addLines(geo.points,boundary.map(([startIdx,endIdx])=>({startIdx,endIdx})),color);
                const hostFace={points:f.pointIndices.map(i=>geo.points[i])},parts=window.ExteriorModel.cutOpenings(hostFace,openings);
                const points=parts.length===1&&parts[0]===hostFace?f.triangles.flat().map(i=>geo.points[i]):parts.flatMap(part=>{const frame=window.WallSolidGeometry.faceFrame(part),rings=[part.points,...(part.holes||[])],flat=rings.flat(),local=p=>window.WallSolidGeometry.inFrame(frame,p);return window.ExteriorGeometry.triangles(rings[0].map(local),rings.slice(1).map(r=>r.map(local))).triangles.flat().map(i=>flat[i]);}),bg=new THREE.BufferGeometry().setFromPoints(points.map(vector));bg.computeVertexNormals();
                const mesh=new THREE.Mesh(bg,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.3,depthWrite:false}));mesh.userData.pickLayer='walls';window.ExteriorFinishes?.prepare(mesh,{points:f.pointIndices.map(i=>geo.points[i])},points);group3D.add(mesh);
                const vertices=f.pointIndices.flatMap(i=>{const v=vector(geo.points[i]);return [v.x,v.y,v.z];}),pg=new THREE.BufferGeometry();pg.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
                group3D.add(new THREE.Points(pg,new THREE.PointsMaterial({color,size:6,sizeAttenuation:false,depthTest:false})));
            }
        }
        roofTrimEditor?.update();groundEditor?.draw3D(group3D,vector);baseEditor?.draw3D(group3D,vector);wallEditor?.draw3D(group3D,vector);window.ExteriorDistanceInput?.render(wallEditor?.distanceInput()||baseEditor?.distanceInput());
        if(wallsVisible&&gapHighlights&&stage>=2){const points=[],connections=[];for(const gap of currentGaps()){const i=points.length;points.push(gap.bottom,gap.top);connections.push({startIdx:i,endIdx:i+1});}addLines(points,connections,GAP_COLOR);}
        window.exteriorSurfaceDisplay?.(group3D,state?.displayMode||(state?.translucent===false?'opaque':'translucent'));
        applyPlaneDisplay(group3D,vector);
        syncVisibility();
    }
    function applyPlaneDisplay(group,vector){
        const view=wallEditor?.planeView?.();if(!view||view.display==='normal')return;
        const K=window.ExteriorGeometry,f=view.frame,origin=vector(K.world(f,{x:0,y:0,z:0})),u=vector(K.world(f,{x:1,y:0,z:0})).sub(origin),v=vector(K.world(f,{x:0,y:1,z:0})).sub(origin),normal=u.clone().cross(v).normalize(),tolerance=Math.max(u.length(),v.length())*K.CONTACT;
        group.updateMatrixWorld(true);group.traverse(o=>{if(o.userData?.planeGuide||!o.material)return;const positions=o.geometry?.getAttribute('position');if(!positions)return;let on=true;const p=new THREE.Vector3();for(let i=0;i<positions.count;i++){p.fromBufferAttribute(positions,i).applyMatrix4(o.matrixWorld).sub(origin);if(Math.abs(p.dot(normal))>tolerance){on=false;break;}}if(on)return;if(view.display==='hidden'){o.visible=false;return;}
            // These render objects are rebuilt each frame; saved geometry/materials are untouched.
            for(const m of Array.isArray(o.material)?o.material:[o.material]){m.transparent=true;m.opacity*=.08;m.depthWrite=false;}
        });
    }
    function syncVisibility() {
        // OrbitControls measures from straight overhead: 90 degrees is level,
        // 170 degrees exposes undersides without reaching the bottom pole.
        const orbit=typeof controls!=='undefined'?controls:null;
        if(enabled&&orbit){
            if(orbitLimitOwner!==orbit){orbitLimitOwner=orbit;roofOrbitLimit=orbit.maxPolarAngle;}
            orbit.maxPolarAngle=170*Math.PI/180;
        }else if(!enabled&&orbitLimitOwner){
            orbitLimitOwner.maxPolarAngle=roofOrbitLimit;orbitLimitOwner.update?.();orbitLimitOwner=null;roofOrbitLimit=null;
        }

        // Hide the comparison surface once on entry, using the same state as
        // its toolbar button. Subsequent redraws must respect user toggles.
        if(enabled&&roofSurfaceVisible===null&&typeof googleTileState!=='undefined'&&typeof window.toggle3DImage==='function'){
            roofSurfaceVisible=googleTileState.surfaceVisible;
            window.toggle3DImage(false);
        }else if(!enabled&&roofSurfaceVisible!==null){
            const previous=roofSurfaceVisible;roofSurfaceVisible=null;
            window.toggle3DImage?.(previous);
        }
        if(enabled){
            const hide=(name,object)=>{if(!object)return;if(hiddenRoofObjects.get(name)?.object!==object)hiddenRoofObjects.set(name,{object,visible:object.visible});object.visible=false;};
            hide('wire',typeof geometryGroup!=='undefined'?geometryGroup:null);
            hide('faces',typeof facesGroup!=='undefined'?facesGroup:null);
            hide('guides',typeof snapGuidesGroup!=='undefined'?snapGuidesGroup:null);
        }else{
            for(const {object,visible}of hiddenRoofObjects.values())object.visible=visible;
            hiddenRoofObjects.clear();
        }
        if(group3D)group3D.visible=enabled;if(roofTrimGroup)roofTrimGroup.visible=!enabled&&roofTrimVisible();const trimVisible=roofTrimVisible();if(trimVisible!==roofTrimVisibility){roofTrimVisibility=trimVisible;roofTrimEditor?.update();}
        // init3D can replace the scene when deferred DSM or imagery arrives.
        if(enabled&&typeof scene!=='undefined'&&scene&&lastScene!==scene)render3D();
    }
    function inspect(id) {selected=id;const s=state?.sources.find(s=>s.id===id),setback=stage>=6?state?.rakeCleanupReport?.setbackCorrections?.find(c=>c.sourceIds.includes(id))?.after:undefined;details.textContent=s?`${s.id} · ${s.kind==='return'?'lower wall return':s.type.replaceAll('_',' ')} · ${s.direction==='up'?'up to next roof':'down to roof or ground'} · ${s.joins?`continues straight to ${s.joins}`:`${((setback??s.setback)/G.INCH).toFixed(1)} in setback`}`:'';render2D();}
    function render() {
        if(!panel)return;document.body.classList.toggle('exterior-textured',enabled&&state?.displayMode==='textured');
        document.getElementById('wall-lengths-toggle').value=state?.lineLengthMode||(state?.wallLengths===false?'off':'moving');document.getElementById('wall-feature-dimensions')?.setAttribute('aria-pressed',String(state?.featureDimensions!==false));
        document.getElementById('wall-roof-bounds').checked=state?.boundExtrusionToRoof!==false;
        document.getElementById('wall-undo-selections').checked=state?.undoSelections!==false;
        const displayButton=document.getElementById('wall-translucency-toggle'),displayMode=state?.displayMode||(state?.translucent===false?'opaque':'translucent');displayButton.textContent=displayMode[0].toUpperCase()+displayMode.slice(1);displayButton.title='Surface display: '+displayMode+'. Click to cycle translucent, opaque and textured.';displayButton.setAttribute('aria-label',displayButton.title);displayButton.setAttribute('aria-pressed',String(displayMode!=='translucent'));
        document.getElementById('wall-centers-toggle').setAttribute('aria-pressed',String(state?.wallCenters!==false));
        stageButtons.forEach((b,i)=>{b.disabled=!state;b.setAttribute('aria-pressed',String(stage===i+1));});
        document.getElementById('wall-roof-visibility').setAttribute('aria-pressed',String(roofVisible));
        if(!document.getElementById('wall-roof-visibility').dataset.layerIcon)document.getElementById('wall-roof-visibility').textContent='Roof';
        document.getElementById('wall-visible')?.setAttribute('aria-pressed',String(wallsVisible));
        const walls=currentWalls(),geo=G.topology(walls);
        badge.textContent=stage===1?'1 · Source lines':stage===2?'2 · Extruded walls':stage===3?'3 · Deduplicated':stage===4?'4 · Gap repairs':stage===5?'5 · Merged walls':stage===6?'6 · Rake cleanup':'7 · Chimney alignment';
        status.textContent=state?`${state.sources.length} sources · ${geo.faces.length} faces${stage>=6?` · ${state.rakeCleanupReport?.paths.length||0} rake returns cleaned${state.rakeCleanupReport?.skippedEdited?` · ${state.rakeCleanupReport.skippedEdited} edited returns kept`:''}`:''}${stage>=7?` · ${state.chimneyCleanupReport?.alignments.length||0} chimney planes aligned`:''}${state.chimneys?.items.length?` · ${state.chimneys.items.length} chimneys`:''}`:'Choose Auto wall and a soffit depth to preview source lines.';
        const messages=[...(state?.warnings||[]),...(state?.chimneys?.warnings||[]),...(stage>=2?(state?.extrusionWarnings||[]):[]),...(storageError?[storageError]:[])];
        warning.textContent=messages.join('\n');warning.hidden=!messages.length;
        document.getElementById('wall-tolerance').value=((state?.options.tolerance??18*G.INCH)/G.INCH).toFixed(1);
        document.getElementById('wall-tolerance').disabled=!state;
        document.querySelectorAll('[data-soffit]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.soffit===String(state?.options.soffit??'auto'))));
        document.getElementById('wall-soffit-label').textContent=state?(state.options.soffit==='auto'?'Auto soffit':`${state.options.soffit} in soffit`):'No sources yet';
        document.getElementById('wall-save-note').textContent=state?'Backed up in this browser · included in project Save':'Wall data is separate from roof geometry';
        document.getElementById('wall-gap-toggle').setAttribute('aria-pressed',String(gapHighlights));
        document.getElementById('wall-gap-status').textContent=stage<2?'Ground-contact open edges are checked after extrusion.':`${currentGaps().length} ground-contact open spans${stage>=4?` · ${state.gapReport?.paths.length||0} paths filled · ${state.gapReport?.sliversRemoved||0} slivers removed`:''}. Pink marks only open intervals touching the ground surface.`;
        groundEditor?.render();baseEditor?.render();
        if(enabled){render2D();render3D();}else {disposeGroup();syncVisibility();renderRoofTrim3D();}
    }
    function initialize() {
        const style=document.createElement('style');style.textContent=`
        #wall-advanced{position:relative;color:#eef3f7;font:12px system-ui} #wall-advanced[hidden]{display:none} #wall-advanced>summary{border:1px solid #ffffff26;border-radius:4px;background:#ffffff0d} #wall-advanced[open]>summary{background:#ffffff26} #wall-advanced>summary{list-style:none;cursor:pointer;padding:4px 8px;font-size:18px} #wall-advanced>summary::-webkit-details-marker{display:none} #wall-advanced>div{position:absolute;right:0;top:100%;width:290px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px;background:#242a30;border:1px solid #65707a;border-radius:7px;z-index:50;box-shadow:0 4px 14px #0006} #wall-advanced label{display:flex;justify-content:flex-start;gap:8px;align-items:center} #wall-advanced input{width:auto;flex:none} #wall-advanced p{font-size:12px;color:#b9c5cc;margin-top:8px}
        #wall-mode-toggle{margin:0 12px;padding:9px 14px;border:1px solid #d2ac27;border-radius:7px;background:#fff8da;color:#433600;font-weight:700;white-space:nowrap;cursor:pointer}
        #wall-mode-toggle[aria-pressed=true]{background:#ffd84d}
        #wall-panel{position:absolute;left:12px;top:12px;z-index:120;width:190px;max-width:calc(100% - 24px);max-height:calc(100% - 24px);overflow:auto;background:rgba(28,32,36,.96);color:#edf1f3;border:1px solid #53606a;border-radius:10px;box-shadow:0 6px 20px #0006;font:12px/1.3 'Segoe UI',sans-serif;padding:12px;box-sizing:border-box}
        #wall-panel[hidden],#wall-soffit-menu[hidden]{display:none} #wall-panel button{cursor:pointer;border:1px solid #5a6470;border-radius:5px;padding:5px 8px;background:#343c43;color:#fff;font:inherit}#wall-panel button:disabled{opacity:.45;cursor:default}#wall-panel button[aria-pressed=true]{border-color:#ffd84d;color:#ffd84d;background:#4d4525}#wall-panel .wall-row{display:flex;gap:5px;margin:5px 0;flex-wrap:wrap}#wall-layer-visibility button{flex-shrink:0}#wall-panel h3{font-size:13px;margin:0}#wall-panel p{margin:4px 0}#wall-panel p:empty{display:none}#wall-panel input{width:68px;background:#15191d;border:1px solid #616c75;border-radius:4px;color:white;padding:4px;font:inherit}#wall-panel label{display:flex;justify-content:space-between;align-items:center;margin:4px 0}#wall-soffit-menu{padding:7px;border:1px solid #65707a;border-radius:6px;background:#242a30}#wall-warning{white-space:pre-line;color:#ffdaa0;max-height:100px;overflow:auto}#wall-save-note{color:#aab7bf;font-size:11px}.wall-mode-active #smart-sticker-bar,.wall-mode-active #ss-toggle-btn,.wall-mode-active #structure-mode-bar{display:none!important}.wall-mode-active #global-toolbar [data-roof-only],.wall-mode-active #layer-controls-group,.wall-mode-active #toolbar-mode-shell{display:none!important}
        .wall-mode-active #global-toolbar .controls-group:has(>button[data-roof-only]):not(:has(>button:not([data-roof-only]))):not(:has(input)){display:none!important}
        .wall-mode-active #global-toolbar,.wall-mode-active #global-toolbar.toolbar-split{display:flex;flex-wrap:wrap;gap:6px;min-height:40px;padding:4px 10px}
        .wall-mode-active #global-toolbar .toolbar-row,.wall-mode-active #global-toolbar .toolbar-section{display:contents}
        .wall-mode-active #global-toolbar .controls-group{margin:0;padding:0 7px;gap:4px}
        .wall-mode-active #global-toolbar #layer-align-wrap{margin-left:0!important}.wall-mode-active #pitch-label-overlay{display:none!important}
        #wall-panel{overscroll-behavior:contain;scrollbar-width:thin}
        #wall-panel select{max-width:190px;background:#15191d;color:#fff;border:1px solid #616c75;border-radius:4px;padding:3px;font:inherit}
        #wall-panel hr{border:0;border-top:1px solid #53606a;margin:8px 0}
        #wall-panel .wall-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:5px;margin:5px 0}
        #wall-panel .wall-stages{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;margin:5px 0}
        #wall-panel .wall-stages button{padding:5px 2px;line-height:1.15}
        #wall-panel details{margin:5px 0;color:#b9c5cc}#wall-panel summary{cursor:pointer}
        #wall-panel .wall-fields{display:grid;grid-template-columns:minmax(0,1fr);gap:5px}
        #wall-panel .wall-fields label{gap:5px}#wall-panel .wall-fields select{min-width:0;max-width:100px}
        #wall-status,#ground-status{color:#b9c5cc;font-size:11px}#base-status{overflow-wrap:anywhere}
        #wall-panel .wall-row{flex-direction:column;align-items:stretch}#wall-panel button{white-space:normal;overflow-wrap:anywhere}#wall-panel label{gap:5px}#wall-panel select{min-width:0;max-width:100%}#wall-panel .wall-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}
        `;
        document.head.appendChild(style);
        const button=document.createElement('button');button.id='wall-mode-toggle';button.type='button';button.textContent='Wall mode';button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>setEnabled(!enabled));
        document.getElementById('addressBarContainer').appendChild(button);
        panel=document.createElement('section');panel.id='wall-panel';panel.hidden=true;panel.setAttribute('aria-label','Wall development tools');
        panel.innerHTML=`<div class="wall-heading"><h3>Walls</h3><details id="wall-advanced"><summary aria-label="Advanced settings" title="Advanced settings">&#9881;</summary><div><label><input id="wall-roof-bounds" type="checkbox" checked>Automatically trim faces to roof line</label><p>Keep extrusions below roof surfaces and follow their slopes, even when the roof is hidden.</p><label><input id="wall-undo-selections" type="checkbox" checked>Undo selection changes</label><p>Include selection-only steps in Undo and Redo. Geometry edits always restore their selection.</p></div></details><button id="wall-auto" aria-expanded="false">Auto wall ▾</button></div><button id="wall-roof-visibility" aria-pressed="true">Roof</button><div id="wall-soffit-menu" hidden><div class="soffit-title">Soffit setback</div><div class="soffit-options" role="group" aria-label="Soffit setback"><button data-soffit="auto"><span>Auto</span><small>From roof</small></button><button data-soffit="0"><span>No soffit</span><small>0 in</small></button><button data-soffit="2.4"><span>0.2 ft</span><small>2.4 in</small></button><button data-soffit="12"><span>1 ft</span><small>12 in</small></button><button data-soffit="18"><span>1.5 ft</span><small>18 in</small></button><button data-soffit="24"><span>2 ft</span><small>24 in</small></button></div></div><details id="wall-developer-stages"><summary>Developer stages</summary><div class="wall-stages" role="group" aria-label="Wall generation stage"><button data-stage="1">1 Sources</button><button data-stage="2">2 Extrude</button><button data-stage="3">3 Dedupe</button><button data-stage="4">4 Close gaps</button><button data-stage="5">5 Merge faces</button><button data-stage="6">6 Clean rake returns</button><button data-stage="7">7 Align chimney walls</button></div></details><p id="wall-status" role="status"></p><label>Line lengths<select id="wall-lengths-toggle" aria-label="Measurements"><option value="all">All lines</option><option value="moving" selected>When moving</option><option value="off">Off</option></select></label><div class="wall-grid"><button id="wall-feature-dimensions" aria-pressed="true">Feature dimensions</button><button id="wall-translucency-toggle" aria-pressed="true">Translucency</button><button id="wall-centers-toggle" aria-pressed="true">Face centers</button><button id="wall-gap-toggle" aria-pressed="true">Open edges</button><button id="wall-step" title="Select a sloped base or diagonal wall line. S adds steps; move sets offset; Ctrl+wheel adjusts tread width; click to place; Esc cancels.">Auto-step · S</button></div><label>Merge gap (in)<input id="wall-tolerance" type="number" min="0" max="36" step="1" aria-label="Deduplication gap in inches"></label><p id="wall-warning" role="alert"></p><div class="wall-row" id="wall-actions"><button id="wall-auto-trim" title="Apply 6 inch trim to outward wall corners, excluding inside corners and roof/ground boundaries">Auto trim</button><button id="wall-merge-all" title="Merge connected coplanar faces with matching materials">Merge faces</button><button id="wall-save">Save walls</button><button id="wall-rebuild" title="Rebuild from the current roof through all seven generation stages">Rebuild from roof</button></div><details><summary>Details &amp; shortcuts</summary><strong id="wall-stage-label"></strong><p id="wall-soffit-label"></p><p id="wall-details"></p><p id="wall-gap-status"></p><p id="wall-save-note"></p><p>Selected face: P toggles its drawing plane; double-click adds points, C connects, N extends, drag selects.<br>Selected lines: T adds trim; repeat for other side / centered. Default 6 in.<br>Selected wall edges or corners: R rounds (fillet); C chamfers.<br>Selected coplanar points: V creates a face using only those points.<br>Selected point: S draws a curve on its face in 2D or 3D; click center, then endpoint. U connects points.<br>Selected geometry: M moves on plane; R rotates; T flips; Y resizes.<br>Repeat M/R/Y to cycle reference planes. T cycles vertical / horizontal / original on the same plane. F toggles snapping.<br>Shared border: M moves along one face; M again switches face.<br>Flip: X horizontal / V vertical. Rotation snaps near 45&deg; increments.<br>Resize starts on All; click X/Y/Z or Ctrl+wheel to change axes.<br>Wheel zooms; Ctrl+wheel changes tool options.<br>Ctrl+C / V copies / pastes complete selected geometry.<br>Switch M / R / T during paste; Esc restores the whole preview.<br>Shift+F: restore a deleted face from selected boundary points.<br>W / D / G: place window / door / garage door.<br>Ctrl+W / D: type selected face; repeat for sizes.<br>Arrows: nudge 1 in · Shift 6 in · Alt ¼ in.<br>H / V: cut; repeat for side / other / both.<br>Click to place · Esc to cancel.</p></details>`;

        document.getElementById('workspace').appendChild(panel);
        groundEditor=window.createGroundEditor?.({getState:()=>state,ensureState:()=>!!state||generate('auto'),projectId:currentId,enabled:()=>enabled,toPixel,toMetric,changed:groundChanged,onEditing:on=>{editingLayer=on?'grade':'base';baseEditor?.render();},redraw:()=>requestEditorRender()});
        groundEditor?.setup(panel);
        const setLayer=(value,preserveVisibility=false,deferScene=false)=>{if(value!=='base'){if(baseEditor?.busy())baseEditor.leave();baseEditor?.clearSelection();}if(value!=='walls')wallEditor?.clear();editingLayer=value;if(value==='base'&&state?.base)baseState().base.visible=true;if(value==='walls'&&!preserveVisibility)wallsVisible=true;groundEditor?.setEditing(value==='grade');persist();if(deferScene){groundEditor?.render();baseEditor?.render();}else render();};
        baseEditor=window.createBaseEditor?.({pickVisible:p=>state?.displayMode!=='textured'&&window.wallPointPickVisible(group3D,getVector3(toPixel(p))),pickLineVisible:(pair,e)=>state?.displayMode!=='textured'&&window.wallLinePickVisible(group3D,...pair.map(p=>getVector3(toPixel(p))),e),walls:currentWalls,state:baseState,ensure:()=>!!state||generate('auto'),enabled:()=>enabled,id:currentId,layer:()=>editingLayer,setLayer,
            selectVisibleLayer:()=>setLayer(baseState()?.base?.visible!==false?'base':wallsVisible?'walls':'grade'),handleKey:e=>handleEditorKey(e),position:(...args)=>groundEditor.position(...args),toPixel,
            recordHistory:before=>{if(before.wallEdits?.$base)delete before.base;recordEdit(before);},undo:()=>undoEdit(),canUndo:()=>editHistory.some(e=>state?.undoSelections!==false||!e.selectionOnly),changed:()=>{groundChanged();finishEdit();baseEditor?.render();},redraw:()=>requestEditorRender()});
        baseEditor?.setup(panel);
        wallEditor=window.createWallEditor?.({pickVisible:p=>state?.displayMode!=='textured'&&window.wallPointPickVisible(group3D,getVector3(toPixel(p))),pickLineVisible:(pair,e)=>state?.displayMode!=='textured'&&window.wallLinePickVisible(group3D,...pair.map(p=>getVector3(toPixel(p))),e),pasteHost:e=>{const hit=window.wallNearestSurface?.(group3D,e);if(hit?.layer==='base'){const f=(state.wallEdits?.$base||state.base)?.faces.find(f=>f.id===hit.object.userData.baseId);if(f)return {f,points:f.points};}return null;},selectBaseEntities:(points,pairs,add,subtract)=>{setLayer('base');baseEditor?.selectEntities(points,pairs,add,subtract);},message:text=>{document.getElementById('base-status').textContent=text||'Walls selected';},setLayer,state:()=>state,enabled:()=>enabled,layer:()=>editingLayer,visible:()=>wallsVisible,roofVisible:()=>roofVisible,walls:currentWalls,toPixel,
            position:(...args)=>groundEditor.position(...args),floorHeight:p=>GroundGeometry.height(wallFloor(),p),recordHistory:before=>recordEdit({wallEdits:before}),changed:()=>{finishEdit();persist();requestEditorRender(true);},redraw:()=>requestEditorRender()});
        const resetWall=document.createElement('button');resetWall.id='wall-reset-position';resetWall.textContent='Reset wall position';resetWall.onclick=()=>wallEditor?.resetPosition();document.getElementById('wall-actions').appendChild(resetWall);
        panel.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
        panel.style.top='140px';panel.style.maxHeight='calc(100% - 152px)';panel.style.overflowY='auto';
        const wallToggle=document.createElement('button');wallToggle.id='wall-visible';wallToggle.textContent='Walls';
        wallToggle.onclick=()=>{wallsVisible=!wallsVisible;if(!wallsVisible&&editingLayer==='walls')setLayer(baseState()?.base?.visible!==false?'base':'grade');if(!wallToggle.dataset.layerIcon)wallToggle.textContent='Walls';persist();render();};
        const visibility=document.createElement('div');visibility.className='wall-row';visibility.id='wall-layer-visibility';visibility.setAttribute('aria-label','Visible layers');
        Object.assign(visibility.style,{position:'sticky',top:'-12px',zIndex:20,background:'#202124',padding:'4px 0',flexWrap:'nowrap',overflowX:'auto'});
        panel.prepend?.(visibility);
        const selectionReadout=document.createElement('p');selectionReadout.id='wall-selection-counts';selectionReadout.setAttribute('aria-label','Selected geometry');selectionReadout.style.cssText='margin:6px 0 10px;color:#f1f3f4;font-size:12px;';panel.prepend?.(selectionReadout);
        for(const b of [document.getElementById('wall-roof-visibility'),wallToggle,document.getElementById('base-visible'),document.getElementById('ground-visible')])registerLayerVisibility(b);
        for(const b of layerVisibilityButtons.values())visibility.appendChild(b);
        window.mountExteriorToolbar?.();
        menu=document.getElementById('wall-soffit-menu');badge=document.getElementById('wall-stage-label');status=document.getElementById('wall-status');details=document.getElementById('wall-details');warning=document.getElementById('wall-warning');stageButtons=[...panel.querySelectorAll('[data-stage]')];
        document.getElementById('wall-auto').onclick=e=>{menu.hidden=!menu.hidden;e.currentTarget.setAttribute('aria-expanded',String(!menu.hidden));};
        panel.querySelectorAll('[data-soffit]').forEach(b=>b.onclick=()=>generate(b.dataset.soffit,true));
        document.getElementById('wall-lengths-toggle').onchange=e=>{if(!state)return;state.lineLengthMode=e.target.value;state.wallLengths=e.target.value!=='off';persist();render();};document.getElementById('wall-feature-dimensions').onclick=()=>{if(!state)return;state.featureDimensions=state.featureDimensions===false;persist();render();};
        document.getElementById('wall-undo-selections').onchange=e=>{if(!state)return;state.undoSelections=e.target.checked;persist();baseEditor?.render();};
        for(const event of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','keydown','change'])window.addEventListener(event,watchSelectionInput,true);
        document.getElementById('wall-roof-bounds').onchange=e=>{if(!state)return;state.boundExtrusionToRoof=e.target.checked;persist();render();};
        document.getElementById('wall-translucency-toggle').onclick=()=>{if(!state)return;const modes=['translucent','opaque','textured'],mode=state.displayMode||(state.translucent===false?'opaque':'translucent');state.displayMode=modes[(modes.indexOf(mode)+1)%3];state.translucent=state.displayMode==='translucent';persist();render();};
        document.getElementById('wall-centers-toggle').onclick=()=>{if(!state)return;state.wallCenters=state.wallCenters===false;const base=baseState()?.base;if(base)base.centers=state.wallCenters;if(state.base)state.base.centers=state.wallCenters;persist();render();};
        stageButtons.forEach(b=>b.onclick=()=>ensureStage(Number(b.dataset.stage)));
        document.getElementById('wall-gap-toggle').onclick=()=>{gapHighlights=!gapHighlights;persist();render();};
        document.getElementById('wall-roof-visibility').onclick=()=>{roofTrimEditor?.finish();roofTrimEditor?.reset();roofVisible=!roofVisible;persist();render();};
        document.getElementById('wall-rebuild').onclick=()=>generate('auto',true);
        document.getElementById('wall-auto-trim').onclick=()=>{if(!enabled)return;nudgeEpoch++;nudgeKey=null;wallEditor?.autoTrim?.((state?.wallTrimWidthInches===8?8:6)*G.INCH);};
        document.getElementById('wall-merge-all').onclick=()=>{nudgeEpoch++;nudgeKey=null;wallEditor?.mergeAll?.();};
        document.getElementById('wall-save').onclick=async()=>{persist();status.textContent='Saving wall data…';try{const ok=await window.saveProjectData(true);status.textContent=ok===false?'Project save failed; local backup retained.':'Wall data saved with project.';}catch(e){status.textContent='Project save failed; local backup retained.';}};
        for(const [id,prop,scale]of [['wall-tolerance','tolerance',G.INCH]])document.getElementById(id).onchange=e=>{
            if(!state)return;const value=Number(e.target.value)*scale;
            if(!Number.isFinite(value)||(prop==='tolerance'&&(value<0||value>36*G.INCH))){render();return;}
            state.options[prop]=value;invalidateWalls();ensureStage(stage);
        };
        roofTrimEditor=window.createRoofTrimEditor?.({wallWidth:()=>state?.wallTrimWidthInches===8?8:6,setWallWidth:value=>{if(state&&[6,8].includes(value)){state.wallTrimWidthInches=value;persist();}},settings:()=>state?.roofTrim||roofTrimOnly,set:value=>{if(state)state.roofTrim=value;else roofTrimOnly=value;},enabled:()=>enabled,prepare:()=>{if(!roofVisible){roofVisible=true;render3D();}},visible:roofTrimVisible,redraw:()=>enabled?render3D():renderRoofTrim3D(),screen:p=>{const r=renderer.domElement.getBoundingClientRect(),q=getVector3(toPixel(p)).project(camera);if(q.z<-1||q.z>1)return null;return {x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};},clearSelection:()=>{baseEditor?.clearSelection();wallEditor?.clear();if(!enabled){selectedPoints.clear();selectedLines.clear();}},commit:before=>{if(state){recordEdit({roofTrim:before});finishEdit();persist();baseEditor?.render();}else{roofTrimHistory.push(before);roofTrimFuture=[];}persistRoofTrim();},undo:redo=>{if(state)undoEdit(redo);else{const from=redo?roofTrimFuture:roofTrimHistory,to=redo?roofTrimHistory:roofTrimFuture;if(from.length){to.push(copy(roofTrimOnly));roofTrimOnly=from.pop();persistRoofTrim();renderRoofTrim3D();}}}});
        function pickPointer(e){
                    if(wallEditor?.planeActive?.())return wallEditor.planeDown(e);
                    // A tool on an inactive layer cannot consume input for the active one.
                    if(baseEditor?.busy()){if(editingLayer==='base')return baseEditor.down(e);baseEditor.leave();}
                    if(wallEditor?.busy()){if(editingLayer==='walls')return wallEditor.down(e);wallEditor.clear();}
                    if(roofTrimEditor?.pick(e,group3D,p=>getVector3(toPixel(p))))return true;roofTrimEditor?.finish();if(roofTrimEditor?.hasSelection())roofTrimEditor.clear();
                    if(e.target.closest?.('#three-view-wrapper')&&wallEditor?.pickPoint?.(e))return true;
                    if(e.target.closest?.('#three-view-wrapper')&&wallEditor?.pickLine?.(e))return true;
                    const front=window.wallNearestSurface?.(group3D,e);
                    if(front){if(front.layer==='roof')return true;
                        if(editingLayer!==front.layer)setLayer(front.layer);
                        if(front.layer==='base')return baseEditor.down(e);
                        if(front.layer==='grade'){groundEditor?.down(e);return true;}
                        const data=front.object.userData;
                        if((data.solidId!==undefined||data.draftKey!==undefined)&&wallEditor?.pickSurface(e))return true;
                        return wallEditor?.down(e)||wallEditor?.pick(e);
                    }
                    if(editingLayer==='base'&&baseEditor?.canHit(e))return baseEditor.down(e);
                    if(wallEditor?.pickSurface(e))return true;
                    if(editingLayer==='walls'&&wallEditor?.hit(e))return wallEditor.down(e);
                    if(wallEditor?.pick(e))return true;
                    if(editingLayer==='walls'&&baseEditor?.canHit(e))setLayer('base');
                    if(editingLayer==='walls'&&wallEditor?.canBox?.())return wallEditor.down(e);
                    return baseEditor?.down(e)||(editingLayer==='grade'&&groundEditor?.down(e));
        }
        // Capture before roof/plugin handlers. Panning, wheel zoom and orbit remain available.
        for(const type of ['pointerdown','mousedown','dblclick','click'])window.addEventListener(type,e=>{
            if(type==='pointerdown'){nudgeEpoch++;nudgeKey=null;}
            if(!enabled)return;if(e.target.closest?.('#resource-3d-controls,#roof-trim-control,#wall-panel,#exterior-toolbar,#axis-gizmo-container,.enh-control-panel,.controls-3d-actions,.exterior-sticker-bar,.exterior-sticker-menu'))return;
            if(e.target.closest?.('#viewport,#three-view-wrapper') && e.button===0){
                if((type==='click'||type==='dblclick')&&wallEditor?.consumeSelectionClick?.()){e.stopImmediatePropagation();e.preventDefault();return;}
                if(type==='dblclick'&&(editingLayer==='base'?baseEditor?.doubleClick(e):editingLayer==='walls'&&wallEditor?.doubleClick(e))){e.stopImmediatePropagation();e.preventDefault();return;}
                if(type==='pointerdown'){nudgeEpoch++;nudgeKey=null;
                    // A fresh press supersedes a drag whose pointer-up was lost.
                    baseEditor?.cancelPointerGesture();wallEditor?.cancelPointerGesture();
                    // Canvas selection consumes the native event, so hand focus back explicitly.
                    document.activeElement?.blur?.();
                    if(editingLayer!=='base'&&baseEditor?.busy())baseEditor.leave();
                    if(editingLayer!=='walls'&&wallEditor?.busy())wallEditor.clear();
                    const free=!baseEditor?.busy()&&!wallEditor?.busy();
                    if(free&&!wallEditor?.planeActive?.()&&e.target.closest?.('#three-view-wrapper')&&wallEditor?.startBox?.(e,()=>{pickPointer(e);wallEditor?.finishPointer?.(e);baseEditor?.finishPointer?.(e);})){e.stopImmediatePropagation();e.preventDefault();return;}
                    if(pickPointer(e)){e.stopImmediatePropagation();e.preventDefault();return;}
                }
                if(type==='click'&&e.target.closest?.('#geoSvg'))return;
                e.stopImmediatePropagation();e.preventDefault();
            }
        },true);
        function cancelInteraction(){
            if(!enabled)return;
            if(roofTrimEditor?.busy())roofTrimEditor.cancel();else if(roofTrimEditor?.hasSelection())roofTrimEditor.clear();if(!enabled)return;
            if(baseEditor?.busy())baseEditor.leave();
            if(wallEditor?.busy())wallEditor.clear();
            render2D();render3D();
        }
        // Transient drag state must not survive a missed release (for example
        // releasing over another pane). Click-to-place tools remain active.
        window.addEventListener('pointermove',e=>{
            if(!enabled||(e.buttons&1))return;
            baseEditor?.cancelPointerGesture();wallEditor?.cancelPointerGesture();
        },true);
        const advanced=document.getElementById('wall-advanced');
        document.addEventListener('pointerdown',e=>{if(!e.target.closest?.('#wall-advanced'))advanced.open=false;});
        advanced.addEventListener('keydown',e=>{if(e.key==='Escape'){advanced.open=false;advanced.querySelector('summary')?.focus();e.preventDefault();e.stopPropagation();}});
        const interaction=document.createElement('div');interaction.id='wall-interaction-status';interaction.hidden=true;
        interaction.style.cssText='display:none;align-items:center;gap:8px;max-width:100%;color:#ffe29a;font:12px system-ui';
        const interactionText=document.createElement('span'),cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='enh-btn';cancelButton.textContent='Cancel · Esc';cancelButton.onclick=()=>wallEditor?.planeActive?.()?wallEditor.keyDown({key:'Escape'}):cancelInteraction();interaction.append(interactionText,cancelButton);
        const planeControls=document.createElement('label');planeControls.textContent='Other geometry ';planeControls.hidden=true;
        const planeDisplay=document.createElement('select');planeDisplay.id='plane-other-geometry';planeDisplay.setAttribute('aria-label','Off-plane geometry');
        for(const [value,text]of [['normal','Normal'],['faint','Faint'],['hidden','Hidden']]){const option=document.createElement('option');option.value=value;option.textContent=text;planeDisplay.appendChild(option);}planeDisplay.value='faint';planeDisplay.onchange=()=>wallEditor?.setPlaneDisplay(planeDisplay.value);planeControls.appendChild(planeDisplay);interaction.appendChild(planeControls);
        const updateInteraction=()=>{
            const counts=selectionCounts();selectionReadout.textContent='Selected: '+counts.points+' points · '+counts.lines+' lines · '+counts.faces+' faces';
            const plane=wallEditor?.planeView?.();planeControls.hidden=!plane;cancelButton.textContent=plane?.rotating?'Cancel - Esc':plane?'Exit plane (P)':'Cancel - Esc';if(plane)planeDisplay.value=plane.display;

            const toolbar=document.querySelector('#three-container .enh-control-panel');const mainToolbar=document.getElementById('exterior-main-toolbar');if(mainToolbar&&advanced.parentElement!==mainToolbar)mainToolbar.appendChild(advanced);advanced.hidden=!enabled;if(!enabled)advanced.open=false;if(toolbar&&interaction.parentElement!==toolbar)toolbar.appendChild(interaction);
            const name=enabled&&(wallEditor?.interaction()||baseEditor?.interaction());
            interaction.hidden=!name;interaction.style.display=name?'flex':'none';
            if(name){const detail=document.getElementById('base-status')?.textContent||'';const text=name+' · '+(name==='Rectangle selection'?'drag and release':detail||'Click to place; Escape cancels');if(interactionText.textContent!==text)interactionText.textContent=text;}
        };
        setInterval(updateInteraction,150);
        window.addEventListener('blur',cancelInteraction);
        window.addEventListener('pointercancel',cancelInteraction,true);
        function handleEditorKey(e){
            if(window.ProjectResources?.handleKey(e))return true;
            if(!enabled)return;
            if(!e.target.closest?.('input,textarea,select,[contenteditable=true]')&&!e.ctrlKey&&!e.metaKey&&(e.key.toLowerCase()==='p'||wallEditor?.planeActive?.())){if(e.key.toLowerCase()==='p'){if(!e.repeat){const entity=editingLayer==='base'?baseEditor?.chamferSelection?.():null,source=entity?.points?.length&&entity.points.length<=2?{axisPoints:entity.points}:editingLayer==='base'?baseEditor?.selectedFaceGeometry?.():null;setLayer('walls',true);wallEditor?.togglePlane(source);}}else if(!window.ExteriorDistanceInput?.key(e,wallEditor?.distanceInput()))wallEditor?.keyDown(e);e.preventDefault();e.stopImmediatePropagation();return true;}
            if(e.key.startsWith('Arrow')&&!e.ctrlKey&&!e.metaKey)nudgeKey=nudgeEpoch+':'+e.key+':'+!!e.shiftKey+':'+!!e.altKey;else if(!['Shift','Alt','Control','Meta'].includes(e.key)){nudgeEpoch++;nudgeKey=null;}
            if(e.target.closest?.('input,textarea,select,[contenteditable=true]'))return;if(roofTrimEditor?.key(e))return true;
            if(e.key!=='Escape'&&e.target.closest?.('.enh-control-panel,.controls-3d-actions,.pane-swap-button'))return;
            if((e.ctrlKey||e.metaKey)&&['c','v'].includes(e.key.toLowerCase())){const copy=e.key.toLowerCase()==='c',selection=copy&&editingLayer==='base'?baseEditor?.chamferSelection?.():null;if(!copy)setLayer('walls',true);wallEditor?.clipboardCommand(copy?'copy':'paste',selection);e.preventDefault();e.stopImmediatePropagation();return true;}
            if(editingLayer==='base'&&!baseEditor?.busy()&&!wallEditor?.busy()&&!e.ctrlKey&&!e.metaKey&&['m','r','t','y'].includes(e.key.toLowerCase())){const selection=baseEditor?.chamferSelection?.();if(selection?.points?.length>=3){setLayer('walls',true);wallEditor?.geometryCommand(e.key.toLowerCase(),selection);e.preventDefault();e.stopImmediatePropagation();return true;}}
            if(window.ExteriorDistanceInput?.key(e,wallEditor?.distanceInput()||baseEditor?.distanceInput()))return;
            if(e.key==='Escape'){window.WallFeatures?.closeUI?.();cancelInteraction();menu.hidden=true;e.preventDefault();e.stopImmediatePropagation();return true;}
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s')return;
            if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){undoEdit(e.key.toLowerCase()==='y'||e.shiftKey);e.preventDefault();e.stopImmediatePropagation();return true;}
            if(editingLayer==='base'&&baseEditor?.busy()&&!e.ctrlKey&&!e.metaKey&&['e','c'].includes(e.key.toLowerCase())&&!baseEditor.finishToolForSwitch())return true;
            if(editingLayer==='base'&&!baseEditor?.busy()&&!wallEditor?.busy()&&['e','m'].includes(e.key.toLowerCase())&&!e.ctrlKey&&!e.metaKey){const selection=baseEditor?.entitySelection();if(selection?.point||selection?.pair){setLayer('walls',true);wallEditor?.beginEntity(e.key.toLowerCase()==='e'?'extrude':'move',selection);e.preventDefault();e.stopImmediatePropagation();return true;}}
            if(editingLayer==='base'&&!baseEditor?.busy()&&!wallEditor?.busy()&&!e.ctrlKey&&!e.metaKey){const k=e.key.toLowerCase(),selection=baseEditor?.chamferSelection?.();if(k==='s'&&selection?.points?.length===1&&!selection.edges?.length)return baseEditor.keyDown(e);if(k==='r'&&(selection?.edges?.length||selection?.points?.length===1)){setLayer('walls',true);wallEditor?.chamferCommand(selection,true);e.preventDefault();e.stopImmediatePropagation();return true;}if(k==='e'){const source=baseEditor?.selectedFaceGeometry?.();if(source){setLayer('walls',true);wallEditor?.extrudeFace(source);e.preventDefault();e.stopImmediatePropagation();return true;}}}
            if(editingLayer==='base'&&e.key.toLowerCase()==='c'&&!baseEditor?.busy()&&!wallEditor?.busy()&&!e.ctrlKey&&!e.metaKey){const selection=baseEditor?.chamferSelection?.();setLayer('walls',true);wallEditor?.chamferCommand(selection);e.preventDefault();e.stopImmediatePropagation();return true;}
            if(editingLayer==='base'&&e.key.toLowerCase()==='v'&&!baseEditor?.busy()&&!wallEditor?.busy()&&!e.ctrlKey&&!e.metaKey){const selection=baseEditor?.chamferSelection?.();if(selection?.points?.length>=3){setLayer('walls',true);wallEditor?.createSelectedFace(selection);e.preventDefault();e.stopImmediatePropagation();return true;}}
            if(editingLayer==='base'&&['h','v'].includes(e.key.toLowerCase())&&!baseEditor?.busy()&&!e.ctrlKey&&!e.metaKey){const p=baseEditor?.singlePoint(),preferred=baseEditor?.selectedFaceId();if(p){setLayer('walls',true);wallEditor?.cutFromPoint(p,e.key.toLowerCase(),preferred);e.preventDefault();e.stopImmediatePropagation();return true;}}
            if(e.key.toLowerCase()==='v'&&!e.ctrlKey&&!e.metaKey&&!wallEditor?.busy()&&!baseEditor?.busy()){const points=wallEditor?.pointSelection?.();if(points?.length>=3){wallEditor.createSelectedFace({points});e.preventDefault();e.stopImmediatePropagation();return true;}}
            if(e.key.toLowerCase()==='g'&&!e.altKey&&!e.ctrlKey&&!e.metaKey){setLayer('walls',true);if(wallEditor?.keyDown(e))return true;}
            if(baseEditor?.keyDown(e)||wallEditor?.keyDown(e))return true; if(e.key==='Escape'){menu.hidden=true;return;}
            if(e.key.toLowerCase()==='e'){document.getElementById('base-status').textContent=editingLayer==='base'?'Select a base point or line to extrude, or a wall face.':'Select a face, a line, or a single point to extrude.';}
            if(e.key==='Tab'||e.key.startsWith('F'))return;
            e.stopImmediatePropagation();if(['Delete','Backspace',' '].includes(e.key))e.preventDefault();
            return true;
        }
        window.addEventListener('wheel',e=>{
            if(!enabled||e.target.closest?.('#wall-panel,.exterior-sticker-menu,.enh-control-panel,.controls-3d-actions,.pane-swap-button,input,textarea,select'))return;
            if((editingLayer==='base'?baseEditor:wallEditor)?.stepWheel(e)){e.preventDefault();e.stopImmediatePropagation();}
        },{capture:true,passive:false});
        window.addEventListener('keydown',handleEditorKey,true);
        document.getElementById('wall-step').onclick=()=>{if(editingLayer==='base')baseEditor?.stepCommand();else{if(editingLayer!=='walls')setLayer('walls');wallEditor?.stepCommand();}};
        window.WallFeatures?.mountUI((...args)=>{if(editingLayer!=='walls')setLayer('walls');window.SmartStickers?.exitPlacement();return wallEditor?.featureCommand(...args);},()=>wallEditor?.featureSelection(),()=>wallEditor?.busy(),{
            color(color){if(editingLayer!=='walls')setLayer('walls');window.SmartStickers?.exitPlacement();wallEditor?.colorCommand(color);},paint(type){if(editingLayer!=='walls')setLayer('walls');window.SmartStickers?.exitPlacement();wallEditor?.materialCommand(type);},
            placement:()=>wallEditor?.featurePlacement?.(),active:()=>wallEditor?.activeMaterial()||'default',
            defaults(value){const current={material:'unassigned',color:'#80868b',trimColor:'#f5f3ef',...state?.finishDefaults};if(!value)return current;if(!enabled||!state||!window.ExteriorMaterials?.[value.material]||value.material==='default'||!/^#[0-9a-f]{6}$/i.test(value.color)||!/^#[0-9a-f]{6}$/i.test(value.trimColor))return current;recordEdit({});state.finishDefaults=copy(value);finishEdit();persist();render();return value;},
            finish(){if(wallEditor?.interaction()==='Paint material'){wallEditor.clear();render();}},
            colors(value){if(!state)return true;if(typeof value==='boolean'){state.materialColors=value;persist();render();}return state.materialColors!==false;}
        });
        window.addEventListener('beforeunload',()=>persist(false));
        setModeUI();render();
    }
    function reportSnapshot(){
        if(!state||stage<2)return null;
        const faces=window.ExteriorModel.collect(state,currentWalls()).flatMap(f=>window.WallChimneys?.visibleParts(f,state)||[f]);
        return window.ExteriorReportModel.build({faces:faces.map(f=>{const finish=window.ExteriorFinishes?.resolve(f,state.finishDefaults);return finish?{...f,material:finish.material,finishColor:finish.color}:f;}),base:state.wallEdits?.$base||state.base,roof:state.roof,context:state.context});
    }
    window.WallMode={get finishDefaults(){return state?.finishDefaults||{};},renderRoofTrim3D,serializeRoofTrim:()=>copy(state?.roofTrim||roofTrimOnly),reportSnapshot,registerLayerVisibility,get enabled(){return enabled;},render2D,render3D,syncVisibility,serialize:exportState,serializeHistory,serializeView:()=>projectId===currentId()?viewSnapshot():null,restore,beforeProjectLoad,setEnabled};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
