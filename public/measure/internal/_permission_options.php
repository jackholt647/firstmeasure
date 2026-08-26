<?php
require_once __DIR__ . '/_storage.php';

function permissionOptionsSchema() {
    static $schema = null;
    if ($schema !== null) return $schema;

    $path = storagePath('data/permission_options.json', true);
    $raw = @file_get_contents($path);
    $data = json_decode((string)$raw, true);
    if (!is_array($data)) $data = [];

    $sections = [];
    $sectionMap = [];
    foreach (($data['sections'] ?? []) as $section) {
        if (!is_array($section)) continue;
        $key = trim((string)($section['key'] ?? ''));
        if ($key === '') continue;
        $norm = [
            'key' => $key,
            'label' => (string)($section['label'] ?? $key),
            'description' => (string)($section['description'] ?? '')
        ];
        $sections[] = $norm;
        $sectionMap[$key] = $norm;
    }

    $permissions = [];
    $permissionMap = [];
    foreach (($data['permissions'] ?? []) as $perm) {
        if (!is_array($perm)) continue;
        $key = trim((string)($perm['key'] ?? ''));
        if ($key === '') continue;

        $type = strtolower(trim((string)($perm['type'] ?? 'boolean')));
        if ($type !== 'select') $type = 'boolean';

        $norm = [
            'key' => $key,
            'label' => (string)($perm['label'] ?? $key),
            'section' => (string)($perm['section'] ?? 'global'),
            'type' => $type,
            'default' => array_key_exists('default', $perm) ? $perm['default'] : ($type === 'select' ? '' : false),
            'description' => (string)($perm['description'] ?? ''),
            'options' => []
        ];

        if ($type === 'select') {
            foreach (($perm['options'] ?? []) as $opt) {
                if (!is_array($opt)) continue;
                $value = (string)($opt['value'] ?? '');
                if ($value === '') continue;
                $norm['options'][] = [
                    'value' => $value,
                    'label' => (string)($opt['label'] ?? $value)
                ];
            }
            if ($norm['default'] === '' && !empty($norm['options'])) {
                $norm['default'] = (string)$norm['options'][0]['value'];
            }
        } else {
            $norm['default'] = !empty($norm['default']);
        }

        $permissions[] = $norm;
        $permissionMap[$key] = $norm;
    }

    // These permissions are code-owned because they protect the blind-review
    // boundary even when an older mutable permission_options.json is present.
    if (!isset($sectionMap['quality'])) {
        $qualitySection = [
            'key' => 'quality',
            'label' => 'Quality & Manager Review',
            'description' => 'Blind auditing and identity-gated quality reporting.'
        ];
        $sections[] = $qualitySection;
        $sectionMap['quality'] = $qualitySection;
    }
    foreach ([
        [
            'key' => 'perform_manager_review',
            'label' => 'Perform Blind Manager Review',
            'description' => 'Review completed projects without seeing the QA or technician identity.'
        ],
        [
            'key' => 'view_manager_review_results',
            'label' => 'View Named Manager Review Results',
            'description' => 'Associate quality scores and audit findings with individual QAs and technicians.'
        ]
    ] as $definition) {
        if (isset($permissionMap[$definition['key']])) continue;
        $norm = [
            'key' => $definition['key'],
            'label' => $definition['label'],
            'section' => 'quality',
            'type' => 'boolean',
            'default' => false,
            'description' => $definition['description'],
            'options' => []
        ];
        $permissions[] = $norm;
        $permissionMap[$definition['key']] = $norm;
    }

    $roles = [];
    $roleMap = [];
    foreach (($data['roles'] ?? []) as $role) {
        if (!is_array($role)) continue;
        $key = trim((string)($role['key'] ?? ''));
        if ($key === '') continue;

        $norm = [
            'key' => $key,
            'label' => (string)($role['label'] ?? $key),
            'icon' => (string)($role['icon'] ?? 'fa-user'),
            'color' => (string)($role['color'] ?? '#5f6368'),
            'department' => (string)($role['department'] ?? 'production'),
            'training_complete' => array_key_exists('training_complete', $role) ? !!$role['training_complete'] : true,
            'contexts' => array_values(array_filter(array_map('strval', (array)($role['contexts'] ?? [])))),
            'aliases' => array_values(array_filter(array_map('strval', (array)($role['aliases'] ?? [])))),
            'grant_all_permissions' => !empty($role['grant_all_permissions']),
            'preset_permissions' => is_array($role['preset_permissions'] ?? null) ? $role['preset_permissions'] : []
        ];

        $roles[] = $norm;
        $roleMap[$key] = $norm;
    }

    $schema = [
        'version' => (int)($data['version'] ?? 1),
        'default_create_role' => is_array($data['default_create_role'] ?? null) ? $data['default_create_role'] : [],
        'sections' => $sections,
        'section_map' => $sectionMap,
        'permissions' => $permissions,
        'permission_map' => $permissionMap,
        'roles' => $roles,
        'role_map' => $roleMap
    ];

    return $schema;
}

