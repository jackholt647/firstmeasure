<?php
declare(strict_types=1);
$IS_DIR_SIZE_WORKER = PHP_SAPI === 'cli' && (($argv[1] ?? '') === '--dir-size-worker');
if (!$IS_DIR_SIZE_WORKER) {
    require_once __DIR__ . '/auth.php';
}
if (file_exists(__DIR__ . '/path-bootstrap.php')) {
    require_once __DIR__ . '/path-bootstrap.php';
}
error_reporting(E_ALL);
if (!$IS_DIR_SIZE_WORKER) {
    header('Content-Type: application/json; charset=utf-8');
    auth_require_login();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
}

function firstmateLooksLikeIdeRoot(string $path): bool {
    return is_dir($path)
        && is_file($path . '/ide.php')
        && is_file($path . '/api.php')
        && (
            is_dir($path . '/v1') ||
            is_dir($path . '/measure') ||
            is_dir($path . '/portal')
        );
}

$localIdeRoot = defined('FIRSTMATE_PUBLIC_ROOT') && firstmateLooksLikeIdeRoot(FIRSTMATE_PUBLIC_ROOT)
    ? FIRSTMATE_PUBLIC_ROOT
    : '';

$rootCandidates = [
    getenv('FIRSTMATE_IDE_ROOT') ?: '',
    '/var/www/ide',
    $localIdeRoot,
    defined('FIRSTMATE_PROJECT_ROOT') ? FIRSTMATE_PROJECT_ROOT : dirname(__DIR__),
];
$ROOT = false;
foreach ($rootCandidates as $candidate) {
    if ($candidate === '') continue;
    $real = realpath($candidate);
    if ($real !== false && is_dir($real)) {
        $ROOT = $real;
        break;
    }
}
if (!$ROOT) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Could not determine IDE root directory.']);
    exit;
}

$MAX_UPLOAD = 1024 * 1024 * 1024; // 1GB
set_time_limit(600);
ini_set('max_execution_time', 600);

// ── Trash directory structure ────────────────────────────────────────────────
// .ide_trash/
//   meta/   — {id}.json metadata files
//   files/  — {id} actual trashed items (file or directory)
$TRASH_BASE      = $ROOT . '/.ide_trash';
$TRASH_META_DIR  = $TRASH_BASE . '/meta';
$TRASH_FILES_DIR = $TRASH_BASE . '/files';
$JOBS_BASE       = $ROOT . '/.ide_jobs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonOut(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): never {
    jsonOut(['ok' => false, 'error' => $msg], $code);
}

function safePath(string $root, string $rel): string {
    $rel = str_replace("\0", '', $rel);
    $rel = str_replace('\\', '/', $rel);
    $rel = preg_replace('#/+#', '/', $rel);
    $rel = ltrim($rel, '/');
    $parts = explode('/', $rel);
    $clean = [];
    foreach ($parts as $p) {
        if ($p === '' || $p === '.') continue;
        if ($p === '..') {
            if (!empty($clean)) array_pop($clean);
            continue;
        }
        $clean[] = $p;
    }
    $rel = implode('/', $clean);
    if ($rel === '') return $root;
    $full = $root . '/' . $rel;

    // Walk down path components — if we hit a symlink inside root, allow it
    $current = $root;
    foreach ($clean as $part) {
        $current .= '/' . $part;
        if (is_link($current)) {
            // The symlink file itself is inside $root — this is intentional, allow it
            return $full;
        }
        if (!file_exists($current)) {
            // Doesn't exist yet (create operation) — check what we have so far is safe
            $real = realpath(dirname($current));
            if ($real !== false && strpos($real, $root) !== 0) {
                fail('Path traversal blocked.');
            }
            return $full;
        }
        $real = realpath($current);
        if ($real !== false && strpos($real, $root) !== 0) {
            fail('Path traversal blocked.');
        }
    }

    return $full;
}

function securedPath(string $root, string $rel): string {
    $full = safePath($root, $rel);
    $relResolved = relPath($root, $full);
    if (!auth_can_access_path($relResolved)) {
        fail('Does not exist.', 404);
    }
    return $full;
}

function relPath(string $root, string $full): string {
    if ($full === $root) return '';
    return ltrim(substr($full, strlen($root)), '/');
}

function humanSize(int $bytes): string {
    if ($bytes < 1024) return $bytes . ' B';
    if ($bytes < 1048576) return round($bytes / 1024, 1) . ' KB';
    if ($bytes < 1073741824) return round($bytes / 1048576, 1) . ' MB';
    return round($bytes / 1073741824, 2) . ' GB';
}

function getMime(string $path): string {
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $map = [
        'php'=>'text/x-php','js'=>'text/javascript','jsx'=>'text/javascript',
        'ts'=>'text/typescript','tsx'=>'text/typescript','json'=>'application/json',
        'html'=>'text/html','htm'=>'text/html','css'=>'text/css',
        'xml'=>'text/xml','svg'=>'image/svg+xml','md'=>'text/markdown',
        'py'=>'text/x-python','rb'=>'text/x-ruby','go'=>'text/x-go',
        'rs'=>'text/x-rustsrc','java'=>'text/x-java','c'=>'text/x-csrc',
        'cpp'=>'text/x-c++src','h'=>'text/x-chdr','sh'=>'text/x-sh',
        'bash'=>'text/x-sh','sql'=>'text/x-sql','yaml'=>'text/yaml',
        'yml'=>'text/yaml','toml'=>'text/x-toml','ini'=>'text/x-ini',
        'conf'=>'text/plain','txt'=>'text/plain','log'=>'text/plain',
        'env'=>'text/plain','gitignore'=>'text/plain',
        'png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg',
        'gif'=>'image/gif','webp'=>'image/webp','ico'=>'image/x-icon',
        'pdf'=>'application/pdf','zip'=>'application/zip',
        'gz'=>'application/gzip','tar'=>'application/x-tar',
    ];
    return $map[$ext] ?? 'application/octet-stream';
}

function isTextFile(string $path): bool {
    $mime = getMime($path);
    if (strpos($mime, 'text/') === 0) return true;
    if (in_array($mime, ['application/json','application/xml','image/svg+xml'])) return true;
    $chunk = @file_get_contents($path, false, null, 0, 8192);
    if ($chunk === false) return false;
    return mb_check_encoding($chunk, 'UTF-8') && !preg_match('/[\x00-\x08\x0E-\x1F]/', $chunk);
}

function deleteRecursive(string $path): void {
    if (is_link($path)) {
        if (!unlink($path)) fail("Could not remove symlink: $path");
        return;
    }
    if (is_dir($path)) {
        foreach (scandir($path) as $n) {
            if ($n === '.' || $n === '..') continue;
            deleteRecursive($path . '/' . $n);
        }
        if (!rmdir($path)) fail("Could not remove directory: $path");
    } else {
        if (!unlink($path)) fail("Could not delete: $path");
    }
}

