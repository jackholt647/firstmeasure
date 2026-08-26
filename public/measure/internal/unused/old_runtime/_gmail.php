<?php
require_once __DIR__ . '/_storage.php';

function gmailConfigValue($configKey, $default = '') {
    $value = serverConfigGet($configKey, null);
    if ($value !== null && $value !== '') return $value;
    $envKey = strtoupper($configKey);
    if (isset($GLOBALS[$envKey]) && $GLOBALS[$envKey] !== '') return $GLOBALS[$envKey];
    $env = getenv($envKey);
    if ($env !== false && $env !== '') return $env;
    return $default;
}

function gmailClientId() {
    return trim((string)gmailConfigValue('gmail_client_id', ''));
}

function gmailClientSecret() {
    return trim((string)gmailConfigValue('gmail_client_secret', ''));
}

function gmailBaseUrl() {
    $https = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
    $scheme = $https ? 'https' : 'http';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '') return '';
    $script = trim((string)($_SERVER['SCRIPT_NAME'] ?? '/server.php'));
    $dir = str_replace('\\', '/', dirname($script));
    if ($dir === '/' || $dir === '.') $dir = '';
    return $scheme . '://' . $host . $dir;
}

function gmailRedirectUri() {
    $configured = trim((string)gmailConfigValue('gmail_redirect_uri', ''));
    if ($configured !== '') return $configured;
    $base = gmailBaseUrl();
    if ($base === '') return 'http://localhost/server.php?action=gmail_oauth_callback';
    return rtrim($base, '/') . '/server.php?action=gmail_oauth_callback';
}

function gmailOauthStateDir() {
    $dir = storagePath('meta/gmail_oauth_state');
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    return $dir;
}

function gmailOauthStatePath($state) {
    $state = strtolower(trim((string)$state));
    $safe = preg_replace('/[^a-f0-9]/', '', $state);
    if ($safe === '') return '';
    return gmailOauthStateDir() . '/' . $safe . '.json';
}

function gmailWriteOauthState($state, array $payload) {
    $path = gmailOauthStatePath($state);
    if ($path === '') return false;
    $payload['state'] = strtolower(trim((string)($payload['state'] ?? $state)));
    $payload['created_at'] = (int)($payload['created_at'] ?? time());
    $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;
    return @file_put_contents($path, $json) !== false;
}

function gmailReadOauthState($state) {
    $path = gmailOauthStatePath($state);
    if ($path === '' || !is_file($path)) return [];
    $decoded = json_decode((string)@file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function gmailDeleteOauthState($state) {
    $path = gmailOauthStatePath($state);
    if ($path !== '' && is_file($path)) {
        @unlink($path);
    }
}

function gmailPruneOauthStates($maxAge = 1800) {
    $maxAge = max(60, (int)$maxAge);
    foreach (glob(gmailOauthStateDir() . '/*.json') ?: [] as $path) {
        $mtime = (int)@filemtime($path);
        if ($mtime > 0 && $mtime < (time() - $maxAge)) {
            @unlink($path);
        }
    }
}

function gmailIsConfigured() {
    return gmailClientId() !== '' && gmailClientSecret() !== '';
}

function googleCalendarScopes() {
    return [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
    ];
}

function gmailScopes() {
    return array_values(array_unique(array_merge([
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.settings.basic',
        'openid',
        'email',
        'profile',
    ], googleCalendarScopes())));
}

function gmailGrantedScopes($gmailData) {
    if (!is_array($gmailData)) return [];
    return array_values(array_filter(array_map('trim', explode(' ', (string)($gmailData['scope'] ?? '')))));
}

function gmailHasGrantedScope($gmailData, $scope) {
    $scope = trim((string)$scope);
    if ($scope === '' || !is_array($gmailData)) return false;
    $granted = gmailGrantedScopes($gmailData);
    if (in_array($scope, $granted, true)) return true;
    if (str_starts_with($scope, 'https://www.googleapis.com/auth/calendar')
        && in_array('https://www.googleapis.com/auth/calendar', $granted, true)) {
        return true;
    }
    if (str_starts_with($scope, 'https://www.googleapis.com/auth/gmail')
        && in_array('https://mail.google.com/', $granted, true)) {
        return true;
    }
    return false;
}

function gmailHasCalendarScopes($gmailData) {
    foreach (googleCalendarScopes() as $scope) {
        if (!gmailHasGrantedScope($gmailData, $scope)) return false;
    }
    return true;
}

function gmailIsLoopbackHost($host) {
    $host = strtolower(trim((string)$host));
    $host = trim($host, '[]');
    return in_array($host, ['localhost', '127.0.0.1', '::1'], true);
}

function gmailAllowInsecureLocalTls() {
    $httpHost = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($httpHost !== '') {
        $hostOnly = explode(':', $httpHost)[0] ?? $httpHost;
        if (gmailIsLoopbackHost($hostOnly)) return true;
    }
    $redirectHost = trim((string)(parse_url(gmailRedirectUri(), PHP_URL_HOST) ?: ''));
    return $redirectHost !== '' && gmailIsLoopbackHost($redirectHost);
}

function gmailCurlSslOptions() {
    if (!gmailAllowInsecureLocalTls()) {
        return [];
    }
    // Local Windows/PHP setups sometimes lack a CA bundle. Relax TLS only for loopback dev hosts.
    return [
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
    ];
}

function gmailSessionUserEmail() {
    return strtolower(trim((string)($_SESSION['user_email'] ?? '')));
}

function gmailUserIntegrationData($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('readUserDataByEmail')) return [];
    $user = readUserDataByEmail($email);
    if (!is_array($user)) return [];
    $integrations = $user['integrations'] ?? [];
    $gmail = $integrations['gmail'] ?? [];
    return is_array($gmail) ? $gmail : [];
}

function gmailWriteUserIntegrationData($email, array $gmailData) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('readUserDataByEmail') || !function_exists('writeUserDataByEmail')) {
        return false;
    }
    $user = readUserDataByEmail($email);
    if (!is_array($user)) return false;
    if (!isset($user['integrations']) || !is_array($user['integrations'])) $user['integrations'] = [];
    $user['integrations']['gmail'] = $gmailData;
    return writeUserDataByEmail($email, $user);
}

function gmailDisconnectUser($email) {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !function_exists('readUserDataByEmail') || !function_exists('writeUserDataByEmail')) {
        return false;
    }
    $user = readUserDataByEmail($email);
    if (!is_array($user)) return false;
    if (isset($user['integrations']['gmail'])) {
        unset($user['integrations']['gmail']);
    }
    return writeUserDataByEmail($email, $user);
}

function gmailHasSignatureScope($gmailData) {
    return gmailHasGrantedScope($gmailData, 'https://www.googleapis.com/auth/gmail.settings.basic');
}

function gmailHtmlToPlainText($html) {
    $html = (string)$html;
    if ($html === '') return '';
    $normalized = preg_replace('/<(br|BR)\s*\/?>/i', "\n", $html);
    $normalized = preg_replace('/<\/(p|div|li|tr|h[1-6])>/i', "\n", (string)$normalized);
    $text = html_entity_decode(strip_tags((string)$normalized), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    $text = preg_replace("/\n{3,}/", "\n\n", (string)$text);
    return trim((string)$text);
}

function gmailNormalizedMarkupForCompare($html) {
    $html = trim((string)$html);
    if ($html === '') return '';
    return strtolower(preg_replace('/\s+/', ' ', $html));
}

function gmailBodyIncludesSignatureHtml($bodyHtml, $signatureHtml) {
    $body = gmailNormalizedMarkupForCompare($bodyHtml);
    $signature = gmailNormalizedMarkupForCompare($signatureHtml);
    if ($body === '' || $signature === '') return false;
    return strpos($body, $signature) !== false;
}

function gmailAppendSignatureHtml($bodyHtml, $signatureHtml) {
    $bodyHtml = trim((string)$bodyHtml);
    $signatureHtml = trim((string)$signatureHtml);
    if ($signatureHtml === '') return $bodyHtml;
    if ($bodyHtml === '') return $signatureHtml;
    if (gmailBodyIncludesSignatureHtml($bodyHtml, $signatureHtml)) return $bodyHtml;
    return $bodyHtml . "\n\n" . $signatureHtml;
}

function gmailAppendSignatureText($bodyText, $signatureHtml) {
    $bodyText = trim((string)$bodyText);
    $signatureText = gmailHtmlToPlainText($signatureHtml);
    if ($signatureText === '') return $bodyText;
    if ($bodyText === '') return $signatureText;
    if (strpos(strtolower($bodyText), strtolower($signatureText)) !== false) return $bodyText;
    return $bodyText . "\n\n" . $signatureText;
}

function gmailRefreshSignatureForActor($actorEmail) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail) || empty($gmail['access_token'])) {
        return ['ok' => false, 'error' => 'Gmail is not connected for this user.'];
    }
    if (!gmailHasSignatureScope($gmail)) {
        return ['ok' => false, 'error' => 'Reconnect Google to grant Gmail signature access.', 'code' => 'missing_signature_scope'];
    }
    $sendAs = gmailApiRequestForActor(
        $actorEmail,
        'GET',
        'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'
    );
    if (empty($sendAs['ok']) || !is_array($sendAs['data'])) {
        return ['ok' => false, 'error' => $sendAs['error'] ?? 'Could not load the Gmail signature.'];
    }
    $sendAsItems = is_array($sendAs['data']['sendAs'] ?? null) ? $sendAs['data']['sendAs'] : [];
    $connectedEmail = strtolower(trim((string)($gmail['email'] ?? '')));
    $selected = null;
    foreach ($sendAsItems as $item) {
        $sendAsEmail = strtolower(trim((string)($item['sendAsEmail'] ?? '')));
        if ($connectedEmail !== '' && $sendAsEmail === $connectedEmail) {
            $selected = $item;
            break;
        }
    }
    if ($selected === null) {
        foreach ($sendAsItems as $item) {
            if (!empty($item['isPrimary']) || !empty($item['isDefault'])) {
                $selected = $item;
                break;
            }
        }
    }
    if ($selected === null && !empty($sendAsItems[0]) && is_array($sendAsItems[0])) {
        $selected = $sendAsItems[0];
    }
    $signatureHtml = trim((string)($selected['signature'] ?? ''));
    $gmail['signature_html'] = $signatureHtml;
    $gmail['signature_text'] = gmailHtmlToPlainText($signatureHtml);
    $gmail['signature_updated_at'] = gmdate('c');
    $gmail['send_as_email'] = trim((string)($selected['sendAsEmail'] ?? ($gmail['email'] ?? $actorEmail)));
    $gmail['send_as_display_name'] = trim((string)($selected['displayName'] ?? ''));
    $gmail['send_as_reply_to'] = trim((string)($selected['replyToAddress'] ?? ''));
    $gmail['updated_at'] = gmdate('c');
    gmailWriteUserIntegrationData($actorEmail, $gmail);
    return ['ok' => true, 'data' => $gmail, 'signature_html' => $signatureHtml];
}

function gmailConnectionPublicStateForActor($email) {
    $email = strtolower(trim((string)$email));
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsGmailConnectionPublicState($email);
    }
    $gmail = gmailUserIntegrationData($email);
    $expiresAt = (int)($gmail['expires_at'] ?? 0);
    $tokenConnected = !empty($gmail['refresh_token']) || (!empty($gmail['access_token']) && $expiresAt > time());
    $gmailConnected = $tokenConnected
        && gmailHasGrantedScope($gmail, 'https://www.googleapis.com/auth/gmail.send')
        && gmailHasGrantedScope($gmail, 'https://www.googleapis.com/auth/gmail.readonly');
    $calendarConnected = $tokenConnected && gmailHasCalendarScopes($gmail);
    $signatureUpdatedAt = (int)(strtotime((string)($gmail['signature_updated_at'] ?? '')) ?: 0);
    if ($gmailConnected && gmailHasSignatureScope($gmail) && ($signatureUpdatedAt <= 0 || $signatureUpdatedAt < (time() - 86400))) {
        $refreshedSignature = gmailRefreshSignatureForActor($email);
        if (!empty($refreshedSignature['ok']) && !empty($refreshedSignature['data']) && is_array($refreshedSignature['data'])) {
            $gmail = $refreshedSignature['data'];
        }
    }
    $mailboxEmail = gmailMailboxIdentityForActor($email, $gmail);
    $mailboxState = $mailboxEmail !== '' ? gmailReadMailboxState($mailboxEmail) : [];
    return [
        'configured' => gmailIsConfigured(),
        'connected' => $gmailConnected,
        'connected_email' => (string)($gmail['email'] ?? ''),
        'mailbox_email' => $mailboxEmail,
        'mailbox_key' => (string)($mailboxState['mailbox_key'] ?? ''),
        'expires_at' => $expiresAt,
        'redirect_uri' => gmailRedirectUri(),
        'has_refresh_token' => !empty($gmail['refresh_token']),
        'scopes' => gmailGrantedScopes($gmail),
        'signature_scope_granted' => gmailHasSignatureScope($gmail),
        'signature_html' => (string)($gmail['signature_html'] ?? ''),
        'signature_text' => (string)($gmail['signature_text'] ?? ''),
        'signature_updated_at' => (string)($gmail['signature_updated_at'] ?? ''),
        'send_as_email' => (string)($gmail['send_as_email'] ?? ($gmail['email'] ?? '')),
        'send_as_display_name' => (string)($gmail['send_as_display_name'] ?? ''),
        'sync' => [
            'initial_sync_complete' => !empty($mailboxState['initial_sync_complete']),
            'last_sync_at' => (int)($mailboxState['last_sync_at'] ?? 0),
            'last_sync_started_at' => (int)($mailboxState['last_sync_started_at'] ?? 0),
            'last_sync_status' => (string)($mailboxState['last_sync_status'] ?? ''),
            'last_sync_reason' => (string)($mailboxState['last_sync_reason'] ?? ''),
            'message_count' => (int)($mailboxState['message_count'] ?? 0),
            'thread_count' => (int)($mailboxState['thread_count'] ?? 0),
        ],
        'calendar' => [
            'configured' => gmailIsConfigured(),
            'connected' => $calendarConnected,
            'connected_email' => (string)($gmail['email'] ?? ''),
            'primary_calendar_id' => (string)($gmail['calendar_primary_id'] ?? 'primary'),
            'primary_calendar_summary' => (string)($gmail['calendar_primary_summary'] ?? ''),
            'timezone' => (string)($gmail['calendar_timezone'] ?? ''),
        ],
    ];
}

