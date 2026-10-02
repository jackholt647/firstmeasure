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
    style.textContent += `
      .fm-project-window-loading{inset:0;border-radius:inherit;display:block;color:#101828;font-weight:400}
      .fm-project-window-loading:before{display:none}.fm-project-window-loading[hidden]{display:none!important}
      .fm-project-loading-header{position:relative;background:#fff;border-bottom:1px solid #e4e7ec;color:#101828}
      .fm-project-loading-header .fm-shell-identity{display:flex;align-items:center;gap:8px;min-width:0}
      .fm-project-loading-header .fm-shell-identity>i{color:var(--primary,#d93025)}
      .fm-project-window-loading button{position:static;inset:auto;font-family:inherit}
      .fm-project-window-loading .fm-window-controls{display:flex;gap:0}
      .fm-project-window-loading .fm-window-controls button{padding:0;border:0;background:none}
      .fm-project-window-loading .fm-window-controls button[aria-pressed=true]{background:#e4e7ec}
      .fm-project-window-loading .fm-window-controls button:hover{background:#66708520}
      .fm-project-window-loading .fm-window-controls button[data-window-action=close]:hover{background:#d92d20;color:#fff}
      .fm-project-window-loading .r-project-identity-trigger{height:auto;border:0;background:none;padding:4px 0;color:inherit;font:inherit}.fm-project-window-loading .r-project-tag{height:auto;font-family:inherit}.fm-project-window-loading .r-property-type-trigger{height:auto;border:0;background:none;color:inherit;padding:4px 9px;border-radius:999px}.fm-project-window-loading .r-project-tag i{color:inherit}\n      .fm-project-window-loading .fm-shell-tabs button{display:flex;align-items:center;gap:6px}
      .fm-project-window-loading [role=status]{position:absolute;inset:69px 0 0;display:flex;align-items:center;justify-content:center;gap:10px;color:#667085;font-size:13px}
      .fm-project-window-loading [role=status]:before{content:"";width:16px;height:16px;border:2px solid #d0d5dd;border-top-color:var(--primary,#d93025);border-radius:50%;animation:fm-project-window-spin .8s linear infinite}
      .fm-project-window-loading.failed [role=status]:before{display:none}
      @media(max-width:760px){.fm-project-frame{inset:0;width:100%;height:100%;border-radius:0}}
    `;
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
    root.Portal?.modules?.request?.ensureStyles?.();
    root.FirstMateWindows.ensureStyles?.();
    root.FirstMateWindowShell?.ensureStyles?.();
    const projectId = identity(project);
    const existing = projectId && [...records.values()].find(record=>record.projectId === projectId);
    if (existing) {
      clearRoutePrecover();
      const shouldFocus = !options.fromRoute || active !== existing;
      if (shouldFocus) { existing.controller?.restore(); existing.controller?.focus(); active=existing; publishRoute(existing); }
      const routeParams=projectRouteParams(projectId,options);
      if (options.tab || options.photo || options.layout) {
        if(existing.api) {
          existing.ready=existing.ready.catch(()=>{}).then(()=>existing.api.openProject(project,{...options,fromRoute:false})).then(result=>{applyRouteParams(existing,routeParams);return result;});
          existing.ready.catch(()=>{});
        }
        else {existing.options={...existing.options,...options};existing.routeParams=routeParams;}
      }
      else applyRouteParams(existing,routeParams);
      return existing;
    }
    const token = root.crypto.randomUUID();
    const layer = document.createElement('div'); layer.className='fm-project-window-layer';layer.dataset.mode='modal';layer.dataset.projectWindow=token;
    const element = document.createElement('section');element.className='fm-project-frame';element.hidden=false;
    const frame = document.createElement('iframe');frame.name='fm-project-window:'+token;frame.style.visibility='hidden';frame.setAttribute('aria-label',String(project?.title || project?.address || 'Project workspace'));frame.setAttribute('allow','clipboard-write; microphone; camera; fullscreen');
    const loading = document.createElement('div');loading.className='fm-project-window-loading fm-entity-window';
    const header=document.createElement('header');header.className='fm-project-loading-header fm-shell-header';header.dataset.headerRows='2';
    const identityNode=document.createElement('div');identityNode.className='r-window-identity fm-shell-identity';identityNode.innerHTML='<i class="fas fa-folder-open" aria-hidden="true"></i>';
    const title=document.createElement('span');title.className='fm-project-loading-title r-window-project-title';
    title.textContent=String(project?.title || project?.project_title || project?.address || (projectId ? 'Project' : 'New Project'));
    const identityTrigger=document.createElement('button');identityTrigger.type='button';identityTrigger.className='r-project-identity-trigger';identityTrigger.setAttribute('aria-label','Edit project contact and address');identityTrigger.append(title);
    const pills=document.createElement('div');pills.className='r-project-stage-bar';
    identityNode.append(identityTrigger,pills);
    const controls=document.createElement('div');controls.className='r-window-bar-actions';
    const tabs=document.createElement('nav');tabs.className='fm-shell-tabs';tabs.dataset.tabStyle='underline';tabs.setAttribute('aria-label','Project tabs');
    const overview=document.createElement('button');overview.type='button';overview.dataset.tab='map';overview.innerHTML='<i class="fas fa-columns" aria-hidden="true"></i><span>Overview</span>';overview.setAttribute('aria-selected',String(!options.tab || options.tab==='map'));tabs.append(overview);
    const trays=document.createElement('nav');trays.className='fm-project-tray-tabs';trays.setAttribute('role','tablist');trays.setAttribute('aria-label','Project trays');
    for(const [label,icon] of [['Notes','note-sticky'],['Activity','clock-rotate-left'],['Agent','wand-magic-sparkles']]){
      const button=document.createElement('button');button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-label',label);button.setAttribute('aria-selected','false');button.disabled=true;button.title=label+' - loading project';button.innerHTML='<i class="fas fa-'+icon+'" aria-hidden="true"></i>';trays.append(button);
    }
    const status=document.createElement('span');status.textContent='Opening project…';status.setAttribute('role','status');
    header.append(identityNode,tabs,controls,trays);loading.append(header,status);
    const record={token,projectId,project,options,layer,element,frame,loading,controller:null,api:null,modal:null};
    const selectOpeningTab=id=>{
      record.options={...record.options,tab:id,...(id!=='photos' ? {photo:''} : {}),...(record.options.layout?.panes ? {layout:{...record.options.layout,panes:[{tab:id}]}} : {})};
      tabs.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.tab===id)));
    };
    const paintHeader=()=>{
      if(record.shellVisible || !records.has(token))return;
      const metadata=root.Portal?.modules?.request?.openingHeader?.(record.project || {});
      if(!metadata){title.textContent=record.project?.title || record.project?.address || 'Project';return;}
      title.innerHTML=metadata.identityHtml;
      pills.innerHTML='<div class="r-project-tags">'+metadata.pillsHtml+'</div>';
      // These are the eventual controls; queue the action while the child boots.
      pills.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{
        const selector=button.hasAttribute('data-manual-stage-trigger')?'[data-manual-stage-trigger]':'[data-header-property-type]';
        record.ready.then(()=>record.frame.contentDocument?.querySelector(selector)?.click()).catch(()=>{});
      }));
      record.frame.setAttribute('aria-label',metadata.title);
    };
    identityTrigger.onclick=()=>record.ready.then(()=>record.frame.contentDocument?.querySelector('#rProjectIdentityTrigger')?.click()).catch(()=>{});
    overview.onclick=()=>selectOpeningTab('map');
    // The parent already has the app catalog and access snapshot. Reading
    // descriptors does not mount apps or wait for the child portal's boot.
    try{
      for(const tab of root.Portal?.modules?.request?.openingTabs?.(project,options) || []){
        if(!tab.id || tab.id==='map')continue;
        const button=document.createElement('button');button.type='button';button.dataset.tab=tab.id;button.disabled=!!tab.disabled;
        button.setAttribute('aria-selected',String(tab.id===options.tab));
        if(tab.icon){const icon=document.createElement('i');icon.className='fas '+tab.icon;icon.setAttribute('aria-hidden','true');button.append(icon);}
        const label=document.createElement('span');label.textContent=tab.label || tab.id;button.append(label);
        button.onclick=()=>selectOpeningTab(tab.id);tabs.append(button);
      }
    }catch(error){console.warn('Project opening tabs unavailable',error);}
    record.openingTabIds=[...tabs.querySelectorAll('[data-tab]')].map(button=>button.dataset.tab);
    record.ready = new Promise((resolve,reject)=>{record.resolveReady=resolve;record.rejectReady=reject;});
    record.ready.catch(()=>{});
    records.set(token,record);active=record;
    paintHeader();
    Promise.resolve(root.Portal?.modules?.request?.prepareHeader?.()).then(paintHeader).catch(()=>{});
    // Fetch the authoritative project while the isolated document boots,
    // instead of waiting for its scripts, session and commerce to finish.
    const orgId=String(root.Portal?.cfg?.userOrgId || root.Portal?.cfg?.orgId || root.__APP?.userOrgId || '').trim();
    if(orgId && /^(project|base|__optimistic)_/i.test(projectId) && root.PlatformAPI?.projects?.get){
      record.projectRead={orgId,projectId,started:Date.now(),promise:Promise.resolve().then(()=>root.PlatformAPI.projects.get(orgId,projectId)).then(result=>{
        const data=result?.document?.data;
        if(data && records.get(token)===record && !root.Portal?.ProjectStore?.hasPendingSave?.(projectId)){record.project={...record.project,...data,id:data.id || result.document.id || projectId};paintHeader();}
        return result;
      }).catch(()=>null)};
    }
    element.append(frame,loading);layer.append(element);host().append(layer);clearRoutePrecover();
    root.FirstMateWindowShell?.revealTabs?.(tabs);
    attach(token,frame.contentWindow,{
      header,title,controlsHost:controls,customChrome:true,presentationModes:true,mobileFullscreen:true,allowFullscreen:false,viewportCoordinates:true,
      name:'project',label:'Project',mode:'modal',width:1200,height:800,dockWidth:900,minWidth:360,minimizedHeight:32
    },true);

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
  function takeProjectRead(token, child, orgId, projectId){
    const record=records.get(token),read=record?.projectRead;
    if(!read || !accepts(token,child) || read.orgId!==orgId || read.projectId!==projectId)return null;
    record.projectRead=null;
    // This is a one-open handoff, never a cache for later refreshes or edits.
    if(Date.now()-read.started>10000)return null;
    return read.promise;
  }
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
      record.controller?.rebindChrome({header:record.loading.querySelector('header'),title:record.loading.querySelector('.fm-project-loading-title'),controlsHost:record.loading.querySelector('.r-window-bar-actions')});
      record.element.append(record.loading);
      record.loading.hidden=false;record.loading.classList.add('failed');record.loading.querySelector('[role=status]').textContent='Unable to load this project. Close this window and try again.';
    });
  }
  function attach(token, child, options, loadingShell=false){
    const record=records.get(token);if(!record || !accepts(token,child))throw Error('Unknown project window');
    if(record.childAttached)throw Error('Project workspace already attached');
    if(!loadingShell)record.childAttached=true;
    child.FirstMateWindows?.ensureStyles?.();
    record.minimizedBar?.remove();
    const bar=document.createElement('div');bar.className='fm-project-minimized-bar';bar.hidden=true;
    const title=document.createElement('button');title.type='button';title.className='fm-project-minimized-title';title.innerHTML='<i class="fas fa-folder-open" aria-hidden="true"></i><span></span>';
    const restore=document.createElement('button');restore.type='button';restore.setAttribute('aria-label','Restore project');restore.innerHTML='<i class="fas fa-window-restore" aria-hidden="true"></i>';
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.setAttribute('aria-label','Close project');dismiss.innerHTML='<i class="fas fa-xmark" aria-hidden="true"></i>';
    title.onclick=restore.onclick=()=>{active=record;record.controller.restore();publishRoute(record);};dismiss.onclick=()=>close(token);bar.append(title,restore,dismiss);record.element.append(bar);record.minimizedBar=bar;
    function placement(state,notify=true){
      const minimized=state.mode==='minimized';bar.hidden=!minimized;
      record.loading.hidden=minimized;
      if(loadingShell && notify)record.userPlacement=true;
      bar.querySelector('span').textContent=options.title?.textContent || record.frame.getAttribute('aria-label') || '';
      title.title=bar.querySelector('span').textContent;
      if(!minimized){record.frame.style.width='100%';record.frame.style.height='100%';}
      clearRoutePrecover();
      record.frame.style.visibility=minimized || !record.shellVisible?'hidden':'visible';
      sync(record);if(notify)options.onChange?.(state);
    }
    const controllerOptions={...options,element:record.element,host:host(),stackElement:record.layer,contentTarget:document.getElementById('mainPanels'),nativeModalLayout:false,titleMenu:false,animateGeometry:true,
      topInset:()=>document.getElementById('platformTopbar')?.offsetHeight || 0,
      onBeforeModeChange:({mode})=>{if(mode==='minimized'){record.frame.style.width=record.frame.clientWidth+'px';record.frame.style.height=record.frame.clientHeight+'px';}},
      onClose:()=>close(token),onChange:placement
    };
    if(record.controller)record.controller.rebindChrome(controllerOptions);
    else record.controller=root.FirstMateWindows.attach(controllerOptions);
    placement(record.controller.state,false);
    // attach() runs while the child is still building its shell and CSS.
    // Only setVisible(true), at the end of open(), may expose that document.
    return {
      get state(){return record.controller.state;},
      setMode(mode,opts){if(!record.shellVisible && record.userPlacement)return;record.controller.setMode(mode,opts);if(opts?.silent)placement(record.controller.state,false);},
      setVisible(value){
        if(value && !record.shellVisible){
          // The embedded shell has its own ready state; unrelated credits
          // refreshes must not put the portal's boot cover above it.
          child.document.body.classList.remove('platform-booting');
          child.document.getElementById('fmPlatformBootCover')?.remove();
          record.shellVisible=true;record.loading.remove();
          child.FirstMateWindowShell?.revealTabs?.(child.document.getElementById('rProjectViewerTabs'),record.openingTabIds);
        }
        record.controller.setVisible(value);placement(record.controller.state);
      },
      refresh(){record.controller.refresh();},focus(){active=record;record.controller.focus();},restore(){record.controller.restore();}
    };
  }
  function update(token, data){const record=records.get(token);if(!record)return;if(data.projectId)record.projectId=data.projectId;if(data.title){record.frame.setAttribute('aria-label',data.title);record.element.setAttribute('aria-label',data.title);const label=record.minimizedBar?.querySelector('span');if(label)label.textContent=data.title;const loadingTitle=record.loading.querySelector('.fm-project-loading-title');if(loadingTitle && !loadingTitle.querySelector('strong'))loadingTitle.textContent=data.title;}}
  function headerState(token,child){return accepts(token,child) ? root.Portal?.modules?.request?.headerState?.() : null;}
  root.FirstMateProjectWindows={headerState,open,close,closed,ready,attach,accepts,update,takeProjectRead,get active(){return active;},get size(){return records.size;}};
})(window);
