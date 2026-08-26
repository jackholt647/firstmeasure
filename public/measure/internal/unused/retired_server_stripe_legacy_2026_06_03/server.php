<?php
require_once __DIR__ . '/_storage.php';
/**
 * server.php
 *
 * Includes:
 * - Auth (register/login/OTP/reset)
 * - Projects (queue/list/load/save/upload/qa)
 * - Credits (balance, ledger, employee bypass)
 * - Stripe Checkout + Webhook + idempotent fulfillment
 * - Apple key store
 * - Tutorial system
 *
 * NEW:
 * - Coupon system (secure):
 *   - Customer redeem: action=coupon_redeem
 *   - Admin endpoints for future app:
 *       action=coupon_admin_create
 *       action=coupon_admin_list
 *       action=coupon_admin_disable
 *   - Codes are NOT stored in plaintext; only HMAC hash is stored.
 *
 * UPDATED:
 * - ALL email (OTP + report delivery) now uses Postmark (no PHP mail()).
 * - Reads Postmark server token from: pm_server_token.txt (same directory as this file)
 */
ini_set('display_errors', 1);
ini_set('log_errors', 1);
ini_set('error_log', storagePath('logs/php_error.log', true));
error_reporting(E_ALL);
$portalSessionBootstrap = __DIR__ . '/../../portal/session_bootstrap.php';
if (is_file($portalSessionBootstrap)) {
    require_once $portalSessionBootstrap;
    portalStartSession();
} else {
    session_start();
}
ignore_user_abort(true);
set_time_limit(300);

// CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Stripe-Signature');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// -------------------- CONFIG --------------------

// Toggle this ONE flag:
define('STRIPE_TEST_MODE', false);  // set false for live

// API Keys
$GOOGLE_API_KEY = 'REMOVED_CREDENTIAL';
$GEMINI_API_KEY = 'REMOVED_CREDENTIAL';
$GLOBALS['GOOGLE_API_KEY'] = $GOOGLE_API_KEY;
$GLOBALS['GEMINI_API_KEY'] = $GEMINI_API_KEY;

// Apple Key store
$APPLE_KEY_PATH = storageExistingPath('config/apple_key.json', __DIR__ . '/apple_key.json', true);

// Base URL
$BASE_URL = 'https://app.1m8.ai/portal';
$BACKEND_URL = 'https://app.1m8.ai/measure/internal/';
$OPS_NOTIFY_TO = 'notifications@1m8.ai';

// Stripe configs (fill both)
$STRIPE_TEST_SECRET_KEY = getenv('STRIPE_TEST_SECRET_KEY') ?: '';
$STRIPE_TEST_PRICE_ID       = 'price_1SsXkOLZgCRkHjNQCJvblXWT';
$STRIPE_TEST_BONUS_PRICE_ID = 'price_1SsXkOLZgCRkHjNQCJvblXWT';
$STRIPE_TEST_WEBHOOK_SECRET = getenv('STRIPE_TEST_WEBHOOK_SECRET') ?: '';
$STRIPE_LIVE_SECRET_KEY = getenv('STRIPE_LIVE_SECRET_KEY') ?: '';
$STRIPE_LIVE_PRICE_ID       = 'price_1SsXlVLsVt78N4NAWbEg84Dq';
$STRIPE_LIVE_BONUS_PRICE_ID = 'price_1T7fn4LsVt78N4NA41Qptrzt';
$STRIPE_LIVE_WEBHOOK_SECRET = getenv('STRIPE_LIVE_WEBHOOK_SECRET') ?: '';



// ============================================================
// INTERNAL MUTATION TOKEN (NOT session/admin/email based)
// - Put a strong random token in: internal_mutation_token.txt
// - Requests must include: POST token=... OR header X-Internal-Mutation-Token: ...
// ============================================================

$INTERNAL_MUTATION_TOKEN_PATH = storageExistingPath('secrets/internal_mutation_token.txt', __DIR__ . '/internal_mutation_token.txt', true);


// Directories
$userDir     = storageDir('users');
$tutorialDir = storageDir('tutorials');
$orgDir = storageDir('organizations');
if (!file_exists($orgDir)) mkdir($orgDir, 0777, true);
$GLOBALS['orgDir'] = $orgDir;

// Per-mode stripe event/idempotency dirs
$stripeEvtDir = storageDir(STRIPE_TEST_MODE ? 'stripe_events_test' : 'stripe_events_live');

// Effective stripe vars
$STRIPE_SECRET_KEY     = STRIPE_TEST_MODE ? $STRIPE_TEST_SECRET_KEY     : $STRIPE_LIVE_SECRET_KEY;
$STRIPE_PRICE_ID       = STRIPE_TEST_MODE ? $STRIPE_TEST_PRICE_ID       : $STRIPE_LIVE_PRICE_ID;
$STRIPE_BONUS_PRICE_ID = STRIPE_TEST_MODE ? $STRIPE_TEST_BONUS_PRICE_ID : $STRIPE_LIVE_BONUS_PRICE_ID;
$STRIPE_WEBHOOK_SECRET = STRIPE_TEST_MODE ? $STRIPE_TEST_WEBHOOK_SECRET : $STRIPE_LIVE_WEBHOOK_SECRET;

// -------------------- COUPONS --------------------
// IMPORTANT: Change this to a long random secret (keep private).
// This is used to HMAC-hash coupon codes so raw codes are never stored.
$COUPON_PEPPER   = 'CHANGE_ME__LONG_RANDOM_SECRET_64+_CHARS';
$couponDir       = storageDir('coupons');
$couponLockFile  = storagePath('locks/coupons.lock', true);

// -------------------- POSTMARK -------------------
// Put your server token in: pm_server_token.txt (same folder as server.php)
$POSTMARK_TOKEN_PATH = storageExistingPath('secrets/pm_server_token.txt', __DIR__ . '/pm_server_token.txt', true);

// IMPORTANT: use addresses on your verified sending domain.
$POSTMARK_DEFAULT_FROM = 'noreply@1m8.ai';
$POSTMARK_DEFAULT_REPLYTO = 'support@1m8.ai'; // optional; change or leave as-is

// ------------------------------------------------

// Ensure directories exist
if (!file_exists($userDir)) mkdir($userDir, 0777, true);
if (!file_exists($tutorialDir)) mkdir($tutorialDir, 0777, true);
if (!file_exists($tutorialDir . 'master/')) mkdir($tutorialDir . 'master/', 0777, true);
if (!file_exists($stripeEvtDir)) mkdir($stripeEvtDir, 0777, true);
if (!file_exists($couponDir)) mkdir($couponDir, 0777, true);

function tutorialCourseIdFromRequest() {
    $raw = strtolower(trim((string)($_POST['course_id'] ?? $_GET['course_id'] ?? 'default')));
    if ($raw === '' || $raw === 'default') return 'default';
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    return $slug !== '' ? $slug : 'default';
}

function tutorialCourseBaseDir($courseId) {
    global $tutorialDir;
    if ($courseId === 'default') return $tutorialDir;
    return $tutorialDir . 'courses/' . $courseId . '/';
}

function tutorialEnsureCourseDirs($courseId) {
    $base = tutorialCourseBaseDir($courseId);
    if (!file_exists($base)) mkdir($base, 0777, true);
    if (!file_exists($base . 'master/')) mkdir($base . 'master/', 0777, true);
    return $base;
}

function tutorialCurriculumFile($courseId) {
    return tutorialEnsureCourseDirs($courseId) . 'master/curriculum.json';
}

function tutorialAssetDir($courseId) {
    $dir = tutorialEnsureCourseDirs($courseId) . 'master/assets/';
    if (!file_exists($dir)) mkdir($dir, 0777, true);
    return $dir;
}

function tutorialAssetUrl($courseId, $filename) {
    $safe = rawurlencode(basename((string)$filename));
    if ($courseId === 'default') return 'tutorials/master/assets/' . $safe;
    return 'tutorials/courses/' . rawurlencode($courseId) . '/master/assets/' . $safe;
}

function tutorialUserDir($courseId, $userSafe) {
    return tutorialEnsureCourseDirs($courseId) . $userSafe . '/';
}

function tutorialProgressFile($courseId, $userSafe) {
    return tutorialUserDir($courseId, $userSafe) . 'progress.json';
}

// Default response type (API)
header('Content-Type: application/json');

// Hydrate JSON request bodies into $_POST for newer portal modules that use fetch(JSON).
if ($_SERVER['REQUEST_METHOD'] === 'POST' && empty($_POST)) {
    $rawBody = @file_get_contents('php://input');
    if (is_string($rawBody) && trim($rawBody) !== '') {
        $jsonBody = json_decode($rawBody, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($jsonBody)) {
            $_POST = $jsonBody;
        }
    }
}

