(function(){
  if (!window.Portal) return;

  const { $, injectCSS, postAction, hasPerm, escapeHtml } = window.Portal.util;
  const { showToast } = window.Portal.ui;

  const OFFER_ID = 'bonus_upfront_match_v1';
  const PROMO_STATUS_ACTION = 'portal_bonus_upfront_match_status';
  const STRIPE_CHECKOUT_PENDING_KEY = 'fm_stripe_checkout_pending_v1';
  const STRIPE_CHECKOUT_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
  let promoState = null;
  let countdownInterval = null;
  let lastAutoOpenSignature = '';

  function checkoutSessionIdFromResponse(data){
    return String(data?.session?.id || data?.session_id || '').trim();
  }

  function rememberStripeCheckoutPending(details = {}){
    try {
      const id = String(details.session_id || details.sessionId || '').trim();
      if (!id) return;
      sessionStorage.setItem(STRIPE_CHECKOUT_PENDING_KEY, JSON.stringify({
        session_id: id,
        source: String(details.source || 'promo_bonus'),
        amount: Number(details.amount) || 0,
        offer_id: String(details.offer_id || OFFER_ID),
        offer_instance_id: String(details.offer_instance_id || ''),
        saved_at: Date.now()
      }));
      window.__FM_STRIPE_CHECKOUT_PENDING = true;
    } catch(e){}
  }

  function readStripeCheckoutPending(){
    try {
      const raw = sessionStorage.getItem(STRIPE_CHECKOUT_PENDING_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const savedAt = Number(data?.saved_at || 0);
      if (!savedAt || Date.now() - savedAt > STRIPE_CHECKOUT_PENDING_MAX_AGE_MS) {
        sessionStorage.removeItem(STRIPE_CHECKOUT_PENDING_KEY);
        window.__FM_STRIPE_CHECKOUT_PENDING = false;
        return null;
      }
      return data;
    } catch(e){
      return null;
    }
  }

  function stripeCheckoutReturnActive(){
    const paid = window.Portal?.cfg?.stripePaidFlag;
    return paid === '1'
      || paid === '0'
      || window.__FM_STRIPE_CHECKOUT_RECONCILING === true
      || !!readStripeCheckoutPending();
  }

  const css = `
    .promo-modal{
      position:fixed; inset:0; z-index:2147483200;
      background:rgba(10,14,20,0.68);
      backdrop-filter:blur(4px);
      display:none; align-items:center; justify-content:center;
      padding:22px;
    }
    .promo-modal.active{ display:flex; }
    .promo-modal-win{
      width:min(960px, 100%);
      max-height:min(92vh, 980px);
      overflow:hidden;
      border-radius:26px;
      background:#fff;
      box-shadow:0 28px 90px rgba(0,0,0,0.34);
      display:flex; flex-direction:column;
    }
    .promo-modal-top{
      padding:22px 24px 18px;
      background:linear-gradient(135deg, #fff5f2 0%, #fffaf0 100%);
      border-bottom:1px solid rgba(0,0,0,0.08);
      display:flex; align-items:flex-start; justify-content:space-between; gap:14px;
    }
    .promo-modal-head{ min-width:0; }
    .promo-modal-title{
      margin:8px 0 0; font-size:34px; font-weight:1000; letter-spacing:-0.8px; line-height:1.02; color:#18181b;
    }
    .promo-modal-subtitle{
      margin:10px 0 0;
      max-width:none;
      font-size:17px;
      line-height:1.45;
      color:#57534e;
      font-weight:700;
    }
    .promo-modal-expiry{
      margin-top:18px;
      display:inline-flex; align-items:center; gap:10px;
      padding:10px 12px; border-radius:14px;
      background:rgba(0,0,0,0.04); color:#333;
      font-size:12px; font-weight:1000;
    }
    .promo-modal-close{
      width:42px; height:42px; border-radius:14px; border:1px solid rgba(0,0,0,0.08);
      background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
      transition:.16s ease; flex:0 0 auto;
    }
    .promo-modal-close:hover{ transform:translateY(-1px); border-color:rgba(0,0,0,0.16); }
    .promo-modal-body{
      padding:20px 24px 24px;
      overflow:auto;
    }
    .promo-tier-grid{
      display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px;
    }
    .promo-tier-card{
      border:1px solid rgba(0,0,0,0.10);
      border-radius:20px;
      background:#fff;
      padding:16px;
      display:flex; flex-direction:column; gap:12px;
      cursor:pointer;
      transition:.16s ease;
      min-height:190px;
      width:100%;
      text-align:left;
    }
    .promo-tier-card:hover{ transform:translateY(-2px); border-color:rgba(217,48,37,0.28); box-shadow:0 14px 30px rgba(0,0,0,0.06); }
    .promo-tier-card.active{
      border-color:#d93025;
      box-shadow:0 0 0 3px rgba(217,48,37,0.12), 0 18px 34px rgba(217,48,37,0.10);
      background:linear-gradient(180deg, #fff 0%, #fff7f5 100%);
    }
    .promo-tier-top{ display:flex; align-items:center; justify-content:flex-start; gap:8px; }
    .promo-tier-name{ font-size:16px; font-weight:1000; letter-spacing:-0.2px; color:#18181b; }
    .promo-tier-price{ font-size:28px; font-weight:1000; letter-spacing:-0.7px; color:#111; }
    .promo-tier-label{ font-size:11px; font-weight:1000; color:#777; letter-spacing:0.35px; text-transform:uppercase; }
    .promo-tier-main{
      display:grid; grid-template-columns:1fr 1fr; gap:12px;
      align-items:end;
    }
    .promo-tier-main-block{
      padding:10px 12px; border-radius:16px; background:#fafafa; border:1px solid rgba(0,0,0,0.06);
    }
    .promo-tier-main-value{
      font-size:30px; font-weight:1000; letter-spacing:-0.8px; line-height:0.98;
      color:#111;
    }
    .promo-tier-main-block .promo-tier-label{
      margin-top:6px;
    }
    .promo-tier-value{
      margin-top:4px;
      font-size:34px; font-weight:1000; letter-spacing:-0.9px; line-height:0.98;
      color:#b42318;
    }
    .promo-tier-value-label{
      font-size:11px; font-weight:1000; color:#8f2b22; letter-spacing:0.35px; text-transform:uppercase;
    }
    .promo-tier-bonus{
      display:inline-flex; align-items:center; gap:8px;
      padding:8px 10px; border-radius:999px;
      background:rgba(217,48,37,0.08); color:#b42318;
      font-size:12px; font-weight:1000;
      width:max-content;
    }
    .promo-tier-custom{
      grid-column:1 / -1;
      display:grid; grid-template-columns:1.2fr 0.8fr 0.8fr; gap:14px;
      align-items:center;
    }
    .promo-custom-input-wrap{
      display:flex; align-items:center; gap:10px;
      padding:12px 14px; border-radius:16px; background:#fff; border:1px solid rgba(0,0,0,0.10);
    }
    .promo-custom-input-col{
      display:flex; flex-direction:column;
    }
    .promo-custom-dollar{ font-size:20px; font-weight:1000; color:#999; }
    .promo-custom-input{
      width:100%; border:none; outline:none; font-size:22px; font-weight:1000; color:#111; background:transparent;
    }
    .promo-custom-bonus{
      margin-top:8px;
      font-size:14px; font-weight:1000; color:#b42318;
      text-align:center;
    }
    .promo-custom-result{
      display:flex; flex-direction:column; gap:6px;
      padding:12px 14px; border-radius:16px;
      background:#fff7f5; border:1px solid rgba(217,48,37,0.14);
      min-height:78px; justify-content:center;
    }
    .promo-custom-result .lbl{
      font-size:11px; font-weight:1000; color:#8f2b22; letter-spacing:0.35px; text-transform:uppercase;
    }
    .promo-custom-result .val{
      font-size:26px; font-weight:1000; letter-spacing:-0.6px; color:#b42318; line-height:1;
    }
    .promo-modal-actions{
      margin-top:18px;
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      flex-wrap:wrap;
    }
    .promo-modal-selection{
      padding:12px 14px; border-radius:16px;
      background:#fafafa; border:1px solid rgba(0,0,0,0.08);
      font-size:13px; font-weight:1000; color:#444;
    }
    .promo-side-error{
      min-height:18px; font-size:12px; font-weight:1000; color:#d93025;
    }
    .promo-action-group{
      display:flex; align-items:center; gap:10px; margin-left:auto;
    }
    .promo-side-btn{
      height:46px; border-radius:16px; border:none;
      padding:0 20px;
      background:#d93025; color:#fff; font-size:14px; font-weight:1000; cursor:pointer;
      box-shadow:0 14px 26px rgba(217,48,37,0.22);
      transition:.16s ease;
    }
    .promo-side-btn:hover{ background:#bf281e; transform:translateY(-1px); }
    .promo-side-btn:disabled{ opacity:0.55; cursor:not-allowed; transform:none; }
    .promo-side-ghost{
      height:42px; padding:0 18px; border-radius:16px; border:1px solid rgba(0,0,0,0.10);
      background:#fff; color:#444; font-size:13px; font-weight:1000; cursor:pointer;
    }
    @media (max-width: 980px){
      .promo-tier-grid{ grid-template-columns:1fr; }
    }
    @media (max-width: 820px){
      .promo-modal{
        padding:16px;
        align-items:center;
        padding-bottom:calc(16px + env(safe-area-inset-bottom));
      }
      .promo-modal-win{ border-radius:20px; max-height:90vh; }
      .promo-modal-top{ padding:16px 16px 12px; gap:12px; }
      .promo-modal-title{ margin-top:4px; font-size:23px; letter-spacing:-0.4px; }
      .promo-modal-subtitle{ margin-top:7px; font-size:14px; line-height:1.35; font-weight:700; }
      .promo-modal-expiry{ margin-top:11px; padding:7px 9px; border-radius:11px; font-size:11px; gap:7px; }
      .promo-modal-close{ width:34px; height:34px; border-radius:10px; }
      .promo-modal-body{ padding:14px 16px 16px; }
      .promo-tier-grid{ gap:10px; }
      .promo-tier-card{
        display:grid;
        grid-template-columns:minmax(0, 1fr) auto;
        grid-template-areas:
          "name bonus"
          "main main";
        gap:7px 8px;
        min-height:0;
        padding:10px;
        border-radius:14px;
      }
      .promo-tier-top{ grid-area:name; min-width:0; }
      .promo-tier-name{ font-size:14px; }
      .promo-tier-bonus{
        grid-area:bonus;
        align-self:center;
        padding:4px 7px;
        border-radius:9px;
        font-size:10px;
        line-height:1;
        white-space:nowrap;
      }
      .promo-tier-main{
        grid-area:main;
        gap:8px;
      }
      .promo-tier-main-block{
        padding:8px 9px;
        border-radius:12px;
      }
      .promo-tier-main-value,
      .promo-tier-value{
        font-size:22px;
        letter-spacing:-0.4px;
      }
      .promo-tier-label,
      .promo-tier-value-label{
        font-size:10px;
      }
      .promo-tier-custom{ grid-template-columns:1fr; }
      .promo-modal-actions{ margin-top:16px; align-items:stretch; gap:8px; }
      .promo-modal-selection{ display:none; }
      .promo-side-error{ min-height:0; }
      .promo-side-error:empty{ display:none; }
      .promo-action-group{ width:100%; margin-left:0; }
      .promo-side-btn, .promo-side-ghost{ flex:1 1 auto; height:38px; border-radius:12px; padding:0 12px; font-size:12px; }
    }
    @media (max-width: 820px) and (max-height: 740px){
      .promo-modal-subtitle{ display:none; }
      .promo-modal-top{ padding-top:14px; padding-bottom:10px; }
      .promo-modal-expiry{ margin-top:9px; }
      .promo-modal-body{ padding-top:12px; }
    }
  `;

  injectCSS('promo_bonus_upfront_match', css);

  function normalizeOfferTier(tier, index = 0){
    const raw = tier && typeof tier === 'object' ? tier : {};
    const id = String(raw.id || raw.tier_id || '');
    const customerPays = Math.round(Number(raw.customer_pays ?? raw.customerPays ?? raw.amount ?? 0) || 0);
    const bonus = Math.round(Number(raw.bonus_dollars ?? raw.bonus ?? 0) || 0);
    const total = Math.round(Number(raw.total_account_value ?? raw.total ?? (customerPays + bonus)) || 0);
    const months = Number(raw.months || 0) || 0;
    const matchPercent = Number(raw.match_percent ?? raw.matchPercent ?? (customerPays > 0 ? (bonus / customerPays) * 100 : 0)) || 0;
    return {
      valid: !!id && customerPays > 0,
      tierId: id,
      customerPays,
      bonus,
      total,
      label: ((v0) => globalThis.PlatformLanguage?.text("promo-inject","m_9f35fbe4f31045",`Option ${v0}`,{v0}) ?? `Option ${v0}`)(index + 1),
      months,
      matchPercent
    };
  }

  function promoOfferTiers(){
    return (Array.isArray(promoState?.tiers) ? promoState.tiers : [])
      .filter((tier) => String(tier?.id || '') !== 'tier_4_custom')
      .map(normalizeOfferTier)
      .filter((tier) => tier.valid);
  }

  function quoteForTierId(tierId){
    const id = String(tierId || '');
    const tier = promoOfferTiers().find((item) => item.tierId === id);
    if (tier) return tier;
    return { valid:false, tierId:id, customerPays:0, bonus:0, total:0, label:'' };
  }

  function defaultTierId(){
    const tiers = promoOfferTiers();
    return tiers.find((tier) => tier.tierId === 'tier_2')?.tierId || tiers[0]?.tierId || '';
  }

  function maxBonusDollars(){
    return promoOfferTiers().reduce((max, tier) => Math.max(max, tier.bonus || 0), 0);
  }

  function formatMoney(value){
    return `$${Number(value || 0).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())}`;
  }

  function formatRemaining(seconds){
    const total = Math.max(0, parseInt(String(seconds || 0), 10) || 0);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function ensureUI(){
    injectCSS('promo_bonus_upfront_match', css);
    if (!document.getElementById('promoBonusModal')) {
      const modal = document.createElement('div');
      modal.id = 'promoBonusModal';
      modal.className = 'promo-modal';
      modal.innerHTML = `
        <div class="promo-modal-win">
          <div class="promo-modal-top">
            <div class="promo-modal-head">
              <h2 class="promo-modal-title">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_eb9ce81bc40229","Thank you for choosing FirstMate!") ?? "Thank you for choosing FirstMate!")}</h2>
              <div class="promo-modal-subtitle">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_f63e22c5463880","Get up to 50% bonus credit when you load your account today.") ?? "Get up to 50% bonus credit when you load your account today.")}</div>
              <div class="promo-modal-expiry"><i class="fas fa-hourglass-half"></i>${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_feff91ced3b954"," Offer expires in ") ?? " Offer expires in ")}<span id="promoModalExpiry">00:00:00</span></div>
            </div>
            <button class="promo-modal-close" id="promoBonusClose" type="button" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="promo-modal-body">
            <div class="promo-tier-grid" id="promoTierGrid"></div>
            <div class="promo-modal-actions">
              <div class="promo-modal-selection" id="promoSummaryNote">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_5683072373aec0","Select an option to continue to Stripe checkout.") ?? "Select an option to continue to Stripe checkout.")}</div>
              <div class="promo-side-error" id="promoSummaryError"></div>
              <div class="promo-action-group">
                <button class="promo-side-ghost" id="promoCheckoutCancel" type="button">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_2d4675a22ab6bd","Not now") ?? "Not now")}</button>
                <button class="promo-side-btn" id="promoCheckoutBtn" type="button">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_0878467cb960ff","Continue to Checkout") ?? "Continue to Checkout")}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.addEventListener('mousedown', (e)=>{ modal.__downBackdrop = (e.target === modal); });
      modal.addEventListener('mouseup', (e)=>{ if (modal.__downBackdrop && e.target === modal) closeModal(); modal.__downBackdrop = false; });
      $('#promoBonusClose')?.addEventListener('click', closeModal);
      $('#promoCheckoutCancel')?.addEventListener('click', closeModal);
      $('#promoCheckoutBtn')?.addEventListener('click', startCheckout);
    }
  }

  // --- attention feed integration -------------------------------------------
  // The promo no longer renders its own fixed bar. It contributes a low
  // priority client-source entry to the shared PlatformBanners topbar surface;
  // all gating (app flag, manage_billing, server show_banner, countdown)
  // stays here, and the CTA opens the existing tier modal via onCta.

  let promoSourceRegistered = false;

  function promoAttentionEntries(){
    if (!promoState?.show_banner) return [];
    const maxBonus = maxBonusDollars();
    return [{
      id: 'attention_firstmeasure_promo_bonus',
      source: 'firstmeasure_promo',
      key: OFFER_ID,
      priority: 10,
      surfaces: ['topbar'],
      title: maxBonus
        ? `Get up to ${formatMoney(maxBonus)} in free credits with your limited time offer`
        : 'Limited time offer',
      body: `Offer expires in ${formatRemaining(promoState?.seconds_remaining || 0)}`,
      cta_label: 'View Offer',
      tone: 'orange',
      state: 'active',
      dismissible: { topbar: true },
      onCta: openModal
    }];
  }

  function ensurePromoSourceRegistered(){
    if (promoSourceRegistered || !window.PlatformBanners?.registerClientSource) return;
    promoSourceRegistered = true;
    window.PlatformBanners.registerClientSource('firstmeasure_promo', promoAttentionEntries);
  }

  function syncPromoBanner(){
    ensurePromoSourceRegistered();
    window.PlatformBanners?.notifySourceChanged?.('firstmeasure_promo');
  }

  function buildTierCards(){
    const grid = $('#promoTierGrid');
    if (!grid) return;
    const tiers = promoOfferTiers();
    grid.innerHTML = tiers.map((tier) => {
      return `
        <button class="promo-tier-card" type="button" data-tier-id="${String(escapeHtml(tier.tierId))}">
          <div class="promo-tier-top">
            <div class="promo-tier-name">${String(escapeHtml(tier.label || ''))}</div>
          </div>
          <div class="promo-tier-main">
            <div class="promo-tier-main-block">
              <div class="promo-tier-main-value">${String(formatMoney(tier.customerPays || 0))}</div>
              <div class="promo-tier-label">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</div>
            </div>
            <div class="promo-tier-main-block">
              <div class="promo-tier-value">${String(formatMoney(tier.bonus || 0))}</div>
              <div class="promo-tier-value-label">${(globalThis.PlatformLanguage?.htmlText("promo-inject","m_d24a472aa5dc24","Free Credits") ?? "Free Credits")}</div>
            </div>
          </div>
          <div class="promo-tier-bonus">${((v4,v5) => globalThis.PlatformLanguage?.htmlText("promo-inject","m_58ccc0c2abd0fc",`${v4} total, ${v5}% bonus`,{v4,v5}) ?? `${v4} total, ${v5}% bonus`)(formatMoney(tier.total || 0),Math.round(tier.matchPercent || 0))}</div>
        </button>
      `;
    }).join('');

    grid.querySelectorAll('[data-tier-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSelectedTier(btn.getAttribute('data-tier-id') || '');
      });
    });
  }

  function setSelectedTier(tierId){
    promoState = promoState || {};
    promoState.selectedTierId = tierId;
    document.querySelectorAll('#promoTierGrid .promo-tier-card').forEach((card) => {
      card.classList.toggle('active', card.getAttribute('data-tier-id') === tierId);
    });
    updateSummary();
  }

  function selectedQuote(){
    const tierId = promoState?.selectedTierId || '';
    return quoteForTierId(tierId);
  }

  function updateSummary(){
    const quote = selectedQuote();
    $('#promoSummaryError').textContent = '';
    const note = $('#promoSummaryNote');
    if (!note) return;
    if (!quote.valid) {
      note.textContent = (globalThis.PlatformLanguage?.text("promo-inject","m_7b0cf949f780b9","Choose one of the featured options.") ?? "Choose one of the featured options.");
    } else {
      note.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("promo-inject","m_940b94914a87a2",`Selected: pay ${v0} and get ${v1} total.`,{v0,v1}) ?? `Selected: pay ${v0} and get ${v1} total.`)(formatMoney(quote.customerPays || 0),formatMoney(quote.total || 0));
    }
  }

  function openModal(){
    if (!promoState?.show_banner) return;
    ensureUI();
    buildTierCards();
    if (!quoteForTierId(promoState?.selectedTierId).valid) promoState.selectedTierId = defaultTierId();
    if (!promoState.selectedTierId) return;
    setSelectedTier(promoState.selectedTierId);
    $('#promoBonusModal')?.classList.add('active');
    updateCountdownDisplays();
  }

  function closeModal(){
    $('#promoBonusModal')?.classList.remove('active');
  }

  function maybeAutoOpenModal(){
    if (!promoState?.show_banner || !promoState?.auto_open_modal) return;
    if (stripeCheckoutReturnActive()) return;
    const signature = [
      promoState.org_id || '',
      promoState.offer?.offer_id || OFFER_ID,
      promoState.offer_instance_id || promoState.bonus_offer_instance?.id || '',
      promoState.offer?.ends_at || '',
    ].join('::');
    if (signature && signature === lastAutoOpenSignature) return;
    lastAutoOpenSignature = signature;
    openModal();
  }

  async function startCheckout(){
    const btn = $('#promoCheckoutBtn');
    const err = $('#promoSummaryError');
    if (!btn || !err) return;
    err.textContent = '';
    const quote = selectedQuote();
    if (!quote.valid) {
      err.textContent = (globalThis.PlatformLanguage?.text("promo-inject","m_b591b5deef8510","Choose a valid offer amount before continuing.") ?? "Choose a valid offer amount before continuing.");
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Redirecting';
    try{
      const { data } = await postAction('stripe_create_checkout', {
        qty: String(quote.customerPays),
        offer_id: OFFER_ID,
        offer_instance_id: promoState?.offer_instance_id || promoState?.bonus_offer_instance?.id || '',
      });
      if (!data || !data.success || !data.url) {
        err.textContent = data?.error || 'Could not start checkout for this offer.';
        btn.disabled = false;
        btn.innerHTML = original;
        return;
      }
      rememberStripeCheckoutPending({
        session_id: checkoutSessionIdFromResponse(data),
        source: 'promo_bonus',
        amount: quote.customerPays,
        offer_id: OFFER_ID,
        offer_instance_id: promoState?.offer_instance_id || promoState?.bonus_offer_instance?.id || ''
      });
      window.Portal?.stripeCheckout?.showOverlay?.('Taking you to secure checkout...');
      window.location.href = data.url;
    }catch(e){
      err.textContent = (globalThis.PlatformLanguage?.text("promo-inject","m_9e84c7aed4d069","Connection error.") ?? "Connection error.");
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  function updateCountdownDisplays(){
    const remaining = Math.max(0, parseInt(String(promoState?.seconds_remaining || 0), 10) || 0);
    const text = formatRemaining(remaining);
    const modalTimer = $('#promoModalExpiry');
    if (modalTimer) modalTimer.textContent = text;
    // The topbar countdown lives in the attention entry's body; re-emit the
    // client source so PlatformBanners refreshes the text in place.
    syncPromoBanner();
  }

  function stopCountdown(){
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function startCountdown(){
    stopCountdown();
    if (!promoState?.show_banner) return;
    countdownInterval = setInterval(() => {
      if (!promoState) return;
      promoState.seconds_remaining = Math.max(0, (promoState.seconds_remaining || 0) - 1);
      updateCountdownDisplays();
      if (promoState.seconds_remaining <= 0) {
        stopCountdown();
        promoState.show_banner = false;
        syncPromoBanner();
        closeModal();
      }
    }, 1000);
  }

  function permissionsLoaded(){
    const perms = window.Portal.currentUser?.permissions;
    return !!perms && Object.keys(perms).length > 0;
  }

  async function refreshPromoStatus(){
    injectCSS('promo_bonus_upfront_match', css);
    if (stripeCheckoutReturnActive()) closeModal();
    if (!hasPerm('manage_billing') && !permissionsLoaded()) {
      await window.Portal.credits?.refreshCredits?.().catch(()=>null);
    }
    if (!hasPerm('manage_billing')) {
      promoState = null;
      syncPromoBanner();
      closeModal();
      stopCountdown();
      return;
    }
    try{
      const { data } = await postAction(PROMO_STATUS_ACTION, {});
      if (!data || !data.success) {
        promoState = null;
        syncPromoBanner();
        stopCountdown();
        return;
      }
      const previousSelectedTierId = promoState?.selectedTierId || '';
      promoState = {
        ...data,
        selectedTierId: '',
      };
      promoState.selectedTierId = quoteForTierId(previousSelectedTierId).valid ? previousSelectedTierId : defaultTierId();
      if (!promoState.show_banner) {
        syncPromoBanner();
        closeModal();
        stopCountdown();
        return;
      }
      syncPromoBanner();
      startCountdown();
      maybeAutoOpenModal();
    }catch(e){
      promoState = null;
      syncPromoBanner();
      stopCountdown();
    }
  }

  async function boot(){
    if (window.Portal?.appFlags?.load) {
      await window.Portal.appFlags.load().catch(() => null);
    }
    if (!window.Portal?.appFlags?.has?.('firstmeasure', 'bonus_upfront_match')) return;
    ensureUI();
    refreshPromoStatus().catch(()=>null);
  }

  window.addEventListener('fm:perms:updated', () => {
    refreshPromoStatus().catch(()=>null);
  });
  window.addEventListener('fm:stripe:checkout-reconciling', () => {
    closeModal();
  });
  window.addEventListener('fm:stripe:checkout-reconciled', (event) => {
    closeModal();
    if (event?.detail?.reconciled) {
      setTimeout(() => refreshPromoStatus().catch(()=>null), 250);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 450));
  } else {
    setTimeout(boot, 450);
  }
})();
