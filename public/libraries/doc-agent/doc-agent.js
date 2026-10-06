/* public/libraries/doc-agent/doc-agent.js
 * Embeddable chat panel for the "docs" document-designer agent — the copilot
 * that edits workflows, templates, and documents conversationally inside the
 * document engine's editing surfaces (Doc Studio + project documents).
 *
 * The host owns the definition being edited: it supplies getInput() (the
 * current in-editor definition sent with every message) and onAction(action)
 * (applies the agent's staged replacement to the live editor). Rendering
 * reuses the shared FirstMateAgentChat engine so replies, "What changed"
 * summaries, and chips look like every other agent surface.
 *
 * Usage:
 *   const panel = FMDocAgentPanel.create(hostEl, {
 *     orgId, subjectId: workflow.id,
 *     title: 'Design copilot',
 *     welcome: 'Tell me what this workflow should do…',
 *     suggestions: ['Add a customer signature step'],
 *     getInput: () => ({ mode:'workflow', subject:{...}, definition:{...} }),
 *     onAction: (action) => { ...apply... }
 *   });
 *   panel.destroy();
 */
(function(){
  'use strict';

  const AGENT_ID = 'docs';
  const PREFIX = 'fmda';
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];

  /** Capability gate — mirrors the platform assistant's available() check. */
  function available(){
    try {
      const Portal = window.Portal;
      if (!Portal?.capabilities) return true; // capabilities not resolved yet — let the API decide
      return Portal.can('documents.agent') !== false;
    } catch (_) { return true; }
  }

  function ensureCss(){
    if (document.getElementById('fm-doc-agent-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-doc-agent-css';
    style.textContent = `
      .${PREFIX}-panel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;background:#fff}
      .${PREFIX}-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f6;flex:0 0 auto}
      .${PREFIX}-head strong{font-size:12.5px;font-weight:850;color:#1d2939;display:inline-flex;align-items:center;gap:7px;min-width:0}
      .${PREFIX}-head strong i{color:var(--primary,#175cd3);font-size:12px}
      .${PREFIX}-head-btn{margin-left:auto;width:26px;height:26px;border-radius:8px;border:1px solid #e4e7ec;background:#fff;color:#667085;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center}
      .${PREFIX}-head-btn:hover{color:#1d2939;border-color:#d0d5dd}
      .${PREFIX}-msgs{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:9px;background:#fbfcfe}
      .${PREFIX}-msg{max-width:94%;padding:8px 11px;border-radius:12px;font-size:12.5px;line-height:1.55;color:#1d2939;overflow-wrap:anywhere}
      .${PREFIX}-msg.user{align-self:flex-end;background:var(--primary,#175cd3);color:var(--fmdx-on-primary,#fff);border-bottom-right-radius:4px;white-space:pre-wrap}
      .${PREFIX}-msg.assistant{align-self:flex-start;background:#fff;border:1px solid #e8ebf2;border-bottom-left-radius:4px}
      .${PREFIX}-msg.assistant.failed{border-color:#fecdca;background:#fffbfa}
      .${PREFIX}-msg.assistant.pending{color:#667085;font-weight:650}
      .${PREFIX}-msg.assistant.pending i{margin-right:6px;color:var(--primary,#175cd3)}
      .${PREFIX}-msg code{background:#f2f4f7;border-radius:4px;padding:1px 4px;font-size:11px}
      .${PREFIX}-welcome{margin:auto 0;text-align:center;color:#667085;font-size:12.5px;padding:18px 14px;display:flex;flex-direction:column;gap:10px;align-items:center}
      .${PREFIX}-welcome i{font-size:22px;color:var(--primary,#175cd3)}
      .${PREFIX}-welcome strong{color:#344054;font-size:13px}
      .${PREFIX}-suggestions{display:flex;flex-direction:column;gap:6px;width:100%}
      .${PREFIX}-suggestion{border:1px solid #e4e7ec;background:#fff;border-radius:10px;padding:7px 11px;font-size:12px;font-weight:700;color:#475467;cursor:pointer;text-align:left}
      .${PREFIX}-suggestion:hover{border-color:var(--primary,#175cd3);color:var(--primary,#175cd3)}
      .${PREFIX}-composer{flex:0 0 auto;display:flex;gap:7px;align-items:flex-end;border-top:1px solid #eef0f6;padding:10px 12px;background:#fff}
      .${PREFIX}-input{flex:1;min-height:36px;max-height:120px;resize:none;border:1px solid #d0d5dd;border-radius:10px;padding:8px 11px;font:inherit;font-size:12.5px;line-height:1.45;color:#1d2939;background:#fff}
      .${PREFIX}-input:focus{outline:none;border-color:var(--primary,#175cd3)}
      .${PREFIX}-send{width:36px;height:36px;border-radius:10px;border:0;background:var(--primary,#175cd3);color:var(--fmdx-on-primary,#fff);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
      .${PREFIX}-send:disabled{opacity:.5;cursor:default}
      .${PREFIX}-unavailable{margin:auto;text-align:center;color:#98a2b3;font-size:12.5px;padding:20px;display:flex;flex-direction:column;gap:8px;align-items:center}
      .${PREFIX}-unavailable i{font-size:20px}
    `;
    document.head.appendChild(style);
  }

  function create(host, options = {}){
    if (!host) return null;
    ensureCss();
    window.FirstMateAgentChat?.injectBaseCss?.(PREFIX);

    const state = {
      destroyed: false,
      busy: false,
      thread: null,
      messages: [],
      loaded: false,
      queuedMessages: []
    };
    const orgId = clean(options.orgId);
    const subjectId = clean(options.subjectId);
    const api = () => window.AgentsAPI;

    host.innerHTML = `
      <div class="${String(PREFIX)}-panel">
        <div class="${String(PREFIX)}-head">
          <strong><i class="fas fa-wand-magic-sparkles"></i> ${String(esc(clean(options.title) || 'Design copilot'))}</strong>
          <button type="button" class="${String(PREFIX)}-head-btn" data-da-new title="${(globalThis.PlatformLanguage?.htmlText("doc-agent","m_e7f0edd8a4b5be","Start a new conversation") ?? "Start a new conversation")}"><i class="fas fa-plus"></i></button>
        </div>
        <div class="${String(PREFIX)}-msgs" data-da-msgs></div>
        <div class="${String(PREFIX)}-composer">
          <textarea class="${String(PREFIX)}-input" data-da-input rows="1" placeholder="${String(esc(clean(options.placeholder) || 'Describe the change you want…'))}"></textarea>
          <button type="button" class="${String(PREFIX)}-send" data-da-send title="${(globalThis.PlatformLanguage?.htmlText("doc-agent","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
        </div>
      </div>`;
    const msgsEl = host.querySelector('[data-da-msgs]');
    const inputEl = host.querySelector('[data-da-input]');
    const sendBtn = host.querySelector('[data-da-send]');

    function scrollToEnd(){ msgsEl.scrollTop = msgsEl.scrollHeight; }

    function welcomeHtml(){
      const suggestions = array(options.suggestions).map(clean).filter(Boolean);
      return `
        <div class="${PREFIX}-welcome">
          <i class="fas fa-wand-magic-sparkles"></i>
          <strong>${esc(clean(options.welcomeTitle) || 'Describe it — I’ll build it')}</strong>
          <span>${esc(clean(options.welcome) || 'Tell me what you want in plain language and I’ll edit it here in real time.')}</span>
          ${suggestions.length ? `<div class="${PREFIX}-suggestions">${suggestions.map((text) => `<button type="button" class="${PREFIX}-suggestion" data-da-suggest="${esc(text)}">${esc(text)}</button>`).join('')}</div>` : ''}
        </div>`;
    }

    function renderMessages(){
      if (state.destroyed) return;
      const chat = window.FirstMateAgentChat;
      if (!state.messages.length) {
        msgsEl.innerHTML = welcomeHtml();
        msgsEl.querySelectorAll('[data-da-suggest]').forEach((btn) => btn.addEventListener('click', () => {
          inputEl.value = btn.getAttribute('data-da-suggest') || '';
          send();
        }));
        return;
      }
      msgsEl.innerHTML = state.messages.map((message) => chat
        ? chat.messageHtml(message, { prefix: PREFIX })
        : `<div class="${PREFIX}-msg ${clean(message.role) === 'user' ? 'user' : 'assistant'}">${esc(message.content)}</div>`).join('');
      chat?.bindActions?.(msgsEl, state.messages);
      scrollToEnd();
    }

    function setBusy(busy){
      state.busy = busy;
      sendBtn.disabled = busy;
      inputEl.disabled = busy;
    }

    async function ensureThread(fresh){
      if (state.thread && !fresh) return state.thread;
      const body = subjectId ? { subject_id: subjectId } : {};
      if (!fresh) {
        try {
          const res = await api().threads(orgId, AGENT_ID, subjectId ? { subjectId } : {});
          const existing = array(res.threads)[0];
          if (existing?.id) {
            state.thread = existing;
            const detail = await api().thread(orgId, AGENT_ID, existing.id);
            state.messages = array(detail.messages);
            return state.thread;
          }
        } catch (error) { console.warn('[doc-agent] thread lookup failed', error); }
      }
      const created = await api().createThread(orgId, AGENT_ID, body);
      state.thread = object(created.thread);
      state.messages = [];
      return state.thread;
    }

    async function boot(){
      if (!available()) {
        msgsEl.innerHTML = `<div class="${String(PREFIX)}-unavailable"><i class="fas fa-wand-magic-sparkles"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-agent","m_2bc4619571c6d8","The Document Designer agent is turned off for this workspace.") ?? "The Document Designer agent is turned off for this workspace.")}<br>${(globalThis.PlatformLanguage?.htmlText("doc-agent","m_b5271e6ee249a2","Enable it under Company Settings → AI Agents.") ?? "Enable it under Company Settings → AI Agents.")}</span></div>`;
        inputEl.disabled = true;
        sendBtn.disabled = true;
        return;
      }
      if (!api()) {
        msgsEl.innerHTML = `<div class="${String(PREFIX)}-unavailable"><i class="fas fa-plug-circle-xmark"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-agent","m_580ec3477e2c69","The agents service is not loaded for this session.") ?? "The agents service is not loaded for this session.")}</span></div>`;
        return;
      }
      try {
        await ensureThread(false);
        state.loaded = true;
        renderMessages();
        // A host-provided command represents explicit user intent. Send it
        // even when this subject already has a conversation history.
        const kickoff = clean(options.initialMessage);
        if (kickoff) state.queuedMessages.push(kickoff);
        drainQueuedMessages();
      } catch (error) {
        console.warn('[doc-agent] boot failed', error);
        msgsEl.innerHTML = `<div class="${PREFIX}-unavailable"><i class="fas fa-cloud-bolt"></i><span>${esc(clean(error?.message) || 'Could not reach the design copilot.')}</span></div>`;
      }
    }

    async function send(){
      const text = clean(inputEl.value);
      if (!text || state.busy || state.destroyed) return;
      inputEl.value = '';
      setBusy(true);
      state.messages.push({ id: `local_${Date.now()}`, role: 'user', content: text });
      state.messages.push({ id: 'local_pending', role: 'assistant', pending: true, content: 'Working on it…' });
      renderMessages();
      try {
        const thread = await ensureThread(false);
        const input = (() => {
          try { return object(options.getInput?.()); } catch (_) { return {}; }
        })();
        const result = await api().send(orgId, AGENT_ID, thread.id, { message: text, input }, { signal: AbortSignal.timeout(180000) });
        state.messages = state.messages.filter((m) => m.id !== 'local_pending');
        if (result.user_message) state.messages.splice(state.messages.length - 1, 1, result.user_message);
        if (result.assistant_message) state.messages.push(result.assistant_message);
        renderMessages();
        // Live-apply: hand every staged action to the host editor.
        array(result.actions).forEach((action) => {
          try { options.onAction?.(object(action)); } catch (error) { console.warn('[doc-agent] onAction failed', error); }
        });
      } catch (error) {
        state.messages = state.messages.filter((m) => m.id !== 'local_pending');
        state.messages.push({ id: `local_err_${Date.now()}`, role: 'assistant', content: clean(error?.message) || 'Something went wrong — try again.', data: { status: 'failed' } });
        renderMessages();
      } finally {
        if (!state.destroyed) { setBusy(false); inputEl.focus(); drainQueuedMessages(); }
      }
    }

    function sendMessage(message){
      const text = clean(message);
      if (!text || state.destroyed) return;
      state.queuedMessages.push(text);
      drainQueuedMessages();
    }

    function drainQueuedMessages(){
      if (!state.loaded || state.busy || state.destroyed || !state.queuedMessages.length) return;
      inputEl.value = state.queuedMessages.shift();
      send();
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = `${Math.min(120, inputEl.scrollHeight)}px`;
    });
    host.querySelector('[data-da-new]')?.addEventListener('click', async () => {
      if (state.busy) return;
      setBusy(true);
      try { await ensureThread(true); renderMessages(); }
      catch (error) { console.warn('[doc-agent] new thread failed', error); }
      finally { setBusy(false); }
    });

    boot();

    return {
      el: host,
      focus(){ try { inputEl.focus(); } catch (_) {} },
      send: sendMessage,
      destroy(){
        state.destroyed = true;
        host.innerHTML = '';
      }
    };
  }

  window.FMDocAgentPanel = { create, available, AGENT_ID };
})();
