<?php
require_once __DIR__ . '/_storage.php';
session_id('codexdash');
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
session_write_close();
$_SERVER['REQUEST_METHOD'] = 'POST';
$_POST['action'] = 'customer_org_dashboard_data';
include __DIR__ . '/server.php';
?>
