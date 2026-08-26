(function () {
  'use strict';

  const ATTR = 'data-firstmate-signup';
  const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', '_fbc', '_fbp', 'xid', 'acquisition_bonus_token', 'bonus_token'];
  const SCRIPT_SRC = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
  const TRACKING_TIMEOUT_MS = 3500;
  const SIGNUP_EMAIL_VERIFICATION_ENABLED = false;
  let googleAuthLibraryPromise = null;

  function signupPhoneDigits(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits.slice(0, 10);
  }

  function formatSignupPhone(value) {
    const digits = signupPhoneDigits(value);
    if (!digits) return '';
    if (digits.length <= 3) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function isValidSignupPhone(value) {
    const rawDigits = String(value || '').replace(/\D/g, '');
    return rawDigits.length === 10 || (rawDigits.length === 11 && rawDigits.startsWith('1'));
  }

  const styles = `
    :host {
      display: block;
      box-sizing: border-box;
      color: #172033;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .fm-auth {
      width: 100%;
      color: inherit;
    }
    .fm-tabs {
      display: flex;
      border-bottom: 1px solid #eee;
      margin: 0 -20px 0;
    }
    .fm-tab {
      appearance: none;
      flex: 1;
      border: 0;
      background: transparent;
      color: #777;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.2;
      min-height: 45px;
      padding: 14px 10px;
      text-align: center;
      border-bottom: 2px solid transparent;
    }
    .fm-tab[aria-selected="true"] {
      color: #d93025;
      border-bottom-color: #d93025;
    }
    .fm-notice {
      display: none;
      border-radius: 10px;
      margin-top: 12px;
      padding: 11px 12px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.4;
    }
    .fm-notice.is-visible { display: block; }
    .fm-notice[data-tone="success"] {
      background: #ecfdf3;
      color: #16703c;
      border: 1px solid rgba(22, 112, 60, 0.16);
    }
    .fm-notice[data-tone="error"] {
      background: #fff1f0;
      color: #b42318;
      border: 1px solid rgba(180, 35, 24, 0.16);
    }
    .fm-referral {
      display: none;
      gap: 10px;
      align-items: center;
      margin-top: 12px;
      border-radius: 12px;
      padding: 12px;
      background: #fff7ed;
      border: 1px solid rgba(217, 48, 37, 0.16);
      color: #8a1c14;
    }
    .fm-referral.is-visible { display: flex; }
    .fm-referral-logo {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      background: #fff;
      border: 1px solid rgba(217, 48, 37, 0.16);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex: 0 0 auto;
      font-size: 18px;
      font-weight: 900;
    }
    .fm-referral-logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .fm-referral-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
      font-size: 12px;
      line-height: 1.35;
    }
    .fm-referral-copy strong {
      display: block;
      color: #7c1c14;
      font-size: 13px;
    }
    .fm-form {
      display: none;
      gap: 0;
      padding-top: 18px;
    }
    .fm-form.is-active { display: grid; }
    .fm-google-block { margin-bottom: 18px; }
    .fm-google-button {
      width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: center;
      padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent;
    }
    .fm-google-button > div,
    .fm-google-button > div > div {
      width: 100% !important; max-width: none !important;
      display: flex !important; justify-content: center;
    }
    .fm-google-button [role="button"] {
      width: 100% !important; min-width: 100% !important; max-width: none !important;
      height: 44px !important; min-height: 44px !important;
      border: 1px solid #ddd !important; border-radius: 8px !important;
      box-shadow: none !important; color: #111 !important;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      font-size: 14px !important;
    }
    .fm-google-button [role="button"] span:not(#button-label) {
      color: #111 !important;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      font-size: 14px !important;
    }
    .fm-google-divider {
      display: flex; align-items: center; gap: 10px; margin: 20px 0 0;
      color: #8a9099; font-size: 11px; font-weight: 800; text-transform: uppercase;
    }
    .fm-google-divider::before, .fm-google-divider::after { content: ''; flex: 1; height: 1px; background: #e5e7eb; }
    .fm-field {
      display: grid;
      gap: 5px;
      margin-bottom: 15px;
    }
    .fm-label {
      color: #555;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0;
      line-height: 1.25;
      text-transform: none;
    }
    .fm-input {
      appearance: none;
      width: 100%;
      height: 40px;
      min-height: 40px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fff;
      color: #111;
      font: inherit;
      font-size: 14px;
      line-height: 1.3;
      padding: 8px 10px;
      outline: none;
    }
    .fm-input:focus {
      border-color: #d93025;
      box-shadow: none;
    }
    .fm-input[readonly] {
      background: #f7f8fa;
      color: #606a78;
    }
    .fm-recovery-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
    .fm-recovery-method {
      appearance: none; min-height: 44px; border: 1px solid #ddd; border-radius: 8px;
      background: #fff; color: #333; cursor: pointer; font: inherit; font-size: 14px; font-weight: 700;
    }
    .fm-recovery-method:hover { border-color: #d93025; color: #b0261e; }
    .fm-recovery-method.is-selected { border-color: #d93025; background: #fff5f4; color: #b0261e; }
    .fm-recovery-method:focus-visible { outline: 3px solid rgba(217,48,37,0.2); outline-offset: 2px; }
    .fm-button {
      appearance: none;
      width: 100%;
      min-height: 44px;
      border: 0;
      border-radius: 8px;
      background: #d93025;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 16px;
      font-weight: 700;
      line-height: 1.2;
      padding: 12px;
      text-align: center;
    }
    .fm-button:hover { background: #b0261e; }
    .fm-button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .fm-link-row {
      color: #555;
      font-size: 12px;
      line-height: 1.4;
      text-align: center;
      margin-top: 15px;
    }
    .fm-link {
      appearance: none;
      border: 0;
      background: transparent;
      color: #d93025;
      cursor: pointer;
      font: inherit;
      font-size: inherit;
      font-weight: 700;
      padding: 0;
      text-decoration: none;
    }
    .fm-terms {
      color: #667085;
      font-size: 11px;
      line-height: 1.45;
      text-align: center;
      margin-top: 10px;
    }
    .fm-terms a {
      color: #d93025;
      font-weight: 800;
    }
    @media (max-width: 420px) {
      .fm-tabs { margin-left: -16px; margin-right: -16px; }
    }
  `;

  function platformApiBaseUrl() {
    const host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') {
      return `${location.protocol}//${location.hostname}:3111/v1/platform`;
    }
    return `${location.origin}/v1/platform`;
  }

  function routeToPortal(path) {
    const source = SCRIPT_SRC || location.href;
    let baseHref = source;
    try {
      const url = new URL(source, location.href);
      const marker = '/landing/shared/signup-widget.js';
      if (url.pathname.endsWith(marker)) {
        url.pathname = url.pathname.slice(0, -marker.length) + '/';
        url.search = '';
        url.hash = '';
        baseHref = url.toString();
      } else {
        const landingIndex = url.pathname.indexOf('/landing/');
        if (landingIndex !== -1) {
          url.pathname = url.pathname.slice(0, landingIndex + 1);
          url.search = '';
          url.hash = '';
          baseHref = url.toString();
        }
      }
    } catch (e) {}
    const base = new URL(baseHref, location.href);
    return new URL(path, base).toString();
  }

  function loadGoogleAuthLibrary() {
    if (window.FirstMateGoogleAuth) return Promise.resolve(window.FirstMateGoogleAuth);
    if (googleAuthLibraryPromise) return googleAuthLibraryPromise;
    googleAuthLibraryPromise = new Promise((resolve, reject) => {
      const source = SCRIPT_SRC
        ? new URL('../../../libraries/google-auth/firstmate-google-auth.js', SCRIPT_SRC).toString()
        : '/libraries/google-auth/firstmate-google-auth.js';
      const existing = document.querySelector(`script[src="${source}"]`);
      const script = existing || document.createElement('script');
      script.addEventListener('load', () => window.FirstMateGoogleAuth
        ? resolve(window.FirstMateGoogleAuth)
        : reject(new Error('Google sign-in library did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Google sign-in library could not be loaded.')), { once: true });
      if (!existing) {
        script.src = source;
        script.async = true;
        document.head.appendChild(script);
      }
    });
    return googleAuthLibraryPromise;
  }

  function normalizeBool(value, fallback) {
    if (value == null || value === '') return fallback;
    return !/^(0|false|no|off)$/i.test(String(value));
  }

  function emit(host, name, detail) {
    host.dispatchEvent(new CustomEvent(`firstmate:${name}`, {
      bubbles: true,
      composed: true,
      detail: detail || {}
    }));
  }

  function safeText(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    return text || fallback || '';
  }

  function formatOffer(offer, fallback) {
    if (!offer) return fallback || '';
    const title = safeText(offer.title || offer.name || offer.headline, '');
    if (title) return title;
    const percent = offer.discount_percent || offer.percent_off || offer.discountPercent;
    const days = offer.window_days || offer.days || offer.windowDays;
    if (percent && days) return `Get ${percent}% off orders for your first ${days} days.`;
    if (percent) return `Get ${percent}% off eligible orders.`;
    return fallback || '';
  }

  function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function existingPageAcquisitionTracking() {
    return window.__firstMateAcquisitionTracking || null;
  }

  function setPageAcquisitionTracking(value) {
    window.__firstMateAcquisitionTracking = value;
    return value;
  }

  function buildWidget(host) {
    if (host.__firstMateSignupMounted) return;
    host.__firstMateSignupMounted = true;

    const params = new URLSearchParams(location.search);
    const shadow = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = styles;

    const initialMode = String(host.dataset.mode || params.get('start') || params.get('mode') || 'register').toLowerCase();
    const showLogin = normalizeBool(host.dataset.showLogin, true);
    const referralSetting = String(host.dataset.referral || 'auto').toLowerCase();
    const referralCode = (referralSetting === 'none' ? '' : (host.dataset.referralCode || params.get('ref') || '')).trim().toUpperCase();
    const landingVariant = String(host.dataset.landingVariant || params.get('variant') || '').trim();
    const campaignCode = String(host.dataset.campaign || host.dataset.campaignCode || params.get('cid') || params.get('campaign') || params.get('campaign_code') || params.get('utm_campaign') || '').trim();
    const campaignType = String(host.dataset.campaignType || params.get('campaign_type') || params.get('utm_source') || '').trim();
    const bonusToken = String(host.dataset.offerToken || host.dataset.bonusToken || params.get('xid') || params.get('acquisition_bonus_token') || params.get('bonus_token') || '').trim();
    const redirectTarget = host.dataset.redirect || params.get('redirect') || routeToPortal('./');
    const showTerms = normalizeBool(host.dataset.showTerms, true);
    const showReferralCard = normalizeBool(host.dataset.showReferralCard, true);
    const offerVisibility = String(host.dataset.offerVisibility || 'auto').toLowerCase();
    const title = safeText(host.dataset.title, 'Create your FirstMate account');
    const submitLabel = safeText(host.dataset.submitLabel, referralCode ? 'Claim invitation' : 'Create account');

    const root = document.createElement('div');
    root.className = 'fm-auth';
    root.innerHTML = `
      <div class="fm-tabs" part="tabs" ${showLogin ? '' : 'hidden'}>
        <button class="fm-tab" type="button" data-tab="register" aria-selected="true">Create Account</button>
        <button class="fm-tab" type="button" data-tab="login" aria-selected="false">Login</button>
      </div>
      <div class="fm-notice" data-notice></div>
      <div class="fm-referral" data-referral-card>
        <div class="fm-referral-logo" data-referral-logo></div>
        <div class="fm-referral-copy">
          <strong data-referral-title>Partner invitation</strong>
          <span data-referral-copy>Sign up today to activate your referral offer.</span>
        </div>
      </div>
      <form class="fm-form" data-form="register" novalidate>
        <input type="hidden" name="referral_code" value="">
        <input type="hidden" name="referral_attribution_id" value="">
        <input type="hidden" name="acquisition_code" value="">
        <input type="hidden" name="acquisition_attribution_id" value="">
        <input type="hidden" name="campaign" value="">
        <input type="hidden" name="xid" value="">
        <input type="hidden" name="acquisition_bonus_token" value="">
        <input type="hidden" name="landing_variant" value="">
        <div class="fm-google-block">
          <div class="fm-google-button" data-google-register aria-label="Sign up with Google"></div>
          <div class="fm-google-divider"><span>or create with email</span></div>
        </div>
        <div class="fm-field">
          <label class="fm-label">Phone</label>
          <input class="fm-input" type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="(555) 555-0123" maxlength="14" required>
        </div>
        <div class="fm-field">
          <label class="fm-label">Email</label>
          <input class="fm-input" type="email" name="email" autocomplete="email" required>
        </div>
        <div class="fm-field fm-password-field">
          <label class="fm-label">Password</label>
          <input class="fm-input" type="password" name="password" autocomplete="new-password" minlength="6" required>
        </div>
        <div class="fm-field fm-password-field">
          <label class="fm-label">Confirm Password</label>
          <input class="fm-input" type="password" name="confirm_password" autocomplete="new-password" minlength="6" required>
        </div>
        <div class="fm-notice" data-register-notice role="alert" aria-live="polite"></div>
        <button class="fm-button" type="submit">${submitLabel}</button>
        ${showLogin ? '<div class="fm-link-row">Already have an account? <button class="fm-link" type="button" data-action="login">Login</button></div>' : ''}
        ${showTerms ? '<div class="fm-terms">By creating an account, you agree to our <a href="' + routeToPortal('terms/') + '" target="_blank" rel="noopener">Terms of Use</a> and that we may text you at the number above. Msg and data rates may apply.</div>' : ''}
      </form>
      <form class="fm-form" data-form="login" novalidate>
        <div class="fm-google-block">
          <div class="fm-google-button" data-google-login aria-label="Sign in with Google"></div>
          <div class="fm-google-divider"><span>or use your account</span></div>
        </div>
        <div class="fm-field">
          <label class="fm-label">Email or phone</label>
          <input class="fm-input" type="text" name="identifier" autocomplete="username" required>
        </div>
        <div class="fm-field">
          <label class="fm-label">Password</label>
          <input class="fm-input" type="password" name="password" autocomplete="current-password" required>
        </div>
        <button class="fm-button" type="submit">Login</button>
        <div class="fm-link-row"><button class="fm-link" type="button" data-action="forgot">Forgot password?</button></div>
      </form>
      <form class="fm-form" data-form="forgot" novalidate>
        <div class="fm-link-row">${title ? 'How would you like to reset your password?' : ''}</div>
        <input type="hidden" name="delivery_channel" value="">
        <div class="fm-recovery-methods" role="group" aria-label="Password reset method">
          <button class="fm-recovery-method" type="button" data-recovery-method="email" aria-pressed="false">Email</button>
          <button class="fm-recovery-method" type="button" data-recovery-method="phone" aria-pressed="false">Phone</button>
        </div>
        <div data-recovery-details hidden>
          <div class="fm-field">
            <label class="fm-label" data-recovery-label>Email</label>
            <input class="fm-input" type="email" name="identifier" autocomplete="email" required>
          </div>
          <button class="fm-button" type="submit">Send Code</button>
        </div>
        <div class="fm-link-row"><button class="fm-link" type="button" data-action="login">Back to login</button></div>
      </form>
      <form class="fm-form" data-form="otp" novalidate>
        <div class="fm-link-row"><span data-otp-message>Enter the code sent to</span> <strong data-otp-email></strong>.</div>
        <div class="fm-field">
          <label class="fm-label">6-Digit Code</label>
          <input class="fm-input" type="text" name="otp" inputmode="numeric" pattern="[0-9]*" maxlength="6" required>
        </div>
        <button class="fm-button" type="submit">Verify Code</button>
      </form>
      <form class="fm-form" data-form="reset" novalidate>
        <div class="fm-link-row">Code verified. Set a new password.</div>
        <div class="fm-field">
          <label class="fm-label">New Password</label>
          <input class="fm-input" type="password" name="new_password" autocomplete="new-password" minlength="6" required>
        </div>
        <button class="fm-button" type="submit">Update Password</button>
      </form>
    `;

    shadow.append(css, root);

    const state = {
      active: 'register',
      otpEmail: '',
      recoveryToken: '',
      recoveryIdentifier: '',
      referralCode,
      referralAttributionId: '',
      acquisitionCode: campaignCode,
      acquisitionAttributionId: '',
      acquisitionBonusToken: bonusToken,
      landingVariant,
      campaignType
    };
    let acquisitionTrackingPromise = null;

    const $ = (selector) => root.querySelector(selector);
    const $$ = (selector) => Array.from(root.querySelectorAll(selector));
    const registrationPhoneInput = $('[data-form="register"] input[name="phone"]');

    function validateRegistrationPhone() {
      if (!registrationPhoneInput) return false;
      const valid = isValidSignupPhone(registrationPhoneInput.value);
      registrationPhoneInput.setCustomValidity(valid ? '' : 'Enter a valid ten-digit mobile phone number.');
      if (valid) registrationPhoneInput.value = formatSignupPhone(registrationPhoneInput.value);
      return valid;
    }

    registrationPhoneInput?.addEventListener('input', () => {
      registrationPhoneInput.value = formatSignupPhone(registrationPhoneInput.value);
      registrationPhoneInput.setCustomValidity('');
    });
    registrationPhoneInput?.addEventListener('blur', validateRegistrationPhone);
    const signupTrackingSessionId = (() => {
      try {
        const key = 'fm_signup_tracking_session_id';
        const existing = sessionStorage.getItem(key);
        if (existing) return existing;
        const next = `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem(key, next);
        return next;
      } catch (e) {
        return `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      }
    })();
    let signupTrackingSequence = 0;

    function trackingText(value, max) {
      return String(value == null ? '' : value).trim().slice(0, max || 240);
    }

    function signupControlLabel(el) {
      if (!el) return '';
      const own = trackingText(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.textContent || '', 160);
      if (own) return own;
      const label = el.closest?.('.fm-field')?.querySelector?.('.fm-label');
      return trackingText(label?.textContent || el.name || '', 160);
    }

    function signupControlMeta(el) {
      if (!el) return {};
      const data = {};
      Object.keys(el.dataset || {}).forEach((key) => {
        if (/^(form|tab|action)$/i.test(key)) data[key] = trackingText(el.dataset[key], 120);
      });
      return {
        tag: trackingText(el.tagName || '', 40).toLowerCase(),
        name: trackingText(el.name || '', 120),
        type: trackingText(el.type || el.getAttribute?.('type') || '', 80),
        label: signupControlLabel(el),
        data,
        disabled: !!el.disabled
      };
    }

    function signupFieldValue(el) {
      if (!el) return {};
      const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
      const name = String(el.name || '').toLowerCase();
      const value = String(el.value || '');
      const base = { empty: value.trim() === '', length: value.length, input_type: type };
      if (type === 'password' || name.includes('password') || name.includes('otp') || name.includes('token') || name.includes('code')) {
        return { ...base, redacted: true };
      }
      if (type === 'email' || name.includes('email')) {
        return { ...base, has_at: value.includes('@'), domain: value.includes('@') ? trackingText(value.split('@').pop().toLowerCase(), 120) : '' };
      }
      if (type === 'tel' || name.includes('phone')) {
        return { ...base, digit_count: value.replace(/\D/g, '').length };
      }
      if (type === 'hidden') {
        return { ...base, redacted: true, populated: value.trim() !== '' };
      }
      return base;
    }

    function trackSignupInteraction(name, detail) {
      const eventId = `swe_${Date.now()}_${++signupTrackingSequence}_${Math.random().toString(36).slice(2, 7)}`;
      const payload = attributionPayload({
        event_type: `signup_${name}`,
        event_id: eventId,
        unique_event: true,
        metadata: {
          ...(detail || {}),
          event_id: eventId,
          signup_session_id: signupTrackingSessionId,
          active_mode: state.active,
          widget_mode: initialMode,
          has_referral_code: !!state.referralCode,
          has_acquisition_code: !!state.acquisitionCode,
          has_bonus_token: !!state.acquisitionBonusToken
        }
      });
      const url = `${platformApiBaseUrl()}/acquisition/event`;
      const body = JSON.stringify(payload);
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([body], { type: 'application/json' });
          if (navigator.sendBeacon(url, blob)) return;
        }
      } catch (e) {}
      try {
        fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          keepalive: true,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body
        }).catch(() => {});
      } catch (e) {}
    }

    function installSignupInteractionTracking() {
      root.addEventListener('click', (event) => {
        const el = event.target.closest('button,a,[data-tab],[data-action]');
        if (!el || !root.contains(el)) return;
        trackSignupInteraction('control_click', { control: signupControlMeta(el) });
      });
      ['focusin', 'input', 'change', 'focusout'].forEach((eventName) => {
        root.addEventListener(eventName, (event) => {
          const el = event.target.closest('input,select,textarea');
          if (!el || !root.contains(el)) return;
          trackSignupInteraction(`field_${eventName === 'focusin' ? 'focus' : eventName === 'focusout' ? 'blur' : eventName}`, {
            control: signupControlMeta(el),
            field_value: signupFieldValue(el)
          });
        });
      });
    }

    function showNotice(message, tone) {
      const notice = $('[data-notice]');
      notice.textContent = message || '';
      notice.dataset.tone = tone || 'error';
      notice.classList.toggle('is-visible', !!message);
    }

    function showRegisterNotice(message, tone) {
      showNotice('', 'error');
      const notice = $('[data-register-notice]');
      if (!notice) {
        showNotice(message, tone);
        return;
      }
      notice.textContent = message || '';
      notice.dataset.tone = tone || 'error';
      notice.classList.toggle('is-visible', !!message);
    }

    function clearFormNotices() {
      $$('[data-register-notice]').forEach((notice) => {
        notice.textContent = '';
        notice.classList.remove('is-visible');
      });
    }

    function setBusy(form, busy) {
      const button = form.querySelector('.fm-button');
      if (!button) return;
      if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
      button.disabled = !!busy;
      button.textContent = busy ? 'Working...' : button.dataset.defaultText;
    }

    function showForm(name) {
      state.active = name;
      showNotice('', 'error');
      clearFormNotices();
      $$('[data-form]').forEach((form) => {
        form.classList.toggle('is-active', form.dataset.form === name);
      });
      $$('[data-tab]').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
      });
      if (name === 'forgot' || name === 'otp' || name === 'reset') {
        $('.fm-tabs').hidden = true;
      } else {
        $('.fm-tabs').hidden = !showLogin;
      }
      emit(host, 'mode-change', { mode: name });
      trackSignupInteraction('mode_change', { mode: name });
    }

    async function authLegacyRequest(formData) {
      const payload = {};
      formData.forEach((value, key) => { payload[key] = value; });
      const res = await fetch(`${platformApiBaseUrl()}/auth/legacy-action`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      return await res.json().catch(() => ({}));
    }

    function loginErrorMessage(data) {
      const code = String(data && data.error || '').trim();
      if (code === 'invalid_credentials') return 'The password you entered is incorrect.';
      if (code === 'identity_phone_ambiguous') return 'This phone number is connected to multiple accounts. Sign in with email or contact support.';
      if (code === 'not_found' || code === 'identity_phone_not_found') return "We couldn't find an account with that email or phone number.";
      return String(data && data.message || 'Unable to log in. Please try again.');
    }

    async function syncPlatformBrowserSession(formData) {
      const identifier = String(formData.get('identifier') || formData.get('email') || '').trim();
      const password = String(formData.get('password') || '');
      if (!identifier || !password) return null;
      try {
        const res = await fetch(`${platformApiBaseUrl()}/auth/login`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ identifier, password })
        });
        return res.ok ? await res.json().catch(() => null) : null;
      } catch (e) {
        return null;
      }
    }

    function redirectAfterAuth(data) {
      const destination = data && data.first_login ? onboardingDestination() : redirectTarget;
      emit(host, 'auth-success', { mode: state.active, first_login: !!(data && data.first_login), redirect: destination });
      window.location.href = destination;
    }

    function appendAttributionParams(urlValue) {
      try {
        const url = new URL(urlValue, location.href);
        if (state.acquisitionCode && !url.searchParams.get('cid')) url.searchParams.set('cid', state.acquisitionCode);
        if (state.acquisitionCode && !url.searchParams.get('campaign')) url.searchParams.set('campaign', state.acquisitionCode);
        if (state.acquisitionAttributionId && !url.searchParams.get('acquisition_attribution_id')) url.searchParams.set('acquisition_attribution_id', state.acquisitionAttributionId);
        if (state.acquisitionBonusToken && !url.searchParams.get('xid')) url.searchParams.set('xid', state.acquisitionBonusToken);
        if (state.acquisitionBonusToken && !url.searchParams.get('acquisition_bonus_token')) url.searchParams.set('acquisition_bonus_token', state.acquisitionBonusToken);
        if (state.landingVariant && !url.searchParams.get('landing_variant')) url.searchParams.set('landing_variant', state.landingVariant);
        if (state.campaignType && !url.searchParams.get('campaign_type')) url.searchParams.set('campaign_type', state.campaignType);
        return url.toString();
      } catch (e) {
        return urlValue;
      }
    }

    function onboardingDestination() {
      return appendAttributionParams(routeToPortal('./?onboarding=1'));
    }

    function compactPayload(payload) {
      const next = {};
      Object.keys(payload || {}).forEach((key) => {
        const value = payload[key];
        if (value === null || typeof value === 'undefined') return;
        if (typeof value === 'number' && !Number.isFinite(value)) return;
        const text = String(value).trim();
        if (!text) return;
        next[key] = value;
      });
      return next;
    }

    function navigationTiming() {
      if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return {};
      const entry = window.performance.getEntriesByType('navigation')[0];
      if (!entry) return {};
      return compactPayload({
        navigation_type: entry.type || '',
        page_load_ms: Math.round(entry.duration || 0),
        dom_interactive_ms: Math.round(entry.domInteractive || 0),
        dom_content_loaded_ms: Math.round(entry.domContentLoadedEventEnd || 0)
      });
    }

    function browserAttributionMetadata() {
      const nav = window.navigator || {};
      const scr = window.screen || {};
      const connection = nav.connection || nav.mozConnection || nav.webkitConnection || {};
      let timezone = '';
      try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch (e) {}
      return compactPayload(Object.assign({
        page_path: location.pathname,
        page_search: location.search,
        page_hash: location.hash,
        browser_user_agent: nav.userAgent || '',
        browser_language: nav.language || '',
        browser_languages: Array.isArray(nav.languages) ? nav.languages.join(',') : '',
        browser_platform: nav.platform || '',
        browser_vendor: nav.vendor || '',
        browser_cookie_enabled: String(!!nav.cookieEnabled),
        browser_do_not_track: nav.doNotTrack || window.doNotTrack || '',
        timezone,
        timezone_offset_minutes: new Date().getTimezoneOffset(),
        screen_width: scr.width || '',
        screen_height: scr.height || '',
        screen_available_width: scr.availWidth || '',
        screen_available_height: scr.availHeight || '',
        screen_color_depth: scr.colorDepth || '',
        screen_pixel_depth: scr.pixelDepth || '',
        viewport_width: window.innerWidth || '',
        viewport_height: window.innerHeight || '',
        device_pixel_ratio: window.devicePixelRatio || '',
        touch_points: nav.maxTouchPoints || 0,
        hardware_concurrency: nav.hardwareConcurrency || '',
        device_memory: nav.deviceMemory || '',
        connection_type: connection.type || '',
        connection_effective_type: connection.effectiveType || '',
        connection_downlink: connection.downlink || '',
        connection_rtt: connection.rtt || '',
        page_title: document.title || '',
        page_loaded_at: new Date().toISOString(),
        visibility_state: document.visibilityState || '',
        history_length: window.history ? window.history.length : ''
      }, navigationTiming()));
    }

    function forwardAttribution(fd) {
      UTM_FIELDS.forEach((key) => {
        const val = params.get(key);
        if (val) fd.append(key, val);
      });
      if (state.referralCode && !fd.get('referral_code')) fd.set('referral_code', state.referralCode);
      if (state.referralAttributionId && !fd.get('referral_attribution_id')) fd.set('referral_attribution_id', state.referralAttributionId);
      if (state.acquisitionCode && !fd.get('acquisition_code')) fd.set('acquisition_code', state.acquisitionCode);
      if (state.acquisitionAttributionId && !fd.get('acquisition_attribution_id')) fd.set('acquisition_attribution_id', state.acquisitionAttributionId);
      if (state.acquisitionCode && !fd.get('campaign')) fd.set('campaign', state.acquisitionCode);
      if (state.acquisitionBonusToken && !fd.get('xid')) fd.set('xid', state.acquisitionBonusToken);
      if (state.acquisitionBonusToken && !fd.get('acquisition_bonus_token')) fd.set('acquisition_bonus_token', state.acquisitionBonusToken);
      if (state.landingVariant && !fd.get('landing_variant')) fd.set('landing_variant', state.landingVariant);
      if (state.campaignType && !fd.get('campaign_type')) fd.set('campaign_type', state.campaignType);
      const browserMetadata = browserAttributionMetadata();
      Object.keys(browserMetadata).forEach((key) => {
        if (!fd.get(key)) fd.set(key, String(browserMetadata[key]));
      });
      fd.set('attribution_metadata', JSON.stringify({ browser: browserMetadata }));
    }

    async function googleRegistrationPayload() {
      await waitForAcquisitionTrackingBeforeSubmit();
      const fd = new FormData($('[data-form="register"]'));
      forwardAttribution(fd);
      const payload = {};
      fd.forEach((value, key) => {
        if (key !== 'password' && key !== 'confirm_password' && key !== 'phone' && key !== 'email') payload[key] = value;
      });
      return payload;
    }

    function googleErrorMessage(error) {
      const code = String(error && error.code || '');
      if (code === 'google_account_mismatch') return 'This email is already linked to a different Google account. Contact support if you need help.';
      if (code === 'membership_required') return 'Your Google email is recognized, but it is not assigned to a company yet.';
      if (code === 'identity_inactive' || code === 'user_disabled') return 'This account is disabled. Contact your company administrator.';
      return String(error && error.message || 'Google sign-in could not be completed. Please try again.');
    }

    function googleSuccess(data) {
      trackSignupInteraction(data && data.first_login ? 'google_register_success' : 'google_login_success', {
        first_login: !!(data && data.first_login),
        linked_google: !!(data && data.linked_google)
      });
      if (data && data.first_login) {
        if (window.fbq) window.fbq('track', 'CompleteRegistration');
        if (window.gtag) window.gtag('event', 'sign_up', { method: 'google' });
      }
      redirectAfterAuth(data);
    }

    async function initializeGoogleAuth() {
      let googleAuth;
      try {
        googleAuth = await loadGoogleAuthLibrary();
      } catch (e) {
        $$('.fm-google-block').forEach((block) => block.remove());
        return;
      }
      const shared = {
        apiBaseUrl: platformApiBaseUrl(),
        onSuccess: googleSuccess
      };
      const mounts = [
        googleAuth.mountButton({
          ...shared,
          container: $('[data-google-register]'),
          text: 'signup_with',
          buildPayload: googleRegistrationPayload,
          onError: (error) => {
            trackSignupInteraction('google_register_error', { error: error.code || 'google_auth_failed' });
            showRegisterNotice(googleErrorMessage(error), 'error');
          }
        }),
        googleAuth.mountButton({
          ...shared,
          container: $('[data-google-login]'),
          buildPayload: () => ({}),
          onError: (error) => {
            trackSignupInteraction('google_login_error', { error: error.code || 'google_auth_failed' });
            showNotice(googleErrorMessage(error), 'error');
          }
        })
      ];
      const results = await Promise.allSettled(mounts);
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        const selector = index === 0 ? '[data-google-register]' : '[data-google-login]';
        $(selector)?.closest('.fm-google-block')?.remove();
      });
    }

    function syncAttributionInputs() {
      $$('input[name="referral_code"]').forEach((input) => { input.value = state.referralCode; });
      $$('input[name="referral_attribution_id"]').forEach((input) => { input.value = state.referralAttributionId; });
      $$('input[name="acquisition_code"]').forEach((input) => { input.value = state.acquisitionCode; });
      $$('input[name="acquisition_attribution_id"]').forEach((input) => { input.value = state.acquisitionAttributionId; });
      $$('input[name="campaign"]').forEach((input) => { input.value = state.acquisitionCode; });
      $$('input[name="xid"]').forEach((input) => { input.value = state.acquisitionBonusToken; });
      $$('input[name="acquisition_bonus_token"]').forEach((input) => { input.value = state.acquisitionBonusToken; });
      $$('input[name="landing_variant"]').forEach((input) => { input.value = state.landingVariant; });
    }

    function applyAcquisitionData(data) {
      if (!data || !data.success) return false;
      state.acquisitionAttributionId = data.acquisition_attribution_id || data.attribution_id || state.acquisitionAttributionId || '';
      state.acquisitionCode = data?.link?.code || data?.acquisition_link?.code || state.acquisitionCode || '';
      state.acquisitionBonusToken = data?.bonus_offer?.token || state.acquisitionBonusToken || '';
      syncBonusTokenToUrl(data?.bonus_query_key || 'xid');
      syncAttributionInputs();
      return true;
    }

    function attributionPayload(extra) {
      const browserMetadata = browserAttributionMetadata();
      const payload = Object.assign({
        campaign: state.acquisitionCode || state.referralCode || '',
        campaign_type: state.campaignType || (state.referralCode ? 'referral' : 'landing_page'),
        landing_variant: state.landingVariant,
        landing_page: location.pathname,
        page_url: location.href,
        referrer: document.referrer || '',
        xid: state.acquisitionBonusToken,
        acquisition_bonus_token: state.acquisitionBonusToken,
        metadata: { browser: browserMetadata }
      }, extra || {});
      Object.assign(payload, browserMetadata);
      UTM_FIELDS.forEach((key) => {
        const val = params.get(key);
        if (val) payload[key] = val;
      });
      return payload;
    }

    function applyReferralData(data) {
      if (!data || !data.success) return false;
      const partner = data.partner || {};
      const offer = data.offer || null;
      const code = data.code && data.code.code ? String(data.code.code).trim().toUpperCase() : state.referralCode;
      state.referralCode = code;
      state.referralAttributionId = data.attribution_id || '';
      state.acquisitionCode = code || state.acquisitionCode;
      state.acquisitionAttributionId = data.acquisition_attribution_id || data.attribution_id || state.acquisitionAttributionId;
      syncAttributionInputs();

      const card = $('[data-referral-card]');
      const logo = $('[data-referral-logo]');
      const titleEl = $('[data-referral-title]');
      const copyEl = $('[data-referral-copy]');
      const partnerName = safeText(partner.display_name, 'A FirstMate partner');
      titleEl.textContent = `${partnerName} invited you`;
      const shouldShowOffer = offerVisibility !== 'never' && (!!offer || offerVisibility === 'always');
      copyEl.textContent = shouldShowOffer
        ? formatOffer(offer, 'Your referral offer will be applied at sign up.')
        : 'Referral attribution will be applied when you create your account.';
      const logoUrl = safeText(partner.logo_url, '');
      if (logoUrl) {
        logo.innerHTML = `<img src="${logoUrl.replace(/"/g, '&quot;')}" alt="">`;
      } else {
        logo.textContent = partnerName.charAt(0).toUpperCase() || 'F';
      }
      card.classList.toggle('is-visible', showReferralCard);
      emit(host, 'referral-loaded', data);
      trackSignupInteraction('referral_loaded', {
        referral_code: state.referralCode,
        has_offer: !!offer,
        partner_type: trackingText(partner.type || '', 80)
      });
      return true;
    }

    async function loadReferralInvite() {
      if (!state.referralCode) return;
      syncAttributionInputs();
      try {
        const res = await fetch(`${platformApiBaseUrl()}/referrals/public/${encodeURIComponent(state.referralCode)}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!applyReferralData(data)) {
          emit(host, 'referral-error', { error: data.error || 'Referral invite unavailable.' });
        }
      } catch (e) {
        emit(host, 'referral-error', { error: 'Referral invite unavailable.' });
      }
    }

    async function trackAcquisitionLanding() {
      if (state.referralCode) return;
      if (!state.acquisitionCode && !state.landingVariant) return;
      const existing = existingPageAcquisitionTracking();
      if (existing && existing.key === `${state.acquisitionCode}|${state.landingVariant}|${state.campaignType}`) {
        acquisitionTrackingPromise = existing.promise.then((data) => {
          if (applyAcquisitionData(data)) {
            trackSignupInteraction('acquisition_tracked', {
              acquisition_code: state.acquisitionCode,
              attribution_id: state.acquisitionAttributionId,
              has_bonus_token: !!state.acquisitionBonusToken,
              shared_tracking: true
            });
          }
          return data;
        }).catch(() => null);
        return acquisitionTrackingPromise;
      }
      const key = `${state.acquisitionCode}|${state.landingVariant}|${state.campaignType}`;
      acquisitionTrackingPromise = (async () => {
        const res = await fetch(`${platformApiBaseUrl()}/acquisition/public/track`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(attributionPayload())
        });
        return await res.json().catch(() => ({}));
      })();
      setPageAcquisitionTracking({ key, promise: acquisitionTrackingPromise });
      try {
        const data = await acquisitionTrackingPromise;
        if (!applyAcquisitionData(data)) return data;
        trackSignupInteraction('acquisition_tracked', {
          acquisition_code: state.acquisitionCode,
          attribution_id: state.acquisitionAttributionId,
          has_bonus_token: !!state.acquisitionBonusToken
        });
        return data;
      } catch (e) {
        return null;
      }
    }

    async function waitForAcquisitionTrackingBeforeSubmit() {
      if (state.referralCode || (!state.acquisitionCode && !state.landingVariant)) return;
      if (!acquisitionTrackingPromise) acquisitionTrackingPromise = trackAcquisitionLanding();
      if (!acquisitionTrackingPromise) return;
      await Promise.race([acquisitionTrackingPromise.catch(() => null), timeout(TRACKING_TIMEOUT_MS)]);
    }

    function syncBonusTokenToUrl(queryKey) {
      if (!state.acquisitionBonusToken || !window.history?.replaceState) return;
      try {
        const key = String(queryKey || 'xid');
        const url = new URL(window.location.href);
        url.searchParams.set(key, state.acquisitionBonusToken);
        window.history.replaceState(window.history.state, document.title, url.toString());
        syncAttributionLinks(key);
      } catch (e) {}
    }

    function syncAttributionLinks(queryKey) {
      if (!state.acquisitionBonusToken) return;
      const key = String(queryKey || 'xid');
      Array.from(document.querySelectorAll('a[href]')).forEach((link) => {
        try {
          const url = new URL(link.getAttribute('href'), window.location.href);
          if (url.origin !== window.location.origin) return;
          if (!/\/portal\/login\.php$|\/login\.php$/i.test(url.pathname)) return;
          url.searchParams.set(key, state.acquisitionBonusToken);
          link.setAttribute('href', url.pathname + url.search + url.hash);
        } catch (e) {}
      });
    }

    root.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      const action = event.target.closest('[data-action]');
      if (tab) showForm(tab.dataset.tab);
      if (action) showForm(action.dataset.action);
    });

    $$('[data-recovery-method]').forEach((button) => button.addEventListener('click', () => {
      const method = button.dataset.recoveryMethod;
      const phone = method === 'phone';
      const form = $('[data-form="forgot"]');
      const input = form.querySelector('input[name="identifier"]');
      form.querySelector('input[name="delivery_channel"]').value = method;
      $$('[data-recovery-method]').forEach((option) => {
        const selected = option === button;
        option.classList.toggle('is-selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      form.querySelector('[data-recovery-label]').textContent = phone ? 'Phone number' : 'Email';
      input.type = phone ? 'tel' : 'email';
      input.autocomplete = phone ? 'tel' : 'email';
      input.placeholder = phone ? '(555) 555-0123' : 'you@example.com';
      input.value = '';
      form.querySelector('[data-recovery-details]').hidden = false;
      input.focus();
    }));

    $('[data-form="register"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!validateRegistrationPhone()) {
        showRegisterNotice('Enter a valid ten-digit mobile phone number.', 'error');
        registrationPhoneInput?.reportValidity();
        return;
      }
      const fd = new FormData(form);
      trackSignupInteraction('register_submit_attempt', {
        form: 'register',
        field_names: Array.from(fd.keys()).filter(key => !/password|token|code/i.test(key)),
        has_referral_code: !!fd.get('referral_code'),
        has_acquisition_code: !!fd.get('acquisition_code'),
        has_bonus_token: !!fd.get('acquisition_bonus_token')
      });
      if (!form.reportValidity()) return;
      showRegisterNotice('', 'error');
      if (fd.get('password') !== fd.get('confirm_password')) {
        trackSignupInteraction('register_validation_error', { reason: 'password_mismatch' });
        showRegisterNotice('Passwords do not match.', 'error');
        return;
      }
      fd.append('action', 'register');
      setBusy(form, true);
      await waitForAcquisitionTrackingBeforeSubmit();
      forwardAttribution(fd);
      try {
        const data = await authLegacyRequest(fd);
        if (data.success) {
          trackSignupInteraction('register_success', { first_login: !!data.first_login });
          if (window.fbq) window.fbq('track', 'CompleteRegistration');
          if (window.gtag) window.gtag('event', 'sign_up', { method: state.referralCode ? 'referral' : 'landing_page' });
          redirectAfterAuth(data);
        } else if (data.require_otp) {
          if (SIGNUP_EMAIL_VERIFICATION_ENABLED) {
            trackSignupInteraction('register_requires_otp', { email_domain: String(data.email || '').split('@').pop() || '' });
            state.otpEmail = data.email || String(fd.get('email') || '');
            $('[data-otp-message]').textContent = 'Enter the code sent to';
            $('[data-otp-email]').textContent = state.otpEmail;
            showNotice(data.message || 'Account created. Verify your email to continue.', 'success');
            showForm('otp');
          } else {
            trackSignupInteraction('register_otp_frontend_bypassed', { email_domain: String(data.email || '').split('@').pop() || '' });
            if (window.fbq) window.fbq('track', 'CompleteRegistration');
            if (window.gtag) window.gtag('event', 'sign_up', { method: state.referralCode ? 'referral' : 'landing_page' });
            redirectAfterAuth({ ...data, success: true, first_login: true });
          }
        } else {
          trackSignupInteraction('register_error', { error: data.error || 'registration_failed' });
          showRegisterNotice(data.error || 'Registration failed.', 'error');
          emit(host, 'signup-error', data);
        }
      } catch (e) {
        trackSignupInteraction('register_error', { error: 'connection_error' });
        showRegisterNotice('Connection error. Please try again.', 'error');
        emit(host, 'signup-error', { error: 'Connection error.' });
      } finally {
        setBusy(form, false);
      }
    });

    $('[data-form="login"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fd = new FormData(form);
      trackSignupInteraction('login_submit_attempt', { form: 'login' });
      if (!form.reportValidity()) return;
      fd.append('action', 'login');
      setBusy(form, true);
      try {
        const data = await authLegacyRequest(fd);
        if (data.success) {
          trackSignupInteraction('login_success', { first_login: !!data.first_login });
          await syncPlatformBrowserSession(fd);
          redirectAfterAuth(data);
        } else if (data.require_otp) {
          trackSignupInteraction('login_requires_otp', { email_domain: String(data.email || '').split('@').pop() || '' });
          state.otpEmail = data.email || String(fd.get('email') || '');
          $('[data-otp-message]').textContent = 'Enter the code sent to';
          $('[data-otp-email]').textContent = state.otpEmail;
          showForm('otp');
        } else {
          trackSignupInteraction('login_error', { error: data.error || 'login_failed' });
          showNotice(loginErrorMessage(data), 'error');
        }
      } catch (e) {
        trackSignupInteraction('login_error', { error: 'connection_error' });
        showNotice('Connection error. Please try again.', 'error');
      } finally {
        setBusy(form, false);
      }
    });

    $('[data-form="forgot"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.dataset.submitting === 'true') return;
      const fd = new FormData(form);
      trackSignupInteraction('forgot_submit_attempt', { form: 'forgot' });
      if (!form.reportValidity()) return;
      form.dataset.submitting = 'true';
      fd.append('action', 'forgot_password');
      setBusy(form, true);
      try {
        const data = await authLegacyRequest(fd);
        if (data.require_otp) {
          trackSignupInteraction('forgot_requires_otp', { delivery_channel: String(fd.get('delivery_channel') || '') });
          state.recoveryToken = String(data.recovery_token || '');
          state.recoveryIdentifier = String(fd.get('identifier') || '');
          $('[data-otp-message]').textContent = data.message || 'Enter the password reset code sent to';
          $('[data-otp-email]').textContent = data.masked_destination || '';
          showForm('otp');
        } else {
          trackSignupInteraction('forgot_error', { error: data.error || 'unable_to_send_code' });
          showNotice(data.error || 'Unable to send code.', 'error');
        }
      } catch (e) {
        trackSignupInteraction('forgot_error', { error: 'connection_error' });
        showNotice('Connection error. Please try again.', 'error');
      } finally {
        form.dataset.submitting = 'false';
        setBusy(form, false);
      }
    });

    $('[data-form="otp"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const otpInput = form.querySelector('input[name="otp"]');
      if (otpInput) otpInput.value = String(otpInput.value || '').replace(/\D/g, '').slice(0, 6);
      const fd = new FormData(form);
      trackSignupInteraction('otp_submit_attempt', { form: 'otp', otp_length: String(fd.get('otp') || '').length });
      if (!form.reportValidity()) return;
      fd.append('action', 'verify_otp');
      if (state.recoveryToken) fd.append('recovery_token', state.recoveryToken);
      else fd.append('email', state.otpEmail);
      setBusy(form, true);
      try {
        const data = await authLegacyRequest(fd);
        if (data.require_new_password) {
          trackSignupInteraction('otp_requires_new_password');
          showForm('reset');
        } else if (data.success) {
          trackSignupInteraction('otp_success', { first_login: !!data.first_login });
          redirectAfterAuth(data);
        } else {
          trackSignupInteraction('otp_error', { error: data.error || 'verification_failed' });
          showNotice(data.error || 'Code verification failed.', 'error');
        }
      } catch (e) {
        trackSignupInteraction('otp_error', { error: 'connection_error' });
        showNotice('Connection error. Please try again.', 'error');
      } finally {
        setBusy(form, false);
      }
    });

    $('[data-form="reset"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fd = new FormData(form);
      trackSignupInteraction('reset_submit_attempt', { form: 'reset' });
      if (!form.reportValidity()) return;
      fd.append('action', 'set_new_password');
      if (state.recoveryToken) fd.append('recovery_token', state.recoveryToken);
      else fd.append('email', state.otpEmail);
      setBusy(form, true);
      try {
        const data = await authLegacyRequest(fd);
        if (data.success) {
          trackSignupInteraction('reset_success');
          showNotice('Password updated. Redirecting...', 'success');
          const loginFd = new FormData();
          loginFd.append('action', 'login');
          loginFd.append('identifier', state.recoveryIdentifier || state.otpEmail);
          loginFd.append('password', String(fd.get('new_password') || ''));
          const loginData = await authLegacyRequest(loginFd);
          setTimeout(() => redirectAfterAuth(loginData && loginData.success ? loginData : data), 700);
        } else {
          trackSignupInteraction('reset_error', { error: data.error || 'password_update_failed' });
          showNotice(data.error || 'Password update failed.', 'error');
        }
      } catch (e) {
        trackSignupInteraction('reset_error', { error: 'connection_error' });
        showNotice('Connection error. Please try again.', 'error');
      } finally {
        setBusy(form, false);
      }
    });

    installSignupInteractionTracking();
    syncAttributionInputs();
    trackSignupInteraction('widget_ready', { initial_mode: initialMode, show_login: showLogin, has_referral_code: !!state.referralCode });
    showForm(initialMode === 'login' && showLogin ? 'login' : 'register');
    loadReferralInvite();
    trackAcquisitionLanding();
    initializeGoogleAuth();
    emit(host, 'ready', { mode: state.active, referral_code: state.referralCode });
  }

  function mountAll() {
    document.querySelectorAll(`[${ATTR}]`).forEach(buildWidget);
  }

  window.FirstMateSignupWidget = {
    mount: buildWidget,
    mountAll
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
