<?php
/* FirstMate community forum. One script, routed by query string so assets stay at depth 1:
 *   ?            home: categories with counts, latest discussions, search
 *   ?c=<slug>    a category          ?t=<id>   a discussion with its replies
 *   ?new=1[&c=]  start a discussion  ?q=<text> search
 * POST action=thread | reply | mod (staff pin, unpin, delete post, delete discussion). */

define('FM_FORUM', 1);
require __DIR__ . '/lib.php';

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-cache, private');

$CATS = fm_categories();
$errors = [];
$old = [];

try {
    fm_data_dir();
    fm_ensure_seeded();
} catch (Throwable $e) {
    http_response_code(503);
    echo '<!doctype html><meta charset="utf-8"><title>Forum unavailable</title><p>The forum is temporarily unavailable.</p>';
    exit;
}

function fm_redirect(string $qs, string $hash = ''): void {
    header('Location: ./' . ($qs !== '' ? '?' . $qs : '') . $hash, true, 303);
    exit;
}

/* ---------- POST ---------- */

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $action = (string)($_POST['action'] ?? '');
    $old = [
        'c' => fm_clean($_POST['c'] ?? ''), 'title' => fm_clean($_POST['title'] ?? ''), 'body' => fm_clean($_POST['body'] ?? '', true),
        'name' => fm_clean($_POST['name'] ?? ''), 'company' => fm_clean($_POST['company'] ?? ''), 't' => (int)($_POST['t'] ?? 0),
    ];
    $code = is_string($_POST['code'] ?? null) ? substr($_POST['code'], 0, 200) : '';

    // Honeypot: real people never see or fill the "website" field. Pretend it worked.
    if (trim((string)($_POST['website'] ?? '')) !== '') fm_redirect($old['t'] ? 't=' . $old['t'] : '');

    if ($err = fm_csrf_check((string)($_POST['csrf'] ?? ''))) $errors[] = $err;

    $staff = false;
    if (!$errors && $code !== '') {
        if (!fm_rate_ok('code', false)) $errors[] = 'Too many team code attempts. Please wait a few minutes and try again.';
        elseif (fm_staff_ok($code)) $staff = true;
        else { fm_rate_ok('code', true); $errors[] = 'That team code did not match.'; }
    }

    if ($action === 'mod') {
        if (!$errors && !$staff) $errors[] = 'Enter the team code to moderate.';
        $op = (string)($_POST['op'] ?? '');
        $n = 0;
        if (preg_match('/^delete_post:(\d+)$/', $op, $m)) { $op = 'delete_post'; $n = (int)$m[1]; }
        if (!$errors) {
            $err = fm_moderate($old['t'], $op, $n);
            if ($err) $errors[] = $err;
            elseif ($op === 'delete_thread') fm_redirect('deleted=1');
            else fm_redirect('t=' . $old['t'] . '&done=' . rawurlencode($op), $n ? '#p' . ($n - 1) : '');
        }
        $_GET = ['t' => (string)$old['t']];
    } elseif ($action === 'thread' || $action === 'reply') {
        if (!$staff && $old['name'] === '') $errors[] = 'Add a display name.';
        if (fm_len($old['name']) > FM_NAME_MAX) $errors[] = 'Your display name can be at most ' . FM_NAME_MAX . ' characters.';
        if (fm_len($old['company']) > FM_COMPANY_MAX) $errors[] = 'Company or trade can be at most ' . FM_COMPANY_MAX . ' characters.';
        if ($old['body'] === '') $errors[] = 'Write a message.';
        if (fm_len($old['body']) > FM_BODY_MAX) $errors[] = 'Messages can be at most ' . number_format(FM_BODY_MAX) . ' characters.';
        if ($action === 'thread') {
            if (!isset($CATS[$old['c']])) $errors[] = 'Choose a category.';
            if ($old['title'] === '') $errors[] = 'Add a title.';
            if (fm_len($old['title']) > FM_TITLE_MAX) $errors[] = 'Titles can be at most ' . FM_TITLE_MAX . ' characters.';
        } elseif (!fm_thread($old['t'])) {
            $errors[] = 'That discussion no longer exists.';
        }
        if (!$errors && !$staff && !fm_rate_ok('post', true)) $errors[] = 'You are posting quickly. Please wait a few minutes before posting again.';
        if (!$errors) {
            $post = ['name' => $old['name'] !== '' ? $old['name'] : 'FirstMate Team', 'company' => $old['company'], 'staff' => $staff, 'body' => $old['body']];
            if ($action === 'thread') {
                $id = fm_create_thread($old['c'], $old['title'], $post);
                fm_redirect('t=' . $id, '#p0');
            }
            $n = fm_add_reply($old['t'], $post);
            if (is_string($n)) $errors[] = $n;
            else fm_redirect('t=' . $old['t'], '#p' . ($n - 1));
        }
        $_GET = $action === 'thread' ? ['new' => '1', 'c' => $old['c']] : ['t' => (string)$old['t']];
    } else {
        $errors[] = 'Unknown action.';
    }
    http_response_code(422);
}

/* ---------- view helpers ---------- */

function fm_old(string $k, string $default = ''): string { global $old; return h($old[$k] ?? $default); }

function fm_avatar(string $name, bool $staff, string $size = ''): string {
    if ($staff) return '<span class="fmf-av fmf-av--staff ' . $size . '" aria-hidden="true"><i class="fa-solid fa-anchor"></i></span>';
    return '<span class="fmf-av ' . $size . '" style="--hue:' . fm_avatar_hue($name) . '" aria-hidden="true">' . h(fm_initials($name)) . '</span>';
}

