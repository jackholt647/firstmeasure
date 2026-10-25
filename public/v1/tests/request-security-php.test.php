<?php
declare(strict_types=1);
// PHP half of docs/architecture/request-security.md. CLI only; never makes a
// network request (every fetch case is refused before resolving or connecting).
// Run by tests/request-security-php.test.ts, or directly: php tests/request-security-php.test.php
ini_set('log_errors', '0');
require_once __DIR__ . '/../../includes/web_security.php';
require_once __DIR__ . '/../../includes/node_api.php';
require_once __DIR__ . '/../../includes/safe_fetch.php';

$failures = [];
$checks = 0;
function check(bool $condition, string $label): void {
    global $failures, $checks;
    $checks++;
    if (!$condition) $failures[] = $label;
}

// --- Same-site redirects -----------------------------------------------------
foreach ([
    ['/portal/', '/portal/'],
    ['/measure/internal/editor.php?folder=abc#x', '/measure/internal/editor.php?folder=abc#x'],
    ['portal.php', 'portal.php'],
    ['./', './'],
    ['browse.php?dir=a/b', 'browse.php?dir=a/b'],
    ['//evil.example/', 'D'],
    ['/\\evil.example', 'D'],
    ['\\\\evil.example', 'D'],
    ['https://evil.example/', 'D'],
    ['javascript:alert(1)', 'D'],
    ['JaVaScRiPt:alert(1)', 'D'],
    ["/\t/evil.example", 'D'],
    ["/%0d%0aSet-Cookie:x", '/%0d%0aSet-Cookie:x'],
    ["/\r\nLocation: x", 'D'],
    ['data:text/html,x', 'D'],
    ['', 'D'],
] as [$input, $expected]) {
    check(fm_safe_redirect_path($input, 'D') === $expected, 'redirect ' . json_encode($input));
}
check(fm_safe_redirect_path(['/x'], 'D') === 'D', 'redirect array');

// --- Address checks ----------------------------------------------------------
foreach (['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80e::200e'] as $ip) {
    check(fm_ip_is_public($ip), "public $ip");
}
foreach ([
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1',
    '192.0.2.1', '198.18.0.1', '203.0.113.5',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::7f00:1',
    'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '2001:db8::1', '2002:7f00:1::1', '2001::1', 'not-an-ip',
] as $ip) {
    check(!fm_ip_is_public($ip), "blocked $ip");
}
foreach ([
    'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/', 'http://localhost/',
    'http://metadata.google.internal/', 'file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/',
    'http://user:pass@example.com/', 'http://example.com:8080/', 'https://example.com:22/', 'http://10.0.0.5:80/',
    "http://exa\nmple.com/", 'http://example.com\\@127.0.0.1/',
] as $url) {
    $target = fm_safe_fetch_target($url);
    check(!$target['ok'], 'fetch target refused ' . json_encode($url));
}
check(fm_safe_fetch_join('https://a.example/x/y.html', '/z') === 'https://a.example/z', 'join absolute path');
check(fm_safe_fetch_join('https://a.example/x/y.html', 'z.png') === 'https://a.example/x/z.png', 'join relative');
check(fm_safe_fetch_join('https://a.example/x/', '//b.example/q') === 'https://b.example/q', 'join scheme-relative');

