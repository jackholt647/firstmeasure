/* Native push bridge for the core FirstMate Android and iOS app. */
(function(){
  const categories = [
    ['leads','Leads'], ['messages','Messages'], ['mentions','Mentions'], ['tasks','Tasks'],
    ['scheduling','Scheduling'], ['payments','Payments'], ['celebrations','Celebrations'], ['measurements','Measurements'], ['system','System']
  ];
  let initialized = false;
  let registration = null;
  let registeredOrgId = '';
  const optOutKey = 'firstmate_native_push_disabled';
  const firstMateHost = async () => {
    if (!window.PhoneFeatures?.isNative?.()) return null;
    const info = await window.PhoneFeatures.ready;
    return info?.capabilities?.includes?.('push') ? window.PhoneFeatures : null;
  };
  const orgId = () => String(window.__APP?.userOrgId || window.__APP?.orgId || window.Portal?.orgId || '');
  const branchId = () => String(window.__APP?.userBranchId || 'default');

  async function initialize(){
    const host = await firstMateHost();
    if (!host || initialized) return false;
    initialized = true;
    window.addEventListener('fm:native:push', (event) => {
      const id = String(event.detail?.notification_id || '');
      if (id) { sessionStorage.setItem('firstmate_pending_notification', id); window.dispatchEvent(new CustomEvent('fm:notification:open', { detail:{ id } })); }
      else window.PlatformNotifications?.load?.(orgId(), { branchId:branchId() }).catch(() => null);
    });
    const status = await host.pushStatus();
    if (status?.granted && localStorage.getItem(optOutKey) !== '1') await registerCurrentHost(host);
    return true;
  }
  async function enable(){
    const host = await firstMateHost();
    if (!host) return { available:false, reason:'Open the FirstMate mobile app to enable device push.' };
    await initialize();
    const result = await host.pushRegister();
    if (!result?.token) return { available:true, granted:false };
    localStorage.removeItem(optOutKey);
    await saveDevice(result.token, result.platform || window.PhoneFeatures.info()?.platform, result.environment);
    return { available:true, granted:true };
  }

  async function release(){
    const host = await firstMateHost();
    if (!host) return false;
    try {
      if (registration?.id && registeredOrgId) await window.PlatformAPI.notifications.unregisterDevice(registeredOrgId, registration.id);
    } finally {
      await host.pushUnregister();
    }
    registration = null;
    registeredOrgId = '';
    return true;
  }
  async function disable(){
    localStorage.setItem(optOutKey, '1');
    return release();
  }

  async function saveDevice(token, devicePlatform, environment){
    if (!orgId()) return;
    registration = (await window.PlatformAPI.notifications.registerDevice(orgId(), {
      token, platform:devicePlatform, branch_id:branchId(), environment:environment === 'development' ? 'sandbox' : 'production'
    })).device;
    registeredOrgId = orgId();
    window.dispatchEvent(new CustomEvent('fm:push:registered', { detail:registration }));
  }
  async function registerCurrentHost(host){
    const result = await host.pushRegister();
    if (result?.token) await saveDevice(result.token, result.platform || window.PhoneFeatures.info()?.platform, result.environment);
  }
  window.PlatformPush = { categories, initialize, enable, disable, release, available:() => !!window.PhoneFeatures?.info?.()?.capabilities?.includes?.('push'), registration:() => registration };
  document.addEventListener('click', async (event) => {
    const link = event.target?.closest?.('a[href$="logout.php"]');
    if (!link || !window.PhoneFeatures?.isNative?.()) return;
    event.preventDefault();
    await release().catch(() => null);
    window.location.href = link.href;
  }, true);
  window.addEventListener('fm:platform-session:updated', async () => {
    if (localStorage.getItem(optOutKey) === '1' || registration || !orgId()) return;
    try {
      const host = await firstMateHost();
      if (host && (await host.pushStatus())?.granted) await registerCurrentHost(host);
    } catch (error) { console.error('Push device registration failed', error); }
  });
  document.addEventListener('DOMContentLoaded', () => initialize().catch((error) => console.error('Push setup failed', error)));
})();
