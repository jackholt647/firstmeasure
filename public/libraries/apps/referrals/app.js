(function(){
  if (!window.Portal) return;

  const { $, injectCSS, postAction, escapeHtml } = window.Portal.util;
  const { showToast } = window.Portal.ui;

  let referralState = null;
  let statusTimer = null;
  let impressionTracked = false;

  const REFERRAL_OFFERS = {
    gift_card_50: {
      sideTitle: 'Refer a friend and get a $50 gift card.',
      mobileTitle: 'Refer a friend and get a $50 gift card.',
      modalTitle: 'Refer a friend and get a $50 gift card.',
      modalSub: 'Share your link. When they qualify, we send you a $50 Visa gift card.'
    },
    credits_50: {
      sideTitle: 'Refer a friend and get $50 in free credits.',
      mobileTitle: 'Refer a friend and get $50 in free credits.',
      modalTitle: 'Refer a friend and get $50 in free credits.',
      modalSub: 'Share your link. When they qualify, we add $50 in FirstMate credits to your account.'
    }
  };

  function currentReferralVariant(){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    const variant = appFlags?.variant?.('firstmeasure.referral_offer', '');
    return REFERRAL_OFFERS[variant] ? variant : 'gift_card_50';
  }

  function currentReferralOffer(){
    return REFERRAL_OFFERS[currentReferralVariant()] || REFERRAL_OFFERS.gift_card_50;
  }

  function applyReferralCopy(){
    const offer = currentReferralOffer();
    const side = $('#referralSideCard .referral-side-title');
    const mobile = $('#referralMobileBar .referral-mobile-text');
    const modalTitle = $('#referralModal .referral-modal-title');
    const modalSub = $('#referralModal .referral-modal-sub');
    if (side) side.textContent = offer.sideTitle;
    if (mobile) mobile.textContent = offer.mobileTitle;
    if (modalTitle) modalTitle.textContent = offer.modalTitle;
    if (modalSub) modalSub.textContent = offer.modalSub;
  }

  const css = `
    .referral-side-card{
      border:1px solid rgba(217,48,37,0.12);
      border-radius:14px;
      padding:12px;
      background:#fff8f6;
      box-shadow:0 8px 18px rgba(0,0,0,0.04);
      display:none;
      gap:10px;
      align-items:center;
      justify-content:space-between;
      margin-top:auto;
    }
    .referral-side-card.active{display:flex}
    .referral-side-card.active + .sidebar-footer{margin-top:0}
    .referral-side-copy{min-width:0}
    .referral-side-title{
      font-size:13px;
      font-weight:1000;
      line-height:1.2;
      color:#9f241a;
    }
    .referral-side-sub{
      margin-top:3px;
      font-size:11px;
      font-weight:800;
      color:#7a4b45;
      line-height:1.25;
    }
    .referral-side-btn{
      width:36px;
      height:36px;
      border:none;
      border-radius:12px;
      background:var(--primary,#d93025);
      color:var(--on-primary,#fff);
      cursor:pointer;
      flex:0 0 auto;
      box-shadow:0 8px 15px rgba(var(--primary-rgb,217,48,37),.2);
    }
    .referral-mobile-bar{
      --referral-mobile-bar-height:46px;
      position:fixed;
      left:0;
      right:0;
      bottom:0;
      z-index:94000;
      min-height:var(--referral-mobile-bar-height);
      padding:4px 8px calc(4px + env(safe-area-inset-bottom));
      background:#fff;
      border-top:1px solid rgba(0,0,0,.08);
      box-shadow:0 -6px 18px rgba(0,0,0,.08);
      display:none;
    }
    .referral-mobile-bar.active{display:none}
    .referral-mobile-inner{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:7px;
      padding:2px 2px 2px 8px;
      background:#fff;
    }
    .referral-mobile-text{
      min-width:0;
      font-size:11.5px;
      font-weight:1000;
      color:#333;
      line-height:1.1;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .referral-mobile-btn{
      width:30px;
      height:30px;
      padding:0;
      border:none;
      border-radius:10px;
      background:var(--primary,#d93025);
      color:var(--on-primary,#fff);
      font-size:12px;
      font-weight:1000;
      cursor:pointer;
      white-space:nowrap;
      flex:0 0 auto;
      box-shadow:0 8px 15px rgba(var(--primary-rgb,217,48,37),.2);
    }
    .referral-modal{
      position:fixed;
      inset:0;
      z-index:97000;
      display:none;
      align-items:center;
      justify-content:center;
      padding:22px;
      background:rgba(10,14,20,.62);
      backdrop-filter:blur(4px);
    }
    .referral-modal.active{display:flex}
    .referral-modal-win{
      width:min(560px,100%);
      background:#fff;
      border-radius:22px;
      box-shadow:0 24px 72px rgba(0,0,0,.28);
      overflow:hidden;
    }
    .referral-modal-top{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:14px;
      padding:20px 22px 14px;
      border-bottom:1px solid rgba(0,0,0,.08);
      background:#fff8f6;
    }
    .referral-modal-title{
      margin:0;
      color:#151515;
      font-size:25px;
      line-height:1.06;
      letter-spacing:-.35px;
      font-weight:1000;
    }
    .referral-modal-sub{
      margin:7px 0 0;
      color:#6b514d;
      font-size:14px;
      line-height:1.35;
      font-weight:750;
    }
    .referral-modal-close{
      width:38px;
      height:38px;
      border-radius:12px;
      border:1px solid rgba(0,0,0,.08);
      background:#fff;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 auto;
    }
    .referral-modal-body{
      padding:18px 22px 22px;
      display:grid;
      gap:14px;
    }
    .referral-qr-wrap{
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .referral-qr{
      width:214px;
      height:214px;
      border:1px solid #e5e7eb;
      border-radius:18px;
      padding:10px;
      background:#fff;
    }
    .referral-link-row{
      display:flex;
      gap:8px;
      align-items:center;
    }
    .referral-link-input{
      min-width:0;
      flex:1;
      height:42px;
      border:1px solid #d6d9df;
      border-radius:12px;
      padding:10px 12px;
      font-size:13px;
      font-weight:750;
      color:#333;
      background:#fafafa;
    }
    .referral-action-row{
      display:flex;
      gap:10px;
    }
    .referral-action-btn{
      flex:1;
      height:42px;
      border-radius:13px;
      border:1px solid #d6d9df;
      background:#fff;
      color:#333;
      font-size:13px;
      font-weight:1000;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:center;
      gap:8px;
    }
    .referral-action-btn.primary{
      border-color:var(--primary,#d93025);
      background:var(--primary,#d93025);
      color:var(--on-primary,#fff);
    }
    @media (max-width: 820px){
      body.has-referral-promo-mobile{
        --referral-mobile-inset:calc(46px + env(safe-area-inset-bottom));
        height:calc(100vh - var(--referral-mobile-inset));
        height:calc(100dvh - var(--referral-mobile-inset));
      }
      body.has-referral-promo-mobile.promo-project-open{
        height:100vh;
        height:100dvh;
      }
      body.has-referral-promo-mobile .main-panels{
        padding-bottom:12px;
      }
      body.has-referral-promo-mobile .sidebar{
        height:calc(100vh - var(--referral-mobile-inset));
        height:calc(100dvh - var(--referral-mobile-inset));
      }
      body.has-referral-promo-mobile:not(.promo-project-open) .r-overlay{
        bottom:var(--referral-mobile-inset);
      }
      body.has-referral-promo-mobile.promo-project-open .r-overlay{
        bottom:0;
        height:100vh;
        height:100dvh;
      }
      body.has-referral-promo-mobile .v-overlay{
        bottom:var(--referral-mobile-inset);
      }
      .referral-side-card.active{display:none}
      .referral-mobile-bar.active{display:block}
      .referral-modal{
        padding:14px;
        padding-bottom:calc(14px + env(safe-area-inset-bottom));
      }
      .referral-modal-win{border-radius:18px}
      .referral-modal-top{padding:16px 16px 12px}
      .referral-modal-title{font-size:21px}
      .referral-modal-sub{font-size:13px}
      .referral-modal-body{padding:14px 16px 16px;gap:12px}
      .referral-qr{width:184px;height:184px}
      .referral-link-row,.referral-action-row{flex-direction:column}
      .referral-link-input,.referral-action-btn{width:100%}
      .referral-action-btn{
        height:42px;
        min-height:42px;
        padding:0 14px;
      }
      body.promo-project-open .referral-mobile-bar{display:none!important}
    }
  `;

  function qrUrl(link){
    return 'https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data=' + encodeURIComponent(link || '');
  }

  function ensureUI(){
    injectCSS('customer_referrals', css);

    if (!document.getElementById('referralSideCard')) {
      const footer = document.querySelector('.sidebar-footer');
      const card = document.createElement('div');
      card.id = 'referralSideCard';
      card.className = 'referral-side-card';
      card.innerHTML = `
        <div class="referral-side-copy">
          <div class="referral-side-title">Refer a friend and get a $100 Visa gift card.</div>
        </div>
        <button class="referral-side-btn" id="referralSideOpen" type="button" data-fm-tooltip="Get referral link"><i class="fas fa-arrow-right"></i></button>
      `;
      if (footer && footer.parentElement) footer.parentElement.insertBefore(card, footer);
      $('#referralSideOpen')?.addEventListener('click', openModal);
    }

    if (!document.getElementById('referralMobileBar')) {
      const bar = document.createElement('div');
      bar.id = 'referralMobileBar';
      bar.className = 'referral-mobile-bar';
      bar.innerHTML = `
        <div class="referral-mobile-inner">
          <div class="referral-mobile-text">Refer a friend and get a $100 Visa gift card.</div>
          <button class="referral-mobile-btn" id="referralMobileOpen" type="button" data-fm-tooltip="Get referral link"><i class="fas fa-arrow-right"></i></button>
        </div>
      `;
      document.body.appendChild(bar);
      $('#referralMobileOpen')?.addEventListener('click', openModal);
    }

    if (!document.getElementById('referralModal')) {
      const modal = document.createElement('div');
      modal.id = 'referralModal';
      modal.className = 'referral-modal';
      modal.innerHTML = `
        <div class="referral-modal-win">
          <div class="referral-modal-top">
            <div>
              <h2 class="referral-modal-title">Refer a friend and get $100 cash.</h2>
              <div class="referral-modal-sub">Share your link. When they qualify, we send you a referral reward.</div>
            </div>
            <button class="referral-modal-close" id="referralClose" type="button" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="referral-modal-body">
            <div class="referral-qr-wrap"><img class="referral-qr" id="referralQr" alt="Referral QR code"></div>
            <div class="referral-link-row">
              <input class="referral-link-input" id="referralLinkInput" readonly value="">
            </div>
            <div class="referral-action-row">
              <button class="referral-action-btn primary" id="referralCopy" type="button"><i class="fas fa-link"></i> Copy Link</button>
              <button class="referral-action-btn" id="referralShare" type="button"><i class="fas fa-share-nodes"></i> Share</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('mousedown', e => { modal.__downBackdrop = e.target === modal; });
      modal.addEventListener('mouseup', e => { if (modal.__downBackdrop && e.target === modal) closeModal(); modal.__downBackdrop = false; });
      $('#referralClose')?.addEventListener('click', closeModal);
      $('#referralCopy')?.addEventListener('click', copyLink);
      $('#referralShare')?.addEventListener('click', shareLink);
    }
    applyReferralCopy();
  }

  function setVisible(show){
    ensureUI();
    $('#referralSideCard')?.classList.toggle('active', !!show);
    $('#referralMobileBar')?.classList.toggle('active', !!show);
    document.body.classList.toggle('has-referral-promo-mobile', !!show);
    if (!show) closeModal();
  }

  async function track(eventType){
    try { await referralRequest('/event', { event_type: eventType, offer_variant: currentReferralVariant() }); } catch(e){}
  }

  function updateModalLink(){
    const link = referralState?.signup_url || '';
    const input = $('#referralLinkInput');
    const qr = $('#referralQr');
    if (input) input.value = link;
    if (qr) qr.src = qrUrl(link);
  }

  async function openModal(){
    if (!referralState?.show_banner) return;
    ensureUI();
    updateModalLink();
    $('#referralModal')?.classList.add('active');
    track('modal_open');
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:true, id:'referral' } }));
  }

  function closeModal(){
    const modal = $('#referralModal');
    if (modal && modal.classList.contains('active')) {
      modal.classList.remove('active');
      window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:false, id:'referral' } }));
    }
  }

  async function copyLink(){
    const link = referralState?.signup_url || '';
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Referral link copied.', 'success');
    } catch(e) {
      const input = $('#referralLinkInput');
      if (input) {
        input.focus();
        input.select();
        document.execCommand('copy');
      }
      showToast('Referral link copied.', 'success');
    }
    track('copy_link');
  }

  async function shareLink(){
    const link = referralState?.signup_url || '';
    if (!link) return;
    const text = 'Try FirstMate with my referral link.';
    track('share_click');
    if (navigator.share) {
      try {
        await navigator.share({ title: 'FirstMate referral', text, url: link });
        return;
      } catch(e){}
    }
    window.location.href = 'mailto:?subject=' + encodeURIComponent('FirstMate referral') + '&body=' + encodeURIComponent(text + '\n\n' + link);
  }

  async function refreshStatus(){
    try {
      const data = await referralRequest('/status', {
        track_impression: impressionTracked ? '0' : '1',
        offer_variant: currentReferralVariant()
      });
      if (!data || !data.success) {
        setVisible(false);
        return;
      }
      referralState = data;
      if (data.show_banner) impressionTracked = true;
      setVisible(!!data.show_banner);
      updateModalLink();
    } catch(e) {
      setVisible(false);
    }
  }

  function referralBase(){
    const endpoint = String(window.__APP?.serverEndpoint || window.Portal?.cfg?.serverEndpoint || '');
    if (endpoint.includes('/v1/platform/portal-action')) {
      return endpoint.replace(/\/portal-action\/?$/, '/referrals');
    }
    const host = (location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:3111/v1/platform/referrals';
    return `${location.origin}/v1/platform/referrals`;
  }

  async function referralRequest(path, fields){
    const payload = Object.assign({}, fields || {}, {
      actor_email: window.__APP?.userEmail || window.Portal?.currentUser?.email || '',
      actor_name: window.__APP?.userName || window.Portal?.currentUser?.name || '',
      actor_org_id: window.__APP?.userOrgId || window.Portal?.currentUser?.organization_id || '',
      offer_variant: currentReferralVariant()
    });
    const res = await fetch(referralBase() + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false || data.ok === false) {
      throw new Error(data.error || data.message || 'Referral request failed.');
    }
    return data;
  }

  async function start(){
    if (window.Portal?.appFlags?.load) {
      await window.Portal.appFlags.load().catch(() => null);
    }
    if (!window.Portal?.appFlags?.has?.('firstmeasure', 'referral_program_banner')) {
      return;
    }
    ensureUI();
    refreshStatus();
    clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 60000);
    window.addEventListener('fm:modal:open', event => {
      const isProject = !!event?.detail?.open && event?.detail?.id !== 'referral';
      document.body.classList.toggle('promo-project-open', isProject);
    });
  }

  document.addEventListener('DOMContentLoaded', () => { start().catch(() => null); });
})();
