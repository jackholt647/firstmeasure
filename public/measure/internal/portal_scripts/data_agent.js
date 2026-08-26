/* portal_scripts/data_agent.js
 * FirstMeasure read-only data agent UI.
 */
(function(){
  const state = {
    booted: false,
    sessions: [],
    activeId: null,
    busy: false,
    currentMessages: [],
    editingIndex: null,
    runActivity: null,
    activeRunId: null,
    runPollSeq: 0,
    pollTimer: null,
    activityExpanded: {},
    libs: { marked: false, purify: false, chart: false }
  };

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const endpoint = () => cfg().endpoints?.data_agent || cfg().endpoints?.portal || 'data_agent.php';

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function fmtTime(value){
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function injectStyles(){
    if ($('#dataAgentStyles')) return;
    const style = document.createElement('style');
    style.id = 'dataAgentStyles';
    style.textContent = `
      #view-data-agent{min-height:0}
      .data-agent-shell{height:var(--da-shell-height,calc(100dvh - 80px));min-height:0;display:grid;grid-template-columns:260px minmax(0,1fr) 330px;gap:14px;color:#202124}
      .data-agent-shell.trace-collapsed{grid-template-columns:260px minmax(0,1fr)}
      .data-agent-shell.trace-collapsed .da-trace{display:none}
      .data-agent-pane{background:#fff;border:1px solid #dadce0;border-radius:8px;min-width:0;overflow:hidden}
      .data-agent-side{display:flex;flex-direction:column}
      .data-agent-side-head{padding:14px;border-bottom:1px solid #eceff1;display:flex;align-items:center;justify-content:space-between;gap:10px}
      .data-agent-title{font-size:15px;font-weight:900;margin:0;display:flex;align-items:center;gap:9px}
      .da-icon-btn{width:34px;height:34px;border:1px solid #d8dee3;background:#fff;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#30404d}
      .da-icon-btn:hover{background:#f5f7f8}
      .da-session-list{padding:8px;overflow:auto;display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
      .da-side-footer{padding:10px;border-top:1px solid #eceff1;display:flex;gap:8px}
      .da-side-footer .da-settings-btn{width:100%;justify-content:flex-start;gap:9px;font-weight:800}
      .da-session-row{position:relative;border-radius:8px}
      .da-session-row:hover{background:#f6f8f9}
      .da-session{width:100%;border:1px solid transparent;background:transparent;text-align:left;border-radius:8px;padding:10px 42px 10px 10px;cursor:pointer;min-height:66px;color:#263238;min-width:0}
      .da-session:hover{background:#f6f8f9}
      .da-session.active{background:#fce8e6;border-color:#f4b7b2;color:#9d1c14}
      .da-session strong{display:block;font-size:13px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .da-session span{display:block;margin-top:5px;font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .da-session-delete{position:absolute;right:6px;bottom:6px;opacity:.72}
      .da-session-delete:hover{opacity:1;background:#fce8e6;color:#9d1c14;border-color:#f4b7b2}
      .data-agent-chat{display:flex;flex-direction:column;min-height:0}
      .da-chat-head{padding:14px 16px;border-bottom:1px solid #eceff1;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .da-chat-head-main{min-width:0}
      .da-chat-head-main h2{margin:0;font-size:18px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .da-chat-head-main h2[data-title-editable="1"]{cursor:text;border-radius:6px;padding:2px 4px;margin:-2px -4px}
      .da-chat-head-main h2[data-title-editable="1"]:hover{background:#f6f8fa}
      .da-title-input{font:inherit;font-size:18px;font-weight:800;line-height:1.2;border:1px solid #cfd8df;border-radius:6px;padding:2px 4px;min-width:min(420px,70vw)}
      .da-chat-head-main div{margin-top:4px;color:#667085;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .da-chat-actions{display:flex;gap:8px;flex-shrink:0}
      .da-mobile-list-btn{display:none}
      .da-messages{flex:1;overflow:auto;padding:18px;background:linear-gradient(180deg,#fbfcfd 0%,#f3f5f7 100%);display:flex;flex-direction:column;gap:14px}
      .da-msg{max-width:min(860px,92%);border:1px solid #e2e8ed;border-radius:8px;padding:13px 14px;background:#fff;box-shadow:0 3px 10px rgba(15,23,42,.04)}
      .da-msg.editing{width:min(860px,92%);max-width:min(860px,92%)}
      .da-msg.user{align-self:flex-end;background:#d93025;color:#fff;border-color:#d93025}
      .da-msg.assistant{align-self:flex-start}
      .da-msg-meta{font-size:11px;font-weight:800;margin-bottom:7px;color:#667085;display:flex;gap:8px;align-items:center;justify-content:space-between}
      .da-msg-meta-main{display:flex;gap:8px;align-items:center;min-width:0;flex-wrap:wrap}
      .da-msg-actions{display:flex;gap:5px;flex-shrink:0}
      .da-msg-action{width:27px;height:27px;border:1px solid #d8dee3;background:#fff;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#30404d;font-size:12px}
      .da-msg-action:hover{background:#f5f7f8}
      .da-msg.user .da-msg-action{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.32);color:#fff}
      .da-msg.user .da-msg-action:hover{background:rgba(255,255,255,.22)}
      .da-msg.user .da-msg-meta{color:rgba(255,255,255,.8)}
      .da-inline-editor{display:flex;flex-direction:column;gap:9px}
      .da-inline-editor textarea{width:100%;min-height:140px;max-height:360px;resize:vertical;border:1px solid rgba(255,255,255,.5);border-radius:8px;padding:10px;font:14px 'Segoe UI',Roboto,sans-serif;box-sizing:border-box;background:#fff;color:#202124}
      .da-inline-actions{display:flex;gap:8px;justify-content:flex-end}
      .da-inline-actions button{border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:8px 10px;cursor:pointer;font-weight:900}
      .da-inline-actions .primary{background:#fff;color:#9d1c14}
      .da-inline-actions .secondary{background:rgba(255,255,255,.12);color:#fff}
      .da-md{font-size:14px;line-height:1.55}
      .da-md p{margin:0 0 10px}
      .da-md p:last-child{margin-bottom:0}
      .da-md table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse;margin:10px 0;background:#fff;border:1px solid #e2e8ed;border-radius:8px}
      .da-md th,.da-md td{padding:9px 10px;border-bottom:1px solid #edf1f4;font-size:13px;text-align:left}
      .da-md th{background:#f6f8fa;font-size:11px;text-transform:uppercase;color:#51606f}
      .da-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1f3f4;border-radius:5px;padding:2px 5px}
      .da-md pre{background:#111827;color:#f9fafb;border-radius:8px;padding:12px;overflow:auto}
      .da-artifacts{display:flex;flex-direction:column;gap:12px;margin-top:12px}
      .da-artifact{border:1px solid #dfe6ec;border-radius:8px;background:#fff;overflow:hidden}
      .da-artifact-title{padding:10px 12px;border-bottom:1px solid #edf1f4;font-size:12px;font-weight:900;color:#344054;display:flex;align-items:center;gap:8px}
      .da-artifact-body{padding:12px;overflow:auto}
      .da-artifact canvas{height:280px!important;max-height:300px}
      .da-composer-wrap{border-top:1px solid #eceff1;background:#fff}
      .da-composer{padding:12px;background:#fff;display:flex;gap:10px;align-items:flex-end}
      .da-composer textarea{flex:1;min-height:48px;max-height:150px;resize:vertical;border:1px solid #cfd8df;border-radius:8px;padding:12px;font:14px 'Segoe UI',Roboto,sans-serif}
      .da-send{width:46px;height:46px;border:none;border-radius:8px;background:#d93025;color:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .da-send:disabled{opacity:.55;cursor:not-allowed}
      .da-trace{display:flex;flex-direction:column;min-height:0}
      .da-trace-head{padding:14px;border-bottom:1px solid #eceff1;display:flex;align-items:center;justify-content:space-between;gap:10px}
      .da-trace-list{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px;background:#fbfcfd}
      .da-trace-item{border:1px solid #e2e8ed;border-radius:8px;background:#fff;padding:10px}
      .da-trace-item.call{border-left:4px solid #1a73e8}
      .da-trace-item.result{border-left:4px solid #137333}
      .da-trace-item.error{border-left:4px solid #d93025}
      .da-trace-item.status{border-left:4px solid #f9ab00}
      .da-trace-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
      .da-trace-top strong{font-size:12px;color:#243447}
      .da-trace-top span{font-size:10px;text-transform:uppercase;font-weight:900;color:#667085}
      .da-trace-item pre{white-space:pre-wrap;word-break:break-word;margin:0;background:#f6f8fa;border-radius:7px;padding:8px;font-size:11px;max-height:190px;overflow:auto}
      .da-empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:#667085;font-weight:800;padding:24px}
      .da-status-line{align-self:flex-start;color:#667085;font-size:12px;font-weight:800;padding:0 2px}
      .da-run-activity{align-self:flex-start;max-width:min(860px,92%);background:transparent;border:0;box-shadow:none;overflow:visible}
      .da-run-summary{width:100%;border:0;background:transparent;display:flex;align-items:center;gap:9px;padding:2px 0;cursor:pointer;color:#667085;text-align:left;font-size:12px;font-weight:900}
      .da-run-summary:hover{background:transparent;color:#344054}
      .da-run-summary span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .da-spinner{width:14px;height:14px;border:2px solid #d8dee3;border-top-color:#d93025;border-radius:50%;animation:da-spin .8s linear infinite;flex-shrink:0}
      .da-run-activity.done .da-spinner{display:none}
      .da-run-activity.done .da-run-summary:before{content:"";width:8px;height:8px;border-radius:50%;background:#137333;flex-shrink:0}
      .da-run-log{display:none;border-top:0;padding:8px 0 0 23px;background:transparent;max-height:520px;overflow:auto}
      .da-run-activity.expanded .da-run-log{display:flex;flex-direction:column;gap:8px}
      .da-run-log-item{border:1px solid #e2e8ed;border-radius:7px;background:#fff;padding:8px}
      .da-run-log-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:5px}
      .da-run-log-title{display:flex;align-items:center;gap:6px;min-width:0}
      .da-run-log-top strong{font-size:12px;color:#243447}
      .da-run-log-top span{font-size:10px;text-transform:uppercase;font-weight:900;color:#667085}
      .da-run-copy{width:24px;height:24px;border:1px solid #d8dee3;background:#fff;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#30404d;font-size:11px}
      .da-run-copy:hover{background:#f5f7f8}
      .da-run-log-item pre{white-space:pre-wrap;word-break:break-word;margin:0;background:#f6f8fa;border-radius:6px;padding:7px;font-size:11px;max-height:300px;overflow:auto}
      .da-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.48);z-index:4000;display:none;align-items:center;justify-content:center;padding:18px}
      .da-modal-backdrop.open{display:flex}
      .da-modal{width:min(1225px,96vw);height:min(950px,96vh);background:#fff;border-radius:8px;box-shadow:0 28px 70px rgba(15,23,42,.3);display:flex;flex-direction:column;overflow:hidden}
      .da-modal-head{padding:14px 16px;border-bottom:1px solid #eceff1;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .da-modal-head h3{margin:0;font-size:17px}
      .da-modal-body{padding:14px 16px;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:14px;flex:1;min-height:0}
      .da-settings-section{border:1px solid #e2e8ed;border-radius:8px;overflow:hidden;background:#fff;display:flex;flex-direction:column;min-height:0}
      .da-settings-section h4{margin:0;padding:10px 12px;border-bottom:1px solid #edf1f4;font-size:12px;text-transform:uppercase;color:#51606f}
      .da-settings-section textarea{width:100%;border:0;resize:none;padding:12px;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-sizing:border-box;flex:1;min-height:0;overflow:auto}
      .da-tool-list{padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto;flex:1;min-height:0}
      .da-tool-item{border:1px solid #edf1f4;border-radius:7px;padding:8px;background:#fbfcfd}
      .da-tool-item strong{display:block;font-size:12px;color:#243447;margin-bottom:4px}
      .da-tool-item span{display:block;font-size:12px;color:#667085;line-height:1.35}
      .da-modal-foot{padding:12px 16px;border-top:1px solid #eceff1;display:flex;justify-content:flex-end;gap:8px}
      .da-btn{border:1px solid #d8dee3;background:#fff;border-radius:8px;padding:9px 12px;cursor:pointer;font-weight:800;color:#30404d}
      .da-btn.primary{background:#d93025;border-color:#d93025;color:#fff}
      @keyframes da-spin{to{transform:rotate(360deg)}}
      .data-agent-standalone{height:100vh;background:#eef2f5;padding:14px;box-sizing:border-box}
      .data-agent-standalone .data-agent-shell{height:calc(100dvh - 28px)}
      @media (max-width:1100px){
        .data-agent-shell{grid-template-columns:220px minmax(0,1fr)}
        .data-agent-shell .da-trace{display:none}
        .data-agent-shell.trace-visible .da-trace{display:flex;position:fixed;inset:72px 16px 16px auto;width:min(390px,calc(100vw - 32px));z-index:2500;box-shadow:0 20px 50px rgba(15,23,42,.25)}
      }
      @media (max-width:760px){
        .data-agent-standalone{padding:0}
        .data-agent-shell,.data-agent-standalone .data-agent-shell{height:100dvh;min-height:0;display:flex;flex-direction:column;gap:0}
        .data-agent-side{display:none}
        .data-agent-shell.mobile-list .data-agent-side{display:flex;flex:1;border-radius:0;border-left:0;border-right:0}
        .data-agent-shell.mobile-list .data-agent-chat{display:none}
        .data-agent-shell.mobile-list .da-trace{display:none}
        .data-agent-chat{flex:1;border-radius:0;border-left:0;border-right:0}
        .da-chat-head{padding:8px 10px 7px;display:grid;grid-template-columns:34px minmax(0,1fr) 34px;grid-template-areas:"menu title refresh" ". meta meta";column-gap:8px;row-gap:3px;align-items:center}
        .da-mobile-list-btn{display:inline-flex;grid-area:menu}
        .da-chat-head-main{grid-area:title;min-width:0}
        .da-chat-head-main h2{font-size:15px;line-height:1.15}
        .da-chat-head-main div{grid-area:meta;margin-top:0;font-size:11px;line-height:1.2}
        .da-chat-actions{grid-area:refresh;display:flex;justify-content:flex-end}
        .da-chat-actions #daSettingsTopBtn,.da-chat-actions #daTraceToggleBtn{display:none}
        .da-chat-actions #daRefreshBtn{width:34px;height:34px}
        .da-messages{padding:12px}
        .da-msg{max-width:96%}
        .da-run-activity{max-width:96%}
        .da-trace{display:none}
        .data-agent-shell.trace-visible .da-trace{display:flex;position:fixed;inset:56px 8px 8px;width:auto;z-index:2500;box-shadow:0 20px 50px rgba(15,23,42,.25)}
        .da-modal-body{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  async function loadScript(src, test){
    if (test()) return true;
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  async function ensureRenderLibs(){
    if (!state.libs.marked) state.libs.marked = await loadScript('https://cdn.jsdelivr.net/npm/marked/marked.min.js', () => !!window.marked);
    if (!state.libs.purify) state.libs.purify = await loadScript('https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js', () => !!window.DOMPurify);
    if (!state.libs.chart) state.libs.chart = await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js', () => !!window.Chart);
  }

  function renderMarkdown(text){
    const raw = String(text || '');
    if (window.marked) {
      const html = window.marked.parse(raw, { breaks:true, gfm:true });
      return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
    }
    return `<p>${esc(raw).replace(/\n/g,'<br>')}</p>`;
  }

  async function apiPost(payload){
    const user = cfg().user || {};
    const body = Object.assign({}, payload || {});
    if (!body.actor_email && user.email) body.actor_email = user.email;
    if (!body.actor_name && user.name) body.actor_name = user.name;
    if (!body.actor_role && user.role) body.actor_role = user.role;
    if (window.Portal && typeof window.Portal.apiPost === 'function') {
      return await window.Portal.apiPost(endpoint(), body);
    }
    const res = await fetch(endpoint(), {
      method:'POST',
      credentials:'same-origin',
      headers: { 'Accept':'application/json', 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch(e) { throw new Error(text.slice(0, 240) || 'Invalid server response'); }
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function root(){
    let mount = $('#view-data-agent');
    if (!mount) mount = $('#dataAgentStandaloneMount');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'dataAgentStandaloneMount';
      mount.className = 'data-agent-standalone';
      document.body.appendChild(mount);
    }
    return mount;
  }

  function renderShell(){
    injectStyles();
    const mount = root();
    if ($('#dataAgentRoot', mount)) return;
    mount.innerHTML = `
      <div class="data-agent-shell trace-collapsed" id="dataAgentRoot">
        <aside class="data-agent-pane data-agent-side">
          <div class="data-agent-side-head">
            <h3 class="data-agent-title"><i class="fas fa-database"></i> Data Agent</h3>
            <button class="da-icon-btn" type="button" id="daNewChatBtn" title="New chat"><i class="fas fa-plus"></i></button>
          </div>
          <div class="da-session-list" id="daSessionList"></div>
          <div class="da-side-footer">
            <button class="da-icon-btn da-settings-btn" type="button" id="daSettingsBtn" title="Data Agent settings"><i class="fas fa-gear"></i><span>Settings</span></button>
          </div>
        </aside>
        <main class="data-agent-pane data-agent-chat">
          <div class="da-chat-head">
            <button class="da-icon-btn da-mobile-list-btn" type="button" id="daMobileListBtn" title="Conversations"><i class="fas fa-bars"></i></button>
            <div class="da-chat-head-main">
              <h2 id="daChatTitle" data-title-editable="1">Data Agent</h2>
              <div id="daChatMeta"></div>
            </div>
            <div class="da-chat-actions">
              <button class="da-icon-btn" type="button" id="daSettingsTopBtn" title="Data Agent settings"><i class="fas fa-gear"></i></button>
              <button class="da-icon-btn" type="button" id="daRefreshBtn" title="Refresh chats"><i class="fas fa-rotate"></i></button>
              <button class="da-icon-btn" type="button" id="daTraceToggleBtn" title="Activity and function calls"><i class="fas fa-list-check"></i></button>
            </div>
          </div>
          <div class="da-messages" id="daMessages"></div>
          <div class="da-composer-wrap">
            <form class="da-composer" id="daComposer">
              <textarea id="daInput" rows="2" placeholder="Ask a data question..."></textarea>
              <button class="da-send" id="daSendBtn" type="submit" title="Send"><i class="fas fa-paper-plane"></i></button>
            </form>
          </div>
        </main>
        <aside class="data-agent-pane da-trace">
          <div class="da-trace-head">
            <h3 class="data-agent-title"><i class="fas fa-list-check"></i> Activity</h3>
            <button class="da-icon-btn" type="button" id="daTraceCloseBtn" title="Collapse activity"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="da-trace-list" id="daTraceList"><div class="da-empty">No active run</div></div>
        </aside>
      </div>
      <div class="da-modal-backdrop" id="daSettingsModal" aria-hidden="true">
        <div class="da-modal" role="dialog" aria-modal="true" aria-labelledby="daSettingsTitle">
          <div class="da-modal-head">
            <h3 id="daSettingsTitle">Data Agent Settings</h3>
            <button class="da-icon-btn" type="button" id="daSettingsCloseBtn" title="Close settings"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="da-modal-body">
            <section class="da-settings-section">
              <h4>System Prompt</h4>
              <textarea id="daSystemPrompt" placeholder="Tell the Data Agent how to understand FirstMeasure and answer users..."></textarea>
            </section>
            <section class="da-settings-section">
              <h4>Read-only Function Calls</h4>
              <div class="da-tool-list" id="daFunctionList"></div>
            </section>
          </div>
          <div class="da-modal-foot">
            <button class="da-btn" type="button" id="daSettingsCancelBtn">Cancel</button>
            <button class="da-btn primary" type="button" id="daSettingsSaveBtn">Save Settings</button>
          </div>
        </div>
      </div>
    `;
    $('#daNewChatBtn', mount)?.addEventListener('click', newSession);
    $('#daRefreshBtn', mount)?.addEventListener('click', bootstrap);
    $('#daTraceToggleBtn', mount)?.addEventListener('click', toggleTrace);
    $('#daTraceCloseBtn', mount)?.addEventListener('click', toggleTrace);
    $('#daMobileListBtn', mount)?.addEventListener('click', toggleMobileList);
    $('#daComposer', mount)?.addEventListener('submit', sendMessage);
    $('#daSettingsBtn', mount)?.addEventListener('click', openSettings);
    $('#daSettingsTopBtn', mount)?.addEventListener('click', openSettings);
    $('#daSettingsCloseBtn', mount)?.addEventListener('click', closeSettings);
    $('#daSettingsCancelBtn', mount)?.addEventListener('click', closeSettings);
    $('#daSettingsSaveBtn', mount)?.addEventListener('click', saveSettings);
    $('#daChatTitle', mount)?.addEventListener('click', beginTitleEdit);
    const settingsModal = $('#daSettingsModal', mount);
    settingsModal?.addEventListener('mousedown', e => {
      settingsModal.dataset.backdropPress = e.target?.id === 'daSettingsModal' ? '1' : '0';
    });
    settingsModal?.addEventListener('click', e => {
      if (e.target?.id === 'daSettingsModal' && settingsModal.dataset.backdropPress === '1') closeSettings();
      settingsModal.dataset.backdropPress = '0';
    });
    mount.addEventListener('click', handleShellClick);
    $('#daInput', mount)?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#daComposer', mount)?.requestSubmit();
      }
    });
    mount.addEventListener('keydown', e => {
      const input = e.target?.closest?.('[data-inline-edit-input]');
      if (!input) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitInlineEditMessage(Number(input.dataset.inlineEditInput));
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    });
    updateShellHeight();
  }

  function updateShellHeight(){
    const shell = $('#dataAgentRoot');
    if (!shell || shell.closest('.data-agent-standalone')) return;
    const rect = shell.getBoundingClientRect();
    if (!rect || rect.top <= 0 || shell.offsetParent === null) return;
    const bottomPad = 30;
    const available = Math.max(420, Math.floor(window.innerHeight - rect.top - bottomPad));
    shell.style.setProperty('--da-shell-height', `${available}px`);
  }

  function setBusy(busy){
    state.busy = busy;
    const send = $('#daSendBtn');
    const input = $('#daInput');
    if (send) send.disabled = busy;
    if (input) input.disabled = busy;
  }

  function setMobileListVisible(visible){
    const shell = $('#dataAgentRoot');
    if (!shell) return;
    shell.classList.toggle('mobile-list', !!visible);
  }

  function toggleMobileList(){
    const shell = $('#dataAgentRoot');
    if (!shell) return;
    shell.classList.toggle('mobile-list');
  }

  function sessionMetaText(session){
    if (!session) return '';
    const when = fmtTime(session.updated_at || session.created_at);
    const who = session.created_by_name || session.created_by_email || '';
    return [when, who].filter(Boolean).join(' · ');
  }

  function legacyRenderSessions(){
    const host = $('#daSessionList');
    if (!host) return;
    if (!state.sessions.length) {
      host.innerHTML = '<div class="da-empty">No chats</div>';
      return;
    }
    host.innerHTML = state.sessions.map(s => `
      <button class="da-session${s.id === state.activeId ? ' active' : ''}" type="button" data-session-id="${esc(s.id)}">
        <strong>${esc(s.title || 'Data chat')}</strong>
        <span>${esc(fmtTime(s.updated_at))}${s.message_count ? ` · ${s.message_count} messages` : ''}${s.created_by_name ? ` · ${esc(s.created_by_name)}` : ''}</span>
      </button>
    `).join('');
    $$('.da-session', host).forEach(btn => btn.addEventListener('click', () => loadSession(btn.dataset.sessionId)));
  }

  function legacyMessageHtml(message){
    const role = message.role === 'user' ? 'user' : 'assistant';
    const label = role === 'user' ? 'You' : 'Data Agent';
    return `
      <article class="da-msg ${role}">
        <div class="da-msg-meta"><span>${label}</span><span>${esc(fmtTime(message.created_at))}</span>${message.model ? `<span>${esc(message.model)}</span>` : ''}</div>
        <div class="da-md">${renderMarkdown(message.content || '')}</div>
        ${renderArtifactsHtml(message.artifacts || [])}
      </article>
    `;
  }

  function legacyRenderMessages(messages){
    const host = $('#daMessages');
    if (!host) return;
    if (!messages || !messages.length) {
      host.innerHTML = '<div class="da-empty">Ready</div>';
      return;
    }
    host.innerHTML = messages.map(legacyMessageHtml).join('');
    renderCharts(host);
    host.scrollTop = host.scrollHeight;
  }

  function legacyAppendMessage(message){
    const host = $('#daMessages');
    if (!host) return;
    if ($('.da-empty', host)) host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.innerHTML = legacyMessageHtml(message).trim();
    host.appendChild(wrap.firstElementChild);
    renderCharts(host);
    host.scrollTop = host.scrollHeight;
  }

  function legacyAddStatus(text){
    const host = $('#daMessages');
    if (!host) return;
    if ($('.da-empty', host)) host.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'da-status-line';
    line.textContent = text;
    host.appendChild(line);
    host.scrollTop = host.scrollHeight;
  }

  function clearTrace(){
    const host = $('#daTraceList');
    if (host) host.innerHTML = '';
  }

  function addTrace(kind, title, payload){
    const host = $('#daTraceList');
    if (!host) return;
    if ($('.da-empty', host)) host.innerHTML = '';
    const item = document.createElement('div');
    item.className = `da-trace-item ${kind}`;
    item.innerHTML = `
      <div class="da-trace-top"><strong>${esc(title)}</strong><span>${esc(kind)}</span></div>
      <pre>${esc(JSON.stringify(payload || {}, null, 2))}</pre>
    `;
    host.appendChild(item);
    host.scrollTop = host.scrollHeight;
  }

  function latestUserIndex(messages=state.currentMessages){
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') return i;
    }
    return -1;
  }

  function activityHtml(activity=state.runActivity, key='live'){
    if (!activity || !activity.items.length) return '';
    const isExpanded = key === 'live' ? !!activity.expanded : !!state.activityExpanded[key];
    const expanded = isExpanded ? ' expanded' : '';
    const done = activity.running ? '' : ' done';
    const summary = activity.running ? (activity.current || 'Thinking...') : 'Model thinking';
    const items = activity.items.map((item, index) => `
      <div class="da-run-log-item ${esc(item.kind || '')}">
        <div class="da-run-log-top">
          <div class="da-run-log-title"><strong>${esc(item.title || 'activity')}</strong><button class="da-run-copy" type="button" data-copy-activity-key="${esc(key)}" data-copy-activity-index="${esc(index)}" title="Copy tool JSON"><i class="fas fa-copy"></i></button></div>
          <span>${esc(item.kind || 'status')} · ${esc(fmtTime(item.at))}</span>
        </div>
        <pre>${esc(JSON.stringify(item.payload || {}, null, 2))}</pre>
      </div>
    `).join('');
    return `
      <div class="da-run-activity${expanded}${done}" data-run-activity="1">
        <button class="da-run-summary" type="button" data-toggle-activity="${esc(key)}">
          <span class="da-spinner"></span>
          <span>${esc(summary)}</span>
          <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}" style="margin-left:auto"></i>
        </button>
        <div class="da-run-log">${items}</div>
      </div>
    `;
  }

  function startActivity(afterIndex){
    state.runActivity = {
      afterIndex,
      running: true,
      expanded: false,
      current: 'Contacting OpenAI with read-only tools.',
      items: [],
    };
    recordActivity('status', 'thinking', { message:state.runActivity.current }, state.runActivity.current, false);
    renderMessages(state.currentMessages);
  }

  function recordActivity(kind, title, payload, currentText, rerender=true){
    if (!state.runActivity) return;
    const item = { kind, title, payload:payload || {}, at:new Date().toISOString() };
    state.runActivity.items.push(item);
    if (currentText) state.runActivity.current = currentText;
    if (rerender) renderMessages(state.currentMessages);
  }

  function finishActivity(){
    if (!state.runActivity) return;
    state.runActivity.running = false;
    state.runActivity.current = 'Model thinking';
    renderMessages(state.currentMessages);
  }

  function stopRunPolling(){
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.activeRunId = null;
    state.runPollSeq = 0;
    setBusy(false);
  }

  function takeCompletedActivity(){
    if (!state.runActivity) return null;
    const activity = {
      ...state.runActivity,
      running: false,
      expanded: false,
      current: 'Model thinking',
      items: state.runActivity.items.slice(),
    };
    state.runActivity = null;
    return activity;
  }

  function activityFromMessage(message){
    if (message?.activity?.items?.length) return message.activity;
    const trace = Array.isArray(message?.trace) ? message.trace : [];
    if (!trace.length) return null;
    return {
      running: false,
      expanded: false,
      current: 'Model thinking',
      items: trace.map(t => ({
        kind: t.ok === false ? 'error' : 'result',
        title: t.name || 'tool',
        payload: t.summary || t.error || t.arguments || t,
        at: t.started_at || message.created_at || new Date().toISOString(),
      })),
    };
  }

  function getActivityByKey(key){
    if (key === 'live') return state.runActivity;
    const match = String(key || '').match(/^msg-(\d+)$/);
    if (!match) return null;
    return activityFromMessage(state.currentMessages[Number(match[1])]);
  }

  function renderSessions(){
    const host = $('#daSessionList');
    if (!host) return;
    if (!state.sessions.length) {
      host.innerHTML = '<div class="da-empty">No chats</div>';
      return;
    }
    host.innerHTML = state.sessions.map(s => `
      <div class="da-session-row">
        <button class="da-session${s.id === state.activeId ? ' active' : ''}" type="button" data-session-id="${esc(s.id)}">
          <strong>${esc(s.title || 'Data chat')}</strong>
          <span>${esc(fmtTime(s.updated_at))}${s.created_by_name ? ` &middot; ${esc(s.created_by_name)}` : (s.created_by_email ? ` &middot; ${esc(s.created_by_email)}` : '')}</span>
        </button>
        <button class="da-icon-btn da-session-delete" type="button" data-delete-session="${esc(s.id)}" title="Delete conversation"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
  }

  function messageHtml(message, index=0, editableUserIndex=-1){
    const role = message.role === 'user' ? 'user' : 'assistant';
    const label = role === 'user' ? 'You' : 'Data Agent';
    const isEditing = role === 'user' && index === state.editingIndex && !state.busy;
    const canEdit = role === 'user' && index === editableUserIndex && !state.busy && !isEditing;
    const baseArtifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
    const hasChartArtifact = baseArtifacts.some(a => a.type === 'chart');
    const xyBlocks = role === 'assistant' && !hasChartArtifact ? extractXyChartBlocks(message.content || '') : [];
    const content = xyBlocks.reduce((text, block) => text.replace(block.raw, '').trim(), message.content || '');
    const artifacts = [...baseArtifacts, ...xyBlocks.map(b => b.artifact)];
    return `
      <article class="da-msg ${role}${isEditing ? ' editing' : ''}" data-message-index="${esc(index)}">
        <div class="da-msg-meta">
          <div class="da-msg-meta-main"><span>${label}</span><span>${esc(fmtTime(message.created_at))}</span>${message.model ? `<span>${esc(message.model)}</span>` : ''}${message.edited_at ? '<span>edited</span>' : ''}</div>
          <div class="da-msg-actions">
            <button class="da-msg-action da-msg-copy" type="button" data-copy-message="${esc(index)}" title="Copy message"><i class="fas fa-copy"></i></button>
            ${canEdit ? `<button class="da-msg-action da-msg-edit" type="button" data-edit-message="${esc(index)}" title="Edit and rerun"><i class="fas fa-pen"></i></button>` : ''}
          </div>
        </div>
        ${isEditing ? `
          <div class="da-inline-editor">
            <textarea data-inline-edit-input="${esc(index)}">${esc(message.content || '')}</textarea>
            <div class="da-inline-actions">
              <button class="secondary" type="button" data-cancel-inline-edit="1">Cancel</button>
              <button class="primary" type="button" data-submit-inline-edit="${esc(index)}">Resubmit</button>
            </div>
          </div>
        ` : `
          <div class="da-md">${renderMarkdown(content)}</div>
          ${renderArtifactsHtml(artifacts)}
        `}
      </article>
    `;
  }

  function renderMessages(messages){
    const host = $('#daMessages');
    if (!host) return;
    state.currentMessages = Array.isArray(messages) ? messages.slice() : [];
    updateEditBanner();
    if (!state.currentMessages.length) {
      host.innerHTML = '<div class="da-empty">Ready</div>';
      return;
    }
    const editableUserIndex = latestUserIndex(state.currentMessages);
    const chunks = [];
    state.currentMessages.forEach((m, i) => {
      const savedActivity = m.role === 'assistant' ? activityFromMessage(m) : null;
      if (savedActivity) chunks.push(activityHtml(savedActivity, `msg-${i}`));
      chunks.push(messageHtml(m, i, editableUserIndex));
      if (state.runActivity && state.runActivity.afterIndex === i) chunks.push(activityHtml(state.runActivity, 'live'));
    });
    if (state.runActivity && state.runActivity.afterIndex >= state.currentMessages.length) chunks.push(activityHtml(state.runActivity, 'live'));
    host.innerHTML = chunks.join('');
    renderCharts(host);
    host.scrollTop = host.scrollHeight;
  }

  function appendMessage(message){
    state.currentMessages.push(message);
    renderMessages(state.currentMessages);
  }

  function addStatus(text){
    recordActivity('status', 'thinking', { message:text }, text);
    addTrace('status', 'thinking', { message:text, at:new Date().toISOString() });
  }

  async function handleShellClick(event){
    const target = event.target;
    const deleteButton = target.closest?.('[data-delete-session]');
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      await deleteSession(deleteButton.dataset.deleteSession);
      return;
    }
    const copyButton = target.closest?.('[data-copy-message]');
    if (copyButton) {
      event.preventDefault();
      copyMessage(Number(copyButton.dataset.copyMessage), copyButton);
      return;
    }
    const copyActivityButton = target.closest?.('[data-copy-activity-key]');
    if (copyActivityButton) {
      event.preventDefault();
      copyActivityItem(copyActivityButton.dataset.copyActivityKey, Number(copyActivityButton.dataset.copyActivityIndex), copyActivityButton);
      return;
    }
    const editButton = target.closest?.('[data-edit-message]');
    if (editButton) {
      event.preventDefault();
      beginEditMessage(Number(editButton.dataset.editMessage));
      return;
    }
    const cancelInlineEdit = target.closest?.('[data-cancel-inline-edit]');
    if (cancelInlineEdit) {
      event.preventDefault();
      cancelEdit();
      return;
    }
    const submitInlineEdit = target.closest?.('[data-submit-inline-edit]');
    if (submitInlineEdit) {
      event.preventDefault();
      await submitInlineEditMessage(Number(submitInlineEdit.dataset.submitInlineEdit));
      return;
    }
    const activityButton = target.closest?.('[data-toggle-activity]');
    if (activityButton) {
      event.preventDefault();
      const key = activityButton.dataset.toggleActivity || 'live';
      if (key === 'live' && state.runActivity) state.runActivity.expanded = !state.runActivity.expanded;
      else state.activityExpanded[key] = !state.activityExpanded[key];
      renderMessages(state.currentMessages);
      return;
    }
    const sessionButton = target.closest?.('[data-session-id]');
    if (sessionButton) {
      await loadSession(sessionButton.dataset.sessionId);
    }
  }

  function updateEditBanner(){
    return;
  }

  function beginEditMessage(index){
    if (state.busy || !Number.isInteger(index)) return;
    if (index !== latestUserIndex(state.currentMessages)) return;
    const message = state.currentMessages[index];
    if (!message || message.role !== 'user') return;
    state.editingIndex = index;
    renderMessages(state.currentMessages);
    setTimeout(() => {
      const input = $(`[data-inline-edit-input="${index}"]`);
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  }

  function cancelEdit(){
    state.editingIndex = null;
    renderMessages(state.currentMessages);
  }

  async function submitInlineEditMessage(index){
    if (state.busy || !Number.isInteger(index)) return;
    if (index !== state.editingIndex || index !== latestUserIndex(state.currentMessages)) return;
    const input = $(`[data-inline-edit-input="${index}"]`);
    const text = String(input?.value || '').trim();
    if (!text) return;
    await sendTextToAgent(text, index);
  }

  async function copyMessage(index, button){
    const message = state.currentMessages[index];
    const text = String(message?.content || '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const icon = button?.innerHTML;
      if (button) {
        button.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { button.innerHTML = icon; }, 900);
      }
    } catch(e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  async function copyActivityItem(key, index, button){
    const activity = getActivityByKey(key);
    const item = activity?.items?.[index];
    if (!item) return;
    const text = `${item.title || 'activity'}\n${JSON.stringify(item.payload || {}, null, 2)}`;
    try {
      await navigator.clipboard.writeText(text);
      const icon = button?.innerHTML;
      if (button) {
        button.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { button.innerHTML = icon; }, 900);
      }
    } catch(e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  async function openSettings(){
    const modal = $('#daSettingsModal');
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    $('#daSystemPrompt').value = '';
    $('#daFunctionList').innerHTML = '<div class="da-empty">Loading</div>';
    try {
      const data = await apiPost({ action:'data_agent_get_settings' });
      const settings = data.settings || {};
      $('#daSystemPrompt').value = settings.system_prompt || '';
      const tools = Array.isArray(data.function_calls) ? data.function_calls : [];
      $('#daFunctionList').innerHTML = tools.map(t => `
        <div class="da-tool-item">
          <strong>${esc(t.name || 'tool')}</strong>
          <span>${esc(t.description || '')}</span>
        </div>
      `).join('') || '<div class="da-empty">No function calls found</div>';
    } catch (err) {
      $('#daSystemPrompt').value = String(err.message || err);
      $('#daFunctionList').innerHTML = '<div class="da-empty">Could not load functions</div>';
    }
  }

  function closeSettings(){
    const modal = $('#daSettingsModal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function saveSettings(){
    const btn = $('#daSettingsSaveBtn');
    const original = btn?.textContent || 'Save Settings';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }
    try {
      await apiPost({ action:'data_agent_save_settings', system_prompt:$('#daSystemPrompt')?.value || '' });
      closeSettings();
    } catch (err) {
      window.alert(`Could not save settings: ${String(err.message || err)}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  async function deleteSession(id){
    if (!id) return;
    const session = state.sessions.find(s => s.id === id);
    const title = session?.title || 'this conversation';
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    if (state.activeId === id) stopRunPolling();
    try {
      await apiPost({ action:'data_agent_delete_session', session_id:id });
    } catch (err) {
      window.alert(`Could not delete the conversation: ${String(err.message || err)}`);
      return;
    }
    state.sessions = state.sessions.filter(s => s.id !== id);
    if (state.activeId === id) {
      state.activeId = state.sessions[0]?.id || null;
      if (state.activeId) await loadSession(state.activeId);
      else showDraftChat();
    } else {
      renderSessions();
    }
  }

  function beginTitleEdit(){
    if (!state.activeId || state.busy || $('#daTitleInput')) return;
    const title = $('#daChatTitle');
    if (!title) return;
    const current = title.textContent || '';
    const input = document.createElement('input');
    input.id = 'daTitleInput';
    input.className = 'da-title-input';
    input.value = current;
    title.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveTitleEdit(input.value);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        renderChatTitle(current);
      }
    });
    input.addEventListener('blur', () => saveTitleEdit(input.value));
  }

  function renderChatTitle(titleText){
    const existing = $('#daTitleInput') || $('#daChatTitle');
    if (!existing) return;
    const h2 = document.createElement('h2');
    h2.id = 'daChatTitle';
    h2.dataset.titleEditable = '1';
    h2.textContent = titleText || 'Data chat';
    existing.replaceWith(h2);
    h2.addEventListener('click', beginTitleEdit);
  }

  async function saveTitleEdit(value){
    const title = String(value || '').trim();
    if (!state.activeId) {
      renderChatTitle(title || 'Data Agent');
      return;
    }
    if (!title) {
      renderChatTitle($('#daTitleInput')?.defaultValue || 'Data chat');
      return;
    }
    renderChatTitle(title);
    try {
      const data = await apiPost({ action:'data_agent_rename_session', session_id:state.activeId, title });
      const saved = data.session?.title || title;
      renderChatTitle(saved);
      const row = state.sessions.find(s => s.id === state.activeId);
      if (row) row.title = saved;
      renderSessions();
    } catch (err) {
      window.alert(`Could not rename conversation: ${String(err.message || err)}`);
    }
  }

  function renderArtifactsHtml(artifacts){
    if (!Array.isArray(artifacts) || !artifacts.length) return '';
    return `<div class="da-artifacts">${artifacts.map(a => {
      if (a.type === 'chart') {
        return `<section class="da-artifact"><div class="da-artifact-title"><i class="fas fa-chart-simple"></i>${esc(a.title || 'Chart')}</div><div class="da-artifact-body"><canvas data-chart-artifact="${esc(JSON.stringify(a))}"></canvas></div></section>`;
      }
      if (a.type === 'table') {
        const cols = Array.isArray(a.columns) ? a.columns : [];
        const rows = Array.isArray(a.rows) ? a.rows : [];
        return `<section class="da-artifact"><div class="da-artifact-title"><i class="fas fa-table"></i>${esc(a.title || 'Table')}</div><div class="da-artifact-body"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
      }
      return '';
    }).join('')}</div>`;
  }

  function chartColor(index){
    return ['#d93025','#1a73e8','#137333','#f9ab00','#9334e6','#00acc1','#e8710a','#5f6368'][index % 8];
  }

  function normalizeChartArtifact(artifact){
    const labels = Array.isArray(artifact.labels) ? artifact.labels.map(v => String(v)) : [];
    const datasets = (Array.isArray(artifact.datasets) ? artifact.datasets : []).map((ds, i) => {
      const color = ds.borderColor || ds.backgroundColor || chartColor(i);
      const data = Array.isArray(ds.data) ? ds.data.map(v => Number(v) || 0) : [];
      return {
        ...ds,
        label: ds.label || ds.name || `Series ${i + 1}`,
        data,
        borderColor: ds.borderColor || color,
        backgroundColor: ds.backgroundColor || (artifact.chart_type === 'line' ? color + '33' : color),
        fill: ds.fill ?? false,
        tension: ds.tension ?? (artifact.chart_type === 'line' ? 0.25 : 0),
      };
    });
    return { ...artifact, labels, datasets };
  }

  function parseJsonishArray(text){
    try { return JSON.parse(text); } catch(e) {}
    return String(text || '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  function extractXyChartBlocks(text){
    const lines = String(text || '').split(/\r?\n/);
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== 'xychart-beta') continue;
      const start = i;
      const block = [lines[i]];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        block.push(lines[i]);
        i++;
      }
      const raw = block.join('\n');
      const title = raw.match(/title\s+"([^"]+)"/)?.[1] || 'Chart';
      const labelsRaw = raw.match(/x-axis\s+(\[[^\n]+\])/)?.[1] || '[]';
      const labels = parseJsonishArray(labelsRaw).map(v => String(v));
      const datasets = [];
      let chartType = 'bar';
      for (const line of block) {
        const m = line.match(/^\s*(line|bar)\s+"([^"]+)"\s+(\[[^\n]+\])/);
        if (!m) continue;
        if (m[1] === 'line') chartType = 'line';
        datasets.push({ label:m[2], data:parseJsonishArray(m[3]).map(v => Number(v) || 0) });
      }
      if (labels.length && datasets.length) {
        blocks.push({ raw, artifact:{ id:`xy_${start}_${datasets.length}`, type:'chart', chart_type:chartType, title, labels, datasets } });
      }
    }
    return blocks;
  }

  function renderCharts(rootNode=document){
    if (!window.Chart) return;
    $$('canvas[data-chart-artifact]', rootNode).forEach(canvas => {
      if (canvas.dataset.rendered) return;
      let artifact = null;
      try { artifact = JSON.parse(canvas.dataset.chartArtifact || '{}'); } catch(e) {}
      if (!artifact) return;
      artifact = normalizeChartArtifact(artifact);
      canvas.dataset.rendered = '1';
      const datasets = Array.isArray(artifact.datasets) ? artifact.datasets : [];
      new window.Chart(canvas, {
        type: artifact.chart_type || 'bar',
        data: { labels: artifact.labels || [], datasets },
        options: {
          responsive:true,
          maintainAspectRatio:false,
          scales: artifact.chart_type === 'pie' || artifact.chart_type === 'doughnut' ? {} : { y:{ beginAtZero:true } },
          plugins:{ legend:{ display:datasets.length > 1 } }
        }
      });
    });
  }

  async function bootstrap(){
    renderShell();
    await ensureRenderLibs();
    const data = await apiPost({ action:'data_agent_bootstrap' });
    state.sessions = data.sessions || [];
    if (state.activeId && !state.sessions.some(s => s.id === state.activeId)) state.activeId = null;
    if (!state.activeId && state.sessions[0]) state.activeId = state.sessions[0].id;
    renderSessions();
    if (state.activeId) await loadSession(state.activeId);
    else {
      showDraftChat();
      if (window.matchMedia('(max-width:760px)').matches) setMobileListVisible(true);
    }
    updateShellHeight();
    state.booted = true;
  }

  async function newSession(){
    state.activeId = null;
    state.editingIndex = null;
    renderSessions();
    showDraftChat();
    setMobileListVisible(false);
  }

  function showDraftChat(){
    stopRunPolling();
    state.activeId = null;
    state.editingIndex = null;
    state.runActivity = null;
    const title = $('#daChatTitle');
    const meta = $('#daChatMeta');
    if (title || $('#daTitleInput')) renderChatTitle('New data chat');
    if (meta) meta.textContent = 'Not saved until you send a message';
    renderMessages([]);
    clearTrace();
    const trace = $('#daTraceList');
    if (trace) trace.innerHTML = '<div class="da-empty">No active run</div>';
    updateShellHeight();
  }

  async function loadSession(id){
    if (!id) return;
    stopRunPolling();
    const data = await apiPost({ action:'data_agent_get_session', session_id:id });
    state.activeId = id;
    state.editingIndex = null;
    state.runActivity = null;
    const session = data.session || {};
    renderChatTitle(session.title || 'Data chat');
    $('#daChatMeta').textContent = sessionMetaText(session);
    renderSessions();
    renderMessages(session.messages || []);
    setMobileListVisible(false);
    updateShellHeight();
    clearTrace();
    const lastAssistant = [...(session.messages || [])].reverse().find(m => m.role === 'assistant' && Array.isArray(m.trace));
    if (lastAssistant?.trace?.length) {
      lastAssistant.trace.forEach(t => addTrace(t.ok === false ? 'error' : 'result', t.name || 'tool', t));
    } else {
      $('#daTraceList').innerHTML = '<div class="da-empty">No active run</div>';
    }
    if (data.active_run?.id) {
      startActivity(latestUserIndex(state.currentMessages));
      pollRun(data.active_run.id, 0);
    }
  }

  async function sendMessage(event){
    event.preventDefault();
    if (state.busy) return;
    const input = $('#daInput');
    const text = String(input?.value || '').trim();
    if (!text) return;
    input.value = '';
    await sendTextToAgent(text, null);
  }

  async function sendTextToAgent(text, editIndex=null){
    clearTrace();
    setBusy(true);
    if (editIndex !== null) {
      const now = new Date().toISOString();
      const messages = state.currentMessages.slice(0, editIndex);
      messages.push({ role:'user', content:text, created_at:now, edited_at:now });
      renderMessages(messages);
    } else {
      appendMessage({ role:'user', content:text, created_at:new Date().toISOString() });
    }
    startActivity(state.currentMessages.length - 1);
    try {
      const payload = { action:'data_agent_start_run', session_id:state.activeId || '', message:text };
      if (editIndex !== null) payload.edit_message_index = String(editIndex);
      const data = await apiPost(payload);
      if (data.session_id) state.activeId = data.session_id;
      if (data.session?.title) renderChatTitle(data.session.title);
      await refreshSessionList();
      await pollRun(data.run?.id, data.run?.last_event_seq || 0);
    } catch (err) {
      addTrace('error', 'request failed', { error:String(err.message || err) });
      appendMessage({ role:'assistant', content:`I hit an error while running that: ${String(err.message || err)}`, created_at:new Date().toISOString() });
      setBusy(false);
    } finally {
      state.editingIndex = null;
      setBusy(false);
      renderMessages(state.currentMessages);
    }
  }

  function handleStreamLine(line){
    if (!line.trim()) return;
    let msg = null;
    try { msg = JSON.parse(line); } catch(e) { return; }
    handleRunEvent(msg.event, msg.data || {});
  }

  function handleRunEvent(event, data){
    if (event === 'user_message') return;
    if (event === 'status') addStatus(data.message || 'Working...');
    if (event === 'meta') {
      addTrace('result', 'model', data);
      recordActivity('result', 'model selected', data, `Using ${data.model || 'selected model'}`);
    }
    if (event === 'tool_call') {
      addTrace('call', data.name || 'tool call', data.arguments || data);
      recordActivity('call', data.name || 'tool call', data.arguments || data, `Calling ${data.name || 'tool'}`);
    }
    if (event === 'tool_result') {
      addTrace(data.ok === false ? 'error' : 'result', data.name || 'tool result', data.summary || data);
      recordActivity(data.ok === false ? 'error' : 'result', data.name || 'tool result', data.summary || data, data.ok === false ? `Tool error: ${data.name || 'tool'}` : `Read ${data.name || 'tool'} result`);
    }
    if (event === 'assistant_message') {
      const activity = takeCompletedActivity();
      appendMessage({ role:'assistant', content:data.content || '', artifacts:data.artifacts || [], activity, model:data.model || '', created_at:data.created_at || new Date().toISOString() });
    }
    if (event === 'error') {
      addTrace('error', 'error', data);
      recordActivity('error', 'error', data, 'The run hit an error.');
      const activity = takeCompletedActivity();
      appendMessage({ role:'assistant', content:data.message || 'The run failed.', activity, created_at:new Date().toISOString() });
    }
    if (event === 'done' && data.session_id) {
      state.activeId = data.session_id;
      if (state.runActivity) finishActivity();
    }
  }

  async function pollRun(runId, afterSeq=0){
    if (!runId) return;
    state.activeRunId = runId;
    state.runPollSeq = Number(afterSeq) || 0;
    const tick = async () => {
      if (state.activeRunId !== runId) return;
      try {
        const data = await apiPost({ action:'data_agent_get_run', run_id:runId, after_seq:String(state.runPollSeq) });
        if (data.session_title) renderChatTitle(data.session_title);
        const events = Array.isArray(data.events) ? data.events : [];
        for (const item of events) {
          state.runPollSeq = Math.max(state.runPollSeq, Number(item.seq) || 0);
          handleRunEvent(item.event, item.data || {});
        }
        const status = data.run?.status || 'queued';
        if (status === 'completed' || status === 'error') {
          stopRunPolling();
          await refreshSessionList();
          return;
        }
        state.pollTimer = setTimeout(tick, 900);
      } catch (err) {
        addTrace('error', 'poll failed', { error:String(err.message || err) });
        state.pollTimer = setTimeout(tick, 1800);
      }
    };
    await tick();
  }

  async function refreshSessionList(){
    try {
      const data = await apiPost({ action:'data_agent_list_sessions' });
      state.sessions = data.sessions || state.sessions;
      renderSessions();
      updateShellHeight();
    } catch(e) {}
  }

  function toggleTrace(){
    const shell = $('#dataAgentRoot');
    if (!shell) return;
    if (window.matchMedia('(max-width:1100px)').matches) {
      shell.classList.toggle('trace-visible');
    } else {
      shell.classList.toggle('trace-collapsed');
    }
    updateShellHeight();
  }

  function registerPortalPlugin(){
    if (cfg().flags && cfg().flags.can_data_agent === false) return;
    if (!window.Portal || $('#view-data-agent')) return;
    const mount = document.createElement('div');
    mount.id = 'view-data-agent';
    mount.style.display = 'none';
    const pluginViews = $('#portalPluginViews');
    (pluginViews || $('.main-content') || document.body).appendChild(mount);
    window.Portal.registerPlugin({ id:'data-agent', title:'Data Agent', iconClass:'fas fa-database' });
    if (!window.Portal.__dataAgentSwitchPatched) {
      const originalSwitch = window.Portal.switchView.bind(window.Portal);
      window.Portal.switchView = async function(id, btn){
        const result = await originalSwitch(id, btn);
        if (id === 'data-agent') setTimeout(updateShellHeight, 0);
        return result;
      };
      window.Portal.__dataAgentSwitchPatched = true;
    }
  }

  window.DataAgent = { bootstrap, init: bootstrap, newSession, loadSession };

  document.addEventListener('DOMContentLoaded', () => {
    registerPortalPlugin();
    if ($('#dataAgentStandaloneMount')) bootstrap().catch(err => console.error(err));
    else bootstrap().catch(err => {
      renderShell();
      const host = $('#daMessages');
      if (host) host.innerHTML = `<div class="da-empty">${esc(err.message || err)}</div>`;
    });
  });
  window.addEventListener('resize', updateShellHeight);
})();
