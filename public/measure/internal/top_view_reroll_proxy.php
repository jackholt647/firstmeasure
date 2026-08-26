<?php
require_once __DIR__ . '/_storage.php';

if (session_status() !== PHP_SESSION_ACTIVE) session_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function tvp_json($status, $payload) {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function tvp_origin_allowed() {
    $fetchSite = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));
    if ($fetchSite === 'cross-site') return false;

    $allowedHosts = [];
    foreach (['HTTP_HOST', 'SERVER_NAME'] as $key) {
        $value = strtolower(trim((string)($_SERVER[$key] ?? '')));
        if ($value === '') continue;
        $host = @parse_url((strpos($value, '://') === false ? 'https://' : '') . $value, PHP_URL_HOST);
        if (is_string($host) && $host !== '') $allowedHosts[] = $host;
    }
    $allowedHosts = array_values(array_unique(array_merge($allowedHosts, [
        'app.1m8.ai',
        'localhost',
        '127.0.0.1',
        '::1',
    ])));

    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin !== '') {
        $parts = @parse_url($origin);
        $originHost = strtolower((string)($parts['host'] ?? ''));
        if ($originHost !== '' && !in_array($originHost, $allowedHosts, true)) return false;
    }

    // Some reverse-proxy deployments rewrite Host/Referer differently. If the
    // browser says this is same-origin/same-site and the user has a valid
    // session, do not fail the request just because Referer is absent or
    // normalized differently by the proxy layer.
    if ($fetchSite === '' || $fetchSite === 'same-origin' || $fetchSite === 'same-site' || $fetchSite === 'none') {
        return true;
    }

    return false;
}

function tvp_node_v1_base_url() {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function tvp_internal_config_value($key) {
    static $configs = null;
    if ($configs === null) {
        $configs = [];
        if (function_exists('curl_init')) {
            $ch = curl_init(rtrim(tvp_node_v1_base_url(), '/') . '/internal/server-config');
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPGET => true,
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_TIMEOUT => 8,
            ]);
            $raw = curl_exec($ch);
            curl_close($ch);
            $decoded = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($decoded)) {
                foreach (($decoded['configs'] ?? []) as $entry) {
                    if (!is_array($entry)) continue;
                    $data = is_array($entry['data'] ?? null) ? $entry['data'] : $entry;
                    $entryKey = trim((string)($data['key'] ?? $entry['id'] ?? ''));
                    if ($entryKey === '') continue;
                    $configs[$entryKey] = $data['value'] ?? null;
                }
            }
        }
    }
    return $configs[$key] ?? '';
}

function tvp_openai_api_key() {
    $candidates = [
        getenv('OPENAI_API_KEY'),
        tvp_internal_config_value('top_view_openai_api_key'),
        tvp_internal_config_value('openai_api_key'),
        tvp_internal_config_value('OPENAI_API_KEY'),
    ];
    foreach ($candidates as $key) {
        $key = is_string($key) ? trim($key) : '';
        if ($key !== '') return $key;
    }
    return '';
}

function tvp_response_text($response) {
    if (!is_array($response)) return '';
    if (isset($response['output_text']) && is_string($response['output_text'])) return trim($response['output_text']);
    $parts = [];
    foreach (($response['output'] ?? []) as $item) {
        if (($item['type'] ?? '') !== 'message') continue;
        foreach (($item['content'] ?? []) as $content) {
            if (isset($content['text'])) $parts[] = (string)$content['text'];
        }
    }
    return trim(implode("\n", $parts));
}

function tvp_run_process($command, $stdin = '', $env = []) {
    $descriptorSpec = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $processEnv = null;
    if ($env) {
        $processEnv = [
            'PATH' => (string)(getenv('PATH') ?: ($_SERVER['PATH'] ?? '')),
            'Path' => (string)(getenv('Path') ?: ($_SERVER['Path'] ?? '')),
            'SystemRoot' => (string)(getenv('SystemRoot') ?: 'C:\\Windows'),
            'WINDIR' => (string)(getenv('WINDIR') ?: 'C:\\Windows'),
            'TEMP' => (string)(getenv('TEMP') ?: sys_get_temp_dir()),
            'TMP' => (string)(getenv('TMP') ?: sys_get_temp_dir()),
        ];
        foreach ($env as $key => $value) {
            $processEnv[$key] = $value;
        }
    }
    $process = @proc_open($command, $descriptorSpec, $pipes, __DIR__, $processEnv);
    if (!is_resource($process)) {
        return ['ok' => false, 'stdout' => '', 'stderr' => 'proc_open_failed', 'code' => -1];
    }
    fwrite($pipes[0], $stdin);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $code = proc_close($process);
    return ['ok' => $code === 0, 'stdout' => (string)$stdout, 'stderr' => (string)$stderr, 'code' => $code];
}

