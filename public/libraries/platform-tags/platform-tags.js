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
  // AI agents that participate in team messaging (mentionable like teammates).
  const agentCache = new Map();
  function listAgentParticipants(selectedOrgId = orgId()){
    const oid = cleanText(selectedOrgId);
    if (!oid || !root.AgentsAPI?.participants) return Promise.resolve([]);
    if (agentCache.has(oid)) return agentCache.get(oid);
    const promise = root.AgentsAPI.participants(oid)
      .then((result) => (Array.isArray(result?.participants) ? result.participants : [])
        .map((participant) => ({
          id: cleanText(participant.id),
          email: '',
          name: cleanText(participant.name),
          avatar: '',
          label: cleanText(participant.name),
          search: `${cleanText(participant.name)} ai agent assistant`.toLowerCase(),
          raw: { kind: 'agent' },
          agent: true
        }))
        .filter((participant) => participant.id))
      .catch(() => []);
    agentCache.set(oid, promise);
    return promise;
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
    const oid = selectedOrgId || orgId();
    const result = await root.PlatformAPI.tagging.mentionEvent(oid, payload);
    const currentUserId = cleanText(root.__APP?.userId || root.Portal?.currentUser?.id || root.Portal?.cfg?.userId);
    const targetUserIds = [
      ...(Array.isArray(payload.target_user_ids) ? payload.target_user_ids : []),
      ...(Array.isArray(payload.mention_users) ? payload.mention_users.map((user) => user?.id) : [])
    ].map(cleanText).filter(Boolean);
    if (currentUserId && targetUserIds.includes(currentUserId)) {
      await root.PlatformNotifications?.load?.(oid).catch?.(() => null);
    }
    return result;
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
      .fm-mention-details{min-width:0;display:flex;flex-direction:column;gap:3px}
      .fm-mention-name{display:block;font-weight:800;font-size:13px;line-height:1.15}
      .fm-mention-email{display:block;font-size:11px;color:#667085;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-mention-mirror{position:absolute;pointer-events:none;overflow:hidden;color:transparent;white-space:pre-wrap;overflow-wrap:break-word}
      .fm-mention-avatar--agent{background:var(--primary-readable,var(--primary,#d93025));-webkit-mask:url('/images/logo_square.png') center / 82% no-repeat;mask:url('/images/logo_square.png') center / 82% no-repeat;border-radius:0;color:transparent}
      .fm-mention-hl{background:rgba(var(--primary-rgb,217,48,37),.14);border-radius:5px;box-shadow:0 0 0 1px rgba(var(--primary-rgb,217,48,37),.16)}
    `);
  }

  // --- composer mention highlighting ---------------------------------------
  // A textarea cannot style its own text, so a mirror div sits BEHIND the
  // (transparent-backgrounded) textarea and paints a tinted pill under every
  // token the controller will actually send as a tag. The textarea's own
  // text renders on top, so typing behavior is untouched.
  function attachMentionHighlight(textarea, getMentionLabels){
    const parent = textarea.parentElement;
    if (!parent) return { refresh(){}, destroy(){} };
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const mirror = document.createElement('div');
    mirror.className = 'fm-mention-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    parent.insertBefore(mirror, textarea);
    const originalBackground = textarea.style.background;
    const originalPosition = textarea.style.position;
    if (getComputedStyle(textarea).position === 'static') textarea.style.position = 'relative';
    textarea.style.background = 'transparent';

    function highlightHtml(){
      const value = textarea.value || '';
      const labels = (getMentionLabels() || [])
        .map((label) => cleanText(label))
        .filter((label) => label.length > 1)
        .sort((a, b) => b.length - a.length);
      if (!labels.length || !value) return escapeHtml(value);
      // Collect non-overlapping @label ranges, longest labels first.
      const lower = value.toLowerCase();
      const ranges = [];
      for (const label of labels) {
        const token = `@${label.toLowerCase()}`;
        let from = 0;
        for (;;) {
          const at = lower.indexOf(token, from);
          if (at < 0) break;
          from = at + token.length;
          if (!ranges.some((range) => at < range.end && at + token.length > range.start)) {
            ranges.push({ start: at, end: at + token.length });
          }
        }
      }
      if (!ranges.length) return escapeHtml(value);
      ranges.sort((a, b) => a.start - b.start);
      let html = '';
      let cursor = 0;
      for (const range of ranges) {
        html += escapeHtml(value.slice(cursor, range.start));
        html += `<span class="fm-mention-hl">${escapeHtml(value.slice(range.start, range.end))}</span>`;
        cursor = range.end;
      }
      html += escapeHtml(value.slice(cursor));
      return html;
    }

    function refresh(){
      if (!textarea.isConnected) return;
      const style = getComputedStyle(textarea);
      Object.assign(mirror.style, {
        left: `${textarea.offsetLeft}px`,
        top: `${textarea.offsetTop}px`,
        width: `${textarea.offsetWidth}px`,
        height: `${textarea.offsetHeight}px`,
        boxSizing: style.boxSizing,
        padding: style.padding,
        border: style.border,
        borderColor: 'transparent',
        borderRadius: style.borderRadius,
        font: style.font,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        textTransform: style.textTransform,
        textIndent: style.textIndent,
        wordBreak: style.wordBreak,
        // The textarea is transparent so the pills show through; the mirror
        // carries the visual background (incl. mode tints like amber notes).
        background: style.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : style.backgroundColor
      });
      mirror.innerHTML = `${highlightHtml()}\n`;
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    }

    const onScroll = () => { mirror.scrollTop = textarea.scrollTop; mirror.scrollLeft = textarea.scrollLeft; };
    textarea.addEventListener('scroll', onScroll);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null;
    observer?.observe(textarea);
    refresh();
    return {
      refresh,
      destroy(){
        textarea.removeEventListener('scroll', onScroll);
        observer?.disconnect();
        mirror.remove();
        textarea.style.background = originalBackground;
        textarea.style.position = originalPosition;
      }
    };
  }
  function caretAnchor(textarea, index){
    const rect = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, {
      position:'fixed', visibility:'hidden', pointerEvents:'none', overflow:'hidden',
      left:`${rect.left}px`, top:`${rect.top - textarea.scrollTop}px`, width:`${rect.width}px`,
      boxSizing:style.boxSizing, padding:style.padding, border:style.border,
      font:style.font, letterSpacing:style.letterSpacing, lineHeight:style.lineHeight,
      textTransform:style.textTransform, textIndent:style.textIndent,
      whiteSpace:'pre-wrap', overflowWrap:'break-word', wordBreak:style.wordBreak
    });
    mirror.textContent = (textarea.value || '').slice(0, index);
    marker.textContent = '@';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const anchor = marker.getBoundingClientRect();
    mirror.remove();
    return anchor.width || anchor.height ? anchor : rect;
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
    // Team-messaging surfaces also offer the AI agent(s) as mention targets.
    const includeAgents = options.includeAgents === true || options.source === 'channels';
    Promise.all([
      listUsers(oid).catch(() => []),
      includeAgents ? listAgentParticipants(oid) : Promise.resolve([])
    ]).then(([list, agents]) => { users = [...list, ...agents]; }).catch(() => {});

    // Pills under every token that will actually send as a tag (picked from
    // the menu, seeded via setSelectedMentions, or an exact typed name).
    const highlighter = attachMentionHighlight(textarea, () => {
      const value = textarea.value || '';
      const labels = new Set();
      extractMentions(value, users).forEach((user) => labels.add(user.name || user.email || user.id));
      selected.forEach((user) => labels.add(user.name || user.email || user.id));
      return [...labels];
    });

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
      const anchor = caretAnchor(textarea, query.at);
      const menuWidth = 280;
      const menuHeight = Math.min(240, 48 + (matches.slice(0, 8).length * 45));
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menuWidth - 8));
      const below = anchor.bottom + 6;
      const above = anchor.top - menuHeight - 6;
      const top = above >= 8 ? above : Math.min(window.innerHeight - menuHeight - 8, below);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.innerHTML = matches.slice(0, 8).map((user, index) => `
        <button type="button" class="fm-mention-option${index === activeIndex ? ' active' : ''}" data-mention-user="${escapeHtml(user.id)}">
          <span class="fm-mention-avatar${user.agent ? ' fm-mention-avatar--agent' : ''}">${user.agent ? '' : escapeHtml((user.name || user.email || '?').slice(0, 1).toUpperCase())}</span>
          <span class="fm-mention-details"><span class="fm-mention-name">${escapeHtml(user.name || user.email || user.id)}</span><span class="fm-mention-email">${escapeHtml(user.email || user.id)}</span></span>
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
      highlighter.refresh();
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
      confirmedMentions(){
        const value = (textarea.value || '').toLowerCase();
        return [...selected.values()].filter((user) => value.includes(`@${(user.name || user.email || user.id).toLowerCase()}`));
      },
      setSelectedMentions(mentions = []){
        selected.clear();
        mentions.forEach((user) => { if (user?.id) selected.set(user.id, normalizeUser(user)); });
        highlighter.refresh();
      },
      refreshHighlight(){ highlighter.refresh(); },
      destroy(){
        textarea.removeEventListener('input', update);
        textarea.removeEventListener('keyup', update);
        textarea.removeEventListener('click', update);
        textarea.removeEventListener('keydown', onKeydown);
        highlighter.destroy();
        hide();
      }
    };
  }

  root.FirstMateTags = {
    listUsers,
    listAgentParticipants,
    normalizeUser,
    extractMentions,
    mentionEventPayload,
    triggerMentionEvent,
    attachMentionTextarea
  };
})();
