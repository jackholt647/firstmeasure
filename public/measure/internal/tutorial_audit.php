<?php
require_once __DIR__ . '/_storage.php';
session_start();
require_once __DIR__ . '/firstmeasure_node.php';
require_once __DIR__ . '/_permission_options.php';
require_once __DIR__ . '/_tutorials.php';

function ta_esc($value) {
    return htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8');
}

function ta_internal_base_url() {
    $base = rtrim((string)fm_api_base_url(), '/');
    $internal = preg_replace('#/firstmeasure/?$#', '/internal', $base);
    if (is_string($internal) && $internal !== '' && $internal !== $base) return $internal;
    return rtrim($base, '/') . '/../internal';
}

function ta_node_internal_user($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('curl_init')) return null;
    $headers = [
        'Accept: application/json',
        'X-Internal-User-Email: ' . strtolower(trim((string)($_SESSION['user_email'] ?? $email))),
    ];
    if (!empty($_SESSION['user_name'])) $headers[] = 'X-Internal-User-Name: ' . (string)$_SESSION['user_name'];
    $ch = curl_init(rtrim(ta_internal_base_url(), '/') . '/users/' . rawurlencode($email));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
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

function ta_course_id($courseId) {
    $raw = strtolower(trim((string)$courseId));
    if ($raw === '' || $raw === 'default') return 'default';
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    return $slug !== '' ? $slug : 'default';
}

function ta_score_color($score) {
    if (!is_numeric($score)) return '#b06000';
    $score = (float)$score;
    if ($score < 60) return '#a50e0e';
    if ($score < 75) return '#d97706';
    if ($score < 90) return '#b58900';
    return '#188038';
}

function ta_score_text($score) {
    return is_numeric($score) ? (round((float)$score, 2) . '%') : 'Not scored';
}

function ta_first_text(...$values) {
    foreach ($values as $value) {
        $text = trim((string)$value);
        if ($text !== '') return $text;
    }
    return '';
}

function ta_value_html($value) {
    if ($value === null || $value === '') return '<span class="muted">null</span>';
    if (is_bool($value)) return $value ? '<b class="good">true</b>' : '<b class="bad">false</b>';
    if (is_numeric($value)) return ta_esc(round((float)$value, 2));
    if (is_array($value) || is_object($value)) {
        return '<pre>' . ta_esc(json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) . '</pre>';
    }
    return ta_esc($value);
}

