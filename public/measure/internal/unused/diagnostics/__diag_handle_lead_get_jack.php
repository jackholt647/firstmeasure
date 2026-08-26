<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
require '_lead.php';
$_POST = ['action'=>'lead_get','id'=>'lead_0c399596fd8514cb'];
ob_start();
handleLeadActions('lead_get');
$out = ob_get_clean();
$decoded = json_decode($out, true);
echo json_encode([
  'out_len' => strlen($out),
  'json_ok' => json_last_error() === JSON_ERROR_NONE,
  'json_error' => json_last_error_msg(),
  'success' => $decoded['success'] ?? null,
  'error' => $decoded['error'] ?? null,
  'has_lead' => isset($decoded['lead']),
  'lead_id' => $decoded['lead']['id'] ?? null,
  'has_crm' => isset($decoded['lead']['crm']),
  'activity_count' => is_array($decoded['lead']['activity_items'] ?? null) ? count($decoded['lead']['activity_items']) : null
], JSON_PRETTY_PRINT), "\n";
