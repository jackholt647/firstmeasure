/* Staff host for the shared availability picker. All writes use authenticated APIs. */
(function(){
  if (window.FirstMateBooking) return;
  const clean = value => String(value ?? '').trim();
  const source = document.currentScript?.src || new URL('/libraries/appointment-booking/booking.js', location.href).href;
  let loading, active;
  async function ensurePicker(){
    if (window.FirstMateAvailability && window.FirstMateProjectSelector && window.FirstMateAppointmentConfiguration) return;
    await (loading ||= Promise.all([!window.FirstMateAppointmentConfiguration ? "configuration.js" : "", !window.FirstMateAvailability ? "availability.js" : "", !window.FirstMateProjectSelector ? "../project-selector/project-selector.js" : ""].filter(Boolean).map(path => new Promise((resolve, reject) => {
      const script = document.createElement('script'); const url = new URL(path, source); url.searchParams.set('v', new URL(source).searchParams.get('v') || '20261005-appointment-ranges-v1'); script.src = url.href;
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
    dialog.id='fm-booking-dialog';
    window.FirstMateAppointmentConfiguration.ensureStyle();
    dialog.innerHTML = `<div class="fm-booking-head"><h2 id="fm-booking-title">New appointment</h2><button type="button" data-close aria-label="Close appointment booking">×</button></div><form class="fm-booking-form"><div data-configuration></div><div class="fm-availability"></div><div role="status" data-status></div></form>`;
    document.body.append(dialog); dialog.showModal();
    let picker, selected, configuration, saving = false;
    const status = dialog.querySelector('[data-status]');
    const projectControl=document.createElement('details');projectControl.className='fm-ap-picker fm-ap-project';
    projectControl.innerHTML='<summary title="Optional project. Search existing projects, or leave unassigned and type an address."><span class="fm-ap-icon" aria-hidden="true">▱</span><span data-project-label>Project</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><div data-project></div></div>';
    const select = window.FirstMateProjectSelector.mount(projectControl.querySelector('[data-project]'), {orgId,projectId:options.projectId,onChange:()=>{
      eventId = `appointment_${crypto.randomUUID()}`;
      projectControl.querySelector('[data-project-label]').textContent=projectControl.querySelector('input').value||'Project';
      if(select.value)projectControl.open=false;
      configuration?.setProject(select.value);if(configuration)refresh();
    }});
    projectControl.addEventListener('toggle',()=>{if(projectControl.open)projectControl.querySelector('input')?.focus();});
    select.ready.then(()=>{projectControl.querySelector('[data-project-label]').textContent=projectControl.querySelector('input')?.value||'Project';});
    const target = dialog.querySelector('.fm-availability');
    const close = () => { if (!saving) dialog.close(); };
    dialog.querySelector('[data-close]').onclick = close;
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { picker?.destroy(); configuration?.destroy(); select.destroy(); dialog.remove(); if (active === dialog) active = null; previousFocus?.focus?.(); }, {once:true});
    const refresh = () => {
      const previousDate=picker?.value?.date;
      const date=previousDate||target.querySelector('[data-date][aria-pressed=true]')?.dataset.date||options.date;
      picker?.destroy(); selected = null; status.textContent = '';
      const dayMode=configuration.value.timing_mode==='days';
      target.innerHTML = dayMode?window.FirstMateAvailability.rangeMarkup():window.FirstMateAvailability.markup({submitLabel:'Book appointment'});
      const submit = target.querySelector('[type=submit]'); submit.disabled = true;
      picker = window.FirstMateAvailability[dayMode?'mountRange':'mount'](target, {
        days:configuration.value.duration_days,
        unavailableMessage:configuration.availabilityHint,
        onDurationChange:days=>{configuration.setDuration(days,false);eventId=`appointment_${crypto.randomUUID()}`;},
        date,
        loadAvailability: (date,days) => api.appointments.preview(orgId, {...(select.value ? {project_id:select.value} : {}), date, configuration:{...configuration.value,...(dayMode?{duration_days:days}:{})}}),
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
      configuration = await window.FirstMateAppointmentConfiguration.mount(dialog.querySelector('[data-configuration]'), {orgId,projectControl,projectId:options.projectId,onChange:()=>{eventId=`appointment_${crypto.randomUUID()}`;refresh();}});
      if(!dialog.isConnected){configuration.destroy();return;}
      select.setDisabled(!!options.lockProject);
      refresh();
    } catch(error){status.textContent=error.message||'Could not load appointment settings.';}
    return dialog;
  }
  window.FirstMateBooking = {open};
})();