function fm_badge(): string { return '<span class="fmf-badge"><i class="fa-solid fa-circle-check"></i> FirstMate Team</span>'; }

function fm_row(array $t, bool $showCat = true): string {
    global $CATS;
    $cat = $CATS[$t['c']] ?? ['General', '', 'fa-comments'];
    $html = '<a class="fmf-row" href="?t=' . (int)$t['id'] . '">' . fm_avatar($t['name'], $t['staff']) .
        '<div class="fmf-row-main"><div class="fmf-row-title">' .
        ($t['pinned'] ? '<span class="fmf-pin" title="Pinned"><i class="fa-solid fa-thumbtack"></i></span>' : '') . h($t['title']) . '</div>' .
        '<div class="fmf-row-meta"><span>' . h($t['name']) . '</span>' . ($t['staff'] ? fm_badge() : '') .
        ($t['company'] !== '' ? '<span class="fmf-dot">' . h($t['company']) . '</span>' : '') .
        ($showCat ? '<span class="fmf-cat"><i class="fa-solid ' . h($cat[2]) . '"></i> ' . h($cat[0]) . '</span>' : '') . '</div></div>' .
        '<div class="fmf-row-stat"><b>' . (int)$t['replies'] . '</b><span>' . ($t['replies'] === 1 ? 'reply' : 'replies') . '</span></div>' .
        '<div class="fmf-row-last"><span>' . fm_time((int)$t['last']) . '</span><small>' . h($t['last_name']) . '</small></div></a>';
    return $html;
}

function fm_empty(string $title, string $text, string $cta = ''): string {
    return '<div class="fmf-empty"><i class="fa-solid fa-comments"></i><h3>' . h($title) . '</h3><p>' . h($text) . '</p>' . $cta . '</div>';
}

function fm_errors(): string {
    global $errors;
    if (!$errors) return '';
    $li = implode('', array_map(fn($e) => '<li>' . h($e) . '</li>', $errors));
    return '<div class="fmf-alert" role="alert"><i class="fa-solid fa-circle-exclamation"></i><ul>' . $li . '</ul></div>';
}

/** Name, company, honeypot, team code and CSRF: shared by both composers. */
function fm_identity_fields(): string {
    return '<div class="fmf-two"><div class="field"><label for="fmf-name">Display name</label>' .
        '<input id="fmf-name" name="name" maxlength="' . FM_NAME_MAX . '" autocomplete="nickname" data-remember="name" value="' . fm_old('name') . '" placeholder="e.g. Sam R."></div>' .
        '<div class="field"><label for="fmf-company">Company or trade <span class="fmf-opt">optional</span></label>' .
        '<input id="fmf-company" name="company" maxlength="' . FM_COMPANY_MAX . '" autocomplete="organization" data-remember="company" value="' . fm_old('company') . '" placeholder="e.g. Roofing, Ridgeway Exteriors"></div></div>' .
        '<div class="fmf-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>' .
        '<input type="hidden" name="csrf" value="' . h(fm_csrf_token()) . '">' .
        '<details class="fmf-team"><summary>FirstMate team member?</summary><div class="field"><label for="fmf-code">Team code</label>' .
        '<input id="fmf-code" name="code" type="password" autocomplete="off" maxlength="200"><small class="muted">Posts with a valid code show the FirstMate Team badge.</small></div></details>';
}

function fm_cat_nav(?string $active): string {
    global $CATS, $INDEX;
    $counts = array_fill_keys(array_keys($CATS), 0);
    foreach ($INDEX['threads'] as $t) if (isset($counts[$t['c']])) $counts[$t['c']]++;
    $html = '<nav class="fmf-catnav" aria-label="Categories"><a href="./"' . ($active === '' ? ' class="is-active"' : '') . '><i class="fa-solid fa-house"></i><span>All discussions</span><b>' . count($INDEX['threads']) . '</b></a>';
    foreach ($CATS as $slug => $c) {
        $html .= '<a href="?c=' . h($slug) . '"' . ($active === $slug ? ' class="is-active"' : '') . '><i class="fa-solid ' . h($c[2]) . '"></i><span>' . h($c[0]) . '</span><b>' . $counts[$slug] . '</b></a>';
    }
    return $html . '</nav>';
}

function fm_aside(?string $active, string $newCat = ''): string {
    return '<aside class="fmf-aside"><a class="btn btn-primary fmf-new" href="?new=1' . ($newCat !== '' ? '&amp;c=' . h($newCat) : '') . '"><i class="fa-solid fa-pen"></i> Start a discussion</a>' .
        fm_cat_nav($active) .
        '<div class="fmf-note"><h4>Forum guidelines</h4><ul><li>Be kind and keep it about the work.</li><li>No spam or customer details.</li><li>Replies with the red badge are from the FirstMate team.</li></ul></div></aside>';
}

function fm_search_form(string $q = '', string $cls = ''): string {
    return '<form class="fmf-search ' . $cls . '" action="./" method="get" role="search"><i class="fa-solid fa-magnifying-glass"></i>' .
        '<input name="q" type="search" maxlength="' . FM_QUERY_MAX . '" placeholder="Search discussions" value="' . h($q) . '" aria-label="Search discussions"><button class="btn btn-primary btn-sm" type="submit">Search</button></form>';
}

/* ---------- routing ---------- */

$INDEX = fm_index();
$view = 'home';
$title = 'Community Forum';
$q = isset($_GET['q']) ? fm_substr(fm_clean($_GET['q']), 0, FM_QUERY_MAX) : null;
$c = isset($_GET['c']) && is_string($_GET['c']) ? $_GET['c'] : '';
$thread = null;

