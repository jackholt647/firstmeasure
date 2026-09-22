/* public/libraries/apps/photos/feed.js
 * Organization-wide media, document, and activity feed.
 */
(function(){
  if (!window.Portal) return;
  const { escapeHtml, injectCSS } = window.Portal.util;
  const { showToast } = window.Portal.ui;
  const APP = window.Portal.cfg || window.__APP || {};
  const TAB_ID = 'photos_feed';
  const PROJECT_CONFIG_MODULE_ID = 'project_configuration';
  const PAGE_SIZE = 14;
  const DEFAULT_MEDIA_FILTERS = ['photo', 'video'];
  const DEFAULT_ACTIVITY_FILTERS = ['payments', 'documents', 'engagement', 'calls', 'messages', 'uploads', 'project', 'scheduling', 'field'];
  const DOCUMENT_FILTERS = [
    { id:'receipt', label:(globalThis.PlatformLanguage?.text("photos","m_fc54001a0cc000","Receipts") ?? "Receipts"), icon:'fa-receipt' },
    { id:'invoice', label:(globalThis.PlatformLanguage?.text("photos","m_74b68c454b06a0","Invoices") ?? "Invoices"), icon:'fa-file-invoice-dollar' },
    { id:'proposal_report', label:(globalThis.PlatformLanguage?.text("photos","m_0eb5d8d48694f0","Proposals & reports") ?? "Proposals & reports"), icon:'fa-file-signature' },
    { id:'contract', label:(globalThis.PlatformLanguage?.text("photos","m_dcdcac34171224","Contracts & change orders") ?? "Contracts & change orders"), icon:'fa-file-contract' },
    { id:'other', label:(globalThis.PlatformLanguage?.text("photos","m_10222af7bca8a8","Other documents") ?? "Other documents"), icon:'fa-folder-open' }
  ];
  const ACTIVITY_FILTERS = [
    { id:'payments', label:(globalThis.PlatformLanguage?.text("photos","m_1a9ae672c03c56","Payments & expenses") ?? "Payments & expenses"), icon:'fa-dollar-sign' },
    { id:'documents', label:(globalThis.PlatformLanguage?.text("photos","m_408c208343964e","Proposals & documents") ?? "Proposals & documents"), icon:'fa-file-signature' },
    { id:'engagement', label:(globalThis.PlatformLanguage?.text("photos","m_3f573261ee80e3","Views & signatures") ?? "Views & signatures"), icon:'fa-signature' },
    { id:'calls', label:(globalThis.PlatformLanguage?.text("photos","m_e830f5588df87c","Calls") ?? "Calls"), icon:'fa-phone' },
    { id:'messages', label:(globalThis.PlatformLanguage?.text("photos","m_09d530e429d079","Messages & feedback") ?? "Messages & feedback"), icon:'fa-message' },
    { id:'uploads', label:(globalThis.PlatformLanguage?.text("photos","m_5f42004754205c","Uploads") ?? "Uploads"), icon:'fa-cloud-arrow-up' },
    { id:'project', label:(globalThis.PlatformLanguage?.text("photos","m_ca88698f97c379","Project updates") ?? "Project updates"), icon:'fa-briefcase' },
    { id:'scheduling', label:(globalThis.PlatformLanguage?.text("photos","m_4249990706c50e","Scheduling") ?? "Scheduling"), icon:'fa-calendar-check' },
    { id:'field', label:(globalThis.PlatformLanguage?.text("photos","m_ab8a6ac7c744e8","Field work") ?? "Field work"), icon:'fa-helmet-safety' }
  ];
  let registered = false;
  let branchProjectConfig = { title_mode: 'customer_name' };
  const markupThumbnailRevisions = new Map();
  let state = {
    root: null,
    projects: [],
    items: [],
    groups: [],
    documents: [],
    activity: [],
    users: [],
    query: '',
    density: 'comfortable',
    shownMenuOpen: false,
    visibleMedia: new Set(DEFAULT_MEDIA_FILTERS),
    visibleTags: new Set(),
    visibleDocuments: new Set(),
    visibleActivity: new Set(DEFAULT_ACTIVITY_FILTERS),
    documentsLoading: false,
    documentsLoaded: false,
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
    title: (globalThis.PlatformLanguage?.text("photos","m_3eea4dfd8e947d","Feed") ?? "Feed"),
    subtitle: '',
    icon: 'fa-layer-group',
    uploadLabel: '',
    onUpload: null,
    enableProjectLinks: true,
    trashMode: false,
    routeRestoreKey: '',
    activeFeedViewer: null,
    closingFeedViewerFromRoute: false,
    openingProjectFromFeedViewer: false,
    activeUserModal: null
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
  function isReceiptMedia(photo = {}){
    const owner = photo.owner && typeof photo.owner === 'object' ? photo.owner : {};
    const metadata = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return !!photo.receipt
      || cleanText(owner.slot || photo.owner_slot).toLowerCase() === 'receipts'
      || cleanText(photo.document_type || photo.type || metadata.document_type).toLowerCase() === 'receipt'
      || cleanText(photo.source || metadata.source).toLowerCase() === 'expense_receipt_upload'
      || !!cleanText(photo.receipt_id || metadata.receipt_id);
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
      'workflow_state'
    ].forEach(keepText);
    ['contacts', 'proposals', 'events'].forEach(keepArray);
    const mergedPhotos = [];
    const photoIds = new Set();
    [...(Array.isArray(right.photos) ? right.photos : []), ...(Array.isArray(left.photos) ? left.photos : [])].forEach((photo) => {
      if (!photo || typeof photo !== 'object') return;
      const id = photoIdentity(photo);
      if (id && photoIds.has(id)) return;
      if (id) photoIds.add(id);
      mergedPhotos.push(photo);
    });
    if (mergedPhotos.length || Object.prototype.hasOwnProperty.call(left, 'photos') || Object.prototype.hasOwnProperty.call(right, 'photos')) {
      merged.photos = mergedPhotos;
    }
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
  function updatePhotoRoute(item = {}, scope = 'feed', options = {}){
    const photo = item.photo || item;
    const project = item.project || photo.__project || {};
    const photoId = mediaRouteId(photo);
    if (!photoId) return;
    const patch = { photo: photoId, photoScope: scope };
    const projectId = projectRouteId(project);
    if (scope === 'project') {
      patch.projectTab = 'photos';
      if (projectId) patch.project = projectId;
    } else {
      patch.tab = TAB_ID;
      // The global feed viewer is not inside a project modal, so it must not
      // leave `project` in the URL: on reload that reopens project chrome the
      // feed never dismisses. closePhotoRoute() already clears it this way.
      patch.project = null;
    }
    window.Portal?.navigation?.write?.(patch, { history:options.history || 'replace', source:options.source || 'photo-viewer', ownedKeys:['photo','photoScope'] });
  }
  function clearPhotoRoute(scope = ''){
    const route = window.Portal?.routeState?.get?.() || {};
    if (scope && route.photoScope && route.photoScope !== scope) return;
    const patch = { photo: null, photoScope: null };
    window.Portal?.navigation?.replace?.(patch, { source:'photo-clear', ownedKeys:['photo','photoScope'] });
  }
  function closePhotoRoute(scope = 'feed'){
    const route = window.Portal?.navigation?.read?.() || {};
    if (scope && route.photoScope && route.photoScope !== scope) return;
    window.Portal?.navigation?.backOrClose?.(['photo'], { photo:null, photoScope:null, ...(scope === 'feed' ? { project:null } : {}) }, { source:'photo-close' });
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
  function objectValue(value){
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function documentId(doc = {}, fallback = ''){
    return firstText(doc.id, doc.document_id, doc.media_id, doc.mediaId, doc.url, doc.href, fallback);
  }
  function documentType(doc = {}){
    return cleanText(doc.document_type || doc.type || 'document').toLowerCase().replace(/[\s-]+/g, '_') || 'document';
  }
  function documentCategory(doc = {}){
    const type = documentType(doc);
    const metadata = objectValue(doc.metadata);
    const source = cleanText(doc.source || metadata.source).toLowerCase();
    if (type === 'receipt' || source === 'expense_receipt_upload' || firstText(doc.receipt_id, metadata.receipt_id)) return 'receipt';
    if (type === 'invoice' || firstText(doc.invoice_id, metadata.invoice_id)) return 'invoice';
    if (type === 'contract' || type === 'change_order' || type.includes('contract')) return 'contract';
    if (type === 'proposal' || type.includes('report')) return 'proposal_report';
    return 'other';
  }
  function documentMeta(doc = {}){
    const category = documentCategory(doc);
    return ({
      receipt:{ label:(globalThis.PlatformLanguage?.text("photos","m_ab3df34a8730df","Receipt") ?? "Receipt"), icon:'fa-receipt', color:'#b54708' },
      invoice:{ label:(globalThis.PlatformLanguage?.text("photos","m_1d5ea39cc421fc","Invoice") ?? "Invoice"), icon:'fa-file-invoice-dollar', color:'#175cd3' },
      proposal_report:{ label:documentType(doc).includes('report') ? 'Report' : 'Proposal', icon:documentType(doc).includes('report') ? 'fa-file-lines' : 'fa-file-signature', color:'#2563eb' },
      contract:{ label:documentType(doc) === 'change_order' ? 'Change order' : 'Contract', icon:'fa-file-contract', color:'#7c3aed' },
      other:{ label:(globalThis.PlatformLanguage?.text("photos","m_9c9b98b1f4e8c9","Document") ?? "Document"), icon:'fa-file-lines', color:'#64748b' }
    })[category];
  }
  function documentUrl(doc = {}){
    const mediaId = firstText(doc.media_id, doc.mediaId);
    if (mediaId && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId(), mediaId, 'original');
    return firstText(doc.url, doc.href, doc.src);
  }
  function documentTimestamp(doc = {}){
    return firstText(doc.uploaded_at, doc.created_at, doc.issued_at, doc.updated_at, doc.issue_date);
  }
  function normalizeFeedDocument(doc = {}, project = {}, index = 0){
    const meta = documentMeta(doc);
    const id = documentId(doc, `document_${index + 1}`);
    return {
      ...doc,
      id,
      document_type:documentType(doc),
      title:firstText(doc.title, doc.label, doc.file_name, doc.name, meta.label),
      type_label:firstText(doc.type_label, meta.label),
      icon:firstText(doc.icon, meta.icon),
      color:firstText(doc.color, meta.color),
      url:documentUrl(doc),
      project,
      project_id:firstText(doc.project_id, project.id, project.platform_project_id, project.base_project_id),
      timestamp:documentTimestamp(doc),
      category:documentCategory(doc)
    };
  }
  function normalizeInvoiceDocument(invoice = {}, project = {}, index = 0){
    const id = firstText(invoice.id, `invoice_${index + 1}`);
    return normalizeFeedDocument({
      ...invoice,
      id:`invoice:${id}`,
      invoice_id:id,
      title:firstText(invoice.invoice_number, invoice.title, `Invoice ${index + 1}`),
      document_type:'invoice',
      type_label:'Invoice',
      content_type:'application/pdf',
      file_name:`${firstText(invoice.invoice_number, 'invoice')}.pdf`,
      url:window.PaymentsAPI?.invoices?.pdfUrl?.(orgId(), id) || '',
      created_at:firstText(invoice.created_at, invoice.issue_date),
      updated_at:firstText(invoice.updated_at, invoice.created_at, invoice.issue_date)
    }, project, index);
  }
  function normalizeReceiptDocument(receipt = {}, project = {}, index = 0){
    const id = firstText(receipt.id, receipt.receipt_id, `receipt_${index + 1}`);
    const file = objectValue(receipt.file);
    const extraction = objectValue(receipt.extraction);
    return normalizeFeedDocument({
      ...receipt,
      id:`receipt:${id}`,
      receipt_id:id,
      title:firstText(receipt.title, extraction.vendor_name, extraction.vendor, file.file_name, `Receipt ${index + 1}`),
      document_type:'receipt',
      type_label:'Receipt',
      content_type:firstText(receipt.content_type, file.content_type),
      file_name:firstText(receipt.file_name, file.file_name),
      url:window.PaymentsAPI?.receipts?.fileUrl?.(orgId(), id, { inline:true }) || '',
      uploaded_at:firstText(receipt.uploaded_at, receipt.created_at)
    }, project, index);
  }
  function activityPayload(event = {}){
    return objectValue(event.payload);
  }
  function activityContext(event = {}){
    return objectValue(event.context);
  }
  function feedActivityCategory(event = {}){
    const type = cleanText(event.type).toLowerCase();
    if (/^(payment|invoice|expense|payroll)\./.test(type)) return 'payments';
    if (/^(media\.uploaded|receipt\.uploaded|document\.ingested)/.test(type)) return 'uploads';
    if (/^(proposal|document|contract)\./.test(type)) return /\.(viewed|opened|signed|completed|declined)$/.test(type) ? 'engagement' : 'documents';
    if (type.startsWith('call.')) return 'calls';
    if (/^(communication|sms|email|feedback)\./.test(type)) return 'messages';
    if (type.startsWith('project.event') || type.startsWith('recurrence.')) return 'scheduling';
    if (/^(material|crew|measurement)\./.test(type)) return 'field';
    return 'project';
  }
  function feedActivityIcon(event = {}){
    const type = cleanText(event.type);
    if (type === 'payment.received' || type === 'proposal.payment.received' || type === 'document.payment.received') return 'fa-circle-dollar-to-slot';
    if (type === 'receipt.uploaded' || type === 'media.uploaded' || type === 'document.ingested') return 'fa-cloud-arrow-up';
    if (type.includes('signed')) return 'fa-signature';
    if (type.includes('viewed') || type.includes('opened') || type === 'portal.visited') return 'fa-eye';
    if (type.includes('sent')) return 'fa-paper-plane';
    if (type.startsWith('communication') || type.startsWith('call')) return 'fa-phone';
    if (type.startsWith('project.event') || type.startsWith('recurrence')) return 'fa-calendar-check';
    if (type.startsWith('material')) return 'fa-truck-ramp-box';
    if (type.startsWith('crew')) return 'fa-helmet-safety';
    if (type.startsWith('invoice')) return 'fa-file-invoice-dollar';
    if (type.startsWith('proposal') || type.startsWith('document')) return 'fa-file-signature';
    return 'fa-bolt';
  }
  function feedActor(event = {}){
    const payload = activityPayload(event);
    const context = activityContext(event);
    const actorId = firstText(event.actor_user_id, context.actor_user_id, payload.actor_user_id);
    const user = state.users.find((entry) => [entry.id, entry.user_id, entry.email].map(cleanText).includes(actorId));
    return firstText(payload.actor_name, context.actor_name, user?.name, user?.display_name, context.actor_email, user?.email, 'Someone');
  }
  function activityObjectLabel(event = {}){
    const payload = activityPayload(event);
    return firstText(payload.title, payload.document_title, payload.proposal_title, payload.invoice_number, payload.file_name, payload.contact_name);
  }
  function feedActivitySummary(event = {}){
    const actor = feedActor(event);
    const object = activityObjectLabel(event);
    const type = cleanText(event.type);
    const action = ({
      'payment.received':'took a payment',
      'proposal.payment.received':'took a proposal payment',
      'document.payment.received':'took a document payment',
      'payment.refunded':'refunded a payment',
      'invoice.created':'created an invoice',
      'invoice.sent':'sent an invoice to the customer',
      'receipt.uploaded':'uploaded a receipt',
      'expense.recorded':'recorded an expense',
      'proposal.created':'created a proposal',
      'proposal.sent':'sent a proposal to the customer',
      'proposal.viewed':'had a proposal viewed by the customer',
      'proposal.signed':'had a proposal signed',
      'document.sent':'sent a document to the customer',
      'document.opened':'had a document opened by the customer',
      'document.viewed':'had a document viewed by the customer',
      'document.signed':'had a document signed',
      'document.completed':'completed a document',
      'document.declined':'had a document declined',
      'document.ingested':'uploaded a document',
      'contract.opened':'had a contract opened by the customer',
      'contract.viewed':'had a contract viewed by the customer',
      'contract.signed':'had a contract signed',
      'call.completed':'made a call',
      'communication.sent':'sent a message',
      'communication.received':'received a customer message',
      'communication.auto_replied':'sent an automatic reply',
      'media.uploaded':'uploaded media',
      'media.shared':'shared media with the customer',
      'project.created':'created a project',
      'project.contact.attached':'attached a contact',
      'project.event_scheduled':'scheduled an event',
      'project.event.started':'started a scheduled event',
      'project.event.completed':'completed a scheduled event',
      'material.delivery.completed':'completed a material delivery',
      'material.order.placed':'placed a material order',
      'crew.clock.in':'clocked in',
      'crew.clock.out':'clocked out',
      'crew.checklist.completed':'completed a checklist',
      'measurement.report.ordered':'ordered a measurement report',
      'measurement.report.completed':'completed a measurement report',
      'note.created':'added a note',
      'portal.visited':'had the customer open their portal',
      'feedback.request.sent':'sent a feedback request'
    })[type] || cleanText(type).replace(/[._]+/g, ' ');
    return `${actor} ${action}${object ? `: ${object}` : ''}`;
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
    const payload = activityPayload(event);
    const context = activityContext(event);
    return cleanText(target.project_id || target.projectId || event.project_id || event.projectId || payload.project_id || payload.projectId || context.project_id || context.projectId);
  }
  function activityMediaId(event = {}){
    const target = activityTarget(event);
    const payload = activityPayload(event);
    return cleanText(target.media_id || target.mediaId || target.photo_id || target.photoId || event.media_id || event.photo_id || payload.media_id || payload.mediaId || payload.photo_id || payload.photoId);
  }
  function activityProjectLabel(event = {}){
    const target = activityTarget(event);
    const payload = activityPayload(event);
    const supplied = cleanText(target.project_title || target.project_name || target.project_address || event.project_title || event.project_address || payload.project_title || payload.project_name || payload.project_address);
    if (supplied) return supplied;
    const projectId = activityProjectId(event);
    const project = state.projects.find((entry) => sameProjectId(entry, projectId));
    return project ? projectTitle(project) : '';
  }
  function activityLinkHtml(event = {}, index = 0){
    const projectId = activityProjectId(event);
    const mediaId = activityMediaId(event);
    const links = [];
    if (mediaId) {
      links.push(`<button type="button" class="pf-activity-link" data-activity-photo-open="${String(index)}"><i class="fas fa-image"></i>${(globalThis.PlatformLanguage?.text("photos","m_e44133b3423b5f"," Open media") ?? " Open media")}</button>`);
    }
    if (projectId || activityProjectLabel(event)) {
      links.push(`<button type="button" class="pf-activity-link" data-activity-project-open="${String(index)}"><i class="fas fa-folder-open"></i>${(globalThis.PlatformLanguage?.text("photos","m_53787840db7d1c"," Open project") ?? " Open project")}</button>`);
    }
    return links.length ? `<div class="pf-activity-links">${links.join('')}</div>` : '';
  }
  function renderActivityList(events = []){
    if (!events.length) {
      return `<div class="pf-user-empty"><i class="fas fa-clock-rotate-left"></i><strong>${(globalThis.PlatformLanguage?.text("photos","m_a545b858debe95","No activity yet") ?? "No activity yet")}</strong><span>${(globalThis.PlatformLanguage?.text("photos","m_987dfddd540a5b","Tracked uploads, comments, and report orders will appear here.") ?? "Tracked uploads, comments, and report orders will appear here.")}</span></div>`;
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
    showToast?.((globalThis.PlatformLanguage?.text("photos","m_f4965c0ef7b141","Project not found") ?? "Project not found"), (globalThis.PlatformLanguage?.text("photos","m_3b64514c752a06","Could not find the project for that activity yet.") ?? "Could not find the project for that activity yet."), false);
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
      updatePhotoRoute(item, 'feed', { history:'push', source:'photo-open' });
      window.FirstMateMarkup?.openPhotoViewer?.({
        photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
        index,
        project: item.project || {},
        onOpenProject: openProject,
        boundsTarget: options.boundsTarget || null,
        onChange: ({ photo, project }) => updatePhotoRoute({ photo, project: project || photo?.__project || item.project }, 'feed'),
        onClose: () => closePhotoRoute('feed')
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
    if (!users.length) return `<span>${(globalThis.PlatformLanguage?.text("photos","m_d891abd029c243","Unknown uploader") ?? "Unknown uploader")}</span>`;
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
      const photos = Array.isArray(project.photos) ? project.photos : [];
      const index = photos.findIndex((photo) => firstText(photo?.media_id, photo?.mediaId, photo?.id) === id);
      if (index < 0) project.photos = [...photos, reference];
      else {
        project.photos = photos.map((photo, photoIndex) => photoIndex === index ? {
          ...photo,
          ...reference,
          metadata: { ...(photo.metadata || {}), ...(reference.metadata || {}) },
          tags: reference.tags || reference.metadata?.tags || photo.tags || photo.metadata?.tags || []
        } : photo);
      }
    });
    return order.map((id) => byId.get(id)).filter(Boolean);
  }
  function buildItems(projects = [], options = {}){
    return projects.flatMap((project) => normalizePhotos(project)
      .filter((photo) => options.includeReceipts === true || !isReceiptMedia(photo))
      .map((photo, index) => {
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
  function normalizeMediaTags(value){
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(values.map((tag) => cleanText(tag)
      .replace(/^#+/, '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 64)).filter(Boolean))].slice(0, 50);
  }
  function mediaTagOptions(items = state.items, selected = new Set()){
    const counts = new Map();
    items.forEach((item) => itemTags(item).forEach((tag) => {
      const key = normalizeMediaTags([tag])[0];
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }));
    selected.forEach((tag) => {
      const key = normalizeMediaTags([tag])[0];
      if (key && !counts.has(key)) counts.set(key, 0);
    });
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([id, count]) => ({ id, label:`#${id}`, icon:'fa-tag', count }));
  }
  async function saveMediaTags(photo = {}, tagsValue = []){
    const mediaId = cleanText(photo.media_id || photo.mediaId || photo.id);
    const tags = normalizeMediaTags(tagsValue);
    if (!mediaId || typeof window.PlatformAPI?.media?.updateTags !== 'function') throw new Error('Media tagging is not available.');
    const result = await window.PlatformAPI.media.updateTags(orgId(), mediaId, tags);
    const apply = (target) => {
      if (!target || photoIdentity(target) !== mediaId) return target;
      target.tags = tags;
      target.metadata = { ...(target.metadata && typeof target.metadata === 'object' ? target.metadata : {}), tags };
      return target;
    };
    state.items.forEach((item) => {
      if (photoIdentity(item.photo) !== mediaId) return;
      apply(item.photo);
      item.search = searchableText(item);
    });
    render();
    return result;
  }
  function projectForId(id = ''){
    return state.projects.find((project) => sameProjectId(project, id)) || {};
  }
  function projectDocumentsFromProjects(projects = []){
    const seen = new Set();
    return projects.flatMap((project) => (Array.isArray(project.documents) ? project.documents : []).map((doc, index) => normalizeFeedDocument(doc, project, index)))
      .filter((doc) => {
        const key = `${doc.project_id}:${doc.id}`;
        if (!doc.id || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  async function mapWithConcurrency(items = [], limit = 4, mapper = async () => null){
    const source = [...items];
    const results = new Array(source.length);
    let cursor = 0;
    const workers = Array.from({ length:Math.min(limit, source.length) }, async () => {
      while (cursor < source.length) {
        const index = cursor++;
        results[index] = await mapper(source[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }
  async function loadFeedDocuments(){
    if (state.documentsLoading || state.documentsLoaded) return;
    if (!window.PlatformAPI?.projectDocuments?.list) {
      state.documentsLoaded = true;
      return;
    }
    state.documentsLoading = true;
    render();
    const oid = orgId();
    const results = await mapWithConcurrency(state.projects, 4, async (project) => {
      const pid = projectRouteId(project);
      if (!pid) return [];
      const [docsResult, invoiceResult, receiptResult] = await Promise.all([
        window.PlatformAPI.projectDocuments.list(oid, pid).catch(() => ({ documents:Array.isArray(project.documents) ? project.documents : [] })),
        window.PaymentsAPI?.invoices?.list
          ? window.PaymentsAPI.invoices.list(oid, pid).catch(() => ({ invoices:[] }))
          : Promise.resolve({ invoices:[] }),
        window.PaymentsAPI?.receipts?.list
          ? window.PaymentsAPI.receipts.list(oid, pid).catch(() => ({ receipts:[] }))
          : Promise.resolve({ receipts:[] })
      ]);
      const documents = (Array.isArray(docsResult?.documents) ? docsResult.documents : [])
        .map((doc, index) => normalizeFeedDocument(doc, project, index));
      const knownInvoices = new Set(documents.map((doc) => firstText(doc.invoice_id, objectValue(doc.metadata).invoice_id)).filter(Boolean));
      const invoices = (Array.isArray(invoiceResult?.invoices) ? invoiceResult.invoices : [])
        .filter((invoice) => !knownInvoices.has(firstText(invoice.id)))
        .map((invoice, index) => normalizeInvoiceDocument(invoice, project, index));
      const knownReceipts = new Set(documents.map((doc) => firstText(doc.receipt_id, objectValue(doc.metadata).receipt_id)).filter(Boolean));
      const receipts = (Array.isArray(receiptResult?.receipts) ? receiptResult.receipts : [])
        .filter((receipt) => !knownReceipts.has(firstText(receipt.id, receipt.receipt_id)))
        .map((receipt, index) => normalizeReceiptDocument(receipt, project, index));
      return [...documents, ...invoices, ...receipts];
    });
    const seen = new Set();
    state.documents = results.flat().filter((doc) => {
      const key = `${doc.project_id}:${doc.id}`;
      if (!doc.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    state.documentsLoading = false;
    state.documentsLoaded = true;
    render();
  }
  function eventTimestamp(event = {}){
    return firstText(event.occurred_at, event.created_at, event.available_at, event.updated_at);
  }
  function eventAssetIds(event = {}){
    const payload = activityPayload(event);
    const target = activityTarget(event);
    return [
      activityMediaId(event),
      payload.document_id,
      payload.receipt_id,
      payload.invoice_id,
      payload.proposal_id,
      target.document_id,
      target.receipt_id
    ].map(cleanText).filter(Boolean);
  }
  function assetEventMatch(asset = {}, event = {}){
    if (asset.projectId && activityProjectId(event) && asset.projectId !== activityProjectId(event)) return false;
    const eventIds = eventAssetIds(event);
    const assetIds = asset.kind === 'media'
      ? [photoIdentity(asset.media), asset.media?.media_id, asset.media?.id]
      : [asset.document?.id, asset.document?.media_id, asset.document?.receipt_id, asset.document?.invoice_id];
    if (eventIds.length && assetIds.map(cleanText).some((id) => id && eventIds.includes(id))) return true;
    const type = cleanText(event.type);
    const compatible = asset.kind === 'media'
      ? type === 'media.uploaded'
      : (asset.document?.category === 'receipt' ? type === 'receipt.uploaded' : type === 'document.ingested');
    if (!compatible) return false;
    const assetTime = Date.parse(asset.timestamp || '');
    const activityAt = Date.parse(eventTimestamp(event) || '');
    return Number.isFinite(assetTime) && Number.isFinite(activityAt) && Math.abs(assetTime - activityAt) <= 5 * 60 * 1000;
  }
  function feedEntries(){
    const mediaEntries = state.items
      .filter((item) => !isPhotoTrashed(item.photo))
      .filter((item) => state.visibleMedia.has(isVideoMedia(item.photo) ? 'video' : 'photo'))
      .filter((item) => !state.visibleTags.size || itemTags(item).some((tag) => state.visibleTags.has(normalizeMediaTags([tag])[0])))
      .map((item) => ({
        id:`media:${item.id}`,
        kind:'media',
        media:item.photo,
        mediaItem:item,
        project:item.project,
        projectId:cleanText(item.projectId),
        timestamp:item.uploadedAt,
        dateKey:item.dateKey,
        search:item.search
      }));
    const documentEntries = state.documents
      .filter((doc) => state.visibleDocuments.has(doc.category))
      .map((doc) => {
        const project = doc.project || projectForId(doc.project_id);
        const search = [doc.title, doc.type_label, projectTitle(project), projectAddress(project), documentTimestamp(doc)].join(' ').toLowerCase();
        return {
          id:`document:${doc.project_id}:${doc.id}`,
          kind:'document',
          document:doc,
          project,
          projectId:cleanText(doc.project_id),
          timestamp:doc.timestamp || documentTimestamp(doc),
          dateKey:dateKey(doc.timestamp || documentTimestamp(doc)),
          search
        };
      });
    const activityEntries = state.activity
      .filter((event) => state.visibleActivity.has(feedActivityCategory(event)))
      .map((event) => ({
        id:`activity:${firstText(event.id, event.idempotency_key, event.type)}:${eventTimestamp(event)}`,
        kind:'activity',
        event,
        project:projectForId(activityProjectId(event)),
        projectId:activityProjectId(event),
        timestamp:eventTimestamp(event),
        dateKey:dateKey(eventTimestamp(event)),
        search:[feedActivitySummary(event), activityProjectLabel(event), cleanText(event.type)].join(' ').toLowerCase()
      }));
    const unpaired = new Set(activityEntries.map((entry) => entry.id));
    [...mediaEntries, ...documentEntries].forEach((asset) => {
      const match = activityEntries.find((entry) => unpaired.has(entry.id) && assetEventMatch(asset, entry.event));
      if (!match) return;
      asset.pairedEvent = match.event;
      asset.timestamp = [asset.timestamp, match.timestamp].sort().reverse()[0] || asset.timestamp;
      asset.dateKey = dateKey(asset.timestamp);
      asset.search += ` ${match.search}`;
      unpaired.delete(match.id);
    });
    const query = cleanText(state.query).toLowerCase();
    const entries = state.visibleTags.size
      ? mediaEntries
      : [...mediaEntries, ...documentEntries, ...activityEntries.filter((entry) => unpaired.has(entry.id))];
    return entries
      .filter((entry) => !query || entry.search.includes(query))
      .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  }
  function groupedFeedEntries(entries = feedEntries()){
    const days = new Map();
    entries.forEach((entry) => {
      if (!days.has(entry.dateKey)) days.set(entry.dateKey, []);
      days.get(entry.dateKey).push(entry);
    });
    return [...days.entries()];
  }
  function serializeFeedShown(){
    return [
      ...[...state.visibleMedia].sort().map((id) => `m:${id}`),
      ...[...state.visibleActivity].sort().map((id) => `a:${id}`),
      ...[...state.visibleDocuments].sort().map((id) => `d:${id}`),
      ...[...state.visibleTags].sort().map((id) => `t:${id}`)
    ].join(',');
  }
  function applyFeedRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (route.feedDensity) state.density = ['loose', 'comfortable', 'compact', 'list'].includes(route.feedDensity) ? route.feedDensity : 'comfortable';
    if (!route.feedShown) return;
    const tokens = cleanText(route.feedShown).split(',').map(cleanText).filter(Boolean);
    state.visibleMedia = new Set(tokens.filter((token) => token.startsWith('m:')).map((token) => token.slice(2)).filter((id) => DEFAULT_MEDIA_FILTERS.includes(id)));
    state.visibleActivity = new Set(tokens.filter((token) => token.startsWith('a:')).map((token) => token.slice(2)).filter((id) => DEFAULT_ACTIVITY_FILTERS.includes(id)));
    state.visibleDocuments = new Set(tokens.filter((token) => token.startsWith('d:')).map((token) => token.slice(2)).filter((id) => DOCUMENT_FILTERS.some((entry) => entry.id === id)));
    state.visibleTags = new Set(tokens.filter((token) => token.startsWith('t:')).map((token) => normalizeMediaTags([token.slice(2)])[0]).filter(Boolean));
    if (state.loaded && state.visibleDocuments.size && !state.documentsLoaded) void loadFeedDocuments();
  }
  function writeFeedPreferences(){
    if (window.Portal?.navigation?.applying) return;
    window.Portal?.navigation?.replace?.({
      feedDensity:state.density,
      feedShown:serializeFeedShown()
    }, { source:'feed-preferences', ownedKeys:['feedDensity','feedShown'] });
  }
  function filteredItems(){
    const query = cleanText(state.query).toLowerCase();
    const modeItems = state.items
      .filter((item) => state.trashMode ? isPhotoTrashed(item.photo) : !isPhotoTrashed(item.photo))
      .filter((item) => state.trashMode || state.visibleMedia.has(isVideoMedia(item.photo) ? 'video' : 'photo'))
      .filter((item) => state.trashMode || !state.visibleTags.size || itemTags(item).some((tag) => state.visibleTags.has(normalizeMediaTags([tag])[0])));
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
    await window.Portal?.modules?.request?.openProject?.(resolved, {
      tab: options.tab || 'photos',
      routePatch: options.fromFeedViewer ? { photo:null, photoScope:null } : null
    });
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
      .pf-refresh,.pf-toolbar-action{height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;font-size:12px;font-weight:900;cursor:pointer}.pf-toolbar-action{display:flex;align-items:center;gap:8px}.pf-refresh.active,.pf-toolbar-action.active{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .pf-shown-wrap{position:relative}.pf-shown-menu{position:absolute;right:0;top:46px;z-index:30;width:min(520px,calc(100vw - 32px));max-height:min(720px,calc(100vh - 130px));overflow:auto;border:1px solid #e4e7ec;border-radius:16px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.22);padding:8px}.pf-shown-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 10px 12px}.pf-shown-head strong{display:block;font-size:15px;color:#101828}.pf-shown-head span{display:block;margin-top:2px;color:#667085;font-size:12px}.pf-shown-head button{width:32px;height:32px;border:0;border-radius:9px;background:#f2f4f7;color:#475467;cursor:pointer}.pf-shown-section{padding:12px 10px;border-top:1px solid #f2f4f7}.pf-shown-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.pf-shown-section-head>span{display:flex;align-items:center;gap:7px;color:#344054}.pf-shown-section-head>span>i{width:20px;color:#667085;text-align:center}.pf-shown-section-head strong{font-size:12px}.pf-shown-section-head em{font-size:10px;color:#98a2b3;font-style:normal;font-weight:900}.pf-shown-section-head button{border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:1000;cursor:pointer;padding:4px}.pf-shown-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.pf-shown-options>button{min-width:0;height:38px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;padding:0 9px;display:grid;grid-template-columns:18px 18px minmax(0,1fr);align-items:center;gap:7px;text-align:left;font:inherit;font-size:11px;font-weight:900;cursor:pointer}.pf-shown-options>button:hover{background:#f8fafc}.pf-shown-options>button.active{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.06);color:#101828}.pf-shown-check{width:16px;height:16px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;display:flex;align-items:center;justify-content:center}.pf-shown-check i{font-size:8px;opacity:0;color:#fff}.pf-shown-options>button.active .pf-shown-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025)}.pf-shown-options>button.active .pf-shown-check i{opacity:1}
      .pf-upload{height:38px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;font-size:12px;font-weight:900;cursor:pointer;display:flex;align-items:center;gap:8px}.pf-upload:hover{border-color:var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
      .pf-selectionbar{position:sticky;top:52px;z-index:3;margin:0 0 12px;border:1px solid #e4e7ec;border-radius:14px;background:rgba(255,255,255,.96);backdrop-filter:blur(14px);padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .pf-selectionbar strong{font-size:13px}.pf-selection-actions{display:flex;align-items:center;gap:8px}.pf-action{height:34px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 11px;font-size:12px;font-weight:900;cursor:pointer}.pf-action.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}.pf-action.danger{border-color:#fecdca;color:#b42318;background:#fff5f5}.pf-action.danger:hover{background:#fee4e2}.pf-download-wrap{position:relative}.pf-download-menu{position:absolute;right:0;top:40px;z-index:6;width:190px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 18px 44px rgba(15,23,42,.16);padding:6px;display:none}.pf-download-menu.visible{display:block}.pf-download-menu button{width:100%;border:0;background:transparent;border-radius:9px;padding:10px;text-align:left;font-size:12px;font-weight:900;color:#344054;cursor:pointer}.pf-download-menu button:hover{background:#f2f4f7}
      .pf-scroll{overflow:auto;flex:1;padding:0 2px 16px;min-height:0}.pf-day{margin-bottom:26px}.pf-wrap .pf-day-title{font-size:13px;font-weight:700;line-height:1.4;color:#344054;text-transform:none;letter-spacing:0;margin:0 0 16px}.pf-day-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.pf-wrap .pf-day-heading .pf-day-title{margin:0}.pf-day-summary{font-size:12px;font-weight:400;color:#667085;display:flex;gap:14px;flex-wrap:wrap}
      .pf-group{background:#fff;border:1px solid #eaecf0;border-radius:8px;margin-bottom:14px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .pf-group-head{padding:13px 14px;border-bottom:1px solid #f2f4f7;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.pf-group-head strong{font-size:14px}.pf-group-head span{display:block;color:#667085;font-size:12px;margin-top:3px}.pf-project-link{border:0;background:transparent;color:#101828;padding:0;font:inherit;font-size:14px;font-weight:1000;cursor:pointer;text-align:left}.pf-project-link:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}.pf-uploaders{font-size:12px;color:#475467;text-align:right;max-width:320px}.pf-user-link{border:0;background:transparent;color:#475467;padding:0;font:inherit;font-size:12px;font-weight:900;cursor:pointer}.pf-user-link:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}.pf-user-sep{color:#98a2b3}
      .pf-grid{display:grid;gap:6px;padding:8px}.pf-wrap[data-density="loose"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}.pf-wrap[data-density="comfortable"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(154px,1fr))}.pf-wrap[data-density="compact"] .pf-grid{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}
      .pf-feed-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.pf-wrap[data-density="loose"] .pf-feed-grid{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}.pf-wrap[data-density="compact"] .pf-feed-grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.pf-wrap[data-density="list"] .pf-feed-grid{grid-template-columns:1fr;gap:8px;max-width:1050px}
      .pf-feed-card{min-width:0;border:1px solid #eaecf0;border-radius:13px;background:#fff;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.04)}.pf-feed-card .pf-thumb,.pf-document-preview{display:block;width:100%;aspect-ratio:16/11;border:0;border-bottom:1px solid #f2f4f7;border-radius:0;background:#f2f4f7;position:relative;overflow:hidden;cursor:pointer}.pf-feed-card .pf-thumb img,.pf-feed-card .pf-thumb video,.pf-document-preview>img{width:100%;height:100%;object-fit:cover;display:block}.pf-feed-card-body{padding:11px 12px 13px;min-width:0}.pf-feed-card-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.pf-kind{display:flex;align-items:center;gap:6px;color:#475467;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.045em}.pf-feed-card-heading time{color:#98a2b3;font-size:10px;white-space:nowrap}.pf-feed-project{display:block;max-width:100%;border:0;background:transparent;color:#101828;padding:0;font:inherit;font-size:13px;font-weight:1000;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pf-feed-project:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}.pf-feed-subtitle{display:block;color:#667085;font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pf-paired-activity{display:flex;align-items:flex-start;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid #f2f4f7;color:#475467;font-size:10px;line-height:1.35}.pf-paired-activity i{color:var(--primary-readable,var(--primary,#d93025));margin-top:1px}.pf-document-preview{color:#475467}.pf-document-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;background:color-mix(in srgb,var(--feed-doc-color) 7%,#fff);color:var(--feed-doc-color)}.pf-document-icon i{font-size:36px}.pf-document-icon small{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.pf-document-badge{position:absolute;left:9px;bottom:9px;border-radius:999px;background:var(--feed-doc-color);color:#fff;padding:5px 8px;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}.pf-document-title{display:block;color:#101828;font-size:13px;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pf-feed-activity{grid-column:1/-1;display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:11px;border:1px solid #eaecf0;border-radius:13px;background:#fff;padding:11px 12px;box-shadow:0 1px 2px rgba(16,24,40,.03)}.pf-feed-activity-icon{width:42px;height:42px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center}.pf-feed-activity-copy{min-width:0}.pf-feed-activity-copy strong{display:block;color:#101828;font-size:12px}.pf-feed-activity-copy>span{display:block;color:#667085;font-size:11px;margin-top:3px}.pf-feed-notice{margin:0 0 12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#667085;padding:9px 11px;font-size:11px;font-weight:900}.pf-feed-notice i{margin-right:6px}
      .pf-wrap[data-density="compact"] .pf-feed-card-body{padding:8px 9px 10px}.pf-wrap[data-density="compact"] .pf-paired-activity{display:none}.pf-wrap[data-density="list"] .pf-feed-card{display:grid;grid-template-columns:132px minmax(0,1fr);min-height:98px}.pf-wrap[data-density="list"] .pf-feed-card .pf-thumb,.pf-wrap[data-density="list"] .pf-document-preview{height:100%;min-height:98px;aspect-ratio:auto;border:0;border-right:1px solid #f2f4f7}.pf-wrap[data-density="list"] .pf-feed-card-body{display:flex;flex-direction:column;justify-content:center}.pf-wrap[data-density="list"] .pf-feed-card-heading{margin-bottom:5px}.pf-wrap[data-density="list"] .pf-paired-activity{margin-top:6px;padding-top:6px}
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
      .pf-user-activity{height:100%;min-height:0;overflow:auto;padding:2px 4px 18px}.pf-user-empty{min-height:280px;border:1px dashed #d0d5dd;border-radius:14px;color:#667085;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;text-align:center}.pf-user-empty i{font-size:28px;color:#98a2b3}.pf-user-empty strong{color:#344054}.pf-user-empty span{font-size:12px}.pf-activity-day{margin-bottom:22px}.pf-activity-day h3{margin:0 0 10px;color:#344054;font-size:12px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}.pf-activity-item{display:grid;grid-template-columns:38px minmax(0,1fr);gap:11px;padding:12px 0;border-bottom:1px solid #f2f4f7}.pf-activity-item .pf-activity-icon{width:38px;height:38px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;margin-top:0}.pf-activity-item strong{display:block;color:#101828;font-size:13px}.pf-activity-item span{display:block;color:#667085;font-size:12px;margin-top:3px}.pf-activity-links{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.pf-activity-link{height:28px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;padding:0 10px;font-size:11px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.pf-activity-link:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
      .pf-trash-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(15,23,42,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px}
      .pf-trash-shell{width:min(1220px,96vw);height:min(850px,92vh);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
      .pf-trash-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #eaecf0;background:#fff}.pf-trash-head strong{font-size:18px;font-weight:1000;color:#101828}.pf-trash-head span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850}.pf-trash-close{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;cursor:pointer}.pf-trash-body{min-height:0;flex:1;padding:18px;background:#fff}.pf-trash-body .pf-toolbar{position:relative;top:auto}
      .pf-picker-modal{position:fixed;inset:0;background:rgba(15,23,42,.42);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px}
      .pf-picker-shell{width:min(820px,94vw);max-height:min(760px,90vh);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
      .pf-picker-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #eaecf0;background:#fff}.pf-picker-head strong{font-size:18px;font-weight:1000;color:#101828}.pf-picker-head span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850}.pf-picker-close{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .pf-picker-body{min-height:0;flex:1;overflow:auto;padding:14px;background:#fff}.pf-picker-grid{grid-template-columns:repeat(auto-fill,minmax(124px,1fr));padding:0}.pf-picker-foot{display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid #eaecf0;background:#f8fafc}.pf-picker-foot .pf-action:disabled{opacity:.5;cursor:default}
      .pf-picker-error{margin:0 18px 12px;border:1px solid #fed7aa;border-radius:12px;background:#fff7ed;color:#9a3412;padding:9px 11px;font-size:12px;font-weight:900}
      @media(max-width:760px){.pf-user-shell{grid-template-columns:1fr;height:94vh}.pf-user-side{border-right:0;border-bottom:1px solid #eaecf0}.pf-user-main{min-height:420px}}
      @media(max-width:760px){.main-panels:has(#tab_photos_feed.active){padding-top:0}.pf-toolbar{align-items:center;flex-direction:row;gap:10px;padding:10px 12px;margin:0 -12px 18px;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.10);z-index:20}.pf-title{flex:0 0 30px;min-width:0;max-width:none;gap:0}.pf-title>div{display:none}.pf-title i{width:30px;height:30px;border-radius:9px;font-size:14px;flex:0 0 auto}.pf-tools{flex:1 1 auto;width:auto;min-width:0;gap:8px}.pf-search{width:100%;min-width:0;flex:1 1 auto}.pf-search input{height:34px;border-radius:9px;font-size:12px;padding-left:32px}.pf-search i{left:11px}.pf-density,.pf-refresh{display:none}.pf-toolbar-action span{display:none}.pf-shown-menu{position:fixed;left:12px;right:12px;top:74px;width:auto;max-height:calc(100vh - 94px)}.pf-shown-options{grid-template-columns:1fr}.pf-wrap .pf-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px}.pf-feed-grid,.pf-wrap[data-density] .pf-feed-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pf-feed-activity{grid-template-columns:38px minmax(0,1fr);padding:10px}.pf-feed-activity .pf-activity-link{display:none}.pf-feed-card-body{padding:9px}.pf-feed-card-heading time,.pf-paired-activity{display:none}.pf-group-head{flex-direction:column}.pf-uploaders{text-align:left}}
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
      const [result, mediaResult, activityResult, userResult] = await Promise.all([
        window.PlatformAPI.projects.list(oid),
        window.PlatformAPI.media?.list ? window.PlatformAPI.media.list(oid).catch(() => ({ media: [] })) : Promise.resolve({ media: [] }),
        window.PlatformAPI.work?.activity ? window.PlatformAPI.work.activity(oid, { limit:300 }).catch(() => ({ events:[] })) : Promise.resolve({ events:[] }),
        window.PlatformAPI.users?.list ? window.PlatformAPI.users.list(oid).catch(() => ({ documents:[] })) : Promise.resolve({ documents:[] })
      ]);
      const projects = (Array.isArray(result?.documents) ? result.documents : [])
        .filter((doc) => doc && typeof doc === 'object')
        .map(hydrateProject)
        .filter((project) => project && (project.id || project.address || project.title || Array.isArray(project.photos)));
      state.projects = attachOwnedMedia(projects, Array.isArray(mediaResult?.media) ? mediaResult.media : []);
      state.items = buildItems(state.projects);
      state.groups = buildGroups(state.items);
      state.activity = Array.isArray(activityResult?.events) ? activityResult.events : [];
      state.users = (Array.isArray(userResult?.documents) ? userResult.documents : []).map((entry) => objectValue(entry.data && typeof entry.data === 'object' ? { ...entry.data, id:firstText(entry.data.id, entry.id) } : entry));
      state.documents = projectDocumentsFromProjects(state.projects);
      if (state.visibleDocuments.size) await loadFeedDocuments();
      state.loaded = true;
      state.visible = PAGE_SIZE;
      if (options.toast) showToast?.((globalThis.PlatformLanguage?.text("photos","m_1d3d11d1bf93d5","Feed refreshed") ?? "Feed refreshed"));
    } catch (error) {
      console.warn('Could not load feed', error);
      showToast?.((globalThis.PlatformLanguage?.text("photos","m_ee3e1a26fec39e","Feed issue") ?? "Feed issue"), error?.message || 'Could not load feed items.', false);
    } finally {
      state.loading = false;
      render();
      restoreFeedPhotoRoute();
      restoreUserRoute();
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
    if (item.photo?.media_id && !isVideoMedia(item.photo) && window.PlatformAPI?.media?.markupThumbnailUrl) {
      return window.PlatformAPI.media.markupThumbnailUrl(orgId(), item.photo.media_id, 320, markupThumbnailRevisions.get(item.photo.media_id) || '');
    }
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
    const mediaId = cleanText(item.photo?.media_id);
    return `<img loading="lazy" draggable="false"${mediaId ? ` data-markup-thumbnail-media-id="${escapeHtml(mediaId)}"` : ''} src="${escapeHtml(thumb)}" alt="${alt}"${originalAttr}>`;
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
    overlay?.__projectMediaPickerCleanup?.();
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
    const imageOnly = options.imageOnly !== false;
    const uploadAccept = options.accept || (imageOnly ? 'image/*' : 'image/*,video/*');
    const pickerProjectId = cleanText(options.projectId);
    const mergePickerPhotos = (...groups) => {
      const merged = [];
      const ids = new Set();
      groups.flatMap((group) => Array.isArray(group) ? group : []).forEach((photo, index) => {
        const id = pickerIdForPhoto(photo, index);
        if (id && ids.has(id)) return;
        if (id) ids.add(id);
        merged.push(photo);
      });
      return merged;
    };
    const currentPhotos = () => {
      if (typeof options.getPhotos === 'function') {
        const next = options.getPhotos();
        if (Array.isArray(next)) return next;
      }
      return Array.isArray(options.photos) ? options.photos : [];
    };
    const pickerIdForPhoto = (photo, index = 0) => mediaPickerItem(photo, index).id;
    let pickerPhotos = mergePickerPhotos(currentPhotos(), options.photos);
    let items = normalizePickerItems(pickerPhotos, { imageOnly });
    let selected = new Set(Array.isArray(options.selectedIds) ? options.selectedIds.map(cleanText).filter(Boolean) : []);
    let pickerError = '';
    const title = cleanText(options.title || (imageOnly ? 'Select Photos' : 'Select Media'));
    const subtitle = cleanText(options.subtitle || 'Choose media from this project.');
    const refreshItems = () => {
      pickerPhotos = mergePickerPhotos(currentPhotos(), pickerPhotos);
      options.photos = pickerPhotos;
      items = normalizePickerItems(pickerPhotos, { imageOnly });
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
      if (!count) return multiple ? (imageOnly ? 'Select photos' : 'Select media') : (imageOnly ? 'Select photo' : 'Select media');
      return multiple ? `Select ${count} ${imageOnly ? `photo${count === 1 ? '' : 's'}` : `media item${count === 1 ? '' : 's'}`}` : (imageOnly ? 'Select photo' : 'Select media');
    };
    let handle = null;
    const render = () => {
      overlay.innerHTML = `
        <div class="pf-picker-shell" role="dialog" aria-modal="true" aria-label="${String(escapeHtml(title))}">
          <div class="pf-picker-head">
            <div><strong>${String(escapeHtml(title))}</strong>${String(subtitle ? `<span>${escapeHtml(subtitle)}</span>` : '')}</div>
            <button type="button" class="pf-picker-close" data-picker-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
          </div>
          <div class="pf-picker-body">
            ${String(items.length ? `
              <div class="pf-grid pf-picker-grid">
                ${items.map((item) => {
                  const selectedClass = selected.has(item.id) ? ' selected' : '';
                  return `<button type="button" class="pf-thumb${selectedClass}${item.photo?.uploading ? ' uploading' : ''}${isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item) ? ' loaded video-placeholder' : ''}" data-picker-media-id="${escapeHtml(item.id)}" aria-pressed="${selected.has(item.id) ? 'true' : 'false'}"><span class="pf-select"><i class="fas fa-check"></i></span>${mediaThumbHtml(item)}<span class="pf-thumb-meta">${escapeHtml(item.photo?.label || item.photo?.alt || 'Project media')}</span></button>`;
                }).join('')}
              </div>
            ` : `
              <div class="pf-empty">
                <i class="fas fa-images"></i>
                <strong>${imageOnly ? 'No photos available' : 'No media available'}</strong>
                <span>${imageOnly ? 'Upload an image to use it here.' : 'Upload a photo or video to use it here.'}</span>
              </div>
            `)}
          </div>
          ${String(pickerError ? `<div class="pf-picker-error">${escapeHtml(pickerError)}</div>` : '')}
          <div class="pf-picker-foot">
            <button type="button" class="pf-action" data-picker-upload><i class="fas fa-upload"></i>${(globalThis.PlatformLanguage?.text("photos","m_9ca9dace4f122f"," Upload") ?? " Upload")}</button>
            <input type="file" data-picker-file accept="${String(escapeHtml(uploadAccept))}" ${String(multiple ? 'multiple' : '')} hidden>
            <div style="flex:1"></div>
            <button type="button" class="pf-action" data-picker-clear ${String(selected.size ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.text("photos","m_506191e24dd383","Clear") ?? "Clear")}</button>
            <button type="button" class="pf-action primary" data-picker-confirm ${String(selected.size ? '' : 'disabled')}>${String(escapeHtml(confirmLabel()))}</button>
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
        const result = options.onConfirm?.(chosen, selectedIds);
        if (result === false) {
          pickerError = `Could not apply that ${imageOnly ? 'image' : 'media'} yet. Please wait a moment and try again.`;
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
          // An upload can complete before the owning project model has propagated
          // its refreshed photo list. Keep the returned media in this picker so
          // the newly uploaded image is visible and selectable immediately.
          const freshPhotos = currentPhotos();
          pickerPhotos = mergePickerPhotos(freshPhotos, pickerPhotos, added);
          options.photos = pickerPhotos;
          items = normalizePickerItems(pickerPhotos, { imageOnly });
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
    const eventMatchesPicker = (event) => {
      const eventProjectId = cleanText(event?.detail?.projectId);
      return !pickerProjectId || !eventProjectId || pickerProjectId === eventProjectId;
    };
    const onUploadStarted = (event) => {
      if (!eventMatchesPicker(event)) return;
      const photos = Array.isArray(event?.detail?.photos) ? event.detail.photos : [];
      if (!photos.length) return;
      pickerPhotos = mergePickerPhotos(pickerPhotos, photos);
      options.photos = pickerPhotos;
      items = normalizePickerItems(pickerPhotos, { imageOnly });
      render();
    };
    const onUploadResolved = (event) => {
      if (!eventMatchesPicker(event)) return;
      const placeholderId = cleanText(event?.detail?.placeholderId);
      const photo = event?.detail?.photo;
      if (!placeholderId || !photo) return;
      const wasSelected = selected.delete(placeholderId);
      pickerPhotos = mergePickerPhotos(
        pickerPhotos.filter((entry, index) => pickerIdForPhoto(entry, index) !== placeholderId),
        [photo]
      );
      const mediaId = pickerIdForPhoto(photo);
      if (wasSelected && mediaId) selected.add(mediaId);
      options.photos = pickerPhotos;
      items = normalizePickerItems(pickerPhotos, { imageOnly });
      render();
    };
    window.addEventListener('fm:project-media-upload-started', onUploadStarted);
    window.addEventListener('fm:project-media-upload-resolved', onUploadResolved);
    overlay.__projectMediaPickerCleanup = () => {
      window.removeEventListener('fm:project-media-upload-started', onUploadStarted);
      window.removeEventListener('fm:project-media-upload-resolved', onUploadResolved);
      overlay.__projectMediaPickerCleanup = null;
    };
    document.body.appendChild(overlay);
    handle = window.Portal?.modals?.register?.(overlay, { id: options.id || 'project-media-picker', onClose: () => closeProjectMediaPicker(overlay, null, options.onClose) });
    render();
    return {
      close: () => closeProjectMediaPicker(overlay, handle, options.onClose),
      refresh(nextPhotos = options.photos || []){
        pickerPhotos = mergePickerPhotos(nextPhotos, pickerPhotos.filter((photo) => photo?.uploading));
        options.photos = pickerPhotos;
        items = normalizePickerItems(pickerPhotos, { imageOnly });
        render();
      },
    };
  }
  function renderGroup(group, options = {}){
    const enableProjectLinks = options.enableProjectLinks ?? state.enableProjectLinks;
    const selectedSet = options.selected || state.selected;
    const selectionEnabled = options.selectionEnabled !== false;
    const projectKey = group.key || `${group.dateKey}::${group.projectId || group.projectTitle}`;
    const projectButton = enableProjectLinks === false
      ? `<strong>${escapeHtml(group.projectTitle)}</strong>`
      : `<button type="button" class="pf-project-link" data-photo-project-open="${escapeHtml(projectKey)}">${escapeHtml(group.projectTitle)}</button>`;
    const itemNoun = cleanText(options.itemNoun || 'media item');
    const fallbackSubtitle = `${group.items.length} ${itemNoun}${group.items.length === 1 ? '' : 's'}`;
    const subtitle = cleanText(group.projectSubtitle || group.projectAddress);
    const groupUploaders = typeof options.renderGroupUploaders === 'function'
      ? options.renderGroupUploaders(group)
      : `<i class="fas fa-user"></i> ${userListHtml(group.items)}`;
    return `
      <section class="pf-group">
        <div class="pf-group-head">
          <div>${projectButton}<span>${escapeHtml(subtitle && subtitle.toLowerCase() !== cleanText(group.projectTitle).toLowerCase() ? subtitle : fallbackSubtitle)}</span></div>
          <div class="pf-uploaders">${groupUploaders}</div>
        </div>
        <div class="pf-grid">
          ${group.items.map((item) => {
            const up = uploader(item.photo);
            const selected = selectedSet.has(item.id);
            const thumbnail = typeof options.renderThumbnail === 'function' ? options.renderThumbnail(item) : mediaThumbHtml(item);
            const meta = typeof options.renderTileMeta === 'function'
              ? options.renderTileMeta(item)
              : `${escapeHtml(up.name || up.email || 'Unknown')}<br>${escapeHtml(item.photo?.uploading ? 'Uploading...' : (window.FirstMateMarkup?.formatDateTime?.(item.uploadedAt) || ''))}`;
            const extraClass = cleanText(typeof options.tileClass === 'function' ? options.tileClass(item) : options.tileClass);
            return `<button type="button" class="pf-thumb${extraClass ? ` ${escapeHtml(extraClass)}` : ''}${selected ? ' selected' : ''}${item.photo?.uploading ? ' uploading' : ''}${isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item) ? ' loaded video-placeholder' : ''}" data-photo-feed-id="${escapeHtml(item.id)}"${selectionEnabled ? ` aria-pressed="${selected ? 'true' : 'false'}"` : ''}>${selectionEnabled ? `<span class="pf-select" data-photo-select="${escapeHtml(item.id)}"><i class="fas fa-check"></i></span>` : ''}${thumbnail}<span class="pf-thumb-meta">${meta}</span></button>`;
          }).join('')}
        </div>
      </section>
    `;
  }
  function pairedActivityHtml(event = {}){
    if (!event || typeof event !== 'object') return '';
    return `<span class="pf-paired-activity"><i class="fas ${feedActivityIcon(event)}"></i>${escapeHtml(feedActivitySummary(event))}</span>`;
  }
  function feedMediaEntryHtml(entry = {}){
    const item = entry.mediaItem;
    const up = uploader(item.photo);
    const selected = state.selected.has(item.id);
    return `
      <article class="pf-feed-card pf-feed-media-card">
        <button type="button" class="pf-thumb${selected ? ' selected' : ''}${item.photo?.uploading ? ' uploading' : ''}${isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item) ? ' loaded video-placeholder' : ''}" data-photo-feed-id="${escapeHtml(item.id)}" aria-pressed="${selected ? 'true' : 'false'}">
          <span class="pf-select" data-photo-select="${escapeHtml(item.id)}"><i class="fas fa-check"></i></span>
          ${mediaThumbHtml(item)}
          <span class="pf-thumb-meta">${escapeHtml(up.name || up.email || 'Unknown')}<br>${escapeHtml(window.FirstMateMarkup?.formatDateTime?.(item.uploadedAt) || '')}</span>
        </button>
        <div class="pf-feed-card-body">
          <div class="pf-feed-card-heading"><span class="pf-kind"><i class="fas ${isVideoMedia(item.photo) ? 'fa-video' : 'fa-image'}"></i>${isVideoMedia(item.photo) ? 'Video' : 'Photo'}</span><time>${escapeHtml(activityTime(entry.timestamp))}</time></div>
          <button type="button" class="pf-feed-project" data-feed-project-id="${escapeHtml(entry.projectId)}">${escapeHtml(projectTitle(entry.project))}</button>
          <span class="pf-feed-subtitle">${escapeHtml(projectSubtitle(entry.project) || item.projectAddress || '')}</span>
          ${pairedActivityHtml(entry.pairedEvent)}
        </div>
      </article>`;
  }
  function documentPreviewHtml(doc = {}){
    const url = documentUrl(doc);
    const image = cleanText(doc.content_type || doc.mime_type).startsWith('image/') || /\.(png|jpe?g|webp|gif)(?:$|[?#])/i.test(firstText(doc.file_name, url));
    const thumbnail = doc.media_id && window.PlatformAPI?.media?.thumbnailUrl ? window.PlatformAPI.media.thumbnailUrl(orgId(), doc.media_id, 480) : url;
    if (image && thumbnail) return `<img loading="lazy" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(doc.title || (globalThis.PlatformLanguage?.text("photos","m_9c9b98b1f4e8c9","Document") ?? "Document"))}">`;
    return `<span class="pf-document-icon" style="--feed-doc-color:${escapeHtml(doc.color || '#64748b')}"><i class="fas ${escapeHtml(doc.icon || 'fa-file-lines')}"></i><small>${escapeHtml(doc.type_label || 'Document')}</small></span>`;
  }
  function feedDocumentEntryHtml(entry = {}){
    const doc = entry.document;
    return `
      <article class="pf-feed-card pf-feed-document-card">
        <button type="button" class="pf-document-preview" data-feed-document-id="${escapeHtml(entry.id)}"${doc.url ? '' : ' aria-disabled="true"'}>
          ${documentPreviewHtml(doc)}
          <span class="pf-document-badge" style="--feed-doc-color:${escapeHtml(doc.color || '#64748b')}">${escapeHtml(doc.type_label || 'Document')}</span>
        </button>
        <div class="pf-feed-card-body">
          <div class="pf-feed-card-heading"><span class="pf-kind"><i class="fas ${escapeHtml(doc.icon || 'fa-file-lines')}"></i>${escapeHtml(doc.type_label || 'Document')}</span><time>${escapeHtml(activityTime(entry.timestamp))}</time></div>
          <strong class="pf-document-title">${escapeHtml(doc.title || (globalThis.PlatformLanguage?.text("photos","m_9c9b98b1f4e8c9","Document") ?? "Document"))}</strong>
          <button type="button" class="pf-feed-project" data-feed-project-id="${escapeHtml(entry.projectId)}">${escapeHtml(projectTitle(entry.project))}</button>
          ${pairedActivityHtml(entry.pairedEvent)}
        </div>
      </article>`;
  }
  function feedActivityEntryHtml(entry = {}){
    const event = entry.event;
    const projectLabel = activityProjectLabel(event);
    return `
      <article class="pf-feed-activity">
        <span class="pf-feed-activity-icon"><i class="fas ${feedActivityIcon(event)}"></i></span>
        <div class="pf-feed-activity-copy">
          <strong>${escapeHtml(feedActivitySummary(event))}</strong>
          <span>${escapeHtml([projectLabel, activityTime(entry.timestamp)].filter(Boolean).join(' · '))}</span>
        </div>
        ${entry.projectId ? `<button type="button" class="pf-activity-link" data-feed-project-id="${String(escapeHtml(entry.projectId))}"><i class="fas fa-folder-open"></i>${(globalThis.PlatformLanguage?.text("photos","m_53787840db7d1c"," Open project") ?? " Open project")}</button>` : ''}
      </article>`;
  }
  function dynamicHtml(options = {}){
    const entries = feedEntries();
    const visibleEntries = entries.slice(0, state.visible);
    const dayGroups = groupedFeedEntries(visibleEntries);
    const selectedCount = state.selected.size;
    const selectionActions = state.trashMode
      ? `<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("photos","m_d55efd8791e299"," Restore") ?? " Restore")}</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("photos","m_4e4c97a39c03c8"," Delete Forever") ?? " Delete Forever")}</button>`
      : `<button type="button" class="pf-action danger" data-selection-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("photos","m_90e27d705bee80"," Delete") ?? " Delete")}</button><div class="pf-download-wrap">
          <button type="button" class="pf-action primary" data-selection-download><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.text("photos","m_f3ad10eaad3ccf"," Download") ?? " Download")}</button>
          <div class="pf-download-menu${String(state.downloadMenuOpen ? ' visible' : '')}" data-selection-download-menu>
            <button type="button" data-download-selected-plain>${(globalThis.PlatformLanguage?.text("photos","m_c94e82190b64cc","Without markup") ?? "Without markup")}</button>
            <button type="button" data-download-selected-markup>${(globalThis.PlatformLanguage?.text("photos","m_42e3382f311f77","With markup") ?? "With markup")}</button>
          </div>
        </div>`;
    return `
      ${state.selectionMode ? `<div class="pf-selectionbar">
        <strong>${((v0) => globalThis.PlatformLanguage?.text("photos","m_4b740d0b3ec319",`${v0} selected`,{v0}) ?? `${v0} selected`)(selectedCount)}</strong>
        <div class="pf-selection-actions">
          <button type="button" class="pf-action" data-selection-clear>${(globalThis.PlatformLanguage?.text("photos","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
          ${String(selectionActions)}
        </div>
      </div>` : ''}
      <div class="pf-scroll" data-feed-scroll>
        ${state.loading && !state.loaded ? `<div class="pf-loading">${(globalThis.PlatformLanguage?.text("photos","m_d9f4b62b1c74a0","Loading your feed...") ?? "Loading your feed...")}</div>` : ''}
        ${state.documentsLoading ? `<div class="pf-feed-notice"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("photos","m_c134b013b4dd64"," Adding project documents…") ?? " Adding project documents…")}</div>` : ''}
        ${!state.loading && state.loaded && !entries.length ? `<div class="pf-empty"><i class="fas fa-filter-circle-xmark"></i><strong>${(globalThis.PlatformLanguage?.text("photos","m_1a6a017a3c3609","Nothing matches what is shown") ?? "Nothing matches what is shown")}</strong><div>${(globalThis.PlatformLanguage?.text("photos","m_e66cd5073679a3","Adjust the Shown menu or search to bring more items into your feed.") ?? "Adjust the Shown menu or search to bring more items into your feed.")}</div></div>` : ''}
        ${dayGroups.map(([key, list]) => `<div class="pf-day"><h2 class="pf-day-title">${escapeHtml(dateLabel(key))}</h2><div class="pf-feed-grid">${list.map((entry) => entry.kind === 'media' ? feedMediaEntryHtml(entry) : (entry.kind === 'document' ? feedDocumentEntryHtml(entry) : feedActivityEntryHtml(entry))).join('')}</div></div>`).join('')}
        ${entries.length > state.visible ? '<div class="pf-sentinel" data-feed-sentinel></div>' : ''}
      </div>`;
  }
  function openFeedViewerAt(index, options = {}){
    const items = filteredItems();
    const safeIndex = Math.max(0, Math.min(Number(index || 0), Math.max(0, items.length - 1)));
    const item = items[safeIndex];
    if (!item) return null;
    if (!options.fromRoute) updatePhotoRoute(item, 'feed', { history:'push', source:'photo-open' });
    if (state.activeFeedViewer) {
      state.closingFeedViewerFromRoute = true;
      state.activeFeedViewer.close?.();
    }
    state.activeFeedViewer = window.FirstMateMarkup?.openPhotoViewer?.({
      photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
      index: safeIndex,
      project: item.project || {},
      onOpenProject: async (project) => {
        state.openingProjectFromFeedViewer = true;
        try {
          await openProject(project, { fromFeedViewer:true });
        } catch (error) {
          console.warn('Could not open photo project', error);
          showToast?.((globalThis.PlatformLanguage?.text("photos","m_6c0b3254cc1aac","Project unavailable") ?? "Project unavailable"), error?.message || 'Could not open this project.', false);
        } finally {
          state.openingProjectFromFeedViewer = false;
        }
      },
      onChange: ({ photo, project }) => updatePhotoRoute({ photo, project: project || photo?.__project || item.project }, 'feed'),
      onTagsChange: ({ photo, tags }) => saveMediaTags(photo, tags),
      onClose: () => {
        state.routeRestoreKey = '';
        state.activeFeedViewer = null;
        if (!state.closingFeedViewerFromRoute && !state.openingProjectFromFeedViewer) closePhotoRoute('feed');
        state.closingFeedViewerFromRoute = false;
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
    return state.activeFeedViewer;
  }
  function restoreFeedPhotoRoute(){
    const route = window.Portal?.routeState?.get?.() || {};
    if (!route.photo || route.photoScope !== 'feed') {
      if (state.activeFeedViewer) {
        state.closingFeedViewerFromRoute = true;
        state.activeFeedViewer.close?.();
      }
      state.routeRestoreKey = '';
      return;
    }
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
  function shownGroupHtml(group, title, icon, items = [], selected = new Set()){
    const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
    const count = items.filter((item) => selected.has(item.id)).length;
    return `
      <section class="pf-shown-section">
        <div class="pf-shown-section-head">
          <span><i class="fas ${String(icon)}"></i><strong>${String(escapeHtml(title))}</strong><em>${((v2,v3) => globalThis.PlatformLanguage?.text("photos","m_f624acebda7242",`${v2} of ${v3}`,{v2,v3}) ?? `${v2} of ${v3}`)(count,items.length)}</em></span>
          <button type="button" data-feed-filter-group="${String(escapeHtml(group))}" data-filter-group-action="${String(allSelected ? 'none' : 'all')}">${String(allSelected ? 'Hide all' : 'Show all')}</button>
        </div>
        <div class="pf-shown-options">
          ${String(items.map((item) => `<button type="button" class="${selected.has(item.id) ? 'active' : ''}" data-feed-filter-group="${escapeHtml(group)}" data-feed-filter-id="${escapeHtml(item.id)}" aria-pressed="${selected.has(item.id) ? 'true' : 'false'}"><span class="pf-shown-check"><i class="fas fa-check"></i></span><i class="fas ${escapeHtml(item.icon)}"></i><span>${escapeHtml(item.label)}</span></button>`).join(''))}
        </div>
      </section>`;
  }
  function shownMenuHtml(){
    if (!state.shownMenuOpen) return '';
    const mediaItems = [
      { id:'photo', label:(globalThis.PlatformLanguage?.text("photos","m_be4cfb58b9c4d7","Photos") ?? "Photos"), icon:'fa-image' },
      { id:'video', label:(globalThis.PlatformLanguage?.text("photos","m_f5b923450deb7f","Videos") ?? "Videos"), icon:'fa-video' }
    ];
    return `
      <div class="pf-shown-menu" data-feed-shown-menu>
        <div class="pf-shown-head"><div><strong>${(globalThis.PlatformLanguage?.text("photos","m_80fdf3a3a8501b","Items shown") ?? "Items shown")}</strong><span>${(globalThis.PlatformLanguage?.text("photos","m_f1b0e54bf174a7","Build the feed your team needs.") ?? "Build the feed your team needs.")}</span></div><button type="button" data-feed-shown-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        ${String(shownGroupHtml('media', 'Media', 'fa-photo-film', mediaItems, state.visibleMedia))}
        ${String(shownGroupHtml('tags', 'Media tags', 'fa-tags', mediaTagOptions(state.items, state.visibleTags), state.visibleTags))}
        ${String(shownGroupHtml('activity', 'Activity', 'fa-clock-rotate-left', ACTIVITY_FILTERS, state.visibleActivity))}
        ${String(shownGroupHtml('documents', 'Documents', 'fa-folder-open', DOCUMENT_FILTERS, state.visibleDocuments))}
      </div>`;
  }
  function render(){
    if (!state.root) return;
    const visibleCount = feedEntries().length;
    state.root.innerHTML = `
      <div class="pf-wrap${String(state.selectionMode ? ' selection-mode' : '')}" data-density="${String(escapeHtml(state.density))}">
        <div class="pf-toolbar">
          <div class="pf-title"><i class="fas ${String(escapeHtml(state.icon || 'fa-layer-group'))}"></i><div><strong>${String(escapeHtml(state.title || 'Feed'))}</strong><span>${String(escapeHtml(state.subtitle || `${visibleCount} item${visibleCount === 1 ? '' : 's'} shown`))}</span></div></div>
          <div class="pf-tools">
            <label class="pf-search"><i class="fas fa-search"></i><input type="search" value="${String(escapeHtml(state.query))}" placeholder="${(globalThis.PlatformLanguage?.text("photos","m_3fb1d572340b7f","Search feed") ?? "Search feed")}"></label>
            <div class="pf-density">
              ${String([
                { id: 'loose', label: 'Loose', icon: 'border-all' },
                { id: 'comfortable', label: 'Comfortable', icon: 'grip' },
                { id: 'compact', label: 'Compact', icon: 'table-cells' },
                { id: 'list', label: 'List', icon: 'list' }
              ].map((mode) => `<button type="button" class="${state.density === mode.id ? 'active' : ''}" data-density="${mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join(''))}
            </div>
            <div class="pf-shown-wrap">
              <button type="button" class="pf-toolbar-action${String(state.shownMenuOpen || state.visibleTags.size || state.visibleDocuments.size || state.visibleMedia.size < DEFAULT_MEDIA_FILTERS.length || state.visibleActivity.size < DEFAULT_ACTIVITY_FILTERS.length ? ' active' : '')}" data-feed-shown aria-expanded="${String(state.shownMenuOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i><span>${(globalThis.PlatformLanguage?.text("photos","m_092ad4c2ce9c6b","Shown") ?? "Shown")}</span></button>
              ${String(shownMenuHtml())}
            </div>
            ${String(state.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(state.uploadLabel)}</button>` : '')}
            ${String(state.onUpload ? '' : '<button type="button" class="pf-refresh" data-refresh><i class="fas fa-rotate"></i></button>')}
          </div>
        </div>
        <div data-photo-feed-dynamic>${String(dynamicHtml())}</div>
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
      writeFeedPreferences();
      render();
    }));
    rootEl.querySelector('[data-feed-shown]')?.addEventListener('click', () => {
      state.shownMenuOpen = !state.shownMenuOpen;
      render();
    });
    rootEl.querySelector('[data-feed-shown-close]')?.addEventListener('click', () => {
      state.shownMenuOpen = false;
      render();
    });
    rootEl.querySelectorAll('[data-feed-filter-id]').forEach((button) => button.addEventListener('click', () => {
      const group = button.dataset.feedFilterGroup || '';
      const id = button.dataset.feedFilterId || '';
      const selected = group === 'media' ? state.visibleMedia : (group === 'activity' ? state.visibleActivity : (group === 'tags' ? state.visibleTags : state.visibleDocuments));
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      state.visible = PAGE_SIZE;
      writeFeedPreferences();
      if (group === 'documents' && selected.has(id) && !state.documentsLoaded) void loadFeedDocuments();
      render();
    }));
    rootEl.querySelectorAll('[data-filter-group-action]').forEach((button) => button.addEventListener('click', () => {
      const group = button.dataset.feedFilterGroup || '';
      const ids = group === 'media' ? DEFAULT_MEDIA_FILTERS : (group === 'activity' ? DEFAULT_ACTIVITY_FILTERS : (group === 'tags' ? mediaTagOptions(state.items, state.visibleTags).map((entry) => entry.id) : DOCUMENT_FILTERS.map((entry) => entry.id)));
      const selected = group === 'media' ? state.visibleMedia : (group === 'activity' ? state.visibleActivity : (group === 'tags' ? state.visibleTags : state.visibleDocuments));
      selected.clear();
      if (button.dataset.filterGroupAction === 'all') ids.forEach((id) => selected.add(id));
      state.visible = PAGE_SIZE;
      writeFeedPreferences();
      if (group === 'documents' && selected.size && !state.documentsLoaded) void loadFeedDocuments();
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
    rootEl.querySelectorAll('[data-feed-project-id]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = cleanText(btn.dataset.feedProjectId);
        const project = projectForId(id);
        openProject(project, { groupKey:id, tab:'photos' }).catch((error) => {
          console.warn('Could not open project from Feed', error);
          showToast?.((globalThis.PlatformLanguage?.text("photos","m_3d2585ab4e8b80","Project issue") ?? "Project issue"), error?.message || 'Could not open that project.', false);
        });
      });
    });
    rootEl.querySelectorAll('[data-feed-document-id]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const id = cleanText(btn.dataset.feedDocumentId);
        const entry = feedEntries().find((item) => item.id === id);
        if (!entry?.document) return;
        if (entry.document.url) {
          window.open(entry.document.url, '_blank', 'noopener');
          return;
        }
        openProject(entry.project, { groupKey:entry.projectId, tab:'docs' }).catch(() => null);
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
          showToast?.((globalThis.PlatformLanguage?.text("photos","m_3d2585ab4e8b80","Project issue") ?? "Project issue"), error?.message || 'Could not open that project.', false);
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
        const user = uploaderUsers(items)[0] || { key, name: btn.textContent || (globalThis.PlatformLanguage?.text("photos","m_dfd6687ea85fad","User") ?? "User") };
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
      showToast?.((globalThis.PlatformLanguage?.text("photos","m_de25a6a2b4b2ce","Media downloaded") ?? "Media downloaded"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_75fdc317b24fbd",`${v0} item${v1} prepared.`,{v0,v1}) ?? `${v0} item${v1} prepared.`)(items.length,items.length === 1 ? '' : 's'), true);
    } catch (error) {
      console.warn('Photo download failed', error);
      showToast?.((globalThis.PlatformLanguage?.text("photos","m_01bd3117125ba8","Download failed") ?? "Download failed"), error?.message || 'Could not download selected media.', false);
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
    const ok = await (window.PlatformUI?.confirm?.(((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_25d73fd9f0ab17",`Move ${v0} media item${v1} to trash? They will still count toward storage until the trash is emptied.`,{v0,v1}) ?? `Move ${v0} media item${v1} to trash? They will still count toward storage until the trash is emptied.`)(items.length,items.length === 1 ? '' : 's'), {
      title: (globalThis.PlatformLanguage?.text("photos","m_f46cc145599314","Delete Media") ?? "Delete Media"),
      okLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
      danger: true
    }) || Promise.resolve(confirm(((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_816965d2c9412c",`Move ${v0} media item${v1} to trash?`,{v0,v1}) ?? `Move ${v0} media item${v1} to trash?`)(items.length,items.length === 1 ? '' : 's'))));
    if (!ok) return { count: 0, bytes: 0 };
    const result = await mutatePhotoItems(items, 'trash', options);
    showToast?.((globalThis.PlatformLanguage?.text("photos","m_e6ced0d83aa8e5","Moved to trash") ?? "Moved to trash"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_43d21e107c88ec",`${v0} media item${v1} moved.`,{v0,v1}) ?? `${v0} media item${v1} moved.`)(result.count,result.count === 1 ? '' : 's'), true);
    return result;
  }
  async function restoreItems(items = [], options = {}){
    const result = await mutatePhotoItems(items, 'restore', options);
    showToast?.((globalThis.PlatformLanguage?.text("photos","m_098dff4e70719e","Restored") ?? "Restored"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_32b7225187968f",`${v0} media item${v1} restored.`,{v0,v1}) ?? `${v0} media item${v1} restored.`)(result.count,result.count === 1 ? '' : 's'), true);
    return result;
  }
  async function hardDeleteItems(items = [], options = {}){
    if (!items.length) return { count: 0, bytes: 0 };
    const ok = await (window.PlatformUI?.confirm?.(((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_9b90c1a8e966ac",`Permanently delete ${v0} media item${v1}? This cannot be undone.`,{v0,v1}) ?? `Permanently delete ${v0} media item${v1}? This cannot be undone.`)(items.length,items.length === 1 ? '' : 's'), {
      title: (globalThis.PlatformLanguage?.text("photos","m_b46b81caf87da4","Empty Trash") ?? "Empty Trash"),
      okLabel: 'Delete Forever',
      cancelLabel: 'Cancel',
      danger: true
    }) || Promise.resolve(confirm(((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_f2c5d6c4baea41",`Permanently delete ${v0} media item${v1}?`,{v0,v1}) ?? `Permanently delete ${v0} media item${v1}?`)(items.length,items.length === 1 ? '' : 's'))));
    if (!ok) return { count: 0, bytes: 0 };
    const result = await mutatePhotoItems(items, 'hard_delete', options);
    showToast?.((globalThis.PlatformLanguage?.text("photos","m_3f67e34639ad71","Deleted forever") ?? "Deleted forever"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_11aab462b7e7b1",`${v0} media item${v1} removed.`,{v0,v1}) ?? `${v0} media item${v1} removed.`)(result.count,result.count === 1 ? '' : 's'), true);
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
          <div><strong><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("photos","m_89e3b5685a73e8"," Trash") ?? " Trash")}</strong><span data-trash-summary>${((v0,v1,v2) => globalThis.PlatformLanguage?.text("photos","m_bb5db1f723b03a",`${v0} media item${v1} | ${v2}`,{v0,v1,v2}) ?? `${v0} media item${v1} | ${v2}`)(escapeHtml(currentStats.count),currentStats.count === 1 ? '' : 's',escapeHtml(formatBytes(currentStats.bytes)))}</span></div>
          <div class="pf-selection-actions">
            <button type="button" class="pf-action danger" data-trash-empty><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("photos","m_fe9f87c79c5388"," Empty Trash") ?? " Empty Trash")}</button>
            <button type="button" class="pf-trash-close" data-trash-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_bef1bdc6b4d7cc","Close trash") ?? "Close trash")}"><i class="fas fa-times"></i></button>
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
      if (summary) summary.textContent = ((v0,v1,v2) => globalThis.PlatformLanguage?.text("photos","m_bb5db1f723b03a",`${v0} media item${v1} | ${v2}`,{v0,v1,v2}) ?? `${v0} media item${v1} | ${v2}`)(stats.count,stats.count === 1 ? '' : 's',formatBytes(stats.bytes));
    };
    const remount = () => {
      mountProjectGallery(modal.querySelector('[data-trash-feed]'), {
        projects: state.projects,
        title: (globalThis.PlatformLanguage?.text("photos","m_2d388bb64c08d8","Trash") ?? "Trash"),
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
  async function openUserModal(user = {}, items = [], options = {}){
    if (!userModalsEnabled()) return;
    injectStyles();
    state.activeUserModal?.close?.({ fromRoute:true });
    document.getElementById('pfUserModal')?.remove();
    const enriched = await enrichUser(user);
    if (!items.length && !state.loaded && !state.loading) await load().catch(() => null);
    const name = cleanText(enriched.name || enriched.label || enriched.email || 'User');
    const email = cleanText(enriched.email || '');
    const avatar = cleanText(enriched.avatar || enriched.avatar_url || enriched.photo_url || enriched.profile_photo_url || enriched.raw?.avatar || enriched.raw?.avatar_url);
    const initial = (name || email || '?').slice(0, 1).toUpperCase();
    const showActivity = userActivityEnabled();
    const userRouteKey = cleanText(enriched.id || enriched.email || enriched.name);
    const modal = document.createElement('div');
    modal.id = 'pfUserModal';
    modal.className = 'pf-user-modal';
    modal.innerHTML = `
      <div class="pf-user-shell">
        <aside class="pf-user-side">
          <div class="pf-user-avatar">${String(avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initial))}</div>
          <div class="pf-user-name">${String(escapeHtml(name))}</div>
          <div class="pf-user-contact">
            ${String(email ? `<span><i class="fas fa-envelope"></i> ${escapeHtml(email)}</span>` : '')}
            ${String(enriched.id ? `<span><i class="fas fa-id-card"></i> ${escapeHtml(enriched.id)}</span>` : '')}
          </div>
        </aside>
        <main class="pf-user-main">
          <div class="pf-user-main-head">
            <div class="pf-user-main-title">${(globalThis.PlatformLanguage?.text("photos","m_6f5dea53bf13f4","Profile") ?? "Profile")}</div>
            <div class="pf-user-head-actions">
              <div class="pf-user-tabs">
                <button type="button" class="pf-user-tab active" data-user-tab="photos">${String(escapeHtml(window.Portal?.terminology?.get?.('photos.photos_view', 'Photos') || 'Photos'))}</button>
                ${String(showActivity ? `<button type="button" class="pf-user-tab" data-user-tab="activity">${escapeHtml(window.Portal?.terminology?.get?.('photos.activity_view', 'Activity') || 'Activity')}</button>` : '')}
              </div>
              <button type="button" class="pf-user-close" data-user-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_f7d93ca06bc15a","Close user") ?? "Close user")}"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div class="pf-user-panel" data-user-panel></div>
        </main>
      </div>`;
    document.body.appendChild(modal);
    let modalHandle = null;
    const close = (closeOptions = {}) => {
      modalHandle?.unregister?.();
      modalHandle = null;
      modal.remove();
      if (state.activeUserModal?.element === modal) state.activeUserModal = null;
      if (!closeOptions.fromRoute && !window.Portal?.navigation?.applying) {
        window.Portal?.navigation?.backOrClose?.(['user'], { user:null, userTab:null }, { source:'user-profile-close' });
      }
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
    const showPhotos = (tabOptions = {}) => {
      setActive('photos');
      if (tabOptions.updateRoute !== false && !window.Portal?.navigation?.applying) window.Portal?.navigation?.push?.({ userTab:'photos' }, { source:'user-profile-tab', ownedKeys:['userTab'] });
      panel.innerHTML = '<div data-user-photos style="height:100%;min-height:0"></div>';
      mountProjectGallery(panel.querySelector('[data-user-photos]'), {
        projects: projectsFromUserItems(userItems),
        title: (globalThis.PlatformLanguage?.text("photos","m_2c66a61e57fe2c","Uploaded Media") ?? "Uploaded Media"),
        uploadLabel: '',
        enableProjectLinks: true
      });
    };
    const showActivityTab = async (tabOptions = {}) => {
      setActive('activity');
      if (tabOptions.updateRoute !== false && !window.Portal?.navigation?.applying) window.Portal?.navigation?.push?.({ userTab:'activity' }, { source:'user-profile-tab', ownedKeys:['userTab'] });
      panel.innerHTML = `<div class="pf-user-activity"><div class="pf-loading">${(globalThis.PlatformLanguage?.text("photos","m_a74d3976fbbe47","Loading activity...") ?? "Loading activity...")}</div></div>`;
      const root = panel.querySelector('.pf-user-activity');
      const result = await window.PlatformAPI?.userActivity?.listForUser?.(orgId(), enriched, { limit: 200 }).catch((error) => ({ error }));
      if (result?.error) {
        root.innerHTML = `<div class="pf-user-empty"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("photos","m_1fc5d851a4ed4e","Could not load activity") ?? "Could not load activity")}</strong><span>${String(escapeHtml(result.error?.message || 'Try again in a moment.'))}</span></div>`;
        return;
      }
      const events = result?.events || [];
      root.innerHTML = renderActivityList(events);
      bindActivityLinks(root, events);
    };
    modal.querySelector('[data-user-tab="photos"]')?.addEventListener('click', showPhotos);
    modal.querySelector('[data-user-tab="activity"]')?.addEventListener('click', showActivityTab);
    state.activeUserModal = {
      element:modal,
      key:userRouteKey,
      close,
      setTab:(tab) => tab === 'activity' && showActivity ? showActivityTab({ updateRoute:false }) : showPhotos({ updateRoute:false })
    };
    if (!options.fromRoute && userRouteKey) window.Portal?.navigation?.push?.({ user:userRouteKey, userTab:'photos' }, { source:'user-profile-open', ownedKeys:['user','userTab'] });
    state.activeUserModal.setTab(options.tab || window.Portal?.navigation?.read?.().userTab || 'photos');
  }
  function mount(panel){
    injectStyles();
    state.observer?.disconnect?.();
    state.root = panel;
    state.projects = [];
    state.items = [];
    state.groups = [];
    state.documents = [];
    state.activity = [];
    state.users = [];
    state.query = '';
    state.density = 'comfortable';
    state.shownMenuOpen = false;
    state.visibleMedia = new Set(DEFAULT_MEDIA_FILTERS);
    state.visibleTags = new Set();
    state.visibleDocuments = new Set();
    state.visibleActivity = new Set(DEFAULT_ACTIVITY_FILTERS);
    state.documentsLoading = false;
    state.documentsLoaded = false;
    state.visible = PAGE_SIZE;
    state.loaded = false;
    state.loading = false;
    state.selected = new Set();
    state.selectionMode = false;
    state.title = (globalThis.PlatformLanguage?.text("photos","m_3eea4dfd8e947d","Feed") ?? "Feed");
    state.subtitle = '';
    state.icon = 'fa-layer-group';
    state.uploadLabel = '';
    state.onUpload = null;
    state.enableProjectLinks = true;
    state.trashMode = false;
    state.routeRestoreKey = '';
    applyFeedRoute();
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
      items: buildItems(sourceProjects, { includeReceipts:options.includeReceipts === true }),
      query: '',
      density: cleanText(options.initialDensity || 'comfortable'),
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
      routeRestoreKey: '',
      tagMenuOpen: false,
      visibleTags: new Set(cleanText(options.routeScope) === 'project'
        ? cleanText(window.Portal?.navigation?.read?.().mediaTags).split(',').map((tag) => normalizeMediaTags([tag])[0]).filter(Boolean)
        : [])
    };
    const filtered = () => {
      const query = cleanText(local.query).toLowerCase();
      const modeItems = local.items
        .filter((item) => options.trashMode ? isPhotoTrashed(item.photo) : !isPhotoTrashed(item.photo))
        .filter((item) => !local.visibleTags.size || itemTags(item).some((tag) => local.visibleTags.has(normalizeMediaTags([tag])[0])));
      if (!query) return modeItems;
      return modeItems.filter((item) => item.search.includes(query) || itemTags(item).some((tag) => tag.toLowerCase().includes(query.replace(/^#/, ''))));
    };
    const localGroups = () => buildGroups(filtered());
    const writeLocalTagRoute = () => {
      if (cleanText(options.routeScope) !== 'project' || window.Portal?.navigation?.applying) return;
      window.Portal?.navigation?.replace?.({
        mediaTags:[...local.visibleTags].sort().join(',') || null
      }, { source:'project-media-tags', ownedKeys:['mediaTags'] });
    };
    const localTagMenuHtml = () => {
      if (!local.tagMenuOpen) return '';
      const items = mediaTagOptions(local.items, local.visibleTags);
      return `<div class="pf-shown-menu" data-local-tag-menu>
        <div class="pf-shown-head"><div><strong>${(globalThis.PlatformLanguage?.text("photos","m_7a18799062167c","Filter by tags") ?? "Filter by tags")}</strong><span>${(globalThis.PlatformLanguage?.text("photos","m_947598ffa6c0ff","Show media matching any selected tag.") ?? "Show media matching any selected tag.")}</span></div><button type="button" data-local-tags-close aria-label="${(globalThis.PlatformLanguage?.text("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        ${String(shownGroupHtml('local-tags', 'Media tags', 'fa-tags', items, local.visibleTags))}
      </div>`;
    };
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
        ? `<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("photos","m_d55efd8791e299"," Restore") ?? " Restore")}</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("photos","m_4e4c97a39c03c8"," Delete Forever") ?? " Delete Forever")}</button>`
        : (String(extraSelectionActions) + "<button type=\"button\" class=\"pf-action danger\" data-selection-delete><i class=\"fas fa-trash\"></i>" + (globalThis.PlatformLanguage?.text("photos","m_90e27d705bee80"," Delete") ?? " Delete") + "</button><div class=\"pf-download-wrap\"><button type=\"button\" class=\"pf-action primary\" data-selection-download><i class=\"fas fa-download\"></i>" + (globalThis.PlatformLanguage?.text("photos","m_f3ad10eaad3ccf"," Download") ?? " Download") + "</button><div class=\"pf-download-menu" + String(local.downloadMenuOpen ? ' visible' : '') + "\" data-selection-download-menu><button type=\"button\" data-download-selected-plain>" + (globalThis.PlatformLanguage?.text("photos","m_c94e82190b64cc","Without markup") ?? "Without markup") + "</button><button type=\"button\" data-download-selected-markup>" + (globalThis.PlatformLanguage?.text("photos","m_42e3382f311f77","With markup") ?? "With markup") + "</button></div></div>");
      return `
        ${local.selectionMode ? `<div class="pf-selectionbar"><strong>${((v0) => globalThis.PlatformLanguage?.text("photos","m_4b740d0b3ec319",`${v0} selected`,{v0}) ?? `${v0} selected`)(local.selected.size)}</strong><div class="pf-selection-actions"><button type="button" class="pf-action" data-selection-clear>${(globalThis.PlatformLanguage?.text("photos","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>${String(selectionActions)}</div></div>` : ''}
        <div class="pf-scroll" data-feed-scroll>
          ${!groups.length ? `<div class="pf-empty"><i class="fas ${escapeHtml(options.emptyIcon || 'fa-images')}"></i><strong>${escapeHtml(options.emptyTitle || 'No media found')}</strong><div>${escapeHtml(options.emptyMessage || 'Upload project media or adjust the search.')}</div></div>` : ''}
          ${groupedByDay(groups).map(([key, list]) => `<div class="pf-day"><div class="pf-day-heading"><h2 class="pf-day-title">${escapeHtml(dateLabel(key))}</h2>${typeof options.renderDaySummary==='function'?`<div class="pf-day-summary">${options.renderDaySummary({key,groups:list})}</div>`:''}</div>${list.map((group) => renderGroup(group, { enableProjectLinks: options.enableProjectLinks !== false, selected: local.selected, selectionEnabled:options.selectionEnabled, itemNoun:options.itemNoun, renderThumbnail:options.renderThumbnail, renderTileMeta:options.renderTileMeta, renderGroupUploaders:options.renderGroupUploaders, tileClass:options.tileClass })).join('')}</div>`).join('')}
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
        showToast?.((globalThis.PlatformLanguage?.text("photos","m_de25a6a2b4b2ce","Media downloaded") ?? "Media downloaded"), ((v0,v1) => globalThis.PlatformLanguage?.text("photos","m_75fdc317b24fbd",`${v0} item${v1} prepared.`,{v0,v1}) ?? `${v0} item${v1} prepared.`)(items.length,items.length === 1 ? '' : 's'), true);
      } catch (error) {
        showToast?.((globalThis.PlatformLanguage?.text("photos","m_01bd3117125ba8","Download failed") ?? "Download failed"), error?.message || 'Could not download selected media.', false);
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
      if (typeof options.onOpenItem === 'function') {
        const viewer = options.onOpenItem({ items, index:safeIndex, item, project:item.project || scopedProject, fromRoute:routeOptions.fromRoute === true });
        if (viewer && typeof options.onViewerOpen === 'function') options.onViewerOpen(viewer);
        return viewer;
      }
      const routeScope = cleanText(options.routeScope);
      if (routeScope && !routeOptions.fromRoute) updatePhotoRoute({ photo: item.photo, project: item.project || scopedProject }, routeScope);
      const viewer = window.FirstMateMarkup?.openPhotoViewer?.({
        photos: items.map((entry) => ({ ...entry.photo, __project: entry.project })),
        index: safeIndex,
        project: item.project || scopedProject,
        actions: Array.isArray(options.viewerActions) ? options.viewerActions : [],
        indicators: Array.isArray(options.viewerIndicators) ? options.viewerIndicators : [],
        onOpenProject: openProject,
        boundsTarget: options.boundsTarget || panel.closest?.('.r-win') || panel.closest?.('.pf-user-shell') || panel,
        projectLinkEnabled: options.projectLinkEnabled !== false && options.enableProjectLinks !== false,
        onChange: ({ photo, project }) => {
          if (routeScope) updatePhotoRoute({ photo, project: project || photo?.__project || item.project || scopedProject }, routeScope);
        },
        onTagsChange: async ({ photo, tags, viewer }) => {
          const normalized = normalizeMediaTags(tags);
          const result = typeof options.onTagsChange === 'function'
            ? await options.onTagsChange({ photo, tags:normalized, viewer })
            : await window.PlatformAPI?.media?.updateTags?.(orgId(), cleanText(photo.media_id || photo.mediaId || photo.id), normalized);
          const mediaId = photoIdentity(photo);
          local.items.forEach((entry) => {
            if (photoIdentity(entry.photo) !== mediaId) return;
            entry.photo.tags = normalized;
            entry.photo.metadata = { ...(entry.photo.metadata || {}), tags:normalized };
            entry.search = searchableText(entry);
          });
          renderLocal();
          return result;
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
      const initialPhotoId = cleanText(options.initialItemId || options.initialPhotoId);
      if (!initialPhotoId) return;
      const key = `${cleanText(options.routeScope)}:${initialPhotoId}`;
      if (local.routeRestoreKey === key) return;
      const items = filtered();
      const index = items.findIndex((item) => (
        (typeof options.itemIdentity === 'function' && cleanText(options.itemIdentity(item)) === initialPhotoId)
        || mediaRouteId(item.photo) === initialPhotoId
        || item.id.endsWith(`::${initialPhotoId}`)
      ));
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
          if (options.selectionEnabled === false) return;
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
        btn.draggable = typeof options.onItemDragStart === 'function';
        if (btn.draggable) btn.style.webkitUserDrag = 'element';
        btn.addEventListener('dragstart', (event) => {
          const item = local.items.find(item => item.id === btn.dataset.photoFeedId);
          if (item && typeof options.onItemDragStart === 'function') options.onItemDragStart({item,event});
          else event.preventDefault();
        });
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
        if (typeof options.onOpenProject === 'function') {
          options.onOpenProject(group?.project || scopedProject, { groupKey:key });
          return;
        }
        openProject(group?.project || scopedProject, { groupKey: key }).catch((error) => {
          console.warn('Could not open project from project photos', error);
          showToast?.((globalThis.PlatformLanguage?.text("photos","m_3d2585ab4e8b80","Project issue") ?? "Project issue"), error?.message || 'Could not open that project.', false);
        });
      }));
      panel.querySelectorAll('[data-photo-user-open]').forEach((btn) => btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!userModalsEnabled()) return;
        const key = btn.dataset.photoUserOpen || '';
        const items = filtered().filter((item) => uploaderUsers([item]).some((user) => user.key === key));
        const user = uploaderUsers(items)[0] || { key, name: btn.textContent || (globalThis.PlatformLanguage?.text("photos","m_dfd6687ea85fad","User") ?? "User") };
        openUserModal(user, items);
      }));
      if (options.selectionEnabled !== false && !local.pointerUpBound) {
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
      const itemNoun = cleanText(options.itemNoun || 'media item');
      const countLabel = `${local.items.length} ${itemNoun}${local.items.length === 1 ? '' : 's'}`;
      const titleLabel = options.title === '' ? countLabel : (options.title || (globalThis.PlatformLanguage?.text("photos","m_eae44a163f8a5a","Project Photos") ?? "Project Photos"));
      const subtitleLabel = options.title === '' ? '' : countLabel;
      const icon = options.icon || 'fa-images';
      const customToolbarActions = Array.isArray(options.toolbarActions) ? options.toolbarActions : [];
      const toolbarActions = customToolbarActions.map((action) => {
        const id = cleanText(action?.id);
        if (!id) return '';
        const label = cleanText(action.label || id);
        const iconName = cleanText(action.icon);
        return `<button type="button" class="pf-toolbar-action${action.active ? ' active' : ''}" data-gallery-toolbar-action="${escapeHtml(id)}" data-fm-tooltip="${escapeHtml(action.tooltip || label)}">${iconName ? `<i class="fas ${escapeHtml(iconName)}"></i>` : ''}${action.showLabel ? ` <span>${escapeHtml(label)}</span>` : ''}</button>`;
      }).join('');
      panel.innerHTML = `
        <div class="pf-wrap${String(local.selectionMode ? ' selection-mode' : '')}" data-density="${String(escapeHtml(local.density))}">
          <div class="pf-toolbar">
            <div class="pf-title"><i class="fas ${String(escapeHtml(icon))}"></i><div><strong>${String(escapeHtml(titleLabel))}</strong>${String(subtitleLabel ? `<span>${escapeHtml(subtitleLabel)}</span>` : '')}</div></div>
            <div class="pf-tools">
              <label class="pf-search"><i class="fas fa-search"></i><input type="search" value="${String(escapeHtml(local.query))}" placeholder="${String(escapeHtml(options.searchPlaceholder || 'Search dates, uploaders, tags'))}"></label>
              <div class="pf-density">${String([
                { id: 'loose', label: 'Loose', icon: 'border-all' },
                { id: 'comfortable', label: 'Comfortable', icon: 'grip' },
                { id: 'compact', label: 'Compact', icon: 'table-cells' },
                ...(Array.isArray(options.extraDensityModes) ? options.extraDensityModes : [])
              ].map((mode) => `<button type="button" class="${local.density === mode.id ? 'active' : ''}" data-density="${mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join(''))}</div>
              <div class="pf-shown-wrap">
                <button type="button" class="pf-toolbar-action${String(local.tagMenuOpen || local.visibleTags.size ? ' active' : '')}" data-local-tags aria-expanded="${String(local.tagMenuOpen ? 'true' : 'false')}"><i class="fas fa-tags"></i><span>${(globalThis.PlatformLanguage?.text("photos","m_562d2cd3a48b8f","Tags") ?? "Tags")}</span></button>
                ${String(localTagMenuHtml())}
              </div>
              ${String(toolbarActions)}
              ${String(options.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(options.uploadLabel)}</button>` : '')}
            </div>
          </div>
          <div data-photo-feed-dynamic>${String(bodyHtml())}</div>
        </div>`;
      panel.querySelector('input[type="search"]')?.addEventListener('input', (event) => {
        local.query = event.target.value || '';
        renderBody();
      });
      panel.querySelectorAll('.pf-density [data-density]').forEach((btn) => btn.addEventListener('click', () => {
        local.density = btn.dataset.density || 'comfortable';
        if (typeof options.onDensityChange === 'function') options.onDensityChange(local.density);
        renderLocal();
      }));
      panel.querySelector('[data-photo-feed-upload]')?.addEventListener('click', () => {
        if (typeof options.onUpload === 'function') options.onUpload();
      });
      panel.querySelector('[data-local-tags]')?.addEventListener('click', () => {
        local.tagMenuOpen = !local.tagMenuOpen;
        renderLocal();
      });
      panel.querySelector('[data-local-tags-close]')?.addEventListener('click', () => {
        local.tagMenuOpen = false;
        renderLocal();
      });
      panel.querySelectorAll('[data-feed-filter-group="local-tags"][data-feed-filter-id]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.feedFilterId || '';
        if (local.visibleTags.has(id)) local.visibleTags.delete(id);
        else local.visibleTags.add(id);
        writeLocalTagRoute();
        renderLocal();
      }));
      panel.querySelector('[data-feed-filter-group="local-tags"][data-filter-group-action]')?.addEventListener('click', (event) => {
        const items = mediaTagOptions(local.items, local.visibleTags);
        local.visibleTags.clear();
        if (event.currentTarget.dataset.filterGroupAction === 'all') items.forEach((item) => local.visibleTags.add(item.id));
        writeLocalTagRoute();
        renderLocal();
      });
      panel.querySelectorAll('[data-gallery-toolbar-action]').forEach((button) => button.addEventListener('click', () => {
        const action = (Array.isArray(options.toolbarActions) ? options.toolbarActions : []).find((entry) => cleanText(entry?.id) === button.dataset.galleryToolbarAction);
        if (typeof action?.onClick === 'function') action.onClick({ render:renderLocal, items:filtered() });
      }));
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
      title: (globalThis.PlatformLanguage?.text("photos","m_3eea4dfd8e947d","Feed") ?? "Feed"),
      icon: 'fa-layer-group',
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
  window.addEventListener('fm:media-video-saved', () => {
    if (state.loaded && !state.loading) void load();
  });
  window.addEventListener('fm:media-renamed', (event) => {
    const mediaId = cleanText(event?.detail?.mediaId);
    const name = cleanText(event?.detail?.name);
    if (!mediaId || !name || !state.loaded) return;
    state.items.forEach((item) => {
      if (cleanText(item.photo?.media_id) !== mediaId) return;
      item.photo.label = name;
      item.photo.alt = name;
      if (event.detail.fileName) item.photo.file_name = event.detail.fileName;
    });
    render();
  });
  window.addEventListener('fm:media-markup-saved', (event) => {
    const mediaId = cleanText(event?.detail?.mediaId);
    if (!mediaId || !window.PlatformAPI?.media?.markupThumbnailUrl) return;
    const revision = cleanText(event?.detail?.revision || event?.detail?.updatedAt || Date.now());
    markupThumbnailRevisions.set(mediaId, revision);
    const src = window.PlatformAPI.media.markupThumbnailUrl(orgId(), mediaId, 320, revision);
    document.querySelectorAll('img[data-markup-thumbnail-media-id]').forEach((img) => {
      if (cleanText(img.dataset.markupThumbnailMediaId) !== mediaId) return;
      img.dataset.baseSrc = src;
      img.dataset.thumbRetries = '0';
      img.closest('.pf-thumb')?.classList.remove('error');
      img.src = src;
    });
  });
  window.Portal?.navigation?.registerHandler?.('photo-feed-viewer', {
    priority:500,
    apply:(route) => {
      if (route.photoScope === 'feed' && route.photo && route.tab === TAB_ID) restoreFeedPhotoRoute();
      else if (state.activeFeedViewer) restoreFeedPhotoRoute();
    }
  });
  window.Portal?.navigation?.registerHandler?.('feed-preferences', {
    priority:490,
    match:(route) => route.tab === TAB_ID,
    apply:(route) => {
      applyFeedRoute(route);
      if (state.root) render();
    }
  });
  function restoreUserRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (!route.user) {
      state.activeUserModal?.close?.({ fromRoute:true });
      return;
    }
    if (state.activeUserModal?.key === route.user) {
      state.activeUserModal.setTab?.(route.userTab || 'photos');
      return;
    }
    const item = state.items.find((entry) => {
      const person = uploader(entry.photo);
      return [person.id, person.email, person.name].map(cleanText).includes(route.user);
    });
    if (!item) return;
    const person = uploader(item.photo);
    const items = state.items.filter((entry) => userMatchesUploader(person, entry));
    void openUserModal(person, items, { fromRoute:true, tab:route.userTab || 'photos' });
  }
  window.Portal?.navigation?.registerHandler?.('photo-user-profile', { priority:510, apply:restoreUserRoute });
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
    isReceiptMedia,
    normalizePickerItems,
    openProjectMediaPicker,
    mountProjectGallery,
    refreshProjectGallery: mountProjectGallery
  };
  loadBranchProjectConfig().then(rebuildProjectDisplayLabels).catch(() => null);
  window.Portal?.appFlags?.load?.().then(refreshRegistration).catch(refreshRegistration);
  setTimeout(refreshRegistration, 800);
})();
