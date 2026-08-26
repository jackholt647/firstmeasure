<?php
require_once dirname(__DIR__) . '/_storage.php';
/**
 * _tracking.php
 *
 * Facebook Conversions API (CAPI) helper functions.
 * Include this file in server.php alongside the other _ files.
 *
 * Usage examples:
 *
 *   // After writing new user to DB (in register action):
 *   capiCompleteRegistration($email, $userId);
 *
 *   // When user accepts an offer:
 *   capiOfferAccepted($email, 'singup-bonus-v1', 49.00);
 *
 *   // When customer total spend crosses a milestone:
 *   capiLtvMilestone($email, 1000);
 *
 *   // Generic purchase (e.g. credit top-up):
 *   capiPurchase($email, 250.00, ['order_id' => 'abc123']);
 *
 * Token setup:
 *   Put your Facebook System User Token in: fb_capi_token.txt
 *   (same directory as server.php — never expose client-side)
 *
 * Test mode:
 *   Set FB_CAPI_TEST_MODE to true below. All events will be logged
 *   to fb_capi_test.log instead of being sent to Facebook.
 *   Set it to false when you're ready to go live.
 *
 * Milestone tracking:
 *   Milestones fired are stored on the user JSON under "ltv_milestones_fired" => [500, 1000, ...]
 *   capiLtvMilestone() is idempotent — calling it twice for the same threshold is a no-op.
 */

// ------------------------------------------------
// CONFIG — everything lives here, nothing to set elsewhere
// ------------------------------------------------

define('FB_CAPI_TEST_MODE', true);   // <<< true = log to file, false = send to Facebook

define('FB_PIXEL_ID', '636685175264715');
define('FB_CAPI_TOKEN_PATH', storageExistingPath('secrets/fb_capi_token.txt', __DIR__ . '/fb_capi_token.txt', true));
define('FB_CAPI_VERSION', 'v21.0');
define('FB_CAPI_TEST_LOG', storagePath('logs/fb_capi_test.log', true));

// Thresholds at which we fire LTV milestone events back to Facebook.
define('LTV_MILESTONES', [500, 1000, 2500, 5000, 10000]);


// ------------------------------------------------
// TOKEN
// ------------------------------------------------

function fbCAPIGetToken() {
    static $token = null;
    if (is_string($token) && $token !== '') return $token;

    $path = FB_CAPI_TOKEN_PATH;
    if (!file_exists($path)) {
        error_log('[CAPI] Token file missing: ' . $path);
        return null;
    }
    $raw = trim((string)@file_get_contents($path));
    if ($raw === '') {
        error_log('[CAPI] Token file empty: ' . $path);
        return null;
    }
    $token = $raw;
    return $token;
}


// ------------------------------------------------
// HASHING
// ------------------------------------------------

function fbHash($value) {
    $value = strtolower(trim((string)$value));
    if ($value === '') return null;
    return hash('sha256', $value);
}


// ------------------------------------------------
// ATTRIBUTION LOOKUP
// ------------------------------------------------

function fbGetAttribution($email) {
    $email = strtolower(trim((string)$email));
    $empty = [
        'utm_source' => null, 'utm_medium' => null, 'utm_campaign' => null,
        'utm_content' => null, 'utm_term' => null, 'fbclid' => null,
        '_fbc' => null, '_fbp' => null,
        'client_ip' => null, 'client_ua' => null,
    ];
    if ($email === '') return $empty;

    $u = readUserDataByEmail($email);
    if (!$u) return $empty;

    $att = $u['attribution'] ?? null;

    if (!is_array($att) || empty(array_filter($att))) {
        $orgId = orgNormalizeId($u['organization_id'] ?? '');
        if ($orgId !== '') {
            $org = orgRead($orgId);
            if (is_array($org) && isset($org['attribution']) && is_array($org['attribution'])) {
                $att = $org['attribution'];
            }
        }
    }

    if (!is_array($att)) return $empty;
    return array_merge($empty, $att);
}


// ------------------------------------------------
// TEST MODE LOGGER
// ------------------------------------------------