function gmailCalendarConnectionPublicStateForActor($email) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCalendarConnectionPublicState($email);
    }
    $state = gmailConnectionPublicStateForActor($email);
    $calendar = $state['calendar'] ?? [];
    return is_array($calendar) ? $calendar : ['configured' => false, 'connected' => false];
}

function gmailMailboxCacheRoot() {
    $dir = storagePath('meta/gmail_mailboxes');
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    return $dir;
}

function gmailMailboxKey($mailboxEmail) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '') return '';
    return preg_replace('/[^a-z0-9_\-@\.]/', '_', $mailboxEmail);
}

function gmailMailboxIdentityForActor($actorEmail, $gmailData = null) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = is_array($gmailData) ? $gmailData : gmailUserIntegrationData($actorEmail);
    $mailboxEmail = strtolower(trim((string)($gmail['email'] ?? '')));
    if ($mailboxEmail !== '' && filter_var($mailboxEmail, FILTER_VALIDATE_EMAIL)) {
        return $mailboxEmail;
    }
    return $actorEmail;
}

function gmailMailboxDir($mailboxEmail) {
    $key = gmailMailboxKey($mailboxEmail);
    if ($key === '') return '';
    $dir = gmailMailboxCacheRoot() . '/' . $key;
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    if (!is_dir($dir . '/messages')) {
        @mkdir($dir . '/messages', 0777, true);
    }
    if (!is_dir($dir . '/threads')) {
        @mkdir($dir . '/threads', 0777, true);
    }
    return $dir;
}

function gmailMailboxStatePath($mailboxEmail) {
    $dir = gmailMailboxDir($mailboxEmail);
    return $dir !== '' ? $dir . '/mailbox.json' : '';
}

function gmailMailboxMessagePath($mailboxEmail, $messageId) {
    $dir = gmailMailboxDir($mailboxEmail);
    $safe = preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$messageId);
    return ($dir !== '' && $safe !== '') ? $dir . '/messages/' . $safe . '.json' : '';
}

function gmailMailboxThreadPath($mailboxEmail, $threadId) {
    $dir = gmailMailboxDir($mailboxEmail);
    $safe = preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$threadId);
    return ($dir !== '' && $safe !== '') ? $dir . '/threads/' . $safe . '.json' : '';
}

function gmailMailboxUnmatchedDir($mailboxEmail) {
    $dir = gmailMailboxDir($mailboxEmail);
    if ($dir === '') return '';
    $path = $dir . '/unmatched';
    if (!is_dir($path)) {
        @mkdir($path, 0777, true);
    }
    return $path;
}

function gmailMailboxSyncRunDir($mailboxEmail) {
    $dir = gmailMailboxDir($mailboxEmail);
    if ($dir === '') return '';
    $path = $dir . '/sync_runs';
    if (!is_dir($path)) {
        @mkdir($path, 0777, true);
    }
    return $path;
}

function gmailMailboxUnmatchedPath($mailboxEmail, $messageId) {
    $dir = gmailMailboxUnmatchedDir($mailboxEmail);
    $safe = preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$messageId);
    return ($dir !== '' && $safe !== '') ? $dir . '/' . $safe . '.json' : '';
}

function gmailMailboxSyncRunPath($mailboxEmail, $runId) {
    $dir = gmailMailboxSyncRunDir($mailboxEmail);
    $safe = preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$runId);
    return ($dir !== '' && $safe !== '') ? $dir . '/' . $safe . '.json' : '';
}

function gmailReadJsonFile($path, $default = []) {
    if (!is_string($path) || $path === '' || !is_file($path)) return $default;
    $decoded = json_decode((string)file_get_contents($path), true);
    return is_array($decoded) ? $decoded : $default;
}

function gmailWriteJsonFile($path, array $data) {
    if (!is_string($path) || $path === '') return false;
    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;
    return file_put_contents($path, $json) !== false;
}

function gmailMailboxStateDefaults($mailboxEmail) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    return [
        'mailbox_email' => $mailboxEmail,
        'mailbox_key' => gmailMailboxKey($mailboxEmail),
        'actors' => [],
        'history_id' => '',
        'initial_sync_complete' => false,
        'has_backfill_sync' => false,
        'first_sync_at' => 0,
        'last_backfill_at' => 0,
        'last_sync_at' => 0,
        'last_sync_started_at' => 0,
        'last_sync_status' => '',
        'last_sync_reason' => '',
        'last_sync_error' => '',
        'message_count' => 0,
        'unmatched_count' => 0,
        'thread_count' => 0,
        'sync_run_count' => 0,
        'updated_at' => 0,
    ];
}

function gmailReadMailboxState($mailboxEmail) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '') return [];
    $state = gmailReadJsonFile(gmailMailboxStatePath($mailboxEmail), []);
    return gmailNormalizeMailboxState(array_merge(gmailMailboxStateDefaults($mailboxEmail), is_array($state) ? $state : []));
}

function gmailWriteMailboxState($mailboxEmail, array $state) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '') return false;
    $merged = array_merge(gmailMailboxStateDefaults($mailboxEmail), $state);
    $merged['mailbox_email'] = $mailboxEmail;
    $merged['mailbox_key'] = gmailMailboxKey($mailboxEmail);
    if (!isset($merged['actors']) || !is_array($merged['actors'])) {
        $merged['actors'] = [];
    }
    return gmailWriteJsonFile(gmailMailboxStatePath($mailboxEmail), $merged);
}

function gmailRefreshMailboxCounts($mailboxEmail, ?array $state = null) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '') return $state ?? [];
    $state = is_array($state) ? array_merge(gmailMailboxStateDefaults($mailboxEmail), $state) : gmailReadMailboxState($mailboxEmail);
    $dir = gmailMailboxDir($mailboxEmail);
    $messageCount = 0;
    $unmatchedCount = 0;
    $threadCount = 0;
    $syncRunCount = 0;
    if ($dir !== '') {
        $messageCount = count(glob($dir . '/messages/*.json') ?: []);
        $unmatchedCount = count(glob($dir . '/unmatched/*.json') ?: []);
        $threadCount = count(glob($dir . '/threads/*.json') ?: []);
        $syncRunCount = count(glob($dir . '/sync_runs/*.json') ?: []);
    }
    $state['message_count'] = $messageCount;
    $state['unmatched_count'] = $unmatchedCount;
    $state['thread_count'] = $threadCount;
    $state['sync_run_count'] = $syncRunCount;
    return $state;
}

function gmailNormalizeMailboxState(array $state, $now = null) {
    $now = $now ?: time();
    $mailboxEmail = strtolower(trim((string)($state['mailbox_email'] ?? '')));
    $state = $mailboxEmail !== ''
        ? gmailRefreshMailboxCounts($mailboxEmail, $state)
        : $state;
    if (
        ($state['last_sync_status'] ?? '') === 'running'
        && (int)($state['last_sync_started_at'] ?? 0) > 0
        && ($now - (int)$state['last_sync_started_at']) > 120
    ) {
        $state['last_sync_status'] = !empty($state['message_count']) || !empty($state['unmatched_count']) || !empty($state['thread_count'])
            ? 'ok'
            : 'idle';
        $state['updated_at'] = $now;
    }
    return $state;
}

function gmailRegisterMailboxForActor($actorEmail, array $gmailData = [], $now = null) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    if ($actorEmail === '') return [];
    $now = $now ?: time();
    $mailboxEmail = gmailMailboxIdentityForActor($actorEmail, $gmailData);
    if ($mailboxEmail === '') return [];
    $state = gmailReadMailboxState($mailboxEmail);
    $actors = is_array($state['actors'] ?? null) ? $state['actors'] : [];
    $actors[$actorEmail] = [
        'linked_at' => (int)($actors[$actorEmail]['linked_at'] ?? $now),
        'updated_at' => $now,
    ];
    $state['actors'] = $actors;
    $historyId = trim((string)($gmailData['history_id'] ?? ''));
    if ($historyId !== '') {
        $state['history_id'] = $historyId;
    }
    $state['updated_at'] = $now;
    gmailWriteMailboxState($mailboxEmail, $state);
    return gmailReadMailboxState($mailboxEmail);
}

function gmailMailboxMessageRecord($mailboxEmail, $messageId) {
    return gmailReadJsonFile(gmailMailboxMessagePath($mailboxEmail, $messageId), []);
}

function gmailWriteMailboxMessageRecord($mailboxEmail, array $record) {
    $messageId = trim((string)($record['gmail_message_id'] ?? ''));
    if ($messageId === '') return false;
    return gmailWriteJsonFile(gmailMailboxMessagePath($mailboxEmail, $messageId), $record);
}

function gmailMailboxThreadRecord($mailboxEmail, $threadId) {
    return gmailReadJsonFile(gmailMailboxThreadPath($mailboxEmail, $threadId), []);
}

function gmailWriteMailboxThreadRecord($mailboxEmail, array $record) {
    $threadId = trim((string)($record['gmail_thread_id'] ?? $record['thread_id'] ?? ''));
    if ($threadId === '') return false;
    return gmailWriteJsonFile(gmailMailboxThreadPath($mailboxEmail, $threadId), $record);
}

function gmailUpdateMailboxThreadRecord($mailboxEmail, array $messageRecord, array $leadIds, $now) {
    $threadId = trim((string)($messageRecord['gmail_thread_id'] ?? ''));
    if ($threadId === '') return false;
    $thread = gmailMailboxThreadRecord($mailboxEmail, $threadId);
    if (!is_array($thread) || empty($thread)) {
        $thread = [
            'gmail_thread_id' => $threadId,
            'mailbox_email' => strtolower(trim((string)$mailboxEmail)),
            'message_ids' => [],
            'lead_ids' => [],
            'updated_at' => 0,
        ];
    }
    $messageIds = array_values(array_unique(array_merge(
        array_values(array_filter($thread['message_ids'] ?? [])),
        [trim((string)($messageRecord['gmail_message_id'] ?? ''))]
    )));
    $thread['message_ids'] = array_values(array_filter($messageIds));
    $thread['lead_ids'] = array_values(array_unique(array_merge(
        array_values(array_filter($thread['lead_ids'] ?? [])),
        array_values(array_filter(array_map('strval', $leadIds)))
    )));
    $thread['updated_at'] = $now;
    return gmailWriteMailboxThreadRecord($mailboxEmail, $thread);
}

function gmailDeleteMailboxUnmatchedRecord($mailboxEmail, $messageId) {
    $path = gmailMailboxUnmatchedPath($mailboxEmail, $messageId);
    if ($path === '' || !is_file($path)) return false;
    return @unlink($path);
}

function gmailWriteMailboxUnmatchedRecord($mailboxEmail, array $messageRecord, array $candidateLeadIds, $now) {
    $messageId = trim((string)($messageRecord['gmail_message_id'] ?? ''));
    if ($messageId === '') return false;
    $existing = gmailReadJsonFile(gmailMailboxUnmatchedPath($mailboxEmail, $messageId), []);
    $record = array_merge(is_array($existing) ? $existing : [], $messageRecord);
    $record['candidate_lead_ids'] = array_values(array_unique(array_filter(array_map('strval', $candidateLeadIds))));
    $record['assigned_lead_ids'] = [];
    $record['association_status'] = 'unmatched';
    $record['updated_at'] = $now;
    if (empty($record['stored_at'])) $record['stored_at'] = $now;
    return gmailWriteJsonFile(gmailMailboxUnmatchedPath($mailboxEmail, $messageId), $record);
}

