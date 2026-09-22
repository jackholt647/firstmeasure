<?php
$ver = time();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#f7f8fa">
  <title>FirstMate</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="app.css?v=<?= $ver ?>">
  <script>
    window.__APP = {
      managementMobileApp: true,
      portalPath: '/portal/',
      platformApiBase: (function(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
          return `${location.origin}/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
      })()
    };
  </script>
</head>
<body>
  <main id="app" class="app-shell" aria-live="polite">
    <section class="boot-card">
      <img src="/images/logo_red.png" alt="FirstMate">
      <p>Opening FirstMate...</p>
    </section>
  </main>

  <script src="../../libraries/platform-api/platform-api.js?v=<?= $ver ?>"></script>
  <script src="app.js?v=<?= $ver ?>"></script>
</body>
</html>
