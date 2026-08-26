<?php
require_once __DIR__ . '/_storage.php';
$d = json_decode(file_get_contents(storagePath('diagnostics/__diag_web_session_live.json')), true);
var_export($d);
