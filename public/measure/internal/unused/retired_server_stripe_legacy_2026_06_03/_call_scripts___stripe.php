<?php
require_once dirname(__DIR__) . '/_storage.php';
/**
 * _stripe.php
 *
 * Stripe-related functions and action handlers.
 * This file should be included AFTER all config, globals, and org functions are defined.
 *
 * Contains:
 * - Stripe helper functions (API requests, signature verification, session management)
 * - Generic checkout session builder (stripeCreateCheckoutSession)
 * - Purpose-built session factories:
 *     stripeCreateCreditPurchaseSession  – one-time credit top-up (supports signup match bonus)
 *     stripeCreateSetupCheckoutSession   – save card for auto top-up
 * - Stripe webhook handler
 * - Stripe action handlers (checkout, fulfillment, billing setup)
 * - Org billing/auto-topup functions
 *
 * SIGNUP MATCH DEAL (50% first-purchase bonus)
 * --------------------------------------------
 * Controlled by the STRIPE_SIGNUP_MATCH_50_ENABLED constant below.
 * Set it to false to disable the deal globally with no other code changes needed.
 *
 * Eligibility at checkout time (all must be true):
 *   1. STRIPE_SIGNUP_MATCH_50_ENABLED is true
 *   2. The purchasing user belongs to an org
 *   3. The org has no prior Stripe purchases recorded in its credits ledger
 *   4. The org has not already claimed this deal (claimed_deals.signup_match_50 !== true)
 *
 * When eligible, stripeCreateCreditPurchaseSession builds a Stripe checkout page that clearly
 * shows "X paid + Y bonus (50% match) = Z total" using inline price_data, and stores the full
 * credited amount in metadata[credit_dollars] so fulfillment applies the right number with no
 * extra logic.
 *
 * On successful fulfillment, orgMarkDealClaimed() stamps claimed_deals.signup_match_50 = true
 * on the org so the deal cannot be reused.
 *
 * ADDING NEW PRODUCT TYPES
 * ------------------------
 * 1. Write a new purpose-built factory function (e.g. stripeCreateSubscriptionSession).
 * 2. It should build a $fields array and call stripeCreateCheckoutSession($key, $fields).
 * 3. Add a corresponding action branch in handleStripeActions if user-initiated.
 * The generic layer never needs to change.
 */

// ------------------------------------------------
// -------- DEAL TOGGLE (GLOBAL MASTER SWITCH) ----
// ------------------------------------------------

/**
 * Set to false to disable the 50% signup credit match deal site-wide.
 * No other code changes needed — all eligibility checks read this constant.
 */
define('STRIPE_SIGNUP_MATCH_50_ENABLED', true);

// ------------------------------------------------
// ---------------- STRIPE HELPERS ---------------
// ------------------------------------------------

/**
 * Exclusive file lock to avoid double-credit between webhook + return/manual fulfill.
 */
function withStripeLock($fn) {
    $lockFile = storagePath('locks/stripe.lock', true);
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

function timingSafeEquals($a, $b) {
    if (function_exists('hash_equals')) return hash_equals($a, $b);
    if (strlen($a) !== strlen($b)) return false;
    $res = 0;
    for ($i = 0; $i < strlen($a); $i++) $res |= ord($a[$i]) ^ ord($b[$i]);
    return $res === 0;
}

/** Supports multiple v1 signatures (Stripe sends multiple when rotating secrets). */
function verifyStripeSig($payload, $sigHeader, $secret, $toleranceSec = 300) {
    $parts = explode(',', $sigHeader);
    $t = null;
    $v1s = [];
    foreach ($parts as $p) {
        $kv = explode('=', trim($p), 2);
        if (count($kv) !== 2) continue;
        if ($kv[0] === 't') $t = $kv[1];
        if ($kv[0] === 'v1') $v1s[] = $kv[1];
    }
    if (!$t || empty($v1s)) return false;
    if (abs(time() - (int)$t) > $toleranceSec) return false;
    $expected = hash_hmac('sha256', $t . '.' . $payload, $secret);
    foreach ($v1s as $v1) {
        if (timingSafeEquals($expected, $v1)) return true;
    }
    return false;
}

/**
 * Low-level Stripe REST wrapper. Returns:
 *   ['success' => true,  'http' => int, 'data'  => array]
 *   ['success' => false, 'http' => int, 'error' => string, 'stripe' => mixed]
 */
function stripeApiRequest($method, $path, $secretKey, $params = null, $idempotencyKey = null) {
    $url = 'https://api.stripe.com' . $path;
    $ch  = curl_init($url);
    $headers = ['Authorization: Bearer ' . $secretKey];
    if ($idempotencyKey) {
        $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
    }
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 30,
    ];
    $method = strtoupper($method);
    if ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        if (is_array($params)) {
            $opts[CURLOPT_POSTFIELDS]  = http_build_query($params);
            $opts[CURLOPT_HTTPHEADER][] = 'Content-Type: application/x-www-form-urlencoded';
        }
    } else {
        $opts[CURLOPT_HTTPGET] = true;
    }
    curl_setopt_array($ch, $opts);
    $resp = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($resp === false) return ['success' => false, 'http' => $http, 'error' => 'Curl error: ' . $err];
    $data = json_decode($resp, true);
    if ($http >= 400 || !is_array($data)) {
        return ['success' => false, 'http' => $http, 'error' => 'Stripe API error', 'stripe' => $data ?: $resp];
    }
    return ['success' => true, 'http' => $http, 'data' => $data];
}

// ------------------------------------------------
// -------- GENERIC CHECKOUT SESSION BUILDER ------
// ------------------------------------------------

/**
 * Generic Stripe Checkout Session creator.
 *
 * Accepts a fully-formed $fields array (Stripe form-encoded parameters) and
 * posts it to /v1/checkout/sessions. Purpose-built factories below compose
 * the fields for their specific use-case, then call this.
 *
 * Returns:
 *   ['success' => true,  'session' => array, 'url' => string]
 *   ['success' => false, 'error'   => string, 'stripe' => mixed]
 */
