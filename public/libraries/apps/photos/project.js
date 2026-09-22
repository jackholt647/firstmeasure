/* public/libraries/apps/photos/project.js
 * Project modal Photos tab lifecycle.
 *
 * The request modal owns the shell and transitions. This module owns the
 * Photos tab mount point, gallery rendering, upload flow, and media helpers.
 */
(function(){
  if (!window.Portal) return;

  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  const util = Portal.util || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const cfg = Portal.cfg || window.__APP || {};
  const fmUrl = util.fmUrl || ((path) => String(path || ''));
  const showToast = (Portal.ui && typeof Portal.ui.showToast === 'function') ? Portal.ui.showToast : (() => {});
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));

  const PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,video/mp4,video/quicktime,video/webm,video/x-m4v,video/ogg';

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    context: null,
    panelRoot: null,
    overlayRoot: null,
    activeViewer: null,
    mediaHydrationToken: 0,
    mediaHydrationProjectId: '',
    mediaHydrationPromise: null,
    mediaHydrationRetryTimer: null
  };

  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }
  function isReceiptPhoto(photo = {}){
    if (window.Portal?.PhotoFeed?.isReceiptMedia) return window.Portal.PhotoFeed.isReceiptMedia(photo);
    const owner = photo.owner && typeof photo.owner === 'object' ? photo.owner : {};
    const metadata = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return !!photo.receipt
      || String(owner.slot || photo.owner_slot || '').trim().toLowerCase() === 'receipts'
      || String(photo.document_type || photo.type || metadata.document_type || '').trim().toLowerCase() === 'receipt'
      || String(photo.source || metadata.source || '').trim().toLowerCase() === 'expense_receipt_upload'
      || !!String(photo.receipt_id || metadata.receipt_id || '').trim();
  }

  function projectPhotosList(){
    const hosted = callHost('getPhotos');
    if (Array.isArray(hosted)) return hosted.filter((photo) => !isReceiptPhoto(photo));
    if (Array.isArray(state.model?.state?.projectPhotos)) return state.model.state.projectPhotos.filter((photo) => !isReceiptPhoto(photo));
    return Array.isArray(window.projectPhotos) ? window.projectPhotos.filter((photo) => !isReceiptPhoto(photo)) : [];
  }

  function setProjectPhotosList(photos){
    const next = Array.isArray(photos) ? photos : [];
    if (typeof state.host?.setPhotos === 'function') return state.host.setPhotos(next);
    if (state.model?.state) state.model.state.projectPhotos = next;
    window.projectPhotos = next;
    return next;
  }

  function currentPhotosPanelRoot(){
    return document.querySelector('#rOverlay .r-preview-panel[data-panel="photos"]');
  }

  function resolveGalleryRoot(root = null){
    let candidate = root && root.isConnected !== false ? root : null;
    if (!candidate || candidate === state.panelRoot) {
      candidate = currentPhotosPanelRoot() || candidate || (state.panelRoot?.isConnected ? state.panelRoot : null);
    }
    if (candidate?.id === 'rPhotoGallery') return candidate.isConnected ? candidate : null;
    if (candidate && !candidate.querySelector?.('#rPhotoGallery')) candidate.innerHTML = panelHtml();
    return candidate?.querySelector?.('#rPhotoGallery') || null;
  }

  function mount(context = {}){
    if (Portal.ExteriorOrder?.active()) { Portal.ExteriorOrder.renderPhotos?.(); return api; }
    state.context = context;
    state.model = context.projectModel || context.model || state.model || window.FirstMateAppContext?.modelFromContext?.(context) || null;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    state.host = context.host || (state.model && window.FirstMateAppContext?.createProjectHost?.(state.model)) || state.host || null;
    state.overlayRoot = context.overlayRoot || state.overlayRoot || $('#rOverlay');
    state.panelRoot = resolveGalleryRoot(context.panelRoot || context.roots?.main) || state.panelRoot;
    state.mounted = !!state.panelRoot;
    return api;
  }

  function ensureMounted(context = {}){
    if (context.force || context.panelRoot || !state.mounted || !resolveGalleryRoot()) mount(context);
    return state.mounted;
  }

  function setActive(active, context = {}){
    if (Portal.ExteriorOrder?.active()) { if(active)Portal.ExteriorOrder.renderPhotos?.(); return; }
    state.active = !!active;
    if (!state.active) {
      state.mediaHydrationToken += 1;
      state.mediaHydrationProjectId = '';
      state.mediaHydrationPromise = null;
      clearTimeout(state.mediaHydrationRetryTimer);
      state.mediaHydrationRetryTimer = null;
      closeActiveViewer();
      setProjectPhotoFocus(false);
    }
    else {
      ensureMounted(context);
      renderPhotoGallery();
      hydrateOwnedProjectMedia();
    }
  }

  function activeProject(){
    return callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject || null;
  }

  function activeProjectId(project = activeProject()){
    return String(
      Portal.routeState?.projectId?.(project)
      || project?.platform_project_id
      || project?.base_project_id
      || project?.project_id
      || project?.id
      || ''
    ).trim();
  }

  function ownedMediaProjectId(item = {}){
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const owner = item.owner && typeof item.owner === 'object'
      ? item.owner
      : (metadata.owner && typeof metadata.owner === 'object' ? metadata.owner : {});
    const ownerType = String(owner.type || item.owner_type || item.ownerType || metadata.owner_type || metadata.ownerType || '').trim().toLowerCase();
    const collection = String(owner.collection || item.collection || metadata.collection || '').trim().toLowerCase();
    const slot = String(owner.slot || item.slot || metadata.slot || '').trim().toLowerCase();
    const projectOwned = ownerType === 'project' || collection === 'projects' || (slot === 'photos' && ownerType !== 'organization');
    return projectOwned
      ? String(owner.id || item.owner_id || item.ownerId || metadata.owner_id || metadata.ownerId || '').trim()
      : '';
  }

  function ownedMediaReference(item = {}){
    const mediaId = String(item.media_id || item.mediaId || item.id || '').trim();
    if (!mediaId) return null;
    const tags = Array.isArray(item.tags) ? item.tags : (Array.isArray(item.metadata?.tags) ? item.metadata.tags : []);
    if (window.PlatformAPI?.media?.referenceFromUpload) {
      return window.PlatformAPI.media.referenceFromUpload(item, { field: 'photos', variant: 'original', tags });
    }
    return {
      kind: 'media_reference',
      id: mediaId,
      media_id: mediaId,
      field: 'photos',
      variant: 'original',
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      tags,
      owner: item.owner && typeof item.owner === 'object' ? item.owner : {}
    };
  }

  function isVisualMediaRecord(item = {}){
    const kind = String(item.kind || item.media_type || item.mediaType || '').trim().toLowerCase();
    const contentType = String(item.content_type || item.contentType || item.mime_type || item.mimeType || '').trim().toLowerCase();
    return kind === 'image' || kind === 'video' || contentType.startsWith('image/') || contentType.startsWith('video/');
  }

  function retryOwnedProjectMedia(projectId, attempt){
    if (!state.active || attempt > 2 || state.mediaHydrationRetryTimer) return;
    state.mediaHydrationRetryTimer = setTimeout(() => {
      state.mediaHydrationRetryTimer = null;
      if (state.active && activeProjectId() === projectId) hydrateOwnedProjectMedia(attempt);
    }, 350);
  }

  async function hydrateOwnedProjectMedia(attempt = 0){
    const project = activeProject();
    const projectId = activeProjectId(project);
    const orgId = firstMeasurePhotoOptions().orgId;
    const list = window.PlatformAPI?.media?.list;
    if (!state.active || !projectId || !orgId || typeof list !== 'function') {
      if (state.active && projectId) retryOwnedProjectMedia(projectId, attempt + 1);
      return projectPhotosList();
    }

    if (state.mediaHydrationProjectId !== projectId) {
      state.mediaHydrationToken += 1;
      state.mediaHydrationProjectId = projectId;
      state.mediaHydrationPromise = null;
      clearTimeout(state.mediaHydrationRetryTimer);
      state.mediaHydrationRetryTimer = null;
    }
    if (state.mediaHydrationPromise) return state.mediaHydrationPromise;

    const token = state.mediaHydrationToken;
    const request = (async () => {
      const result = await list.call(window.PlatformAPI.media, orgId).catch(() => null);
      if (!state.active || token !== state.mediaHydrationToken || activeProjectId() !== projectId) return projectPhotosList();

      const owned = (Array.isArray(result?.media) ? result.media : [])
        .filter((item) => ownedMediaProjectId(item) === projectId && isVisualMediaRecord(item))
        .map(ownedMediaReference)
        .filter(Boolean);
      if (!owned.length) {
        retryOwnedProjectMedia(projectId, attempt + 1);
        return projectPhotosList();
      }

      const photos = [];
      const mediaIds = new Set();
      const ownedById = new Map(owned.map((photo) => [projectPhotoId(photo), photo]));
      [...projectPhotosList(), ...owned].forEach((photo) => {
        const id = projectPhotoId(photo);
        if (id && mediaIds.has(id)) return;
        if (id) mediaIds.add(id);
        const authoritative = id ? ownedById.get(id) : null;
        photos.push(authoritative ? {
          ...photo,
          ...authoritative,
          metadata: { ...(photo.metadata || {}), ...(authoritative.metadata || {}) },
          tags: authoritative.tags || authoritative.metadata?.tags || photo.tags || photo.metadata?.tags || []
        } : photo);
      });
      setProjectPhotosList(photos);
      project.photos = photos.map(serializablePhoto);
      renderPhotoGallery();
      return photos;
    })();
    state.mediaHydrationPromise = request;
    try {
      return await request;
    } finally {
      if (state.mediaHydrationPromise === request) state.mediaHydrationPromise = null;
    }
  }

  function projectPhotoLibrary(){
    return window.PlatformAPI?.projectMedia || null;
  }

  function firstMeasurePhotoOptions(){
    return {
      orgId: window.projectOrgId?.() || String(cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '').trim(),
      firstMeasureUrlBuilder: (path) => fmUrl(path),
      googleMapsApiKey: Portal.util?.googleMapsApiKey?.() || '',
      width: 640
    };
  }

  function normalizeProjectPhotoList(project){
    const library = projectPhotoLibrary();
    if (library?.hydrateProjectPhotos) return library.hydrateProjectPhotos(project || {}, firstMeasurePhotoOptions()).photos || [];
    return ((project?.photos || [])).map(normalizePhoto).filter((photo) => photo.src);
  }

  function projectPhotoId(photo, fallback = ''){
    return String(photo?.id || photo?.photo_id || photo?.media_id || photo?.src || photo?.thumb || fallback || '').trim();
  }

  function projectMediaKind(item = {}, file = null){
    const meta = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const explicit = String(item.media_type || item.mediaType || item.type || meta.media_type || meta.mediaType || meta.type || '').trim().toLowerCase();
    if (explicit.startsWith('video')) return 'video';
    if (explicit.startsWith('image')) return 'image';
    const mime = String(file?.type || item.mime_type || item.mimeType || item.content_type || item.contentType || meta.mime_type || meta.mimeType || meta.content_type || meta.contentType || '').trim().toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    const name = String(file?.name || item.name || item.label || item.src || item.url || '').trim().toLowerCase();
    return /\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/.test(name) ? 'video' : 'image';
  }

  function isVideoMedia(item = {}){ return projectMediaKind(item) === 'video'; }
  function isImageMedia(item = {}){ return projectMediaKind(item) !== 'video'; }

  function isAcceptedProjectMediaFile(file){
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/') || type.startsWith('video/')) return true;
    return PHOTO_ACCEPT.split(',').includes(type);
  }

  function serializablePhoto(photo){
    if (!photo || typeof photo !== 'object') return photo;
    const { file, ...rest } = photo;
    return rest;
  }

  function projectThumbnailPhoto(){
    const photos = projectPhotosList();
    const project = callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject || {};
    const library = projectPhotoLibrary();
    if (library?.thumbnailPhoto) return library.thumbnailPhoto(photos, project.thumbnail_photo_id || project.thumbnailPhotoId || project.thumbnail_id);
    return photos.find((photo) => photo.is_thumbnail || photo.is_default_thumbnail) || photos[0] || null;
  }

  function syncProjectPhotosFromLibrary({ persist = false } = {}){
    const project = callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject;
    if (!project) return projectPhotosList();
    const hydrated = projectPhotoLibrary()?.hydrateProjectPhotos?.({
      ...project,
      address: ($('#rAddress')?.value || project.address || '').trim(),
      lat: ($('#rLat')?.value || project.lat || '').trim(),
      lng: ($('#rLng')?.value || project.lng || '').trim(),
      pins: window.getMarkersData?.() || [],
      photos: projectPhotosList()
    }, firstMeasurePhotoOptions());
    if (!hydrated) return projectPhotosList();
    setProjectPhotosList(hydrated.photos || []);
    project.photos = projectPhotosList().map(serializablePhoto);
    project.thumbnail_photo_id = hydrated.thumbnail_photo_id || projectPhotoId(projectThumbnailPhoto());
    project.thumbnail_photo = serializablePhoto(hydrated.thumbnail_photo || projectThumbnailPhoto());
    if (persist) (callHost('persistProject') || window.persistActiveBaseProject?.());
    return projectPhotosList();
  }

  function proposalPhotoById(id){
    const key = String(id || '').trim();
    return projectPhotosList().find((photo) => projectPhotoId(photo) === key || photo.src === key || photo.thumb === key) || null;
  }

  function normalizePhoto(photo, index = 0){
    if (typeof File !== 'undefined' && photo instanceof File) {
      const src = URL.createObjectURL(photo);
      const mediaType = projectMediaKind({}, photo);
      return {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        media_type: mediaType,
        mime_type: photo.type || '',
        src,
        thumb: src,
        alt: photo.name || `${mediaType === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
        label: photo.name || `${mediaType === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
        file: photo,
      };
    }
    const library = projectPhotoLibrary();
    if (library?.normalizePhoto) return library.normalizePhoto(photo, { ...firstMeasurePhotoOptions(), index });
    if (typeof photo === 'string') {
      return { src: photo, thumb: photo, alt: `Photo ${index + 1}`, label: ((v0) => globalThis.PlatformLanguage?.text("photos","m_7b2459374254fa",`Photo ${v0}`,{v0}) ?? `Photo ${v0}`)(index + 1) };
    }
    return {
      ...photo,
      src: photo?.src || photo?.url || '',
      thumb: photo?.thumb || photo?.thumbnail || photo?.src || photo?.url || '',
      media_type: projectMediaKind(photo),
      alt: photo?.alt || photo?.label || `${projectMediaKind(photo) === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
      label: photo?.label || `${projectMediaKind(photo) === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
    };
  }

  function uploadPlaceholderPhoto(file, index){
    const src = URL.createObjectURL(file);
    const mediaType = projectMediaKind({}, file);
    return {
      id: `uploading_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
      media_type: mediaType,
      mime_type: file.type || '',
      src,
      thumb: mediaType === 'image' ? src : '',
      alt: file.name || `${mediaType === 'video' ? 'Video' : 'Photo'} uploading`,
      label: file.name || `${mediaType === 'video' ? 'Video' : 'Photo'} uploading`,
      uploaded_at: new Date().toISOString(),
      uploading: true
    };
  }

  function replaceUploadPlaceholder(placeholderId, photo){
    const nextPhoto = photo && typeof photo === 'object' ? { ...photo, uploading: false } : null;
    if (!nextPhoto) return;
    setProjectPhotosList(projectPhotosList().map((entry) => entry?.id === placeholderId ? nextPhoto : entry));
    window.dispatchEvent(new CustomEvent('fm:project-media-upload-resolved', {
      detail: {
        projectId: activeProjectId(),
        placeholderId,
        mediaId: projectPhotoId(nextPhoto),
        photo: nextPhoto
      }
    }));
  }

  function removeUploadPlaceholder(placeholderId){
    setProjectPhotosList(projectPhotosList().filter((entry) => entry?.id !== placeholderId));
  }

  function projectMediaThumbHtml(photo, alt = ''){
    const safeAlt = escapeHtml(alt || photo?.alt || photo?.label || '');
    const src = escapeHtml(photo?.thumb || photo?.src || '');
    if (isVideoMedia(photo)) {
      const videoSrc = escapeHtml(photo?.src || photo?.thumb || '');
      return `${src ? `<img src="${src}" alt="${safeAlt}">` : (videoSrc ? `<video src="${videoSrc}" muted preload="metadata"></video>` : '<div class="r-photo-video-placeholder"><i class="fas fa-video"></i></div>')}<span class="r-photo-video-badge"><i class="fas fa-play"></i></span>`;
    }
    return `<img src="${src}" alt="${safeAlt}">`;
  }

  function projectMediaViewerHtml(photo){
    const safeAlt = escapeHtml(photo?.alt || photo?.label || '');
    const src = escapeHtml(photo?.src || photo?.thumb || '');
    if (isVideoMedia(photo)) return `<video id="rPhotoMain" src="${src}" controls autoplay playsinline preload="metadata"></video>`;
    return `<img id="rPhotoMain" src="${src}" alt="${safeAlt}">`;
  }

  function setProjectPhotoFocus(active, viewer = null){
    const win = (state.overlayRoot || $('#rOverlay'))?.querySelector?.('.r-win');
    if (!win) return;
    win.classList.toggle('photo-focus', !!active);
    callHost(active ? 'onFocus' : 'onBlur', viewer);
    if (!active || !viewer) return;
    const refresh = () => {
      viewer.updateBounds?.();
      viewer.updateMarkupLayerBounds?.();
    };
    requestAnimationFrame(refresh);
    [90, 180, 300, 500, 560].forEach((delay) => setTimeout(refresh, delay));
  }

  function setActiveViewer(viewer = null){
    state.activeViewer = viewer && typeof viewer.close === 'function' ? viewer : null;
    return state.activeViewer;
  }

  function closeActiveViewer(){
    const viewer = state.activeViewer;
    state.activeViewer = null;
    viewer?.close?.();
  }

  function portalSelectionActions(){
    if (!window.customerPortalMediaEnabled?.()) return [];
    return [
      {
        id: 'share_customer_portal',
        label: (globalThis.PlatformLanguage?.text("photos","m_a39840b5c977a8","Share to Portal") ?? "Share to Portal"),
        icon: 'fa-link',
        className: 'primary',
        onClick: async (items, helpers = {}) => {
          const ids = items.map((item) => projectPhotoId(item.photo || item)).filter(Boolean);
          const oid = window.projectOrgId?.();
          const projectId = window.customerPortalProjectId?.();
          if (!ids.length || !oid || !projectId) return;
          const result = await window.PlatformAPI?.customerPortals?.shareMedia?.(oid, projectId, ids);
          window.customerPortalState = { ...window.customerPortalState, portal: result?.portal || window.customerPortalState?.portal, error: '' };
          helpers.clearSelection?.();
          helpers.render?.();
          showToast((globalThis.PlatformLanguage?.text("photos","m_0d9562fa27881c","Shared with portal") ?? "Shared with portal"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_53c9bc811953f4",`${v0} item${v1} shared.`,{v0,v1}) ?? `${v0} item${v1} shared.`)(ids.length,ids.length === 1 ? '' : 's'), true);
        }
      },
      {
        id: 'unshare_customer_portal',
        label: (globalThis.PlatformLanguage?.text("photos","m_9f74ba121a3c17","Remove from Portal") ?? "Remove from Portal"),
        icon: 'fa-link-slash',
        onClick: async (items, helpers = {}) => {
          const ids = items.map((item) => projectPhotoId(item.photo || item)).filter(Boolean);
          const oid = window.projectOrgId?.();
          const projectId = window.customerPortalProjectId?.();
          if (!ids.length || !oid || !projectId) return;
          const result = await window.PlatformAPI?.customerPortals?.unshareMedia?.(oid, projectId, ids);
          window.customerPortalState = { ...window.customerPortalState, portal: result?.portal || window.customerPortalState?.portal, error: '' };
          helpers.clearSelection?.();
          helpers.render?.();
          showToast((globalThis.PlatformLanguage?.text("photos","m_0e8d18a3200123","Removed from portal") ?? "Removed from portal"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_e95c22e05588b5",`${v0} item${v1} updated.`,{v0,v1}) ?? `${v0} item${v1} updated.`)(ids.length,ids.length === 1 ? '' : 's'), true);
        }
      }
    ];
  }

  function portalSharedMediaIds(){
    const items = Array.isArray(window.customerPortalState?.portal?.shared_items)
      ? window.customerPortalState.portal.shared_items
      : [];
    return new Set(items
      .filter((item) => String(item?.type || 'media') === 'media')
      .map((item) => String(item?.item_id || item?.media_id || item?.id || '').trim())
      .filter(Boolean));
  }

  async function updateFocusedPortalSharing(photo, shared, viewer){
    const mediaId = projectPhotoId(photo);
    const oid = window.projectOrgId?.();
    const projectId = window.customerPortalProjectId?.();
    if (!mediaId || !oid || !projectId) return;
    try {
      const portalModule = window.Portal?.modules?.customerPortalProject;
      if (typeof portalModule?.updateSharing === 'function') {
        const updated = await portalModule.updateSharing([mediaId], shared);
        if (updated === false) return;
        viewer?.refreshActions?.();
        viewer?.refreshIndicators?.({ pulseId: shared ? 'customer_portal_shared' : '' });
        return;
      }
      const result = shared
        ? await window.PlatformAPI?.customerPortals?.shareMedia?.(oid, projectId, [mediaId])
        : await window.PlatformAPI?.customerPortals?.unshareMedia?.(oid, projectId, [mediaId]);
      window.customerPortalState = { ...window.customerPortalState, portal: result?.portal || window.customerPortalState?.portal, error: '' };
      viewer?.refreshActions?.();
      viewer?.refreshIndicators?.({ pulseId: shared ? 'customer_portal_shared' : '' });
      showToast(shared ? 'Shared with portal' : 'Removed from portal', shared ? 'This item is now visible to the customer.' : 'This item is no longer visible to the customer.', true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("photos","m_0834090fafcc24","Portal update failed") ?? "Portal update failed"), error?.message || 'Could not update this item.', false);
    }
  }

  async function ensurePortalSharingLoaded(viewer){
    if (window.customerPortalState?.portal || window.customerPortalState?.loading) return;
    await window.Portal?.modules?.customerPortalProject?.load?.({ silent: true });
    viewer?.refreshActions?.();
    viewer?.refreshIndicators?.();
  }

  function portalViewerIndicators(){
    const indicators = [{
      id:'project_note_conversation',
      label:(globalThis.PlatformLanguage?.text("photos","m_aad5e273abd212","Project note") ?? "Project note"),
      detail:'This media has a Notes conversation',
      icon:'comments',
      tone:'info',
      visible:({ photo }) => String(photo?.metadata?.source || '').toLowerCase() === 'project_notes'
    }];
    if (!window.customerPortalMediaEnabled?.()) return indicators;
    indicators.push({
      id: 'customer_portal_shared',
      label: (globalThis.PlatformLanguage?.text("photos","m_58f4d4dde98ff6","Shared with customer") ?? "Shared with customer"),
      detail: 'Visible in Customer Portal',
      icon: 'check',
      tone: 'success',
      visible: ({ photo }) => portalSharedMediaIds().has(projectPhotoId(photo))
    });
    return indicators;
  }

  function portalViewerActions(){
    const conversationAction = {
      id:'open_project_note_conversation',
      label:(globalThis.PlatformLanguage?.text("photos","m_0b4fd28e57de4f","Open Note Conversation") ?? "Open Note Conversation"),
      icon:'comments',
      visible:({ photo }) => String(photo?.metadata?.source || '').toLowerCase() === 'project_notes',
      onClick:async ({ photo }) => {
        const oid = firstMeasurePhotoOptions().orgId;
        const projectId = activeProjectId();
        const mediaId = projectPhotoId(photo);
        const ensured = await window.ChannelsAPI?.channels?.ensureProject?.(oid, projectId);
        const channelId = ensured?.channel?.id;
        if (!channelId) return;
        const result = await window.ChannelsAPI?.resources?.list?.(oid, channelId, { type:'media' });
        const ref = (result?.resources || []).find((item) => String(item.resource_id) === mediaId && item.source_message_id);
        window.dispatchEvent(new CustomEvent('fm:open-channel-message', {
          detail:{ channel_id:channelId, message_id:ref?.source_message_id || '' }
        }));
      }
    };
    if (!window.customerPortalMediaEnabled?.()) return [conversationAction];
    const available = ({ photo }) => !!projectPhotoId(photo) && !!window.customerPortalProjectId?.();
    return [
      conversationAction,
      {
        id: 'share_customer_portal',
        label: (globalThis.PlatformLanguage?.text("photos","m_a39840b5c977a8","Share to Portal") ?? "Share to Portal"),
        pendingLabel: 'Sharing…',
        icon: 'link',
        visible: (context) => available(context) && !portalSharedMediaIds().has(projectPhotoId(context.photo)),
        onClick: ({ photo, viewer }) => updateFocusedPortalSharing(photo, true, viewer)
      },
      {
        id: 'unshare_customer_portal',
        label: (globalThis.PlatformLanguage?.text("photos","m_9f74ba121a3c17","Remove from Portal") ?? "Remove from Portal"),
        pendingLabel: 'Removing…',
        icon: 'link-slash',
        className: 'danger',
        visible: (context) => available(context) && portalSharedMediaIds().has(projectPhotoId(context.photo)),
        onClick: ({ photo, viewer }) => updateFocusedPortalSharing(photo, false, viewer)
      }
    ];
  }

  function renderPhotoGallery(){
    if (Portal.ExteriorOrder?.active()) { Portal.ExteriorOrder.renderPhotos?.(); return; }
    ensureMounted();
    const root = resolveGalleryRoot();
    if (!root) return;
    state.panelRoot = root;
    const photos = projectPhotosList();
    if (Portal.PhotoFeed?.mountProjectGallery) {
      const project = callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject || {};
      root.innerHTML = `
        <div id="rPhotoFeedMount" style="height:100%;min-height:0"></div>
        <input type="file" id="rPhotoInput" accept="${PHOTO_ACCEPT}" multiple style="display:none">
      `;
      const input = root.querySelector('#rPhotoInput');
      input?.addEventListener('change', async () => {
        await addPhotoFiles(input.files);
        input.value = '';
      });
      Portal.PhotoFeed.mountProjectGallery(root.querySelector('#rPhotoFeedMount'), {
        project,
        photos,
        title: '',
        uploadLabel: 'Upload',
        enableProjectLinks: false,
        projectLinkEnabled: false,
        boundsTarget: root,
        routeScope: 'project',
        initialPhotoId: window.pendingRoutePhotoId,
        selectionActions: portalSelectionActions(),
        viewerActions: portalViewerActions(),
        viewerIndicators: portalViewerIndicators(),
        onTagsChange: async ({ photo, tags }) => {
          const mediaId = projectPhotoId(photo);
          if (!mediaId || typeof window.PlatformAPI?.media?.updateTags !== 'function') throw new Error('Media tagging is not available.');
          const result = await window.PlatformAPI.media.updateTags(firstMeasurePhotoOptions().orgId, mediaId, tags);
          const next = projectPhotosList().map((entry) => projectPhotoId(entry) === mediaId ? {
            ...entry,
            tags,
            metadata: { ...(entry.metadata || {}), tags }
          } : entry);
          setProjectPhotosList(next);
          project.photos = next.map(serializablePhoto);
          callHost('persistProject') || window.persistActiveBaseProject?.();
          return result;
        },
        onViewerOpen: (viewer) => {
          setActiveViewer(viewer);
          setProjectPhotoFocus(true, viewer);
          ensurePortalSharingLoaded(viewer);
        },
        onViewerClose: () => {
          setActiveViewer(null);
          window.pendingRoutePhotoId = '';
          setProjectPhotoFocus(false);
        },
        onUpload: () => input?.click()
      });
      return;
    }

    if (!photos.length) {
      root.innerHTML = `
        <div class="r-photo-empty" id="rPhotoDropZone">
          <strong>${(globalThis.PlatformLanguage?.text("photos","m_72c4eca00405ce","No media uploaded yet") ?? "No media uploaded yet")}</strong>
          <div>${(globalThis.PlatformLanguage?.text("photos","m_a5e1cd4c41f31c","This project does not have any photos or videos yet.") ?? "This project does not have any photos or videos yet.")}</div>
          <div class="r-photo-empty-tile" id="rPhotoUploadEmpty">
            <div class="r-photo-empty-plus">+</div>
          </div>
        </div>
        <input type="file" id="rPhotoInput" accept="${String(PHOTO_ACCEPT)}" multiple style="display:none">
      `;
      bindPhotoUploadUI();
      return;
    }

    window.activePhotoIndex = Math.max(0, Math.min(Number(window.activePhotoIndex || 0), photos.length - 1));
    const active = photos[window.activePhotoIndex];

    if (!window.photoViewerOpen) {
      root.innerHTML = `
        <div class="r-photo-gallery is-grid">
          <div class="r-photo-gallery-head">
            <strong>${((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_7aeb1a825e7d39",`${v0} media item${v1}`,{v0,v1}) ?? `${v0} media item${v1}`)(photos.length,photos.length === 1 ? '' : 's')}</strong>
            <button type="button" class="r-photo-upload" id="rPhotoUploadBtn"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("photos","m_9ca9dace4f122f"," Upload") ?? " Upload")}</button>
          </div>
          <div class="r-photo-grid-only" id="rPhotoGridOnly">
            ${String(photos.map((photo, index) => `
              <button type="button" class="r-photo-thumb" data-photo-index="${index}">
                ${projectMediaThumbHtml(photo)}
              </button>
            `).join(''))}
          </div>
        </div>
        <input type="file" id="rPhotoInput" accept="${String(PHOTO_ACCEPT)}" multiple style="display:none">
      `;
      root.querySelectorAll('.r-photo-thumb').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.activePhotoIndex = Number(btn.dataset.photoIndex || 0);
          if (window.FirstMateMarkup?.openPhotoViewer) {
            const viewer = window.FirstMateMarkup.openPhotoViewer({
              photos,
              index: window.activePhotoIndex,
              project: window.activeBaseProject || {},
              boundsTarget: root,
              projectLinkEnabled: false,
              actions: portalViewerActions(),
              indicators: portalViewerIndicators(),
              onClose: () => {
                setActiveViewer(null);
                setProjectPhotoFocus(false);
              }
            });
            setActiveViewer(viewer);
            setProjectPhotoFocus(true, viewer);
            ensurePortalSharingLoaded(viewer);
          } else {
            window.photoViewerOpen = true;
            renderPhotoGallery();
          }
        });
      });
      bindPhotoUploadUI();
      return;
    }

    root.innerHTML = `
      <div class="r-photo-gallery viewer">
        <div class="r-photo-viewer-head">
          <button type="button" class="r-photo-upload" id="rPhotoBack"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("photos","m_1dcaeaad30c689"," All Photos") ?? " All Photos")}</button>
          <div class="r-photo-viewer-title">${String(escapeHtml(active.label))}</div>
          <div style="width:96px"></div>
        </div>
        <div class="r-photo-stage">
          <button type="button" class="r-photo-nav prev" id="rPhotoPrev" aria-label="${(globalThis.PlatformLanguage?.text("photos","m_ff93a3105bd290","Previous photo") ?? "Previous photo")}"><i class="fas fa-chevron-left"></i></button>
          ${String(projectMediaViewerHtml(active))}
          <button type="button" class="r-photo-nav next" id="rPhotoNext" aria-label="${(globalThis.PlatformLanguage?.text("photos","m_289ae0bcddeebf","Next photo") ?? "Next photo")}"><i class="fas fa-chevron-right"></i></button>
          <div class="r-photo-count">${String(window.activePhotoIndex + 1)} / ${String(photos.length)}</div>
        </div>
        <div class="r-photo-strip" id="rPhotoStrip">
          ${String(photos.map((photo, index) => `
            <button type="button" class="r-photo-thumb${index === window.activePhotoIndex ? ' active' : ''}" data-photo-index="${index}">
              ${projectMediaThumbHtml(photo)}
            </button>
          `).join(''))}
        </div>
      </div>
      <input type="file" id="rPhotoInput" accept="${String(PHOTO_ACCEPT)}" multiple style="display:none">
    `;

    root.querySelector('#rPhotoPrev')?.addEventListener('click', () => showRelativePhoto(-1));
    root.querySelector('#rPhotoNext')?.addEventListener('click', () => showRelativePhoto(1));
    root.querySelector('#rPhotoBack')?.addEventListener('click', () => {
      window.photoViewerOpen = false;
      renderPhotoGallery();
    });
    root.querySelectorAll('.r-photo-thumb').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.activePhotoIndex = Number(btn.dataset.photoIndex || 0);
        window.photoViewerOpen = true;
        renderPhotoGallery();
      });
    });
    bindPhotoUploadUI();
  }

  function bindPhotoUploadUI(){
    const root = resolveGalleryRoot();
    const input = root?.querySelector('#rPhotoInput') || $('#rPhotoInput');
    const emptyBtn = root?.querySelector('#rPhotoUploadEmpty') || $('#rPhotoUploadEmpty');
    const uploadBtn = root?.querySelector('#rPhotoUploadBtn') || $('#rPhotoUploadBtn');
    const dropTargets = [
      root?.querySelector('#rPhotoDropZone') || $('#rPhotoDropZone'),
      root?.querySelector('.r-photo-stage'),
      root?.querySelector('#rPhotoStrip')
    ].filter(Boolean);

    if (emptyBtn) emptyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input?.click();
    });
    if (uploadBtn) uploadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input?.click();
    });
    if (input) {
      input.addEventListener('change', async () => {
        await addPhotoFiles(input.files);
        input.value = '';
      });
    }

    dropTargets.forEach((target) => {
      ['dragenter', 'dragover'].forEach((eventName) => {
        target.addEventListener(eventName, (e) => {
          e.preventDefault();
          target.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach((eventName) => {
        target.addEventListener(eventName, async (e) => {
          e.preventDefault();
          if (eventName === 'drop') await addPhotoFiles(e.dataTransfer?.files);
          target.classList.remove('dragover');
        });
      });
      if (target.id === 'rPhotoDropZone') {
        target.addEventListener('click', (e) => {
          e.preventDefault();
          input?.click();
        });
      }
    });
  }

  function openStorageCheckoutModal(){
    document.getElementById('storageCheckoutModal')?.remove();
    const back = document.createElement('div');
    back.id = 'storageCheckoutModal';
    back.className = 'storage-checkout-backdrop';
    back.innerHTML = `
      <div class="storage-checkout-modal" role="dialog" aria-modal="true" aria-labelledby="storageCheckoutTitle">
        <div class="storage-checkout-head">
          <div>
            <strong id="storageCheckoutTitle">${(globalThis.PlatformLanguage?.text("photos","m_fd0221a1d87d1d","Get More Storage") ?? "Get More Storage")}</strong>
            <span>${(globalThis.PlatformLanguage?.text("photos","m_eba5a2ca652c52","Storage checkout options will appear here.") ?? "Storage checkout options will appear here.")}</span>
          </div>
          <button type="button" class="storage-checkout-close" data-storage-checkout-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
        </div>
        <div class="storage-checkout-body">${(globalThis.PlatformLanguage?.text("photos","m_66ecec49f56389","Checkout placeholder") ?? "Checkout placeholder")}</div>
      </div>`;
    document.body.appendChild(back);
    let modalHandle = null;
    const close = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      back.remove();
    };
    back.querySelector('[data-storage-checkout-close]')?.addEventListener('click', close);
    modalHandle = Portal.modals?.register?.(back, {
      id: 'storage-checkout',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: close
    }) || null;
  }

  async function showStorageLimitModal({ usedBytes = 0, limitBytes = 0, addingBytes = 0 } = {}){
    const formatBytes = window.formatStorageBytes || ((bytes) => `${Math.round(Number(bytes || 0) / (1024 * 1024))} MB`);
    const message = `This upload would put this company over its media storage limit. Current usage is ${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}. Selected files add about ${formatBytes(addingBytes)}. Manage storage to empty trash or get more storage.`;
    if (!window.purchasableStorageEnabled?.()) {
      await (window.PlatformUI?.alert?.(message, { title: (globalThis.PlatformLanguage?.text("photos","m_424ce81c07dac7","Storage limit reached") ?? "Storage limit reached"), okLabel: 'OK' }) || Promise.resolve(alert(message)));
      return;
    }
    const ok = await (window.PlatformUI?.confirm?.(message, {
      title: (globalThis.PlatformLanguage?.text("photos","m_424ce81c07dac7","Storage limit reached") ?? "Storage limit reached"),
      okLabel: 'Manage Storage',
      cancelLabel: 'Cancel'
    }) || Promise.resolve(confirm(message)));
    if (ok) window.openStorageSettings?.() || openStorageCheckoutModal();
  }

  async function ensurePhotoStorageCapacity(files = []){
    if (!window.storageLimitsEnabled?.() || !window.PlatformAPI?.mediaStorage) return true;
    const orgId = window.projectOrgId?.();
    if (!orgId) return true;
    const addingBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (!addingBytes) return true;
    const usage = await window.PlatformAPI.mediaStorage.get(orgId).catch(() => window.PlatformAPI.mediaStorage.current(orgId));
    const usedBytes = Number(usage?.used_bytes || 0);
    const limitBytes = window.storageLimitBytes?.() || 0;
    if (!limitBytes || usedBytes + addingBytes <= limitBytes) return true;
    await showStorageLimitModal({ usedBytes, limitBytes, addingBytes });
    return false;
  }

  async function addPhotoFiles(fileList){
    const files = [...(fileList || [])].filter(isAcceptedProjectMediaFile);
    if (!files.length) return [];
    if (!(await ensurePhotoStorageCapacity(files))) return [];
    window.ensureDraftBaseProject?.();
    const hadPhotos = projectPhotosList().length > 0;
    let added = [];
    const placeholders = files.map((file, index) => uploadPlaceholderPhoto(file, projectPhotosList().length + index));
    setProjectPhotosList([...projectPhotosList(), ...placeholders]);
    window.dispatchEvent(new CustomEvent('fm:project-media-upload-started', {
      detail: { projectId: activeProjectId(), photos: placeholders }
    }));
    renderPhotoGallery();
    const orgId = window.projectOrgId?.();
    const projectId = window.activeBaseProject?.id || '';
    const library = projectPhotoLibrary();
    if (orgId && projectId && (library?.uploadMedia || library?.uploadPhoto)) {
      for (const [index, file] of files.entries()) {
        const placeholder = placeholders[index];
        try {
          const upload = library.uploadMedia || library.uploadPhoto;
          const persistedPhotos = projectPhotosList().filter((entry) => !entry?.uploading).map(serializablePhoto);
          const result = await upload.call(library, orgId, projectId, { ...window.activeBaseProject, photos: persistedPhotos }, file, {
            thumbnails: true,
            compression: isVideoMedia({ mime_type: file.type }) ? undefined : { quality: 0.88, max_width: 2400, max_height: 2400 }
          });
          const photo = result?.photo;
          if (photo) {
            const normalizedPhoto = library.normalizePhotos([photo], firstMeasurePhotoOptions())[0] || photo;
            replaceUploadPlaceholder(placeholder.id, normalizedPhoto);
            const current = projectPhotosList();
            const pending = current.filter((entry) => entry?.uploading);
            const completed = current.filter((entry) => !entry?.uploading);
            const serverPhotos = library.normalizePhotos(result?.document?.data?.photos || [], firstMeasurePhotoOptions());
            if (serverPhotos.length) {
              const merged = [];
              const mediaIds = new Set();
              [...serverPhotos, ...completed, ...pending].forEach((entry) => {
                const id = projectPhotoId(entry);
                if (id && mediaIds.has(id)) return;
                if (id) mediaIds.add(id);
                merged.push(entry);
              });
              setProjectPhotosList(merged);
            }
            added.push(normalizedPhoto);
            window.trackRequestActivity?.({
              type: 'photo_uploaded',
              summary: `${projectMediaKind(normalizedPhoto, file) === 'video' ? 'Uploaded a video' : 'Uploaded a photo'}`,
              target: {
                media_id: normalizedPhoto.media_id || normalizedPhoto.id || photo.media_id || photo.id || '',
                media_type: projectMediaKind(normalizedPhoto, file)
              },
              metadata: {
                file_name: file.name || normalizedPhoto.file_name || '',
                size_bytes: Number(file.size || normalizedPhoto.size_bytes || 0)
              }
            });
            renderPhotoGallery();
          }
        } catch (error) {
          console.warn('Project photo upload failed; using local preview photo instead.', error);
          const local = normalizePhoto(file, projectPhotosList().length + added.length);
          replaceUploadPlaceholder(placeholder.id, local);
          added.push(local);
          renderPhotoGallery();
        }
      }
    } else {
      added = files.map((file, index) => normalizePhoto(file, projectPhotosList().length + index));
      placeholders.forEach((placeholder, index) => replaceUploadPlaceholder(placeholder.id, added[index]));
    }
    placeholders.forEach((placeholder) => {
      if (projectPhotosList().some((photo) => photo?.id === placeholder.id && photo.uploading)) removeUploadPlaceholder(placeholder.id);
    });
    syncProjectPhotosFromLibrary();
    if (projectPhotosList().length && window.activePhotoIndex >= projectPhotosList().length) window.activePhotoIndex = projectPhotosList().length - 1;
    window.photoViewerOpen = hadPhotos ? window.photoViewerOpen : false;
    renderPhotoGallery();
    window.queueAutosaveNotice?.();
    window.persistActiveBaseProject?.();
    return added;
  }

  async function loadOwnedProjectMedia(){
    const project = activeProject();
    const projectId = activeProjectId(project);
    const orgId = firstMeasurePhotoOptions().orgId;
    const list = window.PlatformAPI?.media?.list;
    if (!project || !projectId || !orgId || typeof list !== 'function') return projectPhotosList();
    const result = await list.call(window.PlatformAPI.media, orgId).catch(() => null);
    if (activeProjectId() !== projectId) return projectPhotosList();
    const owned = (Array.isArray(result?.media) ? result.media : [])
      .filter((item) => ownedMediaProjectId(item) === projectId && isVisualMediaRecord(item))
      .map(ownedMediaReference)
      .filter(Boolean);
    const photos = [];
    const mediaIds = new Set();
    [...projectPhotosList(), ...owned].forEach((photo) => {
      const id = projectPhotoId(photo);
      if (id && mediaIds.has(id)) return;
      if (id) mediaIds.add(id);
      photos.push(photo);
    });
    setProjectPhotosList(photos);
    project.photos = photos.filter((photo) => !photo?.uploading).map(serializablePhoto);
    return photos;
  }

  function showRelativePhoto(delta){
    const photos = projectPhotosList();
    if (!photos.length) return;
    window.photoViewerOpen = true;
    window.activePhotoIndex = (Number(window.activePhotoIndex || 0) + delta + photos.length) % photos.length;
    renderPhotoGallery();
  }

  function handleGalleryKeydown(e){
    if (window.activePreviewTab !== 'photos' || !projectPhotosList().length) return;
    if (e.target?.closest?.('.fm-photo-markup-text,[contenteditable="true"],textarea,input,select,.fm-photo-modal')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      showRelativePhoto(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      showRelativePhoto(-1);
    }
  }

  function reset(){
    state.active = false;
    state.mediaHydrationToken += 1;
    state.mediaHydrationProjectId = '';
    state.mediaHydrationPromise = null;
    clearTimeout(state.mediaHydrationRetryTimer);
    state.mediaHydrationRetryTimer = null;
    closeActiveViewer();
    setProjectPhotoFocus(false);
  }

  function unmount(){
    reset();
    state.mounted = false;
    state.host = null;
    state.panelRoot = null;
    state.overlayRoot = null;
  }

  function context(){
    return {
      mounted: state.mounted,
      active: state.active,
      panelRoot: state.panelRoot,
      overlayRoot: state.overlayRoot,
      activeViewer: state.activeViewer
    };
  }

  function panelHtml(){
    return '<div class="r-photo-wrap" id="rPhotoGallery"></div>';
  }

  const projectPhotosApi = {
    projectPhotoLibrary,
    firstMeasurePhotoOptions,
    normalizeProjectPhotoList,
    projectPhotoId,
    projectMediaKind,
    isVideoMedia,
    isImageMedia,
    isAcceptedProjectMediaFile,
    serializablePhoto,
    projectThumbnailPhoto,
    syncProjectPhotosFromLibrary,
    proposalPhotoById,
    normalizePhoto,
    uploadPlaceholderPhoto,
    replaceUploadPlaceholder,
    removeUploadPlaceholder,
    projectMediaThumbHtml,
    projectMediaViewerHtml,
    setProjectPhotoFocus,
    renderPhotoGallery,
    bindPhotoUploadUI,
    openStorageCheckoutModal,
    showStorageLimitModal,
    ensurePhotoStorageCapacity,
    addPhotoFiles,
    loadOwnedProjectMedia,
    showRelativePhoto,
    handleGalleryKeydown
  };

  function invoke(name, args = []){
    const fn = projectPhotosApi[name];
    if (typeof fn !== 'function') return undefined;
    return fn(...(Array.isArray(args) ? args : []));
  }

  function functionNames(){
    return Object.keys(projectPhotosApi);
  }

  const api = {
    invoke,
    functionNames,
    mount,
    ensureMounted,
    setActive,
    activate: (context = {}) => setActive(true, context),
    deactivate: (context = {}) => setActive(false, context),
    render: renderPhotoGallery,
    reset,
    unmount,
    context
  };

  window.addEventListener('fm:media-renamed', (event) => {
    const mediaId = String(event?.detail?.mediaId || '').trim();
    const name = String(event?.detail?.name || '').trim();
    if (!mediaId || !name) return;
    const photos = projectPhotosList();
    if (!photos.some((photo) => projectPhotoId(photo) === mediaId)) return;
    setProjectPhotosList(photos.map((photo) => projectPhotoId(photo) === mediaId
      ? { ...photo, label: name, alt: name, file_name: String(event.detail.fileName || photo.file_name || '') }
      : photo));
    const project = activeProject();
    if (project) project.photos = projectPhotosList().map(serializablePhoto);
    callHost('persistProject') || window.persistActiveBaseProject?.();
    if (state.active) renderPhotoGallery();
  });

  window.addEventListener('fm:media-video-saved', (event) => {
    if (!state.active) return;
    const projectId = String(event?.detail?.projectId || '').trim();
    if (projectId && projectId !== activeProjectId()) return;
    state.mediaHydrationPromise = null;
    hydrateOwnedProjectMedia();
  });

  window.addEventListener('fm:project-note-media-uploaded', (event) => {
    const projectId = String(event?.detail?.projectId || '').trim();
    if (!projectId || projectId !== activeProjectId()) return;
    state.mediaHydrationPromise = null;
    if (state.active) hydrateOwnedProjectMedia();
  });

  Portal.modules = Portal.modules || {};
  Portal.modules.projectPhotosTab = api;
  Portal.ProjectPhotosTab = api;

  runtime?.registerApp?.({
    id: 'project.photos',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("photos","m_eae44a163f8a5a","Project Photos") ?? "Project Photos"),
    label: (globalThis.PlatformLanguage?.text("photos","m_be4cfb58b9c4d7","Photos") ?? "Photos"),
    icon: 'fa-images',
    order: 20,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    enabled: (context = {}) => context.projectPhotosEnabled !== false,
    panelHtml,
    mount: (context = {}) => mount(context)
  });
})();