// ------------------------------------------------
// NODE INTERNAL API EARLY BRIDGE
// ------------------------------------------------
// Keep server.php as a compatibility shim for old callers, but avoid loading
// the large legacy PHP module stack when Node already owns the action.
function fm_node_v1_base_url() {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function fm_server_action_node_bridge_allowed($action) {
    static $allowed = null;
    if ($allowed === null) {
        $allowed = array_fill_keys([
            'fetch_users','save_user','delete_user',
            'queue_live_trained_users','queue_admin_teams',
            'get_user_queue_mode','set_user_queue_mode',
            'fetch_organizations_list','customer_org_dashboard_data','customer_org_detail',
            'org_assign_sales_owner','org_set_test_flag','admin_adjust_org_credits',
            'customer_pair_candidates','lead_pair_search','customer_apply_pairs',
            'admin_impersonate_user','stats_data','fetch_all_users_with_orders',
            'shift_get_schedules','shift_get_my_schedule','shift_current_status',
            'shift_session_stats','shift_personal_snapshot','shift_save_schedule',
            'shift_save_day_override','shift_remove_day_override',
            'portal_status_snapshot','rush_mode_current','rush_mode_list',
            'rush_mode_start','rush_mode_automation_get','rush_mode_automation_set',
            'pj_rebuild','server_config_list','server_config_set',
            'get_apple_key_info','set_apple_key',
            'coupon_admin_list','coupon_admin_get','coupon_admin_create',
            'coupon_admin_update','coupon_admin_delete',
            'commission_dashboard','commission_save_user_settings',
            'commission_mark_payroll_completed','commission_export_report',
            'lead_sales_users','lead_my_leads','lead_my_followups','lead_get',
            'lead_dashboard','lead_pipeline_snapshot','lead_sequences_snapshot',
            'lead_analytics','lead_list_list','lead_list_leads','lead_list_get',
            'lead_orum_import_history','lead_preview_orum_csv','lead_confirm_orum_import',
            'lead_import_orum_csv','lead_export_leads_csv','lead_export_csv',
            'lead_dashboard_task_save','lead_dashboard_task_toggle','lead_dashboard_task_delete',
            'lead_list_save','lead_list_delete','lead_save','lead_delete','lead_add_note',
            'lead_save_contact','lead_save_contact_note','lead_select_contact',
            'lead_save_followup','lead_update_company_email','lead_update_core_fields',
            'lead_set_primary_contact','lead_save_stage','lead_save_milestone',
            'lead_assign_org_credits','lead_save_email_branding','lead_sequence_action',
            'lead_schedule_calendar','lead_sync_gmail','lead_send_email',
            'crm_call_annotation_save','crm_settings_get','crm_settings_save',
            'google_connection_status','gmail_disconnect','gmail_background_sync',
            'gmail_debug_snapshot',
            'mock_comms_settings_get','mock_comms_settings_save','mock_comms_reset',
            'mock_comms_inject_gmail','mock_comms_inject_calendar',
            'lead_bulk_email_bootstrap','lead_bulk_email_preview',
            'lead_bulk_email_send','lead_email_sample_bundle',
            'referral_partner_list','referral_partners_list','referral_partner_get',
            'referral_partner_save','referral_org_search','referral_manual_attach',
            'referral_rewards_dashboard','referral_reward_dashboard','referral_reward_report',
            'referral_reward_update_status','list_sample_projects','load_sample_project_bundle',
            'toggle_sample_favorite','lead_create_territory_lists','lead_generate_daily_lists',
            'lead_generate_followup_lists','lead_assign_list','lead_distribute_unassigned',
            'lead_list_fetcher_get_config','lead_list_fetcher_get_tile_status',
            'lead_list_fetcher_get_raw_businesses','lead_list_fetcher_get_detail_index',
            'lead_list_fetcher_save_config','lead_list_fetcher_pull_tile',
            'lead_list_fetcher_pull_details_batch',
            'data_agent_get_settings','data_agent_save_settings','data_agent_list_sessions',
            'data_agent_get_session','data_agent_bootstrap','data_agent_delete_session',
            'data_agent_rename_session','data_agent_start_run','data_agent_get_run',
            'list_tutorial_projects','fetch_curriculum','fetch_student_list',
            'fetch_student_details','update_progress','save_curriculum',
            'start_tutorial_project','start_tutorial_test_attempt','start_tutorial_draft_reject_round',
            'technician_leaderboard','my_active_projects','claim_next_for_me',
            'check_hot_swap','execute_hot_swap','record_reopened_project_claim',
            'qa_queue_move_to_top','qa_queue_clear_priority','manager_complexity_override',
            'reject_no_coverage','cancel_project','reopen_completed_project',
            'set_break_status','manager_review_data','manager_audit_mark'
        ], true);
    }
    return isset($allowed[(string)$action]);
}

function fm_server_try_node_bridge() {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') return false;
    if (!empty($_FILES)) return false;
    $action = (string)($_POST['action'] ?? $_GET['action'] ?? '');
    if ($action === '' || !fm_server_action_node_bridge_allowed($action)) return false;

    $payload = $_POST;
    $payload['action'] = $action;
    if (!isset($payload['actor_email']) && isset($_SESSION['user_email'])) $payload['actor_email'] = $_SESSION['user_email'];
    if (!isset($payload['actor_name']) && isset($_SESSION['user_name'])) $payload['actor_name'] = $_SESSION['user_name'];
    if (!isset($payload['actor_role']) && isset($_SESSION['user_role'])) $payload['actor_role'] = $_SESSION['user_role'];

    $body = json_encode($payload);
    if (!is_string($body)) return false;

    $headers = [
        'Content-Type: application/json',
        'Accept: application/json'
    ];
    if (!empty($_SESSION['user_email'])) $headers[] = 'X-Internal-User-Email: ' . $_SESSION['user_email'];
    if (!empty($_SESSION['user_name'])) $headers[] = 'X-Internal-User-Name: ' . $_SESSION['user_name'];
    if (!empty($_SESSION['user_role'])) $headers[] = 'X-Internal-User-Role: ' . $_SESSION['user_role'];

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $body,
            'ignore_errors' => true,
            'timeout' => 20
        ]
    ]);
    $url = rtrim(fm_node_v1_base_url(), '/') . '/internal/legacy-action';
    $response = @file_get_contents($url, false, $context);
    if ($response === false) return false;

    $status = 200;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $m)) {
                $status = (int)$m[1];
                break;
            }
        }
    }
    http_response_code($status);
    header('Content-Type: application/json');
    echo $response;
    return true;
}

if (fm_server_try_node_bridge()) {
    exit;
}


// ------------------------------------------------
// STRIPE WEBHOOK AUTO-ROUTE (no ?stripe_webhook=1 needed)
// If Stripe sends the signature header, this is a webhook call.
// ------------------------------------------------
$isStripeWebhook = (!empty($_SERVER['HTTP_STRIPE_SIGNATURE']) && $_SERVER['REQUEST_METHOD'] === 'POST');

if ($isStripeWebhook) {
    // If your webhook code lives in this same file under the ?stripe_webhook=1 branch,
    // force that branch:
    $_GET['stripe_webhook'] = '1';
}



require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_organizations.php';
require_once __DIR__ . '/_project_api.php';
require_once __DIR__ . '/_tutorials.php';
require_once __DIR__ . '/_project_index.php';
require_once __DIR__ . '/_users.php';
require_once __DIR__ . '/_stripe.php';

function fm_server_try_legacy_module_handler($action, $moduleFile, $handlerFunction) {
    if (!function_exists($handlerFunction)) {
        $path = __DIR__ . '/' . $moduleFile;
        if (!is_file($path)) return false;
        require_once $path;
    }
    if (!function_exists($handlerFunction)) return false;
    return (bool)$handlerFunction($action);
}





// ------------------------------------------------
// ---------------- REQUEST LOGGING --------------
// ------------------------------------------------
function logHitToFile($tag = 'hit') {
    $logPath = storagePath('logs/hit_debug.log', true);

    // Best-effort read of raw body (works for JSON + form posts)
    $rawBody = @file_get_contents('php://input');
    if ($rawBody === false) $rawBody = '';

    // Parse JSON body if applicable (don’t trust Content-Type completely)
    $jsonBody = null;
    if ($rawBody !== '') {
        $tmp = json_decode($rawBody, true);
        if (json_last_error() === JSON_ERROR_NONE) $jsonBody = $tmp;
    }

    // Build safe snapshot (avoid logging secrets)
    $post = $_POST ?? [];
    foreach (['token','password','otp','code','stripe_signature','Stripe-Signature'] as $k) {
        if (isset($post[$k])) $post[$k] = '[REDACTED]';
    }

    $headers = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) {
            $h = str_replace('_', '-', substr($k, 5));
            // redact sensitive headers
            if (in_array(strtolower($h), ['authorization','stripe-signature','x-internal-mutation-token'], true)) {
                $v = '[REDACTED]';
            }
            $headers[$h] = $v;
        }
    }

    $entry = [
        'ts_utc'   => gmdate('c'),
        'tag'      => $tag,
        'ip'       => $_SERVER['REMOTE_ADDR'] ?? null,
        'xff'      => $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null,
        'method'   => $_SERVER['REQUEST_METHOD'] ?? null,
        'uri'      => $_SERVER['REQUEST_URI'] ?? null,
        'action'   => $_POST['action'] ?? null,
        'get'      => $_GET ?? [],
        'post'     => $post,
        'json'     => $jsonBody,
        'raw_len'  => strlen((string)$rawBody),
        'ua'       => $_SERVER['HTTP_USER_AGENT'] ?? null,
        'referer'  => $_SERVER['HTTP_REFERER'] ?? null,
        'headers'  => $headers,
    ];

    // One JSON line per request (easy to grep)
    @file_put_contents($logPath, json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}