function stripeCreateCheckoutSession($stripeSecretKey, array $fields) {
    $ret = stripeApiRequest('POST', '/v1/checkout/sessions', $stripeSecretKey, $fields);
    if (empty($ret['success'])) {
        return ['success' => false, 'error' => $ret['error'] ?? 'Stripe error', 'stripe' => $ret['stripe'] ?? null];
    }
    $data = $ret['data'];
    return ['success' => true, 'session' => $data, 'url' => ($data['url'] ?? null)];
}

// ------------------------------------------------
// ------- PURPOSE-BUILT SESSION FACTORIES --------
// ------------------------------------------------

/**
 * One-time credit purchase session.
 *
 * Uses inline price_data so the product name + description on the Stripe
 * checkout page can be fully dynamic — no pre-created Price object required.
 *
 * When $isSignupMatch is true a 50% bonus is applied:
 *   - The Stripe line-item description clearly shows "X paid + Y bonus = Z total"
 *   - metadata[credit_dollars] carries the TOTAL (paid + bonus) so fulfillment
 *     applies the right amount with zero extra logic
 *   - metadata[bonus_dollars] and metadata[paid_dollars] are stored for records
 *
 * @param string $stripeSecretKey
 * @param int    $qty              Dollars the user is PAYING (quantity of $1 units)
 * @param string $userEmail
 * @param string $baseUrl
 * @param bool   $isSignupMatch    Pass true to apply the 50% signup match bonus
 *
 * @return array ['success', 'url', 'session'] or ['success' => false, 'error', ...]
 */
function stripeCreateCreditPurchaseSession($stripeSecretKey, $qty, $userEmail, $baseUrl, $isSignupMatch = false, $customerId = '', $orgId = '') {
    $qty = max(1, min(50000, (int)$qty));

    $bonus       = $isSignupMatch ? (int)round($qty * 0.50) : 0;
    $totalCredit = $qty + $bonus;

    // --- Dynamic line-item copy shown on Stripe's checkout page ---
    $productName = 'Measurement Credits';
    if ($isSignupMatch && $bonus > 0) {
        $productDesc =
            "\${$qty} purchased + \${$bonus} first-purchase bonus (50% match) "
            . "= \${$totalCredit} total credit added to your account";
    } else {
        $productDesc = "\${$totalCredit} credit added to your FirstMate account";
    }

    $successUrl = $baseUrl . '/index.php?paid=1&session_id={CHECKOUT_SESSION_ID}';
    $cancelUrl  = $baseUrl . '/index.php?paid=0';

    $fields = [
        'mode'        => 'payment',
        'success_url' => $successUrl,
        'cancel_url'  => $cancelUrl,

        // Inline price — $1 USD per unit, quantity = dollars paid
        'line_items[0][price_data][currency]'                      => 'usd',
        'line_items[0][price_data][unit_amount]'                   => '100', // cents
        'line_items[0][price_data][product_data][name]'            => $productName,
        'line_items[0][price_data][product_data][description]'     => $productDesc,
        'line_items[0][quantity]'                                  => (string)$qty,

        'client_reference_id'         => $userEmail,
        'metadata[user_email]'        => $userEmail,

        // credit_dollars = total to credit (paid + bonus); fulfillment reads this
        'metadata[credit_dollars]'    => (string)$totalCredit,
        'metadata[paid_dollars]'      => (string)$qty,
        'metadata[bonus_dollars]'     => (string)$bonus,
        'metadata[is_signup_match]'   => $isSignupMatch ? '1' : '0',

        // backward-compat alias kept for anything that still reads credits_qty
        'metadata[credits_qty]'       => (string)$totalCredit,
    ];

    // If we have a Stripe customer, attach them to the session and instruct Stripe
    // to save the payment method for future off-session use (auto top-ups). This
    // eliminates the separate "save card" step — the card is authorized at checkout.
    if ($customerId !== '') {
        $fields['customer'] = $customerId;
        $fields['payment_intent_data[setup_future_usage]'] = 'off_session';
        if ($orgId !== '') {
            $fields['metadata[org_id]'] = $orgId;
        }
    }

    return stripeCreateCheckoutSession($stripeSecretKey, $fields);
}

/**
 * Setup-mode session for saving a card for auto top-up.
 *
 * @param string $stripeSecretKey
 * @param string $orgId
 * @param string $customerId  Stripe Customer ID
 * @param string $baseUrl
 *
 * @return array ['success', 'session', 'url'] or ['success' => false, 'error', ...]
 */
function stripeCreateSetupCheckoutSession($stripeSecretKey, $orgId, $customerId, $baseUrl) {
    $successUrl = $baseUrl . '/index.php?tab=company_settings&sub=billing&setup=1&session_id={CHECKOUT_SESSION_ID}';
    $cancelUrl  = $baseUrl . '/index.php?tab=company_settings&sub=billing&setup=0';

    $o = orgRead($orgId);
    if ($o) orgEnsureBillingFields($o);
    $enabled   = $o ? (!empty($o['billing']['auto_topup']['enabled'])) : false;
    $threshold = $o ? (int)($o['billing']['auto_topup']['threshold_dollars'] ?? 70) : 70;
    $topup     = $o ? (int)($o['billing']['auto_topup']['topup_dollars'] ?? 70) : 70;

    $termsUrl = rtrim((string)$baseUrl, '/') . '/terms';
    if ($enabled) {
        $consentMsg =
            "I authorize FirstMate to save my card for recurring billing. "
            . "If Auto Top-Up is enabled, I also authorize an automatic top-up of \${$topup} "
            . "when my balance drops below \${$threshold}. "
            . "[Terms]({$termsUrl})";
    } else {
        $consentMsg =
            "I authorize FirstMate to save my card for recurring billing. "
            . "I authorize an automatic top-up of \${$topup} "
            . "when my balance drops below \${$threshold}. "
            . "[Terms]({$termsUrl})";
    }

    $fields = [
        'mode'       => 'setup',
        'customer'   => $customerId,
        'currency'   => 'usd',
        'success_url' => $successUrl,
        'cancel_url'  => $cancelUrl,

        'consent_collection[terms_of_service]'                    => 'required',
        'custom_text[terms_of_service_acceptance][message]'        => $consentMsg,

        'metadata[type]'                          => 'org_auto_topup_setup',
        'metadata[org_id]'                        => $orgId,
        'metadata[topup_dollars]'                 => (string)$topup,
        'metadata[threshold_dollars]'             => (string)$threshold,
        'metadata[auto_topup_enabled_at_checkout]' => $enabled ? '1' : '0',
    ];

    return stripeCreateCheckoutSession($stripeSecretKey, $fields);
}

