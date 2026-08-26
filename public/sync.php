<?php
declare(strict_types=1);

/**
 * FirstMate remote file sync endpoint.
 *
 * READ THIS BEFORE CALLING THE ENDPOINT.
 *
 * Production safety rule:
 * - Do not call this endpoint against production unless Jack explicitly asks
 *   you to sync production files in the current conversation.
 * - Never infer permission from a local task, a previous task, or because this
 *   endpoint exists.
 * - Use the read -> compare -> write flow below. Do not blind-write a file.
 *
 * Required sync flow:
 * 1. POST action "read" for the target relative path. Review the returned
 *    content, sha256, size, and path.
 * 2. Compare that remote content with the local file you intend to push. Only
 *    continue if it is clearly the same file and merely an older expected
 *    version.
 * 3. POST action "write" with the exact expected_sha256 returned by "read",
 *    the complete replacement content, and confirm "WRITE_REMOTE_FILE".
 * 4. Wait for ok: true and verify the returned new_sha256.
 * 5. If the changed path is under v1/, treat node_restart_required: true as a
 *    reminder only. Restarting Node is a separate action and requires a separate
 *    POST action "restart_node" with confirm "RESTART_NODE_SERVER".
 *
 * Authentication:
 * - The private key is loaded from sync-key.php beside this file.
 * - Every POST must be signed with HMAC-SHA256.
 * - Signature payload is: timestamp + "\n" + nonce + "\n" + raw JSON body.
 * - Send:
 *   X-Sync-Key-Id: value from sync-key.php
 *   X-Sync-Timestamp: current unix timestamp
 *   X-Sync-Nonce: random unique string, 16+ characters
 *   X-Sync-Signature: base64url(HMAC_SHA256(payload, secret))
 *
 * Required body field for every action:
 *   "ack": "I_HAVE_READ_SYNC_PHP_AND_JACK_EXPLICITLY_REQUESTED_THIS_PRODUCTION_SYNC"
 *
 * Example body for read:
 *   {"ack":"I_HAVE_READ_SYNC_PHP_AND_JACK_EXPLICITLY_REQUESTED_THIS_PRODUCTION_SYNC","action":"read","path":"portal/index.php"}
 *
 * Example body for write:
 *   {
 *     "ack":"I_HAVE_READ_SYNC_PHP_AND_JACK_EXPLICITLY_REQUESTED_THIS_PRODUCTION_SYNC",
 *     "action":"write",
 *     "path":"portal/index.php",
 *     "expected_sha256":"sha256 returned by read",
 *     "content":"complete replacement file content",
 *     "confirm":"WRITE_REMOTE_FILE"
 *   }
 *
 * Actions:
 * - read: returns file content and sha256 for a relative path.
 * - stat: returns metadata for a relative path without content.
 * - write: atomically replaces a file after expected_sha256 matches.
 * - search: finds likely paths by file name and optionally text content.
 * - restart_node: runs the configured node_restart_command from sync-key.php.
 *
 * Paths are relative to the public directory containing this file. The endpoint
 * refuses path traversal, symlink writes, auth/key files, storage folders, and
 * its own runtime folders.
 */

if (file_exists(__DIR__ . '/path-bootstrap.php')) {
    require_once __DIR__ . '/path-bootstrap.php';
}

error_reporting(E_ALL);
ini_set('display_errors', '0');
set_time_limit(120);
header('Content-Type: application/json; charset=utf-8');

const SYNC_ACK = 'I_HAVE_READ_SYNC_PHP_AND_JACK_EXPLICITLY_REQUESTED_THIS_PRODUCTION_SYNC';
const SYNC_WRITE_CONFIRM = 'WRITE_REMOTE_FILE';
const SYNC_RESTART_CONFIRM = 'RESTART_NODE_SERVER';
const SYNC_MAX_READ_BYTES = 8_388_608;
const SYNC_MAX_WRITE_BYTES = 8_388_608;
const SYNC_TIMESTAMP_WINDOW = 300;
const SYNC_MAX_SEARCH_VISITS = 5000;

