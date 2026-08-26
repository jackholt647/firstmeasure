<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
require '_lead.php';
$_POST = ['action'=>'lead_my_leads','page'=>1,'per_page'=>50,'q'=>'','sort'=>'updated_at','dir'=>'desc','followup_scope'=>'all','target_email'=>'__all__'];
ob_start();
handleLeadActions('lead_my_leads');
$out = ob_get_clean();
$decoded = json_decode($out, true);
echo json_encode([
  'out_len' => strlen($out),
  'json_ok' => json_last_error() === JSON_ERROR_NONE,
  'json_error' => json_last_error_msg(),
  'success' => $decoded['success'] ?? null,
  'lead_count' => is_array($decoded['leads'] ?? null) ? count($decoded['leads']) : null,
  'total' => $decoded['total'] ?? null
], JSON_PRETTY_PRINT), "\n";
