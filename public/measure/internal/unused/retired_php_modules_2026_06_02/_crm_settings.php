<?php
require_once __DIR__ . '/_storage.php';

if (!function_exists('crmSettingsSlug')) {
    function crmSettingsSlug($value) {
        $value = strtolower(trim((string)$value));
        $value = preg_replace('/[^a-z0-9]+/', '_', $value);
        return trim((string)$value, '_');
    }
}

if (!function_exists('crmSettingsDefaultSmsTemplates')) {
    function crmSettingsDefaultSmsTemplates() {
        return [
            [
                'id' => 'follow_up',
                'name' => 'Follow Up',
                'body' => 'Hi, this is FirstMate following up on your estimate request.',
            ],
            [
                'id' => 'check_in',
                'name' => 'Checking In',
                'body' => 'Hi, just checking in to see if you had any questions for us.',
            ],
            [
                'id' => 'call_back',
                'name' => 'Call Back',
                'body' => 'Hi, I missed you. What time works best for a quick call back today?',
            ],
        ];
    }
}

if (!function_exists('crmSettingsDefaultEmailTemplates')) {
    function crmSettingsDefaultEmailTemplates() {
        return [
            [
                'id' => 'dm_info',
                'name' => 'DM Info',
                'subject' => 'First Mate info for {{company}}',
                'body' => "Hi {{contact_name}},\n\nHere is the quick First Mate overview we discussed. We provide aerial roof measurement reports with same-day turnaround and simple pricing.\n\nResidential reports start at \$7 and commercial reports start at \$12.\n\nLet me know if you want me to send a sample report or walk through how teams are using it today.\n\n{{rep_name}}\nFirst Mate",
            ],
            [
                'id' => 'general_info',
                'name' => 'General Info',
                'subject' => 'Quick First Mate overview',
                'body' => "Hi {{contact_name}},\n\nThanks for taking the time today. First Mate gives you fast aerial roof measurement reports without the long turnaround or annual contract.\n\nIf helpful, I can send pricing details and a sample report next.\n\n{{rep_name}}\nFirst Mate",
            ],
            [
                'id' => 'sign_up',
                'name' => 'Sign Up',
                'subject' => 'Getting started with First Mate',
                'body' => "Hi {{contact_name}},\n\nGreat speaking with you. Here is the sign-up path we discussed so you can get started with First Mate right away.\n\nReply here with any questions and I can help you get your first order in.\n\n{{rep_name}}\nFirst Mate",
            ],
            [
                'id' => 'pre_signup_fu',
                'name' => 'Pre-Signup F/U',
                'subject' => 'Following up on First Mate',
                'body' => "Hi {{contact_name}},\n\nWanted to follow up on our conversation about First Mate. If you would like, I can send over a sample report or a quick pricing comparison for your current workflow.\n\n{{rep_name}}\nFirst Mate",
            ],
            [
                'id' => 'post_signup_fu',
                'name' => 'Post-Signup F/U',
                'subject' => 'Checking in after sign up',
                'body' => "Hi {{contact_name}},\n\nChecking in to make sure everything is going smoothly after sign up. If you want help placing the next order or inviting teammates, I am happy to help.\n\n{{rep_name}}\nFirst Mate",
            ],
        ];
    }
}

if (!function_exists('crmSettingsDefaultCallDispositions')) {
    function crmSettingsDefaultCallDispositions() {
        $labels = [
            'Gatekeeper: Info Received',
            'Decision Maker: Info Received',
            'Hook Rejected',
            'Gatekeeper: Info Sent',
            'Decision Maker: Info Sent',
            'Not a Roofing Company',
            'Lead Generator',
            'Gatekeeper: Objection',
            'Decision Maker: Objection',
            'Left Voicemail',
            'No Answer',
            'Wrong Phone #',
            'Do Not Contact',
        ];
        $rows = [];
        foreach ($labels as $label) {
            $rows[] = [
                'id' => crmSettingsSlug($label),
                'label' => $label,
            ];
        }
        return $rows;
    }
}

