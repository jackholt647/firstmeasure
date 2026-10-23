<?php
/* FirstMate community forum: storage, validation and helpers.
 * Data is JSON files under the forum data directory (never in the web root on
 * the server): index.json (thread summaries), threads/<id>.json (one per
 * thread), ratelimit.json (hashed IPs), secret.key (HMAC secret) and
 * staff.json ({"hash": "<bcrypt>"}, written by tools/set-staff-code.php).
 * Every write happens under an exclusive flock on .lock and is atomic
 * (temp file + rename). */

if (!defined('FM_FORUM')) { http_response_code(404); exit; }

const FM_TITLE_MAX = 140;
const FM_BODY_MAX = 8000;
const FM_NAME_MAX = 60;
const FM_COMPANY_MAX = 80;
const FM_QUERY_MAX = 100;
const FM_RATE_POSTS = 5;
const FM_RATE_WINDOW = 600;      // seconds
const FM_MAX_POSTS_PER_THREAD = 1000;
const FM_CSRF_TTL = 172800;      // a form stays valid for two days
const FM_CSRF_MIN_AGE = 2;       // seconds; faster submissions are bots

function fm_categories(): array {
    return [
        'general'      => ['General discussion', 'Introduce yourself and talk shop with other contractors.', 'fa-comments'],
        'measurements' => ['Measurements & reports', 'Roof, exterior and full-house reports, pitch, waste and accuracy.', 'fa-ruler-combined'],
        'sales'        => ['Sales & proposals', 'Proposals, e-signature, follow-ups and closing the job.', 'fa-file-signature'],
        'production'   => ['Production & scheduling', 'Scheduling, work orders, materials and getting jobs finished.', 'fa-calendar-days'],
        'payments'     => ['Payments & billing', 'Collecting payments, deposits, financing and invoices.', 'fa-credit-card'],
        'features'     => ['Feature requests', 'Tell the FirstMate team what to build next.', 'fa-lightbulb'],
        'showcase'     => ['Show off your work', 'Finished jobs, before-and-afters and wins worth sharing.', 'fa-trophy'],
    ];
}

/* ---------- storage ---------- */

function fm_data_dir(): string {
    static $dir = null;
    if ($dir !== null) return $dir;
    $server = '/var/www/firstmate-website-next/data';
    if (is_dir($server)) {
        $dir = $server . '/forum';
    } else {
        // Refuse to fall back into the web root on a real server.
        if (DIRECTORY_SEPARATOR === '/' && strpos(__DIR__, '/var/www/') === 0) {
            throw new RuntimeException('Forum storage is not configured: create ' . $server);
        }
        $dir = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.data' . DIRECTORY_SEPARATOR . 'forum';
    }
    if (!is_dir($dir . '/threads') && !@mkdir($dir . '/threads', 0750, true) && !is_dir($dir . '/threads')) {
        throw new RuntimeException('Could not create the forum data directory.');
    }
    $ht = dirname($dir) . '/.htaccess';
    if (strpos($dir, '.data') !== false && !is_file($ht)) @file_put_contents($ht, "Require all denied\n");
    return $dir;
}

/** Run $fn while holding the forum lock (exclusive for writes, shared for reads). */
function fm_locked(bool $exclusive, callable $fn) {
    $h = fopen(fm_data_dir() . '/.lock', 'c');
    if (!$h || !flock($h, $exclusive ? LOCK_EX : LOCK_SH)) throw new RuntimeException('Could not lock the forum data.');
    try { return $fn(); }
    finally { flock($h, LOCK_UN); fclose($h); }
}

function fm_read_json(string $path, $default) {
    if (!is_file($path)) return $default;
    $raw = file_get_contents($path);
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

/** Atomic write: temp file in the same directory, then rename over the target. Call under the exclusive lock. */
function fm_write_json(string $path, $data): void {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) throw new RuntimeException('Could not encode forum data.');
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(6));
    if (file_put_contents($tmp, $json) !== strlen($json)) { @unlink($tmp); throw new RuntimeException('Could not write forum data.'); }
    if (!rename($tmp, $path)) { @unlink($tmp); throw new RuntimeException('Could not save forum data.'); }
}

function fm_index_path(): string { return fm_data_dir() . '/index.json'; }
function fm_thread_path(int $id): string { return fm_data_dir() . '/threads/' . $id . '.json'; }

