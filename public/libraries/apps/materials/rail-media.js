/* Operations rail: the project's photos and its documents, each as a carousel (stage, filmstrip, details) in the
 * rail's Photos and Documents views. They show the same items, in the same order, as the project window's Photos and
 * Docs tabs, and open them in the same shared viewer (FirstMateMarkup.mountMediaCarousel), so markup, comments, tags,
 * rename, download and delete work as they do there. The carousel fits itself to the rail's width: phone-like when
 * narrow, desktop-like when wide.
 *
 *   mountRailPhotos(stage, ctx)    -> { setVisible, resize, refresh, serialize, destroy }
 *   mountRailDocuments(stage, ctx) -> { setVisible, resize, refresh, update(documents, error), serialize, destroy }
 *
 * ctx: { context: the rail's widget context ({ target: { organizationId, projectId } }), host: the project window's
 *        workspace host (optional; getProject, getPhotos, setPhotos, setActivePreviewTab, persistProject,
 *        loadReportDocumentAssets), documents: the rail's scope documents (accepted documents with their published
 *        material sets, delivered report files), initialState }.
 *
 * Uploads go through each tab's own pipeline: photos through the Photos tab's addPhotoFiles (storage limits, upload
 * events), documents through PlatformAPI.projectDocuments.upload as the Docs tab does. Reads never write.
 */
const PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,video/mp4,video/quicktime,video/webm,video/x-m4v,video/ogg';
const DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.png,.jpg,.jpeg,.webp,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv';

const clean = (value) => String(value ?? '').trim();
const first = (...values) => { for (const value of values) { const text = clean(value); if (text) return text; } return ''; };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (key, fallback, vars) => globalThis.PlatformLanguage?.text?.('materials', key, fallback, vars) ?? fallback;
const docsText = (key, fallback) => globalThis.PlatformLanguage?.text?.('docs', key, fallback) ?? fallback;
const plural = (count, one, many) => count === 1 ? one : many;
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const money = (value, currency = 'USD') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value); } catch { return `${number(value)} ${currency}`; } };
const shortDate = (value) => { const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return ''; return date.toLocaleDateString(undefined, date.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }); };
const toast = (title, body, ok) => (window.Portal?.ui?.showToast || window.showToast || (() => {}))(title, body, ok);

// ------------------------------------------------------------------ project context
function projectEnv(ctx = {}) {
  const target = ctx.context?.target || {};
  const host = ctx.host && typeof ctx.host === 'object' ? ctx.host : null;
  const project = () => host?.getProject?.() || window.activeBaseProject || {};
  return {
    host,
    project,
    orgId: () => first(target.organizationId, host?.projectOrgId?.(), window.projectOrgId?.(), window.Portal?.cfg?.userOrgId, window.__APP?.userOrgId),
    projectId: () => first(target.projectId, project()?.id),
    title: () => first(project()?.title, project()?.name, project()?.address)
  };
}
// Switches the project window to one of its tabs, as the work order's "Open" does from the Project tab.
// Without the host (an older rail), the window's own tab button does it.
function openProjectTab(env, tab, source) {
  if (typeof env.host?.setActivePreviewTab === 'function') {
    env.host.setActivePreviewTab(tab);
    try { window.Portal?.navigation?.push?.({ projectTab: tab }, { source, ownedKeys: ['projectTab'] }); } catch (_) {}
    return true;
  }
  const button = document.querySelector(`.r-tab[data-tab="${CSS.escape(tab)}"]`);
  if (button) { button.click(); return true; }
  return false;
}
function cameraAvailable() {
  if (typeof window.FirstMateCamera?.open !== 'function') return false;
  try { return window.matchMedia('(pointer: coarse)').matches || window.top.matchMedia('(max-width: 760px)').matches; }
  catch { return window.matchMedia?.('(pointer: coarse)')?.matches === true; }
}

// ------------------------------------------------------------------ styles
let styled = false;
export function ensureStyles() {
  if (styled || document.getElementById('fm-rail-media-style')) { styled = true; return; }
  styled = true;
  const style = document.createElement('style');
  style.id = 'fm-rail-media-style';
  style.textContent = `
.fm-rail-media{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#f7f9fc;color:#1d2939}
.fm-rail-media-body{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.fm-rail-media-body>*{flex:1 1 auto;min-height:0}
.fm-rail-media-status{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:#f7f9fc}
.fm-rail-media-status[hidden]{display:none}
.fm-rail-skel{flex:1;display:flex;flex-direction:column;gap:10px;padding:12px}
.fm-rail-skel-head{display:flex;align-items:center;gap:8px}
.fm-rail-skel span{display:block;border-radius:8px;background:linear-gradient(90deg,#e9eef5 0,#f4f7fb 40%,#e9eef5 80%);background-size:300% 100%;animation:fmRailShimmer 1.3s ease-in-out infinite}
.fm-rail-skel-stage{flex:1;min-height:80px}
.fm-rail-skel-strip{display:flex;gap:8px;height:72px}
.fm-rail-skel-strip span{flex:0 0 96px}
@keyframes fmRailShimmer{0%{background-position:100% 0}100%{background-position:0 0}}
@media(prefers-reduced-motion:reduce){.fm-rail-skel span{animation:none}}
.fm-rail-message{margin:auto;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:320px;padding:20px;text-align:center;font-size:12.5px;color:#667085}
.fm-rail-message>i{font-size:28px;color:#c0c8d4}
.fm-rail-message strong{font-size:14px;color:#344054}
.fm-rail-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:4px}
.fm-rail-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;color:#344054;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}
.fm-rail-btn:hover{border-color:var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025))}
.fm-rail-btn:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.fm-rail-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--primary-contrast,#fff)}
.fm-rail-btn.primary:hover{filter:brightness(.96);color:var(--primary-contrast,#fff)}
.fm-rail-btn[disabled]{opacity:.55;cursor:default}
.fm-rail-btn.icon{width:32px;padding:0}
.fm-rail-chip{position:absolute;z-index:6;left:50%;bottom:12px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:#fff;border:1px solid #d0d5dd;box-shadow:0 8px 20px rgba(16,24,40,.12);font-size:12px;font-weight:700;color:#344054;white-space:nowrap}
.fm-rail-chip i{color:var(--primary,#d93025)}
.fm-rail-chip[hidden]{display:none}
.fm-rail-drop{position:absolute;inset:6px;z-index:7;display:none;align-items:center;justify-content:center;border:2px dashed var(--primary,#d93025);border-radius:12px;background:color-mix(in srgb,var(--primary,#d93025) 8%,rgba(255,255,255,.88));font-size:13px;font-weight:800;color:var(--primary-readable,var(--primary,#d93025));pointer-events:none}
.fm-rail-media.is-dragover .fm-rail-drop{display:flex}
/* The accepted document's published materials, over the carousel. */
.fm-rail-sheet{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:#fff;transform:translateY(8px);opacity:0;transition:transform .18s ease,opacity .18s ease}
.fm-rail-sheet.open{transform:none;opacity:1}
.fm-rail-sheet[hidden]{display:none}
.fm-rail-sheet>header{flex:none;display:flex;align-items:flex-start;gap:10px;padding:12px 12px 10px;border-bottom:1px solid #e4e7ec}
.fm-rail-sheet>header div{flex:1;min-width:0}
.fm-rail-sheet>header small{display:block;font-size:11px;font-weight:700;color:#667085;text-transform:uppercase;letter-spacing:.03em}
.fm-rail-sheet>header h2{margin:2px 0 0;font-size:15px;line-height:1.3;color:#101828;overflow-wrap:anywhere}
.fm-rail-sheet>header strong{display:block;margin-top:2px;font-size:13px;color:var(--primary-readable,var(--primary,#d93025))}
.fm-rail-sheet-body{flex:1;min-height:0;overflow:auto;padding:4px 12px 16px}
.fm-rail-sheet-body section{margin-top:14px}
.fm-rail-sheet-body h3{margin:0 0 8px;font-size:12px;letter-spacing:.02em;color:#475467}
.fm-rail-sheet-body .fm-rail-table{width:100%;overflow-x:auto;border:1px solid #e4e7ec;border-radius:8px}
.fm-rail-sheet-body table{width:100%;border-collapse:collapse;font-size:12px}
.fm-rail-sheet-body th{position:sticky;top:0;background:#f8fafc;text-align:left;font-size:11px;font-weight:700;color:#667085;padding:7px 8px;border-bottom:1px solid #e4e7ec;white-space:nowrap}
.fm-rail-sheet-body td{padding:7px 8px;border-bottom:1px solid #f2f4f7;vertical-align:top;color:#344054}
.fm-rail-sheet-body tr:last-child td{border-bottom:0}
.fm-rail-sheet-body td small{display:block;color:#667085;font-size:11px;margin-top:2px}
.fm-rail-sheet-body td:not(:first-child){white-space:nowrap}
.fm-rail-sheet-body p{margin:8px 0;font-size:12px;color:#667085}
@container (max-width:420px){.fm-rail-sheet-body th:nth-child(4),.fm-rail-sheet-body td:nth-child(4){display:none}}
.fm-rail-sheet-body{container-type:inline-size}
/* Fallback carousel, shown only while the shared viewer has no embeddable carousel. */
.fm-rail-fb{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.fm-rail-fb-head{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 10px;border-bottom:1px solid #e4e7ec;background:#fff}
.fm-rail-fb-title{flex:1;min-width:0;display:flex;flex-direction:column}
.fm-rail-fb-title strong{font-size:13px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fm-rail-fb-title span{font-size:11px;color:#667085}
.fm-rail-fb-tools{display:flex;gap:6px;flex:none}
.fm-rail-fb.is-narrow .fm-rail-fb-tools .fm-rail-btn span{display:none}
.fm-rail-fb.is-narrow .fm-rail-fb-tools .fm-rail-btn{width:32px;padding:0}
.fm-rail-fb-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#eef1f5;overflow:hidden}
.fm-rail-fb-stage>img,.fm-rail-fb-stage>video{max-width:100%;max-height:100%;object-fit:contain;display:block}
.fm-rail-fb-stage>img{cursor:zoom-in}
.fm-rail-fb-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px;text-align:center;max-width:300px}
.fm-rail-fb-card .mark{width:64px;height:64px;border-radius:16px;display:grid;place-items:center;background:#fff;border:1px solid #e4e7ec;font-size:28px;color:var(--doc-color,var(--primary,#d93025))}
.fm-rail-fb-card strong{font-size:14px;color:#101828;overflow-wrap:anywhere}
.fm-rail-fb-card span{font-size:12px;color:#667085}
.fm-rail-fb-nav{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:34px;border-radius:50%;border:1px solid #d0d5dd;background:rgba(255,255,255,.92);color:#344054;display:grid;place-items:center;cursor:pointer}
.fm-rail-fb-nav.prev{left:8px}.fm-rail-fb-nav.next{right:8px}
.fm-rail-fb-open{position:absolute;right:10px;bottom:10px}
.fm-rail-fb-strip{flex:none;display:flex;gap:8px;overflow-x:auto;padding:8px 10px;border-top:1px solid #e4e7ec;background:#f8fafc;scrollbar-width:thin}
.fm-rail-fb-tile{position:relative;flex:0 0 96px;height:72px;padding:0;border:2px solid transparent;border-radius:8px;overflow:hidden;background:#e4e7ec;cursor:pointer;display:grid;place-items:center;color:#667085;font-size:20px}
.fm-rail-fb-tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fm-rail-fb-tile[aria-current=true]{border-color:var(--primary,#d93025)}
.fm-rail-fb-tile .play{position:absolute;right:5px;bottom:5px;font-size:10px;color:#fff;background:rgba(16,24,40,.6);border-radius:999px;padding:3px 5px}
.fm-rail-fb-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
`;
  document.head.append(style);
}