/** Silent version of deleteRecursive that returns bool (used by trash ops). */
function trashDeleteRecursive(string $path): bool {
    if (is_link($path)) return @unlink($path);
    if (is_dir($path)) {
        $items = @scandir($path);
        if ($items === false) return false;
        foreach (array_diff($items, ['.', '..']) as $item) {
            trashDeleteRecursive($path . '/' . $item);
        }
        return @rmdir($path);
    }
    if (file_exists($path)) return @unlink($path);
    return true;
}

function copyRecursive(string $src, string $dst): void {
    if (is_dir($src)) {
        if (!is_dir($dst)) mkdir($dst, 0755, true);
        foreach (scandir($src) as $n) {
            if ($n === '.' || $n === '..') continue;
            copyRecursive($src . '/' . $n, $dst . '/' . $n);
        }
    } else {
        $dir = dirname($dst);
        if (!is_dir($dir)) mkdir($dir, 0755, true);
        copy($src, $dst);
    }
}

function dirSize(string $path): int {
    $size = 0;
    if (is_dir($path)) {
        foreach (scandir($path) as $n) {
            if ($n === '.' || $n === '..') continue;
            $size += dirSize($path . '/' . $n);
        }
    } else {
        $size = filesize($path) ?: 0;
    }
    return $size;
}

function dirStats(string $path, ?callable $progress = null): array {
    $bytes = 0;
    $files = 0;
    $dirs = 0;
    $errors = 0;
    $seen = 0;
    $lastProgress = 0.0;

    $report = function (string $current = '') use (&$bytes, &$files, &$dirs, &$errors, &$seen, &$lastProgress, $progress): void {
        if (!$progress) return;
        $seen++;
        $now = microtime(true);
        if ($seen % 250 !== 0 && ($now - $lastProgress) < 1.0) return;
        $lastProgress = $now;
        $progress([
            'bytes' => $bytes,
            'files' => $files,
            'dirs' => max(0, $dirs - 1),
            'errors' => $errors,
            'current' => basename($current),
        ]);
    };

    $walk = function (string $current) use (&$walk, &$bytes, &$files, &$dirs, &$errors, &$report): void {
        if (is_link($current)) {
            $stat = @lstat($current);
            $bytes += (int)($stat['size'] ?? 0);
            $files++;
            $report($current);
            return;
        }

        if (is_dir($current)) {
            $dirs++;
            $report($current);
            $items = @scandir($current);
            if ($items === false) {
                $errors++;
                $report($current);
                return;
            }
            foreach ($items as $n) {
                if ($n === '.' || $n === '..') continue;
                $walk($current . '/' . $n);
            }
            return;
        }

        if (file_exists($current)) {
            $files++;
            $bytes += (int)(@filesize($current) ?: 0);
            $report($current);
        }
    };

    $walk($path);
    if ($dirs > 0) $dirs--;
    if ($progress) {
        $progress([
            'bytes' => $bytes,
            'files' => $files,
            'dirs' => $dirs,
            'errors' => $errors,
            'current' => '',
        ]);
    }

    return [
        'bytes' => $bytes,
        'files' => $files,
        'dirs' => $dirs,
        'errors' => $errors,
    ];
}

function countItems(string $path): array {
    $files = 0; $dirs = 0;
    if (is_dir($path)) {
        foreach (scandir($path) as $n) {
            if ($n === '.' || $n === '..') continue;
            if (is_dir($path . '/' . $n)) $dirs++; else $files++;
        }
    }
    return ['files' => $files, 'dirs' => $dirs];
}

function getSymlinkInfo(string $fullPath): array {
    if (!is_link($fullPath)) {
        return ['isSymlink' => false, 'symlinkTarget' => null, 'symlinkBroken' => false];
    }
    $target = readlink($fullPath);
    if ($target !== false && $target[0] !== '/') {
        $absoluteTarget = dirname($fullPath) . '/' . $target;
    } else {
        $absoluteTarget = $target;
    }
    $broken = ($target === false) || !file_exists($absoluteTarget);
    return ['isSymlink' => true, 'symlinkTarget' => $target ?: '', 'symlinkBroken' => $broken];
}

function filterItemsByAccess(array $items, string $currentRelPath, string $root): array {
    $currentRelPath = trim($currentRelPath, '/');
    if ($currentRelPath !== '' && $currentRelPath !== '.') {
        return $items;
    }
    return array_values(array_filter($items, function ($item) {
        return auth_can_see_top_dir($item['name']);
    }));
}

// ── Trash Helpers ────────────────────────────────────────────────────────────

function ensureTrashDirs(): void {
    global $TRASH_META_DIR, $TRASH_FILES_DIR;
    if (!is_dir($TRASH_META_DIR)) mkdir($TRASH_META_DIR, 0755, true);
    if (!is_dir($TRASH_FILES_DIR)) mkdir($TRASH_FILES_DIR, 0755, true);
}

function generateTrashId(): string {
    return date('Ymd_His') . '_' . substr(bin2hex(random_bytes(4)), 0, 8);
}

function humanTimeDiff(int $timestamp): string {
    $diff = time() - $timestamp;
    if ($diff < 0) return 'just now';
    if ($diff < 60) return $diff . 's ago';
    if ($diff < 3600) return floor($diff / 60) . 'm ago';
    if ($diff < 86400) return floor($diff / 3600) . 'h ago';
    if ($diff < 2592000) return floor($diff / 86400) . 'd ago';
    if ($diff < 31536000) return floor($diff / 2592000) . 'mo ago';
    return floor($diff / 31536000) . 'y ago';
}

/** Count all items recursively inside a directory. */
function countDirItemsRecursive(string $path): int {
    if (!is_dir($path) || is_link($path)) return 0;
    $count = 0;
    try {
        $iter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iter as $_) $count++;
    } catch (Exception $e) {}
    return $count;
}

function sanitizeTrashId(string $id): string {
    return preg_replace('/[^a-zA-Z0-9_]/', '', $id);
}

function ensureJobsDir(): void {
    global $JOBS_BASE;
    if (!is_dir($JOBS_BASE)) mkdir($JOBS_BASE, 0755, true);
}

function generateJobId(): string {
    return date('Ymd_His') . '_' . substr(bin2hex(random_bytes(5)), 0, 10);
}

function sanitizeJobId(string $id): string {
    return preg_replace('/[^a-zA-Z0-9_]/', '', $id);
}

function jobPath(string $id): string {
    global $JOBS_BASE;
    return $JOBS_BASE . '/dir_size_' . sanitizeJobId($id) . '.json';
}

function readJob(string $id): ?array {
    $path = jobPath($id);
    if (!is_file($path)) return null;
    $data = json_decode((string)@file_get_contents($path), true);
    return is_array($data) ? $data : null;
}

