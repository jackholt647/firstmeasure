<?php
require_once dirname(__DIR__) . '/_storage.php';

function callScriptFilePath() {
    return storageExistingPath('data/call_scripts.json', __DIR__ . '/call_scripts.json', true);
}

function callScriptActorEmail() {
    return strtolower(trim((string)($_SESSION['user_email'] ?? '')));
}

function callScriptActorData() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $email = callScriptActorEmail();
    if ($email === '' || !function_exists('readUserDataByEmail')) {
        $cached = null;
        return $cached;
    }
    $cached = readUserDataByEmail($email);
    return $cached;
}

function callScriptHasAccess() {
    $u = callScriptActorData();
    if (!is_array($u)) return false;
    $acct = strtolower(trim((string)($u['account_type'] ?? '')));
    if ($acct === 'customer') return false;
    return true;
}

function callScriptCanManage() {
    $u = callScriptActorData();
    if (!is_array($u)) return false;
    $perms = is_array($u['permissions'] ?? null) ? $u['permissions'] : [];
    if (!empty($perms['manage_users']) || !empty($perms['manage_sales_users']) || !empty($perms['create_users'])) {
        return true;
    }
    $role = strtolower(trim((string)($u['role'] ?? '')));
    return in_array($role, ['admin', 'system_admin', 'lead', 'sales_manager'], true);
}

function callScriptRequireAccess() {
    if (!callScriptHasAccess()) {
        die(json_encode(['success' => false, 'error' => 'Unauthorized']));
    }
}

function callScriptRequireManage() {
    if (!callScriptCanManage()) {
        die(json_encode(['success' => false, 'error' => 'Only managers can edit call scripts']));
    }
}

function callScriptLoadAll() {
    $path = callScriptFilePath();
    if (!file_exists($path)) return [];
    $raw = @file_get_contents($path);
    $data = json_decode((string)$raw, true);
    if (!is_array($data)) return [];
    $rows = [];
    foreach ($data as $row) {
        if (!is_array($row) || empty($row['id'])) continue;
        $rows[] = [
            'id' => (string)$row['id'],
            'title' => (string)($row['title'] ?? ''),
            'description' => (string)($row['description'] ?? ''),
            'body' => (string)($row['body'] ?? ''),
            'created_at' => (int)($row['created_at'] ?? 0),
            'updated_at' => (int)($row['updated_at'] ?? 0),
            'created_by_email' => (string)($row['created_by_email'] ?? ''),
            'updated_by_email' => (string)($row['updated_by_email'] ?? ''),
            'usage_count' => (int)($row['usage_count'] ?? 0),
            'last_used_at' => (int)($row['last_used_at'] ?? 0),
        ];
    }
    usort($rows, function($a, $b) {
        $usageCmp = ((int)$b['usage_count']) <=> ((int)$a['usage_count']);
        if ($usageCmp !== 0) return $usageCmp;
        $updatedCmp = ((int)$b['updated_at']) <=> ((int)$a['updated_at']);
        if ($updatedCmp !== 0) return $updatedCmp;
        return strcmp((string)$a['title'], (string)$b['title']);
    });
    return $rows;
}

function callScriptSaveAll($rows) {
    $path = callScriptFilePath();
    $fp = fopen($path, 'c+');
    if (!$fp) return false;
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return false;
    }
    ftruncate($fp, 0);
    rewind($fp);
    $ok = fwrite($fp, json_encode(array_values($rows), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false;
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $ok;
}

function callScriptId() {
    return 'script_' . bin2hex(random_bytes(8));
}

function callScriptFindIndex($rows, $id) {
    foreach ($rows as $idx => $row) {
        if ((string)($row['id'] ?? '') === (string)$id) return $idx;
    }
    return -1;
}

function handleCallScriptActions($action) {
    $actions = [
        'call_script_list',
        'call_script_get',
        'call_script_save',
        'call_script_delete',
        'call_script_touch',
    ];
    if (!in_array($action, $actions, true)) return false;

    callScriptRequireAccess();
    $rows = callScriptLoadAll();
    $actor = callScriptActorEmail();
    $now = time();

    if ($action === 'call_script_list') {
        echo json_encode([
            'success' => true,
            'scripts' => $rows,
            'can_manage' => callScriptCanManage()
        ]);
        return true;
    }

    if ($action === 'call_script_get') {
        $id = trim((string)($_POST['id'] ?? ''));
        $idx = callScriptFindIndex($rows, $id);
        if ($idx < 0) die(json_encode(['success' => false, 'error' => 'Script not found']));
        echo json_encode(['success' => true, 'script' => $rows[$idx], 'can_manage' => callScriptCanManage()]);
        return true;
    }

    if ($action === 'call_script_save') {
        callScriptRequireManage();
        $id = trim((string)($_POST['id'] ?? ''));
        $title = trim((string)($_POST['title'] ?? ''));
        $description = trim((string)($_POST['description'] ?? ''));
        $body = (string)($_POST['body'] ?? '');
        if ($title === '') die(json_encode(['success' => false, 'error' => 'Title is required']));

        $idx = $id !== '' ? callScriptFindIndex($rows, $id) : -1;
        if ($idx < 0) {
            $rows[] = [
                'id' => $id !== '' ? $id : callScriptId(),
                'title' => $title,
                'description' => $description,
                'body' => $body,
                'created_at' => $now,
                'updated_at' => $now,
                'created_by_email' => $actor,
                'updated_by_email' => $actor,
                'usage_count' => 0,
                'last_used_at' => 0,
            ];
        } else {
            $rows[$idx]['title'] = $title;
            $rows[$idx]['description'] = $description;
            $rows[$idx]['body'] = $body;
            $rows[$idx]['updated_at'] = $now;
            $rows[$idx]['updated_by_email'] = $actor;
        }
        if (!callScriptSaveAll($rows)) die(json_encode(['success' => false, 'error' => 'Could not save call scripts']));
        echo json_encode(['success' => true, 'scripts' => callScriptLoadAll()]);
        return true;
    }

    if ($action === 'call_script_delete') {
        callScriptRequireManage();
        $id = trim((string)($_POST['id'] ?? ''));
        $idx = callScriptFindIndex($rows, $id);
        if ($idx < 0) die(json_encode(['success' => false, 'error' => 'Script not found']));
        array_splice($rows, $idx, 1);
        if (!callScriptSaveAll($rows)) die(json_encode(['success' => false, 'error' => 'Could not delete call script']));
        echo json_encode(['success' => true, 'scripts' => callScriptLoadAll()]);
        return true;
    }

    if ($action === 'call_script_touch') {
        $id = trim((string)($_POST['id'] ?? ''));
        $idx = callScriptFindIndex($rows, $id);
        if ($idx < 0) die(json_encode(['success' => false, 'error' => 'Script not found']));
        $rows[$idx]['usage_count'] = (int)($rows[$idx]['usage_count'] ?? 0) + 1;
        $rows[$idx]['last_used_at'] = $now;
        callScriptSaveAll($rows);
        echo json_encode(['success' => true]);
        return true;
    }

    return false;
}
