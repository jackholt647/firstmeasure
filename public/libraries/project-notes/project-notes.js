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
    const crew = /crew|field|installer|technician|foreman|production/.test(roles) || window.Portal?.util?.hasPerm?.('crew.projects.view') === true;
    if (sales) groups.push('sales');
    if (crew) groups.push('crew');
    if (/office|admin|manager|owner|dispatch|coordinator/.test(roles) || (!sales && !crew)) groups.push('office');
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
      + '.pn-uploads{display:flex;gap:7px;flex-wrap:wrap;overflow:visible}.pn-uploads:empty{display:none}.pn-pending-upload{display:flex;align-items:center;gap:8px;margin-top:7px;padding:7px 9px;border:1px solid #e4e7ec;border-radius:9px;background:#f8fafc;color:#475467;font-size:11px;font-weight:750}.pn-pending-upload img,.pn-pending-upload video{width:42px;height:34px;object-fit:cover;border-radius:6px}.pn-pending-upload span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pn-pending-upload button{border:0;background:none;color:#98a2b3;cursor:pointer}';
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
      created_by: { id:clean(createdBy.id || note.created_by_id), name:clean(createdBy.name || note.created_by_name || 'Unknown'), email:clean(createdBy.email || note.created_by_email).toLowerCase(), avatar:clean(createdBy.avatar || createdBy.avatar_url || createdBy.photo_url) },
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
      created_by: { ...message.author },
      mention_users: message.mention_users || [],
      type_tags: message.tags || [],
      visibility: audience.length ? audience : GROUPS,
      edited_at: clean(message.edited_at),
      deleted_at: clean(message.deleted_at),
      can_edit: message.can_edit === true,
      can_delete: message.can_delete === true,
      can_restore: message.can_restore === true,
      reply_count: Number(message.reply_count) || 0,
      pinned_at: message.pinned_at || null,
      pinned_by: message.pinned_by || null,
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
      entry = { projectId, mediaId:clean(projectValue?.commentMediaId), channelId:'', notes:[], loaded:false, loading:null, lastOp:Promise.resolve(), unsubscribe:null, refreshTimer:0 };
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
    const ensured = await (entry.mediaId ? api.channels.ensurePhoto(oid, entry.mediaId) : api.channels.ensureProject(oid, entry.projectId));
    entry.channelId = clean(ensured.channel?.id);
    subscribeRealtime(entry);
    return entry.channelId;
  }

  async function refreshEntry(entry){
    const api = channels();
    const oid = orgId();
    if (!api || !oid) return entry;
    await ensureChannel(entry);
    const data = await api.messages.list(oid, entry.channelId, {limit:200, view:"notes"});
    entry.historyBefore = data.messages?.length === 200 ? data.messages[0].seq : 0;
    const pins = await (api.pins?.list?.(oid, entry.channelId, {view:"notes"}) || Promise.resolve({messages:[]}));
    const rows = [...new Map([...(data.messages || []), ...(pins.messages || [])].map(row => [row.id,row])).values()];
    entry.notes = rows
      .filter((message) => message.kind !== 'system' && message.metadata?.project_note === true)
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
        project_note:true, pin:options.pin === true,
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
    if(prepared.kind==='image'){
      const preview=window.FirstMateChannels?.composerWidgets?.attachmentDraft?.(prepared.attachment,{url,onRemove:()=>{mount.replaceChildren();onRemove?.();}});
      if(preview){mount.replaceChildren(preview);return preview;}
    }
    mount.innerHTML = `<div class="pn-pending-upload">${String(prepared.kind === 'image'
      ? `<img src="${escapeHtml(url)}" alt="">`
      : prepared.kind === 'video'
        ? `<video src="${escapeHtml(url)}" muted preload="metadata"></video>`
        : '<i class="fas fa-paperclip"></i>')}<span>${String(escapeHtml(prepared.attachment.file_name || 'Attachment ready'))}</span><button type="button" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-notes","m_3ea0f07c7208c2","Remove attachment") ?? "Remove attachment")}"><i class="fas fa-xmark"></i></button></div>`;
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
      : `<button type="button" class="pn-replies-toggle pn-reply-new" data-pn-replies="${String(escapeHtml(note.id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-notes","m_8ac417d9371ab4","Reply to this note") ?? "Reply to this note")}" title="${(globalThis.PlatformLanguage?.htmlText("project-notes","m_b7aa8fbdbd8d21","Reply") ?? "Reply")}"><i class="fas fa-reply"></i></button>`;
  };

  /** Subtle removed-note row with restore link (renders inside the host card element). */
  const removedNoteHtml = (note = {}) => `
    <p class="pn-removed-copy"><i class="fas fa-rotate-left" aria-hidden="true"></i>Note removed${note.can_restore ? ("<button type=\"button\" class=\"pn-restore\" data-pn-restore=\"" + String(escapeHtml(note.id)) + "\">" + (globalThis.PlatformLanguage?.htmlText("project-notes","m_954a04d61ae9d6","Restore") ?? "Restore") + "</button>") : ''}</p>`;

  // --- delegated behaviors: edit history popover, restore, inline replies -----

  let openHistoryPop = null;
  const translationInFlight = new Map();
  let historyPopGeneration = 0;
  function closeHistoryPop(){
    historyPopGeneration++;
    openHistoryPop?.remove();
    openHistoryPop = null;
    document.removeEventListener('mousedown', historyPopOutside, true);
  }
  function historyPopOutside(event){
    if (openHistoryPop && !openHistoryPop.contains(event.target)) closeHistoryPop();
  }

  async function showHistoryPopover(anchor, noteId){
    closeHistoryPop();
    const generation=historyPopGeneration;
    const data = await revisions(noteId).catch(() => null);
    if (!data || generation!==historyPopGeneration || !anchor.isConnected) return;
    const pop = document.createElement('div');
    pop.className = 'pn-history-pop';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Edit history');
    pop.innerHTML = `
      <div class="pn-history-pop-head">${(globalThis.PlatformLanguage?.htmlText("project-notes","m_c3e32bdc4e8fce","Edit history") ?? "Edit history")}<button type="button" class="pn-history-close" aria-label="Close edit history"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>
      <div class="pn-history-item current"><div class="when">${((v0) => globalThis.PlatformLanguage?.htmlText("project-notes","m_a61a3f449dcac0",`Current · ${v0}`,{v0}) ?? `Current · ${v0}`)(escapeHtml(fmtWhen(data.current?.edited_at || data.current?.created_at)))}</div><div class="text">${String(escapeHtml(data.current?.text || ''))}</div></div>
      ${String((data.revisions || []).map((revision) => `<div class="pn-history-item"><div class="when">${escapeHtml(revision.edited_by_user?.name || 'Unknown')} · ${escapeHtml(fmtWhen(revision.edited_at))}</div><div class="text">${escapeHtml(revision.text)}</div></div>`).join(''))}`;
    pop.querySelector('.pn-history-close').onclick=closeHistoryPop;
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
      wrap.innerHTML = `<div class="pn-reply-meta">${(globalThis.PlatformLanguage?.htmlText("project-notes","m_d7c615083b4307","Loading replies…") ?? "Loading replies…")}</div>`;
      card.appendChild(wrap);
    }
    const items = await replies(project, noteId).catch(() => []);
    if (!wrap.isConnected) return;
    wrap.innerHTML = (String(items.map(replyCardHtml).join('')) + "\n      <div class=\"pn-reply-compose\"><input type=\"text\" placeholder=\"" + (globalThis.PlatformLanguage?.htmlText("project-notes","m_7b1d560830d655","Reply…") ?? "Reply…") + "\" data-pn-reply-input=\"" + String(escapeHtml(noteId)) + "\"><button type=\"button\" data-pn-reply-send=\"" + String(escapeHtml(noteId)) + "\" aria-label=\"" + (globalThis.PlatformLanguage?.htmlText("project-notes","m_5ffd34ad8437cd","Send reply") ?? "Send reply") + "\" title=\"" + (globalThis.PlatformLanguage?.htmlText("project-notes","m_5ffd34ad8437cd","Send reply") ?? "Send reply") + "\"><i class=\"fas fa-paper-plane\"></i></button></div>");
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
        if (!card.querySelector(':scope > .pn-translated-note')) card.insertAdjacentHTML('beforeend', `<span class="pn-translated-note">${((v0) => globalThis.PlatformLanguage?.htmlText("project-notes","m_d2d48d3b49d330",`Translated from ${v0}`,{v0}) ?? `Translated from ${v0}`)(escapeHtml(languageName(note.translation.source_language)))}</span>`);
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
  /** Shared note workspace, also mounted by the project's Channels Notes tab. */
  function mount(container, options = {}) {
    if (!document.getElementById('fm-notes-workspace-css')) {
      const style = document.createElement('style'); style.id = 'fm-notes-workspace-css';
      style.textContent = `.pn-workspace{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;font-size:13px;color:#101828;background:white}.pn-tools{display:flex;gap:8px;align-items:center;padding:10px;flex:none}.pn-tools input[type=search]{min-width:0;flex:1;border:1px solid #d0d5dd;border-radius:6px;padding:7px}.pn-tools label{white-space:nowrap;font-size:11px}.pn-pinned{flex:none;padding:0 10px;max-height:50%;overflow:auto;border-bottom:1px solid #e4e7ec}.pn-pinned[hidden]{display:none}.pn-pinned h4{margin:5px 0 8px;font-size:12px;color:#667085}.pn-history{flex:1;min-height:60px;overflow:auto;padding:10px}.pn-card{background:#fff;border:1px solid #e4e7ec;border-radius:9px;margin-bottom:9px;padding:9px}.pn-pinned .pn-card{background:#fffcf5;border-color:#f3e6be}.pn-card header{display:flex;align-items:center;gap:6px;font-size:11px}.pn-card header span{font-weight:600}.pn-card time{color:#667085;margin-left:auto}.pn-card-content{max-height:180px;overflow:hidden;overflow-wrap:anywhere}.pn-card-content.expanded{max-height:none}.pn-card-content p{white-space:pre-wrap}.pn-card footer{display:flex;align-items:center;gap:4px;color:#667085;font-size:11px;margin-top:8px}.pn-card footer button{margin-left:auto}.pn-workspace button{border:1px solid #e4e7ec;background:#fff;border-radius:5px;padding:5px 8px;color:#344054}.pn-menu{position:relative}.pn-menu summary{cursor:pointer;padding:5px;list-style:none}.pn-menu>div{position:absolute;top:100%;right:0;z-index:80;width:160px;padding:5px;background:white;border:1px solid #e4e7ec;border-radius:8px;box-shadow:0 8px 20px #10182820}.pn-menu button{display:block;width:100%;border:0;text-align:left}.pn-menu button:hover{background:#f2f4f7}.pn-composer{padding:10px;border-top:1px solid #e4e7ec;flex:none}.pn-composer textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:58px;max-height:180px;border:1px solid #d0d5dd;border-radius:8px;padding:8px;font:inherit}.pn-compose-actions{display:flex;align-items:center;gap:6px;margin-top:7px}.pn-compose-actions select{min-width:0;max-width:95px;font-size:11px;border:1px solid #e4e7ec;border-radius:5px;padding:4px}.pn-icon{padding:5px;cursor:pointer}.pn-add{margin-left:auto;display:flex;white-space:nowrap}.pn-add button{background:var(--primary,#175cd3);color:white;border:0;border-radius:6px 0 0 6px}.pn-add button+button{border-left:1px solid #ffffff55;border-radius:0 6px 6px 0}.pn-status{font-size:12px;color:#667085;padding:0 10px}.pn-status:empty{display:none}.pn-empty{color:#667085}.pn-uploads{max-height:180px;overflow:auto}.pn-more{font-size:11px;margin-top:5px}.pn-removed{color:#667085}`;
      document.head.append(style);
    }
    const commentMode=options.kind === 'photo-comments';
    const copy=value=>commentMode ? value.replace(/project notes/gi,'photo comments').replace(/project note/gi,'photo comment').replace(/notes/g,'comments').replace(/note/g,'comment') : value;
    let project = options.getProject?.() || options.project;
    let entry = storeFor(project) || {projectId:'',notes:[]};
    function adoptProject() {
      const current = options.getProject?.() || project;
      const next = storeFor(current);
      if (next) {project=current;entry=next;}
    }
    async function ensureSavedProject() {
      adoptProject();
      if (!entry.projectId) {
        project = await options.ensureProject?.();
        entry = storeFor(project) || entry;
        if (!entry.projectId) throw Error('Choose a project or enter a property address before saving a note.');
      }
    }
    if (options.channelId) {entry.channelId = options.channelId; subscribeRealtime(entry);}
    if (!document.getElementById('fm-project-notes-composer-style')) {
      const style = document.createElement('style'); style.id = 'fm-project-notes-composer-style';
      style.textContent = `
        .pn-workspace{font-family:inherit;container-type:inline-size;--ch-muted:#667085;--ch-accent:var(--primary,#175cd3);--ch-hover:#f2f4f7}
        .pn-tools{padding:12px 14px;gap:8px;border-bottom:1px solid #eef0f3}.pn-tools input[type=search]{font:inherit;font-size:12px;padding:8px 10px;border-color:#e4e7ec;border-radius:8px;background:#fafbfc}.pn-tools label{font-size:11px;color:#667085}
        .pn-history{padding:14px;background:#fafbfc;overscroll-behavior:contain}.pn-pinned{padding:0 14px;background:#fafbfc}.pn-empty{font-size:12px;padding:24px 8px;text-align:center;color:#667085}
        .pn-card{padding:14px;border-radius:12px;font-size:12px;line-height:1.55;margin-bottom:12px;box-shadow:0 1px 2px #10182804}.pn-card header{align-items:flex-start;gap:9px;font-size:12px}.pn-avatar{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--primary-light,#eef2ff);color:var(--primary,#175cd3);font-size:10px;font-weight:700}.pn-author{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.pn-author>span{overflow-wrap:anywhere}.pn-card .pn-author time{margin:0;font-size:10px;font-weight:400}.pn-card .pn-menu{margin-left:auto}.pn-menu summary{border-radius:5px;color:#98a2b3}.pn-menu summary:hover,.pn-menu[open] summary{background:#f2f4f7;color:#344054}.pn-card-content{margin-top:10px}.pn-card-content p{margin:6px 0}.pn-card-content blockquote{margin:8px 0;padding:4px 10px;border-left:3px solid #d0d5dd;color:#667085}.pn-card-content ul,.pn-card-content ol{padding-left:22px}.pn-card footer{border-top:1px solid #f2f4f7;padding-top:8px;margin-top:12px;font-size:10px;flex-wrap:wrap}.pn-card footer button,.pn-more{border:0;background:transparent;color:var(--primary,#175cd3);font:inherit;font-size:11px;cursor:pointer}.pn-more[hidden]{display:none}.pn-card footer button:hover,.pn-more:hover{background:#f2f4f7}
        .pn-composer{padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:#fff}.pn-composer-head{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#667085}.pn-composer-heading{font-size:10px;font-weight:700;letter-spacing:.04em}.pn-visibility{display:flex;align-items:center;gap:8px;white-space:nowrap}.pn-visibility>span{font-size:10px;color:#98a2b3}.pn-visibility-choice{position:relative;display:flex;align-items:center;gap:5px;font-size:11px}.pn-visibility-choice select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
        .pn-composer-box{position:relative;border:1px solid #d0d5dd;border-radius:10px;padding:8px 10px;background:#fff;min-width:0}.pn-composer-box:focus-within{border-color:var(--primary,#175cd3);box-shadow:0 0 0 2px var(--primary-light,#eef2ff)}.pn-composer-box .fm-ch-formatbar{gap:2px;margin-bottom:6px;padding-bottom:6px;flex-wrap:wrap}.pn-composer-box .fm-ch-formatbar button{border:0;background:transparent;min-width:28px;height:28px;padding:4px!important;cursor:pointer}
        .pn-composer-box .fm-ch-rich-editor,.pn-composer-box textarea{box-sizing:border-box;display:block;width:100%;min-height:84px;max-height:180px;overflow:auto;border:0;outline:none;resize:none;padding:8px 2px;font:inherit;font-size:12px;line-height:1.5;background:transparent;color:#101828;white-space:pre-wrap;overflow-wrap:anywhere}.pn-composer-box .fm-ch-rich-editor:empty:before{content:attr(data-placeholder);color:#98a2b3;pointer-events:none}.pn-composer-box .fm-ch-rich-editor p{margin:0}.pn-composer-box .fm-ch-rich-editor blockquote{border-left:3px solid #d0d5dd;padding-left:10px;margin:6px 0}
        .pn-compose-actions{gap:4px;margin-top:6px;flex-wrap:wrap}.pn-compose-actions .pn-icon{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:#667085;font-size:14px;cursor:pointer}.pn-compose-actions .pn-icon:hover{background:#f2f4f7;color:var(--primary,#175cd3)}.pn-compose-actions .pn-icon.voice-active{background:#fef3f2;color:#d92d20}.pn-workspace button:disabled{opacity:.45;cursor:default}.pn-workspace button:focus-visible,.pn-menu summary:focus-visible,.pn-visibility-choice:focus-within{outline:2px solid var(--primary,#175cd3);outline-offset:2px}.pn-add{margin-left:auto}.pn-add button{height:28px;padding:0 9px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;background:var(--primary,#175cd3);color:var(--on-primary,#fff)}.pn-add button[hidden]{display:none}.pn-uploads:empty,.pn-emoji-pop[hidden]{display:none}.pn-emoji-pop{position:absolute;bottom:44px;left:0;right:0;z-index:100;background:white;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 8px 24px #10182820;max-height:320px;overflow:auto}.pn-cancel-edit{align-self:flex-start;font-size:11px}.pn-cancel-edit[hidden]{display:none}
        @container (max-width:300px){.pn-visibility>span{display:none}.pn-composer{padding:10px}.pn-history{padding:10px}.pn-card{padding:11px}.pn-compose-actions{gap:2px}}
      `;
      document.head.append(style);
    }
    container.replaceChildren();
    const extraStyle=document.createElement('style');
    extraStyle.textContent=`
      .pn-card-content{overflow-x:auto}.pn-card-content table{border-collapse:collapse;margin:8px 0;width:100%;table-layout:fixed}.pn-card-content td,.pn-card-content th{border:1px solid #e4e7ec;padding:7px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top}.pn-card-content th{background:#f7f8fa;font-weight:700}
      .pn-tools{flex-wrap:wrap;padding:7px 12px;gap:5px}.pn-heading{font-size:11px;font-weight:600;color:#667085;margin-right:auto}.pn-tools button{border:0;background:transparent;cursor:pointer;font:inherit;font-size:10px;padding:6px;color:#667085}.pn-tools button:hover{background:#f2f4f7}.pn-tools [data-search-toggle]{width:28px;height:28px;padding:0;font-size:12px}.pn-search-row{display:flex;gap:4px;width:100%}.pn-search-row[hidden]{display:none}.pn-search-row input{flex:1}.pn-search-row button{font-size:13px}
      .pn-history{padding:10px 12px}.pn-card{padding:10px 11px;margin-bottom:8px;border-radius:10px}.pn-card-content{margin-top:6px}.pn-card-content p{margin:4px 0}.pn-card footer{border:0;padding-top:0;margin-top:7px;align-items:flex-end;gap:6px;font-size:10px}.pn-card footer .pn-audience{margin-right:auto;min-width:0}.pn-card footer .pn-visibility-button{margin-left:0!important;padding:0!important;color:#667085;font-size:10px!important;max-width:180px}.pn-card footer .pn-audience-chevron{display:none}.pn-card footer .pn-visibility-button:disabled{opacity:1;cursor:default}.pn-card footer>[data-act=replies]{padding:0;margin-left:auto;border-radius:0;font-size:10px;color:#667085}.pn-card .pn-more{display:inline-block;border:0;border-radius:0;background:none;padding:0;margin-top:5px;color:var(--primary,#175cd3);font:inherit;font-size:11px;font-weight:700;cursor:pointer}.pn-card .pn-more[hidden]{display:none}.pn-card .pn-more:hover{background:none;text-decoration:underline}.pn-edited-label{color:#98a2b3;font-size:9px}.pn-archived .pn-card-content{color:#667085}.pn-audience-menu button{border:1px solid #e4e7ec;border-radius:5px;padding:5px 8px;background:white;color:#344054}.pn-audience-menu button:disabled{opacity:.45;cursor:default}.pn-audience-menu button:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}.pn-audience-apply-row{display:flex;justify-content:flex-end;gap:6px;margin:5px}.pn-audience-apply-row button{font:inherit;font-size:11px;cursor:pointer}.pn-audience-apply-row [data-audience-apply]{background:var(--primary,#175cd3);border-color:var(--primary,#175cd3);color:var(--on-primary,#fff)}.pn-audience-error{font-size:11px;color:#b42318;padding:5px}.pn-audience-group-label{margin:6px 7px 2px;color:#98a2b3;font-size:10px;text-transform:uppercase}
      .pn-card .pn-avatar{border:0;padding:0;overflow:hidden;cursor:pointer;width:30px;height:30px;border-radius:50%;background:var(--primary-light,#eef2ff);color:var(--primary,#175cd3)}.pn-avatar img{width:100%;height:100%;object-fit:cover}.pn-pin-toggle{border:0!important;background:transparent!important;color:#b54708!important;cursor:pointer;padding:4px!important}.pn-card-content[hidden],.pn-card footer[hidden],.pn-inline-edit[hidden]{display:none}
      .pn-visibility-choice{max-width:100%;min-width:0}.pn-composer-head{flex-wrap:wrap}.pn-visibility-button{display:inline-flex;align-items:center;gap:5px;border:0!important;background:transparent!important;font:inherit;font-size:11px!important;cursor:pointer;min-width:0;max-width:190px;padding:4px!important}.pn-visibility-button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pn-audience{position:relative;min-width:0}.pn-audience-menu{position:absolute;bottom:100%;right:0;z-index:100;width:220px;max-width:calc(100vw - 36px);max-height:230px;overflow:auto;padding:7px;background:white;border:1px solid #e4e7ec;border-radius:9px;box-shadow:0 8px 24px #10182820}.pn-audience-menu[hidden]{display:none}.pn-audience-menu label{display:flex;gap:8px;align-items:center;white-space:normal;padding:7px;font-size:12px;cursor:pointer;border-radius:5px}.pn-audience-menu label:hover{background:#f2f4f7}.pn-audience-menu input{accent-color:var(--primary,#175cd3)}.pn-audience-menu p{font-size:11px;color:#667085;margin:4px 7px}.pn-audience-current{font-size:10px!important;border-bottom:1px solid #f2f4f7;padding-bottom:7px}
      .pn-inline-edit{margin-top:12px}.pn-inline-edit .pn-composer-box{padding:7px 8px}.pn-inline-edit .fm-ch-rich-editor{min-height:72px}.pn-inline-edit-head{font-size:10px;font-weight:600;color:#667085;margin-bottom:7px}.pn-inline-edit-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap;margin-top:8px}.pn-inline-edit-actions .pn-audience{margin-right:auto}.pn-inline-edit-actions>button{font:inherit;font-size:11px;cursor:pointer}.pn-inline-edit-actions [type=submit]{background:var(--primary,#175cd3);color:var(--on-primary,#fff);border-color:var(--primary,#175cd3)}.pn-card:has(.pn-inline-edit) .pn-menu{display:none}.pn-inline-error,.pn-error{color:#b42318;font-size:11px;padding:6px 0}.pn-error{padding:7px 14px}.pn-error[hidden],.pn-inline-error[hidden]{display:none}.pn-history-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.pn-history-close{display:grid;place-items:center;width:24px;height:24px;border:0;background:transparent;color:#667085;border-radius:5px;cursor:pointer}.pn-history-close:hover{background:#f2f4f7}.pn-card .pn-menu>div{width:170px}.pn-card footer>span{min-width:0;overflow-wrap:anywhere}
    `;
    extraStyle.textContent+=`
      .pn-card header .pn-author{gap:0;line-height:1.2}.pn-card .pn-author>span{line-height:1.2}.pn-card .pn-author time{line-height:1.1;margin-top:1px}.pn-card header{min-height:26px}.pn-card .pn-avatar{width:26px;height:26px}.pn-card-content{margin-top:3px}
      .pn-workspace .pn-replies-wrap{margin-top:8px;padding:0 0 0 8px;gap:8px}.pn-reply-card{padding:5px 0;font-size:12px}.pn-reply-card header{font-size:11px;gap:7px;min-height:24px}.pn-reply-card .pn-avatar{width:24px;height:24px}.pn-reply-card .pn-card-content{max-height:none;margin-top:4px}.pn-reply-card .pn-card-content p{margin:3px 0}.pn-reply-card footer:empty{display:none}.pn-reply-card footer{margin-top:3px}.pn-reply-card .pn-menu>div{width:145px}.pn-reply-compose{display:block;margin-top:2px;min-width:0}.pn-reply-compose .pn-composer-box{padding:7px 8px;box-shadow:0 3px 12px #1018280a}.pn-reply-compose .fm-ch-rich-editor{min-height:72px}.pn-reply-compose .pn-add button{border-radius:6px}.pn-workspace .pn-reply-compose .pn-reply-close{position:absolute;top:7px;right:7px;z-index:2;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:transparent;color:#667085;cursor:pointer}.pn-reply-close:hover{background:#f2f4f7}.pn-reply-compose .pn-editor-mount>.fm-ch-formatbar{margin-right:24px}.pn-reply-error{font-size:11px;color:#b42318;margin:4px 0}.pn-reply-error[hidden]{display:none}
    `;
    extraStyle.textContent+=`
      .pn-workspace .pn-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #eef0f3}.pn-search{display:flex;min-width:0;align-items:center;gap:7px;border:1px solid #e4e7ec;border-radius:6px;padding:0 8px;color:#98a2b3}.pn-workspace .pn-tools .pn-search input{font:inherit;font-size:11px;border:0;background:transparent;min-width:0;width:100%;height:30px;outline:none;color:#202124;padding:0;box-sizing:border-box}.pn-search:focus-within{outline:2px solid var(--primary,#175cd3);outline-offset:1px}.pn-workspace .pn-tools [data-note-filters]{display:flex;align-items:center;gap:6px;font:inherit;font-size:11px;max-width:120px;min-width:0;height:32px;border:1px solid transparent;background:#f5f6f8;border-radius:5px;padding:5px 8px;color:#475467;cursor:pointer}.pn-tools [data-note-filters] span{white-space:nowrap}.pn-workspace .pn-tools [data-note-filters][aria-pressed=true]{color:var(--primary,#175cd3);background:var(--primary-light,#eef2ff)}.pn-reply-compose[hidden],.pn-reply-add-row button[hidden]{display:none}.pn-reply-add-row{display:flex;justify-content:flex-end}.pn-workspace .pn-reply-add-row button{border:0;background:transparent;padding:3px 0;font:inherit;font-size:11px;color:var(--primary,#175cd3);cursor:pointer}
    `;
    extraStyle.textContent+=`.pn-workspace .pn-replies-wrap{border-left:0;padding-left:0}.pn-reply-list{border-left:2px solid #eef1f5;padding-left:8px}.pn-reply-list:empty{display:none}`;
    extraStyle.textContent+=`.pn-composer .pn-editor-mount>.fm-ch-rich-editor,.pn-composer .pn-editor-mount>textarea{min-height:76px}.pn-main-audience{float:right;margin:0 0 3px 5px;max-width:max(60px,calc(100% - 190px))}.pn-main-audience .pn-visibility-button{max-width:100%;padding:4px 0!important;font-size:10px!important}.pn-composer .pn-composer-box>.pn-editor-mount>.fm-ch-formatbar{min-height:28px;margin-right:0}.pn-author-name[data-fm-summary-type]{cursor:pointer}.pn-author-name:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px;border-radius:3px}`;
    extraStyle.textContent+=`      .pn-workspace [data-note-filters]{display:flex;align-items:center;gap:6px;font:inherit;font-size:11px;max-width:120px;min-width:0;height:32px;border:1px solid transparent;background:#f5f6f8;border-radius:5px;padding:5px 8px;color:#475467;cursor:pointer}.pn-workspace [data-note-filters] span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.pn-workspace [data-note-filters][data-active=true]{color:var(--primary,#175cd3);background:var(--primary-light,#eef2ff)}
      .pn-filter-menu{position:absolute;left:12px;right:12px;z-index:20;display:flex;flex-direction:column;overflow:hidden;background:white;border:1px solid #e4e7ec;border-radius:8px;box-shadow:0 8px 24px #10182824;padding:6px}.pn-filter-menu[hidden]{display:none}
      .pn-filter-menu .pn-search{flex:none;margin:2px 2px 6px}.pn-filter-menu .pn-search input{flex:1;box-sizing:border-box;width:100%;min-width:0;height:30px;border:0;background:transparent;padding:0;margin:0;font:inherit;font-size:11px;color:#202124;outline:none}
      .pn-filter-options{min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 0}.pn-filter-option{display:flex;align-items:center;border-radius:5px;min-height:32px}.pn-filter-option[hidden]{display:none}.pn-filter-option:hover,.pn-filter-option:focus-within{background:#f5f6f8}.pn-filter-option[data-selected=true]{background:var(--primary-light,#eef2ff)}
      .pn-filter-option label{display:flex;flex:1;align-items:center;min-width:0;gap:7px;padding:7px 6px;cursor:pointer;font-size:11px}.pn-filter-option input{width:13px;height:13px;margin:0;accent-color:var(--primary,#175cd3);flex:none}.pn-filter-option label>i{width:13px;text-align:center;color:#667085}.pn-filter-total{margin-left:auto;color:#98a2b3;font-size:10px;font-variant-numeric:tabular-nums}
      .pn-filter-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 4px 2px;border-top:1px solid #eef0f3;color:#667085;font-size:10px}.pn-filter-footer button{font:inherit;color:var(--primary,#175cd3);border:0;background:transparent;cursor:pointer;padding:4px}.pn-filter-none{padding:12px 6px;font-size:11px;color:#667085}.pn-filter-none[hidden]{display:none}

.pn-workspace .pn-composer{background:transparent;border:0;padding:0 12px 10px}.pn-filter-footer label{display:flex;align-items:center;gap:5px;cursor:pointer}.pn-workspace{position:relative}.pn-filter-menu{top:50px;max-height:min(350px,calc(100% - 60px))}.pn-gif-preview img,.pn-card-content .fm-ch-gif img{max-width:100%;height:auto}.pn-card-content>.fm-ch-gif:first-child{margin-top:0}.pn-workspace [data-note-filters][data-active=true]{color:var(--primary,#175cd3);background:var(--primary-light,#eef2ff)}.pn-audience-menu{max-height:360px}.pn-audience-search{box-sizing:border-box;width:100%;margin:4px 0 2px;border:1px solid #e4e7ec;border-radius:5px;padding:6px;font:inherit;font-size:11px}.pn-audience-search:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:1px}
`;
    extraStyle.textContent+=`.pn-workspace{background:#fafbfc}.pn-workspace .pn-history{position:relative;z-index:0;margin-bottom:-20px;padding-bottom:28px;mask-image:linear-gradient(to bottom,#000 calc(100% - 8px),transparent 100%);-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 8px),transparent 100%)}.pn-workspace .pn-composer{position:relative;z-index:1;padding-top:24px;background:transparent}`;
    extraStyle.textContent+=`.pn-card footer>[data-act=replies],.pn-workspace .pn-reply-add-row button{border:0;background:transparent;padding:0;border-radius:0;font:inherit;font-size:10px;font-weight:400;color:#667085;cursor:pointer;line-height:normal}.pn-card footer>[data-act=replies][hidden],.pn-reply-add-row[hidden]{display:none}`;
    extraStyle.textContent+=`
      .pn-workspace .pn-uploads{display:flex;gap:7px;flex-wrap:wrap;overflow:visible;max-height:none}
      .pn-workspace .pn-composer-box{padding:5px 7px 3px}
      .pn-workspace .pn-editor-mount>.fm-ch-rich-editor,.pn-workspace .pn-editor-mount>textarea{box-sizing:border-box;min-height:44px;padding:2px 0;line-height:20px;font-size:13px;max-height:220px}
      .pn-workspace .pn-editor-mount>.fm-ch-formatbar{border-bottom:0;padding-bottom:0;margin-bottom:2px;min-height:26px;flex-wrap:nowrap}
      .pn-workspace .pn-compose-actions{margin-top:4px;gap:3px;min-height:26px}
      .pn-workspace .pn-compose-actions>.pn-icon,.pn-workspace .pn-compose-actions>[data-mention-button]{width:26px;height:26px;padding:3px;border:0;background:transparent;cursor:pointer;color:#667085;border-radius:5px}
      .pn-workspace .pn-inline-edit-actions{margin-top:4px}.pn-workspace .pn-add button{height:26px;min-height:0;padding:3px 7px}
      .pn-workspace .pn-main-audience{float:none;position:absolute;right:7px;top:5px;max-width:105px;margin:0}
      .pn-workspace .pn-composer .pn-editor-mount>.fm-ch-formatbar{margin-right:110px}
      .pn-workspace .pn-compose-actions>[hidden]{display:none!important}
    `;
    container.append(extraStyle);
    let disposed=false,busy=false,prepared=[],query='',showArchived=false,editSession=null,gifDraft=null;
    const lifetime=new AbortController(),captureAbort=new AbortController(),expanded=new Set(),replyThreads=new Map();
    const voiceIcon=mode=>`<span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:18px;height:18px;background:currentColor;mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat;mask-mode:alpha"></span>`;
    function bindNoteEnterToSend(editor,send){editor.addEventListener('keydown',event=>{const menu=document.getElementById('fmMentionMenu');if(event.key!=='Enter' || event.shiftKey || event.defaultPrevented || event.isComposing || event.keyCode===229 || (menu?.classList.contains('visible') && menu._mentionOwner===editor))return;event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)send();},{capture:true,signal:lifetime.signal});}
    function composerBoxHtml(replyMode=false){return `<div class="pn-composer-box">${replyMode ? '<button type="button" class="pn-reply-close" data-close-reply title="Close reply composer" aria-label="Close reply composer"><i class="fas fa-xmark" aria-hidden="true"></i></button>' : ''}<div class="pn-editor-mount"></div><div class="pn-uploads"></div><div class="pn-gif-preview"></div><div class="pn-compose-actions"><button type="button" class="pn-icon" data-emoji title="Insert emoji" aria-label="Insert emoji" aria-expanded="false"><i class="fas fa-face-smile"></i></button><button type="button" class="pn-icon" data-attach title="Attach a file" aria-label="Attach a file"><i class="fas fa-paperclip"></i></button><input type="file" hidden multiple><button type="button" class="pn-icon" data-dictate title="Dictate message" aria-label="Dictate message" aria-pressed="false">${voiceIcon('dictation')}</button><button type="button" class="pn-icon" data-audio title="Record an audio note" aria-label="Record an audio note" aria-pressed="false">${voiceIcon('record')}</button><div class="pn-add"><button type="submit" title="${replyMode ? 'Send reply' : copy('Add note')}" aria-label="${replyMode ? 'Send reply' : copy('Add note')}"><i class="fas fa-paper-plane" aria-hidden="true"></i></button><button type="button" ${replyMode ? 'hidden' : ''} data-pin-send title="${copy('Add pinned note')}" aria-label="${copy('Add pinned note')}"><i class="fas fa-thumbtack"></i></button></div></div><div class="pn-emoji-pop" hidden></div></div>`;}
    container.insertAdjacentHTML('beforeend',`<section class="pn-workspace"><div class="pn-tools"><label class="pn-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" aria-label="Search project notes" placeholder="Search notes…"></label><button type="button" data-note-filters aria-label="Filter project notes" aria-expanded="false"><i class="fas fa-sliders" aria-hidden="true"></i><span>Filters</span></button></div><div class="pn-pinned" aria-label="Pinned notes"></div><div class="pn-history" role="log" aria-label="Project notes history"></div><div class="pn-error" role="alert" hidden></div><form class="pn-composer">${composerBoxHtml()}</form></section>`);
    if(commentMode)for(const element of container.querySelectorAll('[aria-label],[placeholder]'))for(const name of ['aria-label','placeholder'])if(element.hasAttribute(name))element.setAttribute(name,copy(element.getAttribute(name)));
    const mainBox=container.querySelector('.pn-composer-box');mainBox.insertAdjacentHTML('afterbegin','<div class="pn-main-audience pn-audience"></div>');
    const history=container.querySelector('.pn-history'),pinned=container.querySelector('.pn-pinned'),form=container.querySelector('.pn-composer'),uploadBox=container.querySelector('.pn-uploads'),errorBox=container.querySelector('.pn-error');
    const widgets=window.FirstMateChannels?.composerWidgets,esc=escapeHtml;
    let directory={departments:[],users:[],selectable_department_ids:[],note_department_visibility:false};
    const directoryReady=channels()?.directory?.list?.(orgId()).then(data=>{directory=data;return data;}).catch(()=>null) || Promise.resolve(null);
    function say(value=''){if (!disposed){errorBox.textContent=value;errorBox.hidden=!value;}}
    function mountNotePolish(editor,owner,isBusy,onError,onSettled,isCurrent=()=>!disposed,closeComposerMenus=()=>closeEmoji()){
      if(!channels()?.compose?.polish)return null;
      const handle=widgets?.polishButton?.(editor,owner.querySelector('.pn-compose-actions'),{
        lockRoot:owner,isBusy,isCurrent,identity:()=>entry.projectId,onError,onSettled,
        closeMenus:()=>{closeComposerMenus();for(const host of owner.querySelectorAll('.pn-audience'))audienceClosers.get(host)?.();},
        request:async(input,options)=>{await ready;if(!entry.channelId)throw Error('Choose a saved project before polishing a note.');if(options.signal.aborted)throw options.signal.reason;return channels().compose.polish(orgId(),entry.channelId,input,options);}
      });handle?.button.classList.add('pn-icon');return handle;
    }
    function createEditor(mount,placeholder){
      const editor=widgets?.createEditor ? widgets.createEditor(placeholder) : document.createElement('textarea');
      editor.setAttribute('aria-label',placeholder);editor.placeholder=placeholder;
      if(widgets?.formatBar)mount.append(widgets.formatBar(editor));
      mount.append(editor);
      const owner=mount.closest('form'),actions=owner?.querySelector('.pn-compose-actions');
      if(actions){const mention=widgets?.mentionButton?.(editor,owner,{mount:actions,onError:cause=>say(cause.message)});if(mention)actions.querySelector('.pn-add')?.before(mention);const more=widgets?.moreActions?.(actions,[owner.querySelector('[data-audio]')]);if(more){more.classList.add('pn-icon');actions.querySelector('.pn-add')?.before(more);}}
      return editor;
    }
    const selectedAuthors=new Set();let projectAuthors=null,filteredBefore=0,authorRequest=0,allAuthorsSelected=true;
    const audienceClosers=new WeakMap(),audienceMenus=new WeakMap(),audienceHandles=new Set();
    const crewUsersLabel=()=>window.PlatformTerminology?.get?.('workforce.worker_plural','Crew Members') || 'Crew Members';
    // Picker copy. Group words come from the terminology system; nothing names a kind of group.
    const groupsWord=()=>window.PlatformTerminology?.get?.('workforce.resource_group_plural',null) || (globalThis.PlatformLanguage?.text("project-notes","note_audience_groups_heading","Groups") ?? "Groups");
    const groupKindLabel=name=>((v0,v1)=>globalThis.PlatformLanguage?.text("project-notes","note_audience_group_kind_all",`All ${v0} ${v1}`,{v0,v1}) ?? `All ${v0} ${v1}`)(name,groupsWord().toLowerCase());
    const everybodyLabel=()=>globalThis.PlatformLanguage?.text("project-notes","note_audience_everybody","Everybody") ?? "Everybody";
    function audienceRefLabel(ref){return ref.kind==='user' ? (directory.users || []).find(u=>u.id===ref.id)?.name || 'Selected user' : ref.kind==='resource_group' ? (directory.note_audience_groups || []).find(g=>g.id===ref.id)?.label || 'Selected group' : groupKindLabel((directory.note_audience_group_kinds || []).find(k=>k.id===ref.id)?.name || 'selected');}
    function noteAudienceLabel(note){
      if(note.metadata?.note_audience_refs?.length)return note.metadata.note_audience_refs.map(audienceRefLabel).join(' and ');
      if(note.metadata?.department_access==='restricted'){
        const labels=(note.metadata.department_ids || []).map(id=>directory.departments?.find(d=>d.id===id)?.label || 'Department');
        if(note.metadata.note_audience_crew === true)labels.push(crewUsersLabel());
        return labels.length===1 ? labels[0]+' only' : labels.join(' and ') || 'Selected audience';
      }
      const labels=(note.visibility || GROUPS).map(id=>id[0].toUpperCase()+id.slice(1));
      return labels.length===GROUPS.length ? everybodyLabel() : labels.length===1 ? labels[0]+' only' : labels.join(' and ');
    }
    function audienceChooser(host,note=null,options={}){
      const originalIds=note?.metadata?.department_access==='restricted' ? [...(note.metadata.department_ids || [])] : [],originalCrew=note?.metadata?.note_audience_crew===true,originalLegacy=note && note.visibility.length<GROUPS.length ? [...note.visibility] : [];
      const originalRefs=note?.metadata?.note_audience_refs || [];
      let refs=[...originalRefs],audienceQuery='',ids=[...originalIds],crew=originalCrew,legacy=[...originalLegacy],changed=false,loaded=false,saving=false;
      host.innerHTML='<button type="button" class="pn-visibility-button" aria-label="Choose note visibility" aria-expanded="false" disabled><i class="fas fa-eye" aria-hidden="true"></i><span>Visibility</span><i class="fas fa-chevron-down pn-audience-chevron" aria-hidden="true"></i></button><div class="pn-audience-menu" hidden></div>';
      const button=host.querySelector('button'),menu=host.querySelector('.pn-audience-menu');
      // What the picker offers comes from the directory: departments when there is more than one to choose,
      // groups when the organization has them switched on and has some, people always. One section shows
      // without a heading. The retired "Application access" audience is never offered; a note that has it
      // keeps it until its author picks something else.
      function offered(){
        const departmentMode=directory.note_department_visibility===true,sections=directory.note_audience_sections || {};
        const departments=departmentMode ? (directory.departments || []).filter(d=>(directory.selectable_department_ids || []).includes(d.id)) : GROUPS.map(id=>({id,label:id[0].toUpperCase()+id.slice(1)}));
        const groups=[...(directory.note_audience_group_kinds || []).map(k=>({kind:'resource_group_kind',id:k.id,label:groupKindLabel(k.name)})),...(directory.note_audience_groups || []).map(g=>({kind:'resource_group',id:g.id,label:g.label}))];
        const people=directory.note_advanced_visibility===true ? (directory.note_audience_users || []).map(u=>({kind:'user',id:u.id,label:u.name || u.email || 'Teammate'})) : [];
        const show={departments:departmentMode ? sections.departments!==false && departments.length>1 : true,groups:sections.groups!==false && groups.length>0,people:directory.note_advanced_visibility===true};
        return {departmentMode,departments:show.departments ? departments : [],groups:show.groups ? groups : [],people,show,headed:Object.values(show).filter(Boolean).length>1};
      }
      function draw(){
        const {departmentMode,departments,groups,people,show,headed}=offered();
        const selected=departmentMode ? ids : legacy,labels=selected.map(id=>(directory.departments || []).find(d=>d.id===id)?.label || departments.find(d=>d.id===id)?.label || 'Department');labels.push(...refs.map(audienceRefLabel));
        const label=!changed && note ? noteAudienceLabel(note) : labels.join(' and ') || everybodyLabel();
        button.querySelector('span').textContent=label;button.title=label;
        const everybody=!selected.length && !crew && !refs.length && !(legacy.length && departmentMode && !changed);
        const picked=row=>refs.some(r=>r.kind===row.kind && r.id===row.id);
        const visiblyPicked=departments.some(d=>selected.includes(d.id)) || [...groups,...people].some(picked);
        const query=audienceQuery.trim().toLowerCase(),matches=row=>!query || row.label.toLowerCase().includes(query);
        const heading=text=>headed ? `<div class="pn-audience-group-label">${esc(text)}</div>` : '';
        const refRows=rows=>rows.filter(matches).map(row=>`<label><input type="checkbox" data-audience-ref="${row.kind}" value="${esc(row.id)}" ${picked(row) ? 'checked' : ''}>${esc(row.label)}</label>`).join('');
        const departmentWord=directory.note_department_label || 'Departments',peopleWord=globalThis.PlatformLanguage?.text("project-notes","note_audience_people_heading","People") ?? "People";
        const searchLabel=show.groups ? (globalThis.PlatformLanguage?.text("project-notes","note_audience_find_groups_people","Find groups and people") ?? "Find groups and people") : (globalThis.PlatformLanguage?.text("project-notes","note_audience_find_people","Find people") ?? "Find people");
        const searchable=show.groups || show.people,shown=[...groups,...people].filter(matches).length;
        menu.innerHTML=`<label><input type="checkbox" data-audience-all ${everybody ? 'checked' : ''}>${esc(everybodyLabel())}</label>`
          +(note && !changed && !everybody && !visiblyPicked ? `<p class="pn-audience-current">Current: ${esc(noteAudienceLabel(note))}. Select an audience to update.</p>` : '')
          +(show.departments ? `<div class="pn-audience-section" role="group" aria-label="${esc(departmentWord)}">${departmentMode ? heading('Your '+departmentWord) : ''}${departments.map(d=>`<label><input type="checkbox" value="${esc(d.id)}" ${selected.includes(d.id) ? 'checked' : ''}>${esc(d.label)}</label>`).join('')}</div>` : '')
          +(searchable ? `<input type="search" class="pn-audience-search" aria-label="${esc(searchLabel)}" placeholder="${esc(searchLabel)}…" value="${esc(audienceQuery)}">` : '')
          +(show.groups ? `<div class="pn-audience-section" role="group" aria-label="${esc(groupsWord())}">${groups.some(matches) ? heading(groupsWord()) : ''}${refRows(groups)}</div>` : '')
          +(show.people ? `<div class="pn-audience-section" role="group" aria-label="${esc(peopleWord)}">${people.some(matches) ? heading(peopleWord) : ''}${refRows(people)}</div>` : '')
          +(searchable && query && !shown ? `<p class="pn-audience-empty" role="status">${globalThis.PlatformLanguage?.htmlText("project-notes","note_audience_no_matches","No matches") ?? "No matches"}</p>` : '')
          +(options.onApply ? '<div class="pn-audience-error" role="alert" hidden></div><div class="pn-audience-apply-row"><button type="button" data-audience-cancel>Cancel</button><button type="button" data-audience-apply>Apply</button></div>' : '');
        if(options.onApply)menu.querySelector('[data-audience-apply]').disabled=!changed || saving;
        if(saving)menu.querySelectorAll('button,input').forEach(node=>node.disabled=true);
      }
      function close(){if(options.onApply && !saving){ids=[...originalIds];crew=originalCrew;refs=[...originalRefs];legacy=[...originalLegacy];changed=false;draw();}menu.hidden=true;button.setAttribute('aria-expanded','false');host.append(menu);menu.style.cssText='';}
      // include_crew is never sent: a changed audience replaces the whole audience, so the retired one drops off.
      function payload(){if(!loaded)throw Error('Visibility is still loading. Try again.');return directory.note_department_visibility && (!note || changed) ? {audience:[],department_ids:ids,...(directory.note_advanced_visibility === true ? {audience_refs:refs} : {})} : {audience:legacy};}
      function position(){const rect=button.getBoundingClientRect(),height=menu.offsetHeight,width=menu.offsetWidth;let layer=100000;for(let node=host;node;node=node.parentElement){const z=Number.parseInt(getComputedStyle(node).zIndex,10);if(Number.isFinite(z))layer=Math.max(layer,z+20);}menu.style.zIndex=String(Math.min(2147483647,layer));menu.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-width-8))+'px';const top=rect.top-height-7>=8 ? rect.top-height-7 : rect.bottom+7;menu.style.top=Math.max(8,Math.min(top,window.innerHeight-height-8))+'px';}
      const handle={host,menu,refresh(){draw();if(!menu.hidden)position();},destroy(){menu.remove();audienceHandles.delete(handle);}};audienceHandles.add(handle);
      audienceClosers.set(host,close);audienceMenus.set(host,menu);
      button.onclick=()=>{if(!menu.hidden){close();return;}draw();document.body.append(menu);menu.hidden=false;menu.style.position='fixed';menu.style.bottom='auto';menu.style.right='auto';button.setAttribute('aria-expanded','true');position();};
      menu.setAttribute('role','group');menu.setAttribute('aria-label','Note visibility');
      menu.onchange=event=>{
        const input=event.target;if(!input.matches('input[type=checkbox]'))return;
        const {departmentMode,groups,people}=offered();let selected=departmentMode ? ids : legacy;
        // Any change ends the retired audience; references the picker no longer offers are dropped, never kept hidden.
        crew=false;refs=refs.filter(ref=>[...groups,...people].some(row=>row.kind===ref.kind && row.id===ref.id));
        if(input.hasAttribute('data-audience-all')){selected=[];refs=[];}
        else if(input.hasAttribute('data-audience-ref')){const kind=input.dataset.audienceRef;selected=[];refs=refs.filter(ref=>ref.kind!==kind || ref.id!==input.value);if(input.checked)refs.push({kind,id:input.value,...(kind==='resource_group_kind' ? {department_ids:directory.note_audience_organization_wide ? [] : directory.note_audience_kind_department_ids || []} : {})});}
        else {refs=[];selected=input.checked ? unique([...selected,input.value]) : selected.filter(id=>id!==input.value);}
        if(departmentMode){ids=selected;legacy=[];}else legacy=selected;
        changed=true;draw();
        const active=input.hasAttribute('data-audience-all') ? menu.querySelector('[data-audience-all]') : input.hasAttribute('data-audience-ref') ? menu.querySelector(`input[data-audience-ref="${input.dataset.audienceRef}"][value="${CSS.escape(input.value)}"]`) : menu.querySelector(`input:not([data-audience-ref])[value="${CSS.escape(input.value)}"]`);active?.focus();
      };
      menu.oninput=event=>{if(!event.target.matches('[type=search]'))return;audienceQuery=event.target.value;const start=event.target.selectionStart;draw();const search=menu.querySelector('[type=search]');search.focus();try{search.setSelectionRange(start,start);}catch{}position();};
      menu.onclick=async event=>{
        if(event.target.closest('[data-audience-cancel]')){close();return;}
        if(!event.target.closest('[data-audience-apply]') || !options.onApply || saving || !changed)return;
        const selected=payload();saving=true;draw();
        try{await options.onApply(selected);menu.hidden=true;button.setAttribute('aria-expanded','false');}
        catch(error){saving=false;draw();const message=menu.querySelector('.pn-audience-error');message.textContent=error.message || 'Could not update visibility.';message.hidden=false;}
        finally{saving=false;}
      };
      directoryReady.then(data=>{if(disposed || !host.isConnected)return;if(!data){button.querySelector('span').textContent='Visibility unavailable';return;}loaded=true;button.disabled=!!options.readOnly;draw();});
      return {payload,close};
    }
    const text=createEditor(form.querySelector('.pn-editor-mount'),commentMode ? 'Leave a comment.' : 'Add an internal note.');text.setAttribute('aria-label',copy('New project note'));
    const mentions=window.FirstMateTags?.attachMentionTextarea?.(text,{orgId:orgId(),source:'project_notes'}),audience=audienceChooser(form.querySelector('.pn-audience'));
    text._mentionApi=mentions;
    const sendButton=form.querySelector('[type=submit]'),dictateButton=form.querySelector('[data-dictate]'),audioButton=form.querySelector('[data-audio]');
    let capturing=false,captureMode='',recorderControl=null,uploading=0,emojiPicker=null;
    const emojiButton=form.querySelector('[data-emoji]'),emojiPop=form.querySelector('.pn-emoji-pop');
    const closeEmoji=()=>{emojiPicker?.destroy?.();emojiPicker=null;emojiPop.hidden=true;emojiButton.setAttribute('aria-expanded','false');};
    emojiButton.onclick=()=>{
      if(!emojiPop.hidden){closeEmoji();return;}emojiPop.hidden=false;emojiButton.setAttribute('aria-expanded','true');
      emojiPicker=window.FirstMateChannels?.mountEmojiPicker?.(emojiPop,emoji=>{text.insertText ? text.insertText(emoji) : text.setRangeText(emoji,text.selectionStart,text.selectionEnd,'end');text.dispatchEvent(new Event('input',{bubbles:true}));closeEmoji();text.focus();});emojiPicker?.focus?.();
    };
    form.querySelector('[data-attach]').onclick=()=>form.querySelector('[type=file]').click();
    function syncSendState(){if(text._polishApi?.polishing)return;text._polishApi?.refresh();sendButton.disabled=busy || capturing || uploading>0 || (!clean(text.value) && !prepared.length && !gifDraft);form.querySelector('[data-pin-send]').disabled=sendButton.disabled;if(!capturing){dictateButton.disabled=busy;audioButton.disabled=busy || prepared.some(item=>item.kind==='audio');}form.querySelector('[data-attach]').disabled=busy;gifButton.disabled=busy || capturing;}
    const gifHost=form.querySelector('.pn-gif-preview');
    const paintGif=()=>{window.FirstMateGifWidgets?.renderDraft?.(gifHost,gifDraft,()=>{if(busy)return;gifDraft=null;delete form.dataset.operationId;paintGif();syncSendState();});};
    const gifButton=window.FirstMateChannels.createGifPickerButton({orgId:orgId(),onError:error=>say(error.message),onSelect:selected=>{if(disposed || busy || capturing)return;gifDraft=selected;delete form.dataset.operationId;paintGif();syncSendState();}});gifButton.classList.add('pn-icon');emojiButton.after(gifButton);
    function userSummaryAttributes(note){const user=note.created_by || {};return user.id && !user.id.startsWith('agent_') ? ` data-fm-summary-type="summary.user" data-fm-summary-target="${esc(JSON.stringify({scope:'organization',organizationId:orgId(),id:user.id}))}"` : '';}
    function avatarHtml(note){
      const user=note.created_by || {},photo=user.avatar || directory.users?.find(item=>item.id===user.id)?.avatar,initials=(user.name || 'Teammate').split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
      const summary=userSummaryAttributes(note);
      return `<button type="button" class="pn-avatar" aria-label="Preview ${esc(user.name || 'team member')}"${summary}>${photo && /^(https?:|\/)/.test(photo) ? `<img src="${esc(photo)}" alt="" loading="lazy">` : esc(initials)}</button>`;
    }
    function replyToggleLabel(note,open){const count=Number(note?.reply_count) || 0;return count>0 ? `${open ? 'Hide' : 'Show'} ${count} ${count===1 ? 'reply' : 'replies'}` : 'Reply';}
    function card(note){
      const archived=!!note.deleted_at,shared=note.metadata?.note_shared;
      const historyAction=note.edited_at ? '<button type="button" data-act="history">View Edit History</button>' : '';
      const actions=archived ? `${note.can_restore ? '<button type="button" data-act="restore">Unarchive Note</button>' : ''}${historyAction}<button type="button" data-act="copy">Copy text</button>` : `<button type="button" data-act="pin">${note.pinned_at ? 'Unpin Note' : 'Pin Note'}</button>${note.can_edit ? '<button type="button" data-act="edit">Edit Note</button>' : ''}${historyAction}<button type="button" data-act="copy">Copy text</button>${note.can_delete ? '<button type="button" data-act="delete">Archive Note</button>' : ''}`;
      return `<article class="pn-card${archived ? ' pn-archived' : ''}" data-project-note-id="${esc(note.id)}"><header>${avatarHtml(note)}<div class="pn-author"><span class="pn-author-name" tabindex="0"${userSummaryAttributes(note)}>${esc(note.created_by?.name || 'Teammate')}</span><time datetime="${esc(note.created_at)}">${esc(fmtWhen(note.created_at))}${archived ? ' · Archived' : ''}</time></div>${note.pinned_at && !archived ? '<button type="button" class="pn-pin-toggle" data-act="pin" title="Unpin Note" aria-label="Unpin Note"><i class="fas fa-thumbtack" aria-hidden="true"></i></button>' : ''}<details class="pn-menu"><summary aria-label="Note options"><i class="fas fa-ellipsis"></i></summary><div>${actions}</div></details></header><div class="pn-card-content${expanded.has(note.id) ? ' expanded' : ''}" data-pn-content="${esc(note.id)}"></div><button type="button" class="pn-more" data-act="expand" aria-expanded="${expanded.has(note.id)}" hidden><span>${expanded.has(note.id) ? 'Show less' : 'Show more'}</span></button><footer><div class="pn-audience" data-note-audience="${esc(note.id)}"></div>${note.edited_at ? '<span class="pn-edited-label">Edited</span>' : ''}${shared ? '<span>Shared</span>' : ''}${!archived ? `<button type="button" data-act="replies" aria-expanded="${!!replyThreads.get(note.id)?.open}">${replyToggleLabel(note,!!replyThreads.get(note.id)?.open)}</button>` : ''}</footer></article>`;
    }
    function render(){
      if(disposed)return;syncAuthorFilters();const scroll=history.scrollTop,editingNode=editSession?.node,restoreReplyFocus=captureReplyFocus();
      for(const handle of [...audienceHandles])if(handle.host.hasAttribute('data-note-audience') && !editingNode?.contains(handle.host))handle.destroy();
      const rows=entry.notes.filter(note=>(note.metadata?.project_note===true) && (showArchived || !note.deleted_at) && (allAuthorsSelected || selectedAuthors.has(note.created_by?.id || 'unknown')) && (!query || `${note.text} ${note.created_by?.name}`.toLowerCase().includes(query)));
      const pins=rows.filter(note=>note.pinned_at && !note.deleted_at),rest=rows.filter(note=>!note.pinned_at || note.deleted_at).sort((a,b)=>Number(b.seq)-Number(a.seq));
      pinned.hidden=!pins.length;pinned.innerHTML=pins.length ? `<h4>${copy('Pinned notes')}</h4>${pins.map(card).join('')}` : '';history.innerHTML=rest.map(card).join('') || `<p class="pn-empty">${copy(query ? 'No notes match your search.' : !allAuthorsSelected ? 'No notes match your author selections.' : 'No notes yet. Add the first update below.')}</p>`;
      if(allAuthorsSelected ? entry.historyBefore : selectedAuthors.size && filteredBefore)history.insertAdjacentHTML('beforeend','<button type="button" data-load-more>Load older notes</button>');
      for(const note of rows){const target=container.querySelector(`[data-pn-content="${CSS.escape(note.id)}"]`);if(!target)continue;target.innerHTML=(clean(note.translation?.text || note.text) ? (widgets?.renderBody?.({...note,text:note.translation?.text || note.text}) || `<p>${esc(note.text)}</p>`) : '')+audioPlayerHtml(note)+mediaAttachmentsHtml(note)+(window.FirstMateGifWidgets?.renderCard?.(note.metadata?.giphy) || '');}
      if(editingNode?.classList.contains('pn-card')){const replacement=container.querySelector(`[data-project-note-id="${CSS.escape(editSession.id)}"]`);if(replacement)replacement.replaceWith(editingNode);else history.prepend(editingNode);}
      for(const thread of replyThreads.values()){const root=container.querySelector(`.pn-card[data-project-note-id="${CSS.escape(thread.id)}"]`);if(root && thread.open){root.append(thread.node);syncReplyThread(thread);void loadReplyThread(thread);}}
      container.querySelectorAll('.pn-card').forEach(node=>{const content=node.querySelector('.pn-card-content'),more=node.querySelector('.pn-more');if(content && more)more.hidden=content.hidden || (!content.classList.contains('expanded') && content.scrollHeight<=content.clientHeight);});
      for(const note of rows){const host=container.querySelector(`[data-note-audience="${CSS.escape(note.id)}"]`);if(!host || editSession?.id===note.id)continue;audienceChooser(host,note,{readOnly:!note.can_edit || !!note.deleted_at,onApply:async selected=>{await channels().messages.updateVisibility(orgId(),note.id,selected);if(disposed)return;await refresh();announce(entry.projectId);}});}
      window.FirstMateAudioNotes?.hydrate?.(container);history.scrollTop=scroll;restoreReplyFocus();
    }
    async function refresh(){adoptProject();if(entry.projectId){await refreshEntry(entry);await refreshAuthors();if(!allAuthorsSelected && selectedAuthors.size)await loadAuthorNotes();}render();}
    window.addEventListener('fm:terminology:updated',()=>{for(const handle of audienceHandles)handle.refresh();},{signal:lifetime.signal});
    const notified=event=>{if(event.detail?.projectId===entry.projectId && !disposed)render();};window.addEventListener('fm:project-notes:refreshed',notified);
    const searchInput=container.querySelector('.pn-search input');
    searchInput.oninput=event=>{query=event.target.value.toLowerCase();render();};searchInput.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();query='';searchInput.value='';render();}};
    const filterButton=container.querySelector('[data-note-filters]'),filterMenu=document.createElement('div');filterMenu.className='pn-filter-menu';filterMenu.hidden=true;filterMenu.setAttribute('role','dialog');filterMenu.setAttribute('aria-label','Note filters');
    filterMenu.innerHTML='<label class="pn-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" aria-label="Search note authors" placeholder="Search"></label><div class="pn-filter-options" role="group" aria-label="Note authors"></div><div class="pn-filter-footer"><label><input type="checkbox" data-archived-notes>Show Archived Notes</label><button type="button" data-all-authors>Select All</button></div>';
    container.querySelector('.pn-workspace').append(filterMenu);
    const authorSearch=filterMenu.querySelector('input[type=search]');
    function closeFilter(){filterMenu.hidden=true;filterButton.setAttribute('aria-expanded','false');}
    function syncAuthorFilters(){

      const authors=new Map();for(const note of entry.notes){if(note.metadata?.project_note!==true)continue;const user=note.created_by || {},key=user.id || 'unknown';const row=authors.get(key) || {id:key,name:user.name || 'Teammate',count:0};if(showArchived || !note.deleted_at)row.count++;authors.set(key,row);}
      if(projectAuthors)for(const user of projectAuthors)authors.set(user.id,{...user,count:user.count+(showArchived ? user.archived_count : 0)});
      if(allAuthorsSelected){selectedAuthors.clear();for(const key of authors.keys())selectedAuthors.add(key);}else{for(const key of selectedAuthors)if(!authors.has(key))selectedAuthors.delete(key);if(authors.size && [...authors.keys()].every(key=>selectedAuthors.has(key)))allAuthorsSelected=true;}
      const options=filterMenu.querySelector('.pn-filter-options'),focusedAuthor=options.contains(document.activeElement) ? document.activeElement.value : null;options.innerHTML=[...authors.values()].sort((a,b)=>a.name.localeCompare(b.name)).filter(row=>row.name.toLowerCase().includes(authorSearch.value.toLowerCase())).map(row=>`<div class="pn-filter-option" data-selected="${selectedAuthors.has(row.id)}"><label><input type="checkbox" value="${esc(row.id)}" ${selectedAuthors.has(row.id) ? 'checked' : ''}><i class="fas fa-user" aria-hidden="true"></i><span>${esc(row.name)}</span><span class="pn-filter-total">${row.count}</span></label></div>`).join('') || '<div class="pn-filter-none">No matching note authors.</div>';
      if(focusedAuthor!==null)options.querySelector(`input[value="${CSS.escape(focusedAuthor)}"]`)?.focus({preventScroll:true});
      filterButton.dataset.active=String(!allAuthorsSelected || showArchived);
      filterMenu.querySelector('[data-all-authors]').textContent=allAuthorsSelected ? 'Deselect All' : 'Select All';
      filterMenu.querySelector('[data-archived-notes]').checked=showArchived;
    }
    async function refreshAuthors(){if(!entry.channelId || !channels().messages.noteAuthors)return;try{projectAuthors=(await channels().messages.noteAuthors(orgId(),entry.channelId)).authors;}catch{projectAuthors=null;}}
    async function loadAuthorNotes(before=0){const request=++authorRequest;if(allAuthorsSelected || !selectedAuthors.size)return;const data=await channels().messages.list(orgId(),entry.channelId,{view:'notes',limit:100,author_ids:[...selectedAuthors].join(','),...(before ? {before} : {})});if(disposed || request!==authorRequest)return;entry.notes=[...new Map([...entry.notes,...data.messages.map(noteFromMessage)].map(note=>[note.id,note])).values()];filteredBefore=data.next_before ?? (data.messages.length===100 ? data.messages[0].seq : 0);}
    function applyAuthorFilters(){authorRequest++;filteredBefore=0;render();if(!allAuthorsSelected && selectedAuthors.size)void loadAuthorNotes().then(()=>render()).catch(error=>say(error.message));}
    filterButton.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();if(filterMenu.hidden)filterButton.click();}};filterMenu.onfocusout=event=>{if(event.relatedTarget && !filterMenu.contains(event.relatedTarget) && event.relatedTarget!==filterButton)closeFilter();};
    filterButton.onclick=()=>{if(!filterMenu.hidden){closeFilter();return;}syncAuthorFilters();filterMenu.hidden=false;filterButton.setAttribute('aria-expanded','true');authorSearch.focus();};authorSearch.oninput=syncAuthorFilters;
    filterMenu.onchange=event=>{const input=event.target;if(input.hasAttribute('data-archived-notes'))showArchived=input.checked;else if(input.type==='checkbox'){allAuthorsSelected=false;input.checked ? selectedAuthors.add(input.value) : selectedAuthors.delete(input.value);}applyAuthorFilters();};
    filterMenu.onclick=event=>{if(event.target.closest('[data-all-authors]')){allAuthorsSelected=!allAuthorsSelected;selectedAuthors.clear();applyAuthorFilters();}};
    filterMenu.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeFilter();filterButton.focus();}};
    document.addEventListener('pointerdown',event=>{if(!filterMenu.contains(event.target) && !filterButton.contains(event.target))closeFilter();},{capture:true,signal:lifetime.signal});
    // Starts after the author filter menu exists: refresh() renders synchronously for a project not saved yet.
    const ready=Promise.all([refresh(),directoryReady]).then(()=>render()).catch(error=>say(error.message));

    async function submit(pin=false){
      if(busy || disposed || capturing || uploading || text._polishApi?.polishing)return;const body=clean(text.value);if(!body && !prepared.length && !gifDraft)return;
      busy=true;text.contentEditable='false';closeEmoji();window.FirstMatePickerWidgets?.closeFor?.(gifButton);audience.close();form.querySelectorAll('button,input,textarea').forEach(node=>node.disabled=true);say();
      try{await ensureSavedProject();await ensureChannel(entry);const visibility=audience.payload(),metadata=Object.assign({},...prepared.map(item=>item.kind==='audio' ? {audio_note:item.metadata} : item.metadata || {}),gifDraft ? {giphy:gifDraft} : {});
        const posted=await channels().messages.post(orgId(),entry.channelId,{text:body || prepared.map(item=>item.text || '').filter(Boolean).join('\n'),project_note:true,pin,...visibility,mention_users:mentions?.selectedMentions?.() || [],client_msg_id:form.dataset.operationId || (form.dataset.operationId=id()),attachment_ids:prepared.map(item=>item.attachment?.id).filter(Boolean),metadata});
        try{options.onPosted?.(posted.message);}catch{}
        if(disposed)return;text.value='';prepared=[];gifDraft=null;paintGif();delete form.dataset.operationId;uploadBox.replaceChildren();mentions?.setSelectedMentions?.([]);await refresh();announce(entry.projectId);
      }catch(error){say(error.message || 'Could not save the note. Your draft has been kept.');}
      finally{busy=false;if(!disposed){text.contentEditable='true';form.querySelectorAll('button,input,textarea').forEach(node=>node.disabled=false);syncSendState();}}
    }
    form.onsubmit=event=>{event.preventDefault();void submit();};form.querySelector('[data-pin-send]').onclick=()=>submit(true);text.oninput=()=>{delete form.dataset.operationId;syncSendState();};
    form.querySelector('[type=file]').onchange=async event=>{
      uploading++;syncSendState();say();try{await ensureSavedProject();for(const file of event.target.files){const result=await prepareUpload(project,file);if(disposed)return;prepared.push(result);const node=document.createElement('div');uploadBox.append(node);mountPreparedUpload(node,result,()=>{prepared=prepared.filter(item=>item!==result);node.remove();delete form.dataset.operationId;syncSendState();});}delete form.dataset.operationId;}
      catch(error){say(error.message);}finally{uploading--;syncSendState();event.target.value='';}
    };
    async function capture(mode){
      if(capturing){if(captureMode===mode)recorderControl?.stop();return;}if(busy || disposed)return;capturing=true;captureMode=mode;syncSendState();dictateButton.disabled=audioButton.disabled=true;const button=mode==='dictation' ? dictateButton : audioButton,node=document.createElement('div');uploadBox.append(node);let result;
      try{await ensureSavedProject();if(disposed)return;result=await prepareAudioInline(project,node,{mode,signal:captureAbort.signal,onRecordingState(control){recorderControl=control;if(disposed)return;button.disabled=!control;button.classList.toggle('voice-active',!!control);button.setAttribute('aria-pressed',String(!!control));button.setAttribute('aria-label',control ? mode==='dictation' ? 'Finish dictation' : 'Finish recording' : button.title);},onRemove(){prepared=prepared.filter(item=>item!==result);node.remove();delete form.dataset.operationId;syncSendState();}});
        if(disposed)return;if(mode==='dictation'){text.value=[text.value,result.text].filter(Boolean).join(' ');node.remove();text.dispatchEvent(new Event('input',{bubbles:true}));text.focus();}else{result.kind='audio';prepared.push(result);delete form.dataset.operationId;}
      }catch(error){node.remove();if(!/cancelled/i.test(error.message || ''))say(error.message);}finally{capturing=false;recorderControl=null;if(!disposed){button.classList.remove('voice-active');button.setAttribute('aria-pressed','false');button.setAttribute('aria-label',button.title);syncSendState();}}
    }
    dictateButton.onclick=()=>capture('dictation');audioButton.onclick=()=>capture('record');syncSendState();
    const polish=mountNotePolish(text,form,()=>busy || capturing || uploading>0,cause=>say(cause.message),syncSendState);
    function captureReplyFocus(){
      const element=document.activeElement;if(!container.contains(element) || !element.closest('.pn-replies-wrap') || !element.matches('[contenteditable],textarea'))return ()=>{};
      const selection=getSelection(),anchor=selection?.anchorNode,anchorOffset=selection?.anchorOffset,focus=selection?.focusNode,focusOffset=selection?.focusOffset;
      return ()=>{if(!element.isConnected)return;element.focus({preventScroll:true});if(anchor?.isConnected && focus?.isConnected && element.contains(anchor) && element.contains(focus))getSelection().setBaseAndExtent(anchor,anchorOffset,focus,focusOffset);};
    }
    function replyHtml(note){
      const archived=!!note.deleted_at,actions=archived ? `${note.can_restore ? '<button type="button" data-act="restore">Unarchive Reply</button>' : ''}` : `${note.can_edit ? '<button type="button" data-act="edit">Edit Reply</button>' : ''}${note.can_delete ? '<button type="button" data-act="delete">Archive Reply</button>' : ''}`;
      return `<article class="pn-reply-card${archived ? ' pn-archived' : ''}" data-project-note-id="${esc(note.id)}"><header>${avatarHtml(note)}<div class="pn-author"><span class="pn-author-name" tabindex="0"${userSummaryAttributes(note)}>${esc(note.created_by?.name || 'Teammate')}</span><time datetime="${esc(note.created_at)}">${esc(fmtWhen(note.created_at))}${archived ? ' · Archived' : ''}</time></div><details class="pn-menu"><summary aria-label="Reply options"><i class="fas fa-ellipsis"></i></summary><div>${actions}<button type="button" data-act="copy">Copy text</button>${note.edited_at ? '<button type="button" data-act="history">View Edit History</button>' : ''}</div></details></header><div class="pn-card-content">${clean(note.translation?.text || note.text) ? (widgets?.renderBody?.({...note,text:note.translation?.text || note.text}) || `<p>${esc(note.text)}</p>`) : ''}${audioPlayerHtml(note)}${mediaAttachmentsHtml(note)}${window.FirstMateGifWidgets?.renderCard?.(note.metadata?.giphy) || ''}</div><footer>${note.edited_at ? '<span class="pn-edited-label">Edited</span>' : ''}</footer></article>`;
    }
    function threadHasReplies(thread){return thread.loaded ? thread.items.some(item=>!item.deleted_at) : Number(entry.notes.find(note=>note.id===thread.id)?.reply_count)>0;}
    function syncReplyThread(thread){
      const root=container.querySelector(`.pn-card[data-project-note-id="${CSS.escape(thread.id)}"]`),hasReplies=threadHasReplies(thread),archived=!!entry.notes.find(note=>note.id===thread.id)?.deleted_at;
      thread.form.hidden=!thread.open || !thread.composerOpen || archived;thread.add.hidden=!thread.open || thread.composerOpen || !hasReplies || archived;thread.add.parentElement.hidden=thread.add.hidden;thread.add.setAttribute('aria-expanded',String(thread.composerOpen));
      const reply=root?.querySelector(':scope >footer [data-act=replies]');if(reply){reply.hidden=thread.open && thread.composerOpen && !hasReplies;reply.textContent=replyToggleLabel(entry.notes.find(note=>note.id===thread.id),thread.open);reply.setAttribute('aria-expanded',String(thread.open));}
    }
    function openReplyComposer(thread){thread.open=true;thread.composerOpen=true;syncReplyThread(thread);thread.composer.focus();}
    function closeReplyComposer(thread){
      thread.composerOpen=false;thread.composer.pause();if(!threadHasReplies(thread)){thread.open=false;thread.node.remove();}syncReplyThread(thread);
      const target=thread.add.hidden ? container.querySelector(`.pn-card[data-project-note-id="${CSS.escape(thread.id)}"] >footer [data-act=replies]`) : thread.add;target?.focus();
    }
    function paintReplyThread(thread){
      const restoreFocus=captureReplyFocus(),editing=editSession?.node,keep=editing && thread.items.some(item=>item.id===editSession.id);
      thread.list.innerHTML=thread.items.filter(item=>showArchived || !item.deleted_at).map(replyHtml).join('');
      if(keep){const replacement=thread.list.querySelector(`[data-project-note-id="${CSS.escape(editSession.id)}"]`);if(replacement)replacement.replaceWith(editing);}
      window.FirstMateAudioNotes?.hydrate?.(thread.list);syncReplyThread(thread);restoreFocus();
    }
    async function loadReplyThread(thread){
      if(thread.loading)return thread.loading;
      thread.loading=(async()=>{try{const items=await replies(project,thread.id);if(disposed || !replyThreads.has(thread.id))return;thread.items=items;thread.loaded=true;paintReplyThread(thread);thread.error.hidden=true;}
        catch(error){if(!disposed){thread.error.textContent=error.message || 'Could not load replies.';thread.error.hidden=false;}}
        finally{thread.loading=null;}})();return thread.loading;
    }
    async function toggleReplyThread(note,node){
      let thread=replyThreads.get(note.id);
      if(thread && thread.open && !threadHasReplies(thread)){openReplyComposer(thread);return;}
      if(thread){thread.open=!thread.open;thread.composerOpen=false;thread.composer.pause();if(!thread.open){thread.node.remove();syncReplyThread(thread);return;}node.append(thread.node);thread.loaded=false;if(!threadHasReplies(thread))openReplyComposer(thread);else syncReplyThread(thread);await loadReplyThread(thread);return;}
      const wrap=document.createElement('div');wrap.className='pn-replies-wrap';wrap.innerHTML='<div class="pn-reply-list"></div><div class="pn-reply-error" role="alert" hidden></div><div class="pn-reply-add-row"><button type="button" data-add-reply aria-expanded="false">Add Reply</button></div><form class="pn-reply-compose" hidden>'+composerBoxHtml(true)+'<div class="pn-reply-error" role="alert" hidden></div></form>';node.append(wrap);
      thread={id:note.id,node:wrap,list:wrap.querySelector('.pn-reply-list'),error:wrap.querySelector('.pn-reply-error'),form:wrap.querySelector('form'),items:[],open:true,composerOpen:false,add:wrap.querySelector('[data-add-reply]'),loading:null,loaded:false};replyThreads.set(note.id,thread);
      thread.composer=mountReplyComposer(thread);thread.add.onclick=()=>openReplyComposer(thread);thread.form.querySelector('[data-close-reply]').onclick=()=>closeReplyComposer(thread);if(!Number(note.reply_count))openReplyComposer(thread);else syncReplyThread(thread);await loadReplyThread(thread);
    }
    function mountReplyComposer(thread){
      const replyForm=thread.form,editor=createEditor(replyForm.querySelector('.pn-editor-mount'),'Write a reply…'),uploads=replyForm.querySelector('.pn-uploads'),error=replyForm.querySelector('.pn-reply-error'),send=replyForm.querySelector('[type=submit]'),files=replyForm.querySelector('[type=file]'),attach=replyForm.querySelector('[data-attach]'),dictate=replyForm.querySelector('[data-dictate]'),audio=replyForm.querySelector('[data-audio]'),emoji=replyForm.querySelector('[data-emoji]'),pop=replyForm.querySelector('.pn-emoji-pop');
      const tags=window.FirstMateTags?.attachMentionTextarea?.(editor,{orgId:orgId(),source:'project_notes'}),abort=new AbortController();
      editor._mentionApi=tags;
      let replyGif=null;
      let pending=[],saving=false,uploading=0,recording=false,mode='',control=null,picker=null,destroyed=false,operationId='';
      const alive=()=>!disposed && !destroyed;
      const paintGif=()=>window.FirstMateGifWidgets?.renderDraft?.(replyForm.querySelector('.pn-gif-preview'),replyGif,()=>{if(saving)return;replyGif=null;operationId='';paintGif();sync();});
      const gifButton=window.FirstMateChannels.createGifPickerButton({orgId:orgId(),onError:cause=>fail(cause.message),onSelect:selected=>{if(!alive() || saving || recording)return;replyGif=selected;operationId='';paintGif();sync();}});gifButton.classList.add('pn-icon');emoji.after(gifButton);
      function fail(message=''){if(alive()){error.textContent=message;error.hidden=!message;}}
      function sync(){if(!alive() || editor._polishApi?.polishing)return;editor._polishApi?.refresh();send.disabled=saving || uploading>0 || recording || (!clean(editor.value) && !pending.length && !replyGif);gifButton.disabled=saving || recording;attach.disabled=saving || recording;emoji.disabled=saving || recording;dictate.disabled=saving || (recording && mode!=='dictation');audio.disabled=saving || (recording && mode!=='record') || (!recording && pending.some(item=>item.kind==='audio'));}
      function closeEmoji(){picker?.destroy?.();picker=null;pop.hidden=true;emoji.setAttribute('aria-expanded','false');}
      async function submitReply(){
        if(!alive() || saving || recording || uploading || editor._polishApi?.polishing || (!clean(editor.value) && !pending.length && !replyGif))return;
        saving=true;editor.contentEditable='false';closeEmoji();window.FirstMatePickerWidgets?.closeFor?.(gifButton);sync();fail();
        try{await ensureSavedProject();await ensureChannel(entry);const metadata=Object.assign({},...pending.map(item=>item.kind==='audio' ? {audio_note:item.metadata} : item.metadata || {}),replyGif ? {giphy:replyGif} : {});
          await channels().messages.post(orgId(),entry.channelId,{text:clean(editor.value) || pending.map(item=>item.text || '').filter(Boolean).join('\n'),parent_id:thread.id,client_msg_id:operationId || (operationId=id()),mention_users:tags?.selectedMentions?.() || [],attachment_ids:pending.map(item=>item.attachment?.id).filter(Boolean),metadata});
          if(!alive())return;thread.composerOpen=false;syncReplyThread(thread);if(!thread.add.hidden)thread.add.focus();editor.value='';pending=[];replyGif=null;paintGif();operationId='';uploads.replaceChildren();tags?.setSelectedMentions?.([]);await loadReplyThread(thread);await refresh();announce(entry.projectId);
        }catch(cause){fail(cause.message || 'Could not send your reply. Your draft has been kept.');}
        finally{saving=false;if(alive()){editor.contentEditable='true';sync();if(thread.open && thread.composerOpen)editor.focus();}}
      }
      replyForm.onsubmit=event=>{event.preventDefault();void submitReply();};editor.oninput=()=>{operationId='';sync();};
      bindNoteEnterToSend(editor,()=>void submitReply());editor.onkeydown=event=>{if(event.key==='Escape' && !pop.hidden){event.preventDefault();event.stopPropagation();closeEmoji();}};
      emoji.onclick=()=>{if(!pop.hidden){closeEmoji();return;}pop.hidden=false;emoji.setAttribute('aria-expanded','true');picker=window.FirstMateChannels?.mountEmojiPicker?.(pop,value=>{editor.insertText ? editor.insertText(value) : editor.setRangeText(value,editor.selectionStart,editor.selectionEnd,'end');editor.dispatchEvent(new Event('input',{bubbles:true}));closeEmoji();editor.focus();});picker?.focus?.();};
      attach.onclick=()=>files.click();files.onchange=async event=>{uploading++;sync();fail();try{await ensureSavedProject();for(const file of event.target.files){const item=await prepareUpload(project,file);if(!alive())return;pending.push(item);operationId='';const node=document.createElement('div');uploads.append(node);mountPreparedUpload(node,item,()=>{pending=pending.filter(value=>value!==item);node.remove();operationId='';sync();});}}
        catch(cause){fail(cause.message);}finally{uploading--;if(alive()){files.value='';sync();}}};
      async function captureReply(nextMode){
        if(recording){if(mode===nextMode)control?.stop();return;}if(saving || !alive())return;recording=true;mode=nextMode;sync();fail();const button=mode==='dictation' ? dictate : audio,node=document.createElement('div');uploads.append(node);let item;
        try{await ensureSavedProject();if(!alive())return;item=await prepareAudioInline(project,node,{mode,signal:abort.signal,onRecordingState(value){control=value;if(!alive())return;button.disabled=!value;button.classList.toggle('voice-active',!!value);button.setAttribute('aria-pressed',String(!!value));button.setAttribute('aria-label',value ? mode==='dictation' ? 'Finish dictation' : 'Finish recording' : button.title);},onRemove(){pending=pending.filter(value=>value!==item);node.remove();operationId='';sync();}});
          if(!alive())return;if(mode==='dictation'){editor.value=[editor.value,item.text].filter(Boolean).join(' ');node.remove();editor.dispatchEvent(new Event('input',{bubbles:true}));editor.focus();}else{item.kind='audio';pending.push(item);operationId='';}
        }catch(cause){node.remove();if(!/cancelled/i.test(cause.message || ''))fail(cause.message);}
        finally{recording=false;control=null;if(alive()){button.classList.remove('voice-active');button.setAttribute('aria-pressed','false');button.setAttribute('aria-label',button.title);sync();}}
      }
      dictate.onclick=()=>captureReply('dictation');audio.onclick=()=>captureReply('record');
      const polish=mountNotePolish(editor,replyForm,()=>saving || recording || uploading>0,cause=>fail(cause.message),sync,()=>alive() && thread.open && thread.composerOpen,closeEmoji);
      document.addEventListener('pointerdown',event=>{if(!replyForm.contains(event.target))closeEmoji();},{capture:true,signal:abort.signal});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEmoji();},{signal:abort.signal});sync();
      return {focus(){editor.focus();},pause(){polish?.cancel();closeEmoji();window.FirstMatePickerWidgets?.closeFor?.(gifButton);control?.stop();},destroy(){destroyed=true;polish?.destroy();gifButton.destroy?.();abort.abort();closeEmoji();tags?.destroy?.();replyForm.querySelector('.fm-an-inline-remove')?.click();}};
    }
    function endEdit(){if(!editSession)return;editSession.mentions?.destroy?.();editSession=null;render();}
    function startEdit(note,node){
      if(editSession?.id===note.id){editSession.text.focus();return;}if(editSession){editSession.text.focus();return;}
      node.querySelector('.pn-card-content').hidden=true;node.querySelector('footer').hidden=true;if(node.querySelector('.pn-more'))node.querySelector('.pn-more').hidden=true;
      const editForm=document.createElement('form');editForm.className='pn-inline-edit';editForm.innerHTML='<div class="pn-inline-edit-head">EDIT NOTE</div><div class="pn-composer-box"><div class="pn-editor-mount"></div></div><div class="pn-inline-error" role="alert" hidden></div><div class="pn-inline-edit-actions"><div class="pn-audience"></div><button type="button" data-cancel-edit>Cancel</button><button type="submit">Save changes</button></div>';node.append(editForm);
      const editor=createEditor(editForm.querySelector('.pn-editor-mount'),copy('Edit note'));editor.value=note.text;
      const editMentions=window.FirstMateTags?.attachMentionTextarea?.(editor,{orgId:orgId(),source:'project_notes'});editMentions?.setSelectedMentions?.(note.mention_users || []);
      const isReply=node.classList.contains('pn-reply-card');if(isReply){editForm.querySelector('.pn-inline-edit-head').textContent='EDIT REPLY';editForm.querySelector('.pn-audience').remove();}
      const chooser=isReply ? {payload:()=>({}),close(){}} : audienceChooser(editForm.querySelector('.pn-audience'),note),error=editForm.querySelector('.pn-inline-error'),save=editForm.querySelector('[type=submit]');
      const session={id:note.id,node,text:editor,mentions:editMentions,busy:false};editSession=session;editor.focus();
      editor.oninput=()=>save.disabled=!clean(editor.value);editor.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!session.busy)endEdit();}if(event.key==='Enter' && (event.ctrlKey || event.metaKey)){event.preventDefault();editForm.requestSubmit();}};
      editForm.querySelector('[data-cancel-edit]').onclick=()=>{if(!session.busy)endEdit();};
      editForm.onsubmit=async event=>{event.preventDefault();if(session.busy || !clean(editor.value))return;session.busy=true;editForm.querySelectorAll('button,input').forEach(node=>node.disabled=true);chooser.close();editor.contentEditable='false';editForm.querySelector('[data-cancel-edit]').disabled=true;error.hidden=true;
        try{await channels().messages.edit(orgId(),note.id,{text:clean(editor.value),...chooser.payload(),mention_users:editMentions?.selectedMentions?.() || []});if(disposed)return;const thread=[...replyThreads.values()].find(item=>item.items.some(reply=>reply.id===note.id));endEdit();if(thread)await loadReplyThread(thread);await refresh();announce(entry.projectId);}
        catch(cause){error.textContent=cause.message || 'Could not save your changes.';error.hidden=false;}
        finally{session.busy=false;if(editSession===session){editForm.querySelectorAll('button,input').forEach(node=>node.disabled=false);editor.contentEditable='true';}}
      };
    }
    container.onclick=async event=>{
      const older=event.target.closest('[data-load-more]'),button=event.target.closest('[data-act]');if(!button && !older)return;if(button)event.preventDefault();
      try{if(older){older.disabled=true;if(!allAuthorsSelected){await loadAuthorNotes(filteredBefore);render();return;}const data=await channels().messages.list(orgId(),entry.channelId,{view:'notes',before:entry.historyBefore,limit:100});entry.notes=[...new Map([...entry.notes,...data.messages.map(noteFromMessage)].map(note=>[note.id,note])).values()];entry.historyBefore=data.messages.length===100 ? data.messages[0].seq : 0;render();return;}
        const node=button.closest('[data-project-note-id]'),thread=[...replyThreads.values()].find(item=>item.items.some(reply=>reply.id===node.dataset.projectNoteId)),note=thread?.items.find(item=>item.id===node.dataset.projectNoteId) || entry.notes.find(item=>item.id===node.dataset.projectNoteId);if(!note)return;const action=button.dataset.act,anchor=node.querySelector('.pn-menu summary');say();node.querySelector('.pn-menu').open=false;
        if(action==='expand'){expanded.has(note.id) ? expanded.delete(note.id) : expanded.add(note.id);render();return;}
        if(action==='edit'){startEdit(note,node);return;}
        if(action==='copy'){await navigator.clipboard.writeText(note.text);return;}
        if(action==='history'){await showHistoryPopover(anchor,note.id);return;}
        if(action==='replies'){await toggleReplyThread(note,node);return;}
        button.disabled=true;
        if(action==='pin')await channels().messages[note.pinned_at ? 'unpin' : 'pin'](orgId(),note.id);
        if(action==='delete')await channels().messages.remove(orgId(),note.id);
        if(action==='restore')await channels().messages.restore(orgId(),note.id);
        if(thread)await loadReplyThread(thread);await refresh();announce(entry.projectId);
      }catch(error){say(error.message);if(button?.isConnected)button.disabled=false;}
    };

    document.addEventListener('pointerdown',event=>{
      container.querySelectorAll('.pn-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});
      container.querySelectorAll('.pn-audience').forEach(host=>{if(!host.contains(event.target) && !audienceMenus.get(host)?.contains(event.target))audienceClosers.get(host)?.();});
      if(!form.querySelector('.pn-composer-box').contains(event.target))closeEmoji();
    },{capture:true,signal:lifetime.signal});
    bindNoteEnterToSend(text,()=>void submit());text.onkeydown=event=>{if(event.key==='Escape' && !emojiPop.hidden){event.stopPropagation();closeEmoji();}};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){container.querySelectorAll('.pn-menu[open]').forEach(menu=>menu.open=false);container.querySelectorAll('.pn-audience').forEach(host=>audienceClosers.get(host)?.());closeHistoryPop();}},{signal:lifetime.signal});
    return {ready,refresh,setVisible(value){if(value)return;polish?.cancel();for(const thread of replyThreads.values())thread.composer.pause();closeFilter();closeEmoji();closeHistoryPop();window.FirstMatePickerWidgets?.closeFor?.(gifButton);for(const host of container.querySelectorAll('.pn-audience'))audienceClosers.get(host)?.();},destroy(){disposed=true;polish?.destroy();gifButton.destroy?.();for(const thread of replyThreads.values())thread.composer.destroy();replyThreads.clear();for(const handle of [...audienceHandles])handle.destroy();lifetime.abort();captureAbort.abort();closeEmoji();closeHistoryPop();mentions?.destroy?.();editSession?.mentions?.destroy?.();window.removeEventListener('fm:project-notes:refreshed',notified);container.querySelector('.fm-an-inline-remove')?.click();container.replaceChildren();}};

  }

  window.Portal.ProjectNotes = {
    mount,
    GROUPS, TYPE_TAGS, actor, currentGroups, normalizeVisibility, normalizeTypeTags, normalizeMentionUser, mentionsFromText,
    typeTag, typeTags, renderTypeTags, all, visible, owns, isTagged, canSee, add, update, remove, visibilityLabel,
    recordAudio, prepareAudioInline, prepareUpload, mountAudioAttachment, mountPreparedUpload, audioPlayerHtml, mediaAttachmentsHtml,
    // channels-backed additions:
    load, flush, timeline, restore, revisions, replies, reply,
    editedMetaHtml, repliesToggleHtml, removedNoteHtml, bindHistoryExtras
  };
})();
