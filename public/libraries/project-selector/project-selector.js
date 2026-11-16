/* Shared, bounded server-search project selector. Recent IDs stay local to this user.
   options.search(query) may replace the default search; it resolves to {results:[{id,title,subtitle}]}.
   options.inline keeps the results open under the input (a step of its own, not a dropdown);
   options.extraRows(query) adds inline rows after the results: [{title, subtitle, onSelect}]. */
(function(){
  if (window.FirstMateProjectSelector) return;
  function mount(host, options = {}) {
    const api = window.PlatformAPI, org = options.orgId;
    const key = `fm:recent-projects:${org}:${window.Portal?.cfg?.userId || window.__APP?.userId || 'session'}`;
    const inline = !!options.inline;
    let value = options.projectId || '', none = false, sequence = 0, timer, disposed = false;
    const id = `project-options-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    host.innerHTML = `<style>.fm-project-selector{position:relative}.fm-project-selector input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit}.fm-project-results{position:absolute;z-index:20;top:100%;left:0;right:0;max-height:280px;overflow:auto;background:white;border:1px solid #ddd;border-radius:8px;box-shadow:0 10px 25px #0002;padding:5px}.fm-project-results button{display:block;width:100%;border:0;background:white;text-align:left;padding:10px;border-radius:5px;font:inherit;cursor:pointer}.fm-project-results button:hover,.fm-project-results button:focus{background:#f2f4f7}.fm-project-results small{display:block;color:#667085}.fm-project-results [role=status]{padding:10px;color:#667085}.fm-project-selector-inline .fm-project-results{position:static;box-shadow:none;max-height:none;margin-top:8px}</style><div class="fm-project-selector${inline ? ' fm-project-selector-inline' : ''}"><input type="${inline ? 'search' : 'text'}" role="combobox" aria-label="${inline ? 'Search projects or type an address' : 'Project or lead (optional)'}" aria-autocomplete="list" aria-expanded="${inline}" aria-controls="${id}" placeholder="${inline ? 'Search projects or type an address' : 'No project — search to link one'}" autocomplete="off" enterkeyhint="search"><div id="${id}" class="fm-project-results" role="listbox" ${inline ? '' : 'hidden'}></div></div>`;
    const input = host.querySelector('input'), list = host.querySelector('[role=listbox]');
    function close(){if(inline)return;list.hidden=true;input.setAttribute('aria-expanded','false');}
    function recent(){try{return JSON.parse(sessionStorage.getItem(key)||'[]').slice(0,6);}catch{return [];}}
    function choose(row){
      value=row?.id || '';none=!row;input.value=row?.title || '';close();
      if(value)try{sessionStorage.setItem(key,JSON.stringify([value,...recent().filter(id=>id!==value)].slice(0,6)));}catch{}
      if(inline)list.querySelectorAll('[role=option]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.projectId===value&&!b.dataset.extraRow&&(!!value||none))));
      if(!inline)input.focus();close();options.onChange?.(value);options.onSelect?.(value);
    }
    function button(row){const b=document.createElement('button');b.type='button';b.setAttribute('role','option');b.dataset.projectId=row?.id||'';if(row?.onSelect)b.dataset.extraRow='true';b.setAttribute('aria-selected',String(!row?.onSelect&&value===(row?.id||'')&&(!inline||!!value||none)));const title=document.createElement('span');title.textContent=row?.title||'No project — assign later';b.append(title);if(row?.subtitle){const sub=document.createElement('small');sub.textContent=row.subtitle;b.append(sub);}b.onclick=()=>row?.onSelect?row.onSelect():choose(row);return b;}
    async function search(){
      const ticket=++sequence, query=input.value.trim();list.hidden=false;input.setAttribute('aria-expanded','true');list.replaceChildren(...(inline?[]:[button(null)]));
      const status=document.createElement('div');status.setAttribute('role','status');status.textContent='Searching…';list.append(status);
      const tail=()=>inline?[...(options.extraRows?.(query)||[]).map(button),button(null)]:[];if(inline)list.append(...tail());
      try{
        const results=await (options.search?options.search(query):api.search.projectsAndContacts(org,{query,types:'projects',limit:12}));
        let rows=results.results||[];
        if(!query){
          const docs=api?.projects?.get?await Promise.all(recent().map(id=>api.projects.get(org,id).then(result=>result.document).catch(()=>null))):[];
          const used=docs.filter(Boolean).map(doc=>({id:doc.id,title:doc.data?.title||doc.data?.customer_name||doc.id,subtitle:'Recently selected'}));
          rows=[...used,...rows.filter(row=>!used.some(item=>item.id===row.id))].slice(0,12);
        }
        if(disposed||ticket!==sequence)return;
        status.textContent=rows.length?(query?'Search results':'Recent projects'):(query?'No matching projects':'No recent projects');
        if(inline)list.replaceChildren(status,...rows.map(button),...tail());else rows.forEach(row=>list.append(button(row)));
      }catch(error){if(!disposed&&ticket===sequence)status.textContent=error.message||'Could not find projects.';}
    }
    if(!inline)input.addEventListener('focus',()=>void search());
    input.addEventListener('input',()=>{++sequence;none=false;clearTimeout(timer);if(value){value='';options.onChange?.('');}timer=setTimeout(search,180);});
    host.addEventListener('keydown',event=>{const buttons=[...list.querySelectorAll('button')];if(event.key==='Escape'&&!inline&&!list.hidden){event.preventDefault();event.stopPropagation();close();}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(list.hidden){void search();return;}const index=buttons.indexOf(document.activeElement);buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(event.key==='Enter'&&event.target===input){event.preventDefault();(inline?list.querySelector('[data-project-id]:not([data-project-id=""]),[data-extra-row]'):buttons[1])?.click();}});
    host.addEventListener('focusout',()=>setTimeout(()=>{if(!host.contains(document.activeElement))close();},0));
    const ready=(value&&api?.projects?.get?api.projects.get(org,value).then(result=>{if(!disposed&&value===options.projectId)input.value=result.document?.data?.title||value;}).catch(()=>{}):Promise.resolve()).then(()=>{if(inline&&!disposed)void search();});
    return {ready,input,refresh(){if(inline)void search();},get value(){return value;},setDisabled(disabled){input.disabled=disabled;if(disabled)close();},destroy(){disposed=true;++sequence;clearTimeout(timer);host.replaceChildren();}};
  }
  window.FirstMateProjectSelector={mount};
})();