// ------------------------------------------------
// ---------------- COUPON HELPERS ---------------
// ------------------------------------------------

function couponNormalize($code) {
    $code = strtoupper(trim((string)$code));
    $code = preg_replace('/[^A-Z0-9\-]/', '', $code);
    $code = preg_replace('/\-+/', '-', $code);
    return $code;
}

function couponHash($normalizedCode) {
    $pepper = $GLOBALS['COUPON_PEPPER'] ?? '';
    return hash_hmac('sha256', $normalizedCode, $pepper);
}

function couponPathByHash($hash) {
    $hash = preg_replace('/[^a-f0-9]/', '', strtolower((string)$hash));
    return $GLOBALS['couponDir'] . 'coupon_' . $hash . '.json';
}

function withCouponLock($fn) {
    $lockFile = $GLOBALS['couponLockFile'];
    $fh = fopen($lockFile, 'c+');
    if (!$fh) return $fn();
    try {
        flock($fh, LOCK_EX);
        $out = $fn();
        flock($fh, LOCK_UN);
        fclose($fh);
        return $out;
    } catch (Exception $e) {
        try { flock($fh, LOCK_UN); fclose($fh); } catch (Exception $e2) {}
        return null;
    }
}

function couponRateLimitOrFail() {
    if (!isset($_SESSION['coupon_try'])) $_SESSION['coupon_try'] = ['n'=>0,'t'=>time()];
    $n = (int)($_SESSION['coupon_try']['n'] ?? 0);
    $t = (int)($_SESSION['coupon_try']['t'] ?? time());

    if (time() - $t > 300) { $_SESSION['coupon_try'] = ['n'=>0,'t'=>time()]; $n = 0; }

    $n++;
    $_SESSION['coupon_try']['n'] = $n;

    if ($n > 12) return ['ok'=>false, 'error'=>'Too many attempts. Try again in a few minutes.'];
    return ['ok'=>true];
}

// ------------------------------------------------
// ---------------- EMAIL / POSTMARK HELPERS -------------
// ------------------------------------------------

function postmarkGetServerToken() {
    static $token = null;
    if (is_string($token) && $token !== '') return $token;

    $p = $GLOBALS['POSTMARK_TOKEN_PATH'] ?? null;
    if (!$p || !file_exists($p)) {
        error_log("Postmark token file missing: " . ($p ?: '(null)'));
        return null;
    }

    $raw = trim((string)@file_get_contents($p));
    if ($raw === '') {
        error_log("Postmark token file empty: $p");
        return null;
    }

    $token = $raw;
    return $token;
}

function emailFooterHtml() {
    $logo = 'https://1m8.ai/images/logo_red.png';
    $year = date('Y');

    return
        '<div style="margin-top:22px; padding-top:14px; border-top:1px solid #e9e9e9;">' .
            '<img src="' . htmlspecialchars($logo) . '" alt="1m8" style="height:34px; width:auto; display:block; border:0; outline:none; text-decoration:none;" />' .
            '<div style="margin-top:6px; font-size:12px; line-height:1.3; color:#777;">' .
                ' © ' . $year . ' <a href="https://1m8.ai" style="color:#1a73e8; text-decoration:none;">1m8.ai</a>' .
            '</div>' .
        '</div>';
}


function emailFooterText() {
    return "\n\n--\nThe FirstMeasure Team\n";
}

function wrapEmailHtml($innerHtml) {
    $innerHtml = (string)$innerHtml;

    // If caller passed empty, we still want a valid HTML body for the logo footer.
    if (trim($innerHtml) === '') {
        $innerHtml = '<p style="margin:0;">&nbsp;</p>';
    }

    return
        '<div style="font-family:-apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:14px; line-height:1.45; color:#111;">' .
            $innerHtml .
            emailFooterHtml() .
        '</div>';
}

function wrapEmailText($text) {
    $text = (string)$text;
    // Prevent double-footer if something ever calls postmarkSendEmail twice with already-wrapped text
    if (strpos($text, "\n--\nThe FirstMeasure Team") !== false) return $text;
    return $text . emailFooterText();
}

function postmarkShouldDisableTlsVerification() {
    $configured = serverConfigGet('postmark_disable_tls_verify_local', null);
    if ($configured !== null) {
        return !empty($configured);
    }

    $host = strtolower(trim((string)($_SERVER['HTTP_HOST'] ?? '')));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if (in_array($hostOnly, ['127.0.0.1', 'localhost'], true)) {
        return true;
    }
    if (preg_match('/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $hostOnly)) {
        return true;
    }
    if (preg_match('/^192\.168\.\d{1,3}\.\d{1,3}$/', $hostOnly)) {
        return true;
    }
    if (preg_match('/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/', $hostOnly)) {
        return true;
    }
    return false;
}

function postmarkSendEmail($to, $subject, $textBody, $htmlBody = null, $from = null, $replyTo = null, $attachments = []) {
    $token = postmarkGetServerToken();
    if (!$token) return ['ok'=>false, 'error'=>'Postmark token missing'];

    $from = $from ?: ($GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai');
    $replyTo = $replyTo ?: ($GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null);

    // --- ALWAYS append footer ---
    $textBody = wrapEmailText($textBody);

    // If caller provided HTML, wrap it; if not, generate a simple HTML body from the text so the logo shows.
    if ($htmlBody !== null && trim((string)$htmlBody) !== '') {
        $htmlBody = wrapEmailHtml($htmlBody);
    } else {
        $safeText = htmlspecialchars((string)$textBody);
        // convert newlines -> <br> for readability
        $safeText = nl2br($safeText, false);
        $htmlBody = wrapEmailHtml('<div style="white-space:normal;">' . $safeText . '</div>');
    }

    $payload = [
        'From' => $from,
        'To' => $to,
        'Subject' => $subject,
        'TextBody' => (string)$textBody,
        'HtmlBody' => (string)$htmlBody,
    ];

    if ($replyTo) $payload['ReplyTo'] = $replyTo;

    // Attachments format:
    // [
    //   ['Name'=>'Report.pdf','Content'=>base64,'ContentType'=>'application/pdf']
    // ]
    if (is_array($attachments) && count($attachments) > 0) {
        $payload['Attachments'] = $attachments;
    }

    $ch = curl_init('https://api.postmarkapp.com/email');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'Content-Type: application/json',
            'X-Postmark-Server-Token: ' . $token,
        ],
        CURLOPT_POSTFIELDS => json_encode($payload),
    ]);

    if (postmarkShouldDisableTlsVerification()) {
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        error_log('Postmark TLS verification disabled for local runtime.');
    }

    $resp = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($resp === false) {
        error_log("Postmark curl error: " . $err);
        return ['ok'=>false, 'error'=>'curl_error'];
    }

    $data = json_decode($resp, true);
    if ($http < 200 || $http >= 300) {
        error_log("Postmark send failed HTTP $http resp=" . $resp);
        return ['ok'=>false, 'http'=>$http, 'postmark'=>$data ?: $resp];
    }

    return ['ok'=>true, 'http'=>$http, 'postmark'=>$data];
}


function opsNotifyMarkerPathForUser($email) {
    $userFile = ($GLOBALS['userDir'] ?? (storageDir('users'))) . getUserFilename($email);
    return $userFile . '.ops_notified_signup';
}

function opsNotifyMarkerPathForProject($targetDir, $type) {
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $safeType = preg_replace('/[^a-z0-9_\-]/', '_', strtolower((string)$type));
    return $targetDir . "ops_notified_{$safeType}.json";
}

function opsNotifyOnce($markerPath, $subject, $text, $html) {
    // De-dupe
    if ($markerPath && file_exists($markerPath)) return true;

    $to = $GLOBALS['OPS_NOTIFY_TO'] ?? null;
    if (!$to) return false;

    $ret = postmarkSendEmail(
        $to,
        $subject,
        $text,
        $html,
        $GLOBALS['POSTMARK_DEFAULT_FROM'] ?? 'noreply@1m8.ai',
        $GLOBALS['POSTMARK_DEFAULT_REPLYTO'] ?? null
    );

    // Mark even if Postmark fails (avoid spam loops)
    if ($markerPath) {
        @file_put_contents($markerPath, json_encode([
            'ts' => gmdate('c'),
            'ok' => !empty($ret['ok']),
            'http' => $ret['http'] ?? null,
            'postmark' => $ret['postmark'] ?? null,
        ], JSON_PRETTY_PRINT));
    }

    if (empty($ret['ok'])) {
        error_log("Ops notify failed subject={$subject} ret=" . json_encode($ret));
        return false;
    }

    return true;
}

function opsNotifyNewSignup($email, $name, $company, $phone) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return false;

    $marker = opsNotifyMarkerPathForUser($email);

    $subject = "New signup: " . $email;
    $text =
"New user signup

