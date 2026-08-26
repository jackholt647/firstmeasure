<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/_storage.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: ' . firstmateAllowedOrigin());
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Headers: Content-Type, X-FirstMate-Secret');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const FIRSTMATE_SHARED_SECRET = '';
const FIRSTMATE_MAX_COMMANDS = 50;

function firstmateAllowedOrigin(): string {
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    if (preg_match('/^chrome-extension:\/\/[a-z]{32}$/', $origin)) {
        return $origin;
    }
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    if ($origin !== '' && parse_url($origin, PHP_URL_HOST) === preg_replace('/:\d+$/', '', $host)) {
        return $origin;
    }
    return 'null';
}

function firstmateJsonPath(): string {
    return firstmateSalesStoragePath('firstmate-bridge', 'commands.json', true);
}

function firstmateReadState(): array {
    $path = firstmateSalesExistingStoragePath('firstmate-bridge', 'commands.json');
    if (!is_file($path)) {
        return ['commands' => [], 'events' => []];
    }
    $decoded = json_decode((string)file_get_contents($path), true);
    return is_array($decoded) ? array_merge(['commands' => [], 'events' => []], $decoded) : ['commands' => [], 'events' => []];
}

function firstmateWriteState(array $state): bool {
    $path = firstmateJsonPath();
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    return $json !== false && file_put_contents($path, $json, LOCK_EX) !== false;
}

function firstmateNodeV1BaseUrl(): string {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function firstmatePostNodeJson(string $path, array $payload): array {
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'PHP cURL is not available.'];
    }
    $ch = curl_init(rtrim(firstmateNodeV1BaseUrl(), '/') . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json'],
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
        CURLOPT_TIMEOUT => 20,
    ]);
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($response === false || $response === '') {
        return ['ok' => false, 'status' => $status, 'error' => $error ?: 'Empty Node CRM response'];
    }
    $decoded = json_decode((string)$response, true);
    return [
        'ok' => $status >= 200 && $status < 300,
        'status' => $status,
        'data' => is_array($decoded) ? $decoded : ['raw' => $response],
    ];
}

function firstmateCrmLeadsDbPath(): string {
    $publicRoot = dirname(__DIR__, 3);
    $candidates = [
        $publicRoot . '/v1/storage/crm/databases/leads.sqlite',
        $publicRoot . '/storage/measure/internal/databases/leads.sqlite',
        $publicRoot . '/measure/internal/storage/databases/leads.sqlite',
    ];
    foreach ($candidates as $path) {
        if (is_file($path)) {
            return $path;
        }
    }
    return $candidates[0];
}

function firstmateContactId(): string {
    return 'contact_' . bin2hex(random_bytes(8));
}

function firstmateContactFullName(array $contact): string {
    $first = trim((string)($contact['firstName'] ?? $contact['first_name'] ?? ''));
    $last = trim((string)($contact['lastName'] ?? $contact['last_name'] ?? ''));
    $full = trim((string)($contact['fullName'] ?? $contact['full_name'] ?? ''));
    return $full !== '' ? $full : trim($first . ' ' . $last);
}

function firstmateFetchContact(SQLite3 $db, string $leadId, string $contactId): array {
    $stmt = $db->prepare('SELECT * FROM lead_contacts WHERE lead_id = :lead_id AND id = :id LIMIT 1');
    $stmt->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
    $stmt->bindValue(':id', $contactId, SQLITE3_TEXT);
    $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    return is_array($row) ? $row : [];
}

function firstmateFirstLeadContact(SQLite3 $db, string $leadId): array {
    $stmt = $db->prepare('SELECT * FROM lead_contacts WHERE lead_id = :lead_id ORDER BY updated_at DESC, created_at DESC LIMIT 1');
    $stmt->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
    $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    return is_array($row) ? $row : [];
}

