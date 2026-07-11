"""Authentication router and utilities.

Handles JWT and WebAuthn authentication flows:
  - User registration (username + password, bcrypt-hashed)
  - Password login (+ one-time /claim flow for legacy accounts)
  - WebAuthn passkey registration and login (optional second method)
  - JWT token creation and verification
"""

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from base64 import b64encode
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator

from nexus_server.config import get_config
from nexus_server.database import get_db_connection

logger = logging.getLogger(__name__)
config = get_config()

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


# ───────────────────────────────────────────────────────────────────────────
# Request/Response Models
# ───────────────────────────────────────────────────────────────────────────


# Trivially guessable passwords rejected outright even when they pass
# the >= 8 chars length gate.
_COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789",
    "1234567890", "qwertyui", "qwerty123", "11111111", "00000000",
    "letmein12", "iloveyou", "aa345678",
}


def _validate_password(v: str) -> str:
    """Shared password policy: min 8 chars, not blank, not common."""
    if not v or not v.strip():
        raise ValueError("Password cannot be empty")
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    if v.lower() in _COMMON_PASSWORDS:
        raise ValueError("Password is too common")
    return v


def _validate_username(v: str) -> str:
    v = (v or "").strip()
    if not v:
        raise ValueError("Username cannot be empty")
    return v


class UserRegisterRequest(BaseModel):
    """User registration request (username + password)."""

    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8, max_length=256)
    display_name: Optional[str] = Field(default=None, max_length=255)

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        return _validate_username(v)

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return _validate_password(v)


class UserRegisterResponse(BaseModel):
    """User registration response."""

    user_id: str
    jwt_token: str
    created_at: str
    role: str = "user"
    expires_in_seconds: int = 0


class UserLoginRequest(BaseModel):
    """User login request (username + password)."""

    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        return _validate_username(v)


class UserLoginResponse(BaseModel):
    """User login response."""

    jwt_token: str
    expires_in_seconds: int
    user_id: str = ""
    role: str = "user"
    display_name: str = ""


class UserClaimRequest(BaseModel):
    """One-time account claim: set a password on a legacy
    (password_hash IS NULL) account."""

    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8, max_length=256)

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        return _validate_username(v)

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return _validate_password(v)


class WebAuthnRegisterStartRequest(BaseModel):
    """WebAuthn registration start request."""

    display_name: str = Field(..., min_length=1, max_length=255)
    user_agent: Optional[str] = None


class WebAuthnRegisterStartResponse(BaseModel):
    """WebAuthn registration start response."""

    challenge: str
    user_id: str
    rp_id: str
    rp_name: str


class WebAuthnRegisterFinishRequest(BaseModel):
    """WebAuthn registration finish request."""

    user_id: str
    display_name: str
    credential: dict


class WebAuthnRegisterFinishResponse(BaseModel):
    """WebAuthn registration finish response."""

    user_id: str
    jwt_token: str
    credential_id: str


class WebAuthnLoginStartRequest(BaseModel):
    """WebAuthn login start request."""

    user_id: Optional[str] = None


class WebAuthnLoginStartResponse(BaseModel):
    """WebAuthn login start response."""

    challenge: str
    rp_id: str


class WebAuthnLoginFinishRequest(BaseModel):
    """WebAuthn login finish request."""

    user_id: str
    assertion: dict


class WebAuthnLoginFinishResponse(BaseModel):
    """WebAuthn login finish response."""

    jwt_token: str
    expires_in_seconds: int


# ───────────────────────────────────────────────────────────────────────────
# Token Helpers
# ───────────────────────────────────────────────────────────────────────────


def create_jwt_token(user_id: str, jwt_secret: str) -> tuple[str, int]:
    """Create JWT token for user.

    Args:
        user_id: User identifier
        jwt_secret: User-specific secret for token signing

    Returns:
        (token, expires_in_seconds)
    """
    expiration_hours = config.JWT_EXPIRATION_HOURS
    expires_at = datetime.now(timezone.utc) + timedelta(hours=expiration_hours)

    payload = {
        "user_id": user_id,
        "exp": expires_at,
        "iat": datetime.now(timezone.utc),
    }

    token = jwt.encode(
        payload, jwt_secret, algorithm=config.JWT_ALGORITHM
    )
    expires_in = int(expiration_hours * 3600)

    return token, expires_in


def verify_jwt_token(token: str, user_id: str) -> bool:
    """Verify JWT token signature and expiry.

    Args:
        token: JWT token to verify
        user_id: Expected user in token

    Returns:
        True if valid, False otherwise
    """
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT jwt_secret FROM users WHERE id = ?",
                           (user_id,))
            row = cursor.fetchone()

        if not row:
            return False

        jwt_secret = row[0]
        payload = jwt.decode(
            token, jwt_secret, algorithms=[config.JWT_ALGORITHM]
        )
        return payload.get("user_id") == user_id

    except jwt.ExpiredSignatureError:
        logger.warning(f"JWT token expired for user {user_id}")
        return False
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid JWT token for user {user_id}: {e}")
        return False


