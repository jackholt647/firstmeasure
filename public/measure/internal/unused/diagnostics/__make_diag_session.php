<?php
require_once __DIR__ . '/_storage.php';
session_save_path(sys_get_temp_dir());
session_id('codexdiagjack');
session_start();
$_SESSION['user_email'] = 'jack@1m8.ai';
session_write_close();
echo session_save_path(), "\\n", 'codexdiagjack', "\\n";
