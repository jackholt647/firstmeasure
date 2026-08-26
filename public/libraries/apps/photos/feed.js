/* public/libraries/apps/photos/feed.js
 * Organization-wide project photos feed.
 */
(function(){
  if (!window.Portal) return;
  const { escapeHtml, injectCSS } = window.Portal.util;
  const { showToast } = window.Portal.ui;
  const APP = window.Portal.cfg || window.__APP || {};
  const TAB_ID = 'photos_feed';
  const PROJECT_CONFIG_MODULE_ID = 'project_configuration';
  const PAGE_SIZE = 14;
  let registered = false;
  let branchProjectConfig = { title_mode: 'customer_name' };
  let state = {
    root: null,
    projects: [],
    items: [],
    groups: [],
    query: '',
    density: 'comfortable',
    visible: PAGE_SIZE,
    loading: false,
    loaded: false,
    observer: null,
    selected: new Set(),
    selectionMode: false,
    selectionAnchorId: '',
    dragSelecting: false,
    dragStartId: '',
    dragStartX: 0,
    dragStartY: 0,
    dragMode: 'add',
    dragMoved: false,
    dragLeftStartTile: false,
    dragPreview: new Set(),
    suppressClickId: '',
    downloadMenuOpen: false,
    pointerUpBound: false,
    title: 'Photo Feed',
    subtitle: '',
    icon: 'fa-images',
    uploadLabel: '',
    onUpload: null,
    enableProjectLinks: true,
    trashMode: false,
    routeRestoreKey: ''
  };

  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  function orgId(){ return cleanText(APP.userOrgId || APP.orgId || window.__APP?.userOrgId || window.__APP?.orgId); }
  function photoIdentity(photo = {}){
    return cleanText(photo.media_id || photo.id || photo.src || photo.thumb);
  }
  function mediaRouteId(photo = {}){
    return window.Portal?.routeState?.mediaId?.(photo) || photoIdentity(photo);
  }
  function projectRouteId(project = {}){
    return window.Portal?.routeState?.projectId?.(project) || cleanText(project?.id);
  }
  function projectIdFromGroupKey(key = ''){
    const tail = cleanText(key).split('::').pop() || '';
    return /^project_/i.test(tail) || /^base_/i.test(tail) ? tail : '';
  }
  function sameProjectId(project = {}, id = ''){
    const key = cleanText(id);
    if (!key) return false;
    return [
      project?.id,
      project?.platform_project_id,
      project?.base_project_id
    ].some((value) => cleanText(value) === key);
  }
  function mergeProjectDetails(primary = {}, fallback = {}){
    const left = primary && typeof primary === 'object' ? primary : {};
    const right = fallback && typeof fallback === 'object' ? fallback : {};
    const merged = { ...right, ...left };
    const keepText = (key) => {
      const value = firstText(left[key]);
      const backup = firstText(right[key]);
      if (value) merged[key] = value;
      else if (backup) merged[key] = backup;
    };
    const keepArray = (key) => {
      const value = Array.isArray(left[key]) ? left[key] : [];
      const backup = Array.isArray(right[key]) ? right[key] : [];
      if (value.length) merged[key] = value;
      else if (backup.length) merged[key] = backup;
    };
    [
      'id',
      'platform_project_id',
      'base_project_id',
      'title',
      'project_title',
      'project_name',
      'projectName',
      'customer_name',
      'customerName',
      'primary_contact_name',
      'customer_email',
      'primary_contact_email',
      'customer_phone',
      'primary_contact_phone',
      'address',
      'project_type',
      'status',
      'workflow_state',
      'stage',
      'stage_id'
    ].forEach(keepText);
    ['contacts', 'photos', 'proposals', 'events'].forEach(keepArray);
    const id = firstText(merged.platform_project_id, merged.base_project_id, merged.id);
    if (id) {
      merged.id = firstText(merged.id, id);
      merged.platform_project_id = firstText(merged.platform_project_id, id);
      merged.base_project_id = firstText(merged.base_project_id, id);
    }
    const contact = primaryProjectContact(merged);
    if ((!Array.isArray(merged.contacts) || !merged.contacts.length) && firstText(contact.name, contact.email, contact.phone)) {
      merged.contacts = [{ ...contact, primary: true }];
    }
    return withProjectDisplayAliases(merged);
  }
  function updatePhotoRoute(item = {}, scope = 'feed'){
    const photo = item.photo || item;
    const project = item.project || photo.__project || {};
    const photoId = mediaRouteId(photo);
    if (!photoId) return;
    const patch = { photo: photoId, photoScope: scope };
    if (scope === 'project') patch.projectTab = 'photos';
    else patch.tab = TAB_ID;
    const projectId = projectRouteId(project);
    if (projectId) patch.project = projectId;
    window.Portal?.routeState?.set?.(patch);
  }
  function clearPhotoRoute(scope = ''){
    const route = window.Portal?.routeState?.get?.() || {};
    if (scope && route.photoScope && route.photoScope !== scope) return;
    const patch = { photo: null, photoScope: null };
    window.Portal?.routeState?.set?.(patch);
  }
  function photoSizeBytes(photo = {}){
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return Math.max(0, Number(photo.size_bytes || photo.sizeBytes || meta.size_bytes || meta.original_size_bytes || meta.bytes || 0));
  }
  function isVideoMedia(photo = {}){
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    const explicit = cleanText(photo.media_type || photo.mediaType || photo.type || meta.media_type || meta.mediaType || meta.type).toLowerCase();
    if (explicit.startsWith('video')) return true;
    if (explicit.startsWith('image')) return false;
    const mime = cleanText(photo.mime_type || photo.mimeType || photo.content_type || photo.contentType || meta.mime_type || meta.mimeType || meta.content_type || meta.contentType).toLowerCase();
    if (mime.startsWith('video/')) return true;
    const url = cleanText(photo.src || photo.url || photo.thumb || photo.label || '').toLowerCase();
    return /\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/.test(url);
  }
  function isPhotoTrashed(photo = {}){
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return !!(photo.trashed_at || photo.deleted_at || meta.trashed_at || meta.deleted_at || meta.in_trash || photo.in_trash);
  }
  function withTrashState(photo = {}, trashed = true){
    const now = new Date().toISOString();
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    const nextMeta = { ...meta };
    if (trashed) {
      nextMeta.trashed_at = nextMeta.trashed_at || now;
      nextMeta.deleted_at = nextMeta.deleted_at || now;
      nextMeta.in_trash = true;
      return { ...photo, trashed_at: photo.trashed_at || now, deleted_at: photo.deleted_at || now, in_trash: true, metadata: nextMeta };
    }
    delete nextMeta.trashed_at;
    delete nextMeta.deleted_at;
    delete nextMeta.in_trash;
    const next = { ...photo, in_trash: false, metadata: nextMeta };
    delete next.trashed_at;
    delete next.deleted_at;
    return next;
  }
  function featureEnabled(){
    return !!window.Portal?.appFlags?.has?.('platform', 'project_photos')
      && !!window.Portal?.appFlags?.has?.('platform', 'photos_feed');
  }
  function photoLibrary(){ return window.PlatformAPI?.projectMedia || null; }
  function firstMeasurePhotoOptions(){
    return {
      orgId: orgId(),
      width: 640,
      firstMeasureBaseUrl: cleanText(APP.firstMeasureApiBase || APP.firstmeasureApiBase || ''),
      firstMeasureUrlBuilder: window.Portal?.firstMeasureUrl || null
    };
  }
  function normalizeProjectConfig(config){
    const mode = cleanText(config?.title_mode || config?.project_title_mode || 'customer_name');
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode: ['customer_name', 'address', 'manual'].includes(mode) ? mode : 'customer_name'
    };
  }
  async function loadBranchProjectConfig(){
    if (!window.Portal?.branchModules?.get) return branchProjectConfig;
    try {
      const doc = await window.Portal.branchModules.get(PROJECT_CONFIG_MODULE_ID);
      branchProjectConfig = normalizeProjectConfig(doc?.data || doc || {});
    } catch (error) {
      branchProjectConfig = normalizeProjectConfig(null);
      if (Number(error?.status || 0) !== 404) console.warn('Unable to load Photo Feed project configuration', error);
    }
    return branchProjectConfig;
  }
  function primaryProjectContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const contact = contacts.find((entry) => firstText(entry?.name, entry?.email, entry?.phone)) || {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    return {
      name: firstText(contact.name, typeof project.resident === 'string' ? project.resident : '', project.resident_name, project.residentName, project.customer_name, project.primary_contact_name, resident.name, customer.name),
      email: firstText(contact.email, project.resident_email, project.residentEmail, project.customer_email, project.primary_contact_email, resident.email, customer.email),
      phone: firstText(contact.phone, project.resident_phone, project.residentPhone, project.customer_phone, project.primary_contact_phone, resident.phone, customer.phone)
    };
  }
  function withProjectDisplayAliases(project = {}){
    const contact = primaryProjectContact(project);
    return {
      ...project,
      customer_name: firstText(project.customer_name, project.customerName, contact.name),
      primary_contact_name: firstText(project.primary_contact_name, contact.name),
      customer_email: firstText(project.customer_email, contact.email),
      primary_contact_email: firstText(project.primary_contact_email, contact.email),
      customer_phone: firstText(project.customer_phone, contact.phone),
      primary_contact_phone: firstText(project.primary_contact_phone, contact.phone)
    };
  }
  function savedProjectTitle(project = {}){
    const title = firstText(project.title, project.project_title, project.project_name, project.projectName, project.name);
    const address = projectAddress(project);
    return title && title.toLowerCase() !== address.toLowerCase() ? title : '';
  }
  function projectTitle(project = {}){
    const savedTitle = savedProjectTitle(project);
    if (savedTitle) return savedTitle;
    const mode = branchProjectConfig?.title_mode || 'customer_name';
    const contact = primaryProjectContact(project);
    const address = projectAddress(project);
    if (mode === 'manual') return firstText(contact.name, address, 'Untitled project');
    if (mode === 'address') return firstText(address, contact.name, 'Untitled project');
    return firstText(contact.name, address, 'Untitled project');
  }
  function projectAddress(project = {}){
    return firstText(project.address, project.project_address, project.property_address, project.formatted_address);
  }
  function projectSubtitle(project = {}){
    const title = projectTitle(project);
    const address = projectAddress(project);
    if (address && address.toLowerCase() !== title.toLowerCase()) return address;
    const contact = primaryProjectContact(project);
    if (contact.name && contact.name.toLowerCase() !== title.toLowerCase()) return contact.name;
    return '';
  }
  function parseDate(value){
    const date = value instanceof Date ? value : new Date(value || '');
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function dateKey(value){
    const date = parseDate(value) || new Date(0);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function dateLabel(key){
    const today = dateKey(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    if (key === today) return 'Today';
    if (key === dateKey(yesterdayDate)) return 'Yesterday';
    const date = parseDate(`${key}T12:00:00`);
    return date ? date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : key;
  }
  function photoUploadedAt(photo = {}){
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return cleanText(photo.uploaded_at || photo.created_at || meta.uploaded_at || meta.created_at || photo.updated_at || meta.updated_at || new Date(0).toISOString());
  }
  function uploader(photo = {}){
    return window.FirstMateMarkup?.uploader?.(photo) || { name: '', email: '', at: photoUploadedAt(photo) };
  }
  function userModalsEnabled(){
    const appFlags = window.Portal?.appFlags;
    const current = window.Portal?.appFlags?.current?.();
    if (!current) return true;
    if (current?.missing === true) return true;
    const value = appFlags?.value?.('platform', 'user_modals', undefined);
    if (typeof value === 'boolean') return value;
    return appFlags?.has?.('platform', 'user_modals') || true;
  }
  function userActivityEnabled(){
    const appFlags = window.Portal?.appFlags;
    const value = appFlags?.value?.('platform', 'user_activity', undefined);
    if (typeof value === 'boolean') return value;
    return !!appFlags?.has?.('platform', 'user_activity');
  }
  function activityIcon(type = ''){
    if (type === 'photo_uploaded' || type === 'media_uploaded') return 'fa-upload';
    if (type === 'photo_commented') return 'fa-comment';
    if (type === 'roof_report_ordered') return 'fa-ruler-combined';
    if (type === 'proposal_started') return 'fa-file-signature';
    return 'fa-bolt';
  }
  function activityLabel(type = ''){
    return ({
      photo_uploaded: 'Uploaded media',
      media_uploaded: 'Uploaded media',
      photo_commented: 'Commented on media',
      roof_report_ordered: 'Ordered a roof report',
      proposal_started: 'Started a proposal'
    }[type] || 'Activity');
  }
  function activityTime(value){
    return window.FirstMateMarkup?.formatDateTime?.(value) || cleanText(value);
  }
  function activityTarget(event = {}){
    return event.target && typeof event.target === 'object' ? event.target : {};
  }
  function activityProjectId(event = {}){
    const target = activityTarget(event);
    return cleanText(target.project_id || target.projectId || event.project_id || event.projectId);
  }
  function activityMediaId(event = {}){
    const target = activityTarget(event);
    return cleanText(target.media_id || target.mediaId || target.photo_id || target.photoId || event.media_id || event.photo_id);
  }
  function activityProjectLabel(event = {}){
    const target = activityTarget(event);
    return cleanText(target.project_title || target.project_name || target.project_address || event.project_title || event.project_address);
  }
  function activityLinkHtml(event = {}, index = 0){
    const projectId = activityProjectId(event);
    const mediaId = activityMediaId(event);
    const links = [];
    if (mediaId) {
      links.push(`<button type="button" class="pf-activity-link" data-activity-photo-open="${index}"><i class="fas fa-image"></i> Open media</button>`);
    }
    if (projectId || activityProjectLabel(event)) {
      links.push(`<button type="button" class="pf-activity-link" data-activity-project-open="${index}"><i class="fas fa-folder-open"></i> Open project</button>`);
    }
    return links.length ? `<div class="pf-activity-links">${links.join('')}</div>` : '';
  }
  function renderActivityList(events = []){
    if (!events.length) {
      return '<div class="pf-user-empty"><i class="fas fa-clock-rotate-left"></i><strong>No activity yet</strong><span>Tracked uploads, comments, and report orders will appear here.</span></div>';
    }
    const days = new Map();
    events.forEach((event, index) => {
      const key = dateKey(event.occurred_at || event.created_at);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push({ event, index });
    });
    return [...days.entries()].map(([key, list]) => `
      <section class="pf-activity-day">
        <h3>${escapeHtml(dateLabel(key))}</h3>
        ${list.map(({ event, index }) => {
          const project = activityProjectLabel(event);
          return `
            <article class="pf-activity-item">
              <span class="pf-activity-icon"><i class="fas ${activityIcon(event.type)}"></i></span>
              <div>
                <strong>${escapeHtml(event.summary || activityLabel(event.type))}</strong>
                <span>${escapeHtml([project, activityTime(event.occurred_at || event.created_at)].filter(Boolean).join(' - '))}</span>
                ${activityLinkHtml(event, index)}
              </div>
            </article>
          `;
        }).join('')}
      </section>
    `).join('');
  }
  function findActivityProject(event = {}){
    const projectId = activityProjectId(event);
    const label = activityProjectLabel(event).toLowerCase();
    return (state.projects || []).find((project) => (
      (projectId && cleanText(project.id) === projectId)
      || (label && [projectTitle(project), projectAddress(project)].map((value) => value.toLowerCase()).includes(label))
    )) || null;
  }
  function findActivityItem(event = {}){
    const mediaId = activityMediaId(event);
    const projectId = activityProjectId(event);
    if (!mediaId) return null;
    return (state.items || []).find((item) => {
      const ids = [photoIdentity(item.photo), mediaRouteId(item.photo), item.photo?.media_id, item.photo?.id, item.photo?.photo_id].map(cleanText);
      const projectMatches = !projectId || cleanText(item.projectId || item.project?.id) === projectId;
      return projectMatches && ids.includes(mediaId);
    }) || null;
  }
  async function ensureActivityDataLoaded(){
    if (!state.loaded && !state.loading) await load().catch(() => null);
  }
  async function openActivityProject(event = {}){
    await ensureActivityDataLoaded();
    const projectId = activityProjectId(event);
    const project = findActivityProject(event)
      || (projectId ? await window.Portal?.routeState?.resolveProject?.(projectId).catch(() => null) : null);
    if (project) {
      openProject(project);
      return;
    }
    showToast?.('Project not found', 'Could not find the project for that activity yet.', false);
  }
  async function openActivityPhoto(event = {}, options = {}){
    await ensureActivityDataLoaded();
    const item = findActivityItem(event);
    if (!item) {
      await openActivityProject(event);
      return;
    }
    const items = state.items.filter((entry) => !isPhotoTrashed(entry.photo));
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      updatePhotoRoute(item, 'feed');
      window.FirstMateMarkup?.openPhotoViewer?.({
        photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
        index,
        project: item.project || {},
        onOpenProject: openProject,
        boundsTarget: options.boundsTarget || null,
        onChange: ({ photo, project }) => updatePhotoRoute({ photo, project: project || photo?.__project || item.project }, 'feed'),
        onClose: () => clearPhotoRoute('feed')
      });
    } else {
      await openActivityProject(event);
    }
  }
  function bindActivityLinks(root, events = []){
    root?.querySelectorAll?.('[data-activity-project-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const index = Number(btn.dataset.activityProjectOpen || -1);
        openActivityProject(events[index] || {}).catch(() => null);
      });
    });
    root?.querySelectorAll?.('[data-activity-photo-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const index = Number(btn.dataset.activityPhotoOpen || -1);
        openActivityPhoto(events[index] || {}, {
          boundsTarget: root.closest?.('.pf-user-shell') || root.closest?.('.pf-user-modal') || null
        }).catch(() => null);
      });
    });
  }
  async function trackActivity(event = {}, metadata = {}){
    const oid = orgId();
    if (!oid || !window.PlatformAPI?.userActivity?.track) return null;
    return window.PlatformAPI.userActivity.track(oid, {
      actor_user_id: cleanText(event.actor_user_id || APP.userId || window.__APP?.userId || ''),
      actor_name: cleanText(event.actor_name || APP.userName || window.__APP?.userName || ''),
      actor_email: cleanText(event.actor_email || APP.userEmail || window.__APP?.userEmail || ''),
      occurred_at: new Date().toISOString(),
      ...event
    }, metadata).catch((error) => {
      console.warn('Could not track user activity', error);
      return null;
    });
  }
  function userKey(user = {}){
    return cleanText(user.id || user.email || user.name).toLowerCase();
  }
  function uploaderUsers(items = []){
    const users = new Map();
    items.forEach((item) => {
      const up = uploader(item.photo);
      const key = userKey(up);
      if (!key) return;
      users.set(key, {
        id: cleanText(up.id),
        name: cleanText(up.name || up.email || 'Unknown user'),
        email: cleanText(up.email),
        avatar: cleanText(up.avatar),
        key
      });
    });
    return [...users.values()];
  }
  function userListLabel(items = []){
    const names = uploaderUsers(items).map((user) => user.name || user.email).filter(Boolean);
    if (!names.length) return 'Unknown uploader';
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  }
  function userListHtml(items = []){
    const users = uploaderUsers(items);
    if (!users.length) return '<span>Unknown uploader</span>';
    if (!userModalsEnabled()) return escapeHtml(userListLabel(items));
    return users.map((user) => `<button type="button" class="pf-user-link" data-photo-user-open="${escapeHtml(user.key)}">${escapeHtml(user.name || user.email || 'User')}</button>`).join('<span class="pf-user-sep">,</span> ');
  }
  function itemTags(item = {}){
    const meta = item.photo?.metadata && typeof item.photo.metadata === 'object' ? item.photo.metadata : {};
    return [...new Set([...(Array.isArray(item.photo?.tags) ? item.photo.tags : []), ...(Array.isArray(meta.tags) ? meta.tags : [])].map(cleanText).filter(Boolean))];
  }
  function searchableText(item = {}){
    const up = uploader(item.photo);
    return [
      item.projectTitle,
      item.projectAddress,
      item.photo?.label,
      item.photo?.alt,
      up.name,
      up.email,
      photoUploadedAt(item.photo),
      dateLabel(dateKey(photoUploadedAt(item.photo))),
      ...itemTags(item).map((tag) => `#${tag}`)
    ].join(' ').toLowerCase();
  }
  function fallbackProjectPhotos(data = {}){
    const source = data && typeof data === 'object' ? data : {};
    const candidates = [
      source.photos,
      source.media,
      source.project_media,
      source.projectMedia,
      source.media_items,
      source.mediaItems,
      source.gallery
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    const mediaFields = window.PlatformAPI?.mediaFields;
    if (mediaFields?.list) {
      for (const field of ['photos', 'media', 'project_media', 'media_items', 'gallery']) {
        const list = mediaFields.list(source, field);
        if (list.length) return list;
      }
    }
    return [];
  }
  function hydrateProject(doc = {}){
    const source = doc && typeof doc === 'object' ? doc : {};
    const data = source.data && typeof source.data === 'object' ? source.data : source;
    const documentId = source.data && typeof source.data === 'object' ? cleanText(source.id) : '';
    const dataId = cleanText(data.id);
    const platformId = cleanText(data.platform_project_id || data.base_project_id || documentId);
    const title = firstText(data.title, data.project_title, data.project_name, data.projectName, data.name);
    const project = withProjectDisplayAliases({
      ...data,
      id: platformId || dataId || documentId,
      platform_project_id: cleanText(data.platform_project_id || platformId),
      base_project_id: cleanText(data.base_project_id || platformId),
      photos: Array.isArray(data.photos) && data.photos.length ? data.photos : fallbackProjectPhotos(data),
      title: title || cleanText(data.title),
      project_title: cleanText(data.project_title || title)
    });
    const library = photoLibrary();
    return library?.hydrateProjectPhotos
      ? withProjectDisplayAliases(library.hydrateProjectPhotos(project, firstMeasurePhotoOptions()))
      : project;
  }
  function normalizePhotos(project = {}){
    const library = photoLibrary();
    const safeProject = project && typeof project === 'object' ? project : {};
    const photos = library?.normalizePhotos
      ? library.normalizePhotos(safeProject.photos || [], firstMeasurePhotoOptions())
      : (Array.isArray(safeProject.photos) ? safeProject.photos : []);
    return photos
      .filter((photo) => photo && (photo.media_id || photo.src || photo.thumb))
      .filter((photo) => !photo.is_top_down_thumbnail && cleanText(photo.designator) !== 'top_down_thumbnail');
  }
  function projectPhotosRaw(project = {}){
    const source = project && typeof project === 'object' ? project : {};
    return Array.isArray(source.photos) ? source.photos : [];
  }
  function mediaOwnerProjectId(item = {}){
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const owner = item.owner && typeof item.owner === 'object'
      ? item.owner
      : (metadata.owner && typeof metadata.owner === 'object' ? metadata.owner : {});
    const ownerType = cleanText(owner.type || item.owner_type || item.ownerType || metadata.owner_type || metadata.ownerType).toLowerCase();
    const collection = cleanText(owner.collection || item.collection || metadata.collection).toLowerCase();
    const slot = cleanText(owner.slot || item.slot || metadata.slot).toLowerCase();
    const looksProjectOwned = ownerType === 'project' || collection === 'projects' || (slot === 'photos' && ownerType !== 'organization');
    return looksProjectOwned ? firstText(owner.id, item.owner_id, item.ownerId, metadata.owner_id, metadata.ownerId) : '';
  }
  function mediaReferenceFromItem(item = {}){
    if (!item || typeof item !== 'object') return null;
    const mediaId = firstText(item.media_id, item.mediaId, item.id);
    if (!mediaId) return null;
    if (window.PlatformAPI?.media?.referenceFromUpload) {
      return window.PlatformAPI.media.referenceFromUpload(item, { field: 'photos', variant: 'original' });
    }
    return {
      kind: 'media_reference',
      media_id: mediaId,
      id: mediaId,
      field: 'photos',
      variant: 'original',
      file_name: firstText(item.file_name, item.fileName),
      content_type: firstText(item.content_type, item.contentType),
      size_bytes: Number(item.size_bytes || item.sizeBytes || 0),
      uploaded_at: firstText(item.created_at, item.uploaded_at, item.updated_at),
      updated_at: firstText(item.updated_at, item.created_at),
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      owner: item.owner && typeof item.owner === 'object' ? item.owner : {}
    };
  }
  function attachOwnedMedia(projects = [], mediaItems = []){
    const byId = new Map();
    const order = [];
    const ensureProject = (id) => {
      const key = cleanText(id);
      if (!key) return null;
      if (!byId.has(key)) {
        byId.set(key, withProjectDisplayAliases({ id: key, platform_project_id: key, base_project_id: key, photos: [] }));
        order.push(key);
      }
      return byId.get(key);
    };
    projects.forEach((project) => {
      const id = cleanText(project?.id || project?.platform_project_id || project?.base_project_id);
      if (!id) return;
      byId.set(id, { ...(project || {}), photos: Array.isArray(project?.photos) ? [...project.photos] : [] });
      order.push(id);
    });
    (Array.isArray(mediaItems) ? mediaItems : []).forEach((item) => {
      const projectId = mediaOwnerProjectId(item);
      const project = ensureProject(projectId);
      const reference = mediaReferenceFromItem(item);
      if (!project || !reference) return;
      const id = firstText(reference.media_id, reference.id);
      const exists = (Array.isArray(project.photos) ? project.photos : []).some((photo) => firstText(photo?.media_id, photo?.mediaId, photo?.id) === id);
      if (!exists) project.photos = [...(Array.isArray(project.photos) ? project.photos : []), reference];
    });
    return order.map((id) => byId.get(id)).filter(Boolean);
  }
  function buildItems(projects = []){
    return projects.flatMap((project) => normalizePhotos(project).map((photo, index) => {
      const uploadedAt = photoUploadedAt(photo);
      return {
        id: `${project.id || 'project'}::${photo.media_id || photo.id || photo.src || index}`,
        project,
        projectId: project.id || '',
        projectTitle: projectTitle(project),
        projectAddress: projectAddress(project),
        projectSubtitle: projectSubtitle(project),
        photo,
        uploadedAt,
        dateKey: dateKey(uploadedAt),
        search: ''
      };
    })).map((item) => ({ ...item, search: searchableText(item) }))
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }
  function buildGroups(items = []){
    const groups = new Map();
    items.forEach((item) => {
      const key = `${item.dateKey}::${item.projectId || item.projectTitle}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          dateKey: item.dateKey,
          projectId: item.projectId,
          project: item.project,
          projectTitle: item.projectTitle,
          projectAddress: item.projectAddress,
          projectSubtitle: item.projectSubtitle,
          items: [],
          latestAt: item.uploadedAt
        });
      }
      const group = groups.get(key);
      group.items.push(item);
      if (String(item.uploadedAt).localeCompare(String(group.latestAt)) > 0) group.latestAt = item.uploadedAt;
    });
    return [...groups.values()].sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)));
  }
  function filteredItems(){
    const query = cleanText(state.query).toLowerCase();
    const modeItems = state.items.filter((item) => state.trashMode ? isPhotoTrashed(item.photo) : !isPhotoTrashed(item.photo));
    if (!query) return modeItems;
    return modeItems.filter((item) => item.search.includes(query) || itemTags(item).some((tag) => tag.toLowerCase().includes(query.replace(/^#/, ''))));
  }
  function selectedItems(){
    const selected = state.selected || new Set();
    return filteredItems().filter((item) => selected.has(item.id));
  }
  function allTrashItems(projects = state.projects){
    return buildItems(projects || []).filter((item) => isPhotoTrashed(item.photo));
  }
  function trashStatsFromItems(items = []){
    const count = items.length;
    const bytes = items.reduce((sum, item) => sum + photoSizeBytes(item.photo), 0);
    return { count, bytes };
  }
  function formatBytes(bytes){
    return window.PlatformAPI?.mediaStorage?.formatBytes?.(bytes) || `${Math.round(Number(bytes || 0) / (1024 * 1024))} MB`;
  }
  function setSelectionMode(active){
    state.selectionMode = !!active;
    if (!state.selectionMode) {
      state.selected.clear();
      state.selectionAnchorId = '';
      state.dragSelecting = false;
      state.dragStartId = '';
      state.dragStartX = 0;
      state.dragStartY = 0;
      state.dragMode = 'add';
      state.dragMoved = false;
      state.dragLeftStartTile = false;
      state.dragPreview.clear();
      state.suppressClickId = '';
      state.downloadMenuOpen = false;
    }
  }
  function toggleSelection(itemId, event = {}){
    const items = filteredItems();
    const ids = items.map((item) => item.id);
    if (!itemId || !ids.includes(itemId)) return;
    state.selectionMode = true;
    if (event.shiftKey && state.selectionAnchorId && ids.includes(state.selectionAnchorId)) {
      const a = ids.indexOf(state.selectionAnchorId);
      const b = ids.indexOf(itemId);
      const [start, end] = a < b ? [a, b] : [b, a];
      if (!event.ctrlKey && !event.metaKey) state.selected.clear();
      ids.slice(start, end + 1).forEach((id) => state.selected.add(id));
    } else {
      if (state.selected.has(itemId)) state.selected.delete(itemId);
      else state.selected.add(itemId);
      state.selectionAnchorId = itemId;
    }
    if (!state.selected.size) setSelectionMode(false);
  }
  function applySelection(itemId, event = {}){
    const items = filteredItems();
    const ids = items.map((item) => item.id);
    if (!itemId || !ids.includes(itemId)) return;
    state.selectionMode = true;
    if (event.shiftKey && state.selectionAnchorId && ids.includes(state.selectionAnchorId)) {
      const a = ids.indexOf(state.selectionAnchorId);
      const b = ids.indexOf(itemId);
      const [start, end] = a < b ? [a, b] : [b, a];
      if (!event.ctrlKey && !event.metaKey) state.selected.clear();
      ids.slice(start, end + 1).forEach((id) => state.selected.add(id));
    } else if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(itemId)) state.selected.delete(itemId);
      else state.selected.add(itemId);
      state.selectionAnchorId = itemId;
    } else if (event.dragSelect) {
      state.selected.add(itemId);
      state.selectionAnchorId ||= itemId;
    } else {
      if (state.selected.has(itemId) && state.selected.size === 1) state.selected.clear();
      else {
        state.selected.clear();
        state.selected.add(itemId);
      }
      state.selectionAnchorId = itemId;
    }
    if (!state.selected.size) setSelectionMode(false);
  }
  function setTilePreview(id, active){
    const tile = state.root?.querySelector?.(`[data-photo-feed-id="${CSS.escape(id)}"]`);
    tile?.classList.toggle('selected', !!active);
    tile?.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  function bindThumbLoading(root = document){
    root.querySelectorAll?.('.pf-thumb img').forEach((img) => {
      const tile = img.closest('.pf-thumb');
      if (!tile) return;
      const baseSrc = img.dataset.baseSrc || img.currentSrc || img.src || '';
      img.dataset.baseSrc = baseSrc;
      const retry = () => {
        if (tile.classList.contains('loaded')) return;
        const tries = Number(img.dataset.thumbRetries || 0);
        const originalSrc = img.dataset.originalSrc || '';
        if (tries >= 3 && img.dataset.mediaKind === 'video' && originalSrc) {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.src = originalSrc;
          video.addEventListener('loadeddata', () => {
            tile.classList.add('loaded');
            tile.classList.remove('error');
          }, { once: true });
          video.addEventListener('error', () => tile.classList.add('error'), { once: true });
          img.replaceWith(video);
          return;
        }
        if (tries >= 3 && originalSrc && originalSrc !== baseSrc && img.src !== originalSrc) {
          img.dataset.thumbRetries = String(tries + 1);
          tile.classList.remove('error');
          img.src = originalSrc;
          return;
        }
        if (!baseSrc || tries >= 4) {
          tile.classList.add('error');
          return;
        }
        img.dataset.thumbRetries = String(tries + 1);
        tile.classList.remove('error');
        const separator = baseSrc.includes('?') ? '&' : '?';
        img.src = `${baseSrc}${separator}_pf_retry=${Date.now()}_${tries + 1}`;
      };
      const markLoaded = () => {
        tile.classList.add('loaded');
        tile.classList.remove('error');
      };
      const markError = () => {
        window.setTimeout(retry, 450);
      };
      if (img.complete && img.naturalWidth > 0) markLoaded();
      else if (img.complete) window.setTimeout(retry, 450);
      else window.setTimeout(retry, 3500);
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markError);
    });
    root.querySelectorAll?.('.pf-thumb video').forEach((video) => {
      const tile = video.closest('.pf-thumb');
      if (!tile) return;
      const markLoaded = () => {
        tile.classList.add('loaded');
        tile.classList.remove('error');
      };
      if (video.readyState >= 2) markLoaded();
      else video.addEventListener('loadeddata', markLoaded, { once: true });
      video.addEventListener('error', () => tile.classList.add('error'), { once: true });
    });
  }
  function dragRangeIds(endId){
    const ids = filteredItems().map((item) => item.id);
    const a = ids.indexOf(state.dragStartId);
    const b = ids.indexOf(endId);
    if (a < 0 || b < 0) return [];
    const [start, end] = a < b ? [a, b] : [b, a];
    return ids.slice(start, end + 1);
  }
  function previewDragRange(endId){
    const nextPreview = new Set(dragRangeIds(endId));
    state.dragPreview.forEach((id) => {
      if (!nextPreview.has(id)) setTilePreview(id, state.selected.has(id));
    });
    nextPreview.forEach((id) => setTilePreview(id, state.dragMode !== 'remove'));
    state.dragPreview = nextPreview;
  }
  function commitDragSelection(){
    if (!state.dragPreview.size) return false;
    if (state.dragMode === 'remove') state.dragPreview.forEach((id) => state.selected.delete(id));
    else state.dragPreview.forEach((id) => state.selected.add(id));
    state.selectionAnchorId = [...state.dragPreview].at(-1) || state.selectionAnchorId;
    state.dragPreview.clear();
    if (!state.selected.size) setSelectionMode(false);
    else state.selectionMode = true;
    return true;
  }
  function startDragSelectionCandidate(itemId, event = {}){
    if (!itemId || event.button > 0) return;
    state.dragSelecting = true;
    state.dragStartId = itemId;
    state.dragStartX = event.clientX || 0;
    state.dragStartY = event.clientY || 0;
    state.dragMode = state.selected.has(state.dragStartId) ? 'remove' : 'add';
    state.dragMoved = false;
    state.dragLeftStartTile = false;
    state.dragPreview.clear();
  }
  function feedTileAtPoint(event){
    return document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-photo-feed-id]') || null;
  }
  function isSelectionControlAtPoint(event){
    return !!document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-photo-select]');
  }
  function handleTileClickLike(itemId, event = {}){
    if (!itemId) return;
    if (state.selectionMode || state.trashMode) {
      toggleSelection(itemId, event);
      render();
      return;
    }
    const items = filteredItems();
    const index = Math.max(0, items.findIndex((item) => item.id === itemId));
    openFeedViewerAt(index);
  }
  async function resolveProjectForOpen(project = {}, groupKey = ''){
    const id = projectRouteId(project) || projectIdFromGroupKey(groupKey);
    let resolved = project && typeof project === 'object' ? project : {};
    if (id && !sameProjectId(resolved, id)) {
      resolved = mergeProjectDetails({ id, platform_project_id: id, base_project_id: id }, resolved);
    }
    const local = id ? (state.projects || []).find((entry) => sameProjectId(entry, id)) : null;
    if (local) resolved = mergeProjectDetails(local, resolved);
    if (id && window.Portal?.routeState?.resolveProject) {
      const routed = await window.Portal.routeState.resolveProject(id).catch(() => null);
      if (routed) resolved = mergeProjectDetails(routed, resolved);
    }
    if (id && window.PlatformAPI?.projects?.get) {
      const oid = orgId();
      const remote = oid ? await window.PlatformAPI.projects.get(oid, id).catch(() => null) : null;
      const hydrated = remote?.document ? hydrateProject(remote.document) : null;
      if (hydrated) resolved = mergeProjectDetails(hydrated, resolved);
    }
    return withProjectDisplayAliases(resolved);
  }
  async function openProject(project = {}, options = {}){
    const resolved = await resolveProjectForOpen(project, options.groupKey || '');
    if (!resolved || !Object.keys(resolved).length) return;
    const id = projectRouteId(resolved);
    if (!id && !firstText(resolved.address, resolved.customer_name, resolved.primary_contact_name)) return;
    await window.Portal?.modules?.request?.openProject?.(resolved, { tab: 'photos' });
  }
  function filteredGroups(){
    return buildGroups(filteredItems());
  }
  function injectStyles(){
    injectCSS('photos_feed', `
      .pf-wrap{height:100%;display:flex;flex-direction:column;background:transparent;color:#101828;max-width:1500px;margin:0 auto;width:100%;min-height:0}
      .pf-toolbar{position:sticky;top:0;z-index:4;background:transparent;border:0;padding:0 0 14px;display:flex;align-items:center;justify-content:space-between;gap:14px}
      .pf-title{display:flex;align-items:center;gap:11px;min-width:0}.pf-title i{width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center}.pf-title strong{font-size:18px;line-height:1.15}.pf-title span{display:block;color:#667085;font-size:12px;margin-top:2px}
      .pf-tools{display:flex;align-items:center;gap:10px;min-width:0}.pf-search{position:relative;width:min(360px,34vw)}.pf-search i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#98a2b3}.pf-search input{width:100%;height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 12px 0 36px;font:inherit;font-size:13px;outline:none}.pf-search input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
      .pf-density{display:flex;border:1px solid #d0d5dd;border-radius:10px;overflow:hidden;background:#fff}.pf-density button{width:38px;height:36px;border:0;background:#fff;color:#667085;cursor:pointer}.pf-density button.active{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary,#d93025)}
      .pf-refresh{height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;font-weight:800;cursor:pointer}
      .pf-upload{height:38px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;font-size:12px;font-weight:900;cursor:pointer;display:flex;align-items:center;gap:8px}.pf-upload:hover{border-color:var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
      .pf-selectionbar{position:sticky;top:52px;z-index:3;margin:0 0 12px;border:1px solid #e4e7ec;border-radius:14px;background:rgba(255,255,255,.96);backdrop-filter:blur(14px);padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .pf-selectionbar strong{font-size:13px}.pf-selection-actions{display:flex;align-items:center;gap:8px}.pf-action{height:34px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 11px;font-size:12px;font-weight:900;cursor:pointer}.pf-action.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}.pf-action.danger{border-color:#fecdca;color:#b42318;background:#fff5f5}.pf-action.danger:hover{background:#fee4e2}.pf-download-wrap{position:relative}.pf-download-menu{position:absolute;right:0;top:40px;z-index:6;width:190px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 18px 44px rgba(15,23,42,.16);padding:6px;display:none}.pf-download-menu.visible{display:block}.pf-download-menu button{width:100%;border:0;background:transparent;border-radius:9px;padding:10px;text-align:left;font-size:12px;font-weight:900;color:#344054;cursor:pointer}.pf-download-menu button:hover{background:#f2f4f7}
      .pf-scroll{overflow:auto;flex:1;padding:0 2px 16px;min-height:0}.pf-day{margin-bottom:26px}.pf-day-title{font-size:13px;font-weight:1000;color:#344054;text-transform:uppercase;letter-spacing:.06em;margin:0 0 12px}
      .pf-group{background:#fff;border:1px solid #eaecf0;border-radius:8px;margin-bottom:14px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .pf-group-head{padding:13px 14px;border-bottom:1px solid #f2f4f7;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.pf-group-head strong{font-size:14px}.pf-group-head span{display:block;color:#667085;font-size:12px;margin-top:3px}.pf-project-link{border:0;background:transparent;color:#101828;padding:0;font:inherit;font-size:14px;font-weight:1000;cursor:pointer;text-align:left}.pf-project-link:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}.pf-uploaders{font-size:12px;color:#475467;text-align:right;max-width:320px}.pf-user-link{border:0;background:transparent;color:#475467;padding:0;font:inherit;font-size:12px;font-weight:900;cursor:pointer}.pf-user-link:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}.pf-user-sep{color:#98a2b3}
      .pf-grid{display:grid;gap:6px;padding:8px}.pf-wrap[data-density="loose"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}.pf-wrap[data-density="comfortable"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(154px,1fr))}.pf-wrap[data-density="compact"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}
      .pf-thumb{position:relative;aspect-ratio:1;border:2px solid transparent;border-radius:7px;overflow:hidden;background:#f2f4f7;padding:0;cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;user-select:none;-webkit-user-drag:none}.pf-thumb::before{content:'';position:absolute;left:50%;top:50%;z-index:1;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:999px;border:3px solid rgba(148,163,184,.32);border-top-color:var(--primary,#d93025);animation:pfSpin .8s linear infinite}.pf-thumb.loaded::before,.pf-thumb.error::before,.pf-thumb.video-placeholder::before{display:none}.pf-thumb.error::after{content:'\\f03e';font-family:'Font Awesome 6 Free';font-weight:900;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#98a2b3;font-size:22px}.pf-thumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .18s ease,transform .18s ease;user-select:none;-webkit-user-drag:none;pointer-events:none}.pf-thumb.loaded img{opacity:1}.pf-thumb:hover img{transform:scale(1.04)}.pf-video-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#101828;color:#fff;font-size:28px}.pf-video-badge{position:absolute;right:8px;bottom:8px;z-index:2;width:30px;height:30px;border-radius:999px;background:rgba(15,23,42,.78);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 8px 16px rgba(15,23,42,.16);pointer-events:none}.pf-wrap.selection-mode .pf-thumb{transform:scale(.96)}.pf-wrap.selection-mode .pf-thumb:hover img{transform:scale(1)}.pf-thumb.selected{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.18)}.pf-thumb.selected img{transform:scale(.95)}.pf-select{position:absolute;top:7px;left:7px;z-index:3;width:24px;height:24px;border-radius:8px;border:1px solid rgba(255,255,255,.76);background:rgba(15,23,42,.56);color:#fff;display:flex;align-items:center;justify-content:center;opacity:0;cursor:pointer;backdrop-filter:blur(10px)}.pf-thumb:hover .pf-select,.pf-wrap.selection-mode .pf-select{opacity:1}.pf-select i{font-size:12px;opacity:0}.pf-thumb.selected .pf-select{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}.pf-thumb.selected .pf-select i{opacity:1}.pf-thumb-meta{position:absolute;left:0;right:0;bottom:0;padding:18px 7px 7px;background:linear-gradient(transparent,rgba(0,0,0,.68));color:#fff;font-size:11px;text-align:left;opacity:0;transition:.16s ease}.pf-thumb:hover .pf-thumb-meta{opacity:1}@keyframes pfSpin{to{transform:rotate(360deg)}}
      .pf-thumb video{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .18s ease,transform .18s ease;user-select:none;-webkit-user-drag:none;pointer-events:none}.pf-thumb.loaded video{opacity:1}.pf-thumb:hover video{transform:scale(1.04)}.pf-wrap.selection-mode .pf-thumb:hover video{transform:scale(1)}.pf-thumb.selected video{transform:scale(.95)}.pf-thumb.uploading::after{content:'Uploading';position:absolute;left:8px;top:8px;z-index:3;border-radius:999px;background:rgba(15,23,42,.72);color:#fff;padding:5px 8px;font-size:10px;font-weight:1000}
      .pf-empty{margin:56px auto;max-width:420px;text-align:center;color:#667085}.pf-empty i{font-size:34px;color:#98a2b3;margin-bottom:12px}.pf-empty strong{display:block;color:#344054;margin-bottom:5px}
      .pf-sentinel{height:36px}.pf-loading{padding:18px;text-align:center;color:#667085}
      .pf-user-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(15,23,42,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px}
      .pf-user-shell{width:min(1120px,96vw);height:min(820px,92vh);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:grid;grid-template-columns:280px minmax(0,1fr);overflow:hidden}
      .pf-user-side{padding:22px;border-right:1px solid #eaecf0;background:#f8fafc;min-width:0}.pf-user-close{width:36px;height:36px;flex:0 0 auto;border:1px solid rgba(15,23,42,.1);border-radius:999px;background:#fff;color:#344054;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .pf-user-avatar{width:82px;height:82px;border-radius:24px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:28px;font-weight:1000;margin-bottom:14px}.pf-user-avatar img{width:100%;height:100%;object-fit:cover}
      .pf-user-name{font-size:20px;font-weight:1000;color:#101828;line-height:1.15}.pf-user-contact{margin-top:10px;display:flex;flex-direction:column;gap:8px;color:#475467;font-size:12px;font-weight:800;overflow:hidden}.pf-user-contact span{overflow:hidden;text-overflow:ellipsis}
      .pf-user-main{min-width:0;min-height:0;padding:0;background:#fff;display:flex;flex-direction:column;overflow:hidden}.pf-user-main-head{padding:16px 18px 10px;border-bottom:1px solid #eaecf0;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px}.pf-user-main-title{font-size:13px;font-weight:1000;color:#344054}.pf-user-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}.pf-user-tabs{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;min-width:0}.pf-user-tab{border:1px solid transparent;background:transparent;color:#667085;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:1000;cursor:pointer}.pf-user-tab.active{border-color:rgba(var(--primary-rgb,217,48,37),.22);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}.pf-user-panel{min-height:0;flex:1;padding:18px;display:flex;flex-direction:column;overflow:hidden}
      .pf-user-main .pf-toolbar{position:relative;top:auto;background:transparent}.pf-user-main [data-user-photos],.pf-user-main [data-user-activity]{height:100%;min-height:0;flex:1;overflow:hidden}.pf-user-main .pf-wrap{height:100%;min-height:0;max-width:none}.pf-user-main [data-photo-feed-dynamic]{min-height:0;flex:1;display:flex;flex-direction:column}.pf-user-main [data-photo-feed-dynamic]>.pf-scroll{min-height:0;flex:1}
      .pf-user-activity{height:100%;min-height:0;overflow:auto;padding:2px 4px 18px}.pf-user-empty{min-height:280px;border:1px dashed #d0d5dd;border-radius:14px;color:#667085;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;text-align:center}.pf-user-empty i{font-size:28px;color:#98a2b3}.pf-user-empty strong{color:#344054}.pf-user-empty span{font-size:12px}.pf-activity-day{margin-bottom:22px}.pf-activity-day h3{margin:0 0 10px;color:#344054;font-size:12px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}.pf-activity-item{display:grid;grid-template-columns:38px minmax(0,1fr);gap:11px;padding:12px 0;border-bottom:1px solid #f2f4f7}.pf-activity-icon{width:38px;height:38px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center}.pf-activity-item strong{display:block;color:#101828;font-size:13px}.pf-activity-item span{display:block;color:#667085;font-size:12px;margin-top:3px}.pf-activity-links{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.pf-activity-link{height:28px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;padding:0 10px;font-size:11px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.pf-activity-link:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
      .pf-trash-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(15,23,42,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px}
      .pf-trash-shell{width:min(1220px,96vw);height:min(850px,92vh);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
      .pf-trash-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #eaecf0;background:#fff}.pf-trash-head strong{font-size:18px;font-weight:1000;color:#101828}.pf-trash-head span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850}.pf-trash-close{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;cursor:pointer}.pf-trash-body{min-height:0;flex:1;padding:18px;background:#fff}.pf-trash-body .pf-toolbar{position:relative;top:auto}
      .pf-picker-modal{position:fixed;inset:0;background:rgba(15,23,42,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px}
      .pf-picker-shell{width:min(820px,94vw);max-height:min(760px,90vh);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
      .pf-picker-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #eaecf0;background:#fff}.pf-picker-head strong{font-size:18px;font-weight:1000;color:#101828}.pf-picker-head span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850}.pf-picker-close{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .pf-picker-body{min-height:0;flex:1;overflow:auto;padding:14px;background:#fff}.pf-picker-grid{grid-template-columns:repeat(auto-fill,minmax(124px,1fr));padding:0}.pf-picker-foot{display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid #eaecf0;background:#f8fafc}.pf-picker-foot .pf-action:disabled{opacity:.5;cursor:default}
      .pf-picker-error{margin:0 18px 12px;border:1px solid #fed7aa;border-radius:12px;background:#fff7ed;color:#9a3412;padding:9px 11px;font-size:12px;font-weight:900}
      @media(max-width:760px){.pf-user-shell{grid-template-columns:1fr;height:94vh}.pf-user-side{border-right:0;border-bottom:1px solid #eaecf0}.pf-user-main{min-height:420px}}
      @media(max-width:760px){.main-panels:has(#tab_photos_feed.active){padding-top:0}.pf-toolbar{align-items:center;flex-direction:row;gap:10px;padding:10px 12px;margin:0 -12px 18px;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.10);z-index:20}.pf-title{flex:0 0 30px;min-width:0;max-width:none;gap:0}.pf-title>div{display:none}.pf-title i{width:30px;height:30px;border-radius:9px;font-size:14px;flex:0 0 auto}.pf-tools{flex:1 1 auto;width:auto;min-width:0;gap:8px}.pf-search{width:100%;min-width:0;flex:1 1 auto}.pf-search input{height:34px;border-radius:9px;font-size:12px;padding-left:32px}.pf-search i{left:11px}.pf-density,.pf-refresh{display:none}.pf-wrap .pf-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px}.pf-group-head{flex-direction:column}.pf-uploaders{text-align:left}}
    `);
  }
  async function load(options = {}){
    if (state.loading) return;
    const oid = orgId();
    if (!oid || !window.PlatformAPI?.projects?.list) return;
    state.loading = true;
    render();
    try {
      await loadBranchProjectConfig();
      const [result, mediaResult] = await Promise.all([
        window.PlatformAPI.projects.list(oid),
        window.PlatformAPI.media?.list ? window.PlatformAPI.media.list(oid).catch(() => ({ media: [] })) : Promise.resolve({ media: [] })
      ]);
      const projects = (Array.isArray(result?.documents) ? result.documents : [])
        .filter((doc) => doc && typeof doc === 'object')
        .map(hydrateProject)
        .filter((project) => project && (project.id || project.address || project.title || Array.isArray(project.photos)));
      state.projects = attachOwnedMedia(projects, Array.isArray(mediaResult?.media) ? mediaResult.media : []);
      state.items = buildItems(state.projects);
      state.groups = buildGroups(state.items);
      state.loaded = true;
      state.visible = PAGE_SIZE;
      if (options.toast) showToast?.('Photos feed refreshed');
    } catch (error) {
      console.warn('Could not load photos feed', error);
      showToast?.('Photo Feed issue', error?.message || 'Could not load media.', false);
    } finally {
      state.loading = false;
      render();
      restoreFeedPhotoRoute();
    }
  }
  function rebuildProjectDisplayLabels(){
    if (!state.projects.length) return;
    state.items = buildItems(state.projects);
    state.groups = buildGroups(state.items);
    render();
  }
  function groupedByDay(groups = []){
    const days = new Map();
    groups.forEach((group) => {
      if (!days.has(group.dateKey)) days.set(group.dateKey, []);
      days.get(group.dateKey).push(group);
    });
    return [...days.entries()];
  }
  function photoThumb(item){
    if (item.photo?.media_id && window.PlatformAPI?.media?.thumbnailUrl) return window.PlatformAPI.media.thumbnailUrl(orgId(), item.photo.media_id, 320);
    return item.photo?.thumb || item.photo?.src || '';
  }
  function photoOriginal(item){
    const photo = item?.photo || item || {};
    if (photo.media_id && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId(), photo.media_id, 'original');
    return photo.src || photo.url || photo.thumb || '';
  }
  function mediaThumbHtml(item){
    const thumb = photoThumb(item);
    const original = photoOriginal(item);
    const isVideo = isVideoMedia(item.photo);
    const alt = escapeHtml(item.photo?.alt || item.projectTitle || (isVideo ? 'Video' : 'Photo'));
    const originalAttr = original ? ` data-original-src="${escapeHtml(original)}"` : '';
    if (isVideo) {
      return `${thumb ? `<img loading="lazy" draggable="false" data-media-kind="video" src="${escapeHtml(thumb)}" alt="${alt}"${originalAttr}>` : (original ? `<video muted playsinline preload="metadata" src="${escapeHtml(original)}"></video>` : '<span class="pf-video-placeholder"><i class="fas fa-video"></i></span>')}<span class="pf-video-badge"><i class="fas fa-play"></i></span>`;
    }
    return `<img loading="lazy" draggable="false" src="${escapeHtml(thumb)}" alt="${alt}"${originalAttr}>`;
  }
  function mediaPickerItem(photo = {}, index = 0){
    const normalized = window.PlatformAPI?.projectMedia?.normalizePhoto
      ? window.PlatformAPI.projectMedia.normalizePhoto(photo, { orgId: orgId(), index })
      : {
        ...(photo && typeof photo === 'object' ? photo : {}),
        id: photo?.id || photo?.photo_id || photo?.media_id || photo?.src || photo?.url || `media_${index}`,
        src: photo?.src || photo?.url || photo?.thumb || '',
        thumb: photo?.thumb || photo?.thumbnail || photo?.src || photo?.url || '',
        label: photo?.label || photo?.alt || `Media ${index + 1}`,
      };
    const id = cleanText(normalized.id || normalized.photo_id || normalized.media_id || normalized.src || normalized.thumb || `media_${index}`);
    return {
      id,
      projectId: '',
      projectTitle: '',
      projectAddress: '',
      uploadedAt: normalized.uploaded_at || normalized.created_at || '',
      photo: {
        ...normalized,
        id,
      },
    };
  }
  function normalizePickerItems(photos = [], options = {}){
    return (Array.isArray(photos) ? photos : [])
      .map((photo, index) => mediaPickerItem(photo, index))
      .filter((item) => item.id && item.photo && (!options.imageOnly || !isVideoMedia(item.photo)));
  }
  function closeProjectMediaPicker(overlay, handle, onClose){
    handle?.unregister?.();
    overlay?.remove?.();
    onClose?.();
  }
  function openProjectMediaPicker(options = {}){
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'pf-picker-modal';
    overlay.style.zIndex = String(options.zIndex || 2147483500);
    const multiple = options.multiple !== false;
    const currentPhotos = () => {
      if (typeof options.getPhotos === 'function') {
        const next = options.getPhotos();
        if (Array.isArray(next)) return next;
      }
      return Array.isArray(options.photos) ? options.photos : [];
    };
    const pickerIdForPhoto = (photo, index = 0) => mediaPickerItem(photo, index).id;
    let items = normalizePickerItems(currentPhotos(), { imageOnly: options.imageOnly !== false });
    let selected = new Set(Array.isArray(options.selectedIds) ? options.selectedIds.map(cleanText).filter(Boolean) : []);
    let pickerError = '';
    const title = cleanText(options.title || 'Select Photos');
    const subtitle = cleanText(options.subtitle || 'Choose media from this project.');
    const refreshItems = () => {
      options.photos = currentPhotos();
      items = normalizePickerItems(options.photos, { imageOnly: options.imageOnly !== false });
    };
    const itemMatchesSelectedId = (item, id) => {
      const key = cleanText(id);
      if (!key) return false;
      const photo = item?.photo || {};
      return [item?.id, photo.id, photo.photo_id, photo.media_id, photo.src, photo.thumb, photo.url, photo.thumbnail]
        .some((value) => cleanText(value) === key);
    };
    const confirmLabel = () => {
      const count = selected.size;
      if (options.confirmLabel) return options.confirmLabel(count);
      if (!count) return multiple ? 'Select photos' : 'Select photo';
      return multiple ? `Select ${count} photo${count === 1 ? '' : 's'}` : 'Select photo';
    };
    let handle = null;
    const render = () => {
      overlay.innerHTML = `
        <div class="pf-picker-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="pf-picker-head">
            <div><strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}</div>
            <button type="button" class="pf-picker-close" data-picker-close aria-label="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="pf-picker-body">
            ${items.length ? `
              <div class="pf-grid pf-picker-grid">
                ${items.map((item) => {
                  const selectedClass = selected.has(item.id) ? ' selected' : '';
                  return `<button type="button" class="pf-thumb${selectedClass}${item.photo?.uploading ? ' uploading' : ''}${isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item) ? ' loaded video-placeholder' : ''}" data-picker-media-id="${escapeHtml(item.id)}" aria-pressed="${selected.has(item.id) ? 'true' : 'false'}"><span class="pf-select"><i class="fas fa-check"></i></span>${mediaThumbHtml(item)}<span class="pf-thumb-meta">${escapeHtml(item.photo?.label || item.photo?.alt || 'Project media')}</span></button>`;
                }).join('')}
              </div>
            ` : `
              <div class="pf-empty">
                <i class="fas fa-images"></i>
                <strong>No photos available</strong>
                <span>Upload an image to use it here.</span>
              </div>
            `}
          </div>
          ${pickerError ? `<div class="pf-picker-error">${escapeHtml(pickerError)}</div>` : ''}
          <div class="pf-picker-foot">
            <button type="button" class="pf-action" data-picker-upload><i class="fas fa-upload"></i> Upload</button>
            <input type="file" data-picker-file accept="${escapeHtml(options.accept || 'image/*')}" ${multiple ? 'multiple' : ''} hidden>
            <div style="flex:1"></div>
            <button type="button" class="pf-action" data-picker-clear ${selected.size ? '' : 'disabled'}>Clear</button>
            <button type="button" class="pf-action primary" data-picker-confirm ${selected.size ? '' : 'disabled'}>${escapeHtml(confirmLabel())}</button>
          </div>
        </div>
      `;
      overlay.querySelector('[data-picker-close]')?.addEventListener('click', () => closeProjectMediaPicker(overlay, handle, options.onClose));
      overlay.querySelector('[data-picker-clear]')?.addEventListener('click', () => {
        selected = new Set();
        render();
      });
      overlay.querySelectorAll('[data-picker-media-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = cleanText(btn.dataset.pickerMediaId || '');
          if (!id) return;
          if (multiple) {
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
          } else {
            selected = selected.has(id) ? new Set() : new Set([id]);
          }
          pickerError = '';
          render();
        });
      });
      overlay.querySelector('[data-picker-confirm]')?.addEventListener('click', () => {
        refreshItems();
        const selectedIds = [...selected];
        const chosen = items
          .filter((item) => selectedIds.some((id) => itemMatchesSelectedId(item, id)))
          .map((item) => item.photo);
        if (selectedIds.length && !chosen.length) {
          pickerError = 'That image is still processing. Please wait a moment and try again.';
          render();
          return;
        }
        const result = options.onConfirm?.(chosen, selectedIds);
        if (result === false) {
          pickerError = 'Could not apply that image yet. Please wait a moment and try again.';
          render();
          return;
        }
        closeProjectMediaPicker(overlay, handle, options.onClose);
      });
      const fileInput = overlay.querySelector('[data-picker-file]');
      overlay.querySelector('[data-picker-upload]')?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', async () => {
        const beforeIds = new Set(items.map((item) => item.id));
        const uploadResult = await options.onUpload?.(fileInput.files);
        const added = Array.isArray(uploadResult?.photos)
          ? uploadResult.photos
          : (Array.isArray(uploadResult) ? uploadResult : []);
        const explicitIds = Array.isArray(uploadResult?.selectedIds) ? uploadResult.selectedIds.map(cleanText).filter(Boolean) : [];
        if (added.length || explicitIds.length) {
          options.photos = currentPhotos();
          items = normalizePickerItems(options.photos, { imageOnly: options.imageOnly !== false });
          const itemIds = new Set(items.map((item) => item.id));
          const addedIds = [
            ...explicitIds,
            ...added.map((photo, index) => cleanText(pickerIdForPhoto(photo, index))),
            ...added.map((photo) => cleanText(photo?.id || photo?.photo_id || photo?.media_id || photo?.src || photo?.thumb))
          ].filter(Boolean);
          const matchedIds = [...new Set(addedIds)].filter((id) => itemIds.has(id));
          const newItemIds = items.map((item) => item.id).filter((id) => !beforeIds.has(id));
          const idsToSelect = matchedIds.length ? matchedIds : (newItemIds.length ? newItemIds : addedIds);
          if (!multiple && idsToSelect.length) selected = new Set();
          idsToSelect.forEach((id) => selected.add(id));
          pickerError = '';
        }
        fileInput.value = '';
        render();
      });
      bindThumbLoading(overlay);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeProjectMediaPicker(overlay, handle, options.onClose);
    });
    document.body.appendChild(overlay);
    handle = window.Portal?.modals?.register?.(overlay, { id: options.id || 'project-media-picker', onClose: () => closeProjectMediaPicker(overlay, null, options.onClose) });
    render();
    return {
      close: () => closeProjectMediaPicker(overlay, handle, options.onClose),
      refresh(nextPhotos = options.photos || []){
        options.photos = nextPhotos;
        items = normalizePickerItems(nextPhotos, { imageOnly: options.imageOnly !== false });
        render();
      },
    };
  }
  function renderGroup(group, options = {}){
    const enableProjectLinks = options.enableProjectLinks ?? state.enableProjectLinks;
    const selectedSet = options.selected || state.selected;
    const projectKey = group.key || `${group.dateKey}::${group.projectId || group.projectTitle}`;
    const projectButton = enableProjectLinks === false
      ? `<strong>${escapeHtml(group.projectTitle)}</strong>`
      : `<button type="button" class="pf-project-link" data-photo-project-open="${escapeHtml(projectKey)}">${escapeHtml(group.projectTitle)}</button>`;
    const fallbackSubtitle = `${group.items.length} media item${group.items.length === 1 ? '' : 's'}`;
    const subtitle = cleanText(group.projectSubtitle || group.projectAddress);
    return `
      <section class="pf-group">
        <div class="pf-group-head">
          <div>${projectButton}<span>${escapeHtml(subtitle && subtitle.toLowerCase() !== cleanText(group.projectTitle).toLowerCase() ? subtitle : fallbackSubtitle)}</span></div>
          <div class="pf-uploaders"><i class="fas fa-user"></i> ${userListHtml(group.items)}</div>
        </div>
        <div class="pf-grid">
          ${group.items.map((item) => {
            const up = uploader(item.photo);
            const selected = selectedSet.has(item.id);
            return `<button type="button" class="pf-thumb${selected ? ' selected' : ''}${item.photo?.uploading ? ' uploading' : ''}${isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item) ? ' loaded video-placeholder' : ''}" data-photo-feed-id="${escapeHtml(item.id)}" aria-pressed="${selected ? 'true' : 'false'}"><span class="pf-select" data-photo-select="${escapeHtml(item.id)}"><i class="fas fa-check"></i></span>${mediaThumbHtml(item)}<span class="pf-thumb-meta">${escapeHtml(up.name || up.email || 'Unknown')}<br>${escapeHtml(item.photo?.uploading ? 'Uploading...' : (window.FirstMateMarkup?.formatDateTime?.(item.uploadedAt) || ''))}</span></button>`;
          }).join('')}
        </div>
      </section>
    `;
  }
  function dynamicHtml(options = {}){
    const groups = filteredGroups();
    const visibleGroups = groups.slice(0, state.visible);
    const dayGroups = groupedByDay(visibleGroups);
    const selectedCount = state.selected.size;
    const selectionActions = state.trashMode
      ? '<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i> Restore</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i> Delete Forever</button>'
      : `<button type="button" class="pf-action danger" data-selection-delete><i class="fas fa-trash"></i> Delete</button><div class="pf-download-wrap">
          <button type="button" class="pf-action primary" data-selection-download><i class="fas fa-download"></i> Download</button>
          <div class="pf-download-menu${state.downloadMenuOpen ? ' visible' : ''}" data-selection-download-menu>
            <button type="button" data-download-selected-plain>Without markup</button>
            <button type="button" data-download-selected-markup>With markup</button>
          </div>
        </div>`;
    return `
      ${state.selectionMode ? `<div class="pf-selectionbar">
        <strong>${selectedCount} selected</strong>
        <div class="pf-selection-actions">
          <button type="button" class="pf-action" data-selection-clear>Cancel</button>
          ${selectionActions}
        </div>
      </div>` : ''}
      <div class="pf-scroll" data-feed-scroll>
        ${state.loading && !state.loaded ? '<div class="pf-loading">Loading media...</div>' : ''}
        ${!state.loading && state.loaded && !groups.length ? '<div class="pf-empty"><i class="fas fa-images"></i><strong>No media found</strong><div>Upload project media or adjust the search.</div></div>' : ''}
        ${dayGroups.map(([key, list]) => `<div class="pf-day"><h2 class="pf-day-title">${escapeHtml(dateLabel(key))}</h2>${list.map((group) => renderGroup(group, options)).join('')}</div>`).join('')}
        ${groups.length > state.visible ? '<div class="pf-sentinel" data-feed-sentinel></div>' : ''}
      </div>`;
  }
  function openFeedViewerAt(index, options = {}){
    const items = filteredItems();
    const safeIndex = Math.max(0, Math.min(Number(index || 0), Math.max(0, items.length - 1)));
    const item = items[safeIndex];
    if (!item) return null;
    if (!options.fromRoute) updatePhotoRoute(item, 'feed');
    let openedProjectFromViewer = false;
    return window.FirstMateMarkup?.openPhotoViewer?.({
      photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
      index: safeIndex,
      project: item.project || {},
      onOpenProject: (project) => {
        openedProjectFromViewer = true;
        openProject(project);
      },
      onChange: ({ photo, project }) => updatePhotoRoute({ photo, project: project || photo?.__project || item.project }, 'feed'),
      onClose: () => {
        state.routeRestoreKey = '';
        clearPhotoRoute('feed');
        if (!openedProjectFromViewer) window.Portal?.routeState?.set?.({ project: null });
      },
      onDeletePhoto: async (photo) => {
        const currentItems = filteredItems();
        const currentItem = currentItems.find((entry) => photoIdentity(entry.photo) === photoIdentity(photo)) || currentItems[safeIndex];
        if (!currentItem) return { count: 0, bytes: 0 };
        const result = await trashItems([currentItem]);
        setSelectionMode(false);
        render();
        return result;
      }
    });
  }
  function restoreFeedPhotoRoute(){
    const route = window.Portal?.routeState?.get?.() || {};
    if (!route.photo || route.photoScope !== 'feed') return;
    if (route.tab && route.tab !== TAB_ID) return;
    const key = `${route.photoScope}:${route.photo}`;
    if (state.routeRestoreKey === key) return;
    const items = filteredItems();
    const index = items.findIndex((item) => mediaRouteId(item.photo) === route.photo || item.id.endsWith(`::${route.photo}`));
    if (index < 0) return;
    state.routeRestoreKey = key;
    window.setTimeout(() => openFeedViewerAt(index, { fromRoute: true }), 0);
  }
  function renderDynamic(options = {}){
    const dynamic = state.root?.querySelector?.('[data-photo-feed-dynamic]');
    if (!dynamic) return render();
    dynamic.innerHTML = dynamicHtml(options);
    bindDynamic(options);
  }
  function render(){
    if (!state.root) return;
    state.root.innerHTML = `
      <div class="pf-wrap${state.selectionMode ? ' selection-mode' : ''}" data-density="${escapeHtml(state.density)}">
        <div class="pf-toolbar">
          <div class="pf-title"><i class="fas ${escapeHtml(state.icon || 'fa-images')}"></i><div><strong>${escapeHtml(state.title || 'Photo Feed')}</strong><span>${escapeHtml(state.subtitle || `${state.items.length} media item${state.items.length === 1 ? '' : 's'}`)}</span></div></div>
          <div class="pf-tools">
            <label class="pf-search"><i class="fas fa-search"></i><input type="search" value="${escapeHtml(state.query)}" placeholder="Search dates, projects, addresses, uploaders, tags"></label>
            <div class="pf-density">
              ${[
                { id: 'loose', label: 'Loose', icon: 'border-all' },
                { id: 'comfortable', label: 'Comfortable', icon: 'grip' },
                { id: 'compact', label: 'Compact', icon: 'table-cells' }
              ].map((mode) => `<button type="button" class="${state.density === mode.id ? 'active' : ''}" data-density="${mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join('')}
            </div>
            ${state.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(state.uploadLabel)}</button>` : ''}
            ${state.onUpload ? '' : '<button type="button" class="pf-refresh" data-refresh><i class="fas fa-rotate"></i></button>'}
          </div>
        </div>
        <div data-photo-feed-dynamic>${dynamicHtml()}</div>
      </div>`;
    bind();
  }
  function bind(){
    const rootEl = state.root;
    rootEl.querySelector('input[type="search"]')?.addEventListener('input', (event) => {
      state.query = event.target.value || '';
      state.visible = PAGE_SIZE;
      renderDynamic();
    });
    rootEl.querySelector('[data-refresh]')?.addEventListener('click', () => load({ toast: true }));
    rootEl.querySelector('[data-photo-feed-upload]')?.addEventListener('click', () => {
      if (typeof state.onUpload === 'function') state.onUpload();
    });
    rootEl.querySelectorAll('.pf-density [data-density]').forEach((btn) => btn.addEventListener('click', () => {
      state.density = btn.dataset.density || 'comfortable';
      render();
    }));
    bindDynamic();
  }
  function bindDynamic(options = {}){
    const rootEl = state.root;
    if (!rootEl) return;
    rootEl.querySelector('[data-selection-clear]')?.addEventListener('click', () => {
      setSelectionMode(false);
      render();
    });
    rootEl.querySelector('[data-selection-download]')?.addEventListener('click', () => {
      state.downloadMenuOpen = !state.downloadMenuOpen;
      render();
    });
    rootEl.querySelector('[data-selection-delete]')?.addEventListener('click', async () => {
      await trashItems(selectedItems());
      setSelectionMode(false);
      render();
    });
    rootEl.querySelector('[data-selection-restore]')?.addEventListener('click', async () => {
      await restoreItems(selectedItems());
      setSelectionMode(false);
      render();
    });
    rootEl.querySelector('[data-selection-hard-delete]')?.addEventListener('click', async () => {
      await hardDeleteItems(selectedItems());
      setSelectionMode(false);
      render();
    });
    rootEl.querySelector('[data-download-selected-plain]')?.addEventListener('click', () => downloadSelected(false));
    rootEl.querySelector('[data-download-selected-markup]')?.addEventListener('click', () => downloadSelected(true));
    rootEl.querySelectorAll('[data-photo-select]').forEach((box) => box.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.suppressClickId === box.dataset.photoSelect) {
        state.suppressClickId = '';
        return;
      }
      toggleSelection(box.dataset.photoSelect, event);
      render();
    }));
    rootEl.querySelectorAll('[data-photo-feed-id]').forEach((btn) => {
      btn.addEventListener('pointerdown', (event) => {
        startDragSelectionCandidate(btn.dataset.photoFeedId || '', event);
      });
      btn.addEventListener('dragstart', (event) => event.preventDefault());
      btn.addEventListener('pointerenter', () => {
        return;
      });
      btn.addEventListener('click', (event) => {
        if (state.suppressClickId === btn.dataset.photoFeedId) {
          state.suppressClickId = '';
          event.preventDefault();
          return;
        }
        if (state.selectionMode) {
          event.preventDefault();
          toggleSelection(btn.dataset.photoFeedId, event);
          render();
          return;
        }
        if (state.trashMode) {
          event.preventDefault();
          toggleSelection(btn.dataset.photoFeedId, event);
          render();
          return;
        }
        const items = filteredItems();
        const index = Math.max(0, items.findIndex((item) => item.id === btn.dataset.photoFeedId));
        openFeedViewerAt(index);
      });
    });
    rootEl.querySelectorAll('[data-photo-project-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = btn.dataset.photoProjectOpen || '';
        const group = filteredGroups().find((entry) => entry.key === key || (entry.projectId || entry.projectTitle) === key);
        openProject(group?.project || {}, { groupKey: key }).catch((error) => {
          console.warn('Could not open project from Photo Feed', error);
          showToast?.('Project issue', error?.message || 'Could not open that project.', false);
        });
      });
    });
    bindThumbLoading(rootEl);
    rootEl.querySelectorAll('[data-photo-user-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!userModalsEnabled()) return;
        const key = btn.dataset.photoUserOpen || '';
        const items = filteredItems().filter((item) => uploaderUsers([item]).some((user) => user.key === key));
        const user = uploaderUsers(items)[0] || { key, name: btn.textContent || 'User' };
        openUserModal(user, items);
      });
    });
    if (!state.pointerUpBound) {
      state.pointerUpBound = true;
      window.addEventListener('pointermove', (event) => {
        if (!state.dragSelecting) return;
        const distance = Math.hypot(event.clientX - state.dragStartX, event.clientY - state.dragStartY);
        if (!state.dragMoved && distance < 5) return;
        const thumb = feedTileAtPoint(event);
        const id = thumb?.dataset?.photoFeedId || '';
        if (!id || id !== state.dragStartId) state.dragLeftStartTile = true;
        if (!state.dragMoved) {
          state.dragMoved = true;
          state.selectionMode = true;
          state.suppressClickId = state.dragStartId;
          state.root?.querySelector?.('.pf-wrap')?.classList.add('selection-mode');
          previewDragRange(state.dragStartId);
        }
        event.preventDefault();
        if (!id) return;
        previewDragRange(id);
      });
      window.addEventListener('pointerup', (event) => {
        const moved = state.dragMoved;
        const releasedTile = moved ? feedTileAtPoint(event) : null;
        const releasedId = releasedTile?.dataset?.photoFeedId || '';
        const jitterClick = moved
          && !state.dragLeftStartTile
          && releasedId === state.dragStartId
          && !isSelectionControlAtPoint(event);
        const startId = state.dragStartId;
        const committed = moved && !jitterClick ? commitDragSelection() : false;
        if (!moved) state.dragPreview.clear();
        if (jitterClick) {
          state.dragPreview.forEach((id) => setTilePreview(id, state.selected.has(id)));
          state.dragPreview.clear();
          state.selectionMode = state.selected.size > 0;
        }
        const shouldRender = committed || moved;
        state.dragSelecting = false;
        state.dragStartId = '';
        state.dragStartX = 0;
        state.dragStartY = 0;
        state.dragMode = 'add';
        state.dragMoved = false;
        state.dragLeftStartTile = false;
        if (jitterClick) {
          state.suppressClickId = startId;
          render();
          handleTileClickLike(startId, event);
        } else if (shouldRender) render();
        if (moved) setTimeout(() => { state.suppressClickId = ''; }, 120);
        else state.suppressClickId = '';
      });
    }
    const sentinel = rootEl.querySelector('[data-feed-sentinel]');
    state.observer?.disconnect?.();
    if (sentinel && typeof sentinel.nodeType === 'number') {
      state.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          state.visible += PAGE_SIZE;
          render();
        }
      }, { root: rootEl.querySelector('[data-feed-scroll]'), threshold: 0.1 });
      state.observer.observe(sentinel);
    }
  }
  async function downloadSelected(withMarkup){
    const items = selectedItems();
    if (!items.length) return;
    state.downloadMenuOpen = false;
    render();
    try {
      if (!window.FirstMateMarkup?.downloadPhotoZip) throw new Error('Photo download tools are not available.');
      await window.FirstMateMarkup?.downloadPhotoZip?.(items.map((item) => ({ ...item.photo, __project: item.project })), { withMarkup });
      showToast?.('Media downloaded', `${items.length} item${items.length === 1 ? '' : 's'} prepared.`, true);
    } catch (error) {
      console.warn('Photo download failed', error);
      showToast?.('Download failed', error?.message || 'Could not download selected media.', false);
    }
  }
  async function ensureLoaded(){
    if (!state.loaded && !state.loading) await load();
    return state.loaded;
  }
  async function trashStats(){
    await ensureLoaded();
    return trashStatsFromItems(allTrashItems());
  }
  async function saveProjectPhotos(project, photos, metadata = {}){
    const oid = orgId();
    const projectId = cleanText(project?.id);
    if (!oid || !projectId) throw new Error('Project is missing.');
    const library = photoLibrary();
    if (library?.savePhotos) return library.savePhotos(oid, projectId, project, photos, metadata);
    return window.PlatformAPI?.projects?.save?.(oid, projectId, { ...(project || {}), photos, updated_at: new Date().toISOString() }, metadata);
  }
  function replaceStateProject(project, photos){
    const projectId = cleanText(project?.id);
    const nextProject = { ...(project || {}), photos };
    state.projects = state.projects.map((entry) => cleanText(entry.id) === projectId ? { ...entry, photos } : entry);
    state.items = buildItems(state.projects);
    state.groups = buildGroups(state.items);
    return nextProject;
  }
  async function mutatePhotoItems(items = [], action = 'trash', options = {}){
    const byProject = new Map();
    items.forEach((item) => {
      const key = cleanText(item.projectId || item.project?.id);
      if (!key) return;
      if (!byProject.has(key)) byProject.set(key, { project: item.project || {}, items: [] });
      byProject.get(key).items.push(item);
    });
    let affectedPhotos = 0;
    let affectedBytes = 0;
    const updated = [];
    for (const { project, items: projectItems } of byProject.values()) {
      const targets = new Set(projectItems.map((item) => photoIdentity(item.photo)).filter(Boolean));
      const sourcePhotos = projectPhotosRaw(project).length ? projectPhotosRaw(project) : normalizePhotos(project);
      const nextPhotos = [];
      sourcePhotos.forEach((photo) => {
        const isTarget = targets.has(photoIdentity(photo));
        if (!isTarget) {
          nextPhotos.push(photo);
          return;
        }
        affectedPhotos += 1;
        affectedBytes += photoSizeBytes(photo);
        if (action === 'hard_delete') return;
        nextPhotos.push(withTrashState(photo, action === 'trash'));
      });
      await saveProjectPhotos(project, nextPhotos, { source: `photo_${action}` });
      updated.push(replaceStateProject(project, nextPhotos));
      if (typeof options.onProjectPhotosChanged === 'function') options.onProjectPhotosChanged(nextPhotos, updated.at(-1));
    }
    if (action === 'hard_delete' && affectedBytes > 0) {
      await window.PlatformAPI?.mediaStorage?.increment?.(orgId(), -affectedBytes, { source: 'photo_trash_empty' }).catch(() => null);
    }
    window.dispatchEvent(new CustomEvent('fm:photos:changed', { detail: { action, count: affectedPhotos, bytes: affectedBytes } }));
    return { count: affectedPhotos, bytes: affectedBytes };
  }
  async function trashItems(items = [], options = {}){
    if (!items.length) return { count: 0, bytes: 0 };
    const ok = await (window.PlatformUI?.confirm?.(`Move ${items.length} media item${items.length === 1 ? '' : 's'} to trash? They will still count toward storage until the trash is emptied.`, {
      title: 'Delete Media',
      okLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
      danger: true
    }) || Promise.resolve(confirm(`Move ${items.length} media item${items.length === 1 ? '' : 's'} to trash?`)));
    if (!ok) return { count: 0, bytes: 0 };
    const result = await mutatePhotoItems(items, 'trash', options);
    showToast?.('Moved to trash', `${result.count} media item${result.count === 1 ? '' : 's'} moved.`, true);
    return result;
  }
  async function restoreItems(items = [], options = {}){
    const result = await mutatePhotoItems(items, 'restore', options);
    showToast?.('Restored', `${result.count} media item${result.count === 1 ? '' : 's'} restored.`, true);
    return result;
  }
  async function hardDeleteItems(items = [], options = {}){
    if (!items.length) return { count: 0, bytes: 0 };
    const ok = await (window.PlatformUI?.confirm?.(`Permanently delete ${items.length} media item${items.length === 1 ? '' : 's'}? This cannot be undone.`, {
      title: 'Empty Trash',
      okLabel: 'Delete Forever',
      cancelLabel: 'Cancel',
      danger: true
    }) || Promise.resolve(confirm(`Permanently delete ${items.length} media item${items.length === 1 ? '' : 's'}?`)));
    if (!ok) return { count: 0, bytes: 0 };
    const result = await mutatePhotoItems(items, 'hard_delete', options);
    showToast?.('Deleted forever', `${result.count} media item${result.count === 1 ? '' : 's'} removed.`, true);
    return result;
  }
  async function emptyTrash(){
    await ensureLoaded();
    const items = allTrashItems();
    if (!items.length) return { count: 0, bytes: 0 };
    return hardDeleteItems(items);
  }
  async function openTrash(){
    injectStyles();
    await ensureLoaded();
    document.getElementById('pfTrashModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'pfTrashModal';
    modal.className = 'pf-trash-modal';
    const currentStats = trashStatsFromItems(allTrashItems());
    modal.innerHTML = `
      <div class="pf-trash-shell">
        <div class="pf-trash-head">
          <div><strong><i class="fas fa-trash"></i> Trash</strong><span data-trash-summary>${escapeHtml(currentStats.count)} media item${currentStats.count === 1 ? '' : 's'} | ${escapeHtml(formatBytes(currentStats.bytes))}</span></div>
          <div class="pf-selection-actions">
            <button type="button" class="pf-action danger" data-trash-empty><i class="fas fa-trash"></i> Empty Trash</button>
            <button type="button" class="pf-trash-close" data-trash-close aria-label="Close trash"><i class="fas fa-times"></i></button>
          </div>
        </div>
        <div class="pf-trash-body"><div data-trash-feed style="height:100%;min-height:0"></div></div>
      </div>`;
    document.body.appendChild(modal);
    let modalHandle = null;
    const close = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      modal.remove();
    };
    const updateSummary = () => {
      const stats = trashStatsFromItems(allTrashItems());
      const summary = modal.querySelector('[data-trash-summary]');
      if (summary) summary.textContent = `${stats.count} media item${stats.count === 1 ? '' : 's'} | ${formatBytes(stats.bytes)}`;
    };
    const remount = () => {
      mountProjectGallery(modal.querySelector('[data-trash-feed]'), {
        projects: state.projects,
        title: 'Trash',
        icon: 'fa-trash',
        trashMode: true,
        uploadLabel: '',
        enableProjectLinks: true,
        onProjectPhotosChanged: () => updateSummary()
      });
      updateSummary();
    };
    modal.querySelector('[data-trash-close]')?.addEventListener('click', close);
    modalHandle = window.Portal?.modals?.register?.(modal, {
      id: 'photo-trash',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: close
    });
    modal.querySelector('[data-trash-empty]')?.addEventListener('click', async () => {
      await emptyTrash();
      remount();
    });
    const onChange = () => { if (document.body.contains(modal)) remount(); };
    window.addEventListener('fm:photos:changed', onChange);
    const originalRemove = modal.remove.bind(modal);
    modal.remove = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      window.removeEventListener('fm:photos:changed', onChange);
      originalRemove();
    };
    remount();
  }
  function userMatchesUploader(user = {}, item = {}){
    const up = uploader(item.photo);
    const keys = [up.id, up.email, up.name].map(cleanText).filter(Boolean).map((value) => value.toLowerCase());
    return [user.id, user.email, user.name, user.key].map(cleanText).filter(Boolean).map((value) => value.toLowerCase()).some((value) => keys.includes(value));
  }
  async function enrichUser(user = {}){
    const fallback = { ...(user || {}) };
    const users = await window.FirstMateTags?.listUsers?.(orgId()).catch(() => []) || [];
    const key = userKey(fallback);
    const found = users.find((candidate) => (
      (candidate.id && cleanText(candidate.id).toLowerCase() === key)
      || (candidate.email && cleanText(candidate.email).toLowerCase() === key)
      || (candidate.name && cleanText(candidate.name).toLowerCase() === key)
      || (candidate.id && fallback.id && cleanText(candidate.id).toLowerCase() === cleanText(fallback.id).toLowerCase())
      || (candidate.email && fallback.email && cleanText(candidate.email).toLowerCase() === cleanText(fallback.email).toLowerCase())
    ));
    return found ? { ...fallback, ...found, avatar: cleanText(found.avatar || fallback.avatar) } : fallback;
  }
  function projectsFromUserItems(items = []){
    const map = new Map();
    items.forEach((item) => {
      const key = item.projectId || item.projectTitle || 'project';
      if (!map.has(key)) map.set(key, { ...(item.project || {}), id: item.projectId, photos: [] });
      map.get(key).photos.push(item.photo);
    });
    return [...map.values()];
  }
  async function openUserModal(user = {}, items = []){
    if (!userModalsEnabled()) return;
    injectStyles();
    document.getElementById('pfUserModal')?.remove();
    const enriched = await enrichUser(user);
    if (!items.length && !state.loaded && !state.loading) await load().catch(() => null);
    const name = cleanText(enriched.name || enriched.label || enriched.email || 'User');
    const email = cleanText(enriched.email || '');
    const avatar = cleanText(enriched.avatar || enriched.avatar_url || enriched.photo_url || enriched.profile_photo_url || enriched.raw?.avatar || enriched.raw?.avatar_url);
    const initial = (name || email || '?').slice(0, 1).toUpperCase();
    const showActivity = userActivityEnabled();
    const modal = document.createElement('div');
    modal.id = 'pfUserModal';
    modal.className = 'pf-user-modal';
    modal.innerHTML = `
      <div class="pf-user-shell">
        <aside class="pf-user-side">
          <div class="pf-user-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initial)}</div>
          <div class="pf-user-name">${escapeHtml(name)}</div>
          <div class="pf-user-contact">
            ${email ? `<span><i class="fas fa-envelope"></i> ${escapeHtml(email)}</span>` : ''}
            ${enriched.id ? `<span><i class="fas fa-id-card"></i> ${escapeHtml(enriched.id)}</span>` : ''}
          </div>
        </aside>
        <main class="pf-user-main">
          <div class="pf-user-main-head">
            <div class="pf-user-main-title">Profile</div>
            <div class="pf-user-head-actions">
              <div class="pf-user-tabs">
                <button type="button" class="pf-user-tab active" data-user-tab="photos">Photos</button>
                ${showActivity ? '<button type="button" class="pf-user-tab" data-user-tab="activity">Activity</button>' : ''}
              </div>
              <button type="button" class="pf-user-close" data-user-close aria-label="Close user"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div class="pf-user-panel" data-user-panel></div>
        </main>
      </div>`;
    document.body.appendChild(modal);
    let modalHandle = null;
    const close = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      modal.remove();
    };
    modal.querySelector('[data-user-close]')?.addEventListener('click', close);
    modalHandle = window.Portal?.modals?.register?.(modal, {
      id: 'user-profile',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: close
    });
    const originalRemove = modal.remove.bind(modal);
    modal.remove = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      originalRemove();
    };
    const userItems = items.length ? items : state.items.filter((item) => userMatchesUploader(enriched, item));
    const panel = modal.querySelector('[data-user-panel]');
    const setActive = (tab) => {
      modal.querySelectorAll('[data-user-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.userTab === tab));
    };
    const showPhotos = () => {
      setActive('photos');
      panel.innerHTML = '<div data-user-photos style="height:100%;min-height:0"></div>';
      mountProjectGallery(panel.querySelector('[data-user-photos]'), {
        projects: projectsFromUserItems(userItems),
        title: 'Uploaded Media',
        uploadLabel: '',
        enableProjectLinks: true
      });
    };
    const showActivityTab = async () => {
      setActive('activity');
      panel.innerHTML = '<div class="pf-user-activity"><div class="pf-loading">Loading activity...</div></div>';
      const root = panel.querySelector('.pf-user-activity');
      const result = await window.PlatformAPI?.userActivity?.listForUser?.(orgId(), enriched, { limit: 200 }).catch((error) => ({ error }));
      if (result?.error) {
        root.innerHTML = `<div class="pf-user-empty"><i class="fas fa-triangle-exclamation"></i><strong>Could not load activity</strong><span>${escapeHtml(result.error?.message || 'Try again in a moment.')}</span></div>`;
        return;
      }
      const events = result?.events || [];
      root.innerHTML = renderActivityList(events);
      bindActivityLinks(root, events);
    };
    modal.querySelector('[data-user-tab="photos"]')?.addEventListener('click', showPhotos);
    modal.querySelector('[data-user-tab="activity"]')?.addEventListener('click', showActivityTab);
    showPhotos();
  }
  function mount(panel){
    injectStyles();
    state.observer?.disconnect?.();
    state.root = panel;
    state.projects = [];
    state.items = [];
    state.groups = [];
    state.query = '';
    state.visible = PAGE_SIZE;
    state.loaded = false;
    state.loading = false;
    state.selected = new Set();
    state.selectionMode = false;
    state.title = 'Photo Feed';
    state.subtitle = '';
    state.icon = 'fa-images';
    state.uploadLabel = '';
    state.onUpload = null;
    state.enableProjectLinks = true;
    state.trashMode = false;
    state.routeRestoreKey = '';
    render();
    load();
  }
  function mountProjectGallery(panel, options = {}){
    if (!panel) return;
    injectStyles();
    const project = options.project && typeof options.project === 'object' ? options.project : {};
    const photos = Array.isArray(options.photos) ? options.photos : (Array.isArray(project.photos) ? project.photos : []);
    const scopedProject = { ...project, photos };
    const sourceProjects = Array.isArray(options.projects) && options.projects.length ? options.projects : [scopedProject];
    const local = {
      root: panel,
      items: buildItems(sourceProjects),
      query: '',
      density: 'comfortable',
      selected: new Set(),
      selectionMode: false,
      selectionAnchorId: '',
      dragSelecting: false,
      dragStartId: '',
      dragStartX: 0,
      dragStartY: 0,
      dragMode: 'add',
      dragMoved: false,
      dragLeftStartTile: false,
      dragPreview: new Set(),
      suppressClickId: '',
      downloadMenuOpen: false,
      pointerUpBound: false,
      routeRestoreKey: ''
    };
    const filtered = () => {
      const query = cleanText(local.query).toLowerCase();
      const modeItems = local.items.filter((item) => options.trashMode ? isPhotoTrashed(item.photo) : !isPhotoTrashed(item.photo));
      if (!query) return modeItems;
      return modeItems.filter((item) => item.search.includes(query) || itemTags(item).some((tag) => tag.toLowerCase().includes(query.replace(/^#/, ''))));
    };
    const localGroups = () => buildGroups(filtered());
    const setLocalTile = (id, active) => {
      const tile = panel.querySelector?.(`[data-photo-feed-id="${CSS.escape(id)}"]`);
      tile?.classList.toggle('selected', !!active);
      tile?.setAttribute('aria-pressed', active ? 'true' : 'false');
    };
    const clearLocalSelection = () => {
      local.selected.clear();
      local.selectionMode = false;
      local.selectionAnchorId = '';
      local.dragSelecting = false;
      local.dragPreview.clear();
      local.dragLeftStartTile = false;
      local.downloadMenuOpen = false;
    };
    const dragRange = (endId) => {
      const ids = filtered().map((item) => item.id);
      const a = ids.indexOf(local.dragStartId);
      const b = ids.indexOf(endId);
      if (a < 0 || b < 0) return [];
      const [start, end] = a < b ? [a, b] : [b, a];
      return ids.slice(start, end + 1);
    };
    const previewRange = (endId) => {
      const next = new Set(dragRange(endId));
      local.dragPreview.forEach((id) => {
        if (!next.has(id)) setLocalTile(id, local.selected.has(id));
      });
      next.forEach((id) => setLocalTile(id, local.dragMode !== 'remove'));
      local.dragPreview = next;
    };
    const commitRange = () => {
      if (!local.dragPreview.size) return false;
      if (local.dragMode === 'remove') local.dragPreview.forEach((id) => local.selected.delete(id));
      else local.dragPreview.forEach((id) => local.selected.add(id));
      local.selectionAnchorId = [...local.dragPreview].at(-1) || local.selectionAnchorId;
      local.dragPreview.clear();
      local.selectionMode = local.selected.size > 0;
      return true;
    };
    const localTileAtPoint = (event) => document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-photo-feed-id]') || null;
    const localSelectionControlAtPoint = (event) => !!document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-photo-select]');
    const toggle = (itemId, event = {}) => {
      const ids = filtered().map((item) => item.id);
      if (!ids.includes(itemId)) return;
      local.selectionMode = true;
      if (event.shiftKey && local.selectionAnchorId && ids.includes(local.selectionAnchorId)) {
        const a = ids.indexOf(local.selectionAnchorId);
        const b = ids.indexOf(itemId);
        const [start, end] = a < b ? [a, b] : [b, a];
        if (!event.ctrlKey && !event.metaKey) local.selected.clear();
        ids.slice(start, end + 1).forEach((id) => local.selected.add(id));
      } else {
        if (local.selected.has(itemId)) local.selected.delete(itemId);
        else local.selected.add(itemId);
        local.selectionAnchorId = itemId;
      }
      if (!local.selected.size) clearLocalSelection();
    };
    const bodyHtml = () => {
      const groups = localGroups();
      const extraSelectionActions = Array.isArray(options.selectionActions)
        ? options.selectionActions.map((action) => {
          const id = cleanText(action?.id);
          if (!id) return '';
          const icon = cleanText(action.icon);
          const cls = cleanText(action.className);
          return `<button type="button" class="pf-action ${escapeHtml(cls)}" data-selection-extra="${escapeHtml(id)}">${icon ? `<i class="fas ${escapeHtml(icon)}"></i> ` : ''}${escapeHtml(action.label || id)}</button>`;
        }).join('')
        : '';
      const selectionActions = options.trashMode
        ? '<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i> Restore</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i> Delete Forever</button>'
        : `${extraSelectionActions}<button type="button" class="pf-action danger" data-selection-delete><i class="fas fa-trash"></i> Delete</button><div class="pf-download-wrap"><button type="button" class="pf-action primary" data-selection-download><i class="fas fa-download"></i> Download</button><div class="pf-download-menu${local.downloadMenuOpen ? ' visible' : ''}" data-selection-download-menu><button type="button" data-download-selected-plain>Without markup</button><button type="button" data-download-selected-markup>With markup</button></div></div>`;
      return `
        ${local.selectionMode ? `<div class="pf-selectionbar"><strong>${local.selected.size} selected</strong><div class="pf-selection-actions"><button type="button" class="pf-action" data-selection-clear>Cancel</button>${selectionActions}</div></div>` : ''}
        <div class="pf-scroll" data-feed-scroll>
          ${!groups.length ? '<div class="pf-empty"><i class="fas fa-images"></i><strong>No media found</strong><div>Upload project media or adjust the search.</div></div>' : ''}
          ${groupedByDay(groups).map(([key, list]) => `<div class="pf-day"><h2 class="pf-day-title">${escapeHtml(dateLabel(key))}</h2>${list.map((group) => renderGroup(group, { enableProjectLinks: options.enableProjectLinks !== false, selected: local.selected })).join('')}</div>`).join('')}
        </div>`;
    };
    const renderBody = () => {
      const body = panel.querySelector('[data-photo-feed-dynamic]');
      if (!body) return renderLocal();
      body.innerHTML = bodyHtml();
      bindBody();
      bindThumbLoading(panel);
    };
    const downloadLocal = async (withMarkup) => {
      const items = filtered().filter((item) => local.selected.has(item.id));
      if (!items.length) return;
      local.downloadMenuOpen = false;
      renderBody();
      try {
        if (!window.FirstMateMarkup?.downloadPhotoZip) throw new Error('Photo download tools are not available.');
        await window.FirstMateMarkup.downloadPhotoZip(items.map((item) => ({ ...item.photo, __project: item.project })), { withMarkup });
        showToast?.('Media downloaded', `${items.length} item${items.length === 1 ? '' : 's'} prepared.`, true);
      } catch (error) {
        showToast?.('Download failed', error?.message || 'Could not download selected media.', false);
      }
    };
    const selectedLocalItems = () => filtered().filter((item) => local.selected.has(item.id));
    const refreshLocalAfterMutation = (items, action) => {
      const ids = new Set(items.map((item) => item.id));
      if (action === 'hard_delete') local.items = local.items.filter((item) => !ids.has(item.id));
      else {
        local.items = local.items.map((item) => ids.has(item.id)
          ? { ...item, photo: withTrashState(item.photo, action === 'trash'), search: searchableText({ ...item, photo: withTrashState(item.photo, action === 'trash') }) }
          : item);
      }
      clearLocalSelection();
    };
    const mutateLocal = async (action) => {
      const items = selectedLocalItems();
      if (!items.length) return;
      const mutationOptions = { onProjectPhotosChanged: options.onProjectPhotosChanged };
      if (action === 'trash') await trashItems(items, mutationOptions);
      if (action === 'restore') await restoreItems(items, mutationOptions);
      if (action === 'hard_delete') await hardDeleteItems(items, mutationOptions);
      refreshLocalAfterMutation(items, action);
      renderLocal();
    };
    const openLocalViewerAt = (index, routeOptions = {}) => {
      const items = filtered();
      const safeIndex = Math.max(0, Math.min(Number(index || 0), Math.max(0, items.length - 1)));
      const item = items[safeIndex];
      if (!item) return null;
      const routeScope = cleanText(options.routeScope);
      if (routeScope && !routeOptions.fromRoute) updatePhotoRoute({ photo: item.photo, project: item.project || scopedProject }, routeScope);
      const viewer = window.FirstMateMarkup?.openPhotoViewer?.({
        photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
        index: safeIndex,
        project: item.project || scopedProject,
        onOpenProject: openProject,
        boundsTarget: options.boundsTarget || panel.closest?.('.r-win') || panel.closest?.('.pf-user-shell') || panel,
        projectLinkEnabled: options.projectLinkEnabled !== false && options.enableProjectLinks !== false,
        onChange: ({ photo, project }) => {
          if (routeScope) updatePhotoRoute({ photo, project: project || photo?.__project || item.project || scopedProject }, routeScope);
        },
        onDeletePhoto: async (photo) => {
          const currentItems = filtered();
          const currentItem = currentItems.find((entry) => photoIdentity(entry.photo) === photoIdentity(photo)) || items[safeIndex];
          if (!currentItem) return { count: 0, bytes: 0 };
          const result = await trashItems([currentItem], { onProjectPhotosChanged: options.onProjectPhotosChanged });
          if (result.count) {
            refreshLocalAfterMutation([currentItem], 'trash');
            renderLocal();
          }
          return result;
        },
        onClose: () => {
          local.routeRestoreKey = '';
          if (routeScope) clearPhotoRoute(routeScope);
          if (typeof options.onViewerClose === 'function') options.onViewerClose();
        }
      });
      if (viewer && typeof options.onViewerOpen === 'function') options.onViewerOpen(viewer);
      return viewer;
    };
    const restoreLocalPhotoRoute = () => {
      const initialPhotoId = cleanText(options.initialPhotoId);
      if (!initialPhotoId) return;
      const key = `${cleanText(options.routeScope)}:${initialPhotoId}`;
      if (local.routeRestoreKey === key) return;
      const items = filtered();
      const index = items.findIndex((item) => mediaRouteId(item.photo) === initialPhotoId || item.id.endsWith(`::${initialPhotoId}`));
      if (index < 0) return;
      local.routeRestoreKey = key;
      window.setTimeout(() => openLocalViewerAt(index, { fromRoute: true }), 0);
    };
    const bindBody = () => {
      panel.querySelector('[data-selection-clear]')?.addEventListener('click', () => { clearLocalSelection(); renderLocal(); });
      panel.querySelector('[data-selection-download]')?.addEventListener('click', () => { local.downloadMenuOpen = !local.downloadMenuOpen; renderBody(); });
      panel.querySelector('[data-download-selected-plain]')?.addEventListener('click', () => downloadLocal(false));
      panel.querySelector('[data-download-selected-markup]')?.addEventListener('click', () => downloadLocal(true));
      panel.querySelector('[data-selection-delete]')?.addEventListener('click', () => mutateLocal('trash'));
      panel.querySelector('[data-selection-restore]')?.addEventListener('click', () => mutateLocal('restore'));
      panel.querySelector('[data-selection-hard-delete]')?.addEventListener('click', () => mutateLocal('hard_delete'));
      panel.querySelectorAll('[data-selection-extra]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.selectionExtra || '';
          const items = selectedLocalItems();
          const action = (Array.isArray(options.selectionActions) ? options.selectionActions : []).find((entry) => cleanText(entry?.id) === id);
          if (!items.length || typeof action?.onClick !== 'function') return;
          await action.onClick(items, { clearSelection: clearLocalSelection, render: renderLocal });
        });
      });
      panel.querySelectorAll('[data-photo-select]').forEach((box) => box.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (local.suppressClickId === box.dataset.photoSelect) {
          local.suppressClickId = '';
          return;
        }
        toggle(box.dataset.photoSelect, event);
        renderLocal();
      }));
      panel.querySelectorAll('[data-photo-feed-id]').forEach((btn) => {
        btn.addEventListener('pointerdown', (event) => {
          if (!btn.dataset.photoFeedId || event.button > 0) return;
          local.dragSelecting = true;
          local.dragStartId = btn.dataset.photoFeedId;
          local.dragStartX = event.clientX || 0;
          local.dragStartY = event.clientY || 0;
          local.dragMode = local.selected.has(local.dragStartId) ? 'remove' : 'add';
          local.dragMoved = false;
          local.dragLeftStartTile = false;
          local.dragPreview.clear();
        });
        btn.addEventListener('dragstart', (event) => event.preventDefault());
        btn.addEventListener('click', (event) => {
          if (local.suppressClickId === btn.dataset.photoFeedId) {
            local.suppressClickId = '';
            event.preventDefault();
            return;
          }
          if (local.selectionMode) {
            event.preventDefault();
            toggle(btn.dataset.photoFeedId, event);
            renderLocal();
            return;
          }
          if (options.trashMode) {
            event.preventDefault();
            toggle(btn.dataset.photoFeedId, event);
            renderLocal();
            return;
          }
          const items = filtered();
          const index = Math.max(0, items.findIndex((item) => item.id === btn.dataset.photoFeedId));
          openLocalViewerAt(index);
        });
      });
      panel.querySelectorAll('[data-photo-project-open]').forEach((btn) => btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = btn.dataset.photoProjectOpen || '';
        const group = localGroups().find((entry) => entry.key === key || (entry.projectId || entry.projectTitle) === key);
        openProject(group?.project || scopedProject, { groupKey: key }).catch((error) => {
          console.warn('Could not open project from project photos', error);
          showToast?.('Project issue', error?.message || 'Could not open that project.', false);
        });
      }));
      panel.querySelectorAll('[data-photo-user-open]').forEach((btn) => btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!userModalsEnabled()) return;
        const key = btn.dataset.photoUserOpen || '';
        const items = filtered().filter((item) => uploaderUsers([item]).some((user) => user.key === key));
        const user = uploaderUsers(items)[0] || { key, name: btn.textContent || 'User' };
        openUserModal(user, items);
      }));
      if (!local.pointerUpBound) {
        local.pointerUpBound = true;
        window.addEventListener('pointermove', (event) => {
          if (!local.dragSelecting) return;
          const distance = Math.hypot(event.clientX - local.dragStartX, event.clientY - local.dragStartY);
          if (!local.dragMoved && distance < 5) return;
          const thumb = localTileAtPoint(event);
          const id = thumb?.dataset?.photoFeedId || '';
          if (!id || id !== local.dragStartId || !panel.contains(thumb)) local.dragLeftStartTile = true;
          if (!local.dragMoved) {
            local.dragMoved = true;
            local.selectionMode = true;
            local.suppressClickId = local.dragStartId;
            panel.querySelector('.pf-wrap')?.classList.add('selection-mode');
            previewRange(local.dragStartId);
          }
          event.preventDefault();
          if (id && panel.contains(thumb)) previewRange(id);
        });
        window.addEventListener('pointerup', (event) => {
          const moved = local.dragMoved;
          const releasedTile = moved ? localTileAtPoint(event) : null;
          const releasedId = releasedTile?.dataset?.photoFeedId || '';
          const jitterClick = moved
            && !local.dragLeftStartTile
            && releasedId === local.dragStartId
            && panel.contains(releasedTile)
            && !localSelectionControlAtPoint(event);
          const startId = local.dragStartId;
          const committed = moved && !jitterClick ? commitRange() : false;
          if (!moved) local.dragPreview.clear();
          if (jitterClick) {
            local.dragPreview.forEach((id) => setLocalTile(id, local.selected.has(id)));
            local.dragPreview.clear();
            local.selectionMode = local.selected.size > 0;
          }
          local.dragSelecting = false;
          local.dragStartId = '';
          local.dragMode = 'add';
          local.dragMoved = false;
          local.dragLeftStartTile = false;
          if (jitterClick) {
            local.suppressClickId = startId;
            renderLocal();
            if (local.selectionMode || options.trashMode) {
              toggle(startId, event);
              renderLocal();
            } else {
              const items = filtered();
              const index = Math.max(0, items.findIndex((item) => item.id === startId));
              openLocalViewerAt(index);
            }
          } else if (committed || moved) renderLocal();
          if (moved) setTimeout(() => { local.suppressClickId = ''; }, 120);
          else local.suppressClickId = '';
        });
      }
    };
    function renderLocal(){
      const countLabel = `${local.items.length} media item${local.items.length === 1 ? '' : 's'}`;
      const titleLabel = options.title === '' ? countLabel : (options.title || 'Project Photos');
      const subtitleLabel = options.title === '' ? '' : countLabel;
      const icon = options.icon || 'fa-images';
      panel.innerHTML = `
        <div class="pf-wrap${local.selectionMode ? ' selection-mode' : ''}" data-density="${escapeHtml(local.density)}">
          <div class="pf-toolbar">
            <div class="pf-title"><i class="fas ${escapeHtml(icon)}"></i><div><strong>${escapeHtml(titleLabel)}</strong>${subtitleLabel ? `<span>${escapeHtml(subtitleLabel)}</span>` : ''}</div></div>
            <div class="pf-tools">
              <label class="pf-search"><i class="fas fa-search"></i><input type="search" value="${escapeHtml(local.query)}" placeholder="Search dates, uploaders, tags"></label>
              <div class="pf-density">${[
                { id: 'loose', label: 'Loose', icon: 'border-all' },
                { id: 'comfortable', label: 'Comfortable', icon: 'grip' },
                { id: 'compact', label: 'Compact', icon: 'table-cells' }
              ].map((mode) => `<button type="button" class="${local.density === mode.id ? 'active' : ''}" data-density="${mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join('')}</div>
              ${options.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(options.uploadLabel)}</button>` : ''}
            </div>
          </div>
          <div data-photo-feed-dynamic>${bodyHtml()}</div>
        </div>`;
      panel.querySelector('input[type="search"]')?.addEventListener('input', (event) => {
        local.query = event.target.value || '';
        renderBody();
      });
      panel.querySelectorAll('.pf-density [data-density]').forEach((btn) => btn.addEventListener('click', () => {
        local.density = btn.dataset.density || 'comfortable';
        renderLocal();
      }));
      panel.querySelector('[data-photo-feed-upload]')?.addEventListener('click', () => {
        if (typeof options.onUpload === 'function') options.onUpload();
      });
      bindBody();
      bindThumbLoading(panel);
      restoreLocalPhotoRoute();
    }
    renderLocal();
  }
  function register(){
    if (registered || !featureEnabled() || !window.Portal?.apps?.registerPortalApp) return;
    registered = true;
    window.Portal.apps.registerPortalApp({
      id: 'portal.photos_feed',
      tabId: TAB_ID,
      title: 'Photo Feed',
      icon: 'fa-images',
      order: 12,
      mount,
      onShow: () => {
        if (!state.loaded) load();
      }
    });
    window.Portal.tabs.renderTabs?.();
    if (window.Portal?.routeState?.get?.().tab === TAB_ID) {
      window.setTimeout(() => window.Portal.tabs.activateTab?.(TAB_ID), 0);
    }
  }
  function unregister(){
    if (!registered) return;
    registered = false;
    state.observer?.disconnect?.();
    state.observer = null;
    window.Portal.apps.unregisterPortalApp?.(TAB_ID);
  }
  function refreshRegistration(){
    if (featureEnabled()) register();
    else unregister();
  }
  window.addEventListener('fm:app-flags:updated', refreshRegistration);
  window.addEventListener('fm:auth:session', refreshRegistration);
  window.addEventListener('fm:project-config:updated', (event) => {
    branchProjectConfig = normalizeProjectConfig(event?.detail || {});
    rebuildProjectDisplayLabels();
  });
  window.Portal.PhotoFeed = {
    openUserModal,
    openTrash,
    trashStats,
    emptyTrash,
    trackActivity,
    userModalsEnabled,
    userActivityEnabled,
    bindThumbLoading,
    mediaThumbHtml,
    normalizePickerItems,
    openProjectMediaPicker,
    mountProjectGallery,
    refreshProjectGallery: mountProjectGallery
  };
  loadBranchProjectConfig().then(rebuildProjectDisplayLabels).catch(() => null);
  window.Portal?.appFlags?.load?.().then(refreshRegistration).catch(refreshRegistration);
  setTimeout(refreshRegistration, 800);
})();
