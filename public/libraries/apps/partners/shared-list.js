(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const organization=()=>String(window.Portal?.cfg?.userOrgId||window.Portal?.cfg?.orgId||window.__APP?.userOrgId||window.__APP?.orgId||'');
  function styles(){
    if(document.getElementById('fm-shared-list-style'))return;
    const style=document.createElement('style');style.id='fm-shared-list-style';
    style.textContent=`
.fm-shared-list-host{flex:0 0 auto;min-width:0;max-height:40vh;overflow:auto;font-size:13px;line-height:1.4;color:var(--text,#344054)}
.fm-shared-list{margin:0 0 12px;border:1px solid var(--border,#e4e7ec);border-radius:10px;background:var(--panel,#fff)}
.fm-shared-list>summary{padding:10px 12px;cursor:pointer;font-weight:600;font-size:13px;line-height:18px;color:var(--muted,#667085)}
.fm-shared-list>summary:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px;border-radius:10px}
.fm-shared-list-body{padding:0 12px 12px}
.fm-shared-list-filters{display:flex;align-items:flex-end;flex-wrap:wrap;gap:10px;padding:4px 0 12px}
.fm-shared-list-filters label{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--muted,#667085)}
.fm-shared-list select,.fm-shared-list button{box-sizing:border-box;max-width:100%;min-height:32px;border:1px solid var(--border,#d0d5dd);border-radius:7px;background:var(--panel,#fff);color:var(--text,#344054);padding:6px 10px;font:inherit;font-size:12px}
.fm-shared-list button{cursor:pointer}.fm-shared-list button:hover{background:var(--bg,#f2f4f7)}
.fm-shared-list p{margin:8px 0;font-size:13px;color:var(--muted,#667085)}
.fm-shared-list [role=status]:empty{display:none}.fm-shared-list [hidden]{display:none!important}
.fm-shared-resource{padding:10px 12px;margin-bottom:8px;border:1px solid var(--border,#e4e7ec);border-radius:8px;overflow-wrap:anywhere}
@media(max-width:600px){.fm-shared-list-filters{align-items:stretch}.fm-shared-list-filters label{flex:1 1 180px;justify-content:space-between}.fm-shared-list-filters select{min-width:0;flex:1}}
`;document.head.append(style);
  }
  function mount(host,type){
    if(!host)return;
    styles();host.classList.add('fm-shared-list-host');
    const org=organization();let cursor='',items=[],epoch=0;
    host.innerHTML=`<details class="fm-shared-list"><summary>Shared ${escape({project:'projects',contact:'contacts',channel:'channels'}[type]||'resources')}</summary><div class="fm-shared-list-body"><div class="fm-shared-list-filters"><label>Show <select data-direction><option value="inbound">Shared with us</option><option value="outbound">Shared by us</option></select></label><label>Organization <select data-organization><option value="">All organizations</option></select></label></div><div data-items role="region" aria-label="Shared resources"></div><button type="button" data-more hidden>Load more</button><p role="status"></p></div></details>`;
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
        results.innerHTML=unique.map((item,index)=>`<article class="fm-shared-resource"><strong>${escape(item.data?.title||item.data?.name||item.resource.id)}</strong><p>${outbound?'Shared with':'Shared by'} ${escape(outbound?(item.recipient?.name||item.recipient_org_id):item.owner?.name)}</p>${!outbound?`<button type="button" data-open="${index}">Open shared ${escape(type)}</button>`:''}</article>`).join('')||'<p>No shared resources in this view.</p>';
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
