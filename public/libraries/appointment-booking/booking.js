/* Staff host for the shared availability picker. All writes use authenticated APIs. */
(function(){
  if (window.FirstMateBooking) return;
  const clean = value => String(value ?? '').trim();
  const source = document.currentScript?.src || new URL('/libraries/appointment-booking/booking.js', location.href).href;
  let loading, active;
  async function ensurePicker(){
    if (window.FirstMateAvailability && window.FirstMateProjectSelector && window.FirstMateAppointmentConfiguration) return;
    await (loading ||= Promise.all([!window.FirstMateAppointmentConfiguration ? "configuration.js" : "", !window.FirstMateAvailability ? "availability.js" : "", !window.FirstMateProjectSelector ? "../project-selector/project-selector.js" : ""].filter(Boolean).map(path => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = new URL(path, source).href;
      script.onload = resolve;
      script.onerror = () => { loading = null; script.remove(); reject(new Error('Could not load the appointment calendar.')); };
      document.head.append(script);
    }))));
  }
  async function open(options = {}){
    if (active?.isConnected) { active.focus(); return; }
    await ensurePicker();
    if (active?.isConnected) return;
    const api = window.PlatformAPI;
    const orgId = clean(options.orgId || window.Portal?.cfg?.userOrgId || window.__APP?.userOrgId);
    if (!orgId || !api?.appointments?.book) throw new Error('Appointment booking is unavailable in this session.');
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog'); active = dialog;
    dialog.setAttribute('aria-labelledby', 'fm-booking-title');
    dialog.style.cssText = 'box-sizing:border-box;font-family:Montserrat,Arial,sans-serif;width:min(900px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid #ddd;border-radius:14px;background:white;color:#111827;box-shadow:0 24px 80px #0004;';
    dialog.innerHTML = `<style>dialog::backdrop{background:#11182788}.fm-booking-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.fm-booking-head h2{margin:0;font-size:22px}.fm-booking-head button{border:0;background:transparent;font-size:24px;cursor:pointer}.fm-booking-form{display:grid;gap:18px;margin-top:20px}.fm-booking-form label{display:grid;gap:8px;font-weight:700}.fm-booking-form select{padding:10px;width:100%;font:inherit;border:1px solid #ccc;border-radius:8px}.fm-booking-form [role=status]{font-size:14px}</style>
      <div class="fm-booking-head"><h2 id="fm-booking-title">New appointment</h2><button type="button" data-close aria-label="Close appointment booking">×</button></div>
      <form class="fm-booking-form"><div><div style="font-weight:700;margin-bottom:8px">Project or lead <span style="font-weight:400">(optional)</span></div><div data-project></div><small>You can book now and assign a project later.</small></div><div data-configuration></div><div class="fm-availability"></div><div role="status" data-status></div></form>`;
    document.body.append(dialog); dialog.showModal();
    let picker, selected, configuration, saving = false;
    const status = dialog.querySelector('[data-status]');
    const select = window.FirstMateProjectSelector.mount(dialog.querySelector('[data-project]'), {orgId,projectId:options.projectId,onChange:()=>{eventId = `appointment_${crypto.randomUUID()}`;refresh();}});
    const target = dialog.querySelector('.fm-availability');
    const close = () => { if (!saving) dialog.close(); };
    dialog.querySelector('[data-close]').onclick = close;
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { picker?.destroy(); configuration?.destroy(); select.destroy(); dialog.remove(); if (active === dialog) active = null; previousFocus?.focus?.(); }, {once:true});
    const refresh = () => {
      picker?.destroy(); selected = null; status.textContent = '';
      target.innerHTML = window.FirstMateAvailability.markup({submitLabel:'Book appointment'});
      const submit = target.querySelector('[type=submit]'); submit.disabled = true;
      picker = window.FirstMateAvailability.mount(target, {
        date:options.date,
        loadAvailability: date => api.appointments.preview(orgId, {...(select.value ? {project_id:select.value} : {}), date, configuration:configuration.value}),
        onChange: slot => { selected = slot; submit.disabled = !slot || saving; }
      });
    };
    let eventId = `appointment_${crypto.randomUUID()}`;
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); if (saving || !selected) return;
      saving = true; select.setDisabled(true); dialog.querySelector('[data-configuration]').inert = true;
      target.inert = true; target.querySelector('[type=submit]').disabled = true;
      status.textContent = 'Booking appointment…';
      try {
        await api.appointments.book(orgId, {...(select.value ? {project_id:select.value} : {}), start_at:selected.start_at || selected.start, event_id:eventId, configuration:configuration.value});
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        options.onBooked?.();
        picker?.destroy(); target.innerHTML = '<p role="status">Appointment booked.</p>';
        status.textContent = ''; select.setDisabled(true);
      } catch (error) {
        status.textContent = error.message || 'Could not book this appointment.';
        select.setDisabled(!!options.lockProject); dialog.querySelector('[data-configuration]').inert = false;
        picker?.refresh();
      } finally { saving = false; target.inert = false; }
    });
    try {
      configuration = await window.FirstMateAppointmentConfiguration.mount(dialog.querySelector('[data-configuration]'), {orgId,onChange:()=>{eventId=`appointment_${crypto.randomUUID()}`;refresh();}});
      if(!dialog.isConnected){configuration.destroy();return;}
      select.setDisabled(!!options.lockProject);
      refresh();
    } catch(error){status.textContent=error.message||'Could not load appointment settings.';}
    return dialog;
  }
  window.FirstMateBooking = {open};
})();
