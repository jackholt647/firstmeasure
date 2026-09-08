<?php

/**
 * Version-controlled fallback for the internal user permission editor.
 *
 * Deployments may provide a mutable data/permission_options.json override, but
 * stateless web nodes must still be able to render the complete permission
 * catalog when that legacy file is not mounted locally.
 */
function permissionOptionsBundledDefaults() {
    $sections = [
        ['key' => 'projects', 'label' => 'Projects', 'description' => 'Project visibility and editing controls.'],
        ['key' => 'users', 'label' => 'Users & Teams', 'description' => 'User, team, and crew administration.'],
        ['key' => 'production', 'label' => 'Production', 'description' => 'Production queue and tutorial controls.'],
        ['key' => 'quality', 'label' => 'Quality & Manager Review', 'description' => 'QA queues, blind auditing, and identity-gated quality reporting.'],
        ['key' => 'sales', 'label' => 'Sales & CRM', 'description' => 'Lead, outreach, analytics, and commission controls.'],
        ['key' => 'shifts', 'label' => 'Shifts', 'description' => 'Shift visibility and editing scope.'],
        ['key' => 'administration', 'label' => 'Administration', 'description' => 'Sensitive platform and operational controls.']
    ];

    $permissions = [];
    $addBoolean = function($key, $label, $section, $description = '') use (&$permissions) {
        $permissions[] = [
            'key' => $key,
            'label' => $label,
            'section' => $section,
            'type' => 'boolean',
            'default' => false,
            'description' => $description
        ];
    };

    foreach ([
        ['view_all_projects', 'View All Projects'],
        ['view_team_projects', 'View Team Projects'],
        ['create_projects', 'Create Projects'],
        ['edit_projects', 'Edit Projects'],
        ['cancel_projects', 'Cancel Projects'],
        ['create_filler_projects', 'Create Filler Projects']
    ] as $item) $addBoolean($item[0], $item[1], 'projects');

    foreach ([
        ['manage_users', 'Edit Users'],
        ['create_users', 'Add/Delete Users'],
        ['assign_teams', 'Assign Teams'],
        ['manage_company_users', 'Manage Company Users'],
        ['manage_sales_users', 'Manage Sales Users'],
        ['manage_crews', 'Manage Crews']
    ] as $item) $addBoolean($item[0], $item[1], 'users');

    foreach ([
        ['manage_queue', 'Manage Production Queue'],
        ['manage_tutorials', 'Manage Tutorials']
    ] as $item) $addBoolean($item[0], $item[1], 'production');

    foreach ([
        ['manage_qa', 'Perform QA Reviews'],
        ['manage_qa_queue', 'Manage QA Queue'],
        ['perform_manager_review', 'Perform Blind Manager Review'],
        ['view_manager_review_results', 'View Named Manager Review Results']
    ] as $item) $addBoolean($item[0], $item[1], 'quality');

    $salesPermissions = [
        'sales_view_own_assigned_leads' => 'View Own Assigned Leads',
        'sales_edit_lead_fields' => 'Edit Lead Fields',
        'sales_send_email' => 'Send Email from Lead Page',
        'sales_send_sms' => 'Send SMS from Lead Page',
        'sales_view_email_thread_history' => 'View Email Thread History',
        'sales_view_ringcentral_history' => 'View RingCentral Call/SMS History',
        'sales_view_orum_history' => 'View Orum Call History',
        'sales_schedule_calendar_events' => 'Schedule Calendar Events',
        'sales_enroll_lead_in_sequence' => 'Enroll Leads in Sequences',
        'sales_pause_sequence_on_lead' => 'Stop/Pause Lead Sequences',
        'sales_create_edit_followups' => 'Create/Edit Follow-ups',
        'sales_mark_followups_complete' => 'Mark Follow-ups Complete',
        'sales_star_primary_contact' => 'Star Primary Contacts',
        'sales_extend_bonus_offer' => 'Extend Bonus Offers',
        'sales_add_manual_leads' => 'Add Leads Manually',
        'sales_pair_account_to_lead_manually' => 'Pair Accounts to Leads Manually',
        'sales_view_own_analytics' => 'View Own Detailed Analytics',
        'sales_view_leaderboard_summary' => 'View Leaderboard Summary',
        'sales_view_other_callers_detailed_analytics' => 'View Other Callers\' Detailed Analytics',
        'sales_view_geographic_list_analytics' => 'View Geographic/List Analytics',
        'sales_pull_gmb_lead_lists' => 'Pull Google Business Lead Lists',
        'sales_manage_manual_lead_lists' => 'Create/Edit Manual Lead Lists',
        'sales_import_csv_lead_lists' => 'Import Lead Lists by CSV',
        'sales_assign_lists_to_callers' => 'Assign Lists to Callers',
        'sales_import_daily_orum_csv' => 'Import Daily Orum CSV',
        'sales_manage_sequence_templates' => 'Manage Sequence Templates',
        'sales_manage_email_templates' => 'Manage Email Templates',
        'sales_manage_caller_accounts' => 'Manage Caller Accounts',
        'sales_assign_customers_to_sdrs' => 'Assign Customers to SDRs',
        'sales_view_own_commission_summary' => 'View Own Commission Summary',
        'sales_view_all_commission_summaries' => 'View All Commission Summaries',
        'sales_export_commission_reports' => 'Export Commission Reports',
        'sales_view_all_callers_list_progress' => 'View All Callers\' List Progress',
        'sales_export_data' => 'Export Sales Data'
    ];
    foreach ($salesPermissions as $key => $label) $addBoolean($key, $label, 'sales');

    $permissions[] = [
        'key' => 'shift_view',
        'label' => 'View Shifts',
        'section' => 'shifts',
        'type' => 'select',
        'default' => 'self',
        'description' => 'Choose which employee shifts this user may view.',
        'options' => [
            ['value' => 'none', 'label' => 'None'],
            ['value' => 'self', 'label' => 'Own Shifts'],
            ['value' => 'team', 'label' => 'Team Shifts'],
            ['value' => 'all', 'label' => 'All Shifts']
        ]
    ];
    $permissions[] = [
        'key' => 'shift_edit',
        'label' => 'Edit Shifts',
        'section' => 'shifts',
        'type' => 'select',
        'default' => 'none',
        'description' => 'Choose which employee shifts this user may edit.',
        'options' => [
            ['value' => 'none', 'label' => 'None'],
            ['value' => 'self', 'label' => 'Own Shifts'],
            ['value' => 'team', 'label' => 'Team Shifts'],
            ['value' => 'all', 'label' => 'All Shifts']
        ]
    ];

    foreach ([
        ['manage_apple_key', 'Manage Apple Key'],
        ['manage_payroll', 'Manage Payroll'],
        ['manage_notifications', 'Manage Notifications'],
        ['debug_firstmeasure_api', 'Debug FirstMeasure API'],
        ['platform_admin', 'Platform Administrator'],
        ['is_admin_legacy', 'Legacy Administrator']
    ] as $item) $addBoolean($item[0], $item[1], 'administration');

    $managerSalesPermissions = array_fill_keys(array_keys($salesPermissions), true);
    $callerSalesPermissions = array_fill_keys([
        'sales_view_own_assigned_leads', 'sales_edit_lead_fields', 'sales_send_email',
        'sales_send_sms', 'sales_view_email_thread_history', 'sales_view_ringcentral_history',
        'sales_view_orum_history', 'sales_schedule_calendar_events',
        'sales_enroll_lead_in_sequence', 'sales_pause_sequence_on_lead',
        'sales_create_edit_followups', 'sales_mark_followups_complete',
        'sales_star_primary_contact', 'sales_extend_bonus_offer', 'sales_add_manual_leads',
        'sales_view_own_analytics', 'sales_view_leaderboard_summary',
        'sales_view_own_commission_summary'
    ], true);

    return [
        'version' => 2,
        'default_create_role' => ['production' => 'trainee', 'sales' => 'salesperson'],
        'sections' => $sections,
        'permissions' => $permissions,
        'roles' => [
            ['key' => 'admin', 'label' => 'Admin', 'icon' => 'fa-user-shield', 'color' => '#d93025', 'department' => 'production', 'training_complete' => true, 'contexts' => ['all'], 'grant_all_permissions' => true],
            ['key' => 'manager', 'label' => 'Manager', 'icon' => 'fa-user-tie', 'color' => '#7b1fa2', 'department' => 'production', 'training_complete' => true, 'contexts' => ['all'], 'preset_permissions' => ['view_all_projects' => true, 'view_team_projects' => true, 'manage_queue' => true, 'manage_qa_queue' => true, 'shift_view' => 'all', 'shift_edit' => 'none']],
            ['key' => 'qa', 'label' => 'QA', 'icon' => 'fa-clipboard-check', 'color' => '#e37400', 'department' => 'production', 'training_complete' => true, 'contexts' => ['all'], 'preset_permissions' => ['view_team_projects' => true, 'manage_qa' => true, 'shift_view' => 'all', 'shift_edit' => 'none']],
            ['key' => 'technician', 'label' => 'Technician', 'icon' => 'fa-drafting-compass', 'color' => '#1a73e8', 'department' => 'production', 'training_complete' => true, 'contexts' => ['all'], 'preset_permissions' => ['shift_view' => 'all', 'shift_edit' => 'none']],
            ['key' => 'sales_manager', 'label' => 'Sales Manager', 'icon' => 'fa-chart-line', 'color' => '#0b8043', 'department' => 'sales', 'training_complete' => true, 'contexts' => ['all'], 'preset_permissions' => array_merge($managerSalesPermissions, ['manage_sales_users' => true, 'manage_tutorials' => true, 'shift_view' => 'none', 'shift_edit' => 'none'])],
            ['key' => 'salesperson', 'label' => 'Salesperson', 'icon' => 'fa-handshake', 'color' => '#00897b', 'department' => 'sales', 'training_complete' => true, 'contexts' => ['all'], 'preset_permissions' => array_merge($callerSalesPermissions, ['shift_view' => 'none', 'shift_edit' => 'none'])],
            ['key' => 'trainee', 'label' => 'Trainee', 'icon' => 'fa-user-graduate', 'color' => '#5f6368', 'department' => 'production', 'training_complete' => false, 'contexts' => ['all'], 'preset_permissions' => ['shift_view' => 'none', 'shift_edit' => 'none']]
        ]
    ];
}
