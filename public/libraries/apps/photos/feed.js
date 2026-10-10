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
  let branchProjectConfig = { title_mode: 'all_contacts' };
  const markupThumbnailRevisions = new Map();
  let state = {
    root: null,
    projects: [],
    items: [],
    groups: [],
    documents: [],
    activity: [],
    notes: [],
    users: [],
    manualPosts: [],
    departments: [],
    userDepartments: {},
    memberDepartmentIds: [],
    activityOptions: [],
    postSettings: {company_activity_types:null,department_activity_types:{},revision:0},
    canPost: false,
    canManagePostSettings: false,
    feedScope: 'all',
    scopeMenuOpen: false,
    composerOpen: false,
    composerText: '',
    composerDepartment: '',
    composerMentions: new Set(),
    composerMentionApi: null,
    composerFiles: [],
    composerGif: null,
    composerAudioFile: null,
    composerAudioNote: null,
    composerAudioAttachment: null,
    composerPreviewUrls: new Map(),
    composerPreviewIndex: -1,
    thumbnailStatus: new Map(),
    composerOperationId: '',
    composerBusy: false,
    query: '',
    density: 'small',
    listOrganize: 'time',
    views:['list','small','large','mosaic','posts'],
    authorizedSources:new Map(),
    posts:new Map(),
    canComment:true,
    canReact:true,
    shownMenuOpen: false,
    visibleMedia: new Set(DEFAULT_MEDIA_FILTERS),
    visibleTags: new Set(),
    visibleDocuments: new Set(DOCUMENT_FILTERS.map(d=>d.id)),
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
    noteObserver: null,
    mediaResizeObserver: null,
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
      type_label:cleanText(doc.type_label) === 'Document' && meta.label !== 'Document' ? meta.label : firstText(doc.type_label, meta.label),
      icon:cleanText(doc.type_label) === 'Document' && meta.label !== 'Document' ? meta.icon : firstText(doc.icon, meta.icon),
      color:cleanText(doc.type_label) === 'Document' && meta.label !== 'Document' ? meta.color : firstText(doc.color, meta.color),
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
    return firstText(user?.name, user?.display_name, payload.actor_name, context.actor_name, context.actor_email, user?.email, 'Someone');
  }
  function activityObjectLabel(event = {}){
    const payload = activityPayload(event);
    if (['project.event_scheduled','project.event.started','project.event.completed'].includes(cleanText(event.type))) return firstText(payload.event?.title, payload.title);
    return firstText(payload.title, payload.document_title, payload.proposal_title, payload.invoice_number, payload.file_name, payload.contact_name);
  }
  function feedActivitySummary(event = {}){
    const actor = feedActor(event);
    const object = activityObjectLabel(event);
    const type = cleanText(event.type);
    const documentType = cleanText(activityPayload(event).document_type).replace(/_/g, ' ');
    if (type === 'project.event.started' || type === 'project.event.completed') {
      const payload = activityPayload(event);
      const eventType = firstText(payload.event_type_default_id, payload.event_kind, payload.event?.event_type_default_id, payload.event?.kind).replace(/_/g, ' ');
      const verb = type === 'project.event.started' ? 'started' : 'completed';
      const eventLabel = eventType === 'project work' ? eventType : eventType && eventType !== 'custom' ? `${/^[aeiou]/i.test(eventType) ? 'an' : 'a'} ${eventType}` : 'an event';
      return `${actor} ${verb} ${eventLabel}${object ? `: ${object}` : ''}`;
    }
    if (type === 'work.plan.stage_manually_set') {
      const stage = firstText(activityPayload(event).to_stage_title, activityPayload(event).stage_title);
      return `${actor} moved the project to ${stage || 'a new stage'}`;
    }
    if (documentType && type === 'document.sent') return `${actor} sent a ${documentType} to the customer${object ? `: ${object}` : ''}`;
    if (documentType && type === 'document.viewed') return `${actor} had a ${documentType} viewed by the customer${object ? `: ${object}` : ''}`;
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
      'media.uploaded':cleanText(activityPayload(event).content_type) && !/^(image|video)\//.test(cleanText(activityPayload(event).content_type)) ? 'uploaded a document' : 'uploaded media',
      'media.shared':'shared media with the customer',
      'project.created':'created a project',
      'project.contact.attached':'attached a contact',
      'project.event_scheduled':`scheduled a ${cleanText(activityPayload(event).event_type_default_id || activityPayload(event).event_kind || activityPayload(event).event?.event_type_default_id).replace(/_/g, ' ') || 'project event'}`,
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
    const mode = cleanText(config?.title_mode || config?.project_title_mode || 'all_contacts');
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode: ['all_contacts', 'customer_name', 'address', 'manual'].includes(mode) ? mode : 'all_contacts'
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
    if (savedTitle && branchProjectConfig?.title_mode === 'manual') return savedTitle;
    const mode = branchProjectConfig?.title_mode || 'all_contacts';
    const contact = {...primaryProjectContact(project)};
    if(mode === 'all_contacts') contact.name = window.Portal?.modules?.request?.formatProjectContactNames?.(project.contacts) || contact.name;
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
    const date = parseDate(value);
    if (!date) return "undated";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function dateLabel(key){
    if (key === "undated") return "Unknown date";
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
  function feedListTime(value){
    const date = parseDate(value);
    if (!date) return cleanText(value);
    const time = date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    return dateKey(date) === dateKey(new Date())
      ? `Today, ${time}`
      : `${date.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })} · ${time}`;
  }
  function feedDayTime(value){
    const date = parseDate(value);
    return date ? date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }).toLowerCase() : cleanText(value);
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
      links.push(`<button type="button" class="pf-activity-link" data-activity-photo-open="${String(index)}"><i class="fas fa-image"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_e44133b3423b5f"," Open media") ?? " Open media")}</button>`);
    }
    if (projectId || activityProjectLabel(event)) {
      links.push(`<button type="button" class="pf-activity-link" data-activity-project-open="${String(index)}"><i class="fas fa-folder-open"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_53787840db7d1c"," Open project") ?? " Open project")}</button>`);
    }
    return links.length ? `<div class="pf-activity-links">${links.join('')}</div>` : '';
  }
  function renderActivityList(events = []){
    if (!events.length) {
      return `<div class="pf-user-empty"><i class="fas fa-clock-rotate-left"></i><strong>${(globalThis.PlatformLanguage?.htmlText("photos","m_a545b858debe95","No activity yet") ?? "No activity yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("photos","m_987dfddd540a5b","Tracked uploads, comments, and report orders will appear here.") ?? "Tracked uploads, comments, and report orders will appear here.")}</span></div>`;
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
    if (!users.length) return `<span>${(globalThis.PlatformLanguage?.htmlText("photos","m_d891abd029c243","Unknown uploader") ?? "Unknown uploader")}</span>`;
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
    const rawPhotos=Array.isArray(safeProject.photos)?safeProject.photos:[];
    const documents=rawPhotos.filter(photo=>photo?.resource_type==='document' && photo.id);
    const media=rawPhotos.filter(photo=>photo?.resource_type!=='document');
    const photos = library?.normalizePhotos ? library.normalizePhotos(media, firstMeasurePhotoOptions()) : media;
    return [...photos,...documents]
      .filter((photo) => photo && (photo.media_id || photo.src || photo.thumb || (photo.resource_type==='document' && photo.id)))
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
      const reference = window.PlatformAPI.media.referenceFromUpload(item, { field: 'photos', variant: 'original' });
      return { ...reference, uploaded_at:firstText(item.metadata?.uploaded_at,reference.uploaded_at) };
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
      uploaded_at: firstText(item.metadata?.uploaded_at, item.uploaded_at, item.created_at, item.updated_at),
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
      const owner = objectValue(item.owner);
      const metadata = objectValue(item.metadata);
      const slot = firstText(owner.slot, item.slot, metadata.field, metadata.slot).toLowerCase();
      const mime = firstText(item.content_type, item.mime_type, metadata.content_type).toLowerCase();
      if (slot === 'documents' || slot === 'receipts' || (mime && !/^(image|video)\//.test(mime))) return;
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
    await authorizeFeedEntries();
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
  function feedEntryActorId(entry = {}){
    if (entry.kind === 'media') return firstText(uploader(entry.media).id,entry.media?.uploaded_by_user_id,entry.media?.metadata?.uploaded_by_user_id);
    if (entry.kind === 'document') return firstText(entry.document?.uploaded_by_user_id,entry.document?.created_by_user_id,entry.document?.metadata?.uploaded_by_user_id);
    if (entry.kind === 'activity') return firstText(entry.event?.actor_user_id,activityContext(entry.event).actor_user_id);
    if (entry.kind === 'note') return firstText(entry.note?.author?.id,entry.note?.author_id);
    return '';
  }
  function feedEntryDepartments(entry = {}){
    if (entry.kind === 'manual') return cleanText(entry.manual?.metadata?.feed_department_id) ? [cleanText(entry.manual.metadata.feed_department_id)] : [];
    return state.userDepartments[feedEntryActorId(entry)] || [];
  }
  function feedEntryInScope(entry = {}){
    const departments=feedEntryDepartments(entry);
    if (state.feedScope === 'all') return true;
    if (state.feedScope === 'company') return entry.kind === 'manual' ? departments.length === 0 : true;
    if (state.feedScope === 'mine') return departments.some(id=>state.memberDepartmentIds.includes(id));
    return departments.includes(state.feedScope);
  }
  const DEFAULT_POST_ACTIVITY_TYPES = new Set(['media.uploaded','note.created','project.created','project.event_scheduled','project.event.completed','crew.checklist.completed','proposal.signed','contract.signed','payment.received']);
  function automaticPostType(entry = {}){
    return entry.kind === 'activity' ? cleanText(entry.event?.type) : entry.kind === 'media' ? 'media.uploaded' : entry.kind === 'note' ? 'note.created' : entry.kind === 'document' ? firstText(entry.pairedEvent?.type,'document.ingested') : '';
  }
  function automaticPostEnabled(entry = {}){
    if (state.density !== 'posts') return true;
    const type=automaticPostType(entry),settings=state.postSettings || {};
    const allowed=(scope)=>{
      const selected=scope === 'company' ? settings.company_activity_types : objectValue(settings.department_activity_types)[scope];
      return Array.isArray(selected) ? selected.includes(type) : DEFAULT_POST_ACTIVITY_TYPES.has(type);
    };
    if (state.feedScope === 'company') return allowed('company');
    if (state.feedScope === 'mine') return feedEntryDepartments(entry).some(id=>state.memberDepartmentIds.includes(id) && allowed(id));
    if (state.feedScope !== 'all') return allowed(state.feedScope);
    return allowed('company') || feedEntryDepartments(entry).some(id=>state.memberDepartmentIds.includes(id) && allowed(id));
  }
  function feedEntries(options = {}){
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
      .filter((event) => cleanText(event.type) !== 'work.plan.started')
      .filter((event) => !(cleanText(event.type) === 'note.created' && activityPayload(event).synthetic && !activityPayload(event).message_id))
      .filter((event) => !(cleanText(event.type) === 'document.signed' && activityPayload(event).synthetic && !firstText(activityPayload(event).document_id, activityPayload(event).id)))
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
    const noteEntries = state.visibleActivity.has('project') ? state.notes.map((note) => {
      const project = projectForId(note.projectId);
      return { id:`note:${note.id}`, kind:'note', note, project, projectId:note.projectId,
        timestamp:note.created_at, dateKey:dateKey(note.created_at),
        search:[note.text,note.author?.name,projectTitle(project),projectAddress(project)].join(' ').toLowerCase() };
    }) : [];
    const manualEntries = state.density === 'posts' ? state.manualPosts.map((manual)=>({
      id:`manual:${manual.id}`,kind:'manual',manual,project:{},projectId:'',
      timestamp:manual.created_at,dateKey:dateKey(manual.created_at),
      search:[manual.text,manual.author?.name,...(manual.mention_users || []).map(person=>person.name)].join(' ').toLowerCase()
    })) : [];
    const unpaired = new Set(activityEntries.map((entry) => entry.id));
    [...mediaEntries, ...documentEntries].forEach((asset) => {
      const match = activityEntries.find((entry) => unpaired.has(entry.id) && assetEventMatch(asset, entry.event));
      if (!match) return;
      asset.pairedEvent = match.event;
      asset.timestamp = asset.kind === 'media' ? asset.timestamp : ([asset.timestamp, match.timestamp].sort().reverse()[0] || asset.timestamp);
      asset.dateKey = dateKey(asset.timestamp);
      asset.search += ` ${match.search}`;
      unpaired.delete(match.id);
    });
    const query = cleanText(state.query).toLowerCase();
    const entries = state.visibleTags.size
      ? [...manualEntries,...mediaEntries]
      : [...manualEntries,...mediaEntries, ...documentEntries, ...activityEntries.filter((entry) => unpaired.has(entry.id)), ...noteEntries];
    return entries
      .filter((entry) => entry.kind === 'manual' || entry.kind === 'note' || options.unverified || state.authorizedSources.has(feedRefKey(entryRef(entry))))
      .filter(feedEntryInScope)
      .filter((entry) => state.density !== 'posts' || entry.kind === 'manual' || automaticPostEnabled(entry))
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
  async function loadFeedNotes(oid, projects = []){
    if (!window.ChannelsAPI?.channels?.list || !window.ChannelsAPI?.messages?.list) return [];
    try {
      const available = new Set(projects.map((project) => cleanText(project.id)));
      const result = await window.ChannelsAPI.channels.list(oid);
      const channels = (result.channels || []).filter((channel) => channel.type === 'project' && available.has(cleanText(channel.project_id)));
      const pages = await Promise.all(channels.map(async (channel) => {
        try {
          const page = await window.ChannelsAPI.messages.list(oid, channel.id, { view:'notes', limit:200 });
          return (page.messages || []).filter((message) => message.metadata?.project_note === true && !message.deleted_at)
            .map((message) => ({ ...message, projectId:cleanText(channel.project_id) }));
        } catch (error) {
          console.warn('Could not load project notes for Feed', error);
          return [];
        }
      }));
      return pages.flat().filter(note=>{const context=state.departmentContext||{},ids=note.metadata?.department_ids||[];if(!ids.length)return true;if(state.departmentId&&state.departmentId!=='all')return ids.includes(state.departmentId);return !context.enabled||context.organization_wide||ids.some(id=>(context.department_ids||[]).includes(id));});
    } catch (error) {
      console.warn('Could not list project notes for Feed', error);
      return [];
    }
  }
  function serializeFeedShown(){
    return state.visibleActivity.size ? [...state.visibleActivity].sort().map((id) => `a:${id}`).join(',') : 'a:none';
  }
  function applyFeedRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (route.feedDensity) state.density = ({loose:'large',comfortable:'small',compact:'mosaic'})[route.feedDensity] || (['list','small','large','mosaic','posts'].includes(route.feedDensity) ? route.feedDensity : 'small');
    if (route.feedListOrganize) state.listOrganize = route.feedListOrganize === 'project' ? 'project' : 'time';
    if(state.loaded && !state.views.includes(state.density))state.density=state.views[0];
    if (!route.feedShown) return;
    const tokens = cleanText(route.feedShown).split(',').map(cleanText).filter(Boolean);
    state.visibleMedia = new Set(DEFAULT_MEDIA_FILTERS);
    state.visibleActivity = new Set(tokens.filter((token) => token.startsWith('a:')).map((token) => token.slice(2)).filter((id) => DEFAULT_ACTIVITY_FILTERS.includes(id)));
    state.visibleDocuments = new Set(DOCUMENT_FILTERS.map(entry=>entry.id));
    state.visibleTags = new Set();
    if (state.loaded && state.visibleDocuments.size && !state.documentsLoaded) void loadFeedDocuments();
  }
  function writeFeedPreferences(){
    if (window.Portal?.navigation?.applying) return;
    window.Portal?.navigation?.replace?.({
      feedDensity:state.density,
      feedListOrganize:state.listOrganize,
      feedShown:serializeFeedShown()
    }, { source:'feed-preferences', ownedKeys:['feedDensity','feedListOrganize','feedShown'] });
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
      const cached = state.thumbnailStatus.get(baseSrc);
      if (cached === 'loaded') tile.classList.add('loaded');
      if (cached === 'error') { tile.classList.add('error'); return; }
      const retry = () => {
        if (tile.classList.contains('loaded')) return;
        const originalSrc = img.dataset.originalSrc || '';
        if(img.dataset.fallbackStarted==='true' && !img.complete)return;
        if (img.dataset.mediaKind === 'video' && originalSrc) {
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
        if (originalSrc && originalSrc !== baseSrc && img.src !== originalSrc) {
          img.dataset.fallbackStarted='true';
          tile.classList.remove('error');
          img.src = originalSrc;
          return;
        }
        tile.classList.add('error');
        state.thumbnailStatus.set(baseSrc, 'error');
      };
      const markLoaded = () => {
        tile.classList.add('loaded');
        tile.classList.remove('error');
        state.thumbnailStatus.set(baseSrc, 'loaded');
      };
      const markError = () => {
        window.setTimeout(retry, 450);
      };
      if (img.complete && img.naturalWidth > 0) markLoaded();
      else if (img.complete) window.setTimeout(retry, 450);
      // A slow image is still loading. Replacing its URL here aborts that
      // request and can make a busy tile flash indefinitely.
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
      /* Feed layouts deliberately change structure, rather than just gutters. */
      .pf-wrap[data-density="small"] .pf-feed-grid{grid-template-columns:repeat(8,minmax(0,1fr));gap:7px}
      .pf-wrap[data-density="large"] .pf-feed-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
      .pf-wrap[data-density="small"] .pf-feed-card .pf-thumb,.pf-wrap[data-density="small"] .pf-document-preview{aspect-ratio:4/3;max-height:95px}
      .pf-wrap[data-density="large"] .pf-feed-card .pf-thumb,.pf-wrap[data-density="large"] .pf-document-preview{aspect-ratio:16/9;max-height:130px}
      .pf-wrap[data-density="small"] .pf-feed-activity,.pf-wrap[data-density="large"] .pf-feed-activity{grid-column:auto;display:flex;flex-direction:column;align-items:stretch;min-height:95px;gap:7px}
      .pf-wrap[data-density="small"] .pf-document-icon i,.pf-wrap[data-density="large"] .pf-document-icon i{font-size:18px}
      .pf-wrap[data-density="small"] .pf-feed-activity-icon,.pf-wrap[data-density="large"] .pf-feed-activity-icon{width:21px;height:21px;border-radius:6px;font-size:8px}
      .pf-wrap[data-density="list"] .pf-feed-grid{max-width:none}
      .pf-feed-list-row{display:grid;grid-template-columns:52px minmax(0,1fr) auto;align-items:center;gap:13px;min-height:72px;padding:11px 15px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px #10182808}.pf-feed-list-copy{min-width:0;display:grid;gap:5px}.pf-feed-list-copy strong{color:#182230;font-size:13px;line-height:1.35}.pf-feed-list-project{display:flex;align-items:center;gap:7px;min-width:0;color:#667085;font-size:11px}.pf-feed-list-project button{border:0;background:none;padding:0;color:#475467;font:inherit;font-weight:850;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-feed-list-project button:hover{text-decoration:underline;color:var(--primary-readable,var(--primary,#d93025))}.pf-feed-list-project .pf-feed-list-address{font-weight:650}.pf-feed-list-project .pf-feed-list-separator{color:#98a2b3}.pf-feed-list-time{color:#667085;font-size:11px;font-weight:750;white-space:nowrap;text-align:right}
      .pf-actor-avatar{width:46px;height:46px;flex:0 0 46px;display:grid;place-items:center;position:relative;border-radius:50%;background:#e9eef4;color:#475467;font-size:16px;font-weight:850}.pf-actor-avatar>img{width:100%;height:100%;border-radius:50%;object-fit:cover}.pf-actor-badge{position:absolute;right:-3px;bottom:-3px;width:21px;height:21px;display:grid;place-items:center;border:2px solid #fff;border-radius:50%;background:var(--primary,#d93025);color:#fff;font-size:9px;box-shadow:0 1px 3px #10182820}.pf-post-head .pf-actor-avatar{width:44px;height:44px;flex-basis:44px}
      .pf-wrap[data-density="mosaic"] .pf-feed-grid{display:block;columns:4;column-gap:12px}
      .pf-wrap[data-density="mosaic"] .pf-feed-grid>article{width:100%;box-sizing:border-box;break-inside:avoid;margin:0 0 12px;border-radius:4px;overflow:hidden}
      .pf-wrap[data-density="mosaic"] .pf-feed-card .pf-thumb{aspect-ratio:4/5}
      .pf-wrap[data-density="mosaic"] .pf-feed-card:nth-child(3n+2) .pf-thumb{aspect-ratio:4/3}
      .pf-wrap[data-density="mosaic"] .pf-feed-card:nth-child(5n+3) .pf-thumb{aspect-ratio:1/1}
      .pf-wrap[data-density="mosaic"] .pf-feed-activity{grid-column:auto;display:flex;flex-direction:column;align-items:stretch;gap:15px;padding:22px 16px}
      .pf-wrap[data-density="posts"] .pf-feed-grid{display:flex;flex-direction:column;max-width:700px;gap:20px;margin:auto}
      .pf-wrap[data-density="posts"] .pf-day-title{max-width:700px;margin:0 auto 12px}
      .pf-wrap[data-density="posts"] .pf-scroll{background:#f3f5f7;padding:18px}
      .pf-post{border:1px solid #e1e5ea;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 5px #10182806;min-width:0}
      .pf-post button{cursor:pointer}.pf-post-head{display:flex;align-items:center;gap:11px;padding:16px 18px}.pf-post-head>div{flex:1;min-width:0}.pf-post-head strong{font-size:14px;color:#182230}.pf-post-head>div>span{display:block;color:#798393;font-size:12px;margin-top:4px}.pf-post-head button{border:0;background:transparent;padding:0;color:inherit;font:inherit}.pf-post-head>i{color:#98a2b3}.pf-post-avatar{width:40px;height:40px;flex:0 0 40px;border-radius:50%;object-fit:cover;background:#e9eef4;color:#475467;display:flex;align-items:center;justify-content:center;font-weight:700}
      .pf-post-head>.pf-actor-avatar{display:grid;margin-top:0;color:#475467}.pf-post-head>.pf-actor-avatar>.pf-actor-badge{display:grid;margin-top:0;color:#fff}
      .pf-actor-avatar[data-fm-summary-type]{cursor:help}
      .pf-post-caption{margin:0;padding:0 18px 14px;font-size:14px;color:#344054}
      .pf-post-collage{display:grid;grid-template-columns:2fr 1fr;grid-template-rows:repeat(3,1fr);gap:3px;height:350px;background:#eef1f4}.pf-post-collage .pf-thumb{height:100%;width:100%;aspect-ratio:auto;border-radius:0;border:0;position:relative}.pf-post-collage .pf-thumb:first-child{grid-row:1/-1}.pf-post-collage.count-1{display:block;height:390px}.pf-post-collage.count-2{grid-template-rows:1fr}.pf-post-collage.count-3{grid-template-rows:repeat(2,1fr)}.pf-post-collage img,.pf-post-collage video{object-fit:cover;width:100%;height:100%}.pf-post-overflow{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#10182888;color:#fff;font-size:32px;font-weight:650}
      .pf-post-document{margin:0 18px 18px;padding:24px;background:#f6f4fc;border:1px solid #e4def3;border-radius:8px;display:flex;align-items:flex-start;gap:18px}.pf-post-document-icon{font-size:34px;color:#7c3aed}.pf-post-document small{display:block;color:#667085;margin-bottom:5px}.pf-post-document strong{display:block;font-size:18px;color:#182230}.pf-post-document .pf-action{margin-top:14px}.pf-post-value{display:block;font-size:30px;color:#182230;margin-top:10px;letter-spacing:-.5px}.pf-post-event{padding:10px 22px 26px;line-height:1.6;font-size:16px}.pf-post-event>i{color:var(--primary,#475467);font-size:26px}.pf-post-event p{margin:10px 0 0}
      .pf-post-stats{padding:12px 18px;display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#667085}.pf-post-stats button{border:0;background:none;color:inherit}.pf-post-actions{display:flex;align-items:center;margin:0 14px;border-top:1px solid #eaecf0;padding:5px 0;gap:6px}.pf-post-actions>button{flex:1;border:0;background:none;color:#667085;border-radius:7px;padding:10px;font-size:13px}.pf-post-actions>button:hover{background:#f2f4f7}.pf-post-actions>button[aria-pressed="true"]{color:#2563eb;background:#eff6ff}.pf-post-react{position:relative}.pf-post-react summary{padding:10px;cursor:pointer;list-style:none}.pf-post-react>div{position:absolute;right:0;bottom:100%;display:flex;background:#fff;border:1px solid #e4e7ec;box-shadow:0 4px 20px #10182820;padding:6px;border-radius:20px;z-index:5}.pf-post-react button{border:0;background:none;font-size:22px;padding:5px}
      .pf-comments{padding:14px 18px;border-top:1px solid #eaecf0;background:#fcfcfd}.pf-comment{display:flex;gap:9px;margin-bottom:14px}.pf-comment>.pf-post-avatar{width:30px;height:30px;flex-basis:30px;font-size:12px}.pf-comment-body{flex:1;min-width:0}.pf-comment-head{display:flex;justify-content:space-between;gap:8px;font-size:12px}.pf-comment-head time{font-size:11px;color:#98a2b3}.pf-comment [data-comment-content]{padding:8px 12px;margin-top:5px;border-radius:4px 14px 14px;background:#eef1f4;font-size:13px;overflow-wrap:anywhere}.pf-comment-actions{display:flex;gap:9px;margin-top:5px;flex-wrap:wrap}.pf-comment-actions button{border:0;background:none;color:#667085;font-size:11px;padding:0}.pf-comment-label{display:block;font-size:11px;color:#667085}.pf-comment-label textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:62px;margin-top:5px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:11px;font:inherit;font-size:13px}.pf-comment-tools{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}.pf-comment-tools>button[type="submit"]{margin-left:auto}.pf-comment-tools details{position:relative;font-size:12px;cursor:pointer}.pf-comment-tools details>div{position:absolute;bottom:100%;display:flex;z-index:5;background:#fff;border:1px solid #e4e7ec}.pf-comment-tools details button{border:0;background:none;padding:6px;font-size:20px}.pf-comment-tools [data-comment-attachments]{font-size:11px;max-width:180px;overflow-wrap:anywhere}
      @media(max-width:1050px){.pf-wrap[data-density="small"] .pf-feed-grid{grid-template-columns:repeat(6,minmax(0,1fr))}.pf-wrap[data-density="mosaic"] .pf-feed-grid{columns:3}}
      @media(max-width:760px){.pf-wrap:has(.pf-feed-grid) .pf-toolbar{flex-wrap:wrap}.pf-wrap:has(.pf-feed-grid) .pf-density{display:flex}.pf-wrap:has(.pf-feed-grid) .pf-tools{flex-wrap:wrap}.pf-wrap:has(.pf-feed-grid) .pf-search{flex-basis:100%}.pf-wrap[data-density="small"] .pf-feed-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.pf-wrap[data-density="large"] .pf-feed-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pf-wrap[data-density="list"] .pf-feed-grid{grid-template-columns:1fr}.pf-wrap[data-density="mosaic"] .pf-feed-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pf-post-collage{height:270px}.pf-post-collage.count-1{height:300px}.pf-wrap[data-density="posts"] .pf-scroll{padding:8px}.pf-post-head{padding:14px}.pf-wrap[data-density="list"] .pf-feed-card{grid-template-columns:90px minmax(0,1fr)}}
      @media(max-width:760px){.pf-feed-list-row{grid-template-columns:46px minmax(0,1fr);gap:10px;padding:11px}.pf-feed-list-time{grid-column:2;text-align:left;margin-top:-2px}.pf-feed-list-project{flex-wrap:wrap;gap:3px 7px}.pf-feed-list-project button{white-space:normal;text-align:left}}
      .pf-project-identity{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:0 7px;max-width:100%;text-align:left;line-height:1.4}.pf-project-identity span{overflow-wrap:anywhere}.pf-project-identity .pf-feed-list-address{font-weight:650}.pf-project-identity:hover span{text-decoration:underline}.pf-feed-list-project .pf-project-identity{white-space:normal;overflow:visible}
      .pf-note{min-width:0}.pf-note-toggle{display:flex;align-items:flex-start;gap:8px;width:100%;padding:2px 0;border:0;background:none;color:#475467;font:inherit;font-size:12px;line-height:1.45;text-align:left;cursor:pointer}.pf-note-toggle:hover{color:var(--primary-readable,var(--primary,#d93025))}.pf-note-toggle .pf-note-preview{flex:1;min-width:0;overflow:hidden;max-height:4.5em;transition:max-height .24s ease,opacity .24s ease}.pf-note-toggle i{margin:3px 0 0 auto;flex:none;transition:transform .28s ease}.pf-note.expanded .pf-note-toggle i{transform:rotate(180deg)}.pf-note.expanded .pf-note-preview{max-height:0;opacity:0}.pf-note-expanded{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .32s ease,opacity .32s ease}.pf-note.expanded .pf-note-expanded{grid-template-rows:1fr;opacity:1}.pf-note-expanded>div{min-height:0;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:#344054}.pf-post-note-body{padding:0 18px 16px}
      .pf-tile-actor{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:8px}.pf-tile-actor .pf-actor-avatar{width:32px;height:32px;flex-basis:32px;font-size:12px}.pf-tile-actor .pf-actor-badge{width:16px;height:16px;font-size:7px}.pf-tile-actor>span:last-child{display:flex;flex-direction:column;min-width:0}.pf-tile-actor strong{font-size:11px;color:#182230;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-tile-actor time{font-size:10px;color:#667085}.pf-feed-activity>.pf-actor-avatar{margin-top:0}.pf-feed-activity>time{color:#667085;font-size:10px;white-space:nowrap}.pf-feed-activity-copy .pf-feed-list-project{margin-top:5px}.pf-feed-note-card .pf-note{margin-top:5px}
      .pf-wrap[data-density="small"] .pf-tile-actor{gap:5px}.pf-wrap[data-density="small"] .pf-tile-actor .pf-actor-avatar{width:24px;height:24px;flex-basis:24px;font-size:9px}.pf-wrap[data-density="small"] .pf-tile-actor .pf-actor-badge{width:13px;height:13px;font-size:6px}.pf-wrap[data-density="small"] .pf-tile-actor time{display:none}.pf-wrap[data-density="small"] .pf-project-identity{font-size:10px}.pf-wrap[data-density="small"] .pf-feed-activity>time,.pf-wrap[data-density="large"] .pf-feed-activity>time,.pf-wrap[data-density="mosaic"] .pf-feed-activity>time{white-space:normal}
      .pf-wrap>.pf-toolbar{position:relative;top:auto;flex:none;background:transparent;z-index:1}.pf-wrap>[data-photo-feed-dynamic]{display:flex;flex:1;flex-direction:column;min-height:0;overflow:hidden}.pf-wrap>[data-photo-feed-dynamic]>.pf-scroll{flex:1;min-height:0}
      .pf-note-toggle{display:block}.pf-note-toggle .pf-note-preview{display:inline;max-height:none}.pf-note-toggle .pf-note-preview i,.pf-note-toggle .pf-note-expanded i{display:inline-block;margin-left:6px;font-size:10px;vertical-align:baseline;transition:transform .28s ease}.pf-note.expanded .pf-note-preview{display:none}.pf-note.expanded .pf-note-expanded i{transform:rotate(180deg)}.pf-note-expanded>span{min-height:0;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:#344054}
      .pf-note{position:relative}.pf-note-plain,.pf-note-measure{display:block;color:#475467;font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.pf-note-measure{position:absolute;top:0;left:0;width:100%;visibility:hidden;pointer-events:none}.pf-note .pf-note-toggle{display:none}.pf-note.expandable .pf-note-plain{display:none}.pf-note.expandable .pf-note-toggle{display:block}.pf-note-toggle .pf-note-preview{display:inline-flex;align-items:baseline;max-width:100%;min-width:0;vertical-align:top}.pf-note-toggle .pf-note-preview-text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-note-toggle .pf-note-preview i{flex:none;margin-left:6px}
      .pf-wrap[data-density="list"] .pf-feed-grid{display:block;max-width:none;overflow:hidden;gap:0;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px #10182808}
      .pf-wrap[data-density="list"] .pf-feed-list-row{grid-template-columns:46px minmax(0,1fr) minmax(240px,34%);align-items:start;border:0;border-radius:0;box-shadow:none;background:transparent}.pf-wrap[data-density="list"] .pf-feed-list-row+.pf-feed-list-row{border-top:1px solid #eaecf0}
      .pf-feed-list-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10px;min-width:0;line-height:1.35}.pf-feed-list-head strong{min-width:0}.pf-feed-list-when{white-space:nowrap;color:#667085;font-size:12px;font-weight:750;text-align:right}.pf-wrap[data-density="list"] .pf-feed-list-project{grid-column:3;grid-row:1;width:100%;max-width:none;min-width:0;align-self:stretch;box-sizing:border-box;padding-left:14px;border-left:1px solid #e9edf2}.pf-wrap[data-density="list"] .pf-project-card{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;gap:10px;width:100%;max-width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;text-align:left;white-space:normal;overflow:visible;box-sizing:border-box;line-height:1.35}.pf-wrap[data-density="list"] .pf-feed-list-project:hover .pf-project-card,.pf-wrap[data-density="list"] .pf-project-card:focus-visible{background:#f2f6fb;box-shadow:inset 0 0 0 1px #d3deea;text-decoration:none}.pf-project-card-cover{position:relative;width:96px;height:80px;border-radius:6px;background:#e6eaf0;color:#667085;display:grid;place-items:center;overflow:hidden;font-size:17px}.pf-project-card-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.pf-project-card-details{display:flex;flex-direction:column;gap:2px;min-width:0}.pf-project-card-name{color:#182230;font-size:12px;font-weight:850}.pf-project-card-address{color:#667085;font-size:11px;font-weight:550}.pf-wrap[data-density="list"] .pf-project-card:hover span{text-decoration:none}
      .pf-feed-list-document-thumb{display:block;position:relative;width:72px;height:72px;overflow:hidden;border:1px solid #e4e7ec;border-radius:8px;background:#f4f6f9;padding:0;cursor:pointer}.pf-feed-list-document-thumb img{display:block;width:100%;height:100%;object-fit:cover}.pf-feed-list-document-thumb .pf-document-icon{position:absolute;inset:0;gap:4px}.pf-feed-list-document-thumb .pf-document-icon i{font-size:20px}.pf-feed-list-document-thumb .pf-document-icon small{font-size:8px;text-align:center;padding:0 4px}.pf-feed-list-document-thumb:hover{border-color:var(--primary-readable,var(--primary,#d93025))}
      @media(max-width:760px){.pf-wrap[data-density="list"] .pf-feed-list-row{grid-template-columns:42px minmax(0,1fr) minmax(190px,38%);gap:10px;padding:11px}.pf-wrap[data-density="list"] .pf-feed-list-project{padding-left:10px}.pf-wrap[data-density="list"] .pf-project-card{grid-template-columns:72px minmax(0,1fr)}.pf-project-card-cover{width:72px;height:60px}}
      @media(max-width:560px){.pf-wrap[data-density="list"] .pf-feed-list-row{grid-template-columns:42px minmax(0,1fr)}.pf-wrap[data-density="list"] .pf-feed-list-project{grid-column:2;grid-row:2;border-left:0;padding-left:0}.pf-wrap[data-density="list"] .pf-project-card{max-width:100%;grid-template-columns:96px minmax(0,1fr)}.pf-project-card-cover{width:96px;height:80px}}
      .pf-note-list .pf-note-toggle{width:100%}.pf-note-list .pf-note-toggle:hover{color:#475467}.pf-note-list .pf-note-preview{display:flex;align-items:baseline;width:100%;max-width:100%;min-width:0;white-space:nowrap}.pf-note-list .pf-note-preview-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-note-list .pf-note-more{flex:none;margin-left:8px;color:var(--primary-readable,var(--primary,#d93025));font-weight:850;white-space:nowrap}.pf-note-list .pf-note-less{display:block;margin-top:6px;color:var(--primary-readable,var(--primary,#d93025));font-weight:850}.pf-note-list .pf-note-expanded>span{display:block}
      .pf-feed-list-media{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;margin:5px 0 2px}.pf-feed-list-media .pf-thumb{width:52px;height:52px;flex:0 0 52px;aspect-ratio:auto;border:0;border-radius:7px}.pf-feed-list-media .pf-thumb:nth-of-type(n+7){display:none}.pf-feed-list-media .pf-video-badge{width:19px;height:19px;right:3px;bottom:3px;font-size:8px}.pf-feed-list-more{flex:none;border:0;background:none;padding:5px 3px;color:var(--primary-readable,var(--primary,#d93025));font:inherit;font-size:11px;font-weight:850;cursor:pointer;white-space:nowrap}.pf-feed-list-more:hover{text-decoration:underline}.pf-feed-list-more.mobile{display:none}
      @media(max-width:760px){.pf-feed-list-media .pf-thumb{width:43px;height:43px;flex-basis:43px}.pf-feed-list-media .pf-thumb:nth-of-type(n+5){display:none}.pf-feed-list-more.desktop{display:none}.pf-feed-list-more.mobile{display:inline-block}}
      .pf-list-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pf-list-controls select{height:35px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:0 10px;font:inherit;font-size:12px;font-weight:750;cursor:pointer}.pf-list-controls label{display:flex;align-items:center;gap:6px;color:#475467;font-size:12px;font-weight:700}.pf-list-controls select:hover{border-color:#98a2b3;background:#f8fafc}
      .pf-activity-options{padding:4px 10px 10px}.pf-shown-head{align-items:center}
      @media(max-width:760px){.pf-wrap:has(.pf-feed-grid) .pf-shown-wrap .pf-toolbar-action span{display:inline}.pf-list-controls{width:100%;order:5}.pf-list-controls select{height:32px}}
      .pf-wrap[data-density="list"] .pf-feed-list-media .pf-thumb{display:block}.pf-wrap[data-density="list"] .pf-feed-list-media .pf-thumb[hidden],.pf-wrap[data-density="list"] .pf-feed-list-more[hidden]{display:none}.pf-feed-list-more{font-size:12px}.pf-feed-list-media{width:100%;box-sizing:border-box;white-space:nowrap}
      .pf-note-list .pf-note-preview{display:block;white-space:normal}.pf-note-list .pf-note-preview-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;white-space:normal;overflow:hidden;line-height:1.45;max-height:2.9em}.pf-note-list .pf-note-more{display:block;margin:3px 0 0;font-size:12px}.pf-note-list .pf-note-plain{max-width:100%}
      .pf-wrap[data-density="list"] .pf-project-group{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,34%);gap:0;align-items:start}.pf-wrap[data-density="list"] .pf-project-group+.pf-project-group{border-top:1px solid #e4e7ec}.pf-project-group-events{min-width:0;position:relative}.pf-project-group-events .pf-feed-list-row{position:relative;grid-template-columns:46px minmax(0,1fr);padding-right:14px}.pf-project-group-events .pf-feed-list-row:not(:last-child)::after{content:"";position:absolute;left:37px;top:55px;bottom:-18px;border-left:1px solid #d8e1eb}.pf-wrap[data-density="list"] .pf-project-group-project{grid-column:2;grid-row:1;position:sticky;top:12px;min-height:100%;padding:11px 14px;border-left:1px solid #e9edf2}.pf-project-group-project .pf-project-card{max-width:100%}
      .pf-wrap[data-density="list"] .pf-project-group-events .pf-feed-list-row{grid-template-columns:46px minmax(0,1fr)}.pf-wrap[data-density="list"] .pf-project-group-project{align-items:flex-start;box-sizing:border-box}
      .pf-wrap[data-density="list"] .pf-project-group-events .pf-feed-list-row+.pf-feed-list-row{border-top:0}
      @media(max-width:760px){.pf-wrap[data-density="list"] .pf-project-group{grid-template-columns:minmax(0,1fr) minmax(190px,38%)}.pf-project-group-events .pf-feed-list-row{grid-template-columns:42px minmax(0,1fr)}}
      @media(max-width:560px){.pf-wrap[data-density="list"] .pf-project-group{grid-template-columns:minmax(0,1fr) minmax(120px,34%)}.pf-wrap[data-density="list"] .pf-project-group-events .pf-feed-list-row{grid-template-columns:32px minmax(0,1fr);padding:8px}.pf-wrap[data-density="list"] .pf-project-group-project{grid-column:2;grid-row:1;padding:8px;border-left:1px solid #e9edf2}.pf-project-group-project .pf-project-card{grid-template-columns:1fr}.pf-project-group-project .pf-project-card-cover{width:100%;height:70px}}
      .pf-wrap[data-density="list"] .pf-feed-list-row{min-height:50px}.pf-wrap[data-density="list"] .pf-list-time-row{grid-template-columns:46px minmax(0,1fr) auto;align-items:start}.pf-list-time-row .pf-feed-list-copy{grid-template-columns:minmax(0,1fr)}.pf-list-time-row .pf-feed-list-head{display:block}.pf-feed-list-title{color:#182230;font-size:13px;line-height:1.35;font-weight:400}.pf-feed-list-title strong{font-weight:850}.pf-wrap[data-density="list"] .pf-list-time-row .pf-feed-list-project{grid-column:auto;grid-row:auto;align-self:auto;width:auto;max-width:100%;padding:0;border:0;font-size:12px}.pf-list-time-row .pf-project-identity{color:#667085;font-size:12px;font-weight:500}.pf-list-time-row .pf-feed-list-time{grid-column:3;grid-row:1;align-self:start;padding-top:1px}.pf-feed-list-preview{min-width:0}.pf-project-group-events .pf-feed-list-row.pf-no-preview{align-items:center}.pf-project-group-events .pf-feed-list-row.pf-no-preview .pf-feed-list-head{align-items:center}
      @media(max-width:760px){.pf-wrap[data-density="list"] .pf-list-time-row{grid-template-columns:42px minmax(0,1fr) auto}.pf-list-time-row .pf-feed-list-time{grid-column:3;grid-row:1;text-align:right;margin:0}}
      @media(max-width:560px){.pf-wrap[data-density="list"] .pf-list-time-row{grid-template-columns:42px minmax(0,1fr) auto;gap:10px}.pf-list-time-row .pf-feed-list-time{grid-column:3;grid-row:1}.pf-wrap[data-density="list"] .pf-list-time-row .pf-feed-list-project{grid-column:auto;grid-row:auto;padding:0;border:0}}
      .pf-feed-scopebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px 11px;border-bottom:1px solid #e9edf2;background:#fff}.pf-feed-scopebar label{display:flex;align-items:center;gap:8px;color:#475467;font-size:12px;font-weight:700}.pf-feed-scopebar select{min-width:170px;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:inherit}.pf-feed-scopebar>button{border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;padding:8px 11px;font-size:12px;font-weight:700;cursor:pointer}.pf-feed-scopebar>button.active{border-color:#b8c8ed;background:#eef4ff;color:#2456a8}.pf-feed-scopebar>button:last-child{margin-left:auto}.pf-create-post{white-space:nowrap}
      .pf-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:#1018288c}.fm-ch-modal-backdrop{z-index:10020!important}.fm-ch-popover{z-index:10021!important}.pf-emoji-widget{position:fixed;z-index:10021;width:300px;max-width:calc(100vw - 16px);max-height:340px;overflow:auto;border:1px solid #d0d5dd;border-radius:10px;background:#fff;box-shadow:0 8px 28px #10182829}.pf-dialog{width:min(590px,100%);max-height:min(90vh,850px);overflow:auto;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:16px;background:#fff;box-shadow:0 24px 70px #1018283d;padding:20px;display:grid;gap:16px;color:#344054}.pf-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid #eaecf0;padding-bottom:14px}.pf-dialog header strong{display:block;font-size:20px;color:#182230}.pf-dialog header span{display:block;margin-top:4px;font-size:12px;color:#667085}.pf-dialog header button{border:0;background:none;font-size:26px;line-height:1;color:#667085;cursor:pointer}.pf-dialog-field{display:grid;gap:7px;font-size:12px;font-weight:750}.pf-dialog-field select,.pf-dialog-field textarea{width:100%;box-sizing:border-box;padding:11px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#182230;font:inherit;font-size:14px}.pf-dialog-field textarea{resize:vertical;line-height:1.5}.pf-dialog footer{display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #eaecf0;padding-top:14px}.pf-dialog footer>button:not(.pf-action){border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:9px 14px;color:#344054;font-weight:700;cursor:pointer}.pf-tag-picker{min-width:0;border:1px solid #eaecf0;border-radius:10px;padding:10px}.pf-tag-picker legend{font-size:12px;font-weight:750}.pf-tag-picker>div{display:flex;flex-wrap:wrap;gap:7px;max-height:128px;overflow:auto}.pf-tag-picker label{display:flex;align-items:center;gap:5px;border-radius:20px;background:#f2f4f7;padding:5px 9px;font-size:12px;cursor:pointer}.pf-dialog-upload{display:inline-flex;align-items:center;gap:7px;justify-self:start;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;font-size:12px;font-weight:750;cursor:pointer}.pf-dialog-files{display:flex;flex-wrap:wrap;gap:6px}.pf-dialog-files span,.pf-manual-mentions span{padding:5px 8px;border-radius:15px;background:#eef4ff;color:#2456a8;font-size:11px}.pf-settings-dialog{width:min(640px,100%)}.pf-settings-actions{display:flex;gap:8px}.pf-settings-actions button{border:0;background:none;color:#2456a8;font-size:12px;font-weight:750;cursor:pointer}.pf-settings-types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:350px;overflow:auto}.pf-settings-types label{display:flex;align-items:center;gap:8px;padding:7px;border-radius:7px;font-size:12px}.pf-settings-types label:hover{background:#f2f4f7}
      .pf-manual-text{padding:12px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.55;color:#344054}.pf-post>.pf-manual-text{padding:4px 18px 14px}.pf-manual-mentions{display:flex;flex-wrap:wrap;gap:5px;margin:0 18px 12px}.pf-manual-images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:0 18px 16px}.pf-manual-images a{display:block;aspect-ratio:1/1;overflow:hidden;border-radius:7px;background:#f2f4f7}.pf-manual-images img{width:100%;height:100%;object-fit:cover}.pf-manual-images:not(.expanded) [data-feed-extra-image]{display:none}.pf-manual-images button{grid-column:1/-1;justify-self:start;border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));padding:5px 0;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.pf-manual-tile .pf-manual-text,.pf-manual-row .pf-manual-text{padding:5px 0}.pf-manual-tile .pf-manual-mentions,.pf-manual-row .pf-manual-mentions{margin:0 0 8px}.pf-manual-tile .pf-manual-images,.pf-manual-row .pf-manual-images{padding:0;grid-template-columns:repeat(3,minmax(0,90px))}.pf-post-scope{display:inline-flex;gap:5px;align-items:center}.pf-post-scope i{font-size:11px}
      .pf-comments{padding:16px 18px 18px;background:#f8fafc}.pf-comments-title{display:flex;align-items:center;gap:7px;margin:0 0 16px;color:#344054;font-size:13px}.pf-comments-title span{padding:2px 7px;border-radius:12px;background:#e9eef5;color:#667085;font-size:11px}.pf-comment{gap:10px;margin:0 0 18px}.pf-comment>.pf-post-avatar{width:34px;height:34px;flex-basis:34px}.pf-comment-head{align-items:baseline}.pf-comment-head strong{color:#182230}.pf-comment [data-comment-content]{display:inline-block;max-width:100%;box-sizing:border-box;padding:10px 13px;margin-top:6px;border-radius:5px 13px 13px 13px;background:#fff;border:1px solid #e4e7ec;line-height:1.5;color:#344054;box-shadow:0 1px 2px #10182808}.pf-comment-actions{gap:12px;margin-top:7px;padding-left:2px}.pf-comment-actions button{font-weight:700}.pf-comment-actions button:hover{text-decoration:underline;color:#2456a8}.pf-comment-compose{display:flex;align-items:flex-start;gap:10px;padding-top:14px;border-top:1px solid #e4e7ec}.pf-comment-compose>.pf-post-avatar{width:34px;height:34px;flex-basis:34px}.pf-comment-compose-body{flex:1;min-width:0}.pf-comment-label textarea{margin:0;min-height:70px;border-radius:11px;line-height:1.45;box-shadow:0 1px 2px #10182808}.pf-comment-label textarea:focus{outline:2px solid #bfd7ff;border-color:#5792e4}.pf-comment-tools{gap:12px}.pf-comment-tools details summary{list-style:none;cursor:pointer}.pf-comment-tools details summary:hover,.pf-comment-attach:hover{color:#2456a8}.pf-comment-attach{font-size:12px;font-weight:700;cursor:pointer}.pf-comment-reply-target{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;padding:6px 9px;border-radius:7px;background:#eaf1ff;color:#2456a8;font-size:11px;font-weight:700}.pf-comment-reply-target button{border:0;background:none;color:inherit;font-size:16px;cursor:pointer}.pf-post-actions .pf-post-react{flex:1;text-align:center}.pf-post-actions .pf-post-react summary{border-radius:7px;color:#667085;font-size:13px}.pf-post-actions .pf-post-react summary:hover{background:#f2f4f7}.pf-post-actions .pf-post-react summary span{margin-left:5px}.pf-post-stats button:hover{text-decoration:underline}
      .pf-post-react>div{visibility:hidden;opacity:0;pointer-events:none;transition:opacity .12s ease}.pf-post-react:hover>div,.pf-post-react:focus-within>div,.pf-post-react.open>div{visibility:visible;opacity:1;pointer-events:auto}.pf-reaction-count{display:inline-flex;margin-right:8px;padding:2px 5px;border-radius:99px;cursor:help}.pf-reaction-count:hover{background:#eef4ff}.pf-comment.pf-comment-reply{margin-left:30px}.pf-comment-edit{display:grid;gap:8px;margin-top:6px}.pf-comment-edit textarea{width:100%;min-height:68px;box-sizing:border-box;border:1px solid #b8c7da;border-radius:9px;padding:9px;font:inherit}.pf-comment-edit>div{display:flex;gap:7px}.pf-comment-edit button{border:1px solid #d0d5dd;border-radius:7px;background:#fff;padding:6px 10px;cursor:pointer}.pf-comment-edit button[type="submit"]{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}.pf-comment-head em{font-style:normal;color:#667085;font-size:11px;font-weight:500}
      .pf-post-react>button{width:100%;border:0;background:none;border-radius:7px;color:#667085;font-size:13px;padding:10px;cursor:pointer}.pf-post-react>button:hover{background:#f2f4f7}.pf-post-react>button span{margin-left:5px}
      .pf-comment-tools>button:not([type="submit"]){border:0;background:none;color:#475467;font-size:12px;font-weight:700;cursor:pointer;padding:5px}.pf-comment-tools>button:not([type="submit"]):hover{color:var(--primary,#d93025)}[data-comment-emoji-picker]:not([hidden]){display:block;max-height:230px;overflow:auto;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:8px;box-shadow:0 8px 30px #1018281a}[data-comment-emoji-picker] input{width:100%;box-sizing:border-box;padding:7px;border:1px solid #d0d5dd;border-radius:6px}[data-comment-emoji-picker] .pf-emoji-grid{display:grid;grid-template-columns:repeat(9,1fr);gap:2px}[data-comment-emoji-picker] button{border:0;background:none;font-size:21px;cursor:pointer;padding:4px}.pf-gif-dialog{width:min(580px,92vw)}.pf-gif-grid{height:280px;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pf-gif-grid button{border:2px solid transparent;background:#f2f4f7;border-radius:8px;overflow:hidden;padding:0;cursor:pointer}.pf-gif-grid button.selected{border-color:var(--primary,#d93025)}.pf-gif-grid img{display:block;width:100%;height:125px;object-fit:cover}.pf-gif-dialog footer{align-items:center}.pf-gif-dialog footer a{margin-right:auto;font-size:11px;color:#667085}
      .pf-compose-audience{display:flex;align-items:center;gap:4px;font-size:13px;color:#475467}.pf-compose-audience select{appearance:none;border:0;background:transparent;color:#182230;font:inherit;font-weight:750;max-width:260px;cursor:pointer}.pf-compose-audience i{font-size:10px;pointer-events:none}.pf-compose-message{position:relative}.pf-compose-message textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:150px;padding:12px;border:1px solid #d0d5dd;border-radius:10px;font:inherit;font-size:14px}.pf-mention-menu{position:absolute;left:0;right:0;top:100%;z-index:8;max-height:190px;overflow:auto;border:1px solid #d0d5dd;border-radius:8px;background:#fff;box-shadow:0 12px 30px #1018281f}.pf-mention-menu[hidden]{display:none}.pf-mention-menu button{display:block;width:100%;padding:9px 12px;border:0;background:#fff;text-align:left;cursor:pointer}.pf-mention-menu button:hover{background:#f2f4f7}.pf-dialog-files{gap:10px}.pf-image-preview{position:relative;width:84px;height:84px}.pf-image-preview>button:first-child{width:100%;height:100%;padding:0;border:0;border-radius:8px;overflow:hidden;cursor:zoom-in}.pf-image-preview img{width:100%;height:100%;object-fit:cover}.pf-image-preview>button:last-child{position:absolute;right:-6px;top:-6px;width:22px;height:22px;border:0;border-radius:50%;background:#344054;color:#fff;cursor:pointer}.pf-image-lightbox{position:fixed;inset:0;z-index:10010;display:grid;place-items:center;background:#101828e6;padding:30px}.pf-image-lightbox img{max-width:90vw;max-height:85vh;object-fit:contain}.pf-image-lightbox button{position:absolute;right:25px;top:18px;border:0;background:transparent;color:#fff;font-size:30px;cursor:pointer}
      @media(max-width:760px){.pf-feed-scopebar{padding:9px 11px}.pf-feed-scopebar>button:last-child{margin-left:0}.pf-dialog{padding:15px}.pf-settings-types{grid-template-columns:1fr}.pf-comment-tools{gap:8px}.pf-comment-tools>button[type="submit"]{width:100%}}
      @media(max-width:760px){.pf-wrap[data-density="mosaic"] .pf-feed-grid{columns:2}}
      .pf-comment-children{margin:2px 0 13px 42px;padding-left:12px;border-left:2px solid #e4e7ec}.pf-comment-children[hidden]{display:none}.pf-comment-children .pf-comment{margin-left:0}.pf-comment-replies-toggle{margin:0 0 9px 43px;border:0;background:none;color:#2456a8;font-size:11px;font-weight:750;cursor:pointer;padding:2px 0}.pf-comment-replies-toggle:hover{text-decoration:underline}
      .pf-emoji-picker:not([hidden]){display:block;max-height:230px;overflow:auto;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:8px;box-shadow:0 8px 30px #1018281a}.pf-emoji-picker input{width:100%;box-sizing:border-box;padding:7px;border:1px solid #d0d5dd;border-radius:6px}.pf-emoji-picker .pf-emoji-grid{display:grid;grid-template-columns:repeat(9,1fr);gap:2px}.pf-emoji-picker button{border:0;background:none;font-size:21px;cursor:pointer;padding:4px}.pf-file-preview{display:flex;align-items:center;gap:7px;border:1px solid #e4e7ec;border-radius:8px;padding:6px 8px;font-size:11px;max-width:100%}.pf-file-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-file-preview button{border:0;background:none;cursor:pointer;font-size:16px}
      .pf-manual-gif,.pf-manual-files{padding:0 18px 14px}.pf-manual-gif img{display:block;max-width:100%;max-height:300px;border-radius:8px}.pf-manual-files{display:grid;gap:8px}.pf-manual-files a{color:#2456a8;font-size:12px}.pf-manual-tile .pf-manual-gif,.pf-manual-row .pf-manual-gif,.pf-manual-tile .pf-manual-files,.pf-manual-row .pf-manual-files{padding:0 0 9px}
      .pf-comment-tools .pf-compose-tool,.pf-post-compose-tools .pf-compose-tool{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;border-radius:8px;background:transparent;color:#667085;font-size:12.5px;cursor:pointer;padding:0}.pf-comment-tools .pf-compose-tool:hover,.pf-post-compose-tools .pf-compose-tool:hover{background:#f2f4f7;color:var(--primary-readable,var(--primary,#d93025))}.pf-gif-icon{font-size:10px;font-weight:800;border:1.5px solid currentColor;border-radius:3px;padding:1px}.pf-post-compose-tools{display:flex;align-items:center;gap:8px}.pf-comment-tools{gap:7px}.pf-composer-gif{position:relative;justify-self:start}.pf-composer-gif img{max-width:240px;max-height:160px;border-radius:8px}.pf-composer-gif button{position:absolute;top:-7px;right:-7px;width:22px;height:22px;border:0;border-radius:50%;background:#344054;color:#fff;cursor:pointer}
      .pf-wrap[data-density="posts"] .pf-tools{margin-left:auto}
      .pf-feed-scope-departments button[hidden]{display:none}
      .pf-feed-scope-trigger{border:0;background:transparent;padding:0 7px;color:#344054}.pf-feed-scope-trigger:hover,.pf-feed-scope-trigger[aria-expanded="true"]{background:#f2f4f7}.pf-feed-scope-trigger:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:2px}
      .pf-comment-input{border:1px solid #d0d5dd;border-radius:15px;background:#f2f4f7;overflow:hidden}.pf-comment-input:focus-within{border-color:#5792e4;box-shadow:0 0 0 2px #bfd7ff}.pf-comment-input .pf-comment-label textarea{min-height:102px;border:0;border-radius:0;background:transparent;box-shadow:none;resize:vertical;padding:12px 13px 4px}.pf-comment-input .pf-comment-label textarea:focus{outline:0;border:0}.pf-comment-input .pf-comment-tools{margin:0;padding:2px 7px 7px;flex-wrap:nowrap}.pf-comment-input .pf-comment-tools [data-comment-attachments]{min-width:0;flex:1}.pf-comment-input .pf-comment-send{display:inline-flex;align-items:center;justify-content:center;width:29px;height:29px;flex:none;margin-left:auto;border:0;border-radius:8px;background:transparent;color:var(--primary-readable,var(--primary,#d93025));cursor:pointer}.pf-comment-input .pf-comment-send:disabled{opacity:.4}.pf-comment-input .pf-comment-send:hover:not(:disabled){background:#fff}
      .pf-post-list-line{padding-left:15px}.pf-manual-text blockquote{display:inline-block;margin:2px 0;padding:1px 0 1px 10px;border-left:3px solid #cbd5e1;color:#667085}.pf-manual-text a{color:#2456a8;text-decoration:underline}
      .pf-compose-author{display:flex;align-items:center;gap:10px}.pf-compose-author .pf-post-avatar{width:40px;height:40px;flex:0 0 40px;border-radius:50%;object-fit:cover}.pf-compose-message{border:1px solid #d0d5dd;border-radius:12px;overflow:visible;background:#fff}.pf-compose-message:focus-within{border-color:#5792e4;box-shadow:0 0 0 2px #bfd7ff}.pf-post-formatbar{display:flex;align-items:center;gap:3px;flex-wrap:wrap;margin:0 9px;padding:6px 0;border-bottom:1px solid #eaecf0}.pf-post-formatbar button{min-width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#667085;font:inherit;font-size:13px;cursor:pointer}.pf-post-formatbar button:hover{background:#f2f4f7;color:#344054}.pf-compose-message [data-feed-compose-text]{min-height:300px;max-height:55vh;overflow-y:auto;margin:0;width:100%;box-sizing:border-box;padding:12px;border:0;border-radius:0;outline:0;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere}.pf-compose-message [data-feed-compose-text]:empty:before{content:attr(data-placeholder);color:#98a2b3;pointer-events:none}.pf-post-compose-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 10px}.pf-post-compose-bottom .pf-action{min-width:64px}.pf-image-lightbox{background:#101828ba;backdrop-filter:blur(4px)}.pf-image-lightbox-panel{width:min(900px,94vw);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;border-radius:15px;background:#fff;box-shadow:0 25px 65px #10182855}.pf-image-lightbox-panel header{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:10px 15px;border-bottom:1px solid #e4e7ec}.pf-image-lightbox-panel header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#344054;font-size:13px}.pf-image-lightbox-panel header button{position:static;width:34px;height:34px;flex:none;border-radius:8px;color:#344054;font-size:24px}.pf-image-lightbox-panel img{display:block;max-width:100%;max-height:calc(92vh - 57px);margin:auto;padding:12px;box-sizing:border-box;object-fit:contain}
      .pf-feed-scope-control{position:relative;flex:none}.pf-feed-scope-trigger{display:flex;align-items:center;gap:8px;min-height:38px;padding:0 12px;border:1px solid #344054;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.pf-feed-scope-trigger>span{color:#667085}.pf-feed-scope-trigger strong{font-weight:800;color:#182230}.pf-feed-scope-trigger i{margin-left:3px;font-size:10px}.pf-feed-scope-menu{position:absolute;top:calc(100% + 7px);left:0;z-index:30;width:300px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:9px;background:#fff;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 14px 32px #10182822}.pf-feed-scope-menu>button,.pf-feed-scope-departments button{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 11px;border:0;border-radius:8px;background:#fff;color:#344054;text-align:left;font:inherit;font-size:12px;cursor:pointer}.pf-feed-scope-menu button:hover,.pf-feed-scope-menu button[aria-selected="true"]{background:#f2f4f7}.pf-feed-scope-menu button i{color:var(--primary-readable,var(--primary,#d93025))}.pf-feed-scope-section{margin:6px 3px 8px;padding:11px 8px 0;border-top:1px solid #e4e7ec;color:#667085;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.pf-feed-scope-search{display:flex;align-items:center;gap:8px;margin:0 2px 6px;padding:0 10px;border:1px solid #d0d5dd;border-radius:8px;color:#667085}.pf-feed-scope-search input{width:100%;min-width:0;height:35px;border:0;outline:0;font:inherit;font-size:12px}.pf-feed-scope-departments{max-height:220px;overflow:auto}.pf-list-controls{flex-wrap:nowrap;color:#667085;font-size:12px}.pf-list-segment{display:flex;align-items:center;padding:3px;border:1px solid #d0d5dd;border-radius:10px;background:#fff}.pf-list-segment button{border:0;border-radius:7px;background:transparent;color:#344054;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer}.pf-list-segment button.active{background:#fff0ee;color:var(--primary-readable,var(--primary,#d93025));font-weight:850}
      .pf-compose-audience{display:inline-flex;justify-self:start;max-width:100%}.pf-compose-audience-picker{display:inline-flex;align-items:center;gap:6px;position:relative;max-width:100%;color:#182230;font-weight:750}.pf-compose-audience-picker select{position:absolute;inset:0;width:100%;height:100%;max-width:none;opacity:0;cursor:pointer}.pf-compose-audience-picker i{font-size:10px;pointer-events:none}
      .pf-comment-reactions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.pf-comment-reactions button{border:1px solid #dce5f0;border-radius:999px;background:#fff;padding:2px 7px;color:#344054;font-size:11px;cursor:pointer}.pf-comment-reactions button:hover{background:#eef4ff;border-color:#b8c8ed}.pf-comment-actions .pf-comment-react{position:relative;display:inline-flex;align-items:center}.pf-comment-react>div{position:absolute;left:0;bottom:100%;z-index:12;display:flex;gap:2px;padding:6px;border:1px solid #e4e7ec;border-radius:20px;background:#fff;box-shadow:0 4px 20px #10182820;visibility:hidden;opacity:0;pointer-events:none;transition:opacity .12s ease}.pf-comment-react:hover>div,.pf-comment-react:focus-within>div,.pf-comment-react.open>div{visibility:visible;opacity:1;pointer-events:auto}.pf-comment-actions .pf-comment-react>div button{font-size:20px;padding:3px 5px}
      .pf-feed-scope-trigger{border:0;padding:0 8px;background:transparent}.pf-feed-scope-trigger:hover,.pf-feed-scope-trigger[aria-expanded="true"]{background:#f2f4f7}.pf-feed-scope-trigger:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:2px}
      .pf-compose-author-copy{display:grid;gap:3px;min-width:0}.pf-compose-author-copy>strong{color:#182230;font-size:13px}.pf-dialog [data-feed-compose-dictation-mount]:empty,.pf-dialog [data-feed-compose-audio-mount]:empty,.pf-dialog-files:empty{display:none}
      .pf-image-lightbox{background:#101828ba;backdrop-filter:blur(4px)}.pf-image-lightbox-panel header button{position:static;width:34px;height:34px;flex:none;border-radius:8px;color:#344054;font-size:24px}
      .pf-post-image-viewer{z-index:10015}.pf-post-image-stage{display:flex;align-items:center;justify-content:center;min-height:160px;min-width:0}.pf-post-image-stage img{max-width:calc(100% - 96px);max-height:calc(92vh - 70px)}.pf-post-image-stage button{position:static;flex:0 0 48px;height:64px;border:0;background:transparent;color:#344054;font-size:42px;cursor:pointer}.pf-post-image-stage button:hover{background:#f2f4f7}.pf-post-image-stage button[hidden]{visibility:hidden}
      @media(max-width:760px){.pf-wrap[data-density="posts"] .pf-toolbar{flex-wrap:wrap}.pf-wrap[data-density="posts"] .pf-tools{flex:1 1 100%;justify-content:flex-end;flex-wrap:wrap}.pf-feed-scope-menu{left:auto;right:0}.pf-list-controls{width:auto;order:0}.pf-list-segment button{padding:6px 9px}}
      @media(prefers-reduced-motion:reduce){.pf-note-toggle .pf-note-preview,.pf-note-toggle i,.pf-note-expanded{transition:none}}
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
      const catalog = await window.ChannelsAPI.feed.catalog(oid,state.departmentId||'');
      state.departmentContext=catalog.department_context||{};
      state.views = catalog.views;
      state.canComment = catalog.can_comment;
      state.canReact = catalog.can_react;
      state.canPost = catalog.can_post === true;
      state.canManagePostSettings = catalog.can_manage_post_settings === true;
      state.manualPosts = Array.isArray(catalog.manual_posts) ? catalog.manual_posts : [];
      state.departments = Array.isArray(catalog.departments) ? catalog.departments : [];
      state.userDepartments = objectValue(catalog.user_departments);
      state.memberDepartmentIds = Array.isArray(catalog.member_department_ids) ? catalog.member_department_ids : [];
      state.postSettings = objectValue(catalog.post_settings);
      state.activityOptions = Array.isArray(catalog.activity_options) ? catalog.activity_options : [];
      if (state.feedScope !== 'all' && state.feedScope !== 'mine' && !state.memberDepartmentIds.includes(state.feedScope)) state.feedScope = 'all';
      for (const manual of state.manualPosts) {
        const current=postState(`manual:${manual.id}`);
        current.root=manual;
      }
      if (!state.views.includes(state.density)) state.density = state.views[0];
      const result={documents:catalog.projects},mediaResult={media:catalog.media},activityResult={events:catalog.events},userResult={documents:catalog.users};
      const projects = (Array.isArray(result?.documents) ? result.documents : [])
        .filter((doc) => doc && typeof doc === 'object')
        .map(hydrateProject)
        .filter((project) => project && (project.id || project.address || project.title || Array.isArray(project.photos)));
      state.projects = attachOwnedMedia(projects, Array.isArray(mediaResult?.media) ? mediaResult.media : []);
      state.items = buildItems(state.projects);
      state.groups = buildGroups(state.items);
      state.activity = Array.isArray(activityResult?.events) ? activityResult.events : [];
      const directoryUsers = (Array.isArray(userResult?.documents) ? userResult.documents : []).map((entry) => objectValue(entry.data && typeof entry.data === 'object' ? { ...entry.data, id:firstText(entry.data.id, entry.id) } : entry));
      const memberResult = window.PlatformAPI?.users?.list ? await window.PlatformAPI.users.list(oid).catch(() => null) : null;
      const members = (memberResult?.documents || []).map((entry) => ({ ...objectValue(entry.data), id:firstText(entry.id,entry.data?.id) }));
      const byId = new Map(directoryUsers.map((user) => [cleanText(user.id), user]));
      members.forEach((member) => byId.set(cleanText(member.id), { ...(byId.get(cleanText(member.id)) || {}), ...member }));
      state.users = [...byId.values()];
      state.notes = await loadFeedNotes(oid, state.projects);
      state.documents = projectDocumentsFromProjects(state.projects);
      if (state.visibleDocuments.size) await loadFeedDocuments();
      await authorizeFeedEntries();
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
    if (item.photo?.media_id && !isVideoMedia(item.photo) && markupThumbnailRevisions.has(item.photo.media_id) && window.PlatformAPI?.media?.markupThumbnailUrl) {
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
  function galleryMediaType(photo = {}){
    const mime=cleanText(photo.content_type || photo.mime_type).toLowerCase();
    if(mime.startsWith('video/') || isVideoMedia(photo)) return 'video';
    if(mime.startsWith('audio/')) return 'audio';
    if(mime && !mime.startsWith('image/')) return 'document';
    return 'photo';
  }
  function mediaThumbHtml(item){
    const kind=galleryMediaType(item.photo);
    if(kind==='document' || kind==='audio') return documentPreviewHtml({...item.photo,url:photoOriginal(item),title:item.photo.label,type_label:kind==='audio'?'Audio':'File',icon:kind==='audio'?'fa-headphones':'fa-file-lines'});
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
            <button type="button" class="pf-picker-close" data-picker-close aria-label="${(globalThis.PlatformLanguage?.htmlText("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
          </div>
          <div class="pf-picker-body">
            ${String(items.length ? `
              <div class="pf-grid pf-picker-grid">
                ${items.map((item) => {
                  const selectedClass = selected.has(item.id) ? ' selected' : '';
                  return `<button type="button" class="pf-thumb${selectedClass}${item.photo?.uploading ? ' uploading' : ''}${['audio','document'].includes(galleryMediaType(item.photo)) || (isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item)) ? ' loaded video-placeholder' : ''}" data-picker-media-id="${escapeHtml(item.id)}" aria-pressed="${selected.has(item.id) ? 'true' : 'false'}"><span class="pf-select"><i class="fas fa-check"></i></span>${mediaThumbHtml(item)}<span class="pf-thumb-meta">${escapeHtml(item.photo?.label || item.photo?.alt || 'Project media')}</span></button>`;
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
            <button type="button" class="pf-action" data-picker-upload><i class="fas fa-upload"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_9ca9dace4f122f"," Upload") ?? " Upload")}</button>
            <input type="file" data-picker-file accept="${String(escapeHtml(uploadAccept))}" ${String(multiple ? 'multiple' : '')} hidden>
            <div style="flex:1"></div>
            <button type="button" class="pf-action" data-picker-clear ${String(selected.size ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.htmlText("photos","m_506191e24dd383","Clear") ?? "Clear")}</button>
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
            return `<button type="button" class="pf-thumb${extraClass ? ` ${escapeHtml(extraClass)}` : ''}${selected ? ' selected' : ''}${item.photo?.uploading ? ' uploading' : ''}${['audio','document'].includes(galleryMediaType(item.photo)) || (isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item)) ? ' loaded video-placeholder' : ''}" data-photo-feed-id="${escapeHtml(item.id)}"${selectionEnabled ? ` aria-pressed="${selected ? 'true' : 'false'}"` : ''}>${selectionEnabled ? `<span class="pf-select" data-photo-select="${escapeHtml(item.id)}"><i class="fas fa-check"></i></span>` : ''}${thumbnail}<span class="pf-thumb-meta">${meta}</span></button>`;
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
    const author = postAuthor({ kind:'media', media:item.photo, source:{ author:firstText(item.photo?.uploaded_by_user_id,item.photo?.metadata?.uploaded_by_user_id,up.id) } });
    const selected = state.selected.has(item.id);
    return `
      <article class="pf-feed-card pf-feed-media-card">
        <button type="button" class="pf-thumb${selected ? ' selected' : ''}${item.photo?.uploading ? ' uploading' : ''}${['audio','document'].includes(galleryMediaType(item.photo)) || (isVideoMedia(item.photo) && !photoThumb(item) && !photoOriginal(item)) ? ' loaded video-placeholder' : ''}" data-photo-feed-id="${escapeHtml(item.id)}" aria-pressed="${selected ? 'true' : 'false'}">
          <span class="pf-select" data-photo-select="${escapeHtml(item.id)}"><i class="fas fa-check"></i></span>
          ${mediaThumbHtml(item)}
        </button>
        <div class="pf-feed-card-body">
          <div class="pf-tile-actor">${actorAvatarHtml(author,isVideoMedia(item.photo)?'fa-video':'fa-image')}<span><strong title="${escapeHtml(author.name)} uploaded a ${isVideoMedia(item.photo)?'video':'photo'}">${escapeHtml(author.name)} uploaded a ${isVideoMedia(item.photo)?'video':'photo'}</strong><time>${escapeHtml(feedListTime(entry.timestamp))}</time></span></div>
          <div class="pf-feed-list-project">${feedProjectLinkHtml(entry.project,entry.projectId)}</div>
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
    const author = postAuthor({ kind:'document', document:doc, source:{ author:firstText(doc.uploaded_by_user_id,doc.created_by,doc.uploaded_by) } });
    return `
      <article class="pf-feed-card pf-feed-document-card">
        <button type="button" class="pf-document-preview" data-feed-document-id="${escapeHtml(entry.id)}"${doc.url ? '' : ' aria-disabled="true"'}>
          ${documentPreviewHtml(doc)}
          <span class="pf-document-badge" style="--feed-doc-color:${escapeHtml(doc.color || '#64748b')}">${escapeHtml(doc.type_label || 'Document')}</span>
        </button>
        <div class="pf-feed-card-body">
          <div class="pf-tile-actor">${actorAvatarHtml(author,doc.icon || 'fa-file-lines')}<span><strong>${escapeHtml(author.name)}</strong><time>${escapeHtml(feedListTime(entry.timestamp))}</time></span></div>
          <strong class="pf-document-title">${escapeHtml(doc.title || (globalThis.PlatformLanguage?.text("photos","m_9c9b98b1f4e8c9","Document") ?? "Document"))}</strong>
          <div class="pf-feed-list-project">${feedProjectLinkHtml(entry.project,entry.projectId)}</div>
          ${pairedActivityHtml(entry.pairedEvent)}
        </div>
      </article>`;
  }
  function feedActivityEntryHtml(entry = {}){
    const event = entry.event;
    const author = postAuthor({ kind:'activity', event, source:{ author:cleanText(event.actor_user_id) } });
    return `
      <article class="pf-feed-activity">
        ${actorAvatarHtml(author,feedActivityIcon(event))}
        <div class="pf-feed-activity-copy">
          <strong>${escapeHtml(feedActivitySummary(event))}</strong>
          <div class="pf-feed-list-project">${feedProjectLinkHtml(entry.project,entry.projectId)}</div>
        </div>
        <time>${escapeHtml(feedListTime(entry.timestamp))}</time>
      </article>`;
  }
  function feedNoteEntryHtml(entry = {}){
    const author = postAuthor({kind:'note',note:entry.note,source:{author:entry.note?.author?.id}});
    return `<article class="pf-feed-activity pf-feed-note-card">${actorAvatarHtml(author,'fa-note-sticky')}<div class="pf-feed-activity-copy"><strong>${escapeHtml(author.name)} added a note:</strong>${feedNoteHtml(entry.note)}<div class="pf-feed-list-project">${feedProjectLinkHtml(entry.project,entry.projectId)}</div></div><time>${escapeHtml(feedListTime(entry.timestamp))}</time></article>`;
  }
  function startFeedPolling(){
    clearInterval(state.feedTimer);
    state.feedTimer=setInterval(async()=>{
      if(state.density!=='posts' || document.hidden || !state.root?.isConnected)return;
      const changedPosts=[];
      for(const post of groupedPosts(feedEntries()).slice(0,state.visible)){
        if (post.kind === 'note') continue;
        const current=postState(post.id);if(!current.root || current.busy || current.checking)continue;
        const prior=JSON.stringify([current.root.reactions,current.root.reply_count,current.replies]);
        try{await fetchPost(post);if(prior!==JSON.stringify([current.root.reactions,current.root.reply_count,current.replies]))changedPosts.push(post);}
        catch(error){if([403,404].includes(error.status)){if(post.kind==='manual')state.manualPosts=state.manualPosts.filter(message=>message.id!==post.manual.id);else post.entries.forEach(entry=>state.authorizedSources.delete(feedRefKey(entryRef(entry))));current.root=null;current.replies=[];changedPosts.push(post);}}
      }
      for(const post of changedPosts){
        const card=[...state.root.querySelectorAll('[data-feed-post]')].find(node=>node.dataset.feedPost===post.id);
        if(!card)continue;
        if(!currentPostStillVisible(post)){card.remove();continue;}
        const wrapper=document.createElement('div');wrapper.innerHTML=feedPostHtml(post);
        const updated=wrapper.firstElementChild;
        card.replaceWith(updated);
        bindFeedPosts(state.root,updated);
      }
    },15000);
  }
  function currentPostStillVisible(post){return post.kind!=='manual' || state.manualPosts.some(message=>message.id===post.manual.id);}
  function entryRef(entry){
    return {kind:entry.kind,id:String(entry.kind==='media' ? photoIdentity(entry.media) : entry.kind==='document' ? entry.document.id : entry.event.id),project_id:String(entry.projectId || '')};
  }
  function feedRefKey(ref){ return JSON.stringify([ref.kind,ref.id,ref.project_id || '']); }
  async function authorizeFeedEntries(){
    const refs=[...state.items.map(item=>({kind:'media',id:photoIdentity(item.photo),project_id:cleanText(item.projectId)})),...state.documents.map(doc=>({kind:'document',id:cleanText(doc.id),project_id:cleanText(doc.project_id)})),...state.activity.map(event=>({kind:'activity',id:cleanText(event.id),project_id:activityProjectId(event)}))].filter(ref=>ref.id);
    const sources=new Map();
    for(let i=0;i<refs.length;i+=200){
      const result=await window.ChannelsAPI.feed.authorize(orgId(),refs.slice(i,i+200),state.departmentId||'');
      for(const source of result.sources || []) sources.set(feedRefKey(source.ref),source);
    }
    state.authorizedSources=sources;
  }
  function groupedPosts(entries){
    const groups=new Map();
    for(const entry of entries){
      const source=entry.kind === 'manual'
        ? { key:entry.id, author:entry.manual?.author?.id }
        : entry.kind === 'note'
        ? { key:`note:${entry.note.id}`, author:cleanText(entry.note.author?.id) }
        : state.authorizedSources.get(feedRefKey(entryRef(entry)));
      if(!source)continue;
      let group=groups.get(source.key);
      if(!group){group={...entry,id:source.key,source,entries:[]};groups.set(source.key,group);}
      group.entries.push(entry);
    }
    return [...groups.values()];
  }
  function postState(key){
    if(!state.posts.has(key))state.posts.set(key,{loaded:false,open:false,root:null,replies:[],draft:'',busy:false});
    return state.posts.get(key);
  }
  function postAuthor(post){
    if (post.kind === 'manual') return {id:cleanText(post.manual?.author?.id),name:firstText(post.manual?.author?.name,'Employee'),avatar:firstText(post.manual?.author?.profile_photo_url,post.manual?.author?.avatar)};
    const documentUploader=post.kind==='document' ? firstText(post.document?.uploaded_by_user_id,post.document?.created_by_user_id,objectValue(post.document?.metadata).uploaded_by_user_id,post.pairedEvent?.actor_user_id) : '';
    const person=state.users.find(u=>cleanText(u.id || u.user_id)===cleanText(post.source?.author))
      || (documentUploader ? state.users.find(u=>cleanText(u.id || u.user_id)===documentUploader) : null);
    const up=post.kind==='media'?uploader(post.media):{};
    const profile=person?.profile && typeof person.profile==='object' ? person.profile : {};
    return {id:firstText(person?.id,person?.user_id,post.note?.author?.id,documentUploader,post.source?.author,post.event?.actor_user_id),name:firstText(person?.name,person?.display_name,post.note?.author?.name,up.name,up.email,post.kind==='activity'?feedActor(post.event):'', 'System activity'),
      avatar:firstText(person?.profile_photo_url,person?.profile_photo,profile.profile_photo,profile.profile_photo_url,person?.avatar_url,person?.avatar,post.note?.author?.avatar,up.avatar)};
  }
  function postIcon(post){
    return post.kind==='manual' ? 'fa-pen-to-square' : post.kind==='media' ? 'fa-images' : post.kind==='document' ? 'fa-file-contract' : post.kind==='note' ? 'fa-note-sticky' : feedActivityIcon(post.event);
  }
  function uploadCountLabel(entries){
    const videos=entries.filter((entry)=>isVideoMedia(entry.media)).length;
    const photos=entries.length-videos;
    return [photos ? `${photos} ${photos===1?'photo':'photos'}` : '',videos ? `${videos} ${videos===1?'video':'videos'}` : ''].filter(Boolean).join(' and ');
  }
  function actorAvatarHtml(author, icon){
    const avatar=cleanText(author.avatar);
    const image=/^(https?:\/\/|\/)/.test(avatar)
      ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(author.name)}">`
      : `<span aria-hidden="true">${escapeHtml(author.name.slice(0,1).toUpperCase())}</span>`;
    const userId=cleanText(author.id);
    const preview=userId ? ` data-fm-summary-type="summary.user" data-fm-summary-target="${escapeHtml(JSON.stringify({scope:'organization',organizationId:orgId(),id:userId}))}" tabindex="0" aria-label="Preview user: ${escapeHtml(author.name)}"` : '';
    return `<span class="pf-actor-avatar"${preview}>${image}<span class="pf-actor-badge" aria-hidden="true"><i class="fas ${escapeHtml(icon)}"></i></span></span>`;
  }
  function feedProjectLinkHtml(project = {}, projectId = '', listCard = false, nameOnly = false){
    const title = savedProjectTitle(project) || projectTitle(project);
    const address = nameOnly ? '' : projectAddress(project);
    const label = [title, address && address.toLowerCase() !== title.toLowerCase() ? address : ''].filter(Boolean).join(' · ');
    if (listCard && projectId) {
      const cover = normalizePhotos(project).find((photo) => galleryMediaType(photo) === 'photo');
      const coverUrl = cover ? photoThumb({photo:cover}) : '';
      return `<button type="button" class="pf-project-identity pf-project-card" data-feed-project-id="${escapeHtml(projectId)}" data-fm-summary-type="summary.project" data-fm-summary-project="${escapeHtml(projectId)}" aria-label="Open project: ${escapeHtml(label)}"><span class="pf-project-card-cover" aria-hidden="true"><i class="fas fa-image"></i>${coverUrl ? `<img loading="lazy" src="${escapeHtml(coverUrl)}" alt="">` : ''}</span><span class="pf-project-card-details"><span class="pf-project-card-name">${escapeHtml(title)}</span>${address && address.toLowerCase() !== title.toLowerCase() ? `<span class="pf-project-card-address">${escapeHtml(address)}</span>` : ''}</span></button>`;
    }
    return projectId
      ? `<button type="button" class="pf-project-identity" data-feed-project-id="${escapeHtml(projectId)}" data-fm-summary-type="summary.project" data-fm-summary-project="${escapeHtml(projectId)}" aria-label="Open project: ${escapeHtml(label)}"><span>${escapeHtml(title)}</span>${address && address.toLowerCase() !== title.toLowerCase() ? `<span class="pf-feed-list-separator" aria-hidden="true">·</span><span class="pf-feed-list-address">${escapeHtml(address)}</span>` : ''}</button>`
      : `<span>${escapeHtml(label)}</span>`;
  }
  function feedNoteHtml(note = {}, listNote = false){
    const body = cleanText(note.text);
    if (listNote) return `<div class="pf-note pf-note-list"><span class="pf-note-measure" aria-hidden="true">${escapeHtml(body)}</span><span class="pf-note-plain">${escapeHtml(body)}</span><button type="button" class="pf-note-toggle" data-feed-note-toggle aria-expanded="false" aria-label="Expand note"><span class="pf-note-preview"><span class="pf-note-preview-text">${escapeHtml(body)}</span><span class="pf-note-more">Show more</span></span><span class="pf-note-expanded"><span>${escapeHtml(body)}<span class="pf-note-less">Show less</span></span></span></button></div>`;
    return `<div class="pf-note"><span class="pf-note-measure" aria-hidden="true">${escapeHtml(body)}</span><span class="pf-note-plain">${escapeHtml(body)}</span><button type="button" class="pf-note-toggle" data-feed-note-toggle aria-expanded="false" aria-label="Expand note"><span class="pf-note-preview"><span class="pf-note-preview-text">${escapeHtml(body)}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></span><span class="pf-note-expanded"><span>${escapeHtml(body)}<i class="fas fa-chevron-down" aria-hidden="true"></i></span></span></button></div>`;
  }
  function feedListMediaHtml(photos = [], projectId = ''){
    if (!photos.length) return '';
    const thumbnails = photos.map((entry,index) => `<button type="button" class="pf-thumb" data-photo-feed-id="${escapeHtml(entry.mediaItem.id)}" aria-label="Open ${isVideoMedia(entry.media) ? 'video' : 'photo'} ${index+1} in gallery">${mediaThumbHtml(entry.mediaItem)}</button>`).join('');
    const more = projectId ? `<button type="button" class="pf-feed-list-more" data-feed-more-project-id="${escapeHtml(projectId)}" aria-label="See all ${photos.length} uploads in project Photos" hidden>Show more</button>` : '';
    return `<div class="pf-feed-list-media" aria-label="Uploaded media previews">${thumbnails}${more}</div>`;
  }
  function feedListDocumentHtml(doc = {}, entryId = ''){
    if (!entryId) return '';
    return `<button type="button" class="pf-feed-list-document-thumb" data-feed-document-id="${escapeHtml(entryId)}" aria-label="Open document: ${escapeHtml(doc.title || doc.type_label || 'Document')}">${documentPreviewHtml(doc)}</button>`;
  }
  function feedListTitleHtml(timestamp, action, actor, withTime = true){
    const name=cleanText(actor);
    const actorPrefix=name && (action===name || action.startsWith(`${name} `)) ? name : '';
    const title=actorPrefix ? `<strong>${escapeHtml(actorPrefix)}</strong>${escapeHtml(action.slice(actorPrefix.length))}` : escapeHtml(action);
    return `<div class="pf-feed-list-head"><span class="pf-feed-list-title">${title}</span>${withTime?`<span class="pf-feed-list-when"><time datetime="${escapeHtml(timestamp)}">${escapeHtml(feedDayTime(timestamp))}</time></span>`:''}</div>`;
  }
  function manualPostScope(message = {}){
    const id=cleanText(message.metadata?.feed_department_id);
    return id ? firstText(state.departments.find(department=>department.id===id)?.label,'Department') : 'Company';
  }
  function feedPostTextHtml(value){
    if(window.FirstMateChannels?.composerWidgets?.renderBody)return window.FirstMateChannels.composerWidgets.renderBody({text:String(value)});
    const inline=line=>escapeHtml(line)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_match,label,url)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g,'<s>$1</s>')
      .replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
    return String(value).split('\n').map(line=>{
      if(/^> /.test(line))return `<blockquote>${inline(line.slice(2))}</blockquote>`;
      if(/^(-|\d+\.) /.test(line))return `<div class="pf-post-list-line">${inline(line)}</div>`;
      return inline(line);
    }).join('<br>');
  }
  function manualPostBodyHtml(message = {}){
    const attachments=message.attachments || [],images=attachments.filter(attachment=>cleanText(attachment.content_type).startsWith('image/'));
    const other=attachments.filter(attachment=>!cleanText(attachment.content_type).startsWith('image/'));
    const gif=message.metadata?.giphy;
    return `${message.text?`<div class="pf-manual-text">${feedPostTextHtml(message.text)}</div>`:''}${(message.mention_users || []).length ? `<div class="pf-manual-mentions" aria-label="Tagged people">${message.mention_users.map(person=>`<span>@${escapeHtml(person.name || 'Employee')}</span>`).join('')}</div>` : ''}${gif&&/^https:\/\/media\d*\.giphy\.com\/media\//i.test(gif.url||'')?`<div class="pf-manual-gif"><img loading="lazy" src="${escapeHtml(gif.url)}" alt="${escapeHtml(gif.title || 'GIF')}"></div>`:''}${images.length ? `<div class="pf-manual-images">${images.map((attachment,index)=>`<a ${index>=6?'data-feed-extra-image ':''}href="${escapeHtml(window.ChannelsAPI.mediaFileUrl(orgId(),attachment.media_id))}" data-post-image-index="${index}" aria-label="Open post image ${index+1}"><img loading="lazy" src="${escapeHtml(window.ChannelsAPI.mediaFileUrl(orgId(),attachment.media_id))}" alt="${escapeHtml(attachment.file_name || `Post image ${index+1}`)}"></a>`).join('')}${images.length>6?`<button type="button" data-feed-more-images="${images.length-6}" aria-expanded="false">Show ${images.length-6} more images</button>`:''}</div>` : ''}${other.length?`<div class="pf-manual-files">${other.map(attachment=>cleanText(attachment.content_type).startsWith('audio/')&&message.metadata?.audio_note&&window.FirstMateAudioNotes?.playerHtml?window.FirstMateAudioNotes.playerHtml({url:window.ChannelsAPI.mediaFileUrl(orgId(),attachment.media_id),duration:Number(message.metadata.audio_note.duration_seconds)||0,peaks:message.metadata.audio_note.peaks||[]}):`<a href="${escapeHtml(window.ChannelsAPI.mediaFileUrl(orgId(),attachment.media_id))}" target="_blank" rel="noopener"><i class="fas fa-paperclip"></i> ${escapeHtml(attachment.file_name || 'Open attachment')}</a>`).join('')}</div>`:''}`;
  }
  function feedManualEntryHtml(entry = {}){
    const author=postAuthor(entry),message=entry.manual;
    return `<article class="pf-feed-activity pf-manual-tile">${actorAvatarHtml(author,'fa-pen-to-square')}<div class="pf-feed-activity-copy"><strong>${escapeHtml(author.name)} posted to ${escapeHtml(manualPostScope(message))}</strong>${manualPostBodyHtml(message)}</div><time>${escapeHtml(feedListTime(entry.timestamp))}</time></article>`;
  }
  function feedListEntryHtml(post, showProject = true){
    if(post.kind==='manual'){
      const author=postAuthor(post);
      return `<article class="pf-feed-list-row pf-manual-row">${actorAvatarHtml(author,'fa-pen-to-square')}<div class="pf-feed-list-copy">${feedListTitleHtml(post.timestamp,`${author.name} posted to ${manualPostScope(post.manual)}`,author.name)}${manualPostBodyHtml(post.manual)}</div></article>`;
    }
    const author=postAuthor(post),photos=post.entries.filter((entry)=>entry.kind==='media');
    const action=photos.length
      ? `${author.name} uploaded ${uploadCountLabel(photos)}`
      : post.kind==='note' ? `${author.name} added a note:`
      : post.kind==='activity' ? feedActivitySummary(post.event)
      : post.pairedEvent && !['media.uploaded','document.ingested','receipt.uploaded'].includes(cleanText(post.pairedEvent.type)) ? feedActivitySummary(post.pairedEvent)
      : `${author.name} uploaded ${post.document?.type_label || 'a document'}${post.document?.title ? `: ${post.document.title}` : ''}`;
    const documentEntry=post.entries.find((entry)=>entry.kind==='document');
    const fallback=`${post.kind==='note' ? feedNoteHtml(post.note,true) : ''}${feedListMediaHtml(photos,post.projectId)}${post.kind==='document' ? feedListDocumentHtml(post.document,documentEntry?.id) : ''}`;
    const actionActor=post.kind==='activity' ? feedActor(post.event) : post.pairedEvent && action.startsWith(feedActor(post.pairedEvent)) ? feedActor(post.pairedEvent) : author.name;
    return `<article class="pf-feed-list-row${showProject?' pf-list-time-row':''}${fallback?'':' pf-no-preview'}">${actorAvatarHtml(author,postIcon(post))}<div class="pf-feed-list-copy">${feedListTitleHtml(post.timestamp,action,actionActor,!showProject)}${showProject?`<div class="pf-feed-list-project">${feedProjectLinkHtml(post.project,post.projectId,false,true)}</div>`:''}${fallback?`<div class="pf-feed-list-preview">${fallback}</div>`:''}</div>${showProject?`<time class="pf-feed-list-time" datetime="${escapeHtml(post.timestamp)}">${escapeHtml(feedDayTime(post.timestamp))}</time>`:''}</article>`;
  }
  function feedProjectGroupsHtml(entries){
    const projects=new Map();
    entries.forEach(entry=>{
      const id=cleanText(entry.projectId) || 'unassigned';
      if(!projects.has(id))projects.set(id,[]);
      projects.get(id).push(entry);
    });
    return [...projects.values()].map(group=>{
      const first=group[0];
      return `<section class="pf-project-group"><div class="pf-project-group-events">${group.map(entry=>feedListEntryHtml(entry,false)).join('')}</div><div class="pf-feed-list-project pf-project-group-project">${feedProjectLinkHtml(first.project,first.projectId,true)}</div></section>`;
    }).join('');
  }
  function avatarHtml(author){
    const avatar=cleanText(author.avatar);
    return /^(https?:\/\/|\/)/.test(avatar)?`<img class="pf-post-avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(author.name)}">`:`<span class="pf-post-avatar">${escapeHtml(author.name.slice(0,1).toUpperCase())}</span>`;
  }
  function feedComposerToolsHtml(prefix){
    const voiceIcon=mode=>`<span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat"></span>`;
    return `<button type="button" class="fm-ch-icon-btn pf-compose-tool" data-${prefix}-emoji-open title="Insert emoji" aria-label="Insert emoji"><i class="fas fa-face-smile" aria-hidden="true"></i></button><button type="button" class="fm-ch-icon-btn pf-compose-tool" data-${prefix}-gif title="Send a GIF" aria-label="Send a GIF"><span class="pf-gif-icon">GIF</span></button><label class="fm-ch-icon-btn pf-compose-tool" title="Attach a file" aria-label="Attach a file"><i class="fas fa-paperclip" aria-hidden="true"></i><input type="file" data-${prefix==='comment'?'comment-file':'feed-compose-files'} hidden multiple></label><button type="button" class="fm-ch-icon-btn pf-compose-tool" data-${prefix}-audio title="Record an audio note" aria-label="Record an audio note">${voiceIcon('record')}</button><button type="button" class="fm-ch-icon-btn pf-compose-tool" data-${prefix}-dictate title="Dictate message" aria-label="Dictate message">${voiceIcon('dictation')}</button>`;
  }
  function bindFeedVoiceControls(rootEl,prefix,options){
    const buttons={audio:rootEl.querySelector(`[data-${prefix}-audio]`),dictate:rootEl.querySelector(`[data-${prefix}-dictate]`)};
    if(buttons.audio)buttons.audio.disabled=!!options.hasPendingAudio?.();
    let capturing=false,captureMode='',recorderControl=null;
    const labels={audio:['Record an audio note','Finish recording'],dictate:['Dictate message','Finish dictation']};
    const update=(mode,control)=>{
      recorderControl=control;
      const button=buttons[mode];
      button?.classList.toggle('voice-active',!!control);
      button?.setAttribute('aria-pressed',String(!!control));
      if(button){button.disabled=!control;button.title=labels[mode][control?1:0];button.setAttribute('aria-label',button.title);}
    };
    for(const mode of ['dictate','audio'])buttons[mode]?.addEventListener('click',async()=>{
      if(capturing){if(captureMode===mode)recorderControl?.stop();return;}
      if(mode==='audio' && options.hasPendingAudio?.())return;
      capturing=true;captureMode=mode;
      buttons.audio.disabled=buttons.dictate.disabled=true;
      try{
        if(!window.FirstMateAudioNotes?.prepareInline)throw new Error('Audio tools are unavailable.');
        await options.beforeStart?.();
        const mount=rootEl.querySelector(mode==='dictate'?`[data-${prefix}-dictation-mount]`:`[data-${prefix}-audio-mount]`);
        const prepared=await window.FirstMateAudioNotes.prepareInline(orgId(),null,{mount,mode:mode==='dictate'?'dictation':'record',upload:options.upload,onRemove:options.onRemove,onRecordingState:control=>update(mode,control)});
        if(mount?.isConnected)options.onPrepared(mode,prepared);
      }catch(error){if(!String(error?.message || '').toLowerCase().includes('cancelled'))options.onError(error);}
      finally{
        capturing=false;recorderControl=null;
        for(const kind of ['audio','dictate']){const button=buttons[kind];button.classList.remove('voice-active');button.setAttribute('aria-pressed','false');button.title=labels[kind][0];button.setAttribute('aria-label',button.title);button.disabled=kind==='audio' && !!options.hasPendingAudio?.();}
      }
    });
  }
  function clearComposerAudio(){
    if(state.composerAudioAttachment?.url?.startsWith('blob:'))URL.revokeObjectURL(state.composerAudioAttachment.url);
    state.composerAudioFile=null;state.composerAudioNote=null;state.composerAudioAttachment=null;
  }
  function mountFeedPreparedAudio(mount,attachment,metadata,onRemove){
    if(!mount || !attachment || !metadata)return;
    window.FirstMateAudioNotes?.mountPrepared?.(mount,{
      url:attachment.url || attachment.public_url || window.ChannelsAPI?.mediaFileUrl?.(orgId(),attachment.media_id),
      duration:metadata.duration_seconds,peaks:metadata.peaks,onRemove
    });
  }
  let feedEmojiClose=null;
  function openFeedEmojiWidget(anchor,onPick){
    feedEmojiClose?.();
    const popover=document.createElement('div');popover.className='pf-emoji-widget';document.body.append(popover);
    const rect=anchor.getBoundingClientRect();
    const picker=window.FirstMateChannels.mountEmojiPicker(popover,emoji=>{close();onPick(emoji);});
    const bounds=popover.getBoundingClientRect();
    popover.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-bounds.width-8))}px`;
    popover.style.top=`${rect.bottom+bounds.height+8>innerHeight?Math.max(8,rect.top-bounds.height-6):rect.bottom+6}px`;
    feedEmojiClose=close;
    function close(){if(feedEmojiClose===close)feedEmojiClose=null;document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',onKeydown);picker.destroy();popover.remove();}
    function outside(event){if(!popover.contains(event.target)&&event.target!==anchor)close();}
    function onKeydown(event){if(event.key==='Escape')close();}
    setTimeout(()=>document.addEventListener('pointerdown',outside,true),0);
    document.addEventListener('keydown',onKeydown);
    picker.focus();
  }
  function feedPostHtml(post){
    if (post.kind === 'note') {
      const author=postAuthor(post);
      return `<article class="pf-post pf-note-post"><header class="pf-post-head">${actorAvatarHtml(author,'fa-note-sticky')}<div><strong>${escapeHtml(author.name)} added a note:</strong><span><time>${escapeHtml(feedListTime(post.timestamp))}</time></span><div class="pf-feed-list-project">${feedProjectLinkHtml(post.project,post.projectId,false,true)}</div></div></header><div class="pf-post-note-body">${feedNoteHtml(post.note)}</div></article>`;
    }
    const current=postState(post.id),author=postAuthor(post),photos=post.entries.filter(e=>e.kind==='media'),doc=post.document;
    const amount=doc ? firstText(doc.total_formatted,doc.amount_formatted,doc.contract_value,doc.total,doc.amount) : firstText(activityPayload(post.event || {}).amount_formatted,activityPayload(post.event || {}).amount);
    const amountCents=Number(doc?.total_cents ?? doc?.amount_cents ?? activityPayload(post.event || {}).amount_cents);
    const money=Number.isFinite(amountCents)?new Intl.NumberFormat(undefined,{style:'currency',currency:doc?.currency || activityPayload(post.event || {}).currency || 'USD'}).format(amountCents/100):amount;
    const body=post.kind==='manual' ? manualPostBodyHtml(post.manual) : photos.length ? `<p class="pf-post-caption">Uploaded ${uploadCountLabel(photos)}</p><div class="pf-post-collage count-${Math.min(photos.length,4)}">${photos.slice(0,4).map((entry,i)=>`<button type="button" class="pf-thumb" data-photo-feed-id="${escapeHtml(entry.mediaItem.id)}" aria-label="Open ${isVideoMedia(entry.media)?'video':'photo'} ${i+1}">${mediaThumbHtml(entry.mediaItem)}${i===3&&photos.length>4?`<span class="pf-post-overflow">+${photos.length-4}</span>`:''}</button>`).join('')}</div>` : post.kind==='document' ? `<div class="pf-post-document"><span class="pf-post-document-icon"><i class="fas ${escapeHtml(doc.icon || 'fa-file-contract')}"></i></span><div><small>${escapeHtml(doc.type_label || 'Document')}</small><strong>${escapeHtml(doc.title || 'Document')}</strong>${money?`<b class="pf-post-value">${escapeHtml(money)}</b>`:''}<button type="button" class="pf-action" data-feed-document-id="${escapeHtml(doc.id)}">Open document</button></div></div>` : `<div class="pf-post-event"><i class="fas ${escapeHtml(feedActivityIcon(post.event))}"></i><p>${escapeHtml(feedActivitySummary(post.event))}</p>${money?`<b class="pf-post-value">${escapeHtml(money)}</b>`:''}</div>`;
    const reactions=current.root?.reactions || [],liked=reactions.find(r=>r.emoji==='👍');
    const location=post.kind==='manual' ? `<span class="pf-post-scope"><i class="fas ${post.manual?.metadata?.feed_department_id?'fa-people-group':'fa-building'}"></i>${escapeHtml(manualPostScope(post.manual))}</span>` : feedProjectLinkHtml(post.project,post.projectId,false,true);
    return `<article class="pf-post" data-feed-post="${escapeHtml(post.id)}">
      <header class="pf-post-head">${actorAvatarHtml(author,postIcon(post))}<div><strong>${escapeHtml(author.name)}</strong><span><time>${escapeHtml(activityTime(post.timestamp))}</time> · ${location}</span></div></header>
      ${body}
      <div class="pf-post-stats"><span>${reactions.length ? reactions.map(r=>`<span class="pf-reaction-count" title="${escapeHtml((r.users || []).map(user=>user.name).join(', ') || 'Someone')} reacted with ${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} ${r.count}</span>`).join('') : 'Be the first to react'}</span><button type="button" data-post-comments aria-expanded="${current.open}">${current.root?.reply_count || 0} ${current.root?.reply_count===1?'comment':'comments'}</button></div>
      <div class="pf-post-actions">${state.canReact?`<button type="button" data-post-like aria-pressed="${liked?.reacted || false}" ${current.busy?'disabled':''}><i class="${liked?.reacted?'fas':'far'} fa-thumbs-up"></i> Like</button><div class="pf-post-react"><button type="button" aria-label="More reactions"><i class="far fa-face-smile"></i><span>React</span></button><div>${['❤️','😂','🎉','😮','😢'].map(emoji=>`<button type="button" data-post-emoji="${emoji}" aria-label="React ${emoji}">${emoji}</button>`).join('')}</div></div>`:''}<button type="button" data-post-comments aria-expanded="${current.open}"><i class="far fa-comment"></i> Comments</button></div>
      ${current.open?`<section class="pf-comments" aria-label="Comments"><div class="pf-comments-title"><strong>Comments</strong><span>${current.root?.reply_count || 0}</span></div><div data-comment-list></div>${state.canComment?`<form data-comment-form><div class="pf-comment-compose">${avatarHtml({name:firstText(state.users.find(user=>user.id===APP.userId)?.name,'You'),avatar:state.users.find(user=>user.id===APP.userId)?.profile_photo_url})}<div class="pf-comment-compose-body">${current.replyToName?`<div class="pf-comment-reply-target">Replying to ${escapeHtml(current.replyToName)} <button type="button" data-comment-cancel-reply aria-label="Cancel reply">×</button></div>`:''}<div class="pf-comment-input"><label class="pf-comment-label"><span class="sr-only">Write a comment</span><textarea rows="3" maxlength="250000" placeholder="Write a comment…">${escapeHtml(current.draft)}</textarea></label><div class="pf-comment-tools">${feedComposerToolsHtml('comment')}<span data-comment-attachments></span><button class="pf-comment-send" type="submit" aria-label="Post comment" title="Post comment" ${current.busy?'disabled':''}><i class="fas fa-paper-plane" aria-hidden="true"></i></button></div></div><div class="pf-emoji-picker" data-comment-emoji-picker hidden></div><div data-comment-dictation-mount></div><div data-comment-audio-mount></div></div></div></form>`:''}</section>`:''}</article>`;
  }
  async function fetchPost(post,create=false){
    const current=postState(post.id);
    const result=post.kind === 'manual' ? await window.ChannelsAPI.feed.thread(orgId(),post.manual.id) : create ? await window.ChannelsAPI.feed.resolve(orgId(),post.entries.slice(0,200).map(entryRef)) : current.root ? await window.ChannelsAPI.feed.thread(orgId(),current.root.id) : await window.ChannelsAPI.feed.lookup(orgId(),post.entries.slice(0,200).map(entryRef));
    current.root=result.root;current.replies=result.replies || [];current.loaded=true;
    return current;
  }
  function renderFeedCommentContent(message,container){
    if(message.deleted_at){container.textContent='Comment removed';return;}
    if(message.text){const body=document.createElement('div');body.style.whiteSpace='pre-wrap';body.textContent=message.text;container.append(body);}
    const gif=message.metadata?.giphy;
    if(gif && /^https:\/\/media\d*\.giphy\.com\/media\//i.test(gif.url || '')){const link=document.createElement('a');link.href=`https://giphy.com/gifs/${encodeURIComponent(gif.id)}`;link.target='_blank';link.rel='noopener noreferrer';const image=document.createElement('img');image.src=gif.url;image.alt=gif.title || 'GIF';image.loading='lazy';image.style.cssText='display:block;max-width:min(100%,320px);max-height:240px;margin-top:7px;border-radius:8px';link.append(image);container.append(link);}
    for(const attachment of message.attachments || []){
      const url=window.ChannelsAPI.mediaFileUrl(orgId(),attachment.media_id),type=cleanText(attachment.content_type);
      if(type.startsWith('audio/') && message.metadata?.audio_note && window.FirstMateAudioNotes?.createPlayer){container.append(window.FirstMateAudioNotes.createPlayer({url,duration:Number(message.metadata.audio_note.duration_seconds)||0,peaks:message.metadata.audio_note.peaks || []}));continue;}
      if(type.startsWith('image/')){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';const img=document.createElement('img');img.src=url;img.alt=attachment.file_name || 'Comment image';img.loading='lazy';img.style.cssText='display:block;max-width:min(100%,320px);max-height:240px;margin-top:7px;border-radius:8px';link.append(img);container.append(link);continue;}
      const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=attachment.file_name || 'Open attachment';container.append(link);
    }
  }
  function openPostImageViewer(images,index=0){
    if(!images.length)return;
    const previousFocus=document.activeElement;
    const overlay=document.createElement('div');overlay.className='pf-image-lightbox pf-post-image-viewer';
    overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Post image preview');
    overlay.innerHTML='<div class="pf-image-lightbox-panel"><header><strong data-image-title></strong><button type="button" data-image-close aria-label="Close image preview">×</button></header><div class="pf-post-image-stage"><button type="button" data-image-previous aria-label="Previous image">‹</button><img alt=""><button type="button" data-image-next aria-label="Next image">›</button></div></div>';
    document.body.append(overlay);
    const image=overlay.querySelector('img'),title=overlay.querySelector('[data-image-title]');
    const paint=()=>{const selected=images[index];image.src=selected.url;image.alt=selected.alt||`Post image ${index+1}`;title.textContent=`${image.alt} · ${index+1} of ${images.length}`;overlay.querySelector('[data-image-previous]').hidden=images.length<2;overlay.querySelector('[data-image-next]').hidden=images.length<2;};
    const close=()=>{document.removeEventListener('keydown',onKeydown);overlay.remove();previousFocus?.focus?.();};
    const move=step=>{index=(index+step+images.length)%images.length;paint();};
    const onKeydown=event=>{if(event.key==='Escape'){event.preventDefault();close();}else if(event.key==='ArrowLeft'){event.preventDefault();move(-1);}else if(event.key==='ArrowRight'){event.preventDefault();move(1);}};
    overlay.querySelector('[data-image-close]').onclick=close;
    overlay.querySelector('[data-image-previous]').onclick=()=>move(-1);
    overlay.querySelector('[data-image-next]').onclick=()=>move(1);
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    document.addEventListener('keydown',onKeydown);paint();overlay.querySelector('[data-image-close]').focus();
  }
  function bindFeedPosts(root,onlyCard=null){
    if(state.density!=='posts')return;
    const posts=new Map(groupedPosts(feedEntries()).map(p=>[p.id,p]));
    (onlyCard?[onlyCard]:root.querySelectorAll('[data-feed-post]')).forEach(card=>{
      const post=posts.get(card.dataset.feedPost);if(!post)return;
      if(post.kind==='note')return;
      const postImages=[...card.querySelectorAll('.pf-manual-images [data-post-image-index]')];
      postImages.forEach(anchor=>anchor.addEventListener('click',event=>{event.preventDefault();openPostImageViewer(postImages.map(item=>({url:item.href,alt:item.querySelector('img')?.alt})),Number(anchor.dataset.postImageIndex));}));
      card.querySelector('[data-feed-more-images]')?.addEventListener('click',event=>{
        const button=event.currentTarget,grid=button.closest('.pf-manual-images');
        const expanded=grid.classList.toggle('expanded');
        button.setAttribute('aria-expanded',String(expanded));
        button.textContent=expanded?'Show fewer images':`Show ${button.dataset.feedMoreImages} more images`;
      });
      const current=postState(post.id);
      current.mentionApi?.destroy?.();current.mentionApi=null;
      const error=e=>showToast?.('Feed',e?.message || 'Unable to update this post.',false);
      const rerender=()=>{if(!state.root?.contains(card))return;const replacement=document.createElement('div');replacement.innerHTML=feedPostHtml(post);const next=replacement.firstElementChild;card.replaceWith(next);bindFeedPosts(state.root,next);if(current.editingId)next.querySelector('.pf-comment-edit textarea')?.focus();else if(current.replyTo)next.querySelector('[data-comment-form] textarea')?.focus();};
      const act=async callback=>{if(current.busy)return;current.busy=true;try{await callback();}catch(e){error(e);}finally{current.busy=false;rerender();}};
      if(!current.loaded && !current.checking){
        current.checking=true;
        fetchPost(post).then(()=>{
          const stats=card.querySelector('.pf-post-stats');
          const fresh=document.createElement('div');fresh.innerHTML=feedPostHtml(post);
          const updated=fresh.querySelector('.pf-post-stats');
          if(stats&&updated)stats.replaceWith(updated);
        }).catch(error).finally(()=>{current.checking=false;});
      }
      card.querySelectorAll('[data-post-comments]').forEach(btn=>btn.addEventListener('click',()=>act(async()=>{current.open=!current.open;if(current.open)await fetchPost(post);})));
      const react=(emoji)=>act(async()=>{await fetchPost(post,true);const reaction=current.root.reactions?.find(r=>r.emoji===emoji);await window.ChannelsAPI.feed.react(orgId(),current.root.id,emoji,!reaction?.reacted);await fetchPost(post);});
      card.querySelector('[data-post-like]')?.addEventListener('click',()=>react('👍'));
      card.querySelector('.pf-post-react>button')?.addEventListener('click',event=>{event.currentTarget.parentElement.classList.toggle('open');});
      card.querySelectorAll('[data-post-emoji]').forEach(btn=>btn.addEventListener('click',()=>react(btn.dataset.postEmoji)));
      const comments=card.querySelector('[data-comment-list]');
      const commentThreads=new Map();
      for(const message of current.replies){
        const row=document.createElement('article');row.className=`pf-comment${message.metadata?.feed_reply_to?' pf-comment-reply':''}`;
        row.innerHTML=`${avatarHtml(message.author || {name:'Someone'})}<div class="pf-comment-body"><div class="pf-comment-head"><strong>${escapeHtml(message.author?.name || 'Someone')}</strong>${message.edited_at?'<em>(edited)</em>':''}<time>${escapeHtml(activityTime(message.created_at))}</time></div><div data-comment-content></div><div class="pf-comment-actions"></div></div>`;
        const content=row.querySelector('[data-comment-content]');
        if(current.editingId===message.id){
          const edit=document.createElement('form');edit.className='pf-comment-edit';edit.innerHTML=`<textarea aria-label="Edit comment" maxlength="250000">${escapeHtml(current.editDraft ?? message.text)}</textarea><div><button type="submit">Save edit</button><button type="button">Cancel</button></div>`;
          edit.querySelector('textarea').addEventListener('input',event=>{current.editDraft=event.target.value;});
          edit.addEventListener('submit',event=>{event.preventDefault();const text=cleanText(current.editDraft).trim();if(text)act(async()=>{await window.ChannelsAPI.feed.edit(orgId(),message.id,text);current.editingId='';current.editDraft='';await fetchPost(post);});});
          edit.querySelector('button[type="button"]').onclick=()=>{current.editingId='';current.editDraft='';rerender();};content.append(edit);
        }else renderFeedCommentContent(message,content);
        const actions=row.querySelector('.pf-comment-actions');
        const button=(label,action)=>{const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.onclick=()=>act(action);actions.append(btn);};
        if(state.canReact&&!message.deleted_at){
          const reactComment=async emoji=>{const reaction=message.reactions?.find(item=>item.emoji===emoji);await window.ChannelsAPI.feed.react(orgId(),message.id,emoji,!reaction?.reacted);await fetchPost(post);};
          const reactions=(message.reactions || []).filter(reaction=>Number(reaction.count)>0);
          if(reactions.length){
            const summary=document.createElement('div');summary.className='pf-comment-reactions';summary.setAttribute('aria-label','Comment reactions');
            for(const reaction of reactions){
              const count=Number(reaction.count),names=(reaction.users || []).map(user=>user.name).filter(Boolean);
              const chip=document.createElement('button');chip.type='button';chip.textContent=`${reaction.emoji} ${count}`;
              chip.title=`${count} ${count===1?'person':'people'} reacted with ${reaction.emoji}${names.length?`: ${names.join(', ')}`:''}`;
              chip.setAttribute('aria-label',chip.title);chip.setAttribute('aria-pressed',String(!!reaction.reacted));
              chip.onclick=()=>act(()=>reactComment(reaction.emoji));summary.append(chip);
            }
            content.after(summary);
          }
          const picker=document.createElement('div');picker.className='pf-comment-react';
          const trigger=document.createElement('button');trigger.type='button';trigger.textContent='React';trigger.setAttribute('aria-label','React to comment');trigger.onclick=()=>picker.classList.toggle('open');
          const choices=document.createElement('div');choices.setAttribute('aria-label','Comment reaction options');
          for(const emoji of ['👍','❤️','😂','🎉','😮','😢']){const choice=document.createElement('button');choice.type='button';choice.textContent=emoji;choice.setAttribute('aria-label',`React ${emoji}`);choice.onclick=()=>act(()=>reactComment(emoji));choices.append(choice);}
          picker.onmouseleave=()=>picker.classList.remove('open');picker.append(trigger,choices);actions.append(picker);
        }
        if(state.canComment&&!message.deleted_at)button('Reply',async()=>{current.replyTo=message.id;current.replyToName=message.author?.name || 'Someone';});
        if(message.can_restore && state.canComment)button('Restore',async()=>{await window.ChannelsAPI.feed.restore(orgId(),message.id);await fetchPost(post);});
        if(message.can_edit && state.canComment && current.editingId!==message.id)button('Edit',async()=>{current.editingId=message.id;current.editDraft=message.text;});
        if(message.can_delete && state.canComment)button('Delete',async()=>{await window.ChannelsAPI.feed.remove(orgId(),message.id);await fetchPost(post);});
        const thread=document.createElement('div');thread.className='pf-comment-thread';thread.append(row);
        commentThreads.set(message.id,{thread,message,children:[]});
      }
      for(const item of commentThreads.values()){
        const parent=commentThreads.get(item.message.metadata?.feed_reply_to?.id);
        if(parent && parent!==item)parent.children.push(item);
        else comments?.append(item.thread);
      }
      const descendantCount=(item,seen=new Set())=>{
        if(seen.has(item))return 0;
        seen.add(item);
        return item.children.reduce((count,child)=>count+1+descendantCount(child,seen),0);
      };
      for(const [id,item] of commentThreads){
        if(!item.children.length)continue;
        const collapsed=current.collapsedReplies?.has(id)===true;
        const count=descendantCount(item);
        const toggle=document.createElement('button');toggle.type='button';toggle.className='pf-comment-replies-toggle';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.textContent=`${collapsed?'Show':'Hide'} ${count} ${count===1?'reply':'replies'}`;
        toggle.onclick=()=>{current.collapsedReplies ||= new Set();if(collapsed)current.collapsedReplies.delete(id);else current.collapsedReplies.add(id);rerender();};
        const children=document.createElement('div');children.className='pf-comment-children';children.hidden=collapsed;children.append(...item.children.map(child=>child.thread));
        item.thread.append(toggle,children);
      }
      if(comments&&!current.replies.length&&current.checking)comments.textContent='Loading comments…';
      const form=card.querySelector('[data-comment-form]'),input=form?.querySelector('textarea');
      if(input && window.FirstMateTags?.attachMentionTextarea){
        const department=post.manual?.metadata?.feed_department_id || '';
        const memberIds=()=>state.users.filter(user=>Object.prototype.hasOwnProperty.call(state.userDepartments,user.id) && (!department || (state.userDepartments[user.id] || []).includes(department))).map(user=>user.id);
        current.mentionApi=window.FirstMateTags.attachMentionTextarea(input,{orgId:orgId(),source:'feed',memberIds});
        input._mentionApi=current.mentionApi;
        const mentionButton=window.FirstMateChannels?.composerWidgets?.mentionButton?.(input,form,{mount:form.querySelector('.pf-comment-tools'),onSelect:()=>{current.draft=input.value;},onError:error});
        if(mentionButton){mentionButton.classList.add('fm-ch-icon-btn','pf-compose-tool');form.querySelector('.pf-comment-send')?.before(mentionButton);}
      }
      input?.addEventListener('input',()=>{current.draft=input.value;});
      card.querySelector('[data-comment-cancel-reply]')?.addEventListener('click',()=>{current.replyTo='';current.replyToName='';rerender();});
      card.querySelector('[data-comment-emoji-open]')?.addEventListener('click',event=>openFeedEmojiWidget(event.currentTarget,emoji=>{const start=input.selectionStart,end=input.selectionEnd;input.setRangeText(emoji,start,end,'end');current.draft=input.value;input.focus();}));
      const send=async(metadata={},text=current.draft,clientId)=>{const mentions=current.mentionApi?.selectedMentions?.() || [];await fetchPost(post,true);await window.ChannelsAPI.feed.comment(orgId(),current.root.id,{text,mention_users:mentions,parent_id:current.replyTo || undefined,client_msg_id:clientId || current.operationId || (current.operationId=globalThis.crypto?.randomUUID?.() || `feed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`),attachment_ids:(current.attachments || []).map(a=>a.id),metadata:{...(current.audioNote?{audio_note:current.audioNote}:{}),...metadata}});current.draft='';current.attachments=[];current.audioNote=null;current.operationId='';current.replyTo='';current.replyToName='';await fetchPost(post);};
      form?.addEventListener('submit',event=>{event.preventDefault();if(current.draft.trim() || current.attachments?.length)act(()=>send());});
      card.querySelector('[data-comment-gif]')?.addEventListener('click',()=>window.FirstMateChannels?.createGifPickerButton({orgId:orgId(),dialogTitle:'Choose a GIF',onSend:async selected=>{
        if(current.busy)throw new Error('Please wait for the current comment to finish.');
        current.busy=true;
        try{await send({giphy:selected},current.draft);}
        finally{current.busy=false;rerender();}
      },onError:error}).click());
      const removeCommentAudio=()=>{if(current.audioNote){current.attachments=(current.attachments || []).filter(attachment=>attachment.id!==current.audioAttachmentId);current.audioNote=null;current.audioAttachmentId='';}const button=card.querySelector('[data-comment-audio]');if(button)button.disabled=false;};
      mountFeedPreparedAudio(card.querySelector('[data-comment-audio-mount]'),current.attachments?.find(attachment=>attachment.id===current.audioAttachmentId),current.audioNote,removeCommentAudio);
      bindFeedVoiceControls(card,'comment',{
        beforeStart:()=>fetchPost(post,true),
        upload:file=>window.ChannelsAPI.feed.upload(orgId(),current.root.id,file).then(result=>result.attachment),
        onRemove:removeCommentAudio,
        hasPendingAudio:()=>!!current.audioNote,
        onPrepared:(mode,prepared)=>{
          if(mode==='dictate'){current.draft=[current.draft,prepared.text].filter(Boolean).join(' ');input.value=current.draft;input.focus();}
          else{current.attachments ||= [];current.attachments.push(prepared.attachment);current.audioAttachmentId=prepared.attachment.id;current.audioNote=prepared.metadata;}
        },
        onError:error
      });
      const attachments=card.querySelector('[data-comment-attachments]');
      if(attachments)attachments.textContent=(current.attachments || []).filter(a=>a.id!==current.audioAttachmentId).map(a=>a.file_name).join(', ');
      card.querySelector('[data-comment-file]')?.addEventListener('change',event=>act(async()=>{
        await fetchPost(post,true);
        for(const file of event.target.files || []){const result=await window.ChannelsAPI.feed.upload(orgId(),current.root.id,file);(current.attachments ||= []).push(result.attachment);}
      }));
    });
  }
  function dynamicHtml(options = {}){
    const entries = ['posts','list'].includes(state.density) ? groupedPosts(feedEntries()) : feedEntries();
    const visibleEntries = entries.slice(0, state.visible);
    const dayGroups = groupedFeedEntries(visibleEntries);
    const selectedCount = state.selected.size;
    const selectionActions = state.trashMode
      ? `<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_d55efd8791e299"," Restore") ?? " Restore")}</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_4e4c97a39c03c8"," Delete Forever") ?? " Delete Forever")}</button>`
      : `<button type="button" class="pf-action danger" data-selection-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_90e27d705bee80"," Delete") ?? " Delete")}</button><div class="pf-download-wrap">
          <button type="button" class="pf-action primary" data-selection-download><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_f3ad10eaad3ccf"," Download") ?? " Download")}</button>
          <div class="pf-download-menu${String(state.downloadMenuOpen ? ' visible' : '')}" data-selection-download-menu>
            <button type="button" data-download-selected-plain>${(globalThis.PlatformLanguage?.htmlText("photos","m_c94e82190b64cc","Without markup") ?? "Without markup")}</button>
            <button type="button" data-download-selected-markup>${(globalThis.PlatformLanguage?.htmlText("photos","m_42e3382f311f77","With markup") ?? "With markup")}</button>
          </div>
        </div>`;
    return `
      ${state.selectionMode ? `<div class="pf-selectionbar">
        <strong>${((v0) => globalThis.PlatformLanguage?.htmlText("photos","m_4b740d0b3ec319",`${v0} selected`,{v0}) ?? `${v0} selected`)(selectedCount)}</strong>
        <div class="pf-selection-actions">
          <button type="button" class="pf-action" data-selection-clear>${(globalThis.PlatformLanguage?.htmlText("photos","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
          ${String(selectionActions)}
        </div>
      </div>` : ''}
      <div class="pf-scroll" data-feed-scroll>
        ${state.loading && !state.loaded ? `<div class="pf-loading">${(globalThis.PlatformLanguage?.htmlText("photos","m_d9f4b62b1c74a0","Loading your feed...") ?? "Loading your feed...")}</div>` : ''}
        ${state.documentsLoading ? `<div class="pf-feed-notice"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_c134b013b4dd64"," Adding project documents…") ?? " Adding project documents…")}</div>` : ''}
        ${!state.loading && state.loaded && !entries.length ? `<div class="pf-empty"><i class="fas fa-filter-circle-xmark"></i><strong>${(globalThis.PlatformLanguage?.htmlText("photos","m_1a6a017a3c3609","Nothing matches what is shown") ?? "Nothing matches what is shown")}</strong><div>${(globalThis.PlatformLanguage?.htmlText("photos","m_e66cd5073679a3","Adjust the Shown menu or search to bring more items into your feed.") ?? "Adjust the Shown menu or search to bring more items into your feed.")}</div></div>` : ''}
        ${dayGroups.map(([key, list]) => `<div class="pf-day"><h2 class="pf-day-title">${escapeHtml(dateLabel(key))}</h2><div class="pf-feed-grid">${state.density==='list' && state.listOrganize==='project' ? feedProjectGroupsHtml(list) : list.map((entry) => state.density === 'posts' ? feedPostHtml(entry) : state.density === 'list' ? feedListEntryHtml(entry) : entry.kind === 'manual' ? feedManualEntryHtml(entry) : entry.kind === 'media' ? feedMediaEntryHtml(entry) : entry.kind === 'document' ? feedDocumentEntryHtml(entry) : entry.kind === 'note' ? feedNoteEntryHtml(entry) : feedActivityEntryHtml(entry)).join('')}</div></div>`).join('')}
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
          <span><i class="fas ${String(icon)}"></i><strong>${String(escapeHtml(title))}</strong><em>${((v2,v3) => globalThis.PlatformLanguage?.htmlText("photos","m_f624acebda7242",`${v2} of ${v3}`,{v2,v3}) ?? `${v2} of ${v3}`)(count,items.length)}</em></span>
          <button type="button" data-feed-filter-group="${String(escapeHtml(group))}" data-filter-group-action="${String(allSelected ? 'none' : 'all')}">${String(allSelected ? 'Hide all' : 'Show all')}</button>
        </div>
        <div class="pf-shown-options">
          ${String(items.map((item) => `<button type="button" class="${selected.has(item.id) ? 'active' : ''}" data-feed-filter-group="${escapeHtml(group)}" data-feed-filter-id="${escapeHtml(item.id)}" aria-pressed="${selected.has(item.id) ? 'true' : 'false'}"><span class="pf-shown-check"><i class="fas fa-check"></i></span><i class="fas ${escapeHtml(item.icon)}"></i><span>${escapeHtml(item.label)}</span></button>`).join(''))}
        </div>
      </section>`;
  }
  function shownMenuHtml(){
    if (!state.shownMenuOpen) return '';
    return `
      <div class="pf-shown-menu" data-feed-shown-menu>
        <div class="pf-shown-head"><div><strong>Filters</strong></div><button type="button" data-feed-shown-close aria-label="Close"><i class="fas fa-xmark"></i></button></div>
        <div class="pf-shown-options pf-activity-options">${ACTIVITY_FILTERS.map(item=>`<button type="button" class="${state.visibleActivity.has(item.id)?'active':''}" data-feed-filter-group="activity" data-feed-filter-id="${escapeHtml(item.id)}" aria-pressed="${state.visibleActivity.has(item.id)}"><span class="pf-shown-check"><i class="fas fa-check"></i></span><i class="fas ${escapeHtml(item.icon)}"></i><span>${escapeHtml(item.label)}</span></button>`).join('')}</div>
      </div>`;
  }
  function feedScopeControlHtml(){
    const selected=state.feedScope==='mine'?'My departments':state.departments.find(department=>department.id===state.feedScope)?.label || 'All company activity';
    const option=(value,label)=>`<button type="button" role="option" aria-selected="${state.feedScope===value}" data-feed-scope-option="${escapeHtml(value)}">${escapeHtml(label)}${state.feedScope===value?'<i class="fas fa-check" aria-hidden="true"></i>':''}</button>`;
    return `<div class="pf-feed-scope-control"><button type="button" class="pf-feed-scope-trigger" data-feed-scope aria-label="Show ${escapeHtml(selected)}" aria-expanded="${state.scopeMenuOpen}"><span>Show</span><strong>${escapeHtml(selected)}</strong><i class="fas fa-chevron-${state.scopeMenuOpen?'up':'down'}" aria-hidden="true"></i></button>${state.scopeMenuOpen?`<div class="pf-feed-scope-menu" role="listbox" aria-label="Feed audience">${option('all','All company activity')}${option('mine','My departments')}<div class="pf-feed-scope-section">Departments</div><label class="pf-feed-scope-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-feed-scope-search placeholder="Find a department" aria-label="Find a department"></label><div class="pf-feed-scope-departments">${state.departments.map(department=>option(department.id,department.label)).join('')}</div></div>`:''}</div>`;
  }
  function feedPostFormatBarHtml(){
    return '<div data-feed-format-mount></div>';
  }
  function feedComposerHtml(){
    if(!state.composerOpen)return '';
    const previews=state.composerFiles.map((file,index)=>file.type.startsWith('image/')
      ? `<div class="pf-image-preview"><button type="button" data-feed-compose-preview="${index}" aria-label="Preview ${escapeHtml(file.name)}"><img src="${escapeHtml(state.composerPreviewUrls.get(file) || '')}" alt="${escapeHtml(file.name)}"></button><button type="button" data-feed-compose-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></div>`
      : `<div class="pf-file-preview"><i class="fas fa-paperclip"></i><span>${escapeHtml(file.name)}</span><button type="button" data-feed-compose-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></div>`).join('');
    const enlarged=state.composerFiles[state.composerPreviewIndex];
    return `<div class="pf-overlay"><form class="pf-dialog" data-feed-compose role="dialog" aria-modal="true" aria-label="Create a post">
      <header><strong>Create a post</strong><button type="button" data-feed-compose-close aria-label="Close">×</button></header>
      <div class="pf-compose-author">${avatarHtml({name:firstText(state.users.find(user=>user.id===APP.userId)?.name,'You'),avatar:state.users.find(user=>user.id===APP.userId)?.profile_photo_url})}<div class="pf-compose-author-copy"><strong>${escapeHtml(firstText(state.users.find(user=>user.id===APP.userId)?.name,'You'))}</strong><label class="pf-compose-audience">Post to <span class="pf-compose-audience-picker"><span>${escapeHtml(state.composerDepartment ? `${state.departments.find(department=>department.id===state.composerDepartment)?.label || 'Department'} department` : 'everyone in the company')}</span><i class="fas fa-chevron-down" aria-hidden="true"></i><select data-feed-compose-scope aria-label="Post audience"><option value="" ${!state.composerDepartment?'selected':''}>everyone in the company</option>${state.departments.map(department=>`<option value="${escapeHtml(department.id)}" ${state.composerDepartment===department.id?'selected':''}>${escapeHtml(department.label)} department</option>`).join('')}</select></span></label></div></div>
      <div class="pf-compose-message">${feedPostFormatBarHtml()}<div data-feed-compose-editor-mount></div><div class="pf-post-compose-bottom"><div class="pf-post-compose-tools">${feedComposerToolsHtml('feed-compose')}</div><button type="submit" class="pf-action primary" ${state.composerBusy?'disabled':''}>${state.composerBusy?'Posting…':'Post'}</button></div><div class="pf-mention-menu" data-feed-compose-mention-menu hidden></div></div><div data-feed-compose-dictation-mount></div><div data-feed-compose-audio-mount></div>
      ${state.composerGif?`<div class="pf-composer-gif"><img src="${escapeHtml(state.composerGif.url)}" alt="${escapeHtml(state.composerGif.title)}"><button type="button" data-feed-compose-remove-gif aria-label="Remove GIF">×</button></div>`:''}
      ${previews?`<div class="pf-dialog-files">${previews}</div>`:''}
    </form>${enlarged?.type.startsWith('image/')?`<div class="pf-image-lightbox" data-feed-image-lightbox role="dialog" aria-modal="true" aria-label="Image preview"><div class="pf-image-lightbox-panel"><header><strong>${escapeHtml(enlarged.name)}</strong><button type="button" data-feed-preview-close aria-label="Close image preview">×</button></header><img src="${escapeHtml(state.composerPreviewUrls.get(enlarged) || '')}" alt="${escapeHtml(enlarged.name)}"></div></div>`:''}</div>`;
  }
  function render(){
    if (!state.root) return;
    state.composerMentionApi?.destroy?.();
    state.composerMentionApi=null;
    for(const current of state.posts.values()){current.mentionApi?.destroy?.();current.mentionApi=null;}
    const visibleCount = ['posts','list'].includes(state.density) ? groupedPosts(feedEntries()).length : feedEntries().length;
    state.root.innerHTML = `
      <div class="pf-wrap${String(state.selectionMode ? ' selection-mode' : '')}" data-density="${String(escapeHtml(state.density))}">
        <div class="pf-toolbar" data-app-header>
          <div class="pf-title"><i class="fas ${String(escapeHtml(state.icon || 'fa-layer-group'))}"></i><div><strong>${String(escapeHtml(state.title || (globalThis.PlatformLanguage?.text("photos","m_3eea4dfd8e947d","Feed") ?? "Feed")))}</strong><span>${String(escapeHtml(state.subtitle || `${visibleCount} item${visibleCount === 1 ? '' : 's'} shown`))}</span></div></div>
          <div class="pf-tools">
            ${feedScopeControlHtml()}
            ${state.density==='posts'&&state.canPost?'<button type="button" class="pf-action primary pf-create-post" data-feed-compose-open><i class="fas fa-pen-to-square"></i> Post</button>':''}
            ${state.density==='list'?`<div class="pf-list-controls"><span>Sort by</span><div class="pf-list-segment" role="group" aria-label="Sort feed by"><button type="button" data-feed-list-organize="time" aria-pressed="${state.listOrganize==='time'}" class="${state.listOrganize==='time'?'active':''}">Time</button><button type="button" data-feed-list-organize="project" aria-pressed="${state.listOrganize==='project'}" class="${state.listOrganize==='project'?'active':''}">Project</button></div></div>`:''}
            <div class="pf-density">
              ${String([
                {id:'list',label:'List',icon:'list'},
                {id:'small',label:'Small tiles',icon:'table-cells'},
                {id:'large',label:'Large tiles',icon:'border-all'},
                {id:'mosaic',label:'Mosaic',icon:'shapes'},
                {id:'posts',label:'Posts',icon:'newspaper'}
              ].filter(mode=>state.views.includes(mode.id)).map((mode) => `<button type="button" class="${state.density === mode.id ? 'active' : ''}" data-density="${mode.id}" aria-label="${mode.label}" aria-pressed="${state.density === mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join(''))}
            </div>
            <div class="pf-shown-wrap">
              <button type="button" class="pf-toolbar-action${String(state.shownMenuOpen || state.visibleActivity.size < DEFAULT_ACTIVITY_FILTERS.length ? ' active' : '')}" data-feed-shown aria-expanded="${String(state.shownMenuOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i><span>Filter</span></button>
              ${String(shownMenuHtml())}
            </div>
            ${String(state.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(state.uploadLabel)}</button>` : '')}
          </div>
        </div>
        <div data-photo-feed-dynamic>${String(dynamicHtml())}</div>
        ${feedComposerHtml()}
      </div>`;
    bind();
  }
  function bind(){
    const rootEl = state.root;
    if(!state.dismissHandlersBound){
      state.dismissHandlersBound=true;
      document.addEventListener('pointerdown',event=>{
        if(state.scopeMenuOpen && !state.root?.querySelector('.pf-feed-scope-control')?.contains(event.target)){
          state.scopeMenuOpen=false;
          state.root?.querySelector('.pf-feed-scope-menu')?.remove();
          const trigger=state.root?.querySelector('[data-feed-scope]');
          trigger?.setAttribute('aria-expanded','false');
          trigger?.querySelector('i')?.classList.replace('fa-chevron-up','fa-chevron-down');
        }
        if(state.shownMenuOpen && !state.root?.querySelector('.pf-shown-wrap')?.contains(event.target)){
          state.shownMenuOpen=false;
          state.root?.querySelector('[data-feed-shown-menu]')?.remove();
          const trigger=state.root?.querySelector('[data-feed-shown]');
          trigger?.setAttribute('aria-expanded','false');
          trigger?.classList.toggle('active',state.visibleActivity.size<DEFAULT_ACTIVITY_FILTERS.length);
        }
      });
      document.addEventListener('keydown',event=>{
        if(event.key!=='Escape')return;
        if(state.composerPreviewIndex>=0){state.composerPreviewIndex=-1;render();return;}
        if(state.scopeMenuOpen){state.scopeMenuOpen=false;state.root?.querySelector('.pf-feed-scope-menu')?.remove();const trigger=state.root?.querySelector('[data-feed-scope]');trigger?.setAttribute('aria-expanded','false');trigger?.querySelector('i')?.classList.replace('fa-chevron-up','fa-chevron-down');}
        if(state.shownMenuOpen){state.shownMenuOpen=false;state.root?.querySelector('[data-feed-shown-menu]')?.remove();const trigger=state.root?.querySelector('[data-feed-shown]');trigger?.setAttribute('aria-expanded','false');trigger?.classList.toggle('active',state.visibleActivity.size<DEFAULT_ACTIVITY_FILTERS.length);}
      });
    }
    rootEl.querySelector('[data-feed-scope]')?.addEventListener('click',()=>{state.scopeMenuOpen=!state.scopeMenuOpen;render();if(state.scopeMenuOpen)rootEl.querySelector('[data-feed-scope-search]')?.focus();});
    rootEl.querySelectorAll('[data-feed-scope-option]').forEach(button=>button.addEventListener('click',()=>{state.feedScope=button.dataset.feedScopeOption;state.scopeMenuOpen=false;state.visible=PAGE_SIZE;writeFeedPreferences();render();}));
    rootEl.querySelector('[data-feed-scope-search]')?.addEventListener('input',event=>{const query=event.target.value.trim().toLowerCase();rootEl.querySelectorAll('.pf-feed-scope-departments [data-feed-scope-option]').forEach(button=>{button.hidden=!button.textContent.toLowerCase().includes(query);});});
    rootEl.querySelectorAll('[data-feed-list-organize]').forEach(button=>button.addEventListener('click',()=>{state.listOrganize=button.dataset.feedListOrganize==='project'?'project':'time';writeFeedPreferences();render();}));
    rootEl.querySelector('[data-feed-compose-open]')?.addEventListener('click',()=>{state.composerOpen=true;render();rootEl.querySelector('[data-feed-compose-text]')?.focus();});
    rootEl.querySelectorAll('[data-feed-compose-close]').forEach(button=>button.addEventListener('click',()=>{if(!state.composerBusy){state.composerOpen=false;render();}}));
    const composerWidgets=window.FirstMateChannels?.composerWidgets;
    const editorMount=rootEl.querySelector('[data-feed-compose-editor-mount]');
    const composeText=editorMount&&composerWidgets?.createEditor?.('Write a post… Use @ to mention someone.');
    if(composeText){
      composeText.dataset.feedComposeText='';composeText.setAttribute('aria-label','Post message');composeText.value=state.composerText;
      editorMount.append(composeText);
      const bar=composerWidgets.formatBar(composeText);bar.classList.add('pf-post-formatbar');bar.setAttribute('aria-label','Post formatting');
      rootEl.querySelector('[data-feed-format-mount]')?.append(bar);
    }
    const mentionMenu=rootEl.querySelector('[data-feed-compose-mention-menu]');
    const eligibleMentions=()=>state.users.filter(user=>Object.prototype.hasOwnProperty.call(state.userDepartments,user.id) && (!state.composerDepartment || (state.userDepartments[user.id] || []).includes(state.composerDepartment)));
    if(composeText && window.FirstMateTags?.attachMentionTextarea){
      state.composerMentionApi=window.FirstMateTags.attachMentionTextarea(composeText,{
        orgId:orgId(),source:'feed',memberIds:()=>eligibleMentions().map(user=>user.id),
        onSelect:user=>state.composerMentions.add(user.id)
      });
      state.composerMentionApi.setSelectedMentions?.(eligibleMentions().filter(user=>state.composerMentions.has(user.id)).map(user=>({id:user.id,name:firstText(user.name,user.display_name,user.email),email:user.email})));
      composeText._mentionApi=state.composerMentionApi;
    }
    if(composeText)composerWidgets?.mentionButton?.(composeText,rootEl.querySelector('.pf-post-formatbar'),{
      candidates:()=>eligibleMentions(),onSelect:user=>{state.composerMentions.add(user.id);state.composerText=composeText.value;},
      onError:error=>showToast?.('Mention',error?.message || 'Could not tag a teammate.',false)
    });
    const updateMentionMenu=()=>{
      if(state.composerMentionApi)return;
      if(!composeText || !mentionMenu)return;
      const before=composeText.value,match=before.match(/(?:^|\s)@([^@\n]{0,40})$/);
      if(!match){mentionMenu.hidden=true;return;}
      const query=match[1].toLowerCase();const people=eligibleMentions().filter(user=>firstText(user.name,user.display_name,user.email).toLowerCase().includes(query)).slice(0,8);
      mentionMenu.replaceChildren();mentionMenu.hidden=!people.length;
      for(const user of people){const button=document.createElement('button');button.type='button';button.textContent=firstText(user.name,user.display_name,user.email,'Employee');button.onmousedown=event=>event.preventDefault();button.onclick=()=>{const name=firstText(user.name,user.display_name,user.email,'Employee');composeText.insertText?.(`@${name} `);state.composerText=composeText.value;state.composerMentions.add(user.id);mentionMenu.hidden=true;};mentionMenu.append(button);}
    };
    composeText?.addEventListener('input',event=>{state.composerText=event.target.value;updateMentionMenu();});
    composeText?.addEventListener('click',updateMentionMenu);
    rootEl.querySelector('[data-feed-compose-emoji-open]')?.addEventListener('mousedown',()=>composeText?.saveSelection());
    rootEl.querySelector('[data-feed-compose-emoji-open]')?.addEventListener('click',event=>openFeedEmojiWidget(event.currentTarget,emoji=>{composeText.insertText(emoji);state.composerText=composeText.value;updateMentionMenu();}));
    rootEl.querySelector('[data-feed-compose-gif]')?.addEventListener('click',()=>window.FirstMateChannels?.createGifPickerButton({orgId:orgId(),dialogTitle:'Choose a GIF',actionLabel:'Add GIF',onSend:selected=>{state.composerGif=selected;render();},onError:error=>showToast?.('GIF',error?.message || 'Could not add GIF.',false)}).click());
    rootEl.querySelector('[data-feed-compose-remove-gif]')?.addEventListener('click',()=>{state.composerGif=null;render();});
    const removeComposerAudio=()=>{clearComposerAudio();const button=rootEl.querySelector('[data-feed-compose-audio]');if(button)button.disabled=false;};
    mountFeedPreparedAudio(rootEl.querySelector('[data-feed-compose-audio-mount]'),state.composerAudioAttachment,state.composerAudioNote,removeComposerAudio);
    bindFeedVoiceControls(rootEl,'feed-compose',{
      upload:async file=>{state.composerAudioFile=file;state.composerAudioAttachment={id:'pending',url:URL.createObjectURL(file)};return state.composerAudioAttachment;},
      onRemove:removeComposerAudio,
      hasPendingAudio:()=>!!state.composerAudioNote,
      onPrepared:(mode,prepared)=>{
        if(mode==='dictate'){state.composerText=[state.composerText,prepared.text].filter(Boolean).join(' ');composeText.value=state.composerText;composeText.focus();}
        else{state.composerAudioNote=prepared.metadata;state.composerAudioAttachment=prepared.attachment;}
      },
      onError:error=>showToast?.('Audio note',error?.message || 'Could not record audio.',false)
    });
    rootEl.querySelector('[data-feed-compose-scope]')?.addEventListener('change',event=>{
      state.composerDepartment=event.target.value;
      state.composerMentions.clear();render();
    });
    rootEl.querySelectorAll('[data-feed-compose-preview]').forEach(button=>button.addEventListener('click',()=>{state.composerPreviewIndex=Number(button.dataset.feedComposePreview);render();}));
    rootEl.querySelector('[data-feed-preview-close]')?.addEventListener('click',()=>{state.composerPreviewIndex=-1;render();});
    rootEl.querySelector('[data-feed-image-lightbox]')?.addEventListener('click',event=>{if(event.target===event.currentTarget){state.composerPreviewIndex=-1;render();}});
    rootEl.querySelectorAll('[data-feed-compose-remove]').forEach(button=>button.addEventListener('click',()=>{const index=Number(button.dataset.feedComposeRemove),file=state.composerFiles[index];if(file){URL.revokeObjectURL(state.composerPreviewUrls.get(file));state.composerPreviewUrls.delete(file);state.composerFiles.splice(index,1);}state.composerPreviewIndex=-1;render();}));
    rootEl.querySelector('[data-feed-compose-files]')?.addEventListener('change',event=>{
      const chosen=[...event.target.files];
      if(chosen.length+state.composerFiles.length>50 || chosen.some(file=>file.size>(file.type.startsWith('image/')?10:25)*1024*1024)){
        showToast?.('Post attachments','Choose up to 50 files. Images must be 10 MB or smaller; other files must be 25 MB or smaller.',false);return;
      }
      chosen.filter(file=>file.type.startsWith('image/')).forEach(file=>state.composerPreviewUrls.set(file,URL.createObjectURL(file)));
      state.composerFiles.push(...chosen);render();
    });
    rootEl.querySelector('[data-feed-compose]')?.addEventListener('submit',async event=>{
      event.preventDefault();if(state.composerBusy||!(state.composerText.trim()||state.composerFiles.length||state.composerGif||state.composerAudioFile))return;
      if(state.composerText.length>5000){showToast?.('Post is too long','Keep the post under 5,000 characters.',false);return;}
      const eligible=eligibleMentions();
      const tagged=state.composerMentionApi?.selectedMentions?.() || [];
      const mentionIds=eligible.filter(user=>tagged.some(person=>person.id===user.id) || state.composerMentions.has(user.id) || state.composerText.toLowerCase().includes(`@${firstText(user.name,user.display_name,user.email).toLowerCase()}`)).map(user=>user.id);
      state.composerBusy=true;render();
      try{
        state.composerOperationId ||= globalThis.crypto?.randomUUID?.() || `manual_${Date.now()}`;
        const response=await window.ChannelsAPI.feed.createPost(orgId(),{text:state.composerText.trim(),department_id:state.composerDepartment,mention_user_ids:mentionIds,client_msg_id:state.composerOperationId,has_uploads:!!(state.composerFiles.length||state.composerAudioFile),...(state.composerGif?{giphy:state.composerGif}:{}),...(state.composerAudioNote?{audio_note:state.composerAudioNote}:{})});
        const postId=response.post.id;
        for(const file of [...state.composerFiles]){
          await window.ChannelsAPI.feed.upload(orgId(),postId,file);
          state.composerFiles.shift();URL.revokeObjectURL(state.composerPreviewUrls.get(file));state.composerPreviewUrls.delete(file);
        }
        if(state.composerAudioFile){await window.ChannelsAPI.feed.upload(orgId(),postId,state.composerAudioFile);clearComposerAudio();}
        state.composerOpen=false;state.composerText='';state.composerDepartment='';state.composerMentions.clear();state.composerPreviewIndex=-1;state.composerOperationId='';state.composerGif=null;state.composerAudioNote=null;
        await load({toast:true});
      }catch(error){showToast?.('Could not post',error?.message || 'Try again.',false);}
      finally{state.composerBusy=false;render();}
    });
    rootEl.querySelector('.pf-search input[type="search"]')?.addEventListener('input', (event) => {
      state.query = event.target.value || '';
      state.visible = PAGE_SIZE;
      renderDynamic();
    });
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
    bindFeedPosts(rootEl);
    window.FirstMateAudioNotes?.hydrate?.(rootEl);
    state.mosaicObserver?.disconnect();
    state.noteObserver?.disconnect();
    state.mediaResizeObserver?.disconnect();
    const notes=[...rootEl.querySelectorAll('.pf-note')];
    const measureNote=(note)=>{
      const measure=note.querySelector('.pf-note-measure');
      if (!measure) return;
      const lineHeight=parseFloat(getComputedStyle(measure).lineHeight) || 17;
      const expandable=measure.scrollHeight > lineHeight * (note.classList.contains('pf-note-list') ? 2.25 : 1.5);
      note.classList.toggle('expandable',expandable);
      if (!expandable) {
        note.classList.remove('expanded');
        const button=note.querySelector('[data-feed-note-toggle]');
        button?.setAttribute('aria-expanded','false');
        button?.setAttribute('aria-label','Expand note');
      }
    };
    notes.forEach(measureNote);
    if(notes.length && typeof ResizeObserver === 'function'){
      state.noteObserver=new ResizeObserver(entries=>entries.forEach(({target})=>measureNote(target.parentElement)));
      notes.forEach(note=>{const measure=note.querySelector('.pf-note-measure');if(measure)state.noteObserver.observe(measure);});
    }
    const mediaRows=[...rootEl.querySelectorAll('.pf-feed-list-media')];
    const fitMedia=media=>{
      const thumbs=[...media.querySelectorAll('.pf-thumb')],more=media.querySelector('.pf-feed-list-more');
      if(!thumbs.length)return;
      thumbs.forEach(thumb=>{thumb.hidden=false;});
      if(more)more.hidden=true;
      const width=media.clientWidth,gap=parseFloat(getComputedStyle(media).columnGap)||6;
      const thumbWidth=thumbs[0].getBoundingClientRect().width;
      if(!width || !thumbWidth)return;
      let count=Math.min(thumbs.length,Math.max(1,Math.floor((width+gap)/(thumbWidth+gap))));
      if(count<thumbs.length && more){
        more.hidden=false;
        const moreWidth=more.getBoundingClientRect().width;
        count=Math.max(1,Math.min(count,Math.floor((width-moreWidth)/(thumbWidth+gap))));
      }
      thumbs.forEach((thumb,index)=>{thumb.hidden=index>=count;});
      if(more)more.hidden=count>=thumbs.length;
    };
    mediaRows.forEach(fitMedia);
    if(mediaRows.length && typeof ResizeObserver==='function'){
      state.mediaResizeObserver=new ResizeObserver(entries=>entries.forEach(({target})=>fitMedia(target)));
      mediaRows.forEach(media=>state.mediaResizeObserver.observe(media));
    }
    if(state.mosaicResizeHandler){window.removeEventListener('resize',state.mosaicResizeHandler);state.mosaicResizeHandler=null;}
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
    rootEl.querySelectorAll('[data-feed-more-project-id]').forEach((btn) => btn.addEventListener('click', () => {
      const id=cleanText(btn.dataset.feedMoreProjectId);
      openProject(projectForId(id),{groupKey:id,tab:'photos'}).catch((error)=>{
        console.warn('Could not open project photos from Feed',error);
        showToast?.('Project issue',error?.message || 'Could not open that project.',false);
      });
    }));
    rootEl.querySelectorAll('[data-feed-project-id]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = cleanText(btn.dataset.feedProjectId);
        const project = projectForId(id);
        openProject(project, { groupKey:id, tab:state.density==='list'?'map':'photos' }).catch((error) => {
          console.warn('Could not open project from Feed', error);
          showToast?.((globalThis.PlatformLanguage?.text("photos","m_3d2585ab4e8b80","Project issue") ?? "Project issue"), error?.message || 'Could not open that project.', false);
        });
      });
    });
    rootEl.querySelectorAll('[data-feed-note-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const note = button.closest('.pf-note');
        const expanded = note?.classList.toggle('expanded') || false;
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', expanded ? 'Collapse note' : 'Expand note');
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
          <div><strong><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_89e3b5685a73e8"," Trash") ?? " Trash")}</strong><span data-trash-summary>${((v0,v1,v2) => globalThis.PlatformLanguage?.htmlText("photos","m_bb5db1f723b03a",`${v0} media item${v1} | ${v2}`,{v0,v1,v2}) ?? `${v0} media item${v1} | ${v2}`)(escapeHtml(currentStats.count),currentStats.count === 1 ? '' : 's',escapeHtml(formatBytes(currentStats.bytes)))}</span></div>
          <div class="pf-selection-actions">
            <button type="button" class="pf-action danger" data-trash-empty><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_fe9f87c79c5388"," Empty Trash") ?? " Empty Trash")}</button>
            <button type="button" class="pf-trash-close" data-trash-close aria-label="${(globalThis.PlatformLanguage?.htmlText("photos","m_bef1bdc6b4d7cc","Close trash") ?? "Close trash")}"><i class="fas fa-times"></i></button>
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
            <div class="pf-user-main-title">${(globalThis.PlatformLanguage?.htmlText("photos","m_6f5dea53bf13f4","Profile") ?? "Profile")}</div>
            <div class="pf-user-head-actions">
              <div class="pf-user-tabs">
                <button type="button" class="pf-user-tab active" data-user-tab="photos">${String(escapeHtml(window.Portal?.terminology?.get?.('photos.photos_view', 'Photos') || 'Photos'))}</button>
                ${String(showActivity ? `<button type="button" class="pf-user-tab" data-user-tab="activity">${escapeHtml(window.Portal?.terminology?.get?.('photos.activity_view', 'Activity') || 'Activity')}</button>` : '')}
              </div>
              <button type="button" class="pf-user-close" data-user-close aria-label="${(globalThis.PlatformLanguage?.htmlText("photos","m_f7d93ca06bc15a","Close user") ?? "Close user")}"><i class="fas fa-times"></i></button>
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
      panel.innerHTML = `<div class="pf-user-activity"><div class="pf-loading">${(globalThis.PlatformLanguage?.htmlText("photos","m_a74d3976fbbe47","Loading activity...") ?? "Loading activity...")}</div></div>`;
      const root = panel.querySelector('.pf-user-activity');
      const result = await window.PlatformAPI?.userActivity?.listForUser?.(orgId(), enriched, { limit: 200 }).catch((error) => ({ error }));
      if (result?.error) {
        root.innerHTML = `<div class="pf-user-empty"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("photos","m_1fc5d851a4ed4e","Could not load activity") ?? "Could not load activity")}</strong><span>${String(escapeHtml(result.error?.message || 'Try again in a moment.'))}</span></div>`;
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
    state.notes = [];
    state.users = [];
    state.query = '';
    state.density = 'small';
    state.authorizedSources=new Map();
    state.posts=new Map();
    state.shownMenuOpen = false;
    state.visibleMedia = new Set(DEFAULT_MEDIA_FILTERS);
    state.visibleTags = new Set();
    state.visibleDocuments = new Set(DOCUMENT_FILTERS.map(d=>d.id));
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
    startFeedPolling();
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
      visibleTypes:new Set(['photo','video','audio','document']),
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
        .filter(item => !options.typeFilters || local.visibleTypes.has(galleryMediaType(item.photo)))
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
        <div class="pf-shown-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("photos","m_7a18799062167c","Filter by tags") ?? "Filter by tags")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("photos","m_947598ffa6c0ff","Show media matching any selected tag.") ?? "Show media matching any selected tag.")}</span></div><button type="button" data-local-tags-close aria-label="${(globalThis.PlatformLanguage?.htmlText("photos","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        ${options.typeFilters ? shownGroupHtml('local-types','File types','fa-filter',[{id:'photo',label:'Photos',icon:'fa-image'},{id:'video',label:'Videos',icon:'fa-video'},{id:'audio',label:'Audio',icon:'fa-headphones'},{id:'document',label:'Documents & files',icon:'fa-file-lines'}],local.visibleTypes) : ''}
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
        ? `<button type="button" class="pf-action" data-selection-restore><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_d55efd8791e299"," Restore") ?? " Restore")}</button><button type="button" class="pf-action danger" data-selection-hard-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("photos","m_4e4c97a39c03c8"," Delete Forever") ?? " Delete Forever")}</button>`
        : (String(extraSelectionActions) + "<button type=\"button\" class=\"pf-action danger\" data-selection-delete><i class=\"fas fa-trash\"></i>" + (globalThis.PlatformLanguage?.text("photos","m_90e27d705bee80"," Delete") ?? " Delete") + "</button><div class=\"pf-download-wrap\"><button type=\"button\" class=\"pf-action primary\" data-selection-download><i class=\"fas fa-download\"></i>" + (globalThis.PlatformLanguage?.text("photos","m_f3ad10eaad3ccf"," Download") ?? " Download") + "</button><div class=\"pf-download-menu" + String(local.downloadMenuOpen ? ' visible' : '') + "\" data-selection-download-menu><button type=\"button\" data-download-selected-plain>" + (globalThis.PlatformLanguage?.text("photos","m_c94e82190b64cc","Without markup") ?? "Without markup") + "</button><button type=\"button\" data-download-selected-markup>" + (globalThis.PlatformLanguage?.text("photos","m_42e3382f311f77","With markup") ?? "With markup") + "</button></div></div>");
      return `
        ${local.selectionMode ? `<div class="pf-selectionbar"><strong>${((v0) => globalThis.PlatformLanguage?.htmlText("photos","m_4b740d0b3ec319",`${v0} selected`,{v0}) ?? `${v0} selected`)(local.selected.size)}</strong><div class="pf-selection-actions"><button type="button" class="pf-action" data-selection-clear>${(globalThis.PlatformLanguage?.htmlText("photos","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>${String(selectionActions)}</div></div>` : ''}
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
        onDeletePhoto: options.deleteEnabled===false ? undefined : async (photo) => {
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
          <div class="pf-toolbar" data-app-header>
            <div class="pf-title"><i class="fas ${String(escapeHtml(icon))}"></i><div><strong>${String(escapeHtml(titleLabel))}</strong>${String(subtitleLabel ? `<span>${escapeHtml(subtitleLabel)}</span>` : '')}</div></div>
            <div class="pf-tools">
              <label class="pf-search"><i class="fas fa-search"></i><input type="search" value="${String(escapeHtml(local.query))}" placeholder="${String(escapeHtml(options.searchPlaceholder || 'Search dates, uploaders, tags'))}"></label>
              <div class="pf-density">${String([
                { id: 'loose', label: (globalThis.PlatformLanguage?.htmlText("photos","m_0c94f4868222d9","Loose") ?? "Loose"), icon: 'border-all' },
                { id: 'comfortable', label: (globalThis.PlatformLanguage?.htmlText("photos","m_1aa394ac627daa","Comfortable") ?? "Comfortable"), icon: 'grip' },
                { id: 'compact', label: (globalThis.PlatformLanguage?.htmlText("photos","m_e5eb6280bafc65","Compact") ?? "Compact"), icon: 'table-cells' },
                ...(Array.isArray(options.extraDensityModes) ? options.extraDensityModes : [])
              ].map((mode) => `<button type="button" class="${local.density === mode.id ? 'active' : ''}" data-density="${mode.id}" data-fm-tooltip="${mode.label}"><i class="fas fa-${mode.icon}"></i></button>`).join(''))}</div>
              <div class="pf-shown-wrap">
                <button type="button" class="pf-toolbar-action${String(local.tagMenuOpen || local.visibleTags.size ? ' active' : '')}" data-local-tags aria-expanded="${String(local.tagMenuOpen ? 'true' : 'false')}"><i class="fas fa-tags"></i><span>${(options.typeFilters ? 'Filter' : (globalThis.PlatformLanguage?.htmlText("photos","m_562d2cd3a48b8f","Tags") ?? "Tags"))}</span></button>
                ${String(localTagMenuHtml())}
              </div>
              ${String(toolbarActions)}
              ${String(options.uploadLabel ? `<button type="button" class="pf-upload" data-photo-feed-upload><i class="fas fa-plus"></i> ${escapeHtml(options.uploadLabel)}</button>` : '')}
            </div>
          </div>
          ${String(options.layoutAsideHtml ? `<div class="pf-content-layout">
            ${String(typeof options.layoutTabsHtml === 'function' ? options.layoutTabsHtml() : options.layoutTabsHtml || '')}
            <div data-photo-feed-dynamic>${String(bodyHtml())}</div>
            <aside class="pf-content-aside">${String(typeof options.layoutAsideHtml === 'function' ? options.layoutAsideHtml() : options.layoutAsideHtml)}</aside>
          </div>` : `<div data-photo-feed-dynamic>${String(bodyHtml())}</div>`)}
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
      panel.querySelectorAll('[data-feed-filter-group="local-types"][data-feed-filter-id]').forEach(button=>button.addEventListener('click',()=>{
        const id=button.dataset.feedFilterId;if(local.visibleTypes.has(id))local.visibleTypes.delete(id);else local.visibleTypes.add(id);renderLocal();
      }));
      panel.querySelector('[data-feed-filter-group="local-types"][data-filter-group-action]')?.addEventListener('click',event=>{
        local.visibleTypes=event.currentTarget.dataset.filterGroupAction==='all'?new Set(['photo','video','audio','document']):new Set();renderLocal();
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
        startFeedPolling();
      },
      onHide:()=>{clearInterval(state.feedTimer);state.mosaicObserver?.disconnect();state.noteObserver?.disconnect();state.mediaResizeObserver?.disconnect();if(state.mosaicResizeHandler)window.removeEventListener('resize',state.mosaicResizeHandler);}
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
