<?php
/**
 * add_user.php — User management.
 * Root users: see all users, edit permissions, add users with any access level.
 * Non-root users: add new users who inherit the same permissions as themselves.
 */
require_once __DIR__ . '/auth.php';
auth_require_login();

$message = '';
$error   = '';
$isRoot  = auth_has_root();
$myAccess = auth_get_access();

// ── Handle POST actions ──────────────────────────────────────────────────────

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $formAction = $_POST['form_action'] ?? 'add';

    // ── ADD USER ─────────────────────────────────────────────────────────────
    if ($formAction === 'add') {
        $username = trim($_POST['username'] ?? '');
        $password = $_POST['password'] ?? '';
        $confirm  = $_POST['confirm'] ?? '';

        // Determine access for new user
        if ($isRoot) {
            $accessType = $_POST['access_type'] ?? 'root';
            if ($accessType === 'root') {
                $newAccess = 'root';
            } else {
                $dirs = array_filter(array_map('trim', explode(',', $_POST['access_dirs'] ?? '')));
                $dirs = array_values(array_unique($dirs));
                $newAccess = !empty($dirs) ? $dirs : 'root';
            }
        } else {
            // Non-root users can only create users with their own permissions
            $newAccess = $myAccess;
        }

        if ($username === '') {
            $error = 'Username is required.';
        } elseif (strlen($password) < 6) {
            $error = 'Password must be at least 6 characters.';
        } elseif ($password !== $confirm) {
            $error = 'Passwords do not match.';
        } else {
            $users = auth_load_users();
            foreach ($users as $u) {
                if (strtolower($u['username']) === strtolower($username)) {
                    $error = 'A user with that name already exists.';
                    break;
                }
            }
            if ($error === '') {
                $users[] = [
                    'username'      => $username,
                    'password_hash' => password_hash($password, PASSWORD_DEFAULT),
                    'access'        => $newAccess,
                ];
                if (file_put_contents(AUTH_USERS_FILE, json_encode($users, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))) {
                    $accessLabel = is_array($newAccess) ? implode(', ', $newAccess) : $newAccess;
                    $message = "User \"{$username}\" created with access: {$accessLabel}";
                    $username = '';
                } else {
                    $error = 'Failed to write to ' . AUTH_USERS_FILE . '. Check file permissions.';
                }
            }
        }
    }

    // ── UPDATE USER (root only) ──────────────────────────────────────────────
    if ($formAction === 'update' && $isRoot) {
        $targetUser = trim($_POST['target_user'] ?? '');
        $accessType = $_POST['access_type'] ?? 'root';
        if ($accessType === 'root') {
            $newAccess = 'root';
        } else {
            $dirs = array_filter(array_map('trim', explode(',', $_POST['access_dirs'] ?? '')));
            $dirs = array_values(array_unique($dirs));
            $newAccess = !empty($dirs) ? 'root' : 'root'; // fallback
            if (!empty($dirs)) $newAccess = $dirs;
        }

        $users = auth_load_users();
        $found = false;
        foreach ($users as &$u) {
            if (strtolower($u['username']) === strtolower($targetUser)) {
                $u['access'] = $newAccess;
                $found = true;
                break;
            }
        }
        unset($u);
        if (!$found) {
            $error = "User \"{$targetUser}\" not found.";
        } elseif (file_put_contents(AUTH_USERS_FILE, json_encode($users, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))) {
            $accessLabel = is_array($newAccess) ? implode(', ', $newAccess) : $newAccess;
            $message = "Updated \"{$targetUser}\" access to: {$accessLabel}";
        } else {
            $error = 'Failed to write user file.';
        }
    }

    // ── DELETE USER (root only) ──────────────────────────────────────────────
    if ($formAction === 'delete' && $isRoot) {
        $targetUser = trim($_POST['target_user'] ?? '');
        if (strtolower($targetUser) === strtolower(auth_get_user())) {
            $error = 'You cannot delete your own account.';
        } else {
            $users = auth_load_users();
            $filtered = array_values(array_filter($users, function ($u) use ($targetUser) {
                return strtolower($u['username']) !== strtolower($targetUser);
            }));
            if (count($filtered) === count($users)) {
                $error = "User \"{$targetUser}\" not found.";
            } elseif (file_put_contents(AUTH_USERS_FILE, json_encode($filtered, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))) {
                $message = "User \"{$targetUser}\" deleted.";
            } else {
                $error = 'Failed to write user file.';
            }
        }
    }

    // ── RESET PASSWORD (root only) ───────────────────────────────────────────
    if ($formAction === 'reset_password' && $isRoot) {
        $targetUser = trim($_POST['target_user'] ?? '');
        $newPass    = $_POST['new_password'] ?? '';
        if (strlen($newPass) < 6) {
            $error = 'Password must be at least 6 characters.';
        } else {
            $users = auth_load_users();
            $found = false;
            foreach ($users as &$u) {
                if (strtolower($u['username']) === strtolower($targetUser)) {
                    $u['password_hash'] = password_hash($newPass, PASSWORD_DEFAULT);
                    $found = true;
                    break;
                }
            }
            unset($u);
            if (!$found) {
                $error = "User \"{$targetUser}\" not found.";
            } elseif (file_put_contents(AUTH_USERS_FILE, json_encode($users, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))) {
                $message = "Password reset for \"{$targetUser}\".";
            } else {
                $error = 'Failed to write user file.';
            }
        }
    }
}

