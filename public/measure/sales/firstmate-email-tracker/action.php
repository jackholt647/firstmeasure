<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/_storage.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: ' . firstmateTrackerAllowedOrigin());
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Headers: Content-Type, X-FirstMate-Secret');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const FIRSTMATE_TRACKER_SHARED_SECRET = '';
const FIRSTMATE_TRACKER_MAX_EVENTS = 500;

function firstmateTrackerAllowedOrigin(): string {
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

function firstmateTrackerStorageDir(): string {
    return firstmateSalesStorageDir('firstmate-email-tracker');
}

function firstmateTrackerJsonPath(): string {
    return firstmateTrackerStorageDir() . '/email-events.json';
}

function firstmateTrackerJsonlPath(): string {
    return firstmateTrackerStorageDir() . '/email-events.jsonl';
}

function firstmateTrackerReadEvents(): array {
    $path = firstmateSalesExistingStoragePath('firstmate-email-tracker', 'email-events.json');
    if (!is_file($path)) {
        return [];
    }
    $decoded = json_decode((string)file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function firstmateTrackerWriteEvents(array $events): bool {
    $dir = firstmateTrackerStorageDir();
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    $json = json_encode(array_slice($events, 0, FIRSTMATE_TRACKER_MAX_EVENTS), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    return $json !== false && file_put_contents(firstmateTrackerJsonPath(), $json, LOCK_EX) !== false;
}

function firstmateTrackerPayload(): array {
    $raw = file_get_contents('php://input');
    $payload = json_decode((string)$raw, true);
    if (!is_array($payload)) {
        $payload = $_POST;
    }
    return is_array($payload) ? $payload : [];
}

function firstmateTrackerRequireSecret(): void {
    if (FIRSTMATE_TRACKER_SHARED_SECRET === '') {
        return;
    }
    $provided = (string)($_SERVER['HTTP_X_FIRSTMATE_SECRET'] ?? '');
    if (!hash_equals(FIRSTMATE_TRACKER_SHARED_SECRET, $provided)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Invalid FirstMate tracker shared secret']);
        exit;
    }
}

function firstmateTrackerCleanEvent(array $payload): array {
    $event = is_array($payload['event'] ?? null) ? $payload['event'] : [];
    return [
        'id' => bin2hex(random_bytes(8)),
        'serverReceivedAt' => gmdate('c'),
        'sentAt' => (string)($event['sentAt'] ?? ''),
        'requestId' => (string)($event['requestId'] ?? ''),
        'requestedAt' => (string)($event['requestedAt'] ?? ''),
        'templateId' => (string)($event['templateId'] ?? ''),
        'leadId' => (string)($event['leadId'] ?? ($event['lead']['id'] ?? '')),
        'lead' => is_array($event['lead'] ?? null) ? $event['lead'] : [],
        'contactId' => (string)($event['contactId'] ?? ''),
        'contact' => is_array($event['contact'] ?? null) ? $event['contact'] : null,
        'greetingFirstName' => (string)($event['greetingFirstName'] ?? ''),
        'to' => is_array($event['to'] ?? null) ? array_values($event['to']) : [],
        'cc' => is_array($event['cc'] ?? null) ? array_values($event['cc']) : [],
        'bcc' => is_array($event['bcc'] ?? null) ? array_values($event['bcc']) : [],
        'recipients' => is_array($event['recipients'] ?? null) ? $event['recipients'] : [
            'to' => is_array($event['to'] ?? null) ? array_values($event['to']) : [],
            'cc' => is_array($event['cc'] ?? null) ? array_values($event['cc']) : [],
            'bcc' => is_array($event['bcc'] ?? null) ? array_values($event['bcc']) : [],
            'all' => array_values(array_unique(array_merge(
                is_array($event['to'] ?? null) ? $event['to'] : [],
                is_array($event['cc'] ?? null) ? $event['cc'] : [],
                is_array($event['bcc'] ?? null) ? $event['bcc'] : []
            ))),
        ],
        'subject' => (string)($event['subject'] ?? ''),
        'reports' => is_array($event['reports'] ?? null) ? array_values($event['reports']) : [],
        'sourceUrl' => (string)($event['sourceUrl'] ?? ''),
        'gmailUrl' => (string)($event['gmailUrl'] ?? ''),
        'extensionVersion' => (string)($payload['extension_version'] ?? ''),
        'remoteAddr' => (string)($_SERVER['REMOTE_ADDR'] ?? ''),
    ];
}

firstmateTrackerRequireSecret();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    echo json_encode(['success' => true, 'events' => firstmateTrackerReadEvents()]);
    exit;
}

$payload = firstmateTrackerPayload();
$action = (string)($payload['action'] ?? '');
if ($action !== 'email_sent') {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Unsupported action']);
    exit;
}

$event = firstmateTrackerCleanEvent($payload);
$events = firstmateTrackerReadEvents();
array_unshift($events, $event);
firstmateTrackerWriteEvents($events);

$line = json_encode($event, JSON_UNESCAPED_SLASHES);
if ($line !== false) {
    file_put_contents(firstmateTrackerJsonlPath(), $line . "\n", FILE_APPEND | LOCK_EX);
}

echo json_encode(['success' => true, 'event' => $event]);