function firstmateSavePrimaryContact(array $contact): array {
    if (!class_exists('SQLite3')) {
        return ['success' => false, 'ok' => false, 'error' => 'PHP SQLite3 is not available.'];
    }
    $leadId = trim((string)($contact['leadId'] ?? $contact['lead_id'] ?? ''));
    if ($leadId === '' || !preg_match('/^[a-zA-Z0-9_.:-]+$/', $leadId)) {
        return ['success' => false, 'ok' => false, 'error' => 'Missing or invalid lead id.'];
    }
    $fullName = firstmateContactFullName($contact);
    $email = strtolower(trim((string)($contact['email'] ?? '')));
    if ($fullName === '' && $email === '') {
        return ['success' => true, 'ok' => true, 'skipped' => true, 'contact' => null];
    }
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return ['success' => false, 'ok' => false, 'error' => 'Invalid contact email.'];
    }
    $path = firstmateCrmLeadsDbPath();
    if (!is_file($path)) {
        return ['success' => false, 'ok' => false, 'error' => 'CRM leads database was not found.', 'path' => $path];
    }
    $db = new SQLite3($path);
    $db->busyTimeout(5000);
    $now = time();
    $actor = 'firstmate-extension@1m8.ai';
    $contactId = trim((string)($contact['contactId'] ?? $contact['contact_id'] ?? ''));
    if ($contactId !== '' && !preg_match('/^[a-zA-Z0-9_.:-]+$/', $contactId)) {
        $contactId = '';
    }
    $existing = $contactId !== '' ? firstmateFetchContact($db, $leadId, $contactId) : firstmateFirstLeadContact($db, $leadId);
    if (!empty($existing)) {
        $contactId = (string)$existing['id'];
        $savedFullName = $fullName !== '' ? $fullName : (string)($existing['full_name'] ?? '');
        $savedEmail = $email !== '' ? $email : (string)($existing['email'] ?? '');
        $stmt = $db->prepare('
            UPDATE lead_contacts
            SET full_name = :full_name,
                email = :email,
                updated_at = :updated_at,
                updated_by_email = :updated_by_email
            WHERE id = :id AND lead_id = :lead_id
        ');
        $stmt->bindValue(':id', $contactId, SQLITE3_TEXT);
        $stmt->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
        $stmt->bindValue(':full_name', $savedFullName, SQLITE3_TEXT);
        $stmt->bindValue(':email', $savedEmail, SQLITE3_TEXT);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':updated_by_email', $actor, SQLITE3_TEXT);
        $stmt->execute();
    } else {
        $contactId = $contactId !== '' ? $contactId : firstmateContactId();
        $stmt = $db->prepare('
            INSERT INTO lead_contacts (
                id, lead_id, owner_email, full_name, title, email, phone, notes,
                created_at, updated_at, created_by_email, updated_by_email, metadata_json
            ) VALUES (
                :id, :lead_id, :owner_email, :full_name, "", :email, "", "",
                :created_at, :updated_at, :created_by_email, :updated_by_email, "{}"
            )
        ');
        $stmt->bindValue(':id', $contactId, SQLITE3_TEXT);
        $stmt->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
        $stmt->bindValue(':owner_email', $actor, SQLITE3_TEXT);
        $stmt->bindValue(':full_name', $fullName, SQLITE3_TEXT);
        $stmt->bindValue(':email', $email, SQLITE3_TEXT);
        $stmt->bindValue(':created_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':updated_at', $now, SQLITE3_INTEGER);
        $stmt->bindValue(':created_by_email', $actor, SQLITE3_TEXT);
        $stmt->bindValue(':updated_by_email', $actor, SQLITE3_TEXT);
        $stmt->execute();
    }

    $touch = $db->prepare('UPDATE lead_memberships SET updated_at = :updated_at, updated_by_email = :updated_by_email WHERE id = :id');
    $touch->bindValue(':id', $leadId, SQLITE3_TEXT);
    $touch->bindValue(':updated_at', $now, SQLITE3_INTEGER);
    $touch->bindValue(':updated_by_email', $actor, SQLITE3_TEXT);
    $touch->execute();

    return [
        'success' => true,
        'ok' => true,
        'contact' => firstmateFetchContact($db, $leadId, $contactId),
    ];
}

function firstmateSalesDispositionNote(array $event): string {
    $lead = is_array($event['lead'] ?? null) ? $event['lead'] : [];
    $emailEvent = is_array($event['emailEvent'] ?? null) ? $event['emailEvent'] : [];
    $recipients = is_array($emailEvent['recipients'] ?? null) ? $emailEvent['recipients'] : [];
    $recipientAll = is_array($recipients['all'] ?? null) ? $recipients['all'] : [];
    $reports = is_array($emailEvent['reports'] ?? null) ? $emailEvent['reports'] : [];
    $lines = [
        'FirstMate disposition: ' . (string)($event['disposition'] ?? ''),
    ];
    if (!empty($event['contactType'])) {
        $lines[] = 'Reached: ' . (string)$event['contactType'];
    }
    if (!empty($event['signupEmail'])) {
        $lines[] = 'Signup email: ' . (string)$event['signupEmail'];
    }
    $lines[] = !empty($event['emailSent']) ? 'Gmail email sent: yes' : 'Gmail email sent: no';
    if (!empty($recipientAll)) {
        $lines[] = 'Email recipients: ' . implode(', ', array_map('strval', $recipientAll));
    }
    if (!empty($reports)) {
        $reportNames = [];
        foreach ($reports as $report) {
            if (is_array($report)) {
                $reportNames[] = (string)($report['filename'] ?? $report['name'] ?? $report['id'] ?? '');
            } else {
                $reportNames[] = (string)$report;
            }
        }
        $reportNames = array_values(array_filter($reportNames));
        if (!empty($reportNames)) {
            $lines[] = 'Reports attached: ' . implode(', ', $reportNames);
        }
    }
    if (!empty($lead['company'])) {
        $lines[] = 'Company: ' . (string)$lead['company'];
    }
    if (!empty($event['at'])) {
        $lines[] = 'Captured at: ' . (string)$event['at'];
    }
    return implode("\n", array_filter($lines));
}

function firstmateMaybeSaveSalesDispositionToCrm(array &$event): void {
    if (($event['action'] ?? '') !== 'sales_disposition') {
        return;
    }
    $lead = is_array($event['lead'] ?? null) ? $event['lead'] : [];
    $leadId = (string)($lead['crmId'] ?? $lead['id'] ?? $event['leadId'] ?? '');
    if ($leadId === '' || !preg_match('/^[a-zA-Z0-9_.:-]+$/', $leadId)) {
        $event['crm_note_result'] = ['ok' => false, 'error' => 'Missing CRM lead id'];
        return;
    }
    $event['crm_note_result'] = firstmatePostNodeJson('/internal/crm/leads/' . rawurlencode($leadId) . '/notes', [
        'note_text' => firstmateSalesDispositionNote($event),
        'actor_email' => 'firstmate-extension@1m8.ai',
    ]);
}

function firstmatePayload(): array {
    $raw = file_get_contents('php://input');
    $payload = json_decode((string)$raw, true);
    if (!is_array($payload)) {
        $payload = $_POST;
    }
    return is_array($payload) ? $payload : [];
}

function firstmateRequireSecret(): void {
    if (FIRSTMATE_SHARED_SECRET === '') {
        return;
    }
    $provided = (string)($_SERVER['HTTP_X_FIRSTMATE_SECRET'] ?? '');
    if (!hash_equals(FIRSTMATE_SHARED_SECRET, $provided)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Invalid FirstMate shared secret']);
        exit;
    }
}

firstmateRequireSecret();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    echo json_encode(['success' => true, 'state' => firstmateReadState()]);
    exit;
}

