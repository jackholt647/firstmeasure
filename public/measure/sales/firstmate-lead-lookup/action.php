<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/_storage.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: ' . firstmateLeadAllowedOrigin());
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Headers: Content-Type, X-FirstMate-Code');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const FIRSTMATE_LEAD_LOOKUP_CODE = 'firstmate-sales-extension';

function firstmateLeadAllowedOrigin(): string {
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

function firstmateLeadNodeV1BaseUrl(): string {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($host, '127.0.0.1') !== false || strpos($host, 'localhost') !== false) {
        return 'http://127.0.0.1:3111/v1';
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $hostname = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    return $scheme . '://' . $hostname . '/v1';
}

function firstmateLeadPayload(): array {
    $raw = file_get_contents('php://input');
    $payload = json_decode((string)$raw, true);
    if (!is_array($payload)) {
        $payload = $_POST;
    }
    if (!is_array($payload)) {
        $payload = [];
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
        $payload = array_merge($_GET, $payload);
    }
    return $payload;
}

function firstmateRequireCode(): void {
    $provided = (string)($_SERVER['HTTP_X_FIRSTMATE_CODE'] ?? ($_GET['code'] ?? ''));
    if (!hash_equals(FIRSTMATE_LEAD_LOOKUP_CODE, $provided)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Invalid FirstMate lookup code']);
        exit;
    }
}

function firstmateNodeJson(string $path): array {
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is not available.');
    }
    $ch = curl_init(rtrim(firstmateLeadNodeV1BaseUrl(), '/') . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_TIMEOUT => 20,
    ]);
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($response === false || $response === '') {
        throw new RuntimeException('Node CRM lookup failed' . ($error ? ': ' . $error : ''));
    }
    $decoded = json_decode((string)$response, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Node CRM lookup returned invalid JSON.');
    }
    if ($status < 200 || $status >= 300) {
        http_response_code($status);
        echo json_encode($decoded);
        exit;
    }
    return $decoded;
}

function firstmateMappedCrmLeadId(string $leadId): array {
    $mapPath = firstmateSalesExistingStoragePath('firstmate-lead-lookup', 'lead-map.json');
    if (!is_file($mapPath)) {
        return ['crm_id' => $leadId, 'map_entry' => null];
    }
    $json = preg_replace('/^\xEF\xBB\xBF/', '', (string)file_get_contents($mapPath));
    $decoded = json_decode($json, true);
    if (!is_array($decoded)) {
        return ['crm_id' => $leadId, 'map_entry' => null];
    }
    $entry = $decoded[$leadId] ?? null;
    if (is_array($entry) && !empty($entry['crm_id'])) {
        return ['crm_id' => (string)$entry['crm_id'], 'map_entry' => $entry];
    }
    return ['crm_id' => $leadId, 'map_entry' => null];
}

try {
    firstmateRequireCode();
    $payload = firstmateLeadPayload();
    $leadId = trim((string)($payload['lead_id'] ?? $payload['id'] ?? ''));
    if ($leadId === '' || !preg_match('/^[a-zA-Z0-9_.:-]+$/', $leadId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing or invalid lead_id']);
        exit;
    }

    $mapped = firstmateMappedCrmLeadId($leadId);
    $crmLeadId = $mapped['crm_id'];
    $detail = firstmateNodeJson('/internal/crm/leads/' . rawurlencode($crmLeadId) . '/detail');
    if (isset($detail['lead']) && is_array($detail['lead'])) {
        $detail['lead']['fm_lead_id'] = $leadId;
    }
    echo json_encode([
        'success' => true,
        'ok' => true,
        'lead_id' => $leadId,
        'crm_lead_id' => $crmLeadId,
        'map_entry' => $mapped['map_entry'],
        'detail' => $detail,
        'lead' => $detail['lead'] ?? null,
        'contacts' => $detail['contacts'] ?? [],
        'notes' => $detail['notes'] ?? [],
        'followups' => $detail['followups'] ?? [],
        'dial_events' => $detail['dial_events'] ?? [],
    ], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
