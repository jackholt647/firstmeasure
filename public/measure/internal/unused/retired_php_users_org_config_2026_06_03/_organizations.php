<?php
require_once __DIR__ . '/_storage.php';
/**
 * _organizations.php
 *
 * Organization-related functions and action handlers.
 * This file should be included AFTER all config, globals are defined,
 * and BEFORE _users.php (since users depend on org functions).
 *
 * Contains:
 * - Utility functions (atomicWriteJson, genHexId, etc.)
 * - Organization helper functions (read/write, ensure fields, etc.)
 * - Credits functions (resolve, get, add, spend)
 * - Internal mutation helpers
 * - Organization action handlers
 */

// ------------------------------------------------
// ---------------- UTILITY FUNCTIONS -------------
// ------------------------------------------------

function atomicWriteJson($path, $data) {
    $dir = dirname($path);
    if (!file_exists($dir)) @mkdir($dir, 0777, true);
    $tmp = $path . '.tmp_' . uniqid('', true);
    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) return false;
    if (@file_put_contents($tmp, $json) === false) return false;
    return @rename($tmp, $path);
}

function genHexId($bytes = 12) {
    try { return bin2hex(random_bytes($bytes)); }
    catch (Exception $e) { return bin2hex(openssl_random_pseudo_bytes($bytes)); }
}

// ------------------------------------------------
// ---------------- ORG HELPER FUNCTIONS ----------
// ------------------------------------------------

function orgNormalizeId($id) {
    $id = strtolower(trim((string)$id));
    $id = preg_replace('/[^a-f0-9]/', '', $id);
    return $id;
}

function orgDirPath() {
    $p = $GLOBALS['orgDir'] ?? (storageDir('organizations'));
    if (!file_exists($p)) @mkdir($p, 0777, true);
    return rtrim($p, '/\\') . '/';
}

function orgPath($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    return orgDirPath() . $orgId . '/';
}

function orgManifestPath($orgId) {
    $dir = orgPath($orgId);
    if (!$dir) return null;
    return $dir . 'manifest.json';
}

function orgEnsureCreditsFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['credits_balance'])) $o['credits_balance'] = 0;
    if (!is_numeric($o['credits_balance'])) $o['credits_balance'] = 0;
    $o['credits_balance'] = round((float)$o['credits_balance'], 2);
    if (!isset($o['credits_ledger']) || !is_array($o['credits_ledger'])) $o['credits_ledger'] = [];
}

function orgEnsureBrandingFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['branding']) || !is_array($o['branding'])) $o['branding'] = [];
    if (!isset($o['branding']['logo']) ) $o['branding']['logo'] = null;
    if (!isset($o['branding']['colors']) || !is_array($o['branding']['colors'])) $o['branding']['colors'] = [];
    $defaults = [
        'primary'   => '#DB0000',
        'secondary' => '#111111',
        'accent'    => '#1A73E8',
    ];
    foreach ($defaults as $k=>$v) {
        if (empty($o['branding']['colors'][$k])) $o['branding']['colors'][$k] = $v;
        $o['branding']['colors'][$k] = orgNormalizeHexColor($o['branding']['colors'][$k], $v);
    }
}

function orgNormalizeHexColor($hex, $fallback = '#000000') {
    $hex = strtoupper(trim((string)$hex));
    if ($hex === '') return $fallback;
    if ($hex[0] !== '#') $hex = '#' . $hex;
    if (!preg_match('/^#[0-9A-F]{6}$/', $hex)) return $fallback;
    return $hex;
}

// ---------------- ORG REPORT SETTINGS HELPERS ----------------

function orgEnsureReportSettingsFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['report_settings']) || !is_array($o['report_settings'])) {
        $o['report_settings'] = [];
    }
    // Support both legacy flat object and new {general, customer}
    $rs = $o['report_settings'];
    // If someone accidentally stored the old "customer flags" flat at report_settings
    // (no general/customer keys), normalize it.
    $hasBuckets = (is_array($rs) && (isset($rs['general']) || isset($rs['customer'])));
    if (!$hasBuckets) {
        $o['report_settings'] = [
            'general' => $rs,
            'customer' => $rs,
        ];
        $rs = $o['report_settings'];
    }
    if (!isset($o['report_settings']['general']) || !is_array($o['report_settings']['general'])) {
        $o['report_settings']['general'] = [];
    }
    if (!isset($o['report_settings']['customer']) || !is_array($o['report_settings']['customer'])) {
        $o['report_settings']['customer'] = [];
    }
    // ---- General defaults ----
    // Your UI calls it nfva_ratio (user said NMVA; we accept both).
    if (!array_key_exists('nfva_ratio', $o['report_settings']['general'])) {
        // if someone stored nmva_ratio, map it over
        if (array_key_exists('nmva_ratio', $o['report_settings']['general'])) {
            $o['report_settings']['general']['nfva_ratio'] = $o['report_settings']['general']['nmva_ratio'];
        } else {
            $o['report_settings']['general']['nfva_ratio'] = 300;
        }
    }
    $o['report_settings']['general']['nfva_ratio'] = max(1, min(1000, (int)$o['report_settings']['general']['nfva_ratio']));
    if (!array_key_exists('bonus_upfront_match_offer_enabled', $o['report_settings']['general'])) {
        $o['report_settings']['general']['bonus_upfront_match_offer_enabled'] = true;
    }
    $o['report_settings']['general']['bonus_upfront_match_offer_enabled'] = !!$o['report_settings']['general']['bonus_upfront_match_offer_enabled'];
    // ---- Customer defaults ----
    $defaults = [
        'cover_show_customer' => true,
        'cover_show_squares' => true,
        'cover_show_waste' => true,
        'cover_show_breakdown' => true,
        'cover_show_pitch' => true,
        'cover_show_facets' => true,
        'page_top_view' => true,
        'page_elevations' => true,
        'page_3d' => true,
        'page_pitch' => true,
        'page_area' => true,
        'page_layers' => true,
        'page_summary' => true,
        'page_materials' => true,
        'page_ventilation' => true
    ];
    foreach ($defaults as $k => $v) {
        if (!array_key_exists($k, $o['report_settings']['customer'])) {
            $o['report_settings']['customer'][$k] = $v;
        } else {
            $o['report_settings']['customer'][$k] = !!$o['report_settings']['customer'][$k];
        }
    }
}

function orgEnsureUsersFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['users']) || !is_array($o['users'])) $o['users'] = [];
    if (!isset($o['users_meta']) || !is_array($o['users_meta'])) $o['users_meta'] = []; // optional convenience map
}

function orgOfferRegistry() {
    static $registry = null;
    if (is_array($registry)) return $registry;
    $registry = [
        'legacy_signup_match_v1' => [
            'id' => 'legacy_signup_match_v1',
            'label' => 'Legacy Sign-Up Match',
            'type' => 'credit_bonus',
            'claim_once' => true,
            'window_days' => 0,
            'meta_defaults' => [
                'source' => 'legacy_signup_match',
                'session_id' => '',
                'stripe_checkout_session_id' => '',
                'paid_dollars' => 0,
                'bonus_dollars' => 0,
                'legacy_claimed_deal_key' => 'signup_match_50',
            ],
        ],
        'bonus_upfront_match_v1' => [
            'id' => 'bonus_upfront_match_v1',
            'label' => 'Bonus Upfront Match',
            'type' => 'credit_bonus',
            'claim_once' => true,
            'window_days' => 1,
            'meta_defaults' => [
                'source' => 'bonus_upfront_match',
                'session_id' => '',
                'stripe_checkout_session_id' => '',
                'paid_dollars' => 0,
                'bonus_dollars' => 0,
                'discount_percent' => 50,
                'banner_window_hours' => 24,
                'selected_tier_id' => '',
            ],
        ],
        'referral_week_discount_v1' => [
            'id' => 'referral_week_discount_v1',
            'label' => 'Referral Week Discount',
            'type' => 'order_discount',
            'claim_once' => true,
            'window_days' => 7,
            'meta_defaults' => [
                'source' => 'referral_week_discount',
                'referrer_id' => '',
                'referrer_name' => '',
                'referrer_type' => '',
                'discount_percent' => 50,
                'window_days' => 7,
                'applied_items' => [],
            ],
        ],
    ];
    return $registry;
}

function orgOfferBonusUpfrontMatchTiers() {
    return [
        [
            'id' => 'tier_1',
            'label' => 'Tier 1',
            'customer_pays' => 500,
            'bonus_dollars' => 125,
            'total_account_value' => 625,
            'type' => 'fixed',
        ],
        [
            'id' => 'tier_2',
            'label' => 'Tier 2',
            'customer_pays' => 1000,
            'bonus_dollars' => 500,
            'total_account_value' => 1500,
            'type' => 'fixed',
        ],
        [
            'id' => 'tier_3',
            'label' => 'Tier 3',
            'customer_pays' => 3000,
            'bonus_dollars' => 1500,
            'total_account_value' => 4500,
            'type' => 'fixed',
        ],
        [
            'id' => 'tier_4_custom',
            'label' => 'Tier 4 (Custom)',
            'minimum_customer_pays' => 3001,
            'bonus_match_percent' => 50,
            'bonus_cap' => 10000,
            'type' => 'custom',
        ],
    ];
}

function orgOfferBonusUpfrontMatchQuote($amount) {
    $amount = max(0, (int)$amount);
    $fixedMap = [
        500 => ['tier_id' => 'tier_1', 'tier_label' => 'Tier 1', 'bonus_dollars' => 125],
        1000 => ['tier_id' => 'tier_2', 'tier_label' => 'Tier 2', 'bonus_dollars' => 500],
        3000 => ['tier_id' => 'tier_3', 'tier_label' => 'Tier 3', 'bonus_dollars' => 1500],
    ];
    if (isset($fixedMap[$amount])) {
        $row = $fixedMap[$amount];
        $bonus = (int)$row['bonus_dollars'];
        return [
            'valid' => true,
            'offer_id' => 'bonus_upfront_match_v1',
            'tier_id' => (string)$row['tier_id'],
            'tier_label' => (string)$row['tier_label'],
            'customer_pays' => $amount,
            'bonus_dollars' => $bonus,
            'total_account_value' => $amount + $bonus,
            'match_percent' => $amount > 0 ? round(($bonus / $amount) * 100, 2) : 0,
            'reason' => 'eligible_fixed_tier',
        ];
    }
    if ($amount > 3000) {
        $bonus = min(10000, (int)floor($amount * 0.50));
        return [
            'valid' => true,
            'offer_id' => 'bonus_upfront_match_v1',
            'tier_id' => 'tier_4_custom',
            'tier_label' => 'Tier 4 (Custom)',
            'customer_pays' => $amount,
            'bonus_dollars' => $bonus,
            'total_account_value' => $amount + $bonus,
            'match_percent' => 50,
            'bonus_cap' => 10000,
            'reason' => 'eligible_custom_tier',
        ];
    }
    return [
        'valid' => false,
        'offer_id' => 'bonus_upfront_match_v1',
        'customer_pays' => $amount,
        'bonus_dollars' => 0,
        'total_account_value' => $amount,
        'reason' => 'invalid_amount_for_bonus_upfront_match',
    ];
}

function orgOfferDefinition($offerId) {
    $registry = orgOfferRegistry();
    $offerId = trim((string)$offerId);
    return $registry[$offerId] ?? null;
}

function orgOfferMetaDefaults($offerId) {
    $def = orgOfferDefinition($offerId);
    return is_array($def['meta_defaults'] ?? null) ? $def['meta_defaults'] : [];
}

function orgOfferBaseEntry($offerId) {
    return [
        'offer_id' => (string)$offerId,
        'status' => 'unknown',
        'eligibility_reason' => 'unknown',
        'shown' => false,
        'show_count' => 0,
        'first_shown_at' => null,
        'last_shown_at' => null,
        'claimed' => false,
        'claimed_at' => null,
        'starts_at' => null,
        'ends_at' => null,
        'updated_at' => null,
        'meta' => orgOfferMetaDefaults($offerId),
    ];
}

function orgOfferNormalizeEntry($offerId, $entry) {
    $base = orgOfferBaseEntry($offerId);
    $entry = is_array($entry) ? $entry : [];
    $meta = array_merge(
        $base['meta'],
        is_array($entry['meta'] ?? null) ? $entry['meta'] : []
    );
    $out = array_merge($base, $entry);
    $out['offer_id'] = (string)$offerId;
    $out['shown'] = !empty($out['shown']);
    $out['show_count'] = max(0, (int)($out['show_count'] ?? 0));
    $out['claimed'] = !empty($out['claimed']);
    $out['first_shown_at'] = $out['first_shown_at'] ?: null;
    $out['last_shown_at'] = $out['last_shown_at'] ?: null;
    $out['claimed_at'] = $out['claimed_at'] ?: null;
    $out['starts_at'] = $out['starts_at'] ?: null;
    $out['ends_at'] = $out['ends_at'] ?: null;
    $out['updated_at'] = $out['updated_at'] ?: null;
    $out['status'] = trim((string)($out['status'] ?? 'unknown')) ?: 'unknown';
    $out['eligibility_reason'] = trim((string)($out['eligibility_reason'] ?? 'unknown')) ?: 'unknown';
    $out['meta'] = $meta;
    return $out;
}

function orgEnsureOffersFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['offers']) || !is_array($o['offers'])) $o['offers'] = [];
    if (!isset($o['offers']['version'])) $o['offers']['version'] = 1;
    $o['offers']['version'] = max(1, (int)$o['offers']['version']);
    if (!isset($o['offers']['items']) || !is_array($o['offers']['items'])) $o['offers']['items'] = [];
    foreach (orgOfferRegistry() as $offerId => $def) {
        if (isset($o['offers']['items'][$offerId])) {
            $o['offers']['items'][$offerId] = orgOfferNormalizeEntry($offerId, $o['offers']['items'][$offerId]);
        }
    }
}

function orgOfferTimestampToIso($value) {
    if ($value === null) return null;
    if (is_int($value) || is_float($value) || (is_string($value) && preg_match('/^\d+$/', trim((string)$value)))) {
        $ts = (int)$value;
        if ($ts > 9999999999) $ts = (int)floor($ts / 1000);
        return $ts > 0 ? gmdate('c', $ts) : null;
    }
    $raw = trim((string)$value);
    if ($raw === '') return null;
    $ts = strtotime($raw);
    return $ts === false ? null : gmdate('c', $ts);
}

function orgOfferActiveAtTs($entry, $nowTs = null) {
    $entry = is_array($entry) ? $entry : [];
    $nowTs = $nowTs !== null ? (int)$nowTs : time();
    $startTs = orgProjectTs($entry['starts_at'] ?? null);
    $endTs = orgProjectTs($entry['ends_at'] ?? null);
    if ($startTs !== null && $nowTs < $startTs) return false;
    if ($endTs !== null && $nowTs > $endTs) return false;
    return true;
}

function orgOfferResolveState($offerId, $entry, $orgId = '') {
    $entry = orgOfferNormalizeEntry($offerId, $entry);
    $nowTs = time();
    if ($offerId === 'legacy_signup_match_v1') {
        if (!empty($entry['claimed'])) {
            $entry['status'] = 'claimed';
            $entry['eligibility_reason'] = 'historical_claimed';
        } else {
            $entry['status'] = 'unavailable';
            $entry['eligibility_reason'] = 'historical_only';
        }
    } elseif ($offerId === 'bonus_upfront_match_v1') {
        if (!empty($entry['claimed'])) {
            $entry['status'] = 'claimed';
            $entry['eligibility_reason'] = 'already_claimed';
        } else {
            $windowHours = max(1, (int)($entry['meta']['banner_window_hours'] ?? 24));
            $startTs = orgProjectTs($entry['starts_at'] ?? null);
            if ($startTs === null && !empty($entry['first_shown_at'])) {
                $startTs = orgProjectTs($entry['first_shown_at']);
                if ($startTs !== null) {
                    $entry['starts_at'] = gmdate('c', $startTs);
                }
            }
            $endTs = orgProjectTs($entry['ends_at'] ?? null);
            if ($endTs === null && $startTs !== null) {
                $endTs = $startTs + ($windowHours * 3600);
                $entry['ends_at'] = gmdate('c', $endTs);
            }
            if (!empty($entry['shown']) && $endTs !== null && $nowTs > $endTs) {
                $entry['status'] = 'expired';
                $entry['eligibility_reason'] = 'expired_window';
            } elseif (!empty($entry['shown']) && $startTs !== null && $nowTs < $startTs) {
                $entry['status'] = 'scheduled';
                $entry['eligibility_reason'] = 'scheduled';
            } elseif (!empty($entry['shown'])) {
                $entry['status'] = 'active';
                $entry['eligibility_reason'] = 'active_window';
            } else {
                $entry['status'] = 'eligible';
                $entry['eligibility_reason'] = 'awaiting_activation';
            }
        }
    } elseif ($offerId === 'referral_week_discount_v1') {
        if (!empty($entry['claimed'])) {
            $startTs = orgProjectTs($entry['starts_at'] ?? null);
            $endTs = orgProjectTs($entry['ends_at'] ?? null);
            if ($startTs !== null && $nowTs < $startTs) {
                $entry['status'] = 'scheduled';
                $entry['eligibility_reason'] = 'scheduled';
            } elseif ($endTs !== null && $nowTs > $endTs) {
                $entry['status'] = 'expired';
                $entry['eligibility_reason'] = 'expired';
            } else {
                $entry['status'] = 'active';
                $entry['eligibility_reason'] = 'active_window';
            }
        } else {
            $entry['status'] = 'eligible';
            $entry['eligibility_reason'] = 'eligible';
        }
    }
    return $entry;
}

function orgOffersSnapshot($orgOrId) {
    $org = null;
    $orgId = '';
    if (is_array($orgOrId)) {
        $org = $orgOrId;
        $orgId = orgNormalizeId($org['id'] ?? '');
    } else {
        $orgId = orgNormalizeId($orgOrId);
        if ($orgId !== '') $org = orgRead($orgId);
    }
    if (!is_array($org)) return [];
    orgEnsureOffersFields($org);
    $items = [];
    foreach (orgOfferRegistry() as $offerId => $def) {
        $entry = orgOfferResolveState($offerId, $org['offers']['items'][$offerId] ?? [], $orgId);
        $items[$offerId] = array_merge(
            [
                'label' => (string)($def['label'] ?? $offerId),
                'type' => (string)($def['type'] ?? ''),
            ],
            $entry
        );
    }
    return [
        'version' => 1,
        'items' => $items,
    ];
}

function orgRepairLegacySignupMatchOffer(&$o) {
    if (!is_array($o)) $o = [];
    orgEnsureOffersFields($o);
    $changed = false;

    $legacyMeta = [];
    $legacyClaimedAt = null;
    $claimedDeals = is_array($o['claimed_deals'] ?? null) ? $o['claimed_deals'] : [];
    if (!empty($claimedDeals['signup_match_50'])) {
        $legacyMeta = array_merge($legacyMeta, is_array($claimedDeals['signup_match_50_meta'] ?? null) ? $claimedDeals['signup_match_50_meta'] : []);
        $legacyClaimedAt = orgOfferTimestampToIso($claimedDeals['signup_match_50_claimed_at'] ?? null);
    }

    $ledger = is_array($o['credits_ledger'] ?? null) ? $o['credits_ledger'] : [];
    foreach ($ledger as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower(trim((string)($entry['reason'] ?? '')));
        if ($reason !== 'stripe_checkout_paid') continue;
        $meta = is_array($entry['meta'] ?? null) ? $entry['meta'] : [];
        $isSignupMatch = !empty($meta['is_signup_match']) || (int)($meta['bonus_dollars'] ?? 0) > 0;
        if (!$isSignupMatch) continue;
        $legacyMeta = array_merge($legacyMeta, [
            'session_id' => (string)($meta['session_id'] ?? $legacyMeta['session_id'] ?? ''),
            'stripe_checkout_session_id' => (string)($meta['session_id'] ?? $legacyMeta['stripe_checkout_session_id'] ?? ''),
            'paid_dollars' => (int)($meta['paid_dollars'] ?? $legacyMeta['paid_dollars'] ?? 0),
            'bonus_dollars' => (int)($meta['bonus_dollars'] ?? $legacyMeta['bonus_dollars'] ?? 0),
            'source' => (string)($meta['source'] ?? $legacyMeta['source'] ?? 'legacy_signup_match'),
        ]);
        if ($legacyClaimedAt === null) {
            $legacyClaimedAt = orgOfferTimestampToIso($entry['ts'] ?? null);
        }
    }

    if ($legacyClaimedAt === null && empty($legacyMeta)) {
        return false;
    }

    $existing = orgOfferNormalizeEntry('legacy_signup_match_v1', $o['offers']['items']['legacy_signup_match_v1'] ?? []);
    if (empty($existing['claimed'])) {
        $existing['claimed'] = true;
        $existing['claimed_at'] = $legacyClaimedAt ?: gmdate('c');
        $changed = true;
    } elseif (empty($existing['claimed_at']) && $legacyClaimedAt) {
        $existing['claimed_at'] = $legacyClaimedAt;
        $changed = true;
    }
    if ($legacyClaimedAt && empty($existing['starts_at'])) {
        $existing['starts_at'] = $legacyClaimedAt;
        $changed = true;
    }
    $mergedMeta = array_merge($existing['meta'], array_filter($legacyMeta, function($value) {
        if (is_string($value)) return trim($value) !== '';
        if (is_int($value) || is_float($value)) return $value !== 0;
        return $value !== null;
    }));
    if ($mergedMeta !== $existing['meta']) {
        $existing['meta'] = $mergedMeta;
        $changed = true;
    }
    $resolved = orgOfferResolveState('legacy_signup_match_v1', $existing);
    if ($resolved !== ($o['offers']['items']['legacy_signup_match_v1'] ?? null)) {
        $o['offers']['items']['legacy_signup_match_v1'] = $resolved;
        $changed = true;
    }
    return $changed;
}

