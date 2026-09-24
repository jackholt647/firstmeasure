/* public/libraries/platform-assistant/platform-assistant.js
 * The global FirstMate AI assistant window: one chat in the shared workspace
 * opened from the top bar (closed by default). Talks to /v1/assistant via
 * window.AssistantAPI; renders markdown replies, "What changed" summaries,
 * and navigation chips that open projects or portal tabs.
 */
(function(){
  'use strict';
  if (!window.Portal) return;

  const AGENT_TIMEOUT_MS = 160000;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];

  const state = {
    built:false,
    open:false,
    booted:false,
    booting:false,
    assistantName:'Assistant',
    threads:[],
    threadId:'',
    messages:[],
    attachments:[],
    pending:false,
    view:'chat', // chat | settings
    sidebarOpen:false,
    historyQuery:'',
    historyMatches:[],
    mode:'docked',
    returnTab:''
  };

  let els = null;
  let assistantWindow = null;
  let recorder = null;
  let recordingStream = null;
  let recordingStarted = 0;
  let recordingTimer = null;
  let waveformFrame = null;
  let audioContext = null;
  let historySearchTimer = null;
  let historySearchGeneration = 0;

  function orgId(){ return clean((window.__APP || {}).userOrgId); }
  function branchId(){
    try { return clean(window.Portal.util?.currentBranchId?.() || (window.__APP || {}).userBranchId) || 'default'; }
    catch (_) { return 'default'; }
  }

  function available(){
    try {
      if (window.Portal.can && window.Portal.capabilities?.can) return window.Portal.can('apps.assistant') !== false;
    } catch (_) {}
    return true;
  }

  // ── Markdown (same minimal renderer as the stats agent chat) ─────────────

  function renderMarkdown(raw){
    const inline = (value) => esc(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    String(raw ?? '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
      if (bullet) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(bullet[1])}</li>`);
      } else if (numbered) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(numbered[1])}</li>`);
      } else if (heading) {
        closeList();
        out.push(`<div class="fma-md-h">${inline(heading[1])}</div>`);
      } else if (!trimmed) {
        closeList();
        out.push('<div class="fma-md-gap"></div>');
      } else {
        closeList();
        out.push(`<div>${inline(line)}</div>`);
      }
    });
    closeList();
    return out.join('');
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  function injectCss(){
    if (document.getElementById('fm-assistant-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-assistant-css';
    style.textContent = `
      .fma-drawer{display:flex;flex-direction:column;color:#101828;font-size:14px;}
      .fma-drawer[hidden]{display:none!important;}
      .fma-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #e4e7ec;}
      .fma-head .fm-window-controls{margin-left:auto;}
      .fma-head .fm-window-controls [data-window-action=close]{display:none;}
      .fma-sidebar-toggle{border:0;background:transparent;font-size:16px;color:#475467;}
      .fma-drawer .fma-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden;}
      .fma-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
      .fma-sidebar{display:none;flex-direction:column;width:min(68%,340px);min-width:0;background:#f8fafc;border-right:1px solid #e4e7ec;z-index:2;}
      .fma-drawer[data-window=full] .fma-sidebar{display:flex;width:280px;flex:0 0 280px;}
      .fma-drawer:not([data-window=full])[data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;box-shadow:12px 0 28px #10182824;}
      .fma-drawer[data-window=full] .fma-sidebar-toggle{visibility:hidden;}
      .fma-sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:18px 14px 10px;}
      .fma-sidebar-head h2{margin:0;font-size:16px;color:#101828;}
      .fma-sidebar-search{padding:0 12px 10px;}
      .fma-sidebar-search[hidden]{display:none;}
      .fma-sidebar-search input{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:8px;padding:9px 10px;font:inherit;background:#fff;}
      .fma-sidebar-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-top:1px solid #e4e7ec;}
      .fma-new{border:0;border-radius:8px;background:var(--primary-readable,var(--primary,#175cd3));color:#fff;padding:9px 11px;font:inherit;font-weight:700;cursor:pointer;}
      .fma-badge{flex:0 0 auto;width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:rgba(var(--primary-rgb,23,92,211),.08);color:var(--primary-readable, var(--primary, #175cd3));font-size:15px;}
      .fma-logo{display:inline-block;width:22px;height:22px;background:var(--primary-readable,var(--primary,#d93025));-webkit-mask:url('/images/logo_square.png') center / contain no-repeat;mask:url('/images/logo_square.png') center / contain no-repeat;}
      .fma-welcome .fma-logo{width:34px;height:34px;margin:0 auto 10px;}
      .fma-head-text{flex:1;min-width:0;}
      .fma-head-text .title{font-weight:850;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-head-text .sub{font-size:11px;color:#98a2b3;font-weight:700;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-icon-btn{flex:0 0 auto;width:32px;height:32px;border-radius:9px;border:1px solid #e4e7ec;background:#fff;color:#667085;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:13px;transition:background .15s ease,color .15s ease,border-color .15s ease;}
      .fma-icon-btn:hover{background:#f2f4f7;color:var(--primary-readable, var(--primary, #175cd3));border-color:#d0d5dd;}
      .fma-msgs{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
      .fma-msgs > *{flex:0 0 auto;}
      .fma-msg{max-width:92%;border-radius:12px;padding:9px 12px;font-size:13.5px;line-height:1.45;word-wrap:break-word;}
      .fma-msg.user{align-self:flex-end;background:var(--primary-readable, var(--primary, #175cd3));color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap;}
      .fma-msg.assistant{align-self:flex-start;background:#f2f4f7;color:#101828;border-bottom-left-radius:4px;}
      .fma-msg.assistant ul,.fma-msg.assistant ol{margin:4px 0;padding-left:20px;display:flex;flex-direction:column;gap:2px;}
      .fma-msg.assistant code{background:#e7ebf0;border-radius:4px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
      .fma-msg.assistant a{color:var(--primary-readable, var(--primary, #175cd3));font-weight:600;}
      .fma-msg.assistant.failed{background:#fffaeb;border:1px solid #fedf89;color:#93370d;}
      .fma-md-h{font-weight:800;margin:5px 0 2px;}
      .fma-md-gap{height:7px;}
      .fma-msg-changes{margin-top:8px;border-top:1px solid #e4e7ec;padding-top:7px;font-size:12px;color:#475467;}
      .fma-msg-changes .label{font-size:10.5px;font-weight:800;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;}
      .fma-msg-changes div.row{display:flex;gap:6px;align-items:baseline;}
      .fma-actions{align-self:flex-start;display:flex;flex-wrap:wrap;gap:7px;max-width:92%;}
      .fma-action{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-weight:700;font-size:12.5px;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease,transform .12s ease;}
      .fma-action:hover{border-color:var(--primary-readable, var(--primary, #175cd3));color:var(--primary-readable, var(--primary, #175cd3));background:rgba(var(--primary-rgb,23,92,211),.06);}
      .fma-action:active{transform:scale(.97);}
      .fma-action i{font-size:11px;}
      .fma-pending{align-self:flex-start;color:#667085;font-size:13px;display:flex;align-items:center;gap:8px;padding:4px 2px;}
      .fma-pending .dots span{animation:fmaPulse 1.2s infinite;display:inline-block;}
      .fma-pending .dots span:nth-child(2){animation-delay:.2s}.fma-pending .dots span:nth-child(3){animation-delay:.4s}
      @keyframes fmaPulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
      @keyframes fmaRise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
      .fma-anim{animation:fmaRise .28s cubic-bezier(.4,0,.2,1) both;}
      .fma-welcome{align-self:stretch;text-align:center;color:#667085;padding:44px 18px 10px;}
      .fma-welcome i{font-size:24px;color:var(--primary-readable, var(--primary, #175cd3));margin-bottom:10px;display:block;}
      .fma-welcome .hi{font-weight:800;color:#101828;margin-bottom:4px;}
      .fma-welcome .hint{font-size:12.5px;line-height:1.5;}
      .fma-suggests{display:flex;flex-direction:column;gap:7px;margin-top:14px;}
      .fma-suggest{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px 12px;text-align:left;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;color:#344054;transition:background .15s ease,border-color .15s ease,transform .12s ease;}
      .fma-suggest:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-history{flex:1;min-height:0;overflow:auto;padding:4px 10px;display:flex;flex-direction:column;gap:6px;}
      .fma-settings{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px;}
      .fma-settings h2{font-size:17px;margin:0}.fma-settings p{color:#667085;margin:0;line-height:1.45}
      .fma-settings label{font-weight:700;display:flex;flex-direction:column;gap:6px}
      .fma-settings textarea,.fma-settings input[type=text]{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:10px;font:inherit;resize:vertical}
      .fma-settings button{align-self:flex-start;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:8px 11px;cursor:pointer;font:inherit}
      .fma-settings .fma-memory{display:flex;gap:6px;align-items:center}.fma-settings .fma-memory input{flex:1;min-width:0}
      .fma-settings .fma-status{font-size:12px;color:#475467}
      .fma-history-item{width:100%;text-align:left;border:1px solid transparent;border-radius:10px;padding:9px 12px;background:transparent;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:background .15s ease,border-color .15s ease;}
      .fma-history-item:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-history-item[aria-current=true]{background:#e9eef8;border-color:#cbd5e1;}
      .fma-history-item .name{font-weight:700;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-history-item .meta{font-size:11.5px;color:#98a2b3;font-weight:600;}
      .fma-empty{color:#98a2b3;text-align:center;padding:22px 8px;font-weight:600;}
      .fma-composer{position:relative;flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-top:1px solid #e4e7ec;}
      .fma-compose-shell{display:flex;align-items:flex-end;gap:5px;min-height:54px;padding:5px 7px;border:1px solid #e4e7ec;border-radius:28px;background:#fff;box-shadow:0 3px 14px #10182812;}
      .fma-compose-shell:focus-within{border-color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-compose-shell textarea{flex:1;resize:none;border:0;background:transparent;padding:10px 5px;font:inherit;min-height:42px;max-height:170px;outline:none;}
      .fma-compose-icon{flex:0 0 auto;align-self:flex-end;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:#344054;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:16px;}
      .fma-compose-icon:hover{background:#f2f4f7;}
      .fma-send{align-self:flex-end;width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;background:var(--primary-readable,var(--primary,#175cd3));color:#fff;display:none;align-items:center;justify-content:center;font-size:15px;transition:filter .15s ease,transform .12s ease;}
      .fma-composer[data-can-send=true] .fma-send{display:inline-flex;}
      .fma-send:hover{filter:brightness(1.08);}
      .fma-send:active{transform:scale(.95);}
      .fma-send:disabled{opacity:.5;cursor:default;}
      .fma-attachments{display:flex;flex-wrap:wrap;gap:6px;}
      .fma-attachments:empty{display:none;}
      .fma-attachment{display:flex;align-items:center;gap:6px;max-width:100%;border:1px solid #e4e7ec;border-radius:999px;padding:5px 8px;font-size:12px;background:#f8fafc;}
      .fma-attachment span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
      .fma-attachment button{border:0;background:transparent;cursor:pointer;color:#667085;}
      .fma-attach-menu{position:absolute;bottom:calc(100% - 10px);left:15px;z-index:5;display:flex;flex-direction:column;min-width:170px;padding:5px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 8px 24px #10182824;}
      .fma-attach-menu[hidden]{display:none;}
      .fma-attach-menu button{border:0;background:transparent;text-align:left;padding:10px;border-radius:8px;cursor:pointer;font:inherit;}
      .fma-attach-menu button:hover{background:#f2f4f7;}
      .fma-recording{display:none;align-items:center;gap:10px;flex:1;min-width:0;height:40px;}
      .fma-composer[data-recording=true] .fma-recording{display:flex;}
      .fma-composer[data-recording=true] textarea,.fma-composer[data-recording=true] [data-fma=attach],.fma-composer[data-recording=true] [data-fma=mic]{display:none;}
      .fma-recording-time{font-size:12px;color:#667085;font-variant-numeric:tabular-nums;}
      .fma-wave{display:flex;align-items:center;gap:3px;flex:1;min-width:0;height:28px;overflow:hidden;}
      .fma-wave span{flex:1;min-width:2px;max-width:4px;height:4px;border-radius:50%;background:var(--primary-readable,var(--primary,#175cd3));transition:height .12s ease;}
      .fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings{padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full] .fma-composer{padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full] .fma-msg{max-width:75%;}
      @media (min-width:641px){.fma-attach-menu [data-fma=pickCamera]{display:none;}}
      @media (max-width:640px){.fma-drawer[data-window=full] .fma-sidebar{display:none}.fma-drawer[data-window=full] .fma-sidebar-toggle{visibility:visible}.fma-drawer[data-window=full][data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;width:min(68%,340px);box-shadow:12px 0 28px #10182824}.fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings,.fma-drawer[data-window=full] .fma-composer{padding-left:14px;padding-right:14px}.fma-drawer[data-window=full] .fma-msg{max-width:92%;}}
    `;
    document.head.appendChild(style);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  function build(){
    if (state.built) return;
    injectCss();
    const drawer = document.createElement('div');
    drawer.className = 'fma-drawer';
    drawer.id = 'platformAssistantDrawer';
    drawer.hidden = true;
    drawer.innerHTML = `
      <div class="fma-head">
        <button type="button" class="fma-icon-btn fma-sidebar-toggle" data-fma="history" title="Conversations" aria-label="Open conversations" aria-expanded="false"><i class="fas fa-bars-staggered" aria-hidden="true"></i></button>
      </div>
      <div class="fma-body" data-fma="body">
      <aside class="fma-sidebar" data-fma="sidebar" aria-label="Conversations">
        <div class="fma-sidebar-head"><h2>Conversations</h2><button type="button" class="fma-icon-btn" data-fma="search" title="Search conversations" aria-label="Search conversations"><i class="fas fa-magnifying-glass" aria-hidden="true"></i></button></div>
        <div class="fma-sidebar-search" data-fma="searchWrap" hidden><input type="search" data-fma="searchInput" placeholder="Search conversations" aria-label="Search conversations"></div>
        <div class="fma-history" data-fma="historyList"></div>
        <div class="fma-sidebar-foot"><button type="button" class="fma-new" data-fma="new"><i class="fas fa-plus" aria-hidden="true"></i> New conversation</button><button type="button" class="fma-icon-btn" data-fma="settings" title="Assistant settings" aria-label="Assistant settings"><i class="fas fa-gear" aria-hidden="true"></i></button></div>
      </aside>
      <div class="fma-content" data-fma="content">
      <div class="fma-msgs" data-fma="msgs"></div>
      <div class="fma-settings" data-fma="settingsPanel" style="display:none;"></div>
      <div class="fma-composer" data-fma="composer">
        <div class="fma-attachments" data-fma="attachments"></div>
        <div class="fma-compose-shell">
          <button type="button" class="fma-compose-icon" data-fma="attach" title="Add files or camera photo" aria-label="Add files or camera photo"><i class="fas fa-plus" aria-hidden="true"></i></button>
          <textarea data-fma="input" rows="1" placeholder="${(globalThis.PlatformLanguage?.text("platform-assistant","m_2f18b7bd77b80f","Ask about anything in your workspace...") ?? "Ask about anything in your workspace...")}"></textarea>
          <div class="fma-recording" data-fma="recording"><button type="button" class="fma-compose-icon" data-fma="discardRecording" title="Discard recording" aria-label="Discard recording"><i class="fas fa-trash" aria-hidden="true"></i></button><span class="fma-recording-time" data-fma="recordingTime">0:00</span><div class="fma-wave" data-fma="wave"></div></div>
          <button type="button" class="fma-compose-icon" data-fma="mic" title="Dictate" aria-label="Dictate"><i class="fas fa-microphone" aria-hidden="true"></i></button>
          <button type="button" class="fma-send" data-fma="send" title="Send" aria-label="Send"><i class="fas fa-arrow-up" aria-hidden="true"></i></button>
        </div>
        <div class="fma-attach-menu" data-fma="attachMenu" hidden><button type="button" data-fma="pickFile"><i class="fas fa-paperclip" aria-hidden="true"></i> Upload files</button><button type="button" data-fma="pickCamera"><i class="fas fa-camera" aria-hidden="true"></i> Take photo</button></div>
        <input type="file" data-fma="fileInput" multiple hidden><input type="file" data-fma="cameraInput" accept="image/*,video/*" capture="environment" hidden>
      </div>
      </div>
      </div>
    `;
    const host = document.querySelector('main.main') || document.querySelector('.main');
    if (!host || !window.FirstMateWindows) return;
    host.appendChild(drawer);
    els = {
      drawer,
      sidebar: drawer.querySelector('[data-fma="sidebar"]'),
      sidebarToggle: drawer.querySelector('[data-fma="history"]'),
      searchWrap: drawer.querySelector('[data-fma="searchWrap"]'),
      searchInput: drawer.querySelector('[data-fma="searchInput"]'),
      msgs: drawer.querySelector('[data-fma="msgs"]'),
      historyList: drawer.querySelector('[data-fma="historyList"]'),
      settingsPanel: drawer.querySelector('[data-fma="settingsPanel"]'),
      composer: drawer.querySelector('[data-fma="composer"]'),
      attachments: drawer.querySelector('[data-fma="attachments"]'),
      attachMenu: drawer.querySelector('[data-fma="attachMenu"]'),
      fileInput: drawer.querySelector('[data-fma="fileInput"]'),
      cameraInput: drawer.querySelector('[data-fma="cameraInput"]'),
      wave: drawer.querySelector('[data-fma="wave"]'),
      recordingTime: drawer.querySelector('[data-fma="recordingTime"]'),
      input: drawer.querySelector('[data-fma="input"]'),
      send: drawer.querySelector('[data-fma="send"]')
    };

    assistantWindow = window.FirstMateWindows.attach({
      element:drawer, header:drawer.querySelector('.fma-head'),
      body:drawer.querySelector('[data-fma="body"]'), host,
      contentTarget:document.getElementById('mainPanels'), name:'assistant', label:'FirstMate Assistant',
      mode:'docked', dockWidth:440, width:760, height:650, mobileFullDock:true,
      topInset:() => document.getElementById('platformTopbar')?.offsetHeight || document.querySelector('.platform-topbar')?.offsetHeight || 0,
      onChange:({mode}) => {
        state.mode = mode;
        syncSidebar();
        if (mode === 'full' && document.querySelector('.fm-tabpanel.active')?.id !== 'tab_assistant') {
          window.Portal?.tabs?.activateTab?.('assistant');
        } else if (mode === 'minimized') {
          // For this assistant, minimizing returns the conversation to its dock.
          assistantWindow.setMode('docked', {silent:true});
          state.mode = 'docked';
          leaveAssistantTab();
        } else if (mode === 'docked') {
          leaveAssistantTab();
        }
      }, onClose:close
    });
    drawer.querySelector('[data-fma="new"]').addEventListener('click', startNewThread);
    drawer.querySelector('[data-fma="history"]').addEventListener('click', toggleHistory);
    drawer.querySelector('[data-fma="search"]').addEventListener('click', () => {
      els.searchWrap.hidden = !els.searchWrap.hidden;
      if (!els.searchWrap.hidden) els.searchInput.focus();
      else { els.searchInput.value = ''; state.historyQuery = ''; state.historyMatches = []; historySearchGeneration++; clearTimeout(historySearchTimer); renderHistory(); }
    });
    els.searchInput.addEventListener('input', () => {
      state.historyQuery = clean(els.searchInput.value).toLowerCase();
      state.historyMatches = [];
      const generation = ++historySearchGeneration;
      clearTimeout(historySearchTimer);
      renderHistory();
      if (state.historyQuery.length < 2) return;
      historySearchTimer = setTimeout(async () => {
        try {
          const result = await window.AssistantAPI.search(orgId(), state.historyQuery);
          if (generation !== historySearchGeneration) return;
          state.historyMatches = array(result.matches);
          for (const thread of array(result.threads)) {
            if (!state.threads.some((entry) => clean(entry.id) === clean(thread.id))) state.threads.push(thread);
          }
          renderHistory();
        } catch (error) { console.warn('[assistant] conversation search failed', error); }
      }, 200);
    });
    drawer.querySelector('[data-fma="settings"]').addEventListener('click', () => {
      setView(state.view === 'settings' ? 'chat' : 'settings');
      state.sidebarOpen = false;
      syncSidebar();
    });
    els.send.addEventListener('click', sendMessage);
    els.input.addEventListener('input', updateComposer);
    drawer.querySelector('[data-fma="attach"]').addEventListener('click', () => { els.attachMenu.hidden = !els.attachMenu.hidden; });
    drawer.querySelector('[data-fma="pickFile"]').addEventListener('click', () => { els.attachMenu.hidden = true; els.fileInput.click(); });
    drawer.querySelector('[data-fma="pickCamera"]').addEventListener('click', () => { els.attachMenu.hidden = true; els.cameraInput.click(); });
    for (const picker of [els.fileInput, els.cameraInput]) picker.addEventListener('change', () => { addAttachments(picker.files); picker.value = ''; });
    drawer.querySelector('[data-fma="mic"]').addEventListener('click', startRecording);
    drawer.querySelector('[data-fma="discardRecording"]').addEventListener('click', () => stopRecording(true));
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) {
        if (state.sidebarOpen) { state.sidebarOpen = false; syncSidebar(); }
        else close();
      }
    });
    window.addEventListener('fm:portal-tab:activated', (event) => {
      if (event.detail?.id && event.detail.id !== 'assistant') state.returnTab = event.detail.id;
    });
    state.built = true;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function scrollToBottom(){
    if (els?.msgs) els.msgs.scrollTop = els.msgs.scrollHeight;
  }

  function actionChipHtml(action, index){
    const icon = clean(action.kind) === 'project' ? 'fa-folder-open' : 'fa-arrow-up-right-from-square';
    return `<button type="button" class="fma-action" data-action-index="${index}"><i class="fas ${icon}"></i>${esc(action.label)}</button>`;
  }

  function messageHtml(message, animate){
    const data = object(message.data);
    const anim = animate ? ' fma-anim' : '';
    if (clean(message.role) === 'user') {
      const attachments = array(data.attachments).map((item) => clean(object(item).file_name)).filter(Boolean);
      return `<div class="fma-msg user${anim}">${esc(message.content)}${attachments.length ? `<div>${attachments.map((name) => `📎 ${esc(name)}`).join('<br>')}</div>` : ''}</div>`;
    }
    const failed = clean(data.status) === 'failed';
    let html = `<div class="fma-msg assistant${anim}${failed ? ' failed' : ''}">${renderMarkdown(message.content)}`;
    const changes = array(data.changes).map(clean).filter(Boolean);
    if (changes.length) {
      html += `<div class="fma-msg-changes"><div class="label">${(globalThis.PlatformLanguage?.text("platform-assistant","m_c46a636ed38aee","What changed") ?? "What changed")}</div>${String(changes.map((entry) => `<div class="row"><i class="fas fa-check" style="font-size:10px;color:#12b76a;"></i><span>${esc(entry)}</span></div>`).join(''))}</div>`;
    }
    html += '</div>';
    const actions = array(data.actions);
    if (actions.length) {
      html += `<div class="fma-actions${anim}" data-message-id="${esc(clean(message.id))}">${actions.map((action, index) => actionChipHtml(object(action), index)).join('')}</div>`;
    }
    return html;
  }

  function welcomeHtml(){
    const suggestions = [
      'What happened in the business this week?',
      'Find a customer or project for me',
      'What’s overdue on my to-do list?',
      'How many jobs did we sell this month?'
    ];
    return `
      <div class="fma-welcome fma-anim">
        <span class="fma-logo"></span>
        <div class="hi">${String(esc(state.assistantName))}</div>
        <div class="hint">${(globalThis.PlatformLanguage?.text("platform-assistant","m_8247ee406cbbd6","Ask about projects, customers, schedules, stats, or tell me to create to-dos, book events, and more.") ?? "Ask about projects, customers, schedules, stats, or tell me to create to-dos, book events, and more.")}</div>
        <div class="fma-suggests">${String(suggestions.map((entry) => `<button type="button" class="fma-suggest">${esc(entry)}</button>`).join(''))}</div>
      </div>
    `;
  }

  function renderMessages(options = {}){
    if (!els) return;
    const parts = [];
    if (!state.messages.length && !state.pending) {
      parts.push(welcomeHtml());
    } else {
      state.messages.forEach((message, index) => {
        parts.push(messageHtml(message, options.animateLast && index >= state.messages.length - 2));
      });
    }
    if (state.pending) {
      parts.push(`<div class="fma-pending"><i class="fas fa-wand-magic-sparkles"></i><span>${(globalThis.PlatformLanguage?.text("platform-assistant","m_186fc46dfb3cc0","Working") ?? "Working")}<span class="dots"><span>.</span><span>.</span><span>.</span></span></span></div>`);
    }
    els.msgs.innerHTML = parts.join('');
    els.msgs.querySelectorAll('.fma-suggest').forEach((button) => {
      button.addEventListener('click', () => {
        els.input.value = button.textContent;
        sendMessage();
      });
    });
    els.msgs.querySelectorAll('.fma-actions').forEach((wrap) => {
      const messageId = clean(wrap.getAttribute('data-message-id'));
      const message = state.messages.find((entry) => clean(entry.id) === messageId);
      const actions = array(object(object(message).data).actions);
      wrap.querySelectorAll('.fma-action').forEach((button) => {
        button.addEventListener('click', () => {
          const action = object(actions[Number(button.getAttribute('data-action-index'))]);
          runNavigationAction(action);
        });
      });
    });
    scrollToBottom();
  }

  function runNavigationAction(action){
    const kind = clean(action.kind);
    try {
      if (kind === 'project' && clean(action.project_id)) {
        const projectId = clean(action.project_id);
        if (window.Portal.ProjectModal?.open) { window.Portal.ProjectModal.open(projectId); return; }
        if (window.Portal.modules?.request?.openProject) { window.Portal.modules.request.openProject({ id:projectId }); return; }
        window.dispatchEvent(new CustomEvent('fm:projects:open', { detail:{ id:projectId } }));
        return;
      }
      if (kind === 'tab' && clean(action.tab)) {
        if (window.Portal.navigation?.navigate) { window.Portal.navigation.navigate({ tab:clean(action.tab) }); return; }
        window.Portal.tabs?.activateTab?.(clean(action.tab));
      }
    } catch (error) {
      console.warn('[assistant] navigation action failed', error);
    }
  }

  function renderHistory(){
    if (!els) return;
    const matchingIds = new Set(state.historyMatches.map((match) => clean(match.thread_id)));
    const items = state.threads.filter((thread) => !state.historyQuery || clean(thread.title || 'New conversation').toLowerCase().includes(state.historyQuery) || matchingIds.has(clean(thread.id))).map((thread) => `
      <button type="button" class="fma-history-item" data-thread-id="${esc(clean(thread.id))}" aria-current="${clean(thread.id) === state.threadId}">
        <div class="name">${esc(clean(thread.title) || 'New conversation')}</div>
        <div class="meta">${esc(clean(thread.updated_at).slice(0, 10))}</div>
      </button>
    `);
    els.historyList.innerHTML = String(items.join('') || `<div class="fma-empty">${state.historyQuery ? 'No matching conversations.' : 'No conversations yet.'}</div>`);
    els.historyList.querySelectorAll('.fma-history-item').forEach((item) => {
      item.addEventListener('click', () => openThread(clean(item.getAttribute('data-thread-id'))));
    });
  }

  function setView(view){
    state.view = view;
    if (!els) return;
    const chat = view === 'chat';
    els.msgs.style.display = chat ? '' : 'none';
    els.composer.style.display = chat ? '' : 'none';
    els.settingsPanel.style.display = view === 'settings' ? '' : 'none';
    if (view === 'settings') void renderSettings();
  }

  function syncSidebar(){
    if (!els) return;
    els.drawer.dataset.sidebarOpen = String(state.sidebarOpen);
    els.sidebarToggle.setAttribute('aria-expanded',String((state.mode === 'full' && window.innerWidth > 640) || state.sidebarOpen));
    els.sidebarToggle.setAttribute('aria-label',state.sidebarOpen ? 'Close conversations' : 'Open conversations');
  }

  function toggleHistory(){
    state.sidebarOpen = !state.sidebarOpen;
    syncSidebar();
    if (state.sidebarOpen) renderHistory();
  }

  async function renderSettings(){
    const panel = els?.settingsPanel;
    if (!panel || !window.AssistantAPI) return;
    panel.innerHTML = '<p>Loading assistant settings…</p>';
    try {
      const canManage = window.Portal?.util?.hasPerm?.('manage_company_settings') === true;
      const [profileResult, memoryResult, organizationResult] = await Promise.all([
        window.AssistantAPI.profile.load(orgId()), window.AssistantAPI.memories.list(orgId()),
        canManage ? window.AssistantAPI.settings.load(orgId()) : Promise.resolve(null)
      ]);
      if (state.view !== 'settings') return;
      const profile = object(profileResult.profile);
      const memories = array(memoryResult.memories);
      const organization = object(organizationResult?.settings);
      const organizationControls = canManage ? `<h2>Company assistant</h2>
        <label>Assistant name<input type="text" maxlength="80" data-fma-setting="assistantName" value="${esc(organization.assistant_name || '')}"></label>
        <label>Organization instructions<textarea rows="4" data-fma-setting="organizationInstructions">${esc(organization.custom_instructions || '')}</textarea></label>
        <label style="display:flex;flex-direction:row;align-items:center;"><input type="checkbox" data-fma-setting="companyEnabled" ${organization.enabled !== false ? 'checked' : ''}>Assistant enabled for the company</label>
        <button type="button" data-fma-setting="saveCompany">Save company assistant</button>` : '';
      panel.innerHTML = `<button type="button" data-fma-setting="back"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to conversation</button><h2>Assistant settings</h2>
        <p>These preferences follow your account in both the dock and full view.</p>
        <label>Your instructions<textarea data-fma-setting="instructions" rows="4" maxlength="4000">${esc(profile.instructions || '')}</textarea></label>
        <label style="display:flex;flex-direction:row;align-items:center;"><input type="checkbox" data-fma-setting="memoryEnabled" ${profile.memory_enabled !== false ? 'checked' : ''}>Use saved memories in conversations</label>
        <button type="button" data-fma-setting="save">Save preferences</button>
        <h2>Saved memories</h2>
        <div data-fma-setting="memories">${memories.length ? memories.map((memory) => `<div class="fma-memory"><input type="text" maxlength="500" value="${esc(memory.content || '')}" data-memory-id="${esc(memory.id)}"><button type="button" data-memory-save="${esc(memory.id)}" aria-label="Save memory">Save</button><button type="button" data-memory-delete="${esc(memory.id)}" aria-label="Delete memory">Delete</button></div>`).join('') : '<p>No saved memories.</p>'}</div>
        <div class="fma-memory"><input type="text" maxlength="500" data-fma-setting="newMemory" placeholder="Add a memory"><button type="button" data-fma-setting="addMemory">Add</button></div>
        ${organizationControls}
        <span class="fma-status" data-fma-setting="status" role="status"></span>
        <button type="button" data-fma-setting="allSettings">Open all AI agent settings</button>`;
      const status = panel.querySelector('[data-fma-setting="status"]');
      panel.querySelector('[data-fma-setting="back"]')?.addEventListener('click', () => setView('chat'));
      const run = async (operation, refresh = false) => {
        try {
          await operation();
          if (refresh) await renderSettings();
          const currentStatus = els?.settingsPanel?.querySelector('[data-fma-setting="status"]');
          if (currentStatus) currentStatus.textContent = 'Saved.';
        }
        catch (error) { status.textContent = error?.message || 'Could not save.'; }
      };
      panel.querySelector('[data-fma-setting="save"]')?.addEventListener('click', () => run(() => window.AssistantAPI.profile.save(orgId(), {
        instructions:panel.querySelector('[data-fma-setting="instructions"]').value,
        memory_enabled:panel.querySelector('[data-fma-setting="memoryEnabled"]').checked
      })));
      panel.querySelector('[data-fma-setting="saveCompany"]')?.addEventListener('click', () => run(() => window.AssistantAPI.settings.save(orgId(), {
        ...organization,
        assistant_name:panel.querySelector('[data-fma-setting="assistantName"]').value,
        custom_instructions:panel.querySelector('[data-fma-setting="organizationInstructions"]').value,
        enabled:panel.querySelector('[data-fma-setting="companyEnabled"]').checked
      })));
      panel.querySelector('[data-fma-setting="addMemory"]')?.addEventListener('click', () => {
        const content = clean(panel.querySelector('[data-fma-setting="newMemory"]').value);
        if (content) void run(() => window.AssistantAPI.memories.add(orgId(), content), true);
      });
      panel.querySelectorAll('[data-memory-save]').forEach((button) => button.addEventListener('click', () => {
        const input = [...panel.querySelectorAll('[data-memory-id]')].find((node) => node.dataset.memoryId === button.dataset.memorySave);
        if (input) void run(() => window.AssistantAPI.memories.update(orgId(), button.dataset.memorySave, input.value), true);
      }));
      panel.querySelectorAll('[data-memory-delete]').forEach((button) => button.addEventListener('click', () => run(() => window.AssistantAPI.memories.remove(orgId(), button.dataset.memoryDelete), true)));
      panel.querySelector('[data-fma-setting="allSettings"]')?.addEventListener('click', () => window.Portal?.navigation?.navigate?.({tab:'company_settings', sub:'assistant'}, {source:'assistant-settings', ownedKeys:['tab','sub']}));
    } catch (error) { panel.textContent = error?.message || 'Assistant settings could not be loaded.'; }
  }

  function updateComposer(){
    if (!els) return;
    els.composer.dataset.canSend = String(Boolean(clean(els.input.value) || state.attachments.length || recorder));
    els.composer.dataset.recording = String(Boolean(recorder));
    els.send.disabled = state.pending;
    els.send.title = recorder ? 'Finish dictation' : 'Send';
    els.send.setAttribute('aria-label', els.send.title);
  }

  function renderAttachments(){
    if (!els) return;
    els.attachments.innerHTML = state.attachments.map((file, index) => `<div class="fma-attachment"><i class="fas fa-paperclip" aria-hidden="true"></i><span title="${esc(file.name)}">${esc(file.name)}</span><button type="button" data-remove-attachment="${index}" aria-label="Remove ${esc(file.name)}">×</button></div>`).join('');
    els.attachments.querySelectorAll('[data-remove-attachment]').forEach((button) => button.addEventListener('click', () => {
      state.attachments.splice(Number(button.dataset.removeAttachment), 1);
      renderAttachments();
    }));
    updateComposer();
  }

  function addAttachments(files){
    const selected = [...(files || [])];
    const tooLarge = selected.find((file) => file.size > 20 * 1024 * 1024);
    if (tooLarge) { window.alert('Each attachment must be 20 MB or smaller.'); return; }
    if (state.attachments.length + selected.length > 5) { window.alert('You can add up to five files per message.'); return; }
    state.attachments.push(...selected);
    renderAttachments();
  }

  async function startRecording(){
    if (recorder || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      if (!recorder) window.alert('Microphone recording is unavailable in this browser.');
      return;
    }
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({audio:true});
      const chunks = [];
      recorder = new MediaRecorder(recordingStream);
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', async () => {
        const blob = new Blob(chunks, {type:recorder?.mimeType || 'audio/webm'});
        recorder = null;
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        clearInterval(recordingTimer);
        cancelAnimationFrame(waveformFrame);
        await audioContext?.close();
        audioContext = null;
        updateComposer();
        if (state.discardRecording) { state.discardRecording = false; return; }
        try {
          els.input.placeholder = 'Transcribing…';
          const result = await window.AssistantAPI.transcribe(orgId(), new File([blob], 'dictation.webm', {type:blob.type}));
          els.input.value = [els.input.value, clean(result.transcription?.text)].filter(Boolean).join(' ');
          els.input.focus();
        } catch (error) { window.alert(error?.message || 'Dictation failed.'); }
        finally { els.input.placeholder = 'Ask about anything in your workspace...'; updateComposer(); }
      }, {once:true});
      recorder.start();
      recordingStarted = Date.now();
      els.wave.innerHTML = '<span></span>'.repeat(54);
      const dots = [...els.wave.children];
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(recordingStream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastFrame = 0;
        const animate = (now) => {
          if (!recorder) return;
          if (now - lastFrame > 100) {
            analyser.getByteTimeDomainData(data);
            const level = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
            for (let index = 0; index < dots.length - 1; index++) dots[index].style.height = dots[index + 1].style.height;
            dots.at(-1).style.height = `${Math.max(4, Math.min(26, 4 + level * 120))}px`;
            lastFrame = now;
          }
          waveformFrame = requestAnimationFrame(animate);
        };
        waveformFrame = requestAnimationFrame(animate);
      }
      recordingTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - recordingStarted) / 1000);
        els.recordingTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }, 250);
      updateComposer();
    } catch (error) {
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      recorder = null;
      window.alert(error?.message || 'Microphone access was not available.');
    }
  }

  function stopRecording(discard = false){
    if (!recorder) return;
    state.discardRecording = discard;
    recorder.stop();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  function mapThreadMessages(messages){
    return array(messages).map((message) => ({
      id: clean(object(message).id),
      role: clean(object(message).role),
      content: String(object(message).content ?? ''),
      data: object(object(message).data)
    }));
  }

  async function boot(){
    if (state.booted || state.booting || !window.AssistantAPI) return;
    state.booting = true;
    try {
      const result = await window.AssistantAPI.context(orgId());
      const settings = object(result.settings);
      state.assistantName = clean(settings.assistant_name) || 'Assistant';
      state.threads = array(result.threads);
      renderHistory();
      const latest = state.threads[0];
      if (latest && clean(latest.id)) {
        await openThread(clean(latest.id));
      } else {
        renderMessages();
      }
      state.booted = true;
    } catch (error) {
      console.warn('[assistant] boot failed', error);
      renderMessages();
    } finally {
      state.booting = false;
    }
  }

  async function openThread(threadId){
    setView('chat');
    try {
      const result = await window.AssistantAPI.thread(orgId(), threadId);
      state.threadId = clean(object(result.thread).id);
      state.messages = mapThreadMessages(result.messages);
      renderMessages();
      state.sidebarOpen = false;
      syncSidebar();
      renderHistory();
    } catch (error) {
      console.warn('[assistant] failed to open conversation', error);
    }
  }

  function startNewThread(){
    state.threadId = '';
    state.messages = [];
    state.attachments = [];
    renderAttachments();
    setView('chat');
    renderMessages();
    state.sidebarOpen = false;
    syncSidebar();
    renderHistory();
    els?.input?.focus();
  }

  async function ensureThread(){
    if (state.threadId) return state.threadId;
    const result = await window.AssistantAPI.createThread(orgId(), { branch_id:branchId() });
    state.threadId = clean(object(result.thread).id);
    state.threads.unshift(object(result.thread));
    renderHistory();
    return state.threadId;
  }

  async function sendMessage(){
    if (!els || state.pending) return;
    if (recorder) { stopRecording(); return; }
    const text = clean(els.input.value);
    if (!text && !state.attachments.length) return;
    const files = [...state.attachments];
    els.input.value = '';
    state.attachments = [];
    renderAttachments();
    state.messages.push({ id:`local_${Date.now()}`, role:'user', content:[text, ...files.map((file) => `📎 ${file.name}`)].filter(Boolean).join('\n'), data:{} });
    state.pending = true;
    els.send.disabled = true;
    renderMessages({ animateLast:true });
    try {
      const threadId = await ensureThread();
      const attachments = [];
      for (const file of files) {
        const uploaded = await window.AssistantAPI.upload(orgId(), threadId, file);
        attachments.push(uploaded.attachment);
      }
      const result = await window.AssistantAPI.send(orgId(), threadId, {
        message:text || 'Please review the attached files.',
        attachments:attachments.map((attachment) => attachment.media_id),
        branch_id:branchId()
      }, { signal:AbortSignal.timeout(AGENT_TIMEOUT_MS) });
      const assistantMessage = object(result.assistant_message);
      const updatedThread = object(result.thread);
      const existingThread = state.threads.findIndex((thread) => clean(thread.id) === threadId);
      if (existingThread >= 0) state.threads.splice(existingThread, 1);
      state.threads.unshift(updatedThread);
      renderHistory();
      state.messages.push({
        id: clean(assistantMessage.id) || `local_${Date.now()}_a`,
        role:'assistant',
        content:String(assistantMessage.content ?? ''),
        data: object(assistantMessage.data)
      });
    } catch (error) {
      state.attachments.unshift(...files);
      renderAttachments();
      const offline = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      state.messages.push({
        id:`local_${Date.now()}_e`,
        role:'assistant',
        content: offline
          ? 'That took too long and timed out. Please try again — shorter questions help.'
          : (clean(error?.message) || 'Something went wrong. Please try again.'),
        data:{ status:'failed' }
      });
    } finally {
      state.pending = false;
      if (els.send) els.send.disabled = false;
      renderMessages({ animateLast:true });
      els.input?.focus();
      updateComposer();
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function open(){
    if (!available()) return;
    build();
    if (!assistantWindow) return;
    state.open = true;
    if (assistantWindow.state.mode === 'minimized') assistantWindow.restore();
    assistantWindow.setVisible(true);
    boot();
    setTimeout(() => els?.input?.focus(), 220);
  }

  function openFull(){
    open();
    assistantWindow?.setMode('full');
  }

  function leaveAssistantTab(){
    if (document.querySelector('.fm-tabpanel.active')?.id !== 'tab_assistant') return;
    const destination = state.returnTab || [...document.querySelectorAll('.fm-link[data-tab]')]
      .map((node) => node.dataset.tab).find((id) => id && id !== 'assistant');
    if (destination) window.Portal?.tabs?.activateTab?.(destination);
  }

  function dockIfFull(){
    if (assistantWindow?.state.mode === 'full') {
      assistantWindow.setMode('docked', {silent:true});
      state.mode = 'docked';
    }
  }

  function close(){
    if (!state.built) return;
    state.open = false;
    assistantWindow?.setVisible(false);
    leaveAssistantTab();
  }

  function toggle(){
    if (state.open) close();
    else open();
  }

  window.PlatformAssistant = {
    open,
    openFull,
    dockIfFull,
    close,
    toggle,
    isOpen(){ return state.open; },
    available
  };
})();
