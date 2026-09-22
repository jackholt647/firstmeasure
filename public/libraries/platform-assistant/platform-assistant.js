/* public/libraries/platform-assistant/platform-assistant.js
 * The global FirstMate AI assistant drawer: a fixed right-hand chat panel
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
    pending:false,
    view:'chat' // chat | history
  };

  let els = null;

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
      .fma-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,94vw);z-index:1400;background:#fff;border-left:1px solid #e4e7ec;box-shadow:-14px 0 44px rgba(16,24,40,.16);transform:translateX(105%);transition:transform .32s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;color:#101828;font-size:14px;}
      .fma-drawer.open{transform:none;}
      .fma-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e4e7ec;}
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
      .fma-welcome{align-self:stretch;text-align:center;color:#667085;padding:26px 18px 10px;}
      .fma-welcome i{font-size:24px;color:var(--primary-readable, var(--primary, #175cd3));margin-bottom:10px;display:block;}
      .fma-welcome .hi{font-weight:800;color:#101828;margin-bottom:4px;}
      .fma-welcome .hint{font-size:12.5px;line-height:1.5;}
      .fma-suggests{display:flex;flex-direction:column;gap:7px;margin-top:14px;}
      .fma-suggest{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px 12px;text-align:left;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;color:#344054;transition:background .15s ease,border-color .15s ease,transform .12s ease;}
      .fma-suggest:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-history{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px;}
      .fma-history-head{font-size:12px;font-weight:800;color:#667085;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;}
      .fma-history-item{border:1px solid #e4e7ec;border-radius:10px;padding:9px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:background .15s ease,border-color .15s ease,transform .15s ease;}
      .fma-history-item:hover{background:#f9fafb;border-color:#98a2b3;transform:translateX(2px);}
      .fma-history-item .name{font-weight:700;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fma-history-item .meta{font-size:11.5px;color:#98a2b3;font-weight:600;}
      .fma-empty{color:#98a2b3;text-align:center;padding:22px 8px;font-weight:600;}
      .fma-composer{flex:0 0 auto;display:flex;gap:8px;padding:11px 13px;border-top:1px solid #e4e7ec;}
      .fma-composer textarea{flex:1;resize:none;border:1px solid #d0d5dd;border-radius:9px;padding:9px 11px;font:inherit;min-height:44px;max-height:170px;}
      .fma-composer textarea:focus{outline:none;border-color:var(--primary-readable, var(--primary, #175cd3));}
      .fma-send{align-self:flex-end;width:38px;height:38px;border-radius:10px;border:none;cursor:pointer;background:var(--primary-readable, var(--primary, #175cd3));color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;transition:filter .15s ease,transform .12s ease;}
      .fma-send:hover{filter:brightness(1.08);}
      .fma-send:active{transform:scale(.95);}
      .fma-send:disabled{opacity:.5;cursor:default;}
      @media (max-width:640px){.fma-drawer{width:100vw;border-left:none;}}
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
    drawer.innerHTML = `
      <div class="fma-head">
        <span class="fma-badge"><span class="fma-logo"></span></span>
        <div class="fma-head-text">
          <div class="title" data-fma="title">${(globalThis.PlatformLanguage?.text("platform-assistant","m_8a1a2ff14a50f1","Assistant") ?? "Assistant")}</div>
          <div class="sub">${(globalThis.PlatformLanguage?.text("platform-assistant","m_90443542c7b175","AI Assistant") ?? "AI Assistant")}</div>
        </div>
        <button type="button" class="fma-icon-btn" data-fma="history" title="${(globalThis.PlatformLanguage?.text("platform-assistant","m_a8eeb1d7ca9666","Conversation history") ?? "Conversation history")}"><i class="fas fa-clock-rotate-left"></i></button>
        <button type="button" class="fma-icon-btn" data-fma="new" title="${(globalThis.PlatformLanguage?.text("platform-assistant","m_84e4d3109d655d","New conversation") ?? "New conversation")}"><i class="fas fa-plus"></i></button>
        <button type="button" class="fma-icon-btn" data-fma="close" title="${(globalThis.PlatformLanguage?.text("platform-assistant","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="fma-msgs" data-fma="msgs"></div>
      <div class="fma-history" data-fma="historyList" style="display:none;"></div>
      <div class="fma-composer" data-fma="composer">
        <textarea data-fma="input" rows="1" placeholder="${(globalThis.PlatformLanguage?.text("platform-assistant","m_2f18b7bd77b80f","Ask about anything in your workspace...") ?? "Ask about anything in your workspace...")}"></textarea>
        <button type="button" class="fma-send" data-fma="send" title="${(globalThis.PlatformLanguage?.text("platform-assistant","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
      </div>
    `;
    document.body.appendChild(drawer);
    els = {
      drawer,
      title: drawer.querySelector('[data-fma="title"]'),
      msgs: drawer.querySelector('[data-fma="msgs"]'),
      historyList: drawer.querySelector('[data-fma="historyList"]'),
      composer: drawer.querySelector('[data-fma="composer"]'),
      input: drawer.querySelector('[data-fma="input"]'),
      send: drawer.querySelector('[data-fma="send"]')
    };

    drawer.querySelector('[data-fma="close"]').addEventListener('click', close);
    drawer.querySelector('[data-fma="new"]').addEventListener('click', startNewThread);
    drawer.querySelector('[data-fma="history"]').addEventListener('click', toggleHistory);
    els.send.addEventListener('click', sendMessage);
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
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
      return `<div class="fma-msg user${anim}">${esc(message.content)}</div>`;
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
    const items = state.threads.map((thread) => `
      <div class="fma-history-item" data-thread-id="${esc(clean(thread.id))}">
        <div class="name">${esc(clean(thread.title) || 'New conversation')}</div>
        <div class="meta">${esc(clean(thread.updated_at).slice(0, 10))}</div>
      </div>
    `);
    els.historyList.innerHTML = `<div class="fma-history-head">${(globalThis.PlatformLanguage?.text("platform-assistant","m_ee81752261cfa1","Conversations") ?? "Conversations")}</div>${String(items.join('') || '<div class="fma-empty">No conversations yet.</div>')}`;
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
    els.historyList.style.display = chat ? 'none' : '';
    if (!chat) renderHistory();
  }

  function toggleHistory(){
    setView(state.view === 'history' ? 'chat' : 'history');
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
      if (els?.title) els.title.textContent = state.assistantName;
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
    } catch (error) {
      console.warn('[assistant] failed to open conversation', error);
    }
  }

  function startNewThread(){
    state.threadId = '';
    state.messages = [];
    setView('chat');
    renderMessages();
    els?.input?.focus();
  }

  async function ensureThread(){
    if (state.threadId) return state.threadId;
    const result = await window.AssistantAPI.createThread(orgId(), { branch_id:branchId() });
    state.threadId = clean(object(result.thread).id);
    state.threads.unshift(object(result.thread));
    return state.threadId;
  }

  async function sendMessage(){
    if (!els || state.pending) return;
    const text = clean(els.input.value);
    if (!text) return;
    els.input.value = '';
    state.messages.push({ id:`local_${Date.now()}`, role:'user', content:text, data:{} });
    state.pending = true;
    els.send.disabled = true;
    renderMessages({ animateLast:true });
    try {
      const threadId = await ensureThread();
      const result = await window.AssistantAPI.send(orgId(), threadId, {
        message:text,
        branch_id:branchId()
      }, { signal:AbortSignal.timeout(AGENT_TIMEOUT_MS) });
      const assistantMessage = object(result.assistant_message);
      state.messages.push({
        id: clean(assistantMessage.id) || `local_${Date.now()}_a`,
        role:'assistant',
        content:String(assistantMessage.content ?? ''),
        data: object(assistantMessage.data)
      });
    } catch (error) {
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
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function open(){
    if (!available()) return;
    build();
    state.open = true;
    els.drawer.classList.add('open');
    boot();
    setTimeout(() => els?.input?.focus(), 220);
  }

  function close(){
    if (!state.built) return;
    state.open = false;
    els.drawer.classList.remove('open');
  }

  function toggle(){
    if (state.open) close();
    else open();
  }

  window.PlatformAssistant = {
    open,
    close,
    toggle,
    isOpen(){ return state.open; },
    available
  };
})();