function orgRepairOfferHistory(&$o, $orgId = '') {
    if (!is_array($o)) $o = [];
    orgEnsureOffersFields($o);
    $changed = false;
    if (orgRepairLegacySignupMatchOffer($o)) $changed = true;
    foreach (orgOfferRegistry() as $offerId => $def) {
        $resolved = orgOfferResolveState($offerId, $o['offers']['items'][$offerId] ?? [], $orgId);
        if ($resolved !== ($o['offers']['items'][$offerId] ?? null)) {
            $o['offers']['items'][$offerId] = $resolved;
            $changed = true;
        }
    }
    if ($changed) {
        $o['offers']['last_repaired_at'] = gmdate('c');
    }
    return $changed;
}

function orgOfferLoadForUpdate($orgId, $offerId) {
    $orgId = orgNormalizeId($orgId);
    $offerId = trim((string)$offerId);
    $def = orgOfferDefinition($offerId);
    if ($orgId === '' || !$def) return [null, null, 'invalid_offer'];
    $o = orgRead($orgId);
    if (!is_array($o)) return [null, null, 'org_not_found'];
    orgEnsureOffersFields($o);
    $entry = orgOfferResolveState($offerId, $o['offers']['items'][$offerId] ?? [], $orgId);
    return [$o, $entry, null];
}

function orgOfferSaveEntry($orgId, &$o, $offerId, $entry) {
    orgEnsureOffersFields($o);
    $entry = orgOfferResolveState($offerId, $entry, $orgId);
    $entry['updated_at'] = gmdate('c');
    $o['offers']['items'][$offerId] = $entry;
    return orgWrite($orgId, $o);
}

function orgOfferMarkShown($orgId, $offerId, $meta = []) {
    list($o, $entry, $error) = orgOfferLoadForUpdate($orgId, $offerId);
    if ($error) return ['success' => false, 'error' => $error];
    $now = gmdate('c');
    $isFirstShow = empty($entry['first_shown_at']);
    $entry['shown'] = true;
    $entry['show_count'] = max(0, (int)($entry['show_count'] ?? 0)) + 1;
    if ($isFirstShow) $entry['first_shown_at'] = $now;
    $entry['last_shown_at'] = $now;
    if (is_array($meta) && $meta) {
        $entry['meta'] = array_merge($entry['meta'], $meta);
    }
    if ($offerId === 'bonus_upfront_match_v1') {
        $windowHours = max(1, (int)($entry['meta']['banner_window_hours'] ?? 24));
        if (empty($entry['starts_at'])) $entry['starts_at'] = $entry['first_shown_at'] ?: $now;
        if (empty($entry['ends_at'])) {
            $startTs = orgProjectTs($entry['starts_at'] ?? null);
            if ($startTs !== null) {
                $entry['ends_at'] = gmdate('c', $startTs + ($windowHours * 3600));
            }
        }
    }
    if (!orgOfferSaveEntry($orgId, $o, $offerId, $entry)) {
        return ['success' => false, 'error' => 'org_write_failed'];
    }
    return ['success' => true, 'offer' => orgOffersSnapshot($o)['items'][$offerId] ?? orgOfferResolveState($offerId, $entry, $orgId)];
}

function orgOfferClaim($orgId, $offerId, $meta = [], $options = []) {
    list($o, $entry, $error) = orgOfferLoadForUpdate($orgId, $offerId);
    if ($error) return ['success' => false, 'error' => $error];
    $def = orgOfferDefinition($offerId);
    $status = (string)($entry['status'] ?? '');
    if (!empty($def['claim_once']) && !empty($entry['claimed'])) {
        return ['success' => true, 'already_claimed' => true, 'offer' => orgOfferResolveState($offerId, $entry, $orgId)];
    }
    if ($offerId === 'referral_week_discount_v1') {
        $referrerId = trim((string)($meta['referrer_id'] ?? ''));
        if ($referrerId === '') {
            return ['success' => false, 'error' => 'referrer_id_required'];
        }
        $windowDays = max(1, (int)($meta['window_days'] ?? $def['window_days'] ?? 7));
        $startTs = orgProjectTs($options['starts_at'] ?? null);
        if ($startTs === null) $startTs = time();
        $endTs = orgProjectTs($options['ends_at'] ?? null);
        if ($endTs === null) $endTs = $startTs + ($windowDays * 86400);
        $entry['starts_at'] = gmdate('c', $startTs);
        $entry['ends_at'] = gmdate('c', $endTs);
        $meta['window_days'] = $windowDays;
        if (!isset($meta['discount_percent'])) {
            $meta['discount_percent'] = (int)($entry['meta']['discount_percent'] ?? $def['meta_defaults']['discount_percent'] ?? 50);
        }
    } elseif (!empty($options['starts_at']) || !empty($options['ends_at'])) {
        if (!empty($options['starts_at'])) $entry['starts_at'] = orgOfferTimestampToIso($options['starts_at']);
        if (!empty($options['ends_at'])) $entry['ends_at'] = orgOfferTimestampToIso($options['ends_at']);
    }
    $entry['claimed'] = true;
    if (empty($entry['claimed_at'])) $entry['claimed_at'] = gmdate('c');
    $entry['meta'] = array_merge($entry['meta'], is_array($meta) ? $meta : []);
    if (!orgOfferSaveEntry($orgId, $o, $offerId, $entry)) {
        return ['success' => false, 'error' => 'org_write_failed'];
    }
    return ['success' => true, 'offer' => orgOffersSnapshot($o)['items'][$offerId] ?? orgOfferResolveState($offerId, $entry, $orgId)];
}

function orgOfferEligibilityForOrg($orgId, $offerId) {
    list($o, $entry, $error) = orgOfferLoadForUpdate($orgId, $offerId);
    if ($error) return ['eligible' => false, 'org_id' => orgNormalizeId($orgId), 'offer_id' => $offerId, 'reason' => $error];
    $entry = orgOfferResolveState($offerId, $entry, $orgId);
    $eligible = in_array((string)($entry['status'] ?? ''), ['eligible', 'active'], true);
    if ($offerId === 'legacy_signup_match_v1') $eligible = false;
    if ($offerId === 'bonus_upfront_match_v1') {
        $settingEnabled = !empty($o['report_settings']['general']['bonus_upfront_match_offer_enabled']);
        if ((string)($entry['status'] ?? '') === 'claimed' || !empty($entry['claimed'])) {
            $eligible = false;
            $entry['eligibility_reason'] = 'already_claimed';
        } elseif (!$settingEnabled) {
            $eligible = false;
            $entry['eligibility_reason'] = 'disabled_by_org_setting';
        } else {
            $eligible = ((string)($entry['status'] ?? '') === 'active');
        }
    }
    return [
        'eligible' => $eligible,
        'org_id' => orgNormalizeId($orgId),
        'offer_id' => $offerId,
        'reason' => (string)($entry['eligibility_reason'] ?? 'unknown'),
        'offer' => $entry,
    ];
}

function orgOfferEligibilityByEmail($email, $offerId) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return ['eligible' => false, 'org_id' => null, 'offer_id' => $offerId, 'reason' => 'no_email'];
    $orgId = null;
    if (function_exists('actorOrgIdByEmail')) $orgId = actorOrgIdByEmail($email) ?: null;
    if (!$orgId && function_exists('readUserDataByEmail')) {
        $u = readUserDataByEmail($email);
        if ($u) $orgId = orgNormalizeId($u['organization_id'] ?? '') ?: null;
    }
    if (!$orgId) return ['eligible' => false, 'org_id' => null, 'offer_id' => $offerId, 'reason' => 'no_org'];
    return orgOfferEligibilityForOrg($orgId, $offerId);
}

function orgOfferTrackAppliedItem($orgId, $offerId, $item) {
    list($o, $entry, $error) = orgOfferLoadForUpdate($orgId, $offerId);
    if ($error) return ['success' => false, 'error' => $error];
    $meta = is_array($entry['meta'] ?? null) ? $entry['meta'] : [];
    $items = is_array($meta['applied_items'] ?? null) ? $meta['applied_items'] : [];
    $item = is_array($item) ? $item : [];
    $key = trim((string)($item['charge_token'] ?? $item['project_id'] ?? ''));
    $updated = false;
    if ($key !== '') {
        foreach ($items as $idx => $existing) {
            $existingKey = trim((string)(($existing['charge_token'] ?? '') ?: ($existing['project_id'] ?? '')));
            if ($existingKey !== '' && $existingKey === $key) {
                $items[$idx] = array_merge(is_array($existing) ? $existing : [], $item);
                $updated = true;
                break;
            }
        }
    }
    if (!$updated) $items[] = $item;
    if (count($items) > 100) $items = array_slice($items, -100);
    $entry['meta']['applied_items'] = array_values($items);
    if (!orgOfferSaveEntry($orgId, $o, $offerId, $entry)) {
        return ['success' => false, 'error' => 'org_write_failed'];
    }
    return ['success' => true, 'offer' => orgOffersSnapshot($o)['items'][$offerId] ?? orgOfferResolveState($offerId, $entry, $orgId)];
}

function orgOfferReferralDiscountPreview($orgId, $amount, $pricing = [], $context = []) {
    $amount = max(0, portalMoneyAmount($amount));
    if ($amount <= 0) {
        return [
            'original_amount' => 0,
            'final_amount' => 0,
            'discount_amount' => 0,
            'discountable_amount' => 0,
            'applied_offers' => [],
        ];
    }
    $pricing = is_array($pricing) ? $pricing : [];
    $discountableAmount = isset($pricing['discountable_amount']) && is_numeric((string)$pricing['discountable_amount'])
        ? portalMoneyAmount($pricing['discountable_amount'])
        : $amount;
    $discountableAmount = max(0, min($amount, $discountableAmount));
    $eligibility = orgOfferEligibilityForOrg($orgId, 'referral_week_discount_v1');
    $offer = is_array($eligibility['offer'] ?? null) ? $eligibility['offer'] : [];
    if (empty($eligibility['eligible']) || (string)($offer['status'] ?? '') !== 'active') {
        return [
            'original_amount' => $amount,
            'final_amount' => $amount,
            'discount_amount' => 0,
            'discountable_amount' => $discountableAmount,
            'applied_offers' => [],
        ];
    }
    $discountPercent = max(0, min(100, (int)($offer['meta']['discount_percent'] ?? 50)));
    $discountAmount = portalMoneyAmount($discountableAmount * ($discountPercent / 100));
    if ($discountAmount <= 0) {
        return [
            'original_amount' => $amount,
            'final_amount' => $amount,
            'discount_amount' => 0,
            'discountable_amount' => $discountableAmount,
            'applied_offers' => [],
        ];
    }
    $finalAmount = max(0.01, portalMoneyAmount($amount - $discountAmount));
    return [
        'original_amount' => $amount,
        'final_amount' => $finalAmount,
        'discount_amount' => $discountAmount,
        'discountable_amount' => $discountableAmount,
        'applied_offers' => [[
            'offer_id' => 'referral_week_discount_v1',
            'discount_percent' => $discountPercent,
            'discount_amount' => $discountAmount,
            'discountable_amount' => $discountableAmount,
            'referrer_id' => (string)($offer['meta']['referrer_id'] ?? ''),
            'referrer_name' => (string)($offer['meta']['referrer_name'] ?? ''),
            'referrer_type' => (string)($offer['meta']['referrer_type'] ?? ''),
            'starts_at' => $offer['starts_at'] ?? null,
            'ends_at' => $offer['ends_at'] ?? null,
        ]],
    ];
}

function orgEnsureDefaults(&$o) {
    if (!is_array($o)) $o = [];
    if (empty($o['id'])) $o['id'] = null;
    if (!isset($o['name'])) $o['name'] = '';
    if (!isset($o['created_at'])) $o['created_at'] = gmdate('c');
    if (!isset($o['created_by_user_id'])) $o['created_by_user_id'] = null;
    if (!isset($o['created_by_email'])) $o['created_by_email'] = null;
    // ── Test organization flag ──
    if (!array_key_exists('is_test', $o)) $o['is_test'] = false;
    $o['is_test'] = !!$o['is_test'];
    if (!array_key_exists('assigned_sales_email', $o)) $o['assigned_sales_email'] = '';
    if (!array_key_exists('assigned_sales_name', $o)) $o['assigned_sales_name'] = '';
    if (!array_key_exists('assigned_sales_by_email', $o)) $o['assigned_sales_by_email'] = '';
    if (!array_key_exists('assigned_sales_at', $o)) $o['assigned_sales_at'] = null;
    if (!array_key_exists('paired_lead_ids', $o) || !is_array($o['paired_lead_ids'])) $o['paired_lead_ids'] = [];
    if (!array_key_exists('paired_primary_lead_id', $o)) $o['paired_primary_lead_id'] = '';
    if (!array_key_exists('paired_at', $o)) $o['paired_at'] = null;
    orgEnsureUsersFields($o);
    orgEnsureCreditsFields($o);
    orgEnsureBrandingFields($o);
    orgEnsureBillingFields($o);
    orgEnsureReportSettingsFields($o);
    orgEnsureOffersFields($o);
    if (function_exists('referralEnsureOrgDefaults')) {
        referralEnsureOrgDefaults($o);
    }
    // NEW: contact block
    if (!isset($o['contact']) || !is_array($o['contact'])) $o['contact'] = [];
    if (!array_key_exists('email', $o['contact'])) $o['contact']['email'] = '';
    if (!array_key_exists('phone', $o['contact'])) $o['contact']['phone'] = '';
    if (!array_key_exists('address', $o['contact'])) $o['contact']['address'] = '';
    if (!is_string($o['contact']['email'])) $o['contact']['email'] = '';
    if (!is_string($o['contact']['phone'])) $o['contact']['phone'] = '';
    if (!is_string($o['contact']['address'])) $o['contact']['address'] = '';
}

function orgActorCanManageCustomers() {
    $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
    if ($actor === '') return false;
    if (function_exists('isAdmin') && isAdmin()) return true;
    if (function_exists('userHasPerm') && (userHasPerm($actor, 'manage_users') || userHasPerm($actor, 'manage_sales_users'))) {
        return true;
    }
    $u = function_exists('readUserDataByEmail') ? readUserDataByEmail($actor) : null;
    $role = strtolower(trim((string)($u['role'] ?? '')));
    return in_array($role, ['admin', 'system_admin', 'sales_manager'], true);
}

function orgActorCanViewAllCustomers() {
    return orgActorCanManageCustomers();
}

function orgSalesUsersList() {
    if (function_exists('leadSalesUsers')) return leadSalesUsers();
    $rows = [];
    $userDir = storageDir('users');
    foreach (glob($userDir . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) === 'customer') continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        if ($email === '') continue;
        $perms = is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
        $role = strtolower(trim((string)($u['role'] ?? '')));
        $dept = strtolower(trim((string)($u['department'] ?? '')));
        if ($dept !== 'sales' && empty($perms['manage_sales_users']) && !in_array($role, ['sales_manager', 'admin', 'system_admin'], true)) continue;
        $rows[] = [
            'email' => $email,
            'name' => (string)($u['name'] ?? $email),
            'role' => (string)($u['role'] ?? 'user'),
            'department' => (string)($u['department'] ?? ''),
        ];
    }
    usort($rows, function($a, $b) {
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return $rows;
}

function orgProjectTs($value) {
    if ($value === null) return null;
    if (is_int($value) || is_float($value) || (is_string($value) && preg_match('/^\d+$/', trim($value)))) {
        $ts = (int)$value;
        if ($ts > 9999999999) $ts = (int)floor($ts / 1000);
        return $ts > 0 ? $ts : null;
    }
    $raw = trim((string)$value);
    if ($raw === '') return null;
    $ts = strtotime($raw);
    return $ts === false ? null : $ts;
}

function orgJsonEncodeApiPayload($payload, $context = '') {
    $flags = 0;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    $json = json_encode($payload, $flags);
    if ($json !== false) return $json;

    $prefix = trim((string)$context);
    if ($prefix !== '') $prefix .= ' ';
    error_log($prefix . 'json_encode failed: ' . json_last_error_msg());

    $orgs = $payload['organizations'] ?? null;
    if (is_array($orgs)) {
        foreach ($orgs as $org) {
            $orgId = is_array($org) ? (string)($org['id'] ?? 'unknown') : 'non_array_org';
            if (json_encode($org, $flags) === false) {
                error_log($prefix . 'bad org payload for ' . $orgId . ': ' . json_last_error_msg());
            }
        }
    }

    return false;
}

function orgSqliteTableExists($db, $tableName) {
    if (!$db instanceof SQLite3) return false;
    $tableName = trim((string)$tableName);
    if ($tableName === '') return false;
    $stmt = @$db->prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name LIMIT 1");
    if (!$stmt) return false;
    $stmt->bindValue(':name', $tableName, SQLITE3_TEXT);
    $res = @$stmt->execute();
    if (!$res) return false;
    $row = $res->fetchArray(SQLITE3_ASSOC);
    return is_array($row) && !empty($row['name']);
}

function orgSqliteScalarInt($db, $sql) {
    if (!$db instanceof SQLite3) return 0;
    $sql = trim((string)$sql);
    if ($sql === '') return 0;
    $res = @$db->querySingle($sql);
    return is_numeric($res) ? (int)$res : 0;
}

function orgCustomerPickLatestRow($rows, $key) {
    if (!is_array($rows) || !$rows) return null;
    $latest = null;
    $latestTs = null;
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        $ts = orgProjectTs($row[$key] ?? null);
        if ($ts !== null && ($latestTs === null || $ts > $latestTs)) {
            $latest = $row;
            $latestTs = $ts;
        } elseif ($latest === null) {
            $latest = $row;
        }
    }
    return is_array($latest) ? $latest : null;
}

function orgCustomerVolumeTemplate($weeks = 52) {
    $weeks = max(1, (int)$weeks);
    $dayMs = 86400;
    $todayTs = strtotime(gmdate('Y-m-d'));
    $buckets = [];
    for ($w = $weeks - 1; $w >= 0; $w--) {
        $endTs = $todayTs - ($w * 7 * $dayMs);
        $startTs = $endTs - (7 * $dayMs);
        $buckets[] = [
            'label' => gmdate('n/j', $endTs),
            'start_ts' => $startTs,
            'end_ts' => $endTs,
            'count' => 0,
        ];
    }
    return $buckets;
}

function orgCustomerVolumeIncrement(&$buckets, $createdTs) {
    if (!is_array($buckets) || $createdTs === null) return;
    foreach ($buckets as &$bucket) {
        if ($createdTs > $bucket['start_ts'] && $createdTs <= ($bucket['end_ts'] + 86400)) {
            $bucket['count']++;
            break;
        }
    }
    unset($bucket);
}

function orgCustomerVolumeExport($buckets) {
    if (!is_array($buckets)) return [];
    return array_values(array_map(function($bucket) {
        return [
            'label' => (string)($bucket['label'] ?? ''),
            'count' => (int)($bucket['count'] ?? 0),
        ];
    }, $buckets));
}

