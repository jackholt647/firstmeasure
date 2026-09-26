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
    settingsTab:'personalization',
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
      .fma-drawer[data-window=full] .fma-head{position:absolute;top:12px;right:16px;z-index:4;width:auto;min-height:0;padding:0;border:0;background:transparent;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls{gap:4px;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls button{width:34px;height:34px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;box-shadow:0 2px 8px #10182814;}
      .fma-drawer[data-window=full] .fma-head .fm-window-controls button:hover{background:#f2f4f7;}
      .fma-sidebar-toggle{border:0;background:transparent;font-size:16px;color:#475467;}
      .fma-drawer .fma-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden;}
      .fma-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
      .fma-sidebar{display:none;flex-direction:column;width:min(68%,340px);min-width:0;background:#f8fafc;border-right:1px solid #e4e7ec;z-index:2;}
      .fma-drawer[data-window=full] .fma-sidebar{display:flex;width:280px;flex:0 0 280px;}
      #sidebarAgentsList .fma-sidebar{display:flex;flex:1 1 auto;width:100%;min-width:0;min-height:0;border:0;background:transparent;color:#101828;font-size:14px;}
      .fma-drawer:not([data-window=full])[data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;box-shadow:12px 0 28px #10182824;}
      .fma-drawer[data-window=full] .fma-sidebar-toggle{display:none;}
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
      .fma-settings-tabs{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:5px;padding-bottom:5px;border-bottom:1px solid #e4e7ec;}
      .fma-settings-tabs button{flex:0 0 auto;white-space:nowrap;border:0;border-radius:8px;background:transparent;color:#667085;padding:8px 10px;font-weight:700;}
      .fma-settings-tabs button[aria-selected=true]{background:rgba(var(--primary-rgb,23,92,211),.1);color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-settings-section{flex:0 0 auto;display:none;flex-direction:column;gap:14px;max-width:820px;width:100%;margin:0 auto;padding:18px 0 30px;}
      .fma-settings-section[data-active=true]{display:flex;}
      .fma-settings-card{display:flex;flex-direction:column;gap:12px;border:1px solid #e4e7ec;border-radius:13px;padding:16px;background:#fff;}
      .fma-settings-card h3{font-size:15px;margin:0;}
      .fma-settings-card small{font-size:12px;color:#667085;line-height:1.4;}
      .fma-settings .fma-toggle-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:15px;padding:9px 0;cursor:pointer;}
      .fma-toggle-row+.fma-toggle-row{border-top:1px solid #edf0f4;}
      .fma-toggle-row span{display:flex;flex-direction:column;gap:3px;min-width:0;}
      .fma-settings .fma-toggle{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:42px;height:24px;margin:0;border:0;border-radius:999px;background:#cbd5e1;position:relative;cursor:pointer;transition:background .15s ease;}
      .fma-toggle:before{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #10182833;transition:transform .15s ease;}
      .fma-toggle:checked{background:var(--primary-readable,var(--primary,#175cd3));}
      .fma-toggle:checked:before{transform:translateX(18px);}
      .fma-toggle:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#175cd3));outline-offset:3px;}
      .fma-settings .fma-settings-primary{background:var(--primary-readable,var(--primary,#175cd3));color:#fff;border-color:transparent;font-weight:700;}
      .fma-agent-card{display:flex;flex-direction:column;gap:10px;border-top:1px solid #e4e7ec;padding:14px 0;}
      .fma-agent-card:first-child{border-top:0;}
      .fma-history-item{width:100%;text-align:left;border:1px solid transparent;border-radius:10px;padding:9px 12px;background:transparent;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:background .15s ease,border-color .15s ease;}
      .fma-history-item:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-history-item[aria-current=true]{background:#e9eef8;border-color:#cbd5e1;}
      .fma-history-item .name{font-weight:700;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-history-item .meta{font-size:11.5px;color:#98a2b3;font-weight:600;}
      .fma-empty{color:#98a2b3;text-align:center;padding:22px 8px;font-weight:600;}
      .fma-composer{position:relative;flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-top:1px solid #e4e7ec;}
      .fma-compose-shell{display:flex;align-items:flex-end;gap:5px;min-height:54px;padding:5px 7px;border:1px solid #e4e7ec;border-radius:28px;background:#fff;box-shadow:0 3px 14px #10182812;}
      .fma-compose-shell:focus-within{border-color:var(--primary-readable,var(--primary,#175cd3));}
      .fma-compose-shell textarea{flex:1;min-width:0;box-sizing:border-box;resize:none;border:0;background:transparent;padding:9px 5px;font:inherit;line-height:22px;height:40px;min-height:40px;outline:none;overflow-y:hidden;transition:height .14s ease;}
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
      .fma-wave{display:block;flex:1;min-width:0;width:100%;height:28px;color:var(--primary-readable,var(--primary,#175cd3));}
      @media (prefers-reduced-motion:reduce){.fma-compose-shell textarea{transition:none;}}
      .fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings{padding-top:64px;padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full] .fma-composer{padding-left:max(20px,calc((100% - 850px)/2));padding-right:max(20px,calc((100% - 850px)/2));}
      .fma-drawer[data-window=full] .fma-msg{max-width:75%;}
      @media (min-width:641px){.fma-attach-menu [data-fma=pickCamera]{display:none;}}
      @media (max-width:640px){.fma-drawer[data-window=full] .fma-head{left:14px;right:14px;justify-content:space-between}.fma-drawer[data-window=full] .fma-sidebar{display:none}.fma-drawer[data-window=full] .fma-sidebar-toggle{display:inline-flex}.fma-drawer[data-window=full][data-sidebar-open=true] .fma-sidebar{display:flex;position:absolute;inset:0 auto 0 0;width:min(68%,340px);box-shadow:12px 0 28px #10182824}.fma-drawer[data-window=full] .fma-msgs,.fma-drawer[data-window=full] .fma-settings,.fma-drawer[data-window=full] .fma-composer{padding-left:14px;padding-right:14px}.fma-drawer[data-window=full] .fma-msg{max-width:92%;}}
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
          <div class="fma-recording" data-fma="recording"><button type="button" class="fma-compose-icon" data-fma="discardRecording" title="Discard recording" aria-label="Discard recording"><i class="fas fa-trash" aria-hidden="true"></i></button><span class="fma-recording-time" data-fma="recordingTime">0:00</span><canvas class="fma-wave" data-fma="wave" aria-hidden="true"></canvas></div>
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
        if (mode === 'full' && window.Portal?.sidebarModes?.agentsEnabled?.()) window.Portal.sidebarModes.activate('agents');
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
    drawer.querySelector('[data-fma="new"]').addEventListener('click', () => {
      if (sidebarExternal()) openFull();
      startNewThread();
    });
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
      if (sidebarExternal()) openFull();
      setView(state.view === 'settings' ? 'chat' : 'settings');
      state.sidebarOpen = false;
      syncSidebar();
    });
    els.send.addEventListener('click', sendMessage);
    els.input.addEventListener('input', updateComposer);
    let composerWidth = 0;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        const width = els?.input?.clientWidth || 0;
        if (width && width !== composerWidth) { composerWidth = width; resizeComposerInput(); }
      }).observe(els.input);
    } else window.addEventListener('resize', resizeComposerInput);
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
      item.addEventListener('click', () => {
        if (sidebarExternal()) openFull();
        void openThread(clean(item.getAttribute('data-thread-id')));
      });
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

  function sidebarExternal(){
    return !!els?.sidebar && els.sidebar.parentElement?.id === 'sidebarAgentsList';
  }

  function mountSidebar(container){
    if (!available() || !container) return;
    build();
    if (!els?.sidebar) return;
    if (els.sidebar.parentElement !== container) container.appendChild(els.sidebar);
    renderHistory();
    syncSidebar();
    void boot();
  }

  function unmountSidebar(){
    if (!sidebarExternal()) return;
    const body = els.drawer.querySelector('[data-fma="body"]');
    body?.insertBefore(els.sidebar, els.drawer.querySelector('[data-fma="content"]'));
    state.sidebarOpen = false;
    syncSidebar();
  }

  function syncSidebar(){
    if (!els) return;
    els.drawer.dataset.sidebarOpen = String(state.sidebarOpen);
    els.sidebarToggle.setAttribute('aria-expanded',String(sidebarExternal() || (state.mode === 'full' && window.innerWidth > 640) || state.sidebarOpen));
    els.sidebarToggle.setAttribute('aria-label',state.sidebarOpen ? 'Close conversations' : 'Open conversations');
  }

  function toggleHistory(){
    if (sidebarExternal()) { window.Portal?.sidebarModes?.activate?.('agents'); return; }
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
      const [profileResult, memoryResult] = await Promise.all([
        window.AssistantAPI.profile.load(orgId()), window.AssistantAPI.memories.list(orgId())
      ]);
      const [organizationResult, globalResult, catalogResult] = canManage ? await Promise.allSettled([
        window.AssistantAPI.settings.load(orgId()),
        window.AssistantAPI.globalInstructions.load(orgId()),
        window.AgentsAPI?.catalog?.(orgId()) || Promise.resolve({agents:[]})
      ]) : [];
      if (state.view !== 'settings') return;
      let profile = object(profileResult.profile);
      const memories = array(memoryResult.memories);
      let organization = organizationResult?.status === 'fulfilled' ? object(organizationResult.value.settings) : null;
      const globalInstructions = globalResult?.status === 'fulfilled' ? object(globalResult.value) : null;
      const agentsAvailable = catalogResult?.status === 'fulfilled';
      const agents = agentsAvailable ? array(catalogResult.value.agents).filter((agent) => clean(agent.id) !== 'assistant') : [];
      const toggle = (key, title, hint, checked) => `<label class="fma-toggle-row"><span><strong>${esc(title)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span><input type="checkbox" role="switch" class="fma-toggle" data-fma-setting="${key}" ${checked ? 'checked' : ''} aria-label="${esc(title)}"></label>`;
      const tabs = [
        ['personalization','Personalization'], ['memory','Memory'],
        ...(canManage ? [['capabilities','Capabilities'],['agents','Agents'],['advanced','Advanced']] : [])
      ];
      if (!tabs.some(([id]) => id === state.settingsTab)) state.settingsTab = 'personalization';
      const companyPersonalization = organization ? `<div class="fma-settings-card"><h3>Company assistant</h3><small>These instructions apply to everyone in your organization.</small><label>Assistant name<input type="text" maxlength="80" data-fma-setting="assistantName" value="${esc(organization.assistant_name || '')}"></label><label>Organization instructions<textarea rows="4" maxlength="4000" data-fma-setting="organizationInstructions">${esc(organization.custom_instructions || '')}</textarea></label><button type="button" class="fma-settings-primary" data-fma-setting="saveCompanyPersonalization">Save company personalization</button><span class="fma-status" data-fma-status="company-personalization" role="status"></span></div>` : (canManage ? '<p>Company settings could not be loaded.</p>' : '');
      const scope = object(organization?.data_scope);
      const capabilityControls = organization ? `<div class="fma-settings-card"><h3>Assistant availability</h3>${toggle('companyEnabled','Assistant enabled','Master switch for the organization.',organization.enabled !== false)}</div>
        <div class="fma-settings-card"><h3>What it can do</h3>
          ${toggle('allowActions','Take actions','Create to-dos, move stages, schedule events and trigger automations.',organization.allow_actions !== false)}
          ${toggle('allowNotes','Post project notes','Write internal project notes when asked.',organization.allow_notes !== false)}
          ${toggle('allowMessaging','Send customer messages','Requires chat confirmation and the messaging feature.',organization.allow_messaging === true)}
        </div><div class="fma-settings-card"><h3>What it can see</h3>
          ${toggle('scopeProjects','Projects','Project details and stages.',scope.projects !== false)}
          ${toggle('scopeContacts','Contacts','Customer and contact search.',scope.contacts !== false)}
          ${toggle('scopeStats','Stats','Business metrics.',scope.stats !== false)}
          ${toggle('scopeDocuments','Documents','Proposals, invoices, contracts and reports.',scope.documents !== false)}
          ${toggle('scopeSchedule','Schedule','Calendar and project events.',scope.schedule !== false)}
          ${toggle('scopeActivity','Activity feed','Recent platform events.',scope.activity !== false)}
        </div><button type="button" class="fma-settings-primary" data-fma-setting="saveCapabilities">Save capabilities</button><span class="fma-status" data-fma-status="capabilities" role="status"></span>` : '<p>Capability settings could not be loaded.</p>';
      const agentControls = agents.length ? agents.map((agent) => {
        const settings = object(agent.settings);
        return `<div class="fma-settings-card" data-agent-id="${esc(agent.id)}"><h3>${esc(agent.title || agent.id)}</h3><small>${esc(agent.description || '')}</small>${toggle('agentEnabled','Enabled','Available to permitted users.',settings.enabled !== false)}<label>Display name<input type="text" maxlength="80" data-agent-name value="${esc(settings.display_name || agent.title || '')}"></label><label>Company instructions<textarea rows="3" data-agent-instructions>${esc(settings.custom_instructions || '')}</textarea></label><details><summary>Advanced configuration</summary><small>All settings published by this agent. Changes are validated by the agent service.</small><textarea rows="8" data-agent-advanced spellcheck="false">${esc(JSON.stringify(settings, null, 2))}</textarea></details><button type="button" class="fma-settings-primary" data-agent-save>Save agent</button><span class="fma-status" data-agent-status role="status"></span></div>`;
      }).join('') : (agentsAvailable ? '<p>No other agent settings are available.</p>' : '<p>Registered agent settings could not be loaded.</p>');
      panel.innerHTML = `<button type="button" data-fma-setting="back"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to conversation</button><h2>Assistant settings</h2>
        <nav class="fma-settings-tabs" role="tablist" aria-label="Assistant settings">${tabs.map(([id,label]) => `<button type="button" role="tab" data-settings-tab="${id}" aria-selected="${state.settingsTab === id}">${label}</button>`).join('')}</nav>
        <section class="fma-settings-section" data-settings-section="personalization" data-active="${state.settingsTab === 'personalization'}" role="tabpanel"><div class="fma-settings-card"><h3>Your instructions</h3><small>These apply only when the assistant talks with you.</small><label>Your instructions<textarea data-fma-setting="instructions" rows="5" maxlength="4000">${esc(profile.instructions || '')}</textarea></label><button type="button" class="fma-settings-primary" data-fma-setting="savePersonalization">Save your instructions</button><span class="fma-status" data-fma-status="personalization" role="status"></span></div>${companyPersonalization}</section>
        <section class="fma-settings-section" data-settings-section="memory" data-active="${state.settingsTab === 'memory'}" role="tabpanel"><div class="fma-settings-card"><h3>Memory</h3><small>Turning memory off keeps your saved entries but leaves them out of conversations.</small>${toggle('memoryEnabled','Use saved memories','Apply your saved memories in future conversations.',profile.memory_enabled !== false)}<button type="button" class="fma-settings-primary" data-fma-setting="saveMemoryPreference">Save memory preference</button><span class="fma-status" data-fma-status="memory" role="status"></span></div><div class="fma-settings-card"><h3>Saved memories</h3><div data-fma-setting="memories">${memories.length ? memories.map((memory) => `<div class="fma-memory"><input type="text" maxlength="500" value="${esc(memory.content || '')}" data-memory-id="${esc(memory.id)}"><button type="button" data-memory-save="${esc(memory.id)}" aria-label="Save memory">Save</button><button type="button" data-memory-delete="${esc(memory.id)}" aria-label="Delete memory">Delete</button></div>`).join('') : '<p>No saved memories.</p>'}</div><div class="fma-memory"><input type="text" maxlength="500" data-fma-setting="newMemory" placeholder="Add a memory"><button type="button" data-fma-setting="addMemory">Add</button></div>${memories.length ? '<button type="button" data-fma-setting="clearMemories">Clear all memories</button>' : ''}<span class="fma-status" data-fma-status="memories" role="status"></span></div></section>
        ${canManage ? `<section class="fma-settings-section" data-settings-section="capabilities" data-active="${state.settingsTab === 'capabilities'}" role="tabpanel">${capabilityControls}</section><section class="fma-settings-section" data-settings-section="agents" data-active="${state.settingsTab === 'agents'}" role="tabpanel">${agentControls}</section><section class="fma-settings-section" data-settings-section="advanced" data-active="${state.settingsTab === 'advanced'}" role="tabpanel"><div class="fma-settings-card"><h3>Platform-wide instructions</h3><small>These apply to the global assistant in every organization. Only a verified platform administrator can edit them.</small>${globalInstructions ? `<textarea rows="6" maxlength="8000" data-fma-setting="globalInstructions" ${globalInstructions.can_edit ? '' : 'readonly'}>${esc(globalInstructions.instructions || '')}</textarea>${globalInstructions.can_edit ? '<button type="button" class="fma-settings-primary" data-fma-setting="saveGlobal">Save platform instructions</button>' : '<small>Read only for your account.</small>'}` : '<p>Platform instructions could not be loaded.</p>'}<span class="fma-status" data-fma-status="advanced" role="status"></span></div></section>` : ''}`;
      panel.querySelector('[data-fma-setting="back"]')?.addEventListener('click', () => setView('chat'));
      panel.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.addEventListener('click', () => {
        state.settingsTab = tab.dataset.settingsTab;
        panel.querySelectorAll('[data-settings-tab]').forEach((item) => item.setAttribute('aria-selected',String(item === tab)));
        panel.querySelectorAll('[data-settings-section]').forEach((section) => { section.dataset.active = String(section.dataset.settingsSection === state.settingsTab); });
      }));
      const value = (key) => panel.querySelector(`[data-fma-setting="${key}"]`)?.checked === true;
      const run = async (key, operation, refresh = false) => {
        const status = panel.querySelector(`[data-fma-status="${key}"]`);
        if (status) status.textContent = 'Saving…';
        try {
          const result = await operation();
          if (refresh) await renderSettings();
          const currentStatus = els?.settingsPanel?.querySelector(`[data-fma-status="${key}"]`);
          if (currentStatus) currentStatus.textContent = 'Saved.';
          return result;
        }
        catch (error) { if (status) status.textContent = error?.message || 'Could not save.'; return null; }
      };
      panel.querySelector('[data-fma-setting="savePersonalization"]')?.addEventListener('click', async () => {
        const result = await run('personalization', () => window.AssistantAPI.profile.save(orgId(), {
        instructions:panel.querySelector('[data-fma-setting="instructions"]').value,
        memory_enabled:profile.memory_enabled !== false
        }));
        if (result) profile = object(result.profile);
      });
      panel.querySelector('[data-fma-setting="saveMemoryPreference"]')?.addEventListener('click', async () => {
        const result = await run('memory', () => window.AssistantAPI.profile.save(orgId(), {
          instructions:profile.instructions || '', memory_enabled:value('memoryEnabled')
        }));
        if (result) profile = object(result.profile);
      });
      panel.querySelector('[data-fma-setting="saveCompanyPersonalization"]')?.addEventListener('click', async () => {
        const result = await run('company-personalization', () => window.AssistantAPI.settings.save(orgId(), {
        ...organization,
        assistant_name:panel.querySelector('[data-fma-setting="assistantName"]').value,
        custom_instructions:panel.querySelector('[data-fma-setting="organizationInstructions"]').value
        }));
        if (result) organization = object(result.settings);
      });
      panel.querySelector('[data-fma-setting="saveCapabilities"]')?.addEventListener('click', async () => {
        const result = await run('capabilities', () => window.AssistantAPI.settings.save(orgId(), {
          ...organization,
          enabled:value('companyEnabled'), allow_actions:value('allowActions'),
          allow_notes:value('allowNotes'), allow_messaging:value('allowMessaging'),
          data_scope:{ projects:value('scopeProjects'), contacts:value('scopeContacts'), stats:value('scopeStats'), documents:value('scopeDocuments'), schedule:value('scopeSchedule'), activity:value('scopeActivity') }
        }));
        if (result) organization = object(result.settings);
      });
      panel.querySelector('[data-fma-setting="addMemory"]')?.addEventListener('click', () => {
        const content = clean(panel.querySelector('[data-fma-setting="newMemory"]').value);
        if (content) void run('memories', () => window.AssistantAPI.memories.add(orgId(), content), true);
      });
      panel.querySelectorAll('[data-memory-save]').forEach((button) => button.addEventListener('click', () => {
        const input = [...panel.querySelectorAll('[data-memory-id]')].find((node) => node.dataset.memoryId === button.dataset.memorySave);
        if (input) void run('memories', () => window.AssistantAPI.memories.update(orgId(), button.dataset.memorySave, input.value), true);
      }));
      panel.querySelectorAll('[data-memory-delete]').forEach((button) => button.addEventListener('click', () => run('memories', () => window.AssistantAPI.memories.remove(orgId(), button.dataset.memoryDelete), true)));
      panel.querySelector('[data-fma-setting="clearMemories"]')?.addEventListener('click', () => {
        if (window.confirm('Delete all your saved assistant memories?')) void run('memories', () => window.AssistantAPI.memories.clear(orgId()), true);
      });
      panel.querySelector('[data-fma-setting="saveGlobal"]')?.addEventListener('click', () => run('advanced', () => window.AssistantAPI.globalInstructions.save(orgId(), panel.querySelector('[data-fma-setting="globalInstructions"]').value)));
      panel.querySelectorAll('[data-agent-id]').forEach((card) => card.querySelector('[data-agent-save]')?.addEventListener('click', async () => {
        const id = card.dataset.agentId;
        const status = card.querySelector('[data-agent-status]');
        const current = agents.find((agent) => clean(agent.id) === id);
        if (status) status.textContent = 'Saving…';
        try {
          const advanced = JSON.parse(card.querySelector('[data-agent-advanced]').value);
          if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) throw new Error('Advanced configuration must be a JSON object.');
          const result = await window.AgentsAPI.settings.save(orgId(), id, {
            ...advanced, enabled:card.querySelector('[data-fma-setting="agentEnabled"]')?.checked === true,
            display_name:card.querySelector('[data-agent-name]').value,
            custom_instructions:card.querySelector('[data-agent-instructions]').value
          });
          if (current) current.settings = result.settings;
          card.querySelector('[data-agent-advanced]').value = JSON.stringify(result.settings, null, 2);
          if (status) status.textContent = 'Saved.';
        } catch (error) { if (status) status.textContent = error?.message || 'Could not save.'; }
      }));
    } catch (error) { panel.textContent = error?.message || 'Assistant settings could not be loaded.'; }
  }

  function resizeComposerInput(){
    if (!els?.input) return;
    const input = els.input;
    const style = getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const minimum = Math.ceil(lineHeight + padding);
    const maximum = Math.ceil(10 * lineHeight + padding);
    const previous = input.getBoundingClientRect().height || minimum;
    input.style.transition = 'none';
    input.style.height = `${minimum}px`;
    const needed = input.scrollHeight;
    const next = Math.max(minimum, Math.min(needed, maximum));
    input.style.height = `${previous}px`;
    input.offsetHeight;
    input.style.transition = '';
    input.style.height = `${next}px`;
    input.style.overflowY = needed > maximum + 1 ? 'auto' : 'hidden';
  }

  function updateComposer(){
    if (!els) return;
    resizeComposerInput();
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
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      let analyser = null;
      let data = null;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(recordingStream).connect(analyser);
        data = new Uint8Array(analyser.frequencyBinCount);
      }
      const canvas = els.wave;
      const context = canvas.getContext('2d');
      const samples = [];
      let lastSample = 0;
      const animate = (now) => {
        if (!recorder) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        if (context && width && height) {
          const pixelsWide = Math.round(width * scale);
          const pixelsHigh = Math.round(height * scale);
          if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
            canvas.width = pixelsWide;
            canvas.height = pixelsHigh;
          }
          context.setTransform(scale, 0, 0, scale, 0, 0);
          context.clearRect(0, 0, width, height);
          if (now - lastSample >= 100) {
            if (analyser && data) analyser.getByteTimeDomainData(data);
            const level = data ? Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length) : 0;
            samples.push({ time:now, height:Math.max(4, Math.min(26, 4 + level * 120)) });
            lastSample = now;
          }
          while (samples.length && now - samples[0].time > (width + 8) / 70 * 1000) samples.shift();
          context.fillStyle = getComputedStyle(canvas).color;
          for (const sample of samples) {
            const age = now - sample.time;
            const x = width - 4 - age * .07;
            if (x < -4) continue;
            context.globalAlpha = Math.min(1, age / 170, Math.max(0, (x + 4) / 12));
            context.beginPath();
            if (context.roundRect) context.roundRect(x, (height - sample.height) / 2, 4, sample.height, 2);
            else context.rect(x, (height - sample.height) / 2, 4, sample.height);
            context.fill();
          }
          context.globalAlpha = 1;
        }
        waveformFrame = requestAnimationFrame(animate);
      };
      waveformFrame = requestAnimationFrame(animate);
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
    if (window.Portal?.sidebarModes?.agentsEnabled?.()) window.Portal.sidebarModes.activate('agents');
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
    mountSidebar,
    unmountSidebar,
    isOpen(){ return state.open; },
    isFull(){ return assistantWindow?.state.mode === 'full'; },
    available
  };
  window.dispatchEvent(new CustomEvent('fm:assistant:ready'));
})();