function tvp_powershell_encoded_command($script) {
    if (function_exists('mb_convert_encoding')) {
        return base64_encode(mb_convert_encoding($script, 'UTF-16LE', 'UTF-8'));
    }
    if (function_exists('iconv')) {
        return base64_encode(iconv('UTF-8', 'UTF-16LE', $script));
    }
    $out = '';
    $len = strlen($script);
    for ($i = 0; $i < $len; $i++) {
        $out .= $script[$i] . "\x00";
    }
    return base64_encode($out);
}

function tvp_openai_request($body, $apiKey) {
    $url = 'https://api.openai.com/v1/responses';
    $headers = [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $apiKey,
    ];

    if (function_exists('curl_init')) {
        $runCurl = function ($verifyTls = true) use ($url, $headers, $body) {
            $ch = curl_init($url);
            $opts = [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_TIMEOUT => 30,
            ];
            if (!$verifyTls) {
                $opts[CURLOPT_SSL_VERIFYPEER] = false;
                $opts[CURLOPT_SSL_VERIFYHOST] = 0;
            }
            curl_setopt_array($ch, $opts);
            $resp = curl_exec($ch);
            $err = curl_error($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            return ['resp' => (string)$resp, 'err' => (string)$err, 'status' => $status];
        };

        $curlResult = $runCurl(true);
        $certProblem = $curlResult['status'] === 0
            && preg_match('/certificate|issuer|SSL/i', $curlResult['err']);
        if ($certProblem) {
            $retry = $runCurl(false);
            if ($retry['status'] !== 0 || $retry['resp'] !== '') {
                return [
                    'resp' => $retry['resp'],
                    'err' => $retry['err'],
                    'status' => $retry['status'],
                    'transport' => 'php-curl-no-verify',
                ];
            }
        } elseif ($curlResult['status'] !== 0 || $curlResult['resp'] !== '') {
            return [
                'resp' => $curlResult['resp'],
                'err' => $curlResult['err'],
                'status' => $curlResult['status'],
                'transport' => 'php-curl',
            ];
        }
    }

    if (extension_loaded('openssl')) {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $body,
            'timeout' => 30,
            'ignore_errors' => true,
        ]]);
        $resp = @file_get_contents($url, false, $ctx);
        $err = $resp === false ? 'request_failed' : '';
        $status = 0;
        foreach (($http_response_header ?? []) as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) $status = (int)$m[1];
        }
        return ['resp' => (string)$resp, 'err' => (string)$err, 'status' => $status, 'transport' => 'php-stream'];
    }

    if (!function_exists('proc_open')) {
        return ['resp' => '', 'err' => 'No HTTPS transport available: PHP curl, openssl, and proc_open are unavailable.', 'status' => 0, 'transport' => 'none'];
    }

    $nodeScript = <<<'JS'
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
        'Content-Type': 'application/json'
      },
      body
    });
    const text = await resp.text();
    process.stdout.write(text);
    process.stderr.write(`\nHTTP_STATUS:${resp.status}`);
    process.exit(resp.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`\nHTTP_STATUS:0\n${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
});
JS;

    $nodeResult = tvp_run_process(['node', '-e', $nodeScript], $body, ['OPENAI_API_KEY' => $apiKey]);
    if ($nodeResult['stdout'] !== '' || $nodeResult['stderr'] !== '' || $nodeResult['code'] !== -1) {
        $status = 0;
        if (preg_match('/HTTP_STATUS:(\d+)/', $nodeResult['stderr'], $m)) $status = (int)$m[1];
        $stderr = trim(preg_replace('/HTTP_STATUS:\d+/', '', $nodeResult['stderr']));
        return ['resp' => $nodeResult['stdout'], 'err' => $nodeResult['ok'] ? '' : $stderr, 'status' => $status, 'transport' => 'node-fetch'];
    }

    $isWindows = strtoupper(substr(PHP_OS, 0, 3)) === 'WIN';
    if ($isWindows) {
        $ps = <<<'PS'
$ErrorActionPreference = 'Stop'
$body = [Console]::In.ReadToEnd()
$headers = @{
  'Authorization' = "Bearer $env:OPENAI_API_KEY"
  'Content-Type' = 'application/json'
}
try {
  $resp = Invoke-WebRequest -Uri 'https://api.openai.com/v1/responses' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 30 -UseBasicParsing
  [Console]::Out.Write($resp.Content)
  [Console]::Error.Write("`nHTTP_STATUS:" + [int]$resp.StatusCode)
  exit 0
} catch {
  $status = 0
  $content = ''
  if ($_.Exception.Response) {
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    try {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $content = $reader.ReadToEnd()
    } catch {}
  }
  if ($content) { [Console]::Out.Write($content) }
  [Console]::Error.Write("`nHTTP_STATUS:" + $status + "`n" + $_.Exception.Message)
  exit 1
}
PS;
        $encoded = tvp_powershell_encoded_command($ps);
        $cmd = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded];
        $result = tvp_run_process($cmd, $body, ['OPENAI_API_KEY' => $apiKey]);
        $status = 0;
        if (preg_match('/HTTP_STATUS:(\d+)/', $result['stderr'], $m)) $status = (int)$m[1];
        $stderr = trim(preg_replace('/HTTP_STATUS:\d+/', '', $result['stderr']));
        return ['resp' => $result['stdout'], 'err' => $result['ok'] ? '' : $stderr, 'status' => $status, 'transport' => 'powershell'];
    }

    $curlPath = trim((string)@shell_exec('command -v curl 2>/dev/null'));
    if ($curlPath !== '') {
        $cmd = escapeshellarg($curlPath)
            . ' -sS -X POST ' . escapeshellarg($url)
            . ' -H ' . escapeshellarg('Content-Type: application/json')
            . ' -H ' . escapeshellarg('Authorization: Bearer ' . $apiKey)
            . ' --data-binary @- -w ' . escapeshellarg("\nHTTP_STATUS:%{http_code}");
        $result = tvp_run_process($cmd, $body);
        $stdout = $result['stdout'];
        $status = 0;
        if (preg_match('/\nHTTP_STATUS:(\d+)\s*$/', $stdout, $m)) {
            $status = (int)$m[1];
            $stdout = preg_replace('/\nHTTP_STATUS:\d+\s*$/', '', $stdout);
        }
        return ['resp' => (string)$stdout, 'err' => $result['ok'] ? '' : $result['stderr'], 'status' => $status, 'transport' => 'curl-cli'];
    }

    return ['resp' => '', 'err' => 'No HTTPS transport available for OpenAI request.', 'status' => 0, 'transport' => 'none'];
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    tvp_json(405, ['success' => false, 'error' => 'POST required']);
}

