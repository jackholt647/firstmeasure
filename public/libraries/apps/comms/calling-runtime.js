(function(){
  'use strict';
  const Portal=window.Portal=window.Portal||{};
  if(Portal.CustomerPhone)return;
  const ui=Portal.CommunicationsUI;
  const {esc,request,uid,icon,label,date,field,area,select,dialog}=ui;
  const terminal=new Set(['ended','canceled','failed','no_answer','busy','rejected']);
  const state={call:null,detail:null,entry:null,scripts:[],status:null,client:null,sdkCall:null,registered:false,available:false,
    busy:false,error:'',dirty:false,notes:'',answers:{},panel:null,minimized:false,muted:false,localId:uid(),prepared:{},poll:0,saveTimer:0,tokenTimer:0,heartbeat:0,readyPromise:null,connectionSequence:0,connecting:false,disconnectPromise:null,openSequence:0};
  const audioKey='fm-customer-phone-audio';
  function audioPreferences(){try{return JSON.parse(localStorage.getItem(`${audioKey}:${scope()}`)||'{}');}catch{return {};}}
  function audioElement(){const audio=document.getElementById('fm-customer-call-audio')||document.createElement('audio');audio.id='fm-customer-call-audio';audio.autoplay=true;audio.hidden=true;if(!audio.isConnected)document.body.append(audio);return audio;}
  async function applyAudio(client,preferences=audioPreferences()){
    if(client)await client.setAudioSettings(preferences.microphone?{micId:preferences.microphone,deviceId:{exact:preferences.microphone}}:{});
    const audio=audioElement();if(audio.setSinkId)await audio.setSinkId(preferences.speaker||'');
    else if(preferences.speaker)throw new Error('This browser uses the system speaker. Choose System default or use a browser with speaker selection.');
  }
  // Keep a tab's endpoint identity across reloads. Web Locks prevent a duplicated
  // tab (which copies sessionStorage) from borrowing a still-open tab's identity.
  const identityKey='fm-customer-phone-tab';let deviceId=uid();
  try{deviceId=sessionStorage.getItem(identityKey)||deviceId;}catch{}
  function persistIdentity(){try{sessionStorage.setItem(identityKey,deviceId);}catch{}}
  function ownIdentity(){
    if(!navigator.locks){if(performance.getEntriesByType('navigation')[0]?.type!=='reload')deviceId=uid();persistIdentity();return Promise.resolve();}
    return new Promise(resolve=>{
      void navigator.locks.request(`firstmate-phone:${deviceId}`,{ifAvailable:true},async lock=>{
        if(!lock){deviceId=uid();await ownIdentity();resolve();return;}
        persistIdentity();resolve();await new Promise(()=>{});
      }).catch(()=>{deviceId=uid();persistIdentity();resolve();});
    });
  }
  const identityReady=ownIdentity();
  const callPath=suffix=>`calls/${encodeURIComponent(state.call.id)}${suffix||''}`;
  function changed(){queueMicrotask(()=>void advanceDialer());window.dispatchEvent(new CustomEvent('fm:customer-calls:changed',{detail:{call:state.call,registered:state.registered,available:state.available}}));}
  // A document-lifetime lock prevents two tabs from running a list for this caller.
  // Each call still uses the server's atomic entry/phone claim and operation ID.
  const dialer={active:false,listId:'',listIds:[],fast:false,title:'',seen:new Set(),timer:0,deadline:0,working:false,generation:0,release:null,message:''};
  function pauseDialer(message='Automatic dialing paused.'){
    dialer.active=false;dialer.generation++;clearInterval(dialer.timer);dialer.timer=0;dialer.deadline=0;dialer.release?.();dialer.release=null;dialer.message=message;
    state.panel?.querySelector('[data-dialer]')?.replaceWith(dialerElement());
  }
  function dialerMarkup(){return dialer.listId?`<section class="fmcp-dialer" data-dialer aria-label="Automatic dialing"><strong>${esc(dialer.title||'Call list')}</strong><p role="status">${esc(dialer.deadline?`Next call in ${Math.max(0,Math.ceil((dialer.deadline-Date.now())/1000))} seconds`:dialer.active?dialer.message||'Automatic dialing on · Finish the call and save any required outcome.':dialer.message)}</p>${dialer.active?'<button type="button" data-phone="pause-dialer">Pause automatic dialing</button>':'<button type="button" data-phone="resume-dialer">Resume automatic dialing</button>'}</section>`:'';}
  function dialerElement(){const wrap=document.createElement('div');wrap.innerHTML=dialerMarkup();return wrap.firstElementChild||document.createElement('span');}
  async function startDialer(list){
    if(dialer.active)pauseDialer();
    if(!navigator.locks)throw new Error('Automatic dialing needs a browser with Web Locks. You can still call contacts individually.');
    const acquired=await new Promise((resolve,reject)=>{void navigator.locks.request(`firstmate-auto-dialer:${scope()}`,{ifAvailable:true},async lock=>{if(!lock){resolve(false);return;}await new Promise(release=>{dialer.release=release;resolve(true);});}).catch(reject);});
    if(!acquired)throw new Error('Automatic dialing is already running in another tab. Pause it there first.');
    const listIds=Array.isArray(list.listIds)&&list.listIds.length?list.listIds:[list.id];
    if(dialer.listId!==list.id||JSON.stringify(dialer.listIds)!==JSON.stringify(listIds)){dialer.seen=new Set();dialer.listId=list.id;}
    dialer.listIds=listIds;dialer.fast=!!list.power;dialer.title=list.title||dialer.title;dialer.departmentId=list.departmentId||'';dialer.active=true;dialer.message='';dialer.generation++;dialer.boundScope=scope();
    if(state.call?.entry_id)dialer.seen.add(state.call.entry_id);
    try{if(!state.status)await refreshStatus();}catch(error){pauseDialer(error.message);throw error;}
    if(!state.status?.settings?.enabled){pauseDialer('Enable browser calling before starting automatic dialing.');throw new Error(dialer.message);}
    await advanceDialer();if(state.panel&&!state.panel.hidden)render();
  }
  async function advanceDialer(){
    if(!dialer.active||dialer.working||dialer.deadline||dialer.timer||state.busy)return;
    if(dialer.boundScope!==scope()||state.error||state.saveError){pauseDialer('Automatic dialing paused. Resolve the phone error before continuing.');return;}
    const c=state.call;
    if(c&&!terminal.has(c.state))return;
    if(c?.state==='failed'||c?.metadata?.provider_error||(state.detail?.operations||[]).some(o=>['uncertain','failed'].includes(o.state))){pauseDialer('Automatic dialing paused. Review this call before continuing.');return;}
    if(c&&(state.dirty||c.wrap_up_state==='processing_effects'||state.status?.settings?.require_disposition&&c.wrap_up_state!=='saved'))return;
    dialer.working=true;const generation=dialer.generation;
    try{
      const result=await request(`call-lists/queue${dialer.departmentId?'?department_id='+encodeURIComponent(dialer.departmentId):''}`);
      if(!dialer.active||generation!==dialer.generation)return;
      const entry=(result.columns||[]).filter(list=>dialer.listIds.includes(list.id)).flatMap(list=>list.tasks||[]).find(e=>e.ready&&!dialer.seen.has(e.id));
      if(!entry){dialer.message='Waiting for new leads in the selected lists…';state.panel?.querySelector('[data-dialer]')?.replaceWith(dialerElement());dialer.timer=setTimeout(()=>{dialer.timer=0;void advanceDialer();},5000);return;}
      dialer.message='';
      if(await open({entry,entry_id:entry.id,project_id:entry.project_id})===false){pauseDialer('Finish the current call before resuming.');return;}
      if(!dialer.active||generation!==dialer.generation)return;
      dialer.deadline=Date.now()+(dialer.fast?0:c?Math.max(5,Number(state.status?.settings?.wrap_up_seconds)||0):5)*1000;
      render();dialer.timer=setInterval(()=>{
        state.panel?.querySelector('[data-dialer]')?.replaceWith(dialerElement());
        if(state.call){clearInterval(dialer.timer);dialer.timer=0;dialer.deadline=0;return;}
        if(Date.now()<dialer.deadline)return;clearInterval(dialer.timer);dialer.timer=0;dialer.deadline=0;
        if(!dialer.active||generation!==dialer.generation)return;
        dialer.seen.add(entry.id);
        void handle('start').then(()=>{if(!state.call){pauseDialer(state.deviceCheckRequired?'Run the audio check, then start this contact manually. Resume the list when ready.':'Automatic dialing paused. Check your phone before continuing.');}else if(state.call.state==='failed')pauseDialer('Call failed. Review it before continuing.');if(state.panel&&!state.panel.hidden)render();});
      },250);
    }catch(error){pauseDialer(error.message||'Automatic dialing paused.');state.error=error.message;if(state.panel&&!state.panel.hidden)render();}
    finally{dialer.working=false;}
  }
  function callPermission(name){return state.detail?.permissions?.[name]??state.status?.permissions?.[name]??false;}
  function supervisionMarkup(){
    const s=state.detail?.supervision,p=s?.permissions||{},session=s?.session;
    if(!state.call||state.call.owner_user_id===ui.user()||!['connected','held'].includes(state.call.state)||!Object.values(p).some(Boolean)&&!session)return '';
    const joined=session&&!['ended','failed','taken_over'].includes(session.state),pending=joined&&!['active'].includes(session.state);
    return `<section class="fmcp-supervision"><strong>Supervisor controls</strong><p class="fmcm-help">${esc(joined?`${label(session.mode)} · ${label(session.state)}`:'Listen privately, coach your teammate, or join the conversation.')}</p><div class="fmcm-actions">${[['monitor','Live listen'],['whisper','Whisper'],['barge','Barge'],['takeover','Take over']].filter(([mode])=>p[mode]).map(([mode,title])=>`<button type="button" data-phone="supervise" data-mode="${mode}" ${pending||session?.mode===mode?'disabled':''}>${title}</button>`).join('')}${joined?'<button type="button" data-phone="supervise" data-mode="leave">Leave supervision</button>':''}</div>${session?.state==='uncertain'?'<p class="fmcm-error">Connection status is uncertain. Review provider status before trying again.</p>':''}</section>`;
  }
  async function supervise(mode){
    if(mode!=='leave')await connect();
    const callId=state.call.id,result=await request(callPath('/supervision'),{operation_id:uid(),mode});
    if(state.call?.id!==callId)return;
    state.call=result.call||state.call;state.detail={...state.detail,supervision:result.supervision};schedulePoll();changed();
  }
  function analysisMarkup(){
    if(!state.call||!callPermission('analyze')&&!callPermission('analysis_read'))return '';
    const notes=state.analysis?.notes||[],canAnalyze=callPermission('analyze');
    return `<details class="fmcp-script fmcp-analysis" ${state.analysisOpen?'open':''}><summary>AI notes &amp; questions</summary><p class="fmcm-help">Use the retained transcript to draft notes and answer questions. Review generated content before using it.</p><label class="fmcm-field" ${canAnalyze?'':'hidden'}>Instructions<textarea name="analysis_prompt" maxlength="4000" placeholder="Summarize decisions, concerns, and next steps.">${esc(state.analysisPrompt||'')}</textarea></label><div class="fmcm-actions"><button type="button" data-phone="analysis-generate" ${canAnalyze?'':'hidden'} ${state.analysisBusy?'disabled':''}>Generate notes</button><button type="button" data-phone="analysis-load" ${state.analysisBusy?'disabled':''}>View saved notes</button></div>${state.analysisBusy?'<p role="status">Preparing the request…</p>':''}${state.analysisError?`<p class="fmcm-error" role="alert">${esc(state.analysisError)}</p>`:''}${state.analysis&&!state.analysis.available?'<p class="fmcm-help">A retained transcript is needed. Enable transcription in Phone Setup and wait for processing to finish.</p>':''}${notes.map(n=>`<article class="fmcp-ai-note"><h4>${esc(n.question||'Call summary')}</h4><p class="fmcm-help">${esc(date(n.created_at))}</p><div class="fmcp-transcript">${esc(n.state==='failed'?(n.error||'Analysis failed. Try generating notes again.'):['pending','running'].includes(n.state)?'Reading the transcript…':n.text)}</div>${(n.citations||[]).length?`<p class="fmcm-help">Sources: ${n.citations.map(c=>esc(c.label)).join(' · ')}</p>`:''}${canAnalyze&&!n.question&&n.state==='ready'?`<button type="button" data-phone="analysis-append" data-note="${esc(n.id)}">Append to call notes</button>`:''}</article>`).join('')}<label class="fmcm-field" ${canAnalyze?'':'hidden'}>Ask about this call<input name="analysis_question" maxlength="2000" value="${esc(state.analysisQuestion||'')}" placeholder="What did we agree to do next?"></label><button type="button" data-phone="analysis-ask" ${canAnalyze?'':'hidden'} ${state.analysisBusy?'disabled':''}>Ask question</button></details>`;
  }
  async function analyze(kind,button){
    state.analysisOpen=true;
    if(kind==='append'){const note=state.analysis?.notes?.find(n=>n.id===button.dataset.note);if(note){state.notes=[state.notes,note.text].filter(Boolean).join('\n\n');state.dirty=true;persistLocal();await saveNotes();}return;}
    const callId=state.call.id,base=`calls/${encodeURIComponent(callId)}/analysis`;
    if(kind==='load'){const analysis=await request(base);if(state.call?.id===callId)state.analysis=analysis;return;}
    if(kind==='ask'&&!state.analysisQuestion?.trim())throw new Error('Enter a question about the call.');
    state.analysisBusy=true;state.analysisError='';render();
    const payload={system_prompt:state.analysisPrompt||'',...(kind==='ask'?{question:state.analysisQuestion.trim()}:{})};
    const fingerprint=JSON.stringify(payload);if(state.analysisRequest?.fingerprint!==fingerprint)state.analysisRequest={fingerprint,operation_id:uid()};
    try{await request(base,{...payload,operation_id:state.analysisRequest.operation_id});if(state.call?.id!==callId)return;state.analysis=await request(base);state.analysisRequest=null;if(kind==='ask')state.analysisQuestion='';}
    catch(error){if(state.call?.id===callId)state.analysisError=error.message;}
    finally{if(state.call?.id===callId)state.analysisBusy=false;}
  }
  function ensurePanel(){
    if(state.panel)return state.panel;
    const el=document.createElement('aside');el.className='fmcp';el.setAttribute('aria-label',(globalThis.PlatformLanguage?.text("comms","m_f6ab2f58b94a8e","Customer call workspace") ?? "Customer call workspace"));el.hidden=true;document.body.append(el);state.panel=el;
    Portal.PhoneTray?.attach(el,{panel:()=>state.panel,action:handle,minimized:value=>{state.minimized=value;state.panel?.classList.toggle('minimized',value);}});
    el.addEventListener('click',event=>{const button=event.target.closest('[data-phone]');if(button)void handle(button.dataset.phone,button);});
    el.addEventListener('input',event=>{
      if(event.target.name==='analysis_prompt')state.analysisPrompt=event.target.value;
      if(event.target.name==='analysis_question')state.analysisQuestion=event.target.value;
      if(event.target.name==='due_at'){state.policyDate='';state.usePolicy=false;}
      if(event.target.name==='notes'){state.notes=event.target.value;state.dirty=true;persistLocal();scheduleSave();}
      if(event.target.dataset.question!==undefined){state.answers[event.target.dataset.question]=event.target.value;state.dirty=true;persistLocal();scheduleSave();}
    });
    el.addEventListener('change',event=>{
      if(event.target.name==='next_action'){const appointments=el.querySelector('[data-appointments]');if(appointments)appointments.hidden=event.target.value!=='scheduled';}
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
    if(state.panel?.querySelector('.fmcp-analysis'))state.analysisOpen=state.panel.querySelector('.fmcp-analysis').open;
    const checked=new Set([...state.panel?.querySelectorAll('[data-source]:checked')||[]].map(e=>e.dataset.source));
    const el=ensurePanel(),c=state.call,p=state.prepared,values=readForm();el.hidden=false;el.classList.toggle('minimized',state.minimized);
    if(state.loadingCall){el.innerHTML=`<header class="fmcp-header"><strong style="flex:1" role="status">${(globalThis.PlatformLanguage?.htmlText("comms","m_8f38504a814a9d","Opening call…") ?? "Opening call…")}</strong><button data-phone="close" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_314202e0941af2","Close call workspace") ?? "Close call workspace")}">`+icon('xmark')+'</button></header>';return;}
    const consultation=c?.metadata?.transfer?.target_user_id===ui.user()&&c.owner_user_id!==ui.user()&&['dialing','consulting'].includes(c.metadata.transfer.state);
    const observer=c?.owner_user_id&&c.owner_user_id!==ui.user();
    const supervising=state.detail?.supervision?.session&&!['ended','failed','taken_over'].includes(state.detail.supervision.session.state);
    const active=c?.mode==='browser'&&!terminal.has(c.state),saved=c?.wrap_up_state==='saved',processing=c?.wrap_up_state==='processing_effects';
    const connected=['connected','held'].includes(c?.state),incoming=state.sdkCall?.state==='ringing',script=c?.metadata?.script;
    const scriptData=script?.data||{};
    const title=c?.customer_name||p.customer_name||state.entry?.name||'New call';
    const number=c?.customer_number||p.customer_number||state.entry?.phone||'';
    const capture=c?.metadata?.capture?.state;
    const nextSteps=[['none','Keep open — no work completed'],['complete','Complete selected work'],...(c?.project_id?[['scheduled','Link booked appointment']]:[]),...(state.followupOptions?.follow_up_node_ids?.length?(state.followupOptions.outcomes||[]).filter(o=>o.action==='lost').map(o=>[`outcome:${o.id}`,o.label]):[])];
    el.innerHTML=`<header class="fmcp-header"><div class="fmcm-avatar">${String(icon('phone'))}</div><div><strong>${String(esc(title))}</strong><small>${String(esc(number))}${String(number?' · ':'')}<span data-call-status>${String(esc(c?`${label(c.state)}${c.mode==='external'?' · External phone':''}`:'Ready when you are'))}</span></small></div><button data-phone="minimize" aria-label="${((v5) => globalThis.PlatformLanguage?.htmlText("comms","m_21406d49c2fdb5",`${v5} call`,{v5}) ?? `${v5} call`)(state.minimized?'Expand':'Minimize')}">${String(icon(state.minimized?'expand':'minus'))}</button><button data-phone="close" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_314202e0941af2","Close call workspace") ?? "Close call workspace")}">${String(icon('xmark'))}</button></header>
      <div class="fmcp-body">${!c&&state.connecting?'<p class="fmcm-help" role="status" aria-live="polite">Connecting…</p>':''}${c&&(terminal.has(c.state)||c.mode==='external')&&(saved||!state.status?.settings?.require_disposition)?'<button data-phone="new-call">New call</button>':''}${String(state.error?`<div data-phone-error class="fmcm-error" role="alert">${esc(state.error)}</div>`:'')}
      ${state.deviceCheckRequired&&!c?`<section data-phone-readiness role="status"><p class="fmcm-help">${esc(state.checkMessage||'Run the microphone and network check before calling on this device. Your call details will stay here.')}</p><button data-phone="diagnose" class="fmcm-primary">${state.busy?'Checking microphone and network…':'Run checks'}</button></section>`:''}
      ${state.deviceChecked&&state.checkMessage&&!c?`<p data-phone-check-success class="fmcm-help" role="status">${esc(state.checkMessage)} Click Start call when you are ready.</p>`:''}
      ${state.outcomeRequested&&c&&!saved?`<p class="fmcm-help" role="status">${active?'Ending the call…':'Choose the call outcome, then click Save outcome to finish.'}</p>`:''}
      ${dialerMarkup()}${supervisionMarkup()}
      ${String(c?.metadata?.provider_error?`<p class="fmcm-error">${esc(c.metadata.provider_error.message)} <button data-phone="reconcile">${(globalThis.PlatformLanguage?.htmlText("comms","m_0594685d991928","Check provider status") ?? "Check provider status")}</button></p>`:'')}
      ${String((state.detail?.operations||[]).filter(job=>job.state==='failed'&&['wrap_up','recording_ingest','missed_callback'].includes(job.kind)).map(job=>`<p class="fmcm-error">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_c27c615bb5fb5f",`${v0} could not finish. Your call record is saved. `,{v0}) ?? `${v0} could not finish. Your call record is saved. `)(esc(label(job.kind)))}<button data-phone="retry-work" data-job="${esc(job.id)}">${(globalThis.PlatformLanguage?.htmlText("comms","m_6bf817428776f2","Retry saved work") ?? "Retry saved work")}</button></p>`).join(''))}
      ${String(c?`<div class="fmcp-controls">${incoming?`<button class="fmcm-primary" data-phone="answer">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_0675e6689d03c4",`${v0} Answer`,{v0}) ?? `${v0} Answer`)(icon('phone'))}</button><button data-phone="decline">${(globalThis.PlatformLanguage?.htmlText("comms","m_0bba16c1fd1444","Decline") ?? "Decline")}</button>`:''}
      ${consultation?`<p class="fmcm-help">${(globalThis.PlatformLanguage?.htmlText("comms","m_9dd0f47c454eb7","Consultation in progress. The customer is on hold with your teammate.") ?? "Consultation in progress. The customer is on hold with your teammate.")}</p><button data-phone="decline">${(globalThis.PlatformLanguage?.htmlText("comms","m_61a1d24eba2d59","Leave consultation") ?? "Leave consultation")}</button>`:active&&!observer?`<button data-phone="mute" ${!state.sdkCall?'disabled':''}>${icon(state.muted?'microphone-slash':'microphone')} ${state.muted?'Unmute':'Mute'}</button><button data-phone="${c.state==='held'?'resume':'hold'}" ${!connected?'disabled':''}>${icon(c.state==='held'?'play':'pause')} ${c.state==='held'?'Resume':'Hold'}</button><button data-phone="keypad" ${!connected?'disabled':''}>${((v8) => globalThis.PlatformLanguage?.htmlText("comms","m_a5d2ced26e1d6f",`${v8} Keypad`,{v8}) ?? `${v8} Keypad`)(icon('grip'))}</button><button data-phone="transfer" ${!connected?'disabled':''}>${((v10) => globalThis.PlatformLanguage?.htmlText("comms","m_63420f2e9bb582",`${v10} Transfer`,{v10}) ?? `${v10} Transfer`)(icon('arrow-right-arrow-left'))}</button><button class="fmcm-danger" data-phone="hangup">${((v11) => globalThis.PlatformLanguage?.htmlText("comms","m_121a37c1f0d952",`${v11} End call`,{v11}) ?? `${v11} End call`)(icon('phone-slash'))}</button>`:''}
      ${c.project_id?`<button data-phone="project">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_d29bbd8b50abe3",`${v0} Project`,{v0}) ?? `${v0} Project`)(icon('folder-open'))}</button><button data-phone="schedule">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_1ba8da8140fc77",`${v1} Schedule`,{v1}) ?? `${v1} Schedule`)(icon('calendar-plus'))}</button><button data-phone="message">${((v2) => globalThis.PlatformLanguage?.htmlText("comms","m_b1ce44f713880b",`${v2} Message`,{v2}) ?? `${v2} Message`)(icon('comment'))}</button>`:`<button data-phone="link">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_d6f0ce6293e8d9",`${v0} Link project`,{v0}) ?? `${v0} Link project`)(icon('link'))}</button>`}
      ${connected&&(state.status?.settings?.recording_enabled||['recording','paused'].includes(capture))?`<button data-phone="record">${icon('circle-dot')} ${capture==='recording'?'Pause recording':capture==='paused'?'Resume recording':'Record with consent'}</button>${['recording','paused'].includes(capture)?`<button data-phone="record_stop">${(globalThis.PlatformLanguage?.htmlText("comms","m_71ef1099bbe0fc","Stop recording") ?? "Stop recording")}</button>`:''}`:''}</div>`:
      `${field('Phone number or contact','customer_number',values.customer_number??number,'text','required autocomplete="off"')}
      <div class="fmcm-form-grid">${select('Call method','mode',state.status?.settings?.enabled?[['browser','FirstMate phone'],['external','My external phone']]:[['external','My external phone']],values.mode||(state.status?.settings?.enabled?'browser':'external'))}${select('Call script','script_id',[['','No script'],...state.scripts.filter(s=>s.status==='published').map(s=>[s.id,s.title])],values.script_id||'')}</div>
      <p class="fmcm-help">External phone lets you record call notes without browser audio.</p><button data-phone="start" class="fmcm-primary">${icon('phone')} ${state.waitingToCall?'Connecting…':(values.mode|| (state.status?.settings?.enabled?'browser':'external'))==='browser'?'Start call':'Start call notes'}</button>`)}
      ${String(script?.title?`<details class="fmcp-script" open><summary>${esc(script.title)} <span class="fmcm-pill">v${esc(script.version)}</span></summary>${(scriptData.sections||[]).map(s=>`<h4>${esc(s.title)}</h4><p>${esc(s.body)}</p>`).join('')}${(scriptData.questions||[]).map((q,i)=>`<label class="fmcm-field">${esc(q)}<input data-question="${i}" value="${esc(state.answers[i]||'')}"></label>`).join('')}</details>`:'')}
      ${String(c?.mode==='external'?`<p class="fmcm-help"><a href="tel:${esc(number)}">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_4b023574d976a1",`Open ${v1} in your phone app`,{v1}) ?? `Open ${v1} in your phone app`)(esc(number))}</a></p>`:'')}
      ${String(c?`<label class="fmcm-field">${(globalThis.PlatformLanguage?.htmlText("comms","m_d885eb7f0cdaa0","Call notes ") ?? "Call notes ")}<textarea class="fmcp-notes" name="notes" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_d59c66e54984e5","What happened? Capture decisions, concerns, and next steps.") ?? "What happened? Capture decisions, concerns, and next steps.")}">${esc(state.notes)}</textarea></label><p class="fmcm-help" data-save-state>${state.dirty?'Saving notes…':'Notes saved'}</p>`:'')}
      ${String(c&&!active&&!saved&&!processing&&state.status?.settings?.require_disposition?`<div class="fmcm-form-grid">${select('Call outcome','disposition',['answered','voicemail','no_answer','busy','wrong_number','callback','do_not_call','technical_failure'],values.disposition||((c.connected_at||c.mode==='external')?'answered':'no_answer'))}${select('Next step','next_action',nextSteps,values.next_action||'none')}</div>
      <div data-appointments ${values.next_action==='scheduled'?'':'hidden'}>${select('Booked appointment','appointment_id',[['','Choose an appointment'],...(state.appointments||[]).map(a=>[a.id,`${a.title||(globalThis.PlatformLanguage?.htmlText("comms","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")} · ${a.start||a.id}`])],values.appointment_id||'')}<button data-phone="refresh-context">${(globalThis.PlatformLanguage?.htmlText("comms","m_8b5406d39b44c7","Refresh appointments") ?? "Refresh appointments")}</button></div>
      ${(c.metadata?.source_node_ids||[]).length?`<details class="fmcp-script" open><summary>${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_465e01a14d53fd",`Linked work (${v0})`,{v0}) ?? `Linked work (${v0})`)(c.metadata.source_node_ids.length)}</summary><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_759c2a8bdbdc02","Select only the obligations this call resolves.") ?? "Select only the obligations this call resolves.")}</p>${c.metadata.source_node_ids.map(id=>`<label class="fmcm-check"><input type="checkbox" data-source="${esc(id)}">${esc(state.detail?.work?.find(node=>node.id===id)?.title||state.entry?.title||(globalThis.PlatformLanguage?.text("comms","m_5c4af3e82b50ff","Linked follow-up") ?? "Linked follow-up"))}</label>`).join('')}</details>`:''}`:'')}
      ${String(saved?`<p><span class="fmcm-pill good">${icon('check')} ${esc(label(c.result?.disposition))}</span> <span class="fmcm-help">${esc(date(c.ended_at))}</span></p>`:'')}
      ${String(processing?`<p class="fmcm-help" role="status">${(globalThis.PlatformLanguage?.htmlText("comms","m_aa5c78e69f24d8","Saving the outcome and updating linked work…") ?? "Saving the outcome and updating linked work…")}</p>`:'')}
      ${String(c?`<div data-artifacts>${mediaMarkup()}</div>${analysisMarkup()}`:'')}</div>
      <footer class="fmcp-footer"><span class="fmcm-help">${String(c?`${c.direction==='inbound'?'Incoming':'Outgoing'} call`:'Communications')}</span><div class="fmcm-actions">${String(!c&&state.entry?`<button data-phone="skip">${(globalThis.PlatformLanguage?.htmlText("comms","m_80ad5d823ed757","Skip for now") ?? "Skip for now")}</button>`:'')}${String(c&&!active&&!saved&&!processing&&state.status?.settings?.require_disposition?`<button class="fmcm-primary" data-phone="wrap">${(globalThis.PlatformLanguage?.htmlText("comms","m_6b7aea73ef8d46","Save outcome") ?? "Save outcome")}</button>`:'')}${String(saved&&state.entry?`<button class="fmcm-primary" data-phone="next">${(globalThis.PlatformLanguage?.htmlText("comms","m_db479b7b19a749","Next contact") ?? "Next contact")}</button>`:'')}${String(c&&!active?`<button data-phone="artifacts">${(globalThis.PlatformLanguage?.htmlText("comms","m_f15ce71ba3db6f","Recording & transcript") ?? "Recording & transcript")}</button>`:'')}</div></footer>`;
    el.querySelectorAll('[data-phone]').forEach(b=>{if(state.busy&&!['minimize','close','pause-dialer'].includes(b.dataset.phone))b.disabled=true;});
    if(observer){el.querySelectorAll('[name], [data-question], [data-source]').forEach(e=>e.disabled=true);el.querySelectorAll('[data-phone]').forEach(b=>{if(!['minimize','close','project','schedule','message','artifacts','supervise','analysis-generate','analysis-load','analysis-ask',...(consultation||supervising?['answer','decline']:[])].includes(b.dataset.phone))b.disabled=true;});}
    if(!callPermission('record'))el.querySelectorAll('[data-phone^="record"]').forEach(b=>b.hidden=true);
    if(!callPermission('recordings'))el.querySelectorAll('[data-phone="artifacts"]').forEach(b=>b.hidden=true);
    el.querySelectorAll('[name=analysis_prompt],[name=analysis_question]').forEach(e=>e.disabled=state.analysisBusy);
    if(state.busy)el.querySelectorAll('input,textarea,select').forEach(e=>e.disabled=true);
    if(state.saveError){const message=el.querySelector('[data-save-state]');if(message){message.textContent=(globalThis.PlatformLanguage?.text("comms","m_cb41039283b180","Notes are kept in this tab. ") ?? "Notes are kept in this tab. ");const retry=document.createElement('button');retry.dataset.phone='save-notes';retry.textContent=(globalThis.PlatformLanguage?.text("comms","m_5ede774dc3f22a","Retry saving") ?? "Retry saving");message.append(retry);}}
    el.querySelectorAll('[data-source]').forEach(e=>{e.checked=checked.has(e.dataset.source);});
    const focusTarget=focusQuestion!==undefined?el.querySelector(`[data-question="${CSS.escape(focusQuestion)}"]`):focusName?el.querySelector(`[name="${CSS.escape(focusName)}"]`):null;
    if(state.busy)el.querySelectorAll('input,textarea,select,[data-phone]').forEach(e=>{if(!['minimize','close','pause-dialer'].includes(e.dataset.phone))e.disabled=true;});
    if(!state.status)el.querySelector('[data-phone=start]')?.setAttribute('disabled','');
    Portal.PhoneTray?.update(state);
    if(focusTarget){focusTarget.focus({preventScroll:true});try{focusTarget.setSelectionRange(caret,caretEnd);}catch{}}
    if(state.outcomeRequested&&!active&&!saved&&!processing){const outcome=el.querySelector('[name=disposition]');outcome?.scrollIntoView({block:'nearest'});outcome?.focus({preventScroll:true});}
  }
  async function refreshStatus(){const requestedScope=scope(),status=await request('voice/status');if(requestedScope!==scope())return {};const first=!state.status;state.status=status;if(first&&status.settings?.enabled)state.panel?.querySelector('[name=mode]')?.remove();changed();return status;}
  async function open(input={},options={}){
    state.boundScope=scope();
    if(state.diagnosing)throw new Error('Wait for the audio check to finish before opening a call.');
    if(state.call&&!terminal.has(state.call.state)&&state.call.id!==input.call_id){state.minimized=false;if(input.call_id||input.entry_id)state.error='Finish the active call before opening another contact.';render();return false;}
    if(state.call&&state.call.wrap_up_state!=='saved'&&terminal.has(state.call.state)&&state.status?.settings?.require_disposition&&state.call.id!==input.call_id){state.minimized=false;state.error='Save this call outcome before starting another call.';render();return false;}
    if(state.call&&(!Object.keys(input).length||input.call_id===state.call.id)){state.minimized=false;if(options.artifacts&&callPermission('recordings'))await artifacts();render();autoConnect();void Portal.PhoneTray?.selectTab('call');return true;}
    const ticket=++state.openSequence;
    clearTimeout(state.saveTimer);if(state.dirty&&state.call)await saveNotes();
    if(ticket!==state.openSequence)return false;
    if(state.panel)state.panel.innerHTML='';
    state.error='';state.minimized=false;state.outcomeRequested=false;state.deviceCheckRequired=false;state.checkMessage='';state.entry=input.entry||null;state.prepared=input;state.notes='';state.answers={};state.contacts=[];state.appointments=[];state.media=null;state.analysis=null;state.analysisPrompt='';state.analysisQuestion='';state.analysisError='';state.analysisBusy=false;state.analysisRequest=null;state.analysisOpen=false;state.followupOptions=null;state.policyDate='';state.usePolicy=false;state.wrapId='';state.wrapPayload=null;state.dirty=false;state.localId=uid();
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
    autoConnect();
    if(results[1].status==='fulfilled')state.scripts=results[1].value.scripts||[];
    await refreshContext().catch(error=>{if(ticket===state.openSequence)state.error=error.message;});if(ticket!==state.openSequence)return false;
    if(state.call)state.followupOptions=await request(callPath('/follow-up-options')).catch(()=>null);if(ticket!==state.openSequence)return false;
    if(state.call&&options.artifacts&&callPermission('recordings'))await artifacts();
    render();if(state.call){schedulePoll();void request('conversation-workflow',{kind:'call',source_id:state.call.id,revision:0,action:'read'}).catch(()=>{});}else if(!options.fromRoute){state.panel.querySelector('[name=customer_number]')?.focus();}return true;
  }
  async function refreshContext(){const project=state.call?.project_id||state.prepared.project_id;if(!project)return;
    const ticket=state.openSequence,result=await request(`call-context?project_id=${encodeURIComponent(project)}`),context=result.projects?.[0];if(ticket!==state.openSequence)return;state.contacts=context?.contacts||[];state.appointments=context?.appointments||[];
    if(!state.call&&!state.prepared.customer_number&&!state.entry){const contact=state.contacts.find(c=>c.primary&&c.phone)||state.contacts.find(c=>c.phone);if(contact){Object.assign(state.prepared,{contact_id:contact.id,customer_name:contact.name,customer_number:contact.phone});const form=state.panel;if(form?.querySelector('[name=customer_number]')?.value===''){form.querySelector('[name=customer_name]').value=contact.name;form.querySelector('[name=customer_number]').value=contact.phone;}}}
  }
  async function start(){
    if(dialer.active){clearInterval(dialer.timer);dialer.timer=0;dialer.deadline=0;if(state.entry?.id)dialer.seen.add(state.entry.id);}
    const values=readForm();if(!values.customer_number)throw new Error('Enter a phone number.');
    const dialed=values.customer_number.startsWith('+')?values.customer_number:`${values.country_code||'+1'}${values.customer_number.replace(/\D/g,'')}`;
    if(!/^\+[1-9]\d{7,14}$/.test(dialed))throw new Error('Choose a contact or enter a valid phone number.');
    if(values.mode==='browser'){const ticket=state.openSequence;state.waitingToCall=true;render();try{await connect();}finally{state.waitingToCall=false;}if(ticket!==state.openSequence||state.panel?.hidden)return;}
    if(values.mode==='browser'&&!state.deviceChecked){state.deviceCheckRequired=true;state.checkMessage='';return;}
    state.deviceCheckRequired=false;
    const body={...state.prepared,entry_id:state.entry?.id||state.prepared.entry_id||'',customer_name:state.prepared.customer_name||'',customer_number:dialed,
      purpose:state.prepared.purpose||'',business_number:values.business_number||'',mode:values.mode,script_id:values.script_id,device_id:deviceId,operation_id:state.localId};delete body.entry;delete body.call_id;
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
    const prior=state.call,priorPermissions=state.detail?.permissions;state.call=result.call;state.detail=result;
    if(!state.dirty){state.notes=state.call.notes||'';state.answers=state.call.metadata?.script_answers||{};}
    // Preserve the user's caret and unsaved form values; redraw only a call-state transition.
    if(prior.state!==state.call.state||prior.wrap_up_state!==state.call.wrap_up_state||JSON.stringify(prior.metadata?.capture)!==JSON.stringify(state.call.metadata?.capture)||JSON.stringify(prior.metadata?.transfer)!==JSON.stringify(state.call.metadata?.transfer)||JSON.stringify(priorPermissions)!==JSON.stringify(state.detail?.permissions)||JSON.stringify(state.lastSupervision)!==JSON.stringify(state.detail?.supervision))render();
    state.lastSupervision=state.detail?.supervision;
    if((callPermission('analyze')||callPermission('analysis_read'))&&state.analysis&&(state.analysisOpen||state.analysis.notes?.some(n=>['pending','running'].includes(n.state)))){const analysis=await request(`calls/${encodeURIComponent(id)}/analysis`);if(state.call?.id!==id)return;state.analysis=analysis;render();}
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
    if(name==='pause-dialer'){pauseDialer();render();return;}
    if(name==='resume-dialer'){try{state.error='';await startDialer({id:dialer.listId,listIds:dialer.listIds,power:dialer.fast,title:dialer.title,departmentId:dialer.departmentId});}catch(error){state.error=error.message;render();}return;}
    if(name==='new-call'){if(state.status?.settings?.require_disposition&&state.call?.wrap_up_state!=='saved')return;await saveNotes();state.call=null;await open();return;}
    if(name==='connect'){try{await connect();state.panel?.querySelector('[name=mode]')?.remove();render();}catch(error){state.error=error.message;render();}return;}
    if(name==='dismiss-check'&&!state.busy){state.deviceCheckRequired=false;state.checkMessage='';state.error='';render();return;}
    if(name==='minimize'){state.minimized=!state.minimized;render();return;}
    if(name==='close'){
      if(dialer.active)pauseDialer();
      if(state.detail?.supervision?.session&&!['ended','failed','taken_over'].includes(state.detail.supervision.session.state)){state.minimized=true;render();return;}
      if(state.busy&&!state.waitingToCall){state.minimized=false;render();return;}
      const c=state.call,observer=c?.owner_user_id&&c.owner_user_id!==ui.user()&&!state.status?.permissions?.manage;
      if(c&&!observer&&c.wrap_up_state!=='saved'&&(state.status?.settings?.require_disposition||!terminal.has(c.state)&&c.mode==='browser')){
        state.minimized=false;state.outcomeRequested=true;
        if(c.metadata?.transfer?.target_user_id===ui.user()&&c.owner_user_id!==ui.user()&&['dialing','consulting'].includes(c.metadata.transfer.state)){await handle('decline');return;}
        if(c.mode==='browser'&&!terminal.has(c.state)){state.minimized=true;state.outcomeRequested=false;render();return;}
        render();return;
      }
      try{await saveNotes();}catch(error){state.error=error.message;render();return;}
      state.openSequence++;state.loadingCall=false;state.panel.hidden=true;state.call=null;state.entry=null;state.prepared={};void disconnect().catch(()=>{});clearTimeout(state.poll);Portal.navigation?.backOrClose?.(['customerCall','communicationsEntry'],{customerCall:null,communicationsEntry:null});return;
    }
    if(state.busy)return;state.busy=true;state.error='';state.panel?.querySelectorAll('input,textarea,select,[data-phone]').forEach(e=>{if(!['minimize','close','pause-dialer'].includes(e.dataset.phone))e.disabled=true;});
    try{
      if(name==='supervise'){if(button.dataset.mode==='takeover'){dialog('Take over this call', '<p>You will become the caller. Your teammate will leave the call.</p>',async()=>{await supervise('takeover');render();},{submit:'Take over'});}else await supervise(button.dataset.mode);}
      else if(name.startsWith('analysis-'))await analyze(name.slice(9),button);
      else if(name==='start')await start();else if(name==='wrap')await wrap();else if(name==='save-notes')await saveNotes();else if(name==='skip'||name==='next')await next(name==='skip');
      else if(name==='diagnose'){
        state.checkMessage='Checking microphone and network…';render();
        const result=await diagnose({inline:!!Portal.PhoneTray});state.deviceChecked=['ready','degraded'].includes(result.result?.verdict);
        state.deviceCheckRequired=!state.deviceChecked;state.checkMessage=result.result?.reason||'The check could not confirm call readiness. Run checks again.';
        if(!state.deviceChecked)state.error=state.checkMessage;
      }
      else if(name==='reconcile'){const result=await request(callPath('/reconcile'),{});state.call=result.call;}
      else if(name==='retry-work'){await request(callPath('/retry-work'),{job_id:button.dataset.job});await poll();}
      else if(name==='tone')await action('dtmf',{digits:button.dataset.digit});
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
    }catch(error){if(dialer.active)pauseDialer('Automatic dialing paused. Review the phone error before continuing.');if(error.code==='device_check_required'){state.deviceChecked=false;state.deviceCheckRequired=true;state.checkMessage='';}else if(error.name!=='AbortError')state.error=error.message;}
    finally{state.busy=false;queueMicrotask(()=>void advanceDialer());if(state.panel&&!state.panel.hidden){render();if(name==='artifacts')state.panel.querySelector('[data-artifacts]')?.scrollIntoView({block:'nearest'});}}
  }
  async function loadSDK(){
    if(window.TelnyxWebRTC?.TelnyxRTC)return;
    await new Promise((resolve,reject)=>{const el=document.createElement('script');el.src='/libraries/vendor/telnyx/webrtc-2.27.10.js';el.onload=resolve;el.onerror=()=>reject(new Error('The phone library could not load.'));document.head.append(el);});
  }
  async function heartbeat(){
    if(!state.client||!ui.org())return;const client=state.client,requestedScope=scope();const valid=()=>client===state.client&&requestedScope===scope();
    try{const result=await request('voice/endpoint/presence',{device_id:deviceId,registered:state.registered,availability:state.available?'available':'unavailable'});if(!valid())return;state.available=result.availability==='available';changed();
      if(state.registered&&(!state.call||terminal.has(state.call.state))){const calls=await request(`calls?active=true&owner_user_id=${encodeURIComponent(ui.user())}`);if(!valid())return;const incoming=calls.calls?.find(c=>c.direction==='inbound'||c.owner_user_id===ui.user());const offered=result.offered_call_id||incoming?.id;if(offered)await open({call_id:offered});}}
    catch(error){if(valid()){state.available=false;state.error=error.message;changed();}}
  }
  function connectionChanged(){changed();if(state.panel&&!state.panel.hidden)render();}
  function autoConnect(){if(state.status?.settings?.enabled&&!state.registered&&!state.readyPromise)void connect().catch(error=>{if(error.name!=='AbortError'&&state.panel&&!state.panel.hidden){state.error=error.message;render();}});}
  function stopConnection(){
    ++state.connectionSequence;state.cancelConnection?.();state.cancelConnection=null;state.readyPromise=null;
    const client=state.client;state.client=null;state.registered=false;state.available=false;state.connecting=false;
    clearInterval(state.heartbeat);clearTimeout(state.tokenTimer);try{client?.disconnect();}catch{}
  }
  async function connect(){
    if(state.registered)return;if(state.readyPromise)return state.readyPromise;
    if(state.client)stopConnection();
    state.boundScope=scope();const ticket=++state.connectionSequence,requestedScope=scope();let client;
    const canceled=()=>Object.assign(new Error('Phone closed.'),{name:'AbortError'});
    const valid=()=>ticket===state.connectionSequence&&requestedScope===scope();
    const guard=()=>{if(!valid())throw canceled();};
    state.connecting=true;state.error='';connectionChanged();
    const operation=(async()=>{
      await identityReady;guard();await state.disconnectPromise;guard();await loadSDK();guard();
      const token=await request('voice/endpoint/token',{device_id:deviceId});guard();
      const audio=audioElement();client=new window.TelnyxWebRTC.TelnyxRTC({login_token:token.token});state.client=client;client.remoteElement=audio;
      await applyAudio(client);guard();
      client.on('telnyx.notification',notification=>{
        if(client!==state.client||state.boundScope!==scope())return;
        if(notification.type!=='callUpdate'||!notification.call)return;
        const call=notification.call;state.sdkCall=call;
        if(call.state==='ringing'){
          const callTag=(call.options?.customHeaders||[]).find(header=>String(header.name).toLowerCase()==='x-firstmate-call')?.value;
          if(state.diagnosing&&state.diagnosticId&&callTag===state.diagnosticId){void call.answer({remoteElement:audio});return;}
          // Staff-first outbound leg is auto-answered only after this tab's explicit Start action.
          if(state.call?.direction==='outbound'&&state.call.metadata?.device_id===deviceId&&callTag===state.call.id)void call.answer({remoteElement:audio});
          else {void heartbeat();if(state.call)render();}
        }
        if(['hangup','destroy'].includes(call.state)){state.sdkCall=null;state.muted=false;void poll().catch(()=>{});}else if(state.call)render();
      });
      client.on('telnyx.error',error=>{if(!valid())return;if(dialer.active)pauseDialer('Phone disconnected. Automatic dialing paused.');state.error=error?.message||'Phone connection failed. Try your call again.';state.registered=false;state.available=false;connectionChanged();});
      const dialerConnectionLost=()=>{if(!valid())return;if(dialer.active)pauseDialer('Phone disconnected. Automatic dialing paused.');state.error='Phone disconnected. Check your network connection.';state.registered=false;state.available=false;connectionChanged();};
      client.on('telnyx.socket.close',dialerConnectionLost);client.on('telnyx.socket.error',dialerConnectionLost);
      await new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(timeout);if(valid())state.cancelConnection=null;error?reject(error):resolve();};
        const timeout=setTimeout(()=>finish(new Error('Could not connect. Check your network and try your call again.')),20000);
        state.cancelConnection=()=>finish(canceled());
        client.on('telnyx.ready',()=>{if(!valid())return;state.registered=true;finish();});
        client.on('telnyx.error',()=>finish(new Error('Could not connect. Try your call again.')));client.connect();
      });guard();
      clearInterval(state.heartbeat);state.heartbeat=setInterval(()=>void heartbeat(),12000);await heartbeat();guard();
      const delay=Math.max(30000,Date.parse(token.expires_at)-Date.now()-120000);
      const renew=()=>{if(!valid())return;if(state.call&&!terminal.has(state.call.state)){state.tokenTimer=setTimeout(renew,30000);return;}void disconnect().then(()=>{if(state.panel&&!state.panel.hidden)autoConnect();}).catch(()=>{});};
      state.tokenTimer=setTimeout(renew,Number.isFinite(delay)?delay:45*60000);
    })().catch(error=>{if(valid()){stopConnection();connectionChanged();}throw error;}).finally(()=>{if(valid()){state.readyPromise=null;state.connecting=false;connectionChanged();}});
    state.readyPromise=operation;return operation;
  }
  async function disconnect(){
    const requestedScope=scope(),pending=state.readyPromise,hadConnection=!!(state.client||pending);stopConnection();changed();
    if(!hadConnection)return state.disconnectPromise;
    // Wait for token provisioning before releasing its lease; a reopen waits for this cleanup.
    const cleanup=Promise.resolve(pending).catch(()=>{}).then(()=>{if(requestedScope===scope())return request('voice/endpoint/disconnect',{device_id:deviceId});});
    state.disconnectPromise=cleanup.catch(()=>{});return cleanup;
  }
  async function availability(value){state.available=value;await heartbeat();return state.available;}
  async function diagnose(options={}){
    if(state.diagnosing)throw new Error('An audio check is already running.');
    if(state.call&&!terminal.has(state.call.state))throw new Error('Run the audio check between calls.');
    state.diagnosing=true;const wasAvailable=state.available;state.available=false;const samples=[];let microphone='unavailable',connected=false,providerFailed=false;
    const names=['Connect browser phone','Check microphone access','Connect test audio','Measure audio quality','Save device result'];
    const checks=names.map(()=> 'Waiting');let step=0,finished=false;
    const inline=options.inline&&state.panel&&!state.panel.hidden;
    const el=inline?null:dialog('Call readiness check',`<p>This checks your microphone and the actual phone audio connection. It does not call a customer or record your voice.</p><ol>${names.map((name,i)=>`<li>${esc(name)}: <strong data-check-step="${i}">Waiting</strong></li>`).join('')}</ol><p data-check-progress role="status" aria-live="polite"></p><p class="fmcm-help" data-check-elapsed></p><section data-check-result hidden></section>`,null);
    if(el)el.querySelector('footer [data-close]').textContent='Hide check';
    const began=performance.now();
    const elapsed=el?setInterval(()=>{const target=el.querySelector('[data-check-elapsed]');if(target)target.textContent=`${Math.floor((performance.now()-began)/1000)} seconds elapsed. Allow any browser microphone prompt. Connecting can take up to 20 seconds; the audio test can take another 23 seconds.`;},1000):0;
    function progress(index,message){step=index;checks[index]='Checking…';if(!el){state.checkProgress=['Connecting…','Allow microphone access if asked.','Connecting test audio…','Checking audio quality…','Finishing…'][index];render();return;}checks.forEach((value,i)=>{el.querySelector(`[data-check-step="${i}"]`).textContent=value;});el.querySelector('[data-check-progress]').textContent=message;}
    function finish(result){
      finished=true;clearInterval(elapsed);state.diagnostic=result;state.checkProgress='';changed();if(!el)return;
      el.querySelector('footer [data-close]').textContent='Close';
      checks[step]=['ready','degraded'].includes(result.verdict)?'Passed':label(result.verdict);
      checks.forEach((value,i)=>{el.querySelector(`[data-check-step="${i}"]`).textContent=value==='Waiting'?'Not run':value;});
      el.querySelector('[data-check-progress]').textContent='Check finished.';
      const target=el.querySelector('[data-check-result]');target.hidden=false;
      target.innerHTML=`<h3>${esc(label(result.verdict))}</h3><p>${esc(result.reason||'The check could not finish. Retry the check.')}</p>${result.metrics&&Object.keys(result.metrics).length?`<p>Latency: ${Math.round(result.metrics.rtt_ms)} ms · Jitter: ${Math.round(result.metrics.jitter_ms)} ms · Packet loss: ${Number(result.metrics.packet_loss_percent).toFixed(1)}%</p>`:''}<button type="button" data-check-retry>Run checks again</button>`;
      target.querySelector('[data-check-retry]').disabled=true;target.querySelector('[data-check-retry]').onclick=()=>{el.close();el.remove();void diagnose().catch(()=>{});};
    }
    try{
      progress(0,'Connecting this browser to your business phone. This can take up to 20 seconds.');
      await connect();await heartbeat();checks[0]='Passed';
      progress(1,'Checking the selected microphone. If your browser asks for permission, click Allow.');
      // The SDK microphone check always samples the system default. Check the chosen device.
      try{const preferences=audioPreferences(),stream=await navigator.mediaDevices.getUserMedia({audio:preferences.microphone?{deviceId:{exact:preferences.microphone}}:true});microphone=stream.getAudioTracks().some(track=>track.readyState==='live')?'ready':'unavailable';stream.getTracks().forEach(track=>track.stop());}
      catch(error){microphone=error.name==='NotAllowedError'?'denied':'unavailable';}
      checks[1]=microphone==='ready'?'Passed':microphone==='denied'?'Permission denied':'Unavailable';
      if(microphone==='ready'){
        progress(2,'Starting a private test connection to this browser. Waiting for test audio; no customer number is dialed.');
        const check=await request('voice/diagnostics/start',{device_id:deviceId});state.diagnosticId=check.call_id;
        // A server-controlled SIP leg tests the real Telnyx media path without dialing a public test number.
        const deadline=Date.now()+23000;let mediaStarted=0,lastStatus=0;
        while(Date.now()<deadline){
          if(Date.now()-lastStatus>=2000){lastStatus=Date.now();const detail=await request(`calls/${encodeURIComponent(state.diagnosticId)}`);
            if(['failed','rejected','busy','no_answer','canceled'].includes(detail.call?.state)){providerFailed=true;checks[2]='Failed';break;}
            if(detail.call?.state==='ended')break;
          }
          const peer=state.sdkCall?.peer?.instance;
          if(peer?.connectionState==='connected'){
            connected=true;if(!mediaStarted){mediaStarted=Date.now();checks[2]='Passed';progress(3,'Test audio connected. Speak normally while we measure latency, jitter and packet loss for about 8 seconds. Your voice is not recorded.');}const stats=await peer.getStats();
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
      if(microphone==='ready'){checks[2]=providerFailed?'Failed':connected?'Passed':'Timed out';checks[3]=metrics?'Measured':'No measurements';}
      const failedStep=step;progress(4,'Saving the device result and ending the test connection.');
      const result=await request('voice/diagnostics',{device_id:deviceId,microphone,connectivity:connected?'ready':'inconclusive',provider_verdict:providerFailed?'blocked':metrics?'ready':'inconclusive',...(metrics?{metrics}:{})});checks[4]='Saved';
      state.deviceChecked=['ready','degraded'].includes(result.result?.verdict);step=state.deviceChecked?4:failedStep;finish(result.result);return result;
    }catch(error){state.deviceChecked=false;finish({verdict:'blocked',reason:error.message||'The check could not finish. Reconnect your phone and retry.'});throw error;
    }finally{
      clearInterval(elapsed);if(!finished&&el)el.querySelector('[data-check-progress]').textContent='Check stopped. Retry when you are ready.';
      if(state.diagnosticId){await request(`calls/${encodeURIComponent(state.diagnosticId)}/actions`,{operation_id:uid(),action:'hangup'}).catch(()=>{});await Promise.resolve(state.sdkCall?.hangup()).catch(()=>{});}
      state.diagnosticId='';state.diagnosing=false;state.sdkCall=null;state.available=wasAvailable;await heartbeat();el?.querySelector('[data-check-retry]')?.removeAttribute('disabled');
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
    // The global phone survives app navigation, including an ended call awaiting its outcome.
  }});
  // Do not send a delayed server disconnect that could revoke the reloaded tab.
  window.addEventListener('pagehide',()=>{pauseDialer();stopConnection();});
  window.addEventListener('pageshow',event=>{if(event.persisted&&state.panel&&!state.panel.hidden)autoConnect();});
  window.addEventListener('beforeunload',event=>{if((state.call?.mode==='browser'&&!terminal.has(state.call.state))||state.dirty){event.preventDefault();event.returnValue='';}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.panel&&!state.panel.hidden&&!document.querySelector('dialog[open]')){state.minimized=true;render();}});
  window.addEventListener('fm:platform-session:updated',()=>{
    if(!ui.org()||(state.boundScope&&state.boundScope!==scope())){
      pauseDialer();dialer.listId='';state.openSequence++;state.loadingCall=false;
      if(state.dirty)persistLocal();stopConnection();state.deviceChecked=false;state.deviceCheckRequired=false;state.client=null;state.sdkCall=null;state.registered=false;state.available=false;
      clearInterval(state.heartbeat);clearTimeout(state.poll);clearTimeout(state.tokenTimer);clearTimeout(state.saveTimer);
      if(state.panel)state.panel.hidden=true;state.call=null;state.status=null;Portal.PhoneTray?.reset?.();state.dirty=false;state.notes='';state.answers={};state.boundScope='';changed();
    }
    if(ui.org()&&ui.user())void Portal.navigation?.applyCurrent?.({source:'phone-session-ready',only:'customer-call-workspace'});
  });
  Portal.CustomerPhone={startDialer,pauseDialer,supervise,get dialer(){return dialer;},open,connect,disconnect,availability,diagnose,devices,refreshStatus,saveNotes,get state(){return state;},get deviceId(){return deviceId;},
    get diagnostic(){return state.diagnostic;},
    get connecting(){return state.connecting;},get status(){return state.status;},get connected(){return state.registered;},get available(){return state.available;},get currentCall(){return state.call;},get currentEntry(){return state.panel&&!state.panel.hidden?state.entry?.id:null;}};
  Portal.Communications=Portal.Communications||{};Portal.Communications.open=open;
})();