Email: {$email}
Name: " . ((string)$name ?: '-') . "
Company: " . ((string)$company ?: '-') . "
Phone: " . ((string)$phone ?: '-') . "
When: " . date('Y-m-d H:i:s') . "
";
    $html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; font-size:14px; line-height:1.45; color:#111;">' .
            '<p style="margin:0 0 10px;"><b>New user signup</b></p>' .
            '<div style="padding:12px 14px; border:1px solid #eee; border-radius:12px;">' .
                '<div><b>Email:</b> ' . htmlspecialchars($email) . '</div>' .
                '<div><b>Name:</b> ' . htmlspecialchars(((string)$name ?: '-')) . '</div>' .
                '<div><b>Company:</b> ' . htmlspecialchars(((string)$company ?: '-')) . '</div>' .
                '<div><b>Phone:</b> ' . htmlspecialchars(((string)$phone ?: '-')) . '</div>' .
                '<div><b>When:</b> ' . htmlspecialchars(date('Y-m-d H:i:s')) . '</div>' .
            '</div>' .
        '</div>';

    return opsNotifyOnce($marker, $subject, $text, $html);
}

function opsNotifyNewRequest($targetDir, $m) {
    if (!empty($m['is_filler'])) return true;
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $marker = opsNotifyMarkerPathForProject($targetDir, 'new_request');

    $folder = (string)($m['id'] ?? '');
    $addr   = (string)($m['address'] ?? 'Unknown address');
    $owner  = (string)($m['owner_email'] ?? '');
    $issuerEmail = (string)($m['issuer']['email'] ?? '');
    $issuerName  = (string)($m['issuer']['name'] ?? '');
    $team   = (string)($m['team_id'] ?? 'default');

    $reviewUrl = $GLOBALS['BACKEND_URL'];

    $subject = "New request submitted: " . ($addr ?: $folder ?: 'New request');
    $text =
"New request submitted

Address: " . ($addr ?: '-') . "
Folder: " . ($folder ?: '-') . "
Owner: " . ($owner ?: '-') . "
Issuer: " . ($issuerName ?: '-') . " <" . ($issuerEmail ?: '-') . ">
Team: " . ($team ?: '-') . "
When: " . date('Y-m-d H:i:s') . "

Review: {$reviewUrl}
";
    $html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; font-size:14px; line-height:1.45; color:#111;">' .
            '<p style="margin:0 0 10px;"><b>New request submitted</b></p>' .
            '<div style="padding:12px 14px; border:1px solid #eee; border-radius:12px;">' .
                '<div><b>Address:</b> ' . htmlspecialchars($addr ?: '-') . '</div>' .
                '<div><b>Folder:</b> ' . htmlspecialchars($folder ?: '-') . '</div>' .
                '<div><b>Owner:</b> ' . htmlspecialchars($owner ?: '-') . '</div>' .
                '<div><b>Issuer:</b> ' . htmlspecialchars($issuerName ?: '-') . ' &lt;' . htmlspecialchars($issuerEmail ?: '-') . '&gt;</div>' .
                '<div><b>Team:</b> ' . htmlspecialchars($team ?: '-') . '</div>' .
                '<div><b>When:</b> ' . htmlspecialchars(date('Y-m-d H:i:s')) . '</div>' .
            '</div>' .
            '<a href="' . htmlspecialchars($reviewUrl) . '" style="display:inline-block; margin-top:12px; padding:10px 14px; background:#db0000; color:#fff; text-decoration:none; border-radius:10px; font-weight:700;">Review job</a>' .
        '</div>';

    return opsNotifyOnce($marker, $subject, $text, $html);
}

function opsNotifyNewQaItem($targetDir, $m) {
    return true;
    if (!empty($m['is_filler'])) return true;
    $targetDir = rtrim((string)$targetDir, '/\\') . '/';
    $marker = opsNotifyMarkerPathForProject($targetDir, 'new_qa_item');

    $folder = (string)($m['id'] ?? '');
    $addr   = (string)($m['address'] ?? 'Unknown address');

    $drafterEmail = (string)($m['assigned_to_email'] ?? '');
    $drafterName  = (string)($m['assigned_to_name'] ?? '');

    $issuerEmail = (string)($m['issuer']['email'] ?? '');
    $issuerName  = (string)($m['issuer']['name'] ?? '');

    $uploadedAt = (string)($m['uploaded_at'] ?? date('Y-m-d H:i:s'));

    $reviewUrl = $GLOBALS['BACKEND_URL'];

    $subject = "New QA item: " . ($addr ?: $folder ?: 'QA item');
    $text =
"New QA item submitted

Address: " . ($addr ?: '-') . "
Folder: " . ($folder ?: '-') . "
Drafter: " . ($drafterName ?: '-') . " <" . ($drafterEmail ?: '-') . ">
Submitter: " . ($issuerName ?: '-') . " <" . ($issuerEmail ?: '-') . ">
Uploaded at: " . ($uploadedAt ?: '-') . "

Review: {$reviewUrl}
";
    $html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; font-size:14px; line-height:1.45; color:#111;">' .
            '<p style="margin:0 0 10px;"><b>New QA item submitted</b></p>' .
            '<div style="padding:12px 14px; border:1px solid #eee; border-radius:12px;">' .
                '<div><b>Address:</b> ' . htmlspecialchars($addr ?: '-') . '</div>' .
                '<div><b>Folder:</b> ' . htmlspecialchars($folder ?: '-') . '</div>' .
                '<div><b>Drafter:</b> ' . htmlspecialchars($drafterName ?: '-') . ' &lt;' . htmlspecialchars($drafterEmail ?: '-') . '&gt;</div>' .
                '<div><b>Submitter:</b> ' . htmlspecialchars($issuerName ?: '-') . ' &lt;' . htmlspecialchars($issuerEmail ?: '-') . '&gt;</div>' .
                '<div><b>Uploaded at:</b> ' . htmlspecialchars($uploadedAt ?: '-') . '</div>' .
            '</div>' .
            '<a href="' . htmlspecialchars($reviewUrl) . '" style="display:inline-block; margin-top:12px; padding:10px 14px; background:#db0000; color:#fff; text-decoration:none; border-radius:10px; font-weight:700;">Review job</a>' .
        '</div>';

    return opsNotifyOnce($marker, $subject, $text, $html);
}

function sendFirstLoginWelcomeEmail($email, $name) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return ['ok' => false, 'error' => 'missing_email'];
    $displayName = (trim((string)$name) !== '') ? trim((string)$name) : $email;
    $portalUrl = rtrim(($GLOBALS['BASE_URL'] ?? 'https://app.1m8.ai/portal'), '/');
    $subject = "Welcome to FirstMate — here's how to get started";
    $text =
"Hi {$displayName},

Welcome to FirstMate! Your account is verified and ready to go. Here's a quick rundown of how everything works so you can hit the ground running.

Get started: {$portalUrl}

HOW IT WORKS
FirstMate delivers professional roof measurement reports. You submit an address, we handle the rest — measurements, diagrams, and a branded PDF report delivered to your inbox.

SUBMITTING YOUR FIRST ORDER
1. Click \"New Request\" from your dashboard
2. Choose a project type: Residential (\$7 flat), Commercial (\$12/structure), or Multi-Family (\$12/structure)
3. Enter the property address — the map will zoom to the location
4. Place a pin on each structure you want measured
5. Confirm and submit — you'll receive your report by email

WHAT'S IN A REPORT
Each report includes a cover page with your company branding, top-down and 3D views, elevations, pitch map, area breakdowns, material estimates, and a summary page. You can customize which pages appear in Company Settings > Reports.

MAKE IT YOURS
Head to Company Settings to upload your logo and set your brand colors. Every report you order will be branded with your company identity automatically.

USEFUL THINGS TO KNOW
- You can CC additional email addresses on any order so your team gets the report too
- Auto top-up keeps your account funded automatically (set it up in Billing)
- You can invite team members and control exactly what each person can access
- Residential orders include secondary structures (garages, sheds) at no extra cost
- Reports are processed during business hours (Mon-Sat, Pacific time)

If you ever get stuck, just reply to this email — we're here to help.