if (!isset($_SESSION['user_email'])) {
    tvp_json(403, ['success' => false, 'error' => 'Not logged in']);
}

if (!tvp_origin_allowed()) {
    tvp_json(403, ['success' => false, 'error' => 'Same-origin requests only']);
}

$raw = (string)@file_get_contents('php://input');
$input = json_decode($raw, true);
if (!is_array($input)) {
    tvp_json(400, ['success' => false, 'error' => 'Invalid JSON body']);
}

$images = $input['images'] ?? [];
if (!is_array($images) || count($images) < 1 || count($images) > 4) {
    tvp_json(400, ['success' => false, 'error' => 'Send 1 to 4 images']);
}

$letters = ['A', 'B', 'C', 'D'];
$candidates = [];
foreach ($images as $idx => $image) {
    if (!is_array($image)) continue;
    $letter = $letters[count($candidates)] ?? null;
    if ($letter === null) break;
    $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)($image['id'] ?? ''));
    $label = trim((string)($image['label'] ?? $id));
    $dataUrl = (string)($image['image'] ?? '');
    if ($id === '' || $label === '' || $dataUrl === '') continue;
    if (strlen($dataUrl) > 900000) {
        tvp_json(413, ['success' => false, 'error' => 'Image payload too large']);
    }
    if (!preg_match('#^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$#', $dataUrl)) {
        tvp_json(400, ['success' => false, 'error' => 'Images must be base64 data URLs']);
    }
    $candidates[] = [
        'letter' => $letter,
        'id' => $id,
        'label' => $label,
        'image' => $dataUrl,
    ];
}

if (!$candidates) {
    tvp_json(400, ['success' => false, 'error' => 'No usable images']);
}

