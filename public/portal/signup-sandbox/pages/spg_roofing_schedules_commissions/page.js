(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const DAYS = [
    { id: 'mon', title: 'Mon' }, { id: 'tue', title: 'Tue' }, { id: 'wed', title: 'Wed' },
    { id: 'thu', title: 'Thu' }, { id: 'fri', title: 'Fri' }, { id: 'sat', title: 'Sat' }, { id: 'sun', title: 'Sun' }
  ];
  const HOURS = [];
  for (let hour = 6; hour <= 21; hour++) HOURS.push({ id: `${String(hour).padStart(2, '0')}:00`, title: `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? 'AM' : 'PM'}` });
  const LENGTHS = [{ id: 60, title: '1 hour' }, { id: 90, title: '90 minutes' }, { id: 120, title: '2 hours' }, { id: 180, title: '3 hours' }];

  function addStylesheet() {
    if (document.getElementById('roofing-schedules-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-schedules-styles'; link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_schedules_commissions/page.css?v=20260810d';
    document.head.appendChild(link);
  }

  function esc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function options(selected) { return HOURS.map((hour) => `<option value="${hour.id}"${hour.id === selected ? ' selected' : ''}>${hour.title}</option>`).join(''); }

  async function appointmentContext(ctx) {
    try {
      const response = await fetch(`${ctx.apiBaseUrl}/test-orgs/${encodeURIComponent(ctx.instanceId)}/run-state`, { credentials: 'include' });
      const payload = await response.json();
      const inputs = ((payload.instance || payload).test_org || {}).stage_inputs || {};
      for (const input of Object.values(inputs)) {
        const workflows = ((input || {}).settings || {})['roofing_setup.sales_workflows'];
        if (!workflows || typeof workflows !== 'object') continue;
        const values = Object.values(workflows);
        return { known: true, hasAppointments: values.some((workflow) => workflow && (workflow.first_contact_action === 'estimator_appointment' || workflow.bid_timing === 'initial' || workflow.bid_timing === 'follow_up_appointment')) };
      }
    } catch (error) { /* show the page when context is unavailable */ }
    return { known: false, hasAppointments: true };
  }

  window.SignupSandboxPages.spg_roofing_schedules_commissions = {
    render(container, ctx) {
      addStylesheet();
      container.innerHTML = '<main class="rsc-page"><p class="rsc-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Checking your sales process…</p></main>';
      appointmentContext(ctx).then((context) => {
        if (context.known && !context.hasAppointments) {
          ctx.complete({ settings: { 'roofing_setup.schedules': { skipped: true, reason: 'no_sales_appointments' } } });
          return;
        }

        const days = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
        const dailyHours = Object.fromEntries(DAYS.map((day) => [day.id, { enabled: days.has(day.id), start: '08:00', end: '18:00' }]));
        const recurringBlocks = [];
        let dayStart = '08:00'; let dayEnd = '18:00'; let length = 90;
        let activeStep = 0; let maxSeen = 0; let advancedOpen = false;

        function advancedHtml() {
          return `<details class="rsc-advanced"${advancedOpen ? ' open' : ''}><summary><span><i class="fa-solid fa-sliders"></i><strong>Advanced availability</strong><small>Different hours by day and recurring blocked times</small></span><i class="fa-solid fa-chevron-down"></i></summary><div class="rsc-advanced-body"><h3>Hours by day</h3><div class="rsc-day-hours">${DAYS.map((day) => { const row = dailyHours[day.id]; return `<div class="rsc-day-hours-row${row.enabled ? '' : ' is-off'}"><label><input type="checkbox" data-day-enabled="${day.id}"${row.enabled ? ' checked' : ''}> ${day.title}</label><select data-day-start="${day.id}"${row.enabled ? '' : ' disabled'}>${options(row.start)}</select><span>to</span><select data-day-end="${day.id}"${row.enabled ? '' : ' disabled'}>${options(row.end)}</select></div>`; }).join('')}</div><div class="rsc-blocked-head"><div><h3>Recurring blocked times</h3><p>Keep team meetings, training, and other repeating events off the booking calendar.</p></div><button type="button" data-block-add><i class="fa-solid fa-plus"></i> Add blocked time</button></div><div class="rsc-blocked-list">${recurringBlocks.length ? recurringBlocks.map((block, index) => `<div class="rsc-block-row"><input value="${esc(block.name)}" placeholder="Monday sales meeting" data-block="${index}:name"><select data-block="${index}:day">${DAYS.map((day) => `<option value="${day.id}"${day.id === block.day ? ' selected' : ''}>${day.title}</option>`).join('')}</select><select data-block="${index}:start">${options(block.start)}</select><span>to</span><select data-block="${index}:end">${options(block.end)}</select><button type="button" data-block-remove="${index}" aria-label="Remove blocked time"><i class="fa-solid fa-xmark"></i></button></div>`).join('') : '<p class="rsc-empty">No recurring blocked times yet.</p>'}</div></div></details>`;
        }

        function render() {
          const labels = ['Booking availability', 'Appointment length'];
          const rail = labels.map((label, index) => `<button class="rsc-step-link${index === activeStep ? ' is-active' : index <= maxSeen ? ' is-complete' : ''}" type="button" data-edit-step="${index}"${index > maxSeen ? ' hidden' : ''}><span class="rsc-step-marker">${index !== activeStep && index <= maxSeen ? '<i class="fa-solid fa-check"></i>' : index + 1}</span><span><strong>${label}</strong><small>${index === activeStep ? 'Current step' : 'Completed'}</small></span></button>`).join('');
          const body = activeStep === 0
            ? `<div class="rsc-step-count">Sales appointments · 1 of 2</div><h2>When can appointments be booked?</h2><p class="rsc-help">Set the usual booking window. Use Advanced if certain days differ or regular meetings should stay blocked.</p><div class="rsc-days">${DAYS.map((day) => `<button class="rsc-day${days.has(day.id) ? ' selected' : ''}" type="button" data-day="${day.id}">${day.title}</button>`).join('')}</div><div class="rsc-times"><label>From <select data-global-start>${options(dayStart)}</select></label><label>to <select data-global-end>${options(dayEnd)}</select></label></div>${advancedHtml()}<div class="rsc-step-nav"><button class="rsc-back" type="button" data-back>Back</button><button class="rsc-continue" type="button" data-next>Next <i class="fa-solid fa-arrow-right"></i></button></div>`
            : `<div class="rsc-step-count">Sales appointments · 2 of 2</div><h2>How long is a typical sales appointment?</h2><p class="rsc-help">This becomes the default duration when a homeowner books or your team schedules one.</p><div class="rsc-pills">${LENGTHS.map((item) => `<button class="rsc-pill${length === item.id ? ' selected' : ''}" type="button" data-length="${item.id}">${item.title}</button>`).join('')}</div><div class="rsc-step-nav"><button class="rsc-back" type="button" data-back>Back</button><button class="rsc-continue" type="button" data-finish>Save appointment schedule <i class="fa-solid fa-arrow-right"></i></button></div>`;
          container.innerHTML = `<main class="rsc-page"><div class="rsc-kicker">Sales appointments</div><h1>When can customers meet with your sales team?</h1><p class="rsc-lead">These hours only control sales appointments. Production scheduling is configured separately.</p><div class="rsc-flow"><nav class="rsc-step-list" aria-label="Sales appointment steps">${rail}</nav><section class="rsc-question-stage"><div class="rsc-step-body">${body}</div></section></div></main>`;
          wire();
        }

        function finish() {
          ctx.complete({ settings: { 'roofing_setup.schedules': { skipped: false, bookable_days: DAYS.filter((day) => days.has(day.id)).map((day) => day.id), day_start: dayStart, day_end: dayEnd, appointment_length_minutes: length, daily_hours: dailyHours, recurring_blocks: recurringBlocks } } });
        }

        function wire() {
          const page = container.querySelector('.rsc-page');
          page.addEventListener('toggle', (event) => { if (event.target.matches('.rsc-advanced')) advancedOpen = event.target.open; }, true);
          page.addEventListener('click', (event) => {
            const day = event.target.closest('[data-day]'); if (day) { const id = day.dataset.day; days.has(id) ? days.delete(id) : days.add(id); dailyHours[id].enabled = days.has(id); render(); return; }
            const duration = event.target.closest('[data-length]'); if (duration) { length = Number(duration.dataset.length); render(); return; }
            const edit = event.target.closest('[data-edit-step]'); if (edit) { activeStep = Number(edit.dataset.editStep); render(); return; }
            if (event.target.closest('[data-back]')) { if (activeStep === 0) ctx.back(); else { activeStep--; render(); } return; }
            if (event.target.closest('[data-next]')) { activeStep = 1; maxSeen = 1; render(); return; }
            if (event.target.closest('[data-finish]')) { finish(); return; }
            if (event.target.closest('[data-block-add]')) { recurringBlocks.push({ name: '', day: 'mon', start: '09:00', end: '10:00' }); advancedOpen = true; render(); return; }
            const remove = event.target.closest('[data-block-remove]'); if (remove) { recurringBlocks.splice(Number(remove.dataset.blockRemove), 1); advancedOpen = true; render(); }
          });
          page.addEventListener('change', (event) => {
            const target = event.target;
            if (target.matches('[data-global-start]')) { dayStart = target.value; return; }
            if (target.matches('[data-global-end]')) { dayEnd = target.value; return; }
            if (target.matches('[data-day-enabled]')) { const id = target.dataset.dayEnabled; dailyHours[id].enabled = target.checked; target.checked ? days.add(id) : days.delete(id); render(); return; }
            if (target.matches('[data-day-start]')) { dailyHours[target.dataset.dayStart].start = target.value; return; }
            if (target.matches('[data-day-end]')) { dailyHours[target.dataset.dayEnd].end = target.value; return; }
            if (target.matches('[data-block]')) { const [index, field] = target.dataset.block.split(':'); recurringBlocks[Number(index)][field] = target.value; }
          });
        }

        render();
      });
    }
  };
})();
