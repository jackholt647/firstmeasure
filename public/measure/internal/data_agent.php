<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/_permission_options.php';

require_once __DIR__ . '/_staff_session.php';
fm_internal_session_start();

// The PHP-to-Node /v1 base (configuration only, never the request's Host).
function dataAgentNodeV1BaseUrl() {
    return fm_node_v1_base_url('api', 3111);
}

// The /v1 base the browser uses: its own origin unless configured.
function dataAgentBrowserV1BaseUrl() {
    $configured = fm_node_config('FIRSTMEASURE_BROWSER_API_BASE');
    if ($configured !== '') return fm_node_strip_suffix($configured, ['/firstmeasure']);
    if (fm_node_request_is_local_dev()) return dataAgentNodeV1BaseUrl();
    return '/v1';
}

function dataAgentNodeInternalUser($email) {
    $email = strtolower(trim((string)$email));
    $url = $email === '' ? '' : fm_node_v1_url('internal/users/' . rawurlencode($email));
    if ($url === '') return null;
    // Signed as the Node-verified staff member (includes/node_api.php).
    $res = fm_node_request('GET', $url, ['timeout' => 8]);
    $data = $res['json'];
    return ($res['ok'] && is_array($data['user'] ?? null)) ? $data['user'] : null;
}

function dataAgentStandaloneCanUse($userData) {
    if (!is_array($userData)) return false;
    if (($userData['account_type'] ?? '') === 'customer') return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    $perms = permissionOptionsNormalizePermissions($userData['permissions'] ?? [], $role);
    return $role === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
}

fm_internal_require_staff('html');

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = (string)($_SESSION['user_name'] ?? '');
$currentUserRole = (string)($_SESSION['user_role'] ?? '');
$userData = dataAgentNodeInternalUser($currentUserEmail);

if (!dataAgentStandaloneCanUse($userData)) {
    http_response_code(403);
    echo 'Not authorized for the FirstMeasure Data Agent.';
    exit;
}

$nodeInternalBase = rtrim(dataAgentBrowserV1BaseUrl(), '/') . '/internal';
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
                firstmeasure: <?php echo json_encode(rtrim(dataAgentBrowserV1BaseUrl(), '/') . '/firstmeasure'); ?>
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