if (!function_exists('crmSettingsDefaultToolsDrawer')) {
    function crmSettingsDefaultToolsDrawer() {
        return [
            'fm_price_per_report' => 7,
            'providers' => [
                [
                    'id' => 'eagleview',
                    'name' => 'EagleView',
                    'short_label' => 'EV',
                    'default_price' => 32.75,
                    'comparison_heading' => 'First Mate vs EagleView',
                    'comparison_summary' => 'Use this comparison when the lead is evaluating report cost, turnaround, or contract terms against EagleView.',
                    'comparison_rows' => [
                        ['feature' => 'Residential', 'first_mate' => '$7', 'provider' => '$32.75+'],
                        ['feature' => 'Commercial', 'first_mate' => '$12', 'provider' => '$30-$50+'],
                        ['feature' => 'Turnaround', 'first_mate' => 'Same day', 'provider' => '1-3 days'],
                        ['feature' => 'Contract', 'first_mate' => 'None', 'provider' => 'Annual'],
                        ['feature' => 'Vent Calcs', 'first_mate' => 'Included', 'provider' => 'Not standard'],
                    ],
                ],
                [
                    'id' => 'quickmeasure',
                    'name' => 'QuickMeasure',
                    'short_label' => 'QM',
                    'default_price' => 20,
                    'comparison_heading' => 'First Mate vs QuickMeasure',
                    'comparison_summary' => 'Use this when the lead is price-sensitive and wants a faster same-day turnaround without the usual per-report markup.',
                    'comparison_rows' => [
                        ['feature' => 'Residential', 'first_mate' => '$7', 'provider' => '$20+'],
                        ['feature' => 'Commercial', 'first_mate' => '$12', 'provider' => '$25-$40+'],
                        ['feature' => 'Turnaround', 'first_mate' => 'Same day', 'provider' => '1-2 days'],
                        ['feature' => 'Contract', 'first_mate' => 'None', 'provider' => 'Varies'],
                    ],
                ],
                [
                    'id' => 'roofr',
                    'name' => 'Roofr',
                    'short_label' => 'Roofr',
                    'default_price' => 13,
                    'comparison_heading' => 'First Mate vs Roofr',
                    'comparison_summary' => 'Use this when the lead compares speed and simple pricing against Roofr.',
                    'comparison_rows' => [
                        ['feature' => 'Residential', 'first_mate' => '$7', 'provider' => '$13-$19'],
                        ['feature' => 'Commercial', 'first_mate' => '$12', 'provider' => '$20-$35+'],
                        ['feature' => 'Turnaround', 'first_mate' => 'Same day', 'provider' => 'Same day to next day'],
                        ['feature' => 'Contract', 'first_mate' => 'None', 'provider' => 'Varies'],
                    ],
                ],
                [
                    'id' => 'roofscope',
                    'name' => 'RoofScope',
                    'short_label' => 'RoofScope',
                    'default_price' => 16,
                    'comparison_heading' => 'First Mate vs RoofScope',
                    'comparison_summary' => 'Use this when the lead wants a straightforward side-by-side on cost and turnaround versus RoofScope.',
                    'comparison_rows' => [
                        ['feature' => 'Residential', 'first_mate' => '$7', 'provider' => '$14-$22'],
                        ['feature' => 'Commercial', 'first_mate' => '$12', 'provider' => '$28-$45+'],
                        ['feature' => 'Turnaround', 'first_mate' => 'Same day', 'provider' => '1-2 days'],
                        ['feature' => 'Contract', 'first_mate' => 'None', 'provider' => 'Varies'],
                    ],
                ],
                [
                    'id' => 'other',
                    'name' => 'Other',
                    'short_label' => 'Other',
                    'default_price' => 0,
                    'comparison_heading' => 'First Mate vs Current Provider',
                    'comparison_summary' => 'Use this when the lead is using a provider not listed above and you want to capture a custom cost comparison.',
                    'comparison_rows' => [],
                ],
                [
                    'id' => 'none',
                    'name' => 'None',
                    'short_label' => 'None',
                    'default_price' => 0,
                    'comparison_heading' => 'First Mate ROI Snapshot',
                    'comparison_summary' => 'Use this when the lead is not currently using a paid measurement provider and you only need the First Mate cost snapshot.',
                    'comparison_rows' => [],
                ],
            ],
        ];
    }
}

