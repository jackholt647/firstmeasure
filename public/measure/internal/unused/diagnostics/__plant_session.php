<?php
require_once __DIR__ . '/_storage.php';
$payload = "user_email|s:11:\"jack@1m8.ai\";";
$paths = [sys_get_temp_dir(), getenv('TEMP'), getenv('TMP'), 'C:\\Windows\\Temp'];
foreach ($paths as $path) {
  if (!$path) continue;
  $file = rtrim($path, '\\/') . DIRECTORY_SEPARATOR . 'sess_codexdiagjack';
  @file_put_contents($file, $payload);
  echo $file, ' => ', (is_file($file) ? filesize($file) : 'missing'), "\\n";
}