async def get_current_user(
    authorization: Optional[str] = Header(None),
) -> str:
    """Dependency to get current authenticated user.

    Args:
        authorization: Authorization header (Bearer <token>)

    Returns:
        Authenticated user ID

    Raises:
        HTTPException: If authorization fails
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header",
        )

    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise ValueError("Invalid scheme")
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header format",
        )

    # Extract user_id from token
    try:
        unverified = jwt.decode(
            token, options={"verify_signature": False}
        )
        user_id = unverified.get("user_id")
    except jwt.DecodeError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    if not verify_jwt_token(token, user_id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    # Reject tokens of deleted / admin-disabled accounts. The JWT
    # itself stays cryptographically valid until expiry, so this DB
    # check is the only thing standing between a disabled user and
    # the API.
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT disabled_at, deleted_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None or row["deleted_at"] is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    if row["disabled_at"] is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_disabled",
                    "message": "This account has been disabled."},
        )

    return user_id


# ───────────────────────────────────────────────────────────────────────────
# Password Helpers
# ───────────────────────────────────────────────────────────────────────────

# Pre-computed hash used to equalise timing when the username doesn't
# exist: we still run one bcrypt verify so "user not found" and "wrong
# password" take roughly the same time.
_DUMMY_PASSWORD_HASH = bcrypt.hashpw(
    b"nexus-dummy-password-for-timing", bcrypt.gensalt(rounds=12)
)


def hash_password(password: str) -> str:
    """bcrypt-hash a plaintext password for storage."""
    return bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(rounds=12)
    ).decode("utf-8")


def verify_password(password: str, password_hash: Optional[str]) -> bool:
    """Constant-ish-time password check. When ``password_hash`` is
    None/empty we verify against a dummy hash and return False, so
    the caller's timing doesn't leak whether the account exists."""
    try:
        if not password_hash:
            bcrypt.checkpw(password.encode("utf-8"), _DUMMY_PASSWORD_HASH)
            return False
        return bcrypt.checkpw(
            password.encode("utf-8"), password_hash.encode("utf-8")
        )
    except (ValueError, TypeError):
        return False


def _find_user_by_username(conn, username: str):
    """Case-insensitive (casefold, CJK-safe) username lookup over live
    users. Returns a sqlite3.Row or None. Table is tiny (tens of rows)
    so the Python-side scan is fine — SQLite's LIKE is ASCII-only."""
    typed_fold = (username or "").strip().casefold()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, display_name, jwt_secret, password_hash, role, "
        "       disabled_at, created_at "
        "FROM users WHERE deleted_at IS NULL"
    ).fetchall()
    for r in rows:
        if (r["display_name"] or "").strip().casefold() == typed_fold:
            return r
    return None


# ───────────────────────────────────────────────────────────────────────────
# Auth Rate Limiting (in-memory, per IP + username)
# ───────────────────────────────────────────────────────────────────────────

_AUTH_RATE_LIMIT = 5          # attempts
_AUTH_RATE_WINDOW = 60.0      # seconds
_AUTH_ATTEMPTS: dict[str, list[float]] = {}
_AUTH_ATTEMPTS_LOCK = threading.Lock()


def _check_auth_rate_limit(request: Optional[Request], scope: str,
                           key: str) -> None:
    """Sliding-window limiter for login / claim / register.

    Keyed by (client IP, scope, casefolded username) so a brute-force
    against one account is throttled without collateral damage to
    other accounts behind the same NAT. Raises 429 when exceeded.
    Set ``NEXUS_AUTH_RATELIMIT_DISABLED=1`` to bypass (test suites).
    """
    if os.environ.get("NEXUS_AUTH_RATELIMIT_DISABLED") == "1":
        return
    ip = "unknown"
    if request is not None and request.client is not None:
        ip = request.client.host or "unknown"
    bucket = f"{ip}|{scope}|{(key or '').strip().casefold()}"
    now = time.time()
    with _AUTH_ATTEMPTS_LOCK:
        attempts = [
            t for t in _AUTH_ATTEMPTS.get(bucket, [])
            if now - t < _AUTH_RATE_WINDOW
        ]
        if len(attempts) >= _AUTH_RATE_LIMIT:
            _AUTH_ATTEMPTS[bucket] = attempts
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"code": "rate_limited",
                        "message": "Too many attempts. Try again in a "
                                   "minute."},
            )
        attempts.append(now)
        _AUTH_ATTEMPTS[bucket] = attempts
        # Opportunistic GC so the dict can't grow unbounded.
        if len(_AUTH_ATTEMPTS) > 10_000:
            cutoff = now - _AUTH_RATE_WINDOW
            for k in [k for k, v in _AUTH_ATTEMPTS.items()
                      if not v or v[-1] < cutoff]:
                _AUTH_ATTEMPTS.pop(k, None)


# ───────────────────────────────────────────────────────────────────────────
# WebAuthn Helpers
# ───────────────────────────────────────────────────────────────────────────


def generate_webauthn_challenge() -> str:
    """Generate a random WebAuthn challenge.

    Returns:
        Base64-encoded challenge
    """
    return b64encode(uuid.uuid4().bytes).decode("utf-8").rstrip("=")


# ───────────────────────────────────────────────────────────────────────────
# Routes
# ───────────────────────────────────────────────────────────────────────────


