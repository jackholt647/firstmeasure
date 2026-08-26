<?php
require_once __DIR__ . '/_storage.php';
session_id('codexdash2');
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
session_write_close();
$_SERVER['REQUEST_METHOD'] = 'POST';
$_POST['action'] = 'customer_org_detail';
$_POST['org_id'] = '3dbf7f79528139e27c491363';
$_POST['orders_page'] = '1';
$_POST['ledger_page'] = '1';
include __DIR__ . '/server.php';
?>
