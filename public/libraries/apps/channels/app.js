/* Channels — internal team messaging (Slack-style) portal tab.
 *
 * Thin shell around the shared FirstMateChannels UI library: mounts it in
 * `full` mode, keeps the URL route (channel / thread / message / view) in
 * sync, and handles mention-notification deep links. All actual messaging UI
 * lives in libraries/channels-ui so the project-notes surfaces reuse it.
 *
 * Integrated sidebar mode (personal `left_column_channels` preference): the standalone
 * portal tab is unregistered and the channel rail lives in the global left
 * column instead (core.js mounts the `list`-mode rail). Opening a channel
 * pops a conversation overlay over whatever app is on screen — the app stays
 * mounted underneath and reappears when the overlay's back button closes it.
 */
(function(){
  const APP = window.__APP || {};

  const state = {
    root: null,
    instance: null,
    mounted: false,
    lastRoute: { channel: '', thread: '' }
  };

  const orgId = () => String(APP.userOrgId || APP.orgId || window.Portal?.currentUser?.orgId || '').trim();

  function channelFeatures(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    const enabled = (key, fallback = true) => flags?.current?.() ? !!flags.has?.('channels', key, fallback) : fallback;
    return {
      threads: enabled('threads'),
      reactions: enabled('reactions'),
      dms: enabled('dms'),
      attachments: enabled('attachments'),
      pins: enabled('pins'),
      search: enabled('search'),
      attention: enabled('attention_v2'),
      richMessages: enabled('rich_messages'),
      resources: enabled('resources'),
      clips: enabled('clips'),
      workflows: enabled('workflows'),
      ai: enabled('ai'),
      huddles: enabled('huddles'),
      recording: enabled('recording', false),
      recordVideo: enabled('record_video', true)
    };
  }

  function writeRoute(route, history = 'push'){
    window.Portal?.navigation?.write?.(
      {
        tab: 'channels',
        channel: route.channel || null,
        channelThread: route.thread || null,
        channelMessage: route.message || null,
        channelsView: route.view && route.view !== 'channel' ? route.view : null
      },
      { history, source: 'channels-app', ownedKeys: ['channel', 'channelThread', 'channelMessage', 'channelsView'] }
    );
  }

  async function restoreRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (route.tab !== 'channels' || !state.instance || !state.mounted) return;
    const channel = String(route.channel || '');
    const thread = String(route.channelThread || '');
    const message = String(route.channelMessage || '');
    const current = state.instance.state;
    if (channel && channel !== current.activeChannelId) state.closeSettings?.();
    if (channel && channel !== current.activeChannelId) {
      await state.instance.setChannel(channel, { reveal: message || undefined });
      if (thread && !message) await state.instance.openThread(thread);
    } else if (channel && message) {
      await state.instance.revealMessage(message);
    } else if (channel && thread && thread !== current.threadRootId) {
      await state.instance.openThread(thread);
    }
  }

  function canOpenSettings(){
    return window.Portal?.util?.hasPerm?.('manage_company_settings') || window.Portal?.util?.hasPerm?.('manage_channels');
  }

  function openSettings(owner = state){
    if (!canOpenSettings() || owner.closeSettings) return;
    const host = owner === state ? state.root : overlay.body;
    if (!host) return;
    const previousFocus = document.activeElement;
    const hidden = [...host.children, ...(owner === state ? [] : [overlay.tabsEl, overlay.actionsEl])].filter(Boolean)
      .map(element => ({ element, hidden:element.hidden, display:element.style.display }));
    hidden.forEach(({element}) => { element.hidden = true; element.style.display = 'none'; });
    const view = document.createElement('section');
    view.setAttribute('aria-label', 'Channels settings');
    view.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;background:var(--fm-bg,#fff)';
    view.innerHTML = '<header style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #e4e7ec"><button type="button" data-ch-settings-back style="display:inline-flex;align-items:center;gap:8px;border:1px solid #d0d5dd;border-radius:8px;padding:8px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit"><i class="fas fa-arrow-left" aria-hidden="true"></i>Back to Channels</button><h2 style="margin:0;font-size:18px">Channels settings</h2></header><div data-ch-settings-host style="flex:1;min-height:0;overflow:auto;padding:16px"><p role="status">Loading Channels settings…</p></div>';
    host.append(view);
    let closed = false;
    let handle = null;
    const back = view.querySelector('[data-ch-settings-back]');
    owner.closeSettings = () => {
      if (closed) return;
      closed = true;
      handle?.destroy?.();
      view.remove();
      hidden.forEach(({element,hidden,display}) => { element.hidden = hidden; element.style.display = display; });
      owner.closeSettings = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    back.addEventListener('click', owner.closeSettings);
    back.focus();
    const settingsHost = view.querySelector('[data-ch-settings-host]');
    Promise.resolve().then(() => {
      if (closed) return null;
      const runtime = window.FirstMateEmbeddableApps;
      if (!runtime?.mount) throw new Error('Channels settings could not be loaded. Please try again.');
      return runtime.mount(settingsHost, 'portal.company_settings', {
        surface:'portal_tab', source:'channels-settings',
        params:{ embedded:true, settingsTab:'channels' }, roots:{ main:settingsHost }
      });
    }).then(result => {
      if (closed) result?.destroy?.();
      else handle = result;
    }).catch(error => {
      if (!closed) settingsHost.textContent = error?.message || 'Channels settings could not be loaded.';
    });
  }

  function mount(root){
    state.closeSettings?.();
    state.root = root;
    state.mounted = true;
    root.innerHTML = '';
    root.style.height = '100%';
    const holder = document.createElement('div');
    holder.style.cssText = 'height:100%;min-height:420px;padding:0';
    root.appendChild(holder);

    state.instance = window.FirstMateChannels.create(holder, {
      orgId: orgId(),
      mode: 'full',
      currentUser: {
        id: String(APP.userId || window.Portal?.currentUser?.id || ''),
        name: String(APP.userName || APP.userEmail || ''),
        email: String(APP.userEmail || '').toLowerCase()
      },
      realtime: true,
      features: channelFeatures(),
      onSettings: canOpenSettings() ? () => openSettings(state) : undefined,
      onNavigate(route){
        const changed = route.channel !== state.lastRoute.channel;
        state.lastRoute = { channel: route.channel || '', thread: route.thread || '' };
        writeRoute(route, changed ? 'push' : 'replace');
      }
    });

    const route = window.Portal?.navigation?.read?.() || {};
    if (route.channel) restoreRoute(route);

    return {
      destroy(){
        state.closeSettings?.();
        state.mounted = false;
        state.instance?.destroy();
        state.instance = null;
      },
      setActive(active){
        if (active) state.instance?.refresh();
      },
      update(){
        state.instance?.refresh();
      }
    };
  }

  window.Portal?.navigation?.registerHandler?.('channels-app', {
    priority: 445,
    apply: (route) => restoreRoute(route)
  });

  // --- integrated sidebar mode -------------------------------------------------

  function sidebarModeEnabled(){
    // Mirrors core.js sidebarChannelsFeatureEnabled(): on phones the sidebar
    // is a pop-out drawer, so channels always stays a standalone tab there.
    if (window.matchMedia?.('(max-width: 820px)')?.matches) return false;
    if (window.Portal?.can?.('apps.channels') === false) return false;
    return window.Portal?.currentUser?.identity?.preferences?.left_column_channels === true;
  }

  const overlay = {
    root: null,
    body: null,
    titleEl: null,
    topicEl: null,
    actionsEl: null,
    instance: null,
    channelId: '',
    openFlag: false,
    closeTimer: null
  };
  overlay.windowMode = 'full';
  overlay.pinned = false;
  overlay.dockWidth = 520;

  function setConversationWindow(mode, { silent = false } = {}){
    overlay.windowMode = ['full','floating','docked','minimized'].includes(mode) ? mode : 'full';
    overlay.window?.setMode(overlay.windowMode, {silent:true});
    if (overlay.windowMode !== 'full') overlay.instance?.detachCall?.();
    if (!silent && !window.Portal?.navigation?.applying) window.Portal?.navigation?.replace?.({channelWindow:overlay.windowMode});
  }

  const navigation = window.Portal?.navigation;
  navigation?.registerSchema?.('channelsOverlay', {});
  navigation?.registerSchema?.('channelWindow', {values:['full','floating','docked','minimized'], default:'full', scope:{channelsOverlay:true}});
  navigation?.registerSchema?.('channelPinned', {values:['1'], scope:{channelsOverlay:true}});
  navigation?.registerHandler?.('channels-conversation-window', {
    priority:180, immediate:true,
    apply(route){
      if (!sidebarModeEnabled()) return;
      if (route.channelsOverlay) {
        if (overlay.channelId !== route.channelsOverlay || !overlay.openFlag) openOverlay(route.channelsOverlay, {silent:true});
        setConversationWindow(route.channelWindow || 'full', {silent:true});
        overlay.pinned = route.channelPinned === '1';
        overlay.window?.setPinned(overlay.pinned, {silent:true});
      } else if (overlay.openFlag && overlay.channelId) closeOverlay({silent:true});
    }
  });

  function ensureOverlayStyles(){
    if (document.getElementById('fm-channels-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'fm-channels-overlay-styles';
    style.textContent = `
.main{position:relative}
.fm-channels-overlay{display:flex}
.fm-channels-overlay,.fm-channels-overlay *{box-sizing:border-box}
.fm-channels-overlay[hidden]{display:none}
.fm-channels-overlay-card{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:#fff;border-top:1px solid rgba(15,23,42,.08);box-shadow:0 -18px 48px rgba(15,23,42,.12);opacity:0;transform:translateY(18px) scale(.985);transform-origin:center bottom;transition:opacity .2s ease,transform .26s cubic-bezier(.22,1,.36,1)}
.fm-channels-overlay.open .fm-channels-overlay-card{opacity:1;transform:none}

.fm-channels-overlay-title{font-weight:900;font-size:14.5px;color:#101828;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.fm-channels-overlay-title i{color:#667085;font-size:12px}
.fm-channels-overlay-topic{color:#667085;font-size:13px;flex:1;min-width:40px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fm-channels-overlay-actions{display:flex;align-items:center;flex-shrink:0}
.fm-channels-overlay-actions .fm-ch-header-actions{margin-left:0}
.fm-channels-overlay-actions button{appearance:none;border:0;background:transparent;box-shadow:none;padding:0;font:inherit;font-weight:400}
.fm-channels-overlay-actions .fm-ch-icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;color:#667085;font-size:12.5px}
.fm-channels-overlay-actions .fm-ch-icon-btn:hover{background:#f7f8fa;color:var(--primary-readable,var(--primary,#d93025))}
.fm-channels-overlay-actions .fm-ch-icon-btn.on{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
.fm-channels-overlay-actions .fm-ch-btn{border-radius:9px;padding:8px 15px;font-weight:650;font-size:12.5px;border:1px solid #d8dee8;color:#344054;background:#fff}
.fm-channels-overlay-body{flex:1;min-height:0;display:flex}
.fm-channels-overlay-body>div{flex:1;min-width:0;min-height:0}
.fm-channels-overlay[data-window=minimized] .fm-channels-overlay-subhead{display:none}

.fm-channels-overlay-title{flex:1;min-width:0;flex-shrink:1}.fm-channels-overlay-title span{overflow:hidden;text-overflow:ellipsis}
.fm-channels-overlay-card{position:relative}.fm-channels-overlay-subhead{position:absolute;top:48px;right:12px;z-index:8;max-width:calc(100% - 24px);pointer-events:none}.fm-channels-overlay-subhead button{pointer-events:auto;background:#fff;border:1px solid #e4e7ec;box-shadow:0 2px 6px #10182812}.fm-channels-overlay-subhead .fm-ch-header-actions{gap:5px}.fm-channels-overlay-body .fm-ch-list{padding-top:48px}.fm-channels-overlay-tabs{flex:1;min-width:0;overflow:auto}.fm-channels-overlay-tabs .fm-ch-tabs{border:0;padding:0;background:transparent;flex-wrap:nowrap}.fm-channels-overlay-title{flex:0 1 auto;max-width:32%}.fm-channels-overlay .fm-channels-overlay-head{height:44px;padding-top:0;padding-bottom:0;gap:12px}.fm-channels-overlay-head .fm-window-controls{margin-left:auto;flex-shrink:0}.fm-channels-overlay[data-window=minimized] .fm-channels-overlay-tabs{display:none}
.fm-channels-overlay-subhead .fm-channels-overlay-actions{margin-left:auto;max-width:100%;flex-wrap:wrap}
.fm-channels-overlay-subhead .fm-ch-header-actions{flex-wrap:wrap}
.fm-channels-overlay[data-window=minimized] .fm-channels-overlay-subhead{display:none}
`;
    document.head.appendChild(style);
  }

  function overlayTypeIcon(type){
    if (type === 'private') return 'fa-lock';
    if (type === 'project') return 'fa-diagram-project';
    if (type === 'dm') return 'fa-user';
    if (type === 'group_dm') return 'fa-user-group';
    return 'fa-hashtag';
  }

  function positionOverlay(){ overlay.window?.refresh(); }

  function ensureOverlayDom(){
    if (overlay.root) return true;
    const main = document.querySelector('main.main') || document.querySelector('.main');
    if (!main || !window.FirstMateWindows) return false;
    ensureOverlayStyles();
    const root = document.createElement('div');
    root.className = 'fm-channels-overlay';
    root.hidden = true;
    const card = document.createElement('div');
    card.className = 'fm-channels-overlay-card';
    const head = document.createElement('div');
    head.className = 'fm-channels-overlay-head';
    overlay.titleEl = document.createElement('div');
    overlay.titleEl.className = 'fm-channels-overlay-title';
    overlay.topicEl = document.createElement('div');
    overlay.topicEl.className = 'fm-channels-overlay-topic';
    overlay.actionsEl = document.createElement('div');
    overlay.actionsEl.className = 'fm-channels-overlay-actions';
    overlay.tabsEl = document.createElement('div'); overlay.tabsEl.className = 'fm-channels-overlay-tabs';
    head.append(overlay.titleEl, overlay.tabsEl);
    const subhead = document.createElement('div'); subhead.className = 'fm-channels-overlay-subhead'; subhead.dataset.windowSecondary='';
    subhead.append(overlay.actionsEl);
    overlay.body = document.createElement('div');
    overlay.body.className = 'fm-channels-overlay-body';
    card.append(head, subhead, overlay.body);
    root.appendChild(card);
    main.appendChild(root);
    overlay.root = root;
    overlay.window = window.FirstMateWindows.attach({
      element:root, header:head, title:overlay.titleEl, titleMenu:false, body:overlay.body, host:main,
      contentTarget:main.querySelector(':scope > #mainPanels, :scope > #app'),
      name:'conversation', label:(globalThis.PlatformLanguage?.text("channels","m_15c39359df33c7","Conversation window") ?? "Conversation window"), mode:overlay.windowMode, width:720, height:680, dockWidth:520,
      topInset:() => { const bar=document.getElementById('platformTopbar'); return bar?.offsetParent ? bar.offsetHeight : 0; },
      onChange:({mode,pinned}) => {
        overlay.windowMode=mode; overlay.pinned=pinned;
        if (mode !== 'full') overlay.instance?.detachCall?.();
        if (!window.Portal?.navigation?.applying) window.Portal?.navigation?.replace?.({channelWindow:mode,channelPinned:pinned ? '1' : null});
      },
      onClose:() => closeOverlay()
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !overlay.openFlag || !overlay.root.contains(event.target)) return;
      const target = event.target;
      if (target && (target.closest?.('textarea, input, [contenteditable]'))) return;
      if (document.querySelector('.fm-ch-modal-backdrop') || document.querySelector('.fm-ch-popover') || document.querySelector('.fm-ch-profile-panel')) return;
      closeOverlay();
    });
    return true;
  }

  async function loadOverlayHeader(channelId){
    if (!overlay.titleEl) return;
    try {
      const data = await window.ChannelsAPI.channels.get(orgId(), channelId);
      if (overlay.channelId !== channelId) return;
      const channel = data.channel || {};
      overlay.titleEl.innerHTML = `<i class="fas ${overlayTypeIcon(channel.type)}"></i>`;
      overlay.titleEl.append(window.FirstMateChannels.createChannelTitle(channel));
      overlay.topicEl.textContent = channel.topic || '';
    } catch (error) {
      overlay.titleEl.textContent = (globalThis.PlatformLanguage?.text("channels","m_4cd5e2d9c65130","Conversation") ?? "Conversation");
      overlay.topicEl.textContent = '';
    }
  }

  function ensureOverlayInstance(){
    if (!window.FirstMateChannels?.create || !ensureOverlayDom()) return false;
    if (!overlay.instance) {
      overlay.instance = window.FirstMateChannels.create(overlay.body, {
        orgId: orgId(),
        mode: 'conversation',
        onSettings: canOpenSettings() ? () => openSettings(overlay) : undefined,
        compactHeader: true,
        onCallEnded:() => { if (!overlay.openFlag) setTimeout(() => { if (!overlay.openFlag && !overlay.instance?.state?.inCall) { overlay.instance?.destroy(); overlay.instance=null; } },0); },
        headerActionsTarget: overlay.actionsEl,
        tabsTarget: overlay.tabsEl,
        onNavigate(route){
          if (route.channel && route.channel !== overlay.channelId) {
            overlay.channelId = route.channel; void loadOverlayHeader(route.channel);
            if (!window.Portal?.navigation?.applying) window.Portal?.navigation?.push?.({channelsOverlay:route.channel}, {ownedKeys:['channelsOverlay']});
          }
        },
        currentUser: {
          id: String(APP.userId || window.Portal?.currentUser?.id || ''),
          name: String(APP.userName || APP.userEmail || ''),
          email: String(APP.userEmail || '').toLowerCase()
        },
        realtime: true,
        features: channelFeatures()
      });
    }
    return true;
  }

  function showOverlay(){
    clearTimeout(overlay.closeTimer);
    positionOverlay();
    if (!overlay.openFlag) {
      overlay.openFlag = true;
      overlay.window.setVisible(true);
      positionOverlay();
      // Two frames so the hidden -> visible flip commits before the pop-in
      // transition starts.
      requestAnimationFrame(() => requestAnimationFrame(() => overlay.root.classList.add('open')));
    }
  }

  function openOverlay(channelId, { reveal, thread, windowMode, silent = false } = {}){
    if (!channelId || !ensureOverlayInstance()) return;
    if (overlay.channelId !== channelId || reveal || thread) overlay.closeSettings?.();
    overlay.channelId = channelId;
    overlay.titleEl.textContent = '';
    overlay.topicEl.textContent = '';
    void loadOverlayHeader(channelId);
    const ready = Promise.resolve(overlay.instance.setChannel(channelId, { reveal })).then(async loaded => {
      if (thread && !reveal) await overlay.instance?.openThread?.(thread);
      return loaded !== false;
    });
    showOverlay();
    if (windowMode === 'docked') overlay.window.setMode('docked');
    if (overlay.windowMode === 'minimized') overlay.window.restore();
    if (silent || window.Portal?.navigation?.applying) {
      overlay.root.classList.add('open');
    } else window.Portal?.navigation?.push?.({channelsOverlay:channelId, channelWindow:overlay.windowMode, channelPinned:overlay.pinned ? '1' : null}, {ownedKeys:['channelsOverlay']});
    return ready;
  }

  function openOverlayView(view){
    if (!ensureOverlayInstance()) return;
    overlay.closeSettings?.();
    const views = {
      unreads:['All Unreads', 'fa-inbox'],
      activity:['Activity', 'fa-bell'],
      threads:['Threads', 'fa-comments'],
      saved:['Later', 'fa-bookmark']
    };
    const target = views[view];
    if (!target) return;
    overlay.channelId = '';
    overlay.titleEl.innerHTML = `<i class="fas ${target[1]}"></i><span></span>`;
    overlay.titleEl.lastChild.textContent = target[0];
    overlay.topicEl.textContent = '';
    void overlay.instance.openView?.(view);
    showOverlay();
  }

  function closeOverlay({ silent = false } = {}){
    overlay.closeSettings?.();
    if (!overlay.root || !overlay.openFlag) return;
    if (!silent && !window.Portal?.navigation?.applying && window.Portal?.navigation?.read?.().channelsOverlay) {
      const result = window.Portal.navigation.backOrClose(['channelsOverlay'], {channelsOverlay:null, channelWindow:null, channelPinned:null});
      if (result?.backed) return;
    }
    overlay.instance?.detachCall?.();
    overlay.openFlag = false;
    overlay.window.setVisible(false);
    overlay.channelId = '';
    overlay.root.classList.remove('open');
    clearTimeout(overlay.closeTimer);
    overlay.closeTimer = setTimeout(() => {
      overlay.root.hidden = true;
      if (!overlay.instance?.state?.inCall) { overlay.instance?.destroy?.(); overlay.instance = null; }
    }, 280);
    window.dispatchEvent(new CustomEvent('fm:channels-overlay:closed'));
  }

  window.FirstMateChannelsOverlay = {
    open: openOverlay, openView: openOverlayView, close: closeOverlay, isOpen: () => overlay.openFlag,
    canOpenSettings,
    openSettings(){
      if (!canOpenSettings() || !ensureOverlayInstance()) return;
      if (!overlay.channelId) overlay.titleEl.textContent = 'Channels';
      showOverlay(); openSettings(overlay);
    }
  };

  // Actively choosing an app must bring that app forward — otherwise the
  // conversation keeps covering it and the click looks like it did nothing.
  window.addEventListener('fm:portal-tab:activated', (event) => {
    if (event.detail?.isInitial) return;
    if (overlay.openFlag && overlay.instance?.state?.inCall) overlay.instance.detachCall?.();
    if (overlay.openFlag && !overlay.pinned && !['docked','minimized','floating'].includes(overlay.windowMode)) {
      closeOverlay({silent:true});
      window.Portal?.navigation?.replace?.({channelsOverlay:null, channelWindow:null, channelPinned:null});
    }
  });

  async function openChannelMessage(detail = {}){
    if (!detail.channel_id) return false;
    if (sidebarModeEnabled()) {
      if (window.Portal?.navigation?.applying) await window.Portal.navigation.applyCurrent();
      return await openOverlay(detail.channel_id, {reveal:detail.message_id, thread:detail.parent_id});
    }
    const navigation = window.Portal?.navigation;
    if (!navigation) return false;
    navigation.navigate({tab:'channels', channel:detail.channel_id, channelThread:detail.parent_id || null, channelMessage:detail.message_id || null}, {source:'message-notification',ownedKeys:['tab','channel','channelThread','channelMessage']});
    await navigation.applyCurrent?.();
    return true;
  }
  window.FirstMateChannelsNavigation = {openMessage:openChannelMessage};
  window.addEventListener('fm:open-channel-message', event => { void openChannelMessage(event.detail); });

  // --- portal tab registration ------------------------------------------------
  // In integrated sidebar mode the standalone app icon disappears from the
  // left column; the global rail + overlay replace it.

  let registered = false;

  function syncRegistration(){
    const integrated = sidebarModeEnabled();
    if (integrated && registered) {
      window.Portal?.apps?.unregisterPortalApp?.('channels');
      registered = false;
    } else if (!integrated && !registered) {
      window.Portal?.apps?.registerPortalApp?.({
        id: 'portal.channels',
        tabId: 'channels',
        title: (globalThis.PlatformLanguage?.text("channels","m_dc8b4f6c066b30","Channels") ?? "Channels"),
        terminologyKey: 'channels.portal_tab',
        icon: 'fa-comments',
        order: 44,
        fullBleed: true,
        mount
      });
      registered = true;
    }
    if (!integrated && overlay.openFlag) closeOverlay();
  }

  window.addEventListener('fm:app-flags:updated', syncRegistration);
  window.addEventListener('fm:app-flags:failed', syncRegistration);
  window.addEventListener('fm:user-preferences:updated', syncRegistration);
  window.addEventListener('fm:platform-session:updated', syncRegistration);
  syncRegistration();
})();
