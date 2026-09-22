/* public/libraries/apps/customer-portal/project.js
 * Embeddable customer portal project pane.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const showToast = Portal?.ui?.showToast || window.showToast || (() => {});

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    activeSubtab: 'overview',
    portal: { loading: false, portal: null, activity: [], error: '' },
    mediaSelection: { shared: new Set(), unshared: new Set() }
  };

  function hostFor(context = {}){
    return context.projectWorkspace || context.host?.projectWorkspace || context.host || state.host || {};
  }

  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  function modelFromContext(context = {}){
    if (context.projectModel || context.model) return context.projectModel || context.model;
    if (context.projectWorkspace || context.host) return null;
    return state.model || window.FirstMateAppContext?.modelFromContext?.(context) || null;
  }

  function project(){
    return callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject || {};
  }

  function photos(){
    const hosted = callHost('getPhotos');
    if (Array.isArray(hosted)) return hosted;
    if (Array.isArray(state.model?.state?.projectPhotos)) return state.model.state.projectPhotos;
    if (Array.isArray(window.projectPhotos)) return window.projectPhotos;
    return Array.isArray(project().photos) ? project().photos : [];
  }

  function projectId(){
    return String(project()?.id || '').trim();
  }

  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function projectContact(){
    const current = project() || {};
    const contacts = Array.isArray(current.contacts) ? current.contacts : [];
    const primary = contacts.find((entry) => entry?.primary) || contacts.find((entry) => firstText(entry?.id, entry?.contact_id, entry?.name, entry?.email, entry?.phone)) || {};
    const customer = current.customer && typeof current.customer === 'object' && !Array.isArray(current.customer) ? current.customer : {};
    const id = firstText(primary.id, primary.contact_id, current.contact_id, current.primary_contact_id);
    return {
      id,
      contact_id: id,
      name: firstText(primary.name, customer.name, current.customer_name, current.customerName, current.primary_contact_name, current.resident, current.resident_name),
      email: firstText(primary.email, customer.email, current.customer_email, current.customerEmail, current.primary_contact_email, current.resident_email).toLowerCase(),
      phone: firstText(primary.phone, Array.isArray(primary.phones) ? primary.phones[0] : '', customer.phone, current.customer_phone, current.customerPhone, current.primary_contact_phone, current.resident_phone),
      address: firstText(primary.address, primary.default_address, current.contact_address, current.customer_address, current.primary_contact_address, customer.address)
    };
  }

  function orgId(){
    return String(callHost('projectOrgId') || window.projectOrgId?.() || Portal?.cfg?.userOrgId || Portal?.cfg?.orgId || window.__APP?.userOrgId || '').trim();
  }

  function feature(name, fallback = true){
    const fromHost = callHost(name);
    if (fromHost !== undefined) return !!fromHost;
    const fn = window[name];
    if (typeof fn === 'function') return !!fn();
    return fallback;
  }

  function customerPortalEnabled(){
    return feature('customerPortalEnabled', true);
  }

  function customerPortalMediaEnabled(){
    return feature('customerPortalMediaEnabled', true);
  }

  function photoId(photo, fallback = ''){
    const hosted = callHost('projectPhotoId', photo, fallback);
    if (hosted) return String(hosted);
    return String(photo?.id || photo?.photo_id || photo?.media_id || photo?.src || photo?.thumb || fallback || '').trim();
  }

  function isVideo(photo = {}){
    const hosted = callHost('isVideoMedia', photo);
    if (hosted !== undefined) return !!hosted;
    const type = String(photo.media_type || photo.mediaType || photo.type || photo.mime_type || photo.mimeType || '').toLowerCase();
    return type.startsWith('video') || /\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/i.test(String(photo.src || photo.url || ''));
  }

  function panelHtml(){
    return '<div class="r-cp-panel" id="rCustomerPortalPanel"></div>';
  }

  function resolveRoot(context = {}){
    const root = context.panelRoot || context.roots?.main || state.panelRoot || $('#rCustomerPortalPanel');
    if (root?.id === 'rCustomerPortalPanel') return root;
    return root?.querySelector?.('#rCustomerPortalPanel') || root || null;
  }

  function setPortal(next){
    state.portal = next && typeof next === 'object'
      ? next
      : { loading: false, portal: null, activity: [], error: '' };
    if (state.model?.state) state.model.state.customerPortalState = state.portal;
    return state.portal;
  }

  function sharedPortalMediaIds(){
    const items = Array.isArray(state.portal.portal?.shared_items) ? state.portal.portal.shared_items : [];
    return new Set(items
      .filter((item) => String(item?.type || 'media') === 'media')
      .map((item) => String(item?.item_id || item?.media_id || item?.id || '').trim())
      .filter(Boolean));
  }

  function cleanMediaSelection(shared){
    const validIds = new Set(photos().map((photo) => photoId(photo)).filter(Boolean));
    const next = { shared: new Set(), unshared: new Set() };
    ['shared', 'unshared'].forEach((bucket) => {
      const shouldBeShared = bucket === 'shared';
      (state.mediaSelection[bucket] || new Set()).forEach((id) => {
        if (validIds.has(id) && shared.has(id) === shouldBeShared) next[bucket].add(id);
      });
    });
    state.mediaSelection = next;
  }

  function mediaThumbHtml(photo, label){
    const safeAlt = escapeHtml(label || photo?.alt || photo?.label || '');
    const video = isVideo(photo);
    const imageSrc = String(photo?.thumb || photo?.src || '').trim();
    const videoThumbSrc = String(photo?.thumb || '').trim();
    const originalSrc = String(photo?.src || photo?.thumb || '').trim();
    const fallbackIcon = video ? 'fa-video' : 'fa-image';
    let mediaHtml = '';
    if (video) {
      if (videoThumbSrc) {
        mediaHtml = `<img src="${escapeHtml(videoThumbSrc)}" alt="${safeAlt}" loading="lazy" decoding="async" data-cp-thumb-img data-cp-base-src="${escapeHtml(videoThumbSrc)}" data-cp-original-src="${escapeHtml(originalSrc)}" data-cp-media-kind="video">`;
      } else if (originalSrc) {
        mediaHtml = `<video src="${escapeHtml(originalSrc)}" muted playsinline preload="metadata" data-cp-thumb-video></video>`;
      }
    } else if (imageSrc) {
      mediaHtml = `<img src="${escapeHtml(imageSrc)}" alt="${safeAlt}" loading="lazy" decoding="async" data-cp-thumb-img data-cp-base-src="${escapeHtml(imageSrc)}" data-cp-media-kind="image">`;
    }
    return `
      <div class="r-cp-thumb${String(mediaHtml ? '' : ' failed')}">
        ${String(mediaHtml)}
        <span class="r-cp-fallback"><i class="fas ${String(fallbackIcon)}"></i><span>${(globalThis.PlatformLanguage?.text("customer-portal","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</span></span>
        <span class="r-cp-check"><i class="fas fa-check"></i></span>
      </div>
    `;
  }

  function mediaGridHtml(items, bucket){
    const selection = state.mediaSelection[bucket] || new Set();
    if (!items.length) return `<div class="r-cp-empty">${bucket === 'shared' ? 'No media shared yet.' : 'No unshared media.'}</div>`;
    return `<div class="r-cp-media-grid">${items.map((photo) => {
      const id = photoId(photo);
      const selected = selection.has(id);
      const label = photo.label || photo.alt || id || 'Project media';
      return `
        <button type="button" class="r-cp-media-tile${selected ? ' selected' : ''}" data-cp-select="${escapeHtml(id)}" data-cp-bucket="${escapeHtml(bucket)}" aria-pressed="${selected ? 'true' : 'false'}"${state.portal.loading ? ' disabled' : ''}>
          ${mediaThumbHtml(photo, label)}
          <span class="r-cp-media-name">${escapeHtml(label)}</span>
        </button>
      `;
    }).join('')}</div>`;
  }

  function retrySrc(src, tries){
    if (!src) return '';
    try {
      const url = new URL(src, window.location.href);
      url.searchParams.set('_cp_retry', `${Date.now()}_${tries}`);
      return url.href;
    } catch (_) {
      const separator = src.includes('?') ? '&' : '?';
      return `${src}${separator}_cp_retry=${Date.now()}_${tries}`;
    }
  }

  function bindThumbLoading(root = document){
    root.querySelectorAll?.('.r-cp-thumb img[data-cp-thumb-img]').forEach((img) => {
      const thumb = img.closest('.r-cp-thumb');
      if (!thumb) return;
      const baseSrc = img.dataset.cpBaseSrc || img.currentSrc || img.src || '';
      img.dataset.cpBaseSrc = baseSrc;
      const markLoaded = () => {
        thumb.classList.add('loaded');
        thumb.classList.remove('failed');
      };
      const markFailed = () => {
        thumb.classList.add('failed');
        thumb.classList.remove('loaded');
      };
      const bindVideo = (video) => {
        const markVideoLoaded = () => {
          thumb.classList.add('loaded');
          thumb.classList.remove('failed');
        };
        if (video.readyState >= 2) markVideoLoaded();
        else video.addEventListener('loadeddata', markVideoLoaded, { once: true });
        video.addEventListener('error', markFailed, { once: true });
      };
      const retry = () => {
        if (thumb.classList.contains('loaded')) return;
        const tries = Number(img.dataset.cpThumbRetries || 0);
        const originalSrc = img.dataset.cpOriginalSrc || '';
        if (tries >= 2 && img.dataset.cpMediaKind === 'video' && originalSrc) {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.dataset.cpThumbVideo = '1';
          video.src = originalSrc;
          img.replaceWith(video);
          bindVideo(video);
          return;
        }
        if (!baseSrc || tries >= 3) {
          markFailed();
          return;
        }
        img.dataset.cpThumbRetries = String(tries + 1);
        thumb.classList.remove('failed');
        img.src = retrySrc(baseSrc, tries + 1);
      };
      if (img.complete && img.naturalWidth > 0) markLoaded();
      else if (img.complete) window.setTimeout(retry, 250);
      else window.setTimeout(retry, 3200);
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', () => window.setTimeout(retry, 350));
    });
    root.querySelectorAll?.('.r-cp-thumb video[data-cp-thumb-video]').forEach((video) => {
      const thumb = video.closest('.r-cp-thumb');
      if (!thumb) return;
      const markLoaded = () => {
        thumb.classList.add('loaded');
        thumb.classList.remove('failed');
      };
      const markFailed = () => {
        thumb.classList.add('failed');
        thumb.classList.remove('loaded');
      };
      if (video.readyState >= 2) markLoaded();
      else video.addEventListener('loadeddata', markLoaded, { once: true });
      video.addEventListener('error', markFailed, { once: true });
    });
  }

  async function load(options = {}){
    if (!customerPortalEnabled()) return;
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !window.PlatformAPI?.customerPortals) return;
    setPortal({ ...state.portal, loading: true, error: '' });
    if (!options.silent) render();
    try {
      const [portalResult, activityResult] = await Promise.all([
        window.PlatformAPI.customerPortals.ensure(oid, pid, { contact_id: projectContact().id, customer: projectContact() }),
        window.PlatformAPI.customerPortals.activity(oid, pid).catch(() => ({ events: [] }))
      ]);
      setPortal({
        loading: false,
        portal: portalResult.portal || null,
        activity: Array.isArray(activityResult.events) ? activityResult.events : [],
        error: ''
      });
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || 'Could not load the customer portal.' });
    }
    render();
  }

  async function updateSharing(mediaIds, shared){
    const ids = (Array.isArray(mediaIds) ? mediaIds : [mediaIds]).map((id) => String(id || '').trim()).filter(Boolean);
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !ids.length || !window.PlatformAPI?.customerPortals) return;
    try {
      setPortal({ ...state.portal, loading: true });
      render();
      const result = shared
        ? await window.PlatformAPI.customerPortals.shareMedia(oid, pid, ids)
        : await window.PlatformAPI.customerPortals.unshareMedia(oid, pid, ids);
      setPortal({ ...state.portal, loading: false, portal: result.portal || state.portal.portal, error: '' });
      const sourceBucket = shared ? 'unshared' : 'shared';
      ids.forEach((id) => state.mediaSelection[sourceBucket]?.delete(id));
      showToast(shared ? 'Shared with portal' : 'Removed from portal', ((v0,v1) => globalThis.PlatformLanguage?.text("customer-portal","m_e95c22e05588b5",`${v0} item${v1} updated.`,{v0,v1}) ?? `${v0} item${v1} updated.`)(ids.length,ids.length === 1 ? '' : 's'), true);
      render();
      return true;
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || 'Could not update sharing.' });
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_0834090fafcc24","Portal update failed") ?? "Portal update failed"), state.portal.error, false);
      render();
      return false;
    }
  }

  async function updateAll(shared){
    const ids = photos().map((photo) => photoId(photo)).filter(Boolean);
    await updateSharing(ids, shared);
  }

  async function setCustomerSharingEnabled(enabled){
    const oid = orgId();
    const pid = projectId();
    const portal = state.portal.portal || {};
    if (!oid || !pid || !window.PlatformAPI?.customerPortals) return;
    try {
      setPortal({ ...state.portal, loading:true }); render();
      const result = await window.PlatformAPI.customerPortals.update(oid, pid, {
        settings: { ...(portal.settings || {}), sharing:{ ...((portal.settings || {}).sharing || {}), enabled:enabled === true } }
      });
      setPortal({ ...state.portal, loading:false, portal:result.portal || portal, error:'' });
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_419fcba6686d2f","Sharing updated") ?? "Sharing updated"), enabled ? 'The customer can now create secure guest links.' : 'The customer can no longer create new guest links.', true);
    } catch (error) {
      setPortal({ ...state.portal, loading:false, error:error?.message || 'Could not update portal sharing.' });
    }
    render();
  }

  async function setCustomerReschedulingEnabled(enabled){
    const oid = orgId();
    const pid = projectId();
    const portal = state.portal.portal || {};
    if (!oid || !pid || !window.PlatformAPI?.customerPortals) return;
    try {
      setPortal({ ...state.portal, loading:true }); render();
      const result = await window.PlatformAPI.customerPortals.update(oid, pid, {
        settings: { ...(portal.settings || {}), scheduling:{ ...((portal.settings || {}).scheduling || {}), enabled:enabled === true, reschedule:enabled === true } }
      });
      setPortal({ ...state.portal, loading:false, portal:result.portal || portal, error:'' });
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_03bc09a605e95b","Portal scheduling updated") ?? "Portal scheduling updated"), enabled ? 'Eligible appointments can now be rescheduled in the customer portal.' : 'Customer portal rescheduling is off for this project.', true);
    } catch (error) {
      setPortal({ ...state.portal, loading:false, error:error?.message || 'Could not update portal scheduling.' });
    }
    render();
  }

  async function revokeGuestShare(shareId){
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !shareId || !window.PlatformAPI?.customerPortals?.revokeShare) return;
    if (!window.confirm((globalThis.PlatformLanguage?.text("customer-portal","m_4673313e439d76","Revoke this shared portal link immediately?") ?? "Revoke this shared portal link immediately?"))) return;
    try {
      setPortal({ ...state.portal, loading:true }); render();
      await window.PlatformAPI.customerPortals.revokeShare(oid, pid, shareId);
      await load({ silent:true });
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_5b7392e0641e18","Access revoked") ?? "Access revoked"), (globalThis.PlatformLanguage?.text("customer-portal","m_5f69f2a41b214d","The shared link can no longer open the portal.") ?? "The shared link can no longer open the portal."), true);
    } catch (error) {
      setPortal({ ...state.portal, loading:false, error:error?.message || 'Could not revoke the shared link.' }); render();
    }
  }

  async function copyLink(url, label){
    try {
      await navigator.clipboard.writeText(url);
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_16841202d17c7c","Copied") ?? "Copied"), ((v0) => globalThis.PlatformLanguage?.text("customer-portal","m_43c7ce84738c11",`${v0} copied to clipboard.`,{v0}) ?? `${v0} copied to clipboard.`)(label), true);
    } catch (_) {
      showToast((globalThis.PlatformLanguage?.text("customer-portal","m_9c6d3ea981962c","Copy failed") ?? "Copy failed"), (globalThis.PlatformLanguage?.text("customer-portal","m_3dcfecb51d7499","Could not copy this portal link.") ?? "Could not copy this portal link."), false);
    }
  }

  function downloadQr(url){
    if (!url) return;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=640x640&data=${encodeURIComponent(url)}`;
    const link = document.createElement('a');
    link.href = qrUrl;
    link.download = 'customer-portal-qr.png';
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  }

  function eventDate(event = {}){
    const parsed = new Date(firstText(event.created_at, event.createdAt, event.timestamp));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatWhen(date, options = {}){
    if (!date) return '';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(options.includeYear ? { year: 'numeric' } : {})
    });
  }

  function eventType(event = {}){
    return firstText(event.type, event.event).replace(/^customer_portal\./, '');
  }

  function eventLabel(event = {}){
    const type = eventType(event);
    const labels = {
      viewed: 'Viewed portal',
      tab_opened: `Opened ${firstText(event.tab, event.metadata?.tab, 'tab')}`,
      media_opened: 'Opened media',
      media_downloaded: 'Downloaded media',
      proposal_opened: 'Opened proposal',
      proposal_downloaded: 'Downloaded proposal',
      proposal_printed: 'Printed proposal',
      workflow_step_opened: `Opened ${firstText(event.step, event.metadata?.step, 'workflow step')}`,
      project_opened: 'Switched project'
    };
    return labels[type] || type.replace(/_/g, ' ') || 'Portal event';
  }

  function eventDetail(event = {}){
    return firstText(
      event.media_id ? `Media ${event.media_id}` : '',
      event.proposal_id ? `Proposal ${event.proposal_id}` : '',
      event.project_switch_id ? `Project ${event.project_switch_id}` : '',
      event.tab,
      event.step,
      event.path
    );
  }

  function eventIp(event = {}){
    const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const request = metadata.request && typeof metadata.request === 'object' ? metadata.request : {};
    return firstText(event.visitor_ip, event.ip_address, event.client_ip, event.ip, request.client_ip, request.request_ip, request.remote_address, 'Unknown IP');
  }

  function eventSession(event = {}){
    return firstText(event.visitor_session_id, event.session_id, event.user_agent_hash, 'unknown-session');
  }

  function eventLocation(event = {}){
    return [event.city, event.region, event.country].map((part) => firstText(part)).filter(Boolean).join(', ');
  }

  function eventBrowser(event = {}){
    const ua = firstText(event.user_agent);
    if (!ua) return '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
    const platform = /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : '';
    return [browser, platform].filter(Boolean).join(' on ');
  }

  function activityGroups(events = []){
    const groups = new Map();
    events.forEach((event) => {
      const ip = eventIp(event);
      const key = ip;
      if (!groups.has(key)) {
        groups.set(key, {
          ip,
          location: eventLocation(event),
          browser: eventBrowser(event),
          first: null,
          last: null,
          sessions: new Set(),
          counts: {},
          events: [],
          media: new Set(),
          proposals: new Set(),
          tabs: new Set()
        });
      }
      const group = groups.get(key);
      const date = eventDate(event);
      const type = eventType(event) || 'event';
      group.events.push(event);
      group.sessions.add(eventSession(event));
      group.counts[type] = (group.counts[type] || 0) + 1;
      if (firstText(event.media_id)) group.media.add(firstText(event.media_id));
      if (firstText(event.proposal_id)) group.proposals.add(firstText(event.proposal_id));
      if (firstText(event.tab)) group.tabs.add(firstText(event.tab));
      if (eventLocation(event) && !group.location) group.location = eventLocation(event);
      if (eventBrowser(event) && !group.browser) group.browser = eventBrowser(event);
      if (date && (!group.first || date < group.first)) group.first = date;
      if (date && (!group.last || date > group.last)) group.last = date;
    });
    return [...groups.values()]
      .map((group) => ({
        ...group,
        events: group.events.sort((a, b) => (eventDate(b)?.getTime() || 0) - (eventDate(a)?.getTime() || 0))
      }))
      .sort((a, b) => (b.last?.getTime() || 0) - (a.last?.getTime() || 0));
  }

  function activityStatsHtml(events = [], groups = activityGroups(events)){
    const latest = events.map(eventDate).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const engaged = events.filter((event) => eventType(event) !== 'viewed').length;
    const mediaActions = events.filter((event) => eventType(event).startsWith('media_')).length;
    const proposalActions = events.filter((event) => eventType(event).startsWith('proposal_')).length;
    const cards = [
      ['Visitors', groups.length],
      ['Events', events.length],
      ['Engagements', engaged],
      ['Latest', latest ? formatWhen(latest) : 'None'],
      ['Media actions', mediaActions],
      ['Proposal actions', proposalActions]
    ];
    return `<div class="r-cp-activity-stats">${cards.map(([label, value]) => `
      <div class="r-cp-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
    `).join('')}</div>`;
  }

  function activityGroupHtml(group){
    const count = (type) => group.counts[type] || 0;
    const actionCounts = [
      ['Views', count('viewed')],
      ['Tabs', count('tab_opened')],
      ['Media', count('media_opened') + count('media_downloaded')],
      ['Proposals', count('proposal_opened') + count('proposal_downloaded') + count('proposal_printed')]
    ].filter(([, value]) => value > 0);
    const recent = group.events.slice(0, 5);
    const meta = [
      `${group.sessions.size} session${group.sessions.size === 1 ? '' : 's'}`,
      group.location,
      group.browser
    ].filter(Boolean).join(' - ');
    return `
      <article class="r-cp-visitor-card">
        <div class="r-cp-visitor-head">
          <div>
            <strong>${escapeHtml(group.ip)}</strong>
            <span>${escapeHtml(meta || 'Visitor')}</span>
          </div>
          <time>${escapeHtml(formatWhen(group.last) || 'No time')}</time>
        </div>
        <div class="r-cp-visitor-counts">
          ${actionCounts.length ? actionCounts.map(([label, value]) => `<span><b>${escapeHtml(value)}</b>${escapeHtml(label)}</span>`).join('') : `<span><b>0</b>${(globalThis.PlatformLanguage?.text("customer-portal","m_6067958dea3386","Actions") ?? "Actions")}</span>`}
        </div>
        <div class="r-cp-visitor-window">
          ${group.first && group.last ? `${escapeHtml(formatWhen(group.first))} - ${escapeHtml(formatWhen(group.last))}` : 'Timeline unavailable'}
        </div>
        <div class="r-cp-recent-events">
          ${recent.map((event) => {
            const detail = eventDetail(event);
            return `
              <div class="r-cp-recent-event">
                <span>${escapeHtml(eventLabel(event))}${detail ? ` <em>${escapeHtml(detail)}</em>` : ''}</span>
                <time>${escapeHtml(formatWhen(eventDate(event)))}</time>
              </div>
            `;
          }).join('')}
        </div>
      </article>
    `;
  }

  function activityHtml(events = []){
    if (!events.length) return `<div class="r-cp-empty">${(globalThis.PlatformLanguage?.text("customer-portal","m_397f550437b4ad","No customer portal activity yet.") ?? "No customer portal activity yet.")}</div>`;
    const groups = activityGroups(events);
    return `
      ${activityStatsHtml(events, groups)}
      <div class="r-cp-activity-grid">${groups.map(activityGroupHtml).join('')}</div>
    `;
  }

  function render(context = {}){
    const root = resolveRoot(context);
    if (!root || !customerPortalEnabled()) return;
    state.panelRoot = root;
    const portal = state.portal.portal || {};
    const liveUrl = String(portal.live_url || '').trim();
    const previewUrl = String(portal.preview_url || '').trim();
    const shared = sharedPortalMediaIds();
    cleanMediaSelection(shared);
    const projectPhotos = photos();
    const sharedPhotos = projectPhotos.filter((photo) => shared.has(photoId(photo)));
    const unsharedPhotos = projectPhotos.filter((photo) => !shared.has(photoId(photo)));
    const sharedSelected = state.mediaSelection.shared.size;
    const unsharedSelected = state.mediaSelection.unshared.size;
    const loadingAttr = state.portal.loading ? ' disabled' : '';
    const mediaEnabled = customerPortalMediaEnabled();
    const guestLinks = Array.isArray(portal.guest_links) ? portal.guest_links : [];
    const activeGuestLinks = guestLinks.filter((item) => String(item.status || '').toLowerCase() === 'active');
    const customerSharingEnabled = portal.settings?.sharing?.enabled === true;
    const customerReschedulingEnabled = portal.settings?.scheduling?.enabled === true && portal.settings?.scheduling?.reschedule === true;
    if (state.activeSubtab === 'media' && !mediaEnabled) state.activeSubtab = 'overview';
    const activeSubtab = state.activeSubtab === 'media' ? 'media' : 'overview';
    const overviewHtml = `
      <div class="r-cp-links">
        <div class="r-cp-link-card">
          <span>${(globalThis.PlatformLanguage?.text("customer-portal","m_8f8f3196e91e22","Live customer link") ?? "Live customer link")}</span>
          <input readonly value="${String(escapeHtml(liveUrl))}">
          <div class="r-cp-actions">
            <button type="button" data-cp-copy="live">${(globalThis.PlatformLanguage?.text("customer-portal","m_9302911bb13773","Copy") ?? "Copy")}</button>
            <a href="mailto:${String(escapeHtml(portal.customer?.email || ''))}?subject=${String(encodeURIComponent('Your project portal'))}&body=${String(encodeURIComponent(liveUrl))}">${(globalThis.PlatformLanguage?.text("customer-portal","m_5d2b9327181e33","Email") ?? "Email")}</a>
            <button type="button" data-cp-qr>${(globalThis.PlatformLanguage?.text("customer-portal","m_194f593f8d0a16","Download QR") ?? "Download QR")}</button>
          </div>
        </div>
        <div class="r-cp-link-card preview">
          <span>${(globalThis.PlatformLanguage?.text("customer-portal","m_4556b229717606","Preview link") ?? "Preview link")}</span>
          <input readonly value="${String(escapeHtml(previewUrl))}">
          <div class="r-cp-actions">
            <button type="button" data-cp-copy="preview">${(globalThis.PlatformLanguage?.text("customer-portal","m_9302911bb13773","Copy") ?? "Copy")}</button>
            <a href="${String(escapeHtml(previewUrl))}" target="_blank" rel="noopener">${(globalThis.PlatformLanguage?.text("customer-portal","m_f25442be2eb9d3","Open Preview") ?? "Open Preview")}</a>
          </div>
        </div>
      </div>
      <div class="r-cp-section-title"><strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_6904cbcb4bf953","Customer sharing") ?? "Customer sharing")}</strong><button type="button" data-cp-sharing-toggle="${String(customerSharingEnabled ? 'off' : 'on')}">${String(customerSharingEnabled ? 'Disable new links' : 'Enable secure sharing')}</button></div>
      <div class="r-cp-sharing-admin">
        <p>${String(customerSharingEnabled ? 'The customer can create revocable, read-only links with optional expiration. Guest links never include payments, signatures, approvals, or editing.' : 'Customer-created guest links are off for this project. Staff can still view and revoke existing links.')}</p>
        ${String(activeGuestLinks.length ? `<div class="r-cp-share-list">${activeGuestLinks.map((item) => `<div><span><strong>${escapeHtml(item.label || 'Shared access')}</strong><small>${escapeHtml(String(item.preset || '').replace(/_/g, ' '))} · ${item.expires_at ? `expires ${escapeHtml(formatWhen(new Date(item.expires_at), { includeYear:true }))}` : 'never expires'}</small></span><button type="button" data-cp-revoke-share="${escapeHtml(item.id)}">Revoke</button></div>`).join('')}</div>` : '<div class="r-cp-empty">No active guest links.</div>')}
      </div>
      <div class="r-cp-section-title"><strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_d3e2a22ddb5f09","Appointment self-service") ?? "Appointment self-service")}</strong><button type="button" data-cp-rescheduling-toggle="${String(customerReschedulingEnabled ? 'off' : 'on')}">${String(customerReschedulingEnabled ? 'Turn off' : 'Enable rescheduling')}</button></div>
      <div class="r-cp-sharing-admin"><p>${String(customerReschedulingEnabled ? 'When an upcoming appointment is also enabled by its scheduling policy, the customer can choose from live available times in this portal.' : 'Customers cannot reschedule from this project portal. Confirmation and staff-managed scheduling continue to work normally.')}</p></div>
      <div class="r-cp-section-title"><strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_736894e3c896cd","Portal History") ?? "Portal History")}</strong><button type="button" data-cp-refresh>${(globalThis.PlatformLanguage?.text("customer-portal","m_78973ce0cf3403","Refresh") ?? "Refresh")}</button></div>
      <div class="r-cp-events">${String(activityHtml(state.portal.activity))}</div>
    `;
    const mediaHtml = mediaEnabled ? `
      <div class="r-cp-section-title"><strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_2c7fddee1414af","Media Sharing") ?? "Media Sharing")}</strong><span>${((v0,v1) => globalThis.PlatformLanguage?.text("customer-portal","m_4dab4512a74cfd",`${v0} shared / ${v1} unshared`,{v0,v1}) ?? `${v0} shared / ${v1} unshared`)(sharedPhotos.length,unsharedPhotos.length)}</span></div>
      <div class="r-cp-media-board">
        <section class="r-cp-media-box">
          <div class="r-cp-media-box-head">
            <div class="r-cp-media-box-title">
              <strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_a7a7382d100092","Shared Media") ?? "Shared Media")}</strong>
              <span>${((v2,v3) => globalThis.PlatformLanguage?.text("customer-portal","m_5c8fe5927480d3",`${v2} selected of ${v3}`,{v2,v3}) ?? `${v2} selected of ${v3}`)(sharedSelected,sharedPhotos.length)}</span>
            </div>
            <div class="r-cp-media-box-actions">
              <button type="button" class="r-cp-bulk-btn" data-cp-select-all="shared"${String(loadingAttr || (!sharedPhotos.length ? ' disabled' : ''))}><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_65046f5dd815ba","Select all") ?? "Select all")}</button>
              <button type="button" class="r-cp-bulk-btn" data-cp-clear-selection="shared"${String(loadingAttr || (!sharedSelected ? ' disabled' : ''))}><i class="fas fa-times"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_506191e24dd383","Clear") ?? "Clear")}</button>
              <button type="button" class="r-cp-bulk-btn" data-cp-bulk="unshare"${String(loadingAttr || (!sharedSelected ? ' disabled' : ''))}><i class="fas fa-link-slash"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_48203573600b0c","Unshare selected") ?? "Unshare selected")}</button>
            </div>
          </div>
          ${String(mediaGridHtml(sharedPhotos, 'shared'))}
        </section>
        <section class="r-cp-media-box">
          <div class="r-cp-media-box-head">
            <div class="r-cp-media-box-title">
              <strong>${(globalThis.PlatformLanguage?.text("customer-portal","m_011f74477ef775","Unshared Media") ?? "Unshared Media")}</strong>
              <span>${((v8,v9) => globalThis.PlatformLanguage?.text("customer-portal","m_a40ec62159b706",`${v8} selected of ${v9}`,{v8,v9}) ?? `${v8} selected of ${v9}`)(unsharedSelected,unsharedPhotos.length)}</span>
            </div>
            <div class="r-cp-media-box-actions">
              <button type="button" class="r-cp-bulk-btn" data-cp-select-all="unshared"${String(loadingAttr || (!unsharedPhotos.length ? ' disabled' : ''))}><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_65046f5dd815ba","Select all") ?? "Select all")}</button>
              <button type="button" class="r-cp-bulk-btn" data-cp-clear-selection="unshared"${String(loadingAttr || (!unsharedSelected ? ' disabled' : ''))}><i class="fas fa-times"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_506191e24dd383","Clear") ?? "Clear")}</button>
              <button type="button" class="r-cp-bulk-btn primary" data-cp-bulk="share"${String(loadingAttr || (!unsharedSelected ? ' disabled' : ''))}><i class="fas fa-link"></i>${(globalThis.PlatformLanguage?.text("customer-portal","m_d7f1181b9fe7a7","Share selected") ?? "Share selected")}</button>
            </div>
          </div>
          ${String(mediaGridHtml(unsharedPhotos, 'unshared'))}
        </section>
      </div>
    ` : `<div class="r-cp-empty">${(globalThis.PlatformLanguage?.text("customer-portal","m_45f01ee4eaf862","Customer portal media sharing is disabled for this organization.") ?? "Customer portal media sharing is disabled for this organization.")}</div>`;
    root.innerHTML = `
      <div class="r-cp-wrap">
        <div class="r-cp-head">
          <div><h3>${(globalThis.PlatformLanguage?.text("customer-portal","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal")}</h3><p>${(globalThis.PlatformLanguage?.text("customer-portal","m_929b0824765a0f","Share only the project information and media this customer should be able to see.") ?? "Share only the project information and media this customer should be able to see.")}</p></div>
          ${String(state.portal.loading ? '<span class="r-cp-pill">Syncing...</span>' : '<span class="r-cp-pill">Ready</span>')}
        </div>
        ${String(state.portal.error ? `<div class="r-cp-error">${escapeHtml(state.portal.error)}</div>` : '')}
        <nav class="r-cp-subtabs" aria-label="${(globalThis.PlatformLanguage?.text("customer-portal","m_e6d980684bc615","Customer portal sections") ?? "Customer portal sections")}">
          <button type="button" class="${String(activeSubtab === 'overview' ? 'active' : '')}" data-cp-subtab="overview" aria-selected="${String(activeSubtab === 'overview' ? 'true' : 'false')}"><i class="fas fa-chart-line"></i><span>${String(escapeHtml(window.Portal?.terminology?.get?.('customer_portal.overview_view', 'Overview') || 'Overview'))}</span></button>
          <button type="button" class="${String(activeSubtab === 'media' ? 'active' : '')}" data-cp-subtab="media" aria-selected="${String(activeSubtab === 'media' ? 'true' : 'false')}"${String(mediaEnabled ? '' : ' disabled')}><i class="fas fa-images"></i><span>${String(escapeHtml(window.Portal?.terminology?.get?.('customer_portal.media_view', 'Media') || 'Media'))}</span></button>
        </nav>
        <section class="r-cp-tab-panel">
          ${String(activeSubtab === 'media' ? mediaHtml : overviewHtml)}
        </section>
      </div>
    `;
    root.querySelectorAll('[data-cp-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.cpSubtab === 'media' ? 'media' : 'overview';
        if (next === 'media' && !mediaEnabled) return;
        state.activeSubtab = next;
        window.Portal?.navigation?.push?.({ customerPortalView:next }, { source:'customer-portal-view', ownedKeys:['customerPortalView'] });
        render();
      });
    });
    root.querySelector('[data-cp-copy="live"]')?.addEventListener('click', () => copyLink(liveUrl, 'Live portal link'));
    root.querySelector('[data-cp-copy="preview"]')?.addEventListener('click', () => copyLink(previewUrl, 'Preview portal link'));
    root.querySelector('[data-cp-qr]')?.addEventListener('click', () => downloadQr(liveUrl));
    root.querySelector('[data-cp-refresh]')?.addEventListener('click', () => load({ silent: false }));
    root.querySelector('[data-cp-sharing-toggle]')?.addEventListener('click', (event) => setCustomerSharingEnabled(event.currentTarget.dataset.cpSharingToggle === 'on'));
    root.querySelector('[data-cp-rescheduling-toggle]')?.addEventListener('click', (event) => setCustomerReschedulingEnabled(event.currentTarget.dataset.cpReschedulingToggle === 'on'));
    root.querySelectorAll('[data-cp-revoke-share]').forEach((button) => button.addEventListener('click', () => revokeGuestShare(button.dataset.cpRevokeShare || '')));
    root.querySelector('[data-cp-share-all]')?.addEventListener('click', () => updateAll(true));
    root.querySelector('[data-cp-unshare-all]')?.addEventListener('click', () => updateAll(false));
    bindThumbLoading(root);
    root.querySelectorAll('[data-cp-select]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.cpSelect || '';
        const bucket = btn.dataset.cpBucket === 'shared' ? 'shared' : 'unshared';
        if (!id) return;
        const selection = state.mediaSelection[bucket] || new Set();
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        state.mediaSelection[bucket] = selection;
        render();
      });
    });
    root.querySelectorAll('[data-cp-select-all]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bucket = btn.dataset.cpSelectAll === 'shared' ? 'shared' : 'unshared';
        const sourcePhotos = bucket === 'shared' ? sharedPhotos : unsharedPhotos;
        state.mediaSelection[bucket] = new Set(sourcePhotos.map((photo) => photoId(photo)).filter(Boolean));
        render();
      });
    });
    root.querySelectorAll('[data-cp-clear-selection]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bucket = btn.dataset.cpClearSelection === 'shared' ? 'shared' : 'unshared';
        state.mediaSelection[bucket] = new Set();
        render();
      });
    });
    root.querySelectorAll('[data-cp-bulk]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const share = btn.dataset.cpBulk === 'share';
        const bucket = share ? 'unshared' : 'shared';
        updateSharing([...state.mediaSelection[bucket]], share);
      });
    });
  }

  function mount(context = {}){
    state.host = hostFor(context);
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.mounted = !!state.panelRoot;
    state.active = context.active !== false;
    const routedView = window.Portal?.navigation?.read?.().customerPortalView;
    if (['overview','media'].includes(routedView)) state.activeSubtab = routedView;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    render(context);
    return api;
  }

  function activate(context = {}){
    if (context.host || context.projectWorkspace) mount(context);
    state.active = true;
    render(context);
    if (!state.portal.portal && !state.portal.loading) load({ silent: true });
  }

  function reset(){
    setPortal({ loading: false, portal: null, activity: [], error: '' });
    state.mediaSelection = { shared: new Set(), unshared: new Set() };
  }

  const api = {
    mount,
    activate,
    render,
    load,
    updateSharing,
    reset,
    destroy: reset,
    unmount: reset,
    context: () => ({ mounted: state.mounted, active: state.active, portal: state.portal })
  };

  const definition = {
    id: 'project.customer_portal',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("customer-portal","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal"),
    label: (globalThis.PlatformLanguage?.text("customer-portal","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal"),
    icon: 'fa-link',
    order: 30,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    enabled: (context = {}) => context.customerPortalEnabled !== false && !!context.activeProject,
    panelHtml,
    mount
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.customerPortalProject = api;
  Portal.ProjectCustomerPortalApp = api;

  window.Portal?.navigation?.registerHandler?.('project-customer-portal-view', {
    priority:600,
    apply:(route) => {
      if (!route.project || route.projectTab !== 'customer_portal' || !state.mounted) return;
      const next = route.customerPortalView === 'media' ? 'media' : 'overview';
      if (next !== state.activeSubtab) { state.activeSubtab = next; render(); }
    }
  });

  runtime?.registerApp?.(definition);
})();
