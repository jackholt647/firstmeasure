<?php
require_once __DIR__ . '/_storage.php';
session_start();
require_once __DIR__ . '/_project_api.php';
require_once __DIR__ . '/_permission_options.php';

$userDir = storageDir('users');
$tutorialDir = storageDir('tutorials');

require_once __DIR__ . '/_organizations.php';

function getPermissionPresets($role) {
    return permissionOptionsPresetPermissions($role);
}

function isEmployeeUserData($u) {
    if (!is_array($u)) return false;

    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'employee') return true;
    if ($acct === 'customer') return false;

    $role = strtolower(trim((string)($u['role'] ?? '')));
    if ($role === 'admin') return true;
    if (!empty($u['is_admin'])) return true;

    $perms = permissionOptionsNormalizePermissions($u['permissions'] ?? [], $role);
    return permissionOptionsHasGrantedPermission($perms);
}

function salesDataAgentCanUse($userData, $perms) {
    if (!is_array($userData)) return false;
    if (($userData['account_type'] ?? '') === 'customer') return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    return $role === 'admin' || !empty($userData['is_admin']) || !empty($perms['is_admin_legacy']);
}

function getUserFile($email) {
    global $userDir;
    return $userDir . preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email))) . '.json';
}

function extractPortalStyles() {
    $indexPath = __DIR__ . '/index.php';
    if (!file_exists($indexPath)) return '';
    $raw = file_get_contents($indexPath);
    if (!is_string($raw) || $raw === '') return '';
    if (preg_match('/<style>(.*)<\/style>/sU', $raw, $m)) {
        return trim($m[1]);
    }
    return '';
}

function tutorialCourseIdFromRequest() {
    $raw = strtolower(trim((string)($_POST['course_id'] ?? $_GET['course_id'] ?? 'sales')));
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    return $slug !== '' ? $slug : 'sales';
}

function tutorialCourseBaseDir($courseId) {
    global $tutorialDir;
    return $tutorialDir . 'courses/' . $courseId . '/';
}

function tutorialEnsureCourseDirs($courseId) {
    $base = tutorialCourseBaseDir($courseId);
    if (!file_exists($base)) mkdir($base, 0777, true);
    if (!file_exists($base . 'master/')) mkdir($base . 'master/', 0777, true);
    return $base;
}

function tutorialProgressFile($courseId, $userSafe) {
    return tutorialEnsureCourseDirs($courseId) . $userSafe . '/progress.json';
}

function tutorialProjectThumbBase($courseId, $userSafe, $folderId) {
    return "tutorials/courses/$courseId/$userSafe/$folderId";
}

function salesSampleAssetUrl($folderId, $fileName) {
    $folderId = strtolower(trim((string)$folderId));
    $fileName = ltrim((string)$fileName, '/\\');
    if ($folderId === '' || $fileName === '') return null;
    return fm_project_asset_url($folderId, $fileName);
}

function salesSampleProjectDir($folderId) {
    return null;
}

function salesSampleOrgSummary($orgId) {
    $orgId = orgNormalizeId($orgId);
    if ($orgId === '') return null;
    $org = orgRead($orgId);
    if (!is_array($org)) return null;
    return [
        'id' => $orgId,
        'name' => $org['name'] ?? '',
        'branding' => $org['branding'] ?? null,
        'report_settings' => $org['report_settings'] ?? []
    ];
}

function salesSampleQueryProjects($payload) {
    if (!function_exists('fm_api_json')) return ['count' => 0, 'projects' => []];
    $res = fm_api_json('POST', 'projects/query', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['count' => 0, 'projects' => []];
    }
    return [
        'count' => max(0, (int)($res['json']['count'] ?? 0)),
        'projects' => is_array($res['json']['projects'] ?? null) ? $res['json']['projects'] : []
    ];
}

function salesSampleLegacySearchProjects($search, $limit = 500) {
    if (!function_exists('fm_api_json')) return ['count' => 0, 'projects' => []];
    $res = fm_api_json('POST', 'projects/list', [
        'filter' => 'all',
        'page' => 1,
        'limit' => max(1, min(500, (int)$limit)),
        'search' => (string)$search
    ]);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['count' => 0, 'projects' => []];
    }
    return [
        'count' => max(0, (int)($res['json']['pagination']['total_count'] ?? 0)),
        'projects' => is_array($res['json']['projects'] ?? null) ? $res['json']['projects'] : []
    ];
}

function salesSampleFetchProjectManifest($projectId) {
    $projectId = strtolower(trim((string)$projectId));
    if ($projectId === '' || !function_exists('fm_fetch_project_detail')) return null;
    $detail = fm_fetch_project_detail($projectId);
    if (!is_array($detail)) return null;

    $manifest = $detail['manifest'] ?? null;
    if (!is_array($manifest)) return null;

    if (empty($manifest['thumbnail'])) {
        $files = is_array($detail['files'] ?? null) ? $detail['files'] : [];
        foreach ($files as $file) {
            $name = strtolower(trim((string)($file['name'] ?? '')));
            if ($name === 'google.png') {
                $manifest['thumbnail'] = fm_project_asset_url($projectId, 'google.png');
                break;
            }
        }
    }

    return $manifest;
}

function salesSampleProjectSummary($project) {
    $manifest = null;
    if (is_array($project) && is_array($project['manifest'] ?? null)) {
        $manifest = $project['manifest'];
    } elseif (is_array($project)) {
        $manifest = $project;
    } else {
        $manifest = salesSampleFetchProjectManifest($project);
        if (!is_array($manifest)) return null;
    }

    $folderId = strtolower(trim((string)($manifest['id'] ?? '')));
    if ($folderId === '') return null;

    $status = strtolower(trim((string)($manifest['status'] ?? '')));
    $projectType = strtolower(trim((string)($manifest['project_type'] ?? 'residential')));
    if (!in_array($projectType, ['residential', 'commercial', 'multifamily'], true)) {
        $projectType = 'residential';
    }

    $timestamps = is_array($manifest['timestamps'] ?? null) ? $manifest['timestamps'] : [];
    $createdAt = (string)($manifest['created_at'] ?? $timestamps['created_at'] ?? '');
    $completedAt = (string)($manifest['completed_at'] ?? $timestamps['completed_at'] ?? '');
    $uploadedAt = (string)($manifest['uploaded_at'] ?? $timestamps['uploaded_at'] ?? '');
    if ($status === '' && $completedAt !== '') {
        $status = 'completed';
    }
    $sortAt = $uploadedAt !== '' ? $uploadedAt : ($completedAt !== '' ? $completedAt : $createdAt);
    $thumb = null;
    if (!empty($manifest['thumbnail'])) {
        $thumb = (string)$manifest['thumbnail'];
    } elseif (!empty(($manifest['assets'] ?? [])['google'])) {
        $thumb = (string)$manifest['assets']['google'];
    } elseif (!empty(($manifest['artifacts'] ?? [])['has_google_image'])) {
        $thumb = fm_project_asset_url($folderId, 'google.png');
    } elseif (!empty($manifest['has_google_image'])) {
        $thumb = fm_project_asset_url($folderId, 'google.png');
    }
    $reportUrl = fm_project_pdf_url($folderId, 'main');
    $hasSavedReport = !empty($manifest['has_report_pdf'])
        || !empty(($manifest['artifacts'] ?? [])['has_report_pdf'])
        || !empty(($manifest['artifacts'] ?? [])['has_main_pdf']);
    $hasPdfState = !empty(($manifest['artifacts'] ?? [])['has_pdf_state']) || !empty($manifest['has_pdf_state']);

    return [
        'id' => $folderId,
        'address' => (string)($manifest['address'] ?? ''),
        'status' => $status !== '' ? $status : 'unknown',
        'project_type' => $projectType,
        'created_at' => $createdAt,
        'completed_at' => $completedAt,
        'uploaded_at' => $uploadedAt,
        'sort_at' => $sortAt,
        'complexity' => $manifest['complexity'] ?? null,
        'thumbnail' => $thumb,
        'pdf_state_asset' => fm_project_doc_url($folderId, 'pdf_state'),
        'has_pdf_state' => $hasPdfState,
        'has_saved_report' => $hasSavedReport,
        'report_url' => $reportUrl,
        'issuer_name' => (string)($manifest['issuer']['name'] ?? $manifest['issuer_name'] ?? ''),
        'owner_email' => (string)($manifest['owner_email'] ?? $manifest['owner_ref']['email'] ?? ''),
        'organization_id' => orgNormalizeId($manifest['organization_id'] ?? $manifest['organization_ref']['id'] ?? ''),
        'is_filler' => !empty($manifest['is_filler'])
    ];
}

