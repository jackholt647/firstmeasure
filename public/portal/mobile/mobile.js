(function(){
  const APP = window.__APP || {};
  const API = window.PlatformAPI;
  const Scheduling = window.PlatformScheduling;

  const state = {
    currentUser: null,
    role: 'sales',
    projects: [],
    appointments: [],
    activeProject: null,
    activeEvent: null,
    activePhoto: null,
    activeTab: 'sales',
    strokes: [],
    currentStroke: null,
    canvasRect: null,
    toastTimer: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function clean(value){ return String(value ?? '').trim(); }
  function lower(value){ return clean(value).toLowerCase(); }
  function escapeHtml(value){
    return clean(value).replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function orgId(){ return clean(APP.userOrgId || APP.orgId); }
  function currentUserId(){ return clean(APP.userId || APP.platformUserId); }

  function toast(message){
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('visible'), 2600);
  }

  function setStatus(text){
    const node = $('#syncStatus');
    if (node) node.textContent = text;
  }

  function dateFrom(value){
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function firstText(...values){
    for (const value of values) {
      const text = clean(value);
      if (text) return text;
    }
    return '';
  }

  function rawStartValue(event = {}){
    return firstText(event.start_at, event.start, event.starts_at, event.scheduled_at, event.appointment_at, event.date);
  }

  function explicitTimeValue(event = {}){
    return firstText(
      event.start_time,
      event.time,
      event.appointment_time,
      event.scheduled_time,
      event.window_start,
      event.appointment?.time,
      event.appointment?.start_time
    );
  }

  function normalizeTime(value){
    const raw = clean(value).toLowerCase().replace(/\s+/g, ' ');
    if (!raw) return '';
    const compact = raw.replace(/\./g, '');
    const match = compact.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!match) {
      const timeLike = compact.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
      if (!timeLike) return '';
      return normalizeTime(`${timeLike[1]}:${timeLike[2]}${timeLike[3] ? ` ${timeLike[3]}` : ''}`);
    }
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = match[3] || '';
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return '';
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  }

  function startHasExplicitTime(value){
    const raw = clean(value);
    return /t\d{1,2}:\d{2}/i.test(raw) || /\d{1,2}:\d{2}/.test(raw);
  }

  function startIsDateOnly(value){
    return /^\d{4}-\d{2}-\d{2}$/.test(clean(value));
  }

  function startDateWithFallbackTime(event = {}){
    const raw = rawStartValue(event);
    const time = normalizeTime(explicitTimeValue(event));
    if (startIsDateOnly(raw) && time) return dateFrom(`${raw}T${time}`);
    if (startIsDateOnly(raw)) return dateFrom(`${raw}T00:00:00`);
    if (raw && !startHasExplicitTime(raw) && time) {
      const parsed = dateFrom(raw);
      if (parsed) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return dateFrom(`${y}-${m}-${d}T${time}`);
      }
    }
    return dateFrom(raw);
  }

  function startOfDay(date){
    const d = dateFrom(date) || new Date();
    d.setHours(0,0,0,0);
    return d;
  }

  function sameDay(a, b){
    return startOfDay(a).getTime() === startOfDay(b).getTime();
  }

  function fmtDateTime(value){
    const date = dateFrom(value);
    if (!date) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fmtTime(value, event = null){
    const date = dateFrom(value);
    if (!date) return '';
    if (event && date.getHours() === 0 && date.getMinutes() === 0 && !startHasExplicitTime(rawStartValue(event)) && !normalizeTime(explicitTimeValue(event))) {
      return 'Time TBD';
    }
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel(value){
    const date = dateFrom(value);
    if (!date) return 'Unknown date';
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function uploadDayLabel(value){
    const date = dateFrom(value);
    if (!date) return 'No date';
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function projectTitle(project = {}){
    return clean(project.title || project.name || project.project_name || project.address || 'Project');
  }

  function projectAddress(project = {}){
    return clean(project.address || project.project_address || project.location?.address || '');
  }

  function firstContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    if (contacts.length) return contacts[0] || {};
    return {
      name: project.customer_name || project.name || '',
      phone: project.phone || project.customer_phone || '',
      email: project.email || project.customer_email || ''
    };
  }

  function officeNotes(project = {}){
    return clean(
      project.office_notes ||
      project.project_notes ||
      project.notes_for_sales ||
      project.notes ||
      project.internal_notes ||
      ''
    );
  }

  function eventStart(event = {}){
    return startDateWithFallbackTime(event) || Scheduling?.eventStart?.(event);
  }

  function eventEnd(event = {}){
    return Scheduling?.eventEnd?.(event) || dateFrom(event.end_at || event.end || eventStart(event));
  }

  function eventType(event = {}){
    return lower(event.event_type_id || event.type_id || event.type || event.kind || '');
  }

  function isSalesAppointment(event = {}){
    const type = eventType(event);
    const title = lower(event.title || event.name);
    const roles = [
      ...(Array.isArray(event.role_ids) ? event.role_ids : []),
      ...(Array.isArray(event.required_role_ids) ? event.required_role_ids : []),
      ...(Array.isArray(event.allowed_role_ids) ? event.allowed_role_ids : [])
    ].map(lower);
    return !type || type.includes('sales') || title.includes('appointment') || roles.includes('sales_appointments') || roles.includes('sales');
  }

  function assignedIds(event = {}){
    const ids = new Set();
    [
      event.assigned_user_id,
      event.user_id,
      event.owner_id,
      ...(Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [])
    ].forEach((value) => {
      if (clean(value)) ids.add(clean(value));
    });
    (Array.isArray(event.assigned_users) ? event.assigned_users : []).forEach((user) => {
      [user.id, user.user_id, user.email, user.name].forEach((value) => {
        if (clean(value)) ids.add(clean(value));
      });
    });
    return ids;
  }

  function assignedToCurrentUser(event = {}){
    const ids = assignedIds(event);
    if (!ids.size) return true;
    const user = state.currentUser || {};
    const candidates = [currentUserId(), APP.userEmail, APP.userName, user.id, user.email, user.name].map(clean).filter(Boolean);
    return candidates.some((candidate) => ids.has(candidate));
  }

  function userHasSalesRole(user = {}){
    if (userIsSuperAdmin(user)) return true;
    const roles = [
      user.role,
      user.permission_level,
      user.org_permissions?.level,
      ...(Array.isArray(user.roles) ? user.roles : []),
      ...(Array.isArray(user.role_ids) ? user.role_ids : [])
    ].map(lower).filter(Boolean);
    if (!roles.length) return true;
    return roles.some((role) => role === 'sales' || role === 'sales_appointments' || role === 'salesperson' || role.includes('sales'));
  }

  function userIsSuperAdmin(user = {}){
    const roles = [
      user.role,
      user.permission_level,
      user.org_permissions?.level,
      ...(Array.isArray(user.roles) ? user.roles : []),
      ...(Array.isArray(user.role_ids) ? user.role_ids : [])
    ].map(lower).filter(Boolean);
    return roles.some((role) => role === 'super_admin' || role === 'owner');
  }

  function needsAction(project = {}, event = {}){
    const end = eventEnd(event) || eventStart(event);
    const workflow = lower(project.workflow_state || project.stage || project.status || '');
    const outcome = lower(event.outcome || event.result || project.sales_outcome || project.appointment_outcome);
    const actionStatus = lower(project.sales_action_status || project.action_status || event.action_status);
    if (outcome || ['sold', 'lost', 'cancelled', 'canceled', 'completed'].includes(actionStatus)) return false;
    return !!(end && end.getTime() < Date.now() && !workflow.includes('sold') && !workflow.includes('lost'));
  }

  function needsFollowUp(project = {}, event = {}){
    const fields = [
      project.follow_up_at,
      project.followup_at,
      project.next_follow_up_at,
      event.follow_up_at,
      event.next_follow_up_at
    ].filter(Boolean);
    if (fields.length) return true;
    const workflow = lower(project.workflow_state || project.stage || project.status || '');
    return workflow.includes('follow');
  }

  function normalizeProjects(result){
    return (result?.documents || []).map((doc) => ({ id: doc.id, ...(doc.data || {}) }));
  }

  function buildAppointments(projects){
    const rows = [];
    projects.forEach((project) => {
      const events = Array.isArray(project.events) ? project.events : [];
      events.forEach((event, index) => {
        if (!isSalesAppointment(event) || !assignedToCurrentUser(event)) return;
        const start = eventStart(event);
        if (!start) return;
        rows.push({
          id: clean(event.id || `${project.id}_${index}`),
          event,
          project,
          start,
          end: eventEnd(event) || start,
          action: needsAction(project, event),
          follow: needsFollowUp(project, event)
        });
      });
    });
    rows.sort((a, b) => a.start.getTime() - b.start.getTime());
    return rows;
  }

  async function loadCurrentUser(){
    if (!API?.users?.get || !orgId() || !currentUserId()) {
      state.currentUser = { id: currentUserId(), name: APP.userName, email: APP.userEmail, role: 'sales' };
      return state.currentUser;
    }
    try {
      const result = await API.users.get(orgId(), currentUserId());
      state.currentUser = { id: result?.document?.id || currentUserId(), ...(result?.document?.data || {}) };
    } catch (error) {
      state.currentUser = { id: currentUserId(), name: APP.userName, email: APP.userEmail, role: 'sales' };
    }
    return state.currentUser;
  }

  async function loadData(){
    if (!API || !orgId()) {
      setStatus('Offline');
      toast('Platform API is not available.');
      return;
    }
    setStatus('Loading');
    await loadCurrentUser();
    try {
      const result = await API.projects.list(orgId());
      state.projects = normalizeProjects(result);
      state.appointments = buildAppointments(state.projects);
      renderAppointments();
      setStatus('Synced');
    } catch (error) {
      console.error(error);
      setStatus('Error');
      $('#appointmentSections').innerHTML = emptyState('fa-triangle-exclamation', 'Could not load appointments', error.message || 'Try refreshing.');
    }
  }

  function emptyState(icon, title, message){
    return `
      <div class="empty-state">
        <i class="fas ${escapeHtml(icon)}"></i>
        <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>
      </div>
    `;
  }

  function renderAppointments(){
    const today = new Date();
    const groups = [
      {
        id: 'today',
        title: "Today's appointments",
        items: state.appointments.filter((item) => sameDay(item.start, today))
      },
      {
        id: 'action',
        title: 'Pending action',
        items: state.appointments.filter((item) => item.action)
      },
      {
        id: 'follow',
        title: 'Pending follow up',
        items: state.appointments.filter((item) => item.follow)
      }
    ];
    const root = $('#appointmentSections');
    if (!state.appointments.length) {
      root.innerHTML = emptyState('fa-calendar-check', 'No sales appointments', 'Assigned appointments will show up here as they are scheduled.');
      return;
    }
    root.innerHTML = groups.map((group) => `
      <section class="appt-section" data-group="${escapeHtml(group.id)}">
        <div class="section-head">
          <h2>${escapeHtml(group.title)}</h2>
          <span class="section-count">${group.items.length}</span>
        </div>
        <div class="appt-list">
          ${group.items.length ? group.items.map(renderAppointmentItem).join('') : emptySectionRow(group.id)}
        </div>
      </section>
    `).join('');
    $$('[data-appt-id]', root).forEach((button) => {
      button.addEventListener('click', () => {
        const item = state.appointments.find((appt) => appt.id === button.dataset.apptId);
        if (item) openProject(item.project, item.event);
      });
    });
  }

  function emptySectionRow(id){
    const text = id === 'today' ? 'Nothing scheduled today.' : id === 'action' ? 'No appointments need action.' : 'No follow ups pending.';
    return `<div class="appt-item" role="presentation"><div class="appt-meta">${escapeHtml(text)}</div></div>`;
  }

  function renderAppointmentItem(item){
    const project = item.project;
    const contact = firstContact(project);
    const flags = [
      item.action ? '<span class="pill warning">Action needed</span>' : '',
      item.follow ? '<span class="pill follow">Follow up</span>' : ''
    ].filter(Boolean).join('');
    return `
      <button class="appt-item" type="button" data-appt-id="${escapeHtml(item.id)}">
        <div class="appt-title">${escapeHtml(projectTitle(project))}</div>
        <div class="appt-time">${escapeHtml(fmtTime(item.start, item.event))}</div>
        <div class="appt-meta">${escapeHtml(contact.name || 'Customer')} ${contact.phone ? `- ${contact.phone}` : ''}</div>
        <div class="appt-address">${escapeHtml(projectAddress(project) || dayLabel(item.start))}</div>
        ${flags ? `<div class="appt-flags">${flags}</div>` : ''}
      </button>
    `;
  }

  function mapUrl(address){
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }

  function openProject(project, event = null){
    state.activeProject = project;
    state.activeEvent = event;
    $('#sheetProjectTitle').textContent = projectTitle(project);
    $('#sheetProjectMeta').textContent = event ? fmtDateTime(eventStart(event)) : projectAddress(project);
    renderProjectHome(project);
    renderProjectPhotos(project);
    setProjectTab('home');
    const sheet = $('#projectSheet');
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeProject(){
    const sheet = $('#projectSheet');
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    state.activeProject = null;
    state.activeEvent = null;
  }

  function detailRow(icon, label, value, action = ''){
    if (!clean(value)) return '';
    return `
      <div class="detail-row">
        <i class="fas ${escapeHtml(icon)}"></i>
        <div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>
        ${action}
      </div>
    `;
  }

  function renderProjectHome(project){
    const contact = firstContact(project);
    const address = projectAddress(project);
    const mapAction = address ? `<a class="row-action" href="${escapeHtml(mapUrl(address))}" target="_blank" rel="noopener" aria-label="Open map"><i class="fas fa-map-location-dot"></i></a>` : '';
    const phoneAction = clean(contact.phone) ? `<a class="row-action" href="tel:${escapeHtml(clean(contact.phone).replace(/[^\d+]/g, ''))}" aria-label="Call"><i class="fas fa-phone"></i></a>` : '';
    const emailAction = clean(contact.email) ? `<a class="row-action" href="mailto:${escapeHtml(contact.email)}" aria-label="Email"><i class="fas fa-envelope"></i></a>` : '';
    $('#projectDetails').innerHTML = [
      detailRow('fa-location-dot', 'Address', address, mapAction),
      detailRow('fa-user', 'Customer', contact.name || project.customer_name || ''),
      detailRow('fa-phone', 'Phone', contact.phone || '', phoneAction),
      detailRow('fa-envelope', 'Email', contact.email || '', emailAction)
    ].join('') || emptyState('fa-folder-open', 'No project details', 'Project contact details have not been added yet.');
    $('#officeNotes').textContent = officeNotes(project) || 'No office notes for this project.';
  }

  function setProjectTab(tab){
    $$('.sheet-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.projectTab === tab));
    $$('.project-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
  }

  function normalizePhoto(ref, index){
    const mediaRef = API?.media?.normalizeReference ? API.media.normalizeReference(ref) : ref;
    const mediaId = clean(mediaRef.media_id || mediaRef.mediaId || mediaRef.id);
    const original = mediaId && API?.media?.fileUrlFromReference ? API.media.fileUrlFromReference(orgId(), mediaRef, 'original') : clean(ref.src || ref.url || '');
    const thumb = mediaId && API?.media?.fileUrlFromReference ? API.media.fileUrlFromReference(orgId(), mediaRef, 'thumb_320') : clean(ref.thumb || ref.thumbnail || original);
    return {
      ...mediaRef,
      localIndex: index,
      media_id: mediaId,
      src: original,
      thumb: thumb || original,
      label: clean(ref.label || ref.file_name || `Photo ${index + 1}`),
      uploaded_at: clean(ref.uploaded_at || ref.created_at || ref.updated_at || ref.metadata?.uploaded_at || ''),
      markup: mediaRef.markup && typeof mediaRef.markup === 'object' ? mediaRef.markup : {}
    };
  }

  function projectPhotos(project){
    return (Array.isArray(project?.photos) ? project.photos : []).map(normalizePhoto).filter((photo) => photo.src || photo.media_id);
  }

  function photoMarkup(photo){
    const layer = API?.media?.markupLayerId ? API.media.markupLayerId('sales_mobile') : 'markup_sales_mobile';
    return photo.markup?.[layer]?.data || photo.markup?.sales_mobile?.data || photo.markup?.default?.data || {};
  }

  function hasMarkup(photo){
    const data = photoMarkup(photo);
    return !!(clean(data.notes) || (Array.isArray(data.strokes) && data.strokes.length));
  }

  function renderProjectPhotos(project){
    const photos = projectPhotos(project);
    const root = $('#photoGroups');
    $('#photoStatus').textContent = photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'No photos yet';
    if (!photos.length) {
      root.innerHTML = emptyState('fa-images', 'No project photos', 'Upload job photos here and they will stay on the project.');
      return;
    }
    const groups = new Map();
    photos.forEach((photo) => {
      const key = (dateFrom(photo.uploaded_at) || new Date(0)).toISOString().slice(0, 10);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(photo);
    });
    root.innerHTML = Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0])).map(([key, items]) => `
      <section class="photo-day">
        <h2>${escapeHtml(key === '1970-01-01' ? 'Existing photos' : uploadDayLabel(`${key}T12:00:00`))}</h2>
        <div class="photo-grid">
          ${items.map((photo) => `
            <button class="photo-tile ${hasMarkup(photo) ? 'has-markup' : ''}" type="button" data-photo-index="${photo.localIndex}" aria-label="Open ${escapeHtml(photo.label)}">
              <img src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photo.label)}" loading="lazy">
            </button>
          `).join('')}
        </div>
      </section>
    `).join('');
    $$('[data-photo-index]', root).forEach((button) => {
      button.addEventListener('click', () => {
        const photo = projectPhotos(state.activeProject).find((item) => String(item.localIndex) === String(button.dataset.photoIndex));
        if (photo) openPhoto(photo);
      });
    });
  }

  async function uploadPhotos(files){
    if (!state.activeProject || !files.length) return;
    $('#photoStatus').textContent = `Uploading ${files.length}`;
    try {
      for (const file of files) {
        await API.documents.uploadFieldFile(orgId(), 'projects', state.activeProject.id, 'photos', file, {
          mode: 'append',
          replaceSlot: false,
          mediaMetadata: { source: 'sales_mobile', uploaded_by: APP.userEmail || '' },
          referenceMetadata: { source: 'sales_mobile', uploaded_by: APP.userEmail || '' },
          thumbnails: { enabled: true, sizes: [160, 320, 640], format: 'webp' },
          compression: { enabled: true, max_width: 2400, quality: 84, format: 'webp' }
        });
      }
      const fresh = await API.projects.get(orgId(), state.activeProject.id);
      state.activeProject = { id: fresh.document.id, ...(fresh.document.data || {}) };
      const idx = state.projects.findIndex((project) => project.id === state.activeProject.id);
      if (idx >= 0) state.projects[idx] = state.activeProject;
      renderProjectPhotos(state.activeProject);
      toast('Photos uploaded');
    } catch (error) {
      console.error(error);
      $('#photoStatus').textContent = 'Upload failed';
      toast(error.message || 'Could not upload photos.');
    } finally {
      $('#photoInput').value = '';
    }
  }

  function openPhoto(photo){
    state.activePhoto = photo;
    const markup = photoMarkup(photo);
    state.strokes = Array.isArray(markup.strokes) ? markup.strokes : [];
    $('#viewerPhotoTitle').textContent = photo.label || 'Photo';
    $('#viewerPhotoMeta').textContent = photo.uploaded_at ? fmtDateTime(photo.uploaded_at) : 'Markup';
    $('#photoNotes').value = clean(markup.notes);
    const img = $('#markupImage');
    img.src = photo.src;
    img.onload = resizeCanvas;
    $('#photoViewer').classList.add('open');
    $('#photoViewer').setAttribute('aria-hidden', 'false');
    requestAnimationFrame(resizeCanvas);
  }

  function closePhoto(){
    $('#photoViewer').classList.remove('open');
    $('#photoViewer').setAttribute('aria-hidden', 'true');
    state.activePhoto = null;
    state.strokes = [];
    state.currentStroke = null;
  }

  function resizeCanvas(){
    const stage = $('#markupStage');
    const canvas = $('#markupCanvas');
    if (!stage || !canvas) return;
    const rect = stage.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    state.canvasRect = rect;
    drawStrokes();
  }

  function drawStrokes(){
    const canvas = $('#markupCanvas');
    const ctx = canvas.getContext('2d');
    const rect = state.canvasRect || canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    [...state.strokes, state.currentStroke].filter(Boolean).forEach((stroke) => {
      const points = Array.isArray(stroke.points) ? stroke.points : [];
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = stroke.color || '#ffde59';
      ctx.lineWidth = stroke.width || 4;
      points.forEach((point, index) => {
        const x = point.x * rect.width;
        const y = point.y * rect.height;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function pointFromEvent(event){
    const rect = state.canvasRect || $('#markupCanvas').getBoundingClientRect();
    const touch = event.touches?.[0] || event.changedTouches?.[0] || event;
    const x = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height));
    return { x, y };
  }

  function startDraw(event){
    if (!state.activePhoto) return;
    event.preventDefault();
    state.currentStroke = { color: '#ffde59', width: 4, points: [pointFromEvent(event)] };
    drawStrokes();
  }

  function moveDraw(event){
    if (!state.currentStroke) return;
    event.preventDefault();
    state.currentStroke.points.push(pointFromEvent(event));
    drawStrokes();
  }

  function endDraw(event){
    if (!state.currentStroke) return;
    event.preventDefault();
    if (state.currentStroke.points.length > 1) state.strokes.push(state.currentStroke);
    state.currentStroke = null;
    drawStrokes();
  }

  async function saveMarkup(){
    const project = state.activeProject;
    const photo = state.activePhoto;
    if (!project || !photo) return;
    const data = {
      notes: clean($('#photoNotes').value),
      strokes: state.strokes,
      updated_at: new Date().toISOString(),
      updated_by: APP.userEmail || ''
    };
    const layer = 'sales_mobile';
    try {
      if (photo.media_id && API?.media?.saveMarkup) {
        await API.media.saveMarkup(orgId(), photo.media_id, layer, data, { source: 'sales_mobile' });
      }
      const projectData = await API.projects.getData(orgId(), project.id);
      if (photo.media_id) {
        await API.projectMedia.savePhotoMarkup(orgId(), project.id, projectData || project, photo.media_id, layer, data, { source: 'sales_mobile' });
      } else {
        const layerKey = API?.media?.markupLayerId ? API.media.markupLayerId(layer) : `markup_${layer}`;
        const photos = Array.isArray((projectData || project).photos) ? [...(projectData || project).photos] : [];
        const current = photos[photo.localIndex] || {};
        photos[photo.localIndex] = {
          ...current,
          markup: {
            ...(current.markup || {}),
            [layerKey]: {
              layer_id: layerKey,
              data,
              updated_at: new Date().toISOString()
            }
          }
        };
        await API.documents.setField(orgId(), 'projects', project.id, 'photos', photos, { source: 'sales_mobile_markup' });
      }
      const fresh = await API.projects.get(orgId(), project.id);
      state.activeProject = { id: fresh.document.id, ...(fresh.document.data || {}) };
      const idx = state.projects.findIndex((item) => item.id === state.activeProject.id);
      if (idx >= 0) state.projects[idx] = state.activeProject;
      renderProjectPhotos(state.activeProject);
      toast('Markup saved');
      closePhoto();
    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not save markup.');
    }
  }

  function bind(){
    const name = clean(APP.userName || APP.userEmail || 'User');
    $('#accountInitial').textContent = name.slice(0, 1).toUpperCase();
    $('#menuUserName').textContent = name;
    $('#menuUserEmail').textContent = clean(APP.userEmail);

    $('#accountBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = $('#accountMenu');
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      $('#accountBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#accountMenu') && !event.target.closest('#accountBtn')) {
        $('#accountMenu').classList.remove('open');
        $('#accountMenu').setAttribute('aria-hidden', 'true');
        $('#accountBtn').setAttribute('aria-expanded', 'false');
      }
    });

    $$('[data-app-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.appTab;
        state.activeTab = tab;
        $$('.screen').forEach((screen) => screen.classList.remove('active'));
        $(`#${tab === 'sales' ? 'salesScreen' : 'futureScreen'}`).classList.add('active');
        $('#accountMenu').classList.remove('open');
      });
    });

    $('#refreshBtn').addEventListener('click', loadData);
    $('#closeProjectBtn').addEventListener('click', closeProject);
    $$('.sheet-tab').forEach((button) => button.addEventListener('click', () => setProjectTab(button.dataset.projectTab)));
    $('#photoInput').addEventListener('change', (event) => uploadPhotos(Array.from(event.target.files || [])));
    $('#closePhotoBtn').addEventListener('click', closePhoto);
    $('#saveMarkupBtn').addEventListener('click', saveMarkup);
    $('#undoStrokeBtn').addEventListener('click', () => {
      state.strokes.pop();
      drawStrokes();
    });
    $('#clearMarkupBtn').addEventListener('click', () => {
      state.strokes = [];
      drawStrokes();
    });

    const canvas = $('#markupCanvas');
    canvas.addEventListener('pointerdown', startDraw);
    canvas.addEventListener('pointermove', moveDraw);
    canvas.addEventListener('pointerup', endDraw);
    canvas.addEventListener('pointercancel', endDraw);
    window.addEventListener('resize', resizeCanvas);

    let startX = 0;
    let startY = 0;
    $('#projectSheet').addEventListener('touchstart', (event) => {
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    $('#projectSheet').addEventListener('touchend', (event) => {
      const touch = event.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (startX < 36 && dx > 85 && dy < 80) closeProject();
    }, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    loadData();
  });
})();
