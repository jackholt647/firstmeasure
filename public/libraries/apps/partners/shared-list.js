(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const organization=()=>String(window.Portal?.cfg?.userOrgId||window.Portal?.cfg?.orgId||window.__APP?.userOrgId||window.__APP?.orgId||'');
  function mount(host,type){
    if(!host)return;
    const org=organization();let cursor='',items=[],epoch=0;
    host.innerHTML=`<details open style="padding:12px;border:1px solid var(--border,#888);border-radius:8px;margin:12px 0"><summary>Shared ${escape({project:'projects',contact:'contacts',channel:'channels'}[type]||'resources')}</summary><div style="display:flex;gap:12px;padding:12px 0"><label>Show <select data-direction><option value="inbound">Shared with us</option><option value="outbound">Shared by us</option></select></label><label>Organization <select data-organization><option value="">All organizations</option></select></label></div><div data-items role="region" aria-label="Shared resources"></div><button type="button" data-more hidden>Load more</button><p role="status"></p></details>`;
    const root=host.querySelector('details'),direction=host.querySelector('[data-direction]'),filter=host.querySelector('[data-organization]'),results=host.querySelector('[data-items]'),more=host.querySelector('[data-more]'),status=host.querySelector('[role=status]');
    async function load(append=false){
      const version=++epoch;status.textContent='Loading shared resources…';
      const outbound=direction.value==='outbound';
      const params=new URLSearchParams({type,limit:'50',...(append&&cursor?{after:cursor}:{}),...(filter.value?{[outbound?'recipient':'owner']:filter.value}:{})});
      try{
        const page=await window.PlatformAPI.request(new URL(`/v1/collaboration/organizations/${encodeURIComponent(org)}/${outbound?'shares':'shared'}?${params}`,location.origin).href);
        if(version!==epoch||!root.isConnected||org!==organization())return;
        items=append?[...items,...page.items]:page.items;cursor=page.next_cursor||'';
        const filtered=items.filter(item=>item.resource.type===type&&(!outbound||item.status==='active'));
        for(const item of filtered){const id=outbound?item.recipient_org_id:item.resource.owner_org_id;if(!Array.from(filter.options).some(o=>o.value===id)){const option=document.createElement('option');option.value=id;option.textContent=outbound?(item.recipient?.name||id):(item.owner?.name||id);filter.add(option);}}
        const unique=[...new Map(filtered.map(item=>[JSON.stringify(item.resource)+(outbound?item.recipient_org_id:""),item])).values()];
        results.innerHTML=unique.map((item,index)=>`<article style="padding:12px;margin-bottom:8px;border:1px solid var(--border,#888);border-radius:8px"><strong>${escape(item.data?.title||item.data?.name||item.resource.id)}</strong><p>${outbound?'Shared with':'Shared by'} ${escape(outbound?(item.recipient?.name||item.recipient_org_id):item.owner?.name)}</p>${!outbound?`<button type="button" data-open="${index}">Open shared ${escape(type)}</button>`:''}</article>`).join('')||'<p>No shared resources in this view.</p>';
        results.onclick=event=>{const button=event.target.closest('[data-open]');if(button){
          const item=unique[Number(button.dataset.open)];window.__fmPendingCollaborationResource=item;
          window.Portal.tabs?.activateTab?.('partners');
          window.dispatchEvent(new CustomEvent('fm:collaboration:open',{detail:item}));
        }};
        more.hidden=!cursor;status.textContent='';
      }catch(error){if(version===epoch){status.textContent=error.status===403?'You do not have access to this sharing view.':(error.message||'Shared resources could not be loaded.');results.replaceChildren();more.hidden=true;}}
    }
    direction.onchange=()=>{filter.value='';items=[];load();};filter.onchange=()=>load();more.onclick=()=>load(true);
    root.ontoggle=()=>{if(root.open)load();};load();
    return ()=>{epoch++;host.replaceChildren();};
  }
  window.FirstMateSharedList={mount};
})();
