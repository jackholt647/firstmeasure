/* Live Chat settings tab: widget appearance + embed snippet, availability,
 * routing, team coordination, and the AI agent configuration. Persists to the
 * `live_chat` branch module through /v1/chat settings endpoints. */
(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const controllers = new WeakMap();

  const DAYS = [
    ['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']
  ];
  const TIMEZONES = ['America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles','America/Anchorage','Pacific/Honolulu'];
  const FONTS = ['Inter','Montserrat','Roboto','Open Sans','Lato','Poppins','Source Sans 3'];

  function injectCss(){
    if (document.getElementById('fmLiveChatSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmLiveChatSettingsCss';
    style.textContent = `
      .lc-root{color:#17212b;min-height:620px}.lc-root *{box-sizing:border-box}
      .lc-loading{display:grid;place-items:center;min-height:420px;color:#667085;font-size:12px;font-weight:850}
      .lc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
      .lc-head-copy h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em;display:flex;align-items:center;gap:11px}
      .lc-head-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:16px;flex:0 0 auto}
      .lc-head-copy p{margin:7px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:560px}
      .lc-master{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding-top:6px}
      .lc-master span{font-size:11px;font-weight:900;color:#475467}
      .lc-switch{position:relative;display:inline-block;width:42px;height:24px;flex:0 0 auto}
      .lc-switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;margin:0;z-index:2}
      .lc-switch .track{position:absolute;inset:0;border-radius:999px;background:#d5dbe3;transition:background .16s ease}
      .lc-switch .track::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.25);transition:transform .16s ease}
      .lc-switch input:checked + .track{background:var(--primary-readable,var(--primary,#d93025))}
      .lc-switch input:checked + .track::after{transform:translateX(18px)}
      .lc-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0}
      .lc-subtabs{display:inline-flex;gap:2px;border:1px solid #e4e7ec;border-radius:12px;background:#f4f6f9;padding:3px;flex-wrap:wrap}
      .lc-subtabs button{appearance:none;border:0;border-radius:9px;background:transparent;padding:9px 16px;color:#667085;font:850 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background .12s,color .12s}
      .lc-subtabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
      .lc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
      .lc-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04);padding:18px;min-width:0}
      .lc-card.wide{grid-column:1/-1}
      .lc-card-head strong{font-size:13.5px;color:#101828;display:flex;align-items:center;gap:8px}
      .lc-card-head strong i{color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
      .lc-card-head p{margin:5px 0 0;color:#667085;font-size:11.5px;line-height:1.5;font-weight:650}
      .lc-field{margin-top:14px;min-width:0}
      .lc-field label{display:block;font-size:10px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;color:#667085;margin-bottom:6px}
      .lc-field input[type=text],.lc-field input[type=time],.lc-field input[type=number],.lc-field textarea,.lc-field select{width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:10px 12px;color:#344054;font:700 12.5px/1.5 inherit;outline:0;resize:vertical}
      .lc-field input:focus,.lc-field textarea:focus,.lc-field select:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .lc-field input[type=color]{width:44px;height:34px;border:1px solid #d0d5dd;border-radius:9px;padding:2px;background:#fff;cursor:pointer}
      .lc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .lc-check{display:flex;align-items:center;gap:9px;margin-top:11px;font-size:12.5px;font-weight:800;color:#344054;cursor:pointer}
      .lc-check input{width:15px;height:15px;accent-color:var(--primary-readable,var(--primary,#d93025))}
      .lc-check small{display:block;font-weight:650;color:#667085}
      .lc-day-row{display:grid;grid-template-columns:110px 22px 1fr 1fr;gap:9px;align-items:center;margin-top:8px;font-size:12px;font-weight:800;color:#344054}
      .lc-day-row input[type=time]{margin:0}
      .lc-day-row.off input[type=time]{opacity:.35;pointer-events:none}
      .lc-snippet{margin-top:12px;background:#101828;color:#a7f3d0;border-radius:10px;padding:12px;font:600 11px/1.6 ui-monospace,monospace;word-break:break-all;position:relative}
      .lc-snippet button{position:absolute;top:8px;right:8px;border:0;border-radius:7px;background:rgba(255,255,255,.12);color:#fff;font:800 10.5px/1 inherit;padding:6px 9px;cursor:pointer}
      .lc-snippet button:hover{background:rgba(255,255,255,.22)}
      .lc-actions{margin-top:18px;display:flex;justify-content:flex-end;gap:10px}
      .lc-btn{border:1px solid #d8dee8;background:#fff;border-radius:9px;cursor:pointer;font:850 12.5px/1 inherit;padding:11px 18px;color:#344054}
      .lc-btn.primary{background:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .lc-btn.primary:hover{filter:brightness(.94)}
      .lc-btn:disabled{opacity:.5;cursor:default}
      .lc-preview{margin-top:14px;border:1px dashed #d0d5dd;border-radius:12px;background:#f8fafc;height:150px;position:relative;overflow:hidden}
      .lc-preview-bubble{position:absolute;bottom:14px;right:14px;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;color:#fff;box-shadow:0 5px 16px rgba(0,0,0,.22)}
      .lc-preview-card{position:absolute;bottom:14px;left:14px;right:74px;max-width:230px;border-radius:12px;padding:11px 13px;font-size:12px;font-weight:700;box-shadow:0 5px 18px rgba(0,0,0,.12)}
      .lc-tools{margin-top:6px}
      .lc-ai-locked{border:1px dashed #d0d5dd;border-radius:12px;background:#f8fafc;padding:22px;text-align:center;color:#667085;font-size:12.5px;font-weight:750;line-height:1.6}
      .lc-pill-group{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
      .lc-pill{border:1px solid #d0d5dd;border-radius:999px;background:#fff;padding:7px 13px;font:800 12px/1 inherit;color:#475467;cursor:pointer}
      .lc-pill.on{background:#172033;border-color:#172033;color:#fff}
      @media(max-width:900px){.lc-grid{grid-template-columns:1fr}.lc-toolbar{align-items:flex-end;flex-direction:column}.lc-subtabs{align-self:stretch}.lc-toolbar .lc-btn{align-self:flex-end}}
    `;
    document.head.appendChild(style);
  }

  function mount(pane, options = {}){
    injectCss();
    const orgId = String(options.orgId || '').trim();
    const branchId = String(options.branchId || 'default').trim() || 'default';
    const showToast = typeof options.showToast === 'function' ? options.showToast : () => {};
    const aiCapability = window.Portal?.appFlags?.has?.('live_chat', 'ai_agent') === true;
    const apiBase = (String(window.__APP?.platformApiBase || '').trim() || `${location.origin}/v1/platform`).replace(/\/platform\/?$/, '/chat');
    const csrf = () => {
      const match = document.cookie.match(/(?:^|;\s*)fm_platform_session_csrf=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    };
    async function api(path, opts = {}){
      const method = String(opts.method || 'GET').toUpperCase();
      const res = await fetch(`${apiBase}${path}`, {
        credentials:'include', cache:'no-store', ...opts,
        headers:{ Accept:'application/json', ...(opts.body ? {'Content-Type':'application/json'} : {}), ...(method !== 'GET' ? {'X-Platform-CSRF':csrf()} : {}), ...(opts.headers || {}) }
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.message || 'Live chat settings request failed.');
      return json;
    }

    const initialTab = ['widget','hours','routing','team','ai'].includes(options.initialView) ? options.initialView : 'widget';
    const state = { settings:null, widgetKey:'', embedSnippet:'', tab:initialTab, saving:false, dirty:false };
    controllers.set(pane, {
      setView(next){
        if (!['widget','hours','routing','team','ai'].includes(next) || state.tab === next) return;
        state.tab = next;
        if (state.settings) render();
      }
    });

    pane.innerHTML = `<div class="lc-root"><div class="lc-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8732f897d045c0"," Loading live chat settings…") ?? " Loading live chat settings…")}</span></div></div>`;

    api(`/organizations/${encodeURIComponent(orgId)}/branch/${encodeURIComponent(branchId)}/chat/settings`)
      .then((data) => {
        state.settings = data.settings || {};
        state.widgetKey = data.widget_key || '';
        state.embedSnippet = data.embed_snippet || '';
        render();
      })
      .catch((error) => {
        pane.innerHTML = `<div class="lc-root"><div class="lc-loading" style="color:#b42318">${esc(error.message)}</div></div>`;
      });

    const get = (path, fallback) => path.split('.').reduce((node, key) => object(node)[key], state.settings) ?? fallback;
    const set = (path, value) => {
      const keys = path.split('.');
      let node = state.settings;
      for (let index = 0; index < keys.length - 1; index += 1) {
        if (!node[keys[index]] || typeof node[keys[index]] !== 'object') node[keys[index]] = {};
        node = node[keys[index]];
      }
      node[keys[keys.length - 1]] = value;
      state.dirty = true;
    };

    function field(label, inner){ return `<div class="lc-field"><label>${esc(label)}</label>${inner}</div>`; }
    function textInput(path, placeholder = ''){ return `<input type="text" data-path="${esc(path)}" value="${esc(get(path, ''))}" placeholder="${esc(placeholder)}">`; }
    function textarea(path, rows = 3, placeholder = ''){ return `<textarea rows="${rows}" data-path="${esc(path)}" placeholder="${esc(placeholder)}">${esc(get(path, ''))}</textarea>`; }
    function colorInput(path){ return `<input type="color" data-path="${esc(path)}" value="${esc(get(path, '#1f6feb'))}">`; }
    function check(path, label, hint = ''){
      return `<label class="lc-check"><input type="checkbox" data-path="${esc(path)}" ${get(path, false) === true ? 'checked' : ''}><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
    }
    function select(path, choices){
      const current = String(get(path, choices[0][0]));
      return `<select data-path="${esc(path)}">${choices.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    }
    function numberInput(path, min, max){ return `<input type="number" min="${min}" max="${max}" data-path="${esc(path)}" data-number="1" value="${esc(get(path, min))}">`; }

    function tabWidget(){
      const primary = get('appearance.primary_color', '#1f6feb');
      const bg = get('appearance.background_color', '#ffffff');
      const text = get('appearance.text_color', '#111827');
      return `<div class="lc-grid">
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-palette"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_510c47b74e1ce3"," Appearance") ?? " Appearance")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_1b24a30a5748fb","The widget inherits these on every page it's embedded on.") ?? "The widget inherits these on every page it's embedded on.")}</p></div>
          <div class="lc-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_f7d9b60d47e781","Colors") ?? "Colors")}</label><div class="lc-row">
            <span style="font-size:11px;font-weight:800;color:#667085">${(globalThis.PlatformLanguage?.htmlText("settings","m_2436076ece8629","Primary") ?? "Primary")}</span>${String(colorInput('appearance.primary_color'))}
            <span style="font-size:11px;font-weight:800;color:#667085">${(globalThis.PlatformLanguage?.htmlText("settings","m_986685f23ed459","Background") ?? "Background")}</span>${String(colorInput('appearance.background_color'))}
            <span style="font-size:11px;font-weight:800;color:#667085">${(globalThis.PlatformLanguage?.htmlText("settings","m_124287f184b88b","Text") ?? "Text")}</span>${String(colorInput('appearance.text_color'))}
          </div></div>
          ${String(field('Font', select('appearance.font_family', FONTS.map((font) => [font, font]))))}
          ${String(field('Corner', select('appearance.position', [['bottom_right','Bottom right'],['bottom_left','Bottom left']])))}
          ${String(field('Launcher label', textInput('appearance.launcher_label', 'Chat with us')))}
          ${String(check('appearance.show_branding', 'Show "Powered by FirstMate"'))}
          <div class="lc-preview">
            <div class="lc-preview-card" style="background:${String(esc(bg))};color:${String(esc(text))}">${String(esc(get('copy.greeting', 'Hi there! How can we help?')))}</div>
            <div class="lc-preview-bubble" style="background:${String(esc(primary))}"><i class="fas fa-comment"></i></div>
          </div>
        </div>
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-message"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_c0d4e384c45c77"," Copy &amp; pre-chat") ?? " Copy &amp; pre-chat")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_c8666ed4e50725","What visitors read before and during the conversation.") ?? "What visitors read before and during the conversation.")}</p></div>
          ${String(field('Greeting', textarea('copy.greeting', 2)))}
          ${String(field('Offline message', textarea('copy.offline_message', 2)))}
          ${String(field('Team name shown to visitors', textInput('copy.team_name', 'Support')))}
          ${String(field('Agent names', select('copy.team_display', [['first_name','Show agent first names'],['team_name','Show the team name only']])))}
          <div class="lc-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_e72ce83fda1b84","Require before chatting") ?? "Require before chatting")}</label>
            ${String(check('pre_chat.require_name', 'Name'))}
            ${String(check('pre_chat.require_email', 'Email'))}
            ${String(check('pre_chat.require_phone', 'Phone'))}
          </div>
          ${String(field('Voice button', select('voice.mode', [
            ['attachment','Attach audio + transcript'],
            ['dictation','Dictation only'],
            ['off','Off']
          ])))}
          ${String(field('Maximum recording length (seconds)', numberInput('voice.max_seconds', 5, 300)))}
        </div>
        <div class="lc-card wide">
          <div class="lc-card-head"><strong><i class="fas fa-code"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_507ce7c4ff8bb9"," Embed on your website") ?? " Embed on your website")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_a2fd188b74e2dc","Paste this snippet before the closing &lt;/body&gt; tag. The same widget can also run inside the customer portal.") ?? "Paste this snippet before the closing &lt;/body&gt; tag. The same widget can also run inside the customer portal.")}</p></div>
          <div class="lc-snippet"><button type="button" data-copy-snippet><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_e7bca94ce54b26"," Copy") ?? " Copy")}</button><code>${String(esc(state.embedSnippet))}</code></div>
          <div class="lc-row" style="margin-top:12px">
            ${String(check('website.enabled', 'Enable on website'))}
            ${String(check('portal.enabled', 'Enable in customer portal'))}
            <button type="button" class="lc-btn" data-rotate-key style="margin-left:auto"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_006a936a55aca3"," Rotate widget key") ?? " Rotate widget key")}</button>
          </div>
        </div>
      </div>`;
    }

    function tabHours(){
      const days = object(get('live_hours.days', {}));
      return `<div class="lc-grid">
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-clock"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_9d478369eddf9c"," Live hours") ?? " Live hours")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_9da1d054baebf6","When your team shows as online. Outside these hours the widget offers the offline flow (or the AI, if enabled).") ?? "When your team shows as online. Outside these hours the widget offers the offline flow (or the AI, if enabled).")}</p></div>
          ${String(field('Timezone', select('live_hours.timezone', TIMEZONES.map((zone) => [zone, zone.replace('America/','').replace('Pacific/','').replace(/_/g,' ')]))))}
          <div class="lc-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_7ad2e218d5f0e3","Weekly schedule") ?? "Weekly schedule")}</label>
            ${String(DAYS.map(([key, label]) => {
              const windows = Array.isArray(days[key]) ? days[key] : [];
              const enabled = windows.length > 0;
              const start = object(windows[0]).start || '08:00';
              const end = object(windows[0]).end || '17:00';
              return `<div class="lc-day-row ${enabled ? '' : 'off'}" data-day="${key}">
                <span>${esc(label)}</span>
                <input type="checkbox" data-day-toggle="${key}" ${enabled ? 'checked' : ''}>
                <input type="time" data-day-start="${key}" value="${esc(start)}">
                <input type="time" data-day-end="${key}" value="${esc(end)}">
              </div>`;
            }).join(''))}
          </div>
        </div>
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-signal"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8d647a5c0d5ad2"," Availability rules") ?? " Availability rules")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_760553d71723dc","Fine-tune when the widget shows as online.") ?? "Fine-tune when the widget shows as online.")}</p></div>
          ${String(check('presence.require_agent_presence', 'Require someone in the Chat inbox', 'Only show as online when a teammate actually has the Chat app open.'))}
          ${String(field('Status override', select('presence.force_status', [['auto','Automatic (hours + presence)'],['online','Force online'],['offline','Force offline']])))}
        </div>
      </div>`;
    }

    function tabRouting(){
      return `<div class="lc-grid">
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-route"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_7e45c1616214e2"," Response timing") ?? " Response timing")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_d889eb4682ff10","Escalate conversations that are waiting too long for a team response.") ?? "Escalate conversations that are waiting too long for a team response.")}</p></div>
          ${String(field('Escalate when unanswered (seconds, 0 = never)', numberInput('notifications.escalate_after_seconds', 0, 3600)))}
          ${String(field('Notification debounce (seconds)', numberInput('notifications.debounce_seconds', 0, 3600)))}
        </div>
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-bell"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_01fa6f796f2f6e"," Who gets notified") ?? " Who gets notified")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_9a1195219fa39e","New chat notifications go to the bell menu, with a click-through into the conversation.") ?? "New chat notifications go to the bell menu, with a click-through into the conversation.")}</p></div>
          ${String(field('Route', select('notifications.route.kind', [['all','Everyone in the organization'],['roles','Specific roles'],['users','Specific users']])))}
          ${String(field('Role ids (comma-separated, for "Specific roles")', textInput('notifications.route.role_ids_text', '')))}
          ${String(field('User ids (comma-separated, for "Specific users")', textInput('notifications.route.user_ids_text', '')))}
        </div>
      </div>`;
    }

    function tabTeam(){
      return `<div class="lc-grid">
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-people-arrows"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_c8a56ae22b062a"," Coordination") ?? " Coordination")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_c42a37c48dce9f","How a busy team shares the inbox without stepping on each other.") ?? "How a busy team shares the inbox without stepping on each other.")}</p></div>
          ${String(field('Mode', select('claiming.mode', [
            ['presence','Presence — anyone can reply; tags show who is viewing'],
            ['claim','Claiming — conversations are owned until released']
          ])))}
          ${String(check('claiming.auto_claim_on_reply', 'Claim automatically on first reply'))}
          ${String(check('claiming.allow_takeover', 'Allow taking over a claimed conversation'))}
          ${String(check('claiming.release_on_disconnect', 'Release claims when the owner logs out or disappears'))}
          ${String(field('Release idle claims after (minutes)', numberInput('claiming.idle_release_minutes', 1, 480)))}
        </div>
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_1ae15170b8c22d"," Visitor privacy") ?? " Visitor privacy")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_03fcd4e423ac01","What visitors can see of their own history.") ?? "What visitors can see of their own history.")}</p></div>
          ${String(check('visitor_history.visible_to_visitor', 'Visitors can see their previous conversations', 'Stored in their browser via a private token — never shared between visitors.'))}
        </div>
      </div>`;
    }

    function tabAi(){
      if (!aiCapability) {
        return `<div class="lc-ai-locked"><i class="fas fa-lock" style="font-size:22px;display:block;margin-bottom:10px"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_36472cd995748a","\n          The Chat AI Agent isn't part of this organization's plan.") ?? "\n          The Chat AI Agent isn't part of this organization's plan.")}<br>${(globalThis.PlatformLanguage?.htmlText("settings","m_ed73a6a6c58f47","Enable the ") ?? "Enable the ")}<b>${(globalThis.PlatformLanguage?.htmlText("settings","m_53f2d44be572d5","Chat AI Agent") ?? "Chat AI Agent")}</b>${(globalThis.PlatformLanguage?.htmlText("settings","m_eb834acc721cc5"," capability under Features &amp; Apps to configure it.") ?? " capability under Features &amp; Apps to configure it.")}</div>`;
      }
      const mode = String(get('mode', 'human'));
      const availability = get('ai.enabled', false) !== true || mode === 'human'
        ? 'never'
        : mode === 'ai_when_offline' ? 'offline' : 'always';
      return `<div class="lc-grid">
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-robot"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2386b2699296da"," AI agent availability") ?? " AI agent availability")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_c41de9caad3083","Choose exactly when the AI may answer visitors. Team members can always take over an active AI conversation.") ?? "Choose exactly when the AI may answer visitors. Team members can always take over an active AI conversation.")}</p></div>
          <div class="lc-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_909bb221978259","When should the AI answer?") ?? "When should the AI answer?")}</label>
            <div class="lc-pill-group" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_33f48b42d3e576","AI agent availability") ?? "AI agent availability")}">
              ${String([
                ['never','Never','fa-ban'],
                ['offline','Only when the team is offline','fa-moon'],
                ['always','Always','fa-bolt']
              ].map(([value, label, icon]) => `<button type="button" class="lc-pill ${availability === value ? 'on' : ''}" data-ai-availability="${value}" aria-pressed="${availability === value ? 'true' : 'false'}"><i class="fas ${icon}"></i> ${label}</button>`).join(''))}
            </div>
          </div>
          ${String(check('ai.disclose', 'Disclose that it is an AI in the greeting'))}
          ${String(field('Tone', select('ai.tone.preset', [['friendly','Friendly'],['professional','Professional'],['concise','Concise'],['custom','Custom (describe below)']])))}
          ${String(field('Custom tone (used when Tone is Custom)', textarea('ai.tone.custom', 2)))}
          ${String(field('Instructions', textarea('ai.instructions', 4, 'e.g. Always offer a free estimate. Never quote prices for commercial work.')))}
          ${String(field('Business knowledge', textarea('ai.knowledge', 6, 'Services, service area, typical pricing posture, FAQs — everything the AI may share with visitors.')))}
        </div>
        <div class="lc-card">
          <div class="lc-card-head"><strong><i class="fas fa-toolbox"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_add53758f76ae8"," What the AI can do") ?? " What the AI can do")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_24960ac94d8565","Each tool is off unless enabled here. Customer lookup additionally requires a verified (portal) visitor.") ?? "Each tool is off unless enabled here. Customer lookup additionally requires a verified (portal) visitor.")}</p></div>
          <div class="lc-tools">
            ${String(check('ai.tools.get_business_info', 'Answer from business knowledge'))}
            ${String(check('ai.tools.capture_contact', 'Capture visitor contact details'))}
            ${String(check('ai.tools.create_lead', 'Create CRM leads from captured contacts'))}
            ${String(check('ai.tools.lookup_customer', 'Look up verified customers in the CRM', 'Locked for anonymous website visitors regardless of this setting.'))}
          </div>
          <div class="lc-card-head" style="margin-top:18px"><strong><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8709f57990b16e"," Suggested replies") ?? " Suggested replies")}</strong></div>
          ${String(check('ai.suggestions.enabled', 'Suggest replies in the team inbox'))}
          ${String(check('ai.suggestions.allow_one_click_send', 'Allow sending suggestions without editing'))}
        </div>
      </div>`;
    }

    function render(){
      const rootEl = document.createElement('div');
      rootEl.className = 'lc-root';
      const routeRoles = (get('notifications.route.role_ids', []) || []).join(', ');
      const routeUsers = (get('notifications.route.user_ids', []) || []).join(', ');
      set('notifications.route.role_ids_text', routeRoles); state.dirty = false;
      set('notifications.route.user_ids_text', routeUsers); state.dirty = false;
      rootEl.innerHTML = `
        <div class="lc-head">
          <div class="lc-head-copy">
            <h3><span class="lc-head-icon"><i class="fas fa-comments"></i></span>${(globalThis.PlatformLanguage?.htmlText("settings","m_630e2c7d737dfd"," Live Chat") ?? " Live Chat")}</h3>
            <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_4c3e168c818474","An embeddable chat widget for your website and customer portal, a team inbox in the left column, and an optional AI agent.") ?? "An embeddable chat widget for your website and customer portal, a team inbox in the left column, and an optional AI agent.")}</p>
          </div>
          <div class="lc-master"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_d734af06e82e9d","Live chat") ?? "Live chat")}</span><label class="lc-switch"><input type="checkbox" data-path="enabled" ${String(get('enabled', false) === true ? 'checked' : '')}><span class="track"></span></label></div>
        </div>
        <div class="lc-toolbar">
          <div class="lc-subtabs">
            ${String([['widget','fa-puzzle-piece','Widget'],['hours','fa-clock','Availability'],['routing','fa-bell','Routing'],['team','fa-people-arrows','Team'],['ai','fa-robot','AI Agent']].map(([id, icon, label]) => `
              <button type="button" data-subtab="${id}" class="${state.tab === id ? 'on' : ''}"><i class="fas ${icon}"></i> ${label}</button>`).join(''))}
          </div>
          <button type="button" class="lc-btn primary" data-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_cd64ad413e1d8a"," Save live chat settings") ?? " Save live chat settings")}</button>
        </div>
        <div class="lc-body">${String(state.tab === 'widget' ? tabWidget() : state.tab === 'hours' ? tabHours() : state.tab === 'routing' ? tabRouting() : state.tab === 'team' ? tabTeam() : tabAi())}</div>
        <div class="lc-actions"><button type="button" class="lc-btn primary" data-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_cd64ad413e1d8a"," Save live chat settings") ?? " Save live chat settings")}</button></div>
      `;
      pane.innerHTML = '';
      pane.appendChild(rootEl);
      wire(rootEl);
    }

    function wire(rootEl){
      rootEl.querySelectorAll('[data-subtab]').forEach((button) => button.addEventListener('click', () => {
        collect(rootEl);
        state.tab = button.dataset.subtab;
        options.onViewChange?.(state.tab);
        render();
      }));
      rootEl.querySelectorAll('[data-ai-availability]').forEach((button) => button.addEventListener('click', () => {
        collect(rootEl);
        const availability = button.dataset.aiAvailability;
        set('ai.enabled', availability !== 'never');
        set('mode', availability === 'offline' ? 'ai_when_offline' : availability === 'always' ? 'ai' : 'human');
        render();
      }));
      rootEl.querySelectorAll('[data-path]').forEach((input) => {
        input.addEventListener('change', () => {
          if (input.type === 'checkbox') set(input.dataset.path, input.checked);
          else if (input.dataset.number) set(input.dataset.path, Number(input.value) || 0);
          else set(input.dataset.path, input.value);
          if (input.dataset.path.startsWith('appearance.') || input.dataset.path === 'copy.greeting') { collect(rootEl); render(); }
        });
      });
      rootEl.querySelectorAll('[data-day-toggle]').forEach((toggle) => toggle.addEventListener('change', () => {
        toggle.closest('.lc-day-row').classList.toggle('off', !toggle.checked);
        state.dirty = true;
      }));
      rootEl.querySelector('[data-copy-snippet]')?.addEventListener('click', (event) => {
        navigator.clipboard?.writeText(state.embedSnippet).then(() => {
          event.target.closest('button').innerHTML = '<i class="fas fa-check"></i> Copied';
          setTimeout(() => { const btn = rootEl.querySelector('[data-copy-snippet]'); if (btn) btn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1400);
        });
      });
      rootEl.querySelector('[data-rotate-key]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (!window.confirm((globalThis.PlatformLanguage?.text("settings","m_3e4d8956366833","Rotate the widget key? The old embed snippet stops working immediately.") ?? "Rotate the widget key? The old embed snippet stops working immediately."))) return;
        button.disabled = true;
        try {
          const data = await api(`/organizations/${encodeURIComponent(orgId)}/branch/${encodeURIComponent(branchId)}/chat/settings/rotate-key`, { method:'POST', body:'{}' });
          state.widgetKey = data.widget_key || state.widgetKey;
          state.embedSnippet = data.embed_snippet || state.embedSnippet;
          collect(rootEl);
          render();
          showToast((globalThis.PlatformLanguage?.text("settings","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), (globalThis.PlatformLanguage?.text("settings","m_1028e18fba76e8","Widget key rotated. Update the embed snippet on your website.") ?? "Widget key rotated. Update the embed snippet on your website."), true);
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("settings","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), error.message, false);
          button.disabled = false;
        }
      });
      rootEl.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', async () => {
        collect(rootEl);
        const route = object(object(state.settings.notifications).route);
        route.role_ids = String(route.role_ids_text || '').split(',').map((value) => value.trim()).filter(Boolean);
        route.user_ids = String(route.user_ids_text || '').split(',').map((value) => value.trim()).filter(Boolean);
        delete route.role_ids_text; delete route.user_ids_text;
        rootEl.querySelectorAll('[data-save]').forEach((saveButton) => {
          saveButton.disabled = true;
          saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
        });
        try {
          const data = await api(`/organizations/${encodeURIComponent(orgId)}/branch/${encodeURIComponent(branchId)}/chat/settings`, {
            method:'PUT', body: JSON.stringify({ data: state.settings })
          });
          state.settings = data.settings || state.settings;
          state.widgetKey = data.widget_key || state.widgetKey;
          state.embedSnippet = data.embed_snippet || state.embedSnippet;
          state.dirty = false;
          render();
          showToast((globalThis.PlatformLanguage?.text("settings","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), (globalThis.PlatformLanguage?.text("settings","m_4c73b46df33b36","Settings saved.") ?? "Settings saved."), true);
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("settings","m_1405ecd3fe696b","Live Chat") ?? "Live Chat"), error.message, false);
          rootEl.querySelectorAll('[data-save]').forEach((saveButton) => {
            saveButton.disabled = false;
            saveButton.innerHTML = '<i class="fas fa-check"></i> Save live chat settings';
          });
        }
      }));
    }

    function collect(rootEl){
      rootEl.querySelectorAll('[data-path]').forEach((input) => {
        if (input.type === 'checkbox') set(input.dataset.path, input.checked);
        else if (input.dataset.number) set(input.dataset.path, Number(input.value) || 0);
        else set(input.dataset.path, input.value);
      });
      const days = {};
      DAYS.forEach(([key]) => {
        const toggle = rootEl.querySelector(`[data-day-toggle="${key}"]`);
        if (!toggle) return;
        days[key] = toggle.checked
          ? [{ start: rootEl.querySelector(`[data-day-start="${key}"]`)?.value || '08:00', end: rootEl.querySelector(`[data-day-end="${key}"]`)?.value || '17:00' }]
          : [];
      });
      if (Object.keys(days).length) set('live_hours.days', { ...object(get('live_hours.days', {})), ...days });
    }
  }

  root.FirstMateLiveChatSettings = { mount, setView:(pane, view) => controllers.get(pane)?.setView(view) };
})(window);
