<?php

require_once __DIR__ . '/../../measure/internal/_permission_options.php';

$legacyOverride = permissionOptionsMergeBundledDefaults([
    'version' => 1,
    'sections' => [['key' => 'production', 'label' => 'Legacy Production']],
    'permissions' => [[
        'key' => 'manage_queue',
        'label' => 'Legacy Queue Label',
        'section' => 'production',
        'type' => 'boolean'
    ]],
    'roles' => [[
        'key' => 'manager',
        'label' => 'Legacy Manager',
        'preset_permissions' => ['manage_queue' => true]
    ]]
]);
$legacyPermissionKeys = array_column($legacyOverride['permissions'], 'key');
foreach (['create_projects', 'manage_company_users', 'manage_crews', 'manage_notifications', 'platform_admin'] as $key) {
    if (!in_array($key, $legacyPermissionKeys, true)) {
        fwrite(STDERR, "Incomplete mutable schema erased bundled permission: {$key}\n");
        exit(1);
    }
}
$legacyQueue = array_values(array_filter($legacyOverride['permissions'], fn($item) => ($item['key'] ?? '') === 'manage_queue'));
if (($legacyQueue[0]['label'] ?? '') !== 'Legacy Queue Label') {
    fwrite(STDERR, "Mutable permission overrides were not preserved.\n");
    exit(1);
}

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
