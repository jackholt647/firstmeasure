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
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Create Your FirstMate Account</title>
  <meta name="description" content="Create your FirstMate account to start ordering roof measurement reports.">
  <link rel="stylesheet" href="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/fonts.css">
  <style>
    :root {
      --brand: #d93025;
      --brand-dark: #a82018;
      --ink: #172033;
      --muted: #667085;
      --line: rgba(23, 32, 51, 0.12);
      --page: #f4f6f8;
      --panel: #ffffff;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      min-height: 100%;
    }

    body {
      margin: 0;
      background:
        linear-gradient(180deg, rgba(244, 246, 248, 0.86), rgba(244, 246, 248, 0.96)),
        url("<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/neighborhood_header.png") center / cover no-repeat fixed;
      color: var(--ink);
      font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;
    }

    a {
      color: inherit;
    }

    .signup-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
    }

    .signup-card {
      width: min(100%, 460px);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 24px 70px rgba(23, 32, 51, 0.16);
      padding: clamp(20px, 4vw, 30px);
      backdrop-filter: blur(16px);
    }

    .signup-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      margin-bottom: 22px;
    }

    .signup-logo img {
      display: block;
      width: 138px;
      height: auto;
    }

    .signup-card h1 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(28px, 7vw, 38px);
      font-weight: 900;
      line-height: 1.04;
      letter-spacing: 0;
    }

    .signup-card > p {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
      line-height: 1.45;
    }

    .invite-strip {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-top: 18px;
      border: 1px solid rgba(23, 32, 51, 0.12);
      border-radius: 10px;
      background: #fff;
      padding: 14px;
    }

    .invite-avatar {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      background: var(--brand);
      color: #fff;
      font-size: 21px;
      font-weight: 900;
      overflow: hidden;
    }

    .invite-avatar img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .invite-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .invite-copy strong {
      color: var(--ink);
      font-size: 15px;
      font-weight: 900;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .invite-copy span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      line-height: 1.35;
    }

    .signup-widget {
      margin-top: 20px;
    }

    .signup-login {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.4;
      text-align: center;
    }

    .signup-login a {
      color: var(--brand-dark);
      font-weight: 900;
      text-decoration: none;
    }

    .signup-login a:hover,
    .signup-login a:focus-visible {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main class="signup-page">
    <section class="signup-card" aria-label="Create your FirstMate account">
      <a class="signup-logo" href="https://1m8.ai/" aria-label="FirstMate home">
        <img src="<?= htmlspecialchars($mediaBase, ENT_QUOTES) ?>/logo_red.png" alt="FirstMate">
      </a>

      <h1>Create your account.</h1>
      <p>Create your free account and start ordering roof measurement reports in minutes.</p>

      <?php if ($isReferralLanding): ?>
      <div class="invite-strip" data-customer-invite>
        <div class="invite-avatar" data-ref-avatar>F</div>
        <div class="invite-copy">
          <strong data-ref-title><?= $isPartnerReferralLanding ? 'You were invited to FirstMeasure.' : 'You were invited to FirstMate.' ?></strong>
          <span data-ref-copy>Create your account below to start ordering reports.</span>
        </div>
      </div>
      <?php endif; ?>

      <div class="signup-widget"
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

          </section>
  </main>

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