— The FirstMate Team
";
    /*
    Disabled welcome-email promo copy for now so it is not sent:

    YOUR 50% BONUS - TODAY ONLY
    As a new customer, your first credit load gets a 50% bonus match. Load \$250, get \$375. This is a one-time offer, so take advantage of it when you load your first credits.
    */
    $html =
        '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif; color:#1a1a1a; line-height:1.6; max-width:600px; margin:0 auto; font-size:14px;">' .

        '<p>Hi ' . htmlspecialchars($displayName) . ',</p>' .
        '<p>Welcome to <b>FirstMate</b>! Your account is verified and ready to go. Here\'s a quick rundown of how everything works so you can hit the ground running.</p>' .

        // CTA button — right up front so they know where to go
        '<div style="margin:24px 0 28px;">' .
            '<a href="' . htmlspecialchars($portalUrl) . '" style="display:inline-block; padding:14px 28px; background:#db0000; color:#fff; text-decoration:none; border-radius:10px; font-weight:800; font-size:15px;">Go to Your Dashboard</a>' .
        '</div>' .

        // How it works
        '<h3 style="font-size:15px; font-weight:800; margin:0 0 8px; color:#1a1a1a;">How It Works</h3>' .
        '<p style="margin:0 0 18px; line-height:1.55;">FirstMate delivers professional roof measurement reports. You submit an address, we handle the rest — measurements, diagrams, and a branded PDF report delivered to your inbox.</p>' .

        // Steps
        '<h3 style="font-size:15px; font-weight:800; margin:0 0 10px; color:#1a1a1a;">Submitting Your First Order</h3>' .
        '<table style="line-height:1.55; margin-bottom:20px; border-collapse:collapse;" cellpadding="0" cellspacing="0">' .
            '<tr><td style="padding:4px 10px 4px 0; vertical-align:top; font-weight:800; color:#db0000;">1.</td><td style="padding:4px 0;">Click <b>"New Request"</b> from your dashboard</td></tr>' .
            '<tr><td style="padding:4px 10px 4px 0; vertical-align:top; font-weight:800; color:#db0000;">2.</td><td style="padding:4px 0;">Choose a project type — <b>Residential</b> ($7 flat), <b>Commercial</b> ($12/structure), or <b>Multi-Family</b> ($12/structure)</td></tr>' .
            '<tr><td style="padding:4px 10px 4px 0; vertical-align:top; font-weight:800; color:#db0000;">3.</td><td style="padding:4px 0;">Enter the property address — the map zooms to the location automatically</td></tr>' .
            '<tr><td style="padding:4px 10px 4px 0; vertical-align:top; font-weight:800; color:#db0000;">4.</td><td style="padding:4px 0;">Place a pin on each structure you want measured</td></tr>' .
            '<tr><td style="padding:4px 10px 4px 0; vertical-align:top; font-weight:800; color:#db0000;">5.</td><td style="padding:4px 0;">Confirm and submit — your report arrives by email</td></tr>' .
        '</table>' .

        /*
        // 50% promo - after they know how to order, before the reference stuff
        '<div style="background:#f3edff; border:1px solid #d4c4f7; border-radius:12px; padding:16px 18px; margin-bottom:24px;">' .
            '<p style="margin:0 0 4px; font-weight:800; font-size:14px; color:#5b21b6;">Your 50% Bonus - Today Only</p>' .
            '<p style="margin:0; color:#44337a; line-height:1.5;">As a new customer, your first credit load gets a <b>50% bonus match</b>. Load $100, get $150. This is a one-time offer, so take advantage of it when you load your first credits.</p>' .
        '</div>' .
        */

        // What's in a report
        '<h3 style="font-size:15px; font-weight:800; margin:0 0 8px; color:#1a1a1a;">What\'s in a Report</h3>' .
        '<p style="margin:0 0 18px; line-height:1.55;">Each report includes a cover page with your company branding, top-down and 3D views, elevations, pitch map, area breakdowns, material estimates, and a summary page. You can customize which pages appear in <b>Company Settings → Reports</b>.</p>' .

        // Make it yours
        '<h3 style="font-size:15px; font-weight:800; margin:0 0 8px; color:#1a1a1a;">Make It Yours</h3>' .
        '<p style="margin:0 0 18px; line-height:1.55;">Head to <b>Company Settings</b> to upload your logo and set your brand colors. Every report you order will be automatically branded with your company identity.</p>' .

        // Good to know
        '<h3 style="font-size:15px; font-weight:800; margin:0 0 8px; color:#1a1a1a;">Useful Things to Know</h3>' .
        '<table style="line-height:1.55; margin-bottom:20px; border-collapse:collapse;" cellpadding="0" cellspacing="0">' .
            '<tr><td style="padding:3px 8px 3px 0; vertical-align:top; color:#db0000;">•</td><td style="padding:3px 0;">You can <b>CC additional email addresses</b> on any order so your team gets the report too</td></tr>' .
            '<tr><td style="padding:3px 8px 3px 0; vertical-align:top; color:#db0000;">•</td><td style="padding:3px 0;"><b>Auto top-up</b> keeps your account funded automatically — set it up in Billing</td></tr>' .
            '<tr><td style="padding:3px 8px 3px 0; vertical-align:top; color:#db0000;">•</td><td style="padding:3px 0;"><b>Invite team members</b> and control exactly what each person can access</td></tr>' .
            '<tr><td style="padding:3px 8px 3px 0; vertical-align:top; color:#db0000;">•</td><td style="padding:3px 0;">Residential orders include secondary structures (garages, sheds) at <b>no extra cost</b></td></tr>' .
            '<tr><td style="padding:3px 8px 3px 0; vertical-align:top; color:#db0000;">•</td><td style="padding:3px 0;">Reports are processed during business hours (Mon–Sat, Pacific time)</td></tr>' .
        '</table>' .

        '<hr style="border:none; border-top:1px solid #eee; margin:20px 0;">' .
        '<p style="color:#888; font-size:13px; line-height:1.45;">If you ever get stuck, just reply to this email — we\'re here to help.</p>' .
        '<p style="color:#888; font-size:13px;">— The FirstMate Team</p>' .

        '</div>';
    // TODO: switch to $email for production
    return postmarkSendEmail($email, $subject, $text, $html);
//     return postmarkSendEmail('notifications@1m8.ai', $subject, $text, $html);
}

// ------------------------------------------------
// ---------------- APPLE KEY STORE --------------
// ------------------------------------------------

function appleKeyFilePath() {
    global $APPLE_KEY_PATH;
    return $APPLE_KEY_PATH;
}

function appleKeyEnsureStore() {
    $path = appleKeyFilePath();

    // default shape now includes "v"
    $init = ['key' => '', 'v' => null, 'updated_at_utc' => null];

    if (!file_exists($path)) {
        @file_put_contents($path, json_encode($init, JSON_PRETTY_PRINT));
        return $init;
    }

    $raw = @file_get_contents($path);
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) $data = [];

    // normalize keys
    if (!array_key_exists('key', $data)) $data['key'] = '';
    if (!array_key_exists('v', $data)) $data['v'] = null;
    if (!array_key_exists('updated_at_utc', $data)) $data['updated_at_utc'] = null;

    // types
    if (!is_string($data['key'])) $data['key'] = '';
    if (!is_null($data['v']) && !is_string($data['v']) && !is_int($data['v'])) $data['v'] = null;
    if (is_int($data['v'])) $data['v'] = (string)$data['v'];
    if (!is_null($data['updated_at_utc']) && !is_string($data['updated_at_utc'])) $data['updated_at_utc'] = null;

    return $data;
}

function appleKeyGetInfo() {
    $s = appleKeyEnsureStore();
    $k = trim((string)($s['key'] ?? ''));
    $v = $s['v'] ?? null;
    $v = is_string($v) ? trim($v) : (is_int($v) ? (string)$v : null);
    $ts = $s['updated_at_utc'] ?? null;
    $ts = is_string($ts) ? trim($ts) : null;

    return [
        'key' => ($k !== '') ? $k : null,
        'v'   => ($v !== '') ? $v : null,
        'updated_at_utc' => ($ts !== '') ? $ts : null
    ];
}

function appleKeySet($newKey) {
    $newKey = trim((string)$newKey);
    if ($newKey === '') return false;

    $path = appleKeyFilePath();
    $nowUtc = gmdate('c');

    // ✅ preserve existing "v" (and any future fields you might add)
    $existing = appleKeyEnsureStore();
    $keepV = $existing['v'] ?? null;
    if (!is_null($keepV) && !is_string($keepV) && !is_int($keepV)) $keepV = null;
    if (is_int($keepV)) $keepV = (string)$keepV;

    $data = [
        'key' => $newKey,
        'v'   => ($keepV !== null && trim((string)$keepV) !== '') ? (string)$keepV : null,
        'updated_at_utc' => $nowUtc
    ];

    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;

    return (@file_put_contents($path, $json) !== false);
}




// ------------------------------------------------
// ---------------- ACTION ROUTING ---------------
// ------------------------------------------------

if (isset($_GET['stripe_webhook']) && $_GET['stripe_webhook'] == '1') {
    handleStripeWebhook();
}

$action = $_POST['action'] ?? $_GET['action'] ?? '';
// logHitToFile('server.php');

if (strpos((string)$action, 'lead_') === 0 && session_status() === PHP_SESSION_ACTIVE) {
    @session_write_close();
}

if (handleConfigActions($action)) { exit; }
if (handleOrganizationActions($action)) { exit; }
if (handleUserActions($action)) { exit; }
if (fm_server_try_legacy_module_handler($action, '_referrals.php', 'handleReferralActions')) { exit; }
if (fm_server_try_legacy_module_handler($action, '_crm_settings.php', 'handleCrmSettingsActions')) { exit; }
if (fm_server_try_legacy_module_handler($action, '_lead.php', 'handleLeadActions')) { exit; }
if (fm_server_try_legacy_module_handler($action, '_commissions.php', 'handleCommissionActions')) { exit; }
if (fm_server_try_legacy_module_handler($action, '_call_scripts.php', 'handleCallScriptActions')) { exit; }
if (fm_server_try_legacy_module_handler($action, '_territory.php', 'handleTerritoryActions')) { exit; }
if (handleStripeActions($action)) { exit; }
if (handleProjectActions($action)) { exit; }
if ($action === 'project_org_context') {
    $projectId = trim((string)($_POST['folder'] ?? $_GET['folder'] ?? ''));
    if ($projectId === '') {
        echo json_encode(['success' => false, 'error' => 'Missing project']);
        exit;
    }
    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) {
        echo json_encode(['success' => false, 'error' => 'Project not found']);
        exit;
    }
    echo json_encode([
        'success' => true,
        'organization' => fm_project_organization_context($manifest)
    ]);
    exit;
}