function syncJson(array $payload, int $code = 200): never {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function syncFail(string $error, int $code = 400, array $extra = []): never {
    syncJson(['ok' => false, 'error' => $error] + $extra, $code);
}

function syncBase64Url(string $bytes): string {
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function syncLoadConfig(): array {
    $keyPath = __DIR__ . '/sync-key.php';
    if (!is_file($keyPath)) {
        syncFail('sync-key.php is missing. Copy sync-key.example.php to sync-key.php and set a real secret.', 500);
    }
    define('FIRSTMATE_SYNC_KEY_ALLOWED', true);
    $config = require $keyPath;
    if (!is_array($config)) {
        syncFail('sync-key.php must return a configuration array.', 500);
    }
    $keyId = (string)($config['key_id'] ?? '');
    $secret = (string)($config['secret'] ?? '');
    if ($keyId === '' || strlen($secret) < 32 || str_contains($secret, 'replace-with')) {
        syncFail('sync-key.php has an invalid key_id or secret.', 500);
    }
    return $config;
}

function syncRequirePost(): string {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        syncFail('POST JSON requests only. Read public/sync.php before using this endpoint.', 405);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        syncFail('Missing JSON body.', 400);
    }
    return $raw;
}

function syncHeader(string $name): string {
    $serverName = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return trim((string)($_SERVER[$serverName] ?? ''));
}

function syncNoncePath(string $nonce): string {
    $safe = preg_replace('/[^A-Za-z0-9_.-]/', '_', $nonce);
    return __DIR__ . '/.sync_nonces/' . $safe . '.nonce';
}

function syncPruneNonces(string $dir): void {
    if (!is_dir($dir)) return;
    $cutoff = time() - SYNC_TIMESTAMP_WINDOW - 60;
    $items = @scandir($dir);
    if ($items === false) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = $dir . '/' . $item;
        if (is_file($path) && (int)@filemtime($path) < $cutoff) {
            @unlink($path);
        }
    }
}

function syncAuthenticate(string $rawBody, array $config): void {
    $keyId = syncHeader('X-Sync-Key-Id');
    $timestamp = syncHeader('X-Sync-Timestamp');
    $nonce = syncHeader('X-Sync-Nonce');
    $signature = syncHeader('X-Sync-Signature');

    if ($keyId === '' || $timestamp === '' || $nonce === '' || $signature === '') {
        syncFail('Missing sync authentication headers.', 401);
    }
    if (!hash_equals((string)$config['key_id'], $keyId)) {
        syncFail('Invalid sync key id.', 401);
    }
    if (!ctype_digit($timestamp)) {
        syncFail('Invalid sync timestamp.', 401);
    }
    $now = time();
    $ts = (int)$timestamp;
    if (abs($now - $ts) > SYNC_TIMESTAMP_WINDOW) {
        syncFail('Sync timestamp is outside the allowed window.', 401, ['server_time' => $now]);
    }
    if (!preg_match('/^[A-Za-z0-9_.-]{16,128}$/', $nonce)) {
        syncFail('Invalid sync nonce.', 401);
    }

    $payload = $timestamp . "\n" . $nonce . "\n" . $rawBody;
    $expected = syncBase64Url(hash_hmac('sha256', $payload, (string)$config['secret'], true));
    if (!hash_equals($expected, $signature)) {
        syncFail('Invalid sync signature.', 401);
    }

    $nonceDir = __DIR__ . '/.sync_nonces';
    if (!is_dir($nonceDir) && !mkdir($nonceDir, 0700, true)) {
        syncFail('Could not create nonce directory.', 500);
    }
    syncPruneNonces($nonceDir);
    $noncePath = syncNoncePath($nonce);
    $nonceHandle = @fopen($noncePath, 'x');
    if ($nonceHandle === false) {
        syncFail('Sync nonce has already been used.', 401);
    }
    fwrite($nonceHandle, (string)$ts);
    fclose($nonceHandle);
    @chmod($noncePath, 0600);
}

