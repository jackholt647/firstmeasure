/* Declarative content contract shared by entity windows. Domain renderers retain
 * their nodes, state and authorization; this module only owns presentation. */
(function(root){
  'use strict';
  if(root.FirstMateWindowShell)return;
  function styles(){
    if(document.getElementById('fm-window-shell-style'))return;
    const style=document.createElement('style');style.id='fm-window-shell-style';
    style.textContent=`
.fm-entity-window .fm-shell-identity{display:flex!important;align-items:center;gap:8px;min-width:0;font-size:16px!important;font-weight:800!important;padding-left:16px!important;overflow:hidden}
.fm-shell-identity>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-entity-window .fm-shell-header{position:relative;flex:none;background:#fff;color:#101828;border-bottom:1px solid #e4e7ec}
.fm-entity-window .fm-shell-header .fm-window-controls{height:32px!important;gap:0!important}
.fm-entity-window .fm-shell-header .fm-window-controls button{width:30px!important;height:32px!important;min-height:32px!important;border:0!important;border-radius:6px}
.fm-shell-tabs{display:flex!important;align-items:stretch;gap:0!important;padding:0!important;margin:0!important;min-height:32px;overflow:auto;border-bottom:1px solid #e4e7ec;background:#fff}
.fm-entity-window .fm-shell-tabs.single-tab,.fm-entity-window .fm-shell-tabs[hidden]{display:none!important}
.fm-shell-tabs>button{box-sizing:border-box;flex:none;height:32px!important;min-height:32px!important;padding:4px 12px!important;border:0!important;border-radius:0!important;background:transparent!important;color:#667085;font-family:inherit;font-size:11px;font-weight:800;cursor:pointer}
.fm-shell-tabs[data-tab-style=underline]>button:is([aria-selected=true],[data-pane-open=true]){color:var(--primary-readable,var(--primary,#d93025))!important;box-shadow:inset 0 -3px 0 var(--primary,#d93025)!important}
.fm-shell-tabs[data-tab-style=pills]{gap:4px!important;padding:3px!important}
.fm-shell-tabs[data-tab-style=pills]>button{border-radius:6px!important}
.fm-shell-tabs[data-tab-style=pills]>button:is([aria-selected=true],[data-pane-open=true]){background:var(--primary-light,#eef2ff)!important;box-shadow:none!important}
.fm-shell-panes{display:flex;flex:1;min-height:0;min-width:0;overflow:auto}
.fm-shell-pane{display:flex;flex-direction:column;min-width:160px;min-height:0;overflow:hidden}
.fm-shell-pane[hidden],.fm-shell-sidebar[hidden]{display:none!important}
.fm-shell-divider{flex:0 0 6px;border:0;padding:0;background:#d0d5dd;cursor:col-resize;touch-action:none}
.fm-shell-divider:focus-visible{outline:2px solid #175cd3;outline-offset:-2px}
.fm-shell-tray-tabs{display:flex;margin-left:auto;align-items:center;flex:none}
.fm-shell-tray-tabs[hidden]{display:none}.fm-shell-tray-tabs button{width:32px;height:30px;border:0;background:none;cursor:pointer}
.fm-shell-tray{display:flex;flex-direction:column;flex:0 0 min(380px,45%);min-width:0;overflow:auto;border-left:1px solid #e4e7ec}
.fm-shell-tray[hidden]{display:none}.fm-shell-tray>header{display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid #e4e7ec}
.fm-shell-tray-content{flex:1;min-height:0;overflow:auto}
.fm-entity-window>.fm-shell-header[data-header-rows="1"]{height:36px!important;min-height:36px!important;padding:0!important;display:flex;align-items:center}
.fm-shell-header[data-header-rows="1"]>.fm-shell-identity{flex:1}
.fm-entity-window[data-window=minimized]>.fm-shell-header{height:30px!important;min-height:30px!important}
.fm-shell-toolbar{display:flex;flex:none;min-width:0;background:#fff;border-bottom:1px solid #e4e7ec}
.fm-shell-toolbar>.fm-shell-tabs{flex:1;min-width:0;border-bottom:0}
.fm-entity-window .fm-shell-header[data-header-rows="2"]{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto;grid-template-rows:36px 32px;height:68px!important;min-height:68px!important;padding:0;box-sizing:content-box}
.fm-shell-header[data-header-rows="2"]>.fm-shell-identity{grid-row:1;grid-column:1 / -1;padding:0 224px 0 16px}
.fm-shell-header[data-header-rows="2"]>.r-window-bar-actions{position:absolute;top:0;right:0;width:auto;border:0}
.fm-shell-header[data-header-rows="2"]>.fm-shell-tabs{grid-row:2;grid-column:1;min-width:0;min-height:0;height:32px;box-sizing:border-box;border-bottom:0!important;overflow:hidden}
.fm-shell-header[data-header-rows="2"]>.fm-project-tray-tabs{grid-row:2;grid-column:4;display:flex;align-items:center;gap:2px;padding:0 4px}
.fm-shell-header[data-header-rows="2"]>.fm-project-tray-tabs button{position:static;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:32px;height:30px;padding:0;border:0;border-radius:5px;background:none;color:#667085;font-family:inherit;font-size:13.3333px;font-weight:400;line-height:normal}
.fm-shell-tabs.fm-tabs-revealing>button{position:relative}
.fm-shell-tabs.fm-tabs-revealing>button:first-child{z-index:1;background:#fff!important}
.fm-entity-window .fm-shell-header[data-window-mobile=true]{display:grid!important;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:60px auto;height:auto!important;min-height:60px!important;padding-top:env(safe-area-inset-top,0px)!important}
.fm-entity-window .fm-shell-header[data-window-mobile=true]>.fm-shell-identity{grid-column:1;grid-row:1!important;padding:0 4px 0 16px!important;font-size:18px!important;align-self:stretch}
.fm-entity-window .fm-shell-header[data-window-mobile=true]>.r-window-bar-actions{position:static;grid-row:1;grid-column:2;align-self:center}
.fm-entity-window .fm-shell-header[data-window-mobile=true] .fm-window-controls{height:60px!important}
.fm-entity-window .fm-shell-header[data-window-mobile=true] .fm-window-controls button[data-window-action=close]{width:44px!important;height:44px!important;min-height:44px!important;border:1px solid #e4e7ec!important;border-radius:14px!important}
.fm-entity-window .fm-shell-header[data-window-mobile=true]>.fm-shell-tabs{grid-row:2;grid-column:1 / -1}
.fm-entity-window .fm-shell-header[data-window-mobile=true]>.fm-project-tray-tabs{grid-column:2;grid-row:2}
@media(max-width:760px){.fm-shell-tray{position:absolute;right:0;top:36px;bottom:0;width:min(380px,100%);background:white;z-index:5}}
`;document.head.append(style);
  }
  // Reveal newly available tabs behind the first tab without delaying access
  // or animating their layout widths. Retained tabs never replay the entrance.
  function revealTabs(tabs, known = ['map']){
    if(!tabs || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    const buttons=[...tabs.querySelectorAll('button[data-tab]')];
    const anchor=buttons[0]?.getBoundingClientRect();
    if(!anchor)return;
    const existing=new Set(known),animations=[];
    for(const button of buttons.slice(1)){
      if(existing.has(button.dataset.tab) || !button.animate)continue;
      const offset=Math.min(0,anchor.right-button.getBoundingClientRect().right);
      animations.push(button.animate([{transform:`translateX(${offset}px)`,opacity:0},{transform:'translateX(0)',opacity:1}],{duration:240,delay:Math.min(120,animations.length*25),easing:'cubic-bezier(.2,.7,.2,1)',fill:'backwards'}));
    }
    if(!animations.length)return;
    tabs.classList.add('fm-tabs-revealing');
    Promise.allSettled(animations.map(a=>a.finished)).then(()=>tabs.classList.remove('fm-tabs-revealing'));
  }
  // Yield a real paint opportunity, not an animation-length loading delay.
  // Hidden/minimized documents must still complete opening in the background.
  function afterPaint(){return new Promise(resolve=>{
    const fallback=root.setTimeout(resolve,100);
    root.requestAnimationFrame(()=>root.setTimeout(()=>{root.clearTimeout(fallback);resolve();},0));
  });}
  function normalizePanes(panes,available){
    if(!Array.isArray(panes)||!panes.length)throw Error('Layout panes must be a nonempty array.');
    const ids=new Set();
    const result=panes.map(p=>{
      if(!p||!available.includes(p.tab)||ids.has(p.tab))throw Error('Unavailable or duplicate window tab: '+p?.tab);
      ids.add(p.tab);const weight=p.weight===undefined?1:p.weight;
      if(typeof weight!=='number'||!Number.isFinite(weight)||weight<=0)throw Error('Pane weights must be positive finite numbers.');
      return {tab:p.tab,weight};
    });
    const total=result.reduce((sum,p)=>sum+p.weight,0);
    if(!Number.isFinite(total))throw Error('Pane weights are too large.');
    if(result.some(p=>p.weight/total===0))throw Error('Pane weights differ too much.');
    return result.map(p=>({...p,weight:p.weight/total}));
  }
  function mount({element,header,identity,tabs=null,sidebar=null,panes,trays=null,tabStyle='underline',headerRows=1}){
    styles();header.dataset.headerRows=String(headerRows);element.classList.add('fm-entity-window');header.classList.add('fm-shell-header');identity?.classList.add('fm-shell-identity');
    tabs?.classList.add('fm-shell-tabs');sidebar?.classList.add('fm-shell-sidebar');
    function validate(layout={}){
      if(!layout||typeof layout!=='object'||Array.isArray(layout))throw Error('Window layout must be an object.');
      const next={...layout};
      if(next.panes!==undefined)next.panes=normalizePanes(next.panes,(panes?.available() || []));
      if(next.tabStyle!==undefined&&!['underline','pills'].includes(next.tabStyle))throw Error('Unknown window tab style.');
      for(const key of ['tabs','sidebar'])if(next[key]!==undefined&&typeof next[key]!=='boolean')throw Error(key+' must be a boolean.');
      if(next.sidebar===true&&!sidebar)throw Error('This window has no persistent sidebar.');
      if(next.tabs===true&&!tabs)throw Error('This window has no tab bar.');
      if(next.tray!==undefined&&next.tray!==null&&!trays?.available().includes(next.tray))throw Error('Unavailable window tray: '+next.tray);
      for(const key of Object.keys(next))if(!['panes','tabStyle','tabs','sidebar','tray'].includes(key))throw Error('Unknown window layout option: '+key);
      return next;
    }
    function apply(layout={}){
      const next=validate(layout);
      if(next.panes)panes.apply(next.panes);
      if(tabs){if(next.tabs!==undefined)tabs.hidden=!next.tabs;if(next.tabStyle!==undefined)tabs.dataset.tabStyle=next.tabStyle;}
      if(sidebar&&next.sidebar!==undefined)sidebar.hidden=!next.sidebar;
      if(next.tray!==undefined)return trays?.select(next.tray);
    }
    if(tabs)tabs.dataset.tabStyle=tabStyle;
    return {apply,validate,reset(){return apply({tabs:!!tabs,sidebar:!!sidebar,tabStyle,tray:null});}};
  }
  // In-document apps (e.g. Contacts) retain exactly one mounted node per tab.
  function localPanes({container,definitions,onChange}){
    styles();
    container.classList.add('fm-shell-panes');
    let current=[],dividers=[];
    for(const item of definitions){item.element.classList.add('fm-shell-pane');container.append(item.element);}
    function apply(next){
      current=normalizePanes(next,definitions.map(d=>d.tab));
      dividers.forEach(d=>d.remove());dividers=[];
      for(const item of definitions)item.element.hidden=!current.some(p=>p.tab===item.tab);
      current.forEach((pane,index)=>{
        const element=definitions.find(d=>d.tab===pane.tab).element;element.style.order=String(index*2);element.style.flex=`${pane.weight} 1 0px`;
        if(index===current.length-1)return;
        const other=current[index+1],right=definitions.find(d=>d.tab===other.tab).element;
        const divider=document.createElement('div');divider.className='fm-shell-divider';divider.tabIndex=0;divider.role='separator';divider.setAttribute('aria-label','Resize panes');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-valuemin','0');divider.setAttribute('aria-valuemax','100');divider.style.order=String(index*2+1);
        const update=ratio=>{const total=pane.weight+other.weight;pane.weight=total*ratio;other.weight=total*(1-ratio);element.style.flex=`${pane.weight} 1 0px`;right.style.flex=`${other.weight} 1 0px`;divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));root.dispatchEvent(new Event('resize'));};
        update(pane.weight/(pane.weight+other.weight));
        const resize=ratio=>update(Math.max(.15,Math.min(.85,ratio)));
        divider.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();resize(pane.weight/(pane.weight+other.weight)+(e.key==='ArrowLeft'?-.05:.05));};
        divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);const start=e.clientX,width=element.getBoundingClientRect().width+right.getBoundingClientRect().width,ratio=pane.weight/(pane.weight+other.weight);divider.onpointermove=ev=>resize(ratio+(ev.clientX-start)/width);};
        divider.onpointerup=divider.onpointercancel=divider.onlostpointercapture=()=>{divider.onpointermove=null;};container.append(divider);dividers.push(divider);
      });onChange?.(current.map(p=>p.tab));root.dispatchEvent(new Event('resize'));
    }
    return {apply,available:()=>definitions.map(d=>d.tab),get state(){return current.map(p=>({...p}));}};
  }
  // Optional tray declarations use trusted application renderers, never raw HTML
  // from an open request. Each entity owns its context and access checks.
  function trayHost({container,header,getContext}){
    styles();
    const definitions=new Map(),handles=new Map(),panels=new Map();let selected=null;
    const buttons=document.createElement('nav');buttons.className='fm-shell-tray-tabs';buttons.setAttribute('aria-label','Window trays');header.append(buttons);
    const aside=document.createElement('aside');aside.className='fm-shell-tray';aside.hidden=true;
    const bar=document.createElement('header'),title=document.createElement('strong'),close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Close tray');bar.append(title,close);aside.append(bar);container.append(aside);
    const available=(context=getContext())=>[...definitions.values()].filter(d=>!d.available||d.available(context)).map(d=>d.id);
    function refresh(){
      const ids=available();if(selected&&!ids.includes(selected))select(null);
      buttons.hidden=!ids.length;buttons.replaceChildren();for(const id of ids){const d=definitions.get(id),button=document.createElement('button');button.type='button';button.title=d.label;button.setAttribute('aria-label',d.label);button.setAttribute('aria-pressed',String(selected===id));if(d.icon){const icon=document.createElement('i');icon.className=d.icon;icon.setAttribute('aria-hidden','true');button.append(icon);}else button.textContent=d.label;button.onclick=()=>select(selected===id?null:id);buttons.append(button);}
    }
    function select(id){
      if(id!==null&&!available().includes(id))throw Error('Unavailable window tray: '+id);
      selected=id;aside.hidden=id===null;aside.inert=id===null;panels.forEach((node,key)=>node.hidden=key!==id);
      if(id!==null){const d=definitions.get(id);title.textContent=d.label;if(!panels.has(id)){const panel=document.createElement('div');panel.className='fm-shell-tray-content';panels.set(id,panel);aside.append(panel);try{handles.set(id,d.mount(panel,getContext())||{});}catch(error){panels.delete(id);panel.remove();selected=null;aside.hidden=true;refresh();throw error;}}}
      refresh();
    }
    const capabilityChanged=()=>refresh();root.addEventListener('fm:capabilities:updated',capabilityChanged);
    close.onclick=()=>select(null);aside.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();select(null);}};
    function reset(){select(null);handles.forEach(h=>h.destroy?.());handles.clear();panels.forEach(p=>p.remove());panels.clear();refresh();}
    return {available,select,refresh,reset,get selected(){return selected;},register(definition){if(!definition?.id||typeof definition.mount!=='function'||definitions.has(definition.id))throw Error('Tray requires a unique id and mount function.');definitions.set(definition.id,definition);refresh();return ()=>{if(selected===definition.id)select(null);handles.get(definition.id)?.destroy?.();handles.delete(definition.id);panels.get(definition.id)?.remove();panels.delete(definition.id);definitions.delete(definition.id);refresh();};},destroy(){reset();root.removeEventListener('fm:capabilities:updated',capabilityChanged);buttons.remove();aside.remove();definitions.clear();}};
  }
  root.FirstMateWindowShell={mount,normalizePanes,localPanes,trayHost,ensureStyles:styles,revealTabs,afterPaint};
})(window);