// ------------------------------------------------
// -------- PAYMENT METHOD SAVE HELPER ------------
// ------------------------------------------------

/**
 * Save a payment method (and card details) to an org's billing profile.
 *
 * Called automatically after a successful credit-purchase checkout when
 * payment_intent_data[setup_future_usage]=off_session is set, so the card
 * is already authorized for future top-ups. Also called by the dedicated
 * setup-mode webhook handler.
 *
 * @param string $orgId
 * @param string $customerId  Stripe Customer ID
 * @param string $pmId        Stripe PaymentMethod ID
 */
function stripeSaveCardToOrg($orgId, $customerId, $pmId) {
    $o = orgRead($orgId);
    if (!$o) return;
    orgEnsureBillingFields($o);

    // Skip if this exact PM is already saved (idempotent)
    if ((string)($o['billing']['stripe']['payment_method_id'] ?? '') === $pmId) return;

    $brand = $last4 = $expM = $expY = null;
    $pm = stripeRetrievePaymentMethod($GLOBALS['STRIPE_SECRET_KEY'], $pmId);
    if (!empty($pm['success']) && is_array($pm['data'])) {
        $card  = is_array($pm['data']['card'] ?? null) ? $pm['data']['card'] : [];
        $brand = $card['brand']     ?? null;
        $last4 = $card['last4']     ?? null;
        $expM  = $card['exp_month'] ?? null;
        $expY  = $card['exp_year']  ?? null;
    }

    if ($customerId !== '') {
        stripeCustomerSetDefaultPaymentMethod($GLOBALS['STRIPE_SECRET_KEY'], $customerId, $pmId);
    }

    $o['billing']['stripe']['payment_method_id']  = $pmId;
    $o['billing']['stripe']['has_payment_method'] = true;
    $o['billing']['stripe']['brand']              = $brand;
    $o['billing']['stripe']['last4']              = $last4;
    $o['billing']['stripe']['exp_month']          = $expM;
    $o['billing']['stripe']['exp_year']           = $expY;

    // If the org was waiting on a card, mark auto-topup as ready (but leave
    // enabled flag alone — user still has to consciously turn top-ups on)
    if (($o['billing']['auto_topup']['status'] ?? '') === 'needs_payment_method') {
        $o['billing']['auto_topup']['status']     = 'ok';
        $o['billing']['auto_topup']['last_error'] = null;
    }

    orgBillingLogEvent($o, 'payment_method_saved_via_checkout', [
        'customer_id'       => $customerId,
        'payment_method_id' => $pmId,
        'brand'             => $brand,
        'last4'             => $last4,
    ]);
    orgWrite($orgId, $o);
}

// ------------------------------------------------
// ----------- STRIPE SESSION MANAGEMENT ----------
// ------------------------------------------------

function stripeRetrieveCheckoutSession($stripeSecretKey, $sessionId) {
    $sessionId = trim((string)$sessionId);
    if ($sessionId === '') return ['success' => false, 'error' => 'Missing session_id'];
    $ret = stripeApiRequest('GET', '/v1/checkout/sessions/' . rawurlencode($sessionId), $stripeSecretKey);
    if (empty($ret['success'])) return ['success' => false, 'error' => $ret['error'] ?? 'Stripe retrieve error', 'stripe' => $ret['stripe'] ?? null];
    return ['success' => true, 'session' => $ret['data']];
}

function stripeRetrieveCheckoutSessionExpanded($stripeSecretKey, $sessionId) {
    $path = '/v1/checkout/sessions/' . rawurlencode($sessionId)
        . '?expand[]=setup_intent&expand[]=payment_intent&expand[]=customer';
    return stripeApiRequest('GET', $path, $stripeSecretKey);
}

function stripeRetrieveSetupIntent($stripeSecretKey, $si) {
    return stripeApiRequest('GET', '/v1/setup_intents/' . rawurlencode($si) . '?expand[]=payment_method', $stripeSecretKey);
}

function stripeRetrievePaymentMethod($stripeSecretKey, $pm) {
    return stripeApiRequest('GET', '/v1/payment_methods/' . rawurlencode($pm), $stripeSecretKey);
}

function stripeCustomerSetDefaultPaymentMethod($stripeSecretKey, $customerId, $paymentMethodId) {
    return stripeApiRequest('POST', '/v1/customers/' . rawurlencode($customerId), $stripeSecretKey, [
        'invoice_settings[default_payment_method]' => $paymentMethodId,
    ]);
}

function stripeCreateCustomer($stripeSecretKey, $orgId, $orgName) {
    $ret = stripeApiRequest('POST', '/v1/customers', $stripeSecretKey, [
        'name'              => (string)$orgName,
        'metadata[org_id]' => (string)$orgId,
    ]);
    if (empty($ret['success'])) return ['success' => false, 'error' => $ret['error'] ?? 'Stripe error', 'stripe' => $ret['stripe'] ?? null];
    return ['success' => true, 'customer' => $ret['data'], 'customer_id' => ($ret['data']['id'] ?? null)];
}

function stripeSessionMarkerPath($sessionId) {
    global $stripeEvtDir;
    $sid = preg_replace('/[^a-zA-Z0-9_]/', '_', (string)$sessionId);
    return $stripeEvtDir . 'session_' . $sid . '.json';
}

function stripeIsSessionFulfilled($sessionId) {
    return file_exists(stripeSessionMarkerPath($sessionId));
}

function stripeMarkSessionFulfilled($sessionId, $payloadArr) {
    @file_put_contents(stripeSessionMarkerPath($sessionId), json_encode($payloadArr, JSON_PRETTY_PRINT));
    return true;
}