function syncDecodeBody(string $raw): array {
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        syncFail('Body must be a JSON object.', 400);
    }
    if (($body['ack'] ?? '') !== SYNC_ACK) {
        syncFail('Missing required ack. Read public/sync.php before using this endpoint.', 403);
    }
    return $body;
}

function syncRoot(): string {
    $candidate = defined('FIRSTMATE_PUBLIC_ROOT') ? FIRSTMATE_PUBLIC_ROOT : __DIR__;
    $root = realpath($candidate);
    if ($root === false || !is_dir($root)) {
        syncFail('Could not determine public root.', 500);
    }
    return str_replace('\\', '/', $root);
}

function syncCleanRelPath(string $path): string {
    $path = str_replace("\0", '', $path);
    $path = str_replace('\\', '/', $path);
    $path = preg_replace('#/+#', '/', $path) ?? $path;
    $path = ltrim($path, '/');
    if (str_starts_with($path, 'public/')) {
        $path = substr($path, 7);
    }

    $parts = [];
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') {
            array_pop($parts);
            continue;
        }
        $parts[] = $part;
    }
    return implode('/', $parts);
}

function syncBlockedRelPathReason(string $rel, bool $forWrite): ?string {
    if ($rel === '') {
        return 'Path is required.';
    }

    $blockedExact = [
        'auth_users.json',
        'sync-key.php',
        'sync-key.example.php',
        'sync.php',
    ];
    foreach ($blockedExact as $blocked) {
        if (strcasecmp($rel, $blocked) === 0) {
            return 'This path is blocked for sync.';
        }
    }

    $blockedPrefixes = [
        '.git/',
        '.ide_trash/',
        '.sync_backups/',
        '.sync_nonces/',
        'storage/',
        'v1/storage/',
        'v1/node_modules/',
        'v1/dist/',
    ];
    foreach ($blockedPrefixes as $prefix) {
        if (str_starts_with(strtolower($rel), strtolower($prefix))) {
            return 'This path is blocked for sync.';
        }
    }

    if ($forWrite && preg_match('#(^|/)\.#', $rel)) {
        return 'Writing hidden paths is blocked.';
    }

    return null;
}

function syncAssertAllowedRelPath(string $rel, bool $forWrite): void {
    $reason = syncBlockedRelPathReason($rel, $forWrite);
    if ($reason !== null) {
        syncFail($reason, $rel === '' ? 400 : 403);
    }
}

function syncResolvePath(string $root, string $inputPath, bool $forWrite): array {
    $rel = syncCleanRelPath($inputPath);
    syncAssertAllowedRelPath($rel, $forWrite);
    $full = $root . '/' . $rel;

    $parent = dirname($full);
    $realParent = realpath($parent);
    if ($realParent === false) {
        if (!$forWrite) {
            syncFail('Path does not exist.', 404);
        }
        $nearest = $parent;
        while (!is_dir($nearest) && dirname($nearest) !== $nearest) {
            $nearest = dirname($nearest);
        }
        $realParent = realpath($nearest);
    }
    if ($realParent === false || !str_starts_with(str_replace('\\', '/', $realParent), $root)) {
        syncFail('Path traversal blocked.', 403);
    }

    $walk = $root;
    $parts = explode('/', $rel);
    array_pop($parts);
    foreach ($parts as $part) {
        $walk .= '/' . $part;
        if (is_link($walk)) {
            syncFail('Symlink parent paths are blocked.', 403);
        }
    }

    if (file_exists($full)) {
        $real = realpath($full);
        if ($real === false || !str_starts_with(str_replace('\\', '/', $real), $root)) {
            syncFail('Path traversal blocked.', 403);
        }
        if ($forWrite && is_link($full)) {
            syncFail('Writing through symlinks is blocked.', 403);
        }
    }

    return [$rel, $full];
}

function syncIsTextBytes(string $content): bool {
    if (str_contains($content, "\0")) return false;
    if (function_exists('mb_check_encoding')) {
        return mb_check_encoding($content, 'UTF-8');
    }
    return preg_match('//u', $content) === 1;
}

