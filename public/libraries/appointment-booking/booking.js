/* Staff host for the shared availability picker. All writes use authenticated APIs.
   Phones get a stepped flow (type → project or address → time); wider screens keep one form. */
(function(){
  if (window.FirstMateBooking) return;
  const clean = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const source = document.currentScript?.src || new URL('/libraries/appointment-booking/booking.js', location.href).href;
  const STEP_LABELS = {type:'Type', project:'Project', when:'Time'};
  /* The device's zone: the server books in it when the organization has none of its own (FM-504). */
  const deviceTimezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
  const zoned = body => { const timezone = deviceTimezone(); return timezone ? {...body, timezone} : body; };
  /* What was booked, one fact per line under the step names (FM-503). */
  function createdDetails(configuration, slot, where){
    const when = new Date(slot?.start_at || slot?.start);
    const day = Number.isFinite(when.getTime()) ? when.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'}) : '';
    const type = configuration.presetLabel || 'Custom', title = clean(configuration.value.title);
    const row = (label, ...values) => (values = values.map(clean).filter(Boolean)).length ? `<div><dt>${esc(label)}</dt><dd>${values.map(value => `<span>${esc(value)}</span>`).join('')}</dd></div>` : '';
    return `${title && title !== clean(where) && title !== type ? `<p class="fm-booking-created-title">${esc(title)}</p>` : ''}<dl class="fm-booking-created-details">${row(STEP_LABELS.type, type)}${row(STEP_LABELS.project, where)}${row(STEP_LABELS.when, day, configuration.value.timing_mode === 'days' ? '' : slot?.label)}</dl>`;
  }
  /* The New project step's fields. Name and phone share a row with email under them, as in the project's details tray (FM-557). */
  const newField = (key, label, type, placeholder) => `<label class="fm-booking-field"><span>${label}</span><input type="${type}" data-new-field="${key}" autocomplete="off"${type === 'tel' ? ' inputmode="tel"' : type === 'email' ? ' inputmode="email" autocapitalize="off" spellcheck="false"' : ''} placeholder="${placeholder}" enterkeyhint="next"></label>`;
  const addressParts = components => {
    const out = {street_number:'', route:'', city:'', state:'', state_short:'', zip:'', country:''};
    for (const item of components || []) {
      const types = item.types || [];
      if (types.includes('street_number')) out.street_number = item.long_name;
      if (types.includes('route')) out.route = item.long_name;
      if (types.includes('locality')) out.city = item.long_name;
      if (types.includes('administrative_area_level_1')) { out.state = item.long_name; out.state_short = item.short_name; }
      if (types.includes('postal_code')) out.zip = item.long_name;
      if (types.includes('country')) out.country = item.short_name;
    }
    return out;
  };
  /* Google's own address suggestions on a field inside a modal dialog. The portal page loads Places; Google puts its list
     (.pac-container) on the page body, under the dialog's top layer, so this field's list moves into the dialog and sits
     under the field. onPlace gets the chosen place. */
  function placesAutocomplete(dialog, input, onPlace){
    let autocomplete = null, list = null, timer = 0, attempts = 0, disposed = false, watcher = null;
    const place = () => {
      if (!list) return;
      const field = input.getBoundingClientRect(), box = dialog.getBoundingClientRect();
      list.style.setProperty('--fm-pac-top', `${Math.round(field.bottom - box.top - dialog.clientTop + 4)}px`);
      list.style.setProperty('--fm-pac-left', `${Math.round(field.left - box.left - dialog.clientLeft)}px`);
      list.style.setProperty('--fm-pac-width', `${Math.round(field.width)}px`);
    };
    const adopt = node => { list = node; list.classList.add('fm-booking-places'); dialog.append(list); place(); watcher?.disconnect(); watcher = null; };
    function start(){
      if (autocomplete || disposed || !dialog.isConnected) return;
      const Autocomplete = window.google?.maps?.places?.Autocomplete;
      if (!Autocomplete) { if (attempts++ < 40) timer = setTimeout(start, 150); return; }
      const before = new Set(document.querySelectorAll('.pac-container'));
      autocomplete = new Autocomplete(input, {fields:['formatted_address', 'geometry', 'address_components'], strictBounds:false});
      autocomplete.addListener('place_changed', () => {
        const chosen = autocomplete.getPlace() || {};
        if (!chosen.formatted_address) return;
        const location = chosen.geometry?.location;
        input.value = chosen.formatted_address;
        onPlace({address:chosen.formatted_address, ...(location ? {lat:location.lat(), lng:location.lng()} : {}), address_components:addressParts(chosen.address_components)});
      });
      const added = [...document.querySelectorAll('.pac-container')].find(node => !before.has(node));
      if (added) adopt(added);
      else {
        watcher = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains('pac-container') && !before.has(node)) return adopt(node); });
        watcher.observe(document.body, {childList:true});
      }
    }
    input.addEventListener('focus', start);
    input.addEventListener('input', place);
    const follow = () => requestAnimationFrame(place);
    dialog.addEventListener('scroll', follow, true); window.visualViewport?.addEventListener('resize', follow); window.addEventListener('resize', follow);
    return {
      /* The list is showing: Enter picks a suggestion rather than moving on. */
      get open(){ return !!list && list.style.display !== 'none' && !!list.querySelector('.pac-item'); },
      destroy(){
        disposed = true; clearTimeout(timer); watcher?.disconnect();
        dialog.removeEventListener('scroll', follow, true); window.visualViewport?.removeEventListener('resize', follow); window.removeEventListener('resize', follow);
        if (autocomplete) window.google?.maps?.event?.clearInstanceListeners?.(autocomplete);
        list?.remove();
      }
    };
  }
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
    workforceAnswer = readWorkforce(api, orgId);
    dialog.addEventListener('close', () => { dialog.remove(); if (active === dialog) active = null; previousFocus?.focus?.(); }, {once:true});
    return (stepped ? openSteps : openForm)(dialog, {api, orgId, options});
  }

  /*
   * Who can go (GP-85). The times are the same whether or not anyone is set up: a type nobody can staff yet (no crews or
   * subcontractors, no one of its department) is booked unassigned, and a note above the times says so, with a Setup
   * pill that plays the workforce setup where it can play (the dialog closes for it and opens again after). The preview
   * says which requirements nobody can meet (`staffing[].unstaffed`) and how many crews and outside companies exist.
   * GP-144: a sales type with nobody to go (no one in its Sales department, `sales_department_ids`) offers the
   * salesperson setup (`sales.team.setup`) the same way, and so does the type step's Add users.
   */
  const guides = () => window.FirstMateGuides || (() => { try { return window.top?.FirstMateGuides; } catch (_) { return null; } })();
  /*
   * Who does the company's work (GP-143): the company profile's `workforce` answer, read once each time the dialog opens.
   * A company that does the work itself ("just me") is never told about crews or subcontractors: nobody is assigned.
   */
  let workforceAnswer = Promise.resolve('');
  function readWorkforce(api, orgId){
    if (!api?.publication?.read) return Promise.resolve('');
    return Promise.resolve(api.publication.read(orgId, { provider:'company-profile', export:'profile', target:{ scope:'organization', organizationId:orgId } }))
      .then((result) => { const read = result?.result ?? result; return clean((read?.value ?? read)?.workforce); }).catch(() => '');
  }
  // Crews and subcontractors are set up with the Operations workforce setup, which starts at how many there are when who
  // does the work is answered (a phone tray, a modal on a wider screen); Scheduling's own Crew settings are not it.
  const workforceSetup = () => guides()?.experience?.('operations.workforce.setup') ? 'operations.workforce.setup' : '';
  const term = (path, fallback) => clean(window.PlatformTerminology?.get?.(path, fallback) || window.Portal?.terminology?.get?.(path, fallback)) || fallback;
  /** The setup that adds who a type needs, where it can play (a function that plays it), or null. */
  function staffSetup(need){
    if (need === 'sales') return guides()?.experience?.('sales.team.setup') ? () => guides().play('sales.team.setup', { replay: true, force: true }) : null;
    if (need !== 'teams') return null;
    // The workforce setup where it can play: Scheduling plays it through its own hook, which reloads the schedule after.
    const setupId = workforceSetup();
    return !setupId ? null : typeof window.FirstMateTeamsSetup === 'function' ? window.FirstMateTeamsSetup : () => guides().play(setupId, { replay: true, force: true });
  }
  /** Closes the dialog, plays the setup, and opens the dialog again for the booking once it is over (book again with whoever it added). */
  async function runStaffSetup(dialog, options, setup){
    // Gone before the setup opens (its close takes its history entries off), so it can open again after.
    await new Promise((resolve) => { dialog.addEventListener('close', resolve, { once:true }); dialog.close(); });
    await Promise.resolve(setup()).catch(() => null);
    open(options).catch(() => {});
  }
  /** The type step's Add users (configuration.js): which setup a type nobody can go to needs. */
  const typeSetup = (entry) => staffSetup(entry?.sales ? 'sales' : entry?.teams ? 'teams' : '');
  function staffingNote(target, configuration, {dialog, options}){
    let shown = '', workforce = null;
    const draw = (data) => {
      const host = target.querySelector('.fmle-time-panel [data-selected-day]') || target.querySelector('.fm-range-head');
      if (!host) return;
      const config = configuration.value, staffing = Array.isArray(data?.staffing) ? data.staffing : [], teams = data?.teams || {};
      const gaps = staffing.filter((entry) => entry.unstaffed);
      const noTeams = !Number(teams.groups) && !Number(teams.companies);
      // A type that sends crews, or one that leaves who goes to whoever books it (a subcontractor), in a company with none.
      const groups = gaps.some((entry) => entry.subject_type !== 'organization_user') || (noTeams && !config.requirements.length && config.requires_project === true && config.event_type_id !== 'sales_appointment');
      const people = !groups && gaps.some((entry) => entry.subject_type === 'organization_user');
      // A person of a Sales department (or for a sales appointment): a salesperson (GP-144).
      const salesIds = Array.isArray(data?.sales_department_ids) ? data.sales_department_ids : [];
      const sales = people && gaps.some((entry) => entry.subject_type === 'organization_user' && (config.event_type_id === 'sales_appointment' || salesIds.includes(entry.department_id)));
      // A company with no crews or subcontractors at all is told they are not added yet, not that none is free (GP-142).
      const key = groups ? (workforce === 'just_me' ? '' : noTeams ? 'none' : 'groups') : sales ? 'sales' : people ? 'people' : '';
      if (key === shown && (!key || target.querySelector('[data-staffing-note]'))) return;
      shown = key;
      target.querySelector('[data-staffing-note]')?.remove();
      if (!key) return;
      const crews = term('workforce.resource_group_plural', 'Crews'), subs = term('workforce.organization_connection_plural', 'Subcontractors');
      const text = key === 'none' ? `No ${crews.toLowerCase()} or ${subs.toLowerCase()} yet` : groups ? `No ${crews.toLowerCase()} or ${subs.toLowerCase()} available` : 'No one is set up to go to these yet';
      const blurb = key === 'none' ? 'Appointment will be unassigned until you add them.' : key === 'sales' ? 'It is booked unassigned. Set up your salespeople, or assign someone later from the calendar.' : 'It is booked unassigned. Assign someone later from the calendar.';
      const setup = staffSetup(groups ? 'teams' : sales ? 'sales' : '');
      const note = document.createElement('div');
      note.className = 'fm-booking-staffing'; note.dataset.staffingNote = key; note.setAttribute('role', 'note');
      note.innerHTML = `<span><strong>${esc(text)}</strong><small>${esc(blurb)}</small></span>${setup ? `<button type="button" class="fm-booking-staffing-setup" data-staffing-setup><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${esc('Set up')}</button>` : ''}`;
      host.after(note);
      note.querySelector('[data-staffing-setup]')?.addEventListener('click', () => runStaffSetup(dialog, options, setup));
    };
    // The note waits for who does the work, so a company that does it itself never sees it come and go.
    let latest = null;
    return (data) => {
      latest = data;
      if (workforce !== null) { draw(data); return; }
      workforceAnswer.then((answer) => { workforce = answer; if (latest === data && dialog.isConnected) draw(data); });
    };
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
        showFree:true, onSlots:staffingNote(target, configuration, {dialog, options}),
        onDurationChange:days=>{configuration.setDuration(days,false);eventId=`appointment_${crypto.randomUUID()}`;},
        date,
        loadAvailability: (date,days) => api.appointments.preview(orgId, zoned({...(select.value ? {project_id:select.value} : {}), date, configuration:{...configuration.value,...(dayMode?{duration_days:days}:{})}})),
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
        await api.appointments.book(orgId, zoned({...(select.value ? {project_id:select.value} : {}), start_at:selected.start_at || selected.start, event_id:eventId, configuration:configuration.value}));
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        options.onBooked?.();
        const where = select.value ? clean(projectControl.querySelector('input')?.value) || configuration.project.title : configuration.value.location?.address;
        const details = createdDetails(configuration, selected, where);
        picker?.destroy(); target.innerHTML = `<div class="fm-booking-created fm-booking-created-inline"><p role="status">Event created.</p>${details}</div>`;
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

  /* Phone steps: what kind → which project or address → when. Rarely used settings live in the Advanced sheet.
     A booking names a project, a new one (its own step, every field optional; FM-556), an address, or No project on purpose. */
  async function openSteps(dialog, {api, orgId, options}){
    const lockedProject = options.lockProject && options.projectId ? options.projectId : '';
    const order = lockedProject ? ['type','when'] : ['type','project','when'];
    dialog.classList.add('fm-booking-steps');
    dialog.innerHTML = `<div class="fm-booking-head"><h2 id="fm-booking-title">New appointment</h2><button type="button" class="fm-booking-advanced" data-advanced-open aria-haspopup="dialog" aria-controls="fm-booking-sheet" aria-expanded="false"><span class="fm-booking-sliders" aria-hidden="true"><i></i><i></i><i></i></span>Advanced</button><button type="button" data-close aria-label="Close appointment booking">×</button></div>
<ol class="fm-booking-progress" aria-label="Steps">${order.map(step=>`<li data-progress="${step}"><button type="button" data-goto="${step}"><span>${STEP_LABELS[step]}</span></button></li>`).join('')}</ol>
<form class="fm-booking-form" novalidate>
<div class="fm-booking-stage" data-stage>
<section class="fm-booking-step" data-step="type" aria-labelledby="fm-booking-step-type"><h3 id="fm-booking-step-type" tabindex="-1">What kind of appointment?</h3><div data-slot-type></div></section>
${lockedProject ? '' : `<section class="fm-booking-step" data-step="project" aria-labelledby="fm-booking-step-project" hidden><h3 id="fm-booking-step-project" tabindex="-1">Which project?</h3><p class="fm-booking-hint" data-needs-project hidden></p><div data-project></div><div class="fm-booking-choices" data-choices><button type="button" class="fm-booking-choice new" data-new-project><span class="fm-booking-choice-icon" aria-hidden="true"></span><span>New project</span></button><button type="button" class="fm-booking-choice none" data-no-project aria-pressed="false"><span class="fm-booking-choice-icon" aria-hidden="true"></span><span>No project</span></button></div></section>
<section class="fm-booking-step" data-step="new" aria-labelledby="fm-booking-step-new" hidden><h3 id="fm-booking-step-new" tabindex="-1">New project</h3><p class="fm-booking-hint">All optional. Add what you have, or tap Next to skip.</p><div class="fm-booking-fields">${newField('address', 'Address', 'text', 'Start typing an address')}<div class="fm-booking-contact"><span class="fm-booking-caption">Customer</span><div class="fm-booking-contact-row">${newField('name', 'Name', 'text', 'Name')}${newField('phone', 'Phone', 'tel', 'Phone')}</div>${newField('email', 'Email', 'email', 'Email')}</div></div></section>`}
<section class="fm-booking-step" data-step="when" aria-labelledby="fm-booking-step-when" hidden><h3 id="fm-booking-step-when" tabindex="-1">When?</h3><div class="fm-booking-summary" data-summary></div><div data-slot-quick></div><div class="fm-availability"></div></section>
<section class="fm-booking-step fm-booking-done" data-step="done" hidden><div class="fm-booking-check" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg></div><h3 tabindex="-1">Event created</h3><div class="fm-booking-created" data-done-summary></div></section>
</div>
<div role="status" data-status></div>
<footer class="fm-booking-footer"><button type="button" class="fm-booking-nav" data-prev aria-label="Previous"><span class="fm-booking-arrow back" aria-hidden="true"></span><span>Previous</span></button><button type="button" class="fm-booking-nav new" data-new-project hidden><span class="fm-booking-plus" aria-hidden="true"></span><span>New project</span></button><button type="button" class="fm-booking-nav primary" data-next><span>Next</span><span class="fm-booking-arrow" aria-hidden="true"></span></button><button type="submit" class="fm-booking-nav primary" data-create hidden disabled>Create event</button><button type="button" class="fm-booking-nav primary" data-finish hidden>Done</button></footer>
</form>
<div class="fm-booking-scrim" data-sheet-scrim hidden></div>
<section class="fm-booking-sheet" id="fm-booking-sheet" role="dialog" aria-modal="true" aria-labelledby="fm-booking-sheet-title" hidden><div class="fm-booking-sheet-grip" aria-hidden="true"></div><div class="fm-booking-sheet-head"><h3 id="fm-booking-sheet-title" tabindex="-1">Advanced</h3><button type="button" data-sheet-done>Done</button></div><div class="fm-booking-sheet-body" data-slot-advanced></div></section>
<section class="fm-booking-sheet fm-booking-type-sheet" id="fm-booking-type-sheet" role="dialog" aria-modal="true" aria-labelledby="fm-booking-type-title" hidden><div class="fm-booking-sheet-grip" aria-hidden="true"></div><div class="fm-booking-sheet-head"><h3 id="fm-booking-type-title" tabindex="-1">New appointment type</h3><button type="button" data-type-cancel>Cancel</button></div><div class="fm-booking-sheet-body"><p class="fm-booking-hint">Saved for everyone. You book one next.</p><div data-slot-new-type></div></div><footer class="fm-booking-type-foot"><div role="status" data-type-status></div><button type="button" class="fm-booking-nav primary" data-type-save>Save type</button></footer></section>`;
    document.body.append(dialog); dialog.showModal();
    const $ = selector => dialog.querySelector(selector);
    $('[data-step="type"] h3').focus({preventScroll:true});
    const stage = $('[data-stage]'), status = $('[data-status]'), target = $('.fm-availability'), sheet = $('#fm-booking-sheet'), typeSheet = $('#fm-booking-type-sheet'), scrim = $('[data-sheet-scrim]');
    const typeSave = $('[data-type-save]'), typeStatus = $('[data-type-status]');
    const prev = $('[data-prev]'), next = $('[data-next]'), create = $('[data-create]'), finish = $('[data-finish]'), advancedButton = $('[data-advanced-open]');
    const newFooter = $('.fm-booking-footer [data-new-project]'), choices = $('[data-choices]'), newFields = [...dialog.querySelectorAll('[data-new-field]')];
    const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let step = 'type', picker, selected = null, configuration, select = null, saving = false, done = false, stale = true;
    let addressOverride = null, sheetAdvances = false, advanceTimer, sheetTimer;
    /* openedSheet: the sheet showing (Advanced, or New appointment type). typeEditor: that sheet's own editor, separate from this appointment (FM-558). */
    let openedSheet = null, typeEditor = null, savingType = false;
    /* noProject: No project was chosen on purpose. draft: the project the New project step makes (its id is kept so a retry never makes two). */
    let noProject = false, draft = null, creating = false;
    /* place: the Google place picked for the new project's address, kept while the field still says it. */
    let place = null;
    let eventId = `appointment_${crypto.randomUUID()}`;
    const visited = new Set(['type']);
    const newEvent = () => { eventId = `appointment_${crypto.randomUUID()}`; };
    const projectId = () => lockedProject || select?.value || '';
    const chosen = () => !!(projectId() || addressOverride || noProject);
    /* A type that needs a project (FM-557) offers neither No project nor a bare address. */
    const needsProject = () => !!configuration?.requiresProject;
    function dropProjectless(){
      if (!needsProject()) return;
      // Only a type change makes one needed, and choosing a type already replaced the address's location with the type's.
      noProject = false; addressOverride = null;
    }
    /* The New project step sits inside Project: it has no place of its own in the progress. */
    const rank = name => name === 'done' ? order.length : order.indexOf(name === 'new' ? 'project' : name) + (name === 'new' ? .5 : 0);

    const whereText = () => projectId() ? (lockedProject ? configuration.project.title : clean(select?.input?.value)) || 'Project' : addressOverride ? configuration.value.location.address : 'No project';
    function summary(){
      if (!configuration) return '';
      const type = configuration.presetLabel || 'Custom', where = whereText();
      const chip = (goto, icon, text) => goto ? `<button type="button" class="fm-booking-chip" data-goto="${goto}"><span aria-hidden="true">${icon}</span><span>${esc(text)}</span></button>` : `<span class="fm-booking-chip"><span aria-hidden="true">${icon}</span><span>${esc(text)}</span></span>`;
      return chip('type', '◆', type) + chip(lockedProject ? '' : 'project', projectId() ? '▱' : '⌖', where);
    }
    function sync(){
      const index = order.indexOf(step === 'new' ? 'project' : step), busy = saving || creating;
      prev.style.visibility = index > 0 && !done ? '' : 'hidden';
      prev.disabled = busy;
      next.hidden = done || step === 'when';
      next.disabled = busy || (step === 'project' && !chosen());
      newFooter.hidden = done || step !== 'project'; newFooter.disabled = busy;
      if (choices) {
        choices.hidden = !!clean(select?.input?.value);
        const none = $('[data-no-project]'), required = needsProject(), note = $('[data-needs-project]');
        none.hidden = required; none.setAttribute('aria-pressed', String(noProject));
        note.hidden = !required; note.textContent = required ? (configuration.presetLabel ? `“${configuration.presetLabel}” needs a project.` : 'This appointment needs a project.') : '';
      }
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
        button.disabled = busy || !visited.has(item.dataset.progress) || position === index || (item.dataset.progress === 'when' && !chosen());
      });
      if (step === 'when') $('[data-summary]').innerHTML = summary();
      syncBack();
    }
    function go(name, {focus = true} = {}){
      clearTimeout(advanceTimer);
      if (name === step || saving || creating) return;
      if (name === 'when' && !chosen()) name = 'project';
      if (name === step) return;
      const from = $(`[data-step="${step}"]`), to = $(`[data-step="${name}"]`);
      if (!to) return;
      const forward = rank(name) > rank(step);
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
      else if (name === 'new') (newFields.find(field => !field.value) || newFields[0]).focus({preventScroll:true});
      else to.querySelector('h3')?.focus({preventScroll:true});
    }
    const goNext = () => { if (step === 'new') { void createProject(); return; } const following = order[order.indexOf(step) + 1]; if (following) go(following); };
    const goPrev = () => { if (step === 'new') { go('project'); return; } const preceding = order[order.indexOf(step) - 1]; if (preceding) go(preceding); };
    const advanceFromType = () => { if (step !== 'type') return; clearTimeout(advanceTimer); advanceTimer = setTimeout(goNext, reduceMotion() ? 0 : 200); };
    /* The phone's back control is Previous (FM-554): a history entry per step behind this one, one that closes from the
       first step or the finish, and one more while the Advanced sheet is open (back closes it). */
    const sheetOpen = () => !!openedSheet;
    const backHistory = window.Portal?.navigation?.steps?.({onBack:count => {
      for (let n = 0; n < count && dialog.open; n += 1) {
        if (sheetOpen()) closeSheet();
        else if (saving || creating) break;
        else if (done || step === 'type') close();
        else goPrev();
      }
      syncBack();
    }}) || null;
    function syncBack(){
      if (!dialog.open) return;
      const behind = done ? 0 : step === 'new' ? order.indexOf('project') + 1 : Math.max(0, order.indexOf(step));
      backHistory?.depth(behind + 1 + (sheetOpen() ? 1 : 0));
    }

    function showSheet(which){
      clearTimeout(sheetTimer);
      [sheet, typeSheet].forEach(other => { if (other !== which) { other.classList.remove('open'); other.hidden = true; } });
      openedSheet = which; scrim.hidden = false; which.hidden = false;
      advancedButton.setAttribute('aria-expanded', String(which === sheet));
      $('form').inert = true; $('.fm-booking-head').inert = true;
      requestAnimationFrame(() => { scrim.classList.add('open'); which.classList.add('open'); });
      which.querySelector('.fm-booking-sheet-body').scrollTop = 0;
      syncBack();
    }
    /* Advanced: this appointment's own settings (its name, location, staffing). It never saves a type. */
    function openSheet(){
      if (!configuration || done) return;
      showSheet(sheet); $('#fm-booking-sheet-title').focus({preventScroll:true});
    }
    function closeSheet({focus = true} = {}){
      const which = openedSheet;
      if (!which || savingType) return;
      openedSheet = null;
      scrim.classList.remove('open'); which.classList.remove('open'); advancedButton.setAttribute('aria-expanded', 'false');
      $('form').inert = false; $('.fm-booking-head').inert = false;
      sheetTimer = setTimeout(() => { scrim.hidden = true; which.hidden = true; if (which === typeSheet) { typeEditor?.destroy(); typeEditor = null; } }, reduceMotion() ? 0 : 280);
      syncBack();
      if (which === typeSheet) { if (focus) $('[data-new-type]')?.focus({preventScroll:true}); return; }
      if (sheetAdvances) { sheetAdvances = false; advanceFromType(); }
      else if (focus) advancedButton.focus({preventScroll:true});
    }
    /* New appointment type: a type name and the type's settings in their own sheet. Save type adds it to the catalog
       for everyone, then this booking continues with it chosen (FM-558). */
    async function openTypeSheet(){
      if (!configuration || done || saving || step !== 'type') return;
      clearTimeout(advanceTimer); sheetAdvances = false;
      typeEditor?.destroy(); typeEditor = null;
      const slot = $('[data-slot-new-type]');
      slot.innerHTML = '<p class="fm-booking-hint">Loading…</p>'; typeStatus.textContent = ''; typeSave.disabled = true;
      showSheet(typeSheet); $('#fm-booking-type-title').focus({preventScroll:true});
      try {
        const editor = await window.FirstMateAppointmentConfiguration.mount(slot, {orgId, typeMode:true});
        if (openedSheet !== typeSheet || !dialog.open) { editor.destroy(); return; }
        typeEditor = editor; typeSave.disabled = false;
        slot.querySelector('[data-type-name]')?.focus({preventScroll:true});
      } catch (error) { if (openedSheet === typeSheet) { slot.innerHTML = ''; typeStatus.textContent = error.message || 'Could not load appointment settings.'; } }
    }
    async function saveNewType(){
      if (!typeEditor || savingType) return;
      savingType = true; typeSave.disabled = true; typeSheet.querySelector('.fm-booking-sheet-body').inert = true; typeStatus.textContent = '';
      typeSave.textContent = 'Saving…';
      try {
        const saved = await typeEditor.saveType();
        savingType = false; closeSheet({focus:false});
        configuration.adoptType(saved.id, saved.response);
      } catch (error) {
        typeStatus.textContent = error.message || 'Could not save this type.';
      } finally {
        savingType = false; typeSave.disabled = !typeEditor; typeSave.textContent = 'Save type'; typeSheet.querySelector('.fm-booking-sheet-body').inert = false;
        if (typeStatus.textContent === 'Name the type first.') typeSheet.querySelector('[data-type-name]')?.focus({preventScroll:true});
      }
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
        showFree:true, onSlots:staffingNote(target, configuration, {dialog, options}),
        onDurationChange:days => { configuration.setDuration(days, false); newEvent(); },
        date,
        loadAvailability:(date, days) => api.appointments.preview(orgId, zoned({...(projectId() ? {project_id:projectId()} : {}), date, configuration:{...configuration.value, ...(dayMode ? {duration_days:days} : {})}})),
        onChange:slot => { selected = slot; sync(); }
      });
    }
    function changed(){ newEvent(); stale = true; if (step === 'when') refresh(); else sync(); }
    function useAddress(address){
      noProject = false;
      addressOverride ||= {before:configuration.value.location};
      configuration.setLocation({mode:'custom', address}, false);
      changed(); go('when');
    }
    function useProject(value){
      if (!configuration) return;
      if (addressOverride) { configuration.setLocation(addressOverride.before, false); addressOverride = null; }
      configuration.setProject(value); changed();
    }
    function chooseNoProject(){
      if (!configuration || saving || needsProject()) return;
      if (select?.value) select.setValue(null);
      useProject(''); noProject = true; sync(); go('when');
    }
    /* New project: a fresh form each time, started from what was typed in the search. */
    function startNewProject(){
      if (saving || creating || !configuration) return;
      draft = {id:`project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, created:false};
      newFields.forEach(field => { field.value = ''; }); place = null;
      const typed = select?.value ? '' : clean(select?.input?.value);
      if (typed) dialog.querySelector(`[data-new-field="${/^\d/.test(typed) ? 'address' : 'name'}"]`).value = typed;
      go('new');
    }
    /* Creates the project through the projects API (create only: the server starts its scope, projects/create.ts),
       then links its contact. Every field may be blank. */
    async function createProject(){
      if (creating || saving || !draft) return;
      const field = key => clean(dialog.querySelector(`[data-new-field="${key}"]`)?.value);
      const address = field('address'), name = field('name'), phone = field('phone'), email = field('email');
      const section = $('[data-step="new"]');
      creating = true; section.inert = true; status.textContent = 'Creating project…'; sync();
      try {
        if (!api.projects?.save) throw new Error('Projects are unavailable in this session.');
        if (!draft.created) {
          const now = new Date().toISOString(), title = name || (address ? '' : 'New Project');
          const located = place && place.address === address ? {lat:place.lat, lng:place.lng, address_components:place.address_components} : {};
          const saved = await api.projects.save(orgId, draft.id, {id:draft.id, title, project_title:title, address, ...located, project_type:'residential', workflow_state:'draft',
            has_meaningful_activity:true, last_activity_at:now, measurement:{}, measurement_project:{}, events:[], proposals:[], updated_at:now}, {}, {createOnly:true})
            .catch(error => { if (error?.code === 'project_exists') return {document:{id:draft.id}}; throw error; });
          if (!saved?.document || saved.missing) throw new Error('Could not create the project.');
          draft.created = true;
        }
        if (name || phone || email) {
          try { await api.contacts.setProjectContacts(orgId, draft.id, [{name, phone, email, primary:true}]); }
          catch (error) { throw new Error(`The project was created, but its contact was not saved: ${error.message || 'try again.'}`); }
        }
        const id = draft.id; draft = null; noProject = false;
        window.dispatchEvent(new CustomEvent('fm:projects:refresh', {detail:{redraw:true}}));
        select.setValue({id, title:name || address || 'New Project'});
        useProject(id);
        creating = false; section.inert = false; status.textContent = '';
        go('when');
      } catch (error) {
        creating = false; section.inert = false; sync();
        status.textContent = error.message || 'Could not create the project.';
      }
    }

    const close = () => { if (!saving) dialog.close(); };
    $('[data-close]').onclick = close;
    finish.onclick = close;
    prev.onclick = goPrev;
    next.onclick = goNext;
    dialog.querySelectorAll('[data-new-project]').forEach(button => { button.onclick = startNewProject; });
    $('[data-no-project]')?.addEventListener('click', chooseNoProject);
    const addressInput = $('[data-new-field="address"]');
    const places = addressInput ? placesAutocomplete(dialog, addressInput, picked => { place = picked; }) : null;
    addressInput?.addEventListener('input', () => { if (place && clean(addressInput.value) !== place.address) place = null; });
    newFields.forEach((input, index) => input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || (input === addressInput && places?.open)) return;
      event.preventDefault();
      if (newFields[index + 1]) newFields[index + 1].focus(); else goNext();
    }));
    advancedButton.onclick = () => openSheet();
    $('[data-sheet-done]').onclick = () => closeSheet();
    $('[data-type-cancel]').onclick = () => closeSheet();
    typeSave.onclick = () => void saveNewType();
    scrim.onclick = () => closeSheet();
    dialog.addEventListener('click', event => { const goto = event.target.closest('[data-goto]'); if (goto && !goto.disabled) go(goto.dataset.goto); });
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); else if (openedSheet) { event.preventDefault(); closeSheet(); } });
    dialog.addEventListener('close', () => { clearTimeout(advanceTimer); clearTimeout(sheetTimer); backHistory?.release(); picker?.destroy(); configuration?.destroy(); typeEditor?.destroy(); select?.destroy(); places?.destroy(); }, {once:true});

    if (!lockedProject) {
      select = window.FirstMateProjectSelector.mount($('[data-project]'), {orgId, projectId:options.projectId, inline:true, recent:false,
        extraRows:query => query.length >= 4 && configuration && !needsProject() ? [{title:`Use “${query}”`, subtitle:'Just the address — link a project later', onSelect:() => useAddress(query)}] : [],
        onChange:useProject,
        onSelect:value => { noProject = !value && !needsProject(); sync(); go('when'); }});
      /* Typing undoes the last choice (No project, or an address), so Next waits for a new one. */
      select.input.addEventListener('input', () => { noProject = false; if (addressOverride && configuration) { configuration.setLocation(addressOverride.before, false); addressOverride = null; changed(); } else sync(); });
      select.ready.then(() => { if (dialog.isConnected) sync(); });
    }

    $('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (step !== 'when' || saving || !selected || !chosen()) return;
      saving = true; select?.setDisabled(true); stage.inert = true; advancedButton.disabled = true; sync();
      status.textContent = 'Creating event…';
      try {
        await api.appointments.book(orgId, zoned({...(projectId() ? {project_id:projectId()} : {}), start_at:selected.start_at || selected.start, event_id:eventId, configuration:configuration.value}));
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        options.onBooked?.();
        $('[data-done-summary]').innerHTML = createdDetails(configuration, selected, whereText());
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
        onChange:() => { dropProjectless(); changed(); },
        onNewType:() => void openTypeSheet(),
        staffSetup:(entry) => !!typeSetup(entry),
        onAddUsers:(entry) => { const setup = typeSetup(entry); if (setup) runStaffSetup(dialog, options, setup); },
        onPreset:id => {
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
