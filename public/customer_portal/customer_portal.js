(function(){
  const root = window;
  const mount = document.getElementById('customerPortalApp');
  const cfg = root.__CUSTOMER_PORTAL || {};
  const api = root.PlatformAPI;
  let state = {
    payload: null,
    activeMediaIndex: -1,
    activeTab: 'summary',
    projectMenuOpen: false,
    schedulePastOpen: false,
    rescheduleModalOpen: false,
    rescheduleEventId: '',
    rescheduleSlots: [],
    rescheduleSelectedDate: '',
    rescheduleSelectedStartAt: '',
    rescheduleSelectedResource: '',
    rescheduleMonth: '',
    rescheduleBusy: false,
    rescheduleError: '',
    rescheduleCancelBusyId: '',
    activeProjectId: '',
    signatureName: '',
    activeDocumentToken: '',
    documentBusy: false,
    documentWorkflowViews: {},
    pendingDocumentTaskStep: '',
    pendingDocumentTaskFocus: '',
    shareModalOpen: false,
    shareFormOpen: true,
    shareBusy: false,
    shareCreatedUrl: '',
    shareCreatedId: ''
  };
  // Document-engine snapshot cache: public_token -> { snapshot, document, workflow }.
  const documentSnapshotCache = {};
  let activeDocumentStage = null;
  let activeInlineDocumentWorkflow = null;
  let projectMenuDismissBound = false;

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[char]));
  }
  function hexToRgb(hex){
    let value = cleanText(hex).toUpperCase();
    if (!value.startsWith('#')) value = `#${value}`;
    if (!/^#[0-9A-F]{6}$/.test(value)) return { r: 37, g: 99, b: 235 };
    return {
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16)
    };
  }
  function hexToRgbCsv(hex){
    const { r, g, b } = hexToRgb(hex);
    return `${r},${g},${b}`;
  }
  function relativeLuminance(r, g, b){
    const channels = [r / 255, g / 255, b / 255].map((value) => (
      value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
    ));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function contrastTextFor(hex){
    const { r, g, b } = hexToRgb(hex);
    return relativeLuminance(r, g, b) > 0.40 ? '#111111' : '#ffffff';
  }
  function brandColor(...values){
    for (const value of values) {
      let text = cleanText(value);
      if (!text) continue;
      if (!text.startsWith('#')) text = `#${text}`;
      if (/^#[0-9A-Fa-f]{6}$/.test(text)) return text.toUpperCase();
    }
    return '#2563EB';
  }
  function readableOnWhite(hex){
    const { r, g, b } = hexToRgb(hex);
    const contrast = (1.0 + 0.05) / (relativeLuminance(r, g, b) + 0.05);
    if (contrast >= 3.5) return cleanText(hex);
    let dr = r;
    let dg = g;
    let db = b;
    for (let i = 0; i < 20; i += 1) {
      dr = Math.max(0, Math.round(dr * 0.85));
      dg = Math.max(0, Math.round(dg * 0.85));
      db = Math.max(0, Math.round(db * 0.85));
      const nextContrast = (1.0 + 0.05) / (relativeLuminance(dr, dg, db) + 0.05);
      if (nextContrast >= 3.5) break;
    }
    const toHex = (value) => value.toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(dr)}${toHex(dg)}${toHex(db)}`;
  }
  function visitorSessionId(){
    const key = 'fm_customer_portal_session_id';
    let value = localStorage.getItem(key);
    if (!value) {
      value = `cps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(key, value);
    }
    return value;
  }
  async function track(type, extra = {}){
    if (cfg.preview || !api?.customerPortals?.publicTrack || !cfg.id) return;
    try {
      await api.customerPortals.publicTrack(cfg.id, {
        type,
        path: location.pathname + location.search,
        href: location.href,
        visitor_session_id: visitorSessionId(),
        ...extra
      });
    } catch (error) {
      console.warn('Customer portal tracking unavailable.', error);
    }
  }
  function isPreviewMode(){
    return cfg.preview === true || cfg.preview === 'true';
  }
  function showPortalToast(message){
    const text = cleanText(message);
    if (!text) return;
    let toast = document.querySelector('[data-cp-toast]');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'cp-toast';
      toast.setAttribute('data-cp-toast', 'true');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showPortalToast.timer);
    showPortalToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }
  function blockPreviewAction(kind = 'signing'){
    if (!isPreviewMode()) return false;
    showPortalToast(kind === 'payment' ? 'This is a preview. Nothing can be paid here.' : 'This is a preview. Nothing can be signed or accepted here.');
    return true;
  }
  function applyBranding(payload){
    const branding = payload?.organization?.branding || {};
    const colors = branding.colors || {};
    const primary = brandColor(colors.primary, branding.primary, colors.brand, branding.brand, colors.accent, branding.accent);
    const secondary = brandColor(colors.secondary, branding.secondary, '#111111');
    const accent = brandColor(colors.accent, branding.accent, primary);
    document.documentElement.style.setProperty('--cp-primary', primary);
    document.documentElement.style.setProperty('--cp-primary-rgb', hexToRgbCsv(primary));
    document.documentElement.style.setProperty('--cp-primary-readable', readableOnWhite(primary));
    document.documentElement.style.setProperty('--cp-on-primary', contrastTextFor(primary));
    document.documentElement.style.setProperty('--cp-secondary', secondary);
    document.documentElement.style.setProperty('--cp-accent', accent);
  }
  function assetUrl(value){
    const raw = cleanText(value);
    if (!raw || /^data:/i.test(raw)) return raw;
    try {
      const apiBase = cleanText(root.__APP?.platformApiBase || '');
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw);
        if (parsed.pathname.startsWith('/v1/platform/') && apiBase) {
          const origin = new URL(apiBase, location.href).origin;
          return origin + parsed.pathname + parsed.search + parsed.hash;
        }
        return raw;
      }
      if (raw.startsWith('/v1/') && apiBase) {
        const origin = new URL(apiBase, location.href).origin;
        return origin + raw;
      }
      const platformPath = raw.replace(/^\/+/, '');
      if (platformPath.startsWith('organizations/')) {
        return new URL(`/storage/measure/internal/${platformPath}`, location.href).href;
      }
      return new URL(raw, location.href).href;
    } catch (_) {
      return raw;
    }
  }
  function logoValueUrl(value){
    if (value && typeof value === 'object') {
      return logoValueUrl(value.logo || value.logo_node_url || value.logoNodeUrl || value.logo_url || value.logoUrl || value.url || value.src);
    }
    const raw = cleanText(value);
    if (!raw || raw === '[object Object]') return '';
    return assetUrl(raw.replace(/\/file(\?|$)/, '/logo$1'));
  }
  function logoMediaId(value){
    if (value && typeof value === 'object') return cleanText(value.media_id || value.mediaId || value.id || value._id);
    return cleanText(value);
  }
  function brandingLogoUrl(org = {}){
    const branding = org.branding || {};
    const direct = [
      branding.logo,
      branding.logo_node_url,
      branding.logoNodeUrl,
      branding.logo_url,
      branding.logoUrl,
      branding.companyLogo,
      branding.brandLogo
    ];
    for (const value of direct) {
      const logo = logoValueUrl(value);
      if (logo) return logo;
    }
    const orgId = cleanText(org.id || branding.org_id || branding.organization_id);
    if (!orgId) return '';
    const mediaId = [
      branding.logo_media_id,
      branding.logoMediaId,
      branding.logo_media,
      branding.logoMedia
    ].map(logoMediaId).find(Boolean);
    return mediaId ? assetUrl(`/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/logo`) : '';
  }
  function formatPhone(value){
    const raw = cleanText(value);
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    return raw;
  }
  function normalizeDate(value){
    const raw = cleanText(value);
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function normalizeDateTime(value){
    const raw = cleanText(value);
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function moneyFormat(value){
    return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }
  function nl2br(value){
    return escapeHtml(value).replace(/\n/g, '<br>');
  }
  function resources(payload){
    return payload?.resources && typeof payload.resources === 'object' ? payload.resources : {};
  }
  function projectBundles(payload = state.payload || {}){
    const contactProjects = payload?.contact_portal?.projects;
    const projects = Array.isArray(contactProjects) ? contactProjects : (Array.isArray(payload.projects) ? payload.projects : []);
    const normalized = projects
      .filter((item) => item && typeof item === 'object' && item.project && typeof item.project === 'object')
      .filter((item) => cleanText(item.project.id));
    if (normalized.length) return normalized;
    if (payload?.project && typeof payload.project === 'object') {
      return [{
        portal: payload.portal || {},
        project: payload.project,
        media: Array.isArray(payload.media) ? payload.media : [],
        resources: resources(payload),
        settings: payload.settings || {},
        tabs: Array.isArray(payload.tabs) ? payload.tabs : undefined,
        portal_pages: payload.portal_pages,
        feedback: payload.feedback,
        sharing: payload.sharing,
        customer_uploads: Array.isArray(payload.customer_uploads) ? payload.customer_uploads : [],
        media_comments: Array.isArray(payload.media_comments) ? payload.media_comments : []
      }];
    }
    return [];
  }
  function activeProjectPayload(){
    const payload = state.payload || {};
    const bundles = projectBundles(payload);
    if (!bundles.length) return payload;
    const requested = cleanText(state.activeProjectId || payload?.contact_portal?.active_project_id || payload?.portal?.active_project_id || payload?.project?.id);
    const active = bundles.find((bundle) => cleanText(bundle.project?.id) === requested) || bundles[0];
    state.activeProjectId = cleanText(active.project?.id);
    return {
      ...payload,
      active_project_portal: active.portal || {},
      project: active.project || payload.project || {},
      media: Array.isArray(active.media) ? active.media : [],
      resources: active.resources && typeof active.resources === 'object' ? active.resources : {},
      settings: active.settings && typeof active.settings === 'object' ? active.settings : (payload.settings || {}),
      tabs: Array.isArray(active.tabs) && active.tabs.length ? active.tabs : payload.tabs,
      portal_pages: active.portal_pages && typeof active.portal_pages === 'object' ? active.portal_pages : payload.portal_pages,
      feedback: active.feedback !== undefined ? active.feedback : payload.feedback,
      sharing: active.sharing && typeof active.sharing === 'object' ? active.sharing : payload.sharing,
      customer_uploads: Array.isArray(active.customer_uploads) ? active.customer_uploads : (Array.isArray(payload.customer_uploads) ? payload.customer_uploads : []),
      media_comments: Array.isArray(active.media_comments) ? active.media_comments : (Array.isArray(payload.media_comments) ? payload.media_comments : [])
    };
  }
  function feedbackCard(payload = {}){
    const feedback = payload.feedback && typeof payload.feedback === 'object' ? payload.feedback : null;
    if (!feedback || !cleanText(feedback.url)) return '';
    if (feedback.rated) {
      return `
        <section class="cp-feedback-card rated">
          <div class="cp-feedback-copy">
            <strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_b59a8704909b48","Thanks for your feedback!") ?? "Thanks for your feedback!")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_d96baabfa23bb5","We appreciate you taking the time to share how we did.") ?? "We appreciate you taking the time to share how we did.")}</span>
          </div>
        </section>
      `;
    }
    return `
      <section class="cp-feedback-card">
        <div class="cp-feedback-stars" aria-hidden="true">★★★★★</div>
        <div class="cp-feedback-copy">
          <strong>${escapeHtml(cleanText(feedback.title) || 'How did we do?')}</strong>
          <span>${escapeHtml(cleanText(feedback.body) || 'Tell us how everything went — it only takes a few seconds.')}</span>
        </div>
        <a class="cp-feedback-btn" href="${escapeHtml(feedback.url)}" target="_blank" rel="noopener" data-feedback-open>${escapeHtml(cleanText(feedback.cta) || 'Leave feedback')}</a>
      </section>
    `;
  }
  // The customer's own name is the friendliest label for a single-project
  // portal, but it distinguishes nothing when one contact has several projects
  // — which is exactly the multi-project case. Fall back to what actually
  // differs when the name is shared across bundles.
  function projectTabLabel(bundle = {}, index = 0, siblings = null){
    const project = bundle.project || {};
    const customer = projectCustomer(bundle);
    const bundles = Array.isArray(siblings) ? siblings : [];
    const nameIsShared = bundles.length > 1 && bundles.filter((entry) => (
      cleanText(projectCustomer(entry).name).toLowerCase() === cleanText(customer.name).toLowerCase()
    )).length > 1;
    const preferred = nameIsShared
      ? [project.project_title, project.address, project.title, project.display_name, project.name, customer.name]
      : [customer.name, project.project_title, project.address, project.title, project.display_name, project.name];
    return firstDisplayName(...preferred, `Project ${index + 1}`);
  }
  /**
   * Project identity + switcher, in the header's top right.
   *
   * Everything below the header is scoped to one project, so the header is
   * where "which project am I looking at" belongs. With a single project this
   * is static text — a dropdown that can only pick one thing is noise.
   */
  function projectSwitcherHtml(payload){
    const bundles = projectBundles(payload);
    if (!bundles.length) return '';
    const activeIndex = Math.max(0, bundles.findIndex((bundle) => cleanText(bundle.project?.id) === state.activeProjectId));
    const active = bundles[activeIndex] || bundles[0];
    const label = projectTabLabel(active, activeIndex, bundles);
    const address = cleanText(active.project?.address);
    if (bundles.length === 1) {
      return `
        <div class="cp-project-id">
          <span class="cp-project-eyebrow">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_aaebd7ccba0b30","Project") ?? "Project")}</span>
          <strong>${escapeHtml(label)}</strong>
          ${address ? `<span class="cp-project-address">${escapeHtml(address)}</span>` : ''}
        </div>
      `;
    }
    return `
      <div class="cp-project-switch" data-project-switch>
        <button type="button" class="cp-project-switch-btn" data-project-switch-toggle aria-haspopup="listbox" aria-expanded="${state.projectMenuOpen ? 'true' : 'false'}">
          <span class="cp-project-id">
            <span class="cp-project-eyebrow">${((v1,v2) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_9dabc5bf3cc45f",`Project ${v1} of ${v2}`,{v1,v2}) ?? `Project ${v1} of ${v2}`)(activeIndex + 1,bundles.length)}</span>
            <strong>${escapeHtml(label)}</strong>
            ${address ? `<span class="cp-project-address">${escapeHtml(address)}</span>` : ''}
          </span>
          <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
        </button>
        ${state.projectMenuOpen ? `
          <ul class="cp-project-menu" role="listbox">
            ${bundles.map((bundle, index) => {
              const projectId = cleanText(bundle.project?.id);
              const isActive = projectId === state.activeProjectId;
              return `
                <li role="option" aria-selected="${isActive ? 'true' : 'false'}">
                  <button type="button" class="${isActive ? 'active' : ''}" data-project-tab="${escapeHtml(projectId)}">
                    <strong>${escapeHtml(projectTabLabel(bundle, index, bundles))}</strong>
                    ${cleanText(bundle.project?.address) ? `<span>${escapeHtml(cleanText(bundle.project?.address))}</span>` : ''}
                    ${isActive ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}
                  </button>
                </li>
              `;
            }).join('')}
          </ul>
        ` : ''}
      </div>
    `;
  }
  function documentList(payload, groupId){
    const docs = Array.isArray(resources(payload).documents) ? resources(payload).documents : [];
    const group = cleanText(groupId);
    if (!group) return docs;
    return docs.filter((doc) => cleanText(doc?.presentation?.tab?.id) === group);
  }
  function documentTypeLabel(type){
    const labels = {
      proposal: 'Proposal',
      invoice: 'Invoice',
      change_order: 'Change Order',
      contract: 'Contract',
      work_order: 'Work Order',
      completion_certificate: 'Completion Certificate',
      generic: 'Document'
    };
    return labels[cleanText(type)] || 'Document';
  }
  function documentStatusLabel(status){
    const labels = {
      sent: 'Awaiting review',
      viewed: 'In review',
      in_progress: 'In progress',
      signed: 'Signed',
      completed: 'Completed',
      declined: 'Declined',
      expired: 'Expired',
      canceled: 'Canceled'
    };
    return labels[cleanText(status)] || cleanText(status) || 'Sent';
  }
  function activePortalDocument(){
    const descriptor = tabs().find((tab) => tab.id === state.activeTab) || {};
    const docs = documentList(activeProjectPayload(), descriptor.groupId);
    if (!docs.length) return null;
    const linked = cleanText(state.requestedDocumentId);
    const requested = cleanText(state.activeDocumentToken) || cleanText((docs.find((doc) => cleanText(doc.id) === linked) || {}).public_token);
    // Canceled work has no token — it renders as an inert card, never the
    // active document.
    return docs.find((doc) => cleanText(doc.public_token) && cleanText(doc.public_token) === requested)
      || docs.find((doc) => cleanText(doc.public_token))
      || docs[0];
  }
  // ── Signing from the portal ─────────────────────────────────────────────
  // An agreement is signed with the signer's own credential, never the
  // shared read-only link. The emailed link brings one in its fragment
  // (#sign=...); a customer who opens their portal directly gets one from the
  // server for the agreement's single outside signer.
  const documentSigningTokens = {}; // document id -> signing credential
  (function readSigningLink(){
    try {
      const fragment = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const credential = cleanText(fragment.get('sign'));
      const documentId = cleanText(new URLSearchParams(location.search).get('document'));
      if (documentId) state.requestedDocumentId = documentId;
      if (!credential) return;
      if (documentId) documentSigningTokens[documentId] = credential;
      // The credential does not stay in the address bar or the history.
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}
  })();
  function documentApiBase(){
    const configured = cleanText(root.DocumentsAPI?.baseUrl?.());
    if (configured) return configured.replace(/\/+$/, '');
    return `${location.origin}/v1/documents`;
  }
  async function documentSigningAccess(token){
    // A preview never signs, even holding a signing link (the server refuses it too).
    if (isPreviewMode()) throw new Error('This is a preview of what your customer sees. Nothing can be signed here.');
    const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === cleanText(token)) || {};
    const documentId = cleanText(doc.id);
    if (!documentId) throw new Error('This agreement is not available to sign here.');
    if (!documentSigningTokens[documentId]) {
      const platformBase = documentApiBase().replace(/\/documents$/, '/platform');
      let response;
      try {
        response = await fetch(`${platformBase}/customer-portals/${encodeURIComponent(activePortalUuid())}/documents/${encodeURIComponent(documentId)}/signing-access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch (_) { throw new Error('We could not reach the server. Check your connection and try again.'); }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !cleanText(result.token)) throw new Error(cleanText(result.message) || 'This agreement cannot be signed here right now.');
      documentSigningTokens[documentId] = cleanText(result.token);
    }
    const credential = documentSigningTokens[documentId];
    return { token: credential, base: `${documentApiBase()}/public/${encodeURIComponent(credential)}` };
  }
  /** "It's all done": what the customer did, what happens next, and their copy. */
  function showDocumentCompleteModal(token, payload){
    const snapshot = cpwfObject(cpwfObject(payload).snapshot);
    const outputs = cpwfObject(snapshot.outputs);
    const defs = cpwfObject(snapshot.output_defs);
    const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === cleanText(token)) || {};
    const done = [];
    Object.entries(defs).forEach(([key, def]) => {
      const value = cpwfObject(outputs[key]);
      const type = cleanText(cpwfObject(def).type);
      const when = cleanText(value.signed_at || value.recorded_at || value.paid_at);
      const date = when ? new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      if (type === 'signature' && (value.signer_name || value.text)) done.push(`Signed by ${cleanText(value.signer_name || value.text)}${date ? ` on ${date}` : ''}`);
      if (type === 'payment' && (value.payment_method || value.method || value.payment_id)) done.push(`${Number(value.amount_cents) > 0 ? `Paid ${moneyFormat(Number(value.amount_cents) / 100)}` : 'Payment made'}${date ? ` on ${date}` : ''}`);
    });
    const message = cleanText(cpwfObject(cpwfObject(payload).workflow).completion_message) || 'We will reach out with next steps.';
    const pdfUrl = root.DocumentsAPI?.public?.pdfUrl ? root.DocumentsAPI.public.pdfUrl(token) : '';
    // The payment window, if this was the payment, gives way to the result.
    try { root.FirstMatePaymentIntake?.close?.(); } catch (_) {}
    document.querySelector('.cp-complete-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'cp-complete-overlay';
    overlay.innerHTML = `<div class="cp-complete-modal" role="dialog" aria-modal="true" aria-labelledby="cpCompleteTitle">
        <div class="cp-complete-mark" aria-hidden="true">\u2713</div>
        <h2 id="cpCompleteTitle">${escapeHtml(cleanText(doc.title) || 'Your agreement')} is complete</h2>
        ${done.length ? `<ul>${done.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
        <p>${escapeHtml(message)}</p>
        <div class="cp-complete-actions">
          ${pdfUrl ? `<a class="cp-complete-download" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-download" aria-hidden="true"></i> Download your copy</a>` : ''}
          <button type="button" class="cp-complete-close">Done</button>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.querySelector('.cp-complete-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(event){ if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    document.body.appendChild(overlay);
    try { overlay.querySelector('.cp-complete-close').focus(); } catch (_) {}
  }
  const warmedSigning = new Set();
  function warmDocumentSigning(token){
    const key = cleanText(token);
    const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === key) || {};
    const field = cleanText(cpwfArray(cpwfObject(doc.signature_requirement).pending_keys)[0]);
    if (!field || warmedSigning.has(key) || isPreviewMode()) return;
    warmedSigning.add(key);
    documentSigningAccess(key)
      .then((access) => fetch(`${access.base}/signing/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field }) }))
      .catch(() => warmedSigning.delete(key));
  }
  function documentEngineReady(){
    return Boolean(root.DocumentsAPI && root.FMDocModel && root.FMDocRenderer);
  }
  const viewedDocumentTokens = new Set();
  function markDocumentViewed(token){
    const key = cleanText(token);
    if (!key || !root.DocumentsAPI || viewedDocumentTokens.has(key) || isPreviewMode()) return;
    viewedDocumentTokens.add(key);
    root.DocumentsAPI.public.view(key, withEvidence({}, browserEvidenceBase())).catch(() => {});
    track('document_viewed', { document_token: key });
  }
  async function ensureDocumentSnapshot(token, options = {}){
    const key = cleanText(token);
    if (!key || !root.DocumentsAPI) return null;
    if (documentSnapshotCache[key]) {
      if (!options.silent && !documentSnapshotCache[key].error) markDocumentViewed(key);
      return documentSnapshotCache[key];
    }
    try {
      const payload = await root.DocumentsAPI.public.get(key);
      documentSnapshotCache[key] = payload || null;
      if (!options.silent) markDocumentViewed(key);
    } catch (error) {
      documentSnapshotCache[key] = { error: cleanText(error?.message) || 'We could not load this document. Check your connection and try again.' };
    }
    return documentSnapshotCache[key];
  }
  async function submitDocumentOutput(token, key, value, options = {}){
    if (blockPreviewAction('document actions')) return false;
    // A second answer while one is saving waits its turn instead of vanishing.
    while (state.documentBusy) await new Promise((resolve) => setTimeout(resolve, 60));
    state.documentBusy = true;
    const tokenKey = cleanText(token);
    const outputKey = cleanText(key);
    const cached = cpwfObject(documentSnapshotCache[tokenKey]);
    const snapshot = cpwfObject(cached.snapshot);
    const isSignature = !!value?.__signing;
    // A payment is never shown as made before the processor took it: only
    // choices update optimistically.
    const isPayment = cleanText(cpwfObject(cpwfObject(snapshot.output_defs)[outputKey]).type) === 'payment';
    const optimistic = !isSignature && !isPayment;
    if (optimistic && Object.keys(snapshot).length) snapshot.outputs = { ...cpwfObject(snapshot.outputs), [outputKey]: value };
    const workflowRecord = documentWorkflowCache[tokenKey];
    if (optimistic && workflowRecord && workflowRecord !== 'pending') workflowRecord.outputs = { ...cpwfObject(workflowRecord.outputs), [outputKey]: value };
    updateDocumentTaskPanel(tokenKey);
    try {
      // Only a signature records where it was made; a choice or a payment
      // never waits on, or prompts for, the device's location.
      const evidence = isSignature ? await signatureEvidencePayload() : browserEvidenceBase();
      const writeToken = isSignature ? (await documentSigningAccess(tokenKey)).token : token;
      await root.DocumentsAPI.public.recordOutput(writeToken, key, withEvidence({ value }, evidence));
      // Choice widgets and inline workflows already update themselves
      // optimistically. Refresh the frozen document in the background without
      // blocking the choice. When the server-resolved preview arrives, swap it
      // in while retaining the page currently under the sticky toolbar.
      // Signing and paying are confirmed by the server's copy; wait for it, so
      // the to-do list and the Pay box show them straight away.
      const isRecordedPayment = isPayment;
      const fresh = root.DocumentsAPI.public.get(tokenKey).then((payload) => {
        if (payload) {
          documentSnapshotCache[tokenKey] = payload;
          refreshVisibleDocumentSnapshot(tokenKey, payload);
          updateDocumentTaskPanel(tokenKey);
        }
      }).catch(() => {});
      const wasComplete = cpwfObject(cached.workflow).customer_complete === true;
      if (isSignature || isRecordedPayment) {
        await fresh;
        const now = cpwfObject(documentSnapshotCache[tokenKey]);
        if (!wasComplete && cpwfObject(now.workflow).customer_complete === true) showDocumentCompleteModal(tokenKey, now);
      }
      const defType = cleanText(((snapshot.output_defs || {})[outputKey] || {}).type);
      if (defType === 'signature' || defType === 'payment') await refreshPortalPayload();
      track('document_output_recorded', { document_token: cleanText(token), output_key: cleanText(key) });
      return true;
    } catch (error) {
      // A signature's own dialog and the payment form show their failures
      // where the person is looking; anything else gets the page's notice.
      if (options.rethrow === true || isSignature) throw error;
      showPortalToast(cleanText(error?.message) || 'We could not save that just now. Please try again.');
      return false;
    } finally {
      state.documentBusy = false;
      updateDocumentTaskPanel(tokenKey);
    }
  }
  // ── Document payment intake config (provider tokenization, spec: intake
  // slice). Cached per document token; best-effort — any failure (or no
  // configured provider) resolves null and the checkout keeps the legacy
  // mock-record flow byte-identical.
  const documentIntakeConfigCache = {}; // token -> config | null
  async function documentPaymentIntakeConfig(token){
    const key = cleanText(token);
    if (!key || isPreviewMode() || !root.DocumentsAPI?.public?.paymentIntakeConfig) return null;
    if (documentIntakeConfigCache[key] !== undefined) return documentIntakeConfigCache[key];
    try {
      const result = await root.DocumentsAPI.public.paymentIntakeConfig(key);
      documentIntakeConfigCache[key] = result && typeof result.ready === 'boolean' ? result : null;
    } catch (_) {
      // Not knowing is not the same as "no processor": never remember a
      // failure, or a blip would swap the real checkout for the stand-in form.
      return undefined;
    }
    return documentIntakeConfigCache[key];
  }
  function documentProviderIntakeOptions(config, token, outputKey){
    // Not set up: the form says so and offers no card or bank entry.
    if (!config || config.ready !== true || !config.provider) {
      return {
        notReadyMessage: cleanText(config?.message) || 'Online payment is not available for this document yet. Contact the company to pay.',
        refundPolicy: cleanText(config?.refund_policy)
      };
    }
    const tokenKey = cleanText(token);
    const rails = cpwfObject(config.rails);
    // No surcharge options here on purpose: the document's authoritative
    // pricing already carries its own processing-fee rows and the server
    // charges with apply_surcharge:false.
    return {
      savedMethods: Array.isArray(config.saved_methods) ? config.saved_methods : [],
      allowSavedMethods: true,
      refundPolicy: cleanText(config.refund_policy),
      methods: [rails.card !== false ? 'card' : '', rails.bank !== false ? 'ach' : ''].filter(Boolean),
      tokenization: {
        mode: cleanText(config.tokenization?.mode) || 'mock',
        sdkUrl: cleanText(config.tokenization?.sdk_url),
        publicKey: cleanText(config.tokenization?.public_key),
        // The server prices the payment from the document, never the browser.
        prepare: async ({ method }) => (await root.DocumentsAPI.public.paymentCheckout(tokenKey, { output_key: outputKey, method }))?.checkout,
        createPaymentMethod: (request) => root.DocumentsAPI.public.createPaymentMethodIntent(tokenKey, request)
      }
    };
  }
  // The organization can take online payments right now (server answer).
  function onlinePaymentsAvailable(){
    return activeProjectPayload()?.online_payments !== false;
  }
  async function openDocumentPayment(token, options = {}){
    if (blockPreviewAction('payment')) return false;
    if (!root.FirstMatePaymentIntake?.open) {
      showPortalToast('The payment form is unavailable right now.');
      return false;
    }
    const tokenKey = cleanText(token);
    // The payment is recorded on the output the document declares. A Pay
    // button that names none, or one the document does not have, uses the
    // document's own payment output instead of failing after checkout.
    const declared = cpwfObject(cpwfObject(cpwfObject(documentSnapshotCache[tokenKey]).snapshot).output_defs);
    const paymentKeys = Object.keys(declared).filter((key) => cleanText(cpwfObject(declared[key]).type) === 'payment');
    const askedKey = cleanText(options.outputKey || options.output_key);
    const outputKey = (askedKey && (!paymentKeys.length || paymentKeys.includes(askedKey)) ? askedKey : '') || paymentKeys[0] || askedKey || 'payment';
    const amountCents = Math.max(0, Math.round(Number(options.amountCents ?? options.amount_cents) || 0));
    const document = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === tokenKey) || {};
    const customer = projectCustomer(activeProjectPayload());
    const branding = cpwfObject(activeProjectPayload()?.organization?.branding);
    const colors = cpwfObject(branding.colors);
    const primaryColor = brandColor(colors.primary, branding.primary, colors.brand, branding.brand, colors.accent, branding.accent);
    const secondaryColor = brandColor(colors.secondary, branding.secondary, '#111111');
    // The form opens now; the provider setup it needs arrives into it.
    root.FirstMatePaymentIntake.open({
      pending: documentPaymentIntakeConfig(tokenKey).then((intakeConfig) => {
        if (intakeConfig === undefined) {
          root.FirstMatePaymentIntake.close();
          showPortalToast('We could not load the payment form. Check your connection and try again.');
          return {};
        }
        return documentProviderIntakeOptions(intakeConfig, tokenKey, outputKey);
      }),
      title: cleanText(options.title) || 'Make a payment',
      description: cleanText(options.description) || cleanText(document.title) || 'Project payment',
      amountLabel: 'Amount due',
      amountCents,
      allowCustomAmount: false,
      methods: ['card', 'ach'],
      contact: customer || null,
      allowSavedMethods: true,
      allowSavePaymentMethod: true,
      primaryColor,
      secondaryColor,
      details: [{ label: (globalThis.PlatformLanguage?.text("customer-portal","m_d7c7704979ef7e","For") ?? "For"), value: cleanText(document.title) || 'Project document' }],
      submitLabel: 'Pay',
      successTitle: 'Payment complete',
      successDescription: `${moneyFormat(amountCents / 100)} was paid. Thank you.`,
      onSubmit: async (submitted) => {
        // Tokenized submissions (provider configured) carry the payment
        // method token; the server charges through the processor before the
        // output records. Without a token the envelope is byte-identical to
        // the legacy flow.
        const tokenized = !!(cleanText(submitted?.payment_method_id) || cleanText(submitted?.saved_method_id));
        const value = {
          intent: 'paid',
          amount_cents: Number(submitted?.amountCents) || amountCents,
          method: cleanText(submitted?.method),
          payment_method: cleanText(submitted?.method),
          saved_payment_method_id: cleanText(submitted?.savedPaymentMethodId),
          ...(tokenized ? {
            ...(cleanText(submitted?.payment_method_id) ? { payment_method_id: cleanText(submitted.payment_method_id) } : {}),
            ...(cleanText(submitted?.saved_method_id) ? { saved_method_id: cleanText(submitted.saved_method_id) } : {}),
            ...(cleanText(submitted?.checkout_id) ? { checkout_id: cleanText(submitted.checkout_id) } : {}),
            save_payment_method: submitted?.save_method === true
          } : {})
        };
        if (!tokenized) throw new Error('Enter your payment details to pay.');
        const saved = await submitDocumentOutput(tokenKey, outputKey, value, { rethrow: tokenized });
        if (!saved) throw new Error('Payment could not be completed.');
        // A saved card may have been added — refetch the config next open.
        if (tokenized) delete documentIntakeConfigCache[tokenKey];
        const record = documentWorkflowCache[tokenKey];
        if (record && record !== 'pending') {
          activeInlineDocumentWorkflow?.refresh?.({
            params: cpwfObject(record.params),
            outputs: cpwfObject(record.outputs),
            completed_steps: cpwfArray(cpwfObject(record.state).completed_steps),
            current_step: cleanText(cpwfObject(record.state).current_step)
          });
        }
        return { ok: true, amountCents: value.amount_cents };
      }
    });
    return true;
  }
  // ── Document workflow (doc-workflow runtime, contracts §8) ──────────────
  // When a shared document carries a customer-audience workflow with steps
  // still to answer (options / signature / payment), the viewer offers a
  // "Review & choose options" takeover that mounts FMDocWorkflow full-screen
  // with the live document preview. Customers write OUTPUTS only — every
  // write goes through the public recordOutput endpoint with evidence.
  const documentWorkflowCache = {}; // token -> 'pending' | null | { definition, state, params, outputs }
  let documentWorkflowOverlay = null;
  let documentWorkflowWriteChain = Promise.resolve();
  function cpwfObject(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function cpwfArray(value){ return Array.isArray(value) ? value : []; }
  function documentWorkflowReady(){
    return Boolean(root.FMDocWorkflow?.mount && root.DocumentsAPI?.public?.workflow);
  }
  function activeDocumentGroupTab(){
    return tabs().some((tab) => tab.id === state.activeTab && tab.sourceType === 'document_group');
  }
  function normalizePublicWorkflow(res){
    const source = cpwfObject(res);
    let definition = null;
    for (const candidate of [source.workflow, source.definition, source]) {
      const value = cpwfObject(candidate);
      if (cpwfArray(value.steps).length) { definition = value; break; }
      if (cpwfArray(cpwfObject(value.definition).steps).length) { definition = cpwfObject(value.definition); break; }
    }
    if (!definition) return null;
    return {
      definition,
      state: cpwfObject(source.state || source.workflow_state || cpwfObject(source.workflow).state),
      params: cpwfObject(source.params || cpwfObject(source.document).params),
      outputs: cpwfObject(source.outputs || cpwfObject(source.document).outputs)
    };
  }
  function ensureDocumentWorkflow(token){
    const key = cleanText(token);
    if (!key || !documentWorkflowReady()) return;
    if (documentWorkflowCache[key] !== undefined) return;
    documentWorkflowCache[key] = 'pending';
    root.DocumentsAPI.public.workflow(key)
      .then((res) => { documentWorkflowCache[key] = normalizePublicWorkflow(res); })
      .catch(() => { documentWorkflowCache[key] = null; }) // route absent → no workflow
      .then(() => {
        if (activeDocumentGroupTab()) render();
      });
  }
  function documentWorkflowActionable(token, doc){
    const key = cleanText(token);
    const record = documentWorkflowCache[key];
    if (!record || record === 'pending' || !documentWorkflowReady()) return false;
    if (['signed', 'completed', 'declined', 'expired', 'void'].includes(cleanText(doc?.status))) return false;
    const workflow = record.definition;
    const helpers = cpwfObject(root.FMDocWorkflow.helpers);
    const snapshot = cpwfObject(cpwfObject(documentSnapshotCache[key]).snapshot);
    const outputs = { ...cpwfObject(snapshot.outputs), ...cpwfObject(record.outputs) };
    let actionable = false;
    const scope = { params: cpwfObject(record.params), outputs };
    cpwfArray(workflow.steps).forEach((step) => {
      const stepObj = cpwfObject(step);
      if (typeof helpers.stepVisibleFor === 'function' && !helpers.stepVisibleFor(stepObj, 'customer', workflow)) return;
      if (stepObj.when && typeof helpers.whenPasses === 'function' && !helpers.whenPasses(stepObj.when, scope)) return;
      cpwfArray(stepObj.items).forEach((item) => {
        const itemObj = cpwfObject(item);
        if (typeof helpers.itemVisibleFor === 'function' && !helpers.itemVisibleFor(itemObj, 'customer')) return;
        const writes = cleanText(itemObj.writes);
        if (!writes.startsWith('outputs.')) return; // readonly for customers
        const value = outputs[writes.slice('outputs.'.length)];
        const empty = value === undefined || value === null || value === ''
          || (Array.isArray(value) && !value.length)
          || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
        if (empty) actionable = true;
      });
    });
    return actionable;
  }
  function documentPresentationPhase(token, doc){
    const mode = cleanText(doc?.presentation?.mode) || 'document';
    if (mode === 'document') return 'document';
    const record = documentWorkflowCache[cleanText(token)];
    // Still being fetched: hold the step surface. Fetched and absent: the document.
    if (record === 'pending' || record === undefined) return documentWorkflowReady() ? 'workflow' : 'document';
    if (!record) return 'document';
    const override = cleanText(state.documentWorkflowViews[cleanText(token)]);
    if (override === 'document' || override === 'workflow') return override;
    // Signing and paying happen on the document, so with no question left to
    // answer there is nothing for the step surface to show.
    return documentWorkflowActionable(token, doc) ? 'workflow' : 'document';
  }
  function queueDocumentWorkflowOutput(token, key, value){
    if (value?.__signing) return submitDocumentOutput(token, key, value);
    const tokenKey = cleanText(token);
    const outputKey = cleanText(key);
    const record = documentWorkflowCache[tokenKey];
    if (record && record !== 'pending') record.outputs = { ...cpwfObject(record.outputs), [outputKey]: value };
    const snapshot = cpwfObject(cpwfObject(documentSnapshotCache[tokenKey]).snapshot);
    if (Object.keys(snapshot).length) snapshot.outputs = { ...cpwfObject(snapshot.outputs), [outputKey]: value };
    updateDocumentTaskPanel(tokenKey);
    documentWorkflowWriteChain = documentWorkflowWriteChain.then(async () => {
      if (blockPreviewAction('document actions')) return;
      try {
        const signing = !!value?.__signing;
        const evidence = signing ? await signatureEvidencePayload() : browserEvidenceBase();
        const writeToken = signing ? (await documentSigningAccess(tokenKey)).token : cleanText(token);
        await root.DocumentsAPI.public.recordOutput(writeToken, cleanText(key), withEvidence({ value }, evidence));
        root.DocumentsAPI.public.get(tokenKey).then((payload) => {
          if (payload) {
            documentSnapshotCache[tokenKey] = payload;
            refreshVisibleDocumentSnapshot(tokenKey, payload);
            updateDocumentTaskPanel(tokenKey);
          }
        }).catch(() => {});
        track('document_output_recorded', { document_token: cleanText(token), output_key: cleanText(key), source: 'workflow' });
      } catch (error) {
        showPortalToast(cleanText(error?.message) || 'We could not save that just now. Please try again.');
      }
    });
    return documentWorkflowWriteChain;
  }
  function closeDocumentWorkflowOverlay(){
    if (documentWorkflowOverlay) { try { documentWorkflowOverlay.close(); } catch (error) {} }
  }
  function openDocumentWorkflowOverlay(token){
    const key = cleanText(token);
    const record = documentWorkflowCache[key];
    if (!record || record === 'pending' || !documentWorkflowReady()) return;
    closeDocumentWorkflowOverlay();
    try { root.FMDocWorkflow.ensureStyles(); } catch (error) {}
    const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === key) || {};
    const snapshot = cpwfObject(cpwfObject(documentSnapshotCache[key]).snapshot);
    const overlay = document.createElement('div');
    overlay.className = 'fmdw-overlay';
    overlay.innerHTML = `
      <header class="fmdw-overlay-head">
        <strong>${escapeHtml(cleanText(doc.title) || documentTypeLabel(doc.document_type))}</strong>
        <button type="button" class="fmdw-overlay-close" data-workflow-close aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3742924668fb10","Close") ?? "Close")}">&#10005;</button>
      </header>
      <div class="fmdw-overlay-body"><div data-workflow-host></div></div>`;
    document.body.appendChild(overlay);
    let handle = null;
    const close = () => {
      try { handle?.destroy?.(); } catch (error) {}
      overlay.remove();
      documentWorkflowOverlay = null;
      delete documentSnapshotCache[key];
      ensureDocumentSnapshot(key).then(() => { if (activeDocumentGroupTab()) render(); });
    };
    documentWorkflowOverlay = { close };
    overlay.querySelector('[data-workflow-close]')?.addEventListener('click', close);
    try {
      handle = root.FMDocWorkflow.mount(overlay.querySelector('[data-workflow-host]'), {
        workflow: record.definition,
        audience: 'customer',
        theme: 'portal',
        contract: cpwfObject(record.definition.contract),
        state: {
          params: cpwfObject(record.params),
          outputs: { ...cpwfObject(snapshot.outputs), ...cpwfObject(record.outputs) },
          current_step: cleanText(cpwfObject(record.state).current_step),
          completed_steps: cpwfArray(cpwfObject(record.state).completed_steps)
        },
        // Public writes are OUTPUTS ONLY (the runtime renders non-output items
        // readonly for the customer audience; this host enforces it again).
        onWrite: (path, value) => {
          const target = cleanText(path);
          if (!target.startsWith('outputs.')) return;
          return queueDocumentWorkflowOutput(key, target.slice('outputs.'.length), value);
        },
        onStepState: () => { /* customer step state is not persisted publicly */ },
        onComplete: close,
        preview: {
          resolve: async () => {
            try { await documentWorkflowWriteChain; } catch (error) {}
            delete documentSnapshotCache[key];
            const payload = await ensureDocumentSnapshot(key);
            const snap = cpwfObject(cpwfObject(payload).snapshot);
            return {
              resolved_definition: snap.resolved_definition || snap.definition || {},
              theme: snap.theme || null,
              widget_data: cpwfObject(snap.widget_data)
            };
          }
        },
        services: {
          api: {
            publicToken: key,
            resolveSigning: () => documentSigningAccess(key),
            openPayment: (options) => openDocumentPayment(key, options),
            onlinePayments: onlinePaymentsAvailable()
          }
        }
      });
      track('document_workflow_opened', { document_token: key });
    } catch (error) {
      close();
    }
  }
  function documentWorkflowButtonHtml(token, doc){
    const mode = cleanText(doc?.presentation?.mode) || 'document';
    const record = documentWorkflowCache[cleanText(token)];
    if (record !== 'pending' && !documentWorkflowActionable(token, doc)) return '';
    if (mode === 'document') return '';
    const label = cleanText(doc?.presentation?.workflow_cta) || 'Review & continue';
    return `<button type="button" class="cp-btn cp-doc-workflow-btn" data-document-workflow="${escapeHtml(cleanText(token))}"
      ${record === 'pending' ? 'disabled aria-busy="true"' : ''}
      style="background:var(--cp-primary);color:var(--cp-on-primary);border:0;border-radius:10px;padding:9px 16px;font-weight:800;font-size:13px;cursor:pointer;box-shadow:0 6px 14px rgba(var(--cp-primary-rgb),.22)">${escapeHtml(label)}</button>`;
  }
  function documentOutputComplete(value){
    return !(value === undefined || value === null || value === ''
      || (Array.isArray(value) && !value.length)
      || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length));
  }
  function documentTaskRows(token, doc){
    const key = cleanText(token);
    const record = documentWorkflowCache[key];
    const snapshot = cpwfObject(cpwfObject(documentSnapshotCache[key]).snapshot);
    const outputs = { ...cpwfObject(snapshot.outputs), ...(record && record !== 'pending' ? cpwfObject(record.outputs) : {}) };
    const outputDefs = {
      ...(record && record !== 'pending' ? cpwfObject(cpwfObject(record.definition.contract).outputs) : {}),
      ...cpwfObject(snapshot.output_defs)
    };
    const documentPagesJson = JSON.stringify(cpwfArray(cpwfObject(snapshot.resolved_definition).pages));
    const tasks = [];
    const seen = new Set();
    const mode = cleanText(doc?.presentation?.mode) || 'document';
    const add = (outputKey, label, icon, stepId = '', phase = '') => {
      const id = cleanText(outputKey);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const outputDef = cpwfObject(outputDefs[id]);
      const outputType = cleanText(outputDef.type);
      const outputValue = outputs[id];
      const done = outputType === 'payment'
        ? Boolean(cleanText(cpwfObject(outputValue).payment_method || cpwfObject(outputValue).method || cpwfObject(cpwfObject(outputValue).checkout).payment_method))
        : documentOutputComplete(outputValue);
      // Ungated outputs (no required flag and no completion gate) are shown as
      // optional — e.g. selections whose upgrades bill on the next invoice.
      const required = outputDef.required === true || Boolean(cleanText(outputDef.required_for));
      tasks.push({ id, label, icon, stepId: cleanText(stepId), phase: cleanText(phase) || (mode === 'workflow' ? 'workflow' : 'document'), done, required });
    };
    if (record && record !== 'pending') {
      const helpers = cpwfObject(root.FMDocWorkflow?.helpers);
      const scope = { params: cpwfObject(record.params), outputs };
      cpwfArray(record.definition.steps).filter((step) => {
        const stepObj = cpwfObject(step);
        if (typeof helpers.stepVisibleFor === 'function' && !helpers.stepVisibleFor(stepObj, 'customer', record.definition)) return false;
        return !(stepObj.when && typeof helpers.whenPasses === 'function' && !helpers.whenPasses(stepObj.when, scope));
      }).forEach((step) => cpwfArray(cpwfObject(step).items).forEach((item) => {
        const itemObj = cpwfObject(item);
        const path = cleanText(itemObj.writes);
        if (!path.startsWith('outputs.')) return;
        const outputKey = path.slice('outputs.'.length);
        const kind = cleanText(itemObj.kind || cpwfObject(outputDefs[outputKey]).type);
        const fallback = kind === 'signature' ? 'Sign document' : kind === 'payment' ? 'Make payment' : 'Make selections';
        add(outputKey, cleanText(itemObj.label) || fallback, kind === 'signature' ? 'fa-signature' : kind === 'payment' ? 'fa-credit-card' : 'fa-list-check', cleanText(cpwfObject(step).id), 'workflow');
      }));
    }
    Object.entries(outputDefs).forEach(([outputKey, definition]) => {
      const type = cleanText(cpwfObject(definition).type);
      if (type === 'signature') add(outputKey, 'Sign document', 'fa-signature');
      else if (type === 'payment') add(outputKey, 'Make payment', 'fa-credit-card');
      else if (type === 'select' && cpwfObject(definition).required === true
        && (mode !== 'document' || documentPagesJson.includes(`\"${outputKey}\"`))) {
        add(outputKey, 'Make selections', 'fa-list-check');
      }
    });
    const workflowLeads = tasks.some((task) => task.icon === 'fa-list-check');
    const reviewStep = record && record !== 'pending'
      ? cpwfArray(record.definition.steps).find((step) => cpwfArray(cpwfObject(step).items).some((item) => cleanText(cpwfObject(item).kind) === 'review'))
      : null;
    const workflowReview = mode !== 'document' && Boolean(reviewStep);
    tasks.splice(workflowLeads ? Math.min(1, tasks.length) : 0, 0, {
      id: '__review', label: workflowReview ? 'Review selections' : 'Review document', icon: 'fa-file-lines',
      stepId: workflowReview ? cleanText(cpwfObject(reviewStep).id) : '',
      phase: workflowReview ? 'workflow' : 'document',
      done: workflowReview
        ? cpwfArray(cpwfObject(record.state).completed_steps).includes(cleanText(cpwfObject(reviewStep).id))
        : ['viewed', 'in_progress', 'signed', 'completed'].includes(cleanText(doc?.status)) || Boolean(snapshot.id)
    });
    return tasks;
  }
  function documentTaskPanelHtml(token, doc){
    const tasks = documentTaskRows(token, doc);
    const complete = tasks.filter((task) => task.done).length;
    const nextIndex = tasks.findIndex((task) => !task.done);
    return `<div class="cp-doc-task-panel" data-document-tasks="${escapeHtml(cleanText(token))}">
      <div class="cp-doc-task-head"><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_1e72217cf350a0","To do") ?? "To do")}</span><strong>${complete}/${tasks.length}</strong></div>
      <div class="cp-doc-task-progress"><i style="width:${tasks.length ? Math.round(complete / tasks.length * 100) : 0}%"></i></div>
      <ol>${tasks.map((task, index) => `<li class="${task.done ? 'done' : ''}"><button type="button" data-document-task-phase="${escapeHtml(task.phase)}" data-document-task-step="${escapeHtml(task.stepId)}" data-document-task-focus="${escapeHtml(task.icon)}"><span><i class="fa-solid ${task.done ? 'fa-check' : task.icon}" aria-hidden="true"></i></span><div><strong>${escapeHtml(task.label)}</strong><small>${task.done ? 'Complete' : index === nextIndex ? 'Up next' : (task.required === false ? 'Optional' : 'Required')}</small></div></button></li>`).join('')}</ol>
    </div>`;
  }
  function updateDocumentTaskPanel(token){
    const host = mount.querySelector(`[data-document-tasks="${cleanText(token)}"]`);
    if (!host) return;
    const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === cleanText(token)) || activePortalDocument() || {};
    const wrapper = document.createElement('div');
    wrapper.innerHTML = documentTaskPanelHtml(token, doc);
    host.replaceWith(wrapper.firstElementChild);
  }
  function documentsPanel(docs, descriptor){
    if (!docs.length) {
      return `<section class="cp-panel"><div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_6f3dd34cc86d1a","No documents have been shared yet.") ?? "No documents have been shared yet.")}</div></section>`;
    }
    const active = activePortalDocument() || docs[0];
    const activeToken = cleanText(active?.public_token);
    const presentation = active?.presentation || {};
    const mode = cleanText(presentation.mode) || 'document';
    ensureDocumentWorkflow(activeToken);
    const phase = documentPresentationPhase(activeToken, active);
    const cards = docs.map((doc) => {
      const token = cleanText(doc.public_token);
      const canceled = cleanText(doc.status) === 'canceled' || !token;
      const isActive = !canceled && token === activeToken;
      const statusClass = ['signed', 'completed'].includes(cleanText(doc.status)) ? 'done' : (canceled ? 'canceled' : '');
      return `
        <button type="button" class="cp-doc-card ${isActive ? 'active' : ''} ${canceled ? 'is-canceled' : ''}"${canceled ? ' disabled aria-disabled="true"' : ` data-document-token="${escapeHtml(token)}"`}>
          <span class="cp-doc-card-type">${escapeHtml(documentTypeLabel(doc.document_type))}</span>
          <strong>${escapeHtml(cleanText(doc.title) || documentTypeLabel(doc.document_type))}</strong>
          <span class="cp-doc-card-status ${statusClass}">${escapeHtml(documentStatusLabel(doc.status))}</span>
        </button>
      `;
    }).join('');
    const cached = documentSnapshotCache[activeToken];
    const pdfUrl = phase === 'document' && root.DocumentsAPI ? root.DocumentsAPI.public.pdfUrl(activeToken) : '';
    let stage;
    if (phase === 'document' && !documentEngineReady()) {
      stage = `<div class="cp-empty">This document is best viewed as a PDF.${pdfUrl ? ` <a href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_27faa26cc36a51","Open PDF") ?? "Open PDF")}</a>` : ''}</div>`;
    } else if (cached && cached.error) {
      stage = `<div class="cp-empty">${escapeHtml(cached.error)}<div style="margin-top:12px"><button type="button" class="cp-btn" data-document-retry="${escapeHtml(activeToken)}">Try again</button></div></div>`;
    } else if (phase === 'document') {
      stage = '<div id="cpDocumentStage" class="cp-doc-stage" data-doc-token="' + escapeHtml(activeToken) + `"><div class="cp-loading">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_2f5ece5412be45","Loading document...") ?? "Loading document...")}</div></div>`;
    } else {
      stage = '';
    }
    return `
      <section class="cp-panel cp-documents-panel mode-${escapeHtml(mode)} phase-${escapeHtml(phase)}">
        <aside class="cp-doc-sidebar"><div class="cp-doc-list">${cards}</div>${documentTaskPanelHtml(activeToken, active)}</aside>
        <div class="cp-doc-viewer">
          <div class="cp-doc-toolbar">
            ${cached?.workflow?.customer_complete === true && cleanText(cached.workflow.completion_message) ? '<div class="cp-doc-complete-note" role="status"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>' + escapeHtml(cached.workflow.completion_message) + '</span></div>' : ''}
            <div class="cp-doc-toolbar-actions">
              ${mode === 'hybrid' && phase === 'document' ? `<button type="button" class="cp-doc-change-step" data-document-show-workflow="${escapeHtml(activeToken)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_b6143b01996f97","Change selections") ?? "Change selections")}</span></button>` : ''}
              ${pdfUrl ? `<a class="cp-doc-icon-btn" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_4944e59816b60a","Download PDF") ?? "Download PDF")}" title="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_4944e59816b60a","Download PDF") ?? "Download PDF")}"><i class="fa-solid fa-download" aria-hidden="true"></i></a>` : ''}
            </div>
          </div>
          ${phase === 'workflow' ? `<section class="cp-doc-workflow-inline" data-inline-document-workflow="${escapeHtml(activeToken)}"><div class="cp-loading">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_1552b0ceca5d2f","Loading your next step...") ?? "Loading your next step...")}</div></section>` : ''}
          ${stage}
        </div>
      </section>
    `;
  }
  function mountInlineDocumentWorkflow(){
    if (activeInlineDocumentWorkflow) {
      try { activeInlineDocumentWorkflow.destroy?.(); } catch (error) {}
      activeInlineDocumentWorkflow = null;
    }
    const host = mount.querySelector('[data-inline-document-workflow]');
    if (!host || !documentWorkflowReady()) return;
    const key = cleanText(host.dataset.inlineDocumentWorkflow);
    const record = documentWorkflowCache[key];
    if (!record || record === 'pending') return;
    const snapshot = cpwfObject(cpwfObject(documentSnapshotCache[key]).snapshot);
    host.innerHTML = '';
    try {
      const portalDoc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === key) || {};
      const askedStep = cleanText(state.pendingDocumentTaskStep);
      state.pendingDocumentTaskStep = '';
      activeInlineDocumentWorkflow = root.FMDocWorkflow.mount(host, {
        workflow: record.definition,
        audience: 'customer',
        theme: 'portal',
        readonly: ['signed', 'completed', 'declined', 'expired', 'void', 'canceled'].includes(cleanText(portalDoc.status)),
        contract: cpwfObject(record.definition.contract),
        state: {
          params: cpwfObject(record.params),
          outputs: { ...cpwfObject(snapshot.outputs), ...cpwfObject(record.outputs) },
          current_step: askedStep || cleanText(cpwfObject(record.state).current_step),
          completed_steps: cpwfArray(cpwfObject(record.state).completed_steps)
        },
        onWrite: (path, value) => {
          const target = cleanText(path);
          if (target.startsWith('outputs.')) return queueDocumentWorkflowOutput(key, target.slice('outputs.'.length), value);
        },
        onStepState: (next) => {
          record.state = { ...cpwfObject(record.state), ...cpwfObject(next) };
          updateDocumentTaskPanel(key);
        },
        onComplete: () => {
          const doc = documentList(activeProjectPayload()).find((entry) => cleanText(entry.public_token) === key) || {};
          if (cleanText(doc?.presentation?.mode) === 'hybrid') {
            state.documentWorkflowViews[key] = 'document';
            render();
          } else updateDocumentTaskPanel(key);
        },
        services: {
          api: {
            publicToken: key,
            resolveSigning: () => documentSigningAccess(key),
            openPayment: (options) => openDocumentPayment(key, options),
            onlinePayments: onlinePaymentsAvailable()
          }
        }
      });
      if (state.pendingDocumentTaskStep) {
        const stepId = state.pendingDocumentTaskStep;
        state.pendingDocumentTaskStep = '';
        activeInlineDocumentWorkflow.refresh?.({ current_step: stepId });
      }
    } catch (error) {
      host.innerHTML = `<div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_29e9e478faa698","This workflow is unavailable right now.") ?? "This workflow is unavailable right now.")}</div>`;
    }
  }
  function mountDocumentStage(){
    const stage = mount.querySelector('#cpDocumentStage');
    if (activeDocumentStage) {
      try { activeDocumentStage.destroy?.(); } catch (error) {}
      activeDocumentStage = null;
    }
    if (!stage || !documentEngineReady()) return;
    const token = cleanText(stage.dataset.docToken);
    if (!token) return;
    ensureDocumentWorkflow(token); // reveals "Review & choose options" when actionable
    const cached = documentSnapshotCache[token];
    if (!cached) {
      ensureDocumentSnapshot(token).then(() => {
        if (activeDocumentGroupTab()) render();
      });
      return;
    }
    if (cached.error || !cached.snapshot) {
      if (!cached.error) stage.innerHTML = '<div class="cp-empty">This document has nothing to show yet.</div>';
      return;
    }
    const snapshot = cached.snapshot;
    const resolved = snapshot.resolved_definition || snapshot.definition;
    if (!resolved) return;
    const paper = root.FMDocModel.paperDimensions(resolved);
    const available = Math.max(280, stage.clientWidth - 24);
    const scale = Math.min(1.25, available / (paper.w_pt * (96 / 72)));
    stage.innerHTML = '';
    try {
      const renderOptions = {
        document: resolved,
        theme: snapshot.theme || null,
        themeContext: { overrides: snapshot.theme_vars || {} },
        mode: 'interactive',
        widgetData: snapshot.widget_data || {},
        scale,
        widgetContext: {
          api: {
            publicToken: token,
            resolveSigning: () => documentSigningAccess(token),
            portalUrl: location.href,
            openPayment: (options) => openDocumentPayment(token, options),
            onlinePayments: onlinePaymentsAvailable()
          },
          outputs: snapshot.outputs || {},
          submitOutput: async (key, value) => {
            // Payment outputs get the conditional-pricing preview + confirm
            // (spec §10.4) before recording; everything else submits as-is.
            return submitDocumentOutput(token, key, value);
          }
        }
      };
      stage.__cpDocumentRenderOptions = renderOptions;
      activeDocumentStage = root.FMDocRenderer.render(stage, renderOptions);
      warmDocumentSigning(token);
      if (state.pendingDocumentTaskFocus) {
        const focus = state.pendingDocumentTaskFocus;
        state.pendingDocumentTaskFocus = '';
        Promise.resolve(activeDocumentStage.ready?.()).catch(() => null).then(() => requestAnimationFrame(() => {
          const selector = focus === 'fa-signature' ? '.fmdoc-signature'
            : focus === 'fa-credit-card' ? '.fmdoc-pay-now'
              : '.fmdoc-page';
          stage.querySelector(selector)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }));
      }
      // Popup-media affordances ([data-fmdoc-media-popup] chips from
      // media_text_row / doc.media_popup / line-item rows) open the shared
      // lightbox via ONE document-level delegate — safe to call repeatedly.
      try { root.FMDocWidgets?.installLightboxDelegate?.(); } catch (error) {}
    } catch (error) {
      stage.innerHTML = `<div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8db10c474f07bf","We could not display this document. Try the PDF download instead.") ?? "We could not display this document. Try the PDF download instead.")}</div>`;
    }
  }
  function refreshVisibleDocumentSnapshot(token, payload){
    const stage = mount.querySelector('#cpDocumentStage');
    if (!stage || cleanText(stage.dataset.docToken) !== cleanText(token) || !activeDocumentStage) return;
    const snapshot = cpwfObject(cpwfObject(payload).snapshot);
    const definition = snapshot.resolved_definition || snapshot.definition;
    if (!definition) return;
    const pages = Array.from(stage.querySelectorAll('.fmdoc-page'));
    const stickyBottom = 82;
    let anchorIndex = pages.findIndex((page) => page.getBoundingClientRect().bottom > stickyBottom);
    if (anchorIndex < 0) anchorIndex = Math.max(0, pages.length - 1);
    const anchorOffset = pages[anchorIndex]?.getBoundingClientRect().top || 0;
    const previous = cpwfObject(stage.__cpDocumentRenderOptions);
    const nextOptions = {
      ...previous,
      document: definition,
      theme: snapshot.theme || null,
      themeContext: { overrides: snapshot.theme_vars || {} },
      widgetData: snapshot.widget_data || {},
      widgetContext: { ...cpwfObject(previous.widgetContext), outputs: snapshot.outputs || {} }
    };
    stage.__cpDocumentRenderOptions = nextOptions;
    try {
      try { activeDocumentStage.destroy?.(); } catch (_) {}
      stage.innerHTML = '';
      activeDocumentStage = root.FMDocRenderer.render(stage, nextOptions);
      Promise.resolve(activeDocumentStage.ready?.()).catch(() => null).then(() => {
        requestAnimationFrame(() => {
          const replacement = stage.querySelectorAll('.fmdoc-page')[anchorIndex];
          if (!replacement) return;
          const delta = replacement.getBoundingClientRect().top - anchorOffset;
          if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
        });
      });
    } catch (error) { /* keep the already interactive preview */ }
  }
  // --- Custom web-editor pages (payload.portal_pages) -----------------------
  // Content payload cache: page_id -> { page, definition, widget_data, theme_vars } | { error }.
  const customPageCache = {};
  let activeCustomPageHandle = null;
  let customPageResizeHandler = null;
  let customPageContentObserver = null;
  function websitesPublicApiBase(){
    const apiBase = cleanText(root.__APP?.platformApiBase || '/v1/platform');
    return apiBase.replace('/v1/platform', '/v1/websites');
  }
  function customPagePanel(){
    const tab = tabs().find((item) => item.kind === 'custom' && item.id === state.activeTab);
    if (!tab) return `<div class="cp-custom-page-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_53a041bcb32505","This page is no longer available.") ?? "This page is no longer available.")}</div>`;
    return `<div class="cp-custom-page" id="cpCustomPage" data-page-id="${escapeHtml(tab.pageId)}"><div class="cp-loading">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_9e40e28f8f02bf","Loading page...") ?? "Loading page...")}</div></div>`;
  }
  function summaryExtensionPanel(pageId){
    const id = cleanText(pageId);
    return id ? `<section class="cp-summary-custom" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_c5de8ef577c35b","Additional project information") ?? "Additional project information")}"><div class="cp-custom-page" id="cpCustomPage" data-page-id="${escapeHtml(id)}"><div class="cp-loading">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_953902899d3492","Loading additional content...") ?? "Loading additional content...")}</div></div></section>` : '';
  }
  async function ensureCustomPagePayload(pageId){
    const key = cleanText(pageId);
    if (!key) return null;
    if (customPageCache[key]) return customPageCache[key];
    try {
      const uuid = activePortalUuid();
      const response = await fetch(`${websitesPublicApiBase()}/public/portal/${encodeURIComponent(uuid)}/pages/${encodeURIComponent(key)}`, { credentials: 'omit' });
      if (!response.ok) throw new Error('This page could not be loaded.');
      const payload = await response.json();
      customPageCache[key] = payload && typeof payload === 'object' ? payload : { error: 'This page could not be loaded.' };
    } catch (error) {
      customPageCache[key] = { error: cleanText(error?.message) || 'This page could not be loaded.' };
    }
    return customPageCache[key];
  }
  function clearCustomPageCache(){
    Object.keys(customPageCache).forEach((key) => { delete customPageCache[key]; });
  }
  function destroyCustomPageStage(){
    if (activeCustomPageHandle) {
      try { activeCustomPageHandle.destroy?.(); } catch (error) {}
      activeCustomPageHandle = null;
    }
    if (customPageResizeHandler) {
      root.removeEventListener('resize', customPageResizeHandler);
      customPageResizeHandler = null;
    }
    if (customPageContentObserver) {
      try { customPageContentObserver.disconnect(); } catch (error) {}
      customPageContentObserver = null;
    }
  }
  function handleCustomPageLinkClick(event){
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    const href = cleanText(link.getAttribute('href'));
    const pageMatch = /^#page:(.+)$/.exec(href);
    if (pageMatch) {
      event.preventDefault();
      let slug = pageMatch[1];
      try { slug = decodeURIComponent(slug); } catch (error) {}
      const targetId = `page:${cleanText(slug)}`;
      if (tabs().some((item) => item.id === targetId)) setActiveTab(targetId);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault();
      root.open(href, '_blank', 'noopener');
    }
  }
  function fitCustomPageStage(definition){
    if (!activeCustomPageHandle?.setScale) return;
    const stage = mount.querySelector('#cpCustomPage');
    if (!stage) return;
    // Fluid ("fill") pages span the panel and reflow — never scaled.
    if (definition?.settings?.paper?.size === 'fill') return;
    const paper = root.FMDocModel?.paperDimensions?.(definition) || {};
    const designWidth = (Number(paper.w_pt) || 720) * (96 / 72);
    const available = stage.clientWidth;
    if (!available || !designWidth) return;
    try { activeCustomPageHandle.setScale(Math.min(1, available / designWidth)); } catch (error) {}
  }
  // ── Live chat ─────────────────────────────────────────────────────────────
  // The chat service already verifies signed portal grants; the payload mints
  // one (server-side, live portals only). Starting the widget here rather than
  // via the script's data-* auto-init is what keeps it off preview portals and
  // off orgs that have chat switched off.
  let chatEmbedStarted = false;
  let chatGrantRefreshTimer = null;
  function chatApiBase(){
    const host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') {
      return `${location.origin}/v1/chat`;
    }
    return '/v1/chat';
  }
  function portalChatPageContext(){
    const activePayload = activeProjectPayload();
    const tab = tabs().find((item) => item.id === state.activeTab) || {};
    const panel = mount.querySelector('.cp-tab-panel');
    const visibleText = [];
    const seen = new Set();
    // This is a semantic rendering of the visible page, not a pixel screenshot:
    // never copy fields, controls, media, signatures, or hidden DOM into chat.
    panel?.querySelectorAll('h1,h2,h3,p,li,.cp-empty,.cp-punch-status,.cp-section-head span').forEach((node) => {
      if (visibleText.length >= 12 || node.closest('form,[hidden],[aria-hidden="true"]')) return;
      const style = root.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return;
      const value = cleanText(node.textContent).replace(/\s+/g, ' ').slice(0, 240);
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return;
      seen.add(key);
      visibleText.push(value);
    });
    return {
      kind: 'customer_portal',
      title: cleanText(tab.label) || 'Customer Portal',
      tab_id: cleanText(state.activeTab),
      tab_label: cleanText(tab.label) || cleanText(state.activeTab),
      project_id: cleanText(activePayload?.project?.id || state.activeProjectId),
      project_title: firstDisplayName(activePayload?.project?.project_title, activePayload?.project?.title, activePayload?.project?.display_name),
      visible_text: visibleText
    };
  }
  async function portalChatPageSnapshot(){
    const panel = mount.querySelector('.cp-tab-panel');
    if (!panel || typeof root.html2canvas !== 'function') return null;
    const sourceWidth = Math.max(320, Math.round(panel.getBoundingClientRect().width || panel.clientWidth || 0));
    const sourceHeight = Math.max(180, Math.min(1000, Math.round(panel.scrollHeight || panel.getBoundingClientRect().height || 0)));
    const scale = Math.min(1.5, 960 / sourceWidth);
    const canvas = await root.html2canvas(panel, {
      backgroundColor: '#f7f8fa',
      width: sourceWidth,
      height: sourceHeight,
      scale,
      useCORS: true,
      allowTaint: false,
      imageTimeout: 2500,
      logging: false,
      onclone: (documentClone) => {
        const clonedPanel = documentClone.querySelector('.cp-tab-panel');
        clonedPanel?.querySelectorAll('form,input,textarea,select,[contenteditable="true"],iframe,video,audio,canvas').forEach((node) => node.remove());
        clonedPanel?.querySelectorAll('[hidden],[aria-hidden="true"]').forEach((node) => node.remove());
      }
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    return blob ? { blob, width: canvas.width, height: canvas.height } : null;
  }
  function syncPortalChat(){
    const chat = state.payload?.chat;
    const embed = root.FirstMateChatEmbed;
    if (!embed || isPreviewMode()) return;
    const widgetKey = cleanText(chat?.widget_key);
    const grant = cleanText(chat?.portal_grant);
    if (!widgetKey || !grant) return;
    if (chatEmbedStarted) return;
    chatEmbedStarted = true;
    try {
      embed.init({
        widgetKey,
        baseUrl: chatApiBase(),
        position: cleanText(chat?.appearance?.position),
        portalGrant: grant,
        pageContextProvider: portalChatPageContext,
        pageSnapshotProvider: portalChatPageSnapshot
      });
    } catch (error) {
      chatEmbedStarted = false;
      return;
    }
    // Grants are short-lived (15 min). Refresh the payload a little before
    // expiry so a portal left open overnight can still start a conversation.
    if (chatGrantRefreshTimer) clearTimeout(chatGrantRefreshTimer);
    chatGrantRefreshTimer = setTimeout(() => {
      refreshPortalPayload().catch(() => {});
    }, 12 * 60 * 1000);
  }

  // Hosting context handed to portal.* widgets through the renderer's
  // widgetContext (contracts §11). `settings` is the client-safe projection the
  // payload carries — it decides which affordances render, never whether a write
  // is allowed; every write route re-checks server-side.
  function portalWidgetContext(){
    const payload = activeProjectPayload();
    const projectId = cleanText(payload?.project?.id || state.activeProjectId);
    if (!projectId) return null;
    return {
      portalUuid: activePortalUuid(payload),
      projectId,
      contactId: cleanText(state.payload?.portal?.contact_id),
      preview: isPreviewMode(),
      settings: portalSettings(),
      // Pre-computed view models. The home-essential widgets are VIEWS of the
      // payload the portal already holds, so the business logic (what counts as
      // the next step, which appointment is next) stays in one place here and
      // the widget library stays purely presentational — no duplicated rules,
      // no extra fetches.
      views: portalWidgetViews(payload),
      openTab: (tabId) => setActiveTab(cleanText(tabId)),
      refreshPayload: () => refreshPortalPayload()
    };
  }
  function portalWidgetViews(payload){
    const org = state.payload?.organization || {};
    const project = payload.project || {};
    const customer = projectCustomer(payload);
    const media = Array.isArray(payload.media) ? payload.media : [];
    const events = portalScheduleEvents(payload);
    const now = Date.now();
    const upcoming = events.filter((event) => Date.parse(cleanText(event.start_at || event.start)) >= now);
    let steps = [];
    try { steps = overviewSteps(payload, cleanText(org.name)); } catch (error) { steps = []; }
    return {
      project: {
        name: firstDisplayName(project.project_title, project.title, project.display_name, customer.name),
        address: cleanText(project.address),
        customer_name: cleanText(customer.name),
        customer_email: cleanText(customer.email),
        customer_phone: formatPhone(customer.phone),
        organization_name: cleanText(org.name)
      },
      next_steps: steps.map((step) => ({
        id: cleanText(step.id),
        label: cleanText(step.label),
        detail: cleanText(step.detail),
        complete: step.complete === true,
        disabled: step.disabled === true,
        tab: cleanText(step.tab)
      })),
      appointments: {
        next: upcoming[0] || null,
        upcoming: upcoming.slice(0, 3),
        total: events.length
      },
      photos: {
        items: media.slice(0, 6).map((item) => ({
          media_id: cleanText(item.media_id || item.id),
          url: cleanText(item.thumb || item.src),
          label: cleanText(item.label),
          is_video: cleanText(item.media_type || item.kind).toLowerCase() === 'video'
        })),
        total: media.length
      },
      documents: { total: documentList(payload).length },
      punch: { lists: punchLists(payload).map((entry) => ({ id: entry.id, state: entry.state, noun: entry.labels?.noun || 'list' })) }
    };
  }
  function mountCustomPage(){
    destroyCustomPageStage();
    const stage = mount.querySelector('#cpCustomPage');
    if (!stage) return;
    const pageId = cleanText(stage.dataset.pageId);
    if (!pageId || !root.FMDocRenderer) {
      stage.innerHTML = `<div class="cp-custom-page-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_d14cee5bf47399","This page could not be displayed.") ?? "This page could not be displayed.")}</div>`;
      return;
    }
    const cached = customPageCache[pageId];
    if (!cached) {
      ensureCustomPagePayload(pageId).then(() => {
        const current = mount.querySelector('#cpCustomPage');
        if (current && cleanText(current.dataset.pageId) === pageId) mountCustomPage();
      });
      return; // Loading state from customPagePanel() stays visible meanwhile.
    }
    if (cached.error || !cached.definition) {
      stage.innerHTML = `<div class="cp-custom-page-empty">${escapeHtml(cached.error || 'This page is unavailable.')}</div>`;
      return;
    }
    stage.innerHTML = '';
    stage.addEventListener('click', handleCustomPageLinkClick);
    try {
      activeCustomPageHandle = root.FMDocRenderer.render(stage, {
        document: cached.definition,
        mode: 'interactive',
        widgetData: cached.widget_data || {},
        themeContext: { overrides: cached.theme_vars || {} },
        mediaUrl: (media, variant) => {
          const mediaId = cleanText(media?.media_id || media?.mediaId || media?.id);
          return mediaId && root.PlatformAPI?.customerPortals?.publicMediaUrl
            ? root.PlatformAPI.customerPortals.publicMediaUrl(activePortalUuid(), mediaId, { preview: isPreviewMode(), variant: variant || media?.variant || 'original' })
            : cleanText(media?.url);
        },
        widgetContext: {
          portalUrl: location.href,
          // Cross-page links resolve to tab switches via the click delegate
          // above; if the renderer does not support resolvePageHref yet, the
          // page still renders with plain (inert) hrefs.
          resolvePageHref: (slug) => `#page:${cleanText(slug)}`,
          portal: portalWidgetContext()
        }
      });
    } catch (error) {
      stage.innerHTML = `<div class="cp-custom-page-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_eeea87e651d027","We could not display this page.") ?? "We could not display this page.")}</div>`;
      return;
    }
    fitCustomPageStage(cached.definition);
    customPageResizeHandler = () => fitCustomPageStage(cached.definition);
    root.addEventListener('resize', customPageResizeHandler);
    // Refit as the render settles: images/widgets finish loading after the
    // first fit, and a scale computed from the early (short) layout would
    // otherwise freeze the page into a clipped, scrolling box.
    try { activeCustomPageHandle?.ready?.()?.then?.(() => fitCustomPageStage(cached.definition)); } catch (error) {}
    if (typeof ResizeObserver === 'function') {
      const inner = stage.querySelector('.fmdoc-scale');
      if (inner) {
        customPageContentObserver = new ResizeObserver(() => fitCustomPageStage(cached.definition));
        customPageContentObserver.observe(inner);
      }
    }
  }
  function portalAppointment(payload){
    const appointment = resources(payload).appointment;
    return appointment && typeof appointment === 'object' ? appointment : null;
  }
  function portalScheduleEvents(payload){
    const events = resources(payload).schedule_events;
    if (!Array.isArray(events)) return [];
    return events
      .filter((event) => event && typeof event === 'object' && cleanText(event.start_at || event.start))
      .flatMap((event) => {
        const start = new Date(event.start_at || event.start || '');
        const inclusiveEnd = scheduleInclusiveEnd(event);
        const category = cleanText(event.category).toLowerCase();
        const isMultiDayWork = category === 'work'
          && Number.isFinite(start.getTime())
          && inclusiveEnd
          && !scheduleSameDay(start, inclusiveEnd);
        if (!isMultiDayWork) return [event];

        const baseTitle = cleanText(event.title) || 'Project work';
        const markerStart = inclusiveEnd.toISOString();
        const baseId = cleanText(event.id) || `work_${start.getTime()}`;
        return [{
          ...event,
          title: ((v0) => globalThis.PlatformLanguage?.text("customer-portal","m_3aa492a028ffec",`${v0} starts`,{v0}) ?? `${v0} starts`)(baseTitle),
          is_estimate: false,
          has_estimated_dates: event.is_estimate === true,
          timeline_kind: 'work_start'
        }, {
          ...event,
          id: `${baseId}_end`,
          title: ((v0) => globalThis.PlatformLanguage?.text("customer-portal","m_6c90b1263e9718",`${v0} ends`,{v0}) ?? `${v0} ends`)(baseTitle),
          start_at: markerStart,
          end_at: '',
          all_day: true,
          is_estimate: false,
          crew_name: '',
          customer_description: '',
          timeline_kind: 'work_end'
        }];
      })
      .sort((a, b) => {
        const dateDifference = Date.parse(cleanText(a.start_at || a.start)) - Date.parse(cleanText(b.start_at || b.start));
        if (dateDifference) return dateDifference;
        const order = { work_start: 10, work_end: 20 };
        return (order[cleanText(a.timeline_kind)] || 0) - (order[cleanText(b.timeline_kind)] || 0);
      });
  }
  // Tab descriptors are computed server-side (payload.tabs) so ordering, labels,
  // per-project gating and audience targeting all live in one place. The legacy
  // path below stays as a fallback: an older payload, a failed tab computation,
  // or a stale cached response must render exactly what it always did.
  function tabs(){
    const active = activeProjectPayload();
    const served = Array.isArray(active?.tabs) && active.tabs.length ? active.tabs : state.payload?.tabs;
    if (Array.isArray(served) && served.length) return served.map(normalizeTabDescriptor).filter(Boolean);
    return legacyTabs();
  }
  // Server descriptors speak `kind: "page"` / `page_id`; the rest of this file
  // has always spoken `kind: 'custom'` / `pageId`. Summary additionally carries
  // an extension page that renders after its required native content.
  function normalizeTabDescriptor(tab){
    if (!tab || typeof tab !== 'object') return null;
    const id = cleanText(tab.id);
    if (!id) return null;
    const pageId = cleanText(tab.page_id || tab.pageId);
    const sourcePageId = cleanText(tab.source?.page_id);
    const isCustomPage = cleanText(tab.kind) === 'page' || cleanText(tab.kind) === 'custom';
    return {
      id,
      label: cleanText(tab.label) || 'Section',
      icon: cleanText(tab.icon),
      // A blessed tab backed by a page (today: Home) renders through the same
      // custom-page stage as a portal page tab.
      kind: isCustomPage || sourcePageId ? 'custom' : 'system',
      pageId: pageId || sourcePageId,
      sourceType: cleanText(tab.source?.type),
      groupId: cleanText(tab.source?.group_id),
      extensionPageId: cleanText(tab.extension_page_id || tab.extensionPageId)
    };
  }
  function legacyTabs(){
    const base = [
      { id: 'summary', label: (globalThis.PlatformLanguage?.text("customer-portal","m_9b03ccb29ba168","Summary") ?? "Summary") },
      { id: 'schedule', label: (globalThis.PlatformLanguage?.text("customer-portal","m_fc05a804bd034c","Schedule") ?? "Schedule") },
      { id: 'photos', label: (globalThis.PlatformLanguage?.text("customer-portal","m_be4cfb58b9c4d7","Photos") ?? "Photos") },
      ...(checklistList(activeProjectPayload()).length ? [{ id: 'checklists', label: (globalThis.PlatformLanguage?.text("customer-portal","m_4890d3d11dc3eb","Checklists") ?? "Checklists") }] : []),
      { id: 'payments', label: (globalThis.PlatformLanguage?.text("customer-portal","m_5842802f6c8cbb","Payments") ?? "Payments") }
    ];
    if (documentList(activeProjectPayload()).length) base.splice(base.length - 1, 0, { id: 'documents', label: (globalThis.PlatformLanguage?.text("customer-portal","m_5d7c7ad6033624","Documents") ?? "Documents") });
    if (punchLists().length) base.push({ id: 'punch_lists', label: (globalThis.PlatformLanguage?.text("customer-portal","m_83e0a1f309f1da","Your List") ?? "Your List") });
    return base.concat(customPortalPageTabs());
  }
  function customPortalPageTabs(){
    const active = activeProjectPayload();
    const pages = active?.portal_pages?.pages || state.payload?.portal_pages?.pages;
    if (!Array.isArray(pages)) return [];
    return pages
      .filter((page) => page && typeof page === 'object' && cleanText(page.slug) && cleanText(page.id))
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((page) => ({
        id: `page:${cleanText(page.slug)}`,
        label: cleanText(page.title) || 'Page',
        kind: 'custom',
        pageId: cleanText(page.id)
      }));
  }
  function checklistList(payload = activeProjectPayload()){
    return Array.isArray(resources(payload).checklists) ? resources(payload).checklists : [];
  }
  function activePortalUuid(payload = activeProjectPayload()){
    const portal = payload.active_project_portal || payload.portal || {};
    return cleanText(isPreviewMode() ? portal.preview_uuid : portal.public_uuid) || cleanText(cfg.id);
  }
  function checklistRequirementMatches(requirement = {}, attachment = {}){
    const allowed = Array.isArray(requirement.allowed_kinds) ? requirement.allowed_kinds.map(cleanText).filter(Boolean) : [];
    if (allowed.length) return allowed.some((kind) => checklistRequirementMatches({ kind }, attachment));
    const required = cleanText(requirement.kind || 'any');
    const kind = cleanText(attachment.kind);
    if (required === 'any') return true;
    if (required === 'media') return ['photo','video','audio'].includes(kind);
    return required === kind;
  }
  function checklistPanel(payload = activeProjectPayload()){
    const checklists = checklistList(payload);
    if (!checklists.length) return `<div class="cp-checklist-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_cbf335f6f216cb","There are no customer checklists for this project.") ?? "There are no customer checklists for this project.")}</div>`;
    const readOnlyPreview = isPreviewMode();
    return `<section class="cp-checklists">
      <header class="cp-checklists-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3a4227555210a4","Project checklists") ?? "Project checklists")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_fa42021034be38","Review project requirements and complete any items assigned to you.") ?? "Review project requirements and complete any items assigned to you.")}</p></div></header>
      ${checklists.map((checklist) => {
        const access = checklist.customer_access || {};
        const items = Array.isArray(checklist.items) ? checklist.items : [];
        const completed = items.filter((item) => item.completed).length;
        const percent = items.length ? Math.round(completed / items.length * 100) : 0;
        const customerMayComplete = access.can_complete === true;
        const canComplete = customerMayComplete && !readOnlyPreview;
        const canEdit = access.can_edit_items === true && !readOnlyPreview;
        const voiceMode = cleanText(access.voice_mode || 'off');
        return `<article class="cp-checklist" data-cp-checklist="${escapeHtml(checklist.id)}">
          <div class="cp-checklist-head"><span class="cp-checklist-icon">✓</span><div class="cp-checklist-copy"><strong>${escapeHtml(checklist.title || (globalThis.PlatformLanguage?.text("customer-portal","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"))}</strong>${checklist.description ? `<span>${escapeHtml(checklist.description)}</span>` : ''}</div><div class="cp-checklist-progress">${completed}/${items.length}<span class="cp-checklist-progress-bar"><i style="width:${percent}%"></i></span></div></div>
          <div class="cp-checklist-permissions"><span class="cp-checklist-permission ${customerMayComplete ? 'action' : ''}">${customerMayComplete ? 'Customer can complete' : 'Project team checklist'}</span>${access.can_edit_items === true ? `<span class="cp-checklist-permission action">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_73b4896766269d","Customer can edit items") ?? "Customer can edit items")}</span>` : ''}${voiceMode !== 'off' ? `<span class="cp-checklist-permission">${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_59839e02479775",`Voice: ${v0}`,{v0}) ?? `Voice: ${v0}`)(voiceMode === 'edit' ? 'complete + edit' : 'complete only')}</span>` : ''}</div>
          ${voiceMode !== 'off' && !readOnlyPreview ? `<button type="button" class="cp-checklist-voice-btn" data-cp-checklist-voice><span aria-hidden="true">●</span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_f35187c447e727"," Update with voice") ?? " Update with voice")}</button><div class="cp-checklist-voice" data-cp-checklist-voice-mount></div>` : ''}
          <div class="cp-checklist-items">${items.map((item) => {
            const requirements = Array.isArray(item.requirements) ? item.requirements : [];
            const attachments = Array.isArray(item.attachments) ? item.attachments : [];
            const evidence = requirements.map((requirement) => {
              const count = attachments.filter((attachment) => (!requirement.id || !attachment.requirement_id || requirement.id === attachment.requirement_id) && checklistRequirementMatches(requirement, attachment)).length;
              const minimum = Math.max(1, Number(requirement.min_count) || 1);
              return canComplete
                ? `<button type="button" class="${count >= minimum ? 'met' : ''}" data-cp-checklist-evidence="${escapeHtml(requirement.id)}" data-evidence-kind="${escapeHtml(requirement.kind || 'any')}">${escapeHtml(requirement.label || `Required ${requirement.kind || 'attachment'}`)} ${count}/${minimum}</button>`
                : `<span class="${count >= minimum ? 'met' : ''}">${escapeHtml(requirement.label || `Required ${requirement.kind || 'attachment'}`)} ${count}/${minimum}</span>`;
            }).join('');
            const rating = item.item_type === 'rating';
            return `<div class="cp-checklist-item ${item.completed ? 'done' : ''}" data-cp-checklist-item="${escapeHtml(item.id)}">
              <div class="cp-checklist-item-main">
                ${rating ? '' : `<button type="button" class="cp-checklist-toggle" data-cp-checklist-toggle ${canComplete ? '' : 'disabled'} aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_f57dd121e0c901",`${v1} item`,{v1}) ?? `${v1} item`)(item.completed ? 'Reopen' : 'Complete')}">${item.completed ? '✓' : ''}</button>`}
                <div class="cp-checklist-item-copy"><strong>${escapeHtml(item.title)}</strong>${item.description ? `<span>${escapeHtml(item.description)}</span>` : ''}${item.completed_at ? `<span>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_c0db38fc6a92a6",`Completed ${v0}${v1}`,{v0,v1}) ?? `Completed ${v0}${v1}`)(escapeHtml(new Date(item.completed_at).toLocaleDateString()),item.completed_by_customer ? ' by customer' : '')}</span>` : ''}</div>
                ${rating ? `<div class="cp-checklist-rating">${['good','neutral','bad'].map((value) => `<button type="button" data-cp-checklist-rating="${value}" class="${item.rating === value ? 'active' : ''}" ${canComplete ? '' : 'disabled'}>${value === 'good' ? 'Good' : value === 'neutral' ? 'Okay' : 'Needs work'}</button>`).join('')}</div>` : ''}
                ${canEdit ? `<div class="cp-checklist-item-actions"><button class="cp-checklist-small-btn" type="button" data-cp-checklist-rename aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_22f99c71c3518b","Rename item") ?? "Rename item")}">✎</button><button class="cp-checklist-small-btn" type="button" data-cp-checklist-remove aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_79a02ecd535f66","Remove item") ?? "Remove item")}">×</button></div>` : ''}
              </div>
              ${canComplete ? `<div class="cp-checklist-note"><textarea data-cp-checklist-note placeholder="${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_dd30440abc8a5f",`Add an optional note${v0}`,{v0}) ?? `Add an optional note${v0}`)(rating ? ' (required for Needs work)' : '')}">${escapeHtml(item.note || '')}</textarea><button type="button" data-cp-checklist-note-save>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5bab3e72de1ebf","Save") ?? "Save")}</button></div>` : (item.note ? `<div class="cp-checklist-note"><span>${escapeHtml(item.note)}</span></div>` : '')}
              ${requirements.length || attachments.length ? `<div class="cp-checklist-evidence">${evidence}${attachments.length ? `<span class="met">${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_e4575c3afa82e7",`${v0} attachment${v1}`,{v0,v1}) ?? `${v0} attachment${v1}`)(attachments.length,attachments.length === 1 ? '' : 's')}</span>` : ''}<input type="file" hidden data-cp-checklist-file></div>` : ''}
            </div>`;
          }).join('') || `<div class="cp-checklist-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_515c843668de04","This checklist does not have any items yet.") ?? "This checklist does not have any items yet.")}</div>`}</div>
          ${canEdit ? `<div class="cp-checklist-add"><input data-cp-checklist-add-input placeholder="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8df519ddf54757","Add a checklist item") ?? "Add a checklist item")}"><button type="button" data-cp-checklist-add>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_4d801afb3ef0c9","Add item") ?? "Add item")}</button></div>` : ''}
        </article>`;
      }).join('')}
    </section>`;
  }
  /**
   * Re-fetch the portal payload and repaint.
   *
   * This file previously declared refreshPortalPayload TWICE; the later
   * declaration won and it did not call render(), so every caller silently got
   * fresh state with a stale screen — adding a punch item, uploading a photo,
   * or posting a comment all appeared to do nothing until a manual reload.
   * One definition now, and it repaints.
   */
  async function refreshPortalPayload(){
    if (!cfg.id || !api?.customerPortals?.publicGet) return;
    const payload = await api.customerPortals.publicGet(cfg.id, { preview: cfg.preview });
    if(payload.language){root.PlatformLanguage?.configure?.({context:payload.language.context});root.PlatformTerminology?.setConfig?.({mappings:payload.language.terminology});await root.PlatformLanguage?.ensure?.(['customer-portal']);}
    state.payload = payload;
    state.activeProjectId = cleanText(state.activeProjectId || payload?.contact_portal?.active_project_id || payload?.project?.id);
    applyBranding(payload);
    clearCustomPageCache();
    render();
  }
  function isGenericCustomerName(value){
    const text = cleanText(value).toLowerCase();
    if (text === 'customer' || text === 'project' || text === 'new project') return true;
    if (/^project[_-][a-z0-9_-]{6,}$/i.test(text)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
    return false;
  }
  function firstDisplayName(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text && !isGenericCustomerName(text)) return text;
    }
    return 'Customer Portal';
  }
  function projectCustomer(payload = activeProjectPayload()){
    const project = payload?.project || {};
    const portalCustomer = payload?.portal?.customer || payload?.active_project_portal?.customer || {};
    const directCustomer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const primary = contacts.find((entry) => entry?.primary) || contacts.find((entry) => cleanText(entry?.name || entry?.email || entry?.phone)) || {};
    return {
      name: firstDisplayName(portalCustomer.name, primary.name, directCustomer.name, project.customer_name, project.customerName, project.primary_contact_name, project.resident_name),
      email: cleanText(portalCustomer.email || primary.email || directCustomer.email || project.customer_email || project.customerEmail || project.primary_contact_email).toLowerCase(),
      phone: cleanText(portalCustomer.phone || primary.phone || (Array.isArray(primary.phones) ? primary.phones[0] : '') || directCustomer.phone || project.customer_phone || project.customerPhone || project.primary_contact_phone)
    };
  }
  function logoHtml(org = {}){
    const logo = brandingLogoUrl(org);
    if (logo) return `<img class="cp-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(org.name || 'Company logo')}">`;
    return `<div class="cp-logo-fallback">${escapeHtml(cleanText(org.name).slice(0, 1).toUpperCase() || 'C')}</div>`;
  }
  function markupItems(item = {}){
    const markup = item.markup && typeof item.markup === 'object' ? item.markup : {};
    return Array.isArray(markup.items) ? markup.items : [];
  }
  function markupColor(value){
    const color = cleanText(value);
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#111111';
  }
  function markupPath(points = []){
    return (Array.isArray(points) ? points : []).map((point, index) => {
      const x = Math.max(0, Math.min(1, Number(point?.x || 0))) * 100;
      const y = Math.max(0, Math.min(1, Number(point?.y || 0))) * 100;
      return `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
    }).join(' ');
  }
  function markupArrow(item = {}){
    const x1 = Number(item.x1 || 0), y1 = Number(item.y1 || 0), x2 = Number(item.x2 || 0), y2 = Number(item.y2 || 0);
    const angle = Math.atan2(y2 - y1, x2 - x1), length = 0.035, spread = Math.PI / 7;
    return [
      { x1, y1, x2, y2 },
      { x1: x2, y1: y2, x2: x2 - Math.cos(angle - spread) * length, y2: y2 - Math.sin(angle - spread) * length },
      { x1: x2, y1: y2, x2: x2 - Math.cos(angle + spread) * length, y2: y2 - Math.sin(angle + spread) * length }
    ];
  }
  function markupOverlayHtml(item = {}){
    const items = markupItems(item);
    if (!items.length) return '';
    const strokes = items.filter((entry) => entry?.type === 'stroke').map((entry) => (
      `<path d="${markupPath(entry.points)}" style="stroke:${markupColor(entry.color)};stroke-width:${Math.max(0.5, Number(entry.size || 2.2))}"></path>`
    )).join('');
    const arrows = items.filter((entry) => entry?.type === 'arrow').map((entry) => markupArrow(entry).map((part) => (
      `<line x1="${(part.x1 * 100).toFixed(3)}" y1="${(part.y1 * 100).toFixed(3)}" x2="${(part.x2 * 100).toFixed(3)}" y2="${(part.y2 * 100).toFixed(3)}" style="stroke:${markupColor(entry.color)};stroke-width:${Math.max(0.5, Number(entry.size || 2.8))}"></line>`
    )).join('')).join('');
    const text = items.filter((entry) => entry?.type === 'text').map((entry) => {
      const size = Number(entry.fontPx) > 0 ? Number(entry.fontPx) / 9 : Number(entry.size || 1.5) * 2.4;
      return `<span style="left:${Number(entry.x || 0) * 100}%;top:${Number(entry.y || 0) * 100}%;width:${Number(entry.width || .24) * 100}%;color:${markupColor(entry.color)};font-size:${Math.max(1, size)}cqw">${escapeHtml(entry.text || '')}</span>`;
    }).join('');
    return `<div class="cp-markup-overlay" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${strokes}${arrows}</svg>${text}</div>`;
  }
  function markedImageHtml(item = {}, src, alt){
    const overlay = markupOverlayHtml(item);
    if (!overlay) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
    return `<span class="cp-media-visual"><span class="cp-markup-frame"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${overlay}</span></span>`;
  }
  function fitMarkupFrames(root = document){
    root.querySelectorAll?.('.cp-markup-frame').forEach((frame) => {
      const image = frame.querySelector('img');
      const host = frame.parentElement;
      const fit = () => {
        if (!image?.naturalWidth || !host) return;
        const bounds = host.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const imageRatio = image.naturalWidth / image.naturalHeight;
        const hostRatio = bounds.width / bounds.height;
        frame.style.width = imageRatio >= hostRatio ? '100%' : `${bounds.height * imageRatio}px`;
        frame.style.height = imageRatio >= hostRatio ? `${bounds.width / imageRatio}px` : '100%';
      };
      if (image.complete) fit(); else image.addEventListener('load', fit, { once: true });
    });
  }
  function mediaHtml(item = {}, index){
    const isVideo = cleanText(item.media_type || item.kind).toLowerCase() === 'video';
    const media = isVideo
      ? `<video src="${escapeHtml(item.thumb || item.src)}" muted playsinline preload="metadata"></video>`
      : `<img src="${escapeHtml(item.thumb || item.src)}" alt="${escapeHtml(item.label || 'Shared media')}" loading="lazy">`;
    return `
      <button type="button" class="cp-media-tile" data-media-index="${index}">
        ${media}
        <span class="cp-media-label">${escapeHtml(item.label || (isVideo ? 'Video' : 'Photo'))}</span>
      </button>
    `;
  }
  function photoWidget(media, { compact = false } = {}){
    const items = compact ? media.slice(0, 6) : media;
    return `
      <section class="cp-widget">
        <div class="cp-section-head">
          <h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_be4cfb58b9c4d7","Photos") ?? "Photos")}</h2>
          <span>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_40810d498e9130",`${v0} item${v1}`,{v0,v1}) ?? `${v0} item${v1}`)(media.length,media.length === 1 ? '' : 's')}</span>
        </div>
        ${items.length ? `<div class="cp-media-grid${compact ? ' compact' : ''}">${items.map(mediaHtml).join('')}</div>` : `<div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_136464fd464ca5","No photos or videos have been shared yet.") ?? "No photos or videos have been shared yet.")}</div>`}
        ${compact && media.length > items.length ? `<button type="button" class="cp-link-btn" data-tab-target="photos">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_1592c59e8f4105","View all photos") ?? "View all photos")}</button>` : ''}
        ${compact ? '' : customerUploadSection('photo')}
      </section>
    `;
  }
  // ── Customer uploads ──────────────────────────────────────────────────────
  // Affordances render from the payload's settings projection; the server
  // re-checks every write, so a tampered client gains nothing.
  function portalSettings(){
    return activeProjectPayload()?.settings || state.payload?.settings || {};
  }
  function customerUploadList(kind){
    const uploads = Array.isArray(activeProjectPayload().customer_uploads) ? activeProjectPayload().customer_uploads : [];
    return uploads.filter((upload) => (kind === 'document'
      ? cleanText(upload.kind) === 'document'
      : cleanText(upload.kind) !== 'document'));
  }
  function customerUploadSection(kind){
    const settings = portalSettings();
    const allowed = kind === 'document' ? settings.uploads?.documents === true : settings.uploads?.photos === true;
    const uploads = customerUploadList(kind);
    if (!allowed && !uploads.length) return '';
    const label = kind === 'document' ? 'documents' : 'photos';
    const accept = kind === 'document' ? '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt' : 'image/*,video/*';
    const requireCaption = settings.uploads?.require_caption === true;
    return `
      <section class="cp-uploads" data-upload-kind="${escapeHtml(kind)}">
        <div class="cp-section-head">
          <h2>${((v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_fc1e961a30dda0",`Your ${v1}`,{v1}) ?? `Your ${v1}`)(escapeHtml(label))}</h2>
          <span>${((v2) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_f6b7da8a87b6f1",`${v2} shared`,{v2}) ?? `${v2} shared`)(uploads.length)}</span>
        </div>
        ${uploads.length ? `<ul class="cp-upload-list">${uploads.map(customerUploadRow).join('')}</ul>` : `<div class="cp-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_2582ee52db69a8",`You have not shared any ${v0} yet.`,{v0}) ?? `You have not shared any ${v0} yet.`)(escapeHtml(label))}</div>`}
        ${allowed && !isPreviewMode() ? `
          <div class="cp-upload-form">
            ${requireCaption ? `<input type="text" class="cp-upload-caption" data-upload-caption placeholder="${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_5f5fdaa335973b",`Describe this ${v0}`,{v0}) ?? `Describe this ${v0}`)(kind === 'document' ? 'document' : 'photo')}" maxlength="500">` : ''}
            <label class="cp-upload-btn">
              <i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i>
              <span>${((v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_ba84599d22236c",`Add ${v1}`,{v1}) ?? `Add ${v1}`)(escapeHtml(kind === 'document' ? 'a document' : 'a photo'))}</span>
              <input type="file" accept="${escapeHtml(accept)}" data-upload-input hidden>
            </label>
            <p class="cp-upload-hint" data-upload-status></p>
          </div>
        ` : ''}
      </section>
    `;
  }
  function customerUploadRow(upload = {}){
    const mediaId = cleanText(upload.media_id);
    const isDocument = cleanText(upload.kind) === 'document';
    const url = api?.customerPortals?.publicMediaUrl
      ? api.customerPortals.publicMediaUrl(activePortalUuid(), mediaId, { preview: isPreviewMode() })
      : '';
    const preview = isDocument || !url
      ? `<span class="cp-upload-icon"><i class="fa-solid ${isDocument ? 'fa-file-lines' : 'fa-image'}" aria-hidden="true"></i></span>`
      : `<img src="${escapeHtml(url)}" alt="" loading="lazy">`;
    return `
      <li class="cp-upload-row" data-upload-media="${escapeHtml(mediaId)}">
        ${preview}
        <div class="cp-upload-meta">
          <strong>${escapeHtml(cleanText(upload.caption) || cleanText(upload.file_name) || 'Shared file')}</strong>
          <span>${escapeHtml(formatUploadDate(upload.uploaded_at))}</span>
        </div>
        ${isPreviewMode() ? '' : `<button type="button" class="cp-upload-remove" data-withdraw-upload="${escapeHtml(mediaId)}" title="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_95fc1f316a2ff0","Remove from your portal") ?? "Remove from your portal")}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}
      </li>
    `;
  }
  function formatUploadDate(value){
    const raw = cleanText(value);
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // ── Punch lists ───────────────────────────────────────────────────────────
  // The customer authors the list, signs that it is complete, the team works
  // it, then the customer signs that it is done. Every string here comes from
  // the server-resolved `labels` block — "punch list" is not universal, so
  // nothing user-facing is hardcoded.
  function punchLists(payload = activeProjectPayload()){
    const lists = resources(payload).punch_lists;
    return Array.isArray(lists) ? lists : [];
  }
  function punchPanel(payload = activeProjectPayload()){
    const lists = punchLists(payload);
    if (!lists.length) return `<div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8c81124e22a7c7","There is nothing for you to review right now.") ?? "There is nothing for you to review right now.")}</div>`;
    return `<section class="cp-punch-lists">${lists.map(punchCard).join('')}</section>`;
  }
  function punchCard(list = {}){
    const labels = list.labels || {};
    const state_ = cleanText(list.state) || 'requested';
    const items = Array.isArray(list.items) ? list.items : [];
    const readOnly = isPreviewMode();
    const heading = state_ === 'work_complete'
      ? cleanText(labels.work_complete_title)
      : cleanText(list.title) || cleanText(labels.request_title);
    const body = state_ === 'requested' ? cleanText(labels.request_body)
      : state_ === 'submitted' ? cleanText(labels.submitted_note)
        : state_ === 'work_complete' ? cleanText(labels.work_complete_body)
          : cleanText(labels.accepted_note);
    return `
      <article class="cp-punch" data-punch-id="${escapeHtml(cleanText(list.id))}" data-punch-state="${escapeHtml(state_)}">
        <header class="cp-punch-head">
          <div>
            <h2>${escapeHtml(heading)}</h2>
            ${body ? `<p>${escapeHtml(body)}</p>` : ''}
          </div>
          <span class="cp-punch-state cp-punch-state-${escapeHtml(state_)}">${escapeHtml(punchStateLabel(state_, labels))}</span>
        </header>
        ${punchMetaHtml(list)}
        ${items.length ? `<ul class="cp-punch-items">${items.map((item) => punchItemHtml(item, list)).join('')}</ul>`
          : `<div class="cp-empty">${escapeHtml(cleanText(labels.empty_items) || 'You have not added anything yet.')}</div>`}
        ${list.can_add_items && !readOnly ? punchAddFormHtml(list, items) : ''}
        ${punchActionsHtml(list, readOnly)}
      </article>
    `;
  }
  /** Progress / sign-off meta under the card header, varying by state. */
  function punchMetaHtml(list = {}){
    const state_ = cleanText(list.state);
    const total = Number(list.item_count) || 0;
    const done = Number(list.completed_count) || 0;
    const parts = [];
    if (state_ === 'submitted' || state_ === 'work_complete') {
      if (total) parts.push(`${done} of ${total} item${total === 1 ? '' : 's'} completed`);
      if (cleanText(list.submitted_by)) parts.push(`Submitted by ${cleanText(list.submitted_by)}${formatUploadDate(list.submitted_at) ? ` on ${formatUploadDate(list.submitted_at)}` : ''}`);
    }
    if (state_ === 'accepted' && cleanText(list.accepted_by)) {
      parts.push(`Signed off by ${cleanText(list.accepted_by)}${formatUploadDate(list.accepted_at) ? ` on ${formatUploadDate(list.accepted_at)}` : ''}`);
    }
    if (!parts.length) return '';
    return `<p class="cp-punch-meta">${parts.map((part) => escapeHtml(part)).join(' · ')}</p>`;
  }
  /**
   * The add form carries the whole item — title, an optional note, and any
   * photos or voice notes — so the customer describes the issue in one go
   * instead of creating a bare title and decorating it afterwards.
   */
  function punchAddFormHtml(list = {}, items = []){
    const listId = escapeHtml(cleanText(list.id));
    return `
      <form class="cp-punch-add" data-punch-add="${listId}">
        <div class="cp-punch-add-row">
          <input type="text" data-punch-title placeholder="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3258349622fb52","What still needs attention?") ?? "What still needs attention?")}" maxlength="200" required>
          <button type="submit" data-punch-add-submit>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_c807a71e1c06f5","Add") ?? "Add")}</button>
        </div>
        <textarea data-punch-note placeholder="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_482a59f0ab071d","Add a note — what and where, so we know exactly what you mean") ?? "Add a note — what and where, so we know exactly what you mean")}" maxlength="2000" rows="2" hidden></textarea>
        <div class="cp-punch-pending" data-punch-pending hidden></div>
        <div class="cp-punch-add-extras">
          <button type="button" class="cp-punch-extra" data-punch-note-toggle><i class="fa-solid fa-align-left" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_aaa2ee703d7129"," Note") ?? " Note")}</button>
          <label class="cp-punch-extra">
            <i class="fa-solid fa-camera" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_41e6541f249367"," Photo\n            ") ?? " Photo\n            ")}<input type="file" accept="image/*,video/*" data-punch-add-media multiple hidden>
          </label>
          <button type="button" class="cp-punch-extra" data-punch-add-audio><i class="fa-solid fa-microphone" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e4d3be6cbd9935"," Voice note") ?? " Voice note")}</button>
        </div>
        ${list.max_items ? `<p class="cp-punch-hint">${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_c0b9222208da40",`${v0} of ${v1} items`,{v0,v1}) ?? `${v0} of ${v1} items`)(items.length,list.max_items)}</p>` : ''}
      </form>
    `;
  }
  function punchStateLabel(state_, labels = {}){
    const noun = cleanText(labels.noun) || 'list';
    if (state_ === 'submitted') return 'With your team';
    if (state_ === 'work_complete') return 'Ready for your review';
    if (state_ === 'accepted') return 'Signed off';
    return `Your ${noun}`;
  }
  function punchAttachmentHtml(attachment = {}){
    const kind = cleanText(attachment.kind);
    const mediaId = cleanText(attachment.media_id);
    const mediaUrl = mediaId && api?.customerPortals?.publicMediaUrl
      ? api.customerPortals.publicMediaUrl(activePortalUuid(), mediaId, { preview: isPreviewMode() })
      : '';
    if (kind === 'photo' && mediaUrl) {
      return `<span class="cp-punch-thumb"><img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(cleanText(attachment.file_name) || 'Photo')}" loading="lazy"></span>`;
    }
    if (kind === 'audio' && mediaUrl) {
      return `<audio class="cp-punch-audio" controls preload="none" src="${escapeHtml(mediaUrl)}"></audio>`;
    }
    const icon = kind === 'video' ? 'fa-film' : kind === 'audio' ? 'fa-microphone' : 'fa-paperclip';
    const label = kind === 'video' ? 'Video' : kind === 'audio' ? 'Voice note' : (cleanText(attachment.file_name) || 'File');
    return `<span class="cp-punch-file"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeHtml(label)}</span>`;
  }
  function punchItemHtml(item = {}, list = {}){
    const done = item.completed === true;
    // A completed item is the company's record of finished work — the customer
    // affordances (attach, record, remove) come off rather than sit there and
    // bounce with a server error.
    const editable = list.can_edit_items === true && !isPreviewMode() && !done;
    const requiresPhoto = list.require_photo === true;
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const hasPhoto = attachments.some((attachment) => ['photo', 'video'].includes(cleanText(attachment.kind)));
    const itemId = escapeHtml(cleanText(item.id));
    const description = cleanText(item.description);
    const note = cleanText(item.note);
    return `
      <li class="cp-punch-item${done ? ' done' : ''}" data-punch-item="${itemId}">
        <span class="cp-punch-check" aria-hidden="true"><i class="fa-solid ${done ? 'fa-circle-check' : 'fa-circle'}"></i></span>
        <div class="cp-punch-item-body">
          <strong>${escapeHtml(cleanText(item.title))}</strong>
          ${description ? `<p>${escapeHtml(description)}</p>` : ''}
          ${note && note !== description ? `<p>${escapeHtml(note)}</p>` : ''}
          ${attachments.length ? `<div class="cp-punch-media">${attachments.map(punchAttachmentHtml).join('')}</div>` : ''}
          ${requiresPhoto && !hasPhoto && editable ? `<span class="cp-punch-needs">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_dfee3e11e94a69","Photo required") ?? "Photo required")}</span>` : ''}
          ${done ? `<span class="cp-punch-done-tag">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ade220f511614f","Completed by your project team") ?? "Completed by your project team")}</span>` : ''}
        </div>
        ${editable ? `
          <div class="cp-punch-item-tools">
            <label class="cp-punch-tool" title="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8d4c4c8ca31676","Attach a photo or video") ?? "Attach a photo or video")}">
              <i class="fa-solid fa-camera" aria-hidden="true"></i>
              <input type="file" accept="image/*,video/*" data-punch-evidence="${itemId}" hidden>
            </label>
            <button type="button" class="cp-punch-tool" data-punch-voice="${itemId}" title="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_bb95b36b4a2d24","Record a voice note") ?? "Record a voice note")}"><i class="fa-solid fa-microphone" aria-hidden="true"></i></button>
            <button type="button" class="cp-punch-tool cp-punch-tool-remove" data-punch-remove="${itemId}" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_79a02ecd535f66","Remove item") ?? "Remove item")}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
          </div>
        ` : ''}
      </li>
    `;
  }
  function punchActionsHtml(list = {}, readOnly){
    if (readOnly) return '';
    const labels = list.labels || {};
    const state_ = cleanText(list.state);
    if (state_ === 'requested') {
      return `<div class="cp-punch-actions">
        <button type="button" class="cp-punch-primary" data-punch-submit="${escapeHtml(cleanText(list.id))}">${escapeHtml(cleanText(labels.submit_cta) || 'Submit')}</button>
        <p class="cp-punch-hint">${escapeHtml(cleanText(labels.submit_confirm))}</p>
      </div>`;
    }
    if (state_ === 'work_complete') {
      return `<div class="cp-punch-actions">
        <button type="button" class="cp-punch-primary" data-punch-accept="${escapeHtml(cleanText(list.id))}">${escapeHtml(cleanText(labels.accept_cta) || 'Confirm')}</button>
        <p class="cp-punch-hint">${escapeHtml(cleanText(labels.accept_confirm))}</p>
      </div>`;
    }
    return '';
  }
  /**
   * Sign-off prompt. Produces the typed-signature payload shape the server
   * stores for a signature, so a punch sign-off and a document signature
   * are the same artifact on the server.
   */
  function promptPunchSignature({ title, body, ctaLabel } = {}){
    return new Promise((resolve) => {
      const node = document.createElement('div');
      node.className = 'cp-sign-modal';
      node.innerHTML = `
        <div class="cp-sign-modal-card cp-punch-sign-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Sign off')}">
          <h2>${escapeHtml(title || 'Sign off')}</h2>
          ${body ? `<p class="cp-sign-body">${escapeHtml(body)}</p>` : ''}
          <label class="cp-sign-field">
            <span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_47b529f4d0d67c","Sign by typing your full name") ?? "Sign by typing your full name")}</span>
            <input type="text" data-punch-signer maxlength="120" autocomplete="name" placeholder="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_2d2dbe7ed3c8d7","Your full name") ?? "Your full name")}">
          </label>
          <p class="cp-sign-hint"><i class="fa-solid fa-file-signature" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ed127afed23720"," Typing your name here acts as your electronic signature.") ?? " Typing your name here acts as your electronic signature.")}</p>
          <div class="cp-sign-actions">
            <button type="button" data-punch-sign-cancel>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="cp-punch-primary" data-punch-sign-confirm disabled>${escapeHtml(ctaLabel || 'Sign & confirm')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(node);
      const field = node.querySelector('[data-punch-signer]');
      const confirm = node.querySelector('[data-punch-sign-confirm]');
      if (field && cleanText(state.signatureName)) field.value = cleanText(state.signatureName);
      const sync = () => { if (confirm) confirm.disabled = !cleanText(field?.value); };
      sync();
      field?.focus();
      field?.select?.();
      const finish = (value) => { node.remove(); resolve(value); };
      const sign = () => {
        const name = cleanText(field?.value);
        if (!name) { field?.focus(); return; }
        state.signatureName = name;
        finish({ type: 'typed', text: name, style: 'style-classic', signer_name: name });
      };
      field?.addEventListener('input', sync);
      field?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); sign(); }
        if (event.key === 'Escape') finish(null);
      });
      node.addEventListener('click', (event) => {
        if (event.target === node || event.target.closest('[data-punch-sign-cancel]')) finish(null);
        if (event.target.closest('[data-punch-sign-confirm]')) sign();
      });
    });
  }
  /** Record a voice note via the shared audio-notes library; resolves a File. */
  async function recordPunchVoiceNote(){
    const recorder = window.FirstMateAudioNotes;
    if (!recorder?.record) {
      showPortalToast('Audio recording is not available in this browser.');
      return null;
    }
    try {
      const result = await recorder.record({ title: (globalThis.PlatformLanguage?.text("customer-portal","m_bb95b36b4a2d24","Record a voice note") ?? "Record a voice note") });
      return result?.file || null;
    } catch (error) {
      const message = cleanText(error?.message);
      // A deliberate cancel is not an error worth toasting about.
      if (message && !/cancelled/i.test(message)) showPortalToast(message);
      return null;
    }
  }
  function bindPunchControls(scope){
    scope.querySelectorAll('[data-punch-add]').forEach((form) => {
      const listId = cleanText(form.dataset.punchAdd);
      const titleField = form.querySelector('[data-punch-title]');
      const noteField = form.querySelector('[data-punch-note]');
      const pendingMount = form.querySelector('[data-punch-pending]');
      const submitBtn = form.querySelector('[data-punch-add-submit]');
      // Files chosen before the item exists; uploaded right after creation.
      const pending = [];
      const renderPending = () => {
        if (!pendingMount) return;
        pendingMount.hidden = !pending.length;
        pendingMount.innerHTML = pending.map((file, index) => {
          const isAudio = (file.type || '').startsWith('audio/');
          const label = isAudio ? 'Voice note' : cleanText(file.name) || 'Photo';
          return `<span class="cp-punch-chip"><i class="fa-solid ${isAudio ? 'fa-microphone' : 'fa-image'}" aria-hidden="true"></i>${escapeHtml(label)}<button type="button" data-punch-chip-remove="${index}" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3ea0f07c7208c2","Remove attachment") ?? "Remove attachment")}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
        }).join('');
      };
      pendingMount?.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-punch-chip-remove]');
        if (!remove) return;
        pending.splice(Number(remove.dataset.punchChipRemove), 1);
        renderPending();
      });
      form.querySelector('[data-punch-note-toggle]')?.addEventListener('click', () => {
        if (!noteField) return;
        noteField.hidden = !noteField.hidden;
        if (!noteField.hidden) noteField.focus();
      });
      form.querySelector('[data-punch-add-media]')?.addEventListener('change', (event) => {
        Array.from(event.target.files || []).forEach((file) => pending.push(file));
        event.target.value = '';
        renderPending();
      });
      form.querySelector('[data-punch-add-audio]')?.addEventListener('click', async () => {
        const file = await recordPunchVoiceNote();
        if (file) { pending.push(file); renderPending(); }
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const title = cleanText(titleField?.value);
        if (!title) return;
        const note = cleanText(noteField?.value);
        if (submitBtn) submitBtn.disabled = true;
        try {
          const created = await api.customerPortals.publicAddChecklistItem(
            activePortalUuid(),
            listId,
            note ? { title, description: note } : { title }
          );
          const itemId = cleanText(created?.item?.id || created?.id);
          if (itemId) {
            for (const file of pending.splice(0)) {
              try {
                await api.customerPortals.publicAttachChecklistEvidence(activePortalUuid(), listId, itemId, file);
              } catch (error) {
                showPortalToast(cleanText(error?.message) || 'One attachment could not be uploaded.');
              }
            }
          }
          await refreshPortalPayload();
        } catch (error) {
          if (submitBtn) submitBtn.disabled = false;
          showPortalToast(cleanText(error?.message) || 'That item could not be added.');
        }
      });
    });
    scope.querySelectorAll('[data-punch-voice]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const listId = cleanText(btn.closest('[data-punch-id]')?.dataset.punchId);
        const file = await recordPunchVoiceNote();
        if (!file) return;
        btn.disabled = true;
        try {
          await api.customerPortals.publicAttachChecklistEvidence(activePortalUuid(), listId, cleanText(btn.dataset.punchVoice), file);
          await refreshPortalPayload();
        } catch (error) {
          btn.disabled = false;
          showPortalToast(cleanText(error?.message) || 'That voice note could not be attached.');
        }
      });
    });
    scope.querySelectorAll('[data-punch-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const listId = cleanText(btn.closest('[data-punch-id]')?.dataset.punchId);
        try {
          await api.customerPortals.publicRemoveChecklistItem(activePortalUuid(), listId, cleanText(btn.dataset.punchRemove));
          await refreshPortalPayload();
        } catch (error) {
          showPortalToast(cleanText(error?.message) || 'That item could not be removed.');
        }
      });
    });
    scope.querySelectorAll('[data-punch-evidence]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const listId = cleanText(input.closest('[data-punch-id]')?.dataset.punchId);
        input.disabled = true;
        try {
          await api.customerPortals.publicAttachChecklistEvidence(activePortalUuid(), listId, cleanText(input.dataset.punchEvidence), file);
          await refreshPortalPayload();
        } catch (error) {
          showPortalToast(cleanText(error?.message) || 'That photo could not be attached.');
        } finally {
          input.disabled = false;
          input.value = '';
        }
      });
    });
    scope.querySelectorAll('[data-punch-submit]').forEach((btn) => {
      btn.addEventListener('click', () => runPunchSignOff(btn, 'submit'));
    });
    scope.querySelectorAll('[data-punch-accept]').forEach((btn) => {
      btn.addEventListener('click', () => runPunchSignOff(btn, 'accept'));
    });
  }
  async function runPunchSignOff(btn, mode){
    if (blockPreviewAction('signing')) return;
    const listId = cleanText(mode === 'submit' ? btn.dataset.punchSubmit : btn.dataset.punchAccept);
    const list = punchLists().find((entry) => cleanText(entry.id) === listId) || {};
    const labels = list.labels || {};
    const needsSignature = mode === 'submit' ? list.requires_submit_signature === true : list.requires_accept_signature === true;
    const cta = cleanText(mode === 'submit' ? labels.submit_cta : labels.accept_cta) || 'Confirm';
    const confirmText = cleanText(mode === 'submit' ? labels.submit_confirm : labels.accept_confirm);

    let signature = null;
    if (needsSignature) {
      // The confirm copy explains what the signature commits to — it belongs in
      // the dialog, not in a bare name prompt.
      signature = await promptPunchSignature({ title: cta, body: confirmText, ctaLabel: cta });
      if (!signature) return;
    } else if (confirmText && !window.confirm(confirmText)) {
      return;
    }
    btn.disabled = true;
    try {
      if (mode === 'submit') await api.customerPortals.publicSubmitPunchList(activePortalUuid(), listId, signature);
      else await api.customerPortals.publicAcceptPunchList(activePortalUuid(), listId, signature);
      await refreshPortalPayload();
      showPortalToast(cleanText(mode === 'submit' ? labels.submitted_note : labels.accepted_note) || 'Thank you.');
    } catch (error) {
      btn.disabled = false;
      showPortalToast(cleanText(error?.message) || 'That could not be saved just now.');
    }
  }
  // The customer's own files, distinct from the Documents tab (which is what
  // the business shared with them).
  function myFilesPanel(){
    return `
      <section class="cp-panel">
        ${customerUploadSection('document')}
        ${customerUploadSection('photo')}
      </section>
    `;
  }
  function bindCustomerUploadControls(scope){
    scope.querySelectorAll('[data-upload-kind]').forEach((section) => {
      const input = section.querySelector('[data-upload-input]');
      const status = section.querySelector('[data-upload-status]');
      const captionField = section.querySelector('[data-upload-caption]');
      if (input) {
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const setStatus = (text) => { if (status) status.textContent = cleanText(text); };
          setStatus('Uploading...');
          input.disabled = true;
          try {
            await api.customerPortals.publicUpload(activePortalUuid(), file, {
              caption: cleanText(captionField?.value)
            });
            await refreshPortalPayload();
            showPortalToast('Thanks — we received your file.');
          } catch (error) {
            // Server-side rejections (type, size, quota, permission) surface
            // verbatim: the client never decides whether an upload is allowed.
            setStatus('');
            showPortalToast(cleanText(error?.message) || 'That file could not be uploaded.');
          } finally {
            input.disabled = false;
            input.value = '';
          }
        });
      }
      section.querySelectorAll('[data-withdraw-upload]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const mediaId = cleanText(btn.dataset.withdrawUpload);
          if (!mediaId) return;
          if (!window.confirm((globalThis.PlatformLanguage?.text("customer-portal","m_c14c496968828b","Remove this file from your portal? Your team will still have the copy you sent.") ?? "Remove this file from your portal? Your team will still have the copy you sent."))) return;
          btn.disabled = true;
          try {
            await api.customerPortals.publicWithdrawUpload(activePortalUuid(), mediaId);
            await refreshPortalPayload();
          } catch (error) {
            btn.disabled = false;
            showPortalToast(cleanText(error?.message) || 'That file could not be removed.');
          }
        });
      });
    });
  }
  function bindMediaCommentForm(scope){
    const form = scope.querySelector('[data-comment-form]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const mediaId = cleanText(form.dataset.commentForm);
      const field = form.querySelector('[data-comment-body]');
      const body = cleanText(field?.value);
      if (!body) return;
      const submit = form.querySelector('.cp-comment-submit');
      if (submit) submit.disabled = true;
      try {
        await api.customerPortals.publicAddMediaComment(activePortalUuid(), mediaId, body);
        if (field) field.value = '';
        await refreshPortalPayload();
        // The modal is rebuilt from the refreshed payload so the new comment
        // appears without closing the photo the customer is looking at.
        const index = state.activeMediaIndex;
        scope.remove();
        openMedia(index);
      } catch (error) {
        showPortalToast(cleanText(error?.message) || 'That comment could not be posted.');
        if (submit) submit.disabled = false;
      }
    });
  }
  // ── Photo comments ────────────────────────────────────────────────────────
  function mediaCommentsFor(mediaId){
    const comments = Array.isArray(activeProjectPayload().media_comments) ? activeProjectPayload().media_comments : [];
    return comments.filter((comment) => cleanText(comment.media_id) === cleanText(mediaId));
  }
  function mediaCommentsHtml(mediaId){
    const settings = portalSettings();
    const enabled = settings.comments?.photos === true;
    const comments = mediaCommentsFor(mediaId);
    if (!enabled && !comments.length) return '';
    return `
      <div class="cp-media-comments" data-comments-for="${escapeHtml(cleanText(mediaId))}">
        <h3>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e54fc1b3a14807","Comments") ?? "Comments")}</h3>
        ${comments.length ? `<ul>${comments.map((comment) => `
          <li>
            <strong>${escapeHtml(cleanText(comment.author) || 'You')}</strong>
            <p>${escapeHtml(cleanText(comment.body))}</p>
            <span>${escapeHtml(formatUploadDate(comment.created_at))}</span>
          </li>
        `).join('')}</ul>` : `<p class="cp-media-comments-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_6daba3159863bd","No comments yet.") ?? "No comments yet.")}</p>`}
        ${enabled && !isPreviewMode() ? `
          <form class="cp-comment-form" data-comment-form="${escapeHtml(cleanText(mediaId))}">
            <textarea rows="2" maxlength="2000" data-comment-body placeholder="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5f653f8674d42f","Add a note about this photo") ?? "Add a note about this photo")}"></textarea>
            <button type="submit" class="cp-comment-submit">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_a1fae7010dc311","Post") ?? "Post")}</button>
          </form>
        ` : ''}
      </div>
    `;
  }
  function scheduleEventMeta(event = {}){
    const category = cleanText(event.category || 'event').toLowerCase();
    const map = {
      appointment: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_5a654ad9b6d2e3","Appointment") ?? "Appointment"), icon: 'calendar' },
      work: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_9acd909e2fe732","Project work") ?? "Project work"), icon: 'work' },
      delivery: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_b73185deef6d79","Delivery") ?? "Delivery"), icon: 'delivery' },
      completion: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_bbc23b96fbceb8","Estimated completion") ?? "Estimated completion"), icon: 'finish' },
      equipment: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_2813f320a63b94","Equipment") ?? "Equipment"), icon: 'equipment' },
      event: { label: (globalThis.PlatformLanguage?.text("customer-portal","m_d0a9ffb325f8e6","Schedule item") ?? "Schedule item"), icon: 'calendar' }
    };
    return map[category] || map.event;
  }
  function scheduleIcon(name = 'calendar'){
    const paths = {
      calendar: '<rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M16 3v4M8 3v4M3 10h18"></path><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"></path>',
      work: '<path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0-.6-5.4Z"></path>',
      delivery: '<path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"></path><circle cx="7" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle>',
      finish: '<path d="M5 21V4m0 1h12l-2.5 4L17 13H5"></path><path d="m9 8 2 2 4-4"></path>',
      equipment: '<path d="M4 15h16v4H4zM7 15V8h10v7M9 8V5h6v3"></path><circle cx="8" cy="20" r="1"></circle><circle cx="16" cy="20" r="1"></circle>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.calendar}</svg>`;
  }
  function scheduleDateParts(value){
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { month:'TBD', day:'--', weekday:'' };
    return {
      month: date.toLocaleDateString(undefined, { month:'short' }).toUpperCase(),
      day: date.toLocaleDateString(undefined, { day:'2-digit' }),
      weekday: date.toLocaleDateString(undefined, { weekday:'short' })
    };
  }
  function scheduleSameDay(first, second){
    return first.getFullYear() === second.getFullYear()
      && first.getMonth() === second.getMonth()
      && first.getDate() === second.getDate();
  }
  function scheduleInclusiveEnd(event = {}){
    const start = new Date(event.start_at || event.start || '');
    const end = new Date(event.end_at || event.end || '');
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
    return event.all_day === true ? new Date(end.getTime() - 1) : end;
  }
  function scheduleEventTiming(event = {}){
    const start = new Date(event.start_at || event.start || '');
    const end = new Date(event.end_at || event.end || '');
    if (!Number.isFinite(start.getTime())) return 'Date to be confirmed';
    const allDay = event.all_day === true;
    const inclusiveEnd = scheduleInclusiveEnd(event);
    const sameDate = inclusiveEnd ? scheduleSameDay(start, inclusiveEnd) : scheduleSameDay(start, end);
    const date = start.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    if (allDay) {
      if (inclusiveEnd && !sameDate) {
        return `${date} through ${inclusiveEnd.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' })}`;
      }
      return date;
    }
    const startTime = start.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    if (sameDate) return `${date} · ${startTime}–${end.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' })}`;
    return `${date} · ${startTime}`;
  }
  function scheduleStatus(event = {}){
    const status = cleanText(event.status || 'scheduled').toLowerCase();
    if (['complete', 'completed', 'done'].includes(status)) return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_3c4d2141b2fa1c","Completed") ?? "Completed"), className:'complete' };
    if (['cancelled', 'canceled'].includes(status)) return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_9863f11d60b2fa","Cancelled") ?? "Cancelled"), className:'cancelled' };
    if (cleanText(event.category).toLowerCase() === 'completion') return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_849879a8ce169d","Estimated") ?? "Estimated"), className:'estimated' };
    if (status === 'confirmed') return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_2ac28976b8db5d","Confirmed") ?? "Confirmed"), className:'confirmed' };
    const end = new Date(event.end_at || event.start_at || '');
    if (Number.isFinite(end.getTime()) && end.getTime() < Date.now()) return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_3c4d2141b2fa1c","Completed") ?? "Completed"), className:'complete' };
    return { label:(globalThis.PlatformLanguage?.text("customer-portal","m_6abe57e6a307d5","Scheduled") ?? "Scheduled"), className:'scheduled' };
  }
  function scheduleEventCard(event = {}, index = 0){
    const meta = scheduleEventMeta(event);
    const date = scheduleDateParts(event.start_at || event.start);
    const status = scheduleStatus(event);
    const start = new Date(event.start_at || event.start || '');
    const end = new Date(event.end_at || event.end || '');
    const showEstimate = event.is_estimate === true && Number.isFinite(end.getTime()) && end > start;
    const estimateEnd = showEstimate && event.all_day === true ? new Date(end.getTime() - 1) : end;
    const customerNote = cleanText(event.customer_description);
    const crewName = cleanText(event.crew_name);
    const hasCustomerDetails = !!(customerNote || crewName);
    const schedulingPolicy = event.customer_scheduling && typeof event.customer_scheduling === 'object' ? event.customer_scheduling : {};
    const portalScheduling = portalSettings().scheduling || {};
    const portalCanReschedule = portalScheduling.enabled === true && portalScheduling.reschedule === true;
    const canReschedule = portalCanReschedule && schedulingPolicy.enabled === true
      && Array.isArray(schedulingPolicy.actions) && schedulingPolicy.actions.includes('reschedule')
      && Number.isFinite(start.getTime()) && start.getTime() > Date.now()
      && !['cancelled','canceled','completed'].includes(cleanText(event.status).toLowerCase());
    const rescheduleRequest = event.reschedule_request && typeof event.reschedule_request === 'object' ? event.reschedule_request : {};
    const reschedulePending = cleanText(rescheduleRequest.status) === 'pending';
    const requestedDate = new Date(rescheduleRequest.requested_start_at || '');
    const requestedLabel = Number.isFinite(requestedDate.getTime()) ? requestedDate.toLocaleString(undefined, { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    const headerAction = reschedulePending && portalCanReschedule
      ? `<button type="button" class="cp-reschedule-open cancel" data-reschedule-cancel="${escapeHtml(event.id)}" ${state.rescheduleCancelBusyId === cleanText(event.id) ? 'disabled' : ''}><i class="fa-solid ${state.rescheduleCancelBusyId === cleanText(event.id) ? 'fa-circle-notch fa-spin' : 'fa-xmark'}" aria-hidden="true"></i><span>${state.rescheduleCancelBusyId === cleanText(event.id) ? 'Canceling' : 'Cancel request'}</span></button>`
      : canReschedule
        ? `<button type="button" class="cp-reschedule-open" data-reschedule-event="${escapeHtml(event.id)}"><i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_cfdfd98281fe33","Reschedule") ?? "Reschedule")}</span></button>`
        : status.label !== 'Scheduled' ? `<span class="cp-schedule-status ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>` : '';
    const visibleContent = `
      <div class="cp-schedule-event-top">
        <span class="cp-schedule-event-icon">${scheduleIcon(meta.icon)}</span>
        <div><span class="cp-schedule-event-type">${escapeHtml(meta.label)}</span><h3>${escapeHtml(event.title || meta.label)}</h3></div>
        ${headerAction}
      </div>
      <div class="cp-schedule-time">${escapeHtml(scheduleEventTiming(event))}</div>
      ${showEstimate ? `<div class="cp-schedule-estimate"><span>${scheduleIcon('finish')}</span><div><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_bbc23b96fbceb8","Estimated completion") ?? "Estimated completion")}</small><strong>${escapeHtml(estimateEnd.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' }))}</strong></div></div>` : ''}
      ${reschedulePending ? `<div class="cp-reschedule-pending"><i class="fa-solid fa-clock" aria-hidden="true"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_9d34bd5770c394","Change requested") ?? "Change requested")}</strong><small>${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_930abf685ff598",`${v0} · Waiting for your project team`,{v0}) ?? `${v0} · Waiting for your project team`)(escapeHtml(requestedLabel))}</small></span></div>` : ''}
      ${hasCustomerDetails ? `<span class="cp-schedule-expand"><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e8d22a9dc42a20","View details") ?? "View details")}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg></span>` : ''}
    `;
    const card = hasCustomerDetails ? `
      <details class="cp-schedule-event-card expandable">
        <summary>${visibleContent}</summary>
        <div class="cp-schedule-customer-detail">
          ${crewName ? `<div class="cp-schedule-crew"><span>${scheduleIcon('work')}</span><div><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_43067df3130286","Your crew") ?? "Your crew")}</small><strong>${escapeHtml(crewName)}</strong></div></div>` : ''}
          ${customerNote ? `<div class="cp-schedule-note"><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_c363847b614349","Note from your project team") ?? "Note from your project team")}</small><p>${nl2br(customerNote)}</p></div>` : ''}
        </div>
      </details>
    ` : `<div class="cp-schedule-event-card">${visibleContent}</div>`;
    return `
      <article class="cp-schedule-event ${escapeHtml(status.className)}" style="--schedule-index:${index}">
        <div class="cp-schedule-date" aria-label="${escapeHtml(normalizeDate(event.start_at || event.start))}">
          <span>${escapeHtml(date.month)}</span><strong>${escapeHtml(date.day)}</strong><small>${escapeHtml(date.weekday)}</small>
        </div>
        <div class="cp-schedule-event-line" aria-hidden="true"><i></i></div>
        ${card}
      </article>
    `;
  }
  /**
   * Schedule timeline, split at "now".
   *
   * On a job that has been running a while the finished work outnumbers what is
   * coming, and a customer opening Schedule wants to know what happens NEXT.
   * Past items stay one click away rather than pushing the useful part below
   * the fold — collapsed by default, and only when there is enough history to
   * be worth hiding.
   */
  function scheduleTimelineHtml(events){
    if (!events.length) {
      return `
        <div class="cp-schedule-empty">
          <span>${scheduleIcon('calendar')}</span>
          <h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_cf9de2133057c7","No shared schedule items yet") ?? "No shared schedule items yet")}</h2>
          <p>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_f663bd7bdd9738","Your project team will add appointments, work dates, and deliveries here when they are ready to share.") ?? "Your project team will add appointments, work dates, and deliveries here when they are ready to share.")}</p>
        </div>
      `;
    }
    const now = Date.now();
    const isPast = (event) => {
      const start = Date.parse(cleanText(event.start_at || event.start));
      if (!Number.isFinite(start)) return false;
      const minutes = Number(event.duration_minutes) || 0;
      return (start + minutes * 60000) < now;
    };
    const past = events.filter(isPast);
    const upcoming = events.filter((event) => !isPast(event));

    // With only a couple of past items, hiding them costs more than it saves.
    if (past.length < 2) {
      return `<div class="cp-schedule-timeline">${events.map(scheduleEventCard).join('')}</div>`;
    }
    return `
      ${past.length ? `
        <div class="cp-schedule-past">
          <button type="button" class="cp-schedule-past-toggle" data-schedule-past aria-expanded="${state.schedulePastOpen ? 'true' : 'false'}">
            <i class="fa-solid ${state.schedulePastOpen ? 'fa-chevron-down' : 'fa-chevron-right'}" aria-hidden="true"></i>
            <span>${((v2,v3,v4) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_d3ce763a1f0c3c",`${v2} ${v3} completed item${v4}`,{v2,v3,v4}) ?? `${v2} ${v3} completed item${v4}`)(state.schedulePastOpen ? 'Hide' : 'Show',past.length,past.length === 1 ? '' : 's')}</span>
          </button>
          ${state.schedulePastOpen ? `<div class="cp-schedule-timeline is-past">${past.map(scheduleEventCard).join('')}</div>` : ''}
        </div>
      ` : ''}
      ${upcoming.length
        ? `<div class="cp-schedule-timeline">${upcoming.map(scheduleEventCard).join('')}</div>`
        : `<div class="cp-schedule-empty"><h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_7ec6b5fa6e6101","Nothing else is scheduled right now") ?? "Nothing else is scheduled right now")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_d4221c855ab72e","Your project team will add new dates here as they are booked.") ?? "Your project team will add new dates here as they are booked.")}</p></div>`}
    `;
  }
  function scheduleWidget(payload){
    const events = portalScheduleEvents(payload);
    const includesEstimate = events.some((event) => event.is_estimate === true || event.has_estimated_dates === true);
    return `
      <section class="cp-schedule-page">
        <header class="cp-schedule-header">
          <h1>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8aa1e8a45b3645","Your project schedule") ?? "Your project schedule")}</h1>
          <p>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_65859ed0b87a92","Appointments, work dates, deliveries, and milestones shared with you by the project team.") ?? "Appointments, work dates, deliveries, and milestones shared with you by the project team.")}</p>
        </header>
        ${scheduleTimelineHtml(events)}
        ${includesEstimate ? `
          <div class="cp-schedule-disclaimer">
            <span>${scheduleIcon('finish')}</span>
            <p><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_a82b0c04ed7c6d","About estimated dates") ?? "About estimated dates")}</strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3c2ce151ddfa49","Completion dates are estimates and may change as work progresses, materials arrive, or site conditions are evaluated.") ?? "Completion dates are estimates and may change as work progresses, materials arrive, or site conditions are evaluated.")}</p>
          </div>
        ` : ''}
      </section>
    `;
  }
  function rescheduleModalHtml(){
    if (!state.rescheduleModalOpen) return '';
    const event = portalScheduleEvents(activeProjectPayload()).find((entry) => cleanText(entry.id) === cleanText(state.rescheduleEventId)) || {};
    const groups = state.rescheduleSlots.reduce((all, slot) => { const key = cleanText(slot.date) || cleanText(slot.start_at).slice(0,10); (all[key] ||= []).push(slot); return all; }, {});
    const availableDates = Object.keys(groups).sort();
    const selectedDate = availableDates.includes(state.rescheduleSelectedDate) ? state.rescheduleSelectedDate : (availableDates[0] || '');
    const monthKey = /^\d{4}-\d{2}$/.test(state.rescheduleMonth) ? state.rescheduleMonth : selectedDate.slice(0,7);
    const [year, month] = monthKey.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year || new Date().getUTCFullYear(), Math.max(0, (month || 1) - 1), 1));
    const monthLabel = monthStart.toLocaleDateString(undefined, { month:'long', year:'numeric', timeZone:'UTC' });
    const daysInMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = [...Array(monthStart.getUTCDay()).fill(null), ...Array.from({length:daysInMonth}, (_, index) => index + 1)];
    while (cells.length % 7) cells.push(null);
    const selectedSlots = groups[selectedDate] || [];
    const selectedSlot = state.rescheduleSlots.find((slot) => cleanText(slot.start_at) === cleanText(state.rescheduleSelectedStartAt)) || null;
    const selectedInstant = selectedSlot ? new Date(selectedSlot.start_at) : null;
    const selectedSummary = selectedInstant && Number.isFinite(selectedInstant.getTime())
      ? selectedInstant.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
      : '';
    const selectedDay = selectedDate ? new Date(`${selectedDate}T12:00:00Z`) : null;
    const selectedLabel = selectedDay ? selectedDay.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', timeZone:'UTC' }) : 'Select a day';
    const minMonth = availableDates[0]?.slice(0,7) || monthKey;
    const maxMonth = availableDates[availableDates.length - 1]?.slice(0,7) || monthKey;
    const approvalRequired = cleanText(event.customer_scheduling?.reschedule_approval) === 'required';
    return `<div class="cp-reschedule-modal" data-reschedule-modal>
      <div class="cp-reschedule-card" role="dialog" aria-modal="true" aria-labelledby="cp-reschedule-title">
        <header class="cp-reschedule-head"><div><span class="cp-reschedule-kicker">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_a252dca8e10e56","Live availability") ?? "Live availability")}</span><h2 id="cp-reschedule-title">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_b7d09c4268b709","Select a day and time") ?? "Select a day and time")}</h2><p>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_dab29091546ce2",`${v0} is currently ${v1}.`,{v0,v1}) ?? `${v0} is currently ${v1}.`)(escapeHtml(event.title || 'Your appointment'),escapeHtml(scheduleEventTiming(event)))}</p></div><button type="button" data-reschedule-close aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_536cb6c5df6ea4","Close rescheduling") ?? "Close rescheduling")}">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_dd0c616953d455","&times;") ?? "&times;")}</button></header>
        <div class="cp-reschedule-body">
          ${state.rescheduleBusy ? `<div class="cp-reschedule-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_7554582861da00","Checking the team's schedule...") ?? "Checking the team's schedule...")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_a0ddbb329b8073","We account for crew capacity, travel, and existing appointments.") ?? "We account for crew capacity, travel, and existing appointments.")}</span></div>` : ''}
          ${state.rescheduleError ? `<div class="cp-reschedule-error"><i class="fa-solid fa-circle-exclamation"></i><span>${escapeHtml(state.rescheduleError)}</span></div>` : ''}
          ${!state.rescheduleBusy && !state.rescheduleError && !state.rescheduleSlots.length ? `<div class="cp-reschedule-empty"><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_cf5da3d176fd45","No times are currently available.") ?? "No times are currently available.")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_592a85bf276861","Please contact the project team and they will help find a time.") ?? "Please contact the project team and they will help find a time.")}</span></div>` : ''}
          ${availableDates.length ? `<div class="cp-reschedule-picker">
            <section class="cp-reschedule-calendar" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e00042c00a517d","Available appointment days") ?? "Available appointment days")}">
              <div class="cp-reschedule-month"><button type="button" data-reschedule-month="-1" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_72aab2b513b1bb","Previous month") ?? "Previous month")}" ${monthKey <= minMonth ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button><strong>${escapeHtml(monthLabel)}</strong><button type="button" data-reschedule-month="1" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5f5bc76acbb8de","Next month") ?? "Next month")}" ${monthKey >= maxMonth ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div>
              <div class="cp-reschedule-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<span>${day}</span>`).join('')}</div>
              <div class="cp-reschedule-dates">${cells.map((day) => {
                if (!day) return '<span class="blank" aria-hidden="true"></span>';
                const key = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const count = groups[key]?.length || 0;
                return `<button type="button" data-reschedule-date="${key}" class="${key === selectedDate ? 'selected' : ''}" ${count ? '' : 'disabled'} aria-label="${escapeHtml(`${key}, ${count} available ${count === 1 ? 'time' : 'times'}`)}"><strong>${day}</strong>${count ? `<small>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_f8954a5cc7e32f",`${v0} slot${v1}`,{v0,v1}) ?? `${v0} slot${v1}`)(count,count === 1 ? '' : 's')}</small>` : ''}</button>`;
              }).join('')}</div>
            </section>
            <section class="cp-reschedule-times" aria-live="polite"><div class="cp-reschedule-times-head"><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_572a7eddc49d5d","Available times") ?? "Available times")}</span><h3>${escapeHtml(selectedLabel)}</h3><small>${((v6,v7) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_200b9625435cb9",`${v6} option${v7}`,{v6,v7}) ?? `${v6} option${v7}`)(selectedSlots.length,selectedSlots.length === 1 ? '' : 's')}</small></div><div class="cp-reschedule-slots">${selectedSlots.map((slot) => {
              const isSelected = cleanText(slot.start_at) === cleanText(state.rescheduleSelectedStartAt);
              return `<button type="button" class="${isSelected ? 'selected' : ''}" data-reschedule-slot="${escapeHtml(slot.start_at)}" data-reschedule-resource="${escapeHtml(slot.candidates?.[0]?.resource_key || '')}" aria-pressed="${isSelected ? 'true' : 'false'}"><strong>${escapeHtml(new Date(slot.start_at).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' }))}</strong><span>${isSelected ? '<i class="fa-solid fa-check" aria-hidden="true"></i> Selected' : (Number(slot.available_count || 0) > 1 ? `${escapeHtml(slot.available_count)} openings` : 'Available')}</span></button>`;
            }).join('')}</div></section>
          </div>` : ''}
        </div>
        <footer class="cp-reschedule-foot"><div class="cp-reschedule-selection"><i class="fa-solid ${selectedSummary ? 'fa-calendar-check' : 'fa-shield-halved'}" aria-hidden="true"></i><span><small>${selectedSummary ? 'Selected time' : 'No time selected'}</small><strong>${selectedSummary ? escapeHtml(selectedSummary) : 'Choose a time above to continue'}</strong><em>${approvalRequired ? 'Your original time stays reserved until your project team approves the request.' : 'Nothing changes until you confirm.'}</em></span></div><button type="button" data-reschedule-confirm ${selectedSummary && !state.rescheduleBusy ? '' : 'disabled'}>${state.rescheduleBusy ? '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Confirming...' : 'Confirm reschedule'}</button></footer>
      </div>
    </div>`;
  }
  async function openReschedule(eventId){
    if (isPreviewMode()) { showPortalToast('Rescheduling is disabled during preview mode.'); return; }
    state.rescheduleModalOpen = true;
    state.rescheduleEventId = cleanText(eventId);
    state.rescheduleSlots = [];
    state.rescheduleSelectedDate = '';
    state.rescheduleSelectedStartAt = '';
    state.rescheduleSelectedResource = '';
    state.rescheduleMonth = '';
    state.rescheduleError = '';
    state.rescheduleBusy = true;
    render();
    try {
      const result = await api.customerPortals.publicAppointmentAvailability(activePortalUuid(), eventId, { days:30 });
      state.rescheduleSlots = (Array.isArray(result?.slots) ? result.slots : []).filter((slot) => slot?.available === true).slice(0, 240);
      state.rescheduleSelectedDate = cleanText(state.rescheduleSlots[0]?.date) || cleanText(state.rescheduleSlots[0]?.start_at).slice(0,10);
      state.rescheduleMonth = state.rescheduleSelectedDate.slice(0,7);
    } catch (error) {
      state.rescheduleError = cleanText(error?.message) || 'We could not load available times. Please try again.';
    } finally {
      state.rescheduleBusy = false;
      render();
    }
  }
  function selectRescheduleSlot(button){
    if (state.rescheduleBusy) return;
    state.rescheduleSelectedStartAt = cleanText(button.dataset.rescheduleSlot);
    state.rescheduleSelectedResource = cleanText(button.dataset.rescheduleResource);
    state.rescheduleError = '';
    render();
  }
  async function confirmRescheduleSlot(){
    if (state.rescheduleBusy || !state.rescheduleSelectedStartAt) return;
    state.rescheduleBusy = true;
    state.rescheduleError = '';
    render();
    try {
      const portalUuid = activePortalUuid();
      const held = await api.customerPortals.publicHoldAppointment(portalUuid, state.rescheduleEventId, {
        start_at:state.rescheduleSelectedStartAt,
        resource_key:state.rescheduleSelectedResource
      });
      const committed = await api.customerPortals.publicCommitAppointment(portalUuid, state.rescheduleEventId, held?.hold?.id);
      state.rescheduleModalOpen = false;
      state.rescheduleEventId = '';
      state.rescheduleSlots = [];
      state.rescheduleSelectedStartAt = '';
      state.rescheduleSelectedResource = '';
      showPortalToast(committed?.status === 'pending_approval' ? (committed?.message || 'Your appointment change was submitted for review.') : 'Your appointment has been rescheduled.');
      await refreshPortalPayload();
      track(committed?.status === 'pending_approval' ? 'appointment_reschedule_requested' : 'appointment_rescheduled', {});
    } catch (error) {
      state.rescheduleError = cleanText(error?.message) || 'That time is no longer available. Please choose another.';
      state.rescheduleSelectedStartAt = '';
      state.rescheduleSelectedResource = '';
      state.rescheduleBusy = false;
      render();
    }
  }
  async function cancelRescheduleRequest(eventId){
    if (state.rescheduleCancelBusyId) return;
    if (isPreviewMode()) { showPortalToast('Request cancellation is disabled during preview mode.'); return; }
    state.rescheduleCancelBusyId = cleanText(eventId);
    render();
    try {
      await api.customerPortals.publicCancelAppointmentRequest(activePortalUuid(), eventId);
      showPortalToast('Your appointment change request was canceled.');
      await refreshPortalPayload();
      track('appointment_reschedule_request_canceled', {});
    } catch (error) {
      showPortalToast(cleanText(error?.message) || 'We could not cancel that request. Please try again.');
    } finally {
      state.rescheduleCancelBusyId = '';
      render();
    }
  }
  function browserEvidenceBase(){
    const screenInfo = root.screen || {};
    return {
      captured_at: new Date().toISOString(),
      path: location.pathname + location.search,
      href: location.href,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      locale: navigator.language || '',
      languages: Array.isArray(navigator.languages) ? navigator.languages : [],
      device: {
        user_agent: navigator.userAgent || '',
        platform: navigator.platform || '',
        touch_points: Number(navigator.maxTouchPoints || 0)
      },
      viewport: {
        width: root.innerWidth || 0,
        height: root.innerHeight || 0,
        device_pixel_ratio: root.devicePixelRatio || 1,
        screen_width: screenInfo.width || 0,
        screen_height: screenInfo.height || 0
      }
    };
  }
  function browserGeolocation(timeoutMs = 2200){
    if (!navigator.geolocation?.getCurrentPosition) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = root.setTimeout(() => done(null), timeoutMs);
      navigator.geolocation.getCurrentPosition((position) => {
        root.clearTimeout(timer);
        const coords = position.coords || {};
        done({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          altitude: coords.altitude,
          heading: coords.heading,
          speed: coords.speed,
          captured_at: new Date(position.timestamp || Date.now()).toISOString(),
          source: 'browser_geolocation'
        });
      }, () => {
        root.clearTimeout(timer);
        done(null);
      }, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 300000
      });
    });
  }
  async function signatureEvidencePayload(){
    const evidence = browserEvidenceBase();
    const geolocation = await browserGeolocation();
    if (geolocation) evidence.geolocation = geolocation;
    return evidence;
  }
  function withEvidence(payload = {}, evidence = {}){
    return {
      ...payload,
      path: payload.path || location.pathname + location.search,
      href: payload.href || location.href,
      timezone: payload.timezone || evidence.timezone || '',
      locale: payload.locale || evidence.locale || '',
      ...(evidence.geolocation ? { geolocation: evidence.geolocation } : {}),
      evidence,
      metadata: {
        ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        evidence
      }
    };
  }
  function appointmentComplete(appointment){
    if (!appointment) return false;
    const status = cleanText(appointment.status).toLowerCase();
    if (['completed', 'complete', 'done'].includes(status)) return true;
    const start = new Date(appointment.start_at || appointment.start || '');
    return Number.isFinite(start.getTime()) && start.getTime() < Date.now();
  }
  function appointmentSummary(appointment){
    if (!appointment) return 'To be scheduled';
    const when = normalizeDateTime(appointment.start_at || appointment.start);
    const assigned = Array.isArray(appointment.assigned_to) ? appointment.assigned_to.filter(Boolean).join(', ') : '';
    return [when, assigned].filter(Boolean).join(' - ') || cleanText(appointment.status) || 'Scheduled';
  }
  // The tab a document opens in: its document-group tab when the server
  // serves one, otherwise the flat Documents tab.
  function documentTabId(doc){
    const group = cleanText(doc?.presentation?.tab?.id);
    const list = tabs();
    const grouped = list.find((tab) => tab.sourceType === 'document_group' && cleanText(tab.groupId) === group)
      || list.find((tab) => tab.sourceType === 'document_group' && !cleanText(tab.groupId));
    if (grouped) return grouped.id;
    return list.some((tab) => tab.id === 'documents') ? 'documents' : '';
  }
  function documentStep(doc){
    const token = cleanText(doc?.public_token);
    const status = cleanText(doc?.status).toLowerCase();
    // Canceled work has no token, and a declined or expired document asks
    // nothing of the customer.
    if (!token || ['declined', 'expired', 'canceled', 'cancelled', 'void'].includes(status)) return null;
    const title = cleanText(doc?.title) || documentTypeLabel(doc?.document_type);
    const requirement = doc?.signature_requirement && typeof doc.signature_requirement === 'object' ? doc.signature_requirement : {};
    const finished = ['signed', 'completed'].includes(status);
    const needsSignature = requirement.required === true;
    const complete = needsSignature
      ? finished || Number(requirement.pending_count || 0) <= 0
      : finished || status === 'viewed';
    return {
      id: `document:${cleanText(doc?.id) || token}`,
      label: needsSignature ? `Review and sign ${title}` : `Review ${title}`,
      detail: complete ? (needsSignature ? 'Signature received' : documentStatusLabel(status)) : documentStatusLabel(status),
      complete,
      tab: documentTabId(doc),
      documentToken: token
    };
  }
  function overviewSteps(payload, orgName){
    const appointment = portalAppointment(payload);
    const steps = [{
      id: 'appointment',
      label: (globalThis.PlatformLanguage?.text("customer-portal","m_a59fd86ded6b33","On-site Appointment") ?? "On-site Appointment"),
      detail: appointmentSummary(appointment),
      complete: appointmentComplete(appointment),
      tab: 'schedule'
    }];
    const documentSteps = documentList(payload).map(documentStep).filter(Boolean);
    if (!documentSteps.length) {
      steps.push({
        id: 'clear',
        label: 'Nothing needs your attention right now',
        detail: orgName ? `${orgName} will share documents with you here.` : 'Documents shared with you will appear here.',
        complete: false,
        disabled: true
      });
      return steps;
    }
    steps.push(...documentSteps);
    if (documentSteps.every((step) => step.complete)) {
      steps.push({
        id: 'documents_complete',
        label: 'All documents are complete',
        detail: 'Nothing else needs your attention right now.',
        complete: true,
        disabled: true
      });
    }
    return steps;
  }
  function overviewPanel(payload, orgName){
    const steps = overviewSteps(payload, orgName);
    const firstOpen = steps.find((step) => !step.complete && !step.disabled)?.id || '';
    return `
      <aside class="cp-overview" data-cp-overview>
        <div class="cp-overview-head">
          <h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_07731eeca61b2c","Next Steps") ?? "Next Steps")}</h2>
          <span>${steps.filter((step) => step.complete).length}/${steps.length}</span>
        </div>
        <div class="cp-step-list">
          ${steps.map((step) => `
            <button type="button" class="cp-step ${step.complete ? 'complete' : ''} ${step.id === firstOpen ? 'current' : ''}" data-step-id="${escapeHtml(step.id)}" data-step-target="${escapeHtml(step.tab || '')}" data-step-document="${escapeHtml(step.documentToken || '')}" ${step.disabled ? 'disabled' : ''}>
              <span class="cp-step-indicator" aria-hidden="true"></span>
              <span class="cp-step-copy">
                <strong>${escapeHtml(step.label)}</strong>
                <small>${escapeHtml(step.detail || '')}</small>
              </span>
            </button>
          `).join('')}
        </div>
      </aside>
    `;
  }
  function documentsWidget(payload = activeProjectPayload(), { compact = true } = {}){
    const docs = documentList(payload);
    const items = compact ? docs.slice(0, 6) : docs;
    return `
      <section class="cp-widget cp-documents-widget">
        <div class="cp-section-head">
          <h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5d7c7ad6033624","Documents") ?? "Documents")}</h2>
          <span>${docs.length} ${docs.length === 1 ? 'document' : 'documents'}</span>
        </div>
        ${items.length ? `<div class="cp-summary-doc-list">${items.map((doc) => {
          const token = cleanText(doc?.public_token);
          const status = cleanText(doc?.status).toLowerCase();
          const canceled = status === 'canceled' || !token;
          const tabId = documentTabId(doc) || 'documents';
          const title = cleanText(doc?.title) || documentTypeLabel(doc?.document_type);
          const typeLabel = documentTypeLabel(doc?.document_type);
          const statusLabel = documentStatusLabel(status);
          const isSigned = ['signed', 'completed'].includes(status);
          const badgeClass = isSigned
            ? 'signed'
            : (['declined', 'expired', 'canceled', 'cancelled', 'void'].includes(status)
              ? 'canceled'
              : (['sent', 'viewed', 'in_progress'].includes(status) ? 'action' : ''));
          const dateStr = normalizeDate(doc?.signed_at || doc?.completed_at || doc?.sent_at || doc?.updated_at || doc?.created_at);
          const subtitle = [typeLabel, dateStr].filter(Boolean).join(' · ');
          return `
            <button type="button" class="cp-summary-doc-card${canceled ? ' is-canceled' : ''}" ${canceled ? 'disabled aria-disabled="true"' : `data-step-target="${escapeHtml(tabId)}" data-step-document="${escapeHtml(token)}"`}>
              <span class="cp-summary-doc-preview" data-summary-doc-preview="${escapeHtml(token)}" aria-hidden="true">
                <span class="cp-summary-doc-preview-fallback"><i class="fa-regular fa-file-lines"></i></span>
              </span>
              <span class="cp-summary-doc-body">
                <span class="cp-summary-doc-top">
                  <strong class="cp-summary-doc-title">${escapeHtml(title)}</strong>
                  <span class="cp-summary-doc-badge ${badgeClass}">${isSigned ? '<i class="fa-solid fa-check" aria-hidden="true"></i> ' : ''}${escapeHtml(statusLabel)}</span>
                </span>
                ${subtitle ? `<span class="cp-summary-doc-meta">${escapeHtml(subtitle)}</span>` : ''}
                <span class="cp-summary-doc-cta">${isSigned ? 'View signed document' : 'Open document'} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>
              </span>
            </button>
          `;
        }).join('')}</div>` : `<div class="cp-empty">No documents yet.</div>`}
        ${compact && docs.length > items.length ? `<button type="button" class="cp-link-btn" data-tab-target="${escapeHtml(documentTabId(docs[0]) || 'documents')}">View all documents</button>` : ''}
      </section>
    `;
  }
  function mountSummaryDocumentPreviews(){
    const boxes = Array.from(mount.querySelectorAll('[data-summary-doc-preview]'));
    if (!boxes.length || !documentEngineReady()) return;
    boxes.forEach((box) => {
      const token = cleanText(box.dataset.summaryDocPreview);
      if (!token) return;
      const paint = (payload) => {
        if (!box.isConnected) return;
        const snapshot = cpwfObject(cpwfObject(payload).snapshot);
        const resolved = snapshot.resolved_definition || snapshot.definition;
        const pages = cpwfArray(cpwfObject(resolved).pages);
        if (!resolved || !pages.length) return;
        try {
          const firstPageDoc = { ...resolved, pages: pages.slice(0, 1) };
          const paper = root.FMDocModel.paperDimensions(firstPageDoc);
          const widthPx = Math.max(120, (box.clientWidth || 320) - 32);
          const scale = widthPx / ((Number(paper?.w_pt) || 612) * (96 / 72));
          box.innerHTML = '';
          const stageHost = document.createElement('div');
          stageHost.className = 'cp-summary-doc-preview-canvas';
          box.appendChild(stageHost);
          root.FMDocRenderer.render(stageHost, {
            document: firstPageDoc,
            theme: snapshot.theme || null,
            themeContext: { overrides: snapshot.theme_vars || {} },
            mode: 'preview',
            widgetData: snapshot.widget_data || {},
            scale,
            widgetContext: {
              outputs: snapshot.outputs || {}
            }
          });
        } catch (_) {}
      };
      const cached = documentSnapshotCache[token];
      if (cached) {
        if (!cached.error && cached.snapshot) paint(cached);
        return;
      }
      ensureDocumentSnapshot(token, { silent: true }).then((loaded) => {
        if (loaded && !loaded.error && loaded.snapshot) paint(loaded);
      }).catch(() => {});
    });
  }
  function paymentsPanel(documents = [], payload = activeProjectPayload()){
    const paidById = new Map();
    cpwfArray(documents).forEach((document) => cpwfArray(document?.payments).forEach((payment) => {
      const paymentId = cleanText(payment?.id) || `${cleanText(document?.id)}:${cleanText(payment?.output_key)}`;
      if (!paymentId || paidById.has(paymentId)) return;
      paidById.set(paymentId, {
        payment,
        sourceLabel: `${cleanText(document?.title) || 'Document'} ${cleanText(payment?.label) || 'Payment'}`
      });
    }));
    const resourcePayments = cpwfArray(resources(payload).payments);
    resourcePayments.forEach((entry) => {
      if (cleanText(entry?.kind) === 'obligation') return;
      const paymentId = cleanText(entry?.id);
      if (!paymentId || paidById.has(paymentId)) return;
      paidById.set(paymentId, {
        payment: entry,
        sourceLabel: cleanText(entry?.label) || 'Payment'
      });
    });
    const obligations = resourcePayments.filter((entry) => (
      cleanText(entry?.kind) === 'obligation'
      && Number(entry?.amount_remaining_cents ?? entry?.amount_cents) > 0
    ));
    const paid = Array.from(paidById.values()).sort((left, right) => {
      const leftAt = cleanText(left.payment.settled_at || left.payment.received_at || left.payment.paid_at || left.payment.created_at);
      const rightAt = cleanText(right.payment.settled_at || right.payment.received_at || right.payment.paid_at || right.payment.created_at);
      return rightAt.localeCompare(leftAt);
    });
    return `
      <section class="cp-widget cp-payments-panel">
        <div class="cp-section-head">
          <h2>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5842802f6c8cbb","Payments") ?? "Payments")}</h2>
          <span>${obligations.length ? `${obligations.length} open · ` : ''}${((v0,v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_e0c8002adc5c4c",`${v0} past payment${v1}`,{v0,v1}) ?? `${v0} past payment${v1}`)(paid.length,paid.length === 1 ? '' : 's')}</span>
        </div>
        ${obligations.length ? `
          <div class="cp-payment-section">
            <h3>Upcoming &amp; Due Payments</h3>
            <div class="cp-payment-table">
              <div class="head"><span>Status</span><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</span><span></span></div>
              ${obligations.map((item) => {
                const remaining = Number(item.amount_remaining_cents ?? item.amount_cents ?? 0) / 100;
                const status = cleanText(item.status).toLowerCase();
                const dueLabel = item.due_at
                  ? `Due ${normalizeDate(item.due_at)}`
                  : (status === 'overdue' ? 'Overdue' : status === 'invoiced' || status === 'due' ? 'Due now' : status === 'partial' ? 'Partially paid' : 'Scheduled');
                const labelParts = [cleanText(item.label) || 'Payment', cleanText(item.invoice_number) ? `Invoice #${cleanText(item.invoice_number)}` : ''].filter(Boolean);
                const docToken = cleanText(item.document_token);
                return `
                  <div class="row">
                    <span>${escapeHtml(dueLabel)}</span>
                    <strong>${escapeHtml(moneyFormat(remaining))}</strong>
                    <span>${escapeHtml(labelParts.join(' · '))}</span>
                    <span>${docToken ? `<button type="button" class="cp-link-btn" data-pay-document-token="${escapeHtml(docToken)}">${status === 'scheduled' ? 'View document' : 'View &amp; Pay'}</button>` : ''}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}
        <div class="cp-payment-section">
          <h3>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e9bdfa04394498","Past Payments") ?? "Past Payments")}</h3>
          ${paid.length ? `
            <div class="cp-payment-table">
              <div class="head"><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_2a0b11100c22a4","Date") ?? "Date")}</span><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</span><span></span></div>
              ${paid.map(({ payment, sourceLabel }) => {
                const amount = Number(payment.amount_cents || 0) / 100;
                const date = normalizeDate(payment.settled_at || payment.received_at || payment.paid_at || payment.created_at || payment.updated_at) || 'Paid';
                return `
                  <div class="row">
                    <span>${escapeHtml(date)}</span>
                    <strong>${escapeHtml(moneyFormat(amount))}</strong>
                    <span>${escapeHtml(sourceLabel)}</span>
                    <span aria-hidden="true"></span>
                  </div>
                `;
              }).join('')}
            </div>
          ` : `<div class="cp-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_aef512969e5846","Past payments will appear here after payment.") ?? "Past payments will appear here after payment.")}</div>`}
        </div>
      </section>
    `;
  }
  function projectSummaryHeader(displayName, address, contactRows){
    return `
      <section class="cp-project-summary">
        <div>
          <h1 class="cp-title">${escapeHtml(displayName)}</h1>
          ${address ? `<div class="cp-address">${escapeHtml(address)}</div>` : ''}
        </div>
        ${contactRows ? `<aside class="cp-customer-card">${contactRows}</aside>` : ''}
      </section>
    `;
  }
  function bindChecklistPanel(payload = activeProjectPayload()){
    const portalUuid = activePortalUuid(payload);
    if (!portalUuid || isPreviewMode()) return;
    mount.querySelectorAll('[data-cp-checklist]').forEach((card) => {
      const checklistId = cleanText(card.dataset.cpChecklist);
      const checklist = checklistList(payload).find((entry) => cleanText(entry.id) === checklistId);
      if (!checklist) return;
      const busy = async (button, action) => {
        if (button) button.disabled = true;
        try { await action(); }
        catch (error) { showPortalToast(cleanText(error?.message) || 'The checklist could not be updated.'); if (button) button.disabled = false; }
      };
      card.querySelector('[data-cp-checklist-voice]')?.addEventListener('click', (event) => {
        const button = event.currentTarget;
        const voiceMount = card.querySelector('[data-cp-checklist-voice-mount]');
        if (!voiceMount || !root.FirstMateAudioStructure?.recordAndProcess) return showPortalToast('Voice recording is not available.');
        button.disabled = true;
        root.FirstMateAudioStructure.recordAndProcess({
          mount:voiceMount,
          url:api.customerPortals.publicChecklistVoiceUrl(portalUuid, checklistId),
          processingLabel:'Applying your checklist update…'
        }).then(async (result) => {
          const applied = Array.isArray(result?.data?.applied) ? result.data.applied.length : 0;
          const rejected = Array.isArray(result?.data?.rejected) ? result.data.rejected.length : 0;
          showPortalToast(`${applied} checklist change${applied === 1 ? '' : 's'} applied${rejected ? `; ${rejected} need attention` : ''}.`);
          await refreshPortalPayload();
        }).catch((error) => {
          if (!/cancelled/i.test(cleanText(error?.message))) showPortalToast(cleanText(error?.message) || 'The voice update failed.');
          button.disabled = false;
        });
      });
      card.querySelector('[data-cp-checklist-add]')?.addEventListener('click', (event) => busy(event.currentTarget, async () => {
        const title = cleanText(card.querySelector('[data-cp-checklist-add-input]')?.value);
        if (!title) throw new Error('Enter a checklist item.');
        await api.customerPortals.publicAddChecklistItem(portalUuid, checklistId, { title });
        track('checklist_item_added', { checklist_id:checklistId });
        await refreshPortalPayload();
      }));
      card.querySelectorAll('[data-cp-checklist-item]').forEach((row) => {
        const itemId = cleanText(row.dataset.cpChecklistItem);
        const item = (Array.isArray(checklist.items) ? checklist.items : []).find((entry) => cleanText(entry.id) === itemId);
        if (!item) return;
        row.querySelector('[data-cp-checklist-toggle]')?.addEventListener('click', (event) => busy(event.currentTarget, async () => {
          await api.customerPortals.publicUpdateChecklistItem(portalUuid, checklistId, itemId, { completed:!item.completed });
          track('checklist_item_updated', { checklist_id:checklistId, metadata:{ checklist_item_id:itemId, completed:!item.completed } });
          await refreshPortalPayload();
        }));
        row.querySelectorAll('[data-cp-checklist-rating]').forEach((button) => button.addEventListener('click', () => busy(button, async () => {
          const value = cleanText(button.dataset.cpChecklistRating);
          const note = cleanText(row.querySelector('[data-cp-checklist-note]')?.value);
          if (value === 'bad' && !note) throw new Error('Add a note before choosing Needs work.');
          await api.customerPortals.publicUpdateChecklistItem(portalUuid, checklistId, itemId, { rating:item.rating === value ? '' : value, note });
          track('checklist_item_updated', { checklist_id:checklistId, metadata:{ checklist_item_id:itemId, rating:value } });
          await refreshPortalPayload();
        })));
        row.querySelector('[data-cp-checklist-note-save]')?.addEventListener('click', (event) => busy(event.currentTarget, async () => {
          await api.customerPortals.publicUpdateChecklistItem(portalUuid, checklistId, itemId, { note:cleanText(row.querySelector('[data-cp-checklist-note]')?.value) });
          showPortalToast('Checklist note saved.');
          await refreshPortalPayload();
        }));
        row.querySelector('[data-cp-checklist-rename]')?.addEventListener('click', (event) => busy(event.currentTarget, async () => {
          const title = cleanText(window.prompt((globalThis.PlatformLanguage?.text("customer-portal","m_5d0e8d2336b9f7","Rename checklist item") ?? "Rename checklist item"), item.title || ''));
          if (!title || title === item.title) return;
          await api.customerPortals.publicUpdateChecklistItem(portalUuid, checklistId, itemId, { title });
          await refreshPortalPayload();
        }));
        row.querySelector('[data-cp-checklist-remove]')?.addEventListener('click', (event) => busy(event.currentTarget, async () => {
          if (!window.confirm(((v0) => globalThis.PlatformLanguage?.text("customer-portal","m_99a5678d0457d5",`Remove "${v0}" from this checklist?`,{v0}) ?? `Remove "${v0}" from this checklist?`)(item.title))) return;
          await api.customerPortals.publicRemoveChecklistItem(portalUuid, checklistId, itemId);
          await refreshPortalPayload();
        }));
        row.querySelectorAll('[data-cp-checklist-evidence]').forEach((button) => button.addEventListener('click', () => {
          const input = row.querySelector('[data-cp-checklist-file]');
          if (!input) return;
          const kind = cleanText(button.dataset.evidenceKind || 'any');
          input.dataset.requirementId = cleanText(button.dataset.cpChecklistEvidence);
          input.accept = kind === 'photo' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : kind === 'document' ? '.pdf,.doc,.docx,.xls,.xlsx,.txt' : 'image/*,video/*,audio/*,.pdf,.doc,.docx';
          input.click();
        }));
        row.querySelector('[data-cp-checklist-file]')?.addEventListener('change', (event) => busy(event.currentTarget, async () => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (!file) return;
          await api.customerPortals.publicAttachChecklistEvidence(portalUuid, checklistId, itemId, file, input.dataset.requirementId || '');
          track('checklist_evidence_added', { checklist_id:checklistId, metadata:{ checklist_item_id:itemId } });
          await refreshPortalPayload();
        }));
      });
    });
  }
  function sharingState(){
    const active = activeProjectPayload();
    const sharing = active?.sharing || state.payload?.sharing;
    return sharing && typeof sharing === 'object' ? sharing : null;
  }
  function shareDate(value){
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
  }
  function sharePresetLabel(value){
    return ({ full_view:'Full portal view', project_updates:'Project updates', photos_only:'Photos only' })[cleanText(value)] || 'Shared access';
  }
  function shareModalHtml(){
    if (!state.shareModalOpen) return '';
    const sharing = sharingState() || {};
    const shares = Array.isArray(sharing.shares) ? sharing.shares : [];
    const active = shares
      .filter((item) => cleanText(item.status) === 'active')
      .sort((a, b) => {
        if (cleanText(a.id) === cleanText(state.shareCreatedId)) return -1;
        if (cleanText(b.id) === cleanText(state.shareCreatedId)) return 1;
        return cleanText(b.created_at).localeCompare(cleanText(a.created_at));
      });
    const allProjects = projectBundles(state.payload);
    const formOpen = active.length === 0 || state.shareFormOpen;
    return `
      <div class="cp-share-modal" data-share-modal>
        <div class="cp-share-card" role="dialog" aria-modal="true" aria-labelledby="cp-share-title">
          <header class="cp-share-head">
            <div><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_1b25feb43c2ac7","Secure sharing") ?? "Secure sharing")}</span><h2 id="cp-share-title">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ae859d82d60e2f","Share this portal") ?? "Share this portal")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_9a539416db22b5","Create a separate read-only link you can revoke at any time.") ?? "Create a separate read-only link you can revoke at any time.")}</p></div>
            <button type="button" class="cp-icon-btn" data-share-close aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3742924668fb10","Close") ?? "Close")}">×</button>
          </header>
          <section class="cp-share-existing">
            <div class="cp-share-section-title"><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_be36a6c37ec133","Active links") ?? "Active links")}</strong><span>${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_8676752f96a9e1",`${v0} active`,{v0}) ?? `${v0} active`)(active.length)}</span></div>
            ${active.length ? active.map((item) => `
              <article class="cp-share-row${cleanText(item.id) === cleanText(state.shareCreatedId) ? ' created' : ''}">
                <div class="cp-share-row-head">
                  <span class="cp-share-row-icon"><i class="fa-solid fa-user-group" aria-hidden="true"></i></span>
                  <span><strong>${escapeHtml(item.label || 'Shared access')}${cleanText(item.id) === cleanText(state.shareCreatedId) ? `<em>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_96c4ad96a3b2dc","Link ready") ?? "Link ready")}</em>` : ''}</strong><small>${escapeHtml(sharePresetLabel(item.preset))} · ${item.project_ids?.length > 1 ? `${item.project_ids.length} projects` : 'This project'} · ${item.expires_at ? `Expires ${escapeHtml(shareDate(item.expires_at))}` : 'Never expires'}${item.last_viewed_at ? ` · Last opened ${escapeHtml(shareDate(item.last_viewed_at))}` : ''}</small></span>
                  <button type="button" class="danger" data-share-revoke="${escapeHtml(item.id)}">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_45c67f3cceb08b","Revoke") ?? "Revoke")}</button>
                </div>
                ${item.url ? `<div class="cp-share-link-row"><input readonly value="${escapeHtml(item.url)}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_db7262351f2b24",`Link for ${v1}`,{v1}) ?? `Link for ${v1}`)(escapeHtml(item.label || 'shared access'))}"><button type="button" data-share-copy-url="${escapeHtml(item.url)}"><i class="fa-regular fa-copy" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_9302911bb13773","Copy") ?? "Copy")}</button><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_c25cc66b28cc9d","Open") ?? "Open")}</a></div>` : ''}
              </article>
            `).join('') : `<div class="cp-share-empty">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_8ba0c3ca97c22e","No active shared links yet. Create one below.") ?? "No active shared links yet. Create one below.")}</div>`}
          </section>
          <section class="cp-share-new">
            <button type="button" class="cp-share-new-toggle" data-share-form-toggle aria-expanded="${formOpen ? 'true' : 'false'}"><span><i class="fa-solid fa-plus" aria-hidden="true"></i><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_f0961726127fd4","New link") ?? "New link")}</strong></span><i class="fa-solid fa-chevron-${formOpen ? 'up' : 'down'}" aria-hidden="true"></i></button>
            ${formOpen ? `<form class="cp-share-form" data-share-form>
              <div class="cp-share-security"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_37c79388722d91","Every shared link is read-only and can be revoked at any time.") ?? "Every shared link is read-only and can be revoked at any time.")}</span></div>
              <fieldset>
                <legend>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3a40524c98ef0c","What can they see?") ?? "What can they see?")}</legend>
                <div class="cp-share-choice-grid">
                  <label class="cp-share-choice"><input type="radio" name="preset" value="full_view" checked><span><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_4a787b188bf71f","Full portal view") ?? "Full portal view")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_74c1e9e812db22","Home overview, next steps, schedule, photos, and shared checklists") ?? "Home overview, next steps, schedule, photos, and shared checklists")}</small></span></label>
                  <label class="cp-share-choice"><input type="radio" name="preset" value="project_updates"><span><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ca88698f97c379","Project updates") ?? "Project updates")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_54d132dbe479fd","Schedule and project photos only") ?? "Schedule and project photos only")}</small></span></label>
                  <label class="cp-share-choice"><input type="radio" name="preset" value="photos_only"><span><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_a732f0e6f2ff31","Photos only") ?? "Photos only")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_293ea1f0357b3f","Only photos and videos shared by your project team") ?? "Only photos and videos shared by your project team")}</small></span></label>
                </div>
              </fieldset>
              <div class="cp-share-fields">
                <label><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_b7df67ad2e041b","Who is this for?") ?? "Who is this for?")}</span><input name="label" maxlength="80" required></label>
                ${allProjects.length > 1 ? `<label><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_19156e80fc8a6e","Projects") ?? "Projects")}</span><select name="project_scope"><option value="current" selected>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ab9ea00a86d35b","Only this project") ?? "Only this project")}</option><option value="all">${((v0) => globalThis.PlatformLanguage?.htmlText("customer-portal","m_eb7c8d245a5259",`All ${v0} projects`,{v0}) ?? `All ${v0} projects`)(allProjects.length)}</option></select></label>` : ''}
                <label><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_eeb6aeb8f8e837","Link expires") ?? "Link expires")}</span><select name="expires_days"><option value="0" selected>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_35304e673f218d","Never") ?? "Never")}</option><option value="7">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3360960154af20","In 7 days") ?? "In 7 days")}</option><option value="30">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_4f5de1560523f2","In 30 days") ?? "In 30 days")}</option><option value="90">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_6a09d6fe97cbe5","In 90 days") ?? "In 90 days")}</option><option value="365">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ea94057aa2a5e7","In 1 year") ?? "In 1 year")}</option></select></label>
              </div>
              <button type="submit" class="cp-share-create" ${state.shareBusy ? 'disabled' : ''}>${state.shareBusy ? 'Creating secure link…' : '<i class="fa-solid fa-link" aria-hidden="true"></i>Create secure link'}</button>
            </form>` : ''}
          </section>
        </div>
      </div>
    `;
  }
  function bindShareManager(){
    const layer = document.querySelector('[data-share-modal]');
    if (!layer) return;
    const close = () => { if (state.shareBusy) return; state.shareModalOpen = false; state.shareCreatedUrl = ''; state.shareCreatedId = ''; render(); };
    layer.querySelector('[data-share-close]')?.addEventListener('click', close);
    layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
    layer.querySelector('[data-share-form-toggle]')?.addEventListener('click', () => { state.shareFormOpen = !state.shareFormOpen; render(); });
    layer.querySelectorAll('[data-share-copy-url]').forEach((button) => button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cleanText(button.dataset.shareCopyUrl)); showPortalToast('Secure link copied.'); }
      catch (_) { button.closest('.cp-share-link-row')?.querySelector('input')?.select?.(); showPortalToast('Select the link and copy it.'); }
    }));
    layer.querySelector('[data-share-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.shareBusy || !api?.customerPortals?.publicCreateShare) return;
      const form = new FormData(event.currentTarget);
      const currentProjectId = cleanText(activeProjectPayload()?.project?.id || state.activeProjectId);
      const allProjectIds = projectBundles(state.payload).map((bundle) => cleanText(bundle.project?.id)).filter(Boolean);
      const portalUuid = activePortalUuid();
      state.shareBusy = true; render();
      try {
        const result = await api.customerPortals.publicCreateShare(portalUuid, {
          label: cleanText(form.get('label')),
          preset: cleanText(form.get('preset')) || 'full_view',
          expires_days: Number(form.get('expires_days') || 0),
          project_ids: cleanText(form.get('project_scope')) === 'all' ? allProjectIds : [currentProjectId]
        });
        state.shareCreatedUrl = cleanText(result.url);
        state.shareCreatedId = cleanText(result.share?.id);
        await refreshPortalPayload();
        state.shareModalOpen = true;
        state.shareFormOpen = false;
        render();
      } catch (error) { showPortalToast(error?.message || 'Could not create the shared link.'); }
      finally { state.shareBusy = false; if (state.shareModalOpen) render(); }
    });
    layer.querySelectorAll('[data-share-revoke]').forEach((button) => button.addEventListener('click', async () => {
      if (state.shareBusy || !confirm((globalThis.PlatformLanguage?.text("customer-portal","m_3f7a95b3e0ac2d","Revoke access for this shared link? Anyone using it will be blocked immediately.") ?? "Revoke access for this shared link? Anyone using it will be blocked immediately."))) return;
      const portalUuid = activePortalUuid();
      state.shareBusy = true; button.disabled = true;
      try {
        await api.customerPortals.publicRevokeShare(portalUuid, button.dataset.shareRevoke || '');
        await refreshPortalPayload();
        state.shareModalOpen = true;
        state.shareCreatedUrl = '';
        if (cleanText(state.shareCreatedId) === cleanText(button.dataset.shareRevoke)) state.shareCreatedId = '';
        showPortalToast('Shared link revoked.');
      } catch (error) { showPortalToast(error?.message || 'Could not revoke the shared link.'); }
      finally { state.shareBusy = false; if (state.shareModalOpen) render(); }
    }));
  }
  function render(){
    if (activeInlineDocumentWorkflow) {
      try { activeInlineDocumentWorkflow.destroy?.(); } catch (error) {}
      activeInlineDocumentWorkflow = null;
    }
    const payload = activeProjectPayload();
    const org = payload.organization || {};
    const project = payload.project || {};
    const customer = projectCustomer(payload);
    const media = Array.isArray(payload.media) ? payload.media : [];
    const appointment = portalAppointment(payload);
    const customerName = isGenericCustomerName(customer.name) ? '' : cleanText(customer.name);
    const displayName = firstDisplayName(project.project_title, project.title, project.display_name, project.name, 'Project');
    const address = cleanText(project.address);
    const orgName = cleanText(org.name || 'Company');
    const email = cleanText(customer.email);
    const phone = formatPhone(customer.phone);
    const contactRows = [
      customerName ? `<div><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_46c8aea84388c3","Contact") ?? "Contact")}</span><strong>${escapeHtml(customerName)}</strong></div>` : '',
      email ? `<div><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5d2b9327181e33","Email") ?? "Email")}</span><strong>${escapeHtml(email)}</strong></div>` : '',
      phone ? `<div><span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_ed04c65845180f","Phone") ?? "Phone")}</span><strong>${escapeHtml(phone)}</strong></div>` : ''
    ].filter(Boolean).join('');
    const tabList = tabs();
    // A link that names a document (the email the customer was sent) opens on it, once.
    if (state.requestedDocumentId && !state.requestedDocumentOpened) {
      const linkedDoc = documentList(activeProjectPayload()).find((doc) => cleanText(doc.id) === cleanText(state.requestedDocumentId));
      const linkedTab = linkedDoc ? documentTabId(linkedDoc) : '';
      if (linkedTab) {
        state.activeTab = linkedTab;
        state.activeDocumentToken = cleanText(linkedDoc.public_token);
        state.requestedDocumentOpened = true;
      }
    }
    // Fall back to the first served tab rather than a hardcoded 'summary': when
    // a Home page backs the first tab its id is 'home', and 'summary' no longer
    // exists in the list.
    if (!tabList.some((tab) => tab.id === state.activeTab)) {
      state.activeTab = cleanText(tabList[0]?.id) || 'summary';
    }
    document.title = ((v0) => globalThis.PlatformLanguage?.text("customer-portal","m_54e5b0a0f75f6f",`${v0} - Customer Portal`,{v0}) ?? `${v0} - Customer Portal`)(orgName);
    const guestAccess = cleanText(state.payload?.access?.mode) === 'guest';
    mount.className = `cp-shell${isPreviewMode() ? ' preview' : ''}${guestAccess ? ' guest' : ''}`;
    const activeTabHtml = (() => {
      const activeDescriptor = tabList.find((tab) => tab.id === state.activeTab) || {};
      if (activeDescriptor.sourceType === 'document_group') {
        return documentsPanel(documentList(payload, activeDescriptor.groupId), activeDescriptor);
      }
      if (state.activeTab === 'schedule') return scheduleWidget(payload);
      if (state.activeTab === 'photos') return photoWidget(media);
      if (state.activeTab === 'checklists') return checklistPanel(payload);
      // A served tab with id `proposals` that is not a document group has no
      // viewer of its own; it shows the documents like the Documents tab.
      if (state.activeTab === 'documents' || state.activeTab === 'proposals') return documentsPanel(documentList(payload), activeDescriptor);
      if (state.activeTab === 'payments') return paymentsPanel(documentList(payload), payload);
      if (state.activeTab === 'my_documents') return myFilesPanel();
      if (state.activeTab === 'punch_lists') return punchPanel(payload);
      // Any page-backed tab renders through the custom-page stage — the
      // `page:` prefix for portal pages, plus blessed tabs (Home) that an org
      // has pointed at a designed page.
      if (String(state.activeTab).startsWith('page:')) return customPagePanel();
      if (tabList.some((tab) => tab.id === state.activeTab && tab.kind === 'custom' && tab.pageId)) return customPagePanel();
      return `
        ${projectSummaryHeader(displayName, address, contactRows)}
        ${feedbackCard(payload)}
        <div class="cp-summary-layout">
          ${overviewPanel(payload, orgName)}
          <div class="cp-widget-grid">
            ${photoWidget(media, { compact: true })}
            ${documentsWidget(payload, { compact: true })}
          </div>
        </div>
        ${summaryExtensionPanel(cleanText(activeDescriptor.extensionPageId))}
      `;
    })();
    mount.innerHTML = `${!guestAccess && (state.payload?.notifications||[]).length ? `<section class="cp-card" aria-label="Notifications">${state.payload.notifications.map(n=>`<article><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.body)}</p></article>`).join('')}</section>` : ''}
      ${isPreviewMode() ? `<div class="cp-preview-banner" role="status">${(globalThis.PlatformLanguage?.htmlText("customer-portal","preview_banner_read_only","Preview: what your customer sees. Nothing can be signed, accepted or paid here.") ?? "Preview: what your customer sees. Nothing can be signed, accepted or paid here.")}</div>` : ''}
      ${guestAccess ? `<div class="cp-guest-banner"><i class="fa-solid fa-eye" aria-hidden="true"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_7090eed673e7f9","Shared read-only view") ?? "Shared read-only view")}</strong>${state.payload?.access?.label ? ` for ${escapeHtml(state.payload.access.label)}` : ''}</span></div>` : ''}
      <header class="cp-header">
        <div class="cp-header-inner">
          <div class="cp-brand">
            ${logoHtml(org)}
            <div>
              <strong>${escapeHtml(org.name || 'Company')}</strong>
              <span>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_46ba04ea07c935","Customer portal") ?? "Customer portal")}</span>
            </div>
          </div>
          <div class="cp-header-actions">
            ${projectSwitcherHtml(payload)}
          </div>
        </div>
      </header>
      <nav class="cp-tabs" aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_e6d980684bc615","Customer portal sections") ?? "Customer portal sections")}">
        <div class="cp-tabs-list">
          ${tabs().map((tab) => `
            <button type="button" class="${tab.id === state.activeTab ? 'active' : ''}" data-tab="${escapeHtml(tab.id)}" aria-selected="${tab.id === state.activeTab ? 'true' : 'false'}">${escapeHtml(tab.label)}</button>
          `).join('')}
        </div>
        ${state.payload?.access?.can_share && sharingState()?.enabled ? `<button type="button" class="cp-tabs-share" data-share-open aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_fafa5cd97e183b","Share portal") ?? "Share portal")}" title="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_fafa5cd97e183b","Share portal") ?? "Share portal")}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i></button>` : ''}
      </nav>
      <div class="cp-wrap">
        <div class="cp-tab-panel">${activeTabHtml}</div>
      </div>
      ${shareModalHtml()}
      ${rescheduleModalHtml()}
    `;
    mount.querySelector('[data-share-open]')?.addEventListener('click', () => {
      const shares = Array.isArray(sharingState()?.shares) ? sharingState().shares : [];
      state.shareModalOpen = true;
      state.shareFormOpen = !shares.some((item) => cleanText(item.status) === 'active');
      state.shareCreatedUrl = '';
      state.shareCreatedId = '';
      render();
    });
    mount.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab || 'summary'));
    });
    mount.querySelectorAll('[data-project-switch-toggle]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        state.projectMenuOpen = !state.projectMenuOpen;
        render();
      });
    });
    if (state.projectMenuOpen && !projectMenuDismissBound) {
      projectMenuDismissBound = true;
      document.addEventListener('click', (event) => {
        if (!state.projectMenuOpen) return;
        if (event.target.closest?.('[data-project-switch]')) return;
        state.projectMenuOpen = false;
        render();
      });
    }
    mount.querySelectorAll('[data-project-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setActiveProject(btn.dataset.projectTab || ''));
    });
    mount.querySelectorAll('[data-tab-target]').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tabTarget || 'summary'));
    });
    bindChecklistPanel(payload);
    mount.querySelectorAll('[data-step-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const documentToken = cleanText(btn.dataset.stepDocument);
        if (documentToken) state.activeDocumentToken = documentToken;
        setActiveTab(btn.dataset.stepTarget || 'summary');
        track('workflow_step_opened', { step: btn.textContent.trim().replace(/\s+/g, ' ') });
      });
    });
    mount.querySelectorAll('[data-pay-document-token]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = cleanText(btn.dataset.payDocumentToken);
        if (!token) return;
        const doc = documentList(payload).find((entry) => cleanText(entry.public_token) === token) || {};
        const targetTab = documentTabId(doc) || 'documents';
        state.activeDocumentToken = token;
        state.pendingDocumentTaskFocus = 'fa-credit-card';
        setActiveTab(targetTab);
        track('document_opened', { document_token: token, source: 'payments' });
      });
    });
    mount.querySelectorAll('[data-media-index]').forEach((btn) => {
      btn.addEventListener('click', () => openMedia(Number(btn.dataset.mediaIndex || 0)));
    });
    mount.querySelectorAll('[data-schedule-past]').forEach((btn) => {
      btn.addEventListener('click', () => { state.schedulePastOpen = !state.schedulePastOpen; render(); });
    });
    mount.querySelectorAll('[data-reschedule-event]').forEach((btn) => {
      btn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openReschedule(btn.dataset.rescheduleEvent || ''); });
    });
    mount.querySelectorAll('[data-reschedule-cancel]').forEach((btn) => {
      btn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); cancelRescheduleRequest(btn.dataset.rescheduleCancel || ''); });
    });
    mount.querySelectorAll('[data-reschedule-close]').forEach((btn) => btn.addEventListener('click', () => { state.rescheduleModalOpen = false; render(); }));
    mount.querySelector('[data-reschedule-modal]')?.addEventListener('click', (event) => { if (event.target === event.currentTarget && !state.rescheduleBusy) { state.rescheduleModalOpen = false; render(); } });
    mount.querySelectorAll('[data-reschedule-date]').forEach((btn) => btn.addEventListener('click', () => { if (!btn.disabled) {
      const nextDate = btn.dataset.rescheduleDate || '';
      if (state.rescheduleSelectedDate !== nextDate) {
        state.rescheduleSelectedStartAt = '';
        state.rescheduleSelectedResource = '';
      }
      state.rescheduleSelectedDate = nextDate;
      render();
    } }));
    mount.querySelectorAll('[data-reschedule-month]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const [year, month] = (state.rescheduleMonth || '').split('-').map(Number);
      const next = new Date(Date.UTC(year || new Date().getUTCFullYear(), (month || 1) - 1 + Number(btn.dataset.rescheduleMonth || 0), 1));
      state.rescheduleMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,'0')}`;
      const first = state.rescheduleSlots.find((slot) => (cleanText(slot.date) || cleanText(slot.start_at).slice(0,10)).startsWith(state.rescheduleMonth));
      if (first) state.rescheduleSelectedDate = cleanText(first.date) || cleanText(first.start_at).slice(0,10);
      state.rescheduleSelectedStartAt = '';
      state.rescheduleSelectedResource = '';
      render();
    }));
    mount.querySelectorAll('[data-reschedule-slot]').forEach((btn) => btn.addEventListener('click', () => selectRescheduleSlot(btn)));
    mount.querySelectorAll('[data-reschedule-confirm]').forEach((btn) => btn.addEventListener('click', () => confirmRescheduleSlot()));
    bindCustomerUploadControls(mount);
    bindPunchControls(mount);
    mount.querySelectorAll('[data-feedback-open]').forEach((link) => {
      link.addEventListener('click', () => track('feedback_opened', {}));
    });
    mount.querySelectorAll('[data-document-token]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = cleanText(btn.dataset.documentToken);
        if (!token || state.activeDocumentToken === token) return;
        state.activeDocumentToken = token;
        render();
        track('document_opened', { document_token: token });
      });
    });
    mount.querySelectorAll('[data-document-retry]').forEach((btn) => btn.addEventListener('click', () => {
      delete documentSnapshotCache[cleanText(btn.dataset.documentRetry)];
      delete documentWorkflowCache[cleanText(btn.dataset.documentRetry)];
      render();
    }));
    mount.querySelectorAll('[data-document-workflow]').forEach((btn) => {
      btn.addEventListener('click', () => openDocumentWorkflowOverlay(btn.dataset.documentWorkflow));
    });
    // The to-do list is redrawn after every answer, so its buttons are handled
    // from the page, not bound one by one (a redrawn button had no handler).
    if (!mount.__cpTaskClicks) {
      mount.__cpTaskClicks = true;
      mount.addEventListener('click', (event) => {
        const btn = event.target.closest?.('[data-document-task-phase]');
        if (!btn || !mount.contains(btn)) return;
        const token = cleanText(activePortalDocument()?.public_token);
        if (!token) return;
        const phase = cleanText(btn.dataset.documentTaskPhase) || 'document';
        state.documentWorkflowViews[token] = phase;
        const stepId = phase === 'workflow' ? cleanText(btn.dataset.documentTaskStep) : '';
        if (phase === 'workflow' && activeInlineDocumentWorkflow) {
          activeInlineDocumentWorkflow.refresh?.({ current_step: stepId });
          return;
        }
        state.pendingDocumentTaskStep = stepId;
        state.pendingDocumentTaskFocus = phase === 'document' ? cleanText(btn.dataset.documentTaskFocus) : '';
        render();
      });
    }
    mount.querySelectorAll('[data-document-show-workflow]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = cleanText(btn.dataset.documentShowWorkflow);
        if (!token) return;
        state.documentWorkflowViews[token] = 'workflow';
        render();
      });
    });
    mountDocumentStage();
    mountSummaryDocumentPreviews();
    mountInlineDocumentWorkflow();
    mountCustomPage();
    fitMarkupFrames(mount);
    bindShareManager();
    // Idempotent: only starts the widget on the first render that has a grant.
    syncPortalChat();
  }
  function setActiveProject(projectId){
    const next = cleanText(projectId);
    state.projectMenuOpen = false;
    if (!next || state.activeProjectId === next) { render(); return; }
    state.activeProjectId = next;
    state.activeMediaIndex = -1;
    // Tabs are per-project (a punch list on one, none on another), so a tab
    // that does not exist on the incoming project falls back in render().
    clearCustomPageCache();
    render();
    track('project_opened', { project_id: next });
  }
  function setActiveTab(tab){
    const available = tabs();
    // Falls back to the first served tab: with a Home page the first tab's id is
    // 'home', and 'summary' is not in the list at all.
    const next = available.some((item) => item.id === tab) ? tab : (cleanText(available[0]?.id) || 'summary');
    if (state.activeTab === next) return;
    state.activeTab = next;
    render();
    track('tab_opened', { tab: next });
  }
  function openMedia(index){
    const media = activeProjectPayload().media || [];
    if (!media.length) return;
    state.activeMediaIndex = Math.max(0, Math.min(index, media.length - 1));
    const item = media[state.activeMediaIndex];
    const isVideo = cleanText(item.media_type || item.kind).toLowerCase() === 'video';
    const node = document.createElement('div');
    node.className = 'cp-modal';
    node.innerHTML = `
      <div class="cp-modal-inner" role="dialog" aria-modal="true">
        <button type="button" class="cp-icon-btn cp-close" data-close aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_3742924668fb10","Close") ?? "Close")}">x</button>
        ${media.length > 1 ? `<button type="button" class="cp-icon-btn cp-nav prev" data-prev aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_bb31fd73cbfe3b","Previous") ?? "Previous")}">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_c92214e41976a3","&lt;") ?? "&lt;")}</button><button type="button" class="cp-icon-btn cp-nav next" data-next aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_5e03a7c216f500","Next") ?? "Next")}">${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_6d53ddeac23dcc","&gt;") ?? "&gt;")}</button>` : ''}
        <div class="cp-modal-stage">
          ${isVideo ? `<video src="${escapeHtml(item.src)}" controls autoplay playsinline></video>` : markedImageHtml(item, item.src, item.label || 'Shared media')}
        </div>
        <div class="cp-modal-meta">
          <strong>${escapeHtml(item.label || (isVideo ? 'Video' : 'Photo'))}</strong>
          <a class="cp-icon-btn" href="${escapeHtml(item.src)}" download aria-label="${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_871659bb2df660","Download") ?? "Download")}" data-media-download>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_9bc843cc6db724","DL") ?? "DL")}</a>
        </div>
        ${mediaCommentsHtml(item.media_id || item.id)}
      </div>
    `;
    document.body.appendChild(node);
    fitMarkupFrames(node);
    const close = () => node.remove();
    bindMediaCommentForm(node);
    node.addEventListener('click', (event) => {
      // Comment controls live inside the modal; let them handle their own
      // clicks before the navigation/close delegates run.
      if (event.target.closest('.cp-media-comments')) return;
      if (event.target === node || event.target.closest('[data-close]')) close();
      if (event.target.closest('[data-prev]')) { close(); openMedia(state.activeMediaIndex - 1); }
      if (event.target.closest('[data-next]')) { close(); openMedia(state.activeMediaIndex + 1); }
      if (event.target.closest('[data-media-download]')) track('media_downloaded', { media_id: item.media_id || item.id });
    });
    const keyHandler = (event) => {
      if (!document.body.contains(node)) {
        document.removeEventListener('keydown', keyHandler);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowLeft' && media.length > 1) { event.preventDefault(); close(); openMedia(state.activeMediaIndex - 1); }
      if (event.key === 'ArrowRight' && media.length > 1) { event.preventDefault(); close(); openMedia(state.activeMediaIndex + 1); }
    };
    document.addEventListener('keydown', keyHandler);
    track('media_opened', { media_id: item.media_id || item.id });
  }
  function renderError(error){
    mount.className = 'cp-shell';
    mount.innerHTML = `<div class="cp-error"><h1>${(globalThis.PlatformLanguage?.htmlText("customer-portal","m_881cec332c3933","Portal unavailable") ?? "Portal unavailable")}</h1><p>${escapeHtml(error?.message || 'This customer portal could not be loaded.')}</p></div>`;
  }
  async function init(){
    if (!cfg.id || !api?.customerPortals?.publicGet) {
      renderError(new Error('Missing customer portal link.'));
      return;
    }
    try {
      const payload = await api.customerPortals.publicGet(cfg.id, { preview: cfg.preview });
      if(payload.language){root.PlatformLanguage?.configure?.({context:payload.language.context});root.PlatformTerminology?.setConfig?.({mappings:payload.language.terminology});await root.PlatformLanguage?.ensure?.(['customer-portal']);}
    state.payload = payload;
      state.activeProjectId = cleanText(payload?.contact_portal?.active_project_id || payload?.portal?.active_project_id || payload?.project?.id);
      applyBranding(payload);
      render();
      track('viewed');
    } catch (error) {
      renderError(error);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
