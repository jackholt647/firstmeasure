<?php
declare(strict_types=1);

$assetBase = 'https://1m8.ai';
$query = $_SERVER['QUERY_STRING'] ?? '';
$scriptName = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? ''));
$landingPos = strpos($scriptName, '/landing');
$portalBase = $landingPos === false ? '' : substr($scriptName, 0, $landingPos);
$signupScriptVersion = (string)(@filemtime(__DIR__ . '/../../shared/signup-widget.js') ?: time());
$signupScript = ($portalBase ?: '') . '/landing/shared/signup-widget.js?v=' . rawurlencode($signupScriptVersion);
$loginUrl = ($portalBase ?: '') . '/login.php' . ($query ? '?' . $query : '');
$landingVariantMode = (string)($landingVariantMode ?? '');
$isCustomerReferralLanding = ($landingVariantMode === 'customer_referral');
$isPartnerReferralLanding = ($landingVariantMode === 'representative_referral');
$isReferralLanding = $isCustomerReferralLanding || $isPartnerReferralLanding;
$landingAttributionVariant = $landingVariantMode ?: (string)($_GET['variant'] ?? 'measurements');
$landingCampaign = (string)($_GET['cid'] ?? $_GET['campaign'] ?? $_GET['campaign_code'] ?? $_GET['utm_campaign'] ?? '');
$landingCampaignType = (string)($_GET['campaign_type'] ?? $_GET['utm_source'] ?? '');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>$7 Roof Measurements | FirstMate</title>
  <meta name="description" content="<?= $isReferralLanding ? 'You were invited to FirstMate. Create your account and start ordering fast, reliable roof measurement reports.' : 'Fast, reliable roof measurement reports from FirstMate. Residential reports start at $7 with material, waste, ventilation, and detailed measurement data.' ?>">
  <link rel="stylesheet" href="/fonts.css">
  <script>
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '636685175264715');
    fbq('track', 'PageView');
  </script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-W7MP6MZNMZ"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-W7MP6MZNMZ');
  </script>
  <style>
    :root {
      --brand: #d93025;
      --brand-dark: #a82018;
      --ink: #172033;
      --muted: #667085;
      --line: rgba(23, 32, 51, 0.12);
      --page: #f7f8fb;
      --panel: #ffffff;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--page);
      color: var(--ink);
      font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;
      overflow-x: hidden;
    }
    a { color: inherit; text-decoration: none; }
    img { display: block; max-width: 100%; }
    .lp-shell {
      min-height: 100vh;
      overflow-x: hidden;
    }
    .lp-container {
      width: min(1180px, calc(100% - 40px));
      margin: 0 auto;
    }
    .lp-nav {
      position: absolute;
      inset: 0 0 auto;
      z-index: 5;
      color: #fff;
    }
    .lp-nav-inner {
      min-height: 86px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .lp-logo img { width: 176px; height: auto; }
    .lp-nav-links {
      display: flex;
      align-items: center;
      gap: 24px;
      font-size: 14px;
      font-weight: 800;
    }
    .lp-login {
      border: 1px solid rgba(255,255,255,0.44);
      border-radius: 999px;
      padding: 10px 18px;
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(8px);
    }
    .lp-hero {
      position: relative;
      min-height: 760px;
      color: #fff;
      isolation: isolate;
      background: #172033;
      overflow: hidden;
    }
    .lp-hero::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -2;
      background: url("<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/neighborhood_header.png") center/cover no-repeat;
      opacity: 0.55;
    }
    .lp-hero::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      background:
        linear-gradient(90deg, rgba(13, 21, 37, 0.94) 0%, rgba(13, 21, 37, 0.76) 48%, rgba(13, 21, 37, 0.44) 100%),
        linear-gradient(180deg, rgba(13, 21, 37, 0.18) 0%, rgba(13, 21, 37, 0.62) 100%);
    }
    .lp-hero-grid {
      min-height: 760px;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 440px);
      gap: 46px;
      align-items: center;
      padding: 118px 0 56px;
    }
    .lp-hero-grid > * {
      min-width: 0;
    }
    .lp-eyebrow {
      color: #ffd9d6;
      font-size: 13px;
      font-weight: 900;
      letter-spacing: 0.11em;
      line-height: 1.2;
      text-transform: uppercase;
    }
    .lp-hero h1 {
      margin: 18px 0 16px;
      max-width: 720px;
      color: #fff;
      font-size: clamp(35px, 5.6vw, 62px);
      font-weight: 900;
      letter-spacing: 0;
      line-height: 0.98;
      overflow-wrap: anywhere;
    }
    .lp-lead {
      max-width: 650px;
      margin: 0;
      color: rgba(255,255,255,0.88);
      font-size: 20px;
      font-weight: 600;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .lp-hero-proof {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      max-width: 720px;
      margin-top: 32px;
    }
    .lp-invite-strip {
      display: flex;
      align-items: center;
      gap: 14px;
      max-width: 720px;
      margin-top: 28px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      background: rgba(255,255,255,0.1);
      padding: 15px;
      backdrop-filter: blur(10px);
    }
    .lp-invite-avatar {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      background: #fff;
      color: var(--brand);
      font-size: 22px;
      font-weight: 900;
      overflow: hidden;
    }
    .lp-invite-avatar img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .lp-invite-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .lp-invite-copy strong {
      color: #fff;
      font-size: 17px;
      font-weight: 900;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .lp-invite-copy span {
      color: rgba(255,255,255,0.78);
      font-size: 13px;
      font-weight: 800;
      line-height: 1.4;
    }
    .lp-proof-item {
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      padding: 14px;
      backdrop-filter: blur(10px);
    }
    .lp-proof-item strong {
      display: block;
      color: #fff;
      font-size: 22px;
      font-weight: 900;
      line-height: 1.1;
    }
    .lp-proof-item span {
      display: block;
      margin-top: 5px;
      color: rgba(255,255,255,0.74);
      font-size: 12px;
      font-weight: 800;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .lp-report-preview {
      width: min(560px, 100%);
      margin-top: 32px;
      filter: drop-shadow(0 24px 34px rgba(0,0,0,0.34));
    }
    .lp-signup-card {
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 18px;
      background: rgba(255,255,255,0.94);
      color: var(--ink);
      box-shadow: 0 26px 70px rgba(0,0,0,0.32);
      padding: 22px;
      backdrop-filter: blur(16px);
    }
    .lp-signup-card h2 {
      margin: 0;
      color: var(--ink);
      font-size: 24px;
      font-weight: 900;
      letter-spacing: 0;
      line-height: 1.15;
    }
    .lp-signup-card p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.45;
    }
    .lp-widget-mount {
      margin-top: 18px;
    }
    .lp-section {
      padding: 78px 0;
      background: #fff;
    }
    .lp-section.alt { background: var(--page); }
    .lp-section-head {
      max-width: 760px;
      margin: 0 auto 36px;
      text-align: center;
    }
    .lp-section-head h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(30px, 4vw, 44px);
      font-weight: 900;
      letter-spacing: 0;
      line-height: 1.08;
    }
    .lp-section-head p {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
    }
    .lp-video-wrap {
      max-width: 980px;
      margin: 0 auto;
      border-radius: 12px;
      overflow: hidden;
      background: #111827;
      box-shadow: 0 18px 50px rgba(23,32,51,0.18);
    }
    .lp-pricing-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 22px;
    }
    .lp-price-card {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 10px 26px rgba(23,32,51,0.08);
    }
    .lp-price-card img {
      width: 100%;
      height: 210px;
      object-fit: cover;
    }
    .lp-price-body {
      padding: 24px;
      text-align: center;
    }
    .lp-price-body h3 {
      margin: 0;
      color: var(--ink);
      font-size: 20px;
      font-weight: 900;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .lp-price {
      margin-top: 10px;
      color: var(--brand);
      font-size: 36px;
      font-weight: 900;
      line-height: 1;
    }
    .lp-price span {
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
    }
    .lp-time {
      margin-top: 14px;
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
      line-height: 1.45;
    }
    .lp-feature-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
      gap: 54px;
      align-items: center;
    }
    .lp-feature-row img {
      border-radius: 10px;
      box-shadow: 0 18px 46px rgba(23,32,51,0.16);
    }
    .lp-feature-copy h2 {
      margin: 0 0 14px;
      color: var(--ink);
      font-size: clamp(30px, 4vw, 42px);
      font-weight: 900;
      line-height: 1.1;
    }
    .lp-feature-copy p,
    .lp-feature-copy li {
      color: var(--muted);
      font-size: 17px;
      line-height: 1.55;
    }
    .lp-feature-copy ul {
      margin: 16px 0 0;
      padding-left: 22px;
    }
    .lp-feature-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }
    .lp-feature-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 20px;
      min-height: 150px;
    }
    .lp-feature-card strong {
      display: block;
      color: var(--ink);
      font-size: 16px;
      font-weight: 900;
      line-height: 1.25;
    }
    .lp-feature-card span {
      display: block;
      margin-top: 9px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .lp-bottom-cta {
      padding: 86px 0;
      color: #fff;
      background: linear-gradient(135deg, #991b1b 0%, #d93025 54%, #ef6358 100%);
      text-align: center;
    }
    .lp-bottom-cta h2 {
      margin: 0;
      font-size: clamp(34px, 5vw, 56px);
      font-weight: 900;
      line-height: 1;
    }
    .lp-bottom-cta p {
      max-width: 680px;
      margin: 16px auto 0;
      color: rgba(255,255,255,0.86);
      font-size: 19px;
      font-weight: 700;
      line-height: 1.5;
    }
    .lp-bottom-cta a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      margin-top: 26px;
      border-radius: 999px;
      background: #fff;
      color: var(--brand);
      font-weight: 900;
      padding: 13px 28px;
    }
    .lp-footer {
      padding: 34px 0;
      background: #101828;
      color: rgba(255,255,255,0.72);
    }
    .lp-footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      font-size: 13px;
      font-weight: 700;
    }
    .lp-footer img { width: 58px; height: auto; }
    @media (max-width: 980px) {
      .lp-nav-links a:not(.lp-login) { display: none; }
      .lp-hero,
      .lp-hero-grid { min-height: 0; }
      .lp-hero-grid {
        display: block;
        padding-top: 112px;
      }
      .lp-signup-card { max-width: 540px; }
      .lp-report-preview {
        width: 100%;
        max-width: 460px;
      }
      .lp-pricing-grid,
      .lp-feature-row {
        grid-template-columns: 1fr;
      }
      .lp-feature-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 640px) {
      .lp-container {
        width: calc(100vw - 28px);
        max-width: 1180px;
      }
      .lp-nav-inner { min-height: 76px; }
      .lp-logo img { width: 142px; }
      .lp-hero-grid { padding: 94px 0 34px; }
      .lp-hero h1 { font-size: 31px; }
      .lp-lead { font-size: 17px; }
      .lp-hero-proof { grid-template-columns: 1fr; }
      .lp-invite-strip {
        align-items: flex-start;
        margin-top: 22px;
      }
      .lp-signup-card { padding: 16px; border-radius: 14px; }
      .lp-signup-card h2 {
        font-size: 22px;
        overflow-wrap: anywhere;
      }
      .lp-signup-card p { overflow-wrap: anywhere; }
      .lp-section { padding: 58px 0; }
      .lp-price-card img { height: 180px; }
      .lp-feature-grid { grid-template-columns: 1fr; }
      .lp-footer-inner {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=636685175264715&ev=PageView&noscript=1" alt=""></noscript>

  <div class="lp-shell" id="top">
    <nav class="lp-nav" aria-label="Primary">
      <div class="lp-container lp-nav-inner">
        <a class="lp-logo" href="https://1m8.ai/">
          <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/logo_white.png" alt="FirstMate">
        </a>
        <div class="lp-nav-links">
          <a href="#pricing">Pricing</a>
          <a href="#reports">Reports</a>
          <a href="#included">Included</a>
          <a class="lp-login" href="<?= htmlspecialchars($loginUrl, ENT_QUOTES) ?>">Login</a>
        </div>
      </div>
    </nav>

    <header class="lp-hero">
      <div class="lp-container lp-hero-grid">
        <div>
          <div class="lp-eyebrow">FirstMeasure roof reports</div>
          <h1>$7 roof measurements, ready fast.</h1>
          <p class="lp-lead">Get accurate, reliable roof reports powered by FirstMate's AI measurement platform. No subscriptions, no hidden fees, and every report is reviewed before delivery.</p>
          <?php if ($isReferralLanding): ?>
          <div class="lp-invite-strip" data-customer-invite>
            <div class="lp-invite-avatar" data-ref-avatar>F</div>
            <div class="lp-invite-copy">
              <strong data-ref-title><?= $isPartnerReferralLanding ? 'You were invited to FirstMeasure.' : 'You were invited to FirstMate.' ?></strong>
              <span data-ref-copy>Create your account below to start ordering reports.</span>
            </div>
          </div>
          <?php endif; ?>
          <div class="lp-hero-proof" aria-label="Report highlights">
            <div class="lp-proof-item"><strong>$7</strong><span>Residential property reports</span></div>
            <div class="lp-proof-item"><strong>4 hrs</strong><span>Most residential reports returned</span></div>
            <div class="lp-proof-item"><strong>AI + QA</strong><span>Reviewed by measurement specialists</span></div>
          </div>
          <img class="lp-report-preview" src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/report_three_page_large.png" alt="Sample roof measurement report pages">
        </div>

        <aside class="lp-signup-card" aria-label="Create your FirstMate account">
          <h2>Order your first report today.</h2>
          <p><?= $isReferralLanding ? 'Create your account now to order your first report.' : 'Create your account now. Referral offers and tracking are applied automatically from this link.' ?></p>
          <div class="lp-widget-mount"
            data-firstmate-signup
            data-mode="register"
            data-show-login="true"
            data-referral="auto"
            data-landing-variant="<?= htmlspecialchars($landingAttributionVariant, ENT_QUOTES) ?>"
            data-campaign="<?= htmlspecialchars($landingCampaign, ENT_QUOTES) ?>"
            data-campaign-type="<?= htmlspecialchars($landingCampaignType, ENT_QUOTES) ?>"
            data-show-referral-card="<?= $isReferralLanding ? 'false' : 'true' ?>"
            data-offer-visibility="<?= $isReferralLanding ? 'never' : 'auto' ?>"
            data-submit-label="Create account"
            data-title="Create your FirstMate account"></div>
        </aside>
      </div>
    </header>

    <main>
      <section class="lp-section">
        <div class="lp-container">
          <div class="lp-section-head">
            <h2>How can we offer full roof reports for just $7?</h2>
            <p>Expert measurement technicians work faster with FirstMate's AI-powered measurement platform, and those savings are passed on to you.</p>
          </div>
          <div class="lp-video-wrap">
            <script src="https://fast.wistia.com/player.js" async></script>
            <script src="https://fast.wistia.com/embed/iae21voxy3.js" async type="module"></script>
            <style>wistia-player[media-id='iae21voxy3']:not(:defined) { background: center / contain no-repeat url('https://fast.wistia.com/embed/medias/iae21voxy3/swatch'); display: block; filter: blur(5px); padding-top:56.25%; }</style>
            <wistia-player media-id="iae21voxy3" aspect="1.7777777777777777"></wistia-player>
          </div>
        </div>
      </section>

      <section class="lp-section alt" id="pricing">
        <div class="lp-container">
          <div class="lp-pricing-grid">
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/card_residential.jpg" alt="Residential property">
              <div class="lp-price-body">
                <h3>Residential</h3>
                <div class="lp-price">$7 <span>/ property</span></div>
                <div class="lp-time">Most reports returned in<br>4 hours or less</div>
              </div>
            </article>
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/card_multifamily.jpg" alt="Multi-family property">
              <div class="lp-price-body">
                <h3>Multi-Family</h3>
                <div class="lp-price">$12 <span>/ building</span></div>
                <div class="lp-time">Most reports returned in<br>6 hours or less</div>
              </div>
            </article>
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/card_commercial.jpg" alt="Commercial property">
              <div class="lp-price-body">
                <h3>Commercial</h3>
                <div class="lp-price">$12 <span>/ building</span></div>
                <div class="lp-time">Most reports returned in<br>6 hours or less</div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section class="lp-section" id="reports">
        <div class="lp-container lp-feature-row">
          <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/custom_report.png" alt="Measurement report preview">
          <div class="lp-feature-copy">
            <h2>Reports customized for how you sell.</h2>
            <p>Add your logo and control what customers see, from exact measurements to presentation-ready diagrams.</p>
            <ul>
              <li>Squares with or without waste</li>
              <li>Ventilation calculations</li>
              <li>Material lists</li>
              <li>Detailed diagrams and site views</li>
            </ul>
          </div>
        </div>
      </section>

      <section class="lp-section alt" id="included">
        <div class="lp-container">
          <div class="lp-section-head">
            <h2>Each measurement report includes</h2>
          </div>
          <div class="lp-feature-grid">
            <div class="lp-feature-card"><strong>Ventilation calculations</strong><span>NFVA requirements with recommended intake and exhaust types.</span></div>
            <div class="lp-feature-card"><strong>Waste calculations</strong><span>Calculated across multiple waste percentages, including our recommended percentage.</span></div>
            <div class="lp-feature-card"><strong>Material calculations</strong><span>Material lists automatically calculated for your preferred brands and product types.</span></div>
            <div class="lp-feature-card"><strong>3D model views</strong><span>View the 3D model from multiple angles.</span></div>
            <div class="lp-feature-card"><strong>Multiple side angles</strong><span>See the property from all four side angles.</span></div>
            <div class="lp-feature-card"><strong>Detailed measurements</strong><span>Detailed measurements for every roof section.</span></div>
            <div class="lp-feature-card"><strong>Flashing details</strong><span>Precise measurements for different flashing types.</span></div>
            <div class="lp-feature-card"><strong>XML file download</strong><span>Import measurements into your preferred system.</span></div>
          </div>
        </div>
      </section>

      <section class="lp-bottom-cta">
        <div class="lp-container">
          <h2>$7 Roof Measurements</h2>
          <p>Get accurate, fast, reliable roof reports powered by AI. No hidden fees, no subscriptions required.</p>
          <a href="#top" onclick="window.scrollTo({top: 0, behavior: 'smooth'}); return false;">Create account</a>
        </div>
      </section>
    </main>

    <footer class="lp-footer">
      <div class="lp-container lp-footer-inner">
        <img src="<?= htmlspecialchars($assetBase, ENT_QUOTES) ?>/images/logo_square.png" alt="FirstMate">
        <div>info@1m8.ai</div>
        <div>FirstMate roof measurement reports</div>
      </div>
    </footer>
  </div>

  <?php if ($isReferralLanding): ?>
  <script>
    (function(){
      const avatar = document.querySelector('[data-ref-avatar]');
      const title = document.querySelector('[data-ref-title]');
      const copy = document.querySelector('[data-ref-copy]');
      const isPartnerReferral = <?= $isPartnerReferralLanding ? 'true' : 'false' ?>;
      function safe(value, fallback) {
        const text = String(value || '').trim();
        return text || fallback || '';
      }
      function offerText(offer) {
        if (!offer) return '';
        const headline = safe(offer.title || offer.name || offer.headline, '');
        if (headline) return headline;
        const percent = offer.discount_percent || offer.percent_off || offer.discountPercent;
        const days = offer.window_days || offer.days || offer.windowDays;
        if (percent && days) return `Get ${percent}% off orders for your first ${days} days.`;
        if (percent) return `Get ${percent}% off eligible orders.`;
        return safe(offer.description || offer.copy, '');
      }
      function logoUrlFromPartner(partner) {
        const explicit = safe(partner?.logo_url, '');
        if (explicit) return explicit;
        const path = safe(partner?.logo_path, '');
        if (!path) return '';
        if (/^https?:\/\//i.test(path) || path.charAt(0) === '/') return path;
        if (path.indexOf('meta/referrals/') === 0) {
          return '/measure/internal/storage/' + path.replace(/^\/+/, '');
        }
        return '';
      }
      document.addEventListener('firstmate:referral-loaded', event => {
        const data = event.detail || {};
        const name = safe(data?.partner?.display_name || data?.referrer?.name, '');
        const logo = logoUrlFromPartner(data?.partner || {});
        if (isPartnerReferral && name) {
          title.textContent = `You were invited to FirstMeasure by ${name}.`;
        } else if (name) {
          title.textContent = `${name} invited you to FirstMate.`;
        } else {
          title.textContent = isPartnerReferral ? 'You were invited to FirstMeasure.' : 'You were invited to FirstMate.';
        }
        const offer = isPartnerReferral ? offerText(data.offer || null) : '';
        copy.textContent = offer || 'Create your account below to start ordering reports.';
        avatar.innerHTML = logo && isPartnerReferral ? `<img src="${logo.replace(/"/g, '&quot;')}" alt="">` : (name ? name.charAt(0).toUpperCase() : 'F');
      });
    })();
  </script>
  <?php endif; ?>
  <script src="<?= htmlspecialchars($signupScript, ENT_QUOTES) ?>"></script>
</body>
</html>
