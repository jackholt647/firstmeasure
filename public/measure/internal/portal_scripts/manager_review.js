/* portal_scripts/manager_review.js
 * Manager Audit Plugin v5.0
 *
 * Layout (inspector mode = full width, no left column):
 *   ┌───────────────────────────────────────────────────────┐
 *   │ PDF toolbar (pages 1/2/3, colors, undo/redo, bg tog)  │
 *   │ PDF spread (3-page default) + annotation canvas        │
 *   │ Help bar                                                │
 *   ├──────────┬──────────┬──────────┬──────────┬────────────┤
 *   │  Info &  │          │          │          │            │
 *   │  Buttons │  N map   │  E map   │  S map   │  W map     │
 *   │  + Nav   │          │          │          │            │
 *   └──────────┴──────────┴──────────┴──────────┴────────────┘
 *
 * v5 changes:
 *  - Bottom row is 5 equal-ish columns: info panel + 4 tall quad maps
 *  - Ctrl+Z / Ctrl+Y undo/redo with full history saved to manifest
 *  - Annotations auto-save to manifest on every change (debounced)
 *  - Text annotations have semi-opaque white background (toggleable)
 *  - Address click-to-copy, edit button, all nav in info panel
 */
(function(){
  if (!window.Portal) return;
  const cfg=()=>window.Portal.cfg;
  const apiServer=()=>(cfg().endpoints&&cfg().endpoints.server)?cfg().endpoints.server:window.Portal.internalLegacyEndpoint();
  function canPerformReview(){const p=cfg().perms||{};const u=cfg().user||{};const r=String(u.role||'').toLowerCase();return r==='admin'||!!u.is_admin||!!p.perform_manager_review}
  function canViewResults(){const p=cfg().perms||{};const u=cfg().user||{},f=cfg().flags||{};const r=String(u.role||'').toLowerCase();return r==='admin'||r==='manager'||r==='qa'||!!u.is_admin||!!p.view_manager_review_results||!!p.manage_qa||!!f.is_qa_role||!!p.platform_admin||!!p.is_admin_legacy}
  function canOverrideResults(){const u=cfg().user||{};const r=String(u.role||'').toLowerCase();return r==='admin'||r==='manager'||!!u.is_admin}
  function canAccess(){return canPerformReview()||canViewResults()}
  const ISSUE_CATEGORIES=[['missing_section','Missing section'],['missing_structure','Missing structure'],['missing_skylight_chimney','Missing skylight/chimney'],['wrong_shapes_or_tracing','Wrong shapes or tracing'],['wrong_line_types','Wrong line types'],['didnt_follow_customer_notes',"Didn't follow customer notes"]];

  // ==================== STATE ====================
  let allProjects=[],techList=[],currentPeriod='week';
  let activeWorkspace=canPerformReview()?'review':'results',resultsData=null,resultsLoaded=false,resultsFilterState=null,resultsPage=1;
  let dailySample={date:'',configured_target:100,target:0,selected:0,completed:0,remaining:0};
  let currentTechEmail=null,currentTechName=null;
  let techProjects=[],displayProjects=[],projectFilter='all';
  let currentProjectIdx=-1,currentProject=null,currentManifest=null;
  let currentSlide='techs',loadSeq=0,inspectorSeq=0;
  let uiWired=false,inView=false,showFillers=true;
  // Quad
  let quadMaps={n:null,e:null,s:null,w:null},quadMarkers={n:null,e:null,s:null,w:null};
  const QH={n:0,e:90,s:180,w:270};let quadLastLoc=null;
  // PDF
  let pdfJsLoaded=false,pdfJsLoading=false;
  let pdfDoc=null,pdfPageCount=0,pdfCurrentStart=0,pdfPagesPerView=3;
  // Annotations
  let annotColor='#ef4444',annotWidth=3;
  let annotCanvas=null,annotCtx=null;
  let annotData={};  // keyed by pageStart: {strokes:[], undoStack:[], redoStack:[]}
  let annotCurrentStroke=null,annotDrawing=false;
  let annotCanvasW=0,annotCanvasH=0;
  let annotTextEl=null,annotTextX=0,annotTextY=0;
  let annotTextBg=true; // text background toggle
  let saveTimer=null;
  let annotDirty=false;
  let cachedAppMeta=null; // cached app_metadata from load, so we can merge
  let saveState='idle'; // 'idle'|'saving'|'saved'|'error'
  let pendingReviewImages=[];
  const REVIEW_IMAGE_MAX_BYTES=10*1024*1024;
  const REVIEW_IMAGE_MAX_FILES=5;
  const REVIEW_IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp']);

  try{const sf=localStorage.getItem('mra_show_fillers');if(sf!==null)showFillers=sf==='true';const sp=localStorage.getItem('mra_period');if(sp)currentPeriod=sp;const ppv=localStorage.getItem('mra_pages_per_view');if(ppv)pdfPagesPerView=Math.max(1,Math.min(3,parseInt(ppv)));const tb=localStorage.getItem('mra_text_bg');if(tb!==null)annotTextBg=tb!=='false'}catch(e){}

  // ==================== HELPERS ====================
  function esc(s){return Portal.escapeHtml(s)}
  function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
  function parseSD(d){if(!d)return null;let s=String(d).trim().replace(' ','T');if(!/[Zz]$/.test(s)&&!/[+-]\d{2}:\d{2}$/.test(s))s+='Z';const dt=new Date(s);return isNaN(dt.getTime())?null:dt}
  function fmtDate(d){const dt=parseSD(d);return dt?dt.toLocaleString():(d||'')}
  function fmtShort(d){const dt=parseSD(d);if(!dt)return d||'';const now=new Date();if(dt.toDateString()===now.toDateString())return dt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'})+' '+dt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
  function localDate(d){const dt=d||new Date();return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`}
  function withTimeout(p,ms,l){let t;const to=new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(l||'Timeout')),ms)});return Promise.race([p.finally(()=>clearTimeout(t)),to])}
  async function apiPost(payload,ms){return await withTimeout(Portal.apiPost(apiServer(),payload),ms||25000,'Timeout')}
  function fmProjectPdfUrl(folderId, slot){const query=new URLSearchParams({slot:slot||'main'});return `${Portal.fmUrl(`projects/${encodeURIComponent(folderId)}/pdf`)}?${query.toString()}`}
  function fmArtifactUrl(folderId,fileName){return Portal.fmUrl(`projects/${encodeURIComponent(folderId)}/artifacts/${encodeURIComponent(fileName)}`)}
  async function fmGetEditorBundle(folderId,ms){return await withTimeout(apiPost({action:'manager_review_project_bundle',folder:folderId},ms||20000),ms||20000,'Project load timed out')}
  async function fmSaveMetadata(folderId,metadata,ms){return await withTimeout(apiPost({action:'manager_review_annotations_save',folder:folderId,annotations:asObj(metadata).manager_review_annotations||{}},ms||12000),ms||12000,'Project save timed out')}
  function fmActor(){if(typeof Portal.internalActor==='function')return Portal.internalActor();const u=(cfg().user||{}),f=(cfg().flags||{}),a={};if(u.email)a.email=u.email;if(u.name)a.name=u.name;if(u.role)a.role=u.role;if(u.team_id)a.team_id=u.team_id;if(u.organization_id)a.organization_id=u.organization_id;const roles=[];if(u.role)roles.push(String(u.role).toLowerCase());if(u.is_admin)roles.push('admin');if(f.is_manager_role)roles.push('manager');if(f.is_queue_admin)roles.push('queue_admin');if(roles.length)a.roles=[...new Set(roles)];return a}
  async function fmPatchProject(folderId,patch,ms){return await withTimeout(Portal.fmJson(`projects/${encodeURIComponent(folderId)}`,{method:'PATCH',headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({...patch,actor:fmActor()})}),ms||15000,'Project save timed out')}
  function mapsOk(){return!!(window.google&&google.maps&&typeof google.maps.Map==='function')}
  function safeLoc(lat,lng){const a=parseFloat(lat),b=parseFloat(lng);return(isFinite(a)&&isFinite(b))?{lat:a,lng:b}:null}
  const AC=['#1a73e8','#34a853','#ea4335','#fbbc04','#5e35b1','#00897b','#e91e63','#ff6d00'];
  function avatarColor(e){let h=0;for(let i=0;i<e.length;i++)h=e.charCodeAt(i)+((h<<5)-h);return AC[Math.abs(h)%AC.length]}
  function initials(n){return(n||'?').split(/\s+/).slice(0,2).map(w=>(w[0]||'')).join('').toUpperCase()||'?'}

  // ==================== ANNOT PAGE DATA ====================
  function pageKey(){return String(pdfCurrentStart)}
  function getPage(){const k=pageKey();if(!annotData[k])annotData[k]={strokes:[],undoStack:[],redoStack:[]};return annotData[k]}
  function pushUndo(){const pg=getPage();pg.undoStack.push(JSON.parse(JSON.stringify(pg.strokes)));pg.redoStack=[];if(pg.undoStack.length>80)pg.undoStack.splice(0,pg.undoStack.length-80)}
  function doUndo(){const pg=getPage();if(!pg.undoStack.length)return;pg.redoStack.push(JSON.parse(JSON.stringify(pg.strokes)));pg.strokes=pg.undoStack.pop();redrawAnnot();scheduleSave()}
  function doRedo(){const pg=getPage();if(!pg.redoStack.length)return;pg.undoStack.push(JSON.parse(JSON.stringify(pg.strokes)));pg.strokes=pg.redoStack.pop();redrawAnnot();scheduleSave()}

  // ==================== AUTO-SAVE ====================
  function scheduleSave(){annotDirty=true;if(saveTimer)clearTimeout(saveTimer);showSaveState('saving');saveTimer=setTimeout(()=>doSaveAnnotations(),800)}
  async function doSaveAnnotations(){
    if(saveTimer){clearTimeout(saveTimer);saveTimer=null}
    if(!currentProject){showSaveState('idle');return true}
    if(!getAnnotSnapshot()&&!annotDirty){showSaveState('idle');return true}
    if(cachedAppMeta===null){
      try{
        const mf=await fmGetEditorBundle(currentProject.id,12000);
        cachedAppMeta=(mf&&typeof mf.app_metadata==='object'&&mf.app_metadata)?mf.app_metadata:{};
      }catch(e){
        showSaveState('error');
        console.error('[MRA] Metadata hydrate failed:',e);
        return false;
      }
    }
    // Merge annotations into the cached app_metadata so we don't overwrite other data
    const merged=Object.assign({},cachedAppMeta||{},{manager_review_annotations:annotData});
    try{
      const res=await fmSaveMetadata(currentProject.id,merged,12000);
      if(res&&res.success){cachedAppMeta=merged;annotDirty=false;showSaveState('saved');console.log('[MRA] Annotations saved');return true}
      else{showSaveState('error');console.error('[MRA] Save failed:',res);return false}
    }catch(e){showSaveState('error');console.error('[MRA] Save error:',e);return false}
  }
  function showSaveState(state){
    saveState=state;
    const el=document.getElementById('mraSaveIndicator');if(!el)return;
    if(state==='saving'){el.textContent='Saving…';el.style.color='#fbbc04';el.style.opacity='1'}
    else if(state==='saved'){el.textContent='Saved ✓';el.style.color='#34a853';el.style.opacity='1';setTimeout(()=>{if(saveState==='saved'){el.style.opacity='.4'}},2000)}
    else if(state==='error'){el.textContent='Save failed ✗';el.style.color='#ea4335';el.style.opacity='1'}
    else{el.textContent='';el.style.opacity='0'}
  }

  // ==================== STYLES ====================
  function ensureStyles(){
    if(document.getElementById('mraStyles'))return;
    const css=`
      #portalPluginViews{flex:1;min-height:0;display:flex;flex-direction:column}
      #view-manager_review{flex:1;min-height:0;flex-direction:column}
      #view-manager_review>.header-bar{flex-shrink:0}
      .mra-wrap{display:flex;gap:18px;flex:1;min-height:0;overflow:hidden}
      .mra-wrap.list-mode .mra-left{width:100%;min-width:0;display:flex}
      .mra-wrap.list-mode .mra-right-full{display:none}
      .mra-wrap.inspector-mode .mra-left{display:none}
      .mra-wrap.inspector-mode .mra-right-full{display:flex}
      .mra-panel{background:#fff;border:1px solid var(--border);border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden;min-height:0}
      .mra-left{flex-direction:column;position:relative;min-height:0}
      .mra-right-full{flex:1;flex-direction:column;min-width:0;min-height:0;background:#525659;border-radius:14px;overflow:hidden;position:relative}
      .mra-topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid #eee}
      .mra-title{font-weight:900;letter-spacing:.2px;color:#202124;display:flex;align-items:center;gap:10px}
      .mra-stats{display:flex;gap:10px;align-items:center}
      .mra-stat{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 12px;border-radius:10px;border:1px solid #eee;background:#fafafa;min-width:80px}
      .mra-stat .v{font-weight:900;font-size:18px;color:var(--primary);line-height:1}
      .mra-stat .l{font-size:10px;font-weight:800;color:#777;text-transform:uppercase;margin-top:4px}
      .mra-period-bar{display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid #eee;background:#fafafa}
      .mra-period-btn{padding:6px 14px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid #e0e0e0;background:#fff;color:#555;cursor:pointer;transition:all .12s;user-select:none}.mra-period-btn:hover{background:#f0f1f2;border-color:#ccc}.mra-period-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
      .mra-period-bar .spacer{flex:1}
      .mra-body{overflow-y:auto;flex:1;padding:0}
      .mra-deck{position:relative;flex:1;overflow:hidden;display:flex;flex-direction:column}
      .mra-slide{position:absolute;inset:0;display:flex;flex-direction:column;transform:translateX(0);opacity:1;transition:transform 200ms cubic-bezier(.2,.9,.2,1),opacity 180ms ease;will-change:transform,opacity}.mra-slide.hidden{pointer-events:none;opacity:0;transform:translateX(-16px)}.mra-slide.off-right{pointer-events:none;opacity:0;transform:translateX(16px)}
      .mra-tech-list{padding:14px 18px;display:flex;flex-direction:column;gap:10px}
      .mra-tech-card{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid #e0e0e0;border-radius:12px;background:#fff;cursor:pointer;transition:all .12s;user-select:none}.mra-tech-card:hover{border-color:#1a73e8;box-shadow:0 4px 16px rgba(26,115,232,.1);transform:translateY(-1px)}
      .mra-tech-card .avatar{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;color:#fff;flex-shrink:0;text-transform:uppercase}
      .mra-tech-card .info{flex:1;min-width:0}.mra-tech-card .info .name{font-weight:900;font-size:14px;color:#202124}.mra-tech-card .info .email{font-size:11px;color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mra-tech-card .chips{display:flex;gap:6px;flex-wrap:wrap}
      .mra-chip{padding:4px 10px;border-radius:999px;font-size:10px;font-weight:900;text-transform:uppercase;white-space:nowrap}.mra-chip.total{background:#f1f3f4;color:#5f6368}.mra-chip.unreviewed{background:#fff7e0;color:#7a4b00;border:1px solid #fbbc04}.mra-chip.flagged{background:#fce8e6;color:#b0261e;border:1px solid #f1b7b2}.mra-chip.reviewed{background:#e6f4ea;color:#137333;border:1px solid #c8e6c9}.mra-chip.completed{background:#e8f0fe;color:#1a73e8}.mra-chip.rejected{background:#f5f5f5;color:#666}
      .mra-tech-card .arrow{color:#ccc;font-size:18px}.mra-tech-card:hover .arrow{color:#1a73e8}
      .mra-proj-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #eee;background:#fff}
      .mra-back-btn{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid #e0e0e0;border-radius:8px;background:#fff;cursor:pointer;color:#777;font-size:13px;flex-shrink:0}.mra-back-btn:hover{background:#f5f5f5;color:#333}
      .mra-proj-head .meta{flex:1;min-width:0}.mra-proj-head .meta .name{font-weight:900;font-size:15px;color:#202124}.mra-proj-head .meta .sub{font-size:11px;color:#777;font-weight:700}
      .mra-proj-toolbar{display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid #eee;background:#fafafa;flex-wrap:wrap}
      .mra-filter-btn{padding:5px 12px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid #e0e0e0;background:#fff;color:#555;cursor:pointer;transition:all .12s}.mra-filter-btn:hover{background:#f0f1f2}.mra-filter-btn.active{background:#1a73e8;border-color:#1a73e8;color:#fff}
      .mra-toggle-wrap{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;color:#555;cursor:pointer;user-select:none}
      .mra-toggle-switch{position:relative;width:32px;height:18px;background:#ccc;border-radius:999px;transition:background .15s;flex-shrink:0}.mra-toggle-switch.on{background:#34a853}.mra-toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .15s}.mra-toggle-switch.on::after{transform:translateX(14px)}
      .mra-table{width:100%;border-collapse:collapse}.mra-table th{background:#f8f9fa;padding:10px 12px;text-align:left;font-size:11px;color:#555;text-transform:uppercase;border-bottom:1px solid #eee;white-space:nowrap;cursor:pointer;user-select:none}.mra-table th:hover{background:#eef0f2}.mra-table td{padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;vertical-align:middle}.mra-table tr:hover td{background:#fafafa}.mra-table tr.flagged-row td{background:#fef7f6}.mra-table tr.reviewed-row td{opacity:.55}.mra-table tr.reviewed-row:hover td{opacity:.85}
      .mra-audit-badge,.mra-status-badge{padding:3px 8px;border-radius:999px;font-size:10px;font-weight:900;text-transform:uppercase;display:inline-flex;align-items:center;gap:4px}
      .mra-audit-badge.unreviewed{background:#fff7e0;color:#7a4b00}.mra-audit-badge.reviewed{background:#e6f4ea;color:#137333}.mra-audit-badge.flagged{background:#fce8e6;color:#b0261e}
      .mra-status-badge.completed{background:#e6f4ea;color:#137333}.mra-status-badge.rejected{background:#fce8e6;color:#b0261e}
      .mra-pill{padding:2px 6px;border-radius:4px;font-size:9px;font-weight:900;margin-left:4px;text-transform:uppercase}.mra-pill.filler{background:#e8f0fe;color:#1a73e8}.mra-pill.vip{background:#fff8e1;color:#7a4b00}.mra-pill.expedited{background:#ecfdf5;color:#0f766e}
      .mra-bulk-bar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #eee;background:#fafafa}.mra-bulk-bar .info{flex:1;font-size:12px;color:#666;font-weight:700}
      .mra-btn{border:1px solid var(--border);background:#fff;padding:8px 12px;border-radius:10px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:transform .08s,box-shadow .12s,background .12s;user-select:none;font-size:13px}.mra-btn:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);transform:translateY(-1px)}.mra-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}.mra-btn.sm{padding:5px 10px;font-size:12px;border-radius:8px}.mra-btn.success{background:#34a853;border-color:#34a853;color:#fff}.mra-btn.success:hover{background:#2d8e47}.mra-btn.danger{background:#d93025;border-color:#d93025;color:#fff}.mra-btn.danger:hover{background:#b0261e}.mra-btn.warning{background:#f9ab00;border-color:#f9ab00;color:#fff}.mra-btn.warning:hover{background:#e69500}.mra-btn.ghost{background:#f8f9fa;border-color:#e9eaee;color:#333}.mra-btn.secondary{background:#fff;border:1px solid #1a73e8;color:#1a73e8}.mra-btn.secondary:hover{background:#e8f0fe}

      /* Right panel inner */
      .mra-right-inner{display:flex;flex-direction:column;flex:1;min-height:0}
      /* PDF section - takes remaining space above bottom */
      .mra-pdf-section{flex:1;display:flex;flex-direction:column;min-height:200px}
      .mra-pdf-toolbar{display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.1);flex-shrink:0;flex-wrap:wrap;min-height:36px}
      .mra-pdf-toolbar .tg{display:flex;align-items:center;gap:3px}
      .mra-pdf-toolbar .ts{width:1px;height:18px;background:rgba(255,255,255,.15);margin:0 2px}
      .mra-pdf-toolbar .tl{color:rgba(255,255,255,.65);font-size:10px;font-weight:800;white-space:nowrap}
      .mra-pdf-toolbar button{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.85);padding:3px 7px;border-radius:5px;font-size:10px;font-weight:800;cursor:pointer;transition:all .1s;display:flex;align-items:center;gap:3px}.mra-pdf-toolbar button:hover{background:rgba(255,255,255,.2)}.mra-pdf-toolbar button.active{background:rgba(255,255,255,.3);border-color:rgba(255,255,255,.4);color:#fff}.mra-pdf-toolbar button:disabled{opacity:.3;cursor:not-allowed}
      .mra-pdf-toolbar .cb{width:18px;height:18px;border-radius:50%;padding:0;border:2px solid rgba(255,255,255,.2)}.mra-pdf-toolbar .cb.active{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.3)}
      .mra-pdf-spread{flex:1;display:flex;position:relative;background:#3a3d41;overflow:hidden;align-items:center;justify-content:center;min-height:0}
      .mra-pdf-spread .page-canvas{max-height:100%;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.3)}
      .mra-pdf-spread .annot-layer{position:absolute;top:0;left:0;cursor:crosshair;touch-action:none}
      .mra-pdf-spread .annot-text-input{position:absolute;background:rgba(255,255,255,.85);border:none;outline:2px solid;padding:2px 4px;font-family:-apple-system,system-ui,sans-serif;font-weight:700;font-size:14px;min-width:60px;z-index:5;border-radius:2px}
      .mra-pdf-spread .no-pdf{color:rgba(255,255,255,.5);font-weight:800;font-size:14px}
      .mra-pdf-help{padding:3px 10px;background:rgba(0,0,0,.4);color:rgba(255,255,255,.45);font-size:10px;font-weight:700;text-align:center;flex-shrink:0}

      /* ===== Bottom row: 5 columns (info + 4 maps) ===== */
      .mra-bottom-row{display:flex;gap:6px;flex-shrink:0;height:42%;min-height:220px;max-height:420px;padding:6px 10px 10px;overflow:hidden}
      .mra-bi-panel{flex:0 0 220px;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.12)}
      .mra-bi-inner{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 12px;display:flex;flex-direction:column;gap:6px;color:#fff}
      .mra-bi-addr{font-weight:900;font-size:12px;color:#fff;cursor:pointer;transition:color .1s;line-height:1.3;word-break:break-word}.mra-bi-addr:hover{color:#90caf9}
      .mra-bi-sub{font-size:10px;color:rgba(255,255,255,.5);font-weight:700;line-height:1.3}
      .mra-bi-grid{display:flex;flex-direction:column;gap:8px;margin-top:4px}
      .mra-bi-grid .bi-item{display:flex;flex-direction:column;gap:2px}
      .mra-bi-grid .lbl{font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.3px;color:rgba(255,255,255,.4);line-height:1}
      .mra-bi-grid .val{font-size:11px;font-weight:700;color:rgba(255,255,255,.85);line-height:1.3;word-break:break-all}
      .mra-bi-flag{padding:6px 8px;border:1px solid #f1b7b2;border-radius:6px;background:rgba(217,48,37,.2);font-size:11px;color:#fca5a5;line-height:1.3}
      .mra-bi-actions{padding:8px 12px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:5px;overflow-x:hidden;overflow-y:auto}
      .mra-bi-actions .mra-btn{width:100%;justify-content:center;font-size:11px;padding:6px 8px;border-radius:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mra-review-categories{display:flex;flex-wrap:wrap;gap:4px}.mra-category-btn{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#e5e7eb;border-radius:6px;padding:4px 6px;font-size:9px;font-weight:850;cursor:pointer;line-height:1.15}.mra-category-btn.selected{background:#d93025;border-color:#f28b82;color:#fff}.mra-review-note{width:100%;box-sizing:border-box;min-height:43px;max-height:70px;resize:vertical;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:rgba(255,255,255,.09);color:#fff;padding:6px 7px;font:10px inherit}.mra-review-note::placeholder{color:rgba(255,255,255,.48)}.mra-review-help{font-size:9px;color:rgba(255,255,255,.55)}
      .mra-review-upload{display:flex;flex-direction:column;gap:5px}.mra-review-upload-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 8px;border:1px dashed rgba(255,255,255,.35);border-radius:7px;background:rgba(255,255,255,.08);color:#fff;font-size:10px;font-weight:900;cursor:pointer}.mra-review-upload-btn:hover{background:rgba(255,255,255,.16)}.mra-review-upload-hint{font-size:8px;color:rgba(255,255,255,.45);text-align:center}.mra-review-previews{display:flex;gap:5px;flex-wrap:wrap}.mra-review-preview{position:relative;width:42px;height:42px;border:1px solid rgba(255,255,255,.25);border-radius:6px;overflow:hidden;background:#222}.mra-review-preview img{width:100%;height:100%;object-fit:cover}.mra-review-preview button{position:absolute;top:1px;right:1px;width:16px;height:16px;border:0;border-radius:50%;padding:0;background:rgba(0,0,0,.72);color:#fff;font-size:8px;cursor:pointer}.mra-result-images{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.mra-result-images img{width:44px;height:44px;object-fit:cover;border:1px solid #d8dde6;border-radius:6px}
      .mra-bi-nav{display:flex;align-items:center;gap:4px;padding:6px 12px;border-top:1px solid rgba(255,255,255,.08);overflow:hidden}
      .mra-bi-nav button{flex:1;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.8);padding:5px;border-radius:6px;font-size:11px;font-weight:900;cursor:pointer}.mra-bi-nav button:hover{background:rgba(255,255,255,.2)}.mra-bi-nav button:disabled{opacity:.3;cursor:not-allowed}
      .mra-bi-nav .ctr{color:rgba(255,255,255,.5);font-size:10px;font-weight:900;min-width:40px;text-align:center}
      .mra-bi-copied{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 16px;background:#34a853;color:#fff;border-radius:8px;font-size:13px;font-weight:900;z-index:99999;opacity:0;transition:opacity .15s;pointer-events:none}.mra-bi-copied.show{opacity:1}
      /* Quad maps - each takes 1fr */
      .mra-bottom-row .qc{flex:1;position:relative;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.1);background:#2d2f33;min-width:0}
      .mra-bottom-row .qc .ql{position:absolute;top:4px;left:4px;z-index:2;padding:2px 7px;border-radius:5px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;font-weight:900;letter-spacing:.5px;pointer-events:none}
      .mra-bottom-row .qc .qm{width:100%;height:100%}.mra-bottom-row .qc .qm>div{width:100%!important;height:100%!important}

      .mra-flag-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:30px}
      .mra-flag-modal{background:#fff;border-radius:16px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2)}.mra-flag-modal .fh{display:flex;align-items:center;gap:10px;padding:18px 22px;border-bottom:1px solid #eee}.mra-flag-modal .fh h3{margin:0;font-size:16px;font-weight:950;color:#b0261e;flex:1}.mra-flag-modal .fx{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;color:#777}.mra-flag-modal .fx:hover{background:#f5f5f5;color:#333}.mra-flag-modal .fb{padding:18px 22px}.mra-flag-modal .fb textarea{width:100%;min-height:80px;border:1px solid #d0d0d0;border-radius:10px;padding:12px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box}.mra-flag-modal .fb textarea:focus{border-color:#d93025;outline:none}.mra-flag-modal .ff{display:flex;gap:10px;padding:14px 22px;border-top:1px solid #eee;justify-content:flex-end}
      .mra-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 30px;color:#999;text-align:center}.mra-empty-state .icon{font-size:48px;margin-bottom:16px;opacity:.3}.mra-empty-state .title{font-weight:900;font-size:16px;color:#555;margin-bottom:6px}.mra-empty-state .sub{font-size:13px}
      .mra-kbd-hint{position:fixed;bottom:16px;right:16px;padding:10px 16px;background:rgba(0,0,0,.85);color:#fff;border-radius:10px;font-size:11px;font-weight:800;z-index:100;display:none;line-height:1.8}.mra-kbd-hint.show{display:block}.mra-kbd-hint kbd{display:inline-block;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.15);font-size:10px;margin:0 2px}
      .mra-workspace-tabs{display:flex;gap:6px;padding:4px;background:#f1f3f4;border-radius:10px}.mra-workspace-tab{border:0;background:transparent;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:900;color:#64748b;cursor:pointer}.mra-workspace-tab.active{background:#fff;color:#b3261e;box-shadow:0 1px 4px rgba(0,0,0,.12)}
      .mra-results{display:none;flex:1;min-height:0;overflow:auto;padding:16px;background:#f6f8fb}.mra-results.active{display:block}.mra-results-filters{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:10px;background:#fff;border:1px solid #e5e8ef;border-radius:14px;padding:14px;margin-bottom:14px}.mra-results-filters label,.mra-results-settings label{font-size:10px;font-weight:900;text-transform:uppercase;color:#64748b}.mra-results-filters input,.mra-results-filters select,.mra-results-settings input{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:8px;border:1px solid #d7dce5;border-radius:8px;background:#fff}.mra-results-settings{display:flex;align-items:end;gap:10px;background:#fff;border:1px solid #e5e8ef;border-radius:14px;padding:14px;margin-bottom:14px}.mra-results-settings label{width:180px}.mra-results-settings .hint{font-size:11px;color:#7b8492;flex:1}.mra-results-cards{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:10px;margin-bottom:14px}.mra-results-card{background:#fff;border:1px solid #e5e8ef;border-radius:14px;padding:14px}.mra-results-card .v{font-size:25px;font-weight:950;color:#1f2937}.mra-results-card .l{font-size:10px;font-weight:900;text-transform:uppercase;color:#7b8492;margin-top:4px}.mra-results-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.mra-results-panel{background:#fff;border:1px solid #e5e8ef;border-radius:14px;overflow:hidden}.mra-results-panel h3{font-size:13px;margin:0;padding:13px 15px;border-bottom:1px solid #edf0f4}.mra-results-table{width:100%;border-collapse:collapse}.mra-results-table th,.mra-results-table td{padding:9px 11px;border-bottom:1px solid #eef1f5;text-align:left;font-size:11px}.mra-results-table th{font-size:9px;text-transform:uppercase;color:#6b7280;background:#fafbfc}.mra-results-table .score{font-size:14px;font-weight:950}.mra-results-empty{padding:36px;text-align:center;color:#8b95a5}.mra-blind-banner{padding:9px 14px;background:#eef6ff;border:1px solid #cfe3fb;border-radius:10px;color:#215a94;font-size:11px;font-weight:800}.mra-queue-home{max-width:660px;margin:50px auto;padding:32px;text-align:center}.mra-queue-home .queue-icon{width:64px;height:64px;margin:0 auto 16px;border-radius:18px;background:#e8f0fe;color:#1a73e8;display:flex;align-items:center;justify-content:center;font-size:26px}.mra-queue-home h2{font-size:24px;margin:0 0 7px;color:#202124}.mra-queue-home .queue-sub{font-size:13px;color:#687386;margin-bottom:24px}.mra-progress-track{height:12px;background:#e8edf3;border-radius:999px;overflow:hidden;margin:8px 0}.mra-progress-fill{height:100%;background:linear-gradient(90deg,#1a73e8,#34a853);border-radius:inherit}.mra-progress-copy{display:flex;justify-content:space-between;font-size:11px;font-weight:800;color:#687386;margin-bottom:24px}.mra-next-sample{font-size:15px;padding:12px 22px}.mra-queue-note{margin-top:14px;font-size:11px;color:#8b95a5}.mra-flag-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.mra-flag-grid label{font-size:10px;font-weight:900;text-transform:uppercase;color:#667085}.mra-flag-grid input,.mra-flag-grid select{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:9px;border:1px solid #d0d5dd;border-radius:8px;background:#fff}
      .mra-result-list{margin-top:14px}.mra-result-row td{vertical-align:top}.mra-result-row.excluded td{opacity:.52;background:#f4f5f7}.mra-result-row.excluded .mra-result-address{text-decoration:line-through}.mra-result-address{font-weight:900;color:#1f2937}.mra-result-note{margin-top:4px;color:#64748b;max-width:430px;white-space:normal}.mra-result-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.mra-result-tag{padding:3px 6px;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:9px;font-weight:850}.mra-result-tag.pass{background:#dcfce7;color:#166534}.mra-result-tag.excluded{background:#e5e7eb;color:#4b5563}.mra-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 14px}.mra-pagination span{font-size:11px;color:#64748b;font-weight:800}
      @media(max-width:1100px){.mra-results-filters{grid-template-columns:repeat(3,1fr)}.mra-results-cards{grid-template-columns:repeat(3,1fr)}}@media(max-width:1000px){.mra-bottom-row{flex-wrap:wrap;height:auto;max-height:none}.mra-bi-panel{flex:0 0 100%}.mra-bottom-row .qc{min-height:120px}.mra-results-grid{grid-template-columns:1fr}}
    `;
    const s=document.createElement('style');s.id='mraStyles';s.textContent=css;document.head.appendChild(s);
  }

  // ==================== MARKUP ====================
  function ensureMarkup(){
    const host=document.getElementById('portalPluginViews');if(!host||document.getElementById('view-manager_review'))return;
    const w=document.createElement('div');w.id='view-manager_review';w.style.display='none';
    w.innerHTML=`
      <div class="header-bar"><h1>QA Quality</h1><div style="display:flex;gap:10px;align-items:center"><div class="mra-workspace-tabs">${canPerformReview()?'<button class="mra-workspace-tab" id="mraReviewTab"><i class="fas fa-user-secret"></i> Blind Review</button>':''}${canViewResults()?'<button class="mra-workspace-tab" id="mraResultsTab"><i class="fas fa-chart-bar"></i> Results</button>':''}</div><button class="btn-secondary" id="mraRefreshBtn"><i class="fas fa-sync"></i> Refresh</button></div></div>
      <div class="mra-wrap list-mode" id="mraWrap">
        <div class="mra-panel mra-left"><div class="mra-deck">
          <div class="mra-slide" id="mraSlideTechs"><div class="mra-topbar"><div><div class="mra-title"><i class="fas fa-user-secret" style="color:var(--primary)"></i> Blind Audit Queue</div></div><div class="mra-stats"><div class="mra-stat"><div class="v" id="mraTotalTechs">0</div><div class="l">Selected</div></div><div class="mra-stat"><div class="v" id="mraTotalUnreviewed">0</div><div class="l">Left</div></div><div class="mra-stat"><div class="v" id="mraTotalFlagged">0</div><div class="l">Done</div></div></div></div><div class="mra-period-bar" id="mraPeriodBar" style="display:none"></div><div class="mra-body" id="mraTechBody"><div class="mra-empty-state"><div class="icon"><i class="fas fa-spinner fa-spin"></i></div><div class="title">Loading…</div></div></div></div>
          <div class="mra-slide off-right" id="mraSlideProjects"><div class="mra-proj-head"><div class="mra-back-btn" id="mraProjBack"><i class="fas fa-arrow-left"></i></div><div class="meta"><div class="name" id="mraProjTechName">Tech</div><div class="sub" id="mraProjTechSub">0</div></div></div><div class="mra-proj-toolbar" id="mraProjToolbar"></div><div class="mra-body" id="mraProjBody"><table class="mra-table"><thead><tr id="mraProjHead"></tr></thead><tbody id="mraProjTbody"></tbody></table></div><div class="mra-bulk-bar"><div class="info" id="mraBulkInfo">0</div><button class="mra-btn success sm" id="mraBulkReviewBtn"><i class="fas fa-check-double"></i> Mark All Reviewed</button></div></div>
        </div></div>
        <div class="mra-right-full" id="mraRightFull"><div class="mra-right-inner" id="mraRightInner">
          <div class="mra-pdf-section">
            <div class="mra-pdf-toolbar" id="mraPdfToolbar">
              <div class="tg"><button id="mraPdfPrev" disabled><i class="fas fa-chevron-left"></i></button><span class="tl" id="mraPdfPageLabel">No PDF</span><button id="mraPdfNext" disabled><i class="fas fa-chevron-right"></i></button></div><div class="ts"></div>
              <div class="tg"><span class="tl">View:</span><button id="mraV1">1</button><button id="mraV2">2</button><button id="mraV3" class="active">3</button></div><div class="ts"></div>
              <div class="tg"><button class="cb active" id="mraClrR" style="background:#ef4444"></button><button class="cb" id="mraClrB" style="background:#3b82f6"></button><button class="cb" id="mraClrK" style="background:#1e1e1e"></button><div class="ts"></div><button id="mraUndo" title="Undo (Ctrl+Z)"><i class="fas fa-undo"></i></button><button id="mraRedo" title="Redo (Ctrl+Y)"><i class="fas fa-redo"></i></button><button id="mraClearA" title="Clear page"><i class="fas fa-trash"></i></button><div class="ts"></div><button id="mraBgToggle" title="Toggle text background" class="active"><i class="fas fa-font"></i> Bg</button></div>
            </div>
            <div class="mra-pdf-spread" id="mraPdfSpread"><span class="no-pdf">Select a project</span></div>
            <div class="mra-pdf-help" style="display:flex;align-items:center;justify-content:center;gap:6px"><span><i class="fas fa-question-circle"></i> Draw to annotate · Double-click to type · Ctrl+Z undo · Ctrl+Y redo</span><span id="mraSaveIndicator" style="font-weight:900;transition:opacity .3s;opacity:0;margin-left:6px"></span></div>
          </div>
          <div class="mra-bottom-row" id="mraBottomRow">
            <div class="mra-bi-panel"><div class="mra-bi-inner" id="mraBiInner"></div><div class="mra-bi-actions" id="mraBiActions"></div><div class="mra-bi-nav" id="mraBiNav"></div></div>
            <div class="qc"><div class="ql">N</div><div class="qm" id="mraMapN"></div></div>
            <div class="qc"><div class="ql">E</div><div class="qm" id="mraMapE"></div></div>
            <div class="qc"><div class="ql">S</div><div class="qm" id="mraMapS"></div></div>
            <div class="qc"><div class="ql">W</div><div class="qm" id="mraMapW"></div></div>
          </div>
        </div></div>
      </div>
      <div class="mra-results" id="mraResults"><div class="mra-results-empty"><i class="fas fa-spinner fa-spin"></i> Loading review results…</div></div>
      <div class="mra-bi-copied" id="mraCopied">Copied!</div>
      <div class="mra-kbd-hint" id="mraKbdHint"><kbd>→</kbd> Next <kbd>←</kbd> Prev <kbd>Ctrl+Z</kbd> Undo <kbd>Ctrl+Y</kbd> Redo <kbd>]</kbd><kbd>[</kbd> Pages <kbd>Esc</kbd> Back</div>
    `;
    host.appendChild(w);
  }

  // ==================== PDF.js ====================
  async function ensurePdfJs(){if(pdfJsLoaded)return true;if(pdfJsLoading){for(let i=0;i<50;i++){await sleep(200);if(pdfJsLoaded)return true}return false}pdfJsLoading=true;try{await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)});const lib=window['pdfjs-dist/build/pdf']||window.pdfjsLib;lib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';pdfJsLoaded=true;return true}catch(e){pdfJsLoading=false;return false}}
  async function loadPdfDoc(url){if(!await ensurePdfJs())return false;const lib=window['pdfjs-dist/build/pdf']||window.pdfjsLib;try{pdfDoc=await lib.getDocument(url).promise;pdfPageCount=pdfDoc.numPages;pdfCurrentStart=0;return true}catch(e){pdfDoc=null;pdfPageCount=0;return false}}
  async function renderPdfPages(){if(!pdfDoc)return;const spread=document.getElementById('mraPdfSpread');if(!spread)return;commitAnnotText();spread.innerHTML='';const cont=document.createElement('div');cont.style.cssText='display:flex;gap:3px;align-items:flex-start;justify-content:center;width:100%;height:100%;padding:6px;box-sizing:border-box;position:relative;overflow:hidden';const aH=spread.clientHeight-12,aW=spread.clientWidth-12;const count=Math.min(pdfPagesPerView,pdfPageCount-pdfCurrentStart);const slotW=(aW-(count-1)*3)/count;async function rp(num){if(num<1||num>pdfPageCount)return null;const pg=await pdfDoc.getPage(num);const uv=pg.getViewport({scale:1});const sc=Math.min(aH/uv.height,slotW/uv.width,2.5);const vp=pg.getViewport({scale:sc});const c=document.createElement('canvas');c.className='page-canvas';c.width=vp.width;c.height=vp.height;c.style.width=vp.width+'px';c.style.height=vp.height+'px';await pg.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return c}const ps=[];for(let i=0;i<count;i++)ps.push(rp(pdfCurrentStart+i+1));(await Promise.all(ps)).forEach(c=>{if(c)cont.appendChild(c)});if(!cont.children.length)cont.innerHTML='<span class="no-pdf">No pages</span>';spread.appendChild(cont);const ac=document.createElement('canvas');ac.className='annot-layer';spread.appendChild(ac);requestAnimationFrame(()=>{const cr=cont.getBoundingClientRect(),sr=spread.getBoundingClientRect();ac.width=cr.width;ac.height=cr.height;ac.style.width=cr.width+'px';ac.style.height=cr.height+'px';ac.style.top=(cr.top-sr.top)+'px';ac.style.left=(cr.left-sr.left)+'px';annotCanvasW=cr.width;annotCanvasH=cr.height;annotCanvas=ac;annotCtx=ac.getContext('2d');wireAnnotCanvas();redrawAnnot()});updatePdfNav()}
  function updatePdfNav(){const lbl=document.getElementById('mraPdfPageLabel'),prev=document.getElementById('mraPdfPrev'),next=document.getElementById('mraPdfNext');if(!pdfDoc||!pdfPageCount){if(lbl)lbl.textContent='No PDF';if(prev)prev.disabled=true;if(next)next.disabled=true;return}const p1=pdfCurrentStart+1,p2=Math.min(pdfCurrentStart+pdfPagesPerView,pdfPageCount);if(lbl)lbl.textContent=p1===p2?`Page ${p1}/${pdfPageCount}`:`${p1}–${p2} / ${pdfPageCount}`;if(prev)prev.disabled=pdfCurrentStart<=0;if(next)next.disabled=pdfCurrentStart>=pdfPageCount-pdfPagesPerView;[1,2,3].forEach(n=>{const b=document.getElementById('mraV'+n);if(b)b.classList.toggle('active',pdfPagesPerView===n)})}
  function clearPdfView(){document.getElementById('mraPdfSpread').innerHTML='<span class="no-pdf">Select a project</span>';pdfDoc=null;pdfPageCount=0;pdfCurrentStart=0;annotCanvas=null;annotCtx=null;annotData={};annotDirty=false;updatePdfNav()}

  // ==================== ANNOTATIONS ====================
  function wireAnnotCanvas(){if(!annotCanvas)return;const c=annotCanvas;c.style.pointerEvents='auto';
    c.onpointerdown=e=>{commitAnnotText();annotDrawing=true;const r=c.getBoundingClientRect();const x=(e.clientX-r.left)/annotCanvasW,y=(e.clientY-r.top)/annotCanvasH;pushUndo();annotCurrentStroke={type:'stroke',points:[[x,y]],color:annotColor,width:annotWidth};c.setPointerCapture(e.pointerId)};
    c.onpointermove=e=>{if(!annotDrawing||!annotCurrentStroke)return;const r=c.getBoundingClientRect();annotCurrentStroke.points.push([(e.clientX-r.left)/annotCanvasW,(e.clientY-r.top)/annotCanvasH]);redrawAnnot();drawStroke(annotCtx,annotCurrentStroke,annotCanvasW,annotCanvasH)};
    c.onpointerup=c.onpointercancel=()=>{if(!annotDrawing)return;annotDrawing=false;if(annotCurrentStroke&&annotCurrentStroke.points.length>1){getPage().strokes.push(annotCurrentStroke)}annotCurrentStroke=null;redrawAnnot();scheduleSave()};
    c.ondblclick=e=>{e.preventDefault();commitAnnotText();const r=c.getBoundingClientRect();annotTextX=(e.clientX-r.left)/annotCanvasW;annotTextY=(e.clientY-r.top)/annotCanvasH;const inp=document.createElement('input');inp.type='text';inp.className='annot-text-input';inp.style.left=(e.clientX-r.left)+'px';inp.style.top=(e.clientY-r.top-8)+'px';inp.style.color=annotColor;inp.style.outlineColor=annotColor;annotTextEl=inp;document.getElementById('mraPdfSpread').appendChild(inp);inp.focus();inp.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();commitAnnotText()}else if(ev.key==='Escape'){inp.remove();annotTextEl=null}};inp.onblur=()=>{setTimeout(()=>{if(annotTextEl===inp)commitAnnotText()},100)}}}
  function commitAnnotText(){if(!annotTextEl)return;const txt=annotTextEl.value.trim();if(txt){pushUndo();getPage().strokes.push({type:'text',x:annotTextX,y:annotTextY,text:txt,color:annotColor,size:14});scheduleSave()}annotTextEl.remove();annotTextEl=null;redrawAnnot()}
  function drawStroke(ctx,s,w,h){if(!s||!s.points||s.points.length<2)return;ctx.save();ctx.strokeStyle=s.color||'#ef4444';ctx.lineWidth=s.width||3;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(s.points[0][0]*w,s.points[0][1]*h);for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i][0]*w,s.points[i][1]*h);ctx.stroke();ctx.restore()}
  function drawTextItem(ctx,it,w,h){const x=it.x*w,y=it.y*h;ctx.save();ctx.font=`bold ${it.size||14}px -apple-system,system-ui,sans-serif`;if(annotTextBg){const m=ctx.measureText(it.text);const pad=3;ctx.fillStyle='rgba(255,255,255,.85)';ctx.fillRect(x-pad,y-(it.size||14)+2,m.width+pad*2,(it.size||14)+pad*2);} ctx.fillStyle=it.color||'#ef4444';ctx.fillText(it.text,x,y);ctx.restore()}
  function redrawAnnot(){if(!annotCtx)return;annotCtx.clearRect(0,0,annotCanvas.width,annotCanvas.height);const items=getPage().strokes;for(const it of items){if(it.type==='stroke')drawStroke(annotCtx,it,annotCanvasW,annotCanvasH);else if(it.type==='text')drawTextItem(annotCtx,it,annotCanvasW,annotCanvasH)}}
  function setAnnotColor(c){annotColor=c;document.querySelectorAll('#mraPdfToolbar .cb').forEach(b=>{const bg=b.style.background||b.style.backgroundColor;b.classList.toggle('active',bg===c)})}
  function getAnnotSnapshot(){const has=Object.values(annotData).some(pg=>pg.strokes&&pg.strokes.length>0);return has?JSON.parse(JSON.stringify(annotData)):null}
  function loadAnnotFromManifest(d){annotData={};if(!d||typeof d!=='object')return;for(const[k,v]of Object.entries(d)){if(v&&typeof v==='object')annotData[k]={strokes:v.strokes||[],undoStack:v.undoStack||[],redoStack:v.redoStack||[]}}redrawAnnot()}

  // ==================== QUAD MAP ====================
  function initQuadMaps(){if(!mapsOk())return;for(const[key,heading]of Object.entries(QH)){if(quadMaps[key])continue;const el=document.getElementById('mraMap'+key.toUpperCase());if(!el)continue;const map=new google.maps.Map(el,{center:{lat:39.8,lng:-98.5},zoom:21,mapTypeId:'satellite',mapTypeControl:false,streetViewControl:false,fullscreenControl:false,zoomControl:false,rotateControl:false,tilt:45,heading,gestureHandling:'cooperative'});map._h=heading;quadMaps[key]=map;quadMarkers[key]=new google.maps.Marker({map})}}
  function setQuadLoc(loc){if(!loc)return;quadLastLoc=loc;for(const[key,heading]of Object.entries(QH)){const map=quadMaps[key];if(!map)continue;map.setCenter(loc);map.setZoom(21);map.setTilt(45);map.setHeading(heading);map._h=heading;if(quadMarkers[key])quadMarkers[key].setPosition(loc)}setTimeout(resizeQuad,300)}
  function resizeQuad(){if(!mapsOk())return;for(const key of Object.keys(QH)){const map=quadMaps[key];if(!map)continue;google.maps.event.trigger(map,'resize');if(quadLastLoc)map.setCenter(quadLastLoc);map.setTilt(45);map.setHeading(map._h);map.setZoom(21)}}

  // ==================== DATA ====================
  function firstNonBlank(){for(const v of arguments){if(v===null||typeof v==='undefined')continue;const s=String(v).trim();if(s)return s}return''}
  function asObj(v){return(v&&typeof v==='object')?v:{}}
  function whOf(m){const w=asObj(m.workflow);return Array.isArray(m.work_history)?m.work_history:(Array.isArray(w.history)?w.history:[])}
  function qaActorFromManifest(m){m=asObj(m);const direct=firstNonBlank(m.qa_reviewer_email,m.qa_reviewed_by_email,m.qa_reviewed_by,m.qa_approved_by_email,m.qa_approved_by,m.qa_claimed_by_email).toLowerCase();if(direct)return{email:direct,name:firstNonBlank(m.qa_reviewer_name,m.qa_reviewed_by_name,m.qa_approved_by_name,m.qa_claimed_by_name,direct)};const wh=whOf(m);for(let i=wh.length-1;i>=0;i--){const ev=wh[i]||{},t=String(ev.event||ev.type||'').toLowerCase();if(t==='qa_approved'||t==='qa_approved_pending_manager'||t==='qa_reviewed'||t==='qa_claimed'){const e=firstNonBlank(ev.qa_email,ev.qa_reviewer_email,ev.by_email,ev.user_email).toLowerCase();if(e)return{email:e,name:firstNonBlank(ev.qa_name,ev.qa_reviewer_name,ev.by_name,ev.user_name,e)}}if(t==='rejected_no_coverage'||t==='rejection_reviewed'){const e=firstNonBlank(ev.by_email,ev.reviewer_email).toLowerCase();if(e)return{email:e,name:firstNonBlank(ev.by_name,ev.reviewer_name,e)}}}return{email:'',name:''}}
  function normalizeReviewProject(m){
    m=asObj(m);const workflow=asObj(m.workflow),audit=asObj(m.audit),assigned=asObj(workflow.assigned_to),qa=qaActorFromManifest(m);
    const id=firstNonBlank(m.id,m.folder,m.project_id);
    return {...m,id,address:firstNonBlank(m.address,m.formatted_address,id),status:firstNonBlank(m.status,'completed'),created_at:firstNonBlank(m.created_at,asObj(m.timestamps).created_at,m.date),completed_at:firstNonBlank(m.completed_at,asObj(m.timestamps).completed_at,m.updated_at,m.date),assigned_to_email:firstNonBlank(m.assigned_to_email,assigned.email,m.drafter_email,m.technician_email),is_filler:!!m.is_filler,is_vip:!!m.is_vip,is_expedited:!!m.is_expedited,project_type:firstNonBlank(m.project_type,m.type,'residential'),complexity:firstNonBlank(m.complexity,'complex'),manager_audit_status:m.manager_audit_status??audit.manager_audit_status??null,manager_audit_note:m.manager_audit_note??audit.manager_audit_note??null,manager_audit_annotations:m.manager_audit_annotations??audit.manager_audit_annotations??null,qa_reviewer_email:firstNonBlank(m.qa_reviewer_email,m.qa_reviewed_by_email,m.qa_reviewed_by,m.qa_approved_by_email,m.qa_approved_by,qa.email),qa_reviewer_name:firstNonBlank(m.qa_reviewer_name,m.qa_reviewed_by_name,m.qa_approved_by_name,qa.name),work_history:whOf(m)}
  }
  async function fetchManagerReviewDataFallback(){
    const data=await withTimeout(Portal.fmPost('projects/query',{statuses:['completed','rejected','rejected_no_coverage'],include_all:true,limit:500}),30000,'Manager review load timed out');
    const projects=(Array.isArray(data?.projects)?data.projects:[]).map(normalizeReviewProject).filter(p=>p.id);
    projects.sort((a,b)=>(parseSD(b.completed_at||b.created_at)?.getTime()||0)-(parseSD(a.completed_at||a.created_at)?.getTime()||0));
    return{success:true,projects,count:projects.length,source:'projects_query_fallback'};
  }
  async function markAuditFallback(projectId,auditStatus,note){
    const now=new Date().toISOString();
    const actor=fmActor();
    const storedNote=auditStatus==='flagged'&&String(note||'').trim()?String(note||'').trim():null;
    const patch={manager_audit_status:auditStatus,manager_audit_note:storedNote,manager_audit_updated_at:now,manager_audit_updated_by_email:actor.email||null,manager_audit_updated_by_name:actor.name||null,timestamps:{updated_at:now}};
    if(auditStatus==='reviewed'){patch.manager_audit_reviewed_at=now;patch.manager_audit_reviewed_by_email=actor.email||null;patch.manager_audit_reviewed_by_name=actor.name||null}else{patch.manager_audit_flagged_at=now;patch.manager_audit_flagged_by_email=actor.email||null;patch.manager_audit_flagged_by_name=actor.name||null}
    const res=await fmPatchProject(projectId,patch,15000);
    if(!res||res.success===false||res.ok===false)throw new Error(res?.error||res?.message||'Failed to save manager audit');
    return{success:true,folder:projectId,manager_audit_status:auditStatus,manager_audit_note:storedNote,project:res.project||res.manifest||res};
  }
  async function markAudit(projectId,auditStatus,note,details,ms){
    if(typeof details==='number'){ms=details;details={}}
    const payload={action:'manager_audit_mark',folder:projectId,audit_status:auditStatus,note:note||'',annotations:getAnnotSnapshot()||{},...(details||{})};
    const r=await apiPost(payload,ms||15000);if(r?.success)return r;
    throw new Error(r?.error||r?.message||'Failed to save manager audit');
  }
  function findQaTech(p){const directEmail=firstNonBlank(p?.qa_reviewer_email,p?.qa_reviewed_by_email,p?.qa_reviewed_by,p?.qa_approved_by_email,p?.qa_approved_by,p?.qa_claimed_by_email).toLowerCase();if(directEmail)return{email:directEmail,name:firstNonBlank(p?.qa_reviewer_name,p?.qa_reviewed_by_name,p?.qa_approved_by_name,p?.qa_claimed_by_name,directEmail)};const wh=p.work_history||[];for(let i=wh.length-1;i>=0;i--){const ev=wh[i];if(!ev)continue;const t=ev.event||'';if(t==='qa_approved'||t==='qa_approved_pending_manager'||t==='qa_reviewed'||t==='qa_claimed'){const e=firstNonBlank(ev.qa_email,ev.qa_reviewer_email,ev.by_email,ev.user_email).toLowerCase();if(e)return{email:e,name:firstNonBlank(ev.qa_name,ev.qa_reviewer_name,ev.by_name,ev.user_name,e)}}if(t==='rejected_no_coverage'||t==='rejection_reviewed'){const e=firstNonBlank(ev.by_email,ev.reviewer_email).toLowerCase();if(e)return{email:e,name:firstNonBlank(ev.by_name,ev.reviewer_name,e)}}}return{email:'',name:''}}
  function periodCutoff(){const now=Date.now();switch(currentPeriod){case'today':return new Date(new Date().toDateString()).getTime();case'week':return now-7*864e5;case'month':return now-30*864e5;default:return 0}}
  function filteredByPeriod(){return allProjects}
  function deriveTechs(){const projects=allProjects;techList=[{email:'blind-review-queue',name:'Blind Review Queue',projects,total:projects.length,unreviewed:projects.filter(p=>!p.manager_audit_status).length,flagged:projects.filter(p=>p.manager_audit_status==='flagged').length,reviewed:projects.filter(p=>p.manager_audit_status==='reviewed').length}]}
  async function loadAllData(){const mySeq=++loadSeq;const body=document.getElementById('mraTechBody');if(body)body.innerHTML='<div class="mra-empty-state"><div class="icon"><i class="fas fa-spinner fa-spin"></i></div><div class="title">Loading…</div></div>';try{const res=await apiPost({action:'manager_review_data',sample_date:localDate()},30000);if(mySeq!==loadSeq||!inView)return;if(!res?.success)throw new Error(res?.message||res?.error||'Failed to load blind review queue');allProjects=Array.isArray(res.projects)?res.projects:[];dailySample=Object.assign({},dailySample,res.sample||{});deriveTechs();renderTechList()}catch(e){if(mySeq!==loadSeq)return;if(body)body.innerHTML='<div class="mra-empty-state"><div class="icon"><i class="fas fa-exclamation-circle"></i></div><div class="title">Error</div><div class="sub">'+esc(e.message||'')+'</div></div>'}}

  // ==================== SLIDES ====================
  function showSlide(name){currentSlide=name;const wrap=document.getElementById('mraWrap');if(!wrap)return;wrap.classList.toggle('inspector-mode',name==='inspector');wrap.classList.toggle('list-mode',name!=='inspector');const s1=document.getElementById('mraSlideTechs'),s2=document.getElementById('mraSlideProjects');if(s1)s1.className='mra-slide'+(name==='techs'?'':' hidden');if(s2)s2.className='mra-slide'+(name==='projects'?'':' off-right');document.getElementById('mraKbdHint')?.classList.toggle('show',name==='inspector');if(name==='inspector')setTimeout(resizeQuad,300)}

  // ==================== RENDER: TECHS ====================
  function renderPeriodBar(){const bar=document.getElementById('mraPeriodBar');if(bar){bar.innerHTML='';bar.style.display='none'}}
  function openNextSample(){const idx=displayProjects.findIndex(p=>!p.manager_audit_status);if(idx>=0)openInspector(idx)}
  function renderTechList(){const body=document.getElementById('mraTechBody');const projects=techList[0]?.projects||[];techProjects=projects;rebuildDisplay();const done=projects.filter(p=>!!p.manager_audit_status).length,left=projects.length-done,total=projects.length,pct=total?Math.round(100*done/total):0,backlog=Number(dailySample.backlog_remaining||0),sampleDays=Number(dailySample.sample_days||1);dailySample.completed=done;dailySample.remaining=left;document.getElementById('mraTotalTechs').textContent=total;document.getElementById('mraTotalUnreviewed').textContent=left;document.getElementById('mraTotalFlagged').textContent=done;if(!body)return;if(!projects.length){body.innerHTML='<div class="mra-empty-state"><div class="icon"><i class="fas fa-clipboard-check"></i></div><div class="title">No samples available today</div><div class="sub">The queue will fill as eligible completed projects become available.</div></div>';return}const goal=Number(dailySample.configured_target||total),todaySelected=Number(dailySample.today_selected??total),complete=left===0,heading=complete?'Outstanding review is complete':backlog>0?'Continue Outstanding Blind Review':done>0?'Continue Blind Review':'Start Blind Review',note=backlog>0?`${backlog} carried over · ${sampleDays} sample days in this queue`:`Daily goal: ${goal} · ${todaySelected<goal?`${todaySelected} eligible samples available today`:`Today’s sample is ready`}`;body.innerHTML=`<div class="mra-queue-home"><div class="queue-icon"><i class="fas ${complete?'fa-check':'fa-clipboard-check'}"></i></div><h2>${heading}</h2><div class="queue-sub">Projects are randomly sampled across QAs and presented one at a time.</div><div class="mra-progress-track"><div class="mra-progress-fill" style="width:${pct}%"></div></div><div class="mra-progress-copy"><span>${done} reviewed today</span><span>${left} left of ${total}</span></div><button class="mra-btn success mra-next-sample" id="mraNextSample" ${complete?'disabled':''}><i class="fas ${complete?'fa-check':'fa-arrow-right'}"></i> ${complete?'All outstanding reviews complete':'Review Next Sample'}</button><div class="mra-queue-note">${note}</div></div>`;document.getElementById('mraNextSample')?.addEventListener('click',openNextSample)}

  // ==================== RESULTS (IDENTITY-GATED) ====================
  function resultsPayload(){const root=document.getElementById('mraResults');const get=id=>root?.querySelector(id)?.value||'';return{team_id:get('#mraRFTeam'),qa_email:get('#mraRFQa'),audit_status:get('#mraRFStatus'),page:resultsPage,page_size:25}}
  function resultsGroupTable(title,groups,identity){return`<div class="mra-results-panel"><h3>${esc(title)}</h3>${groups?.length?`<table class="mra-results-table"><thead><tr><th>${identity?'Person':'Group'}</th><th>Samples</th><th>Reviewed</th><th>Open</th><th>Issues</th><th>Skipped</th><th>Quality</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.label)}</td><td>${g.total}</td><td>${g.reviewed}</td><td>${g.unreviewed}</td><td>${g.issues}</td><td>${g.excluded||0}</td><td class="score">${g.pass_rate===null?'—':Number(g.pass_rate).toFixed(1)+'%'}</td></tr>`).join('')}</tbody></table>`:'<div class="mra-results-empty">No matching samples.</div>'}</div>`}
  async function loadResults(force){if(!canViewResults())return;if(resultsLoaded&&!force){renderResultsShell();return}const payload=resultsPayload(),root=document.getElementById('mraResults');resultsFilterState=payload;if(root)root.innerHTML='<div class="mra-results-empty"><i class="fas fa-spinner fa-spin"></i> Loading aggregate review results…</div>';try{const res=await apiPost({action:'manager_review_results',...payload},30000);if(!res?.success)throw new Error(res?.message||res?.error||'Failed to load results');resultsData=res;resultsFilterState=Object.assign({},payload,res.filters||{});resultsLoaded=true;renderResultsShell()}catch(e){if(root)root.innerHTML=`<div class="mra-results-empty"><i class="fas fa-exclamation-circle"></i><br>${esc(e.message||'Unable to load review results.')}</div>`}}
  function renderResultsShell(){const root=document.getElementById('mraResults');if(!root||!resultsData)return;const state=resultsFilterState||{},opts=resultsData.options||{},all=!!resultsData.access?.can_view_all,optionList=(list,selected)=>((list||[]).map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(selected)?'selected':''}>${esc(o.label)}</option>`).join(''));const target=Number(resultsData.settings?.daily_target||100);root.innerHTML=`${all?`<div class="mra-results-settings"><label>Daily blind sample target<input type="number" min="1" max="1000" id="mraDailyTarget" value="${target}"></label><button class="mra-btn secondary" id="mraSaveTarget"><i class="fas fa-save"></i> Save target</button><div class="hint">The score always covers the latest 14 calendar days. Excluded reviews remain visible but do not count.</div></div>`:'<div class="mra-blind-banner"><i class="fas fa-lock"></i> Your view is limited to your own QA results.</div>'}<div class="mra-results-filters" style="grid-template-columns:repeat(3,minmax(160px,1fr))">${all?`<label>Team<select id="mraRFTeam"><option value="">All teams</option>${optionList(opts.team,state.team_id)}</select></label><label>QA<select id="mraRFQa"><option value="">All QAs</option>${optionList(opts.qa,state.qa_email)}</select></label>`:''}<label>Result<select id="mraRFStatus"><option value="">All results</option><option value="reviewed" ${state.audit_status==='reviewed'?'selected':''}>Passed</option><option value="flagged" ${state.audit_status==='flagged'?'selected':''}>Issues found</option></select></label></div><div id="mraResultsBody"></div>`;root.querySelectorAll('.mra-results-filters select').forEach(el=>el.addEventListener('change',()=>{resultsPage=1;loadResults(true)}));document.getElementById('mraSaveTarget')?.addEventListener('click',saveDailyTarget);renderResultsBody()}
  async function saveDailyTarget(){const input=document.getElementById('mraDailyTarget'),button=document.getElementById('mraSaveTarget'),value=Number(input?.value);if(!Number.isInteger(value)||value<1||value>1000){alert('Daily target must be a whole number from 1 to 1000.');return}button.disabled=true;try{const res=await apiPost({action:'manager_review_settings_save',daily_target:value},15000);if(!res?.success)throw new Error(res?.message||res?.error||'Could not save target');resultsData.settings=res.settings;dailySample.configured_target=value;button.innerHTML='<i class="fas fa-check"></i> Saved';resultsLoaded=false;await loadAllData()}catch(e){alert(e.message||'Could not save target')}finally{button.disabled=false;setTimeout(()=>{if(button)button.innerHTML='<i class="fas fa-save"></i> Save target'},1200)}}
  function categoryLabel(key){return ISSUE_CATEGORIES.find(c=>c[0]===key)?.[1]||String(key||'').replaceAll('_',' ')}
  function renderResultsBody(){const body=document.getElementById('mraResultsBody');if(!body||!resultsData)return;const s=resultsData.summary||{},g=resultsData.groups||{},rows=resultsData.results||[],pg=resultsData.pagination||{},cards=[['14-day quality',s.pass_rate===null||s.pass_rate===undefined?'—':Number(s.pass_rate).toFixed(1)+'%'],['Reviewed',s.reviewed||0],['Passed',(s.reviewed||0)-(s.issues||0)-(s.excluded||0)],['Issues',s.issues||0],['Skipped',s.excluded||0],['Open',s.unreviewed||0]];const list=rows.length?`<table class="mra-results-table"><thead><tr><th>Address / notes</th><th>QA</th><th>Team</th><th>Date</th><th>Result</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr class="mra-result-row ${r.score_excluded?'excluded':''}"><td><div class="mra-result-address">${esc(r.address||r.project_id||'Unknown address')}</div>${r.note?`<div class="mra-result-note">${esc(r.note)}</div>`:''}${Array.isArray(r.attachments)&&r.attachments.length?`<div class="mra-result-images">${r.attachments.map(a=>`<a href="${esc(fmArtifactUrl(r.project_id,a.name))}" target="_blank" rel="noopener" title="${esc(a.original_name||a.name||'Review screenshot')}"><img src="${esc(fmArtifactUrl(r.project_id,a.name))}" alt="Review screenshot"></a>`).join('')}</div>`:''}<div class="mra-result-tags">${r.audit_status==='flagged'?(r.issue_categories||[]).map(c=>`<span class="mra-result-tag">${esc(categoryLabel(c))}</span>`).join(''):r.audit_status==='reviewed'?'<span class="mra-result-tag pass">Passed</span>':'<span class="mra-result-tag excluded">Open</span>'}${r.score_excluded?'<span class="mra-result-tag excluded">Skipped from quality score</span>':''}</div></td><td>${esc(r.qa_name||r.qa_email||'Unknown')}</td><td>${esc(r.team_name||r.team_id||'—')}</td><td>${esc(fmtShort(r.reviewed_at||r.sample_date||''))}</td><td>${r.score_excluded?'Skipped':r.audit_status==='flagged'?'Issue':r.audit_status==='reviewed'?'Pass':'Open'}</td><td>${resultsData.access?.can_override&&r.audit_status?`<button class="mra-btn sm ghost mra-override" data-id="${esc(r.project_id)}" data-excluded="${r.score_excluded?'1':'0'}">${r.score_excluded?'Restore':'Skip'}</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="mra-results-empty">No matching review results in the last 14 days.</div>';body.innerHTML=`<div class="mra-results-cards">${cards.map(c=>`<div class="mra-results-card"><div class="v">${esc(String(c[1]))}</div><div class="l">${esc(c[0])}</div></div>`).join('')}</div>${resultsData.access?.can_view_all?`<div class="mra-results-grid">${resultsGroupTable('Quality by team',g.team,false)}${resultsGroupTable('Quality by QA',g.qa,true)}</div>`:''}<div class="mra-results-panel mra-result-list"><h3>Recent addresses · newest first</h3>${list}<div class="mra-pagination"><button class="mra-btn sm ghost" id="mraPrevPage" ${pg.page<=1?'disabled':''}>Previous</button><span>Page ${pg.page||1} of ${pg.total_pages||1} · ${pg.total_count||0} results</span><button class="mra-btn sm ghost" id="mraNextPage" ${pg.page>=pg.total_pages?'disabled':''}>Next</button></div></div>`;document.getElementById('mraPrevPage')?.addEventListener('click',()=>{resultsPage=Math.max(1,(pg.page||1)-1);loadResults(true)});document.getElementById('mraNextPage')?.addEventListener('click',()=>{resultsPage=(pg.page||1)+1;loadResults(true)});body.querySelectorAll('.mra-override').forEach(btn=>btn.addEventListener('click',()=>toggleResultOverride(btn)))}
  async function toggleResultOverride(button){const excluded=button.dataset.excluded==='1',verb=excluded?'restore this review to':'skip this review from';if(!confirm(`Are you sure you want to ${verb} the rolling quality score?`))return;button.disabled=true;try{const res=await apiPost({action:'manager_review_override',folder:button.dataset.id,excluded:!excluded},15000);if(!res?.success)throw new Error(res?.error||'Could not update review');await loadResults(true)}catch(e){alert(e.message||'Could not update review');button.disabled=false}}
  function switchWorkspace(name){activeWorkspace=name==='results'&&canViewResults()?'results':'review';const wrap=document.getElementById('mraWrap'),results=document.getElementById('mraResults');if(wrap)wrap.style.display=activeWorkspace==='review'?'flex':'none';results?.classList.toggle('active',activeWorkspace==='results');document.getElementById('mraReviewTab')?.classList.toggle('active',activeWorkspace==='review');document.getElementById('mraResultsTab')?.classList.toggle('active',activeWorkspace==='results');document.getElementById('mraKbdHint')?.classList.remove('show');if(activeWorkspace==='results')loadResults(false);else{showSlide('techs');deriveTechs();renderTechList()}}

  // ==================== RENDER: PROJECTS ====================
  function drillIntoTech(tech){currentTechEmail=tech.email;currentTechName=tech.name;techProjects=tech.projects||[];projectFilter='all';document.getElementById('mraProjTechName').textContent=tech.name;showSlide('projects');rebuildDisplay();renderProjectList()}
  function rebuildDisplay(){let list=techProjects;if(!showFillers)list=list.filter(p=>!p.is_filler);if(projectFilter==='unreviewed')list=list.filter(p=>!p.manager_audit_status);else if(projectFilter==='flagged')list=list.filter(p=>p.manager_audit_status==='flagged');else if(projectFilter==='reviewed')list=list.filter(p=>p.manager_audit_status==='reviewed');displayProjects=[...list]}
  function renderProjToolbar(){const bar=document.getElementById('mraProjToolbar');if(!bar)return;bar.innerHTML=[{id:'all',label:'All'},{id:'unreviewed',label:'Unreviewed'},{id:'flagged',label:'Flagged'},{id:'reviewed',label:'Reviewed'}].map(f=>`<button class="mra-filter-btn ${f.id===projectFilter?'active':''}" data-f="${f.id}">${f.label}</button>`).join('')+`<div style="flex:1"></div><div class="mra-toggle-wrap" id="mraPFT"><div class="mra-toggle-switch ${showFillers?'on':''}"></div><span>Fillers</span></div>`;bar.querySelectorAll('.mra-filter-btn').forEach(b=>{b.onclick=()=>{projectFilter=b.dataset.f;rebuildDisplay();renderProjectList()}});document.getElementById('mraPFT').onclick=()=>{showFillers=!showFillers;try{localStorage.setItem('mra_show_fillers',String(showFillers))}catch(e){}rebuildDisplay();renderProjectList()}}
  function renderProjectList(){renderProjToolbar();document.getElementById('mraProjHead').innerHTML='<th>Address</th><th>Outcome</th><th>Date</th><th>Drafter</th><th>Audit</th><th style="text-align:right"></th>';const tbody=document.getElementById('mraProjTbody');if(!displayProjects.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:20px;color:#999">No projects match.</td></tr>'}else{tbody.innerHTML='';displayProjects.forEach((p,idx)=>{const tr=document.createElement('tr');tr.style.cursor='pointer';if(p.manager_audit_status==='reviewed')tr.className='reviewed-row';if(p.manager_audit_status==='flagged')tr.className='flagged-row';const sB=p.status==='completed'?'<span class="mra-status-badge completed">✓</span>':'<span class="mra-status-badge rejected">✗</span>';let aB;if(p.manager_audit_status==='reviewed')aB='<span class="mra-audit-badge reviewed"><i class="fas fa-check-circle"></i></span>';else if(p.manager_audit_status==='flagged')aB='<span class="mra-audit-badge flagged"><i class="fas fa-flag"></i></span>';else aB='<span class="mra-audit-badge unreviewed"><i class="fas fa-circle"></i></span>';const pills=(p.is_filler?'<span class="mra-pill filler">F</span>':'')+(p.is_vip?'<span class="mra-pill vip">⭐</span>':'');tr.innerHTML=`<td style="max-width:200px"><strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.address||p.id||'')}</strong>${pills}</td><td>${sB}</td><td style="white-space:nowrap;color:#888;font-size:12px">${esc(fmtShort(p.completed_at||p.created_at||''))}</td><td style="white-space:nowrap;font-size:12px">${esc(p.assigned_to_email||'—')}</td><td>${aB}</td><td style="text-align:right"><button class="mra-btn sm ghost"><i class="fas fa-arrow-right"></i></button></td>`;tr.onclick=()=>openInspector(idx);tbody.appendChild(tr)})}const ur=displayProjects.filter(p=>!p.manager_audit_status).length;document.getElementById('mraBulkInfo').textContent=`${ur} unreviewed / ${displayProjects.length}`;const bb=document.getElementById('mraBulkReviewBtn');bb.disabled=ur===0;bb.onclick=()=>bulkMark();const sub=document.getElementById('mraProjTechSub');if(sub){const fl=techProjects.filter(p=>p.manager_audit_status==='flagged').length;const unr=techProjects.filter(p=>!p.manager_audit_status).length;sub.textContent=`${techProjects.length} · ${unr} unreviewed${fl?' · '+fl+' flagged':''}`}}
  async function bulkMark(){const unrev=displayProjects.filter(p=>!p.manager_audit_status);if(!unrev.length||!confirm(`Mark ${unrev.length} as reviewed?`))return;const btn=document.getElementById('mraBulkReviewBtn');if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i>'}const q=[...unrev];let failed=0;while(q.length){const batch=q.splice(0,10);await Promise.all(batch.map(async p=>{try{const r=await markAudit(p.id,'reviewed','',15000);if(r?.success){p.manager_audit_status='reviewed';p.manager_audit_note=null}else failed++}catch(e){failed++}}))}rederiveTech();rebuildDisplay();renderProjectList();if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-check-double"></i> Mark All Reviewed'}if(failed)alert(`Could not save ${failed} project${failed===1?'':'s'}. Refresh and try again.`)}
  function rederiveTech(){const tech=techList.find(t=>t.email===currentTechEmail);if(!tech)return;tech.reviewed=0;tech.flagged=0;tech.unreviewed=0;for(const p of tech.projects){const a=p.manager_audit_status;if(a==='reviewed')tech.reviewed++;else if(a==='flagged')tech.flagged++;else tech.unreviewed++}}

  function clearPendingReviewImages(){for(const item of pendingReviewImages){if(item.previewUrl)URL.revokeObjectURL(item.previewUrl)}pendingReviewImages=[]}
  function reviewAttachments(){return Array.isArray(currentProject?.manager_audit_attachments)?currentProject.manager_audit_attachments:[]}
  function renderReviewImagePreviews(){const host=document.getElementById('mraReviewPreviews');if(!host)return;const existing=reviewAttachments().map((item,index)=>({kind:'saved',index,name:item?.name||'',src:fmArtifactUrl(currentProject.id,item?.name||'')})).filter(item=>item.name);const pending=pendingReviewImages.map((item,index)=>({kind:'pending',index,name:item.file.name,src:item.previewUrl}));host.innerHTML=[...existing,...pending].map(item=>`<div class="mra-review-preview" title="${esc(item.name)}"><img src="${esc(item.src)}" alt="Review screenshot">${item.kind==='pending'?`<button type="button" data-remove-review-image="${item.index}" title="Remove"><i class="fas fa-times"></i></button>`:''}</div>`).join('');host.querySelectorAll('[data-remove-review-image]').forEach(btn=>btn.addEventListener('click',()=>{const index=Number(btn.dataset.removeReviewImage);const removed=pendingReviewImages.splice(index,1)[0];if(removed?.previewUrl)URL.revokeObjectURL(removed.previewUrl);renderReviewImagePreviews()}))}
  function wireReviewImageUpload(){const input=document.getElementById('mraReviewImages');if(!input)return;input.addEventListener('change',()=>{for(const file of input.files||[]){if(reviewAttachments().length+pendingReviewImages.length>=REVIEW_IMAGE_MAX_FILES){alert(`A review can include up to ${REVIEW_IMAGE_MAX_FILES} screenshots.`);break}if(!REVIEW_IMAGE_TYPES.has(String(file.type||'').toLowerCase())){alert('Screenshots must be PNG, JPEG, or WebP images.');continue}if(Number(file.size||0)>REVIEW_IMAGE_MAX_BYTES){alert(`"${file.name||'This image'}" is larger than 10 MB.`);continue}pendingReviewImages.push({file,previewUrl:URL.createObjectURL(file),uploaded:null})}input.value='';renderReviewImagePreviews()})}
  async function uploadPendingReviewImages(){const attachments=reviewAttachments().map(item=>({name:String(item?.name||''),original_name:String(item?.original_name||item?.name||'')})).filter(item=>item.name);for(const item of pendingReviewImages){if(item.uploaded){attachments.push(item.uploaded);continue}const type=String(item.file.type||'').toLowerCase();const ext=type==='image/png'?'png':type==='image/webp'?'webp':'jpg';const stem=String(item.file.name||'screenshot').replace(/\.[^.]+$/,'').replace(/[^a-z0-9._-]/gi,'_').slice(0,80)||'screenshot';const safeName=`manager-review-${Date.now()}-${Math.random().toString(36).slice(2,8)}-${stem}.${ext}`;const form=new FormData();form.append('file',item.file,safeName);const response=await fetch(Portal.fmUrl(`projects/${encodeURIComponent(currentProject.id)}/artifacts`),{method:'POST',body:form});let data={};try{data=await response.json()}catch(e){}if(!response.ok)throw new Error(data.message||data.error||`Could not upload ${item.file.name||'screenshot'}.`);const name=String(data?.artifact?.name||safeName);item.uploaded={name,original_name:String(item.file.name||safeName).slice(0,255)};attachments.push(item.uploaded)}return attachments}

  // ==================== INSPECTOR ====================
  async function openInspector(idx){
    clearPendingReviewImages();currentProjectIdx=idx;currentProject=displayProjects[idx];if(!currentProject)return;
    const mySeq=++inspectorSeq;annotData={};annotCurrentStroke=null;annotDirty=false;cachedAppMeta=null;showSaveState('idle');
    showSlide('inspector');renderInfoPanel();
    const ok=await loadPdfDoc(`${fmProjectPdfUrl(currentProject.id,'main')}&v=${Date.now()}`);
    if(mySeq!==inspectorSeq)return;
    if(ok)await renderPdfPages();else{document.getElementById('mraPdfSpread').innerHTML='<span class="no-pdf">No PDF</span>';updatePdfNav()}
    try{const mf=await fmGetEditorBundle(currentProject.id,15000);if(mySeq!==inspectorSeq)return;if(mf?.manifest){currentManifest=mf.manifest;if(!currentProject.address&&mf.manifest.address)currentProject.address=mf.manifest.address;renderInfoPanel();const loc=safeLoc(mf.manifest.lat,mf.manifest.lng);if(loc&&mapsOk()){initQuadMaps();setQuadLoc(loc)}}cachedAppMeta=mf?.app_metadata||{};const annot=cachedAppMeta.manager_review_annotations;if(annot&&typeof annot==='object'){loadAnnotFromManifest(annot);console.log('[MRA] Loaded annotations from app_metadata')}}catch(e){console.error('[MRA] Load error:',e)}
    preloadNext(idx);
  }

  function renderInfoPanel(){
    const p=currentProject;if(!p)return;const m=currentManifest||{};
    const addr=p.address||m.address||p.id||'Unknown';
    const inner=document.getElementById('mraBiInner');
    let flagHtml='';if(p.manager_audit_status==='flagged'){const note=p.manager_audit_note||m.manager_audit_note||'';flagHtml=`<div class="mra-bi-flag"><b><i class="fas fa-flag"></i> FLAGGED</b><br>${note?esc(note):'<em>No note</em>'}</div>`}
    inner.innerHTML=`
      <div class="mra-bi-addr" id="mraBiAddr" title="Click to copy">${esc(addr)}${p.is_vip?' <span class="mra-pill vip">⭐</span>':''}${p.is_expedited?' <span class="mra-pill expedited">EXP</span>':''}${p.is_filler?' <span class="mra-pill filler">F</span>':''}</div>
      <div class="mra-bi-sub">${p.status==='completed'?'✓ Approved':'✗ Rejected'} · ${fmtShort(p.completed_at||p.created_at||'')}</div>
      ${flagHtml}
      <div class="mra-bi-grid">
        <div class="bi-item"><span class="lbl">Type</span><span class="val">${esc(p.project_type||'residential')}</span></div>
        <div class="bi-item"><span class="lbl">Complexity</span><span class="val">${esc(String(p.complexity||'—'))}</span></div>
        <div class="bi-item"><span class="lbl">Sample</span><span class="val">${esc(p.id||'—')}</span></div>
        <div class="bi-item"><span class="lbl">Identity</span><span class="val"><i class="fas fa-eye-slash"></i> Hidden</span></div>
      </div>`;
    document.getElementById('mraBiAddr').onclick=()=>{navigator.clipboard.writeText(addr).then(()=>{const el=document.getElementById('mraCopied');el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1200)}).catch(()=>{})};
    // Actions
    const actions=document.getElementById('mraBiActions');
    const selected=new Set(p.manager_audit_issue_categories||[]);
    actions.innerHTML=`<div class="mra-review-help">Select every issue found. Leave all unselected to pass.</div><div class="mra-review-categories">${ISSUE_CATEGORIES.map(([key,label])=>`<button class="mra-category-btn ${selected.has(key)?'selected':''}" data-category="${key}" type="button">${esc(label)}</button>`).join('')}</div><textarea class="mra-review-note" id="mraReviewNote" placeholder="Optional review note…">${esc(p.manager_audit_note||'')}</textarea><div class="mra-review-upload"><label class="mra-review-upload-btn"><i class="fas fa-camera"></i> Upload screenshots<input type="file" id="mraReviewImages" accept="image/png,image/jpeg,image/webp" multiple hidden></label><div class="mra-review-upload-hint">Up to 5 · PNG, JPEG, or WebP · 10 MB each</div><div class="mra-review-previews" id="mraReviewPreviews"></div></div><button class="mra-btn success sm" id="mraSubmitReview"><i class="fas fa-check"></i> Submit review</button><button class="mra-btn secondary sm" id="mraBiEditor"><i class="fas fa-up-right-from-square"></i> Open in Editor</button>`;
    actions.querySelectorAll('.mra-category-btn').forEach(btn=>btn.addEventListener('click',()=>btn.classList.toggle('selected')));
    wireReviewImageUpload();renderReviewImagePreviews();
    document.getElementById('mraSubmitReview')?.addEventListener('click',()=>submitReview());
    document.getElementById('mraBiEditor')?.addEventListener('click',()=>window.open(`editor.php?folder=${encodeURIComponent(p.id)}`,'_blank','noopener'));
    // Nav
    const nav=document.getElementById('mraBiNav');
    const hP=currentProjectIdx>0,hN=currentProjectIdx<displayProjects.length-1;
    nav.innerHTML=`<button id="mraBiPrev" ${hP?'':'disabled'}><i class="fas fa-arrow-left"></i> Back</button><span class="ctr">${currentProjectIdx+1}/${displayProjects.length}</span><button id="mraBiNext" ${hN?'':'disabled'}>Next <i class="fas fa-arrow-right"></i></button>`;
    document.getElementById('mraBiPrev').onclick=()=>{if(currentProjectIdx>0)openInspector(currentProjectIdx-1);else{showSlide('techs');clearPdfView();deriveTechs();renderTechList()}};
    document.getElementById('mraBiNext').onclick=()=>{if(currentProjectIdx<displayProjects.length-1)openInspector(currentProjectIdx+1)};
  }

  // ==================== MARK / FLAG ====================
  async function submitReview(){if(!currentProject)return;commitAnnotText();const selected=[...document.querySelectorAll('#mraBiActions .mra-category-btn.selected')].map(btn=>btn.dataset.category);const note=document.getElementById('mraReviewNote')?.value.trim()||'';const status=selected.length?'flagged':'reviewed',button=document.getElementById('mraSubmitReview');button.disabled=true;button.innerHTML='<i class="fas fa-spinner fa-spin"></i> Saving';const saved=await doSaveAnnotations();if(!saved&&!confirm('Annotations did not save. Submit this review anyway?')){button.disabled=false;button.innerHTML='<i class="fas fa-check"></i> Submit review';return}try{button.innerHTML='<i class="fas fa-spinner fa-spin"></i> Uploading';const attachments=await uploadPendingReviewImages();button.innerHTML='<i class="fas fa-spinner fa-spin"></i> Saving';const res=await markAudit(currentProject.id,status,note,{issue_categories:selected,attachments},15000);if(!res?.success)throw new Error(res?.error||'Failed to save review');currentProject.manager_audit_status=status;currentProject.manager_audit_note=note||null;currentProject.manager_audit_issue_categories=selected;currentProject.manager_audit_attachments=attachments;resultsLoaded=false;rederiveTech();advanceToNext()}catch(e){alert('Error: '+(e.message||'Failed to save review'));button.disabled=false;button.innerHTML='<i class="fas fa-check"></i> Submit review'}}
  async function markReviewed(){return submitReview()}
  function showFlagModal(){if(!currentProject)return;commitAnnotText();document.querySelector('.mra-flag-overlay')?.remove();const snapshot=getAnnotSnapshot();const overlay=document.createElement('div');overlay.className='mra-flag-overlay';overlay.innerHTML=`<div class="mra-flag-modal"><div class="fh"><h3><i class="fas fa-flag" style="margin-right:8px"></i> Flag Issue</h3><div class="fx"><i class="fas fa-times"></i></div></div><div class="fb"><div style="font-size:13px;color:#555;margin-bottom:10px"><strong>${esc(currentProject.address||'')}</strong></div><div class="mra-flag-grid"><label>Quality score<input type="number" id="mraFScore" min="0" max="99" value="${esc(String(currentProject.manager_audit_quality_score??75))}"></label><label>Severity<select id="mraFSeverity"><option value="minor">Minor</option><option value="moderate" selected>Moderate</option><option value="major">Major</option><option value="critical">Critical</option></select></label><label>Issue category<select id="mraFCategory"><option value="measurements">Measurements</option><option value="geometry">Geometry</option><option value="missing_content">Missing content</option><option value="presentation">Presentation</option><option value="coverage">Coverage decision</option><option value="other">Other</option></select></label><label>Outcome<div style="margin-top:5px;padding:10px;border-radius:8px;background:#fff2f0;color:#b42318;font-weight:900">Uncaught QA issue</div></label></div><textarea placeholder="Describe the issue and the expected correction…" id="mraFN">${esc(currentProject.manager_audit_note||'')}</textarea>${snapshot?'<div style="margin-top:10px;font-size:11px;color:#888"><i class="fas fa-pen"></i> PDF annotations will be saved with this audit.</div>':''}</div><div class="ff"><button class="mra-btn ghost" id="mraFC">Cancel</button><button class="mra-btn danger" id="mraFS"><i class="fas fa-flag"></i> Save Flag</button></div></div>`;document.body.appendChild(overlay);overlay.querySelector('.fx').onclick=()=>overlay.remove();overlay.querySelector('#mraFC').onclick=()=>overlay.remove();overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};setTimeout(()=>overlay.querySelector('#mraFN')?.focus(),50);overlay.querySelector('#mraFS').onclick=async()=>{const note=overlay.querySelector('#mraFN').value.trim();const score=Number(overlay.querySelector('#mraFScore').value);const severity=overlay.querySelector('#mraFSeverity').value;const issueCategory=overlay.querySelector('#mraFCategory').value;if(!Number.isFinite(score)||score<0||score>99){alert('Enter a quality score between 0 and 99.');return}const sb=overlay.querySelector('#mraFS');sb.disabled=true;sb.innerHTML='<i class="fas fa-spinner fa-spin"></i>';
    // 1. Always save annotations via app_metadata before changing audit status.
    const saved=await doSaveAnnotations();if(!saved&&!confirm('Annotations did not save. Flag this project anyway?')){sb.disabled=false;sb.innerHTML='<i class="fas fa-flag"></i> Flag';return}
    // 2. Persist flag status via manager_audit_mark.
    try{const res=await markAudit(currentProject.id,'flagged',note,{quality_score:score,severity,issue_category:issueCategory},15000);if(res?.success){currentProject.manager_audit_status='flagged';currentProject.manager_audit_note=note;currentProject.manager_audit_quality_score=score;currentProject.manager_audit_severity=severity;currentProject.manager_audit_issue_category=issueCategory;resultsLoaded=false;rederiveTech();overlay.remove();advanceToNext();return}alert('Error: '+(res?.error||'Failed to save flag'));sb.disabled=false;sb.innerHTML='<i class="fas fa-flag"></i> Save Flag'}catch(e){alert('Error: '+(e.message||'Failed to save flag'));sb.disabled=false;sb.innerHTML='<i class="fas fa-flag"></i> Save Flag'}}}
  function advanceToNext(){for(let i=currentProjectIdx+1;i<displayProjects.length;i++){if(!displayProjects[i].manager_audit_status){openInspector(i);return}}showSlide('techs');clearPdfView();deriveTechs();renderTechList()}
  function preloadNext(idx){const ni=idx+1;if(ni>=displayProjects.length)return;const next=displayProjects[ni];if(next)try{fetch(`${fmProjectPdfUrl(next.id,'main')}&v=${Date.now()}`,{mode:'no-cors'}).catch(()=>{})}catch(e){}}

  // ==================== KEYBOARD ====================
  function handleKeyDown(e){
    if(!inView||currentSlide!=='inspector')return;if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
    if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();doUndo();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='y'){e.preventDefault();doRedo();return}
    if(e.key==='ArrowRight'||e.key==='l'){e.preventDefault();document.getElementById('mraBiNext')?.click()}
    if(e.key==='ArrowLeft'||e.key==='h'){e.preventDefault();document.getElementById('mraBiPrev')?.click()}
    if(e.key===']'){e.preventDefault();document.getElementById('mraPdfNext')?.click()}
    if(e.key==='['){e.preventDefault();document.getElementById('mraPdfPrev')?.click()}
    if(e.key==='Escape'){e.preventDefault();commitAnnotText();showSlide('techs');clearPdfView();deriveTechs();renderTechList()}
  }

  // ==================== WIRE UI ====================
  function wireUIOnce(){
    if(uiWired)return;uiWired=true;
    document.getElementById('mraRefreshBtn').onclick=()=>{if(activeWorkspace==='results'){resultsLoaded=false;loadResults(true);return}loadAllData()};
    document.getElementById('mraReviewTab').onclick=()=>switchWorkspace('review');
    document.getElementById('mraResultsTab')?.addEventListener('click',()=>switchWorkspace('results'));
    document.getElementById('mraProjBack').onclick=()=>{showSlide('techs');deriveTechs();renderTechList()};
    document.getElementById('mraPdfPrev').onclick=()=>{if(pdfCurrentStart>0){pdfCurrentStart=Math.max(0,pdfCurrentStart-pdfPagesPerView);renderPdfPages()}};
    document.getElementById('mraPdfNext').onclick=()=>{if(pdfCurrentStart<pdfPageCount-pdfPagesPerView){pdfCurrentStart=Math.min(pdfPageCount-pdfPagesPerView,pdfCurrentStart+pdfPagesPerView);renderPdfPages()}};
    [1,2,3].forEach(n=>{document.getElementById('mraV'+n).onclick=()=>{pdfPagesPerView=n;pdfCurrentStart=Math.min(pdfCurrentStart,Math.max(0,pdfPageCount-n));try{localStorage.setItem('mra_pages_per_view',String(n))}catch(e){}renderPdfPages()}});
    document.getElementById('mraClrR').onclick=()=>setAnnotColor('#ef4444');
    document.getElementById('mraClrB').onclick=()=>setAnnotColor('#3b82f6');
    document.getElementById('mraClrK').onclick=()=>setAnnotColor('#1e1e1e');
    document.getElementById('mraUndo').onclick=()=>doUndo();
    document.getElementById('mraRedo').onclick=()=>doRedo();
    document.getElementById('mraClearA').onclick=()=>{if(!confirm('Clear annotations on current pages?'))return;pushUndo();getPage().strokes=[];redrawAnnot();scheduleSave()};
    document.getElementById('mraBgToggle').onclick=()=>{annotTextBg=!annotTextBg;document.getElementById('mraBgToggle').classList.toggle('active',annotTextBg);try{localStorage.setItem('mra_text_bg',String(annotTextBg))}catch(e){}redrawAnnot()};
    window.addEventListener('keydown',handleKeyDown);
    window.addEventListener('resize',()=>resizeQuad());
  }

  // ==================== INIT ====================
  function init(){if(!canAccess())return;ensureStyles();ensureMarkup();Portal.registerPlugin({id:'manager_review',title:'QA Quality',iconClass:'fas fa-user-shield'});const origSwitch=Portal.switchView.bind(Portal);Portal.switchView=async function(id,btn){await origSwitch(id,btn);inView=(id==='manager_review');if(!inView){document.getElementById('mraKbdHint')?.classList.remove('show');return}const view=document.getElementById('view-manager_review');if(view){view.style.display='flex';view.style.flexDirection='column'}wireUIOnce();renderPeriodBar();switchWorkspace(activeWorkspace);if(canPerformReview()){if(mapsOk())initQuadMaps();ensurePdfJs();setTimeout(resizeQuad,50);await loadAllData()}}}
  init();
})();