function gmailMailboxLogSyncRun($mailboxEmail, array $run) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '') return false;
    $runId = trim((string)($run['run_id'] ?? ''));
    if ($runId === '') {
        $runId = gmdate('Ymd_His') . '_' . substr(sha1(json_encode($run)), 0, 8);
    }
    $payload = $run;
    $payload['run_id'] = $runId;
    $payload['mailbox_email'] = $mailboxEmail;
    $payload['mailbox_key'] = gmailMailboxKey($mailboxEmail);
    return gmailWriteJsonFile(gmailMailboxSyncRunPath($mailboxEmail, $runId), $payload);
}

function gmailReadJsonCollectionFromDir($dir, $limit = 100, $sortField = 'updated_at') {
    if (!is_string($dir) || $dir === '' || !is_dir($dir)) return [];
    $paths = glob(rtrim($dir, '/\\') . '/*.json') ?: [];
    $records = [];
    foreach ($paths as $path) {
        $record = gmailReadJsonFile($path, []);
        if (!is_array($record) || empty($record)) continue;
        $record['_debug_path'] = $path;
        $records[] = $record;
    }
    usort($records, function ($a, $b) use ($sortField) {
        $av = (int)($a[$sortField] ?? $a['happened_at'] ?? $a['updated_at'] ?? 0);
        $bv = (int)($b[$sortField] ?? $b['happened_at'] ?? $b['updated_at'] ?? 0);
        if ($av === $bv) {
            return strcmp((string)($b['gmail_message_id'] ?? $b['run_id'] ?? ''), (string)($a['gmail_message_id'] ?? $a['run_id'] ?? ''));
        }
        return $bv <=> $av;
    });
    if ($limit > 0 && count($records) > $limit) {
        $records = array_slice($records, 0, $limit);
    }
    return $records;
}

function gmailLeadAddressIndex(SQLite3 $db) {
    static $cache = null;
    if (is_array($cache)) return $cache;
    $index = [];

    $leadRes = $db->query("SELECT id, email FROM leads WHERE email <> ''");
    while ($leadRes && ($row = $leadRes->fetchArray(SQLITE3_ASSOC))) {
        $email = strtolower(trim((string)($row['email'] ?? '')));
        $leadId = trim((string)($row['id'] ?? ''));
        if ($email === '' || $leadId === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) continue;
        if (!isset($index[$email])) $index[$email] = [];
        $index[$email][$leadId] = true;
    }

    $contactRes = $db->query("SELECT lead_id, email, metadata_json FROM lead_contacts WHERE email <> '' OR metadata_json <> ''");
    while ($contactRes && ($row = $contactRes->fetchArray(SQLITE3_ASSOC))) {
        $leadId = trim((string)($row['lead_id'] ?? ''));
        if ($leadId === '') continue;
        $emails = [];
        $primary = strtolower(trim((string)($row['email'] ?? '')));
        if ($primary !== '' && filter_var($primary, FILTER_VALIDATE_EMAIL)) {
            $emails[] = $primary;
        }
        $meta = leadDecodeJsonRowField($row, 'metadata_json');
        $secondary = [];
        if (is_array($meta)) {
            $secondary = leadNormalizeEmailList($meta['secondary_emails'] ?? []);
        }
        foreach (array_values(array_unique(array_merge($emails, $secondary))) as $email) {
            if (!isset($index[$email])) $index[$email] = [];
            $index[$email][$leadId] = true;
        }
    }

    foreach ($index as $email => $leadIds) {
        $index[$email] = array_values(array_keys($leadIds));
    }
    $cache = $index;
    return $cache;
}

function gmailApiGetMessageForActor($actorEmail, $messageId, $format = 'full') {
    $messageId = trim((string)$messageId);
    if ($messageId === '') return ['ok' => false, 'error' => 'Missing Gmail message id'];
    return gmailApiRequestForActor(
        $actorEmail,
        'GET',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/' . rawurlencode($messageId) . '?' . http_build_query([
            'format' => $format,
        ])
    );
}

function gmailCollectRecentMessageIds($actorEmail, $days = 10) {
    $messageIds = [];
    $pageToken = '';
    $pages = 0;
    do {
        $params = [
            'q' => 'in:anywhere newer_than:' . max(1, (int)$days) . 'd -in:chats',
            'maxResults' => 100,
        ];
        if ($pageToken !== '') $params['pageToken'] = $pageToken;
        $res = gmailApiRequestForActor(
            $actorEmail,
            'GET',
            'https://gmail.googleapis.com/gmail/v1/users/me/messages?' . http_build_query($params)
        );
        if (empty($res['ok'])) {
            return ['ok' => false, 'error' => $res['error'] ?? 'Could not list Gmail messages', 'message_ids' => array_values(array_keys($messageIds))];
        }
        foreach (($res['data']['messages'] ?? []) as $message) {
            $messageId = trim((string)($message['id'] ?? ''));
            if ($messageId !== '') $messageIds[$messageId] = true;
        }
        $pageToken = trim((string)($res['data']['nextPageToken'] ?? ''));
        $pages++;
    } while ($pageToken !== '' && $pages < 15);

    return [
        'ok' => true,
        'message_ids' => array_values(array_keys($messageIds)),
        'truncated' => $pageToken !== '',
    ];
}

function gmailCollectHistoryMessageIds($actorEmail, $startHistoryId) {
    $startHistoryId = trim((string)$startHistoryId);
    if ($startHistoryId === '') {
        return ['ok' => false, 'error' => 'Missing Gmail history id'];
    }
    $messageIds = [];
    $pageToken = '';
    $pages = 0;
    $latestHistoryId = $startHistoryId;
    do {
        $params = [
            'startHistoryId' => $startHistoryId,
            'historyTypes' => 'messageAdded',
            'maxResults' => 100,
        ];
        if ($pageToken !== '') $params['pageToken'] = $pageToken;
        $res = gmailApiRequestForActor(
            $actorEmail,
            'GET',
            'https://gmail.googleapis.com/gmail/v1/users/me/history?' . http_build_query($params)
        );
        if (empty($res['ok'])) {
            $status = (int)($res['status'] ?? 0);
            if ($status === 404) {
                return ['ok' => false, 'expired' => true, 'error' => $res['error'] ?? 'Stored Gmail history id is no longer valid'];
            }
            return ['ok' => false, 'error' => $res['error'] ?? 'Could not read Gmail history'];
        }
        $data = is_array($res['data']) ? $res['data'] : [];
        $latestHistoryId = trim((string)($data['historyId'] ?? $latestHistoryId));
        foreach (($data['history'] ?? []) as $historyRow) {
            $addedRows = array_merge(
                is_array($historyRow['messagesAdded'] ?? null) ? $historyRow['messagesAdded'] : [],
                is_array($historyRow['messages'] ?? null) ? array_map(function ($message) { return ['message' => $message]; }, $historyRow['messages']) : []
            );
            foreach ($addedRows as $entry) {
                $message = is_array($entry['message'] ?? null) ? $entry['message'] : [];
                $messageId = trim((string)($message['id'] ?? ''));
                if ($messageId !== '') $messageIds[$messageId] = true;
            }
        }
        $pageToken = trim((string)($data['nextPageToken'] ?? ''));
        $pages++;
    } while ($pageToken !== '' && $pages < 20);

    return [
        'ok' => true,
        'message_ids' => array_values(array_keys($messageIds)),
        'latest_history_id' => $latestHistoryId,
        'truncated' => $pageToken !== '',
    ];
}

function gmailNormalizeMessageRecord(array $message, $mailboxEmail, $actorEmail, $now) {
    $messageId = trim((string)($message['id'] ?? ''));
    if ($messageId === '') return [];
    $threadId = trim((string)($message['threadId'] ?? ''));
    $payload = is_array($message['payload'] ?? null) ? $message['payload'] : [];
    $headers = is_array($payload['headers'] ?? null) ? $payload['headers'] : [];
    $fromHeader = gmailHeaderValue($headers, 'From');
    $toHeader = gmailHeaderValue($headers, 'To');
    $ccHeader = gmailHeaderValue($headers, 'Cc');
    $fromEmails = gmailExtractEmails($fromHeader);
    $toEmails = gmailExtractEmails($toHeader);
    $ccEmails = gmailExtractEmails($ccHeader);
    $subject = trim(gmailHeaderValue($headers, 'Subject'));
    $messageIdHeader = trim(gmailHeaderValue($headers, 'Message-ID'));
    $inReplyTo = trim(gmailHeaderValue($headers, 'In-Reply-To'));
    $references = trim(gmailHeaderValue($headers, 'References'));
    $body = trim(gmailPayloadBodyText($payload));
    $snippet = trim((string)($message['snippet'] ?? ''));
    if ($body === '' && $snippet !== '') $body = $snippet;
    $internalDate = (int)round(((int)($message['internalDate'] ?? 0)) / 1000);
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    $direction = in_array($mailboxEmail, $fromEmails, true) ? 'out' : 'in';
    $participants = array_values(array_unique(array_filter(array_merge($fromEmails, $toEmails, $ccEmails))));
    $labelIds = array_values(is_array($message['labelIds'] ?? null) ? $message['labelIds'] : []);
    return [
        'gmail_message_id' => $messageId,
        'gmail_thread_id' => $threadId,
        'gmail_history_id' => trim((string)($message['historyId'] ?? '')),
        'mailbox_email' => $mailboxEmail,
        'mailbox_key' => gmailMailboxKey($mailboxEmail),
        'actor_email' => strtolower(trim((string)$actorEmail)),
        'direction' => $direction,
        'subject' => $subject !== '' ? $subject : 'Gmail message',
        'body_text' => $body,
        'snippet' => $snippet,
        'message_id_header' => $messageIdHeader,
        'from' => $fromHeader,
        'from_email' => $fromEmails[0] ?? '',
        'from_emails' => $fromEmails,
        'to' => $toHeader,
        'to_emails' => $toEmails,
        'cc' => $ccHeader,
        'cc_emails' => $ccEmails,
        'participants' => $participants,
        'references' => $references,
        'in_reply_to' => $inReplyTo,
        'label_ids' => $labelIds,
        'read_status' => gmailReadStatusFromLabels($labelIds),
        'happened_at' => $internalDate > 0 ? $internalDate : $now,
        'synced_at' => $now,
    ];
}

function gmailReadStatusFromLabels(array $labelIds) {
    $normalized = [];
    foreach ($labelIds as $labelId) {
        $label = strtoupper(trim((string)$labelId));
        if ($label !== '') $normalized[$label] = true;
    }
    return isset($normalized['UNREAD']) ? 'unread' : 'read';
}

function gmailLeadIdsForMessage(SQLite3 $db, array $messageRecord, ?array $leadIndex = null) {
    $leadIndex = is_array($leadIndex) ? $leadIndex : gmailLeadAddressIndex($db);
    $mailboxEmail = strtolower(trim((string)($messageRecord['mailbox_email'] ?? '')));
    $participants = array_values(array_unique(array_filter(array_merge(
        is_array($messageRecord['from_emails'] ?? null) ? $messageRecord['from_emails'] : [],
        is_array($messageRecord['to_emails'] ?? null) ? $messageRecord['to_emails'] : [],
        is_array($messageRecord['cc_emails'] ?? null) ? $messageRecord['cc_emails'] : []
    ))));
    $leadIds = [];
    foreach ($participants as $email) {
        $normalized = strtolower(trim((string)$email));
        if ($normalized === '' || $normalized === $mailboxEmail) continue;
        foreach (($leadIndex[$normalized] ?? []) as $leadId) {
            $leadIds[$leadId] = true;
        }
    }
    return array_values(array_keys($leadIds));
}

function gmailStoreMatchedMessageRecord($mailboxEmail, array $messageRecord, array $leadIds, $now) {
    $mailboxEmail = strtolower(trim((string)$mailboxEmail));
    if ($mailboxEmail === '' || empty($leadIds)) return false;
    $existing = gmailMailboxMessageRecord($mailboxEmail, $messageRecord['gmail_message_id'] ?? '');
    $record = array_merge(is_array($existing) ? $existing : [], $messageRecord);
    $record['assigned_lead_ids'] = array_values(array_unique(array_merge(
        array_values(array_filter(array_map('strval', $existing['assigned_lead_ids'] ?? []))),
        array_values(array_filter(array_map('strval', $leadIds)))
    )));
    $record['updated_at'] = $now;
    if (empty($record['stored_at'])) $record['stored_at'] = $now;
    $ok = gmailWriteMailboxMessageRecord($mailboxEmail, $record);
    if ($ok) {
        gmailUpdateMailboxThreadRecord($mailboxEmail, $record, $record['assigned_lead_ids'], $now);
    }
    return $ok;
}

