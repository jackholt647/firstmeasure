/**
 * public/libraries/apps/help/app.js
 * Self-contained floating help widget.
 * Injects its own styles + markup; uses the app's CSS custom properties
 * (--primary, --primary-rgb, --on-primary, --primary-dark) for theming.
 */
(function () {
  /* ── Prevent double-init ─────────────────────────────────── */
  if (document.getElementById('fmHelpWidget')) return;

  /* ── Stylesheet ──────────────────────────────────────────── */
  const css = `
    /* ----- Floating trigger button ----- */
    #fmHelpBtn{
      position:fixed;
      bottom:24px;
      right:24px;
      z-index:9000;
      width:48px;
      height:48px;
      border-radius:50%;
      border:none;
      cursor:pointer;
      background:var(--primary,#d93025);
      color:var(--on-primary,#fff);
      box-shadow:0 4px 14px rgba(var(--primary-rgb,217,48,37),.35),
                 0 1px 4px rgba(0,0,0,.12);
      display:flex;
      align-items:center;
      justify-content:center;
      transition:transform .22s cubic-bezier(.4,0,.2,1),
                 box-shadow .22s ease,
                 opacity .18s ease;
    }
    #fmHelpBtn:hover{
      transform:scale(1.08);
      box-shadow:0 6px 20px rgba(var(--primary-rgb,217,48,37),.45),
                 0 2px 6px rgba(0,0,0,.1);
    }
    #fmHelpBtn:active{ transform:scale(.96); }
    #fmHelpBtn.fm-hidden{
      opacity:0;
      pointer-events:none;
      transform:scale(.5);
    }
    #fmHelpBtn svg{
      width:22px;
      height:22px;
      fill:currentColor;
    }

    /* ----- Popup card ----- */
    #fmHelpPopup{
      position:fixed;
      bottom:24px;
      right:24px;
      z-index:9001;
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
      transform-origin:bottom right;
      pointer-events:none;
      transition:opacity .28s cubic-bezier(.4,0,.2,1),
                 transform .28s cubic-bezier(.4,0,.2,1);
    }
    #fmHelpPopup.fm-open{
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
      #fmHelpBtn{
        bottom:calc(12px + var(--referral-mobile-inset,0px));
        right:10px;
        width:38px;
        height:38px;
      }
      #fmHelpBtn:hover{ transform:scale(1.04); }
      #fmHelpBtn svg{ width:18px; height:18px; }
      #fmHelpPopup{
        bottom:calc(12px + var(--referral-mobile-inset,0px));
        right:10px;
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
    <!-- Trigger -->
    <button id="fmHelpBtn" aria-label="Help">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48
               10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75
               l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5
               c0-1.1.45-2.1 1.17-2.83l1.24-1.26
               c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2
               .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4
               4c0 .88-.36 1.68-.93 2.25z"/>
      </svg>
    </button>

    <!-- Popup -->
    <div id="fmHelpPopup">
      <div class="fmHelp-header">
        <h3>Need a hand?</h3>
        <button class="fmHelp-close" id="fmHelpCloseBtn" aria-label="Close">&times;</button>
      </div>
      <div class="fmHelp-body">
        <p>We're here to help! Whether you have a question about your account, reports, or anything else, don't hesitate to reach out.</p>
        <p>
          <a class="fmHelp-email" href="mailto:support@1m8.ai">
            <i class="fas fa-envelope"></i>
            support@1m8.ai
          </a>
        </p>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  /* ── Behaviour ───────────────────────────────────────────── */
  const btn   = document.getElementById('fmHelpBtn');
  const popup = document.getElementById('fmHelpPopup');
  const close = document.getElementById('fmHelpCloseBtn');
  let open = false;

  function show() {
    open = true;
    btn.classList.add('fm-hidden');
    popup.classList.add('fm-open');
  }
  function hide() {
    open = false;
    popup.classList.remove('fm-open');
    /* wait for exit animation before re-showing button */
    setTimeout(() => { if (!open) btn.classList.remove('fm-hidden'); }, 260);
  }

  btn.addEventListener('click', show);
  close.addEventListener('click', hide);

  /* Close on outside click */
  document.addEventListener('mousedown', function (e) {
    if (!open) return;
    if (popup.contains(e.target) || btn.contains(e.target)) return;
    hide();
  });

  /* Close on Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) hide();
  });
})();