// ------------------------------------------------------------
// ORG SETTINGS (CUSTOMER-FACING) + ORG USERS (CUSTOMER-FACING)
// Assumptions:
// - Users have organization_id
// - Org manifest has users[] (user ids) but we still scan users/ for safety
// - Permissions live on user file: org_permissions.level + org_permissions.items
// ------------------------------------------------------------


function sanitizeName($s) {
    $s = trim((string)$s);
    $s = preg_replace('/\s+/', ' ', $s);
    return substr($s, 0, 120);
}

function sanitizeEmail($s) {
    $s = strtolower(trim((string)$s));
    if ($s === '') return '';
    if (!filter_var($s, FILTER_VALIDATE_EMAIL)) return '';
    return $s;
}



// ------------------------------------------------
// --------------- APPLE KEY ACTIONS ------------
// ------------------------------------------------

if ($action === 'get_apple_key_info') {
    if (!isset($_SESSION['user_email'])) { http_response_code(403); echo json_encode(['success'=>false,'error'=>'Not logged in']); exit; }
    $info = appleKeyGetInfo();
    echo json_encode([
        'success'=>true,
        'key'=>$info['key'],
        'v'=>$info['v'],
        'updated_at_utc'=>$info['updated_at_utc']
    ]);
    exit;
}


if ($action === 'set_apple_key') {
    if (!isAdmin()) { http_response_code(403); echo json_encode(['success'=>false,'error'=>'Unauthorized']); exit; }
    $k = $_POST['key'] ?? '';
    if (!appleKeySet($k)) { echo json_encode(['success'=>false,'error'=>'Invalid key or write failed']); exit; }
    $info = appleKeyGetInfo();
    echo json_encode(['success'=>true,'updated_at_utc'=>$info['updated_at_utc']]);
    exit;
}


// ------------------------------------------------
// ---------------- COUPON ADMIN ------------------
// ------------------------------------------------

// Admin create coupon (for future admin app)
// POST: action=coupon_admin_create
// fields: code (optional), credits_total (required), credits_per_redeem (optional), max_redemptions (optional), once_per_user (optional)
if ($action === 'coupon_admin_create') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $creditsTotal = (int)($_POST['credits_total'] ?? 0);
    if ($creditsTotal < 1) die(json_encode(['success'=>false,'error'=>'credits_total must be >= 1']));

    $creditsPer = (int)($_POST['credits_per_redeem'] ?? 0);
    if ($creditsPer < 1) $creditsPer = $creditsTotal;

    $maxRed = (int)($_POST['max_redemptions'] ?? 0);
    if ($maxRed < 1) $maxRed = 1;

    $oncePerUser = isset($_POST['once_per_user']) ? filter_var($_POST['once_per_user'], FILTER_VALIDATE_BOOLEAN) : true;

    $raw = trim((string)($_POST['code'] ?? ''));
    if ($raw === '') {
        $raw = 'FM-' . strtoupper(bin2hex(random_bytes(4))) . '-' . strtoupper(bin2hex(random_bytes(3)));
    }

    $norm = couponNormalize($raw);
    if (strlen($norm) < 6) die(json_encode(['success'=>false,'error'=>'Code too short']));

    $hash = couponHash($norm);
    $path = couponPathByHash($hash);

    $out = withCouponLock(function() use ($path, $hash, $norm, $creditsTotal, $creditsPer, $maxRed, $oncePerUser) {
        if (file_exists($path)) return ['success'=>false,'error'=>'Coupon already exists'];

        $obj = [
            'code_hash' => $hash,
            'created_at' => gmdate('c'),
            'created_by' => $_SESSION['user_email'] ?? null,

            'status' => 'active', // active | disabled | exhausted

            'credits_total' => $creditsTotal,
            'credits_remaining' => $creditsTotal,

            'credits_per_redeem' => $creditsPer,
            'max_redemptions' => $maxRed,
            'redemptions_count' => 0,

            'once_per_user' => $oncePerUser,
            'redeemed_by' => [],
            'redemptions' => [],
        ];

        if (@file_put_contents($path, json_encode($obj, JSON_PRETTY_PRINT)) === false) {
            return ['success'=>false,'error'=>'Write failed'];
        }

        return ['success'=>true, 'code'=>$norm, 'credits_total'=>$creditsTotal, 'max_redemptions'=>$maxRed];
    });

    if (!$out) die(json_encode(['success'=>false,'error'=>'Lock failed']));
    echo json_encode($out);
    exit;
}

// Admin list coupons (metadata only)
if ($action === 'coupon_admin_list') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $items = [];
    foreach (scandir($GLOBALS['couponDir']) as $f) {
        if ($f === '.' || $f === '..') continue;
        if (strpos($f, 'coupon_') !== 0 || pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;

        $p = $GLOBALS['couponDir'] . $f;
        $d = json_decode(@file_get_contents($p), true);
        if (!is_array($d)) continue;

        $items[] = [
            'code_hash' => $d['code_hash'] ?? null,
            'status' => $d['status'] ?? 'unknown',
            'credits_total' => (int)($d['credits_total'] ?? 0),
            'credits_remaining' => (int)($d['credits_remaining'] ?? 0),
            'redemptions_count' => (int)($d['redemptions_count'] ?? 0),
            'max_redemptions' => (int)($d['max_redemptions'] ?? 0),
            'created_at' => $d['created_at'] ?? null,
            'created_by' => $d['created_by'] ?? null,
        ];
    }

    usort($items, function($a,$b){
        return strcmp((string)($b['created_at'] ?? ''), (string)($a['created_at'] ?? ''));
    });

    echo json_encode(['success'=>true,'coupons'=>$items]);
    exit;
}

// Admin disable coupon by code_hash
if ($action === 'coupon_admin_disable') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $hash = preg_replace('/[^a-f0-9]/', '', strtolower((string)($_POST['code_hash'] ?? '')));
    if ($hash === '') die(json_encode(['success'=>false,'error'=>'Missing code_hash']));

    $path = couponPathByHash($hash);

    $out = withCouponLock(function() use ($path) {
        if (!file_exists($path)) return ['success'=>false,'error'=>'Not found'];
        $d = json_decode(@file_get_contents($path), true);
        if (!is_array($d)) return ['success'=>false,'error'=>'Bad JSON'];

        $d['status'] = 'disabled';
        $d['disabled_at'] = gmdate('c');
        $d['disabled_by'] = $_SESSION['user_email'] ?? null;

        @file_put_contents($path, json_encode($d, JSON_PRETTY_PRINT));
        return ['success'=>true];
    });

    if (!$out) die(json_encode(['success'=>false,'error'=>'Lock failed']));
    echo json_encode($out);
    exit;
}

// ------------------------------------------------
// ---------------- COUPON ADMIN (EXTRA) ----------
// ------------------------------------------------

// Admin get coupon details (includes redemptions list)
// POST: action=coupon_admin_get, code_hash
if ($action === 'coupon_admin_get') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $hash = preg_replace('/[^a-f0-9]/', '', strtolower((string)($_POST['code_hash'] ?? '')));
    if ($hash === '') die(json_encode(['success'=>false,'error'=>'Missing code_hash']));

    $path = couponPathByHash($hash);
    if (!file_exists($path)) die(json_encode(['success'=>false,'error'=>'Not found']));

    $d = json_decode(@file_get_contents($path), true);
    if (!is_array($d)) die(json_encode(['success'=>false,'error'=>'Bad JSON']));

    echo json_encode(['success'=>true,'coupon'=>$d]);
    exit;
}

// Admin update coupon (edit fields)
// POST: action=coupon_admin_update, code_hash, status, credits_total, credits_per_redeem, max_redemptions, once_per_user
if ($action === 'coupon_admin_update') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $hash = preg_replace('/[^a-f0-9]/', '', strtolower((string)($_POST['code_hash'] ?? '')));
    if ($hash === '') die(json_encode(['success'=>false,'error'=>'Missing code_hash']));

    $status = strtolower(trim((string)($_POST['status'] ?? 'active')));
    if (!in_array($status, ['active','disabled'], true)) $status = 'active';

    $creditsTotal = (int)($_POST['credits_total'] ?? 0);
    if ($creditsTotal < 1) $creditsTotal = 1;

    $creditsPer = (int)($_POST['credits_per_redeem'] ?? 0);
    if ($creditsPer < 1) $creditsPer = 1;

    $maxRed = (int)($_POST['max_redemptions'] ?? 0);
    if ($maxRed < 1) $maxRed = 1;

    $oncePerUser = isset($_POST['once_per_user'])
        ? filter_var($_POST['once_per_user'], FILTER_VALIDATE_BOOLEAN)
        : true;

    $path = couponPathByHash($hash);

    $out = withCouponLock(function() use ($path, $status, $creditsTotal, $creditsPer, $maxRed, $oncePerUser) {
        if (!file_exists($path)) return ['success'=>false,'error'=>'Not found'];

        $c = json_decode(@file_get_contents($path), true);
        if (!is_array($c)) return ['success'=>false,'error'=>'Bad JSON'];

        // Preserve usage: used = total - remaining
        $oldTotal = (int)($c['credits_total'] ?? 0);
        $oldRem   = (int)($c['credits_remaining'] ?? 0);
        $used     = max(0, $oldTotal - $oldRem);

        // Recompute remaining based on new total (can't go below used)
        if ($creditsTotal < $used) {
            $creditsTotal = $used;
            $newRemaining = 0;
        } else {
            $newRemaining = $creditsTotal - $used;
        }

        // Apply edits
        $c['credits_total']       = $creditsTotal;
        $c['credits_remaining']   = $newRemaining;
        $c['credits_per_redeem']  = $creditsPer;
        $c['max_redemptions']     = $maxRed;
        $c['once_per_user']       = $oncePerUser;

        // Status logic (exhausted is derived)
        $redCount = (int)($c['redemptions_count'] ?? 0);
        if ($newRemaining <= 0 || $redCount >= $maxRed) {
            $c['status'] = 'exhausted';
            if (empty($c['exhausted_at'])) $c['exhausted_at'] = gmdate('c');
        } else {
            $c['status'] = $status; // active|disabled
        }

        $c['updated_at'] = gmdate('c');
        $c['updated_by'] = $_SESSION['user_email'] ?? null;

        if (@file_put_contents($path, json_encode($c, JSON_PRETTY_PRINT)) === false) {
            return ['success'=>false,'error'=>'Write failed'];
        }

        return ['success'=>true];
    });

    if (!$out) die(json_encode(['success'=>false,'error'=>'Lock failed']));
    echo json_encode($out);
    exit;
}