function salesSampleNormalizeFavoriteFolderId($value) {
    return preg_replace('/[^a-f0-9]/', '', strtolower(trim((string)$value)));
}

function salesSampleNormalizeFavoriteConfigs($raw) {
    if (!is_array($raw)) return [];
    $configs = [];
    foreach ($raw as $entry) {
        if (is_array($entry)) {
            $folderId = salesSampleNormalizeFavoriteFolderId($entry['id'] ?? ($entry['folder_id'] ?? ($entry['folder'] ?? '')));
            $label = trim((string)($entry['label'] ?? ($entry['name'] ?? '')));
        } else {
            $folderId = salesSampleNormalizeFavoriteFolderId($entry);
            $label = '';
        }
        if ($folderId === '') continue;
        if ($label === '') $label = $folderId;
        $configs[$folderId] = [
            'id' => $folderId,
            'label' => $label,
        ];
    }
    return array_values($configs);
}

function salesSampleNormalizeFavoriteIds($raw) {
    return array_values(array_map(function ($entry) {
        return (string)($entry['id'] ?? '');
    }, salesSampleNormalizeFavoriteConfigs($raw)));
}

function salesSampleFavoriteConfigs($userData) {
    $raw = $userData['sample_report_favorites'] ?? [];
    return salesSampleNormalizeFavoriteConfigs($raw);
}

function salesSampleFavoriteIds($userData) {
    return array_values(array_map(function ($entry) {
        return (string)($entry['id'] ?? '');
    }, salesSampleFavoriteConfigs($userData)));
}

function salesSampleWriteCurrentUserData($file, $userData) {
    if (!is_array($userData)) return false;
    return file_put_contents($file, json_encode($userData, JSON_PRETTY_PRINT)) !== false;
}

function salesSampleUserCanBrowseAll($userData, $perms = null) {
    if (!is_array($userData)) return false;
    $role = strtolower(trim((string)($userData['role'] ?? '')));
    if ($role === 'admin' || !empty($userData['is_admin'])) return true;

    $permBag = is_array($perms) ? $perms : ($userData['permissions'] ?? []);
    if (!is_array($permBag)) $permBag = [];

    foreach (['manage_users', 'manage_sales_users', 'is_admin_legacy', 'view_all_projects'] as $perm) {
        if (!empty($permBag[$perm])) return true;
    }

    return false;
}

function salesSampleSharedFavoritesFile() {
    return storageExistingPath('data/sample_report_favorites.json', __DIR__ . '/sample_report_favorites.json', true);
}

function salesSampleReadSharedFavoriteConfigs() {
    $file = salesSampleSharedFavoritesFile();
    if (file_exists($file)) {
        $decoded = json_decode((string)file_get_contents($file), true);
        if (is_array($decoded) && array_key_exists('favorites', $decoded)) {
            return salesSampleNormalizeFavoriteConfigs($decoded['favorites']);
        }
        if (is_array($decoded)) {
            return salesSampleNormalizeFavoriteConfigs($decoded);
        }
    }

    $seed = [];
    $userDir = storageDir('users');
    if (is_dir($userDir)) {
        foreach (scandir($userDir) as $entry) {
            if (pathinfo($entry, PATHINFO_EXTENSION) !== 'json') continue;
            $path = $userDir . $entry;
            $userData = json_decode((string)file_get_contents($path), true);
            if (!salesSampleUserCanBrowseAll($userData)) continue;
            foreach (salesSampleFavoriteConfigs($userData) as $config) {
                $folderId = (string)($config['id'] ?? '');
                if ($folderId === '') continue;
                $seed[$folderId] = [
                    'id' => $folderId,
                    'label' => trim((string)($config['label'] ?? '')) ?: $folderId,
                ];
            }
        }
    }

    $configs = array_values($seed);
    if ($configs) {
        @file_put_contents($file, json_encode(['favorites' => $configs], JSON_PRETTY_PRINT));
    }
    return $configs;
}

function salesSampleReadSharedFavoriteIds() {
    return array_values(array_map(function ($entry) {
        return (string)($entry['id'] ?? '');
    }, salesSampleReadSharedFavoriteConfigs()));
}

function salesSampleWriteSharedFavoriteConfigs($configs) {
    $file = salesSampleSharedFavoritesFile();
    $normalized = salesSampleNormalizeFavoriteConfigs(is_array($configs) ? $configs : []);
    return file_put_contents($file, json_encode(['favorites' => array_values($normalized)], JSON_PRETTY_PRINT)) !== false;
}

function salesSampleWriteSharedFavoriteIds($ids) {
    $normalizedIds = salesSampleNormalizeFavoriteIds(is_array($ids) ? $ids : []);
    $configs = array_map(function ($id) {
        return ['id' => $id, 'label' => $id];
    }, $normalizedIds);
    return salesSampleWriteSharedFavoriteConfigs($configs);
}

if (!isset($_SESSION['user_email'])) {
    header("Location: backend_login.php?redirect=" . urlencode($_SERVER['REQUEST_URI']));
    exit;
}

$currentUserEmail = $_SESSION['user_email'];
$currentUserName = $_SESSION['user_name'] ?? $currentUserEmail;
$uFile = getUserFile($currentUserEmail);
if (!file_exists($uFile)) {
    header("Location: backend_logout.php");
    exit;
}

$myUserData = json_decode(file_get_contents($uFile), true);
if (!isEmployeeUserData($myUserData)) {
    header("Location: /app");
    exit;
}

$myPerms = permissionOptionsNormalizePermissions($myUserData['permissions'] ?? [], $myUserData['role'] ?? 'user');
$canDataAgent = salesDataAgentCanUse($myUserData, $myPerms);
$myTrainingComplete = !empty($myUserData['training_complete']);
$sampleReportsAdmin = salesSampleUserCanBrowseAll($myUserData, $myPerms);
$salesRole = strtolower(trim((string)($myUserData['role'] ?? 'user')));
$isSalesManagerOrAdmin = !empty($myUserData['is_admin'])
    || !empty($myPerms['is_admin_legacy'])
    || !empty($myPerms['manage_sales_users'])
    || in_array($salesRole, ['sales_manager', 'admin', 'system_admin'], true);