// ------------------------------------------------------------------ the frame shared by both views
function railFrame(stage, kind, accept, onFiles) {
  ensureStyles();
  stage.replaceChildren();
  const root = document.createElement('div');
  root.className = 'fm-rail-media';
  root.dataset.railMedia = kind;
  root.innerHTML = `<div class="fm-rail-media-body"></div><div class="fm-rail-media-status" role="status" aria-live="polite"></div><div class="fm-rail-chip" hidden role="status" aria-live="polite"></div><div class="fm-rail-drop" aria-hidden="true">${esc(kind === 'photos' ? T('rail_photos_drop', 'Drop photos or videos to upload') : T('rail_docs_drop', 'Drop files to upload'))}</div><input type="file" multiple hidden accept="${esc(accept)}">`;
  stage.append(root);
  const body = root.querySelector('.fm-rail-media-body'), status = root.querySelector('.fm-rail-media-status'), chip = root.querySelector('.fm-rail-chip'), input = root.querySelector('input[type=file]');
  input.addEventListener('change', () => { const files = [...(input.files || [])]; input.value = ''; if (files.length) onFiles(files); });
  // Files dropped anywhere on the view upload as they would from the toolbar.
  let depth = 0;
  root.addEventListener('dragenter', (event) => { if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); depth += 1; root.classList.add('is-dragover'); });
  root.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  root.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) root.classList.remove('is-dragover'); });
  root.addEventListener('drop', (event) => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); depth = 0; root.classList.remove('is-dragover'); onFiles([...event.dataTransfer.files]); });
  const skeleton = () => { status.hidden = false; status.innerHTML = `<div class="fm-rail-skel" aria-label="${esc(T('rail_media_loading', 'Loading…'))}"><div class="fm-rail-skel-head"><span style="width:38%;height:16px"></span><span style="margin-left:auto;width:72px;height:28px"></span><span style="width:72px;height:28px"></span></div><span class="fm-rail-skel-stage"></span><div class="fm-rail-skel-strip"><span></span><span></span><span></span><span></span></div></div>`; };
  const message = ({ icon, title, body: text, actions = [] }) => {
    status.hidden = false;
    status.innerHTML = `<div class="fm-rail-message"><i class="fas ${esc(icon)}" aria-hidden="true"></i><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}${actions.length ? `<div class="fm-rail-actions">${actions.map((action, index) => `<button type="button" class="fm-rail-btn${index === 0 ? ' primary' : ''}" data-rail-action="${index}">${action.icon ? `<i class="fas ${esc(action.icon)}" aria-hidden="true"></i>` : ''}<span>${esc(action.label)}</span></button>`).join('')}</div>` : ''}</div>`;
    status.querySelectorAll('[data-rail-action]').forEach((button) => { button.onclick = () => actions[Number(button.dataset.railAction)]?.onClick?.(); });
  };
  const clearStatus = () => { status.hidden = true; status.replaceChildren(); };
  const setChip = (text) => { chip.hidden = !text; chip.innerHTML = text ? `<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i><span>${esc(text)}</span>` : ''; };
  return { root, body, input, skeleton, message, clearStatus, setChip };
}