function permissionOptionsDefaultValue(array $perm) {
    if (($perm['type'] ?? 'boolean') === 'select') {
        $default = (string)($perm['default'] ?? '');
        if ($default !== '') return $default;
        foreach (($perm['options'] ?? []) as $opt) {
            $value = (string)($opt['value'] ?? '');
            if ($value !== '') return $value;
        }
        return '';
    }
    return !empty($perm['default']);
}

function permissionOptionsDefaultPermissions() {
    static $defaults = null;
    if ($defaults !== null) return $defaults;

    $defaults = [];
    foreach (permissionOptionsSchema()['permissions'] as $perm) {
        $defaults[$perm['key']] = permissionOptionsDefaultValue($perm);
    }
    return $defaults;
}

function permissionOptionsAllGrantedPermissions() {
    static $all = null;
    if ($all !== null) return $all;

    $all = [];
    foreach (permissionOptionsSchema()['permissions'] as $perm) {
        if (($perm['type'] ?? 'boolean') === 'select') {
            $chosen = permissionOptionsDefaultValue($perm);
            foreach (($perm['options'] ?? []) as $opt) {
                if ((string)($opt['value'] ?? '') === 'all') {
                    $chosen = 'all';
                    break;
                }
            }
            $all[$perm['key']] = $chosen;
        } else {
            $all[$perm['key']] = true;
        }
    }
    return $all;
}

function permissionOptionsResolveRole($roleKey) {
    $roleKey = strtolower(trim((string)$roleKey));
    if ($roleKey === '') return null;

    $schema = permissionOptionsSchema();
    if (isset($schema['role_map'][$roleKey])) return $schema['role_map'][$roleKey];

    foreach ($schema['roles'] as $role) {
        foreach (($role['aliases'] ?? []) as $alias) {
            if (strtolower(trim((string)$alias)) === $roleKey) return $role;
        }
    }

    return null;
}

function permissionOptionsPresetPermissions($roleKey) {
    $role = permissionOptionsResolveRole($roleKey);
    if (!$role) return permissionOptionsDefaultPermissions();
    if (!empty($role['grant_all_permissions'])) return permissionOptionsAllGrantedPermissions();

    $perms = permissionOptionsDefaultPermissions();
    foreach (($role['preset_permissions'] ?? []) as $key => $value) {
        $perms[(string)$key] = $value;
    }
    return $perms;
}

function permissionOptionsNormalizePermissions($perms, $roleKey = '') {
    $merged = is_array($perms) ? $perms : [];
    $defaults = permissionOptionsResolveRole($roleKey)
        ? permissionOptionsPresetPermissions($roleKey)
        : permissionOptionsDefaultPermissions();

    foreach ($defaults as $key => $value) {
        if (!array_key_exists($key, $merged)) $merged[$key] = $value;
    }
    return $merged;
}

function permissionOptionsHasGrantedPermission($perms) {
    if (!is_array($perms)) return false;

    $permissionMap = permissionOptionsSchema()['permission_map'];
    foreach ($perms as $key => $value) {
        $key = (string)$key;
        if (isset($permissionMap[$key])) {
            $def = $permissionMap[$key];
            if (($def['type'] ?? 'boolean') === 'select') {
                $current = strtolower(trim((string)$value));
                $default = strtolower(trim((string)permissionOptionsDefaultValue($def)));
                if ($current !== '' && $current !== 'none' && $current !== $default) return true;
                continue;
            }
            if (!empty($value)) return true;
            continue;
        }

        if (is_bool($value) && $value) return true;
        $str = strtolower(trim((string)$value));
        if ($str !== '' && $str !== '0' && $str !== 'false' && $str !== 'none' && $str !== 'self') return true;
    }

    return false;
}

function permissionOptionsRolesForContext($context) {
    $context = strtolower(trim((string)$context));
    if ($context === '') $context = 'production';
    if ($context === 'all') return permissionOptionsSchema()['roles'];

    $out = [];
    foreach (permissionOptionsSchema()['roles'] as $role) {
        $contexts = array_map('strtolower', (array)($role['contexts'] ?? []));
        if (empty($contexts) || in_array($context, $contexts, true) || in_array('all', $contexts, true)) {
            $out[] = $role;
        }
    }
    return $out;
}

