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
    style.textContent = `.fm-project-window-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483100}.fm-project-window-layer[data-mode=modal],.fm-project-window-layer[data-mode=fullscreen]{background:rgba(11,16,24,.78);pointer-events:auto}.fm-project-frame{position:fixed;left:2vw;top:4vh;width:96vw;height:92vh;pointer-events:auto;overflow:hidden!important;border-radius:14px;background:#fff}.fm-project-frame iframe{display:block;width:100%;height:100%;border:0}.fm-project-window-loading{position:absolute;inset:4%;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:14px;pointer-events:auto}.fm-project-window-loading button{position:absolute;top:8px;right:8px}.fm-project-frame[hidden]{display:none!important}`;
    document.head.append(style);
    style.textContent += `.fm-project-minimized-bar{position:absolute;inset:0;display:flex;align-items:center;gap:3px;padding:0 4px;background:#fff;font:12px Arial,sans-serif}.fm-project-minimized-bar[hidden]{display:none}.fm-project-minimized-bar button{height:28px;border:0;background:none;color:#344054;cursor:pointer}.fm-project-minimized-bar .fm-project-minimized-title{display:flex;align-items:center;gap:6px;min-width:0;flex:1;text-align:left}.fm-project-minimized-title span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.fm-project-minimized-title i{color:var(--primary,#d93025)}.fm-project-minimized-bar button:last-child:hover{background:#d92d20;color:white}`;
  }
  function publishRoute(record){
    if (!record.projectId) return;
    const current = root.Portal?.routeState?.get?.() || {};
    if (current.project === record.projectId) return;
    root.Portal?.routeState?.set?.({project:record.projectId, projectTab:record.options.tab || null}, {history:'replace',source:'project-window-focus'});
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
    record.controller?.destroy(); record.layer.remove();
    if (active === record) {
      active = null;
      if ((root.Portal?.routeState?.get?.() || {}).project === record.projectId) root.Portal?.routeState?.set?.({project:null,projectTab:null,projectFullscreen:null},{history:'replace',source:'project-window-close'});
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
      const shouldFocus = !options.fromRoute || active !== existing;
      if (shouldFocus) { existing.controller?.restore(); existing.controller?.focus(); active=existing; publishRoute(existing); }
      if (options.tab || options.photo) existing.api?.openProject(project,{...options,fromRoute:false});
      return existing;
    }
    const token = root.crypto.randomUUID();
    const layer = document.createElement('div'); layer.className='fm-project-window-layer';layer.dataset.mode='modal';layer.dataset.projectWindow=token;
    const element = document.createElement('section');element.className='fm-project-frame';element.hidden=false;
    const frame = document.createElement('iframe');frame.name='fm-project-window:'+token;frame.style.visibility='hidden';frame.setAttribute('aria-label',String(project?.title || project?.address || 'Project workspace'));frame.setAttribute('allow','clipboard-write; microphone; camera; fullscreen');
    const loading = document.createElement('div');loading.className='fm-project-window-loading';
    const status=document.createElement('span');status.textContent='Opening project…';status.setAttribute('role','status');
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='Close';dismiss.onclick=()=>close(token);loading.append(status,dismiss);
    const record={token,projectId,project,options,layer,element,frame,loading,controller:null,api:null,modal:null};
    record.ready = new Promise((resolve,reject)=>{record.resolveReady=resolve;record.rejectReady=reject;});
    record.ready.catch(()=>{});
    records.set(token,record);active=record;
    element.append(frame);layer.append(element,loading);host().append(layer);
    const url=new URL(root.location.href);url.search='';url.hash='';url.searchParams.set('projectWindow',token);
    frame.src=url.href;
    record.timer=setTimeout(()=>{if(!record.api)status.textContent='Project is still loading. You can close this window and try again.';},30000);
    publishRoute(record);
    return record;
  }
  function accepts(token, child){ return records.get(token)?.frame.contentWindow === child; }
  function ready(token, child, api){
    const record=records.get(token);if(!record || !accepts(token,child) || record.api)return;
    record.api=api;clearTimeout(record.timer);
    child.addEventListener('fm:projects:refresh',()=>root.dispatchEvent(new CustomEvent('fm:projects:refresh',{detail:{redraw:true}})));
    child.document.addEventListener('pointerdown',()=>{active=record;record.controller?.focus();publishRoute(record);},true);
    Promise.resolve(record.project ? api.openProject(record.project,{...record.options,fromRoute:false}) : api.open(null,record.options)).then(record.resolveReady).catch(error=>{
      record.rejectReady(error);
      console.warn('Project workspace could not finish loading',error);
      if(!records.has(token))return;
      record.layer.append(record.loading);
      record.loading.hidden=false;record.loading.querySelector('[role=status]').textContent='Unable to load this project. Close this window and try again.';
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
