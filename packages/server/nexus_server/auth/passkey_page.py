"""Passkey authentication page router.

Serves a self-contained HTML page with WebAuthn (passkey) registration and login.
Handles WebAuthn flows via @simplewebauthn/browser library and communicates
with the server's passkey endpoints.
"""

import logging
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import HTMLResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Self-contained HTML page with WebAuthn functionality
PASSKEY_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nexus - Passkey Authentication</title>
    <script src="https://unpkg.com/@simplewebauthn/browser@9.0.1/dist/bundle/index.umd.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary: #1A73E8;
            --primary-hover: #1765CC;
            --success: #34A853;
            --error: #D93025;
            --text-primary: #202124;
            --text-secondary: #5F6368;
            --border: #DADCE0;
            --bg: #FFFFFF;
            --bg-subtle: #F8F9FA;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            width: 100%;
            max-width: 420px;
            background: var(--bg);
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        .logo {
            /* Matches the desktop app icon (Nexus.icns): dark-navy
               rounded square + BNB-yellow N. Kept in sync with the
               Tauri app's icon source in
               packages/desktop-v2/src-tauri/icons/source.svg so the
               login modal and the app's dock icon present a single
               coherent identity. */
            width: 72px;
            height: 72px;
            margin: 0 auto 16px;
            background: #0F1729;
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            font-weight: bold;
            color: #F0B90B;
        }

        .header h1 {
            font-size: 28px;
            color: var(--text-primary);
            margin-bottom: 8px;
            font-weight: 500;
        }

        .header p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            color: var(--text-primary);
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 8px;
        }

        input[type="text"] {
            width: 100%;
            padding: 12px 16px;
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 14px;
            color: var(--text-primary);
            font-family: inherit;
            transition: border-color 0.2s;
        }

        input[type="text"]:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.1);
        }

        input[type="text"]::placeholder {
            color: var(--text-secondary);
        }

        .button-group {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin: 24px 0;
        }

        button {
            padding: 12px 24px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            border: none;
            cursor: pointer;
            transition: all 0.2s;
            font-family: inherit;
        }

        .btn-primary {
            background: var(--primary);
            color: white;
            width: 100%;
        }

        .btn-primary:hover:not(:disabled) {
            background: var(--primary-hover);
            box-shadow: 0 4px 12px rgba(26, 115, 232, 0.3);
        }

        .btn-secondary {
            background: var(--bg-subtle);
            color: var(--text-primary);
            border: 1px solid var(--border);
            width: 100%;
        }

        .btn-secondary:hover:not(:disabled) {
            background: #F0F4F9;
        }

        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .mode-toggle {
            display: flex;
            gap: 8px;
            margin-bottom: 24px;
            border-bottom: 1px solid var(--border);
        }

        .mode-btn {
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
        }

        .mode-btn.active {
            border-bottom-color: var(--primary);
            color: var(--primary);
        }

        .mode-btn:hover:not(.active) {
            color: var(--text-primary);
        }

        .status-message {
            padding: 12px 16px;
            border-radius: 6px;
            font-size: 13px;
            margin-bottom: 16px;
            display: none;
        }

        .status-message.show {
            display: block;
        }

        .status-message.info {
            background: #E8F0FE;
            color: #1A73E8;
            border: 1px solid #CCEEF9;
        }

        .status-message.error {
            background: #FCE8E6;
            color: #D93025;
            border: 1px solid #F4CCCC;
        }

        .status-message.success {
            background: #E6F4EA;
            color: #34A853;
            border: 1px solid #CEEAD6;
        }

        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(26, 115, 232, 0.3);
            border-top: 2px solid #1A73E8;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .hidden {
            display: none !important;
        }

        .footer {
            text-align: center;
            margin-top: 24px;
            font-size: 12px;
            color: var(--text-secondary);
        }

        .divider {
            text-align: center;
            margin: 24px 0;
            position: relative;
        }

        .divider::before {
            content: "";
            position: absolute;
            top: 50%;
            left: 0;
            right: 0;
            height: 1px;
            background: var(--border);
        }

        .divider span {
            background: var(--bg);
            padding: 0 8px;
            position: relative;
            color: var(--text-secondary);
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">N</div>
            <h1>Nexus</h1>
            <p>Secure authentication with passkeys</p>
        </div>

        <!-- Insecure-context banner (HTTP non-localhost). Shown by
             checkSecureContext() on page load when WebAuthn won't
             work; otherwise stays hidden. -->
        <div id="insecureBanner"
             style="display:none; background:#FFF3CD; color:#664D03;
                    border:1px solid #FFE69C; border-radius:8px;
                    padding:14px 16px; margin-bottom:16px;
                    font-size:13px; line-height:1.5;"></div>

        <div class="mode-toggle">
            <button class="mode-btn active" onclick="setMode('login')">Sign In</button>
            <button class="mode-btn" onclick="setMode('register')">Create Account</button>
        </div>

        <div id="statusMessage" class="status-message"></div>

        <!-- Login Mode -->
        <div id="loginMode">
            <div class="form-group">
                <label for="loginDisplayName">Display Name (optional)</label>
                <input type="text" id="loginDisplayName" placeholder="Enter your name"
                       onkeypress="handleKeyPress(event, 'login')">
                <small style="color: var(--text-secondary); font-size: 12px; display: block; margin-top: 4px;">
                    Leave empty to use last registered name
                </small>
            </div>

            <div class="button-group">
                <button class="btn-primary" id="loginBtn" onclick="handleLogin()">
                    Sign in with Passkey
                </button>
                <button class="btn-secondary" onclick="handleCancel()">
                    Cancel
                </button>
            </div>
        </div>

        <!-- Register Mode -->
        <div id="registerMode" class="hidden">
            <!-- #101: prevent silent history loss. If you already have
                 an account, registering creates a NEW user_id and your
                 existing chats become invisible (they're tied to the
                 old user_id). Returning users almost always want
                 Sign In, not Create Account. -->
            <div style="background: rgba(255, 165, 0, 0.1);
                        border: 1px solid rgba(255, 165, 0, 0.3);
                        border-radius: 6px; padding: 10px 12px;
                        margin-bottom: 14px; font-size: 12px;
                        color: #e0b070;">
                ⚠ Only use Create Account if you've never signed in
                before. If you already have chat history, registering
                a new passkey will create a SEPARATE account — your
                old chats will not be accessible from it.
                <a href="#" onclick="setMode('login'); return false;"
                   style="color: #ffc080; text-decoration: underline;">
                    Sign in instead →
                </a>
            </div>

            <div class="form-group">
                <label for="regDisplayName">Display Name</label>
                <input type="text" id="regDisplayName" placeholder="Enter your name"
                       onkeypress="handleKeyPress(event, 'register')">
            </div>

            <div class="button-group">
                <button class="btn-primary" id="registerBtn" onclick="handleRegister()">
                    Create Passkey
                </button>
                <button class="btn-secondary" onclick="handleCancel()">
                    Cancel
                </button>
            </div>
        </div>

        <div class="footer">
            <p>Your passkeys are stored securely on your device</p>
        </div>
    </div>

    <script>
        const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;
        const SERVER_URL = window.location.origin;
        let currentMode = 'login';

        // ── Secure-context guard ────────────────────────────────────
        // WebAuthn passkeys require HTTPS unless host is "localhost".
        // The browser's `navigator.credentials.create/get` calls fail
        // silently otherwise — historically users saw the buttons do
        // "nothing" with no error. Detect the bad case here, disable
        // the login/register buttons up front, and show a clear,
        // actionable error so the user knows the deploy needs HTTPS.
        function checkSecureContext() {
            const isLocalhost = location.hostname === 'localhost'
                || location.hostname === '127.0.0.1'
                || location.hostname === '[::1]';
            // window.isSecureContext is true for HTTPS or localhost.
            if (window.isSecureContext || isLocalhost) return true;

            const banner = document.getElementById('insecureBanner');
            if (banner) {
                banner.style.display = 'block';
                // Use template literals (backticks) so we don't have to
                // escape apostrophes — the previous version with
                // ``'You\\'re on '`` got mangled by Python's string
                // escapes (\\' → '), producing JS like ``'You're on '``
                // which the parser bailed on with "Unexpected identifier
                // 're'", taking the whole script down with it. Backticks
                // sidestep the entire quote-escaping minefield.
                banner.innerHTML = `
                    <strong>Passkeys need HTTPS.</strong> You are on
                    <code>${location.protocol}//${location.host}</code>
                    (plain HTTP). Browsers block WebAuthn outside HTTPS / localhost.<br><br>
                    Easiest fix: deploy with the included Docker + Caddy setup
                    (<code>scripts/deploy_setup.sh</code>) — that gives you
                    <code>https://&lt;ip-with-dashes&gt;.nip.io</code> with a real
                    Let&apos;s Encrypt cert and passkeys work normally.<br><br>
                    For local dev, point the desktop at <code>http://localhost:8001</code>
                    instead of the public IP.
                `;
            }
            // Disable both action buttons so users don't keep clicking.
            ['loginBtn', 'registerBtn'].forEach(id => {
                const b = document.getElementById(id);
                if (b) { b.disabled = true; b.style.opacity = '0.55'; }
            });
            return false;
        }
        // Run on page load so the warning is visible BEFORE any click.
        document.addEventListener('DOMContentLoaded', checkSecureContext);

        function setMode(mode) {
            currentMode = mode;
            document.getElementById('loginMode').classList.toggle('hidden', mode !== 'login');
            document.getElementById('registerMode').classList.toggle('hidden', mode !== 'register');
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.toggle('active',
                    (mode === 'login' && btn.textContent === 'Sign In') ||
                    (mode === 'register' && btn.textContent === 'Create Account')
                );
            });
            clearStatus();
        }

        function showStatus(message, type = 'info') {
            const el = document.getElementById('statusMessage');
            el.textContent = message;
            el.className = `status-message show ${type}`;
        }

        function clearStatus() {
            document.getElementById('statusMessage').classList.remove('show');
        }

        function handleKeyPress(event, mode) {
            if (event.key === 'Enter') {
                if (mode === 'login') handleLogin();
                else handleRegister();
            }
        }

        async function handleLogin() {
            clearStatus();
            const loginBtn = document.getElementById('loginBtn');

            try {
                loginBtn.disabled = true;
                showStatus('Starting passkey authentication...', 'info');

                // Step 1: Get login challenge
                const startResp = await fetch(`${SERVER_URL}/api/v1/auth/passkey/login/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: null }),
                });

                if (!startResp.ok) {
                    throw new Error(`Server error: ${startResp.status}`);
                }

                const startData = await startResp.json();

                // Step 2: Start WebAuthn authentication
                showStatus('Complete authentication on your security key', 'info');

                const assertion = await startAuthentication({
                    challenge: startData.challenge,
                    rp: { id: startData.rp_id },
                    allowCredentials: [],
                    userVerification: 'required',
                    timeout: 60000,
                });

                // Step 3: Submit assertion to server
                // The server will extract user_id from the credential stored during registration
                showStatus('Verifying credentials...', 'info');

                // Extract user_id from assertion if available, or let server handle it
                const userId = assertion.id || 'unknown';

                const finishResp = await fetch(`${SERVER_URL}/api/v1/auth/passkey/login/finish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: userId,
                        assertion: assertion,
                    }),
                });

                if (!finishResp.ok) {
                    // #101: when the server can't find a matching passkey
                    // (status 404), it's almost always because the user
                    // never registered on this machine (or their iCloud
                    // Keychain doesn't have the credential synced).
                    // Surface a clear next step + auto-flip the mode
                    // toggle to Register so the user can fix it with
                    // one click instead of staring at a cryptic 404.
                    const errData = await finishResp.json().catch(() => ({}));
                    if (finishResp.status === 404) {
                        showStatus(
                            'No matching passkey for this device. ' +
                            'Click "Create Account" to register first.',
                            'error',
                        );
                        setMode('register');
                        loginBtn.disabled = false;
                        return;
                    }
                    throw new Error(errData.detail || 'Authentication failed');
                }

                const finishData = await finishResp.json();
                const token = finishData.jwt_token;

                showStatus('Authentication successful!', 'success');
                setTimeout(() => {
                    redirectToApp(token);
                }, 500);

            } catch (error) {
                console.error('Login error:', error);
                showStatus(`Error: ${error.message}`, 'error');
                loginBtn.disabled = false;
            }
        }

        async function handleRegister() {
            clearStatus();
            const displayName = document.getElementById('regDisplayName').value.trim();
            const registerBtn = document.getElementById('registerBtn');

            if (!displayName) {
                showStatus('Please enter your display name', 'error');
                return;
            }

            try {
                registerBtn.disabled = true;
                showStatus('Preparing account creation...', 'info');

                // Step 1: Start registration
                const startResp = await fetch(`${SERVER_URL}/api/v1/auth/passkey/register/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ display_name: displayName }),
                });

                if (!startResp.ok) {
                    throw new Error(`Server error: ${startResp.status}`);
                }

                const startData = await startResp.json();
                const userId = startData.user_id;

                // Step 2: Start WebAuthn registration
                showStatus('Complete registration on your security key', 'info');

                const attestation = await startRegistration({
                    challenge: startData.challenge,
                    rp: {
                        id: startData.rp_id,
                        name: startData.rp_name,
                    },
                    user: {
                        id: userId,
                        name: displayName,
                        displayName: displayName,
                    },
                    pubKeyCredParams: [
                        { alg: -7, type: 'public-key' },
                        { alg: -257, type: 'public-key' },
                    ],
                    timeout: 60000,
                    userVerification: 'required',
                    attestation: 'direct',
                });

                // Step 3: Complete registration
                showStatus('Creating your account...', 'info');

                const finishResp = await fetch(`${SERVER_URL}/api/v1/auth/passkey/register/finish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: userId,
                        display_name: displayName,
                        credential: attestation,
                    }),
                });

                if (!finishResp.ok) {
                    const errData = await finishResp.json();
                    throw new Error(errData.detail || 'Registration failed');
                }

                const finishData = await finishResp.json();
                const token = finishData.jwt_token;

                showStatus('Account created! Signing you in...', 'success');
                setTimeout(() => {
                    redirectToApp(token);
                }, 500);

            } catch (error) {
                console.error('Register error:', error);
                showStatus(`Error: ${error.message}`, 'error');
                registerBtn.disabled = false;
            }
        }

        function handleCancel() {
            redirectToApp(null);
        }

        function redirectToApp(token) {
            // Get callback URL from query params (set by Desktop app)
            const params = new URLSearchParams(window.location.search);
            const callbackUrl = params.get('callback');

            if (!token) {
                if (callbackUrl) {
                    window.location = `${callbackUrl}?cancelled=true`;
                } else {
                    window.location = `rune-callback://cancelled=true`;
                }
                return;
            }

            if (callbackUrl) {
                // HTTP callback to Desktop's local listener
                window.location = `${callbackUrl}?token=${encodeURIComponent(token)}`;
            } else {
                // Fallback: custom URL scheme
                window.location = `rune-callback://token=${encodeURIComponent(token)}`;
            }
        }

        // Check for WebAuthn support
        window.addEventListener('load', () => {
            if (!window.PublicKeyCredential) {
                showStatus('Passkeys are not supported in your browser', 'error');
                document.querySelectorAll('button[onclick*="handleLogin"], button[onclick*="handleRegister"]')
                    .forEach(btn => btn.disabled = true);
                return;
            }

            // If launched from Desktop (has callback param), make first-time
            // registration the default path — most users hitting this from a
            // fresh desktop install have no credentials yet. They can still
            // switch to "Sign In" via the mode toggle.
            //
            // IMPORTANT: do NOT replace document.body.innerHTML here — that
            // would destroy loginBtn / statusMessage / regDisplayName and
            // break every subsequent DOM lookup.
            const params = new URLSearchParams(window.location.search);
            if (params.get('callback')) {
                // Tighten the page chrome a bit and show a "from desktop" hint
                const headerP = document.querySelector('.header p');
                if (headerP) {
                    headerP.textContent = 'Continue to Nexus on your desktop';
                }
                // #101: default to SIGN-IN, not register. Returning users
                // re-opening the desktop should hit the login path so
                // they recover their existing user_id (and therefore
                // their chat history, which is keyed by user_id under
                // ~/.nexus_server/twins/<user_id>/). Defaulting to
                // register silently spawned a fresh user_id every time
                // someone forgot to flip the toggle, with the symptom
                // "all my chats disappeared after logout".
                //
                // First-timers can still flip to "Create Account" via
                // the visible toggle. The handleLogin flow surfaces a
                // clean "No matching passkey found — register first?"
                // error if there's nothing to sign in to, which is the
                // RIGHT prompt for a true first-timer.
                setMode('login');
            }
        });
    </script>
</body>
</html>
"""


@router.get("/passkey-page", response_class=HTMLResponse)
async def passkey_page() -> str:
    """Serve the passkey authentication page.

    Returns:
        HTML page with WebAuthn registration and login interface
    """
    logger.info("Serving passkey authentication page")
    return PASSKEY_PAGE_HTML
