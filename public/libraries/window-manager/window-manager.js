/* Shared portal windows. Apps own content, routing and the meaning of Close. */
(function(root){
  'use strict';
  if (root.FirstMateWindows) return;
  const windows = new Set();
  const hosts = new Map();
  const modes = ['full', 'floating', 'docked', 'minimized', 'modal', 'fullscreen'];
  let order = 0;
  let menu = null;
  function styles(){
    if (document.getElementById('fm-window-styles')) return;
    const style = document.createElement('style'); style.id = 'fm-window-styles';
    style.textContent = `
.fm-window,.fm-window *{box-sizing:border-box}.fm-window{position:absolute;display:flex;flex-direction:column;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;resize:none!important;overflow:hidden;background:#fff;color:#101828;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 14px 42px #10182826}
.fm-window[hidden]{display:none!important}.fm-window[data-window=full],.fm-window[data-window=docked]{border-radius:0;box-shadow:none}.fm-window[data-window=docked]{overflow:visible}
.fm-window-header{display:flex;flex:none;align-items:center;gap:8px;min-height:44px;padding:6px 10px;border-bottom:1px solid #e4e7ec;white-space:nowrap;touch-action:none;user-select:none;cursor:default}
.fm-window-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:700;white-space:nowrap}
.fm-window-title:after{content:'';display:inline-block;width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg);margin-left:6px;vertical-align:3px;opacity:.55;flex:0 0 auto}
.fm-window[data-window=minimized] .fm-window-title:after,.fm-window-title-plain:after{display:none}
.fm-window-controls{display:flex;flex:0 0 auto;gap:2px;margin-left:auto}.fm-window-controls button{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;background:none;border:0;border-radius:6px;color:inherit;cursor:pointer;font-size:12px}
.fm-window-controls button:hover{background:#66708520}.fm-window-controls button[data-window-action=close]:hover{background:#d92d20;color:#fff}
.fm-window[data-window=minimized]{border-radius:7px}.fm-window[data-window=minimized] .fm-window-header{height:30px;min-height:30px;padding:0 6px}.fm-window[data-window=minimized] .fm-window-controls button{height:28px!important;min-height:28px!important;width:24px!important}.fm-window[data-window=minimized] .fm-window-controls button:not([data-window-action=minimize]):not([data-window-action=close]){display:none!important}
.fm-window-content{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.fm-window[data-window=minimized] .fm-window-content,.fm-window[data-window=minimized] [data-window-secondary]{display:none!important}
.fm-window-resize{display:none;position:absolute;z-index:10;touch-action:none}.fm-window[data-window=floating] .fm-window-resize{display:block}
.fm-window-resize[data-resize=n]{top:0;left:16px;right:16px;height:6px;cursor:ns-resize}.fm-window-resize[data-resize=s]{bottom:0;left:16px;right:16px;height:6px;cursor:ns-resize}
.fm-window-resize[data-resize=w]{left:0;top:16px;bottom:16px;width:6px;cursor:ew-resize}.fm-window-resize[data-resize=e]{right:0;top:16px;bottom:16px;width:6px;cursor:ew-resize}
.fm-window-resize[data-resize=nw]{top:0;left:0;cursor:nwse-resize}.fm-window-resize[data-resize=ne]{top:0;right:0;cursor:nesw-resize}.fm-window-resize[data-resize=sw]{bottom:0;left:0;cursor:nesw-resize}.fm-window-resize[data-resize=se]{bottom:0;right:0;cursor:nwse-resize}
.fm-window-resize[data-resize=nw],.fm-window-resize[data-resize=ne],.fm-window-resize[data-resize=sw],.fm-window-resize[data-resize=se]{width:14px;height:14px}
.fm-window[data-window=docked] .fm-window-resize[data-resize=w]{display:block;top:0;bottom:0}
.fm-window[data-window=docked] .fm-window-resize[data-resize=w]::before{content:'';position:absolute;top:0;bottom:0;left:0;width:1px;background:#d0d5dd;pointer-events:none;transition:left .16s ease,width .16s ease,background-color .16s ease}
.fm-window[data-window=docked] .fm-window-resize[data-resize=w]:hover::before,.fm-window[data-window=docked] .fm-window-resize[data-resize=w]:focus-visible::before,.fm-window[data-window=docked] .fm-window-resize[data-resize=w].is-resizing::before{left:-3px;width:4px;background:#667085}
@media (prefers-reduced-motion:reduce){.fm-window[data-window=docked] .fm-window-resize[data-resize=w]::before{transition:none}}
.fm-window-resize:focus-visible{background:#66708555;outline:2px solid #175cd3;outline-offset:-2px}
.fm-window-menu{position:fixed;z-index:1700;background:#fff;color:#101828;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 12px 36px #10182830;padding:6px;width:230px;font:13px Arial,sans-serif}
.fm-window-menu button{display:block;width:100%;padding:9px 10px;text-align:left;border:0;border-radius:6px;background:none;color:inherit;cursor:pointer}.fm-window-menu button:hover,.fm-window-menu button:focus{background:#f2f4f7}
.fm-window[data-theme=dark]{background:#111827;color:#fff;border-color:#344054}.fm-window[data-theme=dark] .fm-window-header{border-color:#344054}
`;
    document.head.append(style);
  }
  function closeMenu(){ menu?.remove(); menu = null; }
  const dismissMenuOnPointer = event => { if (menu && !menu.contains(event.target)) closeMenu(); };
  document.addEventListener('pointerdown', dismissMenuOnPointer);
  // Dismiss placement menus before a containing modal's document Escape handler.
  const dismissMenuOnKey = event => { if (event.key === 'Escape' && menu) { closeMenu(); event.preventDefault(); event.stopPropagation(); } };
  window.addEventListener('keydown', dismissMenuOnKey, true);
  function registerHost(host){
    if (hosts.has(host)) return;
    const previousPosition = host.style.position;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const observer = new ResizeObserver(() => layout(host)); observer.observe(host);
    hosts.set(host, {observer, previousPosition, targets:new Map()});
  }
  function releaseHost(host){
    if ([...windows].some(win => win.host === host)) return;
    const record = hosts.get(host); if (!record) return;
    record.observer.disconnect(); host.style.position = record.previousPosition;
    for (const [target, saved] of record.targets) { target.style.width = saved.width; target.style.marginRight = saved.marginRight; }
    hosts.delete(host);
  }
  function box(win, left, top, width, height){
    if (win.viewportCoordinates && !['modal','fullscreen'].includes(win.mode)) { const bounds=win.host.getBoundingClientRect(); left+=bounds.left; top+=bounds.top; }
    for (const [key, value] of Object.entries({left:`${left}px`,top:`${top}px`,right:'auto',bottom:'auto',width:`${width}px`,height:`${height}px`})) win.element.style.setProperty(key,value,'important');
  }
  function layout(host){
    const active = [...windows].filter(win => win.host === host && win.visible);
    const width = host.clientWidth, height = host.clientHeight;
    const docks = active.filter(win => win.mode === 'docked');
    const mobileOverlayDock = width <= 640 && docks.some(win => win.mobileFullDock);
    const desired = docks.reduce((sum,win) => sum + (mobileOverlayDock && win.mobileFullDock ? width : win.dockWidth), 0);
    const budget = mobileOverlayDock ? width : Math.max(0,width - Math.min(320,width * .35));
    const scale = desired > budget ? budget / desired : 1;
    let reserved = 0, minimized = 0;
    const minimizedWidth = Math.min(224, Math.max(0, width - 16));
    const minimizedColumns = Math.max(1, Math.floor((width - 8) / (minimizedWidth + 6)));
    for (const win of docks) {
      const size = (mobileOverlayDock && win.mobileFullDock ? width : win.dockWidth) * scale, top = win.topInset();
      box(win,width - reserved - size,top,size,Math.max(0,height-top)); reserved += size;
    }
    const record = hosts.get(host);
    for (const win of active) {
      if (win.contentTarget && !record.targets.has(win.contentTarget)) record.targets.set(win.contentTarget,{width:win.contentTarget.style.width,marginRight:win.contentTarget.style.marginRight});
    }
    for (const [target, saved] of record.targets) {
      target.style.width = reserved ? `calc(100% - ${reserved}px)` : saved.width;
      target.style.marginRight = reserved ? `${reserved}px` : saved.marginRight;
    }
    for (const win of active) {
      const inset = win.topInset();
      if (win.mode === 'fullscreen') box(win,0,0,innerWidth,innerHeight);
      if (win.mode === 'modal' && win.nativeModalLayout) { for(const key of ['left','top','right','bottom','width','height']) win.element.style.removeProperty(key); }
      else if (win.mode === 'modal') { const w=Math.min(1720,innerWidth*.96),h=Math.min(1180,innerHeight*.92); box(win,(innerWidth-w)/2,(innerHeight-h)/2,w,h); }
      if (win.mode === 'full') box(win,0,inset,Math.max(0,width-reserved),Math.max(0,height-inset));
      if (win.mode === 'minimized') {
        const column = minimized % minimizedColumns, row = Math.floor(minimized++ / minimizedColumns);
        box(win,Math.max(0,width-8-minimizedWidth-column*(minimizedWidth+6)),Math.max(inset,height-8-32-row*38),minimizedWidth,32);
      }
      if (win.mode === 'floating') {
        const r = win.rect;
        r.width = Math.min(Math.max(win.minWidth,r.width),width);
        r.height = Math.min(Math.max(win.minHeight,r.height),Math.max(0,height-inset));
        r.left = Math.max(0,Math.min(r.left,width-r.width)); r.top = Math.max(inset,Math.min(r.top,height-r.height));
        box(win,r.left,r.top,r.width,r.height);
      }
    }
  }
  function restack(){
    [...windows].sort((a,b)=>(a.stackOrder||0)-(b.stackOrder||0)).forEach((win,index)=>{
      (win.stackElement || win.element).style.zIndex=String((['modal','fullscreen'].includes(win.mode) ? 2147483100 : win.mode === 'docked' ? 80 : win.mode === 'minimized' ? 1200 : 500)+index);
    });
  }
  function attach(options){
    styles();
    const element = options.element, header = options.header, title = options.title;
    if (!element || !header || !options.host) throw new Error('Window requires an element, header and host');
    const host = options.host;
    const headerDocument = header.ownerDocument;
    if (headerDocument !== document) {
      headerDocument.addEventListener('pointerdown', dismissMenuOnPointer);
      headerDocument.defaultView.addEventListener('keydown', dismissMenuOnKey, true);
    }
    registerHost(host);
    const win = {
      element, header, host, stackElement:options.stackElement, contentTarget:options.contentTarget,
      viewportCoordinates:options.viewportCoordinates === true, nativeModalLayout:options.nativeModalLayout === true, minimizedHeight:options.minimizedHeight || 44,
      minWidth:options.minWidth || 320, minHeight:options.minHeight || 280,
      mobileFullDock:options.mobileFullDock === true,
      mode:modes.includes(options.mode) ? options.mode : 'floating', previous:'floating',
      pinned:false, visible:!element.hidden, dockWidth:options.dockWidth || 440,
      topInset:() => Math.max(0,Number(options.topInset?.(win.host) || 0)),
      rect:{left:Math.max(0,host.clientWidth-(options.width || 640)-24),top:72,width:options.width || 640,height:options.height || 520}
    };
    windows.add(win); element.classList.add('fm-window'); if (!options.customChrome) header.classList.add('fm-window-header'); title?.classList.add('fm-window-title'); if (options.titleMenu === false) title?.classList.add('fm-window-title-plain'); options.body?.classList.add('fm-window-content');
    element.setAttribute('role','region'); element.setAttribute('aria-label',options.label || 'Window');
    const controls = document.createElement('div'); controls.className = 'fm-window-controls'; (options.controlsHost || header).append(controls);
    const buttons = {};
    for (const [action, icon] of [['place','table-columns'],['minimize','minus'],['maximize','expand'],['close','xmark']]) {
      const button = document.createElement('button'); button.type='button'; button.dataset.windowAction=action; button.innerHTML=`<i class="fas fa-${icon}" aria-hidden="true"></i>`; controls.append(button); buttons[action]=button;
    }
    if (options.presentationModes) {
      for (const [action,icon] of [['modal','window-maximize'],['floating','up-down-left-right'],['fullscreen','up-right-and-down-left-from-center']]) {
        const button=document.createElement('button');button.type='button';button.dataset.windowAction=action;button.innerHTML=`<i class="fas fa-${icon}" aria-hidden="true"></i>`;controls.append(button);buttons[action]=button;
        button.onclick=()=>action === 'pin' ? setPinned(!win.pinned) : setMode(action);
      }
    }
    const name = options.name || 'window';
    function chrome(){
      element.style.position = win.viewportCoordinates || ['modal','fullscreen'].includes(win.mode) ? 'fixed' : 'absolute';
      element.dataset.window = win.mode; element.dataset.pinned=String(win.pinned);
      const dock = options.presentationModes || win.mode === 'floating' || win.mode === 'full';
      const labels = {place:`${dock ? 'Dock' : 'Float'} ${name}`,minimize:`${win.mode === 'minimized' ? 'Restore' : 'Minimize'} ${name}`,maximize:`${win.mode === 'full' ? 'Float' : 'Maximize'} ${name}`,close:`Close ${name}`,modal:`Show ${name} as a modal`,floating:`Float ${name}`,fullscreen:`Fill entire screen with ${name}`,pin:`${win.pinned ? 'Unpin' : 'Pin'} ${name}`};
      if(options.presentationModes) { labels.place=`Dock ${name} to the right`; labels.maximize=`Fill workspace with ${name}`; }
      if (title && options.titleMenu !== false) {
        title.setAttribute('aria-label',win.mode === 'minimized' ? labels.minimize : ((v0) => globalThis.PlatformLanguage?.text("window-manager","m_d2465937dae930",`${v0} window menu`,{v0}) ?? `${v0} window menu`)(name));
        title.title=win.mode === 'minimized' ? labels.minimize : (globalThis.PlatformLanguage?.text("window-manager","m_e271e8dbdf1d3d","Window menu (right-click or Alt+Space)") ?? "Window menu (right-click or Alt+Space)");
      }
      for (const [key,button] of Object.entries(buttons)) { button.title=labels[key]; button.setAttribute('aria-label',labels[key]); }
      buttons.place.innerHTML=`<i class="fas fa-${dock ? 'table-columns' : 'window-restore'}" aria-hidden="true"></i>`;
      buttons.maximize.innerHTML=`<i class="fas fa-${!options.presentationModes && win.mode === 'full' ? 'window-restore' : 'expand'}" aria-hidden="true"></i>`;
      buttons.maximize.style.order=win.mode === 'full' ? '1' : '2'; buttons.minimize.style.order=win.mode === 'full' ? '2' : '1'; buttons.close.style.order='7';
      if(options.presentationModes) { for(const [action,mode] of Object.entries({modal:'modal',floating:'floating',place:'docked',maximize:'full',fullscreen:'fullscreen'})) buttons[action].setAttribute('aria-pressed',String(win.mode===mode)); buttons.modal.style.order='0';buttons.floating.style.order='1';buttons.place.style.order='2';buttons.maximize.style.order='3';buttons.fullscreen.style.order='4';buttons.minimize.style.order='5'; }
      buttons.minimize.innerHTML=`<i class="fas fa-${win.mode === 'minimized' ? 'window-restore' : 'minus'}" aria-hidden="true"></i>`;
    }
    function notify(reason){ options.onChange?.({mode:win.mode,pinned:win.pinned,reason}); }
    function setMode(mode,{silent=false}={}){
      if (!modes.includes(mode)) return;
      if (mode !== win.mode) {
        options.onBeforeModeChange?.({mode,previous:win.mode});
        if (mode === 'minimized') win.previous = win.mode;
        win.mode=mode;
      }
      chrome(); layout(win.host); restack(); if (!silent) notify('mode');
    }
    function setPinned(value,{silent=false}={}){ win.pinned=!!value; chrome(); if (!silent) notify('pin'); }
    function focus(){ win.stackOrder=++order; restack(); }
    async function requestClose(){ if (buttons.close.disabled) return; buttons.close.disabled=true; try { if (options.onClose) await options.onClose(); else {win.visible=false;element.hidden=true;layout(win.host);} } finally { buttons.close.disabled=false; } }
    buttons.place.onclick=() => setMode(options.presentationModes ? 'docked' : ['floating','full'].includes(win.mode) ? 'docked' : 'floating');
    function restore(){if(win.mode === 'minimized'){closeMenu();setMode(win.previous);focus();}}
    buttons.minimize.onclick=() => win.mode === 'minimized' ? restore() : setMode('minimized');
    buttons.maximize.onclick=() => setMode(options.presentationModes ? 'full' : win.mode === 'full' ? 'floating' : 'full');
    buttons.close.onclick=requestClose;
    function showMenu(event){
      event.preventDefault(); closeMenu(); menu=document.createElement('div'); menu.className='fm-window-menu'; menu.setAttribute('role','menu');
      const items=[['Float',() => setMode('floating')],['Dock',() => setMode('docked')],['Close',requestClose]];
      if(options.presentationModes) items.unshift(['Modal',()=>setMode('modal')],['Fill workspace',()=>setMode('full')],['Fill entire screen',()=>setMode('fullscreen')]);
      for(const [label,action] of items) { const button=document.createElement('button');button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{closeMenu();action();};menu.append(button); }
      menu.style.pointerEvents='auto'; (options.menuHost || document.body).append(menu);const r=header.getBoundingClientRect(),view=menu.ownerDocument.defaultView;menu.style.left=`${Math.max(8,Math.min(r.left,view.innerWidth-246))}px`;menu.style.top=`${Math.max(8,Math.min(r.bottom,view.innerHeight-menu.offsetHeight-8))}px`;menu.firstChild.focus();
    }
    header.addEventListener('contextmenu',showMenu);
    if (title && options.titleMenu !== false) { title.tabIndex=0; title.setAttribute('role','button'); title.setAttribute('aria-label',((v0) => globalThis.PlatformLanguage?.text("window-manager","m_d2465937dae930",`${v0} window menu`,{v0}) ?? `${v0} window menu`)(name)); title.title=(globalThis.PlatformLanguage?.text("window-manager","m_e271e8dbdf1d3d","Window menu (right-click or Alt+Space)") ?? "Window menu (right-click or Alt+Space)"); }
    let dragged=false;
    const titleClick=event=>{
      if(dragged || event.composedPath().includes(controls) || event.target.closest('button,input,a,select'))return;
      if(win.mode === 'minimized')restore();
      else if(options.titleMenu !== false && title?.contains(event.target))showMenu(event);
    }; header.addEventListener('click',titleClick);
    function keydown(event){ if (event.altKey && event.code === 'Space') showMenu(event); else if (event.target === title && ['Enter',' '].includes(event.key)) { if(win.mode === 'minimized'){event.preventDefault();restore();}else showMenu(event); } }
    if(headerDocument!==document)headerDocument.addEventListener('keydown',keydown);
    element.addEventListener('keydown',keydown);element.addEventListener('pointerdown',focus);
    let endGesture=null;
    function gesture(event,edge){
      dragged=false;
      if(event.button!==0 || (!edge && (win.mode!=='floating' || event.target.closest('button,input,a,select'))))return;
      event.preventDefault(); dragged=false; focus();
      const handle=event.currentTarget; handle.setPointerCapture(event.pointerId);
      if(edge) handle.classList.add('is-resizing');
      const start={...win.rect}, bounds=element.getBoundingClientRect();const x=event.screenX,y=event.screenY;
      const move=next=>{
        const dx=next.screenX-x,dy=next.screenY-y;if(Math.abs(dx)+Math.abs(dy)>3)dragged=true;
        if(win.mode==='docked'){win.dockWidth=Math.max(win.minWidth,Math.min(win.host.clientWidth,bounds.width-dx));layout(win.host);return;}
        if(!edge){win.rect={...start,left:start.left+dx,top:start.top+dy};layout(win.host);return;}
        let l=start.left,t=start.top,r=l+start.width,b=t+start.height;
        if(edge.includes('w'))l=Math.max(0,Math.min(r-Math.min(win.minWidth,win.host.clientWidth),l+dx));
        if(edge.includes('e'))r=Math.min(win.host.clientWidth,Math.max(l+win.minWidth,r+dx));
        if(edge.includes('n'))t=Math.max(win.topInset(),Math.min(b-win.minHeight,t+dy));
        if(edge.includes('s'))b=Math.min(win.host.clientHeight,Math.max(t+win.minHeight,b+dy));
        win.rect={left:l,top:t,width:r-l,height:b-t};layout(win.host);
      };
      const end=()=>{handle.classList.remove('is-resizing');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);endGesture=null;};
      endGesture?.();endGesture=end;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    }
    const drag=event=>gesture(event,'');header.addEventListener('pointerdown',drag);
    const grips=[];
    for(const edge of ['n','e','s','w','nw','ne','sw','se']){
      const grip=document.createElement('div');grip.className='fm-window-resize';grip.dataset.resize=edge;grip.tabIndex=0;grip.setAttribute('role','separator');grip.setAttribute('aria-label',((v0,v1) => globalThis.PlatformLanguage?.text("window-manager","m_0d80b4a3bd88a0",`Resize ${v0} ${v1}`,{v0,v1}) ?? `Resize ${v0} ${v1}`)(name,edge));
      grip.addEventListener('pointerdown',event=>gesture(event,edge));
      grip.addEventListener('keydown',event=>{
        if(!event.key.startsWith('Arrow'))return;event.preventDefault();const dx=event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0,dy=event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0;
        if(win.mode==='docked')win.dockWidth=Math.max(win.minWidth,win.dockWidth-dx);
        else {if(edge.includes('w')){const w=Math.max(win.minWidth,win.rect.width-dx);win.rect.left+=win.rect.width-w;win.rect.width=w;}if(edge.includes('e'))win.rect.width+=dx;if(edge.includes('n')){const h=Math.max(win.minHeight,win.rect.height-dy);win.rect.top+=win.rect.height-h;win.rect.height=h;}if(edge.includes('s'))win.rect.height+=dy;}
        layout(win.host);
      });element.append(grip);grips.push(grip);
    }
    const refreshViewport=()=>layout(win.host); window.addEventListener('resize',refreshViewport);
    chrome();layout(host);focus();
    return {
      element, setMode, setPinned, focus,
      restore,
      get state(){return {mode:win.mode,pinned:win.pinned,visible:win.visible};},
      setVisible(value){win.visible=!!value;element.hidden=!win.visible;layout(win.host);if(value)focus();},
      rehost(nextHost,contentTarget){if(nextHost===win.host)return;const old=win.host;registerHost(nextHost);win.host=nextHost;win.contentTarget=contentTarget;nextHost.append(element);layout(old);releaseHost(old);layout(nextHost);},
      refresh(){layout(win.host);},
      destroy(){if(headerDocument!==document){headerDocument.removeEventListener('keydown',keydown);headerDocument.removeEventListener('pointerdown',dismissMenuOnPointer);headerDocument.defaultView?.removeEventListener('keydown',dismissMenuOnKey,true);}window.removeEventListener('resize',refreshViewport);endGesture?.();closeMenu();windows.delete(win);controls.remove();grips.forEach(grip=>grip.remove());header.removeEventListener('pointerdown',drag);header.removeEventListener('contextmenu',showMenu);header.removeEventListener('click',titleClick);element.removeEventListener('keydown',keydown);element.removeEventListener('pointerdown',focus);element.remove();layout(win.host);releaseHost(win.host);}
    };
  }
  root.FirstMateWindows={attach, ensureStyles:styles};
})(window);