// Admin delete coupon file
// POST: action=coupon_admin_delete, code_hash
if ($action === 'coupon_admin_delete') {
    if (!canManageCoupons()) die(json_encode(['success'=>false,'error'=>'Unauthorized']));

    $hash = preg_replace('/[^a-f0-9]/', '', strtolower((string)($_POST['code_hash'] ?? '')));
    if ($hash === '') die(json_encode(['success'=>false,'error'=>'Missing code_hash']));

    $path = couponPathByHash($hash);

    $out = withCouponLock(function() use ($path) {
        if (!file_exists($path)) return ['success'=>false,'error'=>'Not found'];
        if (@unlink($path) === false) return ['success'=>false,'error'=>'Delete failed'];
        return ['success'=>true];
    });

    if (!$out) die(json_encode(['success'=>false,'error'=>'Lock failed']));
    echo json_encode($out);
    exit;
}


// ------------------------------------------------
// ---------------- COUPON REDEEM -----------------
// ------------------------------------------------

if ($action === 'coupon_redeem') {
    if (!isset($_SESSION['user_email'])) die(json_encode(['success'=>false,'error'=>'Not logged in']));

    $rl = couponRateLimitOrFail();
    if (empty($rl['ok'])) die(json_encode(['success'=>false,'error'=>$rl['error']]));

    $email = strtolower(trim($_SESSION['user_email']));
    $raw = (string)($_POST['code'] ?? '');
    $norm = couponNormalize($raw);

    if ($norm === '' || strlen($norm) < 6) die(json_encode(['success'=>false,'error'=>'Invalid code']));

    $hash = couponHash($norm);
    $path = couponPathByHash($hash);

    $ip = $_SERVER['REMOTE_ADDR'] ?? null;
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? null;

    $out = withCouponLock(function() use ($path, $hash, $email, $ip, $ua) {
        if (!file_exists($path)) return ['success'=>false,'error'=>'Invalid code'];

        $c = json_decode(@file_get_contents($path), true);
        if (!is_array($c)) return ['success'=>false,'error'=>'Invalid code'];

        $status = (string)($c['status'] ?? 'active');
        if ($status !== 'active') {
            if ($status === 'exhausted') return ['success'=>false,'error'=>'Coupon already used'];
            return ['success'=>false,'error'=>'Coupon not active'];
        }

        $remaining = (int)($c['credits_remaining'] ?? 0);
        if ($remaining < 1) {
            $c['status'] = 'exhausted';
            @file_put_contents($path, json_encode($c, JSON_PRETTY_PRINT));
            return ['success'=>false,'error'=>'Coupon already used'];
        }

        $redCount = (int)($c['redemptions_count'] ?? 0);
        $maxRed   = (int)($c['max_redemptions'] ?? 1);
        if ($redCount >= $maxRed) {
            $c['status'] = 'exhausted';
            @file_put_contents($path, json_encode($c, JSON_PRETTY_PRINT));
            return ['success'=>false,'error'=>'Coupon already used'];
        }

        $oncePerUser = !empty($c['once_per_user']);
        $redeemedBy = $c['redeemed_by'] ?? [];
        if (!is_array($redeemedBy)) $redeemedBy = [];

        if ($oncePerUser && in_array($email, $redeemedBy, true)) {
            return ['success'=>false,'error'=>'You already redeemed this code'];
        }

        $per = (int)($c['credits_per_redeem'] ?? $remaining);
        if ($per < 1) $per = $remaining;
        $grant = min($per, $remaining);

        // Apply credits (ORG if user has org)
        $add = creditsAddByEmail($email, $grant, 'coupon_redeem', [
            'coupon_hash' => $hash,
        ]);
        if (empty($add['ok'])) return ['success'=>false,'error'=>'Credit apply failed'];

        // Update coupon state
        $c['credits_remaining'] = $remaining - $grant;
        $c['redemptions_count'] = $redCount + 1;

        $redeemedBy[] = $email;
        $c['redeemed_by'] = array_values(array_unique($redeemedBy));

        if (!isset($c['redemptions']) || !is_array($c['redemptions'])) $c['redemptions'] = [];
        $c['redemptions'][] = [
            'ts' => gmdate('c'),
            'email' => $email,
            'credits' => $grant,
            'scope' => $add['scope'] ?? null,
            'org_id' => $add['org_id'] ?? null,
            'ip' => $ip,
            'ua' => $ua ? substr($ua, 0, 180) : null,
        ];

        if ((int)$c['credits_remaining'] <= 0 || (int)$c['redemptions_count'] >= (int)$c['max_redemptions']) {
            $c['status'] = 'exhausted';
            $c['exhausted_at'] = gmdate('c');
        }

        @file_put_contents($path, json_encode($c, JSON_PRETTY_PRINT));

        return [
            'success'=>true,
            'credits_added'=>$grant,
            'credits_scope'=>($add['scope'] ?? 'user'),
            'org_id'=>($add['org_id'] ?? null),
            'new_balance'=>(int)($add['new_balance'] ?? 0),
        ];
    });

    if (!$out) die(json_encode(['success'=>false,'error'=>'Lock failed']));
    echo json_encode($out);
    exit;
}


// ------------------------------------------------
// ---------------- TUTORIAL ACTIONS -------------
// ------------------------------------------------

if ($action === 'fetch_curriculum') {
    $courseId = tutorialCourseIdFromRequest();
    $curriculumFile = tutorialCurriculumFile($courseId);
    $curriculum = file_exists($curriculumFile) ? json_decode(file_get_contents($curriculumFile), true) : ['chapters' => []];

    $userEmail = $_SESSION['user_email'] ?? '';
    $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($userEmail)));
    $progress = fm_tutorial_refresh_test_attempt_scores($courseId, $userEmail);

    echo json_encode([
        'success' => true,
        'course_id' => $courseId,
        'curriculum' => $curriculum,
        'progress' => $progress,
        'is_admin' => isAdmin()
    ]);
    exit;
}

if ($action === 'save_curriculum') {
    if (!isAdmin()) die(json_encode(['error' => 'Unauthorized']));
    $courseId = tutorialCourseIdFromRequest();
    $data = $_POST['curriculum'];
    file_put_contents(tutorialCurriculumFile($courseId), $data);
    echo json_encode(['success' => true, 'course_id' => $courseId]);
    exit;
}

if ($action === 'upload_tutorial_pdf') {
    if (!isAdmin()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));

    if (empty($_FILES['file']) || !is_array($_FILES['file'])) {
        die(json_encode(['success' => false, 'error' => 'No file uploaded']));
    }

    $file = $_FILES['file'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        die(json_encode(['success' => false, 'error' => 'Upload failed']));
    }

    $originalName = (string)($file['name'] ?? 'guide.pdf');
    $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if ($ext !== 'pdf') {
        die(json_encode(['success' => false, 'error' => 'Only PDF uploads are allowed']));
    }

    $tmpName = (string)($file['tmp_name'] ?? '');
    $mime = '';
    if ($tmpName !== '' && file_exists($tmpName) && function_exists('finfo_open')) {
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo) {
            $mime = (string)finfo_file($finfo, $tmpName);
            finfo_close($finfo);
        }
    }
    if ($mime !== '' && $mime !== 'application/pdf') {
        die(json_encode(['success' => false, 'error' => 'Uploaded file is not a valid PDF']));
    }

    $courseId = tutorialCourseIdFromRequest();
    $assetDir = tutorialAssetDir($courseId);

    $baseName = pathinfo($originalName, PATHINFO_FILENAME);
    $slug = preg_replace('/[^a-zA-Z0-9_\-]+/', '_', $baseName);
    $slug = trim((string)$slug, '_');
    if ($slug === '') $slug = 'guide';

    $filename = $slug . '_' . date('Ymd_His') . '_' . substr(md5(uniqid('', true)), 0, 8) . '.pdf';
    $destPath = $assetDir . $filename;

    if (!@move_uploaded_file($tmpName, $destPath)) {
        die(json_encode(['success' => false, 'error' => 'Could not save uploaded PDF']));
    }

    echo json_encode([
        'success' => true,
        'course_id' => $courseId,
        'filename' => $filename,
        'url' => tutorialAssetUrl($courseId, $filename),
        'title' => trim(str_replace(['_', '-'], ' ', $baseName)),
    ]);
    exit;
}

