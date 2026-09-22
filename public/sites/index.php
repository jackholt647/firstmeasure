<?php
// Public website hosting shell (web builder, spec §4).
// Serves /sites/<siteKey>[/<pageSlug>] — nginx/router rewrite any such path
// here; the site runtime fetches the published payload and renders it.
$requestPath = rawurldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
$tail = '';
$pathBased = preg_match('#^/sites/(.*)$#', $requestPath, $matches) === 1;
if ($pathBased) {
    $tail = $matches[1]; // leftmost /sites/ wins — slugs may contain "sites"
} else {
    $tail = ltrim($requestPath, '/');
}
$segments = array_values(array_filter(explode('/', $tail), 'strlen'));
$siteKey = $pathBased && isset($segments[0]) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $segments[0]) : '';
$pageIndex = $pathBased ? 1 : 0;
$pageSlug = isset($segments[$pageIndex]) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $segments[$pageIndex]) : '';
$rawHost = strtolower(trim((string)($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? '')));
$parsedHost = parse_url('http://' . $rawHost, PHP_URL_HOST);
$hostname = is_string($parsedHost) ? rtrim($parsedHost, '.') : '';
$assetVer = max(
    @filemtime(__FILE__) ?: 0,
    @filemtime(__DIR__ . '/../libraries/doc-model/firstmate-doc-model.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/doc-widgets/firstmate-doc-widgets.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/doc-renderer/firstmate-doc-renderer.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/web-widgets/firstmate-web-widgets.js') ?: 0,
    @filemtime(__DIR__ . '/../libraries/site-runtime/firstmate-site-runtime.js') ?: 0
);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website</title>
  <script>
    window.__FM_SITE = {
      siteKey: <?php echo json_encode($siteKey); ?>,
      hostname: <?php echo json_encode($hostname); ?>,
      pageSlug: <?php echo json_encode($pageSlug); ?>,
      basePath: <?php echo json_encode($pathBased ? '/sites/' . $siteKey . '/' : '/'); ?>,
      apiBase: (function(){
        var host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
          return location.protocol + '//' + location.hostname + ':3101/v1/websites';
        }
        return '/v1/websites';
      })()
    };
  </script>
  <style>
    /* Critical shell CSS only — everything else self-injects from the libs. */
    html, body { margin: 0; padding: 0; background: #ffffff; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; -webkit-font-smoothing: antialiased; }
  </style>
  <link rel="stylesheet" href="/fonts.css">
  <!-- Library paths are root-absolute: page URLs are 1-2 segments deep under
       /sites/, so document-relative ../ paths would resolve differently per
       page. doc-widgets is a read-only dependency loaded before web-widgets
       (they share one registry). -->
  <script defer src="/libraries/doc-model/firstmate-doc-model.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="/libraries/doc-widgets/firstmate-doc-widgets.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="/libraries/doc-renderer/firstmate-doc-renderer.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="/libraries/web-widgets/firstmate-web-widgets.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script defer src="/libraries/site-runtime/firstmate-site-runtime.js?v=<?php echo (int)$assetVer; ?>"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      if (window.FirstMateSiteRuntime) window.FirstMateSiteRuntime.boot();
    });
  </script>
</head>
<body>
  <main id="fmSiteRoot"></main>
</body>
</html>