function writeJob(array $job): void {
    ensureJobsDir();
    $path = jobPath((string)($job['id'] ?? ''));
    $tmp = $path . '.tmp';
    $job['updatedAt'] = time();
    file_put_contents($tmp, json_encode($job, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @rename($tmp, $path);
}

function phpCliBinary(): string {
    $env = getenv('PHP_CLI_BINARY');
    if ($env) return $env;
    return PHP_BINDIR . DIRECTORY_SEPARATOR . (DIRECTORY_SEPARATOR === '\\' ? 'php.exe' : 'php');
}

function launchDirSizeWorker(string $jobId): bool {
    $php = phpCliBinary();
    if (DIRECTORY_SEPARATOR === '\\') {
        $cmd = 'start /B "" ' . escapeshellarg($php) . ' ' . escapeshellarg(__FILE__) . ' --dir-size-worker ' . escapeshellarg($jobId);
        if (function_exists('popen')) {
            $handle = @popen($cmd, 'r');
            if ($handle) @pclose($handle);
            return true;
        }
        if (function_exists('exec')) {
            @exec($cmd);
            return true;
        }
        return false;
    }
    $cmd = escapeshellarg($php) . ' ' . escapeshellarg(__FILE__) . ' --dir-size-worker ' . escapeshellarg($jobId) . ' > /dev/null 2>&1 &';
    if (function_exists('popen')) {
        $handle = @popen($cmd, 'r');
        if (!$handle) return false;
        @pclose($handle);
        return true;
    }
    if (function_exists('exec')) {
        @exec($cmd);
        return true;
    }
    return false;
}

function cleanupOldJobs(): void {
    global $JOBS_BASE;
    if (!is_dir($JOBS_BASE)) return;
    foreach (glob($JOBS_BASE . '/dir_size_*.json') ?: [] as $path) {
        if ((time() - (int)@filemtime($path)) > 172800) @unlink($path);
    }
}

function runDirSizeWorker(string $jobId): int {
    global $ROOT;
    set_time_limit(0);
    ini_set('max_execution_time', '0');
    $jobId = sanitizeJobId($jobId);
    $job = readJob($jobId);
    if (!$job) return 1;

    $started = microtime(true);
    try {
        $rel = (string)($job['path'] ?? '');
        $path = safePath($ROOT, $rel);
        if (!is_dir($path)) throw new RuntimeException('Not a directory.');

        $job['status'] = 'running';
        $job['startedAt'] = time();
        $job['message'] = 'Scanning folder...';
        writeJob($job);

        $lastWrite = 0.0;
        $stats = dirStats($path, function (array $partial) use (&$job, &$lastWrite, $started): void {
            $now = microtime(true);
            if (($now - $lastWrite) < 1.0) return;
            $lastWrite = $now;
            $job['status'] = 'running';
            $job['size'] = $partial['bytes'];
            $job['sizeH'] = humanSize((int)$partial['bytes']);
            $job['files'] = $partial['files'];
            $job['dirs'] = $partial['dirs'];
            $job['errors'] = $partial['errors'];
            $job['elapsed'] = round($now - $started, 1);
            $job['message'] = 'Scanning' . (!empty($partial['current']) ? ': ' . $partial['current'] : '...');
            writeJob($job);
        });

        $job['status'] = 'done';
        $job['size'] = $stats['bytes'];
        $job['sizeH'] = humanSize((int)$stats['bytes']);
        $job['files'] = $stats['files'];
        $job['dirs'] = $stats['dirs'];
        $job['errors'] = $stats['errors'];
        $job['elapsed'] = round(microtime(true) - $started, 2);
        $job['message'] = 'Done';
        writeJob($job);
        return 0;
    } catch (Throwable $e) {
        $job['status'] = 'error';
        $job['error'] = $e->getMessage();
        $job['elapsed'] = round(microtime(true) - $started, 2);
        writeJob($job);
        return 1;
    }
}

if ($IS_DIR_SIZE_WORKER) {
    exit(runDirSizeWorker($argv[2] ?? ''));
}

// ── Routing ──────────────────────────────────────────────────────────────────

$action = $_REQUEST['action'] ?? '';

switch ($action) {

    // ── LIST DIRECTORY ───────────────────────────────────────────────────────
    case 'list':
        $dir = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_dir($dir)) fail('Not a directory.');
        $items = [];
        foreach (scandir($dir) as $n) {
            if ($n === '.' || $n === '..') continue;
            // Hide internal IDE directories from listings
            if ($n === '.ide_trash' || $n === '.ide_jobs') continue;
            $full = $dir . '/' . $n;
            $isDir = is_dir($full);
            $slInfo = getSymlinkInfo($full);
            $items[] = [
                'name'          => $n,
                'path'          => relPath($ROOT, $full),
                'isDir'         => $isDir,
                'size'          => $isDir ? 0 : (int)(@filesize($full) ?: 0),
                'sizeH'         => $isDir ? '--' : humanSize((int)(@filesize($full) ?: 0)),
                'mtime'         => (int)(@filemtime($full) ?: 0),
                'perms'         => substr(decoct(@fileperms($full) ?: 0), -4),
                'ext'           => $isDir ? '' : strtolower(pathinfo($n, PATHINFO_EXTENSION)),
                'isSymlink'     => $slInfo['isSymlink'],
                'symlinkTarget' => $slInfo['symlinkTarget'],
                'symlinkBroken' => $slInfo['symlinkBroken'],
            ];
        }
        usort($items, function ($a, $b) {
            if ($a['isDir'] !== $b['isDir']) return $a['isDir'] ? -1 : 1;
            return strcasecmp($a['name'], $b['name']);
        });
        $rel = relPath($ROOT, $dir);
        $items = filterItemsByAccess($items, $rel, $ROOT);
        jsonOut([
            'ok'    => true,
            'path'  => $rel,
            'items' => $items,
            'parent'=> ($rel && $rel !== '.') ? (dirname($rel) === '.' ? '' : dirname($rel)) : null,
        ]);
        break;

    // ── READ FILE ────────────────────────────────────────────────────────────
    case 'dir_size_start':
        cleanupOldJobs();
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_dir($path)) fail('Not a directory.');
        ensureJobsDir();
        $id = generateJobId();
        $rel = relPath($ROOT, $path);
        $job = [
            'id' => $id,
            'type' => 'dir_size',
            'status' => 'queued',
            'name' => basename($path) ?: 'Root',
            'path' => $rel,
            'message' => 'Queued',
            'createdAt' => time(),
            'updatedAt' => time(),
        ];
        writeJob($job);
        if (!launchDirSizeWorker($id)) {
            $job['status'] = 'error';
            $job['error'] = 'Could not start background worker.';
            writeJob($job);
            fail($job['error'], 500);
        }
        jsonOut(['ok' => true, 'jobId' => $id, 'job' => $job]);
        break;

    case 'dir_size_status':
        $id = sanitizeJobId($_REQUEST['job'] ?? $_REQUEST['id'] ?? '');
        if (!$id) fail('No job specified.');
        $job = readJob($id);
        if (!$job) fail('Job not found.', 404);
        if (!auth_can_access_path((string)($job['path'] ?? ''))) fail('Does not exist.', 404);
        jsonOut(['ok' => true, 'job' => $job]);
        break;

    case 'dir_size':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_dir($path)) fail('Not a directory.');
        $started = microtime(true);
        $stats = dirStats($path);
        jsonOut([
            'ok'       => true,
            'name'     => basename($path) ?: 'Root',
            'path'     => relPath($ROOT, $path),
            'size'     => $stats['bytes'],
            'sizeH'    => humanSize($stats['bytes']),
            'files'    => $stats['files'],
            'dirs'     => $stats['dirs'],
            'errors'   => $stats['errors'],
            'elapsed'  => round(microtime(true) - $started, 2),
        ]);
        break;

    case 'read':
        $file = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_file($file)) fail('Not a file.');
        $size = filesize($file) ?: 0;
        $isText = isTextFile($file);
        $slInfo = getSymlinkInfo($file);
        if (!$isText) {
            jsonOut([
                'ok'            => true,
                'path'          => relPath($ROOT, $file),
                'binary'        => true,
                'size'          => $size,
                'sizeH'         => humanSize($size),
                'mime'          => getMime($file),
                'isSymlink'     => $slInfo['isSymlink'],
                'symlinkTarget' => $slInfo['symlinkTarget'],
                'symlinkBroken' => $slInfo['symlinkBroken'],
            ]);
        }
        $content = file_get_contents($file);
        if ($content === false) fail('Could not read file.');
        jsonOut([
            'ok'            => true,
            'path'          => relPath($ROOT, $file),
            'binary'        => false,
            'content'       => $content,
            'size'          => $size,
            'sizeH'         => humanSize($size),
            'mime'          => getMime($file),
            'mtime'         => filemtime($file) ?: 0,
            'isSymlink'     => $slInfo['isSymlink'],
            'symlinkTarget' => $slInfo['symlinkTarget'],
            'symlinkBroken' => $slInfo['symlinkBroken'],
        ]);
        break;

    // ── WRITE / SAVE FILE ────────────────────────────────────────────────────
    case 'write':
        $file = securedPath($ROOT, $_REQUEST['path'] ?? '');
        $content = $_POST['content'] ?? $_REQUEST['content'] ?? '';
        if ($content === '' && $_SERVER['REQUEST_METHOD'] === 'POST') {
            $raw = file_get_contents('php://input');
            $json = json_decode($raw, true);
            if ($json && isset($json['content'])) {
                $content = $json['content'];
                if (isset($json['path'])) {
                    $file = securedPath($ROOT, $json['path']);
                }
            }
        }
        $dir = dirname($file);
        if (!is_dir($dir)) mkdir($dir, 0755, true);
        if (file_put_contents($file, $content) === false) fail('Write failed.');
        clearstatcache(true, $file);
        jsonOut([
            'ok'    => true,
            'path'  => relPath($ROOT, $file),
            'size'  => strlen($content),
            'sizeH' => humanSize(strlen($content)),
        ]);
        break;

    // ── CREATE FILE ──────────────────────────────────────────────────────────
    case 'create_file':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (file_exists($path)) fail('Already exists.');
        $dir = dirname($path);
        if (!is_dir($dir)) mkdir($dir, 0755, true);
        file_put_contents($path, '');
        jsonOut(['ok' => true, 'path' => relPath($ROOT, $path)]);
        break;

    // ── CREATE DIRECTORY ─────────────────────────────────────────────────────
    case 'create_dir':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (file_exists($path) || is_link($path)) fail('Already exists.', 409);
        $nearestParent = dirname($path);
        while (!is_dir($nearestParent) && $nearestParent !== dirname($nearestParent)) {
            $nearestParent = dirname($nearestParent);
        }
        if (!is_dir($nearestParent)) fail('Could not find a parent directory to create inside.');
        if (!is_writable($nearestParent)) fail('Cannot create directory: parent is not writable.', 403);
        error_clear_last();
        if (!@mkdir($path, 0755, true)) {
            $err = error_get_last();
            fail('Could not create directory' . (!empty($err['message']) ? ': ' . $err['message'] : '.'), 500);
        }
        jsonOut(['ok' => true, 'path' => relPath($ROOT, $path)]);
        break;

    // ── DELETE ────────────────────────────────────────────────────────────────
    case 'delete':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if ($path === $ROOT) fail('Cannot delete root.');
        if (!file_exists($path) && !is_link($path)) fail('Does not exist.');
        deleteRecursive($path);
        jsonOut(['ok' => true]);
        break;

    // ── RENAME ───────────────────────────────────────────────────────────────
    case 'rename':
        $old = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!file_exists($old) && !is_link($old)) fail('Source does not exist.');
        $newPathRel = trim($_REQUEST['newPath'] ?? '');
        if ($newPathRel !== '') {
            $newPath = safePath($ROOT, $newPathRel);
        } else {
            $newName = basename(trim($_REQUEST['name'] ?? ''));
            if ($newName === '' || $newName === '.' || $newName === '..') fail('Invalid name.');
            $newPath = dirname($old) . '/' . $newName;
        }
        $newRel = relPath($ROOT, $newPath);
        if (!auth_can_access_path($newRel)) fail('Does not exist.', 404);
        if (file_exists($newPath) || is_link($newPath)) fail('Target already exists.');

        // Block cross-device moves — use Copy then Delete instead
        $srcStat = stat(is_link($old) ? dirname($old) : $old);
        $dstDir  = file_exists(dirname($newPath)) ? dirname($newPath) : $ROOT;
        $dstStat = stat($dstDir);
        if ($srcStat !== false && $dstStat !== false && $srcStat['dev'] !== $dstStat['dev']) {
            fail('Cannot move across devices (volume boundary). Use Copy, then Delete the original.');
        }

        if (!rename($old, $newPath)) fail('Rename failed.');
        jsonOut(['ok' => true, 'path' => relPath($ROOT, $newPath)]);
        break;


    // ── COPY ─────────────────────────────────────────────────────────────────
    case 'copy':
        $src = securedPath($ROOT, $_REQUEST['src'] ?? '');
        $dst = securedPath($ROOT, $_REQUEST['dst'] ?? '');
        if (!file_exists($src)) fail('Source does not exist.');
        if (file_exists($dst)) {
            if (is_dir($dst)) {
                $dst = $dst . '/' . basename($src);
            }
            if (file_exists($dst)) {
                $base = pathinfo($dst, PATHINFO_FILENAME);
                $ext  = pathinfo($dst, PATHINFO_EXTENSION);
                $dir  = dirname($dst);
                $i = 1;
                do {
                    $try = $dir . '/' . $base . ' (' . $i . ')' . ($ext ? '.' . $ext : '');
                    $i++;
                } while (file_exists($try));
                $dst = $try;
            }
        }
        copyRecursive($src, $dst);
        jsonOut(['ok' => true, 'path' => relPath($ROOT, $dst)]);
        break;

    // ── MOVE ─────────────────────────────────────────────────────────────────
    case 'move':
        $src = securedPath($ROOT, $_REQUEST['src'] ?? '');
        $dst = securedPath($ROOT, $_REQUEST['dst'] ?? '');
        if (!file_exists($src) && !is_link($src)) fail('Source does not exist.');
        if (is_dir($dst)) {
            $dst = $dst . '/' . basename($src);
        }
        $dstRel = relPath($ROOT, $dst);
        if (!auth_can_access_path($dstRel)) fail('Does not exist.', 404);
        if (file_exists($dst) || is_link($dst)) fail('Target already exists.');

        // Block cross-device moves
        $srcStat = stat(dirname($src));
        $dstStat = stat(dirname($dst) ?: $ROOT);
        if ($srcStat !== false && $dstStat !== false && $srcStat['dev'] !== $dstStat['dev']) {
            fail('Cannot move across devices (volume boundary). Use Copy, then Delete the original.');
        }

        $dir = dirname($dst);
        if (!is_dir($dir)) mkdir($dir, 0755, true);
        if (!rename($src, $dst)) fail('Move failed.');
        jsonOut(['ok' => true, 'path' => relPath($ROOT, $dst)]);
        break;


    // ── INFO ─────────────────────────────────────────────────────────────────
    case 'info':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!file_exists($path) && !is_link($path)) fail('Does not exist.');
        $isDir = is_dir($path);
        $slInfo = getSymlinkInfo($path);
        $data = [
            'ok'            => true,
            'name'          => basename($path),
            'path'          => relPath($ROOT, $path),
            'isDir'         => $isDir,
            'size'          => $isDir ? dirSize($path) : (int)(@filesize($path) ?: 0),
            'sizeH'         => humanSize($isDir ? dirSize($path) : (int)(@filesize($path) ?: 0)),
            'mtime'         => @filemtime($path) ?: 0,
            'perms'         => substr(decoct(@fileperms($path) ?: 0), -4),
            'owner'         => function_exists('posix_getpwuid') ? (posix_getpwuid(fileowner($path))['name'] ?? '?') : '?',
            'isSymlink'     => $slInfo['isSymlink'],
            'symlinkTarget' => $slInfo['symlinkTarget'],
            'symlinkBroken' => $slInfo['symlinkBroken'],
        ];
        if ($isDir) {
            $counts = countItems($path);
            $data['files'] = $counts['files'];
            $data['dirs']  = $counts['dirs'];
        } else {
            $data['mime'] = getMime($path);
            $data['ext']  = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        }
        if ($slInfo['isSymlink'] && !$slInfo['symlinkBroken']) {
            $resolved = realpath($path);
            if ($resolved !== false) {
                $data['resolvedPath'] = $resolved;
            }
        }
        jsonOut($data);
        break;

    // ── UPLOAD ────────────────────────────────────────────────────────────────
    case 'upload':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('POST required.');
        $dir = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_dir($dir)) fail('Target directory does not exist.');
        $uploaded = [];
        if (!empty($_FILES['files'])) {
            $files = $_FILES['files'];
            $count = is_array($files['name']) ? count($files['name']) : 1;
            for ($i = 0; $i < $count; $i++) {
                $name  = is_array($files['name'])  ? $files['name'][$i]  : $files['name'];
                $tmp   = is_array($files['tmp_name']) ? $files['tmp_name'][$i] : $files['tmp_name'];
                $error = is_array($files['error']) ? $files['error'][$i] : $files['error'];
                $size  = is_array($files['size'])  ? $files['size'][$i]  : $files['size'];
                if ($error !== UPLOAD_ERR_OK) continue;
                if ($size > $MAX_UPLOAD) continue;
                $safeName = basename($name);
                $dest = $dir . '/' . $safeName;
                if (file_exists($dest)) {
                    $base = pathinfo($safeName, PATHINFO_FILENAME);
                    $ext  = pathinfo($safeName, PATHINFO_EXTENSION);
                    $j = 1;
                    do {
                        $dest = $dir . '/' . $base . ' (' . $j . ')' . ($ext ? '.' . $ext : '');
                        $j++;
                    } while (file_exists($dest));
                }
                if (move_uploaded_file($tmp, $dest)) {
                    $uploaded[] = relPath($ROOT, $dest);
                }
            }
        }
        jsonOut(['ok' => true, 'uploaded' => $uploaded, 'count' => count($uploaded)]);
        break;

    // ── DOWNLOAD ─────────────────────────────────────────────────────────────
    case 'download':
        $path = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_file($path)) fail('Not a file.');
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($path) . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;

    // ── DOWNLOAD ZIP (directory or multiple paths) ──────────────────────────
    case 'download_zip':
        if (!class_exists('ZipArchive')) fail('ZipArchive not available. Install php-zip.');

        $paths = [];
        // Support single path or comma-separated paths
        $pathParam = trim($_REQUEST['path'] ?? '');
        $pathsParam = trim($_REQUEST['paths'] ?? '');

        if ($pathsParam !== '') {
            $paths = array_filter(array_map('trim', explode(',', $pathsParam)));
        } elseif ($pathParam !== '') {
            $paths = [$pathParam];
        }
        if (empty($paths)) fail('No path(s) specified.');

        // Resolve and validate all paths
        $resolvedPaths = [];
        foreach ($paths as $p) {
            $full = securedPath($ROOT, $p);
            if (!file_exists($full) && !is_link($full)) fail('Path not found: ' . $p);
            $resolvedPaths[] = ['full' => $full, 'rel' => $p, 'name' => basename($p)];
        }

        // Determine zip filename
        if (count($resolvedPaths) === 1 && is_dir($resolvedPaths[0]['full'])) {
            $zipName = $resolvedPaths[0]['name'] . '.zip';
        } else {
            $zipName = 'download_' . date('Ymd_His') . '.zip';
        }

        // Create temp zip file
        $tmpZip = tempnam(sys_get_temp_dir(), 'ide_zip_');
        $zip = new ZipArchive();
        $res = $zip->open($tmpZip, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        if ($res !== true) {
            @unlink($tmpZip);
            fail('Could not create zip archive.');
        }

        // Recursive add helper
        $addToZip = function(string $fullPath, string $zipPrefix) use (&$addToZip, &$zip, $ROOT) {
            if (is_link($fullPath) && !file_exists($fullPath)) return; // skip broken symlinks
            if (is_file($fullPath) || (is_link($fullPath) && is_file(realpath($fullPath)))) {
                $zip->addFile($fullPath, $zipPrefix);
            } elseif (is_dir($fullPath)) {
                $zip->addEmptyDir($zipPrefix);
                $entries = @scandir($fullPath);
                if ($entries === false) return;
                foreach ($entries as $entry) {
                    if ($entry === '.' || $entry === '..' || $entry === '.ide_trash' || $entry === '.ide_jobs') continue;
                    $entryFullPath = $fullPath . '/' . $entry;
                    if (!auth_can_access_path(relPath($ROOT, $entryFullPath))) continue;
                    $addToZip($entryFullPath, $zipPrefix . '/' . $entry);
                }
            }
        };

        foreach ($resolvedPaths as $rp) {
            if (is_dir($rp['full'])) {
                $addToZip($rp['full'], $rp['name']);
            } else {
                $zip->addFile($rp['full'], $rp['name']);
            }
        }

        $zip->close();

        // Stream the zip file
        $zipSize = filesize($tmpZip);
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $zipName . '"');
        header('Content-Length: ' . $zipSize);
        header('Cache-Control: no-cache, no-store, must-revalidate');
        readfile($tmpZip);
        @unlink($tmpZip);
        exit;

    // ── SEARCH ───────────────────────────────────────────────────────────────
    case 'search':
        $dir = securedPath($ROOT, $_REQUEST['path'] ?? '');
        $q   = trim($_REQUEST['q'] ?? '');
        if ($q === '') fail('Query required.');
        if (!is_dir($dir)) fail('Not a directory.');
        $results = [];
        $maxResults = 200;
        $iter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iter as $item) {
            if (count($results) >= $maxResults) break;
            $name = $item->getFilename();
            if (stripos($name, $q) !== false) {
                $full = $item->getPathname();
                $itemRel = relPath($ROOT, $full);
                if (!auth_can_access_path($itemRel)) continue;
                // Skip internal IDE directories from search
                if (strpos($itemRel, '.ide_trash') === 0 || strpos($itemRel, '.ide_jobs') === 0) continue;
                $slInfo = getSymlinkInfo($full);
                $results[] = [
                    'name'          => $name,
                    'path'          => $itemRel,
                    'isDir'         => $item->isDir(),
                    'isSymlink'     => $slInfo['isSymlink'],
                    'symlinkTarget' => $slInfo['symlinkTarget'],
                    'symlinkBroken' => $slInfo['symlinkBroken'],
                ];
            }
        }
        jsonOut(['ok' => true, 'results' => $results, 'query' => $q]);
        break;

    // ── TREE (for sidebar) ───────────────────────────────────────────────────
    case 'tree':
        $dir = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_dir($dir)) fail('Not a directory.');
        $depth = min((int)($_REQUEST['depth'] ?? 1), 5);
        $currentDirRel = relPath($ROOT, $dir);
        $buildTree = function(string $path, int $level) use (&$buildTree, $ROOT, $depth, $currentDirRel): array {
            $items = [];
            $pathRel = relPath($ROOT, $path);
            $isRootLevel = ($pathRel === '' || $pathRel === '.');
            foreach (scandir($path) as $n) {
                if ($n === '.' || $n === '..') continue;
                // Hide internal IDE directories from tree
                if ($n === '.ide_trash' || $n === '.ide_jobs') continue;
                $full = $path . '/' . $n;
                $isDir = is_dir($full);
                if ($isRootLevel && $isDir && !auth_can_see_top_dir($n)) continue;
                if ($isRootLevel && !$isDir && !auth_has_root()) continue;
                $slInfo = getSymlinkInfo($full);
                $node = [
                    'name'          => $n,
                    'path'          => relPath($ROOT, $full),
                    'isDir'         => $isDir,
                    'isSymlink'     => $slInfo['isSymlink'],
                    'symlinkTarget' => $slInfo['symlinkTarget'],
                    'symlinkBroken' => $slInfo['symlinkBroken'],
                ];
                if ($isDir && $level < $depth) {
                    $node['children'] = $buildTree($full, $level + 1);
                } elseif ($isDir) {
                    if ($slInfo['symlinkBroken']) {
                        $node['hasChildren'] = false;
                    } else {
                        $node['hasChildren'] = (count(@scandir($full) ?: []) > 2);
                    }
                }
                $items[] = $node;
            }
            usort($items, function ($a, $b) {
                if ($a['isDir'] !== $b['isDir']) return $a['isDir'] ? -1 : 1;
                return strcasecmp($a['name'], $b['name']);
            });
            return $items;
        };
        jsonOut(['ok' => true, 'tree' => $buildTree($dir, 0)]);
        break;

    // ── CREATE SYMLINK ───────────────────────────────────────────────────────
    case 'create_symlink':
        $linkPath = securedPath($ROOT, $_REQUEST['path'] ?? '');
        $target   = trim($_REQUEST['target'] ?? '');
        if ($target === '') fail('Symlink target is required.');
        if (file_exists($linkPath) || is_link($linkPath)) fail('A file or link already exists at that path.');
        $parentDir = dirname($linkPath);
        if (!is_dir($parentDir)) fail('Parent directory does not exist: ' . relPath($ROOT, $parentDir));
        if (!function_exists('symlink')) fail('symlink() function is not available in this PHP installation.');
        $prevHandler = set_error_handler(function($errno, $errstr) {});
        $ok = @symlink($target, $linkPath);
        set_error_handler($prevHandler);
        if (!$ok) {
            $lastErr = error_get_last();
            $detail = $lastErr ? $lastErr['message'] : 'Unknown error';
            fail('Failed to create symlink: ' . $detail);
        }
        $slInfo = getSymlinkInfo($linkPath);
        jsonOut([
            'ok'            => true,
            'path'          => relPath($ROOT, $linkPath),
            'isSymlink'     => true,
            'symlinkTarget' => $slInfo['symlinkTarget'],
            'symlinkBroken' => $slInfo['symlinkBroken'],
        ]);
        break;

    // ── EDIT SYMLINK ─────────────────────────────────────────────────────────
    case 'edit_symlink':
        $linkPath  = securedPath($ROOT, $_REQUEST['path'] ?? '');
        $newTarget = trim($_REQUEST['target'] ?? '');
        if ($newTarget === '') fail('New symlink target is required.');
        if (!is_link($linkPath)) fail('Path is not a symbolic link.');
        if (!unlink($linkPath)) fail('Could not remove old symlink.');
        $ok = @symlink($newTarget, $linkPath);
        if (!$ok) {
            $lastErr = error_get_last();
            $detail = $lastErr ? $lastErr['message'] : 'Unknown error';
            fail('Failed to create new symlink: ' . $detail);
        }
        $slInfo = getSymlinkInfo($linkPath);
        jsonOut([
            'ok'            => true,
            'path'          => relPath($ROOT, $linkPath),
            'isSymlink'     => true,
            'symlinkTarget' => $slInfo['symlinkTarget'],
            'symlinkBroken' => $slInfo['symlinkBroken'],
        ]);
        break;

    // ── REMOVE SYMLINK ───────────────────────────────────────────────────────
    case 'remove_symlink':
        $linkPath = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_link($linkPath)) fail('Path is not a symbolic link.');
        if (!unlink($linkPath)) fail('Could not remove symlink.');
        jsonOut(['ok' => true]);
        break;

    // ── SYMLINK INFO ─────────────────────────────────────────────────────────
    case 'symlink_info':
        $linkPath = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_link($linkPath)) fail('Path is not a symbolic link.');
        $target = readlink($linkPath);
        if ($target !== false && $target[0] !== '/') {
            $absoluteTarget = dirname($linkPath) . '/' . $target;
        } else {
            $absoluteTarget = $target;
        }
        $broken = ($target === false) || !file_exists($absoluteTarget);
        $resolved = $broken ? null : realpath($linkPath);
        $targetIsDir = !$broken && is_dir($absoluteTarget);
        jsonOut([
            'ok'           => true,
            'path'         => relPath($ROOT, $linkPath),
            'target'       => $target ?: '',
            'broken'       => $broken,
            'resolvedPath' => $resolved ?: null,
            'targetIsDir'  => $targetIsDir,
            'linkMtime'    => @lstat($linkPath)['mtime'] ?? 0,
        ]);
        break;

    // ── EXTRACT ARCHIVE ──────────────────────────────────────────────────────
    case 'extract':
        try {
        $full = securedPath($ROOT, $_REQUEST['path'] ?? '');
        if (!is_file($full)) fail('File not found: ' . $_REQUEST['path']);
        $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));
        $destDir = dirname($full) . DIRECTORY_SEPARATOR . pathinfo($full, PATHINFO_FILENAME);
        if (is_dir($destDir)) {
            $i = 1;
            while (is_dir($destDir . " ($i)")) $i++;
            $destDir .= " ($i)";
        }
        if ($ext === 'zip') {
            if (!class_exists('ZipArchive')) fail('ZipArchive not available. Install php-zip: apt install php8.3-zip');
            $zip = new ZipArchive();
            $res = $zip->open($full);
            if ($res !== true) fail('Cannot open zip file, error code: ' . $res);
            if (!mkdir($destDir, 0755, true)) fail('Cannot create output directory: ' . $destDir . ' — check permissions');
            $zip->extractTo($destDir);
            $count = $zip->numFiles;
            $zip->close();
            $relDest = ltrim(str_replace($ROOT, '', $destDir), '/\\');
            jsonOut(['ok' => true, 'extracted' => $count, 'path' => $relDest]);
        } elseif (in_array($ext, ['gz', 'tgz', 'tar', 'bz2', 'xz'])) {
            if (!mkdir($destDir, 0755, true)) fail('Cannot create output directory: ' . $destDir);
            $escaped = escapeshellarg($full);
            $escapedDest = escapeshellarg($destDir);
            if ($ext === 'tar') {
                exec("tar -xf $escaped -C $escapedDest 2>&1", $out, $ret);
            } elseif ($ext === 'gz' || $ext === 'tgz') {
                exec("tar -xzf $escaped -C $escapedDest 2>&1", $out, $ret);
            } elseif ($ext === 'bz2') {
                exec("tar -xjf $escaped -C $escapedDest 2>&1", $out, $ret);
            } elseif ($ext === 'xz') {
                exec("tar -xJf $escaped -C $escapedDest 2>&1", $out, $ret);
            }
            if ($ret !== 0) fail('Extraction failed: ' . implode("\n", $out));
            $relDest = ltrim(str_replace($ROOT, '', $destDir), '/\\');
            jsonOut(['ok' => true, 'extracted' => -1, 'path' => $relDest]);
        } else {
            fail('Unsupported archive format: ' . $ext);
        }
        } catch (Throwable $e) {
            fail('Extract error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
        }
        break;

    // ═════════════════════════════════════════════════════════════════════════
    // TRASH SYSTEM
    // ═════════════════════════════════════════════════════════════════════════

    // ── TRASH: Move item to trash ────────────────────────────────────────────
    case 'trash_move':
        $relInput = $_REQUEST['path'] ?? '';
        $fullPath = securedPath($ROOT, $relInput);
        if ($fullPath === $ROOT) fail('Cannot trash root.');
        if (!file_exists($fullPath) && !is_link($fullPath)) fail('Item not found.');

        // Don't trash the trash
        $trashReal = realpath($TRASH_BASE) ?: $TRASH_BASE;
        $itemReal  = realpath($fullPath) ?: $fullPath;
        if (strpos($itemReal, $trashReal) === 0) fail('Cannot trash the trash directory.');

        ensureTrashDirs();
        $id      = generateTrashId();
        $isLink  = is_link($fullPath);
        $isDir   = !$isLink && is_dir($fullPath);
        $relP    = relPath($ROOT, $fullPath);
        $name    = basename($relP);
        $size    = $isLink ? 0 : ($isDir ? dirSize($fullPath) : (int)(@filesize($fullPath) ?: 0));
        $items   = $isDir ? countDirItemsRecursive($fullPath) : ($isLink ? 0 : 1);
        $ext     = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        $slTarget = $isLink ? @readlink($fullPath) : null;

        $meta = [
            'id'            => $id,
            'originalPath'  => $relP,
            'originalName'  => $name,
            'deletedAt'     => time(),
            'deletedAtISO'  => date('c'),
            'sizeBytes'     => $size,
            'sizeH'         => humanSize($size),
            'isDir'         => $isDir,
            'isSymlink'     => $isLink,
            'symlinkTarget' => $slTarget,
            'extension'     => $ext,
            'itemCount'     => $items,
            'parentDir'     => dirname($relP) === '.' ? '' : dirname($relP),
        ];

        $metaPath = $TRASH_META_DIR . '/' . $id . '.json';
        if (file_put_contents($metaPath, json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) === false) {
            fail('Failed to write trash metadata.');
        }

        $destPath = $TRASH_FILES_DIR . '/' . $id;
        if (!@rename($fullPath, $destPath)) {
            // Cross-device or symlink fallback
            if ($isLink) {
                @symlink($slTarget, $destPath);
                @unlink($fullPath);
            } else {
                @unlink($metaPath);
                // rename() can't cross a filesystem/volume boundary (EXDEV).
                // The direct `delete` action removes the item regardless of
                // device, so let the client offer a permanent "hard delete".
                jsonOut([
                    'ok'            => false,
                    'error'         => 'Cannot move to trash across a volume boundary.',
                    'canHardDelete' => true,
                    'path'          => $relP,
                    'name'          => $name,
                ]);
            }
        }

        jsonOut(['ok' => true, 'id' => $id, 'name' => $name]);
        break;

    // ── TRASH: List trashed items ────────────────────────────────────────────
    case 'trash_list':
        ensureTrashDirs();
        $items = [];
        $totalSize = 0;
        $search = strtolower(trim($_REQUEST['search'] ?? $_REQUEST['q'] ?? ''));

        $metaFiles = glob($TRASH_META_DIR . '/*.json') ?: [];
        foreach ($metaFiles as $metaFile) {
            $meta = @json_decode(@file_get_contents($metaFile), true);
            if (!$meta || !isset($meta['id'])) continue;
            if (!auth_can_access_path((string)($meta['originalPath'] ?? ''))) continue;

            if ($search) {
                $haystack = strtolower(($meta['originalName'] ?? '') . ' ' . ($meta['originalPath'] ?? ''));
                if (strpos($haystack, $search) === false) continue;
            }

            $dataPath = $TRASH_FILES_DIR . '/' . $meta['id'];
            $meta['dataExists'] = file_exists($dataPath) || is_link($dataPath);
            $meta['ago'] = humanTimeDiff($meta['deletedAt'] ?? 0);
            $items[] = $meta;
            $totalSize += $meta['sizeBytes'] ?? 0;
        }

        usort($items, function ($a, $b) { return ($b['deletedAt'] ?? 0) - ($a['deletedAt'] ?? 0); });

        jsonOut([
            'ok'         => true,
            'items'      => $items,
            'totalSize'  => $totalSize,
            'totalSizeH' => humanSize($totalSize),
            'count'      => count($items),
        ]);
        break;

    // ── TRASH: Restore single item ───────────────────────────────────────────
    case 'trash_restore':
        $id = sanitizeTrashId($_REQUEST['id'] ?? '');
        if (!$id) fail('No trash ID specified.');

        $metaFile = $TRASH_META_DIR . '/' . $id . '.json';
        if (!file_exists($metaFile)) fail('Trash item not found.');

        $meta = json_decode(file_get_contents($metaFile), true);
        if (!$meta) fail('Corrupt metadata.');

        $dataPath = $TRASH_FILES_DIR . '/' . $id;
        if (!file_exists($dataPath) && !is_link($dataPath)) {
            @unlink($metaFile);
            fail('Trash data missing.');
        }

        $originalPath = $meta['originalPath'] ?? '';
        if (!auth_can_access_path((string)$originalPath)) fail('Trash item not found.', 404);
        $restorePath  = $ROOT . '/' . $originalPath;
        $restoredTo   = $originalPath;

        // Handle name conflict
        if (file_exists($restorePath) || is_link($restorePath)) {
            $dir  = dirname($restorePath);
            $name = $meta['originalName'] ?? basename($originalPath);
            $ext  = pathinfo($name, PATHINFO_EXTENSION);
            $base = $ext ? substr($name, 0, -(strlen($ext) + 1)) : $name;
            $c = 1;
            do {
                $newName = $base . '_restored_' . $c . ($ext ? '.' . $ext : '');
                $candidate = $dir . '/' . $newName;
                $c++;
            } while (file_exists($candidate) || is_link($candidate));
            $restorePath = $candidate;
            $parentRel = dirname($originalPath);
            $restoredTo = ($parentRel === '.' ? '' : $parentRel . '/') . $newName;
        }

        $parentDir = dirname($restorePath);
        if (!is_dir($parentDir)) @mkdir($parentDir, 0755, true);

        if (!@rename($dataPath, $restorePath)) fail('Failed to restore item.');
        @unlink($metaFile);

        jsonOut([
            'ok'           => true,
            'restoredTo'   => $restoredTo,
            'originalPath' => $originalPath,
            'renamed'      => ($restoredTo !== $originalPath),
        ]);
        break;

    // ── TRASH: Permanently delete single item ────────────────────────────────
    case 'trash_delete':
        $id = sanitizeTrashId($_REQUEST['id'] ?? '');
        if (!$id) fail('No trash ID specified.');

        $metaFile = $TRASH_META_DIR . '/' . $id . '.json';
        $dataPath = $TRASH_FILES_DIR . '/' . $id;
        if (file_exists($metaFile)) {
            $meta = @json_decode(@file_get_contents($metaFile), true);
            if ($meta && !auth_can_access_path((string)($meta['originalPath'] ?? ''))) fail('Trash item not found.', 404);
        }
        if (file_exists($dataPath) || is_link($dataPath)) trashDeleteRecursive($dataPath);
        if (file_exists($metaFile)) @unlink($metaFile);

        jsonOut(['ok' => true]);
        break;

    // ── TRASH: Empty all ─────────────────────────────────────────────────────
    case 'trash_empty':
        ensureTrashDirs();
        $count = 0;
        foreach (glob($TRASH_META_DIR . '/*.json') ?: [] as $metaFile) {
            $meta = @json_decode(@file_get_contents($metaFile), true);
            if ($meta && !auth_can_access_path((string)($meta['originalPath'] ?? ''))) continue;
            if ($meta && isset($meta['id'])) {
                $dp = $TRASH_FILES_DIR . '/' . $meta['id'];
                if (file_exists($dp) || is_link($dp)) trashDeleteRecursive($dp);
            }
            @unlink($metaFile);
            $count++;
        }
        // Clean orphaned data files
        foreach (array_diff(@scandir($TRASH_FILES_DIR) ?: [], ['.', '..']) as $item) {
            trashDeleteRecursive($TRASH_FILES_DIR . '/' . $item);
        }
        jsonOut(['ok' => true, 'count' => $count]);
        break;

    // ── TRASH: Stats ─────────────────────────────────────────────────────────
    case 'trash_stats':
        ensureTrashDirs();
        $totalSize = 0; $count = 0;
        foreach (glob($TRASH_META_DIR . '/*.json') ?: [] as $metaFile) {
            $meta = @json_decode(@file_get_contents($metaFile), true);
            if (!$meta) continue;
            if (!auth_can_access_path((string)($meta['originalPath'] ?? ''))) continue;
            $totalSize += $meta['sizeBytes'] ?? 0;
            $count++;
        }
        jsonOut(['ok' => true, 'count' => $count, 'totalSize' => $totalSize, 'totalSizeH' => humanSize($totalSize)]);
        break;

    // ── TRASH: Batch restore ─────────────────────────────────────────────────
    case 'trash_restore_multi':
        $ids = array_filter(array_map('sanitizeTrashId', explode(',', $_REQUEST['ids'] ?? '')));
        if (empty($ids)) fail('No IDs specified.');

        $restored = 0; $failed = 0;
        foreach ($ids as $id) {
            $mf = $TRASH_META_DIR . '/' . $id . '.json';
            if (!file_exists($mf)) { $failed++; continue; }
            $meta = json_decode(file_get_contents($mf), true);
            if (!$meta) { $failed++; continue; }
            if (!auth_can_access_path((string)($meta['originalPath'] ?? ''))) { $failed++; continue; }
            $dp = $TRASH_FILES_DIR . '/' . $id;
            if (!file_exists($dp) && !is_link($dp)) { @unlink($mf); $failed++; continue; }

            $op = $meta['originalPath'] ?? '';
            $rp = $ROOT . '/' . $op;
            if (file_exists($rp) || is_link($rp)) {
                $dir = dirname($rp);
                $name = $meta['originalName'] ?? basename($op);
                $ext = pathinfo($name, PATHINFO_EXTENSION);
                $base = $ext ? substr($name, 0, -(strlen($ext) + 1)) : $name;
                $c = 1;
                do {
                    $nn = $base . '_restored_' . $c . ($ext ? '.' . $ext : '');
                    $rp = $dir . '/' . $nn;
                    $c++;
                } while (file_exists($rp) || is_link($rp));
            }
            $pd = dirname($rp);
            if (!is_dir($pd)) @mkdir($pd, 0755, true);
            if (@rename($dp, $rp)) { @unlink($mf); $restored++; } else { $failed++; }
        }
        jsonOut(['ok' => true, 'restored' => $restored, 'failed' => $failed]);
        break;

    // ── TRASH: Batch delete ──────────────────────────────────────────────────
    case 'trash_delete_multi':
        $ids = array_filter(array_map('sanitizeTrashId', explode(',', $_REQUEST['ids'] ?? '')));
        $deleted = 0;
        foreach ($ids as $id) {
            $dp = $TRASH_FILES_DIR . '/' . $id;
            $mf = $TRASH_META_DIR . '/' . $id . '.json';
            if (file_exists($mf)) {
                $meta = @json_decode(@file_get_contents($mf), true);
                if ($meta && !auth_can_access_path((string)($meta['originalPath'] ?? ''))) continue;
            }
            if (file_exists($dp) || is_link($dp)) trashDeleteRecursive($dp);
            if (file_exists($mf)) @unlink($mf);
            $deleted++;
        }
        jsonOut(['ok' => true, 'deleted' => $deleted]);
        break;

    default:
        fail('Unknown action: ' . $action, 404);
}