def _touch_login_timestamps(user_id: str) -> None:
    """Best-effort update of last_login_at / last_active_at."""
    try:
        now = datetime.now(timezone.utc).isoformat()
        with get_db_connection() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ?, last_active_at = ?, "
                "updated_at = ? WHERE id = ?",
                (now, now, now, user_id),
            )
            conn.commit()
    except sqlite3.Error as exc:
        logger.debug("touch_login_timestamps failed: %s", exc)


@router.post(
    "/register",
    response_model=UserRegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register_user(
    body: UserRegisterRequest,
    request: Request,
) -> UserRegisterResponse:
    """Register a new user with username + password.

    Username is unique (case-insensitive) among live accounts. The
    FIRST user ever registered on this server gets role='admin'.
    """
    _check_auth_rate_limit(request, "register", body.username)

    username = body.username.strip()
    display_name = (body.display_name or "").strip() or username
    user_id = str(uuid.uuid4())
    jwt_secret = str(uuid.uuid4())
    password_hash = hash_password(body.password)
    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        # Check-before-insert guard (the UNIQUE index in init_db is
        # best-effort on legacy DBs with pre-existing duplicates).
        if _find_user_by_username(conn, username) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "username_taken",
                        "message": "This username is already registered."},
            )
        # First ever account on this server becomes the admin.
        n_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        role = "admin" if n_users == 0 else "user"
        try:
            conn.execute(
                """
                INSERT INTO users
                (id, display_name, jwt_secret, password_hash, role,
                 created_at, updated_at, last_login_at, last_active_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, display_name, jwt_secret, password_hash, role,
                 now, now, now, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            # UNIQUE index race — same username inserted concurrently.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "username_taken",
                        "message": "This username is already registered."},
            )

    token, expires_in = create_jwt_token(user_id, jwt_secret)
    logger.info("User registered: %s (role=%s)", user_id[:8], role)

    return UserRegisterResponse(
        user_id=user_id,
        jwt_token=token,
        created_at=now,
        role=role,
        expires_in_seconds=expires_in,
    )


@router.post("/login", response_model=UserLoginResponse)
async def login_user(
    body: UserLoginRequest,
    request: Request,
) -> UserLoginResponse:
    """Password login. Errors:

      * 401 invalid_credentials — unknown username OR wrong password
        (indistinguishable on purpose; bcrypt-verify runs either way).
      * 409 claim_required — account exists but has no password yet
        (legacy passwordless account); client should route to /claim.
      * 403 account_disabled — admin disabled this account.
    """
    _check_auth_rate_limit(request, "login", body.username)

    with get_db_connection() as conn:
        row = _find_user_by_username(conn, body.username)

    if row is None:
        # Equalise timing with the wrong-password path.
        verify_password(body.password, None)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials",
                    "message": "Invalid username or password."},
        )

    if row["password_hash"] is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "claim_required",
                    "message": "This account has no password yet. "
                               "Set one via /api/v1/auth/claim."},
        )

    if not verify_password(body.password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials",
                    "message": "Invalid username or password."},
        )

    if row["disabled_at"] is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_disabled",
                    "message": "This account has been disabled."},
        )

    token, expires_in = create_jwt_token(row["id"], row["jwt_secret"])
    _touch_login_timestamps(row["id"])
    logger.info("User logged in: %s", row["id"][:8])

    return UserLoginResponse(
        jwt_token=token,
        expires_in_seconds=expires_in,
        user_id=row["id"],
        role=row["role"] or "user",
        display_name=row["display_name"] or "",
    )


@router.post("/claim", response_model=UserLoginResponse)
async def claim_account(
    body: UserClaimRequest,
    request: Request,
) -> UserLoginResponse:
    """One-time claim of a legacy passwordless account.

    Allowed ONLY when the user exists AND password_hash IS NULL.
    Sets the password and returns a JWT. After the claim, /login is
    the only way in (this endpoint returns 409 already_claimed).
    """
    _check_auth_rate_limit(request, "claim", body.username)

    with get_db_connection() as conn:
        row = _find_user_by_username(conn, body.username)

    if row is None:
        verify_password(body.password, None)  # timing equalisation
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "user_not_found",
                    "message": "No such account to claim."},
        )

    if row["password_hash"] is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "already_claimed",
                    "message": "This account already has a password. "
                               "Use /api/v1/auth/login."},
        )

    if row["disabled_at"] is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_disabled",
                    "message": "This account has been disabled."},
        )

    password_hash = hash_password(body.password)
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? "
            "WHERE id = ? AND password_hash IS NULL",
            (password_hash, now, row["id"]),
        )
        conn.commit()
        if cur.rowcount == 0:
            # Race: someone claimed it between SELECT and UPDATE.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "already_claimed",
                        "message": "This account already has a password."},
            )

    token, expires_in = create_jwt_token(row["id"], row["jwt_secret"])
    _touch_login_timestamps(row["id"])
    logger.info("Legacy account claimed: %s", row["id"][:8])

    return UserLoginResponse(
        jwt_token=token,
        expires_in_seconds=expires_in,
        user_id=row["id"],
        role=row["role"] or "user",
        display_name=row["display_name"] or "",
    )


# ───────────────────────────────────────────────────────────────────────────
# F26.1 — Multi-identity management (USER_MANAGEMENT.md §4 + §5)
# ───────────────────────────────────────────────────────────────────────────

CURRENT_IDENTITY_SCHEMA = 2


class IdentityInfo(BaseModel):
    """Public-facing view of one identity row, for picker UI."""
    user_id: str
    display_name: str
    avatar_emoji: str
    created_at: str
    last_active_at: Optional[str] = None


def _identity_file_path():
    """Resolve $RUNE_HOME/identity.json. Late-import to avoid circular
    dep with settings_router."""
    from pathlib import Path
    from nexus_server.settings_router import _rune_home
    rune_home = _rune_home()
    rune_home.mkdir(parents=True, exist_ok=True)
    return rune_home / "identity.json"


def _rotate_identity_backup(id_file) -> None:
    """§4.4.4 — before every write, rotate the current file to
    ``identity.json.bak.<unix_ts>``. Keep the most recent 3 backups;
    GC older ones. Idempotent + best-effort."""
    if not id_file.exists():
        return
    try:
        ts = int(time.time())
        bak = id_file.with_name(f"identity.json.bak.{ts}")
        id_file.rename(bak)
    except OSError as exc:
        logger.warning("identity.json backup rotate failed: %s", exc)
        return
    # GC: keep most recent 3.
    try:
        baks = sorted(
            id_file.parent.glob("identity.json.bak.*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old in baks[3:]:
            try:
                old.unlink()
            except OSError as e:
                logger.debug("pruning old identity backup failed: %s", e)
    except OSError as e:
        logger.debug("identity backup rotation failed: %s", e)


def _write_identity_atomic(id_file, content: dict) -> None:
    """§4.4.4 — atomic write via tempfile + rename so a crash mid-write
    leaves the previous version intact."""
    import json as _json
    import tempfile
    tmp = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", delete=False,
        dir=str(id_file.parent), prefix=".identity.", suffix=".tmp",
    )
    try:
        _json.dump(content, tmp, indent=2, ensure_ascii=False)
        tmp.flush()
        os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, id_file)
    try:
        os.chmod(id_file, 0o600)
    except OSError as e:
        logger.debug("chmod identity file failed: %s", e)


def _read_identity_file(id_file) -> "dict | None":
    """Read + parse identity.json. Returns None on missing / corrupt.
    Never raises — corruption is a recovery trigger, not an error."""
    import json as _json
    if not id_file.exists():
        return None
    try:
        return _json.loads(id_file.read_text(encoding="utf-8"))
    except (OSError, _json.JSONDecodeError) as exc:
        logger.warning("identity.json unreadable (%s) — will rebuild", exc)
        return None


def _build_identity_from_user_row(row) -> dict:
    """Translate a users-table row (sqlite3.Row or tuple-with-known-shape)
    into the picker JSON shape. Handles legacy rows missing the new
    columns by falling back to sensible defaults."""
    # Support both row-as-mapping (Row) and row-as-tuple. We use a
    # tolerant accessor so this helper works regardless of how the
    # caller queried.
    def _get(key, default=None):
        try:
            v = row[key]
        except (IndexError, KeyError, TypeError):
            v = default
        return v if v is not None else default
    return {
        "user_id":       _get("id"),
        "display_name":  _get("display_name") or "Doctor",
        "avatar_emoji":  _get("avatar_emoji") or "🩺",
        "created_at":    _get("created_at"),
        "last_active_at": _get("last_active_at") or _get("updated_at"),
    }


def _rebuild_identity_from_db() -> "tuple[dict, list[dict]]":
    """§4.4.2 — read all undeleted users from the DB, build a fresh
    identity.json shape. Returns ``(active_user_id_or_None, identities)``.
    If the users table is empty, returns ``(None, [])``."""
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, display_name, avatar_emoji, created_at, "
            "       updated_at, last_active_at "
            "FROM users "
            "WHERE deleted_at IS NULL "
            "ORDER BY COALESCE(last_active_at, updated_at) DESC"
        ).fetchall()
    identities = [_build_identity_from_user_row(r) for r in rows]
    active = identities[0]["user_id"] if identities else None
    return active, identities


def _persist_identity_file(active_user_id: "str | None",
                           identities: list[dict],
                           *, recovered: bool = False) -> None:
    """Write the full v2 identity.json shape. Rotates backup first."""
    id_file = _identity_file_path()
    _rotate_identity_backup(id_file)
    payload = {
        "schema_version": CURRENT_IDENTITY_SCHEMA,
        "active_user_id": active_user_id,
        "identities": identities,
    }
    if recovered:
        payload["_recovered_from_users_table_at"] = datetime.now(
            timezone.utc
        ).isoformat()
    _write_identity_atomic(id_file, payload)


def _migrate_v1_to_v2(v1_doc: dict) -> dict:
    """v1 was ``{"user_id": ..., "created_at": ..., "schema_version": 1}``.
    Wrap that single id into the v2 list shape, then let the caller
    enrich with display_name/avatar from the users-table lookup."""
    candidate = (v1_doc.get("user_id") or "").strip()
    if not candidate:
        return {"schema_version": 2, "active_user_id": None, "identities": []}
    return {
        "schema_version": 2,
        "active_user_id": candidate,
        "identities": [{
            "user_id":      candidate,
            "display_name": "Doctor",
            "avatar_emoji": "🩺",
            "created_at":   v1_doc.get("created_at"),
            "last_active_at": v1_doc.get("created_at"),
        }],
    }


def _resolve_identity_state() -> "tuple[dict, bool]":
    """The §4.4 recovery decision tree, wrapped into a single helper
    that the /identities endpoints use.

    Returns ``(state_dict, recovered_from_db_flag)``. ``state_dict``
    has the v2 shape and is freshly written to disk if anything was
    repaired.
    """
    id_file = _identity_file_path()
    doc = _read_identity_file(id_file)

    if doc is not None:
        version = doc.get("schema_version") or 1
        if version == 1:
            # Auto-migrate v1 → v2. Enrich from users table if
            # possible (display_name / avatar from DB if user
            # already has those columns).
            v2_doc = _migrate_v1_to_v2(doc)
            uid = v2_doc.get("active_user_id")
            if uid:
                with get_db_connection() as conn:
                    conn.row_factory = sqlite3.Row
                    row = conn.execute(
                        "SELECT id, display_name, avatar_emoji, "
                        "       created_at, updated_at, last_active_at "
                        "FROM users WHERE id = ? AND deleted_at IS NULL",
                        (uid,),
                    ).fetchone()
                if row:
                    v2_doc["identities"] = [_build_identity_from_user_row(row)]
                else:
                    # v1 file pointed at a missing user. Trigger
                    # rebuild from DB.
                    doc = None  # force fall-through
                    logger.warning(
                        "v1 identity.json pointed at user_id %s not in DB — "
                        "rebuilding from users table",
                        uid[:8],
                    )
            if doc is not None:
                _persist_identity_file(
                    v2_doc.get("active_user_id"),
                    v2_doc.get("identities") or [],
                )
                return v2_doc, False

        if doc is not None:
            # v2+. Validate active points at a real, undeleted user.
            ids = doc.get("identities") or []
            active = doc.get("active_user_id")
            with get_db_connection() as conn:
                conn.row_factory = sqlite3.Row
                live_rows = {
                    r["id"]: r for r in conn.execute(
                        "SELECT id, display_name, avatar_emoji, "
                        "       created_at, updated_at, last_active_at "
                        "FROM users WHERE deleted_at IS NULL"
                    ).fetchall()
                }
            # Strip stale identities; refresh display fields from DB.
            cleaned: list[dict] = []
            for entry in ids:
                uid = entry.get("user_id")
                if uid in live_rows:
                    cleaned.append(_build_identity_from_user_row(live_rows[uid]))
            if not any(e["user_id"] == active for e in cleaned):
                active = cleaned[0]["user_id"] if cleaned else None
            if not cleaned:
                doc = None   # fall through to rebuild
            else:
                changed = (
                    len(cleaned) != len(ids)
                    or active != doc.get("active_user_id")
                )
                if changed:
                    _persist_identity_file(active, cleaned)
                return {
                    "schema_version": CURRENT_IDENTITY_SCHEMA,
                    "active_user_id": active,
                    "identities": cleaned,
                }, False

    # ─── §4.4.2 — Recovery: rebuild from users table ──────────────────
    active, identities = _rebuild_identity_from_db()
    if identities:
        _persist_identity_file(active, identities, recovered=True)
        logger.warning(
            "identity.json missing/corrupt — recovered %d identities "
            "from users table; active=%s",
            len(identities), (active or "")[:8],
        )
        return {
            "schema_version": CURRENT_IDENTITY_SCHEMA,
            "active_user_id": active,
            "identities": identities,
        }, True

    # ─── §4.4.3 — Both file and DB are empty: truly new install ───────
    return {
        "schema_version": CURRENT_IDENTITY_SCHEMA,
        "active_user_id": None,
        "identities": [],
    }, False


# ───────────────────────────────────────────────────────────────────────────
# F26.1 — Multi-identity CRUD endpoints (§5.1)
# ───────────────────────────────────────────────────────────────────────────

class IdentitiesListResponse(BaseModel):
    identities: list[IdentityInfo]
    active_user_id: Optional[str] = None
    schema_version: int = CURRENT_IDENTITY_SCHEMA


@router.get("/identities", response_model=IdentitiesListResponse)
async def list_identities() -> IdentitiesListResponse:
    """List all undeleted identities on this machine for the picker UI.
    No auth required (see §5.2 — local-only attack surface)."""
    state, _ = _resolve_identity_state()
    return IdentitiesListResponse(
        identities=[IdentityInfo(**i) for i in state["identities"]],
        active_user_id=state["active_user_id"],
        schema_version=CURRENT_IDENTITY_SCHEMA,
    )


class PatchIdentityRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    avatar_emoji: Optional[str] = Field(default=None, max_length=8)


@router.patch("/identities/{user_id}", response_model=IdentityInfo)
async def patch_identity(
    user_id: str, req: PatchIdentityRequest,
    current_user: str = Depends(get_current_user),
) -> IdentityInfo:
    """Rename / change emoji. Auth required AND ``current_user`` must
    match the target — you can't edit someone else's identity."""
    if current_user != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="cannot edit another identity",
        )
    updates: list[str] = []
    params: list = []
    if req.display_name is not None and req.display_name.strip():
        updates.append("display_name = ?")
        params.append(req.display_name.strip())
    if req.avatar_emoji is not None and req.avatar_emoji.strip():
        updates.append("avatar_emoji = ?")
        params.append(req.avatar_emoji.strip())
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="no fields provided",
        )
    now = datetime.now(timezone.utc).isoformat()
    updates.append("updated_at = ?")
    params.append(now)
    params.append(user_id)

    with get_db_connection() as conn:
        cur = conn.execute(
            f"UPDATE users SET {', '.join(updates)} "
            f"WHERE id = ? AND deleted_at IS NULL",
            tuple(params),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="identity not found",
            )

    # Refresh identity.json from DB so picker shows the new label.
    _, identities = _rebuild_identity_from_db()
    state, _ = _resolve_identity_state()
    _persist_identity_file(state["active_user_id"], identities)

    updated = next(
        (i for i in identities if i["user_id"] == user_id), None
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="identity not found after update",
        )
    return IdentityInfo(**updated)


@router.delete("/identities/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_identity(
    user_id: str,
    current_user: str = Depends(get_current_user),
):
    """SOFT delete (§6.4). Sets ``users.deleted_at``; row + all
    projections stay in DB for 90 days for recovery. The picker
    immediately hides this identity. The cron job in
    ``async_tasks`` does the hard delete after 90 days."""
    if current_user != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="cannot delete another identity",
        )
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        cur = conn.execute(
            "UPDATE users SET deleted_at = ?, updated_at = ? "
            "WHERE id = ? AND deleted_at IS NULL",
            (now, now, user_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="identity not found or already deleted",
            )

    # Refresh identity.json — picks new active from remaining live rows.
    active, identities = _rebuild_identity_from_db()
    _persist_identity_file(active, identities)
    logger.info("delete_identity (soft): user_id=%s", user_id[:8])


class WipeIdentityRequest(BaseModel):
    """Belt-and-braces hard delete. UI should require a 2-step confirm.
    ``confirm_token`` is the literal string "I-UNDERSTAND-WIPE" — a
    deliberate friction to prevent accidental clicks."""
    confirm_token: str


@router.post("/identities/{user_id}/wipe",
             status_code=status.HTTP_204_NO_CONTENT)
async def wipe_identity(
    user_id: str, req: WipeIdentityRequest,
    current_user: str = Depends(get_current_user),
):
    """HARD delete — drops the users row + every user-scoped projection
    (clinical_graph_nodes, practitioner_*, chat_takeaways, patients,
    uploads, sessions, twin_event_log). Irreversible. Re-uses the
    patients_router.delete_patient cascade pattern."""
    if current_user != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="cannot wipe another identity",
        )
    if req.confirm_token != "I-UNDERSTAND-WIPE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="confirm_token mismatch",
        )

    with get_db_connection() as conn:
        for table in (
            "clinical_graph_nodes", "clinical_graph_edges", "node_provenance",
            "practitioner_observations", "practitioner_facts",
            "chat_takeaways", "patient_memory", "patients", "uploads",
            "twin_event_log",
        ):
            try:
                conn.execute(
                    f"DELETE FROM {table} WHERE user_id = ?", (user_id,),
                )
            except sqlite3.Error as e:
                logger.debug("delete from %s failed: %s", table, e)  # table may not exist on a partial schema
        try:
            conn.execute(
                "UPDATE sessions SET patient_hash = '' WHERE user_id = ?",
                (user_id,),
            )
        except sqlite3.Error as e:
            logger.debug("clearing session patient_hash failed: %s", e)
        # Finally the users row itself.
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()

    # Rebuild identity.json — this user is gone.
    active, identities = _rebuild_identity_from_db()
    _persist_identity_file(active, identities)
    logger.warning(
        "wipe_identity: HARD-deleted user_id=%s + all projections",
        user_id[:8],
    )


@router.post(
    "/passkey/register/start",
    response_model=WebAuthnRegisterStartResponse,
)
async def passkey_register_start(
    request: WebAuthnRegisterStartRequest,
) -> WebAuthnRegisterStartResponse:
    """Start WebAuthn registration.

    Args:
        request: Registration start request

    Returns:
        Challenge and registration options
    """
    user_id = str(uuid.uuid4())
    challenge = generate_webauthn_challenge()

    logger.info(f"WebAuthn registration started for user: {user_id}")

    return WebAuthnRegisterStartResponse(
        challenge=challenge,
        user_id=user_id,
        rp_id=config.WEBAUTHN_RP_ID,
        rp_name=config.WEBAUTHN_RP_NAME,
    )


@router.post(
    "/passkey/register/finish",
    response_model=WebAuthnRegisterFinishResponse,
)
async def passkey_register_finish(
    request: WebAuthnRegisterFinishRequest,
) -> WebAuthnRegisterFinishResponse:
    """Finish WebAuthn registration and create user.

    Args:
        request: Registration finish request with credential

    Returns:
        user_id, JWT token, and credential_id

    Raises:
        HTTPException: If registration fails
    """
    try:
        jwt_secret = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        credential_json = json.dumps(request.credential)

        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO users
                (id, display_name, passkey_credential, jwt_secret,
                 created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    request.user_id,
                    request.display_name,
                    credential_json,
                    jwt_secret,
                    now,
                    now,
                ),
            )
            conn.commit()

        token, _ = create_jwt_token(request.user_id, jwt_secret)
        credential_id = request.credential.get("id", "unknown")

        logger.info(f"WebAuthn registration finished for user: "
                    f"{request.user_id}")

        return WebAuthnRegisterFinishResponse(
            user_id=request.user_id,
            jwt_token=token,
            credential_id=credential_id,
        )
    except Exception as e:
        logger.error(f"WebAuthn registration finish error: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="WebAuthn registration failed",
        )


@router.post(
    "/passkey/login/start",
    response_model=WebAuthnLoginStartResponse,
)
async def passkey_login_start(
    request: WebAuthnLoginStartRequest,
) -> WebAuthnLoginStartResponse:
    """Start WebAuthn login.

    Args:
        request: Login start request

    Returns:
        Challenge for assertion
    """
    challenge = generate_webauthn_challenge()
    logger.info("WebAuthn login started")

    return WebAuthnLoginStartResponse(
        challenge=challenge,
        rp_id=config.WEBAUTHN_RP_ID,
    )


@router.post(
    "/passkey/login/finish",
    response_model=WebAuthnLoginFinishResponse,
)
async def passkey_login_finish(
    request: WebAuthnLoginFinishRequest,
) -> WebAuthnLoginFinishResponse:
    """Finish WebAuthn login.

    Args:
        request: Login finish request with assertion

    Returns:
        JWT token

    Raises:
        HTTPException: If verification fails
    """
    try:
        # The frontend currently passes assertion.id (the credential id, a
        # base64url string) in request.user_id. Match users by the credential
        # id stored in passkey_credential.id — NEVER fall back to "most recent
        # user", which would silently hand a fresh login the wrong account.
        credential_id = (request.assertion or {}).get("id") or request.user_id

        with get_db_connection() as conn:
            cursor = conn.cursor()
            # 1) Direct match: request.user_id is an actual UUID we issued
            cursor.execute(
                "SELECT id, jwt_secret FROM users WHERE id = ?",
                (request.user_id,),
            )
            row = cursor.fetchone()

            # 2) Match by credential id stored on the user
            if not row and credential_id:
                cursor.execute(
                    "SELECT id, jwt_secret FROM users "
                    "WHERE json_extract(passkey_credential, '$.id') = ?",
                    (credential_id,),
                )
                row = cursor.fetchone()

        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No matching passkey found. Please register first.",
            )

        actual_user_id = row[0]
        jwt_secret = row[1]
        token, expires_in = create_jwt_token(actual_user_id, jwt_secret)

        logger.info(f"WebAuthn login finished for user: {actual_user_id}")

        return WebAuthnLoginFinishResponse(
            jwt_token=token,
            expires_in_seconds=expires_in,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"WebAuthn login finish error: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="WebAuthn login failed",
        )


# ─────────────────────────────────────────────────────────────────────
# v2 passkey desktop bridge — bounce + poll
# ─────────────────────────────────────────────────────────────────────
#
# v1's .NET desktop spawns a localhost HttpListener on an ephemeral
# port, opens the system browser at /auth/passkey-page?callback=
# http://127.0.0.1:<port>/auth-callback, and waits for the redirect
# carrying ?token=<jwt>. The whole dance worked because .NET ships an
# HttpListener primitive.
#
# v2's Tauri stack doesn't have a comparable Rust networking helper
# (we'd need to add tokio + write the listener by hand, and threading
# the cancellation / timeout / error paths from Rust back to React via
# events is ~150 lines of brittle code).
#
# So instead we use the EXISTING FastAPI sidecar as the "callback
# receiver". The medic's browser hits the sidecar's
# /api/v1/auth/passkey/bounce/{session_id} URL with the JWT as a
# query param. The sidecar stashes the token in a tiny in-memory
# dict keyed by session_id. Meanwhile the desktop polls
# /api/v1/auth/passkey/poll/{session_id} every ~500ms until it sees
# the token or times out (5 minutes — same as v1).
#
# Lifetimes & safety:
#   * The bounce-store is in-process only — never persisted, so
#     restarting the sidecar mid-flow drops the token (medic just
#     redoes the WebAuthn ceremony). Acceptable: WebAuthn ceremonies
#     are sub-15s usually.
#   * TTL: 5 minutes. The bounce route refuses to stash if the
#     session id was minted >5min ago (replay-window guard) — see
#     ``_session_seen`` set below.
#   * Poll endpoint POPS the token on the first successful read,
#     so a stolen session id can't be replayed even within the TTL.
#   * Session ids are 32-char UUIDs. Brute-forcing in the 5-min
#     window is computationally infeasible (~3e36 try space).
#
# Security note: this layer does NOT change v1's known gap that
# /passkey/register/finish + /passkey/login/finish skip cryptographic
# verification. That's tracked separately as a Phase B work item
# (see docs / agent's report).


_BOUNCE_TTL_SECONDS = 5 * 60       # 5 minutes
_BOUNCE_TOKENS: dict[str, tuple[str, float]] = {}  # session_id → (token, ts)
_BOUNCE_LOCK = threading.Lock()    # asyncio-safe via the GIL inside locked


def _gc_bounce_store() -> None:
    """Drop entries older than TTL. Called on every read/write."""
    cutoff = time.time() - _BOUNCE_TTL_SECONDS
    stale = [sid for sid, (_t, ts) in _BOUNCE_TOKENS.items() if ts < cutoff]
    for sid in stale:
        _BOUNCE_TOKENS.pop(sid, None)


_BOUNCE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signed in</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   "Helvetica Neue", Arial, sans-serif;
      background: #0a0a0a; color: #e0e0e0;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0;
    }
    .card {
      max-width: 380px; padding: 32px 24px;
      background: #161616; border: 1px solid #2a2a2a; border-radius: 8px;
      text-align: center;
    }
    .check { font-size: 36px; color: #4ade80; margin-bottom: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; font-weight: 500; }
    p { color: #999; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">__CHECK__</div>
    <h1>__TITLE__</h1>
    <p>__SUBTITLE__</p>
  </div>
  <script>
    // The desktop is polling /api/v1/auth/passkey/poll for the token.
    // As soon as it lands the desktop will close this window
    // automatically. Self-close after 3s as a fallback so the user
    // doesn't sit looking at the success page indefinitely.
    setTimeout(function () {
      try { window.close(); } catch (e) {}
    }, 3000);
  </script>
</body>
</html>
"""


def _render_bounce_page(title: str, subtitle: str, check: str = "✓") -> str:
    """Tiny string-replace renderer. We don't use str.format() because
    the inline ``<style>`` + ``<script>`` blocks have literal ``{`` and
    ``}`` chars (CSS rules, JS try/catch) which str.format would either
    interpret as placeholders or require double-brace escaping
    everywhere — that's a maintenance nightmare. Three placeholders is
    a small enough surface that .replace is the simplest right answer.
    """
    return (
        _BOUNCE_HTML
        .replace("__CHECK__", check)
        .replace("__TITLE__", title)
        .replace("__SUBTITLE__", subtitle)
    )


@router.get("/passkey/bounce/{session_id}", response_class=HTMLResponse)
async def passkey_bounce(
    session_id: str,
    token: Optional[str] = None,
) -> HTMLResponse:
    """The browser hits this URL after WebAuthn succeeds. We stash
    the JWT (passed as the ``?token=`` query param by passkey_page.py's
    redirect script) keyed by ``session_id``, then render a tiny
    "Signed in. You can close this window." HTML page.

    The desktop's polling loop picks the token up on its next /poll
    request and closes this window from the WebviewWindow side.

    ``session_id`` is a UUID the desktop minted locally and passed
    into ``passkey-page?callback=…/bounce/{session_id}`` — we use
    a path param (not a query param) because v1's passkey_page.py
    builds the final redirect as ``callback + "?token=" + jwt`` and
    we don't want two ``?`` chars colliding.
    """
    if not token:
        # No token? Render an error page; nothing to stash.
        return HTMLResponse(
            content=_render_bounce_page(
                title="Sign-in incomplete",
                subtitle=(
                    "No token was received. Close this window and try "
                    "again from the Nexus app."
                ),
                check="✗",
            ),
            status_code=400,
        )

    # Light-weight validation of the session_id shape — UUID v4
    # canonical form is 36 chars. Refuse anything else to keep this
    # endpoint from being abused as a generic kv-store.
    if not (24 <= len(session_id) <= 64):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="bad session id",
        )

    with _BOUNCE_LOCK:
        _gc_bounce_store()
        _BOUNCE_TOKENS[session_id] = (token, time.time())

    logger.info("passkey bounce: session=%s token-len=%d",
                session_id[:8], len(token))

    return HTMLResponse(content=_render_bounce_page(
        title="Signed in",
        subtitle="You can close this window.",
    ))


class PasskeyPollResponse(BaseModel):
    """The desktop polls this endpoint waiting for the bounce to land."""

    status: str                          # 'pending' | 'ready'
    token:  Optional[str] = None


@router.get("/passkey/poll/{session_id}", response_model=PasskeyPollResponse)
async def passkey_poll(session_id: str) -> PasskeyPollResponse:
    """Desktop polls. Returns ``{status='pending'}`` until the bounce
    arrives, then ``{status='ready', token=<jwt>}`` exactly ONCE — the
    token is popped on read, so a second poll for the same session
    returns 'pending' again. This prevents replay even within the TTL.

    Unauthenticated: the session_id IS the secret (UUID v4, generated
    on the desktop side). An attacker without the session_id can't
    fish tokens out of this endpoint.
    """
    if not (24 <= len(session_id) <= 64):
        return PasskeyPollResponse(status="pending")

    with _BOUNCE_LOCK:
        _gc_bounce_store()
        entry = _BOUNCE_TOKENS.pop(session_id, None)

    if entry is None:
        return PasskeyPollResponse(status="pending")
    token, _ts = entry
    return PasskeyPollResponse(status="ready", token=token)
