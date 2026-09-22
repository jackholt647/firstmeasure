/* public/libraries/apps/onboarding/wizard.js
 * ─────────────────────────────────────────────────────────────────
 * Full-screen onboarding wizard for new organisations.
 *
 * Triggered when the server returns show_onboarding: true
 * (set on first-ever org creator login).
 *
 * 4 pages:
 *   1. Branding  — Welcome + website → logo + colors + live preview
 *   2. Users     — Super admin (you) + invite team members
 *   3. Credits   — First-load 50% match promo offer
 *   4. Billing   — Save card + auto-topup setup
 * Each page has Skip (bottom-left) and Next/action (bottom-right).
 * Completing or skipping all pages dismisses the overlay and loads
 * the main dashboard.  If they skip credits+billing, the promo
 * banner system (promo_inject.js) still activates.
 *
 * STRIPE RESUME FLOW
 * ------------------
 * When the user clicks "Add card & checkout" on Step 3, we save
 * Before navigating to Stripe, the wizard writes its full state to
 * sessionStorage under ob_wizard_state (including a stripeSource field).
 * On return (URL has ?paid=1), boot() detects the flag, restores
 * state (didPurchase=true, cardSavedViaCheckout=true, currentPage=3)
 * and mounts directly at Step 4.
 *
 * Step 4 has two modes:
 *   - cardSavedViaCheckout=true  → card already on file; just offer
 *     the enable-auto-topup toggle and a Finish button.
 *   - cardSavedViaCheckout=false → card not yet saved; if the user
 *     enables auto top-up, redirect to the card-setup Stripe flow;
 *     if toggle is off, Finish skips card setup entirely.
 *
 * Follows Portal IIFE conventions, uses postAction / injectCSS / showToast.
 * ─────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';
  if (!window.Portal) return;

  const { $, escapeHtml, injectCSS, postAction } = window.Portal.util;
  const { showToast } = window.Portal.ui;
  const APP = window.__APP || {};
  const ME_EMAIL = String(APP.userEmail || '').toLowerCase().trim();
  const ME_NAME  = String(APP.userName || APP.userEmail || '').trim();
  const DEFAULT_LOGO = '/images/logo_red.png';
  const SAMPLE_DIAGRAM = 'media/sample_diagram_cropped.png';

  function onboardingProductMode(){
    const explicit = String(APP.onboardingProductMode || new URL(window.location.href).searchParams.get('onboardingMode') || '').trim().toLowerCase();
    if (explicit === 'channels') return 'channels';
    if (explicit === 'home_improvement') return 'home_improvement';
    const flags = window.Portal?.appFlags;
    if (flags?.current?.()
        && flags.value?.('apps', 'channels', false) === true
        && flags.value?.('apps', 'projects', true) === false
        && flags.value?.('platform', 'left_column_apps', true) === false) return 'channels';
    return 'reports';
  }

  function channelsBrandingMode(){
    return onboardingProductMode() === 'channels';
  }
  function homeImprovementBrandingMode(){
    return onboardingProductMode() === 'home_improvement';
  }
  window.Portal?.navigation?.registerSchema?.('onboardingMode', { values:['channels', 'home_improvement'], history:'replace' });

  /* Org name: not in __APP, but the theme IIFE caches it in localStorage */
  let ORG_NAME = String(APP.orgName || APP.userCompany || '').trim();
  if (!ORG_NAME) {
    try {
      const cached = JSON.parse(localStorage.getItem('fm_org_theme_v1') || '{}');
      if (cached.name) ORG_NAME = cached.name;
    } catch(e){}
  }
  if (!ORG_NAME) {
    const el = document.getElementById('whoCompany');
    if (el && el.textContent.trim()) ORG_NAME = el.textContent.trim();
  }

  async function resolveOnboardingOrgName(){
    if (!channelsBrandingMode() && ORG_NAME && !/^default branch$/i.test(ORG_NAME)) return;
    try {
      const context = await window.PlatformAPI?.request?.('/me');
      const organization = context?.organization || {};
      const organizationData = organization.data || {};
      const canonical = String(organization.name || organizationData.name || '').trim();
      if (canonical) ORG_NAME = canonical;
    } catch(e){ /* keep the best first-paint name */ }
  }

  /* ── Permission / role metadata (mirrors company_settings.js) ── */
  const PERM_META = [
    { k:'order_reports',                   label:(globalThis.PlatformLanguage?.text("onboarding","m_a0d673c98d109b","Order Reports") ?? "Order Reports") },
    { k:'view_reports',                    label:(globalThis.PlatformLanguage?.text("onboarding","m_0cb4deb6e0a11b","View Reports") ?? "View Reports") },
    { k:'manage_billing',                  label:(globalThis.PlatformLanguage?.text("onboarding","m_707e3bb60aa697","Manage Billing") ?? "Manage Billing") },
    { k:'manage_company_settings',         label:(globalThis.PlatformLanguage?.text("onboarding","m_3ca553a96e2d57","Manage Company Settings") ?? "Manage Company Settings") },
    { k:'manage_report_settings',          label:(globalThis.PlatformLanguage?.text("onboarding","m_92a0f4a34883f8","Manage Report Settings") ?? "Manage Report Settings") },
  { k:'manage_company_users',            label:(globalThis.PlatformLanguage?.text("onboarding","m_3e5cbdf732a7e4","Manage Users") ?? "Manage Users") },
  { k:'manage_company_user_permissions', label:(globalThis.PlatformLanguage?.text("onboarding","m_4100a91e5391b6","Manage User Permissions") ?? "Manage User Permissions") },
  ];
  const ROLE_PRESETS = [
    { v:'viewer',  label:(globalThis.PlatformLanguage?.text("onboarding","m_ee8002871331aa","Viewer") ?? "Viewer"),  icon:'fa-eye' },
    { v:'manager', label:(globalThis.PlatformLanguage?.text("onboarding","m_32263fb2e2d35f","Manager") ?? "Manager"), icon:'fa-briefcase' },
    { v:'admin',   label:(globalThis.PlatformLanguage?.text("onboarding","m_624b3522fe2950","Admin") ?? "Admin"),   icon:'fa-shield-halved' },
    { v:'super_admin', label:(globalThis.PlatformLanguage?.text("onboarding","m_1a6b2c0ae6f76c","Super Admin") ?? "Super Admin"), icon:'fa-user-shield' },
  ];
  const ROLE_PERM_DEFAULTS = {
    viewer:  { order_reports:false, view_reports:true },
    manager: { order_reports:true, view_reports:true, manage_billing:false, manage_company_settings:false, manage_report_settings:false, manage_company_users:false, manage_company_user_permissions:false },
    admin:   { order_reports:true, view_reports:true, manage_billing:true, manage_company_settings:true, manage_report_settings:true, manage_company_users:true, manage_company_user_permissions:false },
    super_admin: Object.fromEntries(PERM_META.map(p => [p.k, true])),
  };

  /* ── Promo tiers ─────────────────────────────────────────────── */
  const LOAD_TIERS = [
    { amount: 100 },
    { amount: 250 },
    { amount: 500 },
  ];
  const BONUS_LOAD_TIERS = [
    { amount: 50, match_percent: 0 },
    { amount: 100, match_percent: 25 },
    { amount: 200, match_percent: 50 },
  ];

  /* ── Helpers ─────────────────────────────────────────────────── */
  function esc(s){ return escapeHtml(String(s || '')); }
  function activeLoadTiers(){
    const offerTiers = Array.isArray(acquisitionBonusOffer?.tiers) ? acquisitionBonusOffer.tiers : [];
    const normalized = offerTiers.map((tier, index) => {
      const amount = Math.max(0, Math.round(Number(tier.customer_pays || tier.threshold || tier.amount || 0)));
      const match = Math.max(0, Number(tier.match_percent || 0));
      const bonus = Math.round((amount * match) / 100);
      return {
        id: String(tier.id || `tier_${index + 1}`),
        amount,
        match_percent: match,
        bonus_dollars: bonus,
        total_account_value: amount + bonus
      };
    }).filter(tier => tier.amount > 0).sort((a, b) => a.amount - b.amount).slice(0, 3);
    if (normalized.length) return normalized;
    return LOAD_TIERS.map(tier => ({ ...tier, match_percent: 0, bonus_dollars: 0, total_account_value: tier.amount }));
  }

  function bonusOfferEnabled(){
    return !!(acquisitionBonusOffer && Array.isArray(acquisitionBonusOffer.tiers) && acquisitionBonusOffer.tiers.length);
  }

  function bonusQuoteForAmount(amount){
    const value = Math.max(0, Math.round(Number(amount || 0)));
    if (!value || !bonusOfferEnabled()) return { valid:false, bonus_dollars:0, total_account_value:value, match_percent:0, tier:null };
    const tier = activeLoadTiers().filter(item => item.amount <= value).sort((a, b) => b.amount - a.amount)[0] || null;
    if (!tier) return { valid:false, bonus_dollars:0, total_account_value:value, match_percent:0, tier:null };
    const match = Math.max(0, Number(tier.match_percent || 0));
    const bonus = Math.round((value * match) / 100);
    return { valid:true, bonus_dollars:bonus, total_account_value:value + bonus, match_percent:match, tier };
  }

  function totalCreditsText(amount){
    const quote = bonusQuoteForAmount(amount);
    const total = quote.valid ? quote.total_account_value : Math.max(0, Math.round(Number(amount || 0)));
    return `$${total} total credit`;
  }

  function bonusMinimumLoadAmount(){
    const qualifyingTiers = activeLoadTiers().filter(tier => Number(tier.match_percent || 0) > 0);
    if (!qualifyingTiers.length) return 0;
    return Math.min(...qualifyingTiers.map(tier => tier.amount));
  }

  function bonusDollarsText(amount){
    const quote = bonusQuoteForAmount(amount);
    return quote.valid && quote.bonus_dollars > 0 ? `+ $${Math.round(quote.bonus_dollars)} Bonus` : '';
  }

  function customBonusPreviewHtml(amount){
    const bonusText = bonusDollarsText(amount);
    const totalText = totalCreditsText(amount);
    if (!bonusText) return `<span class="ob-tier-custom-total">${esc(totalText)}</span>`;
    return `<span class="ob-tier-custom-bonus">${esc(bonusText)}</span><span class="ob-tier-custom-total">${esc(totalText)}</span>`;
  }

  function acquisitionCampaignApiBase(){
    const endpoints = window.Portal?.cfg?.endpoints || {};
    const configured = endpoints.crm_referrals
      || (endpoints.crm ? String(endpoints.crm).replace(/\/+$/, '') + '/referrals' : '/v1/internal/crm/referrals');
    return String(configured || '/v1/internal/crm/referrals').replace(/\/+$/, '') + '/acquisition';
  }

  async function loadInternalCampaignBonusOffer(testPayload){
    if (testPayload?.bonus_test !== '1' || !testPayload?.cid || !testPayload?.xid) return null;
    try {
      const res = await fetch(acquisitionCampaignApiBase() + '/campaigns', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
      const campaignCode = String(testPayload.cid || '').trim();
      const campaignCodeUpper = campaignCode.toUpperCase();
      const campaign = campaigns.find(item => {
        const values = [
          item?.id,
          item?.display_name,
          item?.primary_code?.code,
          item?.code,
          item?.campaign_code,
        ].map(value => String(value || '').trim());
        return values.some(value => value === campaignCode || value.toUpperCase() === campaignCodeUpper);
      });
      const sets = campaign?.metadata?.bonus_offer_sets || {};
      const token = String(testPayload.xid || '').trim();
      const offerSet = Object.values(sets).find(set => {
        return String(set?.token || '').trim() === token
          && String(set?.status || 'active').toLowerCase() === 'active'
          && Array.isArray(set?.tiers)
          && set.tiers.length > 0;
      });
      if (!offerSet) return null;
      return {
        offer_id: 'acquisition_bonus_offer_v1',
        token,
        offer_token: token,
        acquisition_bonus_token: token,
        source: 'internal_campaign_bonus_offer_sets',
        campaign_id: campaign?.id || '',
        campaign_code: campaign?.primary_code?.code || campaignCode,
        label: offerSet.label || offerSet.id || 'Campaign offer',
        tiers: offerSet.tiers,
      };
    } catch(e){
      try { console.warn('[OnboardingBonusOffer] internal campaign fallback failed', e); } catch(_e){}
    }
    return null;
  }

  async function loadAcquisitionBonusOffer(){
    const testPayload = acquisitionBonusTestPayload();
    try {
      const { data } = await postAction('portal_acquisition_bonus_offer_status', testPayload);
      acquisitionBonusOffer = data?.offer_enabled && data?.offer ? data.offer : null;
      if (!acquisitionBonusOffer) {
        acquisitionBonusOffer = await loadInternalCampaignBonusOffer(testPayload);
      }
      try {
        console.log('[OnboardingBonusOffer]', {
          enabled: !!data?.offer_enabled,
          has_offer: !!acquisitionBonusOffer,
          reason: data?.reason || data?.error || '',
          offer_id: acquisitionBonusOffer?.offer_id || '',
          source: acquisitionBonusOffer?.source || 'portal_action',
          token_keys: acquisitionBonusOffer
            ? ['token', 'offer_token', 'acquisition_bonus_token', 'xid', 'test_token'].filter(k => !!acquisitionBonusOffer?.[k])
            : [],
          tiers: Array.isArray(acquisitionBonusOffer?.tiers) ? acquisitionBonusOffer.tiers.length : 0,
          test_payload: {
            bonus_test: testPayload.bonus_test || '',
            cid: testPayload.cid || '',
            has_xid: !!testPayload.xid,
          },
          response_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
        });
      } catch(e){}
    } catch(e){
      acquisitionBonusOffer = await loadInternalCampaignBonusOffer(testPayload);
      try { console.warn('[OnboardingBonusOffer] failed', e); } catch(_e){}
    }
  }

  function acquisitionBonusTestPayload(){
    if (!forceOnboardingForTesting()) return {};
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('bonus_test') !== '1') return {};
      const campaign = url.searchParams.get('cid') || url.searchParams.get('campaign') || url.searchParams.get('campaign_code') || url.searchParams.get('acquisition_code') || url.searchParams.get('campaign_id') || '';
      const token = url.searchParams.get('xid') || url.searchParams.get('acquisition_bonus_token') || url.searchParams.get('bonus_token') || '';
      if (!campaign || !token) return {};
      return {
        bonus_test: '1',
        cid: campaign,
        campaign,
        campaign_code: campaign,
        acquisition_code: campaign,
        campaign_id: campaign,
        xid: token,
        bonus_token: token,
        acquisition_bonus_token: token
      };
    } catch(e){}
    return {};
  }

  function acquisitionBonusOfferToken(){
    return String(acquisitionBonusOffer?.token
      || acquisitionBonusOffer?.offer_token
      || acquisitionBonusOffer?.acquisition_bonus_token
      || acquisitionBonusOffer?.xid
      || acquisitionBonusOffer?.test_token
      || '').trim();
  }

  function clampHex(hex, fb){
    let h = String(hex||'').trim().toUpperCase();
    if (!h.startsWith('#')) h = '#'+h;
    if (!/^#[0-9A-F]{6}$/.test(h)) return fb;
    return h;
  }

  function hexToRgbCsv(hex){
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return null;
    return `${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)}`;
  }

  function textColorForBg(hex){
    try {
      let h = String(hex||'').replace('#','');
      if (h.length !== 6) return '#fff';
      const r = parseInt(h.slice(0,2),16) / 255;
      const g = parseInt(h.slice(2,4),16) / 255;
      const b = parseInt(h.slice(4,6),16) / 255;
      const lin = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      return L > 0.36 ? '#111' : '#fff';
    } catch(e){ return '#fff'; }
  }

  function applyPrimaryTextVar(hex){
    document.documentElement.style.setProperty('--primary-text', textColorForBg(hex));

    /* Compute a "readable" variant of the primary for use as text/border
       on light backgrounds (e.g. role toggle buttons, permission pills).
       If the primary is too light to read on white, darken it. */
    const readable = readableVariant(hex);
    document.documentElement.style.setProperty('--primary-readable', readable);
    const rh = readable.replace('#','');
    if (rh.length === 6) {
      document.documentElement.style.setProperty('--primary-readable-rgb',
        `${parseInt(rh.slice(0,2),16)},${parseInt(rh.slice(2,4),16)},${parseInt(rh.slice(4,6),16)}`);
    }
  }

  /** Return the color as-is if it's dark enough to read on white,
   *  otherwise darken it until contrast ratio >= 3:1 against white. */
  function readableVariant(hex){
    try {
      let h = String(hex||'').replace('#','');
      if (h.length !== 6) return '#D93025';
      const r = parseInt(h.slice(0,2),16)/255;
      const g = parseInt(h.slice(2,4),16)/255;
      const b = parseInt(h.slice(4,6),16)/255;
      const lin = (c) => c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
      const L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
      /* WCAG contrast ratio against white (L_white = 1):
         ratio = (1.05) / (L + 0.05).  We want >= 3.0 for readable text. */
      const ratio = 1.05 / (L + 0.05);
      if (ratio >= 3.0) return hex; /* already dark enough */
      /* Darken proportionally — preserve hue by scaling all channels equally */
      const targetL = 0.3; /* luminance that gives ~3:1 vs white */
      const scale = L > 0.001 ? Math.sqrt(targetL / L) : 0;
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
      return '#' + [r*scale, g*scale, b*scale]
        .map(v => clamp(v).toString(16).padStart(2,'0')).join('').toUpperCase();
    } catch(e){ return hex || '#D93025'; }
  }

  async function fetchImageAsDataUrl(url){
    try {
      const fd = new FormData();
      fd.append('action', 'fetch_image');
      fd.append('actor_email', window.__APP?.userEmail || '');
      fd.append('actor_name', window.__APP?.userName || '');
      fd.append('actor_org_id', window.__APP?.userOrgId || '');
      fd.append('url', url);
      const res = await fetch((window.Portal?.cfg?.serverEndpoint || window.__APP?.serverEndpoint), { method:'POST', body: fd, credentials:'include' });
      const data = await res.json().catch(()=>null);
      if (data?.success && data.data_url) return data.data_url;
    } catch(e){}
    return null;
  }

  function extractColors(imgEl){
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        const buckets = {};
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a < 128) continue;
          const qr = Math.round(r/16)*16, qg = Math.round(g/16)*16, qb = Math.round(b/16)*16;
          const key = `${Math.min(255,qr)},${Math.min(255,qg)},${Math.min(255,qb)}`;
          buckets[key] = (buckets[key]||0) + 1;
        }
        const sorted = Object.entries(buckets).sort((a,b) => b[1]-a[1]);
        if (sorted.length === 0) {
          resolve({ primary:'#D93025', secondary:'#960000' });
          return;
        }

        const parseCSV = (csv) => csv.split(',').map(Number);
        const toHex = (rgb) => '#' + rgb.map(v => Math.min(255,v).toString(16).padStart(2,'0')).join('').toUpperCase();
        const colorDist = (a, b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
        const isNearWhite = (rgb) => rgb[0] > 230 && rgb[1] > 230 && rgb[2] > 230;
        const isNearBlack = (rgb) => rgb[0] < 25 && rgb[1] < 25 && rgb[2] < 25;

        let primaryRGB = parseCSV(sorted[0][0]);
        for (let i = 0; i < sorted.length; i++){
          const rgb = parseCSV(sorted[i][0]);
          if (!isNearWhite(rgb) && !isNearBlack(rgb)) { primaryRGB = rgb; break; }
        }

        const MIN_DIST = 80;
        let secondaryRGB = null;
        for (let i = 0; i < sorted.length; i++){
          const rgb = parseCSV(sorted[i][0]);
          if (colorDist(rgb, primaryRGB) > MIN_DIST) { secondaryRGB = rgb; break; }
        }

        if (!secondaryRGB) {
          secondaryRGB = [85, 85, 85];
        }

        const lum = (rgb) => 0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2];
        if (isNearWhite(secondaryRGB)) {
          let darkAlt = null;
          for (let i = 0; i < sorted.length; i++){
            const rgb = parseCSV(sorted[i][0]);
            if (lum(rgb) < 80 && colorDist(rgb, primaryRGB) > MIN_DIST) {
              darkAlt = rgb; break;
            }
          }
          if (darkAlt) secondaryRGB = darkAlt;
        }
        if (isNearWhite(primaryRGB)) {
          let darkAlt = null;
          for (let i = 0; i < sorted.length; i++){
            const rgb = parseCSV(sorted[i][0]);
            if (lum(rgb) < 80 && colorDist(rgb, secondaryRGB) > MIN_DIST) {
              darkAlt = rgb; break;
            }
          }
          if (darkAlt) primaryRGB = darkAlt;
        }

        /* Final guard: never output near-white — fall back to dark gray */
        if (isNearWhite(primaryRGB)) primaryRGB = [68, 68, 68];
        if (isNearWhite(secondaryRGB)) secondaryRGB = [68, 68, 68];

        resolve({ primary: toHex(primaryRGB), secondary: toHex(secondaryRGB) });
      } catch(e){
        resolve({ primary:'#D93025', secondary:'#960000' });
      }
    });
  }

  async function findBestLogo(domain){
    const siteUrl = 'https://' + domain;
    try {
      const fd = new FormData();
      fd.append('action', 'scrape_logos');
      fd.append('actor_email', window.__APP?.userEmail || '');
      fd.append('actor_name', window.__APP?.userName || '');
      fd.append('actor_org_id', window.__APP?.userOrgId || '');
      fd.append('url', siteUrl);
      const res = await fetch((window.Portal?.cfg?.serverEndpoint || window.__APP?.serverEndpoint), { method:'POST', body: fd, credentials:'include' });
      const data = await res.json().catch(()=>null);
      if (!data?.success || !Array.isArray(data.candidates) || data.candidates.length === 0) {
        return null;
      }

      const serverScore = {};
      data.candidates.forEach((c, i) => {
        const url = typeof c === 'string' ? c : c.url;
        serverScore[url] = typeof c === 'object' ? (c.score || 0) : (data.candidates.length - i);
      });

      const urls = data.candidates.map(c => typeof c === 'string' ? c : c.url);

      const results = await Promise.allSettled(
        urls.map(src => new Promise((resolve, reject) => {
          const img = new Image();
          const timer = setTimeout(() => { img.src = ''; reject(); }, 4000);
          img.onload = () => {
            clearTimeout(timer);
            if (img.naturalWidth >= 8 && img.naturalHeight >= 8) {
              const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
              resolve({ src, w: img.naturalWidth, h: img.naturalHeight, maxDim });
            } else {
              reject();
            }
          };
          img.onerror = () => { clearTimeout(timer); reject(); };
          img.src = src;
        }))
      );

      const loaded = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      if (loaded.length === 0) return null;

      const LOGO_MIN = 64, LOGO_MAX = 500;
      const bkts = { logo: [], icon: [], oversized: [] };

      loaded.forEach(item => {
        if (item.maxDim >= LOGO_MIN && item.maxDim <= LOGO_MAX) {
          bkts.logo.push(item);
        } else if (item.maxDim < LOGO_MIN) {
          bkts.icon.push(item);
        } else {
          bkts.oversized.push(item);
        }
      });

      const byScore = (a, b) => (serverScore[b.src] || 0) - (serverScore[a.src] || 0);

      for (const bucket of [bkts.logo, bkts.icon, bkts.oversized]) {
        if (bucket.length > 0) {
          bucket.sort(byScore);
          return bucket[0].src;
        }
      }
      return null;
    } catch(e){
      return null;
    }
  }

  function parseDomain(urlStr){
    try {
      let u = String(urlStr || '').trim();
      if (!u) return '';
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      return new URL(u).hostname;
    } catch(e){ return ''; }
  }

  /* Smart image setter (from company_settings) */
  function setImgSmart(imgEl, url){
    if (!imgEl) return;
    const base = url || DEFAULT_LOGO;
    imgEl.onerror = null;
    imgEl.onerror = function(){
      if (imgEl.src.includes(DEFAULT_LOGO)) return;
      imgEl.src = DEFAULT_LOGO;
    };
    imgEl.src = base;
  }

  /* ── CSS ──────────────────────────────────────────────────────── */
  const CSS = `
  /* ======= ONBOARDING WIZARD — LIGHT THEME ======= */
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;0,9..40,900;1,9..40,400&display=swap');

  .ob-overlay{
      position:fixed; inset:0; z-index:2147483600;
      background:#f5f6f8;
      display:flex; align-items:center; justify-content:center;
      font-family:'DM Sans', system-ui, -apple-system, sans-serif;
      overflow:hidden;
      animation: obFadeIn .4s ease;
      padding-top: max(12px, env(safe-area-inset-top, 12px));
      padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
      box-sizing: border-box;
  }
  @keyframes obFadeIn{from{opacity:0}to{opacity:1}}

  .ob-overlay::before{
    content:'';
    position:absolute; inset:-50%;
    background:
      radial-gradient(ellipse 600px 600px at 20% 30%, rgba(217,48,37,0.05) 0%, transparent 70%),
      radial-gradient(ellipse 500px 500px at 80% 70%, rgba(108,63,224,0.04) 0%, transparent 70%),
      radial-gradient(ellipse 400px 400px at 50% 50%, rgba(26,115,232,0.03) 0%, transparent 70%);
    animation: obBgDrift 20s ease-in-out infinite alternate;
    pointer-events:none;
  }
  @keyframes obBgDrift{
    0%{transform:translate(0,0) scale(1)}
    100%{transform:translate(-3%,2%) scale(1.05)}
  }

  .ob-overlay::after{
    content:'';
    position:absolute; inset:0;
    background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.02'/%3E%3C/svg%3E");
    background-repeat:repeat;
    pointer-events:none;
    opacity:.3;
  }

  /* ── Page container (slides) ──────────────────────── */
  .ob-pages{
    position:relative;
    width:min(680px, 94vw);
    height:min(92vh, calc(100dvh - 24px));
    max-height:92vh;
    overflow:hidden;
    z-index:1;
  }
  .ob-page{
    position:absolute; inset:0;
    display:flex; flex-direction:column;
    opacity:0;
    transform:translateX(60px);
    transition: opacity .45s cubic-bezier(.4,0,.2,1), transform .45s cubic-bezier(.4,0,.2,1);
    pointer-events:none;
    overflow-y:auto;
    scrollbar-width:thin;
    scrollbar-color: rgba(0,0,0,0.1) transparent;
  }
  .ob-page.active{
    position:relative;
    opacity:1; transform:translateX(0);
    pointer-events:auto;
    height:100%;
  }
  .ob-page.no-scroll{
    overflow:hidden;
    max-height:92vh;
  }
  .ob-page.exit-left{
    opacity:0; transform:translateX(-60px);
  }

  /* ── Progress dots ───────────────────────────────────── */
  .ob-progress{
    position:absolute; top:24px; left:50%; transform:translateX(-50%);
    display:flex; gap:8px; z-index:10;
  }
  .ob-dot{
    width:8px; height:8px; border-radius:99px;
    background:rgba(0,0,0,0.12);
    transition: all .3s ease;
  }
  .ob-dot.active{
    width:28px;
    background:var(--primary, #d93025);
  }
  .ob-dot.done{
    background:rgba(0,0,0,0.25);
  }

  /* ── Step indicator ──────────────────────────────────── */
  .ob-step-label{
    font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase;
    color:rgba(0,0,0,0.35);
    margin-bottom:6px;
  }

  /* ── Typography ──────────────────────────────────────── */
  .ob-h1{
    font-size:clamp(28px, 5vw, 40px);
    font-weight:900; letter-spacing:-1px; line-height:1.1;
    color:#1a1a1a;
    margin:0 0 4px;
  }
  .ob-h2{
    font-size:clamp(22px, 4vw, 30px);
    font-weight:900; letter-spacing:-.6px; line-height:1.15;
    color:#1a1a1a;
    margin:0 0 6px;
  }
  .ob-sub{
    font-size:14px; font-weight:500; color:rgba(0,0,0,0.45);
    line-height:1.45; margin:0 0 16px;
  }
  .ob-sub strong{ color:rgba(0,0,0,0.7); font-weight:700; }

  /* ── Common elements ─────────────────────────────────── */
  .ob-card{
    background:#fff;
    border:1px solid rgba(0,0,0,0.08);
    border-radius:16px;
    padding:16px;
    box-shadow:0 2px 8px rgba(0,0,0,0.04);
  }
  .ob-input{
    width:100%; box-sizing:border-box;
    background:#fff;
    border:1px solid rgba(0,0,0,0.12);
    border-radius:12px;
    padding:14px 16px;
    font:inherit; font-size:15px; font-weight:600;
    color:#1a1a1a;
    outline:none;
    transition: border-color .2s, box-shadow .2s;
  }
  .ob-input::placeholder{ color:rgba(0,0,0,0.3); }
  .ob-input:focus{
    border-color:var(--primary, #d93025);
    box-shadow:0 0 0 3px rgba(var(--primary-rgb, 217,48,37),0.1);
  }
  .ob-lbl{
    font-size:11px; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; color:rgba(0,0,0,0.4);
    margin-bottom:8px; display:block;
  }
  .ob-row{ margin-bottom:14px; }

  /* ── Buttons ─────────────────────────────────────────── */
  .ob-footer{
    display:flex; align-items:center; justify-content:space-between;
    margin-top:auto; padding-top:16px; gap:12px;
    flex-shrink:0;
  }
  .ob-footer-right{
    display:flex; align-items:center; gap:8px;
    margin-left:auto;
  }
  .ob-btn{
    border:none; border-radius:999px;
    padding:12px 22px;
    font:inherit; font-size:13px; font-weight:800;
    cursor:pointer; display:inline-flex; align-items:center; gap:8px;
    transition: all .18s ease;
    letter-spacing:-.1px;
  }
  .ob-btn.primary{
    background:var(--primary, #d93025); color:var(--primary-text, #fff);
    box-shadow:0 8px 28px rgba(var(--primary-rgb, 217,48,37),0.2);
  }
  .ob-btn.primary:hover{
    transform:translateY(-1px);
    box-shadow:0 12px 36px rgba(var(--primary-rgb, 217,48,37),0.3);
  }
  .ob-btn.primary:disabled{
    opacity:.35; cursor:not-allowed; transform:none;
    box-shadow:0 8px 28px rgba(var(--primary-rgb, 217,48,37),0.1);
  }
  .ob-btn-icon{
    min-width:52px;
    padding:12px 16px;
    justify-content:center;
    box-shadow:none !important;
  }
  .ob-btn-icon:hover{
    box-shadow:none !important;
    transform:none;
  }
  .ob-btn.ghost{
    background:transparent; color:rgba(0,0,0,0.4);
    border:1px solid rgba(0,0,0,0.1);
  }
  .ob-btn.ghost:hover{
    color:rgba(0,0,0,0.65);
    border-color:rgba(0,0,0,0.2);
    background:rgba(0,0,0,0.03);
  }
  .ob-btn.accent{
    background:var(--primary, #d93025); color:var(--primary-text, #fff);
    box-shadow:0 8px 28px rgba(var(--primary-rgb, 217,48,37),0.25);
  }
  .ob-btn.accent:hover{
    transform:translateY(-1px);
    box-shadow:0 12px 36px rgba(var(--primary-rgb, 217,48,37),0.35);
  }
  .ob-hint{
    font-size:12px; font-weight:500; color:rgba(0,0,0,0.3);
    margin-top:12px; line-height:1.4;
  }
  .ob-hint i{ margin-right:4px; }
  .ob-auto-summary{
    font-size:12px; font-weight:500; color:rgba(0,0,0,0.42);
    margin-top:12px; line-height:1.45;
  }
  .ob-topup-config.ob-topup-config-gated{
    opacity:0;
    transform:translateY(10px);
    max-height:0;
    overflow:hidden;
    pointer-events:none;
    margin-top:0;
    transition:opacity .22s ease, transform .22s ease, max-height .28s ease, margin-top .22s ease;
  }
  .ob-topup-config.ob-topup-config-gated.is-visible{
    opacity:1;
    transform:translateY(0);
    max-height:420px;
    pointer-events:auto;
    margin-top:18px;
  }

  /* ── Page 1: Branding ──────────────────────────────── */
  .ob-welcome-names{
    margin-bottom:20px; padding-top:4px;
  }
  .ob-welcome-names .ob-name-user{
    font-size:clamp(16px, 3vw, 20px);
    font-weight:700; color:rgba(0,0,0,0.6);
    margin-bottom:2px;
  }
  .ob-welcome-names .ob-name-org{
    font-size:13px; font-weight:600; color:rgba(0,0,0,0.35);
  }
  .ob-website-row{
    display:flex; gap:10px; align-items:stretch;
  }
  .ob-website-row .ob-input{ flex:1; min-width:0; }
  .ob-website-row .ob-btn{ flex-shrink:0; }
  .ob-alt-btn{
    margin-top:10px;
    padding:0;
    border:none;
    background:transparent;
    color:var(--primary-readable, var(--primary, #d93025));
    font:inherit;
    font-size:13px;
    font-weight:800;
    cursor:pointer;
    display:inline-flex;
    align-items:center;
    gap:8px;
  }
  .ob-alt-btn:hover{
    color:var(--primary, #d93025);
  }
  .ob-alt-btn .ob-check-sub{
    display:none;
  }
  .ob-brand-section{
    overflow:hidden;
    max-height:0; opacity:0;
    transition: max-height .5s cubic-bezier(.4,0,.2,1), opacity .4s ease, margin .4s ease;
    margin-top:0;
  }
  .ob-brand-section.open{
    max-height:none; opacity:1; margin-top:12px;
    display:flex; flex-direction:column;
    flex:1; min-height:0;
    overflow:visible;
    gap:12px;
  }

  /* ── Logo area (zone + actions outside) ────────── */
  .ob-logo-area{
    display:flex; flex-direction:column;
    transition: flex .35s ease;
  }

  .ob-logo-zone{
    padding:14px;
    border:2px dashed rgba(0,0,0,0.15);
    border-radius:16px;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:6px;
    overflow:hidden;
    cursor:pointer;
    transition: border-color .2s, background .2s, min-height .35s ease, max-height .35s ease, padding .3s ease;
    position:relative;
    background:rgba(0,0,0,0.02);
  }
  .ob-logo-zone:hover{
    border-color:rgba(0,0,0,0.3);
    background:rgba(0,0,0,0.04);
  }
  .ob-logo-zone img#obLogoImg{
    max-width:100%; max-height:70px; object-fit:contain;
    display:block;
  }
  .ob-logo-zone .ob-logo-placeholder{
    text-align:center; color:rgba(0,0,0,0.3);
    font-size:11px; font-weight:700; line-height:1.4;
  }
  .ob-logo-zone .ob-logo-placeholder i{ font-size:22px; display:block; margin-bottom:4px; }
  .ob-logo-zone.has-logo .ob-logo-placeholder{ display:none; }
  .ob-logo-zone .ob-logo-spinner{
    position:absolute; inset:0;
    display:flex; align-items:center; justify-content:center;
    flex-direction:column; gap:6px;
    background:rgba(245,246,248,0.9);
    color:rgba(0,0,0,0.4); font-size:14px;
  }
  .ob-logo-spinner .ob-spinner-text{
    font-size:11px; font-weight:700; color:rgba(0,0,0,0.35);
    letter-spacing:.3px;
  }
  .ob-logo-zone input[type="file"]{ display:none; }

  /* Confirm question text inside the zone */
  .ob-logo-zone .ob-logo-q{
    font-size:13px; font-weight:700; color:rgba(0,0,0,0.5);
    margin-top:4px;
  }

  /* Actions row OUTSIDE the zone */
  .ob-logo-actions{
    display:flex; gap:8px; justify-content:center;
    padding:10px 0 6px;
  }
  .ob-logo-actions:empty{ display:none; }
  .ob-logo-action-btn{
    border:1px solid rgba(0,0,0,0.12);
    background:#fff;
    border-radius:999px;
    padding:8px 18px;
    font:inherit; font-size:12px; font-weight:800;
    cursor:pointer;
    transition:.15s ease;
    display:inline-flex; align-items:center; gap:6px;
  }
  .ob-logo-action-btn:hover{
    border-color:rgba(0,0,0,0.25);
  }
  .ob-logo-action-btn.yes{
    background:var(--primary, #d93025);
    color:var(--primary-text, #fff);
    border-color:transparent;
  }
  .ob-logo-action-btn.yes:hover{
    opacity:.9;
  }

  /* ── State: logo-expanded (searching / confirming / editing) ── */
  .ob-brand-section.logo-expanded .ob-logo-area{
    flex:1; min-height:0;
  }
  .ob-brand-section.logo-expanded .ob-logo-zone{
    flex:1; min-height:80px; max-height:none;
  }
  .ob-brand-section.logo-expanded .ob-brand-bottom{
    display:none;
  }

  /* ── State: logo-collapsed (confirmed, small indicator) ── */
  .ob-brand-section.logo-collapsed{
    overflow:hidden;
    flex:0 1 auto;
  }
  .ob-brand-section.logo-collapsed .ob-logo-area{
    flex:0 0 auto;
  }
  .ob-brand-section.logo-skipped .ob-logo-area{
    display:flex;
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone{
    min-height:0;
    max-height:52px;
    flex-direction:row;
    padding:8px 14px;
    gap:10px;
    border-style:solid;
    border-color:rgba(0,0,0,0.08);
    background:rgba(0,0,0,0.01);
    align-items:center;
    justify-content:flex-start;
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone img#obLogoImg{
    max-height:32px; max-width:120px;
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone .ob-logo-placeholder{ display:none; }
  .ob-brand-section.logo-collapsed .ob-logo-zone:not(.has-logo){
    justify-content:center;
    border-style:dashed;
    border-color:rgba(0,0,0,0.14);
    background:rgba(0,0,0,0.025);
  }
  .ob-logo-mini-label{
    font-size:11px; font-weight:700; color:rgba(0,0,0,0.35);
    display:none;
    align-items:center; gap:5px;
    margin-left:auto;
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone:not(.has-logo) .ob-logo-mini-label{
    margin-left:0;
    color:rgba(0,0,0,0.42);
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone:not(.has-logo):hover{
    border-color:rgba(0,0,0,0.24);
    background:rgba(0,0,0,0.045);
  }
  .ob-brand-section.logo-collapsed .ob-logo-mini-label{
    display:flex;
  }
  .ob-brand-section.logo-collapsed .ob-logo-actions{
    display:none;
  }
  .ob-brand-section.logo-collapsed .ob-logo-zone .ob-logo-q{
    display:none;
  }
  .ob-brand-section.logo-collapsed .ob-brand-bottom{
    display:flex;
    gap:16px;
    min-height:0;
    flex:0 1 auto;
  }
  .ob-brand-copy{
    display:flex; flex-direction:column; gap:4px;
    margin-bottom:12px;
  }
  .ob-brand-copy-title{
    font-size:16px; font-weight:800; color:#1a1a1a;
  }
  .ob-brand-copy-sub{
    font-size:12px; line-height:1.45; color:rgba(0,0,0,0.45);
  }
  .ob-brand-section.logo-collapsed .ob-colors-zone{
    flex:0 0 auto;
    align-self:center;
  }
  .ob-brand-section.logo-collapsed .ob-preview-col{
    flex:1 1 0; min-height:0;
    min-width:0;
  }
  .ob-brand-section.logo-collapsed .ob-preview-wrap{
    max-height:100%;
  }
  .ob-brand-section.logo-collapsed .ob-preview-page{
    max-height:100%;
  }

  /* Brand bottom: colors left, preview right */
  .ob-brand-bottom{
    display:grid;
    grid-template-columns: auto 1fr;
    gap:16px;
    align-items:start;
  }

  /* Step 1 needs the preview to fit within the visible wizard height. */
  #obPage0.active{
    overflow:hidden;
  }
  #obPage0.active .ob-brand-section.open{
    flex:1 1 auto;
    min-height:0;
  }
  #obPage0.active .ob-brand-bottom{
    flex:1 1 auto;
    min-height:0;
    align-items:stretch;
  }
  #obPage0.active .ob-preview-col{
    flex:1 1 auto;
    min-height:0;
    align-items:stretch;
  }
  #obPage0.active .ob-preview-wrap{
    flex:1 1 auto;
    min-height:0;
    height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
    container-type:size;
  }
  #obPage0.active .ob-preview-page{
    width:min(100cqw, calc(100cqh * 8.5 / 11));
    height:auto;
    max-width:100%;
    max-height:100%;
  }

  .ob-colors-zone{
    display:flex; flex-direction:column; gap:8px;
    align-items:center;
    justify-content:center;
  }
  .ob-color-row{
    display:flex; align-items:center;
  }
  .ob-color-swatch{
    width:44px; height:44px; border-radius:12px;
    border:2px solid rgba(0,0,0,0.1);
    cursor:pointer; padding:0;
    transition: border-color .2s, box-shadow .2s;
  }
  .ob-color-swatch:hover{ border-color:rgba(0,0,0,0.25); }
  .ob-color-swatch:focus{ box-shadow:0 0 0 3px rgba(0,0,0,0.08); outline:none; }

  /* ── Sample report preview (inline) ──────────────── */
  .ob-preview-col{
    display:flex; flex-direction:column;
    min-width:0; min-height:0;
    align-items:center;
    flex:1;
  }
  .ob-preview-wrap{
    border-radius:14px;
    padding:8px;
    border:1px dashed rgba(0,0,0,0.15);
    background:rgba(0,0,0,0.02);
    cursor:pointer;
    position:relative;
    transition: border-color .2s, box-shadow .2s;
    width:100%;
  }
  .ob-preview-wrap:hover{
    border-color:rgba(0,0,0,0.25);
    box-shadow:0 4px 16px rgba(0,0,0,0.06);
  }
  .ob-preview-page{
    width:100%;
    aspect-ratio: 8.5 / 11;
    border-radius:8px;
    overflow:hidden;
    background:#fff;
    position:relative;
    box-shadow:0 6px 20px rgba(0,0,0,0.08);
  }
  .ob-preview-bar-p{
    position:absolute; left:0; top:0; bottom:0; width:12px;
    background:var(--primary, #d93025);
    transition: background .25s ease;
  }
  .ob-preview-bar-s{
    position:absolute; left:12px; top:0; bottom:0; width:2px;
    background:var(--secondary, #960000);
    transition: background .25s ease;
  }
  .ob-preview-inner{
    position:absolute; left:14px; right:0; top:0; bottom:0;
    background:#fff;
    display:flex; flex-direction:column;
    padding:6%;
    gap:5%;
  }
  .ob-preview-logo{
    width:55%; max-height:clamp(12px, 14%, 26px);
  }
  .ob-preview-logo img{
    display:block; max-height:100%; max-width:100%; object-fit:contain;
  }
  .ob-preview-logo.default-firstmeasure-logo{
    height:clamp(12px, 14%, 26px);
  }
  .ob-preview-logo.default-firstmeasure-logo img{
    display:none;
  }
  .ob-preview-logo.default-firstmeasure-logo::before{
    content:"";
    display:block;
    width:100%;
    height:100%;
    background:var(--primary, #d93025);
    -webkit-mask:url("/images/logo_red.png") left center / contain no-repeat;
    mask:url("/images/logo_red.png") left center / contain no-repeat;
  }
  /* Diagram image box */
  .ob-prev-diagram{
    border:1px solid rgba(0,0,0,0.1);
    border-radius:4px;
    overflow:hidden;
    flex:1 1 auto;
    min-height:0;
    display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.01);
  }
  .ob-prev-diagram img{
    display:block; width:92%; height:auto; max-height:100%; object-fit:contain; opacity:0.95;
  }
  /* Info row: two boxes */
  .ob-prev-info{
    display:flex; gap:5%; flex-shrink:0;
  }
  .ob-prev-box{
    border:1px solid rgba(0,0,0,0.08);
    border-radius:4px;
    border-left:3px solid var(--primary, #d93025);
    padding:4% 5%;
    overflow:hidden;
    min-width:0;
  }
  .ob-prev-box.left{ flex:2; }
  .ob-prev-box.right{ flex:3; }
  .ob-prev-box .ob-prev-label{
    font-size:clamp(4px, 1.3vw, 7px);
    font-weight:700;
    color:rgba(0,0,0,0.35);
    letter-spacing:.3px;
    text-transform:uppercase;
    line-height:1.2;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .ob-prev-box .ob-prev-value{
    font-size:clamp(5px, 1.6vw, 9px);
    font-weight:900;
    color:#1a1a1a;
    line-height:1.25;
    margin-top:2px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .ob-prev-box .ob-prev-big{
    font-size:clamp(8px, 2.8vw, 16px);
    font-weight:900;
    color:var(--primary, #d93025);
    line-height:1.15;
    margin-top:1px;
    transition: color .25s ease;
  }
  .ob-preview-tap{
    position:absolute;
    right:12px;
    bottom:12px;
    padding:7px 10px;
    border-radius:999px;
    background:rgba(32,33,36,0.82);
    color:#fff;
    font-size:11px;
    font-weight:800;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    gap:6px;
    box-shadow:0 8px 18px rgba(0,0,0,0.16);
    pointer-events:none;
  }

  /* ── Fullscreen preview modal ────────────────────── */
  /* Channels branding preview: a scaled, static slice of the real portal + Channels UI. */
  .ob-channels-preview{--ob-ch-primary:var(--primary-readable,var(--primary,#d93025));--ob-ch-primary-rgb:var(--primary-readable-rgb,var(--primary-rgb,217,48,37));aspect-ratio:16 / 10;background:#fff;color:#101828}
  #obPage0.active .ob-preview-page.ob-channels-preview{width:min(100cqw,calc(100cqh * 16 / 10))}
  .ob-channels-preview .ob-ch-shell{position:absolute;inset:0;display:grid;grid-template-columns:24% 76%;min-height:0;background:#fff}
  .ob-channels-preview .ob-ch-org-rail{min-width:0;background:#fff;border-right:1px solid #dfe3e8;display:flex;flex-direction:column}
  .ob-channels-preview .ob-ch-brand{height:13%;min-height:0;border-bottom:1px solid #dfe3e8;padding:6% 7%;display:flex;align-items:center}
  .ob-channels-preview .ob-preview-logo{width:58%;height:100%;max-height:none;display:flex;align-items:center;justify-content:flex-start}
  .ob-channels-preview .ob-preview-logo img{display:block;max-width:100%;max-height:100%;object-fit:contain;object-position:left center}
  .ob-channels-preview .ob-preview-logo.default-firstmeasure-logo{height:100%}
  .ob-channels-preview .ob-preview-logo.default-firstmeasure-logo::before{background:var(--ob-ch-primary)}
  .ob-channels-preview .ob-ch-org-channels{flex:1;min-height:0;padding:5% 4%;background:#f9fafb;display:flex;flex-direction:column;overflow:hidden}
  .ob-channels-preview .ob-ch-settings{margin:0 8% 10%;height:7%;min-height:16px;border:1px solid #d8dde5;border-radius:7px;display:flex;align-items:center;gap:6%;padding:0 7%;color:#667085;font-size:clamp(4px,1.05cqw,8px);font-weight:650}
  .ob-channels-preview .ob-ch-account{height:13%;min-height:0;border-top:1px solid #e4e7ec;padding:6% 8%;display:flex;align-items:center;gap:7%;color:#475467;font-size:clamp(4px,1cqw,7.5px)}
  .ob-channels-preview .ob-ch-account-copy{min-width:0;flex:1}.ob-channels-preview .ob-ch-account-copy strong,.ob-channels-preview .ob-ch-account-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ob-channels-preview .ob-ch-account-copy strong{font-weight:700}.ob-channels-preview .ob-ch-account-copy span{margin-top:2%;font-size:.82em;color:#667085}
  .ob-channels-preview .ob-ch-avatar{width:clamp(12px,3.4cqw,23px);aspect-ratio:1;border-radius:7px;display:grid;place-items:center;background:#eaf2ff;color:#315f9b;font-size:clamp(4px,1cqw,7px);font-weight:750;flex:0 0 auto}
  .ob-channels-preview .ob-ch-app{min-width:0;display:flex;flex-direction:column;background:#fff}
  .ob-channels-preview .ob-ch-topbar{height:10%;min-height:0;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;justify-content:center;padding:0 4%;color:#667085}
  .ob-channels-preview .ob-ch-search{width:54%;height:54%;border:1px solid #d8dde5;border-radius:999px;background:#f9fafb;display:flex;align-items:center;gap:5%;padding:0 4%;font-size:clamp(4px,1cqw,7.5px)}
  .ob-channels-preview .ob-ch-top-actions{margin-left:auto;display:flex;align-items:center;gap:clamp(4px,1.5cqw,10px);font-size:clamp(5px,1.15cqw,8.5px)}
  .ob-channels-preview .ob-ch-workspace{flex:1;min-height:0;display:flex}
  .ob-channels-preview .ob-ch-quick{display:grid;gap:1%}
  .ob-channels-preview .ob-ch-nav-item{display:flex;align-items:center;gap:6%;padding:3% 6%;border-radius:6px;font-size:clamp(4px,1.05cqw,8px);font-weight:550;color:#475467;white-space:nowrap}
  .ob-channels-preview .ob-ch-nav-item i{width:11%;text-align:center;color:#667085;font-size:.88em}
  .ob-channels-preview .ob-ch-section{margin-top:8%;display:flex;align-items:center;padding:0 6% 2%;color:#667085;font-size:clamp(3.5px,.85cqw,6px);font-weight:900;letter-spacing:.07em;text-transform:uppercase}
  .ob-channels-preview .ob-ch-section span{flex:1}.ob-channels-preview .ob-ch-section i{margin-left:7%;font-size:.75em}
  .ob-channels-preview .ob-ch-nav-item.active{background:rgba(var(--ob-ch-primary-rgb),.08);color:var(--ob-ch-primary);font-weight:700;transition:background .25s ease,color .25s ease}
  .ob-channels-preview .ob-ch-nav-item.active i{color:var(--ob-ch-primary)}
  .ob-channels-preview .ob-ch-assistant-mark{width:clamp(10px,2.6cqw,18px);aspect-ratio:1;flex:0 0 auto;background:var(--ob-ch-primary);-webkit-mask:url('/images/logo_square.png') center / 82% no-repeat;mask:url('/images/logo_square.png') center / 82% no-repeat;transition:background .25s ease}
  .ob-channels-preview .ob-ch-main{min-width:0;flex:1;background:#fff;display:flex;flex-direction:column}
  .ob-channels-preview .ob-ch-head{height:11%;min-height:0;border-bottom:1px solid #e4e7ec;padding:0 4%;display:flex;align-items:center;gap:2.5%}
  .ob-channels-preview .ob-ch-title{font-size:clamp(6px,1.4cqw,10px);font-weight:900;white-space:nowrap}.ob-channels-preview .ob-ch-title i{color:#667085;font-size:.8em;margin-right:4px}
  .ob-channels-preview .ob-ch-topic{font-size:clamp(4px,1cqw,7.5px);color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .ob-channels-preview .ob-ch-actions{display:flex;gap:clamp(3px,1.1cqw,8px);color:#667085;font-size:clamp(4.5px,1.1cqw,8px)}
  .ob-channels-preview .ob-ch-tabs{height:8%;min-height:0;border-bottom:1px solid #e4e7ec;display:flex;align-items:stretch;padding:0 3%;gap:1%}
  .ob-channels-preview .ob-ch-tab{display:flex;align-items:center;padding:0 3%;color:#667085;font-size:clamp(4px,.9cqw,7px);font-weight:700;border-bottom:2px solid transparent}.ob-channels-preview .ob-ch-tab.active{color:var(--ob-ch-primary);border-bottom-color:var(--ob-ch-primary)}
  .ob-channels-preview .ob-ch-messages{flex:1;min-height:0;padding:4%;display:flex;flex-direction:column;gap:7%;overflow:hidden}
  .ob-channels-preview .ob-ch-message{display:grid;grid-template-columns:auto 1fr;gap:2.5%;align-items:start}.ob-channels-preview .ob-ch-message-copy{min-width:0}
  .ob-channels-preview .ob-ch-message-head{display:flex;align-items:baseline;gap:3%;font-size:clamp(4.5px,1cqw,7.5px);font-weight:850}.ob-channels-preview .ob-ch-time{font-size:.75em;color:#98a2b3;font-weight:500}
  .ob-channels-preview .ob-ch-text{font-size:clamp(4px,.95cqw,7px);line-height:1.4;color:#344054;margin-top:1%}.ob-channels-preview .ob-ch-reaction{display:inline-flex;margin-top:2%;padding:1% 2.5%;border-radius:999px;background:rgba(var(--ob-ch-primary-rgb),.08);color:var(--ob-ch-primary);font-size:clamp(3.5px,.8cqw,6px);font-weight:800;border:1px solid var(--ob-ch-primary)}
  .ob-channels-preview .ob-ch-composer{margin:0 4% 4%;border:1px solid #e4e7ec;border-radius:7px;background:#fff;overflow:hidden}.ob-channels-preview .ob-ch-formatbar{height:30%;min-height:12px;border-bottom:1px solid #eaecf0;display:flex;align-items:center;gap:5%;padding:0 3%;color:#667085;font-size:clamp(4px,.9cqw,7px)}
  .ob-channels-preview .ob-ch-compose{padding:3% 3% 2%;display:flex;align-items:center;gap:4%;color:#98a2b3;font-size:clamp(4px,.9cqw,7px)}.ob-channels-preview .ob-ch-compose span{flex:1}.ob-channels-preview .ob-ch-send{padding:2% 4%;border-radius:5px;background:var(--ob-ch-primary);color:#fff;font-weight:800;transition:background .25s ease}
  .ob-preview-modal-inner.ob-channels-preview-frame{width:min(92vw,calc((100dvh - 48px) * 16 / 10));height:auto;max-height:calc(100dvh - 48px);aspect-ratio:16 / 10}
  .ob-preview-modal-page.ob-channels-preview{aspect-ratio:16 / 10}

  /* Generic company preview: enough real portal shape to demonstrate branding without implying a configured product. */
  .ob-workspace-preview{--ob-ws-primary:var(--primary-readable,var(--primary,#d93025));--ob-ws-primary-rgb:var(--primary-readable-rgb,var(--primary-rgb,217,48,37));aspect-ratio:16 / 10;background:#f7f8fa;color:#101828}
  #obPage0.active .ob-preview-page.ob-workspace-preview{width:min(100cqw,calc(100cqh * 16 / 10))}
  .ob-workspace-preview .ob-ws-shell{position:absolute;inset:0;display:grid;grid-template-columns:23% 77%;background:#f7f8fa}
  .ob-workspace-preview .ob-ws-rail{min-width:0;background:#fff;border-right:1px solid #e3e7ed;display:flex;flex-direction:column}
  .ob-workspace-preview .ob-ws-brand{height:14%;border-bottom:1px solid #e3e7ed;padding:6% 8%;display:flex;align-items:center}
  .ob-workspace-preview .ob-preview-logo{width:64%;height:100%;max-height:none;display:flex;align-items:center;justify-content:flex-start}
  .ob-workspace-preview .ob-preview-logo img{display:block;max-width:100%;max-height:100%;object-fit:contain;object-position:left center}
  .ob-workspace-preview .ob-preview-logo.default-firstmeasure-logo{height:100%}
  .ob-workspace-preview .ob-preview-logo.default-firstmeasure-logo::before{background:var(--ob-ws-primary)}
  .ob-workspace-preview .ob-ws-nav{flex:1;padding:9% 7%;display:grid;align-content:start;gap:3%}
  .ob-workspace-preview .ob-ws-nav-item{height:clamp(16px,4.8cqw,33px);padding:0 8%;border-radius:6px;display:flex;align-items:center;gap:8%;color:#667085;font-size:clamp(4px,1.05cqw,8px);font-weight:650}
  .ob-workspace-preview .ob-ws-nav-item i{width:12%;text-align:center}.ob-workspace-preview .ob-ws-nav-item.active{background:rgba(var(--ob-ws-primary-rgb),.08);color:var(--ob-ws-primary);font-weight:800}
  .ob-workspace-preview .ob-ws-profile{height:14%;border-top:1px solid #e4e7ec;padding:7% 8%;display:flex;align-items:center;gap:8%}
  .ob-workspace-preview .ob-ws-avatar{width:clamp(13px,3.5cqw,24px);aspect-ratio:1;border-radius:8px;background:rgba(var(--ob-ws-primary-rgb),.12);color:var(--ob-ws-primary);display:grid;place-items:center;font-size:clamp(4px,1cqw,7px);font-weight:850}
  .ob-workspace-preview .ob-ws-profile-lines{flex:1;display:grid;gap:4px}.ob-workspace-preview .ob-ws-line{height:3px;border-radius:99px;background:#d9dee6}.ob-workspace-preview .ob-ws-line.short{width:62%;background:#e8ebef}
  .ob-workspace-preview .ob-ws-app{min-width:0;display:flex;flex-direction:column}
  .ob-workspace-preview .ob-ws-topbar{height:11%;border-bottom:1px solid #e4e7ec;background:#fff;padding:0 5%;display:flex;align-items:center;justify-content:space-between;color:#667085;font-size:clamp(5px,1.15cqw,8px)}
  .ob-workspace-preview .ob-ws-search{width:45%;height:48%;border:1px solid #d8dde5;border-radius:99px;background:#fafbfc;display:flex;align-items:center;gap:5%;padding:0 4%}
  .ob-workspace-preview .ob-ws-tools{display:flex;gap:clamp(5px,1.5cqw,11px)}
  .ob-workspace-preview .ob-ws-content{position:relative;flex:1;padding:5%;overflow:hidden}
  .ob-workspace-preview .ob-ws-page-head{display:flex;align-items:center;justify-content:space-between}.ob-workspace-preview .ob-ws-heading{width:24%;height:7px;border-radius:99px;background:#cfd5de}.ob-workspace-preview .ob-ws-action{width:16%;height:clamp(13px,3.5cqw,24px);border-radius:6px;background:var(--ob-ws-primary)}
  .ob-workspace-preview .ob-ws-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:3%;margin-top:5%}.ob-workspace-preview .ob-ws-card{height:clamp(34px,10cqw,70px);border:1px solid #e3e7ed;border-radius:8px;background:#fff;padding:9%;display:grid;align-content:start;gap:11%}.ob-workspace-preview .ob-ws-card .ob-ws-line:first-child{width:48%;background:#e2e6eb}.ob-workspace-preview .ob-ws-card .ob-ws-line:last-child{width:70%;height:7px;background:#cfd5de}
  .ob-workspace-preview .ob-ws-table{margin-top:4%;height:42%;border:1px solid #e3e7ed;border-radius:8px;background:#fff;display:grid;grid-template-rows:repeat(4,1fr);overflow:hidden}.ob-workspace-preview .ob-ws-table-row{border-bottom:1px solid #edf0f3;display:grid;grid-template-columns:1.2fr .7fr .5fr;align-items:center;padding:0 4%;gap:7%}.ob-workspace-preview .ob-ws-table-row:last-child{border-bottom:0}.ob-workspace-preview .ob-ws-table-row .ob-ws-line:nth-child(2){width:75%}.ob-workspace-preview .ob-ws-table-row .ob-ws-line:nth-child(3){width:55%}
  .ob-workspace-preview .ob-ws-modal{position:absolute;left:23%;right:17%;top:19%;bottom:14%;border:1px solid #dce1e7;border-radius:10px;background:#fff;box-shadow:0 12px 35px rgba(16,24,40,.18);overflow:hidden;display:flex;flex-direction:column}.ob-workspace-preview .ob-ws-modal-head{height:26%;border-bottom:1px solid #e7eaee;padding:0 7%;display:flex;align-items:center;justify-content:space-between}.ob-workspace-preview .ob-ws-modal-title{width:38%;height:6px;border-radius:99px;background:#bcc4cf}.ob-workspace-preview .ob-ws-modal-close{color:#98a2b3;font-size:clamp(5px,1.15cqw,8px)}.ob-workspace-preview .ob-ws-modal-body{flex:1;padding:7%;display:grid;gap:9%;align-content:start}.ob-workspace-preview .ob-ws-field{display:grid;gap:5px}.ob-workspace-preview .ob-ws-field>.ob-ws-line{width:24%;background:#cfd5de}.ob-workspace-preview .ob-ws-input{height:clamp(12px,3.2cqw,22px);border:1px solid #d8dde5;border-radius:5px;background:#fbfcfd}.ob-workspace-preview .ob-ws-modal-footer{height:25%;border-top:1px solid #e7eaee;padding:0 7%;display:flex;align-items:center;justify-content:flex-end;gap:5%}.ob-workspace-preview .ob-ws-modal-btn{width:22%;height:clamp(11px,3cqw,21px);border:1px solid #d8dde5;border-radius:5px}.ob-workspace-preview .ob-ws-modal-btn.primary{border-color:var(--ob-ws-primary);background:var(--ob-ws-primary)}
  .ob-preview-modal-inner.ob-workspace-preview-frame{width:min(92vw,calc((100dvh - 48px) * 16 / 10));height:auto;max-height:calc(100dvh - 48px);aspect-ratio:16 / 10}.ob-preview-modal-page.ob-workspace-preview{aspect-ratio:16 / 10}

  .ob-preview-modal{
    position:fixed; inset:0; z-index:2147483601;
    background:rgba(0,0,0,0.82);
    display:flex; align-items:center; justify-content:center;
    padding:max(16px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px));
    box-sizing:border-box;
    animation: obFadeIn .25s ease;
  }
  .ob-preview-modal-inner{
    position:relative;
    height:min(760px, calc(100vh - 48px));
    max-height:calc(100vh - 48px);
    width:min(92vw, calc((100vh - 48px) * 8.5 / 11));
    height:min(760px, calc(100dvh - 48px));
    max-height:calc(100dvh - 48px);
    width:min(92vw, calc((100dvh - 48px) * 8.5 / 11));
    max-width:calc(100vw - 32px);
    aspect-ratio:8.5 / 11;
  }
  .ob-preview-modal-page{
    width:100%;
    height:100%;
    aspect-ratio:auto;
    border-radius:14px;
    overflow:hidden;
    background:#fff;
    position:relative;
    box-shadow:0 24px 70px rgba(0,0,0,0.35);
  }
  .ob-preview-modal-page .ob-preview-bar-p{ width:16px; }
  .ob-preview-modal-page .ob-preview-bar-s{ left:16px; width:3px; }
  .ob-preview-modal-page .ob-preview-inner{ left:19px; padding:5%; gap:4%; }
  .ob-preview-modal-page .ob-preview-logo{
    max-width:50%; max-height:12%;
  }
  .ob-preview-modal-page .ob-prev-box .ob-prev-label{
    font-size:clamp(7px, 2vw, 10px);
  }
  .ob-preview-modal-page .ob-prev-box .ob-prev-value{
    font-size:clamp(8px, 2.2vw, 12px);
  }
  .ob-preview-modal-page .ob-prev-box .ob-prev-big{
    font-size:clamp(14px, 4vw, 22px);
  }
  .ob-preview-modal-close{
    position:absolute; top:8px; right:8px;
    width:36px; height:36px; border-radius:99px;
    background:#fff; border:1px solid rgba(0,0,0,0.1);
    display:flex; align-items:center; justify-content:center;
    cursor:pointer; font-size:14px; color:#333;
    box-shadow:0 4px 16px rgba(0,0,0,0.15);
    z-index:2;
    transition: transform .15s ease;
  }
  .ob-preview-modal-close:hover{ transform:scale(1.1); }

  /* ── Page 2: Users ───────────────────────────────────── */
  .ob-user-me{
    display:flex; align-items:center; gap:12px;
    padding:14px 16px;
    background:#fff;
    border:1px solid rgba(0,0,0,0.08);
    border-radius:14px;
    margin-bottom:16px;
    box-shadow:0 2px 8px rgba(0,0,0,0.03);
  }
  .ob-user-me .ob-avatar{
    width:40px; height:40px; border-radius:12px;
    background:rgba(0,0,0,0.06);
    display:flex; align-items:center; justify-content:center;
    font-size:16px; color:rgba(0,0,0,0.45); font-weight:800;
    flex-shrink:0;
  }
  .ob-user-me .ob-user-info{ flex:1; min-width:0; }
  .ob-user-me .ob-user-name{
    font-size:14px; font-weight:800; color:#1a1a1a;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .ob-user-me .ob-user-email{
    font-size:12px; font-weight:600; color:rgba(0,0,0,0.4);
    margin-top:2px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .ob-user-me .ob-role-tag{
    flex-shrink:0;
    padding:6px 12px; border-radius:999px;
    background:rgba(0,0,0,0.05);
    border:1px solid rgba(0,0,0,0.08);
    font-size:11px; font-weight:800; color:rgba(0,0,0,0.5);
    letter-spacing:.5px; text-transform:uppercase;
  }

  .ob-invite-list{
    display:flex; flex-direction:column; gap:10px;
    margin-bottom:16px;
    max-height: 280px;
    overflow-y:auto;
    scrollbar-width:thin;
    scrollbar-color:rgba(0,0,0,0.08) transparent;
  }
  .ob-invite-row{
    background:#fff;
    border:1px solid rgba(0,0,0,0.07);
    border-radius:14px;
    padding:12px 14px;
    box-shadow:0 2px 6px rgba(0,0,0,0.03);
  }
  .ob-invite-row.ob-new{
    animation: obSlideUp .3s ease;
  }
  @keyframes obSlideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .ob-invite-top{
    display:flex; gap:10px; align-items:center; flex-wrap:wrap;
  }
  .ob-invite-top .ob-input{ flex:1; min-width:120px; padding:10px 12px; font-size:13px; }
  .ob-invite-remove{
    border:none; background:rgba(0,0,0,0.04); color:rgba(0,0,0,0.35);
    width:32px; height:32px; border-radius:10px;
    display:flex; align-items:center; justify-content:center;
    cursor:pointer; font-size:13px; flex-shrink:0;
    transition:.15s ease;
  }
  .ob-invite-remove:hover{ background:rgba(255,70,70,0.1); color:#e53935; }
  .ob-role-presets{
    display:flex; gap:6px; flex-wrap:wrap; margin-top:10px;
  }
  .ob-role-btn{
    border:1px solid rgba(0,0,0,0.1);
    background:#fff;
    border-radius:999px; padding:6px 12px;
    font:inherit; font-size:11px; font-weight:800;
    color:rgba(0,0,0,0.45);
    cursor:pointer; display:inline-flex; align-items:center; gap:6px;
    transition:.15s ease;
  }
  .ob-role-btn:hover{
    border-color:rgba(0,0,0,0.2); color:rgba(0,0,0,0.65);
  }
  .ob-role-btn.active{
    border-color:var(--primary-readable, var(--primary, #d93025));
    background:rgba(var(--primary-readable-rgb, var(--primary-rgb, 217,48,37)),0.08);
    color:var(--primary-readable, var(--primary, #d93025));
  }
  .ob-perms-grid{
    display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;
    padding-top:10px;
    border-top:1px dashed rgba(0,0,0,0.08);
  }
  .ob-perms-label{
    width:100%; font-size:10px; font-weight:700; letter-spacing:.5px;
    text-transform:uppercase; color:rgba(0,0,0,0.25);
    margin-bottom:2px;
  }
  .ob-perm-btn{
    border:1px solid rgba(0,0,0,0.06);
    background:rgba(0,0,0,0.02);
    border-radius:8px; padding:5px 10px;
    font:inherit; font-size:10px; font-weight:700;
    color:rgba(0,0,0,0.35);
    cursor:pointer; display:inline-flex; align-items:center; gap:5px;
    transition:.15s ease;
  }
  .ob-perm-btn:hover{ border-color:rgba(0,0,0,0.15); color:rgba(0,0,0,0.5); background:rgba(0,0,0,0.03); }
  .ob-perm-btn.on{
    border-color:var(--primary-readable, var(--primary, #d93025));
    background:rgba(var(--primary-readable-rgb, var(--primary-rgb, 217,48,37)),0.08);
    color:var(--primary-readable, var(--primary, #d93025));
  }
  .ob-perm-btn .dot{
    width:7px; height:7px; border-radius:99px;
    background:rgba(0,0,0,0.12);
    transition:.15s ease;
  }
  .ob-perm-btn.on .dot{ background:var(--primary-readable, var(--primary, #d93025)); }

  .ob-add-user-btn{
    border:1px dashed rgba(0,0,0,0.12);
    background:transparent;
    border-radius:12px; padding:10px 16px;
    font:inherit; font-size:13px; font-weight:700;
    color:rgba(0,0,0,0.35);
    cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;
    width:100%;
    transition:.15s ease;
  }
  .ob-add-user-btn:hover{
    border-color:rgba(0,0,0,0.25); color:rgba(0,0,0,0.55);
    background:rgba(0,0,0,0.02);
  }

  /* ── Page 3: Credits / Promo ─────────────────────────── */
  .ob-promo-badge{
    display:inline-flex; align-items:center; gap:8px;
    padding:6px 14px; border-radius:999px;
    background:linear-gradient(135deg,rgba(108,63,224,0.08),rgba(26,115,232,0.08));
    border:1px solid rgba(108,63,224,0.15);
    font-size:12px; font-weight:800; color:rgba(0,0,0,0.6);
    margin-bottom:16px;
  }
  .ob-tier-grid{
    display:grid;
    grid-template-columns: repeat(2, 1fr);
    gap:10px;
    margin-bottom:16px;
  }
  .ob-bonus-copy{
    text-align:left;
    margin:0 0 16px;
  }
  .ob-bonus-copy i{
    display:inline;
    margin-right:5px;
    font-size:12px;
    color:rgba(0,0,0,0.45);
  }
  .ob-bonus-copy strong{
    font-weight:900;
    color:rgba(0,0,0,0.72);
  }
  .ob-tier{
    border:1px solid rgba(0,0,0,0.08);
    background:#fff;
    border-radius:14px;
    padding:22px 14px;
    text-align:center;
    cursor:pointer;
    transition: all .2s ease;
    position:relative;
    overflow:hidden;
    box-shadow:0 2px 6px rgba(0,0,0,0.03);
  }
  .ob-tier:hover{
    border-color:rgba(0,0,0,0.15);
    transform:translateY(-2px);
    box-shadow:0 6px 16px rgba(0,0,0,0.06);
  }
  .ob-tier.selected{
    border-color:rgba(var(--primary-rgb, 217,48,37),0.28);
    background:rgba(var(--primary-rgb, 217,48,37),0.06);
    box-shadow:0 8px 32px rgba(var(--primary-rgb, 217,48,37),0.14);
  }
  .ob-tier .ob-tier-amount{
    font-size:24px; font-weight:900; color:#1a1a1a;
    letter-spacing:0;
  }
  .ob-tier .ob-tier-main{
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px;
    min-height:48px;
  }
  .ob-tier .ob-tier-bonus{
    font-size:12px; font-weight:900;
    color:var(--primary-readable, var(--primary, #d93025));
    line-height:1;
  }
  .ob-tier .ob-tier-total{
    font-size:12px; font-weight:800;
    color:rgba(0,0,0,0.35);
    margin-top:4px;
  }
  .ob-tier.ob-tier-custom{
    border-style:dashed;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px;
    padding:12px 10px;
  }
  .ob-tier.ob-tier-custom .ob-tier-custom-label{
    font-size:11px; font-weight:800; color:#1a1a1a;
    letter-spacing:.3px; text-transform:uppercase;
  }
  .ob-tier-custom-input{
    width:72px; text-align:center; padding:5px 6px;
    border:1px solid rgba(0,0,0,0.12); border-radius:8px;
    font:inherit; font-size:18px; font-weight:800;
    color:#1a1a1a; background:#fff; outline:none;
  }
  .ob-tier-custom-input:focus{ border-color:var(--primary, #d93025); }
  .ob-tier-custom-preview{
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:3px;
    margin-top:4px;
    line-height:1.15;
  }
  .ob-tier-custom-bonus{
    font-size:11px;
    font-weight:900;
    color:var(--primary-readable, var(--primary, #d93025));
  }
  .ob-tier-custom-total{
    font-size:11px;
    font-weight:800;
    color:rgba(0,0,0,0.46);
  }

  /* ── Page 4: Billing ─────────────────────────────────── */
  .ob-card-saved-banner{
    display:flex; align-items:center; gap:12px;
    padding:14px 16px;
    background:rgba(34,197,94,0.06);
    border:1px solid rgba(34,197,94,0.2);
    border-radius:14px;
    margin-bottom:20px;
  }
  .ob-card-saved-banner .ob-card-icon{
    width:40px; height:40px; border-radius:12px;
    background:rgba(34,197,94,0.1);
    display:flex; align-items:center; justify-content:center;
    font-size:18px; color:#16a34a;
    flex-shrink:0;
  }
  .ob-card-saved-banner .ob-card-text{
    font-size:13px; font-weight:700; color:rgba(0,0,0,0.55);
    line-height:1.4;
  }
  .ob-card-saved-banner .ob-card-text strong{
    color:#16a34a; font-weight:800;
  }
  .ob-billing-card-preview{
    display:flex; align-items:center; gap:12px;
    padding:14px 16px;
    background:#fff;
    border:1px solid rgba(0,0,0,0.08);
    border-radius:14px;
    margin-bottom:16px;
  }
  .ob-billing-card-preview .ob-card-icon{
    width:44px; height:30px; border-radius:6px;
    background:rgba(0,0,0,0.05);
    display:flex; align-items:center; justify-content:center;
    font-size:16px; color:rgba(0,0,0,0.35);
  }
  .ob-billing-card-preview .ob-card-text{
    font-size:13px; font-weight:700; color:rgba(0,0,0,0.45);
  }

  /* Note shown under toggle when auto top-up is on but no card saved */
  .ob-no-card-note{
    display:flex; align-items:flex-start; gap:10px;
    padding:12px 14px;
    background:rgba(234,179,8,0.06);
    border:1px solid rgba(234,179,8,0.2);
    border-radius:12px;
    margin-bottom:14px;
    font-size:12px; font-weight:600; color:rgba(0,0,0,0.5);
    line-height:1.45;
  }
  .ob-topup-help{
    margin:12px 0 0;
    padding:10px 12px;
    border-radius:12px;
    background:rgba(217,48,37,0.06);
    border:1px solid rgba(217,48,37,0.14);
    font-size:12px;
    font-weight:700;
    color:rgba(0,0,0,0.54);
  }
  .ob-topup-msg{
    min-height:18px;
    margin-top:10px;
    font-size:12px;
    font-weight:800;
    color:#b26a00;
  }
  .ob-verification-card{
    background:#fff;
    border:1px solid rgba(0,0,0,0.08);
    border-radius:14px;
    padding:16px;
    box-shadow:0 2px 8px rgba(0,0,0,0.03);
  }
  .ob-label{
    display:block;
    margin:0 0 7px;
    font-size:12px;
    font-weight:900;
    color:rgba(0,0,0,0.56);
  }
  .ob-email-row{
    display:grid;
    grid-template-columns:minmax(0,1fr) auto;
    gap:10px;
    margin-bottom:14px;
  }
  .ob-otp-input{
    max-width:180px;
    letter-spacing:6px;
    font-size:22px;
    font-weight:900;
    text-align:center;
  }
  .ob-no-card-note i{ color:#ca8a04; margin-top:1px; flex-shrink:0; }

  .ob-topup-config{ margin-top:16px; }
  .ob-topup-row{
    display:grid; align-items:center;
    grid-template-columns:minmax(0,1fr) auto;
    gap:10px; margin-bottom:10px;
  }
  .ob-topup-row .ob-topup-label{
    font-size:12px; font-weight:700; color:rgba(0,0,0,0.45);
    display:flex; align-items:center; gap:8px;
    min-width:0;
  }
  .ob-topup-ctrl{
    display:flex; align-items:center; gap:6px;
    flex-shrink:0;
  }
  .ob-topup-step{
    border:1px solid rgba(0,0,0,0.1);
    background:#fff;
    width:36px; height:36px;
    border-radius:10px; padding:0;
    color:rgba(0,0,0,0.45);
    cursor:pointer; font-size:14px; font-weight:800;
    transition:.15s ease;
    display:inline-flex; align-items:center; justify-content:center;
  }
  .ob-topup-step:hover{ border-color:rgba(0,0,0,0.25); color:#1a1a1a; }
  .ob-topup-input{
    width:64px; height:36px; text-align:center;
    padding:0 8px;
    border-radius:10px;
    font-size:15px; font-weight:800;
  }
  .ob-toggle-line{
    display:flex; align-items:center; justify-content:space-between;
    gap:12px;
    padding:14px 16px;
    background:#fff;
    border:1px solid rgba(0,0,0,0.08);
    border-radius:14px;
    margin-bottom:16px;
    box-shadow:0 2px 6px rgba(0,0,0,0.03);
  }
  .ob-toggle-text{
    font-size:13px; font-weight:700; color:rgba(0,0,0,0.55);
    display:flex; align-items:center; gap:8px;
  }
  .ob-toggle-switch{
    width:44px; height:24px; border-radius:99px;
    background:rgba(0,0,0,0.12);
    border:none; cursor:pointer; position:relative;
    transition:.2s ease;
    flex-shrink:0;
  }
  .ob-toggle-switch::after{
    content:'';
    position:absolute; top:3px; left:3px;
    width:18px; height:18px; border-radius:99px;
    background:#fff;
    box-shadow:0 1px 3px rgba(0,0,0,0.15);
    transition:.2s ease;
  }
  .ob-toggle-switch.on{
    background:var(--primary, #d93025);
  }
  .ob-toggle-switch.on::after{
    left:23px;
    background:#fff;
  }

  /* ── Responsive ──────────────────────────────────────── */
  @media(max-width:520px){
    .ob-pages{
        width:100vw;
        height:100vh; height:100dvh;
        max-height:100vh; max-height:100dvh;
    }
    .ob-page{
      padding:14px 16px 12px;
      height:100%;
      box-sizing:border-box;
      overflow-y:auto;
    }
    .ob-page.no-scroll{
      overflow:hidden;
      max-height:100%;
    }
    .ob-progress{
      position:relative; top:auto; left:auto; transform:none;
      margin-bottom:8px;
      justify-content:center;
    }
    .ob-h1{ font-size:26px; }
    .ob-h2{ font-size:20px; }
    .ob-sub{ font-size:13px; margin-bottom:10px; }

    /* Footer: always row, skip left, next right */
    .ob-footer{
      flex-direction:row;
      margin-top:auto;
      padding-top:10px;
      padding-bottom:env(safe-area-inset-bottom, 4px);
      gap:10px;
    }
    .ob-footer .ob-btn{
      padding:12px 18px;
      font-size:13px;
    }

    /* Website row: button stays inline */
    .ob-website-row{
      flex-direction:row;
    }
    .ob-website-row .ob-input{
      padding:12px 14px;
      font-size:16px;
      min-width:0;
      flex:1;
    }
    .ob-email-row{
      grid-template-columns:1fr;
    }
    .ob-email-row .ob-btn{
      width:100%;
      justify-content:center;
    }
    .ob-otp-input{
      max-width:100%;
    }

    /* Brand section: fill available space */
    .ob-brand-section.open{
      max-height:none;
    }
    .ob-brand-section.logo-expanded .ob-logo-zone{
      min-height:60px;
    }
    .ob-brand-section.logo-collapsed .ob-logo-zone{
      max-height:46px;
      padding:6px 12px;
    }
    .ob-brand-section.logo-collapsed .ob-logo-zone img#obLogoImg{
      max-height:28px;
    }

    .ob-brand-bottom{
      grid-template-columns: auto 1fr;
      gap:12px;
      align-items:stretch;
    }
    .ob-colors-zone{
      gap:6px;
    }
    .ob-color-swatch{
      width:48px; height:48px;
      border-radius:14px;
    }

    /* Preview takes remaining space */
    .ob-preview-col{
      min-height:0;
    }
    .ob-preview-wrap{
      padding:6px;
      height:auto;
    }
    .ob-preview-tap{
      right:8px;
      bottom:8px;
      padding:6px 9px;
      font-size:10px;
    }

    .ob-hint{
      display:none; /* hide hints on mobile to save space */
    }

    /* Step label compact */
    .ob-step-label{ margin-bottom:2px; font-size:10px; }

    /* Welcome names compact */
    .ob-welcome-names{ margin-bottom:12px; padding-top:0; }

    .ob-row{ margin-bottom:10px; }

    .ob-topup-config{ margin-top:10px; }
    .ob-topup-row{
      gap:8px;
      margin-bottom:8px;
    }
    .ob-topup-row .ob-topup-label{
      font-size:11px;
      gap:6px;
    }
    .ob-topup-ctrl{
      gap:5px;
    }
    .ob-topup-step{
      width:34px;
      height:34px;
      border-radius:9px;
      font-size:13px;
    }
    .ob-topup-input{
      width:56px;
      height:34px;
      padding:0 6px;
      font-size:14px;
    }
    .ob-topup-msg{
      min-height:14px;
      margin-top:6px;
      font-size:11px;
    }
    .ob-auto-summary{
      margin-top:8px;
      font-size:11px;
      line-height:1.35;
    }
  }

  @media(max-width:360px){
    .ob-brand-bottom{
      grid-template-columns: auto 1fr;
    }
  }
  `;

  /* ═══════════════════════════════════════════════════════════════
   *  STATE
   * ═══════════════════════════════════════════════════════════════ */
  let currentPage = 0;
  const VERIFY_PAGE = 3;
  const ALL_PAGES = [0, 1, 2, VERIFY_PAGE];

  /* Branding state */
  let brandState = {
    website: '',
    domain: '',
    noWebsite: false,
    logoUrl: null,
    logoFile: null,        // File object — not serialisable, intentionally omitted from persistence
    primary: '#D93025',
    secondary: '#960000',
    colorsExtracted: false,
  };

  /* Users state */
  let invites = [];
  let nextInviteId = 1;
  const newInviteIds = new Set();

  /* Credits state */
  let selectedTier = null;
  let customAmount = '';
  let acquisitionBonusOffer = null;

  /* Billing state */
  // Signup auto top-up is kept behind this flag for the 1M8-81 signup test.
  const SIGNUP_AUTO_TOPUP_ENABLED = false;
  // Keep signup email verification available but out of the onboarding flow.
  const SIGNUP_EMAIL_VERIFICATION_ENABLED = false;
  let autoTopupEnabled = false;
  let topupThreshold = 50;
  let topupAmount = 100;
  let topupAmountManual = false;
  let autoTopupSectionUnlocked = false;

  /* Track whether user completed credits/billing */
  let didPurchase = false;
  let didAddCard = false;

  /**
   * Set to true when the user returns from the Stripe credit-purchase
   * checkout (paid=1 in URL + sessionStorage flag).  Means the card is
   * already on file from the first checkout, so page 4 skips the
   * "Add payment method" step and only offers the enable-auto-topup toggle.
   */
  let cardSavedViaCheckout = false;

  /**
   * Card details fetched from the org's billing profile during mount.
   * Populated whenever the org already has a payment method on file,
   * regardless of how it got there. Shape: { brand, last4, expMonth, expYear }
   */
  let savedCardInfo = null;
  let brandingSavePromise = null;
  let verificationEmail = ME_EMAIL || '';
  let verificationSent = false;
  let verificationBusy = false;
  let verificationMessage = '';
  let trackingFlushTimer = null;
  let currentPageEnteredAt = Date.now();

  const TRACKING_SS_KEY = 'ob_tracking_session_id';
  let trackingSessionId = (() => {
    try {
      const existing = sessionStorage.getItem(TRACKING_SS_KEY);
      if (existing) return existing;
      const next = `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(TRACKING_SS_KEY, next);
      return next;
    } catch(e) {
      return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  })();
  let trackingBuffer = [];

  function isMobileOnboarding(){
    const width = window.innerWidth || document.documentElement?.clientWidth || 0;
    const smallViewport = width > 0 && width <= 760;
    const mobileAgent = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
    let coarsePointer = false;
    try { coarsePointer = window.matchMedia('(hover: none) and (pointer: coarse)').matches; }
    catch(e) { coarsePointer = false; }
    return smallViewport && (mobileAgent || coarsePointer);
  }

  function visiblePages(){
    const pages = isMobileOnboarding() ? [0, 2] : [0, 1, 2];
    if (SIGNUP_EMAIL_VERIFICATION_ENABLED) pages.push(VERIFY_PAGE);
    return pages;
  }

  function pageName(page){
    if (page === 0) return 'branding';
    if (page === 1) return 'users';
    if (page === 2) return 'account_load';
    if (page === VERIFY_PAGE) return 'email_verification';
    return `page_${page}`;
  }

  function stepLabel(page){
    const pages = visiblePages();
    const index = Math.max(0, pages.indexOf(page));
    return `Step ${index + 1} of ${pages.length}`;
  }

  function nextVisiblePage(page){
    const pages = visiblePages();
    const index = pages.indexOf(page);
    return pages[Math.min(pages.length - 1, index + 1)] ?? page;
  }

  function previousVisiblePage(page){
    const pages = visiblePages();
    const index = pages.indexOf(page);
    return pages[Math.max(0, index - 1)] ?? page;
  }

  function normalizeCurrentPage(){
    const pages = visiblePages();
    if (!pages.includes(currentPage)) {
      currentPage = pages.find(p => p > currentPage) ?? pages[pages.length - 1] ?? 0;
    }
  }

  function deviceSnapshot(){
    return {
      is_mobile: isMobileOnboarding(),
      viewport_width: window.innerWidth || 0,
      viewport_height: window.innerHeight || 0,
      pixel_ratio: window.devicePixelRatio || 1,
      touch_points: navigator.maxTouchPoints || 0,
      user_agent: navigator.userAgent || '',
      platform: navigator.platform || ''
    };
  }

  function trackingSafeText(value, max = 240){
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function trackingControlLabel(el){
    if (!el) return '';
    const own = trackingSafeText(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.dataset?.trackingLabel || el.textContent || '', 160);
    if (own) return own;
    const id = el.id || '';
    const safeId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const label = id ? document.querySelector(`label[for="${safeId}"]`) : null;
    return trackingSafeText(label?.textContent || '', 160);
  }

  function trackingElementMeta(el){
    if (!el) return {};
    const data = {};
    for (const [key, value] of Object.entries(el.dataset || {})) {
      if (/^(inv|field|role|perm|amount|action|tab|page)$/i.test(key)) data[key] = trackingSafeText(value);
    }
    return {
      tag: trackingSafeText(el.tagName || '').toLowerCase(),
      id: trackingSafeText(el.id || ''),
      name: trackingSafeText(el.name || ''),
      type: trackingSafeText(el.type || el.getAttribute?.('type') || ''),
      label: trackingControlLabel(el),
      data,
      disabled: !!el.disabled
    };
  }

  function trackingFieldValue(el){
    if (!el) return {};
    const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
    const idName = `${el.id || ''} ${el.name || ''} ${el.dataset?.field || ''}`.toLowerCase();
    const value = String(el.value ?? '');
    const meta = {
      empty: value.trim() === '',
      length: value.length,
      input_type: type || trackingSafeText(el.tagName || '').toLowerCase()
    };

    if (type === 'file') {
      const files = Array.from(el.files || []);
      return {
        ...meta,
        file_count: files.length,
        file_types: files.map(file => trackingSafeText(file.type || 'unknown', 80)),
        file_sizes: files.map(file => Number(file.size || 0))
      };
    }
    if (type === 'password' || type === 'hidden' || idName.includes('otp') || idName.includes('code') || idName.includes('token') || idName.includes('secret')) {
      return { ...meta, redacted: true };
    }
    if (type === 'checkbox' || type === 'radio') {
      return { ...meta, checked: !!el.checked, value: trackingSafeText(value, 120) };
    }
    if (type === 'color') {
      return { ...meta, value: clampHex(value, '#000000') };
    }
    if (type === 'email' || idName.includes('email')) {
      const domain = value.includes('@') ? value.split('@').pop().trim().toLowerCase() : '';
      return { ...meta, has_at: value.includes('@'), domain: trackingSafeText(domain, 120) };
    }
    if (type === 'tel' || idName.includes('phone')) {
      return { ...meta, digit_count: value.replace(/\D/g, '').length };
    }
    if (idName.includes('website') || type === 'url') {
      return { ...meta, value: trackingSafeText(value, 240), domain: trackingSafeText(parseDomain(value), 160) };
    }
    if (type === 'number' || /amount|threshold|topup|tier/.test(idName)) {
      return { ...meta, value_number: parseInt(value.replace(/[^\d-]/g, ''), 10) || 0 };
    }
    if (el.tagName === 'SELECT') {
      return { ...meta, value: trackingSafeText(value, 160) };
    }
    return meta;
  }

  function inviteSnapshot(){
    return {
      invite_count: invites.length,
      valid_invite_count: invites.filter(i => i.email && i.email.includes('@')).length,
      roles: invites.map(i => i.role || 'viewer'),
      custom_permission_count: invites.filter(i => i.role === 'custom').length
    };
  }

  function accountLoadSnapshot(){
    const amount = selectedTier || parseInt(customAmount, 10) || 0;
    const quote = bonusQuoteForAmount(amount);
    return {
      selected_tier: selectedTier || null,
      custom_amount: parseInt(customAmount, 10) || 0,
      selected_amount: amount,
      bonus_valid: !!quote.valid,
      bonus_dollars: Math.round(quote.bonus_dollars || 0),
      bonus_match_percent: Number(quote.match_percent || 0),
      auto_topup_enabled: SIGNUP_AUTO_TOPUP_ENABLED && !!autoTopupEnabled,
      auto_topup_threshold: Math.max(50, Number(topupThreshold || 0)),
      auto_topup_amount: Math.max(50, Number(topupAmount || 0)),
      auto_topup_amount_manual: !!topupAmountManual
    };
  }

  function onboardingStateSnapshot(){
    return {
      branding: {
        website_entered: !!brandState.website,
        website_domain: trackingSafeText(brandState.domain || parseDomain(brandState.website || ''), 160),
        no_website: !!brandState.noWebsite,
        has_logo: !!brandState.logoUrl,
        logo_uploaded: !!brandState.logoFile,
        primary_color: clampHex(brandState.primary, '#D93025'),
        secondary_color: clampHex(brandState.secondary, '#960000'),
        colors_extracted: !!brandState.colorsExtracted
      },
      users: inviteSnapshot(),
      account_load: accountLoadSnapshot(),
      billing: {
        did_purchase: !!didPurchase,
        did_add_card: !!didAddCard,
        card_saved_via_checkout: !!cardSavedViaCheckout,
        saved_card_available: !!savedCardInfo
      },
      verification: {
        email_changed: String(verificationEmail || '').toLowerCase() !== (ME_EMAIL || '').toLowerCase(),
        verification_sent: !!verificationSent
      }
    };
  }

  function trackControlEvent(eventName, el, metadata = {}){
    trackOnboarding(eventName, {
      target: trackingSafeText(el?.id || el?.name || el?.dataset?.field || el?.dataset?.role || el?.dataset?.perm || ''),
      label: trackingControlLabel(el),
      metadata: {
        control: trackingElementMeta(el),
        ...metadata
      }
    });
  }

  function installSystematicOnboardingTracking(root){
    if (!root || root.__firstMateOnboardingTracking) return;
    root.__firstMateOnboardingTracking = true;

    root.addEventListener('click', (event) => {
      const el = event.target.closest('button,[role="button"],.ob-tier,.ob-logo-zone,.ob-preview-wrap,.ob-color-swatch');
      if (!el || !root.contains(el)) return;
      const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      trackControlEvent(isButton ? 'button_click' : 'control_click', el, {
        field_value: el.matches('input,select,textarea') ? trackingFieldValue(el) : {},
        state: isButton ? undefined : onboardingStateSnapshot()
      });
    });

    root.addEventListener('focusin', (event) => {
      const el = event.target.closest('input,select,textarea');
      if (!el || !root.contains(el) || el.type === 'hidden') return;
      trackControlEvent('field_focus', el, { field_value: trackingFieldValue(el) });
    });

    root.addEventListener('input', (event) => {
      const el = event.target.closest('input,select,textarea');
      if (!el || !root.contains(el) || el.type === 'hidden') return;
      trackControlEvent('field_input', el, { field_value: trackingFieldValue(el) });
    });

    root.addEventListener('change', (event) => {
      const el = event.target.closest('input,select,textarea');
      if (!el || !root.contains(el) || el.type === 'hidden') return;
      trackControlEvent('field_change', el, { field_value: trackingFieldValue(el), state: onboardingStateSnapshot() });
    });

    root.addEventListener('focusout', (event) => {
      const el = event.target.closest('input,select,textarea');
      if (!el || !root.contains(el) || el.type === 'hidden') return;
      trackControlEvent('field_blur', el, { field_value: trackingFieldValue(el), state: onboardingStateSnapshot() });
    });
  }

  function trackOnboarding(eventName, detail = {}){
    const now = new Date();
    trackingBuffer.push({
      id: `obe_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      event_name: eventName,
      session_id: trackingSessionId,
      step: pageName(currentPage),
      step_index: visiblePages().indexOf(currentPage),
      occurred_at: now.toISOString(),
      device: deviceSnapshot(),
      viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
      ...detail,
    });
    if (trackingBuffer.length >= 10) {
      flushOnboardingTracking();
      return;
    }
    clearTimeout(trackingFlushTimer);
    trackingFlushTimer = setTimeout(flushOnboardingTracking, 1500);
  }

  function flushOnboardingTracking(){
    clearTimeout(trackingFlushTimer);
    trackingFlushTimer = null;
    const events = trackingBuffer.splice(0, 50);
    if (!events.length) return;
    postAction('onboarding_track', {
      session_id: trackingSessionId,
      device: deviceSnapshot(),
      events_json: JSON.stringify(events),
    }).catch(() => {
      trackingBuffer = events.concat(trackingBuffer).slice(-100);
    });
  }

  /* ── Unified session persistence ─────────────────────────────────
   *
   * A single ob_wizard_state key in sessionStorage holds everything
   * needed to fully restore the wizard after a refresh or a Stripe
   * redirect.  logoFile is a File object and can't be serialised —
   * logoUrl (a string path/data-URL) is saved instead; the logo will
   * still render correctly from that URL on restore.
   *
   * stripeSource is non-null only while mid-Stripe-redirect:
   *   'credit_purchase'  — came from the credits checkout (Step 3)
   *   'topup_setup'      — came from the auto-topup card-setup (Step 4)
   * On a paid=1 return stripeSource tells boot() which flow completed.
   * On a back-button return it tells boot() which step to restore to.
   * ────────────────────────────────────────────────────────────────── */
  const SS_KEY = 'ob_wizard_state';
  const STRIPE_CHECKOUT_PENDING_KEY = 'fm_stripe_checkout_pending_v1';
  const ONBOARDING_STRIPE_MIN_RESTORE_WAIT_MS = 3000;
  const ONBOARDING_STRIPE_MAX_RESTORE_WAIT_MS = 9000;
  const ONBOARDING_STRIPE_HISTORY_POLL_MS = 1000;
  const ONBOARDING_STRIPE_COMPLETED_KEY_BASE = 'ob_stripe_credit_purchase_completed_v1';
  const SIGNUP_OTP_BYPASS_KEY = `ob_signup_otp_bypassed_${String(APP.userOrgId || APP.orgId || ME_EMAIL || 'anon')}`;
  let completingStripeCreditPurchase = false;

  function wait(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function signupOtpBypassRemembered(){
    try { return localStorage.getItem(SIGNUP_OTP_BYPASS_KEY) === '1'; } catch(e) { return false; }
  }

  function rememberSignupOtpBypass(){
    try { localStorage.setItem(SIGNUP_OTP_BYPASS_KEY, '1'); } catch(e) {}
  }

  function saveState() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        currentPage,
        brand: {
          website:        brandState.website,
          domain:         brandState.domain,
          noWebsite:      !!brandState.noWebsite,
          logoUrl:        brandState.logoUrl,
          primary:        brandState.primary,
          secondary:      brandState.secondary,
          colorsExtracted: brandState.colorsExtracted,
        },
        invites,
        nextInviteId,
        selectedTier,
        customAmount,
        topupThreshold,
        topupAmount,
        topupAmountManual,
        autoTopupSectionUnlocked,
        didPurchase,
        didAddCard,
        cardSavedViaCheckout,
        verificationEmail,
        verificationSent,
        verificationMessage,
        stripeSource: null,   // cleared on normal saves; set explicitly before Stripe redirects
      }));
    } catch(e){}
  }

  function saveStateForStripe(source, details = {}) {
    /* Like saveState() but stamps stripeSource so boot() knows we're
       mid-redirect.  Called immediately before window.location.href = url. */
    try {
      const blob = JSON.parse(sessionStorage.getItem(SS_KEY) || '{}');
      blob.stripeSource = source;
      blob.stripeStartedAt = Date.now();
      const sessionId = String(details.session_id || details.sessionId || '').trim();
      if (sessionId) blob.stripeSessionId = sessionId;
      sessionStorage.setItem(SS_KEY, JSON.stringify(blob));
    } catch(e){}
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return false;
      if (Object.prototype.hasOwnProperty.call(s, 'autoTopupEnabled')) {
        delete s.autoTopupEnabled;
        try { sessionStorage.setItem(SS_KEY, JSON.stringify(s)); } catch(e){}
      }

      if (typeof s.currentPage === 'number') {
        currentPage = ALL_PAGES.includes(s.currentPage) ? s.currentPage : 0;
      }

      if (s.brand && typeof s.brand === 'object') {
        brandState.website        = s.brand.website        || '';
        brandState.domain         = s.brand.domain         || '';
        brandState.noWebsite      = !!s.brand.noWebsite;
        brandState.logoUrl        = s.brand.logoUrl        || null;
        brandState.primary        = s.brand.primary        || '#D93025';
        brandState.secondary      = s.brand.secondary      || '#960000';
        brandState.colorsExtracted = !!s.brand.colorsExtracted;
      }

      if (Array.isArray(s.invites))     invites      = s.invites;
      if (typeof s.nextInviteId === 'number') nextInviteId = s.nextInviteId;

      selectedTier = activeLoadTiers().some(t => t.amount === s.selectedTier) ? s.selectedTier : null;
      const restoredCustomAmount = parseInt(s.customAmount, 10) || 0;
      customAmount = restoredCustomAmount > 0 ? String(restoredCustomAmount) : '';
      // Keep the old signup auto top-up behavior restorable by flipping
      // SIGNUP_AUTO_TOPUP_ENABLED back on after the 1M8-81 signup test.
      autoTopupEnabled = SIGNUP_AUTO_TOPUP_ENABLED;
      topupThreshold   = typeof s.topupThreshold === 'number' ? Math.max(50, s.topupThreshold) : 50;
      topupAmountManual = !!s.topupAmountManual;
      topupAmount      = topupAmountManual && typeof s.topupAmount === 'number'
        ? Math.max(50, s.topupAmount)
        : 100;
      autoTopupSectionUnlocked = !!s.autoTopupSectionUnlocked;
      didPurchase          = !!s.didPurchase;
      didAddCard           = !!s.didAddCard;
      cardSavedViaCheckout = !!s.cardSavedViaCheckout;
      verificationEmail = s.verificationEmail || ME_EMAIL || verificationEmail;
      verificationSent = !!s.verificationSent;
      verificationMessage = s.verificationMessage || '';

      normalizeCurrentPage();

      return true;
    } catch(e){ return false; }
  }

  function clearState() {
    try { sessionStorage.removeItem(SS_KEY); } catch(e){}
  }

  function onboardingStripeCompletedKey(){
    return `${ONBOARDING_STRIPE_COMPLETED_KEY_BASE}_${String(APP.userOrgId || APP.orgId || ME_EMAIL || 'anon')}`;
  }

  function clearLegacyUnscopedStripeCompletedKey(){
    try { sessionStorage.removeItem(ONBOARDING_STRIPE_COMPLETED_KEY_BASE); } catch(e){}
  }

  function rememberStripeCreditPurchaseCompleted(reason = 'unknown'){
    clearLegacyUnscopedStripeCompletedKey();
    try {
      sessionStorage.setItem(onboardingStripeCompletedKey(), JSON.stringify({
        completed_at: Date.now(),
        reason: String(reason || 'unknown')
      }));
    } catch(e){}
    window.__FM_ONBOARDING_STRIPE_CREDIT_COMPLETED = {
      key: onboardingStripeCompletedKey(),
      completed: true
    };
  }

  function stripeCreditPurchaseCompleted(){
    if (window.__FM_ONBOARDING_STRIPE_CREDIT_COMPLETED?.completed === true
      && window.__FM_ONBOARDING_STRIPE_CREDIT_COMPLETED?.key === onboardingStripeCompletedKey()) return true;
    clearLegacyUnscopedStripeCompletedKey();
    try {
      const key = onboardingStripeCompletedKey();
      const raw = sessionStorage.getItem(key);
      if (!raw) return false;
      const data = JSON.parse(raw);
      const completedAt = Number(data?.completed_at || 0);
      if (!completedAt || Date.now() - completedAt > 30 * 60 * 1000) {
        sessionStorage.removeItem(key);
        return false;
      }
      window.__FM_ONBOARDING_STRIPE_CREDIT_COMPLETED = {
        key,
        completed: true
      };
      return true;
    } catch(e){
      return false;
    }
  }

  function blockStaleOnboardingOpen(reason){
    if (!stripeCreditPurchaseCompleted()) return false;
    clearState();
    document.getElementById('obPrecover')?.remove();
    document.getElementById('obOverlay')?.remove();
    try {
      console.info('[OnboardingStripe] Blocked stale onboarding open after confirmed Stripe payment', {
        reason,
        url: window.location.href
      });
    } catch(e){}
    return true;
  }

  function checkoutSessionIdFromResponse(data){
    return String(data?.session?.id || data?.session_id || '').trim();
  }

  function rememberStripeCheckoutPending(details = {}){
    try {
      const id = String(details.session_id || details.sessionId || '').trim();
      if (!id) return;
      sessionStorage.setItem(STRIPE_CHECKOUT_PENDING_KEY, JSON.stringify({
        session_id: id,
        source: String(details.source || 'onboarding_credit_purchase'),
        amount: Number(details.amount) || 0,
        offer_id: String(details.offer_id || ''),
        offer_instance_id: String(details.offer_instance_id || ''),
        saved_at: Date.now()
      }));
      window.__FM_STRIPE_CHECKOUT_PENDING = true;
    } catch(e){}
  }

  function readSharedStripeCheckoutPending(){
    try {
      const raw = sessionStorage.getItem(STRIPE_CHECKOUT_PENDING_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch(e){
      return null;
    }
  }

  function onboardingStripeReconciliationActive(){
    const pending = readSharedStripeCheckoutPending();
    const pendingSource = String(pending?.source || '');
    return window.__FM_STRIPE_CHECKOUT_RECONCILING === true
      || pendingSource === 'onboarding_credit_purchase'
      || (window.Portal?.cfg?.stripePaidFlag === '1' && readWizardState()?.stripeSource === 'credit_purchase');
  }

  function wizardStripeStartedAt(saved = readWizardState()){
    const n = Number(saved?.stripeStartedAt || 0);
    return Number.isFinite(n) && n > 0 ? n : Date.now() - 5 * 60 * 1000;
  }

  function billingEntryTime(entry){
    const parsed = Date.parse(String(entry?.ts || entry?.created_at || entry?.date || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function billingEntryIsStripeCredit(entry, startedAt){
    if (!entry || typeof entry !== 'object') return false;
    const reason = String(entry.reason || entry.type || '').trim().toLowerCase();
    const delta = Number(entry.delta ?? entry.amount ?? 0);
    if (!(delta > 0)) return false;
    if (reason !== 'stripe_checkout_paid' && !reason.startsWith('stripe_checkout_paid')) return false;
    const ts = billingEntryTime(entry);
    return !ts || ts >= startedAt - 60 * 1000;
  }

  async function hasRecentStripeCredit(startedAt){
    try {
      await window.Portal?.credits?.refreshCredits?.().catch(()=>null);
      const { data } = await postAction('org_billing_history_my', { limit: '25' });
      const ledger = Array.isArray(data?.ledger) ? data.ledger : (Array.isArray(data?.transactions) ? data.transactions : []);
      return ledger.some((entry) => billingEntryIsStripeCredit(entry, startedAt));
    } catch(e){
      return false;
    }
  }

  async function waitForOnboardingStripeOutcome(reason = 'onboarding_stripe_pending'){
    const saved = readWizardState();
    if (saved?.stripeSource !== 'credit_purchase') return false;
    const startedAt = wizardStripeStartedAt(saved);
    const deadline = Date.now() + ONBOARDING_STRIPE_MAX_RESTORE_WAIT_MS;
    window.Portal?.stripeCheckout?.showOverlay?.('Confirming your payment...');
    await wait(ONBOARDING_STRIPE_MIN_RESTORE_WAIT_MS);
    while (Date.now() <= deadline) {
      if (await hasRecentStripeCredit(startedAt)) {
        await completeStripeCreditPurchaseOnboarding(reason);
        return true;
      }
      if (onboardingStripeReconciliationActive()) return true;
      window.Portal?.stripeCheckout?.showOverlay?.('Still confirming your payment...');
      await wait(ONBOARDING_STRIPE_HISTORY_POLL_MS);
    }
    window.Portal?.stripeCheckout?.hideOverlay?.();
    return false;
  }

  function readWizardState(){
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && typeof s === 'object' ? s : null;
    } catch(e){
      return null;
    }
  }

  function wizardStateIsRestorable(s){
    if (!s || typeof s !== 'object') return false;
    if (s.completed === true) return false;
    if (!s.stripeSource && s.didPurchase === true && s.cardSavedViaCheckout === true) return false;
    return true;
  }

  async function completeStripeCreditPurchaseOnboarding(reason = 'stripe_return'){
    if (completingStripeCreditPurchase) return true;
    const saved = readWizardState();
    if (saved?.stripeSource !== 'credit_purchase') return false;
    completingStripeCreditPurchase = true;
    try {
      restoreState();
      didPurchase = true;
      cardSavedViaCheckout = true;
      didAddCard = true;
      cleanOnboardingUrl();
      trackOnboarding('stripe_return', {
        metadata: {
          stripe_source: 'credit_purchase',
          reason,
          state: onboardingStateSnapshot()
        }
      });
      if (!SIGNUP_EMAIL_VERIFICATION_ENABLED) {
        try {
          await postAction('onboarding_complete', {
            did_purchase: '1',
            did_add_card: '1',
          });
        } catch(e){}
        rememberStripeCreditPurchaseCompleted(reason);
        clearState();
        flushOnboardingTracking();
        document.getElementById('obPrecover')?.remove();
        document.getElementById('obOverlay')?.remove();
        window.Portal?.credits?.refreshCredits?.().catch(()=>null);
        return true;
      }
      currentPage = VERIFY_PAGE;
      verificationSent = false;
      saveState();
      mount();
      return true;
    } finally {
      completingStripeCreditPurchase = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════
   *  MOUNT
   * ═══════════════════════════════════════════════════════════════ */
  async function mount(){
    if (blockStaleOnboardingOpen('mount')) return;
    injectCSS('onboarding_wizard', CSS);
    normalizeCurrentPage();

    const rootStyles = getComputedStyle(document.documentElement);
    const currentPrimary = rootStyles.getPropertyValue('--primary').trim();
    const currentSecondary = rootStyles.getPropertyValue('--secondary').trim();
    if (currentPrimary || currentSecondary) {
      applyLiveTheme(currentPrimary || brandState.primary, currentSecondary || brandState.secondary);
    }

    // Fetch org data once: resolve ORG_NAME and check for a saved payment method.
    // savedCardInfo is used by renderPage3 to show card details and skip Stripe setup.
    if (!ORG_NAME || !savedCardInfo) {
      try {
        const { data } = await postAction('org_get_my');
        if (data?.success) {
          if (!ORG_NAME && data.org?.name) ORG_NAME = data.org.name;
          if (!savedCardInfo) {
            const s = data.org?.billing?.stripe;
            if (s?.has_payment_method && s?.payment_method_id) {
              savedCardInfo = {
                brand:    s.brand     || null,
                last4:    s.last4     || null,
                expMonth: s.exp_month || null,
                expYear:  s.exp_year  || null,
              };
            }
          }
        }
      } catch(e){}
    }

    const overlay = document.createElement('div');
    overlay.id = 'obOverlay';
    overlay.className = 'ob-overlay';
    // Make the initially-active page dynamic so we can resume at any step.
    overlay.innerHTML = `
      <div class="ob-pages" id="obPages">
        ${ALL_PAGES.map(i =>
          `<div class="ob-page ${i === currentPage ? 'active' : ''}" id="obPage${i}" data-page="${i}"></div>`
        ).join('\n        ')}
      </div>
    `;
    document.body.appendChild(overlay);
    installSystematicOnboardingTracking(overlay);
    document.getElementById('obPrecover')?.remove(); // Remove instant cover — wizard overlay is now in place
    document.body.style.overflow = 'hidden';

    renderPage0();
    renderPage1();
    renderPage2();
    renderPage3();
    renderProgress();
    currentPageEnteredAt = Date.now();
    trackOnboarding('wizard_start', { metadata: { restored: !!hasWizardState(), mobile_flow: isMobileOnboarding() } });
    trackOnboarding('step_view', { step: pageName(currentPage), step_index: visiblePages().indexOf(currentPage) });
  }

  /* ── Navigation ──────────────────────────────────── */
  function goToPage(idx){
    const pagesInFlow = visiblePages();
    if (!pagesInFlow.includes(idx)) return;
    const previousPage = currentPage;
    const durationMs = Date.now() - currentPageEnteredAt;
    trackOnboarding('step_leave', {
      step: pageName(previousPage),
      step_index: pagesInFlow.indexOf(previousPage),
      duration_ms: durationMs,
      metadata: { next_step: pageName(idx), state: onboardingStateSnapshot() }
    });
    const pages = document.querySelectorAll('.ob-page');
    pages.forEach(p => {
      const pi = parseInt(p.dataset.page);
      if (pi === currentPage) {
        p.classList.remove('active');
        p.classList.add('exit-left');
      } else if (pi === idx) {
        p.style.transition = 'none';
        p.classList.remove('exit-left');
        p.classList.add('active');
        p.style.transform = 'translateX(60px)';
        p.style.opacity = '0';
        void p.offsetWidth;
        p.style.transition = '';
        p.style.transform = '';
        p.style.opacity = '';
      } else {
        p.classList.remove('active','exit-left');
      }
    });
    currentPage = idx;
    currentPageEnteredAt = Date.now();
    renderProgress();
    saveState();
    trackOnboarding('step_view', { step: pageName(currentPage), step_index: visiblePages().indexOf(currentPage) });
    if (currentPage === VERIFY_PAGE && !verificationSent && !verificationBusy) {
      sendVerificationCode(true);
    }
  }
  
  function dismissOnboarding(){
    // Clear persisted state so a refresh lands on the plain dashboard.
    clearState();
    flushOnboardingTracking();

    // Strip ?onboarding and ?paid from the URL as well.
    cleanOnboardingUrl();

    const overlay = document.getElementById('obOverlay');
    if (overlay){
      overlay.style.transition = 'opacity .35s ease';
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        document.body.style.overflow = '';
        /* Re-fetch theme from server so logo + all derived CSS vars update */
        if (typeof window.__refreshTheme === 'function') {
          window.__refreshTheme();
        }
      }, 360);
    }
  }

  async function finish(){
    trackOnboarding('finish_attempt', { metadata: { did_purchase: !!didPurchase, did_add_card: !!didAddCard, state: onboardingStateSnapshot() } });
    try {
      const { data } = await postAction('onboarding_complete', {
        did_purchase: didPurchase ? '1' : '0',
        did_add_card: didAddCard ? '1' : '0',
      });
      if (data?.success) {
        trackOnboarding('finish_success', { metadata: { state: onboardingStateSnapshot() } });
        dismissOnboarding();
        return;
      }
      if (data?.require_signup_otp) {
        rememberSignupOtpBypass();
        trackOnboarding('signup_otp_frontend_bypassed', { metadata: { email: data.email || verificationEmail || ME_EMAIL } });
        dismissOnboarding();
        return;
      }
      showToast((globalThis.PlatformLanguage?.text("onboarding","m_9607f68840c47e","Verification required") ?? "Verification required"), data?.error || 'Please verify your email to finish setup.', false);
    } catch(e) {
      showToast((globalThis.PlatformLanguage?.text("onboarding","m_714b747d11634d","Could not finish setup") ?? "Could not finish setup"), (globalThis.PlatformLanguage?.text("onboarding","m_4567836c628fdd","Please try again.") ?? "Please try again."), false);
    }
  }

  function renderProgress(){
    /* Render progress dots inside each active page header area */
    const pagesInFlow = visiblePages();
    document.querySelectorAll('.ob-page').forEach(p => {
      const pi = parseInt(p.dataset.page);
      let dots = p.querySelector('.ob-progress');
      if (!dots) {
        dots = document.createElement('div');
        dots.className = 'ob-progress';
        p.insertBefore(dots, p.firstChild);
      }
      if (!pagesInFlow.includes(pi)) {
        dots.innerHTML = '';
        return;
      }
      const activeIndex = pagesInFlow.indexOf(currentPage);
      dots.innerHTML = pagesInFlow.map((page, i) => {
        const cls = page === currentPage ? 'active' : (i < activeIndex ? 'done' : '');
        return `<div class="ob-dot ${cls}"></div>`;
      }).join('');
    });
  }

  function completeAfterVerification(){
    trackOnboarding('finish_success', { metadata: { verified_at_end: true, state: onboardingStateSnapshot() } });
    dismissOnboarding();
  }

  /*
  postAction('onboarding_complete', {
      did_purchase: didPurchase ? '1' : '0',
      did_add_card: didAddCard ? '1' : '0',
    }).catch(()=>{});
  */

  function cleanOnboardingUrl(){
    window.Portal?.navigation?.replace?.({ onboarding:null, onboardingMode:null, force_onboarding:null, forceOnboarding:null, paid:null, session_id:null }, { source:'onboarding-complete' });
  }

  function channelsPreviewMarkup(surface = 'inline'){
    const pageClass = surface === 'modal' ? 'ob-preview-modal-page' : 'ob-preview-page';
    const ownerInitial = esc((ME_NAME || ME_EMAIL || 'Y').slice(0, 1).toUpperCase());
    return `
      <div class="${String(pageClass)} ob-channels-preview" style="--ob-ch-primary:${String(esc(readableVariant(brandState.primary)))};--ob-ch-primary-rgb:${String(esc(hexToRgbCsv(readableVariant(brandState.primary)) || '217,48,37'))}">
        <div class="ob-ch-shell">
          <aside class="ob-ch-org-rail">
            <div class="ob-ch-brand"><div class="ob-preview-logo"><img class="ob-preview-logo-img" src="${String(esc(brandState.logoUrl || DEFAULT_LOGO))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_a63c5a4c25569b","Logo") ?? "Logo")}"></div></div>
            <div class="ob-ch-org-channels">
              <div class="ob-ch-quick">
                <div class="ob-ch-nav-item"><i class="fas fa-inbox"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_e9a006d430a9a6","All Unreads") ?? "All Unreads")}</span></div>
                <div class="ob-ch-nav-item"><i class="fas fa-bell"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_37fc206eefac3e","Activity") ?? "Activity")}</span></div>
                <div class="ob-ch-nav-item"><i class="fas fa-comments"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_3201c97f6b38ff","Threads") ?? "Threads")}</span></div>
              </div>
              <div class="ob-ch-section"><span>${(globalThis.PlatformLanguage?.text("onboarding","m_dc8b4f6c066b30","Channels") ?? "Channels")}</span><b>+</b><i class="fas fa-chevron-down"></i></div>
              <div class="ob-ch-nav-item active"><i class="fas fa-hashtag"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_d18c631c8e1203","general") ?? "general")}</span></div>
              <div class="ob-ch-nav-item"><i class="fas fa-hashtag"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_28c50346c6d5d4","announcements") ?? "announcements")}</span></div>
              <div class="ob-ch-section"><span>${(globalThis.PlatformLanguage?.text("onboarding","m_f304f7d46421ed","Direct messages") ?? "Direct messages")}</span><b>+</b><i class="fas fa-chevron-down"></i></div>
              <div class="ob-ch-nav-item"><span class="ob-ch-assistant-mark"></span><span>${(globalThis.PlatformLanguage?.text("onboarding","m_4aaef822b47692","FirstMate Assistant") ?? "FirstMate Assistant")}</span></div>
            </div>
            <div class="ob-ch-settings"><i class="fas fa-gear"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_7d461dc7d355cc","Settings") ?? "Settings")}</span></div>
            <div class="ob-ch-account"><div class="ob-ch-avatar">${String(ownerInitial)}</div><div class="ob-ch-account-copy"><strong>${String(esc(ME_NAME || 'You'))}</strong><span>${String(esc(ME_EMAIL || 'you@company.com'))}</span></div><i class="fas fa-chevron-up"></i></div>
          </aside>
          <section class="ob-ch-app">
            <header class="ob-ch-topbar"><div class="ob-ch-search"><i class="fas fa-magnifying-glass"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_874bb2f35611fe","Search channels and messages") ?? "Search channels and messages")}</span></div><div class="ob-ch-top-actions"><i class="fas fa-wand-magic-sparkles"></i><i class="fas fa-comment"></i><i class="fas fa-bell"></i></div></header>
            <div class="ob-ch-workspace">
              <section class="ob-ch-main">
                <header class="ob-ch-head"><i class="fas fa-arrow-left"></i><div class="ob-ch-title"><i class="fas fa-hashtag"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_d18c631c8e1203","general") ?? "general")}</div><div class="ob-ch-topic">${(globalThis.PlatformLanguage?.text("onboarding","m_12902fd6e80c3d","Company-wide announcements and chatter.") ?? "Company-wide announcements and chatter.")}</div><div class="ob-ch-actions"><i class="fas fa-bell"></i><i class="fas fa-bolt"></i><i class="fas fa-wand-magic-sparkles"></i><i class="fas fa-ellipsis"></i></div></header>
                <div class="ob-ch-tabs"><div class="ob-ch-tab active">${(globalThis.PlatformLanguage?.text("onboarding","m_820b9cb136d6ed","Messages") ?? "Messages")}</div><div class="ob-ch-tab">${(globalThis.PlatformLanguage?.text("onboarding","m_357a58f2b3675d","Files") ?? "Files")}</div><div class="ob-ch-tab">${(globalThis.PlatformLanguage?.text("onboarding","m_5d7c7ad6033624","Documents") ?? "Documents")}</div><div class="ob-ch-tab">${(globalThis.PlatformLanguage?.text("onboarding","m_4bec39f8fa90dd","To Dos") ?? "To Dos")}</div><div class="ob-ch-tab">${(globalThis.PlatformLanguage?.text("onboarding","m_576cd53c8d929f","Pins") ?? "Pins")}</div></div>
                <div class="ob-ch-messages">
                  <div class="ob-ch-message"><div class="ob-ch-avatar">A</div><div class="ob-ch-message-copy"><div class="ob-ch-message-head">${(globalThis.PlatformLanguage?.text("onboarding","m_0bbbc46fe72d5d","Alex Morgan ") ?? "Alex Morgan ")}<span class="ob-ch-time">${(globalThis.PlatformLanguage?.text("onboarding","m_f68605820f0efc","9:42 AM") ?? "9:42 AM")}</span></div><div class="ob-ch-text">${((v7) => globalThis.PlatformLanguage?.text("onboarding","m_f942751806fe4a",`Welcome to ${v7}! This channel is for company-wide updates and conversation.`,{v7}) ?? `Welcome to ${v7}! This channel is for company-wide updates and conversation.`)(esc(ORG_NAME || 'the team'))}</div><div class="ob-ch-reaction"><i class="fas fa-thumbs-up"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_e51b7d28a83ccc","&nbsp; 4") ?? "&nbsp; 4")}</div></div></div>
                  <div class="ob-ch-message"><div class="ob-ch-avatar">J</div><div class="ob-ch-message-copy"><div class="ob-ch-message-head">${(globalThis.PlatformLanguage?.text("onboarding","m_24ef52dbeb1cc7","Jordan Lee ") ?? "Jordan Lee ")}<span class="ob-ch-time">${(globalThis.PlatformLanguage?.text("onboarding","m_d09fb9b7b2a99b","10:08 AM") ?? "10:08 AM")}</span></div><div class="ob-ch-text">${(globalThis.PlatformLanguage?.text("onboarding","m_930e0901f46176","I added the launch notes to the Files tab.") ?? "I added the launch notes to the Files tab.")}</div></div></div>
                </div>
                <div class="ob-ch-composer"><div class="ob-ch-formatbar"><b>B</b><i>I</i><i class="fas fa-code"></i><i class="fas fa-list"></i></div><div class="ob-ch-compose"><span>${(globalThis.PlatformLanguage?.text("onboarding","m_182728baf40759","Message general") ?? "Message general")}</span><i class="fas fa-face-smile"></i><i class="fas fa-paperclip"></i><div class="ob-ch-send">${(globalThis.PlatformLanguage?.text("onboarding","m_c23a056552a09f","Send") ?? "Send")}</div></div></div>
              </section>
            </div>
          </section>
        </div>
      </div>`;
  }

  function workspacePreviewMarkup(surface = 'inline'){
    const pageClass = surface === 'modal' ? 'ob-preview-modal-page' : 'ob-preview-page';
    return `
      <div class="${String(pageClass)} ob-workspace-preview" style="--ob-ws-primary:${String(esc(readableVariant(brandState.primary)))};--ob-ws-primary-rgb:${String(esc(hexToRgbCsv(readableVariant(brandState.primary)) || '217,48,37'))}">
        <div class="ob-ws-shell">
          <aside class="ob-ws-rail">
            <div class="ob-ws-brand"><div class="ob-preview-logo"><img class="ob-preview-logo-img" src="${String(esc(brandState.logoUrl || DEFAULT_LOGO))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_a63c5a4c25569b","Logo") ?? "Logo")}"></div></div>
            <nav class="ob-ws-nav" aria-label="${(globalThis.PlatformLanguage?.text("onboarding","m_680abe10428803","Sample navigation") ?? "Sample navigation")}">
              <div class="ob-ws-nav-item active"><i class="fas fa-house"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_b69161f38dacdf","Overview") ?? "Overview")}</span></div>
              <div class="ob-ws-nav-item"><i class="fas fa-briefcase"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_222066ef57ae0e","Work") ?? "Work")}</span></div>
              <div class="ob-ws-nav-item"><i class="fas fa-user-group"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_9830fe947c8db6","Customers") ?? "Customers")}</span></div>
              <div class="ob-ws-nav-item"><i class="fas fa-calendar"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_77882a9c01fabf","Calendar") ?? "Calendar")}</span></div>
            </nav>
            <div class="ob-ws-profile"><div class="ob-ws-avatar">${String(esc((ME_NAME || 'Y').slice(0, 1).toUpperCase()))}</div><div class="ob-ws-profile-lines"><span class="ob-ws-line"></span><span class="ob-ws-line short"></span></div></div>
          </aside>
          <section class="ob-ws-app">
            <header class="ob-ws-topbar"><div class="ob-ws-search"><i class="fas fa-magnifying-glass"></i><span>${(globalThis.PlatformLanguage?.text("onboarding","m_55524759bb89e3","Search") ?? "Search")}</span></div><div class="ob-ws-tools"><i class="fas fa-wand-magic-sparkles"></i><i class="fas fa-bell"></i><i class="fas fa-gear"></i></div></header>
            <div class="ob-ws-content">
              <div class="ob-ws-page-head"><span class="ob-ws-heading"></span><span class="ob-ws-action"></span></div>
              <div class="ob-ws-cards"><div class="ob-ws-card"><span class="ob-ws-line"></span><span class="ob-ws-line"></span></div><div class="ob-ws-card"><span class="ob-ws-line"></span><span class="ob-ws-line"></span></div><div class="ob-ws-card"><span class="ob-ws-line"></span><span class="ob-ws-line"></span></div></div>
              <div class="ob-ws-table">${String([0,1,2,3].map(() => '<div class="ob-ws-table-row"><span class="ob-ws-line"></span><span class="ob-ws-line"></span><span class="ob-ws-line"></span></div>').join(''))}</div>
              <div class="ob-ws-modal"><div class="ob-ws-modal-head"><span class="ob-ws-modal-title"></span><i class="fas fa-xmark ob-ws-modal-close"></i></div><div class="ob-ws-modal-body"><div class="ob-ws-field"><span class="ob-ws-line"></span><span class="ob-ws-input"></span></div><div class="ob-ws-field"><span class="ob-ws-line"></span><span class="ob-ws-input"></span></div></div><div class="ob-ws-modal-footer"><span class="ob-ws-modal-btn"></span><span class="ob-ws-modal-btn primary"></span></div></div>
            </div>
          </section>
        </div>
      </div>`;
  }

  /* ── Update live preview ─────────────────────────── */
  function updatePreview(){
    applyLiveTheme(brandState.primary, brandState.secondary);
    /* Update all preview instances (inline + modal) */
    document.querySelectorAll('.ob-preview-bar-p').forEach(el => {
      el.style.background = brandState.primary;
    });
    document.querySelectorAll('.ob-preview-bar-s').forEach(el => {
      el.style.background = brandState.secondary;
    });
    document.querySelectorAll('.ob-preview-logo-img').forEach(img => {
      const wrap = img.closest('.ob-preview-logo');
      if (!brandState.logoUrl) {
        if (wrap) wrap.classList.add('default-firstmeasure-logo');
        img.removeAttribute('src');
        img.style.display = 'none';
        return;
      }
      if (wrap) wrap.classList.remove('default-firstmeasure-logo');
      img.style.display = '';
      setImgSmart(img, brandState.logoUrl);
    });
    document.querySelectorAll('.ob-prev-box').forEach(el => {
      el.style.borderLeftColor = brandState.primary;
    });
    document.querySelectorAll('.ob-prev-big').forEach(el => {
      el.style.color = brandState.primary;
    });
    document.querySelectorAll('.ob-channels-preview').forEach(el => {
      const accent = readableVariant(brandState.primary);
      el.style.setProperty('--ob-ch-primary', accent);
      const rgb = hexToRgbCsv(accent);
      if (rgb) el.style.setProperty('--ob-ch-primary-rgb', rgb);
    });
    document.querySelectorAll('.ob-workspace-preview').forEach(el => {
      const accent = readableVariant(brandState.primary);
      el.style.setProperty('--ob-ws-primary', accent);
      const rgb = hexToRgbCsv(accent);
      if (rgb) el.style.setProperty('--ob-ws-primary-rgb', rgb);
    });
  }

  function openPreviewModal(){
    const existing = document.querySelector('.ob-preview-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'ob-preview-modal';
    const channelsMode = channelsBrandingMode();
    const workspaceMode = homeImprovementBrandingMode();
    modal.innerHTML = `
      <div class="ob-preview-modal-inner${channelsMode ? ' ob-channels-preview-frame' : workspaceMode ? ' ob-workspace-preview-frame' : ''}">
        <button class="ob-preview-modal-close" type="button"><i class="fas fa-xmark"></i></button>
        ${channelsMode ? channelsPreviewMarkup('modal') : workspaceMode ? workspacePreviewMarkup('modal') : `<div class="ob-preview-modal-page">
          <div class="ob-preview-bar-p" style="background:${String(esc(brandState.primary))}"></div>
          <div class="ob-preview-bar-s" style="background:${String(esc(brandState.secondary))}"></div>
          <div class="ob-preview-inner">
            <div class="ob-preview-logo"><img class="ob-preview-logo-img" src="${String(esc(brandState.logoUrl || DEFAULT_LOGO))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_a63c5a4c25569b","Logo") ?? "Logo")}"></div>
            <div class="ob-prev-diagram"><img src="${String(esc(SAMPLE_DIAGRAM))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_77fc722124c288","Sample report") ?? "Sample report")}"></div>
            <div class="ob-prev-info">
              <div class="ob-prev-box left" style="border-left-color:${String(esc(brandState.primary))}">
                <div class="ob-prev-label">${(globalThis.PlatformLanguage?.text("onboarding","m_bad7dada05af1a","Prepared for") ?? "Prepared for")}</div>
                <div class="ob-prev-value ob-prev-orgname">${String(esc(ORG_NAME || 'Your Company'))}</div>
              </div>
              <div class="ob-prev-box right" style="border-left-color:${String(esc(brandState.primary))}">
                <div class="ob-prev-label">${(globalThis.PlatformLanguage?.text("onboarding","m_ae873abaa56707","Measurements") ?? "Measurements")}</div>
                <div class="ob-prev-value">${(globalThis.PlatformLanguage?.text("onboarding","m_8658b6cca50dd1","Squares") ?? "Squares")}</div>
                <div class="ob-prev-big" style="color:${String(esc(brandState.primary))}">23.5</div>
              </div>
            </div>
          </div>
        </div>`}
      </div>
    `;

    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      modal.remove();
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') close();
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    modal.querySelector('.ob-preview-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(modal);
    updatePreview();
  }

  /* ═══════════════════════════════════════════════════════════════
   *  PAGE 0: BRANDING
   * ═══════════════════════════════════════════════════════════════ */
  function renderPage0(){
    const page = document.getElementById('obPage0');
    if (!page) return;
    const channelsMode = channelsBrandingMode();
    const workspaceMode = homeImprovementBrandingMode();
    const inlinePreview = channelsMode ? channelsPreviewMarkup('inline') : workspaceMode ? workspacePreviewMarkup('inline') : `
      <div class="ob-preview-page">
        <div class="ob-preview-bar-p" style="background:${String(esc(brandState.primary))}"></div>
        <div class="ob-preview-bar-s" style="background:${String(esc(brandState.secondary))}"></div>
        <div class="ob-preview-inner">
          <div class="ob-preview-logo"><img class="ob-preview-logo-img" src="${String(esc(brandState.logoUrl || DEFAULT_LOGO))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_a63c5a4c25569b","Logo") ?? "Logo")}"></div>
          <div class="ob-prev-diagram"><img id="obSampleDiagram" src="${String(esc(SAMPLE_DIAGRAM))}" alt="${(globalThis.PlatformLanguage?.text("onboarding","m_77fc722124c288","Sample report") ?? "Sample report")}"></div>
          <div class="ob-prev-info">
            <div class="ob-prev-box left"><div class="ob-prev-label">${(globalThis.PlatformLanguage?.text("onboarding","m_bad7dada05af1a","Prepared for") ?? "Prepared for")}</div><div class="ob-prev-value ob-prev-orgname">${String(esc(ORG_NAME || 'Your Company'))}</div></div>
            <div class="ob-prev-box right"><div class="ob-prev-label">${(globalThis.PlatformLanguage?.text("onboarding","m_ae873abaa56707","Measurements") ?? "Measurements")}</div><div class="ob-prev-value">${(globalThis.PlatformLanguage?.text("onboarding","m_8658b6cca50dd1","Squares") ?? "Squares")}</div><div class="ob-prev-big">23.5</div></div>
          </div>
        </div>
      </div>`;

    page.innerHTML = `
      <div class="ob-progress"></div>
      <div class="ob-step-label">${String(stepLabel(0))}</div>
      <h1 class="ob-h1">${(globalThis.PlatformLanguage?.text("onboarding","m_2e992f8bee9c08","Welcome") ?? "Welcome")}</h1>
      <div class="ob-welcome-names">
        <div class="ob-name-user">${String(esc(ME_NAME || ME_EMAIL))}</div>
        <div class="ob-name-org">${String(esc(ORG_NAME || 'Your Company'))}</div>
      </div>

      <div class="ob-row">
        <label class="ob-lbl">${(globalThis.PlatformLanguage?.text("onboarding","m_6ab3729e8bcb2e","Company website") ?? "Company website")}</label>
        <div class="ob-website-row">
          <input class="ob-input" id="obWebsite" placeholder="${(globalThis.PlatformLanguage?.text("onboarding","m_992a2b48510215","yourcompany.com") ?? "yourcompany.com")}" autocomplete="url" spellcheck="false" value="${String(esc(brandState.website))}">
          <button class="ob-btn primary ob-btn-icon" id="obWebsiteGo" type="button">
            <i class="fas fa-arrow-right"></i>
          </button>
        </div>
        <button class="ob-alt-btn ${String(brandState.noWebsite ? 'active' : '')}" id="obNoWebsiteBtn" type="button">
          <i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_9cd6f3c7841cbf","\n          I don't have a website\n            ") ?? "\n          I don't have a website\n            ")}<span class="ob-check-sub">${(globalThis.PlatformLanguage?.text("onboarding","m_5aae5f95d8814d","I'll choose my colors manually.") ?? "I'll choose my colors manually.")}</span>
        </button>
      </div>

      <div class="ob-brand-section ${String(brandState.logoUrl || brandState.colorsExtracted ? 'open' : '')}" id="obBrandSection">
        <div class="ob-brand-copy">
          <div class="ob-brand-copy-title">${(globalThis.PlatformLanguage?.text("onboarding","m_427462d62692c7","Set your colors") ?? "Set your colors")}</div>
          <div class="ob-brand-copy-sub">${String(channelsMode ? 'Preview how your logo and colors will look in Channels.' : workspaceMode ? 'Preview your logo and colors in a sample company workspace.' : 'These colors will show up across your FirstMate workspace.')}</div>
        </div>
        <div class="ob-logo-area" id="obLogoArea">
          <div class="ob-logo-zone" id="obLogoZone">
            ${String(brandState.logoUrl
              ? `<img src="${esc(brandState.logoUrl)}" id="obLogoImg">`
              : '')}
            <div class="ob-logo-placeholder" id="obLogoPlaceholder">
              <i class="fas fa-cloud-arrow-up"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_eeed03da94eb62","\n              Tap to upload your own logo\n            ") ?? "\n              Tap to upload your own logo\n            ")}</div>
            <span class="ob-logo-mini-label"><i class="fas fa-pen" style="font-size:9px;"></i> ${String(brandState.logoUrl ? 'Tap to change' : 'Tap to upload your own logo')}</span>
            <input type="file" id="obLogoFile" accept="image/*">
          </div>
          <div class="ob-logo-actions" id="obLogoActions"></div>
        </div>

        <div class="ob-brand-bottom">
          <div class="ob-colors-zone">
            <div class="ob-color-row">
              <input type="color" class="ob-color-swatch" id="obPrimary" value="${String(brandState.primary)}">
            </div>
            <div class="ob-color-row">
              <input type="color" class="ob-color-swatch" id="obSecondary" value="${String(brandState.secondary)}">
            </div>
          </div>
          <div class="ob-preview-col">
            <div class="ob-preview-wrap" id="obPreviewWrap">
              ${String(inlinePreview)}
              <div class="ob-preview-tap"><i class="fas fa-expand"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_15bd98c986ce3d"," Expand preview") ?? " Expand preview")}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="ob-hint" id="obBrandHint" style="${String(brandState.noWebsite || brandState.domain ? '' : 'display:none;')}"><i class="fas fa-info-circle"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_678738328a6129"," You can adjust your logo and colors anytime from Company Settings.") ?? " You can adjust your logo and colors anytime from Company Settings.")}</div>

      <div class="ob-footer">
        <div></div>
        <div class="ob-footer-right">
          <button class="ob-btn ghost" id="obSkip0" type="button">${(globalThis.PlatformLanguage?.text("onboarding","m_2e3ee6f1c0203f","Skip") ?? "Skip")}</button>
          <button class="ob-btn primary" id="obNext0" type="button">${(globalThis.PlatformLanguage?.text("onboarding","m_dc6a60d7bb3581","Next ") ?? "Next ")}<i class="fas fa-arrow-right"></i></button>
        </div>
      </div>
    `;

    renderProgress();

    /* ── State helpers ──────────────────────────────── */
    const brandSec = document.getElementById('obBrandSection');
    const logoArea = document.getElementById('obLogoArea');
    const logoZone = document.getElementById('obLogoZone');
    const logoActions = document.getElementById('obLogoActions');
    const logoFile = document.getElementById('obLogoFile');
    const logoPlaceholder = document.getElementById('obLogoPlaceholder');
    const previewWrap = document.getElementById('obPreviewWrap');
    const noWebsiteBtn = document.getElementById('obNoWebsiteBtn');
    const brandHint = document.getElementById('obBrandHint');

    const obPage0 = document.getElementById('obPage0');

    function setLogoPlaceholder(text){
      if (!logoPlaceholder) return;
      logoPlaceholder.innerHTML = `<i class="fas fa-cloud-arrow-up"></i>${esc(text)}`;
    }

    function setLogoMiniLabel(text, icon = 'fa-cloud-arrow-up'){
      const miniLabel = logoZone?.querySelector('.ob-logo-mini-label');
      if (!miniLabel) return;
      miniLabel.innerHTML = `<i class="fas ${icon}" style="font-size:9px;"></i> ${esc(text)}`;
    }

    function syncSkipLogoLabel(){
      const skipBtn = document.getElementById('obSkip0');
      if (!skipBtn) return;
      const isLogoStep = brandSec.classList.contains('open')
        && brandSec.classList.contains('logo-expanded');
      skipBtn.textContent = isLogoStep ? 'Skip logo upload' : 'Skip';
    }

    function setLogoExpanded(){
      brandSec.classList.remove('logo-skipped');
      brandSec.classList.remove('logo-collapsed');
      brandSec.classList.add('logo-expanded');
      obPage0.classList.remove('no-scroll');
      syncSkipLogoLabel();
    }
    function setLogoCollapsed(){
      brandSec.classList.remove('logo-expanded');
      brandSec.classList.add('logo-collapsed');
      obPage0.classList.remove('no-scroll');
      syncSkipLogoLabel();
    }

    function syncBrandHint(){
      if (!brandHint) return;
      brandHint.style.display = (brandState.noWebsite || brandState.domain) ? '' : 'none';
    }

    /* Accept a logo URL: collapse logo area, expand preview, extract colors */
    async function acceptLogo(url){
      brandState.logoUrl = url;
      trackOnboarding('logo_selected', {
        metadata: {
          source: String(url || '').startsWith('blob:') ? 'upload' : 'website_lookup',
          has_logo: true,
          state: onboardingStateSnapshot()
        }
      });
      logoZone.classList.add('has-logo');
      brandSec.classList.add('logo-accepted');
      let img = logoZone.querySelector('img#obLogoImg');
      if (!img) {
        img = document.createElement('img');
        img.id = 'obLogoImg';
        logoZone.insertBefore(img, logoZone.firstChild);
      }
      img.src = url;
      /* Remove question text */
      const q = logoZone.querySelector('.ob-logo-q');
      if (q) q.remove();
      /* Clear actions */
      logoActions.innerHTML = '';
      /* Collapse logo, expand preview */
      setLogoCollapsed();
      updatePreview();

      /* Extract colors */
      const dataUrl = await fetchImageAsDataUrl(url);
      if (dataUrl) {
        const proxyImg = new Image();
        proxyImg.onload = async () => {
          const colors = await extractColors(proxyImg);
          brandState.primary = colors.primary;
          brandState.secondary = colors.secondary;
          brandState.colorsExtracted = true;
          syncColorInputs();
          updatePreview();
        };
        proxyImg.src = dataUrl;
      }
    }

    /* Show the upload/editing state */
    function showUploadMode(){
      setLogoExpanded();
      logoZone.classList.remove('has-logo');
      brandSec.classList.remove('logo-accepted');
      const oldImg = logoZone.querySelector('img#obLogoImg');
      if (oldImg) oldImg.remove();
      const q = logoZone.querySelector('.ob-logo-q');
      if (q) q.remove();
      brandState.logoUrl = null;
      brandState.logoFile = null;
      logoActions.innerHTML = '';
      /* Show placeholder */
      const ph = logoZone.querySelector('.ob-logo-placeholder');
      if (ph) ph.style.display = '';
      setLogoPlaceholder('Tap to upload your own logo');
      updatePreview();
    }

    function showColorsWithOptionalLogo(){
      logoSearchGen++;
      brandSec.classList.add('open');
      brandSec.classList.remove('logo-skipped');
      brandSec.classList.remove('logo-accepted');
      logoZone.classList.remove('has-logo');
      const spinner = logoZone.querySelector('.ob-logo-spinner');
      if (spinner) spinner.remove();
      const oldImg = logoZone.querySelector('img#obLogoImg');
      if (oldImg) oldImg.remove();
      const q = logoZone.querySelector('.ob-logo-q');
      if (q) q.remove();
      const ph = logoZone.querySelector('.ob-logo-placeholder');
      if (ph) ph.style.display = '';
      brandState.logoUrl = null;
      brandState.logoFile = null;
      logoActions.innerHTML = '';
      setLogoPlaceholder('Tap to upload your own logo');
      setLogoMiniLabel('Tap to upload your own logo');
      setLogoCollapsed();
      updatePreview();
      saveState();
    }

    /* ── Wire preview tap → fullscreen modal ─────── */
    if (previewWrap) {
      previewWrap.addEventListener('click', () => openPreviewModal());
    }

    /* ── Wire website input ─────────────────────── */
    const webInput = document.getElementById('obWebsite');
    const webGo = document.getElementById('obWebsiteGo');

    let logoSearchGen = 0;

    function skipWebsiteAndLogoToColors({ persist = true } = {}){
      logoSearchGen++;
      brandState.website = '';
      brandState.domain = '';
      brandState.noWebsite = true;
      brandState.logoUrl = null;
      brandState.logoFile = null;
      if (webInput) webInput.value = '';
      if (noWebsiteBtn) noWebsiteBtn.classList.add('active');
      brandSec.classList.add('open', 'logo-skipped');
      brandSec.classList.remove('logo-expanded', 'logo-accepted');
      logoZone.classList.remove('has-logo');
      const spinner = logoZone.querySelector('.ob-logo-spinner');
      if (spinner) spinner.remove();
      const oldImg = logoZone.querySelector('img#obLogoImg');
      if (oldImg) oldImg.remove();
      const q = logoZone.querySelector('.ob-logo-q');
      if (q) q.remove();
      logoActions.innerHTML = '';
      setLogoPlaceholder('Tap to upload your own logo');
      setLogoMiniLabel('Tap to upload your own logo');
      setLogoCollapsed();
      syncBrandHint();
      updatePreview();
      if (persist) saveState();
    }

    function syncWebsiteMode(){
      const noWebsite = !!brandState.noWebsite;
      if (webInput) webInput.disabled = false;
      if (webGo) webGo.disabled = false;
      if (noWebsiteBtn) noWebsiteBtn.classList.toggle('active', noWebsite);
      if (noWebsite) {
        skipWebsiteAndLogoToColors({ persist: false });
      }
      syncBrandHint();
      saveState();
    }

    const handleWebsite = async () => {
      const val = String(webInput.value || '').trim();
      brandState.website = val;
      brandState.domain = parseDomain(val);
      trackOnboarding('website_lookup_attempt', {
        metadata: {
          website_domain: trackingSafeText(brandState.domain, 160),
          value_length: val.length
        }
      });
      if (!brandState.domain) {
        trackOnboarding('website_lookup_error', { metadata: { reason: 'invalid_url', value_length: val.length } });
        showToast((globalThis.PlatformLanguage?.text("onboarding","m_ef860fcc2438d2","Invalid URL") ?? "Invalid URL"), (globalThis.PlatformLanguage?.text("onboarding","m_f9da02942ecaa9","Please enter a valid website address.") ?? "Please enter a valid website address."), false);
        return;
      }
      syncBrandHint();
      brandState.noWebsite = false;
      syncWebsiteMode();
      brandSec.classList.add('open');
      setLogoExpanded();

      /* Clear any previous state */
      logoZone.classList.remove('has-logo');
      const oldImg = logoZone.querySelector('img#obLogoImg');
      if (oldImg) oldImg.remove();
      const oldQ = logoZone.querySelector('.ob-logo-q');
      if (oldQ) oldQ.remove();
      logoActions.innerHTML = '';

      /* Show searching spinner */
      const spinner = document.createElement('div');
      spinner.className = 'ob-logo-spinner';
      spinner.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span class="ob-spinner-text">${(globalThis.PlatformLanguage?.text("onboarding","m_c3a01404101ce8","Searching for logo…") ?? "Searching for logo…")}</span>`;
      logoZone.appendChild(spinner);

      const gen = ++logoSearchGen;
      const found = await findBestLogo(brandState.domain);
      spinner.remove();

      /* Bail if user skipped/navigated during the search */
      if (gen !== logoSearchGen) return;
      if (brandSec.classList.contains('logo-collapsed')) return;

      if (found) {
        trackOnboarding('website_logo_found', {
          metadata: {
            website_domain: trackingSafeText(brandState.domain, 160),
            logo_source_host: (() => { try { return new URL(found, window.location.href).hostname; } catch(e){ return ''; } })()
          }
        });
        /* Show found logo inside the zone with question */
        logoZone.classList.add('has-logo');
        let img = logoZone.querySelector('img#obLogoImg');
        if (!img) {
          img = document.createElement('img');
          img.id = 'obLogoImg';
          logoZone.insertBefore(img, logoZone.firstChild);
        }
        img.src = found;

        /* Hide placeholder */
        const ph = logoZone.querySelector('.ob-logo-placeholder');
        if (ph) ph.style.display = 'none';

        /* Add question text inside zone */
        const qEl = document.createElement('div');
        qEl.className = 'ob-logo-q';
        qEl.textContent = (globalThis.PlatformLanguage?.text("onboarding","m_c3da268c6a1793","Is this your logo?") ?? "Is this your logo?");
        logoZone.appendChild(qEl);

        /* Buttons OUTSIDE the zone */
        logoActions.innerHTML = `
          <button class="ob-logo-action-btn yes" type="button"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_f01d0e54dfe853"," Yes") ?? " Yes")}</button>
          <button class="ob-logo-action-btn" type="button"><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_9b9eae6fc72fdb"," No") ?? " No")}</button>
        `;

        const [btnYes, btnNo] = logoActions.querySelectorAll('.ob-logo-action-btn');
        btnYes.addEventListener('click', () => acceptLogo(found));
        btnNo.addEventListener('click', () => showColorsWithOptionalLogo());
      } else {
        trackOnboarding('website_logo_not_found', {
          metadata: { website_domain: trackingSafeText(brandState.domain, 160) }
        });
        showColorsWithOptionalLogo();
      }
    };

    webGo.addEventListener('click', handleWebsite);
    webInput.addEventListener('focus', () => {
      if (!brandState.noWebsite) return;
      brandState.noWebsite = false;
      syncWebsiteMode();
    });
    webInput.addEventListener('input', () => {
      brandState.website = webInput.value;
      if (!brandState.noWebsite) return;
      brandState.noWebsite = false;
      syncWebsiteMode();
    });
    webInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleWebsite(); });
    noWebsiteBtn?.addEventListener('click', () => {
      brandState.noWebsite = true;
      trackOnboarding('website_skipped', { metadata: { reason: 'no_website_button', state: onboardingStateSnapshot() } });
      syncWebsiteMode();
    });

    /* ── Wire logo zone click ──────────────────── */
    logoZone.addEventListener('click', (e) => {
      /* If collapsed → re-expand for editing */
      if (brandSec.classList.contains('logo-collapsed')) {
        const visibleImg = logoZone.querySelector('img#obLogoImg');
        const visibleSrc = visibleImg?.src || null;

        if (!visibleSrc) {
          /* No logo at all — go straight to file picker */
          setLogoExpanded();
          logoFile.click();
          return;
        }
        setLogoExpanded();
        /* Show the current logo big again with option to apply or change */
        const q = logoZone.querySelector('.ob-logo-q');
        if (!q) {
          const qEl = document.createElement('div');
          qEl.className = 'ob-logo-q';
          qEl.textContent = brandState.logoUrl ? 'Tap to change logo' : 'Apply this logo?';
          logoZone.appendChild(qEl);
        }
        const applyLabel = brandState.logoUrl ? 'Keep this logo' : 'Yes, use this';
        logoActions.innerHTML = `
          <button class="ob-logo-action-btn yes" type="button"><i class="fas fa-check"></i> ${String(applyLabel)}</button>
          <button class="ob-logo-action-btn" type="button"><i class="fas fa-upload"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_79af7cef452dc0"," Upload different") ?? " Upload different")}</button>
        `;
        const [btnKeep, btnChange] = logoActions.querySelectorAll('.ob-logo-action-btn');
        btnKeep.addEventListener('click', () => {
          const q2 = logoZone.querySelector('.ob-logo-q');
          if (q2) q2.remove();
          logoActions.innerHTML = '';
          acceptLogo(visibleSrc);
        });
        btnChange.addEventListener('click', () => {
          logoFile.click();
        });
        return;
      }

      /* If in expanded state with actions showing (confirming), ignore zone click */
      if (logoActions.innerHTML.trim()) return;

      /* Otherwise open file picker */
      logoFile.click();
    });

    /* ── Wire file upload ──────────────────────── */
    logoFile.addEventListener('change', async () => {
      const f = logoFile.files?.[0];
      if (!f) return;
      trackOnboarding('logo_upload_selected', {
        metadata: {
          file_type: trackingSafeText(f.type || 'unknown', 80),
          file_size: Number(f.size || 0)
        }
      });

      brandState.logoFile = f;
      const url = URL.createObjectURL(f);
      brandState.logoUrl = url;
      logoZone.classList.add('has-logo');

      /* Remove question text and actions */
      const q = logoZone.querySelector('.ob-logo-q');
      if (q) q.remove();
      logoActions.innerHTML = '';

      let img = logoZone.querySelector('img#obLogoImg');
      if (!img) {
        img = document.createElement('img');
        img.id = 'obLogoImg';
        logoZone.insertBefore(img, logoZone.firstChild);
      }
      img.src = url;

      /* Hide placeholder */
      const ph = logoZone.querySelector('.ob-logo-placeholder');
      if (ph) ph.style.display = 'none';

      /* Collapse immediately */
      brandSec.classList.add('logo-accepted');
      setLogoCollapsed();
      updatePreview();

      img.onload = async () => {
        const colors = await extractColors(img);
        brandState.primary = colors.primary;
        brandState.secondary = colors.secondary;
        brandState.colorsExtracted = true;
        syncColorInputs();
        updatePreview();
      };
      brandSec.classList.add('open');
    });

    /* ── Wire color pickers ────────────────────── */
    function syncColorInputs(){
      const p = document.getElementById('obPrimary');
      const s = document.getElementById('obSecondary');
      if (p) p.value = clampHex(brandState.primary, '#D93025');
      if (s) s.value = clampHex(brandState.secondary, '#960000');
    }

    const bindColor = (pickerId, prop) => {
      const picker = document.getElementById(pickerId);
      if (picker) picker.addEventListener('input', () => {
        brandState[prop] = picker.value;
        if (prop === 'primary') applyPrimaryTextVar(picker.value);
        updatePreview();
        trackOnboarding('brand_color_changed', {
          target: pickerId,
          label: prop,
          metadata: {
            color_field: prop,
            value: clampHex(picker.value, prop === 'primary' ? '#D93025' : '#960000'),
            state: onboardingStateSnapshot()
          }
        });
      });
    };
    bindColor('obPrimary','primary');
    bindColor('obSecondary','secondary');
    syncBrandHint();
    syncWebsiteMode();

    /* ── Skip / Next ───────────────────────────── */
    const skip0 = document.getElementById('obSkip0');
    const next0 = document.getElementById('obNext0');

    async function saveBrandingAndContinue(){
      if (skip0.disabled || next0.disabled) return;
      skip0.disabled = true;
      next0.disabled = true;
      try {
        await saveBranding();
        // A host workflow can take over after the production branding step
        // without copying its website discovery, uploads, palette extraction,
        // or preview UI. Normal onboarding has no listener and continues to
        // the next built-in page exactly as before.
        const completionEvent = new CustomEvent('fm:onboarding:branding-complete', {
          cancelable: true,
          detail: { next_page: pageName(nextVisiblePage(0)), state: onboardingStateSnapshot() }
        });
        if (!window.dispatchEvent(completionEvent)) return;
        goToPage(nextVisiblePage(0));
      } finally {
        skip0.disabled = false;
        next0.disabled = false;
      }
    }

    skip0.addEventListener('click', async () => {
      if (!brandSec.classList.contains('open')) {
        skipWebsiteAndLogoToColors();
      } else if (brandSec.classList.contains('logo-expanded')) {
        /* Still on logo step — skip = don't apply logo, show preview */
        logoSearchGen++; /* cancel any pending search */
        /* Clean up any spinners, questions, actions */
        const spinner = logoZone.querySelector('.ob-logo-spinner');
        if (spinner) spinner.remove();
        const q = logoZone.querySelector('.ob-logo-q');
        if (q) q.remove();
        logoActions.innerHTML = '';
        /* Don't apply the logo to branding if not formally accepted */
        if (!brandSec.classList.contains('logo-accepted')) {
          /* Keep the image visible in the collapsed bar for reference,
             but clear it from brandState so it won't be used in reports */
          brandState.logoUrl = null;
          brandState.logoFile = null;
          /* Don't remove the img element — leave it visible */
          const hasImg = !!logoZone.querySelector('img#obLogoImg');
          logoZone.classList.toggle('has-logo', hasImg);
          updatePreview();
        }
        /* Update mini-label */
        const miniLabel = logoZone.querySelector('.ob-logo-mini-label');
        if (miniLabel) {
          const hasVisibleImg = !!logoZone.querySelector('img#obLogoImg');
          miniLabel.innerHTML = hasVisibleImg
            ? '<i class="fas fa-pen" style="font-size:9px;"></i> Tap to apply'
            : '<i class="fas fa-cloud-arrow-up" style="font-size:9px;"></i> Tap to upload your own logo';
        }
        setLogoCollapsed();
      } else {
        /* Already past logo, viewing preview — go to next page */
        await saveBrandingAndContinue();
      }
    });

    next0.addEventListener('click', async () => {
      if (!brandSec.classList.contains('open')) {
        /* Brand section not open yet — open it */
        brandSec.classList.add('open');
        setLogoExpanded();
      } else if (brandSec.classList.contains('logo-expanded')) {
        /* On logo step — next = accept whatever logo is showing, show preview */
        logoSearchGen++; /* cancel any pending search */
        const spinner = logoZone.querySelector('.ob-logo-spinner');
        if (spinner) spinner.remove();
        const q = logoZone.querySelector('.ob-logo-q');
        if (q) q.remove();
        logoActions.innerHTML = '';
        /* Grab the visible logo src (may not yet be in brandState) */
        const visibleImg = logoZone.querySelector('img#obLogoImg');
        const visibleSrc = visibleImg?.src || brandState.logoUrl;
        if (visibleSrc) {
          acceptLogo(visibleSrc);
        } else {
          /* No logo at all, just collapse to preview */
          setLogoCollapsed();
        }
      } else {
        /* Already past logo — save and go to next page */
        await saveBrandingAndContinue();
      }
    });

    /* ── Set initial state if already has logo ──── */
    if (brandState.noWebsite || brandSec.classList.contains('logo-skipped')) {
      setLogoCollapsed();
    } else if (brandState.logoUrl) {
      setLogoCollapsed();
      logoZone.classList.add('has-logo');
      brandSec.classList.add('logo-accepted');
    } else {
      setLogoExpanded();
    }
    syncSkipLogoLabel();
  }

  async function saveBranding(){
    if (brandingSavePromise) return brandingSavePromise;
    brandingSavePromise = (async () => {
    /* If the logo came from a URL (web scrape) rather than a file upload,
       fetch it through the proxy and convert to a File so it gets uploaded. */
      if (!brandState.logoFile && brandState.logoUrl
          && brandState.logoUrl !== DEFAULT_LOGO
          && !brandState.logoUrl.startsWith('organizations/')) {
        const dataUrl = await fetchImageAsDataUrl(brandState.logoUrl);
        if (dataUrl) {
          try {
            const r = await fetch(dataUrl);
            const blob = await r.blob();
            const ext = (blob.type || '').includes('png') ? 'png'
                      : (blob.type || '').includes('svg') ? 'svg'
                      : (blob.type || '').includes('webp') ? 'webp' : 'png';
            brandState.logoFile = new File([blob], 'logo.' + ext, { type: blob.type || 'image/png' });
          } catch(e){ /* best-effort */ }
        }
      }
      if (brandState.logoFile) {
        try {
          const APP_CFG = window.Portal.cfg || {};
          const fd = new FormData();
          fd.append('action', 'org_upload_logo_my');
          fd.append('actor_email', window.__APP?.userEmail || '');
          fd.append('actor_name', window.__APP?.userName || '');
          fd.append('actor_org_id', window.__APP?.userOrgId || '');
          fd.append('logo', brandState.logoFile);
          const res = await fetch(APP_CFG.serverEndpoint, { method:'POST', body:fd, credentials:'include' });
          const d = await res.json().catch(()=>null);
          if (d?.success) brandState.logoUrl = d.logo || brandState.logoUrl;
        } catch(e){ /* silent */ }
      }
      try {
        await postAction('org_update_my', {
          accent: brandState.primary,
          secondary: brandState.secondary,
        });
      } catch(e){ /* silent */ }
      applyLiveTheme(brandState.primary, brandState.secondary);

      /* Refresh the main page theme behind the overlay now, so that by the
         time the wizard dismisses everything is already visually in place. */
      if (typeof window.__refreshTheme === 'function') {
        window.__refreshTheme();   // fire-and-forget — runs in background
      }
      saveState(); // persist finalised logoUrl + colors
    })();
    try {
      await brandingSavePromise;
    } finally {
      brandingSavePromise = null;
    }
  }

  function applyLiveTheme(primary, secondary){
    const nextPrimary = clampHex(primary, '#D93025');
    const nextSecondary = clampHex(secondary, '#960000');
    document.documentElement.style.setProperty('--primary', nextPrimary);
    document.documentElement.style.setProperty('--secondary', nextSecondary);
    const primaryRgb = hexToRgbCsv(nextPrimary);
    if (primaryRgb) {
      document.documentElement.style.setProperty('--primary-rgb', primaryRgb);
    }
    const secondaryRgb = hexToRgbCsv(nextSecondary);
    if (secondaryRgb) {
      document.documentElement.style.setProperty('--secondary-rgb', secondaryRgb);
    }
    applyPrimaryTextVar(nextPrimary);
  }

  /* ═══════════════════════════════════════════════════════════════
   *  PAGE 1: USERS
   * ═══════════════════════════════════════════════════════════════ */
  function renderPage1(){
    const page = document.getElementById('obPage1');
    if (!page) return;

    const initial = ME_NAME ? ME_NAME.charAt(0).toUpperCase() : '?';

    page.innerHTML = `
      <div class="ob-progress"></div>
      <div class="ob-step-label">${String(stepLabel(1))}</div>
      <h2 class="ob-h2">${(globalThis.PlatformLanguage?.text("onboarding","m_d7433f84bf9cdf","Invite your team") ?? "Invite your team")}</h2>
      <p class="ob-sub">${(globalThis.PlatformLanguage?.text("onboarding","m_fb95d611553579","Add users who need access to the platform. You can set their permission levels now or adjust them later in Company Settings.") ?? "Add users who need access to the platform. You can set their permission levels now or adjust them later in Company Settings.")}</p>

      <div class="ob-user-me">
        <div class="ob-avatar">${String(esc(initial))}</div>
        <div class="ob-user-info">
          <div class="ob-user-name">${String(esc(ME_NAME || ME_EMAIL))}</div>
          <div class="ob-user-email">${String(esc(ME_EMAIL))}</div>
        </div>
        <div class="ob-role-tag"><i class="fas fa-shield-halved"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_77d6550d8a0aa9"," Super Admin") ?? " Super Admin")}</div>
      </div>

      <div class="ob-invite-list" id="obInviteList"></div>

      <button class="ob-add-user-btn" id="obAddUser" type="button">
        <i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_d131ad7aadedbb"," Add a team member\n      ") ?? " Add a team member\n      ")}</button>

      <div class="ob-hint"><i class="fas fa-info-circle"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_163c9e8ccdb047"," You can manage users anytime from the Users section in Company Settings.") ?? " You can manage users anytime from the Users section in Company Settings.")}</div>

      <div class="ob-footer">
        <button class="ob-btn ghost" id="obBack1" type="button"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_206d31a7c795c4"," Back") ?? " Back")}</button>
        <div class="ob-footer-right">
          <button class="ob-btn ghost" id="obSkip1" type="button">${(globalThis.PlatformLanguage?.text("onboarding","m_2e3ee6f1c0203f","Skip") ?? "Skip")}</button>
          <button class="ob-btn primary" id="obNext1" type="button">
            ${String(invites.length > 0 ? 'Send invites' : 'Next')} <i class="fas fa-arrow-right"></i>
          </button>
        </div>
      </div>
    `;

    renderProgress();
    renderInviteList();

    document.getElementById('obAddUser').addEventListener('click', () => {
      const id = nextInviteId++;
      newInviteIds.add(id);
      invites.push({
        id,
        name: '', email: '',
        role: 'viewer',
        perms: { ...ROLE_PERM_DEFAULTS.viewer },
      });
      trackOnboarding('invite_added', { metadata: { invite_id: id, users: inviteSnapshot() } });
      renderInviteList();
      updateNext1Label();
      saveState();
    });

    document.getElementById('obBack1').addEventListener('click', () => goToPage(previousVisiblePage(1)));
    document.getElementById('obSkip1').addEventListener('click', () => {
      trackOnboarding('invite_step_skipped', { metadata: { users: inviteSnapshot(), state: onboardingStateSnapshot() } });
      goToPage(nextVisiblePage(1));
    });
    document.getElementById('obNext1').addEventListener('click', async () => {
      const toSend = invites.filter(i => i.email && i.email.includes('@'));
      trackOnboarding('invite_step_submit', { metadata: { users: inviteSnapshot(), submit_count: toSend.length } });
      if (toSend.length > 0) {
        const btn = document.getElementById('obNext1');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
        for (const inv of toSend) {
          try {
            await postAction('org_users_add_my', {
              email: inv.email,
              name: inv.name,
              perm_level: inv.role,
              perm_items_json: JSON.stringify(inv.perms),
            });
          } catch(e){ /* continue */ }
        }
        btn.disabled = false;
        showToast((globalThis.PlatformLanguage?.text("onboarding","m_b982de697abe2d","Invites sent") ?? "Invites sent"), ((v0,v1) => globalThis.PlatformLanguage?.text("onboarding","m_507489a99d1632",`${v0} invite${v1} sent.`,{v0,v1}) ?? `${v0} invite${v1} sent.`)(toSend.length,toSend.length>1?'s':''), true);
      }
      goToPage(nextVisiblePage(1));
    });
  }

  function updateNext1Label(){
    const btn = document.getElementById('obNext1');
    if (!btn) return;
    const hasInvites = invites.some(i => i.email && i.email.includes('@'));
    btn.innerHTML = hasInvites
      ? 'Send invites <i class="fas fa-paper-plane"></i>'
      : 'Next <i class="fas fa-arrow-right"></i>';
  }

  function getPermState(inv) {
    if (inv.role === 'custom') return inv.perms;
    return ROLE_PERM_DEFAULTS[inv.role] || {};
  }

  function renderInviteList(){
    const list = document.getElementById('obInviteList');
    if (!list) return;

    list.innerHTML = invites.map(inv => {
      const isNew = newInviteIds.has(inv.id);
      const effectivePerms = getPermState(inv);

      const roleButtons = ROLE_PRESETS.map(rp =>
        `<button class="ob-role-btn ${inv.role === rp.v ? 'active' : ''}" data-inv="${inv.id}" data-role="${rp.v}" type="button">
          <i class="fas ${rp.icon}"></i> ${rp.label}
        </button>`
      ).join('') +
      `<button class="ob-role-btn ${String(inv.role === 'custom' ? 'active' : '')}" data-inv="${String(inv.id)}" data-role="custom" type="button">
        <i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_2b39214759d91a"," Custom\n      ") ?? " Custom\n      ")}</button>`;

      const permButtons = PERM_META.map(pm => {
        const on = !!effectivePerms[pm.k];
        return `<button class="ob-perm-btn ${on ? 'on' : ''}" data-inv="${inv.id}" data-perm="${pm.k}" type="button">
          <span class="dot"></span> ${pm.label}
        </button>`;
      }).join('');

      return `
        <div class="ob-invite-row ${String(isNew ? 'ob-new' : '')}" data-inv="${String(inv.id)}">
          <div class="ob-invite-top">
            <input class="ob-input" placeholder="${(globalThis.PlatformLanguage?.text("onboarding","m_8cf345002184e5","Name") ?? "Name")}" data-inv="${String(inv.id)}" data-field="name" value="${String(esc(inv.name))}">
            <input class="ob-input" placeholder="${(globalThis.PlatformLanguage?.text("onboarding","m_83cc567bdd3fa7","email@company.com") ?? "email@company.com")}" data-inv="${String(inv.id)}" data-field="email" value="${String(esc(inv.email))}" inputmode="email">
            <button class="ob-invite-remove" data-inv="${String(inv.id)}" type="button"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="ob-role-presets">${String(roleButtons)}</div>
          <div class="ob-perms-grid" data-inv="${String(inv.id)}">
            <div class="ob-perms-label">${(globalThis.PlatformLanguage?.text("onboarding","m_0ded144729a113","Permissions") ?? "Permissions")}</div>
            ${String(permButtons)}
          </div>
        </div>
      `;
    }).join('');

    newInviteIds.clear();

    /* Wire events */
    list.querySelectorAll('input[data-field]').forEach(inp => {
      inp.addEventListener('input', () => {
        const inv = invites.find(i => i.id === parseInt(inp.dataset.inv));
        if (inv) inv[inp.dataset.field] = inp.value.trim();
        trackOnboarding('invite_field_updated', {
          target: trackingSafeText(inp.dataset.field),
          metadata: {
            invite_id: parseInt(inp.dataset.inv),
            field: trackingSafeText(inp.dataset.field),
            field_value: trackingFieldValue(inp),
            users: inviteSnapshot()
          }
        });
        updateNext1Label();
      });
    });

    list.querySelectorAll('.ob-invite-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const inviteId = parseInt(btn.dataset.inv);
        invites = invites.filter(i => i.id !== parseInt(btn.dataset.inv));
        trackOnboarding('invite_removed', { metadata: { invite_id: inviteId, users: inviteSnapshot() } });
        renderInviteList();
        updateNext1Label();
      });
    });

    list.querySelectorAll('.ob-role-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const inv = invites.find(i => i.id === parseInt(btn.dataset.inv));
        if (!inv) return;
        const role = btn.dataset.role;
        inv.role = role;
        if (role !== 'custom') {
          inv.perms = { ...(ROLE_PERM_DEFAULTS[role] || {}) };
        }
        trackOnboarding('invite_role_selected', {
          target: trackingSafeText(role),
          metadata: { invite_id: inv.id, role, users: inviteSnapshot() }
        });
        const row = btn.closest('.ob-invite-row');
        row.querySelectorAll('.ob-role-btn').forEach(rb =>
          rb.classList.toggle('active', rb.dataset.role === role)
        );
        const effectivePerms = getPermState(inv);
        row.querySelectorAll('.ob-perm-btn').forEach(pb => {
          pb.classList.toggle('on', !!effectivePerms[pb.dataset.perm]);
        });
      });
    });

    list.querySelectorAll('.ob-perm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const inv = invites.find(i => i.id === parseInt(btn.dataset.inv));
        if (!inv) return;
        const key = btn.dataset.perm;

        if (inv.role !== 'custom') {
          inv.perms = { ...(ROLE_PERM_DEFAULTS[inv.role] || {}) };
          inv.role = 'custom';
          const row = btn.closest('.ob-invite-row');
          row.querySelectorAll('.ob-role-btn').forEach(rb =>
            rb.classList.toggle('active', rb.dataset.role === 'custom')
          );
        }

        inv.perms[key] = !inv.perms[key];
        btn.classList.toggle('on', !!inv.perms[key]);
        trackOnboarding('invite_permission_toggled', {
          target: trackingSafeText(key),
          metadata: { invite_id: inv.id, permission: key, enabled: !!inv.perms[key], role: inv.role, users: inviteSnapshot() }
        });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   *  PAGE 2: CREDITS / PROMO
   * ═══════════════════════════════════════════════════════════════ */
  function renderPage2(){
    const page = document.getElementById('obPage2');
    if (!page) return;

    const loadTiers = activeLoadTiers();
    const bonusMinimum = bonusMinimumLoadAmount();
    const bonusIntroHtml = bonusOfferEnabled()
      ? `<p class="ob-sub ob-bonus-copy"><i class="fas fa-gift" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_95ed713993880f","As a new customer, we're offering a ") ?? "As a new customer, we're offering a ")}<strong>${(globalThis.PlatformLanguage?.text("onboarding","m_dbf7ed5d0bf61d","one time bonus match") ?? "one time bonus match")}</strong>${((v0) => globalThis.PlatformLanguage?.text("onboarding","m_71f966e787feb1",` on your first load of more than ${v0}.`,{v0}) ?? ` on your first load of more than ${v0}.`)(esc(`$${bonusMinimum}`))}</p>`
      : `<p class="ob-sub">${(globalThis.PlatformLanguage?.text("onboarding","m_8f203cf0d6d287","Load your account now, then add your card in our secure checkout.") ?? "Load your account now, then add your card in our secure checkout.")}</p>`;
    const tiersHtml = loadTiers.map(t => {
      const bonusText = bonusDollarsText(t.amount);
      return `
        <div class="ob-tier ${selectedTier === t.amount ? 'selected' : ''}" data-amount="${t.amount}">
          <div class="ob-tier-main">
            <div class="ob-tier-amount">$${t.amount}</div>
            ${bonusText ? `<div class="ob-tier-bonus">${esc(bonusText)}</div>` : ''}
          </div>
          <div class="ob-tier-total">${esc(totalCreditsText(t.amount))}</div>
        </div>
      `;
    }).join('');

    const customSelected = !selectedTier && customAmount;
    const customPreviewAmount = parseInt(customAmount, 10) || 0;
    const customTileHtml = `
      <div class="ob-tier ob-tier-custom ${String(customSelected ? 'selected' : '')}" id="obCustomTile">
        <div class="ob-tier-custom-label">${(globalThis.PlatformLanguage?.text("onboarding","m_6edcf7d7d41112","Custom") ?? "Custom")}</div>
        <div style="display:flex;align-items:center;gap:3px;">
          <span style="font-size:16px;font-weight:900;color:rgba(0,0,0,.35);">$</span>
          <input class="ob-tier-custom-input" id="obCustomAmount" placeholder="—" inputmode="numeric" value="${String(esc(customAmount))}">
        </div>
        <div class="ob-tier-custom-preview" id="obCustomPreview" style="${String(customPreviewAmount ? '' : 'display:none;')}">${String(customPreviewAmount ? customBonusPreviewHtml(customPreviewAmount) : '')}</div>
      </div>
    `;

    page.innerHTML = `
      <div class="ob-progress"></div>
      <div class="ob-step-label">${String(stepLabel(2))}</div>
      <h2 class="ob-h2">${(globalThis.PlatformLanguage?.text("onboarding","m_3460e2ac6317dc","Load your account") ?? "Load your account")}</h2>
      ${String(bonusIntroHtml)}

      <div class="ob-tier-grid" id="obTierGrid">${String(tiersHtml)}${String(customTileHtml)}</div>
      <div class="ob-topup-msg" id="obLoadMsg" aria-live="polite"></div>

      ${String(SIGNUP_AUTO_TOPUP_ENABLED ? `
      <div class="ob-topup-config ob-topup-config-gated ${autoTopupSectionUnlocked || selectedTier || customAmount ? 'is-visible' : ''}" id="obTopupConfig">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
          <div>
            <div class="ob-h2" style="font-size:20px;margin:0;">Auto Top-up</div>
            <div class="ob-sub" style="margin:6px 0 0;">Keep my account funded automatically.</div>
          </div>
          <button class="ob-toggle-switch ${autoTopupEnabled ? 'on' : ''}" id="obAutoToggle" type="button"></button>
        </div>

        <div id="obTopupControls" style="opacity:${autoTopupEnabled ? '1' : '.4'};pointer-events:${autoTopupEnabled ? 'auto' : 'none'};">
          <div class="ob-topup-row" style="margin-top:14px;">
            <div class="ob-topup-label"><i class="fas fa-arrow-down"></i> Top up when below</div>
            <div class="ob-topup-ctrl">
              <button class="ob-topup-step" id="obThMinus" type="button"><i class="fas fa-minus"></i></button>
              <span class="ob-usd" style="color:rgba(0,0,0,.4);font-weight:900;">$</span>
              <input class="ob-input ob-topup-input" id="obThreshold" value="${topupThreshold}" inputmode="numeric">
              <button class="ob-topup-step" id="obThPlus" type="button"><i class="fas fa-plus"></i></button>
            </div>
          </div>
          <div class="ob-topup-row">
            <div class="ob-topup-label"><i class="fas fa-cart-plus"></i> Auto top-up amount</div>
            <div class="ob-topup-ctrl">
              <button class="ob-topup-step" id="obAmtMinus" type="button"><i class="fas fa-minus"></i></button>
              <span class="ob-usd" style="color:rgba(0,0,0,.4);font-weight:900;">$</span>
              <input class="ob-input ob-topup-input" id="obTopupAmt" value="${topupAmount}" inputmode="numeric">
              <button class="ob-topup-step" id="obAmtPlus" type="button"><i class="fas fa-plus"></i></button>
            </div>
          </div>
          <div class="ob-topup-msg" id="obTopupMsg" aria-live="polite"></div>
        </div>
        <div class="ob-auto-summary" id="obAutoSummary"></div>
      </div>
      ` : '')}

      <div class="ob-footer">
        <button class="ob-btn ghost" id="obBack2" type="button"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_206d31a7c795c4"," Back") ?? " Back")}</button>
        <div class="ob-footer-right">
          <button class="ob-btn ghost" id="obSkip2" type="button">${(globalThis.PlatformLanguage?.text("onboarding","m_2e3ee6f1c0203f","Skip") ?? "Skip")}</button>
          <button class="ob-btn primary" id="obNext2" type="button" ${String(!selectedTier && !customAmount ? 'disabled' : '')}>${(globalThis.PlatformLanguage?.text("onboarding","m_8fd20318945f78","\n            Checkout ") ?? "\n            Checkout ")}<i class="fas fa-arrow-right"></i>
          </button>
        </div>
      </div>
    `;

    renderProgress();

    const loadMsg = document.getElementById('obLoadMsg');
    const customTile = document.getElementById('obCustomTile');
    const custInput = document.getElementById('obCustomAmount');
    const toggle = document.getElementById('obAutoToggle');
    const topupConfig = document.getElementById('obTopupConfig');
    const controls = document.getElementById('obTopupControls');
    const topupMsg = document.getElementById('obTopupMsg');
    const autoSummary = document.getElementById('obAutoSummary');
    const minTopupDollars = 50;
    const topupStep = 10;

    function getSelectedLoadAmount(){
      return selectedTier || (parseInt(customAmount, 10) || 0);
    }

    function shouldShowAutoTopupSection(){
      return autoTopupSectionUnlocked || getSelectedLoadAmount() > 0;
    }

    function syncDefaultTopupAmount(){
      if (topupAmountManual) return;
      topupAmount = 100;
      const topupInput = document.getElementById('obTopupAmt');
      if (topupInput) topupInput.value = '100';
      syncAutoSummary();
    }

    function syncLoadDrivenAutoTopupVisibility(){
      const shouldShow = shouldShowAutoTopupSection();
      if (topupConfig) topupConfig.classList.toggle('is-visible', shouldShow);
      if (!shouldShow) setTopupMessage('');
    }

    function syncAutoSummary(){
      if (!autoSummary) return;
      if (!autoTopupEnabled) {
        autoSummary.style.display = 'none';
        autoSummary.textContent = '';
        return;
      }
      autoSummary.style.display = '';
      autoSummary.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("onboarding","m_f38174b09afe58",`If your balance falls below $${v0}, we will automatically add $${v1} to your account.`,{v0,v1}) ?? `If your balance falls below $${v0}, we will automatically add $${v1} to your account.`)(topupThreshold,topupAmount);
    }

    function setLoadMessage(text){
      if (loadMsg) loadMsg.textContent = text || '';
    }

    function setTopupMessage(text){
      if (topupMsg) topupMsg.textContent = text || '';
    }

    function syncAutoTopupUI(){
      if (toggle) toggle.classList.toggle('on', autoTopupEnabled);
      if (controls) {
        controls.style.opacity = autoTopupEnabled ? '1' : '.4';
        controls.style.pointerEvents = autoTopupEnabled ? 'auto' : 'none';
      }
      if (!autoTopupEnabled) setTopupMessage('');
      syncAutoSummary();
      syncLoadDrivenAutoTopupVisibility();
    }

    /* Wire tier selection */
    document.querySelectorAll('.ob-tier:not(.ob-tier-custom)').forEach(el => {
      el.addEventListener('click', () => {
        selectedTier = parseInt(el.dataset.amount);
        customAmount = '';
        trackOnboarding('account_load_tier_selected', {
          target: trackingSafeText(el.dataset.amount),
          metadata: { amount: selectedTier, quote: bonusQuoteForAmount(selectedTier), account_load: accountLoadSnapshot() }
        });
        const custInput = document.getElementById('obCustomAmount');
        if (custInput) custInput.value = '';
        document.querySelectorAll('.ob-tier').forEach(t => {
          t.classList.toggle('selected', parseInt(t.dataset.amount) === selectedTier);
        });
        document.getElementById('obCustomTile')?.classList.remove('selected');
        autoTopupSectionUnlocked = true;
        syncDefaultTopupAmount();
        syncLoadDrivenAutoTopupVisibility();
        setLoadMessage('');
        updateCustomPreview2();
        updateNext2State();
        saveState();
      });
    });

    customTile.addEventListener('click', (e) => {
      if (e.target !== custInput) custInput.focus();
    });

    custInput.addEventListener('input', () => {
      const raw = custInput.value.replace(/[^\d]/g, '');
      const parsed = parseInt(raw, 10) || 0;
      const clamped = parsed > 0 ? parsed : 0;
      customAmount = clamped > 0 ? String(clamped) : '';
      custInput.value = customAmount;
      selectedTier = null;
      document.querySelectorAll('.ob-tier:not(.ob-tier-custom)').forEach(t => t.classList.remove('selected'));
      customTile.classList.toggle('selected', !!customAmount);
      if (customAmount) autoTopupSectionUnlocked = true;
      syncDefaultTopupAmount();
      syncLoadDrivenAutoTopupVisibility();
      setLoadMessage('');
      updateCustomPreview2();
      updateNext2State();
      trackOnboarding('account_load_custom_amount_previewed', {
        target: 'obCustomAmount',
        metadata: { amount: clamped, quote: bonusQuoteForAmount(clamped), account_load: accountLoadSnapshot() }
      });
      saveState();
    });
    custInput.addEventListener('focus', () => {
      selectedTier = null;
      document.querySelectorAll('.ob-tier:not(.ob-tier-custom)').forEach(t => t.classList.remove('selected'));
      customTile.classList.add('selected');
    });

    document.getElementById('obBack2').addEventListener('click', () => goToPage(previousVisiblePage(2)));
    document.getElementById('obSkip2').addEventListener('click', () => {
      trackOnboarding('account_load_skipped', { metadata: { account_load: accountLoadSnapshot(), state: onboardingStateSnapshot() } });
      if (SIGNUP_EMAIL_VERIFICATION_ENABLED) goToPage(VERIFY_PAGE);
      else finish();
    });

    if (SIGNUP_AUTO_TOPUP_ENABLED && toggle) {
      toggle.addEventListener('click', () => {
        autoTopupEnabled = !autoTopupEnabled;
        syncAutoTopupUI();
        trackOnboarding('auto_topup_toggled', { metadata: { enabled: !!autoTopupEnabled, account_load: accountLoadSnapshot() } });
        saveState();
      });
    }

    const wireStep = (minusId, plusId, inputId, setter, opts = {}) => {
      const minusBtn = document.getElementById(minusId);
      const plusBtn = document.getElementById(plusId);
      const input = document.getElementById(inputId);
      if (!input) return;

      minusBtn?.addEventListener('click', () => {
        const current = parseInt(input.value, 10) || minTopupDollars;
        const next = Math.max(minTopupDollars, current - topupStep);
        input.value = next;
        if (opts.markManual) topupAmountManual = true;
        setter(next);
        trackOnboarding('auto_topup_setting_changed', { target: inputId, metadata: { method: 'minus', value: next, account_load: accountLoadSnapshot() } });
        setTopupMessage(next === minTopupDollars && current <= minTopupDollars ? 'Minimum auto top-up values are $50.' : '');
      });

      plusBtn?.addEventListener('click', () => {
        const next = (parseInt(input.value, 10) || minTopupDollars) + topupStep;
        input.value = next;
        if (opts.markManual) topupAmountManual = true;
        setter(next);
        trackOnboarding('auto_topup_setting_changed', { target: inputId, metadata: { method: 'plus', value: next, account_load: accountLoadSnapshot() } });
        setTopupMessage('');
      });

      input.addEventListener('input', () => {
        input.value = input.value.replace(/[^\d]/g, '').slice(0, 5);
        const raw = input.value.trim();
        if (!raw) {
          setTopupMessage('');
          return;
        }
        setTopupMessage((parseInt(raw, 10) || 0) < minTopupDollars ? 'Minimum auto top-up values are $50.' : '');
      });

      input.addEventListener('blur', () => {
        const raw = parseInt(input.value, 10) || minTopupDollars;
        const next = Math.max(minTopupDollars, raw);
        input.value = next;
        if (opts.markManual) topupAmountManual = true;
        setter(next);
        trackOnboarding('auto_topup_setting_changed', { target: inputId, metadata: { method: 'blur', value: next, raw_value: raw, account_load: accountLoadSnapshot() } });
        setTopupMessage(raw < minTopupDollars ? 'We updated that value to the $50 minimum.' : '');
      });
    };

    if (SIGNUP_AUTO_TOPUP_ENABLED) {
      wireStep('obThMinus', 'obThPlus', 'obThreshold', (value) => {
        topupThreshold = value;
        syncAutoSummary();
        saveState();
      });
      wireStep('obAmtMinus', 'obAmtPlus', 'obTopupAmt', (value) => {
        topupAmount = value;
        syncAutoSummary();
        saveState();
      }, { markManual: true });
    }

    document.getElementById('obNext2').addEventListener('click', async () => {
      const amount = selectedTier || parseInt(customAmount) || 0;
      if (amount < 1) return;
      const checkoutQuote = bonusQuoteForAmount(amount);
      trackOnboarding('checkout_attempt', {
        metadata: {
          amount,
          quote: checkoutQuote,
          account_load: accountLoadSnapshot(),
          state: onboardingStateSnapshot()
        }
      });
      const btn = document.getElementById('obNext2');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening checkout...';

      try {
        if (SIGNUP_AUTO_TOPUP_ENABLED) {
          await postAction('org_update_my_billing', {
            billing_json: JSON.stringify({
              auto_topup: {
                enabled: !!autoTopupEnabled,
                threshold_dollars: Math.max(50, topupThreshold),
                topup_dollars: Math.max(50, topupAmount),
              }
            })
          });
        }

        const quote = bonusQuoteForAmount(amount);
        const checkoutPayload = { qty: String(amount) };
        const offerToken = acquisitionBonusOfferToken();
        if (quote.valid && quote.bonus_dollars > 0 && offerToken) {
          checkoutPayload.offer_id = acquisitionBonusOffer.offer_id || 'acquisition_bonus_offer_v1';
          checkoutPayload.offer_token = offerToken;
          checkoutPayload.acquisition_bonus_token = offerToken;
          const testPayload = acquisitionBonusTestPayload();
          if (testPayload.cid) {
            checkoutPayload.cid = testPayload.cid;
            checkoutPayload.campaign = testPayload.campaign || testPayload.cid;
            checkoutPayload.campaign_code = testPayload.campaign_code || testPayload.cid;
            checkoutPayload.acquisition_code = testPayload.acquisition_code || testPayload.cid;
          }
          if (testPayload.xid) {
            checkoutPayload.xid = testPayload.xid;
            checkoutPayload.bonus_token = testPayload.bonus_token || testPayload.xid;
          }
        }
        try {
          console.log('[OnboardingBonusCheckout]', {
            amount,
            bonus_valid: !!quote.valid,
            bonus_dollars: quote.bonus_dollars || 0,
            offer_id: checkoutPayload.offer_id || '',
            has_offer_token: !!offerToken,
          });
        } catch(e){}
        const { data } = await postAction('stripe_create_checkout', checkoutPayload);
        if (data?.success && data.url) {
          trackOnboarding('checkout_redirect', {
            metadata: { amount, quote: checkoutQuote, has_offer_token: !!checkoutPayload.offer_token, account_load: accountLoadSnapshot() }
          });
          const checkoutSessionId = checkoutSessionIdFromResponse(data);
          saveState();
          saveStateForStripe('credit_purchase', { session_id: checkoutSessionId });
          rememberStripeCheckoutPending({
            session_id: checkoutSessionId,
            source: 'onboarding_credit_purchase',
            amount,
            offer_id: checkoutPayload.offer_id || '',
            offer_instance_id: checkoutPayload.offer_instance_id || ''
          });
          window.Portal?.stripeCheckout?.showOverlay?.('Taking you to secure checkout...');
          window.location.href = data.url;
          return;
        }
        trackOnboarding('checkout_error', { metadata: { amount, error: data?.error || 'unknown', account_load: accountLoadSnapshot() } });
        showToast((globalThis.PlatformLanguage?.text("onboarding","m_5932492ff03dc7","Checkout failed") ?? "Checkout failed"), data?.error || 'Please try again.', false);
      } catch(e){
        trackOnboarding('checkout_error', { metadata: { amount, error: 'request_failed', account_load: accountLoadSnapshot() } });
        showToast((globalThis.PlatformLanguage?.text("onboarding","m_77325c78a828d9","Error") ?? "Error"), (globalThis.PlatformLanguage?.text("onboarding","m_1d63b35618bdc9","Could not open checkout. Please try again.") ?? "Could not open checkout. Please try again."), false);
      }
      btn.disabled = false;
      btn.innerHTML = 'Checkout <i class="fas fa-arrow-right"></i>';
    });

    syncDefaultTopupAmount();
    updateCustomPreview2();
    syncAutoTopupUI();
    syncLoadDrivenAutoTopupVisibility();
  }

  function updateCustomPreview2(){
    const el = document.getElementById('obCustomPreview');
    if (!el) return;
    const amount = selectedTier || parseInt(customAmount) || 0;
    if (!selectedTier && customAmount && amount > 0) {
      el.style.display = '';
      el.innerHTML = customBonusPreviewHtml(amount);
    } else {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  function updateNext2State(){
    const btn = document.getElementById('obNext2');
    if (!btn) return;
    const amount = selectedTier || parseInt(customAmount) || 0;
    btn.disabled = amount < 1;
  }


/* ═══════════════════════════════════════════════════════════════
   *  BOOT
   * ═══════════════════════════════════════════════════════════════ */
  function renderPage3(){
    const page = document.getElementById('obPage3');
    if (!page) return;
    page.innerHTML = `
      <div class="ob-progress"></div>
      <div class="ob-step-label">${String(stepLabel(VERIFY_PAGE))}</div>
      <h2 class="ob-h2">${(globalThis.PlatformLanguage?.text("onboarding","m_f1aa26aee43e0e","Verify your email") ?? "Verify your email")}</h2>
      <p class="ob-sub">${(globalThis.PlatformLanguage?.text("onboarding","m_8342e19eddc030","We will send a code to this email before opening the portal. You can correct the address here if it was entered wrong.") ?? "We will send a code to this email before opening the portal. You can correct the address here if it was entered wrong.")}</p>

      <div class="ob-verification-card">
        <label class="ob-label" for="obVerifyEmail">${(globalThis.PlatformLanguage?.text("onboarding","m_2fbb4b11eb7b6f","Email address") ?? "Email address")}</label>
        <div class="ob-email-row">
          <input class="ob-input" id="obVerifyEmail" value="${String(esc(verificationEmail || ME_EMAIL))}" inputmode="email" autocomplete="email">
          <button class="ob-btn ghost" id="obSendOtp" type="button">
            ${String(verificationSent ? '<i class="fas fa-rotate"></i> Resend' : '<i class="fas fa-paper-plane"></i> Send code')}
          </button>
        </div>
        <label class="ob-label" for="obVerifyOtp">${(globalThis.PlatformLanguage?.text("onboarding","m_3a7c6bd31cf96e","Verification code") ?? "Verification code")}</label>
        <input class="ob-input ob-otp-input" id="obVerifyOtp" placeholder="000000" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
        <div class="ob-topup-msg" id="obVerifyMsg" aria-live="polite">${String(esc(verificationMessage))}</div>
      </div>

      <div class="ob-footer">
        <button class="ob-btn ghost" id="obBackVerify" type="button"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("onboarding","m_206d31a7c795c4"," Back") ?? " Back")}</button>
        <div class="ob-footer-right">
          <button class="ob-btn primary" id="obVerifyFinish" type="button">${(globalThis.PlatformLanguage?.text("onboarding","m_a455a4668ee54d","\n            Verify &amp; enter portal ") ?? "\n            Verify &amp; enter portal ")}<i class="fas fa-check"></i>
          </button>
        </div>
      </div>
    `;

    renderProgress();
    const emailInput = document.getElementById('obVerifyEmail');
    const otpInput = document.getElementById('obVerifyOtp');
    const sendBtn = document.getElementById('obSendOtp');
    const finishBtn = document.getElementById('obVerifyFinish');
    const msg = document.getElementById('obVerifyMsg');

    function setMessage(text, ok = true){
      verificationMessage = text || '';
      if (!msg) return;
      msg.textContent = verificationMessage;
      msg.style.color = ok ? 'rgba(0,0,0,.58)' : '#b42318';
    }

    emailInput?.addEventListener('input', () => {
      verificationEmail = emailInput.value.trim();
      verificationSent = false;
      saveState();
    });
    sendBtn?.addEventListener('click', () => sendVerificationCode(false));
    otpInput?.addEventListener('input', () => {
      otpInput.value = otpInput.value.replace(/[^\d]/g, '').slice(0, 6);
    });
    document.getElementById('obBackVerify')?.addEventListener('click', () => goToPage(previousVisiblePage(VERIFY_PAGE)));

    finishBtn?.addEventListener('click', async () => {
      const email = (emailInput?.value || '').trim();
      const otp = (otpInput?.value || '').trim();
      if (!email || !email.includes('@')) {
        setMessage('Enter a valid email address.', false);
        return;
      }
      if (!/^\d{6}$/.test(otp)) {
        setMessage('Enter the 6 digit code from your email.', false);
        return;
      }
      finishBtn.disabled = true;
      finishBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
      trackOnboarding('otp_verify_attempt', { metadata: { email_changed: email.toLowerCase() !== (ME_EMAIL || '').toLowerCase() } });
      try {
        const { data } = await postAction('onboarding_signup_verification_confirm', {
          email,
          otp,
          did_purchase: didPurchase ? '1' : '0',
          did_add_card: didAddCard ? '1' : '0',
        });
        if (data?.success) {
          verificationEmail = data.email || email;
          trackOnboarding('otp_verify_success');
          completeAfterVerification();
          return;
        }
        setMessage(data?.error || 'That code did not work. Try again or send a new code.', false);
        trackOnboarding('otp_verify_error', { metadata: { error: data?.error || 'unknown' } });
      } catch(e) {
        setMessage('Could not verify that code. Please try again.', false);
        trackOnboarding('otp_verify_error', { metadata: { error: 'request_failed' } });
      }
      finishBtn.disabled = false;
      finishBtn.innerHTML = 'Verify &amp; enter portal <i class="fas fa-check"></i>';
    });
  }

  async function sendVerificationCode(auto){
    if (verificationBusy) return;
    const emailInput = document.getElementById('obVerifyEmail');
    const sendBtn = document.getElementById('obSendOtp');
    const msg = document.getElementById('obVerifyMsg');
    const email = (emailInput?.value || verificationEmail || ME_EMAIL || '').trim();
    if (!email || !email.includes('@')) {
      verificationMessage = 'Enter a valid email address before sending the code.';
      if (msg) {
        msg.textContent = verificationMessage;
        msg.style.color = '#b42318';
      }
      return;
    }
    verificationBusy = true;
    verificationEmail = email;
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }
    trackOnboarding(auto ? 'otp_auto_send_attempt' : 'otp_send_attempt', { metadata: { email_changed: email.toLowerCase() !== (ME_EMAIL || '').toLowerCase() } });
    try {
      const { data } = await postAction('onboarding_signup_verification_start', { email });
      if (data?.success) {
        verificationSent = true;
        verificationMessage = `Code sent to ${data.email || email}.`;
        if (msg) {
          msg.textContent = verificationMessage;
          msg.style.color = 'rgba(0,0,0,.58)';
        }
        trackOnboarding('otp_send_success');
      } else {
        verificationSent = false;
        verificationMessage = data?.error || 'Could not send the code.';
        if (msg) {
          msg.textContent = verificationMessage;
          msg.style.color = '#b42318';
        }
        trackOnboarding('otp_send_error', { metadata: { error: data?.error || 'unknown' } });
      }
    } catch(e) {
      verificationSent = false;
      verificationMessage = 'Could not send the code.';
      if (msg) {
        msg.textContent = verificationMessage;
        msg.style.color = '#b42318';
      }
      trackOnboarding('otp_send_error', { metadata: { error: 'request_failed' } });
    }
    verificationBusy = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = verificationSent ? '<i class="fas fa-rotate"></i> Resend' : '<i class="fas fa-paper-plane"></i> Send code';
    }
    saveState();
  }

  function hasWizardState(){
    const s = readWizardState();
    return wizardStateIsRestorable(s) ? s : null;
  }

  function isOnboardingForceAllowed(){
    const host = (window.location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    const path = (window.location.pathname || '').toLowerCase();
    return host === 'app.1m8.ai'
      && (
        path === '/portal' || path.startsWith('/portal/')
        || path === '/portal_snapshot' || path.startsWith('/portal_snapshot/')
      );
  }

  function forceOnboardingForTesting(){
    if (!isOnboardingForceAllowed()) return false;
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('force_onboarding') === '1'
        || url.searchParams.get('forceOnboarding') === '1';
    } catch(e){}
    return false;
  }

  function shouldShowOnboarding(){
    if (blockStaleOnboardingOpen('should_show')) return false;
    if (signupOtpBypassRemembered()) return false;
    if (APP.showOnboarding) return true;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('onboarding') === '1') return true;
      // ?paid=1 should ONLY re-open the wizard if there is an existing
      // wizard session with a stripeSource — i.e. the wizard itself
      // initiated the Stripe redirect.  Without this guard, any non-wizard
      // payment return (e.g. billing page) that carries ?paid=1 would
      // accidentally launch the onboarding overlay.
      if (url.searchParams.get('paid') === '1') {
        const saved = hasWizardState();
        if (saved && saved.stripeSource) return true;
      }
    } catch(e){}
    // Show if there's a saved in-progress wizard state
    if (hasWizardState()) return true;
    return false;
  }

  async function boot(){
    if (blockStaleOnboardingOpen('boot')) return;
    if (!shouldShowOnboarding()) {
      document.getElementById('obPrecover')?.remove();
      return;
    }

    // ── Safety check: if the org already has projects, it's not a new
    //    signup — never show the wizard.  This guards against corrupted
    //    onboarding_completed flags or stale sessionStorage.
    if (!forceOnboardingForTesting()) {
      try {
        const { data } = await postAction('pj_search', { limit: 1 });
        const hits = data?.results ?? data?.projects ?? [];
        if (Array.isArray(hits) && hits.length > 0) {
          clearState();
          document.getElementById('obPrecover')?.remove();
          cleanOnboardingUrl();
          return;
        }
      } catch(e){
        // If the project check fails (network, unknown action, etc.) we
        // fall through and allow the wizard — fail-open is safer here
        // because the server's showOnboarding flag is the primary gate.
      }
    }

    await Promise.all([loadAcquisitionBonusOffer(), resolveOnboardingOrgName()]);

    try {
      const url    = new URL(window.location.href);
      const isPaid = url.searchParams.get('paid') === '1';
      const saved  = readWizardState();
      const stripeSource = saved?.stripeSource || null;

      if (isPaid && stripeSource) {
        // ── Returned from Stripe after successful payment ─────────────────
        // Restore all saved state first, then apply the paid-return overrides.
        restoreState();
        if (stripeSource === 'credit_purchase') {
          didPurchase = true;
          cardSavedViaCheckout = true;
          didAddCard = true;
        } else if (stripeSource === 'topup_setup') {
          didAddCard = true;
        }
        cleanOnboardingUrl();
        if (stripeSource === 'credit_purchase' && !SIGNUP_EMAIL_VERIFICATION_ENABLED) {
          await completeStripeCreditPurchaseOnboarding('stripe_return_url');
          return;
        }
        currentPage = SIGNUP_EMAIL_VERIFICATION_ENABLED ? VERIFY_PAGE : (visiblePages().slice(-1)[0] ?? 0);
        verificationSent = false;
        saveState();
        trackOnboarding('stripe_return', { metadata: { stripe_source: stripeSource, state: onboardingStateSnapshot() } });
        mount();
        return;
      } else if (stripeSource) {
        if (onboardingStripeReconciliationActive() || await waitForOnboardingStripeOutcome('onboarding_history_poll')) {
          document.getElementById('obPrecover')?.remove();
          return;
        }
        // ── Pressed Back from Stripe without completing payment ───────────
        // index.php <head> script redirected here via location.replace so
        // this load is already clean. Restore state as-is; the saved
        // currentPage is the step the user was on before redirecting.
        restoreState();
        saveState(); // re-save to clear stripeSource now that we're back
      } else {
        // ── Normal load or refresh mid-wizard ─────────────────────────────
        restoreState();
      }
    } catch(e){}

    mount();
  }

  window.addEventListener('fm:stripe:checkout-reconciled', (event) => {
    const saved = readWizardState();
    if (saved?.stripeSource !== 'credit_purchase') return;
    if (event?.detail?.reconciled) {
      completeStripeCreditPurchaseOnboarding(event?.detail?.reason || 'stripe_reconciled_event').catch(()=>null);
      return;
    }
    waitForOnboardingStripeOutcome('onboarding_history_poll_after_reconcile')
      .then((handled) => {
        if (handled) return;
        if (blockStaleOnboardingOpen('reconcile_event_fallback')) return;
        restoreState();
        saveState();
        mount();
      })
      .catch(()=>null);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 100));
  } else {
    setTimeout(boot, 100);
  }

  /* Expose for programmatic triggering */
  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.onboarding_wizard = {
    show: mount,
    isVisible: () => !!document.getElementById('obOverlay'),
    goToPage,
    currentPage: () => currentPage,
    pageIndexForName: (name) => ({ branding: 0, users: 1, account_load: 2 })[String(name)] ?? null,
    pageName,
  };
})();
