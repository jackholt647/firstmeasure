(function(){
  'use strict';
  const Portal = window.Portal = window.Portal || {};
  if (Portal.CommunicationsUI) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const org = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '');
  const user = () => String(window.__APP?.userId || Portal.currentUser?.id || '');
  let initialSession;const loadedAt=Date.now();
  const request = async (path, body, method) => {
    // PHP bootstrap identity can differ from the authenticated platform membership.
    if (!initialSession && Portal.auth?.syncPlatformSession) initialSession=Portal.auth.syncPlatformSession();
    if (initialSession) await initialSession;
    try{return await window.CommsAPI.customer(org(), path, body, method);}
    catch(error){
      // The legacy portal bridge may still be materializing membership records at boot.
      // Retry only a read, once; never repeat an externally visible operation here.
      if(body!==undefined||(method&&method!=='GET')||error.code!=='not_found'||Date.now()-loadedAt>8000)throw error;
      await new Promise(resolve=>setTimeout(resolve,750));
      return window.CommsAPI.customer(org(),path,body,method);
    }
  };
  const uid = () => crypto.randomUUID();
  const icon = name => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'No due date';
  const label = value => String(value || '').replaceAll('_',' ').replace(/^./, c => c.toUpperCase());
  function css(){
    if (document.getElementById('fm-communications-css')) return;
    const link = document.createElement('link'); link.id='fm-communications-css'; link.rel='stylesheet';
    const source=new URL(document.currentScript?.src || `${location.origin}/libraries/apps/comms/communications-ui.js`);
    link.href=new URL(`communications.css${source.search||'?v=20260905-2'}`,source).href;
    document.head.append(link);
  }
  css();
  function notice(message){ Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("comms","m_643fa01aa77d59","Communications") ?? "Communications"),message,false); }
  function dialog(title, content, onSubmit, options={}){
    const el=document.createElement('dialog');el.className='fmcm-dialog';
    el.innerHTML=`<form><header><h2>${String(esc(title))}</h2><button type="button" data-close aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_3742924668fb10","Close") ?? "Close")}">${String(icon('xmark'))}</button></header><div class="fmcm-form-body">${String(content)}<p class="fmcm-error" role="alert" hidden></p></div><footer><button type="button" data-close>${(globalThis.PlatformLanguage?.htmlText("comms","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>${String(onSubmit?`<button class="fmcm-primary" type="submit">${esc(options.submit||'Save')}</button>`:'')}</footer></form>`;
    const before=document.activeElement;document.body.append(el);el.showModal();
    const close=()=>{el.close();el.remove();before?.focus?.();};
    el.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);
    el.addEventListener('cancel',event=>{event.preventDefault();close();});
    el.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(!onSubmit)return;
      const button=el.querySelector('[type=submit]'), error=el.querySelector('[role=alert]');button.disabled=true;error.hidden=true;
      try { await onSubmit(Object.fromEntries(new FormData(event.target)),el);close(); }
      catch(err){error.textContent=err.message;error.hidden=false;button.disabled=false;}
    };
    return el;
  }
  const field=(title,name,value='',type='text',extra='')=>`<label class="fmcm-field">${esc(title)}<input aria-label="${esc(title)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const area=(title,name,value='',extra='')=>`<label class="fmcm-field">${esc(title)}<textarea aria-label="${esc(title)}" name="${esc(name)}" ${extra}>${esc(value)}</textarea></label>`;
  const select=(title,name,values,selected='')=>`<label class="fmcm-field">${esc(title)}<select aria-label="${esc(title)}" name="${esc(name)}">${values.map(v=>{const [key,text]=Array.isArray(v)?v:[v,label(v)];return `<option value="${esc(key)}" ${key===selected?'selected':''}>${esc(text)}</option>`;}).join('')}</select></label>`;
  const empty=(title,body,action='')=>`<div class="fmcm-empty">${icon('comments')}<h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
  const projectField=(selected='')=>`<div data-project-picker>${field('Find a project','project_search','','search','placeholder="Search by project or customer name" autocomplete="off"')}${select('Project','project_id',[['','No project'],...(selected?[[selected,selected]]:[])],selected)}<p class="fmcm-help" data-project-status></p></div>`;
  function bindProjectPicker(el,selected=''){
    const host=el.querySelector('[data-project-picker]');if(!host)return;
    let sequence=0,timer;const input=host.querySelector('[name=project_search]'),select=host.querySelector('[name=project_id]'),status=host.querySelector('[data-project-status]');
    async function search(initial=false){const ticket=++sequence;status.textContent=(globalThis.PlatformLanguage?.text("comms","m_c38c62c76bb405","Finding projects…") ?? "Finding projects…");
      try{const data=await request(`call-context?${initial&&selected?`project_id=${encodeURIComponent(selected)}`:`query=${encodeURIComponent(input.value)}`}`);
        if(ticket!==sequence||!el.isConnected)return;const value=select.value;
        const retained=[...select.options].find(o=>o.value===value);select.innerHTML=`<option value="">${(globalThis.PlatformLanguage?.htmlText("comms","m_4e38a5f25060ba","No project") ?? "No project")}</option>`+(data.projects||[]).map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
        if(value&&!data.projects.some(p=>p.id===value)&&retained)select.append(retained);select.value=value;status.textContent=data.projects.length?'':'No matching projects.';
      }catch(error){if(ticket===sequence)status.textContent=error.message;}}
    input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>void search(),250);});void search(true);
  }
  function project(projectId,projectTab='comms',extra={}){
    if(!projectId)return;
    navigate({tab:'viewer',project:projectId,projectTab,...extra});
  }
  function navigate(patch){Portal.navigation?.push?.(patch);void Portal.navigation?.applyCurrent?.({source:'communications-link'});}
  Portal.CommunicationsUI={esc,org,user,request,uid,icon,date,label,notice,dialog,field,area,select,empty,project,navigate,projectField,bindProjectPicker};
})();