// ------------------------------------------------------------------ the carousel (shared viewer, else a fallback)
// The shared viewer's embeddable carousel when it is loaded; otherwise a small stage-and-filmstrip that opens the
// full shared viewer (markup, comments, tags, download, delete) for the item shown.
function mountCarousel(host, options) {
  const factory = window.FirstMateMarkup?.mountMediaCarousel;
  if (typeof factory === 'function') {
    try { const handle = factory(host, options); if (handle) return handle; }
    catch (error) { console.warn('The media carousel could not mount; using the rail fallback.', error); }
  }
  return fallbackCarousel(host, options);
}
function itemKind(item = {}) {
  const explicit = clean(item.media_type || item.mediaType).toLowerCase();
  if (['image', 'video', 'pdf', 'document'].includes(explicit)) return explicit;
  const mime = first(item.content_type, item.mime_type, item.contentType).toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return /\.(mp4|mov|m4v|webm|ogv)(?:[?#].*)?$/i.test(first(item.src, item.url)) ? 'video' : 'image';
}
function fallbackCarousel(host, options = {}) {
  let items = Array.isArray(options.photos) ? options.photos : [], index = Math.max(0, Number(options.index) || 0), visible = true, viewer = null;
  const wrap = document.createElement('div');
  wrap.className = 'fm-rail-fb';
  host.append(wrap);
  const noun = clean(options.collectionNoun) || 'photos';
  const toolbar = Array.isArray(options.toolbar) ? options.toolbar : [];
  const icon = (name) => `fas ${String(name || 'circle').startsWith('fa-') ? name : `fa-${name}`}`;
  const openViewer = () => {
    const open = window.FirstMateMarkup?.openMediaViewer || window.FirstMateMarkup?.openPhotoViewer;
    if (!open || !items.length) return;
    viewer?.close?.();
    viewer = open({ ...options, photos: items, index, projectLinkEnabled: false, boundsTarget: host.closest('.r-win') || host, onChange: (detail) => { const at = items.findIndex((item) => item.id === detail?.photo?.id); if (at >= 0) { index = at; paint(); } options.onChange?.(detail); }, onClose: () => { viewer = null; } });
  };
  const paint = () => {
    const narrow = host.clientWidth > 0 && host.clientWidth < 420;
    wrap.classList.toggle('is-narrow', narrow);
    const item = items[index];
    const empty = options.emptyState || {};
    const tools = toolbar.map((tool) => `<button type="button" class="fm-rail-btn" data-fb-tool="${esc(tool.id)}" title="${esc(tool.label)}" aria-label="${esc(tool.label)}"><i class="${icon(tool.icon)}" aria-hidden="true"></i><span>${esc(tool.label)}</span></button>`).join('');
    const head = `<div class="fm-rail-fb-head"><div class="fm-rail-fb-title"><strong>${esc(item ? (item.label || item.title || '') : noun.charAt(0).toUpperCase() + noun.slice(1))}</strong><span>${items.length ? `${index + 1} / ${items.length} ${esc(noun)}` : ''}</span></div><div class="fm-rail-fb-tools">${tools}</div></div>`;
    if (!item) {
      wrap.innerHTML = `${head}<div class="fm-rail-fb-stage"><div class="fm-rail-message"><i class="${icon(empty.icon || 'images')}" aria-hidden="true"></i><strong>${esc(empty.title || '')}</strong>${empty.body ? `<span>${esc(empty.body)}</span>` : ''}<div class="fm-rail-actions">${(empty.actions || []).map((action, at) => `<button type="button" class="fm-rail-btn${at === 0 ? ' primary' : ''}" data-fb-empty="${at}"><i class="${icon(action.icon)}" aria-hidden="true"></i><span>${esc(action.label)}</span></button>`).join('')}</div></div></div>`;
    } else {
      const kind = itemKind(item), src = first(item.src, item.url), thumb = first(item.thumb, item.thumbnail);
      const stage = kind === 'image' && src ? `<img src="${esc(src)}" alt="${esc(item.alt || item.label || '')}" data-fb-open>`
        : kind === 'video' && src ? `<video src="${esc(src)}" controls playsinline preload="metadata"></video>`
          : `<div class="fm-rail-fb-card" style="--doc-color:${esc(item.color || '')}">${thumb ? `<img src="${esc(thumb)}" alt="" style="max-width:100%;max-height:180px;border-radius:8px;border:1px solid #e4e7ec;background:#fff">` : `<span class="mark"><i class="fas ${esc(item.icon || 'fa-file-lines')}" aria-hidden="true"></i></span>`}<strong>${esc(item.label || item.title || '')}</strong><span>${esc(item.type_label || (kind === 'pdf' ? 'PDF' : ''))}</span></div>`;
      const strip = items.map((entry, at) => { const k = itemKind(entry), t = first(entry.thumb, entry.thumbnail, k === 'image' ? entry.src : ''); return `<button type="button" class="fm-rail-fb-tile" data-fb-index="${at}" aria-current="${at === index}" title="${esc(entry.label || entry.title || '')}" aria-label="${esc(entry.label || entry.title || '')}">${t ? `<img src="${esc(t)}" alt="" loading="lazy">` : `<i class="fas ${esc(entry.icon || (k === 'video' ? 'fa-video' : 'fa-file-lines'))}" aria-hidden="true"></i>`}${k === 'video' ? '<span class="play"><i class="fas fa-play"></i></span>' : ''}</button>`; }).join('');
      wrap.innerHTML = `${head}<div class="fm-rail-fb-stage">${stage}${items.length > 1 ? `<button type="button" class="fm-rail-fb-nav prev" data-fb-step="-1" aria-label="${esc(T('rail_media_previous', 'Previous'))}"><i class="fas fa-chevron-left"></i></button><button type="button" class="fm-rail-fb-nav next" data-fb-step="1" aria-label="${esc(T('rail_media_next', 'Next'))}"><i class="fas fa-chevron-right"></i></button>` : ''}<button type="button" class="fm-rail-btn primary fm-rail-fb-open" data-fb-open><i class="fas fa-up-right-and-down-left-from-center" aria-hidden="true"></i><span>${esc(T('rail_media_open_viewer', 'Open'))}</span></button></div><div class="fm-rail-fb-strip" role="group" aria-label="${esc(noun)}">${strip}</div>`;
      wrap.querySelector(`[data-fb-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    wrap.querySelectorAll('[data-fb-tool]').forEach((button) => { button.onclick = () => toolbar.find((tool) => tool.id === button.dataset.fbTool)?.onClick?.(); });
    wrap.querySelectorAll('[data-fb-empty]').forEach((button) => { button.onclick = () => (options.emptyState?.actions || [])[Number(button.dataset.fbEmpty)]?.onClick?.(); });
    wrap.querySelectorAll('[data-fb-index]').forEach((button) => { button.onclick = () => select(Number(button.dataset.fbIndex)); });
    wrap.querySelectorAll('[data-fb-step]').forEach((button) => { button.onclick = () => select((index + Number(button.dataset.fbStep) + items.length) % items.length); });
    wrap.querySelectorAll('[data-fb-open]').forEach((el) => { el.onclick = openViewer; });
  };
  const select = (at) => {
    const next = typeof at === 'number' ? at : items.findIndex((item) => item.id === at);
    if (next < 0 || next >= items.length) return;
    if (next !== index) { index = next; paint(); options.onChange?.({ photo: items[index], index }); }
  };
  paint();
  return {
    fallback: true,
    get viewer() { return viewer; },
    setItems(next, { keepSelection = true } = {}) { const id = items[index]?.id; items = Array.isArray(next) ? next : []; const at = keepSelection ? items.findIndex((item) => item.id === id) : -1; index = at >= 0 ? at : Math.min(index, Math.max(0, items.length - 1)); paint(); },
    select,
    setVisible(value) { visible = !!value; if (!visible) { viewer?.close?.(); viewer = null; } else paint(); },
    resize() { if (visible) wrap.classList.toggle('is-narrow', host.clientWidth > 0 && host.clientWidth < 420); },
    destroy() { viewer?.close?.(); viewer = null; wrap.remove(); }
  };
}

// The view's lifecycle shared by photos and documents: first load behind a skeleton, then the carousel; a later
// load refreshes the carousel's items in place. Loads while hidden wait until the view is shown.
function railView(stage, ctx, spec) {
  const env = projectEnv(ctx);
  const frame = railFrame(stage, spec.kind, spec.accept, (files) => spec.upload(files, api));
  let alive = true, visible = false, carousel = null, items = [], stale = true, loading = null, timer = 0, failed = false;
  let selected = clean(ctx.initialState?.selected);
  const observer = new ResizeObserver(() => { if (alive && visible) carousel?.resize?.(); });
  observer.observe(frame.root);
  const options = () => ({
    ...spec.viewerOptions(api),
    project: env.project(),
    toolbar: spec.toolbar(api),
    emptyState: spec.emptyState(api),
    onChange: (detail) => { selected = clean(detail?.photo?.id) || selected; spec.onChange?.(detail, api); }
  });
  const load = () => {
    if (!alive) return Promise.resolve();
    if (loading) return loading;
    stale = false;
    if (!carousel) frame.skeleton();
    loading = spec.load(api).then((next) => {
      if (!alive) return;
      failed = false;
      items = next;
      if (!carousel) {
        frame.clearStatus();
        const at = Math.max(0, items.findIndex((item) => item.id === selected));
        carousel = mountCarousel(frame.body, { ...options(), photos: items, index: at });
        carousel.setVisible?.(visible);
      } else carousel.setItems(items, { keepSelection: true });
      if (visible) requestAnimationFrame(() => carousel?.resize?.());
    }).catch((error) => {
      if (!alive) return;
      console.warn(`The rail's ${spec.kind} could not load.`, error);
      if (carousel) { toast(spec.errorTitle(), error?.message || '', false); return; }
      failed = true;
      frame.message({ icon: 'fa-triangle-exclamation', title: spec.errorTitle(), body: T('rail_media_error_body', 'Check your connection and try again.'), actions: [{ label: T('rail_media_retry', 'Try again'), icon: 'fa-rotate', onClick: () => { stale = true; load(); } }] });
    }).finally(() => { loading = null; if (alive && stale && visible) refresh(); });
    return loading;
  };
  // Many events arrive together (an upload resolves, the list saves): read once they settle.
  const refresh = () => {
    stale = true;
    if (!alive || !visible) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (alive && visible && !loading) load(); }, 250);
  };
  const listeners = (spec.events || []).map(([name, handler]) => { const fn = (event) => { if (alive) handler(event, api); }; window.addEventListener(name, fn); return [name, fn]; });
  const api = {
    env, frame, ctx,
    get items() { return items; },
    get carousel() { return carousel; },
    load, refresh,
    upload: () => frame.input.click(),
    setVisible(value) {
      visible = !!value;
      carousel?.setVisible?.(visible);
      if (visible && (stale || failed) && !loading) load();
      if (visible) requestAnimationFrame(() => carousel?.resize?.());
    },
    resize() { carousel?.resize?.(); },
    serialize() { return { selected }; },
    destroy() {
      alive = false; clearTimeout(timer); observer.disconnect();
      listeners.forEach(([name, fn]) => window.removeEventListener(name, fn));
      spec.destroy?.(api);
      carousel?.destroy?.(); carousel = null; stage.replaceChildren();
    }
  };
  frame.skeleton();
  return api;
}

