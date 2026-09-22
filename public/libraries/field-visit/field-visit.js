/* Scope-driven field visit homepage. */
(function(){
  const clean = (value) => String(value ?? '').trim();
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const arr = (value) => Array.isArray(value) ? value : [];
  const esc = (value) => clean(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = (cents) => (Number(cents || 0) / 100).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style:'currency', currency:'USD' });
  const orgId = (context) => clean(context.organizationId || context.orgId || window.__APP?.organizationId || window.__APP?.userOrgId || window.__APP?.orgId);
  const projectId = (context) => clean(context.project?.id || context.projectId || context.entityId);
  const eventId = (context) => clean(context.event?.id || context.project?.event?.id || context.project?.schedule?.event_id);

  const style = document.createElement('style');
  style.textContent = `
    .fm-visit{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#f4f7fb;color:#101828}.fm-visit *{box-sizing:border-box}
    .fm-visit-head{flex:none;padding:16px 18px 12px;background:#fff;border-bottom:1px solid #e4e7ec}.fm-visit-head h2{margin:0;font-size:clamp(20px,4vw,28px);line-height:1.1}.fm-visit-head p{margin:5px 0 0;color:#667085;font-size:12px;font-weight:750}.fm-visit-contact{display:flex;gap:10px;align-items:center}.fm-visit-avatar{width:42px;height:42px;display:grid;place-items:center;flex:none;border-radius:13px;background:#eef4ff;color:#3538cd}
    .fm-visit-progress{flex:none;background:#fff;border-bottom:1px solid #e4e7ec;padding:10px 12px 12px}.fm-visit-progress-copy{display:flex;justify-content:space-between;margin:0 2px 8px;color:#667085;font-size:10px;font-weight:900;text-transform:uppercase}.fm-visit-track{height:5px;border-radius:99px;background:#eaecf0;overflow:hidden}.fm-visit-track span{display:block;height:100%;border-radius:inherit;background:var(--primary,#1769aa);transition:width .2s ease}.fm-visit-steps{display:flex;gap:7px;overflow-x:auto;padding:10px 0 1px;scrollbar-width:none}.fm-visit-steps::-webkit-scrollbar{display:none}.fm-visit-step{flex:0 0 auto;min-width:74px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;color:#667085;padding:8px 9px;text-align:center;font:inherit;font-size:10px;font-weight:900}.fm-visit-step b{display:grid;place-items:center;width:24px;height:24px;margin:0 auto 5px;border-radius:999px;background:#f2f4f7;color:#475467}.fm-visit-step.active{border-color:#84adff;background:#eef4ff;color:#1849a9}.fm-visit-step.active b{background:#1769aa;color:#fff}.fm-visit-step.done{color:#067647}.fm-visit-step.done b{background:#dcfae6;color:#067647}
    .fm-visit-body{flex:1;min-height:0;overflow:auto;padding:16px;-webkit-overflow-scrolling:touch}.fm-visit-panel{width:min(720px,100%);min-height:100%;margin:0 auto;display:flex;flex-direction:column}.fm-visit-hero{display:grid;justify-items:center;text-align:center;padding:26px 18px}.fm-visit-hero>i{width:64px;height:64px;display:grid;place-items:center;border-radius:20px;background:#eef4ff;color:#1769aa;font-size:25px}.fm-visit-hero h3{margin:17px 0 0;font-size:24px}.fm-visit-hero p{max-width:520px;margin:8px 0 0;color:#667085;line-height:1.5}.fm-visit-action{min-height:50px;margin:18px auto 0;border:0;border-radius:14px;background:var(--primary,#1769aa);color:var(--on-primary,#fff);padding:0 22px;font:inherit;font-weight:900;box-shadow:0 12px 26px rgba(23,105,170,.2)}.fm-visit-complete{display:inline-flex;align-items:center;gap:7px;margin-top:18px;border-radius:999px;background:#dcfae6;color:#067647;padding:8px 12px;font-size:12px;font-weight:900}
    .fm-visit-list{display:grid;gap:9px;margin-top:16px}.fm-visit-check{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:11px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:13px;text-align:left;color:#101828}.fm-visit-check i{width:29px;height:29px;display:grid;place-items:center;border:2px solid #d0d5dd;border-radius:9px;color:transparent}.fm-visit-check.done{color:#667085}.fm-visit-check.done i{border-color:#12b76a;background:#12b76a;color:#fff}.fm-visit-check strong{font-size:13px}.fm-visit-card{margin-top:16px;border:1px solid #e4e7ec;border-radius:17px;background:#fff;padding:18px}.fm-visit-card-label{color:#667085;font-size:10px;font-weight:900;text-transform:uppercase}.fm-visit-card-amount{display:block;margin-top:5px;font-size:30px}.fm-visit-launch{width:100%;min-height:48px;margin-top:16px;border:1px solid #1769aa;border-radius:13px;background:#1769aa;color:#fff;font:inherit;font-weight:900}
    .fm-visit-outcomes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}.fm-visit-outcome{min-height:118px;border:1px solid #d0d5dd;border-radius:16px;background:#fff;color:#344054;padding:16px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;font:inherit;font-weight:900}.fm-visit-outcome i{width:42px;height:42px;border-radius:13px;background:#f2f4f7;display:grid;place-items:center;font-size:18px}.fm-visit-outcome.success i{background:#dcfae6;color:#067647}.fm-visit-outcome.warning i{background:#fef0c7;color:#b54708}.fm-visit-outcome.selected{border-color:#1769aa;box-shadow:0 0 0 3px rgba(23,105,170,.12)}.fm-visit-followup-status{display:flex;align-items:center;gap:10px;margin-top:12px;padding:12px;border-radius:12px;background:#fffaeb;color:#b54708;font-weight:850}.fm-visit-followup-status i{font-size:18px}
    .fm-customer-grid{width:min(820px,100%);margin:0 auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fm-customer-card{margin:0}.fm-customer-card.wide{grid-column:1/-1}.fm-customer-name{display:flex;align-items:center;gap:10px;margin-top:10px}.fm-customer-name i{width:38px;height:38px;border-radius:12px;background:#eef4ff;color:#3538cd;display:grid;place-items:center}.fm-customer-name strong,.fm-customer-name span{display:block}.fm-customer-name span{margin-top:3px;color:#667085;font-size:12px}.fm-customer-detail{display:flex;align-items:flex-start;gap:10px;margin-top:12px;color:#344054;text-decoration:none;line-height:1.45}.fm-customer-detail>i{width:25px;color:#667085;text-align:center;margin-top:2px}.fm-customer-detail span{min-width:0;overflow-wrap:anywhere}.fm-customer-note{white-space:pre-wrap;line-height:1.6;color:#344054}
    .fm-visit-notice{display:grid;gap:12px}.fm-visit-notice.fm-visit-page-card{min-height:100%;align-content:start;margin:0}.fm-visit-page-title{display:flex;align-items:center;gap:11px;margin-bottom:2px}.fm-visit-page-title>i{width:42px;height:42px;border-radius:13px;background:#eef4ff;color:#1769aa;display:grid;place-items:center;font-size:18px}.fm-visit-page-title h3{margin:0;font-size:21px}.fm-visit-notice-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-radius:13px;background:#f8fafc;color:#344054}.fm-visit-notice-row a{color:#175cd3;font-weight:900;text-decoration:none}.fm-visit-message{padding:14px;border:1px solid #b2ddff;border-radius:13px;background:#eff8ff;color:#1849a9;line-height:1.5}.fm-visit-eta{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:12px;align-items:end}.fm-visit-eta label{display:grid;gap:6px;color:#475467;font-size:12px;font-weight:850}.fm-visit-eta input,.fm-visit-notes textarea,.fm-visit-notes input{width:100%;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#101828;padding:11px 12px;font:inherit}.fm-visit-notes textarea{min-height:135px;resize:vertical}.fm-visit-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}.fm-visit-actions .fm-visit-action{margin:0}.fm-visit-secondary{min-height:48px;border:1px solid #d0d5dd;border-radius:13px;background:#fff;color:#344054;padding:0 16px;font:inherit;font-weight:900}.fm-arrival-times{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fm-arrival-time{padding:13px;border:1px solid #e4e7ec;border-radius:13px;background:#f8fafc}.fm-arrival-time span,.fm-arrival-time strong{display:block}.fm-arrival-time span{color:#667085;font-size:10px;font-weight:900;text-transform:uppercase}.fm-arrival-time strong{margin-top:5px;font-size:17px}.fm-arrival-delta{padding:11px 13px;border-radius:12px;background:#f2f4f7;color:#475467;font-weight:850}.fm-arrival-delta.late{background:#fef0c7;color:#b54708}.fm-arrival-delta.early{background:#dcfae6;color:#067647}.fm-visit-summary{display:grid;gap:10px}.fm-visit-summary-row{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #e4e7ec;border-radius:14px;background:#fff}.fm-visit-summary-row>i{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:#f2f4f7;color:#667085}.fm-visit-summary-row.done>i{background:#dcfae6;color:#067647}.fm-visit-summary-row strong,.fm-visit-summary-row span{display:block}.fm-visit-summary-row span{margin-top:3px;color:#667085;font-size:12px}
    .fm-visit-foot{flex:none;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 14px calc(9px + env(safe-area-inset-bottom));border-top:1px solid #e4e7ec;background:#fff}.fm-visit-nav{width:auto;min-width:88px;min-height:39px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;color:#344054;padding:0 13px;font:inherit;font-size:12px;font-weight:850}.fm-visit-nav.next{grid-column:3;background:#1769aa;border-color:#1769aa;color:#fff}.fm-visit-nav:disabled{opacity:.35}.fm-visit-count{grid-column:2;justify-self:center;color:#667085;font-size:11px;font-weight:850;white-space:nowrap}.fm-visit-state{height:100%;display:grid;place-items:center;text-align:center;color:#667085;padding:24px}.fm-visit-spinner{width:30px;height:30px;margin:0 auto 10px;border:3px solid #e4e7ec;border-top-color:#1769aa;border-radius:999px;animation:fmvisitspin .8s linear infinite}@keyframes fmvisitspin{to{transform:rotate(360deg)}}
    @media(max-width:720px){.fm-visit-head{padding:13px 14px 10px}.fm-visit-body{padding:10px}.fm-visit-hero{padding:22px 12px}.fm-visit-panel{min-height:calc(100% - 4px)}.fm-visit-step{min-width:68px}.fm-visit-foot{padding-left:10px;padding-right:10px}.fm-visit-outcomes{grid-template-columns:1fr}.fm-visit-outcome{min-height:82px;flex-direction:row;justify-content:flex-start;text-align:left}.fm-customer-grid{grid-template-columns:1fr}.fm-customer-card.wide{grid-column:auto}}
  `;
  document.head.appendChild(style);

  function openProjectTab(context, project, tab){
    window.Portal?.modules?.request?.openProject?.({ ...obj(context.project), ...obj(project), id:projectId(context) }, { tab });
  }

  function mount(root, context = {}, options = {}){
    if (!root || !window.CrewAPI?.projects?.visit) { options.onUnavailable?.(); return { destroy(){} }; }
    let destroyed = false;
    let fallbackHandle = null;
    let data = null;
    let active = 0;
    const applyHeaderIdentity = () => {
      if (context.active === false || !data?.project) return;
      context.setHeaderIdentity?.({ ownerTab:clean(context.activeTab || 'sales_overview'), title:clean(data.project.customer_name || data.project.title || (globalThis.PlatformLanguage?.text("field-visit","m_ae8e4953e07d70","Customer") ?? "Customer")), subtitle:clean(data.project.address) });
    };
    root.innerHTML = `<div class="fm-visit-state"><div><div class="fm-visit-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("field-visit","m_3f024db829343a","Loading this visit") ?? "Loading this visit")}</strong></div></div>`;

    const completeAction = async (step, button, actionId = '', payload = {}) => {
      button.disabled = true;
      try {
        data = await window.CrewAPI.projects.visitAction(orgId(context), projectId(context), step.id, { event_id:clean(data?.event?.id), ...(actionId ? { action_id:actionId } : {}), ...payload });
        const notification = obj(data.notification);
        if (notification.requested && notification.sent === false) window.PortalToast?.error?.(notification.error || 'The customer notification could not be sent.');
        else if (notification.sent && !notification.already_processed) window.PortalToast?.success?.('The customer was notified.');
        const next = arr(data?.workflow?.steps).findIndex((entry) => !entry.completed);
        if (next >= 0) active = next;
        render();
      } catch (error) {
        button.disabled = false;
        window.PortalToast?.error?.(error?.message || 'Could not update the visit.');
      }
    };

    const checklistContent = (step) => {
      const items = arr(data?.integrations?.checklist_items);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-list-check"></i><h3>${esc(step.title)}</h3><p>${esc(step.description)}</p></div>${items.length ? `<div class="fm-visit-list">${items.map((item) => `<button type="button" class="fm-visit-check ${item.completed ? 'done' : ''}" data-visit-check="${esc(item.id)}"><i class="fa-solid fa-check"></i><span><strong>${esc(item.title || item.description || 'Checklist item')}</strong></span></button>`).join('')}</div>` : `<div class="fm-visit-card"><p>${(globalThis.PlatformLanguage?.text("field-visit","m_e8bc295e0ac9f5","No checklist items are assigned yet.") ?? "No checklist items are assigned yet.")}</p><button class="fm-visit-launch" type="button" data-open-tab="crew_checklists">${(globalThis.PlatformLanguage?.text("field-visit","m_d455e7061f578b","Open Checklists") ?? "Open Checklists")}</button></div>`}`;
    };
    const paymentContent = (step) => {
      const summary = obj(data?.integrations?.payment_summary);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-credit-card"></i><h3>${String(esc(step.title))}</h3><p>${String(esc(step.description))}</p></div><div class="fm-visit-card"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_59d1f6f44b2d3a","Amount due") ?? "Amount due")}</span><strong class="fm-visit-card-amount">${String(esc(money(summary.due_cents)))}</strong><button class="fm-visit-launch" type="button" data-open-tab="${String(esc(step.target_tab || 'crew_payments'))}">${String(Number(summary.due_cents || 0) > 0 ? 'Take payment' : 'View payments')}</button></div>`;
    };
    const workflowContent = (step) => {
      const workflows = arr(data?.integrations?.workflows).filter((item) => !step.scope_template_id || clean(item.scope_template_id) === clean(step.scope_template_id));
      const ready = workflows.find((item) => !['completed','skipped','canceled'].includes(clean(item.status)));
      return `<div class="fm-visit-hero"><i class="fa-solid fa-file-signature"></i><h3>${esc(step.title)}</h3><p>${esc(step.description)}</p></div><div class="fm-visit-card"><span class="fm-visit-card-label">${ready ? 'Ready now' : step.completed ? 'Completed' : 'Upcoming'}</span><strong style="display:block;margin-top:6px">${esc(ready?.title || workflows[0]?.title || (globalThis.PlatformLanguage?.text("field-visit","m_005ebc36d89a0c","Customer workflow") ?? "Customer workflow"))}</strong><button class="fm-visit-launch" type="button" data-open-tab="${esc(step.target_tab || 'crew_signatures')}">${ready ? 'Start workflow' : 'View workflows'}</button></div>`;
    };
    const notificationContent = (step) => {
      const visit = obj(data?.integrations?.visit_context);
      const result = obj(obj(data?.state?.step_results)[step.id]);
      const notification = obj(result.notification);
      const phone = clean(visit.customer_phone || data?.project?.customer_phone);
      const eta = Number(notification.eta_minutes || visit.estimated_eta_minutes || 20);
      const customer = clean(visit.customer_name || data?.project?.customer_name || 'there');
      const template = clean(step.action?.notify?.message || 'Hi {{customer.name}}, we are on the way and expect to arrive in {{arrival.eta}}.');
      const preview = template.replaceAll('{{customer.name}}', customer).replaceAll('{{technician.name}}', clean(visit.technician_name || 'your FirstMate specialist')).replaceAll('{{project.address}}', clean(data?.project?.address)).replaceAll('{{arrival.eta}}', `about ${eta} minutes`);
      const title = `<div class="fm-visit-page-title"><i class="fa-solid fa-route"></i><h3>${esc(step.title)}</h3></div>`;
      if (step.completed) return `<div class="fm-visit-card fm-visit-notice fm-visit-page-card">${title}<div class="fm-visit-summary-row done"><i class="fa-solid ${notification.skipped ? 'fa-forward' : 'fa-message'}"></i><div><strong>${notification.skipped ? 'SMS skipped' : 'SMS sent'}</strong><span>${notification.skipped ? 'The trip was started without sending a customer message.' : `${phone || 'Customer'} · ETA ${eta} minutes`}</span></div></div>${notification.text ? `<div class="fm-visit-message">${esc(notification.text)}</div>` : ''}</div>`;
      return `<div class="fm-visit-card fm-visit-notice fm-visit-page-card">${String(title)}<div class="fm-visit-notice-row"><span><strong>${String(esc(customer))}</strong><br><small>${String(esc(phone || 'No mobile number on file'))}</small></span>${String(phone ? `<a href="tel:${esc(phone.replace(/[^0-9+]/g,''))}"><i class="fa-solid fa-phone"></i> Call</a>` : '')}</div><div class="fm-visit-eta"><label>${(globalThis.PlatformLanguage?.text("field-visit","m_389a628cbe1e55","Estimated arrival ") ?? "Estimated arrival ")}<small data-eta-source>${(globalThis.PlatformLanguage?.text("field-visit","m_91b42e93f819bd","Using the scheduled route estimate") ?? "Using the scheduled route estimate")}</small></label><label>${(globalThis.PlatformLanguage?.text("field-visit","m_db4ed7996e84c9","Minutes") ?? "Minutes")}<input type="number" min="5" max="240" step="5" value="${String(eta)}" data-visit-eta></label></div><div class="fm-visit-message" data-visit-message data-message-template="${String(esc(template))}">${String(esc(preview))}</div><div class="fm-visit-actions"><button class="fm-visit-action" type="button" data-visit-notify>${String(esc(step.action?.label || 'Send SMS & start trip'))}</button><button class="fm-visit-secondary" type="button" data-visit-skip>${(globalThis.PlatformLanguage?.text("field-visit","m_92e33d4ffc2022","Skip SMS") ?? "Skip SMS")}</button></div></div>`;
    };
    const arrivedContent = (step) => {
      const visit = obj(data?.integrations?.visit_context);
      const enRoute = obj(obj(obj(data?.state?.step_results).en_route).notification);
      const phone = clean(visit.customer_phone || data?.project?.customer_phone);
      const sentAt = Date.parse(clean(enRoute.sent_at || data?.state?.en_route_at));
      const etaMinutes = Number(enRoute.eta_minutes || 0);
      const promisedAt = Number.isFinite(sentAt) && etaMinutes > 0 ? new Date(sentAt + etaMinutes * 60000) : null;
      const now = new Date();
      const delta = promisedAt ? Math.round((now.getTime() - promisedAt.getTime()) / 60000) : 0;
      const deltaLabel = !promisedAt ? 'No promised arrival time was recorded.' : Math.abs(delta) < 2 ? 'Arriving at the time shared with the customer.' : delta > 0 ? `${delta} minutes later than the shared arrival time.` : `${Math.abs(delta)} minutes earlier than the shared arrival time.`;
      return `<div class="fm-visit-card fm-visit-notice fm-visit-page-card"><div class="fm-visit-page-title"><i class="fa-solid fa-location-dot"></i><h3>${String(esc(step.title))}</h3></div><div class="fm-visit-notice-row"><span><strong>${String(esc(visit.customer_name || data?.project?.customer_name || 'Customer'))}</strong><br><small>${String(esc(phone || 'No mobile number on file'))}</small></span>${String(phone ? `<a href="tel:${esc(phone.replace(/[^0-9+]/g,''))}"><i class="fa-solid fa-phone"></i> Call</a>` : '')}</div><div class="fm-arrival-times"><div class="fm-arrival-time"><span>${(globalThis.PlatformLanguage?.text("field-visit","m_52d3d34101b142","Told customer") ?? "Told customer")}</span><strong>${String(esc(promisedAt ? promisedAt.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : 'Not provided'))}</strong></div><div class="fm-arrival-time"><span>${(globalThis.PlatformLanguage?.text("field-visit","m_26d6e0ccbce907","Current time") ?? "Current time")}</span><strong>${String(esc(now.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })))}</strong></div></div><div class="fm-arrival-delta ${String(promisedAt ? delta > 1 ? 'late' : delta < -1 ? 'early' : '' : '')}">${String(esc(deltaLabel))}</div>${String(step.completed ? '<span class="fm-visit-complete"><i class="fa-solid fa-check"></i> Arrival confirmed</span>' : `<button class="fm-visit-action" type="button" data-visit-action>${esc(step.action?.label || "I've arrived")}</button>`)}</div>`;
    };
    const notesContent = (step) => {
      const saved = obj(obj(data?.state?.step_results)[step.id]);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-note-sticky"></i><h3>${String(esc(step.title))}</h3><p>${String(esc(step.description))}</p></div><div class="fm-visit-card fm-visit-notes"><label class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_fe61e3ae927cde","Appointment notes") ?? "Appointment notes")}</label><textarea data-visit-notes placeholder="${(globalThis.PlatformLanguage?.text("field-visit","m_8b640e66343c56","Customer goals, objections, decisions, and next steps…") ?? "Customer goals, objections, decisions, and next steps…")}">${String(esc(saved.notes || ''))}</textarea><label class="fm-visit-card-label" style="display:block;margin-top:14px">${(globalThis.PlatformLanguage?.text("field-visit","m_9a096aa82c572e","Follow-up date") ?? "Follow-up date")}</label><input type="date" value="${String(esc(saved.follow_up_due_at || tomorrow))}" data-visit-followup-date><div class="fm-visit-actions">${String(arr(step.actions).map((action) => `<button type="button" class="${clean(action.id) === 'follow_up' ? 'fm-visit-action' : 'fm-visit-secondary'}" data-visit-note-action="${esc(action.id)}">${esc(action.label)}</button>`).join(''))}</div></div>`;
    };
    const summaryContent = (step) => {
      const workflows = arr(data?.integrations?.workflows).filter((item) => !step.scope_template_id || clean(item.scope_template_id) === clean(step.scope_template_id));
      const signatureRequired = workflows.some((item) => obj(item.signature_requirement).required);
      const paymentRequired = workflows.some((item) => obj(item.payment_requirement).required);
      const signed = workflows.length > 0 && (!signatureRequired || workflows.every((item) => !obj(item.signature_requirement).required || Number(obj(item.signature_requirement).pending_count || 0) === 0));
      const paid = workflows.length > 0 && (!paymentRequired || workflows.every((item) => !obj(item.payment_requirement).required || Number(obj(item.payment_requirement).pending_count || 0) === 0));
      const delivery = clean(obj(obj(data?.state?.step_results).delivery).action_id);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-clipboard-check"></i><h3>${String(esc(step.title))}</h3><p>${String(esc(step.description))}</p></div><div class="fm-visit-card fm-visit-summary"><div class="fm-visit-summary-row ${String(signed ? 'done' : '')}"><i class="fa-solid ${String(signed ? 'fa-check' : 'fa-pen-nib')}"></i><div><strong>${String(signed ? 'Proposal signed' : 'Waiting for signature')}</strong><span>${String(delivery === 'customer_portal' ? 'Customer portal' : delivery === 'on_device' ? 'On-device approval' : 'Approval method not selected')}</span></div></div><div class="fm-visit-summary-row ${String(paid ? 'done' : '')}"><i class="fa-solid ${String(paid ? 'fa-check' : 'fa-credit-card')}"></i><div><strong>${String(paid ? 'Deposit paid' : signed ? 'Signature complete · payment still due' : 'Payment waits for signature')}</strong><span>${String(paymentRequired ? 'Required by the proposal workflow' : 'No payment required')}</span></div></div><div class="fm-visit-summary-row ${String(signed && paid ? 'done' : '')}"><i class="fa-solid ${String(signed && paid ? 'fa-handshake' : 'fa-clock')}"></i><div><strong>${String(signed && paid ? 'Sold' : 'Pending customer completion')}</strong><span>${(globalThis.PlatformLanguage?.text("field-visit","m_c68b3329256795","This status updates whenever the workflow changes.") ?? "This status updates whenever the workflow changes.")}</span></div></div>${String(!signed || !paid ? `<button class="fm-visit-launch" type="button" data-open-tab="${esc(step.target_tab || 'crew_signatures')}">Open customer workflow</button>` : '')}</div>`;
    };
    const outcomeContent = (step) => {
      const result = obj(obj(data?.state?.step_results)[step.id]);
      const selected = clean(result.action_id);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-arrow-right-arrow-left"></i><h3>${esc(step.title)}</h3><p>${esc(step.description)}</p></div><div class="fm-visit-outcomes">${arr(step.actions).map((action) => `<button type="button" class="fm-visit-outcome ${esc(action.tone)} ${selected === clean(action.id) ? 'selected' : ''}" data-visit-outcome="${esc(action.id)}"><i class="fa-solid ${esc(action.icon || 'fa-circle-dot')}"></i><span>${esc(action.label)}</span></button>`).join('')}</div>`;
    };
    const followUpContent = (step) => {
      const outcome = obj(obj(data?.state?.step_results).outcome);
      const followUp = arr(data?.integrations?.follow_ups).find((item) => clean(item.id) === clean(outcome.follow_up_node_id));
      const due = clean(followUp?.due_at);
      return `<div class="fm-visit-hero"><i class="fa-solid fa-phone"></i><h3>${String(esc(step.title))}</h3><p>${String(esc(step.description))}</p></div><div class="fm-visit-card"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_76340b00b0d14a","Assigned next step") ?? "Assigned next step")}</span><strong style="display:block;margin-top:7px">${String(esc(followUp?.title || 'Customer follow-up'))}</strong><div class="fm-visit-followup-status"><i class="fa-solid fa-list-check"></i><span>${String(esc(followUp ? `${clean(followUp.status || 'ready').replaceAll('_',' ')}${due ? ` · Due ${due}` : ''}` : 'Added to your assigned to-do list'))}</span></div></div>`;
    };
    const statusContent = (step) => `<div class="fm-visit-hero"><i class="fa-solid ${clean(step.kind) === 'complete' ? 'fa-flag-checkered' : clean(step.action?.transition) === 'arrived' ? 'fa-location-dot' : 'fa-route'}"></i><h3>${esc(step.title)}</h3><p>${esc(step.description)}</p>${step.completed ? `<span class="fm-visit-complete"><i class="fa-solid fa-check"></i>${(globalThis.PlatformLanguage?.text("field-visit","m_70a2f1f3873399"," Completed") ?? " Completed")}</span>` : step.action ? `<button class="fm-visit-action" type="button" data-visit-action>${esc(step.action.label || 'Continue')}</button>` : ''}</div>`;

    const render = () => {
      if (destroyed || !data?.configured) return;
      const project = obj(data.project);
      const steps = arr(data.workflow?.steps);
      active = Math.max(0, Math.min(active, Math.max(0, steps.length - 1)));
      const step = obj(steps[active]);
      const completed = steps.filter((entry) => entry.completed).length;
      const body = clean(step.kind) === 'checklist' ? checklistContent(step)
        : clean(step.kind) === 'payment' ? paymentContent(step)
        : clean(step.kind) === 'notification' ? notificationContent(step)
        : clean(step.kind) === 'outcome' ? outcomeContent(step)
        : clean(step.kind) === 'notes_followup' ? notesContent(step)
        : clean(step.kind) === 'summary' ? summaryContent(step)
        : clean(step.kind) === 'follow_up' ? followUpContent(step)
        : ['workflow','workflow_prepare','document','signature'].includes(clean(step.kind)) ? workflowContent(step)
        : clean(step.action?.transition) === 'arrived' ? arrivedContent(step)
        : statusContent(step);
      root.innerHTML = `<div class="fm-visit"><div class="fm-visit-progress"><div class="fm-visit-progress-copy"><span>${String(esc(data.workflow.title || 'Visit'))}</span><span>${((v1,v2) => globalThis.PlatformLanguage?.text("field-visit","m_e17957c5c4a7b9",`${v1}/${v2} complete`,{v1,v2}) ?? `${v1}/${v2} complete`)(completed,steps.length)}</span></div><div class="fm-visit-track"><span style="width:${String(steps.length ? Math.round(completed / steps.length * 100) : 0)}%"></span></div><div class="fm-visit-steps">${String(steps.map((entry,index) => `<button class="fm-visit-step ${index === active ? 'active' : ''} ${entry.completed ? 'done' : ''}" type="button" data-visit-step="${index}"><b>${entry.completed ? '<i class="fa-solid fa-check"></i>' : index + 1}</b>${esc(entry.navigation_title || entry.title)}</button>`).join(''))}</div></div><main class="fm-visit-body"><div class="fm-visit-panel">${String(body)}</div></main><footer class="fm-visit-foot"><button class="fm-visit-nav" type="button" data-visit-prev ${String(active === 0 ? 'disabled' : '')}><i class="fa-solid fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("field-visit","m_206d31a7c795c4"," Back") ?? " Back")}</button><span class="fm-visit-count">${((v7,v8) => globalThis.PlatformLanguage?.text("field-visit","m_c2727134fe1f5a",`${v7} of ${v8}`,{v7,v8}) ?? `${v7} of ${v8}`)(active + 1,steps.length)}</span><button class="fm-visit-nav next" type="button" data-visit-next ${String(active >= steps.length - 1 ? 'disabled' : '')}>${(globalThis.PlatformLanguage?.text("field-visit","m_dc6a60d7bb3581","Next ") ?? "Next ")}<i class="fa-solid fa-arrow-right"></i></button></footer></div>`;
      applyHeaderIdentity();
      root.querySelectorAll('[data-visit-step]').forEach((button) => button.addEventListener('click', () => { active = Number(button.dataset.visitStep) || 0; render(); }));
      root.querySelector('[data-visit-prev]')?.addEventListener('click', () => { active -= 1; render(); });
      root.querySelector('[data-visit-next]')?.addEventListener('click', () => { active += 1; render(); });
      root.querySelector('[data-visit-action]')?.addEventListener('click', (event) => completeAction(step, event.currentTarget));
      root.querySelector('[data-visit-notify]')?.addEventListener('click', (event) => completeAction(step, event.currentTarget, '', { eta_minutes:Number(root.querySelector('[data-visit-eta]')?.value || 20) }));
      root.querySelector('[data-visit-skip]')?.addEventListener('click', (event) => completeAction(step, event.currentTarget, '', { eta_minutes:Number(root.querySelector('[data-visit-eta]')?.value || 20), skip_notification:true }));
      root.querySelectorAll('[data-visit-outcome]').forEach((button) => button.addEventListener('click', (event) => completeAction(step, event.currentTarget, button.dataset.visitOutcome)));
      root.querySelectorAll('[data-visit-note-action]').forEach((button) => button.addEventListener('click', (event) => completeAction(step, event.currentTarget, button.dataset.visitNoteAction, { notes:clean(root.querySelector('[data-visit-notes]')?.value), follow_up_due_at:clean(root.querySelector('[data-visit-followup-date]')?.value) })));
      root.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => openProjectTab(context, project, button.dataset.openTab)));
      root.querySelectorAll('[data-visit-check]').forEach((button) => button.addEventListener('click', async () => {
        const item = arr(data.integrations?.checklist_items).find((entry) => clean(entry.id) === button.dataset.visitCheck);
        if (!item) return;
        button.disabled = true;
        try {
          await window.CrewAPI.projects.updateChecklistItem(orgId(context), projectId(context), item.id, { completed:!item.completed });
          await load(true);
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not update the checklist.');
        }
      }));
      const etaInput = root.querySelector('[data-visit-eta]');
      const message = root.querySelector('[data-visit-message]');
      const updateEta = () => {
        if (!etaInput || !message) return;
        const eta = Math.max(5, Math.min(240, Number(etaInput.value || 20)));
        message.textContent = clean(message.dataset.messageTemplate).replaceAll('{{customer.name}}', clean(data?.integrations?.visit_context?.customer_name || project.customer_name || 'there')).replaceAll('{{technician.name}}', clean(data?.integrations?.visit_context?.technician_name || 'your FirstMate specialist')).replaceAll('{{project.address}}', clean(project.address)).replaceAll('{{arrival.eta}}', `about ${Math.round(eta)} minutes`);
      };
      etaInput?.addEventListener('input', updateEta);
      const destination = obj(data?.integrations?.visit_context?.destination);
      if (etaInput && Number(destination.lat) && Number(destination.lng) && navigator.geolocation) navigator.geolocation.getCurrentPosition((position) => {
        if (!root.isConnected || clean(step.id) !== clean(arr(data?.workflow?.steps)[active]?.id)) return;
        const toRad = (degrees) => degrees * Math.PI / 180;
        const dLat = toRad(Number(destination.lat) - position.coords.latitude);
        const dLng = toRad(Number(destination.lng) - position.coords.longitude);
        const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(position.coords.latitude)) * Math.cos(toRad(Number(destination.lat))) * Math.sin(dLng/2) ** 2;
        const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        etaInput.value = String(Math.max(5, Math.round(((km * 1.25 / 45) * 60) / 5) * 5));
        const source = root.querySelector('[data-eta-source]');
        if (source) source.textContent = (globalThis.PlatformLanguage?.text("field-visit","m_a87126444c39cd","Estimated from your current location") ?? "Estimated from your current location");
        updateEta();
      }, () => {}, { enableHighAccuracy:false, timeout:5000, maximumAge:120000 });
    };

    const load = async (preserveStep = false) => {
      try {
        data = await window.CrewAPI.projects.visit(orgId(context), projectId(context), eventId(context));
        if (destroyed) return;
        if (!data?.configured) {
          fallbackHandle = options.onUnavailable?.() || null;
          return;
        }
        if (!preserveStep) {
          const currentId = clean(data.state?.current_step_id);
          const index = arr(data.workflow?.steps).findIndex((entry) => clean(entry.id) === currentId);
          active = index >= 0 ? index : 0;
        }
        render();
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="fm-visit-state"><div><i class="fa-solid fa-triangle-exclamation"></i><strong>${esc(error?.message || 'Could not load this visit.')}</strong></div></div>`;
      }
    };
    void load();
    return {
      destroy(){ destroyed = true; context.setHeaderIdentity?.(null); fallbackHandle?.destroy?.(); root.innerHTML = ''; },
      deactivate(){ context.active = false; context.setHeaderIdentity?.(null); },
      activate(nextContext = {}){ Object.assign(context, nextContext, { active:true }); applyHeaderIdentity(); },
      setActive(value, nextContext = {}){ Object.assign(context, nextContext, { active:!!value }); if (value) applyHeaderIdentity(); else context.setHeaderIdentity?.(null); },
      reload:() => load(true)
    };
  }

  window.FMFieldVisit = Object.freeze({ mount });

  const runtime = window.FirstMateEmbeddableApps;
  if (runtime?.registerApp) runtime.registerApp({
    id:'project.field_customer',
    package:'field_visit',
    kind:'project_modal_app',
    title:(globalThis.PlatformLanguage?.text("field-visit","m_ed0aeba5cf8e33","Customer information") ?? "Customer information"),
    label:(globalThis.PlatformLanguage?.text("field-visit","m_ae8e4953e07d70","Customer") ?? "Customer"),
    icon:'fa-address-card',
    order:15,
    visible:true,
    surfaces:['project_modal'],
    regions:['main'],
    requiresContext:['project'],
    access:{ applicationsAny:['field'], devices:['mobile','desktop'], entitlementKey:'project.sales_overview', requireEntitlement:false },
    presentation:{ projectModal:{ desktopLeft:'none', mobileLeft:'none', mobileInfo:'none', mobileTabs:'icons', mobileFullscreenControl:false } },
    panelHtml:() => '<div class="fm-visit" data-field-customer></div>',
    mount:(context = {}) => {
      const outer = context.roots?.main || context.mainRoot || context.root;
      const root = outer?.querySelector?.('[data-field-customer]') || outer;
      let destroyed = false;
      const render = (value) => {
        const project = obj(value?.project || value || context.project);
        const contacts = arr(value?.contacts).length ? arr(value.contacts) : arr(project.contacts);
        const customer = clean(project.customer_name || contacts[0]?.name || context.project?.customer_name);
        const address = clean(project.address || context.project?.address);
        const events = arr(value?.assigned_events).length
          ? arr(value.assigned_events)
          : (arr(value?.events).length ? arr(value.events) : arr(project.events));
        const upcoming = events.find((event) => !['completed','canceled'].includes(clean(event.status))) || events[0] || {};
        const when = clean(upcoming.start_at || upcoming.start_date);
        const whenLabel = when ? new Date(when).toLocaleString([], { weekday:'short', month:'short', day:'numeric', ...(clean(upcoming.start_at) ? { hour:'numeric', minute:'2-digit' } : {}) }) : 'Not scheduled';
        const contactCards = (contacts.length ? contacts : [{ name:customer, phone:project.customer_phone, email:project.customer_email }]).map((contact) => {
          const phone = clean(contact.phone);
          const email = clean(contact.email);
          return `<div class="fm-customer-name"><i class="fa-solid fa-user"></i><div><strong>${esc(contact.name || customer || 'Customer')}</strong><span>${contact.primary ? 'Primary contact' : 'Customer contact'}</span></div></div>${phone ? `<a class="fm-customer-detail" href="tel:${esc(phone.replace(/[^0-9+]/g,''))}"><i class="fa-solid fa-phone"></i><span>${esc(phone)}</span></a>` : ''}${email ? `<a class="fm-customer-detail" href="mailto:${esc(email)}"><i class="fa-solid fa-envelope"></i><span>${esc(email)}</span></a>` : ''}`;
        }).join('');
        root.innerHTML = `<main class="fm-visit-body"><div class="fm-customer-grid"><section class="fm-visit-card fm-customer-card"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_4204cc53f171b3","Customer contacts") ?? "Customer contacts")}</span>${String(contactCards || '<p>No customer contact information is available.</p>')}</section><section class="fm-visit-card fm-customer-card"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_3dbf4d87db5138","Property & project") ?? "Property & project")}</span><div class="fm-customer-detail"><i class="fa-solid fa-house"></i><span><strong>${String(esc(project.title || 'Project'))}</strong><br>${String(esc(clean(project.status || project.stage).replaceAll('_',' ')))}</span></div>${String(address ? `<a class="fm-customer-detail" href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener"><i class="fa-solid fa-location-dot"></i><span>${esc(address)}<br><strong>Open directions</strong></span></a>` : '')}</section><section class="fm-visit-card fm-customer-card wide"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")}</span><div class="fm-customer-detail"><i class="fa-solid fa-calendar"></i><span><strong>${String(esc(whenLabel))}</strong>${String(upcoming.notes ? `<br>${esc(upcoming.notes)}` : '')}</span></div></section><section class="fm-visit-card fm-customer-card wide"><span class="fm-visit-card-label">${(globalThis.PlatformLanguage?.text("field-visit","m_d6113dda50d96c","Project notes") ?? "Project notes")}</span><p class="fm-customer-note">${String(esc(project.notes || 'No project notes have been added.'))}</p></section></div></main>`;
      };
      root.innerHTML = `<div class="fm-visit-state"><div><div class="fm-visit-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("field-visit","m_bf1271de7156aa","Loading customer information") ?? "Loading customer information")}</strong></div></div>`;
      window.CrewAPI?.projects?.get?.(orgId(context), projectId(context)).then((response) => { if (!destroyed) render(response); }).catch(() => { if (!destroyed) render(context.project); });
      return { destroy(){ destroyed = true; root.innerHTML = ''; } };
    }
  });
})();
