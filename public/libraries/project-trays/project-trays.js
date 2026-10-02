/* Project shell trays. Domain behavior belongs to ProjectNotes, Channels,
 * PlatformAssistant and the existing activity APIs; this owns only placement. */
(function(root) {
  'use strict';
  if (root.FirstMateProjectTrays) return;
  const clean = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const registry = new Map([
    ['notes',{id:'notes',label:'Notes',icon:'fa-note-sticky',capability:'channels.project_notes'}],
    ['todo',{id:'todo',label:'To Do',icon:'fa-list-check'}],
    ['messages',{id:'messages',label:'Messages',icon:'fa-comments',capability:'channels.project_notes',enabled:()=>root.Portal?.can?.('channels.separate_project_notes') === true}],
    ['activity',{id:'activity',label:'Activity',icon:'fa-clock-rotate-left'}],
    ['agent',{id:'agent',label:'Agent',icon:'fa-wand-magic-sparkles',capability:'apps.assistant'}]
  ]);
  function definitions() {return [...registry.values()].filter(item => (!item.capability || root.Portal?.can?.(item.capability) !== false) && (!item.enabled || item.enabled()));}
  function register(definition) {
    if (!/^[a-z][a-z0-9_-]*$/.test(definition?.id || '') || !definition.label) throw Error('Invalid project tray definition');
    registry.set(definition.id,{...definition});
    root.dispatchEvent(new CustomEvent('fm:project-trays:updated'));
  }
  function mount(shell, options = {}) {
    const preview = options.content || shell.querySelector('.r-preview'), header = options.header || shell.querySelector('.r-modal-header') || shell.closest('.r-overlay')?.querySelector('.r-modal-header');
    if (!preview || !header) throw Error('Project shell content is unavailable.');
    const style = document.createElement('style');
    style.textContent = `.fm-project-tray-tabs{display:flex;justify-content:flex-end;gap:2px;flex:none;min-height:32px;background:white;border-bottom:1px solid #e4e7ec;padding-right:5px}.r-overlay.project-layout-prototype .r-window-bar:has(>.fm-project-tray-tabs){grid-template-columns:minmax(0,1fr) auto auto auto}.r-overlay.project-layout-prototype .r-window-bar>.fm-project-tray-tabs{grid-row:2;grid-column:4;align-self:stretch;border-bottom:0;min-height:0;padding:0 4px;background:#fff}.r-window-bar>.fm-project-tray-tabs{margin-left:auto;align-items:center}.fm-project-tray-tabs button{width:32px;height:30px;border:0;border-radius:5px;background:none;color:#667085;cursor:pointer}.fm-project-tray-tabs button[aria-selected=true]{background:var(--primary-light,#eef2ff);color:var(--primary,#175cd3)}.fm-project-content{display:grid;grid-template-columns:minmax(0,1fr) 0px;flex:1;min-height:0;position:relative;transition:grid-template-columns .32s cubic-bezier(.22,1,.36,1)}.fm-window[data-window=minimized]>.fm-project-content{display:none!important}.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) min(380px,45%)}.fm-project-content>.r-project-body,.fm-project-content>.r-preview{min-width:0;min-height:0;height:100%}.fm-project-tray{min-width:0;overflow:hidden;background:#fff;border-left:1px solid #e4e7ec;display:flex;flex-direction:column;opacity:0;transform:translateX(16px);transition:opacity .25s,transform .32s cubic-bezier(.22,1,.36,1)}[data-tray-open=true]>.fm-project-tray{opacity:1;transform:none}.fm-project-tray>header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e4e7ec;flex:none}.fm-project-tray>header[hidden]{display:none}.fm-project-tray button{cursor:pointer}.fm-project-tray-close{border:0;background:none;color:#667085;padding:5px}.fm-project-tray-panel{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}.fm-project-tray-panel[hidden]{display:none!important}.fm-project-activity{overflow:auto;padding:12px;flex:1}.fm-project-activity article{padding:10px 0;border-bottom:1px solid #f2f4f7}.fm-project-activity p{margin:4px 0}.fm-project-activity time{font-size:11px;color:#667085}.fm-project-activity-tools{display:flex;justify-content:flex-end;padding:8px}.fm-project-activity-tools button{border:1px solid #d0d5dd;background:white;border-radius:6px;padding:5px 9px}@media(max-width:700px){.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray{position:absolute;inset:0 0 0 auto;width:min(100%,380px);z-index:70;box-shadow:-8px 0 24px #10182820}.fm-project-content:not([data-tray-open=true])>.fm-project-tray{visibility:hidden}}@media(prefers-reduced-motion:reduce){.fm-project-content,.fm-project-tray{transition:none}}`;
    document.head.append(style);
    const tabs = document.createElement('nav'); tabs.className = 'fm-project-tray-tabs'; tabs.setAttribute('aria-label','Project trays'); tabs.setAttribute('role','tablist'); header.append(tabs);
    const content = document.createElement('div'); content.className = 'fm-project-content'; preview.before(content); content.append(preview);
    const tray = document.createElement('aside'); tray.className = 'fm-project-tray'; tray.inert = true; tray.setAttribute('aria-hidden','true');
    tray.innerHTML = '<header><strong></strong><button type="button" class="fm-project-tray-close" aria-label="Close project tray"><i class="fas fa-xmark"></i></button></header>';
    content.append(tray);
    const pin = document.createElement('div'); pin.className='fm-project-agent-pin'; pin.hidden=true; tray.append(pin);
    const pinStyle=document.createElement('style');pinStyle.textContent=`.fm-project-agent-pin{height:100px;flex:0 0 100px;min-height:0;border-top:1px solid #e4e7ec}.fm-project-agent-pin[hidden]{display:none}.fm-project-content:has(>.fm-project-tray[data-pin-only=true]){grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray[data-pin-only=true]{position:absolute;right:0;bottom:0;top:auto;height:100px;width:min(380px,100%);z-index:70;justify-content:flex-end;background:transparent;border-left:0;pointer-events:none}.fm-project-tray[data-pin-only=true]>.fm-project-agent-pin{background:white;pointer-events:auto;border:1px solid #e4e7ec;border-radius:10px 0 0 0}.fma-pinned .fma-stage,.fma-pinned .fma-sidebar,.fma-pinned .fma-attachments,.fma-pinned [data-fma=history],.fma-pinned [data-fma=boardSide],.fma-pinned [data-fma=visualsToggle],.fma-pinned [data-fma=closeSurface]{display:none!important}.fma-pinned .fma-head{min-height:32px;padding:4px 8px}.fma-pinned .fma-composer{padding:6px 8px}.fma-pinned .fma-body,.fma-pinned .fma-content{min-height:0}.fm-project-agent-close-menu{position:absolute;right:8px;top:4px;z-index:10000;background:white;border:1px solid #d0d5dd;border-radius:9px;padding:6px;box-shadow:0 8px 24px #10182830;display:flex;gap:6px}.fm-project-agent-close-menu button{padding:8px;border:0;border-radius:6px;background:#f2f4f7;color:#344054;cursor:pointer}.fm-project-agent-close-menu [role=status]{max-width:240px;font-size:12px}`;document.head.append(pinStyle);
    let agentState={voice:false,pending:false}, manualPin=false, closeMenu=null;
    const panels = new Map(), handles = new Map();
    let projectId = '', selected = '', disposed = false, activityTimer = 0, interactionVersion = 0;
    const oid = clean(options.orgId || root.__APP?.userOrgId);
    const getProject = () => options.getProject?.() || options.project || {};
    const capable = key => root.Portal?.can?.(key) !== false;
    const separate = () => root.Portal?.can?.('channels.separate_project_notes') === true;
    const available = () => definitions().map(item=>item.id);
    function close() {selected = ''; panels.forEach(node=>node.hidden=true); renderTabs(); syncAgentPin();}
    function renderTabs() {
      const allowed = definitions().map(item=>[item.id,item.label,item.icon]);
      if (selected && !allowed.some(([key]) => key === selected)) close();
      tabs.innerHTML = allowed.map(([key,title,icon]) => `<button type="button" role="tab" data-tray="${key}" aria-label="${title}" title="${title}" aria-selected="${selected === key}"><i class="fas ${icon}" aria-hidden="true"></i></button>`).join('');
    }
    function panel(key) {
      if (!panels.has(key)) { const node = document.createElement('div'); node.className = 'fm-project-tray-panel'; node.hidden = true; node.setAttribute('role','tabpanel'); node.setAttribute('aria-label',registry.get(key).label); tray.insertBefore(node,pin); panels.set(key,node); }
      return panels.get(key);
    }
    async function open(key) {
      update(); if (!available().includes(key)) throw Error('Unavailable project tray: '+key);
      if (selected === key) {close(); return;}
      selected = key; content.dataset.trayOpen = 'true'; tray.inert = false; tray.setAttribute('aria-hidden','false');
      tray.querySelector('header').hidden = key === 'agent';
      tray.querySelector('strong').textContent = registry.get(key).label;
      const node = panel(key); panels.forEach((value,name) => value.hidden = name !== key); renderTabs(); syncAgentPin();
      if (handles.has(key)) {if (key === 'activity') handles.get(key).refresh(); if (key === 'todo') handles.get(key).load({quiet:true}).catch(()=>null); return;}
      if (!projectId && key !== 'notes') {node.textContent='Select or create a project to use '+registry.get(key).label.toLowerCase()+'.';return;}
      const mountingProject = projectId;
      try {
        if (key === 'notes') handles.set(key, root.Portal.ProjectNotes.mount(node,{project:getProject(),getProject,ensureProject:options.ensureProject}));
        if (key === 'todo') {
          if (!root.PlatformActionItems?.renderTodayList) throw Error('Project to-dos are not available.');
          const project = getProject();
          node.style.padding = '12px';
          handles.set(key,root.PlatformActionItems.renderTodayList(node,{
            orgId:oid, projectId,
            branchId:root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default',
            userId:clean(root.__APP?.userId || root.__APP?.user_id),
            projectTitle:clean(project.title || project.customer_name || project.address || 'Project'),
            projectAddress:clean(project.address || project.project_address),
            completedOpen:false, futureOpen:false, dockDeferredSections:true,
            scrollItemsOnly:true, showProjectContext:false, showUpcoming:true, showFuture:true,
            query:{includeFuture:true,includeAll:true}
          }));
        }
        if (key === 'agent') handles.set(key, root.PlatformAssistant.mountProject(node,{orgId:oid, projectId, onClose:close, openTray:key=>selected===key?Promise.resolve():open(key), onPin:()=>{if(selected==='agent'){manualPin=!manualPin;syncAgentPin();}else void open('agent');}, onState:state=>{agentState=state;queueMicrotask(syncAgentPin);}, getContext:()=>({surface:'project',projectId,trays:available(),tab:options.getActiveTab?.() || '',tray:selected || '',minimized:options.isMinimized?.() || false})}));
        if (key === 'messages') {
          const pending = {}; handles.set(key,pending);
          node.textContent = 'Loading messages…';
          const data = await root.ChannelsAPI.channels.ensureProject(oid,projectId);
          if (disposed || mountingProject !== projectId || !handles.has(key)) return;
          node.replaceChildren(); handles.set(key,root.FirstMateChannels.create(node,{orgId:oid,context:{channelId:data.channel.id},mode:'embedded',features:{resources:false}}));
        }
        if (key === 'activity') handles.set(key,mountActivity(node,mountingProject));
        syncAgentPin();
        if (registry.get(key).mount) handles.set(key,registry.get(key).mount(node,{getProject,projectId,orgId:oid}));
      } catch (error) {if (!disposed && mountingProject === projectId) {tray.querySelector('header').hidden = false; handles.delete(key); node.textContent = error.message; const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.onclick = () => {selected = ''; open(key);}; node.append(retry);}}
    }
    function syncAgentPin(){
      if(disposed)return;
      const agent=handles.get('agent'), pinned=!!agent && selected!=='agent' && (manualPin || agentState.voice);
      pin.hidden=!pinned;
      if(agent){agent.moveTo(pinned?pin:panel('agent'));agent.setCompact(pinned);}
      const visible=!!selected || pinned;
      content.dataset.trayOpen=String(visible);tray.dataset.pinOnly=String(pinned && !selected);
      tray.inert=!visible;tray.setAttribute('aria-hidden',String(!visible));
      tray.querySelector('header').hidden=!selected || selected==='agent';
      root.dispatchEvent(new CustomEvent('fm:project-agent:state',{detail:{...agentState,pinned:manualPin || agentState.voice}}));
      agent?.setWorkspaceContext?.();
    }
    function requestClose(done){
      const agent=handles.get('agent');
      if(!agentState.voice && !agentState.pending && !manualPin)return true;
      if(closeMenu)return false;
      closeMenu=document.createElement('div');closeMenu.className='fm-project-agent-close-menu';closeMenu.setAttribute('role','group');closeMenu.setAttribute('aria-label','Close project with active agent');
      closeMenu.innerHTML='<button type="button" data-end>End voice agent</button><button type="button" data-transfer>Transfer to global voice agent</button><button type="button" data-cancel aria-label="Keep project open">Cancel</button><span role="status"></span>';
      (shell.closest('.r-overlay') || shell).append(closeMenu);
      const dismiss=()=>{closeMenu?.remove();closeMenu=null;};
      closeMenu.querySelector('[data-cancel]').onclick=dismiss;
      closeMenu.querySelector('[data-end]').onclick=()=>{agent.endVoice();dismiss();done();};
      closeMenu.querySelector('[data-transfer]').onclick=async()=>{
        const menu=closeMenu;menu.querySelectorAll('button').forEach(button=>button.disabled=true);
        try{await agent.transferToGlobal();handles.delete('agent');agentState={voice:false,pending:false};manualPin=false;dismiss();syncAgentPin();done();}
        catch(error){menu.querySelector('[role=status]').textContent=error.message;menu.querySelectorAll('button').forEach(button=>button.disabled=false);}
      };
      closeMenu.querySelector('button').focus();return false;
    }
    function mountActivity(node,pid) {
      let events = [], before = '', loading = false, dead = false;
      node.innerHTML = '<div class="fm-project-activity-tools"><button type="button">Refresh</button></div><div class="fm-project-activity" role="log"></div>';
      const log = node.querySelector('[role=log]');
      const format = event => {
        const payload = event.payload || {}, data = event.data || event;
        const noteVerb = {created:'added a note',edited:'edited a note',deleted:'removed a note',restored:'restored a note',pinned:'pinned a note',unpinned:'unpinned a note',shared:'shared a note'};
        const kind = clean(event.type || data.type);
        if (kind.startsWith('project.note.')) return `${payload.actor_name || 'A teammate'} ${noteVerb[kind.split('.').pop()] || 'updated a note'}`;
        return clean(data.summary || data.description || data.title || payload.summary || payload.description) || kind.replace(/[._]/g,' ');
      };
      function render() {
        if (dead) return;
        log.innerHTML = events.filter(event => {
          const kind = clean(event.type || event.data?.type);
          return !kind.startsWith('channels.message.') && !/^(message|note)_(added|created|sent)$/.test(kind) && (separate() || !kind.startsWith('project.note.'));
        }).map(event => `<article><p>${esc(format(event))}</p><time>${esc(new Date(event.created_at || event.data?.created_at).toLocaleString())}</time></article>`).join('') || '<p>No project activity yet.</p>';
        if (before) {const more = document.createElement('button'); more.textContent = 'Load older activity'; more.onclick = () => refresh(true); log.append(more);}
      }
      async function refresh(older = false) {
        if (loading || dead) return;
        loading = true;
        try {
          const [work,audit] = await Promise.all([root.PlatformAPI.work.activity(oid,{projectId:pid,limit:100,before:older ? before : ''}), older ? Promise.resolve({events:[]}) : root.PlatformAPI.userActivity.listForProject(oid,pid,{limit:200})]);
          if (dead) return;
          const next = [...(work.events || []),...(audit.events || [])];
          events = [...new Map([...(older ? events : []),...next].map(event => [event.id,event])).values()].sort((a,b) => Date.parse(b.created_at || b.data?.created_at) - Date.parse(a.created_at || a.data?.created_at));
          before = work.events?.length === 100 ? work.next_before : ''; render();
        } catch (error) {if (!dead) {const failure = document.createElement('p'); failure.textContent = error.message; log.prepend(failure);}}
        finally {loading = false;}
      }
      node.querySelector('button').onclick = () => refresh();
      const poll = setInterval(() => {if (selected === 'activity') refresh();},30000);
      refresh(); return {refresh,destroy() {dead = true; clearInterval(poll);}};
    }
    function update() {
      const next = clean(getProject().platform_project_id || getProject().id);
      if (next !== projectId) {
        const adoptingDraft = !projectId && !!next;
        const previousSelection = selected;
        handles.forEach((handle,key) => {if (!adoptingDraft || key !== 'notes') {handle.destroy?.();handles.delete(key);}});
        panels.forEach((node,key) => {if (!adoptingDraft || key !== 'notes') {node.remove();panels.delete(key);}});
        projectId = next;agentState={voice:false,pending:false};manualPin=false;
        if (adoptingDraft) {
          handles.get('notes')?.refresh?.();
          if (previousSelection && previousSelection !== 'notes') {selected='';void open(previousSelection);}
        } else close();
      }
      renderTabs();
    }
    tabs.onclick = event => {const button = event.target.closest('[data-tray]'); if (button) {interactionVersion++;open(button.dataset.tray);}};
    tray.querySelector('.fm-project-tray-close').onclick = () => {interactionVersion++;const key = selected; close(); tabs.querySelector(`[data-tray="${key}"]`)?.focus();};
    tray.onkeydown = event => {if (event.key === 'Escape') {event.stopPropagation(); interactionVersion++;close();}};
    const contextChanged = () => handles.get('agent')?.setWorkspaceContext?.();
    root.addEventListener('fm:route-state:updated',contextChanged);root.addEventListener('fm:project-window:placement',contextChanged);
    const changed = () => {renderTabs(); handles.get('notes')?.refresh?.();};
    const activityChanged = () => {clearTimeout(activityTimer); activityTimer = setTimeout(() => {if (selected === 'activity') handles.get('activity')?.refresh?.();},400);};
    root.addEventListener('fm:project-trays:updated',changed); root.addEventListener('fm:capabilities:updated',changed); root.addEventListener('fm:project-notes:refreshed',activityChanged); root.addEventListener('fm:projects:refresh',activityChanged);
    update();
    return {requestClose,update,close,open,available,interactionVersion:()=>interactionVersion,select(key){if(key===null){close();return;}if(!available().includes(key))throw Error('Unavailable project tray: '+key);update();return selected===key?Promise.resolve():open(key);},destroy() {disposed = true;root.removeEventListener('fm:route-state:updated',contextChanged);root.removeEventListener('fm:project-window:placement',contextChanged);closeMenu?.remove();pinStyle.remove();clearTimeout(activityTimer);handles.forEach(handle => handle.destroy?.());root.removeEventListener('fm:project-trays:updated',changed); root.removeEventListener('fm:capabilities:updated',changed);root.removeEventListener('fm:project-notes:refreshed',activityChanged);root.removeEventListener('fm:projects:refresh',activityChanged);content.before(preview);content.remove();tabs.remove();style.remove();}};
  }
  root.FirstMateProjectTrays = {mount,definitions,register};
})(window);