$salesHasPerm = function($key, $legacy = []) use ($myPerms, $salesRole) {
    if ($key !== '' && !empty($myPerms[$key])) return true;
    foreach ((array)$legacy as $legacyKey) {
        if ($legacyKey !== '' && !empty($myPerms[$legacyKey])) return true;
    }
    return in_array($salesRole, ['sales_manager', 'admin', 'system_admin', 'lead'], true);
};
$canManageUsers = $salesHasPerm('manage_sales_users', ['manage_users', 'create_users']);
$canViewOwnAssignedLeads = $salesHasPerm('sales_view_own_assigned_leads', ['manage_users', 'manage_sales_users', 'create_users']);
$canViewAllCallersListProgress = $salesHasPerm('sales_view_all_callers_list_progress', ['manage_users', 'manage_sales_users']);
$canViewOwnAnalytics = $salesHasPerm('sales_view_own_analytics', ['manage_users', 'manage_sales_users']);
$canViewOtherAnalytics = $salesHasPerm('sales_view_other_callers_detailed_analytics', ['manage_users', 'manage_sales_users']);
$canViewGeoAnalytics = $salesHasPerm('sales_view_geographic_list_analytics', ['manage_users', 'manage_sales_users']);
$canViewLeaderboardSummary = $salesHasPerm('sales_view_leaderboard_summary', ['manage_users', 'manage_sales_users']);
$canManageEmailTemplates = $salesHasPerm('sales_manage_email_templates', ['manage_users', 'manage_sales_users']);
$canManageSequenceTemplates = $salesHasPerm('sales_manage_sequence_templates', ['manage_users', 'manage_sales_users']);
$canManageCallerAccounts = $salesHasPerm('sales_manage_caller_accounts', ['manage_users', 'manage_sales_users', 'create_users']);
$canViewOwnCommissionSummary = $salesHasPerm('sales_view_own_commission_summary', ['manage_users', 'manage_sales_users']);
$canViewAllCommissionSummaries = $salesHasPerm('sales_view_all_commission_summaries', ['manage_users', 'manage_sales_users']);
$canEnrollSequences = $salesHasPerm('sales_enroll_lead_in_sequence', ['manage_users', 'manage_sales_users']);
$canPauseSequences = $salesHasPerm('sales_pause_sequence_on_lead', ['manage_users', 'manage_sales_users']);
$canManageCrmSettings = $canManageEmailTemplates || $canManageSequenceTemplates || $canManageCallerAccounts;
$canViewDashboard = $canViewOwnAssignedLeads || $canViewOwnAnalytics || $canViewLeaderboardSummary || $canViewAllCallersListProgress;
$canViewPipeline = $canViewOwnAssignedLeads || $canViewAllCallersListProgress;
$canViewSequences = $canEnrollSequences || $canPauseSequences || $canManageSequenceTemplates || $canViewOwnAssignedLeads;
$canViewAnalytics = $canViewOwnAnalytics || $canViewOtherAnalytics || $canViewGeoAnalytics || $canViewLeaderboardSummary;
$canViewCommissions = $canViewOwnCommissionSummary || $canViewAllCommissionSummaries;
$canShowSequencesTab = $canViewSequences && $isSalesManagerOrAdmin;
$canShowAnalyticsTab = $canViewAnalytics && $isSalesManagerOrAdmin;
$canShowUsersTab = $canManageUsers && $isSalesManagerOrAdmin;
$canShowReferralPartnersTab = $isSalesManagerOrAdmin;
$canShowReferralRewardsTab = $isSalesManagerOrAdmin;
$canShowSettingsTab = false;
$defaultSalesView = $canViewDashboard
    ? 'home'
    : ($canViewPipeline
        ? 'pipeline'
        : ($canShowSequencesTab
            ? 'sequences'
            : ($canShowAnalyticsTab ? 'analytics' : 'sample-reports')));

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    header('Content-Type: application/json');

    if ($action === 'list_sample_projects') {
        $searchRaw = trim((string)($_POST['search'] ?? ''));
        $search = strtolower($searchRaw);
        $projectType = strtolower(trim((string)($_POST['project_type'] ?? 'all')));
        $reportState = strtolower(trim((string)($_POST['report_state'] ?? 'all')));
        $page = max(1, (int)($_POST['page'] ?? 1));
        $limit = max(1, min(48, (int)($_POST['limit'] ?? 18)));
        $favoriteConfigs = salesSampleReadSharedFavoriteConfigs();
        $favoriteIds = array_values(array_map(function ($entry) {
            return (string)($entry['id'] ?? '');
        }, $favoriteConfigs));
        $favoriteMap = array_fill_keys($favoriteIds, true);
        $favoriteLabels = [];
        foreach ($favoriteConfigs as $favoriteConfig) {
            $favoriteId = (string)($favoriteConfig['id'] ?? '');
            if ($favoriteId === '') continue;
            $favoriteLabels[$favoriteId] = trim((string)($favoriteConfig['label'] ?? '')) ?: $favoriteId;
        }

        if (!in_array($projectType, ['all', 'residential', 'commercial', 'multifamily'], true)) {
            $projectType = 'all';
        }
        if (!in_array($reportState, ['all', 'saved_report', 'generated_only'], true)) {
            $reportState = 'all';
        }

        $sourceProjects = [];
        $sourceCount = 0;
        $searchNotice = null;

        if ($sampleReportsAdmin) {
            if ($search !== '') {
                $queryResult = salesSampleLegacySearchProjects($searchRaw, 500);
                $legacyRows = is_array($queryResult['projects'] ?? null) ? $queryResult['projects'] : [];
                $sourceCount = max(0, (int)($queryResult['count'] ?? 0));
                foreach ($legacyRows as $legacyRow) {
                    $legacyId = strtolower(trim((string)($legacyRow['id'] ?? '')));
                    if ($legacyId === '') continue;
                    $manifest = salesSampleFetchProjectManifest($legacyId);
                    if (is_array($manifest)) $sourceProjects[] = $manifest;
                }
            } else {
                $queryPayload = [
                    'statuses' => ['completed'],
                    'include_all' => true,
                    'limit' => min(500, max(($page * $limit) + count($favoriteIds) + 15, $limit))
                ];
                if ($projectType !== 'all') $queryPayload['project_type'] = $projectType;
                if ($reportState === 'saved_report') $queryPayload['has_report_pdf'] = true;
                if ($reportState === 'generated_only') $queryPayload['has_report_pdf'] = false;

                $queryResult = salesSampleQueryProjects($queryPayload);
                $sourceProjects = is_array($queryResult['projects'] ?? null) ? $queryResult['projects'] : [];
                $sourceCount = max(0, (int)($queryResult['count'] ?? 0));
            }

            $sourceIdMap = [];
            foreach ($sourceProjects as $project) {
                $sourceId = strtolower(trim((string)($project['id'] ?? '')));
                if ($sourceId !== '') $sourceIdMap[$sourceId] = true;
            }
            foreach ($favoriteIds as $favoriteId) {
                if (!empty($sourceIdMap[$favoriteId])) continue;
                $favoriteProject = salesSampleFetchProjectManifest($favoriteId);
                if (is_array($favoriteProject)) {
                    $sourceProjects[] = $favoriteProject;
                }
            }
        } else {
            foreach ($favoriteIds as $favoriteId) {
                $favoriteProject = salesSampleFetchProjectManifest($favoriteId);
                if (is_array($favoriteProject)) {
                    $sourceProjects[] = $favoriteProject;
                }
            }
            $sourceCount = count($sourceProjects);
        }

        if (!$sourceProjects && function_exists('fm_fetch_all_projects')) {
            if ($sampleReportsAdmin) {
                $sourceProjects = fm_fetch_all_projects(true);
                $sourceCount = count($sourceProjects);
            }
        }

        $items = [];
        $seen = [];
        foreach ($sourceProjects as $project) {
            $folderId = strtolower(trim((string)($project['id'] ?? '')));
            if ($folderId === '') continue;
            if (isset($seen[$folderId])) continue;
            $seen[$folderId] = true;

            $summary = salesSampleProjectSummary($project);
            if (!$summary) continue;
            if (($summary['status'] ?? '') !== 'completed') continue;
            if (empty($summary['has_pdf_state'])) continue;

            if ($projectType !== 'all' && $summary['project_type'] !== $projectType) continue;
            if ($reportState === 'saved_report' && !$summary['has_saved_report']) continue;
            if ($reportState === 'generated_only' && $summary['has_saved_report']) continue;

            if ($search !== '' && !$sampleReportsAdmin) {
                $haystack = strtolower(implode(' ', [
                    $summary['address'] ?? '',
                    $summary['project_type'] ?? '',
                    $summary['status'] ?? '',
                    $summary['issuer_name'] ?? '',
                    $summary['owner_email'] ?? ''
                ]));
                if (strpos($haystack, $search) === false) continue;
            }

            $summary['is_favorite'] = !empty($favoriteMap[$summary['id'] ?? '']);
            $items[] = $summary;
        }

        usort($items, function($a, $b) {
            $aFav = !empty($a['is_favorite']);
            $bFav = !empty($b['is_favorite']);
            if ($aFav !== $bFav) return $aFav ? -1 : 1;
            $ta = strtotime((string)($a['sort_at'] ?? '')) ?: 0;
            $tb = strtotime((string)($b['sort_at'] ?? '')) ?: 0;
            if ($ta === $tb) {
                return strcmp((string)($a['address'] ?? ''), (string)($b['address'] ?? ''));
            }
            return $tb <=> $ta;
        });

        if ($search !== '' && $sourceCount > 0 && count($items) === 0) {
            $searchNotice = 'Matching projects were found, but they are not sample-ready yet. These projects are usually missing a saved pdf_state snapshot.';
        }

        $totalCount = ($search !== '') ? count($items) : max($sourceCount, count($items));
        $totalPages = max(1, (int)ceil($totalCount / $limit));
        if ($page > $totalPages) $page = $totalPages;
        $offset = ($page - 1) * $limit;
        $slice = array_slice($items, $offset, $limit);

        foreach ($slice as &$projectRow) {
            $projectId = (string)($projectRow['id'] ?? '');
            if ($projectId !== '' && isset($favoriteLabels[$projectId])) {
                $projectRow['favorite_label'] = $favoriteLabels[$projectId];
            }
        }
        unset($projectRow);

        echo json_encode([
            'success' => true,
            'projects' => array_values($slice),
            'favorite_ids' => array_keys($favoriteMap),
            'favorite_configs' => array_values($favoriteConfigs),
            'sample_reports_admin' => $sampleReportsAdmin,
            'search_notice' => $searchNotice,
            'pagination' => [
                'current_page' => $page,
                'total_pages' => $totalPages,
                'total_count' => $totalCount,
                'limit' => $limit
            ]
        ]);
        exit;
    }

    if ($action === 'toggle_sample_favorite') {
        if (!$sampleReportsAdmin) {
            echo json_encode(['success' => false, 'error' => 'Only managers can update shared sample pins']);
            exit;
        }
        $folderId = salesSampleNormalizeFavoriteFolderId($_POST['folder'] ?? '');
        $favorite = filter_var($_POST['favorite'] ?? '0', FILTER_VALIDATE_BOOLEAN);
        $label = trim((string)($_POST['label'] ?? ''));
        if ($folderId === '') {
            echo json_encode(['success' => false, 'error' => 'Missing folder']);
            exit;
        }

        $favoriteConfigs = salesSampleReadSharedFavoriteConfigs();
        $favoriteMap = [];
        foreach ($favoriteConfigs as $config) {
            $configId = (string)($config['id'] ?? '');
            if ($configId === '') continue;
            $favoriteMap[$configId] = [
                'id' => $configId,
                'label' => trim((string)($config['label'] ?? '')) ?: $configId,
            ];
        }
        if ($favorite) {
            $favoriteMap[$folderId] = [
                'id' => $folderId,
                'label' => $label !== '' ? $label : (trim((string)($favoriteMap[$folderId]['label'] ?? '')) ?: $folderId),
            ];
        } else {
            unset($favoriteMap[$folderId]);
        }

        if (!salesSampleWriteSharedFavoriteConfigs(array_values($favoriteMap))) {
            echo json_encode(['success' => false, 'error' => 'Could not save shared pin']);
            exit;
        }

        echo json_encode([
            'success' => true,
            'folder' => $folderId,
            'favorite' => $favorite,
            'favorite_label' => $favorite ? (string)($favoriteMap[$folderId]['label'] ?? $folderId) : '',
            'favorite_ids' => array_values(array_keys($favoriteMap)),
            'favorite_configs' => array_values($favoriteMap)
        ]);
        exit;
    }

    if ($action === 'load_sample_project_bundle') {
        $folderId = preg_replace('/[^a-f0-9]/', '', strtolower(trim((string)($_POST['folder'] ?? ''))));
        if ($folderId === '') {
            echo json_encode(['success' => false, 'error' => 'Missing folder']);
            exit;
        }
        if (!$sampleReportsAdmin) {
            $favoriteMap = array_fill_keys(salesSampleReadSharedFavoriteIds(), true);
            if (empty($favoriteMap[$folderId])) {
                echo json_encode(['success' => false, 'error' => 'Only pinned favorites are available for this account']);
                exit;
            }
        }

        $bundle = function_exists('fm_fetch_project_bundle') ? fm_fetch_project_bundle($folderId) : null;
        if (!is_array($bundle)) {
            echo json_encode(['success' => false, 'error' => 'Project not found']);
            exit;
        }
        $manifestClean = $bundle['manifest'] ?? [];
        $appMeta = $bundle['app_metadata'] ?? null;

        echo json_encode([
            'success' => true,
            'folder' => $folderId,
            'manifest' => $manifestClean,
            'organization' => salesSampleOrgSummary($manifestClean['organization_id'] ?? ''),
            'app_metadata' => $appMeta,
            'pdf_state_asset' => fm_project_doc_url($folderId, 'pdf_state'),
            'report_url' => fm_project_pdf_url($folderId, 'main'),
            'thumbnail' => ($bundle['assets']['google'] ?? null)
        ]);
        exit;
    }

    if ($action === 'fetch_users') {
        if (empty($myPerms['manage_users']) && empty($myPerms['manage_sales_users'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            exit;
        }

        $users = [];
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if (!$u) continue;
                unset($u['password_hash']);
            $u['permissions'] = permissionOptionsNormalizePermissions($u['permissions'] ?? [], $u['role'] ?? 'user');
                if (!isset($u['department']) || !is_string($u['department']) || trim($u['department']) === '') $u['department'] = 'production';
                $u['training_complete'] = !empty($u['training_complete']);
                if (!isEmployeeUserData($u)) continue;
                $users[] = $u;
            }
        }

        echo json_encode(['success' => true, 'users' => $users]);
        exit;
    }

    if ($action === 'save_user') {
        $mode = $_POST['mode'] ?? '';
        if ($mode === 'create' && empty($myPerms['create_users']) && empty($myPerms['manage_sales_users'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized to create']);
            exit;
        }
        if ($mode === 'edit' && empty($myPerms['manage_users']) && empty($myPerms['manage_sales_users'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized to edit']);
            exit;
        }

        $email = strtolower(trim($_POST['email'] ?? ''));
        $name = $_POST['name'] ?? '';
        $role = $_POST['role'] ?? 'user';
        $team = $_POST['team'] ?? 'default';
        $department = strtolower(trim($_POST['department'] ?? 'production'));
        if (!in_array($department, ['production', 'sales'], true)) $department = 'production';
        $compPref = $_POST['complexity_preference'] ?? 'all';
        $perms = json_decode($_POST['permissions'] ?? '{}', true);
        $qMode = $_POST['queue_mode'] ?? 'disabled';
        $pass = $_POST['password'] ?? '';
        $trainingComplete = filter_var($_POST['training_complete'] ?? '0', FILTER_VALIDATE_BOOLEAN);

        if ($email === '') {
            echo json_encode(['success' => false, 'error' => 'Email required']);
            exit;
        }

        $perms = permissionOptionsNormalizePermissions($perms, $role);

        $file = getUserFile($email);
        if ($mode === 'create') {
            if (file_exists($file)) {
                echo json_encode(['success' => false, 'error' => 'User already exists']);
                exit;
            }
            if (!$pass) {
                echo json_encode(['success' => false, 'error' => 'Password required for new users']);
                exit;
            }
            $uData = [
                'email' => $email,
                'created_at' => date('Y-m-d H:i:s'),
                'is_verified' => true,
                'training_complete' => $trainingComplete ? true : false,
            ];
        } else {
            if (!file_exists($file)) {
                echo json_encode(['success' => false, 'error' => 'User not found']);
                exit;
            }
            $uData = json_decode(file_get_contents($file), true);
            if (!is_array($uData)) $uData = [];
            $existingAcct = strtolower(trim((string)($uData['account_type'] ?? '')));
            if ($existingAcct === 'customer') {
                echo json_encode(['success' => false, 'error' => 'Refusing to edit customer account from employee user management']);
                exit;
            }
        }

        $uData['name'] = $name;
        $uData['role'] = $role;
        $uData['team_id'] = $team;
        $uData['department'] = $department;
        $uData['complexity_preference'] = $compPref;
        $uData['queue_mode'] = $qMode;
        $uData['shift_rate'] = max(0, min(100000, (int)($_POST['shift_rate'] ?? 940)));
        $uData['permissions'] = $perms;
        $uData['is_admin'] = !empty($perms['is_admin_legacy']) || ($role === 'admin');
        $uData['account_type'] = 'employee';
        $uData['training_complete'] = $trainingComplete ? true : false;

        if ($pass) $uData['password_hash'] = password_hash($pass, PASSWORD_DEFAULT);

        if (file_put_contents($file, json_encode($uData, JSON_PRETTY_PRINT)) === false) {
            echo json_encode(['success' => false, 'error' => 'File write error']);
            exit;
        }

        echo json_encode(['success' => true]);
        exit;
    }

    if ($action === 'delete_user') {
        if (empty($myPerms['assign_teams']) && empty($myPerms['manage_sales_users'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            exit;
        }
        $email = $_POST['email'] ?? '';
        $file = getUserFile($email);
        if (file_exists($file)) {
            unlink($file);
            echo json_encode(['success' => true]);
        } else {
            echo json_encode(['success' => false, 'error' => 'Not found']);
        }
        exit;
    }

    if ($action === 'fetch_student_list') {
        if (empty($myPerms['manage_tutorials'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            exit;
        }
        $courseId = tutorialCourseIdFromRequest();

        $students = [];
        if (is_dir($userDir)) {
            foreach (scandir($userDir) as $f) {
                if (pathinfo($f, PATHINFO_EXTENSION) !== 'json') continue;
                $u = json_decode(file_get_contents($userDir . $f), true);
                if (!isEmployeeUserData($u)) continue;

                $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($u['email'] ?? '')));
                $progFile = tutorialProgressFile($courseId, $userSafe);
                $progress = file_exists($progFile) ? json_decode(file_get_contents($progFile), true) : ['current_chapter' => 1];

                $students[] = [
                    'email' => $u['email'] ?? '',
                    'name' => $u['name'] ?? 'Unknown',
                    'current_chapter' => $progress['current_chapter'] ?? 1,
                ];
            }
        }

        echo json_encode(['success' => true, 'course_id' => $courseId, 'students' => $students]);
        exit;
    }

    if ($action === 'fetch_student_details') {
        if (empty($myPerms['manage_tutorials'])) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            exit;
        }

        $courseId = tutorialCourseIdFromRequest();
        $email = $_POST['email'] ?? '';
        $userSafe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim($email)));
        $progFile = tutorialProgressFile($courseId, $userSafe);
        $progress = file_exists($progFile)
            ? json_decode(file_get_contents($progFile), true)
            : ['current_chapter' => 1, 'completed_videos' => []];

        $projects = [];
        $uTutDir = tutorialEnsureCourseDirs($courseId) . $userSafe . '/';
        if (is_dir($uTutDir)) {
            foreach (scandir($uTutDir) as $f) {
                if ($f === '.' || $f === '..' || !is_dir($uTutDir . $f)) continue;
                $mFile = $uTutDir . $f . '/manifest.json';
                if (!file_exists($mFile)) continue;
                $m = json_decode(file_get_contents($mFile), true);
                $projects[] = [
                    'id' => $f,
                    'address' => $m['address'] ?? '',
                    'status' => $m['status'] ?? '',
                    'thumbnail' => tutorialProjectThumbBase($courseId, $userSafe, $f) . "/google.png",
                ];
            }
        }

        echo json_encode(['success' => true, 'course_id' => $courseId, 'progress' => $progress, 'projects' => $projects]);
        exit;
    }

    echo json_encode(['success' => false, 'error' => 'Unknown action']);
    exit;
}

$ver = time();
$portalStyles = extractPortalStyles();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Mate - Sales</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <style>
<?= $portalStyles !== '' ? $portalStyles : ':root{--primary:#d93025;--primary-light:#fce8e6;--bg-page:#f0f2f5;--bg-panel:#fff;--text-main:#202124;--text-muted:#5f6368;--border:#dadce0;--sidebar-width:270px;}body{background:var(--bg-page);color:var(--text-main);font-family:Segoe UI,Roboto,sans-serif;margin:0;padding:0;height:100vh;display:flex;overflow:hidden;}.sidebar{width:var(--sidebar-width);background:var(--bg-panel);border-right:1px solid var(--border);display:flex;flex-direction:column;}.main-content{flex:1;padding:30px;overflow-y:auto;}.nav-links{flex:1;padding:20px;display:flex;flex-direction:column;gap:5px;}.nav-btn{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:8px;background:transparent;border:none;color:var(--text-muted);font-weight:600;font-size:14px;cursor:pointer;text-align:left;text-decoration:none;}.nav-btn.active{background:var(--primary-light);color:var(--primary);} .panel-card,.tile,.modal-card,table{background:#fff;} .modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:2000;display:none;align-items:center;justify-content:center;} .modal-card{border-radius:12px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;} .md-project{width:900px;height:80vh;} .md-editor{width:1200px;height:90vh;} .md-student{width:1000px;height:85vh;}' ?>
        .sales-intro {
            padding: 18px;
            border-bottom: 1px solid var(--border);
            background: #fff;
        }
        .main-content > [id^="view-"] {
            padding-top: 24px;
            box-sizing: border-box;
            min-height: 0;
        }
        #portalPluginViews,
        #portalPluginViews > [id^="view-"] {
            min-height: 0;
        }
        .sales-intro .panel-card {
            margin: 0;
            box-shadow: none;
        }
        .main-content {
            padding-top: 30px !important;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            min-height: 0;
            position: relative;
        }
        body.lead-page-v5-active .main-content {
            overflow: hidden;
        }
        body.lead-page-v5-active #view-leads {
            min-height: 0;
            height: 100%;
            overflow: hidden;
        }
        body.lead-page-v5-active #view-leads,
        body.lead-page-v5-active #view-leads .leads-shell,
        body.lead-page-v5-active #view-leads .leads-shell-main,
        body.lead-page-v5-active #view-leads .lead-workspace,
        body.lead-page-v5-active #view-leads .lead-workspace-card,
        body.lead-page-v5-active #view-leads .lead-detail-body {
            min-height: 0;
            height: 100%;
            overflow: hidden;
        }
        #globalLeadWorkspace {
            position: absolute;
            inset: 0;
            z-index: 58;
            display: none;
            min-height: 0;
            overflow: hidden;
            background: var(--bg-page);
        }
        #globalLeadWorkspace.active {
            display: block;
        }
        #globalLeadWorkspaceBody {
            min-height: 0;
            height: 100%;
            overflow: hidden;
        }
        .sales-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 320px;
            color: #777;
            font-weight: 700;
        }
        #view-tutorials .fab-next {
            bottom: 94px !important;
        }
        @media (max-width: 860px) {
            #view-tutorials .fab-next {
                bottom: 86px !important;
            }
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo-area" style="gap:10px;">
            <img src="/images/logo_red.png" alt="First Mate" height="34"
                onerror="this.style.display='none'; document.getElementById('logoTxt').style.display='block';">
            <span id="logoTxt" style="display:none;">First Mate</span>
        </div>

        <div class="nav-links">
            <?php if ($canViewDashboard): ?>
            <button class="nav-btn" onclick="switchView('home', this)" id="nav-home">
                <i class="fas fa-house"></i> Dashboard
            </button>
            <?php endif; ?>
            <?php if ($canViewPipeline): ?>
            <button class="nav-btn" onclick="switchView('pipeline', this)" id="nav-pipeline">
                <i class="fas fa-fire"></i> Pipeline
            </button>
            <?php endif; ?>
            <?php if ($canShowSequencesTab): ?>
            <button class="nav-btn" onclick="switchView('sequences', this)" id="nav-sequences">
                <i class="fas fa-bolt"></i> Sequences
            </button>
            <?php endif; ?>
            <?php if ($canShowAnalyticsTab): ?>
            <button class="nav-btn" onclick="switchView('analytics', this)" id="nav-analytics">
                <i class="fas fa-chart-line"></i> Analytics
            </button>
            <?php endif; ?>
            <button class="nav-btn" onclick="switchView('sample-reports', this)" id="nav-sample-reports">
                <i class="fas fa-file-signature"></i> Sample Reports
            </button>
            <button class="nav-btn" onclick="switchView('tutorials', this)" id="nav-tutorials">
                <i class="fas fa-graduation-cap"></i> Tutorials
            </button>
            <?php if ($canShowUsersTab): ?>
            <button class="nav-btn" onclick="switchView('users', this)" id="nav-users">
                <i class="fas fa-users-cog"></i> Users & Teams
            </button>
            <?php endif; ?>
            <?php if ($canShowReferralPartnersTab): ?>
            <button class="nav-btn" onclick="switchView('referral-partners', this)" id="nav-referral-partners">
                <i class="fas fa-handshake-angle"></i> Referral Partners
            </button>
            <?php endif; ?>
            <?php if ($canShowReferralRewardsTab): ?>
            <button class="nav-btn" onclick="switchView('referral-rewards', this)" id="nav-referral-rewards">
                <i class="fas fa-gift"></i> Referral Rewards
            </button>
            <?php endif; ?>
            <?php if ($canShowSettingsTab): ?>
            <button class="nav-btn" onclick="switchView('settings', this)" id="nav-settings">
                <i class="fas fa-sliders-h"></i> Settings
            </button>
            <?php endif; ?>
            <div id="portalPluginNav"></div>
            <div style="flex:1"></div>
        </div>

        <div class="user-panel">
            <strong><?= htmlspecialchars($currentUserName) ?></strong><br>
            <span style="font-size:11px;"><?= htmlspecialchars($currentUserEmail) ?></span><br>
            <div style="margin-top:10px;">
                <a href="backend_logout.php" style="color:var(--primary); text-decoration:none; font-weight:600;">Sign Out</a>
            </div>
        </div>
    </div>

    <div class="main-content">
        <div id="view-home">
            <div id="dashboardRoot"></div>
        </div>

        <div id="view-pipeline" style="display:none;">
            <div id="pipelineRoot"></div>
        </div>

        <?php if ($canShowSequencesTab): ?>
        <div id="view-sequences" style="display:none;">
            <div id="sequencesRoot"></div>
        </div>
        <?php endif; ?>

        <?php if ($canShowAnalyticsTab): ?>
        <div id="view-analytics" style="display:none;">
            <div id="analyticsRoot"></div>
        </div>
        <?php endif; ?>

        <div id="view-sample-reports" style="display:none;"></div>

        <div id="view-tutorials" style="display:none;">
            <div class="header-bar">
                <h1>Sales Training</h1>
                <div style="display:flex; gap:10px;">
                    <?php if (!empty($myPerms['manage_tutorials']) && (($me['role'] ?? '') !== 'salesperson')): ?>
                        <button class="btn-secondary" onclick="openStudentProgress()">
                            <i class="fas fa-chart-line"></i> Student Progress
                        </button>
                        <button class="btn-secondary" onclick="openEditor()">
                            <i class="fas fa-edit"></i> Edit Curriculum
                        </button>
                    <?php endif; ?>
                </div>
            </div>

            <div id="chapterGrid" class="grid"></div>

            <div id="chapterDetail" style="display:none;">
                <button onclick="showChapterGrid()" style="margin-bottom:15px; background:none; border:none; color:#666; cursor:pointer; font-weight:600;">
                    <i class="fas fa-arrow-left"></i> Back to Chapters
                </button>

                <div class="chapter-header">
                    <h2 id="chapTitle" style="margin:0;">Chapter 1</h2>
                    <span id="chapProgress" style="background:#e8f0fe; color:#1a73e8; padding:4px 10px; border-radius:12px; font-size:12px; font-weight:bold;">-</span>
                </div>

                <div id="chapDescCard" class="chapter-desc-card"></div>

                <div class="col-3-layout">
                    <div>
                        <h3><i class="fas fa-video" style="color:#555;"></i> Videos</h3>
                        <div id="resList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-file-pdf" style="color:#555;"></i> Guides</h3>
                        <div id="guideList" class="res-list"></div>
                    </div>

                    <div>
                        <h3><i class="fas fa-project-diagram" style="color:#555;"></i> Hands-on Projects</h3>
                        <div id="projList" class="res-list" style="display:flex; flex-direction:column; gap:15px;"></div>
                    </div>
                </div>

                <button class="fab-next" onclick="completeChapter()" id="btnNextChapter">
                    Next Chapter <i class="fas fa-arrow-right"></i>
                </button>
            </div>
        </div>

        <div id="view-student-progress" style="display:none;">
            <div class="header-bar">
                <div style="display:flex; align-items:center; gap:15px;">
                    <button class="btn-secondary" onclick="switchView('tutorials')" title="Back"><i class="fas fa-arrow-left"></i></button>
                    <h1>Student Progress</h1>
                </div>
                <button class="btn-secondary" onclick="fetchStudentList()"><i class="fas fa-sync"></i> Refresh</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Email</th>
                        <th>Current Chapter</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="studentTable">
                    <tr><td colspan="4" style="text-align:center; padding:30px;">Loading...</td></tr>
                </tbody>
            </table>
        </div>

        <?php if ($canShowUsersTab): ?>
        <div id="view-users" style="display:none;">
            <div class="header-bar">
                <h1>User Management</h1>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="fetchUsers()"><i class="fas fa-sync"></i> Refresh</button>
                    <?php if (!empty($myPerms['create_users']) || !empty($myPerms['manage_sales_users'])): ?>
                    <button class="btn-primary" onclick="openUserModal('create')"><i class="fas fa-plus"></i> Add User</button>
                    <?php endif; ?>
                </div>
            </div>
            <div class="panel-card" style="max-width:none; margin-bottom:18px;">
                <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
                    <div class="filter-group" id="usersScopeFilter">
                        <button class="filter-btn active" type="button" data-user-scope="all">All</button>
                        <button class="filter-btn" type="button" data-user-scope="production">Production</button>
                        <button class="filter-btn" type="button" data-user-scope="sales">Sales</button>
                    </div>
                    <input id="usersSearchInput" type="text" placeholder="Search name, email, role, team..." style="min-width:280px; max-width:420px; padding:10px 12px; border:1px solid #ccc; border-radius:8px;">
                    <div id="usersResultSummary" style="font-size:12px; font-weight:800; color:#666;">Loading...</div>
                </div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th data-user-sort="name" style="cursor:pointer;">Name</th>
                        <th data-user-sort="email" style="cursor:pointer;">Email</th>
                        <th data-user-sort="role" style="cursor:pointer;">Role</th>
                        <th data-user-sort="department" style="cursor:pointer;">Dept</th>
                        <th data-user-sort="team_id" style="cursor:pointer;">Team ID</th>
                        <th data-user-sort="training_complete" style="cursor:pointer;">Training</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody id="usersTable"></tbody>
            </table>
        </div>
        <?php endif; ?>

        <?php if ($canShowReferralPartnersTab): ?>
        <div id="view-referral-partners" style="display:none;">
            <div id="referralPartnersRoot"></div>
        </div>
        <?php endif; ?>

        <?php if ($canShowReferralRewardsTab): ?>
        <div id="view-referral-rewards" style="display:none;">
            <div id="referralRewardsRoot"></div>
        </div>
        <?php endif; ?>

        <?php if ($canShowSettingsTab): ?>
        <div id="view-settings" style="display:none;"></div>
        <?php endif; ?>

        <div id="portalPluginViews"></div>
        <div id="globalLeadWorkspace" aria-live="polite">
            <div id="globalLeadWorkspaceBody"></div>
        </div>
    </div>

    <div class="modal-overlay" id="studentModal">
        <div class="modal-card md-student">
            <div class="modal-header">
                <h2 id="stModalTitle">Student Details</h2>
                <button onclick="closeModal('studentModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div style="display:grid; grid-template-columns: 1fr 2fr; gap:20px; height:100%;">
                    <div style="background:#f9f9f9; padding:20px; border-radius:8px;">
                        <h3 style="margin-top:0;">Progress</h3>
                        <div class="meta-group">
                            <div class="meta-label">Current Chapter</div>
                            <div class="meta-val" id="stCurrentChap" style="font-size:18px; font-weight:bold; color:var(--primary);"></div>
                        </div>
                        <hr>
                        <h4>Video Watch History</h4>
                        <div id="stVideoList" class="res-list" style="max-height:400px; overflow-y:auto;"></div>
                    </div>

                    <div style="display:flex; flex-direction:column;">
                        <h3 style="margin-top:0;">Started Projects</h3>
                        <p style="font-size:12px; color:#777; margin-bottom:15px;">These are the specific instances created by this student. Click to review or edit their work.</p>
                        <div id="stProjectGrid" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));"></div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="closeModal('studentModal')">Close</button>
            </div>
        </div>
    </div>

    <div class="modal-overlay" id="editorModal">
        <div class="modal-card md-editor">
            <div class="modal-header">
                <h2>Curriculum Editor</h2>
                <button onclick="closeModal('editorModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div id="editorContent"></div>
            </div>
            <div class="modal-footer">
                <div id="paginationCtr" class="pagination"></div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-secondary" onclick="addEditorChapter()">+ New Chapter</button>
                    <button class="btn-primary" onclick="saveCurriculum()">Save Curriculum</button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal-overlay" id="projModal">
        <div class="modal-card md-project">
            <div class="modal-header">
                <h2>Project Details</h2>
                <button onclick="closeModal('projModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body" style="padding:0;">
                <div class="proj-layout">
                    <div class="proj-meta" style="padding:25px; background:#f9f9f9;">
                        <div class="meta-group">
                            <div class="meta-label">Address</div>
                            <div class="meta-val" id="pmAddress"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Status</div>
                            <div class="meta-val" id="pmStatus"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Owner</div>
                            <div class="meta-val" id="pmOwner"></div>
                        </div>
                        <div class="meta-group">
                            <div class="meta-label">Date Created</div>
                            <div class="meta-val" id="pmDate"></div>
                        </div>

                        <div style="margin-top:auto; display:flex; gap:10px; flex-direction:column;">
                            <a href="#" target="_blank" id="pmPdfBtn" class="btn-secondary" style="text-align:center; text-decoration:none; gap:10px;">
                                <i class="fas fa-file-pdf"></i> Download PDF
                            </a>
                            <button class="btn-big-edit" id="pmEditBtn">
                                <i class="fas fa-edit"></i> Open in Editor
                            </button>
                        </div>
                    </div>
                    <div class="proj-gallery" style="padding:25px;">
                        <h3 style="margin-top:0; font-size:14px; color:#555;">Project Assets</h3>
                        <div class="gallery-grid" id="pmGallery"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="modal-overlay" id="userModal">
        <div class="modal-card md-user">
            <div class="modal-header">
                <h2 id="uModalTitle">Edit User</h2>
                <button onclick="closeModal('userModal')" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <form id="userForm">
                    <input type="hidden" id="uMode">
                    <div class="form-row"><label>Email</label><input type="email" id="uEmail" required></div>
                    <div class="form-row"><label>Full Name</label><input type="text" id="uName"></div>
                    <div class="form-row"><label>Password <span style="font-weight:normal; font-size:10px;">(Leave blank to keep existing)</span></label><input type="text" id="uPass"></div>
                    <div class="form-row"><label>Team Identifier</label><input type="text" id="uTeam" placeholder="default"></div>
                    <div class="form-row">
                        <label>User Department</label>
                        <select id="uDepartment" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="production">Production</option>
                            <option value="sales">Sales</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label>Queue Priority</label>
                        <select id="uComplexityPref" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="all">No Preference (FIFO)</option>
                            <option value="simple">Prioritize Simple</option>
                            <option value="complex">Prioritize Complex</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label>Queue Mode (Hot Swapping)</label>
                        <select id="uQueueMode" style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px;">
                            <option value="disabled">Disabled (Standard)</option>
                            <option value="wait_for_feedback">Wait for Feedback</option>
                            <option value="hot_swap">Hot Swapping Enabled</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label for="uShiftRate">Shift Rate (PHP/day)</label>
                        <input type="number" id="uShiftRate" min="0" max="100000" step="1" value="940" class="form-control" placeholder="940">
                    </div>

                    <div class="form-row">
                        <label>Training Complete</label>
                        <label style="display:flex; align-items:left; gap:10px; font-size:13px; text-transform:none; font-weight:700; color:#333; margin:0;">
                            <input type="checkbox" id="uTrainingComplete" style="width: 20px;">
                            Training complete. Approved for live system use.
                        </label>
                        <div style="font-size:11px; color:#777; margin-top:6px;">
                            Set manually by admin only. Not set automatically when chapters are finished.
                        </div>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Permissions Preset</label>
                    <div class="presets">
                        <button type="button" class="btn-preset" onclick="applyPreset('admin')">Admin</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('lead')">Team Lead</button>
                        <button type="button" class="btn-preset" onclick="applyPreset('user')">User</button>
                    </div>

                    <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#777; margin-bottom:5px;">Detailed Permissions</label>
                    <?php echo permissionOptionsRenderHtml(); ?>
                    <input type="hidden" id="uRoleLabel">
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn-danger" id="btnDeleteUser" style="margin-right:auto; display:none;" onclick="deleteUser()">Delete</button>
                <button class="btn-secondary" onclick="closeModal('userModal')">Cancel</button>
                <button class="btn-primary" onclick="saveUser()">Save User</button>
            </div>
        </div>
    </div>

