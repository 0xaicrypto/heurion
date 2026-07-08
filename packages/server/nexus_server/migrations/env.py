"""Alembic env.py — wires the migration runner to nexus_server.

The standard Alembic env.py supports both "offline" (emit SQL to stdout)
and "online" (run against a live DB) modes. We only ever use online mode
because PyInstaller doesn't ship a SQL client; offline mode is a no-op.

The DB URL comes from ServerConfig.DATABASE_URL (which itself reads
DATABASE_URL env var with a sensible default). We never read it from
alembic.ini — the placeholder there is intentional.
"""
from __future__ import annotations

import logging
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

logger = logging.getLogger("alembic.env")

# Alembic config object.
config = context.config

# Configure logging from the ini file.
if config.config_file_name is not None:
    try:
        fileConfig(config.config_file_name)
    except Exception as e:
        # File-based logging config is a nice-to-have. If it explodes
        # (PyInstaller path resolution sometimes does), fall back to
        # the parent process's logging config.
        logger.debug("fileConfig failed: %s", e)


def _resolve_db_url() -> str:
    """Pull the DB URL from ServerConfig.

    We delay the import until runtime so this module can be loaded by
    Alembic's CLI without spinning up the whole server.
    """
    try:
        from nexus_server.config import get_config
        return get_config().DATABASE_URL
    except Exception:
        # Fallback to whatever's on alembic.ini (only matters for
        # ``alembic`` invoked outside the server, e.g. local dev).
        return config.get_main_option("sqlalchemy.url") or \
            os.environ.get("DATABASE_URL") or "sqlite:///./nexus_server.db"


def run_migrations_offline() -> None:
    """No-op for our use case — we never emit SQL files."""
    url = _resolve_db_url()
    context.configure(
        url=url, target_metadata=None, literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,           # SQLite ALTER TABLE compat
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live DB.

    ``render_as_batch=True`` is critical for SQLite — without it,
    Alembic generates ALTER TABLE statements SQLite doesn't support
    (DROP COLUMN, CHANGE TYPE). With batch mode, Alembic transparently
    rewrites the table via CREATE TABLE + INSERT SELECT + DROP/RENAME.
    """
    url = _resolve_db_url()
    logger.info("alembic: running migrations against %s", url)
    connectable = create_engine(
        url, poolclass=pool.NullPool,
        # SQLite-specific: enable FK enforcement so migrations that
        # rely on CASCADE behave correctly.
        connect_args={"check_same_thread": False} if url.startswith("sqlite") else {},
    )

    with connectable.connect() as connection:
        if url.startswith("sqlite"):
            connection.exec_driver_sql("PRAGMA foreign_keys = ON")
        context.configure(
            connection=connection,
            target_metadata=None,
            render_as_batch=True,
            # Don't compare schema; we hand-write every migration.
            compare_type=False,
            compare_server_default=False,
            # SQLAlchemy 2.x + alembic 1.18 + SQLite: the version row
            # INSERT lands in a transaction that begin_transaction()
            # opens, but exit-commit semantics changed in SA 2.x and
            # the row is rolled back on connection close even though
            # the DDL above (in "non-transactional DDL" mode) is
            # already on disk. Forcing transaction_per_migration =
            # True wraps the version-stamp INSERT in its own
            # explicit txn that always commits.
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()
        # Belt-and-suspenders: an explicit commit at the end of the
        # connection's lifetime ensures every dangling change (including
        # the version-row INSERT) is flushed. No-op if alembic's
        # transaction_per_migration already committed.
        try:
            connection.commit()
        except Exception as e:
            logger.debug("explicit commit after migrations failed: %s", e)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
