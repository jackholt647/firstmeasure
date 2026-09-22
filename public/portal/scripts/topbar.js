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

  function closeNotificationMenus(){
    notificationMenus().forEach((menu) => menu.classList.remove('visible'));
    document.body.classList.remove('mobile-notifications-open');
  }

  function setMobileNotificationsVisible(visible){
    const mobileTopbar = $('.mobile-topbar');
    const notifications = $('#mobilePlatformNotifications');
    const more = $('#mobilePlatformMoreSlot');
    mobileTopbar?.classList.toggle('topbar-enabled', !!visible);
    if (notifications) notifications.hidden = !visible;
    if (more) more.hidden = !visible;
  }

  // --- Mobile consolidated "More" menu --------------------------------------
  // On phones the assistant, messages, and notifications actions collapse into
  // a single topbar button whose menu proxies to the real controls.

  function closeMoreMenu(){
    $('#mobilePlatformMoreMenu')?.classList.remove('visible');
  }

  function syncMoreMenu(){
    const assistantItem = $('#mobilePlatformMoreAssistant');
    const messagesItem = $('#mobilePlatformMoreMessages');
    if (assistantItem) assistantItem.hidden = $('#mobilePlatformAssistantSlot')?.hidden === true;
    if (messagesItem) messagesItem.hidden = $('#mobilePlatformMessagesSlot')?.hidden === true;
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
    mountLeft: mountTopbarLeft,
    releaseLeft: releaseTopbarLeft,
    leftOwner: () => leftSlotOwner
  };

  // --- Messages dropdown (personal channels inbox) --------------------------

  let messagesInbox = { entries: [], unread_total: 0 };

  function messagesAllowed(){
    try {
      if (window.Portal?.can && window.Portal?.capabilities?.can) return window.Portal.can('apps.channels') !== false;
    } catch (_) {}
    return true;
  }

  function updateMessagesVisibility(){
    const allowed = lastTopbarVisible && messagesAllowed() && !!window.ChannelsAPI;
    const desktop = $('#platformMessagesSlot');
    const mobile = $('#mobilePlatformMessagesSlot');
    if (desktop) desktop.hidden = !allowed;
    if (mobile) mobile.hidden = !allowed;
  }

  function messagesMenus(){
    return Array.from(document.querySelectorAll('#platformMessagesMenu, #mobilePlatformMessagesMenu'));
  }

  function closeMessagesMenus(){
    messagesMenus().forEach((menu) => menu.classList.remove('visible'));
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
    channel: { icon:'fa-hashtag', label:(globalThis.PlatformLanguage?.text("platform","m_4c04db54662b57","new messages") ?? "new messages") }
  };

  function messageEntryHtml(entry, index){
    const meta = MESSAGE_KIND_META[entry.kind] || MESSAGE_KIND_META.channel;
    const who = escapeHtml(cleanText(entry.author?.name) || 'Someone');
    const line = entry.kind === 'reaction'
      ? `<b>${who}</b> reacted ${escapeHtml(cleanText(entry.emoji))} to your message`
      : entry.kind === 'channel'
        ? `<b>${escapeHtml(cleanText(entry.channel_name))}</b> · ${Number(entry.count || 0)} new`
        : `<b>${who}</b> ${meta.label}`;
    return `
      <div class="ptb-msg-row ${entry.unread ? 'unread' : ''}" data-message-entry="${index}">
        <span class="ptb-msg-ico"><i class="fas ${meta.icon}"></i></span>
        <span class="ptb-msg-main">
          <span class="ptb-msg-line">${line}</span>
          <span class="ptb-msg-snippet">${escapeHtml(cleanText(entry.text))}</span>
          <span class="ptb-msg-snippet" style="font-size:10.5px;color:#98a2b3;font-weight:700">${escapeHtml(cleanText(entry.channel_name))}</span>
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

  function openMessageEntry(entry){
    closeMessagesMenus();
    if (entry.channel_type === 'project' && cleanText(entry.project_id)) {
      window.Portal?.navigation?.navigate?.({
        project: cleanText(entry.project_id),
        projectTab: 'materials',
        projectNote: cleanText(entry.message_id) || null
      }, { source:'messages-inbox' });
      return;
    }
    window.Portal?.navigation?.navigate?.({
      tab:'channels',
      channel: cleanText(entry.channel_id),
      channelThread: cleanText(entry.parent_id) || null,
      channelMessage: cleanText(entry.message_id) || null
    }, { source:'messages-inbox', ownedKeys:['channel', 'channelThread', 'channelMessage'] });
    window.dispatchEvent(new CustomEvent('fm:open-channel-message', { detail:{
      channel_id: cleanText(entry.channel_id),
      message_id: cleanText(entry.message_id),
      parent_id: cleanText(entry.parent_id)
    } }));
  }

  function renderMessagesList(){
    ['#platformMessagesList', '#mobilePlatformMessagesList'].forEach((selector) => {
      const list = $(selector);
      if (!list) return;
      const entries = messagesInbox.entries || [];
      list.innerHTML = entries.length
        ? entries.map((entry, index) => messageEntryHtml(entry, index)).join('')
        : `<div class="ptb-empty">${(globalThis.PlatformLanguage?.text("platform","m_56ea1e42b41667","No messages need your attention.") ?? "No messages need your attention.")}<br>${(globalThis.PlatformLanguage?.text("platform","m_fcc1bb46a8b161","Mentions, DMs, replies, and reactions land here.") ?? "Mentions, DMs, replies, and reactions land here.")}</div>`;
      list.querySelectorAll('[data-message-entry]').forEach((row) => {
        row.addEventListener('click', () => {
          const entry = (messagesInbox.entries || [])[Number(row.dataset.messageEntry)];
          if (entry) openMessageEntry(entry);
        });
      });
    });
  }

  async function loadMessagesInbox(){
    if (!window.ChannelsAPI?.readState?.inbox || !orgId() || !messagesAllowed()) return;
    try {
      const data = await window.ChannelsAPI.readState.inbox(orgId());
      messagesInbox = { entries: data.entries || [], unread_total: Number(data.unread_total || 0) };
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

  function openProject(project){
    if (!project?.id) return;
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project } }));
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

  function isLeadNotification(item = {}){
    const title = String(item.title || '').toLowerCase();
    const source = String(item.source || item.context?.lead_source || '').toLowerCase();
    return !!(item.context?.project_id || item.data?.project_id) && (
      title.includes('lead') || source.includes('lead') || source.includes('email') || source.includes('canvassing')
    );
  }

  function leadTitle(item = {}){
    return isLeadNotification(item) ? 'Contact new lead' : (item.title || (globalThis.PlatformLanguage?.text("platform","m_8afbfeae955a57","Notification") ?? "Notification"));
  }

  async function openNotificationProject(item = {}){
    const action = item.frontend_action && typeof item.frontend_action === 'object' ? item.frontend_action : {};
    const projectId = String(action.project_id || action.projectId || item.context?.project_id || item.data?.project_id || '').trim();
    if (!projectId || !window.PlatformAPI?.projects?.get || !orgId()) return false;
    try {
      const result = await window.PlatformAPI.projects.get(orgId(), projectId);
      const data = result?.document?.data || null;
      if (!data) return false;
      const project = { id: projectId, ...data };
      openProject(project);
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
    window.Portal?.navigation?.navigate?.({
      tab:'channels',
      channel:channelId,
      channelThread:String(action.parent_id || '').trim() || null,
      channelMessage:String(action.message_id || '').trim() || null
    }, {
      source:'notification-channel-message',
      ownedKeys:['channel', 'channelThread', 'channelMessage']
    });
    window.dispatchEvent(new CustomEvent('fm:open-channel-message', { detail:{
      channel_id: channelId,
      message_id: String(action.message_id || '').trim(),
      parent_id: String(action.parent_id || '').trim()
    } }));
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
    const opened = await openNotificationProject({ frontend_action:{ ...action, kind:'open_project' } });
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
    const types = window.FirstMateArtifactSearch?.TYPES || [];
    return `<div class="ptb-search-filterbar" aria-label="${(globalThis.PlatformLanguage?.text("platform","m_682192c2691773","Search result types") ?? "Search result types")}">
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

  function renderSearchResults(input, box, results = []){
    if (!box) return;
    searchResultCache.clear();
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
    const empty = enabledSearchTypes.size ? 'No matches' : 'Select at least one result type';
    box.innerHTML = `${searchFiltersHtml()}<div class="ptb-search-result-list">${html || `<div class="ptb-empty">${empty}</div>`}</div>`;
    box.classList.add('visible');
    bindSearchFilters(box, input);
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
    box.innerHTML = (String(searchFiltersHtml()) + "<div class=\"ptb-search-result-list\"><div class=\"ptb-empty\">" + (globalThis.PlatformLanguage?.text("platform","m_1868baee889a75","Searching...") ?? "Searching...") + "</div></div>");
    box.classList.add('visible');
    bindSearchFilters(box, input);
    const platformTypes = ['project','contact'].filter((type) => enabledSearchTypes.has(type));
    const artifactPromise = window.FirstMateArtifactSearch?.search?.(query, {
      orgId:orgId(), branchId:branchId(), types:[...enabledSearchTypes].filter((type) => !platformTypes.includes(type)), limit:100
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
        ${item.manual_dismissible && !isLeadNotification(item) ? `<button type="button" class="ptb-note-dismiss" data-dismiss-note="${String(escapeHtml(item.id))}" aria-label="${(globalThis.PlatformLanguage?.text("platform","m_63fc9fb260d3a6","Mark notification done") ?? "Mark notification done")}" title="${(globalThis.PlatformLanguage?.text("platform","m_8e85dc2d122c71","Mark done") ?? "Mark done")}"><i class="fas fa-check" aria-hidden="true"></i></button>` : ''}
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
        <button type="button" class="ptb-note-restore" data-restore-note="${String(escapeHtml(item.id))}" aria-label="${(globalThis.PlatformLanguage?.text("platform","m_a38ee26b78adc6","Restore notification") ?? "Restore notification")}" title="${(globalThis.PlatformLanguage?.text("platform","m_a38ee26b78adc6","Restore notification") ?? "Restore notification")}"><i class="fas fa-rotate-left" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.text("platform","m_4004b71744b54e","Undo") ?? "Undo")}</span></button>
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
        ${String(entry.state || '') === 'waiting' ? ("<i class=\"fas fa-hourglass-half ptb-note-pinned-wait\" aria-hidden=\"true\" title=\"" + (globalThis.PlatformLanguage?.text("platform","m_c84286da8f58e9","Waiting") ?? "Waiting") + "\"></i>") : ''}
      </div>
    `;
  }

  function notificationListHtml(notifications, dismissed, dismissedOpen, pinned = []){
    const pinnedHtml = pinned.length ? pinned.map(pinnedAttentionHtml).join('') : '';
    const activeHtml = notifications.length
      ? notifications.map(activeNotificationHtml).join('')
      : `<div class="ptb-empty">${(globalThis.PlatformLanguage?.text("platform","m_ef1f67ca1f3465","You're all caught up.") ?? "You're all caught up.")}</div>`;
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
        window.PlatformNotifications?.markSeen(orgId(), node.dataset.noteId, notificationLoadOptions({ reload:true })).catch(() => null);
        if (openChatNotification(item)) {
          closeNotificationMenus();
        } else if (openMerchantPortalNotification(item)) {
          closeNotificationMenus();
        } else if (await openCommsNotification(item)) {
          closeNotificationMenus();
        } else if (openChannelMessageNotification(item)) {
          closeNotificationMenus();
        } else if (openMentionNotification(item)) {
          closeNotificationMenus();
        } else if (notificationOpensProject(item) || isLeadNotification(item)) {
          await openNotificationProject(item);
          closeNotificationMenus();
        }
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
      count.textContent = total > 99 ? '99+' : String(total || 0);
      count.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      count.classList.toggle('visible', total > 0);
      count.classList.toggle('has-unread', unread > 0);
    }
    if (mobileCount) {
      mobileCount.textContent = total > 99 ? '99+' : String(total || 0);
      mobileCount.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      mobileCount.classList.toggle('visible', total > 0);
      mobileCount.classList.toggle('has-unread', unread > 0);
    }
    if (menuHead) {
      menuHead.innerHTML = `<span>${(globalThis.PlatformLanguage?.text("platform","m_5a9115e4033cb3","Notifications") ?? "Notifications")}</span><small>${((v0,v1) => globalThis.PlatformLanguage?.text("platform","m_6d30e375168449",`${v0} unread &middot; ${v1} total`,{v0,v1}) ?? `${v0} unread &middot; ${v1} total`)(unread,total)}</small>`;
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
      });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.platform-search')) closeSearchResults();
      if (!event.target.closest('.platform-notifications')) closeNotificationMenus();
      if (!event.target.closest('.platform-messages')) closeMessagesMenus();
      if (!event.target.closest('.platform-more')) closeMoreMenu();
    });
    $('#mobilePlatformMoreBtn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = $('#mobilePlatformMoreMenu');
      const opening = !menu?.classList.contains('visible');
      closeMessagesMenus();
      closeNotificationMenus();
      syncMoreMenu();
      menu?.classList.toggle('visible', opening);
    });
    $('#mobilePlatformMoreAssistant')?.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMoreMenu();
      window.PlatformAssistant?.toggle?.();
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
    [
      { button: '#platformMessagesBtn', menu: '#platformMessagesMenu' },
      { button: '#mobilePlatformMessagesBtn', menu: '#mobilePlatformMessagesMenu' }
    ].forEach(({ button, menu }) => {
      $(button)?.addEventListener('click', async (event) => {
        event.stopPropagation();
        const targetMenu = $(menu);
        const opening = !targetMenu?.classList.contains('visible');
        closeMessagesMenus();
        closeNotificationMenus();
        targetMenu?.classList.toggle('visible', opening);
        if (opening) {
          await loadMessagesInbox();
          // Opening acknowledges reply/reaction items; mentions and DMs stay
          // unread until the conversation itself is read.
          window.ChannelsAPI?.readState?.inboxSeen?.(orgId()).catch(() => null);
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
        await window.PlatformNotifications?.load(orgId(), notificationLoadOptions()).catch(() => null);
        const targetMenu = $(menu);
        const opening = !targetMenu?.classList.contains('visible');
        // Only one topbar dropdown at a time.
        closeNotificationMenus();
        closeMessagesMenus();
        targetMenu?.classList.toggle('visible', opening);
        document.body.classList.toggle('mobile-notifications-open', opening && menu === '#mobilePlatformNotificationMenu');
      });
    });
    ['#platformAssistantBtn', '#mobilePlatformAssistantBtn'].forEach((selector) => {
      $(selector)?.addEventListener('click', (event) => {
        event.stopPropagation();
        window.PlatformAssistant?.toggle?.();
      });
    });
    updateAssistantVisibility(true);
    window.addEventListener('fm:capabilities:updated', () => { updateAssistantVisibility(); updateMessagesVisibility(); });
    window.PlatformNotifications?.subscribe(renderNotifications);
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
