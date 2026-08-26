<?php
require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();
session_unset();
session_destroy();
portalExpireSessionCookie();
session_write_close();
header("Location: login.php");
exit;
?>