<script>
const FIRSTMEASURE_API_BASE = (function() {
    const host = (location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') {
        return 'http://127.0.0.1:3111/v1/firstmeasure';
    }
    return `${location.origin}/v1/firstmeasure`;
})();
const V1_API_BASE = String(FIRSTMEASURE_API_BASE || '').replace(/\/firstmeasure\/?$/, '');
const INTERNAL_API_BASE = `${V1_API_BASE}/internal`;
const INTERNAL_LEGACY_ACTION_URL = `${INTERNAL_API_BASE}/legacy-action`;

window.PORTAL_CFG = {
    endpoints: {
        portal: INTERNAL_LEGACY_ACTION_URL,
        server: INTERNAL_LEGACY_ACTION_URL,
        data_agent: INTERNAL_LEGACY_ACTION_URL,
        lead_callback: INTERNAL_LEGACY_ACTION_URL,
        firstmeasure: FIRSTMEASURE_API_BASE,
        internal: INTERNAL_API_BASE,
        platform: `${V1_API_BASE}/platform`,
        crm: `${V1_API_BASE}/internal/crm`,
        crm_referrals: `${V1_API_BASE}/internal/crm/referrals`
    },
    tutorials: {
        course_id: 'sales',
        projects_enabled: false,
        label: 'Sales Training'
    },
    permission_model: <?php echo json_encode(permissionOptionsFrontendModel('sales')); ?>,
    perms: <?php echo json_encode($myPerms); ?>,
    user: {
        email: <?php echo json_encode($currentUserEmail); ?>,
        name: <?php echo json_encode($currentUserName); ?>,
        role: <?php echo json_encode($myUserData['role'] ?? 'user'); ?>,
        queue_mode: <?php echo json_encode($myUserData['queue_mode'] ?? 'disabled'); ?>,
        training_complete: <?php echo $myTrainingComplete ? 'true' : 'false'; ?>
    },
    flags: {
        is_sales_portal: true,
        can_data_agent: <?php echo $canDataAgent ? 'true' : 'false'; ?>,
        sample_reports_admin: <?php echo $sampleReportsAdmin ? 'true' : 'false'; ?>
    },
    capabilities: {
        sales_manager_or_admin: <?php echo $isSalesManagerOrAdmin ? 'true' : 'false'; ?>,
        manage_sales_users: <?php echo $canManageUsers ? 'true' : 'false'; ?>,
        view_own_assigned_leads: <?php echo $canViewOwnAssignedLeads ? 'true' : 'false'; ?>,
        view_all_callers_list_progress: <?php echo $canViewAllCallersListProgress ? 'true' : 'false'; ?>,
        view_dashboard: <?php echo $canViewDashboard ? 'true' : 'false'; ?>,
        view_pipeline: <?php echo $canViewPipeline ? 'true' : 'false'; ?>,
        view_sequences: <?php echo $canViewSequences ? 'true' : 'false'; ?>,
        view_analytics: <?php echo $canViewAnalytics ? 'true' : 'false'; ?>,
        view_other_callers_detailed_analytics: <?php echo $canViewOtherAnalytics ? 'true' : 'false'; ?>,
        view_geographic_list_analytics: <?php echo $canViewGeoAnalytics ? 'true' : 'false'; ?>,
        view_leaderboard_summary: <?php echo $canViewLeaderboardSummary ? 'true' : 'false'; ?>,
        send_email: false,
        send_sms: false,
        view_email_history: false,
        manage_email_templates: <?php echo $canManageEmailTemplates ? 'true' : 'false'; ?>,
        manage_sequence_templates: <?php echo $canManageSequenceTemplates ? 'true' : 'false'; ?>,
        manage_caller_accounts: <?php echo $canManageCallerAccounts ? 'true' : 'false'; ?>,
        manage_settings: <?php echo $canManageCrmSettings ? 'true' : 'false'; ?>,
        view_commissions: <?php echo $canViewCommissions ? 'true' : 'false'; ?>,
        view_all_commissions: <?php echo $canViewAllCommissionSummaries ? 'true' : 'false'; ?>
    },
    default_view: <?php echo json_encode($defaultSalesView); ?>
};

