"""Database migrations — Alembic-driven, raw-SQL based.

We use Alembic ONLY as the migration runner + version tracker.
Migration bodies are hand-rolled raw SQL via op.execute() — there is no
SQLAlchemy ORM layer in nexus_server, and we don't add one here.

Two kinds of migrations, same framework:

  * **Schema migrations** — CREATE / ALTER / DROP TABLE; add or drop
    columns, indexes, FKs. Use ``op.execute("ALTER TABLE ...")`` or
    Alembic's ``op.add_column / op.drop_column`` (batch mode handles
    SQLite's missing-DROP-COLUMN limitation transparently — see
    env.py's ``render_as_batch=True``).
  * **Data migrations** — backfill columns, transform rows, deduplicate.
    Use ``op.execute("UPDATE …")`` or ``op.bulk_insert(table, rows)``.
    Both live alongside schema changes in the SAME migration file when
    they're conceptually one change (e.g. "add column + backfill it").

Best practice: split schema-shape from data-backfill into TWO files
when the backfill is expensive (large row count, slow LLM extraction).
Two reasons:

  1. Atomic schema commits land fast; users with empty / tiny DBs get
     a brief migration. Long-running backfills don't block startup.
  2. If the data step crashes you can re-run it without re-running the
     schema half (idempotent UPDATE WHERE not-yet-backfilled).

Per-launch flow (called from main.py::lifespan):

    from nexus_server.migrations.runner import run_migrations
    run_migrations()        # blocks until DB is at head; raises on failure

The first migration (0001) brings a fresh DB up to the same schema the
old ``init_*_table()`` functions used to produce. Subsequent migrations
record actual schema changes.

Adding a new migration:

    1. Pick the next number (look at versions/ — last file's NNNN + 1).
    2. Create ``versions/NNNN_short_slug.py``:

           revision = "NNNN"
           down_revision = "PREV_NNNN"
           def upgrade(): op.execute("ALTER TABLE ...")
           def downgrade(): pass    # we don't roll back in prod

    3. Bump nothing else — runner.py picks it up by directory scan.

PyInstaller: the `versions/` directory is collected via the spec's
``nexus_server.migrations`` data tree. If you add a migration that
imports anything non-trivial, also add it to hidden imports.
"""
