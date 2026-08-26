<?php
require_once __DIR__ . '/_storage.php';
session_start();
require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_users.php';
global $userDir;
header('Content-Type: application/json');
$email = 'jack@1m8.ai';
$file = $userDir . getUserFilename($email);
echo json_encode([
  'userDir' => $userDir,
  'email' => $email,
  'filename' => getUserFilename($email),
  'full_path' => $file,
  'exists' => file_exists($file),
  'cwd' => getcwd()
], JSON_PRETTY_PRINT);