function orgCustomerResolveProjectOrgId($projectOrgId, $ownerEmail, $issuerEmail, $projectId, $orgMap, $customerUsers, $customerProjectOrgMap) {
    $projectOrgId = orgNormalizeId($projectOrgId);
    if ($projectOrgId !== '' && isset($orgMap[$projectOrgId])) return $projectOrgId;

    $ownerEmail = strtolower(trim((string)$ownerEmail));
    if ($ownerEmail !== '' && isset($customerUsers[$ownerEmail]['org_id'])) {
        $ownerOrgId = orgNormalizeId($customerUsers[$ownerEmail]['org_id']);
        if ($ownerOrgId !== '' && isset($orgMap[$ownerOrgId])) return $ownerOrgId;
    }

    $issuerEmail = strtolower(trim((string)$issuerEmail));
    if ($issuerEmail !== '' && isset($customerUsers[$issuerEmail]['org_id'])) {
        $issuerOrgId = orgNormalizeId($customerUsers[$issuerEmail]['org_id']);
        if ($issuerOrgId !== '' && isset($orgMap[$issuerOrgId])) return $issuerOrgId;
    }

    $projectId = strtolower(trim((string)$projectId));
    if ($projectId !== '' && isset($customerProjectOrgMap[$projectId])) {
        $mappedOrgId = orgNormalizeId($customerProjectOrgMap[$projectId]);
        if ($mappedOrgId !== '' && isset($orgMap[$mappedOrgId])) return $mappedOrgId;
    }

    return '';
}

function orgCustomerLedgerOrderEvents($creditLedger) {
    $events = [];
    if (!is_array($creditLedger)) return $events;

    foreach ($creditLedger as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower(trim((string)($entry['reason'] ?? '')));
        if ($reason !== 'order_submitted') continue;

        $meta = is_array($entry['meta'] ?? null) ? $entry['meta'] : [];
        $projectId = strtolower(trim((string)($meta['project_id'] ?? '')));
        $address = trim((string)($entry['address'] ?? ($meta['address'] ?? '')));
        $createdTs = orgProjectTs($entry['ts'] ?? null);
        $createdAt = $createdTs !== null ? gmdate('c', $createdTs) : ((string)($entry['ts'] ?? '') ?: null);
        $revenue = $meta['roof_cost'] ?? null;
        if (!is_numeric($revenue)) $revenue = abs((int)round((float)($entry['delta'] ?? 0)));

        $events[] = [
            'id' => $projectId !== '' ? $projectId : ('ledger:' . md5(json_encode($entry))),
            'address' => $address,
            'status' => 'submitted',
            'owner_email' => strtolower(trim((string)($entry['applied_for_user_email'] ?? ($entry['by_email'] ?? '')))),
            'issuer' => ['email' => ''],
            'revenue' => max(0, (int)$revenue),
            'created_at' => $createdAt,
        ];
    }

    usort($events, function($a, $b) {
        return orgProjectTs($b['created_at'] ?? null) <=> orgProjectTs($a['created_at'] ?? null);
    });
    return $events;
}

function orgCustomerStoredProjectOrderRows($projectIds, $projectOwnerEmails = [], $hydrateDetails = true) {
    $rows = [];
    if (!is_array($projectIds) || !$projectIds) return $rows;

    static $detailCache = [];
    $seen = [];
    foreach ($projectIds as $projectId) {
        $projectId = strtolower(trim((string)$projectId));
        if ($projectId === '' || isset($seen[$projectId])) continue;
        $seen[$projectId] = true;

        if (!$hydrateDetails || !function_exists('fm_fetch_project_detail')) {
            $rows[] = [
                'id' => $projectId,
                'address' => '',
                'status' => 'submitted',
                'owner_email' => strtolower(trim((string)($projectOwnerEmails[$projectId] ?? ''))),
                'issuer' => ['email' => ''],
                'revenue' => 0,
                'created_at' => null,
            ];
            continue;
        }

        if (!array_key_exists($projectId, $detailCache)) {
            $detailCache[$projectId] = fm_fetch_project_detail($projectId);
        }
        $detail = $detailCache[$projectId];
        if (!is_array($detail)) continue;

        $manifest = function_exists('fm_legacy_manifest')
            ? fm_legacy_manifest($detail['manifest'] ?? [])
            : (is_array($detail['manifest'] ?? null) ? $detail['manifest'] : []);
        $ownerEmail = strtolower(trim((string)($detail['owner_email'] ?? ($manifest['owner_email'] ?? ($projectOwnerEmails[$projectId] ?? '')))));
        $issuer = is_array($detail['issuer'] ?? null) ? $detail['issuer'] : [];
        $issuerEmail = strtolower(trim((string)($detail['issuer_email'] ?? ($issuer['email'] ?? ($manifest['issuer_email'] ?? '')))));
        $charged = $detail['amount_charged'] ?? ($manifest['amount_charged'] ?? null);
        $revenue = 0;
        if ($charged !== null && is_numeric($charged)) {
            $revenue = max(0, (int)round((float)$charged));
        } elseif (function_exists('projectTypePrice')) {
            $projectType = strtolower(trim((string)($detail['project_type'] ?? ($manifest['project_type'] ?? 'residential'))));
            $revenue = max(0, (int)projectTypePrice($projectType));
        }

        $createdRaw = $detail['created_at'] ?? ($manifest['created_at'] ?? null);
        $createdTs = orgProjectTs($createdRaw);
        $rows[] = [
            'id' => $projectId,
            'address' => trim((string)($detail['address'] ?? ($manifest['address'] ?? ''))),
            'status' => trim((string)($detail['status'] ?? ($manifest['status'] ?? ''))) ?: 'queued',
            'owner_email' => $ownerEmail,
            'issuer' => ['email' => $issuerEmail],
            'revenue' => $revenue,
            'created_at' => $createdTs !== null ? gmdate('c', $createdTs) : ((string)$createdRaw ?: null),
        ];
    }

    usort($rows, function($a, $b) {
        return orgProjectTs($b['created_at'] ?? null) <=> orgProjectTs($a['created_at'] ?? null);
    });
    return $rows;
}

function orgCustomerLeadPairsSnapshot($orgIds) {
    $map = [];
    if (!is_array($orgIds) || !$orgIds || !function_exists('leadDb')) return $map;

    $normalized = [];
    foreach ($orgIds as $orgId) {
        $orgId = orgNormalizeId($orgId);
        if ($orgId !== '') $normalized[$orgId] = true;
    }
    $normalized = array_keys($normalized);
    if (!$normalized) return $map;

    try {
        $db = leadDb();
        if (!$db instanceof SQLite3) return $map;
        $quoted = array_map(function($orgId) use ($db) {
            return "'" . SQLite3::escapeString($orgId) . "'";
        }, $normalized);
        $sql = "
            SELECT
                id,
                lead_entity_id,
                organization_id,
                company,
                email,
                phone,
                updated_at
            FROM lead_memberships
            WHERE COALESCE(organization_id, '') <> ''
              AND organization_id IN (" . implode(',', $quoted) . ")
            ORDER BY updated_at DESC, company COLLATE NOCASE ASC
        ";
        $res = @$db->query($sql);
        while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
            $orgId = orgNormalizeId($row['organization_id'] ?? '');
            if ($orgId === '') continue;
            if (!isset($map[$orgId])) $map[$orgId] = [];
            $map[$orgId][] = [
                'id' => (string)($row['id'] ?? ''),
                'lead_entity_id' => (string)($row['lead_entity_id'] ?? ''),
                'organization_id' => $orgId,
                'company' => (string)($row['company'] ?? ''),
                'email' => (string)($row['email'] ?? ''),
                'phone' => (string)($row['phone'] ?? ''),
                'updated_at' => (int)($row['updated_at'] ?? 0),
                'is_linked' => true,
            ];
        }
    } catch (Throwable $e) {
        return $map;
    }

    return $map;
}