if (count($candidates) === 1) {
    tvp_json(200, [
        'success' => true,
        'choice' => $candidates[0]['letter'],
        'view_id' => $candidates[0]['id'],
        'reason' => 'Only one loaded image was available.',
        'model' => 'none',
    ]);
}

$apiKey = tvp_openai_api_key();
if ($apiKey === '') {
    tvp_json(500, ['success' => false, 'error' => 'Missing OPENAI_API_KEY or server config openai_api_key']);
}

$model = trim((string)(tvp_internal_config_value('top_view_openai_model') ?: getenv('TOP_VIEW_OPENAI_MODEL')));
if ($model === '') $model = trim((string)getenv('TOP_VIEW_OPENAI_MODEL'));
if ($model === '') $model = 'gpt-5-mini';

$candidateLines = array_map(function ($candidate) {
    return $candidate['letter'] . ' = ' . $candidate['label'] . ' (' . $candidate['id'] . ')';
}, $candidates);

$content = [[
    'type' => 'input_text',
    'text' => "Choose the clearest top-down image of the house for roof measurement. Factor in shadows, tree cover, lighting, occlusion, blur, and image resolution. Options:\n"
        . implode("\n", $candidateLines)
        . "\n\nUse minimal reasoning. Respond with compact JSON only: {\"choice\":\"A\",\"reason\":\"short reason\"}. The choice must be one of the listed letters."
]];

foreach ($candidates as $candidate) {
    $content[] = [
        'type' => 'input_text',
        'text' => 'Option ' . $candidate['letter'] . ': ' . $candidate['label'],
    ];
    $content[] = [
        'type' => 'input_image',
        'image_url' => $candidate['image'],
    ];
}

$payload = [
    'model' => $model,
    'input' => [[
        'role' => 'user',
        'content' => $content,
    ]],
    'reasoning' => ['effort' => 'minimal'],
    'max_output_tokens' => 1000,
];

$body = json_encode($payload, JSON_UNESCAPED_SLASHES);
$openaiResult = tvp_openai_request($body, $apiKey);
$resp = (string)($openaiResult['resp'] ?? '');
$err = (string)($openaiResult['err'] ?? '');
$status = (int)($openaiResult['status'] ?? 0);
$transport = (string)($openaiResult['transport'] ?? 'unknown');

$json = json_decode((string)$resp, true);
if ($err !== '' || $status < 200 || $status >= 300 || !is_array($json)) {
    $upstreamMessage = '';
    if (is_array($json) && isset($json['error']) && is_array($json['error'])) {
        $upstreamMessage = (string)($json['error']['message'] ?? '');
    }
    @error_log('[TopViewReroll] OpenAI request failed transport=' . $transport . ' status=' . $status . ' err=' . $err . ' message=' . $upstreamMessage);
    tvp_json(502, [
        'success' => false,
        'error' => 'OpenAI request failed',
        'status' => $status,
        'upstream_error' => $upstreamMessage,
        'transport_error' => $err,
        'transport' => $transport,
    ]);
}

$text = tvp_response_text($json);
$parsed = json_decode($text, true);
$choice = is_array($parsed) ? strtoupper(trim((string)($parsed['choice'] ?? ''))) : '';
if ($choice === '' && preg_match('/\b([A-D])\b/i', $text, $m)) $choice = strtoupper($m[1]);
@error_log('[TopViewReroll] model_text=' . substr(str_replace(["\r", "\n"], ' ', $text), 0, 1000));

$allowed = array_column($candidates, 'letter');
if (!in_array($choice, $allowed, true)) {
    tvp_json(502, [
        'success' => false,
        'error' => 'Model did not return a valid option',
        'raw_choice' => $text,
        'raw_choice_preview' => substr($text, 0, 1000),
        'response_id' => (string)($json['id'] ?? ''),
        'response_status' => (string)($json['status'] ?? ''),
        'incomplete_details' => $json['incomplete_details'] ?? null,
        'response_output_types' => array_map(function ($item) {
            return (string)($item['type'] ?? '');
        }, is_array($json['output'] ?? null) ? $json['output'] : []),
    ]);
}

$chosen = null;
foreach ($candidates as $candidate) {
    if ($candidate['letter'] === $choice) {
        $chosen = $candidate;
        break;
    }
}

tvp_json(200, [
    'success' => true,
    'choice' => $choice,
    'view_id' => $chosen['id'] ?? '',
    'reason' => is_array($parsed) ? trim((string)($parsed['reason'] ?? '')) : '',
    'model' => $model,
]);
