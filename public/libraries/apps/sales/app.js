/* public/libraries/apps/sales/app.js
 * Salesperson experience: today's appointments, follow-ups, commission
 * earnings, and the assigned sales schedule. Visibility and parameters are
 * resolved by the shared embeddable-app entitlement runtime; this package
 * never self-gates.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!runtime || !Portal) return;

  const clean = (value) => String(value ?? '').trim();
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => runtime.escapeHtml ? runtime.escapeHtml(value) : clean(value).replace(/[&<>"']/g, '');
  const first = (...values) => values.find((value) => clean(value)) ?? '';
  const localDateKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const nowDate = () => localDateKey(new Date());
  const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dateValue = (value) => {
    const text = clean(value);
    const parts = text.match(dateOnlyPattern);
    const date = value instanceof Date
      ? value
      : (parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date(text));
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const addLocalDays = (dateKey, days) => {
    const date = dateValue(dateKey) || new Date();
    date.setDate(date.getDate() + Number(days || 0));
    return localDateKey(date);
  };
  const shortDate = (value, fallback = '') => dateValue(value)?.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' }) || fallback;
  const timeText = (value, fallback = '') => dateOnlyPattern.test(clean(value))
    ? fallback
    : (dateValue(value)?.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) || fallback);
  const currency = (cents, empty = '$0.00') => {
    const amount = Number(cents);
    if (!Number.isFinite(amount)) return empty;
    return (amount / 100).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style:'currency', currency:'USD' });
  };
  const orgId = (context = {}) => clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const statusError = (error, fallback) => clean(error?.data?.message || error?.message || fallback || 'Something went wrong.');
  const responseRows = (result, ...keys) => {
    for (const key of keys) {
      const value = result?.[key] ?? result?.data?.[key];
      if (Array.isArray(value)) return value;
    }
    return Array.isArray(result) ? result : [];
  };
  const showToast = (title, message, ok = true) => Portal.ui?.showToast?.(title, message, ok);

  const css = `
    .sales-shell{--sales-ink:#101828;--sales-muted:#667085;--sales-line:#e4e7ec;min-height:100%;box-sizing:border-box;padding:clamp(14px,2.5vw,28px);background:linear-gradient(180deg,#f8fafc 0,#f3f6fa 100%);color:var(--sales-ink);font-family:inherit}
    .sales-page{width:min(1120px,100%);margin:0 auto;display:grid;gap:16px}.sales-page.narrow{width:min(760px,100%)}.sales-dashboard{display:grid;gap:16px}
    .sales-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}.sales-eyebrow{font-size:10px;font-weight:1000;letter-spacing:.1em;text-transform:uppercase;color:var(--primary-readable,var(--primary,#d93025))}.sales-title{margin:3px 0 0;font-size:clamp(24px,4vw,34px);line-height:1.06;font-weight:1000}.sales-sub{margin:5px 0 0;color:var(--sales-muted);font-size:13px;font-weight:800;line-height:1.4}
    .sales-btn{min-height:40px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;color:#344054;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;box-sizing:border-box}.sales-btn:hover{border-color:rgba(var(--primary-rgb,217,48,37),.32);color:var(--primary-readable,var(--primary,#d93025))}.sales-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 10px 24px rgba(var(--primary-rgb,217,48,37),.18)}.sales-btn.danger{border-color:#fecdca;color:#b42318;background:#fff5f4}.sales-btn:disabled{opacity:.48;cursor:not-allowed;box-shadow:none}.sales-btn.small{min-height:32px;padding:0 10px;font-size:10px}
    .sales-card{border:1px solid rgba(15,23,42,.085);border-radius:18px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.055);padding:16px;box-sizing:border-box}.sales-card-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.sales-card-title h3{margin:0;font-size:14px;font-weight:1000}.sales-card-title small{color:var(--sales-muted);font-size:11px;font-weight:850}
    .sales-state{min-height:160px;display:grid;place-items:center;text-align:center;color:var(--sales-muted);padding:26px;box-sizing:border-box}.sales-state>div{display:grid;justify-items:center;gap:9px}.sales-state i{font-size:28px;color:#98a2b3}.sales-state strong{color:#344054}.sales-state.error i,.sales-state.error strong{color:#b42318}.sales-spinner{width:26px;height:26px;border:3px solid #e4e7ec;border-top-color:var(--primary,#d93025);border-radius:999px;animation:sales-spin .8s linear infinite}@keyframes sales-spin{to{transform:rotate(360deg)}}
    .sales-pulse{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}.sales-pulse-chip{flex:1 1 150px;min-width:0;display:flex;align-items:center;gap:9px;border:1px solid var(--sales-line);border-radius:13px;background:#fff;padding:10px 11px}.sales-pulse-chip>i{width:28px;height:28px;border-radius:9px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:11px;flex:none}.sales-pulse-chip.warn>i{background:#fef3f2;color:#b42318}.sales-pulse-copy{min-width:0}.sales-pulse-copy span{display:block;color:var(--sales-muted);font-size:8px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.sales-pulse-copy strong{display:block;margin-top:1px;font-size:15px;font-weight:1000}
    .sales-appt-list{display:grid;gap:10px}.sales-appt{--scope-color:var(--primary,#d93025);position:relative;border:1px solid rgba(15,23,42,.09);border-left:5px solid var(--scope-color);border-radius:16px;background:#fff;padding:13px 14px;display:grid;gap:9px;box-shadow:0 8px 22px rgba(15,23,42,.04)}
    .sales-appt-top{display:flex;align-items:center;gap:11px}.sales-appt-icon{width:42px;height:42px;border-radius:13px;background:color-mix(in srgb,var(--scope-color) 12%,#fff);color:var(--scope-color);display:grid;place-items:center;font-size:16px;flex:none}.sales-appt-copy{min-width:0;flex:1}.sales-appt-copy strong{display:block;font-size:14px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sales-appt-copy span{display:block;margin-top:2px;font-size:11px;font-weight:850;color:var(--sales-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sales-appt-time{flex:none;text-align:right}.sales-appt-time strong{display:block;font-size:13px;font-weight:1000}.sales-appt-time span{display:block;margin-top:2px;font-size:9px;font-weight:900;color:var(--sales-muted);text-transform:uppercase}
    .sales-appt-actions{display:flex;gap:7px;flex-wrap:wrap}.sales-appt-actions a{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--sales-line);border-radius:999px;background:#f8fafc;color:#475467;padding:6px 11px;font-size:10px;font-weight:1000;text-decoration:none}.sales-appt-actions a:hover{color:var(--primary-readable,var(--primary,#d93025))}
    .sales-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 8px;font-size:9px;font-weight:1000;text-transform:uppercase}.sales-pill.good{background:#ecfdf3;color:#067647}.sales-pill.warn{background:#fffaeb;color:#b54708}.sales-pill.bad{background:#fef3f2;color:#b42318}
    .sales-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.sales-summary{border:1px solid var(--sales-line);border-radius:15px;background:#fff;padding:14px}.sales-summary span{display:block;color:var(--sales-muted);font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.sales-summary strong{display:block;margin-top:5px;font-size:20px;font-weight:1000}.sales-summary small{display:block;margin-top:3px;color:var(--sales-muted);font-size:10px;font-weight:800}
    .sales-row-list{display:grid;gap:8px}.sales-row{border:1px solid var(--sales-line);border-radius:14px;background:#fff;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}.sales-row-copy{min-width:0;flex:1}.sales-row-copy strong{display:block;font-size:12px;font-weight:1000}.sales-row-copy span{display:block;margin-top:3px;color:var(--sales-muted);font-size:10px;font-weight:850}.sales-row-value{text-align:right;font-size:13px;font-weight:1000}.sales-row-value small{display:block;color:var(--sales-muted);font-size:9px;margin-top:3px}
    .sales-fu{border:1px solid var(--sales-line);border-radius:14px;background:#fff;padding:11px 12px;display:flex;align-items:center;gap:11px}.sales-fu.past{border-left:3px solid #d92d20;background:linear-gradient(90deg,#fff7f6,#fff 40%)}.sales-fu-copy{min-width:0;flex:1}.sales-fu-copy strong{display:block;font-size:12px;font-weight:950}.sales-fu-copy span{display:block;margin-top:2px;color:var(--sales-muted);font-size:9px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sales-fu-due{flex:none;font-size:10px;font-weight:1000;color:#475467;white-space:nowrap}.sales-fu-due.past{color:#d92d20}.sales-fu-actions{display:flex;gap:5px;flex:none}
    .sales-form{display:grid;gap:11px}.sales-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sales-field{display:grid;gap:5px;color:var(--sales-muted);font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}.sales-field.wide{grid-column:1/-1}.sales-field input,.sales-field select,.sales-field textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:11px;background:#fff;color:var(--sales-ink);padding:10px 11px;font:inherit;font-size:12px;font-weight:850;text-transform:none;letter-spacing:0;outline:none}.sales-field input:focus,.sales-field select:focus,.sales-field textarea:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}.sales-form-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.sales-inline-form{display:none}.sales-inline-form.open{display:grid}
    .sales-modal-back{position:fixed;inset:0;z-index:2147483500;background:rgba(15,23,42,.58);backdrop-filter:blur(7px);display:grid;place-items:center;padding:18px}.sales-modal{position:relative;width:min(520px,100%);max-height:min(720px,calc(100dvh - 36px));overflow:auto;border-radius:24px;background:#fff;box-shadow:0 32px 90px rgba(15,23,42,.32);padding:22px;box-sizing:border-box;display:grid;align-content:start;gap:14px}.sales-modal-close{position:absolute;right:12px;top:12px;width:38px;height:38px;border:0;border-radius:12px;background:#f2f4f7;color:#475467;display:grid;place-items:center;cursor:pointer}.sales-modal h2{margin:0;padding-right:42px;font-size:22px}
    .sales-project-app{height:100%;min-height:0;overflow:auto;background:#f5f7fa}.sales-project-page{min-height:100%;box-sizing:border-box;padding:clamp(14px,2.5vw,24px);display:grid;align-content:start;gap:14px}.sales-strip{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}.sales-strip-chip{flex:1 1 200px;min-width:0;display:flex;align-items:center;gap:9px;border:1px solid var(--sales-line);border-radius:13px;background:#fff;padding:10px 11px;color:inherit;text-decoration:none}.sales-strip-chip>i{width:28px;height:28px;border-radius:9px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:11px;flex:none}.sales-strip-copy{min-width:0}.sales-strip-copy span{display:block;color:var(--sales-muted);font-size:8px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.sales-strip-copy strong{display:block;margin-top:1px;font-size:11px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}a.sales-strip-chip:hover{background:#f8fafc}.sales-notes{white-space:pre-wrap;line-height:1.55;color:#344054;font-size:13px;font-weight:750}
    .sales-schedule-shell{height:100%;min-height:0;overflow:hidden}.sales-schedule-page{width:100%;height:100%;min-height:0;margin:0;display:block}.sales-schedule-calendar{height:100%;min-height:0;overflow:hidden}.sales-schedule-calendar>.prs-wrap{height:100%;min-height:0}.sales-schedule-calendar .prs-wrap.list-mode .prs-list{padding:16px;box-sizing:border-box}
    @media(max-width:720px){.sales-shell{padding:12px 10px calc(18px + env(safe-area-inset-bottom))}.sales-page{gap:12px}.sales-card{border-radius:15px;padding:13px}.sales-summary-grid{grid-template-columns:1fr 1fr}.sales-summary:first-child{grid-column:1/-1}.sales-form-grid{grid-template-columns:1fr}.sales-field.wide{grid-column:auto}.sales-appt-top{flex-wrap:wrap}.sales-modal-back{padding:0}.sales-modal{width:100%;height:100dvh;max-height:none;border-radius:0;padding:calc(20px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom))}.sales-schedule-shell{padding:6px 5px calc(6px + env(safe-area-inset-bottom))}.sales-schedule-calendar .prs-wrap.list-mode .prs-list{padding:12px}}
  `;
  Portal.util?.injectCSS?.('sales_apps', css);

  function stateHtml(kind = 'loading', message = ''){
    if (kind === 'loading') return `<div class="sales-state"><div><span class="sales-spinner"></span><strong>${esc(message || 'Loading')}</strong></div></div>`;
    const icon = kind === 'error' ? 'fa-triangle-exclamation' : 'fa-calendar-check';
    return `<div class="sales-state ${kind === 'error' ? 'error' : ''}"><div><i class="fas ${icon}"></i><strong>${esc(message || 'Nothing here yet.')}</strong></div></div>`;
  }

  function modal(content, onClose){
    const back = document.createElement('div');
    back.className = 'sales-modal-back';
    back.innerHTML = `<div class="sales-modal" role="dialog" aria-modal="true">${String(content)}<button type="button" class="sales-modal-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("sales","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); onClose?.(); };
    back.querySelector('.sales-modal-close')?.addEventListener('click', close);
    back.addEventListener('click', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    return { el:back, close };
  }

  function mapsUrl(address){
    return `https://maps.google.com/?q=${encodeURIComponent(clean(address))}`;
  }

  function confirmationPill(appointment){
    const confirmation = obj(appointment.confirmation);
    const status = clean(confirmation.status || appointment.confirmation_status).toLowerCase();
    if (['confirmed','yes'].includes(status)) return `<span class="sales-pill good">${(globalThis.PlatformLanguage?.htmlText("sales","m_2ac28976b8db5d","Confirmed") ?? "Confirmed")}</span>`;
    if (['declined','no','canceled'].includes(status)) return `<span class="sales-pill bad">${(globalThis.PlatformLanguage?.htmlText("sales","m_bf5390659e3677","Declined") ?? "Declined")}</span>`;
    if (status) return `<span class="sales-pill warn">${esc(status.replace(/_/g,' '))}</span>`;
    return '';
  }

  function appointmentCard(appointment, options = {}){
    const timed = appointment.specific_time === true && appointment.start_at;
    const time = timed ? timeText(appointment.start_at) : 'Any time';
    const dateLabel = options.showDate ? shortDate(first(appointment.start_at, appointment.start_date)) : '';
    const phone = clean(appointment.customer_phone);
    const address = clean(appointment.address);
    const stage = clean(appointment.stage);
    return `<div class="sales-appt" data-sales-appt="${esc(clean(appointment.id))}">
      <div class="sales-appt-top">
        <span class="sales-appt-icon"><i class="fas fa-handshake"></i></span>
        <div class="sales-appt-copy"><strong>${esc(first(appointment.customer_name, appointment.project_title, 'Appointment'))}</strong><span>${esc(first(address, appointment.project_title))}</span></div>
        <div class="sales-appt-time"><strong>${esc(dateLabel ? `${dateLabel}` : time)}</strong><span>${esc(dateLabel ? time : (timed ? 'Scheduled' : 'All day'))}</span></div>
      </div>
      <div class="sales-appt-actions">
        ${phone ? `<a href="tel:${String(esc(phone))}"><i class="fas fa-phone"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_34ac7f9c427ea4"," Call") ?? " Call")}</a>` : ''}
        ${phone ? `<a href="sms:${String(esc(phone))}"><i class="fas fa-message"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_d54c6c88f8e154"," Text") ?? " Text")}</a>` : ''}
        ${address ? `<a href="${String(esc(mapsUrl(address)))}" target="_blank" rel="noopener"><i class="fas fa-diamond-turn-right"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_3367a4d77d65fd"," Directions") ?? " Directions")}</a>` : ''}
        ${stage ? `<span class="sales-pill">${esc(stage)}</span>` : ''}
        ${confirmationPill(appointment)}
      </div>
    </div>`;
  }

  // Appointments open the shared project modal (the sales persona's Overview
  // tab is its default home), same as crew project tiles do.
  async function openSalesProject(appointment, context){
    let detail = null;
    try { detail = await window.SalesAPI?.me?.project?.(orgId(context), clean(appointment.project_id)); } catch (_) {}
    const resolved = obj(detail?.project);
    const project = {
      id: clean(appointment.project_id),
      title: clean(first(resolved.title, appointment.project_title, appointment.customer_name, 'Project')),
      address: clean(first(resolved.address, appointment.address)),
      customer_name: clean(first(resolved.customer_name, appointment.customer_name)),
      customer_phone: clean(first(resolved.customer_phone, appointment.customer_phone)),
      notes: clean(first(resolved.notes, appointment.notes)),
      stage: clean(first(resolved.stage, appointment.stage)),
      signature_requirements: obj(resolved.signature_requirements || appointment.signature_requirements)
    };
    if (!project.id) return;
    Portal.modules?.request?.openProject?.(project, { tab:'sales_overview' });
  }

  function bindAppointmentCards(root, appointments, context){
    root.querySelectorAll('[data-sales-appt]').forEach((card) => card.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      const appointment = appointments.find((item) => clean(item.id) === card.dataset.salesAppt);
      if (appointment) void openSalesProject(appointment, context);
    }));
  }

  function followUpDueMeta(item){
    const due = dateValue(item.due_at);
    if (!due) return { text:'', past:false };
    const key = localDateKey(due);
    const todayKey = nowDate();
    if (key === todayKey) return { text: timeText(item.due_at) || 'Today', past:false };
    return { text: shortDate(item.due_at), past: key < todayKey };
  }

  function followUpRow(item, options = {}){
    const meta = followUpDueMeta(item);
    const sub = [clean(first(item.project_title, item.project_address)), clean(item.description)].filter(Boolean).join(' · ');
    const actions = options.claim
      ? `<button type="button" class="sales-btn small" data-fu-claim="${String(esc(clean(item.id)))}"><i class="fas fa-hand"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_37d72291d3fdcc"," Claim") ?? " Claim")}</button>`
      : `<button type="button" class="sales-btn small" data-fu-done="${String(esc(clean(item.id)))}"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_224bc948fd9fdf"," Done") ?? " Done")}</button>`;
    return `<div class="sales-fu ${meta.past ? 'past' : ''}">
      <div class="sales-fu-copy"><strong>${esc(first(item.title, 'Follow-up'))}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
      ${meta.text ? `<span class="sales-fu-due ${meta.past ? 'past' : ''}">${esc(meta.text)}</span>` : ''}
      <div class="sales-fu-actions">${actions}</div>
    </div>`;
  }

  function outcomeModal(item, context, reload){
    const tomorrow = addLocalDays(nowDate(), 1);
    const handle = modal(`<h2>${String(esc(first(item.title, 'Follow-up')))}</h2>
      <p class="sales-sub">${(globalThis.PlatformLanguage?.htmlText("sales","m_68fa6f35b11153","How did it go?") ?? "How did it go?")}</p>
      <div class="sales-form">
        <div class="sales-field wide">${(globalThis.PlatformLanguage?.htmlText("sales","m_48f6e986c5a7fb","Reschedule for") ?? "Reschedule for")}<input type="date" value="${String(esc(tomorrow))}" data-outcome-date></div>
        <div class="sales-form-actions" style="justify-content:stretch;display:grid;gap:8px">
          <button type="button" class="sales-btn" data-outcome="reschedule"><i class="fas fa-rotate-right"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_6d0d95f6b13838"," Reschedule") ?? " Reschedule")}</button>
          <button type="button" class="sales-btn primary" data-outcome="scheduled"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_3d6ff50913e97b"," Appointment booked") ?? " Appointment booked")}</button>
          <button type="button" class="sales-btn danger" data-outcome="lost"><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_ee24fc01e458db"," Mark lost") ?? " Mark lost")}</button>
        </div>
      </div>`);
    handle.el.querySelectorAll('[data-outcome]').forEach((button) => button.addEventListener('click', async () => {
      const outcome = button.dataset.outcome;
      button.disabled = true;
      try {
        const payload = { outcome_id: outcome };
        if (outcome === 'reschedule') payload.due_at = clean(handle.el.querySelector('[data-outcome-date]')?.value) || tomorrow;
        await window.SalesAPI.followups.outcome(orgId(context), clean(item.id), payload);
        handle.close();
        showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), outcome === 'reschedule' ? 'Rescheduled.' : 'Completed.', true);
        await reload();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), statusError(error), false);
        button.disabled = false;
      }
    }));
  }

  function bindFollowUps(root, followups, context, reload){
    root.querySelectorAll('[data-fu-claim]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await window.SalesAPI.followups.claim(orgId(context), button.dataset.fuClaim);
        showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), (globalThis.PlatformLanguage?.text("sales","m_8e00be64bb4abf","Claimed — it is on your list now.") ?? "Claimed — it is on your list now."), true);
        await reload();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), statusError(error), false);
        button.disabled = false;
      }
    }));
    root.querySelectorAll('[data-fu-done]').forEach((button) => button.addEventListener('click', () => {
      const item = [...arr(followups.mine), ...arr(followups.unclaimed)].find((entry) => clean(entry.id) === button.dataset.fuDone);
      if (item) outcomeModal(item, context, reload);
    }));
  }

  function mountSalesOverview(root, context = {}){
    let destroyed = false;
    let dashboard = null;
    const showPulse = context.params?.show_pipeline_pulse !== false;
    const canManageFollowups = context.params?.can_manage_followups === true;
    root.innerHTML = `<div class="sales-shell"><div class="sales-page"><div class="sales-head"><div><div class="sales-eyebrow">${(globalThis.PlatformLanguage?.htmlText("sales","m_239c94a2b44bff","Sales overview") ?? "Sales overview")}</div><h1 class="sales-title">${(globalThis.PlatformLanguage?.htmlText("sales","m_23929ba4ba84dd","Today") ?? "Today")}</h1><p class="sales-sub">${String(esc(new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</p></div></div><div data-pulse></div><div class="sales-dashboard" data-dashboard>${String(stateHtml('loading','Loading your day'))}</div></div></div>`;
    const pulseRoot = root.querySelector('[data-pulse]');
    const dashboardRoot = root.querySelector('[data-dashboard]');
    const renderPulse = () => {
      if (!pulseRoot || !showPulse || !dashboard) { if (pulseRoot) pulseRoot.innerHTML = ''; return; }
      const pulse = obj(dashboard.pulse);
      pulseRoot.innerHTML = `<div class="sales-pulse">
        <div class="sales-pulse-chip"><i class="fas fa-handshake"></i><div class="sales-pulse-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_7316f560df772e","Appointments today") ?? "Appointments today")}</span><strong>${String(Number(pulse.appointments_today || 0))}</strong></div></div>
        <div class="sales-pulse-chip"><i class="fas fa-calendar-week"></i><div class="sales-pulse-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_c807cbebf700fa","This week") ?? "This week")}</span><strong>${String(Number(pulse.appointments_week || 0))}</strong></div></div>
        <div class="sales-pulse-chip ${String(Number(pulse.followups_overdue || 0) > 0 ? 'warn' : '')}"><i class="fas fa-phone"></i><div class="sales-pulse-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_c7ef448d322276","Open follow-ups") ?? "Open follow-ups")}</span><strong>${String(Number(pulse.followups_open || 0))}${String(Number(pulse.followups_overdue || 0) ? ` <small style="color:#d92d20;font-size:10px">${((v0) => globalThis.PlatformLanguage?.htmlText("sales","m_1390c17284de2d",`(${v0} late)`,{v0}) ?? `(${v0} late)`)(Number(pulse.followups_overdue))}</small>` : '')}</strong></div></div>
      </div>`;
    };
    const renderDashboard = () => {
      if (!dashboard) return;
      const appointments = responseRows(dashboard, 'appointments');
      const upcoming = responseRows(dashboard, 'upcoming');
      const followups = obj(dashboard.followups);
      const mine = arr(followups.mine);
      const unclaimed = arr(followups.unclaimed);
      dashboardRoot.innerHTML = `
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_e90a3398222f9d","Today's appointments") ?? "Today's appointments")}</h3><small>${String(appointments.length)}</small></div>${String(appointments.length ? `<div class="sales-appt-list">${appointments.map((item) => appointmentCard(item)).join('')}</div>` : stateHtml('empty','No appointments scheduled today.'))}</section>
        ${String(upcoming.length ? `<section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_7d814e419cd412","Coming up") ?? "Coming up")}</h3><small>${upcoming.length}</small></div><div class="sales-appt-list">${upcoming.map((item) => appointmentCard(item, { showDate:true })).join('')}</div></section>` : '')}
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_40d434de84f84c","Your follow-ups") ?? "Your follow-ups")}</h3>${String(canManageFollowups ? `<button type="button" class="sales-btn small" data-fu-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("sales","m_5fe01108f83039"," New") ?? " New")}</button>` : `<small>${mine.length}</small>`)}</div>
          ${String(canManageFollowups ? `<div class="sales-inline-form sales-form" data-fu-form style="margin-bottom:11px"><div class="sales-form-grid"><div class="sales-field wide">${(globalThis.PlatformLanguage?.htmlText("sales","m_da96fc7ac6b2fa","What needs doing?") ?? "What needs doing?")}<input type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("sales","m_bf01c40d236456","Call the customer back") ?? "Call the customer back")}" data-fu-title></div><div class="sales-field">${(globalThis.PlatformLanguage?.htmlText("sales","m_3dac4d5769efeb","Due") ?? "Due")}<input type="date" value="${esc(addLocalDays(nowDate(), 1))}" data-fu-due></div><div class="sales-field">${(globalThis.PlatformLanguage?.htmlText("sales","m_ed28d6fb9ea58c","Channel") ?? "Channel")}<select data-fu-channel><option value="call">${(globalThis.PlatformLanguage?.htmlText("sales","m_8d4eaa0da004be","Call") ?? "Call")}</option><option value="text">${(globalThis.PlatformLanguage?.htmlText("sales","m_124287f184b88b","Text") ?? "Text")}</option><option value="email">${(globalThis.PlatformLanguage?.htmlText("sales","m_5d2b9327181e33","Email") ?? "Email")}</option><option value="visit">${(globalThis.PlatformLanguage?.htmlText("sales","m_d8d2e84c5e4d8b","Visit") ?? "Visit")}</option></select></div></div><div class="sales-form-actions"><button type="button" class="sales-btn" data-fu-cancel>${(globalThis.PlatformLanguage?.htmlText("sales","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="sales-btn primary" data-fu-save>${(globalThis.PlatformLanguage?.htmlText("sales","m_cd06f62a7707a3","Add follow-up") ?? "Add follow-up")}</button></div></div>` : '')}
          ${String(mine.length ? `<div class="sales-row-list">${mine.map((item) => followUpRow(item)).join('')}</div>` : stateHtml('empty','No open follow-ups. Nice.'))}
        </section>
        ${String(unclaimed.length ? `<section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_b41d2411422a87","Unclaimed (your role)") ?? "Unclaimed (your role)")}</h3><small>${unclaimed.length}</small></div><div class="sales-row-list">${unclaimed.map((item) => followUpRow(item, { claim:canManageFollowups })).join('')}</div></section>` : '')}`;
      bindAppointmentCards(dashboardRoot, [...appointments, ...upcoming], context);
      bindFollowUps(dashboardRoot, followups, context, load);
      const form = dashboardRoot.querySelector('[data-fu-form]');
      dashboardRoot.querySelector('[data-fu-new]')?.addEventListener('click', () => form?.classList.toggle('open'));
      dashboardRoot.querySelector('[data-fu-cancel]')?.addEventListener('click', () => form?.classList.remove('open'));
      dashboardRoot.querySelector('[data-fu-save]')?.addEventListener('click', async (event) => {
        const title = clean(form?.querySelector('[data-fu-title]')?.value);
        if (!title) { showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), (globalThis.PlatformLanguage?.text("sales","m_4db69e84360a07","Give the follow-up a title.") ?? "Give the follow-up a title."), false); return; }
        event.currentTarget.disabled = true;
        try {
          await window.SalesAPI.followups.create(orgId(context), {
            title,
            due_at: clean(form?.querySelector('[data-fu-due]')?.value),
            channel: clean(form?.querySelector('[data-fu-channel]')?.value) || 'call'
          });
          showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), (globalThis.PlatformLanguage?.text("sales","m_21856c619234ec","Added to your list.") ?? "Added to your list."), true);
          await load();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("sales","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), statusError(error), false);
          event.currentTarget.disabled = false;
        }
      });
    };
    const load = async () => {
      try {
        dashboard = await window.SalesAPI.me.dashboard(orgId(context), nowDate());
        if (destroyed) return;
        renderPulse();
        renderDashboard();
      } catch (error) {
        if (!destroyed) {
          dashboardRoot.innerHTML = (String(stateHtml('error', statusError(error, 'Could not load your day.'))) + "<div style=\"display:grid;place-items:center;padding-bottom:20px\"><button type=\"button\" class=\"sales-btn\" data-sales-retry><i class=\"fas fa-rotate-right\"></i>" + (globalThis.PlatformLanguage?.htmlText("sales","m_cbfbb44ff35f0f"," Try again") ?? " Try again") + "</button></div>");
          dashboardRoot.querySelector('[data-sales-retry]')?.addEventListener('click', () => { void load(); });
        }
      }
    };
    load();
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  let activeSalesScheduleHandle = null;
  const salesScheduleViews = ['list','day','4day','week','month'];

  function salesScheduleRange(view, anchorValue){
    const anchor = dateValue(anchorValue) || new Date();
    if (view === 'list') return {};
    if (view === 'month') {
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      monthStart.setDate(monthStart.getDate() - monthStart.getDay());
      return { from:localDateKey(monthStart), to:addLocalDays(localDateKey(monthStart), 41) };
    }
    if (view === 'week') {
      const weekStart = new Date(anchor);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return { from:localDateKey(weekStart), to:addLocalDays(localDateKey(weekStart), 6) };
    }
    return { from:localDateKey(anchor), to:addLocalDays(localDateKey(anchor), view === '4day' ? 3 : 0) };
  }

  function salesScheduleEvents(appointments){
    return arr(appointments).map((appointment, index) => {
      const timed = appointment.specific_time === true;
      const start = dateValue(first(appointment.start_at, appointment.start_date));
      if (!start) return null;
      let end = dateValue(first(appointment.end_at, appointment.end_date));
      if (!timed) end = dateValue(addLocalDays(first(appointment.end_date, localDateKey(start)), 1));
      if (!end || end <= start) end = new Date(start.getTime() + (timed ? Math.max(30, Number(appointment.duration_minutes || 60)) * 60 * 1000 : 24 * 60 * 60 * 1000));
      return {
        id:`sales:${clean(appointment.project_id)}:${clean(appointment.id || index)}`,
        title:first(appointment.customer_name, appointment.project_title, 'Appointment'),
        project_id:clean(appointment.project_id),
        project_title:clean(appointment.project_title),
        project_address:clean(appointment.address),
        customer_name:clean(appointment.customer_name),
        start_at:start.toISOString(),
        end_at:end.toISOString(),
        all_day:!timed,
        schedule_granularity:timed ? 'time' : 'date',
        status:clean(appointment.status),
        __salesAppointment:appointment
      };
    }).filter(Boolean);
  }

  function mountSalesSchedule(root, context = {}){
    let destroyed = false;
    let appointments = [];
    let requestVersion = 0;
    let loaded = false;
    const initialRoute = Portal.navigation?.read?.() || {};
    let view = salesScheduleViews.includes(initialRoute.salesScheduleView) ? initialRoute.salesScheduleView : 'week';
    let anchor = dateValue(initialRoute.salesScheduleDate) || new Date();
    root.innerHTML = `<div class="sales-shell sales-schedule-shell"><div class="sales-page sales-schedule-page"><div class="sales-schedule-calendar" data-schedule>${stateHtml('loading','Loading your appointments')}</div></div></div>`;
    const mount = root.querySelector('[data-schedule]');
    const isMobile = () => window.matchMedia?.('(max-width:720px)')?.matches === true;
    const writeRoute = (method, patchValue, options) => {
      if (Portal.navigation?.applying) return;
      Portal.navigation?.[method]?.(patchValue, options);
    };
    const render = () => {
      if (!window.PlatformScheduleView?.renderProjectRangeScheduler || !window.PlatformScheduling) {
        mount.innerHTML = stateHtml('error','The shared schedule view is unavailable.');
        return;
      }
      window.PlatformScheduleView.renderProjectRangeScheduler(mount, {
        Scheduling:window.PlatformScheduling,
        events:salesScheduleEvents(appointments),
        readOnly:true,
        allowCreate:false,
        allowEdit:false,
        mode:view,
        modes:salesScheduleViews,
        modeLabels:{ '4day':isMobile() ? '3 Day' : '4 Day' },
        date:anchor,
        shortRangeDayCount:isMobile() ? 3 : 4,
        mobileLayout:isMobile(),
        touchSwipeNavigation:true,
        initialScrollMinute:7 * 60,
        showListLabel:false,
        emptyMessage:(globalThis.PlatformLanguage?.text("sales","m_03a550bfeb857a","No sales appointments are scheduled in this view.") ?? "No sales appointments are scheduled in this view."),
        onModeChange(nextView){
          if (!salesScheduleViews.includes(nextView)) return;
          view = nextView;
          writeRoute('push', { salesScheduleView:view }, { source:'sales-schedule-view', ownedKeys:['salesScheduleView'] });
          void load();
        },
        onNavigate(nextDate){
          anchor = dateValue(nextDate) || new Date();
          writeRoute('replace', { salesScheduleDate:localDateKey(anchor) }, { source:'sales-schedule-date', ownedKeys:['salesScheduleDate'] });
          void load();
        },
        onEventClick(item){
          if (item?.__salesAppointment) openSalesProject(item.__salesAppointment);
        }
      });
    };
    const load = async () => {
      const version = ++requestVersion;
      if (!loaded && mount) mount.innerHTML = stateHtml('loading','Loading your appointments');
      try {
        const result = await window.SalesAPI.me.appointments(orgId(context), salesScheduleRange(view, anchor));
        if (destroyed || version !== requestVersion) return;
        appointments = responseRows(result, 'appointments');
        loaded = true;
        render();
      } catch (error) {
        if (!destroyed && version === requestVersion && mount) {
          mount.innerHTML = (String(stateHtml('error', statusError(error,'Could not load your appointments.'))) + "<div style=\"display:grid;place-items:center;padding-bottom:20px\"><button type=\"button\" class=\"sales-btn\" data-sales-retry><i class=\"fas fa-rotate-right\"></i>" + (globalThis.PlatformLanguage?.htmlText("sales","m_cbfbb44ff35f0f"," Try again") ?? " Try again") + "</button></div>");
          mount.querySelector('[data-sales-retry]')?.addEventListener('click', () => { void load(); });
        }
      }
    };
    const handle = {
      applyRoute(route = {}){
        if (route.tab !== 'sales_schedule' || destroyed) return;
        const nextView = salesScheduleViews.includes(route.salesScheduleView) ? route.salesScheduleView : 'week';
        const nextAnchor = dateValue(route.salesScheduleDate) || anchor;
        const changed = nextView !== view || localDateKey(nextAnchor) !== localDateKey(anchor);
        view = nextView;
        anchor = nextAnchor;
        if (changed) void load();
      },
      destroy(){
        destroyed = true;
        requestVersion += 1;
        window.removeEventListener('resize', onResize);
        if (activeSalesScheduleHandle === handle) activeSalesScheduleHandle = null;
        root.innerHTML = '';
      }
    };
    const onResize = () => { if (!destroyed && loaded) render(); };
    activeSalesScheduleHandle = handle;
    window.addEventListener('resize', onResize);
    void load();
    return handle;
  }

  function isCommissionEntry(entry){
    return clean(entry.kind).toLowerCase().includes('commission');
  }

  function commissionEntryCard(entryValue = {}){
    const entry = obj(entryValue);
    const status = Number(entry.remaining_cents || 0) === 0 && Number(entry.applied_cents || 0) !== 0 ? 'in payroll' : clean(entry.state || 'accrued');
    const clawback = Number(entry.amount_cents || 0) < 0;
    return `<div class="sales-row"><div class="sales-row-copy"><strong>${esc(first(entry.project_title, entry.description, 'Commission'))}</strong><span>${esc(first(entry.description !== entry.project_title ? entry.description : '', shortDate(entry.eligible_at), 'Commission'))}</span></div><div class="sales-row-value" ${clawback ? 'style="color:#b42318"' : ''}>${esc(currency(Number(entry.amount_cents || 0)))}<small><span class="sales-pill ${status === 'paid' ? 'good' : clawback ? 'bad' : 'warn'}">${esc(clawback ? 'clawback' : status.replace(/_/g,' '))}</span></small></div></div>`;
  }

  function otherEarningCard(entryValue = {}){
    const entry = obj(entryValue);
    const kind = clean(entry.kind || 'earning').replace(/_/g,' ');
    const status = Number(entry.remaining_cents || 0) === 0 && Number(entry.applied_cents || 0) !== 0 ? 'in payroll' : clean(entry.state || 'accrued');
    return `<div class="sales-row"><div class="sales-row-copy"><strong style="text-transform:capitalize">${esc(first(entry.description, kind))}</strong><span>${esc(first(entry.project_title, shortDate(entry.eligible_at), 'Payroll earning'))}</span></div><div class="sales-row-value">${esc(currency(Number(entry.amount_cents || 0)))}<small><span class="sales-pill ${status === 'paid' ? 'good' : 'warn'}">${esc(status.replace(/_/g,' '))}</span></small></div></div>`;
  }

  function mountSalesEarnings(root, context = {}){
    let destroyed = false;
    root.innerHTML = `<div class="sales-shell"><div class="sales-page"><div class="sales-head"><div><div class="sales-eyebrow">${(globalThis.PlatformLanguage?.htmlText("sales","m_a65c881ea565c9","My commissions") ?? "My commissions")}</div><h1 class="sales-title">${(globalThis.PlatformLanguage?.htmlText("sales","m_685ff0ff145929","Earnings") ?? "Earnings")}</h1><p class="sales-sub">${(globalThis.PlatformLanguage?.htmlText("sales","m_665dff0f24c0b6","Commission on every deal: what is pending, what is in payroll, and what has been paid.") ?? "Commission on every deal: what is pending, what is in payroll, and what has been paid.")}</p></div></div><div data-earnings>${String(stateHtml('loading','Loading your commissions'))}</div></div></div>`;
    const mount = root.querySelector('[data-earnings]');
    const render = (result) => {
      const report = obj(result.earnings || result.report || result);
      const entries = arr(report.entries);
      const projects = arr(report.projects);
      const totals = obj(report.totals);
      const commissions = entries.filter(isCommissionEntry);
      const others = entries.filter((entry) => !isCommissionEntry(entry));
      mount.innerHTML = `<div class="sales-summary-grid">
          <div class="sales-summary"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_5f59818bf1cb7d","Owed") ?? "Owed")}</span><strong>${String(esc(currency(Math.max(0, Number(totals.owed_cents || 0)))))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("sales","m_3d6345f45141a8","Accrued and currently in payroll") ?? "Accrued and currently in payroll")}</small></div>
          <div class="sales-summary"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_956173c8527121","Paid") ?? "Paid")}</span><strong>${String(esc(currency(Math.max(0, Number(totals.paid_cents || 0)))))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("sales","m_192360a7033431","Completed payroll") ?? "Completed payroll")}</small></div>
          <div class="sales-summary"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_929d3bd2149645","Projected") ?? "Projected")}</span><strong>${String(esc(currency(Math.max(0, Number(totals.projected_cents || 0)))))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("sales","m_047c1d69a096b3","Not owed until accrued") ?? "Not owed until accrued")}</small></div>
        </div>
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_612cec7371695b","Commissions") ?? "Commissions")}</h3><small>${String(commissions.length)}</small></div>${String(commissions.length ? `<div class="sales-row-list">${commissions.slice(0, 100).map(commissionEntryCard).join('')}</div>` : stateHtml('empty','No commissions yet — go close something.'))}</section>
        ${String(others.length ? `<section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_8726cf189a9d40","Other earnings") ?? "Other earnings")}</h3><small>${others.length}</small></div><div class="sales-row-list">${others.slice(0, 50).map(otherEarningCard).join('')}</div></section>` : '')}
        ${String(!entries.length && projects.length ? `<section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_e48ae8574d9d08","Earnings by project") ?? "Earnings by project")}</h3><small>${projects.length}</small></div><div class="sales-row-list">${projects.map((item) => {
          const project = obj(item);
          const projectTotals = obj(project.totals);
          return `<div class="sales-row"><div class="sales-row-copy"><strong>${esc(first(project.title, project.project_title, project.project_id, 'Project'))}</strong></div><div class="sales-row-value">${esc(currency(Math.max(0, Number(projectTotals.owed_cents || projectTotals.projected_cents || projectTotals.paid_cents || 0))))}</div></div>`;
        }).join('')}</div></section>` : '')}`;
    };
    const client = window.PayrollAPI?.earnings;
    if (!client?.me) {
      mount.innerHTML = stateHtml('error', 'The payroll earnings library is unavailable.');
    } else {
      client.me(orgId(context)).then((result) => { if (!destroyed) render(result); })
        .catch((error) => { if (!destroyed) mount.innerHTML = stateHtml('error', statusError(error, 'Could not load earnings.')); });
    }
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function projectContextId(context = {}){
    return clean(context.projectId || context.project?.id || context.entityId);
  }

  function appointmentRow(appointment){
    const timed = appointment.specific_time === true && appointment.start_at;
    const when = `${shortDate(first(appointment.start_at, appointment.start_date))}${timed ? ` · ${timeText(appointment.start_at)}` : ''}`;
    const status = clean(appointment.status || 'scheduled');
    return `<div class="sales-row"><div class="sales-row-copy"><strong>${esc(first(appointment.title, 'Sales appointment'))}</strong><span>${esc(when)}${clean(appointment.notes) ? ` · ${esc(appointment.notes)}` : ''}</span></div><span class="sales-pill ${status === 'completed' ? 'good' : status === 'canceled' ? 'bad' : ''}">${esc(status)}</span></div>`;
  }

  function mountSalesProjectOverviewLegacy(context = {}){
    const outer = context.roots?.main || context.mainRoot || context.root;
    const root = outer?.querySelector?.('[data-sales-project-app="overview"]') || outer;
    let destroyed = false;
    let data = null;
    const seed = obj(context.project);
    const render = () => {
      const project = obj(data?.project || seed);
      const appointments = arr(data?.appointments);
      const followups = arr(data?.followups);
      const customer = clean(first(project.customer_name, obj(project.customer).name, seed.customer_name));
      const phone = clean(first(project.customer_phone, obj(project.customer).phone, seed.customer_phone));
      const address = clean(first(project.address, seed.address));
      const chips = [
        address ? `<a class="sales-strip-chip" href="${String(esc(mapsUrl(address)))}" target="_blank" rel="noopener"><i class="fas fa-location-dot"></i><div class="sales-strip-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_53d803cdbe9ab1","Address") ?? "Address")}</span><strong>${String(esc(address))}</strong></div></a>` : '',
        customer ? `<div class="sales-strip-chip"><i class="fas fa-user"></i><div class="sales-strip-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_ae8e4953e07d70","Customer") ?? "Customer")}</span><strong>${String(esc(customer))}</strong></div></div>` : '',
        phone ? `<a class="sales-strip-chip" href="tel:${String(esc(phone.replace(/[^0-9+]/g,'')))}"><i class="fas fa-phone"></i><div class="sales-strip-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_ed04c65845180f","Phone") ?? "Phone")}</span><strong>${String(esc(phone))}</strong></div></a>` : ''
      ].filter(Boolean).join('');
      const stage = clean(project.stage);
      root.innerHTML = `<div class="sales-project-page"><div class="sales-page">
        ${String(chips ? `<div class="sales-strip">${chips}</div>` : '')}
        ${String(stage || clean(project.lead_status) ? `<div class="sales-strip">${stage ? `<div class="sales-strip-chip"><i class="fas fa-flag-checkered"></i><div class="sales-strip-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_43f2c4d59757a1","Stage") ?? "Stage")}</span><strong>${esc(stage)}</strong></div></div>` : ''}${clean(project.lead_status) ? `<div class="sales-strip-chip"><i class="fas fa-circle-info"></i><div class="sales-strip-copy"><span>${(globalThis.PlatformLanguage?.htmlText("sales","m_012735d675a8d5","Lead status") ?? "Lead status")}</span><strong>${esc(project.lead_status)}</strong></div></div>` : ''}</div>` : '')}
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_17bb11ec04c41f","Appointments") ?? "Appointments")}</h3><small>${String(appointments.length)}</small></div>${String(appointments.length ? `<div class="sales-row-list">${appointments.map(appointmentRow).join('')}</div>` : stateHtml('empty','No sales appointments on this project.'))}</section>
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_6d21d1db92b8a6","Follow-ups") ?? "Follow-ups")}</h3><small>${String(followups.length)}</small></div>${String(followups.length ? `<div class="sales-row-list">${followups.map((item) => followUpRow(item, { claim: item.mine !== true })).join('')}</div>` : stateHtml('empty','No open follow-ups on this project.'))}</section>
        <section class="sales-card"><div class="sales-card-title"><h3>${(globalThis.PlatformLanguage?.htmlText("sales","m_de7d6168ae1ad6","Notes") ?? "Notes")}</h3></div><div class="sales-notes">${String(esc(clean(project.notes) || 'No notes have been added.'))}</div></section>
      </div></div>`;
      bindFollowUps(root, { mine: followups.filter((item) => item.mine === true), unclaimed: followups.filter((item) => item.mine !== true) }, context, load);
    };
    const load = async () => {
      const id = projectContextId(context);
      if (!id || typeof window.SalesAPI?.me?.project !== 'function') { render(); return; }
      try {
        data = await window.SalesAPI.me.project(orgId(context), id);
        if (!destroyed) render();
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="sales-project-page">${stateHtml('error', statusError(error, 'Could not load this project.'))}</div>`;
      }
    };
    root.innerHTML = `<div class="sales-project-page">${stateHtml()}</div>`;
    void load();
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function mountSalesProjectOverview(context = {}){
    const outer = context.roots?.main || context.mainRoot || context.root;
    const root = outer?.querySelector?.('[data-sales-project-app="overview"]') || outer;
    if (!window.FMFieldVisit?.mount) return mountSalesProjectOverviewLegacy(context);
    return window.FMFieldVisit.mount(root, context, { onUnavailable:() => mountSalesProjectOverviewLegacy(context) });
  }

  const salesAccess = { applicationsAny:['field'], devices:['mobile','desktop'], requireEntitlement:true };
  const salesProjectPresentation = { projectModal:{ desktopLeft:'none', mobileLeft:'none', mobileInfo:'none', mobileTabs:'icons', mobileFullscreenControl:false } };
  function registerPortal(definition){
    Portal.apps?.registerPortalApp?.({ ...definition, access:salesAccess });
  }
  runtime.registerApp({
    id:'project.sales_overview',
    kind:'project_modal_app',
    title:(globalThis.PlatformLanguage?.text("sales","m_d8d2e84c5e4d8b","Visit") ?? "Visit"),
    label:(globalThis.PlatformLanguage?.text("sales","m_d8d2e84c5e4d8b","Visit") ?? "Visit"),
    icon:'fa-house',
    visible:true,
    surfaces:['project_modal'],
    regions:['main'],
    requiresContext:['project'],
    access:salesAccess,
    presentation:salesProjectPresentation,
    panelHtml:() => '<div class="sales-project-app" data-sales-project-app="overview"></div>',
    mount:mountSalesProjectOverview
  });
  registerPortal({ id:'portal.sales_overview', tabId:'sales_overview', title:(globalThis.PlatformLanguage?.text("sales","m_23929ba4ba84dd","Today") ?? "Today"), icon:'fa-house', order:1, defaultHome:true, mount:mountSalesOverview });
  registerPortal({ id:'portal.sales_schedule', tabId:'sales_schedule', title:(globalThis.PlatformLanguage?.text("sales","m_fc05a804bd034c","Schedule") ?? "Schedule"), icon:'fa-calendar-days', order:4, fullBleed:true, params:{ mode:'sales' }, mount:mountSalesSchedule });
  registerPortal({ id:'portal.sales_earnings', tabId:'sales_earnings', title:(globalThis.PlatformLanguage?.text("sales","m_685ff0ff145929","Earnings") ?? "Earnings"), icon:'fa-wallet', order:8, mount:mountSalesEarnings });
  Portal.navigation?.registerHandler?.('sales-schedule-route', {
    priority:412,
    immediate:true,
    apply(route){ activeSalesScheduleHandle?.applyRoute?.(route); }
  });
})();