/**
 * Central eligibility check for the 50% signup credit match deal.
 *
 * Returns ['eligible' => true, 'org_id' => string, 'reason' => 'eligible'] when all
 * four conditions below are met, otherwise ['eligible' => false, ...] with a reason string.
 *
 * Conditions (all must be true):
 *   1. STRIPE_SIGNUP_MATCH_50_ENABLED is true            (global toggle)
 *   2. The user belongs to an org                         (individual users are not eligible)
 *   3. The org has NO prior Stripe purchases in its ledger
 *   4. The org has NOT already claimed 'signup_match_50' in claimed_deals
 *
 * @param string $userEmail
 * @return array ['eligible' => bool, 'org_id' => string|null, 'reason' => string]
 */
function stripeSignupMatchEligibility($userEmail) {
    // 1. Global toggle
    if (!STRIPE_SIGNUP_MATCH_50_ENABLED) {
        return ['eligible' => false, 'org_id' => null, 'reason' => 'deal_disabled'];
    }

    $userEmail = strtolower(trim((string)$userEmail));
    if ($userEmail === '') {
        return ['eligible' => false, 'org_id' => null, 'reason' => 'no_email'];
    }

    // 2. Resolve org for this user
    $orgId = null;
    if (function_exists('actorOrgIdByEmail')) {
        $orgId = actorOrgIdByEmail($userEmail) ?: null;
    }
    if (!$orgId && function_exists('readUserDataByEmail')) {
        $u = readUserDataByEmail($userEmail);
        if ($u) $orgId = orgNormalizeId($u['organization_id'] ?? '') ?: null;
    }
    if (!$orgId) {
        return ['eligible' => false, 'org_id' => null, 'reason' => 'no_org'];
    }

    // 3. Prior Stripe purchase check
    if (orgHasPreviousStripePurchase($orgId)) {
        return ['eligible' => false, 'org_id' => $orgId, 'reason' => 'prior_purchase_exists'];
    }

    // 4. Deal already claimed
    if (orgHasClaimedDeal($orgId, 'signup_match_50')) {
        return ['eligible' => false, 'org_id' => $orgId, 'reason' => 'deal_already_claimed'];
    }

    return ['eligible' => true, 'org_id' => $orgId, 'reason' => 'eligible'];
}

// ------------------------------------------------
// -------------- FULFILLMENT LOGIC ---------------
// ------------------------------------------------

/**
 * Given a fully-loaded Stripe session object, credit the user/org if not already done.
 * Works for both webhook delivery and manual return-page fulfill.
 *
 * metadata[credit_dollars] drives the amount credited — it already includes any
 * signup match bonus baked in at session creation time.
 *
 * If metadata[is_signup_match] is '1', the org's signup_match_50 deal is stamped
 * as claimed here (after confirmed payment) so it cannot be reused.
 */
function stripeFulfillFromSessionObject($sessionObj, $source = 'stripe_return') {
    $sid = (string)($sessionObj['id'] ?? '');
    if ($sid === '') return ['success' => false, 'error' => 'Missing session id'];

    $liveMode = !empty($sessionObj['livemode']);
    if ($liveMode !== (!STRIPE_TEST_MODE)) {
        return ['success' => false, 'error' => 'Livemode mismatch', 'livemode' => $liveMode, 'test_mode' => STRIPE_TEST_MODE];
    }
    if (stripeIsSessionFulfilled($sid)) {
        return ['success' => true, 'duplicate' => true, 'session_id' => $sid];
    }

    $paymentStatus = (string)($sessionObj['payment_status'] ?? '');
    if ($paymentStatus !== 'paid') {
        return ['success' => false, 'error' => 'Not paid yet', 'payment_status' => $paymentStatus, 'session_id' => $sid];
    }

    $meta      = $sessionObj['metadata'] ?? [];
    $userEmail = strtolower(trim((string)($meta['user_email'] ?? ($sessionObj['client_reference_id'] ?? ''))));

    // credit_dollars already includes any bonus; fall back to legacy credits_qty
    $dollars = (int)($meta['credit_dollars'] ?? 0);
    if ($dollars < 1) $dollars = (int)($meta['credits_qty'] ?? 0);

    if (!$userEmail || $dollars < 1) {
        return ['success' => false, 'error' => 'Missing metadata', 'user_email' => $userEmail, 'credit_dollars' => $dollars, 'session_id' => $sid];
    }

    $isSignupMatch = ($meta['is_signup_match'] ?? '0') === '1';

    $add = creditsAddByEmail($userEmail, $dollars, 'stripe_checkout_paid', [
        'source'          => $source,
        'session_id'      => $sid,
        'amount_total'    => $sessionObj['amount_total'] ?? null,
        'currency'        => $sessionObj['currency'] ?? null,
        'paid_dollars'    => (int)($meta['paid_dollars']  ?? $dollars),
        'bonus_dollars'   => (int)($meta['bonus_dollars'] ?? 0),
        'is_signup_match' => $isSignupMatch,
        'test_mode'       => STRIPE_TEST_MODE,
    ]);

    if (empty($add['ok'])) {
        stripeMarkSessionFulfilled($sid, ['error' => 'Credit apply failed', 'source' => $source, 'session' => $sessionObj, 'creditsAdd' => $add]);
        return ['success' => false, 'error' => 'Credit apply failed', 'details' => $add, 'session_id' => $sid];
    }

// Stamp the deal as claimed now that payment is confirmed.
    // We do this AFTER the credit apply succeeds so a failed credit never
    // accidentally blocks the org from trying again.
    $dealOrgId = $add['org_id'] ?? null;
    if ($isSignupMatch && $dealOrgId) {
        orgMarkDealClaimed($dealOrgId, 'signup_match_50', [
            'session_id'    => $sid,
            'paid_dollars'  => (int)($meta['paid_dollars']  ?? $dollars),
            'bonus_dollars' => (int)($meta['bonus_dollars'] ?? 0),
            'source'        => $source,
        ]);

        // Fire CAPI OfferAccepted for the 50% signup match deal.
        // value = the bonus portion (what FB was "given away" to convert the user).
        if (function_exists('capiOfferAccepted')) {
            $bonusDollars = (float)($meta['bonus_dollars'] ?? 0);
            if ($bonusDollars > 0) {
                capiOfferAccepted($userEmail, 'signup_match_50', $bonusDollars, 'offer_signup_match_50_' . $sid);
            }
        }
    }

    stripeMarkSessionFulfilled($sid, [
        'fulfilled'       => true,
        'source'          => $source,
        'user_email'      => $userEmail,
        'credit_dollars'  => $dollars,
        'paid_dollars'    => (int)($meta['paid_dollars']  ?? $dollars),
        'bonus_dollars'   => (int)($meta['bonus_dollars'] ?? 0),
        'is_signup_match' => $isSignupMatch,
        'scope'           => $add['scope'] ?? null,
        'org_id'          => $add['org_id'] ?? null,
        'ts'              => date('c'),
        'test_mode'       => STRIPE_TEST_MODE,
    ]);

    if (function_exists('capiPurchase')) {
        capiPurchase($userEmail, $dollars, ['source' => $source, 'session_id' => $sid]);
    }

    // Auto-save the payment method for future top-ups when the session was
    // created with payment_intent_data[setup_future_usage]=off_session. This
    // means the very first checkout also authorizes the card — no separate
    // "save card" step required before enabling auto top-up.
    $orgIdFromAdd  = $add['org_id'] ?? null;
    $custId        = (string)($sessionObj['customer'] ?? '');
    $piIdOrObj     = $sessionObj['payment_intent'] ?? '';
    if ($orgIdFromAdd && $custId && $piIdOrObj) {
        try {
            $piId2 = is_array($piIdOrObj) ? (string)($piIdOrObj['id'] ?? '') : (string)$piIdOrObj;
            if ($piId2 !== '') {
                $piRet = stripeApiRequest(
                    'GET',
                    '/v1/payment_intents/' . rawurlencode($piId2) . '?expand[]=payment_method',
                    $GLOBALS['STRIPE_SECRET_KEY']
                );
                if (!empty($piRet['success']) && is_array($piRet['data'])) {
                    $pmObj    = $piRet['data']['payment_method'] ?? null;
                    $pmIdSave = is_array($pmObj) ? (string)($pmObj['id'] ?? '') : (string)($pmObj ?? '');
                    if ($pmIdSave !== '') {
                        stripeSaveCardToOrg($orgIdFromAdd, $custId, $pmIdSave);
                    }
                }
            }
        } catch (Exception $e) {
            error_log("checkout_save_pm_exception org={$orgIdFromAdd} sid={$sid} err=" . $e->getMessage());
        }
    }

    return [
        'success'         => true,
        'credited'        => $dollars,
        'email'           => $userEmail,
        'scope'           => ($add['scope'] ?? 'user'),
        'org_id'          => ($add['org_id'] ?? null),
        'is_signup_match' => $isSignupMatch,
        'session_id'      => $sid,
    ];
}

