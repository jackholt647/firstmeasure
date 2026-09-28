<?php
$portalId = isset($_GET['id']) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['id']) : '';
$assetVer = max(
    @filemtime(__DIR__ . '/customer_portal.css') ?: 0,
    @filemtime(__DIR__ . '/customer_portal.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/platform-api/platform-api.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/payment-intake/payment-intake.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/audio-notes/audio-notes.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/audio-structure/audio-structure.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/web-widgets/firstmate-web-widgets.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/portal-widgets/firstmate-portal-widgets.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/chat-embed/html2canvas.min.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/chat-embed/firstmate-chat-embed.js') ?: 0
);
$platformApiVer = @md5_file(__DIR__ . '/../libraries/platform-api/platform-api.js') ?: (string)$assetVer;
$portalCssVer = @md5_file(__DIR__ . '/customer_portal.css') ?: (string)$assetVer;
$portalJsVer = @md5_file(__DIR__ . '/customer_portal.js') ?: (string)$assetVer;
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Customer Portal Preview</title>
  <script>
    window.__APP = window.__APP || {};
    window.__APP.platformApiBase = (function(){
      var host = String(location.hostname || '').toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost') {
        return location.protocol + '//' + location.hostname + ':3101/v1/platform';
      }
      return '/v1/platform';
    })();
    window.Portal = window.Portal || {};
    window.Portal.modules = window.Portal.modules || {};
    window.Portal.cfg = window.Portal.cfg || window.__APP || {};
    window.Portal.util = window.Portal.util || {};
    window.Portal.util.$ = window.Portal.util.$ || function(sel, root){ return (root || document).querySelector(sel); };
    window.Portal.util.escapeHtml = window.Portal.util.escapeHtml || function(value){
      return String(value == null ? '' : value).replace(/[&<>"']/g, function(match){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[match];
      });
    };
    window.Portal.util.injectCSS = window.Portal.util.injectCSS || function(id, css){
      if (!id || document.getElementById(id)) return;
      var style = document.createElement('style');
      style.id = id;
      style.textContent = css || '';
      document.head.appendChild(style);
    };
    window.Portal.util.fmUrl = window.Portal.util.fmUrl || function(path){ return String(path || ''); };
    window.Portal.util.formatDate = window.Portal.util.formatDate || function(value){ return String(value || ''); };
    window.Portal.ui = window.Portal.ui || {};
    window.Portal.ui.showToast = window.Portal.ui.showToast || function(){};
    window.FirstMateEmbeddableApps = window.FirstMateEmbeddableApps || { registerApp: function(){} };
    window.__CUSTOMER_PORTAL = { id: <?php echo json_encode($portalId); ?>, preview: true };
  </script>
  <link rel="stylesheet" href="../fonts.css">
  <!-- FontAwesome: the portal originally used text glyphs, but the widget packs
       (portal.*, doc.*) and the punch-list UI are icon-driven, and unloaded
       icon fonts render as empty boxes. Same source the main app uses. -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="./customer_portal.css?v=<?php echo htmlspecialchars($portalCssVer, ENT_QUOTES); ?>">
  <script defer src="../libraries/platform-api/platform-api.js?v=<?php echo htmlspecialchars($platformApiVer, ENT_QUOTES); ?>"></script>
  <script defer src="../libraries/proposals-api/proposals-api.js"></script>
  <script defer src="../libraries/documents-api/documents-api.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/doc-model/firstmate-doc-model.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/doc-widgets/firstmate-doc-widgets.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/web-widgets/firstmate-web-widgets.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/portal-widgets/firstmate-portal-widgets.js?v=<?php echo (int)$assetVer; ?>"></script>
  <!-- Live chat: loaded inert (data-auto="false"); customer_portal.js starts it
       only when the payload carries a widget key + signed portal grant. -->
  <script defer src="../libraries/chat-embed/html2canvas.min.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer data-auto="false" src="../libraries/chat-embed/firstmate-chat-embed.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/doc-renderer/firstmate-doc-renderer.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/doc-workflow/firstmate-doc-workflow.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/payment-intake/payment-intake.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/audio-notes/audio-notes.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/audio-structure/audio-structure.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/apps/proposals/project.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="../libraries/platform-language/platform-language.js?v=<?php echo htmlspecialchars($portalJsVer, ENT_QUOTES); ?>"></script>
  <script defer src="../libraries/platform-terminology/platform-terminology.js?v=<?php echo htmlspecialchars($portalJsVer, ENT_QUOTES); ?>"></script>
  <script defer src="./customer_portal.js?v=<?php echo htmlspecialchars($portalJsVer, ENT_QUOTES); ?>"></script>
</head>
<body>
  <main id="customerPortalApp" class="cp-shell preview">
    <div class="cp-loading">Loading preview...</div>
  </main>
</body>
</html>
