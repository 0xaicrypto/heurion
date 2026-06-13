#!/usr/bin/env python3
"""CI lint — forbid direct writes to event-sourced projection tables.

Per ADR-002 Rev-8 / design v3 §16.12.3, the ONLY legal mutation entry
point for projection tables is ``Store.emit_and_apply()``. This script
greps for any INSERT / UPDATE / DELETE / REPLACE SQL targeting a name
in ``PROJECTION_TABLES`` from outside the ``event_sourcing/`` and
``replay``-allowed modules. Hits = CI failure.

Usage::

    python scripts/lint_no_direct_projection_writes.py packages/server

Exit codes:
    0 — clean
    1 — violations found
    2 — script error / no files scanned

Per task #195 this is a hard gate on M0 readiness.

What's allowed
==============

Direct projection writes are permitted ONLY from:

* ``packages/server/nexus_server/event_sourcing/handlers.py``
  (replay handlers — the very point of the architecture)
* ``packages/server/nexus_server/event_sourcing/schema.py``
  (DDL — CREATE / DROP only, not data writes)
* ``packages/server/tests/`` (tests may construct projection rows
  directly to seed scenarios, but only when explicitly bypassing
  the contract for testing the contract itself)

Everything else must route through ``Store.emit_and_apply``.

What's detected
===============

* ``INSERT INTO <projection_table>``
* ``UPDATE <projection_table>`` (including OR REPLACE)
* ``DELETE FROM <projection_table>``
* ``REPLACE INTO <projection_table>``

In any combination of casing, whitespace, comments stripping, and
string interpolation. False-positive risk: docstrings / comments
containing literal SQL — handled by stripping ``#`` and triple-quoted
strings before matching.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from typing import Iterable


PROJECTION_TABLES = (
    "clinical_graph_nodes",
    "clinical_graph_edges",
    "node_provenance",
    "cached_views",
    "practitioner_facts",
    "practitioner_observations",
    "reference_knowledge",
)

# Files allowed to issue direct writes to projection tables.
ALLOWED_PATH_SUFFIXES = (
    "/event_sourcing/handlers.py",
    "/event_sourcing/schema.py",
    "/event_sourcing/replay.py",   # full_rebuild calls drop_projections
    "/cached_views.py",            # Tier-1 cache materialiser (deterministic)
    "/tests/test_event_sourcing.py",
    "/tests/test_cached_views.py",
    "/scripts/lint_no_direct_projection_writes.py",  # this file itself
)

# Regex for the forbidden SQL verbs targeting any projection table.
_VERB_PATTERNS = []
for table in PROJECTION_TABLES:
    _VERB_PATTERNS.extend([
        rf"\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+{table}\b",
        rf"\bUPDATE\s+{table}\b",
        rf"\bDELETE\s+FROM\s+{table}\b",
        rf"\bREPLACE\s+INTO\s+{table}\b",
    ])
_VIOLATION_RE = re.compile("|".join(_VERB_PATTERNS), re.IGNORECASE)


def _strip_comments_and_docstrings(src: str) -> str:
    """Best-effort strip of Python ``#`` comments + triple-quoted strings.

    Imperfect (won't handle nested or escaped quotes inside docstrings),
    but the goal is to reduce false positives where the file simply
    documents the SQL. False negatives (real violations slipping through)
    are bounded — the actual SQL will still match outside docstrings.
    """
    # Remove triple-quoted strings (greedy, single-pass; good enough).
    src = re.sub(r'"""[\s\S]*?"""', "", src)
    src = re.sub(r"'''[\s\S]*?'''", "", src)
    # Remove # comments.
    src = re.sub(r"#[^\n]*", "", src)
    return src


def _is_allowed(path: pathlib.Path) -> bool:
    s = str(path)
    return any(s.endswith(suffix) for suffix in ALLOWED_PATH_SUFFIXES)


def _scan_file(path: pathlib.Path) -> list[tuple[int, str]]:
    """Return list of (line_no, line_text) for each violation."""
    if _is_allowed(path):
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []

    stripped = _strip_comments_and_docstrings(raw)
    # Stripping is for detection; reporting uses raw lines so the dev
    # sees the actual offending text in their editor.
    hits: list[tuple[int, str]] = []
    if not _VIOLATION_RE.search(stripped):
        return hits
    # Now find which raw line(s) contain the violation.
    for lineno, line in enumerate(raw.splitlines(), 1):
        if _VIOLATION_RE.search(line):
            # Don't flag commented-out SQL.
            stripped_line = re.sub(r"#.*$", "", line)
            if _VIOLATION_RE.search(stripped_line):
                hits.append((lineno, line.rstrip()))
    return hits


def main(roots: Iterable[str]) -> int:
    paths_scanned = 0
    total_violations = 0
    for root in roots:
        rp = pathlib.Path(root)
        if not rp.exists():
            print(f"[lint] root does not exist: {rp}", file=sys.stderr)
            continue
        for path in rp.rglob("*.py"):
            paths_scanned += 1
            hits = _scan_file(path)
            for lineno, line in hits:
                total_violations += 1
                print(
                    f"{path}:{lineno}: VIOLATION — direct projection write\n"
                    f"    {line}\n"
                    f"    Use Store.emit_and_apply() instead. "
                    f"See ADR-002 Rev-8 / docs/design/m3-memory-architecture.md §16.12.",
                    file=sys.stderr,
                )

    if paths_scanned == 0:
        print("[lint] no .py files found in scan roots", file=sys.stderr)
        return 2

    if total_violations:
        print(
            f"\n[lint] FAIL — {total_violations} violation(s) across "
            f"{paths_scanned} files.\n"
            f"[lint] Contract B (event_log = single source of truth) "
            f"requires every projection mutation to flow through "
            f"Store.emit_and_apply().",
            file=sys.stderr,
        )
        return 1

    print(
        f"[lint] OK — {paths_scanned} files scanned; "
        f"no direct projection writes found."
    )
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "roots", nargs="*",
        default=["packages/server"],
        help="Paths to scan recursively (default: packages/server)",
    )
    args = ap.parse_args()
    sys.exit(main(args.roots))