function gmailAssignMessageRecordToLeadIds(SQLite3 $db, array $leadIds, array $messageRecord, $actorEmail, $now) {
    if (empty($leadIds)) return 0;
    $assigned = 0;
    foreach ($leadIds as $leadId) {
        $ownerEmail = $messageRecord['direction'] === 'out'
            ? (string)($messageRecord['mailbox_email'] ?? $actorEmail)
            : (string)($messageRecord['from_email'] ?? ($messageRecord['from'] ?? 'Gmail'));
        gmailLeadActivityUpsert($db, (string)$leadId, $actorEmail, [
            'owner_email' => $ownerEmail,
            'activity_type' => 'email',
            'direction' => (string)($messageRecord['direction'] ?? ''),
            'subject' => (string)($messageRecord['subject'] ?? 'Gmail message'),
            'body_text' => (string)($messageRecord['body_text'] ?? ''),
            'related_id' => (string)($messageRecord['gmail_message_id'] ?? ''),
            'metadata' => [
                'transport' => 'gmail',
                'sync_source' => 'mailbox_cache',
                'mailbox_email' => (string)($messageRecord['mailbox_email'] ?? ''),
                'mailbox_key' => (string)($messageRecord['mailbox_key'] ?? ''),
                'gmail_thread_id' => (string)($messageRecord['gmail_thread_id'] ?? ''),
                'gmail_message_id' => (string)($messageRecord['gmail_message_id'] ?? ''),
                'gmail_history_id' => (string)($messageRecord['gmail_history_id'] ?? ''),
                'message_id_header' => (string)($messageRecord['message_id_header'] ?? ''),
                'gmail_label_ids' => array_values($messageRecord['label_ids'] ?? []),
                'read_status' => (string)($messageRecord['read_status'] ?? ''),
                'from' => (string)($messageRecord['from'] ?? ''),
                'from_email' => (string)($messageRecord['from_email'] ?? ''),
                'to' => (string)($messageRecord['to'] ?? ''),
                'to_emails' => array_values($messageRecord['to_emails'] ?? []),
                'cc' => (string)($messageRecord['cc'] ?? ''),
                'cc_emails' => array_values($messageRecord['cc_emails'] ?? []),
                'snippet' => (string)($messageRecord['snippet'] ?? ''),
                'references' => (string)($messageRecord['references'] ?? ''),
                'in_reply_to' => (string)($messageRecord['in_reply_to'] ?? ''),
                'synced_at' => $now,
            ],
            'happened_at' => (int)($messageRecord['happened_at'] ?? $now),
        ], $now);
        if (strtolower(trim((string)($messageRecord['direction'] ?? ''))) === 'in') {
            if (function_exists('leadSequencePauseActiveForLead')) {
                leadSequencePauseActiveForLead($db, (string)$leadId, $actorEmail, $now, 'response');
            }
            if (function_exists('leadRowById') && function_exists('leadMaybeAutoAdvanceStage')) {
                $leadRow = leadRowById($db, (string)$leadId);
                if ($leadRow) {
                    leadMaybeAutoAdvanceStage($db, $leadRow, 'info_received', 'System auto-transition from inbound Gmail response.', $now, [
                        'trigger' => 'gmail_inbound_response',
                    ]);
                }
            }
        }
        $assigned++;
    }
    return $assigned;
}

function gmailRefreshMailboxProfile($actorEmail, $now) {
    $profile = gmailApiGetProfile($actorEmail);
    if (empty($profile['ok']) || empty($profile['data']['emailAddress'])) {
        return ['ok' => false, 'error' => $profile['error'] ?? 'Could not read Gmail profile'];
    }
    $gmailData = gmailUserIntegrationData($actorEmail);
    $gmailData['email'] = (string)$profile['data']['emailAddress'];
    $gmailData['history_id'] = (string)($profile['data']['historyId'] ?? ($gmailData['history_id'] ?? ''));
    $gmailData['updated_at'] = gmdate('c');
    gmailWriteUserIntegrationData($actorEmail, $gmailData);
    $state = gmailRegisterMailboxForActor($actorEmail, $gmailData, $now);
    return [
        'ok' => true,
        'gmail' => $gmailData,
        'mailbox_state' => $state,
    ];
}

function gmailSyncMailboxForActor(SQLite3 $db, $actorEmail, $now, $force = false, $reason = 'background') {
    $actorEmail = strtolower(trim((string)$actorEmail));
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsGmailSyncMailboxForActor($db, $actorEmail, $now, $force, $reason);
    }
    if ($actorEmail === '' || !gmailIsConfigured()) {
        return ['ok' => false, 'skipped' => 'gmail_not_configured'];
    }
    $gmail = gmailConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail) || empty($gmail['access_token'])) {
        return ['ok' => false, 'skipped' => 'gmail_not_connected'];
    }

    $profileRefresh = gmailRefreshMailboxProfile($actorEmail, $now);
    if (!empty($profileRefresh['ok'])) {
        $gmail = $profileRefresh['gmail'];
    }
    $mailboxEmail = gmailMailboxIdentityForActor($actorEmail, $gmail);
    if ($mailboxEmail === '') {
        return ['ok' => false, 'error' => 'Could not determine the Gmail mailbox identity'];
    }

    $state = gmailRegisterMailboxForActor($actorEmail, $gmail, $now);
    if (!$force && (int)($state['last_sync_started_at'] ?? 0) > 0 && ($now - (int)$state['last_sync_started_at']) < 20) {
        return ['ok' => true, 'skipped' => 'sync_recently_started', 'mailbox' => gmailRefreshMailboxCounts($mailboxEmail, $state)];
    }

    $state['last_sync_started_at'] = $now;
    $state['last_sync_status'] = 'running';
    $state['last_sync_reason'] = (string)$reason;
    $state['last_sync_error'] = '';
    gmailWriteMailboxState($mailboxEmail, $state);

    $cacheEmpty = ((int)($state['message_count'] ?? 0) === 0)
        && ((int)($state['unmatched_count'] ?? 0) === 0)
        && ((int)($state['thread_count'] ?? 0) === 0);
    $hasBackfillSync = !empty($state['has_backfill_sync']);
    $syncMode = ($hasBackfillSync && trim((string)($state['history_id'] ?? '')) !== '')
        ? 'history'
        : 'backfill';
    if ($syncMode === 'history' && $cacheEmpty && empty($state['last_backfill_at'])) {
        $syncMode = 'backfill';
    }
    $messageIdRes = $syncMode === 'history'
        ? gmailCollectHistoryMessageIds($actorEmail, (string)$state['history_id'])
        : gmailCollectRecentMessageIds($actorEmail, 10);

    if (empty($messageIdRes['ok']) && !empty($messageIdRes['expired'])) {
        $syncMode = 'backfill';
        $messageIdRes = gmailCollectRecentMessageIds($actorEmail, 10);
    }
    if (empty($messageIdRes['ok'])) {
        $state['last_sync_status'] = 'error';
        $state['last_sync_error'] = (string)($messageIdRes['error'] ?? 'Could not sync Gmail mailbox');
        $state['updated_at'] = $now;
        gmailWriteMailboxState($mailboxEmail, $state);
        gmailMailboxLogSyncRun($mailboxEmail, [
            'run_id' => gmdate('Ymd_His', $now) . '_' . substr(sha1($actorEmail . '|' . $reason . '|error|' . $now), 0, 8),
            'status' => 'error',
            'reason' => (string)$reason,
            'mode' => $syncMode,
            'started_at' => (int)($state['last_sync_started_at'] ?? $now),
            'finished_at' => $now,
            'actor_email' => $actorEmail,
            'examined_message_ids' => 0,
            'stored_messages' => 0,
            'unmatched_messages' => 0,
            'assigned_activities' => 0,
            'truncated' => false,
            'history_id' => (string)($state['history_id'] ?? ''),
            'error' => $state['last_sync_error'],
        ]);
        return ['ok' => false, 'error' => $state['last_sync_error'], 'mailbox' => $state];
    }

    $leadIndex = gmailLeadAddressIndex($db);
    $messageIds = array_values(array_unique(array_filter(array_map('strval', $messageIdRes['message_ids'] ?? []))));
    $matchedMessages = 0;
    $unmatchedMessages = 0;
    $assignedActivities = 0;
    foreach ($messageIds as $messageId) {
        $messageRes = gmailApiGetMessageForActor($actorEmail, $messageId, 'full');
        if (empty($messageRes['ok']) || !is_array($messageRes['data'])) continue;
        $record = gmailNormalizeMessageRecord($messageRes['data'], $mailboxEmail, $actorEmail, $now);
        if (empty($record)) continue;
        $leadIds = gmailLeadIdsForMessage($db, $record, $leadIndex);
        if (empty($leadIds)) {
            gmailWriteMailboxUnmatchedRecord($mailboxEmail, $record, [], $now);
            $unmatchedMessages++;
            continue;
        }
        gmailDeleteMailboxUnmatchedRecord($mailboxEmail, $messageId);
        gmailStoreMatchedMessageRecord($mailboxEmail, $record, $leadIds, $now);
        $assignedActivities += gmailAssignMessageRecordToLeadIds($db, $leadIds, $record, $actorEmail, $now);
        $matchedMessages++;
    }

    $profileRefresh = gmailRefreshMailboxProfile($actorEmail, $now);
    if (!empty($profileRefresh['ok'])) {
        $gmail = $profileRefresh['gmail'];
    }
    $state = gmailReadMailboxState($mailboxEmail);
    $state['history_id'] = trim((string)($gmail['history_id'] ?? ($messageIdRes['latest_history_id'] ?? ($state['history_id'] ?? ''))));
    $state['initial_sync_complete'] = true;
    if ($syncMode === 'backfill') {
        $state['has_backfill_sync'] = true;
        $state['last_backfill_at'] = $now;
    }
    if (empty($state['first_sync_at'])) $state['first_sync_at'] = $now;
    $state['last_sync_at'] = $now;
    $state['last_sync_status'] = 'ok';
    $state['last_sync_reason'] = (string)$reason;
    $state['last_sync_error'] = '';
    $state['updated_at'] = $now;
    $state = gmailRefreshMailboxCounts($mailboxEmail, $state);
    gmailWriteMailboxState($mailboxEmail, $state);
    gmailMailboxLogSyncRun($mailboxEmail, [
        'run_id' => gmdate('Ymd_His', $now) . '_' . substr(sha1($actorEmail . '|' . $reason . '|' . $now), 0, 8),
        'status' => 'ok',
        'reason' => (string)$reason,
        'mode' => $syncMode,
        'started_at' => (int)($state['last_sync_started_at'] ?? $now),
        'finished_at' => $now,
        'actor_email' => $actorEmail,
        'examined_message_ids' => count($messageIds),
        'stored_messages' => $matchedMessages,
        'unmatched_messages' => $unmatchedMessages,
        'assigned_activities' => $assignedActivities,
        'truncated' => !empty($messageIdRes['truncated']),
        'history_id' => (string)($state['history_id'] ?? ''),
    ]);

    return [
        'ok' => true,
        'mailbox' => $state,
        'mode' => $syncMode,
        'examined_message_ids' => count($messageIds),
        'stored_messages' => $matchedMessages,
        'unmatched_messages' => $unmatchedMessages,
        'assigned_activities' => $assignedActivities,
        'truncated' => !empty($messageIdRes['truncated']),
    ];
}

function gmailAssociateMailboxMessagesForLead(SQLite3 $db, array $leadRow, $actorEmail, $now, $force = false) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    if ($actorEmail === '' || !gmailIsConfigured()) return ['ok' => false, 'skipped' => 'gmail_not_configured'];
    $gmail = gmailUserIntegrationData($actorEmail);
    $mailboxEmail = gmailMailboxIdentityForActor($actorEmail, $gmail);
    if ($mailboxEmail === '') return ['ok' => false, 'skipped' => 'gmail_no_mailbox'];

    $addresses = gmailLeadAddresses($leadRow);
    if (empty($addresses)) return ['ok' => true, 'assigned' => 0];

    $metadata = leadMetadataValue($leadRow);
    $lastSyncAt = (int)($metadata['integrations']['gmail']['last_sync_at'] ?? 0);
    if (!$force && $lastSyncAt > 0 && ($now - $lastSyncAt) < 45) {
        return ['ok' => true, 'assigned' => 0, 'cached' => true];
    }

    $dir = gmailMailboxDir($mailboxEmail);
    $assigned = 0;
    foreach (glob($dir . '/messages/*.json') ?: [] as $path) {
        $record = gmailReadJsonFile($path, []);
        if (!is_array($record) || empty($record)) continue;
        $participants = array_values(array_unique(array_filter(array_merge(
            is_array($record['from_emails'] ?? null) ? $record['from_emails'] : [],
            is_array($record['to_emails'] ?? null) ? $record['to_emails'] : [],
            is_array($record['cc_emails'] ?? null) ? $record['cc_emails'] : []
        ))));
        if (empty(array_intersect($addresses, $participants))) continue;
        $assigned += gmailAssignMessageRecordToLeadIds($db, [(string)$leadRow['id']], $record, $actorEmail, $now);
    }

    $latestRow = leadRowById($db, $leadRow['id']) ?: $leadRow;
    $meta = leadMetadataValue($latestRow);
    leadSetMetadataNestedValue($meta, ['integrations', 'gmail', 'last_sync_at'], $now);
    leadSetMetadataNestedValue($meta, ['integrations', 'gmail', 'last_sync_by'], $actorEmail);
    leadUpdateLeadMetadata($db, $leadRow['id'], $meta, $actorEmail, $now);

    return ['ok' => true, 'assigned' => $assigned];
}

