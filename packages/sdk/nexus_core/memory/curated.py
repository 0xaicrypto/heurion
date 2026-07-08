"""CuratedMemory — Hermes-style MEMORY.md + USER.md for compact prompt injection.

Two agent-curated markdown files:
  MEMORY.md — Facts, lessons, conventions (~3000 char limit)
  USER.md   — User preferences, communication style (~2000 char limit)

Frozen at session start (injected into system prompt as snapshot).
Updated via tool calls during conversation. Persisted to disk immediately.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

MEMORY_CHAR_LIMIT = 3000
USER_CHAR_LIMIT = 2000
ENTRY_DELIMITER = "\n§\n"


class CuratedMemory:
    """Agent-curated memory in two markdown files."""

    def __init__(self, base_dir: str | Path):
        self._dir = Path(base_dir) / "curated_memory"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._memory_path = self._dir / "MEMORY.md"
        self._user_path = self._dir / "USER.md"
        self._memory_entries: list[str] = []
        self._user_entries: list[str] = []
        self._memory_snapshot: str = ""
        self._user_snapshot: str = ""
        self._load()

    def _load(self) -> None:
        self._memory_entries = self._read_file(self._memory_path)
        self._user_entries = self._read_file(self._user_path)
        self._memory_snapshot = self._format(self._memory_entries)
        self._user_snapshot = self._format(self._user_entries)
        logger.info("CuratedMemory: %d memory + %d user entries",
                     len(self._memory_entries), len(self._user_entries))

    def _read_file(self, path: Path) -> list[str]:
        if not path.exists():
            return []
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            return []
        entries = [e.strip() for e in text.split(ENTRY_DELIMITER) if e.strip()]
        seen = set()
        return [e for e in entries if not (e in seen or seen.add(e))]

    def _write_file(self, path: Path, entries: list[str]) -> None:
        content = ENTRY_DELIMITER.join(entries)
        fd, tmp = tempfile.mkstemp(dir=str(self._dir), suffix=".tmp")
        try:
            os.write(fd, content.encode("utf-8"))
            os.close(fd)
            os.replace(tmp, str(path))
        except Exception:
            os.close(fd)
            try:
                os.unlink(tmp)
            except OSError as e:
                logger.debug("removing tmp file failed: %s", e)
            raise

    def _format(self, entries: list[str]) -> str:
        return ("\n- " + "\n- ".join(entries)) if entries else ""

    def _total_chars(self, entries: list[str]) -> int:
        return sum(len(e) for e in entries) + len(entries) * len(ENTRY_DELIMITER)

    def add_memory(self, content: str) -> bool:
        content = content.strip()
        if not content or content in self._memory_entries:
            return False
        while self._memory_entries and self._total_chars(self._memory_entries) + len(content) > MEMORY_CHAR_LIMIT:
            self._memory_entries.pop(0)
        self._memory_entries.append(content)
        self._write_file(self._memory_path, self._memory_entries)
        return True

    def add_user_info(self, content: str) -> bool:
        content = content.strip()
        if not content or content in self._user_entries:
            return False
        while self._user_entries and self._total_chars(self._user_entries) + len(content) > USER_CHAR_LIMIT:
            self._user_entries.pop(0)
        self._user_entries.append(content)
        self._write_file(self._user_path, self._user_entries)
        return True

    def remove_memory(self, substring: str) -> bool:
        for i, e in enumerate(self._memory_entries):
            if substring in e:
                self._memory_entries.pop(i)
                self._write_file(self._memory_path, self._memory_entries)
                return True
        return False

    def replace_memory(self, old_substring: str, new_content: str) -> bool:
        for i, e in enumerate(self._memory_entries):
            if old_substring in e:
                self._memory_entries[i] = new_content.strip()
                self._write_file(self._memory_path, self._memory_entries)
                return True
        return False

    def get_prompt_context(self) -> str:
        """Frozen snapshot for system prompt (immutable during session)."""
        parts = []
        if self._memory_snapshot:
            parts.append(f"## Your Memory{self._memory_snapshot}")
        if self._user_snapshot:
            parts.append(f"## About This User{self._user_snapshot}")
        return "\n\n".join(parts)

    def refresh_snapshot(self) -> None:
        self._memory_snapshot = self._format(self._memory_entries)
        self._user_snapshot = self._format(self._user_entries)

    @property
    def memory_count(self) -> int:
        return len(self._memory_entries)

    @property
    def user_count(self) -> int:
        return len(self._user_entries)

    @property
    def total_count(self) -> int:
        return len(self._memory_entries) + len(self._user_entries)

    @property
    def memory_entries(self) -> list[str]:
        return list(self._memory_entries)

    @property
    def user_entries(self) -> list[str]:
        return list(self._user_entries)
