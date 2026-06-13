"""
Settings · LLM endpoints — runtime LLM provider/key configuration.

Why this exists
───────────────
v1 desktop (.NET) had no in-app key UI; it depended on bash setup.sh +
start.sh to seed and `export` keys from
``~/Library/Application Support/RuneProtocol/.env`` before spawning the
backend.  See ``packages/desktop/scripts/local-backend/start.sh:220-247``.

v2 Tauri spawn now reads the same .env at boot (see
``packages/desktop-v2/src-tauri/src/lib.rs::load_user_env``) so existing
v1 users get parity. But there is no way to ADD a key without restarting
the app — and a fresh install has no .env at all. This router fills both
gaps:

  GET  /api/v1/settings/llm
      → reports which provider is active, which keys are populated
        (booleans only — keys themselves are never returned), and the
        on-disk .env path for transparency.

  PUT  /api/v1/settings/llm
      → accepts a provider/model + any subset of GEMINI_API_KEY,
        OPENAI_API_KEY, ANTHROPIC_API_KEY values, writes them to
        $RUNE_HOME/.env, AND mutates the in-process config singleton
        so the next chat turn picks them up without a restart.

Per docs/design/m3-memory-architecture.md the chat path can run without
an LLM key (T1/T2 are templated/SQL-only), but T3 reasoning, Twin
memory extraction, embeddings, and Quick scan all require Gemini or
Anthropic. This is the only place that surfaces "you haven't set a key"
to the medic instead of letting it 500 deep in the stack.
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from nexus_server.auth import get_current_user
from nexus_server.config import get_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


# Keys we let the desktop set. Intentionally narrow — billing /
# webauthn / rate-limit settings are not surfaced (they're deploy-level,
# not per-medic). DEFAULT_LLM_* are settable so the desktop can switch
# provider in one round-trip.
ALLOWED_KEYS = {
    "DEFAULT_LLM_PROVIDER",
    "DEFAULT_LLM_MODEL",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
}


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _rune_home() -> Path:
    """Resolve $RUNE_HOME (v1 parity) or fall back to the macOS default.

    The Tauri sidecar sets RUNE_HOME explicitly in lib.rs::spawn_backend_sidecar
    so this is always set in the bundled .app. The fallback is for `uvicorn`
    runs and pytest where the user-level path makes sense anyway.
    """
    env = os.environ.get("RUNE_HOME")
    if env:
        return Path(env)
    return Path(os.path.expanduser("~/Library/Application Support/RuneProtocol"))


def _env_file() -> Path:
    return _rune_home() / ".env"


def _read_env() -> dict[str, str]:
    """Parse $RUNE_HOME/.env into a flat dict. Same rules as v1's start.sh:
    skip blanks + ``#`` comments, split on first ``=``, strip one pair of
    surrounding quotes from values."""
    path = _env_file()
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.rstrip("\r\n")
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        if not k:
            continue
        v = v.strip()
        if len(v) >= 2 and ((v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'")):
            v = v[1:-1]
        out[k] = v
    return out


_LINE_RE_TMPL = r"^[ \t]*{key}=.*$"


def _write_env(updates: dict[str, str]) -> Path:
    """Idempotent merge of ``updates`` into $RUNE_HOME/.env.

    Strategy: read all lines, replace any existing assignment of a
    target key in place, append any keys not already present.  We do
    NOT touch unrelated lines so user comments and ordering survive.
    Atomic via tempfile + rename so a crash mid-write can't truncate
    the file the next launch needs to load.
    """
    path = _env_file()
    path.parent.mkdir(parents=True, exist_ok=True)

    existing_lines: list[str] = []
    if path.exists():
        existing_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()

    remaining = dict(updates)  # keys we still need to write

    new_lines: list[str] = []
    for line in existing_lines:
        replaced = False
        for k in list(remaining.keys()):
            if re.match(_LINE_RE_TMPL.format(key=re.escape(k)), line):
                new_lines.append(f"{k}={remaining.pop(k)}")
                replaced = True
                break
        if not replaced:
            new_lines.append(line)

    if remaining:
        if new_lines and new_lines[-1].strip():
            new_lines.append("")
        new_lines.append("# ── Settings · LLM (written via /api/v1/settings/llm) ──")
        for k, v in remaining.items():
            new_lines.append(f"{k}={v}")

    # Atomic write.
    tmp = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", delete=False,
        dir=str(path.parent), prefix=".env.", suffix=".tmp",
    )
    try:
        tmp.write("\n".join(new_lines))
        if new_lines:
            tmp.write("\n")
        tmp.flush()
        os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, path)
    # Tighten perms — file holds API keys.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def _apply_to_running_config(updates: dict[str, str]) -> None:
    """Mutate the in-process config so the very next LLM call sees the
    new key without a restart.

    Subtle: ``get_config()`` returns a fresh ``ServerConfig()`` instance
    on every call, but the keys are CLASS attributes populated at import
    time from ``os.environ``. So patching an instance is a no-op for
    every other call site; we must patch the class itself. We also
    mirror to ``os.environ`` for any code that re-reads env hot (e.g.
    twin_manager.create_twin reads ``os.environ.get`` directly)."""
    from nexus_server.config import ServerConfig
    for k, v in updates.items():
        os.environ[k] = v
        if hasattr(ServerConfig, k):
            try:
                setattr(ServerConfig, k, v)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "could not set ServerConfig.%s in-process; "
                    "will pick up on next boot", k,
                )


# ─────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────


class LlmStatusResponse(BaseModel):
    provider: str
    model: str
    env_file_path: str
    env_file_exists: bool
    has_gemini_key: bool
    has_openai_key: bool
    has_anthropic_key: bool
    # Free-form note rendered under the form — e.g. tells the user the
    # active provider has no key configured.
    advisory: Optional[str] = None


class LlmUpdateRequest(BaseModel):
    provider: Optional[str] = Field(
        default=None, description="One of: gemini | openai | anthropic",
    )
    model: Optional[str] = Field(default=None)
    gemini_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None


class LlmUpdateResponse(BaseModel):
    ok: bool
    env_file_path: str
    written_keys: list[str]
    status: LlmStatusResponse


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────


def _make_status() -> LlmStatusResponse:
    cfg = get_config()
    path = _env_file()
    provider = cfg.DEFAULT_LLM_PROVIDER
    has_gemini    = bool(cfg.GEMINI_API_KEY)
    has_openai    = bool(cfg.OPENAI_API_KEY)
    has_anthropic = bool(cfg.ANTHROPIC_API_KEY)
    advisory: Optional[str] = None
    if provider == "gemini" and not has_gemini:
        advisory = "Active provider is Gemini but GEMINI_API_KEY is not set."
    elif provider == "openai" and not has_openai:
        advisory = "Active provider is OpenAI but OPENAI_API_KEY is not set."
    elif provider == "anthropic" and not has_anthropic:
        advisory = "Active provider is Anthropic but ANTHROPIC_API_KEY is not set."
    return LlmStatusResponse(
        provider=provider,
        model=cfg.DEFAULT_LLM_MODEL,
        env_file_path=str(path),
        env_file_exists=path.exists(),
        has_gemini_key=has_gemini,
        has_openai_key=has_openai,
        has_anthropic_key=has_anthropic,
        advisory=advisory,
    )


@router.get("/llm", response_model=LlmStatusResponse)
async def get_llm_settings(_: str = Depends(get_current_user)):
    return _make_status()


@router.put("/llm", response_model=LlmUpdateResponse)
async def put_llm_settings(
    body: LlmUpdateRequest,
    _: str = Depends(get_current_user),
):
    """Persist any subset of LLM provider/key settings to $RUNE_HOME/.env
    AND mutate the in-process config so the next chat turn uses them.
    Returns the new status (booleans only — keys themselves never leave
    the server)."""
    updates: dict[str, str] = {}
    if body.provider is not None:
        p = body.provider.strip().lower()
        if p not in {"gemini", "openai", "anthropic"}:
            raise HTTPException(status_code=400, detail=f"unknown provider: {p}")
        updates["DEFAULT_LLM_PROVIDER"] = p
    if body.model is not None and body.model.strip():
        updates["DEFAULT_LLM_MODEL"] = body.model.strip()
    if body.gemini_api_key is not None and body.gemini_api_key.strip():
        updates["GEMINI_API_KEY"] = body.gemini_api_key.strip()
    if body.openai_api_key is not None and body.openai_api_key.strip():
        updates["OPENAI_API_KEY"] = body.openai_api_key.strip()
    if body.anthropic_api_key is not None and body.anthropic_api_key.strip():
        updates["ANTHROPIC_API_KEY"] = body.anthropic_api_key.strip()

    if not updates:
        raise HTTPException(status_code=400, detail="no settings provided")

    try:
        path = _write_env(updates)
    except OSError as exc:
        logger.exception("write_env failed")
        raise HTTPException(status_code=500, detail=f"failed to write .env: {exc}") from exc

    _apply_to_running_config(updates)

    return LlmUpdateResponse(
        ok=True,
        env_file_path=str(path),
        written_keys=sorted(updates.keys()),
        status=_make_status(),
    )
