<?php
require_once __DIR__ . '/_storage.php';
session_start();
$_SESSION['user_email'] = 'frank@1m8.ai';
$_SESSION['permissions'] = ['manage_sales_users'=>1,'view_all_callers_list_progress'=>1];
$_POST = ['action'=>'lead_my_leads','page'=>1,'per_page'=>5,'q'=>'','sort'=>'updated_at','dir'=>'desc','followup_scope'=>'all','target_email'=>'__all__'];
require '_lead.php';
ob_start();
handleLeadActions('lead_my_leads');
$out = ob_get_clean();
echo $out;
