/**
 * public/libraries/apps/help/app.js
 * Self-contained help & support card (support@1m8.ai).
 * Injects its own styles + markup; uses the app's CSS custom properties
 * (--primary, --primary-rgb, --on-primary, --primary-dark) for theming.
 * It is opened by the sidebar's Help launcher (window.FirstMateHelp.toggle), which every
 * customer has (1M8-243). Its old floating "?" button covered UI such as chat composers.
 */
(function () {
  /* ── Prevent double-init ─────────────────────────────────── */
  if (document.getElementById('fmHelpWidget')) return;

  /* ── Stylesheet ──────────────────────────────────────────── */
  const css = `
    /* ----- Popup card ----- */
    #fmHelpPopup{
      position:fixed;
      bottom:24px;
      left:24px;
      z-index:2147483600;
      width:320px;
      max-width:calc(100vw - 32px);
      background:#fff;
      border-radius:18px;
      box-shadow:0 16px 48px rgba(0,0,0,.14),
                 0 2px 8px rgba(0,0,0,.06);
      overflow:hidden;
      /* start hidden */
      opacity:0;
      transform:translateY(12px) scale(.92);
      transform-origin:bottom left;
      visibility:hidden;
      pointer-events:none;
      transition:opacity .28s cubic-bezier(.4,0,.2,1),
                 transform .28s cubic-bezier(.4,0,.2,1);
    }
    #fmHelpPopup.fm-open{
      visibility:visible;
      opacity:1;
      transform:translateY(0) scale(1);
      pointer-events:auto;
    }

    /* header bar */
    .fmHelp-header{
      background:var(--primary,#d93025);
      color:var(--on-primary,#fff);
      padding:18px 18px 16px;
      display:flex;
      align-items:center;
      justify-content:space-between;
    }
    .fmHelp-header h3{
      margin:0;
      font-size:15px;
      font-weight:800;
      letter-spacing:-.15px;
    }
    .fmHelp-close{
      background:rgba(var(--on-primary-rgb,255,255,255),.18);
      border:none;
      color:var(--on-primary,#fff);
      width:30px;
      height:30px;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      font-size:16px;
      line-height:1;
      transition:background .16s ease;
      flex-shrink:0;
    }
    .fmHelp-close:hover{
      background:rgba(var(--on-primary-rgb,255,255,255),.3);
    }

    /* body */
    .fmHelp-body{
      padding:20px 18px 22px;
    }
    .fmHelp-body p{
      margin:0 0 14px;
      font-size:13.5px;
      line-height:1.55;
      color:#444;
    }
    .fmHelp-body p:last-child{ margin-bottom:0; }

    .fmHelp-email{
      display:inline-flex;
      align-items:center;
      gap:7px;
      font-weight:700;
      font-size:13.5px;
      color:var(--primary-readable,#d93025);
      text-decoration:none;
      transition:opacity .14s;
    }
    .fmHelp-email:hover{ opacity:.78; }
    .fmHelp-email i{ font-size:13px; }

    /* ----- Mobile tweak ----- */
    @media(max-width:820px){
      #fmHelpPopup{
        bottom:calc(12px + var(--referral-mobile-inset,0px));
        left:10px;
        width:min(300px,calc(100vw - 20px));
        border-radius:14px;
      }
      .fmHelp-header{padding:13px 14px 11px}
      .fmHelp-header h3{font-size:14px}
      .fmHelp-close{width:28px;height:28px;font-size:15px}
      .fmHelp-body{padding:14px 14px 16px}
      .fmHelp-body p{font-size:12.5px;line-height:1.45;margin-bottom:10px}
      .fmHelp-email{font-size:12.5px}
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ── Markup ──────────────────────────────────────────────── */
  const wrapper = document.createElement('div');
  wrapper.id = 'fmHelpWidget';
  wrapper.innerHTML = `
    <div id="fmHelpPopup" role="dialog" aria-labelledby="fmHelpTitle" aria-hidden="true">
      <div class="fmHelp-header">
        <h3 id="fmHelpTitle">${(globalThis.PlatformLanguage?.htmlText("help","m_0db6efc53ab2ed","Need a hand?") ?? "Need a hand?")}</h3>
        <button class="fmHelp-close" id="fmHelpCloseBtn" aria-label="${(globalThis.PlatformLanguage?.htmlText("help","m_3742924668fb10","Close") ?? "Close")}">${(globalThis.PlatformLanguage?.htmlText("help","m_dd0c616953d455","&times;") ?? "&times;")}</button>
      </div>
      <div class="fmHelp-body">
        <p>${(globalThis.PlatformLanguage?.htmlText("help","m_cbc949dace2ec7","We're here to help! Whether you have a question about your account, reports, or anything else, don't hesitate to reach out.") ?? "We're here to help! Whether you have a question about your account, reports, or anything else, don't hesitate to reach out.")}</p>
        <p>
          <a class="fmHelp-email" href="mailto:support@1m8.ai">
            <i class="fas fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("help","m_6132b3067588fe","\n            support@1m8.ai\n          ") ?? "\n            support@1m8.ai\n          ")}</a>
        </p>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  /* ── Behaviour ───────────────────────────────────────────── */
  const popup = document.getElementById('fmHelpPopup');
  const close = document.getElementById('fmHelpCloseBtn');
  let open = false;
  let opener = null;

  /* Beside the launcher that opened it (the sidebar's bottom row); phones use the stylesheet's corner. */
  function place(trigger) {
    popup.style.left = popup.style.bottom = '';
    if (!trigger || window.matchMedia('(max-width:820px)').matches) return;
    const rect = trigger.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const edge = trigger.closest('.sidebar')?.getBoundingClientRect().right ?? rect.right;
    const width = popup.offsetWidth || 320;
    popup.style.left = Math.max(12, Math.min(edge + 12, window.innerWidth - width - 12)) + 'px';
    popup.style.bottom = Math.max(12, window.innerHeight - rect.bottom) + 'px';
  }
  function show(trigger) {
    opener = trigger || null;
    window.__mobileSidebar?.close?.();
    place(opener);
    open = true;
    popup.classList.add('fm-open');
    popup.setAttribute('aria-hidden', 'false');
    opener?.setAttribute?.('aria-expanded', 'true');
  }
  function hide() {
    if (!open) return;
    open = false;
    popup.classList.remove('fm-open');
    popup.setAttribute('aria-hidden', 'true');
    opener?.setAttribute?.('aria-expanded', 'false');
  }

  close.addEventListener('click', hide);

  /* Close on outside click (the launcher toggles it itself) */
  document.addEventListener('mousedown', function (e) {
    if (!open) return;
    if (popup.contains(e.target) || e.target.closest?.('[data-fm-help-open]')) return;
    hide();
  });

  /* Close on Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) hide();
  });

  window.FirstMateHelp = {
    open: show,
    close: hide,
    toggle(trigger) { if (open) hide(); else show(trigger); },
    isOpen: () => open
  };
})();
