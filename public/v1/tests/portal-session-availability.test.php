<?php
declare(strict_types=1);
// Run in CLI; tests only synthetic response values and never contact an API.
if (($argv[1] ?? '') === 'case') {
    require $argv[2];
    $result = portalDecodeAuthSessionResponse($argv[4] === 'false' ? false : $argv[4], (int)$argv[3]);
    echo json_encode(['returned' => $result]);
    exit;
}
$bootstrap = $argv[1] ?? dirname(__DIR__, 2) . '/portal/session_bootstrap.php';
$cases = [
    [200, '{"authenticated":true,"identity":{"email":"synthetic@example.test"}}', true],
    [200, '{"authenticated":false}', false],
    [401, '{}', false],
    [403, '{}', false],
    [503, '{"authenticated":false}', null],
    [200, 'not-json', null],
    [200, '{}', null],
    [0, 'false', null],
];
foreach ($cases as [$status, $body, $expected]) {
    $process = proc_open([PHP_BINARY, __FILE__, 'case', $bootstrap, (string)$status, $body], [1 => ['pipe','w'], 2 => ['pipe','w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Could not start test process');
    $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    if (proc_close($process) !== 0) throw new RuntimeException($error);
    if ($expected === null) {
        if (!str_contains($output, 'temporarily unavailable') || str_contains($output, '"returned"')) throw new RuntimeException('Backend error must stop protected-page rendering');
    } else {
        $data = json_decode($output, true);
        if (($data['returned']['authenticated'] ?? null) !== $expected) throw new RuntimeException('Authentication response changed');
    }
}
echo "8 portal availability cases passed\n";