if (empty($_SESSION['user_email'])) {
    header('Location: backend_login.php?redirect=' . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = strtolower(trim((string)$_SESSION['user_email']));
$userData = ta_node_internal_user($currentUserEmail);
if (!is_array($userData)) {
    http_response_code(403);
    echo 'Unauthorized';
    exit;
}

$perms = permissionOptionsNormalizePermissions($userData['permissions'] ?? [], $userData['role'] ?? 'user');
if (empty($perms['manage_tutorials'])) {
    http_response_code(403);
    echo 'Unauthorized';
    exit;
}

$studentEmail = strtolower(trim((string)($_GET['email'] ?? '')));
$tutorialId = fm_tutorial_sanitize_project_id($_GET['tutorial_id'] ?? $_GET['project_id'] ?? '');
$courseId = ta_course_id($_GET['course_id'] ?? 'default');
$audit = ($studentEmail !== '' && $tutorialId !== '')
    ? fm_tutorial_project_grading_audit($courseId, $studentEmail, $tutorialId)
    : ['success' => false, 'error' => 'Missing student email or tutorial project ID.'];

$stored = is_array($audit['stored_score'] ?? null) ? $audit['stored_score'] : [];
$current = is_array($audit['current_score'] ?? null) ? $audit['current_score'] : [];
$project = is_array($audit['project'] ?? null) ? $audit['project'] : [];
$answerKey = is_array($audit['answer_key'] ?? null) ? $audit['answer_key'] : [];
$categories = is_array($audit['categories'] ?? null) ? $audit['categories'] : [];
$links = is_array($audit['links'] ?? null) ? $audit['links'] : [];
$sourceProjectId = ta_first_text($audit['source_project_id'] ?? '', $answerKey['source_project_id'] ?? '');
$projectAddress = ta_first_text($project['source_address'] ?? '', $project['address'] ?? '');
$studentProjectUrl = ta_first_text($links['student_project_editor_url'] ?? '');
$sourceProjectUrl = ta_first_text($links['source_project_editor_url'] ?? '');
$mapSearchUrl = ta_first_text($links['map_search_url'] ?? '');
$mapEmbedUrl = ta_first_text($links['map_embed_url'] ?? '');
$raw = json_encode($audit, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tutorial Grading Audit</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f6f8fb; color: #202124; }
        header { position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid #e6e8ef; padding: 18px 24px; }
        h1 { margin: 0; font-size: 24px; }
        .sub { margin-top: 6px; color: #667085; font-size: 13px; }
        main { padding: 22px 24px 36px; display: grid; gap: 16px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
        .card { background: #fff; border: 1px solid #e6e8ef; border-radius: 8px; padding: 12px; }
        .label { font-size: 10px; font-weight: 900; color: #667085; text-transform: uppercase; letter-spacing: .04em; }
        .value { margin-top: 6px; font-size: 14px; font-weight: 900; word-break: break-word; }
        .panel { background: #fff; border: 1px solid #e6e8ef; border-radius: 8px; overflow: hidden; }
        .panel-title { padding: 11px 13px; background: #f8fafc; border-bottom: 1px solid #e6e8ef; font-weight: 900; }
        .panel-body { padding: 13px; }
        .table-wrap { overflow: auto; }
        table { width: 100%; min-width: 940px; border-collapse: collapse; }
        th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #edf0f5; padding: 10px; font-size: 12px; }
        th { color: #667085; font-size: 11px; text-transform: uppercase; background: #fff; }
        pre { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #f8fafc; border: 1px solid #e6e8ef; border-radius: 7px; padding: 8px; font-size: 11px; line-height: 1.45; color: #344054; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 8px 11px; border: 1px solid #d0d5dd; border-radius: 7px; background: #fff; color: #344054; text-decoration: none; font-size: 12px; font-weight: 900; }
        .btn.primary { background: #202124; border-color: #202124; color: #fff; }
        .map-frame { width: 100%; height: 260px; border: 0; display: block; background: #eef2f7; }
        .muted { color: #98a2b3; }
        .good { color: #188038; }
        .bad { color: #a50e0e; }
        .warn { border: 1px solid #fed7aa; background: #fffbeb; color: #92400e; border-radius: 8px; padding: 10px 12px; font-size: 12px; font-weight: 800; }
        .error { border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; border-radius: 8px; padding: 14px; font-weight: 900; }
    </style>
</head>
<body>
<header>
    <h1>Tutorial Grading Audit</h1>
    <div class="sub"><?= ta_esc($studentEmail) ?> · <?= ta_esc($tutorialId) ?></div>
</header>
<main>
    <?php if (empty($audit['success'])): ?>
        <div class="error"><?= ta_esc($audit['error'] ?? 'Could not load audit.') ?></div>
    <?php else: ?>
        <section class="grid">
            <div class="card"><div class="label">Stored Grade</div><div class="value" style="color:<?= ta_esc(ta_score_color($stored['score'] ?? null)) ?>"><?= ta_esc(ta_score_text($stored['score'] ?? null)) ?></div></div>
            <div class="card"><div class="label">Recomputed Grade</div><div class="value" style="color:<?= ta_esc(ta_score_color($current['score'] ?? null)) ?>"><?= ta_esc(ta_score_text($current['score'] ?? null)) ?></div></div>
            <div class="card"><div class="label">Score Status</div><div class="value"><?= ta_esc($current['score_status'] ?? $stored['score_status'] ?? '') ?></div></div>
            <div class="card"><div class="label">Grading Version</div><div class="value"><?= ta_esc($current['grading_version'] ?? $stored['grading_version'] ?? '') ?></div></div>
            <div class="card"><div class="label">Answer Key Version</div><div class="value"><?= ta_esc($answerKey['version'] ?? '') ?></div></div>
            <div class="card"><div class="label">Source Project</div><div class="value"><?= ta_esc($sourceProjectId) ?></div></div>
        </section>

        <section class="grid">
            <div class="panel">
                <div class="panel-title">Project Links</div>
                <div class="panel-body">
                    <div class="label">Student Project</div>
                    <div class="value"><?= ta_esc($tutorialId) ?></div>
                    <div class="label" style="margin-top:12px;">Source Project</div>
                    <div class="value"><?= ta_esc($sourceProjectId) ?></div>
                    <div class="actions">
                        <?php if ($studentProjectUrl !== ''): ?><a class="btn primary" href="<?= ta_esc($studentProjectUrl) ?>" target="_blank" rel="noopener">Open Student Project</a><?php endif; ?>
                        <?php if ($sourceProjectUrl !== ''): ?><a class="btn" href="<?= ta_esc($sourceProjectUrl) ?>" target="_blank" rel="noopener">Open Source Project</a><?php endif; ?>
                    </div>
                </div>
            </div>
            <div class="panel">
                <div class="panel-title">Address</div>
                <div class="panel-body">
                    <div class="value"><?= ta_esc($projectAddress !== '' ? $projectAddress : 'No address recorded') ?></div>
                    <div class="actions">
                        <?php if ($mapSearchUrl !== ''): ?><a class="btn primary" href="<?= ta_esc($mapSearchUrl) ?>" target="_blank" rel="noopener">Open Google Maps</a><?php endif; ?>
                    </div>
                </div>
                <?php if ($mapEmbedUrl !== ''): ?>
                    <iframe class="map-frame" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="<?= ta_esc($mapEmbedUrl) ?>"></iframe>
                <?php endif; ?>
            </div>
        </section>

        <?php if (is_numeric($stored['score'] ?? null) && is_numeric($current['score'] ?? null) && abs((float)$stored['score'] - (float)$current['score']) > 0.01): ?>
            <div class="warn">Stored and recomputed grades differ. Current grader reports <?= ta_esc(ta_score_text($current['score'] ?? null)) ?>; stored record shows <?= ta_esc(ta_score_text($stored['score'] ?? null)) ?>.</div>
        <?php endif; ?>

        <section class="grid">
            <div class="card"><div class="label">Project Status</div><div class="value"><?= ta_esc($project['status'] ?? '') ?></div></div>
            <div class="card"><div class="label">Project Type</div><div class="value"><?= ta_esc($project['tutorial_kind'] ?? '') ?></div></div>
            <div class="card"><div class="label">Chapter</div><div class="value"><?= ta_esc($project['chapter_id'] ?? '') ?></div></div>
            <div class="card"><div class="label">Test Attempt</div><div class="value"><?= ta_esc($project['test_attempt_id'] ?? '') ?></div></div>
            <div class="card"><div class="label">Sequence</div><div class="value"><?= ta_esc(!empty($project['sequence_total']) ? (($project['sequence_index'] ?? '?') . ' / ' . $project['sequence_total']) : '') ?></div></div>
            <div class="card"><div class="label">Scored At</div><div class="value"><?= ta_esc($current['scored_at'] ?? $stored['scored_at'] ?? '') ?></div></div>
        </section>

        <section class="panel">
            <div class="panel-title">Category Math</div>
            <div class="table-wrap">
                <table>
                    <thead>
                    <tr>
                        <th>Category</th>
                        <th>Points</th>
                        <th>Diff</th>
                        <th>Credit Band</th>
                        <th>Expected</th>
                        <th>Submitted</th>
                    </tr>
                    </thead>
                    <tbody>
                    <?php if (!$categories): ?>
                        <tr><td colspan="6" class="muted">No category details are available yet.</td></tr>
                    <?php else: ?>
                        <?php foreach ($categories as $category): ?>
                            <?php
                                $score = $category['score'] ?? null;
                                $max = $category['max_score'] ?? null;
                                $pct = (is_numeric($score) && is_numeric($max) && (float)$max > 0) ? ((float)$score / (float)$max) * 100 : null;
                            ?>
                            <tr>
                                <td>
                                    <b><?= ta_esc($category['label'] ?? $category['key'] ?? '') ?></b>
                                    <div class="muted"><?= ta_esc($category['metric_key'] ?? '') ?></div>
                                    <?php if (!empty($category['message'])): ?><div class="muted"><?= ta_esc($category['message']) ?></div><?php endif; ?>
                                </td>
                                <td style="font-weight:900; color:<?= ta_esc(ta_score_color($pct)) ?>"><?= ta_esc(is_numeric($score) && is_numeric($max) ? (round((float)$score, 2) . ' / ' . round((float)$max, 2)) : ($category['status'] ?? '')) ?></td>
                                <td><?= ta_esc(is_numeric($category['diff_percent'] ?? null) ? (round((float)$category['diff_percent'], 2) . '%') : '-') ?></td>
                                <td><?= ta_esc(($category['full_credit_at_diff_percent'] ?? '?') . '% full / ' . ($category['zero_credit_at_diff_percent'] ?? '?') . '% zero') ?></td>
                                <td><?= ta_value_html($category['expected_value'] ?? null) ?></td>
                                <td><?= ta_value_html($category['submitted_value'] ?? null) ?></td>
                            </tr>
                        <?php endforeach; ?>
                    <?php endif; ?>
                    </tbody>
                </table>
            </div>
        </section>

        <section class="grid">
            <div class="panel"><div class="panel-title">Expected Metrics</div><div class="panel-body"><?= ta_value_html($audit['expected_metrics'] ?? []) ?></div></div>
            <div class="panel"><div class="panel-title">Submitted Metrics</div><div class="panel-body"><?= ta_value_html($audit['submitted_metrics'] ?? []) ?></div></div>
        </section>

        <section class="panel">
            <div class="panel-title">Raw Grader Payload</div>
            <div class="panel-body"><pre><?= ta_esc($raw) ?></pre></div>
        </section>
    <?php endif; ?>
</main>
</body>
</html>