function syncFileMeta(string $root, string $rel, string $full, bool $includeHash = true): array {
    $exists = is_file($full);
    $meta = [
        'path' => $rel,
        'exists' => $exists,
        'node_restart_required' => str_starts_with($rel, 'v1/'),
    ];
    if (!$exists) return $meta;

    $size = filesize($full);
    $meta += [
        'size' => $size === false ? null : $size,
        'mtime' => filemtime($full) ?: null,
        'extension' => pathinfo($full, PATHINFO_EXTENSION),
    ];
    if ($includeHash) {
        $hash = hash_file('sha256', $full);
        $meta['sha256'] = $hash === false ? null : $hash;
    }
    return $meta;
}

function syncReadAction(string $root, array $body): never {
    [$rel, $full] = syncResolvePath($root, (string)($body['path'] ?? ''), false);
    if (!is_file($full)) {
        syncFail('Path is not a file.', 404, ['path' => $rel]);
    }
    $size = filesize($full);
    if ($size === false || $size > SYNC_MAX_READ_BYTES) {
        syncFail('File is too large for sync read.', 413, ['path' => $rel, 'size' => $size]);
    }
    $content = file_get_contents($full);
    if ($content === false) {
        syncFail('Could not read file.', 500, ['path' => $rel]);
    }
    $meta = syncFileMeta($root, $rel, $full);
    $meta['is_text'] = syncIsTextBytes($content);
    if ($meta['is_text']) {
        $meta['content'] = $content;
        $meta['encoding'] = 'utf8';
    } else {
        $meta['content_base64'] = base64_encode($content);
        $meta['encoding'] = 'base64';
    }
    syncJson(['ok' => true] + $meta);
}

function syncStatAction(string $root, array $body): never {
    [$rel, $full] = syncResolvePath($root, (string)($body['path'] ?? ''), false);
    syncJson(['ok' => true] + syncFileMeta($root, $rel, $full));
}

function syncEnsureParent(string $parent, bool $create): void {
    if (is_dir($parent)) return;
    if (!$create) {
        syncFail('Parent directory does not exist. Set create_parent_dirs true if this is intentional.', 400);
    }
    if (!mkdir($parent, 0755, true) && !is_dir($parent)) {
        syncFail('Could not create parent directories.', 500);
    }
}

function syncBackupExisting(string $rel, string $full): ?string {
    if (!is_file($full)) return null;
    $stamp = gmdate('Ymd-His') . '-' . bin2hex(random_bytes(4));
    $backup = __DIR__ . '/.sync_backups/' . $stamp . '/' . $rel;
    $backupDir = dirname($backup);
    if (!is_dir($backupDir) && !mkdir($backupDir, 0700, true)) {
        syncFail('Could not create backup directory.', 500);
    }
    if (!copy($full, $backup)) {
        syncFail('Could not create backup copy.', 500);
    }
    @chmod($backup, 0600);
    return syncCleanRelPath(substr($backup, strlen(__DIR__) + 1));
}