function fm_secret(): string {
    static $secret = null;
    if ($secret !== null) return $secret;
    $path = fm_data_dir() . '/secret.key';
    if (!is_file($path)) {
        fm_locked(true, function () use ($path) {
            if (!is_file($path)) {
                $tmp = $path . '.tmp-' . bin2hex(random_bytes(6));
                file_put_contents($tmp, bin2hex(random_bytes(32)));
                rename($tmp, $path);
            }
        });
    }
    $secret = trim((string)file_get_contents($path));
    return $secret;
}

/** Create the index (and the pinned welcome thread) on first use. */
function fm_ensure_seeded(): void {
    if (is_file(fm_index_path())) return;
    fm_locked(true, function () {
        if (is_file(fm_index_path())) return;
        $now = time();
        $body = "Welcome to the FirstMate community forum!\n\n"
              . "This forum is brand new, so you are one of the first people here. It is a place for contractors to talk to each other: ask how others handle measurements, proposals, scheduling or payments, share finished jobs, and tell us what you want FirstMate to do next.\n\n"
              . "The FirstMate team reads every thread. Replies from us carry a red \"FirstMate Team\" badge so you always know who you are talking to.\n\n"
              . "A few ground rules:\n"
              . "- Be kind and keep it about the work.\n"
              . "- No spam or self-promotion beyond your signature.\n"
              . "- Do not post customer details, addresses or anything private.\n\n"
              . "Start a discussion in any category, or reply here to introduce yourself.";
        $thread = ['id' => 1, 'c' => 'general', 'title' => 'Welcome to the FirstMate community', 'pinned' => true, 'created' => $now,
            'posts' => [['n' => 1, 'name' => 'FirstMate Team', 'company' => '', 'staff' => true, 'body' => $body, 'created' => $now]], 'next' => 2];
        fm_write_json(fm_thread_path(1), $thread);
        fm_write_json(fm_index_path(), ['seq' => 1, 'threads' => ['1' => fm_summary($thread)]]);
    });
}

/** The index entry for a thread, derived from the thread file. */
function fm_summary(array $t): array {
    $live = array_values(array_filter($t['posts'], fn($p) => empty($p['removed'])));
    $first = $t['posts'][0];
    $last = $live ? $live[count($live) - 1] : $first;
    return [
        'id' => $t['id'], 'c' => $t['c'], 'title' => $t['title'], 'pinned' => !empty($t['pinned']),
        'created' => $t['created'], 'name' => $first['name'], 'company' => $first['company'] ?? '', 'staff' => !empty($first['staff']),
        'replies' => max(0, count($live) - 1), 'last' => $last['created'], 'last_name' => $last['name'], 'last_staff' => !empty($last['staff']),
        'excerpt' => fm_substr(preg_replace('/\s+/u', ' ', $first['body']) ?? '', 0, 220),
    ];
}

function fm_index(): array {
    fm_ensure_seeded();
    return fm_locked(false, fn() => fm_read_json(fm_index_path(), ['seq' => 0, 'threads' => []]));
}

function fm_thread(int $id): ?array {
    if ($id < 1) return null;
    fm_ensure_seeded();
    return fm_locked(false, fn() => fm_read_json(fm_thread_path($id), null));
}

/** Newest activity first, pinned threads ahead when $pinnedFirst. */
function fm_sorted(array $threads, bool $pinnedFirst = true): array {
    $list = array_values($threads);
    usort($list, function ($a, $b) use ($pinnedFirst) {
        if ($pinnedFirst && $a['pinned'] !== $b['pinned']) return $a['pinned'] ? -1 : 1;
        return $b['last'] <=> $a['last'] ?: $b['id'] <=> $a['id'];
    });
    return $list;
}

/* ---------- writes ---------- */

function fm_create_thread(string $c, string $title, array $post): int {
    return fm_locked(true, function () use ($c, $title, $post) {
        $index = fm_read_json(fm_index_path(), ['seq' => 0, 'threads' => []]);
        $id = (int)$index['seq'] + 1;
        while (is_file(fm_thread_path($id))) $id++;
        $now = time();
        $post['n'] = 1; $post['created'] = $now;
        $t = ['id' => $id, 'c' => $c, 'title' => $title, 'pinned' => false, 'created' => $now, 'posts' => [$post], 'next' => 2];
        fm_write_json(fm_thread_path($id), $t);
        $index['seq'] = $id;
        $index['threads'][(string)$id] = fm_summary($t);
        fm_write_json(fm_index_path(), $index);
        return $id;
    });
}