// ------------------------------------------------
// ------------- ORG BILLING / AUTO-TOPUP --------
// ------------------------------------------------

function creditsAddToOrg($orgId, $amount, $reason, $meta = []) {
    error_log("creditsAddToOrg LANDED");
    $orgId  = orgNormalizeId($orgId);
    $amount = (int)$amount;
    if ($orgId === '' || $amount === 0) return ['ok' => false, 'error' => 'bad_args'];
    $o = orgRead($orgId);
    if (!$o) return ['ok' => false, 'error' => 'org_not_found'];
    orgEnsureCreditsFields($o);
    $o['credits_balance'] = (int)$o['credits_balance'] + $amount;
    $o['credits_ledger'][] = [
        'ts'       => date('c'),
        'delta'    => $amount,
        'reason'   => (string)$reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'meta'     => is_array($meta) ? $meta : [],
        'unit'     => 'usd_dollars',
    ];
    if (!orgWrite($orgId, $o)) return ['ok' => false, 'error' => 'org_write_failed'];
    return ['ok' => true, 'scope' => 'org', 'org_id' => $orgId, 'new_balance' => (int)$o['credits_balance']];
}

function orgAutoTopupTry($orgId, $byEmailForCreditApply, $balanceAfterSpend, $context = []) {
    error_log("orgAutoTopupTry LANDED");
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return ['ok' => false, 'error' => 'bad_org'];
    $o = orgRead($orgId);
    if (!$o) return ['ok' => false, 'error' => 'org_not_found'];
    orgEnsureBillingFields($o);
    $at = $o['billing']['auto_topup'];
    $s  = $o['billing']['stripe'];

    if (empty($at['enabled'])) return ['ok' => true, 'skipped' => true, 'reason' => 'disabled'];

    $threshold = max(35, (int)$at['threshold_dollars']);
    $topup     = max(35, (int)$at['topup_dollars']);
    $coolMin   = max(1,  (int)$at['cooldown_minutes']);

    if ((int)$balanceAfterSpend >= $threshold) {
        $o['billing']['auto_topup']['status'] = 'idle';
        orgWrite($orgId, $o);
        return ['ok' => true, 'skipped' => true, 'reason' => 'above_threshold'];
    }
    if (empty($s['has_payment_method']) || empty($s['customer_id']) || empty($s['payment_method_id'])) {
        $o['billing']['auto_topup']['status']     = 'needs_payment_method';
        $o['billing']['auto_topup']['last_error'] = 'No saved payment method';
        orgBillingLogEvent($o, 'autotopup_blocked_no_pm', ['balance' => $balanceAfterSpend]);
        orgWrite($orgId, $o);
        return ['ok' => false, 'error' => 'no_payment_method'];
    }

    $o['billing']['auto_topup']['last_attempt_utc'] = gmdate('c');
    $o['billing']['auto_topup']['status'] = 'attempting';
    orgBillingLogEvent($o, 'autotopup_attempt', [
        'balance'   => $balanceAfterSpend,
        'threshold' => $threshold,
        'topup'     => $topup,
        'context'   => $context,
    ]);
    orgWrite($orgId, $o);

    $amountCents = $topup * 100;
    $fields = [
        'amount'                         => (string)$amountCents,
        'currency'                       => 'usd',
        'customer'                       => (string)$s['customer_id'],
        'payment_method'                 => (string)$s['payment_method_id'],
        'confirm'                        => 'true',
        'off_session'                    => 'true',
        'metadata[type]'                 => 'org_auto_topup',
        'metadata[org_id]'               => $orgId,
        'metadata[balance_after_spend]'  => (string)$balanceAfterSpend,
        'metadata[topup_dollars]'        => (string)$topup,
    ];
    $attemptUtc = (string)($o['billing']['auto_topup']['last_attempt_utc'] ?? gmdate('c'));
    $idemp = 'autotopup_' . $orgId . '_' . (int)$topup . '_' . preg_replace('/[^0-9]/', '', $attemptUtc);
    $ret = stripeApiRequest('POST', '/v1/payment_intents', $GLOBALS['STRIPE_SECRET_KEY'], $fields, $idemp);

    if (empty($ret['success'])) {
        $o = orgRead($orgId) ?: $o;
        orgEnsureBillingFields($o);
        $o['billing']['auto_topup']['status']     = 'failed';
        $o['billing']['auto_topup']['last_error'] = $ret['error'] ?? 'Stripe PI failed';
        $stripeErr = $ret['stripe'] ?? null;
        $code      = is_array($stripeErr) ? ($stripeErr['error']['code']         ?? null) : null;
        $decline   = is_array($stripeErr) ? ($stripeErr['error']['decline_code'] ?? null) : null;
        if ($code === 'authentication_required' || $decline === 'authentication_required') {
            $o['billing']['auto_topup']['status']     = 'needs_payment_method';
            $o['billing']['auto_topup']['enabled']    = false;
            $o['billing']['auto_topup']['last_error'] = 'Card requires authentication. Please update card.';
        }
        orgBillingLogEvent($o, 'autotopup_payment_intent_failed', [
            'error'  => $ret['error'] ?? null,
            'http'   => $ret['http']  ?? null,
            'stripe' => $ret['stripe'] ?? null,
            'fields' => $fields,
        ]);
        error_log("AUTO_TOPUP PI FAIL org=$orgId ret=" . json_encode($ret));
        orgWrite($orgId, $o);
        return ['ok' => false, 'error' => 'payment_intent_failed', 'details' => $ret];
    }

    $pi       = $ret['data'];
    $piStatus = (string)($pi['status'] ?? '');
    $piId     = (string)($pi['id']     ?? '');

    if ($piStatus !== 'succeeded') {
        $o = orgRead($orgId) ?: $o;
        orgEnsureBillingFields($o);
        $o['billing']['auto_topup']['status']     = 'failed';
        $o['billing']['auto_topup']['enabled']    = false;
        $o['billing']['auto_topup']['last_error'] = 'Top-up not completed (status=' . $piStatus . '). Update card.';
        orgBillingLogEvent($o, 'autotopup_non_succeeded', ['payment_intent_id' => $piId, 'status' => $piStatus]);
        orgWrite($orgId, $o);
        return ['ok' => false, 'error' => 'pi_not_succeeded', 'status' => $piStatus, 'payment_intent_id' => $piId];
    }

    $add = creditsAddToOrg($orgId, $topup, 'stripe_auto_topup', [
        'payment_intent_id' => $piId,
        'amount_cents'      => $pi['amount']   ?? null,
        'currency'          => $pi['currency'] ?? null,
    ]);
    $o = orgRead($orgId) ?: $o;
    orgEnsureBillingFields($o);

    if (empty($add['ok'])) {
        $o['billing']['auto_topup']['status']     = 'failed';
        $o['billing']['auto_topup']['last_error'] = 'Credits apply failed after charge. Investigate.';
        orgBillingLogEvent($o, 'autotopup_credit_apply_failed', ['payment_intent_id' => $piId, 'creditsAdd' => $add]);
        orgWrite($orgId, $o);
        return ['ok' => false, 'error' => 'credit_apply_failed', 'payment_intent_id' => $piId];
    }

    if (function_exists('capiPurchase')) {
        $creatorEmail = strtolower(trim((string)($o['created_by_email'] ?? '')));
        if ($creatorEmail !== '') {
            capiPurchase($creatorEmail, $topup, ['source' => 'auto_topup', 'payment_intent_id' => $piId]);
        }
    }

    $o['billing']['auto_topup']['status']           = 'ok';
    $o['billing']['auto_topup']['last_success_utc'] = gmdate('c');
    $o['billing']['auto_topup']['last_error']       = null;
    orgBillingLogEvent($o, 'autotopup_success', [
        'payment_intent_id' => $piId,
        'topup_dollars'     => $topup,
        'new_balance'       => $add['new_balance'] ?? null,
    ]);
    orgWrite($orgId, $o);
    return ['ok' => true, 'payment_intent_id' => $piId, 'topup_dollars' => $topup, 'credits' => $add];
}

