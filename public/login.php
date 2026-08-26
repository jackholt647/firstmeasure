<?php
require_once __DIR__ . '/auth.php';

// Hash helper — visit login.php?hash=YourPassword to generate a hash, then delete from history
if (isset($_GET['hash'])) {
    header('Content-Type: text/plain');
    $pw = $_GET['hash'];
    echo "Password: $pw\n";
    echo "Hash:     " . password_hash($pw, PASSWORD_DEFAULT) . "\n\n";
    echo "Put this in auth_users.json:\n";
    echo json_encode([['username' => 'admin', 'password_hash' => password_hash($pw, PASSWORD_DEFAULT)]], JSON_PRETTY_PRINT) . "\n";
    exit;
}

// Handle logout
if (isset($_GET['logout'])) {
    auth_logout();
    header('Location: login.php');
    exit;
}

// Already logged in? Redirect
if (auth_is_logged_in()) {
    header('Location: ' . ($_GET['return'] ?? 'browse.php'));
    exit;
}

$error = '';

// Handle login POST
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    // Rate limit: max 5 attempts per 5 minutes
    if (!isset($_SESSION['login_attempts'])) $_SESSION['login_attempts'] = ['count' => 0, 'first' => time()];
    if (time() - $_SESSION['login_attempts']['first'] > 300) {
        $_SESSION['login_attempts'] = ['count' => 0, 'first' => time()];
    }
    $_SESSION['login_attempts']['count']++;

    if ($_SESSION['login_attempts']['count'] > 5) {
        $error = 'Too many attempts. Try again in a few minutes.';
    } elseif ($username === '' || $password === '') {
        $error = 'Please enter username and password.';
    } elseif (!file_exists(AUTH_USERS_FILE)) {
        $error = 'No users configured. Visit login.php?hash=YourPassword to set up.';
    } elseif (auth_login($username, $password)) {
        $_SESSION['login_attempts'] = ['count' => 0, 'first' => time()];
        $return = $_POST['return'] ?? $_GET['return'] ?? 'browse.php';
        header('Location: ' . $return);
        exit;
    } else {
        $error = 'Invalid username or password.';
    }
}

$return = htmlspecialchars($_GET['return'] ?? 'browse.php');
$hasUsers = file_exists(AUTH_USERS_FILE) && count(auth_load_users()) > 0;
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — IDE</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
    --bg:#0a0e14;--bg2:#0f1419;--bg3:#151b24;--bg4:#1a2130;
    --border:#1e2a3a;--border2:#263347;
    --text:#d4dce8;--text2:#8b9bb4;--text3:#5c6f85;
    --accent:#38bdf8;--accent2:#0ea5e9;--accent3:#0284c7;
    --red:#f87171;--green:#34d399;
    --font:'DM Sans',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:var(--font);display:flex;align-items:center;justify-content:center}
.bg-grid{position:fixed;inset:0;background-image:radial-gradient(circle at 1px 1px,var(--border) 1px,transparent 0);background-size:40px 40px;opacity:.3;pointer-events:none}
.login-card{position:relative;z-index:1;width:400px;background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:40px;box-shadow:0 16px 64px rgba(0,0,0,.5)}
.logo{text-align:center;margin-bottom:32px}
.logo h1{font-size:24px;font-weight:700;color:var(--accent);letter-spacing:-0.5px}
.logo p{font-size:13px;color:var(--text3);margin-top:4px}
.field{margin-bottom:20px}
.field label{display:block;font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;letter-spacing:.3px}
.field input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:14px var(--font);outline:none;transition:border .2s}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(56,189,248,.1)}
.field input::placeholder{color:var(--text3)}
.btn-login{width:100%;padding:11px;background:var(--accent3);border:none;border-radius:8px;color:#fff;font:14px/1 var(--font);font-weight:600;cursor:pointer;transition:background .15s;letter-spacing:.3px}
.btn-login:hover{background:var(--accent2)}
.btn-login:active{transform:scale(.99)}
.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.25);color:var(--red);padding:10px 14px;border-radius:8px;font-size:12px;margin-bottom:20px;line-height:1.4}
.setup-notice{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.2);color:var(--accent);padding:12px 14px;border-radius:8px;font-size:12px;margin-bottom:20px;line-height:1.5}
.setup-notice code{font-family:var(--mono);background:var(--bg);padding:2px 6px;border-radius:4px;font-size:11px}
.footer{text-align:center;margin-top:24px;font-size:11px;color:var(--text3)}
.lockicon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;background:rgba(56,189,248,.1);border-radius:12px;margin:0 auto 16px}
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="login-card">
    <div class="logo">
        <div class="lockicon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
        </div>
        <h1>IDE Login</h1>
        <p>Sign in to access the file manager &amp; editor</p>
    </div>

    <?php if (!$hasUsers): ?>
    <div class="setup-notice">
        <strong>First-time setup:</strong> No users configured yet.<br><br>
        1. Visit <code>login.php?hash=YourPassword</code> to generate a hash<br>
        2. Create <code>auth_users.json</code> in the IDE root with the output<br>
        3. Refresh this page and log in
    </div>
    <?php endif; ?>

    <?php if ($error): ?>
    <div class="error"><?= htmlspecialchars($error) ?></div>
    <?php endif; ?>

    <form method="POST">
        <input type="hidden" name="return" value="<?= $return ?>">
        <div class="field">
            <label>Username</label>
            <input type="text" name="username" placeholder="Enter username" autocomplete="username" autofocus required>
        </div>
        <div class="field">
            <label>Password</label>
            <input type="password" name="password" placeholder="Enter password" autocomplete="current-password" required>
        </div>
        <button type="submit" class="btn-login">Sign In</button>
    </form>

    <div class="footer">Protected by session authentication</div>
</div>
</body>
</html>