(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const organization=()=>String(window.Portal?.cfg?.userOrgId||window.Portal?.cfg?.orgId||window.__APP?.userOrgId||window.__APP?.orgId||'');
  const key=r=>JSON.stringify([r.owner_org_id,r.type,r.project_id||'',r.id]);
  function styles(){
    if(document.getElementById('fm-sharing-view-style'))return;
    const style=document.createElement('style');style.id='fm-sharing-view-style';
    style.textContent=`.fm-sharing-label{display:block;font-size:11px;font-weight:500;line-height:1.5;color:var(--muted,#667085);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-sharing-label i{margin-right:5px}.fm-sharing-fields{display:grid;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border,#e4e7ec)}.fm-sharing-fields label{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted,#667085)}.fm-sharing-fields select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--border,#d0d5dd);border-radius:7px;padding:7px 9px;background:var(--panel,#fff);color:var(--text,#344054);font:inherit}.fm-sharing-fields fieldset{border:0;margin:0;padding:0;display:grid;gap:10px;min-width:0}.fm-sharing-fields legend{padding:0;margin-bottom:10px;font-size:12px;font-weight:600}.fm-sharing-fields input[type=checkbox]{width:15px;height:15px;flex:none;accent-color:var(--primary,#d93025)}.fm-sharing-fields .fm-sharing-organizations{padding-left:23px;max-height:220px;overflow:auto}.fm-sharing-fields label span{overflow-wrap:anywhere}.fm-sharing-fields p{margin:0;font-size:12px}.fm-sharing-menu{position:relative}.fm-sharing-menu>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px}.ct-list-contact .fm-sharing-label{display:block}.fm-sharing-menu>summary::-webkit-details-marker{display:none}.fm-sharing-popover{position:absolute;right:0;top:calc(100% + 6px);width:240px;max-width:80vw;z-index:30;padding:14px;border:1px solid var(--border,#e4e7ec);border-radius:10px;background:var(--panel,#fff);box-shadow:0 12px 28px #10182820}.fm-sharing-popover>label{display:grid;gap:6px;font-size:12px}.fm-sharing-popover select{width:100%}.fm-ch-side-label .fm-sharing-label{font-size:10px}.fm-shared-project-thumb{display:flex;align-items:center;justify-content:center;background:var(--bg,#f4f6f8);color:#98a2b3;font-size:30px}`;
    document.head.append(style);
  }
  function create(type,getOrg=organization){
    styles();let org='',incoming=[],outgoing=[],error='',epoch=0,prefs={ours:true,received:true,organizations:null};
    function syncOrg(){
      const next=String(getOrg()||'');
      if(next!==org){org=next;incoming=[];outgoing=[];error='';prefs={ours:true,received:true,organizations:null};
        try{const saved=JSON.parse(localStorage.getItem(`fm.sharing-view.v2.${org}.${type}`)||'null');if(saved){prefs.ours=saved.ours!==false;prefs.received=saved.received!==false;prefs.organizations=Array.isArray(saved.organizations)?saved.organizations.map(String):null;}}catch{}
      }return org;
    }
    async function pages(direction,oid){let after='',items=[],seen=new Set();do{const params=new URLSearchParams({type,limit:'100',...(after?{after}:{})});const page=await window.PlatformAPI.request(new URL(`/v1/collaboration/organizations/${encodeURIComponent(oid)}/${direction}?${params}`,location.origin).href);items.push(...(page.items||[]));after=page.next_cursor||'';if(seen.has(after))throw new Error('Could not finish loading sharing information.');seen.add(after);}while(after);return items;}
    async function load(){const oid=syncOrg(),version=++epoch;if(!oid||!window.PlatformAPI?.request)return;const results=await Promise.allSettled([pages('shared',oid),pages('shares',oid)]);if(version!==epoch||oid!==syncOrg())return;incoming=results[0].status==='fulfilled'?[...new Map(results[0].value.filter(i=>i.resource?.type===type).map(i=>[key(i.resource),i])).values()]:[];outgoing=results[1].status==='fulfilled'?results[1].value.filter(i=>i.resource?.type===type&&i.status==='active'):[];error=results.some(r=>r.status==='rejected'&&r.reason?.status!==403)?'Sharing information could not be loaded. Refresh to try again.':'';}
    function recipients(id,projectId){syncOrg();return outgoing.filter(i=>String(i.resource.id)===String(id)&&(!projectId||i.resource.project_id===projectId));}
    function matches(record,id=record.id,projectId){
      syncOrg();if(!incoming.length)return !record._shared;
      if(!record._shared)return prefs.ours;
      return prefs.received && (prefs.organizations===null || prefs.organizations.includes(record._shared.resource.owner_org_id));
    }
    function badge(record,id=record.id,projectId){const shared=record._shared,grants=recipients(id,projectId);const names=[...new Set(grants.map(i=>i.recipient?.name||'Partner organization'))];const label=shared?`From ${shared.owner?.name||'Partner organization'}`:names.length?`Shared with ${names.join(', ')}`:'';return label?`<span class="fm-sharing-label" title="${escape(label)}"><i class="fas fa-link" aria-hidden="true"></i>${escape(label)}</span>`:'';}
    function fields(){
      syncOrg();if(!incoming.length)return '';
      const noun={project:'projects',contact:'contacts',channel:'channels'}[type]||'items';
      const names=new Map(incoming.map(i=>[i.resource.owner_org_id,i.owner?.name||'Partner organization']));
      return `<div class="fm-sharing-fields"><fieldset><legend>Show ${noun}</legend><label><input type="checkbox" data-sharing-kind="ours" ${prefs.ours?'checked':''}> Our ${noun}</label><label><input type="checkbox" data-sharing-kind="received" ${prefs.received?'checked':''}> ${noun[0].toUpperCase()+noun.slice(1)} shared with us</label></fieldset>${prefs.received?`<fieldset class="fm-sharing-organizations"><legend>Shared by</legend>${[...names].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<label><input type="checkbox" data-sharing-owner="${escape(id)}" ${prefs.organizations===null||prefs.organizations.includes(id)?'checked':''}> <span>${escape(name)}</span></label>`).join('')}</fieldset>`:''}${error?`<p role="status">${escape(error)}</p>`:''}</div>`;
    }
    function change(event){
      syncOrg();const target=event.target;
      if(target.matches('[data-sharing-kind]'))prefs[target.dataset.sharingKind]=target.checked;
      else if(target.matches('[data-sharing-owner]')){const owners=new Set(prefs.organizations??incoming.map(i=>i.resource.owner_org_id));if(target.checked)owners.add(target.dataset.sharingOwner);else owners.delete(target.dataset.sharingOwner);prefs.organizations=[...owners];}
      else return false;
      try{localStorage.setItem(`fm.sharing-view.v2.${org}.${type}`,JSON.stringify(prefs));}catch{}return true;
    }
    return {load,matches,badge,fields,change,get incoming(){syncOrg();return incoming;},get mode(){syncOrg();return !incoming.length?'owned':prefs.ours?(prefs.received?'all':'owned'):(prefs.received?'received':'none');},get filtered(){syncOrg();return incoming.length>0&&(!prefs.ours||!prefs.received||prefs.organizations!==null);},get error(){return error;},id:item=>'shared:'+encodeURIComponent(key(item.resource))};
  }
  function open(item){window.__fmPendingCollaborationResource=item;window.Portal.tabs?.activateTab?.('partners');window.dispatchEvent(new CustomEvent('fm:collaboration:open',{detail:item}));}
  window.FirstMateSharedList={create,open};
})();