function fbCAPITestLog($event) {
    $entry = [
        'logged_at'    => date('c'),
        'test_mode'    => true,
        'event_name'   => $event['event_name'] ?? 'unknown',
        'event_id'     => $event['event_id'] ?? null,
        'would_send_to' => 'https://graph.facebook.com/' . FB_CAPI_VERSION . '/' . FB_PIXEL_ID . '/events',
        'payload'      => $event,
    ];

    @file_put_contents(
        FB_CAPI_TEST_LOG,
        json_encode($entry, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n\n",
        FILE_APPEND | LOCK_EX
    );

    error_log('[CAPI-TEST] ' . ($event['event_name'] ?? 'unknown') . ' logged to ' . FB_CAPI_TEST_LOG);

    return ['ok' => true, 'test_mode' => true, 'event_name' => $event['event_name'] ?? 'unknown'];
}


// ------------------------------------------------
// LOW-LEVEL CAPI SENDER
// ------------------------------------------------

function fbCAPISend($event) {
    // --- TEST MODE: log to file, skip Facebook entirely ---
    if (FB_CAPI_TEST_MODE) {
        return fbCAPITestLog($event);
    }

    // --- LIVE MODE: send to Facebook ---
    $token = fbCAPIGetToken();
    if (!$token) return ['ok' => false, 'error' => 'missing_token'];

    $url = 'https://graph.facebook.com/' . FB_CAPI_VERSION . '/' . FB_PIXEL_ID . '/events';

    $payload = json_encode([
        'data' => [$event],
        'access_token' => $token,
    ]);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => $payload,
    ]);

    $resp = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($resp === false) {
        error_log('[CAPI] curl error: ' . $err);
        return ['ok' => false, 'error' => 'curl_error', 'details' => $err];
    }

    $data = json_decode($resp, true);

    if ($http < 200 || $http >= 300) {
        error_log('[CAPI] HTTP ' . $http . ' resp=' . $resp);
        return ['ok' => false, 'http' => $http, 'response' => $data ?: $resp];
    }

    return ['ok' => true, 'http' => $http, 'response' => $data];
}


// ------------------------------------------------
// USER_DATA BUILDER
// ------------------------------------------------

function fbBuildUserData($email, $attribution = [], $extra = []) {
    $ud = [];

    $ud['em'] = fbHash($email);

    if (!empty($extra['fn'])) $ud['fn'] = fbHash($extra['fn']);
    if (!empty($extra['ln'])) $ud['ln'] = fbHash($extra['ln']);
    if (!empty($extra['phone'])) $ud['ph'] = fbHash($extra['phone']);

    if (!empty($attribution['_fbc'])) $ud['fbc'] = $attribution['_fbc'];
    if (!empty($attribution['_fbp'])) $ud['fbp'] = $attribution['_fbp'];

    $ud['client_ip_address'] = $extra['client_ip']
        ?? $_SERVER['REMOTE_ADDR']
        ?? ($attribution['client_ip'] ?? null);

    $ud['client_user_agent'] = $extra['client_ua']
        ?? $_SERVER['HTTP_USER_AGENT']
        ?? ($attribution['client_ua'] ?? null);

    return array_filter($ud, function($v) { return $v !== null && $v !== ''; });
}


// ------------------------------------------------
// HIGH-LEVEL EVENT FUNCTIONS
// ------------------------------------------------

function capiCompleteRegistration($email, $eventId, $extra = []) {
    $att = fbGetAttribution($email);

    $event = [
        'event_name'    => 'CompleteRegistration',
        'event_time'    => time(),
        'event_id'      => (string)$eventId,
        'action_source' => 'website',
        'event_source_url' => 'https://app.1m8.ai/portal/login.html',
        'user_data'     => fbBuildUserData($email, $att, $extra),
        'custom_data'   => array_filter([
            'utm_campaign' => $att['utm_campaign'] ?? null,
            'utm_source'   => $att['utm_source'] ?? null,
            'lead_magnet'  => $att['utm_campaign'] ?? null,
        ]),
    ];

    $result = fbCAPISend($event);

    if (empty($result['ok'])) {
        error_log('[CAPI] CompleteRegistration failed for ' . $email . ': ' . json_encode($result));
    }

    return $result;
}


