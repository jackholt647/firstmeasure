/* Completion widgets: confirming that work is done (work.completion) and reviewing the project's photos beside it
 * (project.photos.review). Both are declared in catalog.json. Hosts own what a confirmation means; the completion
 * widget only reports which items the person confirmed and how, and the host passes that to an authorized action
 * (labor.list.finalize, project-closeout.close), which checks it again. */
(function(global){
  'use strict';
  const W=global.FirstMateWidgets;if(!W||global.FirstMateCompletionWidgets)return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=cents=>cents==null?'':`$${(Number(cents)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const METHODS=['approve','select_all','each'];
  function styles(){
    if(document.getElementById('fm-completion-widget-styles'))return;
    const el=document.createElement('style');el.id='fm-completion-widget-styles';el.textContent=`
    .fmc{display:flex;flex-direction:column;gap:10px;min-width:0;font-size:12px;color:#101828}
    .fmc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px}
    .fmc-head strong{display:block;font-size:12px;font-weight:800}.fmc-head span{display:block;margin-top:2px;font-size:11px;color:#667085}
    .fmc-head button,.fmc-approve{flex:none;height:30px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
    .fmc-head button:hover:not(:disabled){background:#f2f4f7}.fmc-head button:disabled{opacity:.5;cursor:default}
    .fmc-group{border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;background:#fff}
    .fmc-group>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:#f8fafc;border-bottom:1px solid #eaecf0;font-size:11px;font-weight:800;color:#344054}
    .fmc-group>header em{font-style:normal;font-weight:600;color:#667085}
    .fmc-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid #f0f2f5;cursor:pointer;transition:background-color .15s ease}
    .fmc-row:first-of-type{border-top:0}.fmc-row:hover{background:#f9fafb}
    .fmc-row input{width:15px;height:15px;margin:0;accent-color:#079455;cursor:pointer}
    .fmc-row .fmc-label{min-width:0}.fmc-row .fmc-label strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fmc-row .fmc-label span{display:block;margin-top:1px;font-size:11px;color:#667085}
    .fmc-row .fmc-amount{font-variant-numeric:tabular-nums;font-weight:700;color:#344054}
    .fmc-row.is-confirmed{background:#f6fef9}.fmc-row.is-confirmed .fmc-label strong{color:#067647}
    .fmc-row.is-done{cursor:default;opacity:.75}.fmc-row .fmc-dot{width:8px;height:8px;border-radius:50%;background:#d0d5dd;justify-self:center}
    .fmc-row.is-confirmed .fmc-dot{background:#079455}
    .fmc-done{font-size:10px;font-weight:800;color:#067647;background:#ecfdf3;border-radius:999px;padding:2px 7px;margin-left:6px}
    .fmc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 2px 0;color:#475467}
    .fmc-foot strong{font-size:13px;color:#101828;font-variant-numeric:tabular-nums}
    .fmc-approve{height:34px;padding:0 16px;border-color:#079455;background:#079455;color:#fff;font-size:12px}
    .fmc-approve:hover{filter:brightness(.95)}.fmc-approve.is-approved{background:#ecfdf3;color:#067647;border-color:#abefc6}
    .fmc-hint{font-size:11px;color:#667085}.fmc-empty{padding:18px;border:1px dashed #d0d5dd;border-radius:10px;text-align:center;color:#667085}
    .fmp{display:flex;flex-direction:column;gap:10px;min-width:0;font-size:12px}
    .fmp-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 10px;min-height:30px}
    .fmp-head strong{display:block;font-size:12px;font-weight:800;color:#101828}.fmp-head span{display:block;margin-top:2px;font-size:11px;color:#667085}
    .fmp-head button{white-space:nowrap;height:30px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:11px;font-weight:700;cursor:pointer}
    .fmp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
    .fmp-tile{position:relative;aspect-ratio:1;border:0;border-radius:9px;overflow:hidden;background:#eef1f5;padding:0;cursor:zoom-in;outline:2px solid transparent;outline-offset:1px;transition:outline-color .15s ease}
    .fmp-tile img{width:100%;height:100%;object-fit:cover;display:block}.fmp-tile:hover{outline-color:#98a2b3}
    .fmp-tile.is-reviewed{outline-color:#079455}.fmp-tile .fmp-badge{position:absolute;right:5px;top:5px;width:20px;height:20px;border-radius:50%;background:#079455;color:#fff;display:none;place-items:center;font-size:10px;box-shadow:0 1px 3px rgba(0,0,0,.25)}
    .fmp-tile.is-reviewed .fmp-badge{display:grid}
    .fmp-tile figcaption{position:absolute;left:0;right:0;bottom:0;padding:14px 6px 4px;font-size:10px;color:#fff;background:linear-gradient(transparent,rgba(16,24,40,.7));text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fmp-empty{padding:28px 14px;border:1px dashed #d0d5dd;border-radius:10px;text-align:center;color:#667085}
    .fmp-view{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.86);display:grid;grid-template-rows:auto minmax(0,1fr);padding:14px}
    .fmp-view header{display:flex;align-items:center;justify-content:space-between;color:#fff;gap:10px;padding-bottom:10px}
    .fmp-view header button{height:32px;padding:0 12px;border:1px solid rgba(255,255,255,.35);border-radius:8px;background:transparent;color:#fff;font:inherit;font-size:12px;cursor:pointer}
    .fmp-view img{max-width:100%;max-height:100%;margin:auto;object-fit:contain;border-radius:8px}
    `;document.head.append(el);
  }
  function reader(context){return context.read||((source,target)=>global.PlatformAPI.publication.read(target.organizationId,{...source,target}));}

  /* work.completion: confirm that each item of a piece of work is done. One parameter changes how: `approve` is a single
   * button and no checkboxes, `select_all` (the default) is checkboxes with Select all, `each` is checkboxes that must
   * each be checked. Items already done are shown and need nothing. The selection says what was confirmed and whether
   * every line item is confirmed (`complete`); hosts enable their final confirm on it. */
  W.attachRenderer('work.completion','1',async(root,{data,config,context,reference,state,notifySelection})=>{
    styles();
    const method=METHODS.includes(config.method)?config.method:'select_all',target=reference.target||context.target||{};
    const args={...(config.list_id?{list_id:config.list_id}:{}),...(config.materials?{materials:true}:{}),...(config.requirements?{requirements:true}:{})};
    async function load(){const result=await reader(context)({provider:'labor-completion',export:'items',args},target);if(result.status!=='ready')throw Error(result.message||'The items are unavailable.');return result.value;}
    // The runtime's first read carries no arguments; read again when this instance asks for one list or for more kinds.
    if(context.data?.[reference.id]===undefined&&Object.keys(args).length)data=await load();
    let items=Array.isArray(data?.items)?data.items:[],alive=true;
    const confirmed=new Set([...(state?.confirmed_item_ids||[]),...(state?.confirmed_material_ids||[]),...(state?.confirmed_requirement_ids||[])]);
    let approved=state?.approved===true;
    const pending=()=>items.filter(item=>!item.done),lines=()=>pending().filter(item=>item.kind==='line');
    const isOn=item=>item.done||(method==='approve'?approved:confirmed.has(item.id));
    const complete=()=>method==='approve'?approved||!lines().length:lines().every(item=>confirmed.has(item.id));
    function selection(){
      const ids=kind=>pending().filter(item=>item.kind===kind&&isOn(item)).map(item=>item.id).slice(0,100);
      return {method,complete:complete(),approved:method==='approve'&&approved,confirmed_item_ids:ids('line'),confirmed_material_ids:ids('material'),confirmed_requirement_ids:ids('requirement')};
    }
    const label=()=>{const total=pending().length,on=pending().filter(isOn).length;return method==='approve'?(approved?'Approved':'Not approved yet'):`${on} of ${total} confirmed`;};
    function report(){notifySelection(selection(),{confirmed:complete(),label:label()});}
    function render(){
      const groups=new Map();
      for(const item of items){const key=item.kind==='line'?'line:'+item.list_id:item.kind;if(!groups.has(key))groups.set(key,{title:item.kind==='line'?item.list_title:item.kind==='material'?'Materials':'Requirements',items:[]});groups.get(key).items.push(item);}
      const total=pending().length,on=pending().filter(isOn).length,sum=items.filter(item=>item.kind==='line'&&isOn(item)).reduce((value,item)=>value+(Number(item.total_cents)||0),0);
      const allOn=total>0&&on===total;
      const prompt=esc(config.prompt||(method==='approve'?'Approve the work as done':method==='each'?'Check each item that is done':'Confirm what is done'));
      const hint=method==='approve'?'One approval confirms every item.':method==='each'?'Each item has to be checked on its own.':'Check what is done, or select all.';
      const row=item=>{const on=isOn(item),control=method==='approve'||item.done?'<span class="fmc-dot" aria-hidden="true"></span>':`<input type="checkbox" data-fmc-item="${esc(item.id)}" ${on?'checked':''} aria-label="${esc(item.label)} is done">`;
        return `<label class="fmc-row${on?' is-confirmed':''}${item.done?' is-done':''}" data-fmc-row="${esc(item.id)}">${control}<span class="fmc-label"><strong title="${esc(item.label)}">${esc(item.label)}${item.done?'<span class="fmc-done">Done</span>':''}</strong>${item.detail&&item.kind!=='line'?`<span>${esc(item.detail)}</span>`:item.kind==='line'&&item.detail?`<span>${esc(String(item.detail).split(' · ')[0])}</span>`:''}</span><span class="fmc-amount">${item.kind==='line'?esc(money(item.total_cents)):''}</span></label>`;};
      root.innerHTML=`<div class="fmc" data-method="${method}"><div class="fmc-head"><div><strong>${prompt}</strong><span>${esc(hint)}</span></div>${method==='select_all'&&total?`<button type="button" data-fmc-all>${allOn?'Clear all':'Select all'}</button>`:''}</div>
        ${items.length?[...groups.values()].map(group=>`<section class="fmc-group"><header><span>${esc(group.title)}</span><em>${group.items.filter(isOn).length} of ${group.items.length}</em></header>${group.items.map(row).join('')}</section>`).join(''):'<div class="fmc-empty">Nothing to confirm.</div>'}
        <div class="fmc-foot"><span class="fmc-hint" data-fmc-status>${esc(label())}</span>${method==='approve'&&total?`<button type="button" class="fmc-approve${approved?' is-approved':''}" data-fmc-approve><i class="fas ${approved?'fa-check':'fa-thumbs-up'}" aria-hidden="true"></i>${approved?'Approved':'Approve'}</button>`:`<span>Confirmed <strong>${esc(money(sum))}</strong></span>`}</div></div>`;
      root.querySelectorAll('[data-fmc-item]').forEach(input=>input.onchange=()=>{if(input.checked)confirmed.add(input.dataset.fmcItem);else confirmed.delete(input.dataset.fmcItem);render();report();});
      root.querySelector('[data-fmc-all]')?.addEventListener('click',()=>{const clear=pending().every(item=>confirmed.has(item.id));for(const item of pending())clear?confirmed.delete(item.id):confirmed.add(item.id);render();report();});
      root.querySelector('[data-fmc-approve]')?.addEventListener('click',()=>{approved=!approved;render();report();});
    }
    render();report();
    return {selection,serialize:()=>{const s=selection();return {approved:s.approved,confirmed_item_ids:s.confirmed_item_ids,confirmed_material_ids:s.confirmed_material_ids,confirmed_requirement_ids:s.confirmed_requirement_ids};},
      async refresh(){const next=context.data?.[reference.id]||await load();if(!alive)return;items=Array.isArray(next?.items)?next.items:[];render();report();},destroy(){alive=false;root.replaceChildren();}};
  });

  /* project.photos.review: the project's photos beside a confirmation. Opening a photo marks it reviewed; the selection
   * is the reviewed photos, which a host records as the evidence that was looked at. */
  W.attachRenderer('project.photos.review','1',async(root,{data,config,context,reference,state,notifySelection})=>{
    styles();
    const target=reference.target||context.target||{},org=target.organizationId||global.__APP?.userOrgId||'';
    const limit=Number.isInteger(config.limit)?config.limit:60;
    if(context.data?.[reference.id]===undefined&&limit!==120){const result=await reader(context)({provider:'media',export:'library',args:{limit}},target);if(result.status!=='ready')throw Error(result.message||'Photos are unavailable.');data=result.value;}
    let photos=Array.isArray(data?.items)?data.items:[],alive=true,viewer=null;
    const reviewed=new Set(Array.isArray(state?.media_ids)?state.media_ids:[]);
    const src=(id,variant)=>global.PlatformAPI?.media?.fileUrl?global.PlatformAPI.media.fileUrl(org,id,variant):'';
    const selection=()=>({media_ids:[...reviewed].filter(id=>photos.some(photo=>photo.id===id)).slice(0,50)});
    const report=()=>notifySelection(selection(),{confirmed:reviewed.size>0,label:`${reviewed.size} reviewed`});
    function open(photo){
      reviewed.add(photo.id);render();report();viewer?.remove();
      viewer=document.createElement('div');viewer.className='fmp-view';viewer.setAttribute('role','dialog');viewer.setAttribute('aria-label',photo.label||'Photo');
      viewer.innerHTML=`<header><span>${esc(photo.label||photo.file_name||'Photo')}</span><button type="button" data-fmp-close>Close</button></header><img alt="${esc(photo.label||'Project photo')}">`;
      const img=viewer.querySelector('img');img.src=src(photo.id,'display');img.onerror=()=>{img.onerror=null;img.src=src(photo.id,'original');};
      const close=()=>{viewer?.remove();viewer=null;document.removeEventListener('keydown',key,true);};
      const key=event=>{if(event.key==='Escape'){event.stopPropagation();event.preventDefault();close();}};
      viewer.onclick=event=>{if(event.target===viewer||event.target.closest('[data-fmp-close]'))close();};
      document.addEventListener('keydown',key,true);
      (root.closest('dialog')||document.body).append(viewer);
    }
    function render(){
      root.innerHTML=`<div class="fmp"><div class="fmp-head"><div><strong>${esc(config.prompt||'Project photos')}</strong><span>${photos.length?`${reviewed.size} of ${photos.length} reviewed. Open a photo to look at it.`:'Photos taken on this project appear here.'}</span></div>${photos.length&&reviewed.size<photos.length?'<button type="button" data-fmp-all>Mark all reviewed</button>':''}</div>
        ${photos.length?`<div class="fmp-grid">${photos.map(photo=>`<button type="button" class="fmp-tile${reviewed.has(photo.id)?' is-reviewed':''}" data-fmp-photo="${esc(photo.id)}" title="${esc(photo.label||photo.file_name||'Photo')}"><img loading="lazy" alt="${esc(photo.label||'Project photo')}" data-fmp-img="${esc(photo.id)}"><span class="fmp-badge"><i class="fas fa-check" aria-hidden="true"></i></span>${photo.label?`<figcaption>${esc(photo.label)}</figcaption>`:''}</button>`).join('')}</div>`:'<div class="fmp-empty"><i class="fas fa-camera" aria-hidden="true"></i> No photos on this project yet.</div>'}</div>`;
      root.querySelectorAll('[data-fmp-img]').forEach(img=>{const id=img.dataset.fmpImg;img.src=src(id,'thumb_320');img.onerror=()=>{img.onerror=()=>{img.onerror=null;img.src=src(id,'original');};img.src=src(id,'display');};});
      root.querySelectorAll('[data-fmp-photo]').forEach(button=>button.onclick=()=>{const photo=photos.find(entry=>entry.id===button.dataset.fmpPhoto);if(photo)open(photo);});
      root.querySelector('[data-fmp-all]')?.addEventListener('click',()=>{photos.forEach(photo=>reviewed.add(photo.id));render();report();});
    }
    render();if(reviewed.size)report();
    return {selection,serialize:()=>selection(),async refresh(){const result=await reader(context)({provider:'media',export:'library',args:{limit}},target);if(!alive||result.status!=='ready')return;photos=Array.isArray(result.value?.items)?result.value.items:[];render();},destroy(){alive=false;viewer?.remove();root.replaceChildren();}};
  });
  global.FirstMateCompletionWidgets={methods:METHODS.slice()};
})(window);