function orgCustomerLeadRowById(SQLite3 $db, $leadId, $expectedOrgId = '') {
    $leadId = trim((string)$leadId);
    $expectedOrgId = orgNormalizeId($expectedOrgId);
    if ($leadId === '') return null;

    $stmt = @$db->prepare("
        SELECT
            id,
            lead_entity_id,
            organization_id,
            company,
            email,
            phone,
            updated_at
        FROM lead_memberships
        WHERE id = :id
        LIMIT 1
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':id', $leadId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    if (!$row) return null;

    $rowOrgId = orgNormalizeId($row['organization_id'] ?? '');
    return [
        'id' => (string)($row['id'] ?? ''),
        'lead_entity_id' => (string)($row['lead_entity_id'] ?? ''),
        'organization_id' => $rowOrgId,
        'company' => (string)($row['company'] ?? ''),
        'email' => (string)($row['email'] ?? ''),
        'phone' => (string)($row['phone'] ?? ''),
        'updated_at' => (int)($row['updated_at'] ?? 0),
        'is_linked' => ($expectedOrgId !== '' && $rowOrgId !== '' && $rowOrgId === $expectedOrgId),
    ];
}

function orgCustomerDataSnapshot($actorEmail, $options = []) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $options = is_array($options) ? $options : [];
    $canViewAll = orgActorCanViewAllCustomers();
    $targetOrgId = orgNormalizeId($options['org_id'] ?? '');
    $includeOrders = !empty($options['include_orders']);
    $includeCreditLedger = !empty($options['include_credit_ledger']);
    $includeBillingEvents = !empty($options['include_billing_events']);
    $includeVolumeBuckets = array_key_exists('include_volume_buckets', $options)
        ? !!$options['include_volume_buckets']
        : ($targetOrgId !== '');
    $ordersPage = max(1, (int)($options['orders_page'] ?? 1));
    $ordersPerPage = min(200, max(10, (int)($options['orders_per_page'] ?? 50)));
    $ledgerPage = max(1, (int)($options['ledger_page'] ?? 1));
    $ledgerPerPage = min(200, max(10, (int)($options['ledger_per_page'] ?? 50)));
    $includeRevenue = !empty($options['include_revenue']) || $targetOrgId !== '' || $includeOrders;
    $projectIndexFactory = null;
    if (function_exists('projectIndexDb')) {
        $projectIndexFactory = 'projectIndexDb';
    } elseif (function_exists('pj_db')) {
        $projectIndexFactory = 'pj_db';
    }
    $preferProjectIndex = $projectIndexFactory !== null;
    $orgMap = [];
    $orgDirPath = orgDirPath();
    if (is_dir($orgDirPath)) {
        foreach (scandir($orgDirPath) as $f) {
            if ($f === '.' || $f === '..') continue;
            $manifestPath = $orgDirPath . $f . '/manifest.json';
            if (!file_exists($manifestPath)) continue;
            $o = json_decode((string)@file_get_contents($manifestPath), true);
            if (!is_array($o)) continue;
            orgEnsureDefaults($o);
            $oid = orgNormalizeId($o['id'] ?? $f);
            if ($oid === '') continue;
            if (orgRepairOfferHistory($o, $oid)) {
                @orgWrite($oid, $o);
            }
            if ($targetOrgId !== '' && $oid !== $targetOrgId) continue;
            $assigned = strtolower(trim((string)($o['assigned_sales_email'] ?? '')));
            if (!$canViewAll && $assigned !== $actorEmail) continue;
            $creditLedger = is_array($o['credits_ledger'] ?? null)
                ? array_values(array_filter($o['credits_ledger'], function($row) { return is_array($row); }))
                : [];
            $billingEvents = is_array($o['billing']['events'] ?? null)
                ? array_values(array_filter($o['billing']['events'], function($row) { return is_array($row); }))
                : [];
            $orgMap[$oid] = [
                'id' => $oid,
                'name' => (string)($o['name'] ?? $oid),
                'is_test' => !empty($o['is_test']),
                'created_at' => $o['created_at'] ?? null,
                'credits_balance' => portalMoneyAmount($o['credits_balance'] ?? 0),
                'credits_ledger' => [],
                'credits_ledger_count' => count($creditLedger),
                'latest_credit_entry' => orgCustomerPickLatestRow($creditLedger, 'ts'),
                'assigned_sales_email' => $assigned,
                'assigned_sales_name' => (string)($o['assigned_sales_name'] ?? ''),
                'assigned_sales_by_email' => (string)($o['assigned_sales_by_email'] ?? ''),
                'assigned_sales_at' => $o['assigned_sales_at'] ?? null,
                'paired_lead_ids' => array_values(array_filter(array_map('strval', $o['paired_lead_ids'] ?? []))),
                'paired_primary_lead_id' => (string)($o['paired_primary_lead_id'] ?? ''),
                'paired_primary_lead' => null,
                'paired_leads' => [],
                'paired_lead_count' => 0,
                'paired_at' => $o['paired_at'] ?? null,
                'contact' => is_array($o['contact'] ?? null) ? $o['contact'] : ['email' => '', 'phone' => '', 'address' => ''],
                'offers' => orgOffersSnapshot($o),
                'users' => [],
                'orders' => [],
                'orders_count' => 0,
                'latest_order' => null,
                'lifetimeOrders' => 0,
                'lifetimeRevenue' => 0,
                'rolling7' => 0,
                'avgOrdersDay' => 0,
                'billing_events' => [],
                'billing_events_count' => count($billingEvents),
                'volume_buckets' => $includeVolumeBuckets ? orgCustomerVolumeTemplate() : [],
                '_ledger_orders' => orgCustomerLedgerOrderEvents($creditLedger),
            ];
            if ($includeCreditLedger) $orgMap[$oid]['_credits_ledger_full'] = $creditLedger;
            if ($includeBillingEvents) $orgMap[$oid]['_billing_events_full'] = $billingEvents;
        }
    }

    $customerUsers = [];
    $orgUserIndexByEmail = [];
    $customerProjectOrgMap = [];
    $orgProjectIds = [];
    $orgProjectOwnerEmails = [];
    foreach (glob(storageDir('users') . '*.json') as $path) {
        $u = json_decode((string)@file_get_contents($path), true);
        if (!is_array($u)) continue;
        if (strtolower(trim((string)($u['account_type'] ?? ''))) !== 'customer') continue;
        $orgId = orgNormalizeId($u['organization_id'] ?? '');
        if ($orgId === '' || !isset($orgMap[$orgId])) continue;
        $email = strtolower(trim((string)($u['email'] ?? '')));
        $userProjects = [];
        foreach ((array)($u['projects'] ?? []) as $projectId) {
            $projectId = strtolower(trim((string)$projectId));
            if ($projectId === '') continue;
            $userProjects[$projectId] = true;
            if (!isset($customerProjectOrgMap[$projectId])) $customerProjectOrgMap[$projectId] = $orgId;
            $orgProjectIds[$orgId][$projectId] = true;
            if ($email !== '' && !isset($orgProjectOwnerEmails[$orgId][$projectId])) {
                $orgProjectOwnerEmails[$orgId][$projectId] = $email;
            }
        }
        $customerUsers[$email] = [
            'email' => $email,
            'org_id' => $orgId,
            'name' => (string)($u['name'] ?? ''),
            'phone' => (string)($u['phone'] ?? ''),
            'created_at' => $u['created_at'] ?? null,
            'org_permission_level' => (string)(($u['org_permissions']['level'] ?? 'viewer')),
        ];
        $orgMap[$orgId]['users'][] = [
            'id' => (string)($u['id'] ?? ''),
            'email' => $email,
            'name' => (string)($u['name'] ?? ''),
            'phone' => (string)($u['phone'] ?? ''),
            'created_at' => $u['created_at'] ?? null,
            'orderCount' => count($userProjects),
            'org_permission_level' => (string)(($u['org_permissions']['level'] ?? 'viewer')),
        ];
        $orgUserIndexByEmail[$orgId][$email] = count($orgMap[$orgId]['users']) - 1;
        if (!$orgMap[$orgId]['created_at'] && !empty($u['created_at'])) $orgMap[$orgId]['created_at'] = $u['created_at'];
    }

    $orderBuckets = [];
    $projectsLoadedFromApi = false;
    $cutoffTs = time() - (7 * 86400);

    if ($targetOrgId === '' && $preferProjectIndex && $projectIndexFactory !== null && function_exists('fm_project_list')) {
        try {
            $pdb = $projectIndexFactory();
            $indexRowCount = 0;
            $indexOrgLinkedCount = 0;
            if (orgSqliteTableExists($pdb, 'p')) {
                $indexRowCount = orgSqliteScalarInt($pdb, "SELECT COUNT(1) FROM p");
                $indexOrgLinkedCount = orgSqliteScalarInt($pdb, "SELECT COUNT(1) FROM p WHERE COALESCE(TRIM(org), '') <> ''");
            } elseif (orgSqliteTableExists($pdb, 'manifests')) {
                $indexRowCount = orgSqliteScalarInt($pdb, "SELECT COUNT(1) FROM manifests");
                $indexOrgLinkedCount = $indexRowCount;
            }

            $probe = fm_project_list([
                'filter' => 'all',
                'status_filter' => 'all',
                'include_all' => true,
                'limit' => 1,
                'page' => 1,
            ]);
            $apiTotalCount = !empty($probe['ok']) ? (int)($probe['pagination']['total_count'] ?? 0) : 0;
            if (
                $apiTotalCount > 0
                && (
                    $indexRowCount <= 0
                    || $indexOrgLinkedCount <= 0
                    || $indexRowCount < max(10, (int)floor($apiTotalCount * 0.8))
                )
            ) {
                $preferProjectIndex = false;
            }
        } catch (Throwable $e) {
        }
    }

    if (function_exists('fm_project_list') && !$preferProjectIndex) {
        try {
            $basePayload = [
                'filter' => 'all',
                'status_filter' => 'all',
                'include_all' => true,
                'limit' => 200,
            ];
            $page = 1;
            $totalPages = 1;
            $maxPages = 250;
            while ($page <= $totalPages && $page <= $maxPages) {
                $pagePayload = $basePayload;
                $pagePayload['page'] = $page;
                $result = fm_project_list($pagePayload);
                if (empty($result['ok'])) {
                    break;
                }
                $projectsLoadedFromApi = true;
                $batch = is_array($result['projects'] ?? null) ? $result['projects'] : [];
                foreach ($batch as $project) {
                    if (!is_array($project)) continue;

                    $projectId = strtolower(trim((string)($project['id'] ?? $project['folder'] ?? '')));
                    $ownerEmail = strtolower(trim((string)($project['owner_email'] ?? '')));
                    $issuer = is_array($project['issuer'] ?? null) ? $project['issuer'] : [];
                    $issuerEmail = strtolower(trim((string)($project['issuer_email'] ?? ($issuer['email'] ?? ''))));
                    $orgId = orgCustomerResolveProjectOrgId(
                        $project['organization_id'] ?? '',
                        $ownerEmail,
                        $issuerEmail,
                        $projectId,
                        $orgMap,
                        $customerUsers,
                        $customerProjectOrgMap
                    );
                    if ($orgId === '') continue;

                    $createdTs = orgProjectTs($project['created_at'] ?? null);
                    $manifestRevenue = 0;
                    if ($includeRevenue) {
                        $charged = $project['amount_charged'] ?? null;
                        if ($charged !== null && is_numeric($charged)) {
                            $manifestRevenue = max(0, (int)round((float)$charged));
                        } elseif (function_exists('projectTypePrice')) {
                            $manifestRevenue = max(0, (int)projectTypePrice(strtolower(trim((string)($project['project_type'] ?? 'residential')))));
                        }
                    }

                    if (!isset($orderBuckets[$orgId])) $orderBuckets[$orgId] = ['lifetime' => 0, 'rolling7' => 0, 'revenue' => 0];
                    $orderBuckets[$orgId]['lifetime'] += 1;
                    if ($createdTs !== null && $createdTs >= $cutoffTs) {
                        $orderBuckets[$orgId]['rolling7'] += 1;
                    }
                    $orderBuckets[$orgId]['revenue'] += $manifestRevenue;
                    orgCustomerVolumeIncrement($orgMap[$orgId]['volume_buckets'], $createdTs);

                    $countEmail = '';
                    if ($ownerEmail !== '' && isset($orgUserIndexByEmail[$orgId][$ownerEmail])) {
                        $countEmail = $ownerEmail;
                    } elseif ($issuerEmail !== '' && isset($orgUserIndexByEmail[$orgId][$issuerEmail])) {
                        $countEmail = $issuerEmail;
                    }
                    if ($countEmail !== '') {
                        $userIdx = $orgUserIndexByEmail[$orgId][$countEmail];
                        $orgMap[$orgId]['users'][$userIdx]['orderCount'] += 1;
                    }

                    $orderRow = [
                        'id' => $projectId,
                        'address' => (string)($project['address'] ?? ''),
                        'status' => trim((string)($project['status'] ?? '')) ?: 'queued',
                        'owner_email' => $ownerEmail,
                        'issuer' => ['email' => $issuerEmail],
                        'revenue' => $manifestRevenue,
                        'created_at' => $createdTs !== null ? gmdate('c', $createdTs) : ((string)($project['created_at'] ?? '') ?: null),
                    ];
                    $latestOrderTs = orgProjectTs($orgMap[$orgId]['latest_order']['created_at'] ?? null);
                    if ($orgMap[$orgId]['latest_order'] === null || ($createdTs !== null && ($latestOrderTs === null || $createdTs > $latestOrderTs))) {
                        $orgMap[$orgId]['latest_order'] = $orderRow;
                    }
                    if ($includeOrders) {
                        $orgMap[$orgId]['orders'][] = $orderRow;
                    }
                }

                $pagination = is_array($result['pagination'] ?? null) ? $result['pagination'] : [];
                $reportedTotalPages = (int)($pagination['total_pages'] ?? 0);
                if ($reportedTotalPages > 0) {
                    $totalPages = $reportedTotalPages;
                } else {
                    $reportedTotalCount = (int)($pagination['total_count'] ?? 0);
                    $totalPages = $reportedTotalCount > 0 ? (int)ceil($reportedTotalCount / (int)$basePayload['limit']) : $page;
                }

                if (!$batch || $page >= $totalPages) break;
                $page++;
            }
        } catch (Throwable $e) {
        }
    }

    $leadPairsByOrg = orgCustomerLeadPairsSnapshot(array_keys($orgMap));
    $leadDb = null;
    if (function_exists('leadDb')) {
        try {
            $candidate = leadDb();
            if ($candidate instanceof SQLite3) $leadDb = $candidate;
        } catch (Throwable $e) {
            $leadDb = null;
        }
    }

    if (!$projectsLoadedFromApi && $projectIndexFactory !== null) {
        try {
            $pdb = $projectIndexFactory();
            $hasProjectIndexTable = orgSqliteTableExists($pdb, 'p');
            $hasLegacyManifestsTable = !$hasProjectIndexTable && orgSqliteTableExists($pdb, 'manifests');
            if ($hasProjectIndexTable) {
                $queryArgs = [];
                $whereParts = [];
                if ($targetOrgId !== '') {
                    $whereParts[] = "LOWER(TRIM(org)) = :target_org";
                    $queryArgs[':target_org'] = $targetOrgId;

                    $targetEmails = array_keys($orgUserIndexByEmail[$targetOrgId] ?? []);
                    $emailParts = [];
                    foreach ($targetEmails as $i => $email) {
                        $email = strtolower(trim((string)$email));
                        if ($email === '') continue;
                        $key = ':email' . $i;
                        $emailParts[] = $key;
                        $queryArgs[$key] = $email;
                    }
                    if ($emailParts) {
                        $whereParts[] = "LOWER(TRIM(ow)) IN (" . implode(',', $emailParts) . ")";
                    }

                }
                $sql = "
                    SELECT
                        id,
                        LOWER(TRIM(org)) AS org_id,
                        st AS status,
                        ow AS owner_email,
                        ca AS created_at
                    FROM p
                    " . ($whereParts ? ("WHERE " . implode(' OR ', $whereParts)) : "") . "
                    ORDER BY COALESCE(ca, 0) DESC
                ";
                $stmt2 = @$pdb->prepare($sql);
                if ($stmt2) {
                    foreach ($queryArgs as $key => $value) {
                        $stmt2->bindValue($key, $value, SQLITE3_TEXT);
                    }
                    $res2 = @$stmt2->execute();
                } else {
                    $res2 = false;
                }
                while ($res2 && ($row = $res2->fetchArray(SQLITE3_ASSOC))) {
                    $ownerEmail = strtolower(trim((string)($row['owner_email'] ?? '')));
                    $folderId = trim((string)($row['id'] ?? ''));
                    $orgId = orgCustomerResolveProjectOrgId(
                        $row['org_id'] ?? '',
                        $ownerEmail,
                        '',
                        $folderId,
                        $orgMap,
                        $customerUsers,
                        $customerProjectOrgMap
                    );
                    if ($orgId === '') continue;
                    $manifestRevenue = 0;
                    $address = '';
                    $issuerEmail = '';
                    $ledgerOrderById = [];
                    foreach (($orgMap[$orgId]['_ledger_orders'] ?? []) as $ledgerOrder) {
                        $ledgerProjectId = strtolower(trim((string)($ledgerOrder['id'] ?? '')));
                        if ($ledgerProjectId !== '') $ledgerOrderById[$ledgerProjectId] = $ledgerOrder;
                    }
                    $ledgerOrder = $ledgerOrderById[strtolower($folderId)] ?? null;
                    if (is_array($ledgerOrder)) {
                        $address = (string)($ledgerOrder['address'] ?? '');
                        $manifestRevenue = max(0, (int)($ledgerOrder['revenue'] ?? 0));
                    }
                    $shouldHydrateManifest = $folderId !== ''
                        && function_exists('fm_fetch_project_manifest')
                        && $targetOrgId === ''
                        && ($includeOrders || $includeRevenue);
                    if ($shouldHydrateManifest) {
                        $manifest = fm_fetch_project_manifest($folderId);
                        if (is_array($manifest)) {
                            $address = (string)($manifest['address'] ?? '');
                            $issuer = is_array($manifest['issuer'] ?? null) ? $manifest['issuer'] : [];
                            $issuerEmail = strtolower(trim((string)($manifest['issuer_email'] ?? ($issuer['email'] ?? ''))));
                            if ($includeRevenue) {
                                $charged = $manifest['amount_charged'] ?? null;
                                if ($charged !== null && is_numeric($charged)) {
                                    $manifestRevenue = max(0, (int)round((float)$charged));
                                } elseif (function_exists('projectTypePrice')) {
                                    $manifestRevenue = max(0, (int)projectTypePrice(strtolower(trim((string)($manifest['project_type'] ?? 'residential')))));
                                }
                            }
                        }
                    }
                    if (!isset($orderBuckets[$orgId])) $orderBuckets[$orgId] = ['lifetime' => 0, 'rolling7' => 0, 'revenue' => 0];
                    $orderBuckets[$orgId]['lifetime'] += 1;
                    $createdTs = orgProjectTs($row['created_at'] ?? null);
                    if ($createdTs !== null && $createdTs >= $cutoffTs) {
                        $orderBuckets[$orgId]['rolling7'] += 1;
                    }
                    $orderBuckets[$orgId]['revenue'] += $manifestRevenue;
                    if ($ownerEmail !== '' && isset($orgUserIndexByEmail[$orgId][$ownerEmail])) {
                        $userIdx = $orgUserIndexByEmail[$orgId][$ownerEmail];
                        $orgMap[$orgId]['users'][$userIdx]['orderCount'] += 1;
                    }
                    $createdAtIso = $createdTs !== null ? date('c', $createdTs) : null;
                    $orderRow = [
                        'id' => $folderId,
                        'address' => $address,
                        'status' => (string)($row['status'] ?? ''),
                        'owner_email' => $ownerEmail,
                        'issuer' => ['email' => $issuerEmail],
                        'revenue' => $manifestRevenue,
                        'created_at' => $createdAtIso,
                    ];
                    orgCustomerVolumeIncrement($orgMap[$orgId]['volume_buckets'], $createdTs);
                    $latestOrderTs = orgProjectTs($orgMap[$orgId]['latest_order']['created_at'] ?? null);
                    if ($orgMap[$orgId]['latest_order'] === null || ($createdTs !== null && ($latestOrderTs === null || $createdTs > $latestOrderTs))) {
                        $orgMap[$orgId]['latest_order'] = $orderRow;
                    }
                    if ($includeOrders) {
                        $orgMap[$orgId]['orders'][] = $orderRow;
                    }
                }
            } elseif ($hasLegacyManifestsTable) {
                $res = @$pdb->query("
                    SELECT
                        COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) AS email,
                        COUNT(1) AS order_count,
                        SUM(CASE WHEN COALESCE(ca, 0) >= strftime('%s','now','-7 day') THEN 1 ELSE 0 END) AS rolling7,
                        MIN(COALESCE(ca, qa, da, pa, 0)) AS first_touch
                    FROM manifests
                    WHERE COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) <> ''
                    GROUP BY COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie)))
                ");
                while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
                    $email = strtolower(trim((string)($row['email'] ?? '')));
                    if ($email === '' || !isset($customerUsers[$email])) continue;
                    $orgId = $customerUsers[$email]['org_id'];
                    if (!isset($orderBuckets[$orgId])) $orderBuckets[$orgId] = ['lifetime' => 0, 'rolling7' => 0, 'revenue' => 0];
                    $orderBuckets[$orgId]['lifetime'] += (int)($row['order_count'] ?? 0);
                    $orderBuckets[$orgId]['rolling7'] += (int)($row['rolling7'] ?? 0);
                    if (isset($orgUserIndexByEmail[$orgId][$email])) {
                        $userIdx = $orgUserIndexByEmail[$orgId][$email];
                        $orgMap[$orgId]['users'][$userIdx]['orderCount'] = (int)($row['order_count'] ?? 0);
                    }
                }
                $res2 = @$pdb->query("
                    SELECT
                        id,
                        ad AS address,
                        st AS status,
                        ow AS owner_email,
                        ie AS issuer_email,
                        ca AS created_at
                    FROM manifests
                    WHERE COALESCE(NULLIF(LOWER(TRIM(ow)), ''), LOWER(TRIM(ie))) <> ''
                    ORDER BY COALESCE(ca, 0) DESC
                ");
                while ($res2 && ($row = $res2->fetchArray(SQLITE3_ASSOC))) {
                    $ownerEmail = strtolower(trim((string)($row['owner_email'] ?? '')));
                    $issuerEmail = strtolower(trim((string)($row['issuer_email'] ?? '')));
                    $email = $ownerEmail !== '' ? $ownerEmail : $issuerEmail;
                    if ($email === '' || !isset($customerUsers[$email])) continue;
                    $orgId = $customerUsers[$email]['org_id'];
                    $manifestRevenue = 0;
                    $folderId = trim((string)($row['folder_id'] ?? $row['id'] ?? ''));
                    if ($includeRevenue && $targetOrgId === '' && $folderId !== '' && function_exists('fm_fetch_project_manifest')) {
                        $manifest = fm_fetch_project_manifest($folderId);
                        if (is_array($manifest)) {
                            $charged = $manifest['amount_charged'] ?? null;
                            if ($charged !== null && is_numeric($charged)) {
                                $manifestRevenue = max(0, (int)round((float)$charged));
                            } elseif (function_exists('projectTypePrice')) {
                                $manifestRevenue = max(0, (int)projectTypePrice(strtolower(trim((string)($manifest['project_type'] ?? 'residential')))));
                            }
                        }
                    }
                    if (!isset($orderBuckets[$orgId])) $orderBuckets[$orgId] = ['lifetime' => 0, 'rolling7' => 0, 'revenue' => 0];
                    $orderBuckets[$orgId]['revenue'] += $manifestRevenue;
                    $createdAtIso = !empty($row['created_at']) ? date('c', (int)$row['created_at']) : null;
                    $orderRow = [
                        'id' => $folderId,
                        'address' => (string)($row['address'] ?? ''),
                        'status' => (string)($row['status'] ?? ''),
                        'owner_email' => $ownerEmail,
                        'issuer' => ['email' => $issuerEmail],
                        'revenue' => $manifestRevenue,
                        'created_at' => $createdAtIso,
                    ];
                    $createdTs = orgProjectTs($createdAtIso);
                    orgCustomerVolumeIncrement($orgMap[$orgId]['volume_buckets'], $createdTs);
                    $latestOrderTs = orgProjectTs($orgMap[$orgId]['latest_order']['created_at'] ?? null);
                    if ($orgMap[$orgId]['latest_order'] === null || ($createdTs !== null && ($latestOrderTs === null || $createdTs > $latestOrderTs))) {
                        $orgMap[$orgId]['latest_order'] = $orderRow;
                    }
                    if ($includeOrders) {
                        $orgMap[$orgId]['orders'][] = $orderRow;
                    }
                }
            }
        } catch (Throwable $e) {
        }
    }

    foreach ($orgMap as $orgId => &$org) {
        $bucket = $orderBuckets[$orgId] ?? ['lifetime' => 0, 'rolling7' => 0, 'revenue' => 0];
        $pairedLeadMap = [];
        foreach ((array)($leadPairsByOrg[$orgId] ?? []) as $leadRow) {
            if (!is_array($leadRow)) continue;
            $leadId = trim((string)($leadRow['id'] ?? ''));
            if ($leadId === '') continue;
            $leadRow['organization_id'] = orgNormalizeId($leadRow['organization_id'] ?? $orgId);
            $leadRow['is_linked'] = !array_key_exists('is_linked', $leadRow) ? true : !empty($leadRow['is_linked']);
            $pairedLeadMap[$leadId] = $leadRow;
        }
        foreach ((array)($org['paired_lead_ids'] ?? []) as $leadIdRaw) {
            $leadId = trim((string)$leadIdRaw);
            if ($leadId === '' || isset($pairedLeadMap[$leadId]) || !($leadDb instanceof SQLite3)) continue;
            $leadRow = orgCustomerLeadRowById($leadDb, $leadId, $orgId);
            if ($leadRow !== null) {
                $pairedLeadMap[$leadId] = $leadRow;
            } else {
                $pairedLeadMap[$leadId] = [
                    'id' => $leadId,
                    'lead_entity_id' => '',
                    'organization_id' => '',
                    'company' => '',
                    'email' => '',
                    'phone' => '',
                    'updated_at' => 0,
                    'is_linked' => false,
                ];
            }
        }
        $pairedLeads = array_values($pairedLeadMap);
        usort($pairedLeads, function($a, $b) {
            $aLinked = !empty($a['is_linked']) ? 1 : 0;
            $bLinked = !empty($b['is_linked']) ? 1 : 0;
            if ($aLinked !== $bLinked) return $bLinked <=> $aLinked;
            $aUpdated = (int)($a['updated_at'] ?? 0);
            $bUpdated = (int)($b['updated_at'] ?? 0);
            if ($aUpdated !== $bUpdated) return $bUpdated <=> $aUpdated;
            return strcmp((string)($a['company'] ?? $a['email'] ?? $a['id'] ?? ''), (string)($b['company'] ?? $b['email'] ?? $b['id'] ?? ''));
        });
        $org['paired_leads'] = $pairedLeads;
        $org['paired_lead_ids'] = array_values(array_map(function($row) {
            return (string)($row['id'] ?? '');
        }, array_filter($pairedLeads, function($row) {
            return trim((string)($row['id'] ?? '')) !== '';
        })));
        $org['paired_lead_count'] = count($org['paired_leads']);
        $primaryLeadId = trim((string)($org['paired_primary_lead_id'] ?? ''));
        $primaryLead = null;
        if ($primaryLeadId !== '') {
            foreach ($org['paired_leads'] as $leadRow) {
                if ((string)($leadRow['id'] ?? '') === $primaryLeadId && !empty($leadRow['is_linked'])) {
                    $primaryLead = $leadRow;
                    break;
                }
            }
            if ($primaryLead === null) {
                foreach ($org['paired_leads'] as $leadRow) {
                    if ((string)($leadRow['id'] ?? '') === $primaryLeadId) {
                        $primaryLead = $leadRow;
                        break;
                    }
                }
            }
        }
        if ($primaryLead === null) {
            foreach ($org['paired_leads'] as $leadRow) {
                if (!empty($leadRow['is_linked'])) {
                    $primaryLead = $leadRow;
                    break;
                }
            }
        }
        if ($primaryLead === null && !empty($org['paired_leads'])) {
            $primaryLead = $org['paired_leads'][0];
        }
        $org['paired_primary_lead'] = $primaryLead;
        $org['paired_primary_lead_id'] = (string)($primaryLead['id'] ?? '');
        $storedProjectCount = isset($orgProjectIds[$orgId]) ? count($orgProjectIds[$orgId]) : 0;
        if ($storedProjectCount > (int)$bucket['lifetime']) {
            $bucket['lifetime'] = $storedProjectCount;
        }
        if ((int)$bucket['rolling7'] <= 0 && !empty($org['_ledger_orders'])) {
            $rolling7Fallback = 0;
            foreach ($org['_ledger_orders'] as $event) {
                $eventTs = orgProjectTs($event['created_at'] ?? null);
                if ($eventTs !== null && $eventTs >= $cutoffTs) $rolling7Fallback++;
            }
            if ($rolling7Fallback > 0) $bucket['rolling7'] = $rolling7Fallback;
        }
        $org['lifetimeOrders'] = (int)$bucket['lifetime'];
        $org['lifetimeRevenue'] = (int)$bucket['revenue'];
        $org['rolling7'] = (int)$bucket['rolling7'];
        $org['avgOrdersDay'] = round($org['rolling7'] / 7, 2);
        $org['orders_count'] = (int)$bucket['lifetime'];
        usort($org['users'], function($a, $b) {
            return strcmp((string)($a['name'] ?: $a['email']), (string)($b['name'] ?: $b['email']));
        });
        if ($includeOrders) {
            if ($targetOrgId !== '' && count($org['orders']) < $org['orders_count'] && !empty($orgProjectIds[$orgId])) {
                $storedRows = orgCustomerStoredProjectOrderRows(
                    array_keys($orgProjectIds[$orgId]),
                    $orgProjectOwnerEmails[$orgId] ?? [],
                    false
                );
                if ($storedRows) {
                    $existingIds = [];
                    foreach ($org['orders'] as $row) {
                        $existingId = strtolower(trim((string)($row['id'] ?? '')));
                        if ($existingId !== '') $existingIds[$existingId] = true;
                    }
                    foreach ($storedRows as $row) {
                        $rowId = strtolower(trim((string)($row['id'] ?? '')));
                        if ($rowId !== '' && isset($existingIds[$rowId])) continue;
                        if ($rowId !== '') {
                            foreach (($org['_ledger_orders'] ?? []) as $ledgerOrder) {
                                if (strtolower(trim((string)($ledgerOrder['id'] ?? ''))) !== $rowId) continue;
                                if (trim((string)($row['address'] ?? '')) === '') $row['address'] = (string)($ledgerOrder['address'] ?? '');
                                if (empty($row['revenue'])) $row['revenue'] = max(0, (int)($ledgerOrder['revenue'] ?? 0));
                                if (empty($row['created_at'])) $row['created_at'] = $ledgerOrder['created_at'] ?? null;
                                break;
                            }
                        }
                        $org['orders'][] = $row;
                    }
                }
            }
            if (!$org['orders'] && !empty($org['_ledger_orders'])) {
                $org['orders'] = $org['_ledger_orders'];
            }
            usort($org['orders'], function($a, $b) {
                return orgProjectTs($b['created_at'] ?? null) <=> orgProjectTs($a['created_at'] ?? null);
            });
            $ordersTotal = count($org['orders']);
            $ordersTotalPages = max(1, (int)ceil($ordersTotal / $ordersPerPage));
            $ordersPageClamped = min($ordersPage, $ordersTotalPages);
            $ordersOffset = ($ordersPageClamped - 1) * $ordersPerPage;
            $org['orders'] = array_slice($org['orders'], $ordersOffset, $ordersPerPage);
            $org['orders_pagination'] = [
                'page' => $ordersPageClamped,
                'per_page' => $ordersPerPage,
                'total' => $ordersTotal,
                'total_pages' => $ordersTotalPages,
            ];
        } else {
            $org['orders'] = [];
            $org['orders_pagination'] = [
                'page' => 1,
                'per_page' => $ordersPerPage,
                'total' => (int)$bucket['lifetime'],
                'total_pages' => max(1, (int)ceil(((int)$bucket['lifetime']) / $ordersPerPage)),
            ];
        }
        if ($org['latest_order'] === null && !empty($org['_ledger_orders'])) {
            $org['latest_order'] = $org['_ledger_orders'][0];
        }
        if ($includeCreditLedger) {
            $ledgerRows = is_array($org['_credits_ledger_full'] ?? null) ? $org['_credits_ledger_full'] : [];
            usort($ledgerRows, function($a, $b) {
                return orgProjectTs($b['ts'] ?? null) <=> orgProjectTs($a['ts'] ?? null);
            });
            $ledgerTotal = count($ledgerRows);
            $ledgerTotalPages = max(1, (int)ceil($ledgerTotal / $ledgerPerPage));
            $ledgerPageClamped = min($ledgerPage, $ledgerTotalPages);
            $ledgerOffset = ($ledgerPageClamped - 1) * $ledgerPerPage;
            $org['credits_ledger'] = array_slice($ledgerRows, $ledgerOffset, $ledgerPerPage);
            $org['credits_pagination'] = [
                'page' => $ledgerPageClamped,
                'per_page' => $ledgerPerPage,
                'total' => $ledgerTotal,
                'total_pages' => $ledgerTotalPages,
            ];
        } else {
            $org['credits_ledger'] = [];
            $org['credits_pagination'] = [
                'page' => 1,
                'per_page' => $ledgerPerPage,
                'total' => (int)($org['credits_ledger_count'] ?? 0),
                'total_pages' => max(1, (int)ceil(((int)($org['credits_ledger_count'] ?? 0)) / $ledgerPerPage)),
            ];
        }
        if ($includeBillingEvents) {
            $billingRows = is_array($org['_billing_events_full'] ?? null) ? $org['_billing_events_full'] : [];
            $org['billing_events'] = array_slice($billingRows, -50);
        } else {
            $org['billing_events'] = [];
        }
        $org['volume_buckets'] = $includeVolumeBuckets ? orgCustomerVolumeExport($org['volume_buckets']) : [];
        unset($org['_credits_ledger_full'], $org['_billing_events_full'], $org['_ledger_orders']);
    }
    unset($org);

    return array_values($orgMap);
}