function gmailCacheSentMessageForLead(SQLite3 $db, $actorEmail, $leadId, array $payload, $now) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $leadId = trim((string)$leadId);
    if ($actorEmail === '' || $leadId === '') return false;
    $gmail = gmailUserIntegrationData($actorEmail);
    $mailboxEmail = gmailMailboxIdentityForActor($actorEmail, $gmail);
    if ($mailboxEmail === '') return false;
    $record = [
        'gmail_message_id' => trim((string)($payload['gmail_message_id'] ?? '')),
        'gmail_thread_id' => trim((string)($payload['gmail_thread_id'] ?? '')),
        'gmail_history_id' => trim((string)($payload['gmail_history_id'] ?? '')),
        'mailbox_email' => $mailboxEmail,
        'mailbox_key' => gmailMailboxKey($mailboxEmail),
        'actor_email' => $actorEmail,
        'direction' => 'out',
        'subject' => trim((string)($payload['subject'] ?? '')) ?: 'Gmail message',
        'body_text' => (string)($payload['body_text'] ?? ''),
        'snippet' => trim((string)($payload['body_text'] ?? '')),
        'message_id_header' => trim((string)($payload['message_id_header'] ?? $payload['message_id'] ?? '')),
        'from' => (string)($payload['from'] ?? $mailboxEmail),
        'from_email' => (string)($payload['from_email'] ?? $mailboxEmail),
        'from_emails' => [(string)($payload['from_email'] ?? $mailboxEmail)],
        'to' => (string)($payload['to'] ?? ''),
        'to_emails' => array_values(array_filter(array_map('strtolower', is_array($payload['to_emails'] ?? null) ? $payload['to_emails'] : [(string)($payload['to'] ?? '')]))),
        'cc' => (string)($payload['cc'] ?? ''),
        'cc_emails' => array_values(array_filter(array_map('strtolower', is_array($payload['cc_emails'] ?? null) ? $payload['cc_emails'] : []))),
        'participants' => [],
        'references' => (string)($payload['references'] ?? ''),
        'in_reply_to' => (string)($payload['in_reply_to'] ?? ''),
        'label_ids' => ['SENT'],
        'read_status' => 'read',
        'happened_at' => (int)($payload['happened_at'] ?? $now),
        'synced_at' => $now,
    ];
    $record['participants'] = array_values(array_unique(array_filter(array_merge(
        $record['from_emails'],
        $record['to_emails'],
        $record['cc_emails']
    ))));
    gmailDeleteMailboxUnmatchedRecord($mailboxEmail, $record['gmail_message_id']);
    gmailStoreMatchedMessageRecord($mailboxEmail, $record, [$leadId], $now);
    return true;
}

function gmailLeadSummariesByIds(SQLite3 $db, array $leadIds) {
    $leadIds = array_values(array_unique(array_filter(array_map('strval', $leadIds))));
    if (empty($leadIds)) return [];
    $summaries = [];
    foreach ($leadIds as $leadId) {
        $stmt = $db->prepare('SELECT id, company, email, status, assigned_to_email, lead_name FROM leads WHERE id = :id LIMIT 1');
        if (!$stmt) continue;
        leadBindText($stmt, ':id', $leadId);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (!$row) continue;
        $summaries[$leadId] = [
            'id' => (string)($row['id'] ?? ''),
            'company' => (string)($row['company'] ?? ''),
            'lead_name' => (string)($row['lead_name'] ?? ''),
            'email' => (string)($row['email'] ?? ''),
            'status' => (string)($row['status'] ?? ''),
            'assigned_to_email' => (string)($row['assigned_to_email'] ?? ''),
        ];
    }
    return $summaries;
}

function gmailReadMailboxStateByKey($mailboxKey) {
    $mailboxKey = trim((string)$mailboxKey);
    if ($mailboxKey === '') return [];
    $path = gmailMailboxCacheRoot() . '/' . $mailboxKey . '/mailbox.json';
    $state = gmailReadJsonFile($path, []);
    return is_array($state) ? $state : [];
}

function gmailViewerCanInspectAllMailboxes($actorEmail) {
    if (function_exists('isAdmin') && isAdmin()) return true;
    if (function_exists('userHasPerm')) {
        return userHasPerm($actorEmail, 'manage_users') || userHasPerm($actorEmail, 'manage_sales_users');
    }
    return false;
}

function gmailBuildMailboxSummary(SQLite3 $db, array $state) {
    $mailboxEmail = strtolower(trim((string)($state['mailbox_email'] ?? '')));
    if ($mailboxEmail === '') return [];
    $state = gmailRefreshMailboxCounts($mailboxEmail, $state);
    $leadIds = [];
    foreach (gmailReadJsonCollectionFromDir(gmailMailboxDir($mailboxEmail) . '/messages', 5000, 'happened_at') as $message) {
        foreach (($message['assigned_lead_ids'] ?? []) as $leadId) {
            $leadIds[(string)$leadId] = true;
        }
    }
    $runs = gmailReadJsonCollectionFromDir(gmailMailboxSyncRunDir($mailboxEmail), 1, 'finished_at');
    return [
        'mailbox_email' => $mailboxEmail,
        'mailbox_key' => (string)($state['mailbox_key'] ?? gmailMailboxKey($mailboxEmail)),
        'actors' => array_values(array_keys(is_array($state['actors'] ?? null) ? $state['actors'] : [])),
        'history_id' => (string)($state['history_id'] ?? ''),
        'initial_sync_complete' => !empty($state['initial_sync_complete']),
        'first_sync_at' => (int)($state['first_sync_at'] ?? 0),
        'last_sync_at' => (int)($state['last_sync_at'] ?? 0),
        'last_sync_started_at' => (int)($state['last_sync_started_at'] ?? 0),
        'last_sync_status' => (string)($state['last_sync_status'] ?? ''),
        'last_sync_reason' => (string)($state['last_sync_reason'] ?? ''),
        'last_sync_error' => (string)($state['last_sync_error'] ?? ''),
        'message_count' => (int)($state['message_count'] ?? 0),
        'unmatched_count' => (int)($state['unmatched_count'] ?? 0),
        'thread_count' => (int)($state['thread_count'] ?? 0),
        'sync_run_count' => (int)($state['sync_run_count'] ?? 0),
        'lead_count' => count($leadIds),
        'last_run' => $runs[0] ?? null,
    ];
}

function gmailMailboxDebugDetail(SQLite3 $db, array $state, $limit = 150) {
    $mailboxEmail = strtolower(trim((string)($state['mailbox_email'] ?? '')));
    if ($mailboxEmail === '') return [];
    $matched = gmailReadJsonCollectionFromDir(gmailMailboxDir($mailboxEmail) . '/messages', max(1, (int)$limit), 'happened_at');
    $unmatched = gmailReadJsonCollectionFromDir(gmailMailboxUnmatchedDir($mailboxEmail), max(1, (int)$limit), 'happened_at');
    $runs = gmailReadJsonCollectionFromDir(gmailMailboxSyncRunDir($mailboxEmail), 30, 'finished_at');
    $threads = gmailReadJsonCollectionFromDir(gmailMailboxDir($mailboxEmail) . '/threads', 200, 'updated_at');

    $leadIds = [];
    foreach ($matched as $message) {
        foreach (($message['assigned_lead_ids'] ?? []) as $leadId) {
            $leadIds[(string)$leadId] = true;
        }
    }
    foreach ($threads as $thread) {
        foreach (($thread['lead_ids'] ?? []) as $leadId) {
            $leadIds[(string)$leadId] = true;
        }
    }
    $leadSummaries = gmailLeadSummariesByIds($db, array_values(array_keys($leadIds)));

    $inbox = [];
    foreach ($matched as $message) {
        $message['association_status'] = 'matched';
        $message['lead_summaries'] = array_values(array_filter(array_map(function ($leadId) use ($leadSummaries) {
            return $leadSummaries[(string)$leadId] ?? null;
        }, $message['assigned_lead_ids'] ?? [])));
        $inbox[] = $message;
    }
    foreach ($unmatched as $message) {
        $message['association_status'] = 'unmatched';
        $message['lead_summaries'] = [];
        $inbox[] = $message;
    }
    usort($inbox, function ($a, $b) {
        return ((int)($b['happened_at'] ?? 0)) <=> ((int)($a['happened_at'] ?? 0));
    });
    if (count($inbox) > $limit) {
        $inbox = array_slice($inbox, 0, $limit);
    }

    return [
        'summary' => gmailBuildMailboxSummary($db, $state),
        'associated_leads' => array_values($leadSummaries),
        'threads' => array_map(function ($thread) use ($leadSummaries) {
            $thread['lead_summaries'] = array_values(array_filter(array_map(function ($leadId) use ($leadSummaries) {
                return $leadSummaries[(string)$leadId] ?? null;
            }, $thread['lead_ids'] ?? [])));
            return $thread;
        }, $threads),
        'inbox' => $inbox,
        'matched_messages' => $matched,
        'unmatched_messages' => $unmatched,
        'sync_runs' => $runs,
    ];
}

function gmailDebugSnapshot(SQLite3 $db, $actorEmail, $mailboxKey = '', $limit = 150) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $canViewAll = gmailViewerCanInspectAllMailboxes($actorEmail);
    $states = [];
    if ($canViewAll) {
        foreach (glob(gmailMailboxCacheRoot() . '/*/mailbox.json') ?: [] as $path) {
            $state = gmailReadJsonFile($path, []);
            if (!is_array($state) || empty($state)) continue;
            $states[] = $state;
        }
    } else {
        $ownState = gmailReadMailboxState(gmailMailboxIdentityForActor($actorEmail));
        if (!empty($ownState)) {
            $states[] = $ownState;
        }
    }
    usort($states, function ($a, $b) {
        return ((int)($b['last_sync_at'] ?? 0)) <=> ((int)($a['last_sync_at'] ?? 0));
    });
    $summaries = array_values(array_filter(array_map(function ($state) use ($db) {
        return gmailBuildMailboxSummary($db, $state);
    }, $states)));

    $selected = [];
    $requestedKey = trim((string)$mailboxKey);
    if ($requestedKey !== '') {
        foreach ($states as $state) {
            if ((string)($state['mailbox_key'] ?? '') === $requestedKey) {
                $selected = $state;
                break;
            }
        }
    }
    if (empty($selected) && !empty($states)) {
        $selected = $states[0];
    }

    return [
        'viewer' => [
            'actor_email' => $actorEmail,
            'can_view_all' => $canViewAll,
            'current_mailbox_email' => gmailMailboxIdentityForActor($actorEmail),
        ],
        'mailboxes' => $summaries,
        'selected_mailbox' => !empty($selected) ? gmailMailboxDebugDetail($db, $selected, $limit) : null,
    ];
}

function gmailBase64UrlEncode($value) {
    return rtrim(strtr(base64_encode((string)$value), '+/', '-_'), '=');
}

function gmailBase64UrlDecode($value) {
    $value = strtr((string)$value, '-_', '+/');
    $pad = strlen($value) % 4;
    if ($pad > 0) $value .= str_repeat('=', 4 - $pad);
    return base64_decode($value) ?: '';
}

function gmailPopupHtml($title, $message, array $payload = []) {
    $payloadJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($payloadJson === false) $payloadJson = '{}';
    $titleEsc = htmlspecialchars((string)$title, ENT_QUOTES);
    $messageEsc = htmlspecialchars((string)$message, ENT_QUOTES);
    return '<!doctype html><html><head><meta charset="utf-8"><title>' . $titleEsc . '</title>'
        . '<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#f6f8fb;color:#223040;padding:28px}h1{margin:0 0 10px;font-size:20px}p{margin:0;line-height:1.5}.card{max-width:520px;margin:40px auto;background:#fff;border:1px solid #d9e1ee;border-radius:16px;padding:24px;box-shadow:0 12px 40px rgba(16,24,40,.08)}</style>'
        . '</head><body><div class="card"><h1>' . $titleEsc . '</h1><p>' . $messageEsc . '</p></div>'
        . '<script>try{if(window.opener&&!window.opener.closed){window.opener.postMessage(' . $payloadJson . ',"*");}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},400);</script>'
        . '</body></html>';
}

function gmailEmitPopup($title, $message, array $payload = []) {
    if (!headers_sent()) {
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
    }
    echo gmailPopupHtml($title, $message, $payload);
}

