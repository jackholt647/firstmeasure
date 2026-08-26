/* libraries/platform-tags/platform-tags.js
 * Lightweight org-wide tagging and mention helpers.
 */
(function(){
  const root = window;
  const cache = new Map();

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return cleanText(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function orgId(){
    return cleanText(root.__APP?.userOrgId || root.__APP?.orgId || root.Portal?.cfg?.userOrgId || root.Portal?.cfg?.orgId);
  }
  function normalizeUser(user = {}){
    const data = user?.data && typeof user.data === 'object' ? user.data : user;
    const id = cleanText(user.id || data.id || data.user_id || data.identity_id || data.email);
    const email = cleanText(data.email || data.user_email);
    const name = cleanText(data.name || data.full_name || email || id);
    const avatar = cleanText(data.avatar || data.avatar_url || data.photo_url || data.profile_photo_url || data.image_url || data.picture || data.profile_image);
    return {
      id,
      email,
      name,
      avatar,
      label: name || email || id,
      search: `${name} ${email} ${id}`.toLowerCase(),
      raw: data
    };
  }
  async function listUsers(selectedOrgId = orgId(), options = {}){
    const oid = cleanText(selectedOrgId);
    if (!oid || !root.PlatformAPI?.users?.list) return [];
    if (cache.has(oid) && !options.refresh) return cache.get(oid);
    const result = await root.PlatformAPI.users.list(oid).catch(() => ({ users: [], documents: [] }));
    const users = (Array.isArray(result?.users) ? result.users : (Array.isArray(result?.documents) ? result.documents : []))
      .map(normalizeUser)
      .filter((user) => user.id && user.raw?.status !== 'disabled' && user.raw?.deleted !== true);
    cache.set(oid, users);
    return users;
  }
  function extractMentions(text = '', users = []){
    const value = cleanText(text);
    if (!value) return [];
    const lower = value.toLowerCase();
    return users.filter((user) => {
      const tokens = [`@${user.name}`, `@${user.email}`, `@${user.label}`]
        .map((item) => item.toLowerCase().replace(/\s+/g, ' ').trim())
        .filter((item) => item.length > 1);
      return tokens.some((token) => lower.includes(token));
    }).map((user) => ({ id: user.id, name: user.name, email: user.email, avatar: user.avatar }));
  }
  function mentionEventPayload({ source = 'photo_comment', mentions = [], context = {}, comment = {} } = {}){
    return {
      source,
      mention_users: mentions,
      target_user_ids: mentions.map((user) => user.id).filter(Boolean),
      context,
      comment
    };
  }
  async function triggerMentionEvent(selectedOrgId, payload = {}){
    if (!root.PlatformAPI?.tagging?.mentionEvent) return { ok: false, missing: true };
    return root.PlatformAPI.tagging.mentionEvent(selectedOrgId || orgId(), payload);
  }

  function caretQuery(textarea){
    const value = textarea.value || '';
    const pos = textarea.selectionStart || 0;
    const before = value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) return null;
    const fragment = before.slice(at + 1);
    if (/\s/.test(fragment) || fragment.length > 80) return null;
    return { at, pos, fragment };
  }
  function ensureMenu(){
    let menu = document.getElementById('fmMentionMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'fmMentionMenu';
    menu.className = 'fm-mention-menu';
    document.body.appendChild(menu);
    return menu;
  }
  function injectStyles(){
    root.Portal?.util?.injectCSS?.('platform_tags_mentions', `
      .fm-mention-menu{position:fixed;z-index:2147483500;display:none;min-width:220px;max-width:280px;max-height:240px;overflow:auto;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;box-shadow:0 18px 40px rgba(15,23,42,.18);padding:6px}
      .fm-mention-menu.visible{display:block}
      .fm-mention-option{width:100%;border:0;background:transparent;border-radius:9px;padding:8px 10px;display:flex;align-items:center;gap:9px;text-align:left;cursor:pointer;color:#101828}
      .fm-mention-option:hover,.fm-mention-option.active{background:rgba(var(--primary-rgb,217,48,37),.1)}
      .fm-mention-avatar{width:28px;height:28px;border-radius:999px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;flex:0 0 auto}
      .fm-mention-name{font-weight:800;font-size:13px;line-height:1.15}
      .fm-mention-email{font-size:11px;color:#667085;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    `);
  }
  function attachMentionTextarea(textarea, options = {}){
    if (!textarea) return { destroy(){} };
    injectStyles();
    let users = [];
    let matches = [];
    let activeIndex = 0;
    let query = null;
    const menu = ensureMenu();
    const selected = new Map();
    const oid = cleanText(options.orgId || orgId());
    listUsers(oid).then((list) => { users = list; }).catch(() => {});

    function hide(){
      menu.classList.remove('visible');
      menu.innerHTML = '';
      matches = [];
      query = null;
      activeIndex = 0;
    }
    function insert(user){
      if (!query || !user) return;
      const value = textarea.value || '';
      const before = value.slice(0, query.at);
      const after = value.slice(query.pos);
      const label = user.name || user.email || user.id;
      textarea.value = `${before}@${label} ${after}`;
      const nextPos = before.length + label.length + 2;
      textarea.setSelectionRange(nextPos, nextPos);
      selected.set(user.id, user);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      if (typeof options.onSelect === 'function') options.onSelect(user);
    }
    function render(){
      if (!matches.length || !query) return hide();
      const rect = textarea.getBoundingClientRect();
      const menuWidth = 280;
      const menuHeight = Math.min(240, 48 + (matches.slice(0, 8).length * 45));
      const left = Math.max(8, Math.min(rect.left + 12, window.innerWidth - menuWidth - 8));
      const below = rect.bottom + 6;
      const above = rect.top - menuHeight - 6;
      const top = below + menuHeight <= window.innerHeight - 8 ? below : Math.max(8, above);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.innerHTML = matches.slice(0, 8).map((user, index) => `
        <button type="button" class="fm-mention-option${index === activeIndex ? ' active' : ''}" data-mention-user="${escapeHtml(user.id)}">
          <span class="fm-mention-avatar">${escapeHtml((user.name || user.email || '?').slice(0, 1).toUpperCase())}</span>
          <span style="min-width:0"><span class="fm-mention-name">${escapeHtml(user.name || user.email || user.id)}</span><span class="fm-mention-email">${escapeHtml(user.email || user.id)}</span></span>
        </button>
      `).join('');
      menu.querySelectorAll('[data-mention-user]').forEach((btn) => {
        btn.addEventListener('mousedown', (event) => {
          event.preventDefault();
          insert(matches.find((user) => user.id === btn.dataset.mentionUser));
        });
      });
      menu.classList.add('visible');
    }
    function update(){
      query = caretQuery(textarea);
      if (!query) return hide();
      const needle = query.fragment.toLowerCase();
      matches = users.filter((user) => !needle || user.search.includes(needle));
      activeIndex = 0;
      render();
    }
    function onKeydown(event){
      if (!menu.classList.contains('visible')) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeIndex = Math.min(matches.length - 1, activeIndex + 1);
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        render();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insert(matches[activeIndex] || matches[0]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    }
    textarea.addEventListener('input', update);
    textarea.addEventListener('keyup', update);
    textarea.addEventListener('click', update);
    textarea.addEventListener('keydown', onKeydown);
    document.addEventListener('mousedown', (event) => {
      if (event.target !== textarea && !menu.contains(event.target)) hide();
    });
    return {
      selectedMentions(){
        const found = extractMentions(textarea.value || '', users);
        found.forEach((user) => selected.set(user.id, user));
        return [...selected.values()].filter((user) => (textarea.value || '').toLowerCase().includes(`@${(user.name || user.email || user.id).toLowerCase()}`));
      },
      destroy(){
        textarea.removeEventListener('input', update);
        textarea.removeEventListener('keyup', update);
        textarea.removeEventListener('click', update);
        textarea.removeEventListener('keydown', onKeydown);
        hide();
      }
    };
  }

  root.FirstMateTags = {
    listUsers,
    normalizeUser,
    extractMentions,
    mentionEventPayload,
    triggerMentionEvent,
    attachMentionTextarea
  };
})();
