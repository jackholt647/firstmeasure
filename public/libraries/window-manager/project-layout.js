/* Project layout prototype. Each docked app retains its own document and local
 * content rail, preserving legacy app state without sharing singleton controls. */
(function(root){
  'use strict';
  if(root.FirstMateProjectLayout)return;
  // Development rollback flags: no user-facing configuration or persisted preference.
  const config=Object.freeze({enabled:true,splitTabs:true});
  const children=new Map();
  function styles(){
    if(document.getElementById('fm-project-layout-style'))return;
    const s=document.createElement('style');s.id='fm-project-layout-style';s.textContent=`
.r-overlay.project-layout-prototype .r-win{display:flex!important;flex-direction:column!important;padding-top:0!important}
.r-overlay.project-layout-prototype .r-window-bar{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto;grid-template-rows:36px 32px;height:68px;min-height:68px;flex:none;border-bottom:1px solid #e4e7ec}
.r-overlay.project-layout-prototype .r-window-identity{display:flex!important;grid-column:1 / -1;grid-row:1;max-width:none;border:0;padding:0 224px 0 16px;font-size:16px;font-weight:800;cursor:inherit}
.r-overlay.project-layout-prototype .r-window-bar-actions{position:absolute;top:0;right:0;width:auto;flex:none;border:0}
.r-overlay.project-layout-prototype .fm-window-controls{display:flex;gap:0;height:32px}
.r-overlay.project-layout-prototype .fm-window-controls button,.r-overlay.project-layout-prototype .fm-window-controls [data-window-action=close]{width:30px;height:32px;min-height:32px}
.r-overlay.project-layout-prototype .r-window-bar > .r-tabbar{grid-row:2;grid-column:1;min-width:0}
.r-overlay.project-layout-prototype .r-window-bar > .modal-shell-actions{grid-row:2;grid-column:3}
.r-overlay.project-layout-prototype .r-window-bar > .r-measure-tabs{grid-row:2;grid-column:2}
.r-overlay.project-layout-prototype .r-window-bar > .r-tabbar{align-self:stretch;border-bottom:1px solid #e4e7ec;overflow:hidden}
.r-overlay.project-layout-prototype .r-window-bar .r-tab{height:32px;min-height:32px;padding-top:4px;padding-bottom:4px}
.r-project-body{display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:auto;position:relative;background:#e4e7ec}
.r-project-main-pane{display:flex;flex:1 1 0;min-width:320px;min-height:0;position:relative;overflow:hidden;background:#fff}
.r-overlay.project-layout-prototype .r-project-main-pane > .r-right{flex:1 1 0!important;min-height:0!important;min-width:0;margin:0!important;width:auto!important;overflow:hidden}
.r-tab-content{display:flex;height:100%;min-height:0;min-width:0;overflow:hidden;background:#fff}
.r-tab-main{flex:1 1 0;min-width:0;min-height:0;position:relative;overflow:hidden}
.r-overlay.project-layout-prototype .r-tab-sidebar{flex:0 0 30%!important;min-width:150px;max-width:320px;height:100%;overflow:auto;padding:12px;border-right:1px solid #e4e7ec}
.r-overlay.project-layout-prototype .r-overview-details{display:flex;flex-direction:column;position:relative;inset:auto;transform:none;flex:0 0 34%;width:34%;min-width:260px;max-width:420px;height:100%;max-height:none;margin:0;padding:12px;overflow:hidden;border-right:1px solid #e4e7ec;box-shadow:none;z-index:auto}
.r-overlay.project-layout-prototype:not(.mobile-order) .r-overview-details .r-left-bottom{display:flex!important}
.r-overview-details .r-form{display:flex;flex:1;flex-direction:column;min-height:0}.r-overview-details .r-scroll{flex:1;min-height:0;overflow:auto}
@container project-body (max-width:760px){
 .r-overlay.project-layout-prototype [data-panel=map]>.r-tab-content{flex-direction:column;overflow:auto}
 .r-overlay.project-layout-prototype [data-panel=map]>.r-tab-content>.r-overview-details{width:100%;min-width:0;max-width:none;height:auto;flex:none;max-height:none;border-right:0;border-bottom:1px solid #e4e7ec;overflow:visible}
 .r-overlay.project-layout-prototype [data-panel=map] .r-overview-details .r-scroll{overflow:visible;flex:none}
 .r-overlay.project-layout-prototype [data-panel=map]>.r-tab-content>.r-tab-main{flex:1 0 360px;min-height:360px}
}
.r-overlay.project-layout-prototype.mobile-order [data-panel=map]>.r-tab-content{flex-direction:column;overflow:auto}
.r-overlay.project-layout-prototype.mobile-order [data-panel=map] .r-overview-details{width:100%;min-width:0;max-width:none;height:auto;flex:none;max-height:none;overflow:visible}
/* Later ordering pages own the remaining viewport; do not inherit Overview's content-height rail. */
.r-overlay.project-layout-prototype.mobile-order:not(.mobile-order-location) [data-panel=map]>.r-tab-content{overflow:hidden}
.r-overlay.project-layout-prototype.mobile-order:not(.mobile-order-location) [data-panel=map]>.r-tab-content>.r-overview-details{flex:1 1 0;height:100%;min-height:0;overflow:hidden;border:0}
.r-overlay.project-layout-prototype.mobile-order:not(.mobile-order-location) [data-panel=map] .r-overview-details .r-scroll{flex:1 1 0;min-height:0;overflow:auto}
.r-overlay.project-layout-prototype.mobile-order.ext-guiding [data-panel=map] .r-overview-details .r-scroll{display:flex;flex-direction:column;overflow:hidden}
.r-overlay.project-layout-prototype.mobile-order.mobile-order-location [data-panel=map]>.r-tab-content>.r-tab-main{display:block;flex:1 0 320px;min-height:320px}
.r-overlay.project-layout-prototype.mobile-order:not(.mobile-order-location) [data-panel=map]>.r-tab-content>.r-tab-main{display:none!important}
.r-overlay.project-layout-prototype .r-mobile-project-title,.r-overlay.project-layout-prototype .r-mobile-left-tray-scrim,.r-overlay.project-layout-prototype .r-mobile-default-info-tray-scrim{display:none!important}
.r-project-docked-pane{display:flex;flex:1 1 0;min-width:320px;min-height:0;position:relative;overflow:hidden;background:#fff}
.r-project-docked-pane iframe{display:block;border:0;width:100%;height:100%;min-width:0}
.r-project-pane-status{position:absolute;inset:0;display:grid;place-content:center;gap:12px;background:#fff;color:#667085;font:13px Arial,sans-serif;text-align:center}
.r-project-pane-status[hidden]{display:none}.r-project-pane-status button{padding:8px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;cursor:pointer}
.r-project-divider{flex:0 0 6px;width:6px;min-height:0;padding:0;border:0;background:#d0d5dd;cursor:col-resize;touch-action:none;position:relative}
.r-project-divider:hover,.r-project-divider:focus-visible{background:#98a2b3;outline:2px solid #344054;outline-offset:-2px}
.r-project-body.resizing iframe{pointer-events:none}.r-project-body.resizing{user-select:none}
.r-overlay.project-layout-prototype .r-tab[data-pane-open]{background:#fff;color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -3px 0 var(--primary,#d93025)}
@keyframes project-tab-menu-open{from{opacity:0;transform:translateY(-4px) scale(.96)}to{opacity:1;transform:none}}
.r-project-tab-menu{position:fixed;z-index:2147483647;display:flex;gap:4px;padding:5px;background:#fff;border:1px solid #d0d5dd;border-radius:8px;box-shadow:0 8px 30px #10182826;animation:project-tab-menu-open .14s ease-out}
.r-project-tab-menu button{display:grid;place-items:center;width:36px;height:32px;border:0;border-radius:4px;padding:6px;background:none;color:#344054;cursor:pointer}.r-project-tab-menu button:hover,.r-project-tab-menu button:focus{background:#f2f4f7}.r-project-tab-menu svg{width:22px;height:18px}
@media(prefers-reduced-motion:reduce){.r-project-tab-menu{animation:none}}
html.project-content-pane .r-overlay.project-layout-prototype .r-window-bar{display:none!important}
html.project-content-pane .r-project-main-pane{min-width:0}
.r-overlay.project-layout-prototype .r-win[data-window=minimized] > .r-window-bar{display:flex!important;height:30px;min-height:30px}
.r-overlay.project-layout-prototype .r-win[data-window=minimized] > .r-project-body{display:none!important}
.r-overlay.project-layout-prototype .r-win[data-window=minimized] .r-window-identity{padding:0;flex:1;font-size:12px}
.r-overlay.project-layout-prototype .r-win[data-window=minimized] .r-window-bar-actions{position:static}
.r-overlay.project-layout-prototype .r-win[data-window=minimized] .fm-window-controls{height:28px}
html.project-content-pane .r-overlay.project-layout-prototype .r-contact-contextbar{display:none!important}
`;document.head.append(s);
  }
  function mount({overlay,getProject,getTab,setTab,pane=false}){
    if(!config.enabled||overlay.__projectLayout)return overlay.__projectLayout;
    styles();const win=overlay.querySelector('.r-win'),header=win.querySelector('.r-window-bar'),right=win.querySelector('.r-right'),tabs=header.querySelector('.r-tabbar');
    const body=document.createElement('div');body.className='r-project-body';
    const main=document.createElement('div');main.className='r-project-main-pane';main.dataset.projectPane='main';
    win.insertBefore(header,win.firstChild);win.append(body);body.append(main);main.append(right);
    overlay.classList.add('project-layout-prototype');if(pane)document.documentElement.classList.add('project-content-pane');
    let order=[{element:main,main:true,weight:1}],dividers=[],menu=null,disposed=false;let focused=order[0];
    const current=()=>String(getTab()||'');
    const tabButton=id=>[...tabs.querySelectorAll('[data-tab]')].find(el=>el.dataset.tab===id);
    const tabLabel=id=>tabButton(id)?.getAttribute('aria-label')||id;
    const find=id=>order.find(p=>p.main?current()===id:p.tab===id);
    const closeMenu=()=>{menu?.remove();menu=null;};
    function updateSelection(){
      for(const button of tabs.querySelectorAll('[data-tab]')){const open=!!find(button.dataset.tab);if(open)button.dataset.paneOpen='true';else delete button.dataset.paneOpen;}
    }
    function arrange(){
      dividers.forEach(el=>el.remove());dividers=[];
      order.forEach((item,i)=>{item.element.style.order=String(i*2);item.element.style.flex=`${item.weight} 1 0px`;if(i===order.length-1)return;
        const divider=document.createElement('div');divider.className='r-project-divider';divider.tabIndex=0;divider.role='separator';divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-label','Resize panes; double-click to swap');divider.setAttribute('aria-valuemin','15');divider.setAttribute('aria-valuemax','85');divider.setAttribute('aria-valuenow',String(Math.round(100*item.weight/(item.weight+order[i+1].weight))));divider.style.order=String(i*2+1);body.append(divider);dividers.push(divider);
        const resize=ratio=>{const total=item.weight+order[i+1].weight;ratio=Math.max(.15,Math.min(.85,ratio));item.weight=total*ratio;order[i+1].weight=total*(1-ratio);item.element.style.flex=`${item.weight} 1 0px`;order[i+1].element.style.flex=`${order[i+1].weight} 1 0px`;divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));root.dispatchEvent(new Event('resize'));};
        divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);const a=item.element.getBoundingClientRect(),b=order[i+1].element.getBoundingClientRect(),start=e.clientX,width=a.width+b.width,ratio=a.width/width;body.classList.add('resizing');divider.onpointermove=ev=>resize(ratio+(ev.clientX-start)/width);const end=()=>{body.classList.remove('resizing');divider.onpointermove=null;};divider.onpointerup=end;divider.onpointercancel=end;divider.onlostpointercapture=end;};
        const swap=()=>{const a=order[i],b=order[i+1];[a.weight,b.weight]=[b.weight,a.weight];[order[i],order[i+1]]=[b,a];arrange();};divider.ondblclick=swap;divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();resize(item.weight/(item.weight+order[i+1].weight)+(e.key==='ArrowLeft'?-.05:.05));}else if(e.key==='Enter'){e.preventDefault();swap();}};
      });updateSelection();root.dispatchEvent(new Event('resize'));
    }
    function remove(item){if(!item||item.main)return;item.closed=true;if(focused===item)focused=order.find(p=>p!==item);children.delete(item.token);clearTimeout(item.timer);item.element.remove();order=order.filter(p=>p!==item);arrange();}
    function dock(id,side){
      if(!getProject()||!tabButton(id)||tabButton(id).disabled)return;
      let item=find(id);
      if(!item){
        const token=crypto.randomUUID(),element=document.createElement('section'),frame=document.createElement('iframe'),status=document.createElement('div'),message=document.createElement('span'),close=document.createElement('button');
        element.className='r-project-docked-pane';element.dataset.projectPane=id;frame.name='fm-project-pane:'+token;frame.title=tabLabel(id);frame.setAttribute('allow','clipboard-write; microphone; camera; fullscreen');status.className='r-project-pane-status';message.textContent='Opening '+tabLabel(id)+'…';close.type='button';close.textContent='Close pane';status.append(message,close);element.append(frame,status);body.append(element);
        item={token,tab:id,element,frame,status,project:getProject(),weight:1,changed:updateSelection,focus:()=>{focused=item;},remove:()=>remove(item)};close.onclick=e=>{e.preventDefault();e.stopPropagation();item.remove();};element.addEventListener('pointerdown',()=>{focused=item;});children.set(token,item);order.push(item);
        const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('projectPane',token);frame.src=url.href;
        item.timer=setTimeout(()=>{message.textContent='This pane is taking longer to load. You can close it and try again.';},45000);
      }
      order=order.filter(p=>p!==item);side==='left'?order.unshift(item):order.push(item);arrange();
    }
    function onContext(e){
      const button=e.target.closest('[data-tab]');if(!button||!tabs.contains(button)||button.disabled||!config.splitTabs||pane)return;
      e.preventDefault();e.stopPropagation();closeMenu();menu=document.createElement('div');menu.className='r-project-tab-menu';menu.role='menu';
      const options=[['Dock left','left',()=>dock(button.dataset.tab,'left')],['Dock right','right',()=>dock(button.dataset.tab,'right')]];
      const existing=find(button.dataset.tab);if(existing&&!existing.main)options.push(['Close pane','close',()=>remove(existing)]);
      for(const [label,icon,fn] of options){
        const option=document.createElement('button');option.type='button';option.role='menuitem';option.title=label;option.setAttribute('aria-label',label);
        option.innerHTML=icon==='close'?'<svg viewBox="0 0 24 20" aria-hidden="true"><path d="m6 4 12 12M18 4 6 16" fill="none" stroke="currentColor" stroke-width="2"/></svg>':`<svg viewBox="0 0 24 20" aria-hidden="true"><rect x="2" y="2" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v16" stroke="currentColor"/><rect x="${icon==='left'?4:14}" y="4" width="6" height="12" rx="1" fill="currentColor"/></svg>`;
        option.onclick=()=>{fn();closeMenu();button.focus();};menu.append(option);
      }
      document.body.append(menu);const rect=button.getBoundingClientRect();menu.style.left=Math.max(4,Math.min(rect.x+(rect.width-menu.offsetWidth)/2,innerWidth-menu.offsetWidth-4))+'px';menu.style.top=Math.max(4,Math.min(rect.bottom+7,innerHeight-menu.offsetHeight-4))+'px';menu.querySelector('button').focus();
    }
    function click(e){
      const button=e.target.closest('[data-tab]');if(!button||!tabs.contains(button)||button.disabled||pane)return;
      const existing=find(button.dataset.tab);
      if(existing){focused=existing;if(!existing.main){e.preventDefault();e.stopImmediatePropagation();existing.frame.focus();}return;}
      if(!focused?.main){e.preventDefault();e.stopImmediatePropagation();focused.tab=button.dataset.tab;focused.frame.title=tabLabel(focused.tab);focused.element.dataset.projectPane=focused.tab;updateSelection();openTab(focused);}
    }
    main.addEventListener('pointerdown',()=>{focused=order.find(p=>p.main);});
    const outside=e=>{if(menu&&!menu.contains(e.target))closeMenu();};const key=e=>{if(e.key==='Escape'&&menu){e.stopImmediatePropagation();closeMenu();}};
    tabs.addEventListener('contextmenu',onContext,true);tabs.addEventListener('click',click,true);document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);
    const observer=new MutationObserver(()=>{if(!disposed)updateSelection();});observer.observe(tabs,{childList:true,subtree:true});
    function refresh(){if(disposed)return;if(pane)root.parent.FirstMateProjectLayout?.tabChanged(root.name.slice(16),root,current());updateSelection();}
    const available=()=>[...tabs.querySelectorAll('[data-tab]')].filter(button=>!button.disabled&&!button.hidden).map(button=>button.dataset.tab);
    function apply(panes){
      const next=root.FirstMateWindowShell.normalizePanes(panes,available());
      if(next.length>1&&!getProject())throw Error('Split panes require a project.');
      const mainTab=next.some(p=>p.tab===current())?current():next[0].tab;
      for(const item of [...order])if(!item.main&&(!next.some(p=>p.tab===item.tab)||item.tab===mainTab))remove(item);
      if(current()!==mainTab)setTab(mainTab);
      for(const spec of next)if(spec.tab!==mainTab&&!find(spec.tab))dock(spec.tab,'right');
      order=next.map(spec=>{const item=find(spec.tab);item.weight=spec.weight;return item;});
      focused=order[0];arrange();
    }
    const api={refresh,dock,apply,available,get state(){return order.map(p=>({tab:p.main?current():p.tab,weight:p.weight}));},clear(){for(const item of [...order])if(!item.main)remove(item);focused=order[0];},destroy(){api.clear();disposed=true;observer.disconnect();tabs.removeEventListener('contextmenu',onContext,true);tabs.removeEventListener('click',click,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);closeMenu();},get panes(){return order.map(p=>p.main?current():p.tab)}};
    overlay.__projectLayout=api;refresh();return api;
  }
  function accepts(token,child){return children.get(token)?.frame.contentWindow===child;}
  // Opening the shell is synchronous; hydration may continue in the background.
  // Never cover a rendered shell while waiting for unrelated project requests.
  function openTab(item){
    if(!item.api||item.closed)return;
    const tab=item.tab,version=item.version=(item.version||0)+1;
    Promise.resolve().then(()=>item.api.openProject(item.project,{tab,fromRoute:false})).then(()=>{
      if(item.closed||item.version!==version)return;
      item.ready=true;clearTimeout(item.timer);item.status.hidden=true;
      if(item.tab!==tab)openTab(item);
    }).catch(()=>{
      if(item.closed||item.version!==version)return;
      clearTimeout(item.timer);item.status.querySelector('span').textContent='Unable to open this tab. Close the pane and try again.';
    });
  }
  function ready(token,child,api){
    const item=children.get(token);if(!item||!accepts(token,child)||item.api)return;
    item.api=api;child.document.addEventListener('pointerdown',()=>{item.focus();item.element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));},true);openTab(item);
  }
  function attach(token,child){
    const item=children.get(token);if(!item||!accepts(token,child))throw Error('Unknown project pane');
    return {state:{mode:'full'},setVisible(visible){if(visible&&!item.closed){clearTimeout(item.timer);item.status.hidden=true;}},setMode(){},restore(){},focus(){},destroy(){}};
  }
  root.FirstMateProjectLayout={config,mount,accepts,ready,attach,async openContact(token,child,contact,options){if(!accepts(token,child))throw Error('Unknown project pane');await root.Portal.modules.request.openContact(contact,options);},update(){},tabChanged(token,child,tab){const item=children.get(token);if(!item?.ready||!accepts(token,child)||!tab||item.tab===tab)return;item.tab=tab;item.changed();},closed(token){children.get(token)?.remove();}};
})(window);