if (!function_exists('crmSettingsProtectedDispositionLabel')) {
    function crmSettingsProtectedDispositionLabel() {
        return 'Do Not Contact';
    }
}

if (!function_exists('crmSettingsNormalizeSmsTemplates')) {
    function crmSettingsNormalizeSmsTemplates($raw) {
        if (!is_array($raw)) $raw = [];
        $rows = [];
        $seen = [];
        foreach ($raw as $entry) {
            if (is_string($entry)) {
                $entry = ['name' => $entry, 'body' => ''];
            }
            if (!is_array($entry)) continue;
            $name = trim((string)($entry['name'] ?? ($entry['label'] ?? '')));
            $body = trim((string)($entry['body'] ?? ''));
            if ($name === '' && $body === '') continue;
            if ($name === '') $name = 'Untitled Template';
            $id = crmSettingsSlug($entry['id'] ?? $name);
            if ($id === '') $id = crmSettingsSlug($name);
            if ($id === '') $id = 'sms_' . substr(md5($name . '|' . $body), 0, 10);
            if (isset($seen[$id])) continue;
            $seen[$id] = true;
            $rows[] = [
                'id' => $id,
                'name' => $name,
                'body' => $body,
            ];
        }
        return $rows ?: crmSettingsDefaultSmsTemplates();
    }
}

if (!function_exists('crmSettingsNormalizeEmailTemplates')) {
    function crmSettingsNormalizeEmailTemplates($raw) {
        if (!is_array($raw)) $raw = [];
        $rows = [];
        $seen = [];
        foreach ($raw as $entry) {
            if (!is_array($entry)) continue;
            $name = trim((string)($entry['name'] ?? ($entry['label'] ?? '')));
            $subject = trim((string)($entry['subject'] ?? ''));
            $body = trim((string)($entry['body'] ?? ''));
            if ($name === '' && $subject === '' && $body === '') continue;
            if ($name === '') $name = 'Untitled Template';
            $id = crmSettingsSlug($entry['id'] ?? $name);
            if ($id === '') $id = 'email_' . substr(md5($name . '|' . $subject . '|' . $body), 0, 10);
            if (isset($seen[$id])) continue;
            $seen[$id] = true;
            $rows[] = [
                'id' => $id,
                'name' => $name,
                'subject' => $subject,
                'body' => $body,
            ];
        }
        return $rows ?: crmSettingsDefaultEmailTemplates();
    }
}

if (!function_exists('crmSettingsNormalizeCallDispositions')) {
    function crmSettingsNormalizeCallDispositions($raw) {
        if (!is_array($raw)) $raw = [];
        $rows = [];
        $seen = [];
        foreach ($raw as $entry) {
            if (is_string($entry)) $entry = ['label' => $entry];
            if (!is_array($entry)) continue;
            $label = trim((string)($entry['label'] ?? ($entry['name'] ?? '')));
            if ($label === '') continue;
            $id = crmSettingsSlug($entry['id'] ?? $label);
            if ($id === '') $id = 'disp_' . substr(md5($label), 0, 10);
            if (isset($seen[$id])) continue;
            $seen[$id] = true;
            $rows[] = [
                'id' => $id,
                'label' => $label,
            ];
        }
        if (!$rows) {
            return crmSettingsDefaultCallDispositions();
        }
        $protectedLabel = crmSettingsProtectedDispositionLabel();
        $protectedId = crmSettingsSlug($protectedLabel);
        $hasProtected = false;
        foreach ($rows as $row) {
            $label = trim((string)($row['label'] ?? ''));
            $id = trim((string)($row['id'] ?? ''));
            if (strcasecmp($label, $protectedLabel) === 0 || $id === $protectedId) {
                $hasProtected = true;
                break;
            }
        }
        if (!$hasProtected) {
            $rows[] = [
                'id' => $protectedId,
                'label' => $protectedLabel,
            ];
        } else {
            foreach ($rows as &$row) {
                $label = trim((string)($row['label'] ?? ''));
                $id = trim((string)($row['id'] ?? ''));
                if (strcasecmp($label, $protectedLabel) === 0 || $id === $protectedId) {
                    $row['id'] = $protectedId;
                    $row['label'] = $protectedLabel;
                }
            }
            unset($row);
        }
        return $rows;
    }
}

