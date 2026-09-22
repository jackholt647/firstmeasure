<?php
$ver = time();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#d93025">
  <title>FirstMate Canvassing</title>
  <link rel="stylesheet" href="/fonts.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script>
    window.__APP = {
      standaloneCanvassing: true,
      userBranchId: 'default'
    };
  </script>
</head>
<body>
  <div id="app"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="../../libraries/platform-api/platform-api.js?v=<?= $ver ?>"></script>
  <script src="../../libraries/canvassing-api/canvassing-api.js?v=<?= $ver ?>"></script>
  <script src="../../libraries/canvassing-app/canvassing-app.js?v=<?= $ver ?>"></script>
  <script src="app.js?v=<?= $ver ?>"></script>
</body>
</html>
