/* public/libraries/apps/comms/project.js
 * Project Comms tab — the per-project communications hub. Sub-tabs (Overview,
 * Email, Texts, Portal Chat) are a data-driven registry so future channels
 * (e.g. appointment recordings) are one entry + one renderer. Includes
 * cross-channel search, the comms AI panel, AI draft review, test-mode
 * badges/simulation, and a left-column takeover with per-project comms
 * controls.
 */
(function(){
  'use strict';

  const rootWindow = window;
  const Portal = rootWindow.Portal = rootWindow.Portal || {};
  const runtime = rootWindow.FirstMateEmbeddableApps;
  const util = Portal.util || {};

  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timeLabel = (iso) => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const time = date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    if (date.toDateString() === today.toDateString()) return time;
    return `${date.toLocaleDateString([], { month:'short', day:'numeric' })} ${time}`;
  };

  function can(key){
    const fn = Portal.can;
    if (typeof fn !== 'function') return true;
    try { return fn(key) !== false; } catch (_) { return true; }
  }

  // ── Channel sub-tab registry ─────────────────────────────────────────────
  // Adding a channel later (recordings, mail, …) = add an entry here with a
  // loader + renderer; routing, tab chrome, and gating come for free.
  const CHANNEL_TABS = [
    { id:'overview', label:(globalThis.PlatformLanguage?.text("comms","m_b69161f38dacdf","Overview") ?? "Overview"), icon:'fa-table-columns', capability:'apps.comms' },
    { id:'email', label:(globalThis.PlatformLanguage?.text("comms","m_5d2b9327181e33","Email") ?? "Email"), icon:'fa-envelope', capability:'comms.email' },
    { id:'sms', label:(globalThis.PlatformLanguage?.text("comms","m_502193b4922098","Texts") ?? "Texts"), icon:'fa-comment-sms', capability:'comms.sms' },
    { id:'chat', label:(globalThis.PlatformLanguage?.text("comms","m_a75cb043a6d759","Portal Chat") ?? "Portal Chat"), icon:'fa-message', capability:'comms.portal_chat' },
    { id:'calls', label:(globalThis.PlatformLanguage?.text("comms","m_e830f5588df87c","Calls") ?? "Calls"), icon:'fa-phone', capability:'apps.comms' }
  ];

  const CHANNEL_ICONS = { email:'fa-envelope', sms:'fa-comment-sms', webchat:'fa-message', call:'fa-phone' };

  const state = {
    context:null, host:null, project:null,
    panelRoot:null, leftRoot:null,
    mounted:false, active:false,
    view:'overview',
    callsHandle:null,
    loading:false, error:'',
    overview:null,
    emailThreads:[], emailThread:null, emailComposeOpen:false,
    emailDraft:{ to:'', cc:'', bcc:'' },
    sms:null, activeSmsId:'', smsComposeOpen:false, smsDraft:{ to:'' },
    chatConversations:[], activeChatId:'',
    chatVoice:{ mode:'attachment', max_seconds:120 },
    search:{ open:false, query:'', results:[], busy:false },
    agent:{ open:false, threadId:'', messages:[], busy:false, error:'' },
    // Content signatures for the incremental poll (syncView): a poll tick
    // only touches the DOM when the corresponding signature changed, and
    // then only the list / message containers — never composers.
    sync:{ overview:'', emailList:'', emailMsgs:'', sms:'', chatList:'', chatMsgs:'' },
    settings:{ overrides:null, saving:false, loaded:false },
    voiceSettings:{ sms:'attachment', email:'dictation' },
    pendingVoice:{ sms:null, chat:null },
    inboxAddress:'',
    sending:false,
    simulateBusy:false,
    pollTimer:0
  };

  function orgId(){
    return clean(state.context?.orgId || rootWindow.__APP?.userOrgId || rootWindow.__APP?.orgId || '');
  }

  function projectId(){
    return clean(state.project?.id || state.context?.projectId || state.context?.entityId || '');
  }

  function api2(){ return rootWindow.CommsAPI; }

  function overviewContacts(){
    return Array.isArray(state.overview?.contacts) ? state.overview.contacts : [];
  }

  function primaryContact(){
    return overviewContacts().find((contact) => contact.primary === true) || overviewContacts()[0] || object(state.overview?.contact);
  }

  function splitRecipients(value){
    return clean(value).split(/[,\n;]/).map(clean).filter(Boolean);
  }

  function addRecipient(value, address){
    const current = splitRecipients(value);
    if (address && !current.some((item) => item.toLowerCase() === address.toLowerCase())) current.push(address);
    return current.join(', ');
  }

  function recipientNames(participants){
    const values = (Array.isArray(participants) ? participants : [])
      .filter((participant) => clean(participant.type) !== 'internal' && clean(participant.address))
      .map((participant) => clean(participant.name) || clean(participant.address));
    return values.join(', ') || 'No recipients';
  }

  function setOverview(result){
    if (!result) return;
    state.overview = object(result.overview);
    state.inboxAddress = clean(state.overview.org_inbox_address);
  }

  function beginEmailDraft(){
    const contact = primaryContact();
    state.emailDraft = { to:clean(contact.email), cc:'', bcc:'' };
    state.emailComposeOpen = true;
    state.emailThread = null;
  }

  function beginSmsDraft(){
    const contact = primaryContact();
    state.smsDraft = { to:clean(contact.phone) };
    state.smsComposeOpen = true;
    state.activeSmsId = '';
  }

  // ── Styles ───────────────────────────────────────────────────────────────

  function css(){
    const text = `
      .fmco-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fa;color:#101828}
      .fmco-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e4e7ec;background:#fff;flex:0 0 auto;flex-wrap:wrap}
      .fmco-tabs{display:flex;gap:4px;flex:0 0 auto}
      .fmco-tab{border:1px solid transparent;background:transparent;border-radius:8px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:800;color:#667085;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .fmco-tab:hover{background:#f2f4f7}
      .fmco-tab.active{background:#101828;color:#fff}
      .fmco-head-spacer{flex:1}
      .fmco-search{display:flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 10px;min-width:210px}
      .fmco-search i{color:#98a2b3;font-size:12px}
      .fmco-search input{border:0;outline:none;font:inherit;font-size:12.5px;padding:7px 0;background:transparent;flex:1;min-width:0}
      .fmco-ai-btn{border:1px solid #d8dee8;background:#fff;border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:800;color:#344054;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .fmco-ai-btn:hover{background:#f8fafc}
      .fmco-ai-btn.active{background:var(--primary-readable,var(--primary,#d93025));border-color:transparent;color:#fff}
      .fmco-body{flex:1;min-height:0;display:flex}
      .fmco-content{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:16px}
      .fmco-agent-col{width:340px;flex:0 0 auto;border-left:1px solid #e4e7ec;background:#fff;display:flex;flex-direction:column;min-height:0}
      /* display:flex would otherwise override the [hidden] attribute and
         leave a permanently blank right column. */
      .fmco-agent-col[hidden]{display:none!important}
      .fmco-test{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#b45309;background:#fff7e6;border:1px solid #f5dda9;border-radius:999px;padding:1px 7px;text-transform:uppercase;vertical-align:1px}
      .fmco-ai-chip{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#6d28d9;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:999px;padding:1px 7px;text-transform:uppercase;vertical-align:1px}
      .fmco-auto-chip{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#0369a1;background:#e0f2fe;border:1px solid #bae6fd;border-radius:999px;padding:1px 7px;text-transform:uppercase;vertical-align:1px}
      .fmco-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
      .fmco-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px;display:grid;gap:6px}
      .fmco-card-top{display:flex;align-items:center;justify-content:space-between}
      .fmco-card-title{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;display:flex;align-items:center;gap:7px}
      .fmco-card-title i{color:#667085}
      .fmco-card-count{font-size:22px;font-weight:900;color:#101828}
      .fmco-card-sub{font-size:11.5px;color:#667085;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-card-open{border:0;background:transparent;color:#667085;font-size:12px;cursor:pointer;padding:4px}
      .fmco-card-open:hover{color:#101828}
      .fmco-section-title{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;margin:0 0 8px}
      .fmco-feed{display:grid;gap:6px}
      .fmco-feed-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:center;background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:9px 12px;cursor:pointer}
      .fmco-feed-row:hover{border-color:#c7ced9}
      .fmco-feed-ico{width:30px;height:30px;border-radius:8px;background:#f2f4f7;display:flex;align-items:center;justify-content:center;color:#475467;font-size:12.5px}
      .fmco-feed-ico.inbound{background:rgba(var(--primary-rgb,217 48 37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-feed-main{min-width:0;display:grid;gap:2px}
      .fmco-feed-line1{display:flex;align-items:center;gap:7px;min-width:0}
      .fmco-feed-who{font-size:12.5px;font-weight:900;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fmco-feed-preview{font-size:12px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-feed-time{font-size:11px;color:#98a2b3;font-weight:700;white-space:nowrap}
      .fmco-empty{padding:36px 16px;text-align:center;color:#98a2b3}
      .fmco-empty i{font-size:34px;opacity:.45;margin-bottom:10px;display:block}
      .fmco-empty p{margin:0;font-size:13px;font-weight:700}
      .fmco-error{background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:10px;padding:10px 14px;font-size:12.5px;font-weight:700;margin-bottom:12px}
      .fmco-draft-card{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:12px;padding:12px 14px;margin-bottom:8px;display:grid;gap:8px}
      .fmco-draft-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .fmco-draft-label{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#6d28d9;display:flex;align-items:center;gap:7px}
      .fmco-draft-text{font-size:12.5px;color:#344054;line-height:1.5;white-space:pre-wrap}
      .fmco-draft-actions{display:flex;gap:6px;justify-content:flex-end}
      .fmco-btn{border:1px solid #d8dee8;background:#fff;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;font-weight:800;padding:6px 12px;color:#344054;display:inline-flex;align-items:center;gap:6px}
      .fmco-btn:hover{background:#f8fafc}
      .fmco-btn.primary{background:#101828;border-color:#101828;color:#fff}
      .fmco-btn.primary:hover{background:#232f47}
      .fmco-btn:disabled{opacity:.5;cursor:default}
      .fmco-split{display:grid;grid-template-columns:300px minmax(0,1fr);gap:14px;height:100%;min-height:0}
      .fmco-list-col{display:flex;flex-direction:column;gap:6px;min-height:0;overflow-y:auto}
      .fmco-list-col>.fmco-empty{margin:auto}
      .fmco-thread-row{width:100%;text-align:left;background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:10px 12px;cursor:pointer;font:inherit;display:grid;gap:3px}
      .fmco-thread-row:hover{border-color:#c7ced9}
      .fmco-thread-row.active{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217 48 37),.04)}
      .fmco-thread-subject{font-size:12.5px;font-weight:900;color:#101828;display:flex;align-items:center;gap:7px;min-width:0}
      .fmco-thread-subject span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-thread-meta{font-size:11px;color:#98a2b3;font-weight:700;display:flex;justify-content:space-between;gap:8px}
      .fmco-thread-view{background:#fff;border:1px solid #e4e7ec;border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
      .fmco-thread-head{padding:11px 16px;border-bottom:1px solid #eef1f4;display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 auto}
      .fmco-thread-title{font-size:13.5px;font-weight:900;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-msgs{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
      .fmco-msg{max-width:76%;border-radius:13px;padding:10px 13px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
      .fmco-msg.inbound{align-self:flex-start;background:#f2f4f7;border-bottom-left-radius:5px}
      .fmco-msg.outbound{align-self:flex-end;background:#101828;color:#fff;border-bottom-right-radius:5px}
      .fmco-msg.outbound.ai{background:#6d28d9}
      .fmco-msg-subject{font-weight:900;margin-bottom:4px}
      .fmco-msg-meta{font-size:10.5px;color:#98a2b3;font-weight:700;margin:1px 4px 6px;display:flex;align-items:center;gap:6px}
      .fmco-msg-meta.inbound{align-self:flex-start}
      .fmco-msg-meta.outbound{align-self:flex-end}
      .fmco-page-context{align-self:flex-start;width:min(360px,88%);margin-bottom:7px;border:1px solid #d8dee8;border-radius:11px;background:#fff;overflow:hidden;box-shadow:0 3px 10px rgba(16,24,40,.05)}
      .fmco-page-context-head{padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;gap:8px}.fmco-page-context-head i{color:#667085}.fmco-page-context-head span{display:grid;min-width:0}.fmco-page-context-head small{font-size:9px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3}.fmco-page-context-head strong{font-size:12px;color:#344054;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-page-shot{display:block;background:#eef1f5;border-bottom:1px solid #e4e7ec}.fmco-page-shot img{display:block;width:100%;max-height:230px;object-fit:cover;object-position:top left}.fmco-page-shot:hover img{filter:brightness(.98)}
      .fmco-page-preview{padding:9px 10px;display:grid;gap:4px;background:linear-gradient(145deg,#fff,#f8fafc)}.fmco-page-line{font-size:10.5px;line-height:1.3;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmco-page-line:before{content:' ';display:inline-block;width:4px;height:4px;border-radius:50%;background:#c7ced9;margin:0 6px 2px 0}.fmco-page-line.title{font-size:11px;font-weight:800;color:#475467}.fmco-page-line.title:before{display:none}.fmco-page-line.placeholder{height:6px;border-radius:999px;background:#dfe4eb;width:82%}.fmco-page-line.placeholder:before{display:none}
      .fmco-composer{border-top:1px solid #eef1f4;padding:10px 14px;display:grid;gap:8px;flex:0 0 auto;background:#fff}
      .fmco-recipient-box{border:1px solid #d0d5dd;border-radius:10px;background:#fff;overflow:hidden}
      .fmco-recipient-row{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;border-bottom:1px solid #eef1f4}
      .fmco-recipient-row:last-child{border-bottom:0}
      .fmco-recipient-label{padding-left:12px;font-size:11px;font-weight:900;color:#667085}
      .fmco-recipient-input{border:0;outline:0;padding:9px 10px 9px 0;font:inherit;font-size:13px;min-width:0;width:100%}
      .fmco-contact-options{display:flex;gap:6px;flex-wrap:wrap}
      .fmco-contact-chip{border:1px solid #d8dee8;background:#f8fafc;border-radius:999px;padding:4px 9px;font:inherit;font-size:10.5px;font-weight:800;color:#475467;cursor:pointer}
      .fmco-contact-chip:hover{border-color:#98a2b3;background:#fff}
      .fmco-contact-chip:disabled{opacity:.48;cursor:not-allowed;text-decoration:line-through}
      .fmco-recipient-summary{font-size:11px;color:#667085;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-input,.fmco-textarea{border:1px solid #d0d5dd;border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;outline:none;width:100%}
      .fmco-input:focus,.fmco-textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-textarea{resize:vertical;min-height:64px;max-height:220px}
      .fmco-composer-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .fmco-composer-hint{font-size:11px;color:#98a2b3;font-weight:700}
      .fmco-voice{height:38px;display:inline-flex;align-items:center;gap:5px}.fmco-voice small{font-size:9px}.fmco-voice-mount:empty{display:none}.fmco-msg-audio{margin-top:6px;min-width:220px}
      .fmco-agent-head{padding:11px 14px;border-bottom:1px solid #eef1f4;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}
      .fmco-agent-title{font-size:12px;font-weight:900;display:flex;align-items:center;gap:8px;color:#101828}
      .fmco-agent-title i{color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-agent-msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
      .fmco-agent-msg{border-radius:11px;padding:9px 12px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
      .fmco-agent-msg.user{align-self:flex-end;background:#101828;color:#fff;max-width:85%}
      .fmco-agent-msg.assistant{align-self:flex-start;background:#f2f4f7;max-width:95%}
      .fmco-agent-msg.pending{opacity:.6;font-style:italic}
      .fmco-agent-composer{border-top:1px solid #eef1f4;padding:10px 12px;display:flex;gap:7px;flex:0 0 auto}
      .fmco-agent-composer textarea{flex:1;border:1px solid #d0d5dd;border-radius:9px;padding:8px 11px;font:inherit;font-size:12.5px;resize:none;min-height:38px;max-height:120px;outline:none}
      .fmco-agent-send{width:38px;height:38px;border:0;border-radius:9px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;cursor:pointer;flex:0 0 auto}
      .fmco-agent-send:disabled{opacity:.5;cursor:default}
      .fmco-result-snippet{font-size:11.5px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-result-snippet b{color:#101828}
      .fmco-left{display:grid;gap:12px;padding:2px 0 14px}
      .fmco-left-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:12px 14px;display:grid;gap:9px}
      .fmco-left-title{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;display:flex;align-items:center;gap:7px}
      .fmco-left-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#344054;min-width:0}
      .fmco-left-row i{width:15px;color:#98a2b3;text-align:center;flex:0 0 auto;font-size:11.5px}
      .fmco-left-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-left-stat{display:flex;justify-content:space-between;font-size:12px;color:#344054;font-weight:700}
      .fmco-left-stat b{color:#101828;font-weight:900}
      .fmco-role-chips{display:flex;gap:5px;flex-wrap:wrap}
      .fmco-role-chip{border:1px solid #d8dee8;background:#fff;border-radius:999px;padding:4px 11px;font:inherit;font-size:11px;font-weight:800;color:#475467;cursor:pointer}
      .fmco-role-chip.on{background:rgba(var(--primary-rgb,217 48 37),.08);border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-left textarea{border:1px solid #d0d5dd;border-radius:9px;padding:7px 10px;font:inherit;font-size:12px;min-height:58px;resize:vertical;outline:none;width:100%}
      .fmco-left select{border:1px solid #d0d5dd;border-radius:8px;padding:6px 9px;font:inherit;font-size:12px;outline:none;background:#fff;width:100%}
      .fmco-left-hint{font-size:10.5px;color:#98a2b3;font-weight:700;line-height:1.4}
      .fmco-left-save{justify-self:end}
      @media(max-width:1180px){.fmco-agent-col{position:absolute;right:0;top:0;bottom:0;z-index:30;box-shadow:-14px 0 30px rgba(16,24,40,.12)}}
      @media(max-width:900px){.fmco-split{grid-template-columns:1fr}.fmco-split .fmco-thread-view{display:none}.fmco-split.thread-mode .fmco-thread-view{display:flex}.fmco-split.thread-mode .fmco-list-col{display:none}}
    `;
    util.injectCSS ? util.injectCSS('project_comms', text) : document.head.appendChild(Object.assign(document.createElement('style'), { textContent:text }));
  }

  // ── Shell ────────────────────────────────────────────────────────────────

  function panelHtml(){
    return `
      <div class="fmco-shell" data-comms-root style="position:relative">
        <div class="fmco-head">
          <div class="fmco-tabs" data-co-tabs></div>
          <div class="fmco-head-spacer"></div>
          <label class="fmco-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_ba670f4714e86b","Search all communications…") ?? "Search all communications…")}" data-co-search></label>
          <button type="button" class="fmco-ai-btn" data-co-ai-toggle hidden><i class="fa-solid fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_fe8a5736f9bbac","Ask AI") ?? "Ask AI")}</button>
          <button type="button" class="fmco-btn" data-co-settings aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_c4955421e825c8","Project communication settings") ?? "Project communication settings")}"><i class="fa-solid fa-gear"></i></button>
        </div>
        <div class="fmco-body">
          <div class="fmco-content" data-co-content></div>
          <div class="fmco-agent-col" data-co-agent hidden></div>
        </div>
      </div>
    `;
  }

  function visibleTabs(){
    return CHANNEL_TABS.filter((tab) => !tab.capability || can(tab.capability));
  }

  function renderTabs(){
    const host = state.panelRoot?.querySelector('[data-co-tabs]');
    if (!host) return;
    host.innerHTML = visibleTabs().map((tab) => `
      <button type="button" class="fmco-tab${state.view === tab.id ? ' active' : ''}" data-co-tab="${tab.id}">
        <i class="fa-solid ${tab.icon}"></i>${esc(tab.label)}
      </button>
    `).join('');
    host.querySelectorAll('[data-co-tab]').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.coTab, { pushRoute:true }));
    });
    const aiButton = state.panelRoot?.querySelector('[data-co-ai-toggle]');
    if (aiButton) {
      aiButton.hidden = !can('comms.agent');
      aiButton.classList.toggle('active', state.agent.open);
    }
  }

  function setView(view, options = {}){
    if(state.callsHandle){state.callsHandle.destroy();state.callsHandle=null;contentRoot()?.replaceChildren();}
    const allowed = visibleTabs().some((tab) => tab.id === view);
    state.view = allowed ? view : 'overview';
    state.search.open = false;
    if (options.pushRoute) Portal.navigation?.push?.({ commsView: state.view });
    renderTabs();
    loadView().catch(() => null);
    render();
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  async function loadView(){
    if (!state.mounted || !api2() || !orgId() || !projectId()) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      if (state.view === 'overview') {
        const result = await api2().overview(orgId(), projectId());
        setOverview(result);
      } else if (state.view === 'email') {
        const [result, overviewResult] = await Promise.all([
          api2().email.threads(orgId(), projectId()),
          state.overview ? Promise.resolve(null) : api2().overview(orgId(), projectId())
        ]);
        setOverview(overviewResult);
        state.emailThreads = Array.isArray(result.threads) ? result.threads : [];
        if (state.emailThread) {
          const stillThere = state.emailThreads.some((thread) => thread.id === state.emailThread.id);
          if (stillThere) await openEmailThread(state.emailThread.id, { silent:true });
          else state.emailThread = null;
        }
      } else if (state.view === 'sms') {
        const [result, overviewResult] = await Promise.all([
          api2().sms.conversation(orgId(), projectId(), state.activeSmsId),
          state.overview ? Promise.resolve(null) : api2().overview(orgId(), projectId())
        ]);
        setOverview(overviewResult);
        state.sms = result;
        const conversations = Array.isArray(result.conversations) ? result.conversations : [];
        if (!state.smsComposeOpen && !state.activeSmsId && conversations.length) {
          state.activeSmsId = clean(object(result.conversation).id || conversations[0].id);
        }
      } else if (state.view === 'chat') {
        const result = await api2().chat.conversations(orgId(), projectId());
        state.chatConversations = Array.isArray(result.conversations) ? result.conversations : [];
        state.chatVoice = { ...state.chatVoice, ...object(result.voice) };
        if (!state.activeChatId && state.chatConversations.length) state.activeChatId = clean(state.chatConversations[0].id);
      }
    } catch (error) {
      state.error = error?.message || 'Could not load communications.';
    }
    state.loading = false;
    render();
    // Channel stats + inbox address in the left column come from overview
    // data; refresh it once data lands (also heals a mount-order race where
    // the left region renders after us).
    if (state.active) renderLeft();
  }

  // ── Incremental poll sync ────────────────────────────────────────────────
  // The poll must PULL changes, not refresh the view: it fetches the same
  // data, compares content signatures, and patches only the list / message
  // containers that actually changed. Composers are never rebuilt, so drafts
  // and focus survive every tick and nothing flickers.

  function signatureOf(value){
    try { return JSON.stringify(value ?? null); } catch (_) { return String(Date.now()); }
  }

  function patchContainer(selector, html, options = {}){
    const root = contentRoot();
    const container = root?.querySelector(selector);
    if (!container) return false;
    // Never rebuild a container the user is interacting with.
    if (container.contains(document.activeElement)) return false;
    const nearBottom = options.keepScroll
      ? (container.scrollHeight - container.scrollTop - container.clientHeight) < 80
      : false;
    container.innerHTML = html;
    if (options.bind) options.bind(container);
    if (options.keepScroll && nearBottom) container.scrollTop = container.scrollHeight;
    return true;
  }

  async function syncView(){
    if (!state.mounted || !api2() || !orgId() || !projectId()) return;
    if (state.search.open || state.sending || state.loading) return;
    try {
      if (state.view === 'overview') {
        const result = await api2().overview(orgId(), projectId());
        if(state.view!=='overview')return;
        const overview = object(result.overview);
        const signature = signatureOf(overview);
        if (signature !== state.sync.overview) {
          state.sync.overview = signature;
          state.overview = overview;
          state.inboxAddress = clean(overview.org_inbox_address);
          // Overview has no composers; a focused element (e.g. a draft action
          // button) still blocks the rebuild to avoid yanking the click away.
          const root = contentRoot();
          if (root && !root.contains(document.activeElement)) renderOverview(root);
        }
      } else if (state.view === 'email') {
        const result = await api2().email.threads(orgId(), projectId());
        const threads = Array.isArray(result.threads) ? result.threads : [];
        const listSignature = signatureOf(threads.map((thread) => [thread.id, thread.message_count, thread.last_message_at]));
        if (listSignature !== state.sync.emailList) {
          state.sync.emailList = listSignature;
          state.emailThreads = threads;
          patchContainer('[data-co-list]', emailListHtml(), { bind: bindEmailList });
        }
        if (state.emailThread) {
          const stillThere = threads.some((thread) => thread.id === state.emailThread.id);
          if (stillThere) {
            const detail = await api2().email.thread(orgId(), projectId(), clean(state.emailThread.id)).catch(() => null);
            const thread = detail ? detail.thread : null;
            const msgsSignature = signatureOf((Array.isArray(thread?.messages) ? thread.messages : []).map((message) => message.id));
            if (thread && msgsSignature !== state.sync.emailMsgs) {
              state.sync.emailMsgs = msgsSignature;
              state.emailThread = thread;
              patchContainer('[data-co-scroll]', emailMsgsHtml(thread), { keepScroll:true });
            }
          }
        }
      } else if (state.view === 'sms') {
        const result = await api2().sms.conversation(orgId(), projectId(), state.activeSmsId);
        const conversations = Array.isArray(object(result).conversations) ? object(result).conversations : [];
        const signature = signatureOf(conversations.map((conversation) => [
          conversation.id,
          conversation.message_count,
          conversation.last_message_at
        ]));
        if (signature !== state.sync.sms) {
          state.sync.sms = signature;
          state.sms = result;
          patchContainer('[data-co-list]', smsListHtml(), { bind: bindSmsList });
          const active = activeSmsConversation();
          if (active) patchContainer('[data-co-scroll]', smsMsgsHtml(active), { keepScroll:true });
        }
      } else if (state.view === 'chat') {
        const result = await api2().chat.conversations(orgId(), projectId());
        state.chatVoice = { ...state.chatVoice, ...object(result.voice) };
        const conversations = Array.isArray(result.conversations) ? result.conversations : [];
        const listSignature = signatureOf(conversations.map((conversation) => [conversation.id, conversation.last_message_at]));
        if (listSignature !== state.sync.chatList) {
          state.sync.chatList = listSignature;
          state.chatConversations = conversations;
          if (!state.activeChatId && conversations.length) state.activeChatId = clean(conversations[0].id);
          patchContainer('[data-co-list]', chatListHtml(), { bind: bindChatList });
          const active = chatActiveConversation();
          const msgsSignature = signatureOf((Array.isArray(active?.messages) ? active.messages : []).map((message) => message.id));
          if (msgsSignature !== state.sync.chatMsgs) {
            state.sync.chatMsgs = msgsSignature;
            patchContainer('[data-co-scroll]', chatMsgsHtml(active), { keepScroll:true });
          }
        }
      }
    } catch (_) {
      // Poll blips are silent — the next tick retries; interactive loads
      // still surface errors through loadView().
    }
    // The left column stats update in place (renderLeft has its own guards).
    if (state.active) renderLeft();
  }

  async function openEmailThread(conversationId, options = {}){
    try {
      const result = await api2().email.thread(orgId(), projectId(), conversationId);
      state.emailThread = result.thread;
      state.emailComposeOpen = false;
    } catch (error) {
      state.error = error?.message || 'Could not load this thread.';
    }
    if (!options.silent) render();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function badges(message){
    const parts = [];
    if (message.test_mode) parts.push(`<span class="fmco-test"><i class="fa-solid fa-flask"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_7068831b41c117","Test") ?? "Test")}</span>`);
    if (message.source_kind === 'ai') parts.push(`<span class="fmco-ai-chip"><i class="fa-solid fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_6bb9dc0a65d709","AI") ?? "AI")}</span>`);
    else if (message.source_kind === 'automation') parts.push(`<span class="fmco-auto-chip"><i class="fa-solid fa-bolt"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_ab5038eb19bf34","Auto") ?? "Auto")}</span>`);
    return parts.join('');
  }

  function messageWho(message){
    const sender = object(message.sender);
    if (message.direction === 'inbound') return clean(sender.name) || clean(sender.address) || 'Customer';
    if (message.source_kind === 'ai') return 'AI agent';
    if (message.source_kind === 'automation') return 'Automation';
    return clean(sender.name) || 'Team';
  }

  function messagePreview(message){
    const subject = clean(message.subject);
    const text = clean(message.text).replace(/\s+/g, ' ');
    return subject ? (text ? `${subject} — ${text}` : subject) : text;
  }

  function contentRoot(){ return state.panelRoot?.querySelector('[data-co-content]'); }

  function render(){
    if (!state.mounted) return;
    renderAgentPanel();
    const root = contentRoot();
    if (!root) return;
    if (state.search.open) { renderSearch(root); return; }
    if (state.view === 'overview') renderOverview(root);
    else if (state.view === 'email') renderEmail(root);
    else if (state.view === 'sms') renderSms(root);
    else if (state.view === 'chat') renderChat(root);
    else if (state.view === 'calls' && !state.callsHandle) state.callsHandle=Portal.CommunicationsWorkspace.mount(root,{projectId:projectId()});
  }

  function loadingHtml(){
    return `<div class="fmco-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_d2da77452877dd","Loading…") ?? "Loading…")}</p></div>`;
  }

  function errorHtml(){
    return state.error ? `<div class="fmco-error">${esc(state.error)}</div>` : '';
  }

  // Overview -----------------------------------------------------------------

  function renderOverview(root){
    if (state.loading && !state.overview) { root.innerHTML = loadingHtml(); return; }
    const overview = object(state.overview);
    const channels = object(overview.channels);
    const cards = [
      { id:'email', label:(globalThis.PlatformLanguage?.text("comms","m_5d2b9327181e33","Email") ?? "Email"), icon:'fa-envelope' },
      { id:'sms', label:(globalThis.PlatformLanguage?.text("comms","m_502193b4922098","Texts") ?? "Texts"), icon:'fa-comment-sms' },
      { id:'webchat', label:(globalThis.PlatformLanguage?.text("comms","m_a75cb043a6d759","Portal Chat") ?? "Portal Chat"), icon:'fa-message', tab:'chat' },
      { id:'call', label:(globalThis.PlatformLanguage?.text("comms","m_e830f5588df87c","Calls") ?? "Calls"), icon:'fa-phone', tab:'calls' }
    ].filter((card) => visibleTabs().some((tab) => tab.id === (card.tab || card.id)));
    const drafts = Array.isArray(overview.pending_ai_drafts) ? overview.pending_ai_drafts : [];
    const recent = Array.isArray(overview.recent) ? overview.recent : [];
    root.innerHTML = `
      ${String(errorHtml())}
      <div class="fmco-cards">
        ${String(cards.map((card) => {
          const bucket = object(channels[card.id]);
          const last = object(bucket.last_message);
          return `
            <div class="fmco-card">
              <div class="fmco-card-top">
                <span class="fmco-card-title"><i class="fa-solid ${card.icon}"></i>${esc(card.label)}</span>
                <button type="button" class="fmco-card-open" data-co-open="${card.tab || card.id}" title="${(globalThis.PlatformLanguage?.htmlText("comms","m_c25cc66b28cc9d","Open") ?? "Open")}"><i class="fa-solid fa-arrow-right"></i></button>
              </div>
              <div class="fmco-card-count">${Number(bucket.total || 0)}</div>
              <div class="fmco-card-sub">${bucket.total
                ? `${Number(bucket.inbound || 0)} received · last ${esc(timeLabel(last.created_at) || '—')}`
                : 'No messages yet'}</div>
            </div>
          `;
        }).join(''))}
      </div>
      ${String(drafts.length ? `
        <p class="fmco-section-title">${(globalThis.PlatformLanguage?.htmlText("comms","m_d9605e0a2440b7","AI drafts waiting for review") ?? "AI drafts waiting for review")}</p>
        ${drafts.map((draft) => `
          <div class="fmco-draft-card" data-draft-id="${esc(clean(draft.id))}">
            <div class="fmco-draft-head">
              <span class="fmco-draft-label"><i class="fa-solid fa-wand-magic-sparkles"></i>${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_2c58f3119aa8a0",`Drafted ${v1} reply`,{v1}) ?? `Drafted ${v1} reply`)(esc(clean(draft.channel) === 'sms' ? 'text' : 'email'))}</span>
              <span class="fmco-feed-time">${esc(timeLabel(draft.created_at))}</span>
            </div>
            <div class="fmco-draft-text">${esc(clean(object(draft.content).text))}</div>
            <div class="fmco-draft-actions">
              <button type="button" class="fmco-btn" data-co-draft-dismiss="${esc(clean(draft.id))}">${(globalThis.PlatformLanguage?.htmlText("comms","m_54fe29d1908de6","Dismiss") ?? "Dismiss")}</button>
              <button type="button" class="fmco-btn primary" data-co-draft-send="${esc(clean(draft.id))}"><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_c23a056552a09f","Send") ?? "Send")}</button>
            </div>
          </div>
        `).join('')}
      ` : '')}
      <p class="fmco-section-title">${(globalThis.PlatformLanguage?.htmlText("comms","m_de75c1482eb43a","Recent activity") ?? "Recent activity")}</p>
      ${String(recent.length ? `<div class="fmco-feed">${recent.map((message) => `
        <div class="fmco-feed-row" data-co-jump="${esc(clean(message.channel))}">
          <div class="fmco-feed-ico ${message.direction === 'inbound' ? 'inbound' : ''}">
            <i class="fa-solid ${CHANNEL_ICONS[message.channel] || 'fa-envelope'}"></i>
          </div>
          <div class="fmco-feed-main">
            <div class="fmco-feed-line1">
              <span class="fmco-feed-who">${esc(messageWho(message))}</span>
              ${message.direction === 'inbound' ? '<i class="fa-solid fa-arrow-down" style="font-size:9px;color:#12b76a"></i>' : '<i class="fa-solid fa-arrow-up" style="font-size:9px;color:#98a2b3"></i>'}
              ${badges(message)}
            </div>
            <div class="fmco-feed-preview">${esc(messagePreview(message))}</div>
          </div>
          <span class="fmco-feed-time">${esc(timeLabel(message.created_at))}</span>
        </div>
      `).join('')}</div>` : `
        <div class="fmco-empty"><i class="fa-solid fa-comments"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_5efa8e436e84a7","No communications on this project yet.") ?? "No communications on this project yet.")}</p></div>
      `)}
    `;
    root.querySelectorAll('[data-co-open]').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.coOpen, { pushRoute:true }));
    });
    root.querySelectorAll('[data-co-jump]').forEach((row) => {
      row.addEventListener('click', () => {
        const channel = row.dataset.coJump;
        setView(channel === 'webchat' ? 'chat' : channel === 'call' ? 'calls' : channel, { pushRoute:true });
      });
    });
    root.querySelectorAll('[data-co-draft-send]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api2().autoReplies.send(orgId(), projectId(), button.dataset.coDraftSend);
          await loadView();
        } catch (error) { state.error = error?.message || 'Could not send the draft.'; render(); }
      });
    });
    root.querySelectorAll('[data-co-draft-dismiss]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api2().autoReplies.dismiss(orgId(), projectId(), button.dataset.coDraftDismiss);
          await loadView();
        } catch (error) { state.error = error?.message || 'Could not dismiss the draft.'; render(); }
      });
    });
  }

  // Email ---------------------------------------------------------------------

  function emailListHtml(){
    const thread = state.emailThread;
    return `
      <button type="button" class="fmco-btn primary" data-co-compose style="justify-content:center"><i class="fa-solid fa-pen"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_71e31660564d5a","New email") ?? "New email")}</button>
      ${String(state.emailThreads.length ? state.emailThreads.map((item) => `
        <button type="button" class="fmco-thread-row${thread && thread.id === item.id ? ' active' : ''}" data-co-thread="${esc(clean(item.id))}">
          <span class="fmco-thread-subject"><span>${esc(clean(item.subject) || '(no subject)')}</span>${object(item.last_message).test_mode ? `<span class="fmco-test"><i class="fa-solid fa-flask"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_7068831b41c117","Test") ?? "Test")}</span>` : ''}</span>
          <span class="fmco-thread-meta"><span>${((v4,v5) => globalThis.PlatformLanguage?.htmlText("comms","m_2de5206655064d",`${v4} message${v5}`,{v4,v5}) ?? `${v4} message${v5}`)(Number(item.message_count || 0),Number(item.message_count || 0) === 1 ? '' : 's')}</span><span>${esc(timeLabel(item.last_message_at))}</span></span>
        </button>
      `).join('') : `<div class="fmco-empty"><i class="fa-solid fa-envelope-open"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_4aeca6bca783d6","No email threads yet.") ?? "No email threads yet.")}</p></div>`)}
    `;
  }

  function contactChipsHtml(channel, target){
    const key = channel === 'email' ? 'email' : 'phone';
    const contacts = overviewContacts();
    if (!contacts.length) return '';
    return `<div class="fmco-contact-options">${contacts.map((contact) => {
      const address = clean(contact[key]);
      const label = clean(contact.name) || address || 'Unnamed contact';
      return `<button type="button" class="fmco-contact-chip" data-co-add-${channel}="${esc(address)}" data-co-target="${target}" ${address ? '' : 'disabled'} title="${address ? esc(address) : `No ${key} on file`}">${esc(label)}${contact.primary ? ' · Primary' : ''}</button>`;
    }).join('')}</div>`;
  }

  function emailRecipientFieldsHtml(){
    return `
      <div class="fmco-recipient-box" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_911db27369deff","Email recipients") ?? "Email recipients")}">
        <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_af8bc9e774b68c","To") ?? "To")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.to))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_0864076e5066f2","name@example.com") ?? "name@example.com")}" data-co-email-to></label>
        <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_75c322757c6a34","CC") ?? "CC")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.cc))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_c3c1a5d95882ad","Add CC recipients") ?? "Add CC recipients")}" data-co-email-cc></label>
        <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_6ad86ac94efad5","BCC") ?? "BCC")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.bcc))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_529af833bc1e63","Add BCC recipients") ?? "Add BCC recipients")}" data-co-email-bcc></label>
      </div>
      ${String(contactChipsHtml('email', 'to'))}
    `;
  }

  function bindEmailList(scope){
    scope.querySelector('[data-co-compose]')?.addEventListener('click', () => { beginEmailDraft(); render(); });
    scope.querySelectorAll('[data-co-thread]').forEach((button) => {
      button.addEventListener('click', () => openEmailThread(button.dataset.coThread));
    });
  }

  function audioHtml(message){
    const note = message?.metadata?.audio_note;
    if (!note?.public_url || !rootWindow.FirstMateAudioNotes) return '';
    return `<div class="fmco-msg-audio">${rootWindow.FirstMateAudioNotes.playerHtml({ url:note.public_url, duration:note.duration_seconds, peaks:note.peaks })}</div>`;
  }

  function pageContextHtml(message){
    const page = object(object(message).metadata).page_context;
    if (!page || clean(message.direction) !== 'inbound') return '';
    const title = clean(page.tab_label || page.title) || 'Website page';
    const lines = (Array.isArray(page.visible_text) ? page.visible_text : []).slice(0, 6);
    const snapshotUrl = clean(object(page.snapshot).public_url);
    return `<div class="fmco-page-context" title="${(globalThis.PlatformLanguage?.htmlText("comms","m_26a1344cd9d9e0","Captured when this message was sent") ?? "Captured when this message was sent")}">
      <div class="fmco-page-context-head"><i class="fa-solid fa-window-maximize"></i><span><small>${(globalThis.PlatformLanguage?.htmlText("comms","m_4d70bd8d225412","Customer was viewing") ?? "Customer was viewing")}</small><strong>${String(esc(title))}</strong></span></div>
      ${String(snapshotUrl ? `<a class="fmco-page-shot" href="${esc(snapshotUrl)}" target="_blank" rel="noopener" title="${(globalThis.PlatformLanguage?.htmlText("comms","m_7dda15c6130ec4","Open the full page snapshot") ?? "Open the full page snapshot")}"><img src="${esc(snapshotUrl)}" alt="${((v2) => globalThis.PlatformLanguage?.htmlText("comms","m_9449db765fed60",`Snapshot of the ${v2} page`,{v2}) ?? `Snapshot of the ${v2} page`)(esc(title))}" loading="lazy"></a>` : '')}
      <div class="fmco-page-preview">${String(lines.length ? lines.map((line, index) => `<div class="fmco-page-line ${index === 0 ? 'title' : ''}" title="${esc(line)}">${esc(line)}</div>`).join('') : '<div class="fmco-page-line placeholder"></div><div class="fmco-page-line placeholder"></div><div class="fmco-page-line placeholder"></div>')}</div>
    </div>`;
  }

  async function recordComposerVoice(root, channel, input){
    const library = rootWindow.FirstMateAudioNotes;
    const mount = root.querySelector(`[data-co-${channel}-voice-mount]`);
    const mode = channel === 'chat' ? clean(state.chatVoice.mode || 'attachment') : clean(state.voiceSettings[channel] || 'dictation');
    if (!library || !mount || !input || mode === 'off') return;
    const button = root.querySelector(`[data-co-${channel}-voice]`);
    if (button) button.disabled = true;
    try {
      const prepared = await library.prepareInline(orgId(), '', {
        mount,
        mode,
        maxSeconds:channel === 'sms' ? 30 : channel === 'chat' ? Number(state.chatVoice.max_seconds || 120) : 120,
        ...(channel === 'sms' && mode === 'attachment' ? { format:'wav', sampleRate:8000 } : {}),
        onRemove:() => { state.pendingVoice[channel] = null; }
      });
      input.value = [clean(input.value), prepared.text].filter(Boolean).join(' ');
      if (prepared.attachment) state.pendingVoice[channel] = prepared;
      input.focus();
    } catch (error) {
      if (!/cancelled/i.test(clean(error?.message))) state.error = error?.message || 'Voice recording failed.';
    } finally {
      if (button) button.disabled = false;
    }
  }

  function restoreComposerVoice(root, channel){
    const prepared = state.pendingVoice[channel];
    const mount = root.querySelector(`[data-co-${channel}-voice-mount]`);
    if (!prepared?.attachment || !mount) return;
    rootWindow.FirstMateAudioNotes?.mountPrepared?.(mount, {
      url:prepared.attachment.public_url,
      duration:prepared.metadata?.duration_seconds,
      peaks:prepared.metadata?.peaks,
      onRemove:() => { state.pendingVoice[channel] = null; }
    });
  }

  function emailMsgsHtml(thread){
    return (Array.isArray(thread?.messages) ? thread.messages : []).map((message) => `
      <div class="fmco-msg-meta ${message.direction}">${esc(messageWho(message))} · ${esc(timeLabel(message.created_at))} ${badges(message)}</div>
      <div class="fmco-msg ${message.direction}${message.source_kind === 'ai' ? ' ai' : ''}">${clean(message.subject) && message.direction === 'inbound' ? `<div class="fmco-msg-subject">${esc(clean(message.subject))}</div>` : ''}${esc(clean(message.text))}${audioHtml(message)}</div>
    `).join('');
  }

  function renderEmail(root){
    if (state.loading && !state.emailThreads.length && !state.emailThread) { root.innerHTML = loadingHtml(); return; }
    const thread = state.emailThread;
    root.innerHTML = `
      ${errorHtml()}
      <div class="fmco-split${thread || state.emailComposeOpen ? ' thread-mode' : ''}" style="height:100%">
        <div class="fmco-list-col" data-co-list>${emailListHtml()}</div>
        <div class="fmco-thread-view">
          ${thread ? `
            <div class="fmco-thread-head">
              <div style="min-width:0"><div class="fmco-thread-title">${String(esc(clean(thread.subject) || '(no subject)'))}</div><div class="fmco-recipient-summary" title="${String(esc(recipientNames(thread.participants)))}">${((v2) => globalThis.PlatformLanguage?.htmlText("comms","m_4a4203a7cc18a9",`With ${v2}`,{v2}) ?? `With ${v2}`)(esc(recipientNames(thread.participants)))}</div></div>
              <button type="button" class="fmco-btn" data-co-thread-close><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fmco-msgs" data-co-scroll>${String(emailMsgsHtml(thread))}</div>
            <div class="fmco-composer">
              <textarea class="fmco-textarea" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_cecfa49a90d03c","Write a reply…") ?? "Write a reply…")}" data-co-email-reply></textarea>
              <div class="fmco-composer-row">
                <span class="fmco-composer-hint">${((v4) => globalThis.PlatformLanguage?.htmlText("comms","m_9efa62529d102d",`Replies thread automatically${v4}`,{v4}) ?? `Replies thread automatically${v4}`)(state.inboxAddress ? ` · from ${esc(state.inboxAddress)}` : '')}</span>
                <div class="fmco-voice-mount" data-co-email-voice-mount></div>${String(clean(state.voiceSettings.email) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-email-voice><i class="fa-solid fa-microphone"></i><small>${(globalThis.PlatformLanguage?.htmlText("comms","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}</small></button>` : '')}
                <button type="button" class="fmco-btn primary" data-co-email-reply-send><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_c23a056552a09f","Send") ?? "Send")}</button>
              </div>
            </div>
          ` : state.emailComposeOpen ? `
            <div class="fmco-thread-head"><span class="fmco-thread-title">${(globalThis.PlatformLanguage?.htmlText("comms","m_71e31660564d5a","New email") ?? "New email")}</span><button type="button" class="fmco-btn" data-co-thread-close><i class="fa-solid fa-xmark"></i></button></div>
            <div class="fmco-composer" style="border-top:0">
              ${String(emailRecipientFieldsHtml())}
              <input type="text" class="fmco-input" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_bfb9f300f17496","Subject") ?? "Subject")}" data-co-email-subject>
              <textarea class="fmco-textarea" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_a2585fc6c21d1a","Write your email…") ?? "Write your email…")}" style="min-height:150px" data-co-email-body></textarea>
              <div class="fmco-composer-row">
                <span class="fmco-composer-hint">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_e5d7f79d2a0498",`Separate multiple addresses with commas${v1}`,{v1}) ?? `Separate multiple addresses with commas${v1}`)(state.inboxAddress ? ` · from ${esc(state.inboxAddress)}` : '')}</span>
                <div class="fmco-voice-mount" data-co-email-voice-mount></div>${String(clean(state.voiceSettings.email) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-email-voice><i class="fa-solid fa-microphone"></i><small>${(globalThis.PlatformLanguage?.htmlText("comms","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}</small></button>` : '')}
                <button type="button" class="fmco-btn primary" data-co-email-send><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_c23a056552a09f","Send") ?? "Send")}</button>
              </div>
            </div>
          ` : `
            <div class="fmco-empty" style="align-self:center;margin:auto"><i class="fa-solid fa-envelope"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_ee23091a29828f","Select a thread or start a new email.") ?? "Select a thread or start a new email.")}</p></div>
          `}
        </div>
      </div>
    `;
    bindEmailList(root.querySelector('[data-co-list]') || root);
    root.querySelector('[data-co-thread-close]')?.addEventListener('click', () => { state.emailThread = null; state.emailComposeOpen = false; render(); });
    [['to','[data-co-email-to]'], ['cc','[data-co-email-cc]'], ['bcc','[data-co-email-bcc]']].forEach(([key, selector]) => {
      root.querySelector(selector)?.addEventListener('input', (event) => { state.emailDraft[key] = event.target.value; });
    });
    root.querySelectorAll('[data-co-add-email]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = clean(button.dataset.coTarget) || 'to';
        state.emailDraft[target] = addRecipient(state.emailDraft[target], clean(button.dataset.coAddEmail));
        render();
      });
    });
    root.querySelector('[data-co-email-voice]')?.addEventListener('click', () => {
      recordComposerVoice(root, 'email', root.querySelector('[data-co-email-reply]') || root.querySelector('[data-co-email-body]'));
    });
    root.querySelector('[data-co-email-send]')?.addEventListener('click', async (event) => {
      const to = splitRecipients(root.querySelector('[data-co-email-to]')?.value);
      const cc = splitRecipients(root.querySelector('[data-co-email-cc]')?.value);
      const bcc = splitRecipients(root.querySelector('[data-co-email-bcc]')?.value);
      const subject = clean(root.querySelector('[data-co-email-subject]')?.value);
      const body = clean(root.querySelector('[data-co-email-body]')?.value);
      if (!to.length || !subject || !body || state.sending) return;
      state.sending = true; event.currentTarget.disabled = true;
      try {
        const sent = await api2().email.send(orgId(), projectId(), { to, cc, bcc, subject, text: body });
        const conversationId = clean(object(sent.message).conversation_id);
        state.emailComposeOpen = false;
        await loadView();
        if (conversationId) await openEmailThread(conversationId);
      } catch (error) { state.error = error?.message || 'Could not send the email.'; render(); }
      state.sending = false;
    });
    root.querySelector('[data-co-email-reply-send]')?.addEventListener('click', async (event) => {
      const body = clean(root.querySelector('[data-co-email-reply]')?.value);
      if (!body || !thread || state.sending) return;
      state.sending = true; event.currentTarget.disabled = true;
      try {
        await api2().email.send(orgId(), projectId(), {
          subject: `Re: ${clean(thread.subject) || 'your message'}`.replace(/^Re: Re:/i, 'Re:'),
          text: body,
          conversation_id: clean(thread.id)
        });
        await openEmailThread(clean(thread.id));
      } catch (error) { state.error = error?.message || 'Could not send the reply.'; render(); }
      state.sending = false;
    });
    scrollBottom(root);
  }

  // SMS -----------------------------------------------------------------------

  function smsConversations(){
    return Array.isArray(object(state.sms).conversations) ? object(state.sms).conversations : [];
  }

  function activeSmsConversation(){
    return smsConversations().find((conversation) => clean(conversation.id) === state.activeSmsId) || null;
  }

  function smsListHtml(){
    const active = activeSmsConversation();
    return `
      <button type="button" class="fmco-btn primary" data-co-sms-compose style="justify-content:center"><i class="fa-solid fa-pen"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_3c10edbba72365","New text") ?? "New text")}</button>
      ${String(smsConversations().length ? smsConversations().map((conversation) => `
        <button type="button" class="fmco-thread-row${active && clean(active.id) === clean(conversation.id) ? ' active' : ''}" data-co-sms-thread="${esc(clean(conversation.id))}">
          <span class="fmco-thread-subject"><span>${esc(recipientNames(conversation.participants))}</span>${object(conversation.last_message).test_mode ? `<span class="fmco-test"><i class="fa-solid fa-flask"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_7068831b41c117","Test") ?? "Test")}</span>` : ''}</span>
          <span class="fmco-thread-meta"><span>${((v4,v5) => globalThis.PlatformLanguage?.htmlText("comms","m_2de5206655064d",`${v4} message${v5}`,{v4,v5}) ?? `${v4} message${v5}`)(Number(conversation.message_count || 0),Number(conversation.message_count || 0) === 1 ? '' : 's')}</span><span>${esc(timeLabel(conversation.last_message_at))}</span></span>
        </button>
      `).join('') : `<div class="fmco-empty"><i class="fa-solid fa-comment-sms"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_25af8c4f012bc1","No text threads yet.") ?? "No text threads yet.")}</p></div>`)}
    `;
  }

  function bindSmsList(scope){
    scope.querySelector('[data-co-sms-compose]')?.addEventListener('click', () => { beginSmsDraft(); render(); });
    scope.querySelectorAll('[data-co-sms-thread]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeSmsId = clean(button.dataset.coSmsThread);
        state.smsComposeOpen = false;
        render();
      });
    });
  }

  function smsMsgsHtml(conversation){
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    return messages.length ? messages.map((message) => `
      <div class="fmco-msg-meta ${message.direction}">${esc(messageWho(message))} · ${esc(timeLabel(message.created_at))} ${badges(message)}</div>
      <div class="fmco-msg ${message.direction}${message.source_kind === 'ai' ? ' ai' : ''}">${esc(clean(message.text))}${audioHtml(message)}</div>
    `).join('') : `<div class="fmco-empty" style="margin:auto"><i class="fa-solid fa-comment-sms"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_06fc4f53d27077","No text messages yet.") ?? "No text messages yet.")}</p></div>`;
  }

  function renderSms(root){
    if (state.loading && !state.sms) { root.innerHTML = loadingHtml(); return; }
    const active = activeSmsConversation();
    const hasWorkspace = state.smsComposeOpen || active;
    root.innerHTML = `
      ${errorHtml()}
      <div class="fmco-split${hasWorkspace ? ' thread-mode' : ''}" style="height:100%">
        <div class="fmco-list-col" data-co-list>${smsListHtml()}</div>
        <div class="fmco-thread-view">
          ${state.smsComposeOpen ? `
            <div class="fmco-thread-head"><span class="fmco-thread-title">${(globalThis.PlatformLanguage?.htmlText("comms","m_3c10edbba72365","New text") ?? "New text")}</span><button type="button" class="fmco-btn" data-co-sms-close><i class="fa-solid fa-xmark"></i></button></div>
            <div class="fmco-composer" style="border-top:0">
              <div class="fmco-recipient-box" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_9cdf1c6f55699f","Text recipients") ?? "Text recipients")}">
                <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_af8bc9e774b68c","To") ?? "To")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.smsDraft.to))}" placeholder="+1 206 555 1234" data-co-sms-to></label>
              </div>
              ${String(contactChipsHtml('sms', 'to'))}
              <textarea class="fmco-textarea" style="min-height:110px" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_00e2352d42e80c","Write a text message…") ?? "Write a text message…")}" data-co-sms-input></textarea>
              <div class="fmco-composer-row">
                <span class="fmco-composer-hint">${(globalThis.PlatformLanguage?.htmlText("comms","m_6530a8d89e9c93","Separate multiple phone numbers with commas to start a group thread") ?? "Separate multiple phone numbers with commas to start a group thread")}</span>
                <div class="fmco-voice-mount" data-co-sms-voice-mount></div>${String(clean(state.voiceSettings.sms) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-sms-voice><i class="fa-solid fa-microphone"></i><small>${clean(state.voiceSettings.sms) === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
                <button type="button" class="fmco-btn primary" data-co-sms-send><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_c23a056552a09f","Send") ?? "Send")}</button>
              </div>
            </div>
          ` : active ? `
            <div class="fmco-thread-head">
              <div style="min-width:0"><div class="fmco-thread-title"><i class="fa-solid fa-comment-sms" style="margin-right:7px;color:#667085"></i>${String(esc(recipientNames(active.participants)))}</div><div class="fmco-recipient-summary">${String(esc((active.participants || []).map((participant) => clean(participant.address)).filter(Boolean).join(', ')))}</div></div>
              <button type="button" class="fmco-btn" data-co-sms-close><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fmco-msgs" data-co-scroll>${String(smsMsgsHtml(active))}</div>
            <div class="fmco-composer">
              <div style="display:flex;gap:8px;align-items:flex-end">
                <textarea class="fmco-textarea" style="min-height:44px" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_00e2352d42e80c","Write a text message…") ?? "Write a text message…")}" data-co-sms-input></textarea>
                ${String(clean(state.voiceSettings.sms) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-sms-voice><i class="fa-solid fa-microphone"></i><small>${clean(state.voiceSettings.sms) === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
                <button type="button" class="fmco-btn primary" style="height:38px" data-co-sms-send><i class="fa-solid fa-paper-plane"></i></button>
              </div>
              <div class="fmco-voice-mount" data-co-sms-voice-mount></div>
              <div class="fmco-composer-row"><span class="fmco-composer-hint">${(globalThis.PlatformLanguage?.htmlText("comms","m_d28416ff3f0c41","Sends to everyone shown above from your business number") ?? "Sends to everyone shown above from your business number")}</span></div>
            </div>
          ` : `<div class="fmco-empty" style="margin:auto"><i class="fa-solid fa-comment-sms"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_bd100abbcef202","Select a text thread or start a new one.") ?? "Select a text thread or start a new one.")}</p></div>`}
        </div>
      </div>
    `;
    bindSmsList(root.querySelector('[data-co-list]') || root);
    root.querySelector('[data-co-sms-close]')?.addEventListener('click', () => {
      state.smsComposeOpen = false;
      state.activeSmsId = '';
      render();
    });
    root.querySelector('[data-co-sms-to]')?.addEventListener('input', (event) => { state.smsDraft.to = event.target.value; });
    root.querySelectorAll('[data-co-add-sms]').forEach((button) => {
      button.addEventListener('click', () => {
        state.smsDraft.to = addRecipient(state.smsDraft.to, clean(button.dataset.coAddSms));
        render();
      });
    });
    root.querySelector('[data-co-sms-voice]')?.addEventListener('click', () => recordComposerVoice(root, 'sms', root.querySelector('[data-co-sms-input]')));
    restoreComposerVoice(root, 'sms');
    root.querySelector('[data-co-sms-send]')?.addEventListener('click', async (event) => {
      const input = root.querySelector('[data-co-sms-input]');
      const text = clean(input?.value);
      const to = state.smsComposeOpen ? splitRecipients(root.querySelector('[data-co-sms-to]')?.value) : [];
      if (!text || (state.smsComposeOpen && !to.length) || state.sending) return;
      state.sending = true; event.currentTarget.disabled = true;
      try {
        const voice = state.pendingVoice.sms;
        const audioNote = voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {};
        const sent = await api2().sms.send(orgId(), projectId(), state.smsComposeOpen
          ? { to, text, ...audioNote }
          : { conversation_id:clean(active?.id), text, ...audioNote });
        state.activeSmsId = clean(object(sent.message).conversation_id) || clean(active?.id);
        state.smsComposeOpen = false;
        if (input) input.value = '';
        state.pendingVoice.sms = null;
        await loadView();
      } catch (error) { state.error = error?.message || 'Could not send the text.'; render(); }
      state.sending = false;
    });
    scrollBottom(root);
    rootWindow.FirstMateAudioNotes?.hydrate?.(root);
  }

  // Portal chat ---------------------------------------------------------------

  function chatActiveConversation(){
    return state.chatConversations.find((conversation) => clean(conversation.id) === state.activeChatId) || null;
  }

  function chatListHtml(){
    const conversations = state.chatConversations;
    const active = chatActiveConversation();
    return conversations.length ? conversations.map((conversation) => `
      <button type="button" class="fmco-thread-row${String(active && clean(conversation.id) === clean(active.id) ? ' active' : '')}" data-co-chat="${String(esc(clean(conversation.id)))}">
        <span class="fmco-thread-subject"><span><i class="fa-solid fa-message" style="margin-right:6px;color:#667085"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_2ad7b94cffe1d4","Portal chat") ?? "Portal chat")}</span></span>
        <span class="fmco-thread-meta"><span>${String(esc(clean(object(conversation.last_message).text).slice(0, 44)))}</span><span>${String(esc(timeLabel(conversation.last_message_at)))}</span></span>
      </button>
    `).join('') : `<div class="fmco-empty"><i class="fa-solid fa-message"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_816bc81cdff2c4","No portal chat conversations for this project yet.") ?? "No portal chat conversations for this project yet.")}</p></div>`;
  }

  function bindChatList(scope){
    scope.querySelectorAll('[data-co-chat]').forEach((button) => {
      button.addEventListener('click', () => { state.activeChatId = button.dataset.coChat; render(); });
    });
  }

  function chatMsgsHtml(active){
    return (Array.isArray(active?.messages) ? active.messages : []).map((message) => `
      <div class="fmco-msg-meta ${message.direction}">${esc(messageWho(message))} · ${esc(timeLabel(message.created_at))} ${badges(message)}</div>
      <div class="fmco-msg ${message.direction}${message.source_kind === 'ai' ? ' ai' : ''}">${esc(clean(message.text))}${audioHtml(message)}</div>
      ${pageContextHtml(message)}
    `).join('');
  }

  function renderChat(root){
    if (state.loading && !state.chatConversations.length) { root.innerHTML = loadingHtml(); return; }
    const active = chatActiveConversation();
    root.innerHTML = `
      ${errorHtml()}
      <div class="fmco-split${active ? ' thread-mode' : ''}" style="height:100%">
        <div class="fmco-list-col" data-co-list>${chatListHtml()}</div>
        <div class="fmco-thread-view">
          ${active ? `
            <div class="fmco-thread-head">
              <span class="fmco-thread-title">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_b968d55aeebd47",`Portal chat · ${v0}`,{v0}) ?? `Portal chat · ${v0}`)(esc(clean(active.status) || 'open'))}</span>
            </div>
            <div class="fmco-msgs" data-co-scroll>${String(chatMsgsHtml(active))}</div>
            <div class="fmco-composer">
              <div style="display:flex;gap:8px;align-items:flex-end">
                <textarea class="fmco-textarea" style="min-height:44px" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_5287d898a85931","Reply in the customer portal chat…") ?? "Reply in the customer portal chat…")}" data-co-chat-input></textarea>
                ${String(clean(state.chatVoice.mode) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-chat-voice><i class="fa-solid fa-microphone"></i><small>${clean(state.chatVoice.mode) === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
                <button type="button" class="fmco-btn primary" style="height:38px" data-co-chat-send><i class="fa-solid fa-paper-plane"></i></button>
              </div>
              <div class="fmco-voice-mount" data-co-chat-voice-mount></div>
              <div class="fmco-composer-row"><span class="fmco-composer-hint">${(globalThis.PlatformLanguage?.htmlText("comms","m_db210487843b3a","The customer sees this in their portal chat instantly") ?? "The customer sees this in their portal chat instantly")}</span></div>
            </div>
          ` : `<div class="fmco-empty" style="margin:auto"><i class="fa-solid fa-message"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_43e38330c9efc3","Select a conversation.") ?? "Select a conversation.")}</p></div>`}
        </div>
      </div>
    `;
    bindChatList(root.querySelector('[data-co-list]') || root);
    root.querySelector('[data-co-chat-voice]')?.addEventListener('click', () => recordComposerVoice(root, 'chat', root.querySelector('[data-co-chat-input]')));
    restoreComposerVoice(root, 'chat');
    root.querySelector('[data-co-chat-send]')?.addEventListener('click', async (event) => {
      const input = root.querySelector('[data-co-chat-input]');
      const text = clean(input?.value);
      if (!text || !active || state.sending) return;
      state.sending = true; event.target.disabled = true;
      try {
        const voice = state.pendingVoice.chat;
        await api2().chat.send(orgId(), projectId(), clean(active.id), {
          message:text,
          ...(voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {})
        });
        if (input) input.value = '';
        state.pendingVoice.chat = null;
        await loadView();
      } catch (error) { state.error = error?.message || 'Could not send the chat reply.'; render(); }
      state.sending = false;
    });
    scrollBottom(root);
    rootWindow.FirstMateAudioNotes?.hydrate?.(root);
  }

  // Search --------------------------------------------------------------------

  function renderSearch(root){
    const results = state.search.results;
    root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <p class="fmco-section-title" style="margin:0">${((v0) => globalThis.PlatformLanguage?.htmlText("comms","m_0e1b50405bc620",`Search results${v0}`,{v0}) ?? `Search results${v0}`)(state.search.busy ? ' · searching…' : ` · ${results.length}`)}</p>
        <button type="button" class="fmco-btn" data-co-search-close><i class="fa-solid fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_3742924668fb10","Close") ?? "Close")}</button>
      </div>
      ${String(results.length ? `<div class="fmco-feed">${results.map((hit) => `
        <div class="fmco-feed-row" data-co-hit-channel="${esc(clean(hit.channel))}" data-co-hit-conversation="${esc(clean(hit.conversation_id))}">
          <div class="fmco-feed-ico ${hit.direction === 'inbound' ? 'inbound' : ''}"><i class="fa-solid ${CHANNEL_ICONS[hit.channel] || 'fa-envelope'}"></i></div>
          <div class="fmco-feed-main">
            <div class="fmco-feed-line1"><span class="fmco-feed-who">${esc(messageWho(hit))}</span>${badges(hit)}</div>
            <div class="fmco-result-snippet">${clean(hit.snippet) ? esc(clean(hit.snippet)).replace(/\[(.*?)\]/g, '<b>$1</b>') : esc(messagePreview(hit))}</div>
          </div>
          <span class="fmco-feed-time">${esc(timeLabel(hit.created_at))}</span>
        </div>
      `).join('')}</div>` : (state.search.busy ? loadingHtml() : `<div class="fmco-empty"><i class="fa-solid fa-magnifying-glass"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_ceb00ee26ffd50","No messages match that search.") ?? "No messages match that search.")}</p></div>`))}
    `;
    root.querySelector('[data-co-search-close]')?.addEventListener('click', () => {
      state.search.open = false;
      const input = state.panelRoot?.querySelector('[data-co-search]');
      if (input) input.value = '';
      render();
    });
    root.querySelectorAll('[data-co-hit-channel]').forEach((row) => {
      row.addEventListener('click', async () => {
        const channel = row.dataset.coHitChannel;
        const conversationId = clean(row.dataset.coHitConversation);
        state.search.open = false;
        if (channel === 'email') {
          setView('email', { pushRoute:true });
          if (conversationId) await openEmailThread(conversationId);
        } else if (channel === 'webchat') {
          state.activeChatId = conversationId;
          setView('chat', { pushRoute:true });
        } else {
          setView('sms', { pushRoute:true });
        }
      });
    });
  }

  let searchTimer = 0;
  function bindSearch(){
    const input = state.panelRoot?.querySelector('[data-co-search]');
    if (!input || input.dataset.coBound === '1') return;
    input.dataset.coBound = '1';
    input.addEventListener('input', () => {
      const query = clean(input.value);
      state.search.query = query;
      if (searchTimer) clearTimeout(searchTimer);
      if (!query) { state.search.open = false; render(); return; }
      searchTimer = setTimeout(async () => {
        state.search.open = true;
        state.search.busy = true;
        render();
        try {
          const result = await api2().search(orgId(), { q:query, project_id:projectId() });
          state.search.results = Array.isArray(result.results) ? result.results : [];
        } catch (_) {
          state.search.results = [];
        }
        state.search.busy = false;
        render();
      }, 280);
    });
  }

  // AI agent panel ------------------------------------------------------------

  function renderAgentPanel(){
    const host = state.panelRoot?.querySelector('[data-co-agent]');
    if (!host) return;
    host.hidden = !state.agent.open;
    renderTabs();
    if (!state.agent.open) return;
    host.innerHTML = `
      <div class="fmco-agent-head">
        <span class="fmco-agent-title"><i class="fa-solid fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_4a042d7afc906b","Comms AI") ?? "Comms AI")}</span>
        <button type="button" class="fmco-btn" data-co-agent-close><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="fmco-agent-msgs" data-co-agent-scroll>
        ${String(state.agent.error ? `<div class="fmco-error">${esc(state.agent.error)}</div>` : '')}
        ${String(state.agent.messages.length ? state.agent.messages.map((message) => rootWindow.FirstMateAgentChat
          ? rootWindow.FirstMateAgentChat.messageHtml(message, { prefix:'fmco-agent', userClass:'fmco-agent-msg user', assistantClass:'fmco-agent-msg assistant' })
          : `<div class="fmco-agent-msg ${clean(message.role) === 'user' ? 'user' : 'assistant'}${message.pending ? ' pending' : ''}">${esc(clean(message.content))}</div>`
        ).join('') : `<div class="fmco-empty" style="padding:20px"><i class="fa-solid fa-wand-magic-sparkles"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_de3e46c965f4d6","Ask anything about this project’s communications — or ask me to reply, schedule, or follow up.") ?? "Ask anything about this project’s communications — or ask me to reply, schedule, or follow up.")}</p></div>`)}
      </div>
      <div class="fmco-agent-composer">
        <textarea placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_dfdbb257902462","Ask about these conversations…") ?? "Ask about these conversations…")}" data-co-agent-input></textarea>
        <button type="button" class="fmco-agent-send" data-co-agent-send ${String(state.agent.busy ? 'disabled' : '')}><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    `;
    rootWindow.FirstMateAgentChat?.injectBaseCss?.('fmco-agent');
    rootWindow.FirstMateAgentChat?.bindActions?.(host, state.agent.messages);
    host.querySelector('[data-co-agent-close]')?.addEventListener('click', () => { state.agent.open = false; renderAgentPanel(); });
    const input = host.querySelector('[data-co-agent-input]');
    const send = async () => {
      const text = clean(input?.value);
      if (!text || state.agent.busy) return;
      state.agent.busy = true;
      state.agent.messages.push({ role:'user', content:text });
      state.agent.messages.push({ role:'assistant', content:'Working…', pending:true });
      if (input) input.value = '';
      renderAgentPanel();
      try {
        if (!state.agent.threadId) {
          const created = await api2().agent.createThread(orgId(), projectId());
          state.agent.threadId = clean(object(created.thread).id);
        }
        const result = await api2().agent.send(orgId(), projectId(), state.agent.threadId, { message:text });
        state.agent.messages = state.agent.messages.filter((message) => !message.pending);
        const assistant = object(result.assistant_message);
        state.agent.messages.push({ id: clean(assistant.id), role:'assistant', content: clean(assistant.content) || 'Done.', data: object(assistant.data) });
        // Agent actions may have changed the feed (sent messages, drafts).
        loadView().catch(() => null);
      } catch (error) {
        state.agent.messages = state.agent.messages.filter((message) => !message.pending);
        state.agent.messages.push({ role:'assistant', content: error?.message || 'The comms agent is unavailable right now.' });
      }
      state.agent.busy = false;
      renderAgentPanel();
    };
    host.querySelector('[data-co-agent-send]')?.addEventListener('click', send);
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    const scroll = host.querySelector('[data-co-agent-scroll]');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function bindAgentToggle(){
    const button = state.panelRoot?.querySelector('[data-co-ai-toggle]');
    if (!button || button.dataset.coBound === '1') return;
    button.dataset.coBound = '1';
    button.addEventListener('click', async () => {
      state.agent.open = !state.agent.open;
      state.agent.error = '';
      renderAgentPanel();
      if (state.agent.open && !state.agent.threadId) {
        try {
          const result = await api2().agent.threads(orgId(), projectId());
          const threads = Array.isArray(result.threads) ? result.threads : [];
          if (threads.length) {
            state.agent.threadId = clean(threads[0].id);
            const detail = await api2().agent.thread(orgId(), projectId(), state.agent.threadId);
            state.agent.messages = (Array.isArray(detail.messages) ? detail.messages : [])
              .map((message) => ({ id:clean(message.id), role:clean(message.role), content:clean(message.content), data:object(message.data) }));
          }
        } catch (error) {
          // A blank panel with no explanation reads as "broken" — say why.
          state.agent.error = error?.message || 'Could not load the AI conversation history.';
        }
        renderAgentPanel();
      }
    });
  }

  // Left column ---------------------------------------------------------------

  const NOTIFY_ROLES = [
    { id:'office', label:(globalThis.PlatformLanguage?.text("comms","m_aa20efe27f3230","Office") ?? "Office") },
    { id:'sales', label:(globalThis.PlatformLanguage?.text("comms","m_2680c31facb03d","Sales") ?? "Sales") },
    { id:'operations', label:(globalThis.PlatformLanguage?.text("comms","m_33dfb8f7cb012a","Operations") ?? "Operations") },
    { id:'crew', label:(globalThis.PlatformLanguage?.text("comms","m_5b8ee9e9110e54","Crew") ?? "Crew") }
  ];

  function leftContentRoot(){
    return state.settingsDrawer?.querySelector('[data-project-comms-settings]')||null;
  }
  function legacyLeftContentRoot(){
    // The left region app can render after our mount; resolve lazily.
    if (!state.leftRoot || !state.leftRoot.isConnected) {
      state.leftRoot = state.context?.leftRoot || state.context?.roots?.left
        || document.querySelector('#rOverlay #rProposalSection') || state.leftRoot;
    }
    if (!state.leftRoot) return null;
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel">${(globalThis.PlatformLanguage?.htmlText("comms","m_da0c54815d9259","Comms") ?? "Comms")}</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  async function loadLeftData(){
    if (state.settings.loaded || !api2() || !orgId() || !projectId()) return;
    try {
      const [result, globalResult] = await Promise.all([
        api2().settings.loadProject(orgId(), projectId()),
        api2().settings.load(orgId())
      ]);
      state.settings.overrides = object(result.overrides);
      state.voiceSettings = { ...state.voiceSettings, ...object(object(globalResult.settings).voice) };
      state.settings.loaded = true;
      renderLeft({ force:true });
    } catch (_) {}
  }

  let leftRetryTimer = 0;
  let leftRetries = 0;
  function renderLeft(options = {}){
    if (!state.active || !state.mounted) return;
    if(!state.settingsDrawer?.isConnected)return;
    const target = leftContentRoot();
    if (!target) {
      // The left region app can mount after us on a direct deep link; retry
      // briefly instead of waiting for the next poll.
      if (leftRetries < 10 && !leftRetryTimer) {
        leftRetries += 1;
        leftRetryTimer = setTimeout(() => { leftRetryTimer = 0; renderLeft(); }, 350);
      }
      return;
    }
    leftRetries = 0;
    // Poll-driven refreshes must not rebuild the column while it exists —
    // that would wipe in-progress edits in the instructions textarea. Only a
    // missing shell (first render / region-app re-render) or an explicit
    // force (settings save) rebuilds.
    const existing = target.querySelector('.fmco-left');
    if (existing && !options.force) {
      if (existing.contains(document.activeElement)) return;
      const overviewNow = object(state.overview);
      const channelsNow = object(overviewNow.channels);
      existing.querySelectorAll('[data-co-stat]').forEach((node) => {
        node.textContent = String(Number(object(channelsNow[node.dataset.coStat]).total || 0));
      });
      return;
    }
    // The left region is a SHARED container (#rProposalList) that other main
    // apps (proposals, materials) render into and never clear when their tab
    // deactivates. Take full ownership: drop everything that isn't ours —
    // the owner app rebuilds its content when its own tab activates again.
    Array.from(target.children || []).forEach((child) => {
      if (!child.classList || !child.classList.contains('fmco-left')) child.remove();
    });
    target.querySelector?.('.fmco-left')?.remove();
    const overrides = object(state.settings.overrides);
    const notifications = object(overrides.notifications);
    const inherit = notifications.inherit !== false;
    const roles = Array.isArray(notifications.target_role_ids) ? notifications.target_role_ids : [];
    const overview = object(state.overview);
    const channels = object(overview.channels);
    const shell = document.createElement('div');
    shell.className = 'fmco-left';
    shell.innerHTML = `
      <div class="fmco-left-card">
        <span class="fmco-left-title"><i class="fa-solid fa-tower-broadcast"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_dc8b4f6c066b30","Channels") ?? "Channels")}</span>
        ${String(state.inboxAddress ? `<div class="fmco-left-row"><i class="fa-solid fa-envelope"></i><span title="${esc(state.inboxAddress)}">${esc(state.inboxAddress)}</span></div>` : '')}
        <div class="fmco-left-stat"><span>${(globalThis.PlatformLanguage?.htmlText("comms","m_5d2b9327181e33","Email") ?? "Email")}</span><b data-co-stat="email">${String(Number(object(channels.email).total || 0))}</b></div>
        <div class="fmco-left-stat"><span>${(globalThis.PlatformLanguage?.htmlText("comms","m_502193b4922098","Texts") ?? "Texts")}</span><b data-co-stat="sms">${String(Number(object(channels.sms).total || 0))}</b></div>
        <div class="fmco-left-stat"><span>${(globalThis.PlatformLanguage?.htmlText("comms","m_2ad7b94cffe1d4","Portal chat") ?? "Portal chat")}</span><b data-co-stat="webchat">${String(Number(object(channels.webchat).total || 0))}</b></div>
      </div>
      <div class="fmco-left-card">
        <span class="fmco-left-title"><i class="fa-solid fa-bell"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_1c74bcbcebceaa","Who gets notified") ?? "Who gets notified")}</span>
        <div class="fmco-role-chips">
          <button type="button" class="fmco-role-chip${String(inherit ? ' on' : '')}" data-co-notify-inherit>${(globalThis.PlatformLanguage?.htmlText("comms","m_4072ee4e7867cd","Company default") ?? "Company default")}</button>
          ${String(NOTIFY_ROLES.map((role) => `
            <button type="button" class="fmco-role-chip${!inherit && roles.includes(role.id) ? ' on' : ''}" data-co-notify-role="${role.id}" ${inherit ? 'disabled' : ''}>${esc(role.label)}</button>
          `).join(''))}
        </div>
        <span class="fmco-left-hint">${(globalThis.PlatformLanguage?.htmlText("comms","m_69062bfc16f5e8","Inbound customer messages on this project notify these people. Pipeline automations can add stage-based routing on top.") ?? "Inbound customer messages on this project notify these people. Pipeline automations can add stage-based routing on top.")}</span>
      </div>
      ${String(can('comms.agent') ? `
        <div class="fmco-left-card">
          <span class="fmco-left-title"><i class="fa-solid fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_9b382173066415","AI for this project") ?? "AI for this project")}</span>
          <textarea data-co-agent-notes placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_f21cbc2e6a63ee","Project-specific instructions, e.g. “Customer prefers texts, never call before noon.”") ?? "Project-specific instructions, e.g. “Customer prefers texts, never call before noon.”")}">${esc(clean(overrides.agent_instructions))}</textarea>
          ${can('comms.auto_response') ? `
            <select data-co-auto-mode>
              <option value="inherit"${clean(overrides.auto_response) === 'inherit' || !clean(overrides.auto_response) ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("comms","m_c0888d774a9fc5","Auto-reply: company default") ?? "Auto-reply: company default")}</option>
              <option value="off"${clean(overrides.auto_response) === 'off' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("comms","m_d398221c829b80","Auto-reply: off for this project") ?? "Auto-reply: off for this project")}</option>
              <option value="draft"${clean(overrides.auto_response) === 'draft' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("comms","m_4fa2295071335a","Auto-reply: draft for review") ?? "Auto-reply: draft for review")}</option>
              <option value="send"${clean(overrides.auto_response) === 'send' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("comms","m_ff3f10c06cefde","Auto-reply: send automatically") ?? "Auto-reply: send automatically")}</option>
            </select>
          ` : ''}
          <button type="button" class="fmco-btn primary fmco-left-save" data-co-left-save ${state.settings.saving ? 'disabled' : ''}>${state.settings.saving ? 'Saving…' : 'Save'}</button>
        </div>
      ` : '')}
      <div class="fmco-left-card">
        <span class="fmco-left-title"><i class="fa-solid fa-flask"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_4ee0964bb70748","Test mode") ?? "Test mode")}</span>
        <span class="fmco-left-hint">${(globalThis.PlatformLanguage?.htmlText("comms","m_597802c753ea62","Deliveries are in test mode: outbound messages are recorded here with a Test badge but not delivered. Simulate the customer replying to exercise notifications, automations, and AI.") ?? "Deliveries are in test mode: outbound messages are recorded here with a Test badge but not delivered. Simulate the customer replying to exercise notifications, automations, and AI.")}</span>
        <div style="display:flex;gap:6px">
          ${String(can('comms.email') ? `<button type="button" class="fmco-btn" data-co-sim="email" style="flex:1;justify-content:center"><i class="fa-solid fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_6ad499fc7305f0","Email in") ?? "Email in")}</button>` : '')}
          ${String(can('comms.sms') ? `<button type="button" class="fmco-btn" data-co-sim="sms" style="flex:1;justify-content:center"><i class="fa-solid fa-comment-sms"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_d06e1f42fcf0c7","Text in") ?? "Text in")}</button>` : '')}
        </div>
      </div>
    `;
    target.appendChild(shell);

    shell.querySelector('[data-co-notify-inherit]')?.addEventListener('click', () => {
      const next = object(state.settings.overrides);
      next.notifications = { ...object(next.notifications), inherit: !(object(next.notifications).inherit !== false) };
      state.settings.overrides = next;
      saveLeft();
    });
    shell.querySelectorAll('[data-co-notify-role]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const next = object(state.settings.overrides);
        const notificationsNext = { ...object(next.notifications), inherit:false };
        const current = new Set(Array.isArray(notificationsNext.target_role_ids) ? notificationsNext.target_role_ids : []);
        const role = chip.dataset.coNotifyRole;
        if (current.has(role)) current.delete(role); else current.add(role);
        notificationsNext.target_role_ids = [...current];
        next.notifications = notificationsNext;
        state.settings.overrides = next;
        saveLeft();
      });
    });
    shell.querySelector('[data-co-left-save]')?.addEventListener('click', () => {
      const next = object(state.settings.overrides);
      next.agent_instructions = clean(shell.querySelector('[data-co-agent-notes]')?.value);
      const mode = clean(shell.querySelector('[data-co-auto-mode]')?.value);
      if (mode) next.auto_response = mode;
      state.settings.overrides = next;
      saveLeft();
    });
    shell.querySelectorAll('[data-co-sim]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (state.simulateBusy) return;
        const channel = button.dataset.coSim;
        const text = rootWindow.prompt(channel === 'email' ? 'Simulated customer email text:' : 'Simulated customer text message:');
        if (!clean(text)) return;
        state.simulateBusy = true;
        button.disabled = true;
        try {
          await api2().simulateInbound(orgId(), projectId(), {
            channel,
            text: clean(text),
            ...(channel === 'email' ? { subject: 'Message from your customer' } : {})
          });
          await loadView();
        } catch (error) {
          state.error = error?.message || 'Simulation failed.';
          render();
        }
        state.simulateBusy = false;
        button.disabled = false;
      });
    });
  }

  async function saveLeft(){
    if (state.settings.saving) return;
    state.settings.saving = true;
    renderLeft({ force:true });
    try {
      const result = await api2().settings.saveProject(orgId(), projectId(), object(state.settings.overrides));
      state.settings.overrides = object(result.overrides);
    } catch (_) {}
    state.settings.saving = false;
    renderLeft({ force:true });
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  function scrollBottom(root){
    const scroll = root.querySelector('[data-co-scroll]');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function schedulePoll(){
    stopPoll();
    state.pollTimer = setTimeout(async () => {
      if (state.mounted && state.active && !state.search.open && !state.sending) {
        // Incremental pull: patches only changed containers, never composers.
        try { await syncView(); } catch (_) {}
      }
      if (state.mounted && state.active) schedulePoll();
    }, document.hidden ? 20000 : 6000);
  }

  function stopPoll(){
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function projectFromContext(context){
    return context.project || context.projectModel?.project || null;
  }

  function mount(context = {}){
    css();
    const nextProjectId = clean(projectFromContext(context)?.id || context.projectId || context.entityId);
    const previousProjectId = projectId();
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = projectFromContext(context);
    state.panelRoot = context.panelRoot || context.roots?.main || context.root || state.panelRoot;
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.active = context.active !== false;
    document.getElementById('rOverlay')?.classList.toggle('communications-wide',state.active);
    state.mounted = !!state.panelRoot;
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) reset();
    if (state.panelRoot && !state.panelRoot.querySelector('[data-comms-root]')) {
      state.panelRoot.innerHTML = panelHtml();
    }
    // The host may pre-render panelHtml() into the panel before mount runs,
    // so header bindings happen here — idempotently via a marker attribute.
    bindSearch();
    bindAgentToggle();
    const settingsButton=state.panelRoot?.querySelector('[data-co-settings]');
    if(settingsButton&&!settingsButton.dataset.bound){settingsButton.dataset.bound='1';settingsButton.onclick=()=>{
      const ui=Portal.CommunicationsUI;if(!ui)return;
      state.settingsDrawer=ui.dialog('Project communication settings','<div data-project-comms-settings></div>',null);
      renderLeft({force:true});
    };}
    state.leftRoot?.querySelector?.('#rProposalList .fmco-left')?.remove();
    state.leftRoot?.classList?.remove('visible','mode-edit','mode-list','mode-send');
    const route = Portal.navigation?.read?.() || {};
    if (clean(route.commsView)) state.view = clean(route.commsView);
    renderTabs();
    loadView().catch(() => null);
    loadLeftData();
    renderLeft();
    if (state.active) schedulePoll();
    return api;
  }

  function setActive(active){
    state.active = !!active;
    document.getElementById('rOverlay')?.classList.toggle('communications-wide',state.active);
    if (state.active) {
      renderLeft();
      loadLeftData();
      loadView().catch(() => null);
      schedulePoll();
    } else {
      stopPoll();
      if (leftRetryTimer) { clearTimeout(leftRetryTimer); leftRetryTimer = 0; }
      state.leftRoot?.querySelector?.('#rProposalList .fmco-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || '';
      if (!['proposal', 'materials', 'schedule', 'money', 'comms'].includes(activeTab)) {
        state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
      }
    }
  }

  function reset(){
    state.settingsDrawer?.close();state.settingsDrawer?.remove();state.settingsDrawer=null;
    state.callsHandle?.destroy();state.callsHandle=null;
    state.view = 'overview';
    state.overview = null;
    state.emailThreads = [];
    state.emailThread = null;
    state.emailComposeOpen = false;
    state.emailDraft = { to:'', cc:'', bcc:'' };
    state.sms = null;
    state.activeSmsId = '';
    state.smsComposeOpen = false;
    state.smsDraft = { to:'' };
    state.chatConversations = [];
    state.chatVoice = { mode:'attachment', max_seconds:120 };
    state.activeChatId = '';
    state.search = { open:false, query:'', results:[], busy:false };
    state.agent = { open:false, threadId:'', messages:[], busy:false };
    state.settings = { overrides:null, saving:false, loaded:false };
    state.voiceSettings = { sms:'attachment', email:'dictation' };
    state.pendingVoice = { sms:null, chat:null };
    state.sync = { overview:'', emailList:'', emailMsgs:'', sms:'', chatList:'', chatMsgs:'' };
    state.inboxAddress = '';
    state.error = '';
  }

  function destroy(){
    document.getElementById('rOverlay')?.classList.remove('communications-wide');
    stopPoll();
    if (leftRetryTimer) { clearTimeout(leftRetryTimer); leftRetryTimer = 0; }
    state.leftRoot?.querySelector?.('#rProposalList .fmco-left')?.remove();
    state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    reset();
    state.mounted = false;
    state.panelRoot = null;
    state.leftRoot = null;
  }

  const api = {
    mount,
    setActive,
    activate: () => setActive(true),
    deactivate: () => setActive(false),
    render,
    reset,
    destroy,
    unmount: destroy,
    context: () => ({ mounted: state.mounted, active: state.active, view: state.view })
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.commsTab = api;
  Portal.CommsTab = api;

  Portal.navigation?.registerHandler?.('project-comms-route', {
    priority:600,
    apply:(route) => {
      if (!route.project || route.projectTab !== 'comms' || !state.mounted) return;
      const view = clean(route.commsView);
      if (view && view !== state.view) setView(view);
      const conversation = clean(route.commsConversation);
      if (conversation && state.view === 'email') openEmailThread(conversation).catch(() => null);
      if (conversation && state.view === 'sms') { state.activeSmsId = conversation; state.smsComposeOpen = false; loadView().catch(() => null); }
      if (conversation && state.view === 'chat') { state.activeChatId = conversation; render(); }
    }
  });

  // Deep link from notifications (topbar routes open_project_comms here).
  rootWindow.addEventListener('fm:open-project-comms', (event) => {
    const detail = object(event.detail);
    if (!state.mounted) return;
    const view = clean(detail.comms_view);
    if (view) setView(view, { pushRoute:true });
  });

  runtime?.registerApp?.({
    id: 'project.comms',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("comms","m_da0c54815d9259","Comms") ?? "Comms"),
    label: (globalThis.PlatformLanguage?.text("comms","m_da0c54815d9259","Comms") ?? "Comms"),
    icon: 'fa-comments',
    order: 45,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    dependencies: [],
    panelHtml,
    mount
  });
})();
