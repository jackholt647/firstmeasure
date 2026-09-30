/* Retained project workspaces. Each document owns its legacy app state and IDs;
 * the outer portal owns placement, docking, minimization and lifetime. */
(function(root){
  'use strict';
  if (root.FirstMateProjectWindows) return;
  const records = new Map();
  let active = null;
  function identity(project){ return String(project?.platform_project_id || project?.base_project_id || project?.id || '').trim(); }
  function host(){ return document.querySelector('main.main') || document.querySelector('.main'); }
  function styles(){
    if (document.getElementById('fm-project-window-host-style')) return;
    const style = document.createElement('style'); style.id = 'fm-project-window-host-style';
    style.textContent = `.fm-project-window-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483100}.fm-project-window-layer[data-mode=modal],.fm-project-window-layer[data-mode=fullscreen]{background:rgba(11,16,24,.78);pointer-events:auto}.fm-project-frame{position:fixed;left:2vw;top:4vh;width:96vw;height:92vh;pointer-events:auto;overflow:hidden!important;border-radius:14px;background:#fff}.fm-project-frame iframe{display:block;width:100%;height:100%;border:0}.fm-project-window-loading{position:absolute;inset:4%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;border-radius:14px;pointer-events:auto;color:#475467;font-weight:800;font-size:13px;font-family:inherit}.fm-project-window-loading:before{content:"";width:16px;height:16px;border:2px solid #d0d5dd;border-top-color:var(--primary,#d93025);border-radius:50%;animation:fm-project-window-spin .8s linear infinite}.fm-project-window-loading.failed:before{display:none}@keyframes fm-project-window-spin{to{transform:rotate(360deg)}}.fm-project-window-loading button{position:absolute;top:10px;right:10px;height:32px;padding:0 12px;border:1px solid rgba(15,23,42,.14);border-radius:9px;background:#fff;color:#344054;font-weight:900;font-size:12px;font-family:inherit;display:inline-flex;align-items:center;gap:6px;cursor:pointer}.fm-project-window-loading button:hover{background:#f2f4f7;color:#101828}.fm-project-window-loading button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}.fm-project-frame[hidden]{display:none!important}`;
    document.head.append(style);
    style.textContent += `.fm-project-minimized-bar{position:absolute;inset:0;display:flex;align-items:center;gap:3px;padding:0 4px;background:#fff;font:12px Arial,sans-serif}.fm-project-minimized-bar[hidden]{display:none}.fm-project-minimized-bar button{height:28px;border:0;background:none;color:#344054;cursor:pointer}.fm-project-minimized-bar .fm-project-minimized-title{display:flex;align-items:center;gap:6px;min-width:0;flex:1;text-align:left}.fm-project-minimized-title span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.fm-project-minimized-title i{color:var(--primary,#d93025)}.fm-project-minimized-bar button:last-child:hover{background:#d92d20;color:white}`;
  }
  // The portal paints a project-shaped skeleton (#fmProjectRoutePrecover) on a
  // direct ?project= load. Once a project window layer exists it owns the
  // screen (and its own loading state); a leftover skeleton would sit over the
  // page, blocking clicks, as soon as the window closes or stops being modal.
  function clearRoutePrecover(){ document.getElementById('fmProjectRoutePrecover')?.remove(); }
  const PROJECT_SCOPED_ROUTE_KEYS=['projectScheduleView','projectScheduleTarget','projectScheduleDate'];
  // Route keys a window's own navigation mirrors to the browser address while
  // it is the routed project (the portal already mirrors project/projectTab
  // on focus; the Schedule tab's view, target and date live in the window).
  function mirrorRouteFromWindow(record, detail = {}){
    const route = detail?.route || {};
    const changed = Array.isArray(detail?.changedKeys) ? detail.changedKeys : [];
    const keys = ['projectTab', ...PROJECT_SCOPED_ROUTE_KEYS].filter((key)=>changed.includes(key));
    // Only once the window has opened its project and applied the deep link
    // (its first renders use defaults that must not replace the address).
    if (!keys.length || !record.routeMirrorReady || active !== record || !record.projectId || String(route.project || '') !== record.projectId) return;
    const current = root.Portal?.routeState?.get?.() || {};
    if (String(current.project || '') !== record.projectId) return;
    const patch = {};
    for (const key of keys) patch[key] = String(route[key] || '').trim() || null;
    if (patch.projectTab) record.options.tab = patch.projectTab;
    try { root.Portal?.routeState?.set?.(patch, {history:'replace',source:'project-window-route'}); } catch(_) {}
  }
  function projectRouteParams(projectId, options = {}){
    const params={};
    const current=root.Portal?.routeState?.get?.() || {};
    const routed=!!projectId && String(current.project || '') === projectId;
    for(const key of PROJECT_SCOPED_ROUTE_KEYS){
      const value=String(options[key] || (routed ? current[key] || '' : '')).trim();
      if(value)params[key]=value;
    }
    return params;
  }
  function applyRouteParams(record, params = {}){
    const child=record?.frame?.contentWindow;
    const navigation=child?.Portal?.navigation;
    if(!navigation || !Object.keys(params || {}).length)return;
    try{ navigation.replace?.(params,{source:'project-window-deep-link'}); navigation.applyCurrent?.({source:'project-window-deep-link',only:'project-schedule-route'}); }catch(_){}
  }
  // Schedule changes in one surface refresh the others: a window's changes are
  // relayed to the portal as its usual refresh events, and portal refreshes
  // reach every other window as fm:project-schedule:external, which only the
  // project apps consume (so nothing is relayed back).
  function relayToWindows(exceptToken = ''){
    for(const record of records.values()){
      if(record.token === exceptToken || !record.api)continue;
      try{ const child=record.frame.contentWindow; child?.dispatchEvent(new child.CustomEvent('fm:project-schedule:external',{detail:{fromPortal:true}})); }catch(_){}
    }
  }
  for(const type of ['fm:calendar:refresh','fm:projects:refresh']){
    root.addEventListener(type,event=>relayToWindows(event.detail?.fromProjectWindow || ''));
  }
  function publishRoute(record){
    if (!record.projectId) return;
    const current = root.Portal?.routeState?.get?.() || {};
    if (current.project === record.projectId) return;
    // The focused window's own schedule view/date replace the previous
    // project's (never carried over to a different project).
    const patch={project:record.projectId, projectTab:record.options.tab || null};
    let childRoute={};
    try{ childRoute=record.frame?.contentWindow?.Portal?.navigation?.read?.() || {}; }catch(_){}
    const own=String(childRoute.project || '') === record.projectId;
    for(const key of PROJECT_SCOPED_ROUTE_KEYS) patch[key]=own ? (String(childRoute[key] || '').trim() || null) : null;
    if(own && childRoute.projectTab) patch.projectTab=childRoute.projectTab;
    root.Portal?.routeState?.set?.(patch, {history:'replace',source:'project-window-focus'});
  }
  function sync(record){
    if (!record.controller) return;
    const mode = record.controller.state.mode;
    record.layer.dataset.mode = mode;
    // Moving a live iframe between parents reloads its document. Keep its layer
    // in the workspace for its entire lifetime; fixed geometry fills the screen.
    record.layer.style.background = ['modal','fullscreen'].includes(mode) ? '' : 'transparent';
    record.modal?.unregister?.(); record.modal = null;
    if (record.controller.state.visible && ['modal','fullscreen'].includes(mode)) {
      record.modal = root.Portal?.modals?.register?.(record.layer, {id:`project-${record.token}`,closeOnEscape:true,closeOnBackdrop:false,onClose:()=>close(record.token)}) || null;
    }
  }
  function closed(token){
    const record = records.get(token); if (!record) return;
    records.delete(token); record.resolveReady?.(null); clearTimeout(record.timer); record.modal?.unregister?.();
    record.controller?.destroy(); record.layer.remove(); clearRoutePrecover();
    if (active === record) {
      active = null;
      if ((root.Portal?.routeState?.get?.() || {}).project === record.projectId) root.Portal?.routeState?.set?.({project:null,projectTab:null,projectFullscreen:null,projectScheduleView:null,projectScheduleTarget:null,projectScheduleDate:null},{history:'replace',source:'project-window-close'});
    }
    root.dispatchEvent(new CustomEvent('fm:projects:refresh', {detail:{redraw:true}}));
  }
  function close(token = active?.token){
    const record = records.get(token); if (!record) return;
    if (record.api) record.api.close({skipHistory:true});
    closed(token);
  }
  function open(project, options = {}){
    if (!host() || !root.FirstMateWindows) return null;
    styles();
    const projectId = identity(project);
    const existing = projectId && [...records.values()].find(record=>record.projectId === projectId);
    if (existing) {
      clearRoutePrecover();
      const shouldFocus = !options.fromRoute || active !== existing;
      if (shouldFocus) { existing.controller?.restore(); existing.controller?.focus(); active=existing; publishRoute(existing); }
      const routeParams=projectRouteParams(projectId,options);
      if (options.tab || options.photo) Promise.resolve(existing.api?.openProject(project,{...options,fromRoute:false})).then(()=>applyRouteParams(existing,routeParams)).catch(()=>{});
      else applyRouteParams(existing,routeParams);
      return existing;
    }
    const token = root.crypto.randomUUID();
    const layer = document.createElement('div'); layer.className='fm-project-window-layer';layer.dataset.mode='modal';layer.dataset.projectWindow=token;
    const element = document.createElement('section');element.className='fm-project-frame';element.hidden=false;
    const frame = document.createElement('iframe');frame.name='fm-project-window:'+token;frame.style.visibility='hidden';frame.setAttribute('aria-label',String(project?.title || project?.address || 'Project workspace'));frame.setAttribute('allow','clipboard-write; microphone; camera; fullscreen');
    const loading = document.createElement('div');loading.className='fm-project-window-loading';
    const status=document.createElement('span');status.textContent='Opening project…';status.setAttribute('role','status');
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.innerHTML='<i class="fas fa-xmark" aria-hidden="true"></i><span>Close</span>';dismiss.setAttribute('aria-label','Close project');dismiss.onclick=()=>close(token);loading.append(status,dismiss);
    const record={token,projectId,project,options,layer,element,frame,loading,controller:null,api:null,modal:null};
    record.ready = new Promise((resolve,reject)=>{record.resolveReady=resolve;record.rejectReady=reject;});
    record.ready.catch(()=>{});
    records.set(token,record);active=record;
    element.append(frame);layer.append(element,loading);host().append(layer);clearRoutePrecover();
    // While it loads the window is already the topmost layer: Escape closes it
    // (not an editor left open underneath). sync() re-registers it by mode.
    record.modal = root.Portal?.modals?.register?.(layer, {id:`project-${token}`,closeOnEscape:true,closeOnBackdrop:false,onClose:()=>close(token)}) || null;
    const url=new URL(root.location.href);url.search='';url.hash='';url.searchParams.set('projectWindow',token);
    // Project-scoped deep-link state (e.g. the Schedule tab's view, target and
    // date) is applied inside the window once its project has opened.
    record.routeParams=projectRouteParams(projectId,options);
    frame.src=url.href;
    record.timer=setTimeout(()=>{if(!record.api)status.textContent='Project is still loading. You can close this window and try again.';},30000);
    publishRoute(record);
    return record;
  }
  function accepts(token, child){ return records.get(token)?.frame.contentWindow === child; }
  function ready(token, child, api){
    const record=records.get(token);if(!record || !accepts(token,child) || record.api)return;
    record.api=api;clearTimeout(record.timer);
    const relayUp=type=>()=>root.dispatchEvent(new CustomEvent(type,{detail:{redraw:true,fromProjectWindow:token}}));
    child.addEventListener('fm:projects:refresh',relayUp('fm:projects:refresh'));
    child.addEventListener('fm:calendar:refresh',relayUp('fm:calendar:refresh'));
    child.addEventListener('fm:project-schedule:changed',relayUp('fm:calendar:refresh'));
    child.document.addEventListener('pointerdown',()=>{active=record;record.controller?.focus();publishRoute(record);},true);
    child.addEventListener('fm:route-state:updated',event=>mirrorRouteFromWindow(record,event.detail));
    Promise.resolve(record.project ? api.openProject(record.project,{...record.options,fromRoute:false}) : api.open(null,record.options)).then(result=>{
      applyRouteParams(record,record.routeParams);record.routeMirrorReady=true;
      try{ mirrorRouteFromWindow(record,{route:child.Portal?.navigation?.read?.() || {},changedKeys:PROJECT_SCOPED_ROUTE_KEYS}); }catch(_){}
      record.resolveReady(result);
      // Keyboard focus follows the window that just opened, so Escape and
      // keyboard navigation reach it without a click inside first.
      if(active===record && records.has(token) && record.controller?.state?.mode!=='minimized'){try{record.frame.focus({preventScroll:true});child.focus();}catch(_){}}
    }).catch(error=>{
      record.rejectReady(error);
      console.warn('Project workspace could not finish loading',error);
      if(!records.has(token))return;
      record.layer.append(record.loading);
      record.loading.hidden=false;record.loading.classList.add('failed');record.loading.querySelector('[role=status]').textContent='Unable to load this project. Close this window and try again.';
    });
  }
  function attach(token, child, options){
    const record=records.get(token);if(!record || !accepts(token,child))throw Error('Unknown project window');
    if(record.controller)throw Error('Project workspace already attached');
    child.FirstMateWindows?.ensureStyles?.();
    const bar=document.createElement('div');bar.className='fm-project-minimized-bar';bar.hidden=true;
    const title=document.createElement('button');title.type='button';title.className='fm-project-minimized-title';title.innerHTML='<i class="fas fa-folder-open" aria-hidden="true"></i><span></span>';
    const restore=document.createElement('button');restore.type='button';restore.setAttribute('aria-label','Restore project');restore.innerHTML='<i class="fas fa-window-restore" aria-hidden="true"></i>';
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.setAttribute('aria-label','Close project');dismiss.innerHTML='<i class="fas fa-xmark" aria-hidden="true"></i>';
    title.onclick=restore.onclick=()=>{active=record;record.controller.restore();publishRoute(record);};dismiss.onclick=()=>close(token);bar.append(title,restore,dismiss);record.element.append(bar);record.minimizedBar=bar;
    function placement(state,notify=true){
      const minimized=state.mode==='minimized';bar.hidden=!minimized;
      bar.querySelector('span').textContent=options.title?.textContent || record.frame.getAttribute('aria-label') || '';
      title.title=bar.querySelector('span').textContent;
      if(!minimized){record.frame.style.width='100%';record.frame.style.height='100%';}
      clearRoutePrecover();
      record.frame.style.visibility=minimized?'hidden':'visible';
      sync(record);if(notify)options.onChange?.(state);
    }
    record.controller=root.FirstMateWindows.attach({...options,element:record.element,host:host(),stackElement:record.layer,contentTarget:document.getElementById('mainPanels'),nativeModalLayout:false,
      topInset:()=>document.getElementById('platformTopbar')?.offsetHeight || 0,
      onBeforeModeChange:({mode})=>{if(mode==='minimized'){record.frame.style.width=record.frame.clientWidth+'px';record.frame.style.height=record.frame.clientHeight+'px';}},
      onClose:()=>close(token),onChange:placement
    });
    record.loading.remove();record.frame.style.visibility='visible';
    return {
      get state(){return record.controller.state;},
      setMode(mode,opts){record.controller.setMode(mode,opts);if(opts?.silent)placement(record.controller.state,false);},
      setVisible(value){record.controller.setVisible(value);sync(record);},
      refresh(){record.controller.refresh();},focus(){active=record;record.controller.focus();},restore(){record.controller.restore();}
    };
  }
  function update(token, data){const record=records.get(token);if(!record)return;if(data.projectId)record.projectId=data.projectId;if(data.title){record.frame.setAttribute('aria-label',data.title);record.element.setAttribute('aria-label',data.title);const label=record.minimizedBar?.querySelector('span');if(label)label.textContent=data.title;}}
  root.FirstMateProjectWindows={open,close,closed,ready,attach,accepts,update,get active(){return active;},get size(){return records.size;}};
})(window);