if (isset($_GET['t'])) {
    $thread = fm_thread((int)$_GET['t']);
    $view = $thread ? 'thread' : 'missing';
    $title = $thread ? $thread['title'] : 'Discussion not found';
} elseif (isset($_GET['new'])) {
    $view = 'new'; $title = 'Start a discussion';
} elseif ($q !== null) {
    $view = 'search'; $title = $q === '' ? 'Search' : 'Search: ' . $q;
} elseif ($c !== '') {
    if (isset($CATS[$c])) { $view = 'category'; $title = $CATS[$c][0]; } else { $view = 'missing'; $title = 'Category not found'; }
}
if ($view === 'missing' && !$errors) http_response_code(404);

ob_start();

/* ---------- views ---------- */

if ($view === 'home') {
    $counts = [];
    foreach ($CATS as $slug => $_) $counts[$slug] = ['threads' => 0, 'posts' => 0, 'last' => null];
    foreach ($INDEX['threads'] as $t) {
        if (!isset($counts[$t['c']])) continue;
        $counts[$t['c']]['threads']++;
        $counts[$t['c']]['posts'] += 1 + $t['replies'];
        if (!$counts[$t['c']]['last'] || $t['last'] > $counts[$t['c']]['last']['last']) $counts[$t['c']]['last'] = $t;
    }
    $totalPosts = array_sum(array_column($counts, 'posts'));
    $sorted = fm_sorted($INDEX['threads']);
    ?>
  <section class="page-hero fmf-hero">
    <div class="container">
      <div class="breadcrumb"><a href="~/resources/">Resources</a><span>Forum</span></div>
      <div class="eyebrow">Community</div>
      <h1>The FirstMate <span class="text-gradient">Forum</span>.</h1>
      <p class="lead">Contractors talking shop: measurements, proposals, scheduling, payments and everything in between. The FirstMate team reads every thread and replies.</p>
      <?= fm_search_form('', 'fmf-search--hero') ?>
      <div class="fmf-hero-stats"><span><b><?= count($INDEX['threads']) ?></b> discussions</span><span><b><?= $totalPosts ?></b> posts</span><span><b><?= count($CATS) ?></b> categories</span><span class="fmf-live"><span class="pulse-dot"></span> No login needed to post</span></div>
    </div>
  </section>
  <section class="section section--tight">
    <div class="container fmf-layout">
      <div class="fmf-main">
        <?php if (isset($_GET['deleted'])): ?><div class="fmf-flash"><i class="fa-solid fa-check"></i> The discussion was deleted.</div><?php endif; ?>
        <div class="fmf-head"><h2>Categories</h2></div>
        <div class="fmf-cats">
          <?php foreach ($CATS as $slug => $cat): $ct = $counts[$slug]; ?>
          <a class="fmf-catcard reveal" href="?c=<?= h($slug) ?>">
            <span class="fmf-caticon"><i class="fa-solid <?= h($cat[2]) ?>"></i></span>
            <span class="fmf-catbody"><strong><?= h($cat[0]) ?></strong><span><?= h($cat[1]) ?></span>
              <small><?= $ct['threads'] ?> <?= $ct['threads'] === 1 ? 'discussion' : 'discussions' ?> · <?= $ct['posts'] ?> <?= $ct['posts'] === 1 ? 'post' : 'posts' ?><?= $ct['last'] ? ' · active ' . h(fm_ago((int)$ct['last']['last'])) : '' ?></small></span>
          </a>
          <?php endforeach; ?>
        </div>
        <div class="fmf-head"><h2>Latest discussions</h2><a class="link-arrow" href="?new=1">Start one</a></div>
        <div class="fmf-list">
          <?php if (!$sorted): echo fm_empty('No discussions yet', 'Be the first to start one.'); endif; ?>
          <?php foreach (array_slice($sorted, 0, 20) as $t) echo fm_row($t); ?>
        </div>
      </div>
      <?= fm_aside('') ?>
    </div>
  </section>
    <?php
} elseif ($view === 'category') {
    $cat = $CATS[$c];
    $list = fm_sorted(array_filter($INDEX['threads'], fn($t) => $t['c'] === $c));
    $per = 30;
    $pages = max(1, (int)ceil(count($list) / $per));
    $page = min($pages, max(1, (int)($_GET['page'] ?? 1)));
    ?>
  <section class="page-hero fmf-hero fmf-hero--sm">
    <div class="container">
      <div class="breadcrumb"><a href="./">Forum</a><span><?= h($cat[0]) ?></span></div>
      <div class="fmf-hero-row">
        <span class="fmf-caticon fmf-caticon--lg"><i class="fa-solid <?= h($cat[2]) ?>"></i></span>
        <div><h1><?= h($cat[0]) ?></h1><p class="lead"><?= h($cat[1]) ?></p></div>
      </div>
      <?= fm_search_form() ?>
    </div>
  </section>
  <section class="section section--tight">
    <div class="container fmf-layout">
      <div class="fmf-main">
        <div class="fmf-head"><h2><?= count($list) ?> <?= count($list) === 1 ? 'discussion' : 'discussions' ?></h2><a class="btn btn-outline btn-sm" href="?new=1&amp;c=<?= h($c) ?>"><i class="fa-solid fa-pen"></i> New in this category</a></div>
        <div class="fmf-list">
          <?php if (!$list) echo fm_empty('Nothing here yet', 'Start the first discussion in ' . $cat[0] . '.', '<a class="btn btn-primary btn-sm" href="?new=1&amp;c=' . h($c) . '">Start a discussion</a>'); ?>
          <?php foreach (array_slice($list, ($page - 1) * $per, $per) as $t) echo fm_row($t, false); ?>
        </div>
        <?php if ($pages > 1): ?><nav class="fmf-pages" aria-label="Pages">
          <?php for ($i = 1; $i <= $pages; $i++): ?><a href="?c=<?= h($c) ?>&amp;page=<?= $i ?>"<?= $i === $page ? ' class="is-active" aria-current="page"' : '' ?>><?= $i ?></a><?php endfor; ?>
        </nav><?php endif; ?>
      </div>
      <?= fm_aside($c, $c) ?>
    </div>
  </section>
    <?php
} elseif ($view === 'search') {
    $results = [];
    if ($q !== '') {
        $needle = function_exists('mb_strtolower') ? mb_strtolower($q, 'UTF-8') : strtolower($q);
        $lower = fn($s) => function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
        // Full scan of thread files; fine at forum scale (see docs/optimization-backlog.md).
        foreach (fm_sorted($INDEX['threads'], false) as $t) {
            $hit = null;
            if (strpos($lower($t['title']), $needle) !== false) $hit = $t['excerpt'];
            $full = fm_thread((int)$t['id']);
            if ($full) foreach ($full['posts'] as $p) {
                if (!empty($p['removed'])) continue;
                $pos = strpos($lower($p['body']), $needle);
                if ($pos !== false) {
                    $pre = substr($p['body'], 0, $pos);
                    $start = max(0, fm_len($pre) - 60);
                    $hit = ($start > 0 ? '…' : '') . fm_substr(preg_replace('/\s+/u', ' ', fm_substr($p['body'], $start, 220)), 0, 220);
                    break;
                }
            }
            if ($hit !== null) $results[] = [$t, $hit];
            if (count($results) >= 50) break;
        }
    }
    $mark = function (string $text) use ($q) {
        $html = h($text);
        return $q === '' ? $html : preg_replace('/(' . preg_quote(h($q), '/') . ')/iu', '<mark>$1</mark>', $html);
    };
    ?>
  <section class="page-hero fmf-hero fmf-hero--sm">
    <div class="container">
      <div class="breadcrumb"><a href="./">Forum</a><span>Search</span></div>
      <h1>Search the forum</h1>
      <?= fm_search_form($q, 'fmf-search--hero') ?>
    </div>
  </section>
  <section class="section section--tight">
    <div class="container fmf-layout">
      <div class="fmf-main">
        <?php if ($q === ''): ?>
          <?= fm_empty('Type something to search', 'Search titles and every post.') ?>
        <?php else: ?>
          <div class="fmf-head"><h2><?= count($results) ?> <?= count($results) === 1 ? 'result' : 'results' ?> for “<?= h($q) ?>”</h2></div>
          <div class="fmf-list">
            <?php if (!$results) echo fm_empty('No matches', 'Try fewer words, or start a discussion and ask.', '<a class="btn btn-primary btn-sm" href="?new=1">Start a discussion</a>'); ?>
            <?php foreach ($results as [$t, $hit]): ?>
              <div class="fmf-result"><?= fm_row($t) ?><p class="fmf-snippet"><?= $mark($hit) ?></p></div>
            <?php endforeach; ?>
          </div>
        <?php endif; ?>
      </div>
      <?= fm_aside(null) ?>
    </div>
  </section>
    <?php
} elseif ($view === 'new') {
    $sel = $old['c'] ?? (is_string($_GET['c'] ?? null) ? $_GET['c'] : '');
    ?>
  <section class="page-hero fmf-hero fmf-hero--sm">
    <div class="container">
      <div class="breadcrumb"><a href="./">Forum</a><?php if (isset($CATS[$sel])): ?><a href="?c=<?= h($sel) ?>"><?= h($CATS[$sel][0]) ?></a><?php endif; ?><span>New discussion</span></div>
      <h1>Start a discussion</h1>
      <p class="lead">Ask a question, share a tip or show a finished job. No account needed.</p>
    </div>
  </section>
  <section class="section section--tight">
    <div class="container fmf-layout">
      <div class="fmf-main">
        <form class="fmf-composer" method="post" action="./" data-fmf-form>
          <?= fm_errors() ?>
          <input type="hidden" name="action" value="thread">
          <div class="field"><label for="fmf-c">Category</label>
            <select id="fmf-c" name="c" required><option value="">Choose a category</option>
              <?php foreach ($CATS as $slug => $cat): ?><option value="<?= h($slug) ?>"<?= $sel === $slug ? ' selected' : '' ?>><?= h($cat[0]) ?></option><?php endforeach; ?>
            </select></div>
          <div class="field"><label for="fmf-title">Title</label>
            <input id="fmf-title" name="title" required maxlength="<?= FM_TITLE_MAX ?>" value="<?= fm_old('title') ?>" placeholder="What do you want to talk about?" data-count-max="<?= FM_TITLE_MAX ?>"></div>
          <div class="field"><label for="fmf-body">Message</label>
            <textarea id="fmf-body" name="body" required rows="9" maxlength="<?= FM_BODY_MAX ?>" placeholder="Give other contractors the details. Links are fine; formatting is plain text." data-count-max="<?= FM_BODY_MAX ?>"><?= fm_old('body') ?></textarea></div>
          <?= fm_identity_fields() ?>
          <div class="fmf-actions"><a class="btn btn-ghost" href="<?= isset($CATS[$sel]) ? '?c=' . h($sel) : './' ?>">Cancel</a><button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane"></i> Post discussion</button></div>
        </form>
      </div>
      <?= fm_aside(isset($CATS[$sel]) ? $sel : null) ?>
    </div>
  </section>
    <?php
} elseif ($view === 'thread') {
    $cat = $CATS[$thread['c']] ?? ['General discussion', '', 'fa-comments'];
    $live = array_filter($thread['posts'], fn($p) => empty($p['removed']));
    $people = count(array_unique(array_map(fn($p) => $p['name'], $live)));
    $done = ['pin' => 'Pinned.', 'unpin' => 'Unpinned.', 'delete_post' => 'The post was removed.'][$_GET['done'] ?? ''] ?? null;
    ?>
  <section class="page-hero fmf-hero fmf-hero--sm fmf-hero--thread">
    <div class="container">
      <div class="breadcrumb"><a href="./">Forum</a><a href="?c=<?= h($thread['c']) ?>"><?= h($cat[0]) ?></a><span>Discussion</span></div>
      <h1 class="fmf-thread-title"><?php if (!empty($thread['pinned'])): ?><span class="fmf-pin" title="Pinned"><i class="fa-solid fa-thumbtack"></i></span><?php endif; ?><?= h($thread['title']) ?></h1>
      <div class="fmf-thread-meta"><a class="pill" href="?c=<?= h($thread['c']) ?>"><i class="fa-solid <?= h($cat[2]) ?>"></i> <?= h($cat[0]) ?></a><span><i class="fa-regular fa-comment"></i> <?= max(0, count($live) - 1) ?> replies</span><span><i class="fa-solid fa-user-group"></i> <?= $people ?> <?= $people === 1 ? 'person' : 'people' ?></span><span><i class="fa-regular fa-clock"></i> Started <?= fm_time((int)$thread['created']) ?></span></div>
    </div>
  </section>
  <section class="section section--tight">
    <div class="container fmf-layout fmf-layout--thread">
      <div class="fmf-main">
        <?php if ($done): ?><div class="fmf-flash"><i class="fa-solid fa-check"></i> <?= h($done) ?></div><?php endif; ?>
        <?php if (($_POST['action'] ?? '') === 'mod') echo fm_errors(); ?>
        <div class="fmf-posts">
        <?php foreach ($thread['posts'] as $i => $p): ?>
          <?php if (!empty($p['removed'])): ?>
            <article class="fmf-post fmf-post--removed" id="p<?= $i ?>"><i class="fa-solid fa-eye-slash"></i> This post was removed by the FirstMate team.</article>
          <?php else: ?>
            <article class="fmf-post<?= !empty($p['staff']) ? ' fmf-post--staff' : '' ?><?= $i === 0 ? ' fmf-post--op' : '' ?>" id="p<?= $i ?>">
              <header class="fmf-post-head">
                <?= fm_avatar($p['name'], !empty($p['staff']), 'fmf-av--lg') ?>
                <div class="fmf-post-who"><div><strong><?= h($p['name']) ?></strong><?= !empty($p['staff']) ? fm_badge() : '' ?><?= $i === 0 ? '<span class="fmf-op">Author</span>' : '' ?></div>
                  <small><?= $p['company'] !== '' ? h($p['company']) . ' · ' : '' ?><?= fm_time((int)$p['created']) ?></small></div>
                <a class="fmf-permalink" href="?t=<?= (int)$thread['id'] ?>#p<?= $i ?>" aria-label="Link to this post">#<?= $i + 1 ?></a>
              </header>
              <div class="fmf-body"><?= fm_format($p['body']) ?></div>
              <div class="fmf-modbar">
                <?php if ($i === 0): ?>
                  <button class="btn btn-ghost btn-sm" form="fmf-mod" name="op" value="<?= !empty($thread['pinned']) ? 'unpin' : 'pin' ?>"><i class="fa-solid fa-thumbtack"></i> <?= !empty($thread['pinned']) ? 'Unpin' : 'Pin' ?> discussion</button>
                  <button class="btn btn-ghost btn-sm fmf-danger" form="fmf-mod" name="op" value="delete_thread" data-confirm="Delete this whole discussion? This cannot be undone."><i class="fa-solid fa-trash"></i> Delete discussion</button>
                <?php else: ?>
                  <button class="btn btn-ghost btn-sm fmf-danger" form="fmf-mod" name="op" value="delete_post:<?= (int)$p['n'] ?>" data-confirm="Remove this post?"><i class="fa-solid fa-trash"></i> Remove post</button>
                <?php endif; ?>
              </div>
            </article>
          <?php endif; ?>
        <?php endforeach; ?>
        </div>

        <form class="fmf-composer fmf-reply" id="reply" method="post" action="./" data-fmf-form>
          <h3><i class="fa-solid fa-reply"></i> Add a reply</h3>
          <?php if (($_POST['action'] ?? '') !== 'mod') echo fm_errors(); ?>
          <input type="hidden" name="action" value="reply">
          <input type="hidden" name="t" value="<?= (int)$thread['id'] ?>">
          <div class="field"><label for="fmf-body" class="fmf-sr">Your reply</label>
            <textarea id="fmf-body" name="body" required rows="6" maxlength="<?= FM_BODY_MAX ?>" placeholder="Share what has worked for you…" data-count-max="<?= FM_BODY_MAX ?>"><?= fm_old('body') ?></textarea></div>
          <?= fm_identity_fields() ?>
          <div class="fmf-actions"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane"></i> Post reply</button></div>
        </form>

        <details class="fmf-modpanel" id="fmf-modpanel"<?= ($_POST['action'] ?? '') === 'mod' ? ' open' : '' ?>>
          <summary><i class="fa-solid fa-shield-halved"></i> Team tools</summary>
          <form id="fmf-mod" method="post" action="./">
            <input type="hidden" name="action" value="mod">
            <input type="hidden" name="t" value="<?= (int)$thread['id'] ?>">
            <input type="hidden" name="csrf" value="<?= h(fm_csrf_token()) ?>">
            <div class="field"><label for="fmf-modcode">Team code</label><input id="fmf-modcode" name="code" type="password" autocomplete="off" required maxlength="200"></div>
            <p class="muted">With the panel open, pin, remove and delete buttons appear on each post.</p>
          </form>
        </details>
      </div>
      <?= fm_aside($thread['c'], $thread['c']) ?>
    </div>
  </section>
    <?php
} else {
    ?>
  <section class="page-hero fmf-hero fmf-hero--sm">
    <div class="container">
      <div class="breadcrumb"><a href="./">Forum</a><span>Not found</span></div>
      <h1><?= h($title) ?></h1>
      <p class="lead">It may have been removed, or the link is wrong.</p>
      <div class="btn-row"><a class="btn btn-primary" href="./">Back to the forum</a></div>
    </div>
  </section>
    <?php
}

