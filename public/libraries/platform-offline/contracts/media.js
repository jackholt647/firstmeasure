/* public/libraries/platform-offline/contracts/media.js
 *
 * Photos and videos without a connection (docs/architecture/offline.md, "Photos and files").
 *
 *   media.upload   POST .../media                       a photo or video of a project, or one with no project yet
 *   photos.save    POST .../projects/:project/photos    the project's photo list (add, trash, restore, remove)
 *   media.assign   POST .../media/assign                pairing photos that have no project with one
 *
 * A project photo is two changes in the scope `project:<id>`: the upload, then the list save, so both follow the
 * project's own create when that is still waiting. A photo with no project is in the person's scope `user:<id>`,
 * and so is its pairing. Renaming and tagging (PATCH .../media/:id) are not queued: see the doc.
 */
(function () {
  'use strict';
  const ORG = '/v1/platform/organizations/:org';
  const text = (value) => String(value == null ? '' : value).trim();
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const list = (value) => (Array.isArray(value) ? value : []);
  const parse = (value, fallback) => {
    if (value && typeof value === 'object') return value;
    if (value === undefined || value === null || value === '') return fallback;
    try { return JSON.parse(String(value)); } catch (_) { return fallback; }
  };
  const truthy = (value) => value === true || /^(1|true|yes|on)$/i.test(text(value));
  // The server's own id and file name rules (platform/storage.ts: sanitizeId, sanitizeFileName).
  const cleanId = (value) => text(value).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanName = (value) => ((text(value).replace(/\\/g, '/').split('/').pop() || 'upload').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')) || 'upload';
  const iso = (ms) => new Date(ms).toISOString();
  const path = (org, rest) => '/v1/platform/organizations/' + encodeURIComponent(org) + rest;

  // ---------------------------------------------------------------------------------------------------------
  // The upload
  // ---------------------------------------------------------------------------------------------------------

  /** The upload's form as the route reads it, or null when this contract does not queue it. */
  function uploadOf(ctx) {
    const body = obj(ctx.body);
    const field = Object.keys(body).find((name) => body[name] && typeof body[name] === 'object' && body[name].blob);
    const id = cleanId(body.id);
    if (!field || !id || truthy(body.replace_slot != null ? body.replace_slot : body.replaceSlot)) return null;
    const ownerType = cleanId(body.owner_type || body.ownerType) || 'organization';
    const slot = cleanId(body.slot) || 'media';
    const owner = cleanId(body.owner_id || body.ownerId);
    const metadata = obj(parse(body.metadata, {}));
    // A contact's picture (slot `profile`), media and documents. The contact's own save follows in the contact's
    // scope (contacts.js). The public branding slots are never a contact's.
    if (ownerType === 'contact') {
      if (!owner || slot === 'logo' || cleanId(body.scope) === 'branding' || cleanId(body.collection) === 'branding') return null;
      // A picture the server would refuse is not kept to be refused later (contacts/photo-import.ts: validateContactPhoto).
      if (slot === 'profile' && (!/^image\/(jpeg|png|webp|gif)$/i.test(text(body[field].type)) || body[field].size > 10 * 1024 * 1024)) return null;
      return { id, field, file: body[field], ownerType, slot, project: '', contact: owner, metadata, body };
    }
    // Otherwise only a project's photos and photos with no project yet: the uploads of other apps go to routes of
    // their own, with contracts of their own below.
    if (slot !== 'photos' || (ownerType !== 'project' && ownerType !== 'organization')) return null;
    const project = ownerType === 'project' ? owner : '';
    if (ownerType === 'project' && !project) return null;
    return { id, field, file: body[field], ownerType, slot, project, contact: '', metadata, body };
  }

  /** Width and height of a picture, where the context can decode one (a worker can; a test may not). */
  async function dimensions(file) {
    if (!/^image\//i.test(file.type || '') || /svg|gif/i.test(file.type) || typeof createImageBitmap !== 'function') return null;
    try {
      const bitmap = await createImageBitmap(file.blob);
      const size = { width: bitmap.width, height: bitmap.height };
      if (bitmap.close) bitmap.close();
      return size;
    } catch (_) { return null; }
  }

  function extension(type, name) {
    const found = /\.([a-z0-9]{2,6})$/i.exec(name);
    if (found) return found[1].toLowerCase();
    return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm' }[type] || 'bin';
  }
  const numberIn = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback; };
  const choice = (value, fallback) => (['webp', 'jpeg', 'png'].includes(text(value).toLowerCase()) ? text(value).toLowerCase() : fallback);
  const formatExt = (format) => (format === 'jpeg' ? 'jpg' : format);
  const formatType = (format) => (format === 'jpeg' ? 'image/jpeg' : 'image/' + format);
  // A fraction (0.88) is a percentage (platform/storage.ts: mediaQuality).
  const quality = (value, fallback, min, max) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return fallback; return Math.max(min, Math.min(max, Math.round(n <= 1 ? n * 100 : n))); };

  /** The processing settings the server would use (platform/storage.ts: normalizeProcessingSettings). */
  function processing(body) {
    const whole = obj(parse(body.processing, {}));
    const pick = (name) => (Object.prototype.hasOwnProperty.call(body, name) ? parse(body[name], undefined) : whole[name]);
    const thumbs = pick('thumbnails') === false ? { enabled: false } : obj(pick('thumbnails'));
    const compress = pick('compression') === false ? { enabled: false } : obj(pick('compression'));
    const sizes = [...new Set(list(thumbs.sizes).map((size) => numberIn(size, 0, 32, 2400)).filter(Boolean))].sort((a, b) => a - b);
    return {
      thumbnails: {
        enabled: thumbs.enabled !== false, sizes: sizes.length ? sizes : [160, 320, 640], quality: quality(thumbs.quality, 78, 35, 95), format: choice(thumbs.format, 'webp'),
        largeOnly: thumbs.large_only !== false && thumbs.largeOnly !== false, largeThreshold: numberIn(thumbs.large_threshold != null ? thumbs.large_threshold : thumbs.largeThreshold, 1024, 128, 8000)
      },
      compression: {
        enabled: compress.enabled !== false, maxWidth: numberIn(compress.max_width != null ? compress.max_width : compress.maxWidth, 2400, 320, 12000), quality: quality(compress.quality, 82, 35, 98),
        format: choice(compress.format, 'webp'), variant: text(compress.variant) ? cleanId(compress.variant) : ''
      }
    };
  }

  /** The record the route answers for a new upload (platform/storage.ts: storeMediaUpload). */
  async function mediaRecord(ctx, upload) {
    const { id, file, ownerType, slot, project, contact, body } = upload;
    const type = text(file.type || 'application/octet-stream').toLowerCase();
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type === 'application/pdf' ? 'pdf' : 'file';
    const name = cleanName(file.name);
    const size = await dimensions(file);
    const settings = processing(body);
    const original = { path: 'original/original.' + extension(type, name), content_type: type, file_name: name, size_bytes: file.size };
    const variants = { original };
    if (kind === 'image' && type !== 'image/svg+xml' && type !== 'image/gif') {
      // Without the picture's size (nothing here could decode it) a photo is taken to be large, as a phone's are.
      const largest = size ? Math.max(size.width, size.height) : Infinity;
      if (size) { original.width = size.width; original.height = size.height; }
      const fit = (width, height) => {
        if (!size) return {};
        const scale = Math.min(1, width / size.width, (height || Infinity) / size.height);
        return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
      };
      const add = (variant, format, box) => {
        const fileName = variant + '.' + formatExt(format);
        variants[variant] = Object.assign({ path: 'renditions/' + fileName, content_type: formatType(format), file_name: fileName, size_bytes: 0 }, box);
      };
      if (settings.compression.enabled && size && largest > settings.compression.maxWidth) add(settings.compression.variant || 'display_' + settings.compression.maxWidth, settings.compression.format, fit(settings.compression.maxWidth));
      if (settings.thumbnails.enabled && (!settings.thumbnails.largeOnly || largest >= settings.thumbnails.largeThreshold)) {
        for (const edge of settings.thumbnails.sizes) add('thumb_' + edge, settings.thumbnails.format, fit(edge, edge));
      }
    }
    const metadata = Object.assign({}, upload.metadata, { uploaded_by_user_id: ctx.user });
    if (project) metadata.project_id = project;
    else if (ownerType === 'organization') delete metadata.project_id;
    const tags = [...new Set(list(metadata.tags).map((tag) => text(tag).toLowerCase().replace(/^#+/, '')).filter(Boolean))];
    if (tags.length) metadata.tags = tags;
    const now = iso(ctx.now);
    return {
      schema_version: 1, id, organization_id: ctx.org,
      scope: text(body.scope || body.collection || ownerType), collection: text(body.collection),
      owner: { type: ownerType, id: project || contact || cleanId(ctx.org), slot },
      kind, content_type: type, file_name: name, size_bytes: file.size,
      width: size ? size.width : null, height: size ? size.height : null,
      variants,
      renditions: Object.keys(variants).filter((key) => key !== 'original').map((key) => Object.assign({ variant: key }, variants[key])),
      markup: { layers: [], current_layer_id: null },
      processing: { thumbnails: settings.thumbnails, compression: settings.compression, warnings: [] },
      metadata, created_at: now, updated_at: now
    };
  }

  const isUnassigned = (media) => obj(media.owner).type === 'organization' && obj(media.owner).slot === 'photos' && !text(obj(media.metadata).project_id);
  const mediaProject = (media) => text(obj(media.metadata).project_id || (obj(media.owner).type === 'project' ? obj(media.owner).id : ''));
  const upsertById = (items, record, front) => { const rest = list(items).filter((item) => text(obj(item).id) !== text(record.id)); return front ? [record].concat(rest) : rest.concat([record]); };

  /** A media list read (GET .../media) this record belongs in, by the read's own filters. */
  function listShows(read, record) {
    const query = obj(read.query);
    if (text(query.tags) || text(query.tag)) return false;
    // A contact's own list shows that contact's files and nothing else.
    const contact = obj(record.owner).type === 'contact' ? text(obj(record.owner).id) : '';
    if (text(query.contact_id)) return text(query.contact_id) === contact;
    const project = text(query.project_id || query.projectId);
    if (project && project !== mediaProject(record)) return false;
    if (truthy(query.unassigned) && !isUnassigned(record)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The project's photo list
  // ---------------------------------------------------------------------------------------------------------

  /** A photo's identity, as the server and the apps name it. */
  const photoId = (photo) => { const p = obj(photo); return text(p.id || p.photo_id || p.media_id || p.src || p.url); };
  /** Photos with their identity as `id`, so two copies of a list merge photo by photo. */
  const withIds = (photos) => list(photos).map(obj).filter((photo) => photoId(photo)).map((photo) => (photo.id === photoId(photo) ? photo : Object.assign({}, photo, { id: photoId(photo) })));

  /**
   * What the photos route leaves (projects/media-assignment.ts: mergeProjectPhotos): the writer's photos in its
   * order, each replacing the stored photo with its identity, then every stored photo it did not mention, except
   * the ones it removes.
   */
  function applyList(stored, incoming, remove) {
    const gone = new Set(list(remove).map(text).filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const photo of list(incoming).map(obj)) {
      const id = photoId(photo);
      if (id && (seen.has(id) || gone.has(id))) continue;
      if (id) seen.add(id);
      out.push(photo);
    }
    for (const photo of list(stored).map(obj)) {
      const id = photoId(photo);
      if (!id || seen.has(id) || gone.has(id)) continue;
      seen.add(id);
      out.push(photo);
    }
    return out;
  }

  const projectUrl = (ctx) => path(ctx.org, '/projects/' + encodeURIComponent(ctx.params.project));
  const documentOf = (json) => obj(obj(json).document);

  /** A project photo reference for a media record (projects/media-assignment.ts: projectPhotoReference). */
  function photoReference(media, project) {
    const metadata = obj(media.metadata);
    const type = text(media.content_type).startsWith('video/') ? 'video' : 'image';
    const label = text(media.label || metadata.label || media.file_name) || (type === 'video' ? 'Project video' : 'Project photo');
    const source = text(metadata.source) || 'feed_camera';
    return {
      id: media.id, photo_id: media.id, media_id: media.id, kind: 'media_reference', variant: 'original',
      file_name: text(media.file_name), content_type: text(media.content_type), mime_type: text(media.content_type), media_type: type,
      size_bytes: Number(media.size_bytes || 0), variants: Object.keys(obj(media.variants)),
      owner: { collection: 'projects', id: project, field: 'photos' }, field: 'photos', label, alt: label, source,
      tags: list(media.tags).length ? media.tags : list(metadata.tags),
      uploaded_at: text(metadata.uploaded_at || media.created_at), updated_at: text(media.updated_at),
      is_thumbnail: false, is_default_thumbnail: false,
      metadata: Object.assign({}, metadata, { source, media_type: type, mime_type: text(media.content_type) }, obj(media.variants).thumb_320 ? { thumbnail_variant: 'thumb_320' } : {})
    };
  }

  /** Applies `change(photos)` to the photo list of a project read: one project, or the project in a list. */
  function projectPhotoEffects(org, project, change) {
    const inDocument = (document) => {
      const data = obj(obj(document).data);
      return Object.assign({}, document, { data: Object.assign({}, data, { photos: change(list(data.photos)) }) });
    };
    return [
      { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.org === org && m.project === project, apply: (json) => (obj(json).document ? Object.assign({}, json, { document: inDocument(json.document) }) : json) },
      { match: 'GET ' + ORG + '/projects', when: (m) => m.org === org, apply: (json) => (Array.isArray(obj(json).documents) ? Object.assign({}, json, { documents: json.documents.map((document) => (text(obj(document).id) === project ? inDocument(document) : document)) }) : json) }
    ];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Renaming and tagging
  // ---------------------------------------------------------------------------------------------------------

  const CATALOG = '/v1/channels/organizations/:org/feed/catalog';
  /** The server's tag rule (platform/storage.ts: normalizeMediaTags). */
  const cleanTags = (value) => [...new Set((Array.isArray(value) ? value : String(value == null ? '' : value).split(','))
    .map((tag) => String(tag == null ? '' : tag).trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+|[_-]+$/g, '').slice(0, 64)).filter(Boolean))].slice(0, 50);
  /** The name the server keeps for a requested one (platform/storage.ts: renameMedia). */
  const cleanLabel = (value) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.\-\s]+/, '').trim().slice(0, 160);
  const has = (body, key) => Object.prototype.hasOwnProperty.call(obj(body), key);
  const nameKey = (body) => ['name', 'file_name', 'label'].find((key) => has(body, key));
  const tagsOf = (media) => cleanTags(list(obj(media).tags).length ? media.tags : obj(obj(media).metadata).tags);
  /** A photo's name as people see it: what it was renamed to, else its file name. */
  const nameOf = (media) => text(obj(media).label || obj(obj(media).metadata).label || obj(media).file_name);
  // Tags are kept as a set while two copies are merged, so a tag added here and another added in the office both stay.
  const tagSet = (tags) => Object.fromEntries(cleanTags(tags).map((tag) => [tag, true]));
  const mergeDoc = (media) => ({ name: nameOf(media), tags: tagSet(tagsOf(media)) });

  /** What the rename and tag route leaves of a record (platform/storage.ts: renameMedia, updateMediaTags). */
  function editedRecord(media, change, now) {
    let next = Object.assign({}, media);
    if (change.name !== undefined) {
      const requested = cleanLabel(change.name);
      const previous = text(media.file_name);
      const ext = (/\.([a-z0-9]{1,8})$/i.exec(previous) || [])[1] || '';
      const fileName = ext && !new RegExp('\\.' + ext + '$', 'i').test(requested) ? requested + '.' + ext : requested;
      const stem = fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || requested;
      const variants = {};
      for (const [key, value] of Object.entries(obj(media.variants))) {
        const entry = obj(value);
        const own = (/\.([a-z0-9]{1,8})$/i.exec(text(entry.file_name)) || [])[1] || ext;
        variants[key] = text(entry.file_name) ? Object.assign({}, entry, { file_name: own ? stem + '.' + own : stem }) : value;
      }
      next = Object.assign(next, { file_name: fileName, label: requested, variants, metadata: Object.assign({}, obj(next.metadata), { file_name: fileName, label: requested }) });
      if (Array.isArray(media.renditions)) next.renditions = media.renditions.map((item) => (variants[obj(item).variant] ? Object.assign({}, item, { file_name: variants[item.variant].file_name }) : item));
    }
    if (change.tags !== undefined) {
      const tags = cleanTags(change.tags);
      next = Object.assign(next, { tags, metadata: Object.assign({}, obj(next.metadata), { tags }) });
    }
    next.updated_at = now;
    return next;
  }

  /** The change a rename or tag request makes: { name?, tags? }. */
  function editOf(ctx) {
    const body = obj(ctx.body);
    const key = nameKey(body);
    const change = {};
    if (key && cleanLabel(body[key])) change.name = cleanLabel(body[key]);
    if (has(body, 'tags')) change.tags = cleanTags(body.tags);
    return change;
  }

  /**
   * A media record as this device knows it, with the changes queued before this one: its own read, else the
   * lists that show it (a photo is mostly known from a project's media list or the Feed's catalog).
   */
  async function knownMedia(ctx, id) {
    const own = obj(obj(await ctx.saved(path(ctx.org, '/media/' + encodeURIComponent(id)))).media);
    if (text(own.id) === id) return own;
    for (const read of await ctx.find('GET ' + ORG + '/media')) {
      const found = list(obj(read.json).media).find((item) => text(obj(item).id) === id);
      if (found) return found;
    }
    const catalog = obj(await ctx.saved('/v1/channels/organizations/' + encodeURIComponent(ctx.org) + '/feed/catalog'));
    return list(catalog.media).concat(list(catalog.unassigned_media)).find((item) => text(obj(item).id) === id) || null;
  }

  /** `change(record)` on that record wherever a read lists it. */
  function mediaRecordEffects(org, id, change) {
    const inList = (items) => items.map((item) => (text(obj(item).id) === id ? change(obj(item)) : item));
    return [
      { match: 'GET ' + ORG + '/media/:media', when: (m) => m.org === org && m.media === id, apply: (json) => (text(obj(obj(json).media).id) === id ? Object.assign({}, json, { media: change(json.media) }) : json) },
      { match: 'GET ' + ORG + '/media', when: (m) => m.org === org, apply: (json) => (Array.isArray(obj(json).media) ? Object.assign({}, json, { media: inList(json.media) }) : json) },
      { match: 'GET ' + CATALOG, when: (m) => m.org === org, apply: (json) => {
        const catalog = obj(json);
        const next = Object.assign({}, json);
        for (const key of ['media', 'unassigned_media']) if (Array.isArray(catalog[key])) next[key] = inList(catalog[key]);
        return next;
      } }
    ];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Uploads of other apps: a file added to a project's documents list, checklist evidence
  // ---------------------------------------------------------------------------------------------------------

  const WORKFORCE = '/v1/workforce/organizations/:org';
  const first = (...values) => { for (const value of values) { const found = text(value); if (found) return found; } return ''; };

  /** The form's file and the media id the device made for it (sent as `name`), or null. */
  function namedFile(ctx, name) {
    const body = obj(ctx.body);
    const field = Object.keys(body).find((key) => body[key] && typeof body[key] === 'object' && body[key].blob);
    const id = text(body[name]);
    return field && /^media_[a-f0-9]{16}$/.test(id) ? { id, field, file: body[field], body } : null;
  }
  /** The record's own read and the media lists that show it. */
  const recordEffects = (ctx, record) => [
    { match: 'GET ' + ORG + '/media/:media', when: (m) => m.org === ctx.org && m.media === record.id, seed: () => ({ ok: true, media: record }) },
    { match: 'GET ' + ORG + '/media', when: (m, read) => m.org === ctx.org && listShows(read, record), apply: (json) => (Array.isArray(obj(json).media) ? Object.assign({}, json, { media: upsertById(json.media, record) }) : json) }
  ];

  /** The server's document types (platform/api.ts: documentTypeMeta). */
  function documentType(value) {
    const type = text(value || 'document').toLowerCase().replace(/[\s-]+/g, '_');
    if (type === 'proposal') return { type, label: 'Proposal', icon: 'fa-file-signature', color: '#2563eb' };
    if (type === 'change_order' || type === 'changeorder') return { type: 'change_order', label: 'Change Order', icon: 'fa-file-contract', color: '#7c3aed' };
    if (type === 'roof_report' || type === 'report' || type === 'measurement_report') return { type: 'roof_report', label: 'Roof Report', icon: 'fa-ruler-combined', color: '#059669' };
    if (type === 'customer_report' || type === 'summary') return { type: 'customer_report', label: 'Customer Report', icon: 'fa-file-lines', color: '#0891b2' };
    if (type === 'instant_report') return { type, label: 'Instant Report', icon: 'fa-bolt', color: '#ca8a04' };
    if (type === 'weather_report') return { type, label: 'Weather Report', icon: 'fa-cloud-sun-rain', color: '#0d9488' };
    if (type === 'receipt') return { type, label: 'Receipt', icon: 'fa-receipt', color: '#0f766e' };
    if (type === 'required') return { type, label: 'Required', icon: 'fa-clipboard-check', color: '#dc2626' };
    return { type: type || 'document', label: 'Document', icon: 'fa-file-lines', color: '#64748b' };
  }

  /** The media record the documents route stores (platform/api.ts: POST .../projects/:project/documents). */
  async function documentMedia(ctx, found) {
    const meta = obj(parse(found.body.metadata, {}));
    const record = await mediaRecord(ctx, {
      id: found.id, file: found.file, ownerType: 'project', slot: 'documents', project: ctx.params.project, contact: '',
      metadata: Object.assign({}, meta, { field: 'documents', document_collection: 'projects', document_id: ctx.params.project, source: text(meta.source) || 'project_document_upload', uploaded_at: iso(ctx.now) }),
      // The route makes no thumbnails or smaller copy of a document unless the form asks.
      body: { scope: 'documents', collection: 'projects', thumbnails: has(found.body, 'thumbnails') ? found.body.thumbnails : 'false', compression: has(found.body, 'compression') ? found.body.compression : 'false' }
    });
    delete record.metadata.project_id;
    return record;
  }

  /** The entry of a project's documents list for an uploaded file (documentReferenceFromMedia, normalizeProjectDocumentReference). */
  function documentReference(media, meta) {
    const stored = obj(media.metadata);
    const title = first(meta.title, meta.label, media.file_name, 'Document');
    const type = documentType(first(meta.document_type, meta.type, 'document'));
    return {
      id: media.id, document_id: media.id, media_id: media.id, kind: 'media_reference', title, label: title,
      document_type: type.type, source: first(meta.source, 'project_document_upload'),
      file_name: text(media.file_name), content_type: text(media.content_type), mime_type: text(media.content_type), size_bytes: Number(media.size_bytes || 0) || 0,
      variant: 'original', uploaded_at: first(stored.uploaded_at, media.created_at), updated_at: first(media.updated_at, media.created_at), metadata: stored,
      type: type.type, type_label: type.label, icon: type.icon, color: type.color, url: '', special: false, required: false, interactive: true, markup: {}
    };
  }
  const documentsUrl = (ctx) => path(ctx.org, '/projects/' + encodeURIComponent(ctx.params.project) + '/documents');

  const checklistsUrl = (ctx) => '/v1/workforce/organizations/' + encodeURIComponent(ctx.org) + '/crew/projects/' + encodeURIComponent(ctx.params.project) + '/checklists';
  const evidenceKind = (type) => (type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'document');
  /** What the evidence route stores on the item (workforce/crew_api.ts, crew_storage.ts: addProjectChecklistItemAttachment). */
  function evidenceOf(ctx, found) {
    const type = text(found.file.type || 'application/octet-stream').toLowerCase();
    return { media_id: found.id, file_name: cleanName(found.file.name), content_type: type, size_bytes: found.file.size, kind: evidenceKind(type), requirement_id: text(found.body.requirement_id) };
  }
  const withEvidence = (item, attachment, ctx) => {
    const metadata = obj(obj(item).metadata);
    const stored = Object.assign({}, attachment, { attached_by_user_id: ctx.user, attached_at: iso(ctx.now) });
    return Object.assign({}, item, { metadata: Object.assign({}, metadata, { attachments: list(metadata.attachments).filter((entry) => text(obj(entry).media_id) !== attachment.media_id).concat([stored]) }), updated_at: iso(ctx.now) });
  };
  async function evidenceMedia(ctx, found) {
    const attachment = evidenceOf(ctx, found);
    const visual = attachment.kind === 'photo' || attachment.kind === 'video';
    return mediaRecord(ctx, {
      id: found.id, file: found.file, ownerType: 'project', slot: visual ? 'photos' : 'checklist_evidence', project: ctx.params.project, contact: '',
      metadata: { source: 'checklist_evidence', field: visual ? 'photos' : 'checklist_evidence', document_collection: 'projects', document_id: ctx.params.project, project_id: ctx.params.project, checklist_id: ctx.params.checklist, checklist_item_id: ctx.params.item, requirement_id: attachment.requirement_id, media_type: attachment.kind },
      body: { scope: 'projects' }
    });
  }

  FMOffline.contracts.add({
    id: 'media',

    // A pinned project: its photo list and media records, and the thumbnail its grid shows for each.
    prefetch: [
      // The files of each of its contacts, as the contact window lists them.
      {
        url: (ctx) => path(ctx.org, '/projects/' + encodeURIComponent(ctx.project)),
        each: (json, ctx) => list(obj(documentOf(json).data).contacts).map((entry) => text(obj(entry).contact_id || obj(entry).id)).filter(Boolean).map((id) => path(ctx.org, '/media?contact_id=' + encodeURIComponent(id)))
      },
      {
        url: (ctx) => path(ctx.org, '/projects/' + encodeURIComponent(ctx.project)),
        each: (json, ctx) => list(obj(documentOf(json).data).photos).map(obj).filter((photo) => text(photo.media_id) && !/^video/i.test(text(photo.media_type || photo.mime_type || photo.content_type)))
          .map((photo) => path(ctx.org, '/media/' + encodeURIComponent(photo.media_id) + '/file?variant=' + (Array.isArray(photo.variants) && !photo.variants.includes('thumb_320') ? 'original' : 'thumb_320')))
      },
      {
        url: (ctx) => path(ctx.org, '/media?project_id=' + encodeURIComponent(ctx.project)),
        each: (json, ctx) => list(obj(json).media).map(obj).filter((media) => text(media.id) && media.kind === 'image')
          .map((media) => path(ctx.org, '/media/' + encodeURIComponent(media.id) + '/file?variant=' + (obj(media.variants).thumb_320 ? 'thumb_320' : 'original')))
      }
    ],

    writes: [
      {
        id: 'media.upload',
        match: 'POST ' + ORG + '/media',
        when: (ctx) => !!uploadOf(ctx),
        kind: 'upload',
        scope: (ctx) => { const upload = uploadOf(ctx); return upload.project ? 'project:' + upload.project : upload.contact ? 'contact:' + upload.contact : 'user:' + ctx.user; },
        label: (ctx) => {
          const upload = uploadOf(ctx);
          const type = text(upload.file.type).toLowerCase();
          if (upload.contact && upload.slot === 'profile') return FMOffline.label('sync_contact_picture', 'Contact picture', '');
          if (upload.contact && !/^(image|video)\//.test(type)) return FMOffline.label('sync_contact_file', 'Contact file', text(upload.file.name));
          const video = type.startsWith('video/');
          return { key: video ? 'sync_video_new' : 'sync_photo_new', title: video ? 'Video' : 'Photo', detail: text(upload.file.name) };
        },
        records: (ctx) => [uploadOf(ctx).id],
        media: (ctx) => { const upload = uploadOf(ctx); return [{ id: upload.id, field: upload.field }]; },
        respond: async (ctx) => ({ ok: true, media: await mediaRecord(ctx, uploadOf(ctx)) }),
        effects: (ctx) => {
          const record = obj(obj(ctx.response).media);
          if (!record.id) return [];
          return [
            // The record's own read, which the server cannot answer yet: what a rename or a tag made meanwhile starts from.
            { match: 'GET ' + ORG + '/media/:media', when: (m) => m.org === ctx.org && m.media === record.id, seed: () => ({ ok: true, media: record }) },
            { match: 'GET ' + ORG + '/media', when: (m, read) => m.org === ctx.org && listShows(read, record), apply: (json) => (Array.isArray(obj(json).media) ? Object.assign({}, json, { media: upsertById(json.media, record) }) : json) },
            // The Photos Feed reads one catalog: project media in `media`, photos with no project in `unassigned_media`.
            { match: 'GET /v1/channels/organizations/:org/feed/catalog', when: (m) => m.org === ctx.org, apply: (json) => {
              const key = isUnassigned(record) ? 'unassigned_media' : 'media';
              return Array.isArray(obj(json)[key]) ? Object.assign({}, json, { [key]: upsertById(json[key], record, true) }) : json;
            } }
          ];
        }
      },

      {
        id: 'photos.save',
        match: 'POST ' + ORG + '/projects/:project/photos',
        when: (ctx) => Array.isArray(obj(ctx.body).photos),
        // A `patch`: when it is sent, the list is merged photo by photo with the server's list as it is then, so
        // what someone else did to another photo meanwhile is kept and a photo is removed only when this change
        // removed it.
        kind: 'patch',
        scope: (ctx) => 'project:' + ctx.params.project,
        label: (ctx) => (list(ctx.body.remove).length ? FMOffline.label('sync_project_photos_removed', 'Photos removed from the project', '') : FMOffline.label('sync_project_photos', 'Project photos', '')),
        // To a person one photo is one change: a save that only adds photos whose uploads wait here is not counted
        // or listed beside them (it still shows when it is the only thing waiting, fails or conflicts).
        quiet: async (ctx) => {
          if (list(ctx.body.remove).length) return false;
          const saved = await ctx.saved(projectUrl(ctx));
          const known = new Set(list(obj(documentOf(saved).data).photos).map(photoId));
          const added = list(ctx.body.photos).filter((photo) => text(obj(photo).media_id)).map(photoId).filter((id) => id && !known.has(id));
          if (!added.length) return false;
          for (const id of added) if (!(await ctx.queued(id)).some((entry) => entry.kind === 'upload')) return false;
          return true;
        },
        // The photos this save adds or removes: what an app asks about with isPending.
        records: async (ctx) => {
          const saved = await ctx.saved(projectUrl(ctx));
          const known = new Set(list(obj(documentOf(saved).data).photos).map(photoId));
          // (Only library photos: the generated satellite stand-in in a list is not a record anyone waits for.)
          return [...new Set(list(ctx.body.photos).filter((photo) => text(obj(photo).media_id)).map(photoId).filter((id) => id && !known.has(id)).concat(list(ctx.body.remove).map(text).filter(Boolean)))];
        },
        respond: async (ctx) => {
          const saved = await ctx.saved(projectUrl(ctx));
          const document = documentOf(saved);
          const data = obj(document.data);
          const photos = applyList(data.photos, ctx.body.photos, ctx.body.remove);
          return {
            ok: true, project_id: ctx.params.project, photos,
            thumbnail_photo_id: text(data.thumbnail_photo_id), thumbnail_photo: data.thumbnail_photo == null ? null : data.thumbnail_photo,
            project_revision: Number(document.revision || 0),
            document: Object.assign({ id: ctx.params.project }, document, { data: Object.assign({}, data, { photos }) })
          };
        },
        effects: (ctx) => projectPhotoEffects(ctx.org, ctx.params.project, (photos) => applyList(photos, ctx.body.photos, ctx.body.remove)),
        conflict: {
          current: (ctx) => projectUrl(ctx),
          pick: (json) => { const document = documentOf(json); return { doc: { photos: withIds(obj(document.data).photos) }, revision: document.revision }; },
          fields: () => ['photos'],
          mine: (ctx, base) => ({ photos: withIds(applyList(base ? base.photos : [], ctx.body.photos, ctx.body.remove)) }),
          // The merged list, and of the photos this change removed only those the merge agreed to drop.
          send: (ctx, merged) => { const kept = new Set(list(merged.photos).map(photoId)); return { photos: list(merged.photos), remove: list(ctx.body.remove).map(text).filter((id) => id && !kept.has(id)) }; }
        }
      },

      {
        // A file added to a project's documents list. The route stores the file and writes the list in one
        // request; the whole-project save the Docs tab makes afterwards is the project's own contract.
        id: 'documents.upload',
        match: 'POST ' + ORG + '/projects/:project/documents',
        when: (ctx) => !!namedFile(ctx, 'id'),
        kind: 'upload',
        scope: (ctx) => 'project:' + ctx.params.project,
        label: (ctx) => FMOffline.label('sync_project_document', 'Project document', text(namedFile(ctx, 'id').file.name)),
        records: (ctx) => [namedFile(ctx, 'id').id],
        media: (ctx) => { const found = namedFile(ctx, 'id'); return [{ id: found.id, field: found.field }]; },
        respond: async (ctx) => {
          const found = namedFile(ctx, 'id');
          const media = await documentMedia(ctx, found);
          const document = documentReference(media, obj(parse(found.body.metadata, {})));
          const saved = obj(await ctx.saved(documentsUrl(ctx)));
          const project = documentOf(await ctx.saved(projectUrl(ctx)));
          const before = Array.isArray(saved.uploaded_documents) ? saved.uploaded_documents : list(obj(project.data).documents);
          return {
            ok: true, document, media, project_id: ctx.params.project,
            documents: upsertById(Array.isArray(saved.documents) ? saved.documents : before, document),
            special_documents: list(saved.special_documents), uploaded_documents: upsertById(before, document)
          };
        },
        effects: (ctx) => {
          const answer = obj(ctx.response);
          const document = obj(answer.document);
          const record = obj(answer.media);
          if (!document.id || !record.id) return [];
          const project = ctx.params.project;
          const inProject = (item) => { const data = obj(obj(item).data); return Object.assign({}, item, { data: Object.assign({}, data, { documents: upsertById(data.documents, document) }) }); };
          return recordEffects(ctx, record).concat([
            { match: 'GET ' + ORG + '/projects/:project/documents', when: (m) => m.org === ctx.org && m.project === project, apply: (json) => {
              const next = Object.assign({}, json);
              for (const key of ['documents', 'uploaded_documents']) if (Array.isArray(obj(json)[key])) next[key] = upsertById(json[key], document);
              return next;
            } },
            { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.org === ctx.org && m.project === project, apply: (json) => (obj(json).document ? Object.assign({}, json, { document: inProject(json.document) }) : json) },
            { match: 'GET ' + ORG + '/projects', when: (m) => m.org === ctx.org, apply: (json) => (Array.isArray(obj(json).documents) ? Object.assign({}, json, { documents: json.documents.map((item) => (text(obj(item).id) === project ? inProject(item) : item)) }) : json) }
          ]);
        }
      },

      {
        // A photo or file added to a checklist item. The route stores the file and puts it on the item in one
        // request. Completing the item is not queued (see the doc).
        id: 'checklist.evidence',
        match: 'POST ' + WORKFORCE + '/crew/projects/:project/checklists/:checklist/items/:item/attachments',
        when: (ctx) => !!namedFile(ctx, 'media_id'),
        kind: 'upload',
        scope: (ctx) => 'project:' + ctx.params.project,
        label: (ctx) => {
          const found = namedFile(ctx, 'media_id');
          return evidenceOf(ctx, found).kind === 'photo' ? FMOffline.label('sync_checklist_photo', 'Checklist photo', text(found.file.name)) : FMOffline.label('sync_checklist_file', 'Checklist file', text(found.file.name));
        },
        records: (ctx) => [namedFile(ctx, 'media_id').id],
        media: (ctx) => { const found = namedFile(ctx, 'media_id'); return [{ id: found.id, field: found.field }]; },
        respond: async (ctx) => {
          const found = namedFile(ctx, 'media_id');
          const attachment = evidenceOf(ctx, found);
          const lists = list(obj(await ctx.saved(checklistsUrl(ctx))).checklists);
          const item = lists.flatMap((checklist) => list(obj(checklist).items)).find((entry) => text(obj(entry).id) === ctx.params.item) || { id: ctx.params.item, checklist_id: ctx.params.checklist, project_id: ctx.params.project, metadata: {} };
          return { ok: true, attachment, item: withEvidence(item, attachment, ctx) };
        },
        effects: async (ctx) => {
          const found = namedFile(ctx, 'media_id');
          const attachment = obj(obj(ctx.response).attachment);
          if (!found || !attachment.media_id) return [];
          const record = await evidenceMedia(ctx, found);
          return recordEffects(ctx, record).concat([
            { match: 'GET ' + WORKFORCE + '/crew/projects/:project/checklists', when: (m) => m.org === ctx.org && m.project === ctx.params.project, apply: (json) => {
              if (!Array.isArray(obj(json).checklists)) return json;
              return Object.assign({}, json, { checklists: json.checklists.map((checklist) => (Array.isArray(obj(checklist).items) ? Object.assign({}, checklist, { items: checklist.items.map((item) => (text(obj(item).id) === ctx.params.item ? withEvidence(item, attachment, ctx) : item)) }) : checklist)) });
            } }
          ]);
        }
      },

      {
        id: 'media.update',
        match: 'PATCH ' + ORG + '/media/:media',
        when: (ctx) => { const change = editOf(ctx); return change.name !== undefined || change.tags !== undefined; },
        // A `patch`: the route replaces the whole name or tag list and has no revision, so when it is sent the name
        // and each tag are merged with the record as the server has it then.
        kind: 'patch',
        // One photo's edits in order. A photo whose upload still waits is named in the URL, so the engine sends
        // this after that upload (`after`), whatever scope the upload is in.
        scope: (ctx) => 'media:' + ctx.params.media,
        label: (ctx) => {
          const change = editOf(ctx);
          return change.name !== undefined ? FMOffline.label('sync_photo_renamed', 'Photo renamed', change.name) : FMOffline.label('sync_photo_tagged', 'Photo tags', change.tags.map((tag) => '#' + tag).join(' '));
        },
        records: (ctx) => [ctx.params.media],
        // The whole record with the change, as the route answers. A record this device never read is answered
        // with what the change itself says (the apps read the name and the tags from it).
        respond: async (ctx) => ({ ok: true, media: editedRecord((await knownMedia(ctx, ctx.params.media)) || { id: ctx.params.media, organization_id: ctx.org, metadata: {} }, editOf(ctx), iso(ctx.now)) }),
        effects: (ctx) => { const change = editOf(ctx); const now = iso(ctx.now); return mediaRecordEffects(ctx.org, ctx.params.media, (record) => editedRecord(record, change, now)); },
        conflict: {
          current: (ctx) => path(ctx.org, '/media/' + encodeURIComponent(ctx.params.media)),
          pick: (json) => { const media = obj(obj(json).media); return { doc: mergeDoc(media), revision: text(media.updated_at) }; },
          // The record as the lists show it, where its own read was never saved.
          base: async (ctx) => { const media = await knownMedia(ctx, ctx.params.media); return media ? { doc: mergeDoc(media), revision: text(media.updated_at) } : null; },
          fields: (ctx) => Object.keys(editOf(ctx)),
          mine: (ctx, base) => { const change = editOf(ctx); return Object.assign({}, base || {}, change.name !== undefined ? { name: change.name } : {}, change.tags !== undefined ? { tags: tagSet(change.tags) } : {}); },
          send: (ctx, merged) => Object.assign({}, merged.name != null ? { name: merged.name } : {}, merged.tags != null ? { tags: Object.keys(obj(merged.tags)) } : {})
        }
      },

      {
        id: 'media.assign',
        match: 'POST ' + ORG + '/media/assign',
        when: (ctx) => !!text(obj(ctx.body).project_id) && list(obj(ctx.body).media_ids).length > 0,
        // The route is safe to repeat (a photo already in the project is reported, not refused), so it is replayed as sent.
        kind: 'action',
        // Behind this person's own waiting photos, which are what the phone camera pairs.
        scope: (ctx) => 'user:' + ctx.user,
        label: () => (FMOffline.label('sync_photo_assign', 'Photos added to a project', '')),
        records: (ctx) => list(ctx.body.media_ids).map(text).filter(Boolean),
        respond: async (ctx) => {
          const project = text(ctx.body.project_id);
          const ids = [...new Set(list(ctx.body.media_ids).map(text).filter(Boolean))];
          const known = new Map();
          for (const url of [path(ctx.org, '/media?unassigned=true'), path(ctx.org, '/media')]) for (const item of list(obj(await ctx.saved(url)).media)) if (!known.has(text(obj(item).id))) known.set(text(obj(item).id), obj(item));
          for (const item of list(obj(await ctx.saved('/v1/channels/organizations/' + encodeURIComponent(ctx.org) + '/feed/catalog')).unassigned_media)) if (!known.has(text(obj(item).id))) known.set(text(obj(item).id), obj(item));
          const now = iso(ctx.now);
          const media = ids.map((id) => {
            const item = known.get(id) || { id, metadata: {} };
            const metadata = Object.assign({}, obj(item.metadata), { project_id: project, field: 'photos', document_collection: 'projects', document_id: project, paired_from: 'organization', paired_at: now, paired_by_user_id: ctx.user });
            return Object.assign({}, item, { owner: Object.assign({}, obj(item.owner), { type: 'project', id: project, slot: text(obj(item.owner).slot) || 'photos' }), metadata, updated_at: now });
          });
          const saved = documentOf(await ctx.saved(path(ctx.org, '/projects/' + encodeURIComponent(project))));
          const stored = list(obj(saved.data).photos);
          const present = new Set(stored.map((photo) => text(obj(photo).media_id || obj(photo).id)));
          return {
            ok: true, project_id: project, media, assigned: ids, already_assigned: [],
            photos: stored.concat(media.filter((item) => !present.has(item.id)).map((item) => photoReference(item, project))),
            thumbnail_photo_id: text(obj(saved.data).thumbnail_photo_id), project_revision: Number(saved.revision || 0)
          };
        },
        effects: (ctx) => {
          const answer = obj(ctx.response);
          const project = text(answer.project_id);
          const moved = new Map(list(answer.media).map((item) => [text(obj(item).id), obj(item)]));
          if (!project || !moved.size) return [];
          const references = [...moved.values()].map((item) => photoReference(item, project));
          return [
            { match: 'GET ' + ORG + '/media', when: (m, read) => m.org === ctx.org && !text(obj(read.query).contact_id), apply: (json) => {
              if (!Array.isArray(obj(json).media)) return json;
              return Object.assign({}, json, { media: json.media.map((item) => moved.get(text(obj(item).id)) || item) });
            } },
            { match: 'GET ' + ORG + '/media', when: (m, read) => m.org === ctx.org && truthy(obj(read.query).unassigned), apply: (json) => (Array.isArray(obj(json).media) ? Object.assign({}, json, { media: json.media.filter((item) => !moved.has(text(obj(item).id))) }) : json) },
            { match: 'GET /v1/channels/organizations/:org/feed/catalog', when: (m) => m.org === ctx.org, apply: (json) => {
              const catalog = obj(json);
              if (!Array.isArray(catalog.unassigned_media)) return json;
              return Object.assign({}, json, {
                unassigned_media: catalog.unassigned_media.filter((item) => !moved.has(text(obj(item).id))),
                media: Array.isArray(catalog.media) ? [...moved.values()].concat(catalog.media.filter((item) => !moved.has(text(obj(item).id)))) : catalog.media
              });
            } }
          ].concat(projectPhotoEffects(ctx.org, project, (photos) => { const present = new Set(photos.map((photo) => text(obj(photo).media_id || obj(photo).id))); return photos.concat(references.filter((reference) => !present.has(reference.id))); }));
        }
      }
    ]
  });
})();
