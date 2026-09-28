/* Company Settings → Communications: branch defaults and reusable customer
 * message templates. Per-project overrides remain in each project's Comms tab.
 */
(function(){
  'use strict';

  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const controllers = new WeakMap();
  const ROLES = [
    { id:'office', label:(globalThis.PlatformLanguage?.text("settings","m_aa20efe27f3230","Office") ?? "Office") },
    { id:'sales', label:(globalThis.PlatformLanguage?.text("settings","m_2680c31facb03d","Sales") ?? "Sales") },
    { id:'operations', label:(globalThis.PlatformLanguage?.text("settings","m_33dfb8f7cb012a","Operations") ?? "Operations") },
    { id:'crew', label:(globalThis.PlatformLanguage?.text("settings","m_5b8ee9e9110e54","Crew") ?? "Crew") }
  ];

  function css(){
    if (document.getElementById('fmco-settings-css')) return;
    const style = document.createElement('style');
    style.id = 'fmco-settings-css';
    style.textContent = `
      .fmcos{padding:20px;width:100%;box-sizing:border-box;display:grid;gap:16px;color:#172033}
      .fmcos [hidden]{display:none!important}
      .fmcos-tabs{display:flex;align-items:center;gap:5px;border-bottom:1px solid #e4e7ec}
      .fmcos-tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 14px;font:inherit;font-size:12px;font-weight:900;color:#667085;cursor:pointer}
      .fmcos-tab.active{color:var(--primary-readable,var(--primary,#d93025));border-bottom-color:currentColor}
      .fmcos-grid{display:grid;grid-template-columns:repeat(3,minmax(280px,1fr));gap:14px;align-items:start}
      .fmcos-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px 18px;display:grid;gap:12px;min-width:0}
      .fmcos-card.wide{grid-column:span 2}.fmcos-title{font-size:13px;font-weight:900;color:#101828;display:flex;align-items:center;gap:9px;margin:0}
      .fmcos-title i{color:var(--primary-readable,var(--primary,#d93025))}.fmcos-sub{font-size:12px;color:#667085;font-weight:600;line-height:1.5;margin:-6px 0 0}
      .fmcos-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.fmcos-label{font-size:12.5px;font-weight:800;color:#344054}
      .fmcos-hint{font-size:11px;color:#98a2b3;font-weight:600;margin-top:2px;line-height:1.45}
      .fmcos input[type=text],.fmcos input[type=email],.fmcos textarea,.fmcos select{box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:8px 11px;font:inherit;font-size:12.5px;outline:none;width:100%;background:#fff;color:#172033}
      .fmcos textarea{min-height:96px;resize:vertical}.fmcos input:focus,.fmcos textarea:focus,.fmcos select:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217 48 37),.08)}
      .fmcos-chips{display:flex;gap:6px;flex-wrap:wrap}.fmcos-chip{border:1px solid #d8dee8;background:#fff;border-radius:999px;padding:5px 11px;font:inherit;font-size:11px;font-weight:800;color:#475467;cursor:pointer}
      .fmcos-chip.on{background:rgba(var(--primary-rgb,217 48 37),.08);border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}
      .fmcos-toggle{position:relative;width:40px;height:22px;flex:0 0 auto;cursor:pointer}.fmcos-toggle input{position:absolute;opacity:0;inset:0;cursor:pointer}
      .fmcos-toggle i{position:absolute;inset:0;border-radius:999px;background:#e4e7ec;transition:background .15s}.fmcos-toggle i:before{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(16,24,40,.2)}
      .fmcos-toggle input:checked + i{background:var(--primary-readable,var(--primary,#d93025))}.fmcos-toggle input:checked + i:before{left:21px}
      .fmcos-save,.fmcos-btn{border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:9px;padding:9px 14px;font:inherit;font-size:12px;font-weight:900;cursor:pointer}
      .fmcos-save{justify-self:end;background:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025));color:#fff}.fmcos-save:disabled,.fmcos-btn:disabled{opacity:.55;cursor:default}
      .fmcos-btn.danger{color:#b42318;border-color:#fecdca}.fmcos-inbox{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:#344054;background:#f8fafc;border:1px dashed #d0d5dd;border-radius:9px;padding:8px 12px;overflow-wrap:anywhere}
      .fmcos-template-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.fmcos-template-head h3{margin:0;font-size:16px}.fmcos-template-head p{margin:5px 0 0;color:#667085;font-size:12px}
      .fmcos-template-workspace{display:grid;grid-template-columns:300px minmax(420px,1fr);gap:14px;min-height:520px}.fmcos-template-list{background:#fff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;min-height:0}
      .fmcos-template-filter{padding:12px;border-bottom:1px solid #e4e7ec}.fmcos-template-items{display:grid;gap:3px;padding:7px;overflow:auto}
      .fmcos-template-item{border:1px solid transparent;background:transparent;border-radius:9px;padding:10px;text-align:left;display:grid;gap:4px;cursor:pointer;color:#344054}
      .fmcos-template-item:hover{background:#f8fafc}.fmcos-template-item.active{border-color:rgba(var(--primary-rgb,217 48 37),.3);background:rgba(var(--primary-rgb,217 48 37),.055)}
      .fmcos-template-item strong{font-size:12px}.fmcos-template-meta{display:flex;gap:6px;align-items:center;color:#667085;font-size:10px;font-weight:800}.fmcos-template-meta span{padding:2px 5px;border-radius:999px;background:#f2f4f7}
      .fmcos-template-editor{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:18px;display:grid;gap:14px;align-content:start}.fmcos-template-fields{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}.fmcos-field{display:grid;gap:5px}
      .fmcos-template-editor textarea{min-height:150px;line-height:1.55}.fmcos-variable-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.fmcos-variable-bar>span{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .fmcos-preview{background:#f8fafc;border:1px solid #e4e7ec;border-radius:11px;padding:14px;display:grid;gap:7px}.fmcos-preview-label{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .fmcos-preview-bubble{justify-self:start;max-width:min(560px,90%);border-radius:14px 14px 14px 4px;background:#e9eef6;color:#172033;padding:10px 13px;font-size:12.5px;line-height:1.5;white-space:pre-wrap}
      .fmcos-template-actions{display:flex;justify-content:space-between;gap:8px}.fmcos-template-actions>div{display:flex;gap:8px}
      .fmcos-empty{padding:30px;text-align:center;color:#98a2b3;font-size:12px;font-weight:750}
      @media(max-width:1180px){.fmcos-grid{grid-template-columns:repeat(2,minmax(280px,1fr))}}@media(max-width:820px){.fmcos{padding:14px}.fmcos-grid{grid-template-columns:1fr}.fmcos-card.wide{grid-column:auto}.fmcos-template-workspace{grid-template-columns:1fr}.fmcos-template-list{max-height:250px}.fmcos-template-fields{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function toggle(name, checked){
    return `<label class="fmcos-toggle"><input type="checkbox" data-co-set="${name}" ${checked ? 'checked' : ''}><i></i></label>`;
  }

  function shell(view){
    return `<div class="fmcos"><nav class="fmcos-tabs" aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_d2ffc030cab2fb","Communications settings sections") ?? "Communications settings sections")}">
      <button class="fmcos-tab ${String(view === 'general' ? 'active' : '')}" data-co-view="general"><i class="fa-solid fa-sliders"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_a8b3e178ada9e1"," General") ?? " General")}</button>
      <button class="fmcos-tab ${String(view === 'templates' ? 'active' : '')}" data-co-view="templates"><i class="fa-solid fa-message"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_d708ded93ed154"," Message templates") ?? " Message templates")}</button>
    </nav><div data-co-content></div></div>`;
  }

  async function mount(el, options = {}){
    css();
    const orgId = clean(options.orgId);
    const api = window.CommsAPI;
    if (!api || !orgId) {
      el.innerHTML = `<div style="padding:24px;color:#b42318;font-weight:850">${(globalThis.PlatformLanguage?.htmlText("settings","m_7ece649be9adf9","Communications settings failed to load.") ?? "Communications settings failed to load.")}</div>`;
      return;
    }
    const controller = {
      el, options, api, orgId, settings:null, inboxAddress:'', templates:null,
      view:clean(options.initialView) === 'templates' ? 'templates' : 'general',
      selectedId:'', draft:null
    };
    controllers.set(el, controller);
    el.innerHTML = shell(controller.view);
    bindTabs(controller);
    await renderView(controller);
  }

  function bindTabs(controller){
    controller.el.querySelectorAll('[data-co-view]').forEach((button) => button.addEventListener('click', () => {
      const view = button.dataset.coView;
      if (view === controller.view) return;
      controller.view = view;
      controller.options.onViewChange?.(view);
      renderView(controller);
    }));
  }

  function refreshTabs(controller){
    controller.el.querySelectorAll('[data-co-view]').forEach((button) => button.classList.toggle('active', button.dataset.coView === controller.view));
  }

  async function loadGeneral(controller){
    if (controller.settings) return;
    const result = await controller.api.settings.load(controller.orgId);
    controller.settings = object(result.settings);
    try {
      const base = controller.api.baseUrl().replace(/\/v1\/comms\/?$/i, '/v1/email');
      const response = await fetch(`${base}/organizations/${encodeURIComponent(controller.orgId)}/inbox`, { credentials:'include' });
      const data = await response.json();
      if (data?.ok) controller.inboxAddress = clean(object(data.inbox).address);
    } catch (_) {}
  }

  async function renderView(controller){
    refreshTabs(controller);
    const content = controller.el.querySelector('[data-co-content]');
    content.innerHTML = `<div class="cs-note" style="padding:18px;">${(globalThis.PlatformLanguage?.htmlText("settings","m_41963dee42009b","Loading communications settings…") ?? "Loading communications settings…")}</div>`;
    try {
      if (controller.view === 'templates') {
        if (!controller.templates) {
          const result = await controller.api.templates.list(controller.orgId);
          controller.templates = Array.isArray(result.templates) ? result.templates : [];
          controller.selectedId = controller.selectedId || clean(controller.templates[0]?.id);
        }
        renderTemplates(controller);
      } else {
        await loadGeneral(controller);
        renderGeneral(controller);
      }
    } catch (error) {
      content.innerHTML = `<div style="padding:24px;color:#b42318;font-weight:850">${esc(error?.message || 'Could not load communications settings.')}</div>`;
    }
  }

  function renderGeneral(controller){
    const settings = object(controller.settings);
    const notifications = object(settings.notifications);
    const voice = object(settings.voice);
    const forwarding = object(settings.email_forwarding);
    const agent = object(settings.agent);
    const autoResponse = object(agent.auto_response);
    const channels = object(autoResponse.channels);
    const roleSelection = new Set(Array.isArray(notifications.target_role_ids) ? notifications.target_role_ids : ['office']);
    const content = controller.el.querySelector('[data-co-content]');
    content.innerHTML = `<div class="fmcos-grid">
      <section class="fmcos-card"><p class="fmcos-title"><i class="fa-solid fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_3a7245a5ee6cd0","Company inbox") ?? "Company inbox")}</p>
        ${String(controller.inboxAddress ? `<div class="fmcos-inbox"><i class="fa-solid fa-at"></i>${esc(controller.inboxAddress)}</div><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_da83a9a54ee065","Customer replies land on the matching project automatically.") ?? "Customer replies land on the matching project automatically.")}</p>` : `<p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_56d30ef96f433f","The company inbox is provisioned the first time email is used.") ?? "The company inbox is provisioned the first time email is used.")}</p>`)}</section>
      <section class="fmcos-card"><p class="fmcos-title"><i class="fa-solid fa-bell"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_23fbb6d4f23d62","Inbound notifications") ?? "Inbound notifications")}</p><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_8eba04bd967401","Choose who is notified when a customer emails or texts in.") ?? "Choose who is notified when a customer emails or texts in.")}</p>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_dfc39bd0cac3f5","Notify the team") ?? "Notify the team")}</span>${String(toggle('notify_enabled', notifications.enabled !== false))}</div>
        <div class="fmcos-chips">${String(ROLES.map((role) => `<button type="button" class="fmcos-chip${roleSelection.has(role.id) ? ' on' : ''}" data-co-role="${role.id}">${esc(role.label)}</button>`).join(''))}</div></section>
      <section class="fmcos-card"><p class="fmcos-title"><i class="fa-solid fa-share-from-square"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_6b7a5ab17b95c9","Unmatched email") ?? "Unmatched email")}</p><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_12b5abb0bd300a","Forward messages that have no usable project target.") ?? "Forward messages that have no usable project target.")}</p>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_4028fc8e76bfe1","Enable forwarding") ?? "Enable forwarding")}</span>${String(toggle('forwarding_enabled', forwarding.enabled === true))}</div>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_bc01ab81360626","Fallback email") ?? "Fallback email")}</span><input type="email" data-co-text="forwarding_email" value="${String(esc(clean(forwarding.fallback_email)))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_770640beb7d631","inbox@example.com") ?? "inbox@example.com")}"></div></section>
      <section class="fmcos-card"><p class="fmcos-title"><i class="fa-solid fa-microphone-lines"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_048a7361aa1b5d","Voice messages") ?? "Voice messages")}</p><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_01253a5e3076f3","Choose how recorded notes are delivered by channel.") ?? "Choose how recorded notes are delivered by channel.")}</p>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_7a2ee5bebd134a","Text messages") ?? "Text messages")}</span><select data-co-text="voice_sms"><option value="attachment" ${String(clean(voice.sms) !== 'dictation' && clean(voice.sms) !== 'off' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_fc578eefcdfca0","Audio + transcript (MMS)") ?? "Audio + transcript (MMS)")}</option><option value="dictation" ${String(clean(voice.sms) === 'dictation' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_c2373e9f83affc","Dictation only") ?? "Dictation only")}</option><option value="off" ${String(clean(voice.sms) === 'off' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_273e689aeb0785","Off") ?? "Off")}</option></select></div>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</span><select data-co-text="voice_email"><option value="dictation" ${String(clean(voice.email) !== 'off' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_c2373e9f83affc","Dictation only") ?? "Dictation only")}</option><option value="off" ${String(clean(voice.email) === 'off' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_273e689aeb0785","Off") ?? "Off")}</option></select></div></section>
      <section class="fmcos-card wide"><p class="fmcos-title"><i class="fa-solid fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_4c8e66d639bed7","Comms AI agent") ?? "Comms AI agent")}</p><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_9231e287f19194","Company-wide behavior across email, texts, and portal chat.") ?? "Company-wide behavior across email, texts, and portal chat.")}</p>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_044994db3c4b47","Enable the comms agent") ?? "Enable the comms agent")}</span>${String(toggle('agent_enabled', agent.enabled !== false))}</div>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_85ff81dc918529","Agent name") ?? "Agent name")}</span><input type="text" data-co-text="agent_name" value="${String(esc(clean(agent.agent_name) || 'Comms Agent'))}" maxlength="80"></div>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_04016b6467ee76","Global instructions") ?? "Global instructions")}</span><textarea data-co-text="custom_instructions" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_2d8ec1abaee245","Tone, policies, and promises to avoid.") ?? "Tone, policies, and promises to avoid.")}">${String(esc(String(agent.custom_instructions ?? '')))}</textarea></div>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_fcbd394b0a74de","Allowed to send messages") ?? "Allowed to send messages")}</span>${String(toggle('allow_send', agent.allow_send !== false))}</div>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_b707adca6df34d","Allowed to create appointments") ?? "Allowed to create appointments")}</span>${String(toggle('allow_scheduling', agent.allow_scheduling !== false))}</div>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_f7fbbb14ff6fd8","Allowed to read available times") ?? "Allowed to read available times")}</span>${String(toggle('allow_availability_read', agent.allow_availability_read === true))}</div>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_f5b101a8a73792","Allowed to commit customer reschedules") ?? "Allowed to commit customer reschedules")}</span>${String(toggle('allow_rescheduling', agent.allow_rescheduling === true))}</div></section>
      <section class="fmcos-card"><p class="fmcos-title"><i class="fa-solid fa-reply"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_27309f9c4210cc","AI auto-response") ?? "AI auto-response")}</p><p class="fmcos-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_e4e2a3aa8b5ed8","Draft replies for review or send automatically.") ?? "Draft replies for review or send automatically.")}</p>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_1b7f88942c0182","Auto-respond") ?? "Auto-respond")}</span>${String(toggle('auto_enabled', autoResponse.enabled === true))}</div>
        <div><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_669e1e42b35fa1","Mode") ?? "Mode")}</span><select data-co-text="auto_mode"><option value="draft" ${String(clean(autoResponse.mode) !== 'send' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_a26f603c848435","Draft for review") ?? "Draft for review")}</option><option value="send" ${String(clean(autoResponse.mode) === 'send' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_d8eaf5654c6968","Send automatically") ?? "Send automatically")}</option></select></div>
        <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_193abbb507fbd0","Respond to email") ?? "Respond to email")}</span>${String(toggle('auto_email', channels.email !== false))}</div><div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_fab27481d54e6f","Respond to texts") ?? "Respond to texts")}</span>${String(toggle('auto_sms', channels.sms !== false))}</div></section>
    </div><button type="button" class="fmcos-save" data-co-save>${(globalThis.PlatformLanguage?.htmlText("settings","m_89abc4aa7105b9","Save communications settings") ?? "Save communications settings")}</button>`;
    content.querySelectorAll('[data-co-role]').forEach((chip) => chip.addEventListener('click', () => {
      const role = chip.dataset.coRole;
      if (roleSelection.has(role)) roleSelection.delete(role); else roleSelection.add(role);
      chip.classList.toggle('on', roleSelection.has(role));
    }));
    content.querySelector('[data-co-save]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const checked = (name) => content.querySelector(`[data-co-set="${name}"]`)?.checked === true;
      const text = (name) => clean(content.querySelector(`[data-co-text="${name}"]`)?.value);
      button.disabled = true;
      try {
        const result = await controller.api.settings.save(controller.orgId, {
          notifications:{ enabled:checked('notify_enabled'), target_role_ids:[...roleSelection] },
          voice:{ sms:text('voice_sms') || 'attachment', email:text('voice_email') || 'dictation' },
          email_forwarding:{ enabled:checked('forwarding_enabled'), fallback_email:text('forwarding_email') },
          agent:{ enabled:checked('agent_enabled'), agent_name:text('agent_name'), custom_instructions:content.querySelector('[data-co-text="custom_instructions"]')?.value ?? '', allow_send:checked('allow_send'), allow_scheduling:checked('allow_scheduling'), allow_availability_read:checked('allow_availability_read'), allow_rescheduling:checked('allow_rescheduling'), auto_response:{ enabled:checked('auto_enabled'), mode:text('auto_mode') === 'send' ? 'send' : 'draft', channels:{ email:checked('auto_email'), sms:checked('auto_sms') } } }
        });
        controller.settings = object(result.settings);
        controller.options.showToast?.((globalThis.PlatformLanguage?.text("settings","m_061c2764fba8e1","Communications settings saved") ?? "Communications settings saved"));
      } catch (error) { controller.options.showToast?.(error?.message || 'Could not save communications settings', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error")); }
      button.disabled = false;
    });
  }

  function newTemplate(){
    return { id:'', name:'New text template', channel:'sms', category:'Calls', subject:'', body:'Hi {{first_name}}, ', variables:['first_name'], active:true };
  }

  function renderTemplates(controller){
    const templates = controller.templates || [];
    let selected = templates.find((item) => clean(item.id) === controller.selectedId);
    if (controller.draft && (!selected || clean(controller.draft.id) === clean(selected.id))) selected = controller.draft;
    if (!selected && templates.length) { selected = templates[0]; controller.selectedId = clean(selected.id); }
    const content = controller.el.querySelector('[data-co-content]');
    content.innerHTML = `<div class="fmcos-template-head"><div><h3>${(globalThis.PlatformLanguage?.htmlText("settings","m_3cc8ac595c76f1","Message templates") ?? "Message templates")}</h3><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_8d85ab7a35841d","Create reusable SMS and email drafts. Variables resolve when a teammate selects a template.") ?? "Create reusable SMS and email drafts. Variables resolve when a teammate selects a template.")}</p></div><button class="fmcos-btn" data-template-new><i class="fa-solid fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_fc61a22aa7a62e"," New template") ?? " New template")}</button></div>
      <div class="fmcos-template-workspace">
        <aside class="fmcos-template-list"><div class="fmcos-template-filter"><select data-template-filter><option value="">${(globalThis.PlatformLanguage?.htmlText("settings","m_90d8f15c2db3ca","All channels") ?? "All channels")}</option><option value="sms">${(globalThis.PlatformLanguage?.htmlText("settings","m_e1dd22c36fbc9b","SMS") ?? "SMS")}</option><option value="email">${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</option></select></div><div class="fmcos-template-items" data-template-items></div></aside>
        <section class="fmcos-template-editor" data-template-editor></section>
      </div>`;
    const filter = content.querySelector('[data-template-filter]');
    const drawList = () => {
      const visible = templates.filter((item) => !filter.value || clean(item.channel) === filter.value);
      content.querySelector('[data-template-items]').innerHTML = visible.length ? visible.map((item) => `<button class="fmcos-template-item ${clean(item.id) === controller.selectedId ? 'active' : ''}" data-template-id="${esc(clean(item.id))}"><strong>${esc(item.name)}</strong><div class="fmcos-template-meta"><span>${esc(clean(item.channel).toUpperCase())}</span>${item.category ? `<span>${esc(item.category)}</span>` : ''}${item.active === false ? `<span>${(globalThis.PlatformLanguage?.htmlText("settings","m_425a653d4590da","Inactive") ?? "Inactive")}</span>` : ''}</div></button>`).join('') : `<div class="fmcos-empty">${(globalThis.PlatformLanguage?.htmlText("settings","m_c9475097bcee66","No templates in this channel.") ?? "No templates in this channel.")}</div>`;
      content.querySelectorAll('[data-template-id]').forEach((button) => button.addEventListener('click', () => {
        controller.selectedId = button.dataset.templateId;
        controller.draft = null;
        renderTemplates(controller);
      }));
    };
    filter.addEventListener('change', drawList);
    drawList();
    content.querySelector('[data-template-new]').addEventListener('click', () => {
      controller.selectedId = '';
      controller.draft = newTemplate();
      renderTemplates(controller);
    });
    drawTemplateEditor(controller, selected || controller.draft);
  }

  function drawTemplateEditor(controller, template){
    const editor = controller.el.querySelector('[data-template-editor]');
    if (!template) {
      editor.innerHTML = `<div class="fmcos-empty"><i class="fa-regular fa-message" style="font-size:28px"></i><br>${(globalThis.PlatformLanguage?.htmlText("settings","m_0bce23feafbaf5","Select a template or create a new one.") ?? "Select a template or create a new one.")}</div>`;
      return;
    }
    const renderer = window.FirstMateMessageTemplates;
    const variables = renderer?.variableCatalog || [];
    editor.innerHTML = `<div class="fmcos-template-fields">
      <label class="fmcos-field"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_c4b7cbfdc9b700","Template name") ?? "Template name")}</span><input type="text" data-template-name value="${String(esc(template.name))}" maxlength="120"></label>
      <label class="fmcos-field"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_ed28d6fb9ea58c","Channel") ?? "Channel")}</span><select data-template-channel><option value="sms" ${String(template.channel === 'sms' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_e1dd22c36fbc9b","SMS") ?? "SMS")}</option><option value="email" ${String(template.channel === 'email' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</option></select></label>
      <label class="fmcos-field"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_c478c1907a4d4f","Category") ?? "Category")}</span><input type="text" data-template-category value="${String(esc(template.category || ''))}" maxlength="80"></label>
    </div>
    <label class="fmcos-field" data-template-subject-wrap ${String(template.channel === 'email' ? '' : 'hidden')}><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_eb218e4bd1f2dd","Email subject") ?? "Email subject")}</span><input type="text" data-template-subject value="${String(esc(template.subject || ''))}" maxlength="998"></label>
    <label class="fmcos-field"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_a16cfd85cfd122","Message") ?? "Message")}</span><textarea data-template-body maxlength="100000">${String(esc(template.body))}</textarea></label>
    <div class="fmcos-variable-bar"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_55e76df1f0d41a","Insert variable") ?? "Insert variable")}</span>${String(variables.map((item) => `<button class="fmcos-chip" type="button" data-template-variable="${esc(item.key)}" title="${esc(item.example || '')}">{{${esc(item.key)}}}</button>`).join(''))}</div>
    <div class="fmcos-preview"><span class="fmcos-preview-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_4cde618f7445e1","Example preview") ?? "Example preview")}</span><div class="fmcos-preview-bubble" data-template-preview></div><div class="fmcos-hint" data-template-missing></div></div>
    <div class="fmcos-row"><span class="fmcos-label">${(globalThis.PlatformLanguage?.htmlText("settings","m_9f4aefdd323d29","Available to teammates") ?? "Available to teammates")}</span>${String(toggle('template_active', template.active !== false))}</div>
    <div class="fmcos-template-actions"><div>${String(template.id ? `<button class="fmcos-btn danger" data-template-delete>${(globalThis.PlatformLanguage?.htmlText("settings","m_4fc60207629a44","Delete") ?? "Delete")}</button>` : '')}</div><div><button class="fmcos-save" data-template-save>${String(template.id ? 'Save template' : 'Create template')}</button></div></div>`;
    const body = editor.querySelector('[data-template-body]');
    const updatePreview = () => {
      const examples = Object.fromEntries(variables.map((item) => [item.key, item.example]));
      const result = renderer?.render?.(body.value, examples) || { text:body.value, missing:[] };
      editor.querySelector('[data-template-preview]').textContent = result.text || 'Your preview will appear here.';
      editor.querySelector('[data-template-missing]').textContent = result.missing?.length ? `No example is defined for: ${result.missing.join(', ')}` : '';
    };
    body.addEventListener('input', updatePreview);
    editor.querySelector('[data-template-channel]').addEventListener('change', (event) => {
      editor.querySelector('[data-template-subject-wrap]').hidden = event.target.value !== 'email';
    });
    editor.querySelectorAll('[data-template-variable]').forEach((button) => button.addEventListener('click', () => {
      const token = `{{${button.dataset.templateVariable}}}`;
      const start = body.selectionStart ?? body.value.length;
      body.setRangeText(token, start, body.selectionEnd ?? start, 'end');
      body.focus();
      updatePreview();
    }));
    updatePreview();
    editor.querySelector('[data-template-save]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const payload = {
        name:clean(editor.querySelector('[data-template-name]').value),
        channel:editor.querySelector('[data-template-channel]').value,
        category:clean(editor.querySelector('[data-template-category]').value),
        subject:clean(editor.querySelector('[data-template-subject]').value),
        body:body.value,
        variables:renderer?.extractVariables?.(body.value) || [],
        active:editor.querySelector('[data-co-set="template_active"]').checked
      };
      if (!payload.name || !clean(payload.body)) { controller.options.showToast?.((globalThis.PlatformLanguage?.text("settings","m_1517d18286f0be","Add a template name and message") ?? "Add a template name and message"), (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error")); return; }
      button.disabled = true;
      try {
        const result = template.id ? await controller.api.templates.update(controller.orgId, template.id, payload) : await controller.api.templates.create(controller.orgId, payload);
        const saved = result.template;
        const index = controller.templates.findIndex((item) => clean(item.id) === clean(saved.id));
        if (index >= 0) controller.templates[index] = saved; else controller.templates.push(saved);
        controller.selectedId = clean(saved.id); controller.draft = null;
        controller.options.showToast?.((globalThis.PlatformLanguage?.text("settings","m_e39eca5619dfd7","Message template saved") ?? "Message template saved"));
        renderTemplates(controller);
      } catch (error) { controller.options.showToast?.(error?.message || 'Could not save this template', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error")); button.disabled = false; }
    });
    editor.querySelector('[data-template-delete]')?.addEventListener('click', async (event) => {
      if (!window.confirm(((v0) => globalThis.PlatformLanguage?.text("settings","m_d0987286fd2869",`Delete “${v0}”?`,{v0}) ?? `Delete “${v0}”?`)(template.name))) return;
      event.currentTarget.disabled = true;
      try {
        await controller.api.templates.remove(controller.orgId, template.id);
        controller.templates = controller.templates.filter((item) => clean(item.id) !== clean(template.id));
        controller.selectedId = clean(controller.templates[0]?.id); controller.draft = null;
        controller.options.showToast?.((globalThis.PlatformLanguage?.text("settings","m_03a21f69a299a8","Message template deleted") ?? "Message template deleted"));
        renderTemplates(controller);
      } catch (error) { controller.options.showToast?.(error?.message || 'Could not delete this template', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error")); event.currentTarget.disabled = false; }
    });
  }

  function setView(el, rawView){
    const controller = controllers.get(el);
    if (!controller) return;
    const view = clean(rawView) === 'templates' ? 'templates' : 'general';
    if (view === controller.view) return;
    controller.view = view;
    renderView(controller);
  }

  window.FirstMateCommsSettings = { mount, setView };
})();