if (!function_exists('crmSettingsNormalizeToolsComparisonRows')) {
    function crmSettingsNormalizeToolsComparisonRows($raw) {
        if (is_string($raw)) {
            $raw = preg_split('/\r\n|\r|\n/', $raw) ?: [];
        }
        if (!is_array($raw)) $raw = [];
        $rows = [];
        foreach ($raw as $entry) {
            if (is_string($entry)) {
                $parts = array_map('trim', explode('|', $entry));
                $entry = [
                    'feature' => $parts[0] ?? '',
                    'first_mate' => $parts[1] ?? '',
                    'provider' => $parts[2] ?? '',
                ];
            }
            if (!is_array($entry)) continue;
            $feature = trim((string)($entry['feature'] ?? ''));
            $firstMate = trim((string)($entry['first_mate'] ?? ($entry['fm'] ?? '')));
            $provider = trim((string)($entry['provider'] ?? ($entry['competitor'] ?? '')));
            if ($feature === '' && $firstMate === '' && $provider === '') continue;
            $rows[] = [
                'feature' => $feature,
                'first_mate' => $firstMate,
                'provider' => $provider,
            ];
        }
        return $rows;
    }
}

if (!function_exists('crmSettingsNormalizeToolsProviders')) {
    function crmSettingsNormalizeToolsProviders($raw) {
        $defaults = crmSettingsDefaultToolsDrawer()['providers'];
        $defaultMap = [];
        $order = [];
        foreach ($defaults as $provider) {
            $id = crmSettingsSlug($provider['id'] ?? $provider['name'] ?? '');
            if ($id === '') continue;
            $provider['id'] = $id;
            $defaultMap[$id] = $provider;
            $order[] = $id;
        }
        if (!is_array($raw)) $raw = [];
        $result = [];
        foreach ($raw as $entry) {
            if (is_string($entry)) {
                $entry = ['name' => $entry];
            }
            if (!is_array($entry)) continue;
            $name = trim((string)($entry['name'] ?? ''));
            $id = crmSettingsSlug($entry['id'] ?? $name);
            if ($id === '') continue;
            $base = $defaultMap[$id] ?? [
                'id' => $id,
                'name' => $name ?: ucwords(str_replace('_', ' ', $id)),
                'short_label' => $name ?: ucwords(str_replace('_', ' ', $id)),
                'default_price' => 0,
                'comparison_heading' => '',
                'comparison_summary' => '',
                'comparison_rows' => [],
            ];
            $base['id'] = $id;
            $base['name'] = $name !== '' ? $name : (string)($base['name'] ?? ucwords(str_replace('_', ' ', $id)));
            $shortLabel = trim((string)($entry['short_label'] ?? $base['short_label'] ?? $base['name']));
            $base['short_label'] = $shortLabel !== '' ? $shortLabel : $base['name'];
            $defaultPrice = is_numeric($entry['default_price'] ?? null)
                ? round((float)$entry['default_price'], 2)
                : round((float)($base['default_price'] ?? 0), 2);
            $base['default_price'] = max(0, $defaultPrice);
            $heading = trim((string)($entry['comparison_heading'] ?? $base['comparison_heading'] ?? ''));
            $base['comparison_heading'] = $heading !== '' ? $heading : ('First Mate vs ' . $base['name']);
            $base['comparison_summary'] = trim((string)($entry['comparison_summary'] ?? $base['comparison_summary'] ?? ''));
            $rows = crmSettingsNormalizeToolsComparisonRows($entry['comparison_rows'] ?? ($entry['comparison_rows_text'] ?? $base['comparison_rows'] ?? []));
            $base['comparison_rows'] = $rows;
            $result[$id] = $base;
            if (!in_array($id, $order, true)) $order[] = $id;
        }
        foreach ($defaultMap as $id => $provider) {
            if (!isset($result[$id])) {
                $result[$id] = $provider;
            }
        }
        $rows = [];
        foreach ($order as $id) {
            if (isset($result[$id])) $rows[] = $result[$id];
        }
        return $rows ?: $defaults;
    }
}