function capiOfferAccepted($email, $offerId, $value, $eventId = '') {
    $att = fbGetAttribution($email);
    if ($eventId === '') $eventId = 'offer_' . $offerId . '_' . md5($email . time());

    $event = [
        'event_name'    => 'Purchase',
        'event_time'    => time(),
        'event_id'      => (string)$eventId,
        'action_source' => 'website',
        'user_data'     => fbBuildUserData($email, $att),
        'custom_data'   => array_filter([
            'value'        => (float)$value,
            'currency'     => 'USD',
            'offer_id'     => (string)$offerId,
            'utm_campaign' => $att['utm_campaign'] ?? null,
            'utm_source'   => $att['utm_source'] ?? null,
        ]),
    ];

    $result = fbCAPISend($event);

    if (empty($result['ok'])) {
        error_log('[CAPI] OfferAccepted failed for ' . $email . ' offer=' . $offerId . ': ' . json_encode($result));
    }

    return $result;
}


function capiPurchase($email, $value, $meta = [], $eventId = '') {
    $att = fbGetAttribution($email);
    if ($eventId === '') $eventId = 'purchase_' . md5($email . $value . time());

    $customData = array_merge([
        'value'        => (float)$value,
        'currency'     => 'USD',
        'utm_campaign' => $att['utm_campaign'] ?? null,
        'utm_source'   => $att['utm_source'] ?? null,
    ], $meta);

    $event = [
        'event_name'    => 'Purchase',
        'event_time'    => time(),
        'event_id'      => (string)$eventId,
        'action_source' => 'website',
        'user_data'     => fbBuildUserData($email, $att),
        'custom_data'   => array_filter($customData),
    ];

    $result = fbCAPISend($event);

    if (empty($result['ok'])) {
        error_log('[CAPI] Purchase failed for ' . $email . ' value=' . $value . ': ' . json_encode($result));
    }

    return $result;
}


function capiLtvMilestone($email, $totalSpend) {
    $email = strtolower(trim((string)$email));
    $totalSpend = (float)$totalSpend;
    if ($email === '' || $totalSpend <= 0) return [];

    $u = readUserDataByEmail($email);
    if (!$u) return [];

    $fired = $u['ltv_milestones_fired'] ?? [];
    if (!is_array($fired)) $fired = [];

    $att = fbGetAttribution($email);
    $newlyFired = [];

    foreach (LTV_MILESTONES as $threshold) {
        if (in_array($threshold, $fired, true)) continue;
        if ($totalSpend < $threshold) continue;

        $eventId = 'ltv_' . $threshold . '_' . md5($email);

        $event = [
            'event_name'    => 'Purchase',
            'event_time'    => time(),
            'event_id'      => (string)$eventId,
            'action_source' => 'website',
            'user_data'     => fbBuildUserData($email, $att),
            'custom_data'   => array_filter([
                'value'         => (float)$threshold,
                'currency'      => 'USD',
                'ltv_milestone' => (string)$threshold,
                'utm_campaign'  => $att['utm_campaign'] ?? null,
                'utm_source'    => $att['utm_source'] ?? null,
            ]),
        ];

        $result = fbCAPISend($event);

        if (!empty($result['ok'])) {
            $fired[] = $threshold;
            $newlyFired[] = $threshold;
        } else {
            error_log('[CAPI] LTV milestone ' . $threshold . ' failed for ' . $email . ': ' . json_encode($result));
        }
    }

    if (!empty($newlyFired)) {
        sort($fired);
        $u['ltv_milestones_fired'] = $fired;
        writeUserDataByEmail($email, $u);
    }

    return $newlyFired;
}


function capiCheckLtvMilestones($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return [];

    $u = readUserDataByEmail($email);
    if (!$u) return [];

    $totalSpend = 0;

    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    if ($orgId !== '') {
        $org = orgRead($orgId);
        if (is_array($org)) {
            $ledger = $org['credits_ledger'] ?? [];
            if (is_array($ledger)) {
                foreach ($ledger as $entry) {
                    $reason = strtolower(trim((string)($entry['reason'] ?? '')));
                    if (in_array($reason, ['stripe_purchase', 'purchase', 'payment'], true)) {
                        $totalSpend += abs((float)($entry['amount_usd'] ?? $entry['amount'] ?? 0));
                    }
                }
            }
        }
    }

    if ($totalSpend <= 0) return [];

    return capiLtvMilestone($email, $totalSpend);
}