function permissionOptionsDefaultCreateRole($context) {
    $context = strtolower(trim((string)$context));
    if ($context === '') $context = 'production';
    if ($context === 'all') $context = 'production';
    $defaults = permissionOptionsSchema()['default_create_role'];
    $value = trim((string)($defaults[$context] ?? ''));
    if ($value !== '') return $value;
    $roles = permissionOptionsRolesForContext($context);
    return !empty($roles[0]['key']) ? (string)$roles[0]['key'] : 'user';
}

function permissionOptionsFrontendModel($context) {
    $context = strtolower(trim((string)$context));
    if ($context === '') $context = 'production';

    $roles = [];
    foreach (permissionOptionsRolesForContext($context) as $role) {
        $roles[] = [
            'value' => $role['key'],
            'label' => $role['label'],
            'icon' => $role['icon'],
            'color' => $role['color'],
            'department' => $role['department'],
            'training_complete' => $role['training_complete'],
            'permissions' => permissionOptionsPresetPermissions($role['key'])
        ];
    }

    return [
        'version' => permissionOptionsSchema()['version'],
        'default_create_role' => permissionOptionsDefaultCreateRole($context),
        'sections' => permissionOptionsSchema()['sections'],
        'permissions' => permissionOptionsSchema()['permissions'],
        'roles' => $roles
    ];
}

function permissionOptionsRenderHtml() {
    $schema = permissionOptionsSchema();
    $bySection = [];
    foreach ($schema['permissions'] as $perm) {
        $sectionKey = (string)($perm['section'] ?? 'global');
        if (!isset($bySection[$sectionKey])) $bySection[$sectionKey] = [];
        $bySection[$sectionKey][] = $perm;
    }

    ob_start();
    echo '<div class="perm-sections">';
    foreach ($schema['sections'] as $section) {
        $sectionKey = $section['key'];
        $items = $bySection[$sectionKey] ?? [];
        if (empty($items)) continue;

        $checkboxItems = [];
        $selectItems = [];
        foreach ($items as $perm) {
            if (($perm['type'] ?? 'boolean') === 'select') $selectItems[] = $perm;
            else $checkboxItems[] = $perm;
        }

        echo '<section class="perm-section">';
        echo '<div class="perm-section-header">';
        echo '<div class="perm-section-title">' . htmlspecialchars((string)$section['label'], ENT_QUOTES, 'UTF-8') . '</div>';
        if (($section['description'] ?? '') !== '') {
            echo '<div class="perm-section-description">' . htmlspecialchars((string)$section['description'], ENT_QUOTES, 'UTF-8') . '</div>';
        }
        echo '</div>';

        if (!empty($checkboxItems)) {
            echo '<div class="perm-grid">';
            foreach ($checkboxItems as $perm) {
                $key = (string)$perm['key'];
                $id = 'p_' . $key;
                echo '<label class="perm-item perm-item-checkbox">';
                echo '<input type="checkbox" id="' . htmlspecialchars($id, ENT_QUOTES, 'UTF-8') . '" data-perm-key="' . htmlspecialchars($key, ENT_QUOTES, 'UTF-8') . '">';
                echo '<span class="perm-copy">';
                echo '<span class="perm-label">' . htmlspecialchars((string)$perm['label'], ENT_QUOTES, 'UTF-8') . '</span>';
                if (($perm['description'] ?? '') !== '') {
                    echo '<span class="perm-help">' . htmlspecialchars((string)$perm['description'], ENT_QUOTES, 'UTF-8') . '</span>';
                }
                echo '</span>';
                echo '</label>';
            }
            echo '</div>';
        }

        if (!empty($selectItems)) {
            echo '<div class="perm-grid perm-grid-selects">';
            foreach ($selectItems as $perm) {
            $key = (string)$perm['key'];
            $id = 'p_' . $key;
                echo '<div class="perm-item perm-item-select">';
                echo '<label class="perm-control-label" for="' . htmlspecialchars($id, ENT_QUOTES, 'UTF-8') . '">' . htmlspecialchars((string)$perm['label'], ENT_QUOTES, 'UTF-8') . '</label>';
                echo '<select id="' . htmlspecialchars($id, ENT_QUOTES, 'UTF-8') . '" data-perm-key="' . htmlspecialchars($key, ENT_QUOTES, 'UTF-8') . '">';
                foreach (($perm['options'] ?? []) as $opt) {
                    $value = (string)($opt['value'] ?? '');
                    echo '<option value="' . htmlspecialchars($value, ENT_QUOTES, 'UTF-8') . '">' . htmlspecialchars((string)($opt['label'] ?? $value), ENT_QUOTES, 'UTF-8') . '</option>';
                }
                echo '</select>';
                echo '</div>';
            }
            echo '</div>';
        }
        echo '</section>';
    }
    echo '</div>';

    return ob_get_clean();
}