$content = ob_get_clean();
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= h($title) ?> — FirstMate Forum</title>
<meta name="description" content="The FirstMate community forum: contractors talking about measurements, sales, production and payments, with replies from the FirstMate team.">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/site.css">
<style>
.fmf-hero { padding-bottom: clamp(32px, 5vw, 56px) }
.fmf-hero h1 { font-size: clamp(36px, 5vw, 60px) }
.fmf-hero--sm h1 { font-size: clamp(30px, 4vw, 46px); margin-bottom: .3em }
.fmf-hero--thread h1 { max-width: 900px; overflow-wrap: anywhere }
.breadcrumb a + a::before { content: "/"; margin-right: 8px; opacity: .5 }
.fmf-hero-row { display: flex; gap: 18px; align-items: center }
.fmf-hero-row .lead { margin: 0 }
.fmf-hero-stats { display: flex; flex-wrap: wrap; gap: 10px 26px; margin-top: 22px; font-size: 14px; font-weight: 600; color: var(--muted) }
.fmf-hero-stats b { color: var(--heading); font-weight: 800 }
.fmf-live { display: inline-flex; align-items: center; gap: 8px }

.fmf-search { display: flex; align-items: center; gap: 8px; max-width: 620px; margin-top: 24px; background: #fff; border: 1.5px solid var(--line); border-radius: 999px; padding: 6px 6px 6px 18px; box-shadow: var(--shadow-sm); transition: border-color .2s, box-shadow .2s }
.fmf-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 4px rgba(219, 0, 0, .1) }
.fmf-search i { color: var(--muted) }
.fmf-search input { flex: 1; min-width: 0; border: 0; outline: 0; font: inherit; font-size: 16px; font-weight: 500; background: transparent; color: var(--ink); padding: 8px 4px }
.fmf-search--hero { padding: 8px 8px 8px 22px }