/** Returns the new post number, or an error string. */
function fm_add_reply(int $id, array $post) {
    return fm_locked(true, function () use ($id, $post) {
        $t = fm_read_json(fm_thread_path($id), null);
        if (!$t) return 'That discussion no longer exists.';
        if (count($t['posts']) >= FM_MAX_POSTS_PER_THREAD) return 'This discussion is full. Please start a new one.';
        $n = (int)($t['next'] ?? count($t['posts']) + 1);
        $post['n'] = $n; $post['created'] = time();
        $t['posts'][] = $post;
        $t['next'] = $n + 1;
        fm_write_json(fm_thread_path($id), $t);
        $index = fm_read_json(fm_index_path(), ['seq' => 0, 'threads' => []]);
        $index['threads'][(string)$id] = fm_summary($t);
        fm_write_json(fm_index_path(), $index);
        return $n;
    });
}

/** Staff moderation. $op: pin, unpin, delete_thread, delete_post. Returns null or an error string. */
function fm_moderate(int $id, string $op, int $n) {
    return fm_locked(true, function () use ($id, $op, $n) {
        $t = fm_read_json(fm_thread_path($id), null);
        if (!$t) return 'That discussion no longer exists.';
        $index = fm_read_json(fm_index_path(), ['seq' => 0, 'threads' => []]);
        if ($op === 'delete_thread') {
            unset($index['threads'][(string)$id]);
            fm_write_json(fm_index_path(), $index);
            @unlink(fm_thread_path($id));
            return null;
        }
        if ($op === 'pin' || $op === 'unpin') {
            $t['pinned'] = $op === 'pin';
        } elseif ($op === 'delete_post') {
            if ($n <= 1) return 'Delete the whole discussion to remove its first post.';
            $found = false;
            foreach ($t['posts'] as &$p) {
                if ((int)$p['n'] === $n) { $p = ['n' => $n, 'created' => $p['created'], 'removed' => true, 'name' => '', 'company' => '', 'staff' => false, 'body' => '']; $found = true; }
            }
            unset($p);
            if (!$found) return 'That post was not found.';
        } else {
            return 'Unknown action.';
        }
        fm_write_json(fm_thread_path($id), $t);
        $index['threads'][(string)$id] = fm_summary($t);
        fm_write_json(fm_index_path(), $index);
        return null;
    });
}

/* ---------- safety ---------- */

function fm_client_hash(string $bucket): string {
    return substr(hash_hmac('sha256', $bucket . '|ip|' . ($_SERVER['REMOTE_ADDR'] ?? ''), fm_secret()), 0, 32);
}

/** Per hashed IP and bucket ('post' or 'code' for failed team codes): returns false when over the
 * limit, and records one attempt when $record and under it. */
function fm_rate_ok(string $bucket, bool $record = true): bool {
    $key = fm_client_hash($bucket);
    return fm_locked(true, function () use ($key, $record) {
        $path = fm_data_dir() . '/ratelimit.json';
        $now = time();
        $all = fm_read_json($path, []);
        foreach ($all as $k => $times) {
            $all[$k] = array_values(array_filter((array)$times, fn($ts) => $ts > $now - FM_RATE_WINDOW));
            if (!$all[$k]) unset($all[$k]);
        }
        $mine = $all[$key] ?? [];
        $ok = count($mine) < FM_RATE_POSTS;
        if ($ok && $record) { $mine[] = $now; $all[$key] = $mine; }
        fm_write_json($path, (object)$all);
        return $ok;
    });
}

function fm_csrf_token(): string {
    $ts = (string)time();
    return $ts . '.' . hash_hmac('sha256', 'csrf|' . $ts, fm_secret());
}

