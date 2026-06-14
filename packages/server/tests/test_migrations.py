"""
Tests for the Alembic migration runner (U3.4).

Three scenarios we MUST guarantee:

  1. Fresh DB (no tables at all) → upgrade head → all tables exist,
     alembic_version stamped at current head.
  2. DB already at head → upgrade head is a no-op (no SQL fires).
  3. DB at older revision → only the missing migrations run; existing
     data is preserved.

Plus a defensive test: every migration file in versions/ MUST be
discoverable + importable by Alembic, so we don't ship a broken
migration that crashes startup for every user.

Per ENGINEERING_STANDARDS.md rule 3, these tests must run green before
any change to migrations/ ships.
"""
from __future__ import annotations

import importlib
import pathlib
import sqlite3
import sys
import tempfile

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _make_alembic_cfg(db_path: str):
    """Build an Alembic Config pointing at the given sqlite DB."""
    from alembic.config import Config
    from nexus_server.migrations.runner import _migrations_dir

    cfg = Config(str(_migrations_dir() / "alembic.ini"))
    cfg.set_main_option("script_location", str(_migrations_dir()))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return cfg


def _table_columns(db_path: str, table: str) -> list[str]:
    with sqlite3.connect(db_path) as c:
        return [r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()]


def _current_head(db_path: str) -> str | None:
    with sqlite3.connect(db_path) as c:
        try:
            row = c.execute("SELECT version_num FROM alembic_version").fetchone()
            return row[0] if row else None
        except sqlite3.OperationalError:
            return None


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_every_migration_module_importable():
    """Catch syntax errors / wrong-name imports before they reach a user."""
    from nexus_server.migrations.runner import _migrations_dir
    versions = _migrations_dir() / "versions"
    py_files = sorted(versions.glob("*.py"))
    assert py_files, "no migration files found — regression?"

    for f in py_files:
        mod_name = f"nexus_server.migrations.versions.{f.stem}"
        # Reload-safe — works whether or not the module was already
        # imported by a previous test.
        try:
            mod = importlib.import_module(mod_name)
            importlib.reload(mod)
        except Exception as exc:
            pytest.fail(f"migration {f.name} failed to import: {exc}")
        assert hasattr(mod, "revision"), f"{f.name} missing revision id"
        assert hasattr(mod, "upgrade"),  f"{f.name} missing upgrade()"
        assert hasattr(mod, "downgrade"), f"{f.name} missing downgrade()"


def test_fresh_db_upgrades_to_head(tmp_path, monkeypatch):
    """Empty DB → upgrade head → all expected tables + alembic_version."""
    from alembic import command

    db = tmp_path / "fresh.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    # Force config singleton to re-read env so the runner sees the tmp DB.
    # monkeypatch.setattr → auto-reverts at test teardown. Plain
    # ``ServerConfig.DATABASE_URL = …`` would leak across the test
    # session and break test_files_endpoints' fixtures which open
    # the DB at the conftest-pinned /tmp/rune_test.db path.
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")

    cfg = _make_alembic_cfg(str(db))
    command.upgrade(cfg, "head")

    # alembic_version should now exist and be at the latest revision
    head = _current_head(str(db))
    assert head is not None, "alembic_version row missing after upgrade"
    # As of U3.4 the latest revision is 0002. Update this assertion when
    # adding 0003 etc. — the failure tells you to add a new test.
    assert head == "0002", f"expected head=0002, got {head!r}"

    # uploads table exists with the columns 0002 was supposed to add
    cols = _table_columns(str(db), "uploads")
    assert "memory_status" in cols
    assert "memory_summary" in cols
    assert "quick_scan_status" in cols
    assert "quick_scan_summary" in cols


def test_upgrade_is_idempotent(tmp_path, monkeypatch):
    """Running upgrade head twice doesn't crash and doesn't duplicate
    rows in alembic_version."""
    from alembic import command

    db = tmp_path / "idem.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    # monkeypatch.setattr → auto-reverts at test teardown. Plain
    # ``ServerConfig.DATABASE_URL = …`` would leak across the test
    # session and break test_files_endpoints' fixtures which open
    # the DB at the conftest-pinned /tmp/rune_test.db path.
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")

    cfg = _make_alembic_cfg(str(db))
    command.upgrade(cfg, "head")
    command.upgrade(cfg, "head")    # second run = no-op

    with sqlite3.connect(db) as c:
        n = c.execute("SELECT COUNT(*) FROM alembic_version").fetchone()[0]
        assert n == 1, f"alembic_version has {n} rows; expected 1"


def test_0002_idempotent_against_legacy_db(tmp_path, monkeypatch):
    """A DB that already has the 0002 columns (from pre-Alembic code)
    must NOT cause 0002 to fail with 'duplicate column name'. This
    protects users whose old _ensure_uploads_table() already added the
    columns before we wrote this migration."""
    from alembic import command

    db = tmp_path / "legacy.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    # monkeypatch.setattr → auto-reverts at test teardown. Plain
    # ``ServerConfig.DATABASE_URL = …`` would leak across the test
    # session and break test_files_endpoints' fixtures which open
    # the DB at the conftest-pinned /tmp/rune_test.db path.
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")

    # Pretend pre-Alembic code created the uploads table WITH all the
    # columns 0002 adds.
    with sqlite3.connect(db) as c:
        c.executescript("""
            CREATE TABLE uploads (
                file_id TEXT PRIMARY KEY,
                user_id TEXT,
                name TEXT,
                memory_status TEXT NOT NULL DEFAULT '',
                memory_summary TEXT NOT NULL DEFAULT '',
                quick_scan_status TEXT NOT NULL DEFAULT '',
                quick_scan_summary TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO uploads(file_id, user_id, name) VALUES ('f1', 'u1', 'pet.zip');
        """)

    cfg = _make_alembic_cfg(str(db))
    # The 0001 migration calls init_event_sourcing_schema etc. — those
    # might fail in this synthetic setup, but 0002 specifically should
    # not crash on duplicate columns. Stamp 0001 as already applied so
    # only 0002 runs.
    command.stamp(cfg, "0001")
    command.upgrade(cfg, "head")    # should NOT raise duplicate column

    # The pre-existing row must survive.
    with sqlite3.connect(db) as c:
        row = c.execute("SELECT user_id FROM uploads WHERE file_id='f1'").fetchone()
        assert row and row[0] == "u1", "data lost across migration"