// ------------------------------------------------
// ------------- STRIPE WEBHOOK HANDLER ----------
// ------------------------------------------------

function handleStripeWebhook() {
    $payload = @file_get_contents('php://input');
    $sig     = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
    if (!$payload || !$sig) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing payload/signature']);
        exit;
    }
    if (!verifyStripeSig($payload, $sig, $GLOBALS['STRIPE_WEBHOOK_SECRET'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid signature']);
        exit;
    }
    $event = json_decode($payload, true);
    if (!is_array($event) || empty($event['id']) || empty($event['type'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid event JSON']);
        exit;
    }
    // Mode guard
    $eventLiveMode = !empty($event['livemode']);
    if ($eventLiveMode !== (!STRIPE_TEST_MODE)) {
        http_response_code(200);
        echo json_encode(['success' => true, 'ignored' => true, 'reason' => 'livemode_mismatch', 'livemode' => $eventLiveMode, 'test_mode' => STRIPE_TEST_MODE]);
        exit;
    }
    $eventId   = preg_replace('/[^a-zA-Z0-9_]/', '_', $event['id']);
    $eventFlag = $GLOBALS['stripeEvtDir'] . $eventId . '.json';
    if (file_exists($eventFlag)) {
        echo json_encode(['success' => true, 'duplicate' => true]);
        exit;
    }

    $type = $event['type'];
    $obj  = $event['data']['object'] ?? null;

    // ---- Setup sessions: save payment method ----
    if (in_array($type, ['checkout.session.completed', 'checkout.session.async_payment_succeeded'], true) && is_array($obj)) {
        $mode = (string)($obj['mode'] ?? 'payment');
        if ($mode === 'setup') {
            error_log("SETUP LANDED");
            $sid = (string)($obj['id'] ?? '');
            $exp  = stripeRetrieveCheckoutSessionExpanded($GLOBALS['STRIPE_SECRET_KEY'], $sid);
            $sess = (!empty($exp['success']) && is_array($exp['data'])) ? $exp['data'] : $obj;
            $meta = is_array($sess['metadata'] ?? null) ? $sess['metadata'] : [];

            $orgId = orgNormalizeId($meta['org_id'] ?? '');
            if ($orgId === '') {
                @file_put_contents($eventFlag, $payload);
                echo json_encode(['success' => true, 'ignored' => true, 'reason' => 'missing_org_id']);
                exit;
            }
            $o = orgRead($orgId);
            if (!$o) {
                @file_put_contents($eventFlag, $payload);
                echo json_encode(['success' => true, 'ignored' => true, 'reason' => 'org_not_found']);
                exit;
            }
            orgEnsureBillingFields($o);

            $customerId = (string)($sess['customer']['id'] ?? ($sess['customer'] ?? ''));
            if ($customerId !== '') $o['billing']['stripe']['customer_id'] = $customerId;

            $setupIntentId = (string)($sess['setup_intent']['id'] ?? ($sess['setup_intent'] ?? ''));
            if ($setupIntentId === '') {
                orgBillingLogEvent($o, 'setup_complete_missing_setup_intent', ['session_id' => $sid]);
                orgWrite($orgId, $o);
                @file_put_contents($eventFlag, $payload);
                echo json_encode(['success' => true, 'ok' => false, 'reason' => 'missing_setup_intent']);
                exit;
            }

            $pmId = '';
            $si   = stripeRetrieveSetupIntent($GLOBALS['STRIPE_SECRET_KEY'], $setupIntentId);
            if (!empty($si['success']) && is_array($si['data'])) {
                $siObj = $si['data'];
                $pmId  = (string)($siObj['payment_method']['id'] ?? ($siObj['payment_method'] ?? ''));
            }
            if ($pmId === '') {
                $o['billing']['stripe']['has_payment_method']    = false;
                $o['billing']['stripe']['payment_method_id']     = null;
                $o['billing']['auto_topup']['status']            = 'needs_payment_method';
                $o['billing']['auto_topup']['last_error']        = 'Missing payment method after setup';
                orgBillingLogEvent($o, 'setup_complete_missing_pm', ['setup_intent' => $setupIntentId]);
                orgWrite($orgId, $o);
                @file_put_contents($eventFlag, $payload);
                echo json_encode(['success' => true, 'ok' => false, 'reason' => 'pm_missing']);
                exit;
            }

            $brand = $last4 = $expM = $expY = null;
            $pm = stripeRetrievePaymentMethod($GLOBALS['STRIPE_SECRET_KEY'], $pmId);
            if (!empty($pm['success']) && is_array($pm['data'])) {
                $card  = is_array($pm['data']['card'] ?? null) ? $pm['data']['card'] : [];
                $brand = $card['brand']     ?? null;
                $last4 = $card['last4']     ?? null;
                $expM  = $card['exp_month'] ?? null;
                $expY  = $card['exp_year']  ?? null;
            }
            if ($customerId !== '') {
                stripeCustomerSetDefaultPaymentMethod($GLOBALS['STRIPE_SECRET_KEY'], $customerId, $pmId);
            }

            $o['billing']['stripe']['payment_method_id']  = $pmId;
            $o['billing']['stripe']['has_payment_method'] = true;
            $o['billing']['stripe']['brand']     = $brand;
            $o['billing']['stripe']['last4']     = $last4;
            $o['billing']['stripe']['exp_month'] = $expM;
            $o['billing']['stripe']['exp_year']  = $expY;
            $o['billing']['auto_topup']['status']     = 'ok';
            $o['billing']['auto_topup']['last_error'] = null;
            orgBillingLogEvent($o, 'payment_method_saved', [
                'customer_id'       => $customerId,
                'payment_method_id' => $pmId,
                'brand' => $brand,
                'last4' => $last4,
            ]);
            orgWrite($orgId, $o);

            // Prime charge: if auto-topup is enabled and balance < threshold, charge now
            try {
                $oPrime = orgRead($orgId);
                if ($oPrime) {
                    orgEnsureBillingFields($oPrime);
                    orgEnsureCreditsFields($oPrime);
                    $enabled   = !empty($oPrime['billing']['auto_topup']['enabled']);
                    $threshold = (int)($oPrime['billing']['auto_topup']['threshold_dollars'] ?? 70);
                    $balance   = (int)($oPrime['credits_balance'] ?? 0);
                    if ($enabled && $balance < $threshold) {
                        $prime = orgAutoTopupTry($orgId, '', $balance, [
                            'reason'           => 'card_setup_prime',
                            'source'           => 'stripe_setup_webhook',
                            'setup_session_id' => (string)($sid ?? ''),
                        ]);
                        $oLog = orgRead($orgId);
                        if ($oLog) {
                            orgEnsureBillingFields($oLog);
                            orgEnsureCreditsFields($oLog);
                            orgBillingLogEvent($oLog, 'setup_prime_attempt', [
                                'enabled'        => $enabled,
                                'threshold'      => $threshold,
                                'balance_before' => $balance,
                                'result'         => $prime,
                            ]);
                            orgWrite($orgId, $oLog);
                        }
                    }
                }
            } catch (Exception $e) {
                error_log("setup_prime exception org=$orgId err=" . $e->getMessage());
            }

            @file_put_contents($eventFlag, $payload);
            echo json_encode(['success' => true, 'setup_saved' => true, 'primed' => true]);
            exit;
        }
        // fall through to payment-mode fulfillment below
    }

    $shouldFulfill = in_array($type, ['checkout.session.completed', 'checkout.session.async_payment_succeeded'], true);
    if (!$shouldFulfill || !is_array($obj)) {
        @file_put_contents($eventFlag, $payload);
        echo json_encode(['success' => true, 'ignored' => true]);
        exit;
    }

    $out = withStripeLock(function() use ($obj) {
        return stripeFulfillFromSessionObject($obj, 'stripe_webhook');
    });
    @file_put_contents($eventFlag, $payload);
    http_response_code(200);
    echo json_encode(['success' => true, 'result' => $out]);
    exit;
}

// ------------------------------------------------
// ------------- STRIPE ACTION HANDLERS ----------
// ------------------------------------------------

function handleStripeActions($action) {
    global $STRIPE_SECRET_KEY, $BASE_URL;

    // --- Create checkout session (credit purchase) ---
    if ($action === 'stripe_create_checkout') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $email = strtolower(trim($_SESSION['user_email']));
        $qty   = (int)($_POST['qty'] ?? 1);

        // Check signup match eligibility. stripeSignupMatchEligibility() handles the
        // global toggle, prior-purchase detection, and claimed_deals all in one call.
        $eligibility = stripeSignupMatchEligibility($email);
        $isSignupMatch = $eligibility['eligible'];

        // Resolve org and ensure a Stripe customer exists so we can attach the
        // session to it. This lets Stripe save the payment method during checkout
        // (payment_intent_data[setup_future_usage]=off_session), meaning the card
        // is authorized for future auto top-ups without any extra step.
        $resolvedOrgId  = $eligibility['org_id'] ?? null;
        $resolvedCustId = '';
        if (!$resolvedOrgId) {
            // eligibility check may not have run if deal is disabled — resolve manually
            if (function_exists('actorOrgIdByEmail')) {
                $resolvedOrgId = actorOrgIdByEmail($email) ?: null;
            }
            if (!$resolvedOrgId && function_exists('readUserDataByEmail')) {
                $u = readUserDataByEmail($email);
                if ($u) $resolvedOrgId = orgNormalizeId($u['organization_id'] ?? '') ?: null;
            }
        }
        if ($resolvedOrgId) {
            $oForCustomer = orgRead($resolvedOrgId);
            if ($oForCustomer) {
                orgEnsureBillingFields($oForCustomer);
                $resolvedCustId = (string)($oForCustomer['billing']['stripe']['customer_id'] ?? '');
                if ($resolvedCustId === '') {
                    $mk = stripeCreateCustomer($GLOBALS['STRIPE_SECRET_KEY'], $resolvedOrgId, (string)($oForCustomer['name'] ?? 'Organization'));
                    if (!empty($mk['success']) && !empty($mk['customer_id'])) {
                        $resolvedCustId = $mk['customer_id'];
                        $oForCustomer['billing']['stripe']['customer_id'] = $resolvedCustId;
                        orgBillingLogEvent($oForCustomer, 'stripe_customer_created', [
                            'customer_id' => $resolvedCustId,
                            'source'      => 'checkout_auto',
                        ]);
                        orgWrite($resolvedOrgId, $oForCustomer);
                    }
                }
            }
        }

        $out = stripeCreateCreditPurchaseSession($STRIPE_SECRET_KEY, $qty, $email, $BASE_URL, $isSignupMatch, $resolvedCustId, (string)($resolvedOrgId ?? ''));

        // Surface deal info to the frontend so it can show a banner / confirmation
        if ($isSignupMatch) {
            $out['deal_applied']   = 'signup_match_50';
            $out['deal_org_id']    = $eligibility['org_id'];
            $out['bonus_dollars']  = (int)round($qty * 0.50);
            $out['total_credited'] = $qty + (int)round($qty * 0.50);
        }

        echo json_encode($out);
        return true;
    }

    // --- Fulfill a completed checkout session immediately (return-page fast path) ---
    if ($action === 'stripe_fulfill_session') {
        if (!isset($_SESSION['user_email'])) die(json_encode(['success' => false, 'error' => 'Not logged in']));
        $sessionId = trim((string)($_POST['session_id'] ?? ''));
        if ($sessionId === '') die(json_encode(['success' => false, 'error' => 'Missing session_id']));
        $out = withStripeLock(function() use ($sessionId) {
            $ret = stripeRetrieveCheckoutSession($GLOBALS['STRIPE_SECRET_KEY'], $sessionId);
            if (empty($ret['success'])) return $ret;
            $sess = $ret['session'] ?? null;
            if (!is_array($sess)) return ['success' => false, 'error' => 'Bad session JSON'];
            return stripeFulfillFromSessionObject($sess, 'stripe_manual_fulfill');
        });
        if (!$out) die(json_encode(['success' => false, 'error' => 'Stripe lock failed']));
        echo json_encode($out);
        return true;
    }

    // --- Billing auto-topup setup start ---
    if ($action === 'billing_autotopup_setup_start') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success' => false, 'error' => 'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success' => false, 'error' => 'Org not found']));
        orgEnsureBillingFields($o);

        $cid = (string)($o['billing']['stripe']['customer_id'] ?? '');
        if ($cid === '') {
            $mk = stripeCreateCustomer($GLOBALS['STRIPE_SECRET_KEY'], $orgId, (string)($o['name'] ?? 'Organization'));
            if (empty($mk['success']) || empty($mk['customer_id'])) die(json_encode(['success' => false, 'error' => 'Customer create failed']));
            $cid = $mk['customer_id'];
            $o['billing']['stripe']['customer_id'] = $cid;
            orgBillingLogEvent($o, 'stripe_customer_created', ['customer_id' => $cid]);
            orgWrite($orgId, $o);
        }

        $sess = stripeCreateSetupCheckoutSession($GLOBALS['STRIPE_SECRET_KEY'], $orgId, $cid, $GLOBALS['BASE_URL']);
        if (empty($sess['success']) || empty($sess['url'])) {
            error_log("setup_start: stripe setup session failed: " . json_encode($sess));
            die(json_encode(['success' => false, 'error' => 'Setup session failed', 'stripe' => $sess]));
        }
        echo json_encode(['success' => true, 'url' => $sess['url']]);
        return true;
    }

    return false; // action not handled here
}