function gmailTokenRequest(array $params) {
    $ch = curl_init('https://oauth2.googleapis.com/token');
    curl_setopt_array($ch, array_replace([
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_POSTFIELDS => http_build_query($params),
    ], gmailCurlSslOptions()));
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    $json = json_decode((string)$response, true);
    return [
        'ok' => $status >= 200 && $status < 300 && is_array($json),
        'status' => $status,
        'error' => $error ?: (($json['error_description'] ?? $json['error'] ?? '') ?: 'Google token request failed'),
        'data' => is_array($json) ? $json : [],
    ];
}

function gmailExchangeCode($code) {
    return gmailTokenRequest([
        'code' => $code,
        'client_id' => gmailClientId(),
        'client_secret' => gmailClientSecret(),
        'redirect_uri' => gmailRedirectUri(),
        'grant_type' => 'authorization_code',
    ]);
}

function gmailRefreshAccessTokenForActor($actorEmail) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailUserIntegrationData($actorEmail);
    $refreshToken = trim((string)($gmail['refresh_token'] ?? ''));
    if ($actorEmail === '' || $refreshToken === '') {
        return ['ok' => false, 'error' => 'No Gmail refresh token is stored for this user.'];
    }
    $token = gmailTokenRequest([
        'refresh_token' => $refreshToken,
        'client_id' => gmailClientId(),
        'client_secret' => gmailClientSecret(),
        'grant_type' => 'refresh_token',
    ]);
    if (empty($token['ok'])) return $token;
    $data = $token['data'];
    $gmail['access_token'] = (string)($data['access_token'] ?? '');
    $gmail['token_type'] = (string)($data['token_type'] ?? ($gmail['token_type'] ?? 'Bearer'));
    $gmail['scope'] = (string)($data['scope'] ?? ($gmail['scope'] ?? implode(' ', gmailScopes())));
    $gmail['expires_at'] = time() + max(60, (int)($data['expires_in'] ?? 3600)) - 30;
    $gmail['updated_at'] = gmdate('c');
    gmailWriteUserIntegrationData($actorEmail, $gmail);
    return ['ok' => true, 'data' => $gmail];
}

function gmailConnectedDataForActor($actorEmail, $refreshIfNeeded = true) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    if ($actorEmail === '' || !gmailIsConfigured()) return null;
    $gmail = gmailUserIntegrationData($actorEmail);
    if (empty($gmail['access_token']) && empty($gmail['refresh_token'])) return null;
    $expiresAt = (int)($gmail['expires_at'] ?? 0);
    if ($refreshIfNeeded && (!empty($gmail['refresh_token'])) && ($expiresAt <= (time() + 60) || empty($gmail['access_token']))) {
        $refreshed = gmailRefreshAccessTokenForActor($actorEmail);
        if (!empty($refreshed['ok'])) {
            $gmail = $refreshed['data'];
        }
    }
    return $gmail;
}

function gmailCalendarConnectedDataForActor($actorEmail, $refreshIfNeeded = true) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCalendarConnectedDataForActor($actorEmail);
    }
    $gmail = gmailConnectedDataForActor($actorEmail, $refreshIfNeeded);
    if (!is_array($gmail) || !gmailHasCalendarScopes($gmail)) return null;
    return $gmail;
}

function gmailApiRequestForActor($actorEmail, $method, $url, $body = null, array $headers = [], $retry = true) {
    if (
        function_exists('mockCommsEnabled')
        && mockCommsEnabled()
        && (
            stripos((string)$url, 'gmail.googleapis.com/gmail/') !== false
            || stripos((string)$url, 'www.googleapis.com/calendar/') !== false
        )
    ) {
        return ['ok' => false, 'status' => 423, 'error' => 'Real Google provider calls are disabled while CRM testing mode is enabled.'];
    }
    $gmail = gmailConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail) || empty($gmail['access_token'])) {
        return ['ok' => false, 'status' => 0, 'error' => 'Gmail is not connected for this user.', 'data' => null];
    }
    $requestHeaders = array_merge([
        'Authorization: Bearer ' . $gmail['access_token'],
        'Accept: application/json',
    ], $headers);
    $ch = curl_init($url);
    curl_setopt_array($ch, array_replace([
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => strtoupper((string)$method),
        CURLOPT_TIMEOUT => 25,
        CURLOPT_HTTPHEADER => $requestHeaders,
    ], gmailCurlSslOptions()));
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    $json = json_decode((string)$response, true);
    if ($status === 401 && $retry && !empty($gmail['refresh_token'])) {
        $refreshed = gmailRefreshAccessTokenForActor($actorEmail);
        if (!empty($refreshed['ok'])) {
            return gmailApiRequestForActor($actorEmail, $method, $url, $body, $headers, false);
        }
    }
    return [
        'ok' => $status >= 200 && $status < 300,
        'status' => $status,
        'error' => $error ?: (($json['error']['message'] ?? '') ?: ''),
        'data' => is_array($json) ? $json : null,
        'raw' => (string)$response,
    ];
}

function gmailApiGetProfile($actorEmail) {
    return gmailApiRequestForActor($actorEmail, 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
}

function gmailCalendarApiGetPrimary($actorEmail) {
    return gmailApiRequestForActor($actorEmail, 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary');
}

function gmailRefreshCalendarProfile($actorEmail) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        $calendar = mockCommsCalendarConnectionPublicState($actorEmail);
        $gmail = mockCommsCalendarConnectedDataForActor($actorEmail);
        return ['ok' => true, 'gmail' => $gmail, 'calendar' => $calendar];
    }
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailCalendarConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return ['ok' => false, 'error' => 'Google Calendar is not connected for this user.'];
    }
    $primary = gmailCalendarApiGetPrimary($actorEmail);
    if (empty($primary['ok']) || !is_array($primary['data'])) {
        return ['ok' => false, 'error' => $primary['error'] ?? 'Could not read Google Calendar profile'];
    }
    $gmail['calendar_primary_id'] = (string)($primary['data']['id'] ?? 'primary');
    $gmail['calendar_primary_summary'] = (string)($primary['data']['summary'] ?? 'Primary Calendar');
    $gmail['calendar_timezone'] = (string)($primary['data']['timeZone'] ?? ($gmail['calendar_timezone'] ?? ''));
    $gmail['updated_at'] = gmdate('c');
    gmailWriteUserIntegrationData($actorEmail, $gmail);
    return ['ok' => true, 'gmail' => $gmail, 'calendar' => $primary['data']];
}

function gmailCalendarListEventsForDateForActor($actorEmail, $date, $timezone = '') {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCalendarListEventsForDateForActor($actorEmail, $date, $timezone);
    }
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailCalendarConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return ['ok' => false, 'error' => 'Connect Google Calendar before viewing events from a lead.'];
    }
    $date = trim((string)$date);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return ['ok' => false, 'error' => 'Pick a valid calendar date first.'];
    }
    $tzName = trim((string)$timezone);
    if ($tzName === '') $tzName = trim((string)($gmail['calendar_timezone'] ?? ''));
    if ($tzName === '') $tzName = date_default_timezone_get() ?: 'UTC';
    try {
        $tz = new DateTimeZone($tzName);
        $start = new DateTimeImmutable($date . ' 00:00:00', $tz);
        $end = $start->modify('+1 day');
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => 'Could not build the Google Calendar day range'];
    }
    $query = http_build_query([
        'singleEvents' => 'true',
        'orderBy' => 'startTime',
        'timeMin' => $start->format(DateTimeInterface::RFC3339),
        'timeMax' => $end->format(DateTimeInterface::RFC3339),
    ]);
    return gmailApiRequestForActor(
        $actorEmail,
        'GET',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?' . $query
    );
}

function gmailCalendarGetEventForActor($actorEmail, $eventId) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCalendarGetEventForActor($actorEmail, $eventId);
    }
    $actorEmail = strtolower(trim((string)$actorEmail));
    $eventId = trim((string)$eventId);
    $gmail = gmailCalendarConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return ['ok' => false, 'error' => 'Connect Google Calendar before checking events from a lead.', 'status' => 0];
    }
    if ($eventId === '') {
        return ['ok' => false, 'error' => 'Missing Google Calendar event id', 'status' => 0];
    }
    return gmailApiRequestForActor(
        $actorEmail,
        'GET',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/' . rawurlencode($eventId)
    );
}

function gmailCalendarDeleteEventForActor($actorEmail, $eventId, $sendUpdates = true) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCalendarDeleteEventForActor($actorEmail, $eventId, $sendUpdates);
    }
    $actorEmail = strtolower(trim((string)$actorEmail));
    $eventId = trim((string)$eventId);
    $gmail = gmailCalendarConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return ['ok' => false, 'error' => 'Connect Google Calendar before cancelling events from a lead.', 'status' => 0];
    }
    if ($eventId === '') {
        return ['ok' => false, 'error' => 'Missing Google Calendar event id', 'status' => 0];
    }
    $query = http_build_query([
        'sendUpdates' => $sendUpdates ? 'all' : 'none',
    ]);
    return gmailApiRequestForActor(
        $actorEmail,
        'DELETE',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/' . rawurlencode($eventId) . '?' . $query
    );
}

function gmailIsoDateTimeInTimezone($timestamp, $timezone) {
    $timestamp = (int)$timestamp;
    if ($timestamp <= 0) return '';
    try {
        $dt = new DateTime('@' . $timestamp);
        $dt->setTimezone(new DateTimeZone(trim((string)$timezone) !== '' ? (string)$timezone : 'UTC'));
        return $dt->format('Y-m-d\TH:i:s');
    } catch (Throwable $e) {
        return gmdate('Y-m-d\TH:i:s', $timestamp);
    }
}

function gmailCalendarCreateEventForActor($actorEmail, array $payload) {
    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsCreateCalendarEventForActor($actorEmail, $payload);
    }
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailCalendarConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return ['ok' => false, 'error' => 'Connect Google Calendar before creating events from a lead.'];
    }
    $allDay = !empty($payload['all_day']);
    $allDayDate = trim((string)($payload['all_day_date'] ?? ''));
    $startTs = (int)($payload['start_ts'] ?? 0);
    $endTs = (int)($payload['end_ts'] ?? 0);
    $durationMinutes = max(15, min(480, (int)($payload['duration_minutes'] ?? 30)));
    if ($allDay) {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $allDayDate)) {
            return ['ok' => false, 'error' => 'Missing all-day event date'];
        }
    } else {
        if ($startTs <= 0) {
            return ['ok' => false, 'error' => 'Missing event start time'];
        }
        if ($endTs <= $startTs) {
            $endTs = $startTs + ($durationMinutes * 60);
        }
    }
    $timezone = trim((string)($payload['timezone'] ?? ($gmail['calendar_timezone'] ?? '')));
    if ($timezone === '') $timezone = date_default_timezone_get() ?: 'UTC';
    $attendees = [];
    foreach ((array)($payload['attendees'] ?? []) as $email) {
        $normalized = strtolower(trim((string)$email));
        if ($normalized === '' || !filter_var($normalized, FILTER_VALIDATE_EMAIL)) continue;
        $attendees[$normalized] = ['email' => $normalized];
    }
    $request = [
        'summary' => trim((string)($payload['summary'] ?? 'Scheduled follow-up')),
        'description' => (string)($payload['description'] ?? ''),
        'attendees' => array_values($attendees),
    ];
    if ($allDay) {
        try {
            $endDate = new DateTimeImmutable($allDayDate, new DateTimeZone($timezone));
            $endDate = $endDate->modify('+1 day');
            $request['start'] = ['date' => $allDayDate];
            $request['end'] = ['date' => $endDate->format('Y-m-d')];
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => 'Could not build the all-day Google Calendar event'];
        }
    } else {
        $request['start'] = [
            'dateTime' => gmailIsoDateTimeInTimezone($startTs, $timezone),
            'timeZone' => $timezone,
        ];
        $request['end'] = [
            'dateTime' => gmailIsoDateTimeInTimezone($endTs, $timezone),
            'timeZone' => $timezone,
        ];
    }
    if (!empty($payload['add_meet'])) {
        $request['conferenceData'] = [
            'createRequest' => [
                'requestId' => 'firstmate-' . bin2hex(random_bytes(12)),
                'conferenceSolutionKey' => ['type' => 'hangoutsMeet'],
            ],
        ];
    }
    $query = [
        'conferenceDataVersion' => !empty($payload['add_meet']) ? 1 : 0,
        'sendUpdates' => !empty($attendees) ? 'all' : 'none',
    ];
    return gmailApiRequestForActor(
        $actorEmail,
        'POST',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?' . http_build_query($query),
        json_encode($request),
        ['Content-Type: application/json']
    );
}

function gmailMimeBoundary($prefix = 'part') {
    try {
        return '=_FirstMate_' . preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$prefix) . '_' . bin2hex(random_bytes(12));
    } catch (Throwable $e) {
        return '=_FirstMate_' . preg_replace('/[^A-Za-z0-9_\-]/', '_', (string)$prefix) . '_' . md5(uniqid('', true));
    }
}

function gmailMimeBase64Lines($value) {
    return rtrim(chunk_split(base64_encode((string)$value), 76, "\r\n"));
}