if ($action === 'start_tutorial_project') {
    global $userDir;

    if (!isset($_SESSION['user_email'])) die(json_encode(['error' => 'Not logged in']));

    $courseId = tutorialCourseIdFromRequest();
    $sourceProjectId = $_POST['project_id'] ?? $_POST['source_project_id'] ?? $_POST['master_id'] ?? '';
    $sourceProjectId = fm_tutorial_sanitize_project_id($sourceProjectId);
    if ($sourceProjectId && !fm_tutorial_is_tutorial_project_id($sourceProjectId)) {
        $created = fm_tutorial_create_project_instance($sourceProjectId, $courseId, (string)$_SESSION['user_email'], $_POST['chapter_id'] ?? null, [
            'curriculum_project_id' => $_POST['curriculum_project_id'] ?? $_POST['practice_project_id'] ?? '',
            'practice_project_name' => $_POST['practice_project_name'] ?? $_POST['project_name'] ?? ''
        ]);
        if (!empty($created['success']) || empty($_POST['master_id'])) {
            echo json_encode($created);
            exit;
        }
    }

    $masterId = $_POST['master_id'] ?? '';
    if (!$masterId) die(json_encode(['error' => 'No master ID']));

    $userEmail = $_SESSION['user_email'];
    $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($userEmail)));

    $userFolder = tutorialUserDir($courseId, $userSafe);
    if (!file_exists($userFolder)) mkdir($userFolder, 0777, true);

    $masterPath = tutorialEnsureCourseDirs($courseId) . 'master/' . $masterId . '/';
    if (!file_exists($masterPath)) die(json_encode(['error' => 'Master project not found']));

    $newInstanceId = md5($userEmail . $masterId . time());
    $destPath = $userFolder . $newInstanceId . '/';

    recurseCopy($masterPath, $destPath);

    $mFile = $destPath . 'manifest.json';
    if (file_exists($mFile)) {
        $m = json_decode(file_get_contents($mFile), true);
        if (!is_array($m)) $m = [];
        $m['owner_email'] = $userEmail;
        $m['is_tutorial_instance'] = true;
        $m['original_master_id'] = $masterId;
        $m['tutorial_course_id'] = $courseId;
        $m['created_at'] = date('Y-m-d H:i:s');
        saveManifest($mFile, $m);
    }

    $userFile = $userDir . getUserFilename($userEmail);
    if (file_exists($userFile)) {
        $uData = json_decode(file_get_contents($userFile), true);
        if (!isset($uData['projects'])) $uData['projects'] = [];
        if (!in_array($newInstanceId, $uData['projects'])) {
            $uData['projects'][] = $newInstanceId;
            file_put_contents($userFile, json_encode($uData, JSON_PRETTY_PRINT));
        }
    }

    echo json_encode(['success' => true, 'folder' => $newInstanceId, 'course_id' => $courseId]);
    exit;
}

if ($action === 'start_tutorial_test_attempt') {
    if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
    $courseId = tutorialCourseIdFromRequest();
    $chapterId = $_POST['chapter_id'] ?? $_POST['chapter'] ?? '';
    $testId = $_POST['test_id'] ?? $_POST['test'] ?? null;
    echo json_encode(fm_tutorial_start_test_attempt($courseId, (string)$_SESSION['user_email'], $chapterId, $testId));
    exit;
}

if ($action === 'start_tutorial_draft_reject_round') {
    if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
    $courseId = tutorialCourseIdFromRequest();
    $chapterId = $_POST['chapter_id'] ?? $_POST['chapter'] ?? '';
    $roundId = $_POST['round_id'] ?? $_POST['round'] ?? null;
    echo json_encode(fm_tutorial_start_draft_reject_round($courseId, (string)$_SESSION['user_email'], $chapterId, $roundId));
    exit;
}

if ($action === 'upload_tutorial_file') {
    if (!isAdmin()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
    if (empty($_FILES['file']) || !is_array($_FILES['file'])) {
        die(json_encode(['success' => false, 'error' => 'No file uploaded']));
    }
    $file = $_FILES['file'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        die(json_encode(['success' => false, 'error' => 'Upload failed']));
    }

    $courseId = tutorialCourseIdFromRequest();
    $assetDir = tutorialAssetDir($courseId);
    $originalName = (string)($file['name'] ?? 'tutorial_file');
    $safeName = fm_tutorial_sanitize_file_name($originalName, 'tutorial_file');
    $dot = strrpos($safeName, '.');
    $base = $dot === false ? $safeName : substr($safeName, 0, $dot);
    $ext = $dot === false ? '' : substr($safeName, $dot);
    $filename = $base . '_' . date('Ymd_His') . '_' . substr(md5(uniqid('', true)), 0, 8) . $ext;
    $destPath = $assetDir . $filename;

    if (!@move_uploaded_file((string)$file['tmp_name'], $destPath)) {
        die(json_encode(['success' => false, 'error' => 'Could not save uploaded file']));
    }

    echo json_encode([
        'success' => true,
        'course_id' => $courseId,
        'filename' => $filename,
        'url' => tutorialAssetUrl($courseId, $filename),
        'title' => trim(str_replace(['_', '-'], ' ', pathinfo($originalName, PATHINFO_FILENAME))),
    ]);
    exit;
}

if ($action === 'list_tutorial_projects') {
    if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
    $courseId = tutorialCourseIdFromRequest();
    echo json_encode([
        'success' => true,
        'course_id' => $courseId,
        'projects' => fm_tutorial_list_user_projects((string)$_SESSION['user_email'], $courseId)
    ]);
    exit;
}

if ($action === 'create_master_project') {
    global $GOOGLE_API_KEY, $GEMINI_API_KEY;

    if (!isAdmin()) die(json_encode(['error' => 'Unauthorized']));

    $courseId = tutorialCourseIdFromRequest();
    $address = $_POST['address'];
    $folderId = getFolder($address . '_MASTER_' . time());
    $targetDir = tutorialEnsureCourseDirs($courseId) . 'master/' . $folderId . '/';

    if (!file_exists($targetDir)) mkdir($targetDir, 0777, true);

    $manifest = [
        'id' => $folderId,
        'address' => $address,
        'owner_email' => 'system_admin',
        'status' => 'master_template',
        'tutorial_course_id' => $courseId,
        'created_at' => date('Y-m-d H:i:s'),
        'resident' => ['name' => 'Template', 'email' => '', 'phone' => ''],
        'issuer' => ['name' => 'First Mate', 'email' => 'admin@firstmate.app']
    ];
    saveManifest($targetDir . 'manifest.json', $manifest);

    processProjectApis($targetDir, $address, $GOOGLE_API_KEY, $GEMINI_API_KEY);

    echo json_encode(['success' => true, 'folder' => $folderId, 'course_id' => $courseId]);
    exit;
}

if ($action === 'update_progress') {
    $courseId = tutorialCourseIdFromRequest();
    $userEmail = $_SESSION['user_email'];
    $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($userEmail)));

    $type = $_POST['type'];
    $id = $_POST['id'];

    $progress = fm_tutorial_read_progress($courseId, $userEmail);
    if (!is_array($progress)) $progress = ['completed_videos'=>[], 'completed_projects'=>[], 'current_chapter'=>1];

    if ($type === 'video') {
        $newEntry = ['url' => $id, 'date' => date('Y-m-d H:i:s')];

        $exists = false;
        foreach ($progress['completed_videos'] as $v) {
            if (is_string($v) && $v === $id) { $exists = true; break; }
            if (is_array($v) && ($v['url'] ?? '') === $id) { $exists = true; break; }
        }
        if (!$exists) $progress['completed_videos'][] = $newEntry;

    } elseif ($type === 'chapter_complete') {
        $chapterId = intval($id);
        $curriculum = fm_tutorial_read_curriculum($courseId);
        $chapters = is_array($curriculum['chapters'] ?? null) ? $curriculum['chapters'] : [];
        $chapter = $chapters[max(0, $chapterId - 1)] ?? null;
        if (is_array($chapter) && (!fm_tutorial_required_tests_passed($chapter, $progress, $chapterId) || !fm_tutorial_required_draft_reject_rounds_passed($chapter, $progress, $chapterId))) {
            echo json_encode(['success' => false, 'course_id' => $courseId, 'error' => 'A required test must be passed before advancing.']);
            exit;
        }
        if ($chapterId >= ($progress['current_chapter'] ?? 1)) $progress['current_chapter'] = $chapterId + 1;
    }

    fm_tutorial_write_progress($courseId, $userEmail, $progress);
    echo json_encode(['success' => true, 'course_id' => $courseId]);
    exit;
}

// Note: The existing ensureUserCreditsFields(), readUserDataByEmail(), 
// and writeUserDataByEmail() functions are already in your server.php

// Default
echo json_encode(['error' => 'Unknown action']);
exit;