function syncWriteAction(string $root, array $body): never {
    if (($body['confirm'] ?? '') !== SYNC_WRITE_CONFIRM) {
        syncFail('Write requires confirm "' . SYNC_WRITE_CONFIRM . '".', 403);
    }

    [$rel, $full] = syncResolvePath($root, (string)($body['path'] ?? ''), true);
    $content = null;
    if (array_key_exists('content', $body)) {
        $content = (string)$body['content'];
    } elseif (array_key_exists('content_base64', $body)) {
        $decoded = base64_decode((string)$body['content_base64'], true);
        if ($decoded === false) {
            syncFail('content_base64 is invalid.', 400);
        }
        $content = $decoded;
    } else {
        syncFail('Missing content or content_base64.', 400);
    }

    if (strlen($content) > SYNC_MAX_WRITE_BYTES) {
        syncFail('Content is too large for sync write.', 413, ['max_bytes' => SYNC_MAX_WRITE_BYTES]);
    }

    $exists = is_file($full);
    $allowCreate = (bool)($body['allow_create'] ?? false);
    if (!$exists && !$allowCreate) {
        syncFail('Remote file does not exist. Set allow_create true if this is intentional.', 404, ['path' => $rel]);
    }

    $currentSha = $exists ? hash_file('sha256', $full) : null;
    $expectedSha = $body['expected_sha256'] ?? null;
    if ($exists) {
        if (!is_string($expectedSha) || $expectedSha === '') {
            syncFail('expected_sha256 is required for existing files.', 409, ['path' => $rel, 'current_sha256' => $currentSha]);
        }
        if (!hash_equals((string)$currentSha, $expectedSha)) {
            syncFail('Remote file changed or does not match expected_sha256.', 409, [
                'path' => $rel,
                'current_sha256' => $currentSha,
                'expected_sha256' => $expectedSha,
            ]);
        }
    } elseif ($expectedSha !== null && $expectedSha !== '') {
        syncFail('expected_sha256 must be empty when creating a new file.', 400);
    }

    $parent = dirname($full);
    syncEnsureParent($parent, (bool)($body['create_parent_dirs'] ?? false));

    $backupPath = syncBackupExisting($rel, $full);
    $tmp = $parent . '/.' . basename($full) . '.sync-tmp-' . bin2hex(random_bytes(6));
    if (file_put_contents($tmp, $content, LOCK_EX) === false) {
        @unlink($tmp);
        syncFail('Could not write temporary file.', 500);
    }
    @chmod($tmp, $exists ? (fileperms($full) & 0777) : 0644);

    if (!rename($tmp, $full)) {
        @unlink($tmp);
        syncFail('Could not replace remote file.', 500);
    }

    $newSha = hash_file('sha256', $full);
    syncJson([
        'ok' => true,
        'path' => $rel,
        'created' => !$exists,
        'old_sha256' => $currentSha,
        'new_sha256' => $newSha,
        'bytes' => strlen($content),
        'backup_path' => $backupPath,
        'node_restart_required' => str_starts_with($rel, 'v1/'),
    ]);
}

function syncShouldSkipDir(string $name): bool {
    $skip = [
        '.git',
        '.ide_trash',
        '.sync_backups',
        '.sync_nonces',
        '_codex_screenshots',
        'backups',
        'node_modules',
        'dist',
        'output',
        'rendered',
        'storage',
        'tmp',
        'unused',
        'updates',
    ];
    foreach ($skip as $blocked) {
        if (strcasecmp($name, $blocked) === 0) return true;
    }
    return false;
}

function syncRelFromFull(string $root, string $full): string {
    $full = str_replace('\\', '/', $full);
    return ltrim(substr($full, strlen($root)), '/');
}

