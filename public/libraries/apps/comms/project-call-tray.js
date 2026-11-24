/* GP-155: a project window's Call tray. While the call workspace is open (a call ready to place, live, or being
 * wrapped up) the project's trays (project-trays.js) have a Call tab, marked while the call is live and when the
 * customer on it is not on this project. The one call panel (calling-runtime.js) shows in the tray of the project
 * window that last opened it while that window shows; the phone tray takes it back when the window closes or is
 * minimized (phone-tray.js projectCallHost). A project window is a frame: the phone belongs to the portal page. */
(function(){
  'use strict';
  const Portal=window.Portal=window.Portal||{};
  const trays=window.FirstMateProjectTrays;
  if(Portal.ProjectCallTray||!trays?.register)return;
  const terminal=new Set(['ended','canceled','failed','no_answer','busy','rejected']);
  const clean=value=>String(value??'').trim();
  const digits=value=>clean(value).replace(/\D/g,'').slice(-10);
  // The page that owns the phone: the portal, when this is a project window's frame.
  function owner(){let target=window;try{while(target.parent!==target&&target.parent.Portal?.PhoneTray&&target.parent.Portal?.CustomerPhone)target=target.parent;}catch{}return target;}
  const phone=()=>owner().Portal?.CustomerPhone,phoneTray=()=>owner().Portal?.PhoneTray;
  const formatPhone=value=>phoneTray()?.formatPhone?.(value)||clean(value);
  // A call asked for from this window, until its workspace opens.
  let wanted=0;
  function workspace(){const state=phone()?.state;return state?.panel&&!state.panel.hidden?state:null;}
  function info(){
    const state=workspace();if(!state)return null;
    const call=state.call,prepared=state.prepared||{};
    return {live:!!call&&!terminal.has(call.state),name:clean(call?.customer_name||prepared.customer_name),number:clean(call?.customer_number||prepared.customer_number),
      contactId:clean(call?.contact_id||prepared.contact_id),projectId:clean(call?.project_id||prepared.project_id)};
  }
  // A customer call (one with a contact or a project) is someone else's when this project has neither that contact nor
  // that number. A number typed in by hand is nobody's customer.
  function otherCustomer(call,project){
    const id=clean(project?.platform_project_id||project?.id);
    if(!call||!id||!call.projectId&&!call.contactId||call.projectId===id)return false;
    const contacts=[...(Array.isArray(project.contacts)?project.contacts:[]),project.contact].filter(contact=>contact&&typeof contact==='object');
    const ids=new Set([project.contact_id,project.primary_contact_id,...contacts.flatMap(contact=>[contact.id,contact.contact_id])].map(clean).filter(Boolean));
    if(call.contactId&&ids.has(call.contactId))return false;
    const number=digits(call.number);
    if(number.length>=7&&[...contacts.map(contact=>contact.phone),project.customer_phone,project.contact_phone,project.phone].some(value=>digits(value)===number))return false;
    return true;
  }
  // Copy in the shapes localization-catalogs.mjs translates.
  const copy={someone:{label:(globalThis.PlatformLanguage?.text("comms","m_0a24888f7bd132","This customer") ?? "This customer")},live:{title:(globalThis.PlatformLanguage?.text("comms","m_02e85d80532125","Call: on a live call") ?? "Call: on a live call")},other:name=>({title:((v0) => globalThis.PlatformLanguage?.text("comms","m_a949e18476d681",`Call: ${v0} is not a customer on this project`,{v0}) ?? `Call: ${v0} is not a customer on this project`)(name)}),
    note:name=>({message:((v0) => globalThis.PlatformLanguage?.text("comms","m_d0c9664c696c05",`${v0} is not a customer on this project.`,{v0}) ?? `${v0} is not a customer on this project.`)(name)})};
  const who=call=>call.name||formatPhone(call.number)||copy.someone.label;
  trays.register({id:'call',label:(globalThis.PlatformLanguage?.text("comms","m_8d4eaa0da004be","Call") ?? "Call"),icon:'fa-phone',widget:false,
    enabled:()=>!!workspace()||Date.now()-wanted<15000,
    state:project=>{const call=info();return call?[call.live?'live':'',otherCustomer(call,project)?'other':''].filter(Boolean).join(' '):'';},
    title:project=>{const call=info();return !call?'':otherCustomer(call,project)?copy.other(who(call)).title:call.live?copy.live.title:'';},
    mount:(node,{getProject})=>mount(node,getProject)});
  const style=document.createElement('style');
  style.textContent=`
  .fm-project-tray-tabs button[data-tray=call]{position:relative}.fm-project-tray-tabs button[data-tray=call]>i{position:relative}
  .fm-project-tray-tabs button[data-tray-state~=live]>i{color:#12805c}
  .fm-project-tray-tabs button[data-tray-state~=live]>i::after{content:'';position:absolute;top:-4px;right:-5px;width:7px;height:7px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 2px #fff;animation:fmProjectCallLive 1.6s ease-in-out infinite}
  .fm-project-tray-tabs button[data-tray-state~=other]::before{content:'!';position:absolute;bottom:2px;right:2px;min-width:12px;height:12px;border-radius:6px;background:#dc6803;color:#fff;font:800 9px/12px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff}
  @keyframes fmProjectCallLive{0%,100%{box-shadow:0 0 0 2px #fff,0 0 0 2px #12b76a55}50%{box-shadow:0 0 0 2px #fff,0 0 0 5px #12b76a00}}
  @media(prefers-reduced-motion:reduce){.fm-project-tray-tabs button[data-tray-state~=live]>i::after{animation:none}}
  .fm-project-call.fm-phone-tray{flex:1;min-height:0;overflow:auto;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column}
  .fm-project-call-other{display:flex;align-items:flex-start;gap:7px;margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:#fffaeb;color:#93370d;font-size:11.5px;line-height:1.45}
  .fm-project-call-other i{margin-top:2px;color:#dc6803}.fm-project-call-other[hidden]{display:none}
  .fm-project-call.fm-phone-tray .fmcp .fmcp-header{display:flex!important;padding:12px 14px;gap:10px;background:transparent;color:inherit;border-bottom:1px solid var(--phone-line)}
  .fm-project-call .fmcp-header strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-project-call .fmcp-header small{color:var(--phone-muted)}
  .fm-project-call .fmcp-header .fmcm-avatar{background:color-mix(in srgb,var(--primary,#d93025) 9%,white);color:var(--phone-accent)}
  .fm-project-call[data-live=true] .fmcp-header .fmcm-avatar{background:#ecfdf3;color:#12805c;animation:fmProjectCallLive 1.6s ease-in-out infinite}
  .fm-project-call .fmcp-header [data-phone=minimize],.fm-project-call[data-live=true] .fmcp-header [data-phone=close]{display:none}
  .fm-project-call .fmcp-header button{width:30px;height:30px;min-height:0;padding:0;border:0;background:transparent;color:var(--phone-muted)}
  .fm-project-call .fmcp.minimized .fmcp-body{display:block!important}.fm-project-call .fmcp.minimized .fmcp-footer{display:flex!important}
  .fm-project-call-away{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 18px;text-align:center;color:var(--phone-muted)}.fm-project-call-away[hidden]{display:none}
  .fm-project-call-away>i{font-size:20px}.fm-project-call-away p{margin:0;font-size:12px;line-height:1.5}
  .fm-project-call-away button{min-height:34px;padding:6px 14px;border-radius:8px;border:1px solid var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-weight:600;cursor:pointer}`;
  document.head.append(style);
  // Mounted Call trays, and those waiting for one to show (start below).
  const handles=new Set(),hosted=new Set();
  function mount(node,getProject){
    const box=document.createElement('div');box.className='fm-phone-tray fm-project-call';
    box.innerHTML=`<p class="fm-project-call-other" role="note" hidden><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span></span></p><div class="fm-project-call-host"></div><div class="fm-project-call-away" hidden><i class="fas fa-phone" aria-hidden="true"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_86f1c669a4feed","This call is showing in another window.") ?? "This call is showing in another window.")}</p><button type="button" data-call-here>${(globalThis.PlatformLanguage?.htmlText("comms","m_00954ab71dd9e0","Show it here") ?? "Show it here")}</button></div>`;
    node.append(box);
    const host=box.querySelector('.fm-project-call-host'),note=box.querySelector('.fm-project-call-other'),away=box.querySelector('.fm-project-call-away');
    const link=phoneTray()?.projectCallHost?.({node:host,showing,placed:sync});
    if(!link){away.hidden=false;away.querySelector('p').textContent=(globalThis.PlatformLanguage?.text("comms","m_76dbe358f51c1f","The phone is not available here.") ?? "The phone is not available here.");away.querySelector('button').remove();return {destroy(){box.remove();}};}
    let visible=false;
    // This window shows unless it is closed, minimized or a spare (window-manager/project-windows.js).
    function showing(){
      if(!host.isConnected)return false;
      const overlay=document.getElementById('rOverlay');
      if(overlay&&(!overlay.classList.contains('active')||overlay.dataset.windowMode==='minimized'))return false;
      const frame=window.frameElement;if(!frame)return true;
      const layer=frame.closest('.fm-project-window-layer');
      return frame.isConnected&&!layer?.classList.contains('fm-project-spare')&&layer?.dataset.mode!=='minimized';
    }
    function sync(){
      const call=info(),other=otherCustomer(call,getProject());
      box.dataset.live=String(!!call?.live);
      note.hidden=!other;if(other)note.querySelector('span').textContent=copy.note(who(call)).message;
      host.hidden=!link.hosting;away.hidden=!call||link.hosting;
    }
    away.querySelector('[data-call-here]').onclick=()=>{link.claim();sync();};
    const watch=new MutationObserver(()=>link.check());
    const overlay=document.getElementById('rOverlay');if(overlay)watch.observe(overlay,{attributes:true,attributeFilter:['class','data-window-mode']});
    try{const layer=window.frameElement?.closest('.fm-project-window-layer');if(layer)watch.observe(layer,{attributes:true,attributeFilter:['class','data-mode','hidden']});}catch{}
    // A closing frame hands the panel back while it can still leave this document.
    const leave=()=>link.release();window.addEventListener('pagehide',leave);
    const handle={sync,get visible(){return visible;},claim(){link.claim();hosted.forEach(waiter=>waiter());hosted.clear();sync();},
      setVisible(value){visible=!!value;if(visible)handle.claim();else sync();},
      destroy(){window.removeEventListener('pagehide',leave);watch.disconnect();handles.delete(handle);link.release();box.remove();}};
    handles.add(handle);sync();return handle;
  }
  let shown='';
  function refresh(){
    const call=info(),key=JSON.stringify([!!call,call?.live,call?.name,call?.number,call?.contactId,call?.projectId,!!wanted]);
    if(key!==shown){shown=key;window.dispatchEvent(new CustomEvent('fm:project-trays:tabs'));}
    handles.forEach(handle=>handle.sync());
  }
  for(const name of ['fm:customer-calls:changed','fm:customer-call-tray:changed'])window.addEventListener(name,refresh);
  // Only a window with an open project has trays to show a call in.
  const projectOpen=()=>!!document.querySelector('#rOverlay.active .fm-project-tray-tabs');
  const select=()=>window.dispatchEvent(new CustomEvent('fm:project-trays:select',{detail:{key:'call'}}));
  async function start(run){
    if(!projectOpen())return run();
    wanted=Date.now();refresh();
    // The tray mounts first, so the call opens straight into it rather than the phone tray first.
    const open=[...handles].find(handle=>handle.visible);
    if(open)open.claim();else await new Promise(resolve=>{hosted.add(resolve);setTimeout(resolve,1500);select();});
    try{return await run();}
    finally{wanted=0;refresh();if(workspace())select();}
  }
  Portal.ProjectCallTray={
    /** Opens the call workspace (CustomerPhone.open) in this project window's Call tray. */
    open:(input={},options)=>start(()=>phone().open(input,options)),
    /** Calls a customer's number (CustomerPhone.call) from this project window. */
    call:(input={})=>start(()=>phone().call(input)),
    /** Shows the open call in this project window's Call tray. */
    show(){if(!projectOpen()||!workspace())return false;const open=[...handles].find(handle=>handle.visible);if(open)open.claim();else select();return true;}
  };
})();
