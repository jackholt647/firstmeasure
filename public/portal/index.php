<?php
require_once __DIR__ . '/session_bootstrap.php';
require_once dirname(__DIR__) . '/includes/provider_keys.php';
portalStartSession();

$GOOGLE_BROWSER_API_KEY = fm_google_provider_key('browser_customer');

// --- LOGIN CHECK ---
if (!isset($_SESSION['user_email'])) {
    header("Location: login.php");
    exit;
}

$userName    = $_SESSION['user_name'] ?? '';
$userEmail   = $_SESSION['user_email'] ?? '';
$userCompany = $_SESSION['user_company'] ?? '';
$userOrgId   = $_SESSION['user_org_id'] ?? ($_SESSION['org_id'] ?? null);
$userBranchId = $_SESSION['platform_branch_id'] ?? ($_SESSION['branch_id'] ?? 'default');
$isImpersonating = !empty($_SESSION['is_impersonating']);
$impersonatingFromEmail = $_SESSION['impersonating_from_email'] ?? null;

$ver = time(); // Cache busting

// --- TUTORIAL CHECK ---
$headers = function_exists('getallheaders') ? getallheaders() : [];
$showTutorial = false;
if (isset($_GET['tutorial']) || (isset($headers['X-Tutorial-Mode']) && $headers['X-Tutorial-Mode'] == 'true')) {
    $showTutorial = true;
}

// Stripe return params
$paidFlag = isset($_GET['paid']) ? $_GET['paid'] : null; // "1" or "0"
$showOnboarding = false;
if (isset($_GET['onboarding'])) {
    $showOnboarding = true;
} elseif (!empty($userOrgId) && function_exists('orgRead')) {
    $o = orgRead($userOrgId);
    if ($o && empty($o['onboarding_completed'])) {
        $creatorEmail = strtolower(trim((string)($o['created_by_email'] ?? '')));
        if ($creatorEmail === strtolower(trim($userEmail))) {
            $showOnboarding = true;
        }
    }
}

// First-time login: login.php sets $_SESSION['first_login'] = true for new users.
// Consume it immediately so it only fires on the very first page load.
if (!empty($_SESSION['first_login'])) {
    unset($_SESSION['first_login']);
    $showOnboarding = true;
}

session_write_close();

