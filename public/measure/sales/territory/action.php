<?php
session_start();
header('Content-Type: application/json');

require_once __DIR__ . '/territory_engine.php';

try {
    $action = (string)($_POST['action'] ?? '');
    if ($action === '') {
        $raw = file_get_contents('php://input');
        $json = json_decode((string)$raw, true);
        if (is_array($json)) {
            foreach ($json as $key => $value) {
                $_POST[$key] = is_array($value) ? json_encode($value) : $value;
            }
            $action = (string)($_POST['action'] ?? '');
        }
    }
    if ($action === '') {
        echo json_encode(['success' => false, 'status' => 'error', 'error' => 'Missing action']);
        exit;
    }
    if (!handleTerritoryActions($action)) {
        echo json_encode(['success' => false, 'status' => 'error', 'error' => 'Unsupported action']);
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'status' => 'error', 'error' => $e->getMessage()]);
}

