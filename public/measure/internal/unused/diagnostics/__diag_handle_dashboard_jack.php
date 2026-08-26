<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
require '_lead.php';
$_POST = ['action'=>'lead_dashboard','target_email'=>'__all__'];
ob_start();
handleLeadActions('lead_dashboard');
$out = ob_get_clean();
$decoded = json_decode($out, true);
echo json_encode([
  'out_len' => strlen($out),
  'json_ok' => json_last_error() === JSON_ERROR_NONE,
  'json_error' => json_last_error_msg(),
  'success' => $decoded['success'] ?? null,
  'today_keys' => is_array($decoded['today'] ?? null) ? array_keys($decoded['today']) : [],
  'cards_keys' => is_array($decoded['cards'] ?? null) ? array_keys($decoded['cards']) : []
], JSON_PRETTY_PRINT), "\n";