window.Portal = {
    cfg: window.PORTAL_CFG,
    qs(sel, root){ return (root || document).querySelector(sel); },
    qsa(sel, root){ return Array.from((root || document).querySelectorAll(sel)); },
    escapeHtml(s){
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },
    async apiPost(url, payload){
        const isNode = String(url || '').includes('/v1/');
        const actorPayload = {
            actor_email: this.cfg?.user?.email || '',
            actor_name: this.cfg?.user?.name || '',
            actor_role: this.cfg?.user?.role || ''
        };
        const init = isNode
            ? {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, actorPayload, payload || {}))
            }
            : (() => {
                const fd = new FormData();
                Object.entries(payload || {}).forEach(([k, v]) => fd.append(k, v));
                return { method: 'POST', body: fd };
            })();
        const res = await fetch(url, init);
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch (err) {
            throw new Error(`Server returned invalid JSON (${res.status}). ${String(text || '').slice(0, 240)}`);
        }
    },
    openModal(id){ const el = document.getElementById(id); if (el) el.style.display = 'flex'; },
    closeModal(id){ const el = document.getElementById(id); if (el) el.style.display = 'none'; },
    registerPlugin(plugin){
        const navHost = document.getElementById('portalPluginNav');
        if (!navHost || !plugin || !plugin.id) return;
        const btn = document.createElement('button');
        btn.className = 'nav-btn';
        btn.id = `nav-${plugin.id}`;
        btn.innerHTML = `<i class="${plugin.iconClass || 'fas fa-puzzle-piece'}"></i> ${plugin.title || plugin.id}`;
        btn.onclick = () => this.switchView(plugin.id, btn);
        navHost.appendChild(btn);
    },
    async switchView(id, btn){
        this.qsa('.nav-btn').forEach(el => el.classList.remove('active'));
        if (btn) btn.classList.add('active');
        document.querySelectorAll('[id^="view-"]').forEach(el => { el.style.display = 'none'; });

        const target = document.getElementById('view-' + id);
        if (target) target.style.display = 'block';

        if (id === 'sample-reports' && window.SampleReports && SampleReports.onShow) await SampleReports.onShow();
        if (id === 'tutorials' && window.Tutorials) await Tutorials.onShowTutorials();
        if (id === 'student-progress' && window.Tutorials) await Tutorials.onShowStudentProgress();
        if (id === 'users' && window.Users) await Users.onShowUsers();
        if (id === 'referral-partners' && window.ReferralPartnersTab && ReferralPartnersTab.onShow) await ReferralPartnersTab.onShow();
        if (id === 'referral-rewards' && window.ReferralRewardsTab && ReferralRewardsTab.onShow) await ReferralRewardsTab.onShow();
        if (id === 'leads' && window.Leads && Leads.onShow) await Leads.onShow();
        if (id === 'home' && window.DashboardTab && DashboardTab.onShow) await DashboardTab.onShow();
        if (id === 'pipeline' && window.PipelineTab && PipelineTab.onShow) await PipelineTab.onShow();
        if (id === 'sequences' && window.SequencesTab && SequencesTab.onShow) await SequencesTab.onShow();
        if (id === 'analytics' && window.AnalyticsTab && AnalyticsTab.onShow) await AnalyticsTab.onShow();
    },
    init(){
        if (window.Tutorials && Tutorials.init) Tutorials.init();
        if (window.Users && Users.init) Users.init();
        if (window.ReferralPartnersTab && ReferralPartnersTab.init) ReferralPartnersTab.init();
        if (window.ReferralRewardsTab && ReferralRewardsTab.init) ReferralRewardsTab.init();
        if (window.DashboardTab && DashboardTab.init) DashboardTab.init();
        if (window.PipelineTab && PipelineTab.init) PipelineTab.init();
        if (window.SequencesTab && SequencesTab.init) SequencesTab.init();
        if (window.AnalyticsTab && AnalyticsTab.init) AnalyticsTab.init();
        const candidates = ['home', 'pipeline', 'sequences', 'analytics', 'sample-reports', 'leads', 'lead-lists', 'tutorials', 'users', 'referral-partners', 'referral-rewards'];
        for (const id of candidates) {
            const viewEl = document.getElementById('view-' + id);
            if (!viewEl) continue;
            const btn = document.getElementById('nav-' + id) ||
                document.querySelector(`[onclick*="switchView('${id}'"]`);
            this.switchView(id, btn);
            break;
        }
    }
};