.fmf-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; align-items: start }
.fmf-main { min-width: 0 }
.fmf-aside { position: sticky; top: calc(var(--header-h) + 20px); display: flex; flex-direction: column; gap: 18px }
.fmf-new { justify-content: center; width: 100% }
.fmf-catnav { display: flex; flex-direction: column; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 8px }
.fmf-catnav a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: var(--body); font-weight: 600; font-size: 14px; transition: background .2s, color .2s }
.fmf-catnav a i { width: 18px; text-align: center; color: var(--muted) }
.fmf-catnav a span { flex: 1 }
.fmf-catnav a b { font-size: 12px; color: var(--muted); background: var(--bg-soft); border-radius: 999px; padding: 2px 8px }
.fmf-catnav a:hover { background: var(--bg-soft); color: var(--heading) }
.fmf-catnav a.is-active { background: var(--brand-soft); color: var(--brand) }
.fmf-catnav a.is-active i, .fmf-catnav a.is-active b { color: var(--brand) }
.fmf-note { background: var(--bg-soft); border-radius: var(--radius); padding: 18px 20px; font-size: 14px }
.fmf-note h4 { font-size: 15px; margin-bottom: 8px }
.fmf-note ul { margin: 0; padding-left: 18px; color: var(--muted) }
.fmf-note li { margin: 4px 0 }

