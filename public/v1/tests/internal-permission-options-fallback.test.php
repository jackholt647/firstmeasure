<?php

require_once __DIR__ . '/../../measure/internal/_permission_options.php';

$schema = permissionOptionsSchema();
$keys = array_column($schema['permissions'], 'key');
$roles = array_column($schema['roles'], 'key');
$html = permissionOptionsRenderHtml();

$requiredPermissions = [
    'view_all_projects',
    'manage_users',
    'manage_queue',
    'manage_qa',
    'sales_view_own_assigned_leads',
    'sales_manage_caller_accounts',
    'shift_view',
    'manage_payroll',
    'perform_manager_review'
];

foreach ($requiredPermissions as $key) {
    if (!in_array($key, $keys, true)) {
        fwrite(STDERR, "Missing bundled permission: {$key}\n");
        exit(1);
    }
    if (!str_contains($html, 'data-perm-key="' . $key . '"')) {
        fwrite(STDERR, "Bundled permission was not rendered: {$key}\n");
        exit(1);
    }
}

foreach (['admin', 'manager', 'qa', 'technician', 'sales_manager', 'salesperson', 'trainee'] as $role) {
    if (!in_array($role, $roles, true)) {
        fwrite(STDERR, "Missing bundled role: {$role}\n");
        exit(1);
    }
}

if (count($schema['permissions']) < 50) {
    fwrite(STDERR, "Permission fallback unexpectedly incomplete.\n");
    exit(1);
}

echo json_encode([
    'ok' => true,
    'sections' => count($schema['sections']),
    'permissions' => count($schema['permissions']),
    'roles' => count($schema['roles'])
], JSON_UNESCAPED_SLASHES) . PHP_EOL;
