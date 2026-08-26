<?php
require_once __DIR__ . '/_storage.php';
/**
 * migrate_app_metadata.php
 *
 * Visit this file in your browser to trigger the app_metadata migration.
 * It will scan all project manifests, extract app_metadata into separate
 * app_metadata.json files, and clean the manifests.
 *
 * Place in the same directory as server.php.
 */
ini_set('display_errors', 1);
error_reporting(E_ALL);
session_start();

// ---- Bootstrap (same setup as server.php, without action routing) ----
$GOOGLE_API_KEY = 'REMOVED_CREDENTIAL';
$GEMINI_API_KEY = 'REMOVED_CREDENTIAL';

$baseDir     = __DIR__ . '/saves/';
$userDir     = storageDir('users');
$tutorialDir = storageDir('tutorials');
$orgDir      = storageDir('organizations');
$GLOBALS['orgDir'] = $orgDir;

$POSTMARK_DEFAULT_FROM    = 'noreply@1m8.ai';
$POSTMARK_DEFAULT_REPLYTO = 'support@1m8.ai';

require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_organizations.php';
require_once __DIR__ . '/_users.php';
require_once __DIR__ . '/_stripe.php';
require_once __DIR__ . '/_project_index.php';
require_once __DIR__ . '/_call_scripts/_deprecated_projects_legacy_unused.php';

// ---- Auth gate: admin only ----
if (!function_exists('isAdmin') || !isAdmin()) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    echo '<h1>403 — Admin access required</h1>';
    echo '<p>Log in as an admin first, then revisit this page.</p>';
    exit;
}

// ---- Run the migration ----
$result = migrateAllAppMetadata();

// ---- Render results ----
header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>App Metadata Migration</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background: #f5f5f5; color: #111; padding: 40px 20px; }
        .card { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.08); padding: 32px; }
        h1 { font-size: 22px; margin-bottom: 20px; }
        .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .stat { padding: 14px; border-radius: 8px; background: #f9f9f9; border: 1px solid #eee; }
        .stat .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
        .success .value { color: #1a7f37; }
        .errors .value { color: #cf222e; }
        .err-list { margin-top: 16px; padding: 14px; background: #fce8e6; border: 1px solid #f4b4ae; border-radius: 8px; font-size: 13px; }
        .err-list p { margin-bottom: 6px; font-weight: 600; }
        .err-list code { display: block; margin: 4px 0; padding: 4px 8px; background: #fff; border-radius: 4px; font-size: 12px; }
        .done { margin-top: 20px; padding: 12px 16px; background: #dafbe1; border: 1px solid #a7f0ba; border-radius: 8px; color: #1a7f37; font-weight: 600; }
        .fail { margin-top: 20px; padding: 12px 16px; background: #fce8e6; border: 1px solid #f4b4ae; border-radius: 8px; color: #cf222e; font-weight: 600; }
    </style>
</head>
<body>
<div class="card">
    <h1>App Metadata Migration</h1>

    <?php if (empty($result['success'])): ?>
        <div class="fail">
            Migration failed: <?= htmlspecialchars($result['error'] ?? 'Unknown error') ?>
        </div>
    <?php else: ?>
        <?php $s = $result['stats']; ?>
        <div class="stat-grid">
            <div class="stat">
                <div class="label">Projects scanned</div>
                <div class="value"><?= (int)$s['total'] ?></div>
            </div>
            <div class="stat success">
                <div class="label">Migrated</div>
                <div class="value"><?= (int)$s['migrated'] ?></div>
            </div>
            <div class="stat">
                <div class="label">Skipped (already done)</div>
                <div class="value"><?= (int)$s['skipped'] ?></div>
            </div>
            <div class="stat">
                <div class="label">Manifest-only cleanups</div>
                <div class="value"><?= (int)$s['cleaned'] ?></div>
            </div>
            <div class="stat errors">
                <div class="label">Errors</div>
                <div class="value"><?= (int)$s['errors'] ?></div>
            </div>
        </div>

        <?php if (!empty($result['errors'])): ?>
            <div class="err-list">
                <p>Error details:</p>
                <?php foreach ($result['errors'] as $e): ?>
                    <code><?= htmlspecialchars($e['folder'] ?? '?') ?>: <?= htmlspecialchars($e['error'] ?? '?') ?></code>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>

        <div class="done">Migration complete. Safe to re-run — it's idempotent.</div>
    <?php endif; ?>
</div>
</body>
</html>