def test_runner_imports_cleanly():
    """The runner module must import without side effects on every
    nexus_server boot — this protects against accidental top-level
    work in migrations/__init__ or env.py."""
    import nexus_server.migrations.runner as runner
    importlib.reload(runner)
    assert hasattr(runner, "run_migrations")
    assert hasattr(runner, "current_revision")


def test_pyinstaller_spec_bundles_migrations_under_nexus_server_prefix():
    """
    Regression for the 2026-06-14 production crash:

        RuntimeError: alembic.ini missing at
        /private/var/folders/.../T/_MEIxxxxxx/nexus_server/migrations/alembic.ini.
        PyInstaller bundle didn't include nexus_server/migrations/ — fix the spec.

    Root cause: the spec computed datafile destinations with
    ``f.relative_to(NEXUS_SERVER)`` which stripped the ``nexus_server/``
    prefix. At runtime ``runner.py`` is at
    ``_MEIPASS/nexus_server/migrations/runner.py`` and resolves
    ``Path(__file__).parent / 'alembic.ini'``, so the file MUST be at
    ``_MEIPASS/nexus_server/migrations/alembic.ini``.

    This test parses the spec file as text (we don't want to execute
    PyInstaller's ``Analysis()`` here — it's slow and pulls in too
    much). We assert:

      * The spec uses ``relative_to(ROOT)`` for the migrations data list
        (NOT ``relative_to(NEXUS_SERVER)`` which was the buggy form).
      * The hidden_imports list still names every versions/*.py module
        (so PyInstaller's static analysis can compile them).
    """
    spec = pathlib.Path(__file__).resolve().parents[1] / "nexus-server.spec"
    text = spec.read_text()

    # Locate the migrations_data block. Be lenient about whitespace so
    # the test doesn't break on cosmetic reformatting.
    assert "migrations_data" in text, \
        "spec lost the migrations_data list — runner won't find alembic.ini"

    # Find the migrations_data assignment + the next ``for`` loop. The
    # block must use relative_to(ROOT), NOT relative_to(NEXUS_SERVER).
    m_start = text.find("migrations_data = []")
    assert m_start != -1
    # Truncate to a window large enough to capture the loop body.
    m_end = text.find("\n# ", m_start + 1)  # next top-level comment
    if m_end == -1:
        m_end = len(text)
    block = text[m_start:m_end]

    assert "relative_to(ROOT)" in block, (
        "migrations_data must compute destinations relative to ROOT so "
        "the 'nexus_server/' prefix is preserved in the bundle. "
        "Found block:\n" + block
    )
    assert "relative_to(NEXUS_SERVER)" not in block, (
        "migrations_data is using the buggy relative_to(NEXUS_SERVER) — "
        "this strips the 'nexus_server/' prefix and alembic.ini won't "
        "land next to runner.py. Use relative_to(ROOT) instead. "
        "Found block:\n" + block
    )

    # Each migration version file must be listed as a hiddenimport so
    # PyInstaller compiles its bytecode (Alembic loads it by name at
    # runtime, which static analysis can't see).
    versions_dir = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "migrations" / "versions"
    )
    for f in versions_dir.glob("*.py"):
        if f.name.startswith("_"):
            continue
        modname = f"nexus_server.migrations.versions.{f.stem}"
        assert modname in text, (
            f"spec missing hidden_imports entry for {modname} — "
            "PyInstaller can't statically discover migration modules "
            "(Alembic loads them via importlib at runtime). Add this "
            "name to the `hidden` list in nexus-server.spec."
        )


def test_migrations_dir_fallback_to_meipass(tmp_path, monkeypatch):
    """
    Defensive: even if a future spec accidentally drops alembic.ini
    next to runner.py, _migrations_dir() must still find it as long as
    it landed SOMEWHERE under sys._MEIPASS (either at
    ``nexus_server/migrations/`` or at the legacy ``migrations/``
    location). This keeps a spec misconfiguration from being
    immediately fatal at user-startup.
    """
    import nexus_server.migrations.runner as runner

    # Stage a fake _MEIPASS that has alembic.ini ONLY in the legacy
    # location (no nexus_server/ prefix).
    fake_meipass = tmp_path / "_MEItest"
    legacy_dir = fake_meipass / "migrations"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "alembic.ini").write_text("[alembic]\nscript_location = .\n")

    # Point Path(__file__).parent at a directory that has NO alembic.ini
    # so the first candidate misses, forcing the fallback.
    empty_dir = tmp_path / "no-ini-here"
    empty_dir.mkdir()
    fake_self = empty_dir / "runner.py"
    fake_self.write_text("")  # content doesn't matter; only the path does

    monkeypatch.setattr(runner, "__file__", str(fake_self))
    monkeypatch.setattr(sys, "_MEIPASS", str(fake_meipass), raising=False)

    found = runner._migrations_dir()
    assert (found / "alembic.ini").exists(), \
        f"_migrations_dir fell back to {found} but no alembic.ini there"
    # And it MUST be the legacy dir we set up (the only one with the file).
    assert found == legacy_dir, \
        f"expected fallback to legacy {legacy_dir}, got {found}"
