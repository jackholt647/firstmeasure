/* Project shell trays. Domain behavior belongs to ProjectNotes, Channels,
 * PlatformAssistant and the existing activity APIs; this owns only placement. */
(function(root) {
  'use strict';
  if (root.FirstMateProjectTrays) return;
  const clean = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Resolved against this script; an inline copy on an opaque page (about:blank) falls back to a relative path.
  const activityScriptUrl=(()=>{const path='activity-presenter.js?v=20261012-notes-separation-v1';try{return new URL(path,document.currentScript?.src || location.href).href;}catch(_){return path;}})();
  let activityPromise;
  function activityPresenter(){
    if(root.FirstMateActivity)return Promise.resolve(root.FirstMateActivity);
    return activityPromise ||= new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=activityScriptUrl;
      script.onload=()=>{if(root.FirstMateActivity)resolve(root.FirstMateActivity);else{activityPromise=null;script.remove();reject(Error('Activity descriptions are unavailable.'));}};
      script.onerror=()=>{activityPromise=null;script.remove();reject(Error('Activity descriptions could not be loaded.'));};document.head.append(script);
    });
  }
  // Trays that open on a draft project. Messages needs a stored project channel.
  const draftTrays = new Set(['todo','activity','agent']);
  const registry = new Map([
    ['notes',{id:'notes',label:'Notes',icon:'fa-note-sticky',capability:'channels.project_notes'}],
    ['todo',{id:'todo',label:'To Do',icon:'fa-list-check'}],
    ['messages',{id:'messages',label:'Messages',icon:'fa-comments',capability:'channels.project_messages_tray'}],
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
    // A new project that is not saved yet (a draft) opens every built-in tray; the
    // tray saves it through options.ensureProject only when the person acts.
    const draft=!pid && typeof options.ensureProject==='function' && draftTrays.has(key);
    if (!pid && key!=='notes' && !draft) throw Error('Select or create a project to use '+definition.label.toLowerCase()+'.');
    node.style.cssText='height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden';
    const getProject=options.getProject || (()=>({id:pid}));
    if (key==='notes') return root.Portal.ProjectNotes.mount(node,{project:getProject(),getProject,ensureProject:options.ensureProject});
    if (key==='todo') {
      if (!root.PlatformActionItems?.renderTodayList) throw Error('Project to-dos are not available.');
      const project=getProject();node.style.padding='12px';
      const controller=root.PlatformActionItems.renderTodayList(node,{orgId:oid,projectId:pid,ensureProject:draft?options.ensureProject:undefined,
        branchId:root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default',
        userId:clean(root.__APP?.userId || root.__APP?.user_id),
        projectTitle:clean(project.title || project.customer_name || project.address || 'Project'),
        projectAddress:clean(project.address || project.project_address),completedOpen:false,futureOpen:false,
        dockDeferredSections:true,scrollItemsOnly:true,showProjectContext:false,showUpcoming:true,showFuture:true,
        query:{includeFuture:true,includeAll:true}});
      return {...controller,adoptProject:(id,project)=>controller.adoptProject?.({...(project||{}),id,platform_project_id:id})};
    }
    if (key==='agent') return root.PlatformAssistant.mountProject(node,{orgId:oid,projectId:pid,...options.agentOptions,...(draft?{ensureProject:options.ensureProject}:{})});
    if (key==='activity') return mountActivity(node,oid,pid,getProject);
    if (key==='messages') {
      const data=await root.ChannelsAPI.channels.ensureProject(oid,pid);
      return root.FirstMateChannels.create(node,{orgId:oid,context:{channelId:data.channel.id},mode:'embedded',features:{resources:false}});
    }
    return definition.mount?.(node,{getProject,projectId:pid,orgId:oid});
  }
  function mountActivity(node,oid,pid,getProject=()=>({id:pid})) {
    // A draft project has no activity yet: show the empty timeline until it is saved.
    let loaded=!pid;
    let events=[],before='',loading=false,dead=false,visible=true,lastMarkup='',updateTimer=0,refreshQueued=false;
    let presenter,activityContext;
    const selectedTypes=new Set();
    const expandedNotes=new Set(),notePrefix='fm-activity-note-'+Math.random().toString(36).slice(2)+'-';
    const style=document.createElement('style');
    style.textContent=`
      .fm-activity-widget{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;font-size:11px;color:#202124;background:#fff}
      .fm-project-activity-tools{flex:none;padding:9px 12px;border-bottom:1px solid #eef0f3;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px}
      .fm-activity-search{display:flex;min-width:0;align-items:center;gap:7px;border:1px solid #e4e7ec;border-radius:6px;padding:0 8px;color:#98a2b3}
      .fm-activity-search input{font:inherit;font-size:11px;border:0;background:transparent;min-width:0;width:100%;height:30px;outline:none;color:#202124}
      .fm-activity-search:focus-within{outline:2px solid var(--primary,#175cd3);outline-offset:1px}
      .fm-activity-filter-toggle{display:flex;align-items:center;gap:6px;font:inherit;font-size:11px;max-width:120px;min-width:0;height:32px;border:1px solid transparent;background:#f5f6f8;border-radius:5px;padding:5px 8px;color:#475467;cursor:pointer}.fm-activity-filter-toggle span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.fm-activity-filter-toggle[data-active=true]{color:var(--primary,#175cd3);background:var(--primary-light,#eef2ff)}
      .fm-activity-filter-menu{position:absolute;left:12px;right:12px;z-index:20;display:flex;flex-direction:column;overflow:hidden;background:white;border:1px solid #e4e7ec;border-radius:8px;box-shadow:0 8px 24px #10182824;padding:6px}.fm-activity-filter-menu[hidden]{display:none}
      .fm-activity-filter-menu input[type=search]{flex:none;box-sizing:border-box;width:100%;min-width:0;border:0;border-bottom:1px solid #eef0f3;background:white;padding:8px;font:inherit;font-size:11px;color:#344054;border-radius:0}
      .fm-activity-filter-options{min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 0}.fm-activity-filter-option{display:flex;align-items:center;border-radius:5px;min-height:32px}.fm-activity-filter-option[hidden]{display:none}.fm-activity-filter-option:hover,.fm-activity-filter-option:focus-within{background:#f5f6f8}.fm-activity-filter-option[data-selected=true]{background:var(--primary-light,#eef2ff)}
      .fm-activity-filter-option label{display:flex;flex:1;align-items:center;min-width:0;gap:7px;padding:7px 6px;cursor:pointer;font-size:11px}.fm-activity-filter-option input{width:13px;height:13px;margin:0;accent-color:var(--primary,#175cd3);flex:none}.fm-activity-filter-option label>i{width:13px;text-align:center;color:#667085}.fm-activity-filter-total{margin-left:auto;color:#98a2b3;font-size:10px;font-variant-numeric:tabular-nums}
      .fm-activity-filter-only{font:inherit;font-size:10px;border:0;background:transparent;color:#667085;padding:6px;cursor:pointer}.fm-activity-filter-only:hover{color:var(--primary,#175cd3)}.fm-activity-filter-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 4px 2px;border-top:1px solid #eef0f3;color:#667085;font-size:10px}.fm-activity-filter-footer button{font:inherit;color:var(--primary,#175cd3);border:0;background:transparent;cursor:pointer;padding:4px}.fm-activity-filter-none{padding:12px 6px;font-size:11px;color:#667085}.fm-activity-filter-none[hidden]{display:none}
      .fm-activity-widget button:focus-visible,.fm-activity-widget input:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}
      .fm-project-activity{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:0 12px 12px}
      .fm-activity-day{position:sticky;top:0;z-index:1;margin:0;background:#fff;padding:13px 0 8px;font-size:10.5px;font-weight:700;color:#667085;border-bottom:1px solid #f2f4f7}
      .fm-project-activity article{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;position:relative;padding:11px 0}
      .fm-project-activity article:not(:last-child):before{content:'';position:absolute;left:11px;top:34px;bottom:-10px;width:1px;background:#e9ecf1}
      .fm-activity-icon{position:relative;z-index:0;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#f2f4f7;color:#667085;font-size:10px}
      .fm-project-activity p{margin:0;line-height:1.55;overflow-wrap:anywhere;font-size:11px}.fm-activity-meta{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:4px;font-size:10px;color:#98a2b3}.fm-activity-meta time{font-size:10px;color:#667085}
      .fm-project-activity p strong{font-weight:700}.fm-activity-actor{font:inherit;color:inherit;border:0;background:none;padding:0;text-align:left;cursor:pointer}.fm-activity-actor:hover,.fm-activity-actor:focus-visible{color:var(--primary,#175cd3);text-decoration:underline}
      .fm-project-activity .fm-activity-note{margin-top:4px;font-weight:400;white-space:pre-wrap}.fm-activity-note-more{display:inline;color:var(--primary,#175cd3);font:inherit;font-size:10px;text-decoration:underline;cursor:pointer}.fm-activity-note-more:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}
      .fm-activity-empty{text-align:center;padding:38px 14px;color:#667085;line-height:1.6;animation:fm-activity-in .24s ease-out}@keyframes fm-activity-in{from{opacity:0;transform:translateY(4px)}}@media(prefers-reduced-motion:reduce){.fm-activity-empty{animation:none}}.fm-activity-empty i{display:block;font-size:20px;color:#98a2b3;margin-bottom:12px}.fm-activity-empty strong{display:block;font-size:12px;color:#344054;margin-bottom:4px}
      .fm-activity-error{flex:none;margin:8px 12px 0;border-radius:6px;padding:8px;color:#b42318;background:#fff4f2;line-height:1.5}.fm-activity-error[hidden]{display:none}
      .fm-activity-more{width:100%;font:inherit;font-size:11px;color:#475467;border:1px solid #e4e7ec;background:#fff;padding:8px;border-radius:6px;margin-top:10px;cursor:pointer}.fm-activity-widget button:disabled{opacity:.45;cursor:wait}
    `;
    node.append(style);
    const shell=document.createElement('section');shell.className='fm-activity-widget';shell.setAttribute('aria-label','Project activity');
    shell.innerHTML='<div class="fm-project-activity-tools"><label class="fm-activity-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" aria-label="Search activity" placeholder="Search activity…"></label><button type="button" class="fm-activity-filter-toggle" aria-label="Filter activity: All activity" aria-haspopup="dialog" aria-expanded="false"><i class="fas fa-filter" aria-hidden="true"></i><span>All activity</span><i class="fas fa-chevron-down" aria-hidden="true"></i></button></div><div class="fm-activity-error" role="alert" hidden></div><div class="fm-project-activity" role="log" aria-label="Activity timeline" aria-live="off"></div>';
    node.append(shell);
    const log=shell.querySelector('[role=log]'),search=shell.querySelector('input'),filter=shell.querySelector('.fm-activity-filter-toggle'),failure=shell.querySelector('[role=alert]');
    const kind=event=>clean(event.type || event.data?.type);
    const categories={project:['Project changes','fa-pen'],tasks:['To-dos','fa-check'],notes:['Notes','fa-note-sticky'],schedule:['Scheduling','fa-calendar'],reports:['Reports & measurements','fa-ruler-combined'],files:['Files & photos','fa-image'],documents:['Documents & signatures','fa-file-signature'],scope:['Scope & materials','fa-layer-group'],payments:['Payments & billing','fa-credit-card'],contacts:['Contacts & people','fa-user-group'],communications:['Calls & communications','fa-phone'],workflow:['Workflow & stages','fa-diagram-project'],field:['Field work & checklists','fa-clipboard-check']};
    const category=event=>{
      if(presenter)return presenter.describe(event,activityContext).category;
      const type=kind(event).toLowerCase();
      if(/note/.test(type))return 'notes';
      if(/action[._]item|task|todo/.test(type))return 'tasks';
      if(/payment|invoice|receipt|expense|payroll|billing/.test(type))return 'payments';
      if(/schedule|appointment|booking|project[._]event/.test(type))return 'schedule';
      if(/report|measurement/.test(type))return 'reports';
      if(/document|proposal|signature|contract/.test(type))return 'documents';
      if(/scope|material|list[._]item/.test(type))return 'scope';
      if(/file|photo|upload|attachment/.test(type))return 'files';
      if(/contact|member|assignee|assignment|collaborator/.test(type))return 'contacts';
      if(/call|communication|email|sms|comment|mention/.test(type))return 'communications';
      if(/crew|checklist|punch_list|field|inspection/.test(type))return 'field';
      if(/^work[._]|stage|status/.test(type))return 'workflow';
      return 'project';
    };
    const menu=document.createElement('div');menu.className='fm-activity-filter-menu';menu.hidden=true;menu.setAttribute('role','dialog');menu.setAttribute('aria-label','Activity filters');
    menu.id='fm-activity-filter-'+Math.random().toString(36).slice(2);filter.setAttribute('aria-controls',menu.id);
    menu.innerHTML='<input type="search" aria-label="Find activity types" placeholder="Find activity types…"><div class="fm-activity-filter-options" role="group" aria-label="Activity types"></div><div class="fm-activity-filter-footer"><span>Choose one or more types</span><button type="button">All activity</button></div>';
    shell.append(menu);
    const typeSearch=menu.querySelector('input'),optionsList=menu.querySelector('[role=group]'),allButton=menu.querySelector('button'),typeRows=new Map();
    for(const [key,[label,icon]] of Object.entries(categories)){
      const row=document.createElement('div');row.className='fm-activity-filter-option';
      row.innerHTML=`<label><input type="checkbox" aria-label="${label}"><i class="fas ${icon}" aria-hidden="true"></i><span>${label}</span><span class="fm-activity-filter-total" aria-hidden="true">0</span></label><button type="button" class="fm-activity-filter-only" aria-label="Only ${label}">Only</button>`;
      const checkbox=row.querySelector('input');checkbox.onchange=()=>{if(checkbox.checked)selectedTypes.add(key);else selectedTypes.delete(key);applyTypes();};
      row.querySelector('button').onclick=()=>{selectedTypes.clear();selectedTypes.add(key);applyTypes();};
      typeRows.set(key,row);optionsList.append(row);
    }
    const noTypes=document.createElement('div');noTypes.className='fm-activity-filter-none';noTypes.textContent='No matching activity types.';noTypes.hidden=true;optionsList.append(noTypes);
    function applyTypes(){if(selectedTypes.size===Object.keys(categories).length)selectedTypes.clear();log.scrollTop=0;render();}
    function syncTypes(rows){
      const labels=[...selectedTypes].map(key=>categories[key][0]),summary=labels.length>1?labels[0]+' +'+(labels.length-1):labels[0] || 'All activity';
      filter.querySelector('span').textContent=summary;filter.dataset.active=String(!!labels.length);filter.setAttribute('aria-label','Filter activity: '+(labels.join(', ') || 'All activity'));filter.title=labels.join(', ') || 'All activity';
      allButton.setAttribute('aria-pressed',String(!labels.length));
      const totals={};for(const event of rows){const key=category(event);totals[key]=(totals[key]||0)+1;}
      for(const [key,row]of typeRows){row.dataset.selected=String(selectedTypes.has(key));row.querySelector('input').checked=selectedTypes.has(key);row.querySelector('.fm-activity-filter-total').textContent=String(totals[key]||0);}
    }
    function positionMenu(){if(menu.hidden)return;const top=filter.getBoundingClientRect().bottom-shell.getBoundingClientRect().top+5;menu.style.top=top+'px';menu.style.maxHeight=Math.max(0,Math.min(390,shell.clientHeight-top-8))+'px';}
    function closeFilter(restoreFocus=false){menu.hidden=true;filter.setAttribute('aria-expanded','false');if(restoreFocus)filter.focus();}
    function openFilter(){menu.hidden=false;filter.setAttribute('aria-expanded','true');typeSearch.value='';typeSearch.oninput();positionMenu();typeSearch.focus();}
    filter.onclick=()=>menu.hidden?openFilter():closeFilter();filter.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();openFilter();}};
    menu.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeFilter(true);}};
    menu.onfocusout=event=>{if(event.relatedTarget&&!menu.contains(event.relatedTarget)&&event.relatedTarget!==filter)closeFilter();};
    typeSearch.oninput=()=>{const query=typeSearch.value.trim().toLocaleLowerCase();let matches=0;for(const [key,row]of typeRows){row.hidden=!categories[key][0].toLocaleLowerCase().includes(query);if(!row.hidden)matches++;}noTypes.hidden=!!matches;};
    allButton.onclick=()=>{selectedTypes.clear();applyTypes();};
    const outside=event=>{if(!menu.hidden&&!menu.contains(event.target)&&!filter.contains(event.target))closeFilter();};
    const ownerDocument=node.ownerDocument;ownerDocument.addEventListener('pointerdown',outside,true);
    const menuResize=new ResizeObserver(positionMenu);menuResize.observe(shell);
    const timestamp=event=>Date.parse(event.created_at || event.data?.created_at) || 0;
    const format=event=>{
      if(presenter)return presenter.describe(event,activityContext).text;
      const data=event.data || event,payload=event.payload || {};
      const verbs={created:'added a note',edited:'edited a note',deleted:'removed a note',restored:'restored a note',pinned:'pinned a note',unpinned:'unpinned a note',shared:'shared a note'};
      if(kind(event).startsWith('project.note.'))return `${payload.actor_name || 'A teammate'} ${verbs[kind(event).split('.').pop()] || 'updated a note'}`;
      const text=clean(data.summary || data.description || data.title || payload.summary || payload.description) || kind(event).replace(/[._]/g,' ') || 'Project updated';
      return text.charAt(0).toUpperCase()+text.slice(1);
    };
    const actor=event=>presenter?presenter.describe(event,activityContext).actor.name:clean(event.payload?.actor_name || event.data?.actor_name || event.actor_name || event.actor?.name);
    function dayLabel(date){const today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);return date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString([], {month:'short',day:'numeric',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'});}
    function render(){
      if(dead)return;
      const top=log.scrollTop,query=search.value.trim().toLocaleLowerCase();
      const displayed=presenter?presenter.groupUploads(presenter.withNotes(events,activityContext),activityContext):events;
      const matching=displayed.filter(event=>!kind(event).startsWith('channels.message.')&&!/^(message|note)_(added|created|sent)$/.test(kind(event)))
        .filter(event=>!query||(format(event)+' '+actor(event)).toLocaleLowerCase().includes(query));
      syncTypes(matching);
      const rows=matching.filter(event=>!selectedTypes.size||selectedTypes.has(category(event)));
      let group='';
      const markup=rows.map(event=>{
        const presentation=presenter?.describe(event,activityContext),at=presentation?Date.parse(presentation.timestamp)||0:timestamp(event);
        const date=new Date(at),valid=!!at,day=valid?dayLabel(date):'Earlier activity',heading=day!==group?`<h3 class="fm-activity-day">${esc(day)}</h3>`:'';group=day;
        const [label,icon]=categories[category(event)],name=actor(event),summary=format(event),user=presentation?.actor;
        const preview=user?.id?` data-fm-summary-type="summary.user" data-fm-summary-target="${esc(JSON.stringify({scope:'organization',organizationId:oid,id:user.id}))}"`:'';
        const isNote=presentation?.category==='notes',key=event._source+':'+event.id;
        const description=`<strong>${esc(presentation?.headline||summary)}</strong>${presentation?.suffix?` ${esc(presentation.suffix)}`:''}${presentation?.detail&&!isNote?` — ${esc(presentation.detail)}`:''}`;
        const noteText=isNote?presentation.detail:'',characters=Array.from(noteText),long=characters.length>140,expanded=expandedNotes.has(key),noteId=notePrefix+encodeURIComponent(key);
        const noteHtml=noteText?`<p class="fm-activity-note" id="${esc(noteId)}">${esc(long&&!expanded?characters.slice(0,140).join('').trimEnd()+'…':noteText)}</p>${long?`<a class="fm-activity-note-more" href="#${esc(noteId)}" data-activity-note="${esc(key)}" aria-expanded="${expanded}" aria-controls="${esc(noteId)}">${expanded?'See less':'See more'}</a>`:''}`:'';
        const actorHtml=user?.id?`<button type="button" class="fm-activity-actor"${preview} aria-label="Preview ${esc(name||'team member')}">${esc(name||'Team member')}</button>`:name?`<span>${esc(name)}</span>`:'';
        return `${heading}<article><span class="fm-activity-icon"><i class="fas ${icon}" aria-hidden="true"></i></span><div><p>${description}</p>${noteHtml}<div class="fm-activity-meta">${actorHtml?`${actorHtml}<span aria-hidden="true">·</span>`:''}<span>${label}</span>${valid?`<span aria-hidden="true">·</span><time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))}</time>`:''}</div></div></article>`;
      }).join('') || `<div class="fm-activity-empty"><i class="fas ${loaded?'fa-clock-rotate-left':'fa-spinner'}" aria-hidden="true"></i><strong>${loaded?(query||selectedTypes.size?'No matching activity':'No activity yet'):'Loading activity…'}</strong>${loaded?(query||selectedTypes.size?'Try another search or activity type.':'Project updates will appear here as work progresses.'):''}</div>`;
      if(markup!==lastMarkup){log.innerHTML=markup;lastMarkup=markup;}
      if(before){let more=log.querySelector('.fm-activity-more');if(!more){more=document.createElement('button');more.type='button';more.className='fm-activity-more';more.textContent='Load older activity';more.onclick=()=>refresh(true);log.append(more);}more.disabled=loading;}else log.querySelector('.fm-activity-more')?.remove();
      log.scrollTop=top;
    }
    async function refresh(older=false){
      if(dead||!pid)return;if(loading){if(!older)refreshQueued=true;return;}loading=true;log.setAttribute('aria-busy','true');failure.hidden=true;
      shell.querySelector('.fm-activity-more')?.setAttribute('disabled','');
      try{
        presenter=await activityPresenter();activityContext ||= presenter.context();
        const [work,audit]=await Promise.all([root.PlatformAPI.work.activity(oid,{projectId:pid,limit:100,before:older?before:''}),older?{events:[]}:root.PlatformAPI.userActivity.listForProject(oid,pid,{limit:200})]);
        if(dead)return;
        // Keep previously loaded pages on polling; source namespaces prevent ID collisions.
        const next=[...(work.events||[]).map(e=>({...e,_source:'work'})),...(audit.events||[]).map(e=>({...e,_source:'audit'}))];
        const merged=[...new Map([...events,...next].map(e=>[e._source+':'+(e.id||[e.type,e.created_at,format(e)].join('|')),e])).values()];
        await presenter.hydrate(activityContext,merged,{platform:root.PlatformAPI,documents:root.DocumentsAPI,materials:root.MaterialsAPI,communications:root.CommunicationsAPI,channels:root.ChannelsAPI,projectNotes:root.Portal?.ProjectNotes},oid,pid,getProject());
        if(dead)return;
        events=presenter.merge(merged);
        if(older||!loaded)before=work.events?.length===100?work.next_before || '':'';
        loaded=true;
      }catch(error){if(!dead){failure.textContent=(loaded?'Could not update activity. ':'Could not load activity. ')+(error.message || '')+' Retrying automatically.';failure.hidden=false;}}
      finally{loading=false;if(!dead){log.setAttribute('aria-busy','false');render();if(refreshQueued){refreshQueued=false;scheduleUpdate();}}}
    }
    search.oninput=()=>{log.scrollTop=0;render();};
    log.addEventListener('click',event=>{
      const link=event.target.closest?.('a[data-activity-note]');if(!link)return;event.preventDefault();
      const key=link.dataset.activityNote;if(expandedNotes.has(key))expandedNotes.delete(key);else expandedNotes.add(key);
      render();Array.from(log.querySelectorAll('a[data-activity-note]')).find(a=>a.dataset.activityNote===key)?.focus({preventScroll:true});
    });
    function scheduleUpdate(){if(!visible||dead)return;clearTimeout(updateTimer);updateTimer=setTimeout(()=>{if(!dead&&visible)void refresh();},250);}
    const onChange=event=>{if(pid&&(!event?.detail?.projectId||event.detail.projectId===pid))scheduleUpdate();};
    root.addEventListener('fm:project-notes:refreshed',onChange);root.addEventListener('fm:projects:refresh',onChange);
    const stopRealtime=root.PlatformRealtime?.subscribe?.(oid,'',event=>{
      const payload=event.payload||{},project=payload.project_id||payload.projectId||payload.context?.project_id;
      if(pid&&(!project||project===pid)&&/^(work|channels|documents|payments|materials|communication|messaging|platform\.(project|media|activity))\./.test(event.topic||''))scheduleUpdate();
    },{onResync:scheduleUpdate});
    const poll=setInterval(()=>{if(visible)void refresh();},30000);
    render();void refresh();
    function adoptProject(id){
      const next=clean(id);if(dead||pid||!next)return;
      pid=next;loaded=false;render();void refresh();
    }
    return {refresh,adoptProject,setVisible(value){const changed=visible!==!!value;visible=!!value;if(!visible)closeFilter();else if(changed)scheduleUpdate();},destroy(){dead=true;stopRealtime?.();clearTimeout(updateTimer);menuResize.disconnect();ownerDocument.removeEventListener('pointerdown',outside,true);clearInterval(poll);root.removeEventListener('fm:project-notes:refreshed',onChange);root.removeEventListener('fm:projects:refresh',onChange);style.remove();shell.remove();}};
  }

  // The phone agent bar: the assistant's input bar sliding up from the bottom, its conversation folded above it
  // behind a Conversation control, under an edge in the organization's colours. The project window's Agent tray
  // and the portal's top bar on phones (portal/scripts/topbar.js) both use it. `host` positions the bar and carries
  // data-agent-compact and data-tray-open; `bar` is what slides; `panel` holds the assistant's drawer.
  function agentBarCss({host,bar,panel}) {
    const H=host+'[data-agent-compact=true]',B=bar+':not([data-pin-only=true])',C=bar+'[data-agent-compact=true]';
    return `.fm-project-agent-history{display:none}
${H}>${B}{position:absolute;inset:auto 0 0 0;width:auto;height:auto;max-height:calc(100% - 8px);z-index:70;border-left:0;background:#fff;border-radius:18px 18px 0 0;box-shadow:0 -12px 34px #10182830,0 -1px 0 #10182814;overflow:hidden;opacity:0;visibility:hidden;transform:translateY(calc(100% + 18px));transition:transform .44s cubic-bezier(.4,0,.2,1),opacity .34s ease .06s,visibility 0s linear .44s}
${H}[data-tray-open=true]>${B}{opacity:1;visibility:visible;transform:none;transition:transform .44s cubic-bezier(.16,1,.3,1),opacity .2s ease}
${H}>${B}::before{content:'';position:absolute;z-index:3;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--primary,#175cd3),var(--secondary,var(--primary,#175cd3)),var(--primary,#175cd3),var(--secondary,var(--primary,#175cd3)),var(--primary,#175cd3));background-size:200% 100%;animation:fmAgentEdge 5s linear infinite;pointer-events:none}
${C}>${panel}{flex:0 0 auto;overflow:visible}
${C}>${panel}>*{height:auto!important;flex:0 0 auto!important;overflow:visible!important}
${C} .fma-drawer.fma-embedded{height:auto;flex:0 0 auto}
${C} .fma-drawer .fma-body{flex:0 0 auto}${C} .fma-content{flex:1 1 auto;min-width:0}
${C} .fma-stage{flex:0 0 auto;height:0;overflow:hidden;transition:height .36s cubic-bezier(.16,1,.3,1)}
${C}[data-agent-history=open] .fma-stage{height:min(52vh,460px);border-bottom:1px solid #eef0f3}
${C} :is(.fma-sidebar,.fma-thread-bar,[data-fma=history],[data-fma=visualsToggle],[data-fma=boardSide]){display:none!important}
${C}:not([data-agent-history=open]) .gx-faqs-wrap{display:none!important}
${C} .fma-head{min-height:44px;padding:7px 8px 3px 16px;border-bottom:0;gap:6px}
${C} .fma-tray-identity{display:flex;align-items:center;gap:7px;font-weight:650;font-size:14px;color:#101828}
${C} .fma-tray-identity>i{color:var(--primary-readable,var(--primary,#175cd3))}
${C}:not([data-voice=true]) .fma-head-title:empty::before{content:"Agent"}
${C} .fma-composer{padding:4px 10px calc(12px + var(--fm-safe-bottom,env(safe-area-inset-bottom,0px)));border-top:0}
${C} .fm-project-agent-history{display:inline-flex;align-items:center;gap:6px;position:relative;margin-left:auto;height:30px;padding:0 11px;border:0;border-radius:999px;background:#f2f4f7;color:#344054;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.fm-project-agent-history i{font-size:11px;transition:transform .3s cubic-bezier(.16,1,.3,1)}
.fm-project-agent-history[aria-expanded=true] i{transform:rotate(180deg)}
.fm-project-agent-history[data-face=working]{color:var(--primary-readable,var(--primary,#175cd3));background:rgba(var(--primary-rgb,23,92,211),.1)}
.fm-project-agent-history[data-unread=true]::after{content:'';position:absolute;top:3px;right:3px;width:8px;height:8px;border-radius:50%;background:var(--primary,#175cd3);box-shadow:0 0 0 2px #fff}
.fm-project-agent-history:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}
${C} [data-fma=closeSurface]{width:34px;height:34px;border-radius:10px}
@keyframes fmAgentEdge{to{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){${H}>${bar},${C} .fma-stage{transition:none!important}${H}>${bar}::before{animation:none!important}}`;
  }
  // The bar's state: whether the conversation is unfolded, and a request asked from the folded bar (which shows
  // Working, then unfolds when the answer arrives; the assistant reports turns through its surface's onTurn).
  // `sync` is the host's own sync, which ends by calling update(bar,{open,voice}).
  function createAgentBar({drawer,sync}) {
    let open=false, history=false, unread=false, folded=false;
    function scrollHistory(){const msgs=drawer()?.querySelector('[data-fma=msgs]');if(msgs)msgs.scrollTop=msgs.scrollHeight;}
    function setHistory(value){history=!!value;if(history)unread=false;sync();if(history)setTimeout(scrollHistory,40);}
    function turn(phase){
      if(phase==='sent'){folded=open && !history;sync();return;}
      if(phase!=='done' || !folded)return;
      folded=false;sync();
      // The person asked from the bar alone: show the answer (and any confirmation it asks for).
      if(open && !history)setHistory(true);else if(!open){unread=true;sync();}
    }
    function update(element,{open:next,voice}){
      // Every opening starts folded.
      if(next && !open)history=false;
      open=!!next;
      element.dataset.agentHistory=open && history?'open':'closed';
      element.dataset.voice=String(!!voice);
      const head=drawer()?.querySelector('.fma-head');
      if(!head)return;
      let button=head.querySelector('.fm-project-agent-history');
      if(!button){
        button=document.createElement('button');button.type='button';button.className='fm-project-agent-history';
        button.onclick=()=>setHistory(!history);
        head.insertBefore(button,head.querySelector('[data-fma=closeSurface]'));
      }
      // While a request asked from the folded bar runs, the control says so; the answer unfolds it.
      const working=folded && !history, face=working?'working':'idle';
      if(button.dataset.face!==face){button.dataset.face=face;button.innerHTML=working?'<span>Working</span><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>':'<span>Conversation</span><i class="fas fa-chevron-up" aria-hidden="true"></i>';}
      button.setAttribute('aria-expanded',String(open && history));
      button.setAttribute('aria-label',history?'Hide conversation':'Show conversation');
      button.dataset.unread=String(unread && !history);
    }
    return {update,turn,setHistory,isOpen:()=>open};
  }

  function mount(shell, options = {}) {
    const preview = options.content || shell.querySelector('.r-preview'), header = options.header || shell.querySelector('.r-modal-header') || shell.closest('.r-overlay')?.querySelector('.r-modal-header');
    if (!preview || !header) throw Error('Project shell content is unavailable.');
    const style = document.createElement('style');
    style.textContent = `.fm-project-tray-tabs{display:flex;justify-content:flex-end;gap:2px;flex:none;min-height:32px;background:white;border-bottom:1px solid #e4e7ec;padding-right:5px}.r-overlay.project-layout-prototype .r-window-bar:has(>.fm-project-tray-tabs){grid-template-columns:minmax(0,1fr) auto auto auto}.r-overlay.project-layout-prototype .r-window-bar>.fm-project-tray-tabs{grid-row:2;grid-column:4;align-self:stretch;border-bottom:0;min-height:0;padding:0 4px;background:#fff}.r-window-bar>.fm-project-tray-tabs{margin-left:auto;align-items:center}.fm-project-tray-tabs button{width:32px;height:30px;border:0;border-radius:5px;background:none;color:#667085;cursor:pointer}.fm-project-tray-tabs button[aria-selected=true]{background:var(--primary-light,#eef2ff);color:var(--primary,#175cd3)}.fm-project-content{display:grid;grid-template-columns:minmax(0,1fr) 0px;flex:1;min-height:0;position:relative;transition:grid-template-columns .32s cubic-bezier(.22,1,.36,1)}.fm-window[data-window=minimized]>.fm-project-content{display:none!important}.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) min(380px,45%)}.fm-project-content>.r-project-body,.fm-project-content>.r-preview{min-width:0;min-height:0;height:100%}.fm-project-tray{min-width:0;overflow:hidden;background:#fff;border-left:1px solid #e4e7ec;display:flex;flex-direction:column;opacity:0;transform:translateX(16px);transition:opacity .25s,transform .32s cubic-bezier(.22,1,.36,1)}[data-tray-open=true]>.fm-project-tray{opacity:1;transform:none}.fm-project-tray>header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e4e7ec;flex:none}.fm-project-tray>header[hidden]{display:none}.fm-project-tray button{cursor:pointer}.fm-project-tray-close{border:0;background:none;color:#667085;padding:5px}.fm-project-tray-panel{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}.fm-project-tray-panel[hidden]{display:none!important}@media(max-width:700px){.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray{position:absolute;inset:0 0 0 auto;width:min(100%,380px);z-index:70;box-shadow:-8px 0 24px #10182820}.fm-project-content:not([data-tray-open=true])>.fm-project-tray{visibility:hidden}}[data-window-mobile=true] .fm-project-content>.fm-project-tray{width:100%;border-left:0;box-shadow:none;transform:translateY(12px)}[data-window-mobile=true] .fm-project-content[data-tray-open=true]>.fm-project-tray{transform:none}@media(prefers-reduced-motion:reduce){.fm-project-content,.fm-project-tray{transition:none}}`;
    document.head.append(style);
    const tabs = document.createElement('nav'); tabs.className = 'fm-project-tray-tabs'; tabs.setAttribute('aria-label','Project trays'); tabs.setAttribute('role','tablist');
    // Where the tray buttons live in the header; on a phone they move to a footer bar under the window.
    const tabsAnchor = document.createComment('project trays'); header.append(tabsAnchor); tabsAnchor.after(tabs);
    const content = document.createElement('div'); content.className = 'fm-project-content'; preview.before(content); content.append(preview);
    const scrim = document.createElement('div'); scrim.className = 'fm-project-tray-scrim'; scrim.setAttribute('aria-hidden','true'); content.append(scrim);
    const tray = document.createElement('aside'); tray.className = 'fm-project-tray'; tray.inert = true; tray.setAttribute('aria-hidden','true');
    tray.innerHTML = '<header><strong></strong><button type="button" class="fm-project-tray-close" aria-label="Close project tray"><i class="fas fa-xmark"></i></button></header>';
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'fm-project-tray-grip'; tray.prepend(grip);
    content.append(tray);
    const pin = document.createElement('div'); pin.className='fm-project-agent-pin'; pin.hidden=true; tray.append(pin);
    const pinStyle=document.createElement('style');pinStyle.textContent=`.fm-project-agent-pin{height:100px;flex:0 0 100px;min-height:0;border-top:1px solid #e4e7ec}.fm-project-agent-pin[hidden]{display:none}.fm-project-content:has(>.fm-project-tray[data-pin-only=true]){grid-template-columns:minmax(0,1fr) 0px}.fm-project-tray[data-pin-only=true]{position:absolute;right:0;bottom:0;top:auto;height:100px;width:min(380px,100%);z-index:70;justify-content:flex-end;background:transparent;border-left:0;pointer-events:none}.fm-project-tray[data-pin-only=true]>.fm-project-agent-pin{background:white;pointer-events:auto;border:1px solid #e4e7ec;border-radius:10px 0 0 0}.fma-pinned .fma-stage,.fma-pinned .fma-sidebar,.fma-pinned .fma-attachments,.fma-pinned [data-fma=history],.fma-pinned [data-fma=boardSide],.fma-pinned [data-fma=visualsToggle],.fma-pinned [data-fma=closeSurface]{display:none!important}.fma-pinned:not([data-voice=true]) .fma-head-title:empty::before{content:"Agent"}.fma-pinned .fma-head{min-height:32px;padding:4px 8px}.fma-pinned .fma-composer{padding:6px 8px}.fma-pinned .fma-body,.fma-pinned .fma-content{min-height:0}.fm-project-agent-close-menu{position:absolute;right:8px;top:4px;z-index:10000;background:white;border:1px solid #d0d5dd;border-radius:9px;padding:6px;box-shadow:0 8px 24px #10182830;display:flex;gap:6px}.fm-project-agent-close-menu button{padding:8px;border:0;border-radius:6px;background:#f2f4f7;color:#344054;cursor:pointer}.fm-project-agent-close-menu [role=status]{max-width:240px;font-size:12px}`;document.head.append(pinStyle);
    let agentState={voice:false,pending:false}, manualPin=false, closeMenu=null;
    const panels = new Map(), handles = new Map();
    let projectId = '', selected = '', disposed = false, activityTimer = 0, interactionVersion = 0;
    const oid = clean(options.orgId || root.__APP?.userOrgId);
    const getProject = () => options.getProject?.() || options.project || {};
    // Saving a draft from any tray switches every open tray to the new project.
    let draftSave = null;
    const ensureProject = typeof options.ensureProject === 'function' ? () => (draftSave ||= Promise.resolve().then(() => options.ensureProject()).then(project => {if (!disposed) update(); return project;}).finally(() => {draftSave = null;})) : undefined;
    const available = () => definitions().map(item=>item.id);
    // On a phone a closing tray keeps its panel showing while it slides away (`lingering`).
    let lingering = '', lingerTimer = 0;
    const reducedMotion = () => {try {return root.matchMedia('(prefers-reduced-motion: reduce)').matches;} catch (_) {return false;}};
    function close() {
      const was = selected; selected = ''; handles.forEach(handle=>handle.setVisible?.(false));
      clearTimeout(lingerTimer); lingering = '';
      // A voice call pins the agent instead, so its bar has nothing left to slide away.
      const pins = was === 'agent' && handles.has('agent') && (manualPin || agentState.voice);
      if (was && panels.has(was) && trayPhone() && !pins && !reducedMotion()) {
        lingering = was;
        lingerTimer = setTimeout(() => {if (disposed || selected) return; lingering = ''; panels.forEach(node=>node.hidden=true); setSheetSize(''); syncAgentPin();}, 460);
      }
      panels.forEach((node,key)=>node.hidden=key!==lingering); renderTabs(); syncAgentPin();
    }
    function renderTabs() {
      const allowed = definitions().map(item=>[item.id,item.label,item.icon]);
      if (selected && !allowed.some(([key]) => key === selected)) close();
      tabs.innerHTML = allowed.map(([key,title,icon]) => `<button type="button" role="tab" data-tray="${key}" aria-label="${title}" title="${title}" aria-selected="${selected === key}"><i class="fas ${icon}" aria-hidden="true"></i><span class="fm-tray-label" aria-hidden="true">${esc(title)}</span></button>`).join('');
    }
    // A phone (the window manager's data-window-mobile, else a 760px top-window query) has no
    // header room for the trays: the same buttons, from the same list, become a footer bar
    // along the bottom of the window, under the app, and trays open above it.
    const trayPhone=()=>{const flag=header.dataset.windowMobile;if(flag)return flag==='true';try{return root.top.matchMedia('(max-width: 760px)').matches;}catch(_){return root.matchMedia('(max-width: 760px)').matches;}};
    function syncPlacement() {
      if (disposed) return;
      const phone = trayPhone();
      if (phone) {if (tabs.previousElementSibling !== content) content.after(tabs); tabs.dataset.placement = 'footer';}
      else {if (tabsAnchor.parentNode && tabsAnchor.nextSibling !== tabs) tabsAnchor.after(tabs); delete tabs.dataset.placement;}
      content.dataset.phone = String(phone);
    }
    syncPlacement();
    const placementObserver = new MutationObserver(() => {syncPlacement(); syncAgentPin();});
    placementObserver.observe(header,{attributes:true,attributeFilter:['data-window-mobile']});
    function panel(key) {
      if (!panels.has(key)) { const node = document.createElement('div'); node.className = 'fm-project-tray-panel'; node.hidden = true; node.setAttribute('role','tabpanel'); node.setAttribute('aria-label',registry.get(key).label); tray.insertBefore(node,pin); panels.set(key,node); }
      return panels.get(key);
    }
    async function open(key) {
      update(); if (!available().includes(key)) throw Error('Unavailable project tray: '+key);
      if (selected === key) {close(); return;}
      clearTimeout(lingerTimer); if (lingering && lingering !== key) setSheetSize(''); lingering = '';
      selected = key; content.dataset.trayOpen = 'true'; tray.inert = false; tray.setAttribute('aria-hidden','false');
      tray.querySelector('header').hidden = key === 'agent';
      tray.querySelector('strong').textContent = registry.get(key).label;
      handles.forEach((handle,name)=>handle.setVisible?.(name===key));
      const node = panel(key); panels.forEach((value,name) => value.hidden = name !== key); renderTabs(); syncAgentPin();
      if (handles.has(key)) {if (key === 'activity') handles.get(key).refresh?.(); if (key === 'todo') handles.get(key).load?.({quiet:true})?.catch(()=>null); return;}
      if (!projectId && key !== 'notes' && !(ensureProject && draftTrays.has(key))) {node.textContent='Select or create a project to use '+registry.get(key).label.toLowerCase()+'.';return;}
      const mountingProject = projectId;
      try {
        const pending = {}; handles.set(key,pending);
        const handle = await mountWidget(node,key,{orgId:oid,projectId:mountingProject,getProject,ensureProject,
          agentOptions:{orgId:oid, projectId, onClose:close, openTray:key=>selected===key?Promise.resolve():open(key), onState:state=>{agentState=state;queueMicrotask(syncAgentPin);}, onTurn:agentTurn, getContext:()=>({surface:'project',projectId,trays:available(),tab:options.getActiveTab?.() || '',tray:selected || '',minimized:options.isMinimized?.() || false})}});
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
      const shown=selected || lingering;
      tray.querySelector('header').hidden=!shown || shown==='agent';
      root.dispatchEvent(new CustomEvent('fm:project-agent:state',{detail:{...agentState,pinned:manualPin || agentState.voice}}));
      agent?.setWorkspaceContext?.();
      syncAgentCompact();
    }
    // On a phone the agent is not a full tray: the same assistant (same conversation, voice
    // and auto-pin) slides up from the bottom as its input bar, with the conversation folded
    // above it. Desktop never sets data-agent-compact, so none of this applies there.
    let agentResize=0;
    const agentBar=createAgentBar({drawer:agentDrawer,sync:syncAgentCompact});
    // Phone footer bar and bottom sheets. Colours are the organization's (--primary/--secondary).
    const phoneStyle=document.createElement('style');
    phoneStyle.textContent=`.fm-project-tray-grip,.fm-project-tray-scrim{display:none}
.fm-project-tray-tabs[data-placement=footer]{position:relative;z-index:75;display:flex;align-items:stretch;justify-content:space-around;flex:none;gap:0;min-height:0;height:auto;margin:0;padding:0 6px env(safe-area-inset-bottom,0px);background:#fff;border:0;border-top:1px solid #e4e7ec;box-shadow:0 -1px 2px #1018280a}
.fm-project-tray-tabs[data-placement=footer]:empty,.fm-window[data-window=minimized]>.fm-project-tray-tabs[data-placement=footer]{display:none!important}
.fm-project-tray-tabs[data-placement=footer]>button{position:relative;display:flex;flex:1 1 0;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0;max-width:112px;width:auto;height:52px;margin:0;padding:5px 2px 4px;border:0;border-radius:0;background:none;color:#667085;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:color .18s ease}
.fm-project-tray-tabs[data-placement=footer]>button>i{display:grid;place-items:center;width:48px;height:26px;border-radius:999px;font-size:16px;line-height:1;transition:background .2s ease,color .2s ease,box-shadow .2s ease,transform .12s ease}
.fm-project-tray-tabs[data-placement=footer]>button:active>i{transform:scale(.94)}
.fm-project-tray-tabs[data-placement=footer] .fm-tray-label{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:13px;font-weight:600;letter-spacing:0}
.fm-project-tray-tabs[data-placement=footer]>button[aria-selected=true]{color:var(--primary-readable,var(--primary,#175cd3))}
.fm-project-tray-tabs[data-placement=footer]>button[aria-selected=true]>i{background:rgba(var(--primary-rgb,23,92,211),.13)}
.fm-project-tray-tabs[data-placement=footer]>button:focus-visible{outline:none}.fm-project-tray-tabs[data-placement=footer]>button:focus-visible>i{outline:2px solid var(--primary,#175cd3);outline-offset:1px}
.fm-project-tray-tabs[data-placement=footer][data-agent-compact=true]>button[data-tray=agent][aria-selected=true]>i{color:var(--on-primary,#fff);background:linear-gradient(135deg,var(--primary,#175cd3),var(--secondary,var(--primary,#175cd3)));box-shadow:0 0 0 3px rgba(var(--primary-rgb,23,92,211),.16),0 3px 12px rgba(var(--primary-rgb,23,92,211),.38);animation:fmAgentGlow 2.6s ease-in-out infinite}
.fm-project-content[data-phone=true]:has(+.fm-project-tray-tabs[data-placement=footer]:not(:empty)){--fm-safe-bottom:0px}
.fm-project-content[data-tray-mode=sheet]{grid-template-columns:minmax(0,1fr) 0px!important}
.fm-project-content[data-tray-mode=sheet]>.fm-project-tray-scrim{display:block;position:absolute;inset:0;z-index:71;background:rgba(16,24,40,.3);opacity:0;pointer-events:none;transition:opacity .3s ease}
.fm-project-content[data-tray-mode=sheet][data-tray-open=true]>.fm-project-tray-scrim{opacity:1;pointer-events:auto}
.fm-project-content.fm-project-content[data-tray-mode=sheet]>.fm-project-tray:not([data-pin-only=true]){position:absolute;inset:auto 0 0 0;width:auto;height:var(--fm-sheet-px,var(--fm-sheet-height,62%));max-height:calc(100% - 12px);z-index:72;border:0;border-radius:18px 18px 0 0;background:#fff;box-shadow:0 -12px 34px #10182833,0 -1px 0 #10182814;overflow:hidden;opacity:1;visibility:hidden;transform:translateY(calc(100% + 24px));transition:transform .38s cubic-bezier(.4,0,.2,1),height .34s cubic-bezier(.16,1,.3,1),visibility 0s linear .38s}
.fm-project-content.fm-project-content[data-tray-mode=sheet][data-tray-open=true]>.fm-project-tray:not([data-pin-only=true]){visibility:visible;transform:translateY(var(--fm-sheet-drag,0px));transition:transform .42s cubic-bezier(.16,1,.3,1),height .34s cubic-bezier(.16,1,.3,1)}
.fm-project-tray[data-sheet-size=full]{--fm-sheet-height:calc(100% - 12px)}
.fm-project-content.fm-project-content[data-tray-mode=sheet]>.fm-project-tray[data-dragging=true]{transition:none!important}
.fm-project-content[data-tray-mode=sheet]>.fm-project-tray>.fm-project-tray-grip{display:block;position:relative;flex:none;width:100%;height:22px;margin:0;padding:0;border:0;background:none;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent}
.fm-project-tray-grip::before{content:'';position:absolute;left:50%;top:9px;width:40px;height:5px;margin-left:-20px;border-radius:999px;background:#d0d5dd;transition:background .16s ease}
.fm-project-tray-grip:focus-visible{outline:none}.fm-project-tray-grip:focus-visible::before,.fm-project-tray[data-dragging=true]>.fm-project-tray-grip::before{background:var(--primary,#175cd3)}
.fm-project-content[data-tray-mode=sheet]>.fm-project-tray>header{padding:0 10px 8px 16px;touch-action:none;cursor:grab}
.fm-project-content[data-tray-mode=sheet]>.fm-project-tray>header strong{font-size:15px;color:#101828}
.fm-project-content[data-tray-mode=sheet] .fm-project-tray-close{display:grid;place-items:center;width:34px;height:34px;padding:0;border-radius:10px;background:#f2f4f7;font-size:15px}
@media(prefers-reduced-motion:reduce){.fm-project-content.fm-project-content[data-tray-mode=sheet]>.fm-project-tray,.fm-project-tray-scrim{transition:none!important}.fm-project-tray-tabs[data-placement=footer]>button>i{animation:none!important;transition:none}}`;
    document.head.append(phoneStyle);
    let drag=null, dragEnded=0;
    const T=(key,fallback)=>globalThis.PlatformLanguage?.text?.('project-trays',key,fallback) ?? fallback;
    const sheetOpen=()=>content.dataset.trayMode==='sheet' && !!selected;
    function syncGrip(){const full=tray.dataset.sheetSize==='full';grip.setAttribute('aria-label',full?T('tray_sheet_shrink','Shrink tray'):T('tray_sheet_expand','Expand tray'));grip.setAttribute('aria-expanded',String(full));}
    function setSheetSize(size){if(size==='full')tray.dataset.sheetSize='full';else delete tray.dataset.sheetSize;syncGrip();}
    // The handle is also a button (tap or keyboard) that toggles the height; the click that ends a drag is not a tap.
    grip.onclick=()=>{if(sheetOpen() && Date.now()-dragEnded>400)setSheetSize(tray.dataset.sheetSize==='full'?'':'full');};
    // Drag the grip or the sheet's title: down puts it away, up makes it taller.
    tray.addEventListener('pointerdown',event=>{
      if(!sheetOpen() || event.button>0 || !event.target.closest?.('.fm-project-tray-grip,.fm-project-tray>header') || event.target.closest('.fm-project-tray-close'))return;
      drag={id:event.pointerId,y:event.clientY,height:tray.getBoundingClientRect().height,max:content.getBoundingClientRect().height-12,dy:0,speed:0,last:[event.clientY,event.timeStamp],moved:false};
      // The pointer leaves the handle as soon as it moves up, so the document follows it.
      document.addEventListener('pointermove',moveDrag,{passive:false});document.addEventListener('pointerup',endDrag);document.addEventListener('pointercancel',endDrag);
    });
    function moveDrag(event){
      if(!drag || event.pointerId!==drag.id)return;
      const dy=event.clientY-drag.y;
      if(!drag.moved){if(Math.abs(dy)<6)return;drag.moved=true;tray.dataset.dragging='true';}
      drag.speed=(event.clientY-drag.last[0])/Math.max(1,event.timeStamp-drag.last[1]);drag.last=[event.clientY,event.timeStamp];drag.dy=dy;
      if(dy>=0){tray.style.setProperty('--fm-sheet-drag',dy+'px');tray.style.removeProperty('--fm-sheet-px');}
      else{tray.style.removeProperty('--fm-sheet-drag');tray.style.setProperty('--fm-sheet-px',Math.min(drag.max,drag.height-dy)+'px');}
      event.preventDefault();
    }
    function endDrag(event){
      if(!drag || event.pointerId!==drag.id)return;
      document.removeEventListener('pointermove',moveDrag);document.removeEventListener('pointerup',endDrag);document.removeEventListener('pointercancel',endDrag);
      const d=drag;drag=null;if(!d.moved)return;
      dragEnded=Date.now();
      delete tray.dataset.dragging;tray.style.removeProperty('--fm-sheet-drag');tray.style.removeProperty('--fm-sheet-px');
      if(event.type==='pointercancel')return;
      const full=tray.dataset.sheetSize==='full';
      if(d.dy>0 && (d.speed>.6 || d.dy>(full?d.height*.55:Math.min(140,d.height*.3)))){interactionVersion++;close();return;}
      if(d.dy>70 && full){setSheetSize('');return;}
      if(d.dy<0)setSheetSize(full || d.height-d.dy>(d.height+d.max)/2?'full':'');
    }
    scrim.onclick=()=>{interactionVersion++;close();};
    syncGrip();
    const agentStyle=document.createElement('style');
    // The bar itself is shared with the portal's phone top bar (agentBarCss, createAgentBar); the grid column,
    // the footer button's glow and which tray shows stay here.
    agentStyle.textContent=`.fm-project-content[data-agent-compact=true]{grid-template-columns:minmax(0,1fr) 0px!important}
${agentBarCss({host:'.fm-project-content',bar:'.fm-project-tray',panel:'.fm-project-tray-panel'})}
@keyframes fmAgentGlow{0%,100%{box-shadow:0 0 0 3px rgba(var(--primary-rgb,23,92,211),.16),0 3px 12px rgba(var(--primary-rgb,23,92,211),.38)}50%{box-shadow:0 0 0 5px rgba(var(--primary-rgb,23,92,211),.1),0 3px 18px rgba(var(--primary-rgb,23,92,211),.55)}}`;
    document.head.append(agentStyle);
    function agentDrawer(){return handles.has('agent') ? panels.get('agent')?.querySelector('.fma-drawer') : null;}
    function agentTurn(phase){agentBar.turn(phase);}
    function syncAgentCompact(){
      if(disposed)return;
      const phone=trayPhone(), open=phone && selected==='agent';
      // Kept after closing so the bar slides back down; another tray (or a wider screen) clears it.
      const compact=phone && (open || (!selected && content.dataset.agentCompact==='true'));
      content.dataset.agentCompact=tray.dataset.agentCompact=String(compact);
      tabs.dataset.agentCompact=String(open);
      // A phone's other trays are bottom sheets over the app; one shows at a time.
      const shown=selected || lingering;
      if(phone && !compact && shown!=='agent')content.dataset.trayMode='sheet';else delete content.dataset.trayMode;
      agentBar.update(tray,{open,voice:agentState.voice});
    }
    const agentViewport=()=>{cancelAnimationFrame(agentResize);agentResize=requestAnimationFrame(()=>{if(!disposed){syncPlacement();syncAgentCompact();}});};
    root.addEventListener('resize',agentViewport);
    const agentCleanup=()=>{cancelAnimationFrame(agentResize);clearTimeout(lingerTimer);drag=null;document.removeEventListener('pointermove',moveDrag);document.removeEventListener('pointerup',endDrag);document.removeEventListener('pointercancel',endDrag);placementObserver.disconnect();root.removeEventListener('resize',agentViewport);agentStyle.remove();phoneStyle.remove();scrim.remove();};
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
        // A saved draft keeps every tray that can adopt the project (what the
        // person typed stays put); others are mounted again for the project.
        const keeps = (handle,key) => adoptingDraft && (key === 'notes' || typeof handle?.adoptProject === 'function');
        const kept = new Set([...handles].filter(([key,handle]) => keeps(handle,key)).map(([key]) => key));
        handles.forEach((handle,key) => {if (!kept.has(key)) {handle.destroy?.();handles.delete(key);}});
        panels.forEach((node,key) => {if (!kept.has(key)) {node.remove();panels.delete(key);}});
        projectId = next;
        if (!kept.has('agent')) {agentState={voice:false,pending:false};manualPin=false;}
        if (adoptingDraft) {
          handles.get('notes')?.refresh?.();
          kept.forEach(key => {if (key !== 'notes') handles.get(key).adoptProject(next,getProject());});
          if (previousSelection && !kept.has(previousSelection)) {selected='';void open(previousSelection);}
          else syncAgentPin();
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
    return {requestClose,update,close,open,available,interactionVersion:()=>interactionVersion,select(key){if(key===null){close();return;}if(!available().includes(key))throw Error('Unavailable project tray: '+key);update();return selected===key?Promise.resolve():open(key);},destroy() {disposed = true;agentCleanup();root.removeEventListener('fm:route-state:updated',contextChanged);root.removeEventListener('fm:project-window:placement',contextChanged);closeMenu?.remove();pinStyle.remove();clearTimeout(activityTimer);handles.forEach(handle => handle.destroy?.());root.removeEventListener('fm:project-trays:updated',changed); root.removeEventListener('fm:capabilities:updated',changed);root.removeEventListener('fm:project-notes:refreshed',activityChanged);root.removeEventListener('fm:projects:refresh',activityChanged);content.before(preview);content.remove();tabs.remove();tabsAnchor.remove();style.remove();}};
  }
  root.FirstMateProjectTrays = {mount,definitions,register,mountWidget,registerWidgets};
  root.FirstMateAgentBar = {css:agentBarCss,create:createAgentBar};
  registerWidgets();
})(window);
