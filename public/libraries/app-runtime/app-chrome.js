/* Shared app headers and organization-configurable groups. Placement never grants access. */
(function(){
  'use strict';
  if (window.AppChrome) return;
  const runtime = window.FirstMateEmbeddableApps;
  const esc = runtime.escapeHtml;
  const groups = new Map();
  let layouts = {}, loadedOrg = '', generation = 0;
  const org = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '');
  const style = document.createElement('style');
  style.textContent = `
    [data-app-header]{box-sizing:border-box;display:flex!important;align-items:center!important;justify-content:space-between;gap:16px!important;flex-wrap:wrap;flex:none;padding:18px 22px!important;background:#fff;border-bottom:1px solid #e7eaf0;min-height:76px}
    [data-app-header]>.app-heading{display:flex;align-items:center;gap:12px;min-width:0}
    [data-app-header] :is(h1,h2,strong){font-size:22px!important;font-weight:800!important;line-height:1.2;margin:0!important;color:#182230}
    [data-app-header] .app-heading>i{font-size:24px;color:var(--primary-readable,var(--primary,#3b6ef6))}
    [data-app-header] .app-subtitle{font-size:12px;color:#667085;margin:4px 0 0}
    :where([data-app-header]) button{min-height:34px;border-radius:8px;padding:8px 11px;font-family:inherit;font-size:12px;font-weight:600}
    [data-app-header]>:first-child i{color:var(--primary-readable,var(--primary,#3b6ef6));font-size:24px;margin-right:10px}
    [data-app-header] .app-heading>i{margin-right:0}
    .app-header-tools{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;flex-wrap:wrap}
    .app-tabs,[data-app-tab-row]{display:flex;align-items:center;gap:4px;max-width:100%;overflow-x:auto}
    [data-app-header] .app-tabs button,.app-tabs button{border:0;background:transparent;padding:9px 11px;border-radius:8px;white-space:nowrap;color:#667085;font-family:inherit;font-size:12px;font-weight:600;line-height:1.3;cursor:pointer}
    [data-app-header] .app-tabs button[aria-current=page],.app-tabs button[aria-current=page]{color:var(--primary-readable,var(--primary,#245cc5));background:color-mix(in srgb,var(--primary,#245cc5) 9%,white)}
    .app-tabs button:focus-visible{outline:2px solid var(--primary,#245cc5);outline-offset:2px}
    [data-app-tab-row]{padding:10px 22px;border-bottom:1px solid #e7eaf0;background:white;flex:none}
    .app-layout{padding:20px;max-width:800px}.app-layout label{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:1px solid #eaecf0}.app-layout select{padding:8px;max-width:60%}.app-layout button{margin-top:16px;padding:9px 14px}
    .app-layout-dialog{border:1px solid #e4e7ec;border-radius:14px;width:min(680px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:16px;font:14px/1.5 system-ui;color:#182230}.app-layout-dialog::backdrop{background:rgba(16,24,40,.4)}.app-layout-dialog>[data-layout-close]{float:right;border:0;background:#f2f4f7;border-radius:8px;padding:8px 12px;cursor:pointer}
    @media(max-width:800px){[data-app-header]{padding:14px!important;gap:12px!important}.app-header-tools{width:100%;margin:0;flex-wrap:nowrap}.app-header-tools .app-tabs{flex:1;min-width:0}[data-app-header] :is(h1,h2,strong){font-size:20px!important}}
  `;
  document.head.appendChild(style);
  function header({title, icon='fa-layer-group', subtitle='', tabs='', actions='', row=''}) {
    return `<header data-app-header><div class="app-heading"><i class="fas ${esc(icon)}" aria-hidden="true"></i><div><h1>${esc(title)}</h1>${subtitle?`<p class="app-subtitle">${esc(subtitle)}</p>`:''}</div></div><div class="app-header-tools">${tabs}${actions}</div></header>${row?`<div data-app-tab-row>${row}</div>`:''}`;
  }
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
  function tabs(group, selected, attribute, context={}) {
    return `<nav class="app-tabs" aria-label="${esc(groups.get(group)?.title || group)}">${members(group,context).map(m=>`<button type="button" ${attribute}="${esc(m.id)}" aria-current="${m.id===selected?'page':'false'}">${esc(m.title)}</button>`).join('')}</nav>`;
  }
  function settingsTabs(group,selected,attribute,back){
    return `<nav class="app-tabs" aria-label="${esc(groups.get(group)?.title)} settings"><button type="button" ${attribute}="${esc(back)}">Back</button>${(groups.get(group)?.settings || []).map(tab=>`<button type="button" ${attribute}="${esc(tab.id)}" aria-current="${selected===tab.id?'page':'false'}">${esc(tab.title)}</button>`).join('')}</nav>`;
  }
  function registerGroup(definition){
    if (!definition.members.some(m=>m.id===definition.default)) throw new Error('An app group needs a declared default member.');
    const group={...definition,members:definition.members.map(m=>({...m,appId:m.appId || `${definition.parent}.${m.id}`}))};
    groups.set(group.id,group);
    const parent=runtime.getApp(group.parent);
    const originalVisible=parent?.visible;
    runtime.registerApp({...parent,visible:context=>(typeof originalVisible==='function'?originalVisible(context):originalVisible!==false) &&
      group.members.some(member=>['group','both'].includes(placement(group.id,member.id)))});
    for (const member of group.members) {
      runtime.registerApp({id:member.appId,title:member.title,icon:member.icon || group.icon,kind:'portal_tab',
        portalTabId:member.appId.replace(/^portal\./,''),surfaces:['portal_tab','app_group'],fullBleed:true,
        route:{parent:'portal',params:{...(parent?.route?.params || {}),tab:{default:member.appId.replace(/^portal\./,''),history:'push'}}},
        order:(parent?.order || 100)+group.members.indexOf(member)/100,
        access:parent?.access || {},
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
  window.AppChrome={header,tabs,settingsTabs,registerGroup,members,resolve,settings,openSettings,load,placement};
  window.addEventListener('fm:platform-session:updated',()=>{void load().catch(()=>{});});
  void load().catch(()=>{});
})();