function orgFreeEmailDomains() {
    return [
        'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com',
        'rocketmail.com','icloud.com','me.com','mac.com','aol.com','protonmail.com','pm.me','att.net','comcast.net',
        'verizon.net','sbcglobal.net','bellsouth.net','cox.net','mail.com'
    ];
}

function orgEmailDomain($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || strpos($email, '@') === false) return '';
    $parts = explode('@', $email);
    $domain = trim((string)end($parts));
    if ($domain === '' || in_array($domain, orgFreeEmailDomains(), true)) return '';
    return $domain;
}

function orgNormPhone($phone) {
    $digits = preg_replace('/\D+/', '', (string)$phone);
    if (strlen($digits) === 11 && $digits[0] === '1') $digits = substr($digits, 1);
    return strlen($digits) >= 10 ? $digits : '';
}

// ---------------- ORG BILLING HELPERS ----------------

function orgEnsureBillingFields(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['billing']) || !is_array($o['billing'])) $o['billing'] = [];
    if (!isset($o['billing']['auto_topup']) || !is_array($o['billing']['auto_topup'])) {
        $o['billing']['auto_topup'] = [];
    }
    $at =& $o['billing']['auto_topup'];
    if (!array_key_exists('enabled', $at)) $at['enabled'] = false;
    $at['enabled'] = !!$at['enabled'];
    if (!array_key_exists('threshold_dollars', $at)) $at['threshold_dollars'] = 50;
    if (!array_key_exists('topup_dollars', $at)) $at['topup_dollars'] = 50;
    $at['threshold_dollars'] = max(35, (int)$at['threshold_dollars']);
    $at['topup_dollars']     = max(35, (int)$at['topup_dollars']);
    if (!array_key_exists('cooldown_minutes', $at)) $at['cooldown_minutes'] = 10;
    $at['cooldown_minutes'] = max(1, (int)$at['cooldown_minutes']);
    if (!array_key_exists('last_attempt_utc', $at)) $at['last_attempt_utc'] = null;
    if (!array_key_exists('last_success_utc', $at)) $at['last_success_utc'] = null;
    if (!array_key_exists('status', $at)) $at['status'] = 'idle'; // idle|ok|cooldown|failed|needs_payment_method
    if (!array_key_exists('last_error', $at)) $at['last_error'] = null;
    if (!isset($o['billing']['stripe']) || !is_array($o['billing']['stripe'])) {
        $o['billing']['stripe'] = [];
    }
    $s =& $o['billing']['stripe'];
    foreach (['customer_id','payment_method_id','brand','last4','exp_month','exp_year'] as $k) {
        if (!array_key_exists($k, $s)) $s[$k] = null;
    }
    if (!array_key_exists('has_payment_method', $s)) $s['has_payment_method'] = false;
    $s['has_payment_method'] = !!$s['has_payment_method'];
    if (!isset($o['billing']['events']) || !is_array($o['billing']['events'])) $o['billing']['events'] = [];
}

function orgBillingLogEvent(&$o, $type, $data = [], $cap = 100) {
    orgEnsureBillingFields($o);
    $ev = [
        'ts_utc' => gmdate('c'),
        'type' => (string)$type,
        'data' => is_array($data) ? $data : ['value'=>(string)$data],
    ];
    $o['billing']['events'][] = $ev;
    $cap = max(10, (int)$cap);
    if (count($o['billing']['events']) > $cap) {
        $o['billing']['events'] = array_slice($o['billing']['events'], -$cap);
    }
}

function orgRead($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    $mp = orgManifestPath($orgId);
    if (!$mp || !file_exists($mp)) return null;
    $o = json_decode(@file_get_contents($mp), true);
    if (!is_array($o)) $o = [];
    orgEnsureDefaults($o);
    $o['id'] = $orgId;
    $changed = orgRepairOfferHistory($o, $orgId);
    if ($changed) {
        @orgWrite($orgId, $o);
    }
    return $o;
}

function orgWrite($orgId, $o) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return false;
    $dir = orgPath($orgId);
    if (!$dir) return false;
    if (!file_exists($dir)) @mkdir($dir, 0777, true);
    orgEnsureDefaults($o);
    $o['id'] = $orgId;
    $mp = $dir . 'manifest.json';
    return atomicWriteJson($mp, $o);
}

function orgResolveCreditEmail($org, $preferredEmail = '') {
    $preferredEmail = strtolower(trim((string)$preferredEmail));
    if ($preferredEmail !== '') return $preferredEmail;

    $org = is_array($org) ? $org : [];
    $contact = is_array($org['contact'] ?? null) ? $org['contact'] : [];
    $contactEmail = strtolower(trim((string)($contact['email'] ?? '')));
    if ($contactEmail !== '') return $contactEmail;

    $createdByEmail = strtolower(trim((string)($org['created_by_email'] ?? '')));
    if ($createdByEmail !== '') return $createdByEmail;

    $usersMeta = is_array($org['users_meta'] ?? null) ? $org['users_meta'] : [];
    foreach ($usersMeta as $meta) {
        if (!is_array($meta)) continue;
        $email = strtolower(trim((string)($meta['email'] ?? '')));
        if ($email !== '') return $email;
    }

    $userIds = is_array($org['users'] ?? null) ? $org['users'] : [];
    foreach ($userIds as $userId) {
        $userId = strtolower(trim((string)$userId));
        if ($userId === '') continue;
        $meta = is_array($usersMeta[$userId] ?? null) ? $usersMeta[$userId] : [];
        $email = strtolower(trim((string)($meta['email'] ?? '')));
        if ($email !== '') return $email;
    }

    return '';
}

function creditsAddByOrganizationId($orgId, $amount, $reason, $meta = [], $appliedForEmail = '') {
    $orgId = orgNormalizeId($orgId);
    $amount = (int)$amount;
    if ($orgId === '' || $amount === 0) return ['ok'=>false,'error'=>'bad_args'];

    $o = orgRead($orgId);
    if (!is_array($o)) return ['ok'=>false,'error'=>'Organization not found'];

    orgEnsureCreditsFields($o);
    $appliedForEmail = orgResolveCreditEmail($o, $appliedForEmail);
    $now = date('c');

    $amount = portalMoneyAmount($amount);
    $o['credits_balance'] = portalMoneyAmount($o['credits_balance']) + $amount;
    $o['credits_balance'] = portalMoneyAmount($o['credits_balance']);
    $ledgerEntry = [
        'ts' => $now,
        'delta' => $amount,
        'reason' => (string)$reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'applied_for_user_email' => $appliedForEmail !== '' ? $appliedForEmail : null,
        'meta' => is_array($meta) ? $meta : [],
        'unit' => 'usd_dollars',
        'balance_after' => portalMoneyAmount($o['credits_balance']),
    ];
    $o['credits_ledger'][] = $ledgerEntry;

    if (!orgWrite($orgId, $o)) return ['ok'=>false,'error'=>'org_write_failed'];

    return [
        'ok'=>true,
        'scope'=>'org',
        'org_id'=>$orgId,
        'new_balance'=>portalMoneyAmount($o['credits_balance']),
        'applied_for_user_email'=>$appliedForEmail !== '' ? $appliedForEmail : null,
        'ledger_entry'=>$ledgerEntry,
    ];
}

function creditsRefundByOrganizationId($orgId, $amount, $reason, $meta = [], $appliedForEmail = '') {
    $orgId = orgNormalizeId($orgId);
    $amount = portalMoneyAmount($amount);
    if ($orgId === '' || $amount <= 0) return ['ok'=>false,'error'=>'bad_args'];

    $result = creditsAddByOrganizationId($orgId, $amount, $reason, array_merge((array)$meta, [
        'refund' => $amount,
    ]), $appliedForEmail);

    if (!empty($result['ok'])) {
        $result['refunded'] = $amount;
    }

    return $result;
}

function orgCreate($name, $creatorUserId, $creatorEmail, $creatorName, $preferredId = null) {
    $base = orgDirPath();
    $orgId = $preferredId ? orgNormalizeId($preferredId) : '';
    if ($orgId === '') {
        for ($i=0; $i<20; $i++) {
            $candidate = genHexId(12);
            if (!file_exists($base . $candidate . '/manifest.json')) { $orgId = $candidate; break; }
        }
    }
    if ($orgId === '') return null;
    $o = [
        'id' => $orgId,
        'name' => (string)$name,
        'created_at' => gmdate('c'),
        'created_by_user_id' => $creatorUserId ?: null,
        'created_by_email' => $creatorEmail ?: null,
        'created_by_name' => $creatorName ?: null,
        'users' => [],
        'users_meta' => [],
        'credits_balance' => 0,
        'credits_ledger' => [],
        'is_test' => false,
        'branding' => [
            'logo' => null,
            'colors' => [
                'primary' => '#DB0000',
                'secondary' => '#111111',
                'accent' => '#1A73E8',
            ]
        ],
    ];
    orgEnsureDefaults($o);
    if (!orgWrite($orgId, $o)) return null;
    return $orgId;
}

function orgAddUserId($orgId, $userId, $email = null, $name = null) {
    $orgId = orgNormalizeId($orgId);
    $userId = strtolower(trim((string)$userId));
    if ($orgId === '' || $userId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureUsersFields($o);
    if (!in_array($userId, $o['users'], true)) $o['users'][] = $userId;
    $o['users_meta'][$userId] = [
        'id' => $userId,
        'email' => $email ? strtolower(trim((string)$email)) : ($o['users_meta'][$userId]['email'] ?? null),
        'name' => $name ? (string)$name : ($o['users_meta'][$userId]['name'] ?? null),
        'added_at' => $o['users_meta'][$userId]['added_at'] ?? gmdate('c'),
    ];
    $o['users'] = array_values(array_unique($o['users']));
    return orgWrite($orgId, $o);
}

// ------------------------------------------------
// ------------ ORG DEALS HELPERS -----------------
// ------------------------------------------------

/**
 * Ensure the org array has a claimed_deals sub-object.
 * Safe to call on any org regardless of age — orgs created before the deals
 * system existed simply won't have the key yet, and this adds it cleanly.
 */
function orgEnsureDealsFields(&$o) {
    if (!isset($o['claimed_deals']) || !is_array($o['claimed_deals'])) {
        $o['claimed_deals'] = [];
    }
}

/**
 * Check whether an org has already claimed a named deal.
 *
 * @param string $orgId
 * @param string $dealKey  e.g. 'signup_match_50'
 * @return bool
 */
function orgHasClaimedDeal($orgId, $dealKey) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureDealsFields($o);
    return !empty($o['claimed_deals'][$dealKey]);
}

/**
 * Stamp a deal as claimed on the org. Idempotent — safe to call twice.
 * Writes to disk immediately.
 *
 * @param string $orgId
 * @param string $dealKey  e.g. 'signup_match_50'
 * @param array  $meta     Optional context stored alongside the claim timestamp
 * @return bool  True on success
 */
function orgMarkDealClaimed($orgId, $dealKey, $meta = []) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureDealsFields($o);
    // Already claimed — don't overwrite the original timestamp
    if (!empty($o['claimed_deals'][$dealKey])) return true;
    $o['claimed_deals'][$dealKey]                   = true;
    $o['claimed_deals'][$dealKey . '_claimed_at']   = gmdate('c');
    if (!empty($meta)) {
        $o['claimed_deals'][$dealKey . '_meta'] = $meta;
    }
    return (bool)orgWrite($orgId, $o);
}

/**
 * Return true if the org has any Stripe purchase recorded in its credits ledger.
 *
 * This covers both manual checkouts (stripe_checkout_paid) and auto top-ups
 * (stripe_auto_topup). We use it to gate the first-purchase bonus — if they
 * have bought before, the deal is not available regardless of claimed_deals.
 *
 * @param string $orgId
 * @return bool
 */
function orgHasPreviousStripePurchase($orgId) {
    $orgId = orgNormalizeId((string)$orgId);
    if ($orgId === '') return false;
    $o = orgRead($orgId);
    if (!$o) return false;
    orgEnsureCreditsFields($o);
    $ledger = $o['credits_ledger'] ?? [];
    if (!is_array($ledger)) return false;
    foreach ($ledger as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower((string)($entry['reason'] ?? ''));
        // Any ledger entry whose reason starts with 'stripe_' counts as a prior purchase.
        // This catches: stripe_checkout_paid, stripe_auto_topup, stripe_manual_fulfill, etc.
        if (strpos($reason, 'stripe_') === 0) return true;
    }
    return false;
}

// ------------------------------------------------
// ---------------- CREDITS FUNCTIONS -------------
// ------------------------------------------------

// credits owner resolver (org if available, else user)
function creditsResolveOwnerByEmail($email) {
    $u = readUserDataByEmail($email);
    if (!$u) return ['ok'=>false,'error'=>'User not found'];
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    if ($orgId !== '') {
        $o = orgRead($orgId);
        if ($o) return ['ok'=>true,'scope'=>'org','org_id'=>$orgId,'org'=>$o,'user'=>$u];
    }
    return ['ok'=>true,'scope'=>'user','user'=>$u];
}

function creditsGetBalanceByEmail($email) {
    $r = creditsResolveOwnerByEmail($email);
    if (empty($r['ok'])) return ['ok'=>false,'error'=>$r['error'] ?? 'resolve_failed'];
    if (($r['scope'] ?? '') === 'org') {
        orgEnsureCreditsFields($r['org']);
        return ['ok'=>true,'scope'=>'org','org_id'=>$r['org_id'],'balance'=>portalMoneyAmount($r['org']['credits_balance'])];
    }
    ensureUserCreditsFields($r['user']);
    return ['ok'=>true,'scope'=>'user','balance'=>portalMoneyAmount($r['user']['credits_balance'])];
}

function creditsAddByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = portalMoneyAmount($amount);
    if ($email === '' || $amount === 0) return ['ok'=>false,'error'=>'bad_args'];
    $r = creditsResolveOwnerByEmail($email);
    if (empty($r['ok'])) return ['ok'=>false,'error'=>$r['error'] ?? 'resolve_failed'];
    $now = date('c');
    if (($r['scope'] ?? '') === 'org') {
        $o = $r['org'];
        orgEnsureCreditsFields($o);
        $o['credits_balance'] = portalMoneyAmount($o['credits_balance']) + $amount;
        $o['credits_balance'] = portalMoneyAmount($o['credits_balance']);
        $ledgerEntry = [
            'ts' => $now,
            'delta' => $amount,
            'reason' => (string)$reason,
            'by_email' => $_SESSION['user_email'] ?? null,
            'applied_for_user_email' => $email,
            'meta' => is_array($meta) ? $meta : [],
            'unit' => 'usd_dollars',
            'balance_after' => portalMoneyAmount($o['credits_balance']),
        ];
        $o['credits_ledger'][] = $ledgerEntry;
        if (!orgWrite($r['org_id'], $o)) return ['ok'=>false,'error'=>'org_write_failed'];
        return ['ok'=>true,'scope'=>'org','org_id'=>$r['org_id'],'new_balance'=>portalMoneyAmount($o['credits_balance']),'ledger_entry'=>$ledgerEntry];
    }
    $u = $r['user'];
    ensureUserCreditsFields($u);
    $u['credits_balance'] = portalMoneyAmount($u['credits_balance']) + $amount;
    $u['credits_balance'] = portalMoneyAmount($u['credits_balance']);
    $ledgerEntry = [
        'ts' => $now,
        'delta' => $amount,
        'reason' => (string)$reason,
        'by_email' => $_SESSION['user_email'] ?? null,
        'meta' => is_array($meta) ? $meta : [],
        'unit' => 'usd_dollars',
        'balance_after' => portalMoneyAmount($u['credits_balance']),
    ];
    $u['credits_ledger'][] = $ledgerEntry;
    if (!writeUserDataByEmail($email, $u)) return ['ok'=>false,'error'=>'user_write_failed'];
    return ['ok'=>true,'scope'=>'user','new_balance'=>portalMoneyAmount($u['credits_balance']),'ledger_entry'=>$ledgerEntry];
}

function creditsSpendByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = portalMoneyAmount($amount);
    if ($email === '' || $amount <= 0) return ['ok'=>false,'error'=>'bad_args'];
    $bal = creditsGetBalanceByEmail($email);
    if (empty($bal['ok'])) return $bal;
    if (portalMoneyAmount($bal['balance']) < $amount) {
        return ['ok'=>false,'error'=>'insufficient','balance'=>portalMoneyAmount($bal['balance'])];
    }
    return creditsAddByEmail($email, -$amount, $reason, array_merge((array)$meta, [
        'spend' => $amount,
    ]));
}

function creditsRefundByEmail($email, $amount, $reason, $meta = []) {
    $email = strtolower(trim((string)$email));
    $amount = portalMoneyAmount($amount);
    if ($email === '' || $amount <= 0) return ['ok'=>false,'error'=>'bad_args'];

    $result = creditsAddByEmail($email, $amount, $reason, array_merge((array)$meta, [
        'refund' => $amount,
    ]));

    if (!empty($result['ok'])) {
        $result['refunded'] = $amount;
    }

    return $result;
}

function portalNormalizeProjectType($value) {
    $type = strtolower(trim((string)$value));
    if (!in_array($type, ['residential', 'commercial', 'multifamily'], true)) {
        return 'residential';
    }
    return $type;
}

function portalOrderPinCount($pinsRaw) {
    if (is_array($pinsRaw)) {
        return count($pinsRaw);
    }
    $decoded = json_decode((string)$pinsRaw, true);
    return is_array($decoded) ? count($decoded) : 0;
}

function portalShouldIncludeGutters($projectTypeRaw, $includeGuttersRaw) {
    $projectType = portalNormalizeProjectType($projectTypeRaw);
    if ($projectType !== 'residential') return false;
    return filter_var($includeGuttersRaw, FILTER_VALIDATE_BOOLEAN);
}

function portalNormalizeReportMode($value) {
    $mode = strtolower(trim((string)$value));
    if ($mode === 'instant') {
        return 'both';
    }
    if (!in_array($mode, ['full', 'instant', 'both'], true)) {
        return 'full';
    }
    return $mode;
}

function portalInstantUnitPrice($projectType) {
    return portalBothUnitPrice($projectType);
}

function portalBothUnitPrice($projectType) {
    $standardUnitPrice = function_exists('projectTypePrice')
        ? (int)projectTypePrice($projectType)
        : (in_array($projectType, ['commercial', 'multifamily'], true) ? 12 : 7);
    $instantAddon = in_array($projectType, ['commercial', 'multifamily'], true) ? 4 : 2;
    return $standardUnitPrice + $instantAddon;
}

function portalOrderAmountFromRequest($projectTypeRaw, $pinsRaw, $includeGuttersRaw = false, $reportModeRaw = 'full') {
    $projectType = portalNormalizeProjectType($projectTypeRaw);
    $reportMode = portalNormalizeReportMode($reportModeRaw);
    $pinCount = max(1, portalOrderPinCount($pinsRaw));
    $standardUnitPrice = function_exists('projectTypePrice')
        ? (int)projectTypePrice($projectType)
        : (in_array($projectType, ['commercial', 'multifamily'], true) ? 12 : 7);
    if ($reportMode === 'instant') {
        $unitPrice = portalInstantUnitPrice($projectType);
    } else if ($reportMode === 'both') {
        $unitPrice = portalBothUnitPrice($projectType);
    } else {
        $unitPrice = $standardUnitPrice;
    }
    $includeGutters = portalShouldIncludeGutters($projectType, $includeGuttersRaw);
    $gutterAddon = defined('PORTAL_GUTTER_REPORT_ADDON') ? (int)PORTAL_GUTTER_REPORT_ADDON : 3;
    $amount = in_array($projectType, ['commercial', 'multifamily'], true)
        ? ($unitPrice * $pinCount)
        : ($unitPrice + (($reportMode !== 'instant' && $includeGutters) ? $gutterAddon : 0));
    $discountableAmount = 0;
    if ($reportMode !== 'instant') {
        $discountableAmount = in_array($projectType, ['commercial', 'multifamily'], true)
            ? ($standardUnitPrice * $pinCount)
            : $standardUnitPrice;
    }
    if ($reportMode === 'instant' || $reportMode === 'both') {
        $discountableAmount = $amount;
    }
    return [
        'project_type' => $projectType,
        'report_mode' => $reportMode,
        'pin_count' => $pinCount,
        'include_gutter_measurements' => $includeGutters,
        'unit_price' => portalMoneyAmount($unitPrice),
        'standard_unit_price' => portalMoneyAmount($standardUnitPrice),
        'discountable_amount' => portalMoneyAmount($discountableAmount),
        'amount' => portalMoneyAmount($amount),
    ];
}

