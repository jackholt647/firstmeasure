/* Shared app headers and organization-configurable groups. Placement never grants access. */
(function(){
  'use strict';
  if (window.AppChrome) return;
  const runtime = window.FirstMateEmbeddableApps;
  const esc = runtime.escapeHtml;
  const groups = new Map();
  // GP-113: an app's sub-tabs, declared once: { param, items:[{ id, title, icon, available? }] }. A group's members
  // are its parent's sub-tabs (registerGroup with `routeParam`); an app with its own view strip registers its own.
  // The Apps menu lists them under the app, and a person can pin each to the left column (left-column-pins.js).
  const subtabRegistry = new Map();
  let layouts = {}, loadedOrg = '', generation = 0;
  const org = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '');
  const style = document.createElement('style');
  style.textContent = `
    [data-app-header="shared"]{box-sizing:border-box;display:flex!important;align-items:center!important;justify-content:space-between;gap:16px!important;flex-wrap:wrap;flex:none;padding:18px 22px!important;background:var(--bg,#f0f2f5);border-bottom:0;min-height:80px}
    [data-app-header="shared"]>.app-heading{display:flex;align-items:center;gap:12px;min-width:0}
    [data-app-header="shared"] :is(h1,h2,strong){font-size:24px!important;font-weight:650!important;line-height:1.2;margin:0!important;color:var(--text,#202124)}
    [data-app-header="shared"] .app-heading>i{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:var(--radius-md,10px);background:var(--primary,#d93025);color:var(--on-primary,#fff)!important;font-size:18px!important}
    [data-app-header="shared"] .app-subtitle{font-size:12px;color:#667085;margin:4px 0 0}
    :where([data-app-header="shared"]) button{min-height:34px;border-radius:8px;padding:8px 11px;font-family:inherit;font-size:12px;font-weight:600}
    [data-app-header="shared"]>:first-child i{color:var(--primary-readable,var(--primary,#3b6ef6));font-size:24px;margin-right:10px}
    [data-app-header="shared"] .app-heading>i{margin-right:0}
    .app-header-tools{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;flex-wrap:wrap}
    .app-tabs,[data-app-tab-row]{display:flex;align-items:center;gap:4px;max-width:100%;overflow-x:auto}.app-header-tools>.app-tabs{padding:3px;border:1px solid var(--border,#dadce0);border-radius:10px;background:var(--panel,#fff);gap:2px;scrollbar-width:thin}.app-header-tools>button{display:inline-flex;align-items:center;justify-content:center;min-width:36px;border:1px solid var(--border,#dadce0);background:var(--panel,#fff);color:var(--muted,#5f6368);cursor:pointer}.app-header-tools>button:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary,#d93025)}
    [data-app-header="shared"] .app-tabs button,.app-tabs button{border:0;background:transparent;padding:8px 10px;border-radius:7px;white-space:nowrap;color:var(--muted,#5f6368);font-family:inherit;font-size:12px;font-weight:600;line-height:1.3;cursor:pointer}
    [data-app-header="shared"] .app-tabs button[aria-current=page],.app-tabs button[aria-current=page]{color:var(--primary-readable,var(--primary,#245cc5));background:color-mix(in srgb,var(--primary,#245cc5) 9%,white)}
    .app-tabs button:focus-visible{outline:2px solid var(--primary,#245cc5);outline-offset:2px}
    /* FM-550: the shared app tab strip, a full-width row of icon + label tabs like the project view's. When the full
       labels do not fit it uses each tab's short label, then icons only; a narrow strip gives every tab an equal
       column with its label under the icon. */
    app-tab-strip.app-tabstrip{box-sizing:border-box;display:flex;align-items:stretch;flex:none;width:100%;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;background:var(--panel,#fff);border-top:1px solid #e4e7ec;border-bottom:1px solid #e4e7ec}
    app-tab-strip.app-tabstrip::-webkit-scrollbar{display:none}
    app-tab-strip.app-tabstrip>button{box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:0;min-height:46px;margin:0;padding:10px 16px;border:0;border-right:1px solid rgba(15,23,42,.10);border-radius:0;background:transparent;box-shadow:none;color:#475467;font-family:inherit;font-size:12px;font-weight:650;line-height:1.2;white-space:nowrap;cursor:pointer;transition:background .16s ease,color .16s ease}
    app-tab-strip.app-tabstrip>button:hover{background:#f8fafc;color:#101828;border-color:rgba(15,23,42,.10)}
    app-tab-strip.app-tabstrip>button[aria-current=page]{background:transparent;color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -3px 0 var(--primary,#d93025)}
    app-tab-strip.app-tabstrip>button:focus-visible{outline:2px solid var(--primary,#245cc5);outline-offset:-2px}
    app-tab-strip.app-tabstrip>button>i{flex:none;font-size:13px;margin:0}
    app-tab-strip .app-tab-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis}
    app-tab-strip .app-tab-short{display:none}
    app-tab-strip[data-fit=short] .app-tab-label:has(.app-tab-short)>.app-tab-long{display:none}
    app-tab-strip[data-fit=short] .app-tab-short{display:inline}
    app-tab-strip.app-tabstrip[data-fit=icons]>button:has(>i){gap:0;min-width:44px;padding:0 13px}
    app-tab-strip[data-fit=icons]>button:has(>i) .app-tab-label{display:none}
    app-tab-strip.app-tabstrip[data-fit=icons]>button>i{font-size:15px}
    app-tab-strip.app-tabstrip[data-stacked]>button{flex:1 1 0;flex-direction:column;gap:4px;min-height:52px;padding:7px 4px 6px;font-size:11px}
    app-tab-strip.app-tabstrip[data-stacked]>button>i{font-size:15px}
    app-tab-strip.app-tabstrip[data-stacked]>button:last-child{border-right:0}
    app-tab-strip.app-tabstrip[data-stacked] .app-tab-label{max-width:100%}
    app-tab-strip.app-tabstrip[data-measure]{flex:none!important;width:max-content!important;max-width:none!important;overflow:visible!important}
    /* GP-63: in a header the strip takes the room beside the title. On a desktop every strip is a segmented
       control like My Projects' and My Contacts' views (right-aligned in a header); on a phone it stays the
       full-width row under the title. */
    [data-app-header="shared"]>.app-header-strip{display:flex;flex:1 1 0;min-width:0}
    [data-app-header="shared"]>.app-header-strip:not(:has(app-tab-strip)){display:none}
    [data-app-header="shared"]>.app-header-strip>*{flex:1 1 auto;min-width:0}
    [data-app-header="shared"]>.app-header-strip+.app-header-tools:empty{display:none}
    @media(min-width:801px){
      app-tab-strip.app-tabstrip{align-items:center;background:transparent;border:0}
      app-tab-strip.app-tabstrip>button{min-height:38px;padding:0 12px;gap:8px;border:1px solid #d0d5dd;border-width:1px 0 1px 1px;border-left-color:#eaecf0;background:#fff;color:#667085;font-size:12px;font-weight:900}
      app-tab-strip.app-tabstrip>button:first-child{border-left-color:#d0d5dd;border-radius:10px 0 0 10px}
      app-tab-strip.app-tabstrip>button:last-child{border-right-width:1px;border-radius:0 10px 10px 0}
      app-tab-strip.app-tabstrip>button:only-child{border-radius:10px}
      app-tab-strip.app-tabstrip>button:hover{background:#f8fafc;color:#344054;border-color:#d0d5dd #d0d5dd #d0d5dd #eaecf0}
      app-tab-strip.app-tabstrip>button:first-child:hover{border-left-color:#d0d5dd}
      app-tab-strip.app-tabstrip>button[aria-current=page]{background:#fff linear-gradient(rgba(var(--primary-rgb,217,48,37),.1),rgba(var(--primary-rgb,217,48,37),.1));color:var(--primary-readable,var(--primary,#d93025));box-shadow:none}
      app-tab-strip.app-tabstrip[data-fit=icons]>button:has(>i){min-width:40px;padding:0 12px}
      app-tab-strip.app-tabstrip[data-fit=icons]>button>i{font-size:14px}
      .app-header-strip app-tab-strip.app-tabstrip>button:first-child{margin-left:auto}
    }
    @media(max-width:800px){[data-app-header="shared"]>.app-header-strip{order:1;flex:0 0 calc(100% + 28px);margin:2px -14px -14px}}
    [data-app-tab-row]{padding:10px 22px;border-bottom:1px solid #e7eaf0;background:white;flex:none}
    .app-layout{padding:24px;max-width:800px;background:var(--panel,#fff);border:1px solid var(--border,#dadce0);border-radius:12px;margin:16px auto}.app-layout h2{font-size:20px;font-weight:600;margin:0 0 8px}.app-layout>p{font-size:13px;line-height:1.6;color:var(--muted,#5f6368)}.app-layout label{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:1px solid #eaecf0}.app-layout select{font:inherit;font-size:12px;padding:9px 12px;max-width:60%;border:1px solid var(--border,#dadce0);border-radius:8px;background:var(--panel,#fff)}.app-layout button{margin-top:16px;padding:9px 14px;border:0;border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-size:12px;cursor:pointer}
    .app-layout-dialog{border:1px solid #e4e7ec;border-radius:14px;width:min(680px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:16px;font-family:inherit;font-size:14px;line-height:1.5;color:var(--text,#202124)}.app-layout-dialog::backdrop{background:rgba(16,24,40,.4)}.app-layout-dialog>[data-layout-close]{float:right;border:0;background:#f2f4f7;border-radius:8px;padding:8px 12px;cursor:pointer}
    @media(max-width:800px){[data-app-header="shared"]{padding:14px!important;gap:12px!important}.app-header-tools{width:100%;margin:0;flex-wrap:nowrap}.app-header-tools .app-tabs{flex:1;min-width:0}.app-header-tools:not(:has(.app-tabs)){width:auto;margin-left:auto}[data-app-header="shared"] :is(h1,h2,strong){font-size:20px!important}}
  `;
  document.head.appendChild(style);
  // strip: a tabStrip() (or tabs(...,{strip:true})), or a host an app fills with one: beside the title on a desktop,
  // full width under it on a phone (GP-63).
  function header({title, icon='fa-layer-group', subtitle='', tabs='', actions='', row='', strip=''}) {
    return `<header data-app-header="shared"><div class="app-heading"><i class="fas ${esc(icon)}" aria-hidden="true"></i><div><h1>${esc(title)}</h1>${subtitle?`<p class="app-subtitle">${esc(subtitle)}</p>`:''}</div></div>${strip?`<div class="app-header-strip">${strip}</div>`:''}<div class="app-header-tools">${tabs}${actions}</div></header>${row?`<div data-app-tab-row>${row}</div>`:''}`;
  }
  const faIcon=name=>{name=String(name||'');return !name || name.startsWith('fa-') ? name : `fa-${name}`;};
  // One tab strip for every app (FM-550). items: {id, title, short?, icon?, attribute?}; a tab's attribute (default
  // `attribute`) carries its id for the app's click handler, and the selected one is aria-current="page".
  function tabStrip({label='', attribute='data-tab', selected='', items=[]}={}){
    return `<app-tab-strip class="app-tabstrip" role="navigation" aria-label="${esc(label)}">${items.map(item=>{
      const title=String(item.title || item.id), short=item.short && item.short!==title ? String(item.short) : '', icon=faIcon(item.icon);
      return `<button type="button" ${item.attribute || attribute}="${esc(item.id)}" aria-current="${item.id===selected?'page':'false'}" aria-label="${esc(title)}">${icon?`<i class="fas ${esc(icon)}" aria-hidden="true"></i>`:''}<span class="app-tab-label"><span class="app-tab-long">${esc(title)}</span>${short?`<span class="app-tab-short" aria-hidden="true">${esc(short)}</span>`:''}</span></button>`;
    }).join('')}</app-tab-strip>`;
  }
  // Full labels, then short labels, then icons only (as the project view, FM-371). On a phone, a strip under 600 px
  // gives every tab an equal column with its label under the icon, and short labels once any full one is cut off;
  // a desktop strip is a segmented control and never stacks (GP-63).
  const STACK_BELOW=600, phone=window.matchMedia?.('(max-width:800px)');
  function fitStrip(strip){
    const room=strip.clientWidth;
    if(!strip.isConnected || !room)return;
    const buttons=[...strip.children].filter(el=>el.matches('button'));
    let fit='full';
    if(room<STACK_BELOW && (!phone || phone.matches)){
      strip.dataset.stacked='';strip.dataset.fit='full';
      const range=document.createRange();
      const cut=[...strip.querySelectorAll('.app-tab-label')].some(label=>{range.selectNodeContents(label);return range.getBoundingClientRect().width>label.getBoundingClientRect().width+0.01;});
      if(cut && strip.querySelector('.app-tab-short'))fit='short';
    }else{
      delete strip.dataset.stacked;strip.dataset.measure='';strip.dataset.fit='full';
      if(strip.getBoundingClientRect().width>room+1){strip.dataset.fit='short';fit=strip.getBoundingClientRect().width>room+1?'icons':'short';}
      delete strip.dataset.measure;
    }
    strip.dataset.fit=fit;
    // Icons only: the platform tooltip names each tab.
    for(const button of buttons){if(fit==='icons')button.setAttribute('data-fm-tooltip',button.getAttribute('aria-label') || '');else button.removeAttribute('data-fm-tooltip');}
  }
  const pendingFits=new Set();let fitFrame=0;
  function scheduleFit(strip){pendingFits.add(strip);if(!fitFrame)fitFrame=requestAnimationFrame(()=>{fitFrame=0;const strips=[...pendingFits];pendingFits.clear();strips.forEach(fitStrip);});}
  const stripResize=typeof ResizeObserver==='function' ? new ResizeObserver(entries=>entries.forEach(entry=>scheduleFit(entry.target))) : null;
  if(window.customElements && !customElements.get('app-tab-strip'))customElements.define('app-tab-strip',class extends HTMLElement{
    connectedCallback(){fitStrip(this);stripResize?.observe(this);}
    disconnectedCallback(){stripResize?.unobserve(this);}
  });
  document.fonts?.ready?.then(()=>document.querySelectorAll('app-tab-strip').forEach(scheduleFit));
  phone?.addEventListener?.('change',()=>document.querySelectorAll('app-tab-strip').forEach(scheduleFit));
  function placement(group, id){ return layouts[group]?.members?.[id] || groups.get(group)?.members.find(member=>member.id===id)?.defaultPlacement || 'group'; }
  function members(group, context={}) {
    const definition=groups.get(group);
    if (!definition) return [];
    return definition.members.filter(member => ['group','both'].includes(placement(group,member.id)) &&
      (!member.available || member.available(context)) && runtime.evaluateAccess(definition.parent,{...context,surface:'portal_tab'}).allowed &&
      runtime.evaluateAccess(member.appId,{...context,surface:'portal_tab'}).allowed);
  }
  function resolve(group, requested, context={}) {
    const available=members(group,context);
    return available.find(m=>m.id===requested)?.id || available.find(m=>m.id===(layouts[group]?.default || groups.get(group)?.default))?.id || available[0]?.id || '';
  }
  // options.strip: the shared tab strip (each member's icon and short label), with options.extra tabs after the
  // members (for example Settings). Without it, the header's compact pills.
  function tabs(group, selected, attribute, context={}, options={}) {
    if(options.strip)return tabStrip({label:groups.get(group)?.title || group,attribute,selected,
      items:[...members(group,context).map(m=>({id:m.id,title:m.title,short:m.short,icon:m.icon})),...(options.extra || [])]});
    return `<nav class="app-tabs" aria-label="${esc(groups.get(group)?.title || group)}">${members(group,context).map(m=>`<button type="button" ${attribute}="${esc(m.id)}" aria-current="${m.id===selected?'page':'false'}">${esc(m.title)}</button>`).join('')}</nav>`;
  }
  function settingsTabs(group,selected,attribute,back){
    return `<nav class="app-tabs" aria-label="${esc(groups.get(group)?.title)} settings"><button type="button" ${attribute}="${esc(back)}">Back</button>${(groups.get(group)?.settings || []).map(tab=>`<button type="button" ${attribute}="${esc(tab.id)}" aria-current="${selected===tab.id?'page':'false'}">${esc(tab.title)}</button>`).join('')}</nav>`;
  }
  function registerSubtabs(appId, {param, items, icon=''}={}){
    const id=String(appId || '').trim().toLowerCase();
    if (!id || !param || (typeof items!=='function' && !Array.isArray(items))) throw new Error('Sub-tabs need an app, a route param and their items.');
    subtabRegistry.set(id,{param:String(param),items,icon});
  }
  // The sub-tabs this person has now, each with the route that opens it.
  function subtabs(appId, context={}){
    const entry=subtabRegistry.get(String(appId || '').trim().toLowerCase());
    if (!entry) return [];
    const items=typeof entry.items==='function' ? entry.items(context) : entry.items;
    return (Array.isArray(items) ? items : []).filter(item=>item?.id && (!item.available || item.available(context)))
      .map(item=>({id:String(item.id),label:String(item.title || item.label || item.id),icon:item.icon || entry.icon || '',route:{[entry.param]:String(item.id)}}));
  }
  function registerGroup(definition){
    if (!definition.members.some(m=>m.id===definition.default)) throw new Error('An app group needs a declared default member.');
    const group={...definition,members:definition.members.map(m=>({...m,appId:m.appId || `${definition.parent}.${m.id}`}))};
    groups.set(group.id,group);
    if (group.routeParam) registerSubtabs(group.parent,{param:group.routeParam,icon:group.icon,items:context=>members(group.id,context)});
    const parent=runtime.getApp(group.parent);
    const originalVisible=parent?.visible;
    runtime.registerApp({...parent,visible:context=>(typeof originalVisible==='function'?originalVisible(context):originalVisible!==false) &&
      group.members.some(member=>['group','both'].includes(placement(group.id,member.id)))});
    for (const member of group.members) {
      runtime.registerApp({id:member.appId,title:member.title,icon:member.icon || group.icon,kind:'portal_tab',
        portalTabId:member.appId.replace(/^portal\./,''),surfaces:['portal_tab','app_group'],fullBleed:true,
        route:{parent:'portal',params:{...(parent?.route?.params || {}),tab:{default:member.appId.replace(/^portal\./,''),history:'push'}}},
        order:(parent?.order || 100)+group.members.indexOf(member)/100,
        // A member has no app entitlement of its own: it is its parent's, so it is offered with it, shows the parent's
        // welcome and Get Started starts the parent (GP-87: the Call center while Communications is offered).
        access:{...(parent?.access || {}),entitlementKey:group.parent},
        enabled:context=>runtime.evaluateAccess(group.parent,{...context,surface:'portal_tab'}).allowed && (!member.available || member.available(context)),
        visible:context=>context.surface==='app_group' || ['standalone','both'].includes(placement(group.id,member.id)),
        mount:context=>group.mount(member.id,context)});
    }
    return group;
  }
  async function load(){
    const organization=org(), token=++generation;
    if (organization!==loadedOrg){layouts={};loadedOrg=organization;}
    if (!organization || !window.PlatformAPI) return;
    const result=await window.PlatformAPI.request(`/organizations/${encodeURIComponent(organization)}/app-groups`);
    if(token!==generation || org()!==organization)return;
    const next=result.groups || {},changed=JSON.stringify(next)!==JSON.stringify(layouts);
    layouts=next;
    if(changed)window.dispatchEvent(new CustomEvent('fm:app-placements:updated'));
  }
  function settings(groupId){
    const group=groups.get(groupId), config=layouts[groupId] || {};
    return `<form class="app-layout" data-app-layout="${esc(groupId)}"><h2>App layout</h2><p>Choose where each app appears for your organization. Access permissions still apply.</p>${group.members.map(m=>`<label>${esc(m.title)}<select name="${esc(m.id)}">${[['group','In group'],['standalone','Standalone'],['both','Both'],['hidden','Hidden']].map(([v,l])=>`<option value="${v}" ${placement(groupId,m.id)===v?'selected':''}>${l}</option>`).join('')}</select></label>`).join('')}<label>Default tab<select name="default"><option value="" ${config.default===''?'selected':''}>No group (standalone apps only)</option>${group.members.map(m=>`<option value="${esc(m.id)}" ${m.id===(config.default ?? group.default)?'selected':''}>${esc(m.title)}</option>`).join('')}</select></label><button type="submit">Save layout</button><p role="status" data-layout-status></p></form>`;
  }
  function openSettings(groupId){
    const dialog=document.createElement('dialog');
    dialog.className='app-layout-dialog';
    dialog.innerHTML=`<button type="button" data-layout-close aria-label="Close settings">Close</button>${settings(groupId)}`;
    dialog.querySelector('[data-layout-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    document.body.appendChild(dialog);dialog.showModal();
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-app-layout-open]');if(button)openSettings(button.dataset.appLayoutOpen);});
  document.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-app-layout]');if(!form)return;event.preventDefault();
    const status=form.querySelector('[data-layout-status]'),button=form.querySelector('[type=submit]');
    button.disabled=true;
    try{
      const values=Object.fromEntries(new FormData(form)), {default:defaultId,...memberValues}=values;
      if(defaultId ? !['group','both'].includes(memberValues[defaultId]) : Object.values(memberValues).some(v=>['group','both'].includes(v)))throw new Error('Choose a default tab included in the group, or move all apps out of the group.');
      await window.PlatformAPI.request(`/organizations/${encodeURIComponent(org())}/app-groups/${encodeURIComponent(form.dataset.appLayout)}`,{method:'PUT',body:{default:defaultId,members:memberValues}});
      await load();status.textContent='Layout saved. Reopen the app to use the new layout.';
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
  window.AppChrome={header,tabs,tabStrip,fitStrip,settingsTabs,registerGroup,registerSubtabs,subtabs,members,resolve,settings,openSettings,load,placement};
  window.addEventListener('fm:platform-session:updated',()=>{void load().catch(()=>{});});
  void load().catch(()=>{});
})();
