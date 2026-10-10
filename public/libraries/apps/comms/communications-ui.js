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
    link.href=new URL('communications.css?v=20261009-group-text-v1',source).href;
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
  const phoneKey=value=>{const digits=String(value||'').replace(/\D/g,'');return digits.length===10?'1'+digits:digits;};
  const groupThread=thread=>thread?.group_mms===true||thread?.metadata?.sms_group?.mode==='group_mms';
  const members=thread=>thread?.participants||[];
  const phoneLabel=value=>Portal.PhoneTray?.formatPhone(value)||String(value||'');
  const threadTitle=thread=>groupThread(thread)?members(thread).map(member=>member.name||phoneLabel(member.address)).join(', '):thread.contact_name||phoneLabel(thread.contact_address)||'Conversation';
  async function textInbox(cursor){
    const [privateInbox,groups]=await Promise.all([cursor?Promise.resolve({conversations:[]}):window.CommsAPI.inbox(org(),{channel:'sms',limit:250}),window.CommsAPI.sms.groups.list(org(),{limit:100,...(cursor?{cursor}:{})})]);
    const conversations=new Map((privateInbox.conversations||[]).map(thread=>[thread.id,thread]));
    for(const group of groups.items||[])conversations.set(group.id,{...conversations.get(group.id),...group,group_mms:true});
    return {conversations:[...conversations.values()].sort((a,b)=>String(b.last_message_at||b.updated_at||b.last_message?.created_at||'').localeCompare(String(a.last_message_at||a.updated_at||a.last_message?.created_at||''))),nextCursor:groups.nextCursor};
  }
  async function textDetail(thread){
    if(!groupThread(thread)){const result=await window.CommsAPI.conversation(org(),thread.id),detail={...thread,...result.conversation};if(groupThread(detail))return textDetail(detail);return {thread:detail,messages:(result.conversation?.messages||[]).filter(message=>message.channel==='sms')};}
    const [detail,page]=await Promise.all([window.CommsAPI.sms.groups.get(org(),thread.id),window.CommsAPI.sms.groups.messages(org(),thread.id,{limit:100})]);
    return {thread:{...thread,...detail.conversation,group_mms:true},messages:[...(page.items||[])].reverse(),nextCursor:page.nextCursor};
  }
  function threadLine(thread){return thread.local_number||thread.metadata?.sms_group?.local_number||'';}
  async function textReply(thread,body,number){
    if(groupThread(thread))return window.CommsAPI.sms.groups.send(org(),thread.id,{text:body.text,idempotency_key:body.idempotency_key,...(body.image?{image_media_id:body.image.media_id}:{})});
    if(!number)throw new Error('Choose a text-ready company line.');
    return window.CommsAPI.reply(org(),thread.id,{...body,business_number:number});
  }
  function textDraft(contacts){let groupId='',groupSignature='';return async(body,number)=>{
    if(!number)throw new Error('Choose a text-ready company line.');
    if(contacts.length===1){const contact=contacts[0];if(!contact.project_id)throw new Error('This contact needs a project before you can text them.');const sent=await window.CommsAPI.sms.send(org(),contact.project_id,{to:contact.phone,...body,business_number:number});return {...sent,id:sent.message?.conversation_id};}
    const participants=contacts.map(contact=>({address:contact.phone,name:contact.name||'',...(contact.id?{contact_id:contact.id}:{})}));
    const signature=JSON.stringify([number,participants.map(item=>phoneKey(item.address)).sort()]);
    if(!groupId||groupSignature!==signature){const created=await window.CommsAPI.sms.groups.create(org(),participants,number);groupId=created.conversation.id;groupSignature=signature;}
    const sent=await textReply({id:groupId,group_mms:true},body,number);return {...sent,id:groupId};
  };}
  function messageContent(message,thread){
    const sender=typeof message.sender==='string'?message.sender:message.sender?.address;
    const author=members(thread).find(member=>phoneKey(member.address)===phoneKey(sender));
    const mediaId=message.image_media_id||message.metadata?.sms_image?.media_id;
    const attachments=message.attachments||message.metadata?.media||[];
    const urls=[...(mediaId?[window.PlatformAPI.media.fileUrl(org(),mediaId)]:[]),...attachments.filter(item=>/^image\//i.test(item.content_type||'')).map(item=>item.url)].filter(url=>{try{return ['https:','http:'].includes(new URL(url,location.origin).protocol);}catch{return false;}});
    return `${groupThread(thread)&&message.direction==='inbound'?`<strong class="fm-text-author">${esc(author?.name||phoneLabel(sender)||'Participant')}</strong>`:''}<span class="fm-text-body">${esc(message.text||'')}</span>${urls.map(url=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="Attached image" loading="lazy"></a>`).join('')}<small>${esc(date(message.created_at))}${message.direction==='outbound'&&message.status?' · '+esc(label(message.status)):''}</small>${message.deliveries?.length?`<details class="fm-text-deliveries"><summary>Delivery (${message.deliveries.length})</summary>${message.deliveries.map(item=>`<div>${esc(members(thread).find(member=>phoneKey(member.address)===phoneKey(item.recipient))?.name||phoneLabel(item.recipient))}: ${esc(label(item.status))}</div>`).join('')}</details>`:''}`;
  }
  function memberSummary(thread){return groupThread(thread)?`<details class="fm-text-members"><summary>${members(thread).length} participants</summary>${members(thread).map(member=>`<div><strong>${esc(member.name||phoneLabel(member.address))}</strong>${member.name?` <span>${esc(phoneLabel(member.address))}</span>`:''}</div>`).join('')}</details>`:'';}
  function lineLabel(number){const line=(Portal.CustomerPhone?.status?.numbers||[]).find(item=>phoneKey(item.phone_number)===phoneKey(number));return `Text using ${esc(line?.label||'Phone line')} (${esc(phoneLabel(number).replace(/^\((\d{3})\) /,'$1-'))})`;}
  function recipientPicker(root,{initial=[],onCompose,isCurrent=()=>root.isConnected}){
    const selected=new Map(initial.map(contact=>[phoneKey(contact.phone),contact]));let matches=[],searchId=0,timer;
    root.innerHTML=`<div class="fm-text-recipients" aria-label="Selected recipients"></div><label class="fm-phone-search">${icon('magnifying-glass')}<input type="search" aria-label="Find a contact to text" placeholder="Search contacts" autocomplete="off"></label><div data-text-contacts class="fm-text-contact-list"></div><p class="fm-phone-error" data-recipient-error role="alert" hidden></p><div class="fm-text-recipient-footer"><span data-recipient-count></span><button type="button" data-compose-recipients>${icon('comment-sms')} Continue</button></div>`;
    const input=root.querySelector('input'),list=root.querySelector('[data-text-contacts]'),error=root.querySelector('[data-recipient-error]'),button=root.querySelector('[data-compose-recipients]');
    function render(){root.querySelector('.fm-text-recipients').innerHTML=[...selected].map(([key,contact])=>`<button type="button" data-remove-recipient="${esc(key)}" aria-label="Remove ${esc(contact.name||phoneLabel(contact.phone))}">${esc(contact.name||phoneLabel(contact.phone))}${icon('xmark')}</button>`).join('');button.disabled=!selected.size;root.querySelector('[data-recipient-count]').textContent=`${selected.size}/8 selected`;
      list.innerHTML=matches.map((contact,index)=>`<button type="button" class="fm-phone-result" data-text-contact="${index}" aria-pressed="${selected.has(phoneKey(contact.phone))}" ${contact.phone?'':'disabled'}><span class="fm-phone-person">${icon(selected.has(phoneKey(contact.phone))?'circle-check':'user')}</span><span>${esc(contact.name||'Contact')}<small>${esc(phoneLabel(contact.phone)||'No phone number')}</small></span></button>`).join('')||'<p class="fm-phone-thread-empty">No matching contacts.</p>';}
    list.onclick=event=>{const row=event.target.closest('[data-text-contact]');if(!row)return;const contact=matches[Number(row.dataset.textContact)],key=phoneKey(contact.phone);error.hidden=true;if(selected.has(key))selected.delete(key);else if(selected.size<8)selected.set(key,contact);else{error.textContent='A group can have up to 8 recipients.';error.hidden=false;}render();};
    root.querySelector('.fm-text-recipients').onclick=event=>{const row=event.target.closest('[data-remove-recipient]');if(row){selected.delete(row.dataset.removeRecipient);render();}};
    button.onclick=()=>onCompose([...selected.values()]);
    async function load(){const id=++searchId,query=input.value;list.textContent='Loading contacts...';try{const result=await request(`voice/contacts?query=${encodeURIComponent(query)}`);if(!isCurrent()||id!==searchId||input.value!==query)return;matches=result.contacts||[];render();}catch(err){if(isCurrent()&&id===searchId)list.textContent=err.message;}}
    input.oninput=()=>{searchId++;clearTimeout(timer);timer=setTimeout(()=>void load(),180);};render();void load();input.focus();
  }
  Portal.PhoneTexting={isGroup:groupThread,title:threadTitle,line:threadLine,inbox:textInbox,detail:textDetail,reply:textReply,draft:textDraft,messageContent,memberSummary,lineLabel,recipientPicker};
  Portal.CommunicationsUI={esc,org,user,request,uid,icon,date,label,notice,dialog,field,area,select,empty,project,navigate,projectField,bindProjectPicker};
})();