// Load users for the management table (root only)
$allUsers = $isRoot ? auth_load_users() : [];
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><?= $isRoot ? 'User Management' : 'Add User' ?></title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5; display: flex; justify-content: center; padding: 40px 16px; min-height: 100vh; }
    .wrap { width: 100%; max-width: <?= $isRoot ? '780px' : '400px' ?>; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1); padding: 32px; margin-bottom: 24px; }
    h1 { font-size: 1.3rem; margin-bottom: 4px; }
    h2 { font-size: 1.1rem; margin-bottom: 12px; }
    .sub { color: #666; font-size: .85rem; margin-bottom: 20px; }
    label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: 4px; margin-top: 14px; }
    input[type="text"], input[type="password"], select {
        width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: .95rem;
    }
    input:focus, select:focus { outline: none; border-color: #4a7cff; box-shadow: 0 0 0 2px rgba(74,124,255,.25); }
    button, .btn { padding: 10px 18px; background: #4a7cff; color: #fff; border: none; border-radius: 6px; font-size: .9rem; font-weight: 600; cursor: pointer; }
    button:hover, .btn:hover { background: #3a65d4; }
    .btn-sm { padding: 6px 12px; font-size: .8rem; }
    .btn-red { background: #dc3545; }
    .btn-red:hover { background: #b02a37; }
    .btn-green { background: #28a745; }
    .btn-green:hover { background: #1e7e34; }
    .btn-full { width: 100%; margin-top: 20px; }
    .msg { margin-bottom: 16px; padding: 10px 14px; border-radius: 6px; font-size: .9rem; }
    .msg.ok { background: #e6f9ee; color: #1a7f42; }
    .msg.err { background: #fdecea; color: #b71c1c; }
    .back { display: inline-block; margin-top: 8px; font-size: .85rem; color: #4a7cff; text-decoration: none; }
    .back:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: .88rem; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; font-size: .8rem; text-transform: uppercase; color: #555; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .78rem; font-weight: 600; }
    .tag-root { background: #e8f0fe; color: #1a73e8; }
    .tag-dir { background: #fef3e0; color: #e67700; margin: 1px 2px; }
    .tag-you { background: #e6f9ee; color: #1a7f42; margin-left: 6px; }
    .access-field { margin-top: 6px; }
    .help { font-size: .78rem; color: #888; margin-top: 4px; }
    .actions-cell { white-space: nowrap; }
    .actions-cell form { display: inline; }
    /* Modal */
    .modal-bg { display: none; position: fixed; top:0; left:0; width:100%; height:100%; background: rgba(0,0,0,.4); z-index: 100; justify-content: center; align-items: center; }
    .modal-bg.active { display: flex; }
    .modal { background: #fff; border-radius: 8px; padding: 28px; width: 90%; max-width: 440px; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
    .modal h3 { margin-bottom: 16px; font-size: 1.05rem; }
    .modal-actions { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
    .btn-ghost { background: transparent; color: #333; border: 1px solid #ccc; }
    .btn-ghost:hover { background: #f0f0f0; }
</style>
</head>
<body>
<div class="wrap">

    <?php if ($message): ?>
        <div class="msg ok"><?= htmlspecialchars($message) ?></div>
    <?php endif; ?>
    <?php if ($error): ?>
        <div class="msg err"><?= htmlspecialchars($error) ?></div>
    <?php endif; ?>

    <?php if ($isRoot): ?>
    <!-- ── EXISTING USERS TABLE (root only) ──────────────────────────────── -->
    <div class="card">
        <h2>Existing Users</h2>
        <table>
            <thead>
                <tr>
                    <th>Username</th>
                    <th>Access</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
            <?php foreach ($allUsers as $u): ?>
                <?php
                    $uname = $u['username'];
                    $uAccess = $u['access'] ?? 'root';
                    $isMe = strtolower($uname) === strtolower(auth_get_user());
                ?>
                <tr>
                    <td>
                        <?= htmlspecialchars($uname) ?>
                        <?php if ($isMe): ?><span class="tag tag-you">you</span><?php endif; ?>
                    </td>
                    <td>
                        <?php if ($uAccess === 'root'): ?>
                            <span class="tag tag-root">root</span>
                        <?php elseif (is_array($uAccess)): ?>
                            <?php foreach ($uAccess as $d): ?>
                                <span class="tag tag-dir"><?= htmlspecialchars($d) ?></span>
                            <?php endforeach; ?>
                        <?php endif; ?>
                    </td>
                    <td class="actions-cell">
                        <button class="btn btn-sm" onclick="openEditModal('<?= htmlspecialchars($uname, ENT_QUOTES) ?>', <?= htmlspecialchars(json_encode($uAccess), ENT_QUOTES) ?>)">Edit</button>
                        <button class="btn btn-sm btn-green" onclick="openResetModal('<?= htmlspecialchars($uname, ENT_QUOTES) ?>')">Reset PW</button>
                        <?php if (!$isMe): ?>
                        <form method="post" style="display:inline" onsubmit="return confirm('Delete <?= htmlspecialchars($uname, ENT_QUOTES) ?>?');">
                            <input type="hidden" name="form_action" value="delete">
                            <input type="hidden" name="target_user" value="<?= htmlspecialchars($uname) ?>">
                            <button class="btn btn-sm btn-red" type="submit">Delete</button>
                        </form>
                        <?php endif; ?>
                    </td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php endif; ?>

    <!-- ── ADD USER FORM ─────────────────────────────────────────────────── -->
    <div class="card">
        <h1>Add New User</h1>
        <div class="sub">
            Logged in as <strong><?= htmlspecialchars(auth_get_user()) ?></strong>
            <?php if (!$isRoot): ?>
                — new users will inherit your directory access
                (<?= is_array($myAccess) ? htmlspecialchars(implode(', ', $myAccess)) : 'root' ?>)
            <?php endif; ?>
        </div>

        <form method="post" autocomplete="off">
            <input type="hidden" name="form_action" value="add">

            <label for="username">Username</label>
            <input type="text" id="username" name="username" value="<?= htmlspecialchars($username ?? '') ?>" required autofocus>

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required minlength="6">

            <label for="confirm">Confirm Password</label>
            <input type="password" id="confirm" name="confirm" required minlength="6">

            <?php if ($isRoot): ?>
            <label for="access_type">Access Level</label>
            <select id="access_type" name="access_type" onchange="toggleDirsField(this.value)">
                <option value="root">Root (full access)</option>
                <option value="limited">Limited (specific directories)</option>
            </select>
            <div id="dirs_field" class="access-field" style="display:none;">
                <label for="access_dirs">Allowed Directories</label>
                <input type="text" id="access_dirs" name="access_dirs" placeholder="measure, portal, portal_dev">
                <div class="help">Comma-separated top-level directory names</div>
            </div>
            <?php endif; ?>

            <button type="submit" class="btn-full">Create User</button>
        </form>
        <a class="back" href="./">&larr; Back</a>
    </div>
</div>

<?php if ($isRoot): ?>
<!-- ── EDIT ACCESS MODAL ─────────────────────────────────────────────────── -->
<div class="modal-bg" id="editModal">
    <div class="modal">
        <h3>Edit Access — <span id="editUser"></span></h3>
        <form method="post">
            <input type="hidden" name="form_action" value="update">
            <input type="hidden" name="target_user" id="editTargetUser">
            <label>Access Level</label>
            <select id="editAccessType" name="access_type" onchange="toggleEditDirs(this.value)">
                <option value="root">Root (full access)</option>
                <option value="limited">Limited (specific directories)</option>
            </select>
            <div id="editDirsField" class="access-field" style="display:none;">
                <label>Allowed Directories</label>
                <input type="text" id="editAccessDirs" name="access_dirs" placeholder="measure, portal">
                <div class="help">Comma-separated top-level directory names</div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-ghost" onclick="closeModal('editModal')">Cancel</button>
                <button type="submit" class="btn">Save Changes</button>
            </div>
        </form>
    </div>
</div>

<!-- ── RESET PASSWORD MODAL ──────────────────────────────────────────────── -->
<div class="modal-bg" id="resetModal">
    <div class="modal">
        <h3>Reset Password — <span id="resetUser"></span></h3>
        <form method="post">
            <input type="hidden" name="form_action" value="reset_password">
            <input type="hidden" name="target_user" id="resetTargetUser">
            <label>New Password</label>
            <input type="password" name="new_password" required minlength="6">
            <div class="modal-actions">
                <button type="button" class="btn btn-ghost" onclick="closeModal('resetModal')">Cancel</button>
                <button type="submit" class="btn btn-green">Reset Password</button>
            </div>
        </form>
    </div>
</div>
<?php endif; ?>

<script>
function toggleDirsField(val) {
    document.getElementById('dirs_field').style.display = val === 'limited' ? 'block' : 'none';
}
<?php if ($isRoot): ?>
function openEditModal(username, access) {
    document.getElementById('editUser').textContent = username;
    document.getElementById('editTargetUser').value = username;
    if (access === 'root') {
        document.getElementById('editAccessType').value = 'root';
        document.getElementById('editDirsField').style.display = 'none';
        document.getElementById('editAccessDirs').value = '';
    } else {
        document.getElementById('editAccessType').value = 'limited';
        document.getElementById('editDirsField').style.display = 'block';
        document.getElementById('editAccessDirs').value = Array.isArray(access) ? access.join(', ') : '';
    }
    document.getElementById('editModal').classList.add('active');
}
function toggleEditDirs(val) {
    document.getElementById('editDirsField').style.display = val === 'limited' ? 'block' : 'none';
}
function openResetModal(username) {
    document.getElementById('resetUser').textContent = username;
    document.getElementById('resetTargetUser').value = username;
    document.getElementById('resetModal').classList.add('active');
}
function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}
// Close modal on background click
document.querySelectorAll('.modal-bg').forEach(el => {
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('active'); });
});
<?php endif; ?>
</script>
</body>
</html>