function gmailMimeHeaderText($value) {
    $value = trim(str_replace(["\r", "\n"], ' ', (string)$value));
    if ($value === '') return '';
    if (preg_match('/[^\x20-\x7E]/', $value) && function_exists('mb_encode_mimeheader')) {
        return mb_encode_mimeheader($value, 'UTF-8', 'B', "\r\n");
    }
    return $value;
}

function gmailMimeMailbox($email, $displayName = '') {
    $email = strtolower(trim((string)$email));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) return '';
    $displayName = trim(str_replace(["\r", "\n"], ' ', (string)$displayName));
    if ($displayName === '') return $email;
    return gmailMimeHeaderText($displayName) . ' <' . $email . '>';
}

function gmailOutboundIdentityForActor($actorEmail) {
    $actorEmail = strtolower(trim((string)$actorEmail));
    $gmail = gmailConnectedDataForActor($actorEmail, true);
    if (!is_array($gmail)) {
        return [
            'email' => $actorEmail,
            'display_name' => function_exists('leadUserDisplayNameByEmail') ? leadUserDisplayNameByEmail($actorEmail) : '',
            'reply_to' => '',
        ];
    }

    $sendAsEmail = trim((string)($gmail['send_as_email'] ?? ($gmail['email'] ?? $actorEmail)));
    $displayName = trim((string)($gmail['send_as_display_name'] ?? ''));
    $replyTo = trim((string)($gmail['send_as_reply_to'] ?? ''));
    $signatureUpdatedAt = (int)(strtotime((string)($gmail['signature_updated_at'] ?? '')) ?: 0);
    $needsRefresh = gmailHasSignatureScope($gmail)
        && ($sendAsEmail === '' || $displayName === '' || $signatureUpdatedAt <= 0 || $signatureUpdatedAt < (time() - 86400));

    if ($needsRefresh) {
        $refreshed = gmailRefreshSignatureForActor($actorEmail);
        if (!empty($refreshed['ok']) && !empty($refreshed['data']) && is_array($refreshed['data'])) {
            $gmail = $refreshed['data'];
            $sendAsEmail = trim((string)($gmail['send_as_email'] ?? ($gmail['email'] ?? $actorEmail)));
            $displayName = trim((string)($gmail['send_as_display_name'] ?? ''));
            $replyTo = trim((string)($gmail['send_as_reply_to'] ?? ''));
        }
    }

    if ($sendAsEmail === '' || !filter_var($sendAsEmail, FILTER_VALIDATE_EMAIL)) {
        $sendAsEmail = trim((string)($gmail['email'] ?? $actorEmail));
    }
    if ($displayName === '' && function_exists('leadUserDisplayNameByEmail')) {
        $displayName = leadUserDisplayNameByEmail($actorEmail);
    }

    return [
        'email' => $sendAsEmail,
        'display_name' => $displayName,
        'reply_to' => $replyTo,
    ];
}

function gmailMimeBodyText(array $payload) {
    $bodyText = (string)($payload['body_text'] ?? ($payload['body'] ?? ''));
    $bodyText = str_replace(["\r\n", "\r"], "\n", $bodyText);
    return $bodyText;
}