if (!function_exists('crmSettingsNormalizeToolsDrawer')) {
    function crmSettingsNormalizeToolsDrawer($raw) {
        $defaults = crmSettingsDefaultToolsDrawer();
        $raw = is_array($raw) ? $raw : [];
        $fmPrice = is_numeric($raw['fm_price_per_report'] ?? null)
            ? round((float)$raw['fm_price_per_report'], 2)
            : round((float)($defaults['fm_price_per_report'] ?? 7), 2);
        return [
            'fm_price_per_report' => max(0, $fmPrice),
            'providers' => crmSettingsNormalizeToolsProviders($raw['providers'] ?? []),
        ];
    }
}

if (!function_exists('crmSettingsNormalizeRoot')) {
    function crmSettingsNormalizeRoot($raw) {
        $raw = is_array($raw) ? $raw : [];
        return [
            'sms_templates' => crmSettingsNormalizeSmsTemplates($raw['sms_templates'] ?? []),
            'email_templates' => crmSettingsNormalizeEmailTemplates($raw['email_templates'] ?? []),
            'call_dispositions' => crmSettingsNormalizeCallDispositions($raw['call_dispositions'] ?? []),
            'tools_drawer' => crmSettingsNormalizeToolsDrawer($raw['tools_drawer'] ?? []),
        ];
    }
}

