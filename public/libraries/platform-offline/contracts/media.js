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
    // Only a project's photos and photos with no project yet: other uploads are followed by writes of their own
    // app (a note, a contact, a document) that would have to wait behind them.
    if (slot !== 'photos' || (ownerType !== 'project' && ownerType !== 'organization')) return null;
    const metadata = obj(parse(body.metadata, {}));
    const project = ownerType === 'project' ? cleanId(body.owner_id || body.ownerId) : '';
    if (ownerType === 'project' && !project) return null;
    return { id, field, file: body[field], ownerType, slot, project, metadata, body };
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
    const { id, file, ownerType, slot, project, body } = upload;
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
      owner: { type: ownerType, id: project || cleanId(ctx.org), slot },
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
    if (text(query.contact_id) || text(query.tags) || text(query.tag)) return false;
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

  FMOffline.contracts.add({
    id: 'media',

    // A pinned project: its photo list and media records, and the thumbnail its grid shows for each.
    prefetch: [
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
        scope: (ctx) => { const upload = uploadOf(ctx); return upload.project ? 'project:' + upload.project : 'user:' + ctx.user; },
        label: (ctx) => { const upload = uploadOf(ctx); const video = /^video\//i.test(upload.file.type || ''); return { key: video ? 'sync_video_new' : 'sync_photo_new', title: video ? 'Video' : 'Photo', detail: text(upload.file.name) }; },
        records: (ctx) => [uploadOf(ctx).id],
        media: (ctx) => { const upload = uploadOf(ctx); return [{ id: upload.id, field: upload.field }]; },
        respond: async (ctx) => ({ ok: true, media: await mediaRecord(ctx, uploadOf(ctx)) }),
        effects: (ctx) => {
          const record = obj(obj(ctx.response).media);
          if (!record.id) return [];
          return [
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
        label: (ctx) => (list(ctx.body.remove).length ? { key: 'sync_project_photos_removed', title: 'Photos removed from the project', detail: '' } : { key: 'sync_project_photos', title: 'Project photos', detail: '' }),
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
        id: 'media.assign',
        match: 'POST ' + ORG + '/media/assign',
        when: (ctx) => !!text(obj(ctx.body).project_id) && list(obj(ctx.body).media_ids).length > 0,
        // The route is safe to repeat (a photo already in the project is reported, not refused), so it is replayed as sent.
        kind: 'action',
        // Behind this person's own waiting photos, which are what the phone camera pairs.
        scope: (ctx) => 'user:' + ctx.user,
        label: () => ({ key: 'sync_photo_assign', title: 'Photos added to a project', detail: '' }),
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
