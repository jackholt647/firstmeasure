/* libraries/chat-embed/firstmate-chat-embed.js
 * Public browser embed for FirstMate live chat.
 *
 * Inputs:
 *   FirstMateChatEmbed.init({ widgetKey, baseUrl, position })
 *   <script src="/libraries/chat-embed/firstmate-chat-embed.js" data-widget-key="cw_x" async></script>
 *
 * Server:
 *   GET  /v1/chat/public/widgets/:widgetKey
 *   POST /v1/chat/public/widgets/:widgetKey/sessions
 *   POST /v1/chat/public/widgets/:widgetKey/conversations
 *   POST /v1/chat/public/widgets/:widgetKey/conversations/:id/messages
 *   GET  /v1/chat/public/widgets/:widgetKey/conversations/:id/feed?after=<cursor>
 *
 * Output:
 *   A floating chat launcher + panel, themed from org settings, that keeps its
 *   visitor identity in localStorage so conversations survive reloads.
 */
(function(){
  const root = window;
  if (root.FirstMateChatEmbed) return;

  const FONT_URLS = {
    Montserrat: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&display=swap',
    Inter: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    Roboto: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap',
    'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap',
    Lato: 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap',
    Poppins: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap',
    'Source Sans 3': 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap'
  };

  function cleanText(value){ return String(value ?? '').trim(); }
  function esc(value){
    return cleanText(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }
  function uuid(){
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }
  function currentScript(){
    return document.currentScript || document.querySelector('script[data-widget-key][src*="firstmate-chat-embed"]');
  }
  function defaultBaseUrl(){
    const script = currentScript();
    const explicit = cleanText(script?.dataset?.baseUrl);
    if (explicit) return explicit.replace(/\/+$/, '');
    try {
      const src = new URL(script?.src || '', location.href);
      if ((src.hostname === 'localhost' || src.hostname === '127.0.0.1')) return `${src.protocol}//${src.hostname}:3101/v1/chat`;
      return `${src.origin}/v1/chat`;
    } catch {
      return `${location.origin}/v1/chat`;
    }
  }
  function injectFont(font){
    const url = FONT_URLS[font];
    if (!url || document.querySelector(`link[data-fm-chat-font="${CSS.escape(font)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.fmChatFont = font;
    document.head.appendChild(link);
  }

  function storageGet(key){
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function storageSet(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  function timeLabel(iso){
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  class ChatWidget {
    constructor(options){
      this.widgetKey = cleanText(options.widgetKey);
      this.baseUrl = cleanText(options.baseUrl) || defaultBaseUrl();
      this.positionOverride = cleanText(options.position);
      this.portalGrant = cleanText(options.portalGrant);
      this.pageContextProvider = typeof options.pageContextProvider === 'function' ? options.pageContextProvider : null;
      this.pageSnapshotProvider = typeof options.pageSnapshotProvider === 'function' ? options.pageSnapshotProvider : null;
      this.storageKey = `fmchat:${this.widgetKey}`;
      this.instanceId = `fmce_${Math.random().toString(36).slice(2, 10)}`;
      this.config = null;
      this.session = null;
      this.conversationId = '';
      this.cursor = '';
      this.messages = [];
      this.conversationLiveStatus = '';
      this.conversationHandling = '';
      this.conversationTeamPresent = false;
      this.open = false;
      this.unread = 0;
      this.pollTimer = null;
      this.typingSentAt = 0;
      this.sendingIds = new Set();
      this.preChatDone = false;
      this.detailsSubmitted = false;
      this.pendingVoice = null;
      this.destroyed = false;

      const stored = storageGet(this.storageKey) || {};
      this.visitorToken = cleanText(stored.visitor_token);
      this.conversationId = cleanText(stored.open_conversation_id);
      if (stored.identity && typeof stored.identity === 'object') this.identity = stored.identity;
    }

    async pageContext(){
      const base = {
        kind: 'website',
        title: cleanText(document.title),
        // Query strings commonly contain portal/access tokens. The existing
        // page_url remains available to the service, while the durable visual
        // context intentionally records only the safe page location.
        url: `${location.origin}${location.pathname}`,
        captured_at: new Date().toISOString(),
        viewport: { width: Math.max(0, Math.round(innerWidth || 0)), height: Math.max(0, Math.round(innerHeight || 0)) }
      };
      let context = base;
      try {
        const provided = this.pageContextProvider ? await this.pageContextProvider() : null;
        if (provided && typeof provided === 'object') context = { ...base, ...provided };
      } catch {}
      if (!this.pageSnapshotProvider || !this.visitorToken) return context;
      try {
        const rendered = await this.pageSnapshotProvider();
        if (rendered?.blob instanceof Blob && rendered.blob.size) {
          const snapshot = await this.uploadPageSnapshot(rendered);
          if (snapshot) context.snapshot = snapshot;
        }
      } catch (error) {
        console.warn('Live chat page snapshot failed', error);
      }
      return context;
    }

    async uploadPageSnapshot(rendered){
      const form = new FormData();
      const contentType = cleanText(rendered.blob.type) || 'image/jpeg';
      form.append('file', rendered.blob, contentType === 'image/png' ? 'customer-page.png' : 'customer-page.jpg');
      form.append('width', String(Math.max(1, Math.round(Number(rendered.width) || 1))));
      form.append('height', String(Math.max(1, Math.round(Number(rendered.height) || 1))));
      const response = await fetch(`${this.baseUrl}/public/widgets/${encodeURIComponent(this.widgetKey)}/page-snapshots`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.visitorToken}` },
        body: form
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok || data?.ok === false) throw new Error(cleanText(data?.message || data?.error) || `Page snapshot upload failed (${response.status})`);
      return data?.snapshot || null;
    }

    persist(){
      storageSet(this.storageKey, {
        visitor_token: this.visitorToken,
        open_conversation_id: this.conversationId,
        identity: this.identity || null
      });
    }

    async fetchJson(path, options = {}){
      const headers = {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.visitorToken ? { Authorization: `Bearer ${this.visitorToken}` } : {})
      };
      const res = await fetch(`${this.baseUrl}/${path.replace(/^\/+/, '')}`, {
        ...options, cache: 'no-store', credentials: 'omit', headers
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok || data?.ok === false) {
        const error = new Error(cleanText(data?.message || data?.error) || `Chat request failed (${res.status})`);
        error.code = cleanText(data?.error);
        error.status = res.status;
        throw error;
      }
      return data;
    }

    async boot(){
      try {
        const data = await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}`);
        this.config = data.widget;
      } catch {
        return; // Widget unavailable (disabled, revoked key) — render nothing.
      }
      injectFont(this.config.appearance.font_family);
      this.mount();
    }

    // --- DOM ---------------------------------------------------------------

    mount(){
      const appearance = this.config.appearance;
      const host = document.createElement('div');
      host.id = this.instanceId;
      host.className = `fmce-root ${appearance.position === 'bottom_left' ? 'fmce-left' : 'fmce-right'}`;
      host.innerHTML = (String(this.styleTag()) + "\n        <button type=\"button\" class=\"fmce-launcher\" aria-label=\"" + String(esc(appearance.launcher_label)) + "\">\n          <span class=\"fmce-launcher-icon\">\n            <svg viewBox=\"0 0 24 24\" width=\"26\" height=\"26\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/></svg>\n          </span>\n          <span class=\"fmce-launcher-close\">\n            <svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg>\n          </span>\n          <span class=\"fmce-badge\" hidden></span>\n        </button>\n        <div class=\"fmce-panel\" hidden>\n          <div class=\"fmce-header\">\n            <div class=\"fmce-header-main\">\n              <span class=\"fmce-status-dot\"></span>\n              <div>\n                <div class=\"fmce-header-title\"></div>\n                <div class=\"fmce-header-sub\"></div>\n              </div>\n            </div>\n            <button type=\"button\" class=\"fmce-min\" aria-label=\"" + (globalThis.PlatformLanguage?.htmlText("chat-embed","m_16d35abc7a6b88","Minimize chat") ?? "Minimize chat") + "\">\n              <svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M5 12h14\"/></svg>\n            </button>\n          </div>\n          <div class=\"fmce-body\"></div>\n          <div class=\"fmce-footer\">\n            <div class=\"fmce-composer\">\n              <textarea class=\"fmce-input\" rows=\"1\" spellcheck=\"true\" placeholder=\"" + (globalThis.PlatformLanguage?.htmlText("chat-embed","m_9e7fd62bf04a3f","Write a message…") ?? "Write a message…") + "\"></textarea>\n              " + String(cleanText(this.config.voice?.mode) !== 'off' ? `<button type="button" class="fmce-voice" aria-label="${cleanText(this.config.voice?.mode) === 'dictation' ? 'Dictate message' : 'Attach audio message'}" title="${cleanText(this.config.voice?.mode) === 'dictation' ? 'Dictation' : 'Attach audio'}"><span>🎙</span><small>${cleanText(this.config.voice?.mode) === 'dictation' ? 'Dictate' : 'Audio'}</small></button>` : '') + "\n              <button type=\"button\" class=\"fmce-send\" aria-label=\"" + (globalThis.PlatformLanguage?.htmlText("chat-embed","m_c23a056552a09f","Send") ?? "Send") + "\">\n                <svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"currentColor\"><path d=\"M3.4 20.4l17.8-8.4L3.4 3.6l-.01 6.53L14 12 3.39 13.87z\"/></svg>\n              </button>\n            </div>\n            <div class=\"fmce-voice-mount\"></div>\n            " + String(appearance.show_branding ? `<div class="fmce-brand">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_2cb43f3b6430c4","Powered by FirstMate") ?? "Powered by FirstMate")}</div>` : '') + "\n          </div>\n        </div>");
      document.body.appendChild(host);
      this.host = host;
      this.panel = host.querySelector('.fmce-panel');
      this.body = host.querySelector('.fmce-body');
      this.input = host.querySelector('.fmce-input');
      this.launcher = host.querySelector('.fmce-launcher');
      this.badge = host.querySelector('.fmce-badge');

      this.launcher.addEventListener('click', () => this.open ? this.closePanel() : this.openPanel());
      host.querySelector('.fmce-min').addEventListener('click', () => this.closePanel());
      host.querySelector('.fmce-send').addEventListener('click', () => this.handleSend());
      host.querySelector('.fmce-voice')?.addEventListener('click', () => this.handleVoice());
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.handleSend();
        }
      });
      this.input.addEventListener('input', () => {
        this.autosize();
        this.sendTyping();
      });
      document.addEventListener('visibilitychange', () => this.schedulePoll());
      this.renderHeader();
      this.renderBody();
    }

    styleTag(){
      const a = this.config.appearance;
      return `<style>
        #${this.instanceId}{ --fmce-primary:${esc(a.primary_color)}; --fmce-bg:${esc(a.background_color)}; --fmce-text:${esc(a.text_color)};
          --fmce-font:'${esc(a.font_family)}', system-ui, -apple-system, sans-serif;
          position:fixed; bottom:20px; z-index:2147483000; font-family:var(--fmce-font); font-size:15px; line-height:1.45; }
        #${this.instanceId}.fmce-right{ right:20px; } #${this.instanceId}.fmce-left{ left:20px; }
        #${this.instanceId} *{ box-sizing:border-box; margin:0; padding:0; }
        #${this.instanceId} .fmce-launcher{ position:relative; width:58px; height:58px; border:none; border-radius:50%;
          background:var(--fmce-primary); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
          box-shadow:0 6px 24px rgba(0,0,0,.22); transition:transform .18s ease, box-shadow .18s ease; margin-left:auto; }
        #${this.instanceId}.fmce-left .fmce-launcher{ margin-left:0; margin-right:auto; }
        #${this.instanceId} .fmce-launcher:hover{ transform:scale(1.06); box-shadow:0 8px 28px rgba(0,0,0,.28); }
        #${this.instanceId} .fmce-launcher-close{ display:none; }
        #${this.instanceId}.fmce-open .fmce-launcher-icon{ display:none; }
        #${this.instanceId}.fmce-open .fmce-launcher-close{ display:flex; }
        #${this.instanceId} .fmce-badge{ position:absolute; top:-2px; right:-2px; min-width:20px; height:20px; padding:0 5px;
          border-radius:10px; background:#e5484d; color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
        #${this.instanceId} .fmce-panel{ position:absolute; bottom:72px; width:372px; max-width:calc(100vw - 32px); height:560px;
          max-height:calc(100vh - 110px); background:var(--fmce-bg); color:var(--fmce-text); border-radius:16px; overflow:hidden;
          display:flex; flex-direction:column; box-shadow:0 12px 48px rgba(0,0,0,.24); opacity:0; transform:translateY(14px) scale(.98);
          transition:opacity .2s ease, transform .2s ease; pointer-events:none; }
        #${this.instanceId}.fmce-right .fmce-panel{ right:0; } #${this.instanceId}.fmce-left .fmce-panel{ left:0; }
        #${this.instanceId}.fmce-open .fmce-panel{ opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
        #${this.instanceId} .fmce-header{ background:var(--fmce-primary); color:#fff; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto; }
        #${this.instanceId} .fmce-header-main{ display:flex; align-items:center; gap:10px; min-width:0; }
        #${this.instanceId} .fmce-header-title{ font-weight:700; font-size:15px; }
        #${this.instanceId} .fmce-header-sub{ font-size:12.5px; opacity:.85; }
        #${this.instanceId} .fmce-status-dot{ width:10px; height:10px; border-radius:50%; background:#3ddc84; flex:0 0 auto; box-shadow:0 0 0 3px rgba(255,255,255,.25); }
        #${this.instanceId}.fmce-offline .fmce-status-dot{ background:#f0b429; }
        #${this.instanceId} .fmce-min{ background:rgba(255,255,255,.14); color:#fff; border:none; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        #${this.instanceId} .fmce-min:hover{ background:rgba(255,255,255,.24); }
        #${this.instanceId} .fmce-body{ flex:1 1 auto; overflow-y:auto; padding:16px 14px 8px; display:flex; flex-direction:column; gap:10px; scroll-behavior:smooth; background:var(--fmce-bg); }
        #${this.instanceId} .fmce-msg{ max-width:82%; padding:9px 13px; border-radius:16px; font-size:14.5px; white-space:pre-wrap; word-wrap:break-word; animation:fmceIn .18s ease; }
        @keyframes fmceIn{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }
        #${this.instanceId} .fmce-msg.visitor{ align-self:flex-end; background:var(--fmce-primary); color:#fff; border-bottom-right-radius:5px; }
        #${this.instanceId} .fmce-msg.agent{ align-self:flex-start; background:rgba(0,0,0,.06); color:var(--fmce-text); border-bottom-left-radius:5px; }
        #${this.instanceId} .fmce-msg.pending{ opacity:.65; }
        #${this.instanceId} .fmce-meta{ font-size:11.5px; opacity:.55; margin-top:-4px; }
        #${this.instanceId} .fmce-meta.visitor{ align-self:flex-end; } #${this.instanceId} .fmce-meta.agent{ align-self:flex-start; }
        #${this.instanceId} .fmce-day{ align-self:center; font-size:11.5px; opacity:.5; margin:6px 0 2px; }
        #${this.instanceId} .fmce-greeting{ background:rgba(0,0,0,.05); border-radius:14px; padding:12px 14px; font-size:14.5px; align-self:flex-start; max-width:88%; }
        #${this.instanceId} .fmce-typing{ align-self:flex-start; display:flex; gap:4px; padding:12px 14px; background:rgba(0,0,0,.06); border-radius:16px; border-bottom-left-radius:5px; }
        #${this.instanceId} .fmce-typing i{ width:7px; height:7px; border-radius:50%; background:var(--fmce-text); opacity:.4; animation:fmceBounce 1.2s infinite; }
        #${this.instanceId} .fmce-typing i:nth-child(2){ animation-delay:.15s; } #${this.instanceId} .fmce-typing i:nth-child(3){ animation-delay:.3s; }
        @keyframes fmceBounce{ 0%,60%,100%{ transform:none; } 30%{ transform:translateY(-5px); } }
        #${this.instanceId} .fmce-footer{ flex:0 0 auto; border-top:1px solid rgba(0,0,0,.08); background:var(--fmce-bg); }
        #${this.instanceId} .fmce-composer{ display:flex; align-items:flex-end; gap:8px; padding:10px 12px; }
        #${this.instanceId} .fmce-voice{ flex:0 0 auto; min-width:44px; height:38px; border:1px solid rgba(0,0,0,.14); border-radius:11px; background:transparent; color:var(--fmce-text); cursor:pointer; display:grid; place-items:center; line-height:1; }
        #${this.instanceId} .fmce-voice small{font:600 8px/1 var(--fmce-font);opacity:.66} #${this.instanceId} .fmce-voice:disabled{opacity:.45;cursor:default}
        #${this.instanceId} .fmce-voice-mount{padding:0 12px 8px} #${this.instanceId} .fmce-voice-mount:empty{display:none}
        #${this.instanceId} .fmce-msg-audio{margin-top:6px;min-width:210px}
        #${this.instanceId} .fmce-input{ flex:1; border:1px solid rgba(0,0,0,.14); border-radius:12px; padding:9px 12px; font:inherit; font-size:14.5px;
          color:var(--fmce-text); background:var(--fmce-bg); resize:none; max-height:110px; outline:none; transition:border-color .15s; }
        #${this.instanceId} .fmce-input:focus{ border-color:var(--fmce-primary); }
        #${this.instanceId} .fmce-send{ flex:0 0 auto; width:38px; height:38px; border:none; border-radius:12px; background:var(--fmce-primary); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity .15s, transform .12s; }
        #${this.instanceId} .fmce-send:hover{ transform:scale(1.05); }
        #${this.instanceId} .fmce-send:disabled{ opacity:.45; cursor:default; transform:none; }
        #${this.instanceId} .fmce-brand{ text-align:center; font-size:11px; opacity:.45; padding:0 0 8px; }
        #${this.instanceId} .fmce-form{ display:flex; flex-direction:column; gap:8px; background:rgba(0,0,0,.04); padding:14px; border-radius:14px; }
        #${this.instanceId} .fmce-form label{ font-size:12.5px; font-weight:600; opacity:.8; }
        #${this.instanceId} .fmce-form input{ border:1px solid rgba(0,0,0,.14); border-radius:10px; padding:8px 11px; font:inherit; font-size:14px; background:var(--fmce-bg); color:var(--fmce-text); outline:none; }
        #${this.instanceId} .fmce-form input:focus{ border-color:var(--fmce-primary); }
        #${this.instanceId} .fmce-btn{ border:none; border-radius:10px; background:var(--fmce-primary); color:#fff; font:inherit; font-size:14px; font-weight:600; padding:9px 14px; cursor:pointer; transition:opacity .15s; }
        #${this.instanceId} .fmce-btn:hover{ opacity:.9; }
        #${this.instanceId} .fmce-btn.ghost{ background:transparent; color:var(--fmce-primary); }
        #${this.instanceId} .fmce-note{ font-size:13px; opacity:.7; text-align:center; padding:4px 8px; }
        #${this.instanceId} .fmce-offline-banner{ background:#fff7e6; border:1px solid #f0d9a8; color:#7a5c12; border-radius:12px; padding:10px 13px; font-size:13.5px; align-self:stretch; }
        #${this.instanceId} .fmce-history{ display:flex; flex-direction:column; gap:6px; }
        #${this.instanceId} .fmce-history-item{ border:1px solid rgba(0,0,0,.1); border-radius:12px; padding:10px 12px; cursor:pointer; background:transparent; text-align:left; font:inherit; color:var(--fmce-text); transition:background .12s; }
        #${this.instanceId} .fmce-history-item:hover{ background:rgba(0,0,0,.04); }
        #${this.instanceId} .fmce-history-item small{ display:block; opacity:.55; font-size:12px; margin-top:2px; }
        #${this.instanceId} .fmce-section-title{ font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; opacity:.5; margin-top:4px; }
        @media (max-width:520px){
          #${this.instanceId} .fmce-panel{ position:fixed; inset:0; width:100%; height:100%; max-width:none; max-height:none; border-radius:0; bottom:0; }
          #${this.instanceId}.fmce-open .fmce-launcher{ display:none; }
        }
      </style>`;
    }

    renderHeader(){
      const online = this.isAvailableNow();
      const aiActive = this.conversationId ? this.conversationHandling === 'ai' : this.config.ai;
      this.host.classList.toggle('fmce-offline', !online);
      this.host.querySelector('.fmce-header-title').textContent = this.config.appearance.launcher_label || 'Chat with us';
      this.host.querySelector('.fmce-header-sub').textContent = online
        ? (aiActive && this.config.ai_disclose ? 'AI assistant • replies instantly' : this.conversationTeamPresent ? 'A team member is here' : 'We typically reply in a few minutes')
        : 'We’re offline right now';
    }

    isAvailableNow(){
      if (this.conversationId) {
        return this.conversationHandling === 'ai' || this.conversationLiveStatus === 'online';
      }
      return this.config.status === 'online' || this.config.ai;
    }

    // --- Panel lifecycle ---------------------------------------------------

    async openPanel(){
      this.open = true;
      this.unread = 0;
      this.updateBadge();
      this.host.classList.add('fmce-open');
      this.panel.hidden = false;
      if (!this.session) {
        try { await this.ensureSession(); } catch { this.renderNote('Chat is unavailable right now. Please try again later.'); return; }
      }
      this.renderBody();
      this.schedulePoll();
      setTimeout(() => this.input?.focus(), 220);
    }

    closePanel(){
      this.open = false;
      this.host.classList.remove('fmce-open');
      this.schedulePoll();
    }

    async ensureSession(){
      const data = await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          visitor_token: this.visitorToken || undefined,
          page_url: location.href,
          portal_grant: this.portalGrant || undefined
        })
      });
      this.visitorToken = cleanText(data.visitor_token);
      this.session = data;
      const open = (data.conversations || []).find((item) => item.status === 'open');
      if (this.conversationId && !(data.conversations || []).some((item) => item.id === this.conversationId)) this.conversationId = '';
      if (!this.conversationId && open) this.conversationId = open.id;
      this.persist();
      if (this.conversationId) await this.loadFeed(true);
    }

    // --- Rendering ---------------------------------------------------------

    renderBody(){
      if (!this.body) return;
      const config = this.config;
      const online = this.isAvailableNow();
      const parts = [];

      if (!this.conversationId) {
        parts.push(`<div class="fmce-greeting">${esc(config.copy.greeting)}</div>`);
        if (!online) parts.push(`<div class="fmce-offline-banner">${esc(config.copy.offline_message)}</div>`);
        if (this.needsPreChat()) parts.push(this.preChatForm());
        const closed = (this.session?.conversations || []).filter((item) => item.status === 'closed');
        if (config.history_visible && closed.length) {
          parts.push(`<div class="fmce-section-title">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_a418e0fa2c0fa0","Previous conversations") ?? "Previous conversations")}</div>`);
          parts.push(`<div class="fmce-history">${closed.slice(0, 5).map((item) => `
            <button type="button" class="fmce-history-item" data-history-id="${String(esc(item.id))}">
              ${String(esc((item.last_message?.text || 'Conversation').slice(0, 70)))}
              <small>${((v2,v3) => globalThis.PlatformLanguage?.htmlText("chat-embed","m_e0dc03a4a52948",`${v2} • ${v3} messages`,{v2,v3}) ?? `${v2} • ${v3} messages`)(esc(new Date(item.created_at).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.())),item.message_count)}</small>
            </button>`).join('')}</div>`);
        }
      } else {
        parts.push(this.messagesHtml());
        if (this.agentTyping) parts.push('<div class="fmce-typing"><i></i><i></i><i></i></div>');
        if (this.conversationClosed) {
          parts.push(`<div class="fmce-note">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_52ad0207a8dd5a","This conversation has ended.") ?? "This conversation has ended.")}</div>`);
          parts.push(`<button type="button" class="fmce-btn ghost" data-action="new-chat">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_d5f9696cb48cf7","Start a new chat") ?? "Start a new chat")}</button>`);
        } else if (!online && !this.detailsSubmitted && this.shouldOfferDetails()) {
          parts.push(this.offlineDetailsForm());
        }
      }
      this.body.innerHTML = parts.join('');
      root.FirstMateAudioNotes?.hydrate?.(this.body);
      this.wireBody();
      this.scrollToEnd();
      const composerHidden = this.conversationClosed || (!this.conversationId && this.needsPreChat());
      this.host.querySelector('.fmce-composer').style.display = composerHidden ? 'none' : 'flex';
    }

    messagesHtml(){
      const out = [];
      let lastDay = '';
      for (const message of this.messages) {
        const day = new Date(message.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
        if (day !== lastDay) { out.push(`<div class="fmce-day">${esc(day)}</div>`); lastDay = day; }
        const mine = message.direction === 'inbound';
        const cls = mine ? 'visitor' : 'agent';
        const note = message.metadata?.audio_note;
        const audio = note?.public_url && root.FirstMateAudioNotes
          ? `<div class="fmce-msg-audio">${root.FirstMateAudioNotes.playerHtml({ url:note.public_url, duration:note.duration_seconds, peaks:note.peaks })}</div>`
          : '';
        out.push(`<div class="fmce-msg ${cls} ${message.pending ? 'pending' : ''}">${esc(message.text)}${audio}</div>`);
        const label = mine ? timeLabel(message.created_at) : [message.sender?.name, timeLabel(message.created_at)].filter(Boolean).join(' • ');
        if (label) out.push(`<div class="fmce-meta ${cls}">${esc(label)}</div>`);
      }
      return out.join('');
    }

    needsPreChat(){
      const pre = this.config.pre_chat;
      if (this.preChatDone || this.identity) return false;
      return pre.require_name || pre.require_email || pre.require_phone;
    }

    preChatForm(){
      const pre = this.config.pre_chat;
      return `<form class="fmce-form" data-form="pre-chat">
        ${String(pre.require_name ? `<label>${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_8cf345002184e5","Name") ?? "Name")}</label><input name="name" required autocomplete="name">` : '')}
        ${String(pre.require_email ? `<label>${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_5d2b9327181e33","Email") ?? "Email")}</label><input name="email" type="email" required autocomplete="email">` : '')}
        ${String(pre.require_phone ? `<label>${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_ed04c65845180f","Phone") ?? "Phone")}</label><input name="phone" type="tel" required autocomplete="tel">` : '')}
        <button type="submit" class="fmce-btn">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_6cb9c39d67a388","Start chat") ?? "Start chat")}</button>
      </form>`;
    }

    shouldOfferDetails(){
      return this.messages.some((message) => message.direction === 'inbound') && !this.session?.identified;
    }

    offlineDetailsForm(){
      return `<form class="fmce-form" data-form="details">
        <div style="font-size:13.5px;">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_7c6ebe768edfcf","Leave your email and we’ll follow up:") ?? "Leave your email and we’ll follow up:")}</div>
        <label>${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_5d2b9327181e33","Email") ?? "Email")}</label><input name="email" type="email" required autocomplete="email">
        <label>${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_3b439645b0b1ae","Name (optional)") ?? "Name (optional)")}</label><input name="name" autocomplete="name">
        <button type="submit" class="fmce-btn">${(globalThis.PlatformLanguage?.htmlText("chat-embed","m_c23a056552a09f","Send") ?? "Send")}</button>
      </form>`;
    }

    wireBody(){
      this.body.querySelectorAll('[data-history-id]').forEach((el) => {
        el.addEventListener('click', () => this.openHistory(el.dataset.historyId));
      });
      const preChat = this.body.querySelector('[data-form="pre-chat"]');
      if (preChat) preChat.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(preChat).entries());
        this.identity = data;
        this.preChatDone = true;
        this.persist();
        this.renderBody();
        this.input?.focus();
      });
      const details = this.body.querySelector('[data-form="details"]');
      if (details) details.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(details).entries());
        try {
          await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/conversations/${encodeURIComponent(this.conversationId)}/details`, {
            method: 'POST', body: JSON.stringify(data)
          });
          this.detailsSubmitted = true;
          this.renderBody();
          this.renderNote('Thanks! We’ll be in touch soon.');
        } catch {}
      });
      const newChat = this.body.querySelector('[data-action="new-chat"]');
      if (newChat) newChat.addEventListener('click', async () => {
        this.conversationId = '';
        this.messages = [];
        this.cursor = '';
        this.conversationClosed = false;
        this.conversationLiveStatus = '';
        this.conversationHandling = '';
        this.conversationTeamPresent = false;
        this.persist();
        this.renderHeader();
        this.renderBody();
        // Refresh the session so the just-closed conversation shows up under
        // "Previous conversations" without a page reload.
        try { await this.ensureSession(); } catch {}
        this.renderBody();
      });
    }

    async openHistory(conversationId){
      this.conversationId = cleanText(conversationId);
      this.messages = [];
      this.cursor = '';
      this.persist();
      await this.loadFeed(true);
      this.renderBody();
    }

    renderNote(text){
      const note = document.createElement('div');
      note.className = 'fmce-note';
      note.textContent = text;
      this.body.appendChild(note);
      this.scrollToEnd();
    }

    scrollToEnd(){
      if (this.body) this.body.scrollTop = this.body.scrollHeight;
    }

    autosize(){
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(110, this.input.scrollHeight)}px`;
    }

    updateBadge(){
      if (!this.badge) return;
      this.badge.hidden = !this.unread;
      this.badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
    }

    async ensureAudioLibrary(){
      if (root.FirstMateAudioNotes) return root.FirstMateAudioNotes;
      if (!this.audioLibraryPromise) {
        this.audioLibraryPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          let assetOrigin = this.baseUrl.replace(/\/v1\/chat\/?$/i, '');
          try { assetOrigin = new URL(currentScript()?.src || '', location.href).origin; } catch {}
          script.src = `${assetOrigin}/libraries/audio-notes/audio-notes.js?v=20260725-communications-voice-v2`;
          script.onload = () => resolve(root.FirstMateAudioNotes);
          script.onerror = () => reject(new Error('Voice recording could not be loaded.'));
          document.head.appendChild(script);
        });
      }
      return this.audioLibraryPromise;
    }

    async preparePublicAudio(file, options = {}){
      const form = new FormData();
      form.append('file', file, file.name || 'voice-message.webm');
      const response = await fetch(`${this.baseUrl}/public/widgets/${encodeURIComponent(this.widgetKey)}/audio`, {
        method:'POST',
        headers:{ Accept:'application/json', Authorization:`Bearer ${this.visitorToken}` },
        body:form,
        credentials:'omit',
        signal:options.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) throw new Error(cleanText(data?.message || data?.error) || 'Voice recording failed.');
      return data;
    }

    async handleVoice(){
      const button = this.host.querySelector('.fmce-voice');
      const mount = this.host.querySelector('.fmce-voice-mount');
      if (!button || !mount) return;
      button.disabled = true;
      try {
        await this.ensureSession();
        const library = await this.ensureAudioLibrary();
        const mode = cleanText(this.config.voice?.mode) || 'attachment';
        const prepared = await library.prepareInline('', '', {
          mount,
          mode,
          maxSeconds:Number(this.config.voice?.max_seconds || 120),
          prepareRecording:(file, options) => this.preparePublicAudio(file, options),
          onRemove:() => { this.pendingVoice = null; }
        });
        this.input.value = [cleanText(this.input.value), prepared.text].filter(Boolean).join(' ');
        this.autosize();
        this.pendingVoice = prepared.attachment ? prepared : null;
        this.input.focus();
      } catch (error) {
        if (!/cancelled/i.test(cleanText(error?.message))) this.renderNote(cleanText(error?.message) || 'Voice recording failed.');
      } finally {
        button.disabled = false;
      }
    }

    // --- Messaging ---------------------------------------------------------

    async handleSend(){
      const text = cleanText(this.input.value);
      if (!text) return;
      const voice = this.pendingVoice;
      this.input.value = '';
      this.autosize();
      const pending = {
        id: `pending_${uuid()}`,
        direction: 'inbound',
        text,
        created_at: new Date().toISOString(),
        metadata:voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {},
        pending: true
      };
      this.messages.push(pending);
      this.renderBody();
      try {
        const pageContext = await this.pageContext();
        if (!this.conversationId) {
          const data = await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/conversations`, {
            method: 'POST',
            body: JSON.stringify({
              message: text,
              ...(this.identity || {}),
              page_url: location.href,
              page_context: pageContext,
              ...(voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {}),
              idempotency_key: uuid()
            })
          });
          this.conversationId = data.conversation.id;
          this.conversationClosed = false;
          this.conversationLiveStatus = cleanText(data.conversation.live_status);
          this.conversationHandling = cleanText(data.conversation.handling);
          this.conversationTeamPresent = data.conversation.team_present === true;
          this.renderHeader();
          this.persist();
          this.replacePending(pending.id, data.message);
        } else {
          const data = await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/conversations/${encodeURIComponent(this.conversationId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              message: text,
              page_url: location.href,
              page_context: pageContext,
              ...(voice?.attachment ? { audio_note:{ ...voice.metadata, ...voice.attachment } } : {}),
              idempotency_key: uuid()
            })
          });
          this.replacePending(pending.id, data.message);
        }
        this.schedulePoll(true);
        this.pendingVoice = null;
        const voiceMount = this.host.querySelector('.fmce-voice-mount');
        if (voiceMount) voiceMount.innerHTML = '';
      } catch (error) {
        console.warn('Live chat message failed', error);
        this.messages = this.messages.filter((message) => message.id !== pending.id);
        this.renderBody();
        this.renderNote(error?.status === 429
          ? 'You’re sending messages too quickly — give it a moment.'
          : (cleanText(error?.message) || 'That message didn’t send. Please try again.'));
        this.input.value = text;
        this.autosize();
      }
    }

    replacePending(pendingId, message){
      const index = this.messages.findIndex((item) => item.id === pendingId);
      if (index >= 0 && message) {
        this.messages[index] = message;
        if (message.cursor && message.cursor > this.cursor) this.cursor = message.cursor;
      }
      this.renderBody();
    }

    sendTyping(){
      if (!this.conversationId || this.conversationClosed) return;
      const now = Date.now();
      if (now - this.typingSentAt < 3000) return;
      this.typingSentAt = now;
      this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/conversations/${encodeURIComponent(this.conversationId)}/typing`, { method: 'POST', body: '{}' }).catch(() => {});
    }

    // --- Polling -----------------------------------------------------------

    schedulePoll(immediate){
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
      if (this.destroyed || !this.conversationId) return;
      const hidden = document.visibilityState === 'hidden';
      const delay = immediate ? 400 : this.open && !hidden ? 2500 : 15000;
      this.pollTimer = setTimeout(() => this.loadFeed().then(() => this.schedulePoll()).catch(() => this.schedulePoll()), delay);
    }

    async loadFeed(initial){
      if (!this.conversationId) return;
      const data = await this.fetchJson(`public/widgets/${encodeURIComponent(this.widgetKey)}/conversations/${encodeURIComponent(this.conversationId)}/feed${this.cursor && !initial ? `?after=${encodeURIComponent(this.cursor)}` : ''}`);
      const fresh = data.messages || [];
      if (initial) this.messages = [];
      let newAgentMessages = 0;
      for (const message of fresh) {
        if (this.messages.some((item) => item.id === message.id)) continue;
        this.messages.push(message);
        if (message.direction === 'outbound' && !initial) newAgentMessages += 1;
      }
      if (data.cursor && data.cursor > (this.cursor || '')) this.cursor = data.cursor;
      const wasClosed = this.conversationClosed;
      const wasLiveStatus = this.conversationLiveStatus;
      const wasHandling = this.conversationHandling;
      const wasTeamPresent = this.conversationTeamPresent;
      this.conversationClosed = data.conversation?.status === 'closed';
      this.conversationLiveStatus = cleanText(data.conversation?.live_status);
      this.conversationHandling = cleanText(data.conversation?.handling);
      this.conversationTeamPresent = data.conversation?.team_present === true;
      this.agentTyping = Boolean(data.conversation?.agent_typing);
      const availabilityChanged = wasLiveStatus !== this.conversationLiveStatus
        || wasHandling !== this.conversationHandling
        || wasTeamPresent !== this.conversationTeamPresent;
      if (availabilityChanged) this.renderHeader();
      if (fresh.length || this.agentTyping !== this.lastAgentTyping || wasClosed !== this.conversationClosed || availabilityChanged) {
        this.lastAgentTyping = this.agentTyping;
        if (this.open) this.renderBody();
      }
      if (newAgentMessages && !this.open) {
        this.unread += newAgentMessages;
        this.updateBadge();
      }
    }

    identify(details){
      this.identity = { ...(this.identity || {}), ...(details || {}) };
      this.preChatDone = true;
      this.persist();
    }

    destroy(){
      this.destroyed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.host?.remove();
    }
  }

  let instance = null;

  const FirstMateChatEmbed = {
    init(options = {}){
      if (instance) instance.destroy();
      instance = new ChatWidget(options);
      const start = () => instance.boot();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
      return instance;
    },
    open(){ instance?.openPanel(); },
    close(){ instance?.closePanel(); },
    identify(details){ instance?.identify(details); },
    destroy(){ instance?.destroy(); instance = null; }
  };
  root.FirstMateChatEmbed = FirstMateChatEmbed;

  const script = currentScript();
  const widgetKey = cleanText(script?.dataset?.widgetKey);
  if (widgetKey && cleanText(script?.dataset?.auto) !== 'false') {
    FirstMateChatEmbed.init({
      widgetKey,
      baseUrl: cleanText(script?.dataset?.baseUrl),
      position: cleanText(script?.dataset?.position),
      portalGrant: cleanText(script?.dataset?.portalGrant)
    });
  }
})();
