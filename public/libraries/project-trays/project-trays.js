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
  function definitions() {return [...registry.values()].map(item=>({...item,widget:{id:'project.'+item.id,version:'1'}})).filter(item => (!item.capability || root.Portal?.can?.(item.capability) !== false) && (!item.enabled || item.enabled()));}
  function register(definition) {
    if (!/^[a-z][a-z0-9_-]*$/.test(definition?.id || '') || !definition.label) throw Error('Invalid project tray definition');
    registry.set(definition.id,{...definition});
    registerWidgets();
    root.dispatchEvent(new CustomEvent('fm:project-trays:updated'));
  }
  // Interactive project widgets use the existing authenticated domain clients.
  // They are application surfaces, not agent-generated or document renderers.
  const registeredWidgets = new Set();
  function registerWidgets() {
    const widgets = root.FirstMateWidgets;
    if (!widgets) return;
    for (const item of registry.values()) {
      if (registeredWidgets.has(item.id)) continue;
      registeredWidgets.add(item.id);
      widgets.register({id:'project.'+item.id,version:'1',title:item.label,
        description:item.label+' workspace for a project',app:item.id==='agent'?'assistant':item.id==='todo'?'action_items':'projects',
        surfaces:['project','dashboard'],sizing:{mode:'fill',minWidth:180,minHeight:0,aspectRatio:null},
        configSchema:{type:'object',properties:{},additionalProperties:false},sources:[],actions:[]},
        async (node,{context,reference}) => {
          const target=reference.target || context.target || {};
          const options={...context,orgId:target.organizationId,projectId:target.projectId};
          const handle=await mountContent(node,item.id,options);
          context.onMount?.(handle,node);
          return handle;
        });
    }
  }
  async function mountWidget(node,key,options) {
    registerWidgets();
    if (!root.FirstMateWidgets) return mountContent(node,key,options);
    let contentHandle,renderRoot;
    const widget=root.FirstMateWidgets.mount(node,{id:'project.'+key,version:'1',target:{organizationId:options.orgId,projectId:options.projectId}},
      {...options,surface:'project',onMount:(handle,element)=>{contentHandle=handle;renderRoot=element;}});
    await widget.ready;
    if (!contentHandle) {const message=node.textContent;widget.destroy();throw Error(message || 'Unable to open widget');}
    // Preserve the domain controller (including Agent move/pin/transfer) while
    // the widget runtime owns cleanup and visibility.
    return {...contentHandle,...(contentHandle.moveTo?{moveTo:container=>contentHandle.moveTo(container===node?renderRoot:container)}:{}),destroy:()=>widget.destroy(),setVisible:value=>widget.setVisible(value)};
  }
  async function mountContent(node,key,options={}) {
    const oid=clean(options.orgId),pid=clean(options.projectId);
    const definition=definitions().find(item=>item.id===key);
    if (!definition) throw Error('This project widget is unavailable.');
    if (root.__APP?.userOrgId && oid!==root.__APP.userOrgId) throw Error('This project belongs to another organization.');
    if (!pid && key!=='notes') throw Error('Select or create a project to use '+definition.label.toLowerCase()+'.');
    node.style.cssText='height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden';
    const getProject=options.getProject || (()=>({id:pid}));
    if (key==='notes') return root.Portal.ProjectNotes.mount(node,{project:getProject(),getProject,ensureProject:options.ensureProject});
    if (key==='todo') {
      if (!root.PlatformActionItems?.renderTodayList) throw Error('Project to-dos are not available.');
      const project=getProject();node.style.padding='12px';
      return root.PlatformActionItems.renderTodayList(node,{orgId:oid,projectId:pid,
        branchId:root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default',
        userId:clean(root.__APP?.userId || root.__APP?.user_id),
        projectTitle:clean(project.title || project.customer_name || project.address || 'Project'),
        projectAddress:clean(project.address || project.project_address),completedOpen:false,futureOpen:false,
        dockDeferredSections:true,scrollItemsOnly:true,showProjectContext:false,showUpcoming:true,showFuture:true,
        query:{includeFuture:true,includeAll:true}});
    }
    if (key==='agent') return root.PlatformAssistant.mountProject(node,{orgId:oid,projectId:pid,...options.agentOptions});
    if (key==='activity') return mountActivity(node,oid,pid);
    if (key==='messages') {
      const data=await root.ChannelsAPI.channels.ensureProject(oid,pid);
      return root.FirstMateChannels.create(node,{orgId:oid,context:{channelId:data.channel.id},mode:'embedded',features:{resources:false}});
    }
    return definition.mount?.(node,{getProject,projectId:pid,orgId:oid});
  }
  function mountActivity(node,oid,pid) {
    let events=[],before='',loading=false,dead=false,visible=true,loaded=false;
    const style=document.createElement('style');
    style.textContent=`
      .fm-activity-widget{height:100%;min-height:0;display:flex;flex-direction:column;font-size:11px;color:#202124;background:#fff}
      .fm-project-activity-tools{flex:none;padding:12px 12px 9px;border-bottom:1px solid #eef0f3;display:grid;gap:8px}
      .fm-activity-search{display:flex;align-items:center;gap:7px;border:1px solid #e4e7ec;border-radius:6px;padding:0 8px;color:#98a2b3}
      .fm-activity-search input{font:inherit;font-size:11px;border:0;background:transparent;min-width:0;width:100%;height:30px;outline:none;color:#202124}
      .fm-activity-search:focus-within{outline:2px solid var(--primary,#175cd3);outline-offset:1px}
      .fm-activity-filter-row{display:flex;align-items:center;gap:6px}.fm-activity-filter-row select{font:inherit;font-size:11px;max-width:65%;border:0;background:#f5f6f8;border-radius:5px;padding:6px;color:#475467}
      .fm-activity-count{margin-left:auto;color:#667085;font-size:10px;white-space:nowrap}.fm-activity-refresh{border:0;background:transparent;color:#667085;border-radius:5px;width:28px;height:28px;cursor:pointer}
      .fm-activity-refresh:hover{background:#f2f4f7}.fm-activity-widget button:focus-visible,.fm-activity-widget select:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}
      .fm-project-activity{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:0 12px 12px}
      .fm-activity-day{position:sticky;top:0;z-index:1;margin:0;background:#fff;padding:13px 0 8px;font-size:10.5px;font-weight:700;color:#667085;border-bottom:1px solid #f2f4f7}
      .fm-project-activity article{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;position:relative;padding:11px 0}
      .fm-project-activity article:not(:last-child):before{content:'';position:absolute;left:11px;top:34px;bottom:-10px;width:1px;background:#e9ecf1}
      .fm-activity-icon{position:relative;z-index:0;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#f2f4f7;color:#667085;font-size:10px}
      .fm-project-activity p{margin:0;line-height:1.55;overflow-wrap:anywhere;font-size:11px}.fm-activity-meta{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:4px;font-size:10px;color:#98a2b3}.fm-activity-meta time{font-size:10px;color:#667085}
      .fm-activity-empty{text-align:center;padding:38px 14px;color:#667085;line-height:1.6}.fm-activity-empty i{display:block;font-size:20px;color:#98a2b3;margin-bottom:12px}.fm-activity-empty strong{display:block;font-size:12px;color:#344054;margin-bottom:4px}
      .fm-activity-error{flex:none;margin:8px 12px 0;border-radius:6px;padding:8px;color:#b42318;background:#fff4f2;line-height:1.5}.fm-activity-error[hidden]{display:none}
      .fm-activity-more{width:100%;font:inherit;font-size:11px;color:#475467;border:1px solid #e4e7ec;background:#fff;padding:8px;border-radius:6px;margin-top:10px;cursor:pointer}.fm-activity-widget button:disabled{opacity:.45;cursor:wait}
    `;
    node.append(style);
    const shell=document.createElement('section');shell.className='fm-activity-widget';shell.setAttribute('aria-label','Project activity');
    shell.innerHTML='<div class="fm-project-activity-tools"><label class="fm-activity-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" aria-label="Search activity" placeholder="Search activity…"></label><div class="fm-activity-filter-row"><select aria-label="Activity type"><option value="all">All activity</option><option value="project">Project changes</option><option value="tasks">To-dos</option><option value="notes">Notes</option><option value="files">Files & reports</option><option value="schedule">Scheduling</option></select><span class="fm-activity-count" role="status"></span><button class="fm-activity-refresh" type="button" aria-label="Refresh activity" title="Refresh activity"><i class="fas fa-arrow-rotate-right" aria-hidden="true"></i></button></div></div><div class="fm-activity-error" role="alert" hidden></div><div class="fm-project-activity" role="log" aria-label="Activity timeline" aria-live="off"></div>';
    node.append(shell);
    const log=shell.querySelector('[role=log]'),search=shell.querySelector('input'),filter=shell.querySelector('select'),count=shell.querySelector('[role=status]'),failure=shell.querySelector('[role=alert]'),refreshButton=shell.querySelector('.fm-activity-refresh');
    const kind=event=>clean(event.type || event.data?.type);
    const category=event=>/note/.test(kind(event))?'notes':/action.item|action_item|task|todo/.test(kind(event))?'tasks':/file|report|upload|document|measurement/.test(kind(event))?'files':/schedule|appointment|booking/.test(kind(event))?'schedule':'project';
    const categories={project:['Project','fa-pen'],tasks:['To-do','fa-check'],notes:['Note','fa-note-sticky'],files:['File / report','fa-file-lines'],schedule:['Schedule','fa-calendar']};
    const timestamp=event=>Date.parse(event.created_at || event.data?.created_at) || 0;
    const format=event=>{
      const data=event.data || event,payload=event.payload || {};
      const verbs={created:'added a note',edited:'edited a note',deleted:'removed a note',restored:'restored a note',pinned:'pinned a note',unpinned:'unpinned a note',shared:'shared a note'};
      if(kind(event).startsWith('project.note.'))return `${payload.actor_name || 'A teammate'} ${verbs[kind(event).split('.').pop()] || 'updated a note'}`;
      const text=clean(data.summary || data.description || data.title || payload.summary || payload.description) || kind(event).replace(/[._]/g,' ') || 'Project updated';
      return text.charAt(0).toUpperCase()+text.slice(1);
    };
    const actor=event=>clean(event.payload?.actor_name || event.data?.actor_name || event.actor_name || event.actor?.name);
    function dayLabel(date){const today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);return date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString([], {month:'short',day:'numeric',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'});}
    function render(){
      if(dead)return;
      const top=log.scrollTop,query=search.value.trim().toLocaleLowerCase();
      const rows=events.filter(event=>!kind(event).startsWith('channels.message.')&&!/^(message|note)_(added|created|sent)$/.test(kind(event))&&(root.Portal?.can?.('channels.separate_project_notes')===true||!kind(event).startsWith('project.note.')))
        .filter(event=>(filter.value==='all'||category(event)===filter.value)&&(!query||(format(event)+' '+actor(event)).toLocaleLowerCase().includes(query)));
      count.textContent=loaded?rows.length+' event'+(rows.length===1?'':'s'): 'Loading…';
      let group='';
      log.innerHTML=rows.map(event=>{
        const date=new Date(timestamp(event)),valid=!!timestamp(event),day=valid?dayLabel(date):'Earlier activity',heading=day!==group?`<h3 class="fm-activity-day">${esc(day)}</h3>`:'';group=day;
        const [label,icon]=categories[category(event)],name=actor(event),summary=format(event);
        return `${heading}<article><span class="fm-activity-icon"><i class="fas ${icon}" aria-hidden="true"></i></span><div><p>${esc(summary)}</p><div class="fm-activity-meta">${name&&!summary.includes(name)?`<span>${esc(name)}</span><span aria-hidden="true">·</span>`:''}<span>${label}</span>${valid?`<span aria-hidden="true">·</span><time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))}</time>`:''}</div></div></article>`;
      }).join('') || `<div class="fm-activity-empty"><i class="fas ${loaded?'fa-clock-rotate-left':'fa-spinner'}" aria-hidden="true"></i><strong>${loaded?(query||filter.value!=='all'?'No matching activity':'No activity yet'):'Loading activity…'}</strong>${loaded?(query||filter.value!=='all'?'Try another search or activity type.':'Project updates will appear here as work progresses.'):''}</div>`;
      if(before){const more=document.createElement('button');more.type='button';more.className='fm-activity-more';more.textContent='Load older activity';more.disabled=loading;more.onclick=()=>refresh(true);log.append(more);}
      log.scrollTop=top;
    }
    async function refresh(older=false){
      if(loading||dead)return;loading=true;refreshButton.disabled=true;log.setAttribute('aria-busy','true');failure.hidden=true;
      shell.querySelector('.fm-activity-more')?.setAttribute('disabled','');
      try{
        const [work,audit]=await Promise.all([root.PlatformAPI.work.activity(oid,{projectId:pid,limit:100,before:older?before:''}),older?{events:[]}:root.PlatformAPI.userActivity.listForProject(oid,pid,{limit:200})]);
        if(dead)return;
        // Keep previously loaded pages on polling; source namespaces prevent ID collisions.
        const next=[...(work.events||[]).map(e=>({...e,_source:'work'})),...(audit.events||[]).map(e=>({...e,_source:'audit'}))];
        events=[...new Map([...events,...next].map(e=>[e._source+':'+(e.id||[e.type,e.created_at,format(e)].join('|')),e])).values()].sort((a,b)=>timestamp(b)-timestamp(a));
        if(older||!loaded)before=work.events?.length===100?work.next_before || '':'';
        loaded=true;
      }catch(error){if(!dead){failure.textContent=(loaded?'Could not refresh activity. ':'Could not load activity. ')+(error.message || 'Try again.')+' Use Refresh to retry.';failure.hidden=false;}}
      finally{loading=false;if(!dead){refreshButton.disabled=false;log.setAttribute('aria-busy','false');render();if(!loaded){count.textContent='Unavailable';log.innerHTML='';}}}
    }
    search.oninput=filter.onchange=()=>{log.scrollTop=0;render();};refreshButton.onclick=()=>refresh();
    const onChange=()=>{if(visible)void refresh();};
    root.addEventListener('fm:project-notes:refreshed',onChange);root.addEventListener('fm:projects:refresh',onChange);
    const poll=setInterval(()=>{if(visible)void refresh();},30000);
    render();void refresh();
    return {refresh,setVisible(value){visible=!!value;},destroy(){dead=true;clearInterval(poll);root.removeEventListener('fm:project-notes:refreshed',onChange);root.removeEventListener('fm:projects:refresh',onChange);style.remove();shell.remove();}};
  }

  function mount(shell, options = {}) {
    const preview = options.content || shell.querySelector('.r-preview'), header = options.header || shell.querySelector('.r-modal-header') || shell.closest('.r-overlay')?.querySelector('.r-modal-header');
    if (!preview || !header) throw Error('Project shell content is unavailable.');
    const style = document.createElement('style');
    style.textContent = `.fm-project-tray-tabs{display:flex;justify-content:flex-end;gap:2px;flex:none;min-height:32px;background:white;border-bottom:1px solid #e4e7ec;padding-right:5px}.r-overlay.project-layout-prototype .r-window-bar:has(>.fm-project-tray-tabs){grid-template-columns:minmax(0,1fr) auto auto auto}.r-overlay.project-layout-prototype .r-window-bar>.fm-project-tray-tabs{grid-row:2;grid-column:4;align-self:stretch;border-bottom:0;min-height:0;padding:0 4px;background:#fff}.r-window-bar>.fm-project-tray-tabs{margin-left:auto;align-items:center}.fm-project-tray-tabs button{width:32px;height:30px;border:0;border-radius:5px;background:none;color:#667085;cursor:pointer}.fm-project-tray-tabs button[aria-selected=true]{background:var(--primary-light,#eef2ff);color:var(--primary,#175cd3)}.fm-project-content{display:grid;grid-template-columns:minmax(0,1fr) 0px;flex:1;min-height:0;position:relative;transition:grid-template-columns .32s cubic-bezier(.22,1,.36,1)}.fm-window[data-window=minimized]>.fm-project-content{display:none!important}.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) min(380px,45%)}.fm-project-content>.r-project-body,.fm-project-content>.r-preview{min-width:0;min-height:0;height:100%}.fm-project-tray{min-width:0;overflow:hidden;background:#fff;border-left:1px solid #e4e7ec;display:flex;flex-direction:column;opacity:0;transform:translateX(16px);transition:opacity .25s,transform .32s cubic-bezier(.22,1,.36,1)}[data-tray-open=true]>.fm-project-tray{opacity:1;transform:none}.fm-project-tray>header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e4e7ec;flex:none}.fm-project-tray>header[hidden]{display:none}.fm-project-tray button{cursor:pointer}.fm-project-tray-close{border:0;background:none;color:#667085;padding:5px}.fm-project-tray-panel{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}.fm-project-tray-panel[hidden]{display:none!important}@media(max-width:700px){.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray{position:absolute;inset:0 0 0 auto;width:min(100%,380px);z-index:70;box-shadow:-8px 0 24px #10182820}.fm-project-content:not([data-tray-open=true])>.fm-project-tray{visibility:hidden}}@media(prefers-reduced-motion:reduce){.fm-project-content,.fm-project-tray{transition:none}}`;
    document.head.append(style);
    const tabs = document.createElement('nav'); tabs.className = 'fm-project-tray-tabs'; tabs.setAttribute('aria-label','Project trays'); tabs.setAttribute('role','tablist'); header.append(tabs);
    const content = document.createElement('div'); content.className = 'fm-project-content'; preview.before(content); content.append(preview);
    const tray = document.createElement('aside'); tray.className = 'fm-project-tray'; tray.inert = true; tray.setAttribute('aria-hidden','true');
    tray.innerHTML = '<header><strong></strong><button type="button" class="fm-project-tray-close" aria-label="Close project tray"><i class="fas fa-xmark"></i></button></header>';
    content.append(tray);
    const pin = document.createElement('div'); pin.className='fm-project-agent-pin'; pin.hidden=true; tray.append(pin);
    const pinStyle=document.createElement('style');pinStyle.textContent=`.fm-project-agent-pin{height:100px;flex:0 0 100px;min-height:0;border-top:1px solid #e4e7ec}.fm-project-agent-pin[hidden]{display:none}.fm-project-content:has(>.fm-project-tray[data-pin-only=true]){grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray[data-pin-only=true]{position:absolute;right:0;bottom:0;top:auto;height:100px;width:min(380px,100%);z-index:70;justify-content:flex-end;background:transparent;border-left:0;pointer-events:none}.fm-project-tray[data-pin-only=true]>.fm-project-agent-pin{background:white;pointer-events:auto;border:1px solid #e4e7ec;border-radius:10px 0 0 0}.fma-pinned .fma-stage,.fma-pinned .fma-sidebar,.fma-pinned .fma-attachments,.fma-pinned [data-fma=history],.fma-pinned [data-fma=boardSide],.fma-pinned [data-fma=visualsToggle],.fma-pinned [data-fma=closeSurface]{display:none!important}.fma-pinned:not([data-voice=true]) .fma-head-title:empty::before{content:"Agent"}.fma-pinned .fma-head{min-height:32px;padding:4px 8px}.fma-pinned .fma-composer{padding:6px 8px}.fma-pinned .fma-body,.fma-pinned .fma-content{min-height:0}.fm-project-agent-close-menu{position:absolute;right:8px;top:4px;z-index:10000;background:white;border:1px solid #d0d5dd;border-radius:9px;padding:6px;box-shadow:0 8px 24px #10182830;display:flex;gap:6px}.fm-project-agent-close-menu button{padding:8px;border:0;border-radius:6px;background:#f2f4f7;color:#344054;cursor:pointer}.fm-project-agent-close-menu [role=status]{max-width:240px;font-size:12px}`;document.head.append(pinStyle);
    let agentState={voice:false,pending:false}, manualPin=false, closeMenu=null;
    const panels = new Map(), handles = new Map();
    let projectId = '', selected = '', disposed = false, activityTimer = 0, interactionVersion = 0;
    const oid = clean(options.orgId || root.__APP?.userOrgId);
    const getProject = () => options.getProject?.() || options.project || {};
    const available = () => definitions().map(item=>item.id);
    function close() {selected = ''; handles.forEach(handle=>handle.setVisible?.(false)); panels.forEach(node=>node.hidden=true); renderTabs(); syncAgentPin();}
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
      handles.forEach((handle,name)=>handle.setVisible?.(name===key));
      const node = panel(key); panels.forEach((value,name) => value.hidden = name !== key); renderTabs(); syncAgentPin();
      if (handles.has(key)) {if (key === 'activity') handles.get(key).refresh?.(); if (key === 'todo') handles.get(key).load?.({quiet:true})?.catch(()=>null); return;}
      if (!projectId && key !== 'notes') {node.textContent='Select or create a project to use '+registry.get(key).label.toLowerCase()+'.';return;}
      const mountingProject = projectId;
      try {
        const pending = {}; handles.set(key,pending);
        const handle = await mountWidget(node,key,{orgId:oid,projectId:mountingProject,getProject,ensureProject:options.ensureProject,
          agentOptions:{orgId:oid, projectId, onClose:close, openTray:key=>selected===key?Promise.resolve():open(key), onPin:()=>{if(selected==='agent'){manualPin=!manualPin;syncAgentPin();}else void open('agent');}, onState:state=>{agentState=state;queueMicrotask(syncAgentPin);}, getContext:()=>({surface:'project',projectId,trays:available(),tab:options.getActiveTab?.() || '',tray:selected || '',minimized:options.isMinimized?.() || false})}});
        if (disposed || mountingProject !== projectId || handles.get(key)!==pending) {handle.destroy?.();return;}
        handles.set(key,handle); handle.setVisible?.(selected===key);
        syncAgentPin();

      } catch (error) {if (!disposed && mountingProject === projectId) {tray.querySelector('header').hidden = false; handles.delete(key); node.textContent = error.message; const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.onclick = () => {selected = ''; open(key);}; node.append(retry);}}
    }
    function syncAgentPin(){
      if(disposed)return;
      const agent=handles.get('agent'), pinned=!!agent && selected!=='agent' && (manualPin || agentState.voice);
      pin.hidden=!pinned;
      if(agent){agent.moveTo?.(pinned?pin:panel('agent'));agent.setCompact?.(pinned);const toggle=(pinned?pin:panel('agent')).querySelector('[data-fma=pinSurface]');if(toggle){if(pinned)toggle.removeAttribute('aria-pressed');else toggle.setAttribute('aria-pressed',String(manualPin));}}
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
      if(!agentState.voice){closeMenu.querySelector('[data-end]').textContent='End agent';closeMenu.querySelector('[data-transfer]').textContent='Transfer to global agent';}
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
  root.FirstMateProjectTrays = {mount,definitions,register,mountWidget,registerWidgets};
  registerWidgets();
})(window);
