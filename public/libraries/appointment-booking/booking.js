/* Staff host for the shared availability picker. All writes use authenticated APIs.
   Phones get a stepped flow (type → project or address → time); wider screens keep one form. */
(function(){
  if (window.FirstMateBooking) return;
  const clean = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const source = document.currentScript?.src || new URL('/libraries/appointment-booking/booking.js', location.href).href;
  const STEP_LABELS = {type:'Type', project:'Project', when:'Time'};
  let loading, active;
  async function ensurePicker(){
    if (window.FirstMateAvailability && window.FirstMateProjectSelector && window.FirstMateAppointmentConfiguration) return;
    await (loading ||= Promise.all([!window.FirstMateAppointmentConfiguration ? "configuration.js" : "", !window.FirstMateAvailability ? "availability.js" : "", !window.FirstMateProjectSelector ? "../project-selector/project-selector.js" : ""].filter(Boolean).map(path => new Promise((resolve, reject) => {
      const script = document.createElement('script'); const url = new URL(path, source); url.searchParams.set('v', new URL(source).searchParams.get('v') || '20261005-appointment-picker-v1'); script.src = url.href;
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
    const stepped = options.steps ?? !!window.matchMedia?.('(max-width:720px)').matches;
    dialog.addEventListener('close', () => { dialog.remove(); if (active === dialog) active = null; previousFocus?.focus?.(); }, {once:true});
    return (stepped ? openSteps : openForm)(dialog, {api, orgId, options});
  }

  /* One form: wide screens. */
  async function openForm(dialog, {api, orgId, options}){
    dialog.innerHTML = `<div class="fm-booking-head"><h2 id="fm-booking-title">New appointment</h2><button type="button" data-close aria-label="Close appointment booking">×</button></div><form class="fm-booking-form"><div data-configuration></div><div class="fm-availability"></div><div role="status" data-status></div></form>`;
    document.body.append(dialog); dialog.showModal();
    let picker, selected, configuration, saving = false;
    const status = dialog.querySelector('[data-status]');
    const projectControl=document.createElement('details');projectControl.className='fm-ap-picker fm-ap-project';
    projectControl.innerHTML='<summary title="Optional project. Search existing projects, or leave unassigned and type an address."><span class="fm-ap-icon" aria-hidden="true">▱</span><span data-project-label>Project</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><div data-project></div></div>';
    const select = window.FirstMateProjectSelector.mount(projectControl.querySelector('[data-project]'), {orgId,projectId:options.projectId,onChange:()=>{
      eventId = `appointment_${crypto.randomUUID()}`;
      projectControl.querySelector('[data-project-label]').textContent=projectControl.querySelector('input').value||'Project';

      configuration?.setProject(select.value);if(configuration)refresh();
    },onSelect:()=>{projectControl.open=false;projectControl.querySelector('summary').focus();}});
    projectControl.addEventListener('toggle',()=>{if(projectControl.open)projectControl.querySelector('input')?.focus();});
    select.ready.then(()=>{projectControl.querySelector('[data-project-label]').textContent=projectControl.querySelector('input')?.value||'Project';});
    const target = dialog.querySelector('.fm-availability');
    const close = () => { if (!saving) dialog.close(); };
    dialog.querySelector('[data-close]').onclick = close;
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { picker?.destroy(); configuration?.destroy(); select.destroy(); }, {once:true});
    const refresh = () => {
      const previousDate=picker?.value?.date;
      const date=previousDate||target.querySelector('[data-date][aria-pressed=true]')?.dataset.date||options.date;
      picker?.destroy(); selected = null; status.textContent = '';
      const dayMode=configuration.value.timing_mode==='days';
      target.innerHTML = dayMode?window.FirstMateAvailability.rangeMarkup({submitLabel:'Create event'}):window.FirstMateAvailability.markup({submitLabel:'Create event'});
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
      status.textContent = 'Creating event…';
      try {
        await api.appointments.book(orgId, {...(select.value ? {project_id:select.value} : {}), start_at:selected.start_at || selected.start, event_id:eventId, configuration:configuration.value});
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        options.onBooked?.();
        picker?.destroy(); target.innerHTML = '<p role="status">Event created.</p>';
        status.textContent = ''; select.setDisabled(true);
      } catch (error) {
        status.textContent = error.message || 'Could not create this event.';
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

  /* Phone steps: what kind → which project or address → when. Rarely used settings live in the Advanced sheet. */
  async function openSteps(dialog, {api, orgId, options}){
    const lockedProject = options.lockProject && options.projectId ? options.projectId : '';
    const order = lockedProject ? ['type','when'] : ['type','project','when'];
    dialog.classList.add('fm-booking-steps');
    dialog.innerHTML = `<div class="fm-booking-head"><h2 id="fm-booking-title">New appointment</h2><button type="button" class="fm-booking-advanced" data-advanced-open aria-haspopup="dialog" aria-controls="fm-booking-sheet" aria-expanded="false"><span class="fm-booking-sliders" aria-hidden="true"><i></i><i></i><i></i></span>Advanced</button><button type="button" data-close aria-label="Close appointment booking">×</button></div>
<ol class="fm-booking-progress" aria-label="Steps">${order.map(step=>`<li data-progress="${step}"><button type="button" data-goto="${step}"><span>${STEP_LABELS[step]}</span></button></li>`).join('')}</ol>
<form class="fm-booking-form" novalidate>
<div class="fm-booking-stage" data-stage>
<section class="fm-booking-step" data-step="type" aria-labelledby="fm-booking-step-type"><h3 id="fm-booking-step-type" tabindex="-1">What kind of appointment?</h3><div data-slot-type></div></section>
${lockedProject ? '' : `<section class="fm-booking-step" data-step="project" aria-labelledby="fm-booking-step-project" hidden><h3 id="fm-booking-step-project" tabindex="-1">Which project?</h3><p class="fm-booking-hint">Search by name, or type the address to find it.</p><div data-project></div></section>`}
<section class="fm-booking-step" data-step="when" aria-labelledby="fm-booking-step-when" hidden><h3 id="fm-booking-step-when" tabindex="-1">When?</h3><div class="fm-booking-summary" data-summary></div><div data-slot-quick></div><div class="fm-availability"></div></section>
<section class="fm-booking-step fm-booking-done" data-step="done" hidden><div class="fm-booking-check" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg></div><h3 tabindex="-1">Event created</h3><p data-done-summary></p></section>
</div>
<div role="status" data-status></div>
<footer class="fm-booking-footer"><button type="button" class="fm-booking-nav" data-prev><span class="fm-booking-arrow back" aria-hidden="true"></span><span>Previous</span></button><button type="button" class="fm-booking-nav primary" data-next><span>Next</span><span class="fm-booking-arrow" aria-hidden="true"></span></button><button type="submit" class="fm-booking-nav primary" data-create hidden disabled>Create event</button><button type="button" class="fm-booking-nav primary" data-finish hidden>Done</button></footer>
</form>
<div class="fm-booking-scrim" data-sheet-scrim hidden></div>
<section class="fm-booking-sheet" id="fm-booking-sheet" role="dialog" aria-modal="true" aria-labelledby="fm-booking-sheet-title" hidden><div class="fm-booking-sheet-grip" aria-hidden="true"></div><div class="fm-booking-sheet-head"><h3 id="fm-booking-sheet-title" tabindex="-1">Advanced</h3><button type="button" data-sheet-done>Done</button></div><div class="fm-booking-sheet-body" data-slot-advanced></div></section>`;
    document.body.append(dialog); dialog.showModal();
    const $ = selector => dialog.querySelector(selector);
    $('[data-step="type"] h3').focus({preventScroll:true});
    const stage = $('[data-stage]'), status = $('[data-status]'), target = $('.fm-availability'), sheet = $('#fm-booking-sheet'), scrim = $('[data-sheet-scrim]');
    const prev = $('[data-prev]'), next = $('[data-next]'), create = $('[data-create]'), finish = $('[data-finish]'), advancedButton = $('[data-advanced-open]');
    const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let step = 'type', picker, selected = null, configuration, select = null, saving = false, done = false, stale = true;
    let addressOverride = null, sheetAdvances = false, advanceTimer, sheetTimer;
    let eventId = `appointment_${crypto.randomUUID()}`;
    const visited = new Set(['type']);
    const newEvent = () => { eventId = `appointment_${crypto.randomUUID()}`; };
    const projectId = () => lockedProject || select?.value || '';

    function summary(){
      if (!configuration) return '';
      const type = configuration.presetLabel || 'Custom';
      const where = projectId() ? (lockedProject ? configuration.project.title : clean(select?.input?.value)) || 'Project' : addressOverride ? configuration.value.location.address : 'No project';
      const chip = (goto, icon, text) => goto ? `<button type="button" class="fm-booking-chip" data-goto="${goto}"><span aria-hidden="true">${icon}</span><span>${esc(text)}</span></button>` : `<span class="fm-booking-chip"><span aria-hidden="true">${icon}</span><span>${esc(text)}</span></span>`;
      return chip('type', '◆', type) + chip(lockedProject ? '' : 'project', projectId() ? '▱' : '⌖', where);
    }
    function sync(){
      const index = order.indexOf(step);
      prev.style.visibility = index > 0 && !done ? '' : 'hidden';
      prev.disabled = saving;
      next.hidden = done || step === 'when';
      create.hidden = done || step !== 'when';
      create.disabled = !selected || saving;
      finish.hidden = !done;
      advancedButton.hidden = done;
      dialog.querySelector('.fm-booking-progress').hidden = done;
      dialog.style.setProperty('--fm-booking-progress', String(order.length > 1 ? Math.max(0, index) / (order.length - 1) : 1));
      dialog.querySelectorAll('[data-progress]').forEach(item => {
        const position = order.indexOf(item.dataset.progress);
        item.dataset.state = position < index ? 'done' : position === index ? 'current' : 'todo';
        const button = item.querySelector('button');
        if (position === index) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
        button.disabled = saving || !visited.has(item.dataset.progress) || position === index;
      });
      if (step === 'when') $('[data-summary]').innerHTML = summary();
    }
    function go(name, {focus = true} = {}){
      clearTimeout(advanceTimer);
      if (name === step || saving) return;
      const from = $(`[data-step="${step}"]`), to = $(`[data-step="${name}"]`);
      if (!to) return;
      const forward = name === 'done' || order.indexOf(name) > order.indexOf(step);
      step = name; visited.add(name);
      if (reduceMotion()) from.hidden = true;
      else {
        from.classList.remove('fm-step-in-forward', 'fm-step-in-back');
        from.classList.add('fm-step-leaving', forward ? 'fm-step-out-forward' : 'fm-step-out-back'); from.inert = true;
        setTimeout(() => { from.classList.remove('fm-step-leaving', 'fm-step-out-forward', 'fm-step-out-back'); from.inert = false; if (from.dataset.step !== step) from.hidden = true; }, 260);
      }
      to.hidden = false; to.inert = false; to.classList.remove('fm-step-leaving', 'fm-step-out-forward', 'fm-step-out-back', 'fm-step-in-forward', 'fm-step-in-back');
      if (!reduceMotion()) { void to.offsetWidth; to.classList.add(forward ? 'fm-step-in-forward' : 'fm-step-in-back'); }
      stage.scrollTop = 0;
      status.textContent = '';
      sync();
      if (name === 'when' && stale) refresh();
      if (!focus) return;
      if (name === 'project' && !select?.value) select?.input?.focus({preventScroll:true});
      else to.querySelector('h3')?.focus({preventScroll:true});
    }
    const goNext = () => { const following = order[order.indexOf(step) + 1]; if (following) go(following); };
    const goPrev = () => { const preceding = order[order.indexOf(step) - 1]; if (preceding) go(preceding); };
    const advanceFromType = () => { if (step !== 'type') return; clearTimeout(advanceTimer); advanceTimer = setTimeout(goNext, reduceMotion() ? 0 : 200); };

    function openSheet({saveType = false} = {}){
      if (!configuration || done) return;
      clearTimeout(sheetTimer);
      scrim.hidden = false; sheet.hidden = false; advancedButton.setAttribute('aria-expanded', 'true');
      $('form').inert = true; $('.fm-booking-head').inert = true;
      requestAnimationFrame(() => { scrim.classList.add('open'); sheet.classList.add('open'); });
      const field = saveType ? sheet.querySelector('[data-type-name]') : null;
      if (field) { field.closest('[data-save-type-section]')?.classList.add('fm-ap-highlight'); field.scrollIntoView({block:'center'}); field.focus({preventScroll:true}); }
      else { sheet.querySelector('.fm-booking-sheet-body').scrollTop = 0; $('#fm-booking-sheet-title').focus({preventScroll:true}); }
    }
    function closeSheet(){
      if (sheet.hidden) return;
      scrim.classList.remove('open'); sheet.classList.remove('open'); advancedButton.setAttribute('aria-expanded', 'false');
      $('form').inert = false; $('.fm-booking-head').inert = false;
      sheet.querySelector('.fm-ap-highlight')?.classList.remove('fm-ap-highlight');
      sheetTimer = setTimeout(() => { scrim.hidden = true; sheet.hidden = true; }, reduceMotion() ? 0 : 280);
      if (sheetAdvances) { sheetAdvances = false; advanceFromType(); }
      else advancedButton.focus({preventScroll:true});
    }

    function refresh(){
      if (!configuration) return;
      if (step !== 'when') { stale = true; return; }
      stale = false;
      const date = picker?.value?.date || target.querySelector('[data-date][aria-pressed=true]')?.dataset.date || options.date;
      picker?.destroy(); selected = null; sync();
      const dayMode = configuration.value.timing_mode === 'days';
      target.innerHTML = dayMode ? window.FirstMateAvailability.rangeMarkup({submitLabel:''}) : window.FirstMateAvailability.markup({submitLabel:''});
      picker = window.FirstMateAvailability[dayMode ? 'mountRange' : 'mount'](target, {
        days:configuration.value.duration_days,
        unavailableMessage:configuration.availabilityHint,
        onDurationChange:days => { configuration.setDuration(days, false); newEvent(); },
        date,
        loadAvailability:(date, days) => api.appointments.preview(orgId, {...(projectId() ? {project_id:projectId()} : {}), date, configuration:{...configuration.value, ...(dayMode ? {duration_days:days} : {})}}),
        onChange:slot => { selected = slot; sync(); }
      });
    }
    function changed(){ newEvent(); stale = true; if (step === 'when') refresh(); else sync(); }
    function useAddress(address){
      addressOverride ||= {before:configuration.value.location};
      configuration.setLocation({mode:'custom', address}, false);
      changed(); go('when');
    }

    const close = () => { if (!saving) dialog.close(); };
    $('[data-close]').onclick = close;
    finish.onclick = close;
    prev.onclick = goPrev;
    next.onclick = goNext;
    advancedButton.onclick = () => openSheet();
    $('[data-sheet-done]').onclick = closeSheet;
    scrim.onclick = closeSheet;
    dialog.addEventListener('click', event => { const goto = event.target.closest('[data-goto]'); if (goto && !goto.disabled) go(goto.dataset.goto); });
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); else if (!sheet.hidden) { event.preventDefault(); closeSheet(); } });
    dialog.addEventListener('close', () => { clearTimeout(advanceTimer); clearTimeout(sheetTimer); picker?.destroy(); configuration?.destroy(); select?.destroy(); }, {once:true});

    if (!lockedProject) {
      select = window.FirstMateProjectSelector.mount($('[data-project]'), {orgId, projectId:options.projectId, inline:true,
        extraRows:query => query.length >= 4 && configuration ? [{title:`Use “${query}”`, subtitle:'Just the address — link a project later', onSelect:() => useAddress(query)}] : [],
        onChange:value => {
          if (!configuration) return;
          if (addressOverride) { configuration.setLocation(addressOverride.before, false); addressOverride = null; }
          configuration.setProject(value); changed();
        },
        onSelect:() => go('when')});
    }

    $('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (step !== 'when' || saving || !selected) return;
      saving = true; select?.setDisabled(true); stage.inert = true; advancedButton.disabled = true; sync();
      status.textContent = 'Creating event…';
      try {
        await api.appointments.book(orgId, {...(projectId() ? {project_id:projectId()} : {}), start_at:selected.start_at || selected.start, event_id:eventId, configuration:configuration.value});
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        options.onBooked?.();
        const when = new Date(selected.start_at || selected.start);
        const day = Number.isFinite(when.getTime()) ? when.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'}) : '';
        $('[data-done-summary]').textContent = [configuration.value.title, day, configuration.value.timing_mode === 'days' ? '' : selected.label].filter(Boolean).join(' · ');
        saving = false; stage.inert = false; done = true; status.textContent = '';
        picker?.destroy(); picker = null;
        go('done');
        finish.focus({preventScroll:true});
      } catch (error) {
        saving = false; stage.inert = false; advancedButton.disabled = false; select?.setDisabled(false);
        status.textContent = error.message || 'Could not create this event.';
        picker?.refresh(); sync();
      }
    });

    sync();
    try {
      configuration = await window.FirstMateAppointmentConfiguration.mount(null, {orgId, projectId:lockedProject || options.projectId,
        slots:{type:$('[data-slot-type]'), quick:$('[data-slot-quick]'), advanced:$('[data-slot-advanced]')},
        onChange:changed,
        onPreset:(id, info = {}) => {
          if (info.newType) { sheetAdvances = false; openSheet({saveType:true}); return; }
          if (info.saved) { sheetAdvances = false; closeSheet(); advanceFromType(); return; }
          if (!id) { sheetAdvances = step === 'type'; openSheet(); return; }
          advanceFromType();
        }});
      if (!dialog.isConnected) { configuration.destroy(); return; }
      sync();
    } catch (error) { status.textContent = error.message || 'Could not load appointment settings.'; }
    return dialog;
  }
  window.FirstMateBooking = {open};
})();
