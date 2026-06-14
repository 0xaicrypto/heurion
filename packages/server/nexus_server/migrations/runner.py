"""Migration runner — programmatic Alembic upgrade.

Called once at FastAPI startup by ``main.py::lifespan``. Brings the DB
to ``head`` (latest migration). Idempotent: re-running when already at
head is a no-op.

Why programmatic instead of ``alembic upgrade head`` CLI:

  * In a PyInstaller bundle there is no `alembic` script on $PATH.
  * Programmatic API gives us a single point to inject our log handler
    and surface migration failures into the desktop's startup banner.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def _migrations_dir() -> Path:
    """Path to the alembic root (where alembic.ini + env.py live).

    Resolution order (first hit wins):

      1. ``Path(__file__).parent`` — works for source-tree runs AND for
         correctly-bundled PyInstaller (alembic.ini sits next to this
         runner.py in ``_MEIPASS/nexus_server/migrations/``).

      2. ``sys._MEIPASS / "nexus_server" / "migrations"`` — explicit
         PyInstaller temp dir lookup. Belt-and-suspenders: even if the
         spec bundles into a non-standard destination, this fallback
         catches it as long as the file made it into the binary.

      3. ``sys._MEIPASS / "migrations"`` — last resort for the legacy
         (pre-U3.4) spec convention that stripped the ``nexus_server/``
         prefix. Kept so an older spec doesn't crash a new runner.

    Raises FileNotFoundError if none of the candidates contain
    ``alembic.ini`` — caller surfaces this as a startup error.
    """
    candidates = [Path(__file__).resolve().parent]
    mei = getattr(sys, "_MEIPASS", None)
    if mei:
        candidates.append(Path(mei) / "nexus_server" / "migrations")
        candidates.append(Path(mei) / "migrations")
    for c in candidates:
        if (c / "alembic.ini").exists():
            return c
    # No candidate worked — return the first so the caller's existing
    # error message ("alembic.ini missing at ...") points at the most
    # informative path. Listing every tried candidate in the error
    # makes spec-bundle bugs trivial to diagnose.
    msg_lines = ["alembic.ini missing in PyInstaller bundle. Tried:"]
    for c in candidates:
        msg_lines.append(f"  - {c}")
    raise FileNotFoundError("\n".join(msg_lines))


def run_migrations() -> str:
    """Bring the DB to ``head``. Returns the new head revision.

    Raises:
        RuntimeError on any migration failure — startup must abort so
        the user sees a meaningful error instead of broken queries
        later.
    """
    # Defer Alembic imports until first call so module load is cheap.
    from alembic import command
    from alembic.config import Config

    # _migrations_dir() raises FileNotFoundError with the full candidate
    # list if NONE of the fallbacks have alembic.ini — surface that as
    # the startup error so a spec-bundle bug points right at itself.
    try:
        mdir = _migrations_dir()
    except FileNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
    cfg_file = mdir / "alembic.ini"

    cfg = Config(str(cfg_file))
    # script_location → the directory holding env.py + versions/
    cfg.set_main_option("script_location", str(mdir))
    # DB URL is resolved inside env.py from ServerConfig; the
    # placeholder in alembic.ini is intentional. We still write the
    # real value here for any tooling that introspects cfg directly.
    try:
        from nexus_server.config import get_config
        cfg.set_main_option("sqlalchemy.url", get_config().DATABASE_URL)
    except Exception:
        pass

    logger.info("running Alembic upgrade head (cfg=%s)", cfg_file)
    try:
        command.upgrade(cfg, "head")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"DB migration failed: {exc}") from exc

    # Report current head for the startup log.
    head = current_revision()
    logger.info("DB at revision: %s", head or "(empty)")
    return head or ""


def current_revision() -> str | None:
    """The currently-applied revision in the DB (None if no migrations
    have ever run)."""
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy import create_engine

    try:
        from nexus_server.config import get_config
        url = get_config().DATABASE_URL
    except Exception:
        url = os.environ.get("DATABASE_URL", "sqlite:///./nexus_server.db")

    engine = create_engine(url)
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn)
        return ctx.get_current_revision()