function gmailMimeBodyHtml(array $payload) {
    $bodyHtml = (string)($payload['body_html'] ?? '');
    if ($bodyHtml !== '') return $bodyHtml;
    $bodyText = gmailMimeBodyText($payload);
    if ($bodyText === '') return '';
    return nl2br(htmlspecialchars($bodyText, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'));
}

function gmailMimeNormalizeAttachments($attachments) {
    $normalized = [];
    foreach ((array)$attachments as $item) {
        if (!is_array($item)) continue;
        $filename = trim((string)($item['filename'] ?? 'attachment'));
        $filename = preg_replace('/[\r\n]+/', ' ', $filename);
        if ($filename === '') $filename = 'attachment';
        $mimeType = trim((string)($item['mime_type'] ?? 'application/octet-stream'));
        $contentBase64 = trim((string)($item['content_base64'] ?? ''));
        if ($contentBase64 === '' && array_key_exists('content', $item)) {
            $contentBase64 = base64_encode((string)$item['content']);
        }
        if ($contentBase64 === '') continue;
        $normalized[] = [
            'filename' => $filename,
            'mime_type' => $mimeType !== '' ? $mimeType : 'application/octet-stream',
            'content_base64' => preg_replace('/\s+/', '', $contentBase64),
        ];
    }
    return $normalized;
}

function gmailMimeAlternativeSection($bodyText, $bodyHtml, $boundary) {
    $sections = [];
    if ($bodyText !== '') {
        $sections[] = '--' . $boundary . "\r\n"
            . 'Content-Type: text/plain; charset=UTF-8' . "\r\n"
            . 'Content-Transfer-Encoding: base64' . "\r\n\r\n"
            . gmailMimeBase64Lines($bodyText);
    }
    if ($bodyHtml !== '') {
        $sections[] = '--' . $boundary . "\r\n"
            . 'Content-Type: text/html; charset=UTF-8' . "\r\n"
            . 'Content-Transfer-Encoding: base64' . "\r\n\r\n"
            . gmailMimeBase64Lines($bodyHtml);
    }
    if (!$sections) {
        $sections[] = '--' . $boundary . "\r\n"
            . 'Content-Type: text/plain; charset=UTF-8' . "\r\n"
            . 'Content-Transfer-Encoding: base64' . "\r\n\r\n"
            . gmailMimeBase64Lines('');
    }
    $sections[] = '--' . $boundary . '--';
    return implode("\r\n", $sections);
}

function gmailGenerateOutboundMessageId() {
    $host = preg_replace('/[^A-Za-z0-9.\-]/', '', (string)($_SERVER['HTTP_HOST'] ?? 'firstmate.local'));
    return '<' . uniqid('crm-', true) . '@' . ($host !== '' ? $host : 'firstmate.local') . '>';
}

function gmailExtractMessageIdHeaders($value) {
    preg_match_all('/<[^<>\r\n]+>/', (string)$value, $matches);
    $ids = array_map(function ($entry) {
        return trim((string)$entry);
    }, $matches[0] ?? []);
    return array_values(array_unique(array_filter($ids)));
}

function gmailMergeMessageIdHeaders(...$values) {
    $merged = [];
    foreach ($values as $value) {
        foreach (gmailExtractMessageIdHeaders($value) as $id) {
            if (!in_array($id, $merged, true)) $merged[] = $id;
        }
    }
    return $merged;
}

function gmailMimeMessage(array $payload) {
    $to = trim((string)($payload['to'] ?? ''));
    $cc = trim((string)($payload['cc'] ?? ''));
    $bcc = trim((string)($payload['bcc'] ?? ''));
    $from = trim((string)($payload['from'] ?? ''));
    $replyTo = trim((string)($payload['reply_to'] ?? ''));
    $subject = gmailMimeHeaderText($payload['subject'] ?? '');
    $bodyText = gmailMimeBodyText($payload);
    $bodyHtml = gmailMimeBodyHtml($payload);
    if ($bodyText === '' && $bodyHtml !== '') {
        $bodyText = gmailHtmlToPlainText($bodyHtml);
    }
    $attachments = gmailMimeNormalizeAttachments($payload['attachments'] ?? []);
    $messageId = trim((string)($payload['message_id'] ?? ''));
    if ($messageId === '') {
        $messageId = gmailGenerateOutboundMessageId();
    }
    $headers = [
        'MIME-Version: 1.0',
        'To: ' . $to,
        'Subject: ' . $subject,
        'Message-ID: ' . $messageId,
    ];
    if ($from !== '') $headers[] = 'From: ' . $from;
    if ($replyTo !== '') $headers[] = 'Reply-To: ' . $replyTo;
    if ($cc !== '') $headers[] = 'Cc: ' . $cc;
    if ($bcc !== '') $headers[] = 'Bcc: ' . $bcc;
    $inReplyToIds = gmailExtractMessageIdHeaders($payload['in_reply_to'] ?? '');
    $inReplyTo = $inReplyToIds ? end($inReplyToIds) : '';
    $references = implode(' ', gmailMergeMessageIdHeaders($payload['references'] ?? '', $inReplyTo));
    if ($inReplyTo !== '') $headers[] = 'In-Reply-To: ' . $inReplyTo;
    if ($references !== '') $headers[] = 'References: ' . $references;

    if ($attachments) {
        $mixedBoundary = gmailMimeBoundary('mixed');
        $altBoundary = gmailMimeBoundary('alt');
        $headers[] = 'Content-Type: multipart/mixed; boundary="' . $mixedBoundary . '"';
        $parts = [];
        $parts[] = 'This is a multi-part message in MIME format.';
        $parts[] = '--' . $mixedBoundary . "\r\n"
            . 'Content-Type: multipart/alternative; boundary="' . $altBoundary . '"' . "\r\n\r\n"
            . gmailMimeAlternativeSection($bodyText, $bodyHtml, $altBoundary);
        foreach ($attachments as $attachment) {
            $parts[] = '--' . $mixedBoundary . "\r\n"
                . 'Content-Type: ' . $attachment['mime_type'] . '; name="' . addslashes($attachment['filename']) . '"' . "\r\n"
                . 'Content-Disposition: attachment; filename="' . addslashes($attachment['filename']) . '"' . "\r\n"
                . 'Content-Transfer-Encoding: base64' . "\r\n\r\n"
                . rtrim(chunk_split($attachment['content_base64'], 76, "\r\n"));
        }
        $parts[] = '--' . $mixedBoundary . '--';
        return implode("\r\n", $headers) . "\r\n\r\n" . implode("\r\n", $parts);
    }

    if ($bodyHtml !== '' && $bodyText !== '') {
        $altBoundary = gmailMimeBoundary('alt');
        $headers[] = 'Content-Type: multipart/alternative; boundary="' . $altBoundary . '"';
        return implode("\r\n", $headers) . "\r\n\r\n" . gmailMimeAlternativeSection($bodyText, $bodyHtml, $altBoundary);
    }

    if ($bodyHtml !== '') {
        $headers[] = 'Content-Type: text/html; charset=UTF-8';
        $headers[] = 'Content-Transfer-Encoding: base64';
        return implode("\r\n", $headers) . "\r\n\r\n" . gmailMimeBase64Lines($bodyHtml);
    }

    $headers[] = 'Content-Type: text/plain; charset=UTF-8';
    $headers[] = 'Content-Transfer-Encoding: base64';
    return implode("\r\n", $headers) . "\r\n\r\n" . gmailMimeBase64Lines($bodyText);
}

function gmailSendMessageForActor($actorEmail, array $payload) {
    $identity = gmailOutboundIdentityForActor($actorEmail);
    if (empty($payload['from_email']) && !empty($identity['email'])) {
        $payload['from_email'] = $identity['email'];
    }
    if (empty($payload['from_name']) && !empty($identity['display_name'])) {
        $payload['from_name'] = $identity['display_name'];
    }
    if (empty($payload['reply_to']) && !empty($identity['reply_to'])) {
        $payload['reply_to'] = $identity['reply_to'];
    }
    if (empty($payload['from']) && !empty($payload['from_email'])) {
        $payload['from'] = gmailMimeMailbox(
            (string)$payload['from_email'],
            (string)($payload['from_name'] ?? '')
        );
    }
    if (empty($payload['reply_to']) && !empty($payload['from_email'])) {
        $payload['reply_to'] = gmailMimeMailbox(
            (string)$payload['from_email'],
            (string)($payload['from_name'] ?? '')
        );
    } elseif (!empty($payload['reply_to']) && strpos((string)$payload['reply_to'], '<') === false) {
        $payload['reply_to'] = gmailMimeMailbox((string)$payload['reply_to']);
    }
    $inReplyToIds = gmailExtractMessageIdHeaders($payload['in_reply_to'] ?? '');
    $payload['in_reply_to'] = $inReplyToIds ? end($inReplyToIds) : '';
    $payload['references'] = implode(' ', gmailMergeMessageIdHeaders(
        $payload['references'] ?? '',
        $payload['in_reply_to'] ?? ''
    ));
    if (empty($payload['message_id'])) {
        $payload['message_id'] = gmailGenerateOutboundMessageId();
    }

    if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
        return mockCommsGmailSendMessageForActor($actorEmail, $payload);
    }
    $raw = gmailBase64UrlEncode(gmailMimeMessage($payload));
    $request = ['raw' => $raw];
    $threadId = trim((string)($payload['thread_id'] ?? ''));
    if ($threadId !== '') $request['threadId'] = $threadId;
    $response = gmailApiRequestForActor(
        $actorEmail,
        'POST',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        json_encode($request),
        ['Content-Type: application/json']
    );
    $data = is_array($response['data'] ?? null) ? $response['data'] : [];
    if (!isset($response['id']) && !empty($data['id'])) {
        $response['id'] = (string)$data['id'];
    }
    if (!isset($response['threadId']) && !empty($data['threadId'])) {
        $response['threadId'] = (string)$data['threadId'];
    }
    if (!isset($response['labelIds']) && !empty($data['labelIds']) && is_array($data['labelIds'])) {
        $response['labelIds'] = array_values(array_map('strval', $data['labelIds']));
    }
    $response['message_id_header'] = (string)$payload['message_id'];
    $response['in_reply_to'] = (string)($payload['in_reply_to'] ?? '');
    $response['references'] = (string)($payload['references'] ?? '');
    return $response;
}

function gmailExtractEmails($text) {
    $text = (string)$text;
    if ($text === '') return [];
    preg_match_all('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $matches);
    $emails = array_map(function ($value) {
        return strtolower(trim((string)$value));
    }, $matches[0] ?? []);
    return array_values(array_unique(array_filter($emails)));
}

function gmailHeaderValue(array $headers, $name) {
    $target = strtolower((string)$name);
    foreach ($headers as $header) {
        if (strtolower((string)($header['name'] ?? '')) === $target) {
            return (string)($header['value'] ?? '');
        }
    }
    return '';
}

function gmailPayloadBodyText(array $payload) {
    $mime = strtolower((string)($payload['mimeType'] ?? ''));
    $bodyData = (string)($payload['body']['data'] ?? '');
    if ($mime === 'text/plain' && $bodyData !== '') {
        return gmailBase64UrlDecode($bodyData);
    }
    if (!empty($payload['parts']) && is_array($payload['parts'])) {
        foreach ($payload['parts'] as $part) {
            $text = gmailPayloadBodyText(is_array($part) ? $part : []);
            if ($text !== '') return $text;
        }
    }
    if ($bodyData !== '') {
        $decoded = gmailBase64UrlDecode($bodyData);
        if ($mime === 'text/html') {
            return trim(html_entity_decode(strip_tags($decoded)));
        }
        return $decoded;
    }
    return '';
}

function gmailLeadAddresses(array $leadRow) {
    $emails = [];
    $leadEmail = strtolower(trim((string)($leadRow['email'] ?? '')));
    if ($leadEmail !== '' && filter_var($leadEmail, FILTER_VALIDATE_EMAIL)) $emails[] = $leadEmail;
    foreach (($leadRow['contacts'] ?? []) as $contact) {
        $email = strtolower(trim((string)($contact['email'] ?? '')));
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) $emails[] = $email;
    }
    return array_values(array_unique($emails));
}

function gmailLeadActivityUpsert(SQLite3 $db, $leadId, $actor, array $payload, $now) {
    $relatedId = trim((string)($payload['related_id'] ?? ''));
    if ($relatedId === '') {
        return leadInsertActivity($db, $leadId, $actor, $payload, $now);
    }
    $existing = leadActivityRowByRelatedId($db, $leadId, (string)($payload['activity_type'] ?? ''), $relatedId);
    if (!$existing) {
        return leadInsertActivity($db, $leadId, $actor, $payload, $now);
    }
    $metadataJson = null;
    if (array_key_exists('metadata', $payload)) {
        $metadataJson = json_encode($payload['metadata']);
    }
    $stmt = $db->prepare("
        UPDATE lead_activity_items
        SET owner_email = :owner_email,
            direction = :direction,
            subject = :subject,
            body_text = :body_text,
            metadata_json = :metadata_json,
            happened_at = :happened_at,
            updated_at = :updated_at,
            updated_by_email = :updated_by_email
        WHERE id = :id
    ");
    leadBindText($stmt, ':owner_email', (string)($payload['owner_email'] ?? $actor));
    leadBindText($stmt, ':direction', (string)($payload['direction'] ?? ''));
    leadBindText($stmt, ':subject', (string)($payload['subject'] ?? ''));
    leadBindText($stmt, ':body_text', (string)($payload['body_text'] ?? ''));
    if ($metadataJson === null || $metadataJson === 'null') $stmt->bindValue(':metadata_json', null, SQLITE3_NULL);
    else leadBindText($stmt, ':metadata_json', $metadataJson);
    $stmt->bindValue(':happened_at', (int)($payload['happened_at'] ?? $now), SQLITE3_INTEGER);
    $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    leadBindText($stmt, ':updated_by_email', $actor);
    leadBindText($stmt, ':id', (string)$existing['id']);
    $stmt->execute();
    return (string)$existing['id'];
}

function gmailSyncLeadActivity(SQLite3 $db, array $leadRow, $actorEmail, $now, $force = false) {
    $mailboxSync = gmailSyncMailboxForActor($db, $actorEmail, $now, $force, $force ? 'lead_force_sync' : 'lead_load');
    if (empty($mailboxSync['ok']) && !empty($mailboxSync['skipped'])) {
        return $mailboxSync;
    }
    if (empty($mailboxSync['ok'])) {
        return $mailboxSync;
    }
    $association = gmailAssociateMailboxMessagesForLead($db, $leadRow, $actorEmail, $now, $force);
    return [
        'ok' => true,
        'mailbox_sync' => $mailboxSync,
        'assigned' => (int)($association['assigned'] ?? 0),
        'cached' => !empty($association['cached']),
    ];
}

function handleGmailActions($action) {
    if ($action === 'gmail_connection_status' || $action === 'google_connection_status') {
        $actor = gmailSessionUserEmail();
        if ($actor === '') {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        echo json_encode(['success' => true, 'gmail' => gmailConnectionPublicStateForActor($actor)]);
        return true;
    }

    if ($action === 'gmail_background_sync') {
        $actor = gmailSessionUserEmail();
        if ($actor === '') {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        if (!function_exists('leadDb')) {
            echo json_encode(['success' => false, 'error' => 'Lead database is not available']);
            return true;
        }
        $sync = gmailSyncMailboxForActor(leadDb(), $actor, time(), false, 'background');
        if (empty($sync['ok']) && empty($sync['skipped'])) {
            echo json_encode(['success' => false, 'error' => $sync['error'] ?? 'Could not sync Gmail mailbox']);
            return true;
        }
        echo json_encode([
            'success' => true,
            'sync' => $sync,
            'gmail' => gmailConnectionPublicStateForActor($actor),
        ]);
        return true;
    }

    if ($action === 'gmail_debug_snapshot') {
        $actor = gmailSessionUserEmail();
        if ($actor === '') {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        if (!function_exists('leadDb')) {
            echo json_encode(['success' => false, 'error' => 'Lead database is not available']);
            return true;
        }
        $mailboxKey = trim((string)($_POST['mailbox_key'] ?? $_GET['mailbox_key'] ?? ''));
        $limit = max(25, min(300, (int)($_POST['limit'] ?? $_GET['limit'] ?? 150)));
        echo json_encode([
            'success' => true,
            'debug' => gmailDebugSnapshot(leadDb(), $actor, $mailboxKey, $limit),
        ]);
        return true;
    }

    if ($action === 'gmail_begin_connect' || $action === 'google_begin_connect') {
        if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
            gmailEmitPopup(
                'Google Connection',
                'CRM testing mode is enabled, so Gmail uses the internal mock provider instead of a real Google connection.',
                ['type' => 'firstmate-gmail-connected', 'gmail' => gmailConnectionPublicStateForActor(gmailSessionUserEmail())]
            );
            return true;
        }
        $actor = gmailSessionUserEmail();
        if ($actor === '') {
            http_response_code(403);
            gmailEmitPopup('Google Connection', 'You must be signed in to connect Google services.', ['type' => 'firstmate-gmail-error']);
            return true;
        }
        if (!gmailIsConfigured()) {
            gmailEmitPopup(
                'Google Connection',
                'Google integrations are not configured on this server yet. Add the Google client ID and client secret first.',
                ['type' => 'firstmate-gmail-error', 'reason' => 'missing_config']
            );
            return true;
        }
        $state = bin2hex(random_bytes(24));
        $statePayload = [
            'state' => $state,
            'email' => $actor,
            'created_at' => time(),
            'redirect_uri' => gmailRedirectUri(),
        ];
        $_SESSION['gmail_oauth_state'] = $statePayload;
        gmailPruneOauthStates();
        gmailWriteOauthState($state, $statePayload);
        $params = [
            'client_id' => gmailClientId(),
            'redirect_uri' => gmailRedirectUri(),
            'response_type' => 'code',
            'access_type' => 'offline',
            'prompt' => 'consent',
            'scope' => implode(' ', gmailScopes()),
            'state' => $state,
            'include_granted_scopes' => 'true',
        ];
        header('Location: https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query($params));
        return true;
    }

    if ($action === 'gmail_oauth_callback') {
        $error = trim((string)($_GET['error'] ?? ''));
        if ($error !== '') {
            gmailEmitPopup('Google Connection', 'Google returned an error: ' . $error, ['type' => 'firstmate-gmail-error', 'reason' => $error]);
            return true;
        }
        $receivedState = trim((string)($_GET['state'] ?? ''));
        $code = trim((string)($_GET['code'] ?? ''));
        $sessionState = $_SESSION['gmail_oauth_state'] ?? [];
        $storedState = [];
        if ($receivedState !== '') {
            $storedState = gmailReadOauthState($receivedState);
        }
        unset($_SESSION['gmail_oauth_state']);
        if (!is_array($sessionState)) $sessionState = [];
        if (!is_array($storedState)) $storedState = [];
        $stateSource = $sessionState;
        $sessionExpectedState = (string)($sessionState['state'] ?? '');
        if ($sessionExpectedState === '' || $receivedState === '' || !hash_equals($sessionExpectedState, $receivedState)) {
            $stateSource = $storedState;
        }
        $expectedState = (string)($stateSource['state'] ?? '');
        $actor = strtolower(trim((string)($stateSource['email'] ?? '')));
        $createdAt = (int)($stateSource['created_at'] ?? 0);
        gmailDeleteOauthState($receivedState);
        $stateExpired = ($createdAt > 0 && $createdAt < (time() - 1800));
        if ($expectedState === '' || $receivedState === '' || !hash_equals($expectedState, $receivedState) || $actor === '') {
            gmailEmitPopup('Google Connection', 'The Google connection state could not be verified. Please try again.', ['type' => 'firstmate-gmail-error', 'reason' => 'invalid_state']);
            return true;
        }
        if ($stateExpired) {
            gmailEmitPopup('Google Connection', 'The Google connection took too long to finish. Please try again.', ['type' => 'firstmate-gmail-error', 'reason' => 'expired_state']);
            return true;
        }
        $token = gmailExchangeCode($code);
        if (empty($token['ok'])) {
            gmailEmitPopup('Google Connection', 'Could not finish the Google connection: ' . ($token['error'] ?? 'Unknown error'), ['type' => 'firstmate-gmail-error', 'reason' => 'token_exchange_failed']);
            return true;
        }
        $gmailData = gmailUserIntegrationData($actor);
        $tokenData = $token['data'];
        $gmailData['access_token'] = (string)($tokenData['access_token'] ?? '');
        if (!empty($tokenData['refresh_token'])) {
            $gmailData['refresh_token'] = (string)$tokenData['refresh_token'];
        }
        $gmailData['token_type'] = (string)($tokenData['token_type'] ?? 'Bearer');
        $gmailData['scope'] = (string)($tokenData['scope'] ?? implode(' ', gmailScopes()));
        $gmailData['expires_at'] = time() + max(60, (int)($tokenData['expires_in'] ?? 3600)) - 30;
        $gmailData['connected_at'] = $gmailData['connected_at'] ?? gmdate('c');
        $gmailData['updated_at'] = gmdate('c');
        gmailWriteUserIntegrationData($actor, $gmailData);
        $profile = gmailApiGetProfile($actor);
        if (!empty($profile['ok']) && !empty($profile['data']['emailAddress'])) {
            $gmailData = gmailUserIntegrationData($actor);
            $gmailData['email'] = (string)$profile['data']['emailAddress'];
            $gmailData['history_id'] = (string)($profile['data']['historyId'] ?? '');
            $gmailData['updated_at'] = gmdate('c');
            gmailWriteUserIntegrationData($actor, $gmailData);
            gmailRegisterMailboxForActor($actor, $gmailData, time());
            if (gmailHasSignatureScope($gmailData)) {
                gmailRefreshSignatureForActor($actor);
            }
            if (gmailHasCalendarScopes($gmailData)) {
                gmailRefreshCalendarProfile($actor);
            }
        }
        gmailEmitPopup(
            'Google Connected',
            'Your Google account is now connected to FirstMate CRM for Gmail and Calendar.',
            ['type' => 'firstmate-gmail-connected', 'gmail' => gmailConnectionPublicStateForActor($actor)]
        );
        return true;
    }

    if ($action === 'gmail_disconnect' || $action === 'google_disconnect') {
        $actor = gmailSessionUserEmail();
        if ($actor === '') {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        if (function_exists('mockCommsEnabled') && mockCommsEnabled()) {
            echo json_encode(['success' => true, 'gmail' => gmailConnectionPublicStateForActor($actor)]);
            return true;
        }
        gmailDisconnectUser($actor);
        echo json_encode(['success' => true, 'gmail' => gmailConnectionPublicStateForActor($actor)]);
        return true;
    }

    return false;
}
