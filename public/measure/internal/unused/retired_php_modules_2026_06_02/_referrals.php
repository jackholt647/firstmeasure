<?php
require_once __DIR__ . '/_storage.php';

function referralDbPath() {
    return storageExistingPath('databases/referrals.sqlite', __DIR__ . '/referrals.sqlite', true);
}

function referralSqliteTableExists($db, $table) {
    if (!($db instanceof SQLite3) || trim((string)$table) === '') return false;
    $stmt = @$db->prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = :name LIMIT 1");
    if (!$stmt) return false;
    $stmt->bindValue(':name', (string)$table, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) && !empty($row['name']);
}

function referralSqliteColumnExists($db, $table, $column) {
    if (!($db instanceof SQLite3) || trim((string)$table) === '' || trim((string)$column) === '') return false;
    $res = @$db->query("PRAGMA table_info(" . $table . ")");
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        if (strtolower(trim((string)($row['name'] ?? ''))) === strtolower(trim((string)$column))) {
            return true;
        }
    }
    return false;
}

function referralEnsureSchema($db) {
    if (!($db instanceof SQLite3)) return;
    @$db->exec('PRAGMA journal_mode=WAL');
    @$db->exec('PRAGMA foreign_keys=OFF');
    @$db->exec("
        CREATE TABLE IF NOT EXISTS referral_partners (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            display_name TEXT NOT NULL,
            company_name TEXT NOT NULL DEFAULT '',
            contact_name TEXT NOT NULL DEFAULT '',
            contact_email TEXT NOT NULL DEFAULT '',
            contact_phone TEXT NOT NULL DEFAULT '',
            logo_path TEXT NOT NULL DEFAULT '',
            logo_url TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            linked_user_email TEXT NOT NULL DEFAULT '',
            linked_org_id TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by_email TEXT NOT NULL DEFAULT '',
            updated_by_email TEXT NOT NULL DEFAULT ''
        )
    ");
    @$db->exec("
        CREATE TABLE IF NOT EXISTS referral_codes (
            id TEXT PRIMARY KEY,
            partner_id TEXT NOT NULL,
            code TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL DEFAULT 'Primary',
            campaign_type TEXT NOT NULL DEFAULT '',
            landing_variant TEXT NOT NULL DEFAULT '',
            new_org_offer_id TEXT NOT NULL DEFAULT '',
            referrer_reward_policy_id TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            is_primary INTEGER NOT NULL DEFAULT 1,
            landing_views INTEGER NOT NULL DEFAULT 0,
            last_viewed_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by_email TEXT NOT NULL DEFAULT '',
            updated_by_email TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
    ");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_codes_partner ON referral_codes(partner_id)");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_codes_active ON referral_codes(active, code)");
    @$db->exec("
        CREATE TABLE IF NOT EXISTS referral_attributions (
            id TEXT PRIMARY KEY,
            code_id TEXT NOT NULL,
            partner_id TEXT NOT NULL,
            referred_org_id TEXT NOT NULL DEFAULT '',
            referred_email TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'viewed',
            clicked_at TEXT NOT NULL DEFAULT '',
            signup_started_at TEXT NOT NULL DEFAULT '',
            signup_completed_at TEXT NOT NULL DEFAULT '',
            offer_started_at TEXT NOT NULL DEFAULT '',
            ip_address TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            snapshot_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    ");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_attr_partner ON referral_attributions(partner_id)");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_attr_code ON referral_attributions(code_id)");
    @$db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_attr_org_unique ON referral_attributions(referred_org_id) WHERE referred_org_id <> ''");
    @$db->exec("
        CREATE TABLE IF NOT EXISTS referral_reward_ledger (
            id TEXT PRIMARY KEY,
            partner_id TEXT NOT NULL,
            attribution_id TEXT NOT NULL DEFAULT '',
            reward_type TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
    ");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_rewards_partner ON referral_reward_ledger(partner_id)");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_rewards_attr ON referral_reward_ledger(attribution_id)");
    @$db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_rewards_once ON referral_reward_ledger(attribution_id, reward_type) WHERE attribution_id <> '' AND reward_type <> ''");
    @$db->exec("
        CREATE TABLE IF NOT EXISTS referral_events (
            id TEXT PRIMARY KEY,
            partner_id TEXT NOT NULL DEFAULT '',
            code_id TEXT NOT NULL DEFAULT '',
            actor_email TEXT NOT NULL DEFAULT '',
            actor_org_id TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL DEFAULT '',
            event_count INTEGER NOT NULL DEFAULT 1,
            first_seen_at TEXT NOT NULL DEFAULT '',
            last_seen_at TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
    ");
    @$db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_events_unique ON referral_events(partner_id, actor_email, actor_org_id, event_type)");
    @$db->exec("CREATE INDEX IF NOT EXISTS idx_referral_events_partner ON referral_events(partner_id, event_type)");

    if (!referralSqliteColumnExists($db, 'referral_codes', 'metadata_json')) {
        @$db->exec("ALTER TABLE referral_codes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!referralSqliteColumnExists($db, 'referral_partners', 'logo_url')) {
        @$db->exec("ALTER TABLE referral_partners ADD COLUMN logo_url TEXT NOT NULL DEFAULT ''");
    }
}

function referralRewardPolicyDefinition($policyId) {
    $policyId = trim((string)$policyId);
    if ($policyId === 'customer_referral_reward_v1') {
        return [
            'id' => 'customer_referral_reward_v1',
            'label' => '$100 Visa gift card after $500 paid revenue',
            'reward_type' => 'visa_gift_card',
            'reward_amount' => 100.0,
            'threshold_paid_revenue' => 500.0,
            'currency' => 'usd',
            'fulfillment_method' => 'manual_visa_gift_card',
        ];
    }
    return null;
}

function referralMoneyAmount($value) {
    return round((float)$value, 2);
}

function referralQualifiedPaidRevenueForOrg($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return 0.0;
    $o = orgRead($orgId);
    if (!is_array($o)) return 0.0;
    orgEnsureCreditsFields($o);
    $total = 0.0;
    $ledger = is_array($o['credits_ledger'] ?? null) ? $o['credits_ledger'] : [];
    foreach ($ledger as $entry) {
        if (!is_array($entry)) continue;
        $reason = strtolower(trim((string)($entry['reason'] ?? '')));
        if (!in_array($reason, ['stripe_checkout_paid', 'stripe_auto_topup'], true)) continue;
        $meta = is_array($entry['meta'] ?? null) ? $entry['meta'] : [];
        if (isset($meta['paid_dollars']) && is_numeric($meta['paid_dollars'])) {
            $total += (float)$meta['paid_dollars'];
        } elseif (isset($meta['amount_total']) && is_numeric($meta['amount_total'])) {
            $total += ((float)$meta['amount_total']) / 100;
        } elseif (isset($meta['amount_cents']) && is_numeric($meta['amount_cents'])) {
            $total += ((float)$meta['amount_cents']) / 100;
        }
    }
    return referralMoneyAmount($total);
}

function referralEventTypeNormalize($eventType) {
    $eventType = strtolower(trim((string)$eventType));
    $eventType = preg_replace('/[^a-z0-9_]/', '_', $eventType);
    $allowed = ['offer_impression', 'modal_open', 'copy_link', 'share_click'];
    return in_array($eventType, $allowed, true) ? $eventType : '';
}

function referralTrackEvent($partnerId, $codeId, $actorEmail, $actorOrgId, $eventType, $metadata = []) {
    $partnerId = trim((string)$partnerId);
    $codeId = trim((string)$codeId);
    $actorEmail = strtolower(trim((string)$actorEmail));
    $actorOrgId = orgNormalizeId($actorOrgId);
    $eventType = referralEventTypeNormalize($eventType);
    if ($partnerId === '' || $eventType === '') return ['success' => false, 'error' => 'bad_event'];
    $db = referralDb();
    $id = 'refevent_' . genHexId(12);
    $now = referralNowIso();
    $meta = is_array($metadata) ? $metadata : [];
    $stmt = @$db->prepare("
        INSERT INTO referral_events (
            id, partner_id, code_id, actor_email, actor_org_id, event_type, event_count,
            first_seen_at, last_seen_at, metadata_json
        ) VALUES (
            :id, :partner_id, :code_id, :actor_email, :actor_org_id, :event_type, 1,
            :now, :now, :metadata_json
        )
        ON CONFLICT(partner_id, actor_email, actor_org_id, event_type) DO UPDATE SET
            event_count = event_count + 1,
            last_seen_at = excluded.last_seen_at,
            code_id = excluded.code_id,
            metadata_json = excluded.metadata_json
    ");
    if (!$stmt) return ['success' => false, 'error' => 'prepare_failed'];
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':partner_id', $partnerId, SQLITE3_TEXT);
    $stmt->bindValue(':code_id', $codeId, SQLITE3_TEXT);
    $stmt->bindValue(':actor_email', $actorEmail, SQLITE3_TEXT);
    $stmt->bindValue(':actor_org_id', $actorOrgId, SQLITE3_TEXT);
    $stmt->bindValue(':event_type', $eventType, SQLITE3_TEXT);
    $stmt->bindValue(':now', $now, SQLITE3_TEXT);
    $stmt->bindValue(':metadata_json', json_encode($meta, JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    @$stmt->execute();
    return ['success' => true];
}

function referralEventStatsForPartner($partnerId) {
    $partnerId = trim((string)$partnerId);
    $stats = [
        'offer_impression' => 0,
        'modal_open' => 0,
        'copy_link' => 0,
        'share_click' => 0,
    ];
    if ($partnerId === '') return $stats;
    $db = referralDb();
    $stmt = @$db->prepare("SELECT event_type, SUM(event_count) AS total_count FROM referral_events WHERE partner_id = :partner_id GROUP BY event_type");
    if (!$stmt) return $stats;
    $stmt->bindValue(':partner_id', $partnerId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $type = referralEventTypeNormalize($row['event_type'] ?? '');
        if ($type !== '') $stats[$type] = (int)($row['total_count'] ?? 0);
    }
    return $stats;
}

function referralDb() {
    static $db = null;
    if ($db instanceof SQLite3) return $db;
    $db = new SQLite3(referralDbPath());
    $db->busyTimeout(5000);
    referralEnsureSchema($db);
    return $db;
}

function referralNowIso() {
    return gmdate('c');
}

function referralActorEmail() {
    return strtolower(trim((string)($_SESSION['user_email'] ?? '')));
}

function referralNormalizeType($value) {
    $type = strtolower(trim((string)$value));
    $type = preg_replace('/[^a-z0-9_]/', '_', $type);
    if ($type === '') $type = 'manufacturer_rep';
    return $type;
}

function referralNormalizeStatus($value) {
    $status = strtolower(trim((string)$value));
    return in_array($status, ['active', 'archived', 'disabled'], true) ? $status : 'active';
}

function referralTypeLabel($type) {
    $type = referralNormalizeType($type);
    if ($type === 'customer_user') return 'Customer / User';
    if ($type === 'manufacturer_rep') return 'Manufacturer / Rep';
    return ucwords(str_replace('_', ' ', $type));
}

function referralEnsureOrgDefaults(&$o) {
    if (!is_array($o)) $o = [];
    if (!isset($o['referral']) || !is_array($o['referral'])) $o['referral'] = [];
    $o['referral']['attribution_id'] = (string)($o['referral']['attribution_id'] ?? '');
    $o['referral']['partner_id'] = (string)($o['referral']['partner_id'] ?? '');
    $o['referral']['partner_type'] = (string)($o['referral']['partner_type'] ?? '');
    $o['referral']['partner_name'] = (string)($o['referral']['partner_name'] ?? '');
    $o['referral']['code'] = (string)($o['referral']['code'] ?? '');
    $o['referral']['campaign_type'] = (string)($o['referral']['campaign_type'] ?? '');
    $o['referral']['landing_variant'] = (string)($o['referral']['landing_variant'] ?? '');
    $o['referral']['new_org_offer_id'] = (string)($o['referral']['new_org_offer_id'] ?? '');
    $o['referral']['referred_at'] = (string)($o['referral']['referred_at'] ?? '');
}

function referralDefaultCodeConfig($partnerType) {
    $partnerType = referralNormalizeType($partnerType);
    if ($partnerType === 'customer_user') {
        return [
            'campaign_type' => 'customer_referral',
            'landing_variant' => 'customer_invite',
            'new_org_offer_id' => '',
            'referrer_reward_policy_id' => 'customer_referral_reward_v1',
        ];
    }
    return [
        'campaign_type' => 'manufacturer_referral',
        'landing_variant' => 'manufacturer_invite',
        'new_org_offer_id' => 'referral_week_discount_v1',
        'referrer_reward_policy_id' => '',
    ];
}

function referralGenerateCodeBase($displayName) {
    $slug = strtoupper((string)$displayName);
    $slug = preg_replace('/[^A-Z0-9]+/', '-', $slug);
    $slug = trim((string)$slug, '-');
    if ($slug === '') $slug = 'PARTNER';
    if (strlen($slug) > 18) $slug = substr($slug, 0, 18);
    return $slug;
}

function referralGenerateUniqueCode($displayName) {
    $db = referralDb();
    $base = referralGenerateCodeBase($displayName);
    for ($i = 0; $i < 40; $i++) {
        $suffix = strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
        $code = $base . '-' . $suffix;
        $stmt = @$db->prepare("SELECT id FROM referral_codes WHERE code = :code LIMIT 1");
        if (!$stmt) continue;
        $stmt->bindValue(':code', $code, SQLITE3_TEXT);
        $res = @$stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (!is_array($row)) return $code;
    }
    return $base . '-' . strtoupper(substr(genHexId(6), 0, 6));
}

function referralLogoDir() {
    $dir = storageDir('meta/referrals/partner_logos');
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function referralPublicLogoUrl($relativeOrUrl) {
    $raw = trim((string)$relativeOrUrl);
    if ($raw === '') return '';
    if (preg_match('/^(https?:|data:|blob:|\/)/i', $raw)) return $raw;
    return '/measure/internal/' . ltrim($raw, '/');
}

function referralSaveUploadedLogo($fileInfo) {
    if (!is_array($fileInfo) || (($fileInfo['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK)) return '';
    $tmp = (string)($fileInfo['tmp_name'] ?? '');
    if ($tmp === '' || !is_file($tmp)) return '';
    $name = (string)($fileInfo['name'] ?? 'logo');
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $allowed = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
    if (!in_array($ext, $allowed, true)) return '';
    $targetName = 'partner_logo_' . strtolower(genHexId(12)) . '.' . $ext;
    $targetPath = referralLogoDir() . $targetName;
    if (!@move_uploaded_file($tmp, $targetPath)) {
        if (!@copy($tmp, $targetPath)) return '';
    }
    return 'meta/referrals/partner_logos/' . $targetName;
}

function referralPartnerHydrate($row) {
    $row = is_array($row) ? $row : [];
    $meta = json_decode((string)($row['metadata_json'] ?? '{}'), true);
    if (!is_array($meta)) $meta = [];
    $type = referralNormalizeType($row['type'] ?? '');
    return [
        'id' => (string)($row['id'] ?? ''),
        'type' => $type,
        'type_label' => referralTypeLabel($type),
        'status' => referralNormalizeStatus($row['status'] ?? ''),
        'display_name' => (string)($row['display_name'] ?? ''),
        'company_name' => (string)($row['company_name'] ?? ''),
        'contact_name' => (string)($row['contact_name'] ?? ''),
        'contact_email' => (string)($row['contact_email'] ?? ''),
        'contact_phone' => (string)($row['contact_phone'] ?? ''),
        'logo_path' => (string)($row['logo_path'] ?? ''),
        'logo_url' => referralPublicLogoUrl((string)($row['logo_path'] ?? ($row['logo_url'] ?? ''))),
        'notes' => (string)($row['notes'] ?? ''),
        'linked_user_email' => strtolower(trim((string)($row['linked_user_email'] ?? ''))),
        'linked_org_id' => orgNormalizeId($row['linked_org_id'] ?? ''),
        'metadata' => $meta,
        'created_at' => (string)($row['created_at'] ?? ''),
        'updated_at' => (string)($row['updated_at'] ?? ''),
        'created_by_email' => (string)($row['created_by_email'] ?? ''),
        'updated_by_email' => (string)($row['updated_by_email'] ?? ''),
    ];
}

function referralCodeHydrate($row) {
    $row = is_array($row) ? $row : [];
    $meta = json_decode((string)($row['metadata_json'] ?? '{}'), true);
    if (!is_array($meta)) $meta = [];
    return [
        'id' => (string)($row['id'] ?? ''),
        'partner_id' => (string)($row['partner_id'] ?? ''),
        'code' => strtoupper(trim((string)($row['code'] ?? ''))),
        'label' => (string)($row['label'] ?? 'Primary'),
        'campaign_type' => (string)($row['campaign_type'] ?? ''),
        'landing_variant' => (string)($row['landing_variant'] ?? ''),
        'new_org_offer_id' => (string)($row['new_org_offer_id'] ?? ''),
        'referrer_reward_policy_id' => (string)($row['referrer_reward_policy_id'] ?? ''),
        'active' => !empty($row['active']),
        'is_primary' => !empty($row['is_primary']),
        'landing_views' => (int)($row['landing_views'] ?? 0),
        'last_viewed_at' => (string)($row['last_viewed_at'] ?? ''),
        'metadata' => $meta,
        'created_at' => (string)($row['created_at'] ?? ''),
        'updated_at' => (string)($row['updated_at'] ?? ''),
    ];
}

function referralPartnerGet($partnerId) {
    $partnerId = trim((string)$partnerId);
    if ($partnerId === '') return null;
    $db = referralDb();
    $stmt = @$db->prepare("SELECT * FROM referral_partners WHERE id = :id LIMIT 1");
    if (!$stmt) return null;
    $stmt->bindValue(':id', $partnerId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) ? referralPartnerHydrate($row) : null;
}

function referralPartnerFindLikelyDuplicate($type, $displayName, $companyName, $contactName, $contactEmail, $excludeId = '') {
    $type = referralNormalizeType($type);
    $displayName = trim((string)$displayName);
    $companyName = trim((string)$companyName);
    $contactName = trim((string)$contactName);
    $contactEmail = strtolower(trim((string)$contactEmail));
    if ($displayName === '') return null;
    $db = referralDb();
    $stmt = @$db->prepare("
        SELECT id
        FROM referral_partners
        WHERE type = :type
          AND LOWER(TRIM(display_name)) = LOWER(TRIM(:display_name))
          AND LOWER(TRIM(company_name)) = LOWER(TRIM(:company_name))
          AND LOWER(TRIM(contact_name)) = LOWER(TRIM(:contact_name))
          AND LOWER(TRIM(contact_email)) = LOWER(TRIM(:contact_email))
          AND (:exclude_id = '' OR id <> :exclude_id)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':type', $type, SQLITE3_TEXT);
    $stmt->bindValue(':display_name', $displayName, SQLITE3_TEXT);
    $stmt->bindValue(':company_name', $companyName, SQLITE3_TEXT);
    $stmt->bindValue(':contact_name', $contactName, SQLITE3_TEXT);
    $stmt->bindValue(':contact_email', $contactEmail, SQLITE3_TEXT);
    $stmt->bindValue(':exclude_id', trim((string)$excludeId), SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    if (!is_array($row) || empty($row['id'])) return null;
    return referralPartnerGet((string)$row['id']);
}

function referralPartnerPrimaryCode($partnerId) {
    $partnerId = trim((string)$partnerId);
    if ($partnerId === '') return null;
    $db = referralDb();
    $stmt = @$db->prepare("
        SELECT * FROM referral_codes
        WHERE partner_id = :partner_id
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':partner_id', $partnerId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) ? referralCodeHydrate($row) : null;
}

function referralCodeByCode($code, $requireActive = false) {
    $code = strtoupper(trim((string)$code));
    if ($code === '') return null;
    $db = referralDb();
    $sql = "SELECT * FROM referral_codes WHERE code = :code";
    if ($requireActive) $sql .= " AND active = 1";
    $sql .= " LIMIT 1";
    $stmt = @$db->prepare($sql);
    if (!$stmt) return null;
    $stmt->bindValue(':code', $code, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) ? referralCodeHydrate($row) : null;
}

function referralPartnerStatsMap() {
    $db = referralDb();
    $map = [];
    $res = @$db->query("
        SELECT
            partner_id,
            COUNT(1) AS total_views,
            SUM(CASE WHEN signup_completed_at <> '' THEN 1 ELSE 0 END) AS total_signups
        FROM referral_attributions
        GROUP BY partner_id
    ");
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $map[(string)($row['partner_id'] ?? '')] = [
            'total_views' => (int)($row['total_views'] ?? 0),
            'total_signups' => (int)($row['total_signups'] ?? 0),
        ];
    }
    return $map;
}

function referralPartnerList() {
    $db = referralDb();
    $stats = referralPartnerStatsMap();
    $items = [];
    $res = @$db->query("SELECT * FROM referral_partners ORDER BY updated_at DESC, created_at DESC");
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $partner = referralPartnerHydrate($row);
        $primaryCode = referralPartnerPrimaryCode($partner['id']);
        $partner['primary_code'] = $primaryCode;
        $partner['stats'] = $stats[$partner['id']] ?? ['total_views' => 0, 'total_signups' => 0];
        $partner['event_stats'] = referralEventStatsForPartner($partner['id']);
        $items[] = $partner;
    }
    return $items;
}

function referralBasePortalSignupUrl() {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
    return $scheme . '://' . $host . '/portal/login.php?start=register';
}

function referralPartnerLinkForCode($code) {
    $code = strtoupper(trim((string)$code));
    return referralBasePortalSignupUrl() . '&ref=' . rawurlencode($code);
}

function referralPartnerCreatePrimaryCode($partner, $override = []) {
    $partner = is_array($partner) ? $partner : [];
    $partnerId = trim((string)($partner['id'] ?? ''));
    if ($partnerId === '') return null;
    $db = referralDb();
    $now = referralNowIso();
    $defaults = referralDefaultCodeConfig($partner['type'] ?? '');
    $payload = array_merge($defaults, is_array($override) ? $override : []);
    $code = referralGenerateUniqueCode($partner['display_name'] ?? 'Partner');
    $id = 'refcode_' . genHexId(12);
    $stmt = @$db->prepare("
        INSERT INTO referral_codes (
            id, partner_id, code, label, campaign_type, landing_variant, new_org_offer_id,
            referrer_reward_policy_id, active, is_primary, landing_views, last_viewed_at,
            created_at, updated_at, created_by_email, updated_by_email, metadata_json
        ) VALUES (
            :id, :partner_id, :code, :label, :campaign_type, :landing_variant, :new_org_offer_id,
            :referrer_reward_policy_id, 1, 1, 0, '', :created_at, :updated_at, :created_by_email,
            :updated_by_email, :metadata_json
        )
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':partner_id', $partnerId, SQLITE3_TEXT);
    $stmt->bindValue(':code', $code, SQLITE3_TEXT);
    $stmt->bindValue(':label', 'Primary', SQLITE3_TEXT);
    $stmt->bindValue(':campaign_type', (string)($payload['campaign_type'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':landing_variant', (string)($payload['landing_variant'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':new_org_offer_id', (string)($payload['new_org_offer_id'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':referrer_reward_policy_id', (string)($payload['referrer_reward_policy_id'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':created_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':created_by_email', referralActorEmail(), SQLITE3_TEXT);
    $stmt->bindValue(':updated_by_email', referralActorEmail(), SQLITE3_TEXT);
    $stmt->bindValue(':metadata_json', json_encode([], JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    @$stmt->execute();
    return referralCodeByCode($code, false);
}

function referralManagerAccessAllowed() {
    $email = referralActorEmail();
    if ($email === '') return false;
    if (!empty($_SESSION['user_is_admin'])) return true;
    if (function_exists('userHasSalesPermission')) {
        return userHasSalesPermission($email, 'manage_sales_users', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
    }
    return false;
}

function referralRequireManagerAccess() {
    if (!referralManagerAccessAllowed()) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Not authorized']);
        exit;
    }
}

function referralInvitationCopy($partner, $code) {
    $partner = is_array($partner) ? $partner : [];
    $code = is_array($code) ? $code : [];
    $name = trim((string)($partner['display_name'] ?? 'A referral partner'));
    $type = referralNormalizeType($partner['type'] ?? '');
    $offerId = trim((string)($code['new_org_offer_id'] ?? ''));
    $headline = $name . ' has invited you to try FirstMate.';
    $subheadline = $type === 'customer_user'
        ? 'Create your account to get started with FirstMate.'
        : 'Create your account to get started with FirstMate through this partner invitation.';
    $offer = null;
    if ($offerId === 'referral_week_discount_v1') {
        $offer = [
            'offer_id' => $offerId,
            'label' => '50% off for your first 7 days',
            'description' => 'Get 50% off report orders for the first 7 days after you create your account.',
            'discount_percent' => 50,
            'window_days' => 7,
        ];
    }
    return [
        'headline' => $headline,
        'subheadline' => $subheadline,
        'offer' => $offer,
    ];
}

function referralAttributionCreateViewed($partner, $code) {
    $partner = is_array($partner) ? $partner : [];
    $code = is_array($code) ? $code : [];
    $partnerId = trim((string)($partner['id'] ?? ''));
    $codeId = trim((string)($code['id'] ?? ''));
    if ($partnerId === '' || $codeId === '') return '';
    $db = referralDb();
    $id = 'refattr_' . genHexId(12);
    $now = referralNowIso();
    $snapshot = [
        'partner' => [
            'id' => $partnerId,
            'type' => (string)($partner['type'] ?? ''),
            'display_name' => (string)($partner['display_name'] ?? ''),
        ],
        'code' => [
            'id' => $codeId,
            'code' => (string)($code['code'] ?? ''),
            'campaign_type' => (string)($code['campaign_type'] ?? ''),
            'landing_variant' => (string)($code['landing_variant'] ?? ''),
            'new_org_offer_id' => (string)($code['new_org_offer_id'] ?? ''),
        ],
    ];
    $stmt = @$db->prepare("
        INSERT INTO referral_attributions (
            id, code_id, partner_id, referred_org_id, referred_email, status,
            clicked_at, signup_started_at, signup_completed_at, offer_started_at,
            ip_address, user_agent, snapshot_json, created_at, updated_at
        ) VALUES (
            :id, :code_id, :partner_id, '', '', 'viewed',
            :clicked_at, '', '', '', :ip_address, :user_agent, :snapshot_json, :created_at, :updated_at
        )
    ");
    if (!$stmt) return '';
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':code_id', $codeId, SQLITE3_TEXT);
    $stmt->bindValue(':partner_id', $partnerId, SQLITE3_TEXT);
    $stmt->bindValue(':clicked_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':ip_address', (string)($_SERVER['REMOTE_ADDR'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':user_agent', (string)($_SERVER['HTTP_USER_AGENT'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':snapshot_json', json_encode($snapshot, JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    $stmt->bindValue(':created_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    @$stmt->execute();
    return $id;
}

function referralCodeMarkViewed($codeId) {
    $codeId = trim((string)$codeId);
    if ($codeId === '') return;
    $db = referralDb();
    $stmt = @$db->prepare("
        UPDATE referral_codes
        SET landing_views = COALESCE(landing_views, 0) + 1,
            last_viewed_at = :last_viewed_at,
            updated_at = :updated_at
        WHERE id = :id
    ");
    if (!$stmt) return;
    $now = referralNowIso();
    $stmt->bindValue(':last_viewed_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':id', $codeId, SQLITE3_TEXT);
    @$stmt->execute();
}

function referralPublicLookup($codeValue) {
    $code = referralCodeByCode($codeValue, true);
    if (!$code) return ['success' => false, 'error' => 'Referral link not found.'];
    $partner = referralPartnerGet($code['partner_id']);
    if (!$partner || $partner['status'] !== 'active') {
        return ['success' => false, 'error' => 'Referral partner is not active.'];
    }
    referralCodeMarkViewed($code['id']);
    $attributionId = referralAttributionCreateViewed($partner, $code);
    $copy = referralInvitationCopy($partner, $code);
    return [
        'success' => true,
        'partner' => $partner,
        'code' => $code,
        'attribution_id' => $attributionId,
        'headline' => $copy['headline'],
        'subheadline' => $copy['subheadline'],
        'offer' => $copy['offer'],
        'signup_url' => referralPartnerLinkForCode($code['code']),
    ];
}

function referralFindAttributionByOrgId($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    $db = referralDb();
    $stmt = @$db->prepare("SELECT * FROM referral_attributions WHERE referred_org_id = :org_id LIMIT 1");
    if (!$stmt) return null;
    $stmt->bindValue(':org_id', $orgId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) ? $row : null;
}

function referralOrgAttributionFields($partner) {
    $partner = is_array($partner) ? $partner : [];
    $type = referralNormalizeType($partner['type'] ?? '');
    $referrerUserEmail = '';
    $referrerOrgId = '';
    $referralSdrEmail = '';

    if ($type === 'customer_user') {
        $referrerUserEmail = strtolower(trim((string)($partner['linked_user_email'] ?? $partner['contact_email'] ?? '')));
        $referrerOrgId = orgNormalizeId($partner['linked_org_id'] ?? '');
        if ($referrerOrgId !== '' && function_exists('orgRead')) {
            $referrerOrg = orgRead($referrerOrgId);
            if (is_array($referrerOrg)) {
                $referralSdrEmail = strtolower(trim((string)(
                    $referrerOrg['assigned_sales_email']
                    ?? $referrerOrg['commission_signup_owner_email']
                    ?? ''
                )));
            }
        }
    }

    return [
        'referral_source_type' => $type === 'customer_user' ? 'customer_referral' : 'partner_referral',
        'referrer_user_email' => $referrerUserEmail,
        'referrer_org_id' => $referrerOrgId,
        'referral_sdr_email' => $referralSdrEmail,
    ];
}

function referralStampOrgSummary($orgId, $partner, $code, $attributionId, $claimedOfferId = '') {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return;
    $o = orgRead($orgId);
    if (!is_array($o)) return;
    referralEnsureOrgDefaults($o);
    $attributionFields = referralOrgAttributionFields($partner);
    $o['referral'] = array_merge($o['referral'], [
        'attribution_id' => (string)$attributionId,
        'partner_id' => (string)($partner['id'] ?? ''),
        'partner_type' => (string)($partner['type'] ?? ''),
        'partner_name' => (string)($partner['display_name'] ?? ''),
        'referral_source_type' => $attributionFields['referral_source_type'],
        'referrer_user_email' => $attributionFields['referrer_user_email'],
        'referrer_org_id' => $attributionFields['referrer_org_id'],
        'referral_sdr_email' => $attributionFields['referral_sdr_email'],
        'code' => (string)($code['code'] ?? ''),
        'campaign_type' => (string)($code['campaign_type'] ?? ''),
        'landing_variant' => (string)($code['landing_variant'] ?? ''),
        'new_org_offer_id' => $claimedOfferId !== '' ? $claimedOfferId : (string)($code['new_org_offer_id'] ?? ''),
        'referred_at' => referralNowIso(),
    ]);
    if ($attributionFields['referrer_user_email'] !== '') {
        $o['referred_by_user_email'] = $attributionFields['referrer_user_email'];
    }
    if ($attributionFields['referrer_org_id'] !== '') {
        $o['referred_by_org_id'] = $attributionFields['referrer_org_id'];
    }
    if ($attributionFields['referral_sdr_email'] !== '') {
        $o['referrer_sdr_email'] = $attributionFields['referral_sdr_email'];
    }
    orgWrite($orgId, $o);
}

function referralFinalizeSignupAttribution($orgId, $email, $codeValue, $attributionId = '', $context = []) {
    $orgId = orgNormalizeId($orgId);
    $email = strtolower(trim((string)$email));
    $codeValue = strtoupper(trim((string)$codeValue));
    $attributionId = trim((string)$attributionId);
    if ($orgId === '' || $email === '' || $codeValue === '') return ['success' => false, 'error' => 'missing_referral_inputs'];

    $existing = referralFindAttributionByOrgId($orgId);
    if (is_array($existing)) {
        return ['success' => true, 'already_linked' => true, 'attribution_id' => (string)($existing['id'] ?? '')];
    }

    $code = referralCodeByCode($codeValue, true);
    if (!$code) return ['success' => false, 'error' => 'invalid_referral_code'];
    $partner = referralPartnerGet($code['partner_id']);
    if (!$partner) return ['success' => false, 'error' => 'invalid_referral_partner'];

    $db = referralDb();
    $row = null;
    if ($attributionId !== '') {
        $stmt = @$db->prepare("
            SELECT * FROM referral_attributions
            WHERE id = :id AND code_id = :code_id AND partner_id = :partner_id
            LIMIT 1
        ");
        if ($stmt) {
            $stmt->bindValue(':id', $attributionId, SQLITE3_TEXT);
            $stmt->bindValue(':code_id', $code['id'], SQLITE3_TEXT);
            $stmt->bindValue(':partner_id', $partner['id'], SQLITE3_TEXT);
            $res = @$stmt->execute();
            $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        }
    }
    if (!is_array($row)) {
        $attributionId = referralAttributionCreateViewed($partner, $code);
        $stmt = @$db->prepare("SELECT * FROM referral_attributions WHERE id = :id LIMIT 1");
        if ($stmt) {
            $stmt->bindValue(':id', $attributionId, SQLITE3_TEXT);
            $res = @$stmt->execute();
            $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        }
    }
    if (!is_array($row)) return ['success' => false, 'error' => 'attribution_create_failed'];

    $claimOfferId = trim((string)($code['new_org_offer_id'] ?? ''));
    $offerStartedAt = '';
    if ($claimOfferId === 'referral_week_discount_v1') {
        $claim = orgOfferClaim($orgId, 'referral_week_discount_v1', [
            'source' => 'referral_signup',
            'referrer_id' => (string)$partner['id'],
            'referrer_name' => (string)$partner['display_name'],
            'referrer_type' => (string)$partner['type'],
            'referral_code' => (string)$code['code'],
            'attribution_id' => (string)$attributionId,
            'discount_percent' => 50,
            'window_days' => 7,
        ]);
        if (!empty($claim['success']) && is_array($claim['offer'] ?? null)) {
            $offerStartedAt = (string)($claim['offer']['starts_at'] ?? '');
        }
    }

    $snapshot = [
        'partner' => [
            'id' => (string)$partner['id'],
            'type' => (string)$partner['type'],
            'display_name' => (string)$partner['display_name'],
        ],
        'code' => [
            'id' => (string)$code['id'],
            'code' => (string)$code['code'],
            'campaign_type' => (string)$code['campaign_type'],
            'landing_variant' => (string)$code['landing_variant'],
            'new_org_offer_id' => (string)$code['new_org_offer_id'],
            'referrer_reward_policy_id' => (string)$code['referrer_reward_policy_id'],
        ],
        'signup' => [
            'organization_id' => $orgId,
            'email' => $email,
            'name' => (string)($context['name'] ?? ''),
            'company' => (string)($context['company'] ?? ''),
            'manual_attached' => !empty($context['manual_attached']),
            'manual_note' => (string)($context['manual_note'] ?? ''),
            'manual_actor_email' => (string)($context['manual_actor_email'] ?? ''),
        ],
    ];
    $now = referralNowIso();
    $stmt = @$db->prepare("
        UPDATE referral_attributions
        SET referred_org_id = :referred_org_id,
            referred_email = :referred_email,
            status = 'signup_completed',
            signup_started_at = CASE WHEN signup_started_at = '' THEN :signup_started_at ELSE signup_started_at END,
            signup_completed_at = :signup_completed_at,
            offer_started_at = :offer_started_at,
            snapshot_json = :snapshot_json,
            updated_at = :updated_at
        WHERE id = :id
    ");
    if (!$stmt) return ['success' => false, 'error' => 'attribution_update_failed'];
    $stmt->bindValue(':referred_org_id', $orgId, SQLITE3_TEXT);
    $stmt->bindValue(':referred_email', $email, SQLITE3_TEXT);
    $stmt->bindValue(':signup_started_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':signup_completed_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':offer_started_at', $offerStartedAt, SQLITE3_TEXT);
    $stmt->bindValue(':snapshot_json', json_encode($snapshot, JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':id', $attributionId, SQLITE3_TEXT);
    @$stmt->execute();

    referralStampOrgSummary($orgId, $partner, $code, $attributionId, $claimOfferId);

    return [
        'success' => true,
        'attribution_id' => $attributionId,
        'partner' => $partner,
        'code' => $code,
        'offer_started_at' => $offerStartedAt,
    ];
}

function referralRewardLedgerFind($attributionId, $rewardType = '') {
    $attributionId = trim((string)$attributionId);
    if ($attributionId === '') return null;
    $db = referralDb();
    $sql = "SELECT * FROM referral_reward_ledger WHERE attribution_id = :attribution_id";
    if (trim((string)$rewardType) !== '') $sql .= " AND reward_type = :reward_type";
    $sql .= " ORDER BY created_at DESC LIMIT 1";
    $stmt = @$db->prepare($sql);
    if (!$stmt) return null;
    $stmt->bindValue(':attribution_id', $attributionId, SQLITE3_TEXT);
    if (trim((string)$rewardType) !== '') $stmt->bindValue(':reward_type', trim((string)$rewardType), SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return is_array($row) ? $row : null;
}

function referralRewardHydrate($row) {
    if (!is_array($row)) return null;
    $meta = json_decode((string)($row['metadata_json'] ?? '{}'), true);
    if (!is_array($meta)) $meta = [];
    return [
        'id' => (string)($row['id'] ?? ''),
        'partner_id' => (string)($row['partner_id'] ?? ''),
        'attribution_id' => (string)($row['attribution_id'] ?? ''),
        'reward_type' => (string)($row['reward_type'] ?? ''),
        'amount' => referralMoneyAmount($row['amount'] ?? 0),
        'status' => (string)($row['status'] ?? 'pending'),
        'created_at' => (string)($row['created_at'] ?? ''),
        'applied_at' => (string)($row['applied_at'] ?? ''),
        'metadata' => $meta,
    ];
}

function referralRewardStatusNormalize($status) {
    $status = strtolower(trim((string)$status));
    return in_array($status, ['pending', 'approved', 'sent', 'void'], true) ? $status : 'pending';
}

function referralRewardPublicSummary($reward, $context = []) {
    $reward = is_array($reward) ? $reward : [];
    $meta = is_array($reward['metadata'] ?? null) ? $reward['metadata'] : [];
    return [
        'id' => (string)($reward['id'] ?? ''),
        'reward_type' => (string)($reward['reward_type'] ?? ''),
        'amount' => referralMoneyAmount($reward['amount'] ?? 0),
        'currency' => (string)($meta['currency'] ?? 'usd'),
        'status' => referralRewardStatusNormalize($reward['status'] ?? 'pending'),
        'created_at' => (string)($reward['created_at'] ?? ''),
        'applied_at' => (string)($reward['applied_at'] ?? ''),
        'policy_id' => (string)($meta['policy_id'] ?? ''),
        'threshold_paid_revenue' => referralMoneyAmount($meta['threshold_paid_revenue'] ?? 0),
        'qualified_paid_revenue' => referralMoneyAmount($context['qualified_paid_revenue'] ?? ($meta['qualified_paid_revenue'] ?? 0)),
        'referred_org_id' => orgNormalizeId($meta['referred_org_id'] ?? ($context['referred_org_id'] ?? '')),
        'referred_org_name' => (string)($context['referred_org_name'] ?? ($meta['referred_org_name'] ?? '')),
        'referred_email' => strtolower(trim((string)($context['referred_email'] ?? ($meta['referred_email'] ?? '')))),
    ];
}

function referralSyncPartnerUserRewards($partnerId) {
    $partner = referralPartnerGet($partnerId);
    if (!$partner) return;
    $email = strtolower(trim((string)($partner['linked_user_email'] ?? '')));
    if ($email === '' || !function_exists('readUserDataByEmail') || !function_exists('writeUserDataByEmail')) return;
    $user = readUserDataByEmail($email);
    if (!is_array($user)) return;
    $db = referralDb();
    $stmt = @$db->prepare("
        SELECT r.*, a.referred_org_id, a.referred_email
        FROM referral_reward_ledger r
        LEFT JOIN referral_attributions a ON a.id = r.attribution_id
        WHERE r.partner_id = :partner_id
        ORDER BY r.created_at DESC
        LIMIT 100
    ");
    if (!$stmt) return;
    $stmt->bindValue(':partner_id', (string)$partnerId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $summaries = [];
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $orgId = orgNormalizeId($row['referred_org_id'] ?? '');
        $org = $orgId !== '' ? orgRead($orgId) : null;
        $reward = referralRewardHydrate($row);
        if (!$reward) continue;
        $summaries[] = referralRewardPublicSummary($reward, [
            'referred_org_id' => $orgId,
            'referred_org_name' => is_array($org) ? (string)($org['name'] ?? '') : '',
            'referred_email' => (string)($row['referred_email'] ?? ''),
            'qualified_paid_revenue' => referralQualifiedPaidRevenueForOrg($orgId),
        ]);
    }
    if (!isset($user['referral_rewards']) || !is_array($user['referral_rewards'])) $user['referral_rewards'] = [];
    $user['referral_rewards'] = [
        'updated_at' => referralNowIso(),
        'items' => $summaries,
    ];
    writeUserDataByEmail($email, $user);
}

function referralCreateRewardLedgerEntry($partner, $code, $attribution, $policy, $qualifiedRevenue) {
    $existing = referralRewardLedgerFind($attribution['id'] ?? '', $policy['reward_type'] ?? '');
    if (is_array($existing)) return referralRewardHydrate($existing);
    $db = referralDb();
    $id = 'refreward_' . genHexId(12);
    $now = referralNowIso();
    $orgId = orgNormalizeId($attribution['referred_org_id'] ?? '');
    $org = $orgId !== '' ? orgRead($orgId) : null;
    $metadata = [
        'policy_id' => (string)$policy['id'],
        'policy_label' => (string)$policy['label'],
        'threshold_paid_revenue' => referralMoneyAmount($policy['threshold_paid_revenue']),
        'qualified_paid_revenue' => referralMoneyAmount($qualifiedRevenue),
        'currency' => (string)($policy['currency'] ?? 'usd'),
        'fulfillment_method' => (string)($policy['fulfillment_method'] ?? 'manual'),
        'referred_org_id' => $orgId,
        'referred_org_name' => is_array($org) ? (string)($org['name'] ?? '') : '',
        'referred_email' => strtolower(trim((string)($attribution['referred_email'] ?? ''))),
        'referral_code' => (string)($code['code'] ?? ''),
        'partner_type' => (string)($partner['type'] ?? ''),
        'partner_name' => (string)($partner['display_name'] ?? ''),
        'linked_user_email' => strtolower(trim((string)($partner['linked_user_email'] ?? ''))),
    ];
    $stmt = @$db->prepare("
        INSERT INTO referral_reward_ledger (
            id, partner_id, attribution_id, reward_type, amount, status, created_at, applied_at, metadata_json
        ) VALUES (
            :id, :partner_id, :attribution_id, :reward_type, :amount, 'pending', :created_at, '', :metadata_json
        )
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':partner_id', (string)($partner['id'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':attribution_id', (string)($attribution['id'] ?? ''), SQLITE3_TEXT);
    $stmt->bindValue(':reward_type', (string)$policy['reward_type'], SQLITE3_TEXT);
    $stmt->bindValue(':amount', (float)$policy['reward_amount'], SQLITE3_FLOAT);
    $stmt->bindValue(':created_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':metadata_json', json_encode($metadata, JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    @$stmt->execute();
    $reward = referralRewardLedgerFind($attribution['id'] ?? '', $policy['reward_type'] ?? '');
    referralSyncPartnerUserRewards($partner['id'] ?? '');
    return referralRewardHydrate($reward);
}

function referralEvaluateRewardsForOrg($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return ['success' => false, 'error' => 'missing_org'];
    $attr = referralFindAttributionByOrgId($orgId);
    if (!is_array($attr)) return ['success' => true, 'eligible' => false, 'reason' => 'no_referral_attribution'];
    $codeId = trim((string)($attr['code_id'] ?? ''));
    $db = referralDb();
    $stmt = @$db->prepare("SELECT * FROM referral_codes WHERE id = :id LIMIT 1");
    if (!$stmt) return ['success' => false, 'error' => 'code_lookup_failed'];
    $stmt->bindValue(':id', $codeId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $codeRow = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    $code = is_array($codeRow) ? referralCodeHydrate($codeRow) : null;
    if (!$code) return ['success' => true, 'eligible' => false, 'reason' => 'missing_referral_code'];
    $policy = referralRewardPolicyDefinition($code['referrer_reward_policy_id'] ?? '');
    if (!$policy) return ['success' => true, 'eligible' => false, 'reason' => 'no_reward_policy'];
    $partner = referralPartnerGet($code['partner_id']);
    if (!$partner) return ['success' => false, 'error' => 'missing_partner'];
    $qualifiedRevenue = referralQualifiedPaidRevenueForOrg($orgId);
    $existing = referralRewardLedgerFind($attr['id'], $policy['reward_type']);
    if ($qualifiedRevenue < (float)$policy['threshold_paid_revenue']) {
        return [
            'success' => true,
            'eligible' => false,
            'reason' => 'below_threshold',
            'qualified_paid_revenue' => $qualifiedRevenue,
            'threshold_paid_revenue' => referralMoneyAmount($policy['threshold_paid_revenue']),
            'reward' => referralRewardHydrate($existing),
        ];
    }
    $reward = is_array($existing)
        ? referralRewardHydrate($existing)
        : referralCreateRewardLedgerEntry($partner, $code, $attr, $policy, $qualifiedRevenue);
    return [
        'success' => true,
        'eligible' => true,
        'qualified_paid_revenue' => $qualifiedRevenue,
        'threshold_paid_revenue' => referralMoneyAmount($policy['threshold_paid_revenue']),
        'reward' => $reward,
    ];
}

function referralEvaluateAllRewards() {
    $db = referralDb();
    $res = @$db->query("SELECT referred_org_id FROM referral_attributions WHERE referred_org_id <> ''");
    $count = 0;
    while ($res && ($row = $res->fetchArray(SQLITE3_ASSOC))) {
        $orgId = orgNormalizeId($row['referred_org_id'] ?? '');
        if ($orgId === '') continue;
        referralEvaluateRewardsForOrg($orgId);
        $count++;
    }
    return $count;
}

function referralRewardReportRows($evaluate = true) {
    if ($evaluate) referralEvaluateAllRewards();
    $db = referralDb();
    $rows = [];
    $res = @$db->query("
        SELECT a.*, c.code, c.campaign_type, c.referrer_reward_policy_id, p.type AS partner_type,
               p.display_name AS partner_name, p.contact_email, p.linked_user_email, p.linked_org_id
        FROM referral_attributions a
        LEFT JOIN referral_codes c ON c.id = a.code_id
        LEFT JOIN referral_partners p ON p.id = a.partner_id
        WHERE a.referred_org_id <> ''
        ORDER BY a.signup_completed_at DESC, a.updated_at DESC
    ");
    while ($res && ($attr = $res->fetchArray(SQLITE3_ASSOC))) {
        $policy = referralRewardPolicyDefinition($attr['referrer_reward_policy_id'] ?? '');
        $orgId = orgNormalizeId($attr['referred_org_id'] ?? '');
        $org = $orgId !== '' ? orgRead($orgId) : null;
        $qualifiedRevenue = referralQualifiedPaidRevenueForOrg($orgId);
        $reward = $policy ? referralRewardHydrate(referralRewardLedgerFind($attr['id'], $policy['reward_type'])) : null;
        $threshold = $policy ? referralMoneyAmount($policy['threshold_paid_revenue']) : 0.0;
        $status = 'no_policy';
        if ($policy) $status = $qualifiedRevenue >= $threshold ? ($reward['status'] ?? 'qualified') : 'tracking';
        $rows[] = [
            'attribution_id' => (string)($attr['id'] ?? ''),
            'partner_id' => (string)($attr['partner_id'] ?? ''),
            'partner_name' => (string)($attr['partner_name'] ?? ''),
            'partner_type' => (string)($attr['partner_type'] ?? ''),
            'referrer_email' => strtolower(trim((string)($attr['linked_user_email'] ?? ($attr['contact_email'] ?? '')))),
            'referral_code' => (string)($attr['code'] ?? ''),
            'referred_org_id' => $orgId,
            'referred_org_name' => is_array($org) ? (string)($org['name'] ?? '') : '',
            'referred_email' => strtolower(trim((string)($attr['referred_email'] ?? ''))),
            'signup_completed_at' => (string)($attr['signup_completed_at'] ?? ''),
            'policy_id' => (string)($attr['referrer_reward_policy_id'] ?? ''),
            'policy_label' => $policy ? (string)$policy['label'] : '',
            'qualified_paid_revenue' => $qualifiedRevenue,
            'threshold_paid_revenue' => $threshold,
            'progress_percent' => $threshold > 0 ? min(100, round(($qualifiedRevenue / $threshold) * 100, 1)) : 0,
            'status' => $status,
            'reward' => $reward,
            'event_stats' => referralEventStatsForPartner((string)($attr['partner_id'] ?? '')),
        ];
    }
    return $rows;
}

function referralRewardUpdateStatus($rewardId, $status) {
    $rewardId = trim((string)$rewardId);
    $status = referralRewardStatusNormalize($status);
    if ($rewardId === '') return ['success' => false, 'error' => 'Missing reward id'];
    $db = referralDb();
    $stmt = @$db->prepare("SELECT * FROM referral_reward_ledger WHERE id = :id LIMIT 1");
    if (!$stmt) return ['success' => false, 'error' => 'Reward lookup failed'];
    $stmt->bindValue(':id', $rewardId, SQLITE3_TEXT);
    $res = @$stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    if (!is_array($row)) return ['success' => false, 'error' => 'Reward not found'];
    $appliedAt = in_array($status, ['sent', 'void'], true) ? referralNowIso() : (string)($row['applied_at'] ?? '');
    $stmt = @$db->prepare("UPDATE referral_reward_ledger SET status = :status, applied_at = :applied_at WHERE id = :id");
    if (!$stmt) return ['success' => false, 'error' => 'Reward update failed'];
    $stmt->bindValue(':status', $status, SQLITE3_TEXT);
    $stmt->bindValue(':applied_at', $appliedAt, SQLITE3_TEXT);
    $stmt->bindValue(':id', $rewardId, SQLITE3_TEXT);
    @$stmt->execute();
    referralSyncPartnerUserRewards($row['partner_id'] ?? '');
    return ['success' => true, 'reward' => referralRewardHydrate(referralRewardLedgerFind($row['attribution_id'] ?? '', $row['reward_type'] ?? ''))];
}

function referralManualOrgSearch($query = '', $limit = 80) {
    $query = strtolower(trim((string)$query));
    $limit = max(10, min(150, (int)$limit));
    $rows = [];
    if (!function_exists('orgDirPath') || !function_exists('orgRead')) {
        return ['success' => false, 'error' => 'Organization tools are unavailable'];
    }
    $orgDirPath = orgDirPath();
    if (!is_dir($orgDirPath)) return ['success' => true, 'organizations' => []];

    foreach (scandir($orgDirPath) as $f) {
        if ($f === '.' || $f === '..') continue;
        $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($f) : trim((string)$f);
        if ($orgId === '') continue;
        $org = orgRead($orgId);
        if (!is_array($org)) continue;

        $contact = is_array($org['contact'] ?? null) ? $org['contact'] : [];
        $email = function_exists('orgResolveCreditEmail')
            ? orgResolveCreditEmail($org)
            : strtolower(trim((string)($contact['email'] ?? ($org['created_by_email'] ?? ''))));
        $phone = trim((string)($contact['phone'] ?? ''));
        $name = trim((string)($org['name'] ?? $orgId));
        $referral = is_array($org['referral'] ?? null) ? $org['referral'] : [];
        $hasReferral = trim((string)($referral['attribution_id'] ?? '')) !== ''
            || referralFindAttributionByOrgId($orgId) !== null;
        $hay = strtolower($name . ' ' . $email . ' ' . $phone . ' ' . $orgId);
        if ($query !== '' && strpos($hay, $query) === false) continue;

        $rows[] = [
            'id' => $orgId,
            'name' => $name !== '' ? $name : $orgId,
            'email' => $email,
            'phone' => $phone,
            'created_at' => (string)($org['created_at'] ?? ''),
            'is_test' => !empty($org['is_test']),
            'has_referral' => $hasReferral,
            'referral_partner_name' => (string)($referral['partner_name'] ?? ''),
            'referral_code' => (string)($referral['code'] ?? ''),
        ];
        if (count($rows) >= $limit) break;
    }

    usort($rows, function($a, $b) {
        return strcmp(strtolower((string)($a['name'] ?? '')), strtolower((string)($b['name'] ?? '')));
    });
    return ['success' => true, 'organizations' => $rows];
}

function referralManualAttachOrgToPartner($orgId, $partnerId, $note = '') {
    $orgId = function_exists('orgNormalizeId') ? orgNormalizeId($orgId) : trim((string)$orgId);
    $partnerId = trim((string)$partnerId);
    if ($orgId === '' || $partnerId === '') return ['success' => false, 'error' => 'Missing organization or referral partner'];
    if (!function_exists('orgRead')) return ['success' => false, 'error' => 'Organization tools are unavailable'];

    $existing = referralFindAttributionByOrgId($orgId);
    if (is_array($existing)) {
        return [
            'success' => false,
            'error' => 'This organization is already paired to a referral.',
            'attribution_id' => (string)($existing['id'] ?? ''),
        ];
    }

    $partner = referralPartnerGet($partnerId);
    if (!$partner) return ['success' => false, 'error' => 'Referral partner not found'];
    $code = referralPartnerPrimaryCode($partnerId);
    if (!$code || empty($code['active'])) return ['success' => false, 'error' => 'This partner does not have an active primary referral code'];

    $org = orgRead($orgId);
    if (!is_array($org)) return ['success' => false, 'error' => 'Organization not found'];
    $email = function_exists('orgResolveCreditEmail')
        ? orgResolveCreditEmail($org)
        : strtolower(trim((string)(($org['contact']['email'] ?? '') ?: ($org['created_by_email'] ?? ''))));
    if ($email === '') return ['success' => false, 'error' => 'This organization does not have a usable customer email'];

    $result = referralFinalizeSignupAttribution($orgId, $email, (string)$code['code'], '', [
        'name' => $email,
        'company' => (string)($org['name'] ?? ''),
        'manual_attached' => true,
        'manual_note' => trim((string)$note),
        'manual_actor_email' => referralActorEmail(),
    ]);
    if (empty($result['success'])) return $result;

    referralEvaluateRewardsForOrg($orgId);
    return array_merge($result, [
        'success' => true,
        'manual_attached' => true,
        'organization' => [
            'id' => $orgId,
            'name' => (string)($org['name'] ?? $orgId),
            'email' => $email,
        ],
        'partner' => $partner,
        'primary_code' => $code,
    ]);
}

function referralPartnerSaveFromRequest() {
    $id = trim((string)($_POST['id'] ?? ''));
    $type = referralNormalizeType($_POST['type'] ?? 'manufacturer_rep');
    $displayName = trim((string)($_POST['display_name'] ?? ''));
    $companyName = trim((string)($_POST['company_name'] ?? ''));
    $contactName = trim((string)($_POST['contact_name'] ?? ''));
    $contactEmail = strtolower(trim((string)($_POST['contact_email'] ?? '')));
    $contactPhone = trim((string)($_POST['contact_phone'] ?? ''));
    $notes = trim((string)($_POST['notes'] ?? ''));
    $linkedUserEmail = strtolower(trim((string)($_POST['linked_user_email'] ?? '')));
    $linkedOrgId = orgNormalizeId($_POST['linked_org_id'] ?? '');
    $status = referralNormalizeStatus($_POST['status'] ?? 'active');
    $logoUrl = trim((string)($_POST['logo_url'] ?? ''));
    $newOrgOfferId = trim((string)($_POST['new_org_offer_id'] ?? ''));
    $rewardPolicy = trim((string)($_POST['referrer_reward_policy_id'] ?? ''));

    if ($displayName === '') {
        return ['success' => false, 'error' => 'Display name is required.'];
    }

    $db = referralDb();
    $now = referralNowIso();
    $existing = $id !== '' ? referralPartnerGet($id) : null;
    if (!$existing) {
        $duplicate = referralPartnerFindLikelyDuplicate($type, $displayName, $companyName, $contactName, $contactEmail);
        if ($duplicate) {
            $existing = $duplicate;
            $id = (string)$duplicate['id'];
        }
    }
    $logoPath = $existing['logo_path'] ?? '';
    if (!empty($_FILES['logo_file'])) {
        $uploaded = referralSaveUploadedLogo($_FILES['logo_file']);
        if ($uploaded !== '') {
            $logoPath = $uploaded;
            $logoUrl = '';
        }
    } elseif ($logoUrl !== '') {
        $logoPath = '';
    }
    if (!$existing) {
        $id = 'refpartner_' . genHexId(12);
        $stmt = @$db->prepare("
            INSERT INTO referral_partners (
                id, type, status, display_name, company_name, contact_name, contact_email,
                contact_phone, logo_path, logo_url, notes, linked_user_email, linked_org_id,
                metadata_json, created_at, updated_at, created_by_email, updated_by_email
            ) VALUES (
                :id, :type, :status, :display_name, :company_name, :contact_name, :contact_email,
                :contact_phone, :logo_path, :logo_url, :notes, :linked_user_email, :linked_org_id,
                :metadata_json, :created_at, :updated_at, :created_by_email, :updated_by_email
            )
        ");
    } else {
        $stmt = @$db->prepare("
            UPDATE referral_partners
            SET type = :type,
                status = :status,
                display_name = :display_name,
                company_name = :company_name,
                contact_name = :contact_name,
                contact_email = :contact_email,
                contact_phone = :contact_phone,
                logo_path = :logo_path,
                logo_url = :logo_url,
                notes = :notes,
                linked_user_email = :linked_user_email,
                linked_org_id = :linked_org_id,
                metadata_json = :metadata_json,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id
        ");
    }
    if (!$stmt) return ['success' => false, 'error' => 'Could not prepare save statement.'];
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':type', $type, SQLITE3_TEXT);
    $stmt->bindValue(':status', $status, SQLITE3_TEXT);
    $stmt->bindValue(':display_name', $displayName, SQLITE3_TEXT);
    $stmt->bindValue(':company_name', $companyName, SQLITE3_TEXT);
    $stmt->bindValue(':contact_name', $contactName, SQLITE3_TEXT);
    $stmt->bindValue(':contact_email', $contactEmail, SQLITE3_TEXT);
    $stmt->bindValue(':contact_phone', $contactPhone, SQLITE3_TEXT);
    $stmt->bindValue(':logo_path', $logoPath, SQLITE3_TEXT);
    $stmt->bindValue(':logo_url', $logoUrl, SQLITE3_TEXT);
    $stmt->bindValue(':notes', $notes, SQLITE3_TEXT);
    $stmt->bindValue(':linked_user_email', $linkedUserEmail, SQLITE3_TEXT);
    $stmt->bindValue(':linked_org_id', $linkedOrgId, SQLITE3_TEXT);
    $stmt->bindValue(':metadata_json', json_encode([], JSON_UNESCAPED_SLASHES), SQLITE3_TEXT);
    if (!$existing) {
        $stmt->bindValue(':created_at', $now, SQLITE3_TEXT);
        $stmt->bindValue(':created_by_email', referralActorEmail(), SQLITE3_TEXT);
    }
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':updated_by_email', referralActorEmail(), SQLITE3_TEXT);
    @$stmt->execute();

    $partner = referralPartnerGet($id);
    if (!$existing && $partner) {
        $codeConfig = referralDefaultCodeConfig($type);
        if ($newOrgOfferId !== '') $codeConfig['new_org_offer_id'] = $newOrgOfferId;
        if ($rewardPolicy !== '') $codeConfig['referrer_reward_policy_id'] = $rewardPolicy;
        referralPartnerCreatePrimaryCode($partner, $codeConfig);
    } elseif ($partner) {
        $primaryCode = referralPartnerPrimaryCode($id);
        if ($primaryCode) {
            $stmt2 = @$db->prepare("
                UPDATE referral_codes
                SET campaign_type = :campaign_type,
                    landing_variant = :landing_variant,
                    new_org_offer_id = :new_org_offer_id,
                    referrer_reward_policy_id = :referrer_reward_policy_id,
                    active = :active,
                    updated_at = :updated_at,
                    updated_by_email = :updated_by_email
                WHERE id = :id
            ");
            if ($stmt2) {
                $defaults = referralDefaultCodeConfig($type);
                $stmt2->bindValue(':campaign_type', (string)($primaryCode['campaign_type'] ?: ($defaults['campaign_type'] ?? '')), SQLITE3_TEXT);
                $stmt2->bindValue(':landing_variant', (string)($primaryCode['landing_variant'] ?: ($defaults['landing_variant'] ?? '')), SQLITE3_TEXT);
                $stmt2->bindValue(':new_org_offer_id', $newOrgOfferId !== '' ? $newOrgOfferId : (string)($primaryCode['new_org_offer_id'] ?: ($defaults['new_org_offer_id'] ?? '')), SQLITE3_TEXT);
                $stmt2->bindValue(':referrer_reward_policy_id', $rewardPolicy !== '' ? $rewardPolicy : (string)($primaryCode['referrer_reward_policy_id'] ?: ($defaults['referrer_reward_policy_id'] ?? '')), SQLITE3_TEXT);
                $stmt2->bindValue(':active', $status === 'active' ? 1 : 0, SQLITE3_INTEGER);
                $stmt2->bindValue(':updated_at', $now, SQLITE3_TEXT);
                $stmt2->bindValue(':updated_by_email', referralActorEmail(), SQLITE3_TEXT);
                $stmt2->bindValue(':id', $primaryCode['id'], SQLITE3_TEXT);
                @$stmt2->execute();
            }
        }
    }

    $saved = referralPartnerGet($id);
    $savedCode = referralPartnerPrimaryCode($id);
    referralSyncPartnerUserRewards($id);
    return [
        'success' => true,
        'partner' => $saved,
        'primary_code' => $savedCode,
        'signup_url' => $savedCode ? referralPartnerLinkForCode($savedCode['code']) : '',
    ];
}

function referralCustomerPortalEligibility($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return ['show' => false, 'reason' => 'no_org'];
    $o = orgRead($orgId);
    if (!is_array($o)) return ['show' => false, 'reason' => 'org_not_found'];
    $offers = is_array($o['offers']['items'] ?? null) ? $o['offers']['items'] : [];
    $bonus = is_array($offers['bonus_upfront_match_v1'] ?? null) ? $offers['bonus_upfront_match_v1'] : [];
    $firstShownAt = trim((string)($bonus['first_shown_at'] ?? ''));
    if ($firstShownAt === '') return ['show' => false, 'reason' => 'bonus_not_shown'];
    $firstTs = strtotime($firstShownAt);
    if ($firstTs === false) return ['show' => false, 'reason' => 'bad_bonus_timestamp'];
    $eligibleAtTs = $firstTs + (72 * 3600);
    $secondsUntil = max(0, $eligibleAtTs - time());
    return [
        'show' => $secondsUntil <= 0,
        'reason' => $secondsUntil <= 0 ? 'eligible' : 'waiting_72h',
        'bonus_first_shown_at' => $firstShownAt,
        'eligible_at' => gmdate('c', $eligibleAtTs),
        'seconds_until_eligible' => $secondsUntil,
    ];
}

function referralCustomerPartnerForUser($email, $create = true) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return null;
    $db = referralDb();
    $stmt = @$db->prepare("SELECT id FROM referral_partners WHERE linked_user_email = :email AND type = 'customer_user' ORDER BY created_at ASC LIMIT 1");
    if ($stmt) {
        $stmt->bindValue(':email', $email, SQLITE3_TEXT);
        $res = @$stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (is_array($row) && !empty($row['id'])) return referralPartnerGet((string)$row['id']);
    }
    if (!$create || !function_exists('readUserDataByEmail')) return null;
    $u = readUserDataByEmail($email);
    if (!is_array($u)) return null;
    $name = trim((string)($u['name'] ?? ''));
    $company = trim((string)($u['company'] ?? ''));
    $orgId = orgNormalizeId($u['organization_id'] ?? '');
    $displayName = $name !== '' ? $name : ($company !== '' ? $company : $email);
    $now = referralNowIso();
    $id = 'refpartner_' . genHexId(12);
    $stmt = @$db->prepare("
        INSERT INTO referral_partners (
            id, type, status, display_name, company_name, contact_name, contact_email,
            contact_phone, logo_path, logo_url, notes, linked_user_email, linked_org_id,
            metadata_json, created_at, updated_at, created_by_email, updated_by_email
        ) VALUES (
            :id, 'customer_user', 'active', :display_name, :company_name, :contact_name, :contact_email,
            '', '', '', '', :linked_user_email, :linked_org_id, '{}', :created_at, :updated_at, :created_by_email, :updated_by_email
        )
    ");
    if (!$stmt) return null;
    $stmt->bindValue(':id', $id, SQLITE3_TEXT);
    $stmt->bindValue(':display_name', $displayName, SQLITE3_TEXT);
    $stmt->bindValue(':company_name', $company, SQLITE3_TEXT);
    $stmt->bindValue(':contact_name', $name, SQLITE3_TEXT);
    $stmt->bindValue(':contact_email', $email, SQLITE3_TEXT);
    $stmt->bindValue(':linked_user_email', $email, SQLITE3_TEXT);
    $stmt->bindValue(':linked_org_id', $orgId, SQLITE3_TEXT);
    $stmt->bindValue(':created_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':updated_at', $now, SQLITE3_TEXT);
    $stmt->bindValue(':created_by_email', $email, SQLITE3_TEXT);
    $stmt->bindValue(':updated_by_email', $email, SQLITE3_TEXT);
    @$stmt->execute();
    $partner = referralPartnerGet($id);
    if ($partner) referralPartnerCreatePrimaryCode($partner, referralDefaultCodeConfig('customer_user'));
    return referralPartnerGet($id);
}

function referralCustomerPortalStatus($email, $trackImpression = false) {
    $email = strtolower(trim((string)$email));
    if ($email === '') return ['success' => false, 'error' => 'missing_email'];
    $orgId = function_exists('actorOrgIdByEmail') ? actorOrgIdByEmail($email) : '';
    $eligibility = referralCustomerPortalEligibility($orgId);
    $partner = referralCustomerPartnerForUser($email, true);
    if (!$partner) return ['success' => false, 'error' => 'referral_partner_unavailable'];
    $code = referralPartnerPrimaryCode($partner['id']);
    if (!$code) $code = referralPartnerCreatePrimaryCode($partner, referralDefaultCodeConfig('customer_user'));
    $link = $code ? referralPartnerLinkForCode($code['code']) : '';
    if ($trackImpression && !empty($eligibility['show'])) {
        referralTrackEvent($partner['id'], $code['id'] ?? '', $email, $orgId, 'offer_impression', ['source' => 'customer_portal']);
    }
    $stats = array_merge(referralEventStatsForPartner($partner['id']), [
        'landing_views' => (int)($code['landing_views'] ?? 0),
    ]);
    return [
        'success' => true,
        'show_banner' => !empty($eligibility['show']),
        'reason' => (string)($eligibility['reason'] ?? ''),
        'eligible_at' => $eligibility['eligible_at'] ?? null,
        'seconds_until_eligible' => (int)($eligibility['seconds_until_eligible'] ?? 0),
        'bonus_first_shown_at' => $eligibility['bonus_first_shown_at'] ?? null,
        'partner' => [
            'id' => (string)$partner['id'],
            'display_name' => (string)$partner['display_name'],
        ],
        'code' => [
            'id' => (string)($code['id'] ?? ''),
            'code' => (string)($code['code'] ?? ''),
        ],
        'signup_url' => $link,
        'stats' => $stats,
    ];
}

function handleReferralActions($action) {
    if ($action === 'referral_public_lookup') {
        header('Content-Type: application/json');
        $code = (string)($_POST['code'] ?? $_GET['code'] ?? '');
        echo json_encode(referralPublicLookup($code));
        return true;
    }

    if ($action === 'referral_partner_list') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        $items = referralPartnerList();
        foreach ($items as &$item) {
            $code = is_array($item['primary_code'] ?? null) ? $item['primary_code'] : null;
            $item['signup_url'] = $code ? referralPartnerLinkForCode($code['code']) : '';
        }
        unset($item);
        echo json_encode(['success' => true, 'partners' => $items]);
        return true;
    }

    if ($action === 'referral_partner_get') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        $partner = referralPartnerGet($_POST['id'] ?? $_GET['id'] ?? '');
        if (!$partner) {
            echo json_encode(['success' => false, 'error' => 'Referral partner not found.']);
            return true;
        }
        $code = referralPartnerPrimaryCode($partner['id']);
        echo json_encode([
            'success' => true,
            'partner' => $partner,
            'primary_code' => $code,
            'signup_url' => $code ? referralPartnerLinkForCode($code['code']) : '',
        ]);
        return true;
    }

    if ($action === 'referral_partner_save') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        echo json_encode(referralPartnerSaveFromRequest());
        return true;
    }

    if ($action === 'referral_reward_report') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        echo json_encode(['success' => true, 'rows' => referralRewardReportRows(true)]);
        return true;
    }

    if ($action === 'referral_reward_update_status') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        echo json_encode(referralRewardUpdateStatus($_POST['reward_id'] ?? '', $_POST['status'] ?? 'pending'));
        return true;
    }

    if ($action === 'referral_org_search') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        echo json_encode(referralManualOrgSearch($_POST['query'] ?? $_GET['query'] ?? '', $_POST['limit'] ?? 80));
        return true;
    }

    if ($action === 'referral_manual_attach') {
        referralRequireManagerAccess();
        header('Content-Type: application/json');
        echo json_encode(referralManualAttachOrgToPartner(
            $_POST['org_id'] ?? '',
            $_POST['partner_id'] ?? '',
            $_POST['note'] ?? ''
        ));
        return true;
    }

    if ($action === 'portal_customer_referral_status') {
        requireLoginOrFail();
        header('Content-Type: application/json');
        $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $track = !empty($_POST['track_impression']);
        echo json_encode(referralCustomerPortalStatus($email, $track));
        return true;
    }

    if ($action === 'portal_customer_referral_event') {
        requireLoginOrFail();
        header('Content-Type: application/json');
        $email = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $partner = referralCustomerPartnerForUser($email, true);
        if (!$partner) {
            echo json_encode(['success' => false, 'error' => 'referral_partner_unavailable']);
            return true;
        }
        $code = referralPartnerPrimaryCode($partner['id']);
        $orgId = function_exists('actorOrgIdByEmail') ? actorOrgIdByEmail($email) : '';
        $eventType = (string)($_POST['event_type'] ?? '');
        echo json_encode(referralTrackEvent($partner['id'], $code['id'] ?? '', $email, $orgId, $eventType, [
            'source' => 'customer_portal',
        ]));
        return true;
    }

    return false;
}
