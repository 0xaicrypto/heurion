"""External skill import — #111 marketplace MVP.

Lets the user install any agentskills.io-compatible SKILL.md from a
URL (raw GitHub link, gist, marketplace download). The server fetches
the file, parses the frontmatter to extract the skill's name, and
drops it into the user's ``.nexus/skills/`` directory using the same
layout as starter packs.

Security
========
* HTTP fetch is gated by an allow-list of safe hosts (GitHub raw,
  gist, agentskills.io). The user can override via the
  ``NEXUS_SKILL_IMPORT_ALLOW`` env var.
* Hard cap on content size (256 KB) — a SKILL.md should never need
  more than that.
* The skill body is treated as untrusted text. It only becomes an
  LLM system prompt when the user installs a workflow that
  references it, so attack surface is the prompt injection bar (same
  as starter packs).

Public surface
==============
* :func:`fetch_and_install_skill(url, user_id)` — download, parse,
  write to ``.nexus/skills/<name>/SKILL.md``. Returns the installed
  skill's name.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# Hosts the server will fetch SKILL.md content from. Conservative
# default — extend via NEXUS_SKILL_IMPORT_ALLOW=host1,host2 for
# self-hosters that ship their own skill registry.
_DEFAULT_ALLOWED_HOSTS = (
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "agentskills.io",
)

# Hard cap on the SKILL.md size we'll accept. 256 KB is generous —
# the largest real-world SKILL.md in the K-Dense-AI catalog clocks in
# at ~80 KB.
_MAX_SKILL_BYTES = 256 * 1024

# Match the SkillManager's name validation: kebab-case, alphanumeric
# + dashes. Other chars → reject, don't sanitise (silent rewrites are
# nasty — name should round-trip exactly).
_VALID_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")


def _allowed_hosts() -> tuple[str, ...]:
    env = os.environ.get("NEXUS_SKILL_IMPORT_ALLOW", "").strip()
    if not env:
        return _DEFAULT_ALLOWED_HOSTS
    extra = tuple(h.strip() for h in env.split(",") if h.strip())
    return _DEFAULT_ALLOWED_HOSTS + extra


def _host_allowed(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in _allowed_hosts()


def _user_skills_dir() -> Path:
    """Same location starter_packs.install_pack uses — the SkillManager
    default points here at cwd-relative ``.nexus/skills``."""
    return Path.cwd() / ".nexus" / "skills"


def _parse_skill_name(text: str) -> Optional[str]:
    """Quick-and-dirty YAML frontmatter scan for ``name:`` field.
    Avoids pulling in PyYAML as a new dep — the format is consistent
    enough that regex is fine. Returns None when no name found."""
    # Frontmatter must be the first thing in the file.
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    block = text[3:end]
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("name:"):
            return stripped.split(":", 1)[1].strip().strip("\"").strip("'")
    return None


def fetch_and_install_skill(url: str, user_id: str) -> dict:
    """Download a remote SKILL.md and install it under the user's
    skills dir as a folder-layout skill.

    Returns ``{name, path, bytes_written}`` on success. Raises
    :class:`ValueError` (with a user-friendly message) on any
    rejected condition.
    """
    if not url or not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    if not _host_allowed(url):
        raise ValueError(
            f"Host not in allow-list. Permitted: "
            f"{', '.join(_allowed_hosts())}. Override via "
            "NEXUS_SKILL_IMPORT_ALLOW env var."
        )

    # Lazy-import httpx so import-time doesn't pull network deps.
    import httpx
    try:
        resp = httpx.get(url, timeout=15.0, follow_redirects=True)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"Fetch failed: {e}") from e
    if resp.status_code != 200:
        raise ValueError(
            f"Fetch returned HTTP {resp.status_code} — "
            f"check the URL points at a raw SKILL.md."
        )
    body = resp.content
    if len(body) > _MAX_SKILL_BYTES:
        raise ValueError(
            f"SKILL.md too large ({len(body)} bytes; cap "
            f"{_MAX_SKILL_BYTES}). Skill markdown files should be "
            "self-contained; large reference material belongs in a "
            "references/ subfolder fetched separately."
        )
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(f"SKILL.md is not valid UTF-8: {e}") from e

    name = _parse_skill_name(text)
    if not name:
        raise ValueError(
            "Could not find a `name:` field in the SKILL.md "
            "frontmatter. Ensure the file starts with a `---` "
            "fenced block containing `name: <skill-name>`."
        )
    if not _VALID_NAME_RE.match(name):
        raise ValueError(
            f"Skill name {name!r} is not valid kebab-case "
            "(lowercase letters / digits / dashes only, must "
            "start + end with alphanumeric)."
        )

    target_dir = _user_skills_dir() / name
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "SKILL.md"
    target.write_text(text, encoding="utf-8")
    logger.info(
        "Imported skill %r (%d bytes) from %s → %s",
        name, len(body), url, target,
    )
    return {
        "name": name,
        "path": str(target),
        "bytes_written": len(body),
    }
