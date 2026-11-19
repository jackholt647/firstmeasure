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
  /** An (i) whose tip shows on hover on a desktop and opens and closes with a tap (bindHintTips). */
  const hintTip = (tip) => clean(tip) ? `<button type="button" class="fmco-hint-btn" data-co-tip aria-expanded="false" aria-label="${esc(tip)}"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span class="fmco-hint-tip" role="tooltip">${esc(tip)}</span></button>` : '';
  const boundTipDocs = new WeakSet();
  function bindHintTips(scope){
    const closeTips = (except) => scope.ownerDocument.querySelectorAll('[data-co-tip][aria-expanded="true"]').forEach((tip) => { if (tip !== except) tip.setAttribute('aria-expanded', 'false'); });
    scope.querySelectorAll('[data-co-tip]').forEach((tip) => tip.addEventListener('click', (event) => {
      event.preventDefault();
      closeTips(tip);
      tip.setAttribute('aria-expanded', String(tip.getAttribute('aria-expanded') !== 'true'));
    }));
    const doc = scope.ownerDocument;
    if (boundTipDocs.has(doc)) return;
    boundTipDocs.add(doc);
    doc.addEventListener('pointerdown', (event) => { if (!event.target.closest?.('[data-co-tip]')) closeTips(); }, true);
  }

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
    panelRoot:null, sidebarRoot:null,
    mounted:false, active:false,
    view:'overview',
    callsHandle:null,
    loading:false, error:'',
    overview:null,
    emailThreads:[], emailThread:null, emailComposeOpen:false, emailOpenMessages:new Set(),
    emailDraft:{ to:'', cc:'', bcc:'', subject:'', body:'', files:[] },
    emailReply:{ threadId:'', body:'', files:[] },
    sms:null, activeSmsId:'', smsComposeOpen:false, smsDraft:{ to:'', body:'', files:[] }, smsReply:{ threadId:'', body:'', files:[] },
    phone:null,
    chatConversations:[], activeChatId:'', chatPicking:false,
    chatVoice:{ mode:'attachment', max_seconds:120 },
    search:{ open:false, query:'', results:[], busy:false },
    agent:{ open:false, threadId:'', messages:[], busy:false, error:'' },
    // Content signatures for the incremental poll (syncView): a poll tick
    // only touches the DOM when the corresponding signature changed, and
    // then only the list / message containers — never composers.
    sync:{ overview:'', emailList:'', emailMsgs:'', sms:'', chatList:'', chatMsgs:'' },
    settings:{ overrides:null, saving:false, loaded:false },
    voiceSettings:{ sms:'attachment', email:'dictation' },
    pendingVoice:{ chat:null },
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
    state.emailDraft = { to:clean(contact.email), cc:'', bcc:'', subject:'', body:'', files:[] };
    state.emailComposeOpen = true;
    state.emailThread = null;
  }

  function beginSmsDraft(){
    const contact = primaryContact();
    state.smsDraft = { to:clean(contact.phone), body:'', files:[] };
    state.smsComposeOpen = true;
    state.activeSmsId = '';
  }

  // ── Styles ───────────────────────────────────────────────────────────────

  function css(){
    const text = `
      .fmco-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fa;color:#101828}
      /* Before mount the window shows only its own "Loading…" status (GP-8). */
      .fmco-shell[data-co-pending]{display:none}
      .fmco-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e4e7ec;background:#fff;flex:0 0 auto;flex-wrap:wrap}
      .fmco-tabs{display:flex;gap:4px;flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
      .fmco-tabs::-webkit-scrollbar{display:none}
      .fmco-tab{flex:none;white-space:nowrap;border:1px solid transparent;background:transparent;border-radius:8px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:800;color:#667085;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .fmco-tab:hover{background:#f2f4f7}
      .fmco-tab.active,.fmco-tab.active:hover{background:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .fmco-head-spacer{flex:1}
      .fmco-search{display:flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 10px;min-width:210px}
      .fmco-search:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
      .fmco-search i{color:#98a2b3;font-size:12px}
      .fmco-search input{border:0;outline:none;font:inherit;font-size:12.5px;padding:7px 0;background:transparent;flex:1;min-width:0}
      .fmco-ai-btn{border:1px solid #d8dee8;background:#fff;border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:800;color:#344054;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .fmco-ai-btn:hover{background:#f8fafc}
      .fmco-ai-btn.active{background:var(--primary,#d93025);border-color:transparent;color:var(--on-primary,#fff)}
      .fmco-head-icon,.fmco-phone-only,.fmco-ai-btn[hidden]{display:none}
      .fmco-body{flex:1;min-height:0;display:flex}
      .fmco-content{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:16px}
      /* FM-594: the project's Calls (comms/workspace.js) sit on the tab like every other channel: no second background or padding. */
      .fmco-content:has(>.fmcm){padding:0}.fmco-content>.fmcm{background:transparent;min-height:0}.fmco-content>.fmcm>.fmcm-view{padding:16px}
      .fmco-agent-col{width:340px;flex:0 0 auto;border-left:1px solid #e4e7ec;background:#fff;display:flex;flex-direction:column;min-height:0}
      /* display:flex would otherwise override the [hidden] attribute and
         leave a permanently blank right column. */
      .fmco-agent-col[hidden]{display:none!important}
      .fmco-ai-chip{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#6d28d9;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:999px;padding:1px 7px;text-transform:uppercase;vertical-align:1px}
      .fmco-auto-chip{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#0369a1;background:#e0f2fe;border:1px solid #bae6fd;border-radius:999px;padding:1px 7px;text-transform:uppercase;vertical-align:1px}
      .fmco-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
      .fmco-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px;display:grid;gap:6px;align-content:start}
      .fmco-setup-card{border-style:dashed;background:#fcfcfd;align-content:start}.fmco-setup-card .fmco-btn{justify-self:start;margin-top:4px}.fmco-setup-card [data-co-setup-note]:empty{display:none}.fmco-setup-card .fmco-card-sub{white-space:normal;overflow:visible;text-overflow:clip}
      .fmco-composer[hidden]{display:none!important}
      .fmco-card-top{display:flex;align-items:center;justify-content:space-between}
      .fmco-card-title{font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;display:flex;align-items:center;gap:7px}
      .fmco-card-title i{color:#667085}
      .fmco-card-count{font-size:22px;font-weight:900;color:#101828}
      .fmco-card-sub{font-size:11.5px;color:#667085;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-card-open{border:0;background:transparent;color:#667085;font-size:12px;cursor:pointer;padding:4px}
      .fmco-card-open:hover{color:var(--primary-readable,var(--primary,#d93025))}
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
      .fmco-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .fmco-btn.primary:hover{background:var(--primary,#d93025);filter:brightness(.94)}
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
      .fmco-msg.outbound{align-self:flex-end;background:var(--primary,#d93025);color:var(--on-primary,#fff);border-bottom-right-radius:5px}
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
      .fmco-recipient-row.has-tip{grid-template-columns:42px minmax(0,1fr) auto}
      .fmco-recipient-label{padding-left:12px;font-size:11px;font-weight:900;color:#667085}
      .fmco-recipient-input{border:0;outline:0;padding:9px 10px 9px 0;font:inherit;font-size:13px;min-width:0;width:100%}
      .fmco-contact-options{display:flex;gap:6px;flex-wrap:wrap}
      .fmco-contact-chip{border:1px solid #d8dee8;background:#f8fafc;border-radius:999px;padding:4px 9px;font:inherit;font-size:10.5px;font-weight:800;color:#475467;cursor:pointer}
      .fmco-contact-chip:hover{border-color:#98a2b3;background:#fff}
      .fmco-contact-chip:disabled{opacity:.48;cursor:not-allowed;text-decoration:line-through}
      .fmco-recipient-summary{font-size:11px;color:#667085;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-input,.fmco-textarea{box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;outline:none;width:100%}
      .fmco-input:focus,.fmco-textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-textarea{resize:vertical;min-height:64px;max-height:220px}
      .fmco-composer-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .fmco-composer-hint{font-size:11px;color:#98a2b3;font-weight:700}
      /* An (i) on a field: hover shows its tip on a desktop, a tap opens and closes it (aria-expanded).
         The tip hangs under the field from .fmco-tip-host, outside the recipient box's overflow. */
      .fmco-tip-host{position:relative}
      .fmco-hint-btn{display:inline-grid;place-items:center;width:32px;height:32px;margin-right:4px;padding:0;border:0;border-radius:99px;background:none;color:#98a2b3;font:inherit;font-size:14px;cursor:help}
      .fmco-hint-btn:hover,.fmco-hint-btn[aria-expanded="true"]{color:#475467}
      .fmco-hint-btn:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:-2px}
      .fmco-hint-tip{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:max-content;max-width:min(320px,100%);box-sizing:border-box;padding:8px 10px;border-radius:9px;background:#344054;color:#fff;font-size:12.5px;font-weight:400;line-height:1.45;text-align:left;white-space:normal;cursor:auto;box-shadow:0 8px 24px rgba(16,24,40,.18)}
      .fmco-hint-btn[aria-expanded="true"] .fmco-hint-tip,.fmco-hint-btn:focus-visible .fmco-hint-tip{display:block}
      @media (hover:hover){.fmco-hint-btn:hover .fmco-hint-tip{display:block}}
      .fmco-thread-sub{font-size:11px;color:#98a2b3;font-weight:700;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* FM-587: email and texts use the notes rich editor (channels-ui) in one box with its format bar, files and actions. */
      .fmco-rich-box{border:1px solid #d0d5dd;border-radius:10px;padding:8px 10px;background:#fff;min-width:0;display:grid;gap:6px}
      .fmco-rich-box{position:relative}
      .fmco-emoji-pop{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:40;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.12);max-height:320px;overflow:auto}.fmco-emoji-pop[hidden]{display:none}.fmco-emoji-pop.below{top:calc(100% + 6px);bottom:auto}
      .fmco-rich-file>img{width:22px;height:22px;object-fit:cover;border-radius:4px;flex:none}
      .fmco-msg-image{display:block;margin-top:6px}.fmco-msg-image img{display:block;max-width:220px;max-height:220px;border-radius:9px}
      .fmco-rich-box:focus-within{border-color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-rich-box .fm-ch-formatbar{gap:2px;margin:0;padding-bottom:6px;flex-wrap:wrap}
      .fmco-rich-box .fm-ch-formatbar button{border:0;background:transparent;min-width:28px;height:28px;padding:4px!important;cursor:pointer}
      .fmco-rich-box .fm-ch-rich-editor,.fmco-rich-plain{box-sizing:border-box;display:block;width:100%;min-height:150px;max-height:360px;overflow:auto;border:0;outline:none;resize:none;padding:6px 2px;font:inherit;font-size:13px;line-height:1.5;background:transparent;color:#101828;white-space:pre-wrap;overflow-wrap:anywhere}
      .fmco-rich-box:not([data-co-composer="compose"]) .fm-ch-rich-editor,.fmco-rich-box:not([data-co-composer="compose"]) .fmco-rich-plain{min-height:64px;max-height:220px}
      .fmco-rich-box .fm-ch-rich-editor:empty:before{content:attr(data-placeholder);color:#98a2b3;pointer-events:none}
      .fmco-rich-box .fm-ch-rich-editor p{margin:0}
      .fmco-rich-files{display:flex;flex-wrap:wrap;gap:6px}.fmco-rich-files:empty{display:none}
      .fmco-rich-file{display:inline-flex;align-items:center;gap:6px;max-width:100%;box-sizing:border-box;border:1px solid #e4e7ec;background:#f8fafc;border-radius:8px;padding:3px 3px 3px 9px;font-size:12px;color:#344054}
      .fmco-rich-file>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
      .fmco-rich-file>small{color:#98a2b3;font-size:11px;white-space:nowrap}
      .fmco-rich-file.failed{border-color:#fecdca;background:#fef3f2;color:#b42318}.fmco-rich-file.failed>small{color:#b42318;white-space:normal}
      .fmco-rich-file>button{display:grid;place-items:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:#667085;cursor:pointer}.fmco-rich-file>button:hover{background:#eaecf0}
      .fmco-rich-actions{display:flex;align-items:center;gap:4px}
      .fmco-rich-actions>.fmco-rich-send{margin-left:auto}
      .fmco-icon-btn{display:grid;place-items:center;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:#667085;font-size:14px;cursor:pointer}
      .fmco-icon-btn:hover{background:#f2f4f7;color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-icon-btn.voice-active{background:#fef3f2;color:#d92d20}
      .fmco-icon-btn:disabled{opacity:.45;cursor:default}
      .fmco-msg-rich{white-space:normal}.fmco-msg-rich table{border-collapse:collapse;margin:4px 0}.fmco-msg-rich th,.fmco-msg-rich td{border:1px solid color-mix(in srgb,currentColor 40%,transparent);padding:3px 7px;text-align:left;vertical-align:top}.fmco-msg-rich ul,.fmco-msg-rich ol{margin:4px 0;padding-left:20px}.fmco-msg-rich blockquote{margin:4px 0;padding-left:10px;border-left:3px solid color-mix(in srgb,currentColor 45%,transparent)}.fmco-msg-rich pre{margin:4px 0;white-space:pre-wrap}.fmco-msg-rich a{color:inherit}
      .fmco-msg-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;white-space:normal}
      .fmco-msg-file{display:inline-flex;align-items:center;gap:6px;max-width:100%;box-sizing:border-box;padding:4px 9px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);color:inherit;font-size:11.5px;font-weight:700;text-decoration:none}
      .fmco-msg-file>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      a.fmco-msg-file:hover{text-decoration:underline}
      .fmco-voice{height:38px;display:inline-flex;align-items:center;gap:5px}.fmco-voice small{font-size:9px}.fmco-voice-mount:empty{display:none}.fmco-msg-audio{margin-top:6px;min-width:220px}
      .fmco-agent-head{padding:11px 14px;border-bottom:1px solid #eef1f4;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}
      .fmco-agent-title{font-size:12px;font-weight:900;display:flex;align-items:center;gap:8px;color:#101828}
      .fmco-agent-title i{color:var(--primary-readable,var(--primary,#d93025))}
      .fmco-agent-msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
      .fmco-agent-msg{border-radius:11px;padding:9px 12px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
      .fmco-agent-msg.user{align-self:flex-end;background:var(--primary,#d93025);color:var(--on-primary,#fff);max-width:85%}
      .fmco-agent-msg.assistant{align-self:flex-start;background:#f2f4f7;max-width:95%}
      .fmco-agent-msg.pending{opacity:.6;font-style:italic}
      .fmco-agent-composer{border-top:1px solid #eef1f4;padding:10px 12px;display:flex;gap:7px;flex:0 0 auto}
      .fmco-agent-composer textarea{flex:1;border:1px solid #d0d5dd;border-radius:9px;padding:8px 11px;font:inherit;font-size:12.5px;resize:none;min-height:38px;max-height:120px;outline:none}
      .fmco-agent-send{width:38px;height:38px;border:0;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);cursor:pointer;flex:0 0 auto}
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
      /* FM-591: email reads like email (Gmail), not like the SMS rows and bubbles Texts keep. */
      .fmco-split.fmco-mail{position:relative}
      .fmco-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      /* GP-10: no gutter kept for the unread dot; it sits before the name, so read rows line up with the New email button. */
      .fmco-mail-row{position:relative;gap:4px;padding:11px 14px 10px;border-radius:10px}
      .fmco-mail-row.unread .fmco-mail-who:before{content:'';flex:none;align-self:center;width:7px;height:7px;border-radius:50%;background:var(--primary,#d93025)}
      .fmco-mail-top{display:flex;align-items:baseline;gap:10px;min-width:0}
      .fmco-mail-who{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:600;color:#344054}
      .fmco-mail-who>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-mail-count{flex:none;font-size:11px;font-weight:700;color:#98a2b3}
      .fmco-mail-addr{flex:0 1 auto;max-width:55%;font-size:11.5px;font-weight:600;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
      .fmco-mail-snippet{font-size:12px;line-height:1.45;color:#667085;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
      .fmco-mail-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:#98a2b3}
      .fmco-mail-foot i{font-size:11px}
      .fmco-mail-row.unread .fmco-mail-who{font-weight:900;color:#101828}.fmco-mail-row.unread .fmco-mail-addr{color:#344054}
      .fmco-mail-row.unread .fmco-mail-snippet{color:#344054}
      .fmco-mail-row.unread .fmco-mail-foot time{color:var(--primary-readable,var(--primary,#d93025));font-weight:800}
      .fmco-mail-peek{position:absolute;z-index:25;width:min(480px,calc(100% - 320px));min-width:300px;max-height:min(420px,calc(100% - 8px));box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;background:#fff;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 16px 40px rgba(16,24,40,.18);pointer-events:none}
      .fmco-mail-peek[hidden]{display:none}
      .fmco-mail-peek .fmco-mail-card{border:0;box-shadow:none;border-radius:0;flex:1;min-height:0;overflow:hidden}
      .fmco-mail-peek .fmco-mail-body{-webkit-mask-image:linear-gradient(#000 calc(100% - 36px),transparent);mask-image:linear-gradient(#000 calc(100% - 36px),transparent);max-height:300px;overflow:hidden}
      .fmco-mail-peek-subject{padding:12px 16px 0;font-size:14px;font-weight:900;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-mail-head{padding:14px 18px 12px}
      .fmco-mail-head .fmco-thread-title{font-size:17px;font-weight:800;white-space:normal;overflow-wrap:anywhere;line-height:1.3}
      .fmco-mail-msgs{position:relative;gap:8px;background:#fff;padding:12px 16px 16px}
      .fmco-mail-card{flex:none;border:1px solid #e4e7ec;border-radius:12px;background:#fff;min-width:0}
      .fmco-mail-card.collapsed{background:#f9fafb}
      .fmco-mail-card-head{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:10px;align-items:start;padding:12px 14px;cursor:pointer;border-radius:12px}
      .fmco-mail-card-head:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:-2px}
      .fmco-mail-card.collapsed .fmco-mail-card-head{padding:9px 14px;align-items:center}
      .fmco-mail-avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-size:14px;font-weight:800;color:#fff;background:var(--fmco-avatar,#667085)}
      .fmco-mail-card.collapsed .fmco-mail-avatar{width:30px;height:30px;font-size:12px;margin:0 3px}
      .fmco-mail-from{min-width:0;display:grid;gap:2px}
      .fmco-mail-from-line{display:flex;align-items:baseline;gap:6px;min-width:0;flex-wrap:wrap}
      .fmco-mail-from-line strong{font-size:13px;font-weight:800;color:#101828}
      .fmco-mail-from-line small{font-size:11.5px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
      .fmco-mail-to,.fmco-mail-card-snippet{font-size:11.5px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmco-mail-card.collapsed .fmco-mail-to,.fmco-mail-card:not(.collapsed) .fmco-mail-card-snippet,.fmco-mail-card.collapsed .fmco-mail-from-line small,.fmco-mail-card.collapsed .fmco-mail-body{display:none}
      .fmco-mail-card-head time{font-size:11.5px;color:#667085;font-weight:600;white-space:nowrap}
      .fmco-mail-body{padding:0 18px 16px 60px;font-size:13.5px;line-height:1.55;color:#202124;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
      .fmco-mail-body .fmco-msg-rich{white-space:normal}
      .fmco-mail-body .fmco-msg-file{border-color:#d0d5dd;color:#344054;background:#f8fafc}
      .fmco-mail-msg-subject{font-weight:800;margin-bottom:6px;white-space:normal}
      .fmco-mail-quoted{margin-top:6px}
      .fmco-mail-quoted>summary{display:inline-block;list-style:none;padding:0 7px;border-radius:6px;background:#eef1f4;color:#475467;font-size:12px;line-height:16px;letter-spacing:1px;cursor:pointer}
      .fmco-mail-quoted>summary::-webkit-details-marker{display:none}
      .fmco-mail-quoted>div{margin-top:6px;padding-left:10px;border-left:2px solid #d0d5dd;color:#667085}
      /* GP-11: a project's Calls (comms/workspace.js projectCalls) in the same split as Email and Texts: the calls on
         the left, the selected call's details, outcome, recording and transcript on the right. */
      .fmco-content>.fmcm>.fmcm-view:has(>.fmco-split){overflow:hidden}
      /* communications.css styles every .fmcm button and select; inside the split they look like Email's and Texts'. */
      .fmcm .fmco-split .fmco-btn{min-height:0;gap:6px;padding:6px 12px;border-color:#d8dee8;font-size:12px;font-weight:800;color:#344054}
      .fmcm .fmco-split .fmco-btn:hover{background:#f8fafc;border-color:#d8dee8}
      .fmcm .fmco-split .fmco-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .fmcm .fmco-split .fmco-btn.primary:hover{filter:brightness(.94)}
      .fmcm .fmco-split .fmco-call-row{display:grid;justify-content:stretch;align-items:start;gap:3px;min-height:0;padding:10px 12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;font-weight:inherit;white-space:normal}
      .fmcm .fmco-split .fmco-call-row:hover{background:#fff;border-color:#c7ced9}
      .fmcm .fmco-split .fmco-call-row.active{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217 48 37),.04)}
      .fmco-call-filters{display:flex;gap:6px}
      .fmcm .fmco-call-filters select{flex:1 1 0;min-width:0;height:32px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:inherit;font-size:12px;font-weight:700;color:#344054;padding:0 8px;text-overflow:ellipsis}
      .fmco-call-ico{flex:none;color:#667085;font-size:11.5px}.fmco-call-ico.missed{color:#b42318}
      .fmco-call-flag{justify-self:start;font-size:10.5px;font-weight:800;color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:999px;padding:1px 8px}
      .fmco-call-actions{display:flex;gap:6px;flex:none}
      .fmco-call-body{flex:1;min-height:0;overflow-y:auto;padding:16px;display:grid;gap:18px;align-content:start}
      .fmco-call-body section{display:grid;gap:8px;min-width:0}.fmco-call-body .fmco-section-title{margin:0}
      .fmco-call-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:0}
      .fmco-call-facts>div{min-width:0;background:#f8fafc;border:1px solid #eef1f4;border-radius:10px;padding:8px 12px}
      .fmco-call-facts dt{font-size:10.5px;font-weight:800;color:#98a2b3;text-transform:uppercase;letter-spacing:.04em}
      .fmco-call-facts dd{margin:2px 0 0;font-size:13px;font-weight:700;color:#101828;overflow-wrap:anywhere}
      .fmco-call-needs{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;background:#fffaeb;border:1px solid #fedf89;color:#93370d;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:700}
      .fmco-call-text{margin:0;font-size:13px;line-height:1.5;color:#344054;white-space:pre-wrap;overflow-wrap:anywhere}
      .fmco-call-note{margin:0;font-size:12.5px;color:#667085}
      .fmco-call-media{display:grid;gap:4px}.fmco-call-media audio{width:100%}.fmco-call-media small{font-size:11px;font-weight:700;color:#98a2b3}
      .fmco-call-transcript{max-height:420px;overflow-y:auto;background:#f8fafc;border:1px solid #eef1f4;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#344054;white-space:pre-wrap;overflow-wrap:anywhere}
      @media(max-width:1180px){.fmco-agent-col{position:absolute;right:0;top:0;bottom:0;z-index:30;box-shadow:-14px 0 30px rgba(16,24,40,.12)}}
      @media(max-width:900px){.fmco-split{grid-template-columns:1fr}.fmco-split .fmco-thread-view{display:none}.fmco-split.thread-mode .fmco-thread-view{display:flex}.fmco-split.thread-mode .fmco-list-col{display:none}}
      /* Phone (the platform's 760px window breakpoint), like Photos and Docs:
         one header row (the tab icon, a flexible search, Ask AI and settings
         as icons), the channels as a strip that scrolls sideways, and an open
         thread or the AI panel takes the whole tab. */
      @media(max-width:760px){
        .fmco-head{gap:8px;padding:10px 12px 0;flex-wrap:wrap}
        .fmco-head-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;height:32px;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:14px}
        .fmco-head-spacer{display:none}
        .fmco-search{order:1;flex:1 1 auto;min-width:0;height:36px;border-radius:10px}
        .fmco-search input{font-size:13px;padding:0}
        .fmco-head>.fmco-ai-btn,.fmco-head>[data-co-settings]{order:2;flex:none;width:36px;height:36px;padding:0;justify-content:center;border-radius:10px}
        .fmco-ai-btn>span{display:none}
        .fmco-tabs{order:3;flex:1 1 100%;gap:6px;margin:0 -12px;padding:2px 12px 10px;scroll-padding:0 12px}
        .fmco-tab{height:34px;padding:0 13px;border-color:#e4e7ec;background:#fff;border-radius:999px;font-size:12.5px}
        .fmco-tab.active{border-color:var(--primary,#d93025)}
        .fmco-phone-only{display:inline-flex}
        .fmco-content{padding:12px}
        .fmco-content:has(>.fmco-split.thread-mode),.fmco-content:has(>.fmcm){padding:0}.fmco-content>.fmcm>.fmcm-view{padding:12px}
        .fmco-cards{grid-template-columns:repeat(var(--fmco-channels,2),minmax(0,1fr));gap:8px;margin-bottom:14px}
        .fmco-card{position:relative;padding:11px 12px;gap:3px;min-width:0;grid-template-columns:minmax(0,1fr);align-content:space-between}
        .fmco-card-top{gap:4px}
        .fmco-card-title{min-width:0}
        .fmco-card-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .fmco-cards[data-co-channels="4"] .fmco-card{padding:11px 10px}
        .fmco-cards[data-co-channels="4"] .fmco-card-title>span{white-space:normal;line-height:1.25}
        .fmco-cards[data-co-channels="4"] .fmco-card-title>i,.fmco-cards[data-co-channels="4"] .fmco-card-open>i{display:none}
        .fmco-setup-card{grid-column:1/-1}
        .fmco-card-open::after{content:'';position:absolute;inset:0;border-radius:12px}
        .fmco-card-count{font-size:20px}
        .fmco-card-sub{font-size:11px}
        .fmco-card:not(.fmco-setup-card) .fmco-card-sub{display:none}
        .fmco-feed-row{grid-template-columns:32px minmax(0,1fr) auto;padding:10px 12px}
        .fmco-feed-ico{width:32px;height:32px;border-radius:9px}
        .fmco-draft-actions .fmco-btn{min-height:36px}
        .fmco-list-col{gap:8px}
        .fmco-list-col>.fmco-btn.primary{min-height:40px;border-radius:10px;font-size:13px}
        .fmco-thread-row{padding:12px;border-radius:12px}
        .fmco-mail-row{padding:12px 12px 11px}
        .fmco-mail-msgs{padding:10px}
        .fmco-mail-card-head{padding:11px 12px}
        .fmco-mail-body{padding:0 14px 14px;font-size:14px}
        .fmco-split.thread-mode .fmco-thread-view{border:0;border-radius:0}
        .fmco-thread-head{padding:10px 12px}
        .fmco-thread-head .fmco-btn{flex:none;width:36px;height:36px;padding:0;justify-content:center;border-radius:10px}
        .fmco-msgs{padding:12px}
        .fmco-msg{max-width:86%}
        .fmco-composer{padding:10px 12px calc(10px + var(--fm-safe-bottom,env(safe-area-inset-bottom,0px)))}
        .fmco-composer-row{flex-wrap:wrap;justify-content:flex-end}
        .fmco-composer-row>.fmco-composer-hint{order:9;flex:1 1 100%;min-width:0;overflow-wrap:anywhere}
        .fmco-composer .fmco-btn{min-height:38px}
        .fmco-input,.fmco-textarea,.fmco-recipient-input,.fmco-agent-composer textarea{font-size:16px}
        .fmco-rich-box .fm-ch-rich-editor,.fmco-rich-plain{font-size:16px}
        .fmco-icon-btn{width:38px;height:38px;font-size:16px}
        .fmco-recipient-row{grid-template-columns:50px minmax(0,1fr)}
        .fmco-recipient-row.has-tip{grid-template-columns:50px minmax(0,1fr) auto}
        .fmco-hint-btn{width:40px;height:40px;margin-right:0;font-size:16px}
        .fmco-agent-col{position:absolute;inset:0;width:auto;z-index:30;border-left:0;box-shadow:none}
        .fmco-agent-head{padding:10px 12px}
        .fmco-agent-head .fmco-btn{width:36px;height:36px;padding:0;justify-content:center;border-radius:10px}
        .fmco-content>.fmcm>.fmcm-view:has(>.fmco-split.thread-mode){padding:0}
        .fmcm .fmco-call-filters select{height:38px;border-radius:10px;font-size:16px}
        .fmcm .fmco-split .fmco-list-col>.fmco-btn.primary{min-height:40px;border-radius:10px;font-size:13px}
        .fmcm .fmco-split .fmco-call-row{padding:12px;border-radius:12px}
        .fmcm .fmco-split .fmco-thread-head .fmco-btn{width:36px;height:36px;padding:0;border-radius:10px}
        .fmco-call-actions .fmco-btn>span{display:none}
        .fmco-call-body{padding:12px}
      }
    `;
    util.injectCSS ? util.injectCSS('project_comms', text) : document.head.appendChild(Object.assign(document.createElement('style'), { textContent:text }));
  }

  // ── Shell ────────────────────────────────────────────────────────────────

  // The project window draws this, with its own "Loading…" status, before the app mounts: the tab's styles go in
  // first and the shell stays hidden until mount() takes it, so nothing paints unstyled (GP-8, as FM-564).
  function panelHtml(){
    css();
    return `
      <div class="fmco-shell" data-comms-root data-co-pending style="position:relative">
        <div class="fmco-head">
          <span class="fmco-head-icon" aria-hidden="true"><i class="fa-solid fa-comments"></i></span>
          <div class="fmco-tabs" data-co-tabs></div>
          <div class="fmco-head-spacer"></div>
          <label class="fmco-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_ba670f4714e86b","Search all communications…") ?? "Search all communications…")}" data-co-search></label>
          <button type="button" class="fmco-ai-btn" data-co-ai-toggle hidden><i class="fa-solid fa-wand-magic-sparkles"></i><span>${(globalThis.PlatformLanguage?.htmlText("comms","m_fe8a5736f9bbac","Ask AI") ?? "Ask AI")}</span></button>
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
    const wasCalls = state.search.calls;
    state.search.open = false;
    state.search.calls = state.view === 'calls';
    syncSearchBox(wasCalls !== state.search.calls);
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
          state.overview ? Promise.resolve(null) : api2().overview(orgId(), projectId()),
          loadPhoneStatus()
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
        if (!state.activeChatId && !state.chatPicking && state.chatConversations.length) state.activeChatId = clean(state.chatConversations[0].id);
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
        const listSignature = signatureOf(threads.map((thread) => [thread.id, thread.message_count, thread.last_message_at, thread.unread_count, thread.snippet]));
        if (listSignature !== state.sync.emailList) {
          state.sync.emailList = listSignature;
          state.emailThreads = threads;
          patchContainer('[data-co-list]', emailListHtml(), { bind: bindEmailList });
        }
        if (state.emailThread) {
          const stillThere = threads.some((thread) => thread.id === state.emailThread.id);
          if (stillThere) {
            markEmailRead(clean(state.emailThread.id));
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
          if (!state.activeChatId && !state.chatPicking && conversations.length) state.activeChatId = clean(conversations[0].id);
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
      if (clean(state.emailThread?.id) !== clean(conversationId)) state.emailOpenMessages = new Set();
      state.emailThread = result.thread;
      state.emailComposeOpen = false;
      markEmailRead(conversationId);
    } catch (error) {
      state.error = error?.message || 'Could not load this thread.';
    }
    if (!options.silent) render();
  }

  /** FM-591: opening a thread is reading it, for this person (the comms read marker the inbox and phone tray use). */
  function markEmailRead(conversationId){
    const item = state.emailThreads.find((thread) => clean(thread.id) === clean(conversationId));
    if (!item || !Number(item.unread_count || 0) || typeof api2()?.customer !== 'function') return;
    item.unread_count = 0;
    state.sync.emailList = '';
    contentRoot()?.querySelector(`[data-co-thread="${CSS.escape(clean(conversationId))}"]`)?.classList.remove('unread');
    api2().customer(orgId(), 'conversation-workflow', { kind:'conversation', source_id:clean(conversationId), revision:0, action:'read' }).catch(() => null);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function badges(message){
    const parts = [];
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
    // Texts' setup panel and Calls are drawn with communications.css: keep the loading state until it has loaded (GP-8).
    const ui = Portal.CommunicationsUI;
    if (ui?.cssLoaded && !ui.cssLoaded()) {
      if (!root.querySelector(':scope > .fmco-empty[data-co-css-wait]')) root.innerHTML = loadingHtml().replace('class="fmco-empty"', 'class="fmco-empty" data-co-css-wait');
      if (!state.cssWait) state.cssWait = ui.cssReady.then(() => { state.cssWait = null; render(); });
      return;
    }
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

  // FM-491: a channel that is not on yet (Texts, Email) is offered here; its button opens the Communications setup
  // (guided experience comms.setup) on that channel's page. Whether the person may set it up is the setup's own check.
  function setupCards(){
    if (typeof (rootWindow.FirstMateGuides || rootWindow.top?.FirstMateGuides)?.play !== 'function') return '';
    const cards = [
      !can('comms.sms') && { id:'phone', icon:'fa-comment-sms', label:'Texts and calls', body:'Text and call customers from their project.' },
      !can('comms.email') && { id:'email', icon:'fa-envelope', label:'Email', body:'Email customers from their project.' }
    ].filter(Boolean);
    return cards.map((card) => `
      <div class="fmco-card fmco-setup-card" data-co-setup-card="${card.id}">
        <span class="fmco-card-title"><i class="fa-solid ${card.icon}"></i>${esc(card.label)}</span>
        <div class="fmco-card-sub">${esc(card.body)}</div>
        <button type="button" class="fmco-btn primary" data-co-setup="${card.id}">${card.id === 'email' ? 'Set up email' : 'Set up texts and calls'}</button>
        <div class="fmco-card-sub" data-co-setup-note role="status"></div>
      </div>`).join('');
  }

  async function setUpChannel(channel, button){
    const guides = rootWindow.FirstMateGuides;
    if (!guides?.play) return;
    button.disabled = true;
    const windows = [rootWindow];
    try { if (rootWindow.top !== rootWindow && rootWindow.top.location.origin === rootWindow.location.origin) windows.push(rootWindow.top); } catch (_) {}
    windows.forEach((win) => { win.__fmCommsSetupStart = channel; });
    try {
      const outcome = await guides.play('comms.setup', { replay:true });
      if (outcome?.status === 'unavailable') {
        const note = button.parentElement?.querySelector('[data-co-setup-note]');
        if (note) note.textContent = 'Ask someone who manages company settings to set this up.';
      }
    } catch (_) {
      /* the setup reports its own errors */
    } finally {
      windows.forEach((win) => { win.__fmCommsSetupStart = ''; });
      if (button.isConnected) button.disabled = false;
    }
    // FM-588: Texts show where setup stands now.
    if (channel === 'phone' && state.mounted && state.view === 'sms') loadView().catch(() => null);
  }

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
      <div class="fmco-cards" data-co-channels="${cards.length}" style="--fmco-channels:${Math.max(1, cards.length)}">
        ${String(cards.map((card) => {
          const bucket = object(channels[card.id]);
          const last = object(bucket.last_message);
          return `
            <div class="fmco-card">
              <div class="fmco-card-top">
                <span class="fmco-card-title"><i class="fa-solid ${card.icon}"></i><span>${esc(card.label)}</span></span>
                <button type="button" class="fmco-card-open" data-co-open="${card.tab || card.id}" title="${(globalThis.PlatformLanguage?.htmlText("comms","m_c25cc66b28cc9d","Open") ?? "Open")}"><i class="fa-solid fa-arrow-right"></i></button>
              </div>
              <div class="fmco-card-count">${Number(bucket.total || 0)}</div>
              ${bucket.total ? `<div class="fmco-card-sub">${Number(bucket.inbound || 0)} received · last ${esc(timeLabel(last.created_at) || '—')}</div>` : ''}
            </div>
          `;
        }).join(''))}
        ${String(setupCards())}
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
    root.querySelectorAll('[data-co-setup]').forEach((button) => {
      button.addEventListener('click', () => { void setUpChannel(button.dataset.coSetup, button); });
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
      ${String(state.emailThreads.length ? state.emailThreads.map((item) => {
        const count = Number(item.message_count || 0);
        const unread = Number(item.unread_count || 0) > 0;
        const people = emailPeopleList(item.participants);
        const addresses = people.map((person) => person.address).join(', ');
        return `
        <button type="button" class="fmco-thread-row fmco-mail-row${unread ? ' unread' : ''}${thread && thread.id === item.id ? ' active' : ''}" data-co-thread="${esc(clean(item.id))}">
          <span class="fmco-mail-top">
            <span class="fmco-mail-who"><span>${esc(emailPeople(item.participants))}</span>${count > 1 ? `<span class="fmco-mail-count">${count}</span>` : ''}</span>
            ${people.some((person) => person.name) ? `<span class="fmco-mail-addr" title="${esc(addresses)}">${esc(addresses)}</span>` : ''}
          </span>
          <span class="fmco-mail-snippet">${esc(clean(item.snippet) || emailLine(object(item.last_message).text).slice(0, 200) || (globalThis.PlatformLanguage?.text("comms","m_1fd5d8b93e36dd","No message text") ?? "No message text"))}</span>
          <span class="fmco-mail-foot"><span>${item.has_attachments ? `<i class="fa-solid fa-paperclip" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_0b5cae7c72c6a9","Has attachments") ?? "Has attachments")}"></i>` : ''}${unread ? `<span class="fmco-sr-only">${(globalThis.PlatformLanguage?.htmlText("comms","m_e6bd48170f22a4","Unread") ?? "Unread")}</span>` : ''}</span><time datetime="${esc(clean(item.last_message_at))}">${esc(timeLabel(item.last_message_at))}</time></span>
        </button>
      `;
      }).join('') : `<div class="fmco-empty"><i class="fa-solid fa-envelope-open"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_4aeca6bca783d6","No email threads yet.") ?? "No email threads yet.")}</p></div>`)}
    `;
  }

  /** The project contact's name for an email address, when one of the project's contacts has it. */
  function contactNameFor(address){
    const key = clean(address).toLowerCase();
    return key ? clean(overviewContacts().find((contact) => clean(contact.email).toLowerCase() === key)?.name) : '';
  }

  /** Who an email thread is with, as { name, address }: the participant's name, else the project contact's. */
  function emailPeopleList(participants){
    const seen = new Set();
    const people = (Array.isArray(participants) ? participants : [])
      .filter((participant) => !['internal', 'bcc'].includes(clean(participant.type)) && clean(participant.address) && clean(participant.address).toLowerCase() !== state.inboxAddress.toLowerCase())
      .map((participant) => ({ name:clean(participant.name) || contactNameFor(participant.address), address:clean(participant.address) }))
      .filter((person) => !seen.has(person.address.toLowerCase()) && seen.add(person.address.toLowerCase()));
    // One recipient whose address is on no contact, in a project whose primary contact has no email on file: that is
    // the contact it was written to (the address was typed into New email), so the tile says their name.
    const primary = primaryContact();
    if (people.length === 1 && !people[0].name && !clean(primary.email) && clean(primary.name)) people[0].name = clean(primary.name);
    return people;
  }

  /** Names first (FM-591): the tile puts the name top left and the address top right. */
  function emailPeople(participants){
    return emailPeopleList(participants).map((person) => person.name || person.address).join(', ') || 'No recipients';
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
      <div class="fmco-tip-host"><div class="fmco-recipient-box" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_911db27369deff","Email recipients") ?? "Email recipients")}">
        <div class="fmco-recipient-row has-tip"><label class="fmco-recipient-label" for="fmcoEmailTo">${(globalThis.PlatformLanguage?.htmlText("comms","m_af8bc9e774b68c","To") ?? "To")}</label><input id="fmcoEmailTo" class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.to))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_0864076e5066f2","name@example.com") ?? "name@example.com")}" data-co-email-to>${String(hintTip((globalThis.PlatformLanguage?.text("comms","m_275d433a1ef093","Separate multiple addresses with commas") ?? "Separate multiple addresses with commas")))}</div>
        <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_75c322757c6a34","CC") ?? "CC")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.cc))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_c3c1a5d95882ad","Add CC recipients") ?? "Add CC recipients")}" data-co-email-cc></label>
        <label class="fmco-recipient-row"><span class="fmco-recipient-label">${(globalThis.PlatformLanguage?.htmlText("comms","m_6ad86ac94efad5","BCC") ?? "BCC")}</span><input class="fmco-recipient-input" type="text" value="${String(esc(state.emailDraft.bcc))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_529af833bc1e63","Add BCC recipients") ?? "Add BCC recipients")}" data-co-email-bcc></label>
      </div></div>
      ${String(contactChipsHtml('email', 'to'))}
    `;
  }

  function bindEmailList(scope){
    scope.querySelector('[data-co-compose]')?.addEventListener('click', () => { beginEmailDraft(); render(); });
    scope.querySelectorAll('[data-co-thread]').forEach((button) => {
      button.addEventListener('click', () => { hideEmailPeek(); openEmailThread(button.dataset.coThread); });
      button.addEventListener('mouseenter', () => scheduleEmailPeek(button));
      button.addEventListener('mouseleave', hideEmailPeek);
    });
    if (!scope.dataset.coPeekBound) { scope.dataset.coPeekBound = '1'; scope.addEventListener('scroll', hideEmailPeek, { passive:true }); }
  }

  // FM-591: resting the pointer on a thread shows its newest email in full beside the list (desktop only).
  let peekTimer = 0;
  function scheduleEmailPeek(button){
    clearTimeout(peekTimer);
    if (!rootWindow.matchMedia?.('(hover:hover) and (pointer:fine)').matches) return;
    peekTimer = setTimeout(() => showEmailPeek(button), 450);
  }
  function hideEmailPeek(){
    clearTimeout(peekTimer);
    const peek = contentRoot()?.querySelector('[data-co-mail-peek]');
    if (peek) peek.hidden = true;
  }
  function showEmailPeek(button){
    const split = button.closest('.fmco-split');
    const peek = split?.querySelector('[data-co-mail-peek]');
    const item = state.emailThreads.find((thread) => clean(thread.id) === clean(button.dataset.coThread));
    const message = object(item?.last_message);
    // Only beside a visible thread pane (not when the list is the whole width), and never for the open thread.
    if (!peek || !item || !message.id || !button.isConnected || clean(state.emailThread?.id) === clean(item.id)) return;
    if (split.querySelector('.fmco-thread-view')?.offsetParent === null) return;
    peek.innerHTML = `<div class="fmco-mail-peek-subject">${esc(clean(item.subject) || '(no subject)')}</div>${emailCardHtml(message, { open:true, threadSubject:item.subject })}`;
    peek.hidden = false;
    const box = split.getBoundingClientRect(), row = button.getBoundingClientRect();
    peek.style.left = `${Math.round(row.right - box.left + 10)}px`;
    peek.style.top = `${Math.round(Math.max(0, Math.min(row.top - box.top, box.height - peek.offsetHeight)))}px`;
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

  // Rich composers (FM-587) --------------------------------------------------
  // Email and texts use the rich editor project notes use (channels-ui composerWidgets) in one box with the same
  // controls: format bar, attach, emoji, dictate, audio and Send. The editor's value is Markdown.
  // Email: the Markdown is the text part and, rendered (renderBody), the HTML part; files are uploaded as the sender's
  // own media in the email_attachment slot and sent by id (v1/comms/email-attachments.ts).
  // Texts: a shorter format bar (lists and links, which read well as plain text), flattened to plain text on send;
  // one image (the phone tray's MMS preparation, slot sms_image) or one audio note.
  // A draft lives in state, so a re-render never loses it.
  const EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const EMAIL_ATTACHMENT_COUNT = 10;
  const SMS_TEXT_LIMIT = 1600;
  const SMS_FORMATS = ['Bulleted list', 'Numbered list', 'Link'];
  const COMPOSERS = {
    compose:{ channel:'email', draft:() => state.emailDraft, send:'data-co-email-send' },
    reply:{ channel:'email', draft:() => state.emailReply, send:'data-co-email-reply-send' },
    'sms-compose':{ channel:'sms', draft:() => state.smsDraft, send:'data-co-sms-send' },
    'sms-reply':{ channel:'sms', draft:() => state.smsReply, send:'data-co-sms-send' }
  };
  const voiceIcon = (mode) => `<span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:18px;height:18px;background:currentColor;mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat"></span>`;
  const composerWidgets = () => rootWindow.FirstMateChannels?.composerWidgets || null;
  const currentUserId = () => clean(rootWindow.__APP?.userId || Portal.currentUser?.id || '');
  const draftFor = (kind) => COMPOSERS[kind].draft();
  const composerBox = (kind) => contentRoot()?.querySelector(`[data-co-composer="${kind}"]`) || null;
  const fileSize = (bytes) => { const value = Number(bytes) || 0; return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; };
  const fileKey = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const withoutTableWidths = (markdown) => String(markdown || '').replace(/^<!--fm-table-widths:[\d.,]+-->$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  /** The email as sent: Markdown without the editor's table-width notes, and the same body as inline-styled HTML. */
  function emailBodies(markdown){
    const text = withoutTableWidths(markdown);
    const render = composerWidgets()?.renderBody;
    if (!render || !text) return { text, html:'' };
    const box = document.createElement('div');
    box.innerHTML = render({ text:markdown });
    const styles = {
      TABLE:'border-collapse:collapse;margin:8px 0', TH:'border:1px solid #d0d5dd;padding:6px 10px;background:#f8fafc;text-align:left', TD:'border:1px solid #d0d5dd;padding:6px 10px;vertical-align:top',
      BLOCKQUOTE:'margin:8px 0;padding:0 0 0 12px;border-left:3px solid #d0d5dd;color:#475467', PRE:'margin:8px 0;padding:10px 12px;border-radius:6px;background:#f2f4f7;white-space:pre-wrap',
      CODE:'font-family:Menlo,Consolas,monospace;font-size:90%', UL:'margin:6px 0;padding-left:24px', OL:'margin:6px 0;padding-left:24px'
    };
    box.querySelectorAll('*').forEach((node) => {
      [...node.attributes].forEach((attribute) => { if (!['href', 'target', 'rel', 'style'].includes(attribute.name)) node.removeAttribute(attribute.name); });
      if (styles[node.tagName]) node.setAttribute('style', [node.getAttribute('style'), styles[node.tagName]].filter(Boolean).join(';'));
    });
    return { text, html:`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#101828">${box.innerHTML}</div>` };
  }

  /** A text as sent: lists stay as typed ("- ", "1. "), a link becomes "label (url)", and emphasis a pasted or
   *  keyboard-shortcut format left behind is dropped, since a text message shows only plain text. */
  function smsText(markdown){
    return withoutTableWidths(markdown)
      .replace(/\[((?:\\.|[^\]\\\n])+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => { const text = label.replace(/\\([\[\]\\])/g, '$1'); const href = url.replace(/%28/g, '(').replace(/%29/g, ')'); return text === href ? href : `${text} (${href})`; })
      .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/~~([^~\n]+)~~/g, '$1').replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
      .replace(/^```.*$/gm, '').replace(/`([^`\n]+)`/g, '$1').replace(/\\\|/g, '|').trim();
  }

  function composerHtml(kind){
    const { channel, send } = COMPOSERS[kind];
    const sms = channel === 'sms';
    const voice = clean(state.voiceSettings[channel]) !== 'off';
    const attachLabel = sms ? (globalThis.PlatformLanguage?.htmlText("comms","m_fda32e5e3fa3a8","Attach an image") ?? "Attach an image") : (globalThis.PlatformLanguage?.htmlText("comms","m_032133d04a761e","Attach files") ?? "Attach files");
    const sendTitle = kind === 'reply' && state.inboxAddress ? String(esc(state.inboxAddress)) : kind === 'sms-reply' ? (globalThis.PlatformLanguage?.htmlText("comms","m_d28416ff3f0c41","Sends to everyone shown above from your business number") ?? "Sends to everyone shown above from your business number") : '';
    return `<div class="fmco-rich-box" data-co-composer="${kind}">
      <div class="fmco-rich-editor" data-co-composer-editor></div>
      <div class="fmco-rich-files" data-co-composer-files></div>
      <div class="fmco-voice-mount" data-co-composer-voice></div>
      <div class="fmco-rich-actions">
        <button type="button" class="fmco-icon-btn" data-co-composer-attach title="${attachLabel}" aria-label="${attachLabel}"><i class="fa-solid ${sms ? 'fa-image' : 'fa-paperclip'}" aria-hidden="true"></i></button><input type="file" ${sms ? 'accept="image/jpeg,image/png,image/gif,image/webp"' : 'multiple'} hidden data-co-composer-file>
        <button type="button" class="fmco-icon-btn" data-co-composer-emoji title="${(globalThis.PlatformLanguage?.htmlText("comms","m_1832447bbc385c","Insert emoji") ?? "Insert emoji")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_1832447bbc385c","Insert emoji") ?? "Insert emoji")}" aria-expanded="false"><i class="fa-solid fa-face-smile" aria-hidden="true"></i></button>
        ${voice ? `<button type="button" class="fmco-icon-btn" data-co-composer-dictate title="${(globalThis.PlatformLanguage?.htmlText("comms","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}" aria-pressed="false">${voiceIcon('dictation')}</button><button type="button" class="fmco-icon-btn" data-co-composer-audio title="${(globalThis.PlatformLanguage?.htmlText("comms","m_eb0aa857e4778b","Record an audio note") ?? "Record an audio note")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_eb0aa857e4778b","Record an audio note") ?? "Record an audio note")}" aria-pressed="false">${voiceIcon('record')}</button>` : ''}
        <button type="button" class="fmco-btn primary fmco-rich-send" ${send}${sendTitle ? ` title="${sendTitle}"` : ''}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_c23a056552a09f","Send") ?? "Send")}</button>
      </div>
      <div class="fmco-emoji-pop" data-co-composer-emoji-pop hidden></div>
    </div>`;
  }

  function mountComposer(root, kind){
    const box = root.querySelector(`[data-co-composer="${kind}"]`);
    if (!box) return null;
    const { channel } = COMPOSERS[kind];
    const draft = draftFor(kind);
    const widgets = composerWidgets();
    const placeholder = channel === 'sms' ? (globalThis.PlatformLanguage?.text("comms","m_00e2352d42e80c","Write a text message…") ?? "Write a text message…") : kind === 'reply' ? (globalThis.PlatformLanguage?.text("comms","m_cecfa49a90d03c","Write a reply…") ?? "Write a reply…") : (globalThis.PlatformLanguage?.text("comms","m_a2585fc6c21d1a","Write your email…") ?? "Write your email…");
    const editor = widgets?.createEditor ? widgets.createEditor(placeholder) : Object.assign(document.createElement('textarea'), { className:'fmco-rich-plain' });
    editor.setAttribute('aria-label', placeholder);
    editor.placeholder = placeholder;
    editor.dataset.coComposerInput = kind;
    const mount = box.querySelector('[data-co-composer-editor]');
    if (widgets?.formatBar) mount.append(widgets.formatBar(editor, channel === 'sms' ? SMS_FORMATS : undefined));
    mount.append(editor);
    if (draft.body) editor.value = draft.body;
    editor.addEventListener('input', () => { draft.body = editor.value; });
    // A text is plain: the browser's bold, italic and underline shortcuts would show formatting it never sends.
    if (channel === 'sms') editor.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && !event.altKey && ['b', 'i', 'u'].includes(event.key.toLowerCase())) event.preventDefault(); });
    const picker = box.querySelector('[data-co-composer-file]');
    box.querySelector('[data-co-composer-attach]')?.addEventListener('click', () => picker?.click());
    picker?.addEventListener('change', () => { const files = [...(picker.files || [])]; picker.value = ''; files.forEach((file) => attachComposerFile(kind, file)); });
    bindComposerEmoji(box, editor);
    box.querySelector('[data-co-composer-dictate]')?.addEventListener('click', () => recordComposerNote(kind, 'dictation'));
    box.querySelector('[data-co-composer-audio]')?.addEventListener('click', () => recordComposerNote(kind, 'record'));
    paintComposerFiles(kind);
    return editor;
  }

  function bindComposerEmoji(box, editor){
    const button = box.querySelector('[data-co-composer-emoji]'), pop = box.querySelector('[data-co-composer-emoji-pop]');
    const mountPicker = rootWindow.FirstMateChannels?.mountEmojiPicker;
    if (!button || !pop || !mountPicker) { button?.remove(); return; }
    let picker = null;
    const close = () => { picker?.destroy?.(); picker = null; pop.hidden = true; pop.replaceChildren(); button.setAttribute('aria-expanded', 'false'); };
    button.addEventListener('mousedown', () => editor.saveSelection?.());
    button.addEventListener('click', () => {
      if (!pop.hidden) { close(); return; }
      // Open on the side of the box with more room in the thread panel (a new text's box sits near its top).
      const panel = (box.closest('.fmco-thread-view') || box).getBoundingClientRect(), rect = box.getBoundingClientRect();
      pop.classList.toggle('below', panel.bottom - rect.bottom > rect.top - panel.top);
      pop.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      picker = mountPicker(pop, (emoji) => {
        if (editor.insertText) editor.insertText(emoji); else editor.setRangeText(emoji, editor.selectionStart, editor.selectionEnd, 'end');
        editor.dispatchEvent(new Event('input', { bubbles:true }));
        close();
        editor.focus();
      });
      picker?.focus?.();
    });
    box.ownerDocument.addEventListener('pointerdown', (event) => { if (!pop.hidden && !pop.contains(event.target) && !button.contains(event.target)) close(); }, true);
  }

  function syncComposerSend(kind){
    const box = composerBox(kind);
    if (!box) return;
    const draft = draftFor(kind);
    const sms = COMPOSERS[kind].channel === 'sms';
    const media = draft.files.some((file) => file.status !== 'failed');
    const send = box.querySelector('.fmco-rich-send');
    if (send) send.disabled = state.sending || !!draft.recording || draft.files.some((file) => file.status !== 'ready');
    const attach = box.querySelector('[data-co-composer-attach]');
    if (attach) attach.disabled = state.sending || (sms && media);
    for (const [mode, selector] of [['dictation', '[data-co-composer-dictate]'], ['record', '[data-co-composer-audio]']]) {
      const button = box.querySelector(selector);
      if (!button) continue;
      const active = draft.recording === mode;
      button.classList.toggle('voice-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = state.sending || (!!draft.recording && !active) || (mode === 'record' && !draft.recording && (sms ? media : draft.files.some((file) => file.audio)));
    }
  }

  function paintComposerFiles(kind){
    const box = composerBox(kind);
    if (!box) return;
    const draft = draftFor(kind);
    const list = box.querySelector('[data-co-composer-files]');
    list.innerHTML = draft.files.filter((file) => !file.audio).map((file) => `<span class="fmco-rich-file${file.status === 'failed' ? ' failed' : ''}" title="${esc(file.error || file.name)}">${file.preview && file.status !== 'failed' ? `<img src="${esc(file.preview)}" alt="">` : `<i class="fa-solid ${file.status === 'uploading' ? 'fa-circle-notch fa-spin' : file.status === 'failed' ? 'fa-triangle-exclamation' : 'fa-paperclip'}" aria-hidden="true"></i>`}<span>${esc(file.name)}</span><small>${file.status === 'uploading' ? (globalThis.PlatformLanguage?.htmlText("comms","m_50479360308f51","Uploading…") ?? "Uploading…") : file.status === 'failed' ? esc(file.error) : fileSize(file.size)}</small><button type="button" data-co-composer-file-remove="${esc(file.key)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_3ea0f07c7208c2","Remove attachment") ?? "Remove attachment")}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`).join('');
    list.querySelectorAll('[data-co-composer-file-remove]').forEach((button) => button.addEventListener('click', () => removeComposerFile(kind, button.dataset.coComposerFileRemove)));
    const audio = draft.files.find((file) => file.audio);
    const voiceMount = box.querySelector('[data-co-composer-voice]');
    if (audio && voiceMount && !voiceMount.firstChild && !draft.recording) {
      rootWindow.FirstMateAudioNotes?.mountPrepared?.(voiceMount, { url:audio.url, duration:audio.duration, peaks:audio.peaks, onRemove:() => removeComposerFile(kind, audio.key) });
    }
    syncComposerSend(kind);
  }

  function removeComposerFile(kind, fileId){
    const draft = draftFor(kind);
    const removed = draft.files.find((file) => file.key === fileId);
    draft.files = draft.files.filter((file) => file.key !== fileId);
    if (removed?.audio) composerBox(kind)?.querySelector('[data-co-composer-voice]')?.replaceChildren();
    if (removed?.preview) URL.revokeObjectURL(removed.preview);
    paintComposerFiles(kind);
  }

  async function uploadComposerFile(file, slot){
    const media = rootWindow.PlatformAPI?.media;
    if (!media?.upload) throw new Error((globalThis.PlatformLanguage?.text("comms","m_7a8f2e380417f3","Could not upload this file.") ?? "Could not upload this file."));
    const result = await media.upload(orgId(), file, { ownerType:'user', ownerId:currentUserId(), slot, scope:'communications' });
    const stored = object(result?.media || result);
    if (!clean(stored.id)) throw new Error((globalThis.PlatformLanguage?.text("comms","m_7a8f2e380417f3","Could not upload this file.") ?? "Could not upload this file."));
    return stored;
  }

  // The phone tray's preparation (comms/phone-tray.js): JPG, PNG, GIF or WebP, made a JPEG under the MMS limit.
  async function prepareTextImage(file){
    const prepare = Portal.PhoneTexting?.prepareImage;
    if (prepare) return prepare(file);
    if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type) || file.size > 900 * 1024) throw new Error('Attach a JPG, PNG, or GIF image under 900 KB.');
    return file;
  }

  async function attachComposerFile(kind, file){
    const draft = draftFor(kind);
    const sms = COMPOSERS[kind].channel === 'sms';
    const kept = draft.files.filter((item) => item.status !== 'failed');
    const item = { key:fileKey(), name:clean(file.name) || 'Attachment', size:Number(file.size) || 0, status:'uploading', media_id:'', error:'' };
    if (sms && kept.length) Object.assign(item, { status:'failed', error:(globalThis.PlatformLanguage?.text("comms","m_454c8c95547f52","A text can carry one image or one audio note.") ?? "A text can carry one image or one audio note.") });
    else if (kept.length >= EMAIL_ATTACHMENT_COUNT) Object.assign(item, { status:'failed', error:(globalThis.PlatformLanguage?.text("comms","m_17232c58b8f7af","Attach up to 10 files to one email.") ?? "Attach up to 10 files to one email.") });
    else if (!sms && kept.reduce((sum, entry) => sum + entry.size, 0) + item.size > EMAIL_ATTACHMENT_BYTES) Object.assign(item, { status:'failed', error:(globalThis.PlatformLanguage?.text("comms","m_cd26f253a37e4b","Attachments can add up to 10 MB per email.") ?? "Attachments can add up to 10 MB per email.") });
    draft.files.push(item);
    paintComposerFiles(kind);
    if (item.status === 'failed') return;
    try {
      let upload = file;
      if (sms) {
        upload = await prepareTextImage(file);
        Object.assign(item, { image:true, name:clean(upload.name) || item.name, size:Number(upload.size) || item.size, preview:URL.createObjectURL(upload) });
      }
      item.media_id = clean((await uploadComposerFile(upload, sms ? 'sms_image' : 'email_attachment')).id);
      item.status = 'ready';
    } catch (error) { Object.assign(item, { status:'failed', error:error?.message || (globalThis.PlatformLanguage?.text("comms","m_7a8f2e380417f3","Could not upload this file.") ?? "Could not upload this file.") }); }
    paintComposerFiles(kind);
  }

  // Dictation types into the editor. An email's audio note is recorded as a WAV (every mail client plays it) and
  // attached; a text's is the audio note texts have always sent (a short 8 kHz WAV, sent as MMS media).
  async function recordComposerNote(kind, mode){
    const library = rootWindow.FirstMateAudioNotes;
    const draft = draftFor(kind);
    const sms = COMPOSERS[kind].channel === 'sms';
    if (draft.recording) { if (draft.recording === mode) draft.recorder?.stop?.(); return; }
    const mount = composerBox(kind)?.querySelector('[data-co-composer-voice]');
    if (!library?.prepareInline || !mount) return;
    const key = fileKey();
    const name = `${(globalThis.PlatformLanguage?.text("comms","m_52eac0531af849","Audio note") ?? "Audio note")} ${new Date().toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).replace(/[/:]/g, '-')}.wav`;
    let size = 0, url = '';
    draft.recording = mode;
    syncComposerSend(kind);
    try {
      const prepared = await library.prepareInline(orgId(), '', {
        mount, mode, maxSeconds:sms ? 30 : 120,
        onRecordingState:(control) => { draft.recorder = control; },
        ...(mode === 'record' && sms ? { format:'wav', sampleRate:8000 } : {}),
        ...(mode === 'record' && !sms ? {
          format:'wav', sampleRate:16000,
          upload:async (recorded) => {
            const file = new File([recorded], name, { type:'audio/wav' });
            size = file.size;
            if (draft.files.filter((item) => item.status !== 'failed').reduce((sum, item) => sum + item.size, 0) + size > EMAIL_ATTACHMENT_BYTES) throw new Error((globalThis.PlatformLanguage?.text("comms","m_cd26f253a37e4b","Attachments can add up to 10 MB per email.") ?? "Attachments can add up to 10 MB per email."));
            const stored = await uploadComposerFile(file, 'email_attachment');
            url = URL.createObjectURL(file);
            return { media_id:clean(stored.id), file_name:name, content_type:'audio/wav', url };
          }
        } : {}),
        onRemove:() => removeComposerFile(kind, key)
      });
      if (mode === 'dictation') {
        const editor = composerBox(kind)?.querySelector('[data-co-composer-input]');
        draft.body = [clean(editor ? editor.value : draft.body), clean(prepared.text)].filter(Boolean).join(' ');
        if (editor) { editor.value = draft.body; editor.focus(); }
      } else if (prepared.attachment?.media_id) {
        draft.files.push({ key, audio:true, status:'ready', name, size, media_id:prepared.attachment.media_id, url:url || clean(prepared.attachment.public_url || prepared.attachment.url), duration:prepared.metadata?.duration_seconds, peaks:prepared.metadata?.peaks, note:sms ? { ...prepared.metadata, ...prepared.attachment } : null });
      }
    } catch (error) {
      if (!/cancelled/i.test(clean(error?.message))) { state.error = error?.message || 'Voice recording failed.'; draft.recording = ''; draft.recorder = null; render(); return; }
    }
    draft.recording = '';
    draft.recorder = null;
    syncComposerSend(kind);
  }

  async function sendComposer(kind, conversation){
    const draft = draftFor(kind);
    const box = composerBox(kind);
    if (!box || state.sending || draft.recording || draft.files.some((file) => file.status !== 'ready')) return;
    const editor = box.querySelector('[data-co-composer-input]');
    if (editor) draft.body = editor.value;
    const sms = COMPOSERS[kind].channel === 'sms';
    let request;
    if (sms) {
      const text = smsText(draft.body);
      const image = draft.files.find((file) => file.image);
      const audio = draft.files.find((file) => file.audio);
      const to = kind === 'sms-compose' ? splitRecipients(state.smsDraft.to) : [];
      if (kind === 'sms-compose' && !to.length) { contentRoot()?.querySelector('[data-co-sms-to]')?.focus(); return; }
      if (!text && !image && !audio) { editor?.focus(); return; }
      if (text.length > SMS_TEXT_LIMIT) { state.error = (globalThis.PlatformLanguage?.text("comms","m_0af52926f42dbe","Texts can be up to 1600 characters.") ?? "Texts can be up to 1600 characters."); render(); return; }
      const media = { ...(image ? { image:{ media_id:image.media_id } } : {}), ...(audio ? { audio_note:audio.note || { media_id:audio.media_id } } : {}) };
      request = () => api2().sms.send(orgId(), projectId(), kind === 'sms-compose' ? { to, text, ...media } : { conversation_id:clean(conversation?.id), text, ...media });
    } else {
      const { text, html } = emailBodies(draft.body);
      const attachments = draft.files.map((file) => ({ media_id:file.media_id }));
      const body = text || (attachments.length ? draft.files.map((file) => file.name).join('\n') : '');
      let payload;
      if (kind === 'reply') {
        if (!body || !conversation) { editor?.focus(); return; }
        payload = { subject:`Re: ${clean(conversation.subject) || 'your message'}`.replace(/^Re: Re:/i, 'Re:'), conversation_id:clean(conversation.id) };
      } else {
        const to = splitRecipients(state.emailDraft.to);
        const subject = clean(state.emailDraft.subject);
        const missing = !to.length ? '[data-co-email-to]' : !subject ? '[data-co-email-subject]' : '';
        if (missing || !body) { (missing ? contentRoot()?.querySelector(missing) : editor)?.focus(); return; }
        payload = { to, cc:splitRecipients(state.emailDraft.cc), bcc:splitRecipients(state.emailDraft.bcc), subject };
      }
      request = () => api2().email.send(orgId(), projectId(), { ...payload, text:body, format:'markdown', ...(html ? { html } : {}), ...(attachments.length ? { attachments } : {}) });
    }
    state.sending = true;
    syncComposerSend(kind);
    try {
      const sent = await request();
      draft.files.forEach((file) => { if (file.url?.startsWith('blob:')) URL.revokeObjectURL(file.url); if (file.preview) URL.revokeObjectURL(file.preview); });
      state.sending = false;
      const conversationId = clean(object(sent.message).conversation_id);
      if (kind === 'reply') {
        state.emailReply = { threadId:clean(conversation.id), body:'', files:[] };
        await openEmailThread(clean(conversation.id));
      } else if (kind === 'compose') {
        state.emailDraft = { to:'', cc:'', bcc:'', subject:'', body:'', files:[] };
        state.emailComposeOpen = false;
        await loadView();
        if (conversationId) await openEmailThread(conversationId);
      } else {
        state.activeSmsId = conversationId || clean(conversation?.id);
        if (kind === 'sms-compose') { state.smsDraft = { to:'', body:'', files:[] }; state.smsComposeOpen = false; }
        state.smsReply = { threadId:state.activeSmsId, body:'', files:[] };
        await loadView();
      }
    } catch (error) {
      state.sending = false;
      state.error = error?.message || (sms ? 'Could not send the text.' : kind === 'reply' ? 'Could not send the reply.' : 'Could not send the email.');
      render();
    }
  }

  function smsImageHtml(message){
    const id = clean(object(object(message?.metadata).sms_image).media_id);
    const url = id && rootWindow.PlatformAPI?.media?.fileUrl ? rootWindow.PlatformAPI.media.fileUrl(orgId(), id, 'original') : '';
    return url ? `<a class="fmco-msg-image" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt=""></a>` : '';
  }

  function emailAttachmentsHtml(message){
    const metadata = object(message?.metadata);
    const stored = Array.isArray(metadata.email_attachments) ? metadata.email_attachments : Array.isArray(object(metadata.email).attachments) ? object(metadata.email).attachments : [];
    const files = stored.map(object).filter((file) => clean(file.file_name || file.name));
    if (!files.length) return '';
    const fileUrl = (id) => id && rootWindow.PlatformAPI?.media?.fileUrl ? rootWindow.PlatformAPI.media.fileUrl(orgId(), id, 'original') : '';
    return `<div class="fmco-msg-files">${files.map((file) => {
      const url = fileUrl(clean(file.media_id));
      const label = `<i class="fa-solid fa-paperclip" aria-hidden="true"></i><span>${esc(clean(file.file_name || file.name))}</span>`;
      return url ? `<a class="fmco-msg-file" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : `<span class="fmco-msg-file">${label}</span>`;
    }).join('')}</div>`;
  }

  /** A body written in the rich editor shows formatted; anything else (inbound mail, older sends) stays plain text. */
  function emailMessageBody(message){
    const render = composerWidgets()?.renderBody;
    if (clean(object(message?.metadata).email_format) === 'markdown' && render) return `<div class="fmco-msg-rich">${render({ text:String(message.text || '') })}</div>`;
    return esc(clean(message.text));
  }

  const AVATAR_COLORS = ['#1a73e8', '#188038', '#e37400', '#9334e6', '#d01884', '#12a4af', '#5f6368', '#b06000'];
  function avatarColor(seed){
    let hash = 0;
    for (const char of clean(seed).toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  /** An email's text on one line, without Markdown marks (the server's emailSnippet, for a folded card). */
  function emailLine(text){
    return clean(text).replace(/(^|\n)\s*([-*+]|\d+\.|#{1,6}|>)\s+/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`|]+/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Recipients of one email as "to a, b · cc c". */
  function emailToLine(message){
    const recipients = (Array.isArray(message.recipients) ? message.recipients : []).map(object).filter((recipient) => clean(recipient.address));
    const names = (type) => recipients.filter((recipient) => (clean(recipient.type) || 'to') === type).map((recipient) => clean(recipient.name) || contactNameFor(recipient.address) || clean(recipient.address)).join(', ');
    const to = names('to'), cc = names('cc');
    return [to && ((v1) => globalThis.PlatformLanguage?.text("comms","m_c648ede769fadb",`to ${v1}`,{v1}) ?? `to ${v1}`)(to), cc && ((v1) => globalThis.PlatformLanguage?.text("comms","m_1b06b5c29a2df5",`cc ${v1}`,{v1}) ?? `cc ${v1}`)(cc)].filter(Boolean).join(' · ');
  }

  /** Plain-text mail keeps the reply history it quotes behind a ••• toggle, as Gmail does. */
  function emailPlainBody(text){
    const lines = clean(text).split(/\r?\n/);
    const at = lines.findIndex((line, index) => index > 0 && (/^\s*>/.test(line) || /^On .{4,200}wrote:\s*$/.test(line.trim())));
    if (at <= 0) return esc(clean(text));
    return `${esc(lines.slice(0, at).join('\n').trimEnd())}<details class="fmco-mail-quoted"><summary aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_270ef93292386e","Show trimmed content") ?? "Show trimmed content")}">•••</summary><div>${esc(lines.slice(at).join('\n'))}</div></details>`;
  }

  function emailCardHtml(message, options = {}){
    const sender = object(message.sender);
    const address = clean(sender.address || sender.email);
    const who = message.direction === 'inbound' && !clean(sender.name) ? contactNameFor(address) || messageWho(message) : messageWho(message);
    const outbound = message.direction !== 'inbound';
    const threadSubject = clean(options.threadSubject ?? state.emailThread?.subject).replace(/^(re|fwd?):\s*/i, '');
    const subject = clean(message.subject).replace(/^(re|fwd?):\s*/i, '');
    const body = clean(object(message.metadata).email_format) === 'markdown' ? emailMessageBody(message) : emailPlainBody(message.text);
    return `<article class="fmco-mail-card${options.open ? '' : ' collapsed'}${outbound ? ' outbound' : ''}" data-co-mail-msg="${esc(clean(message.id))}">
      <div class="fmco-mail-card-head"${options.toggle ? ` data-co-mail-toggle role="button" tabindex="0" aria-expanded="${options.open ? 'true' : 'false'}"` : ''}>
        <span class="fmco-mail-avatar" style="--fmco-avatar:${outbound ? 'var(--primary,#d93025)' : avatarColor(address || who)}" aria-hidden="true">${esc((who.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>
        <span class="fmco-mail-from">
          <span class="fmco-mail-from-line"><strong>${esc(who)}</strong>${address && address !== who ? `<small>${esc(`<${address}>`)}</small>` : ''}${badges(message)}</span>
          <span class="fmco-mail-to">${esc(emailToLine(message))}</span>
          <span class="fmco-mail-card-snippet">${esc(emailLine(message.text).slice(0, 160))}</span>
        </span>
        <time datetime="${esc(clean(message.created_at))}">${esc(timeLabel(message.created_at))}</time>
      </div>
      <div class="fmco-mail-body">${subject && threadSubject && subject.toLowerCase() !== threadSubject.toLowerCase() ? `<div class="fmco-mail-msg-subject">${esc(clean(message.subject))}</div>` : ''}${body}${audioHtml(message)}${emailAttachmentsHtml(message)}</div>
    </article>`;
  }

  /** The thread as stacked email cards: the newest open, earlier ones folded to a line until clicked. */
  function emailMsgsHtml(thread){
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    return messages.map((message, index) => emailCardHtml(message, {
      toggle:true,
      open:index === messages.length - 1 || state.emailOpenMessages.has(clean(message.id))
    })).join('');
  }

  function bindEmailCards(scroll){
    if (!scroll || scroll.dataset.coMailBound) return;
    scroll.dataset.coMailBound = '1';
    const toggle = (head) => {
      const card = head.closest('[data-co-mail-msg]');
      const id = clean(card?.dataset.coMailMsg);
      if (!card || card === scroll.lastElementChild) return;
      const open = card.classList.toggle('collapsed') === false;
      head.setAttribute('aria-expanded', String(open));
      if (open) state.emailOpenMessages.add(id); else state.emailOpenMessages.delete(id);
    };
    scroll.addEventListener('click', (event) => {
      const head = event.target.closest?.('[data-co-mail-toggle]');
      if (head && !event.target.closest('a,button,details,audio')) toggle(head);
    });
    scroll.addEventListener('keydown', (event) => {
      const head = event.target.closest?.('[data-co-mail-toggle]');
      if (head && event.target === head && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(head); }
    });
  }

  /** Show the newest email from its top, as a mail client opens a thread. */
  function scrollToNewestEmail(root){
    const scroll = root.querySelector('[data-co-scroll]');
    const last = scroll?.lastElementChild;
    if (scroll && last) scroll.scrollTop = Math.max(0, last.offsetTop - 12);
  }

  function renderEmail(root){
    if (state.loading && !state.emailThreads.length && !state.emailThread) { root.innerHTML = loadingHtml(); return; }
    const thread = state.emailThread;
    root.innerHTML = `
      ${errorHtml()}
      <div class="fmco-split fmco-mail${thread || state.emailComposeOpen ? ' thread-mode' : ''}" style="height:100%">
        <div class="fmco-list-col" data-co-list>${emailListHtml()}</div>
        <div class="fmco-mail-peek" data-co-mail-peek hidden aria-hidden="true"></div>
        <div class="fmco-thread-view">
          ${thread ? `
            <div class="fmco-thread-head fmco-mail-head">
              <div style="min-width:0"><div class="fmco-thread-title">${String(esc(clean(thread.subject) || '(no subject)'))}</div><div class="fmco-recipient-summary" title="${String(esc(emailPeopleList(thread.participants).map((person) => person.name ? person.name + ' <' + person.address + '>' : person.address).join(', ')))}">${((v2) => globalThis.PlatformLanguage?.htmlText("comms","m_4a4203a7cc18a9",`With ${v2}`,{v2}) ?? `With ${v2}`)(esc(emailPeople(thread.participants)))}</div></div>
              <button type="button" class="fmco-btn" data-co-thread-close><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fmco-msgs fmco-mail-msgs" data-co-scroll>${String(emailMsgsHtml(thread))}</div>
            <div class="fmco-composer">${String(composerHtml('reply'))}</div>
          ` : state.emailComposeOpen ? `
            <div class="fmco-thread-head"><div style="min-width:0"><div class="fmco-thread-title">${(globalThis.PlatformLanguage?.htmlText("comms","m_71e31660564d5a","New email") ?? "New email")}</div>${String(state.inboxAddress ? `<div class="fmco-thread-sub" title="${esc(state.inboxAddress)}">${((v1) => globalThis.PlatformLanguage?.htmlText("comms","m_75109744834b1c",`Sending as ${v1}`,{v1}) ?? `Sending as ${v1}`)(esc(state.inboxAddress))}</div>` : '')}</div><button type="button" class="fmco-btn" data-co-thread-close><i class="fa-solid fa-xmark"></i></button></div>
            <div class="fmco-composer fmco-email-compose" style="border-top:0">
              ${String(emailRecipientFieldsHtml())}
              <input type="text" class="fmco-input" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_bfb9f300f17496","Subject") ?? "Subject")}" value="${String(esc(state.emailDraft.subject))}" data-co-email-subject>
              ${String(composerHtml('compose'))}
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
    root.querySelector('[data-co-email-subject]')?.addEventListener('input', (event) => { state.emailDraft.subject = event.target.value; });
    bindHintTips(root);
    if (thread && state.emailReply.threadId !== clean(thread.id)) state.emailReply = { threadId:clean(thread.id), body:'', files:[] };
    const composer = thread ? 'reply' : state.emailComposeOpen ? 'compose' : '';
    if (composer) {
      mountComposer(root, composer);
      root.querySelector('.fmco-rich-send')?.addEventListener('click', () => sendComposer(composer, thread));
    }
    bindEmailCards(root.querySelector('.fmco-mail-msgs'));
    scrollToNewestEmail(root);
  }

  // SMS -----------------------------------------------------------------------

  function smsConversations(){
    return Array.isArray(object(state.sms).conversations) ? object(state.sms).conversations : [];
  }

  function activeSmsConversation(){
    return smsConversations().find((conversation) => clean(conversation.id) === state.activeSmsId) || null;
  }

  // FM-588: Texts offer New text only once texting works (voice/status `channels`, comms/setup.ts phoneChannels).
  // Until then the tab says where setup stands. Without an answer it behaves as before.
  async function loadPhoneStatus(){
    try {
      const phone = Portal.CustomerPhone;
      const status = typeof phone?.refreshStatus === 'function' ? await phone.refreshStatus() : await api2().customer(orgId(), 'voice/status');
      state.phone = object(status);
    } catch (_) { state.phone = state.phone || {}; }
  }

  function phoneChannel(channel){ return clean(object(state.phone?.channels)[channel]) || 'ready'; }

  // FM-594: the same panel as the project's Calls (CommunicationsUI.setupPanel in comms/communications-ui.js).
  function phoneSetupHtml(channel){
    const status = phoneChannel(channel);
    const setUp = status !== 'pending' && typeof rootWindow.FirstMateGuides?.play === 'function';
    const copy = status === 'pending'
      ? { icon:'hourglass-half', title:`${(globalThis.PlatformLanguage?.htmlText("comms","m_2285049db07c36","Texts are pending approval") ?? "Texts are pending approval")}`, body:`${(globalThis.PlatformLanguage?.htmlText("comms","m_8517b659bbefd9","Carriers are reviewing your texting registration. This can take a few days, so check back later.") ?? "Carriers are reviewing your texting registration. This can take a few days, so check back later.")}` }
      : status === 'attention'
        ? { icon:'triangle-exclamation', title:`${(globalThis.PlatformLanguage?.htmlText("comms","m_856e6f0aa78a99","Texting registration needs changes") ?? "Texting registration needs changes")}`, body:`${(globalThis.PlatformLanguage?.htmlText("comms","m_6a5f5a12429e2d","Carriers did not approve your texting registration. Continue setup to fix it and send it again.") ?? "Carriers did not approve your texting registration. Continue setup to fix it and send it again.")}` }
        : { icon:'comment-sms', title:`${(globalThis.PlatformLanguage?.htmlText("comms","m_976928725a48f4","Texts are not set up yet") ?? "Texts are not set up yet")}`, body:`${(globalThis.PlatformLanguage?.htmlText("comms","m_53db3de27dfd79","Finish setting up texts and calls to text customers from their project.") ?? "Finish setting up texts and calls to text customers from their project.")}` };
    return Portal.CommunicationsUI.setupPanel({ status, ...copy, attrs:`data-co-phone-setup="${esc(status)}"`,
      button: setUp ? { label:`${(globalThis.PlatformLanguage?.htmlText("comms","m_00f67583b123a0","Continue setup") ?? "Continue setup")}`, attrs:'data-co-setup="phone"', note:'data-co-setup-note' } : null });
  }

  function smsListHtml(){
    const active = activeSmsConversation();
    const ready = phoneChannel('texts') === 'ready';
    return `
      ${String(ready ? `<button type="button" class="fmco-btn primary" data-co-sms-compose style="justify-content:center"><i class="fa-solid fa-pen"></i>${(globalThis.PlatformLanguage?.htmlText("comms","m_3c10edbba72365","New text") ?? "New text")}</button>` : phoneSetupHtml('texts'))}
      ${String(smsConversations().length ? smsConversations().map((conversation) => `
        <button type="button" class="fmco-thread-row${active && clean(active.id) === clean(conversation.id) ? ' active' : ''}" data-co-sms-thread="${esc(clean(conversation.id))}">
          <span class="fmco-thread-subject"><span>${esc(recipientNames(conversation.participants))}</span></span>
          <span class="fmco-thread-meta"><span>${((v4,v5) => globalThis.PlatformLanguage?.htmlText("comms","m_2de5206655064d",`${v4} message${v5}`,{v4,v5}) ?? `${v4} message${v5}`)(Number(conversation.message_count || 0),Number(conversation.message_count || 0) === 1 ? '' : 's')}</span><span>${esc(timeLabel(conversation.last_message_at))}</span></span>
        </button>
      `).join('') : ready ? `<div class="fmco-empty"><i class="fa-solid fa-comment-sms"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_25af8c4f012bc1","No text threads yet.") ?? "No text threads yet.")}</p></div>` : '')}
    `;
  }

  function bindSmsList(scope){
    scope.querySelector('[data-co-sms-compose]')?.addEventListener('click', () => { beginSmsDraft(); render(); });
    scope.querySelectorAll('[data-co-setup]').forEach((button) => {
      button.addEventListener('click', () => { void setUpChannel(button.dataset.coSetup, button); });
    });
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
      <div class="fmco-msg ${message.direction}${message.source_kind === 'ai' ? ' ai' : ''}">${esc(clean(message.text))}${smsImageHtml(message)}${audioHtml(message)}</div>
    `).join('') : `<div class="fmco-empty" style="margin:auto"><i class="fa-solid fa-comment-sms"></i><p>${(globalThis.PlatformLanguage?.htmlText("comms","m_06fc4f53d27077","No text messages yet.") ?? "No text messages yet.")}</p></div>`;
  }

  function renderSms(root){
    if (state.loading && !state.sms) { root.innerHTML = loadingHtml(); return; }
    const ready = phoneChannel('texts') === 'ready';
    if (!ready) state.smsComposeOpen = false;
    if (!ready && !smsConversations().length) {
      root.innerHTML = `${errorHtml()}<div class="fmcm-setup-page">${phoneSetupHtml('texts')}</div>`;
      bindSmsList(root);
      return;
    }
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
              <div class="fmco-tip-host"><div class="fmco-recipient-box" aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_9cdf1c6f55699f","Text recipients") ?? "Text recipients")}">
                <div class="fmco-recipient-row has-tip"><label class="fmco-recipient-label" for="fmcoSmsTo">${(globalThis.PlatformLanguage?.htmlText("comms","m_af8bc9e774b68c","To") ?? "To")}</label><input id="fmcoSmsTo" class="fmco-recipient-input" type="text" value="${String(esc(state.smsDraft.to))}" placeholder="+1 206 555 1234" data-co-sms-to>${String(hintTip(globalThis.PlatformLanguage?.text("comms","m_6530a8d89e9c93","Separate multiple phone numbers with commas to start a group thread") ?? "Separate multiple phone numbers with commas to start a group thread"))}</div>
              </div></div>
              ${String(contactChipsHtml('sms', 'to'))}
              ${String(composerHtml('sms-compose'))}
            </div>
          ` : active ? `
            <div class="fmco-thread-head">
              <div style="min-width:0"><div class="fmco-thread-title"><i class="fa-solid fa-comment-sms" style="margin-right:7px;color:#667085"></i>${String(esc(recipientNames(active.participants)))}</div><div class="fmco-recipient-summary">${String(esc((active.participants || []).map((participant) => clean(participant.address)).filter(Boolean).join(', ')))}</div></div>
              <button type="button" class="fmco-btn" data-co-sms-close><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fmco-msgs" data-co-scroll>${String(smsMsgsHtml(active))}</div>
            ${String(ready ? '' : `<div class="fmco-composer" data-co-sms-off><span class="fmco-composer-hint">${phoneChannel('texts') === 'pending' ? (globalThis.PlatformLanguage?.htmlText("comms","m_651562ad9e13ae","You can reply once texting is approved.") ?? "You can reply once texting is approved.") : (globalThis.PlatformLanguage?.htmlText("comms","m_537214cee9376e","You can reply once texts are set up.") ?? "You can reply once texts are set up.")}</span></div>`)}
            <div class="fmco-composer"${ready ? '' : ' hidden'}>${String(composerHtml('sms-reply'))}</div>
          ` : `<div class="fmco-empty" style="margin:auto"><i class="fa-solid fa-comment-sms"></i><p>${ready ? (globalThis.PlatformLanguage?.htmlText("comms","m_bd100abbcef202","Select a text thread or start a new one.") ?? "Select a text thread or start a new one.") : (globalThis.PlatformLanguage?.htmlText("comms","m_5e1987c94b5e12","Select a text thread to read it.") ?? "Select a text thread to read it.")}</p></div>`}
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
    bindHintTips(root);
    root.querySelectorAll('[data-co-add-sms]').forEach((button) => {
      button.addEventListener('click', () => {
        state.smsDraft.to = addRecipient(state.smsDraft.to, clean(button.dataset.coAddSms));
        render();
      });
    });
    if (active && state.smsReply.threadId !== clean(active.id)) state.smsReply = { threadId:clean(active.id), body:'', files:[] };
    const composer = state.smsComposeOpen ? 'sms-compose' : active && ready ? 'sms-reply' : '';
    if (composer) {
      mountComposer(root, composer);
      root.querySelector('.fmco-rich-send')?.addEventListener('click', () => sendComposer(composer, active));
    }
    rootWindow.FirstMateAudioNotes?.hydrate?.(root);
    scrollBottom(root);
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
      button.addEventListener('click', () => { state.activeChatId = button.dataset.coChat; state.chatPicking = false; render(); });
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
              <button type="button" class="fmco-btn fmco-phone-only" data-co-chat-close aria-label="${(globalThis.PlatformLanguage?.htmlText("comms","m_3742924668fb10","Close") ?? "Close")}"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fmco-msgs" data-co-scroll>${String(chatMsgsHtml(active))}</div>
            <div class="fmco-composer">
              <div style="display:flex;gap:8px;align-items:flex-end">
                <textarea class="fmco-textarea" style="min-height:44px" placeholder="${(globalThis.PlatformLanguage?.htmlText("comms","m_5287d898a85931","Reply in the customer portal chat…") ?? "Reply in the customer portal chat…")}" data-co-chat-input></textarea>
                ${String(clean(state.chatVoice.mode) !== 'off' ? `<button type="button" class="fmco-btn fmco-voice" data-co-chat-voice><span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;mask:url(/libraries/voice-icons/${clean(state.chatVoice.mode) === 'dictation' ? 'dictation' : 'record'}.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/${clean(state.chatVoice.mode) === 'dictation' ? 'dictation' : 'record'}.svg) center/contain no-repeat"></span><small>${clean(state.chatVoice.mode) === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '')}
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
    // Phone: an open chat fills the tab, so this goes back to the list (and
    // keeps the poll from opening the first chat again).
    root.querySelector('[data-co-chat-close]')?.addEventListener('click', () => { state.activeChatId = ''; state.chatPicking = true; render(); });
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
  // On Calls the one search box filters the project's calls; elsewhere it searches every message.
  function syncSearchBox(clear){
    const input = state.panelRoot?.querySelector('[data-co-search]');
    if (!input) return;
    if (clear) { input.value = ''; state.search.query = ''; if (searchTimer) clearTimeout(searchTimer); }
    input.placeholder = state.view === 'calls'
      ? (globalThis.PlatformLanguage?.text("comms","m_eb57b9fe518a5c",'Search calls…',{v0:'calls'}) ?? 'Search calls…')
      : (globalThis.PlatformLanguage?.text("comms","m_ba670f4714e86b","Search all communications…") ?? "Search all communications…");
  }
  function bindSearch(){
    const input = state.panelRoot?.querySelector('[data-co-search]');
    if (!input || input.dataset.coBound === '1') return;
    input.dataset.coBound = '1';
    input.addEventListener('input', () => {
      const query = clean(input.value);
      state.search.query = query;
      if (searchTimer) clearTimeout(searchTimer);
      if (state.view === 'calls') { state.callsHandle?.search(query); return; }
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
    if (!state.sidebarRoot || !state.sidebarRoot.isConnected) {
      state.sidebarRoot = state.context?.sidebarRoot || state.context?.roots?.sidebar
        || document.querySelector('#rOverlay #coSidebarSection') || state.sidebarRoot;
    }
    if (!state.sidebarRoot) return null;
    let list = state.sidebarRoot.querySelector('#coSidebarList');
    if (!list) {
      state.sidebarRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="coSidebarLabel">${(globalThis.PlatformLanguage?.htmlText("comms","m_da0c54815d9259","Comms") ?? "Comms")}</label>
          <div class="r-proposal-listing" id="coSidebarList"></div>
        </div></div></div>
      `;
      list = state.sidebarRoot.querySelector('#coSidebarList');
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
    // The left region is a SHARED container (#coSidebarList) that other main
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
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
    // A text's image has no height until it loads: stay at the bottom when it arrives (FM-587).
    scroll.querySelectorAll('.fmco-msg-image img').forEach((image) => {
      if (!image.complete) image.addEventListener('load', () => { if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < image.offsetHeight + 80) scroll.scrollTop = scroll.scrollHeight; }, { once:true });
    });
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
    state.sidebarRoot = context.sidebarRoot || context.roots?.sidebar || state.sidebarRoot;
    state.active = context.active !== false;
    document.getElementById('rOverlay')?.classList.toggle('communications-wide',state.active);
    state.mounted = !!state.panelRoot;
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) reset();
    if (state.panelRoot && !state.panelRoot.querySelector('[data-comms-root]')) {
      state.panelRoot.innerHTML = panelHtml();
    }
    state.panelRoot?.querySelector('[data-comms-root]')?.removeAttribute('data-co-pending');
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
    state.sidebarRoot?.querySelector?.('#coSidebarList .fmco-left')?.remove();
    state.sidebarRoot?.classList?.remove('visible','mode-edit','mode-list','mode-send');
    const route = Portal.navigation?.read?.() || {};
    if (clean(route.commsView)) state.view = clean(route.commsView);
    state.search.calls = state.view === 'calls';
    syncSearchBox(false);
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
      state.sidebarRoot?.querySelector?.('#coSidebarList .fmco-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || '';
      if (!['proposal', 'materials', 'schedule', 'money', 'comms'].includes(activeTab)) {
        state.sidebarRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
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
    state.emailDraft = { to:'', cc:'', bcc:'', subject:'', body:'', files:[] };
    state.emailReply = { threadId:'', body:'', files:[] };
    state.sms = null;
    state.phone = null;
    state.activeSmsId = '';
    state.smsComposeOpen = false;
    state.smsDraft = { to:'', body:'', files:[] };
    state.smsReply = { threadId:'', body:'', files:[] };
    state.chatConversations = [];
    state.chatVoice = { mode:'attachment', max_seconds:120 };
    state.activeChatId = '';
    state.chatPicking = false;
    state.search = { open:false, query:'', results:[], busy:false };
    state.agent = { open:false, threadId:'', messages:[], busy:false };
    state.settings = { overrides:null, saving:false, loaded:false };
    state.voiceSettings = { sms:'attachment', email:'dictation' };
    state.pendingVoice = { chat:null };
    state.sync = { overview:'', emailList:'', emailMsgs:'', sms:'', chatList:'', chatMsgs:'' };
    state.inboxAddress = '';
    state.error = '';
  }

  function destroy(){
    document.getElementById('rOverlay')?.classList.remove('communications-wide');
    stopPoll();
    if (leftRetryTimer) { clearTimeout(leftRetryTimer); leftRetryTimer = 0; }
    state.sidebarRoot?.querySelector?.('#coSidebarList .fmco-left')?.remove();
    state.sidebarRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    reset();
    state.mounted = false;
    state.panelRoot = null;
    state.sidebarRoot = null;
  }

  function openContactDraft(channel,recipient){
    if(!['email','sms'].includes(channel) || !visibleTabs().some(tab=>tab.id===channel))throw new Error('This communication channel is not available.');
    if(channel==='email'){beginEmailDraft();state.emailDraft.to=clean(recipient);}
    else {beginSmsDraft();state.smsDraft.to=clean(recipient);}
    setView(channel,{pushRoute:true});
  }
  const api = {
    openContactDraft,
    mount,
    setActive,
    activate: () => setActive(true),
    deactivate: () => setActive(false),
    render,
    reset,
    destroy,
    unmount: destroy,
    context: () => ({ mounted: state.mounted, active: state.active, view: state.view, channels: { email: can('comms.email'), sms: can('comms.sms') } }),
    // The dev console (dev-console/sections/comms.js) simulates the customer replying on this project.
    async simulateInbound({ channel, text }) {
      if (!state.mounted || !['email', 'sms'].includes(channel) || !clean(text)) throw new Error('Open a project\'s Comms tab first.');
      if (state.simulateBusy) return;
      state.simulateBusy = true;
      try {
        await api2().simulateInbound(orgId(), projectId(), { channel, text: clean(text), ...(channel === 'email' ? { subject: 'Message from your customer' } : {}) });
        await loadView();
      } finally { state.simulateBusy = false; }
    }
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

  // The Communications setup turned a channel on: show its tab and drop its setup card.
  rootWindow.addEventListener('fm:comms:setup-changed', () => {
    if (!state.mounted) return;
    renderTabs();
    if (state.view === 'overview') render();
    else if (state.view === 'sms') loadView().catch(() => null);
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
    regions: ['main'],
    requiresContext: ['project'],
    dependencies: [],
    panelHtml,
    mount
  });
})();