// ================================================================== Photos
function isReceipt(photo = {}) {
  if (window.Portal?.PhotoFeed?.isReceiptMedia) return window.Portal.PhotoFeed.isReceiptMedia(photo);
  const owner = photo.owner || {}, meta = photo.metadata || {};
  return !!photo.receipt || clean(owner.slot || photo.owner_slot).toLowerCase() === 'receipts' || clean(photo.document_type || meta.document_type).toLowerCase() === 'receipt' || !!clean(photo.receipt_id || meta.receipt_id);
}
function isTrashed(photo = {}) { const meta = photo.metadata || {}; return !!(photo.trashed_at || photo.deleted_at || meta.trashed_at || meta.deleted_at || meta.in_trash || photo.in_trash); }
function photoId(photo = {}) { return first(photo.media_id, photo.mediaId, photo.id, photo.photo_id, photo.src, photo.thumb); }
function uploadedAt(photo = {}) { const meta = photo.metadata || {}; return first(photo.uploaded_at, photo.created_at, meta.uploaded_at, meta.created_at, photo.updated_at, meta.updated_at, new Date(0).toISOString()); }
function photoOptions(env) {
  try { const options = window.firstMeasurePhotoOptions?.() || window.Portal?.ProjectPhotosTab?.invoke?.('firstMeasurePhotoOptions'); if (options) return options; } catch (_) {}
  return { orgId: env.orgId(), width: 640 };
}
function hostPhotos(env) {
  const hosted = env.host?.getPhotos?.();
  if (Array.isArray(hosted)) return hosted;
  if (Array.isArray(window.projectPhotos)) return window.projectPhotos;
  return Array.isArray(env.project()?.photos) ? env.project().photos : [];
}
function setHostPhotos(env, photos) {
  if (typeof env.host?.setPhotos === 'function') env.host.setPhotos(photos);
  else try { window.projectPhotos = photos; } catch (_) {}
  const project = env.project();
  if (project && typeof project === 'object') project.photos = photos.filter((photo) => !photo?.uploading).map(({ file, ...rest }) => rest);
}
// The project's media the Photos tab shows: what the project lists, plus media owned by the project that it does not
// list yet (the Photos tab's own hydration), the newer record winning.
function ownedProject(item = {}) {
  const meta = item.metadata || {}, owner = item.owner || meta.owner || {};
  const type = clean(owner.type || item.owner_type || meta.owner_type).toLowerCase(), collection = clean(owner.collection || item.collection || meta.collection).toLowerCase(), slot = clean(owner.slot || item.slot || meta.slot).toLowerCase();
  return type === 'project' || collection === 'projects' || (slot === 'photos' && type !== 'organization') ? first(owner.id, item.owner_id, meta.owner_id) : '';
}
function visualRecord(item = {}) {
  const kind = clean(item.kind || item.media_type).toLowerCase(), mime = first(item.content_type, item.mime_type).toLowerCase();
  return kind === 'image' || kind === 'video' || mime.startsWith('image/') || mime.startsWith('video/');
}
async function rawProjectPhotos(env) {
  const orgId = env.orgId(), projectId = env.projectId(), hosted = hostPhotos(env);
  const list = window.PlatformAPI?.media?.list;
  if (!orgId || !projectId || typeof list !== 'function') return { photos: hosted, owned: false };
  const result = await list.call(window.PlatformAPI.media, orgId, { projectId });
  const owned = (Array.isArray(result?.media) ? result.media : []).filter((item) => ownedProject(item) === projectId && visualRecord(item)).map((item) => {
    const tags = Array.isArray(item.tags) ? item.tags : (Array.isArray(item.metadata?.tags) ? item.metadata.tags : []);
    return window.PlatformAPI.media.referenceFromUpload ? window.PlatformAPI.media.referenceFromUpload(item, { field: 'photos', variant: 'original', tags }) : { kind: 'media_reference', id: item.media_id || item.id, media_id: item.media_id || item.id, field: 'photos', variant: 'original', metadata: item.metadata || {}, tags, owner: item.owner || {} };
  });
  const byId = new Map(owned.map((photo) => [photoId(photo), photo])), seen = new Set(), photos = [];
  for (const photo of [...hosted, ...owned]) {
    const id = photoId(photo);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const fresh = id ? byId.get(id) : null;
    photos.push(fresh && fresh !== photo ? { ...photo, ...fresh, metadata: { ...(photo.metadata || {}), ...(fresh.metadata || {}) }, tags: fresh.tags || fresh.metadata?.tags || photo.tags || [] } : photo);
  }
  return { photos, owned: true };
}
const safeUrl = (value) => { try { const url = clean(value); if (!url) return ''; if (/^data:image\/(jpeg|png|webp);base64,/i.test(url)) return url; const parsed = new URL(url, location.href); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === location.origin ? parsed.href : ''; } catch { return ''; } };
async function reportPhotos(ctx, env) {
  const context = ctx.context || {};
  let report = {};
  if (context.data && Object.hasOwn(context.data, 'reports.photo')) report = context.data['reports.photo'] || {};
  else if (env.orgId() && env.projectId()) {
    const target = { scope: 'project', organizationId: env.orgId(), projectId: env.projectId() };
    const read = context.read || ((source, at) => window.PlatformAPI.publication.read(at.organizationId, { ...source, target: at }));
    const result = await read({ provider: 'project-widgets', export: 'report' }, target);
    report = result?.status === 'ready' ? result.value || {} : {};
  }
  return (Array.isArray(report?.media) ? report.media : []).filter((row) => !row.video && safeUrl(row.url)).map((row, index) => ({
    id: `report:${index}`, src: safeUrl(row.url), url: safeUrl(row.url), thumb: safeUrl(row.thumbnail || row.url),
    label: row.label || T('rail_photos_report_photo', 'Report photo'), alt: row.label || T('rail_photos_report_photo', 'Report photo'),
    media_type: 'image', source: 'report', special: true, aerial: row.label === 'Aerial view', report_photo: true
  })).sort((a, b) => Number(b.aerial) - Number(a.aerial));
}
async function loadPhotoItems(api) {
  const { env, ctx } = api;
  const [report, raw] = await Promise.allSettled([reportPhotos(ctx, env), rawProjectPhotos(env)]);
  if (report.status === 'rejected' && raw.status === 'rejected') throw raw.reason;
  const library = window.PlatformAPI?.projectMedia;
  const rawPhotos = raw.status === 'fulfilled' ? raw.value.photos : hostPhotos(env);
  api.rawPhotos = rawPhotos;
  const normalized = library?.normalizePhotos ? library.normalizePhotos(rawPhotos.filter((photo) => photo?.resource_type !== 'document'), photoOptions(env)) : rawPhotos;
  const project = env.project();
  const media = normalized
    .filter((photo) => photo && (photo.media_id || photo.src || photo.thumb))
    .filter((photo) => !photo.is_top_down_thumbnail && clean(photo.designator) !== 'top_down_thumbnail' && !photo.metadata?.is_top_down_thumbnail)
    .filter((photo) => !photo.uploading && !isReceipt(photo) && !isTrashed(photo))
    .sort((a, b) => uploadedAt(b).localeCompare(uploadedAt(a)));
  const reportItems = report.status === 'fulfilled' ? report.value : [];
  const seen = new Set();
  return [...reportItems, ...media].filter((photo) => { const key = first(photo.media_id, photo.src); if (!key || seen.has(key)) return false; seen.add(key); return true; }).map((photo) => ({ ...photo, __project: project }));
}
// The Photos tab's own viewer actions and indicators when it shares them; otherwise the indicators it shows.
function photoTabExtras(name) {
  const tab = window.Portal?.ProjectPhotosTab;
  try { if (tab?.functionNames?.().includes(name)) { const value = tab.invoke(name); if (Array.isArray(value)) return value; } } catch (_) {}
  return null;
}
function coverIndicators(env) {
  const coverId = () => {
    const project = env.project() || {};
    const chosen = clean((project.custom_field_values || project.custom_fields || {}).cover_photo?.media_id);
    if (chosen) return chosen;
    const saved = window.PlatformAPI?.projectMedia?.savedSatellitePhoto?.(hostPhotos(env));
    return saved ? photoId(saved) : '';
  };
  const photosText = (key, fallback) => globalThis.PlatformLanguage?.text?.('photos', key, fallback) ?? fallback;
  return [
    { id: 'project_note_conversation', label: photosText('m_aad5e273abd212', 'Project note'), detail: 'This media has a Notes conversation', icon: 'comments', tone: 'info', visible: ({ photo }) => clean(photo?.metadata?.source).toLowerCase() === 'project_notes' },
    { id: 'project_cover', label: photosText('cover_badge', 'Cover'), detail: photosText('cover_card_kicker', 'Cover photo'), icon: 'image', tone: 'info', visible: ({ photo }) => !!coverId() && coverId() === photoId(photo) },
    { id: 'report_photo', label: T('rail_photos_report_indicator', 'From the measurement report'), icon: 'ruler-combined', tone: 'info', visible: ({ photo }) => photo?.report_photo === true }
  ];
}
async function trashPhoto(api, photo) {
  const { env } = api, orgId = env.orgId(), projectId = env.projectId(), library = window.PlatformAPI?.projectMedia;
  const target = photoId(photo);
  if (!target || photo.special || !orgId || !projectId || !library?.savePhotos) return { count: 0, bytes: 0 };
  const photosText = (key, fallback) => globalThis.PlatformLanguage?.text?.('photos', key, fallback) ?? fallback;
  const question = photosText('m_25d73fd9f0ab17', 'Move 1 media item to trash? They will still count toward storage until the trash is emptied.', { v0: 1, v1: '' });
  const ok = await (window.PlatformUI?.confirm?.(question, { title: photosText('m_f46cc145599314', 'Delete Media'), okLabel: 'Move to Trash', cancelLabel: 'Cancel', danger: true }) || Promise.resolve(window.confirm(question)));
  if (!ok) return { count: 0, bytes: 0 };
  // The Photos tab's trash: the item stays in the project's list, marked as in the trash.
  const raw = api.rawPhotos || hostPhotos(env), now = new Date().toISOString();
  const next = raw.map((entry) => photoId(entry) !== target ? entry : { ...entry, trashed_at: entry.trashed_at || now, deleted_at: entry.deleted_at || now, in_trash: true, metadata: { ...(entry.metadata || {}), trashed_at: entry.metadata?.trashed_at || now, deleted_at: entry.metadata?.deleted_at || now, in_trash: true } });
  await library.savePhotos(orgId, projectId, { ...env.project(), photos: raw }, next, { source: 'photo_trash' });
  setHostPhotos(env, next);
  window.dispatchEvent(new CustomEvent('fm:photos:changed', { detail: { action: 'trash', count: 1, bytes: Number(photo.size_bytes || 0) } }));
  toast(photosText('m_e6ced0d83aa8e5', 'Moved to trash'), photosText('m_43d21e107c88ec', '1 media item moved.', { v0: 1, v1: '' }), true);
  api.refresh();
  return { count: 1, bytes: Number(photo.size_bytes || 0) };
}
async function uploadPhotos(api, files) {
  const add = window.addPhotoFiles || ((list, options) => window.Portal?.ProjectPhotosTab?.invoke?.('addPhotoFiles', [list, options]));
  if (!api.env.projectId()) { toast(T('rail_media_upload_unavailable', 'Upload unavailable'), T('rail_media_save_first', 'Save the project before uploading.'), false); return; }
  const accepted = files.filter((file) => /^(image|video)\//.test(file.type || ''));
  if (!accepted.length) { toast(T('rail_photos_upload_type', 'Not a photo or video'), T('rail_photos_upload_type_body', 'Choose photos or videos to upload here.'), false); return; }
  api.frame.setChip(T('rail_photos_uploading', `Uploading ${accepted.length} ${plural(accepted.length, 'item', 'items')}…`, { count: accepted.length }));
  try { await add(accepted); }
  catch (error) { toast(globalThis.PlatformLanguage?.text?.('docs', 'm_eba695c553b0b3', 'Upload failed') ?? 'Upload failed', error?.message || '', false); }
  finally { api.frame.setChip(''); api.refresh(); }
}
function takePhotos(api) {
  const { env } = api;
  window.FirstMateCamera?.open?.({
    orgId: env.orgId(), projectId: env.projectId(), projectTitle: env.title(),
    upload: async (file) => {
      const add = window.addPhotoFiles || ((list, options) => window.Portal?.ProjectPhotosTab?.invoke?.('addPhotoFiles', [list, options]));
      const [photo] = await add([file], { rethrow: true });
      if (!photo) throw new Error(globalThis.PlatformLanguage?.text?.('photos', 'camera_not_uploaded', 'This photo was not uploaded.') ?? 'This photo was not uploaded.');
      return photo;
    },
    onDone: () => api.refresh()
  });
}

export function mountRailPhotos(stage, ctx = {}) {
  return railView(stage, ctx, {
    kind: 'photos',
    accept: PHOTO_ACCEPT,
    load: loadPhotoItems,
    upload: (files, api) => uploadPhotos(api, files),
    errorTitle: () => T('rail_photos_error', 'Photos could not load'),
    toolbar: (api) => [
      { id: 'upload', label: T('rail_media_upload', 'Upload'), icon: 'upload', onClick: () => api.upload() },
      ...(cameraAvailable() ? [{ id: 'take_photos', label: T('rail_photos_take', 'Take photos'), icon: 'camera', onClick: () => takePhotos(api) }] : []),
      { id: 'open_photos', label: T('rail_photos_open_tab', 'Open in Photos'), icon: 'images', onClick: () => openProjectTab(api.env, 'photos', 'operations-rail-photos') }
    ],
    emptyState: (api) => ({
      icon: 'images',
      title: T('rail_photos_empty_title', 'No photos yet'),
      body: T('rail_photos_empty_body', 'Photos and videos of this project show here. Upload them or take them on site.'),
      actions: [
        { id: 'upload', label: T('rail_media_upload', 'Upload'), icon: 'upload', onClick: () => api.upload() },
        ...(cameraAvailable() ? [{ id: 'take_photos', label: T('rail_photos_take', 'Take photos'), icon: 'camera', onClick: () => takePhotos(api) }] : [])
      ]
    }),
    viewerOptions: (api) => ({
      itemNoun: 'photo',
      collectionNoun: 'photos',
      actions: photoTabExtras('portalViewerActions') || [],
      indicators: photoTabExtras('portalViewerIndicators') || coverIndicators(api.env),
      canDelete: ({ photo }) => !!clean(photo?.media_id) && !photo?.special,
      onDeletePhoto: (photo) => trashPhoto(api, photo),
      onTagsChange: async ({ photo, tags }) => {
        const mediaId = clean(photo?.media_id || photo?.mediaId);
        if (!mediaId || typeof window.PlatformAPI?.media?.updateTags !== 'function') throw new Error('Media tagging is not available.');
        const result = await window.PlatformAPI.media.updateTags(api.env.orgId(), mediaId, tags);
        setHostPhotos(api.env, hostPhotos(api.env).map((entry) => photoId(entry) === mediaId ? { ...entry, tags, metadata: { ...(entry.metadata || {}), tags } } : entry));
        api.env.host?.persistProject?.() ?? window.persistActiveBaseProject?.();
        api.items.forEach((item) => { if (clean(item.media_id) === mediaId) { item.tags = tags; item.metadata = { ...(item.metadata || {}), tags }; } });
        return result;
      }
    }),
    events: [
      ['fm:project-media-upload-started', (event, api) => { if (!event.detail?.projectId || event.detail.projectId === api.env.projectId()) api.refresh(); }],
      ['fm:project-media-upload-resolved', (event, api) => { if (!event.detail?.projectId || event.detail.projectId === api.env.projectId()) api.refresh(); }],
      ['fm:project-note-media-uploaded', (event, api) => { if (clean(event.detail?.projectId) === api.env.projectId()) api.refresh(); }],
      ['fm:media-video-saved', (event, api) => { const id = clean(event.detail?.projectId); if (!id || id === api.env.projectId()) api.refresh(); }],
      ['fm:media-renamed', (event, api) => { if (api.items.some((item) => clean(item.media_id) === clean(event.detail?.mediaId))) api.refresh(); }],
      ['fm:media-markup-saved', (event, api) => { if (api.items.some((item) => clean(item.media_id) === clean(event.detail?.mediaId))) api.refresh(); }],
      ['fm:photos:changed', (_event, api) => api.refresh()]
    ]
  });
}

// ================================================================== Documents
const DOC_TYPES = {
  roof_report_xml: ['roof_report_xml', 'Roof Report XML', 'fa-ruler-combined'],
  roof_report: ['m_51ac44c5f2e0fc', 'Roof Report', 'fa-ruler-combined'],
  customer_report: ['m_d7e9bec617183b', 'Customer Report', 'fa-ruler-combined'],
  proposal: ['m_1d8655e967c464', 'Proposal', 'fa-file-signature', '#2563eb'],
  change_order: ['m_4c17910c74a05e', 'Change Order', 'fa-file-contract', '#7c3aed'],
  instant_report: ['m_f8f58e81f3e5f9', 'Instant Report', 'fa-bolt', '#ca8a04'],
  weather_report: ['m_e2f688300156b9', 'Weather Report', 'fa-cloud-sun-rain', '#0d9488'],
  invoice: ['m_1d5ea39cc421fc', 'Invoice', 'fa-file-invoice-dollar', '#175cd3'],
  receipt: ['m_ab3df34a8730df', 'Receipt', 'fa-receipt', '#b54708'],
  contract: ['m_06c8cfa66b1dbc', 'Contract', 'fa-file-pen', '#0f766e'],
  work_order: ['m_338a7c0bfabed0', 'Work Order', 'fa-clipboard-list', '#b45309'],
  completion_certificate: ['m_a8e9d925687a1e', 'Completion Certificate', 'fa-award', '#16a34a'],
  report: ['m_c47c2ce6bb05c0', 'Report', 'fa-file-lines', '#0891b2'],
  document: ['m_9c9b98b1f4e8c9', 'Document', 'fa-file-lines', '#64748b']
};
const docType = (doc = {}) => clean(doc.document_type || doc.type || 'document').toLowerCase().replace(/[\s-]+/g, '_') || 'document';
function typeMeta(type) {
  const [key, fallback, icon, color] = DOC_TYPES[type] || DOC_TYPES.document;
  return { label: docsText(key, fallback), icon, color: color || 'var(--primary,#d93025)' };
}
const docId = (doc = {}, fallback = '') => first(doc.id, doc.document_id, doc.media_id, doc.mediaId, doc.url, doc.href, fallback);
function docFileUrl(env, doc = {}) {
  const mediaId = first(doc.media_id, doc.mediaId);
  if (mediaId && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(env.orgId(), mediaId, 'original');
  return first(doc.url, doc.href, doc.src);
}
function docKind(doc = {}, url = '') {
  const mime = first(doc.content_type, doc.contentType, doc.mime_type, doc.mimeType).toLowerCase(), name = first(doc.file_name, doc.fileName, doc.title, url).toLowerCase();
  if (mime.includes('pdf') || /\.pdf(?:$|[?#])/i.test(name) || /\.pdf(?:$|[?#])/i.test(url) || /\/pdf(?:$|[?#])/.test(url)) return 'pdf';
  if (mime.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|heic)(?:$|[?#])/i.test(name)) return 'image';
  if (mime.startsWith('video/') || /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(name)) return 'video';
  return 'document';
}
function documentsBase() { return clean(window.PlatformAPI?.baseUrl?.()).replace(/\/platform\/?$/, '') || '/v1'; }
function enginePdfUrl(env, record, snapshotId) {
  const org = encodeURIComponent(env.orgId()), id = encodeURIComponent(record.id);
  return `${documentsBase()}/documents/organizations/${org}/documents/${id}/pdf${snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : ''}`;
}
const STATUS_TONES = { draft: 'muted', sent: 'info', viewed: 'warn', signed: 'success', completed: 'success', paid: 'success', declined: 'danger', expired: 'danger', void: 'danger' };
// One item per thing the Docs tab lists: the shape the Docs tab hands the shared viewer (documentPhoto), plus what the
// Operations rail adds (the material sets an accepted document published).
function docItem(env, doc, extra = {}) {
  const type = docType(doc), meta = typeMeta(type), url = first(extra.url, docFileUrl(env, doc)), title = first(doc.title, doc.label, doc.file_name, doc.name, meta.label);
  const kind = extra.media_type || docKind(doc, url);
  return {
    ...doc, ...extra,
    id: docId(doc), media_id: first(doc.media_id, doc.mediaId), document_type: type, type_label: first(doc.type_label, meta.label),
    icon: first(extra.icon, doc.icon, meta.icon), color: first(doc.color, meta.color), title, label: title, alt: title,
    src: first(extra.src, url), url, thumb: first(extra.thumb, doc.media_id && kind === 'image' && window.PlatformAPI?.media?.thumbnailUrl ? window.PlatformAPI.media.thumbnailUrl(env.orgId(), doc.media_id, 320) : ''),
    media_type: kind, uploaded_at: first(doc.uploaded_at, doc.created_at, doc.updated_at, doc.metadata?.uploaded_at, doc.metadata?.created_at, env.project()?.updated_at, new Date(0).toISOString()),
    tags: [first(doc.type_label, meta.label), type].filter(Boolean),
    __document: doc, __project: env.project()
  };
}
function reportItems(env, assets = {}, stored = []) {
  const measured = env.project()?.measurement_project || env.project()?.measurement || {};
  const producedAt = first(measured.completed_at, measured.raw?.completed_at);
  return [
    ['roof_report_pdf', 'roof_report', 'roof_measurements_report', 'Roof Measurement Report', 'reportUrl', 'application/pdf', 'roof-measurements.pdf'],
    ['customer_report_pdf', 'customer_report', 'customer_roof_report', 'Customer Roof Report', 'summaryUrl', 'application/pdf', 'customer-roof-report.pdf'],
    ['roof_report_xml', 'roof_report_xml', 'roof_report_xml', 'Roof Report XML', 'xmlUrl', 'application/xml', 'roof-report.xml']
  ].flatMap(([id, type, key, title, asset, contentType, fileName]) => {
    const url = clean(assets?.[asset]);
    if (!url) return [];
    const kept = stored.find((doc) => docId(doc) === id) || {};
    return [docItem(env, { ...kept, id, document_type: type, title: docsText(key, title), url, content_type: contentType, file_name: fileName, special: true, source: 'report', uploaded_at: first(producedAt, kept.uploaded_at), related: { tab: 'measurements', label: type === 'customer_report' ? 'View Customer Report' : 'View Roof Report' } }, { media_type: type === 'roof_report_xml' ? 'document' : 'pdf', icon: 'fa-ruler-combined' })];
  });
}
function invoiceItem(env, invoice, index) {
  const id = first(invoice.id, `invoice_${index + 1}`), url = window.PaymentsAPI?.invoices?.pdfUrl?.(env.orgId(), id) || '';
  return docItem(env, { id: `invoice:${id}`, invoice_id: id, title: first(invoice.invoice_number, invoice.title, `Invoice ${index + 1}`), document_type: 'invoice', url, content_type: 'application/pdf', file_name: `${first(invoice.invoice_number, 'invoice')}.pdf`, created_at: first(invoice.created_at, invoice.issue_date), updated_at: first(invoice.updated_at, invoice.created_at), special: true, interactive: !!url, can_markup: false, metadata: { source: 'payments_invoice', invoice_id: id, status: clean(invoice.status), total_cents: Number(invoice.total_cents || 0), balance_due_cents: Number(invoice.balance_due_cents || 0) } }, { media_type: 'pdf', status: clean(invoice.status).toLowerCase() });
}
// A document built in the document engine (proposal, contract, change order, work order). It shows as a PDF only when
// one is already stored (the accepted snapshot's, or the document's latest): the PDF route makes and stores one for a
// document that has none, from its current state, so opening this view must never reach it then. Without a stored PDF
// it shows its preview page, else its card; "Open the document" opens it in the Docs tab.
function engineItem(env, record, accepted) {
  const status = clean(window.FMDocModel?.documentProgress?.(record) || record.status).toLowerCase();
  const summary = record.summary && typeof record.summary === 'object' ? record.summary : {};
  const pdfMedia = first(record.pdf?.latest_media_id, record.pdf?.latest_media_ref?.media_id);
  const previewMedia = first(record.preview_media_ref?.media_id);
  const snapshotPdf = first(accepted?.snapshot?.pdf?.media_id, accepted?.snapshot?.pdf?.media_ref?.media_id);
  const snapshotId = snapshotPdf ? accepted.snapshotId : (pdfMedia ? first(record.delivery?.current_snapshot_id) : '');
  const media = window.PlatformAPI?.media;
  const thumb = previewMedia && media?.thumbnailUrl ? media.thumbnailUrl(env.orgId(), previewMedia, 320) : (accepted?.thumbnail || '');
  const base = { ...record, id: `engine:${record.id}`, engine_document: true, title: first(accepted?.title, record.title), document_type: docType(record), status, special: true, can_markup: false, created_at: record.created_at, updated_at: first(record.updated_at, record.created_at), uploaded_at: first(accepted?.acceptedAt, record.updated_at, record.created_at), metadata: { ...(record.metadata || {}), source: 'document_engine', engine_status: status } };
  delete base.media_id;
  const extra = { status, thumb, total: accepted?.total || (Number.isFinite(Number(summary.total_cents)) && summary.total_cents !== null && summary.total_cents !== undefined ? money(Number(summary.total_cents) / 100) : ''), sets: accepted?.sets || [], accepted: !!accepted, acceptedAt: accepted?.acceptedAt || '', snapshotId: accepted?.snapshotId || '', __engineDoc: record };
  if (snapshotPdf || pdfMedia) return docItem(env, base, { ...extra, media_type: 'pdf', url: enginePdfUrl(env, record, snapshotId) });
  if (previewMedia && media?.fileUrl) return docItem(env, base, { ...extra, media_type: 'image', url: '', src: media.fileUrl(env.orgId(), previewMedia, 'original') });
  // A draft with no PDF and no preview yet: its card, with "Open the document".
  return docItem(env, base, { ...extra, media_type: 'document', url: '', src: '' });
}
async function loadDocumentItems(api) {
  const { env } = api, orgId = env.orgId(), projectId = env.projectId();
  if (!orgId || !projectId) return [];
  const scope = Array.isArray(api.scopeDocuments) ? api.scopeDocuments : [];
  const scopeReports = scope.filter((doc) => doc.source === 'report_asset');
  const assetsFromScope = scopeReports.length ? Object.fromEntries(scopeReports.map((doc) => [doc.id === 'roof_report_pdf' ? 'reportUrl' : doc.id === 'customer_report_pdf' ? 'summaryUrl' : 'xmlUrl', doc.url])) : null;
  const [uploaded, invoices, engine, assets] = await Promise.allSettled([
    window.PlatformAPI?.projectDocuments?.list ? window.PlatformAPI.projectDocuments.list(orgId, projectId) : Promise.resolve({ documents: env.project()?.documents || [] }),
    window.PaymentsAPI?.invoices?.list ? window.PaymentsAPI.invoices.list(orgId, projectId) : Promise.resolve({ invoices: [] }),
    window.DocumentsAPI?.documents?.listForProject ? window.DocumentsAPI.documents.listForProject(orgId, projectId) : Promise.resolve({ documents: [] }),
    assetsFromScope ? Promise.resolve(assetsFromScope) : Promise.resolve(env.host?.loadReportDocumentAssets?.() || null)
  ]);
  if ([uploaded, invoices, engine].every((result) => result.status === 'rejected')) throw uploaded.reason;
  const stored = uploaded.status === 'fulfilled' ? (uploaded.value?.documents || []) : (env.project()?.documents || []);
  const reports = reportItems(env, assets.status === 'fulfilled' ? assets.value || {} : {}, stored);
  const reportIds = new Set(reports.map((doc) => doc.id));
  const invoiceList = invoices.status === 'fulfilled' && Array.isArray(invoices.value?.invoices) ? invoices.value.invoices : [];
  const knownInvoices = new Set(stored.map((doc) => first(doc.invoice_id, doc.metadata?.invoice_id)).filter(Boolean));
  const acceptedById = new Map(scope.filter((doc) => doc.source === 'document' && doc.documentId).map((doc) => [doc.documentId, doc]));
  const records = engine.status === 'fulfilled' ? (engine.value?.documents || []) : [];
  const engineItems = records.filter((record) => record?.id && clean(record.status).toLowerCase() !== 'void').map((record) => engineItem(env, record, acceptedById.get(record.id))).filter(Boolean);
  // An accepted document the engine list did not return (it could not load): still show it from the rail's own read.
  for (const [id, doc] of acceptedById) if (!records.some((record) => record?.id === id)) { const item = engineItem(env, { ...doc, id }, doc); if (item) engineItems.push(item); }
  const seen = new Set();
  const media = stored.filter((doc) => !reportIds.has(docId(doc))).map((doc) => docItem(env, doc)).filter((doc) => doc.interactive !== false && (doc.url || doc.media_id));
  const all = [...engineItems, ...media, ...reports, ...invoiceList.filter((invoice) => !knownInvoices.has(first(invoice.id))).map((invoice, index) => invoiceItem(env, invoice, index))]
    .filter((doc) => { if (!doc.id || seen.has(doc.id)) return false; seen.add(doc.id); return true; });
  // The Docs tab lists newest first.
  return all.sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
}
function materialsCount(doc) { return (doc.sets || []).reduce((sum, set) => sum + (Array.isArray(set.lines) ? set.lines.length : 0), 0); }
function materialsTable(doc) {
  const sets = Array.isArray(doc.sets) ? doc.sets : [];
  if (!sets.length) return `<p>${esc(T('rail_docs_no_sets', 'This document published no materials.'))}</p>`;
  return sets.map((set) => `<section><h3>${esc(set.title || T('rail_docs_set', 'Materials'))}</h3>${(set.lines || []).length ? `<div class="fm-rail-table"><table><thead><tr><th>${esc(T('rail_docs_col_material', 'Material'))}</th><th>${esc(T('rail_docs_col_required', 'Required'))}</th><th>${esc(T('rail_docs_col_order', 'Order quantity'))}</th><th>${esc(T('rail_docs_col_cost', 'Unit cost'))}</th></tr></thead><tbody>${set.lines.map((line) => `<tr><td><strong>${esc(line.name)}</strong>${line.variant ? `<small>${esc(line.variant)}</small>` : ''}${line.explanation ? `<small>${esc(line.explanation)}</small>` : ''}${line.group || line.structure ? `<small>${esc([line.group, line.structure].filter(Boolean).join(' · '))}</small>` : ''}</td><td>${esc(number(line.quantity))} ${esc(line.unit || '')}</td><td>${esc(number(line.order_quantity))} ${esc(line.order_unit || '')}</td><td>${line.unit_cost == null ? '—' : esc(money(line.unit_cost, line.currency))}</td></tr>`).join('')}</tbody></table></div>` : `<p>${esc(T('rail_docs_set_pending', 'This accepted document published a material calculation. Quantities have not been generated yet.'))}</p>`}${(set.evaluations?.find((evaluation) => evaluation.id === set.applied_evaluation)?.warnings || []).map((warning) => `<p>${esc(warning)}</p>`).join('')}</section>`).join('');
}
function showMaterials(api, doc) {
  const sheet = api.frame.root.querySelector('.fm-rail-sheet') || (() => { const el = document.createElement('div'); el.className = 'fm-rail-sheet'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'false'); api.frame.root.append(el); return el; })();
  const typeLabel = typeMeta(doc.document_type).label.toLowerCase();
  sheet.setAttribute('aria-label', T('rail_docs_materials_title', 'Published materials'));
  sheet.innerHTML = `<header><div><small>${esc(T('rail_docs_accepted', `Accepted ${typeLabel}`, { type: typeLabel }))}${doc.acceptedAt ? ` · ${esc(shortDate(doc.acceptedAt))}` : ''}</small><h2 tabindex="-1">${esc(doc.title)}</h2>${doc.total ? `<strong>${esc(doc.total)}</strong>` : ''}</div><button type="button" class="fm-rail-btn icon" data-rail-sheet-close aria-label="${esc(T('rail_media_close', 'Close'))}" title="${esc(T('rail_media_close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button></header><div class="fm-rail-sheet-body">${materialsTable(doc)}</div>`;
  const close = () => { sheet.classList.remove('open'); setTimeout(() => { sheet.hidden = true; }, 180); window.removeEventListener('keydown', onKey, true); };
  const onKey = (event) => { if (event.key === 'Escape' && !sheet.hidden && sheet.offsetParent && sheet.classList.contains('open')) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
  sheet.querySelector('[data-rail-sheet-close]').onclick = close;
  window.addEventListener('keydown', onKey, true);
  sheet.hidden = false;
  requestAnimationFrame(() => { sheet.classList.add('open'); sheet.querySelector('h2')?.focus(); });
}
async function openEngineDocument(api, doc) {
  const record = doc.__engineDoc || { id: clean(doc.id).replace(/^engine:/, '') };
  const docs = window.Portal?.modules?.projectDocsTab || window.Portal?.ProjectDocsTab;
  if (docs?.openEngineDocument) {
    openProjectTab(api.env, 'docs', 'operations-rail-document-open');
    if (await docs.openEngineDocument(record).catch(() => false)) return;
  }
  window.open(enginePdfUrl(api.env, record, doc.snapshotId), '_blank', 'noopener');
}
async function uploadDocuments(api, files) {
  const { env } = api, orgId = env.orgId(), projectId = env.projectId();
  if (!orgId || !projectId || !window.PlatformAPI?.projectDocuments?.upload) { toast(docsText('m_920aa9d1b0216a', 'Upload unavailable'), docsText('m_546d652f15f847', 'Save the project before uploading documents.'), false); return; }
  api.frame.setChip(T('rail_docs_uploading', `Uploading ${files.length} ${plural(files.length, 'file', 'files')}…`, { count: files.length }));
  let uploaded = null, done = 0;
  for (const file of files) {
    try {
      const result = await window.PlatformAPI.projectDocuments.upload(orgId, projectId, file, { title: file.name, document_type: 'document' });
      uploaded = result?.uploaded_documents || uploaded;
      done += 1;
    } catch (error) {
      toast(docsText('m_eba695c553b0b3', 'Upload failed'), error?.message || `Could not upload ${file.name || 'document'}.`, false);
    }
  }
  api.frame.setChip('');
  if (!done) return;
  // As the Docs tab does: the project keeps its uploaded documents, and its Docs tab reads them again.
  const project = env.project();
  if (uploaded && project && typeof project === 'object') { project.documents = uploaded; env.host?.setProject?.(project); }
  env.host?.persistProject?.();
  await window.PlatformAPI?.mediaStorage?.usage?.(orgId)?.catch?.(() => null);
  const docsTab = window.Portal?.ProjectDocsTab;
  try { if (docsTab?.context?.().loadedForProjectId === projectId) docsTab.loadDocs?.({ force: true, quiet: true }); } catch (_) {}
  api.refresh();
}
async function removeDocument(api, doc) {
  const { env } = api;
  if (!doc?.media_id || doc.special || !window.PlatformAPI?.projectDocuments?.remove) return { count: 0 };
  const question = globalThis.PlatformLanguage?.text?.('docs', 'm_bd3178edcda733', `Remove ${doc.title || 'this document'} from the project?`, { v0: doc.title || 'this document' }) ?? `Remove ${doc.title || 'this document'} from the project?`;
  const ok = await (window.PlatformUI?.confirm?.(question, { title: T('rail_docs_remove_title', 'Remove document'), okLabel: T('rail_docs_remove_ok', 'Remove'), cancelLabel: 'Cancel', danger: true }) || Promise.resolve(window.confirm(question)));
  if (!ok) return { count: 0 };
  try {
    const result = await window.PlatformAPI.projectDocuments.remove(env.orgId(), env.projectId(), docId(doc));
    const project = env.project();
    if (project && typeof project === 'object' && Array.isArray(result?.uploaded_documents)) { project.documents = result.uploaded_documents; env.host?.setProject?.(project); }
    env.host?.persistProject?.();
    const docsTab = window.Portal?.ProjectDocsTab;
    try { if (docsTab?.context?.().loadedForProjectId === env.projectId()) docsTab.loadDocs?.({ force: true, quiet: true }); } catch (_) {}
    api.refresh();
    return { count: 1 };
  } catch (error) {
    toast(docsText('m_16f422ba4271fa', 'Remove failed'), error?.message || 'Could not remove this document.', false);
    return { count: 0 };
  }
}
function documentIndicators() {
  const statusLabel = (status) => clean(status).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return [
    { id: 'accepted_document', icon: 'file-signature', tone: 'success',
      label: ({ photo }) => T('rail_docs_accepted', `Accepted ${typeMeta(photo.document_type).label.toLowerCase()}`, { type: typeMeta(photo.document_type).label.toLowerCase() }),
      detail: ({ photo }) => [photo.total, photo.acceptedAt ? shortDate(photo.acceptedAt) : ''].filter(Boolean).join(' · '),
      visible: ({ photo }) => photo?.accepted === true },
    { id: 'published_materials', icon: 'boxes-stacked', tone: 'info',
      label: ({ photo }) => { const count = materialsCount(photo); return count ? T('rail_docs_published_count', `Published ${count} ${plural(count, 'material', 'materials')}`, { count }) : T('rail_docs_published_pending', 'Published a material calculation'); },
      detail: ({ photo }) => (photo.sets || []).map((set) => set.title).filter(Boolean).join(', '),
      visible: ({ photo }) => Array.isArray(photo?.sets) && photo.sets.length > 0 },
    { id: 'document_status', icon: 'circle-info',
      tone: ({ photo }) => STATUS_TONES[clean(photo.status)] || 'info',
      label: ({ photo }) => statusLabel(photo.status), detail: ({ photo }) => photo.total || '',
      visible: ({ photo }) => !!clean(photo?.status) && photo?.accepted !== true }
  ];
}

export function mountRailDocuments(stage, ctx = {}) {
  const view = railView(stage, ctx, {
    kind: 'documents',
    accept: DOC_ACCEPT,
    load: loadDocumentItems,
    upload: (files, api) => uploadDocuments(api, files),
    errorTitle: () => T('rail_docs_error', 'Documents could not load'),
    toolbar: (api) => [
      { id: 'upload', label: T('rail_media_upload', 'Upload'), icon: 'upload', onClick: () => api.upload() },
      { id: 'open_docs', label: T('rail_docs_open_tab', 'Open in Docs'), icon: 'folder-open', onClick: () => openProjectTab(api.env, 'docs', 'operations-rail-docs') }
    ],
    emptyState: (api) => ({
      icon: 'file-lines',
      title: T('rail_docs_empty_title', 'No documents yet'),
      body: T('rail_docs_empty_body', 'Reports, accepted proposals and contracts, invoices and uploaded files for this project show here.'),
      actions: [
        { id: 'upload', label: T('rail_media_upload', 'Upload'), icon: 'upload', onClick: () => api.upload() },
        { id: 'open_docs', label: T('rail_docs_open_tab', 'Open in Docs'), icon: 'folder-open', onClick: () => openProjectTab(api.env, 'docs', 'operations-rail-docs') }
      ]
    }),
    viewerOptions: (api) => ({
      itemNoun: 'document',
      collectionNoun: 'documents',
      indicators: documentIndicators(),
      actions: [
        { id: 'show_materials', icon: 'boxes-stacked',
          label: ({ photo }) => { const count = materialsCount(photo); return count ? T('rail_docs_show_materials', `Show ${count} ${plural(count, 'material', 'materials')}`, { count }) : T('rail_docs_show_calculation', 'Show material calculation'); },
          visible: ({ photo }) => Array.isArray(photo?.sets) && photo.sets.length > 0,
          onClick: ({ photo }) => showMaterials(api, photo) },
        { id: 'open_document', icon: 'pen-to-square', label: T('rail_docs_open_document', 'Open the document'),
          visible: ({ photo }) => photo?.engine_document === true,
          onClick: ({ photo }) => openEngineDocument(api, photo) },
        { id: 'open_original', icon: 'up-right-from-square', label: docsText('m_237716bb3d8498', 'Open Original'),
          visible: ({ photo }) => !!first(photo?.url, photo?.src) && !/^fm-doc:/.test(first(photo?.url, photo?.src)),
          onClick: ({ photo }) => window.open(first(photo.url, photo.src), '_blank', 'noopener') },
        { id: 'document_details', icon: 'arrow-up-right-from-square',
          label: ({ photo }) => first(photo?.related?.label, 'View Report'),
          visible: ({ photo }) => !!photo?.related?.tab,
          onClick: ({ photo }) => openProjectTab(api.env, photo.related.tab, 'operations-rail-document-related') }
      ],
      canDelete: ({ photo }) => !photo?.special && !!clean(photo?.media_id),
      onDeletePhoto: (photo) => removeDocument(api, photo)
    }),
    events: [
      ['fm:documents:refresh', (event, api) => { const id = clean(event.detail?.project_id); if (!id || id === api.env.projectId()) api.refresh(); }],
      ['fm:media-renamed', (event, api) => { if (api.items.some((item) => clean(item.media_id) === clean(event.detail?.mediaId))) api.refresh(); }]
    ]
  });
  view.scopeDocuments = Array.isArray(ctx.documents) ? ctx.documents : [];
  let fingerprint = JSON.stringify(view.scopeDocuments.map((doc) => [doc.id, doc.source, doc.url, materialsCount(doc)]));
  // The rail read its scope documents again (an accepted document, a report delivered): read the list again.
  view.update = (documents) => {
    const next = Array.isArray(documents) ? documents : [];
    const key = JSON.stringify(next.map((doc) => [doc.id, doc.source, doc.url, materialsCount(doc)]));
    view.scopeDocuments = next;
    if (key !== fingerprint) { fingerprint = key; view.refresh(); }
  };
  return view;
}
