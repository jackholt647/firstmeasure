/* libraries/platform-notifications/platform-notifications.js
 * Browser helper for Platform notification records and per-user state.
 */
(function(){
  const root = window;
  const PlatformAPI = root.PlatformAPI;
  const listeners = new Set();
  let state = { notifications: [], dismissed_notifications: [], unread_count: 0, active_count: 0, loaded_at: null };
  let knownIds = new Set();

  function notify(){
    listeners.forEach((fn) => {
      try { fn({ ...state }); } catch (error) {}
    });
  }

  function isToday(value){
    if (!value) return false;
    const date = new Date(value);
    const today = new Date();
    return !Number.isNaN(date.getTime())
      && date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
  }

  function isCelebrationNotification(item){
    if (String(item?.kind || '').toLowerCase() === 'celebration') return true;
    const celebration = item?.celebration || item?.context?.celebration;
    return !!celebration
      && typeof celebration === 'object'
      && !Array.isArray(celebration)
      && Object.keys(celebration).length > 0;
  }

  function wasAutoCompletedByCelebrationBug(item){
    if (isCelebrationNotification(item) || !item?.user_state?.completed_at) return false;
    const createdAt = new Date(item.created_at || '').getTime();
    const completedAt = new Date(item.user_state.completed_at).getTime();
    return Number.isFinite(createdAt)
      && Number.isFinite(completedAt)
      && completedAt >= createdAt
      && completedAt - createdAt <= 2000;
  }

  async function load(orgId, options = {}){
    if (!PlatformAPI?.notifications || !orgId) return state;
    const data = await PlatformAPI.notifications.list(orgId, options);
    const nextNotifications = Array.isArray(data.notifications) ? data.notifications : [];
    await root.PlatformCelebrations?.loadConfig?.(orgId, options.branchId || options.branch_id || root.__APP?.userBranchId || 'default').catch?.(() => null);
    const visibleNotifications = [];
    const dismissedNotifications = [];
    for (const item of nextNotifications) {
      if (isCelebrationNotification(item)) {
        const id = String(item?.id || '');
        if (id && !knownIds.has(id) && !item?.user_state?.completed_at) {
          root.PlatformCelebrations?.fromNotification?.(item);
          setState(orgId, id, { completed: true }, { ...options, reload: false }).catch(() => null);
        }
        continue;
      }
      if (wasAutoCompletedByCelebrationBug(item)) {
        item.user_state = { ...(item.user_state || {}) };
        delete item.user_state.completed_at;
        setState(orgId, String(item.id || ''), { completed: false }, { ...options, reload: false }).catch(() => null);
      }
      if (item?.user_state?.dismissed_at) {
        if (!item?.user_state?.completed_at && isToday(item.user_state.dismissed_at)) dismissedNotifications.push(item);
        continue;
      }
      if (!item?.user_state?.completed_at) visibleNotifications.push(item);
    }
    const newNotification = state.loaded_at && visibleNotifications.some((item) => {
      const id = String(item?.id || '');
      return id && !knownIds.has(id) && !item?.user_state?.seen_at;
    });
    state = {
      notifications: visibleNotifications,
      dismissed_notifications: dismissedNotifications,
      unread_count: visibleNotifications.filter((item) => !item?.user_state?.seen_at).length,
      active_count: visibleNotifications.length,
      loaded_at: new Date().toISOString(),
    };
    knownIds = new Set(nextNotifications.map((item) => String(item?.id || '')).filter(Boolean));
    if (newNotification && options.silent !== true) playNotificationIndicator();
    notify();
    return state;
  }

  function playNotificationIndicator(){
    if (root.PlatformCelebrations?.indicator) {
      root.PlatformCelebrations.indicator();
      return;
    }
    try {
      const AudioCtx = root.AudioContext || root.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      gain.connect(ctx.destination);
      [659.25, 880].forEach((freq, index) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + index * 0.08);
        osc.connect(gain);
        osc.start(now + index * 0.08);
        osc.stop(now + 0.38 + index * 0.08);
      });
      setTimeout(() => ctx.close?.().catch?.(() => null), 700);
    } catch (error) {}
  }

  async function setState(orgId, notificationId, patch = {}, options = {}){
    if (!PlatformAPI?.notifications || !orgId || !notificationId) return null;
    const result = await PlatformAPI.notifications.setUserState(orgId, notificationId, patch);
    if (options.reload !== false) await load(orgId, options);
    return result?.state || result;
  }

  function subscribe(fn){
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    fn({ ...state });
    return () => listeners.delete(fn);
  }

  root.PlatformNotifications = {
    subscribe,
    getState(){ return { ...state }; },
    load,
    markSeen(orgId, notificationId, options = {}){ return setState(orgId, notificationId, { seen: true }, options); },
    dismiss(orgId, notificationId, options = {}){ return setState(orgId, notificationId, { dismissed: true }, options); },
    restore(orgId, notificationId, options = {}){ return setState(orgId, notificationId, { dismissed: false }, options); },
    complete(orgId, notificationId, options = {}){ return setState(orgId, notificationId, { completed: true }, options); },
    create(orgId, notification){ return PlatformAPI.notifications.create(orgId, notification); },
  };
})();