.fmf-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 16px }
.fmf-head h2 { font-size: clamp(20px, 2.2vw, 26px); margin: 0 }
.fmf-cats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 44px }
.fmf-catcard { display: flex; gap: 14px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); color: inherit; transition: transform .3s var(--ease), box-shadow .3s var(--ease), border-color .3s }
.fmf-catcard:hover { transform: translateY(-3px); box-shadow: var(--shadow); border-color: transparent }
.fmf-caticon { flex: none; width: 44px; height: 44px; border-radius: 13px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; font-size: 18px }
.fmf-caticon--lg { width: 64px; height: 64px; border-radius: 18px; font-size: 26px }
.fmf-catbody { display: flex; flex-direction: column; gap: 3px; min-width: 0 }
.fmf-catbody strong { color: var(--heading); font-weight: 800 }
.fmf-catbody > span { font-size: 14px; color: var(--muted); line-height: 1.45 }
.fmf-catbody small { font-size: 12px; font-weight: 700; color: var(--body); margin-top: 4px }

.fmf-list { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden }
.fmf-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 70px 110px; gap: 16px; align-items: center; padding: 16px 20px; color: inherit; border-top: 1px solid var(--line-soft); transition: background .2s }
.fmf-list > .fmf-row:first-child, .fmf-list > .fmf-result:first-child .fmf-row { border-top: 0 }
.fmf-row:hover { background: #fcfcfd }
.fmf-row:hover .fmf-row-title { color: var(--brand) }
.fmf-row-title { font-weight: 750; color: var(--heading); font-size: 16px; line-height: 1.35; overflow-wrap: anywhere; transition: color .2s }
.fmf-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; font-size: 13px; color: var(--muted); font-weight: 600 }
.fmf-dot::before { content: "·"; margin-right: 10px; opacity: .6 }
.fmf-cat { color: var(--body) }
.fmf-cat i { color: var(--brand); font-size: 11px }
.fmf-row-stat { text-align: center; line-height: 1.1 }
.fmf-row-stat b { display: block; font-size: 18px; font-weight: 800; color: var(--heading) }
.fmf-row-stat span { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em }
.fmf-row-last { text-align: right; font-size: 13px; font-weight: 700; color: var(--body); line-height: 1.3; min-width: 0 }
.fmf-row-last small { display: block; color: var(--muted); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.fmf-pin { color: var(--brand); margin-right: 8px; font-size: .8em; display: inline-block; transform: rotate(30deg) }
.fmf-result { border-top: 1px solid var(--line-soft) }
.fmf-result:first-child { border-top: 0 }
.fmf-result .fmf-row { border-top: 0; padding-bottom: 6px }
.fmf-snippet { margin: 0; padding: 0 20px 16px 76px; font-size: 14px; color: var(--muted); overflow-wrap: anywhere }
.fmf-snippet mark { background: #ffe1e1; color: var(--heading); border-radius: 3px; padding: 0 2px }

.fmf-av { --hue: 0; flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 14px; font-weight: 800; color: hsl(var(--hue) 55% 30%); background: hsl(var(--hue) 70% 92%); letter-spacing: .02em }
.fmf-av--lg { width: 46px; height: 46px; font-size: 16px }
.fmf-av--staff { background: var(--brand); color: #fff; box-shadow: 0 6px 16px rgba(219, 0, 0, .3) }
.fmf-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; background: var(--brand); color: #fff; font-size: 11px; font-weight: 800; letter-spacing: .03em; white-space: nowrap }
.fmf-op { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--bg-soft); border: 1px solid var(--line); font-size: 11px; font-weight: 700; color: var(--muted) }

.fmf-thread-title { display: block }
.fmf-thread-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; font-size: 14px; font-weight: 600; color: var(--muted) }
.fmf-thread-meta i { margin-right: 4px }
.fmf-posts { display: flex; flex-direction: column; gap: 16px; margin-bottom: 28px }
.fmf-post { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px; scroll-margin-top: calc(var(--header-h) + 20px); animation: fmf-in .5s var(--ease) both; animation-delay: calc(var(--i, 0) * 60ms) }
.fmf-post:target { border-color: var(--brand); box-shadow: 0 0 0 4px rgba(219, 0, 0, .08) }
.fmf-post--op { box-shadow: var(--shadow-sm) }
.fmf-post--staff { border-color: #ffc9c9; background: linear-gradient(180deg, #fff6f6, #fff 120px) }
.fmf-post--removed { color: var(--muted); font-size: 14px; font-weight: 600; background: var(--bg-soft); border-style: dashed; padding: 14px 20px }
.fmf-post--removed i { margin-right: 6px }
.fmf-post-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px }
.fmf-post-who { flex: 1; min-width: 0 }
.fmf-post-who > div { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px }
.fmf-post-who strong { color: var(--heading); font-weight: 800; overflow-wrap: anywhere }
.fmf-post-who small { display: block; color: var(--muted); font-size: 13px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere }
.fmf-permalink { color: var(--muted); font-size: 13px; font-weight: 700 }
.fmf-permalink:hover { color: var(--brand) }
.fmf-body { color: var(--body); line-height: 1.65; overflow-wrap: anywhere }
.fmf-body p { margin: 0 0 .9em }
.fmf-body p:last-child { margin-bottom: 0 }
.fmf-body a { color: var(--brand); text-decoration: underline; text-underline-offset: 2px }
.fmf-modbar { display: none; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--line) }
body:has(#fmf-modpanel[open]) .fmf-modbar, body.fmf-modmode .fmf-modbar { display: flex }
.fmf-danger { color: var(--brand) !important }
.fmf-danger:hover { border-color: var(--brand) !important }
@keyframes fmf-in { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }

.fmf-composer { background: #fff; border: 1px solid var(--line); border-radius: var(--radius-lg); padding: clamp(20px, 3vw, 32px); box-shadow: var(--shadow-sm) }
.fmf-composer h3 { font-size: 20px; margin-bottom: 16px }
.fmf-composer h3 i { color: var(--brand); margin-right: 6px }
.fmf-composer textarea { resize: vertical; min-height: 140px; line-height: 1.55 }
.fmf-two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px }
.fmf-opt { font-weight: 600; color: var(--muted); font-size: 12px; margin-left: 4px }
.fmf-count { align-self: flex-end; font-size: 12px; font-weight: 600; color: var(--muted); margin-top: -2px }
.fmf-count.is-over { color: var(--brand) }
.fmf-hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden }
.fmf-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
.fmf-team { margin: -4px 0 12px }
.fmf-team summary, .fmf-modpanel summary { cursor: pointer; font-size: 13px; font-weight: 700; color: var(--muted); list-style: none; display: inline-flex; align-items: center; gap: 6px }
.fmf-team summary::-webkit-details-marker, .fmf-modpanel summary::-webkit-details-marker { display: none }
.fmf-team summary:hover, .fmf-modpanel summary:hover { color: var(--brand) }
.fmf-team[open] summary { margin-bottom: 10px }
.fmf-team small { font-size: 12px }
.fmf-actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 8px }
.fmf-modpanel { margin-top: 26px; padding: 14px 18px; border: 1px dashed var(--line); border-radius: var(--radius) }
.fmf-modpanel[open] { background: var(--bg-soft) }
.fmf-modpanel form { margin-top: 12px; max-width: 360px }
.fmf-modpanel p { font-size: 13px; margin: 0 }

