<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'frank@1m8.ai';
$_SESSION['permissions'] = ['manage_sales_users'=>1,'view_all_callers_list_progress'=>1];
$_POST = [];
require '_lead.php';
$db = leadDb();
$actor = strtolower(trim($_SESSION['user_email']));
$target = leadViewerTarget($actor);
$result = [
  'target' => $target,
  'lead_count' => 0,
  'sample' => [],
];
if (function_exists('leadMyLeadsQueryForTarget')) {
  $q = leadMyLeadsQueryForTarget($target, '', 'updated_at', 'desc', 'all');
  $stmt = $db->prepare($q['sql']);
  $idx = 1;
  foreach ($q['params'] as $param) {
    $type = is_int($param) ? SQLITE3_INTEGER : SQLITE3_TEXT;
    $stmt->bindValue($idx++, $param, $type);
  }
  $res = $stmt->execute();
  while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
    $result['lead_count']++;
    if (count($result['sample']) < 3) $result['sample'][] = ['id'=>$row['id'] ?? null,'company'=>$row['company'] ?? null,'assigned'=>$row['assigned_to_email'] ?? null];
  }
}
echo json_encode($result, JSON_PRETTY_PRINT), "\n";
