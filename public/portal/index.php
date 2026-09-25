<?php
require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();

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

$platformExpandedAssets = ($_SESSION['platform_expanded_access'] ?? false) === true;
$ver = time(); // Cache busting

// --- TUTORIAL CHECK ---
$headers = function_exists('getallheaders') ? getallheaders() : [];
$showTutorial = false;
if (isset($_GET['tutorial']) || (isset($headers['X-Tutorial-Mode']) && $headers['X-Tutorial-Mode'] == 'true')) {
    $showTutorial = true;
}

// Stripe return params
$paidFlag = isset($_GET['paid']) ? $_GET['paid'] : null; // "1" or "0"
$initialProjectRoute = trim((string)($_GET['project'] ?? ''));
// A global-scope media viewer (the photo feed) keeps `project` in the URL only
// as context and never opens project chrome, so painting the first-paint shell
// for it would leave a cover nothing removes.
if (strtolower(trim((string)($_GET['photoScope'] ?? ''))) === 'feed') {
    $initialProjectRoute = '';
}
$initialProjectTab = trim((string)($_GET['projectTab'] ?? 'map'));
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
      --sidebar:250px;
      --sidebar-compact:48px;
      --fm-visual-vh:100vh;
      --fm-visual-vw:100vw;
      --fm-scrollbar-size:12px;
      --fm-scrollbar-content-gap:10px;
      --fm-scrollbar-thumb:rgba(71,84,103,.52);
      --fm-scrollbar-thumb-hover:rgba(52,64,84,.78);
    }
    *{box-sizing:border-box}
    @supports not selector(::-webkit-scrollbar){
      *{scrollbar-color:var(--fm-scrollbar-thumb) transparent}
    }
    *::-webkit-scrollbar{width:var(--fm-scrollbar-size);height:var(--fm-scrollbar-size);background:transparent}
    *::-webkit-scrollbar-button{display:none;width:0;height:0}
    *::-webkit-scrollbar-track{background:transparent}
    *::-webkit-scrollbar-thumb{min-width:44px;min-height:44px;border:3px solid transparent;border-radius:999px;background-color:rgba(71,84,103,.52);background-color:var(--fm-scrollbar-thumb);background-clip:padding-box;box-shadow:inset 0 0 0 999px var(--fm-scrollbar-thumb)}
    *::-webkit-scrollbar-thumb:hover{background-color:rgba(52,64,84,.78);background-color:var(--fm-scrollbar-thumb-hover);background-clip:padding-box;box-shadow:inset 0 0 0 999px var(--fm-scrollbar-thumb-hover)}
    *::-webkit-scrollbar-corner{background:transparent}
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
      --fm-sidebar-safe-bottom:env(safe-area-inset-bottom,0px);
      position:relative;
      width:var(--sidebar);
      background:var(--panel);
      border-right:1px solid var(--border);
      display:flex;
      flex-direction:column;
      box-shadow:4px 0 16px rgba(0,0,0,0.05);
      z-index:2147483004;
      margin-right:0;
      transition:width .2s cubic-bezier(.2,.8,.2,1),margin-right .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s ease;
    }

    /* The Android host already insets the WebView above the system navigation bar. */
    html[data-native-app="android"] .sidebar{--fm-sidebar-safe-bottom:0px}

    .sidebar-mini-logo,
    .sidebar-new-mini-icon,
    .sidebar-compact-toggle{display:none}

    #newMenuWrap[hidden],
    #mobNewReqBtn[hidden]{display:none!important}

    @media (min-width:821px){
      .sidebar .logo-area{flex:0 0 92px;box-sizing:border-box}
      .sidebar.sidebar-compact{width:var(--sidebar-compact)}
      .sidebar.sidebar-compact:hover,
      .sidebar.sidebar-compact.sidebar-compact-edge-held,
      .sidebar.sidebar-compact.sidebar-compact-expanded{width:var(--sidebar)}
      .sidebar.sidebar-compact.sidebar-compact-overlap:hover:not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open),
      .sidebar.sidebar-compact.sidebar-compact-overlap.sidebar-compact-edge-held:not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open){
        margin-right:calc(var(--sidebar-compact) - var(--sidebar));
      }
      .sidebar.sidebar-compact:hover,
      .sidebar.sidebar-compact.sidebar-compact-edge-held{box-shadow:7px 0 22px rgba(15,23,42,.09)}

      .sidebar-compact-toggle{
        position:absolute;
        top:50%;
        right:-11px;
        z-index:4;
        width:22px;
        height:38px;
        border:1px solid var(--border);
        border-radius:0 9px 9px 0;
        background:#fff;
        color:#7b8490;
        align-items:center;
        justify-content:center;
        padding:0;
        box-shadow:3px 2px 8px rgba(15,23,42,.08);
        cursor:pointer;
      }
      .sidebar.sidebar-compact .sidebar-compact-toggle{display:flex}
      .sidebar-compact-toggle i{font-size:10px;transition:transform .18s ease,color .18s ease}
      .sidebar.sidebar-compact:hover .sidebar-compact-toggle i,
      .sidebar.sidebar-compact.sidebar-compact-edge-held .sidebar-compact-toggle i,
      .sidebar.sidebar-compact.sidebar-compact-expanded .sidebar-compact-toggle i{transform:rotate(180deg)}
      .sidebar-compact-toggle:hover{color:var(--primary-readable,var(--primary,#d93025))}

      .sidebar.sidebar-compact .logo-area{position:relative}
      .sidebar.sidebar-compact .logo-area>.firstmate-color-logo,
      .sidebar.sidebar-compact .logo-area>.cobrand-logo-divider,
      .sidebar.sidebar-compact .logo-area>img{transition:opacity .16s ease .04s,transform .2s ease;transform-origin:left center}
      .sidebar.sidebar-compact .sidebar-mini-logo{
        display:block;position:absolute;left:10px;top:50%;width:27px;height:27px;
        background:var(--primary-readable,var(--primary,#d93025));
        -webkit-mask:url('/images/logo_square.png') center / contain no-repeat;
        mask:url('/images/logo_square.png') center / contain no-repeat;
        transform:translateY(-50%);opacity:0;pointer-events:none;
        transition:opacity .12s ease;
      }
      .sidebar.sidebar-compact .sidebar-scroll{transition:padding .2s cubic-bezier(.2,.8,.2,1)}
      .sidebar.sidebar-compact #sidebarLinks,
      .sidebar.sidebar-compact #sidebarBottomLinks{transition:padding .2s cubic-bezier(.2,.8,.2,1)}
      .sidebar.sidebar-compact .new-menu-wrap{display:flex;align-items:center;flex:0 0 46px}
      .sidebar.sidebar-compact #btnNewReq{
        position:relative;width:100%;height:40px;min-height:40px;
        transition:padding .2s cubic-bezier(.2,.8,.2,1),background .18s ease,box-shadow .18s ease;
      }
      .sidebar.sidebar-compact #btnNewReq>span{min-width:0;max-width:170px;overflow:hidden;white-space:nowrap;opacity:1;transition:max-width .2s ease,opacity .12s ease .08s}
      .sidebar.sidebar-compact .sidebar-new-full-icon{opacity:1;transition:opacity .12s ease .08s}
      .sidebar.sidebar-compact .sidebar-new-mini-icon{
        display:block;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
        opacity:0;pointer-events:none;transition:opacity .12s ease;
      }
      .sidebar.sidebar-compact .sidebar-mode-tabs{transition:opacity .16s ease}
      .sidebar.sidebar-compact .fm-link{
        box-sizing:border-box;width:100%;height:32px;min-height:32px;flex:0 0 32px;
        justify-content:flex-start;transition:padding .2s cubic-bezier(.2,.8,.2,1),color .14s ease,background .14s ease;
      }
      .sidebar.sidebar-compact .fm-link .ic{width:18px;flex:0 0 18px;font-size:14px}
      .sidebar.sidebar-compact .fm-link .tx{
        max-width:180px;overflow:hidden;white-space:nowrap;opacity:1;transform:translateX(0);
        transition:max-width .2s ease,opacity .12s ease .08s,transform .2s ease;
      }

      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .logo-area{
        display:flex;
        height:92px;
        width:100%;
        padding:0;
        align-items:center;
        justify-content:center;
        grid-template-columns:none;
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .logo-area>.firstmate-color-logo,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .logo-area>.cobrand-logo-divider,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .logo-area>img{opacity:0;pointer-events:none;transform:scale(.82)}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-mini-logo{
        opacity:1;
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-scroll{
        padding:16px 6px calc(14px + var(--fm-sidebar-safe-bottom));
        gap:12px;
        overflow:hidden;
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .new-menu-wrap{display:flex;align-items:center;justify-content:center}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #btnNewReq{
        width:100%;
        justify-content:center;
        padding:0;
        border-radius:12px;
        box-shadow:0 5px 12px rgba(var(--primary-rgb),.2);
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #btnNewReq>span,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-new-full-icon{max-width:0;opacity:0}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #btnNewReq>span{max-width:0;opacity:0}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-new-mini-icon{opacity:1}

      /* Keep the tab row's space so app icons do not move when the rail opens. */
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-mode-tabs{visibility:hidden;opacity:0;pointer-events:none}

      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarTodoPanel,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarChannelsPanel,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarAgentsPanel{visibility:hidden;pointer-events:none}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarLinks,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarMainLinks,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarBottomLinks{padding:0;margin-left:0;margin-right:0;gap:2px}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarAppsPanel,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarLinks{min-height:0;overflow:hidden}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarMainLinks{
        flex:1 1 auto;
        min-height:0;
        overflow-x:hidden;
        overflow-y:auto;
        scrollbar-width:none;
        gap:10px;
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarMainLinks::-webkit-scrollbar{display:none}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-link{
        padding:0 0 0 8px;
        flex:none;
      }
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-link .tx{max-width:0;opacity:0;transform:translateX(-6px)}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-link.bottom{padding-top:0}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-footer{padding:8px 0 0;border-top:1px solid rgba(0,0,0,.06)}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-account-switcher-trigger{justify-content:center;padding:3px!important}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-account-trigger-copy,
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-account-trigger-chevron{display:none}
    }

    @media (prefers-reduced-motion:reduce){
      .sidebar,.sidebar-compact-toggle i,
      .sidebar.sidebar-compact .logo-area>*,
      .sidebar.sidebar-compact .sidebar-scroll,
      .sidebar.sidebar-compact #sidebarLinks,
      .sidebar.sidebar-compact #sidebarBottomLinks,
      .sidebar.sidebar-compact #btnNewReq,
      .sidebar.sidebar-compact #btnNewReq>span,
      .sidebar.sidebar-compact .sidebar-new-full-icon,
      .sidebar.sidebar-compact .sidebar-new-mini-icon,
      .sidebar.sidebar-compact .sidebar-mode-tabs,
      .sidebar.sidebar-compact .fm-link,
      .sidebar.sidebar-compact .fm-link .tx{transition-duration:.01ms!important}
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
      padding:16px 14px calc(14px + var(--fm-sidebar-safe-bottom));
      display:flex;
      flex-direction:column;
      gap:12px;
      flex:1 1 auto;
      min-height:0;
      overflow:hidden;
    }

    .sidebar-mode-tabs{
      display:none;
      grid-auto-flow:column;
      grid-auto-columns:minmax(0,1fr);
      gap:0;
      padding:0;
      border:1px solid rgba(0,0,0,0.07);
      border-bottom:0;
      background:#f7f8fa;
      border-radius:0;
    }

    .sidebar.sidebar-modes-switchable .sidebar-mode-tabs{
      display:grid;
      margin:0 -14px;
    }

    .sidebar:not(.apps-list-enabled) #sidebarAppsTab{display:none}
    .sidebar:not(.todo-list-enabled) #sidebarTodoTab{display:none}
    .sidebar:not(.channels-tab-enabled) #sidebarChannelsTab{display:none}
    .sidebar:not(.agents-tab-enabled) #sidebarAgentsTab{display:none}

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
      overflow:hidden;
      gap:14px;
    }

    #sidebarAppsPanel.active{
      position:relative;
      gap:0;
    }

    .sidebar-app-scroll-control{
      display:none;
      position:absolute;
      left:0;
      z-index:3;
      width:100%;
      height:22px;
      align-items:center;
      justify-content:center;
      border:0;
      border-radius:0;
      color:#667085;
      cursor:pointer;
      font-size:10px;
      opacity:0;
      transition:color .14s ease,opacity .16s ease;
    }
    #sidebarAppsScrollUp{
      top:0;
      align-items:flex-start;
      padding-top:2px;
      background:linear-gradient(to bottom,rgba(255,255,255,.96) 0%,rgba(255,255,255,.68) 54%,rgba(255,255,255,0) 100%);
    }
    #sidebarAppsScrollDown{
      bottom:0;
      align-items:flex-end;
      padding-bottom:2px;
      background:linear-gradient(to top,rgba(255,255,255,.96) 0%,rgba(255,255,255,.68) 54%,rgba(255,255,255,0) 100%);
    }
    #sidebarAppsPanel.sidebar-apps-can-scroll-up #sidebarAppsScrollUp,
    #sidebarAppsPanel.sidebar-apps-can-scroll-down #sidebarAppsScrollDown{display:flex;opacity:1}
    .sidebar-app-scroll-control[hidden]{display:none!important}
    .sidebar-app-scroll-control:hover{color:var(--primary-readable,var(--primary,#d93025))}
    .sidebar-app-scroll-control:focus-visible{outline:2px solid rgba(var(--primary-rgb),.28);outline-offset:-2px}

    #sidebarTodoPanel.active{
      gap:8px;
    }

    #sidebarTodoList{
      display:flex;
      flex:1 1 auto;
      min-height:0;
      overflow:hidden;
    }

    #sidebarChannelsPanel.active{
      gap:8px;
    }

    #sidebarChannelsList{
      display:flex;
      flex:1 1 auto;
      min-height:0;
      overflow:hidden;
      margin:0 -6px;
    }

    #sidebarChannelsList .fm-ch{
      flex:1;
      min-width:0;
    }

    #sidebarAgentsPanel.active{gap:8px}
    #sidebarAgentsList{display:flex;flex:1 1 auto;min-height:0;overflow:hidden;margin:0 -6px}

    #sidebarBottomLinks{
      display:flex;
      flex:0 0 auto;
      flex-direction:column;
      gap:10px;
      margin-top:auto;
      padding:0 6px;
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

    @media (min-width:821px){
      .new-menu-wrap{height:46px}
      .new-menu-wrap .btn-primary{height:100%}
      #sidebarMainLinks .fm-link{min-height:32px}
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
    .platform-topbar-app-left{
      flex:1 1 auto;
      min-width:0;
      display:flex;
      align-items:center;
      overflow:hidden;
    }
    .platform-topbar-app-left:empty{display:none}
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
    .ptb-search-filterbar{position:sticky;top:0;z-index:2;padding:9px 10px;background:#fff;border-bottom:1px solid #e4e7ec}
    .ptb-search-filters{display:grid;grid-template-columns:repeat(5,max-content);align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;padding:1px}
    .ptb-search-filters::-webkit-scrollbar{display:none}
    .ptb-search-filter{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#667085;font-family:inherit;font-size:9.5px;font-weight:850;line-height:1;cursor:pointer;white-space:nowrap}
    .ptb-search-filter i{position:static;transform:none;font-size:8.5px;color:inherit}
    .ptb-search-filter:hover{border-color:#98a2b3;color:#344054;background:#f8fafc}
    .ptb-search-filter.active{border-color:rgba(var(--primary-rgb),.28);background:rgba(var(--primary-rgb),.08);color:var(--primary-readable)}
    .ptb-search-result-list{padding:4px 0}
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
    .ptb-search-item.setting .ptb-search-kind{background:#fff4e5;color:#b54708}
    .ptb-search-item.user .ptb-search-kind{background:#f4f3ff;color:#5925dc}
    .ptb-search-item.equipment .ptb-search-kind{background:#ecfdf3;color:#067647}
    .ptb-search-item.event .ptb-search-kind{background:#eff8ff;color:#175cd3}
    .ptb-search-item.document .ptb-search-kind{background:#eef4ff;color:#3538cd}
    .ptb-search-item.scope .ptb-search-kind{background:#f0f9ff;color:#026aa2}
    .ptb-search-item.channel .ptb-search-kind{background:#f8f9fc;color:#363f72}
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
    .platform-messages{position:relative}
    .ptb-menu.ptb-menu--messages{width:400px;max-width:min(92vw,400px);max-height:min(72vh,680px);overflow:auto}
    .ptb-msg-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;padding:9px 12px;border-radius:10px;cursor:pointer;align-items:start}
    .ptb-msg-row:hover{background:#f8fafc}
    .ptb-msg-row.unread{background:rgba(var(--primary-rgb,217,48,37),.05)}
    .ptb-msg-ico{width:30px;height:30px;border-radius:8px;background:#f2f4f7;display:flex;align-items:center;justify-content:center;color:#475467;font-size:12px}
    .ptb-msg-row.unread .ptb-msg-ico{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
    .ptb-msg-main{min-width:0;display:grid;gap:2px}
    .ptb-msg-line{font-size:12.5px;color:#101828;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ptb-msg-line b{font-weight:900}
    .ptb-msg-snippet{font-size:12px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ptb-msg-meta{font-size:10.5px;color:#98a2b3;font-weight:800;white-space:nowrap;text-align:right;display:grid;gap:4px;justify-items:end}
    .ptb-msg-dot{width:8px;height:8px;border-radius:50%;background:var(--primary-readable,var(--primary,#d93025))}
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
    .ptb-note{padding:12px 14px;border-bottom:1px solid rgba(15,23,42,.06);display:flex;gap:10px;align-items:flex-start;cursor:pointer;position:relative;background:#fff;max-height:140px;overflow:hidden;transition:opacity .18s ease,transform .24s cubic-bezier(.22,1,.36,1),max-height .24s ease,padding .24s ease,border-color .18s ease,background-color .16s ease}
    .ptb-note.unread{background:rgba(var(--primary-rgb),.055)}
    .ptb-note.unread::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:99px;background:var(--primary,#d93025)}
    .ptb-note.seen{opacity:.78}
    .ptb-note.lead-note .ptb-note-main strong{color:var(--primary-readable,#d93025)}
    .ptb-note:hover{background:#f8fafc}
    .ptb-note-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
    .ptb-note-main strong{font-size:13px;color:#101828}
    .ptb-note-main span{font-size:12px;line-height:1.4;color:#667085;font-weight:750}
    .ptb-note-dismiss{border:1px solid rgba(15,23,42,.18);background:#fff;border-radius:6px;width:26px;height:26px;padding:0;font-size:11px;font-weight:950;cursor:pointer;color:#344054;display:grid;place-items:center;flex:0 0 26px;transition:transform .12s ease,background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease}
    .ptb-note-dismiss:hover{color:#047857;border-color:#6ee7b7;background:#ecfdf3;box-shadow:0 2px 8px rgba(4,120,87,.14)}
    .ptb-note-dismiss:active{transform:scale(.84)}
    .ptb-note-dismiss:focus-visible,.ptb-note-restore:focus-visible,.ptb-dismissed-section summary:focus-visible{outline:3px solid rgba(var(--primary-rgb),.22);outline-offset:2px}
    .ptb-note.is-dismissing{background:#ecfdf3}
    .ptb-note.is-dismissing .ptb-note-dismiss{color:#fff;border-color:#10b981;background:#10b981;box-shadow:0 0 0 4px rgba(16,185,129,.14)}
    .ptb-note.is-dismissing .ptb-note-dismiss i{animation:ptb-check-pop .3s cubic-bezier(.22,1,.36,1)}
    .ptb-note.is-dismissed{opacity:0;transform:translateX(20px);max-height:0;padding-top:0;padding-bottom:0;border-color:transparent;pointer-events:none}
    .ptb-note-dismiss.is-error,.ptb-note-restore.is-error{animation:ptb-button-error .35s ease;color:#b42318;border-color:#fda29b;background:#fef3f2}
    .ptb-active-notifications{min-height:51px}
    .ptb-dismissed-section{border-top:1px solid rgba(15,23,42,.08);background:#f8fafc}
    .ptb-dismissed-section summary{list-style:none;padding:11px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;color:#475467;font-size:12px;font-weight:950;user-select:none}
    .ptb-dismissed-section summary::-webkit-details-marker{display:none}
    .ptb-dismissed-section summary:hover{background:#f1f5f9;color:#344054}
    .ptb-dismissed-section summary span{display:flex;align-items:center;gap:8px}
    .ptb-dismissed-section summary i{font-size:9px;transition:transform .16s ease}
    .ptb-dismissed-section[open] summary i{transform:rotate(90deg)}
    .ptb-dismissed-section summary b{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#e2e8f0;color:#475467;display:grid;place-items:center;font-size:10px}
    .ptb-dismissed-list{border-top:1px solid rgba(15,23,42,.06)}
    .ptb-note-dismissed{cursor:default;background:#fbfcfd;opacity:.72}
    .ptb-note-dismissed:hover{background:#fbfcfd}
    .ptb-note-dismissed.is-restoring{opacity:.35;transform:translateX(-8px);pointer-events:none}
    .ptb-note-restore{border:1px solid rgba(15,23,42,.14);background:#fff;border-radius:7px;min-height:27px;padding:0 8px;color:#475467;display:flex;align-items:center;gap:5px;flex:0 0 auto;font-size:10px;font-weight:950;cursor:pointer;transition:transform .12s ease,background-color .15s ease,border-color .15s ease,color .15s ease}
    .ptb-note-restore:hover{color:#175cd3;border-color:#84adff;background:#eff8ff}
    .ptb-note-restore:active{transform:scale(.92)}
    .ptb-note-restore[aria-busy="true"] i{animation:ptb-undo-spin .55s ease}
    @keyframes ptb-check-pop{0%{transform:scale(.45)}65%{transform:scale(1.35)}100%{transform:scale(1)}}
    @keyframes ptb-undo-spin{to{transform:rotate(-360deg)}}
    @keyframes ptb-button-error{0%,100%{transform:translateX(0)}35%{transform:translateX(-3px)}70%{transform:translateX(3px)}}
    @media (prefers-reduced-motion:reduce){.ptb-note,.ptb-note-dismiss,.ptb-note-restore,.ptb-dismissed-section summary i{transition-duration:.01ms!important}.ptb-note.is-dismissing .ptb-note-dismiss i,.ptb-note-dismiss.is-error,.ptb-note-restore.is-error,.ptb-note-restore[aria-busy="true"] i{animation:none!important}}
    .ptb-empty{padding:18px;text-align:center;color:#667085;font-size:12px;font-weight:850}
    /* Pinned attention rows (PlatformBanners "notification" surface): locked
       above regular notifications, thinner, tone background, never dismissible. */
    .ptb-note.ptb-note-pinned{padding:9px 14px;opacity:1;border-left:3px solid transparent}
    .ptb-note.ptb-note-pinned .ptb-note-main{gap:2px}
    .ptb-note.ptb-note-pinned .ptb-note-main strong{font-size:12.5px}
    .ptb-note.ptb-note-pinned .ptb-note-main span{font-size:11.5px}
    .ptb-note.ptb-note-pinned.tone-orange{background:rgba(240,90,40,.10);border-left-color:#f05a28}
    .ptb-note.ptb-note-pinned.tone-orange:hover{background:rgba(240,90,40,.16)}
    .ptb-note.ptb-note-pinned.tone-primary{background:rgba(var(--primary-rgb,217,48,37),.08);border-left-color:var(--primary,#d93025)}
    .ptb-note.ptb-note-pinned.tone-primary:hover{background:rgba(var(--primary-rgb,217,48,37),.14)}
    .ptb-note.ptb-note-pinned.tone-danger{background:rgba(217,45,32,.10);border-left-color:#d92d20}
    .ptb-note.ptb-note-pinned.tone-danger:hover{background:rgba(217,45,32,.16)}
    .ptb-note.ptb-note-pinned.tone-neutral{background:#f2f4f7;border-left-color:#667085}
    .ptb-note.ptb-note-pinned.tone-neutral:hover{background:#e9edf2}
    .ptb-note-pinned-wait{flex:0 0 auto;color:#667085;font-size:11px;align-self:center}
    /* Sidebar attention card (PlatformBanners "sidebar" surface). */
    .sidebar-attention-slot{flex:0 0 auto;margin-top:-8px;padding:3px 10px 2px}
    .sidebar-attention-card{
      width:100%;display:flex;align-items:center;gap:8px;
      padding:9px 10px;border-radius:12px;border:1px solid rgba(15,23,42,.10);
      background:#fff;cursor:pointer;text-align:left;transition:.15s ease;
      border-left-width:4px;
    }
    .sidebar-attention-card:hover{transform:translateY(-1px);box-shadow:0 8px 18px rgba(15,23,42,.10)}
    .sidebar-attention-card.tone-orange{border-left-color:#f05a28;background:linear-gradient(90deg, rgba(240,90,40,.10), rgba(245,158,11,.05))}
    .sidebar-attention-card.tone-primary{border-left-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
    .sidebar-attention-card.tone-danger{border-left-color:#d92d20;background:rgba(217,45,32,.08)}
    .sidebar-attention-card.tone-neutral{border-left-color:#667085;background:#f8fafc}
    .sidebar-attention-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
    .sidebar-attention-copy strong{font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sidebar-attention-copy small{font-size:11px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sidebar-attention-chevron{flex:0 0 auto;color:#98a2b3;font-size:10px}
    .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open):not(.sidebar-compact-edge-held) .sidebar-attention-slot{display:none}
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
        display:grid;
        grid-template-columns:40px minmax(0,1fr) 40px;
        align-items:center;
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
        grid-template-rows:40px 36px;
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
      .mobile-topbar .mob-logo{grid-column:2;grid-row:1;min-width:0;text-align:center;display:flex;align-items:center;justify-content:center}
      .mobile-topbar .mob-logo img{
        display:none!important;
      }
      .mobile-topbar .mob-tab-title{
        display:block;
        max-width:100%;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        color:#202124;
        font-size:17px;
        font-weight:1000;
        line-height:1.1;
      }
      /* Branding belongs in the opened mobile menu; the fixed bar owns the page title. */
      .mobile-topbar .mob-logo.default-firstmeasure-logo::before{display:none!important}
      html[data-fm-field-only="true"] .mobile-topbar .mob-new-req{display:none!important}
      html[data-fm-field-only="true"] .new-menu-wrap{display:none!important}
      .mobile-topbar .mob-new-req{
        grid-column:3;grid-row:1;
        min-width:40px; width:40px; height:40px;
        padding:0;
        display:flex; align-items:center; justify-content:center;
        gap:6px;
        background:var(--primary); color:var(--on-primary); border:none;
        border-radius:12px; cursor:pointer; font-size:16px;
        box-shadow:0 4px 12px rgba(var(--primary-rgb),0.3);
        transition:.14s ease;
        font-weight:950;
      }
      .mobile-topbar .mob-new-req span{
        display:none;
      }
      .mobile-topbar .mob-new-req:active{transform:scale(0.95)}
      /* Mobile consolidates the three topbar actions into one More button.
         The assistant/messages/notifications slots stay in the DOM only as
         anchors for their pop-out panels; their own buttons are hidden. */
      .mobile-topbar{position:relative}
      .mobile-topbar .mob-notifications{
        display:none;
        position:static;
        grid-column:3;
        grid-row:1;
      }
      .mobile-topbar.topbar-enabled .mob-new-req{display:none}
      .mobile-topbar.topbar-enabled .mob-notifications{display:block}
      .mobile-topbar.topbar-enabled .mob-notifications[hidden]{display:none}
      .mobile-topbar .platform-assistant .ptb-bell,
      .mobile-topbar .platform-messages .ptb-bell,
      .mobile-topbar .platform-notifications .ptb-bell{display:none}
      .mobile-topbar .mob-notifications.platform-more{position:relative}
      .mobile-topbar .ptb-menu--more{height:auto;max-height:none;width:236px;padding:6px}
      .mobile-topbar .ptb-more-item{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;padding:11px 12px;border-radius:10px;font:inherit;font-size:13px;font-weight:800;color:#202124;cursor:pointer;text-align:left}
      .mobile-topbar .ptb-more-item:hover{background:rgba(0,0,0,.05)}
      .mobile-topbar .ptb-more-item i{width:20px;text-align:center;color:#475467}
      .mobile-topbar .ptb-more-item .ptb-more-count{margin-left:auto;background:var(--primary,#d93025);color:var(--on-primary,#fff);border-radius:999px;font-size:10px;font-weight:900;padding:2px 7px;font-style:normal}
      .mobile-topbar.topbar-enabled .mobile-platform-search{
        display:block;
        grid-column:1 / -1;
        grid-row:2;
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
        padding-bottom:calc(26px + var(--fm-sidebar-safe-bottom));
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
      userId: <?= json_encode((string)($_SESSION['platform_user_id'] ?? '')) ?>,
      userBranchId: <?= json_encode($userBranchId) ?>,
      platformExpandedAssets: <?= $platformExpandedAssets ? 'true' : 'false' ?>,
      platformSessionCookieName: <?= json_encode(portalPlatformSessionCookieName()) ?>,
      showTutorial: <?= $showTutorial ? 'true' : 'false' ?>,
      stripePaidFlag: <?= ($paidFlag === null ? 'null' : json_encode($paidFlag)) ?>,
      serverEndpoint: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/platform/portal-action`;
        }
        return `${location.origin}/v1/platform/portal-action`;
      })(),
      platformApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
      })(),
      emailApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/email`;
        }
        return `${location.origin}/v1/email`;
      })(),
      messagingApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/messaging`;
        }
        return `${location.origin}/v1/messaging`;
      })(),
      leadIntakeApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/lead-intake`;
        }
        return `${location.origin}/v1/lead-intake`;
      })(),
      canvassingApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/canvassing`;
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

      function mergedBranding(...sources){
        const values = sources.filter((value) => value && typeof value === 'object');
        return {
          ...Object.assign({}, ...values),
          colors: Object.assign({}, ...values.map((value) => value.colors || {}))
        };
      }

      async function themeOrgFromAuthenticatedContext(requestedOrgId){
        if (!window.PlatformAPI?.request) return null;
        const context = await window.PlatformAPI.request('/me').catch(() => null);
        if (!context?.authenticated) return null;
        const membership = context.membership || {};
        const contextOrgId = String(membership.organization_id || context.organization?.id || requestedOrgId || '').trim();
        if (requestedOrgId && contextOrgId && requestedOrgId !== contextOrgId) return null;
        const organization = context.organization || {};
        const organizationData = organization.data || {};
        const globalData = context.global?.data || {};
        const branchData = context.branch?.data || {};
        return {
          id: contextOrgId,
          branch_id: membership.branch_id || context.branch?.id || window.__APP?.userBranchId || 'default',
          name: branchData.name || organization.name || organizationData.name || window.__APP?.userCompany || '',
          branding: mergedBranding(organization.branding, organizationData.branding, globalData.branding, branchData.branding)
        };
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
          const requestedOrgId = String(window.__APP?.userOrgId || '').trim();
          let data = null;
          // /me is application-neutral, so crew-only users receive the same
          // branch branding as management users without gaining settings access.
          const contextOrg = await themeOrgFromAuthenticatedContext(requestedOrgId);
          if (contextOrg) data = { success:true, org:contextOrg };
          // Retain the older organization reads for pre-context sessions.
          if (!data && requestedOrgId && window.PlatformAPI?.organizations?.get) {
            const result = await window.PlatformAPI.organizations.get(requestedOrgId).catch(() => null);
            const org = result?.organization || result?.document?.data || result?.data || result || null;
            if (org && typeof org === 'object') data = { success:true, org };
          }
          if (!data) {
            const fd = new FormData();
            fd.append('action','org_get_my');
            fd.append('actor_email', window.__APP?.userEmail || '');
            fd.append('actor_name', window.__APP?.userName || '');
            fd.append('actor_org_id', requestedOrgId);
            const res = await fetch(window.__APP.serverEndpoint, { method:'POST', body: fd, credentials:'include' });
            data = res.ok ? await res.json().catch(()=>null) : null;
          }
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
      // The first theme request can precede the authenticated Platform session.
      // Re-read it once the field/crew identity and organization are resolved.
      window.addEventListener('fm:platform-session:updated', fetchAndApplyTheme);
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
<body class="platform-booting">
  <style>
    body.platform-booting > :not(script):not(style):not(#fmPlatformBootCover){visibility:hidden!important}
    #fmPlatformBootCover{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#f5f6f8;color:#64748b;font:500 14px Inter,Arial,sans-serif}
  </style>
  <div id="fmPlatformBootCover" role="status" aria-live="polite">Loading your workspace…</div>
  <script>
    // Keep a failed bundle or network request recoverable without showing tabs
    // before account permissions have loaded.
    setTimeout(function () {
      var cover = document.getElementById('fmPlatformBootCover');
      if (!cover) return;
      var message = document.createElement('div');
      message.style.cssText = 'text-align:center;padding:24px;line-height:1.8';
      message.textContent = 'Your workspace is taking longer to load. Please try again.';
      var retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Reload workspace';
      retry.style.cssText = 'display:block;margin:16px auto;padding:10px 18px;cursor:pointer';
      retry.addEventListener('click', function () { window.location.reload(); });
      message.appendChild(retry); cover.replaceChildren(message);
    }, 20000);
  </script>
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
  <?php if ($initialProjectRoute !== '' && !$showOnboarding): ?>
  <!-- First-paint project chrome. The routed project app replaces this shell
       in place without replaying its entrance animation. -->
  <?php $projectRouteTabs = ['map'=>['Overview','fa-map'], 'photos'=>['Photos','fa-image'], 'proposal'=>['Proposals','fa-file-signature'], 'docs'=>['Docs','fa-folder'], 'materials'=>['Scope','fa-link'], 'money'=>['Money','fa-dollar-sign'], 'schedule'=>['Schedule','fa-calendar'], 'measurements'=>['Reports','fa-clipboard-list']]; $initialProjectTabMeta = $projectRouteTabs[$initialProjectTab] ?? $projectRouteTabs['map']; ?>
  <div id="fmProjectRoutePrecover" aria-hidden="true" style="position:fixed;inset:0;z-index:2147483099;background:rgba(11,16,24,.58);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:Inter,Arial,sans-serif;color:#172033">
    <style>
      #fmProjectRoutePrecover{background:rgba(11,16,24,.58)!important}
      #fmProjectRoutePrecover>div:not(.fm-pr-shell){display:none!important}
      #fmProjectRoutePrecover .fm-pr-shell{width:min(1720px,96vw);height:min(1180px,92vh);overflow:hidden;display:flex;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 36px 120px rgba(15,23,42,.28)}
      #fmProjectRoutePrecover .fm-pr-header{height:58px;min-height:58px;display:flex;align-items:stretch;border-bottom:1px solid rgba(15,23,42,.10);background:#fff}
      #fmProjectRoutePrecover .fm-pr-tabs{min-width:0;display:flex;flex:1;overflow:hidden}
      #fmProjectRoutePrecover .fm-pr-tab{min-width:0;padding:0 14px;border-right:1px solid rgba(15,23,42,.10);display:inline-flex;align-items:center;justify-content:center;gap:7px;color:#475467;font-size:11px;font-weight:900;white-space:nowrap}
      #fmProjectRoutePrecover .fm-pr-tab.active{color:var(--primary-readable,#d93025);box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      #fmProjectRoutePrecover .fm-pr-close{width:46px;border-left:1px solid rgba(15,23,42,.10);display:grid;place-items:center;color:#667085;font-size:18px}
      #fmProjectRoutePrecover .fm-pr-title{display:none}
      #fmProjectRoutePrecover .fm-pr-body{display:grid;grid-template-columns:minmax(230px,360px) minmax(0,1fr);flex:1;min-height:0}
      #fmProjectRoutePrecover .fm-pr-left{padding:18px;border-right:1px solid rgba(15,23,42,.08);background:#fff}
      #fmProjectRoutePrecover .fm-pr-shimmer{height:14px;width:58%;margin-bottom:16px;border-radius:999px;background:#eef1f5}
      #fmProjectRoutePrecover .fm-pr-card{height:74px;margin-bottom:10px;border:1px solid rgba(15,23,42,.07);border-radius:12px;background:#fafbfc}
      #fmProjectRoutePrecover .fm-pr-content{min-width:0;padding:18px;background:#eef2f6}
      #fmProjectRoutePrecover .fm-pr-content-card{height:100%;min-height:180px;border:1px solid rgba(15,23,42,.07);border-radius:14px;background:#fff}
      #fmProjectRoutePrecover .fm-pr-content-card:before{content:'';display:block;width:34%;height:16px;margin:18px;border-radius:999px;background:#eef1f5}
      @media(max-width:720px){
        #fmProjectRoutePrecover{align-items:flex-end!important;justify-content:center!important;padding-top:20px!important;box-sizing:border-box;background:rgba(11,16,24,.34)!important;backdrop-filter:blur(2px)!important}
        #fmProjectRoutePrecover .fm-pr-shell{width:100vw;height:calc(100dvh - 20px);border-radius:18px 18px 0 0;box-shadow:0 -9px 28px rgba(15,23,42,.30)}
        #fmProjectRoutePrecover .fm-pr-header{height:48px;min-height:48px}
        #fmProjectRoutePrecover .fm-pr-tabs{display:grid;grid-auto-columns:minmax(44px,1fr);grid-auto-flow:column}
        #fmProjectRoutePrecover .fm-pr-tab{min-height:48px;padding:0;font-size:0}
        #fmProjectRoutePrecover .fm-pr-tab i{font-size:16px}
        #fmProjectRoutePrecover .fm-pr-close{width:48px;min-width:48px;font-size:17px}
        #fmProjectRoutePrecover .fm-pr-title{height:48px;min-height:48px;padding:0 16px;border-bottom:1px solid rgba(15,23,42,.10);display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;font-size:16px;font-weight:900;color:#475467}
        #fmProjectRoutePrecover .fm-pr-current{display:inline-flex;align-items:center;gap:9px;min-width:0;overflow:hidden;white-space:nowrap}
        #fmProjectRoutePrecover .fm-pr-project{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#475467}
        #fmProjectRoutePrecover .fm-pr-body{display:block;min-height:0;background:#eef2f6}
        #fmProjectRoutePrecover .fm-pr-left{display:none}
        #fmProjectRoutePrecover .fm-pr-content{height:100%;padding:12px;box-sizing:border-box;background:#eef2f6}
        #fmProjectRoutePrecover .fm-pr-content-card{min-height:0;border-radius:12px}
      }
    </style>
    <div class="fm-pr-shell">
      <div class="fm-pr-header"><div class="fm-pr-tabs"><?php foreach ($projectRouteTabs as $id=>$tab): ?><span class="fm-pr-tab<?= $initialProjectTab === $id ? ' active' : '' ?>"><i class="fas <?= htmlspecialchars($tab[1], ENT_QUOTES, 'UTF-8') ?>"></i><span><?= htmlspecialchars($tab[0], ENT_QUOTES, 'UTF-8') ?></span></span><?php endforeach; ?></div><span class="fm-pr-close">&times;</span></div>
      <div class="fm-pr-title"><span class="fm-pr-current"><i class="fas <?= htmlspecialchars($initialProjectTabMeta[1], ENT_QUOTES, 'UTF-8') ?>"></i><?= htmlspecialchars($initialProjectTabMeta[0], ENT_QUOTES, 'UTF-8') ?></span><span class="fm-pr-project">Project <i class="fas fa-chevron-left"></i></span></div>
      <div class="fm-pr-body"><aside class="fm-pr-left"><div class="fm-pr-shimmer"></div><div class="fm-pr-card"></div><div class="fm-pr-card"></div><div class="fm-pr-card"></div></aside><main class="fm-pr-content"><div class="fm-pr-content-card"></div></main></div>
    </div>
    <div style="width:min(1720px,96vw);height:min(1180px,92vh);background:#fff;border-radius:14px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:grid;grid-template-rows:58px minmax(0,1fr)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #e5e7eb"><div><strong style="font-size:15px">Project</strong><span style="display:block;margin-top:2px;font-size:10px;color:#667085">Loading project details…</span></div><span style="width:32px;height:32px;border:1px solid #e5e7eb;border-radius:9px;display:grid;place-items:center;color:#667085">×</span></div>
      <div style="display:grid;grid-template-columns:minmax(230px,360px) minmax(0,1fr);min-height:0">
        <aside style="padding:16px;border-right:1px solid #e5e7eb;background:#f8fafc"><div style="height:13px;width:58%;border-radius:999px;background:#e4e7ec;margin-bottom:14px"></div><div style="display:grid;gap:9px"><?php foreach (['Overview','Photos','Proposals','Docs','Scope','Money','Schedule','Reports'] as $label): ?><span style="height:34px;border:1px solid #eaecf0;border-radius:9px;background:#fff;padding:0 11px;display:flex;align-items:center;font-size:11px;font-weight:800;color:#667085"><?= htmlspecialchars($label, ENT_QUOTES, 'UTF-8') ?></span><?php endforeach; ?></div></aside>
        <main style="padding:18px;min-width:0"><div style="display:flex;gap:8px;margin-bottom:18px"><?php foreach (['map'=>'Overview','photos'=>'Photos','proposal'=>'Proposals','docs'=>'Docs','materials'=>'Scope','money'=>'Money','schedule'=>'Schedule','measurements'=>'Reports'] as $id=>$label): ?><span style="padding:8px 10px;border-radius:8px;background:<?= $initialProjectTab === $id ? '#172033' : '#f2f4f7' ?>;color:<?= $initialProjectTab === $id ? '#fff' : '#667085' ?>;font-size:10px;font-weight:850"><?= htmlspecialchars($label, ENT_QUOTES, 'UTF-8') ?></span><?php endforeach; ?></div><div style="height:18px;width:34%;border-radius:999px;background:#e4e7ec;margin-bottom:14px"></div><div style="height:12px;width:72%;border-radius:999px;background:#f0f2f5;margin-bottom:9px"></div><div style="height:12px;width:58%;border-radius:999px;background:#f0f2f5"></div></main>
      </div>
    </div>
  </div>
  <script>
    /* Safety net for the first-paint project shell above.
     *
     * The routed project app removes this cover when it opens the real modal.
     * If that never happens — the route does not actually open project chrome,
     * the project fails to resolve, or the app script errors — the cover is a
     * full-screen element with no behaviour behind it and the user is trapped.
     * Always give them a way out, and clear it once the app has taken over. */
    (function(){
      var cover = document.getElementById('fmProjectRoutePrecover');
      if (!cover) return;
      var dismiss = function(){
        cover.remove();
        document.removeEventListener('keydown', onKey, true);
      };
      var onKey = function(event){
        if (event.key === 'Escape') dismiss();
      };
      document.addEventListener('keydown', onKey, true);
      cover.addEventListener('click', function(event){
        // Clicking the inert shell should do nothing; the backdrop dismisses.
        if (event.target === cover) dismiss();
      });
      cover.querySelector('.fm-pr-close')?.addEventListener('click', dismiss);
      var settle = function(){
        if (!document.body.contains(cover)) return;
        var overlay = document.getElementById('rOverlay');
        // The real modal owns the screen now, or nothing ever claimed it.
        if (overlay && overlay.classList.contains('active')) dismiss();
        else if (Date.now() - started > 15000) dismiss();
        else setTimeout(settle, 500);
      };
      var started = Date.now();
      setTimeout(settle, 1500);
    })();
  </script>
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
      <input id="mobilePlatformGlobalSearch" data-platform-search-input type="search" placeholder="Search" aria-label="Search" autocomplete="off">
      <div class="ptb-search-results" id="mobilePlatformSearchResults"></div>
    </div>
    <div class="mob-notifications platform-assistant" id="mobilePlatformAssistantSlot" hidden>
      <button type="button" class="ptb-bell" id="mobilePlatformAssistantBtn" data-fm-tooltip="AI Assistant" aria-label="AI Assistant">
        <i class="fas fa-wand-magic-sparkles"></i>
      </button>
    </div>
    <div class="mob-notifications platform-messages" id="mobilePlatformMessagesSlot" hidden>
      <button type="button" class="ptb-bell" id="mobilePlatformMessagesBtn" data-fm-tooltip="Messages" aria-label="Messages">
        <i class="fas fa-comments"></i>
        <span class="ptb-count" id="mobilePlatformMessagesCount">0</span>
      </button>
      <div class="ptb-menu ptb-menu--messages" id="mobilePlatformMessagesMenu">
        <div class="ptb-menu-head">Messages</div>
        <div id="mobilePlatformMessagesList"><div class="ptb-empty">Loading...</div></div>
      </div>
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
    <div class="mob-notifications platform-more" id="mobilePlatformMoreSlot" hidden>
      <button type="button" class="ptb-bell" id="mobilePlatformMoreBtn" aria-label="More">
        <i class="fas fa-ellipsis-vertical"></i>
        <span class="ptb-count" id="mobilePlatformMoreCount">0</span>
      </button>
      <div class="ptb-menu ptb-menu--more" id="mobilePlatformMoreMenu">
        <button type="button" class="ptb-more-item" id="mobilePlatformMoreAssistant"><i class="fas fa-wand-magic-sparkles"></i><span>AI Assistant</span></button>
        <button type="button" class="ptb-more-item" id="mobilePlatformMoreMessages"><i class="fas fa-comments"></i><span>Messages</span><b class="ptb-more-count" id="mobilePlatformMoreMessagesCount" hidden>0</b></button>
        <button type="button" class="ptb-more-item" id="mobilePlatformMoreNotifications"><i class="fas fa-bell"></i><span>Notifications</span><b class="ptb-more-count" id="mobilePlatformMoreNotificationCount" hidden>0</b></button>
      </div>
    </div>
  </div>

  <!-- ====== SIDEBAR BACKDROP (mobile only) ====== -->
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>

  <aside class="sidebar" id="mainSidebar">
    <div class="logo-area">
      <span class="sidebar-mini-logo" role="img" aria-label="FirstMate"></span>
      <span class="firstmate-color-logo" role="img" aria-label="FirstMate"></span>
      <span class="cobrand-logo-divider" aria-hidden="true"></span>
      <img id="companyLogoImg" alt="Logo" style="display:none">
    </div>

    <div class="sidebar-scroll">
      <div class="new-menu-wrap" id="newMenuWrap">
        <button class="btn-primary" id="btnNewReq" aria-haspopup="menu" aria-expanded="false" data-fm-track="new_project_clicked" data-fm-track-source="sidebar">
          <span>New</span>
          <i class="fas fa-plus-circle sidebar-new-full-icon"></i>
          <i class="fas fa-plus sidebar-new-mini-icon" aria-hidden="true"></i>
        </button>
        <div class="new-menu-popout" id="newMenuPopout" role="menu" aria-label="Create new">
          <!-- Items are re-rendered by initNewMenu() from platform.new_button_items
               + the document type registry; this markup is the pre-flags fallback. -->
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="project"><i class="fas fa-folder-plus"></i><span>Project</span></button>
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="contact"><i class="fas fa-address-book"></i><span>Contact</span></button>
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="report"><i class="fas fa-file-lines"></i><span>New Report</span></button>
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="document"><i class="fas fa-file-medical"></i><span>Document</span></button>
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="payment"><i class="fas fa-money-check-dollar"></i><span>Payment</span></button>
          <button type="button" class="new-menu-item" role="menuitem" data-new-workflow="appointment"><i class="fas fa-calendar-plus"></i><span>Appointment</span></button>
        </div>
      </div>

      <div class="sidebar-mode-tabs" role="tablist" aria-label="Sidebar">
        <button type="button" class="sidebar-mode-tab active" id="sidebarAppsTab" role="tab" aria-selected="true" aria-controls="sidebarAppsPanel">Apps</button>
        <button type="button" class="sidebar-mode-tab" id="sidebarTodoTab" role="tab" aria-selected="false" aria-controls="sidebarTodoPanel">To Do</button>
        <button type="button" class="sidebar-mode-tab" id="sidebarChannelsTab" role="tab" aria-selected="false" aria-controls="sidebarChannelsPanel">Channels</button>
        <button type="button" class="sidebar-mode-tab" id="sidebarAgentsTab" role="tab" aria-selected="false" aria-controls="sidebarAgentsPanel">Agents</button>
      </div>

      <div class="sidebar-panel active" id="sidebarAppsPanel" role="tabpanel" aria-labelledby="sidebarAppsTab">
        <button type="button" class="sidebar-app-scroll-control" id="sidebarAppsScrollUp" aria-label="Scroll apps up" title="Scroll apps up" hidden><i class="fas fa-chevron-up" aria-hidden="true"></i></button>
        <div id="sidebarLinks"></div>
        <button type="button" class="sidebar-app-scroll-control" id="sidebarAppsScrollDown" aria-label="Scroll apps down" title="Scroll apps down" hidden><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
      </div>

      <div class="sidebar-panel" id="sidebarTodoPanel" role="tabpanel" aria-labelledby="sidebarTodoTab" hidden>
        <div id="sidebarTodoList"></div>
      </div>

      <div class="sidebar-panel" id="sidebarChannelsPanel" role="tabpanel" aria-labelledby="sidebarChannelsTab" hidden>
        <div id="sidebarChannelsList"></div>
      </div>
      <div class="sidebar-panel" id="sidebarAgentsPanel" role="tabpanel" aria-labelledby="sidebarAgentsTab" hidden>
        <div id="sidebarAgentsList"></div>
      </div>

      <!-- Attention banner sidebar surface. Rendered by PlatformBanners; must
           stay a SIBLING of #sidebarBottomLinks (that container is wiped and
           re-rendered by renderSidebarLaunchers on every sidebar render). -->
      <div id="sidebarAttentionSlot" class="sidebar-attention-slot" hidden></div>

      <div id="sidebarBottomLinks" aria-label="Sidebar settings"></div>

      <div class="sidebar-footer">
        <button type="button" class="fm-account-switcher-trigger" id="accountSwitcherButton" aria-haspopup="dialog" aria-expanded="false" aria-label="Choose account">
          <span class="fm-account-avatar" aria-hidden="true"><?= htmlspecialchars(strtoupper(substr(trim($userName ?: $userEmail), 0, 1) ?: '?')) ?></span>
          <span class="fm-account-trigger-copy">
            <strong class="who" id="whoName"><?= htmlspecialchars($userName) ?></strong>
            <small class="em" id="whoEmail"><?= htmlspecialchars($userEmail) ?></small>
          </span>
          <i class="fas fa-chevron-up fm-account-trigger-chevron" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <button type="button" class="sidebar-compact-toggle" id="sidebarCompactToggle" aria-label="Keep sidebar expanded" aria-pressed="false" title="Keep sidebar expanded"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
  </aside>

  <main class="main">
    <div class="platform-topbar" id="platformTopbar">
      <div class="platform-topbar-app-left" id="platformTopbarAppLeft" data-platform-topbar-left></div>
      <div class="platform-search">
        <i class="fas fa-search"></i>
        <input id="platformGlobalSearch" data-platform-search-input type="search" placeholder="Search" aria-label="Search" autocomplete="off">
        <div class="ptb-search-results" id="platformSearchResults"></div>
      </div>
      <div class="platform-assistant" id="platformAssistantSlot" hidden>
        <button type="button" class="ptb-bell" id="platformAssistantBtn" data-fm-tooltip="AI Assistant" aria-label="AI Assistant">
          <i class="fas fa-wand-magic-sparkles"></i>
        </button>
      </div>
      <div class="platform-messages" id="platformMessagesSlot" hidden>
        <button type="button" class="ptb-bell" id="platformMessagesBtn" data-fm-tooltip="Messages" aria-label="Messages">
          <i class="fas fa-comments"></i>
          <span class="ptb-count" id="platformMessagesCount">0</span>
        </button>
        <div class="ptb-menu ptb-menu--messages" id="platformMessagesMenu">
          <div class="ptb-menu-head">Messages</div>
          <div id="platformMessagesList"><div class="ptb-empty">Loading...</div></div>
        </div>
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
  <script src="../libraries/platform-undo/platform-undo.js?v=<?= $ver ?>"></script>
  <script src="../libraries/proposals-api/proposals-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/materials-api/materials-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/payments-api/payments-api.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/payroll-api/payroll-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/financials-api/financials-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/stats-api/stats-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/assistant-api/assistant-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/agents-api/agents-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/agent-chat/agent-chat.js?v=<?= $ver ?>"></script>
  <script src="../libraries/insights/firstmate-insights.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-agent/doc-agent.js?v=<?= $ver ?>"></script>
  <script src="../libraries/crew-api/crew-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/sales-api/sales-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/training-api/training-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/equipment-api/equipment-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/payment-intake/payment-intake.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/email-api/email-api.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/communications-api/communications-api.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/platform-realtime/platform-realtime.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/calls-runtime/livekit-client.umd.js?v=<?= $ver ?>"></script>
  <script src="../libraries/calls-api/calls-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/channels-api/channels-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/audio-notes/audio-notes.js?v=<?= $ver ?>"></script>
  <script src="../libraries/audio-structure/audio-structure.js?v=<?= $ver ?>"></script>
  <script src="../libraries/window-manager/window-manager.js?v=<?= $ver ?>"></script>
  <script src="../libraries/channels-ui/channels-ui.js?v=<?= $ver ?>"></script>
  <script src="../libraries/project-notes/project-notes.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/lead-intake-api/lead-intake-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/canvassing-api/canvassing-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-celebrations/platform-celebrations.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-notifications/platform-notifications.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-notifications/platform-push.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-banners/platform-banners.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-action-items/platform-action-items.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-tags/platform-tags.js?v=<?= $ver ?>"></script>
  <script src="../libraries/markup/firstmate-markup.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/video-editor/firstmate-video-editor.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/platform-scheduling/platform-scheduling.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-language/platform-language.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-terminology/platform-terminology.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-schedule-view/platform-schedule-view.js?v=<?= $ver ?>"></script>
  <script src="../libraries/firstmeasure-api/firstmeasure-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/statsig/firstmate-statsig.js?v=<?= $ver ?>"></script>
  <script src="../libraries/settings-pages/firstmate-settings-pages.js?v=<?= $ver ?>"></script>
  <script src="../libraries/app-runtime/firstmate-embeddable-apps.js?v=<?= $ver ?>"></script>
  <script src="../libraries/app-runtime/firstmate-app-context.js?v=<?= $ver ?>"></script>
  <script src="../libraries/navigation/portal-navigation.js?v=<?= $ver ?>"></script>
  <script src="../libraries/setup-wizard/setup-wizard.js?v=<?= $ver ?>"></script>
  <script src="landing/shared/signup-widget.js?v=<?= $ver ?>"></script>
  <script src="../libraries/account-switcher/account-switcher.js?v=<?= $ver ?>"></script>
  <script src="../libraries/custom-fields/firstmate-custom-fields.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/documents-api/documents-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-model/firstmate-doc-model.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-widgets/firstmate-doc-widgets.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-renderer/firstmate-doc-renderer.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-workflow/firstmate-doc-workflow.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-language/firstmate-doc-language.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-editor/firstmate-doc-editor.js?v=<?= $ver ?>"></script>
  <script src="../libraries/visual-editor/firstmate-visual-editor.js?v=<?= $ver ?>"></script>
  <script src="../libraries/doc-workflow/firstmate-workflow-editor.js?v=<?= $ver ?>"></script>
  <script src="../libraries/web-widgets/firstmate-web-widgets.js?v=<?= $ver ?>"></script>
  <script src="../libraries/portal-widgets/firstmate-portal-widgets.js?v=<?= $ver ?>"></script>
  <script src="../libraries/websites-api/websites-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/domains-api/domains-api.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/firstmate-apps-manifest.js?v=<?= $ver ?>"></script>
  <script src="../libraries/report-units.js?v=<?= $ver ?>"></script>
  <script src="../libraries/platform-commerce/platform-commerce.js?v=<?= $ver ?>"></script>
  <script src="scripts/core.js?v=<?= $ver ?>"></script>
  <script src="../libraries/payments-setup/payments-setup.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/app-runtime/firstmate-external-apps.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <?php
    if ($platformExpandedAssets) {
      $externalAppsRegistry = dirname(__DIR__, 2) . '/external-apps/registry.php';
      if (is_file($externalAppsRegistry)) {
        require_once $externalAppsRegistry;
        fm_external_render();
      } else {
        error_log('FirstMate external app registry is missing; continuing portal render without external apps.');
      }
    }
  ?>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/app-setup-workflows/app-setup-workflows.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/settings/search.js?v=<?= $ver ?>"></script>
  <script src="scripts/topbar-artifacts.js?v=<?= $ver ?>"></script>
  <script src="scripts/topbar.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/platform-assistant/platform-assistant.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="scripts/project_viewer.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/tab-promos/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-map/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/customer-portal/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-schedule/panel.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/comms-api/comms-api.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/comms/communications-ui.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/comms/calling-runtime.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/comms/workspace.js?v=<?= $ver ?>"></script>
  <script src="../libraries/communications-templates/communications-templates.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/comms/project.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/measurements/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/firstmeasure/order/exteriors.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/firstmeasure/order/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/projects/viewer.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/photos/feed.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/apps/receipts/app.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/photos/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/docs/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/pricebook/firstmate-pricebook.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/pricebook/bridge.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/materials/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/proposals/project.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/apps/documents/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/payroll/project.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/money/project.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/apps/checklists/app.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/proposals/global.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/project-request/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/contacts/modal.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/contacts/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/scheduling/app.js?v=<?= $ver ?>"></script>
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/apps/financials/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/invoices/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/stats/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/payroll/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/crew/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/sales/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/signatures/project.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/training/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/training/studio.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/equipment/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/documents/studio.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/web-editor/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/chat/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/channels/app.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
  <script src="../libraries/apps/canvassing/app.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/billing/app.js?v=<?= $ver ?>"></script>
  <!-- Floating help widget disabled 2026-07-22: low value and it covered UI (e.g. chat composers). Re-enable by restoring this tag.
  <script src="../libraries/apps/help/app.js?v=<?= $ver ?>"></script> -->
  <!--<script src="../libraries/apps/tutorial/app.js?v=<?= $ver ?>"></script>-->
  <?php if ($platformExpandedAssets): ?>
  <script src="../libraries/apps/settings/crm.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/contacts.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/automations.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/scope-events.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/scope-artifacts.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/feedback.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/equipment.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/live_chat.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/comms.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/channels.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/payroll.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/domains.js?v=<?= $ver ?>"></script>
  <?php endif; ?>
<script src="../libraries/phone-features/phone-features.js?v=<?= $ver ?>"></script>
<script src="../libraries/phone-features/app-download.js?v=<?= $ver ?>"></script>
<script src="../libraries/apps/settings/firstmeasure-users.js?v=<?= $ver ?>"></script>
  <script src="../libraries/apps/settings/platform-billing.js?v=<?= $ver ?>"></script>
  <script src="../libraries/brand-kit/brand-kit.js?v=<?= $ver ?>"></script>
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

  <!-- Signup Sandbox dev bar: no-ops unless the logged-in org is a sandbox
       test org (and /v1/signup-sandbox is dead in production entirely). -->
  <script src="signup-sandbox/devbar.js?v=<?= $ver ?>" defer></script>

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
        const mode = mainBtn?.dataset?.newButtonMode || 'selector';
        if (mode === 'off') return;
        if (mode === 'selector') openSidebar();
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
        // fa-file-circle-plus needs FA 6.1+; the portal ships FA 6.0.
        document: { label: 'New Document', icon: 'fa-file-medical', workflow: 'document' },
        payment: { label: 'New Payment', icon: 'fa-money-check-dollar', workflow: 'payment' },
        appointment: { label: 'New Appointment', icon: 'fa-calendar-plus', workflow: 'appointment' }
      };
      /* Data-driven document actions: every registered document type is a
         "doc:<type_id>" mode ("New Proposal" = start the create wizard with
         that type picked). Labels/icons come from the documents catalog. */
      const DOC_TYPE_ICONS = {
        proposal: 'fa-file-signature',
        invoice: 'fa-file-invoice-dollar',
        change_order: 'fa-file-contract',
        contract: 'fa-file-pen',
        work_order: 'fa-clipboard-list',
        completion_certificate: 'fa-award',
        report: 'fa-file-lines'
      };
      let docTypes = [];
      let docTypesLoading = false;
      const escText = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
      const documentsEnabled = () => {
        const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
        if (!flags?.current?.()) return false;
        return flags.value?.('platform', 'documents', undefined) === true;
      };
      const docTypeLabel = (id) => {
        const type = docTypes.find((entry) => entry.id === id);
        if (type?.label) return type.label;
        return String(id || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      };
      const docTypeIcon = (id) => docTypes.find((entry) => entry.id === id)?.icon || DOC_TYPE_ICONS[id] || 'fa-file-lines';
      const isDocMode = (mode) => mode === 'document' || String(mode || '').startsWith('doc:');
      const modeConfig = (mode) => {
        const raw = String(mode || '');
        if (raw.startsWith('doc:')) {
          const typeId = raw.slice(4);
          return { label: `New ${docTypeLabel(typeId)}`, icon: docTypeIcon(typeId), workflow: 'document', documentType: typeId };
        }
        return modes[raw] || null;
      };
      const loadDocTypes = () => {
        if (docTypes.length || docTypesLoading || !documentsEnabled() || !window.DocumentsAPI?.catalog?.get) return;
        const orgId = String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
        if (!orgId) return;
        docTypesLoading = true;
        window.DocumentsAPI.catalog.get(orgId).then((res) => {
          const data = res?.catalog && Object.keys(res.catalog).length ? res.catalog : (res || {});
          docTypes = (Array.isArray(data.types) ? data.types : [])
            .map((type) => ({
              id: String(type.id || type.type || '').trim(),
              label: String(type.label || '').trim(),
              icon: String(type.icon || '').trim()
            }))
            .filter((type) => type.id && type.id !== 'generic');
          renderMenuItems();
          setButtonMode();
        }).catch(() => null).finally(() => { docTypesLoading = false; });
      };
      const normalizeMode = (value) => {
        const raw = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
        if (raw === 'menu' || raw === 'select' || raw === 'chooser') return 'selector';
        if (raw === 'new_project') return 'project';
        if (raw === 'new_contact' || raw === 'customer') return 'contact';
        if (raw === 'new_report' || raw === 'roof' || raw === 'measurement') return 'report';
        /* Legacy proposal mode maps onto the document-engine proposal type. */
        if (raw === 'proposal' || raw === 'new_proposal') return 'doc:proposal';
        if (raw === 'new_document') return 'document';
        if (raw.startsWith('doc:')) return raw;
        if (raw === 'new_payment' || raw === 'payment') return 'payment';
        if (raw === 'new_appointment' || raw === 'schedule' || raw === 'scheduling') return 'appointment';
        if (raw === 'off' || raw === 'none' || raw === 'hidden' || raw === 'disabled') return 'off';
        return modes[raw] ? raw : 'report';
      };
      const DEFAULT_MENU_ITEMS = ['project', 'contact', 'report', 'document', 'payment', 'appointment'];
      const itemAvailable = (id) => {
        if (isDocMode(id)) return documentsEnabled();
        return !!modes[id] && id !== 'selector';
      };
      const configuredMenuItems = () => {
        const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
        const raw = String(flags?.value?.('platform', 'new_button_items', '') || '').trim();
        const ids = raw
          ? raw.split(',').map((part) => normalizeMode(part)).filter(Boolean)
          : DEFAULT_MENU_ITEMS;
        return [...new Set(ids)].filter(itemAvailable);
      };
      const renderMenuItems = () => {
        const items = configuredMenuItems()
          .map((id) => ({ id, config: modeConfig(id) }))
          .filter((entry) => entry.config);
        if (!items.length) return;
        menu.innerHTML = items.map(({ id, config }) => {
          const short = config.label.replace(/^New\s+/i, '');
          return `<button type="button" class="new-menu-item" role="menuitem" data-new-workflow="${escText(id)}"><i class="fas ${escText(config.icon)}"></i><span>${escText(short)}</span></button>`;
        }).join('');
      };
      const isFieldOnlyUser = () => {
        const access = window.Portal?.currentUser?.applicationAccess || {};
        return access.field?.enabled === true && access.management?.enabled !== true;
      };
      const syncCreateAccess = (mode = '') => {
        const fieldOnly = isFieldOnlyUser();
        const unavailable = fieldOnly || mode === 'off';
        document.documentElement.dataset.fmFieldOnly = fieldOnly ? 'true' : 'false';
        sidebar?.classList.toggle('new-button-unavailable', unavailable);
        wrap.hidden = unavailable;
        const mobileBtn = document.getElementById('mobNewReqBtn');
        if (mobileBtn) mobileBtn.hidden = unavailable;
        if (unavailable) closeMenu();
        return !unavailable;
      };
      const configuredMode = () => normalizeMode(
        window.Portal?.appFlags?.value?.('platform', 'new_button_mode',
          window.PlatformAPI?.appFlags?.value?.('platform', 'new_button_mode', 'report')
        )
      );
      const setButtonMode = () => {
        let mode = configuredMode();
        btn.dataset.newButtonMode = mode;
        if (!syncCreateAccess(mode)) return;
        if (isDocMode(mode) && !documentsEnabled()) mode = 'selector';
        const config = modeConfig(mode) || modes.selector;
        btn.querySelector('span').textContent = config.label;
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'fas fa-plus-circle sidebar-new-full-icon';
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
        renderMenuItems();
        loadDocTypes();
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
      const paymentOrgId = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
      const paymentBranchId = () => String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || window.__APP?.branchId || 'default').trim() || 'default';
      const paymentProjectTitle = (project) => String(project?.title || project?.project_title || project?.address || project?.name || project?.id || '').trim();
      const paymentProjectContact = (project) => {
        const contacts = Array.isArray(project?.contacts) ? project.contacts : [];
        return contacts.find((item) => String(item?.name || item?.email || item?.phone || '').trim()) || null;
      };
      const printPaymentReceipt = (result = {}, context = {}) => {
        const amount = Number(result.amount_cents || result.amountCents || context.amountCents || 0) / 100;
        const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        const win = window.open('', '_blank', 'width=560,height=720');
        if (!win) return window.Portal?.ui?.showToast?.('Could not open receipt window.', 'error');
        win.document.write(`<!doctype html><title>Payment Receipt</title><body style="font-family:Inter,Arial,sans-serif;padding:32px;color:#101828"><h1 style="margin:0 0 8px">Payment Receipt</h1><p style="margin:0 0 24px;color:#667085">${String(result.id || result.payment_id || 'Pending receipt')}</p><div><strong>Customer</strong><br>${String(context.customer || 'Customer payment')}</div><div style="margin-top:16px"><strong>Project</strong><br>${String(context.project || 'Not associated')}</div><div style="margin-top:16px"><strong>Amount</strong><br>${formatter.format(amount)}</div><div style="margin-top:16px"><strong>Date</strong><br>${new Date().toLocaleString()}</div><script>window.print();<\/script></body>`);
        win.document.close();
      };
      const cachedPaymentProjects = () => {
        const store = window.Portal?.ProjectStore;
        return (store?.cachedIds?.() || []).map((id) => store.get?.(id)).filter(Boolean);
      };
      const loadPaymentProjects = async () => {
        const projects = cachedPaymentProjects();
        const orgId = paymentOrgId();
        if (window.PlatformAPI?.projects?.list && orgId) {
          const result = await window.PlatformAPI.projects.list(orgId).catch(() => null);
          (result?.documents || result?.projects || []).forEach((doc) => {
            const data = doc?.data || doc?.project || doc?.document?.data || doc;
            const project = window.Portal?.ProjectStore?.cache?.({ ...data, id: data?.id || doc?.id }) || data;
            if (project?.id && !projects.some((item) => item.id === project.id)) projects.push(project);
          });
        }
        return projects;
      };
      const paymentCentsFromAmount = (value) => {
        const number = Number(String(value || '').replace(/[$,\s]/g, ''));
        return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0;
      };
      const openNewPaymentModal = () => {
        if (!window.FirstMatePaymentIntake?.mount || !window.PaymentsAPI?.payments?.create) {
          window.Portal?.ui?.showToast?.('Payment intake is not available yet.', 'error');
          return;
        }
        const modal = document.createElement('div');
        modal.className = 'fm-payment-modal';
        modal.innerHTML = `
          <style>
            .fm-payment-modal{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(15,23,42,.58);padding:20px}
            .fm-payment-shell{width:min(1060px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:10px;box-shadow:0 24px 80px rgba(15,23,42,.30);padding:18px;display:grid;gap:14px;color:#101828}
            .fm-payment-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.fm-payment-head h2{margin:0;font-size:20px}.fm-payment-head p{margin:3px 0 0;color:#667085;font-size:13px}.fm-payment-close{border:0;background:#111827;color:#fff;border-radius:7px;width:36px;height:36px;cursor:pointer}
            .fm-payment-intake{display:grid;grid-template-columns:minmax(320px,.82fr) minmax(380px,1.18fr);gap:16px;align-items:start}.fm-payment-left{display:grid;gap:12px}.fm-payment-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:12px;display:grid;gap:10px;background:#fff}.fm-payment-card h3{margin:0;font-size:13px}.fm-payment-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px}.fm-payment-field{display:grid;gap:4px}.fm-payment-field.wide{grid-column:1/-1}.fm-payment-field span{font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.fm-payment-field input{border:1px solid #d0d5dd;border-radius:8px;padding:10px 11px;font:inherit;min-width:0}.fm-payment-results{display:grid;gap:6px;max-height:170px;overflow:auto}.fm-payment-result{border:1px solid #e4e7ec;border-radius:8px;background:#fff;padding:9px;text-align:left;cursor:pointer}.fm-payment-result strong,.fm-payment-selected strong{display:block;font-size:12px}.fm-payment-result small,.fm-payment-selected small{display:block;color:#667085;margin-top:2px}.fm-payment-selected{border:1px solid rgba(6,118,71,.2);background:#f6fef9;border-radius:8px;padding:9px;display:flex;justify-content:space-between;gap:10px}.fm-payment-clear{border:0;background:transparent;color:#067647;font-weight:900;cursor:pointer}.fm-payment-methods{display:grid;gap:8px}.fm-payment-method{display:flex;align-items:center;gap:10px;border:1px solid #e4e7ec;background:#fff;border-radius:8px;padding:10px;text-align:left;cursor:pointer}.fm-payment-method.active{border-color:rgba(6,118,71,.36);box-shadow:0 0 0 3px rgba(6,118,71,.10);background:#f6fef9}.fm-payment-icon{width:30px;height:30px;border-radius:8px;background:rgba(6,118,71,.08);color:#067647;display:grid;place-items:center}.fm-payment-right{border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:14px;min-height:420px;background:#fff}
            @media(max-width:820px){.fm-payment-intake{grid-template-columns:1fr}.fm-payment-fields{grid-template-columns:1fr}}
          </style>
          <div class="fm-payment-shell" role="dialog" aria-modal="true" aria-label="New payment">
            <div class="fm-payment-head"><div><h2>New payment</h2><p>Take a custom customer payment over the phone.</p></div><button type="button" class="fm-payment-close" data-fm-payment-close aria-label="Close">x</button></div>
            <div class="fm-payment-intake">
              <div class="fm-payment-left">
                <div class="fm-payment-card">
                  <h3>Project</h3>
                  <label class="fm-payment-field wide"><span>Search</span><input type="search" data-fm-pay-project-search placeholder="Search project, address, or customer"></label>
                  <div data-fm-pay-selected></div>
                  <div class="fm-payment-results" data-fm-pay-results></div>
                </div>
                <div class="fm-payment-card">
                  <h3>Payment</h3>
                  <label class="fm-payment-field wide"><span>Amount</span><input type="text" inputmode="decimal" data-fm-pay-amount placeholder="0.00"></label>
                  <div class="fm-payment-methods" data-fm-pay-methods></div>
                </div>
              </div>
              <div class="fm-payment-right" data-fm-pay-mount></div>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        const handle = window.Portal?.modals?.register?.(modal, { id: 'new-payment', closeOnBackdrop: true, onClose: () => modal.remove() });
        const close = () => handle?.close?.('close') || modal.remove();
        modal.querySelector('[data-fm-payment-close]')?.addEventListener('click', close);
        const amountInput = modal.querySelector('[data-fm-pay-amount]');
        const searchInput = modal.querySelector('[data-fm-pay-project-search]');
        const resultsNode = modal.querySelector('[data-fm-pay-results]');
        const selectedNode = modal.querySelector('[data-fm-pay-selected]');
        const methodsNode = modal.querySelector('[data-fm-pay-methods]');
        const mountNode = modal.querySelector('[data-fm-pay-mount]');
        let projects = cachedPaymentProjects();
        let selectedProject = null;
        let intakeHandle = null;
        let selectedMethod = 'card';
        let selectedSavedMethod = '';
        const contact = () => paymentProjectContact(selectedProject) || null;
        const renderSelected = () => {
          selectedNode.innerHTML = selectedProject ? `<div class="fm-payment-selected"><span><strong>${paymentProjectTitle(selectedProject)}</strong><small>${String(paymentProjectContact(selectedProject)?.name || selectedProject.id || '')}</small></span><button type="button" class="fm-payment-clear" data-fm-pay-clear>Clear</button></div>` : '';
          selectedNode.querySelector('[data-fm-pay-clear]')?.addEventListener('click', () => { selectedProject = null; renderSelected(); renderIntake(); });
        };
        const renderSearch = () => {
          const query = searchInput.value.trim().toLowerCase();
          if (!query) { resultsNode.innerHTML = ''; return; }
          const matches = projects.filter((project) => `${paymentProjectTitle(project)} ${paymentProjectContact(project)?.name || ''} ${paymentProjectContact(project)?.email || ''}`.toLowerCase().includes(query)).slice(0, 8);
          resultsNode.innerHTML = matches.map((project, index) => `<button type="button" class="fm-payment-result" data-fm-pay-project="${index}"><strong>${paymentProjectTitle(project)}</strong><small>${String(paymentProjectContact(project)?.name || project.id || '')}</small></button>`).join('') || '<div style="color:#667085;font-size:12px;font-weight:800">No projects found.</div>';
          resultsNode.querySelectorAll('[data-fm-pay-project]').forEach((button) => button.addEventListener('click', () => {
            selectedProject = matches[Number(button.dataset.fmPayProject || 0)] || null;
            searchInput.value = '';
            resultsNode.innerHTML = '';
            renderSelected();
            renderIntake();
          }));
        };
        const renderMethods = () => {
          const saved = intakeHandle?.context?.options?.savedMethods || [];
          const savedHtml = saved.map((method) => `<button type="button" class="fm-payment-method ${selectedSavedMethod === method.id ? 'active' : ''}" data-fm-pay-saved="${method.id}"><span class="fm-payment-icon"><i class="fas ${method.type === 'ach' ? 'fa-building-columns' : 'fa-credit-card'}"></i></span><span><strong>${method.label}</strong><small>${method.detail || 'Saved method'}</small></span></button>`).join('');
          methodsNode.innerHTML = `
            <button type="button" class="fm-payment-method ${selectedMethod === 'card' && !selectedSavedMethod ? 'active' : ''}" data-fm-pay-method="card"><span class="fm-payment-icon"><i class="fas fa-credit-card"></i></span><span><strong>Card</strong><small>Credit or debit card</small></span></button>
            <button type="button" class="fm-payment-method ${selectedMethod === 'ach' && !selectedSavedMethod ? 'active' : ''}" data-fm-pay-method="ach"><span class="fm-payment-icon"><i class="fas fa-building-columns"></i></span><span><strong>ACH</strong><small>Bank transfer</small></span></button>
            ${savedHtml}
          `;
          methodsNode.querySelectorAll('[data-fm-pay-method]').forEach((button) => button.addEventListener('click', () => {
            selectedMethod = button.dataset.fmPayMethod || 'card';
            selectedSavedMethod = '';
            intakeHandle?.setMethod?.(selectedMethod);
            renderMethods();
          }));
          methodsNode.querySelectorAll('[data-fm-pay-saved]').forEach((button) => button.addEventListener('click', () => {
            selectedSavedMethod = button.dataset.fmPaySaved || '';
            intakeHandle?.setSavedMethod?.(selectedSavedMethod);
            renderMethods();
          }));
        };
        const renderIntake = () => {
          intakeHandle?.close?.();
          const currentContact = contact();
          intakeHandle = window.FirstMatePaymentIntake.mount(mountNode, {
            title: '',
            amountProvider: () => paymentCentsFromAmount(amountInput.value),
            amountCents: 0,
            allowCustomAmount: false,
            detailsOnly: true,
            methods: ['card', 'ach'],
            contact: currentContact.name || currentContact.email || currentContact.phone ? currentContact : null,
            allowSavedMethods: !!selectedProject && !!(currentContact.name || currentContact.email || currentContact.phone),
            allowSavePaymentMethod: true,
            submitLabel: 'Run Payment',
            successTitle: 'Payment recorded',
            successActions: [
              { label: 'Print receipt', onClick: (result) => printPaymentReceipt(result, { amountCents: result?.amountCents, customer: currentContact.name || currentContact.email || 'Customer payment', project: selectedProject ? paymentProjectTitle(selectedProject) : '' }) },
              { label: 'Email receipt', onClick: () => window.Portal?.ui?.showToast?.('Receipt email is ready for processor wiring.', 'success') },
              { label: 'Close', primary: true, onClick: close }
            ],
            onSubmit: async (payment) => {
              const methodLabel = payment.savedPaymentMethod?.label || String(payment.method || 'payment').replace(/_/g, ' ');
              const result = await window.PaymentsAPI.payments.create(paymentOrgId(), {
                project_id: selectedProject?.id || '',
                branch_id: paymentBranchId(),
                amount_cents: payment.amountCents,
                kind: 'customer_payment',
                direction: 'inbound',
                status: 'settled',
                allocate: !!selectedProject?.id,
                method: { type: payment.savedPaymentMethodId ? `saved_${payment.method}` : payment.method, label: methodLabel },
                contact_ref: currentContact,
                notes: selectedProject?.id ? `Phone payment for ${paymentProjectTitle(selectedProject)}.` : 'Phone payment without project association.'
              });
              window.Portal?.ui?.showToast?.('Payment saved.', 'success');
              return result?.payment || result || {};
            }
          });
          if (selectedSavedMethod && !intakeHandle.context.options.savedMethods.some((method) => method.id === selectedSavedMethod)) selectedSavedMethod = '';
          if (selectedSavedMethod) intakeHandle.setSavedMethod(selectedSavedMethod);
          else intakeHandle.setMethod(selectedMethod);
          renderMethods();
        };
        amountInput.addEventListener('input', () => intakeHandle?.updateSubmitState?.());
        searchInput.addEventListener('input', renderSearch);
        renderSelected();
        renderIntake();
        void loadPaymentProjects().then((loaded) => { projects = loaded; renderSearch(); renderMethods(); });
      };
      const runMode = (mode) => {
        closeMenu();
        if (sidebar?.classList.contains('mob-open')) closeSidebar();
        if (mode === 'payment') {
          openNewPaymentModal();
          return;
        }
        const config = modeConfig(mode) || modes.project;
        window.dispatchEvent(new CustomEvent('fm:new-project-workflow', {
          detail: { workflow: config.workflow || 'project', ...(config.documentType ? { documentType: config.documentType } : {}) }
        }));
      };
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        let mode = configuredMode();
        if (!syncCreateAccess(mode)) return;
        if (isDocMode(mode) && !documentsEnabled()) mode = 'selector';
        if (mode !== 'selector') {
          runMode(mode);
          return;
        }
        wrap.classList.contains('open') ? closeMenu() : openMenu();
      });
      menu.addEventListener('click', (event) => {
        if (!syncCreateAccess(configuredMode())) return;
        const item = event.target.closest('[data-new-workflow]');
        if (!item) return;
        const mode = item.dataset.newWorkflow || 'project';
        if (isDocMode(mode) && !documentsEnabled()) return;
        runMode(mode);
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
      window.addEventListener('fm:platform-session:updated', setButtonMode);
      setButtonMode();
    })();

    /* Close sidebar when a sidebar tab link is clicked (mobile UX) */
    document.addEventListener('click', (e)=>{
      if (!sidebar.classList.contains('mob-open')) return;
      const link = e.target.closest('.fm-link, .sidebar-launcher-icon[data-tab]');
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

  <script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyArWL1FL5W-QHEzbvcYpRl28pW88RKJDBA&v=3.64&libraries=places&loading=async" async defer></script>
</body>
</html>
