<?php
require_once __DIR__ . '/_storage.php';
session_start();
require_once __DIR__ . '/_config.php';
require_once __DIR__ . '/_users.php';
header('Content-Type: application/json');
echo json_encode([
  'session_id' => session_id(),
  'cookie' => $_COOKIE['PHPSESSID'] ?? null,
  'session_user_email' => $_SESSION['user_email'] ?? null,
  'user_data_exists' => isset($_SESSION['user_email']) ? (readUserDataByEmail($_SESSION['user_email']) ? true : false) : false
], JSON_PRETTY_PRINT);
