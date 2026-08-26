<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'frank@1m8.ai';
$_SESSION['permissions'] = ['manage_sales_users'=>1,'view_all_callers_list_progress'=>1];
$_POST = ['action'=>'lead_get','id'=>'lead_0c399596fd8514cb'];
require '_lead.php';
ob_start();
handleLeadActions('lead_get');
$out = ob_get_clean();
file_put_contents(storagePath('diagnostics/__diag_lead_get.json', true), $out);
$decoded = json_decode($out, true);
echo json_encode([
 'json_ok' => json_last_error() === JSON_ERROR_NONE,
 'success' => $decoded['success'] ?? null,
 'has_lead' => isset($decoded['lead']),
 'keys' => is_array($decoded['lead'] ?? null) ? array_slice(array_keys($decoded['lead']),0,30) : [],
 'crm_keys' => is_array($decoded['lead']['crm'] ?? null) ? array_keys($decoded['lead']['crm']) : [],
 'activity_count' => is_array($decoded['lead']['activity_items'] ?? null) ? count($decoded['lead']['activity_items']) : null,
 'dial_count' => is_array($decoded['lead']['dial_events'] ?? null) ? count($decoded['lead']['dial_events']) : null
], JSON_PRETTY_PRINT), "\n";
