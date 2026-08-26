<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'frank@1m8.ai';
$_SESSION['permissions'] = ['manage_sales_users'=>1,'view_all_callers_list_progress'=>1];
require '_lead.php';
$db = leadDb();
$actor = strtolower(trim($_SESSION['user_email']));
$target = ['mode'=>'all','email'=>''];
$result = leadMyLeadsQueryForTarget($db, $actor, $target, 1, 5, '', 'updated_at', 'desc', 'all');
echo json_encode([
  'total' => $result['total'] ?? null,
  'page' => $result['page'] ?? null,
  'count' => is_array($result['leads'] ?? null) ? count($result['leads']) : null,
  'sample' => array_slice($result['leads'] ?? [], 0, 3)
], JSON_PRETTY_PRINT), "\n";