$payload = firstmatePayload();
$action = (string)($payload['action'] ?? '');
$state = firstmateReadState();
$now = gmdate('c');

if ($action === 'send_email_requested') {
    $command = is_array($payload['command'] ?? null) ? $payload['command'] : [];
    $command['serverReceivedAt'] = $now;
    array_unshift($state['commands'], $command);
    $state['commands'] = array_slice($state['commands'], 0, FIRSTMATE_MAX_COMMANDS);
    firstmateWriteState($state);
    echo json_encode(['success' => true, 'queued' => true, 'command' => $command]);
    exit;
}

if ($action === 'save_primary_contact') {
    $contact = is_array($payload['contact'] ?? null) ? $payload['contact'] : [];
    $result = firstmateSavePrimaryContact($contact);
    if (empty($result['success'])) {
        http_response_code(400);
    }
    echo json_encode($result, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($action === 'gmail_event') {
    $event = is_array($payload['event'] ?? null) ? $payload['event'] : [];
    firstmateMaybeSaveSalesDispositionToCrm($event);
    $event['serverReceivedAt'] = $now;
    $event['sourceUrl'] = (string)($payload['sourceUrl'] ?? '');
    array_unshift($state['events'], $event);
    $state['events'] = array_slice($state['events'], 0, FIRSTMATE_MAX_COMMANDS);
    firstmateWriteState($state);
    echo json_encode(['success' => true, 'recorded' => true, 'event' => $event]);
    exit;
}

http_response_code(400);
echo json_encode(['success' => false, 'error' => 'Unsupported action']);