// --- Node base URL comes from configuration only -----------------------------
foreach (['FIRSTMEASURE_API_BASE', 'FIRSTMEASURE_NODE_BASE_URL'] as $name) putenv($name);
$_SERVER = ['HTTP_HOST' => 'attacker.example', 'REMOTE_ADDR' => '198.51.100.7'];
check(fm_node_v1_base_url('api') === '', 'unconfigured public host refuses');
$_SERVER = ['HTTP_HOST' => 'localhost', 'REMOTE_ADDR' => '198.51.100.7'];
check(fm_node_v1_base_url('api') === '', 'spoofed localhost Host from a remote address refuses');
$_SERVER = ['HTTP_HOST' => '127.0.0.1:8021', 'REMOTE_ADDR' => '127.0.0.1'];
check(fm_node_v1_base_url('api') === 'http://127.0.0.1:3111/v1', 'local development default');
$_SERVER = ['HTTP_HOST' => 'attacker.example', 'FIRSTMEASURE_NODE_BASE_URL' => 'http://127.0.0.1:3101/v1/platform'];
check(fm_node_v1_base_url('api') === 'http://127.0.0.1:3101/v1', 'node base from configuration');
check(fm_node_v1_base_url('session') === 'http://127.0.0.1:3101/v1', 'session base from configuration');
$_SERVER = ['HTTP_HOST' => 'attacker.example', 'FIRSTMEASURE_API_BASE' => 'https://app.1m8.ai/v1/firstmeasure', 'FIRSTMEASURE_NODE_BASE_URL' => 'http://127.0.0.1:3101/v1/platform'];
check(fm_node_v1_base_url('api') === 'https://app.1m8.ai/v1', 'api base prefers FIRSTMEASURE_API_BASE');
check(fm_node_v1_base_url('session') === 'http://127.0.0.1:3101/v1', 'session base prefers FIRSTMEASURE_NODE_BASE_URL');
$_SERVER = ['HTTP_HOST' => 'x', 'FIRSTMEASURE_API_BASE' => 'javascript:alert(1)', 'REMOTE_ADDR' => '198.51.100.7'];
check(fm_node_v1_base_url('api') === '', 'invalid configured base refused');
$curl = fm_node_curl_options();
check(($curl[CURLOPT_SSL_VERIFYPEER] ?? null) === true && ($curl[CURLOPT_SSL_VERIFYHOST] ?? null) === 2 && ($curl[CURLOPT_FOLLOWLOCATION] ?? null) === false, 'curl verifies TLS and never follows redirects');

// --- Staff session -----------------------------------------------------------
$_SESSION = ['user_email' => 'customer@example.test', 'platform_node_auth' => true];
check(fm_staff_session_email() === '', 'a customer platform login is not staff');
$_SESSION = ['user_email' => 'Staff@Example.test', 'fm_staff' => ['email' => 'staff@example.test', 'verified_at' => time()]];
check(fm_staff_session_email() === 'staff@example.test', 'verified staff');
$_SESSION['user_email'] = 'customer@example.test';
check(fm_staff_session_email() === '', 'a changed identity drops the staff mark');
$_SESSION = ['user_email' => 'staff@example.test'];
check(fm_staff_session_email() === '' && fm_node_identity_headers('session', 'GET', 'http://127.0.0.1:3111/v1/internal/me') === [], 'no staff, no signature');

// --- Signature shape ---------------------------------------------------------
putenv('FIRSTMEASURE_INTERNAL_API_SECRET=test-secret');
$headers = fm_node_signature_headers('get', 'https://app.1m8.ai/v1/internal/users/a%40b.test?x=1&y=2', 'Staff@Example.test', null, false, 1700000000);
$map = [];
foreach ($headers as $line) { [$k, $v] = explode(': ', $line, 2); $map[strtolower($k)] = $v; }
$expected = hash_hmac('sha256', "v1\nGET\n/v1/internal/users/a%40b.test?x=1&y=2\n1700000000\nstaff@example.test\n" . hash('sha256', ''), 'test-secret');
check(($map['x-fm-service-signature'] ?? '') === $expected, 'signature payload matches service.ts');
check(($map['x-fm-service-actor'] ?? '') === 'staff@example.test', 'actor lower-cased');
$multipart = fm_node_signature_headers('POST', 'http://127.0.0.1:3111/v1/firstmeasure/projects/x/artifacts', 'system', null, true, 1700000000);
check(in_array('X-FM-Service-Body-Sha256: UNSIGNED-PAYLOAD', $multipart, true), 'multipart is UNSIGNED-PAYLOAD');
putenv('FIRSTMEASURE_INTERNAL_API_SECRET');
putenv('FIRSTMEASURE_NODE_SIGNING_SECRET');
check(fm_node_signature_headers('GET', 'http://x/v1/internal/me', 'system') === [] || fm_provider_key_value('application', 'internal_api_secret') !== '', 'no secret, no signature');

// --- Upload types ------------------------------------------------------------
foreach (['a.png', 'b.JPG', 'c.pdf', 'd.json', 'e.glb', 'f.txt', 'file.bin'] as $name) check(fm_upload_extension_allowed($name), "upload ok $name");
foreach (['a.html', 'b.htm', 'c.svg', 'd.js', 'e.php', 'f.phtml', 'g.xml', 'h', 'i.png.php', 'j.shtml'] as $name) check(!fm_upload_extension_allowed($name), "upload refused $name");

if ($failures) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $failures) . "\n");
    exit(1);
}
echo "$checks request-security PHP checks passed\n";
