(function(){
  'use strict';
  const Portal=window.Portal=window.Portal||{};
  if(Portal.CustomerPhone)return;
  const ui=Portal.CommunicationsUI;
  const {esc,request,uid,icon,label,date,field,area,select,dialog}=ui;
  const terminal=new Set(['ended','canceled','failed','no_answer','busy','rejected']);
  const state={call:null,detail:null,entry:null,scripts:[],status:null,client:null,sdkCall:null,registered:false,available:false,
    busy:false,error:'',dirty:false,notes:'',answers:{},panel:null,minimized:false,muted:false,localId:uid(),prepared:{},poll:0,saveTimer:0,tokenTimer:0,heartbeat:0,readyPromise:null,openSequence:0};
  const audioKey='fm-customer-phone-audio';
  function audioPreferences(){try{return JSON.parse(localStorage.getItem(`${audioKey}:${scope()}`)||'{}');}catch{return {};}}
  function audioElement(){const audio=document.getElementById('fm-customer-call-audio')||document.createElement('audio');audio.id='fm-customer-call-audio';audio.autoplay=true;audio.hidden=true;if(!audio.isConnected)document.body.append(audio);return audio;}
  async function applyAudio(client,preferences=audioPreferences()){
    if(client)await client.setAudioSettings(preferences.microphone?{micId:preferences.microphone,deviceId:{exact:preferences.microphone}}:{});
    const audio=audioElement();if(audio.setSinkId)await audio.setSinkId(preferences.speaker||'');
    else if(preferences.speaker)throw new Error('This browser uses the system speaker. Choose System default or use a browser with speaker selection.');
  }
  // Each tab owns a distinct endpoint lease. Do not copy sessionStorage IDs across duplicated tabs.
  const deviceId=uid();
  const callPath=suffix=>`calls/${encodeURIComponent(state.call.id)}${suffix||''}`;
  function changed(){window.dispatchEvent(new CustomEvent('fm:customer-calls:changed',{detail:{call:state.call,registered:state.registered,available:state.available}}));}
  function ensurePanel(){
    if(state.panel)return state.panel;
    const el=document.createElement('aside');el.className='fmcp';el.setAttribute('aria-label',(globalThis.PlatformLanguage?.text("comms","m_f6ab2f58b94a8e","Customer call workspace") ?? "Customer call workspace"));el.hidden=true;document.body.append(el);state.panel=el;
    el.addEventListener('click',event=>{const button=event.target.closest('[data-phone]');if(button)void handle(button.dataset.phone,button);});
    el.addEventListener('input',event=>{
      if(event.target.name==='due_at'){state.policyDate='';state.usePolicy=false;}
      if(event.target.name==='notes'){state.notes=event.target.value;state.dirty=true;persistLocal();scheduleSave();}
      if(event.target.dataset.question!==undefined){state.answers[event.target.dataset.question]=event.target.value;state.dirty=true;persistLocal();scheduleSave();}
    });
    el.addEventListener('change',event=>{
      if(event.target.name==='disposition')render();
      if(event.target.name==='next_action'){el.querySelector('[data-follow-up]').hidden=event.target.value!=='follow_up';const appointments=el.querySelector('[data-appointments]');if(appointments)appointments.hidden=event.target.value!=='scheduled';}
      if(event.target.name==='contact_choice'){const contact=state.contacts?.find(c=>c.id===event.target.value);if(contact){el.querySelector('[name=customer_name]').value=contact.name;el.querySelector('[name=customer_number]').value=contact.phone;state.prepared.contact_id=contact.id;}}
    });
    return el;
  }
  function scope(){return `${ui.org()}:${ui.user()}`;}
  function localKey(){return `fm-call-draft:${state.boundScope||scope()}:${state.call?.id||state.localId}`;}
  function persistLocal(){try{sessionStorage.setItem(localKey(),JSON.stringify({notes:state.notes,answers:state.answers,at:Date.now()}));}catch{/* Server autosave remains authoritative. */}}
  function restoreLocal(){try{const draft=JSON.parse(sessionStorage.getItem(localKey())||'null');if(draft&&Date.now()-draft.at<86400000&&draft.notes!==state.call?.notes){state.notes=draft.notes;state.answers=draft.answers||{};state.dirty=true;}}catch{}}
  function readForm(){
    const el=state.panel;if(!el)return {};
    return Object.fromEntries([...el.querySelectorAll('[name]')].map(e=>[e.name,e.value]));
  }
  function render(){
    const focused=state.panel?.contains(document.activeElement)?document.activeElement:null;
    const focusName=focused?.name,focusQuestion=focused?.dataset?.question,caret=focused?.selectionStart,caretEnd=focused?.selectionEnd;
    const checked=new Set([...state.panel?.querySelectorAll('[data-source]:checked')||[]].map(e=>e.dataset.source));
    const el=ensurePanel(),c=state.call,p=state.prepared,values=readForm();el.hidden=false;el.classList.toggle('minimized',state.minimized);
    if(state.loadingCall){el.innerHTML=`<header class="fmcp-header"><strong style="flex:1" role="status">${(globalThis.PlatformLanguage?.htmlText("comms","m_8f38504a814a9d","Opening call…") ?? "Opening call…")}</strong><button data-phone="close" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_314202e0941af2","Close call workspace") ?? "Close call workspace")}">`+icon('xmark')+'</button></header>';return;}
    const consultation=c?.metadata?.transfer?.target_user_id===ui.user()&&c.owner_user_id!==ui.user()&&['dialing','consulting'].includes(c.metadata.transfer.state);
    const observer=c?.owner_user_id&&c.owner_user_id!==ui.user()&&!state.status?.permissions?.manage;
    const active=c?.mode==='browser'&&!terminal.has(c.state),saved=c?.wrap_up_state==='saved',processing=c?.wrap_up_state==='processing_effects';
    const connected=['connected','held'].includes(c?.state),incoming=state.sdkCall?.state==='ringing',script=c?.metadata?.script;
    const scriptData=script?.data||{};
    const title=c?.customer_name||p.customer_name||state.entry?.name||'New call';
    const number=c?.customer_number||p.customer_number||state.entry?.phone||'';
    const capture=c?.metadata?.capture?.state;
    const disposition=values.disposition||((c?.connected_at||c?.mode==='external')?'answered':'no_answer');
    const suggestion=state.followupOptions?.suggestions?.[['voicemail','no_answer'].includes(disposition)?disposition:'manual_follow_up'];
    const nextSteps=[['none','Keep open — no work completed'],['complete','Complete selected work'],['follow_up','Create follow-up'],...(c?.project_id?[['scheduled','Link booked appointment']]:[]),...(state.followupOptions?.follow_up_node_ids?.length?(state.followupOptions.outcomes||[]).filter(o=>o.action==='lost').map(o=>[`outcome:${o.id}`,o.label]):[])];
    el.innerHTML=`<header class="fmcp-header"><div class="fmcm-avatar">${String(icon('phone'))}</div><div><strong>${String(esc(title))}</strong><small>${String(esc(number))}${String(number?' · ':'')}<span data-call-status>${String(esc(c?`${label(c.state)}${c.mode==='external'?' · External phone':''}`:'Ready when you are'))}</span></small></div><button data-phone="minimize" aria-label="${((v5) => globalThis.PlatformLanguage?.htmlText("comms","m_21406d49c2fdb5",`${v5} call`,{v5}) ?? `${v5} call`)(state.minimized?'Expand':'Minimize')}">${String(icon(state.minimized?'expand':'minus'))}</button><button data-phone="close" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_314202e0941af2","Close call workspace") ?? "Close call workspace")}">${String(icon('xmark'))}</button></header>
      <div class="fmcp-body">${String(state.error?`<div class="fmcm-error" role="alert">${esc(state.error)}</div>`:'')}
      ${String(c?.metadata?.provider_error?`<p class="fmcm-error">${esc(c.metadata.provider_error.message)} <button data-phone="reconcile">${(globalThis.PlatformLanguage?.htmlText("comms","m_0594685d991928","Check provider status") ?? "Check provider status")}</button></p>`:'')}
      ${String((state.detail?.operations||[]).filter(job=>job.state==='failed'&&['wrap_up','recording_ingest','missed_callback'].includes(job.kind)).map(job=>`<p class="fmcm-error">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_c27c615bb5fb5f",`${v0} could not finish. Your call record is saved. `,{v0}) ?? `${v0} could not finish. Your call record is saved. `)(esc(label(job.kind)))}<button data-phone="retry-work" data-job="${esc(job.id)}">${(globalThis.PlatformLanguage?.htmlText("comms","m_6bf817428776f2","Retry saved work") ?? "Retry saved work")}</button></p>`).join(''))}
      ${String(c?`<div class="fmcp-controls">${incoming?`<button class="fmcm-primary" data-phone="answer">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_0675e6689d03c4",`${v0} Answer`,{v0}) ?? `${v0} Answer`)(icon('phone'))}</button><button data-phone="decline">${(globalThis.PlatformLanguage?.htmlText("comms","m_0bba16c1fd1444","Decline") ?? "Decline")}</button>`:''}
      ${consultation?`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_9dd0f47c454eb7","Consultation in progress. The customer is on hold with your teammate.") ?? "Consultation in progress. The customer is on hold with your teammate.")}</p><button data-phone="decline">${(globalThis.PlatformLanguage?.htmlText("comms","m_61a1d24eba2d59","Leave consultation") ?? "Leave consultation")}</button>`:active?`<button data-phone="mute" ${!state.sdkCall?'disabled':''}>${icon(state.muted?'microphone-slash':'microphone')} ${state.muted?'Unmute':'Mute'}</button><button data-phone="${c.state==='held'?'resume':'hold'}" ${!connected?'disabled':''}>${icon(c.state==='held'?'play':'pause')} ${c.state==='held'?'Resume':'Hold'}</button><button data-phone="keypad" ${!connected?'disabled':''}>${((v8) => globalThis.PlatformLanguage?.htmlText("comms","m_a5d2ced26e1d6f",`${v8} Keypad`,{v8}) ?? `${v8} Keypad`)(icon('grip'))}</button><button data-phone="transfer" ${!connected?'disabled':''}>${((v10) => globalThis.PlatformLanguage?.htmlText("comms","m_63420f2e9bb582",`${v10} Transfer`,{v10}) ?? `${v10} Transfer`)(icon('arrow-right-arrow-left'))}</button><button class="fmcm-danger" data-phone="hangup">${((v11) => globalThis.PlatformLanguage?.htmlText("comms","m_121a37c1f0d952",`${v11} End call`,{v11}) ?? `${v11} End call`)(icon('phone-slash'))}</button>`:''}
      ${c.project_id?`<button data-phone="project">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_d29bbd8b50abe3",`${v0} Project`,{v0}) ?? `${v0} Project`)(icon('folder-open'))}</button><button data-phone="schedule">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_1ba8da8140fc77",`${v1} Schedule`,{v1}) ?? `${v1} Schedule`)(icon('calendar-plus'))}</button><button data-phone="message">${((v2) => globalThis.PlatformLanguage?.htmlText("comms","m_b1ce44f713880b",`${v2} Message`,{v2}) ?? `${v2} Message`)(icon('comment'))}</button>`:`<button data-phone="link">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_d6f0ce6293e8d9",`${v0} Link project`,{v0}) ?? `${v0} Link project`)(icon('link'))}</button>`}
      ${connected&&(state.status?.settings?.recording_enabled||['recording','paused'].includes(capture))?`<button data-phone="record">${icon('circle-dot')} ${capture==='recording'?'Pause recording':capture==='paused'?'Resume recording':'Record with consent'}</button>${['recording','paused'].includes(capture)?`<button data-phone="record_stop">${(globalThis.PlatformLanguage?.htmlText("comms","m_71ef1099bbe0fc","Stop recording") ?? "Stop recording")}</button>`:''}`:''}</div>`:
      `${state.contacts?.length?select('Project contact','contact_choice',state.contacts.map(c=>[c.id,`${c.name} · ${c.phone||'No phone'}`]),p.contact_id||state.contacts[0].id):''}<div class="fmcm-form-grid">${field('Name','customer_name',values.customer_name??(title==='New call'?'':title),'text','autocomplete="name"')}${field('Phone number','customer_number',values.customer_number??number,'tel','required autocomplete="tel"')}</div>
      ${field('Reason for calling','purpose',values.purpose??p.purpose??state.entry?.title??'')}
      <div class="fmcm-form-grid">${select('Call using','mode',state.registered&&state.status?.settings?.enabled?[['browser','FirstMate phone'],['external','My external phone']]:[['external','My external phone']],values.mode||(state.registered?'browser':'external'))}${select('Call script','script_id',[['','No script'],...state.scripts.filter(s=>s.status==='published').map(s=>[s.id,s.title])],values.script_id||'')}</div>
      <p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_9aa1bceb154d29","External phone keeps your lists, scripts, notes, and follow-ups together. It does not record audio or measure call duration.") ?? "External phone keeps your lists, scripts, notes, and follow-ups together. It does not record audio or measure call duration.")}</p><button data-phone="start" class="fmcm-primary">${icon('phone')} ${state.registered?'Start call':'Start call notes'}</button>`)}
      ${String(script?.title?`<details class="fmcp-script" open><summary>${esc(script.title)} <span class="fmcm-pill">v${esc(script.version)}</span></summary>${(scriptData.sections||[]).map(s=>`<h4>${esc(s.title)}</h4><p>${esc(s.body)}</p>`).join('')}${(scriptData.questions||[]).map((q,i)=>`<label class="fmcm-field">${esc(q)}<input data-question="${i}" value="${esc(state.answers[i]||'')}"></label>`).join('')}</details>`:'')}
      ${String(c?.mode==='external'?`<p class="fmcm-help"><a href="tel:${esc(number)}">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_4b023574d976a1",`Open ${v1} in your phone app`,{v1}) ?? `Open ${v1} in your phone app`)(esc(number))}</a></p>`:'')}
      ${String(c?`<label class="fmcm-field">${(globalThis.PlatformLanguage?.htmlText("comms","m_d885eb7f0cdaa0","Call notes ") ?? "Call notes ")}<textarea class="fmcp-notes" name="notes" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_d59c66e54984e5","What happened? Capture decisions, concerns, and next steps.") ?? "What happened? Capture decisions, concerns, and next steps.")}">${esc(state.notes)}</textarea></label><p class="fmcm-help" data-save-state>${state.dirty?'Saving notes…':'Notes saved'}</p>`:'')}
      ${String(c&&!active&&!saved&&!processing?`<div class="fmcm-form-grid">${select('Call outcome','disposition',['answered','voicemail','no_answer','busy','wrong_number','callback','do_not_call','technical_failure'],values.disposition||((c.connected_at||c.mode==='external')?'answered':'no_answer'))}${select('Next step','next_action',nextSteps,values.next_action||'none')}</div>
      <div data-appointments ${values.next_action==='scheduled'?'':'hidden'}>${select('Booked appointment','appointment_id',[['','Choose an appointment'],...(state.appointments||[]).map(a=>[a.id,`${a.title||(globalThis.PlatformLanguage?.htmlText("comms","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")} · ${a.start||a.id}`])],values.appointment_id||'')}<button data-phone="refresh-context">${(globalThis.PlatformLanguage?.htmlText("comms","m_8b5406d39b44c7","Refresh appointments") ?? "Refresh appointments")}</button></div>
      ${(c.metadata?.source_node_ids||[]).length?`<details class="fmcp-script" open><summary>${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_465e01a14d53fd",`Linked work (${v0})`,{v0}) ?? `Linked work (${v0})`)(c.metadata.source_node_ids.length)}</summary><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_759c2a8bdbdc02","Select only the obligations this call resolves.") ?? "Select only the obligations this call resolves.")}</p>${c.metadata.source_node_ids.map(id=>`<label class="fmcm-check"><input type="checkbox" data-source="${esc(id)}">${esc(state.detail?.work?.find(node=>node.id===id)?.title||state.entry?.title||(globalThis.PlatformLanguage?.text("comms","m_5c4af3e82b50ff","Linked follow-up") ?? "Linked follow-up"))}</label>`).join('')}</details>`:''}
      <div data-follow-up ${values.next_action==='follow_up'?'':'hidden'}>${field('Follow-up title','title',values.title||((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_cfbb844d8f17be",`Follow up with ${v0}`,{v0}) ?? `Follow up with ${v0}`)(c.customer_name))}<div class="fmcm-actions" style="margin-bottom:12px">${suggestion?`<button data-phone="policy-date" data-due="${esc(suggestion.due_at)}" data-policy="true">${esc(suggestion.policy_step_label||'Use suggested date')}</button>`:''}${(state.followupOptions?.quick_options||[]).map(q=>`<button data-phone="policy-date" data-due="${esc(q.due_at)}">${esc(q.label)}</button>`).join('')}</div><div class="fmcm-form-grid">${field('Due at (your local time)','due_at',values.due_at||'','datetime-local')}${select('Channel','channel',['call','email','sms'],values.channel||'call')}</div>${state.policyDate?`<p class="fmcm-help">${((v0,v1) => globalThis.PlatformLanguage?.htmlText("comms","m_84873f911741da",`Follow-up: ${v0} · ${v1}`,{v0,v1}) ?? `Follow-up: ${v0} · ${v1}`)(esc(state.policyDate),esc(state.followupOptions?.timezone||''))}</p>`:''}</div>`:'')}
      ${String(saved?`<p><span class="fmcm-pill good">${icon('check')} ${esc(label(c.result?.disposition))}</span> <span class="fmcm-help">${esc(date(c.ended_at))}</span></p>`:'')}
      ${String(processing?`<p class="fmcm-help" role="status">${(globalThis.PlatformLanguage?.htmlText("comms","m_aa5c78e69f24d8","Saving the outcome and updating linked work…") ?? "Saving the outcome and updating linked work…")}</p>`:'')}
      ${String(c?`<div data-artifacts>${mediaMarkup()}</div>`:'')}</div>
      <footer class="fmcp-footer"><span class="fmcm-help">${String(c?`${c.direction==='inbound'?'Incoming':'Outgoing'} call`:state.entry?'Call list workspace':'Communications')}</span><div class="fmcm-actions">${String(!c&&state.entry?`<button data-phone="skip">${(globalThis.PlatformLanguage?.htmlText("comms","m_80ad5d823ed757","Skip for now") ?? "Skip for now")}</button>`:'')}${String(c&&!active&&!saved&&!processing?`<button class="fmcm-primary" data-phone="wrap">${(globalThis.PlatformLanguage?.htmlText("comms","m_6b7aea73ef8d46","Save outcome") ?? "Save outcome")}</button>`:'')}${String(saved&&state.entry?`<button class="fmcm-primary" data-phone="next">${(globalThis.PlatformLanguage?.htmlText("comms","m_db479b7b19a749","Next contact") ?? "Next contact")}</button>`:'')}${String(c&&!active?`<button data-phone="artifacts">${(globalThis.PlatformLanguage?.htmlText("comms","m_f15ce71ba3db6f","Recording & transcript") ?? "Recording & transcript")}</button>`:'')}</div></footer>`;
    el.querySelectorAll('[data-phone]').forEach(b=>{if(state.busy&&!['minimize','close'].includes(b.dataset.phone))b.disabled=true;});
    if(observer){el.querySelectorAll('[name], [data-question], [data-source]').forEach(e=>e.disabled=true);el.querySelectorAll('[data-phone]').forEach(b=>{if(!['minimize','close','project','schedule','message','artifacts',...(consultation?['answer','decline']:[])].includes(b.dataset.phone))b.disabled=true;});}
    if(!state.status?.permissions?.record)el.querySelectorAll('[data-phone^="record"]').forEach(b=>b.hidden=true);
    if(!state.status?.permissions?.recordings)el.querySelectorAll('[data-phone="artifacts"]').forEach(b=>b.hidden=true);
    if(state.busy)el.querySelectorAll('input,textarea,select').forEach(e=>e.disabled=true);
    if(state.saveError){const message=el.querySelector('[data-save-state]');if(message){message.textContent=(globalThis.PlatformLanguage?.text("comms","m_cb41039283b180","Notes are kept in this tab. ") ?? "Notes are kept in this tab. ");const retry=document.createElement('button');retry.dataset.phone='save-notes';retry.textContent=(globalThis.PlatformLanguage?.text("comms","m_5ede774dc3f22a","Retry saving") ?? "Retry saving");message.append(retry);}}
    el.querySelectorAll('[data-source]').forEach(e=>{e.checked=checked.has(e.dataset.source);});
    const focusTarget=focusQuestion!==undefined?el.querySelector(`[data-question="${CSS.escape(focusQuestion)}"]`):focusName?el.querySelector(`[name="${CSS.escape(focusName)}"]`):null;
    if(focusTarget){focusTarget.focus({preventScroll:true});try{focusTarget.setSelectionRange(caret,caretEnd);}catch{}}
  }
  async function refreshStatus(){state.status=await request('voice/status');changed();return state.status;}
  async function open(input={},options={}){
    state.boundScope=scope();
    if(state.diagnosing)throw new Error('Wait for the audio check to finish before opening a call.');
    if(state.call&&!terminal.has(state.call.state)&&state.call.id!==input.call_id){state.minimized=false;if(input.call_id||input.entry_id)state.error='Finish the active call before opening another contact.';render();return false;}
    const ticket=++state.openSequence;
    clearTimeout(state.saveTimer);if(state.dirty&&state.call)await saveNotes();
    if(ticket!==state.openSequence)return false;
    state.error='';state.minimized=false;state.entry=input.entry||null;state.prepared=input;state.notes='';state.answers={};state.contacts=[];state.appointments=[];state.media=null;state.followupOptions=null;state.policyDate='';state.usePolicy=false;state.wrapId='';state.wrapPayload=null;state.dirty=false;state.localId=uid();
    if(input.call_id){
      // Synchronous shell during browser-history restoration.
      state.call=null;state.loadingCall=true;render();let detail;
      try{detail=await request(`calls/${encodeURIComponent(input.call_id)}`);}finally{if(ticket===state.openSequence)state.loadingCall=false;}
      if(ticket!==state.openSequence)return false;state.detail=detail;state.call=state.detail.call;state.notes=state.call.notes||'';state.answers=state.call.metadata?.script_answers||{};restoreLocal();
      if(!options.fromRoute&&!Portal.navigation?.applying)Portal.navigation?.push?.({customerCall:state.call.id});
    }else{state.call=null;state.detail=null;}
    render();
    const results=await Promise.allSettled([refreshStatus(),request('call-scripts?published=true')]);
    if(ticket!==state.openSequence)return false;
    if(results[1].status==='fulfilled')state.scripts=results[1].value.scripts||[];
    await refreshContext().catch(error=>{if(ticket===state.openSequence)state.error=error.message;});if(ticket!==state.openSequence)return false;
    if(state.call)state.followupOptions=await request(callPath('/follow-up-options')).catch(()=>null);if(ticket!==state.openSequence)return false;
    render();if(state.call){schedulePoll();void request('conversation-workflow',{kind:'call',source_id:state.call.id,revision:0,action:'read'}).catch(()=>{});}else if(!options.fromRoute){state.panel.querySelector(`[name="${state.prepared.customer_number||state.entry?.phone?'purpose':'customer_number'}"]`)?.focus();}return true;
  }
  async function refreshContext(){const project=state.call?.project_id||state.prepared.project_id;if(!project)return;
    const ticket=state.openSequence,result=await request(`call-context?project_id=${encodeURIComponent(project)}`),context=result.projects?.[0];if(ticket!==state.openSequence)return;state.contacts=context?.contacts||[];state.appointments=context?.appointments||[];
    if(!state.call&&!state.prepared.customer_number&&!state.entry){const contact=state.contacts.find(c=>c.primary&&c.phone)||state.contacts.find(c=>c.phone);if(contact){Object.assign(state.prepared,{contact_id:contact.id,customer_name:contact.name,customer_number:contact.phone});const form=state.panel;if(form?.querySelector('[name=customer_number]')?.value===''){form.querySelector('[name=customer_name]').value=contact.name;form.querySelector('[name=customer_number]').value=contact.phone;}}}
  }
  async function start(){
    const values=readForm();if(!values.customer_number)throw new Error('Enter a phone number.');
    const body={...state.prepared,entry_id:state.entry?.id||state.prepared.entry_id||'',customer_name:values.customer_name,customer_number:values.customer_number,
      purpose:values.purpose,mode:values.mode,script_id:values.script_id,device_id:deviceId,operation_id:state.localId};delete body.entry;delete body.call_id;
    const result=await request('calls',body);state.call=result.call;state.notes=result.call.notes||'';state.answers={};
    state.detail=await request(callPath()).catch(()=>null);
    state.followupOptions=await request(callPath('/follow-up-options')).catch(()=>null);
    if(!Portal.navigation?.applying)Portal.navigation?.push?.({customerCall:state.call.id});changed();schedulePoll();
  }
  function scheduleSave(){clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>{void saveNotes().catch(error=>{state.error=error.message;state.saveError=true;render();});},800);}
  async function saveNotes(){
    while(state.saving)await state.saving;
    if(!state.call||!state.dirty)return;
    state.saving=performSaveNotes();
    try{await state.saving;state.saveError=false;}catch(error){state.saveError=true;throw error;}finally{state.saving=null;}
  }
  async function performSaveNotes(){
    if(!state.call||!state.dirty)return;const callId=state.call.id,notes=state.notes,answers={...state.answers};
    try{const result=await request(`calls/${encodeURIComponent(callId)}/draft`,{revision:state.call.revision,notes,script_answers:answers},'PATCH');if(state.call?.id===callId){state.call=result.call;state.dirty=state.notes!==notes||JSON.stringify(state.answers)!==JSON.stringify(answers);}}
    catch(error){if(error.status===409){const result=await request(`calls/${encodeURIComponent(callId)}`);if(state.call?.id===callId)state.call=result.call;throw new Error('This call changed while you were editing. Your notes are kept here; save again to apply them.');}throw error;}
    const message=state.panel?.querySelector('[data-save-state]');if(message)message.textContent=state.dirty?'Saving notes…':'Notes saved';
    if(state.dirty)scheduleSave();else try{sessionStorage.removeItem(localKey());}catch{}
  }
  async function action(action,extra={}){const result=await request(callPath('/actions'),{operation_id:uid(),action,...extra});state.call=result.call||state.call;changed();return result;}
  async function wrap(){
    const values=readForm();await saveNotes();
    const due=values.due_at?new Date(values.due_at).toISOString():'';
    const sources=[...state.panel.querySelectorAll('[data-source]:checked')].map(e=>e.dataset.source);
    const payload={operation_id:state.wrapId||(state.wrapId=uid()),revision:state.call.revision,disposition:values.disposition,notes:state.notes,next_action:values.next_action.startsWith('outcome:')?'complete':values.next_action,outcome_id:values.next_action.startsWith('outcome:')?values.next_action.slice(8):'',
      due_at:state.policyDate||due,use_policy:!!state.usePolicy,timezone:state.policyDate?state.followupOptions.timezone:Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone,channel:values.channel||'call',title:values.title||'',source_node_ids:sources,appointment_id:values.appointment_id||''};
    state.wrapPayload=state.wrapPayload||payload;
    let result;try{result=await request(callPath('/wrap-up'),state.wrapPayload);}catch(error){if(error.status&&error.status<500){state.wrapPayload=null;state.wrapId='';}throw error;}
    state.call=result.call;state.wrapId='';state.wrapPayload=null;changed();schedulePoll();
  }
  async function poll(){
    if(!ui.org()||!state.call)return;
    const id=state.call.id;
    const result=await request(`calls/${encodeURIComponent(id)}`);if(state.call?.id!==id)return;
    if(result.call.owner_user_id===ui.user()&&!terminal.has(result.call.state)&&(!state.lastLease||Date.now()-state.lastLease>30000)){await request(`calls/${encodeURIComponent(id)}/lease`,{});state.lastLease=Date.now();}
    const prior=state.call;state.call=result.call;state.detail=result;
    if(!state.dirty){state.notes=state.call.notes||'';state.answers=state.call.metadata?.script_answers||{};}
    // Preserve the user's caret and unsaved form values; redraw only a call-state transition.
    if(prior.state!==state.call.state||prior.wrap_up_state!==state.call.wrap_up_state||JSON.stringify(prior.metadata?.capture)!==JSON.stringify(state.call.metadata?.capture)||JSON.stringify(prior.metadata?.transfer)!==JSON.stringify(state.call.metadata?.transfer))render();
    changed();updateTransferDialog();
  }
  function schedulePoll(){clearTimeout(state.poll);state.poll=setTimeout(async()=>{try{await poll();}catch(error){state.error=error.message;}finally{if(state.call)schedulePoll();}},document.hidden?10000:2000);}
  async function artifacts(){
    const callId=state.call.id,result=await request(callPath('/artifacts'));if(state.call?.id===callId)state.media=result.artifacts||[];
  }
  function mediaMarkup(){
    if(!state.media)return '';
    return state.media.length?state.media.map(a=>`<section class="fmcp-script"><h4>${esc(label(a.kind))} <span class="fmcm-pill">${esc(label(a.state))}</span></h4>${a.kind==='transcript'&&a.state==='ready'?`<div class="fmcp-transcript">${esc(a.data?.text)}</div>`:a.state==='ready'?`<audio controls preload="none" src="${esc(window.CommsAPI.customerUrl(ui.org(),callPath(`/artifacts/${encodeURIComponent(a.id)}/media`)))}"></audio>`:''}${a.expires_at?`<p class="fmcm-help">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_e39e9d36bff8c0",`Available until ${v0}`,{v0}) ?? `Available until ${v0}`)(esc(date(a.expires_at)))}</p>`:''}${state.status?.permissions?.manage&&a.state!=='deleted'?("<button data-phone=\"delete-artifact\" data-artifact=\"" + String(esc(a.id)) + "\">" + ((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_35c5c05fb408d8",`Delete ${v1}`,{v1}) ?? `Delete ${v1}`)(esc(label(a.kind).toLowerCase())) + "</button>"):''}</section>`).join(''):`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_e3735034192fbd","No recording or transcript is available for this call.") ?? "No recording or transcript is available for this call.")}</p>`;
  }
  function removeArtifact(id){
    const callId=state.call.id;
    dialog('Delete call media', `<p>${(globalThis.PlatformLanguage?.htmlText("comms","m_8506d5637307fe","Permanently delete this recording or transcript? Deleting a recording also deletes its transcript. The call history and your notes remain.") ?? "Permanently delete this recording or transcript? Deleting a recording also deletes its transcript. The call history and your notes remain.")}</p>`,async()=>{
      await request(`calls/${encodeURIComponent(callId)}/artifacts/${encodeURIComponent(id)}`,undefined,'DELETE');
      if(state.call?.id===callId){await artifacts();render();}
    },{submit:'Delete media'});
  }
  async function linkProject(){
    const el=dialog('Link call to a project',ui.projectField(),async data=>{
      const id=data.project_id;if(!id)throw new Error('Choose a project.');
      const result=await request(callPath('/link'),{project_id:id,revision:state.call.revision});state.call=result.call;render();changed();
    });
    ui.bindProjectPicker(el);
  }
  async function transfer(){
    const result=await request('voice/center'),current=state.call.metadata?.transfer||{};
    if(['dialing','consulting'].includes(current.state)){
      const el=dialog('Transfer in progress',`<div data-transfer-controls><p data-transfer-status></p><div class="fmcm-actions"><button type="button" data-cancel-transfer>${(globalThis.PlatformLanguage?.htmlText("comms","m_9c4b861d7bfb10","Return to customer") ?? "Return to customer")}</button><button type="button" class="fmcm-primary" data-complete-transfer>${(globalThis.PlatformLanguage?.htmlText("comms","m_5e11d7ecf0739b","Complete transfer") ?? "Complete transfer")}</button></div><p data-transfer-error role="alert"></p></div>`,null);
      el.dataset.transferCall=state.call.id;updateTransferDialog();
      for(const [selector,command] of [['[data-cancel-transfer]','transfer_cancel'],['[data-complete-transfer]','transfer_complete']])el.querySelector(selector).onclick=async event=>{
        event.currentTarget.disabled=true;try{if(el.dataset.transferCall!==state.call?.id)throw new Error('This call is no longer open.');await action(command);el.close();el.remove();render();}
        catch(error){el.querySelector('[data-transfer-error]').textContent=error.message;event.target.disabled=false;}
      };return;
    }
    const agents=(result.agents||[]).filter(a=>a.user_id!==ui.user()&&a.availability==='available');
    dialog('Transfer call',select('Available teammate','target_user_id',agents.map(a=>[a.user_id,a.name]))+select('Handoff','transfer_mode',[['warm','Consult first'],['cold','Transfer when they answer']])+`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_e0e91e4856c71f","The customer waits on hold while your teammate answers. A failed transfer returns the customer to you.") ?? "The customer waits on hold while your teammate answers. A failed transfer returns the customer to you.")}</p>`,async data=>{if(!data.target_user_id)throw new Error('No teammates are available.');await action('transfer',data);render();},{submit:'Call teammate'});
  }
  function updateTransferDialog(){
    const el=document.querySelector('dialog[data-transfer-call]');if(!el||el.dataset.transferCall!==state.call?.id)return;
    const current=state.call.metadata?.transfer?.state;
    el.querySelector('[data-transfer-status]').textContent=current==='consulting'?'Your teammate answered. Finish the handoff when ready.':current==='dialing'?'Calling your teammate. The customer is on hold.':`Transfer ${label(current||'ended').toLowerCase()}.`;
    el.querySelector('[data-complete-transfer]').hidden=current!=='consulting';el.querySelector('[data-cancel-transfer]').hidden=!['dialing','consulting'].includes(current);
  }
  function keypad(){
    const el=dialog('Keypad',`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_0770dbf1ab92a1","Send digits to the connected call.") ?? "Send digits to the connected call.")}</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${String('123456789*0#'.split('').map(d=>`<button type="button" data-digit="${d}">${d}</button>`).join(''))}</div><p data-keypad-status role="status"></p>`,null);
    el.querySelectorAll('[data-digit]').forEach(button=>button.onclick=async()=>{try{await action('dtmf',{digits:button.dataset.digit});el.querySelector('[data-keypad-status]').textContent=((v0) => globalThis.PlatformLanguage?.text("comms","m_f357c1d81f96cb",`Sent ${v0}`,{v0}) ?? `Sent ${v0}`)(button.dataset.digit);}catch(error){el.querySelector('[data-keypad-status]').textContent=error.message;}});
  }
  async function record(){
    const capture=state.call.metadata?.capture?.state;
    if(capture==='recording'){await action('record_pause');return;}
    if(capture==='paused'){await action('record_resume');return;}
    dialog('Ask for recording permission',`<p>${String(esc(state.status?.settings?.disclosure))}</p><p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_1f3afb17c82258","Read this to the caller. Recording starts only after you confirm that they agreed.") ?? "Read this to the caller. Recording starts only after you confirm that they agreed.")}</p>`,async()=>{await action('consent',{consent:'granted'});await action('record_start');render();},{submit:'Caller agreed — start recording'});
  }
  async function next(skip=false){
    if(skip&&state.entry)await request(`call-list-entries/${encodeURIComponent(state.entry.id)}/skip`,{session_id:deviceId});
    const entryId=state.entry?.id;state.call=null;state.entry=null;ensurePanel().hidden=true;changed();
    window.dispatchEvent(new CustomEvent('fm:customer-calls:next',{detail:{entry_id:entryId,skip}}));
  }
  async function handle(name,button){
    if(name==='minimize'){state.minimized=!state.minimized;render();return;}
    if(name==='close'){if(state.busy||(state.call&&!terminal.has(state.call.state))){state.minimized=true;render();return;}try{await saveNotes();}catch(error){state.error=error.message;render();return;}state.openSequence++;state.loadingCall=false;state.panel.hidden=true;state.call=null;state.entry=null;state.prepared={};clearTimeout(state.poll);Portal.navigation?.backOrClose?.(['customerCall','communicationsEntry'],{customerCall:null,communicationsEntry:null});return;}
    if(state.busy)return;state.busy=true;state.error='';state.panel?.querySelectorAll('input,textarea,select,[data-phone]').forEach(e=>{if(!['minimize','close'].includes(e.dataset.phone))e.disabled=true;});
    try{
      if(name==='start')await start();else if(name==='wrap')await wrap();else if(name==='save-notes')await saveNotes();else if(name==='skip'||name==='next')await next(name==='skip');
      else if(name==='reconcile'){const result=await request(callPath('/reconcile'),{});state.call=result.call;}
      else if(name==='retry-work'){await request(callPath('/retry-work'),{job_id:button.dataset.job});await poll();}
      else if(name==='answer'){await state.sdkCall?.answer();}
      else if(name==='decline'){await action('decline');await state.sdkCall?.hangup();}
      else if(name==='mute'){if(!state.sdkCall)throw new Error('This tab does not own the phone audio.');state.muted=!state.muted;if(state.muted)state.sdkCall.muteAudio();else state.sdkCall.unmuteAudio();}
      else if(['project','schedule','message'].includes(name)){state.minimized=true;ui.project(state.call.project_id,name==='schedule'?'schedule':'comms',name==='message'?{commsView:'sms'}:{});}
      else if(name==='refresh-context')await refreshContext();
      else if(name==='policy-date'){state.policyDate=button.dataset.due;state.usePolicy=button.dataset.policy==='true';const input=state.panel.querySelector('[name=due_at]');if(input){const due=new Date(state.policyDate);input.value=state.policyDate.length===10?`${state.policyDate}T09:00`:new Date(due.getTime()-due.getTimezoneOffset()*60000).toISOString().slice(0,16);}}
      else if(name==='link')await linkProject();else if(name==='keypad')keypad();else if(name==='transfer')await transfer();else if(name==='record')await record();
      else if(name==='artifacts')await artifacts();
      else if(name==='delete-artifact')removeArtifact(button.dataset.artifact);
      else await action(name);
    }catch(error){state.error=error.message;}
    finally{state.busy=false;if(state.panel&&!state.panel.hidden){render();if(name==='artifacts')state.panel.querySelector('[data-artifacts]')?.scrollIntoView({block:'nearest'});}}
  }
  async function loadSDK(){
    if(window.TelnyxWebRTC?.TelnyxRTC)return;
    await new Promise((resolve,reject)=>{const el=document.createElement('script');el.src='/libraries/vendor/telnyx/webrtc-2.27.10.js';el.onload=resolve;el.onerror=()=>reject(new Error('The phone library could not load.'));document.head.append(el);});
  }
  async function heartbeat(){
    if(!state.client||!ui.org())return;
    try{const result=await request('voice/endpoint/presence',{device_id:deviceId,registered:state.registered,availability:state.available?'available':'unavailable'});state.available=result.availability==='available';changed();
      if(state.registered&&(!state.call||terminal.has(state.call.state))){const calls=await request(`calls?active=true&owner_user_id=${encodeURIComponent(ui.user())}`);const incoming=calls.calls?.find(c=>c.direction==='inbound'||c.owner_user_id===ui.user());const offered=result.offered_call_id||incoming?.id;if(offered)await open({call_id:offered});}}
    catch(error){state.available=false;state.error=error.message;changed();}
  }
  async function connect(){
    state.boundScope=scope();
    if(state.registered)return refreshStatus();if(state.readyPromise)return state.readyPromise;
    state.readyPromise=(async()=>{
      await loadSDK();const token=await request('voice/endpoint/token',{device_id:deviceId});
      const audio=audioElement();
      const client=new window.TelnyxWebRTC.TelnyxRTC({login_token:token.token});state.client=client;client.remoteElement=audio;
      await applyAudio(client);
      client.on('telnyx.notification',notification=>{
        if(client!==state.client||state.boundScope!==scope())return;
        if(notification.type!=='callUpdate'||!notification.call)return;
        const call=notification.call;state.sdkCall=call;
        if(call.state==='ringing'){
          const callTag=(call.options?.customHeaders||[]).find(header=>String(header.name).toLowerCase()==='x-firstmate-call')?.value;
          if(state.diagnosing&&state.diagnosticId&&callTag===state.diagnosticId){void call.answer({remoteElement:audio});return;}
          // Staff-first outbound leg is auto-answered only after this tab's explicit Start action.
          if(state.call?.direction==='outbound'&&state.call.metadata?.device_id===deviceId&&callTag===state.call.id)void call.answer({remoteElement:audio});
          else {void heartbeat();if(state.call){state.minimized=false;render();}}
        }
        if(['hangup','destroy'].includes(call.state)){state.sdkCall=null;state.muted=false;void poll().catch(()=>{});}else if(state.call)render();
      });
      client.on('telnyx.error',error=>{state.error=error?.message||'Phone connection failed.';state.registered=false;state.available=false;changed();});
      await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('The phone could not register. Check your network and try again.')),20000);
        client.on('telnyx.ready',()=>{clearTimeout(timeout);state.registered=true;resolve();});client.on('telnyx.error',()=>{clearTimeout(timeout);reject(new Error('Phone registration failed.'));});client.connect();});
      clearInterval(state.heartbeat);state.heartbeat=setInterval(()=>void heartbeat(),12000);await heartbeat();
      clearTimeout(state.tokenTimer);const delay=Math.max(30000,Date.parse(token.expires_at)-Date.now()-120000);
      const renew=()=>{if(state.call&&!terminal.has(state.call.state)){state.tokenTimer=setTimeout(renew,30000);return;}void disconnect().then(connect).catch(error=>{state.error=error.message;changed();});};
      state.tokenTimer=setTimeout(renew,Number.isFinite(delay)?delay:45*60000);
      return refreshStatus();
    })().catch(error=>{state.client?.disconnect();state.client=null;state.registered=false;state.available=false;clearInterval(state.heartbeat);throw error;}).finally(()=>{state.readyPromise=null;});return state.readyPromise;
  }
  async function disconnect(){
    await request('voice/endpoint/disconnect',{device_id:deviceId});state.client?.disconnect();state.client=null;state.registered=false;state.available=false;clearInterval(state.heartbeat);clearTimeout(state.tokenTimer);changed();
  }
  async function availability(value){state.available=value;await heartbeat();return state.available;}
  async function diagnose(){
    if(state.diagnosing)throw new Error('An audio check is already running.');
    if(state.call&&!terminal.has(state.call.state))throw new Error('Run the audio check between calls.');
    state.diagnosing=true;const wasAvailable=state.available;state.available=false;const samples=[];let microphone='unavailable',connected=false;
    try{
      await connect();await heartbeat();
      // The SDK microphone check always samples the system default. Check the chosen device.
      try{const preferences=audioPreferences(),stream=await navigator.mediaDevices.getUserMedia({audio:preferences.microphone?{deviceId:{exact:preferences.microphone}}:true});microphone=stream.getAudioTracks().some(track=>track.readyState==='live')?'ready':'unavailable';stream.getTracks().forEach(track=>track.stop());}
      catch(error){microphone=error.name==='NotAllowedError'?'denied':'unavailable';}
      if(microphone==='ready'){
        const check=await request('voice/diagnostics/start',{device_id:deviceId});state.diagnosticId=check.call_id;
        // A server-controlled SIP leg tests the real Telnyx media path without dialing a public test number.
        const deadline=Date.now()+23000;let mediaStarted=0;
        while(Date.now()<deadline){
          const peer=state.sdkCall?.peer?.instance;
          if(peer?.connectionState==='connected'){
            connected=true;if(!mediaStarted)mediaStarted=Date.now();const stats=await peer.getStats();
            let rtt,jitter,lost,received;
            stats.forEach(item=>{if(item.type==='candidate-pair'&&item.state==='succeeded'&&Number.isFinite(item.currentRoundTripTime))rtt=item.currentRoundTripTime*1000;
              if(item.type==='inbound-rtp'&&(item.kind==='audio'||item.mediaType==='audio')){if(Number.isFinite(item.jitter))jitter=item.jitter*1000;if(Number.isFinite(item.packetsReceived)){received=item.packetsReceived;lost=Math.max(0,item.packetsLost||0);}}});
            if([rtt,jitter,lost,received].every(Number.isFinite)&&received+lost>0)samples.push({rtt_ms:rtt,jitter_ms:jitter,packet_loss_percent:100*lost/(received+lost)});
            if(Date.now()-mediaStarted>=8000)break;
          }
          await new Promise(resolve=>setTimeout(resolve,500));
        }
      }
      const metrics=samples.length?Object.fromEntries(['rtt_ms','jitter_ms','packet_loss_percent'].map(key=>[key,samples.reduce((sum,s)=>sum+s[key],0)/samples.length])):undefined;
      return await request('voice/diagnostics',{device_id:deviceId,microphone,connectivity:connected?'ready':'inconclusive',provider_verdict:metrics?'ready':'inconclusive',...(metrics?{metrics}:{})});
    }finally{
      if(state.diagnosticId){await request(`calls/${encodeURIComponent(state.diagnosticId)}/actions`,{operation_id:uid(),action:'hangup'}).catch(()=>{});await state.sdkCall?.hangup();}
      state.diagnosticId='';state.diagnosing=false;state.sdkCall=null;state.available=wasAvailable;await heartbeat();
    }
  }
  async function devices(){
    if(state.call&&!terminal.has(state.call.state))throw new Error('Change devices between calls.');
    if(!navigator.mediaDevices)throw new Error('Use a supported browser over HTTPS to access audio devices.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());
    const list=await navigator.mediaDevices.enumerateDevices();
    const preferences=audioPreferences();
    dialog('Audio devices',select('Microphone','microphone',[['','System default'],...list.filter(d=>d.kind==='audioinput').map(d=>[d.deviceId,d.label||'Microphone'])],preferences.microphone)+select('Speaker','speaker',[['','System default'],...list.filter(d=>d.kind==='audiooutput').map(d=>[d.deviceId,d.label||'Speaker'])],preferences.speaker)+`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_9640d651adce54","Saved for your account in this browser. Run the readiness check after changing devices.") ?? "Saved for your account in this browser. Run the readiness check after changing devices.")}</p>`,async data=>{
      if(state.call&&!terminal.has(state.call.state))throw new Error('Change devices between calls.');
      const probe=await navigator.mediaDevices.getUserMedia({audio:data.microphone?{deviceId:{exact:data.microphone}}:true});probe.getTracks().forEach(track=>track.stop());
      await applyAudio(state.client,data);localStorage.setItem(`${audioKey}:${scope()}`,JSON.stringify({microphone:data.microphone,speaker:data.speaker}));
    });
  }
  Portal.navigation?.registerSchema?.('customerCall',{history:'push'});
  Portal.navigation?.registerHandler?.('customer-call-workspace',{priority:700,immediate:true,apply:route=>{
    if(!ui.org()||!ui.user())return;
    if(route.customerCall&&route.customerCall!==state.call?.id)void open({call_id:route.customerCall},{fromRoute:true}).catch(error=>{if(Portal.navigation?.read?.().customerCall===route.customerCall){state.error=error.message;render();}});
    else if(route.customerCall&&route.customerCall===state.call?.id&&state.panel?.hidden){state.minimized=false;render();}
    else if(!route.customerCall&&state.call&&terminal.has(state.call.state)){state.panel.hidden=true;}
    else if(!route.customerCall&&!route.communicationsEntry&&!state.call&&state.panel)state.panel.hidden=true;
  }});
  window.addEventListener('beforeunload',event=>{if((state.call?.mode==='browser'&&!terminal.has(state.call.state))||state.dirty){event.preventDefault();event.returnValue='';}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.panel&&!state.panel.hidden&&!document.querySelector('dialog[open]')){state.minimized=true;render();}});
  window.addEventListener('fm:platform-session:updated',()=>{
    if(!ui.org()||(state.boundScope&&state.boundScope!==scope())){
      state.openSequence++;state.loadingCall=false;
      if(state.dirty)persistLocal();state.client?.disconnect();state.client=null;state.sdkCall=null;state.registered=false;state.available=false;
      clearInterval(state.heartbeat);clearTimeout(state.poll);clearTimeout(state.tokenTimer);clearTimeout(state.saveTimer);
      if(state.panel)state.panel.hidden=true;state.call=null;state.dirty=false;state.notes='';state.answers={};state.boundScope='';changed();
    }
    if(ui.org()&&ui.user())void Portal.navigation?.applyCurrent?.({source:'phone-session-ready',only:'customer-call-workspace'});
  });
  Portal.CustomerPhone={open,connect,disconnect,availability,diagnose,devices,refreshStatus,saveNotes,deviceId,
    get status(){return state.status;},get connected(){return state.registered;},get available(){return state.available;},get currentCall(){return state.call;},get currentEntry(){return state.panel&&!state.panel.hidden?state.entry?.id:null;}};
  Portal.Communications=Portal.Communications||{};Portal.Communications.open=open;
})();