function portalPendingChargesRead() {
    $charges = $_SESSION['portal_pending_order_charges'] ?? [];
    if (!is_array($charges)) $charges = [];
    $fresh = [];
    $cutoff = time() - 3600;
    foreach ($charges as $token => $charge) {
        if (!is_array($charge)) continue;
        $createdTs = (int)($charge['created_ts'] ?? 0);
        if ($createdTs > 0 && $createdTs < $cutoff) continue;
        $fresh[(string)$token] = $charge;
    }
    $_SESSION['portal_pending_order_charges'] = $fresh;
    return $fresh;
}

function portalPendingChargesWrite($charges) {
    $_SESSION['portal_pending_order_charges'] = is_array($charges) ? $charges : [];
}

function portalPendingChargePeek($token, $email) {
    $token = trim((string)$token);
    $email = strtolower(trim((string)$email));
    if ($token === '' || $email === '') return null;
    $charges = portalPendingChargesRead();
    $charge = $charges[$token] ?? null;
    if (!is_array($charge)) return null;
    if (strtolower(trim((string)($charge['email'] ?? ''))) !== $email) return null;
    return $charge;
}

function portalPendingChargeDelete($token) {
    $token = trim((string)$token);
    if ($token === '') return;
    $charges = portalPendingChargesRead();
    unset($charges[$token]);
    portalPendingChargesWrite($charges);
}

function orgCreateForNewSignup($email, $userId, $name, $company) {
    $company = trim((string)$company);
    if ($company === '') $company = trim((string)$name) !== '' ? (trim((string)$name) . ' Company') : 'My Company';
    $orgId = orgCreate($company, $userId, $email, $name);
    if (!$orgId) return null;
    // seed membership
    orgAddUserId($orgId, $userId, $email, $name);
    return $orgId;
}

// ------------------------------------------------
// ---------------- INTERNAL MUTATION HELPERS -----
// ------------------------------------------------

function internalMutationToken() {
    static $tok = null;
    if (is_string($tok) && $tok !== '') return $tok;
    $p = $GLOBALS['INTERNAL_MUTATION_TOKEN_PATH'] ?? null;
    if (!$p || !file_exists($p)) return null;
    $raw = trim((string)@file_get_contents($p));
    if ($raw === '') return null;
    $tok = $raw;
    return $tok;
}

function internalMutationAuthOrFail() {
    $need = internalMutationToken();
    if (!$need) {
        http_response_code(500);
        die(json_encode(['success'=>false,'error'=>'Internal mutation token missing on server']));
    }
    $got = '';
    if (isset($_POST['token'])) $got = (string)$_POST['token'];
    if ($got === '') {
        $hdr = $_SERVER['HTTP_X_INTERNAL_MUTATION_TOKEN'] ?? '';
        if ($hdr) $got = (string)$hdr;
    }
    if ($got === '') {
        http_response_code(403);
        die(json_encode(['success'=>false,'error'=>'Missing internal mutation token']));
    }
    // timing-safe compare
    if (function_exists('hash_equals')) {
        if (!hash_equals($need, $got)) {
            http_response_code(403);
            die(json_encode(['success'=>false,'error'=>'Bad internal mutation token']));
        }
    } else {
        if ($need !== $got) {
            http_response_code(403);
            die(json_encode(['success'=>false,'error'=>'Bad internal mutation token']));
        }
    }
}

function internalMutationAuthorized() {
    $need = internalMutationToken();
    if (!$need) return false;
    $got = '';
    if (isset($_POST['token'])) $got = (string)$_POST['token'];
    if ($got === '') {
        $hdr = $_SERVER['HTTP_X_INTERNAL_MUTATION_TOKEN'] ?? '';
        if ($hdr) $got = (string)$hdr;
    }
    if ($got === '') return false;
    return hash_equals($need, trim($got));
}

function normalizeDotPath($path) {
    $path = trim((string)$path);
    if ($path === '') return null;
    $parts = explode('.', $path);
    $out = [];
    foreach ($parts as $seg) {
        $seg = trim($seg);
        if ($seg === '') return null;
        // only allow safe keys
        if (!preg_match('/^[A-Za-z0-9_\-]+$/', $seg)) return null;
        $out[] = $seg;
    }
    return $out;
}

function coerceJsonValue($raw) {
    // Accept already-decoded arrays/objects
    if (is_array($raw)) return $raw;
    $s = trim((string)$raw);
    if ($s === '') return '';
    // Try JSON first (objects/arrays/numbers/bools/null/strings)
    $j = json_decode($s, true);
    if (json_last_error() === JSON_ERROR_NONE) return $j;
    // Common primitives if not valid JSON
    $low = strtolower($s);
    if ($low === 'null') return null;
    if ($low === 'true') return true;
    if ($low === 'false') return false;
    // Numeric
    if (preg_match('/^-?\d+$/', $s)) return (int)$s;
    if (preg_match('/^-?\d+\.\d+$/', $s)) return (float)$s;
    // Fallback: string
    return $s;
}

function arraySetByPath(&$arr, $pathParts, $value) {
    if (!is_array($arr)) $arr = [];
    $ref =& $arr;
    $n = count($pathParts);
    for ($i = 0; $i < $n; $i++) {
        $k = $pathParts[$i];
        if ($i === $n - 1) {
            $ref[$k] = $value;
            return true;
        }
        if (!isset($ref[$k]) || !is_array($ref[$k])) $ref[$k] = [];
        $ref =& $ref[$k];
    }
    return false;
}

function orgLogoRelUrl($orgId, $filename) {
    $orgId = orgNormalizeId($orgId);
    $filename = ltrim((string)$filename, '/\\');
    return 'organizations/' . $orgId . '/' . $filename;
}

function portalMoneyAmount($value) {
    if (!is_numeric((string)$value)) return 0.0;
    return round((float)$value, 2);
}

function orgLedgerRowTimestamp($row) {
    if (!is_array($row)) return 0;
    $raw = trim((string)($row['ts'] ?? $row['ts_utc'] ?? $row['created_at'] ?? ''));
    if ($raw === '') return 0;
    $ts = strtotime($raw);
    return $ts === false ? 0 : $ts;
}

function orgLedgerRowIsFinancial($row) {
    if (!is_array($row)) return false;
    return portalMoneyAmount($row['delta'] ?? 0) != 0.0;
}

function orgNormalizeBillingLedgerRow($row) {
    $row = is_array($row) ? $row : [];
    $meta = is_array($row['meta'] ?? null) ? $row['meta'] : [];
    return array_merge($row, [
        'ts' => (string)($row['ts'] ?? $row['ts_utc'] ?? $row['created_at'] ?? ''),
        'delta' => portalMoneyAmount($row['delta'] ?? 0),
        'reason' => (string)($row['reason'] ?? 'credit_adjustment'),
        'by_email' => $row['by_email'] ?? null,
        'applied_for_user_email' => $row['applied_for_user_email'] ?? null,
        'meta' => $meta,
        'unit' => (string)($row['unit'] ?? 'usd_dollars'),
        'balance_after' => isset($row['balance_after']) ? portalMoneyAmount($row['balance_after']) : null,
    ]);
}

function orgBillingLedgerRowsForRange($org, $startTs = null, $endTs = null) {
    $ledger = is_array($org['credits_ledger'] ?? null) ? $org['credits_ledger'] : [];
    $rows = [];
    foreach ($ledger as $row) {
        if (!orgLedgerRowIsFinancial($row)) continue;
        $ts = orgLedgerRowTimestamp($row);
        if ($startTs !== null && $ts < $startTs) continue;
        if ($endTs !== null && $ts > $endTs) continue;
        $rows[] = orgNormalizeBillingLedgerRow($row);
    }
    usort($rows, function($a, $b) {
        return orgLedgerRowTimestamp($b) <=> orgLedgerRowTimestamp($a);
    });
    return $rows;
}

function orgMonthlyStatementPayload($orgId, $org, $month, $year) {
    $month = max(1, min(12, (int)$month));
    $year = max(2020, min((int)date('Y') + 1, (int)$year));
    $start = mktime(0, 0, 0, $month, 1, $year);
    $end = strtotime('+1 month', $start) - 1;
    $transactions = orgBillingLedgerRowsForRange($org, $start, $end);

    $totalIn = 0.0;
    $totalOut = 0.0;
    $totalPayments = 0;
    $orders = [];
    $byType = [];

    foreach ($transactions as $row) {
        $delta = portalMoneyAmount($row['delta'] ?? 0);
        $reason = strtolower(trim((string)($row['reason'] ?? '')));
        $meta = is_array($row['meta'] ?? null) ? $row['meta'] : [];

        if ($delta > 0) {
            $totalIn += $delta;
            $totalPayments++;
        } elseif ($delta < 0) {
            $totalOut += abs($delta);
        }

        if ($reason === 'order_submitted') {
            $projectType = strtolower(trim((string)($meta['project_type'] ?? 'residential')));
            if ($projectType === '') $projectType = 'residential';
            $byType[$projectType] = ($byType[$projectType] ?? 0) + 1;
            $orders[] = [
                'id' => (string)($meta['project_id'] ?? $meta['folder'] ?? $meta['charge_token'] ?? ''),
                'address' => (string)($meta['address'] ?? ''),
                'project_type' => $projectType,
                'report_mode' => (string)($meta['report_mode'] ?? ''),
                'cost' => abs($delta),
                'cost_nominal' => portalMoneyAmount($meta['roof_cost'] ?? abs($delta)),
                'status' => 'submitted',
                'rejected' => false,
                'created_at' => (string)($row['ts'] ?? ''),
                'completed_at' => '',
                'issuer_name' => '',
                'issuer_email' => (string)($row['applied_for_user_email'] ?? $row['by_email'] ?? ''),
                'complexity' => '',
            ];
        }
    }

    return [
        'success' => true,
        'org_id' => $orgId,
        'month' => $month,
        'year' => $year,
        'month_label' => date('F Y', $start),
        'transactions' => $transactions,
        'ledger' => $transactions,
        'orders' => $orders,
        'total_transactions' => count($transactions),
        'total_orders' => count($orders),
        'total_payments' => $totalPayments,
        'total_in' => portalMoneyAmount($totalIn),
        'total_out' => portalMoneyAmount($totalOut),
        'net_change' => portalMoneyAmount($totalIn - $totalOut),
        'total_spent' => portalMoneyAmount($totalOut),
        'by_type' => $byType,
    ];
}

// ------------------------------------------------
// ---------------- ORG ACTION HANDLERS -----------
// ------------------------------------------------