if (!function_exists('crmSettingsActorCanManage')) {
    function crmSettingsActorCanManage($actor = '') {
        $actor = strtolower(trim((string)($actor ?: ($_SESSION['user_email'] ?? ''))));
        if ($actor === '') return false;
        if (function_exists('userHasSalesPermission')) {
            return userHasSalesPermission($actor, 'sales_manage_email_templates', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager'])
                || userHasSalesPermission($actor, 'sales_manage_sequence_templates', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager'])
                || userHasSalesPermission($actor, 'sales_manage_caller_accounts', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
        }
        if (function_exists('isAdmin') && isAdmin()) return true;
        if (function_exists('userHasPerm') && (userHasPerm($actor, 'manage_users') || userHasPerm($actor, 'manage_sales_users'))) {
            return true;
        }
        if (function_exists('readUserDataByEmail')) {
            $u = readUserDataByEmail($actor);
            $role = strtolower(trim((string)($u['role'] ?? '')));
            if (in_array($role, ['admin', 'system_admin', 'sales_manager'], true)) return true;
        }
        return false;
    }
}

if (!function_exists('crmSettingsActorCanManageSection')) {
    function crmSettingsActorCanManageSection($section, $actor = '') {
        $actor = strtolower(trim((string)($actor ?: ($_SESSION['user_email'] ?? ''))));
        $section = strtolower(trim((string)$section));
        if ($actor === '') return false;
        if (function_exists('userHasSalesPermission')) {
            if ($section === 'email_templates') {
                return userHasSalesPermission($actor, 'sales_manage_email_templates', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
            }
            if (in_array($section, ['sms_templates', 'call_dispositions', 'tools_drawer'], true)) {
                return userHasSalesPermission($actor, 'sales_manage_sequence_templates', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
            }
            if ($section === 'caller_accounts') {
                return userHasSalesPermission($actor, 'sales_manage_caller_accounts', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager']);
            }
        }
        return crmSettingsActorCanManage($actor);
    }
}

if (!function_exists('crmSettingsReadForOrg')) {
    function crmSettingsReadForOrg($orgId) {
        if ($orgId === '' || !function_exists('orgRead')) return crmSettingsNormalizeRoot([]);
        $org = orgRead($orgId);
        if (!is_array($org)) return crmSettingsNormalizeRoot([]);
        return crmSettingsNormalizeRoot($org['crm_settings'] ?? []);
    }
}

if (!function_exists('crmSettingsWriteForOrg')) {
    function crmSettingsWriteForOrg($orgId, array $settings) {
        if ($orgId === '' || !function_exists('orgRead') || !function_exists('orgWrite')) return false;
        $org = orgRead($orgId);
        if (!is_array($org)) return false;
        $org['crm_settings'] = crmSettingsNormalizeRoot($settings);
        return (bool)orgWrite($orgId, $org);
    }
}

if (!function_exists('crmSettingsConfigKey')) {
    function crmSettingsConfigKey() {
        return 'crm_settings';
    }
}

if (!function_exists('crmSettingsReadGlobal')) {
    function crmSettingsReadGlobal($actor = '') {
        $actor = strtolower(trim((string)$actor));
        $raw = function_exists('serverConfigGet')
            ? serverConfigGet(crmSettingsConfigKey(), null)
            : null;
        if (is_array($raw) && !empty($raw)) {
            return crmSettingsNormalizeRoot($raw);
        }

        $orgId = '';
        if (function_exists('actorOrgIdFromSession')) {
            $orgId = (string)(actorOrgIdFromSession() ?? '');
        }
        if ($orgId === '' && $actor !== '' && function_exists('orgIdForUserEmail')) {
            $orgId = (string)(orgIdForUserEmail($actor) ?? '');
        }
        if ($orgId !== '') {
            $fallback = crmSettingsReadForOrg($orgId);
            if (function_exists('serverConfigSet')) {
                @serverConfigSet(crmSettingsConfigKey(), $fallback);
            }
            return $fallback;
        }

        return crmSettingsNormalizeRoot([]);
    }
}

if (!function_exists('crmSettingsWriteGlobal')) {
    function crmSettingsWriteGlobal(array $settings, $actor = '') {
        $normalized = crmSettingsNormalizeRoot($settings);
        if (function_exists('serverConfigSet')) {
            return (bool)serverConfigSet(crmSettingsConfigKey(), $normalized);
        }

        $orgId = '';
        if (function_exists('actorOrgIdFromSession')) {
            $orgId = (string)(actorOrgIdFromSession() ?? '');
        }
        if ($orgId === '' && $actor !== '' && function_exists('orgIdForUserEmail')) {
            $orgId = (string)(orgIdForUserEmail($actor) ?? '');
        }
        if ($orgId === '') return false;
        return crmSettingsWriteForOrg($orgId, $normalized);
    }
}

if (!function_exists('crmSettingsSnapshotForSession')) {
    function crmSettingsSnapshotForSession() {
        $orgId = function_exists('actorOrgIdFromSession') ? (string)(actorOrgIdFromSession() ?? '') : '';
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $settings = crmSettingsReadGlobal($actor);
        return [
            'org_id' => $orgId,
            'storage' => 'server_config',
            'can_manage' => crmSettingsActorCanManage($actor),
            'permissions' => [
                'sms_templates' => crmSettingsActorCanManageSection('sms_templates', $actor),
                'email_templates' => crmSettingsActorCanManageSection('email_templates', $actor),
                'call_dispositions' => crmSettingsActorCanManageSection('call_dispositions', $actor),
                'tools_drawer' => crmSettingsActorCanManageSection('tools_drawer', $actor),
            ],
            'sms_templates' => $settings['sms_templates'],
            'email_templates' => $settings['email_templates'],
            'call_dispositions' => $settings['call_dispositions'],
            'tools_drawer' => $settings['tools_drawer'],
        ];
    }
}

if (!function_exists('crmSettingsPublicSnapshotForActor')) {
    function crmSettingsPublicSnapshotForActor($actor = '') {
        $snapshot = crmSettingsSnapshotForSession();
        return [
            'sms_templates' => $snapshot['sms_templates'],
            'email_templates' => $snapshot['email_templates'],
            'call_dispositions' => $snapshot['call_dispositions'],
            'tools_drawer' => $snapshot['tools_drawer'],
        ];
    }
}

if (!function_exists('crmSettingsDispositionLabelsForActor')) {
    function crmSettingsDispositionLabelsForActor($actor = '') {
        $snapshot = crmSettingsSnapshotForSession();
        $labels = [];
        foreach ($snapshot['call_dispositions'] as $row) {
            $label = trim((string)($row['label'] ?? ''));
            if ($label !== '') $labels[] = $label;
        }
        return $labels;
    }
}

if (!function_exists('crmSettingsSaveCallAnnotation')) {
    function crmSettingsSaveCallAnnotation(SQLite3 $db, $leadId, $dialEventId, $disposition, $notes, $actor, $now) {
        $leadId = trim((string)$leadId);
        $dialEventId = trim((string)$dialEventId);
        $disposition = trim((string)$disposition);
        $notes = trim((string)$notes);
        if ($leadId === '' || $dialEventId === '') return ['success' => false, 'error' => 'Missing lead or call id'];

        $leadRow = function_exists('leadRowById') ? leadRowById($db, $leadId) : null;
        if (!$leadRow) return ['success' => false, 'error' => 'Lead not found'];
        if (function_exists('leadRequireLeadView')) leadRequireLeadView($leadRow);

        $stmt = $db->prepare('SELECT * FROM lead_dial_events WHERE id = :id AND lead_id = :lead_id LIMIT 1');
        if (!$stmt) return ['success' => false, 'error' => 'Could not load call event'];
        if (function_exists('leadBindText')) {
            leadBindText($stmt, ':id', $dialEventId);
            leadBindText($stmt, ':lead_id', $leadId);
        } else {
            $stmt->bindValue(':id', $dialEventId, SQLITE3_TEXT);
            $stmt->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
        }
        $res = $stmt->execute();
        $dialEvent = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        if (!$dialEvent) return ['success' => false, 'error' => 'Call event not found'];

        $allowed = crmSettingsDispositionLabelsForActor($actor);
        if ($disposition !== '' && !in_array($disposition, $allowed, true)) {
            return ['success' => false, 'error' => 'Disposition is not in the company-wide list'];
        }

        $context = function_exists('leadDecodeJsonRowField')
            ? leadDecodeJsonRowField($dialEvent, 'context_json')
            : json_decode((string)($dialEvent['context_json'] ?? ''), true);
        if (!is_array($context)) $context = [];
        $context['disposition'] = $disposition;
        $context['notes'] = $notes;
        $context['disposition_updated_at'] = (int)$now;
        $context['disposition_updated_by_email'] = $actor;

        $json = json_encode($context);
        if ($json === false) return ['success' => false, 'error' => 'Could not encode call context'];

        $update = $db->prepare('UPDATE lead_dial_events SET context_json = :context_json WHERE id = :id AND lead_id = :lead_id');
        if (!$update) return ['success' => false, 'error' => 'Could not save call annotation'];
        if (function_exists('leadBindText')) {
            leadBindText($update, ':context_json', $json);
            leadBindText($update, ':id', $dialEventId);
            leadBindText($update, ':lead_id', $leadId);
        } else {
            $update->bindValue(':context_json', $json, SQLITE3_TEXT);
            $update->bindValue(':id', $dialEventId, SQLITE3_TEXT);
            $update->bindValue(':lead_id', $leadId, SQLITE3_TEXT);
        }
        if (!$update->execute()) return ['success' => false, 'error' => 'Could not save call annotation'];

        $dncTriggered = strcasecmp($disposition, 'Do Not Contact') === 0;
        if ($dncTriggered) {
            $metadata = function_exists('leadDecodeJsonRowField')
                ? leadDecodeJsonRowField($leadRow, 'metadata_json')
                : json_decode((string)($leadRow['metadata_json'] ?? ''), true);
            if (!is_array($metadata)) $metadata = [];
            $metadata['dnc'] = [
                'flagged' => true,
                'source' => 'ringcentral_disposition',
                'disposition' => 'Do Not Contact',
                'updated_at' => (int)$now,
                'updated_by_email' => $actor,
            ];
            if (function_exists('leadUpdateLeadMetadata')) {
                leadUpdateLeadMetadata($db, $leadId, $metadata, $actor, $now);
            }
            $currentStatus = function_exists('leadNormalizeStageStatus')
                ? leadNormalizeStageStatus($leadRow['status'] ?? 'contacted', 'contacted')
                : strtolower(trim((string)($leadRow['status'] ?? 'contacted')));
            if ($currentStatus !== 'do_not_contact' && function_exists('leadUpdateStage')) {
                if (leadUpdateStage($db, $leadId, 'do_not_contact', $actor, $now) && function_exists('leadInsertActivity') && function_exists('leadStageLabel')) {
                    leadInsertActivity($db, $leadId, $actor, [
                        'activity_type' => 'stage',
                        'subject' => leadStageLabel('do_not_contact'),
                        'body_text' => 'Lead marked as Do Not Contact from RingCentral call disposition.',
                        'metadata' => [
                            'from' => function_exists('leadStageLabel') ? leadStageLabel($currentStatus) : $currentStatus,
                            'to' => leadStageLabel('do_not_contact'),
                        ],
                    ], $now);
                }
            }
        }

        return [
            'success' => true,
            'context' => $context,
            'dnc_triggered' => $dncTriggered,
        ];
    }
}

if (!function_exists('handleCrmSettingsActions')) {
    function handleCrmSettingsActions($action) {
        if (!in_array($action, [
            'crm_settings_get',
            'crm_settings_save',
            'crm_call_annotation_save',
        ], true)) {
            return false;
        }

        requireLoginOrFail();
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));

        if ($action === 'crm_settings_get') {
            echo json_encode([
                'success' => true,
                'settings' => crmSettingsSnapshotForSession(),
            ]);
            return true;
        }

        if ($action === 'crm_settings_save') {
            if (!crmSettingsActorCanManage($actor)) {
                echo json_encode(['success' => false, 'error' => 'You do not have permission to manage CRM settings.']);
                return true;
            }
            $payload = [
                'sms_templates' => json_decode((string)($_POST['sms_templates_json'] ?? '[]'), true),
                'email_templates' => json_decode((string)($_POST['email_templates_json'] ?? '[]'), true),
                'call_dispositions' => json_decode((string)($_POST['call_dispositions_json'] ?? '[]'), true),
                'tools_drawer' => json_decode((string)($_POST['tools_drawer_json'] ?? '{}'), true),
            ];
            foreach (['sms_templates', 'email_templates', 'call_dispositions', 'tools_drawer'] as $section) {
                if (!crmSettingsActorCanManageSection($section, $actor) && isset($_POST[$section . '_json'])) {
                    echo json_encode(['success' => false, 'error' => 'You do not have permission to manage ' . str_replace('_', ' ', $section) . '.']);
                    return true;
                }
            }
            $settings = crmSettingsNormalizeRoot($payload);
            if (!crmSettingsWriteGlobal($settings, $actor)) {
                echo json_encode(['success' => false, 'error' => 'Could not save CRM settings.']);
                return true;
            }
            echo json_encode([
                'success' => true,
                'settings' => crmSettingsSnapshotForSession(),
            ]);
            return true;
        }

        if ($action === 'crm_call_annotation_save') {
            if (!function_exists('leadDb')) {
                echo json_encode(['success' => false, 'error' => 'Lead database is not available.']);
                return true;
            }
            if (function_exists('userHasSalesPermission') && !userHasSalesPermission($actor, 'sales_view_ringcentral_history', ['manage_users', 'manage_sales_users'], ['admin', 'system_admin', 'sales_manager'])) {
                echo json_encode(['success' => false, 'error' => 'You do not have permission to annotate RingCentral calls.']);
                return true;
            }
            $db = leadDb();
            $result = crmSettingsSaveCallAnnotation(
                $db,
                (string)($_POST['lead_id'] ?? ''),
                (string)($_POST['dial_event_id'] ?? ''),
                (string)($_POST['disposition'] ?? ''),
                (string)($_POST['notes'] ?? ''),
                $actor,
                time()
            );
            echo json_encode($result);
            return true;
        }

        return false;
    }
}
