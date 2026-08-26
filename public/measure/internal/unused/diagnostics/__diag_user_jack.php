<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email']='jack@1m8.ai';
$usersPath = storageDir('users') . 'jack@1m8.ai.json';
if (is_file($usersPath)) {
  $user = json_decode(file_get_contents($usersPath), true);
  echo json_encode([
    'exists' => true,
    'account_type' => $user['account_type'] ?? null,
    'role' => $user['role'] ?? null,
    'has_org_permissions' => isset($user['org_permissions']),
    'org_permissions' => $user['org_permissions'] ?? null
  ], JSON_PRETTY_PRINT), "\n";
} else {
  echo json_encode(['exists'=>false,'path'=>$usersPath]), "\n";
}
