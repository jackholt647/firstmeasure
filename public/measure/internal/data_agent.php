<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/_permission_options.php';

if (session_status() !== PHP_SESSION_ACTIVE) session_start();

function dataAgentNodeV1BaseUrl() {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function dataAgentNodeInternalUser($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('curl_init')) return null;
    $url = rtrim(dataAgentNodeV1BaseUrl(), '/') . '/internal/users/' . rawurlencode($email);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'X-Internal-User-Email: ' . $email,
            'X-Internal-User-Name: ' . (string)($_SESSION['user_name'] ?? $email),
        ],
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status < 200 || $status >= 300 || !is_string($raw) || $raw === '') return null;
    $data = json_decode($raw, true);
    return is_array($data['user'] ?? null) ? $data['user'] : null;
}

function dataAgentStandaloneCanUse($userData) {
    if (!is_array($userData)) return false;
    if (($userData['account_type'] ?? '') === 'customer') return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    $perms = permissionOptionsNormalizePermissions($userData['permissions'] ?? [], $role);
    return $role === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
}

if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = (string)($_SESSION['user_name'] ?? '');
$currentUserRole = (string)($_SESSION['user_role'] ?? '');
$userData = dataAgentNodeInternalUser($currentUserEmail);

if (!dataAgentStandaloneCanUse($userData)) {
    http_response_code(403);
    echo 'Not authorized for the FirstMeasure Data Agent.';
    exit;
}

$nodeInternalBase = rtrim(dataAgentNodeV1BaseUrl(), '/') . '/internal';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FirstMeasure Data Agent</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <style>
        :root { --primary:#d93025; }
        html, body { margin:0; height:100%; font-family:'Segoe UI', Roboto, sans-serif; background:#eef2f5; }
    </style>
</head>
<body>
    <div id="dataAgentStandaloneMount" class="data-agent-standalone"></div>
    <script>
        window.PORTAL_CFG = {
            endpoints: {
                data_agent: <?php echo json_encode($nodeInternalBase . '/legacy-action'); ?>,
                portal: <?php echo json_encode($nodeInternalBase . '/legacy-action'); ?>,
                firstmeasure: <?php echo json_encode(rtrim(dataAgentNodeV1BaseUrl(), '/') . '/firstmeasure'); ?>
            },
            flags: { can_data_agent: true },
            user: {
                email: <?php echo json_encode($currentUserEmail); ?>,
                name: <?php echo json_encode($currentUserName); ?>,
                role: <?php echo json_encode($currentUserRole); ?>
            }
        };
    </script>
    <script src="portal_scripts/data_agent.js?v=<?php echo time(); ?>"></script>
</body>
</html>
