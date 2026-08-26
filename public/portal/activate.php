<?php
// activate.php — FirstMate user activation
// Uses existing "forgot_password" -> "verify_otp" -> "set_new_password" flow
// Includes auto-login and checks for existing verification.

$emailParam = isset($_GET['email']) ? trim($_GET['email']) : '';
$redirectParam = isset($_GET['redirect']) ? trim($_GET['redirect']) : './';
$startParam = isset($_GET['start']) ? trim($_GET['start']) : '';

// --- 1. CHECK IF ALREADY VERIFIED ---
if ($emailParam) {
    // Basic file look-up to see if user is verified
    $safeFile = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower($emailParam)) . '.json';
    $userPath = __DIR__ . '/users/' . $safeFile;
    if (file_exists($userPath)) {
        $uCheck = json_decode(file_get_contents($userPath), true);
        if (is_array($uCheck) && !empty($uCheck['is_verified'])) {
            // Already active? Go to login.
            $loginUrl = 'login.php?email=' . urlencode($emailParam);
            if ($redirectParam && $redirectParam !== './') {
                $loginUrl .= '&redirect=' . urlencode($redirectParam);
            }
            header("Location: " . $loginUrl);
            exit;
        }
    }
}

function esc($s) { return htmlspecialchars($s ?? '', ENT_QUOTES, 'UTF-8'); }
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FirstMate - Activate Account</title>
    <!-- 2. FONTS RESTORED -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <style>
        body {
            font-family: 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            display: flex; align-items: center; justify-content: center;
            height: 100vh; margin: 0;
        }
        .container {
            background: white; width: 400px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            overflow: hidden; position: relative;
            max-width: 90vw;
        }
        .header {
            background: #d93025; color: white; padding: 25px; text-align: center;
        }

        /* --- Smooth auth panel height + form crossfade --- */
        .form-area {
            position: relative;
            overflow: hidden;
            transition: height 280ms cubic-bezier(.2,.9,.2,1);
            will-change: height;
        }
        .auth-form {
            position: absolute;
            left: 0; right: 0;
            top: 0;
            opacity: 0;
            transform: translateY(8px);
            pointer-events: none;
            padding: 30px;
            transition:
                opacity 180ms ease,
                transform 220ms cubic-bezier(.2,.9,.2,1);
        }
        .auth-form.active {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        @media (prefers-reduced-motion: reduce) {
            .form-area, .auth-form { transition: none !important; }
        }

        .form-group { margin-bottom: 15px; }
        .form-group label {
            display: block; font-size: 12px; font-weight: 700; color: #5f6368;
            margin-bottom: 5px; text-transform: uppercase;
        }
        input {
            width: 100%; padding: 10px; border: 2px solid #eee; border-radius: 6px;
            box-sizing: border-box; font-size: 14px;
        }
        input:focus { border-color: #d93025; outline: none; }

        .btn {
            width: 100%; padding: 12px; background: #d93025; color: white; border: none;
            border-radius: 6px; font-weight: 700; cursor: pointer; margin-top: 10px;
        }
        .btn:hover { background: #b0261e; }

        .error { color: #d93025; font-size: 13px; text-align: center; margin-top: 10px; display: none; }
        .success { color: #34a853; font-size: 13px; text-align: center; margin-top: 10px; display: none; }

        .otp-info { text-align: center; font-size: 13px; color: #555; margin-bottom: 20px; line-height: 1.5; }
        .link-btn {
            background:none; border:none; color:#d93025; cursor:pointer;
            font-size:12px; text-decoration:underline; padding:0;
        }
        .center-links { text-align:center; margin-top:15px; font-size:12px; }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <img src="/images/logo_white.png" alt="FirstMate" height="70" style="padding:0; margin:0;">
    </div>

    <div class="form-area">
        <!-- STEP 1: EMAIL + SEND OTP -->
        <form class="auth-form" id="startForm">
            <div style="margin-bottom:15px; text-align:center; font-size:13px; color:#666;">
                Activate your account by verifying your email, then set your password.
            </div>

            <div class="form-group">
                <label>Email</label>
                <input type="email" name="email" id="emailInput" required value="<?php echo esc($emailParam); ?>">
            </div>

            <button type="submit" class="btn">Send Verification Code</button>

            <div id="startError" class="error"></div>
            <div id="startSuccess" class="success"></div>

            <div class="center-links">
                <button type="button" class="link-btn" onclick="goToLogin()">Back to Login</button>
            </div>
        </form>

        <!-- STEP 2: OTP -->
        <form class="auth-form" id="otpForm">
            <div class="otp-info">
                <span id="otpMsg">Enter the code sent to your email:</span><br>
                <strong id="otpEmailDisp"></strong>
            </div>
            <div class="form-group">
                <label>6-Digit Code</label>
                <input type="text" name="otp" placeholder="123456" pattern="[0-9]*" maxlength="6"
                       style="text-align:center; letter-spacing: 5px; font-size: 18px;" required>
            </div>
            <button type="submit" class="btn">Verify Code</button>
            <div id="otpError" class="error"></div>

            <div class="center-links">
                <button type="button" class="link-btn" onclick="showStart()">Start Over</button>
            </div>
        </form>

        <!-- STEP 3: SET PASSWORD -->
        <form class="auth-form" id="setPassForm">
            <div style="margin-bottom:15px; text-align:center; font-size:13px; color:#666;">
                Email verified. Set your password to finish activation.
            </div>
            <div class="form-group">
                <label>New Password</label>
                <input type="password" name="new_password" required minlength="6">
            </div>
            <div class="form-group">
                <label>Confirm Password</label>
                <input type="password" name="confirm_password" required minlength="6">
            </div>

            <button type="submit" class="btn">Activate Account</button>
            <div id="setPassError" class="error"></div>
            <div id="setPassSuccess" class="success">Activated! Signing you in...</div>
        </form>
    </div>
</div>

<script>
    const urlParams = new URLSearchParams(window.location.search);
    const redirectTarget = urlParams.get('redirect') || <?php echo json_encode($redirectParam ?: './'); ?>;
    const startParam = urlParams.get('start') || <?php echo json_encode($startParam); ?>;

    const formArea = document.querySelector('.form-area');
    const emailInput = document.getElementById('emailInput');

    // If email came from invite link, lock it
    const emailFromLink = (urlParams.get('email') || '').trim();
    if (emailFromLink) {
        emailInput.value = emailFromLink;
        emailInput.readOnly = true;
        emailInput.style.background = '#f8f9fa';
    }

    function platformApiBaseUrl(){
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.protocol}//${location.hostname}:3111/v1/platform`;
        }
        return `${location.origin}/v1/platform`;
    }

    async function authLegacyRequest(formData){
        const payload = {};
        formData.forEach((value, key) => { payload[key] = value; });
        const res = await fetch(`${platformApiBaseUrl()}/auth/legacy-action`, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        return await res.json();
    }

    function setFormAreaHeightTo(el) {
        const prevPos = el.style.position;
        const prevVis = el.style.visibility;
        const prevDisp = el.style.display;

        el.style.position = 'relative';
        el.style.visibility = 'hidden';
        el.style.display = 'block';

        const h = el.offsetHeight;

        el.style.position = prevPos;
        el.style.visibility = prevVis;
        el.style.display = prevDisp;

        formArea.style.height = h + 'px';
    }

    function activateForm(formEl) {
        document.querySelectorAll('form.auth-form').forEach(f => f.classList.remove('active'));
        formEl.classList.add('active');
        requestAnimationFrame(() => setFormAreaHeightTo(formEl));
    }

    function hideAllMessages() {
        document.querySelectorAll('.error, .success').forEach(e => e.style.display = 'none');
    }

    function showStart() {
        hideAllMessages();
        activateForm(document.getElementById('startForm'));
    }

    function showOtp(email, message) {
        hideAllMessages();
        document.getElementById('otpEmailDisp').innerText = email;
        if (message) document.getElementById('otpMsg').innerText = message;
        activateForm(document.getElementById('otpForm'));
    }

    function showSetPass() {
        hideAllMessages();
        activateForm(document.getElementById('setPassForm'));
    }

    function goToLogin() {
        const r = encodeURIComponent(redirectTarget || './');
        window.location.href = 'login.php?redirect=' + r;
    }

    window.addEventListener('resize', () => {
        const active = document.querySelector('form.auth-form.active');
        if (active) setFormAreaHeightTo(active);
    });

    window.addEventListener('load', () => {
        // Default to start form, but allow deep-link to OTP
        if (startParam && startParam.toLowerCase() === 'otp') {
            const e = (emailInput.value || '').trim();
            if (e) showOtp(e, "Enter the code sent to your email:");
            else showStart();
        } else {
            showStart();
        }
    });

    // STEP 1: Send OTP (using existing 'forgot_password' action)
    document.getElementById('startForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAllMessages();

        const err = document.getElementById('startError');
        const succ = document.getElementById('startSuccess');

        const email = (emailInput.value || '').trim();
        if (!email) {
            err.innerText = 'Please enter your email.';
            err.style.display = 'block';
            return;
        }

        const fd = new FormData();
        fd.append('action', 'forgot_password'); 
        fd.append('email', email);

        try {
            const data = await authLegacyRequest(fd);

            if (data && data.require_otp) {
                showOtp(data.email || email, data.message || "Enter the code sent to your email:");
            } else {
                err.innerText = (data && (data.error || data.message)) ? (data.error || data.message) : 'Failed to send code.';
                err.style.display = 'block';
            }
        } catch (ex) {
            err.innerText = 'Connection Error';
            err.style.display = 'block';
        }
    });

    // STEP 2: Verify OTP (using existing 'verify_otp' action)
    document.getElementById('otpForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAllMessages();

        const err = document.getElementById('otpError');
        const otpInput = document.querySelector('#otpForm input[name="otp"]');
        const otp = (otpInput.value || '').trim();
        const email = (emailInput.value || '').trim();

        const fd = new FormData();
        fd.append('action', 'verify_otp');
        fd.append('email', email);
        fd.append('otp', otp);

        try {
            const data = await authLegacyRequest(fd);

            // Existing backend returns require_new_password:true for "forgot_password" flows
            if (data && (data.success || data.require_new_password)) {
                showSetPass();
            } else {
                err.innerText = (data && (data.error || data.message)) ? (data.error || data.message) : 'Invalid code';
                err.style.display = 'block';
            }
        } catch (ex) {
            err.innerText = 'Connection Error';
            err.style.display = 'block';
        }
    });

    // STEP 3: Set password + 3. AUTO LOGIN
    document.getElementById('setPassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAllMessages();

        const err = document.getElementById('setPassError');
        const succ = document.getElementById('setPassSuccess');

        const email = (emailInput.value || '').trim();
        const pw = (document.querySelector('#setPassForm input[name="new_password"]').value || '');
        const pw2 = (document.querySelector('#setPassForm input[name="confirm_password"]').value || '');

        if (pw.length < 6) {
            err.innerText = 'Password must be at least 6 characters.';
            err.style.display = 'block';
            return;
        }
        if (pw !== pw2) {
            err.innerText = 'Passwords do not match.';
            err.style.display = 'block';
            return;
        }

        const fd = new FormData();
        fd.append('action', 'set_new_password'); 
        fd.append('email', email);
        fd.append('new_password', pw);

        try {
            // A. Set Password
            const data = await authLegacyRequest(fd);

            if (data && data.success) {
                succ.style.display = 'block';
                
                // B. Auto Login (using the credentials just set)
                const loginFd = new FormData();
                loginFd.append('action', 'login');
                loginFd.append('email', email);
                loginFd.append('password', pw);

                const loginData = await authLegacyRequest(loginFd);

                if (loginData && (loginData.success || loginData.first_login)) {
                    // Success! Redirect to app
                    setTimeout(() => {
                        window.location.href = redirectTarget || './';
                    }, 800);
                } else {
                    // Fallback if login fails (rare): redirect to login page
                    setTimeout(() => {
                        const r = encodeURIComponent(redirectTarget || './');
                        window.location.href = 'login.php?email=' + encodeURIComponent(email) + '&redirect=' + r;
                    }, 1500);
                }

            } else {
                err.innerText = (data && (data.error || data.message)) ? (data.error || data.message) : 'Failed';
                err.style.display = 'block';
            }
        } catch (ex) {
            err.innerText = 'Connection Error';
            err.style.display = 'block';
        }
    });
</script>

</body>
</html>
