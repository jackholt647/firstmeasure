/* libraries/markup/firstmate-markup.js
 * Shared markup and photo viewer primitives for FirstMate surfaces.
 */
(function(){
  const root = window;
  const PHOTO_MARKUP_LAYER = 'photo_markup';
  const PHOTO_COMMENTS_LAYER = 'photo_comments';
  const MARKUP_DEFAULT_COLORS = ['#111111', '#d93025', '#2563eb', '#15803d', '#fbbc04'];
  const MARKUP_RECENT_COLORS_KEY = 'fm_markup_recent_colors_v1';
  const ERASER_STROKE_WIDTH = 6;
  const ERASER_RADIUS = ERASER_STROKE_WIDTH / 200;
  const TEXT_SIZE_WIDTH_SCALE = 0.024;

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return cleanText(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function escapeMarkupText(value){
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function sanitizeMarkupHtml(value){
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '');
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child.remove();
          return;
        }
        const tag = child.tagName.toLowerCase();
        if (!['br', 'div', 'span', 'font'].includes(tag)) {
          child.replaceWith(document.createTextNode(child.textContent || ''));
          return;
        }
        [...child.attributes].forEach((attr) => {
          const name = attr.name.toLowerCase();
          const value = attr.value;
          if (name === 'color') return;
          if (name === 'style') {
            const match = value.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
            if (match) child.setAttribute('style', `color:${match[1].trim()}`);
            else child.removeAttribute(attr.name);
            return;
          }
          child.removeAttribute(attr.name);
        });
        walk(child);
      });
    };
    walk(template.content);
    return template.innerHTML;
  }
  function clamp(value, min, max){ return Math.max(min, Math.min(max, value)); }
  function normalizeColor(color){
    const value = cleanText(color).toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) return `#${value.slice(1).split('').map((ch) => `${ch}${ch}`).join('')}`.toLowerCase();
    return '';
  }
  function escapeRegex(value){
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function mentionAvatar(mention = {}){
    return cleanText(mention.avatar || mention.avatar_url || mention.photo_url || mention.profile_photo_url || mention.image_url || mention.picture || mention.raw?.avatar || mention.raw?.avatar_url || mention.raw?.photo_url || mention.raw?.profile_photo_url);
  }
  function mentionChipHtml(mention = {}, label = ''){
    const name = cleanText(mention.name || mention.label || mention.email || mention.id || label.replace(/^@/, ''));
    const email = cleanText(mention.email || mention.id);
    const avatar = mentionAvatar(mention);
    const initial = (name || email || '?').slice(0, 1).toUpperCase();
    return `<span class="fm-photo-mention" role="button" tabindex="0" data-photo-mention-user="${escapeHtml(mention.id || email || name)}" data-photo-mention-name="${escapeHtml(name)}" data-photo-mention-email="${escapeHtml(email)}" data-photo-mention-avatar="${escapeHtml(avatar)}">${escapeHtml(label.replace(/^@/, '') || name)}<span class="fm-photo-mention-card"><span class="fm-photo-mention-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initial)}</span><span style="min-width:0"><span class="fm-photo-mention-name">${escapeHtml(name || email || 'User')}</span>${email ? `<span class="fm-photo-mention-email">${escapeHtml(email)}</span>` : ''}</span></span></span>`;
  }
  function renderMentionText(text = '', mentions = []){
    const value = String(text ?? '');
    const mentionList = Array.isArray(mentions) ? mentions.filter(Boolean) : [];
    if (!value || !mentionList.length) return escapeMarkupText(value);
    const ranges = [];
    mentionList.forEach((mention) => {
      const labels = [mention.name, mention.email, mention.label, mention.id]
        .map(cleanText)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      labels.some((label) => {
        const re = new RegExp(`@${escapeRegex(label)}(?=$|\\s|[.,;:!?\\)\\]])`, 'i');
        const match = re.exec(value);
        if (!match) return false;
        const start = match.index;
        const end = start + match[0].length;
        if (ranges.some((range) => start < range.end && end > range.start)) return false;
        ranges.push({ start, end, mention, label: match[0] });
        return true;
      });
    });
    if (!ranges.length) return escapeMarkupText(value);
    ranges.sort((a, b) => a.start - b.start);
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeMarkupText(value.slice(cursor, range.start));
      html += mentionChipHtml(range.mention, range.label);
      cursor = range.end;
    });
    html += escapeMarkupText(value.slice(cursor));
    return html;
  }
  function markupRecentColors(){
    try {
      const parsed = JSON.parse(root.localStorage?.getItem(MARKUP_RECENT_COLORS_KEY) || '[]');
      return (Array.isArray(parsed) ? parsed : [])
        .map(normalizeColor)
        .filter((color) => color && !MARKUP_DEFAULT_COLORS.includes(color))
        .slice(0, 6);
    } catch (_) {
      return [];
    }
  }
  function rememberMarkupColor(color){
    const normalized = normalizeColor(color);
    if (!normalized || MARKUP_DEFAULT_COLORS.includes(normalized)) return;
    const next = [normalized, ...markupRecentColors().filter((item) => item !== normalized)].slice(0, 6);
    try { root.localStorage?.setItem(MARKUP_RECENT_COLORS_KEY, JSON.stringify(next)); } catch (_) {}
  }
  function markupColorButton(color, extraAttrs = ''){
    const normalized = normalizeColor(color);
    return normalized ? `<button type="button" class="r-proposal-markup-color" data-markup-color="${normalized}" ${extraAttrs} style="background:${normalized}"></button>` : '';
  }
  function markupColorPaletteHtml(currentColor = '#111111'){
    const recent = markupRecentColors();
    const recentRow = recent.length
      ? `<div class="r-proposal-markup-recent">${recent.map((color) => markupColorButton(color, 'data-markup-recent-color')).join('')}</div>`
      : '<div class="r-proposal-markup-recent empty"></div>';
    return `
      ${recentRow}
      <div class="r-proposal-markup-colorbox">
        ${MARKUP_DEFAULT_COLORS.map((color) => markupColorButton(color)).join('')}
        <label class="r-proposal-markup-color custom"><input type="color" value="${escapeHtml(normalizeColor(currentColor) || '#111111')}"></label>
      </div>
    `;
  }
  function uid(prefix = 'mk'){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
  function orgId(){ return cleanText(root.__APP?.userOrgId || root.__APP?.orgId || root.Portal?.cfg?.userOrgId || root.Portal?.cfg?.orgId); }
  function userName(){ return cleanText(root.__APP?.userName || root.Portal?.cfg?.userName || root.__APP?.userEmail || 'You'); }
  function userEmail(){ return cleanText(root.__APP?.userEmail || root.Portal?.cfg?.userEmail); }
  function formatDateTime(value){
    const date = value instanceof Date ? value : new Date(value || '');
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function photoId(photo = {}){ return cleanText(photo.media_id || photo.id || photo.photo_id || photo.src); }
  function mediaKind(item = {}){
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const explicit = cleanText(item.media_type || item.mediaType || item.type || meta.media_type || meta.mediaType || meta.type).toLowerCase();
    if (explicit.startsWith('video')) return 'video';
    if (explicit.startsWith('image')) return 'image';
    const mime = cleanText(item.mime_type || item.mimeType || item.content_type || item.contentType || meta.mime_type || meta.mimeType || meta.content_type || meta.contentType).toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    const url = cleanText(item.src || item.url || item.thumb || item.label || item.name).toLowerCase();
    return /\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/.test(url) ? 'video' : 'image';
  }
  function isVideoMedia(item = {}){ return mediaKind(item) === 'video'; }
  function photoUrl(photo = {}, variant = 'original'){
    const oid = orgId();
    if (photo.media_id && root.PlatformAPI?.media?.fileUrl) return root.PlatformAPI.media.fileUrl(oid, photo.media_id, variant);
    return cleanText(variant === 'thumb_320' ? (photo.thumb || photo.src) : (photo.src || photo.thumb));
  }
  function safeFileName(value = 'photo', ext = 'jpg'){
    const base = cleanText(value).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || 'photo';
    const cleanExt = cleanText(ext).replace(/^\./, '') || 'jpg';
    return `${base}.${cleanExt}`;
  }
  function photoFileName(photo = {}, project = {}, suffix = ''){
    const source = cleanText(photo.label || photo.name || project.title || project.address || photoId(photo) || 'photo');
    const url = photoUrl(photo, 'original');
    const match = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    const ext = match?.[1] || 'jpg';
    return safeFileName(`${source}${suffix ? `-${suffix}` : ''}`, suffix ? 'png' : ext);
  }
  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  async function photoBlob(photo = {}){
    const response = await fetch(photoUrl(photo, 'original'), { credentials: 'include' });
    if (!response.ok) throw new Error(`Could not download image (${response.status})`);
    return response.blob();
  }
  function blobToImage(blob){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not render image for download.'));
      };
      img.src = url;
    });
  }
  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight){
    String(text || '').replace(/\r/g, '').split('\n').forEach((line, lineIndex) => {
      const words = line.split(/\s+/);
      let current = '';
      words.forEach((word) => {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
          ctx.fillText(current, x, y);
          y += lineHeight;
          current = word;
        } else {
          current = test;
        }
      });
      ctx.fillText(current || ' ', x, y);
      if (lineIndex < text.split('\n').length - 1) y += lineHeight;
    });
  }
  async function renderPhotoWithMarkupBlob(photo = {}, items = null){
    const blob = await photoBlob(photo);
    const img = await blobToImage(blob);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const strokeScale = Math.max(1, Math.sqrt(canvas.width * canvas.height) / 100);
    const markupItems = Array.isArray(items) ? items : (photo.media_id ? await loadMarkup(orgId(), photo.media_id) : []);
    markupItems.forEach((item) => {
      if (!item) return;
      ctx.save();
      ctx.strokeStyle = item.color || '#111';
      ctx.fillStyle = item.color || '#111';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (item.type === 'stroke') {
        const points = Array.isArray(item.points) ? item.points : [];
        if (!points.length) return;
        ctx.lineWidth = Math.max(1, Number(item.size || 2.2) * strokeScale);
        ctx.beginPath();
        points.forEach((point, index) => {
          const x = Number(point.x || 0) * canvas.width;
          const y = Number(point.y || 0) * canvas.height;
          if (index) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      } else if (item.type === 'arrow') {
        ctx.lineWidth = Math.max(1, Number(item.size || 2.8) * strokeScale);
        Object.values(arrowParts(item)).forEach((part) => {
          ctx.beginPath();
          ctx.moveTo(part.x1 * canvas.width, part.y1 * canvas.height);
          ctx.lineTo(part.x2 * canvas.width, part.y2 * canvas.height);
          ctx.stroke();
        });
      } else if (item.type === 'text') {
        const x = Number(item.x || 0) * canvas.width;
        const y = Number(item.y || 0) * canvas.height;
        const width = Number(item.width || 0.24) * canvas.width;
        const height = Number(item.height || 0.07) * canvas.height;
        const lines = String(item.text || '').split('\n').length || 1;
        const fontSize = Math.max(8, (height - 8) / Math.max(1, lines * 1.14));
        ctx.fillStyle = 'rgba(255,255,255,.72)';
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = item.color || '#111';
        ctx.font = `700 ${fontSize}px Arial, sans-serif`;
        ctx.textBaseline = 'top';
        drawWrappedText(ctx, item.text || '', x + 5, y + 4, Math.max(20, width - 10), fontSize * 1.14);
      }
      ctx.restore();
    });
    return new Promise((resolve) => canvas.toBlob((result) => resolve(result || blob), 'image/png', 0.94));
  }
  async function downloadPhoto(photo = {}, options = {}){
    const project = photo.__project || options.project || {};
    const withMarkup = !!options.withMarkup;
    const useMarkup = withMarkup && !isVideoMedia(photo);
    const blob = useMarkup ? await renderPhotoWithMarkupBlob(photo, options.items) : await photoBlob(photo);
    downloadBlob(blob, photoFileName(photo, project, useMarkup ? 'markup' : ''));
  }
  function loadScriptOnce(id, src){
    if (root[id]) return Promise.resolve(root[id]);
    const existing = document.querySelector(`script[data-loader-id="${id}"]`);
    if (existing) return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(root[id]));
      existing.addEventListener('error', reject);
    });
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.loaderId = id;
      script.onload = () => resolve(root[id]);
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  async function downloadPhotoZip(photos = [], options = {}){
    const JSZip = await loadScriptOnce('JSZip', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!JSZip) throw new Error('Could not load zip tools.');
    const zip = new JSZip();
    const withMarkup = !!options.withMarkup;
    for (const photo of photos) {
      const project = photo.__project || {};
      const useMarkup = withMarkup && !isVideoMedia(photo);
      const blob = useMarkup ? await renderPhotoWithMarkupBlob(photo) : await photoBlob(photo);
      zip.file(photoFileName(photo, project, useMarkup ? 'markup' : ''), blob);
    }
    const out = await zip.generateAsync({ type: 'blob' });
    downloadBlob(out, safeFileName(`media${withMarkup ? '-with-markup' : ''}-${new Date().toISOString().slice(0, 10)}`, 'zip'));
  }
  function uploader(photo = {}){
    const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
    return {
      id: cleanText(photo.uploaded_by_user_id || meta.uploaded_by_user_id || meta.actor_user_id || meta.user_id || meta.identity_id || ''),
      name: cleanText(photo.uploaded_by_name || meta.uploaded_by_name || meta.actor_name || meta.user_name || meta.name || meta.uploaded_by_email || photo.uploaded_by || ''),
      email: cleanText(photo.uploaded_by_email || meta.uploaded_by_email || meta.actor_email || meta.user_email || ''),
      avatar: cleanText(photo.uploaded_by_avatar || meta.uploaded_by_avatar || meta.avatar || meta.avatar_url || meta.photo_url || meta.profile_photo_url || meta.image_url || ''),
      at: cleanText(photo.uploaded_at || photo.created_at || meta.uploaded_at || meta.created_at || photo.updated_at)
    };
  }
  function normalizeItems(data = {}){
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (data.data && Array.isArray(data.data.items)) return data.data.items;
    return [];
  }
  async function loadMarkup(selectedOrgId, mediaId){
    if (!selectedOrgId || !mediaId || !root.PlatformAPI?.media?.getMarkup) return [];
    const result = await root.PlatformAPI.media.getMarkup(selectedOrgId, mediaId, PHOTO_MARKUP_LAYER).catch(() => null);
    return normalizeItems(result?.layer?.data || result?.data || {});
  }
  async function saveMarkup(selectedOrgId, mediaId, items){
    if (!selectedOrgId || !mediaId || !root.PlatformAPI?.media?.saveMarkup) return null;
    return root.PlatformAPI.media.saveMarkup(selectedOrgId, mediaId, PHOTO_MARKUP_LAYER, { schema: 1, items: items || [] }, {
      source: 'photo_markup',
      updated_by_name: userName(),
      updated_by_email: userEmail()
    }).catch((error) => {
      console.warn('Could not save photo markup', error);
      return null;
    });
  }
  async function loadComments(selectedOrgId, mediaId){
    if (!selectedOrgId || !mediaId || !root.PlatformAPI?.media?.getMarkup) return [];
    const result = await root.PlatformAPI.media.getMarkup(selectedOrgId, mediaId, PHOTO_COMMENTS_LAYER).catch(() => null);
    const data = result?.layer?.data || result?.data || {};
    return Array.isArray(data.comments) ? data.comments : [];
  }
  async function saveComments(selectedOrgId, mediaId, comments){
    if (!selectedOrgId || !mediaId || !root.PlatformAPI?.media?.saveMarkup) return null;
    return root.PlatformAPI.media.saveMarkup(selectedOrgId, mediaId, PHOTO_COMMENTS_LAYER, { schema: 1, comments: comments || [] }, {
      source: 'photo_comments',
      updated_by_name: userName(),
      updated_by_email: userEmail()
    });
  }

  function injectStyles(){
    root.Portal?.util?.injectCSS?.('firstmate_photo_markup', `
      .fm-photo-modal{position:fixed;z-index:2147483140;background:rgba(12,18,28,.86);display:flex;align-items:stretch;justify-content:center;color:#fff}
      .fm-photo-modal-shell{width:100%;height:100%;display:grid;grid-template-columns:minmax(0,1fr) 360px;background:#0b111b}
      .fm-photo-stage{position:relative;min-width:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#070b12}
      .fm-photo-stage img,.fm-photo-stage video{max-width:100%;max-height:100%;object-fit:contain;display:block}
      .fm-photo-stage [hidden]{display:none!important}
      .fm-photo-top{position:absolute;top:18px;left:18px;right:18px;z-index:20;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;pointer-events:none}
      .fm-photo-title{min-width:0;text-shadow:0 2px 16px rgba(0,0,0,.5)}
      .fm-photo-title strong{display:block;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58vw}
      .fm-photo-title span{display:block;font-size:12px;color:rgba(255,255,255,.76);margin-top:3px}
      .fm-photo-actions{display:flex;align-items:flex-start;gap:8px;pointer-events:auto}
      .fm-photo-actions-wrap{position:relative}
      .fm-photo-iconbtn{pointer-events:auto;width:38px;height:38px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(15,23,42,.62);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(12px)}
      .fm-photo-iconbtn:hover{background:rgba(255,255,255,.16)}
      .fm-photo-actions-menu{position:absolute;right:0;top:46px;width:220px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(15,23,42,.92);box-shadow:0 18px 44px rgba(0,0,0,.32);backdrop-filter:blur(16px);padding:6px;display:none}
      .fm-photo-actions-menu.visible{display:block}
      .fm-photo-actions-menu button{width:100%;border:0;border-radius:10px;background:transparent;color:#fff;padding:10px 11px;text-align:left;font-size:12px;font-weight:900;cursor:pointer;display:flex;align-items:center;gap:9px}
      .fm-photo-actions-menu button:hover{background:rgba(255,255,255,.12)}
      .fm-photo-actions-menu button.danger{color:#fecaca}
      .fm-photo-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:18;width:44px;height:58px;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:rgba(15,23,42,.54);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(12px)}
      .fm-photo-nav.prev{left:18px}.fm-photo-nav.next{right:18px}
      .fm-photo-side{background:#fff;color:#101828;border-left:1px solid rgba(15,23,42,.08);display:flex;flex-direction:column;min-height:0}
      .fm-photo-meta{padding:18px;border-bottom:1px solid #eaecf0}
      .fm-photo-meta h3{margin:0;font-size:16px;line-height:1.25;color:#101828}
      .fm-photo-project-link{margin:0;border:0;background:transparent;padding:0;text-align:left;font:inherit;font-size:16px;line-height:1.25;font-weight:900;color:#101828;cursor:pointer}
      .fm-photo-project-link:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}
      .fm-photo-project-link.is-static{cursor:default}
      .fm-photo-project-link.is-static:hover{color:#101828;text-decoration:none}
      .fm-photo-meta-row{margin-top:10px;display:flex;align-items:center;gap:8px;color:#475467;font-size:12px;line-height:1.35}
      .fm-photo-user-row{width:100%;margin-top:10px;border:0;background:transparent;padding:0;display:flex;align-items:center;gap:8px;color:#475467;font:inherit;font-size:12px;line-height:1.35;text-align:left;cursor:pointer}
      .fm-photo-user-row:hover strong{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}
      .fm-photo-avatar{width:30px;height:30px;border-radius:999px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex:0 0 auto}
      .fm-photo-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
      .fm-photo-tag{border-radius:999px;background:#f2f4f7;color:#344054;padding:4px 8px;font-size:11px;font-weight:800}
      .fm-photo-comments{padding:14px 18px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:12px}
      .fm-photo-comment{display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px}
      .fm-photo-comment-body{background:#f8fafc;border:1px solid #eaecf0;border-radius:12px;padding:9px 10px;color:#101828}
      .fm-photo-comment-head{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#667085;margin-bottom:4px}
      .fm-photo-comment-head strong{color:#344054;font-size:12px}
      .fm-photo-comment-text{font-size:13px;line-height:1.42;white-space:pre-wrap}
      .fm-photo-mention{position:relative;display:inline-flex;align-items:center;vertical-align:baseline;margin:0 1px;padding:1px 5px;border:1px solid rgba(var(--primary-rgb,217,48,37),.2);border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));font-weight:650;line-height:1.25;white-space:nowrap;cursor:pointer}
      .fm-photo-mention::before{content:'@';font-weight:700;opacity:.8}
      .fm-photo-mention-card{position:fixed;left:0;top:0;z-index:2147483400;width:max-content;min-width:220px;max-width:280px;padding:10px;border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#fff;color:#101828;box-shadow:0 18px 38px rgba(15,23,42,.18);display:none;grid-template-columns:34px minmax(0,1fr);gap:9px;white-space:normal;pointer-events:none}
      .fm-photo-mention-card.visible{display:grid}
      .fm-photo-mention-avatar{width:34px;height:34px;border-radius:999px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:13px;font-weight:1000;flex:0 0 auto}
      .fm-photo-mention-avatar img{width:100%;height:100%;object-fit:cover;display:block}
      .fm-photo-mention-name{display:block;font-size:13px;font-weight:1000;line-height:1.15;color:#101828;overflow:hidden;text-overflow:ellipsis}
      .fm-photo-mention-email{display:block;margin-top:3px;font-size:11px;font-weight:700;line-height:1.2;color:#667085;overflow:hidden;text-overflow:ellipsis}
      .fm-photo-comment-empty{border:1px dashed #d0d5dd;border-radius:12px;padding:18px;text-align:center;color:#667085;font-size:13px}
      .fm-photo-composer{border-top:1px solid #eaecf0;padding:14px 18px;background:#fff}
      .fm-photo-composer textarea{width:100%;min-height:72px;resize:vertical;border:1px solid #d0d5dd;border-radius:12px;padding:10px 11px;font:inherit;font-size:13px;line-height:1.42;outline:none}
      .fm-photo-composer textarea:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
      .fm-photo-composer-actions{display:flex;justify-content:flex-end;margin-top:10px}
      .fm-photo-composer-actions button{border:0;border-radius:10px;background:var(--primary,#d93025);color:#fff;font-weight:900;padding:9px 13px;cursor:pointer}
      .fm-photo-markup-layer{position:absolute;inset:0;z-index:10;pointer-events:none}
      .fm-photo-modal.markup-active .fm-photo-markup-layer{pointer-events:auto}
      .fm-photo-modal.video-active .fm-photo-markup-layer{pointer-events:none}
      .fm-photo-markup-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
      .fm-photo-markup-text{position:absolute;min-width:40px;min-height:20px;box-sizing:border-box;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.72);color:#111;font-size:13px;line-height:1.2;white-space:pre-wrap;overflow:hidden;box-shadow:0 4px 14px rgba(15,23,42,.08)}
      .fm-photo-markup-text[contenteditable="true"]{outline:0;cursor:text;overflow-wrap:anywhere;word-break:normal}
      .fm-photo-markup-text[contenteditable="true"]:focus{box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.18),0 4px 14px rgba(15,23,42,.08)}
      .fm-photo-markup-handle{position:absolute;width:21px;height:21px;border-radius:999px;background:#fff;border:2px solid var(--primary,#d93025);box-shadow:0 6px 12px rgba(15,23,42,.14);transform:translate(-50%,-50%);display:none;cursor:grab;z-index:12;opacity:.5;transition:opacity .14s ease,transform .14s ease}
      .fm-photo-markup-text-size{position:absolute;width:21px;height:21px;border-radius:5px;background:#fff;border:2px solid var(--primary,#d93025);box-shadow:0 6px 12px rgba(15,23,42,.14);display:none;cursor:nwse-resize;z-index:12;opacity:.5;transition:opacity .14s ease,transform .14s ease}
      .fm-photo-markup-handle:hover,.fm-photo-markup-handle:focus-visible,.fm-photo-markup-text-size:hover,.fm-photo-markup-text-size:focus-visible{opacity:1}
      .fm-photo-modal.markup-active .fm-photo-markup-handle,.fm-photo-modal.markup-active .fm-photo-markup-text-size{display:block}
      .fm-photo-markup-path{fill:none;stroke:#111;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
      .fm-photo-markup-arrow{fill:none;stroke-linecap:round}
      .fm-photo-modal .r-proposal-markupdock{display:block;top:72px;right:18px}
      .fm-photo-modal.video-active .r-proposal-markupdock,.fm-photo-modal.video-active [data-photo-download-markup]{display:none}
      .fm-photo-modal .r-proposal-markupdock{position:absolute;z-index:61;width:42px}
      .fm-photo-modal .r-proposal-markupdock.dock-bottom-right{top:auto;right:18px;bottom:18px}
      .fm-photo-modal .r-proposal-markupdock.expanded{width:42px}
      .fm-photo-modal .r-proposal-markup-btn{position:relative;width:42px;height:42px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.92);backdrop-filter:blur(14px);color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 34px rgba(15,23,42,.12);transition:.18s ease}
      .fm-photo-modal .r-proposal-markup-btn:hover{transform:translateY(-1px);background:#fff;color:#101828}
      .fm-photo-modal .r-proposal-markup-btn.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .fm-photo-modal .r-proposal-markup-tools{position:absolute;top:52px;right:0;display:flex;flex-direction:column;gap:10px;pointer-events:none}
      .fm-photo-modal .r-proposal-markupdock.expand-left .r-proposal-markup-tools{top:0;right:52px;flex-direction:row-reverse}
      .fm-photo-modal .r-proposal-markupdock.expand-up .r-proposal-markup-tools{top:auto;bottom:52px}
      .fm-photo-modal .r-proposal-markupdock.expanded .r-proposal-markup-tools{pointer-events:auto}
      .fm-photo-modal .r-proposal-markup-tool{width:42px;height:42px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.94);backdrop-filter:blur(14px);color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 34px rgba(15,23,42,.12);opacity:0;transform:translateY(-14px) scale(.88);transition:opacity .2s ease,transform .26s cubic-bezier(.22,1,.36,1),background .18s ease,color .18s ease,border-color .18s ease}
      .fm-photo-modal .r-proposal-markupdock.expanded .r-proposal-markup-tool{opacity:1;transform:translateY(0) scale(1)}
      .fm-photo-modal .r-proposal-markup-tool:hover{transform:translateY(0) scale(1.04);background:#fff;color:#101828}
      .fm-photo-modal .r-proposal-markup-tool:disabled{cursor:not-allowed;transform:translateY(-14px) scale(.88);background:rgba(255,255,255,.74);color:#98a2b3}
      .fm-photo-modal .r-proposal-markupdock.expanded .r-proposal-markup-tool:disabled{opacity:.36;transform:translateY(0) scale(.96)}
      .fm-photo-modal .r-proposal-markup-tool.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .fm-photo-modal .r-proposal-markup-tool.swatch{position:relative;overflow:hidden}
      .fm-photo-modal .r-proposal-markup-tool-swatch{position:absolute;inset:10px;border-radius:10px;border:1px solid rgba(255,255,255,.35)}
      .fm-photo-modal .r-proposal-markup-tool-size{font-size:11px;font-weight:1000;letter-spacing:.02em}
      .fm-photo-modal .r-proposal-markup-pop{position:absolute;right:52px;top:0;padding:12px;border-radius:16px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);backdrop-filter:blur(14px);box-shadow:0 18px 34px rgba(15,23,42,.12);opacity:0;transform:translateX(8px) scale(.96);pointer-events:none;transition:opacity .18s ease,transform .22s cubic-bezier(.22,1,.36,1)}
      .fm-photo-modal .r-proposal-markupdock.expand-left .r-proposal-markup-pop{right:0;top:auto;bottom:52px;transform:translateY(8px) scale(.96)}
      .fm-photo-modal .r-proposal-markup-pop.visible{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
      .fm-photo-modal .r-proposal-markupdock.expand-left .r-proposal-markup-pop.visible{transform:translateY(0) scale(1)}
      .fm-photo-modal .r-proposal-markup-slider{width:140px}
      .fm-photo-modal .r-proposal-markup-slider input{width:100%}
      .fm-photo-modal .r-proposal-markup-colorbox,.fm-photo-modal .r-proposal-markup-recent{display:grid;grid-template-columns:repeat(6,28px);gap:8px}
      .fm-photo-modal .r-proposal-markup-recent{margin-bottom:8px;min-height:28px}
      .fm-photo-modal .r-proposal-markup-recent.empty{display:none}
      .fm-photo-modal .r-proposal-markup-color{width:28px;height:28px;border-radius:10px;border:1px solid rgba(15,23,42,.08);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45)}
      .fm-photo-modal .r-proposal-markup-color.custom{position:relative;background:conic-gradient(#ff6b6b,#ffd166,#06d6a0,#118ab2,#9b5de5,#ff6b6b)}
      .fm-photo-modal .r-proposal-markup-color input{position:absolute;inset:0;opacity:0;cursor:pointer}
      @media(max-width:900px){.fm-photo-modal-shell{grid-template-columns:1fr}.fm-photo-side{position:absolute;right:0;top:0;bottom:0;width:min(360px,92vw);box-shadow:-20px 0 44px rgba(0,0,0,.28)}}
    `);
  }
  function svgPath(points = []){
    return points.map((point, index) => `${index ? 'L' : 'M'}${(point.x * 100).toFixed(3)} ${(point.y * 100).toFixed(3)}`).join(' ');
  }
  function arrowParts(item){
    const x1 = Number(item.x1 || 0), y1 = Number(item.y1 || 0), x2 = Number(item.x2 || 0), y2 = Number(item.y2 || 0);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = 0.035;
    const a = Math.PI / 7;
    return {
      shaft: { x1, y1, x2, y2 },
      left: { x1: x2, y1: y2, x2: x2 - Math.cos(angle - a) * len, y2: y2 - Math.sin(angle - a) * len },
      right: { x1: x2, y1: y2, x2: x2 - Math.cos(angle + a) * len, y2: y2 - Math.sin(angle + a) * len }
    };
  }
  function distanceToSegment(point, a, b){
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!dx && !dy) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }
  function ccw(a, b, c){
    return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  }
  function segmentsIntersect(a, b, c, d){
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }
  function distanceBetweenSegments(a, b, c, d){
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
  }
  function expandedRectSegments(item = {}, padding = 0){
    const left = Number(item.x || 0) - padding;
    const top = Number(item.y || 0) - padding;
    const right = Number(item.x || 0) + Number(item.width || 0.24) + padding;
    const bottom = Number(item.y || 0) + Number(item.height || 0.07) + padding;
    const tl = { x: left, y: top }, tr = { x: right, y: top }, br = { x: right, y: bottom }, bl = { x: left, y: bottom };
    return { left, top, right, bottom, edges: [[tl, tr], [tr, br], [br, bl], [bl, tl]] };
  }
  function pointInRect(point, rect){
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }
  function markupStrokeRadius(item = {}){
    return Math.max(0.004, Number(item.size || 2.2) / 200);
  }
  function itemIntersectsPoint(item, point, tolerance = ERASER_RADIUS){
    if (!item || !point) return false;
    if (item.type === 'stroke') {
      const points = Array.isArray(item.points) ? item.points : [];
      const hitRadius = tolerance + markupStrokeRadius(item);
      if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= hitRadius;
      for (let i = 1; i < points.length; i += 1) {
        if (distanceToSegment(point, points[i - 1], points[i]) <= hitRadius) return true;
      }
      return false;
    }
    if (item.type === 'arrow') {
      const hitRadius = tolerance + markupStrokeRadius({ size: item.size || 2.8 });
      return Object.values(arrowParts(item)).some((part) => (
        distanceToSegment(point, { x: Number(part.x1 || 0), y: Number(part.y1 || 0) }, { x: Number(part.x2 || 0), y: Number(part.y2 || 0) }) <= hitRadius
      ));
    }
    if (item.type === 'text') {
      return pointInRect(point, expandedRectSegments(item, tolerance));
    }
    return false;
  }
  function itemIntersectsEraserSegment(item, a, b, tolerance = ERASER_RADIUS){
    if (!item || !a || !b) return false;
    if (Math.hypot(Number(a.x || 0) - Number(b.x || 0), Number(a.y || 0) - Number(b.y || 0)) < 0.0001) return itemIntersectsPoint(item, a, tolerance);
    if (item.type === 'stroke') {
      const points = Array.isArray(item.points) ? item.points : [];
      const hitRadius = tolerance + markupStrokeRadius(item);
      if (points.length === 1) return distanceToSegment(points[0], a, b) <= hitRadius;
      for (let i = 1; i < points.length; i += 1) {
        if (distanceBetweenSegments(a, b, points[i - 1], points[i]) <= hitRadius) return true;
      }
      return false;
    }
    if (item.type === 'arrow') {
      const hitRadius = tolerance + markupStrokeRadius({ size: item.size || 2.8 });
      return Object.values(arrowParts(item)).some((part) => (
        distanceBetweenSegments(a, b, { x: Number(part.x1 || 0), y: Number(part.y1 || 0) }, { x: Number(part.x2 || 0), y: Number(part.y2 || 0) }) <= hitRadius
      ));
    }
    if (item.type === 'text') {
      const rect = expandedRectSegments(item, tolerance);
      return pointInRect(a, rect) || pointInRect(b, rect) || rect.edges.some(([c, d]) => segmentsIntersect(a, b, c, d));
    }
    return false;
  }

  class PhotoMarkup {
    constructor(rootEl, options = {}){
      this.root = rootEl;
      this.options = options;
      this.items = Array.isArray(options.items) ? options.items.map((item) => ({ ...item })) : [];
      this.tool = 'pen';
      this.color = '#d93025';
      this.size = Number(options.size || 1.5) || 1.5;
      this.active = false;
      this.drawing = null;
      this.dragging = null;
      this.erasing = false;
      this.eraserPoints = [];
      this.savedTextRange = null;
      this.history = [];
      this.historyIndex = -1;
      this.render();
      this.pushHistory();
    }
    cloneItems(){ return JSON.parse(JSON.stringify(this.items || [])); }
    pushHistory(){
      const snapshot = this.cloneItems();
      const current = JSON.stringify(this.history[this.historyIndex] || null);
      const next = JSON.stringify(snapshot);
      if (current === next) return;
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(snapshot);
      if (this.history.length > 80) this.history.shift();
      this.historyIndex = this.history.length - 1;
      this.updateHistoryButtons();
    }
    restoreHistory(index){
      if (index < 0 || index >= this.history.length) return false;
      this.historyIndex = index;
      this.items = JSON.parse(JSON.stringify(this.history[this.historyIndex] || []));
      this.renderLayer();
      this.emitChange();
      this.updateHistoryButtons();
      return true;
    }
    undo(){ return this.restoreHistory(this.historyIndex - 1); }
    redo(){ return this.restoreHistory(this.historyIndex + 1); }
    setItems(items = []){
      this.items = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
      this.history = [];
      this.historyIndex = -1;
      this.renderLayer();
      this.pushHistory();
    }
    setActive(active){
      this.active = !!active;
      this.root.closest('.fm-photo-modal')?.classList.toggle('markup-active', this.active);
      this.dock?.classList.toggle('expanded', this.active);
      this.toggleBtn?.classList.toggle('active', this.active);
      if (!this.active) this.closePops();
    }
    point(event){
      const rect = this.layer.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
      };
    }
    constrainItem(item = {}){
      if (item.type === 'stroke') {
        item.points = (Array.isArray(item.points) ? item.points : []).map((point) => ({
          x: clamp(Number(point.x || 0), 0, 1),
          y: clamp(Number(point.y || 0), 0, 1)
        }));
      } else if (item.type === 'arrow') {
        item.x1 = clamp(Number(item.x1 || 0), 0, 1);
        item.y1 = clamp(Number(item.y1 || 0), 0, 1);
        item.x2 = clamp(Number(item.x2 || 0), 0, 1);
        item.y2 = clamp(Number(item.y2 || 0), 0, 1);
      } else if (item.type === 'text') {
        const { minWidth, minHeight } = this.textBoxBounds({ x: 0, y: 0 });
        const width = clamp(Number(item.width || minWidth), minWidth, 0.995);
        const height = clamp(Number(item.height || minHeight), minHeight, 0.995);
        item.width = width;
        item.height = height;
        item.x = clamp(Number(item.x || 0), 0, Math.max(0, 0.995 - width));
        item.y = clamp(Number(item.y || 0), 0, Math.max(0, 0.995 - height));
        if (item.naturalWidth != null) item.naturalWidth = clamp(Number(item.naturalWidth || width), minWidth, 0.995);
        if (item.naturalHeight != null) item.naturalHeight = clamp(Number(item.naturalHeight || height), minHeight, 0.995);
      }
      return item;
    }
    textFontPx(size = this.size, heightRatio = null, lineCount = 1){
      if (heightRatio != null) {
        const height = Math.max(1, this.layer?.getBoundingClientRect?.().height || 600);
        const estimatedPadding = 8;
        return Math.max(8, ((Number(heightRatio || 0) * height) - estimatedPadding) / Math.max(1, Number(lineCount || 1) * 1.2));
      }
      const width = Math.max(320, this.layer?.getBoundingClientRect?.().width || 900);
      return Math.max(10, width * (Number(size || 1.5) * TEXT_SIZE_WIDTH_SCALE));
    }
    textSizeFromHeight(heightRatio){
      const rect = this.layer?.getBoundingClientRect?.() || { width: 900, height: 600 };
      const fontPx = Math.max(8, (Number(heightRatio || 0.04) * Math.max(1, rect.height)) / 1.45);
      return Math.max(1.0, fontPx / (Math.max(320, rect.width || 900) * TEXT_SIZE_WIDTH_SCALE));
    }
    textPadding(fontSize = 12){
      const font = Math.max(1, Number(fontSize || 12));
      return {
        x: Math.max(4, font * 0.45),
        y: Math.max(3, font * 0.35),
        totalX: Math.max(8, font * 0.9),
        totalY: Math.max(6, font * 0.7)
      };
    }
    textLines(value = ''){
      const raw = String(value ?? '').replace(/\r/g, '').replace(/\u00a0/g, ' ');
      const lines = raw.split('\n');
      return lines.length ? lines : [''];
    }
    textMeasureContext(fontSize = 12){
      if (!this.textMeasureCanvas) this.textMeasureCanvas = document.createElement('canvas');
      const ctx = this.textMeasureCanvas.getContext('2d');
      ctx.font = `700 ${Math.max(1, Number(fontSize || 12))}px Arial, sans-serif`;
      return ctx;
    }
    textVisualMetrics(item = {}, options = {}){
      const lines = this.textLines(item.text);
      const fontSize = Math.max(1, Number(options.fontSize || 12));
      const maxContentWidth = Number(options.maxContentWidth || 0);
      const ctx = this.textMeasureContext(fontSize);
      let longest = 1;
      let lineCount = 0;
      lines.forEach((line) => {
        const text = line || ' ';
        const measured = Math.max(1, ctx.measureText(text).width);
        if (maxContentWidth > 0 && measured > maxContentWidth) {
          const words = text.split(/(\s+)/);
          let current = '';
          words.forEach((part) => {
            const test = current + part;
            if (current && ctx.measureText(test).width > maxContentWidth) {
              longest = Math.max(longest, Math.min(ctx.measureText(current).width, maxContentWidth));
              lineCount += 1;
              current = part.trimStart();
            } else {
              current = test;
            }
          });
          if (current || !words.length) {
            longest = Math.max(longest, Math.min(ctx.measureText(current || ' ').width, maxContentWidth));
            lineCount += 1;
          }
        } else {
          lineCount += 1;
          longest = Math.max(longest, measured);
        }
      });
      lineCount = Math.max(1, lineCount);
      return {
        lines,
        widthPx: longest,
        longest,
        lineCount,
        aspect: 2
      };
    }
    textMetrics(item = {}, options = {}){
      if (options.fontSize || options.maxContentWidth) return this.textVisualMetrics(item, options);
      const lines = this.textLines(item.text);
      const longest = Math.max(1, ...lines.map((line) => line.length || 1));
      const lineCount = Math.max(1, lines.length);
      return { lines, longest, lineCount, aspect: Math.max(2, (longest * 0.62 + 1.8) / Math.max(1, lineCount * 1.12)) };
    }
    textAspect(item = {}){
      return this.textMetrics(item).aspect;
    }
    textBoxBounds(item = {}){
      const rect = this.layer?.getBoundingClientRect?.() || { width: 900, height: 600 };
      const minHeight = 20 / Math.max(1, rect.height || 600);
      const minWidth = Math.max(40 / Math.max(1, rect.width || 900), (minHeight * 2 * Math.max(1, rect.height || 600)) / Math.max(1, rect.width || 900));
      return {
        rect,
        minWidth,
        minHeight,
        maxWidth: Math.max(minWidth, 0.995 - Number(item.x || 0)),
        maxHeight: Math.max(minHeight, 0.995 - Number(item.y || 0))
      };
    }
    fitTextBoxToContent(item = {}, options = {}){
      const { rect, minWidth, minHeight, maxWidth, maxHeight } = this.textBoxBounds(item);
      const baseMetrics = this.textMetrics(item);
      const fontSize = Number(options.fontSize) || Number(item.fontPx) || this.textFontPx(item.size || 1.5, item.height ?? null, baseMetrics.lineCount);
      const padding = this.textPadding(fontSize);
      const padX = padding.totalX;
      const padY = padding.totalY;
      const rectWidth = Math.max(1, rect.width || 900);
      const rectHeight = Math.max(1, rect.height || 600);
      const unwrappedMetrics = this.textVisualMetrics(item, { fontSize });
      const unwrappedHeightPx = Math.max(20, unwrappedMetrics.lineCount * fontSize * 1.2 + padY);
      const desiredWidthPx = Math.max(40, unwrappedMetrics.widthPx + padX, unwrappedHeightPx * 2);
      const naturalWidth = clamp(desiredWidthPx / rectWidth, minWidth, Math.max(minWidth, 0.995));
      const naturalHeight = clamp(unwrappedHeightPx / rectHeight, minHeight, maxHeight);
      const width = clamp(Math.min(naturalWidth, maxWidth), minWidth, maxWidth);
      const isEdgeWrapped = width < naturalWidth - 0.0005;
      const fittedMetrics = isEdgeWrapped
        ? this.textVisualMetrics(item, { fontSize, maxContentWidth: Math.max(1, width * rectWidth - padX) })
        : unwrappedMetrics;
      const desiredHeightPx = Math.max(20, fittedMetrics.lineCount * fontSize * 1.2 + padY);
      const height = isEdgeWrapped
        ? clamp(desiredHeightPx / rectHeight, minHeight, maxHeight)
        : naturalHeight;
      item.width = width;
      item.height = height;
      item.naturalWidth = naturalWidth;
      item.naturalHeight = naturalHeight;
      item.fontPx = fontSize;
      delete item.edgeNaturalWidth;
      item.aspect = Math.max(0.1, (width * rectWidth) / Math.max(1, height * rectHeight));
      return { width, height };
    }
    textBoxRenderBox(item = {}){
      const { minWidth, minHeight, maxWidth, maxHeight } = this.textBoxBounds(item);
      return {
        width: item.width != null ? clamp(Number(item.width || minWidth), minWidth, maxWidth) : clamp(0.24, minWidth, maxWidth),
        height: item.height != null ? clamp(Number(item.height || minHeight), minHeight, maxHeight) : null
      };
    }
    applyTextBoxElement(item = {}, el = null){
      const target = el || this.layer?.querySelector?.(`.fm-photo-markup-text[data-markup-id="${item.id}"]`);
      const handle = this.layer?.querySelector?.(`.fm-photo-markup-text-size[data-markup-id="${item.id}"]`);
      if (!target) return;
      const metrics = this.textMetrics(item);
      const { width, height } = this.textBoxRenderBox(item);
      const fontSize = Number(item.fontPx) || this.textFontPx(item.size || 1.5, height, metrics.lineCount);
      const padding = this.textPadding(fontSize);
      target.style.width = `${(width * 100).toFixed(3)}%`;
      target.style.height = height != null ? `${(height * 100).toFixed(3)}%` : '';
      target.style.maxWidth = `${(Math.max(0.12, 0.98 - Number(item.x || 0)) * 100).toFixed(3)}%`;
      target.style.fontSize = `${fontSize.toFixed(1)}px`;
      target.style.padding = `${padding.y.toFixed(1)}px ${padding.x.toFixed(1)}px`;
      if (handle && height != null) {
        handle.style.left = `calc(${((Number(item.x || 0) + width) * 100).toFixed(3)}% - 10.5px)`;
        handle.style.top = `calc(${((Number(item.y || 0) + height) * 100).toFixed(3)}% - 10.5px)`;
      }
    }
    textBoxFromDiagonal(item = {}, point = {}) {
      const { rect, minWidth, minHeight, maxWidth, maxHeight } = this.textBoxBounds(item);
      const metrics = this.textMetrics(item);
      const fontSize = Number(item.fontPx) || this.textFontPx(item.size || 1.5, item.height ?? null, metrics.lineCount);
      const padding = this.textPadding(fontSize);
      const padX = padding.totalX;
      const padY = padding.totalY;
      const aspect = Math.max(0.1, Number(item.aspect || 0) || this.textAspect(item));
      const surfaceAspect = Math.max(0.1, (rect.height || 600) / Math.max(1, rect.width || 900));
      const rawWidth = Math.max(minWidth, Number(point.x || 0) - Number(item.x || 0));
      const rawHeight = Math.max(minHeight, Number(point.y || 0) - Number(item.y || 0));
      const widthFromCursor = clamp(rawWidth, minWidth, maxWidth);
      const heightFromCursor = clamp(rawHeight, minHeight, maxHeight);
      let width = widthFromCursor;
      let height = width * surfaceAspect / Math.max(0.1, aspect);
      if (height > heightFromCursor) {
        height = heightFromCursor;
        width = height * aspect / surfaceAspect;
      }
      if (width > maxWidth) {
        width = maxWidth;
        height = width * surfaceAspect / Math.max(0.1, aspect);
      }
      if (height > maxHeight) {
        height = maxHeight;
        width = height * aspect / surfaceAspect;
      }
      if (width < minWidth) {
        width = minWidth;
        height = width * surfaceAspect / Math.max(0.1, aspect);
      }
      if (height < minHeight) {
        height = minHeight;
        width = height * aspect / surfaceAspect;
      }
      height = clamp(height, minHeight, maxHeight);
      width = clamp(width, minWidth, maxWidth);
      if (width >= maxWidth - 0.0005) {
        const wrapMetrics = this.textVisualMetrics(item, { fontSize, maxContentWidth: Math.max(1, width * Math.max(1, rect.width || 900) - padX) });
        height = clamp((wrapMetrics.lineCount * fontSize * 1.2 + padY) / Math.max(1, rect.height || 600), minHeight, maxHeight);
      }
      return { width, height };
    }
    textBoxFromResizeDrag(item = {}, point = {}, drag = {}){
      const { rect, minWidth, minHeight, maxWidth, maxHeight } = this.textBoxBounds(item);
      const startWidth = Math.max(minWidth, Number(drag.startWidth || item.width || minWidth));
      const startHeight = Math.max(minHeight, Number(drag.startHeight || item.height || minHeight));
      const startFontPx = Math.max(4, Number(drag.startFontPx || item.fontPx || this.textFontPx(item.size || 1.5)));
      const pointerWidthPx = Math.max(1, (Number(point.x || 0) - Number(item.x || 0)) * Math.max(1, rect.width || 900));
      const pointerHeightPx = Math.max(1, (Number(point.y || 0) - Number(item.y || 0)) * Math.max(1, rect.height || 600));
      const scaleX = pointerWidthPx / Math.max(1, Number(drag.startPointerWidthPx || startWidth * Math.max(1, rect.width || 900)));
      const scaleY = pointerHeightPx / Math.max(1, Number(drag.startPointerHeightPx || startHeight * Math.max(1, rect.height || 600)));
      let scale = Math.max(0.15, Math.min(scaleX, scaleY));
      let width = clamp(startWidth * scale, minWidth, maxWidth);
      let height = clamp(startHeight * scale, minHeight, maxHeight);
      scale = Math.min(width / startWidth, height / startHeight);
      width = clamp(startWidth * scale, minWidth, maxWidth);
      height = clamp(startHeight * scale, minHeight, maxHeight);
      const fontPx = Math.max(4, startFontPx * scale);
      item.fontPx = fontPx;
      item.aspect = Math.max(0.1, (width * Math.max(1, rect.width || 900)) / Math.max(1, height * Math.max(1, rect.height || 600)));
      return { width, height };
    }
    fitTextBoxIntoAvailableWidth(item = {}, fontSize = null){
      const { rect, minWidth, minHeight, maxWidth, maxHeight } = this.textBoxBounds(item);
      const baseFont = Number(fontSize) || Number(item.fontPx) || this.textFontPx(item.size || 1.5, item.height ?? null, this.textMetrics(item).lineCount);
      const padding = this.textPadding(baseFont);
      const padX = padding.totalX;
      const padY = padding.totalY;
      const rectWidth = Math.max(1, rect.width || 900);
      const rectHeight = Math.max(1, rect.height || 600);
      const naturalWidth = clamp(Number(item.naturalWidth || item.edgeNaturalWidth || item.width || minWidth), minWidth, Math.max(minWidth, 0.995));
      const naturalHeight = clamp(Number(item.naturalHeight || item.height || minHeight), minHeight, maxHeight);
      const nextWidth = clamp(Math.min(naturalWidth, maxWidth), minWidth, maxWidth);
      const isEdgeWrapped = nextWidth < naturalWidth - 0.0005;
      const nextMetrics = isEdgeWrapped
        ? this.textVisualMetrics(item, { fontSize: baseFont, maxContentWidth: Math.max(1, nextWidth * rectWidth - padX) })
        : this.textVisualMetrics(item, { fontSize: baseFont });
      const nextHeight = isEdgeWrapped
        ? clamp((nextMetrics.lineCount * baseFont * 1.2 + padY) / rectHeight, minHeight, maxHeight)
        : naturalHeight;
      if (isEdgeWrapped) item.edgeNaturalWidth = naturalWidth;
      else delete item.edgeNaturalWidth;
      item.width = nextWidth;
      item.height = nextHeight;
      item.naturalWidth = naturalWidth;
      item.naturalHeight = naturalHeight;
      item.fontPx = baseFont;
      item.aspect = Math.max(0.1, (nextWidth * rectWidth) / Math.max(1, nextHeight * rectHeight));
      return { width: item.width, height: item.height };
    }
    closePops(except = null){
      this.dock?.querySelectorAll('.r-proposal-markup-pop.visible').forEach((pop) => {
        if (pop !== except) pop.classList.remove('visible');
      });
    }
    emitChange(){
      if (typeof this.options.onChange === 'function') this.options.onChange(this.items);
    }
    deleteItem(id){
      this.items = this.items.filter((item) => item.id !== id);
      this.renderLayer();
      this.pushHistory();
      this.emitChange();
    }
    updateHistoryButtons(){
      if (!this.dock) return;
      const canUndo = this.historyIndex > 0;
      const canRedo = this.historyIndex >= 0 && this.historyIndex < this.history.length - 1;
      this.dock.querySelector('[data-markup-undo]')?.toggleAttribute('disabled', !canUndo);
      this.dock.querySelector('[data-markup-redo]')?.toggleAttribute('disabled', !canRedo);
    }
    render(){
      this.layer = document.createElement('div');
      this.layer.className = 'fm-photo-markup-layer';
      this.layer.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none"></svg>';
      this.root.appendChild(this.layer);

      this.dock = document.createElement('div');
      const dock = this.options.dock || {};
      this.dock.className = `r-proposal-markupdock ${dock.position || 'dock-top-right'} ${dock.expand || 'expand-down'}`;
      this.dock.innerHTML = `
        <button type="button" class="r-proposal-markup-btn" data-markup-toggle data-fm-tooltip="Markup"><i class="fas fa-pen"></i></button>
        <div class="r-proposal-markup-tools">
          <button type="button" class="r-proposal-markup-tool active" data-markup-tool="pen" data-fm-tooltip="Pen"><i class="fas fa-pen"></i></button>
          <button type="button" class="r-proposal-markup-tool" data-markup-tool="arrow" data-fm-tooltip="Arrow"><i class="fas fa-arrow-right"></i></button>
          <button type="button" class="r-proposal-markup-tool" data-markup-tool="text" data-fm-tooltip="Text"><i class="fas fa-font"></i></button>
          <div style="position:relative"><button type="button" class="r-proposal-markup-tool" data-markup-size data-fm-tooltip="Size"><span class="r-proposal-markup-tool-size">${this.size.toFixed(1)}x</span></button><div class="r-proposal-markup-pop"><div class="r-proposal-markup-slider"><input type="range" min="1" max="8" step="0.1" value="${this.size}"></div></div></div>
          <div style="position:relative"><button type="button" class="r-proposal-markup-tool swatch" data-markup-color-toggle data-fm-tooltip="Color"><span class="r-proposal-markup-tool-swatch" style="background:${this.color}"></span></button><div class="r-proposal-markup-pop" data-markup-color-pop>${markupColorPaletteHtml(this.color)}</div></div>
          <button type="button" class="r-proposal-markup-tool" data-markup-tool="eraser" data-fm-tooltip="Eraser"><i class="fas fa-eraser"></i></button>
          <button type="button" class="r-proposal-markup-tool" data-markup-undo data-fm-tooltip="Undo"><i class="fas fa-undo"></i></button>
          <button type="button" class="r-proposal-markup-tool" data-markup-redo data-fm-tooltip="Redo"><i class="fas fa-redo"></i></button>
          <button type="button" class="r-proposal-markup-tool" data-markup-clear data-fm-tooltip="Clear"><i class="fas fa-trash"></i></button>
        </div>`;
      this.root.appendChild(this.dock);
      this.toggleBtn = this.dock.querySelector('[data-markup-toggle]');
      this.toggleBtn.addEventListener('click', () => this.setActive(!this.active));
      this.dock.querySelector('[data-markup-undo]')?.addEventListener('click', () => this.undo());
      this.dock.querySelector('[data-markup-redo]')?.addEventListener('click', () => this.redo());
      this.dock.querySelector('[data-markup-clear]')?.addEventListener('click', async () => {
        const confirmed = !this.items.length || await (root.PlatformUI?.confirm?.('Clear markup from this photo?', {
          title: 'Clear markup',
          okLabel: 'Clear',
          danger: true
        }) || root.confirm('Clear markup from this photo?'));
        if (confirmed) {
          this.items = [];
          this.renderLayer();
          this.pushHistory();
          this.emitChange();
        }
      });
      this.dock.querySelectorAll('[data-markup-tool]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.closePops();
          this.tool = btn.dataset.markupTool || 'pen';
          this.dock.querySelectorAll('[data-markup-tool]').forEach((item) => item.classList.toggle('active', item === btn));
          this.setActive(true);
        });
      });
      const sizePop = this.dock.querySelector('[data-markup-size]')?.nextElementSibling;
      this.dock.querySelector('[data-markup-size]')?.addEventListener('click', () => {
        const shouldShow = !sizePop?.classList.contains('visible');
        this.closePops(sizePop);
        sizePop?.classList.toggle('visible', shouldShow);
      });
      sizePop?.querySelector('input')?.addEventListener('input', (event) => {
        this.size = Number(event.target.value) || this.size;
        this.dock.querySelector('.r-proposal-markup-tool-size').textContent = `${this.size.toFixed(1)}x`;
      });
      const colorPop = this.dock.querySelector('[data-markup-color-toggle]')?.nextElementSibling;
      this.dock.querySelector('[data-markup-color-toggle]')?.addEventListener('click', () => {
        const shouldShow = !colorPop?.classList.contains('visible');
        this.closePops(colorPop);
        colorPop?.classList.toggle('visible', shouldShow);
      });
      this.bindColorPalette(colorPop);
      this.layer.addEventListener('pointerdown', (event) => this.onDown(event));
      this.layer.addEventListener('pointermove', (event) => this.onMove(event));
      this.keyHandler = (event) => {
        if (!this.active || !(event.ctrlKey || event.metaKey)) return;
        if (event.target?.closest?.('.fm-photo-markup-text')) return;
        const key = cleanText(event.key).toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) this.redo();
          else this.undo();
        } else if (key === 'y') {
          event.preventDefault();
          this.redo();
        }
      };
      window.addEventListener('keydown', this.keyHandler);
      window.addEventListener('pointerup', (event) => this.onUp(event));
      this.renderLayer();
      this.updateHistoryButtons();
    }
    setColor(color){
      this.color = normalizeColor(color) || this.color;
      rememberMarkupColor(this.color);
      this.applyColorToTextSelection(this.color);
      this.dock.querySelector('.r-proposal-markup-tool-swatch').style.background = this.color;
      const colorPop = this.dock.querySelector('[data-markup-color-pop]');
      if (colorPop) {
        colorPop.innerHTML = markupColorPaletteHtml(this.color);
        this.bindColorPalette(colorPop);
      }
    }
    bindColorPalette(colorPop){
      if (!colorPop) return;
      colorPop.addEventListener('mousedown', (event) => {
        this.saveTextSelection();
        if (!event.target.closest?.('input[type="color"]')) event.preventDefault();
      });
      colorPop.querySelectorAll('[data-markup-color]').forEach((btn) => {
        btn.addEventListener('click', () => this.setColor(btn.dataset.markupColor));
      });
      colorPop.querySelector('input[type="color"]')?.addEventListener('input', (event) => this.setColor(event.target.value));
    }
    activeTextElement(){
      const selection = root.getSelection?.();
      const node = selection?.anchorNode;
      const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return el?.closest?.('.fm-photo-markup-text') || document.activeElement?.closest?.('.fm-photo-markup-text') || null;
    }
    saveTextSelection(){
      const selection = root.getSelection?.();
      const el = this.activeTextElement();
      if (!selection || !el || selection.rangeCount < 1 || selection.isCollapsed) return;
      if (!el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return;
      this.savedTextRange = { id: el.dataset.markupId, range: selection.getRangeAt(0).cloneRange() };
    }
    restoreTextSelection(){
      if (!this.savedTextRange?.range) return null;
      const el = this.layer?.querySelector?.(`.fm-photo-markup-text[data-markup-id="${this.savedTextRange.id}"]`);
      if (!el) return null;
      const selection = root.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(this.savedTextRange.range);
      return el;
    }
    applyColorToTextSelection(color){
      const selection = root.getSelection?.();
      let el = this.activeTextElement();
      if ((!el || !selection || selection.rangeCount < 1 || selection.isCollapsed) && this.savedTextRange) el = this.restoreTextSelection();
      if (!el || !selection || selection.rangeCount < 1 || selection.isCollapsed) return false;
      if (!el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return false;
      document.execCommand?.('foreColor', false, color);
      const item = this.items.find((entry) => entry.id === el.dataset.markupId);
      if (item) {
        item.text = String(el.innerText || '').replace(/\u00a0/g, ' ');
        item.html = sanitizeMarkupHtml(el.innerHTML);
        this.emitChange();
      }
      return true;
    }
    destroy(){
      if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
      this.layer?.remove();
      this.dock?.remove();
    }
    onDown(event){
      if (!this.active) return;
      const textEl = event.target.closest?.('.fm-photo-markup-text');
      if (textEl && this.tool !== 'eraser') return;
      event.preventDefault();
      const point = this.point(event);
      if (this.tool === 'eraser') {
        const target = event.target.closest?.('[data-markup-id]');
        if (target) this.deleteItem(target.dataset.markupId);
        this.erasing = true;
        this.eraserPoints = [point];
        this.eraseAt(point);
        this.renderLayer();
        return;
      }
      const handle = event.target.closest?.('[data-markup-handle]');
      if (handle) {
        const item = this.items.find((entry) => entry.id === handle.dataset.markupId);
        const box = item?.type === 'text' ? this.textBoxRenderBox(item) : {};
        const rect = this.layer?.getBoundingClientRect?.() || { width: 900, height: 600 };
        this.dragging = {
          id: handle.dataset.markupId,
          kind: handle.dataset.markupHandle,
          offsetX: item?.type === 'text' && handle.dataset.markupHandle === 'text-move' ? point.x - Number(item.x || 0) : 0,
          offsetY: item?.type === 'text' && handle.dataset.markupHandle === 'text-move' ? point.y - Number(item.y || 0) : 0,
          startWidth: Number(box.width || item?.width || 0),
          startHeight: Number(box.height || item?.height || 0),
          startFontPx: Number(item?.fontPx || 0),
          startPointerWidthPx: item?.type === 'text' && handle.dataset.markupHandle === 'text-size' ? Math.max(1, (point.x - Number(item.x || 0)) * Math.max(1, rect.width || 900)) : 0,
          startPointerHeightPx: item?.type === 'text' && handle.dataset.markupHandle === 'text-size' ? Math.max(1, (point.y - Number(item.y || 0)) * Math.max(1, rect.height || 600)) : 0
        };
        return;
      }
      if (this.tool === 'text') {
        const rect = this.layer?.getBoundingClientRect?.() || { width: 900, height: 600 };
        const startWidth = 0.18;
        const startHeight = Math.max(20 / Math.max(1, rect.height || 600), 0.04);
        const item = {
          id: uid('text'),
          type: 'text',
          x: clamp(point.x, 0, Math.max(0, 0.995 - startWidth)),
          y: clamp(point.y, 0, Math.max(0, 0.995 - startHeight)),
          text: '',
          html: '',
          color: this.color,
          size: this.size,
          fontPx: this.textFontPx(this.size),
          width: startWidth,
          height: startHeight,
          naturalWidth: startWidth,
          naturalHeight: startHeight,
          aspect: 2.4
        };
        this.items.push(item);
        this.renderLayer();
        setTimeout(() => this.layer.querySelector(`[data-markup-id="${item.id}"]`)?.focus(), 0);
        this.pushHistory();
        this.emitChange();
        return;
      }
      this.drawing = this.tool === 'arrow'
        ? { id: uid('arrow'), type: 'arrow', x1: point.x, y1: point.y, x2: point.x, y2: point.y, color: this.color, size: this.size }
        : { id: uid('stroke'), type: 'stroke', points: [point], color: this.color, size: this.size };
      this.items.push(this.drawing);
      this.renderLayer();
    }
    onMove(event){
      if (!this.active) return;
      event.preventDefault();
      const point = this.point(event);
      if (this.dragging) {
        const item = this.items.find((entry) => entry.id === this.dragging.id);
        if (!item) return;
        if (item.type === 'arrow') {
          if (this.dragging.kind === 'arrow-start') {
            item.x1 = point.x;
            item.y1 = point.y;
          } else if (this.dragging.kind === 'arrow-end') {
            item.x2 = point.x;
            item.y2 = point.y;
          }
        } else if (item.type === 'text') {
          if (this.dragging.kind === 'text-size') {
            const box = this.textBoxFromResizeDrag(item, point, this.dragging);
            item.width = box.width;
            item.height = box.height;
            item.naturalWidth = box.width;
            item.naturalHeight = box.height;
            delete item.edgeNaturalWidth;
          } else if (this.dragging.kind === 'text-move') {
            const bounds = this.textBoxBounds(item);
            const fontSize = Number(item.fontPx) || this.textFontPx(item.size || 1.5, item.height ?? null, this.textMetrics(item).lineCount);
            item.x = clamp(point.x - Number(this.dragging.offsetX || 0), 0, Math.max(0, 0.995 - bounds.minWidth));
            item.y = clamp(point.y - Number(this.dragging.offsetY || 0), 0, Math.max(0, 0.995 - Number(item.height || bounds.minHeight)));
            this.fitTextBoxIntoAvailableWidth(item, fontSize);
            item.y = clamp(item.y, 0, Math.max(0, 0.995 - Number(item.height || bounds.minHeight)));
          }
        }
        this.renderLayer();
        return;
      }
      if (this.erasing) {
        const previous = this.eraserPoints[this.eraserPoints.length - 1] || point;
        this.eraserPoints.push(point);
        this.eraseBetween(previous, point);
        this.renderLayer();
        return;
      }
      if (!this.drawing) return;
      if (this.drawing.type === 'arrow') {
        this.drawing.x2 = point.x;
        this.drawing.y2 = point.y;
      } else {
        this.drawing.points.push(point);
      }
      this.renderLayer();
    }
    onUp(){
      if (this.drawing || this.dragging || this.erasing) {
        this.drawing = null;
        this.dragging = null;
        this.erasing = false;
        this.eraserPoints = [];
        this.renderLayer();
        this.pushHistory();
        this.emitChange();
      }
    }
    eraseAt(point){
      const before = this.items.length;
      this.items = this.items.filter((item) => !itemIntersectsPoint(item, point));
      return this.items.length !== before;
    }
    eraseBetween(a, b){
      const before = this.items.length;
      this.items = this.items.filter((item) => !itemIntersectsEraserSegment(item, a, b));
      return this.items.length !== before;
    }
    renderLayer(){
      if (!this.layer) return;
      this.items.forEach((item) => this.constrainItem(item));
      const svg = this.layer.querySelector('svg');
      const eraserPath = this.eraserPoints.length > 1
        ? `<path class="fm-photo-markup-path" d="${svgPath(this.eraserPoints)}" style="stroke:rgba(148,163,184,.46);stroke-width:${ERASER_STROKE_WIDTH};stroke-linecap:round;stroke-linejoin:round;pointer-events:none"></path>`
        : '';
      svg.innerHTML = this.items.filter((item) => item.type === 'stroke').map((item) => (
        `<path class="fm-photo-markup-path" data-markup-id="${escapeHtml(item.id)}" d="${svgPath(item.points)}" style="stroke:${escapeHtml(item.color || '#111')};stroke-width:${escapeHtml(String(item.size || 2.2))}"></path>`
      )).join('') + this.items.filter((item) => item.type === 'arrow').map((item) => {
        const parts = arrowParts(item);
        const style = `stroke:${escapeHtml(item.color || '#111')};stroke-width:${escapeHtml(String(item.size || 2.8))}`;
        return Object.values(parts).map((part) => `<line class="fm-photo-markup-arrow" data-markup-id="${escapeHtml(item.id)}" x1="${(part.x1 * 100).toFixed(3)}" y1="${(part.y1 * 100).toFixed(3)}" x2="${(part.x2 * 100).toFixed(3)}" y2="${(part.y2 * 100).toFixed(3)}" style="${style}"></line>`).join('');
      }).join('') + eraserPath;
      this.layer.querySelectorAll('.fm-photo-markup-text,.fm-photo-markup-handle,.fm-photo-markup-text-size').forEach((node) => node.remove());
      this.items.filter((item) => item.type === 'text').forEach((item) => {
        const metrics = this.textMetrics(item);
        const { width, height } = this.textBoxRenderBox(item);
        const fontSize = Number(item.fontPx) || this.textFontPx(item.size || 1.5, height, metrics.lineCount);
        const padding = this.textPadding(fontSize);
        const heightStyle = height != null ? `height:${(height * 100).toFixed(3)}%;` : '';
        const content = item.html ? sanitizeMarkupHtml(item.html) : escapeMarkupText(item.text || '');
        this.layer.insertAdjacentHTML('beforeend', `<div class="fm-photo-markup-text" data-markup-id="${escapeHtml(item.id)}" contenteditable="true" spellcheck="true" style="left:${(item.x * 100).toFixed(3)}%;top:${(item.y * 100).toFixed(3)}%;width:${(width * 100).toFixed(3)}%;${heightStyle}max-width:${(Math.max(0.12, 0.98 - item.x) * 100).toFixed(3)}%;color:${escapeHtml(item.color || '#111')};font-size:${fontSize.toFixed(1)}px;padding:${padding.y.toFixed(1)}px ${padding.x.toFixed(1)}px">${content}</div>`);
      });
      const layerRect = this.layer.getBoundingClientRect();
      this.layer.querySelectorAll('.fm-photo-markup-text').forEach((el) => {
        const item = this.items.find((entry) => entry.id === el.dataset.markupId);
        if (!item || !layerRect.height) return;
        if (item.height != null) return;
        const rect = el.getBoundingClientRect();
        item.height = clamp(rect.height / layerRect.height, 0.03, 0.5);
      });
      this.items.filter((item) => item.type === 'arrow').forEach((item) => {
        this.layer.insertAdjacentHTML('beforeend', `
          <div class="fm-photo-markup-handle" data-markup-id="${escapeHtml(item.id)}" data-markup-handle="arrow-start" style="left:${(Number(item.x1 || 0) * 100).toFixed(3)}%;top:${(Number(item.y1 || 0) * 100).toFixed(3)}%"></div>
          <div class="fm-photo-markup-handle" data-markup-id="${escapeHtml(item.id)}" data-markup-handle="arrow-end" style="left:${(Number(item.x2 || 0) * 100).toFixed(3)}%;top:${(Number(item.y2 || 0) * 100).toFixed(3)}%"></div>
        `);
      });
      this.items.filter((item) => item.type === 'text').forEach((item) => {
        const { width, height } = this.textBoxRenderBox(item);
        this.layer.insertAdjacentHTML('beforeend', `
          <div class="fm-photo-markup-handle" data-markup-id="${escapeHtml(item.id)}" data-markup-handle="text-move" style="left:${(Number(item.x || 0) * 100).toFixed(3)}%;top:${(Number(item.y || 0) * 100).toFixed(3)}%"></div>
          <div class="fm-photo-markup-text-size" data-markup-id="${escapeHtml(item.id)}" data-markup-handle="text-size" style="left:calc(${((Number(item.x || 0) + width) * 100).toFixed(3)}% - 10.5px);top:calc(${((Number(item.y || 0) + height) * 100).toFixed(3)}% - 10.5px)"></div>
        `);
      });
      this.layer.querySelectorAll('.fm-photo-markup-text').forEach((el) => {
        el.addEventListener('input', () => {
          const item = this.items.find((entry) => entry.id === el.dataset.markupId);
          if (!item) return;
          const previousMetrics = this.textMetrics(item);
          const previousFontSize = Number(item.fontPx) || this.textFontPx(item.size || 1.5, item.height ?? null, previousMetrics.lineCount);
          item.text = String(el.innerText || '').replace(/\u00a0/g, ' ');
          item.html = sanitizeMarkupHtml(el.innerHTML);
          item.aspect = this.textAspect(item);
          this.fitTextBoxToContent(item, { fontSize: previousFontSize });
          this.applyTextBoxElement(item, el);
          this.emitChange();
        });
        el.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && cleanText(event.key).toLowerCase() === 'a') {
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = root.getSelection?.();
            selection?.removeAllRanges();
            selection?.addRange(range);
            this.saveTextSelection();
          }
        });
        el.addEventListener('keyup', () => this.saveTextSelection());
        el.addEventListener('mouseup', () => this.saveTextSelection());
        el.addEventListener('blur', () => this.emitChange());
        el.addEventListener('blur', () => this.pushHistory());
      });
    }
  }

  class PhotoViewer {
    constructor(options = {}){
      this.photos = Array.isArray(options.photos) ? options.photos : [];
      this.index = clamp(Number(options.index || 0), 0, Math.max(0, this.photos.length - 1));
      this.project = options.project || {};
      this.onClose = options.onClose;
      this.onChange = options.onChange;
      this.onOpenProject = options.onOpenProject;
      this.onDeletePhoto = options.onDeletePhoto;
      this.boundsTarget = options.boundsTarget || null;
      this.projectLinkEnabled = options.projectLinkEnabled !== false;
      this.comments = [];
      this.mentions = null;
      this.modalHandle = null;
      injectStyles();
      this.renderShell();
      this.show(this.index);
    }
    current(){ return this.photos[this.index] || {}; }
    currentProject(){
      const photo = this.current();
      return (photo.__project && typeof photo.__project === 'object') ? photo.__project : (this.project || {});
    }
    close(){
      this.modalHandle?.unregister?.();
      this.modalHandle = null;
      this.markup?.destroy?.();
      this.mentions?.destroy?.();
      this.el?.remove();
      window.removeEventListener('keydown', this.keyHandler);
      window.removeEventListener('resize', this.boundResize);
      window.removeEventListener('mousedown', this.boundOutsideDown, true);
      window.removeEventListener('mouseup', this.boundOutsideUp, true);
      if (typeof this.onClose === 'function') this.onClose();
    }
    async show(index){
      this.index = (index + this.photos.length) % this.photos.length;
      const photo = this.current();
      const project = this.currentProject();
      const up = uploader(photo);
      const img = this.el.querySelector('[data-photo-img]');
      const video = this.el.querySelector('[data-photo-video]');
      const isVideo = isVideoMedia(photo);
      if (img) {
        img.hidden = isVideo;
        if (!isVideo) img.src = photoUrl(photo, 'original');
        else img.removeAttribute('src');
      }
      if (video) {
        video.hidden = !isVideo;
        if (isVideo) {
          video.src = photoUrl(photo, 'original');
          video.autoplay = true;
          video.load?.();
          const playVideo = () => video.play?.().catch(() => null);
          if (video.readyState >= 2) window.setTimeout(playVideo, 0);
          else video.addEventListener('canplay', playVideo, { once: true });
        } else {
          video.pause?.();
          video.removeAttribute('src');
          video.autoplay = false;
          video.load?.();
        }
      }
      const plainDownload = this.el.querySelector('[data-photo-download-plain]');
      if (plainDownload) plainDownload.innerHTML = isVideo ? '<i class="fas fa-download"></i> Download' : '<i class="far fa-image"></i> Download without Markup';
      requestAnimationFrame(() => this.updateMarkupLayerBounds());
      this.el.querySelector('[data-photo-title]').textContent = photo.label || project.title || project.address || (isVideo ? 'Video' : 'Photo');
      this.el.querySelector('[data-photo-sub]').textContent = `${up.name || 'Unknown uploader'}${up.at ? ` • ${formatDateTime(up.at)}` : ''}`;
      this.el.querySelector('[data-photo-project]').textContent = project.title || project.address || 'Project photo';
      this.el.querySelector('[data-photo-uploader]').textContent = up.name || 'Unknown uploader';
      this.el.querySelector('[data-photo-uploaded]').textContent = up.at ? formatDateTime(up.at) : 'Unknown time';
      this.el.querySelector('[data-photo-counter]').textContent = `${this.index + 1} / ${this.photos.length}`;
      this.el.querySelector('[data-photo-avatar]').textContent = (up.name || up.email || '?').slice(0, 1).toUpperCase();
      const userBtn = this.el.querySelector('[data-photo-user-open]');
      if (userBtn) {
        userBtn.dataset.photoUserId = up.id || '';
        userBtn.dataset.photoUserName = up.name || '';
        userBtn.dataset.photoUserEmail = up.email || '';
        userBtn.dataset.photoUserAvatar = up.avatar || '';
      }
      this.el.querySelector('[data-photo-tags]').innerHTML = this.photoTags(photo).map((tag) => `<span class="fm-photo-tag">#${escapeHtml(tag)}</span>`).join('');
      this.markup?.setItems([]);
      this.el.classList.toggle('video-active', isVideo);
      if (isVideo) this.markup?.setActive(false);
      if (photo.media_id) {
        const [items, comments] = await Promise.all([isVideo ? Promise.resolve([]) : loadMarkup(orgId(), photo.media_id), loadComments(orgId(), photo.media_id)]);
        if (this.current() !== photo) return;
        this.markup?.setItems(items);
        this.comments = comments;
      } else {
        this.comments = [];
      }
      this.renderComments();
      if (typeof this.onChange === 'function') this.onChange({ photo, index: this.index, project, isVideo });
    }
    photoTags(photo = {}){
      const meta = photo.metadata && typeof photo.metadata === 'object' ? photo.metadata : {};
      return [...new Set([...(Array.isArray(photo.tags) ? photo.tags : []), ...(Array.isArray(meta.tags) ? meta.tags : [])].map(cleanText).filter(Boolean))];
    }
    renderShell(){
      this.el = document.createElement('div');
      this.el.className = 'fm-photo-modal';
      this.el.innerHTML = `
        <div class="fm-photo-modal-shell">
          <div class="fm-photo-stage" data-photo-stage>
            <img data-photo-img alt="">
            <video data-photo-video hidden controls autoplay playsinline preload="metadata"></video>
            <div class="fm-photo-top">
              <div class="fm-photo-title"><strong data-photo-title></strong><span data-photo-sub></span></div>
              <div class="fm-photo-actions">
                <div class="fm-photo-actions-wrap">
                  <button type="button" class="fm-photo-iconbtn" data-photo-actions aria-label="Photo actions"><i class="fas fa-ellipsis"></i></button>
                  <div class="fm-photo-actions-menu" data-photo-actions-menu>
                    <button type="button" data-photo-download-markup><i class="fas fa-download"></i> Download</button>
                    <button type="button" data-photo-download-plain><i class="far fa-image"></i> Download without Markup</button>
                    <button type="button" class="danger" data-photo-delete><i class="fas fa-trash"></i> Delete</button>
                  </div>
                </div>
                <button type="button" class="fm-photo-iconbtn" data-photo-close aria-label="Close photo"><i class="fas fa-times"></i></button>
              </div>
            </div>
            <button type="button" class="fm-photo-nav prev" data-photo-prev aria-label="Previous photo"><i class="fas fa-chevron-left"></i></button>
            <button type="button" class="fm-photo-nav next" data-photo-next aria-label="Next photo"><i class="fas fa-chevron-right"></i></button>
          </div>
          <aside class="fm-photo-side">
            <div class="fm-photo-meta">
              ${this.projectLinkEnabled ? `<button type="button" class="fm-photo-project-link" data-photo-project>${escapeHtml(this.project.title || this.project.address || 'Project photo')}</button>` : `<div class="fm-photo-project-link is-static" data-photo-project>${escapeHtml(this.project.title || this.project.address || 'Project photo')}</div>`}
              <button type="button" class="fm-photo-user-row" data-photo-user-open><span class="fm-photo-avatar" data-photo-avatar>?</span><span><strong data-photo-uploader></strong><br><span data-photo-uploaded></span></span></button>
              <div class="fm-photo-meta-row"><i class="fas fa-images"></i><span data-photo-counter></span></div>
              <div class="fm-photo-tags" data-photo-tags></div>
            </div>
            <div class="fm-photo-comments" data-photo-comments></div>
            <div class="fm-photo-composer">
              <textarea data-photo-comment-input placeholder="Leave a comment. Type @ to tag someone."></textarea>
              <div class="fm-photo-composer-actions"><button type="button" data-photo-comment-post>Post Comment</button></div>
            </div>
          </aside>
        </div>`;
      document.body.appendChild(this.el);
      this.modalHandle = root.Portal?.modals?.register?.(this.el, {
        id: 'photo-viewer',
        closeOnEscape: true,
        closeOnBackdrop: false,
        onClose: () => this.close()
      }) || null;
      this.boundResize = () => {
        this.updateBounds();
        this.updateMarkupLayerBounds();
      };
      this.boundOutsideDown = (event) => this.handleOutsidePointer(event, 'down');
      this.boundOutsideUp = (event) => this.handleOutsidePointer(event, 'up');
      this.updateBounds();
      window.addEventListener('resize', this.boundResize);
      window.addEventListener('mousedown', this.boundOutsideDown, true);
      window.addEventListener('mouseup', this.boundOutsideUp, true);
      this.markup = new PhotoMarkup(this.el.querySelector('[data-photo-stage]'), {
        dock: { position: 'dock-bottom-right', expand: 'expand-left' },
        size: 1.5,
        onChange: (items) => {
          const photo = this.current();
          if (photo.media_id && !isVideoMedia(photo)) saveMarkup(orgId(), photo.media_id, items);
        }
      });
      this.el.querySelector('[data-photo-img]')?.addEventListener('load', () => this.updateMarkupLayerBounds());
      this.el.querySelector('[data-photo-close]').addEventListener('click', () => this.close());
      const actionMenu = () => this.el.querySelector('[data-photo-actions-menu]');
      this.el.querySelector('[data-photo-actions]')?.addEventListener('click', () => {
        actionMenu()?.classList.toggle('visible');
      });
      this.el.querySelector('[data-photo-download-plain]')?.addEventListener('click', async () => {
        actionMenu()?.classList.remove('visible');
        await downloadPhoto(this.current(), { withMarkup: false }).catch((error) => root.PlatformUI?.alert?.(error?.message || 'Could not download this photo.'));
      });
      this.el.querySelector('[data-photo-download-markup]')?.addEventListener('click', async () => {
        actionMenu()?.classList.remove('visible');
        await downloadPhoto(this.current(), { withMarkup: true, items: this.markup?.items || [] }).catch((error) => root.PlatformUI?.alert?.(error?.message || 'Could not download this photo.'));
      });
      this.el.querySelector('[data-photo-delete]')?.addEventListener('click', async () => {
        actionMenu()?.classList.remove('visible');
        if (typeof this.onDeletePhoto !== 'function') {
          await (root.PlatformUI?.alert?.('This photo cannot be deleted from here.', { title: 'Delete unavailable' }) || Promise.resolve(alert('This photo cannot be deleted from here.')));
          return;
        }
        const result = await this.onDeletePhoto(this.current(), this.currentProject());
        if (result?.count !== 0) this.close();
      });
      this.el.querySelector('[data-photo-prev]').addEventListener('click', () => this.show(this.index - 1));
      this.el.querySelector('[data-photo-next]').addEventListener('click', () => this.show(this.index + 1));
      if (this.projectLinkEnabled) {
        this.el.querySelector('[data-photo-project]')?.addEventListener('click', () => {
          const project = this.currentProject();
          if (typeof this.onOpenProject === 'function') this.onOpenProject(project);
          else window.Portal?.modules?.request?.openProject?.(project);
          this.close();
        });
      }
      this.el.querySelector('[data-photo-user-open]')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const btn = event.currentTarget;
        root.Portal?.PhotoFeed?.openUserModal?.({
          id: btn.dataset.photoUserId || '',
          name: btn.dataset.photoUserName || '',
          email: btn.dataset.photoUserEmail || '',
          avatar: btn.dataset.photoUserAvatar || ''
        }, []);
      });
      this.el.querySelector('[data-photo-comment-post]').addEventListener('click', () => this.postComment());
      this.mentions = root.FirstMateTags?.attachMentionTextarea?.(this.el.querySelector('[data-photo-comment-input]'), { orgId: orgId() });
      this.keyHandler = (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          if (event.target?.closest?.('.fm-photo-markup-text,[contenteditable="true"],textarea,input,select')) return;
          if (this.modalHandle && !this.modalHandle.isTop?.()) return;
          event.preventDefault();
          this.show(this.index + (event.key === 'ArrowLeft' ? -1 : 1));
        }
      };
      window.addEventListener('keydown', this.keyHandler);
    }
    handleOutsidePointer(event, phase){
      if (this.modalHandle && !this.modalHandle.isTop?.()) return;
      if (!this.el || this.el.contains(event.target)) return;
      const rect = this.el.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      if (!outside) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (phase === 'down') {
        this.outsidePointerDown = true;
        return;
      }
      if (this.outsidePointerDown) this.close();
      this.outsidePointerDown = false;
    }
    updateBounds(){
      if (!this.el) return;
      const target = this.boundsTarget
        || document.getElementById('mainPanels')
        || document.querySelector('.main-panels')
        || document.querySelector('.main')
        || document.body;
      const rect = target.getBoundingClientRect();
      const top = Math.max(0, rect.top);
      const left = Math.max(0, rect.left);
      const width = Math.max(280, rect.width || window.innerWidth - left);
      const height = Math.max(280, rect.height || window.innerHeight - top);
      Object.assign(this.el.style, {
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        height: `${height}px`
      });
    }
    updateMarkupLayerBounds(){
      const stage = this.el?.querySelector?.('[data-photo-stage]');
      const img = this.el?.querySelector?.('[data-photo-img]');
      const layer = this.markup?.layer;
      if (!stage || !img || !layer) return;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height || !imgRect.width || !imgRect.height) return;
      Object.assign(layer.style, {
        inset: 'auto',
        left: `${Math.max(0, imgRect.left - stageRect.left)}px`,
        top: `${Math.max(0, imgRect.top - stageRect.top)}px`,
        width: `${Math.max(1, imgRect.width)}px`,
        height: `${Math.max(1, imgRect.height)}px`
      });
      this.markup.renderLayer?.();
    }
    renderComments(){
      const rootEl = this.el.querySelector('[data-photo-comments]');
      if (!rootEl) return;
      if (!this.comments.length) {
        rootEl.innerHTML = '<div class="fm-photo-comment-empty">No comments yet.</div>';
        return;
      }
      rootEl.innerHTML = this.comments.map((comment) => `
        <div class="fm-photo-comment">
          <span class="fm-photo-avatar">${escapeHtml((comment.author_name || comment.author_email || '?').slice(0, 1).toUpperCase())}</span>
          <div class="fm-photo-comment-body">
            <div class="fm-photo-comment-head"><strong>${escapeHtml(comment.author_name || comment.author_email || 'User')}</strong><span>${escapeHtml(formatDateTime(comment.created_at))}</span></div>
            <div class="fm-photo-comment-text">${renderMentionText(comment.text || '', comment.mentions || [])}</div>
          </div>
        </div>
      `).join('');
      this.bindMentionInteractions(rootEl);
      rootEl.scrollTop = rootEl.scrollHeight;
    }
    mentionUserFromChip(chip){
      return {
        id: cleanText(chip?.dataset?.photoMentionUser),
        name: cleanText(chip?.dataset?.photoMentionName),
        email: cleanText(chip?.dataset?.photoMentionEmail),
        avatar: cleanText(chip?.dataset?.photoMentionAvatar)
      };
    }
    positionMentionCard(chip){
      const card = chip?.querySelector?.('.fm-photo-mention-card');
      if (!chip || !card) return;
      const rect = chip.getBoundingClientRect();
      card.classList.add('visible');
      const cardRect = card.getBoundingClientRect();
      const width = cardRect.width || 260;
      const height = cardRect.height || 74;
      let left = rect.left;
      let top = rect.top - height - 8;
      if (top < 8) top = rect.bottom + 8;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      left = Math.max(8, left);
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    }
    hideMentionCard(chip){
      chip?.querySelector?.('.fm-photo-mention-card')?.classList.remove('visible');
    }
    openMentionUser(chip){
      const user = this.mentionUserFromChip(chip);
      if (!user.id && !user.email && !user.name) return;
      root.Portal?.PhotoFeed?.openUserModal?.(user, []);
    }
    bindMentionInteractions(rootEl){
      rootEl.querySelectorAll('[data-photo-mention-user]').forEach((chip) => {
        chip.addEventListener('mouseenter', () => this.positionMentionCard(chip));
        chip.addEventListener('focus', () => this.positionMentionCard(chip));
        chip.addEventListener('mouseleave', () => this.hideMentionCard(chip));
        chip.addEventListener('blur', () => this.hideMentionCard(chip));
        chip.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.openMentionUser(chip);
        });
        chip.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          this.openMentionUser(chip);
        });
      });
    }
    async postComment(){
      const input = this.el.querySelector('[data-photo-comment-input]');
      const text = cleanText(input?.value);
      const photo = this.current();
      const project = this.currentProject();
      if (!text || !photo.media_id) return;
      const mentions = this.mentions?.selectedMentions?.() || root.FirstMateTags?.extractMentions?.(text, await root.FirstMateTags.listUsers(orgId()).catch(() => [])) || [];
      const comment = {
        id: uid('comment'),
        text,
        author_name: userName(),
        author_email: userEmail(),
        mentions: mentions.map((user) => ({
          id: user.id,
          name: user.name || user.label || user.email || user.id,
          email: user.email || '',
          avatar: mentionAvatar(user)
        })),
        created_at: new Date().toISOString()
      };
      this.comments = [...this.comments, comment];
      input.value = '';
      this.renderComments();
      await saveComments(orgId(), photo.media_id, this.comments).catch(() => null);
      root.Portal?.PhotoFeed?.trackActivity?.({
        type: 'photo_commented',
        summary: 'Commented on media',
        actor_name: userName(),
        actor_email: userEmail(),
        target: {
          media_id: photo.media_id,
          photo_id: photoId(photo),
          project_id: project.id || '',
          project_title: project.title || project.address || '',
          project_address: project.address || ''
        },
        metadata: {
          comment_id: comment.id,
          mention_count: mentions.length
        }
      }, { source: 'photo_comments' });
      if (mentions.length) {
        root.FirstMateTags?.triggerMentionEvent?.(orgId(), root.FirstMateTags.mentionEventPayload({
          mentions,
          comment,
          context: {
            media_id: photo.media_id,
            photo_id: photoId(photo),
            project_id: project.id || '',
            project_title: project.title || project.address || '',
            kind: 'photo_comment'
          }
        })).catch(() => null);
      }
      if (typeof this.onChange === 'function') this.onChange({ photo, comments: this.comments });
    }
  }

  function openPhotoViewer(options = {}){
    return new PhotoViewer(options);
  }

  function proposalDockHtml(){
    return `
      <div class="r-proposal-markupdock" id="rProposalMarkupDock">
        <button type="button" class="r-proposal-markup-btn" id="rProposalMarkupToggle" data-fm-tooltip="Markup"><i class="fas fa-pen"></i></button>
        <div class="r-proposal-markup-tools">
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupEraser" data-fm-tooltip="Eraser"><i class="fas fa-eraser"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupArrow" data-fm-tooltip="Arrow"><i class="fas fa-arrow-right"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupText" data-fm-tooltip="Text"><i class="fas fa-font"></i></button>
          <div style="position:relative">
            <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupSize" data-fm-tooltip="Size"><span class="r-proposal-markup-tool-size">2.2x</span></button>
            <div class="r-proposal-markup-pop" id="rProposalMarkupSizePop">
              <div class="r-proposal-markup-slider"><input type="range" min="1" max="8" step="0.1"></div>
            </div>
          </div>
          <div style="position:relative">
            <button type="button" class="r-proposal-markup-tool swatch" id="rProposalMarkupColor" data-fm-tooltip="Color"><span class="r-proposal-markup-tool-swatch"></span></button>
            <div class="r-proposal-markup-pop" id="rProposalMarkupColorPop">
              ${markupColorPaletteHtml('#111111')}
            </div>
          </div>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupUndo" data-fm-tooltip="Undo"><i class="fas fa-undo"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupRedo" data-fm-tooltip="Redo"><i class="fas fa-redo"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupClear" data-fm-tooltip="Clear page"><i class="fas fa-trash"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupClose" data-fm-tooltip="Close markup"><i class="fas fa-times"></i></button>
        </div>
      </div>`;
  }

  root.FirstMateMarkup = {
    PhotoMarkup,
    PhotoViewer,
    openPhotoViewer,
    loadMarkup,
    saveMarkup,
    loadComments,
    saveComments,
    downloadPhoto,
    downloadPhotoZip,
    renderPhotoWithMarkupBlob,
    photoUrl,
    uploader,
    formatDateTime,
    proposalDockHtml,
    markupColorPaletteHtml,
    rememberMarkupColor,
    markupDefaultColors: MARKUP_DEFAULT_COLORS.slice(),
    PHOTO_MARKUP_LAYER,
    PHOTO_COMMENTS_LAYER
  };
})();