function switchView(id, btn){ return Portal.switchView(id, btn); }
function closeModal(id){ return Portal.closeModal(id); }
function initMapsCallback(){}

function firstMeasureUrl(path){
    const base = String(Portal.cfg?.endpoints?.firstmeasure || '').replace(/\/+$/, '');
    const suffix = String(path || '').replace(/^\/+/, '');
    return `${base}/${suffix}`;
}

function normalizeProjectManifest(manifest){
    const m = (manifest && typeof manifest === 'object') ? { ...manifest } : {};
    const asRecord = (value) => (value && typeof value === 'object') ? value : {};
    const timestamps = asRecord(m.timestamps);
    const ownerRef = asRecord(m.owner_ref);
    return {
        ...m,
        owner_email: m.owner_email || ownerRef.email || '',
        created_at: m.created_at || timestamps.created_at || ''
    };
}

async function fetchProjectModalData(id){
    const res = await fetch(firstMeasureUrl(`projects/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });
    const payload = await res.json().catch(() => ({}));
    const project = payload && payload.project ? payload.project : null;
    if (!project) return { success: false, error: payload.error || payload.message || 'Project not found' };

    const files = Array.isArray(project.files) ? project.files : [];
    const images = files
        .map((file) => String(file && file.name ? file.name : '').trim())
        .filter((name) => ['png', 'jpg', 'jpeg'].includes((name.split('.').pop() || '').toLowerCase()))
        .map((name) => ({
            name,
            url: firstMeasureUrl(`projects/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`)
        }));

    return {
        success: true,
        manifest: normalizeProjectManifest(project.manifest || {}),
        images,
        pdf_url: firstMeasureUrl(`projects/${encodeURIComponent(id)}/pdf?slot=main`)
    };
}

async function openProjectModal(id){
    const data = await fetchProjectModalData(id).catch(() => ({}));

    if (!data.success) {
        alert(data.error || 'Could not load details');
        return;
    }

    const m = data.manifest || {};
    document.getElementById('pmAddress').innerText = m.address || '-';
    document.getElementById('pmStatus').innerText = m.status || '-';
    document.getElementById('pmOwner').innerText = (m.issuer ? m.issuer.name : '') || m.owner_email || '-';
    document.getElementById('pmDate').innerText = m.created_at || '-';

    const pdfBtn = document.getElementById('pmPdfBtn');
    if (data.pdf_url) {
        pdfBtn.href = data.pdf_url;
        pdfBtn.style.display = 'flex';
    } else {
        pdfBtn.style.display = 'none';
    }

    document.getElementById('pmEditBtn').onclick = () => directOpen(id);

    const gal = document.getElementById('pmGallery');
    gal.innerHTML = '';
    (data.images || []).forEach(img => {
        const d = document.createElement('div');
        d.className = 'gal-item';
        d.innerHTML = `<img src="${img.url}" title="${Portal.escapeHtml(img.name || '')}" onclick="window.open(this.src)">`;
        gal.appendChild(d);
    });

    Portal.openModal('projModal');
}

function directOpen(id){
    localStorage.setItem('autoLoadProject', id);
    window.location.href = 'editor.php';
}

window.openProjectModal = openProjectModal;
window.directOpen = directOpen;

document.addEventListener('DOMContentLoaded', () => Portal.init());
</script>

<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="editor_scripts/pdf.js?v=<?=$ver?>"></script>
<script src="editor_scripts/pdf_standalone.js?v=<?=$ver?>"></script>
<script src="portal_scripts/tutorials.js?v=<?=$ver?>"></script>
<script src="portal_scripts/users.js?v=<?=$ver?>"></script>
<script src="portal_scripts/referral_partners.js?v=<?=$ver?>"></script>
<script src="portal_scripts/referral_rewards.js?v=<?=$ver?>"></script>
<script src="portal_scripts/customers.js?v=<?=$ver?>"></script>
<script src="portal_scripts/lead_viewer.js?v=<?=$ver?>"></script>
<script src="portal_scripts/lead_workspace.js?v=<?=$ver?>"></script>
<script src="portal_scripts/script_viewer.js?v=<?=$ver?>"></script>
<script src="portal_scripts/leads.js?v=<?=$ver?>"></script>
<script src="portal_scripts/leads_workspace_autosave_patch.js?v=<?=$ver?>"></script>
<script src="portal_scripts/orum_import.js?v=<?=$ver?>"></script>
<script src="portal_scripts/lead_lists.js?v=<?=$ver?>"></script>
<script src="portal_scripts/territory_builder.js?v=<?=$ver?>"></script>
<script src="portal_scripts/sample_reports.js?v=<?=$ver?>"></script>
<script src="portal_scripts/dashboard.js?v=<?=$ver?>"></script>
<script src="portal_scripts/pipeline.js?v=<?=$ver?>"></script>
<script src="portal_scripts/sequences.js?v=<?=$ver?>"></script>
<script src="portal_scripts/analytics.js?v=<?=$ver?>"></script>
<?php if ($canDataAgent): ?>
<script src="portal_scripts/data_agent.js?v=<?=$ver?>"></script>
<?php endif; ?>
</body>
</html>
