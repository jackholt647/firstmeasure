/* scripts/topbar.js
 * Thin content top bar with search and notifications.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { escapeHtml } = window.Portal.util;

  const orgId = () => String(cfg.userOrgId || cfg.orgId || '').trim();
  const branchId = () => window.Portal.branchModules?.currentBranchId?.() || cfg.userBranchId || cfg.branchId || 'default';
  let searchData = { loaded: false, projects: [], contacts: [], customers: [] };
  let searchTimer = null;
  let searchRequest = null;
  let searchSequence = 0;
  const searchResultCache = new Map();
  const enabledSearchTypes = new Set((window.FirstMateArtifactSearch?.TYPES || []).map((type) => type.id));
  let notificationTimer = null;

  function $(sel){ return document.querySelector(sel); }
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function notificationMenus(){
    return Array.from(document.querySelectorAll('#platformNotificationMenu, #mobilePlatformNotificationMenu'));
  }

  function notificationLoadOptions(options = {}){
    return { branchId:branchId(), includeDismissed:true, ...options };
  }

  function wait(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // A phone sheet slides away first (its observer then leaves the top layer); a dropdown hides at once.
  function hideMenu(menu){
    menu.classList.remove('visible');
    if (menu.classList.contains('ptb-menu--sheet')) return;
    if (menu.hidePopover && menu.matches(':popover-open')) menu.hidePopover();
  }

  function closeNotificationMenus(){
    notificationMenus().forEach(hideMenu);
    document.body.classList.remove('mobile-notifications-open');
  }

  function showNotificationMenu(menu, bell){
    if (!menu || !bell) return;
    // On phones messages and notifications are bottom sheets, like the project window's trays.
    if (menu.classList.contains('ptb-menu--sheet')) { presentSheet(menu); return; }
    let rect = bell.getBoundingClientRect();
    // On phones these bells are folded into the More button; open under it.
    if (!rect.width && !rect.height) rect = $('#mobilePlatformMoreBtn')?.getBoundingClientRect() || rect;
    Object.assign(menu.style, {position:'fixed', margin:'0', inset:'auto', top:`${Math.min(rect.bottom + 8, innerHeight - 100)}px`, right:'12px', left:'auto', width:'min(380px, calc(100vw - 24px))', maxHeight:`${Math.max(90, innerHeight - rect.bottom - 24)}px`, zIndex:'2147483647'});
    menu.classList.add('visible');
    // The browser's top layer escapes every app/window stacking context.
    if (menu.showPopover) { menu.popover = 'manual'; menu.showPopover(); }
    else document.body.append(menu);
  }
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#platformNotificationMenu,#mobilePlatformNotificationMenu,#platformBell,#mobilePlatformBell,#mobilePlatformMoreNotifications')) closeNotificationMenus();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeNotificationMenus(); closeMessagesMenus(); closeMoreMenu(); closePhoneSheets(); closePhoneAgent(); } });

  function setMobileNotificationsVisible(visible){
    const mobileTopbar = $('.mobile-topbar');
    const notifications = $('#mobilePlatformNotifications');
    const more = $('#mobilePlatformMoreSlot');
    mobileTopbar?.classList.toggle('topbar-enabled', !!visible);
    if (notifications) notifications.hidden = !visible;
    if (more) more.hidden = !visible;
  }

  // --- Mobile consolidated "More" sheet -------------------------------------
  // On phones every desktop top bar action (assistant, to-do, phone, messages,
  // notifications, development tools) collapses into one button whose bottom
  // sheet proxies to the real controls. Each item is shown exactly when its
  // desktop control is, so phone and desktop offer the same entries.
  // Scripts that add an item prepend a `.ptb-more-item` to the menu; it is
  // filed into the group named by its `data-more-group` (default "tools").

  const MORE_GROUPS = { mobilePlatformMoreAssistant:'work', mobilePlatformMoreTodos:'work', mobilePlatformMoreMessages:'inbox', mobilePlatformMoreNotifications:'inbox', mobilePlatformMorePhone:'inbox' };
  const MORE_ORDER = ['mobilePlatformMoreAssistant', 'mobilePlatformMoreTodos', 'mobilePlatformMoreMessages', 'mobilePlatformMoreNotifications', 'mobilePlatformMorePhone'];
  let moreReturnFocus = null;

  function fileMoreItems(){
    const menu = $('#mobilePlatformMoreMenu');
    if (!menu) return;
    menu.querySelectorAll(':scope > .ptb-more-item, :scope > .ptb-sheet > .ptb-more-item').forEach((item) => {
      const group = menu.querySelector(`[data-more-group="${item.dataset.moreGroup || MORE_GROUPS[item.id] || 'tools'}"]`)
        || menu.querySelector('[data-more-group="tools"]');
      if (!group) return;
      const rank = MORE_ORDER.indexOf(item.id);
      const before = rank < 0 ? null : [...group.children].find((other) => MORE_ORDER.indexOf(other.id) > rank || MORE_ORDER.indexOf(other.id) < 0);
      group.insertBefore(item, before || null);
    });
  }

  function moreMenuOpen(){
    return $('#mobilePlatformMoreMenu')?.classList.contains('visible') === true;
  }

  // Where the More menu opens on phones is the organization's topbar.phone_menu: "bottom" (the default) is a
  // sheet from the bottom, "top" a dropdown at the top right. What it opens slides up from the bottom either way.
  function moreMenuPlacement(){
    const capabilities = window.Portal?.capabilities || window.PlatformAPI?.capabilities;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    const value = capabilities?.current?.()
      ? capabilities.value?.('topbar.phone_menu', 'bottom')
      : (flags?.current?.() ? flags.value?.('topbar', 'phone_menu', 'bottom') : 'bottom');
    return value === 'top' ? 'top' : 'bottom';
  }

  function openMoreMenu(){
    const menu = $('#mobilePlatformMoreMenu');
    if (!menu) return;
    fileMoreItems();
    syncMoreMenu();
    const placement = moreMenuPlacement();
    menu.dataset.placement = placement;
    if (placement === 'top') {
      const rect = $('#mobilePlatformMoreBtn')?.getBoundingClientRect();
      menu.style.setProperty('--ptb-more-top', `${Math.round((rect?.bottom || 52) + 6)}px`);
    }
    presentSheet(menu);
    moreReturnFocus = $('#mobilePlatformMoreBtn');
    moreReturnFocus?.setAttribute('aria-expanded', 'true');
    menu.querySelector('.ptb-more-item:not([hidden])')?.focus({ preventScroll:true });
  }

  // Other scripts close the sheet by removing `visible` (todo-tray.js); its
  // observer finishes that close the same way.
  function moreClosing(){
    const menu = $('#mobilePlatformMoreMenu');
    const button = $('#mobilePlatformMoreBtn');
    button?.setAttribute('aria-expanded', 'false');
    if (menu?.contains(document.activeElement)) button?.focus({ preventScroll:true });
  }

  function closeMoreMenu(){
    $('#mobilePlatformMoreMenu')?.classList.remove('visible');
  }

  function installMoreSheet(){
    const menu = $('#mobilePlatformMoreMenu');
    if (!menu || menu.dataset.moreReady) return;
    menu.dataset.moreReady = '1';
    menu.classList.add('ptb-menu--sheet');
    fileMoreItems();
    new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList')) fileMoreItems();
    }).observe(menu, { childList:true });
    // Item visibility follows the desktop controls whenever they change.
    const mirrored = ['#mobilePlatformAssistantSlot', '#mobilePlatformMessagesSlot', '#platformPhoneSlot'].map($).filter(Boolean);
    const mirror = new MutationObserver(() => syncMoreMenu());
    mirrored.forEach((slot) => mirror.observe(slot, { attributes:true, attributeFilter:['hidden'] }));
    installSheet(menu, { onClosing:moreClosing });
  }

  // --- Phone sheets -----------------------------------------------------------
  // On a phone (the portal at 820px or narrower) the More sheet and everything it
  // opens (messages, notifications, To Do, development tools) are bottom sheets in
  // the browser's top layer, one at a time, as the project window's trays are; the
  // assistant is the project window's agent bar (below). A sheet is a
  // `.ptb-menu--sheet` whose `.ptb-sheet` slides up while it has `visible`.
  // Removing `visible`, here or from another script, slides it away and then takes
  // it out of the top layer. Other scripts get one from Portal.topbar.phoneSheet.

  const SHEET_LEAVE_MS = 320;
  const sheetTimers = new WeakMap();
  const phoneLayout = () => window.matchMedia?.('(max-width: 820px)')?.matches === true;
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const phrase = (key, fallback) => globalThis.PlatformLanguage?.text?.('platform', key, fallback) ?? fallback;

  function phoneSheets(){
    return Array.from(document.querySelectorAll('.ptb-menu--sheet'));
  }

  function closePhoneSheets(except){
    phoneSheets().forEach((menu) => { if (menu !== except) menu.classList.remove('visible'); });
  }

  function presentSheet(menu){
    if (!menu) return;
    closePhoneSheets(menu);
    // Another tray puts the assistant bar away, as in the project window; the More menu sits over it, and a
    // live voice conversation keeps it.
    if (menu.classList.contains('ptb-menu--panel') && !phoneAgent?.voice) closePhoneAgent();
    clearTimeout(sheetTimers.get(menu));
    menu.style.removeProperty('--ptb-sheet-drag');
    // The browser's top layer escapes every app/window stacking context.
    if (menu.showPopover && !menu.matches(':popover-open')) { menu.popover = 'manual'; menu.showPopover(); }
    void menu.offsetHeight;
    menu.classList.add('visible');
    if (menu.classList.contains('ptb-menu--panel')) menu.querySelector('.ptb-sheet-close')?.focus({ preventScroll:true });
  }

  function installSheet(menu, options = {}){
    if (!menu || menu.dataset.sheetReady) return;
    menu.dataset.sheetReady = '1';
    new MutationObserver((records) => {
      const wasOpen = records.some((record) => /(^|\s)visible(\s|$)/.test(record.oldValue || ''));
      if (!wasOpen || menu.classList.contains('visible')) return;
      clearTimeout(sheetTimers.get(menu));
      // Focus leaves a closing panel for the More button it was opened from.
      if (menu.classList.contains('ptb-menu--panel') && menu.contains(document.activeElement)) $('#mobilePlatformMoreBtn')?.focus({ preventScroll:true });
      options.onClosing?.();
      sheetTimers.set(menu, setTimeout(() => {
        if (menu.classList.contains('visible')) return;
        menu.style.removeProperty('--ptb-sheet-drag');
        if (menu.hidePopover && menu.matches(':popover-open')) menu.hidePopover();
        options.onClosed?.();
      }, reducedMotion() ? 0 : SHEET_LEAVE_MS));
    }).observe(menu, { attributes:true, attributeFilter:['class'], attributeOldValue:true });
    menu.addEventListener('click', (event) => {
      if (event.target.closest('[data-more-close]')) { event.stopPropagation(); menu.classList.remove('visible'); }
    });
    // Drag the sheet down to dismiss it: anywhere on a menu that is not scrolled,
    // by its grip or title on a panel (whose body scrolls). A dropdown is not dragged.
    const sheet = menu.querySelector('.ptb-sheet');
    const panel = menu.classList.contains('ptb-menu--panel');
    let drag = null;
    let suppressClick = false;
    sheet?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || menu.dataset.placement === 'top' || event.target.closest('.ptb-sheet-close')) return;
      if (panel ? !event.target.closest('.ptb-sheet-grip,.ptb-sheet-head') : (sheet.scrollTop > 0 && !event.target.closest('.ptb-sheet-grip'))) return;
      drag = { id:event.pointerId, y:event.clientY, dy:0, moved:false };
    });
    sheet?.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dy = Math.max(0, event.clientY - drag.y);
      if (!drag.moved && drag.dy > 8) { drag.moved = true; menu.classList.add('is-dragging'); try { sheet.setPointerCapture(event.pointerId); } catch (_) {} }
      if (drag.moved) menu.style.setProperty('--ptb-sheet-drag', `${drag.dy}px`);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { dy, moved } = drag;
      drag = null;
      menu.classList.remove('is-dragging');
      if (!moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (dy > Math.min(120, sheet.offsetHeight * 0.3)) menu.classList.remove('visible');
      else menu.style.removeProperty('--ptb-sheet-drag');
    };
    sheet?.addEventListener('pointerup', endDrag);
    sheet?.addEventListener('pointercancel', endDrag);
    // A drag that moved must not also tap the item under the finger.
    sheet?.addEventListener('click', (event) => {
      if (suppressClick) { event.stopPropagation(); event.preventDefault(); }
    }, true);
  }

  // Turns a top bar menu (a `.ptb-menu-head` and its list) into a panel sheet:
  // a grip, the head beside a Close button, and the rest in a scrolling body.
  function sheetify(menu, options = {}){
    if (!menu) return null;
    if (!menu.classList.contains('ptb-menu--sheet')) {
      let head = menu.querySelector(':scope > .ptb-menu-head');
      if (!head) { head = document.createElement('div'); head.className = 'ptb-menu-head'; head.textContent = cleanText(options.label); }
      const rest = [...menu.childNodes].filter((node) => node !== head);
      const scrim = document.createElement('div'); scrim.className = 'ptb-sheet-scrim'; scrim.dataset.moreClose = '';
      const grip = document.createElement('div'); grip.className = 'ptb-sheet-grip'; grip.setAttribute('aria-hidden', 'true');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'ptb-sheet-close'; close.dataset.moreClose = '';
      close.setAttribute('aria-label', phrase('ptb_sheet_close', 'Close'));
      close.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i>';
      const top = document.createElement('div'); top.className = 'ptb-sheet-head'; top.append(head, close);
      const body = document.createElement('div'); body.className = 'ptb-sheet-body'; body.append(...rest);
      const sheet = document.createElement('div'); sheet.className = 'ptb-sheet'; sheet.append(grip, top, body);
      menu.replaceChildren(scrim, sheet);
      menu.classList.add('ptb-menu--sheet', 'ptb-menu--panel');
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-label', cleanText(options.label) || cleanText(head.textContent));
    }
    installSheet(menu, options);
    return menu;
  }

  // A bottom sheet for something else in the top bar on a phone (To Do, development tools):
  // { element, body, open(), close(), isOpen() }. onClosing runs as it starts to slide away,
  // onClosed once it has. Null without the phone top bar.
  function phoneSheet({ id, label:title, onClosing, onClosed } = {}){
    const host = $('.mobile-topbar');
    const key = cleanText(id);
    if (!host || !key) return null;
    let menu = document.getElementById(key);
    if (!menu) { menu = document.createElement('div'); menu.id = key; menu.className = 'ptb-menu'; host.append(menu); }
    sheetify(menu, { label:title, onClosing, onClosed });
    return {
      element: menu,
      body: menu.querySelector('.ptb-sheet-body'),
      open: () => presentSheet(menu),
      close: () => menu.classList.remove('visible'),
      isOpen: () => menu.classList.contains('visible')
    };
  }

  function installPhoneSheets(){
    sheetify($('#mobilePlatformMessagesMenu'));
    sheetify($('#mobilePlatformNotificationMenu'));
    window.addEventListener('resize', () => {
      if (phoneLayout()) return;
      closePhoneSheets();
      closePhoneAgent();
    }, { passive:true });
  }

  // --- Phone assistant: the project window's agent bar ------------------------
  // On a phone the assistant slides up from the bottom as the project window's
  // Agent does: the same bar (FirstMateAgentBar, project-trays.js) with its
  // conversation folded above the input, in the person's main conversation.
  // Desktop keeps the assistant window.
  let phoneAgent = null;

  function phoneAgentAvailable(){
    return !!window.FirstMateAgentBar?.create && !!window.FirstMateAgentBar.css && typeof window.PlatformAssistant?.mountSurface === 'function';
  }

  function phoneAgentOpen(){
    return phoneAgent?.host.dataset.trayOpen === 'true';
  }

  function phoneAgentBar(){
    if (phoneAgent) return phoneAgent;
    if (!phoneAgentAvailable()) return null;
    const style = document.createElement('style');
    style.id = 'ptbAgentBarStyle';
    style.textContent = `.ptb-agent-host{position:fixed;left:0;right:0;top:0;height:var(--fm-visual-vh,100dvh);z-index:2147483000;pointer-events:none}
.ptb-agent-host>.ptb-agent-bar{display:flex;flex-direction:column;pointer-events:auto}
.ptb-agent-panel{display:flex;flex-direction:column;min-height:0}
@media (min-width:821px){.ptb-agent-host{display:none}}
${window.FirstMateAgentBar.css({ host:'.ptb-agent-host', bar:'.ptb-agent-bar', panel:'.ptb-agent-panel' })}`;
    document.head.append(style);
    const host = document.createElement('div');
    host.className = 'ptb-agent-host';
    host.dataset.agentCompact = 'true';
    host.dataset.trayOpen = 'false';
    const element = document.createElement('aside');
    element.className = 'ptb-agent-bar';
    element.dataset.agentCompact = 'true';
    element.setAttribute('aria-label', phrase('ptb_agent_bar', 'AI Assistant'));
    element.inert = true;
    const panel = document.createElement('div');
    panel.className = 'ptb-agent-panel';
    element.append(panel);
    host.append(element);
    document.body.append(host);
    const agent = { host, element, panel, surface:null, voice:false, controller:null };
    agent.sync = () => agent.controller?.update(element, { open:host.dataset.trayOpen === 'true', voice:agent.voice });
    agent.controller = window.FirstMateAgentBar.create({ drawer:() => panel.querySelector('.fma-drawer'), sync:agent.sync });
    phoneAgent = agent;
    return agent;
  }

  function openPhoneAgent(){
    const agent = phoneAgentBar();
    if (!agent) return false;
    closePhoneSheets();
    if (!agent.surface) {
      agent.surface = window.PlatformAssistant.mountSurface(agent.panel, {
        orgId:orgId(),
        onClose:closePhoneAgent,
        onTurn:(phase) => agent.controller.turn(phase),
        onState:(state) => { agent.voice = !!state?.voice; agent.sync(); }
      });
      Promise.resolve(agent.surface?.ready).then(() => agent.sync()).catch(() => null);
    } else {
      agent.surface.refresh?.();
    }
    agent.element.inert = false;
    agent.host.dataset.trayOpen = 'true';
    agent.sync();
    return true;
  }

  function closePhoneAgent(){
    if (!phoneAgentOpen()) return;
    // As the assistant window's Close does, putting it away ends a voice conversation.
    phoneAgent.surface?.endVoice?.();
    phoneAgent.host.dataset.trayOpen = 'false';
    phoneAgent.element.inert = true;
    phoneAgent.sync();
  }

  // `reveal` (the More menu's entry) only opens it; the top bar button toggles it.
  function toggleAssistant({ reveal = false } = {}){
    if (phoneLayout() && phoneAgentAvailable()) {
      if (phoneAgentOpen() && !reveal) closePhoneAgent();
      else if (!phoneAgentOpen()) openPhoneAgent();
      return;
    }
    window.PlatformAssistant?.toggle?.();
  }

  function syncMoreMenu(){
    const assistantItem = $('#mobilePlatformMoreAssistant');
    const messagesItem = $('#mobilePlatformMoreMessages');
    const phoneItem = $('#mobilePlatformMorePhone');
    if (assistantItem) assistantItem.hidden = $('#mobilePlatformAssistantSlot')?.hidden === true;
    if (messagesItem) messagesItem.hidden = $('#mobilePlatformMessagesSlot')?.hidden === true;
    if (phoneItem) phoneItem.hidden = $('#platformPhoneSlot')?.hidden !== false;
    const messagesCount = Number(messagesInbox.unread_total || 0);
    const notificationText = cleanText($('#mobilePlatformNotificationCount')?.textContent);
    const notificationVisible = $('#mobilePlatformNotificationCount')?.classList.contains('visible') === true;
    const notificationCount = notificationVisible ? (Number(notificationText.replace('+', '')) || 0) : 0;
    const setCount = (selector, count) => {
      const badge = $(selector);
      if (!badge) return;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count <= 0;
    };
    setCount('#mobilePlatformMoreMessagesCount', messagesCount);
    setCount('#mobilePlatformMoreNotificationCount', notificationCount);
    const total = messagesCount + notificationCount;
    const totalBadge = $('#mobilePlatformMoreCount');
    if (totalBadge) {
      totalBadge.textContent = total > 99 ? '99+' : String(total);
      totalBadge.classList.toggle('visible', total > 0);
      totalBadge.closest('.ptb-bell')?.classList.toggle('has-unread', total > 0);
    }
  }

  function setTopbarVisible(visible){
    const topbar = $('#platformTopbar');
    if (topbar) topbar.style.display = visible ? '' : 'none';
    lastTopbarVisible = visible !== false;
    setMobileNotificationsVisible(visible);
    updateAssistantVisibility(visible);
    updateMessagesVisibility();
    window.dispatchEvent(new CustomEvent('fm:platform-topbar-visibility', { detail:{ visible:isTopbarVisible() } }));
  }

  let lastTopbarVisible = true;
  let leftSlotOwner = '';

  function isTopbarVisible(){
    const topbar = $('#platformTopbar');
    if (!topbar || !lastTopbarVisible) return false;
    return window.getComputedStyle(topbar).display !== 'none';
  }

  function mountTopbarLeft(owner, node){
    const slot = $('#platformTopbarAppLeft');
    const ownerId = cleanText(owner);
    if (!slot || !ownerId || !(node instanceof Node) || !isTopbarVisible()) return false;
    if (leftSlotOwner !== ownerId || slot.firstChild !== node || slot.childNodes.length !== 1) slot.replaceChildren(node);
    leftSlotOwner = ownerId;
    slot.dataset.owner = ownerId;
    return true;
  }

  function releaseTopbarLeft(owner){
    const slot = $('#platformTopbarAppLeft');
    const ownerId = cleanText(owner);
    if (!slot || (ownerId && leftSlotOwner && ownerId !== leftSlotOwner)) return false;
    slot.replaceChildren();
    delete slot.dataset.owner;
    leftSlotOwner = '';
    return true;
  }

  window.Portal.topbar = {
    ...(window.Portal.topbar || {}),
    isVisible: isTopbarVisible,
    // The organization has the top bar on (desktop row or the phone bar's More sheet).
    isEnabled: () => lastTopbarVisible,
    mountLeft: mountTopbarLeft,
    releaseLeft: releaseTopbarLeft,
    leftOwner: () => leftSlotOwner,
    // Phones: whether the portal is in its phone layout, and a bottom sheet for a top bar action.
    isPhone: phoneLayout,
    phoneSheet
  };

  // --- Messages dropdown (personal channels inbox) --------------------------

  let messagesInbox = { entries: [], unread_total: 0 };
  let messagesGeneration = 0;

  function messagesAllowed(){
    try {
      if (window.Portal?.can && window.Portal?.capabilities?.can) return window.Portal.can('apps.channels') !== false && window.Portal.can('topbar.messages') !== false;
    } catch (_) {}
    return true;
  }

  function updateMessagesVisibility(){
    const allowed = lastTopbarVisible && messagesAllowed() && !!window.ChannelsAPI;
    const desktop = $('#platformMessagesSlot');
    const mobile = $('#mobilePlatformMessagesSlot');
    if (desktop) desktop.hidden = !allowed;
    if (mobile) mobile.hidden = !allowed;
    if (!allowed) {
      messagesGeneration++;
      closeMessagesMenus();
      messagesInbox = { entries: [], unread_total: 0 };
      renderMessagesBadge();
      renderMessagesList();
    }
    syncMoreMenu();
  }

  function messagesMenus(){
    return Array.from(document.querySelectorAll('#platformMessagesMenu, #mobilePlatformMessagesMenu'));
  }

  function closeMessagesMenus(){
    messagesMenus().forEach(hideMenu);
  }

  function renderMessagesBadge(){
    const count = Number(messagesInbox.unread_total || 0);
    ['#platformMessagesCount', '#mobilePlatformMessagesCount'].forEach((selector) => {
      const badge = $(selector);
      if (!badge) return;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.toggle('visible', count > 0);
      badge.closest('.ptb-bell')?.classList.toggle('has-unread', count > 0);
    });
  }

  const MESSAGE_KIND_META = {
    mention: { icon:'fa-at', label:(globalThis.PlatformLanguage?.text("platform","m_5e787a0581e68d","mentioned you") ?? "mentioned you") },
    dm: { icon:'fa-message', label:(globalThis.PlatformLanguage?.text("platform","m_e3cc894d04e408","sent you a message") ?? "sent you a message") },
    reply: { icon:'fa-reply', label:(globalThis.PlatformLanguage?.text("platform","m_68e3c79189e8dd","replied to you") ?? "replied to you") },
    reaction: { icon:'fa-face-smile', label:(globalThis.PlatformLanguage?.text("platform","m_a7e03e084a102a","reacted") ?? "reacted") },
    activity: { icon:'fa-message', label:'Channels update' },
    channel: { icon:'fa-hashtag', label:(globalThis.PlatformLanguage?.text("platform","m_4c04db54662b57","new messages") ?? "new messages") }
  };

  function messageEntryHtml(entry, index, groupedReaction = false){
    const meta = MESSAGE_KIND_META[entry.kind] || MESSAGE_KIND_META.channel;
    const who = escapeHtml(cleanText(entry.author?.name) || 'Someone');
    const line = entry.kind === 'activity' ? `<b>${escapeHtml(cleanText(entry.title) || 'Channels update')}</b>` : entry.kind === 'reaction'
      ? `<b>${who}</b> reacted ${escapeHtml(cleanText(entry.emoji))} to your message`
      : entry.kind === 'channel'
        ? `<b>${escapeHtml(cleanText(entry.channel_name))}</b> · ${Number(entry.count || 0)} new`
        : `<b>${who}</b> ${meta.label}`;
    return `
      <div class="ptb-msg-row ${entry.unread ? 'unread' : ''}" data-message-entry="${index}" role="button" tabindex="0">
        <span class="ptb-msg-ico">${entry.kind === 'reaction' ? `<span class="ptb-msg-reaction-emoji" aria-hidden="true">${escapeHtml(cleanText(entry.emoji))}</span>` : `<i class="fas ${meta.icon}"></i>`}</span>
        <span class="ptb-msg-main">
          <span class="ptb-msg-line">${line}</span>
          ${groupedReaction ? '' : `<span class="ptb-msg-snippet">${escapeHtml(cleanText(entry.text))}</span>
          <span class="ptb-msg-snippet" style="font-size:10.5px;color:#98a2b3;font-weight:700">${escapeHtml(cleanText(entry.channel_name))}</span>`}
        </span>
        <span class="ptb-msg-meta">
          <span>${escapeHtml(timeAgoLabel(entry.at))}</span>
          ${entry.unread ? '<span class="ptb-msg-dot"></span>' : ''}
        </span>
      </div>
    `;
  }

  function timeAgoLabel(iso){
    const time = new Date(String(iso || '')).getTime();
    if (!Number.isFinite(time)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  const openedMessageEntries = new Set();
  async function openMessageEntry(entry){
    if (openedMessageEntries.has(entry.entry_id)) return;
    openedMessageEntries.add(entry.entry_id);
    closeMessagesMenus();
    renderMessagesList();
    try {
      if (cleanText(entry.photo_id) && cleanText(entry.project_id)) {
        window.Portal?.navigation?.navigate?.({project:cleanText(entry.project_id),projectTab:'photos',projectNote:null,photo:cleanText(entry.photo_id),photoScope:'project'}, {source:'messages-inbox',ownedKeys:['project','projectTab','projectNote','photo','photoScope']});
        await window.Portal?.navigation?.applyCurrent?.();
      } else if (entry.channel_type === 'project' && cleanText(entry.project_id)) {
        window.Portal?.navigation?.navigate?.({project:cleanText(entry.project_id), projectTab:'materials', projectNote:cleanText(entry.kind === 'activity' ? entry.related_message_id : entry.message_id) || null}, {source:'messages-inbox'});
        await window.Portal?.navigation?.applyCurrent?.();
      } else {
        const detail = {channel_id:cleanText(entry.channel_id), message_id:cleanText(entry.kind === 'activity' ? entry.related_message_id : entry.message_id), parent_id:cleanText(entry.parent_id), huddle_id:cleanText(entry.huddle_id)};
        if (window.FirstMateChannelsNavigation?.openMessage) {
          if (await window.FirstMateChannelsNavigation.openMessage(detail) === false) throw new Error('This conversation could not be opened.');
        } else {
          window.Portal?.navigation?.navigate?.({tab:'channels', channel:detail.channel_id, channelThread:detail.parent_id || null, channelMessage:detail.message_id || null}, {source:'messages-inbox',ownedKeys:['tab','channel','channelThread','channelMessage']});
          await window.Portal?.navigation?.applyCurrent?.();
        }
      }
      await window.ChannelsAPI.readState.inboxRead(orgId(), entry);
      await loadMessagesInbox();
    } catch (error) {
      openedMessageEntries.delete(entry.entry_id);
      await loadMessagesInbox();
      window.Portal?.ui?.showToast?.('Could not open message', error.message);
    }
  }

  function messageInboxHtml(entries){
    const groups = new Map();
    entries.forEach((entry, index) => {
      if (entry.kind !== 'reaction') return;
      const key = JSON.stringify([entry.channel_id, entry.message_id]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({entry, index});
    });
    const rendered = new Set();
    return entries.map((entry, index) => {
      if (entry.kind !== 'reaction') return messageEntryHtml(entry, index);
      const key = JSON.stringify([entry.channel_id, entry.message_id]);
      if (rendered.has(key)) return '';
      rendered.add(key);
      const group = groups.get(key);
      const preview = cleanText(entry.text) || 'Attachment or media message';
      return `<section class="ptb-msg-reaction-group" aria-label="Reactions to your message">
        <div class="ptb-msg-reaction-context"><strong>${group.length} ${group.length === 1 ? 'reaction' : 'reactions'} to your message</strong>
        <blockquote>${escapeHtml(preview)}</blockquote><small>${escapeHtml(cleanText(entry.channel_name))}</small></div>
        ${group.map(item => messageEntryHtml(item.entry, item.index, true)).join('')}
      </section>`;
    }).join('');
  }

  function renderMessagesList(){
    ['#platformMessagesList', '#mobilePlatformMessagesList'].forEach((selector) => {
      const list = $(selector);
      if (!list) return;
      const entries = (messagesInbox.entries || []).filter(entry => !openedMessageEntries.has(entry.entry_id));
      list.innerHTML = entries.length
        ? messageInboxHtml(entries)
        : `<div class="ptb-empty">${(globalThis.PlatformLanguage?.htmlText("platform","m_56ea1e42b41667","No messages need your attention.") ?? "No messages need your attention.")}<br>${(globalThis.PlatformLanguage?.htmlText("platform","m_fcc1bb46a8b161","Mentions, DMs, replies, and reactions land here.") ?? "Mentions, DMs, replies, and reactions land here.")}</div>`;
      list.querySelectorAll('[data-message-entry]').forEach((row) => {
        const open = () => {
          const entry = entries[Number(row.dataset.messageEntry)];
          if (entry) openMessageEntry(entry);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      });
    });
  }

  async function loadMessagesInbox(){
    if (!window.ChannelsAPI?.readState?.inbox || !orgId() || !messagesAllowed()) return;
    const generation = messagesGeneration;
    try {
      const data = await window.ChannelsAPI.readState.inbox(orgId());
      if (generation !== messagesGeneration || !messagesAllowed()) return;
      const entries = (data.entries || []).filter(entry => !openedMessageEntries.has(entry.entry_id));
      messagesInbox = { entries, unread_total: entries.reduce((sum, entry) => sum + (entry.unread ? Math.max(1, Number(entry.count || 1)) : 0), 0) };
      renderMessagesBadge();
      renderMessagesList();
    } catch (_) {}
  }

  function assistantAllowed(){
    try {
      if (window.Portal?.can && window.Portal?.capabilities?.can) return window.Portal.can('apps.assistant') !== false;
    } catch (_) {}
    return true;
  }

  function updateAssistantVisibility(topbarVisible){
    if (topbarVisible !== undefined) lastTopbarVisible = topbarVisible !== false;
    const allowed = lastTopbarVisible && assistantAllowed();
    const desktop = $('#platformAssistantSlot');
    const mobile = $('#mobilePlatformAssistantSlot');
    if (desktop) desktop.hidden = !allowed;
    if (mobile) mobile.hidden = !allowed;
    if (!allowed) closePhoneAgent();
  }

  async function topbarEnabled(){
    if (!orgId()) return false;
    if (!window.PlatformAPI?.appFlags?.current?.()) {
      await window.Portal?.appFlags?.load?.().catch(() => null);
    }
    const current = window.PlatformAPI?.appFlags?.current?.();
    if (!current) return false;
    return !!window.PlatformAPI?.appFlags?.has?.('platform', 'top_bar');
  }

  async function loadSearchData(){
    if (searchData.loaded || !window.PlatformAPI || !orgId()) return searchData;
    const customerPromise = window.PlatformAPI.customers?.list
      ? window.PlatformAPI.customers.list(orgId()).catch(() => ({ documents: [] }))
      : Promise.resolve({ documents: [] });
    const [projectResult, customerResult] = await Promise.all([
      window.PlatformAPI.projects.list(orgId()).catch(() => ({ documents: [] })),
      customerPromise,
    ]);
    const projects = (projectResult.documents || []).map((doc) => {
      const data = doc?.data && typeof doc.data === 'object' ? doc.data : {};
      const id = firstText(data.platform_project_id, data.base_project_id, data.id, doc?.id);
      return { id, ...data, id, _type: 'project' };
    });
    const customers = (customerResult.documents || []).map((doc) => ({ id: doc.id, ...(doc.data || {}), _type: 'customer' }));
    const contacts = projects.flatMap((project) => {
      const rows = Array.isArray(project.contacts) ? project.contacts : [];
      const embedded = rows.map((contact, index) => ({
        id: `${project.id || 'project'}:${index}`,
        project_id: project.id,
        project,
        name: contact?.name || '',
        email: contact?.email || '',
        phone: contact?.phone || '',
        address: contact?.address || contact?.default_address || project.contact_address || project.customer_address || project.primary_contact_address || '',
        _type: 'contact'
      })).filter((contact) => contact.name || contact.email || contact.phone);
      const aliases = [{
        id: `${project.id || 'project'}:primary`,
        project_id: project.id,
        project,
        name: firstText(project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : ''),
        email: firstText(project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail),
        phone: firstText(project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone),
        address: firstText(project.contact_address, project.customer_address, project.primary_contact_address, project.workflow_state === 'contact_only' ? project.address : ''),
        _type: 'contact'
      }].filter((contact) => contact.name || contact.email || contact.phone);
      return [...embedded, ...aliases];
    });
    const customerContacts = customers.map((customer) => ({
      id: `customer:${customer.id}`,
      customer,
      project_id: firstText(customer.primary_project_id, customer.project_id, Array.isArray(customer.project_ids) ? customer.project_ids[0] : ''),
      project_ids: Array.isArray(customer.project_ids) ? customer.project_ids : [],
      name: customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || customer.default_address || '',
      _type: 'customer'
    })).filter((contact) => contact.name || contact.email || contact.phone);
    searchData = {
      loaded: true,
      projects,
      contacts: [...contacts, ...customerContacts],
      customers,
    };
    return searchData;
  }

  function openProject(project, options = {}){
    if (!project?.id) return;
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project, options);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project, ...options } }));
  }

  async function openContact(contact = {}){
    if (window.Portal.modules?.contacts?.open) {
      window.Portal.modules.contacts.open(contact, {
        projects: contact.project?.id ? [contact.project] : []
      });
      return;
    }
    if (contact.project?.id) {
      openProject(contact.project);
      return;
    }
    const ids = [
      contact.project_id,
      contact.primary_project_id,
      ...(Array.isArray(contact.project_ids) ? contact.project_ids : [])
    ].map(cleanText).filter(Boolean);
    const local = searchData.projects.find((project) => ids.includes(cleanText(project.id)));
    if (local) {
      openProject(local);
      return;
    }
    const matched = searchData.projects.find((project) => {
      const haystack = contactNeedlesForProject(project);
      return [contact.name, contact.email, contact.phone]
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean)
        .some((value) => haystack.includes(value));
    });
    if (matched) {
      openProject(matched);
      return;
    }
    const id = ids[0];
    if (id && window.PlatformAPI?.projects?.get) {
      const result = await window.PlatformAPI.projects.get(orgId(), id).catch(() => null);
      const data = result?.document?.data;
      if (data) openProject({ id, ...data });
    }
  }

  function contactNeedlesForProject(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    return [
      project.customer_name,
      project.customerName,
      project.primary_contact_name,
      project.customer_email,
      project.primary_contact_email,
      project.customer_phone,
      project.primary_contact_phone,
      project.resident_name,
      project.residentName,
      typeof project.resident === 'string' ? project.resident : '',
      ...contacts.flatMap((contact) => [contact?.name, contact?.email, contact?.phone])
    ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  function projectSearchText(project = {}){
    return [
      project.address,
      project.project_address,
      project.property_address,
      project.title,
      project.project_title,
      project.project_name,
      project.projectName,
      project.name,
      project.project_type,
      project.stage,
      project.stage_id,
      project.status,
      contactNeedlesForProject(project)
    ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  function contactSearchText(contact = {}){
    return [contact.name, contact.email, contact.phone].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  // A new-lead notification says so in its context (the lead.received rules set
  // context.lead_source); what a click opens is only its frontend_action.
  function isLeadNotification(item = {}){
    return !!String(item.context?.lead_source || '').trim();
  }

  function leadTitle(item = {}){
    return item.title || (globalThis.PlatformLanguage?.text("platform","m_8afbfeae955a57","Notification") ?? "Notification");
  }

  // `project_tab` names the project window tab to open; "overview" is the map tab.
  function notificationProjectTab(action = {}){
    const tab = String(action.project_tab || action.projectTab || '').trim();
    return tab === 'overview' ? 'map' : tab;
  }

  async function openNotificationProject(item = {}){
    const action = item.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    // With no click action, a notification about a project opens that project.
    const projectId = String(action.project_id || action.projectId || (!action.kind ? item.context?.project_id || item.data?.project_id : '') || '').trim();
    if (!projectId || !window.PlatformAPI?.projects?.get || !orgId()) return false;
    try {
      const result = await window.PlatformAPI.projects.get(orgId(), projectId);
      const data = result?.document?.data || null;
      if (!data) return false;
      const project = { id: projectId, ...data };
      const tab = notificationProjectTab(action);
      openProject(project, tab ? { tab } : {});
      searchData.loaded = false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function notificationOpensProject(item = {}){
    const action = item.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    return String(action.kind || '').trim() === 'open_project' && !!String(action.project_id || action.projectId || '').trim();
  }

  async function openMeasurementReportNotification(item = {}){
    const action = item.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if (action.kind !== 'open_measurement_report') return false;
    const projectId = String(action.project_id || item.context?.project_id || '').trim();
    window.Portal?.navigation?.navigate?.({ tab:'viewer' }, { source:'measurement-notification' });
    await window.Portal?.modules?.viewer?.refresh?.(true);
    if (projectId) window.Portal?.modules?.viewer?.openProjectById?.(projectId);
    return true;
  }

  function mentionNotificationRoute(item = {}){
    if (String(item?.kind || '').toLowerCase() !== 'mention') return null;
    const action = item.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    const context = item.context && typeof item.context === 'object' ? item.context : {};
    const comment = context.comment && typeof context.comment === 'object' ? context.comment : {};
    const source = cleanText(action.kind || context.mention_source || item.source || context.kind).toLowerCase();
    const projectId = firstText(action.project_id, action.projectId, context.project_id, context.projectId);
    if (!projectId) return null;
    if (source === 'open_project_photo' || source === 'photo_comment') {
      const photoId = firstText(action.photo_id, action.photoId, context.media_id, context.mediaId, context.photo_id, context.photoId);
      return photoId
        ? { project:projectId, projectTab:'photos', projectNote:null, photo:photoId, photoScope:'project' }
        : { project:projectId, projectTab:'photos', projectNote:null, photo:null, photoScope:null };
    }
    if (source === 'open_project_note' || source === 'project_note' || source === 'open_project_message' || source === 'project_message') {
      const noteId = firstText(action.message_id, action.messageId, action.note_id, action.noteId, context.message_id, context.note_id, context.noteId, comment.id);
      return {
        project:projectId,
        projectTab:firstText(action.project_tab, action.projectTab, context.project_tab, context.projectTab, 'materials'),
        projectNote:noteId || null,
        photo:null,
        photoScope:null
      };
    }
    return { project:projectId };
  }

  function openChannelMessageNotification(item = {}){
    const action = item?.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if (String(action.kind || '').trim() !== 'open_channel_message') return false;
    const channelId = String(action.channel_id || item?.context?.channel_id || '').trim();
    if (!channelId) return false;
    const detail = {channel_id:channelId, message_id:String(action.message_id || '').trim(), parent_id:String(action.parent_id || '').trim()};
    if (window.FirstMateChannelsNavigation?.openMessage) void window.FirstMateChannelsNavigation.openMessage(detail);
    else window.dispatchEvent(new CustomEvent('fm:open-channel-message', {detail}));
    return true;
  }

  function openChatNotification(item = {}){
    const action = item?.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if (String(action.kind || '').trim() !== 'open_chat_conversation') return false;
    const conversationId = String(action.conversation_id || item?.context?.conversation_id || '').trim();
    window.Portal?.navigation?.navigate?.({ tab:'chat', chatConversation: conversationId || null }, {
      source:'notification-chat',
      ownedKeys:['chatConversation']
    });
    if (conversationId) window.dispatchEvent(new CustomEvent('fm:open-chat-conversation', { detail:{ conversation_id: conversationId } }));
    return true;
  }

  function openAssistantNotification(item = {}){
    const action = item?.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if (String(action.kind || '').trim() !== 'open_assistant' || !window.PlatformAssistant?.openConversation) return false;
    void window.PlatformAssistant.openConversation({ thread_id: String(action.thread_id || '').trim(), agent_id: String(action.agent_id || '').trim() });
    return true;
  }

  function openMerchantPortalNotification(item = {}){
    const action = item?.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if (String(action.kind || '').trim() !== 'open_merchant_portal') return false;
    // Open the tab synchronously (popup blockers), then point it at a freshly
    // minted single-use merchant-portal magic link.
    const win = window.open('about:blank', '_blank');
    (async () => {
      try {
        const result = await window.PaymentsAPI?.merchantPortal?.loginUrl?.(orgId());
        const loginUrl = String(result?.login_url || '').trim();
        if (loginUrl && win) win.location = loginUrl;
        else if (win) win.close();
      } catch (error) {
        if (win) win.close();
        window.PlatformUI?.showToast?.(error?.message || 'Could not open the merchant portal.');
      }
    })();
    return true;
  }

  async function openCommsNotification(item = {}){
    const action = item?.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    if(action.kind==='open_customer_call'){await window.Portal?.Communications?.open?.(action);return true;}
    if (String(action.kind || '').trim() !== 'open_project_comms') return false;
    const projectId = String(action.project_id || item?.context?.project_id || '').trim();
    if (!projectId) return false;
    const opened = await openNotificationProject({ frontend_action:{ ...action, kind:'open_project', project_id:projectId } });
    if (!opened) return false;
    const commsView = String(action.comms_view || '').trim() || 'overview';
    const conversationId = String(action.conversation_id || '').trim();
    window.Portal?.navigation?.navigate?.({
      project:projectId,
      projectTab:'comms',
      commsView,
      commsConversation:conversationId || null
    }, {
      source:'notification-comms',
      ownedKeys:['projectTab', 'commsView', 'commsConversation']
    });
    window.dispatchEvent(new CustomEvent('fm:open-project-comms', { detail:{
      project_id: projectId,
      comms_view: commsView,
      conversation_id: conversationId,
      auto_reply_id: String(action.auto_reply_id || '').trim()
    } }));
    return true;
  }

  function openMentionNotification(item = {}){
    const route = mentionNotificationRoute(item);
    if (!route || !window.Portal?.navigation?.navigate) return false;
    window.Portal.navigation.navigate(route, {
      source:'notification-mention',
      ownedKeys:['project', 'projectTab', 'projectNote', 'photo', 'photoScope']
    });
    return true;
  }

  function searchBoxForInput(input){
    return input?.closest?.('.platform-search')?.querySelector?.('.ptb-search-results') || $('#platformSearchResults');
  }

  function closeSearchResults(){
    document.querySelectorAll('.ptb-search-results.visible').forEach((box) => box.classList.remove('visible'));
  }

  async function projectForSearchResult(result = {}){
    const projectId = cleanText(result.project_id || result.id);
    if (!projectId) return null;
    const local = searchData.projects.find((project) => cleanText(project.id) === projectId);
    if (local) return local;
    if (window.PlatformAPI?.projects?.get) {
      const data = await window.PlatformAPI.projects.get(orgId(), projectId).catch(() => null);
      const doc = data?.document;
      if (doc?.data) return { id: doc.id || projectId, ...doc.data };
    }
    return { id: projectId, title: result.title || '', address: result.subtitle || '' };
  }

  async function openSearchResult(result = {}){
    if (result.type === 'contact') {
      const contact = {
        ...(result.contact || {}),
        id: result.id,
        project_id: result.project_id || result.contact?.project_id || '',
        project_ids: Array.isArray(result.contact?.project_ids) ? result.contact.project_ids : [],
        name: result.contact?.name || result.title || '',
        email: result.contact?.email || '',
        phone: result.contact?.phone || ''
      };
      await openContact(contact);
      return;
    }
    if (result.type === 'project') {
      const project = await projectForSearchResult(result);
      openProject(project);
      return;
    }
    window.FirstMateArtifactSearch?.open?.(result);
  }

  function resultIcon(type){
    return window.FirstMateArtifactSearch?.type?.(type)?.icon || 'fa-magnifying-glass';
  }

  function resultLabel(type){
    return window.FirstMateArtifactSearch?.type?.(type)?.singular || 'Result';
  }

  function searchFiltersHtml(){
    // Only the result types this organization has (FirstMateArtifactSearch.loadOffered).
    const types = window.FirstMateArtifactSearch?.available?.() || [];
    return `<div class="ptb-search-filterbar" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform","m_682192c2691773","Search result types") ?? "Search result types")}">
      <div class="ptb-search-filters">${String(types.map((type) => {
        const active = enabledSearchTypes.has(type.id);
        return `<button type="button" class="ptb-search-filter ${active ? 'active' : ''}" data-search-filter="${escapeHtml(type.id)}" aria-pressed="${active}"><i class="fas ${escapeHtml(type.icon)}" aria-hidden="true"></i>${escapeHtml(type.label)}</button>`;
      }).join(''))}</div>
    </div>`;
  }

  function bindSearchFilters(box, input){
    box.querySelectorAll('[data-search-filter]').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = button.dataset.searchFilter;
      if (enabledSearchTypes.has(type)) enabledSearchTypes.delete(type);
      else enabledSearchTypes.add(type);
      runSearch(input).catch(() => null);
    }));
  }

  // A search with no matching project offers, under No matches: order a report
  // for what was typed, a new project for it and a new contact for it. Each is
  // offered only to people who can use it where the organization has it on
  // (permissions and feature switches; never a configuration). Nothing is saved
  // until the person saves: the project window opens an unsaved draft and the
  // contact window a new, unsaved contact.
  const ADDRESS_MATCH_SRC = '/libraries/address-match/address-match.js?v=20261026-search-order-v1';
  let addressMatchLoading = null;

  function searchFeatureOn(group, flag, fallback){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return fallback;
    if (flags.has?.(group, flag)) return true;
    const value = flags.value?.(group, flag, undefined);
    return typeof value === 'boolean' ? value : fallback;
  }

  function searchCanCreate(){
    return document.documentElement.dataset.fmAssignedOnly !== 'true';
  }

  // Whoever can use the New button can start a project from a search that found none.
  function canStartProjectFromSearch(){
    return typeof window.Portal?.modules?.request?.open === 'function'
      && window.Portal?.util?.hasPerm?.('order_reports') === true
      && searchCanCreate();
  }

  function canOrderReportFromSearch(){
    return canStartProjectFromSearch() && searchFeatureOn('firstmeasure', 'report_orders', true);
  }

  function canCreateContactFromSearch(){
    return typeof window.Portal?.modules?.contacts?.open === 'function'
      && searchFeatureOn('platform', 'contacts', false)
      && window.Portal?.util?.hasPerm?.('manage_projects') === true
      && searchCanCreate();
  }


  function searchOfferRowHtml(kind, icon, label){
    return `
        <button type="button" class="ptb-search-item ptb-search-offer" data-search-offer="${escapeHtml(kind)}">
          <i class="fas ${escapeHtml(icon)} ptb-search-kind" aria-hidden="true"></i>
          <span><strong>${escapeHtml(label)}</strong></span>
        </button>
      `;
  }

  function searchOffersHtml(query){
    const rows = [];
    if (canOrderReportFromSearch()) rows.push(searchOfferRowHtml('report', 'fa-file-lines', ((v0) => globalThis.PlatformLanguage?.text("platform","search_offer_order_report",`Order a new report for "${v0}"`,{v0}) ?? `Order a new report for "${v0}"`)(query)));
    if (canStartProjectFromSearch()) rows.push(searchOfferRowHtml('project', 'fa-folder-plus', ((v0) => globalThis.PlatformLanguage?.text("platform","search_offer_new_project",`New project for "${v0}"`,{v0}) ?? `New project for "${v0}"`)(query)));
    if (canCreateContactFromSearch()) rows.push(searchOfferRowHtml('contact', 'fa-address-book', ((v0) => globalThis.PlatformLanguage?.text("platform","search_offer_new_contact",`New contact for "${v0}"`,{v0}) ?? `New contact for "${v0}"`)(query)));
    return rows.join('');
  }

  function ensureSearchOfferStyles(){
    if (document.getElementById('ptbSearchOfferStyles')) return;
    const style = document.createElement('style');
    style.id = 'ptbSearchOfferStyles';
    style.textContent = `
      .ptb-search-offers-label{padding:10px 12px 4px;font-size:11px;font-weight:900;color:#667085}
      .ptb-search-item.ptb-search-offer .ptb-search-kind{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .ptb-search-item.ptb-search-offer strong{white-space:normal;overflow-wrap:anywhere}
      .ptb-search-item:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px;background:#f8fafc}
      .ptb-search-item.ptb-search-offer[aria-busy="true"]{opacity:.65;cursor:progress}
      .mobile-platform-search .ptb-search-item.ptb-search-offer{min-height:52px;padding:12px 14px;gap:12px}
      .mobile-platform-search .ptb-search-item.ptb-search-offer strong{font-size:14px}
      .mobile-platform-search .ptb-search-item.ptb-search-offer .ptb-search-kind{width:34px;height:34px;flex-basis:34px;font-size:14px}
    `;
    document.head.append(style);
  }

  function addressMatchLibrary(){
    if (window.FirstMateAddressMatch) return Promise.resolve(window.FirstMateAddressMatch);
    if (!addressMatchLoading) addressMatchLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = ADDRESS_MATCH_SRC;
      script.onload = () => resolve(window.FirstMateAddressMatch || null);
      script.onerror = () => { addressMatchLoading = null; resolve(null); };
      document.head.append(script);
    });
    return addressMatchLoading;
  }

  // Google's first answer for the typed text, or null (no Maps, no answer, an error).
  function geocodeSearchText(text){
    const Geocoder = window.google?.maps?.Geocoder;
    if (typeof Geocoder !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      try {
        new Geocoder().geocode({ address:text }, (results, status) => {
          clearTimeout(timer);
          resolve(status === 'OK' && Array.isArray(results) && results[0]?.geometry?.location ? results[0] : null);
        });
      } catch (error) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function placeLiteral(place){
    const location = place.geometry.location;
    const lat = typeof location.lat === 'function' ? location.lat() : Number(location.lat);
    const lng = typeof location.lng === 'function' ? location.lng() : Number(location.lng);
    return {
      formatted_address:cleanText(place.formatted_address),
      lat, lng,
      address_components:(Array.isArray(place.address_components) ? place.address_components : []).map((part) => ({
        long_name:part.long_name, short_name:part.short_name, types:Array.isArray(part.types) ? [...part.types] : []
      }))
    };
  }

  // A project this person can see at the address Google gave.
  async function projectAtAddress(place, library){
    const street = library.streetLine(place);
    if (!street) return null;
    let candidates = [];
    if (window.PlatformAPI?.search?.projectsAndContacts) {
      const result = await window.PlatformAPI.search.projectsAndContacts(orgId(), { query:street, types:'project', limit:20 }).catch(() => null);
      candidates = Array.isArray(result?.results) ? result.results.filter((row) => cleanText(row.type || 'project') === 'project') : [];
    } else {
      await loadSearchData();
      candidates = searchData.projects
        .filter((project) => library.sameAddress(firstText(project.address), place))
        .map((project) => ({ type:'project', id:project.id, project_id:project.id, title:project.title || '', subtitle:project.address || '' }));
    }
    for (const candidate of candidates.slice(0, 8)) {
      const project = await projectForSearchResult(candidate).catch(() => null);
      if (project?.id && library.sameAddress(firstText(project.address, candidate.subtitle), place)) return project;
    }
    return null;
  }

  // Order a report for the typed text. Google's answer is used only when it is
  // the typed address completed (FirstMateAddressMatch); then a project already
  // there opens on its order (or on Reports when it has a report), and otherwise
  // the order opens as a new draft with the address filled in. Anything else
  // opens a new draft with the text typed and Google's suggestions open.
  async function orderReportFromSearch(query, button){
    const request = window.Portal?.modules?.request;
    if (!request?.open) return;
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    }
    const [library, place] = await Promise.all([addressMatchLibrary(), geocodeSearchText(query)]);
    const clean = !!(library && place && library.matchesTyped(query, place));
    const existing = clean ? await projectAtAddress(place, library).catch(() => null) : null;
    closeSearchResults();
    if (button) {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
    if (existing) {
      const ordered = request.hasReportOrder?.(existing) === true;
      openProject(existing, ordered ? { tab:'measurements' } : { workflow:'report', tab:'map', forceRefresh:true });
      return;
    }
    if (clean) {
      const resolved = placeLiteral(place);
      request.open(null, { workflow:'report', reportProject:'new', address:resolved.formatted_address || query, resolvedAddress:resolved });
      return;
    }
    request.open(null, { workflow:'report', reportProject:'new', address:query, addressSuggest:true });
  }

  // What the typed text most likely is, for the new contact's first field.
  function contactPrefill(query){
    const text = cleanText(query);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { email:text };
    const digits = text.replace(/\D/g, '');
    if (/^[\d\s()+.\-]+$/.test(text) && digits.length >= 7) return { phone:text };
    if (/^\d+[a-z]?\s+\S+/i.test(text)) return { address:text };
    return { name:text };
  }

  function runSearchOffer(kind, query, button){
    if (kind === 'report') {
      orderReportFromSearch(query, button).catch((error) => console.warn('Order from search failed', error));
      return;
    }
    closeSearchResults();
    if (kind === 'project') window.Portal?.modules?.request?.open?.(null, { workflow:'project', address:query });
    if (kind === 'contact') window.Portal?.modules?.contacts?.open?.(contactPrefill(query), { projects:[] });
  }

  // Arrow keys move from the search box through the results; Enter opens the focused one.
  function moveSearchFocus(input, step){
    const box = searchBoxForInput(input);
    if (!box?.classList.contains('visible')) return false;
    const items = [...box.querySelectorAll('.ptb-search-item:not([disabled])')];
    if (!items.length) return false;
    const at = items.indexOf(document.activeElement);
    if (at < 0) {
      if (step < 0) return false;
      items[0].focus();
      return true;
    }
    const next = at + step;
    if (next < 0) input.focus();
    else items[Math.min(next, items.length - 1)].focus();
    return true;
  }

  function bindSearchKeyboard(box, input){
    if (box.dataset.searchKeys === '1') return;
    box.dataset.searchKeys = '1';
    box.addEventListener('keydown', (event) => {
      if (!event.target.closest?.('.ptb-search-item')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSearchFocus(input, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchResults();
        input.focus();
      }
    });
  }

  function renderSearchResults(input, box, results = []){
    if (!box) return;
    searchResultCache.clear();
    const query = cleanText(input?.value);
    const offerCreate = !!query && enabledSearchTypes.has('project')
      && !results.some((result) => cleanText(result.type || 'project') === 'project');
    const html = results.map((result, index) => {
      const requestedType = cleanText(result.type);
      const type = window.FirstMateArtifactSearch?.type?.(requestedType) ? requestedType : 'project';
      const key = `${type}:${result.id || index}`;
      searchResultCache.set(key, result);
      return `
        <button type="button" class="ptb-search-item ${type}" data-search-result="${escapeHtml(key)}">
          <i class="fas ${resultIcon(type)} ptb-search-kind" aria-hidden="true"></i>
          <span><strong>${escapeHtml(result.title || resultLabel(type))}</strong><small><b>${escapeHtml(resultLabel(type))}</b>${result.subtitle ? ` &middot; ${escapeHtml(result.subtitle)}` : ''}</small></span>
        </button>
      `;
    }).join('');
    const empty = enabledSearchTypes.size ? (globalThis.PlatformLanguage?.htmlText("platform","search_no_matches","No matches") ?? "No matches") : 'Select at least one result type';
    const offers = offerCreate ? searchOffersHtml(query) : '';
    if (offers) ensureSearchOfferStyles();
    const offerBlock = offers
      ? `${html ? '' : `<div class="ptb-search-offers-label">${empty}</div>`}<div class="ptb-search-offers" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform","search_offers_label","Start something new") ?? "Start something new")}">${offers}</div>`
      : '';
    box.innerHTML = `${searchFiltersHtml()}<div class="ptb-search-result-list">${html}${offerBlock}${html || offers ? '' : `<div class="ptb-empty">${empty}</div>`}</div>`;
    box.classList.add('visible');
    bindSearchFilters(box, input);
    bindSearchKeyboard(box, input);
    box.querySelectorAll('[data-search-offer]').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault();
      runSearchOffer(button.dataset.searchOffer, query, button);
    }));
    box.querySelectorAll('[data-search-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const result = searchResultCache.get(btn.dataset.searchResult);
        closeSearchResults();
        openSearchResult(result).catch(() => null);
      });
    });
  }

  async function localProjectContactResults(query){
    const needle = String(query || '').trim().toLowerCase();
    await loadSearchData();
    return [
      ...(enabledSearchTypes.has('project') ? searchData.projects.filter((project) => projectSearchText(project).includes(needle)).slice(0, 40).map((project) => ({
        type:'project', id:project.id, project_id:project.id,
        title:firstText(project.title, project.project_title, project.project_name, project.customer_name, project.primary_contact_name, project.address, 'Project'),
        subtitle:firstText(project.address, project.project_type, project.stage)
      })) : []),
      ...(enabledSearchTypes.has('contact') ? searchData.contacts.filter((contact) => contactSearchText(contact).includes(needle)).slice(0, 40).map((contact) => ({
        type:'contact', id:contact.id, project_id:contact.project_id, title:contact.name || contact.email || 'Contact',
        subtitle:firstText(contact.email, contact.phone), contact
      })) : [])
    ];
  }

  async function runSearch(input){
    const box = searchBoxForInput(input);
    const query = cleanText(input?.value);
    if (!box) return;
    if (!query) {
      box.classList.remove('visible');
      box.innerHTML = '';
      return;
    }
    const sequence = ++searchSequence;
    if (searchRequest) searchRequest.abort();
    searchRequest = window.AbortController ? new AbortController() : null;
    await window.FirstMateArtifactSearch?.loadOffered?.({ orgId:orgId(), branchId:branchId() });
    if (sequence !== searchSequence) return;
    const offered = (type) => window.FirstMateArtifactSearch?.offered?.(type) === true;
    box.innerHTML =(String(searchFiltersHtml()) + "<div class=\"ptb-search-result-list\"><div class=\"ptb-empty\">" + (globalThis.PlatformLanguage?.htmlText("platform","m_1868baee889a75","Searching...") ?? "Searching...") + "</div></div>");
    box.classList.add('visible');
    bindSearchFilters(box, input);
    const platformTypes = ['project','contact'].filter((type) => enabledSearchTypes.has(type) && offered(type));
    const artifactPromise = window.FirstMateArtifactSearch?.search?.(query, {
      orgId:orgId(), branchId:branchId(), types:[...enabledSearchTypes].filter((type) => offered(type) && !platformTypes.includes(type)), limit:100
    }) || Promise.resolve([]);
    let platformResults = [];
    if (platformTypes.length && window.PlatformAPI?.search?.projectsAndContacts) {
      try {
        const result = await window.PlatformAPI.search.projectsAndContacts(orgId(), {
          query,
          types: platformTypes.join(','),
          limit: 100,
          ...(searchRequest ? { signal: searchRequest.signal } : {})
        });
        if (sequence !== searchSequence) return;
        platformResults = Array.isArray(result?.results) ? result.results : [];
      } catch (error) {
        if (error?.name === 'AbortError') return;
        platformResults = await localProjectContactResults(query);
      }
    } else if (platformTypes.length) {
      platformResults = await localProjectContactResults(query);
    }
    const artifactResults = await artifactPromise;
    if (sequence !== searchSequence) return;
    renderSearchResults(input, box, [...platformResults, ...artifactResults]);
  }

  function activeNotificationHtml(item){
    return `
      <div class="ptb-note ${item.user_state?.seen_at ? 'seen' : 'unread'} ${isLeadNotification(item) ? 'lead-note' : ''}" data-note-id="${escapeHtml(item.id)}">
        <div class="ptb-note-main">
          <strong>${escapeHtml(leadTitle(item))}</strong>
          <span>${escapeHtml(item.body || '')}</span>
        </div>
        ${item.manual_dismissible ? `<button type="button" class="ptb-note-dismiss" data-dismiss-note="${String(escapeHtml(item.id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform","m_63fc9fb260d3a6","Mark notification done") ?? "Mark notification done")}" title="${(globalThis.PlatformLanguage?.htmlText("platform","m_8e85dc2d122c71","Mark done") ?? "Mark done")}"><i class="fas fa-check" aria-hidden="true"></i></button>` : ''}
      </div>
    `;
  }

  function dismissedNotificationHtml(item){
    return `
      <div class="ptb-note ptb-note-dismissed seen" data-dismissed-note-id="${String(escapeHtml(item.id))}">
        <div class="ptb-note-main">
          <strong>${String(escapeHtml(leadTitle(item)))}</strong>
          <span>${String(escapeHtml(item.body || ''))}</span>
        </div>
        <button type="button" class="ptb-note-restore" data-restore-note="${String(escapeHtml(item.id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform","m_a38ee26b78adc6","Restore notification") ?? "Restore notification")}" title="${(globalThis.PlatformLanguage?.htmlText("platform","m_a38ee26b78adc6","Restore notification") ?? "Restore notification")}"><i class="fas fa-rotate-left" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("platform","m_4004b71744b54e","Undo") ?? "Undo")}</span></button>
      </div>
    `;
  }

  // Pinned attention entries (PlatformBanners "notification" surface): locked
  // above the regular rows, tone background, never dismissible from here.
  function pinnedAttentionEntries(){
    try {
      return window.PlatformBanners?.entriesForSurface?.('notification') || [];
    } catch (error) {
      return [];
    }
  }

  function pinnedAttentionHtml(entry){
    const tone = ['orange', 'primary', 'danger', 'neutral'].includes(String(entry.tone || '')) ? entry.tone : 'orange';
    return `
      <div class="ptb-note ptb-note-pinned tone-${tone}" data-attention-note-id="${escapeHtml(entry.id)}">
        <div class="ptb-note-main">
          <strong>${escapeHtml(entry.title || (globalThis.PlatformLanguage?.text("platform","m_633c5884c59d4e","Attention") ?? "Attention"))}</strong>
          ${entry.body ? `<span>${escapeHtml(entry.body)}</span>` : ''}
        </div>
        ${String(entry.state || '') === 'waiting' ? ("<i class=\"fas fa-hourglass-half ptb-note-pinned-wait\" aria-hidden=\"true\" title=\"" + (globalThis.PlatformLanguage?.htmlText("platform","m_c84286da8f58e9","Waiting") ?? "Waiting") + "\"></i>") : ''}
      </div>
    `;
  }

  function notificationListHtml(notifications, dismissed, dismissedOpen, pinned = []){
    const pinnedHtml = pinned.length ? pinned.map(pinnedAttentionHtml).join('') : '';
    const activeHtml = notifications.length
      ? notifications.map(activeNotificationHtml).join('')
      : `<div class="ptb-empty">${(globalThis.PlatformLanguage?.htmlText("platform","m_ef1f67ca1f3465","You're all caught up.") ?? "You're all caught up.")}</div>`;
    const activeSection = `${pinnedHtml}<div class="ptb-active-notifications">${activeHtml}</div>`;
    if (!dismissed.length) return activeSection;
    return (String(activeSection) + "\n      <details class=\"ptb-dismissed-section\" " + String(dismissedOpen ? 'open' : '') + ">\n        <summary><span><i class=\"fas fa-chevron-right\" aria-hidden=\"true\"></i>" + (globalThis.PlatformLanguage?.text("platform","m_cf7bc46e9e0379","Dismissed today") ?? "Dismissed today") + "</span><b>" + String(dismissed.length) + "</b></summary>\n        <div class=\"ptb-dismissed-list\">" + String(dismissed.map(dismissedNotificationHtml).join('')) + "</div>\n      </details>");
  }

  async function dismissNotification(button){
    const row = button.closest('[data-note-id]');
    if (!row || button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    row.classList.add('is-dismissing');
    try {
      await Promise.all([
        window.PlatformNotifications?.dismiss(orgId(), button.dataset.dismissNote, notificationLoadOptions({ reload:false })),
        wait(180)
      ]);
      row.classList.add('is-dismissed');
      await wait(220);
      await window.PlatformNotifications?.load(orgId(), notificationLoadOptions({ silent:true }));
    } catch (error) {
      row.classList.remove('is-dismissing', 'is-dismissed');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.add('is-error');
      setTimeout(() => button.classList.remove('is-error'), 500);
    }
  }

  async function restoreNotification(button){
    const row = button.closest('[data-dismissed-note-id]');
    if (!row || button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    row.classList.add('is-restoring');
    try {
      const notificationId = button.dataset.restoreNote;
      const restoreRequest = typeof window.PlatformNotifications?.restore === 'function'
        ? window.PlatformNotifications.restore(orgId(), notificationId, notificationLoadOptions({ reload:false }))
        : window.PlatformAPI?.notifications?.setUserState?.(orgId(), notificationId, { dismissed:false });
      if (!restoreRequest) throw new Error('Notification restore is unavailable.');
      const [restoredState] = await Promise.all([restoreRequest, wait(180)]);
      if (restoredState?.dismissed_at || restoredState?.state?.dismissed_at) {
        throw new Error('Notification remained dismissed after the restore request.');
      }
      await window.PlatformNotifications?.load(orgId(), notificationLoadOptions({ silent:true }));
    } catch (error) {
      row.classList.remove('is-restoring');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.add('is-error');
      setTimeout(() => button.classList.remove('is-error'), 500);
    }
  }

  function openSmsRegistrationNotification(item){
    if (item?.frontend_action?.kind !== 'open_sms_registration' || !window.Portal?.navigation?.navigate) return false;
    window.Portal.navigation.navigate({tab:'company_settings',sub:'sms',workflow:'10dlc',workflow_step:'summary'}, {source:'notification-sms-registration'});
    return true;
  }

  function openPaymentSettingsNotification(item){
    if (item?.frontend_action?.kind !== 'open_payment_settings' || !window.Portal?.navigation?.navigate) return false;
    window.Portal.navigation.navigate({tab:'company_settings',sub:'money',settingsView:'payments'}, {source:'notification-payment-settings'});
    return true;
  }

  async function openNotificationItem(item){
    if (!item) return;
    window.PlatformNotifications?.markSeen(orgId(), item.id, notificationLoadOptions({ reload:true })).catch(() => null);
    if (openSmsRegistrationNotification(item) || openPaymentSettingsNotification(item) || openAssistantNotification(item) || openChatNotification(item) || openMerchantPortalNotification(item) || await openCommsNotification(item) || openChannelMessageNotification(item) || openMentionNotification(item) || await openMeasurementReportNotification(item)) {
      closeNotificationMenus();
    } else if (notificationOpensProject(item) || (!item.frontend_action?.kind && (item.context?.project_id || item.data?.project_id))) {
      await openNotificationProject(item);
      closeNotificationMenus();
    }
  }

  function bindNotificationList(list, notifications){
    if (!list) return;
    list.querySelectorAll('[data-attention-note-id]').forEach((node) => {
      node.addEventListener('click', () => {
        const entry = pinnedAttentionEntries().find((item) => String(item.id) === String(node.dataset.attentionNoteId));
        if (!entry) return;
        if (window.PlatformBanners?.applyEntryAction?.(entry)) closeNotificationMenus();
      });
    });
    list.querySelectorAll('[data-note-id]').forEach((node) => {
      node.addEventListener('click', async () => {
        const item = notifications.find((entry) => String(entry.id) === String(node.dataset.noteId));
        await openNotificationItem(item);
      });
    });
    list.querySelectorAll('[data-dismiss-note]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        dismissNotification(button);
      });
    });
    list.querySelectorAll('[data-restore-note]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        restoreNotification(button);
      });
    });
  }

  function renderNotifications(snapshot = window.PlatformNotifications?.getState?.() || {}){
    const count = $('#platformNotificationCount');
    const list = $('#platformNotificationList');
    const menuHead = $('#platformNotificationMenu .ptb-menu-head');
    const mobileCount = $('#mobilePlatformNotificationCount');
    const mobileList = $('#mobilePlatformNotificationList');
    const mobileMenuHead = $('#mobilePlatformNotificationMenu .ptb-menu-head');
    const unread = Number(snapshot.unread_count || 0);
    const total = Number(snapshot.active_count || 0);
    if (count) {
      count.textContent = unread > 99 ? '99+' : String(unread || 0);
      count.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      count.classList.toggle('visible', unread > 0);
      count.classList.toggle('has-unread', unread > 0);
    }
    if (mobileCount) {
      mobileCount.textContent = unread > 99 ? '99+' : String(unread || 0);
      mobileCount.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      mobileCount.classList.toggle('visible', unread > 0);
      mobileCount.classList.toggle('has-unread', unread > 0);
    }
    if (menuHead) {
      menuHead.innerHTML = `<span>${(globalThis.PlatformLanguage?.htmlText("platform","m_5a9115e4033cb3","Notifications") ?? "Notifications")}</span><small>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("platform","m_6d30e375168449",`${v0} unread &middot; ${v1} total`,{v0,v1}) ?? `${v0} unread &middot; ${v1} total`)(unread,total)}</small>`;
    }
    if (mobileMenuHead && menuHead) mobileMenuHead.innerHTML = menuHead.innerHTML;
    if (!list) return;
    const notifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    const dismissed = Array.isArray(snapshot.dismissed_notifications) ? snapshot.dismissed_notifications : [];
    const pinned = pinnedAttentionEntries();
    const desktopDismissedOpen = !!list.querySelector('.ptb-dismissed-section[open]');
    const mobileDismissedOpen = !!mobileList?.querySelector('.ptb-dismissed-section[open]');
    list.innerHTML = notificationListHtml(notifications, dismissed, desktopDismissedOpen, pinned);
    if (mobileList) mobileList.innerHTML = notificationListHtml(notifications, dismissed, mobileDismissedOpen, pinned);
    bindNotificationList(list, notifications);
    if (mobileList) {
      bindNotificationList(mobileList, notifications);
    }
  }

  async function bind(){
    if (!(await topbarEnabled())) {
      setTopbarVisible(false);
      return;
    }
    setTopbarVisible(true);
    document.querySelectorAll('[data-platform-search-input]').forEach((search) => {
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(search).catch(() => null), 120);
      });
      search.addEventListener('focus', () => {
        if (cleanText(search.value)) runSearch(search).catch(() => null);
      });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          search.value = '';
          closeSearchResults();
        }
        if (event.key === 'ArrowDown' && moveSearchFocus(search, 1)) event.preventDefault();
      });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.platform-search')) closeSearchResults();
      if (!event.target.closest('.platform-notifications,#platformNotificationMenu,#mobilePlatformNotificationMenu')) closeNotificationMenus();
      if (!event.target.closest('.platform-messages')) closeMessagesMenus();
      if (!event.target.closest('.platform-more')) closeMoreMenu();
    });
    $('#mobilePlatformMoreBtn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = !moreMenuOpen();
      closeMessagesMenus();
      closeNotificationMenus();
      if (opening) openMoreMenu();
      else closeMoreMenu();
    });
    $('#mobilePlatformMoreAssistant')?.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMoreMenu();
      closeMessagesMenus();
      closeNotificationMenus();
      toggleAssistant({ reveal:true });
    });
    $('#mobilePlatformMoreMessages')?.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMoreMenu();
      $('#mobilePlatformMessagesBtn')?.click();
    });
    $('#mobilePlatformMoreNotifications')?.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMoreMenu();
      $('#mobilePlatformBell')?.click();
    });
    $('#mobilePlatformMorePhone')?.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMoreMenu();
      $('#platformPhoneBtn')?.click();
    });
    installMoreSheet();
    installPhoneSheets();
    [
      { button: '#platformMessagesBtn', menu: '#platformMessagesMenu' },
      { button: '#mobilePlatformMessagesBtn', menu: '#mobilePlatformMessagesMenu' }
    ].forEach(({ button, menu }) => {
      $(button)?.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!messagesAllowed()) return;
        const targetMenu = $(menu);
        const opening = !targetMenu?.classList.contains('visible');
        closeMessagesMenus();
        closeNotificationMenus();
        if (opening) {
          showNotificationMenu(targetMenu, $(button));
          await loadMessagesInbox();
          // Reading an individual item acknowledges it; opening the menu does not.
        }
      });
    });
    updateMessagesVisibility();
    loadMessagesInbox().catch(() => null);
    [
      { bell: '#platformBell', menu: '#platformNotificationMenu' },
      { bell: '#mobilePlatformBell', menu: '#mobilePlatformNotificationMenu' }
    ].forEach(({ bell, menu }) => {
      $(bell)?.addEventListener('click', async (event) => {
        event.stopPropagation();
        const targetMenu = $(menu);
        const opening = !targetMenu?.classList.contains('visible');
        // Only one topbar dropdown at a time.
        closeNotificationMenus();
        closeMessagesMenus();
        if (opening) showNotificationMenu(targetMenu, $(bell));
        document.body.classList.toggle('mobile-notifications-open', opening && menu === '#mobilePlatformNotificationMenu' && !targetMenu?.classList.contains('ptb-menu--sheet'));
        if (opening) await window.PlatformNotifications?.load(orgId(), notificationLoadOptions()).catch(() => null);
      });
    });
    ['#platformAssistantBtn', '#mobilePlatformAssistantBtn'].forEach((selector) => {
      $(selector)?.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMessagesMenus();
        closeNotificationMenus();
        if (selector === '#mobilePlatformAssistantBtn') toggleAssistant();
        else window.PlatformAssistant?.toggle?.();
      });
    });
    updateAssistantVisibility(true);
    const refreshMessagesAccess = () => { updateAssistantVisibility(); updateMessagesVisibility(); loadMessagesInbox().catch(() => null); };
    window.addEventListener('fm:capabilities:updated', refreshMessagesAccess);
    window.addEventListener('fm:app-flags:updated', refreshMessagesAccess);
    window.PlatformNotifications?.subscribe(renderNotifications);
    window.PlatformRealtime?.subscribe?.(orgId(), "channels.", event => {
      if (['channels.read.updated','channels.read_state.updated','channels.unreads.changed','channels.message.created','channels.reaction.updated'].includes(event.topic)) loadMessagesInbox().catch(() => null);
    });
    window.addEventListener('fm:notification:open', async (event) => {
      const id = String(event.detail?.id || '');
      if (!id) return;
      const state = await window.PlatformNotifications?.load(orgId(), notificationLoadOptions({ silent:true })).catch(() => null);
      let item = state?.notifications?.find((entry) => String(entry.id) === id);
      if (!item) item = (await window.PlatformAPI?.notifications?.get?.(orgId(), id).catch(() => null))?.notification?.data;
      if (item) { await openNotificationItem(item); sessionStorage.removeItem('firstmate_pending_notification'); }
    });
    const pendingNotification = sessionStorage.getItem('firstmate_pending_notification');
    if (pendingNotification) window.dispatchEvent(new CustomEvent('fm:notification:open', { detail:{ id:pendingNotification } }));
    // Re-render the menus whenever the attention feed changes so pinned rows
    // stay current; unread counts still come from PlatformNotifications only.
    window.PlatformBanners?.subscribe?.(() => renderNotifications());
    window.PlatformNotifications?.load(orgId(), notificationLoadOptions()).catch(() => null);
    syncMoreMenu();
    if (!notificationTimer) {
      notificationTimer = setInterval(() => {
        window.PlatformNotifications?.load(orgId(), notificationLoadOptions()).catch(() => null);
        loadMessagesInbox().catch(() => null);
        syncMoreMenu();
      }, 10000);
    }
  }

  document.addEventListener('DOMContentLoaded', () => bind().catch(() => setTopbarVisible(true)));
  window.addEventListener('fm:app-flags:updated', () => {
    topbarEnabled()
      .then((enabled) => setTopbarVisible(enabled))
      .catch(() => setTopbarVisible(true));
  });
})();
