(function (global) {
  'use strict';

  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  let gisPromise = null;
  let clientPromise = null;
  let initializedClientId = '';
  let activeEntry = null;
  const entries = [];

  function apiError(data, status) {
    const error = new Error(String(data && data.message || 'Google sign-in could not be completed.'));
    error.code = String(data && data.error || 'google_auth_failed');
    error.status = status;
    error.details = data && data.details || null;
    return error;
  }

  function loadGis() {
    if (global.google && global.google.accounts && global.google.accounts.id) return Promise.resolve(global.google);
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
      const script = existing || document.createElement('script');
      const done = () => global.google && global.google.accounts
        ? resolve(global.google)
        : reject(new Error('Google Identity Services did not initialize.'));
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', () => reject(new Error('Could not load Google Identity Services.')), { once: true });
      if (!existing) {
        script.src = GIS_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    });
    return gisPromise;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = element;
    while (current && current !== document.documentElement) {
      const style = global.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }
    return true;
  }

  async function postCredential(entry, credential, extraPayload) {
    const built = typeof entry.buildPayload === 'function' ? await entry.buildPayload() : {};
    const payload = { ...(built || {}), ...(extraPayload || {}), credential };
    const response = await fetch(`${entry.apiBaseUrl}/auth/google`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = apiError(data, response.status);
      if (error.code === 'google_registration_required' && typeof entry.onRegistrationRequired === 'function') {
        entry.onRegistrationRequired({
          profile: error.details && error.details.profile || {},
          complete: (details) => postCredential(entry, credential, details)
        });
        return null;
      }
      throw error;
    }
    if (typeof entry.onSuccess === 'function') entry.onSuccess(data);
    return data;
  }

  async function handleCredential(response) {
    const visibleEntries = entries.filter((entry) => isVisible(entry.container));
    const entry = activeEntry && visibleEntries.includes(activeEntry) ? activeEntry : visibleEntries[0] || activeEntry;
    if (!entry) return;
    try {
      await postCredential(entry, String(response && response.credential || ''), null);
    } catch (error) {
      if (typeof entry.onError === 'function') entry.onError(error);
    }
  }

  async function getClientId(apiBaseUrl) {
    const response = await fetch(`${apiBaseUrl}/auth/google/config`, {
      credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.enabled || !data.client_id) throw apiError(data, response.status);
    return String(data.client_id);
  }

  async function ensureInitialized(apiBaseUrl) {
    if (!clientPromise) {
      clientPromise = Promise.all([loadGis(), getClientId(apiBaseUrl)]).then(([google, clientId]) => {
        initializedClientId = clientId;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: handleCredential,
          auto_select: false,
          cancel_on_tap_outside: true
        });
        return google;
      });
    }
    return clientPromise;
  }

  async function mountButton(options) {
    const container = options && options.container;
    const apiBaseUrl = String(options && options.apiBaseUrl || '').replace(/\/$/, '');
    if (!container || !apiBaseUrl) throw new Error('Google sign-in requires a container and API base URL.');
    const entry = {
      container,
      apiBaseUrl,
      buildPayload: options.buildPayload,
      onSuccess: options.onSuccess,
      onRegistrationRequired: options.onRegistrationRequired,
      onError: options.onError
    };
    entries.push(entry);
    container.addEventListener('pointerenter', () => { activeEntry = entry; });
    container.addEventListener('focusin', () => { activeEntry = entry; });
    const google = await ensureInitialized(apiBaseUrl);
    if (initializedClientId) {
      google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'rectangular',
        text: options.text === 'signup_with' ? 'signup_with' : 'signin_with',
        logo_alignment: 'center',
        width: Math.max(200, Math.floor(container.clientWidth || container.getBoundingClientRect().width || 320))
      });
    }
    return { submit: (credential, details) => postCredential(entry, credential, details) };
  }

  global.FirstMateGoogleAuth = Object.freeze({ mountButton });
})(window);
