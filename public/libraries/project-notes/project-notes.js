/* Shared project-note model and visibility rules.
 *
 * Same public API as the original project-document model, now backed by the
 * channels backend (/v1/channels): each project has a message thread, so notes
 * get server-enforced authorship, edit history, soft delete with restore, and
 * threaded replies — while every existing note surface keeps its exact UI.
 *
 * Mutations are optimistic against a per-project cache and settle through
 * ChannelsAPI; `flush(project)` awaits pending writes. Realtime updates arrive
 * via PlatformRealtime and re-announce through `fm:project-notes:refreshed`.
 */
(function(){
  if (window.Portal?.ProjectNotes) return;
  window.Portal = window.Portal || {};

  const GROUPS = ['office', 'crew', 'sales'];
  const TYPE_TAGS = {
    call_note:{ key:'call_note', label:(globalThis.PlatformLanguage?.text("project-notes","m_5bef95cb2a0d72","Call note") ?? "Call note"), icon:'fa-phone', tone:'call' }
  };
  const clean = (value) => String(value ?? '').trim();
  const unique = (values) => [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
  const id = () => `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const actor = () => {
    const app = window.__APP || {};
    const user = window.Portal?.currentUser || {};
    return {
      id: clean(app.userId || app.user_id || user.id || user.user_id),
      name: clean(app.userName || user.user?.name || user.identity?.name || app.userEmail),
      email: clean(app.userEmail || user.user?.email || user.identity?.email).toLowerCase()
    };
  };
  const actorKeys = (value = actor()) => unique([value.id, value.email, value.name].map((item) => clean(item).toLowerCase()));
  const currentGroups = () => {
    const user = window.Portal?.currentUser || {};
    const roles = unique([user.role, ...(user.roleIds || []), ...(user.roles || [])]).join(' ').toLowerCase();
    const groups = [];
    const sales = /sales|estim|business.develop|account.executive/.test(roles);
    const crew = /crew|field|installer|technician|foreman|production/.test(roles) || user.applicationAccess?.field?.enabled === true;
    if (sales) groups.push('sales');
    if (crew) groups.push('crew');
    if (/office|admin|manager|owner|dispatch|coordinator/.test(roles) || (!sales && !crew && user.applicationAccess?.management?.enabled === true)) groups.push('office');
    return unique(groups.length ? groups : ['office']);
  };
  const mentionsFromText = (text) => unique((clean(text).match(/@[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|@[\w.-]+/g) || []).map((token) => token.slice(1).toLowerCase()));
  const normalizeMentionUser = (value = {}) => ({
    id:clean(value.id || value.user_id || value.identity_id || value.email),
    name:clean(value.name || value.label || value.email || value.id),
    email:clean(value.email || value.user_email).toLowerCase(),
    avatar:clean(value.avatar || value.avatar_url || value.photo_url || value.profile_photo_url || value.image_url || value.picture)
  });
  const normalizeVisibility = (value) => {
    if (value === 'everybody' || value?.everybody === true) return [...GROUPS];
    const source = Array.isArray(value) ? value : (Array.isArray(value?.groups) ? value.groups : GROUPS);
    return unique(source.map((group) => clean(group).toLowerCase())).filter((group) => GROUPS.includes(group));
  };
  const normalizeTypeTags = (value) => unique(Array.isArray(value) ? value : []).map((tag) => tag.toLowerCase().replace(/[^a-z0-9_-]+/g, '_'));
  const typeTag = (value) => {
    const key = clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
    return TYPE_TAGS[key] || { key, label:key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), icon:'fa-tag', tone:'default' };
  };
  const typeTags = (note = {}) => normalizeTypeTags(note.type_tags).map(typeTag).filter((tag) => tag.key);
  const escapeHtml = (value) => clean(value).replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  const renderTypeTags = (note = {}) => {
    const tags = typeTags(note);
    if (!tags.length) return '';
    return `<span class="fm-note-type-tags">${tags.map((tag) => `<span class="fm-note-type-tag fm-note-type-tag--${escapeHtml(tag.tone)}"><i class="fas ${escapeHtml(tag.icon)}" aria-hidden="true"></i>${escapeHtml(tag.label)}</span>`).join('')}</span>`;
  };
  const ensureTypeTagStyles = () => {
    if (typeof document === 'undefined' || document.getElementById('fm-project-note-type-tags')) return;
    const style = document.createElement('style');
    style.id = 'fm-project-note-type-tags';
    style.textContent = '.fm-note-card-with-types{position:relative;z-index:1;overflow:visible!important;margin-top:10px;padding-top:14px!important}.fm-note-type-tags{position:absolute;z-index:5;top:-9px;left:9px;display:flex;flex-wrap:wrap;gap:4px;pointer-events:none}.fm-note-type-tag{display:inline-flex;align-items:center;gap:4px;min-height:18px;box-sizing:border-box;padding:2px 7px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;box-shadow:0 1px 2px rgba(15,23,42,.08);font-size:8px;font-weight:950;line-height:1;letter-spacing:.03em;text-transform:uppercase}.fm-note-type-tag--call{border-color:#b2ccff;background:#eff4ff;color:#175cd3}.fm-note-type-tag i{font-size:8px}'
      /* Additions for channels-backed extras: keep them quiet — they live inside the existing card design. */
      + '.pn-edited{border:0;background:none;padding:0;margin:0;font:inherit;color:#98a2b3;cursor:pointer;text-decoration:none}.pn-edited:hover{color:#475467;text-decoration:underline}'
      + '.pn-removed{opacity:.75}.pn-removed-copy{display:flex;align-items:center;gap:7px;margin:0;color:#98a2b3;font-size:11px;font-weight:700;font-style:italic}.pn-removed-copy i{font-size:10px}'
      + '.pn-restore{border:0;background:none;padding:0;font:inherit;font-size:11px;font-weight:800;font-style:normal;color:#98a2b3;cursor:pointer;text-decoration:underline}.pn-restore:hover{color:var(--primary-readable,var(--primary,#d93025))}'
      + '.pn-replies-toggle{border:0;background:none;padding:0;font:inherit;font-size:10px;font-weight:900;color:#667085;cursor:pointer;display:inline-flex;align-items:center;gap:4px}.pn-replies-toggle:hover{color:var(--primary-readable,var(--primary,#d93025))}.pn-replies-toggle i{font-size:9px}'
      + '.pn-reply-new{opacity:0;transition:opacity .15s ease}article:hover .pn-reply-new,.pn-reply-new:focus-visible{opacity:1}'
      + '.pn-replies-wrap{margin-top:7px;padding:7px 0 1px 9px;border-left:2px solid #eef1f5;display:flex;flex-direction:column;gap:6px}'
      + '.pn-reply-card{font-size:11.5px;line-height:1.45;color:#344054}.pn-reply-card p{margin:0;word-break:break-word}.pn-reply-meta{color:#98a2b3;font-size:10px;font-weight:700;margin-top:1px}'
      + '.pn-reply-compose{display:flex;gap:6px;align-items:center}.pn-reply-compose input{flex:1;min-width:0;border:1px solid #e4e7ec;border-radius:8px;padding:5px 9px;font:inherit;font-size:11.5px;outline:none;background:#fff}.pn-reply-compose input:focus{border-color:var(--primary-readable,var(--primary,#d93025))}'
      + '.pn-reply-compose button{border:0;background:none;color:#667085;cursor:pointer;font-size:12px;padding:4px 6px;border-radius:7px}.pn-reply-compose button:hover{color:var(--primary-readable,var(--primary,#d93025));background:#f7f8fa}'
      + '.pn-history-pop{position:fixed;z-index:2147483600;min-width:220px;max-width:320px;max-height:280px;overflow-y:auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 12px 34px rgba(15,23,42,.16);padding:4px 0}'
      + '.pn-history-pop-head{padding:7px 12px 5px;color:#667085;font-size:9.5px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid #f0f2f5}'
      + '.pn-history-item{padding:7px 12px;border-bottom:1px solid #f0f2f5}.pn-history-item:last-child{border-bottom:0}'
      + '.pn-history-item .when{color:#98a2b3;font-size:10px;font-weight:800;margin-bottom:2px}.pn-history-item.current .when{color:var(--primary-readable,var(--primary,#d93025))}'
      + '.pn-translate{position:absolute;z-index:7;top:5px;right:5px;width:22px;height:22px;border:0;border-radius:6px;background:rgba(255,255,255,.88);color:#98a2b3;display:grid;place-items:center;cursor:pointer;font-size:9px;box-shadow:0 0 0 1px rgba(15,23,42,.06)}.pn-translate:hover,.pn-translate.on{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}.pn-translate.loading i{animation:pnTranslateSpin .75s linear infinite}@keyframes pnTranslateSpin{to{transform:rotate(360deg)}}.pn-translated-note{display:block;margin-top:3px;color:#98a2b3;font-size:8.5px;font-weight:750}'
      + '.pn-history-item .text{color:#344054;font-size:11.5px;line-height:1.45;word-break:break-word}'
      + '.pn-media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,180px));gap:7px;margin-top:8px}.pn-media-item{display:block;overflow:hidden;border:1px solid #e4e7ec;border-radius:9px;background:#f8fafc}.pn-media-item img,.pn-media-item video{display:block;width:100%;max-height:180px;object-fit:cover}.pn-file-item{display:flex;align-items:center;gap:7px;margin-top:8px;padding:8px 10px;border:1px solid #e4e7ec;border-radius:9px;color:#475467;text-decoration:none;font-size:11px;font-weight:750}.pn-file-item:hover{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}'
      + '.pn-pending-upload{display:flex;align-items:center;gap:8px;margin-top:7px;padding:7px 9px;border:1px solid #e4e7ec;border-radius:9px;background:#f8fafc;color:#475467;font-size:11px;font-weight:750}.pn-pending-upload img,.pn-pending-upload video{width:42px;height:34px;object-fit:cover;border-radius:6px}.pn-pending-upload span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pn-pending-upload button{border:0;background:none;color:#98a2b3;cursor:pointer}';
    document.head?.appendChild(style);
  };
  const normalize = (note, index = 0) => {
    if (typeof note === 'string') note = { text: note };
    note = note && typeof note === 'object' ? note : {};
    const createdBy = note.created_by && typeof note.created_by === 'object' ? note.created_by : {};
    const mentionUsers = (Array.isArray(note.mention_users) ? note.mention_users : (Array.isArray(note.mentions) ? note.mentions : []))
      .map(normalizeMentionUser)
      .filter((user) => user.id || user.email || user.name);
    const taggedPeople = unique([
      ...(Array.isArray(note.tagged_people) ? note.tagged_people : []),
      ...mentionsFromText(note.text || note.body || note.note),
      ...mentionUsers.flatMap((user) => [user.id, user.email, user.name])
    ].map((item) => clean(item).toLowerCase()));
    return {
      ...note,
      id: clean(note.id) || `legacy_note_${index}`,
      text: clean(note.text || note.body || note.note),
      created_at: clean(note.created_at) || new Date(0).toISOString(),
      updated_at: clean(note.updated_at || note.created_at) || new Date(0).toISOString(),
      created_by: { id:clean(createdBy.id || note.created_by_id), name:clean(createdBy.name || note.created_by_name || 'Unknown'), email:clean(createdBy.email || note.created_by_email).toLowerCase() },
      tagged_people: taggedPeople,
      mention_users: mentionUsers,
      attachments: Array.isArray(note.attachments) ? note.attachments : [],
      metadata: note.metadata && typeof note.metadata === 'object' ? note.metadata : {},
      language_code: clean(note.language_code || 'und'),
      language_confidence: Number(note.language_confidence) || 0,
      translation: note.translation && typeof note.translation === 'object' ? { ...note.translation } : { available:false },
      type_tags: normalizeTypeTags(note.type_tags),
      visibility: normalizeVisibility(note.visibility)
    };
  };

  // --- channels-backed store ------------------------------------------------

  const stores = new Map(); // projectId -> { channelId, notes, loaded, loading, lastOp, unsubscribe }
  const orgId = () => clean(window.__APP?.userOrgId || window.__APP?.orgId || window.Portal?.currentUser?.orgId);
  const channels = () => window.ChannelsAPI || null;

  function noteFromMessage(message = {}){
    const audience = Array.isArray(message.audience) ? message.audience : [];
    return normalize({
      id: message.id,
      text: message.text,
      created_at: message.created_at,
      updated_at: message.edited_at || message.created_at,
      created_by: { id: message.author?.id, name: message.author?.name, email: message.author?.email },
      mention_users: message.mention_users || [],
      type_tags: message.tags || [],
      visibility: audience.length ? audience : GROUPS,
      edited_at: clean(message.edited_at),
      deleted_at: clean(message.deleted_at),
      can_edit: message.can_edit === true,
      can_delete: message.can_delete === true,
      can_restore: message.can_restore === true,
      reply_count: Number(message.reply_count) || 0,
      attachments: message.attachments || [],
      metadata: message.metadata || {},
      language_code: message.language_code,
      language_confidence: message.language_confidence,
      translation: message.translation,
      seq: Number(message.seq) || 0
    });
  }

  function storeFor(projectValue){
    const projectId = clean(typeof projectValue === 'object' ? projectValue?.id : projectValue);
    if (!projectId) return null;
    let entry = stores.get(projectId);
    if (!entry) {
      entry = { projectId, channelId:'', notes:[], loaded:false, loading:null, lastOp:Promise.resolve(), unsubscribe:null, refreshTimer:0 };
      stores.set(projectId, entry);
    }
    return entry;
  }

  function announce(projectId){
    try {
      window.dispatchEvent(new CustomEvent('fm:project-notes:refreshed', { detail:{ projectId } }));
    } catch (error) {}
  }

  function subscribeRealtime(entry){
    if (entry.unsubscribe || !window.PlatformRealtime?.subscribe || !orgId()) return;
    entry.unsubscribe = window.PlatformRealtime.subscribe(orgId(), 'channels.', (event) => {
      const channelId = clean(event?.payload?.channel_id);
      if (!channelId || channelId !== entry.channelId) return;
      window.clearTimeout(entry.refreshTimer);
      entry.refreshTimer = window.setTimeout(() => {
        refreshEntry(entry).then(() => announce(entry.projectId)).catch(() => {});
      }, 400);
    });
  }

  async function ensureChannel(entry){
    if (entry.channelId) return entry.channelId;
    const api = channels();
    const oid = orgId();
    if (!api || !oid) throw new Error('Channels API unavailable');
    const ensured = await api.channels.ensureProject(oid, entry.projectId);
    entry.channelId = clean(ensured.channel?.id);
    subscribeRealtime(entry);
    return entry.channelId;
  }

  async function refreshEntry(entry){
    const api = channels();
    const oid = orgId();
    if (!api || !oid) return entry;
    await ensureChannel(entry);
    const data = await api.messages.list(oid, entry.channelId, { limit: 200 });
    entry.notes = (data.messages || [])
      .filter((message) => message.kind !== 'system')
      .map(noteFromMessage);
    entry.loaded = true;
    return entry;
  }

  function load(project, options = {}){
    const entry = storeFor(project);
    if (!entry) return Promise.resolve(null);
    if (entry.loading) return entry.loading;
    if (entry.loaded && !options.force) return Promise.resolve(entry);
    entry.loading = refreshEntry(entry)
      .then((result) => { entry.loading = null; announce(entry.projectId); return result; })
      .catch(() => { entry.loading = null; return entry; });
    return entry.loading;
  }

  function track(entry, work){
    const promise = (async () => work())();
    entry.lastOp = entry.lastOp.then(() => promise).catch(() => {});
    promise.catch(() => {});
    return promise;
  }

  function flush(project){
    const entry = storeFor(project);
    return entry ? entry.lastOp : Promise.resolve();
  }

  function audienceFromVisibility(visibility){
    const groups = normalizeVisibility(visibility);
    return groups.length >= GROUPS.length ? [] : groups;
  }

  // --- original read API ------------------------------------------------------

  const all = (project = {}) => {
    const entry = project?.id ? stores.get(clean(project.id)) : null;
    const notes = (entry?.notes || []).filter((note) => (note.text || note.attachments?.length) && !note.deleted_at);
    const legacy = typeof project.project_notes === 'string' ? clean(project.project_notes) : '';
    if (legacy && !notes.some((note) => note.id === 'legacy_internal_note')) notes.unshift(normalize({ id:'legacy_internal_note', text:legacy, created_at:project.created_at || project.updated_at, created_by:{ name:'Legacy internal note' }, visibility:GROUPS }, -1));
    return notes;
  };
  /** Active notes plus removed-note tombstones, for surfaces that render the subtle restore row. */
  const timeline = (project = {}) => {
    const entry = project?.id ? stores.get(clean(project.id)) : null;
    return (entry?.notes || []).filter((note) => ((note.text || note.attachments?.length) && !note.deleted_at) || note.deleted_at);
  };
  const owns = (note, who = actor()) => {
    if (note?.can_edit === true) return true;
    const keys = actorKeys(who);
    return actorKeys(note?.created_by || {}).some((key) => keys.includes(key));
  };
  const isTagged = (note, who = actor()) => {
    const keys = actorKeys(who);
    return unique(note?.tagged_people || []).map((item) => item.toLowerCase()).some((tag) => keys.some((key) => key === tag || key.startsWith(tag) || tag.startsWith(key)));
  };
  const canSee = (note, who = actor(), groups = currentGroups()) => owns(note, who) || isTagged(note, who) || normalizeVisibility(note?.visibility).some((group) => groups.includes(group));
  // The backend filters by audience server-side; canSee stays for cached-data parity.
  const visible = (project, options = {}) => all(project).filter((note) => canSee(note, options.actor || actor(), options.groups || currentGroups()));

  // --- original write API (optimistic, settled through ChannelsAPI) -----------

  const add = (project, text, visibility = GROUPS, mentionUsers = [], typeTagsValue = [], options = {}) => {
    const entry = storeFor(project);
    if (!entry) return null;
    const now = new Date().toISOString();
    const note = normalize({
      id:id(), text, visibility, tagged_people:mentionsFromText(text), mention_users:mentionUsers, type_tags:typeTagsValue,
      attachments:Array.isArray(options.attachments) ? options.attachments : [],
      metadata:options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
      created_at:now, updated_at:now, created_by:actor(),
      can_edit:true, can_delete:true, reply_count:0,
      seq:(entry.notes[entry.notes.length - 1]?.seq || 0) + 1
    });
    entry.notes = [...entry.notes, note];
    track(entry, async () => {
      const api = channels();
      const oid = orgId();
      if (!api || !oid) return;
      await ensureChannel(entry);
      const posted = await api.messages.post(oid, entry.channelId, {
        text: note.text,
        client_msg_id: note.id,
        audience: audienceFromVisibility(visibility),
        tags: note.type_tags,
        mention_users: note.mention_users,
        attachment_ids: note.attachments.map((attachment) => attachment.id).filter(Boolean),
        metadata: note.metadata
      });
      entry.notes = entry.notes.map((item) => item.id === note.id ? noteFromMessage(posted.message) : item);
      announce(entry.projectId);
    });
    return note;
  };

  async function recordAudio(project, options = {}){
    const entry = storeFor(project);
    const audio = window.FirstMateAudioNotes;
    if (!entry || !audio?.prepare) throw new Error('Audio notes are unavailable.');
    await ensureChannel(entry);
    return audio.prepare(orgId(), entry.channelId, options);
  }

  async function prepareAudioInline(project, mount, options = {}){
    const entry = storeFor(project);
    const audio = window.FirstMateAudioNotes;
    if (!entry || !audio?.prepareInline) throw new Error('Inline audio notes are unavailable.');
    await ensureChannel(entry);
    return audio.prepareInline(orgId(), entry.channelId, { ...options, mount });
  }

  async function prepareUpload(project, file, options = {}){
    const entry = storeFor(project);
    const api = channels();
    if (!entry || !file || !api?.uploads?.send) throw new Error('Note uploads are unavailable.');
    await ensureChannel(entry);
    const contentType = clean(file.type).toLowerCase();
    if (contentType.startsWith('audio/')) {
      const audio = window.FirstMateAudioNotes;
      if (!audio?.prepareFile) throw new Error('Audio transcription is unavailable.');
      return {
        kind:'audio',
        ...(await audio.prepareFile(orgId(), entry.channelId, file, options))
      };
    }
    const uploaded = await api.uploads.send(orgId(), file, entry.channelId);
    if ((contentType.startsWith('image/') || contentType.startsWith('video/')) && uploaded?.attachment?.media_id) {
      window.dispatchEvent(new CustomEvent('fm:project-note-media-uploaded', {
        detail:{
          projectId:entry.projectId,
          channelId:entry.channelId,
          attachment:uploaded.attachment
        }
      }));
    }
    return {
      kind:contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : 'file',
      text:'',
      attachment:uploaded.attachment,
      metadata:{
        media_upload:{
          version:1,
          source:'project_note_upload',
          file_name:clean(file.name),
          content_type:contentType
        }
      }
    };
  }

  function mountAudioAttachment(mount, prepared, onRemove){
    const audio = window.FirstMateAudioNotes;
    const api = channels();
    if (!mount || !prepared?.attachment?.media_id || !audio?.mountPrepared || !api?.mediaFileUrl) return null;
    return audio.mountPrepared(mount, {
      url:api.mediaFileUrl(orgId(), prepared.attachment.media_id),
      duration:prepared.metadata?.duration_seconds,
      peaks:prepared.metadata?.peaks,
      onRemove
    });
  }

  function audioPlayerHtml(note = {}){
    const audioNote = note.metadata?.audio_note;
    const attachment = (note.attachments || []).find((item) => String(item.content_type || '').startsWith('audio/'));
    const api = channels();
    if (!audioNote || !attachment?.media_id || !api?.mediaFileUrl || !window.FirstMateAudioNotes?.playerHtml) return '';
    return window.FirstMateAudioNotes.playerHtml({
      url:api.mediaFileUrl(orgId(), attachment.media_id),
      duration:Number(audioNote.duration_seconds) || 0,
      peaks:Array.isArray(audioNote.peaks) ? audioNote.peaks : []
    });
  }

  function mountPreparedUpload(mount, prepared, onRemove){
    if (!mount || !prepared?.attachment) return null;
    if (prepared.kind === 'audio' || String(prepared.attachment.content_type || '').startsWith('audio/')) {
      return mountAudioAttachment(mount, prepared, onRemove);
    }
    const api = channels();
    const url = api?.mediaFileUrl?.(orgId(), prepared.attachment.media_id) || '';
    mount.innerHTML = `<div class="pn-pending-upload">${String(prepared.kind === 'image'
      ? `<img src="${escapeHtml(url)}" alt="">`
      : prepared.kind === 'video'
        ? `<video src="${escapeHtml(url)}" muted preload="metadata"></video>`
        : '<i class="fas fa-paperclip"></i>')}<span>${String(escapeHtml(prepared.attachment.file_name || 'Attachment ready'))}</span><button type="button" aria-label="${(globalThis.PlatformLanguage?.text("project-notes","m_3ea0f07c7208c2","Remove attachment") ?? "Remove attachment")}"><i class="fas fa-xmark"></i></button></div>`;
    const remove = mount.querySelector('button');
    remove?.addEventListener('click', () => {
      mount.innerHTML = '';
      onRemove?.();
    });
    return mount.firstElementChild;
  }

  function mediaAttachmentsHtml(note = {}){
    const api = channels();
    if (!api?.mediaFileUrl) return '';
    const media = (note.attachments || []).filter((item) => !String(item.content_type || '').startsWith('audio/'));
    if (!media.length) return '';
    return `<div class="pn-media-grid">${media.map((item) => {
      const url = api.mediaFileUrl(orgId(), item.media_id);
      const contentType = String(item.content_type || '').toLowerCase();
      if (contentType.startsWith('image/')) return `<a class="pn-media-item" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${escapeHtml(item.file_name || 'Note image')}"></a>`;
      if (contentType.startsWith('video/')) return `<div class="pn-media-item"><video src="${escapeHtml(url)}" controls preload="metadata"></video></div>`;
      return `<a class="pn-file-item" href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="fas fa-paperclip"></i><span>${escapeHtml(item.file_name || 'Attachment')}</span></a>`;
    }).join('')}</div>`;
  }

  const update = (project, noteId, patch = {}) => {
    const entry = storeFor(project);
    if (!entry) return null;
    let result = null;
    entry.notes = entry.notes.map((note) => {
      if (note.id !== noteId || !owns(note)) return note;
      result = normalize({ ...note, ...patch, tagged_people:patch.text == null ? note.tagged_people : [], mention_users:patch.mention_users == null ? note.mention_users : patch.mention_users, updated_at:new Date().toISOString(), edited_at:new Date().toISOString() });
      return result;
    });
    if (result) {
      const noteRef = result;
      track(entry, async () => {
        const api = channels();
        const oid = orgId();
        if (!api || !oid) return;
        const edited = await api.messages.edit(oid, noteId, {
          text: noteRef.text,
          audience: audienceFromVisibility(noteRef.visibility),
          tags: noteRef.type_tags,
          mention_users: noteRef.mention_users
        });
        entry.notes = entry.notes.map((item) => item.id === noteId ? noteFromMessage(edited.message) : item);
        announce(entry.projectId);
      });
    }
    return result;
  };

  const remove = (project, noteId) => {
    const entry = storeFor(project);
    const target = entry?.notes.find((note) => note.id === noteId);
    if (!entry || !target || !(target.can_delete === true || owns(target))) return false;
    entry.notes = entry.notes.map((note) => note.id === noteId
      ? { ...note, deleted_at:new Date().toISOString(), can_restore:true }
      : note);
    track(entry, async () => {
      const api = channels();
      const oid = orgId();
      if (!api || !oid) return;
      const deleted = await api.messages.remove(oid, noteId);
      entry.notes = entry.notes.map((item) => item.id === noteId ? noteFromMessage(deleted.message) : item);
      announce(entry.projectId);
    });
    return true;
  };

  const restore = (project, noteId) => {
    const entry = storeFor(project);
    if (!entry) return false;
    entry.notes = entry.notes.map((note) => note.id === noteId ? { ...note, deleted_at:'' } : note);
    track(entry, async () => {
      const api = channels();
      const oid = orgId();
      if (!api || !oid) return;
      const restored = await api.messages.restore(oid, noteId);
      entry.notes = entry.notes.map((item) => item.id === noteId ? noteFromMessage(restored.message) : item);
      announce(entry.projectId);
    });
    return true;
  };

  const revisions = async (noteId) => {
    const api = channels();
    const oid = orgId();
    if (!api || !oid) return null;
    return api.messages.revisions(oid, noteId);
  };

  const replies = async (project, noteId) => {
    const api = channels();
    const oid = orgId();
    if (!api || !oid) return [];
    const thread = await api.messages.thread(oid, noteId);
    return (thread.replies || []).map(noteFromMessage);
  };

  const reply = async (project, noteId, text, mentionUsers = []) => {
    const entry = storeFor(project);
    const api = channels();
    const oid = orgId();
    if (!entry || !api || !oid || !clean(text)) return null;
    await ensureChannel(entry);
    const posted = await api.messages.post(oid, entry.channelId, {
      text: clean(text),
      parent_id: noteId,
      client_msg_id: id(),
      mention_users: mentionUsers
    });
    entry.notes = entry.notes.map((note) => note.id === noteId
      ? { ...note, reply_count:(Number(note.reply_count) || 0) + 1 }
      : note);
    announce(entry.projectId);
    return noteFromMessage(posted.message);
  };

  const visibilityLabel = (visibility) => {
    const groups = normalizeVisibility(visibility);
    if (groups.length === GROUPS.length) return 'Everybody';
    if (!groups.length) return 'Only Tagged';
    return groups.map((group) => group[0].toUpperCase() + group.slice(1)).join(', ');
  };

  // --- small meta helpers for the note-card extras ----------------------------

  const fmtWhen = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.toLocaleDateString([], { month:'short', day:'numeric' })}, ${date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`;
  };

  /** " · edited" meta link (opens revision history) — empty when never edited. */
  const editedMetaHtml = (note = {}) => note.edited_at && note.id
    ? (" · <button type=\"button\" class=\"pn-edited\" data-pn-history=\"" + String(escapeHtml(note.id)) + "\" title=\"" + (globalThis.PlatformLanguage?.text("project-notes","m_2a147261f9659a","View edit history") ?? "View edit history") + "\">" + (globalThis.PlatformLanguage?.text("project-notes","m_313a7c5abadc61","edited") ?? "edited") + "</button>")
    : '';

  /** Reply affordance for a note card: count when replies exist, quiet reply icon otherwise. */
  const repliesToggleHtml = (note = {}) => {
    if (!note.id || note.id === 'legacy_internal_note') return '';
    const count = Number(note.reply_count) || 0;
    return count
      ? `<button type="button" class="pn-replies-toggle" data-pn-replies="${escapeHtml(note.id)}"><i class="fas fa-reply"></i>${count} ${count === 1 ? 'reply' : 'replies'}</button>`
      : `<button type="button" class="pn-replies-toggle pn-reply-new" data-pn-replies="${String(escapeHtml(note.id))}" aria-label="${(globalThis.PlatformLanguage?.text("project-notes","m_8ac417d9371ab4","Reply to this note") ?? "Reply to this note")}" title="${(globalThis.PlatformLanguage?.text("project-notes","m_b7aa8fbdbd8d21","Reply") ?? "Reply")}"><i class="fas fa-reply"></i></button>`;
  };

  /** Subtle removed-note row with restore link (renders inside the host card element). */
  const removedNoteHtml = (note = {}) => `
    <p class="pn-removed-copy"><i class="fas fa-rotate-left" aria-hidden="true"></i>Note removed${note.can_restore ? ("<button type=\"button\" class=\"pn-restore\" data-pn-restore=\"" + String(escapeHtml(note.id)) + "\">" + (globalThis.PlatformLanguage?.text("project-notes","m_954a04d61ae9d6","Restore") ?? "Restore") + "</button>") : ''}</p>`;

  // --- delegated behaviors: edit history popover, restore, inline replies -----

  let openHistoryPop = null;
  const translationInFlight = new Map();
  function closeHistoryPop(){
    openHistoryPop?.remove();
    openHistoryPop = null;
    document.removeEventListener('mousedown', historyPopOutside, true);
  }
  function historyPopOutside(event){
    if (openHistoryPop && !openHistoryPop.contains(event.target)) closeHistoryPop();
  }

  async function showHistoryPopover(anchor, noteId){
    closeHistoryPop();
    const data = await revisions(noteId).catch(() => null);
    if (!data) return;
    const pop = document.createElement('div');
    pop.className = 'pn-history-pop';
    pop.innerHTML = `
      <div class="pn-history-pop-head">${(globalThis.PlatformLanguage?.text("project-notes","m_c3e32bdc4e8fce","Edit history") ?? "Edit history")}</div>
      <div class="pn-history-item current"><div class="when">${((v0) => globalThis.PlatformLanguage?.text("project-notes","m_a61a3f449dcac0",`Current · ${v0}`,{v0}) ?? `Current · ${v0}`)(escapeHtml(fmtWhen(data.current?.edited_at || data.current?.created_at)))}</div><div class="text">${String(escapeHtml(data.current?.text || ''))}</div></div>
      ${String((data.revisions || []).map((revision) => `<div class="pn-history-item"><div class="when">${escapeHtml(revision.edited_by_user?.name || 'Unknown')} · ${escapeHtml(fmtWhen(revision.edited_at))}</div><div class="text">${escapeHtml(revision.text)}</div></div>`).join(''))}`;
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - popRect.height - 6);
    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8))}px`;
    openHistoryPop = pop;
    setTimeout(() => document.addEventListener('mousedown', historyPopOutside, true), 0);
  }

  function replyCardHtml(item){
    return `<div class="pn-reply-card"><p>${escapeHtml(item.text)}</p><div class="pn-reply-meta">${escapeHtml(item.created_by?.name || item.created_by?.email || 'Unknown')} · ${escapeHtml(fmtWhen(item.created_at))}</div></div>`;
  }

  async function renderRepliesInto(card, project, noteId, options = {}){
    let wrap = card.querySelector('.pn-replies-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'pn-replies-wrap';
      wrap.innerHTML = `<div class="pn-reply-meta">${(globalThis.PlatformLanguage?.text("project-notes","m_d7c615083b4307","Loading replies…") ?? "Loading replies…")}</div>`;
      card.appendChild(wrap);
    }
    const items = await replies(project, noteId).catch(() => []);
    if (!wrap.isConnected) return;
    wrap.innerHTML = (String(items.map(replyCardHtml).join('')) + "\n      <div class=\"pn-reply-compose\"><input type=\"text\" placeholder=\"" + (globalThis.PlatformLanguage?.text("project-notes","m_7b1d560830d655","Reply…") ?? "Reply…") + "\" data-pn-reply-input=\"" + String(escapeHtml(noteId)) + "\"><button type=\"button\" data-pn-reply-send=\"" + String(escapeHtml(noteId)) + "\" aria-label=\"" + (globalThis.PlatformLanguage?.text("project-notes","m_5ffd34ad8437cd","Send reply") ?? "Send reply") + "\" title=\"" + (globalThis.PlatformLanguage?.text("project-notes","m_5ffd34ad8437cd","Send reply") ?? "Send reply") + "\"><i class=\"fas fa-paper-plane\"></i></button></div>");
    if (options.focus) wrap.querySelector('input')?.focus();
  }

  async function sendReply(wrapInput, project, noteId){
    const text = clean(wrapInput?.value);
    if (!text) return;
    wrapInput.disabled = true;
    const posted = await reply(project, noteId, text).catch(() => null);
    if (wrapInput.isConnected) {
      wrapInput.disabled = false;
      if (posted) {
        wrapInput.value = '';
        wrapInput.closest('.pn-replies-wrap')?.querySelector('.pn-reply-compose')?.insertAdjacentHTML('beforebegin', replyCardHtml(posted));
      }
    }
  }

  /**
   * Attach the extras (edit history, restore, replies) to a note-history
   * container by delegation. Cards must carry data-project-note-id. Open reply
   * threads survive history re-renders: expansions are tracked and rebuilt
   * whenever the container's cards are replaced.
   */
  function bindHistoryExtras(container, getProject){
    if (!container || container.dataset.pnExtrasBound === '1') return;
    container.dataset.pnExtrasBound = '1';
    const expanded = new Set();
    const projectOf = () => (typeof getProject === 'function' ? getProject() : getProject);
    const noteForCard = (project, noteId) => timeline(project).find((note) => note.id === noteId);
    const languageName = (code) => ({ en:'English', 'en-US':'English (US)', 'en-GB':'English (UK)', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', it:'Italian', nl:'Dutch', pl:'Polish', ru:'Russian', uk:'Ukrainian', ar:'Arabic', hi:'Hindi', bn:'Bengali', ur:'Urdu', zh:'Chinese', ja:'Japanese', ko:'Korean', vi:'Vietnamese', th:'Thai', id:'Indonesian', tl:'Filipino', tr:'Turkish', he:'Hebrew' })[code] || code || 'another language';
    const noteTextElement = (card) => card.querySelector('[data-project-note-text],p:not(.pn-removed-copy),.r-note-text,.dialer-note-text,.mt-note-text');
    const paintTranslation = (card, note) => {
      if (!card || !note?.translation?.available || note.deleted_at) return;
      card.style.position = card.style.position || 'relative';
      let button = card.querySelector(':scope > .pn-translate');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'pn-translate';
        button.dataset.pnTranslate = note.id;
        card.appendChild(button);
      }
      const textNode = noteTextElement(card);
      if (!textNode) return;
      if (textNode.dataset.pnOriginalHtml == null) textNode.dataset.pnOriginalHtml = textNode.innerHTML;
      const translated = clean(note.translation.cached_text);
      const show = note._show_translation === true || (note._show_translation !== false && note.translation.auto_translate && translated);
      button.classList.toggle('on', !!show);
      button.classList.toggle('loading', translationInFlight.has(note.id));
      button.title = show ? 'Show original' : `Translate to ${languageName(note.translation.target_language)}`;
      button.innerHTML = `<i class="fas ${translationInFlight.has(note.id) ? 'fa-circle-notch' : 'fa-language'}"></i>`;
      if (show) {
        textNode.textContent = translated;
        if (!card.querySelector(':scope > .pn-translated-note')) card.insertAdjacentHTML('beforeend', `<span class="pn-translated-note">${((v0) => globalThis.PlatformLanguage?.text("project-notes","m_d2d48d3b49d330",`Translated from ${v0}`,{v0}) ?? `Translated from ${v0}`)(escapeHtml(languageName(note.translation.source_language)))}</span>`);
      } else {
        textNode.innerHTML = textNode.dataset.pnOriginalHtml;
        card.querySelector(':scope > .pn-translated-note')?.remove();
      }
      if (note.translation.auto_translate && !translated && !translationInFlight.has(note.id)) void requestNoteTranslation(note, card, true);
    };
    const requestNoteTranslation = async (note, card, automatic) => {
      if (!note?.translation?.available || translationInFlight.has(note.id)) return;
      if (note.translation.cached_text) {
        note._show_translation = true;
        paintTranslation(card, note);
        return;
      }
      note._show_translation = true;
      const promise = channels().messages.translate(orgId(), note.id)
        .then((data) => { note.translation = { ...note.translation, ...data.translation, cached_text:data.translation?.translated_text }; })
        .catch((error) => {
          note._show_translation = false;
          if (!automatic) window.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("project-notes","m_f7937646874120","Translation failed") ?? "Translation failed"), error?.message || 'Could not translate this note.', false);
        })
        .finally(() => {
          translationInFlight.delete(note.id);
          if (card.isConnected) paintTranslation(card, note);
        });
      translationInFlight.set(note.id, promise);
      paintTranslation(card, note);
      await promise;
    };
    const rehydrate = () => {
      const project = projectOf();
      container.querySelectorAll('[data-project-note-id]').forEach((card) => {
        const note = noteForCard(project, card.dataset.projectNoteId);
        if (note) paintTranslation(card, note);
      });
      expanded.forEach((noteId) => {
        const card = container.querySelector(`[data-project-note-id="${CSS.escape(noteId)}"]`);
        if (!card || card.classList.contains('pn-removed')) return;
        if (!card.querySelector('.pn-replies-wrap')) void renderRepliesInto(card, project, noteId);
      });
    };
    try {
      new MutationObserver(rehydrate).observe(container, { childList: true });
    } catch (error) {}
    queueMicrotask(rehydrate);
    container.addEventListener('click', async (event) => {
      const history = event.target.closest('[data-pn-history]');
      const restoreBtn = event.target.closest('[data-pn-restore]');
      const repliesBtn = event.target.closest('[data-pn-replies]');
      const sendBtn = event.target.closest('[data-pn-reply-send]');
      const translateBtn = event.target.closest('[data-pn-translate]');
      if (!history && !restoreBtn && !repliesBtn && !sendBtn && !translateBtn) return;
      event.preventDefault();
      event.stopPropagation();
      const project = projectOf();
      if (translateBtn) {
        const note = noteForCard(project, translateBtn.dataset.pnTranslate);
        const card = translateBtn.closest('[data-project-note-id]');
        if (!note || !card) return;
        if (note._show_translation === true || (note._show_translation !== false && note.translation?.auto_translate && note.translation?.cached_text)) {
          note._show_translation = false;
          paintTranslation(card, note);
        } else {
          await requestNoteTranslation(note, card, false);
        }
        return;
      }
      if (history) return void showHistoryPopover(history, history.dataset.pnHistory);
      if (restoreBtn) return void restore(project, restoreBtn.dataset.pnRestore);
      if (sendBtn) return void sendReply(container.querySelector(`[data-pn-reply-input="${CSS.escape(sendBtn.dataset.pnReplySend)}"]`), project, sendBtn.dataset.pnReplySend);
      if (repliesBtn) {
        const noteId = repliesBtn.dataset.pnReplies;
        const card = repliesBtn.closest('[data-project-note-id]') || repliesBtn.closest('article');
        if (!card) return;
        if (card.querySelector('.pn-replies-wrap')) {
          expanded.delete(noteId);
          card.querySelector('.pn-replies-wrap').remove();
        } else {
          expanded.add(noteId);
          await renderRepliesInto(card, project, noteId, { focus: true });
        }
      }
    });
    container.addEventListener('keydown', (event) => {
      const input = event.target.closest('[data-pn-reply-input]');
      if (!input || event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void sendReply(input, projectOf(), input.dataset.pnReplyInput);
    });
  }

  ensureTypeTagStyles();
  window.Portal.ProjectNotes = {
    GROUPS, TYPE_TAGS, actor, currentGroups, normalizeVisibility, normalizeTypeTags, normalizeMentionUser, mentionsFromText,
    typeTag, typeTags, renderTypeTags, all, visible, owns, isTagged, canSee, add, update, remove, visibilityLabel,
    recordAudio, prepareAudioInline, prepareUpload, mountAudioAttachment, mountPreparedUpload, audioPlayerHtml, mediaAttachmentsHtml,
    // channels-backed additions:
    load, flush, timeline, restore, revisions, replies, reply,
    editedMetaHtml, repliesToggleHtml, removedNoteHtml, bindHistoryExtras
  };
})();
