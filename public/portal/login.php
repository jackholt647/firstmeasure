<?php
$initialReferralCode = strtoupper(trim((string)($_GET['ref'] ?? '')));
$hasReferralInvite = $initialReferralCode !== '';
$loginBillboardFile = basename((string)(defined('LOGIN_MARKETING_BILLBOARD_FILE') ? LOGIN_MARKETING_BILLBOARD_FILE : 'login_billboard.php'));
$loginBannerFile = basename((string)(defined('LOGIN_MARKETING_BANNER_FILE') ? LOGIN_MARKETING_BANNER_FILE : 'login_banner.php'));
$loginBillboardPath = __DIR__ . '/marketing/' . $loginBillboardFile;
$loginBannerPath = __DIR__ . '/marketing/' . $loginBannerFile;
$loginBillboardSrc = 'marketing/' . $loginBillboardFile;
$loginBannerSrc = 'marketing/' . $loginBannerFile;
$showLoginBillboard = !$hasReferralInvite && is_file($loginBillboardPath);
$showLoginBanner = !$hasReferralInvite && is_file($loginBannerPath);
$hasLoginMarketing = $showLoginBillboard || $showLoginBanner;
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#d93025">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="application-name" content="FirstMate">
    <title>FirstMate - Login</title>
    <link rel="manifest" href="/portal/manifest.webmanifest">
    <link rel="icon" type="image/png" href="/images/icon.png">
    <link rel="apple-touch-icon" href="/images/icon.png">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <style>
        body {
            font-family: 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            display: flex; align-items: center; justify-content: center;
            height: 100vh; margin: 0;
        }
        body.referral-active {
            background:
                radial-gradient(circle at top left, rgba(217,48,37,0.14), transparent 34%),
                radial-gradient(circle at bottom right, rgba(22,163,74,0.10), transparent 30%),
                linear-gradient(135deg, #f8efe8 0%, #f5f7fb 46%, #eef3f8 100%);
        }
        .container {
            background: white; width: 400px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            overflow: hidden; position: relative;
            max-width: 90vw;
        }
        .login-shell {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            box-sizing: border-box;
        }
        .login-shell.has-login-billboard {
            width: min(1180px, calc(100% - 48px));
            display: grid;
            grid-template-columns: minmax(420px, 1fr) 400px;
            gap: 28px;
            padding: 0;
        }
        .login-shell.has-login-billboard .container:not(.referral-mode) {
            width: 400px;
            max-width: 100%;
        }
        .login-marketing-billboard,
        .login-marketing-banner {
            width: 100%;
            border: 0;
            background: #fff;
            box-shadow: 0 18px 45px rgba(17, 24, 39, 0.12);
            overflow: hidden;
        }
        .login-marketing-billboard {
            display: block;
            aspect-ratio: 16 / 10;
            border-radius: 18px;
        }
        .login-marketing-banner {
            display: none;
            aspect-ratio: 4 / 1;
            border-radius: 16px;
        }
        .container.referral-mode {
            width: min(1120px, 96vw);
            max-width: 96vw;
            border-radius: 28px;
            display: grid;
            grid-template-columns: minmax(0, 1.08fr) minmax(420px, 0.92fr);
            grid-template-areas:
                "header header"
                "hero auth";
            box-shadow: 0 30px 90px rgba(15, 23, 42, 0.16);
            border: 1px solid rgba(255,255,255,0.55);
            background:
                linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.96));
        }
        .header {
            background: #d93025; color: white; padding: 25px; text-align: center;
        }
        .container.referral-mode .header {
            grid-area: header;
            padding: 18px 28px;
            text-align: left;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 20px;
            background: linear-gradient(90deg, #b1241c 0%, #d93025 38%, #ef5a4f 100%);
            border-bottom: 1px solid rgba(255,255,255,0.18);
        }
        .header-offer-note {
            display: none;
        }
        .container.referral-mode .header-offer-note {
            display: block;
            font-size: 38px;
            line-height: 1.2;
            font-weight: 800;
            color: rgba(255,255,255,0.94);
            text-align: right;
            white-space: nowrap;
        }
        .header-offer-note span {
            display: inline;
        }
        .auth-pane {
            display: block;
        }
        .container.referral-mode .auth-pane {
            grid-area: auth;
            display: flex;
            flex-direction: column;
            background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
            min-height: 640px;
        }
        .referral-hero {
            display:none; gap:18px; align-items:center; padding:22px 24px;
            border-bottom:1px solid #eee; background:linear-gradient(180deg, #fff7f6 0%, #fff 100%);
        }
        .referral-hero.active { display:flex; }
        .container.referral-mode .referral-hero {
            grid-area: hero;
            display: none;
            flex-direction: column;
            justify-content: center;
            align-items: stretch;
            gap: 24px;
            padding: 42px 42px 38px;
            border-bottom: none;
            border-right: 1px solid rgba(217,48,37,0.08);
            background:
                radial-gradient(circle at top right, rgba(255,255,255,0.52), transparent 34%),
                linear-gradient(155deg, #8f1d18 0%, #c52a21 42%, #e45147 100%);
            color: white;
            min-height: 640px;
            position: relative;
            overflow: hidden;
        }
        .container.referral-mode .referral-hero.active {
            display: flex;
        }
        .referral-hero.loading .referral-logo {
            background: rgba(255,255,255,0.12);
            border-color: rgba(255,255,255,0.18);
        }
        .referral-hero.loading .referral-logo .fallback {
            color: rgba(255,255,255,0.88);
            animation: referralPulse 1.2s ease-in-out infinite;
        }
        body.referral-pending #referralOffer {
            display: none !important;
        }
        body.referral-pending .referral-mobile-continue {
            display: none !important;
        }
        body.referral-pending .container.referral-mode .form-area,
        body.referral-pending .referral-offer.active {
            position: relative;
            overflow: hidden;
        }
        body.referral-pending .container.referral-mode .form-area::after,
        body.referral-pending .referral-offer.active::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.14) 45%, rgba(255,255,255,0) 100%);
            transform: translateX(-100%);
            animation: referralSheen 1.3s linear infinite;
            pointer-events: none;
        }
        @keyframes referralPulse {
            0%, 100% { opacity: 0.58; transform: scale(0.96); }
            50% { opacity: 1; transform: scale(1); }
        }
        @keyframes referralSheen {
            from { transform: translateX(-100%); }
            to { transform: translateX(100%); }
        }
        .container.referral-mode .referral-hero::before {
            content: '';
            position: absolute;
            inset: auto -120px -140px auto;
            width: 360px;
            height: 360px;
            border-radius: 50%;
            background: rgba(255,255,255,0.08);
            pointer-events: none;
        }
        .container.referral-mode .referral-hero::after {
            content: '';
            position: absolute;
            inset: 34px auto auto -58px;
            width: 180px;
            height: 180px;
            border-radius: 34px;
            background: rgba(255,255,255,0.06);
            transform: rotate(22deg);
            pointer-events: none;
        }
        .referral-top {
            position: relative;
            z-index: 1;
            display: grid;
            gap: 18px;
        }
        .referral-logo {
            width:96px; height:96px; border-radius:24px; background:#fff; border:1px solid #f0d7d4;
            box-shadow:0 8px 20px rgba(0,0,0,0.08); display:flex; align-items:center; justify-content:center;
            overflow:hidden; flex-shrink:0; padding:10px; box-sizing:border-box;
        }
        .container.referral-mode .referral-logo {
            width: 292px;
            height: 292px;
            border-radius: 48px;
            border: 1px solid rgba(255,255,255,0.24);
            box-shadow: 0 18px 34px rgba(0,0,0,0.22);
        }
        .referral-logo img { width:100%; height:100%; object-fit:contain; }
        .referral-logo .fallback {
            font-size:34px; font-weight:900; color:#d93025;
        }
        .referral-brand {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 24px;
        }
        .referral-copy { display:grid; gap:14px; width: 100%; }
        .referral-copy h2 {
            margin:0; font-size:28px; line-height:1.1; color:#111827; font-weight:900;
        }
        .container.referral-mode .referral-copy h2 {
            font-family: 'Montserrat', 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            font-size: 50px;
            line-height: 1.02;
            max-width: none;
            width: 100%;
        }
        .referral-headline-loading {
            font-size: 34px;
            line-height: 1.08;
        }
        .referral-copy p {
            margin:0; color:#4b5563; font-size:14px; line-height:1.5; font-weight:600;
        }
        .container.referral-mode .referral-copy p {
            color: rgba(255,255,255,0.84);
            font-size: 24px;
            line-height: 1.2;
            font-weight: 700;
            max-width: none;
        }
        .referral-offer {
            display:none; margin-top:8px; padding:12px 14px; border-radius:14px;
            background:#fff; border:1px solid #f2d4cf;
        }
        .referral-offer.active { display:block; }
        .referral-offer strong { display:block; font-size:14px; color:#8a1c14; margin:0; }
        .referral-offer span { display:none; }
        .referral-mobile-continue {
            display: none;
        }
        .container.referral-mode .referral-offer {
            margin-top: 10px;
            padding: 20px 20px 18px;
            border-radius: 18px;
            background: rgba(255,255,255,0.14);
            border: 1px solid rgba(255,255,255,0.18);
            backdrop-filter: blur(10px);
        }
        .container.referral-mode .referral-offer strong {
            font-size: 26px;
            line-height: 1.18;
            color: #fff;
        }
        .tabs { display: flex; border-bottom: 1px solid #eee; }
        .tab {
            flex: 1; padding: 15px; text-align: center; cursor: pointer;
            background: #f8f9fa; font-weight: 600; color: #5f6368; transition: 0.2s;
        }
        .tab.active {
            background: white; color: #d93025; border-bottom: 2px solid #d93025;
        }
        .container.referral-mode .tabs {
            margin: 0 26px;
            border-bottom: none;
            gap: 10px;
            padding-top: 24px;
        }
        .container.referral-mode .tab {
            border-radius: 14px 14px 0 0;
            background: #f3f5f8;
            border: 1px solid #e8edf3;
            border-bottom: none;
            font-weight: 800;
        }
        .container.referral-mode .tab.active {
            background: #fff;
            color: #d93025;
            box-shadow: 0 -1px 0 #fff inset;
        }
        /* --- Smooth auth panel height + form crossfade --- */
        .form-area {
            position: relative;
            overflow: hidden;
            transition: height 280ms cubic-bezier(.2,.9,.2,1);
            will-change: height;
        }
        .container.referral-mode .form-area {
            margin: 0 26px 26px;
            background: #fff;
            border: 1px solid #e8edf3;
            border-radius: 0 20px 20px 20px;
            box-shadow: 0 16px 36px rgba(15,23,42,0.07);
        }

        .auth-form {
            position: absolute;
            left: 0; right: 0;
            top: 0;
            opacity: 0;
            transform: translateY(8px);
            pointer-events: none;
            padding: 30px;
            transition:
                opacity 180ms ease,
                transform 220ms cubic-bezier(.2,.9,.2,1);
        }

        .auth-form.active {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        .container.referral-mode .auth-form {
            padding: 28px 28px 30px;
        }

        @media (prefers-reduced-motion: reduce) {
            .form-area, .auth-form { transition: none !important; }
        }

        .form-group { margin-bottom: 15px; }
        .form-group label {
            display: block; font-size: 12px; font-weight: 700; color: #5f6368;
            margin-bottom: 5px; text-transform: uppercase;
        }
        input, select {
            width: 100%; padding: 10px; border: 2px solid #eee; border-radius: 6px;
            box-sizing: border-box; font-size: 14px; background: white;
        }
        input:focus, select:focus { border-color: #d93025; outline: none; }
        .recovery-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
        .recovery-method {
            width: 100%; padding: 12px; border: 2px solid #e5e7eb; border-radius: 8px;
            background: white; color: #3c4043; cursor: pointer; font-size: 14px; font-weight: 700;
        }
        .recovery-method:hover { border-color: #d93025; color: #b0261e; }
        .recovery-method.active { border-color: #d93025; background: #fff5f4; color: #b0261e; }
        .recovery-method:focus-visible { outline: 3px solid rgba(217,48,37,0.2); outline-offset: 2px; }

        .btn {
            width: 100%; padding: 12px; background: #d93025; color: white; border: none;
            border-radius: 6px; font-weight: 700; cursor: pointer; margin-top: 10px;
        }
        .btn:hover { background: #b0261e; }
        .google-auth-block { margin-bottom: 18px; }
        .google-auth-button {
            width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: center;
            box-sizing: border-box; padding: 0; overflow: visible;
            border: 0; border-radius: 0; background: transparent;
        }
        .google-auth-button > div {
            width: 100% !important; max-width: none !important;
        }
        .google-auth-button [role="button"] {
            width: 100% !important; min-width: 100% !important; max-width: none !important;
            height: 44px !important; min-height: 44px !important;
            border: 2px solid #eee !important; border-radius: 6px !important;
            box-shadow: none !important; color: #111 !important;
            font-family: 'Segoe UI', Roboto, sans-serif !important; font-size: 14px !important;
        }
        .google-auth-button [role="button"] span:not(#button-label) {
            color: #111 !important; font-family: 'Segoe UI', Roboto, sans-serif !important;
            font-size: 14px !important;
        }
        .google-auth-divider {
            display: flex; align-items: center; gap: 10px; margin: 20px 0 16px;
            color: #8a9099; font-size: 11px; font-weight: 800; text-transform: uppercase;
        }
        .google-auth-divider::before, .google-auth-divider::after { content: ''; flex: 1; height: 1px; background: #e5e7eb; }
        .container.referral-mode .btn {
            border-radius: 14px;
            padding: 14px 16px;
            font-weight: 900;
            letter-spacing: 0.01em;
            box-shadow: 0 12px 20px rgba(217,48,37,0.18);
        }

        .error { color: #d93025; font-size: 13px; text-align: center; margin-top: 10px; display: none; }
        .success { color: #34a853; font-size: 13px; text-align: center; margin-top: 10px; display: none; }

        .otp-info { text-align: center; font-size: 13px; color: #555; margin-bottom: 20px; line-height: 1.5; }
        .link-btn {
            background:none; border:none; color:#d93025; cursor:pointer;
            font-size:12px; text-decoration:underline; padding:0;
        }
        .center-links { text-align:center; margin-top:15px; font-size:12px; }
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
        @media (max-width: 760px) {
            body { align-items:flex-start; padding:20px 0; height:auto; min-height:100vh; }
            .login-shell {
                padding: 0;
            }
            .login-shell.has-login-marketing {
                width: min(100% - 28px, 520px);
                display: flex;
                flex-direction: column;
                align-items: stretch;
                gap: 16px;
            }
            .login-shell.has-login-marketing .container:not(.referral-mode) {
                width: 100%;
                max-width: 100%;
            }
            .login-marketing-billboard {
                display: none;
            }
            .login-marketing-banner {
                display: block;
            }
            .container.referral-mode {
                width: min(94vw, 620px);
                display: block;
            }
            .container.referral-mode .header {
                text-align: center;
            }
            .container.referral-mode .auth-pane {
                min-height: 0;
            }
            body.referral-active:not(.referral-mobile-signup) .container.referral-mode .auth-pane {
                display: none;
            }
            body.referral-mobile-signup .container.referral-mode .referral-hero {
                display: none;
            }
            .container.referral-mode .tabs {
                display: none !important;
            }
            .container.referral-mode .form-area {
                margin: 18px 18px 18px;
                border-radius: 20px;
            }
            .container.referral-mode .referral-hero {
                min-height: 0;
                padding: 26px 22px 24px;
            }
            .referral-hero { flex-direction:column; text-align:center; }
            .referral-brand {
                align-items: center;
            }
            .container.referral-mode .referral-copy h2 { font-size:28px; max-width: none; }
            .container.referral-mode .referral-copy p { max-width: none; }
            .container.referral-mode .header {
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 18px;
                padding: 18px 18px 16px;
            }
            .container.referral-mode .header-offer-note {
                display: grid;
                gap: 7px;
                width: min(100%, 360px);
                padding: 0;
                font-size: 15px;
                line-height: 1.12;
                font-weight: 900;
                text-align: center;
                white-space: normal;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }
            .header-offer-note span {
                display: block;
            }
            .header-offer-note .offer-price {
                font-size: 24px;
                letter-spacing: 0;
                text-transform: none;
            }
            .container.referral-mode .referral-logo {
                width: 180px;
                height: 180px;
                border-radius: 36px;
            }
            .container.referral-mode .referral-offer {
                margin-top: 4px;
            }
            .container.referral-mode .referral-offer strong {
                font-size: 22px;
            }
            .referral-mobile-continue {
                display: block;
                width: 100%;
                margin-top: 18px;
                padding: 14px 16px;
                border: none;
                border-radius: 14px;
                background: #fff;
                color: #b1241c;
                font-size: 15px;
                font-weight: 900;
                cursor: pointer;
                box-shadow: 0 14px 24px rgba(0,0,0,0.14);
            }
        }
    </style>
    <!-- Meta Pixel Code -->
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
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=636685175264715&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
    <!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-W7MP6MZNMZ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-W7MP6MZNMZ');
</script>
</head>
<body class="<?= $hasReferralInvite ? 'referral-active referral-pending' : '' ?>">

<div class="login-shell <?= $hasLoginMarketing ? 'has-login-marketing' : '' ?> <?= $showLoginBillboard ? 'has-login-billboard' : '' ?> <?= $showLoginBanner ? 'has-login-banner' : '' ?>">
<?php if ($showLoginBillboard): ?>
    <iframe class="login-marketing-billboard" src="<?= htmlspecialchars($loginBillboardSrc, ENT_QUOTES) ?>" title="FirstMate marketing billboard" loading="lazy" scrolling="no"></iframe>
<?php endif; ?>
<?php if ($showLoginBanner): ?>
    <iframe class="login-marketing-banner" src="<?= htmlspecialchars($loginBannerSrc, ENT_QUOTES) ?>" title="FirstMate marketing banner" loading="lazy" scrolling="no"></iframe>
<?php endif; ?>
<div class="container <?= $hasReferralInvite ? 'referral-mode' : '' ?>">
    <div class="header">
        <img src="/images/logo_white.png" alt="Logo" height="70" style="padding:0; margin:0;">
        <div class="header-offer-note"><span>Premium Roof Reports</span><span class="offer-price">Only $7</span></div>
    </div>

    <div class="referral-hero <?= $hasReferralInvite ? 'active loading' : '' ?>" id="referralHero">
        <div class="referral-top">
            <div class="referral-brand">
                <div class="referral-logo" id="referralLogo">
                    <div class="fallback" id="referralLogoFallback"><?= $hasReferralInvite ? '...' : 'R' ?></div>
                    <img id="referralLogoImg" src="" alt="" style="display:none;">
                </div>
                <div class="referral-copy">
                    <h2 id="referralHeadline">
                        <span class="<?= $hasReferralInvite ? 'referral-headline-loading' : '' ?>" id="referralHeadlinePartner"><?= $hasReferralInvite ? 'Loading...' : 'Partner Name' ?></span>
                    </h2>
                    <p id="referralSubheadline"><?= $hasReferralInvite ? '' : 'Has invited you to try FirstMeasure' ?></p>
                    <div class="referral-offer" id="referralOffer">
                        <strong id="referralOfferTitle"></strong>
                        <span id="referralOfferDescription"></span>
                    </div>
                    <button type="button" class="referral-mobile-continue" id="referralMobileContinue">Continue</button>
                </div>
            </div>
        </div>
    </div>

    <div class="auth-pane">
    <div class="tabs" id="authTabs">
        <div class="tab <?= $hasReferralInvite ? '' : 'active' ?>" id="tabLogin" onclick="switchTab('login')"<?= $hasReferralInvite ? ' style="display:none;"' : '' ?>>Login</div>
        <div class="tab <?= $hasReferralInvite ? 'active' : '' ?>" id="tabRegister" onclick="switchTab('register')"><?= $hasReferralInvite ? 'Create your company account to activate this invitation.' : 'Create Account' ?></div>
    </div>

    <div class="form-area">
        <!-- LOGIN FORM -->
        <form class="auth-form <?= $hasReferralInvite ? '' : 'active' ?>" id="loginForm">
            <div class="google-auth-block">
                <div class="google-auth-button" id="googleLoginButton" aria-label="Sign in with Google"></div>
                <div class="google-auth-divider"><span>or use your account</span></div>
            </div>
            <div class="form-group">
                <label>Email or phone</label>
                <input type="text" name="identifier" autocomplete="username" required>
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" required>
            </div>
            <button type="submit" class="btn">Login</button>
            <div class="center-links">
                <button type="button" class="link-btn" onclick="showForgot()">Forgot Password?</button>
            </div>
            <div id="loginError" class="error"></div>
        </form>

        <!-- REGISTER FORM -->
        <form class="auth-form <?= $hasReferralInvite ? 'active' : '' ?>" id="registerForm">
            <input type="hidden" name="referral_code" id="registerReferralCode" value="<?= htmlspecialchars($initialReferralCode, ENT_QUOTES) ?>">
            <input type="hidden" name="referral_attribution_id" id="registerReferralAttributionId" value="">
            <input type="hidden" name="acquisition_code" id="registerAcquisitionCode" value="">
            <input type="hidden" name="acquisition_attribution_id" id="registerAcquisitionAttributionId" value="">
            <input type="hidden" name="campaign" id="registerCampaign" value="">
            <input type="hidden" name="xid" id="registerBonusToken" value="">
            <input type="hidden" name="acquisition_bonus_token" id="registerAcquisitionBonusToken" value="">
            <input type="hidden" name="landing_variant" id="registerLandingVariant" value="">
            <div class="google-auth-block">
                <div class="google-auth-button" id="googleRegisterButton" aria-label="Sign up with Google"></div>
                <div class="google-auth-divider"><span>or create with email</span></div>
            </div>
            <div class="form-group">
                <label>Phone</label>
                <input type="tel" name="phone" inputmode="tel" autocomplete="tel" placeholder="(555) 555-0123" maxlength="14" required>
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" name="email" required>
            </div>
            <div class="form-group password-form-group">
                <label>Password</label>
                <input type="password" name="password" required>
            </div>
            <!-- Added Confirm Password -->
            <div class="form-group password-form-group">
                <label>Confirm Password</label>
                <input type="password" name="confirm_password" required>
            </div>
            <div id="regError" class="error" role="alert" aria-live="polite"></div>
            <button type="submit" class="btn">Create Account</button>
            <?php if ($hasReferralInvite): ?>
            <div class="center-links">
                Already have an account?
                <button type="button" class="link-btn" onclick="switchToExistingAccountLogin()">Click here to Login</button>
            </div>
            <?php endif; ?>
            <div class="fm-terms">By creating an account, you agree to our <a href="https://app.1m8.ai/portal/terms/" target="_blank" rel="noopener">Terms of Use</a> and that we may text you at the number above. Msg and data rates may apply.</div>
        </form>

        <!-- FORGOT PASSWORD FORM -->
        <form class="auth-form" id="forgotPassForm">
            <div style="margin-bottom:15px; text-align:center; font-size:13px; color:#666;">
                How would you like to reset your password?
            </div>
            <input type="hidden" name="delivery_channel" id="recoveryChannel" value="">
            <div class="recovery-methods" role="group" aria-label="Password reset method">
                <button type="button" class="recovery-method" data-recovery-method="email" aria-pressed="false">Email</button>
                <button type="button" class="recovery-method" data-recovery-method="phone" aria-pressed="false">Phone</button>
            </div>
            <div id="recoveryDetails" hidden>
                <div class="form-group">
                    <label id="recoveryIdentifierLabel">Email</label>
                    <input type="email" name="identifier" id="recoveryIdentifier" autocomplete="email" required>
                </div>
                <button type="submit" class="btn">Send Code</button>
            </div>
            <div class="center-links">
                <button type="button" class="link-btn" onclick="switchTab('login')">Back to Login</button>
            </div>
            <div id="forgotError" class="error"></div>
        </form>

        <!-- OTP FORM -->
        <form class="auth-form" id="otpForm">
            <div class="otp-info">
                <span id="otpMsg">Enter the verification code:</span><br>
                <strong id="otpDestinationDisp"></strong>
            </div>
            <div class="form-group">
                <label>6-Digit Code</label>
                <input type="text" name="otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" style="text-align:center; letter-spacing: 5px; font-size: 18px;" required>
            </div>
            <button type="submit" class="btn">Verify Code</button>
            <div id="otpError" class="error"></div>
            <div class="center-links">
                <button type="button" class="link-btn" onclick="location.reload()">Start Over</button>
            </div>
        </form>

        <!-- RESET PASSWORD FORM -->
        <form class="auth-form" id="resetPassForm">
            <div style="margin-bottom:15px; text-align:center; font-size:13px; color:#666;">
                Code verified. Please set a new password.
            </div>
            <div class="form-group">
                <label>New Password</label>
                <input type="password" name="new_password" required minlength="6">
            </div>
            <button type="submit" class="btn">Update Password</button>
            <div id="resetError" class="error"></div>
            <div id="resetSuccess" class="success">Password updated! Logging in...</div>
        </form>
    </div>
    </div>
</div>
</div>

<script src="/libraries/google-auth/firstmate-google-auth.js"></script>
<script>
    // --- HELPER: Parse URL params ---
    const urlParams = new URLSearchParams(window.location.search);
    const redirectTarget = urlParams.get('redirect') || './'; // Default to browser
    const referralCode = (urlParams.get('ref') || '').trim().toUpperCase();
    const campaignCode = (urlParams.get('cid') || urlParams.get('campaign') || urlParams.get('campaign_code') || urlParams.get('utm_campaign') || '').trim();
    let acquisitionCode = campaignCode;
    const campaignType = (urlParams.get('campaign_type') || urlParams.get('utm_source') || '').trim();
    const landingVariant = (urlParams.get('variant') || urlParams.get('landing_variant') || '').trim();
    let acquisitionBonusToken = (urlParams.get('xid') || urlParams.get('acquisition_bonus_token') || urlParams.get('bonus_token') || '').trim();
    let acquisitionAttributionId = '';
    let acquisitionTrackingPromise = null;
    let storedLoginNotice = '';
    try {
        storedLoginNotice = sessionStorage.getItem('fm_login_notice') || '';
        if (storedLoginNotice) sessionStorage.removeItem('fm_login_notice');
    } catch(e) {}
    const expiredSessionNotice = urlParams.get('expired') === '1' || !!storedLoginNotice;
    const formArea = document.querySelector('.form-area');
    const containerEl = document.querySelector('.container');
    const heroEl = document.getElementById('referralHero');
    const hasReferralInvite = <?= $hasReferralInvite ? 'true' : 'false' ?>;
    const mobileReferralQuery = window.matchMedia('(max-width: 760px)');

    // UTM fields to forward to server on registration
    const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', '_fbc', '_fbp', 'xid', 'acquisition_bonus_token', 'bonus_token'];
    const TRACKING_TIMEOUT_MS = 3500;
    const SIGNUP_EMAIL_VERIFICATION_ENABLED = false;

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
        const digits = String(value || '').replace(/\D/g, '');
        return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
    }

    const registrationPhoneInput = document.querySelector('#registerForm input[name="phone"]');

    function validateRegistrationPhone() {
        const valid = !!registrationPhoneInput && isValidSignupPhone(registrationPhoneInput.value);
        registrationPhoneInput?.setCustomValidity(valid ? '' : 'Enter a valid ten-digit mobile phone number.');
        if (valid) registrationPhoneInput.value = formatSignupPhone(registrationPhoneInput.value);
        return valid;
    }

    registrationPhoneInput?.addEventListener('input', () => {
        registrationPhoneInput.value = formatSignupPhone(registrationPhoneInput.value);
        registrationPhoneInput.setCustomValidity('');
    });
    registrationPhoneInput?.addEventListener('blur', validateRegistrationPhone);

    function platformApiBaseUrl(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.protocol}//${location.hostname}:3111/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
    }

    let passwordRecoveryToken = '';
    let passwordRecoveryIdentifier = '';

    function googleErrorMessage(error) {
        const code = String(error && error.code || '');
        if (code === 'google_account_mismatch') return 'This email is already linked to a different Google account. Contact support if you need help.';
        if (code === 'membership_required') return 'Your Google email is recognized, but it is not assigned to a company yet.';
        if (code === 'identity_inactive' || code === 'user_disabled') return 'This account is disabled. Contact your company administrator.';
        return String(error && error.message || 'Google sign-in could not be completed. Please try again.');
    }

    function showGoogleError(error, targetId) {
        const err = document.getElementById(targetId || 'loginError');
        if (!err) return;
        err.innerText = googleErrorMessage(error);
        err.style.display = 'block';
        requestAnimationFrame(() => setFormAreaHeightTo(err.closest('form.auth-form')));
    }

    async function googleRegistrationPayload() {
        await waitForAcquisitionTrackingBeforeSubmit();
        const fd = new FormData(document.getElementById('registerForm'));
        const payload = {};
        fd.forEach((value, key) => {
            if (key !== 'password' && key !== 'confirm_password' && key !== 'phone' && key !== 'email') payload[key] = value;
        });
        UTM_FIELDS.forEach(key => {
            const value = urlParams.get(key);
            if (value) payload[key] = value;
        });
        if (acquisitionCode) {
            payload.campaign = payload.campaign || acquisitionCode;
            payload.acquisition_code = payload.acquisition_code || acquisitionCode;
        }
        if (acquisitionAttributionId) payload.acquisition_attribution_id = payload.acquisition_attribution_id || acquisitionAttributionId;
        if (acquisitionBonusToken) {
            payload.xid = payload.xid || acquisitionBonusToken;
            payload.acquisition_bonus_token = payload.acquisition_bonus_token || acquisitionBonusToken;
        }
        if (landingVariant) payload.landing_variant = payload.landing_variant || landingVariant;
        if (campaignType) payload.campaign_type = payload.campaign_type || campaignType;
        return payload;
    }

    function handleGoogleSuccess(data) {
        if (data && data.first_login && window.fbq) window.fbq('track', 'CompleteRegistration');
        window.location.href = data && data.first_login ? onboardingDestination() : redirectTarget;
    }

    async function initializeGoogleAuth() {
        if (!window.FirstMateGoogleAuth) return;
        const shared = {
            apiBaseUrl: platformApiBaseUrl(),
            onSuccess: handleGoogleSuccess
        };
        const mounts = [
            window.FirstMateGoogleAuth.mountButton({
                ...shared,
                container: document.getElementById('googleLoginButton'),
                buildPayload: () => ({}),
                onError: error => showGoogleError(error, 'loginError')
            }),
            window.FirstMateGoogleAuth.mountButton({
                ...shared,
                container: document.getElementById('googleRegisterButton'),
                text: 'signup_with',
                buildPayload: googleRegistrationPayload,
                onError: error => showGoogleError(error, 'regError')
            })
        ];
        const results = await Promise.allSettled(mounts);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const id = index === 0 ? 'googleLoginButton' : 'googleRegisterButton';
                document.getElementById(id)?.closest('.google-auth-block')?.remove();
            }
        });
    }

    async function syncPlatformBrowserSession(formData){
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
        } catch(e) {
            return null;
        }
    }

    async function authLegacyRequest(formData){
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
        return await res.json();
    }

    function loginErrorMessage(data) {
        const code = String(data && data.error || '').trim();
        if (code === 'invalid_credentials') return 'The password you entered is incorrect.';
        if (code === 'identity_phone_ambiguous') return 'This phone number is connected to multiple accounts. Sign in with email or contact support.';
        if (code === 'not_found' || code === 'identity_phone_not_found') return "We couldn't find an account with that email or phone number.";
        return String(data && data.message || 'Unable to log in. Please try again.');
    }

    function attributionPayload(extra = {}) {
        const payload = Object.assign({
            campaign: acquisitionCode || referralCode || '',
            cid: acquisitionCode || '',
            campaign_type: campaignType || (referralCode ? 'referral' : 'landing_page'),
            landing_variant: landingVariant,
            landing_page: location.pathname,
            page_url: location.href,
            referrer: document.referrer || '',
            xid: acquisitionBonusToken,
            acquisition_bonus_token: acquisitionBonusToken
        }, extra || {});
        UTM_FIELDS.forEach(key => {
            const val = urlParams.get(key);
            if (val) payload[key] = val;
        });
        return payload;
    }

    async function trackAcquisitionLanding() {
        if (referralCode || (!acquisitionCode && !landingVariant)) return null;
        if (acquisitionTrackingPromise) return acquisitionTrackingPromise;
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
            const data = await res.json().catch(() => ({}));
            if (!data || !data.success) return;
            acquisitionAttributionId = data.acquisition_attribution_id || data.attribution_id || '';
            acquisitionBonusToken = data?.bonus_offer?.token || acquisitionBonusToken || '';
            syncBonusTokenToUrl(data?.bonus_query_key || 'xid');
            const code = data?.link?.code || data?.acquisition_link?.code || acquisitionCode || '';
            acquisitionCode = code;
            document.getElementById('registerAcquisitionCode').value = code;
            document.getElementById('registerAcquisitionAttributionId').value = acquisitionAttributionId;
            document.getElementById('registerCampaign').value = code;
            document.getElementById('registerBonusToken').value = acquisitionBonusToken;
            document.getElementById('registerAcquisitionBonusToken').value = acquisitionBonusToken;
            document.getElementById('registerLandingVariant').value = landingVariant;
            return data;
        })();
        try {
            return await acquisitionTrackingPromise;
        } catch(e) {
            return null;
        }
    }

    function syncBonusTokenToUrl(queryKey) {
        if (!acquisitionBonusToken || !window.history?.replaceState) return;
        try {
            const url = new URL(window.location.href);
            url.searchParams.set(String(queryKey || 'xid'), acquisitionBonusToken);
            window.history.replaceState(window.history.state, document.title, url.toString());
        } catch(e) {}
    }

    function timeout(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForAcquisitionTrackingBeforeSubmit() {
        if (referralCode || (!acquisitionCode && !landingVariant)) return;
        const pending = trackAcquisitionLanding();
        if (!pending) return;
        await Promise.race([pending.catch(() => null), timeout(TRACKING_TIMEOUT_MS)]);
    }

    function appendAttributionParams(urlValue) {
        try {
            const url = new URL(urlValue, window.location.href);
            if (acquisitionCode && !url.searchParams.get('cid')) url.searchParams.set('cid', acquisitionCode);
            if (acquisitionCode && !url.searchParams.get('campaign')) url.searchParams.set('campaign', acquisitionCode);
            if (acquisitionAttributionId && !url.searchParams.get('acquisition_attribution_id')) url.searchParams.set('acquisition_attribution_id', acquisitionAttributionId);
            if (acquisitionBonusToken && !url.searchParams.get('xid')) url.searchParams.set('xid', acquisitionBonusToken);
            if (acquisitionBonusToken && !url.searchParams.get('acquisition_bonus_token')) url.searchParams.set('acquisition_bonus_token', acquisitionBonusToken);
            if (landingVariant && !url.searchParams.get('landing_variant')) url.searchParams.set('landing_variant', landingVariant);
            if (campaignType && !url.searchParams.get('campaign_type')) url.searchParams.set('campaign_type', campaignType);
            return url.pathname + url.search + url.hash;
        } catch(e) {
            return urlValue;
        }
    }

    function onboardingDestination() {
        return appendAttributionParams('./?onboarding=1');
    }

    function setFormAreaHeightTo(el) {
        const prevPos = el.style.position;
        const prevVis = el.style.visibility;
        const prevDisp = el.style.display;

        el.style.position = 'relative';
        el.style.visibility = 'hidden';
        el.style.display = 'block';

        const h = el.offsetHeight;

        el.style.position = prevPos;
        el.style.visibility = prevVis;
        el.style.display = prevDisp;

        formArea.style.height = h + 'px';
    }

    function activateForm(formEl) {
        document.querySelectorAll('form.auth-form').forEach(f => f.classList.remove('active'));
        formEl.classList.add('active');
        requestAnimationFrame(() => setFormAreaHeightTo(formEl));
    }

    function showMobileReferralSignup() {
        if (!referralCode) return;
        document.body.classList.add('referral-mobile-signup');
        switchTab('register');
        requestAnimationFrame(() => {
            document.getElementById('registerForm')?.querySelector('input[name="name"]')?.focus();
        });
    }

    function hideAll() {
        document.querySelectorAll('.error, .success').forEach(e => e.style.display = 'none');
        document.querySelectorAll('form.auth-form').forEach(f => f.classList.remove('active'));
    }

    function switchTab(tab) {
        hideAll();
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.getElementById('authTabs').style.display = 'flex';

        if (tab === 'login') {
            document.getElementById('tabLogin').classList.add('active');
            activateForm(document.getElementById('loginForm'));
        } else {
            document.getElementById('tabRegister').classList.add('active');
            activateForm(document.getElementById('registerForm'));
        }
    }

    function showForgot() {
        hideAll();
        document.getElementById('authTabs').style.display = 'none';
        activateForm(document.getElementById('forgotPassForm'));
    }

    function showOtp(destination, message) {
        hideAll();
        document.getElementById('authTabs').style.display = 'none';
        document.getElementById('otpDestinationDisp').innerText = destination || '';
        if (message) document.getElementById('otpMsg').innerText = message;
        activateForm(document.getElementById('otpForm'));
    }

    function showResetPass() {
        hideAll();
        document.getElementById('authTabs').style.display = 'none';
        activateForm(document.getElementById('resetPassForm'));
    }

    document.querySelectorAll('[data-recovery-method]').forEach((button) => button.addEventListener('click', () => {
        const method = button.dataset.recoveryMethod;
        const phone = method === 'phone';
        const input = document.getElementById('recoveryIdentifier');
        document.getElementById('recoveryChannel').value = method;
        document.querySelectorAll('[data-recovery-method]').forEach((option) => {
            const selected = option === button;
            option.classList.toggle('active', selected);
            option.setAttribute('aria-pressed', String(selected));
        });
        document.getElementById('recoveryIdentifierLabel').innerText = phone ? 'Phone number' : 'Email';
        input.type = phone ? 'tel' : 'email';
        input.autocomplete = phone ? 'tel' : 'email';
        input.placeholder = phone ? '(555) 555-0123' : 'you@example.com';
        input.value = '';
        document.getElementById('recoveryDetails').hidden = false;
        requestAnimationFrame(() => {
            setFormAreaHeightTo(document.getElementById('forgotPassForm'));
            input.focus();
        });
    }));

    function switchToExistingAccountLogin() {
        document.body.classList.remove('referral-active', 'referral-pending');
        document.body.classList.remove('referral-mobile-signup');
        containerEl.classList.remove('referral-mode');
        heroEl.classList.remove('active', 'loading');
        const loginTab = document.getElementById('tabLogin');
        const registerTab = document.getElementById('tabRegister');
        loginTab.style.display = '';
        registerTab.textContent = 'Create Account';
        switchTab('login');
    }

    function setReferralPending(isPending) {
        if (!referralCode) return;
        document.body.classList.toggle('referral-pending', !!isPending);
        containerEl.classList.add('referral-mode');
        document.body.classList.add('referral-active');
        heroEl.classList.add('active');
        heroEl.classList.toggle('loading', !!isPending);
        document.getElementById('referralHeadlinePartner').classList.toggle('referral-headline-loading', !!isPending);
        if (isPending) {
            document.getElementById('referralHeadlinePartner').textContent = 'Loading...';
            document.getElementById('referralSubheadline').textContent = '';
        }
        document.getElementById('tabRegister').textContent = 'Claim Invitation';
        document.getElementById('tabLogin').style.display = 'none';
        document.getElementById('registerReferralCode').value = referralCode;
        document.getElementById('registerAcquisitionCode').value = referralCode;
        document.getElementById('registerCampaign').value = referralCode;
        document.getElementById('registerLandingVariant').value = landingVariant;
        if (isPending && mobileReferralQuery.matches) {
            document.body.classList.remove('referral-mobile-signup');
        }
    }

    function showReferralFallback(message) {
        const logoImg = document.getElementById('referralLogoImg');
        const logoFallback = document.getElementById('referralLogoFallback');
        document.getElementById('referralHeadlinePartner').textContent = 'Partner invitation';
        document.getElementById('referralHeadlinePartner').classList.remove('referral-headline-loading');
        document.getElementById('referralSubheadline').textContent = 'Has invited you to try FirstMeasure';
        document.getElementById('referralOffer').classList.remove('active');
        logoImg.style.display = 'none';
        logoFallback.textContent = 'R';
        logoFallback.style.display = '';
        setReferralPending(false);
    }

    function applyReferralData(data) {
        if (!data || !data.success) return false;
        const partner = data.partner || {};
        const offer = data.offer || null;
        const logoImg = document.getElementById('referralLogoImg');
        const logoFallback = document.getElementById('referralLogoFallback');
        const headlinePartner = document.getElementById('referralHeadlinePartner');
        const subheadline = document.getElementById('referralSubheadline');
        const offerBox = document.getElementById('referralOffer');
        const offerTitle = document.getElementById('referralOfferTitle');
        const offerDescription = document.getElementById('referralOfferDescription');
        document.getElementById('registerReferralCode').value = (data.code && data.code.code) ? data.code.code : referralCode;
        document.getElementById('registerReferralAttributionId').value = data.attribution_id || '';
        document.getElementById('registerAcquisitionCode').value = (data.code && data.code.code) ? data.code.code : referralCode;
        document.getElementById('registerAcquisitionAttributionId').value = data.acquisition_attribution_id || data.attribution_id || '';
        document.getElementById('registerCampaign').value = (data.code && data.code.code) ? data.code.code : referralCode;
        document.getElementById('registerLandingVariant').value = landingVariant;
        const partnerName = String((partner && partner.display_name) || 'A FirstMate partner').trim() || 'A FirstMate partner';
        headlinePartner.textContent = partnerName;
        headlinePartner.classList.remove('referral-headline-loading');
        subheadline.textContent = 'Has invited you to try FirstMeasure';
        const logoUrl = (partner && partner.logo_url) ? String(partner.logo_url).trim() : '';
        if (logoUrl) {
            logoImg.src = logoUrl;
            logoImg.style.display = '';
            logoFallback.style.display = 'none';
        } else {
            const first = String((partner && partner.display_name) || 'R').trim().charAt(0).toUpperCase() || 'R';
            logoFallback.textContent = first;
            logoFallback.style.display = '';
            logoImg.style.display = 'none';
        }
        if (offer) {
            offerTitle.textContent = `Sign up today to get ${offer.discount_percent || 50}% off all orders for your first ${offer.window_days || 7} days.`;
            offerDescription.textContent = '';
            offerBox.classList.add('active');
        } else {
            offerTitle.textContent = 'Sign up today to get 50% off all orders for your first 7 days.';
            offerDescription.textContent = '';
            offerBox.classList.add('active');
        }
        containerEl.classList.add('referral-mode');
        document.body.classList.add('referral-active');
        document.getElementById('tabRegister').textContent = 'Claim Invitation';
        setReferralPending(false);
        return true;
    }

    window.addEventListener('resize', () => {
        const active = document.querySelector('form.auth-form.active');
        if (active) setFormAreaHeightTo(active);
    });

    document.getElementById('referralMobileContinue')?.addEventListener('click', showMobileReferralSignup);

    window.addEventListener('load', () => {
        const active = document.querySelector('form.auth-form.active') || document.getElementById('loginForm');
        activateForm(active);
    });

    async function loadReferralInvite() {
        if (!referralCode) return;
        try {
            setReferralPending(true);
            const base = (() => {
                const host = (location.hostname || '').toLowerCase();
                if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:3111/v1/platform';
                return `${location.origin}/v1/platform`;
            })();
            const res = await fetch(`${base}/referrals/public/${encodeURIComponent(referralCode)}`, {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
            const data = await res.json().catch(() => ({}));
            if (!applyReferralData(data)) {
                showReferralFallback((data && data.error) ? String(data.error) : '');
            }
        } catch (err) {
            showReferralFallback('');
        }
    }

    // 1. LOGIN SUBMIT
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target); fd.append('action', 'login');
        const err = document.getElementById('loginError'); err.style.display='none';

        try {
            const data = await authLegacyRequest(fd);

            if(data.success) {
                await syncPlatformBrowserSession(fd);
                // first_login: send to onboarding wizard instead of tutorial
                if(data.first_login) {
                    window.location.href = onboardingDestination();
                } else {
                    window.location.href = redirectTarget;
                }
            }
            else if(data.require_otp) {
                showOtp(data.email, data.message || "Verification Required");
            }
            else {
                err.innerText = loginErrorMessage(data);
                err.style.display='block';
            }
        } catch(e) {
            err.innerText='Connection Error';
            err.style.display='block';
        }
    });

    // 2. REGISTER SUBMIT
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        if (form.dataset.submitting === 'true') return;
        form.dataset.submitting = 'true';
        const submitButton = form.querySelector('button[type="submit"]');
        const submitButtonText = submitButton?.innerText || 'Create Account';
        if (submitButton) { submitButton.disabled = true; submitButton.innerText = 'Creating…'; }
        const resetSubmitting = () => {
            form.dataset.submitting = 'false';
            if (submitButton) { submitButton.disabled = false; submitButton.innerText = submitButtonText; }
        };
        const err = document.getElementById('regError'); err.style.display='none';
        if (!validateRegistrationPhone()) {
            err.innerText = 'Enter a valid ten-digit mobile phone number.';
            err.style.display = 'block';
            registrationPhoneInput?.reportValidity();
            resetSubmitting();
            return;
        }
        const fd = new FormData(form);

        // Passwords Check
        if(fd.get('password') !== fd.get('confirm_password')) {
            err.innerText = "Passwords do not match."; err.style.display='block'; resetSubmitting(); return;
        }

        fd.append('action', 'register');
        await waitForAcquisitionTrackingBeforeSubmit();

        // Forward any UTM / attribution params from the URL to the server
        UTM_FIELDS.forEach(key => {
            const val = urlParams.get(key);
            if (val) fd.append(key, val);
        });
        if (acquisitionCode && !fd.get('campaign')) fd.set('campaign', acquisitionCode);
        if (acquisitionCode && !fd.get('acquisition_code')) fd.set('acquisition_code', acquisitionCode);
        if (acquisitionAttributionId && !fd.get('acquisition_attribution_id')) fd.set('acquisition_attribution_id', acquisitionAttributionId);
        if (acquisitionBonusToken && !fd.get('xid')) fd.set('xid', acquisitionBonusToken);
        if (acquisitionBonusToken && !fd.get('acquisition_bonus_token')) fd.set('acquisition_bonus_token', acquisitionBonusToken);
        if (landingVariant && !fd.get('landing_variant')) fd.set('landing_variant', landingVariant);
        if (campaignType && !fd.get('campaign_type')) fd.set('campaign_type', campaignType);

        try {
            const data = await authLegacyRequest(fd);
            if(data.success) {
                if (window.fbq) window.fbq('track', 'CompleteRegistration');
                window.location.href = data.first_login ? onboardingDestination() : redirectTarget;
            }
            else if(data.require_otp) {
                if (SIGNUP_EMAIL_VERIFICATION_ENABLED) {
                    showOtp(data.email, "Account created! Verify your email.");
                } else {
                    if (window.fbq) window.fbq('track', 'CompleteRegistration');
                    window.location.href = onboardingDestination();
                }
            }
            else { err.innerText = data.error || 'Failed'; err.style.display='block'; }
        } catch(e) { err.innerText='Connection Error'; err.style.display='block'; }
        finally { resetSubmitting(); }
    });

    // 3. FORGOT PASS
    document.getElementById('forgotPassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        if (form.dataset.submitting === 'true') return;
        form.dataset.submitting = 'true';
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) { submitButton.disabled = true; submitButton.innerText = 'Sending…'; }
        const fd = new FormData(form); fd.append('action', 'forgot_password');
        const err = document.getElementById('forgotError'); err.style.display='none';
        try {
            const data = await authLegacyRequest(fd);
            if(data.require_otp) {
                passwordRecoveryToken = String(data.recovery_token || '');
                passwordRecoveryIdentifier = String(fd.get('identifier') || '');
                showOtp(data.masked_destination || '', data.message || "Password reset code sent.");
            }
            else { err.innerText = data.message || data.error || 'Unable to send code.'; err.style.display='block'; }
        } catch(e) { err.innerText='Connection Error'; err.style.display='block'; }
        finally {
            form.dataset.submitting = 'false';
            if (submitButton) { submitButton.disabled = false; submitButton.innerText = 'Send Code'; }
        }
    });

    // 4. OTP SUBMIT
    document.getElementById('otpForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const otpInput = e.target.querySelector('input[name="otp"]');
        if (otpInput) otpInput.value = String(otpInput.value || '').replace(/\D/g, '').slice(0, 6);
        const fd = new FormData(e.target); fd.append('action', 'verify_otp');
        if (passwordRecoveryToken) fd.append('recovery_token', passwordRecoveryToken);
        else fd.append('email', document.getElementById('otpDestinationDisp')?.innerText || '');
        const err = document.getElementById('otpError'); err.style.display='none';
        try {
            const data = await authLegacyRequest(fd);
            if(data.require_new_password) showResetPass();
            else if(data.success) {
                // first_login: send to onboarding wizard instead of tutorial
                if(data.first_login) window.location.href = onboardingDestination();
                else window.location.href = redirectTarget;
            }
            else { err.innerText = data.error; err.style.display='block'; }
        } catch(e) { err.innerText='Connection Error'; err.style.display='block'; }
    });

    // 5. RESET PASS
    document.getElementById('resetPassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target); fd.append('action', 'set_new_password');
        if (passwordRecoveryToken) fd.append('recovery_token', passwordRecoveryToken);
        else fd.append('email', document.getElementById('otpDestinationDisp')?.innerText || '');
        const err = document.getElementById('resetError'); err.style.display='none';
        const succ = document.getElementById('resetSuccess'); succ.style.display='none';
        try {
            const data = await authLegacyRequest(fd);
            if(data.success) {
                succ.style.display='block';
                const loginFd = new FormData();
                loginFd.append('action', 'login');
                loginFd.append('identifier', passwordRecoveryIdentifier || document.getElementById('otpDestinationDisp')?.innerText || '');
                loginFd.append('password', String(fd.get('new_password') || ''));
                const loginData = await authLegacyRequest(loginFd);
                if (loginData && (loginData.success || loginData.first_login)) {
                    setTimeout(() => window.location.href = loginData.first_login ? onboardingDestination() : redirectTarget, 800);
                } else {
                    setTimeout(() => window.location.href = 'login.php?identifier=' + encodeURIComponent(passwordRecoveryIdentifier) + '&redirect=' + encodeURIComponent(redirectTarget || './'), 1200);
                }
            } else { err.innerText = data.error; err.style.display='block'; }
        } catch(e) { err.innerText='Connection Error'; err.style.display='block'; }
    });

    // ---------------------------
    // Start mode via GET param
    // ---------------------------
    const startMode =
        urlParams.get('start') ||
        urlParams.get('mode')  ||
        urlParams.get('tab');

    if (referralCode || startMode === 'register' || startMode === 'create') {
        switchTab('register');
    } else {
        switchTab('login');
    }
    if (hasReferralInvite) {
        setReferralPending(true);
    }
    trackAcquisitionLanding();
    if (expiredSessionNotice) {
        switchToExistingAccountLogin();
        const err = document.getElementById('loginError');
        if (err) {
            err.innerText = storedLoginNotice || 'Your session expired. Please log in again.';
            err.style.display = 'block';
        }
    }
    loadReferralInvite();
    initializeGoogleAuth();
</script>

</body>
</html>