function fm_csrf_check(string $token): ?string {
    $parts = explode('.', $token, 2);
    if (count($parts) !== 2 || !ctype_digit($parts[0])) return 'Your form expired. Please try again.';
    if (!hash_equals(hash_hmac('sha256', 'csrf|' . $parts[0], fm_secret()), $parts[1])) return 'Your form expired. Please try again.';
    $age = time() - (int)$parts[0];
    if ($age > FM_CSRF_TTL) return 'Your form expired. Please reload the page and try again.';
    if ($age < FM_CSRF_MIN_AGE) return 'That was fast! Please wait a moment and submit again.';
    return null;
}

function fm_staff_hash(): ?string {
    $data = fm_read_json(fm_data_dir() . '/staff.json', []);
    return isset($data['hash']) && is_string($data['hash']) && $data['hash'] !== '' ? $data['hash'] : null;
}

function fm_staff_ok(string $code): bool {
    $hash = fm_staff_hash();
    return $hash !== null && $code !== '' && password_verify($code, $hash);
}

/* ---------- text ---------- */

function fm_len(string $s): int {
    if (function_exists('mb_strlen')) return mb_strlen($s, 'UTF-8');
    $n = iconv_strlen($s, 'UTF-8');
    return $n === false ? strlen($s) : $n;
}

function fm_substr(string $s, int $start, int $len): string {
    if (function_exists('mb_substr')) return mb_substr($s, $start, $len, 'UTF-8');
    $r = iconv_substr($s, $start, $len, 'UTF-8');
    return $r === false ? '' : $r;
}

/** Valid UTF-8, no control characters (except newlines/tabs when $multiline), trimmed. */
function fm_clean($v, bool $multiline = false): string {
    $s = is_string($v) ? $v : '';
    if (!preg_match('//u', $s)) return '';
    $s = str_replace(["\r\n", "\r"], "\n", $s);
    $s = $multiline ? preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $s) : preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $s);
    $s = trim((string)$s);
    if ($multiline) $s = preg_replace("/\n{4,}/", "\n\n\n", $s);
    else $s = preg_replace('/\s{2,}/u', ' ', $s);
    return (string)$s;
}

function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8'); }

/** Plain text to HTML: escaped, URLs linked (nofollow ugc noopener), paragraphs and line breaks kept. */
function fm_format(string $body): string {
    $out = [];
    foreach (preg_split("/\n{2,}/", $body) as $para) {
        $html = h($para);
        $html = preg_replace_callback('~\bhttps?://[^\s<>"\']+~i', function ($m) {
            $url = $m[0]; $tail = '';
            while ($url !== '' && preg_match('~[.,;:!?)\]]$~', $url)) { $tail = substr($url, -1) . $tail; $url = substr($url, 0, -1); }
            if (preg_match('~&(?:amp|quot|lt|gt|apos|#0?39);$~', $url, $mm)) { $tail = $mm[0] . $tail; $url = substr($url, 0, -strlen($mm[0])); }
            $label = strlen($url) > 70 ? substr($url, 0, 60) . '…' : $url;
            return '<a href="' . $url . '" rel="nofollow ugc noopener" target="_blank">' . $label . '</a>' . $tail;
        }, $html);
        $out[] = '<p>' . nl2br($html, false) . '</p>';
    }
    return implode("\n", $out);
}

function fm_initials(string $name): string {
    $words = preg_split('/\s+/u', trim($name), -1, PREG_SPLIT_NO_EMPTY) ?: ['?'];
    $first = fm_substr($words[0], 0, 1);
    $second = count($words) > 1 ? fm_substr($words[count($words) - 1], 0, 1) : '';
    $i = $first . $second;
    return function_exists('mb_strtoupper') ? mb_strtoupper($i, 'UTF-8') : strtoupper($i);
}

function fm_avatar_hue(string $name): int { return hexdec(substr(md5(strtolower($name)), 0, 4)) % 360; }

function fm_ago(int $ts): string {
    $d = max(0, time() - $ts);
    if ($d < 60) return 'just now';
    if ($d < 3600) return floor($d / 60) . 'm ago';
    if ($d < 86400) return floor($d / 3600) . 'h ago';
    if ($d < 86400 * 7) return floor($d / 86400) . 'd ago';
    return date('M j, Y', $ts);
}

function fm_time(int $ts): string {
    return '<time datetime="' . gmdate('c', $ts) . '" title="' . h(gmdate('M j, Y g:i A', $ts) . ' UTC') . '">' . h(fm_ago($ts)) . '</time>';
}
