<?php
declare(strict_types=1);

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
$landingAttributionVariant = $landingVariantMode ?: (string)($_GET['variant'] ?? 'landing_template');
$landingCampaign = (string)($_GET['cid'] ?? $_GET['campaign'] ?? $_GET['campaign_code'] ?? $_GET['utm_campaign'] ?? '');
$landingCampaignType = (string)($_GET['campaign_type'] ?? $_GET['utm_source'] ?? '');
$mediaBase = 'media';
$reportPages = [
  [
    'kicker' => 'Page 1',
    'title' => '$7 Roof Measurement Reports',
    'copy' => 'Roof layout, key dimensions, and measurement totals in one quick view.',
  ],
  [
    'kicker' => 'Page 2',
    'title' => 'Aerial Top View',
    'copy' => 'Understand the roof footprint, property access, and surrounding site before you arrive.',
  ],
  [
    'kicker' => 'Page 3',
    'title' => '3D Roof Facets',
    'copy' => 'Review the roof model from multiple angles to understand shape, slopes, and complexity.',
  ],
  [
    'kicker' => 'Page 4',
    'title' => 'Pitch Diagram',
    'copy' => 'Each facet labeled by pitch, with total area broken down by pitch category.',
  ],
  [
    'kicker' => 'Page 5',
    'title' => 'Area Diagram',
    'copy' => 'Facet-by-facet square footage shown directly on the roof diagram.',
  ],
  [
    'kicker' => 'Page 6',
    'title' => 'Layer Measurements',
    'copy' => 'Color-coded roof line measurements organized by layer so complex roofs are easier to read and verify.',
  ],
  [
    'kicker' => 'Page 7',
    'title' => 'Measurement Summary',
    'copy' => 'Total squares, recommended waste, pitch totals, and key roof measurements.',
  ],
  [
    'kicker' => 'Page 8',
    'title' => 'Steep-Slope Materials',
    'copy' => 'A customized material list based on your preferred roofing system.',
  ],
  [
    'kicker' => 'Page 9',
    'title' => 'Flashing & Accessories',
    'copy' => 'Drip edge, valley metal, step flashing, nails, cap nails, and caulk quantities in one view.',
  ],
  [
    'kicker' => 'Page 10',
    'title' => 'Low-Slope Materials',
    'copy' => 'Dedicated material lists for low-slope roof sections when applicable.',
  ],
  [
    'kicker' => 'Page 11',
    'title' => 'Ventilation Calculations',
    'copy' => 'Intake and exhaust estimates with ridge vent, box vent, and intake product recommendations.',
  ],
  [
    'kicker' => 'Page 12',
    'title' => 'Project Notes',
    'copy' => 'Facet labels make it easier to reference roof sections with your estimator, crew, or customer.',
  ],
];
$faqs = [
  [
    'question' => 'What manufacturers and materials do you support?',
    'answer' => 'Most major manufacturers and material types are supported, including GAF, Owens Corning, Malarky, and CertainTeed.',
  ],
  [
    'question' => 'Can I import measurements into my CRM?',
    'answer' => 'Yes. FirstMeasure reports include XML downloads that can be imported into systems that support XML measurement files.',
  ],
  [
    'question' => 'Are the reports accurate?',
    'answer' => 'Yes. Every report goes through a multi-step quality control process and is backed by our accuracy guarantee.',
  ],
  [
    'question' => 'What areas do you cover?',
    'answer' => 'We cover most of the continental United States. Availability depends on property visibility, imagery quality, tree coverage, and other obstructions.',
  ],
  [
    'question' => 'What if something is wrong with my report?',
    'answer' => 'Contact support in the app or email support@1m8.ai. We’ll review the issue and make it right.',
  ],
  [
    'question' => 'Can I expedite a report?',
    'answer' => 'Yes. Expedite options are available in the app when placing a new order.',
  ],
  [
    'question' => 'Do you have an API?',
    'answer' => 'Yes. For API and integration questions, contact support@1m8.ai.',
  ],
  [
    'question' => 'Are all structures included for $7?',
    'answer' => 'For residential orders, all structures within the property lines are included at no additional cost. Commercial and multi-family reports are billed at $12 per building.',
  ],
];
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>$7 Roof Measurements | FirstMate</title>
  <meta name="description" content="<?= $isReferralLanding ? 'You were invited to FirstMate. Create your account and start ordering fast, reliable roof measurement reports.' : 'Fast, reliable roof measurement reports from FirstMate. Residential reports start at $7 with material, waste, ventilation, and detailed measurement data.' ?>">
  <link rel="stylesheet" href="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/fonts.css">
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
      --page: #f4f6f8;
      --panel: #ffffff;
      --soft: #edf1f5;
      --green: #1f7a55;
      --gold: #b7791f;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      padding-top: 86px;
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
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 20;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(255,255,255,0.86), rgba(255,255,255,0.72));
      border-bottom: 1px solid rgba(23,32,51,0.08);
      backdrop-filter: blur(16px);
    }
    .lp-nav-inner {
      min-height: 86px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .lp-logo img { width: 126px; height: auto; }
    .lp-nav-links {
      display: flex;
      align-items: center;
      gap: 24px;
      font-size: 14px;
      font-weight: 800;
      overflow-x: auto;
      scrollbar-width: none;
      white-space: nowrap;
    }
    .lp-nav-links::-webkit-scrollbar { display: none; }
    .lp-login {
      border: 1px solid rgba(23,32,51,0.16);
      border-radius: 999px;
      padding: 10px 18px;
      background: #fff;
      backdrop-filter: blur(8px);
    }
    .lp-signup-link {
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 900;
      padding: 11px 18px;
    }
    .lp-hero {
      position: relative;
      color: var(--ink);
      isolation: isolate;
      background: #fff;
      overflow: visible;
      border-bottom: 1px solid var(--line);
    }
    .lp-hero::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 360px;
      z-index: -2;
      /* Mirrors the exact blend mode structure of the FAQ section background */
      background:
        linear-gradient(180deg, rgba(232,235,241,0.66), rgba(224,228,236,0.74)),
        url("<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/neighborhood_header.png") center/cover no-repeat;
      opacity: 1.0;
    }
    .lp-hero::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      background: linear-gradient(180deg, rgba(255,255,255,0.2) 0%, #fff 70%);
    }
    .lp-hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(340px, 420px);
      gap: 46px;
      align-items: start;
      padding: 54px 0 58px;
    }
    .lp-hero-grid > * {
      min-width: 0;
    }
    .lp-eyebrow {
      color: var(--brand);
      font-size: 13px;
      font-weight: 900;
      letter-spacing: 0.11em;
      line-height: 1.2;
      text-transform: uppercase;
    }
    .lp-hero h1 {
      margin: 14px 0 14px;
      max-width: 720px;
      color: var(--ink);
      font-size: clamp(34px, 5.2vw, 68px);
      font-weight: 900;
      letter-spacing: 0;
      line-height: 0.98;
      overflow-wrap: anywhere;
    }
    .lp-lead {
      max-width: 690px;
      margin: 0;
      color: #4b5563;
      font-size: 19px;
      font-weight: 600;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .lp-hero-proof {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      max-width: 680px;
      margin-top: 26px;
    }
    .lp-invite-strip {
      display: flex;
      align-items: center;
      gap: 14px;
      max-width: 720px;
      margin-top: 28px;
      border: 1px solid rgba(23,32,51,0.12);
      border-radius: 12px;
      background: #fff;
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
      background: var(--brand);
      color: #fff;
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
      color: var(--ink);
      font-size: 17px;
      font-weight: 900;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .lp-invite-copy span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      line-height: 1.4;
    }
    .lp-proof-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 14px;
      backdrop-filter: blur(10px);
    }
    .lp-proof-item strong {
      display: block;
      color: var(--ink);
      font-size: 22px;
      font-weight: 900;
      line-height: 1.1;
    }
    .lp-proof-item span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .lp-signup-card {
      position: sticky;
      top: 108px;
      border: 1px solid rgba(23,32,51,0.14);
      border-radius: 12px;
      background: rgba(255,255,255,0.96);
      color: var(--ink);
      box-shadow: 0 22px 50px rgba(23,32,51,0.12);
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
      scroll-margin-top: 86px;
      padding: 78px 0;
      background: #fff;
    }
    .lp-section.alt { background: var(--page); }
    #faqs {
      background:
        linear-gradient(180deg, rgba(232,235,241,0.66), rgba(224,228,236,0.74)),
        url("<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/faq-background.png") center / cover no-repeat;
    }
    .lp-report-section {
      padding: 0;
      overflow: clip;
      background:
        linear-gradient(135deg, rgba(10,16,28,0.9), rgba(10,16,28,0.76)),
        url("<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/neighborhood_header.png") center / cover no-repeat;
    }
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
    .lp-section-kicker {
      margin-bottom: 10px;
      color: var(--brand);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .lp-report-intro {
      background: #fff;
      padding: clamp(18px, 3vh, 34px) 0;
    }
    .lp-report-intro-inner {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .lp-report-heading {
      display: flex;
      align-items: baseline;
      justify-content: center;
      flex-wrap: wrap;
      gap: 10px;
      margin: 0;
      color: var(--ink);
      font-size: clamp(28px, 4.3vw, 54px);
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: 0;
    }
    .lp-report-price {
      color: var(--brand);
      white-space: nowrap;
    }
    .lp-report-intro p {
      max-width: 680px;
      margin: 12px auto 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.5;
    }
    .lp-report-viewer-head {
      background: #fff;
    }
    .lp-report-viewer-title {
      position: relative;
      z-index: 4;
      width: min(1180px, calc(100% - 40px));
      margin: 0 auto -1px;
      padding: 18px 0 12px;
      color: var(--ink);
      font-size: clamp(18px, 2vw, 24px);
      font-weight: 900;
      letter-spacing: 0;
      text-align: center;
    }
    .lp-walkthrough {
      --report-page-width: clamp(360px, min(36vw, calc((100vh - 285px) * 0.7727)), 500px);
      --report-page-height: calc(var(--report-page-width) * 1.2941176);
      --report-section-pad: clamp(118px, 12vh, 150px);
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto;
      gap: 0;
      width: 100%;
      background: transparent;
      overflow: hidden;
    }
    .lp-report-step {
      position: relative;
      display: none;
      grid-column: 1;
      grid-row: 1;
      grid-template-columns: minmax(260px, 1fr) minmax(280px, 0.92fr);
      gap: 0;
      align-items: stretch;
      min-height: calc(var(--report-page-height) + (var(--report-section-pad) * 2));
      background: transparent;
      padding: 0;
      opacity: 0;
    }
    .lp-report-step.is-active {
      display: grid;
      opacity: 1;
      z-index: 2;
    }
    .lp-report-step.is-leaving {
      display: grid;
      opacity: 1;
      pointer-events: none;
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    .lp-report-step.is-leaving .lp-step-copy {
      opacity: 0;
    }
    .lp-report-rail {
      grid-column: 1;
      grid-row: 2;
      z-index: 3;
      background: transparent;
      padding: 10px clamp(14px, 2vw, 28px);
    }
    .lp-report-rail-inner {
      display: grid;
      grid-template-columns: repeat(12, minmax(54px, 1fr));
      gap: clamp(5px, 0.8vh, 10px);
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior: contain;
      padding: 4px 2px;
      scrollbar-color: rgba(23,32,51,0.22) transparent;
      scrollbar-width: thin;
    }
    .lp-report-rail-inner::-webkit-scrollbar { height: 6px; }
    .lp-report-rail-inner::-webkit-scrollbar-track { background: transparent; }
    .lp-report-rail-inner::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(23,32,51,0.22);
    }
    .lp-report-thumb {
      position: relative;
      display: grid;
      gap: 6px;
      width: 100%;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 6px;
      text-align: left;
      transition: background 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
    }
    .lp-report-thumb:hover,
    .lp-report-thumb:focus-visible {
      border-color: rgba(217,48,37,0.28);
      background: #fff;
      box-shadow: 0 10px 22px rgba(23,32,51,0.08);
      outline: none;
      transform: translateY(-2px);
    }
    .lp-report-thumb.is-active {
      border-color: rgba(217,48,37,0.56);
      background: #fff;
      color: var(--brand);
      box-shadow: 0 14px 30px rgba(217,48,37,0.13);
    }
    .lp-report-thumb.is-active::before {
      content: "";
      position: absolute;
      inset: auto 8px -1px 8px;
      height: 3px;
      border-radius: 999px;
      background: var(--brand);
    }
    .lp-report-thumb img {
      width: 100%;
      aspect-ratio: 8.5 / 11;
      border: 1px solid rgba(23,32,51,0.12);
      border-radius: 5px;
      background: #fff;
      object-fit: cover;
      object-position: top center;
    }
    .lp-step-copy {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-self: stretch;
      background: transparent;
      color: #fff;
      padding: clamp(48px, 6vh, 78px) clamp(20px, 3vw, 48px);
    }
    .lp-step-kicker {
      color: #ffb5ad;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .lp-step-copy h3 {
      margin: 12px 0 12px;
      color: #fff;
      font-size: clamp(28px, 3.2vw, 50px);
      font-weight: 900;
      line-height: 1.05;
    }
    .lp-report-step:first-of-type .lp-step-copy h3 {
      max-width: 760px;
      font-size: clamp(44px, 5.6vw, 82px);
      line-height: 0.96;
    }
    .lp-step-copy p {
      margin: 0;
      color: rgba(255,255,255,0.82);
      max-width: 580px;
      font-size: clamp(15px, 1.35vw, 18px);
      line-height: 1.52;
    }
    .lp-step-points {
      display: grid;
      gap: 8px;
      margin-top: 18px;
      max-width: 560px;
    }
    .lp-step-points span {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
    }
    .lp-step-points span::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--brand);
      flex: 0 0 auto;
    }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-kicker,
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy h3,
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy p,
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-points span {
      animation: copySlideUp 480ms cubic-bezier(.16,1,.3,1) both;
    }
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-kicker,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy h3,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy p,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-points span {
      animation: copySlideDown 480ms cubic-bezier(.16,1,.3,1) both;
    }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-kicker,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-kicker { animation-delay: 30ms; }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy h3,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy h3 { animation-delay: 80ms; }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy p,
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy p { animation-delay: 130ms; }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-points span:nth-child(1),
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-points span:nth-child(1) { animation-delay: 180ms; }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-points span:nth-child(2),
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-points span:nth-child(2) { animation-delay: 230ms; }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-points span:nth-child(3),
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-points span:nth-child(3) { animation-delay: 280ms; }
    @keyframes copySlideUp {
      from {
        opacity: 0;
        filter: blur(4px);
        transform: translateY(16px);
      }
      to {
        opacity: 1;
        filter: blur(0);
        transform: translateY(0);
      }
    }
    @keyframes copySlideDown {
      from {
        opacity: 0;
        filter: blur(4px);
        transform: translateY(-16px);
      }
      to {
        opacity: 1;
        filter: blur(0);
        transform: translateY(0);
      }
    }
    .lp-report-text-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-top: 20px;
    }
    .lp-mobile-page-count {
      display: none;
    }
    .lp-report-download-inline {
      align-self: flex-start;
      min-height: 38px;
      margin-top: 12px;
      font-size: 13px;
      padding: 9px 16px;
    }
    .lp-report-cta-row {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
    }
    .lp-report-cta-row .lp-report-download-inline {
      margin-top: 0;
    }
    .lp-report-start {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      min-height: 38px;
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 900;
      padding: 9px 16px;
      box-shadow: 0 14px 28px rgba(217,48,37,0.18);
      transition: background 180ms ease, transform 180ms ease;
    }
    .lp-report-start:hover,
    .lp-report-start:focus-visible {
      background: var(--brand-dark);
      outline: none;
      transform: translateY(-2px);
    }
    @media (min-width: 641px) {
      .lp-report-start {
        display: none;
      }
    }
    .lp-report-page {
      position: relative;
      width: min(var(--report-page-width), calc(100% - 104px));
      align-self: start;
      justify-self: center;
      aspect-ratio: 8.5 / 11;
      overflow: visible;
      border: 1px solid rgba(23,32,51,0.16);
      border-radius: 6px;
      background: #fff;
      box-shadow: none;
      margin: var(--report-section-pad) 0;
      order: -1;
    }
    .lp-report-page[data-expand-report-page] {
      cursor: zoom-in;
    }
    .lp-report-page[data-expand-report-page]:focus-visible {
      outline: 3px solid rgba(217,48,37,0.42);
      outline-offset: 5px;
    }
    .lp-report-expand-icon {
      position: absolute;
      right: 10px;
      bottom: 10px;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      box-shadow: 0 8px 20px rgba(23,32,51,0.16);
      pointer-events: none;
    }
    .lp-report-expand-icon svg {
      width: 17px;
      height: 17px;
      stroke: currentColor;
      stroke-width: 2.4;
      fill: none;
    }
    .lp-report-jump {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      border: 1px solid rgba(23,32,51,0.16);
      border-radius: 999px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font: inherit;
      font-size: 15px;
      font-weight: 900;
      padding: 12px 20px;
      transition: background 180ms ease, border-color 180ms ease, color 180ms ease, opacity 180ms ease, transform 180ms ease;
    }
    .lp-report-jump[data-report-next] {
      border-color: rgba(23,32,51,0.16);
      background: #fff;
      color: var(--ink);
      box-shadow: none;
      gap: 4px;
    }
    .lp-report-jump:hover:not(:disabled),
    .lp-report-jump:focus-visible:not(:disabled) {
      border-color: rgba(23,32,51,0.24);
      background: #f6f7f9;
      color: var(--ink);
      outline: none;
      transform: translateY(-2px);
    }
    @media (min-width: 641px) {
      .lp-desktop-button-word {
        display: inline;
      }
      .lp-report-jump[data-report-next] {
        border-color: var(--brand);
        background: var(--brand);
        color: #fff;
        box-shadow: 0 14px 28px rgba(217,48,37,0.18);
      }
      .lp-report-jump[data-report-next]:hover:not(:disabled),
      .lp-report-jump[data-report-next]:focus-visible:not(:disabled) {
        border-color: var(--brand-dark);
        background: var(--brand-dark);
        color: #fff;
      }
    }
    .lp-report-jump:disabled {
      cursor: default;
      opacity: 0.28;
      transform: none;
      box-shadow: none;
    }
    .lp-report-page img {
      width: 100%;
      height: 100%;
      border-radius: 6px;
      object-fit: cover;
      box-shadow: 0 10px 24px rgba(23,32,51,0.10);
      transform-origin: center 42%;
    }
    .lp-walkthrough.is-forward .lp-report-step.is-active .lp-report-page img {
      animation: pageDeckInForward 560ms cubic-bezier(.16,1,.3,1) both;
    }
    .lp-walkthrough.is-backward .lp-report-step.is-active .lp-report-page img {
      animation: pageDeckInBackward 560ms cubic-bezier(.16,1,.3,1) both;
    }
    .lp-walkthrough.is-forward .lp-report-step.is-leaving .lp-report-page img {
      animation: pageDeckOutForward 540ms cubic-bezier(.55,.06,.68,.19) both;
    }
    .lp-walkthrough.is-backward .lp-report-step.is-leaving .lp-report-page img {
      animation: pageDeckOutBackward 540ms cubic-bezier(.55,.06,.68,.19) both;
    }
    @keyframes pageDeckInForward {
      from {
        opacity: 0;
        filter: blur(6px);
        transform: translateX(34px) translateY(10px) scale(0.982) rotate(0.6deg);
      }
      to {
        opacity: 1;
        filter: blur(0);
        transform: translateX(0) translateY(0) scale(1) rotate(0);
      }
    }
    .lp-report-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 18px;
    }
    .lp-report-intro .lp-report-actions {
      display: none;
    }
    .lp-report-download {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      border: 1px solid rgba(23,32,51,0.16);
      border-radius: 999px;
      background: #fff;
      color: var(--ink);
      font-size: 14px;
      font-weight: 900;
      padding: 11px 18px;
      box-shadow: 0 10px 24px rgba(23,32,51,0.08);
      transition: border-color 180ms ease, color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
    }
    .lp-report-download:hover,
    .lp-report-download:focus-visible {
      border-color: var(--brand);
      color: var(--brand);
      outline: none;
      transform: translateY(-2px);
      box-shadow: 0 14px 30px rgba(217,48,37,0.12);
    }
    @keyframes pageDeckInBackward {
      from {
        opacity: 0;
        filter: blur(6px);
        transform: translateX(-34px) translateY(10px) scale(0.982) rotate(-0.6deg);
      }
      to {
        opacity: 1;
        filter: blur(0);
        transform: translateX(0) translateY(0) scale(1) rotate(0);
      }
    }
    @keyframes pageDeckOutForward {
      from {
        opacity: 1;
        filter: blur(0);
        transform: translateX(0) translateY(0) scale(1) rotate(0);
      }
      to {
        opacity: 0;
        filter: blur(4px);
        transform: translateX(-42px) translateY(-8px) scale(0.965) rotate(-0.8deg);
      }
    }
    @keyframes pageDeckOutBackward {
      from {
        opacity: 1;
        filter: blur(0);
        transform: translateX(0) translateY(0) scale(1) rotate(0);
      }
      to {
        opacity: 0;
        filter: blur(4px);
        transform: translateX(42px) translateY(-8px) scale(0.965) rotate(0.8deg);
      }
    }
    .lp-page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 14px;
    }
    .lp-page-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
      font-weight: 900;
    }
    .lp-page-mark {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      background: var(--brand);
    }
    .lp-page-meta {
      color: #6b7280;
      font-size: 11px;
      font-weight: 800;
      text-align: right;
      text-transform: uppercase;
    }
    .lp-page-hero {
      display: grid;
      grid-template-columns: 1fr 0.65fr;
      gap: 14px;
      margin-top: 22px;
    }
    .lp-roof-diagram {
      position: relative;
      min-height: 230px;
      border: 1px solid #d7dee8;
      background:
        linear-gradient(135deg, transparent 43%, rgba(217,48,37,0.22) 43% 48%, transparent 48%),
        linear-gradient(45deg, transparent 40%, rgba(31,122,85,0.2) 40% 45%, transparent 45%),
        #f8fafc;
    }
    .lp-roof-diagram::before,
    .lp-roof-diagram::after {
      content: "";
      position: absolute;
      border: 2px solid #172033;
      transform: rotate(18deg);
    }
    .lp-roof-diagram::before {
      width: 62%;
      height: 38%;
      left: 16%;
      top: 24%;
      background: rgba(255,255,255,0.72);
    }
    .lp-roof-diagram::after {
      width: 34%;
      height: 24%;
      right: 12%;
      bottom: 18%;
      background: rgba(255,255,255,0.82);
    }
    .lp-page-stats {
      display: grid;
      gap: 10px;
    }
    .lp-stat-box {
      border: 1px solid #d7dee8;
      background: #fbfcfe;
      padding: 12px;
    }
    .lp-stat-box strong {
      display: block;
      color: var(--ink);
      font-size: 20px;
      font-weight: 900;
      line-height: 1;
    }
    .lp-stat-box span {
      display: block;
      margin-top: 6px;
      color: #6b7280;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .lp-page-table {
      display: grid;
      gap: 8px;
      margin-top: 22px;
    }
    .lp-table-row {
      display: grid;
      grid-template-columns: 1.2fr 0.7fr 0.7fr;
      gap: 8px;
      min-height: 26px;
      align-items: center;
      border-bottom: 1px solid #e5eaf0;
      color: #4b5563;
      font-size: 12px;
      font-weight: 700;
    }
    .lp-table-row:first-child {
      color: var(--ink);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .lp-mini-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 22px;
    }
    .lp-mini-panel {
      min-height: 140px;
      border: 1px solid #d7dee8;
      background: #fbfcfe;
      padding: 14px;
    }
    .lp-mini-panel strong {
      display: block;
      font-size: 13px;
      font-weight: 900;
    }
    .lp-mini-line {
      height: 8px;
      margin-top: 12px;
      background: #d8dee8;
    }
    .lp-mini-line.short { width: 64%; }
    .lp-mini-line.red { background: rgba(217,48,37,0.36); }
    .lp-testimonial-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
    }
    .lp-quote-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 24px;
      box-shadow: 0 12px 30px rgba(23,32,51,0.08);
    }
    .lp-quote-card blockquote {
      margin: 0;
      color: var(--ink);
      font-size: 18px;
      font-weight: 800;
      line-height: 1.42;
    }
    .lp-quote-card figcaption {
      margin-top: 18px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }
    .lp-report-types {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
      margin-top: 24px;
    }
    .lp-pricing-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      max-width: 760px;
      margin: 0 auto;
    }
    .lp-price-card {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto auto auto;
      align-items: stretch;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 10px 26px rgba(23,32,51,0.08);
      padding: 0;
    }
    .lp-price-card img {
      width: 100%;
      aspect-ratio: 1 / 0.72;
      height: auto;
      border-radius: 0;
      object-fit: cover;
    }
    .lp-price-body {
      padding: 14px 16px 0;
      text-align: center;
    }
    .lp-price-body h3 {
      margin: 0;
      color: var(--ink);
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .lp-price {
      margin: 8px 0 0;
      color: var(--brand);
      font-size: 28px;
      font-weight: 900;
      line-height: 1;
      text-align: center;
    }
    .lp-price span {
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
    }
    .lp-time {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.45;
    }
    .lp-expedite {
      max-width: 720px;
      margin: 18px auto 0;
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
      line-height: 1.45;
      text-align: center;
    }
    .lp-price-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border: 0;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 900;
      margin: 12px 16px 16px;
      padding: 8px 14px;
    }
    .lp-custom-report {
      background: #fff;
      padding: 64px 0;
    }
    .lp-custom-report + .lp-custom-report {
      padding-top: 0;
    }
    .lp-custom-inner {
      display: grid;
      grid-template-columns: minmax(260px, 0.9fr) minmax(280px, 1fr);
      gap: clamp(28px, 5vw, 64px);
      align-items: center;
    }
    .lp-custom-image {
      position: relative;
      overflow: hidden;
      border-radius: 8px;
      box-shadow: 0 18px 46px rgba(23,32,51,0.16);
      background: #fff;
    }
    .lp-custom-image img {
      width: 100%;
      height: auto;
      display: block;
    }
    .lp-custom-image.is-report-preview,
    .lp-custom-image.is-gutter {
      width: min(100%, 368px);
      justify-self: center;
    }
    .lp-beta-pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      margin-left: 8px;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
      padding: 5px 8px;
      text-transform: uppercase;
      vertical-align: middle;
    }
    .lp-custom-copy h2,
    .lp-trust-copy h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(30px, 4vw, 44px);
      font-weight: 900;
      line-height: 1.08;
    }
    .lp-addon-subline {
      margin: 12px 0 0;
      color: var(--brand);
      font-size: 16px;
      font-weight: 900;
      line-height: 1.35;
    }
    .lp-custom-list {
      display: grid;
      gap: 12px;
      margin: 22px 0 0;
    }
    .lp-custom-list span {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 16px;
      font-weight: 800;
    }
    .lp-custom-list span::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--brand);
      flex: 0 0 auto;
    }
    .lp-custom-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      margin-top: 26px;
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 900;
      padding: 13px 24px;
      box-shadow: 0 14px 28px rgba(217,48,37,0.18);
    }
    .lp-trust-section {
      position: relative;
      overflow: hidden;
      background: #f8fafc;
      padding-bottom: clamp(36px, 5vw, 52px);
    }
    .lp-trust-inner {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(280px, 0.85fr) minmax(320px, 1fr);
      column-gap: clamp(26px, 5vw, 58px);
      row-gap: clamp(24px, 3.5vw, 42px);
      align-items: center;
    }
    .lp-trust-copy p {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.55;
    }
    .lp-trust-copy p span {
      color: var(--brand);
      font-weight: 900;
    }
    .lp-trust-video {
      position: relative;
      z-index: 1;
      max-width: 100%;
      margin: 0;
    }
    .lp-trust-video-frame {
      overflow: hidden;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }
    .lp-trust-video-frame wistia-player {
      display: block;
      width: 100%;
      border: 0;
    }
    .lp-trust-video-frame wistia-player[media-id='eco5tm13ug']:not(:defined) {
      display: block;
      padding-top: 56.25%;
      background: center / cover no-repeat url('https://fast.wistia.com/embed/medias/eco5tm13ug/swatch');
      filter: blur(4px);
    }
    .lp-trust-endorsement {
      grid-column: 1 / -1;
      margin: 0;
      color: var(--ink);
      font-size: clamp(19px, 2.2vw, 28px);
      font-weight: 900;
      line-height: 1.15;
      text-align: center;
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
    .lp-faq-list {
      max-width: 920px;
      margin: 0 auto;
      display: grid;
      gap: 12px;
    }
    .lp-faq-item {
      overflow: hidden;
      border: 1px solid rgba(23,32,51,0.12);
      border-radius: 14px;
      background: rgba(255,255,255,0.94);
      box-shadow: 0 12px 28px rgba(23,32,51,0.06);
      transition:
        border-color 220ms ease,
        box-shadow 220ms ease,
        transform 220ms ease,
        background 220ms ease;
    }
    .lp-faq-item:hover,
    .lp-faq-item[open],
    .lp-faq-item.is-animating {
      border-color: rgba(217,48,37,0.22);
      background: #fff;
      box-shadow: 0 18px 42px rgba(23,32,51,0.1);
      transform: translateY(-1px);
    }
    .lp-faq-item summary {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      cursor: pointer;
      color: var(--ink);
      font-size: clamp(16px, 1.45vw, 19px);
      font-weight: 900;
      line-height: 1.28;
      list-style: none;
      min-height: 72px;
      padding: 20px 22px;
      outline: none;
    }
    .lp-faq-item summary::-webkit-details-marker { display: none; }
    .lp-faq-item summary:focus-visible {
      box-shadow: inset 0 0 0 3px rgba(217,48,37,0.16);
    }
    .lp-faq-item summary::after {
      content: "+";
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      flex: 0 0 auto;
      border: 1px solid rgba(217,48,37,0.18);
      border-radius: 999px;
      background: rgba(217,48,37,0.06);
      color: var(--brand);
      font-size: 22px;
      line-height: 1;
      transition:
        transform 240ms cubic-bezier(.22,1,.36,1),
        background 200ms ease,
        color 200ms ease,
        border-color 200ms ease;
    }
    .lp-faq-item[open] summary::after {
      background: var(--brand);
      border-color: var(--brand);
      color: #fff;
      transform: rotate(45deg);
    }
    .lp-faq-answer {
      color: var(--muted);
      font-size: clamp(15px, 1.2vw, 17px);
      line-height: 1.62;
      overflow: hidden;
    }
    .lp-faq-answer-inner {
      max-width: 760px;
      padding: 0 70px 22px 22px;
      opacity: 0;
      transform: translateY(-6px);
      transition:
        opacity 220ms ease,
        transform 260ms cubic-bezier(.22,1,.36,1);
    }
    .lp-faq-item[open] .lp-faq-answer-inner {
      opacity: 1;
      transform: translateY(0);
    }
    .lp-faq-cta {
      margin-top: 34px;
      text-align: center;
    }
    .lp-faq-cta button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 900;
      padding: 13px 26px;
      box-shadow: 0 14px 28px rgba(217,48,37,0.18);
    }
    .lp-faq-cta button:hover,
    .lp-faq-cta button:focus-visible {
      background: var(--brand-dark);
      outline: none;
    }
    .lp-signup-band {
      padding: 68px 0;
      background: #fff;
      border-top: 1px solid var(--line);
    }
    .lp-signup-band-inner {
      display: grid;
      grid-template-columns: minmax(260px, 0.85fr) minmax(320px, 1fr);
      gap: clamp(28px, 5vw, 64px);
      align-items: center;
    }
    .lp-signup-band-copy {
      text-align: left;
    }
    .lp-signup-band h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 900;
      line-height: 1.08;
    }
    .lp-signup-band p {
      max-width: 620px;
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.5;
    }
    .lp-signup-band-widget .lp-signup-card {
      position: static;
      max-width: 520px;
      margin-left: auto;
      backdrop-filter: none;
    }
    @keyframes faqReveal {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
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
    .lp-bottom-cta button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      margin-top: 26px;
      border: 0;
      border-radius: 999px;
      background: #fff;
      color: var(--brand);
      cursor: pointer;
      font: inherit;
      font-weight: 900;
      padding: 13px 28px;
    }
    .lp-footer {
      padding: 40px 24px 24px;
      background: #101828;
      color: rgba(255,255,255,0.4);
      text-align: center;
    }
    .lp-footer-inner {
      display: block;
      max-width: 800px;
      font-size: 13px;
      font-weight: 600;
    }
    .lp-footer-logo {
      width: auto;
      height: 24px;
      margin: 0 auto 16px;
      filter: brightness(0) invert(1);
      opacity: 0.6;
    }
    .lp-footer-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 20px;
      margin-bottom: 20px;
    }
    .lp-footer-links a {
      color: rgba(255,255,255,0.4);
      transition: color 180ms ease;
    }
    .lp-footer-links a:hover,
    .lp-footer-links a:focus-visible {
      color: rgba(255,255,255,0.7);
      outline: none;
    }
    .lp-footer-copy {
      margin: 0;
      color: rgba(255,255,255,0.25);
      font-size: 12px;
      font-weight: 500;
    }
    .lp-modal {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(16,24,40,0.58);
      padding: 24px;
    }
    .lp-modal.is-open {
      display: flex;
    }
    .lp-modal-panel {
      position: relative;
      width: min(520px, 100%);
      max-height: calc(100vh - 48px);
      overflow: auto;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 28px 80px rgba(0,0,0,0.32);
      padding: 24px;
    }
    .lp-modal-panel .lp-signup-card {
      position: static;
      border: 0;
      box-shadow: none;
      padding: 0;
      backdrop-filter: none;
    }
    .lp-modal-panel .lp-invite-strip {
      margin-top: 18px;
      background: var(--page);
    }
    .lp-modal-close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 38px;
      height: 38px;
      border: 1px solid rgba(23,32,51,0.14);
      border-radius: 50%;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font-size: 22px;
      line-height: 1;
    }
    .lp-image-modal {
      position: fixed;
      inset: 0;
      z-index: 70;
      display: none;
      grid-template-rows: auto 1fr auto;
      background: rgba(10,15,25,0.94);
      color: #fff;
    }
    .lp-image-modal.is-open {
      display: grid;
    }
    .lp-image-modal-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px clamp(14px, 3vw, 28px);
      background: rgba(10,15,25,0.88);
    }
    .lp-image-modal-title {
      margin: 0;
      font-size: 14px;
      font-weight: 900;
    }
    .lp-image-modal-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: space-between;
      padding: 14px clamp(14px, 3vw, 28px);
      background: rgba(10,15,25,0.88);
    }
    .lp-image-modal-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lp-image-modal-controls button,
    .lp-image-modal-bar button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 40px;
      min-height: 40px;
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 900;
      padding: 8px 13px;
    }
    .lp-image-modal-controls button:hover,
    .lp-image-modal-controls button:focus-visible,
    .lp-image-modal-bar button:hover,
    .lp-image-modal-bar button:focus-visible {
      background: rgba(255,255,255,0.16);
      outline: none;
    }
    .lp-image-modal-controls button:disabled {
      cursor: default;
      opacity: 0.36;
    }
    .lp-image-modal-controls [data-report-modal-signup] {
      border-color: var(--brand);
      background: var(--brand);
      color: #fff;
      box-shadow: 0 14px 28px rgba(217,48,37,0.22);
    }
    .lp-image-modal-controls [data-report-modal-signup]:hover,
    .lp-image-modal-controls [data-report-modal-signup]:focus-visible {
      background: var(--brand-dark);
    }
    .lp-image-modal-stage {
      overflow: auto;
      overscroll-behavior: contain;
      padding: 18px;
      text-align: center;
      touch-action: pinch-zoom;
      display: grid;
      place-items: center;
    }
    .lp-image-modal-stage img {
      display: inline-block;
      width: min(100%, 920px);
      max-width: 100%;
      max-height: 100%;
      height: auto;
      object-fit: contain;
      box-shadow: 0 24px 80px rgba(0,0,0,0.36);
    }
    @media (max-width: 980px) {
      .lp-hero-grid {
        display: block;
        padding-top: 42px;
      }
      .lp-signup-card {
        position: static;
        max-width: 540px;
        margin-top: 28px;
      }
      .lp-feature-row {
        grid-template-columns: 1fr;
      }
      .lp-walkthrough {
        --report-page-width: clamp(320px, min(40vw, calc((100vh - 250px) * 0.7727)), 460px);
        grid-template-columns: minmax(0, 1fr);
      }
      .lp-report-step { grid-template-columns: minmax(240px, 0.9fr) minmax(260px, 1fr); }
      .lp-testimonial-grid,
      .lp-report-types,
      .lp-pricing-grid {
        grid-template-columns: 1fr;
      }
      .lp-pricing-grid {
        max-width: 100%;
      }
      .lp-price-card {
        grid-template-columns: 108px minmax(0, 1fr) auto;
        grid-template-rows: auto auto;
        align-items: center;
        gap: 14px;
        padding: 12px;
      }
      .lp-price-card img {
        grid-row: 1 / 3;
        height: 108px;
        aspect-ratio: auto;
        border-radius: 6px;
      }
      .lp-price-body {
        padding: 0;
        text-align: left;
      }
      .lp-price {
        margin: 0;
        text-align: right;
      }
      .lp-price-action {
        grid-column: 2 / 4;
        justify-self: stretch;
        margin: 0;
      }
      .lp-custom-inner,
      .lp-trust-inner,
      .lp-signup-band-inner {
        grid-template-columns: 1fr;
      }
      .lp-signup-band-copy {
        text-align: center;
      }
      .lp-signup-band-copy p {
        margin-left: auto;
        margin-right: auto;
      }
      .lp-signup-band-widget .lp-signup-card {
        margin: 0 auto;
      }
      .lp-feature-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .lp-walkthrough.is-forward .lp-report-step.is-active .lp-report-page img,
      .lp-walkthrough.is-backward .lp-report-step.is-active .lp-report-page img,
      .lp-walkthrough.is-forward .lp-report-step.is-leaving .lp-report-page img,
      .lp-walkthrough.is-backward .lp-report-step.is-leaving .lp-report-page img,
      .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-kicker,
      .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy h3,
      .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-copy p,
      .lp-walkthrough.is-forward .lp-report-step.is-active .lp-step-points span,
      .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-kicker,
      .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy h3,
      .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-copy p,
      .lp-walkthrough.is-backward .lp-report-step.is-active .lp-step-points span,
      .lp-faq-item,
      .lp-faq-item summary::after,
      .lp-faq-answer-inner {
        animation: none;
        transition: none;
        filter: none;
        transform: none;
      }
    }
    @media (max-width: 640px) {
      body { padding-top: 76px; }
      .lp-container {
        width: calc(100vw - 28px);
        max-width: 1180px;
      }
      .lp-nav-inner { min-height: 76px; }
      .lp-logo img { width: 114px; }
      .lp-nav-links { gap: 0; }
      .lp-nav-links a { display: none; }
      .lp-login { display: none; }
      .lp-signup-link { padding: 10px 18px; }
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
      .lp-faq-list { gap: 10px; }
      .lp-faq-item { border-radius: 12px; }
      .lp-faq-item summary {
        min-height: 64px;
        gap: 12px;
        padding: 17px 16px;
        font-size: 15px;
      }
      .lp-faq-item summary::after {
        width: 30px;
        height: 30px;
        font-size: 20px;
      }
      .lp-faq-answer-inner {
        padding: 0 16px 18px;
        font-size: 14px;
      }
      #pricing .lp-section-head p:nth-of-type(2) {
        display: none;
      }
      .lp-report-section { padding: 0; }
      .lp-report-intro { padding: 26px 0 14px; }
      .lp-report-intro-inner { grid-template-columns: 1fr; gap: 12px; }
      .lp-report-heading {
        font-size: 31px;
        line-height: 1.02;
      }
      .lp-mobile-hide-word { display: none; }
      .lp-walkthrough {
        --report-page-width: min(calc((100vh - 290px) * 0.7727), calc(100vw - 40px));
        grid-template-columns: minmax(0, 1fr);
      }
      .lp-report-rail {
        display: none;
      }
      .lp-report-rail-inner {
        gap: 8px;
        padding: 4px 2px;
      }
      .lp-report-thumb {
        border-radius: 7px;
        padding: 4px;
      }
      .lp-report-step {
        grid-template-columns: 1fr;
        min-height: 0;
      }
      .lp-step-copy {
        display: grid;
        grid-template-columns: minmax(54px, auto) minmax(0, 1fr) minmax(54px, auto);
        grid-template-areas:
          "prev title next"
          "cta cta cta";
        column-gap: 6px;
        row-gap: 14px;
        border-left: 0;
        align-items: center;
        justify-content: start;
        order: 2;
        padding: 10px 18px 14px;
        text-align: center;
      }
      .lp-step-kicker,
      .lp-step-copy p,
      .lp-step-points {
        display: none;
      }
      .lp-step-copy h3 {
        grid-area: title;
        margin: 0;
        font-size: 24px;
        line-height: 1.12;
      }
      .lp-report-step:first-of-type .lp-step-copy h3 {
        max-width: none;
        font-size: 30px;
        line-height: 1.05;
      }
      .lp-report-text-controls {
        display: contents;
      }
      .lp-report-download-inline {
        align-self: center;
        min-height: 36px;
        padding: 8px 14px;
      }
      .lp-report-cta-row {
        grid-area: cta;
        justify-content: center;
        margin: 10px 0 8px;
      }
      .lp-report-start {
        min-height: 36px;
        padding: 8px 14px;
      }
      .lp-mobile-page-count {
        display: none;
        color: var(--ink);
        font-size: 13px;
        font-weight: 900;
        text-align: center;
      }
      .lp-report-jump {
        min-width: 54px;
        min-height: 40px;
        font-size: 12px;
        padding: 9px 8px;
      }
      .lp-report-jump[data-report-prev] {
        grid-area: prev;
      }
      .lp-report-jump[data-report-next] {
        grid-area: next;
      }
      .lp-desktop-button-word {
        display: none;
      }
      .lp-report-page {
        margin: 64px auto 30px;
        max-width: calc(100vw - 40px);
        order: 1;
      }
      .lp-page-hero,
      .lp-mini-grid {
        grid-template-columns: 1fr;
      }
      .lp-roof-diagram { min-height: 180px; }
      .lp-price-card {
        grid-template-columns: 78px minmax(0, 1fr) auto;
      }
      .lp-price-card img { height: 78px; }
      .lp-price-action {
        grid-column: 2 / -1;
        width: 100%;
      }
      .lp-custom-copy {
        order: 2;
      }
      .lp-custom-report {
        padding: 50px 0;
      }
      .lp-custom-report + .lp-custom-report {
        padding-top: 0;
      }
      .lp-custom-image {
        order: 1;
        max-width: 240px;
        margin: 0 auto;
      }
      .lp-feature-grid { grid-template-columns: 1fr; }
      .lp-image-modal-bar {
        padding: 12px 14px;
      }
      .lp-image-modal-controls {
        justify-content: space-between;
        padding: 12px 10px;
      }
      .lp-image-modal-stage img {
        width: auto;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 150px);
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
          <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/logo_red.png" alt="FirstMate">
        </a>
        <div class="lp-nav-links">
          <a href="#reports">Reports</a>
          <a href="#pricing">Pricing</a>
          <a href="#faqs">FAQs</a>
          <button class="lp-signup-link" type="button" data-open-signup>Sign up</button>
        </div>
      </div>
    </nav>

    <main>
      <section class="lp-section lp-report-section" id="reports">
        <div class="lp-walkthrough" data-report-carousel>
          <aside class="lp-report-rail" aria-label="Report page navigation">
            <div class="lp-report-rail-inner">
              <?php foreach ($reportPages as $index => $page): ?>
              <?php $thumbNumber = $index + 1; ?>
              <button
                class="lp-report-thumb<?= $index === 0 ? ' is-active' : '' ?>"
                type="button"
                data-report-thumb
                data-page-index="<?= $index ?>"
                aria-label="Show report page <?= $thumbNumber ?>"
                aria-current="<?= $index === 0 ? 'true' : 'false' ?>">
                <img
                  src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/report-page-<?= $thumbNumber ?>.webp"
                  alt=""
                  loading="eager"
                  decoding="async">
              </button>
              <?php endforeach; ?>
            </div>
          </aside>
            <?php foreach ($reportPages as $index => $page): ?>
            <?php $pageNumber = $index + 1; ?>
            <article class="lp-report-step<?= $index === 0 ? ' is-active' : '' ?>" data-report-step>
              <div class="lp-step-copy">
                <div class="lp-step-kicker"><?= htmlspecialchars($page['kicker'], ENT_QUOTES) ?></div>
                <h3><?= htmlspecialchars($page['title'], ENT_QUOTES) ?></h3>
                <p><?= htmlspecialchars($page['copy'], ENT_QUOTES) ?></p>
                <div class="lp-report-text-controls" aria-label="Report page controls">
                  <button class="lp-report-jump" type="button" data-report-prev aria-label="Previous report page">Back</button>
                  <span class="lp-mobile-page-count">Page <?= $pageNumber ?> of <?= count($reportPages) ?></span>
                  <button class="lp-report-jump" type="button" data-report-next aria-label="Next report page">Next <span class="lp-desktop-button-word">Page</span></button>
                </div>
                <div class="lp-report-cta-row">
                  <a class="lp-report-download lp-report-download-inline" href="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/sample-roof-measurement-report.pdf" download>Download Sample PDF</a>
                  <button class="lp-report-start" type="button" data-open-signup>Get Started</button>
                </div>
                <?php if (!empty($page['points'])): ?>
                <div class="lp-step-points">
                  <?php foreach ($page['points'] as $point): ?>
                  <span><?= htmlspecialchars($point, ENT_QUOTES) ?></span>
                  <?php endforeach; ?>
                </div>
                <?php endif; ?>
              </div>
              <figure class="lp-report-page" data-expand-report-page tabindex="0" role="button" aria-label="Expand report page <?= $pageNumber ?>">
                <span class="lp-report-expand-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M8 3H3v5"></path>
                    <path d="M3 3l7 7"></path>
                    <path d="M16 21h5v-5"></path>
                    <path d="M21 21l-7-7"></path>
                  </svg>
                </span>
                <img
                  src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/report-page-<?= $pageNumber ?>.webp"
                  alt="Sample FirstMeasure report page <?= $pageNumber ?>"
                  loading="<?= $pageNumber === 1 ? 'eager' : 'lazy' ?>"
                  decoding="async">
              </figure>
            </article>
            <?php endforeach; ?>
        </div>
      </section>

      <section class="lp-section" id="pricing">
        <div class="lp-container">
          <div class="lp-section-head">
            <h2>How are full reports only $7?</h2>
            <p>Our AI-powered measurement platform helps our technicians produce reports faster and more efficiently, so we can pass the savings on to you.</p>
            <p>Every report still goes through a multi-step quality control process before delivery to ensure accuracy and completeness.</p>
          </div>
          <div class="lp-pricing-grid">
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/card_residential.jpg" alt="Residential property">
              <div class="lp-price-body">
                <h3>Residential</h3>
                <div class="lp-time">Most reports delivered in 4 hours or less</div>
              </div>
              <div class="lp-price">$7</div>
              <button class="lp-price-action" type="button" data-open-signup>Order</button>
            </article>
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/card_multifamily.jpg" alt="Multi-family property">
              <div class="lp-price-body">
                <h3>Multi-Family</h3>
                <div class="lp-time">Most reports delivered in 6 hours or less</div>
              </div>
              <div class="lp-price">$12 <span>/building</span></div>
              <button class="lp-price-action" type="button" data-open-signup>Order</button>
            </article>
            <article class="lp-price-card">
              <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/card_commercial.jpg" alt="Commercial property">
              <div class="lp-price-body">
                <h3>Commercial</h3>
                <div class="lp-time">Most reports delivered in 6 hours or less</div>
              </div>
              <div class="lp-price">$12 <span>/building</span></div>
              <button class="lp-price-action" type="button" data-open-signup>Order</button>
            </article>
          </div>
          <p class="lp-expedite">Need it faster? Guaranteed 1-2 hour expedite is available for all report types.</p>
        </div>
      </section>

      <section class="lp-section lp-custom-report">
        <div class="lp-container">
          <div class="lp-custom-inner">
            <div class="lp-custom-image is-report-preview">
              <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/sample-customer-report.png" alt="Sample custom branded customer report" loading="lazy">
            </div>
            <div class="lp-custom-copy">
              <div class="lp-section-kicker">Your brand, your way</div>
              <h2>Fully customizable branded reports.</h2>
              <div class="lp-custom-list">
                <span>Add your company logo</span>
                <span>Set your brand colors</span>
                <span>Choose which details your customer sees.</span>
              </div>
              <button class="lp-custom-cta" type="button" data-open-signup>Configure your custom report</button>
            </div>
          </div>
        </div>
      </section>

      <section class="lp-section lp-custom-report">
        <div class="lp-container">
          <div class="lp-custom-inner">
            <div class="lp-custom-copy">
              <div class="lp-section-kicker">Gutter reports <span class="lp-beta-pill">Beta</span></div>
              <h2>Streamline Gutter Projects</h2>
              <p class="lp-addon-subline">Add gutters to any roof report for just $2.</p>
              <div class="lp-custom-list">
                <span>Gutter lengths</span>
                <span>Downspout lengths</span>
                <span>Mitered corner counts and a clear install diagram.</span>
              </div>
              <button class="lp-custom-cta" type="button" data-open-signup>Order Now</button>
            </div>
            <div class="lp-custom-image is-gutter">
              <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/gutter-report-page-12.webp" alt="Sample gutter report page with gutter lengths and corner counts" loading="lazy">
            </div>
          </div>
        </div>
      </section>

      <section class="lp-section lp-trust-section">
        <div class="lp-container lp-trust-inner">
          <div class="lp-trust-copy">
            <h2>Trusted by 1000s of Roofing Professionals</h2>
            <p>Thousands of roofers use FirstMeasure reports to estimate faster, order more accurately, and improve their sales process.</p>
            <p>Hear how <span>Brenda</span>, Office Manager at <span>Roof Medic</span> in Washington, uses FirstMeasure roof reports.</p>
          </div>
          <div class="lp-trust-video">
            <div class="lp-trust-video-frame">
              <wistia-player media-id="eco5tm13ug" aspect="1.7777777777777777"></wistia-player>
            </div>
          </div>
          <h3 class="lp-trust-endorsement">FirstMeasure reports are approved and endorsed by the NRCIA</h3>
        </div>
      </section>

      <section class="lp-signup-band" id="signup" data-signup-section>
        <div class="lp-container lp-signup-band-inner">
          <div class="lp-signup-band-copy">
            <h2>Sign Up For Your Free Account</h2>
            <p>Create your account and start ordering accurate roof measurement reports in minutes.</p>
          </div>
          <div class="lp-signup-band-widget">
            <aside class="lp-signup-card" aria-label="Create your FirstMate account">
              <h2>Create your account.</h2>
              <p><?= $isReferralLanding ? 'Create your free account now.' : 'Create your free account now.' ?></p>
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
                data-submit-label="Create Account"
                data-title="Create your FirstMate account"></div>
            </aside>
          </div>
        </div>
      </section>

      <section class="lp-section alt" id="faqs">
        <div class="lp-container">
          <div class="lp-section-head">
            <h2>Frequently asked questions</h2>
          </div>
          <div class="lp-faq-list">
            <?php foreach ($faqs as $index => $faq): ?>
            <details class="lp-faq-item"<?= $index === 0 ? ' open' : '' ?>>
              <summary><?= htmlspecialchars($faq['question'], ENT_QUOTES) ?></summary>
              <div class="lp-faq-answer">
                <div class="lp-faq-answer-inner"><?= htmlspecialchars($faq['answer'], ENT_QUOTES) ?></div>
              </div>
            </details>
            <?php endforeach; ?>
          </div>
          <div class="lp-faq-cta">
            <button type="button" data-open-signup>Create Account</button>
          </div>
        </div>
      </section>

    </main>

    <footer class="lp-footer">
      <div class="lp-container lp-footer-inner">
        <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/logo_red.png" alt="First Meat" class="lp-footer-logo">
        <div class="lp-footer-links">
          <a href="https://www.1m8.ai">Home</a>
          <a href="https://www.1m8.ai/measurements">Measurements</a>
          <a href="https://www.1m8.ai/platform">Platform</a>
          <a href="https://www.1m8.ai/privacy">Privacy Policy</a>
          <a href="https://www.1m8.ai/terms">Terms of Service</a>
        </div>
        <p class="lp-footer-copy">&copy; 2026 First Mate. All rights reserved.</p>
      </div>
    </footer>
  </div>

  <div class="lp-modal" data-signup-modal aria-hidden="true">
    <div class="lp-modal-panel" role="dialog" aria-modal="true" aria-labelledby="signup-modal-title">
      <button class="lp-modal-close" type="button" data-close-signup aria-label="Close signup modal">&times;</button>
      <aside class="lp-signup-card" aria-label="Create your FirstMate account">
        <h2 id="signup-modal-title">Order your first report today.</h2>
        <p><?= $isReferralLanding ? 'Create your account now to order your first report.' : 'Create your account now. Referral offers and tracking are applied automatically from this link.' ?></p>
        <?php if ($isReferralLanding): ?>
        <div class="lp-invite-strip" data-customer-invite>
          <div class="lp-invite-avatar" data-ref-avatar>F</div>
          <div class="lp-invite-copy">
            <strong data-ref-title><?= $isPartnerReferralLanding ? 'You were invited to FirstMeasure.' : 'You were invited to FirstMate.' ?></strong>
            <span data-ref-copy>Create your account below to start ordering reports.</span>
          </div>
        </div>
        <?php endif; ?>
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
          data-submit-label="Start Ordering Reports"
          data-title="Create your FirstMate account"></div>
      </aside>
    </div>
  </div>

  <div class="lp-image-modal" data-report-image-modal aria-hidden="true">
    <div class="lp-image-modal-bar">
      <p class="lp-image-modal-title" data-report-image-title>Sample report page</p>
      <button type="button" data-close-report-image aria-label="Close expanded report page">Close</button>
    </div>
    <div class="lp-image-modal-stage" data-report-image-stage>
      <img src="" alt="" data-report-image>
    </div>
    <div class="lp-image-modal-controls" aria-label="Expanded report controls">
      <div class="lp-image-modal-actions">
        <button type="button" data-report-modal-prev>Back</button>
        <button type="button" data-report-modal-next>Next</button>
      </div>
      <div class="lp-image-modal-actions">
        <button type="button" data-report-modal-signup>Sign up</button>
      </div>
    </div>
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
  <script>
    (function(){
      const faqItems = Array.from(document.querySelectorAll('.lp-faq-item'));
      if (!faqItems.length) return;

      faqItems.forEach((item) => {
        const summary = item.querySelector('summary');
        const answer = item.querySelector('.lp-faq-answer');
        if (!summary || !answer || !answer.animate) return;
        let animation = null;

        summary.addEventListener('click', (event) => {
          event.preventDefault();
          if (animation) animation.cancel();

          const isOpen = item.open;
          const startHeight = answer.offsetHeight;
          item.classList.add('is-animating');

          if (!isOpen) {
            item.open = true;
          }

          const endHeight = isOpen ? 0 : answer.scrollHeight;
          animation = answer.animate(
            [
              { height: `${startHeight}px`, opacity: isOpen ? 1 : 0.55 },
              { height: `${endHeight}px`, opacity: isOpen ? 0.55 : 1 }
            ],
            {
              duration: 260,
              easing: 'cubic-bezier(.22,1,.36,1)'
            }
          );

          animation.onfinish = () => {
            if (isOpen) item.open = false;
            answer.style.height = '';
            item.classList.remove('is-animating');
            animation = null;
          };
          animation.oncancel = () => {
            answer.style.height = '';
            item.classList.remove('is-animating');
            animation = null;
          };
        });
      });
    })();
  </script>
  <script>
    (function(){
      const modal = document.querySelector('[data-signup-modal]');
      if (!modal) return;

      const openButtons = Array.from(document.querySelectorAll('[data-open-signup]'));
      const closeButton = modal.querySelector('[data-close-signup]');
      const mobileSignupQuery = window.matchMedia('(max-width: 640px)');

      function scrollToSignupSection() {
        const signupSection = document.querySelector('[data-signup-section]');
        if (!signupSection) return false;
        signupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }

      function openModal() {
        if (mobileSignupQuery.matches && scrollToSignupSection()) return;
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (closeButton) closeButton.focus();
      }

      function closeModal() {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }

      openButtons.forEach(button => button.addEventListener('click', openModal));
      if (closeButton) closeButton.addEventListener('click', closeModal);
      modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
      });
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
      });
    })();
  </script>
  <script>
    (function(){
      const modal = document.querySelector('[data-report-image-modal]');
      if (!modal) return;

      const image = modal.querySelector('[data-report-image]');
      const title = modal.querySelector('[data-report-image-title]');
      const stage = modal.querySelector('[data-report-image-stage]');
      const closeButtons = Array.from(modal.querySelectorAll('[data-close-report-image]'));
      const openButtons = Array.from(document.querySelectorAll('[data-expand-report-page]'));
      const modalPrevious = modal.querySelector('[data-report-modal-prev]');
      const modalNext = modal.querySelector('[data-report-modal-next]');
      const modalSignup = modal.querySelector('[data-report-modal-signup]');
      const steps = Array.from(document.querySelectorAll('[data-report-step]'));
      const desktopImageModalQuery = window.matchMedia('(min-width: 641px)');
      let modalIndex = 0;
      let swipeStartX = null;
      let swipeStartY = null;

      function updateModalPage(index) {
        modalIndex = Math.max(0, Math.min(steps.length - 1, index));
        const step = steps[modalIndex];
        const source = step && step.querySelector('.lp-report-page img');
        if (!source) return;
        image.src = source.currentSrc || source.src;
        image.alt = source.alt || 'Expanded sample report page';
        const pageTitle = step.querySelector('.lp-step-copy h3')?.textContent.trim() || 'Sample report page';
        title.textContent = `Page ${modalIndex + 1} of ${steps.length}: ${pageTitle}`;
        if (stage) {
          stage.scrollTop = 0;
          stage.scrollLeft = 0;
        }
        if (modalPrevious) modalPrevious.disabled = modalIndex === 0;
        if (modalNext) modalNext.disabled = modalIndex === steps.length - 1;
      }

      function openModal(trigger) {
        const step = trigger.closest('[data-report-step]');
        const index = Math.max(0, steps.indexOf(step));
        updateModalPage(index);
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        closeButtons[0]?.focus();
      }

      function closeModal() {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        image.removeAttribute('src');
      }

      openButtons.forEach(button => {
        button.addEventListener('click', () => openModal(button));
        button.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openModal(button);
        });
      });
      closeButtons.forEach(button => button.addEventListener('click', closeModal));
      modal.addEventListener('click', event => {
        if (!desktopImageModalQuery.matches) return;
        if (event.target === modal || event.target === stage) closeModal();
      });
      modalPrevious?.addEventListener('click', () => updateModalPage(modalIndex - 1));
      modalNext?.addEventListener('click', () => updateModalPage(modalIndex + 1));
      modalSignup?.addEventListener('click', () => {
        closeModal();
        document.querySelector('.lp-signup-link')?.click();
      });
      stage?.addEventListener('touchstart', event => {
        if (!event.touches || event.touches.length !== 1) return;
        swipeStartX = event.touches[0].clientX;
        swipeStartY = event.touches[0].clientY;
      }, { passive: true });
      stage?.addEventListener('touchend', event => {
        if (swipeStartX === null || swipeStartY === null || !event.changedTouches || !event.changedTouches.length) return;
        const deltaX = event.changedTouches[0].clientX - swipeStartX;
        const deltaY = event.changedTouches[0].clientY - swipeStartY;
        swipeStartX = null;
        swipeStartY = null;
        if (Math.abs(deltaX) < 54 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
        updateModalPage(modalIndex + (deltaX < 0 ? 1 : -1));
      }, { passive: true });
      window.addEventListener('keydown', event => {
        if (!modal.classList.contains('is-open')) return;
        if (event.key === 'Escape') closeModal();
        if (event.key === 'ArrowLeft') updateModalPage(modalIndex - 1);
        if (event.key === 'ArrowRight') updateModalPage(modalIndex + 1);
      });
    })();
  </script>
  <script>
    (function(){
      const carousel = document.querySelector('[data-report-carousel]');
      if (!carousel) return;

      const steps = Array.from(carousel.querySelectorAll('[data-report-step]'));
      const thumbs = Array.from(carousel.querySelectorAll('[data-report-thumb]'));
      const previousButtons = Array.from(carousel.querySelectorAll('[data-report-prev]'));
      const nextButtons = Array.from(carousel.querySelectorAll('[data-report-next]'));
      if (!steps.length) return;

      let activeIndex = 0;
      let lockedUntil = 0;
      let touchStartY = null;
      let transitionReset = null;
      let leavingReset = null;
      let imageSwipeStartX = null;
      let imageSwipeStartY = null;
      let suppressExpandClickUntil = 0;

      function isInFlipZone() {
        const activeStep = steps[activeIndex];
        const viewer = activeStep && activeStep.querySelector('.lp-report-page');
        if (!viewer) return false;
        const rect = viewer.getBoundingClientRect();
        const margin = window.innerHeight < 760 ? 8 : 24;
        return rect.top >= margin && rect.bottom <= window.innerHeight - margin;
      }

      function updateThumbs() {
        thumbs.forEach((thumb, index) => {
          const isActive = index === activeIndex;
          thumb.classList.toggle('is-active', isActive);
          thumb.setAttribute('aria-current', isActive ? 'true' : 'false');
          if (isActive) {
            const rail = thumb.closest('.lp-report-rail-inner');
            if (rail) {
              const thumbLeft = thumb.offsetLeft;
              const thumbRight = thumbLeft + thumb.offsetWidth;
              const viewLeft = rail.scrollLeft;
              const viewRight = viewLeft + rail.clientWidth;
              if (thumbLeft < viewLeft) {
                rail.scrollTo({ left: thumbLeft, behavior: 'smooth' });
              } else if (thumbRight > viewRight) {
                rail.scrollTo({ left: thumbRight - rail.clientWidth, behavior: 'smooth' });
              }
            }
          }
        });
        previousButtons.forEach(button => {
          button.disabled = activeIndex === 0;
        });
        nextButtons.forEach(button => {
          button.disabled = activeIndex === steps.length - 1;
        });
      }

      function setTransitionDirection(direction) {
        carousel.classList.remove('is-forward', 'is-backward');
        carousel.classList.add(direction >= 0 ? 'is-forward' : 'is-backward');
        if (transitionReset) window.clearTimeout(transitionReset);
        transitionReset = window.setTimeout(() => {
          carousel.classList.remove('is-forward', 'is-backward');
        }, 760);
      }

      function restoreScrollPosition(scrollLeft, scrollTop) {
        const root = document.documentElement;
        const previousBehavior = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        const restore = () => window.scrollTo(scrollLeft, scrollTop);
        restore();
        window.requestAnimationFrame(restore);
        window.setTimeout(restore, 80);
        window.setTimeout(restore, 220);
        window.setTimeout(() => {
          restore();
          root.style.scrollBehavior = previousBehavior;
        }, 520);
      }

      function updateReportPage(nextIndex, direction) {
        const bounded = Math.max(0, Math.min(steps.length - 1, nextIndex));
        if (bounded === activeIndex) return false;

        const scrollLeft = window.scrollX;
        const scrollTop = window.scrollY;
        const previousStep = steps[activeIndex];
        setTransitionDirection(direction || bounded - activeIndex);
        if (leavingReset) window.clearTimeout(leavingReset);
        steps.forEach(step => step.classList.remove('is-leaving'));
        previousStep.classList.remove('is-active');
        previousStep.classList.add('is-leaving');
        activeIndex = bounded;
        steps[activeIndex].classList.add('is-active');
        updateThumbs();
        restoreScrollPosition(scrollLeft, scrollTop);
        leavingReset = window.setTimeout(() => {
          previousStep.classList.remove('is-leaving');
        }, 620);

        return true;
      }

      function canFlip(deltaY) {
        if (!isInFlipZone()) return false;
        if (deltaY > 0 && activeIndex < steps.length - 1) return true;
        if (deltaY < 0 && activeIndex > 0) return true;
        return false;
      }

      function flipByDelta(deltaY) {
        const now = Date.now();
        if (now < lockedUntil || !canFlip(deltaY)) return false;
        const direction = deltaY > 0 ? 1 : -1;
        const changed = updateReportPage(activeIndex + direction, direction);
        if (changed) lockedUntil = now + 660;
        return changed;
      }

      window.addEventListener('keydown', event => {
        const keys = ['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'];
        if (!keys.includes(event.key)) return;
        const deltaY = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
        if (flipByDelta(deltaY)) {
          event.preventDefault();
        }
      });

      thumbs.forEach(thumb => {
        thumb.addEventListener('click', () => {
          thumb.blur();
          const index = Number(thumb.getAttribute('data-page-index'));
          if (Number.isNaN(index)) return;
          const direction = index > activeIndex ? 1 : -1;
          updateReportPage(index, direction);
          lockedUntil = Date.now() + 520;
        });
      });

      previousButtons.forEach(button => {
        button.addEventListener('click', () => {
          button.blur();
          updateReportPage(activeIndex - 1, -1);
          lockedUntil = Date.now() + 520;
        });
      });
      nextButtons.forEach(button => {
        button.addEventListener('click', () => {
          button.blur();
          updateReportPage(activeIndex + 1, 1);
          lockedUntil = Date.now() + 520;
        });
      });

      steps.forEach(step => {
        const reportPage = step.querySelector('.lp-report-page');
        if (!reportPage) return;

        reportPage.addEventListener('click', event => {
          if (Date.now() < suppressExpandClickUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);

        reportPage.addEventListener('touchstart', event => {
          if (!event.touches || event.touches.length !== 1) return;
          imageSwipeStartX = event.touches[0].clientX;
          imageSwipeStartY = event.touches[0].clientY;
        }, { passive: true });

        reportPage.addEventListener('touchend', event => {
          if (imageSwipeStartX === null || imageSwipeStartY === null || !event.changedTouches || !event.changedTouches.length) return;
          const deltaX = event.changedTouches[0].clientX - imageSwipeStartX;
          const deltaY = event.changedTouches[0].clientY - imageSwipeStartY;
          imageSwipeStartX = null;
          imageSwipeStartY = null;
          if (Math.abs(deltaX) < 54 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;

          const direction = deltaX < 0 ? 1 : -1;
          if (updateReportPage(activeIndex + direction, direction)) {
            suppressExpandClickUntil = Date.now() + 450;
            lockedUntil = Date.now() + 520;
            event.preventDefault();
          }
        }, { passive: false });
      });

      updateThumbs();
    })();
  </script>
  <script>
    (function(){
      let loaded = false;

      function loadWistia() {
        if (loaded) return;
        loaded = true;

        const playerScript = document.createElement('script');
        playerScript.src = 'https://fast.wistia.com/player.js';
        playerScript.async = true;
        document.head.appendChild(playerScript);

        const mediaScript = document.createElement('script');
        mediaScript.src = 'https://fast.wistia.com/embed/eco5tm13ug.js';
        mediaScript.async = true;
        mediaScript.type = 'module';
        document.head.appendChild(mediaScript);
      }

      const targets = document.querySelectorAll('wistia-player');
      if (!targets.length) return;

      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              loadWistia();
              observer.disconnect();
            }
          });
        }, { rootMargin: '400px' });

        targets.forEach(target => observer.observe(target));
      } else {
        loadWistia();
      }
    })();
  </script>
  <script src="<?= htmlspecialchars($signupScript, ENT_QUOTES) ?>"></script>
</body>
</html>