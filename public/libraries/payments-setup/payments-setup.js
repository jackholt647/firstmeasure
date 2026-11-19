/* Hosted modal for direct entry; interactive Chromium for assistant requests. */
(function(root){
  'use strict';
  let active=null;
  function currentOrgId(){return String(root.__APP?.userOrgId||root.Portal?.cfg?.userOrgId||'').trim();}
  function request(orgId,path,body){
    if(!root.PaymentsAPI?.request) return Promise.reject(new Error('Payments API is unavailable.'));
    return root.PaymentsAPI.request(`/organizations/${encodeURIComponent(orgId)}/merchant-boarding/browser/${path}`,body===undefined?{}:{method:'POST',body});
  }
  function openAgent(){
    if(!root.PlatformAssistant?.openPaymentSetup) throw new Error('Open the global assistant to set up payments.');
    root.PlatformAssistant.openPaymentSetup();
    return Promise.resolve(true);
  }
  // Settings › Money and anything else showing payment state refresh on this.
  function announce(orgId){root.dispatchEvent(new CustomEvent('fm:payments-setup-updated',{detail:{orgId}}));}
  /* What Forward says now, for the finishing page: reading the application
     records it (status, account, processing, payouts, the "payments are on"
     notification) even when no webhook has arrived. */
  async function outcome(options={}){
    const orgId=String(options.orgId||currentOrgId()),api=root.PaymentsAPI;
    if(!orgId||!api?.merchantConfig)throw new Error('Payments API is unavailable.');
    let forward=(await api.merchantConfig.get(orgId))?.merchant_config?.forward||{};
    if(forward.application_id){const synced=await api.merchantBoarding.getApplication(orgId,forward.application_id).catch(()=>null);if(synced?.merchant_config?.forward)forward=synced.merchant_config.forward;}
    const readiness=(await api.intake.readiness(orgId).catch(()=>null))?.readiness||null;
    const status=String(forward.boarding_status||'').toUpperCase();
    const result={status,ready:readiness?.ready===true,processing_enabled:forward.processing_enabled===true,payouts_enabled:(readiness?.payouts_enabled??forward.payouts_enabled)===true,rails:readiness?.rails||null};
    announce(orgId);root.PlatformBanners?.load?.(orgId);
    return result;
  }
  let modal=null;
  async function open(options={}){
    if(modal){modal.dialog.focus();return true;}
    const orgId=String(options.orgId||currentOrgId()),previousFocus=document.activeElement;
    const overlay=document.createElement('div');
    // Above the project window (2147483200), which payment setup is often started from (GP-17), and below guides.
    // On a phone it is a tray rising from the bottom, like the Finance tab's own dialogs (GP-40).
    overlay.innerHTML=`<style>
      .fmp-modal{position:fixed;inset:0;z-index:2147483250;background:rgba(11,16,24,.78);display:grid;place-items:center;box-sizing:border-box}.fmp-modal-dialog{position:relative;width:min(1720px,96vw);height:min(1180px,calc(var(--fm-visual-vh,100vh) * .92));min-width:0;min-height:0;background:white;border-radius:14px;box-shadow:0 24px 80px #0004;display:flex;flex-direction:column;overflow:hidden;font:14px/1.5 system-ui;color:#182230}.fmp-modal-header{position:absolute;inset:0 0 auto 0;z-index:3;display:flex;justify-content:space-between;align-items:flex-start;padding:16px 10px 0 20px;pointer-events:none}.fmp-modal-header>*{pointer-events:auto}.fmp-modal button{cursor:pointer;font:inherit;padding:8px 12px;border:1px solid #d0d5dd;border-radius:8px;background:white;color:#182230}
      /* The tag and close are the guided setups' (.gxs-badge, .gxs-close; GP-75). They float over Forward's page, which can be dark, so both sit on white. The tag is a div so the portal's font (fonts.css sets it on div) reaches it, as in a guided setup. */
      .fmp-modal-title{display:inline-flex;align-items:center;gap:7px;font-size:12px;line-height:1.5;font-weight:700;color:var(--primary,#d93025);background:linear-gradient(rgba(var(--primary-rgb,217,48,37),.08),rgba(var(--primary-rgb,217,48,37),.08)) #fff;border-radius:999px;padding:5px 11px;white-space:nowrap;box-shadow:0 2px 10px #1018281f}.fmp-modal .fmp-modal-close{margin-top:-6px;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:#fff;color:#475467;display:inline-grid;place-items:center;box-shadow:0 2px 10px #1018281f;transition:background .15s,color .15s}.fmp-modal .fmp-modal-close:hover{background:#f2f4f7;color:#101828}.fmp-modal .fmp-modal-close:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}.fmp-modal-close .fmp-x{display:block;width:18px;height:18px}.fmp-modal iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:white}.fmp-modal-status{padding:32px;white-space:pre-line;margin:auto;max-width:600px;text-align:center}.fmp-modal-status:empty{display:none}
      @media(max-width:640px){.fmp-modal-header{padding:14px 6px 0 16px}.fmp-modal{place-items:end stretch}.fmp-modal-dialog{width:100%;height:calc(var(--fm-visual-vh,100vh) - 28px);border-radius:18px 18px 0 0;box-shadow:0 -9px 28px #0000004d;animation:fmpTrayUp .3s cubic-bezier(.2,.8,.2,1)}}@keyframes fmpTrayUp{from{transform:translateY(100%)}to{transform:none}}@media(prefers-reduced-motion:reduce){.fmp-modal-dialog{animation:none}}
    </style><section class="fmp-modal"><div class="fmp-modal-dialog" role="dialog" aria-modal="true" aria-label="Payment setup" tabindex="-1"><header class="fmp-modal-header"><div class="fmp-modal-title" aria-hidden="true"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>Set up payments</span></div><button type="button" class="fmp-modal-close" data-close aria-label="Close payment setup" title="Close payment setup"><svg class="fmp-x" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header><div class="fmp-modal-status" role="status">Opening secure application…</div><iframe aria-label="Forward payment application" hidden></iframe></div></section>`;
    document.body.appendChild(overlay);
    const background=[...document.body.children].filter(node=>node!==overlay).map(node=>[node,node.inert]);
    background.forEach(([node])=>{node.inert=true;});
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const dialog=overlay.querySelector('[role=dialog]'),frame=overlay.querySelector('iframe'),status=overlay.querySelector('[role=status]');
    let closed=false;
    function close(){closed=true;root.removeEventListener('message',returned);document.removeEventListener('keydown',keydown);overlay.remove();background.forEach(([node,inert])=>{node.inert=inert;});document.body.style.overflow=previousOverflow;modal=null;previousFocus?.focus?.();root.PlatformBanners?.load?.(orgId);announce(orgId);}
    function returned(event){if(event.origin===root.location.origin&&event.source===frame.contentWindow&&event.data?.type==='firstmate:payments-setup-return')close();}
    function keydown(event){if(event.key==='Escape'){event.preventDefault();close();}else if(event.key==='Tab'&&event.target===dialog){event.preventDefault();overlay.querySelector('[data-close]').focus();}}
    root.addEventListener('message',returned);document.addEventListener('keydown',keydown);
    overlay.querySelector('[data-close]').onclick=close;modal={dialog,close};dialog.focus();
    // Forward's application opens straight away; it returns to /portal/payments-setup-complete.html.
    try{
      const result=await root.PaymentsAPI.merchantBoarding.hostedSignup(orgId,{});
      if(closed)return true;
      if(result.already_submitted){status.textContent='This application has already been submitted.';return true;}
      const url=new URL(result.link?.url||'');
      if(!(url.origin===root.location.origin||(url.protocol==='https:'&&url.hostname.endsWith('.getfwd.com'))))throw new Error('The provider returned an unsupported application URL.');
      status.textContent='';frame.hidden=false;frame.src=url.href;
    }catch(error){if(!closed)status.textContent=error?.message||'Unable to open payment setup. Close and reopen to retry.';}
    return true;
  }
  function mount(container,options={}){
    if(active?.container===container)return active;
    active?.dispose();
    const orgId=String(options.orgId||currentOrgId());
    let stopped=false,session='',sequence=0,timer=0,queue=Promise.resolve(),uploadShown=false,resizeTimer=0;
    container.innerHTML=`<style>
      .fmp-shell{position:relative;height:100%;min-height:420px;padding-top:38px;box-sizing:border-box;animation:fmpPopIn .48s cubic-bezier(.16,1,.3,1) .08s both;transform-origin:50% 35%}.fmp-close{position:absolute;top:0;right:2px;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:50%;background:#fff;color:#667085;box-shadow:0 2px 12px #10182812;cursor:pointer;transition:background .15s,color .15s,transform .15s}.fmp-close .fmp-x{display:block;width:16px;height:16px}.fmp-close:hover{background:#f2f4f7;color:#101828;transform:scale(1.06)}.fmp-close:focus-visible{outline:2px solid #175cd3;outline-offset:3px}@keyframes fmpPopIn{from{opacity:0;transform:translateY(14px) scale(.965)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.fmp-shell{animation:none}.fmp-close{transition:none}}
      .fmp-browser{display:flex;flex-direction:column;height:100%;min-height:0;background:white;border:0;border-radius:18px;box-shadow:0 12px 38px #1018280c,0 2px 8px #10182808;overflow:hidden;color:#182230}
      .fmp-notice button{font:inherit;border:1px solid #d0d5dd;border-radius:6px;background:white;padding:5px 8px;cursor:pointer}
      .fmp-viewport{position:relative;flex:1;min-height:320px;overflow:hidden;outline:none;background:#fff;touch-action:none}.fmp-viewport:focus-visible{box-shadow:inset 0 0 0 2px #175cd3}.fmp-viewport img{display:block;width:100%;height:100%;object-fit:contain;object-position:top left;pointer-events:none;user-select:none}.fmp-input{position:absolute;left:0;top:0;opacity:.01;width:1px;height:1px;resize:none;border:0;padding:0}.fmp-status{padding:6px 10px;font:11px system-ui;color:#667085;min-height:14px}.fmp-notice{padding:10px;font:12px system-ui;background:#fffaeb}.fmp-browser [hidden]{display:none!important}
    </style><div class="fmp-shell"><button type="button" class="fmp-close" data-close aria-label="Close" title="Close payment signup"><svg class="fmp-x" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button><section class="fmp-browser" aria-label="Payment signup browser"><div class="fmp-notice" data-recovery hidden>Connection interrupted. <button type="button" data-reconnect>Reconnect</button></div><div class="fmp-notice" data-upload hidden>Choose the document requested by the signup form. <input type="file" data-file aria-label="Upload signup document"></div><div class="fmp-notice" data-dialog hidden>The signup page asks for confirmation. <button type="button" data-accept>Continue</button><button type="button" data-dismiss>Cancel</button></div><div class="fmp-viewport" tabindex="0" role="application" aria-label="Secure signup. Click a field to type; Tab moves between fields."><img alt="Live payment signup browser" draggable="false"><textarea class="fmp-input" aria-label="Type into signup" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div><div class="fmp-status" role="status">Starting secure signup browser…</div></section></div>`;
    const find=selector=>container.querySelector(selector),viewport=find('.fmp-viewport'),img=find('img'),textInput=find('textarea'),status=find('[role=status]');
    const statusText=text=>{if(!stopped){status.textContent=text;status.hidden=!text;}};
    let remoteWidth=900,remoteHeight=780;
    function failed(error){statusText(error?.message||'The signup connection was interrupted.');find('[data-recovery]').hidden=false;}
    function input(event){
      if(!session||stopped)return Promise.resolve();
      const work=queue.then(()=>request(orgId,'input',{session_id:session,event}));
      queue=work.catch(failed);return work;
    }
    function coordinates(event){
      const rect=viewport.getBoundingClientRect(),scale=Math.min(rect.width/remoteWidth,rect.height/remoteHeight);
      return {x:Math.max(0,Math.min(remoteWidth-1,(event.clientX-rect.left)/scale)),y:Math.max(0,Math.min(remoteHeight-1,(event.clientY-rect.top)/scale))};
    }
    function resize(){
      clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
        if(!session||stopped||!viewport.clientWidth)return;
        const width=Math.max(420,Math.min(1440,Math.round(viewport.clientWidth))),height=Math.max(400,Math.min(1200,Math.round(viewport.clientHeight)));
        if(Math.abs(width-remoteWidth)>5||Math.abs(height-remoteHeight)>5) void input({type:'resize',width,height}).catch(()=>{});
      },250);
    }
    async function poll(){
      if(stopped||!session)return;
      if(document.hidden||!container.getClientRects().length){timer=setTimeout(poll,1500);return;}
      try{
        const frame=await request(orgId,`frame?session_id=${encodeURIComponent(session)}&after=${sequence}`);
        if(stopped)return;
        remoteWidth=frame.width||remoteWidth;remoteHeight=frame.height||remoteHeight;
        if(frame.frame){img.src='data:image/jpeg;base64,'+frame.frame;sequence=frame.sequence;}
        if(frame.complete){statusText('Application submitted. Forward will review it.');root.PlatformBanners?.load?.(orgId);options.onSubmitted?.();return;}
        find('[data-upload]').hidden=!frame.upload_requested;
        if(frame.upload_requested&&!uploadShown){uploadShown=true;statusText('Select a file above to send it to the signup form.');}
        if(!frame.upload_requested)uploadShown=false;
        find('[data-dialog]').hidden=!frame.dialog;
        if(!frame.upload_requested&&!frame.dialog)statusText('');
        timer=setTimeout(poll,250);
      }catch(error){failed(error);}
    }
    async function connect(){
      clearTimeout(timer);find('[data-recovery]').hidden=true;statusText('Starting secure signup browser…');
      try{
        const result=await request(orgId,'session',{});
        if(stopped)return;
        if(result.state==='submitted'){statusText('Your application has already been submitted.');root.PlatformBanners?.load?.(orgId);return;}
        session=result.session_id;
        if(result.state!=='ready'){timer=setTimeout(connect,1500);return;}
        remoteWidth=result.width;remoteHeight=result.height;sequence=0;resize();void poll();
      }catch(error){failed(error);}
    }
    viewport.addEventListener('pointerdown',event=>{
      if(event.target===textInput)return;
      event.preventDefault();viewport.setPointerCapture(event.pointerId);textInput.focus({preventScroll:true});
      void input({type:'pointer',action:'mousePressed',...coordinates(event),button:event.button===2?'right':'left',buttons:event.buttons,clickCount:Math.min(2,event.detail||1)}).catch(()=>{});
    });
    viewport.addEventListener('pointerup',event=>{if(event.target!==textInput){event.preventDefault();void input({type:'pointer',action:'mouseReleased',...coordinates(event),button:event.button===2?'right':'left',buttons:0,clickCount:Math.min(2,event.detail||1)}).catch(()=>{});}});
    let movedAt=0;
    viewport.addEventListener('pointermove',event=>{if(event.buttons&&Date.now()-movedAt>30){movedAt=Date.now();void input({type:'pointer',action:'mouseMoved',...coordinates(event),buttons:event.buttons}).catch(()=>{});}});
    viewport.addEventListener('contextmenu',event=>event.preventDefault());
    viewport.addEventListener('wheel',event=>{event.preventDefault();void input({type:'wheel',...coordinates(event),deltaX:event.deltaX,deltaY:event.deltaY}).catch(()=>{});},{passive:false});
    viewport.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v')return; // Local paste event supplies text.
      const special=['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
      if(special.includes(event.key)||((event.ctrlKey||event.metaKey)&&/^[a-z0-9]$/i.test(event.key))){
        event.preventDefault();const mods=[event.ctrlKey||event.metaKey?'Control':'',event.altKey?'Alt':'',event.shiftKey?'Shift':''].filter(Boolean);
        void input({type:'key',key:[...mods,event.key].join('+')}).catch(()=>{});
      }else if(event.key.length===1&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&event.target!==textInput){event.preventDefault();void input({type:'text',text:event.key}).catch(()=>{});}
    });
    textInput.addEventListener('input',event=>{if(event.isComposing)return;const text=textInput.value;textInput.value='';if(text)void input({type:'text',text}).catch(()=>{});});
    textInput.addEventListener('compositionend',()=>{const text=textInput.value;textInput.value='';if(text)void input({type:'text',text}).catch(()=>{});});
    textInput.addEventListener('paste',event=>{event.preventDefault();const text=event.clipboardData?.getData('text/plain')||'';if(text)void input({type:'text',text}).catch(()=>{});});
    find('[data-file]').addEventListener('change',async event=>{
      const file=event.target.files?.[0];if(!file)return;
      if(file.size>10*1024*1024){statusText('Choose a file smaller than 10 MB.');return;}
      try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await input({type:'upload',name:file.name,mime:file.type,data});event.target.value='';find('[data-upload]').hidden=true;}catch(error){failed(error);}
    });
    find('[data-accept]').onclick=()=>void input({type:'dialog',accept:true}).catch(()=>{});
    find('[data-dismiss]').onclick=()=>void input({type:'dialog',accept:false}).catch(()=>{});
    find('[data-reconnect]').onclick=()=>void connect();
    const observer=new ResizeObserver(resize);observer.observe(viewport);
    function dispose(){stopped=true;clearTimeout(timer);clearTimeout(resizeTimer);observer.disconnect();img.removeAttribute('src');if(active?.container===container)active=null;}
    async function close(){const id=session;dispose();container.replaceChildren();options.onClose?.();if(id)await request(orgId,'close',{session_id:id}).catch(()=>{});root.dispatchEvent(new CustomEvent('fm:payments-setup-closed'));}
    find('[data-close]').onclick=()=>void close();
    active={container,dispose,close};void connect();return active;
  }
  root.FirstMatePaymentsSetup={open,openLink:open,openAgent,mount,outcome,get active(){return active;}};
})(window);