function handleOrganizationActions($action) {
    global $userDir;

    if ($action === 'admin_adjust_org_credits') {
        requireLoginOrFail();
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if ((!function_exists('isAdmin') || !isAdmin()) && (!function_exists('userHasPerm') || !userHasPerm($actor, 'manage_users'))) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }

        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        $amount = portalMoneyAmount($_POST['amount'] ?? 0);
        $direction = strtolower(trim((string)($_POST['direction'] ?? 'add')));
        if ($orgId === '') die(json_encode(['success' => false, 'error' => 'Missing organization id']));
        if ($amount <= 0) die(json_encode(['success' => false, 'error' => 'Amount must be positive']));
        if (!in_array($direction, ['add', 'deduct'], true)) {
            die(json_encode(['success' => false, 'error' => 'Invalid credit adjustment type']));
        }

        $org = orgRead($orgId);
        if (!is_array($org)) die(json_encode(['success' => false, 'error' => 'Organization not found']));
        orgEnsureCreditsFields($org);
        $currentBalance = portalMoneyAmount($org['credits_balance'] ?? 0);
        $delta = $direction === 'deduct' ? -$amount : $amount;
        if ($delta < 0 && $currentBalance < $amount) {
            die(json_encode([
                'success' => false,
                'error' => 'Cannot deduct more credits than the current balance',
                'current_balance' => $currentBalance,
            ]));
        }

        $appliedForEmail = orgResolveCreditEmail($org, $_POST['applied_for_email'] ?? '');
        $reason = trim((string)($_POST['reason'] ?? ''));
        if ($reason === '') $reason = $direction === 'deduct' ? 'manual_admin_deduction' : 'manual_admin_credit';
        $meta = [
            'adjusted_by' => $actor !== '' ? $actor : 'system',
            'adjustment_type' => $direction,
            'manual_adjustment' => true,
        ];
        $result = creditsAddByOrganizationId($orgId, $delta, $reason, $meta, $appliedForEmail);
        if (empty($result['ok'])) {
            die(json_encode(['success' => false, 'error' => $result['error'] ?? 'Failed to adjust credits', 'details' => $result]));
        }

        $newBalance = portalMoneyAmount($result['new_balance'] ?? ($currentBalance + $delta));
        echo json_encode([
            'success' => true,
            'credits_scope' => 'org',
            'organization_id' => $orgId,
            'new_balance' => $newBalance,
            'amount' => $amount,
            'delta' => portalMoneyAmount($delta),
            'direction' => $direction,
            'ledger_entry' => $result['ledger_entry'] ?? [
                'ts' => date('c'),
                'delta' => portalMoneyAmount($delta),
                'reason' => $reason,
                'by_email' => $actor !== '' ? $actor : null,
                'applied_for_user_email' => ($result['applied_for_user_email'] ?? $appliedForEmail) ?: null,
                'meta' => $meta,
                'unit' => 'usd_dollars',
                'balance_after' => $newBalance,
            ],
        ]);
        exit;
    }

    if ($action === 'portal_charge_order_credits') {
        requireLoginOrFail();
        $userEmail = strtolower(trim((string)$_SESSION['user_email']));
        $isEmployee = function_exists('isEmployeeUserByEmail') ? isEmployeeUserByEmail($userEmail) : false;
        $orgId = function_exists('actorOrgIdByEmail') ? actorOrgIdByEmail($userEmail) : null;
        if ($orgId && !$isEmployee) {
            if (!userHasOrgPerm($userEmail, $orgId, 'order_reports')) {
                die(json_encode(['success' => false, 'error' => 'Unauthorized']));
            }
        }

        $pricing = portalOrderAmountFromRequest(
            $_POST['project_type'] ?? 'residential',
            $_POST['pins'] ?? '[]',
            $_POST['include_gutter_measurements'] ?? false,
            $_POST['report_mode'] ?? 'full'
        );
        $amount = portalMoneyAmount($pricing['amount'] ?? 0);
        $address = trim((string)($_POST['address'] ?? ''));
        $discountPreview = [
            'original_amount' => $amount,
            'final_amount' => $amount,
            'discount_amount' => 0,
            'discountable_amount' => portalMoneyAmount($pricing['discountable_amount'] ?? 0),
            'applied_offers' => [],
        ];
        if ($orgId && !$isEmployee) {
            $discountPreview = orgOfferReferralDiscountPreview($orgId, $amount, $pricing, [
                'user_email' => $userEmail,
                'address' => $address,
                'source' => 'portal_new_api_queue',
            ]);
            $amount = portalMoneyAmount($discountPreview['final_amount'] ?? $amount);
        }
        $chargeToken = bin2hex(random_bytes(16));

        if ($isEmployee || $amount <= 0) {
            echo json_encode([
                'success' => true,
                'charged_amount' => 0,
                'charge_token' => null,
                'balance' => portalMoneyAmount(creditsGetBalanceByEmail($userEmail)['balance'] ?? 0),
            ]);
            return true;
        }

        $spend = creditsSpendByEmail($userEmail, $amount, 'order_submitted', [
            'address' => $address,
            'roof_cost' => portalMoneyAmount($discountPreview['original_amount'] ?? $amount),
            'charged_amount' => $amount,
            'discount_amount' => portalMoneyAmount($discountPreview['discount_amount'] ?? 0),
            'charge_token' => $chargeToken,
            'offers_applied' => is_array($discountPreview['applied_offers'] ?? null) ? $discountPreview['applied_offers'] : [],
            'project_type' => $pricing['project_type'],
            'report_mode' => $pricing['report_mode'],
            'pin_count' => (int)$pricing['pin_count'],
            'include_gutter_measurements' => !empty($pricing['include_gutter_measurements']),
            'source' => 'portal_new_api_queue',
        ]);
        if (!empty($spend['ok']) && (($spend['scope'] ?? '') === 'org')) {
            $balNow = portalMoneyAmount($spend['new_balance'] ?? 0);
            if ($balNow <= 0) {
                $bal = creditsGetBalanceByEmail($userEmail);
                $balNow = portalMoneyAmount($bal['balance'] ?? 0);
            }
            $spendOrgId = (string)($spend['org_id'] ?? '');
            if ($spendOrgId !== '' && function_exists('withStripeLock') && function_exists('orgAutoTopupTry')) {
                withStripeLock(function() use ($spendOrgId, $userEmail, $balNow, $amount, $address) {
                    orgAutoTopupTry($spendOrgId, $userEmail, $balNow, [
                        'reason' => 'order_submitted',
                        'roof_cost' => $amount,
                        'address' => $address,
                        'source' => 'portal_new_api_queue',
                    ]);
                    return true;
                });
            }
        }
        if (empty($spend['ok'])) {
            $bal = creditsGetBalanceByEmail($userEmail);
            $have = portalMoneyAmount($bal['balance'] ?? 0);
            echo json_encode([
                'success' => false,
                'error' => "Insufficient credit. This order costs \$$amount. You have \$$have. Please add credit to submit an order."
            ]);
            return true;
        }

        foreach ((array)($discountPreview['applied_offers'] ?? []) as $offerApplied) {
            if (!is_array($offerApplied)) continue;
            $offerId = trim((string)($offerApplied['offer_id'] ?? ''));
            if ($offerId === '') continue;
            if (($spend['scope'] ?? '') === 'org' && !empty($spend['org_id'])) {
                orgOfferTrackAppliedItem((string)$spend['org_id'], $offerId, [
                    'charge_token' => $chargeToken,
                    'status' => 'charged',
                    'charged_at' => gmdate('c'),
                    'source' => 'portal_new_api_queue',
                    'address' => $address,
                    'project_type' => $pricing['project_type'],
                    'report_mode' => $pricing['report_mode'],
                    'pin_count' => (int)$pricing['pin_count'],
                    'original_amount' => portalMoneyAmount($discountPreview['original_amount'] ?? $amount),
                    'charged_amount' => $amount,
                    'discount_amount' => portalMoneyAmount($discountPreview['discount_amount'] ?? 0),
                    'offer_data' => $offerApplied,
                ]);
            }
        }

        $charges = portalPendingChargesRead();
        $charges[$chargeToken] = [
            'email' => $userEmail,
            'amount' => $amount,
            'original_amount' => portalMoneyAmount($discountPreview['original_amount'] ?? $amount),
            'discount_amount' => portalMoneyAmount($discountPreview['discount_amount'] ?? 0),
            'applied_offers' => is_array($discountPreview['applied_offers'] ?? null) ? $discountPreview['applied_offers'] : [],
            'address' => $address,
            'project_type' => $pricing['project_type'],
            'report_mode' => $pricing['report_mode'],
            'pin_count' => (int)$pricing['pin_count'],
            'include_gutter_measurements' => !empty($pricing['include_gutter_measurements']),
            'scope' => (string)($spend['scope'] ?? 'user'),
            'org_id' => (string)($spend['org_id'] ?? ''),
            'created_ts' => time(),
            'created_at' => gmdate('c'),
        ];
        portalPendingChargesWrite($charges);

        echo json_encode([
            'success' => true,
            'charged_amount' => $amount,
            'original_amount' => portalMoneyAmount($discountPreview['original_amount'] ?? $amount),
            'discount_amount' => portalMoneyAmount($discountPreview['discount_amount'] ?? 0),
            'applied_offers' => is_array($discountPreview['applied_offers'] ?? null) ? $discountPreview['applied_offers'] : [],
            'charge_token' => $chargeToken,
            'scope' => (string)($spend['scope'] ?? 'user'),
            'org_id' => (string)($spend['org_id'] ?? ''),
            'new_balance' => portalMoneyAmount($spend['new_balance'] ?? 0),
        ]);
        return true;
    }

    if ($action === 'portal_capture_order_credits') {
        requireLoginOrFail();
        $userEmail = strtolower(trim((string)$_SESSION['user_email']));
        $token = trim((string)($_POST['charge_token'] ?? ''));
        if ($token === '') {
            echo json_encode(['success' => true, 'charged_amount' => 0]);
            return true;
        }
        $charge = portalPendingChargePeek($token, $userEmail);
        if (!$charge) {
            echo json_encode(['success' => false, 'error' => 'Charge confirmation was not found.']);
            return true;
        }
        portalPendingChargeDelete($token);
        $chargeOrgId = orgNormalizeId($charge['org_id'] ?? '');
        foreach ((array)($charge['applied_offers'] ?? []) as $offerApplied) {
            if (!is_array($offerApplied)) continue;
            $offerId = trim((string)($offerApplied['offer_id'] ?? ''));
            if ($offerId === '' || $chargeOrgId === '') continue;
            orgOfferTrackAppliedItem($chargeOrgId, $offerId, [
                'charge_token' => $token,
                'status' => 'captured',
                'captured_at' => gmdate('c'),
                'address' => (string)($charge['address'] ?? ''),
                'charged_amount' => portalMoneyAmount($charge['amount'] ?? 0),
                'discount_amount' => portalMoneyAmount($charge['discount_amount'] ?? 0),
            ]);
        }
        echo json_encode([
            'success' => true,
            'charged_amount' => portalMoneyAmount($charge['amount'] ?? 0),
            'original_amount' => portalMoneyAmount($charge['original_amount'] ?? ($charge['amount'] ?? 0)),
            'discount_amount' => portalMoneyAmount($charge['discount_amount'] ?? 0),
            'applied_offers' => (array)($charge['applied_offers'] ?? []),
            'address' => (string)($charge['address'] ?? ''),
        ]);
        return true;
    }

    if ($action === 'portal_refund_order_credits') {
        requireLoginOrFail();
        $userEmail = strtolower(trim((string)$_SESSION['user_email']));
        $token = trim((string)($_POST['charge_token'] ?? ''));
        if ($token === '') {
            echo json_encode(['success' => true, 'refunded' => 0]);
            return true;
        }
        $charge = portalPendingChargePeek($token, $userEmail);
        if (!$charge) {
            echo json_encode(['success' => false, 'error' => 'Charge refund token was not found.']);
            return true;
        }

        $amount = portalMoneyAmount($charge['amount'] ?? 0);
        if ($amount <= 0) {
            echo json_encode(['success' => true, 'refunded' => 0]);
            return true;
        }

        $refund = creditsRefundByEmail($userEmail, $amount, 'order_submit_api_failed', [
            'address' => (string)($charge['address'] ?? ($_POST['address'] ?? '')),
            'project_type' => (string)($charge['project_type'] ?? ($_POST['project_type'] ?? 'residential')),
            'pin_count' => (int)($charge['pin_count'] ?? 1),
            'source' => 'portal_new_api_queue',
        ]);
        if (empty($refund['ok'])) {
            echo json_encode(['success' => false, 'error' => $refund['error'] ?? 'Refund failed']);
            return true;
        }

        $chargeOrgId = orgNormalizeId($charge['org_id'] ?? '');
        foreach ((array)($charge['applied_offers'] ?? []) as $offerApplied) {
            if (!is_array($offerApplied)) continue;
            $offerId = trim((string)($offerApplied['offer_id'] ?? ''));
            if ($offerId === '' || $chargeOrgId === '') continue;
            orgOfferTrackAppliedItem($chargeOrgId, $offerId, [
                'charge_token' => $token,
                'status' => 'refunded',
                'refunded_at' => gmdate('c'),
                'refund_reason' => 'order_submit_api_failed',
                'refund_amount' => portalMoneyAmount($refund['refunded'] ?? $amount),
            ]);
        }

        portalPendingChargeDelete($token);
        echo json_encode([
            'success' => true,
            'refunded' => portalMoneyAmount($refund['refunded'] ?? $amount),
            'new_balance' => portalMoneyAmount($refund['new_balance'] ?? 0),
        ]);
        return true;
    }

    if ($action === 'portal_refund_captured_order_credits') {
        requireLoginOrFail();
        $userEmail = strtolower(trim((string)$_SESSION['user_email']));
        $amount = isset($_POST['refund_amount']) ? portalMoneyAmount($_POST['refund_amount']) : 0;
        $address = trim((string)($_POST['address'] ?? ''));
        $projectType = trim((string)($_POST['project_type'] ?? 'residential'));
        $projectId = trim((string)($_POST['project_id'] ?? ''));
        $reportMode = trim((string)($_POST['report_mode'] ?? 'instant'));

        if ($amount <= 0) {
            echo json_encode(['success' => false, 'error' => 'Refund amount must be greater than $0.']);
            return true;
        }

        $refund = creditsRefundByEmail($userEmail, $amount, 'instant_no_coverage_refund', [
            'address' => $address,
            'project_type' => $projectType,
            'project_id' => $projectId,
            'report_mode' => $reportMode,
            'source' => 'portal_instant_rejection_refund',
        ]);
        if (empty($refund['ok'])) {
            echo json_encode(['success' => false, 'error' => $refund['error'] ?? 'Refund failed']);
            return true;
        }

        echo json_encode([
            'success' => true,
            'refunded' => portalMoneyAmount($refund['refunded'] ?? $amount),
            'new_balance' => portalMoneyAmount($refund['new_balance'] ?? 0),
        ]);
        return true;
    }
    
    // ---------------- ORG GET (my org) ----------------
    if ($action === 'org_get_my') {
        requireLoginOrFail();
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureDefaults($o);               // ✅ ensures contact/billing/report_settings exist
        orgEnsureBrandingFields($o);
        orgEnsureBillingFields($o);
        orgEnsureReportSettingsFields($o);
        $branding = $o['branding'] ?? [];
        $colors = (is_array($branding) && isset($branding['colors']) && is_array($branding['colors'])) ? $branding['colors'] : [];
        $contact = (isset($o['contact']) && is_array($o['contact'])) ? $o['contact'] : [];
        // Keep your existing "safe" billing response
        $billingSafe = [
            'auto_topup' => [
                'enabled' => !empty($o['billing']['auto_topup']['enabled']),
                'threshold_dollars' => (int)$o['billing']['auto_topup']['threshold_dollars'],
                'topup_dollars' => (int)$o['billing']['auto_topup']['topup_dollars'],
                'cooldown_minutes' => (int)$o['billing']['auto_topup']['cooldown_minutes'],
                'status' => (string)($o['billing']['auto_topup']['status'] ?? 'idle'),
                'last_attempt_utc' => $o['billing']['auto_topup']['last_attempt_utc'] ?? null,
                'last_success_utc' => $o['billing']['auto_topup']['last_success_utc'] ?? null,
                'last_error' => $o['billing']['auto_topup']['last_error'] ?? null,
            ],
            'stripe' => [
                'has_payment_method' => !empty($o['billing']['stripe']['has_payment_method']),
                'brand' => $o['billing']['stripe']['brand'] ?? null,
                'last4' => $o['billing']['stripe']['last4'] ?? null,
                'exp_month' => $o['billing']['stripe']['exp_month'] ?? null,
                'exp_year' => $o['billing']['stripe']['exp_year'] ?? null,
            ],
        ];
        echo json_encode([
            'success'=>true,
            'org'=>[
                'id'=>$orgId,
                'name'=>(string)($o['name'] ?? ''),
                'is_test'=>!empty($o['is_test']),
                'branding'=>[
                    'logo'=>($branding['logo'] ?? null),
                    'colors'=>[
                        'accent'=>$colors['primary'] ?? '#d93025',
                        'secondary'=>$colors['secondary'] ?? '#111111',
                    ]
                ],
                'contact'=>[
                    'email'=>(string)($contact['email'] ?? ''),
                    'phone'=>(string)($contact['phone'] ?? ''),
                    'address'=>(string)($contact['address'] ?? ''),
                ],
                'report_settings'=>$o['report_settings'] ?? [
                    'general'=>['nfva_ratio'=>300],
                    'customer'=>[]
                ],
                'billing'=>$billingSafe,
                'offers'=>orgOffersSnapshot($o),
            ]
        ]);
        return true;
    }

    if ($action === 'org_offer_status' || $action === 'org_offers_my') {
        $internalOk = internalMutationAuthorized();
        if (!$internalOk) requireLoginOrFail();
        $actorEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $actorOrgId = function_exists('actorOrgIdFromSession') ? actorOrgIdFromSession() : null;
        $targetOrgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($targetOrgId === '') $targetOrgId = orgNormalizeId($actorOrgId ?? '');
        if ($targetOrgId === '') {
            die(json_encode(['success' => false, 'error' => 'No org']));
        }
        if (!$internalOk && $targetOrgId !== orgNormalizeId($actorOrgId ?? '') && !orgActorCanManageCustomers()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $o = orgRead($targetOrgId);
        if (!$o) die(json_encode(['success' => false, 'error' => 'Org not found']));
        $offerId = trim((string)($_POST['offer_id'] ?? ''));
        $offers = orgOffersSnapshot($o);
        if ($offerId !== '') {
            $offer = $offers['items'][$offerId] ?? null;
            if (!$offer) die(json_encode(['success' => false, 'error' => 'Offer not found']));
            echo json_encode(['success' => true, 'org_id' => $targetOrgId, 'offer' => $offer]);
            return true;
        }
        echo json_encode(['success' => true, 'org_id' => $targetOrgId, 'offers' => $offers]);
        return true;
    }

    if ($action === 'org_offer_mark_shown') {
        $internalOk = internalMutationAuthorized();
        if (!$internalOk) requireLoginOrFail();
        $actorOrgId = function_exists('actorOrgIdFromSession') ? actorOrgIdFromSession() : null;
        $targetOrgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($targetOrgId === '') $targetOrgId = orgNormalizeId($actorOrgId ?? '');
        $offerId = trim((string)($_POST['offer_id'] ?? ''));
        if ($targetOrgId === '' || $offerId === '') {
            die(json_encode(['success' => false, 'error' => 'Missing org_id or offer_id']));
        }
        if (!$internalOk && $targetOrgId !== orgNormalizeId($actorOrgId ?? '') && !orgActorCanManageCustomers()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $rawMeta = $_POST['meta_json'] ?? ($_POST['meta'] ?? '');
        $meta = is_array($rawMeta) ? $rawMeta : json_decode((string)$rawMeta, true);
        if (!is_array($meta)) $meta = [];
        $result = orgOfferMarkShown($targetOrgId, $offerId, $meta);
        echo json_encode($result);
        return true;
    }

    if ($action === 'org_offer_claim') {
        $internalOk = internalMutationAuthorized();
        if (!$internalOk) requireLoginOrFail();
        if (!$internalOk && !orgActorCanManageCustomers()) {
            die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        }
        $actorOrgId = function_exists('actorOrgIdFromSession') ? actorOrgIdFromSession() : null;
        $targetOrgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($targetOrgId === '') $targetOrgId = orgNormalizeId($actorOrgId ?? '');
        $offerId = trim((string)($_POST['offer_id'] ?? ''));
        if ($targetOrgId === '' || $offerId === '') {
            die(json_encode(['success' => false, 'error' => 'Missing org_id or offer_id']));
        }
        $rawMeta = $_POST['meta_json'] ?? ($_POST['meta'] ?? '');
        $meta = is_array($rawMeta) ? $rawMeta : json_decode((string)$rawMeta, true);
        if (!is_array($meta)) $meta = [];
        $rawOptions = $_POST['options_json'] ?? ($_POST['options'] ?? '');
        $options = is_array($rawOptions) ? $rawOptions : json_decode((string)$rawOptions, true);
        if (!is_array($options)) $options = [];
        $result = orgOfferClaim($targetOrgId, $offerId, $meta, $options);
        echo json_encode($result);
        return true;
    }
    
    if ($action === 'org_billing_history_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBillingFields($o);
        orgEnsureCreditsFields($o);
        $limit = (int)($_POST['limit'] ?? 60);
        if ($limit < 5) $limit = 5;
        if ($limit > 200) $limit = 200;
        $events = $o['billing']['events'] ?? [];
        if (!is_array($events)) $events = [];
        // newest last in storage sometimes; normalize to newest-first
        usort($events, function($a,$b){
            return strcmp((string)($b['ts_utc'] ?? ''), (string)($a['ts_utc'] ?? ''));
        });
        $events = array_slice($events, 0, $limit);
        $ledger = orgBillingLedgerRowsForRange($o);
        $ledger = array_slice($ledger, 0, $limit);
        echo json_encode([
            'success'=>true,
            'org_id'=>$orgId,
            'events'=>$events,
            'ledger'=>$ledger
        ]);
        return true;
    }

    if ($action === 'org_monthly_statement') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBillingFields($o);
        orgEnsureCreditsFields($o);
        $month = (int)($_POST['month'] ?? (int)date('n'));
        $year = (int)($_POST['year'] ?? (int)date('Y'));
        echo json_encode(orgMonthlyStatementPayload($orgId, $o, $month, $year));
        return true;
    }
    
    if ($action === 'org_update_my_billing') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_billing');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBillingFields($o);
        orgEnsureCreditsFields($o);
        $raw = (string)($_POST['billing_json'] ?? '');
        $j = json_decode($raw, true);
        if (!is_array($j)) $j = [];
        $at = $j['auto_topup'] ?? [];
        if (!is_array($at)) $at = [];
        $enabled  = !empty($at['enabled']);
        $threshold = max(35, (int)($at['threshold_dollars'] ?? $o['billing']['auto_topup']['threshold_dollars']));
        $topup     = max(35, (int)($at['topup_dollars'] ?? $o['billing']['auto_topup']['topup_dollars']));
        $hasPM = !empty($o['billing']['stripe']['has_payment_method']);
        // ✅ Always save settings, even without a payment method.
        $o['billing']['auto_topup']['enabled'] = $enabled;
        $o['billing']['auto_topup']['threshold_dollars'] = $threshold;
        $o['billing']['auto_topup']['topup_dollars'] = $topup;
        // Status semantics
        if (!$enabled) {
            $o['billing']['auto_topup']['status'] = 'idle';
            $o['billing']['auto_topup']['last_error'] = null;
        } else if (!$hasPM) {
            $o['billing']['auto_topup']['status'] = 'needs_payment_method';
            $o['billing']['auto_topup']['last_error'] = 'Payment method required';
        } else {
            $cur = (string)($o['billing']['auto_topup']['status'] ?? '');
            if ($cur === '' || $cur === 'needs_payment_method') $o['billing']['auto_topup']['status'] = 'idle';
            $o['billing']['auto_topup']['last_error'] = null;
        }
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)$_SESSION['user_email']));
        orgBillingLogEvent($o, 'settings_update', [
            'enabled'=>$enabled,
            'threshold_dollars'=>$threshold,
            'topup_dollars'=>$topup,
            'has_payment_method'=>$hasPM,
        ]);
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        // Prime if needed
        $primed = false;
        if ($enabled && $hasPM) {
            $balance = portalMoneyAmount($o['credits_balance'] ?? 0);
            $byEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
            if ($byEmail !== '' && $balance < $threshold) {
                $prime = orgAutoTopupTry($orgId, $byEmail, $balance, [
                    'reason' => 'settings_save_prime',
                    'source' => 'org_update_my_billing'
                ]);
                $primed = !empty($prime['ok']) && empty($prime['skipped']);
            }
        }
        echo json_encode([
            'success'=>true,
            'saved'=>true,
            'requires_payment_method'=>($enabled && !$hasPM),
            'primed'=>$primed
        ]);
        return true;
    }
    
    // ---------------- ORG UPDATE (my org) ----------------
    if ($action === 'org_update_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_settings');
        $email = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        $name = trim((string)($_POST['name'] ?? ''));
        $accent = trim((string)($_POST['accent'] ?? ''));
        $secondary = trim((string)($_POST['secondary'] ?? ''));
        if ($name !== '') $o['name'] = sanitizeName($name);
        orgEnsureBrandingFields($o);
        if ($accent !== '')   $o['branding']['colors']['primary']   = orgNormalizeHexColor($accent,   $o['branding']['colors']['primary']   ?? '#d93025');
        if ($secondary !== '')$o['branding']['colors']['secondary'] = orgNormalizeHexColor($secondary,$o['branding']['colors']['secondary'] ?? '#111111');
        // contact fields
        $cEmail = sanitizeEmail($_POST['company_email'] ?? '');
        $cPhone = trim((string)($_POST['company_phone'] ?? ''));
        $cAddr  = trim((string)($_POST['company_address'] ?? ''));
        // light normalization
        $cPhone = preg_replace('/[^\d\+\-\(\)\.\s]/', '', $cPhone);
        $cPhone = preg_replace('/\s+/', ' ', $cPhone);
        $cPhone = substr($cPhone, 0, 60);
        $cAddr = preg_replace('/\s+/', ' ', $cAddr);
        $cAddr = substr($cAddr, 0, 240);
        if (!isset($o['contact']) || !is_array($o['contact'])) $o['contact'] = [];
        $o['contact']['email'] = $cEmail;
        $o['contact']['phone'] = $cPhone;
        $o['contact']['address'] = $cAddr;
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = $email;
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true]);
        return true;
    }
    
    // ---------------- ORG UPDATE REPORT SETTINGS (my org) ----------------
    if ($action === 'org_update_my_report_settings') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_report_settings');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureDefaults($o);
        orgEnsureReportSettingsFields($o);
        $raw = (string)($_POST['report_settings_json'] ?? '');
        $j = json_decode($raw, true);
        if (!is_array($j)) $j = [];
        $gen = $j['general'] ?? [];
        $cus = $j['customer'] ?? [];
        if (!is_array($gen)) $gen = [];
        if (!is_array($cus)) $cus = [];
        // Accept nmva_ratio alias
        if (!array_key_exists('nfva_ratio', $gen) && array_key_exists('nmva_ratio', $gen)) {
            $gen['nfva_ratio'] = $gen['nmva_ratio'];
        }
        $nfva = (int)($gen['nfva_ratio'] ?? ($o['report_settings']['general']['nfva_ratio'] ?? 300));
        $nfva = max(1, min(1000, $nfva));
        $bonusUpfrontMatchEnabled = array_key_exists('bonus_upfront_match_offer_enabled', $gen)
            ? !!$gen['bonus_upfront_match_offer_enabled']
            : !empty($o['report_settings']['general']['bonus_upfront_match_offer_enabled']);
        // Normalize booleans for known customer keys
        $known = [
            'cover_show_customer','cover_show_squares','cover_show_waste','cover_show_breakdown','cover_show_pitch','cover_show_facets',
            'page_top_view','page_elevations','page_3d','page_pitch','page_area','page_layers','page_summary','page_materials','page_ventilation'
        ];
        $nextCustomer = $o['report_settings']['customer'] ?? [];
        if (!is_array($nextCustomer)) $nextCustomer = [];
        foreach ($known as $k) {
            if (array_key_exists($k, $cus)) $nextCustomer[$k] = !!$cus[$k];
            else if (!array_key_exists($k, $nextCustomer)) $nextCustomer[$k] = true;
        }
        $o['report_settings'] = [
            'general' => [
                'nfva_ratio' => $nfva,
                'bonus_upfront_match_offer_enabled' => $bonusUpfrontMatchEnabled,
            ],
            'customer' => $nextCustomer
        ];
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true]);
        return true;
    }
    
    if ($action === 'onboarding_complete') {
        requireLoginOrFail();
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));

        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));

        $o['onboarding_completed'] = true;
        $o['onboarding_completed_at'] = gmdate('c');
        $o['onboarding_meta'] = [
            'did_purchase' => ($_POST['did_purchase'] ?? '0') === '1',
            'did_add_card' => ($_POST['did_add_card'] ?? '0') === '1',
            'completed_by' => $_SESSION['user_email'] ?? null,
        ];

        orgWrite($orgId, $o);

        echo json_encode(['success'=>true]);
        return true;
    }
    
    // ---------------- PROMO: First-Load 50% Match Eligibility ----------------
    if ($action === 'check_promo_eligibility') {
        // Must be logged in
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'not_logged_in']));
        }

        $email = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = actorOrgIdFromSession();

        // No org → not eligible
        if (!$orgId) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'no_org']));
        }

        $o = orgRead($orgId);
        if (!$o) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'org_not_found']));
        }

        orgEnsureDefaults($o);
        orgEnsureCreditsFields($o);

        // ── 1. Must be the org creator (first / primary user) ──
        $creatorEmail = strtolower(trim((string)($o['created_by_email'] ?? '')));
        if ($creatorEmail === '' || $creatorEmail !== $email) {
            die(json_encode(['success' => true, 'eligible' => false, 'reason' => 'not_creator']));
        }

        // ── 2. Org must have been created today (UTC) ──
        $createdAt = $o['created_at'] ?? '';
        $signupDate = '';
        if ($createdAt !== '') {
            // Handle both ISO 8601 and "Y-m-d H:i:s" formats
            $ts = strtotime($createdAt);
            if ($ts !== false) {
                $signupDate = gmdate('Y-m-d', $ts);
            }
        }

        $todayUtc = gmdate('Y-m-d');
        if ($signupDate !== $todayUtc) {
            die(json_encode([
                'success'     => true,
                'eligible'    => false,
                'reason'      => 'not_signup_day',
                'signup_date' => $signupDate,
                'today'       => $todayUtc,
            ]));
        }

        // ── 3. Org must have never completed a Stripe card-load ──
        //    Check both credits_ledger and billing.events for any
        //    stripe checkout / payment completion.
        $hasStripeLoad = false;

        // Check credits ledger
        $ledger = $o['credits_ledger'] ?? [];
        if (is_array($ledger)) {
            foreach ($ledger as $entry) {
                if (!is_array($entry)) continue;
                $reason = strtolower((string)($entry['reason'] ?? ''));
                $delta  = (int)($entry['delta'] ?? 0);
                // Only count positive stripe loads (not refunds or spends)
                if ($delta > 0 && (
                    strpos($reason, 'stripe') !== false ||
                    strpos($reason, 'checkout') !== false ||
                    strpos($reason, 'card_load') !== false ||
                    strpos($reason, 'payment') !== false
                )) {
                    $hasStripeLoad = true;
                    break;
                }
            }
        }

        // Also check billing events as a fallback
        if (!$hasStripeLoad) {
            $events = $o['billing']['events'] ?? [];
            if (is_array($events)) {
                foreach ($events as $ev) {
                    if (!is_array($ev)) continue;
                    $type = strtolower((string)($ev['type'] ?? ''));
                    if (
                        strpos($type, 'stripe_paid') !== false ||
                        strpos($type, 'checkout_complete') !== false ||
                        strpos($type, 'topup_success') !== false ||
                        strpos($type, 'payment_success') !== false
                    ) {
                        $hasStripeLoad = true;
                        break;
                    }
                }
            }
        }

        if ($hasStripeLoad) {
            die(json_encode([
                'success'  => true,
                'eligible' => false,
                'reason'   => 'already_loaded',
            ]));
        }

        // ── All checks passed — eligible ──
        echo json_encode([
            'success'     => true,
            'eligible'    => true,
            'signup_date' => $signupDate,
            'org_id'      => $orgId,
            'match_pct'   => 50,
        ]);
        return true;
    }

    
    // ---------------- ORG UPLOAD LOGO (my org) ----------------
    if ($action === 'org_upload_logo_my') {
        requireLoginOrFail();
        requireOrgPermOrFail('manage_company_settings');
        $orgId = actorOrgIdFromSession();
        if (!$orgId) die(json_encode(['success'=>false,'error'=>'No org']));
        if (empty($_FILES['logo']) || !is_array($_FILES['logo'])) {
            die(json_encode(['success'=>false,'error'=>'Missing file: logo']));
        }
        $f = $_FILES['logo'];
        if (!empty($f['error'])) die(json_encode(['success'=>false,'error'=>'Upload error','code'=>$f['error']]));
        if (empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) die(json_encode(['success'=>false,'error'=>'Bad upload tmp']));
        $name = (string)($f['name'] ?? 'logo');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '') $ext = 'png';
        if (!in_array($ext, ['png','jpg','jpeg','webp','svg'], true)) die(json_encode(['success'=>false,'error'=>'Unsupported file type']));
        if ($ext === 'jpeg') $ext = 'jpg';
        $dir = orgPath($orgId);
        if (!$dir) die(json_encode(['success'=>false,'error'=>'Org path failed']));
        if (!file_exists($dir)) @mkdir($dir, 0777, true);
        $destName = 'logo.' . $ext;
        $destPath = $dir . $destName;
        if (!@move_uploaded_file($f['tmp_name'], $destPath)) die(json_encode(['success'=>false,'error'=>'Move failed']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        orgEnsureBrandingFields($o);
        $o['branding']['logo'] = 'organizations/' . $orgId . '/' . $destName;
        $o['branding']['logo_updated_at_utc'] = gmdate('c');
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true,'logo'=>$o['branding']['logo']]);
        return true;
    }

    // ---------------- SET TEST ORG FLAG ----------------
    if ($action === 'org_set_test_flag') {
        requireLoginOrFail();
        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Missing org_id']));
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        $isTest = !empty($_POST['is_test']);
        $o['is_test'] = $isTest;
        $o['updated_at_utc'] = gmdate('c');
        $o['updated_by_email'] = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode(['success'=>true,'org_id'=>$orgId,'is_test'=>$isTest]);
        return true;
    }
    
    if ($action === 'internal_set_field') {
        internalMutationAuthOrFail();
        $type = strtolower(trim((string)($_POST['target_type'] ?? '')));
        $tid  = trim((string)($_POST['target_id'] ?? ''));
        $path = trim((string)($_POST['path'] ?? ''));
        if (!in_array($type, ['user','org'], true)) die(json_encode(['success'=>false,'error'=>'Invalid target_type']));
        if ($tid === '') die(json_encode(['success'=>false,'error'=>'Missing target_id']));
        if ($path === '') die(json_encode(['success'=>false,'error'=>'Missing path']));
        $parts = normalizeDotPath($path);
        if (!$parts) die(json_encode(['success'=>false,'error'=>'Invalid path']));
        $rawVal = isset($_POST['value_json']) ? $_POST['value_json'] : ($_POST['value'] ?? '');
        $val = coerceJsonValue($rawVal);
        if ($type === 'org') {
            $orgId = orgNormalizeId($tid);
            if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Bad org_id']));
            $o = orgRead($orgId);
            if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
            arraySetByPath($o, $parts, $val);
            if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
            echo json_encode([
                'success'=>true,
                'target_type'=>'org',
                'target_id'=>$orgId,
                'path'=>$path,
                'value'=>$val
            ]);
            return true;
        }
        // user (by user_id, not email)
        $userId = strtolower(trim((string)$tid));
        $uf = userFindFileById($userId);
        if (!$uf) die(json_encode(['success'=>false,'error'=>'User not found by id']));
        $u = json_decode(@file_get_contents($uf), true);
        if (!is_array($u)) $u = [];
        if (function_exists('ensureUserId')) ensureUserId($u);
        if (function_exists('ensureUserCreditsFields')) ensureUserCreditsFields($u);
        if (function_exists('ensureUserOrgFields')) ensureUserOrgFields($u);
        arraySetByPath($u, $parts, $val);
        if (!atomicWriteJson($uf, $u)) die(json_encode(['success'=>false,'error'=>'User write failed']));
        echo json_encode([
            'success'=>true,
            'target_type'=>'user',
            'target_id'=>$userId,
            'path'=>$path,
            'value'=>$val
        ]);
        return true;
    }
    
    if ($action === 'org_upload_logo') {
        internalMutationAuthOrFail();
        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($orgId === '') die(json_encode(['success'=>false,'error'=>'Missing/bad org_id']));
        if (empty($_FILES['logo']) || !is_array($_FILES['logo'])) {
            die(json_encode(['success'=>false,'error'=>'Missing file: logo']));
        }
        $f = $_FILES['logo'];
        if (!empty($f['error'])) die(json_encode(['success'=>false,'error'=>'Upload error','code'=>$f['error']]));
        if (empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) die(json_encode(['success'=>false,'error'=>'Bad upload tmp']));
        // allow common image formats
        $name = (string)($f['name'] ?? 'logo');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '') $ext = 'png';
        if (!in_array($ext, ['png','jpg','jpeg','webp','svg'], true)) {
            die(json_encode(['success'=>false,'error'=>'Unsupported file type']));
        }
        if ($ext === 'jpeg') $ext = 'jpg';
        $dir = orgPath($orgId);
        if (!$dir) die(json_encode(['success'=>false,'error'=>'Org path failed']));
        if (!file_exists($dir)) @mkdir($dir, 0777, true);
        $destName = 'logo.' . $ext;
        $destPath = $dir . $destName;
        // overwrite ok
        if (!@move_uploaded_file($f['tmp_name'], $destPath)) {
            die(json_encode(['success'=>false,'error'=>'Move failed']));
        }
        // update org manifest
        $o = orgRead($orgId);
        if (!$o) die(json_encode(['success'=>false,'error'=>'Org not found']));
        if (!isset($o['branding']) || !is_array($o['branding'])) $o['branding'] = [];
        $o['branding']['logo'] = orgLogoRelUrl($orgId, $destName);
        $o['branding']['logo_updated_at_utc'] = gmdate('c');
        if (!orgWrite($orgId, $o)) die(json_encode(['success'=>false,'error'=>'Org write failed']));
        echo json_encode([
            'success'=>true,
            'org_id'=>$orgId,
            'logo'=>$o['branding']['logo'],
        ]);
        return true;
    }

    if ($action === 'customer_org_dashboard_data') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        set_error_handler(function($severity, $message, $file, $line) {
            if (!(error_reporting() & $severity)) return false;
            throw new ErrorException($message, 0, $severity, $file, $line);
        });
        try {
            $payload = [
                'success' => true,
                'can_manage' => orgActorCanManageCustomers(),
                'can_view_all' => orgActorCanViewAllCustomers(),
                'sales_users' => orgSalesUsersList(),
                'organizations' => orgCustomerDataSnapshot($actor),
            ];
            $json = orgJsonEncodeApiPayload($payload, 'customer_org_dashboard_data');
            if ($json === false) {
                throw new RuntimeException('Unable to encode customer dashboard payload');
            }
            echo $json;
        } catch (Throwable $e) {
            error_log(
                'customer_org_dashboard_data failed for actor=' . $actor
                . ' message=' . $e->getMessage()
                . ' file=' . $e->getFile()
                . ' line=' . $e->getLine()
            );
            echo json_encode([
                'success' => false,
                'error' => 'Customer dashboard data failed to load. Check php_error.log for details.'
            ]);
        } finally {
            restore_error_handler();
        }
        exit;
    }

    if ($action === 'customer_org_detail') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $actor = strtolower(trim((string)$_SESSION['user_email']));
        $orgId = orgNormalizeId($_POST['org_id'] ?? '');
        if ($orgId === '') {
            die(json_encode(['success' => false, 'error' => 'Missing organization id']));
        }
        $ordersPage = max(1, (int)($_POST['orders_page'] ?? 1));
        $ledgerPage = max(1, (int)($_POST['ledger_page'] ?? 1));
        $rows = orgCustomerDataSnapshot($actor, [
            'org_id' => $orgId,
            'include_orders' => true,
            'include_credit_ledger' => true,
            'include_volume_buckets' => true,
            'orders_page' => $ordersPage,
            'ledger_page' => $ledgerPage,
            'orders_per_page' => 50,
            'ledger_per_page' => 50,
        ]);
        if (!$rows) {
            die(json_encode(['success' => false, 'error' => 'Organization not found or not accessible']));
        }
        echo json_encode([
            'success' => true,
            'organization' => $rows[0],
        ]);
        exit;
    }

    if ($action === 'org_assign_sales_owner') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $orgIds = $_POST['org_ids'] ?? [];
        if (is_string($orgIds)) {
            $decoded = json_decode($orgIds, true);
            if (json_last_error() === JSON_ERROR_NONE) $orgIds = $decoded;
        }
        if (!is_array($orgIds) || !$orgIds) die(json_encode(['success' => false, 'error' => 'No organizations selected']));
        $assignedTo = strtolower(trim((string)($_POST['assigned_to_email'] ?? '')));
        $salesUsers = orgSalesUsersList();
        $salesMap = [];
        foreach ($salesUsers as $row) $salesMap[strtolower(trim((string)$row['email']))] = $row;
        if ($assignedTo !== '' && !isset($salesMap[$assignedTo])) {
            die(json_encode(['success' => false, 'error' => 'Unknown salesperson']));
        }
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $updated = 0;
        foreach ($orgIds as $orgIdRaw) {
            $orgId = orgNormalizeId($orgIdRaw);
            if ($orgId === '') continue;
            $o = orgRead($orgId);
            if (!$o) continue;
            $o['assigned_sales_email'] = $assignedTo;
            $o['assigned_sales_name'] = $assignedTo !== '' ? (string)($salesMap[$assignedTo]['name'] ?? $assignedTo) : '';
            $o['assigned_sales_by_email'] = $actor;
            $o['assigned_sales_at'] = gmdate('c');
            if (orgWrite($orgId, $o)) $updated++;
        }
        echo json_encode(['success' => true, 'updated' => $updated]);
        exit;
    }

    if ($action === 'customer_pair_candidates') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $db = function_exists('leadDb') ? leadDb() : null;
        if (!$db) die(json_encode(['success' => false, 'error' => 'Lead database unavailable']));

        $orgs = orgCustomerDataSnapshot(strtolower(trim((string)($_SESSION['user_email'] ?? ''))));
        $domainIndex = [];
        $phoneIndex = [];
        $leadSql = "
            SELECT l.id, l.company, l.email, l.phone, l.organization_id, l.updated_at, ll.assigned_to_email, ll.name AS list_name
            FROM leads l
            JOIN lead_lists ll ON ll.id = l.list_id
            WHERE COALESCE(l.organization_id, '') = ''
        ";
        $leadRes = $db->query($leadSql);
        while ($leadRes && ($lead = $leadRes->fetchArray(SQLITE3_ASSOC))) {
            $domain = orgEmailDomain($lead['email'] ?? '');
            $phone = orgNormPhone($lead['phone'] ?? '');
            if ($domain !== '') {
                if (!isset($domainIndex[$domain])) $domainIndex[$domain] = [];
                $domainIndex[$domain][] = $lead;
            }
            if ($phone !== '') {
                if (!isset($phoneIndex[$phone])) $phoneIndex[$phone] = [];
                $phoneIndex[$phone][] = $lead;
            }
        }

        $pairs = [];
        foreach ($orgs as $org) {
            if (!empty($org['is_test'])) continue;
            $domains = [];
            $phones = [];
            foreach (($org['users'] ?? []) as $user) {
                $domain = orgEmailDomain($user['email'] ?? '');
                if ($domain !== '') $domains[$domain] = true;
                $phone = orgNormPhone($user['phone'] ?? '');
                if ($phone !== '') $phones[$phone] = true;
            }
            $contactEmailDomain = orgEmailDomain($org['contact']['email'] ?? '');
            if ($contactEmailDomain !== '') $domains[$contactEmailDomain] = true;
            $contactPhone = orgNormPhone($org['contact']['phone'] ?? '');
            if ($contactPhone !== '') $phones[$contactPhone] = true;

            $candidates = [];
            foreach (array_keys($domains) as $domain) {
                foreach (($domainIndex[$domain] ?? []) as $lead) {
                    $id = (string)$lead['id'];
                    if (!isset($candidates[$id])) $candidates[$id] = ['lead' => $lead, 'reasons' => [], 'score' => 0];
                    $candidates[$id]['reasons'][] = 'Shared email domain: ' . $domain;
                    $candidates[$id]['score'] += 3;
                }
            }
            foreach (array_keys($phones) as $phone) {
                foreach (($phoneIndex[$phone] ?? []) as $lead) {
                    $id = (string)$lead['id'];
                    if (!isset($candidates[$id])) $candidates[$id] = ['lead' => $lead, 'reasons' => [], 'score' => 0];
                    $candidates[$id]['reasons'][] = 'Shared phone number';
                    $candidates[$id]['score'] += 4;
                }
            }

            foreach ($candidates as $leadId => $candidate) {
                $lead = $candidate['lead'];
                $pairs[] = [
                    'pair_id' => $org['id'] . ':' . $leadId,
                    'organization_id' => $org['id'],
                    'organization_name' => $org['name'],
                    'organization_is_test' => !empty($org['is_test']),
                    'lead_id' => $leadId,
                    'lead_company' => (string)($lead['company'] ?? ''),
                    'lead_email' => (string)($lead['email'] ?? ''),
                    'lead_phone' => (string)($lead['phone'] ?? ''),
                    'lead_list_name' => (string)($lead['list_name'] ?? ''),
                    'assigned_sales_email' => strtolower(trim((string)($lead['assigned_to_email'] ?? ''))),
                    'reasons' => array_values(array_unique($candidate['reasons'])),
                    'score' => (int)$candidate['score'],
                    'updated_at' => (int)($lead['updated_at'] ?? 0),
                ];
            }
        }

        usort($pairs, function($a, $b) {
            if ((int)$a['score'] !== (int)$b['score']) return (int)$b['score'] - (int)$a['score'];
            return strcmp((string)$a['organization_name'], (string)$b['organization_name']);
        });

        echo json_encode(['success' => true, 'pairs' => $pairs]);
        exit;
    }

    if ($action === 'customer_apply_pairs') {
        requireLoginOrFail();
        if (!orgActorCanManageCustomers()) die(json_encode(['success' => false, 'error' => 'Unauthorized']));
        $pairs = $_POST['pairs'] ?? [];
        if (is_string($pairs)) {
            $decoded = json_decode($pairs, true);
            if (json_last_error() === JSON_ERROR_NONE) $pairs = $decoded;
        }
        if (!is_array($pairs) || !$pairs) die(json_encode(['success' => false, 'error' => 'No pairs provided']));
        $db = function_exists('leadDb') ? leadDb() : null;
        if (!$db) die(json_encode(['success' => false, 'error' => 'Lead database unavailable']));
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $applied = 0;
        foreach ($pairs as $pair) {
            $orgId = orgNormalizeId($pair['organization_id'] ?? '');
            $leadId = trim((string)($pair['lead_id'] ?? ''));
            if ($orgId === '' || $leadId === '') continue;
            $o = orgRead($orgId);
            if (!$o) continue;
            if (!empty($o['is_test'])) continue;
            $salesEmail = strtolower(trim((string)($pair['assigned_sales_email'] ?? '')));
            if (!leadLinkOrganization($db, $leadId, $orgId, $actor, $salesEmail)) continue;
            $paired = array_values(array_unique(array_filter(array_map('strval', $o['paired_lead_ids'] ?? []))));
            if (!in_array($leadId, $paired, true)) $paired[] = $leadId;
            $o['paired_lead_ids'] = $paired;
            if (empty($o['paired_primary_lead_id'])) $o['paired_primary_lead_id'] = $leadId;
            $o['paired_at'] = gmdate('c');
            if ($salesEmail !== '') {
                $o['assigned_sales_email'] = $salesEmail;
                $o['assigned_sales_by_email'] = $actor;
                $o['assigned_sales_at'] = gmdate('c');
                foreach (orgSalesUsersList() as $row) {
                    if (strtolower(trim((string)$row['email'])) === $salesEmail) {
                        $o['assigned_sales_name'] = (string)($row['name'] ?? $salesEmail);
                        break;
                    }
                }
            }
            if (orgWrite($orgId, $o)) $applied++;
        }
        echo json_encode(['success' => true, 'applied' => $applied]);
        exit;
    }

    if ($action === 'fetch_organizations_list') {
        if (!isset($_SESSION['user_email'])) {
            die(json_encode(['success' => false, 'error' => 'Not logged in']));
        }
        $orgs = [];
        $orgDirPath = orgDirPath();
        if (is_dir($orgDirPath)) {
            foreach (scandir($orgDirPath) as $f) {
                if ($f === '.' || $f === '..') continue;
                $manifestPath = $orgDirPath . $f . '/manifest.json';
                if (file_exists($manifestPath)) {
                    $o = json_decode(file_get_contents($manifestPath), true);
                    if (is_array($o)) {
                        orgEnsureCreditsFields($o);
                        $entry = [
                            'id' => $o['id'] ?? $f,
                            'name' => $o['name'] ?? $f,
                            'is_test' => !empty($o['is_test']),
                            'created_at' => $o['created_at'] ?? null,
                        ];
                        // Include credits data when requested (used by customers admin view)
                        if (!empty($_POST['include_credits'])) {
                            $entry['credits_balance'] = portalMoneyAmount($o['credits_balance'] ?? 0);
                            $entry['credits_ledger'] = $o['credits_ledger'] ?? [];
                        }
                        $orgs[] = $entry;
                    }
                }
            }
        }
        echo json_encode(['success' => true, 'organizations' => $orgs]);
        exit;
    }
    
    // Action not handled by this file
    return false;
}