function syncSearchAction(string $root, array $body): never {
    $query = trim((string)($body['query'] ?? ''));
    if (strlen($query) < 2) {
        syncFail('Search query must be at least 2 characters.', 400);
    }
    $limit = max(1, min(50, (int)($body['limit'] ?? 25)));
    $maxVisits = max(100, min(SYNC_MAX_SEARCH_VISITS, (int)($body['max_visits'] ?? SYNC_MAX_SEARCH_VISITS)));
    $includeContent = (bool)($body['include_content'] ?? false);
    $rootRel = syncCleanRelPath((string)($body['root'] ?? ''));
    if ($rootRel !== '') {
        $blocked = syncBlockedRelPathReason($rootRel . '/', false);
        if ($blocked !== null) {
            syncFail($blocked, 403);
        }
    }
    $searchRoot = $rootRel === '' ? $root : $root . '/' . $rootRel;
    if (!is_dir($searchRoot)) {
        syncFail('Search root does not exist.', 404);
    }
    $realSearchRoot = realpath($searchRoot);
    if ($realSearchRoot === false || !str_starts_with(str_replace('\\', '/', $realSearchRoot), $root)) {
        syncFail('Search root is outside public root.', 403);
    }

    $realSearchRoot = str_replace('\\', '/', $realSearchRoot);
    $results = [];
    $visited = 0;
    $skippedDirs = 0;
    $queryLower = strtolower($query);

    $stack = [$realSearchRoot];
    while ($stack !== [] && count($results) < $limit && $visited < $maxVisits) {
        $dir = array_pop($stack);
        if (!is_string($dir) || syncShouldSkipDir(basename($dir)) || is_link($dir)) {
            $skippedDirs++;
            continue;
        }
        $items = @scandir($dir);
        if ($items === false) {
            $skippedDirs++;
            continue;
        }

        foreach ($items as $item) {
            if ($item === '.' || $item === '..') continue;
            $visited++;
            if ($visited >= $maxVisits || count($results) >= $limit) {
                break;
            }

            $full = $dir . '/' . $item;
            if (is_dir($full)) {
                if (!syncShouldSkipDir($item) && !is_link($full)) {
                    $realDir = realpath($full);
                    if ($realDir !== false) {
                        $realDir = str_replace('\\', '/', $realDir);
                        if (str_starts_with($realDir, $root)) {
                            $stack[] = $realDir;
                        }
                    }
                } else {
                    $skippedDirs++;
                }
                continue;
            }

            if (!is_file($full) || is_link($full)) {
                continue;
            }

            $rel = syncRelFromFull($root, $full);
            if (syncBlockedRelPathReason($rel, false) !== null) {
                continue;
            }

            $size = @filesize($full);
            if ($size === false) {
                continue;
            }

            $nameMatch = str_contains(strtolower($item), $queryLower)
                || str_contains(strtolower($rel), $queryLower);
            $contentMatch = null;
            $snippet = null;
            if (!$nameMatch && $includeContent && $size <= 524288) {
                $content = @file_get_contents($full);
                if (is_string($content) && syncIsTextBytes($content)) {
                    $pos = stripos($content, $query);
                    if ($pos !== false) {
                        $contentMatch = true;
                        $start = max(0, $pos - 80);
                        $snippet = substr($content, $start, 200);
                    }
                }
            }

            if ($nameMatch || $contentMatch) {
                $results[] = [
                    'path' => $rel,
                    'size' => $size,
                    'mtime' => @filemtime($full) ?: null,
                    'name_match' => $nameMatch,
                    'content_match' => (bool)$contentMatch,
                    'snippet' => $snippet,
                    'node_restart_required' => str_starts_with($rel, 'v1/'),
                ];
            }
        }
    }

    syncJson([
        'ok' => true,
        'query' => $query,
        'results' => $results,
        'visited' => $visited,
        'truncated' => $visited >= $maxVisits,
        'max_visits' => $maxVisits,
        'skipped_dirs' => $skippedDirs,
    ]);
}

function syncRestartNodeAction(array $body, array $config): never {
    if (($body['confirm'] ?? '') !== SYNC_RESTART_CONFIRM) {
        syncFail('Node restart requires confirm "' . SYNC_RESTART_CONFIRM . '".', 403);
    }
    $command = trim((string)($config['node_restart_command'] ?? ''));
    if ($command === '') {
        syncFail('No node_restart_command is configured in sync-key.php.', 501);
    }

    $output = [];
    $exitCode = 1;
    exec($command . ' 2>&1', $output, $exitCode);
    syncJson([
        'ok' => $exitCode === 0,
        'exit_code' => $exitCode,
        'output_tail' => array_slice($output, -40),
    ], $exitCode === 0 ? 200 : 500);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    syncFail('POST JSON requests only. Read public/sync.php before using this endpoint.', 405);
}

$config = syncLoadConfig();
$rawBody = syncRequirePost();
syncAuthenticate($rawBody, $config);
$body = syncDecodeBody($rawBody);
$root = syncRoot();
$action = (string)($body['action'] ?? '');

match ($action) {
    'read' => syncReadAction($root, $body),
    'stat' => syncStatAction($root, $body),
    'write' => syncWriteAction($root, $body),
    'search' => syncSearchAction($root, $body),
    'restart_node' => syncRestartNodeAction($body, $config),
    default => syncFail('Unknown sync action.', 404),
};