?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#d93025">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="application-name" content="FirstMate">
  <link rel="manifest" href="/portal/manifest.webmanifest">
  <link rel="icon" type="image/png" href="/images/icon.png">
  <link rel="apple-touch-icon" href="/images/icon.png">
  <title>FirstMate - Report Dashboard</title>
  <script>
  /*
   * Mid-wizard Back-button recovery.
   * Before navigating to Stripe the wizard saves its full state to
   * sessionStorage under ob_wizard_state, including a stripeSource field.
   * If the user presses Back instead of completing payment, they land here
   * without ?paid=1 or ?onboarding=1, so PHP won't include the wizard script.
   * This script runs synchronously in <head> — before a single pixel is
   * painted — detects that situation, and redirects via location.replace()
   * so the wizard loads and restores from the saved state automatically.
   * location.replace() keeps this hop invisible to browser history.
   */
  (function(){
    try {
      var p = new URLSearchParams(location.search);
      window.__FM_INITIAL_PORTAL_TAB = p.get('tab') || '';
      if (p.get('paid') === '1' || p.get('onboarding') === '1') return;
      var raw = sessionStorage.getItem('ob_wizard_state');
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && s.stripeSource) {
        p.set('onboarding', '1');
        location.replace('./?' + p.toString() + location.hash);
      }
    } catch(e){}
  })();
  </script>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="/fonts.css">

  <style>
    :root{
      /* Brand */
      --primary:#d93025;
      --primary-rgb:217,48,37;      /* <-- used for shadows */
      --primary-dark:#b0261e;
      --secondary:#111111;
      --on-primary:#ffffff;
      --on-primary-rgb:255,255,255;
      --primary-readable:#d93025;

      /* UI */
      --bg:#f0f2f5;
      --panel:#ffffff;
      --text:#202124;
      --muted:#5f6368;
      --border:#dadce0;
      --shadow:0 10px 30px rgba(0,0,0,0.08);
      --radius-xl:16px;
      --radius-lg:12px;
      --radius-md:10px;
      --sidebar:224px;
      --fm-visual-vh:100vh;
      --fm-visual-vw:100vw;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      height:var(--fm-visual-vh, 100vh);
      display:flex;
      overflow:hidden;
      background:var(--bg);
      color:var(--text);
      font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
    }

    .sidebar{
      position:relative;
      width:var(--sidebar);
      background:var(--panel);
      border-right:1px solid var(--border);
      display:flex;
      flex-direction:column;
      box-shadow:4px 0 16px rgba(0,0,0,0.05);
      z-index:2147483004;
    }

    /* TOP LEFT: logo only, no border, preserve aspect ratio */
    .logo-area{
      height:92px;
      display:flex;
      align-items:center;
      justify-content:flex-start;
      gap:10px;
      padding:0 16px;
      border-bottom:1px solid var(--border);
      min-width:0;
      --firstmate-cobrand-logo-width:82px;
      --company-cobrand-logo-max-height:54px;
    }
    .logo-area .firstmate-color-logo,
    .logo-area .cobrand-logo-divider{
      display:none;
    }
    .logo-area.cobrand-logo-enabled.has-company-logo .firstmate-color-logo{
      display:block;
      flex:0 0 auto;
      width:var(--firstmate-cobrand-logo-width);
      height:31px;
      background:var(--primary, #d93025);
      -webkit-mask:url('/images/logo_red.png') center / contain no-repeat;
      mask:url('/images/logo_red.png') center / contain no-repeat;
    }
    .logo-area.cobrand-logo-enabled.has-company-logo{
      display:grid;
      grid-template-columns:minmax(0,1fr) 1px minmax(0,1fr);
      column-gap:0;
      padding:0 10px;
    }
    .logo-area.cobrand-logo-enabled.has-company-logo .firstmate-color-logo{
      justify-self:center;
    }
    .logo-area.cobrand-logo-enabled.has-company-logo .cobrand-logo-divider{
      display:block;
      flex:0 0 auto;
      width:1px;
      height:32px;
      background:rgba(0,0,0,0.12);
      justify-self:center;
    }
    .logo-area img{
      display:block;
      width:auto;
      height:auto;
      max-width: 160px;
      max-height: 42px;
      min-width:0;
      flex:0 1 auto;
    }
    .logo-area.cobrand-logo-enabled.has-company-logo img{
      max-width:var(--firstmate-cobrand-logo-width);
      max-height:var(--company-cobrand-logo-max-height);
      object-fit:contain;
      justify-self:center;
    }
    .logo-area.default-firstmeasure-logo .firstmate-color-logo,
    .mobile-topbar .mob-logo.default-firstmeasure-logo::before{
      content:"";
      display:block;
      width:126px;
      height:48px;
      max-width:160px;
      max-height:48px;
      background:var(--primary, #d93025);
      -webkit-mask:url('/images/logo_red.png') center / contain no-repeat;
      mask:url('/images/logo_red.png') center / contain no-repeat;
    }
    .logo-area.default-firstmeasure-logo img,
    .mobile-topbar .mob-logo.default-firstmeasure-logo img{
      display:none!important;
    }

    .sidebar-scroll{
      padding:16px 14px calc(14px + env(safe-area-inset-bottom,0px));
      display:flex;
      flex-direction:column;
      gap:12px;
      overflow:auto;
      height:100%;
    }

    .sidebar-mode-tabs{
      display:none;
      grid-template-columns:1fr 1fr;
      gap:0;
      padding:0;
      border:1px solid rgba(0,0,0,0.07);
      border-bottom:0;
      background:#f7f8fa;
      border-radius:0;
    }

    .sidebar.todo-list-enabled .sidebar-mode-tabs{
      display:grid;
      margin:-16px -14px 0;
    }

    .sidebar-mode-tab{
      border:0;
      border-radius:0;
      background:transparent;
      color:#5f6368;
      cursor:pointer;
      font-size:12px;
      font-weight:950;
      line-height:1;
      min-height:28px;
      padding:0 10px;
      transition:.16s ease;
    }

    .sidebar-mode-tab:hover{
      color:#202124;
      background:#fff;
    }

    .sidebar-mode-tab.active{
      color:#202124;
      background:#fff;
      box-shadow:inset 0 -2px 0 var(--primary-readable, var(--primary, #d93025));
    }

    .sidebar-panel{
      display:none;
      min-height:0;
    }

    .sidebar-panel.active{
      display:flex;
      flex-direction:column;
      flex:1 1 auto;
      gap:14px;
    }

    #sidebarTodoPanel.active{
      gap:8px;
    }

    #sidebarTodoList{
      min-height:0;
      overflow:visible;
    }

    .btn-primary{
      background:var(--primary);
      color:var(--on-primary);
      border:none;
      border-radius:999px;
      padding:14px 14px;
      font-size:14px;
      font-weight:950;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:space-between;
      /* IMPORTANT: shadow now follows primary */
      box-shadow:0 10px 22px rgba(var(--primary-rgb),0.25);
      transition:.18s ease;
      user-select:none;
    }
    .btn-primary:hover{background:var(--primary-dark); transform:translateY(-1px)}
    .btn-primary:active{transform:translateY(0)}
    .new-menu-wrap{
      position:relative;
      z-index:20;
    }
    .new-menu-wrap .btn-primary{
      width:100%;
    }
    .new-menu-popout{
      position:fixed;
      top:var(--new-menu-top, 108px);
      left:var(--new-menu-left, calc(var(--sidebar) + 10px));
      width:188px;
      padding:7px;
      border:1px solid rgba(15,23,42,.10);
      border-radius:14px;
      background:rgba(255,255,255,.96);
      box-shadow:0 18px 42px rgba(15,23,42,.18);
      backdrop-filter:blur(14px);
      opacity:0;
      pointer-events:none;
      transform:translateX(-8px) scale(.98);
      transform-origin:left top;
      transition:opacity .16s ease,transform .18s cubic-bezier(.22,1,.36,1);
      z-index:2147483005;
    }
    .new-menu-wrap.open .new-menu-popout{
      opacity:1;
      pointer-events:auto;
      transform:translateX(0) scale(1);
    }
    .new-menu-item{
      width:100%;
      min-height:38px;
      border:0;
      border-radius:10px;
      background:transparent;
      color:#202124;
      cursor:pointer;
      display:flex;
      align-items:center;
      gap:10px;
      padding:0 10px;
      font-size:12px;
      font-weight:950;
      text-align:left;
      transition:.14s ease;
    }
    .new-menu-item:hover{
      background:rgba(var(--primary-rgb),.07);
      color:var(--primary-readable,var(--primary));
    }
    .new-menu-item i{
      width:18px;
      text-align:center;
      color:inherit;
      opacity:.9;
    }

    .credits-card{
      border:1px solid rgba(0,0,0,0.06);
      border-radius:18px;
      padding:14px 14px 12px;
      box-shadow:0 12px 28px rgba(0,0,0,0.05);
      background:#fff;
    }
    .credits-top{display:flex; align-items:center; justify-content:space-between; margin-bottom:6px}
    .credits-label{font-size:11px; font-weight:950; color:#777; letter-spacing:.5px; text-transform:uppercase}
    .credits-value{font-size:28px; font-weight:1000; letter-spacing:-.3px}
    .credits-sub{margin-top:6px; font-size:12px; color:#777; font-weight:800; line-height:1.35}
    .btn-ghost{
      margin-top:10px;
      width:100%;
      border-radius:14px;
      border:1px solid var(--border);
      background:#fff;
      padding:12px;
      font-weight:950;
      cursor:pointer;
      color:#333;
      display:inline-flex;
      align-items:center;
      justify-content:space-between;
      transition:.18s ease;
    }
    .btn-ghost:hover{border-color:var(--primary-readable); color:var(--primary-readable)}


    #sidebarLinks{
      margin-top: 10px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      padding: 0 6px;
    }

    .sidebar-footer{
      margin-top:auto;
      padding-top:14px;
      border-top:1px solid rgba(0,0,0,0.06);
      font-size:12px;
      color:#999;
      text-align:center;
      line-height:1.35;
    }
    .sidebar-footer strong{color:#666}
    .sidebar-footer .who{ color:#666; font-weight:950; }
    .sidebar-footer .co{ color:#777; font-weight:850; }
    .sidebar-footer .em{ color:#666; font-weight:900; }

    .main{
      flex:1;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      min-width:0;
    }
    .platform-topbar{
      height:46px;
      flex:0 0 46px;
      display:flex;
      align-items:center;
      justify-content:flex-end;
      gap:12px;
      padding:0 18px;
      background:rgba(255,255,255,.94);
      border-bottom:1px solid rgba(0,0,0,.06);
      position:relative;
      isolation:isolate;
      z-index:2147483000;
    }
    .platform-search{
      position:relative;
      width:min(440px, 46vw);
    }
    .platform-search i{
      position:absolute;
      left:12px;
      top:50%;
      transform:translateY(-50%);
      color:#8a94a3;
      font-size:13px;
      pointer-events:none;
    }
    .platform-search input{
      width:100%;
      height:32px;
      border:1px solid rgba(0,0,0,.10);
      border-radius:999px;
      padding:0 12px 0 34px;
      outline:none;
      font-size:13px;
      font-weight:850;
      background:#f8fafc;
      color:#202124;
    }
    .platform-search input:focus{
      background:#fff;
      border-color:rgba(var(--primary-rgb),.45);
      box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10);
    }
    .ptb-search-results{
      display:none;
      position:absolute;
      top:38px;
      left:0;
      right:0;
      background:#fff;
      border:1px solid rgba(15,23,42,.10);
      border-radius:14px;
      box-shadow:0 18px 42px rgba(15,23,42,.16);
      overflow:auto;
      max-height:min(70vh, 520px);
      z-index:2147483001;
    }
    .ptb-search-results.visible{display:block}
    .ptb-search-item{
      width:100%;
      border:0;
      background:#fff;
      padding:10px 12px;
      display:flex;
      align-items:center;
      gap:10px;
      text-align:left;
      cursor:pointer;
      color:#202124;
    }
    .ptb-search-item:hover{background:#f8fafc}
    .ptb-search-item i{position:static;transform:none;color:#64748b}
    .ptb-search-item .ptb-search-kind{
      width:28px;
      height:28px;
      border-radius:999px;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 28px;
      font-size:12px;
      background:#eef2ff;
      color:#334155;
    }
    .ptb-search-item.project .ptb-search-kind{background:#eef2ff;color:#3730a3}
    .ptb-search-item.contact .ptb-search-kind{background:#ecfdf3;color:#047857}
    .ptb-search-item span{display:flex;flex-direction:column;gap:2px;min-width:0}
    .ptb-search-item strong{font-size:12px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ptb-search-item small{font-size:11px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ptb-search-item small b{font-weight:1000;color:#344054}
    .platform-notifications{position:relative;z-index:2147483002}
    .ptb-bell{
      width:34px;
      height:34px;
      border-radius:999px;
      border:1px solid rgba(0,0,0,.10);
      background:#fff;
      color:#344054;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      position:relative;
    }
    .ptb-bell:hover{color:var(--primary-readable);border-color:rgba(var(--primary-rgb),.28)}
    .ptb-count{
      display:none;
      position:absolute;
      top:-5px;
      right:-5px;
      min-width:17px;
      height:17px;
      padding:0 5px;
      border-radius:999px;
      background:var(--primary,#d93025);
      color:#fff;
      font-size:10px;
      font-weight:1000;
      align-items:center;
      justify-content:center;
      line-height:17px;
    }
    .ptb-count.visible{display:flex}
    .ptb-count.has-unread{box-shadow:0 0 0 2px #fff, 0 0 0 5px rgba(var(--primary-rgb),.18)}
    .ptb-menu{
      display:block;
      position:absolute;
      top:48px;
      right:0;
      width:min(380px, 86vw);
      max-height:460px;
      overflow:auto;
      background:#fff;
      border:1px solid rgba(15,23,42,.10);
      border-radius:16px;
      box-shadow:0 24px 60px rgba(15,23,42,.18);
      z-index:2147483003;
      opacity:0;
      visibility:hidden;
      pointer-events:none;
      transform:translateY(-8px) scale(.985);
      transform-origin:top right;
      transition:opacity .16s ease,transform .18s cubic-bezier(.22,1,.36,1),visibility 0s linear .18s;
    }
    .ptb-menu.visible{
      opacity:1;
      visibility:visible;
      pointer-events:auto;
      transform:translateY(0) scale(1);
      transition:opacity .16s ease,transform .18s cubic-bezier(.22,1,.36,1),visibility 0s;
    }
    .ptb-menu-head{padding:13px 14px;border-bottom:1px solid rgba(15,23,42,.08);font-size:13px;font-weight:1000;color:#101828;display:flex;align-items:center;justify-content:space-between;gap:10px}
    .ptb-menu-head small{font-size:11px;font-weight:900;color:#667085}
    .ptb-note{padding:12px 14px;border-bottom:1px solid rgba(15,23,42,.06);display:flex;gap:10px;align-items:flex-start;cursor:pointer;position:relative;background:#fff}
    .ptb-note.unread{background:rgba(var(--primary-rgb),.055)}
    .ptb-note.unread::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:99px;background:var(--primary,#d93025)}
    .ptb-note.seen{opacity:.78}
    .ptb-note.lead-note .ptb-note-main strong{color:var(--primary-readable,#d93025)}
    .ptb-note:hover{background:#f8fafc}
    .ptb-note-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
    .ptb-note-main strong{font-size:13px;color:#101828}
    .ptb-note-main span{font-size:12px;line-height:1.4;color:#667085;font-weight:750}
    .ptb-note-dismiss{border:1px solid rgba(15,23,42,.12);background:#fff;border-radius:999px;padding:6px 9px;font-size:11px;font-weight:950;cursor:pointer;color:#344054}
    .ptb-empty{padding:18px;text-align:center;color:#667085;font-size:12px;font-weight:850}
    .main-panels{
      flex:1;
      min-height:0;
      overflow:auto;
      padding:22px;
    }

    /* ============================================
       MOBILE TOP BAR (hidden on desktop)
       ============================================ */
    .mobile-topbar{
      display:none;
    }
    .mobile-platform-search{
      display:none;
    }
    .sidebar-backdrop{
      display:none;
    }

    /* ============================================
       MOBILE STYLES — max-width: 820px
       ============================================ */
    @media (max-width: 820px){
      body{
        flex-direction:column;
        overflow:hidden;
      }

      /* --- Mobile top bar --- */
      .mobile-topbar{
        display:flex;
        align-items:center;
        justify-content:space-between;
        height:56px;
        padding:0 14px;
        background:var(--panel);
        border-bottom:1px solid var(--border);
        box-shadow:0 2px 8px rgba(0,0,0,0.06);
        z-index:20;
        flex-shrink:0;
      }
      .mobile-topbar.topbar-enabled{
        height:104px;
        flex-wrap:wrap;
        align-content:center;
        gap:8px 10px;
        padding:8px 14px;
      }
      .mobile-topbar .mob-hamburger{
        width:40px; height:40px;
        display:flex; align-items:center; justify-content:center;
        background:none; border:none; cursor:pointer;
        font-size:20px; color:#333;
        border-radius:10px;
        transition:.14s ease;
      }
      .mobile-topbar .mob-hamburger:hover{background:rgba(0,0,0,0.05)}
      .mobile-topbar .mob-logo{min-width:0;text-align:center;display:flex;align-items:center;justify-content:center}
      .mobile-topbar .mob-logo img{
        height:28px; width:auto; display:block;
      }
      .mobile-topbar .mob-tab-title{
        display:none;
        max-width:48vw;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        color:#202124;
        font-size:17px;
        font-weight:1000;
        line-height:1.1;
      }
      .mobile-topbar.has-tab-title .mob-logo img{display:none!important}
      .mobile-topbar.has-tab-title .mob-tab-title{display:block}
      .mobile-topbar .mob-new-req{
        min-width:40px; height:40px;
        padding:0 12px;
        display:flex; align-items:center; justify-content:center;
        gap:6px;
        background:var(--primary); color:var(--on-primary); border:none;
        border-radius:12px; cursor:pointer; font-size:16px;
        box-shadow:0 4px 12px rgba(var(--primary-rgb),0.3);
        transition:.14s ease;
        font-weight:950;
      }
      .mobile-topbar .mob-new-req span{
        font-size:12px;
        letter-spacing:.01em;
        white-space:nowrap;
      }
      .mobile-topbar .mob-new-req:active{transform:scale(0.95)}
      .mobile-topbar .mob-notifications{
        display:none;
        position:relative;
      }
      .mobile-topbar.topbar-enabled .mob-new-req{display:none}
      .mobile-topbar.topbar-enabled .mob-notifications{display:block}
      .mobile-topbar.topbar-enabled .mobile-platform-search{
        display:block;
        order:4;
        flex:0 0 100%;
        width:100%;
      }
      .mobile-platform-search input{
        height:36px;
        font-size:14px;
      }
      .mobile-platform-search .ptb-search-results{
        top:42px;
        max-height:calc(var(--fm-visual-vh, 100dvh) - 120px);
        border-radius:12px;
      }
      body.mobile-notifications-open::after{
        content:"";
        position:fixed;
        inset:104px 0 0;
        background:rgba(15,23,42,.22);
        z-index:19;
        pointer-events:auto;
      }
      .mobile-topbar .ptb-bell{
        width:40px;
        height:40px;
        border:0;
        border-radius:0;
        background:transparent;
        box-shadow:none;
        color:#333;
        font-size:20px;
        padding:0;
      }
      .mobile-topbar .ptb-bell:hover{background:transparent;border-color:transparent;color:#333}
      .mobile-topbar .ptb-menu{
        top:52px;
        right:0;
        width:min(360px, calc(100vw - 28px));
        height:calc(var(--fm-visual-vh, 100dvh) - 74px);
        max-height:calc(var(--fm-visual-vh, 100dvh) - 74px);
      }

      /* --- Sidebar as slide-out overlay --- */
      .sidebar{
        position:fixed;
        top:0; left:0; bottom:auto;
        height:var(--fm-visual-vh, 100dvh);
        max-height:var(--fm-visual-vh, 100dvh);
        width:min(320px, 85vw);
        z-index:1000;
        transform:translateX(-100%);
        transition:transform .24s cubic-bezier(.4,0,.2,1);
        box-shadow:none;
      }
      .sidebar.mob-open{
        transform:translateX(0);
        box-shadow:8px 0 30px rgba(0,0,0,0.18);
      }
      .sidebar.mob-open .new-menu-popout{
        display:none;
        position:static;
        width:100%;
        margin-top:8px;
        transform:translateY(-6px) scale(.98);
        transform-origin:top center;
      }
      .sidebar.mob-open .new-menu-wrap.open .new-menu-popout{
        display:block;
        transform:translateY(0) scale(1);
      }

      /* --- Backdrop --- */
      .sidebar-backdrop{
        display:none;
        position:fixed;
        inset:0;
        background:rgba(0,0,0,0.45);
        z-index:999;
        opacity:0;
        transition:opacity .24s ease;
      }
      .sidebar-backdrop.active{
        display:block;
        opacity:1;
      }

      /* --- Main content fills remaining space --- */
      .main{
        flex:1;
        overflow:hidden;
      }
      .platform-topbar{display:none}
      .main-panels{
        padding:12px;
        overflow:auto;
        -webkit-overflow-scrolling:touch;
      }

      .logo-area{
        height:68px;
        padding:0 18px;
        --firstmate-cobrand-logo-width:84px;
        --company-cobrand-logo-max-height:42px;
      }
      .logo-area.cobrand-logo-enabled.has-company-logo .firstmate-color-logo{
        height:32px;
      }
      .logo-area.cobrand-logo-enabled.has-company-logo .cobrand-logo-divider{
        height:28px;
      }
      .logo-area img{
        max-height:32px;
      }
      .logo-area.default-firstmeasure-logo .firstmate-color-logo,
      .mobile-topbar .mob-logo.default-firstmeasure-logo::before{
        width:114px;
        height:32px;
        max-height:32px;
      }
      .sidebar-scroll{
        padding-bottom:calc(26px + env(safe-area-inset-bottom,0px));
        overscroll-behavior:contain;
        -webkit-overflow-scrolling:touch;
      }
    }
  </style>

  <script>
      
    window.__APP = {
      userName: <?= json_encode($userName) ?>,
      userEmail: <?= json_encode($userEmail) ?>,
      userCompany: <?= json_encode($userCompany) ?>,
      userOrgId: <?= json_encode($userOrgId) ?>,
      userBranchId: <?= json_encode($userBranchId) ?>,
      showTutorial: <?= $showTutorial ? 'true' : 'false' ?>,
      stripePaidFlag: <?= ($paidFlag === null ? 'null' : json_encode($paidFlag)) ?>,
      serverEndpoint: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.protocol}//${location.hostname}:3111/v1/platform/portal-action`;
        }
        return `${location.origin}/v1/platform/portal-action`;
      })(),
      platformApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.protocol}//${location.hostname}:3111/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
      })(),
      emailApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.protocol}//${location.hostname}:3111/v1/email`;
        }
        return `${location.origin}/v1/email`;
      })(),
      leadIntakeApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.protocol}//${location.hostname}:3111/v1/lead-intake`;
        }
        return `${location.origin}/v1/lead-intake`;
      })(),
      canvassingApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.protocol}//${location.hostname}:3111/v1/canvassing`;
        }
        return `${location.origin}/v1/canvassing`;
      })(),
      roofCost: 7,
      gutterReportAddon: 2,
        isImpersonating: <?= $isImpersonating ? 'true' : 'false' ?>,
        realAdminEmail: <?= json_encode($impersonatingFromEmail) ?>,
        showOnboarding: <?= json_encode($showOnboarding) ?>,
    };

    (function(){
      const DEFAULT_LOGO = '/images/logo_red.png';
      const LS_KEY = 'fm_org_theme_v1';
      let currentTheme = null;

      function hexToRgbCSV(hex){
        try{
          let h = String(hex||'').trim().toUpperCase();
          if (!h.startsWith('#')) h = '#'+h;
          if (!/^#[0-9A-F]{6}$/.test(h)) return '217,48,37';
          const r = parseInt(h.slice(1,3),16);
          const g = parseInt(h.slice(3,5),16);
          const b = parseInt(h.slice(5,7),16);
          return `${r},${g},${b}`;
        }catch(e){ return '217,48,37'; }
      }
        
        function hexToRgb(hex){
          try{
            let h = String(hex||'').trim().toUpperCase();
            if (!h.startsWith('#')) h = '#'+h;
            if (!/^#[0-9A-F]{6}$/.test(h)) return {r:217,g:48,b:37};
            return {
              r: parseInt(h.slice(1,3),16),
              g: parseInt(h.slice(3,5),16),
              b: parseInt(h.slice(5,7),16)
            };
          }catch(e){ return {r:217,g:48,b:37}; }
        }

        /**
         * Compute relative luminance (WCAG 2.x formula).
         * Returns 0 (black) to 1 (white).
         */
        function relativeLuminance(r, g, b){
          const sRGB = [r/255, g/255, b/255];
          const lin = sRGB.map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4));
          return 0.2126*lin[0] + 0.7152*lin[1] + 0.0722*lin[2];
        }

        /**
         * Determine the best text color to use ON a given background.
         * Returns '#ffffff' or '#111111'.
         */
        function contrastTextFor(hex){
          const {r,g,b} = hexToRgb(hex);
          const lum = relativeLuminance(r,g,b);
          return lum > 0.40 ? '#111111' : '#ffffff';
        }

        /**
         * Create a "readable" version of a color for use AS text on white/light backgrounds.
         * If the color is too light to read on white, darken it until contrast >= 3.5:1.
         */
        function readableOnWhite(hex){
          const {r,g,b} = hexToRgb(hex);
          const bgLum = 1.0; // white background
          const fgLum = relativeLuminance(r,g,b);
          const ratio = (bgLum + 0.05) / (fgLum + 0.05);
          if (ratio >= 3.5) return hex;
          let dr=r, dg=g, db=b;
          for (let i = 0; i < 20; i++){
            dr = Math.max(0, Math.round(dr * 0.85));
            dg = Math.max(0, Math.round(dg * 0.85));
            db = Math.max(0, Math.round(db * 0.85));
            const newLum = relativeLuminance(dr,dg,db);
            const newRatio = (bgLum + 0.05) / (newLum + 0.05);
            if (newRatio >= 3.5) break;
          }
          const toHex = n => n.toString(16).padStart(2,'0').toUpperCase();
          return '#' + toHex(dr) + toHex(dg) + toHex(db);
        }

      function darken(hex, amt){
        try{
          let h = String(hex||'').trim().toUpperCase();
          if (!h.startsWith('#')) h = '#'+h;
          if (!/^#[0-9A-F]{6}$/.test(h)) return '#b0261e';
          const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
          const d = (n)=>Math.max(0,Math.min(255,Math.round(n*(1-amt)))).toString(16).padStart(2,'0').toUpperCase();
          return '#'+d(r)+d(g)+d(b);
        }catch(e){ return '#b0261e'; }
      }

      function platformApiBaseUrl(){
        const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
        if (configured) return configured;
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') return '';
        return `${location.origin}/v1/platform`;
      }

      function portalAssetUrl(url){
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
        if (raw.startsWith('/v1/')) {
          try { return new URL(raw, platformApiBaseUrl()).href; } catch(e) { return raw; }
        }
        if (raw.startsWith('/')) return raw;
        if (raw.startsWith('organizations/')) {
          const base = platformApiBaseUrl();
          return base ? `${base}/${raw}` : '';
        }
        return raw;
      }

      function cacheBustUrl(url){
        if (!url || /^(data:|blob:)/i.test(url)) return url;
        return url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
      }

      function withoutCacheBust(url){
        const raw = String(url || '').trim();
        if (!raw) return '';
        try {
          const parsed = new URL(raw, location.href);
          parsed.searchParams.delete('v');
          return parsed.href;
        } catch(e) {
          return raw.replace(/([?&])v=[^&#]*(&?)/, (match, prefix, suffix) => suffix ? prefix : '');
        }
      }

      function appFlagEnabled(group, flag){
        const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
        if (!flags?.current?.()) return false;
        return !!flags.has?.(group, flag);
      }

      function setSidebarCompanyLogoPresent(hasLogo){
        const area = document.querySelector('.logo-area');
        area?.classList.toggle('has-company-logo', !!hasLogo);
      }

      function setDefaultLogoPresent(enabled){
        document.querySelector('.logo-area')?.classList.toggle('default-firstmeasure-logo', !!enabled);
        document.querySelector('.mobile-topbar .mob-logo')?.classList.toggle('default-firstmeasure-logo', !!enabled);
      }

      function applySidebarCobrandLogoFlag(){
        const enabled = appFlagEnabled('platform', 'cobrand_sidebar_logo');
        const area = document.querySelector('.logo-area');
        area?.classList.toggle('cobrand-logo-enabled', enabled);
      }

      function setLogo(src){
        /* Set both desktop sidebar logo and mobile topbar logo */
        const requestedSrc = String(src || '').trim();
        const useDefaultLogo = !requestedSrc || requestedSrc === DEFAULT_LOGO;
        const resolvedSrc = useDefaultLogo ? DEFAULT_LOGO : portalAssetUrl(requestedSrc);
        const targets = ['companyLogoImg', 'mobLogoImg'];
        for (const tid of targets){
          const img = document.getElementById(tid);
          if (!img) continue;
          img.onerror = null;
          if (tid === 'companyLogoImg') setDefaultLogoPresent(useDefaultLogo);
          if (!resolvedSrc){
            img.removeAttribute('src');
            img.style.display = 'none';
            if (tid === 'companyLogoImg') setSidebarCompanyLogoPresent(false);
            continue;
          }
          if (useDefaultLogo) {
            img.removeAttribute('src');
            img.style.display = 'none';
            if (tid === 'companyLogoImg') setSidebarCompanyLogoPresent(false);
            continue;
          }
          img.onerror = function(){
            img.removeAttribute('src');
            img.style.display = 'none';
            if (tid === 'companyLogoImg') setDefaultLogoPresent(true);
            if (tid === 'companyLogoImg') setSidebarCompanyLogoPresent(false);
          };
          if (withoutCacheBust(img.src) === withoutCacheBust(resolvedSrc)) {
            img.style.display = 'block';
            if (tid === 'companyLogoImg') setSidebarCompanyLogoPresent(true);
            continue;
          }
          img.src = cacheBustUrl(resolvedSrc);
          img.style.display = 'block';
          if (tid === 'companyLogoImg') setSidebarCompanyLogoPresent(true);
        }
      }

      function mediaLogoUrl(orgId, mediaId){
        const id = String(mediaId || '').trim();
        if (!id) return '';
        if (window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId, id, 'original');
        const base = platformApiBaseUrl();
        return base ? `${base}/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(id)}/file?variant=original` : '';
      }

      function logoFromBranding(branding, orgId){
        const b = branding && typeof branding === 'object' ? branding : {};
        const canonicalLogo = String(b.logo || '').trim();
        if (/^(https?:|blob:|data:|\/v1\/)/i.test(canonicalLogo)) return portalAssetUrl(canonicalLogo);
        if (b.logo_media_id) return mediaLogoUrl(orgId, b.logo_media_id);
        return portalAssetUrl(
          b.logo_node_url
          || b.logoNodeUrl
          || b.logo_url
          || b.logoUrl
          || b.companyLogo
          || b.brandLogo
          || canonicalLogo
          || ''
        );
      }

      function shouldReplaceLogo(currentLogo, candidateLogo){
        const current = String(currentLogo || '').trim();
        const candidate = String(candidateLogo || '').trim();
        if (!candidate) return false;
        if (!current) return true;
        const currentIsMigrated = current.includes('/v1/platform/') || current.includes('/media/');
        const candidateIsLegacy = candidate.includes('/organizations/') && !candidate.includes('/media/');
        return !(currentIsMigrated && candidateIsLegacy);
      }

      function publishTheme(theme){
        currentTheme = {
          name: theme.companyName || theme.name || '',
          logo: portalAssetUrl(theme.logo || '') || DEFAULT_LOGO,
          primary: theme.primary || '#d93025',
          secondary: theme.secondary || '#111111',
          branchId: theme.branchId || window.__APP?.userBranchId || 'default',
          orgId: theme.orgId || window.__APP?.userOrgId || ''
        };
        window.__APP = window.__APP || {};
        window.__APP.theme = currentTheme;
        window.Portal = window.Portal || {};
        window.Portal.currentTheme = currentTheme;
        window.dispatchEvent(new CustomEvent('fm:theme:updated', { detail: currentTheme }));
      }

      function applyTheme({ companyName, logo, primary, secondary }){
        const p = primary || '#d93025';
        const s = secondary || '#111111';
        const onPrimary = contrastTextFor(p);
        const onPrimaryRgb = hexToRgbCSV(onPrimary);
        const readable = readableOnWhite(p);

        document.documentElement.style.setProperty('--primary', p);
        document.documentElement.style.setProperty('--primary-rgb', hexToRgbCSV(p));
        document.documentElement.style.setProperty('--primary-dark', darken(p, 0.16));
        document.documentElement.style.setProperty('--secondary', s);
        document.documentElement.style.setProperty('--on-primary', onPrimary);
        document.documentElement.style.setProperty('--on-primary-rgb', onPrimaryRgb);
        document.documentElement.style.setProperty('--primary-readable', readable);

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', p);

        setLogo(logo || '');
        publishTheme({ companyName, logo, primary: p, secondary: s });

        const who = document.getElementById('whoName');
        const co  = document.getElementById('whoCompany');
        const em  = document.getElementById('whoEmail');
        if (who) who.textContent = (window.__APP.userName || '');
        if (em) em.textContent = (window.__APP.userEmail || '');
        if (co) co.textContent = (companyName || window.__APP.userCompany || '');
      }

      function cachedThemeMatchesSession(theme){
        if (!theme || typeof theme !== 'object') return false;
        const currentOrgId = String(window.__APP?.userOrgId || '').trim();
        const currentBranchId = String(window.__APP?.userBranchId || 'default').trim() || 'default';
        const cachedOrgId = String(theme.orgId || '').trim();
        const cachedBranchId = String(theme.branchId || 'default').trim() || 'default';
        if (currentOrgId && cachedOrgId && currentOrgId !== cachedOrgId) return false;
        if (currentBranchId && cachedBranchId && currentBranchId !== cachedBranchId) return false;
        return true;
      }

      // 1) cache first (instant)
      try{
        const raw = localStorage.getItem(LS_KEY);
        if (raw){
          const t = JSON.parse(raw);
          if (cachedThemeMatchesSession(t)){
            applyTheme({
              companyName: t.name || '',
              logo: t.logo || null,
              primary: t.primary || t.accent || '#d93025',
              secondary: t.secondary || '#111111'
            });
          } else {
            applyTheme({ companyName:'', logo:null, primary:'#d93025', secondary:'#111111' });
          }
        } else {
          applyTheme({ companyName:'', logo:null, primary:'#d93025', secondary:'#111111' });
        }
      }catch(e){
        applyTheme({ companyName:'', logo:null, primary:'#d93025', secondary:'#111111' });
      }

      // 2) Reusable server fetch + apply
      async function hydrateThemeFromPlatformApi(theme, org){
        const orgId = String(window.__APP?.userOrgId || org?.id || theme.orgId || '').trim();
        const branchId = String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || org?.branch_id || theme.branchId || 'default').trim() || 'default';
        if (!orgId || !window.PlatformAPI) return { ...theme, orgId, branchId };
        const next = { ...theme, orgId, branchId };
        try {
          if (window.PlatformAPI.branches?.get) {
            const branchResp = await window.PlatformAPI.branches.get(orgId, branchId);
            const branch = branchResp?.document?.data || branchResp?.data || {};
            const branchBranding = branch.branding || {};
            const branchColors = branchBranding.colors || {};
            if (branch.name) next.name = branch.name;
            const branchLogo = logoFromBranding(branchBranding, orgId);
            if (shouldReplaceLogo(next.logo, branchLogo)) next.logo = branchLogo;
            if (branchColors.primary || branchColors.accent) next.primary = branchColors.primary || branchColors.accent;
            if (branchColors.secondary) next.secondary = branchColors.secondary;
          }
        } catch(e) {}
        try {
          if (window.PlatformAPI.branchModules?.get) {
            const styleModule = await window.PlatformAPI.branchModules.get(orgId, branchId, 'presentation_style');
            const style = styleModule?.data || {};
            const styleBranding = style.branding || {};
            const styleColors = styleBranding.colors || {};
            if (style.companyName) next.name = style.companyName;
            const styleLogo = logoFromBranding(styleBranding, orgId) || portalAssetUrl(style.logoUrl || style.companyLogo || style.logo || '');
            if (shouldReplaceLogo(next.logo, styleLogo)) next.logo = styleLogo;
            if (styleColors.primary || styleColors.accent) next.primary = styleColors.primary || styleColors.accent;
            if (styleColors.secondary) next.secondary = styleColors.secondary;
          }
        } catch(e) {}
        return next;
      }

      async function fetchAndApplyTheme(){
        try{
          const cached = (() => {
            try {
              const parsed = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
              return cachedThemeMatchesSession(parsed) ? parsed : null;
            } catch(e) { return null; }
          })();
          const fd = new FormData();
          fd.append('action','org_get_my');
          fd.append('actor_email', window.__APP?.userEmail || '');
          fd.append('actor_name', window.__APP?.userName || '');
          fd.append('actor_org_id', window.__APP?.userOrgId || '');
          const res = await fetch(window.__APP.serverEndpoint, { method:'POST', body: fd });
          let data = res.ok ? await res.json().catch(()=>null) : null;
          if ((!data || !data.success || !data.org) && cached && typeof cached === 'object') {
            data = {
              success: true,
              org: {
                id: cached.orgId || window.__APP?.userOrgId || '',
                branch_id: cached.branchId || window.__APP?.userBranchId || 'default',
                name: cached.name || window.__APP?.userCompany || '',
                branding: {
                  logo: cached.logo || '',
                  colors: { primary: cached.primary || '', secondary: cached.secondary || '' }
                }
              }
            };
          }
          if (!data || !data.success || !data.org) {
            data = {
              success: true,
              org: {
                id: window.__APP?.userOrgId || '',
                branch_id: window.__APP?.userBranchId || 'default',
                name: window.__APP?.userCompany || '',
                branding: { colors: { primary: '#d93025', secondary: '#111111' } }
              }
            };
          }

          const o = data.org;
          const orgId = String(window.__APP?.userOrgId || o.id || '').trim();
          const branding = o?.branding || {};
          const colors = branding.colors || {};
          const baseTheme = {
            name: o.name || '',
            logo: logoFromBranding(branding, orgId),
            primary: colors.primary || colors.accent || '#d93025',
            secondary: colors.secondary || '#111111',
            orgId,
            branchId: o.branch_id || window.__APP?.userBranchId || 'default'
          };
          const theme = await hydrateThemeFromPlatformApi(baseTheme, o);

          applyTheme({ companyName: theme.name, logo: theme.logo, primary: theme.primary, secondary: theme.secondary });

          try{
            if (theme.primary || theme.secondary || theme.logo || theme.name) {
              localStorage.setItem(LS_KEY, JSON.stringify({ name: theme.name, logo: theme.logo, primary: theme.primary, secondary: theme.secondary, orgId: theme.orgId, branchId: theme.branchId }));
            }
          }catch(e){}
        }catch(e){}
      }

      // Initial server fetch
      fetchAndApplyTheme();
      document.addEventListener('DOMContentLoaded', () => {
        applySidebarCobrandLogoFlag();
        if (currentTheme) {
          applyTheme({ companyName: currentTheme.name, logo: currentTheme.logo, primary: currentTheme.primary, secondary: currentTheme.secondary });
        }
      });
      window.addEventListener('load', () => setTimeout(fetchAndApplyTheme, 0));
      window.addEventListener('fm:app-flags:updated', applySidebarCobrandLogoFlag);
      window.addEventListener('fm:app-flags:failed', applySidebarCobrandLogoFlag);

      // Expose to window — MUST be inside this IIFE where applyTheme etc. are in scope
      window.__refreshTheme = fetchAndApplyTheme;
      window.__applyTheme = (theme) => applyTheme({ companyName: theme?.name || theme?.companyName || '', logo: theme?.logo || '', primary: theme?.primary || theme?.accent, secondary: theme?.secondary });
      window.__themeContrast = { contrastTextFor, readableOnWhite, hexToRgbCSV };
    })();
  </script>
    <!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-W7MP6MZNMZ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-W7MP6MZNMZ');
</script>
</head>
<body>
  <?php if ($showOnboarding || $paidFlag === '1'): ?>
  <!--
    Instant full-screen cover: prevents the main dashboard from flashing
    before the onboarding wizard JS mounts its overlay. Rendered as raw
    HTML so it's painted on the very first frame with no JS needed.
    The wizard removes it in boot() once the overlay is in place, or
    immediately if it decides not to show (e.g. ?paid=1 without the
    sessionStorage resume flag).
  -->
  <div id="obPrecover" style="position:fixed;inset:0;z-index:2147483600;background:#f5f6f8;"></div>
  <?php endif; ?>
    <?php if ($isImpersonating): ?>
    <div id="impersonationBanner" style="
        position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
        background: linear-gradient(135deg, #ff6f00, #e65100);
        color: #fff; padding: 10px 20px;
        display: flex; align-items: center; justify-content: center; gap: 16px;
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 13px; font-weight: 700;
        box-shadow: 0 3px 12px rgba(230, 81, 0, 0.4);
        letter-spacing: 0.3px;
    ">
        <i class="fas fa-user-secret" style="font-size: 16px;"></i>
        <span>
            SUPPORT MODE — Viewing as
            <strong style="text-decoration:underline;"><?= htmlspecialchars($userEmail ?? '') ?></strong>
            &nbsp;(Admin: <?= htmlspecialchars($impersonatingFromEmail ?? '') ?>)
        </span>
        <button onclick="stopImpersonating()" style="
            background: #fff; color: #e65100; border: none;
            border-radius: 6px; padding: 6px 16px;
            font-weight: 800; font-size: 12px; cursor: pointer;
            box-shadow: 0 2px 6px rgba(0,0,0,0.15);
            transition: .15s;
        " onmouseover="this.style.background='#fff3e0'" onmouseout="this.style.background='#fff'">
            <i class="fas fa-sign-out-alt"></i> End Session
        </button>
    </div>
    <style>
        /* Push everything below the banner */
        body { padding-top: 44px !important; }
        .mobile-topbar { top: 44px !important; }
        .sidebar { top: 44px !important; height: calc(var(--fm-visual-vh, 100vh) - 44px) !important; }
    </style>
    <script>
    async function stopImpersonating() {
        try {
            const fd = new FormData();
            fd.append('action', 'admin_stop_impersonation');
            fd.append('actor_email', window.__APP?.userEmail || '');
            fd.append('actor_name', window.__APP?.userName || '');
            fd.append('actor_org_id', window.__APP?.userOrgId || '');
            const res = await fetch(window.__APP?.serverEndpoint, {
                method: 'POST',
                credentials: 'include',
                body: fd
            });
            const data = await res.json();
            if (data.success) {
                // Flush the cached org theme so customer branding doesn't persist
                try { localStorage.removeItem('fm_org_theme_v1'); } catch(e){}
                if (data.restored) {
                    window.location.reload();
                } else {
                    window.location.href = 'logout.php';
                }
            } else {
                (window.PlatformUI?.alert || window.alert)('Error: ' + (data.error || 'Unknown'));
            }
        } catch (e) {
            (window.PlatformUI?.alert || window.alert)('Connection error');
        }
    }
    </script>
    <?php endif; ?>

  <!-- ====== MOBILE TOP BAR (hidden on desktop) ====== -->
  <div class="mobile-topbar">
    <button class="mob-hamburger" id="mobMenuBtn" aria-label="Open menu">
      <i class="fas fa-bars"></i>
    </button>
    <div class="mob-logo">
      <img id="mobLogoImg" alt="Logo" style="display:none">
      <span class="mob-tab-title" id="mobTabTitle"></span>
    </div>
    <button class="mob-new-req" id="mobNewReqBtn" aria-label="New" data-fm-tooltip="New" data-fm-track="new_project_clicked" data-fm-track-source="mobile_topbar">
      <i class="fas fa-plus"></i>
      <span>New</span>
    </button>
    <div class="platform-search mobile-platform-search">
      <i class="fas fa-search"></i>
      <input id="mobilePlatformGlobalSearch" data-platform-search-input type="search" placeholder="Search projects and contacts" autocomplete="off">
      <div class="ptb-search-results" id="mobilePlatformSearchResults"></div>
    </div>
    <div class="mob-notifications platform-notifications" id="mobilePlatformNotifications" hidden>
      <button type="button" class="ptb-bell" id="mobilePlatformBell" data-fm-tooltip="Notifications" aria-label="Notifications">
        <i class="fas fa-bell"></i>
        <span class="ptb-count" id="mobilePlatformNotificationCount">0</span>
      </button>
      <div class="ptb-menu" id="mobilePlatformNotificationMenu">
        <div class="ptb-menu-head">Notifications</div>
        <div id="mobilePlatformNotificationList"><div class="ptb-empty">Loading...</div></div>
      </div>
    </div>
  </div>

  <!-- ====== SIDEBAR BACKDROP (mobile only) ====== -->
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>

  <aside class="sidebar" id="mainSidebar">
    <div class="logo-area">
      <span class="firstmate-color-logo" role="img" aria-label="FirstMate"></span>
      <span class="cobrand-logo-divider" aria-hidden="true"></span>
      <img id="companyLogoImg" alt="Logo" style="display:none">
    </div>

    <div class="sidebar-scroll">
      <div class="sidebar-mode-tabs" role="tablist" aria-label="Sidebar">
        <button type="button" class="sidebar-mode-tab active" id="sidebarAppsTab" role="tab" aria-selected="true" aria-controls="sidebarAppsPanel">Apps</button>
        <button type="button" class="sidebar-mode-tab" id="sidebarTodoTab" role="tab" aria-selected="false" aria-controls="sidebarTodoPanel">To Do</button>
      </div>

      <div class="sidebar-panel active" id="sidebarAppsPanel" role="tabpanel" aria-labelledby="sidebarAppsTab">
        <div class="new-menu-wrap" id="newMenuWrap">
          <button class="btn-primary" id="btnNewReq" aria-haspopup="menu" aria-expanded="false" data-fm-track="new_project_clicked" data-fm-track-source="sidebar">
            <span>New</span>
            <i class="fas fa-plus-circle"></i>
          </button>
          <div class="new-menu-popout" id="newMenuPopout" role="menu" aria-label="Create new">
            <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="project"><i class="fas fa-folder-plus"></i><span>Project</span></button>
            <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="contact"><i class="fas fa-address-book"></i><span>Contact</span></button>
            <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="report"><i class="fas fa-file-lines"></i><span>New Report</span></button>
            <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="proposal"><i class="fas fa-file-signature"></i><span>Proposal</span></button>
            <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="appointment"><i class="fas fa-calendar-plus"></i><span>Appointment</span></button>
          </div>
        </div>

        <div id="sidebarLinks"></div>
      </div>

      <div class="sidebar-panel" id="sidebarTodoPanel" role="tabpanel" aria-labelledby="sidebarTodoTab" hidden>
        <div id="sidebarTodoList"></div>
      </div>

      <div class="sidebar-footer">
        <div class="who" id="whoName"><?= htmlspecialchars($userName) ?></div>
        <!--<div class="co" id="whoCompany"><?= htmlspecialchars($userCompany) ?></div>-->
        <div class="em"><strong id="whoEmail"><?= htmlspecialchars($userEmail) ?></strong></div>
      </div>
    </div>
  </aside>

  <main class="main">
    <div class="platform-topbar" id="platformTopbar">
      <div class="platform-search">
        <i class="fas fa-search"></i>
        <input id="platformGlobalSearch" data-platform-search-input type="search" placeholder="Search projects and contacts" autocomplete="off">
        <div class="ptb-search-results" id="platformSearchResults"></div>
      </div>
      <div class="platform-notifications">
        <button type="button" class="ptb-bell" id="platformBell" data-fm-tooltip="Notifications">
          <i class="fas fa-bell"></i>
          <span class="ptb-count" id="platformNotificationCount">0</span>
        </button>
        <div class="ptb-menu" id="platformNotificationMenu">
          <div class="ptb-menu-head">Notifications</div>
          <div id="platformNotificationList"><div class="ptb-empty">Loading...</div></div>
        </div>
      </div>
    </div>
    <div class="main-panels" id="mainPanels"></div>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/geotiff"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
  <script src="../libraries/platform-api/platform-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-ui/platform-ui.js?v=<?= $ver ?>"></script>
  <script src="../libraries/proposals-api/proposals-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/materials-api/materials-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/payments-api/payments-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/email-api/email-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/lead-intake-api/lead-intake-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/canvassing-api/canvassing-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-celebrations/platform-celebrations.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-notifications/platform-notifications.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-action-items/platform-action-items.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-tags/platform-tags.js?v=<?= $ver ?>"></script>
  <script src="../libraries/markup/firstmate-markup.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-scheduling/platform-scheduling.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-schedule-view/platform-schedule-view.js?v=<?= $ver ?>"></script>
  <script src="../libraries/firstmeasure-api/firstmeasure-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/statsig/firstmate-statsig.js?v=<?= $ver ?>"></script>
  <script src="../libraries/settings-pages/firstmate-settings-pages.js?v=<?= $ver ?>"></script>
  <script src="../libraries/app-runtime/firstmate-embeddable-apps.js?v=<?= $ver ?>"></script>
  <script src="../libraries/app-runtime/firstmate-app-context.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/firstmate-apps-manifest.js?v=<?= $ver ?>"></script>
  <script src="scripts/core.js?v=<?= $ver ?>"></script>
  <script src="scripts/topbar.js?v=<?= $ver ?>"></script>
  <script src="scripts/project_viewer.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-map/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/customer-portal/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-schedule/panel.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/measurements/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/firstmeasure/order/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/projects/viewer.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/photos/feed.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/photos/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/docs/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/pricebook/firstmate-pricebook.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/pricebook/bridge.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/materials/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/proposals/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/money/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/proposals/global.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-request/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/contacts/modal.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/contacts/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/scheduling/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/calls/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/canvassing/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/billing/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/help/app.js?v=<?= $ver ?>"></script>
  <!--<script src="../libraries/apps/tutorial/app.js?v=<?= $ver ?>"></script>-->
  <script src="../libraries/apps/settings/company.js?v=<?= $ver ?>"></script>
  <script src="scripts/dev_overlay.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/promo-inject/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/referrals/app.js?v=<?= $ver ?>"></script>

  <?php
  /*
   * Load the onboarding wizard whenever:
   *   1. $showOnboarding is true — covers both first-time org creators (org check
   *      above) and any explicit ?onboarding param.
   *   2. ?paid=1 is present — Stripe redirects back here after checkout. The wizard
   *      JS checks sessionStorage for the ob_wizard_state blob it saved before
   *      redirecting, and if found it resumes directly at the Auto Top-up step
   *      (Step 4). Without loading the script here, the user just lands on the
   *      dashboard with no wizard, losing the rest of the flow.
   */
  if ($showOnboarding || $paidFlag === '1'): ?>
    <script src="../libraries/apps/onboarding/wizard.js?v=<?= $ver ?>"></script>
  <?php endif; ?>

  <!-- Mobile sidebar toggle -->
  <script>
  (function(){
    const sidebar   = document.getElementById('mainSidebar');
    const backdrop  = document.getElementById('sidebarBackdrop');
    const menuBtn   = document.getElementById('mobMenuBtn');
    const mobNewReq = document.getElementById('mobNewReqBtn');

    function openSidebar(){
      sidebar.classList.add('mob-open');
      backdrop.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeSidebar(){
      sidebar.classList.remove('mob-open');
      backdrop.classList.remove('active');
      document.body.style.overflow = '';
    }

    if (menuBtn)  menuBtn.addEventListener('click', openSidebar);
    if (backdrop) backdrop.addEventListener('click', closeSidebar);

    /* Mobile "New Request" button mirrors the sidebar's btnNewReq */
    if (mobNewReq){
      mobNewReq.addEventListener('click', ()=>{
        const mainBtn = document.getElementById('btnNewReq');
        if ((mainBtn?.dataset?.newButtonMode || 'selector') === 'selector') openSidebar();
        if (mainBtn) setTimeout(() => mainBtn.click(), 0);
      });
    }

    (function initNewMenu(){
      const wrap = document.getElementById('newMenuWrap');
      const btn = document.getElementById('btnNewReq');
      const menu = document.getElementById('newMenuPopout');
      if (!wrap || !btn || !menu) return;
      const modes = {
        selector: { label: 'New', icon: 'fa-plus-circle', workflow: 'selector' },
        project: { label: 'New Project', icon: 'fa-folder-plus', workflow: 'project' },
        contact: { label: 'New Contact', icon: 'fa-address-book', workflow: 'contact' },
        report: { label: 'New Report', icon: 'fa-file-lines', workflow: 'report' },
        proposal: { label: 'New Proposal', icon: 'fa-file-signature', workflow: 'proposal' },
        appointment: { label: 'New Appointment', icon: 'fa-calendar-plus', workflow: 'appointment' }
      };
      const normalizeMode = (value) => {
        const raw = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
        if (raw === 'menu' || raw === 'select' || raw === 'chooser') return 'selector';
        if (raw === 'new_project') return 'project';
        if (raw === 'new_contact' || raw === 'customer') return 'contact';
        if (raw === 'new_report' || raw === 'roof' || raw === 'measurement') return 'report';
        if (raw === 'new_proposal') return 'proposal';
        if (raw === 'new_appointment' || raw === 'schedule' || raw === 'scheduling') return 'appointment';
        return modes[raw] ? raw : 'report';
      };
      const proposalsEnabled = () => {
        const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
        if (!flags?.current?.()) return false;
        if (flags.has?.('platform', 'proposals')) return true;
        const value = flags.value?.('platform', 'proposals', undefined);
        return typeof value === 'boolean' ? value : false;
      };
      const configuredMode = () => normalizeMode(
        window.Portal?.appFlags?.value?.('platform', 'new_button_mode',
          window.PlatformAPI?.appFlags?.value?.('platform', 'new_button_mode', 'report')
        )
      );
      const setButtonMode = () => {
        let mode = configuredMode();
        if (mode === 'proposal' && !proposalsEnabled()) mode = 'selector';
        const config = modes[mode] || modes.selector;
        btn.querySelector('span').textContent = config.label;
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'fas fa-plus-circle';
        btn.setAttribute('aria-haspopup', mode === 'selector' ? 'menu' : 'false');
        btn.setAttribute('aria-expanded', mode === 'selector' && wrap.classList.contains('open') ? 'true' : 'false');
        btn.setAttribute('aria-label', 'New');
        btn.dataset.newButtonMode = mode;
        const mobileBtn = document.getElementById('mobNewReqBtn');
        if (mobileBtn) {
          mobileBtn.setAttribute('aria-label', 'New');
          mobileBtn.setAttribute('data-fm-tooltip', 'New');
          const mobileLabel = mobileBtn.querySelector('span');
          const mobileIcon = mobileBtn.querySelector('i');
          if (mobileLabel) mobileLabel.textContent = 'New';
          if (mobileIcon) mobileIcon.className = 'fas fa-plus';
        }
        menu.querySelectorAll('[data-new-workflow="proposal"]').forEach((item) => {
          item.hidden = !proposalsEnabled();
        });
      };
      const closeMenu = () => {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      };
      const openMenu = () => {
        const rect = btn.getBoundingClientRect();
        const mobileSidebarOpen = sidebar?.classList.contains('mob-open');
        if (!mobileSidebarOpen) {
          menu.style.setProperty('--new-menu-left', `${Math.round(rect.right + 10)}px`);
          menu.style.setProperty('--new-menu-top', `${Math.round(rect.top)}px`);
        }
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      };
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        let mode = configuredMode();
        if (mode === 'proposal' && !proposalsEnabled()) mode = 'selector';
        if (mode !== 'selector') {
          closeMenu();
          if (sidebar?.classList.contains('mob-open')) closeSidebar();
          window.dispatchEvent(new CustomEvent('fm:new-project-workflow', {
            detail: { workflow: modes[mode]?.workflow || 'project' }
          }));
          return;
        }
        wrap.classList.contains('open') ? closeMenu() : openMenu();
      });
      menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-new-workflow]');
        if (!item) return;
        if (item.dataset.newWorkflow === 'proposal' && !proposalsEnabled()) return;
        closeMenu();
        window.dispatchEvent(new CustomEvent('fm:new-project-workflow', {
          detail: { workflow: item.dataset.newWorkflow || 'project' }
        }));
      });
      document.addEventListener('click', (event) => {
        if (!wrap.contains(event.target)) closeMenu();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeMenu();
      });
      window.addEventListener('resize', () => {
        if (wrap.classList.contains('open')) openMenu();
      });
      window.addEventListener('fm:app-flags:updated', () => {
        closeMenu();
        setButtonMode();
      });
      window.addEventListener('fm:app-flags:failed', setButtonMode);
      setButtonMode();
    })();

    /* Close sidebar when a sidebar tab link is clicked (mobile UX) */
    document.addEventListener('click', (e)=>{
      if (!sidebar.classList.contains('mob-open')) return;
      const link = e.target.closest('.fm-link');
      if (link && sidebar.contains(link)) setTimeout(closeSidebar, 80);
    });

    /* Close on Escape */
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && sidebar.classList.contains('mob-open')) closeSidebar();
    });

    /* Expose for other scripts */
    window.__mobileSidebar = { open: openSidebar, close: closeSidebar };
  })();
  </script>

  <?php if ($GOOGLE_BROWSER_API_KEY !== ''): ?>
  <script src="https://maps.googleapis.com/maps/api/js?key=<?=htmlspecialchars(rawurlencode($GOOGLE_BROWSER_API_KEY), ENT_QUOTES, 'UTF-8')?>&v=3.64&libraries=places&loading=async" async defer></script>
  <?php endif; ?>
</body>
</html>
