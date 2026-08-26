/* public/libraries/apps/billing/app.js
 * Factors in 'manage_billing' permission.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { $, injectCSS, postAction, hasPerm } = window.Portal.util;
  const { showToast } = window.Portal.ui;

  const ROOF_COST = Number(cfg.roofCost || 7);
  const EXPEDITE_FEE_PERCENT = 115;
  const INSTANT_ADDON_RESIDENTIAL = 2;
  const INSTANT_ADDON_COMMERCIAL = 4;
  const DEFAULT_CREDIT_AMOUNT = 250;
  const CREDIT_STEP = 10;
  const MIN_CREDIT_AMOUNT = 1;
  const MAX_CREDIT_AMOUNT = 700000;
  const AUTO_MIN_AMOUNT = 35;
  const AUTO_STEP = 10;
  const AUTO_DEFAULT_THRESHOLD = 50;
  const AUTO_DEFAULT_TOPUP = 100;
  const CREDIT_AMOUNT_HELP_TEXT = 'You can adjust the amount of credit added to your account using the plus and minus buttons.';
  const PENDING_ORDER_KEY = 'fm_pending_order_v1';
  const SUPPRESS_AUTO_SUBMIT_KEY = 'fm_billing_suppress_auto_submit_until';
  const STRIPE_CHECKOUT_PURCHASE_KEY = 'fm_stripe_checkout_purchase_v1';
  const STRIPE_CHECKOUT_PENDING_KEY = 'fm_stripe_checkout_pending_v1';
  const STRIPE_CHECKOUT_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
  const STRIPE_RECONCILE_MAX_WAIT_MS = 8000;
  const STRIPE_RECONCILE_POLL_MS = 1000;
  const STRIPE_CHECKOUT_OVERLAY_ID = 'fmStripeCheckoutOverlay';
  const STRIPE_CHECKOUT_OVERLAY_CSS = `
    .fm-stripe-checkout-overlay{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;padding:22px;background:rgba(15,23,42,.52);backdrop-filter:blur(4px)}
    .fm-stripe-checkout-overlay.active{display:flex}
    .fm-stripe-checkout-card{width:min(360px,calc(100vw - 44px));border-radius:18px;background:#fff;box-shadow:0 24px 80px rgba(15,23,42,.28);padding:24px;text-align:center;border:1px solid rgba(15,23,42,.1)}
    .fm-stripe-checkout-spinner{width:34px;height:34px;margin:0 auto 14px;border:3px solid #e5e7eb;border-top-color:#2f6fed;border-radius:999px;animation:fmStripeSpin .8s linear infinite}
    .fm-stripe-checkout-title{font-size:16px;font-weight:1000;color:#101828}
    .fm-stripe-checkout-message{margin-top:6px;font-size:13px;font-weight:750;line-height:1.4;color:#667085}
    @keyframes fmStripeSpin{to{transform:rotate(360deg)}}
  `;
  let inFlightAutoSubmit = false;
  let stripeReconcilePromise = null;
  let autoTopupState = null;
  let autoTopupBase = null;
  let autoTopupLoadSeq = 0;
  let billingModalHandle = null;
  let purchaseTopupContext = null;
  let firstReportAccountLoadEligible = false;
  let firstReportEligibilitySeq = 0;

  function wait(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function gutterReportAddon(){
    const amount = Number(cfg.gutterReportAddon ?? 2);
    return Number.isFinite(amount) ? amount : 2;
  }

  function weatherReportAddon(){
    const amount = Number(cfg.weatherReportAddon ?? 5);
    return Number.isFinite(amount) ? amount : 5;
  }

  function fmtMoney(value){
    if (window.Portal?.pricing?.formatMoney) return window.Portal.pricing.formatMoney(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const amount = Math.round(n * 100) / 100;
    return amount % 1 === 0 ? String(amount.toFixed(0)) : amount.toFixed(2);
  }

  function pendingPinCount(fields){
    try{
      const pins = JSON.parse(fields?.pins || '[]');
      return Array.isArray(pins) ? pins.length : 0;
    }catch(e){
      return 0;
    }
  }

  function firstMeasureFlagEnabled(flag, fallback = false){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.('firstmeasure', flag)) return true;
      const value = appFlags.value?.('firstmeasure', flag, undefined);
      return value === undefined ? fallback : value !== false;
    }
    return fallback;
  }

  function pendingIncludesGutters(fields){
    return firstMeasureFlagEnabled('gutter_reports', false)
      && String(fields?.project_type || 'residential').trim().toLowerCase() === 'residential'
      && (fields?.include_gutter_measurements === true
        || fields?.include_gutter_measurements === '1'
        || String(fields?.include_gutter_measurements || '').trim().toLowerCase() === 'true');
  }

  function pendingIncludesWeather(fields){
    return firstMeasureFlagEnabled('weather_reports', false)
      && (fields?.include_weather_report === true
        || fields?.include_weather_report === '1'
        || String(fields?.include_weather_report || '').trim().toLowerCase() === 'true');
  }

  function pendingReportMode(fields){
    const mode = String(fields?.report_mode || 'full').trim().toLowerCase();
    return mode === 'instant' || mode === 'both' ? 'both' : 'full';
  }

  function pendingReportModeLabel(fields){
    const mode = pendingReportMode(fields);
    if (mode === 'both') return 'Standard + Instant Preview';
    return 'Standard';
  }

  function normalizedStatusList(values){
    return values.flatMap((value) => String(value || '').split(/[,\s]+/))
      .map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_'))
      .filter(Boolean);
  }

  function isCancelledStatus(...values){
    return normalizedStatusList(values).some((status) => status === 'cancelled' || status === 'canceled');
  }

  function isRejectedStatus(...values){
    return normalizedStatusList(values).some((status) => status === 'rejected' || status === 'rejected_no_coverage');
  }

  function isReturnedReportStatus(...values){
    return normalizedStatusList(values).some((status) => (
      status === 'completed'
      || status === 'complete'
      || status === 'delivered'
      || status === 'returned'
      || status === 'report_returned'
      || status === 'report_delivered'
    ));
  }

  function isUnfinishedReportStatus(...values){
    return normalizedStatusList(values).some((status) => (
      status === 'new'
      || status === 'new_lead'
      || status === 'submitted'
      || status === 'queued'
      || status === 'processing'
      || status === 'in_progress'
      || status === 'awaiting_review'
      || status === 'awaiting_manager_review'
      || status === 'pending_rejection'
      || status === 'measurement_ordered'
    ));
  }

  function parseDeliveryHoldDate(value){
    const text = String(value || '').trim();
    if (!text) return null;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = Date.parse(hasExplicitZone ? isoish : `${isoish}Z`);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }

  function deliveryReleaseHoldIsActive(...sources){
    return sources.some((source) => {
      if (!source || typeof source !== 'object') return false;
      const raw = (source.raw && typeof source.raw === 'object') ? source.raw : {};
      const manifest = (source.manifest && typeof source.manifest === 'object')
        ? source.manifest
        : ((raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : source);
      const delivery = (manifest.delivery && typeof manifest.delivery === 'object') ? manifest.delivery : {};
      const hold = (manifest.delivery_release_hold && typeof manifest.delivery_release_hold === 'object')
        ? manifest.delivery_release_hold
        : ((delivery.release_hold && typeof delivery.release_hold === 'object') ? delivery.release_hold : {});
      const status = String(manifest.delivery_hold_status || hold.status || '').trim().toLowerCase();
      if (status !== 'holding') return false;
      const scheduled = parseDeliveryHoldDate(manifest.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '');
      return !!scheduled && scheduled.getTime() > Date.now();
    });
  }

  function projectText(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function projectHasDeliveredReport(project = {}){
    const p = project || {};
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (p.manifest && typeof p.manifest === 'object' && !Array.isArray(p.manifest))
      ? p.manifest
      : ((raw.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest)) ? raw.manifest : {});
    if (isCancelledStatus(p.status, p.workflow_state, measurement.status, raw.status, manifest.status)) return false;
    if (isRejectedStatus(p.status, measurement.status, raw.status, manifest.status)) return false;
    if (deliveryReleaseHoldIsActive(p, manifest, measurement, raw)) return false;

    const hasMeasurementSignal = [
      p.measurement_project_id,
      p.firstmeasure_project_id,
      p.firstmeasure_id,
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.id,
      raw.project_id,
      raw.folder,
      raw.measurement_project_id,
      manifest.project_id,
      manifest.folder,
      manifest.measurement_project_id
    ].some((value) => !!projectText(value));
    const hasDeliveredStatus = isReturnedReportStatus(measurement.status, raw.status, manifest.status)
      || (hasMeasurementSignal && isReturnedReportStatus(p.status, p.workflow_state));
    if (hasDeliveredStatus) return true;

    const hasUnfinishedStatus = isUnfinishedReportStatus(p.status, p.workflow_state, measurement.status, raw.status, manifest.status);
    const hasDeliveredAsset = [
      p.report_url,
      p.summary_url,
      p.xml_url,
      p.artifacts?.report_url,
      p.artifacts?.summary_url,
      p.assets?.report_url,
      p.assets?.summary_url,
      measurement.report_url,
      measurement.pdf_url,
      measurement.summary_url,
      measurement.xml_url,
      raw.report_url,
      raw.pdf_url,
      raw.summary_url,
      raw.xml_url,
      manifest.report_url,
      manifest.pdf_url,
      manifest.summary_url,
      manifest.xml_url
    ].some((value) => !!projectText(value));
    return hasMeasurementSignal && hasDeliveredAsset && !hasUnfinishedStatus;
  }

  async function hasDeliveredReportInOrg(){
    try {
      for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
        const { data } = await postAction('list_projects', {
          filter: 'org',
          status_filter: 'all',
          include_instant_only: '1',
          hide_drafts: '0',
          view: 'card',
          limit: '100',
          page: String(page)
        });
        const projects = Array.isArray(data?.projects) ? data.projects : [];
        if (projects.some(projectHasDeliveredReport)) return true;
        totalPages = Number(data?.pagination?.total_pages || 1) || 1;
        if (page >= totalPages || projects.length < 100) break;
      }
    } catch (error) {
      console.warn('First report top-up eligibility check failed:', error);
    }
    return false;
  }

  function pendingInstantAddon(fields){
    const projectType = String(fields?.project_type || 'residential').trim().toLowerCase() || 'residential';
    if (window.Portal?.pricing?.instantReportAddon) return window.Portal.pricing.instantReportAddon(projectType);
    return projectType === 'commercial' || projectType === 'multifamily' ? INSTANT_ADDON_COMMERCIAL : INSTANT_ADDON_RESIDENTIAL;
  }

  function pendingReportExpediteOption(fields){
    const rawKey = String(fields?.report_expedite_option || '').trim().toLowerCase();
    const key = rawKey === 'rush_1_2' || rawKey === 'rush_1_1_5'
      ? 'rush_under_1'
      : (rawKey === 'rush_2_3' ? 'rush_1_3' : rawKey);
    const quotedUnit = Number(fields?.report_expedite_unit_price);
    const quotedDelta = Number(fields?.report_expedite_rush_delta);
    if (key && Number.isFinite(quotedUnit) && quotedUnit > 0) {
      return {
        key,
        residentialPrice: Math.round(quotedUnit * 100) / 100,
        rushDelta: Number.isFinite(quotedDelta) ? Math.max(0, Math.round(quotedDelta * 100) / 100) : Math.max(0, Math.round((quotedUnit - ROOF_COST) * 100) / 100)
      };
    }
    const wait = Number(fields?.report_estimated_wait_minutes);
    const normalizedWait = Number.isFinite(wait) ? Math.max(240, Math.min(420, wait)) : 240;
    const ratio = (normalizedWait - 240) / 180;
    const previousRush23 = Math.round((8 + ratio * 2) * 10) / 10;
    const previousRushDelta = previousRush23 - ROOF_COST;
    const increaseFee = (fee) => Math.round(Math.round(fee * 100) * EXPEDITE_FEE_PERCENT / 100) / 100;
    const rush23 = Math.round((ROOF_COST + increaseFee(previousRushDelta)) * 100) / 100;
    const rush12 = Math.round((ROOF_COST + increaseFee(previousRushDelta * 3)) * 100) / 100;
    if (key === 'rush_under_1') return { key, residentialPrice: rush12, rushDelta: Math.max(0, Math.round((rush12 - ROOF_COST) * 100) / 100) };
    if (key === 'rush_1_3') return { key, residentialPrice: rush23, rushDelta: Math.max(0, Math.round((rush23 - ROOF_COST) * 100) / 100) };
    if (key === 'standard_3_6' || key === 'rush_3_4' || key === 'no_rush') return { key, residentialPrice: ROOF_COST, rushDelta: 0 };
    return null;
  }

  function pendingUnitPrice(fields){
    const projectType = String(fields?.project_type || 'residential').trim().toLowerCase() || 'residential';
    const reportMode = pendingReportMode(fields);
    const expedite = pendingReportExpediteOption(fields);
    const standardBase = projectType === 'commercial' || projectType === 'multifamily' ? 12 : ROOF_COST;
    const base = expedite
      ? (projectType === 'commercial' || projectType === 'multifamily' ? standardBase + expedite.rushDelta : expedite.residentialPrice)
      : standardBase;
    if (reportMode === 'both') {
      return base + pendingInstantAddon(fields);
    }
    return base;
  }

  function pendingOrderAmount(fields){
    return pendingOrderQuote(fields).final_amount;
  }

  function pendingOriginalOrderAmount(fields){
    const projectType = String(fields?.project_type || 'residential').trim().toLowerCase() || 'residential';
    const base = pendingUnitPrice(fields);
    const gross = projectType === 'commercial' || projectType === 'multifamily'
      ? base * Math.max(1, pendingPinCount(fields))
      : base + (pendingIncludesGutters(fields) ? gutterReportAddon() : 0);
    const withWeather = gross + (pendingIncludesWeather(fields) ? weatherReportAddon() : 0);
    const couponDiscount = Number(fields?.report_expedite_coupon_discount);
    const computed = Math.max(0.01, Math.round((withWeather - (Number.isFinite(couponDiscount) ? Math.max(0, couponDiscount) : 0)) * 100) / 100);
    const quotedNet = Number(fields?.report_expedite_net_total_price);
    if (Number.isFinite(quotedNet) && quotedNet > 0) {
      return Math.max(computed, Math.round(quotedNet * 100) / 100);
    }
    return computed;
  }

  function pendingDiscountableBase(fields){
    const mode = pendingReportMode(fields);
    if (mode === 'both') {
      return pendingOriginalOrderAmount(fields);
    }
    return window.Portal?.pricing?.standardBaseAmountForOrder?.(
      String(fields?.project_type || 'residential').trim().toLowerCase() || 'residential',
      pendingPinCount(fields),
      mode
    ) || 0;
  }

  function pendingOrderQuote(fields){
    const original = pendingOriginalOrderAmount(fields);
    return window.Portal?.pricing?.referralDiscountPreview?.(original, pendingDiscountableBase(fields)) || {
      active: false,
      original_amount: original,
      final_amount: original,
      discount_amount: 0,
      discountable_amount: 0,
      discount_percent: 0,
    };
  }

  const css = `
    /* ... (CSS same as previous version) ... */
    .b-overlay{position:fixed; inset:0; z-index:2147483400; background:rgba(0,0,0,0.60); backdrop-filter:blur(3px); display:none; align-items:center; justify-content:center; opacity:0; transition:opacity .16s ease}
    .b-overlay.active{display:flex; opacity:1}
    .b-win{width:min(560px, 94vw); background:#fff; border-radius:18px; box-shadow:0 30px 90px rgba(0,0,0,0.50); overflow:hidden; animation:bUp .18s ease-out; display:flex; flex-direction:column; max-height:92vh}
    @keyframes bUp{from{transform:translateY(16px); opacity:0}to{transform:translateY(0); opacity:1}}
    .b-top{padding:16px 16px 12px; border-bottom:1px solid rgba(0,0,0,0.10); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-shrink:0}
    .b-title{margin:0; font-size:16px; font-weight:1000; letter-spacing:-0.2px}
    .b-subtitle{margin:4px 0 0; font-size:12px; font-weight:850; color:#666; line-height:1.35}
    .buy-close{width:38px; height:38px; border-radius:12px; border:1px solid #eee; background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:.18s ease}
    .buy-close:hover{border-color:#ddd; transform:translateY(-1px)}
    .b-body{padding:14px 16px; overflow:auto}
    .b-row{display:flex; gap:10px; align-items:flex-end}
    .b-group{flex:1; min-width:0}
    .b-group label{display:block; font-size:11px; font-weight:1000; color:#777; letter-spacing:.4px; text-transform:uppercase; margin-bottom:6px}
    .b-inp{width:100%; box-sizing:border-box; padding:8px 10px; height:36px; border-radius:11px; border:1px solid rgba(0,0,0,0.16); outline:none; font-weight:900; transition:.16s ease}
    .b-inp:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.75); box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),0.12)}
    .b-credit-grid{margin-top:12px; display:grid; grid-template-columns:minmax(0,1fr) minmax(150px,.75fr); gap:10px; align-items:stretch}
    .b-credit-panel{border:1px solid #eee; border-radius:14px; padding:10px; background:#fff; min-width:0}
    .b-amountrow{display:grid; grid-template-columns:32px minmax(0,1fr) 32px; align-items:end; gap:7px; min-width:0}
    .b-amountrow .b-group{min-width:0}
    .b-nudge{width:32px; height:36px; border-radius:11px; border:1px solid #eee; background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:.18s ease; font-weight:1000; padding:0; box-sizing:border-box}
    .b-nudge:hover{border-color:#ddd; transform:translateY(-1px)}
    .b-hint{margin-top:10px; font-size:13px; color:#666; font-weight:850; line-height:1.35}
    .b-price{height:100%; display:flex; flex-direction:column; justify-content:center; gap:8px; background:#fafafa}
    .b-price-label{font-weight:950; color:#555; font-size:11px; letter-spacing:.4px; text-transform:uppercase}
    .b-price .big{font-weight:1000; font-size:22px; letter-spacing:-.2px}
    .b-price .big.is-insufficient{color:#d93025}
    .b-err{margin-top:10px; min-height:16px; font-size:12px; font-weight:1000; color:#d93025}
    .b-msg{margin-top:8px; font-size:12px; color:#777; font-weight:850}
    .b-msg:empty{display:none}
    .b-actions{padding:14px 16px 16px; border-top:1px solid rgba(0,0,0,0.10); display:flex; gap:10px; flex-shrink:0}
    .b-btn{flex:1; padding:12px 12px; border-radius:14px; border:1px solid rgba(0,0,0,0.12); background:#fff; font-weight:1000; cursor:pointer; transition:.16s ease}

    .b-btn.primary{background:var(--primary,#d93025); border-color:var(--primary,#d93025); color:var(--on-primary,#fff)}
    .b-btn.primary:hover{background:var(--primary-dark,#b0261e); border-color:var(--primary-dark,#b0261e)}

    .b-btn:disabled{opacity:.55; cursor:not-allowed}
    .b-auto{margin-top:12px; border:1px solid rgba(0,0,0,0.09); border-radius:16px; background:#fff; padding:10px; box-shadow:0 10px 25px rgba(0,0,0,0.04)}
    .b-auto-top{display:flex; align-items:center; justify-content:space-between; gap:12px}
    .b-auto-title{font-size:13px; font-weight:1000; color:#111; letter-spacing:0; display:flex; align-items:center; gap:7px}
    .b-auto-note{margin-top:4px; color:#666; font-size:12px; font-weight:850; line-height:1.35}
    .b-auto-note:empty{display:none}
    .b-auto-switch{min-width:104px; height:36px; border-radius:999px; border:1px solid rgba(0,0,0,0.12); background:#f5f5f5; cursor:pointer; font-weight:1000; display:inline-flex; align-items:center; justify-content:center; gap:7px; transition:.16s ease}
    .b-auto-switch .dot{width:10px; height:10px; border-radius:50%; background:#999}
    .b-auto-switch.on{background:rgba(30,126,52,0.10); border-color:rgba(30,126,52,0.28); color:#1e7e34}
    .b-auto-switch.on .dot{background:#1e7e34}
    .b-auto-grid{margin-top:10px; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px}
    .b-auto-field{min-width:0}
    .b-auto-field label{display:block; font-size:10px; font-weight:1000; color:#777; letter-spacing:.35px; text-transform:uppercase; margin-bottom:6px}
    .b-auto-moneyrow{display:grid; grid-template-columns:28px minmax(0,1fr) 28px; gap:5px; align-items:center; min-width:0}
    .b-auto-step{width:28px; height:34px; border-radius:10px; border:1px solid #eee; background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding:0; box-sizing:border-box}
    .b-auto-step:disabled{opacity:.45; cursor:not-allowed}
    .b-auto-money{min-width:0; width:100%; box-sizing:border-box; height:34px; border-radius:10px; border:1px solid rgba(0,0,0,0.14); padding:6px 8px; font-weight:1000; outline:none}
    .b-auto-money:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.70); box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),0.10)}
    .b-auto-summary{margin-top:10px; padding:10px; border-radius:12px; background:#fafafa; color:#555; font-size:12px; font-weight:850; line-height:1.35; display:none}
    .b-auto-status{margin-top:8px; min-height:15px; color:#777; font-size:12px; font-weight:850}
    .b-auto-disabled .b-auto-grid{opacity:.58}
    .b-hint:empty{display:none}
    .b-insufficient-message{display:none; margin-top:8px; color:#d93025; font-size:12px; font-weight:1000; line-height:1.35}
    @media (max-width:560px){
      .b-auto-top{align-items:flex-start; flex-direction:column}
      .b-auto-switch{width:100%}
      .b-auto-grid{grid-template-columns:1fr}
      .b-credit-grid{grid-template-columns:1fr}
    }
    @media (max-width:480px){
      .b-body{padding:12px}
      .b-auto-grid{grid-template-columns:1fr}
      .b-credit-panel{padding:9px}
    }
    .b-pending{margin-bottom:12px; border:1px solid rgba(0,0,0,0.08); border-radius:16px; padding:12px; background:#fff; box-shadow:0 10px 25px rgba(0,0,0,0.05); display:none}
    .b-pk{font-size:11px; font-weight:1000; color:#777; letter-spacing:.4px; text-transform:uppercase}
    .b-pa{margin-top:6px; font-weight:1000; font-size:13px; color:#111}
    .b-ps{margin-top:6px; font-weight:850; font-size:12px; color:#666; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .b-prow{margin-top:10px; display:flex; gap:10px}
    .b-plink{flex:1; padding:10px 10px; border-radius:14px; border:1px solid rgba(0,0,0,0.10); background:#fff; cursor:pointer; font-weight:1000; transition:.16s ease}
    .b-plink:hover{transform:translateY(-1px); border-color:rgba(var(--primary-rgb,217,48,37),0.45); color:var(--primary-readable,var(--primary,#d93025))}
    .b-first-report{display:none; margin-bottom:12px; border:1px solid rgba(22,101,52,0.18); border-radius:16px; padding:14px; background:linear-gradient(135deg, #f0fdf4 0%, #eff6ff 100%); box-shadow:0 12px 28px rgba(15,23,42,0.06)}
    .b-first-kicker{display:inline-flex; align-items:center; gap:7px; padding:5px 8px; border-radius:999px; background:rgba(255,255,255,0.78); color:#166534; font-size:11px; font-weight:1000; letter-spacing:.35px; text-transform:uppercase}
    .b-first-title{margin:10px 0 4px; color:#101828; font-size:18px; font-weight:1000; letter-spacing:0}
    .b-first-copy{margin:0; color:#475467; font-size:13px; font-weight:850; line-height:1.4}
    .b-first-address{margin-top:12px; padding:10px 11px; border-radius:12px; background:rgba(255,255,255,0.74); color:#101828; font-size:13px; font-weight:1000; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .b-first-numbers{margin-top:12px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px}
    .b-first-number{border-radius:12px; background:rgba(255,255,255,0.72); padding:9px}
    .b-first-number span{display:block; color:#667085; font-size:10px; font-weight:1000; letter-spacing:.3px; text-transform:uppercase}
    .b-first-number strong{display:block; margin-top:4px; color:#101828; font-size:16px; font-weight:1000}
    .b-first-number.due{background:#fff; box-shadow:0 8px 18px rgba(22,101,52,0.10)}
    .b-first-number.due strong{color:#166534; font-size:20px}
    .first-report-checkout .b-credit-grid{margin-top:8px; opacity:.84}
    .first-report-checkout .b-credit-panel{background:#fff}
    .first-report-checkout .b-price-label::after{content:" for checkout"; text-transform:none; letter-spacing:0; color:#777; font-weight:850}
    .first-report-checkout .b-auto{opacity:.72; box-shadow:none; background:#fafafa}
    .first-report-checkout .b-auto-title{font-size:12px; color:#555}
    .report-credit-gate .b-top{justify-content:space-between}
    .report-credit-gate .b-top > div{display:block}
    .report-credit-gate .b-subtitle{display:none}
    .report-credit-gate .b-first-title{display:none}
    @media (max-width:480px){
      .b-first-numbers{grid-template-columns:1fr}
      .b-first-address{white-space:normal}
    }
  `;

  function readPending(){
    try{ const raw = localStorage.getItem(PENDING_ORDER_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  }
  function clearPending(){ try{ localStorage.removeItem(PENDING_ORDER_KEY); }catch(e){} }
  function hasPendingOrder(){
    const pending = readPending();
    return !!pending?.fields?.address;
  }
  function queryParamChoice(names, allowed){
    try {
      const params = new URLSearchParams(window.location.search || '');
      for (const name of names) {
        if (!params.has(name)) continue;
        const value = String(params.get(name) || '').trim().toLowerCase();
        if (allowed.includes(value)) return value;
      }
    } catch(e){}
    return '';
  }
  function reportCreditViewOverride(){
    const value = queryParamChoice(['fm_report_credit_view', 'fm_credit_gate_view'], ['initial', 'first', 'first_report', 'normal', 'existing']);
    if (value === 'first' || value === 'first_report') return 'initial';
    if (value === 'existing') return 'normal';
    return value;
  }
  function suppressAutoSubmitForPurchase(){
    try{ localStorage.setItem(SUPPRESS_AUTO_SUBMIT_KEY, String(Date.now() + 10 * 60 * 1000)); }catch(e){}
  }
  function clearAutoSubmitSuppression(){
    try{ localStorage.removeItem(SUPPRESS_AUTO_SUBMIT_KEY); }catch(e){}
  }
  function autoSubmitSuppressed(){
    try{
      const until = Number(localStorage.getItem(SUPPRESS_AUTO_SUBMIT_KEY) || 0);
      if (!Number.isFinite(until) || until <= 0) return false;
      if (Date.now() <= until) return true;
      localStorage.removeItem(SUPPRESS_AUTO_SUBMIT_KEY);
      return false;
    }catch(e){
      return false;
    }
  }

  function ensureUI(){
    if (document.getElementById('bOverlay')) return;
    injectCSS('billing', css);

    const el = document.createElement('div');
    el.className = 'b-overlay';
    el.id = 'bOverlay';
    el.innerHTML = `
      <div class="b-win">
        <div class="b-top">
          <div>
            <h3 class="b-title" id="bTitle">Add Credit</h3>
            <div class="b-subtitle" id="bSubtitle"></div>
          </div>
          <button class="buy-close" id="bCloseX" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="b-body">
          <div class="b-first-report" id="bFirstReportCard">
            <div class="b-first-kicker"><i class="fas fa-gift"></i> First report checkout</div>
            <h4 class="b-first-title">Thanks for trying FirstMeasure.</h4>
            <p class="b-first-copy">Add credit to your account to pay for this report.</p>
            <div class="b-first-address" id="bFirstAddress">Your first roof report</div>
            <div class="b-first-numbers">
              <div class="b-first-number"><span>Needed for order</span><strong id="bFirstReportTotal">$0</strong></div>
              <div class="b-first-number"><span>Your balance</span><strong id="bFirstBalance">$0</strong></div>
              <div class="b-first-number due"><span>Difference</span><strong id="bFirstDue">$0</strong></div>
            </div>
            <div class="b-msg" id="bFirstAutoSubmit" style="margin-top:10px;"></div>
          </div>
          <div class="b-pending" id="bPendingCard">
            <div class="b-pk">Pending order</div>
            <div class="b-pa" id="bPendingAddr">—</div>
            <div class="b-ps" id="bPendingSub">—</div>
            <div class="b-prow">
              <button class="b-plink" id="bEditOrder"><i class="fas fa-pen"></i> Edit order</button>
              <button class="b-plink" id="bDiscard"><i class="fas fa-trash"></i> Discard</button>
            </div>
            <div class="b-msg" style="margin-top:10px;">After payment goes through, this report order will submit automatically. You do not need to place it again.</div>
          </div>
          <div class="b-credit-grid" id="bCreditGrid">
            <div class="b-credit-panel">
              <div class="b-amountrow">
                <button class="b-nudge" id="bMinus" data-fm-tooltip="Decrease"><i class="fas fa-minus"></i></button>
                <div class="b-group">
                  <label id="bCreditLabel">Credit To Add</label>
                  <input class="b-inp" id="bQty" type="number" min="${MIN_CREDIT_AMOUNT}" max="${MAX_CREDIT_AMOUNT}" value="${DEFAULT_CREDIT_AMOUNT}">
                </div>
                <button class="b-nudge" id="bPlus" data-fm-tooltip="Increase"><i class="fas fa-plus"></i></button>
              </div>
            </div>
            <div class="b-credit-panel b-price">
              <div class="b-price-label">Total</div>
              <div class="big" id="bTotal">$${DEFAULT_CREDIT_AMOUNT}</div>
            </div>
          </div>
          <div class="b-hint" id="bHint">${CREDIT_AMOUNT_HELP_TEXT}</div>
          <div class="b-insufficient-message" id="bInsufficientMessage"></div>
          <div class="b-auto" id="bAutoTopupCard">
            <div class="b-auto-top">
              <div>
                <div class="b-auto-title"><i class="fas fa-bolt"></i> Automatically top up your account next time?</div>
                <div class="b-auto-note" id="bAutoNote">Loading auto top-up settings...</div>
              </div>
              <button class="b-auto-switch" id="bAutoToggle" type="button" disabled>
                <span class="dot"></span>
                <span id="bAutoToggleText">Loading</span>
              </button>
            </div>
            <div class="b-auto-grid">
              <div class="b-auto-field">
                <label>Top up when below</label>
                <div class="b-auto-moneyrow">
                  <button class="b-auto-step" id="bAutoThMinus" type="button" disabled><i class="fas fa-minus"></i></button>
                  <input class="b-auto-money" id="bAutoThreshold" inputmode="numeric" disabled>
                  <button class="b-auto-step" id="bAutoThPlus" type="button" disabled><i class="fas fa-plus"></i></button>
                </div>
              </div>
              <div class="b-auto-field">
                <label>Auto top-up amount</label>
                <div class="b-auto-moneyrow">
                  <button class="b-auto-step" id="bAutoAmtMinus" type="button" disabled><i class="fas fa-minus"></i></button>
                  <input class="b-auto-money" id="bAutoTopup" inputmode="numeric" disabled>
                  <button class="b-auto-step" id="bAutoAmtPlus" type="button" disabled><i class="fas fa-plus"></i></button>
                </div>
              </div>
            </div>
            <div class="b-auto-summary" id="bAutoSummary"></div>
            <div class="b-auto-status" id="bAutoStatus"></div>
          </div>
          <div class="b-err" id="bErr"></div>
        </div>
        <div class="b-actions">
          <button class="b-btn" id="bCancel">Cancel</button>
          <button class="b-btn primary" id="bGo">Go to Checkout</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const pendingHint = el.querySelector('#bPendingCard .b-msg');
    if (pendingHint) pendingHint.textContent = 'After payment goes through, this report order will submit automatically. You do not need to place it again.';

    $('#bCloseX').addEventListener('click', close);
    $('#bCancel').addEventListener('click', close);

    el.addEventListener('mousedown', (e)=>{ el.__downBackdrop = (e.target === el); });
    el.addEventListener('mouseup', (e)=>{ if (el.__downBackdrop && e.target === el) close(); el.__downBackdrop = false; });

    $('#bPlus').addEventListener('click', (e)=>{ e.preventDefault(); nudge(CREDIT_STEP); });
    $('#bMinus').addEventListener('click', (e)=>{ e.preventDefault(); nudge(-CREDIT_STEP); });
    $('#bQty').addEventListener('input', updateTotal);

    $('#bQty').addEventListener('blur', normalizeAmountInput);
    $('#bGo').addEventListener('click', startCheckout);
    wireAutoTopupControls();

    $('#bEditOrder').addEventListener('click', ()=>{
      close();
      window.Portal.modules.request?.open?.();
    });
    $('#bDiscard').addEventListener('click', ()=>{
      clearPending();
      renderPendingSafe();
      renderFundingContext();
      showToast('Order discarded', 'No pending order will be submitted.', false);
    });
  }

  function clampInt(v, mn, mx, def){
    let n = parseInt(String(v || ''), 10);
    if (isNaN(n)) n = def;
    return Math.max(mn, Math.min(mx, n));
  }
  function hasOwn(obj, key){
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }
  function safeMoney(value, fallback = AUTO_MIN_AMOUNT){
    const raw = String(value ?? '').replace(/[^\d]/g, '');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(AUTO_MIN_AMOUNT, n) : fallback;
  }
  function moneyFromSetting(obj, key, fallback){
    if (!hasOwn(obj, key)) return fallback;
    const n = parseInt(String(obj?.[key] ?? ''), 10);
    return Number.isFinite(n) ? Math.max(AUTO_MIN_AMOUNT, n) : fallback;
  }
  function normalizeAutoTopupOrg(org){
    const billing = (org?.billing && typeof org.billing === 'object') ? org.billing : {};
    const auto = (billing.auto_topup && typeof billing.auto_topup === 'object') ? billing.auto_topup : {};
    const stripe = (billing.stripe && typeof billing.stripe === 'object') ? billing.stripe : {};
    const enabled = auto.enabled === true;
    return {
      loaded: true,
      loading: false,
      error: '',
      orgId: org?.id || null,
      enabled,
      threshold_dollars: enabled ? moneyFromSetting(auto, 'threshold_dollars', AUTO_DEFAULT_THRESHOLD) : AUTO_DEFAULT_THRESHOLD,
      topup_dollars: enabled ? moneyFromSetting(auto, 'topup_dollars', AUTO_DEFAULT_TOPUP) : AUTO_DEFAULT_TOPUP,
      stripe: {
        has_payment_method: !!stripe.has_payment_method,
        brand: stripe.brand || '',
        last4: stripe.last4 || '',
        exp_month: stripe.exp_month || '',
        exp_year: stripe.exp_year || '',
      }
    };
  }
  function currentAutoValues(){
    return {
      enabled: !!autoTopupState?.enabled,
      threshold_dollars: safeMoney($('#bAutoThreshold')?.value, autoTopupState?.threshold_dollars || AUTO_DEFAULT_THRESHOLD),
      topup_dollars: safeMoney($('#bAutoTopup')?.value, autoTopupState?.topup_dollars || AUTO_DEFAULT_TOPUP),
    };
  }
  function setAutoBaseFromState(){
    autoTopupBase = autoTopupState ? {
      orgId: autoTopupState.orgId,
      enabled: !!autoTopupState.enabled,
      threshold_dollars: safeMoney(autoTopupState.threshold_dollars, AUTO_DEFAULT_THRESHOLD),
      topup_dollars: safeMoney(autoTopupState.topup_dollars, AUTO_DEFAULT_TOPUP),
    } : null;
  }
  function autoTopupDirty(){
    if (!autoTopupBase || !autoTopupState?.loaded) return false;
    const v = currentAutoValues();
    return !!v.enabled !== !!autoTopupBase.enabled
      || v.threshold_dollars !== autoTopupBase.threshold_dollars
      || v.topup_dollars !== autoTopupBase.topup_dollars;
  }
  function autoTopupAvailableInCurrentFlow(){
    if (reportCreditGateActive()) return !reportCreditGateInitial();
    return !firstReportTopupActive();
  }
  function renderAutoTopup(){
    const card = $('#bAutoTopupCard');
    if (!card) return;
    const available = autoTopupAvailableInCurrentFlow();
    card.style.display = available ? '' : 'none';
    if (!available) return;
    const toggle = $('#bAutoToggle');
    const toggleText = $('#bAutoToggleText');
    const note = $('#bAutoNote');
    const th = $('#bAutoThreshold');
    const amt = $('#bAutoTopup');
    const summary = $('#bAutoSummary');
    const status = $('#bAutoStatus');
    const controls = ['#bAutoThMinus','#bAutoThPlus','#bAutoAmtMinus','#bAutoAmtPlus'].map(id => $(id));
    const isLoaded = !!autoTopupState?.loaded && !autoTopupState?.error;
    const enabled = !!autoTopupState?.enabled;
    const thVal = safeMoney(autoTopupState?.threshold_dollars, AUTO_DEFAULT_THRESHOLD);
    const amtVal = safeMoney(autoTopupState?.topup_dollars, AUTO_DEFAULT_TOPUP);

    card.classList.toggle('b-auto-disabled', !enabled);
    if (toggle) {
      toggle.disabled = !isLoaded;
      toggle.classList.toggle('on', enabled);
    }
    if (toggleText) toggleText.textContent = autoTopupState?.loading ? 'Loading' : (enabled ? 'Yes' : 'No');
    if (note) {
      if (autoTopupState?.loading) note.textContent = 'Loading auto top-up settings...';
      else if (autoTopupState?.error) note.textContent = autoTopupState.error;
      else note.textContent = '';
    }
    if (th) {
      if (document.activeElement !== th) th.value = String(thVal);
      th.disabled = !isLoaded || !enabled;
    }
    if (amt) {
      if (document.activeElement !== amt) amt.value = String(amtVal);
      amt.disabled = !isLoaded || !enabled;
    }
    controls.forEach(btn => {
      if (!btn) return;
      btn.disabled = !isLoaded || !enabled;
    });
    const thMinus = $('#bAutoThMinus');
    const amtMinus = $('#bAutoAmtMinus');
    if (thMinus) thMinus.disabled = !isLoaded || !enabled || thVal <= AUTO_MIN_AMOUNT;
    if (amtMinus) amtMinus.disabled = !isLoaded || !enabled || amtVal <= AUTO_MIN_AMOUNT;
    if (summary) summary.textContent = '';
    if (status && !autoTopupState?.loading && !autoTopupState?.error) status.textContent = '';
  }
  async function loadAutoTopupSettings(){
    const seq = ++autoTopupLoadSeq;
    autoTopupState = {
      loaded: false,
      loading: true,
      error: '',
      enabled: false,
      threshold_dollars: AUTO_DEFAULT_THRESHOLD,
      topup_dollars: AUTO_DEFAULT_TOPUP,
      stripe: { has_payment_method:false }
    };
    renderAutoTopup();
    try{
      const orgId = String(window.__APP?.userOrgId || '').trim();
      let data = null;
      if (orgId && window.PlatformAPI?.orgs?.portalState) {
        const state = await window.PlatformAPI.orgs.portalState(orgId);
        data = {
          success: true,
          org: {
            id: state?.organization?.id || orgId,
            billing: state?.billing || state?.global?.data?.billing || {}
          }
        };
      } else {
        const legacy = await postAction('org_get_my');
        data = legacy?.data || null;
      }
      if (seq !== autoTopupLoadSeq) return;
      if (!data || !data.success || !data.org) throw new Error(data?.error || 'Could not load auto top-up settings.');
      autoTopupState = normalizeAutoTopupOrg(data.org);
      setAutoBaseFromState();
    }catch(e){
      if (seq !== autoTopupLoadSeq) return;
      autoTopupState = {
        loaded: false,
        loading: false,
        error: 'Could not load auto top-up settings.',
        enabled: false,
        threshold_dollars: AUTO_DEFAULT_THRESHOLD,
        topup_dollars: AUTO_DEFAULT_TOPUP,
        stripe: { has_payment_method:false }
      };
      autoTopupBase = null;
    }
    renderAutoTopup();
  }
  async function saveAutoTopupSettings(){
    if (!autoTopupState?.loaded) return false;
    const status = $('#bAutoStatus');
    const v = currentAutoValues();
    autoTopupState.enabled = v.enabled;
    autoTopupState.threshold_dollars = v.threshold_dollars;
    autoTopupState.topup_dollars = v.topup_dollars;
    if (status) status.textContent = 'Saving auto top-up settings...';
    try{
      const { data } = await postAction('org_update_my_billing', {
        billing_json: JSON.stringify({
          auto_topup: {
            enabled: !!v.enabled,
            threshold_dollars: v.threshold_dollars,
            topup_dollars: v.topup_dollars
          }
        })
      });
      if (!data || !data.success) {
        showToast('Save failed', data?.error || 'Could not save auto top-up settings.', false);
        if (status) status.textContent = '';
        return false;
      }
      setAutoBaseFromState();
      if (status) status.textContent = '';
      renderAutoTopup();
      return true;
    }catch(e){
      showToast('Save failed', 'Connection error.', false);
      if (status) status.textContent = '';
      return false;
    }finally{
      renderAutoTopup();
    }
  }
  function syncAutoMoneyInput(inputEl, path){
    if (!inputEl || !autoTopupState) return;
    inputEl.value = String(inputEl.value || '').replace(/[^\d]/g,'').slice(0, 6);
    const v = safeMoney(inputEl.value, path === 'threshold' ? AUTO_DEFAULT_THRESHOLD : AUTO_DEFAULT_TOPUP);
    if (path === 'threshold') autoTopupState.threshold_dollars = v;
    if (path === 'topup') autoTopupState.topup_dollars = v;
    renderAutoTopup();
  }
  function stepAutoMoney(inputEl, path, delta){
    if (!inputEl || !autoTopupState) return;
    const current = safeMoney(inputEl.value, path === 'threshold' ? AUTO_DEFAULT_THRESHOLD : AUTO_DEFAULT_TOPUP);
    const next = Math.max(AUTO_MIN_AMOUNT, current + delta);
    inputEl.value = String(next);
    if (path === 'threshold') autoTopupState.threshold_dollars = next;
    if (path === 'topup') autoTopupState.topup_dollars = next;
    renderAutoTopup();
  }
  function wireAutoTopupControls(){
    const toggle = $('#bAutoToggle');
    const th = $('#bAutoThreshold');
    const amt = $('#bAutoTopup');
    if (toggle && !toggle.__wired){
      toggle.__wired = true;
      toggle.addEventListener('click', ()=>{
        if (!autoTopupState?.loaded) return;
        autoTopupState.enabled = !autoTopupState.enabled;
        renderAutoTopup();
      });
    }
    if (th && !th.__wired){
      th.__wired = true;
      th.addEventListener('input', ()=>syncAutoMoneyInput(th, 'threshold'));
      th.addEventListener('blur', ()=>{ th.value = String(safeMoney(th.value, AUTO_DEFAULT_THRESHOLD)); syncAutoMoneyInput(th, 'threshold'); });
    }
    if (amt && !amt.__wired){
      amt.__wired = true;
      amt.addEventListener('input', ()=>syncAutoMoneyInput(amt, 'topup'));
      amt.addEventListener('blur', ()=>{ amt.value = String(safeMoney(amt.value, AUTO_DEFAULT_TOPUP)); syncAutoMoneyInput(amt, 'topup'); });
    }
    const thMinus = $('#bAutoThMinus');
    const thPlus = $('#bAutoThPlus');
    const amtMinus = $('#bAutoAmtMinus');
    const amtPlus = $('#bAutoAmtPlus');
    if (thMinus && !thMinus.__wired){ thMinus.__wired = true; thMinus.addEventListener('click', ()=>stepAutoMoney(th, 'threshold', -AUTO_STEP)); }
    if (thPlus && !thPlus.__wired){ thPlus.__wired = true; thPlus.addEventListener('click', ()=>stepAutoMoney(th, 'threshold', AUTO_STEP)); }
    if (amtMinus && !amtMinus.__wired){ amtMinus.__wired = true; amtMinus.addEventListener('click', ()=>stepAutoMoney(amt, 'topup', -AUTO_STEP)); }
    if (amtPlus && !amtPlus.__wired){ amtPlus.__wired = true; amtPlus.addEventListener('click', ()=>stepAutoMoney(amt, 'topup', AUTO_STEP)); }
  }
  function readAmountInput(){
    const raw = String($('#bQty')?.value || '').trim();
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(MIN_CREDIT_AMOUNT, Math.min(MAX_CREDIT_AMOUNT, parsed));
  }
  function firstReportNeededAmount(){
    if (!purchaseTopupContext || (!purchaseTopupContext.firstReportCheckout && !hasPendingOrder())) return null;
    const needed = Number(purchaseTopupContext.needed);
    const required = Number(purchaseTopupContext.required);
    const fallback = Number.isFinite(required) && required > 0 ? Math.ceil(required) : MIN_CREDIT_AMOUNT;
    return Math.max(MIN_CREDIT_AMOUNT, Number.isFinite(needed) && needed > 0 ? Math.ceil(needed) : fallback);
  }
  function firstReportTopupActive(){
    return !!purchaseTopupContext?.firstReportCheckout || !!firstReportAccountLoadEligible;
  }
  function firstReportTopupIsPurchase(){
    return !!purchaseTopupContext?.firstReportCheckout;
  }
  function reportCreditGateActive(){
    return !!purchaseTopupContext && hasPendingOrder();
  }
  function insufficientForFirstReport(balance = currentBalance()){
    const required = purchaseTopupContext
      ? Number(purchaseTopupContext.required || 0)
      : ROOF_COST;
    if (!Number.isFinite(required) || required <= 0) return false;
    if (!Number.isFinite(Number(balance))) {
      return purchaseTopupContext ? Number(purchaseTopupContext.needed || 0) > 0 : false;
    }
    return Number(balance) < required;
  }
  async function refreshFirstReportTopupEligibility(){
    const seq = firstReportEligibilitySeq;
    const balance = currentBalance() ?? purchaseTopupContext?.balance ?? null;
    const alreadyActive = firstReportTopupActive();
    if (purchaseTopupContext) {
      firstReportAccountLoadEligible = false;
      renderPendingSafe();
      renderFundingContext();
      return;
    }
    const eligible = insufficientForFirstReport(balance) && !(await hasDeliveredReportInOrg());
    if (seq !== firstReportEligibilitySeq) return;
    if (!$('#bOverlay')?.classList?.contains('active')) return;
    firstReportAccountLoadEligible = !!eligible;
    if (!alreadyActive && firstReportTopupActive()) {
      $('#bQty').value = String(defaultCreditAmountForContext());
      updateTotal();
    }
    renderPendingSafe();
    renderFundingContext();
  }
  function updateFirstReportInsufficientState(amount){
    const total = $('#bTotal');
    const message = $('#bInsufficientMessage');
    const needed = firstReportNeededAmount();
    const active = needed !== null;
    const numericAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    const insufficient = active && numericAmount < needed;
    total?.classList?.toggle('is-insufficient', insufficient);
    if (message) {
      message.textContent = insufficient
        ? `This credit would not be sufficient to order the report. You need to add at least $${fmtMoney(needed)} to cover this report.`
        : '';
      message.style.display = insufficient ? 'block' : 'none';
    }
  }
  function updateTotal(){
    const q = readAmountInput();
    $('#bTotal').textContent = `$${q ?? 0}`;
    updateFirstReportInsufficientState(q ?? 0);
    if (firstReportAccountLoadEligible && !purchaseTopupContext) {
      const due = $('#bFirstDue');
      if (due) due.textContent = `$${fmtMoney(q ?? 0)}`;
    }
  }
  function normalizeAmountInput(fallback = defaultCreditAmountForContext()){
    const q = clampInt($('#bQty').value, MIN_CREDIT_AMOUNT, MAX_CREDIT_AMOUNT, fallback);
    $('#bQty').value = String(q);
    updateTotal();
    return q;
  }
  function nudge(delta){
    const q = clampInt($('#bQty').value, MIN_CREDIT_AMOUNT, MAX_CREDIT_AMOUNT, defaultCreditAmountForContext());
    $('#bQty').value = String(Math.max(MIN_CREDIT_AMOUNT, Math.min(MAX_CREDIT_AMOUNT, q + delta)));
    updateTotal();
  }
  function currentBalance(){
    const n = Number(window.Portal?.credits?.lastCredits);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function readCookie(name){
    try {
      const match = document.cookie.split('; ').find((item) => item.startsWith(`${name}=`));
      return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
    } catch(e){
      return '';
    }
  }
  function metaAttributionPayload(){
    return {
      fbp: readCookie('_fbp'),
      fbc: readCookie('_fbc')
    };
  }
  function rememberStripeCheckoutPurchase(sessionId, amount){
    try {
      const id = String(sessionId || '').trim();
      if (!id) return;
      sessionStorage.setItem(STRIPE_CHECKOUT_PURCHASE_KEY, JSON.stringify({
        session_id: id,
        amount: Number(amount) || 0,
        saved_at: Date.now()
      }));
    } catch(e){}
  }
  function rememberStripeCheckoutPending(details = {}){
    try {
      const id = String(details.session_id || details.sessionId || '').trim();
      if (!id) return;
      sessionStorage.setItem(STRIPE_CHECKOUT_PENDING_KEY, JSON.stringify({
        session_id: id,
        source: String(details.source || 'billing'),
        amount: Number(details.amount) || 0,
        offer_id: String(details.offer_id || ''),
        offer_instance_id: String(details.offer_instance_id || ''),
        saved_at: Date.now()
      }));
      window.__FM_STRIPE_CHECKOUT_PENDING = true;
    } catch(e){}
  }
  function readStripeCheckoutPending(sessionId){
    try {
      const raw = sessionStorage.getItem(STRIPE_CHECKOUT_PENDING_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const savedAt = Number(data?.saved_at || 0);
      if (!savedAt || Date.now() - savedAt > STRIPE_CHECKOUT_PENDING_MAX_AGE_MS) {
        clearStripeCheckoutPending();
        return null;
      }
      if (sessionId && data.session_id && String(data.session_id) !== String(sessionId)) return null;
      return data;
    } catch(e){
      return null;
    }
  }
  function clearStripeCheckoutPending(){
    try { sessionStorage.removeItem(STRIPE_CHECKOUT_PENDING_KEY); } catch(e){}
    window.__FM_STRIPE_CHECKOUT_PENDING = false;
  }
  function checkoutSessionIdFromResponse(data){
    return String(data?.session?.id || data?.session_id || '').trim();
  }
  function ensureStripeCheckoutOverlay(){
    injectCSS('stripe_checkout_overlay', STRIPE_CHECKOUT_OVERLAY_CSS);
    let overlay = document.getElementById(STRIPE_CHECKOUT_OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = STRIPE_CHECKOUT_OVERLAY_ID;
    overlay.className = 'fm-stripe-checkout-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="fm-stripe-checkout-card">
        <div class="fm-stripe-checkout-spinner" aria-hidden="true"></div>
        <div class="fm-stripe-checkout-title">Secure checkout</div>
        <div class="fm-stripe-checkout-message" data-stripe-checkout-overlay-message>Opening Stripe...</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }
  function showStripeCheckoutOverlay(message = 'Opening Stripe...'){
    const overlay = ensureStripeCheckoutOverlay();
    const text = overlay.querySelector('[data-stripe-checkout-overlay-message]');
    if (text) text.textContent = message;
    overlay.classList.add('active');
  }
  function hideStripeCheckoutOverlay(){
    document.getElementById(STRIPE_CHECKOUT_OVERLAY_ID)?.classList?.remove('active');
  }
  function readStripeCheckoutPurchase(sessionId){
    try {
      const raw = sessionStorage.getItem(STRIPE_CHECKOUT_PURCHASE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (sessionId && data.session_id && String(data.session_id) !== String(sessionId)) return null;
      return data;
    } catch(e){
      return null;
    }
  }
  function clearStripeCheckoutPurchase(){
    try { sessionStorage.removeItem(STRIPE_CHECKOUT_PURCHASE_KEY); } catch(e){}
  }
  function trackMetaPurchase(sessionId, amount){
    const id = String(sessionId || '').trim();
    const value = Number(amount);
    if (!id || !Number.isFinite(value) || value <= 0 || !window.fbq) return;
    try {
      window.fbq('track', 'Purchase', {
        value: Math.round(value * 100) / 100,
        currency: 'USD',
        content_name: 'FirstMate account credit',
        content_type: 'product'
      }, { eventID: `stripe_purchase:${id}` });
    } catch(e){}
  }
  function normalizePurchaseTopupContext(context){
    const purchase = (context && typeof context === 'object') ? context.purchase : null;
    if (!purchase || typeof purchase !== 'object') return null;
    const required = Number(purchase.required ?? purchase.amount ?? 0);
    const balance = Number(purchase.balance);
    const needed = Number(purchase.needed);
    return {
      label: String(purchase.label || 'this purchase'),
      required: Number.isFinite(required) ? Math.max(0, Math.round(required * 100) / 100) : 0,
      balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : null,
      needed: Number.isFinite(needed) ? Math.max(MIN_CREDIT_AMOUNT, Math.ceil(needed)) : null,
      firstReportCheckout: !!context.firstReportCheckout,
      reportCreditView: String(context.reportCreditView || '').trim().toLowerCase()
    };
  }
  function reportCreditGateMode(){
    if (!reportCreditGateActive()) return '';
    const override = reportCreditViewOverride();
    if (override) return override;
    if (purchaseTopupContext?.reportCreditView === 'initial' || purchaseTopupContext?.reportCreditView === 'normal') {
      return purchaseTopupContext.reportCreditView;
    }
    return purchaseTopupContext?.firstReportCheckout ? 'initial' : 'normal';
  }
  function reportCreditGateInitial(){
    return reportCreditGateMode() === 'initial';
  }
  function defaultCreditAmountForContext(){
    if (reportCreditGateActive()) {
      if (!reportCreditGateInitial()) return DEFAULT_CREDIT_AMOUNT;
      const needed = Number(purchaseTopupContext.needed);
      const required = Number(purchaseTopupContext.required);
      const fallback = Number.isFinite(required) && required > 0 ? Math.ceil(required) : MIN_CREDIT_AMOUNT;
      return Math.max(MIN_CREDIT_AMOUNT, Math.min(MAX_CREDIT_AMOUNT, Number.isFinite(needed) && needed > 0 ? Math.ceil(needed) : fallback));
    }
    if (purchaseTopupContext && firstReportTopupIsPurchase()) {
      const needed = Number(purchaseTopupContext.needed);
      const required = Number(purchaseTopupContext.required);
      const fallback = Number.isFinite(required) && required > 0 ? Math.ceil(required) : MIN_CREDIT_AMOUNT;
      return Math.max(MIN_CREDIT_AMOUNT, Math.min(MAX_CREDIT_AMOUNT, Number.isFinite(needed) && needed > 0 ? Math.ceil(needed) : fallback));
    }
    return DEFAULT_CREDIT_AMOUNT;
  }
  function renderFirstReportCheckout(){
    const card = $('#bFirstReportCard');
    const overlay = $('#bOverlay');
    const creditGrid = $('#bCreditGrid');
    const hint = $('#bHint');
    const label = $('#bCreditLabel');
    if (!card) return;
    const reportGateActive = reportCreditGateActive();
    const active = firstReportTopupActive() || reportGateActive;
    const purchaseActive = firstReportTopupIsPurchase();
    card.style.display = active ? 'block' : 'none';
    overlay?.classList?.toggle('report-credit-gate', reportGateActive);
    overlay?.classList?.toggle('first-report-checkout', purchaseActive || reportGateActive);
    overlay?.classList?.toggle('first-report-account-load', active && !purchaseActive && !reportGateActive);
    creditGrid?.classList?.toggle('b-subtle-topup', purchaseActive || reportGateActive);
    if (label) label.textContent = active ? 'Credit to add today' : 'Credit To Add';
    if (hint) {
      hint.textContent = CREDIT_AMOUNT_HELP_TEXT;
    }
    updateFirstReportInsufficientState(readAmountInput() ?? 0);
    if (!active) return;
    const pending = readPending();
    const autoSubmit = $('#bFirstAutoSubmit');
    const balance = currentBalance() ?? purchaseTopupContext?.balance ?? 0;
    const required = (purchaseActive || reportGateActive) ? (Number(purchaseTopupContext.required) || pendingOrderAmount(pending?.fields || {}) || 0) : ROOF_COST;
    const needed = (purchaseActive || reportGateActive)
      ? Math.max(MIN_CREDIT_AMOUNT, Math.ceil(Number(purchaseTopupContext.needed ?? (required - balance)) || required || MIN_CREDIT_AMOUNT))
      : (readAmountInput() ?? defaultCreditAmountForContext());
    const kicker = $('#bFirstReportCard .b-first-kicker');
    const copy = $('#bFirstReportCard .b-first-copy');
    const address = $('#bFirstAddress');
    if (kicker) {
      if (reportGateActive) kicker.innerHTML = '<i class="fas fa-file-invoice-dollar"></i> Report checkout';
      else if (purchaseActive) kicker.innerHTML = '<i class="fas fa-gift"></i> First report checkout';
      else kicker.innerHTML = '<i class="fas fa-gift"></i> First account load';
      kicker.style.display = reportGateActive ? 'none' : '';
    }
    $('#bFirstReportCard .b-first-title').textContent = reportGateActive
      ? 'More credit needed'
      : (purchaseActive ? 'Thanks for trying FirstMeasure.'
      : 'Load your account for your first report.');
    if (copy) {
      copy.textContent = (purchaseActive || reportGateActive)
      ? 'Add credit to your account to pay for this report.'
      : 'You have not received a completed report yet. Add credit now so your first order is ready when you need it.';
      copy.style.display = reportGateActive ? 'none' : '';
    }
    if (address) {
      address.textContent = (purchaseActive || reportGateActive) ? (pending?.fields?.address || 'Your roof report') : 'No completed reports yet';
      address.style.display = reportGateActive ? 'none' : '';
    }
    $('#bFirstReportCard .b-first-number:first-child span').textContent = (purchaseActive || reportGateActive) ? 'Needed for order' : 'First report from';
    $('#bFirstReportCard .b-first-number.due span').textContent = (purchaseActive || reportGateActive) ? 'Difference' : 'Credit to add';
    $('#bFirstReportTotal').textContent = `$${fmtMoney(required)}`;
    $('#bFirstBalance').textContent = `$${fmtMoney(balance)}`;
    $('#bFirstDue').textContent = `$${fmtMoney(needed)}`;
    if (autoSubmit) {
      autoSubmit.textContent = reportGateActive
        ? ''
        : (purchaseActive && pending?.fields?.address)
        ? 'After payment goes through, this report order will submit automatically. You do not need to place it again.'
        : 'This credit will be available for your first report order.';
    }
  }
  function renderFundingContext(){
    const title = $('#bTitle');
    const subtitle = $('#bSubtitle');
    if (!title || !subtitle) return;
    renderFirstReportCheckout();
    renderAutoTopup();
    const balance = currentBalance();
    const purchase = purchaseTopupContext;
    const po = readPending();
    if (purchase && po?.fields?.address) {
      title.textContent = 'More credit needed';
      subtitle.textContent = '';
      return;
    }
    if (firstReportAccountLoadEligible) {
      title.textContent = 'Load your account';
      subtitle.textContent = balance === null
        ? 'Add credit before ordering your first report.'
        : `Your balance is $${fmtMoney(balance)}. Add credit before ordering your first report.`;
      return;
    }
    if (po?.fields?.address) {
      title.textContent = 'More credit needed';
      subtitle.textContent = balance === null
        ? 'Checking your balance. More credit is needed to fulfill this order.'
        : `Your balance is $${fmtMoney(balance)}. More credit is needed to fulfill this order.`;
      return;
    }
    if (purchase) {
      const current = balance ?? purchase.balance;
      title.textContent = 'More credit needed';
      subtitle.textContent = current === null
        ? `Please top up your account to complete ${purchase.label}.`
        : `Your balance is $${fmtMoney(current)}. Please top up your account to complete ${purchase.label}.`;
      return;
    }
    title.textContent = 'Add credit';
    subtitle.textContent = balance === null ? 'Checking your balance.' : `Your balance is $${fmtMoney(balance)}.`;
  }

  function renderPendingSafe(){
    const po = readPending();
    const card = $('#bPendingCard');
    if (!card) {
      renderFundingContext();
      return;
    }
    if (!po?.fields?.address){
      card.style.display = 'none';
      renderFundingContext();
      return;
    }
    card.style.display = 'block';
    $('#bPendingAddr').textContent = po.fields.address || '-';
    const rn = po.fields.residentName || '';
    const em = po.fields.residentEmail || '';
    const ph = po.fields.residentPhone || '';
    const projectType = String(po.fields.project_type || 'residential').trim().toLowerCase() || 'residential';
    const typeLabel = projectType === 'commercial'
      ? 'Commercial'
      : (projectType === 'multifamily' ? 'Multi-Family' : 'Residential');
    const scopeLabel = pendingIncludesGutters(po.fields) ? 'Roof & Gutters' : 'Roof Only';
    const packageLabel = `${pendingReportModeLabel(po.fields)} - ${scopeLabel}`;
    const quote = pendingOrderQuote(po.fields);
    const priceLabel = quote.active
      ? `$${fmtMoney(quote.final_amount)} (save $${fmtMoney(quote.discount_amount)})`
      : `$${fmtMoney(quote.final_amount)}`;
    $('#bPendingSub').textContent = [typeLabel, packageLabel, priceLabel, rn, em, ph].filter(Boolean).join(' - ') || '-';
    renderFundingContext();
  }

  function renderPending(){
    const po = readPending();
    const card = $('#bPendingCard');
    if (!card) return;
    if (!po?.fields?.address){
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    $('#bPendingAddr').textContent = po.fields.address || '—';
    const rn = po.fields.residentName || '';
    const em = po.fields.residentEmail || '';
    const ph = po.fields.residentPhone || '';
    const projectType = String(po.fields.project_type || 'residential').trim().toLowerCase() || 'residential';
    const typeLabel = projectType === 'commercial'
      ? 'Commercial'
      : (projectType === 'multifamily' ? 'Multi-Family' : 'Residential');
    const scopeLabel = pendingIncludesGutters(po.fields) ? 'Roof & Gutters' : 'Roof Only';
    const packageLabel = `${pendingReportModeLabel(po.fields)} · ${scopeLabel}`;
    const quote = pendingOrderQuote(po.fields);
    const priceLabel = quote.active
      ? `$${fmtMoney(quote.final_amount)} (save $${fmtMoney(quote.discount_amount)})`
      : `$${fmtMoney(quote.final_amount)}`;
    $('#bPendingSub').textContent = [typeLabel, packageLabel, priceLabel, rn, em, ph].filter(Boolean).join(' • ') || '—';
  }

  async function startCheckout(e){
    e?.preventDefault?.();
    const errEl = $('#bErr');
    const btn = $('#bGo');
    errEl.textContent = '';
    btn.disabled = true;

    const old = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Redirecting`;

    try{
      const rawQty = String($('#bQty').value || '').trim();
      if (!rawQty){
        errEl.textContent = 'Enter an amount to continue.';
        btn.disabled = false;
        btn.innerHTML = old;
        return;
      }

      const qty = normalizeAmountInput();
      const firstReportNeeded = firstReportNeededAmount();
      if (firstReportNeeded !== null && qty < firstReportNeeded) {
        updateFirstReportInsufficientState(qty);
        btn.disabled = false;
        btn.innerHTML = old;
        return;
      }
      if (purchaseTopupContext && !hasPendingOrder()) suppressAutoSubmitForPurchase();
      else clearAutoSubmitSuppression();
      if (autoTopupAvailableInCurrentFlow() && autoTopupDirty()) {
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving`;
        const saved = await saveAutoTopupSettings();
        if (!saved) {
          errEl.textContent = 'Could not save auto top-up settings.';
          btn.disabled = false;
          btn.innerHTML = old;
          return;
        }
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Redirecting`;
      }
      const { data } = await postAction('stripe_create_checkout', { qty, ...metaAttributionPayload() });

      if (!data || !data.success || !data.url){
        errEl.textContent = data?.error || 'Failed to start checkout.';
        btn.disabled = false;
        btn.innerHTML = old;
        return;
      }

      const checkoutSessionId = checkoutSessionIdFromResponse(data);
      rememberStripeCheckoutPurchase(checkoutSessionId, qty);
      rememberStripeCheckoutPending({
        session_id: checkoutSessionId,
        source: 'billing',
        amount: qty
      });
      showStripeCheckoutOverlay('Taking you to secure checkout...');
      window.location.href = data.url;
    }catch(err){
      errEl.textContent = 'Connection error.';
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  async function tryAutoSubmitPending(reason){
    if (inFlightAutoSubmit) return false;
    if (autoSubmitSuppressed()) return false;
    inFlightAutoSubmit = true;

    try{
      const po = readPending();
      if (!po?.fields?.address) return false;

      await window.Portal.credits.refreshCredits().catch(()=>null);
      const bal = window.Portal.credits.lastCredits ?? 0;
      const requiredAmount = pendingOrderAmount(po.fields);
      if (bal < requiredAmount) return false;

      showToast('Submitting order…', po.fields.address, true);

      const f = po.fields;
      const { data } = await postAction('queue', {
        address: f.address || '',
        residentName: f.residentName || '',
        residentEmail: f.residentEmail || '',
        residentPhone: f.residentPhone || '',
        contacts: f.contacts || '',
        project_title: f.project_title || '',
        project_notes: f.projectNotes || f.project_notes || '',
        lat: f.lat || '',
        lng: f.lng || '',
        custom_coords: f.custom_coords || '0',
        address_components: f.address_components || '{}',
        issuerName: f.issuerName || '',
        issuerEmail: f.issuerEmail || '',
        project_type: f.project_type || 'residential',
        wants_roof_report: f.wants_roof_report || '1',
        gutter_addon: f.gutter_addon || (pendingIncludesGutters(f) ? '1' : '0'),
        weather_addon: f.weather_addon || (pendingIncludesWeather(f) ? '1' : '0'),
        report_mode: pendingReportMode(f),
        report_expedite_option: f.report_expedite_option || '',
        report_expedite_label: f.report_expedite_label || '',
        report_due_window_start: f.report_due_window_start || '',
        report_due_window_end: f.report_due_window_end || '',
        report_due_window_label: f.report_due_window_label || '',
        report_expedite_unit_price: f.report_expedite_unit_price || '',
        report_expedite_total_price: f.report_expedite_total_price || '',
        report_expedite_net_total_price: f.report_expedite_net_total_price || '',
        report_expedite_rush_delta: f.report_expedite_rush_delta || '',
        report_expedite_coupon_available: f.report_expedite_coupon_available || '',
        report_expedite_coupon_discount: f.report_expedite_coupon_discount || '',
        is_expedited: f.is_expedited === true || f.is_expedited === '1' || String(f.is_expedited || '').trim().toLowerCase() === 'true',
        include_gutter_measurements: f.include_gutter_measurements === true || f.include_gutter_measurements === '1' || String(f.include_gutter_measurements || '').trim().toLowerCase() === 'true',
        include_weather_report: f.include_weather_report === true || f.include_weather_report === '1' || String(f.include_weather_report || '').trim().toLowerCase() === 'true',
        report_options: f.report_options || '',
        pins: f.pins || '[]',
        cc_emails: f.cc_emails || '[]',
        tech_notes: f.tech_notes || '',
        platform_project_id: f.platform_project_id || '',
        base_project_id: f.base_project_id || '',
        reorder_project_id: f.reorder_project_id || '',
        source_project_id: f.source_project_id || '',
        client_note: `auto_submit_after_${reason || 'credit'}`
      });

      if (!data || !data.success){
        showToast('Couldn’t submit order', data?.error || 'Order submission failed.', false);
        return false;
      }

      clearPending();
      renderPendingSafe();
      close();

      if (pendingReportMode(f) === 'both') {
        window.dispatchEvent(new CustomEvent('fm:projects:open', {
          detail: {
            project: data?.project || data?.manifest || { id: data?.project?.id || data?.folder || null },
            preferInstant: true
          }
        }));
      }

      await window.Portal.credits.refreshCredits().catch(()=>null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail:{ redraw:true } }));
      showToast('Order submitted', 'Report is now processing.', true);
      return true;
    }catch(err){
      if (err?.code === 'AUTH_REQUIRED') return false;
      showToast('Couldn’t submit order', 'Connection error.', false);
      return false;
    }finally{
      inFlightAutoSubmit = false;
    }
  }

  function setStripeReconcileActive(active, detail = {}){
    window.__FM_STRIPE_CHECKOUT_RECONCILING = !!active;
    window.dispatchEvent(new CustomEvent(active ? 'fm:stripe:checkout-reconciling' : 'fm:stripe:checkout-reconciled', {
      detail: { active: !!active, ...detail }
    }));
  }

  async function fulfillStripeCheckoutWithPolling(sessionId, reason){
    const sid = String(sessionId || '').trim();
    if (!sid) return { data: null, attempts: 0 };
    const startedAt = Date.now();
    let attempts = 0;
    let lastData = null;
    while (Date.now() - startedAt <= STRIPE_RECONCILE_MAX_WAIT_MS) {
      attempts += 1;
      try {
        lastData = (await postAction('stripe_fulfill_session', { session_id: sid }))?.data || null;
      } catch(e){
        lastData = null;
      }
      if (lastData?.success === true) return { data: lastData, attempts };
      showStripeCheckoutOverlay(attempts === 1
        ? 'Confirming your payment...'
        : 'Still confirming your payment...');
      await wait(STRIPE_RECONCILE_POLL_MS);
    }
    return { data: lastData, attempts };
  }

  async function reconcileStripeCheckout({ paid = '1', sessionId = '', reason = 'stripe_return', clearReturnUrl = false } = {}){
    const sid = String(sessionId || '').trim();
    if (paid !== '1' && paid !== '0') return false;
    if (stripeReconcilePromise) return await stripeReconcilePromise;
    const initialPending = readStripeCheckoutPending(sid);
    stripeReconcilePromise = (async () => {
      let reconciled = false;
      let fulfillData = null;
      let attempts = 0;
      setStripeReconcileActive(true, {
        paid,
        session_id: sid || initialPending?.session_id || '',
        reason,
        source: initialPending?.source || ''
      });
      try {
        if (paid !== '1'){
          showToast('Payment canceled', 'No charges were made.', false);
          clearStripeCheckoutPending();
          clearStripeCheckoutPurchase();
          return false;
        }

        const rememberedPending = initialPending || readStripeCheckoutPending(sid);
        const sessionToFulfill = sid || rememberedPending?.session_id || '';
        showStripeCheckoutOverlay(reason === 'bfcache_restore' ? 'Confirming your payment...' : 'Finishing your payment...');
        showToast(reason === 'bfcache_restore' ? 'Checking payment status' : 'Payment received', 'Updating credits...');
        if (sessionToFulfill){
          const fulfilled = await fulfillStripeCheckoutWithPolling(sessionToFulfill, reason);
          fulfillData = fulfilled.data;
          attempts = fulfilled.attempts;
        }
        const paidByReturnUrl = reason !== 'bfcache_restore';
        if (!sessionToFulfill || fulfillData?.success !== true) {
          showToast('Payment not complete', 'No charge has been confirmed yet.', false);
          return false;
        }
        const remembered = readStripeCheckoutPurchase(sessionToFulfill) || rememberedPending;
        const purchaseAmount = Number(fulfillData?.paid_dollars || remembered?.amount || 0);
        trackMetaPurchase(sessionToFulfill, purchaseAmount);
        clearStripeCheckoutPending();
        clearStripeCheckoutPurchase();
        await window.Portal.credits.refreshCredits().catch(()=>null);
        const pendingOrder = hasPendingOrder();
        if (pendingOrder) clearAutoSubmitSuppression();
        const suppressAutoSubmit = !pendingOrder && autoSubmitSuppressed();
        showToast('Credits updated', pendingOrder ? 'Submitting your report order now.' : (suppressAutoSubmit ? 'You can continue with the add-on purchase.' : 'You can submit orders now.'));
        close();
        if (!suppressAutoSubmit) await tryAutoSubmitPending(reason || 'stripe_return');
        reconciled = true;
        return true;
      } finally {
        if (clearReturnUrl) {
          const url = new URL(window.location.href);
          url.searchParams.delete('paid');
          url.searchParams.delete('session_id');
          window.history.replaceState({}, document.title, url.toString());
        }
        setStripeReconcileActive(false, {
          paid,
          session_id: sid || initialPending?.session_id || '',
          reason,
          reconciled,
          source: initialPending?.source || '',
          attempts,
          fulfill: fulfillData || null
        });
        hideStripeCheckoutOverlay();
      }
    })().finally(() => {
      stripeReconcilePromise = null;
    });
    return await stripeReconcilePromise;
  }

  async function handleStripeReturn(){
    const paid = cfg.stripePaidFlag;
    if (paid !== '1' && paid !== '0') return;

    const url = new URL(window.location.href);
    const sid = url.searchParams.get('session_id');
    await reconcileStripeCheckout({ paid, sessionId: sid, reason: 'stripe_return', clearReturnUrl: true });
  }

  async function handleStripeRestore(event){
    const restored = event?.persisted === true
      || performance.getEntriesByType?.('navigation')?.[0]?.type === 'back_forward';
    if (!restored) return;
    const pending = readStripeCheckoutPending();
    if (!pending?.session_id) return;
    await reconcileStripeCheckout({
      paid: '1',
      sessionId: pending.session_id,
      reason: 'bfcache_restore',
      clearReturnUrl: false
    });
  }

  function open(context){
    // PERMISSION CHECK
    if (!hasPerm('manage_billing')) {
      showToast('Access denied', 'You do not have permission to manage billing.', false);
      return;
    }

    ensureUI();
    purchaseTopupContext = normalizePurchaseTopupContext(context);
    firstReportAccountLoadEligible = false;
    firstReportEligibilitySeq += 1;
    $('#bErr').textContent = '';
    const overlay = $('#bOverlay');
    overlay.classList.add('active');
    billingModalHandle?.unregister?.();
    billingModalHandle = window.Portal?.modals?.register?.(overlay, {
      id: 'billing',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: () => close()
    }) || null;
    $('#bQty').value = String(defaultCreditAmountForContext());
    updateTotal();
    renderPendingSafe();
    renderFundingContext();
    Promise.resolve(window.Portal?.credits?.refreshCredits?.())
      .then(()=>refreshFirstReportTopupEligibility())
      .catch(()=>refreshFirstReportTopupEligibility())
      .catch(()=>null);
    loadAutoTopupSettings().catch(()=>null);

    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:true, id:'billing', context } }));
  }

  function close(){
    firstReportEligibilitySeq += 1;
    billingModalHandle?.unregister?.();
    billingModalHandle = null;
    const ov = $('#bOverlay');
    if (ov) ov.classList.remove('active');
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:false, id:'billing' } }));
  }

  function updateButtonVisibility() {
    document.querySelectorAll('#btnBuyCredits,[data-buy-credits]').forEach((btn) => {
      btn.style.display = hasPerm('manage_billing') ? '' : 'none';
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('btnBuyCredits');
    if (btn) btn.addEventListener('click', ()=>open('manual'));
    document.addEventListener('click', (event) => {
      const trigger = event.target?.closest?.('[data-buy-credits]');
      if (!trigger) return;
      event.preventDefault();
      open(trigger.dataset.buyCredits || 'manual');
    });
    handleStripeReturn().catch(()=>null);
    window.Portal.credits.refreshCredits().then(()=>tryAutoSubmitPending('boot')).catch(()=>null);
    updateButtonVisibility();
  });
  window.addEventListener('pageshow', (event) => {
    handleStripeRestore(event).catch(()=>null);
  });

  // Re-check visibility if permissions reload
  window.addEventListener('fm:perms:updated', updateButtonVisibility);

  window.addEventListener('fm:billing:open', (e)=>{ open(e?.detail || e?.detail?.context || ''); });

  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.billing = { open, close, tryAutoSubmitPending, reconcileStripeCheckout };
  window.Portal.stripeCheckout = {
    ...(window.Portal.stripeCheckout || {}),
    showOverlay: showStripeCheckoutOverlay,
    hideOverlay: hideStripeCheckoutOverlay,
    reconcile: reconcileStripeCheckout
  };
})();