.fmf-alert { display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; background: #fff1f1; border: 1px solid #ffc9c9; color: var(--brand-ink); font-weight: 600; font-size: 14px; margin-bottom: 18px }
.fmf-alert i { margin-top: 3px }
.fmf-alert ul { margin: 0; padding-left: 16px }
.fmf-flash { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: #ecfdf3; border: 1px solid #b7ebcb; color: #166534; font-weight: 700; font-size: 14px; margin-bottom: 18px }
.fmf-empty { text-align: center; padding: 48px 20px; color: var(--muted) }
.fmf-empty > i { font-size: 30px; color: #d1d5db; margin-bottom: 12px }
.fmf-empty h3 { font-size: 18px; color: var(--heading) }
.fmf-empty p { margin: 0 0 16px }
.fmf-pages { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 18px }
.fmf-pages a { min-width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; border: 1px solid var(--line); font-weight: 700; color: var(--body); background: #fff }
.fmf-pages a.is-active { background: var(--brand); border-color: var(--brand); color: #fff }

@media (max-width: 1020px) {
  .fmf-layout { grid-template-columns: minmax(0, 1fr) }
  .fmf-aside { position: static; order: -1; min-width: 0 }
  .fmf-layout--thread .fmf-aside { order: 0 }
  .fmf-catnav { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding: 0 0 4px; border: 0; border-radius: 0; background: transparent; scrollbar-width: none }
  .fmf-catnav::-webkit-scrollbar { display: none }
  .fmf-catnav a { flex: none; white-space: nowrap; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff }
  .fmf-catnav a i { width: auto }
  .fmf-catnav a span { flex: none }
  .fmf-note { display: none }
  .fmf-new { align-self: flex-start; width: auto }
}
@media (max-width: 640px) {
  .fmf-cats, .fmf-two { grid-template-columns: 1fr }
  .fmf-row { grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; padding: 14px 16px }
  .fmf-row-last { display: none }
  .fmf-snippet { padding-left: 16px }
  .fmf-post { padding: 18px }
  .fmf-catnav a b { display: none }
  .fmf-search input::placeholder { font-size: 14px }
  .fmf-hero-row { align-items: flex-start }
  .fmf-caticon--lg { width: 48px; height: 48px; font-size: 20px }
}
@media (prefers-reduced-motion: reduce) { .fmf-post { animation: none } }
</style>
</head>
<body>
<div id="site-header"></div>
<main>
<?= $content ?>
</main>
<div id="site-footer"></div>
<script src="../assets/site.js"></script>
<script>
(function () {
  'use strict';
  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  var ls = store('localStorage');
  document.querySelectorAll('.fmf-post').forEach(function (el, i) { el.style.setProperty('--i', Math.min(i, 8)); });
  document.querySelectorAll('[data-remember]').forEach(function (input) {
    var key = 'fm-forum-' + input.getAttribute('data-remember');
    if (!input.value && ls) { try { input.value = ls.getItem(key) || ''; } catch (e) {} }
  });
  document.querySelectorAll('[data-count-max]').forEach(function (input) {
    var max = +input.getAttribute('data-count-max');
    var out = document.createElement('span'); out.className = 'fmf-count';
    input.parentNode.appendChild(out);
    function upd() { var n = input.value.length; out.textContent = n > max * 0.6 ? n.toLocaleString() + ' / ' + max.toLocaleString() : ''; out.classList.toggle('is-over', n > max); }
    input.addEventListener('input', upd); upd();
  });
  document.querySelectorAll('[data-fmf-form]').forEach(function (form) {
    form.addEventListener('submit', function () {
      form.querySelectorAll('[data-remember]').forEach(function (input) {
        if (ls) { try { ls.setItem('fm-forum-' + input.getAttribute('data-remember'), input.value.trim()); } catch (e) {} }
      });
      var btn = form.querySelector('button[type=submit]');
      setTimeout(function () { if (btn) btn.disabled = true; }, 0);
    });
  });
  document.querySelectorAll('[data-confirm]').forEach(function (btn) {
    btn.addEventListener('click', function (e) { if (!window.confirm(btn.getAttribute('data-confirm'))) e.preventDefault(); });
  });
  var panel = document.getElementById('fmf-modpanel');
  if (panel) {
    var sync = function () { document.body.classList.toggle('fmf-modmode', panel.open); };
    panel.addEventListener('toggle', sync); sync();
    document.querySelectorAll('.fmf-modbar button').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        var code = document.getElementById('fmf-modcode');
        if (code && !code.value) { e.preventDefault(); panel.open = true; code.focus(); }
      });
    });
  }
})();
</script>
</body>
</html>
