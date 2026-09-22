/* Global communications center: every inbox in one place — live website
 * chat (full presence/claiming/AI behavior, backed by /v1/chat), plus the
 * org-wide email and SMS inboxes (backed by /v1/comms). Live chat keeps all
 * of its original machinery; email/SMS conversations open in the same
 * three-pane layout with channel-appropriate reply composers, and the comms
 * agent is available org-wide from the Ask AI button. */
(function(){
  const Portal = window.Portal || {};
  const util = Portal.util || {};
  const $ = util.$ || ((s, r=document) => r.querySelector(s));
  const $$ = util.$$ || ((s, r=document) => [...r.querySelectorAll(s)]);
  const esc = util.escapeHtml || ((v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const APP = window.__APP || {};

  const state = {
    root: null,
    mounted: false,
    conversations: [],
    onlineUsers: [],
    liveStatus: 'offline',
    features: { suggestions: false, claiming_mode: 'presence' },
    filter: 'open',
    activeId: '',
    detail: null,
    cursor: '',
    drafts: new Map(),
    suggestionDrafts: new Map(),
    autoSuggestedFor: new Map(),
    renderedMessageIds: new Set(),
    suggestion: null,
    suggestionError: '',
    suggestionRequestId: 0,
    suggesting: false,
    polishing: false,
    pollTimer: null,
    typingSentAt: 0,
    lastListJson: '',
    sending: false,
    unreadTotal: 0,
    // Global comms center additions: channel filter, org-wide email/SMS rows
    // from /v1/comms, and the active non-chat conversation.
    channel: 'all',
    commsRows: [],
    commsDetail: null,
    activeKind: 'webchat',
    commsSending: false,
    commsSettings: { voice:{ sms:'attachment', email:'dictation' } },
    commsSettingsLoaded: false,
    pendingVoice: new Map(),
    agent: { open: false, threadId: '', messages: [], busy: false, error: '' }
  };

  const can = (key) => {
    try {
      if (window.Portal?.can && window.Portal?.capabilities?.can) return window.Portal.can(key) !== false;
    } catch (_) {}
    return true;
  };
  const commsApi = () => window.CommsAPI || null;
  const agentsApi = () => window.AgentsAPI || null;
  const commsChannelsEnabled = () => Boolean(commsApi()) && can('apps.comms');
  const chatChannelEnabled = () => can('apps.live_chat');

  const orgId = () => String(APP.userOrgId || APP.orgId || '').trim();
  const userId = () => String(APP.userId || window.Portal?.currentUser?.id || '').trim();
  const apiBase = () => {
    const platform = String(APP.platformApiBase || '').trim();
    if (platform) return platform.replace(/\/platform\/?$/, '/chat');
    return `${location.origin}/v1/chat`;
  };
  const csrfToken = () => {
    const match = document.cookie.match(/(?:^|;\s*)fm_platform_session_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  };
  async function api(path, options = {}){
    const method = String(options.method || 'GET').toUpperCase();
    const res = await fetch(`${apiBase()}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Platform-CSRF': csrfToken() } : {}),
        ...(options.headers || {})
      }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const error = new Error(json.message || 'Chat request failed.');
      error.code = json.error || '';
      throw error;
    }
    return json;
  }

  const timeAgo = (iso) => {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };
  const clock = (iso) => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  };
  const dayLabel = (iso) => {
    const date = new Date(iso);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return 'Today';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const firstName = (value) => String(value || '').trim().split(/\s+/)[0] || '';

  function css(){
    const text = `
      .fmchat-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fa;color:#172033}
      .fmchat-head{padding:12px 22px;border-bottom:1px solid #e5e7eb;background:#fff;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}
      .fmchat-head h2{margin:0;font-size:18px}
      .fmchat-live{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#667085;padding:6px 11px;border:1px solid #e4e7ec;border-radius:999px;background:#fff}
      .fmchat-live i{width:9px;height:9px;border-radius:50%;background:#f0b429;display:inline-block}
      .fmchat-live.online i{background:#12b76a}
      .fmchat-main{flex:1;min-height:0;display:grid;grid-template-columns:320px minmax(0,1fr) 280px}
      .fmchat-list-col{border-right:1px solid #e5e7eb;background:#fff;display:flex;flex-direction:column;min-height:0}
      .fmchat-filters{display:flex;gap:4px;padding:10px 12px;border-bottom:1px solid #eef1f4;flex:0 0 auto}
      .fmchat-filter{border:1px solid transparent;background:transparent;border-radius:7px;padding:5px 10px;font:inherit;font-size:12px;font-weight:800;color:#667085;cursor:pointer}
      .fmchat-filter:hover{background:#f2f4f7}
      .fmchat-filter.active{background:#172033;color:#fff}
      .fmchat-list{flex:1;min-height:0;overflow-y:auto;padding:6px}
      .fmchat-row{width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:9px;padding:10px 11px;cursor:pointer;font:inherit;display:grid;gap:4px;position:relative}
      .fmchat-row:hover{background:#f8fafc}
      .fmchat-row.active{background:#eef4ff;border-color:#c7dbff}
      .fmchat-row-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .fmchat-row-name{font-size:13px;font-weight:900;display:flex;align-items:center;gap:6px;min-width:0}
      .fmchat-row-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmchat-online-dot{width:7px;height:7px;border-radius:50%;background:#12b76a;flex:0 0 auto}
      .fmchat-row-time{font-size:11px;color:#98a2b3;font-weight:700;flex:0 0 auto}
      .fmchat-row-preview{font-size:12px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmchat-row.unread .fmchat-row-preview{color:#172033;font-weight:700}
      .fmchat-unread-dot{position:absolute;top:12px;right:10px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#2563eb;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center}
      .fmchat-row.unread .fmchat-row-time{display:none}
      .fmchat-tags{display:flex;gap:5px;flex-wrap:wrap}
      .fmchat-tag{font-size:10px;font-weight:900;padding:2px 7px;border-radius:999px;background:#f2f4f7;color:#475467}
      .fmchat-tag.wait{background:#fff7e6;color:#b45309}
      .fmchat-tag.wait.hot{background:#fee4e2;color:#b42318}
      .fmchat-tag.claim{background:#ede9fe;color:#6d28d9}
      .fmchat-tag.mine{background:#dcfce7;color:#15803d}
      .fmchat-tag.view{background:#e0f2fe;color:#0369a1}
      .fmchat-tag.ai{background:#fef3c7;color:#92400e}
      .fmchat-tag.typing{background:#e0f2fe;color:#0369a1}
      .fmchat-empty{padding:32px 16px;text-align:center;color:#98a2b3;font-size:13px}
      .fmchat-thread-col{display:flex;flex-direction:column;min-height:0;min-width:0;background:#f7f8fa}
      .fmchat-thread-head{padding:11px 18px;border-bottom:1px solid #e5e7eb;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 auto;min-height:54px}
      .fmchat-thread-title{font-size:14px;font-weight:900;display:flex;align-items:center;gap:8px;min-width:0}
      .fmchat-thread-sub{font-size:11.5px;color:#667085;font-weight:700}
      .fmchat-thread-actions{display:flex;gap:6px;flex:0 0 auto}
      .fmchat-btn{border:1px solid #d8dee8;background:#fff;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;font-weight:800;padding:6px 11px;color:#344054;display:inline-flex;align-items:center;gap:6px}
      .fmchat-btn:hover{background:#f8fafc}
      .fmchat-btn.primary{background:#172033;border-color:#172033;color:#fff}
      .fmchat-btn.primary:hover{background:#232f47}
      .fmchat-btn:disabled{opacity:.5;cursor:default}
      .fmchat-banner{padding:9px 18px;font-size:12.5px;font-weight:800;display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 auto}
      .fmchat-banner.ai{background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e}
      .fmchat-banner.claim{background:#f5f3ff;border-bottom:1px solid #ddd6fe;color:#5b21b6}
      .fmchat-msgs{flex:1;min-height:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:4px;scroll-behavior:smooth}
      .fmchat-day{align-self:center;font-size:11px;font-weight:800;color:#98a2b3;margin:10px 0 6px}
      .fmchat-msg{max-width:68%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
      .fmchat-msg.is-new{animation:fmchatIn .16s ease}
      @keyframes fmchatIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      .fmchat-msg.inbound{align-self:flex-start;background:#fff;border:1px solid #e4e7ec;border-bottom-left-radius:5px}
      .fmchat-msg.outbound{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:5px}
      .fmchat-msg.outbound.ai{background:#7c3aed}
      .fmchat-msg.internal{align-self:flex-end;background:#fffbeb;border:1px dashed #f0d9a8;color:#7a5c12}
      .fmchat-msg.pending{opacity:.6}
      .fmchat-msg-meta{font-size:10.5px;color:#98a2b3;font-weight:700;margin:2px 4px 6px}
      .fmchat-msg-meta.inbound{align-self:flex-start}
      .fmchat-msg-meta.outbound{align-self:flex-end}
      .fmchat-typing-row{align-self:flex-start;display:flex;gap:4px;padding:11px 14px;background:#fff;border:1px solid #e4e7ec;border-radius:14px;border-bottom-left-radius:5px}
      .fmchat-typing-row i{width:6px;height:6px;border-radius:50%;background:#98a2b3;animation:fmchatBounce 1.2s infinite}
      .fmchat-typing-row i:nth-child(2){animation-delay:.15s}.fmchat-typing-row i:nth-child(3){animation-delay:.3s}
      @keyframes fmchatBounce{0%,60%,100%{transform:none}30%{transform:translateY(-4px)}}
      .fmchat-composer-wrap{flex:0 0 auto;border-top:1px solid #e5e7eb;background:#fff;padding:10px 14px 12px}
      .fmchat-suggestion{position:relative;width:min(100%,760px);border:1px solid #ddd6fe;background:#f5f3ff;border-radius:10px;padding:10px 42px 10px 12px;margin-bottom:8px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center}
      .fmchat-suggestion[hidden]{display:none}
      .fmchat-suggestion-label{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#6d28d9;display:flex;align-items:center;gap:6px}
      .fmchat-suggestion-text{grid-column:1/2;font-size:13px;line-height:1.45;color:#344054;white-space:pre-wrap}
      .fmchat-suggestion-text.loading{color:#7c6bb3;font-style:italic}
      .fmchat-suggestion-text.error{color:#8a4b16}
      .fmchat-suggestion-actions{grid-column:2/3;grid-row:1/3;display:flex;gap:6px;align-items:center}
      .fmchat-suggestion-dismiss{position:absolute;top:7px;right:7px;width:27px;height:27px;border:0;border-radius:7px;background:transparent;color:#7c6bb3;cursor:pointer}
      .fmchat-suggestion-dismiss:hover{background:#ebe7ff;color:#5b21b6}
      .fmchat-composer-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:7px;flex-wrap:wrap}
      .fmchat-tool-btn{border:1px solid #d8dee8;background:#fff;border-radius:8px;cursor:pointer;font:inherit;font-size:11px;font-weight:800;padding:6px 9px;color:#475467;display:inline-flex;align-items:center;gap:6px}
      .fmchat-tool-btn:hover{background:#f8fafc;border-color:#c7ced9}
      .fmchat-tool-btn.active{background:#fffbeb;border-color:#f0d9a8;color:#b45309}
      .fmchat-tool-btn:disabled{opacity:.55;cursor:default}
      .fmchat-composer{display:flex;align-items:flex-end;gap:8px}
      .fmchat-input{flex:1;border:1px solid #d0d5dd;border-radius:10px;padding:9px 12px;font:inherit;font-size:13.5px;resize:none;max-height:130px;outline:none;min-height:38px}
      .fmchat-input:focus{border-color:#2563eb}
      .fmchat-input.internal-mode{background:#fffbeb;border-color:#f0d9a8}
      .fmchat-composer-side{display:flex;gap:6px}
      .fmchat-icon-btn{width:36px;height:36px;border:1px solid #d8dee8;background:#fff;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#475467;font-size:14px}
      .fmchat-icon-btn:hover{background:#f8fafc}
      .fmchat-icon-btn.active{background:#fffbeb;border-color:#f0d9a8;color:#b45309}
      .fmchat-icon-btn.send{background:#172033;border-color:#172033;color:#fff}
      .fmchat-icon-btn.send:hover{background:#232f47}
      .fmchat-icon-btn:disabled{opacity:.5;cursor:default}
      .fmchat-icon-btn.voice{width:auto;padding:0 8px;gap:5px}.fmchat-icon-btn.voice small{font-size:9px;font-weight:850}
      .fmchat-composer-hints{display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px;color:#98a2b3;font-weight:700}
      .fmchat-voice-mode{display:inline-flex;align-items:center;gap:4px;color:#667085}.fmchat-voice-mode i{color:var(--primary-readable,var(--primary,#2563eb))}
      .fmchat-voice-mount:empty{display:none}.fmchat-msg-audio{margin-top:6px;min-width:220px}.fmchat-msg.outbound .fm-an-player{background:rgba(255,255,255,.94);color:#344054}
      .fmchat-page-context{align-self:flex-start;width:min(360px,88%);margin:0 0 7px;border:1px solid #d8dee8;border-radius:11px;background:#fff;overflow:hidden;box-shadow:0 3px 10px rgba(16,24,40,.05)}
      .fmchat-page-context-head{padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;gap:8px}.fmchat-page-context-head i{color:#667085}.fmchat-page-context-head span{display:grid;min-width:0}.fmchat-page-context-head small{font-size:9px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3}.fmchat-page-context-head strong{font-size:12px;color:#344054;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmchat-page-shot{display:block;background:#eef1f5;border-bottom:1px solid #e4e7ec}.fmchat-page-shot img{display:block;width:100%;max-height:230px;object-fit:cover;object-position:top left}.fmchat-page-shot:hover img{filter:brightness(.98)}
      .fmchat-page-preview{padding:9px 10px;display:grid;gap:4px;background:linear-gradient(145deg,#fff,#f8fafc)}.fmchat-page-line{font-size:10.5px;line-height:1.3;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmchat-page-line:before{content:' ';display:inline-block;width:4px;height:4px;border-radius:50%;background:#c7ced9;margin:0 6px 2px 0}.fmchat-page-line.title{font-size:11px;font-weight:800;color:#475467}.fmchat-page-line.title:before{display:none}.fmchat-page-line.placeholder{height:6px;border-radius:999px;background:#dfe4eb;width:82%}.fmchat-page-line.placeholder:before{display:none}
      .fmchat-ctx-col{border-left:1px solid #e5e7eb;background:#fff;overflow-y:auto;min-height:0;padding:16px}
      .fmchat-ctx-section{margin-bottom:18px}
      .fmchat-ctx-title{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;margin-bottom:8px}
      .fmchat-ctx-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#344054;padding:3px 0;min-width:0}
      .fmchat-ctx-row i{width:16px;color:#98a2b3;text-align:center;flex:0 0 auto}
      .fmchat-ctx-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmchat-ctx-empty{font-size:12px;color:#98a2b3}
      .fmchat-hist-item{border:1px solid #e4e7ec;border-radius:9px;padding:8px 10px;font-size:12px;color:#475467;margin-bottom:6px}
      .fmchat-hist-item small{display:block;color:#98a2b3;margin-top:2px}
      .fmchat-viewer-chip{display:inline-flex;align-items:center;gap:5px;background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:800;border-radius:999px;padding:3px 9px;margin:0 4px 4px 0}
      .fmchat-blank{flex:1;display:grid;place-items:center;color:#98a2b3}
      .fmchat-blank-inner{text-align:center}
      .fmchat-blank-inner i{font-size:38px;margin-bottom:10px;opacity:.5}
      .fmchat-blank-inner p{margin:0;font-size:13.5px;font-weight:700}
      .fmchat-channels{display:flex;gap:4px;padding:10px 12px 0;flex:0 0 auto}
      .fmchat-channel{border:1px solid #e4e7ec;background:#fff;border-radius:999px;padding:5px 11px;font:inherit;font-size:11.5px;font-weight:800;color:#667085;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .fmchat-channel:hover{background:#f8fafc}
      .fmchat-channel.active{background:#172033;border-color:#172033;color:#fff}
      .fmchat-channel i{font-size:10.5px}
      .fmchat-row-channel{width:26px;height:26px;border-radius:7px;background:#f2f4f7;display:inline-flex;align-items:center;justify-content:center;color:#475467;font-size:11px;flex:0 0 auto}
      .fmchat-row-project{font-size:10.5px;color:#98a2b3;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmchat-ai-toggle{border:1px solid #d8dee8;background:#fff;border-radius:9px;padding:7px 12px;font:inherit;font-size:12px;font-weight:800;color:#344054;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .fmchat-ai-toggle:hover{background:#f8fafc}
      .fmchat-ai-toggle.active{background:var(--primary-readable,var(--primary,#2563eb));border-color:transparent;color:#fff}
      .fmchat-agent-panel{display:flex;flex-direction:column;min-height:0;height:100%}
      .fmchat-agent-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid #eef1f4;margin-bottom:10px}
      .fmchat-agent-title{font-size:12px;font-weight:900;display:flex;align-items:center;gap:8px;color:#101828}
      .fmchat-agent-title i{color:var(--primary-readable,var(--primary,#2563eb))}
      .fmchat-agent-msgs{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:10px}
      .fmchat-agent-msg{border-radius:11px;padding:9px 12px;font-size:12.5px;line-height:1.5;word-wrap:break-word}
      .fmchat-agent-msg.user{align-self:flex-end;background:#172033;color:#fff;max-width:88%;white-space:pre-wrap}
      .fmchat-agent-msg.assistant{align-self:flex-start;background:#f2f4f7;max-width:96%}
      .fmchat-agent-msg.assistant.failed{background:#fffaeb;border:1px solid #fedf89;color:#93370d}
      .fmchat-agent-msg.assistant.pending{opacity:.6;font-style:italic}
      .fmchat-agent-composer{border-top:1px solid #eef1f4;padding-top:10px;display:flex;gap:7px;flex:0 0 auto}
      .fmchat-agent-composer textarea{flex:1;border:1px solid #d0d5dd;border-radius:9px;padding:8px 11px;font:inherit;font-size:12.5px;resize:none;min-height:38px;max-height:120px;outline:none}
      .fmchat-agent-send{width:38px;height:38px;border:0;border-radius:9px;background:var(--primary-readable,var(--primary,#2563eb));color:#fff;cursor:pointer;flex:0 0 auto}
      .fmchat-agent-send:disabled{opacity:.5;cursor:default}
      @media(max-width:1180px){.fmchat-main{grid-template-columns:290px minmax(0,1fr)}.fmchat-ctx-col{display:none}}
      @media(max-width:820px){.fmchat-main{grid-template-columns:1fr}.fmchat-list-col{display:none}.fmchat-shell.list-mode .fmchat-list-col{display:flex}.fmchat-shell.list-mode .fmchat-thread-col{display:none}}
    `;
    util.injectCSS ? util.injectCSS('live_chat_inbox', text) : document.head.appendChild(Object.assign(document.createElement('style'), { textContent: text }));
  }

  // --- Data ---------------------------------------------------------------

  async function loadInbox(options = {}){
    const tasks = [];
    if (chatChannelEnabled()) {
      const params = new URLSearchParams();
      if (state.filter === 'closed') params.set('status', 'closed');
      if (state.activeId && state.activeKind === 'webchat') {
        params.set('active', state.activeId);
        if (state.cursor && !options.reset) params.set('after', state.cursor);
      }
      tasks.push(api(`/organizations/${encodeURIComponent(orgId())}/chat/inbox?${params}`).then((data) => {
        state.liveStatus = data.live_status || 'offline';
        state.features = data.features || state.features;
        state.onlineUsers = data.online_users || [];
        state.unreadTotal = Number(data.unread_total || 0);
        let conversations = data.conversations || [];
        if (state.filter === 'mine') conversations = conversations.filter((c) => c.claimed_by_user_id === userId() || (c.viewers || []).some((v) => v.user_id === userId()));
        if (state.filter === 'unclaimed') conversations = conversations.filter((c) => !c.claimed_by_user_id && !(c.viewers || []).length);
        state.conversations = conversations;
        if (data.thread && data.thread.conversation_id === state.activeId && state.detail) {
          appendThreadMessages(data.thread.messages || []);
          if (data.thread.cursor) state.cursor = data.thread.cursor;
        }
      }));
    } else {
      state.conversations = [];
    }
    if (commsChannelsEnabled()) {
      if (!state.commsSettingsLoaded) {
        state.commsSettingsLoaded = true;
        tasks.push(commsApi().settings.load(orgId()).then((data) => {
          state.commsSettings = data.settings || state.commsSettings;
        }).catch(() => {}));
      }
      tasks.push(commsApi().inbox(orgId(), {
        status: state.filter === 'closed' ? 'closed' : '',snoozed:state.filter==='snoozed'?'true':''
      }).then((data) => {
        // Web chat rows come from the richer chat inbox; comms provides the
        // email and SMS inboxes.
        state.commsRows = (Array.isArray(data.conversations) ? data.conversations : [])
          .filter((row) => ['email','sms','call'].includes(row.channel));
        state.commsLoadError='';
      }).catch((error) => {
        state.commsLoadError=error.message;
        const list=$('.fmchat-list',state.root);
        if(list&&!state.commsRows.length)list.innerHTML=`<div class="fmchat-empty">${esc(error.message)}</div>`;
      }));
    } else {
      state.commsRows = [];
    }
    await Promise.all(tasks);
    if (state.activeId && state.activeKind !== 'webchat') await syncActiveCommsDetail();
    updateHeader();
    updateList();
    updateActiveMeta();
  }

  // Merge chat + comms rows into the single channel-filtered inbox list.
  function mergedRows(){
    const rows = [];
    if (state.filter!=='snoozed'&&(state.channel === 'all' || state.channel === 'webchat')) {
      rows.push(...state.conversations.map((row) => ({ kind: 'webchat', sort: row.last_message_at || row.created_at, row })));
    }
    if (['all','email','sms','call'].includes(state.channel)) {
      const wanted = state.channel === 'all' ? ['email', 'sms','call'] : [state.channel];
      const openOnly = state.filter !== 'closed';
      rows.push(...state.commsRows
        .filter((row) => wanted.includes(row.channel))
        .filter((row) => state.filter==='mine'?row.owner_user_id===userId()&&row.status!=='closed':state.filter==='unclaimed'?!row.owner_user_id&&row.status!=='closed':(openOnly ? String(row.status || 'open') !== 'closed' : String(row.status || '') === 'closed'))
        .map((row) => ({ kind: row.channel, sort: row.last_message_at, row })));
    }
    return rows.sort((a, b) => String(b.sort || '').localeCompare(String(a.sort || '')));
  }

  async function syncActiveCommsDetail(){
    if (!state.activeId || state.activeKind === 'webchat' || !commsApi()) return;
    try {
      const data = await commsApi().conversation(orgId(), state.activeId);
      const next = data.conversation || null;
      const previousIds = JSON.stringify(((state.commsDetail || {}).messages || []).map((m) => m.id));
      const nextIds = JSON.stringify(((next || {}).messages || []).map((m) => m.id));
      if (previousIds !== nextIds || !state.commsDetail) {
        state.commsDetail = next;
        renderCommsMessages();
      } else {
        state.commsDetail = next;
      }
    } catch (_) {}
  }

  function appendThreadMessages(messages){
    if (!state.detail) return;
    let appended = false;
    let receivedVisitorMessage = false;
    for (const message of messages) {
      if (state.detail.messages.some((item) => item.id === message.id)) continue;
      state.detail.messages.push(message);
      appended = true;
      if (message.direction === 'inbound' && !message.internal) receivedVisitorMessage = true;
    }
    if (appended) {
      renderMessages();
      if (receivedVisitorMessage) maybeAutoSuggest();
    }
  }

  async function openConversation(id, options = {}){
    // Email/SMS conversations (from the comms inbox) open through their own
    // renderer; web chats keep the full original path below.
    const commsRow = state.commsRows.find((row) => String(row.id) === String(id));
    if(commsRow?.channel==='call')return window.Portal.CustomerPhone.open({call_id:id});
    if (commsRow || options.kind === 'email' || options.kind === 'sms') {
      return openCommsConversation(id, commsRow ? commsRow.channel : options.kind, options);
    }
    state.activeKind = 'webchat';
    state.commsDetail = null;
    state.activeId = id;
    state.suggestion = null;
    state.suggestionError = '';
    state.detail = null;
    state.cursor = '';
    state.renderedMessageIds = new Set();
    updateList();
    renderThreadShell();
    try {
      const data = await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(id)}`);
      state.detail = data;
      state.cursor = data.cursor || '';
      renderThreadShell();
      renderMessages(true);
      renderContext();
      const row = state.conversations.find((c) => c.id === id);
      if (row) { row.unread_count = 0; row.waiting_since = null; updateList(); }
      maybeAutoSuggest();
    } catch (error) {
      Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_6ee294b459127f","Chat") ?? "Chat"), error.message, false);
    }
    if (!options.fromRoute) syncRoute('push');
  }

  function closeThread(options={}){
    state.activeId = '';
    state.detail = null;
    state.commsDetail = null;
    state.activeKind = 'webchat';
    state.suggestion = null;
    state.suggestionError = '';
    state.renderedMessageIds = new Set();
    renderThreadShell();
    renderContext();
    updateList();
    if(!options.fromRoute)Portal.navigation?.backOrClose?.(['chatConversation'],{chatConversation:null});
  }

  // --- Email / SMS conversations (global comms) ----------------------------

  async function openCommsConversation(id, kind, options = {}){
    state.activeKind = kind === 'sms' ? 'sms' : 'email';
    state.activeId = id;
    state.detail = null;
    state.commsDetail = null;
    state.suggestion = null;
    state.suggestionError = '';
    updateList();
    renderThreadShell();
    try {
      const data = await commsApi().conversation(orgId(), id);
      state.commsDetail = data.conversation || null;
      await commsApi().customer(orgId(),'conversation-workflow',{kind:'conversation',source_id:id,revision:Number(state.commsDetail?.revision||0),action:'read'});
      const readRow=state.commsRows.find(row=>row.id===id);if(readRow)readRow.unread_count=0;
      if (state.commsDetail && !state.commsDetail.project_title) {
        const row = state.commsRows.find((entry) => String(entry.id) === String(id));
        state.commsDetail.project_title = row?.project_title || '';
        state.commsDetail.contact_name = state.commsDetail.contact_name || row?.contact_name || '';
      }
      renderThreadShell();
      renderContext();
    } catch (error) {
      Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_643fa01aa77d59","Communications") ?? "Communications"), error.message, false);
    }
    if (!options.fromRoute) syncRoute('push');
  }

  function voiceKey(kind = state.activeKind){ return `${kind}:${state.activeId}`; }
  function voiceMode(kind = state.activeKind){
    if (kind === 'webchat') return String(state.features.voice?.mode || 'attachment');
    return String(state.commsSettings?.voice?.[kind] || (kind === 'email' ? 'dictation' : 'attachment'));
  }
  function voiceLabel(mode){ return mode === 'dictation' ? 'Dictation' : 'Attach audio'; }
  function audioHtml(message){
    const note = message?.metadata?.audio_note;
    const url = String(note?.public_url || note?.url || '');
    if (!note || !url || !window.FirstMateAudioNotes) return '';
    return `<div class="fmchat-msg-audio">${window.FirstMateAudioNotes.playerHtml({ url, duration:note.duration_seconds, peaks:note.peaks })}</div>`;
  }

  function pageContextHtml(message){
    const page = message?.metadata?.page_context;
    if (!page || message.direction !== 'inbound') return '';
    const title = String(page.tab_label || page.title || (globalThis.PlatformLanguage?.text("chat","m_7fa0f26d9ba1c4","Website page") ?? "Website page"));
    const lines = (Array.isArray(page.visible_text) ? page.visible_text : []).slice(0, 6);
    const snapshotUrl = String(page.snapshot?.public_url || '');
    return `<div class="fmchat-page-context" title="${(globalThis.PlatformLanguage?.text("chat","m_26a1344cd9d9e0","Captured when this message was sent") ?? "Captured when this message was sent")}">
      <div class="fmchat-page-context-head"><i class="fas fa-window-maximize"></i><span><small>${(globalThis.PlatformLanguage?.text("chat","m_4d70bd8d225412","Customer was viewing") ?? "Customer was viewing")}</small><strong>${String(esc(title))}</strong></span></div>
      ${String(snapshotUrl ? `<a class="fmchat-page-shot" href="${esc(snapshotUrl)}" target="_blank" rel="noopener" title="Open the full page snapshot"><img src="${esc(snapshotUrl)}" alt="Snapshot of the ${esc(title)} page" loading="lazy"></a>` : '')}
      <div class="fmchat-page-preview">${String(lines.length ? lines.map((line, index) => `<div class="fmchat-page-line ${index === 0 ? 'title' : ''}" title="${esc(line)}">${esc(line)}</div>`).join('') : '<div class="fmchat-page-line placeholder"></div><div class="fmchat-page-line placeholder"></div><div class="fmchat-page-line placeholder"></div>')}</div>
    </div>`;
  }

  function restoreVoice(col, kind){
    const prepared = state.pendingVoice.get(voiceKey(kind));
    const mount = col.querySelector('[data-voice-mount]');
    if (!prepared?.attachment || !mount) return;
    window.FirstMateAudioNotes?.mountPrepared?.(mount, {
      url:prepared.attachment.public_url || prepared.attachment.url,
      duration:prepared.metadata?.duration_seconds,
      peaks:prepared.metadata?.peaks,
      onRemove:() => state.pendingVoice.delete(voiceKey(kind))
    });
  }

  async function startVoice(kind, col){
    const library = window.FirstMateAudioNotes;
    const mount = col.querySelector('[data-voice-mount]');
    const input = col.querySelector('.fmchat-input');
    const mode = voiceMode(kind);
    if (!library || !mount || !input || mode === 'off') return;
    col.querySelector('[data-voice]')?.setAttribute('disabled', '');
    try {
      const prepared = await library.prepareInline(orgId(), '', {
        mount,
        mode,
        maxSeconds:kind === 'sms' ? 30 : Number(state.features.voice?.max_seconds || 120),
        ...(kind === 'sms' && mode === 'attachment' ? { format:'wav', sampleRate:8000 } : {}),
        onRemove:() => state.pendingVoice.delete(voiceKey(kind))
      });
      input.value = [String(input.value || '').trim(), prepared.text].filter(Boolean).join(' ');
      state.drafts.set(state.activeId, input.value);
      autosize(input);
      if (prepared.attachment) state.pendingVoice.set(voiceKey(kind), prepared);
      input.focus();
    } catch (error) {
      if (!/cancelled/i.test(String(error?.message || ''))) Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_0507ee9d98173f","Voice message") ?? "Voice message"), error.message, false);
    } finally {
      col.querySelector('[data-voice]')?.removeAttribute('disabled');
    }
  }

  function commsMessageWho(message){
    const sender = message.sender || {};
    if (message.direction === 'inbound') return sender.name || sender.address || 'Customer';
    if (message.source_kind === 'ai') return 'AI agent';
    if (message.source_kind === 'automation') return 'Automation';
    return sender.name || 'You';
  }

  function renderCommsMessages(){
    const mount = $('.fmchat-msgs', state.root);
    if (!mount || !state.commsDetail) return;
    const messages = state.commsDetail.messages || [];
    const parts = [];
    let lastDay = '';
    for (const message of messages) {
      const day = dayLabel(message.created_at);
      if (day !== lastDay) { parts.push(`<div class="fmchat-day">${esc(day)}</div>`); lastDay = day; }
      const inbound = message.direction === 'inbound';
      const ai = message.source_kind === 'ai';
      parts.push(`<div class="fmchat-msg ${inbound ? 'inbound' : `outbound ${ai ? 'ai' : ''}`}">${message.subject && inbound ? `<strong>${esc(message.subject)}</strong><br>` : ''}${esc(message.text || '')}${audioHtml(message)}</div>`);
      parts.push(`<div class="fmchat-msg-meta ${inbound ? 'inbound' : 'outbound'}">${esc(commsMessageWho(message))} • ${clock(message.created_at)}${message.test_mode ? (" • <i class=\"fas fa-flask\" title=\"" + (globalThis.PlatformLanguage?.text("chat","m_4ee0964bb70748","Test mode") ?? "Test mode") + "\"></i>") : ''}</div>`);
    }
    const renderKey = JSON.stringify(messages.map((message) => message.id));
    if (mount.dataset.renderKey === renderKey) return;
    const nearBottom = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 80;
    mount.innerHTML = parts.join('') || `<div class="fmchat-empty">${(globalThis.PlatformLanguage?.text("chat","m_f6fa564d97e598","No messages yet.") ?? "No messages yet.")}</div>`;
    window.FirstMateAudioNotes?.hydrate?.(mount);
    mount.dataset.renderKey = renderKey;
    if (nearBottom || !mount.dataset.scrolled) {
      mount.scrollTop = mount.scrollHeight;
      mount.dataset.scrolled = '1';
    }
  }

  function mobileBack(col){
    if(col.querySelector('[data-inbox-back]'))return;
    const button=document.createElement('button');button.type='button';button.className='fmchat-btn fmchat-mobile-back';button.dataset.inboxBack='';button.textContent=(globalThis.PlatformLanguage?.text("chat","m_bf05d8a430dec7","← All conversations") ?? "← All conversations");button.onclick=()=>closeThread();col.prepend(button);
  }
  function renderCommsThread(col){
    const detail = state.commsDetail;
    const kind = state.activeKind;
    if (!detail) {
      col.innerHTML = `<div class="fmchat-blank"><div class="fmchat-blank-inner"><i class="fas fa-spinner fa-spin"></i><p>${(globalThis.PlatformLanguage?.text("chat","m_d2da77452877dd","Loading…") ?? "Loading…")}</p></div></div>`;
      return;
    }
    const closed = String(detail.status || 'open') === 'closed';
    const snoozed=detail.snoozed_until&&Date.parse(detail.snoozed_until)>Date.now();
    const icon = kind === 'sms' ? 'fa-comment-sms' : 'fa-envelope';
    const title = kind === 'sms'
      ? (detail.project_title || 'Text conversation')
      : (detail.subject || '(no subject)');
    const projectId = String(detail.project_id || '');
    const mode = voiceMode(kind);
    col.innerHTML = `
      <div class="fmchat-thread-head">
        <div style="min-width:0">
          <div class="fmchat-thread-title"><i class="fas ${icon}" style="color:#667085"></i> ${esc(title)}</div>
          <div class="fmchat-thread-sub">${kind === 'sms' ? 'Text message thread' : 'Email thread'}${detail.project_title ? ` • ${esc(detail.project_title)}` : ''}</div>
          ${snoozed?`<div class="fmchat-thread-sub">${((v0) => globalThis.PlatformLanguage?.text("chat","m_35e8ee692d0494",`Snoozed until ${v0}`,{v0}) ?? `Snoozed until ${v0}`)(esc(new Date(detail.snoozed_until).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())))}</div>`:''}
        </div>
        <div class="fmchat-thread-actions">
          <button type="button" class="fmchat-btn" data-comms-workflow="assign">${detail.owner_user_id===userId()?'Unassign':'Assign to me'}</button>
          <button type="button" class="fmchat-btn" data-comms-workflow="${closed?'reopen':'resolve'}">${closed?'Reopen':'Resolve'}</button>
          <button type="button" class="fmchat-btn" data-comms-workflow="${snoozed?'unsnooze':'snooze'}" aria-label="${snoozed?'Return to inbox':'Snooze conversation'}"><i class="fas fa-clock"></i>${snoozed?' Return to inbox':''}</button>
          ${projectId?`<button type="button" class="fmchat-btn" data-comms-call><i class="fas fa-phone"></i>${(globalThis.PlatformLanguage?.text("chat","m_34ac7f9c427ea4"," Call") ?? " Call")}</button>`:''}
          ${projectId ? `<button type="button" class="fmchat-btn" data-open-project="${String(esc(projectId))}"><i class="fas fa-folder-open"></i>${(globalThis.PlatformLanguage?.text("chat","m_53787840db7d1c"," Open project") ?? " Open project")}</button>` : ''}
        </div>
      </div>
      <div class="fmchat-msgs"></div>
      ${closed ? `<div class="fmchat-composer-wrap" style="text-align:center;color:#98a2b3;font-size:12.5px;font-weight:700">${(globalThis.PlatformLanguage?.text("chat","m_e366f94f041c75","This conversation is closed.") ?? "This conversation is closed.")}</div>` : `
      <div class="fmchat-composer-wrap">
        <div class="fmchat-composer">
          <textarea class="fmchat-input" rows="1" spellcheck="true" placeholder="${String(kind === 'sms' ? 'Text the customer…' : 'Reply — sends as email…')}"></textarea>
          <div class="fmchat-composer-side">
            ${String(mode !== 'off' ? `<button type="button" class="fmchat-icon-btn voice" data-voice title="${voiceLabel(mode)}" aria-label="${voiceLabel(mode)}"><i class="fas fa-microphone"></i><small>${mode === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
            <button type="button" class="fmchat-icon-btn send" data-comms-send title="${(globalThis.PlatformLanguage?.text("chat","m_c23a056552a09f","Send") ?? "Send")}" aria-label="${(globalThis.PlatformLanguage?.text("chat","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
        <div class="fmchat-voice-mount" data-voice-mount></div>
        <div class="fmchat-composer-hints"><span>${String(kind === 'sms' ? 'Sends from your business number' : 'Replies thread automatically')}</span>${String(mode !== 'off' ? `<span class="fmchat-voice-mode"><i class="fas ${mode === 'dictation' ? 'fa-quote-left' : 'fa-paperclip'}"></i>${voiceLabel(mode)}</span>` : '<span></span>')}</div>
      </div>`}
    `;
    col.querySelector('[data-open-project]')?.addEventListener('click', () => {
      window.FirstMateAgentChat?.runAction?.({ kind: 'project', project_id: projectId });
    });
    col.querySelector('[data-comms-call]')?.addEventListener('click',()=>window.Portal.CustomerPhone.open({project_id:projectId}));
    col.querySelectorAll('[data-comms-workflow]').forEach(button=>button.addEventListener('click',async()=>{
      const action=button.dataset.commsWorkflow;
      const apply=async(extra={})=>{await commsApi().customer(orgId(),'conversation-workflow',{kind:'conversation',source_id:state.activeId,revision:Number(detail.revision||0),action,...extra});
        const result=await commsApi().conversation(orgId(),state.activeId);state.commsDetail=result.conversation;renderCommsThread(col);await loadInbox();};
      try{if(action==='snooze'){window.Portal.CommunicationsUI.dialog('Snooze conversation',window.Portal.CommunicationsUI.field('Until (your local time)','until','','datetime-local','required'),async data=>apply({snoozed_until:new Date(data.until).toISOString()}));}
        else await apply(action==='assign'?{owner_user_id:detail.owner_user_id===userId()?'':userId()}:{});
      }catch(error){Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_4cd5e2d9c65130","Conversation") ?? "Conversation"),error.message,false);}
    }));
    const input = $('.fmchat-input', col);
    if (input) {
      input.value = state.drafts.get(state.activeId) || '';
      autosize(input);
      input.addEventListener('input', () => { state.drafts.set(state.activeId, input.value); autosize(input); });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCommsReply(); }
      });
    }
    col.querySelector('[data-comms-send]')?.addEventListener('click', () => sendCommsReply());
    col.querySelector('[data-voice]')?.addEventListener('click', () => startVoice(kind, col));
    restoreVoice(col, kind);
    mobileBack(col);
    renderCommsMessages();
  }

  async function sendCommsReply(){
    if (state.commsSending || !state.activeId || state.activeKind === 'webchat') return;
    const col = $('.fmchat-thread-col', state.root);
    const input = $('.fmchat-input', col);
    const text = String(input?.value || '').trim();
    if (!text) return;
    state.commsSending = true;
    const button = col.querySelector('[data-comms-send]');
    if (button) button.disabled = true;
    try {
      const voice = state.pendingVoice.get(voiceKey());
      await commsApi().reply(orgId(), state.activeId, {
        message: text,
        ...(voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {})
      });
      if (input) { input.value = ''; autosize(input); }
      state.drafts.delete(state.activeId);
      state.pendingVoice.delete(voiceKey());
      await syncActiveCommsDetail();
    } catch (error) {
      Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1eff5022ac4ad5","Message not sent") ?? "Message not sent"), error.message, false);
    } finally {
      state.commsSending = false;
      if (button) button.disabled = false;
    }
  }

  // --- Header / list ------------------------------------------------------

  function updateHeader(){
    const live = $('.fmchat-live', state.root);
    if (!live) return;
    live.classList.toggle('online', state.liveStatus === 'online');
    live.hidden = !chatChannelEnabled();
    live.querySelector('span').textContent = state.liveStatus === 'online' ? 'Web chat available' : 'Web chat offline';
  }

  function coordinationTags(row){
    const tags = [];
    if (row.visitor_typing) tags.push(`<span class="fmchat-tag typing">${(globalThis.PlatformLanguage?.text("chat","m_8a600d365c1990","typing…") ?? "typing…")}</span>`);
    if (row.handling_mode === 'ai' && row.ai_status === 'active') tags.push(`<span class="fmchat-tag ai"><i class="fas fa-robot"></i>${(globalThis.PlatformLanguage?.text("chat","m_bdd20e2c55aa69"," AI handling") ?? " AI handling")}</span>`);
    if (row.claimed_by_user_id) {
      tags.push(row.claimed_by_user_id === userId()
        ? `<span class="fmchat-tag mine">${(globalThis.PlatformLanguage?.text("chat","m_5f0c5d79658b50","You") ?? "You")}</span>`
        : `<span class="fmchat-tag claim">${esc(firstName(viewerName(row.claimed_by_user_id, row)) || 'Claimed')}</span>`);
    }
    const others = (row.viewers || []).filter((viewer) => viewer.user_id !== userId() && viewer.user_id !== row.claimed_by_user_id);
    if (others.length) tags.push(`<span class="fmchat-tag view"><i class="fas fa-eye"></i> ${esc(firstName(others[0].user_name) || 'Viewing')}${others.length > 1 ? ` +${others.length - 1}` : ''}</span>`);
    if (row.waiting_since && row.status === 'open') {
      const seconds = (Date.now() - new Date(row.waiting_since).getTime()) / 1000;
      tags.push(`<span class="fmchat-tag wait ${seconds > 180 ? 'hot' : ''}"><i class="fas fa-clock"></i> ${esc(timeAgo(row.waiting_since))}</span>`);
    }
    return tags.join('');
  }

  function viewerName(id, row){
    const fromViewers = (row.viewers || []).find((viewer) => viewer.user_id === id);
    if (fromViewers) return fromViewers.user_name;
    const online = state.onlineUsers.find((user) => user.user_id === id);
    return online ? online.user_name : '';
  }

  function chatRowHtml(row){
    const unread = Number(row.unread_count || 0);
    const preview = row.last_message ? `${row.last_message.direction === 'outbound' ? `${esc(firstName(row.last_message.sender?.name) || 'You')}: ` : ''}${esc(row.last_message.text)}` : 'New conversation';
    return `<button type="button" class="fmchat-row ${row.id === state.activeId ? 'active' : ''} ${unread ? 'unread' : ''}" data-conversation="${esc(row.id)}">
      <div class="fmchat-row-top">
        <span class="fmchat-row-name">${state.channel === 'all' ? '<span class="fmchat-row-channel"><i class="fas fa-message"></i></span>' : ''}${row.visitor?.online ? ("<span class=\"fmchat-online-dot\" title=\"" + (globalThis.PlatformLanguage?.text("chat","m_aabde4e0c8a505","Visitor is on the page") ?? "Visitor is on the page") + "\"></span>") : ''}<span>${esc(row.visitor?.name || 'Website visitor')}</span></span>
        <span class="fmchat-row-time">${esc(timeAgo(row.last_message_at || row.created_at))}</span>
      </div>
      <span class="fmchat-row-preview">${preview}</span>
      <span class="fmchat-tags">${coordinationTags(row)}</span>
      ${unread ? `<span class="fmchat-unread-dot">${unread > 9 ? '9+' : unread}</span>` : ''}
    </button>`;
  }

  function commsRowHtml(row){
    const icon = row.channel === 'call' ? 'fa-phone' : row.channel === 'sms' ? 'fa-comment-sms' : 'fa-envelope';
    const name = row.contact_name || row.project_title || (row.channel === 'sms' ? 'Text conversation' : 'Email');
    const preview = row.channel === 'email'
      ? (row.subject || (row.last_message ? row.last_message.text : '') || '(no subject)')
      : (row.last_message ? row.last_message.text : 'No messages yet');
    return `<button type="button" class="fmchat-row ${row.id === state.activeId ? 'active' : ''} ${row.unread_count?'unread':''}" data-conversation="${esc(row.id)}">
      <div class="fmchat-row-top">
        <span class="fmchat-row-name"><span class="fmchat-row-channel"><i class="fas ${icon}"></i></span><span>${esc(name)}</span></span>
        <span class="fmchat-row-time">${esc(timeAgo(row.last_message_at))}</span>
      </div>
      <span class="fmchat-row-preview">${esc(String(preview || '').replace(/\s+/g, ' '))}</span>
      ${row.project_title && row.contact_name ? `<span class="fmchat-row-project">${esc(row.project_title)}</span>` : ''}
      ${row.unread_count?("<span class=\"fmchat-unread-dot\" aria-label=\"" + (globalThis.PlatformLanguage?.text("chat","m_e6bd48170f22a4","Unread") ?? "Unread") + "\">1</span>"):''}
    </button>`;
  }

  function updateList(){
    const list = $('.fmchat-list', state.root);
    if (!list) return;
    const rows = mergedRows();
    if (!rows.length) {
      if(state.commsLoadError){list.innerHTML=`<div class="fmchat-empty" role="alert">${esc(state.commsLoadError)}</div>`;return;}
      list.innerHTML = `<div class="fmchat-empty"><i class="fas fa-comments" style="font-size:26px;display:block;margin-bottom:8px;opacity:.4"></i>${state.filter === 'open' ? 'No open conversations.<br>New chats, emails, texts, and calls appear here.' : 'Nothing here.'}</div>`;
      return;
    }
    list.innerHTML = rows.map((entry) => entry.kind === 'webchat' ? chatRowHtml(entry.row) : commsRowHtml(entry.row)).join('');
    $$('[data-conversation]', list).forEach((el) => el.addEventListener('click', () => openConversation(el.dataset.conversation)));
  }

  // --- Thread -------------------------------------------------------------

  function activeRow(){
    return state.conversations.find((row) => row.id === state.activeId);
  }

  function renderThreadShell(){
    $('.fmchat-shell',state.root)?.classList.toggle('list-mode',!state.activeId);
    const col = $('.fmchat-thread-col', state.root);
    if (!col) return;
    if (!state.activeId) {
      col.innerHTML = `<div class="fmchat-blank"><div class="fmchat-blank-inner"><i class="fas fa-comment-dots"></i><p>${(globalThis.PlatformLanguage?.text("chat","m_a7155791df97c9","Select a conversation") ?? "Select a conversation")}</p></div></div>`;
      return;
    }
    if (state.activeKind !== 'webchat') {
      renderCommsThread(col);
      return;
    }
    if (!state.detail) {
      col.innerHTML = `<div class="fmchat-blank"><div class="fmchat-blank-inner"><i class="fas fa-spinner fa-spin"></i><p>${(globalThis.PlatformLanguage?.text("chat","m_d2da77452877dd","Loading…") ?? "Loading…")}</p></div></div>`;
      return;
    }
    const detail = state.detail;
    const conversationState = detail.state || {};
    const visitor = detail.visitor || {};
    const closed = detail.conversation.status === 'closed';
    const claimedByOther = conversationState.claimed_by_user_id && conversationState.claimed_by_user_id !== userId();
    const claimMode = state.features.claiming_mode === 'claim';
    const aiActive = conversationState.handling_mode === 'ai' && conversationState.ai_status === 'active';

    let banner = '';
    if (aiActive) {
      banner = `<div class="fmchat-banner ai"><span><i class="fas fa-robot"></i>${(globalThis.PlatformLanguage?.text("chat","m_30f9b69013e0c5"," The AI agent is handling this conversation.") ?? " The AI agent is handling this conversation.")}</span><button type="button" class="fmchat-btn" data-take-over-ai>${(globalThis.PlatformLanguage?.text("chat","m_640932b8f828d0","Take over") ?? "Take over")}</button></div>`;
    } else if (claimedByOther) {
      const name = firstName(viewerName(conversationState.claimed_by_user_id, activeRow() || { viewers: detail.viewers })) || 'a teammate';
      banner = `<div class="fmchat-banner claim"><span><i class="fas fa-lock"></i>${((v0) => globalThis.PlatformLanguage?.text("chat","m_cbc9260e706307",` Claimed by ${v0}.`,{v0}) ?? ` Claimed by ${v0}.`)(esc(name))}</span><button type="button" class="fmchat-btn" data-claim>${(globalThis.PlatformLanguage?.text("chat","m_640932b8f828d0","Take over") ?? "Take over")}</button></div>`;
    }

    col.innerHTML = `
      <div class="fmchat-thread-head">
        <div style="min-width:0">
          <div class="fmchat-thread-title">${visitor.name ? esc(visitor.name) : 'Website visitor'}${conversationState.visitor_online ? (" <span class=\"fmchat-online-dot\" title=\"" + (globalThis.PlatformLanguage?.text("chat","m_37ce02d8babddc","On the page now") ?? "On the page now") + "\"></span>") : ''}</div>
          <div class="fmchat-thread-sub">${esc(conversationState.source === 'portal' ? 'Customer portal' : (conversationState.origin_url || 'Website'))}</div>
        </div>
        <div class="fmchat-thread-actions">
          ${!closed && claimMode && !conversationState.claimed_by_user_id ? `<button type="button" class="fmchat-btn" data-claim><i class="fas fa-hand"></i>${(globalThis.PlatformLanguage?.text("chat","m_37d72291d3fdcc"," Claim") ?? " Claim")}</button>` : ''}
          ${!closed && conversationState.claimed_by_user_id === userId() ? `<button type="button" class="fmchat-btn" data-release>${(globalThis.PlatformLanguage?.text("chat","m_63e61106b0e642","Release") ?? "Release")}</button>` : ''}
          ${!closed ? `<button type="button" class="fmchat-btn" data-close-chat>${(globalThis.PlatformLanguage?.text("chat","m_76901f41f6f55b","End chat") ?? "End chat")}</button>` : ''}
        </div>
      </div>
      ${banner}
      <div class="fmchat-msgs"></div>
      ${closed ? `<div class="fmchat-composer-wrap" style="text-align:center;color:#98a2b3;font-size:12.5px;font-weight:700">${(globalThis.PlatformLanguage?.text("chat","m_52ad0207a8dd5a","This conversation has ended.") ?? "This conversation has ended.")}</div>` : `
      <div class="fmchat-composer-wrap">
        <div class="fmchat-suggestion" data-suggestion hidden>
          <span class="fmchat-suggestion-label"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.text("chat","m_fa9969045dbe0d"," Suggested reply") ?? " Suggested reply")}</span>
          <div class="fmchat-suggestion-text" data-suggestion-text></div>
          <div class="fmchat-suggestion-actions">
            <button type="button" class="fmchat-btn primary" data-suggestion-insert>${(globalThis.PlatformLanguage?.text("chat","m_bb8244ba61e6b9","Insert &amp; edit") ?? "Insert &amp; edit")}</button>
          </div>
          <button type="button" class="fmchat-suggestion-dismiss" data-suggestion-dismiss aria-label="${(globalThis.PlatformLanguage?.text("chat","m_cc02393042526a","Dismiss suggested reply") ?? "Dismiss suggested reply")}" title="${(globalThis.PlatformLanguage?.text("chat","m_cc02393042526a","Dismiss suggested reply") ?? "Dismiss suggested reply")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="fmchat-composer-toolbar">
          ${String(state.features.suggestions ? `<button type="button" class="fmchat-tool-btn" data-suggest><i class="fas fa-wand-magic-sparkles"></i> Suggest reply</button>` : '')}
          ${String(state.features.suggestions ? `<button type="button" class="fmchat-tool-btn" data-polish><i class="fas fa-spell-check"></i> Polish draft</button>` : '')}
          <button type="button" class="fmchat-tool-btn" data-internal><i class="fas fa-note-sticky"></i>${(globalThis.PlatformLanguage?.text("chat","m_00e05ce1c1d4e7"," Internal note") ?? " Internal note")}</button>
        </div>
        <div class="fmchat-composer">
          <textarea class="fmchat-input" rows="1" spellcheck="true" placeholder="${((v2) => globalThis.PlatformLanguage?.text("chat","m_9b4bc7a1e8b34f",`Reply to ${v2}…`,{v2}) ?? `Reply to ${v2}…`)(esc(firstName(visitor.name) || 'the visitor'))}"></textarea>
          <div class="fmchat-composer-side">
            ${String(voiceMode('webchat') !== 'off' ? `<button type="button" class="fmchat-icon-btn voice" data-voice title="${voiceLabel(voiceMode('webchat'))}" aria-label="${voiceLabel(voiceMode('webchat'))}"><i class="fas fa-microphone"></i><small>${voiceMode('webchat') === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
            <button type="button" class="fmchat-icon-btn send" data-send title="${(globalThis.PlatformLanguage?.text("chat","m_5ffd34ad8437cd","Send reply") ?? "Send reply")}" aria-label="${(globalThis.PlatformLanguage?.text("chat","m_5ffd34ad8437cd","Send reply") ?? "Send reply")}"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
        <div class="fmchat-voice-mount" data-voice-mount></div>
        <div class="fmchat-composer-hints"><span data-hint>${(globalThis.PlatformLanguage?.text("chat","m_c2996b3077a4f1","Enter to send • Shift+Enter for a new line") ?? "Enter to send • Shift+Enter for a new line")}</span><span data-typing-hint></span></div>
      </div>`}
    `;
    wireThread(col, closed);
    mobileBack(col);
    renderMessages(true);
  }

  function wireThread(col, closed){
    $('[data-close-chat]', col)?.addEventListener('click', async () => {
      try { await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/close`, { method: 'POST', body: '{}' }); await refreshDetail(); } catch (error) { Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_6ee294b459127f","Chat") ?? "Chat"), error.message, false); }
    });
    $$('[data-claim]', col).forEach((el) => el.addEventListener('click', async () => {
      try { await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/claim`, { method: 'POST', body: '{}' }); await refreshDetail(); } catch (error) { Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_6ee294b459127f","Chat") ?? "Chat"), error.message, false); }
    }));
    $('[data-release]', col)?.addEventListener('click', async () => {
      try { await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/release`, { method: 'POST', body: '{}' }); await refreshDetail(); } catch (error) { Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_6ee294b459127f","Chat") ?? "Chat"), error.message, false); }
    });
    $('[data-take-over-ai]', col)?.addEventListener('click', async () => {
      try { await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/ai`, { method: 'POST', body: JSON.stringify({ active: false }) }); await refreshDetail(); } catch (error) { Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_6ee294b459127f","Chat") ?? "Chat"), error.message, false); }
    });
    if (closed) return;

    const input = $('.fmchat-input', col);
    input.value = state.drafts.get(state.activeId) || '';
    const suggestionDraft = state.suggestionDrafts.get(state.activeId);
    if (suggestionDraft) input.dataset.suggestionId = suggestionDraft.id;
    autosize(input);
    input.addEventListener('input', () => {
      state.drafts.set(state.activeId, input.value);
      autosize(input);
      sendTypingSignal();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
    });
    $('[data-send]', col)?.addEventListener('click', () => sendMessage());
    $('[data-voice]', col)?.addEventListener('click', () => startVoice('webchat', col));
    restoreVoice(col, 'webchat');
    $('[data-internal]', col)?.addEventListener('click', (event) => {
      const btn = event.currentTarget;
      btn.classList.toggle('active');
      input.classList.toggle('internal-mode', btn.classList.contains('active'));
      input.placeholder = btn.classList.contains('active') ? 'Internal note — the visitor will not see this…' : 'Reply…';
      $('[data-hint]', col).textContent = btn.classList.contains('active') ? 'Internal note mode — visible to your team only' : 'Enter to send • Shift+Enter for a new line';
      input.focus();
    });
    $('[data-suggest]', col)?.addEventListener('click', () => requestSuggestion());
    $('[data-polish]', col)?.addEventListener('click', () => polishDraft());
    $('[data-suggestion-insert]', col)?.addEventListener('click', () => {
      if (!String(state.suggestion?.text || '').trim()) return;
      input.value = state.suggestion.text;
      state.drafts.set(state.activeId, input.value);
      input.dataset.suggestionId = state.suggestion.id;
      state.suggestionDrafts.set(state.activeId, { id: state.suggestion.id, text: state.suggestion.text });
      autosize(input);
      dismissSuggestion();
      input.focus();
    });
    $('[data-suggestion-dismiss]', col)?.addEventListener('click', () => dismissSuggestion());
    if (state.suggesting) showSuggestionLoading();
    else if (String(state.suggestion?.text || '').trim()) showSuggestion(state.suggestion.text);
    else if (state.suggestionError) showSuggestionError(state.suggestionError);
  }

  function autosize(input){
    input.style.height = 'auto';
    input.style.height = `${Math.min(130, input.scrollHeight)}px`;
  }

  function renderMessages(scroll){
    const mount = $('.fmchat-msgs', state.root);
    if (!mount || !state.detail) return;
    const parts = [];
    const messageIds = new Set();
    const animateNew = state.renderedMessageIds.size > 0;
    let lastDay = '';
    for (const message of state.detail.messages) {
      const messageId = String(message.id || '');
      if (messageId) messageIds.add(messageId);
      const day = dayLabel(message.created_at);
      if (day !== lastDay) { parts.push(`<div class="fmchat-day">${esc(day)}</div>`); lastDay = day; }
      const inbound = message.direction === 'inbound';
      const ai = message.sender?.kind === 'ai_agent';
      const cls = message.internal ? 'internal' : inbound ? 'inbound' : `outbound ${ai ? 'ai' : ''}`;
      const isNew = animateNew && messageId && !state.renderedMessageIds.has(messageId);
      parts.push(`<div class="fmchat-msg ${cls} ${message.pending ? 'pending' : ''} ${isNew ? 'is-new' : ''}">${esc(message.text)}${audioHtml(message)}</div>${pageContextHtml(message)}`);
      const who = message.internal
        ? `${esc(firstName(message.sender?.name) || 'Note')} • team only`
        : inbound ? clock(message.created_at)
        : `${ai ? 'AI Agent' : esc(firstName(message.sender?.name) || 'You')} • ${clock(message.created_at)}${message.metadata?.ai?.suggested ? (" • <i class=\"fas fa-wand-magic-sparkles\" title=\"" + (globalThis.PlatformLanguage?.text("chat","m_dc59be3991c5f8","AI-suggested") ?? "AI-suggested") + "\"></i>") : ''}`;
      parts.push(`<div class="fmchat-msg-meta ${inbound ? 'inbound' : 'outbound'}">${who}</div>`);
    }
    const row = activeRow();
    const visitorTyping = Boolean(row?.visitor_typing || state.detail.state?.visitor_typing);
    if (visitorTyping) parts.push('<div class="fmchat-typing-row"><i></i><i></i><i></i></div>');
    const renderKey = JSON.stringify({
      messages: state.detail.messages.map((message) => [message.id, message.text, message.pending, message.internal]),
      visitorTyping
    });
    if (mount.dataset.renderKey === renderKey) return;
    const nearBottom = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 80;
    const previousScrollTop = mount.scrollTop;
    mount.innerHTML = parts.join('');
    window.FirstMateAudioNotes?.hydrate?.(mount);
    mount.dataset.renderKey = renderKey;
    state.renderedMessageIds = messageIds;
    if (scroll !== false || nearBottom) mount.scrollTop = mount.scrollHeight;
    else mount.scrollTop = previousScrollTop;
  }

  async function refreshDetail(){
    if (!state.activeId) return;
    const data = await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}`);
    state.detail = data;
    state.cursor = data.cursor || '';
    renderThreadShell();
    renderContext();
  }

  function updateActiveMeta(){
    // Lightweight per-poll refresh of typing indicator + banner-worthy state.
    if (state.activeKind !== 'webchat') return;
    if (!state.activeId || !state.detail) return;
    const row = activeRow();
    if (!row) return;
    const stateChanged = (row.claimed_by_user_id || '') !== (state.detail.state?.claimed_by_user_id || '')
      || (row.handling_mode === 'ai' && row.ai_status === 'active') !== (state.detail.state?.handling_mode === 'ai' && state.detail.state?.ai_status === 'active')
      || (row.status === 'closed') !== (state.detail.conversation?.status === 'closed');
    if (stateChanged) { refreshDetail().catch(() => {}); return; }
    state.detail.state = { ...(state.detail.state || {}), visitor_typing: Boolean(row.visitor_typing) };
    renderMessages(false);
  }

  async function sendMessage(){
    if (state.sending || !state.activeId) return;
    const col = $('.fmchat-thread-col', state.root);
    const input = $('.fmchat-input', col);
    const text = String(input?.value || '').trim();
    if (!text) return;
    const internal = $('[data-internal]', col)?.classList.contains('active');
    const suggestionDraft = state.suggestionDrafts.get(state.activeId);
    const suggestionId = input.dataset.suggestionId || suggestionDraft?.id || '';
    const suggestionEdited = Boolean(suggestionId && suggestionDraft && text !== suggestionDraft.text);
    const voice = state.pendingVoice.get(voiceKey('webchat'));
    state.sending = true;
    input.value = '';
    delete input.dataset.suggestionId;
    state.drafts.delete(state.activeId);
    autosize(input);
    const pending = { id: `pending_${Date.now()}`, direction: 'outbound', text, internal, sender: { kind: 'user', name: 'You' }, created_at: new Date().toISOString(), pending: true };
    state.detail.messages.push(pending);
    renderMessages();
    try {
      const data = await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          internal_note: Boolean(internal),
          ...(voice?.attachment ? { metadata:{ audio_note:{ ...voice.metadata, ...voice.attachment } } } : {}),
          ...(suggestionId ? { suggestion_id: suggestionId, suggestion_edited: Boolean(suggestionEdited) } : {}),
          idempotency_key: `ui_${Date.now()}_${Math.random().toString(16).slice(2)}`
        })
      });
      const index = state.detail.messages.findIndex((message) => message.id === pending.id);
      if (index >= 0) state.detail.messages[index] = data.message;
      if (data.message?.id) state.renderedMessageIds.add(String(data.message.id));
      if (data.message?.cursor) state.cursor = data.message.cursor;
      state.suggestion = null;
      state.suggestionDrafts.delete(state.activeId);
      state.pendingVoice.delete(voiceKey('webchat'));
      renderMessages();
    } catch (error) {
      state.detail.messages = state.detail.messages.filter((message) => message.id !== pending.id);
      renderMessages();
      input.value = text;
      autosize(input);
      Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1eff5022ac4ad5","Message not sent") ?? "Message not sent"), error.message, false);
      if (error.code === 'chat_claim_held') refreshDetail().catch(() => {});
    } finally {
      state.sending = false;
    }
  }

  function sendTypingSignal(){
    const now = Date.now();
    if (!state.activeId || now - state.typingSentAt < 3000) return;
    state.typingSentAt = now;
    api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(state.activeId)}/typing`, { method: 'POST', body: '{}' }).catch(() => {});
  }

  // --- Suggestions --------------------------------------------------------

  function showSuggestion(text){
    const box = $('[data-suggestion]', state.root);
    if (!box) return;
    const value = String(text || '').trim();
    if (!value) { box.hidden = true; return; }
    const textEl = $('[data-suggestion-text]', box);
    textEl.classList.remove('loading', 'error');
    textEl.textContent = value;
    $('[data-suggestion-insert]', box).hidden = false;
    box.hidden = false;
  }
  function showSuggestionLoading(){
    const box = $('[data-suggestion]', state.root);
    if (!box) return;
    const textEl = $('[data-suggestion-text]', box);
    textEl.classList.remove('error');
    textEl.classList.add('loading');
    textEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Drafting a reply…';
    $('[data-suggestion-insert]', box).hidden = true;
    box.hidden = false;
  }
  function showSuggestionError(message){
    const box = $('[data-suggestion]', state.root);
    if (!box) return;
    const textEl = $('[data-suggestion-text]', box);
    textEl.classList.remove('loading');
    textEl.classList.add('error');
    textEl.textContent = String(message || 'A reply could not be drafted automatically.');
    $('[data-suggestion-insert]', box).hidden = true;
    box.hidden = false;
  }
  function hideSuggestion(){
    const box = $('[data-suggestion]', state.root);
    if (box) box.hidden = true;
  }
  function dismissSuggestion(){
    state.suggestionRequestId += 1;
    state.suggestion = null;
    state.suggestionError = '';
    hideSuggestion();
  }

  function maybeAutoSuggest(){
    if (!state.features.suggestions || !state.activeId || !state.detail || state.suggesting || state.suggestion) return;
    if (state.detail.conversation?.status === 'closed' || state.drafts.get(state.activeId)) return;
    const messages = state.detail.messages || [];
    const lastVisitorMessage = [...messages].reverse().find((message) => message.direction === 'inbound' && !message.internal);
    if (!lastVisitorMessage) return;
    const lastResponseIndex = messages.findLastIndex((message) => message.direction === 'outbound' || message.internal);
    const visitorIndex = messages.findLastIndex((message) => message.id === lastVisitorMessage.id);
    if (lastResponseIndex > visitorIndex) return;
    if (state.autoSuggestedFor.get(state.activeId) === lastVisitorMessage.id) return;
    state.autoSuggestedFor.set(state.activeId, lastVisitorMessage.id);
    requestSuggestion({ automatic:true });
  }

  async function requestSuggestion(options = {}){
    if (state.suggesting || !state.activeId) return;
    const conversationId = state.activeId;
    const automatic = options.automatic === true;
    const requestId = ++state.suggestionRequestId;
    state.suggesting = true;
    state.suggestionError = '';
    const btn = $('[data-suggest]', state.root);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Drafting…';
    }
    showSuggestionLoading();
    try {
      const data = await api(`/organizations/${encodeURIComponent(orgId())}/chat/conversations/${encodeURIComponent(conversationId)}/suggest`, { method: 'POST', body: '{}' });
      const text = String(data.suggestion?.text || '').trim();
      if (text && state.activeId === conversationId && state.suggestionRequestId === requestId) {
        state.suggestion = { ...data.suggestion, text, conversationId };
        showSuggestion(text);
      } else if (state.suggestionRequestId === requestId) {
        state.suggestionError = 'A reply could not be drafted automatically. You can try again with Suggest reply.';
        showSuggestionError(state.suggestionError);
        if (!automatic) Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), (globalThis.PlatformLanguage?.text("chat","m_246cfc4d7d4eb3","No suggestion available right now.") ?? "No suggestion available right now."), false);
      }
    } catch (error) {
      if (state.suggestionRequestId === requestId) {
        state.suggestionError = 'A reply could not be drafted automatically. You can try again with Suggest reply.';
        showSuggestionError(state.suggestionError);
        if (!automatic) Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), error.message, false);
      }
    } finally {
      state.suggesting = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Suggest reply';
      }
    }
  }

  async function polishDraft(){
    if (state.polishing || !state.activeId) return;
    const input = $('.fmchat-input', state.root);
    const text = String(input?.value || '').trim();
    if (!text) { Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), (globalThis.PlatformLanguage?.text("chat","m_37986db73235e9","Write a draft first, then polish it.") ?? "Write a draft first, then polish it."), false); return; }
    state.polishing = true;
    const btn = $('[data-polish]', state.root);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Polishing…';
    }
    try {
      const data = await api(`/organizations/${encodeURIComponent(orgId())}/chat/compose/polish`, { method: 'POST', body: JSON.stringify({ text }) });
      if (data.text) {
        input.value = data.text;
        state.drafts.set(state.activeId, data.text);
        autosize(input);
        input.focus();
      }
    } catch (error) {
      Portal.ui?.showToast?.((globalThis.PlatformLanguage?.text("chat","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), error.message, false);
    } finally {
      state.polishing = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-spell-check"></i> Polish draft';
      }
    }
  }

  // --- Context pane -------------------------------------------------------

  function renderContext(){
    const mount = $('.fmchat-ctx-col', state.root);
    if (!mount) return;
    state.root.querySelector('.fmchat-shell')?.classList.toggle('agent-open',state.agent.open);
    state.root.querySelector('.fmchat-shell')?.classList.toggle('context-visible',Boolean(state.activeId)||state.agent.open);
    state.root.querySelector('[data-agent-toggle]')?.setAttribute('aria-expanded',String(state.agent.open));
    if (state.agent.open) {
      renderAgentPanel(mount);
      return;
    }
    if (state.activeKind !== 'webchat') {
      const detail = state.commsDetail || {};
      const participants = Array.isArray(detail.participants) ? detail.participants : [];
      const customer = participants.find((p) => String(p.type || '') !== 'internal') || participants[0] || {};
      mount.innerHTML = `
        <div class="fmchat-ctx-section">
          <div class="fmchat-ctx-title">${(globalThis.PlatformLanguage?.text("chat","m_4cd5e2d9c65130","Conversation") ?? "Conversation")}</div>
          <div class="fmchat-ctx-row"><i class="fas ${String(state.activeKind === 'sms' ? 'fa-comment-sms' : 'fa-envelope')}"></i><span>${String(state.activeKind === 'sms' ? 'Text messages' : 'Email thread')}</span></div>
          ${String(customer.name ? `<div class="fmchat-ctx-row"><i class="fas fa-user"></i><span>${esc(customer.name)}</span></div>` : '')}
          ${String(customer.address || customer.email || customer.phone ? `<div class="fmchat-ctx-row"><i class="fas fa-at"></i><span>${esc(customer.address || customer.email || customer.phone)}</span></div>` : '')}
        </div>
        ${String(detail.project_id ? `
        <div class="fmchat-ctx-section">
          <div class="fmchat-ctx-title">Project</div>
          <div class="fmchat-ctx-row"><i class="fas fa-folder"></i><span>${esc(detail.project_title || 'Project')}</span></div>
          <button type="button" class="fmchat-btn" data-ctx-open-project style="margin-top:6px"><i class="fas fa-folder-open"></i> Open project</button>
        </div>` : '<div class="fmchat-ctx-empty">Not linked to a project.</div>')}
      `;
      mount.querySelector('[data-ctx-open-project]')?.addEventListener('click', () => {
        window.FirstMateAgentChat?.runAction?.({ kind: 'project', project_id: String(detail.project_id || '') });
      });
      return;
    }
    if (!state.detail) {
      mount.innerHTML = `<div class="fmchat-ctx-empty" style="padding-top:24px;text-align:center">${(globalThis.PlatformLanguage?.text("chat","m_c3520419f1afbd","Conversation details appear here.") ?? "Conversation details appear here.")}</div>`;
      return;
    }
    const visitor = state.detail.visitor || {};
    const conversationState = state.detail.state || {};
    const history = state.detail.history || [];
    const hints = state.detail.ip_hints || [];
    const viewers = state.detail.viewers || [];
    mount.innerHTML = `
      <div class="fmchat-ctx-section">
        <div class="fmchat-ctx-title">${(globalThis.PlatformLanguage?.text("chat","m_929ba30480de60","Visitor") ?? "Visitor")}</div>
        <div class="fmchat-ctx-row"><i class="fas fa-user"></i><span>${String(esc(visitor.name || 'Unknown'))}</span></div>
        ${String(visitor.email ? `<div class="fmchat-ctx-row"><i class="fas fa-envelope"></i><span>${esc(visitor.email)}</span></div>` : '')}
        ${String(visitor.phone ? `<div class="fmchat-ctx-row"><i class="fas fa-phone"></i><span>${esc(visitor.phone)}</span></div>` : '')}
        ${String(visitor.contact_id ? '<div class="fmchat-ctx-row"><i class="fas fa-id-badge"></i><span>Linked CRM contact</span></div>' : '')}
        ${String(visitor.portal_customer_id ? '<div class="fmchat-ctx-row"><i class="fas fa-circle-check" style="color:#12b76a"></i><span>Verified portal customer</span></div>' : '')}
        <div class="fmchat-ctx-row"><i class="fas fa-globe"></i><span title="${String(esc(conversationState.origin_url || ''))}">${String(esc(pageLabel(conversationState.origin_url)))}</span></div>
        <div class="fmchat-ctx-row"><i class="fas fa-clock"></i><span>${((v7) => globalThis.PlatformLanguage?.text("chat","m_efff4d5af9232c",`First seen ${v7}`,{v7}) ?? `First seen ${v7}`)(esc(dayLabel(visitor.first_seen_at)))}</span></div>
      </div>
      ${String(viewers.length ? `<div class="fmchat-ctx-section"><div class="fmchat-ctx-title">Viewing now</div>${viewers.map((viewer) => `<span class="fmchat-viewer-chip"><i class="fas fa-eye"></i>${esc(firstName(viewer.user_name) || 'Teammate')}</span>`).join('')}</div>` : '')}
      <div class="fmchat-ctx-section">
        <div class="fmchat-ctx-title">${(globalThis.PlatformLanguage?.text("chat","m_a418e0fa2c0fa0","Previous conversations") ?? "Previous conversations")}</div>
        ${String(history.length ? history.slice(0, 6).map((item) => `<div class="fmchat-hist-item">${esc((item.last_message?.text || 'Conversation').slice(0, 60))}<small>${esc(dayLabel(item.created_at))} • ${item.message_count} messages</small></div>`).join('') : '<div class="fmchat-ctx-empty">None from this visitor.</div>')}
      </div>
      ${String(hints.length ? `<div class="fmchat-ctx-section"><div class="fmchat-ctx-title">Possibly the same visitor</div>${hints.map((hint) => `<div class="fmchat-hist-item">${esc(hint.name || hint.email || 'Unnamed visitor')}<small>Same network • last seen ${esc(dayLabel(hint.last_seen_at))}</small></div>`).join('')}</div>` : '')}
    `;
  }

  function pageLabel(url){
    if (!url) return 'Website';
    try { const parsed = new URL(url); return parsed.pathname === '/' ? parsed.hostname : parsed.pathname; } catch { return url; }
  }

  // --- Shell / lifecycle --------------------------------------------------

  function channelTabs(){
    const tabs = [{ id: 'all', label: (globalThis.PlatformLanguage?.text("chat","m_61df468d92e238","All") ?? "All"), icon: 'fa-inbox' }];
    if (chatChannelEnabled()) tabs.push({ id: 'webchat', label: (globalThis.PlatformLanguage?.text("chat","m_c0bcad9b8e4a38","Chats") ?? "Chats"), icon: 'fa-message' });
    if (commsChannelsEnabled() && can('comms.email')) tabs.push({ id: 'email', label: (globalThis.PlatformLanguage?.text("chat","m_5d2b9327181e33","Email") ?? "Email"), icon: 'fa-envelope' });
    if (commsChannelsEnabled() && can('comms.sms')) tabs.push({ id: 'sms', label: (globalThis.PlatformLanguage?.text("chat","m_502193b4922098","Texts") ?? "Texts"), icon: 'fa-comment-sms' });
    if (commsChannelsEnabled()) tabs.push({ id:'call',label:(globalThis.PlatformLanguage?.text("chat","m_e830f5588df87c","Calls") ?? "Calls"),icon:'fa-phone' });
    return tabs;
  }

  function renderShell(){
    const showChannels = channelTabs().length > 2;
    state.root.innerHTML = `
      <div class="fmchat-shell">
        <div class="fmchat-main">
          <div class="fmchat-list-col">
            <div class="fmchat-list-tools"><strong>${(globalThis.PlatformLanguage?.text("chat","m_1d1623bb0560dd","Inbox") ?? "Inbox")}</strong>
              ${String(can('comms.agent') && commsChannelsEnabled() ? '<button type="button" class="fmchat-ai-toggle" data-agent-toggle aria-expanded="false"><i class="fas fa-wand-magic-sparkles"></i>Ask AI</button>' : '')}
              <div class="fmchat-live"><i></i><span>${(globalThis.PlatformLanguage?.text("chat","m_4e930690c170d1","Checking…") ?? "Checking…")}</span></div>
            </div>
            ${String(showChannels ? `<div class="fmchat-channels">${channelTabs().map((tab) => `<button type="button" class="fmchat-channel ${state.channel === tab.id ? 'active' : ''}" data-channel="${tab.id}"><i class="fas ${tab.icon}"></i>${tab.label}</button>`).join('')}</div>` : '')}
            <div class="fmchat-filters">
              ${String(['open', 'mine', 'unclaimed', 'snoozed', 'closed'].map((filter) => `<button type="button" class="fmchat-filter ${state.filter === filter ? 'active' : ''}" data-filter="${filter}">${filter[0].toUpperCase()}${filter.slice(1)}</button>`).join(''))}
            </div>
            <div class="fmchat-list"></div>
          </div>
          <div class="fmchat-thread-col"></div>
          <div class="fmchat-ctx-col"></div>
        </div>
      </div>`;
    $$('[data-filter]', state.root).forEach((el) => el.addEventListener('click', () => {
      state.filter = el.dataset.filter;
      if(!Portal.navigation?.applying)Portal.navigation?.replace?.({chatFilter:state.filter});
      $$('[data-filter]', state.root).forEach((btn) => btn.classList.toggle('active', btn === el));
      loadInbox({ reset: true }).catch(() => {});
    }));
    $$('[data-channel]', state.root).forEach((el) => el.addEventListener('click', () => {
      state.channel = el.dataset.channel;
      if(!Portal.navigation?.applying)Portal.navigation?.replace?.({chatChannel:state.channel});
      $$('[data-channel]', state.root).forEach((btn) => btn.classList.toggle('active', btn === el));
      updateList();
    }));
    $('[data-agent-toggle]', state.root)?.addEventListener('click', () => toggleAgentPanel());
    renderThreadShell();
    renderContext();
  }

  // --- Org-wide comms agent panel ------------------------------------------

  async function toggleAgentPanel(){
    state.agent.open = !state.agent.open;
    state.agent.error = '';
    $('[data-agent-toggle]', state.root)?.classList.toggle('active', state.agent.open);
    renderContext();
    if (state.agent.open && !state.agent.threadId && agentsApi()) {
      try {
        const result = await agentsApi().threads(orgId(), 'comms', { subjectId: '' });
        const threads = Array.isArray(result.threads) ? result.threads : [];
        if (threads.length) {
          state.agent.threadId = String(threads[0].id || '');
          const detail = await agentsApi().thread(orgId(), 'comms', state.agent.threadId);
          state.agent.messages = (Array.isArray(detail.messages) ? detail.messages : [])
            .map((message) => ({ id: message.id, role: message.role, content: message.content, data: message.data }));
        }
      } catch (error) {
        state.agent.error = error.message || 'Could not load the AI conversation.';
      }
      renderContext();
    }
  }

  function renderAgentPanel(mount){
    const engine = window.FirstMateAgentChat;
    engine?.injectBaseCss?.('fmchat-agent');
    const messagesHtml = state.agent.messages.length
      ? state.agent.messages.map((message) => engine
          ? engine.messageHtml(message, { prefix: 'fmchat-agent', userClass: 'fmchat-agent-msg user', assistantClass: 'fmchat-agent-msg assistant' })
          : `<div class="fmchat-agent-msg ${message.role === 'user' ? 'user' : 'assistant'}">${esc(message.content)}</div>`).join('')
      : `<div class="fmchat-ctx-empty" style="padding-top:14px;text-align:center"><i class="fas fa-wand-magic-sparkles" style="display:block;font-size:22px;margin-bottom:8px;opacity:.5"></i>${(globalThis.PlatformLanguage?.text("chat","m_e195500186cfc6","Ask about any conversation across email, texts, and chat — or ask me to draft replies and book appointments.") ?? "Ask about any conversation across email, texts, and chat — or ask me to draft replies and book appointments.")}</div>`;
    mount.innerHTML = `
      <div class="fmchat-agent-panel">
        <div class="fmchat-agent-head">
          <span class="fmchat-agent-title"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.text("chat","m_4a042d7afc906b","Comms AI") ?? "Comms AI")}</span>
          <button type="button" class="fmchat-btn" data-agent-close aria-label="${(globalThis.PlatformLanguage?.text("chat","m_da993921863718","Close AI sidebar") ?? "Close AI sidebar")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="fmchat-agent-msgs" data-agent-scroll>
          ${String(state.agent.error ? `<div class="fmchat-empty" style="color:#b42318">${esc(state.agent.error)}</div>` : '')}
          ${String(messagesHtml)}
          ${String(state.agent.busy ? '<div class="fmchat-agent-msg assistant pending">Working…</div>' : '')}
        </div>
        <div class="fmchat-agent-composer">
          <textarea placeholder="${(globalThis.PlatformLanguage?.text("chat","m_48227f599c3b37","Ask across every inbox…") ?? "Ask across every inbox…")}" data-agent-input></textarea>
          <button type="button" class="fmchat-agent-send" data-agent-send ${String(state.agent.busy ? 'disabled' : '')}><i class="fas fa-paper-plane"></i></button>
        </div>
      </div>
    `;
    window.FirstMateAgentChat?.bindActions?.(mount, state.agent.messages);
    mount.querySelector('[data-agent-close]')?.addEventListener('click', () => toggleAgentPanel());
    const input = mount.querySelector('[data-agent-input]');
    const send = async () => {
      const text = String(input?.value || '').trim();
      if (!text || state.agent.busy || !agentsApi()) return;
      state.agent.busy = true;
      state.agent.error = '';
      state.agent.messages.push({ id: `local_${Date.now()}`, role: 'user', content: text, data: {} });
      if (input) input.value = '';
      renderContext();
      try {
        if (!state.agent.threadId) {
          const created = await agentsApi().createThread(orgId(), 'comms', {});
          state.agent.threadId = String((created.thread || {}).id || '');
        }
        const result = await agentsApi().send(orgId(), 'comms', state.agent.threadId, { message: text });
        const assistantMessage = result.assistant_message || {};
        state.agent.messages.push({
          id: assistantMessage.id || `local_${Date.now()}_a`,
          role: 'assistant',
          content: assistantMessage.content || 'Done.',
          data: assistantMessage.data || {}
        });
        // The agent may have sent messages or booked events — refresh.
        loadInbox().catch(() => {});
      } catch (error) {
        state.agent.messages.push({ id: `local_${Date.now()}_e`, role: 'assistant', content: error.message || 'The comms agent is unavailable right now.', data: { status: 'failed' } });
      }
      state.agent.busy = false;
      renderContext();
    };
    mount.querySelector('[data-agent-send]')?.addEventListener('click', send);
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    const scroll = mount.querySelector('[data-agent-scroll]');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function schedulePoll(){
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    if (!state.mounted) return;
    const delay = document.visibilityState === 'hidden' ? 15000 : 3000;
    state.pollTimer = setTimeout(() => {
      loadInbox().catch(() => {}).finally(() => schedulePoll());
    }, delay);
  }

  function syncRoute(history = 'replace'){
    window.Portal?.navigation?.write?.({ tab: 'chat', chatConversation: state.activeId || null }, { history, source: 'chat-inbox', ownedKeys: ['chatConversation'] });
  }

  function restoreRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (route.tab !== 'chat') return;
    const filter=route.chatFilter||'open',channel=route.chatChannel||'all';
    const filterChanged=filter!==state.filter,channelChanged=channel!==state.channel;
    state.filter=filter;state.channel=channel;
    if(state.mounted){
      $$('[data-filter]',state.root).forEach(btn=>btn.classList.toggle('active',btn.dataset.filter===filter));
      $$('[data-channel]',state.root).forEach(btn=>btn.classList.toggle('active',btn.dataset.channel===channel));
      if(filterChanged)void loadInbox({reset:true}).catch(()=>{});else if(channelChanged)updateList();
    }
    const target = String(route.chatConversation || '');
    if (target && target !== state.activeId && state.mounted) void openConversation(target, { fromRoute: true });
    else if(!target&&state.activeId)closeThread({fromRoute:true});
  }

  window.Portal?.navigation?.registerHandler?.('chat-inbox', { priority: 440, apply: (route) => restoreRoute(route) });
  window.addEventListener('fm:open-chat-conversation', (event) => {
    const id = String(event.detail?.conversation_id || '');
    if (!id) return;
    if (state.mounted) void openConversation(id);
    else window.Portal?.navigation?.write?.({ tab: 'chat', chatConversation: id }, { history: 'push', source: 'chat-notification' });
  });
  document.addEventListener('visibilitychange', () => schedulePoll());

  function mountInbox(root){
    css();
    const route=Portal.navigation?.read?.()||{};state.filter=route.chatFilter||'open';state.channel=route.chatChannel||'all';
    state.root = root;
    state.mounted = true;
    renderShell();
    loadInbox({ reset: true }).then(() => {
      const route = window.Portal?.navigation?.read?.() || {};
      if (route.chatConversation) void openConversation(String(route.chatConversation), { fromRoute: true });
    }).catch((error) => {
      const shell = $('.fmchat-list', state.root);
      if (shell) shell.innerHTML = `<div class="fmchat-empty">${esc(error.message)}</div>`;
    });
    schedulePoll();
    return { destroy(){ state.mounted = false; if (state.pollTimer) clearTimeout(state.pollTimer); } };
  }

  function mount(root){
    return window.Portal.CommunicationsWorkspace.mount(root, { mountInbox });
  }

  let registered = false, timer = null;
  function ready(){ return !!window.Portal?.apps?.registerPortalApp && !!document.getElementById('mainPanels'); }
  function sync(delay = 0){
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!ready()) return sync(100);
      if (window.Portal?.appFlags?.load) await window.Portal.appFlags.load().catch(() => null);
      // The global communications center shows when EITHER live chat or the
      // comms hub is enabled; each channel gates itself inside the app.
      const on = window.Portal?.appFlags?.has?.('apps', 'live_chat') || window.Portal?.appFlags?.has?.('apps', 'comms');
      if (on && !registered) {
        registered = true;
        window.Portal.apps.registerPortalApp({ id: 'portal.chat', tabId: 'chat', title: (globalThis.PlatformLanguage?.text("chat","m_643fa01aa77d59","Communications") ?? "Communications"), terminologyKey: 'chat.portal_tab', icon: 'fa-inbox', order: 23, fullBleed: true, mount });
        window.Portal.tabs.renderTabs?.();
      } else if (!on && registered) {
        registered = false;
        window.Portal.apps.unregisterPortalApp?.('chat');
      }
    }, delay);
  }
  window.addEventListener('fm:platform-session:updated', () => sync());
  window.addEventListener('fm:app-flags:updated', () => sync());
  document.addEventListener('DOMContentLoaded', () => sync());
  sync();
})();
