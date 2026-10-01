/* One global surface for the existing CustomerPhone session. */
(function(){
  'use strict';
  const Portal=window.Portal=window.Portal||{};
  if(Portal.PhoneTray)return;
  const ui=Portal.CommunicationsUI,{esc,icon,request}=ui;
  let shell,win,title,nav,extra,compact,runtime,tab='dialer',sequence=0,timer,frame,context,sources=[],trackKey='';
  const style=document.createElement('style');style.textContent=`
  .fm-phone-tray{background:white;color:#182230;display:flex;flex-direction:column;overflow:hidden;font:13px/1.4 system-ui;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 8px 32px #10182826}
  .fm-phone-tray[hidden],.fm-phone-tray [hidden]{display:none!important}.fm-phone-tray .fm-window-header{flex-wrap:wrap;flex:none;gap:4px}.fm-phone-title{flex:1;min-width:65px;font-size:13px}.fm-phone-title small{display:block;font-weight:400;font-size:11px}.fm-phone-tray .fm-window-content{display:block;overflow:auto;min-height:0;flex:1}
  .fm-phone-tray .fmcp{position:static!important;inset:auto!important;width:auto!important;max-width:none!important;height:auto!important;max-height:none!important;box-shadow:none!important;border:0!important;display:block!important}.fm-phone-tray .fmcp[hidden],.fm-phone-tray .fmcp.phone-other-tab{display:none!important}.fm-phone-tray .fmcp-header{display:none!important}.fm-phone-tray .fmcp-body{padding:12px}.fm-phone-tray .fmcp-footer{flex-wrap:wrap;padding:10px}.fm-phone-tray .fmcm-form-grid{grid-template-columns:1fr}.fm-phone-tray .fmcp-controls{gap:4px;flex-wrap:wrap}
  .fm-phone-tabs{display:flex;overflow:auto;gap:4px;padding:8px;border-bottom:1px solid #eee}.fm-phone-tabs button{white-space:nowrap}.fm-phone-tray button{cursor:pointer;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:inherit;padding:7px}.fm-phone-tabs button[aria-selected=true]{background:#eff4ff;color:#175cd3}.fm-phone-extra{padding:12px}.fm-phone-extra:empty{display:none}.fm-phone-extra input{box-sizing:border-box;width:100%;padding:9px;border:1px solid #d0d5dd;border-radius:7px}.fm-phone-result{display:block;width:100%;text-align:left;margin-top:6px}.fm-phone-result small{display:block;color:#667085}.fm-phone-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:10px 0}.fm-phone-pad button{font-size:21px;padding:8px}
  .fm-phone-tray .fmcp .fmcm-field{margin-bottom:8px;gap:3px}.fm-phone-tray .fmcp .fmcm-field input{min-height:32px;padding:6px 8px}.fm-phone-tray .fmcp .fm-phone-pad button{min-height:32px;padding:4px;font-size:18px}.fm-phone-tray .fm-phone-pad{gap:4px;margin:6px 0}
  .fm-phone-compact{display:none;align-items:center;gap:4px;width:100%}.fm-phone-compact canvas{width:55px;height:20px}.fm-phone-tray[data-window=minimized] .fm-phone-compact{display:flex}.fm-phone-tray.fm-window[data-window=minimized] .fm-window-header{height:auto;min-height:72px}.fm-phone-tray[data-window=minimized] .fm-window-controls button[data-window-action=place]{display:inline-flex!important}.fm-phone-compact button{padding:4px 7px;font-size:11px}.fm-phone-compact [data-phone=hangup]{background:#b42318;color:white}.fm-phone-tray [data-window-action=maximize]{display:none!important}
  `;document.head.append(style);
  function attach(panel,api){
    if(!window.FirstMateWindows?.attach)return null;
    runtime=api;
    const host=document.querySelector('main.main')||document.querySelector('.main')||document.body;
    shell=document.createElement('aside');shell.className='fm-phone-tray';shell.hidden=true;
    const header=document.createElement('header');title=document.createElement('div');title.className='fm-phone-title';title.tabIndex=0;
    const float=document.createElement('button');float.innerHTML=icon('up-down-left-right');float.setAttribute('aria-label','Float phone');float.onclick=()=>win.setMode('floating');
    compact=document.createElement('div');compact.className='fm-phone-compact';header.append(title,float);
    const body=document.createElement('div');nav=document.createElement('nav');nav.className='fm-phone-tabs';nav.setAttribute('aria-label','Phone tabs');extra=document.createElement('div');extra.className='fm-phone-extra';body.append(nav,extra,panel);shell.append(header,body);host.append(shell);
    win=window.FirstMateWindows.attach({element:shell,header,title,body,host,contentTarget:host.querySelector(':scope > #mainPanels'),name:'phone',label:'Phone',mode:'docked',width:330,height:540,minWidth:290,minHeight:360,dockWidth:370,mobileFullDock:true,compactCall:true,minimizedHeight:78,allowFullscreen:false,topInset:()=>document.getElementById('platformTopbar')?.offsetHeight||0,onChange:({mode})=>runtime.minimized(mode==='minimized'),onClose:()=>runtime.action('close')});
    header.append(compact);
    compact.onclick=event=>{const b=event.target.closest('[data-phone]');if(b){event.stopPropagation();void runtime.action(b.dataset.phone,b);}};
    new MutationObserver(()=>win.setVisible(!panel.hidden)).observe(panel,{attributes:true,attributeFilter:['hidden']});
    nav.onclick=e=>{const b=e.target.closest('[data-phone-tab]');if(b)void selectTab(b.dataset.phoneTab);};
    void selectTab('dialer');return win;
  }
  async function selectTab(value){
    tab=value;const ticket=++sequence;
    nav.innerHTML=[['dialer','Dialer'],['contacts','Contacts'],['lists','Call lists'],['followups','Follow-ups']].map(([id,name])=>`<button data-phone-tab="${id}" aria-selected="${tab===id}">${name}</button>`).join('');
    runtime.panel().classList.toggle('phone-other-tab',tab!=='dialer');extra.innerHTML='';extra.onclick=null;
    if(tab==='dialer')return;
    if(tab==='contacts'){extra.innerHTML='<input aria-label="Search contacts" placeholder="Search contacts"><div data-results></div>';extra.querySelector('input').oninput=e=>{clearTimeout(timer);const query=e.target.value;timer=setTimeout(()=>contacts(query,ticket),250);};return;}
    extra.textContent='Loading…';
    try{const result=await request(tab==='lists'?'call-lists/queue':'follow-ups?owner=mine');if(ticket!==sequence)return;
      const entries=tab==='lists'?(result.columns||[]).flatMap(column=>(column.tasks||[]).map(entry=>({...entry,listId:column.id,list:column.title||column.name}))):(result.tasks||[]).map(task=>({...task,phone:task.metadata?.follow_up?.phone,contact_id:task.metadata?.follow_up?.contact_id,source_node_ids:[task.id]}));
      extra.innerHTML=entries.length?entries.map((e,i)=>`<button class="fm-phone-result" data-entry="${i}" ${e.blocked_reason?'disabled':''}>${esc(e.name||e.title)}<small>${esc(e.list||e.phone||e.blocked_reason||'Follow-up')}</small></button>`).join(''):'No calls waiting.';
      if(tab==='lists'&&result.columns?.length)extra.insertAdjacentHTML('afterbegin','<nav class="fm-phone-tabs" aria-label="Call lists"><button data-list="" aria-selected="true">All</button>'+result.columns.map(c=>`<button data-list="${esc(c.id)}" aria-selected="false">${esc(c.title||c.name)}</button>`).join('')+'</nav>');
      extra.onclick=async event=>{const list=event.target.closest('[data-list]');if(list){extra.querySelectorAll('[data-list]').forEach(b=>b.setAttribute('aria-selected',String(b===list)));extra.querySelectorAll('[data-entry]').forEach(b=>b.hidden=!!list.dataset.list&&entries[Number(b.dataset.entry)].listId!==list.dataset.list);return;}const b=event.target.closest('[data-entry]');if(!b)return;const e=entries[Number(b.dataset.entry)];await Portal.CustomerPhone.open(tab==='lists'?{entry_id:e.id,entry:e}:{customer_number:e.phone||'',customer_name:e.title,project_id:e.project_id,contact_id:e.contact_id,source_node_ids:e.source_node_ids});await selectTab('dialer');};
    }catch(error){if(ticket===sequence)extra.textContent=error.message;}
  }
  async function contacts(query,ticket){
    const target=extra.querySelector('[data-results]');if(!target)return;
    try{const result=await request(`voice/contacts?query=${encodeURIComponent(query)}`);if(ticket!==sequence||extra.querySelector('input')?.value!==query)return;
      target.innerHTML=(result.contacts||[]).map((c,i)=>`<button class="fm-phone-result" data-contact="${i}">${esc(c.name)}<small>${esc(c.phone)}</small></button>`).join('')||'No matching contacts.';
      target.onclick=async e=>{const b=e.target.closest('[data-contact]');if(!b)return;const c=result.contacts[Number(b.dataset.contact)];await Portal.CustomerPhone.open({contact_id:c.id,customer_name:c.name,customer_number:c.phone});await selectTab('dialer');};
    }catch(error){if(ticket===sequence)target.textContent=error.message;}
  }
  function update(state){
    if(!shell)return;
    const c=state.call,ended=c&&['ended','failed','canceled','no_answer','busy','rejected'].includes(c.state);
    if(state.status?.development?.enabled&&!state.panel.querySelector('[data-dev-destination]')){const note=document.createElement('p');note.dataset.devDestination='';note.className='fmcm-help';note.textContent='Development: calls route to '+state.status.development.destination;state.panel.querySelector('.fmcp-body')?.prepend(note);}
    title.innerHTML=`${icon('phone')} ${esc(c?.customer_name||state.prepared?.customer_name||'Phone')}<small>${esc(ended&&c.wrap_up_state!=='saved'?'Call ended · Outcome ready':c?ui.label(c.state):'Ready to call')}</small>`;
    compact.innerHTML=`<canvas width="110" height="40" aria-label="Incoming and outgoing audio levels"></canvas>${c&&!ended?`<button data-phone="mute" ${!state.sdkCall||state.busy?'disabled':''}>${state.muted?'Unmute':'Mute'}</button><button data-phone="${c.state==='held'?'resume':'hold'}" ${!['held','connected'].includes(c.state)||state.busy?'disabled':''}>${c.state==='held'?'Resume':'Hold'}</button><button data-phone="hangup" ${state.busy?'disabled':''}>End</button>`:'<span>Click to open</span>'}`;
    if(state.minimized&&win.state.mode!=='minimized')win.setMode('minimized');else if(!state.minimized&&win.state.mode==='minimized')win.restore();
    win.setVisible(!state.panel.hidden);
    if(!c){const field=state.panel.querySelector('[name=customer_number]');if(field&&!state.panel.querySelector('.fm-phone-pad')){const pad=document.createElement('div');pad.className='fm-phone-pad';pad.innerHTML=[...'123456789*0#'].map(n=>`<button type="button" data-digit="${n}">${n}</button>`).join('')+'<button type="button" data-digit="+">+</button><button type="button" data-erase aria-label="Delete last digit">⌫</button>';field.closest('label').after(pad);const start=state.panel.querySelector('[data-phone=start]');if(start){pad.after(start);start.style.cssText='width:100%;background:#067647;color:white';const name=state.panel.querySelector('[name=customer_name]')?.closest('label');if(name)start.after(name);}pad.onclick=e=>{const b=e.target.closest('button');if(!b)return;field.value=b.hasAttribute('data-erase')?field.value.slice(0,-1):field.value+b.dataset.digit;field.dispatchEvent(new Event('input',{bubbles:true}));};}}
    if(c&&['connected','held'].includes(c.state)&&(!c.owner_user_id||c.owner_user_id===ui.user()||state.status?.permissions?.manage)&&!state.panel.querySelector('.fm-phone-pad')){
      const pad=document.createElement('div');pad.className='fm-phone-pad';pad.setAttribute('aria-label','Call keypad');pad.innerHTML=[...'123456789*0#'].map(digit=>`<button type="button" data-phone="tone" data-digit="${digit}" ${state.busy?'disabled':''}>${digit}</button>`).join('');state.panel.querySelector('.fmcp-controls')?.after(pad);
    }
    levels(ended?null:state.sdkCall);
  }
  function levels(call){
    const peer=call?.peer?.instance;
    const tracks=[...(peer?.getReceivers?.()||[]).map(r=>({track:r.track,receive:true})),...(peer?.getSenders?.()||[]).map(s=>({track:s.track,receive:false}))].filter(i=>i.track?.kind==='audio'&&i.track.readyState==='live');
    const key=tracks.map(i=>i.track.id).join(':');
    if(key!==trackKey){trackKey=key;sources.forEach(s=>s.source.disconnect());sources=[];
      if(tracks.length){try{context ||= new (window.AudioContext||window.webkitAudioContext)();void context.resume();sources=tracks.map(i=>{const source=context.createMediaStreamSource(new MediaStream([i.track])),analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);return {source,analyser,receive:i.receive,data:new Uint8Array(256)};});}catch{sources=[];}}
    }
    cancelAnimationFrame(frame);
    function draw(){const canvas=compact.querySelector('canvas'),ctx=canvas?.getContext('2d');if(ctx){ctx.clearRect(0,0,110,40);for(const i of sources){i.analyser.getByteTimeDomainData(i.data);ctx.strokeStyle=i.receive?'#1570ef':'#079455';ctx.beginPath();i.data.forEach((v,n)=>{const x=n*110/255,y=(i.receive?10:30)+(v-128)/128*9;n?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}}if(sources.length&&!shell.hidden)frame=requestAnimationFrame(draw);}
    draw();
  }
  async function sync(){const slot=document.getElementById('platformPhoneSlot');if(!slot)return;slot.hidden=true;if(!ui.org()||!ui.user()||!Portal.appFlags?.has?.('apps','comms'))return;try{const s=await Portal.CustomerPhone.refreshStatus();slot.hidden=!s.settings?.enabled;}catch{}}
  document.addEventListener('click',e=>{if(e.target.closest('#platformPhoneBtn'))void Portal.CustomerPhone.open().catch(()=>{});});
  window.addEventListener('fm:platform-session:updated',sync);window.addEventListener('fm:app-flags:updated',sync);document.addEventListener('DOMContentLoaded',sync);
  window.addEventListener('fm:customer-calls:changed',()=>{const slot=document.getElementById('platformPhoneSlot');if(slot)slot.hidden=!Portal.CustomerPhone.status?.settings?.enabled;});
  async function developmentSetup(container,onComplete){
    try{
      const status=await request('voice/status');if(!container.isConnected||!status.development?.enabled||!status.permissions?.manage)return;
      container.querySelector('[data-development-phone]')?.remove();
      const details=document.createElement('details');details.dataset.developmentPhone='';details.className='fmcm-card';
      const paint=development=>{details.innerHTML=`<summary>Development tools</summary><p>Test calls route to ${esc(development.destination)}. Brand and 10DLC registrations are simulated.</p>${development.onboarded?'<p role="status">Fully onboarded for development: mock brand approved, mock 10DLC campaign approved, test line connected.</p>':'<button type="button" data-complete-development>Skip to fully onboarded</button>'}<p data-development-error role="alert"></p>`;
        details.querySelector('[data-complete-development]')?.addEventListener('click',async event=>{event.target.disabled=true;try{const result=await request('voice/development/onboard',{});paint(result.development);onComplete?.(result.development);await Portal.CustomerPhone.refreshStatus();await window.AppChrome?.load?.();}catch(error){details.querySelector('[data-development-error]').textContent=error.message;event.target.disabled=false;}});};
      paint(status.development);container.prepend(details);if(status.development.onboarded)onComplete?.(status.development);
    }catch{/* The normal setup remains available when calling access is unavailable. */}
  }
  Portal.PhoneTray={attach,update,selectTab,developmentSetup,reset(){++sequence;clearTimeout(timer);cancelAnimationFrame(frame);sources.forEach(s=>s.source.disconnect());sources=[];trackKey='';if(context){void context.close();context=null;}win?.setVisible(false);if(extra)extra.innerHTML='';}};
})();
