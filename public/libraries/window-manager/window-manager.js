/* Shared portal windows. Apps own content, routing and the meaning of Close. */
(function(root){
  'use strict';
  if (root.FirstMateWindows) return;
  const windows = new Set();
  const hosts = new Map();
  const modes = ['full', 'floating', 'docked', 'minimized', 'modal', 'fullscreen'];
  const placements = ['left','right','top-left','top-right','bottom-left','bottom-right','top','bottom'];
  let order = 0;
  let menu = null;
  function styles(){
    if (document.getElementById('fm-window-styles')) return;
    const style = document.createElement('style'); style.id = 'fm-window-styles';
    style.textContent = `
.fm-window,.fm-window *{box-sizing:border-box}.fm-window{position:absolute;display:flex;flex-direction:column;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;resize:none!important;overflow:hidden;background:#fff;color:#101828;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 14px 42px #10182826}
.fm-window{transition:left .32s cubic-bezier(.22,1,.36,1),top .32s cubic-bezier(.22,1,.36,1),width .32s cubic-bezier(.22,1,.36,1),height .32s cubic-bezier(.22,1,.36,1),border-radius .32s,box-shadow .32s}
.fm-window.is-gesturing{transition:none!important}
.fm-window[data-window=docked] .fm-window-resize:not(.is-dock-divider){display:none!important}
.fm-window-resize.is-dock-divider{display:block!important}
.fm-window-menu hr{border:0;border-top:1px solid #e4e7ec;margin:5px 4px}
.fm-window-preview{box-sizing:border-box;position:fixed;pointer-events:none;z-index:2147483200;border:2px solid #528bff;border-radius:12px;background:#528bff30;box-shadow:0 0 0 1px #fff5 inset;transition:left .2s,top .2s,width .2s,height .2s,opacity .15s;animation:fm-preview-in .15s ease-out}
@keyframes fm-preview-in{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.fm-window,.fm-window-preview{transition:none!important;animation:none!important}}
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
.fm-window-menu{position:fixed;z-index:2147483647;background:#fff;color:#101828;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 12px 36px #10182830;padding:6px;width:230px;font:13px Arial,sans-serif}
.fm-window-dock-options{display:flex;gap:4px;align-items:center}.fm-window-dock-options button{display:grid!important;place-items:center;width:34px!important;height:32px;padding:5px!important}.fm-window-dock-options svg{width:22px;height:18px}.fm-window-dock-options hr{align-self:stretch;border:0!important;border-left:1px solid #e4e7ec!important;margin:3px 2px!important}.fm-window-menu button{display:block;width:100%;padding:9px 10px;text-align:left;border:0;border-radius:6px;background:none;color:inherit;cursor:pointer}.fm-window-menu button:hover,.fm-window-menu button:focus{background:#f2f4f7}
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
    for (const [target, saved] of record.targets) { target.style.width = saved.width; target.style.marginRight = saved.marginRight; target.style.marginLeft=saved.marginLeft; target.style.height=saved.height; target.style.marginTop=saved.marginTop; target.style.transition=saved.transition; }
    hosts.delete(host);
  }
  function box(win, left, top, width, height){
    if (win.viewportCoordinates && !['modal','fullscreen'].includes(win.mode)) { const bounds=win.host.getBoundingClientRect(); left+=bounds.left; top+=bounds.top; }
    for (const [key, value] of Object.entries({left:`${left}px`,top:`${top}px`,right:'auto',bottom:'auto',width:`${width}px`,height:`${height}px`})) win.element.style.setProperty(key,value,'important');
  }
  function layout(host,previewOnly=null){
    const geometry=new Map();
    const place=(win,left,top,width,height)=>{geometry.set(win,{left,top,width,height});if(!previewOnly)box(win,left,top,width,height);};
    const active = [...windows].filter(win => win.host === host && win.visible);
    const width = host.clientWidth, height = host.clientHeight;
    const docks = active.filter(win => win.mode === 'docked');
    const mobileOverlayDock = width <= 640 && docks.some(win => win.mobileFullDock);
    const leftDocks=docks.filter(w=>w.dockSide.endsWith('left'));
    const rightDocks=docks.filter(w=>w.dockSide.endsWith('right'));
    const dockWidth=win=>mobileOverlayDock && win.mobileFullDock ? width : win.dockWidth;
    function laneSize(list){return list.reduce((sum,w)=>sum+(w.dockSide.includes('-') ? 0 : dockWidth(w)),0)+Math.max(0,...list.filter(w=>w.dockSide.includes('-')).map(w=>dockWidth(w)));}
    const desired=laneSize(leftDocks)+laneSize(rightDocks);
    const budget=mobileOverlayDock ? width : Math.max(0,width-Math.min(320,width*.35));
    const scale=desired>budget ? budget/desired : 1;
    let leftReserved=laneSize(leftDocks)*scale,rightReserved=laneSize(rightDocks)*scale;
    let reserved=leftReserved+rightReserved,minimized=0;
    const minimizedWidth = Math.min(224, Math.max(0, width - 16));
    const minimizedColumns = Math.max(1, Math.floor((width - 8) / (minimizedWidth + 6)));
    function placeLane(list,right){
      let offset=0;
      const cornerWidth=Math.max(0,...list.filter(w=>w.dockSide.includes('-')).map(w=>dockWidth(w)))*scale;
      const corners=list.filter(w=>w.dockSide.includes('-'));
      for(const win of [...list.filter(w=>!w.dockSide.includes('-')),...corners]){
        const corner=win.dockSide.includes('-'),size=corner ? cornerWidth : dockWidth(win)*scale,inset=win.topInset();
        const group=corner ? corners.filter(w=>w.dockSide===win.dockSide) : [win];
        const half=(height-inset)/2,h=corner ? half/group.length : height-inset,x=right ? width-offset-size : offset;
        const y=inset+(win.dockSide.startsWith('bottom-') ? half : 0)+(corner ? group.indexOf(win)*h : 0);
        place(win,x,y,size,Math.max(0,h));
        if(!previewOnly)win.dockBox={left:x,top:y,width:size,height:h};
        if(!previewOnly)win.divider=right ? 'w' : 'e';
        if(!corner)offset+=size;
      }
    }
    placeLane(leftDocks,false);placeLane(rightDocks,true);
    const topDocks=docks.filter(w=>w.dockSide==='top'),bottomDocks=docks.filter(w=>w.dockSide==='bottom');
    const inset=Math.max(0,...active.map(w=>w.topInset()));
    const verticalDesired=[...topDocks,...bottomDocks].reduce((sum,w)=>sum+w.dockHeight,0);
    const verticalScale=Math.min(1,Math.max(0,height-inset-200)/Math.max(1,verticalDesired));
    let topReserved=0,bottomReserved=0;
    for(const win of [...topDocks,...bottomDocks]){
      const h=win.dockHeight*verticalScale,top=win.dockSide==='top';
      const y=top ? inset+topReserved : height-bottomReserved-h;
      place(win,leftReserved,y,width-reserved,h);if(!previewOnly)win.dockBox={left:leftReserved,top:y,width:width-reserved,height:h};if(!previewOnly)win.divider=top ? 's' : 'n';
      if(top)topReserved+=h;else bottomReserved+=h;
    }
    if(previewOnly)return geometry.get(previewOnly);
    for(const win of docks)for(const grip of win.element.querySelectorAll('.fm-window-resize'))grip.classList.toggle('is-dock-divider',grip.dataset.resize===win.divider);
    const record = hosts.get(host);
    for (const win of active) {
      if (win.contentTarget && !record.targets.has(win.contentTarget)) record.targets.set(win.contentTarget,{width:win.contentTarget.style.width,marginRight:win.contentTarget.style.marginRight,marginLeft:win.contentTarget.style.marginLeft,height:win.contentTarget.style.height,marginTop:win.contentTarget.style.marginTop,transition:win.contentTarget.style.transition});
    }
    for (const [target, saved] of record.targets) {
      target.style.transition='width .32s cubic-bezier(.22,1,.36,1),height .32s cubic-bezier(.22,1,.36,1),margin .32s cubic-bezier(.22,1,.36,1)';
      if(root.matchMedia('(prefers-reduced-motion: reduce)').matches || active.some(w=>w.element.classList.contains('is-gesturing')))target.style.transition='none';
      target.style.marginLeft=leftReserved ? `${leftReserved}px` : saved.marginLeft;
      target.style.height=topReserved+bottomReserved ? `calc(100% - ${topReserved+bottomReserved}px)` : saved.height;
      target.style.marginTop=topReserved ? `${topReserved}px` : saved.marginTop;
      target.style.width = reserved ? `calc(100% - ${reserved}px)` : saved.width;
      target.style.marginRight = rightReserved ? `${rightReserved}px` : saved.marginRight;
    }
    for (const win of active) {
      const inset = win.topInset();
      if (win.mode === 'fullscreen') place(win,0,0,innerWidth,innerHeight);
      if (win.mode === 'modal') { const w=Math.min(1720,innerWidth*.96),h=Math.min(1180,innerHeight*.92); place(win,(innerWidth-w)/2,(innerHeight-h)/2,w,h); }
      if (win.mode === 'full') place(win,leftReserved,inset+topReserved,Math.max(0,width-reserved),Math.max(0,height-inset-topReserved-bottomReserved));
      if (win.mode === 'minimized') {
        const column = minimized % minimizedColumns, row = Math.floor(minimized++ / minimizedColumns);
        place(win,Math.max(0,width-8-minimizedWidth-column*(minimizedWidth+6)),Math.max(inset,height-8-32-row*38),minimizedWidth,32);
      }
      if (win.mode === 'floating') {
        const r = win.rect;
        r.width = Math.min(Math.max(win.minWidth,r.width),width);
        r.height = Math.min(Math.max(win.minHeight,r.height),Math.max(0,height-inset));
        r.left = Math.max(0,Math.min(r.left,width-r.width)); r.top = Math.max(inset,Math.min(r.top,height-r.height));
        place(win,r.left,r.top,r.width,r.height);
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
    function outerPoint(event){const frame=headerDocument!==document ? headerDocument.defaultView.frameElement?.getBoundingClientRect() : null;return {x:event.clientX+(frame?.left||0),y:event.clientY+(frame?.top||0)};}
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
      pinned:false, visible:!element.hidden, dockWidth:options.dockWidth || 440, dockHeight:options.dockHeight || 360, dockSide:'right',
      topInset:() => Math.max(0,Number(options.topInset?.(win.host) || 0)),
      rect:{left:Math.max(0,host.clientWidth-(options.width || 640)-24),top:72,width:options.width || 640,height:options.height || 520}
    };
    function fitFloatingSize(){
      const width=win.host.clientWidth,height=Math.max(0,win.host.clientHeight-win.topInset());
      win.rect.width=Math.min(width,Math.max(Math.min(win.minWidth,width),Math.min(win.rect.width,width*.72)));
      win.rect.height=Math.min(height,Math.max(Math.min(win.minHeight,height),Math.min(win.rect.height,height*.60)));
    }
    fitFloatingSize();
    win.rect.left=Math.max(0,host.clientWidth-win.rect.width-24);
    windows.add(win); element.classList.add('fm-window'); if (!options.customChrome) header.classList.add('fm-window-header'); title?.classList.add('fm-window-title'); if (options.titleMenu === false) title?.classList.add('fm-window-title-plain'); options.body?.classList.add('fm-window-content');
    element.setAttribute('role','region'); element.setAttribute('aria-label',options.label || 'Window');
    const controls = document.createElement('div'); controls.className = 'fm-window-controls'; (options.controlsHost || header).append(controls);
    const buttons = {};
    for (const [action, icon] of [['place','table-columns'],['minimize','minus'],['maximize','expand'],['close','xmark']]) {
      const button = document.createElement('button'); button.type='button'; button.dataset.windowAction=action; button.innerHTML=`<i class="fas fa-${icon}" aria-hidden="true"></i>`; controls.append(button); buttons[action]=button;
    }
    if (options.presentationModes) {
      for (const [action,icon] of [['modal','window-maximize'],['floating','up-down-left-right'],['fullscreen','up-right-and-down-left-from-center']]) {
        if(action==='fullscreen' && options.allowFullscreen===false)continue;
        const button=document.createElement('button');button.type='button';button.dataset.windowAction=action;button.innerHTML=`<i class="fas fa-${icon}" aria-hidden="true"></i>`;controls.append(button);buttons[action]=button;
        button.onclick=()=>action === 'pin' ? setPinned(!win.pinned) : setMode(action);
      }
    }
    const name = options.name || 'window';
    function chrome(){
      element.style.position = win.viewportCoordinates || ['modal','fullscreen'].includes(win.mode) ? 'fixed' : 'absolute';
      element.dataset.window = win.mode; element.dataset.pinned=String(win.pinned);
      const dock = true;
      const labels = {place:`${dock ? 'Dock' : 'Float'} ${name}`,minimize:`${win.mode === 'minimized' ? 'Restore' : 'Minimize'} ${name}`,maximize:`${win.mode === 'full' ? 'Float' : 'Maximize'} ${name}`,close:`Close ${name}`,modal:`Show ${name} as a modal`,floating:`Float ${name}`,fullscreen:`Fill entire screen with ${name}`,pin:`${win.pinned ? 'Unpin' : 'Pin'} ${name}`};
      labels.place=`Dock ${name} to the ${win.mode==='docked' && win.dockSide==='right' ? 'left' : 'right'} (right-click for placement)`;
      if(options.presentationModes) { labels.maximize=`Fill workspace with ${name}`; }
      if (title && options.titleMenu !== false) {
        title.setAttribute('aria-label',win.mode === 'minimized' ? labels.minimize : ((v0) => globalThis.PlatformLanguage?.text("window-manager","m_d2465937dae930",`${v0} window menu`,{v0}) ?? `${v0} window menu`)(name));
        title.title=win.mode === 'minimized' ? labels.minimize : (globalThis.PlatformLanguage?.text("window-manager","m_e271e8dbdf1d3d","Window menu (right-click or Alt+Space)") ?? "Window menu (right-click or Alt+Space)");
      }
      for (const [key,button] of Object.entries(buttons)) { button.title=labels[key]; button.setAttribute('aria-label',labels[key]); }
      buttons.place.innerHTML=`<i class="fas fa-${dock ? 'table-columns' : 'window-restore'}" aria-hidden="true"></i>`;
      buttons.maximize.innerHTML=`<i class="fas fa-${!options.presentationModes && win.mode === 'full' ? 'window-restore' : 'expand'}" aria-hidden="true"></i>`;
      buttons.maximize.style.order=win.mode === 'full' ? '1' : '2'; buttons.minimize.style.order=win.mode === 'full' ? '2' : '1'; buttons.close.style.order='7';
      if(options.presentationModes) { for(const [action,mode] of Object.entries({modal:'modal',floating:'floating',place:'docked',maximize:'full',fullscreen:'fullscreen'})) buttons[action]?.setAttribute('aria-pressed',String(win.mode===mode)); buttons.modal.style.order='0';buttons.floating.style.order='1';buttons.place.style.order='2';buttons.maximize.style.order='3';if(buttons.fullscreen)buttons.fullscreen.style.order='4';buttons.minimize.style.order='5'; }
      buttons.minimize.innerHTML=`<i class="fas fa-${win.mode === 'minimized' ? 'window-restore' : 'minus'}" aria-hidden="true"></i>`;
    }
    function notify(reason){ options.onChange?.({mode:win.mode,dockSide:win.dockSide,pinned:win.pinned,reason}); }
    function setMode(mode,{silent=false}={}){
      if (!modes.includes(mode) || (mode==='fullscreen' && options.allowFullscreen===false)) return;
      if (mode !== win.mode) {
        options.onBeforeModeChange?.({mode,previous:win.mode});
        if (mode === 'minimized') win.previous = win.mode;
        if(mode==='floating' && (win.rect.width>=win.host.clientWidth*.9 || win.rect.height>=Math.max(0,win.host.clientHeight-win.topInset())*.9))fitFloatingSize();
        win.mode=mode;
      }
      chrome(); layout(win.host); restack(); if (!silent) notify('mode');
    }
    function setPinned(value,{silent=false}={}){ win.pinned=!!value; chrome(); if (!silent) notify('pin'); }
    function focus(){ win.stackOrder=++order; restack(); }
    async function requestClose(){ if (buttons.close.disabled) return; buttons.close.disabled=true; try { if (options.onClose) await options.onClose(); else {win.visible=false;element.hidden=true;layout(win.host);} } finally { buttons.close.disabled=false; } }
    function dock(side='right'){if(!placements.includes(side))return;win.dockSide=side;element.dataset.dock=side;setMode('docked');}
    win.dock=dock;
    buttons.place.onclick=()=>dock(win.mode==='docked' && win.dockSide==='right' ? 'left' : 'right');
    buttons.place.oncontextmenu=event=>{event.stopPropagation();showMenu(event,true);};
    function restore(){if(win.mode === 'minimized'){closeMenu();setMode(win.previous);focus();}}
    buttons.minimize.onclick=() => win.mode === 'minimized' ? restore() : setMode('minimized');
    buttons.maximize.onclick=() => setMode(options.presentationModes ? 'full' : win.mode === 'full' ? 'floating' : 'full');
    buttons.close.onclick=requestClose;
    function showMenu(event,dockOnly=false){
      event.preventDefault(); closeMenu(); menu=document.createElement('div'); menu.className='fm-window-menu'; menu.setAttribute('role','menu');
      const dockOptions=document.createElement('div');dockOptions.className='fm-window-dock-options';dockOptions.setAttribute('role','group');dockOptions.setAttribute('aria-label','Dock placement');
      for(const [index,side] of placements.slice(0,6).entries()) {
        if(index===2)dockOptions.append(document.createElement('hr'));
        const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.setAttribute('aria-label','Dock '+side.replace('-',' '));button.title='Dock '+side.replace('-',' ');button.dataset.dockPlacement=side;
        const corner=side.includes('-'),left=side.includes('left'),top=side.startsWith('top');
        button.innerHTML=`<svg viewBox="0 0 24 20" aria-hidden="true"><rect x="2" y="2" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v16${corner?'M2 10h20':''}" fill="none" stroke="currentColor" stroke-width="1"/><rect x="${left?4:14}" y="${corner&&!top?12:4}" width="6" height="${corner?4:12}" rx="1" fill="currentColor"/></svg>`;
        button.onclick=()=>{closeMenu();dock(side);};dockOptions.append(button);
      }
      const items=dockOnly ? [] : [['Float',()=>setMode('floating')],['Close',requestClose]];
      if(options.presentationModes && !dockOnly){items.unshift(['Modal',()=>setMode('modal')],['Fill workspace',()=>setMode('full')]);if(options.allowFullscreen!==false)items.unshift(['Fill entire screen',()=>setMode('fullscreen')]);}
      for(const [label,action] of items) {const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{closeMenu();action();};if(label==='Close')menu.append(dockOptions);menu.append(button);}
      if(dockOnly)menu.append(dockOptions);
      menu.style.width='max-content';menu.style.pointerEvents='auto';(options.menuHost || document.body).append(menu);
      const anchor=dockOnly?buttons.place:header,r=anchor.getBoundingClientRect(),view=menu.ownerDocument.defaultView;
      const frameOffset=menu.ownerDocument!==headerDocument?headerDocument.defaultView.frameElement?.getBoundingClientRect():null;
      const pointer=event.type==='contextmenu'&&!dockOnly&&Number.isFinite(event.clientX);
      const point=menu.ownerDocument===headerDocument?{x:event.clientX,y:event.clientY}:outerPoint(event);
      const x=pointer?point.x:r.left+(frameOffset?.left||0),y=pointer?point.y+6:r.bottom+(frameOffset?.top||0)+4;
      menu.style.left=`${Math.max(8,Math.min(x,view.innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,view.innerHeight-menu.offsetHeight-8))}px`;menu.querySelector('button')?.focus();
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
      if(event.button!==0 || (!edge && (!['floating','docked'].includes(win.mode) || event.target.closest('button,input,a,select'))))return;
      endGesture?.();event.preventDefault(); dragged=false; focus();element.classList.add('is-gesturing');
      let candidate=null,preview=null;
      function clearPreview(){preview?.remove();preview=null;candidate=null;}
      function updatePreview(next){
        const p=outerPoint(next),b=win.host.getBoundingClientRect(),x=p.x-b.left,y=p.y-b.top,top=win.topInset(),threshold=28,corner=85;
        let side=null;
        if(x<=threshold || x>=b.width-threshold){const horizontal=x<b.width/2 ? 'left':'right';side=y<=top+corner ? 'top-'+horizontal : y>=b.height-corner ? 'bottom-'+horizontal : horizontal;}
        else if(y<=top+threshold || y>=b.height-threshold){const vertical=y<b.height/2 ? 'top':'bottom';side=x<=corner ? vertical+'-left' : x>=b.width-corner ? vertical+'-right' : vertical;}
        if(!side){clearPreview();return;}candidate=side;
        if(!preview){preview=document.createElement('div');preview.className='fm-window-preview';document.body.append(preview);}
        const oldMode=win.mode,oldSide=win.dockSide;
        let geometry;
        try{win.mode='docked';win.dockSide=side;geometry=layout(win.host,win);}finally{win.mode=oldMode;win.dockSide=oldSide;}
        Object.assign(preview.style,{left:(b.left+geometry.left)+'px',top:(b.top+geometry.top)+'px',width:geometry.width+'px',height:geometry.height+'px'});
      }
      const handle=event.currentTarget; handle.setPointerCapture(event.pointerId);
      if(edge) handle.classList.add('is-resizing');
      let start={...win.rect};const bounds=element.getBoundingClientRect(),grab=outerPoint(event),grabRatio=Math.max(0,Math.min(1,(grab.x-bounds.left)/Math.max(1,bounds.width))),grabY=Math.max(0,Math.min(header.getBoundingClientRect().height,grab.y-bounds.top));const x=event.screenX,y=event.screenY;
      const move=next=>{
        const dx=next.screenX-x,dy=next.screenY-y;if(Math.abs(dx)+Math.abs(dy)>3)dragged=true;
        if(!edge && win.mode==='docked'){
          if(!dragged)return;
          const point=outerPoint(next),hostBounds=win.host.getBoundingClientRect();
          setMode('floating');
          start={...win.rect,left:point.x-hostBounds.left-grabRatio*win.rect.width-dx,top:point.y-hostBounds.top-grabY-dy};
        }
        if(win.mode==='docked'){if(['top','bottom'].includes(win.dockSide))win.dockHeight=Math.max(120,bounds.height+(win.dockSide==='top' ? dy : -dy));else win.dockWidth=Math.max(win.minWidth,Math.min(win.host.clientWidth,bounds.width+(win.dockSide.endsWith('left') ? dx : -dx)));layout(win.host);return;}
        if(!edge){win.rect={...start,left:start.left+dx,top:start.top+dy};layout(win.host);if(dragged)updatePreview(next);return;}
        let l=start.left,t=start.top,r=l+start.width,b=t+start.height;
        if(edge.includes('w'))l=Math.max(0,Math.min(r-Math.min(win.minWidth,win.host.clientWidth),l+dx));
        if(edge.includes('e'))r=Math.min(win.host.clientWidth,Math.max(l+win.minWidth,r+dx));
        if(edge.includes('n'))t=Math.max(win.topInset(),Math.min(b-win.minHeight,t+dy));
        if(edge.includes('s'))b=Math.min(win.host.clientHeight,Math.max(t+win.minHeight,b+dy));
        win.rect={left:l,top:t,width:r-l,height:b-t};layout(win.host);
      };
      const end=next=>{const side=candidate;clearPreview();element.classList.remove('is-gesturing');handle.classList.remove('is-resizing');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);endGesture=null;if(next?.type==='pointerup' && side)dock(side);else layout(win.host);};
      endGesture=end;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    }
    const drag=event=>gesture(event,'');header.addEventListener('pointerdown',drag);
    const grips=[];
    for(const edge of ['n','e','s','w','nw','ne','sw','se']){
      const grip=document.createElement('div');grip.className='fm-window-resize';grip.dataset.resize=edge;grip.tabIndex=0;grip.setAttribute('role','separator');grip.setAttribute('aria-label',((v0,v1) => globalThis.PlatformLanguage?.text("window-manager","m_0d80b4a3bd88a0",`Resize ${v0} ${v1}`,{v0,v1}) ?? `Resize ${v0} ${v1}`)(name,edge));
      grip.addEventListener('pointerdown',event=>gesture(event,edge));
      grip.addEventListener('dblclick',event=>{
        if(win.mode!=='docked' || edge!==win.divider)return;event.preventDefault();
        const a=win.dockBox;
        const other=[...windows].find(w=>w!==win && w.host===win.host && w.visible && w.mode==='docked' && w.dockBox && (edge==='w' ? Math.abs(w.dockBox.left+w.dockBox.width-a.left)<2 : edge==='e' ? Math.abs(a.left+a.width-w.dockBox.left)<2 : edge==='n' ? Math.abs(w.dockBox.top+w.dockBox.height-a.top)<2 : Math.abs(a.top+a.height-w.dockBox.top)<2) && (['w','e'].includes(edge) ? Math.min(a.top+a.height,w.dockBox.top+w.dockBox.height)>Math.max(a.top,w.dockBox.top) : Math.min(a.left+a.width,w.dockBox.left+w.dockBox.width)>Math.max(a.left,w.dockBox.left)));
        if(other){const side=win.dockSide,otherSide=other.dockSide,width=win.dockWidth,height=win.dockHeight;win.dockWidth=other.dockWidth;win.dockHeight=other.dockHeight;other.dockWidth=width;other.dockHeight=height;if(side===other.dockSide){const all=[...windows],i=all.indexOf(win),j=all.indexOf(other);[all[i],all[j]]=[all[j],all[i]];windows.clear();all.forEach(w=>windows.add(w));}else{win.dockSide=otherSide;other.dock(side);}dock(win.dockSide);}
        else{if(['top','bottom'].includes(win.dockSide))win.dockHeight=win.host.clientHeight-win.topInset()-a.height;else win.dockWidth=win.contentTarget?.clientWidth || win.host.clientWidth-a.width;dock(['top','bottom'].includes(win.dockSide) ? (win.dockSide==='top' ? 'bottom':'top') : win.dockSide.replace(/left|right/g,part=>part==='left' ? 'right':'left'));}
      });
      grip.addEventListener('keydown',event=>{
        if(!event.key.startsWith('Arrow'))return;event.preventDefault();const dx=event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0,dy=event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0;
        if(win.mode==='docked'){if(['top','bottom'].includes(win.dockSide))win.dockHeight=Math.max(120,win.dockHeight+(win.dockSide==='top' ? dy : -dy));else win.dockWidth=Math.max(win.minWidth,win.dockWidth+(win.dockSide.endsWith('left') ? dx : -dx));}
        else {if(edge.includes('w')){const w=Math.max(win.minWidth,win.rect.width-dx);win.rect.left+=win.rect.width-w;win.rect.width=w;}if(edge.includes('e'))win.rect.width+=dx;if(edge.includes('n')){const h=Math.max(win.minHeight,win.rect.height-dy);win.rect.top+=win.rect.height-h;win.rect.height=h;}if(edge.includes('s'))win.rect.height+=dy;}
        layout(win.host);
      });element.append(grip);grips.push(grip);
    }
    const refreshViewport=()=>layout(win.host); window.addEventListener('resize',refreshViewport);
    chrome();layout(host);focus();
    return {
      element, setMode, setPinned, focus, dock,
      restore,
      get state(){return {mode:win.mode,dockSide:win.dockSide,pinned:win.pinned,visible:win.visible};},
      setVisible(value){win.visible=!!value;element.hidden=!win.visible;layout(win.host);if(value)focus();},
      rehost(nextHost,contentTarget){if(nextHost===win.host)return;const old=win.host;registerHost(nextHost);win.host=nextHost;win.contentTarget=contentTarget;nextHost.append(element);layout(old);releaseHost(old);layout(nextHost);},
      refresh(){layout(win.host);},
      destroy(){if(headerDocument!==document){headerDocument.removeEventListener('keydown',keydown);headerDocument.removeEventListener('pointerdown',dismissMenuOnPointer);headerDocument.defaultView?.removeEventListener('keydown',dismissMenuOnKey,true);}window.removeEventListener('resize',refreshViewport);endGesture?.();closeMenu();windows.delete(win);controls.remove();grips.forEach(grip=>grip.remove());header.removeEventListener('pointerdown',drag);header.removeEventListener('contextmenu',showMenu);header.removeEventListener('click',titleClick);element.removeEventListener('keydown',keydown);element.removeEventListener('pointerdown',focus);element.remove();layout(win.host);releaseHost(win.host);}
    };
  }
  root.FirstMateWindows={attach, ensureStyles:styles};
})(window);
