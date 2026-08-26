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
    overlayRoot: null
  };

  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  function projectPhotosList(){
    const hosted = callHost('getPhotos');
    if (Array.isArray(hosted)) return hosted;
    if (Array.isArray(state.model?.state?.projectPhotos)) return state.model.state.projectPhotos;
    return Array.isArray(window.projectPhotos) ? window.projectPhotos : [];
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
    state.active = !!active;
    if (!state.active) setProjectPhotoFocus(false);
    else {
      ensureMounted(context);
      renderPhotoGallery();
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
      return { src: photo, thumb: photo, alt: `Photo ${index + 1}`, label: `Photo ${index + 1}` };
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

  function portalSelectionActions(){
    if (!window.customerPortalMediaEnabled?.()) return [];
    return [
      {
        id: 'share_customer_portal',
        label: 'Share to Portal',
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
          showToast('Shared with portal', `${ids.length} item${ids.length === 1 ? '' : 's'} shared.`, true);
        }
      },
      {
        id: 'unshare_customer_portal',
        label: 'Remove from Portal',
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
          showToast('Removed from portal', `${ids.length} item${ids.length === 1 ? '' : 's'} updated.`, true);
        }
      }
    ];
  }

  function renderPhotoGallery(){
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
        onViewerOpen: (viewer) => setProjectPhotoFocus(true, viewer),
        onViewerClose: () => {
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
          <strong>No media uploaded yet</strong>
          <div>This project does not have any photos or videos yet.</div>
          <div class="r-photo-empty-tile" id="rPhotoUploadEmpty">
            <div class="r-photo-empty-plus">+</div>
          </div>
        </div>
        <input type="file" id="rPhotoInput" accept="${PHOTO_ACCEPT}" multiple style="display:none">
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
            <strong>${photos.length} media item${photos.length === 1 ? '' : 's'}</strong>
            <button type="button" class="r-photo-upload" id="rPhotoUploadBtn"><i class="fas fa-plus"></i> Upload</button>
          </div>
          <div class="r-photo-grid-only" id="rPhotoGridOnly">
            ${photos.map((photo, index) => `
              <button type="button" class="r-photo-thumb" data-photo-index="${index}">
                ${projectMediaThumbHtml(photo)}
              </button>
            `).join('')}
          </div>
        </div>
        <input type="file" id="rPhotoInput" accept="${PHOTO_ACCEPT}" multiple style="display:none">
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
              onClose: () => setProjectPhotoFocus(false)
            });
            setProjectPhotoFocus(true, viewer);
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
          <button type="button" class="r-photo-upload" id="rPhotoBack"><i class="fas fa-arrow-left"></i> All Photos</button>
          <div class="r-photo-viewer-title">${escapeHtml(active.label)}</div>
          <div style="width:96px"></div>
        </div>
        <div class="r-photo-stage">
          <button type="button" class="r-photo-nav prev" id="rPhotoPrev" aria-label="Previous photo"><i class="fas fa-chevron-left"></i></button>
          ${projectMediaViewerHtml(active)}
          <button type="button" class="r-photo-nav next" id="rPhotoNext" aria-label="Next photo"><i class="fas fa-chevron-right"></i></button>
          <div class="r-photo-count">${window.activePhotoIndex + 1} / ${photos.length}</div>
        </div>
        <div class="r-photo-strip" id="rPhotoStrip">
          ${photos.map((photo, index) => `
            <button type="button" class="r-photo-thumb${index === window.activePhotoIndex ? ' active' : ''}" data-photo-index="${index}">
              ${projectMediaThumbHtml(photo)}
            </button>
          `).join('')}
        </div>
      </div>
      <input type="file" id="rPhotoInput" accept="${PHOTO_ACCEPT}" multiple style="display:none">
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
            <strong id="storageCheckoutTitle">Get More Storage</strong>
            <span>Storage checkout options will appear here.</span>
          </div>
          <button type="button" class="storage-checkout-close" data-storage-checkout-close aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="storage-checkout-body">Checkout placeholder</div>
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
      await (window.PlatformUI?.alert?.(message, { title: 'Storage limit reached', okLabel: 'OK' }) || Promise.resolve(alert(message)));
      return;
    }
    const ok = await (window.PlatformUI?.confirm?.(message, {
      title: 'Storage limit reached',
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
            const pending = projectPhotosList().filter((entry) => entry?.uploading);
            const serverPhotos = library.normalizePhotos(result?.document?.data?.photos || [], firstMeasurePhotoOptions());
            if (serverPhotos.length) setProjectPhotosList([...serverPhotos, ...pending]);
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
      overlayRoot: state.overlayRoot
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

  Portal.modules = Portal.modules || {};
  Portal.modules.projectPhotosTab = api;
  Portal.ProjectPhotosTab = api;

  runtime?.registerApp?.({
    id: 'project.photos',
    kind: 'project_modal_app',
    title: 'Project Photos',
    label: 'Photos',
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
