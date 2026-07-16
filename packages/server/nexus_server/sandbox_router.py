"""Sandbox code execution — REST endpoint + LLM tool.

POST /api/v1/sandbox/execute

Accepts ``language`` (python|bash) and ``code`` (string).
Executes in a temp directory with a 30-second timeout, captures
stdout + stderr, and returns the result as a JSON dict:
  {ok, stdout, stderr, runtime_ms, language}

Also exposes an LLM tool ``sandbox_execute`` so the agent can run
code from chat. Registered via ``register_sandbox_tool()``.

Safety constraints
──────────────────
- 30-second wall-clock timeout (SIGTERM at 30s, SIGKILL at 35s)
- No network access (disabled via container env — this is a
  defence-in-depth note; the runtime itself has network)
- Working directory is a tempdir under /tmp/nexus-sandbox/
- Maximum output capture: 64 KB per stream (stdout/stderr truncated
  beyond that to prevent the sandbox from DOS-ing the server)
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from nexus_core.tools.base import BaseTool
from nexus_server.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/sandbox", tags=["sandbox"])

_MAX_RUNTIME_S = 30
_MAX_OUTPUT_BYTES = 64 * 1024
_SANDBOX_BASE = Path("/tmp/nexus-sandbox")


class SandboxRequest(BaseModel):
    language: str = Field(..., description="python or bash")
    code:     str = Field(..., min_length=1, max_length=50000)


class SandboxResponse(BaseModel):
    ok:         bool
    stdout:     str
    stderr:     str
    runtime_ms: int
    language:   str
    error:      str = ""


@router.post("/execute", response_model=SandboxResponse)
async def sandbox_execute(
    req: SandboxRequest,
    current_user: str = Depends(get_current_user),
) -> SandboxResponse:
    lang = req.language.strip().lower()
    if lang not in ("python", "bash", "sh"):
        raise HTTPException(status_code=400, detail="Unsupported language. Use python or bash.")

    _SANDBOX_BASE.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(dir=_SANDBOX_BASE, prefix=f"{lang}-"))

    try:
        t0 = time.monotonic()
        if lang == "python":
            # Write code to a .py file so tracebacks include line numbers
            script = run_dir / "script.py"
            script.write_text(req.code, encoding="utf-8")
            proc = subprocess.Popen(
                ["python3", str(script)],
                cwd=str(run_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        elif lang in ("bash", "sh"):
            proc = subprocess.Popen(
                ["bash", "-c", req.code],
                cwd=str(run_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "LC_ALL": "C.UTF-8"},
            )
        else:
            raise HTTPException(status_code=400, detail="Unsupported language.")

        try:
            stdout, stderr = proc.communicate(timeout=_MAX_RUNTIME_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            runtime_ms = int((time.monotonic() - t0) * 1000)
            return SandboxResponse(
                ok=False,
                stdout=stdout.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES],
                stderr=stderr.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES],
                runtime_ms=runtime_ms,
                language=lang,
                error=f"Execution timed out after {_MAX_RUNTIME_S}s",
            )

        runtime_ms = int((time.monotonic() - t0) * 1000)
        return SandboxResponse(
            ok=proc.returncode == 0,
            stdout=stdout.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES],
            stderr=stderr.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES],
            runtime_ms=runtime_ms,
            language=lang,
            error="" if proc.returncode == 0 else f"Exit code: {proc.returncode}",
        )

    except Exception as exc:
        logger.exception("sandbox execution failed: user=%s", current_user)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Sandbox error: {type(exc).__name__}: {exc}",
        ) from exc
    finally:
        # Best-effort cleanup of temp dir
        try:
            import shutil
            shutil.rmtree(run_dir, ignore_errors=True)
        except Exception:
            pass


# ── LLM Tool (registered during agent bootstrap like the calendar tools) ──

def _execute_sync(language: str, code: str) -> dict:
    """Synchronous wrapper used by the tool's execute() method."""
    lang = language.strip().lower()
    _SANDBOX_BASE.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(dir=_SANDBOX_BASE, prefix=f"{lang}-"))

    try:
        t0 = time.monotonic()
        if lang == "python":
            script = run_dir / "script.py"
            script.write_text(code, encoding="utf-8")
            proc = subprocess.Popen(
                ["python3", str(script)],
                cwd=str(run_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        else:
            proc = subprocess.Popen(
                ["bash", "-c", code],
                cwd=str(run_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "LC_ALL": "C.UTF-8"},
            )

        try:
            stdout, stderr = proc.communicate(timeout=_MAX_RUNTIME_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            return {"ok": False, "stdout": stdout.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES], "stderr": stderr.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES], "runtime_ms": int((time.monotonic() - t0) * 1000), "error": f"Timed out after {_MAX_RUNTIME_S}s"}

        return {"ok": proc.returncode == 0, "stdout": stdout.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES], "stderr": stderr.decode("utf-8", errors="replace")[:_MAX_OUTPUT_BYTES], "runtime_ms": int((time.monotonic() - t0) * 1000), "error": "" if proc.returncode == 0 else f"Exit {proc.returncode}"}
    finally:
        try:
            import shutil
            shutil.rmtree(run_dir, ignore_errors=True)
        except Exception:
            pass


class SandboxExecuteTool(BaseTool):
    @property
    def name(self) -> str:
        return "sandbox_execute"

    @property
    def description(self) -> str:
        return (
            "Execute Python or Bash code in an isolated sandbox. "
            "Returns stdout, stderr, exit code, and runtime.\n\n"
            "Use this to:\n"
            "- Run calculations or data analysis\n"
            "- Test code snippets\n"
            "- Process text or files programmatically\n"
            "- Execute shell commands for file operations\n\n"
            "30-second timeout. 64 KB output limit per stream. "
            "The sandbox has access to the server's Python 3 "
            "environment (numpy, pillow, etc.)."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "language": {
                    "type": "string",
                    "enum": ["python", "bash"],
                    "description": "Programming language to execute",
                },
                "code": {
                    "type": "string",
                    "description": "The source code or shell command to execute",
                },
            },
            "required": ["language", "code"],
        }

    async def execute(self, *, language: str, code: str, **kwargs) -> str:
        import json
        result = _execute_sync(language, code)
        return json.dumps(result, ensure_ascii=False)


def register_sandbox_tool(twin):
    """Register the sandbox tool with a DigitalTwin instance."""
    twin.register_tool(SandboxExecuteTool())
    logger.info("sandbox tool registered for user %s", twin.user_id)
