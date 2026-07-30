"""Plugin management API — installed plugins, audit logs.

Tables are created on first use via _ensure_tables(). The catalog
is shared across users; audit logs and installation prefs are
per-user.
"""

import logging
import sqlite3

from fastapi import APIRouter, Depends

from nexus_server.auth.routes import get_current_user
from nexus_server.database import get_db_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/plugins", tags=["plugins"])


def _ensure_tables(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plugin_catalog (
            plugin_id    TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            author       TEXT NOT NULL DEFAULT '',
            version      TEXT NOT NULL DEFAULT '',
            ui           TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plugin_installations (
            user_id       TEXT NOT NULL,
            plugin_id     TEXT NOT NULL,
            version       TEXT NOT NULL DEFAULT '',
            enabled       INTEGER NOT NULL DEFAULT 1,
            config        TEXT NOT NULL DEFAULT '{}',
            installed_at  TIMESTAMP NOT NULL,
            updated_at    TIMESTAMP NOT NULL,
            PRIMARY KEY (user_id, plugin_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plugin_audit_logs (
            id            TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL,
            plugin_id     TEXT NOT NULL,
            tool_name     TEXT NOT NULL DEFAULT '',
            job_id        TEXT NOT NULL DEFAULT '',
            status        TEXT NOT NULL DEFAULT '',
            duration_ms   INTEGER NOT NULL DEFAULT 0,
            input_summary TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            created_at    TIMESTAMP NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_plugin_audit_user
        ON plugin_audit_logs(user_id, created_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin
        ON plugin_audit_logs(user_id, plugin_id)
    """)
    conn.commit()


@router.get("/installed")
async def list_installed_plugins(current_user: str = Depends(get_current_user)):
    """Return installed plugins for the current user."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        rows = conn.execute(
            "SELECT pi.*, pc.name, pc.description, pc.author, "
            "pc.version AS catalog_version "
            "FROM plugin_installations pi "
            "LEFT JOIN plugin_catalog pc ON pc.plugin_id = pi.plugin_id "
            "WHERE pi.user_id = ? ORDER BY pi.installed_at DESC",
            (current_user,),
        ).fetchall()
    plugins = []
    for r in rows:
        plugins.append({
            "pluginId": r["plugin_id"],
            "name": r["name"] or r["plugin_id"],
            "version": r["version"] or r["catalog_version"] or "",
            "description": r["description"] or "",
            "author": r["author"] or "",
            "enabled": bool(r["enabled"]),
            "installedAt": r["installed_at"],
            "updatedAt": r["updated_at"],
            "config": {},
        })
    return {"plugins": plugins}


@router.get("/audit-logs")
async def list_audit_logs(
    plugin_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    current_user: str = Depends(get_current_user),
):
    """Return plugin audit logs filtered by plugin_id and/or status."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        where = "WHERE user_id = ?"
        params: list = [current_user]
        if plugin_id:
            where += " AND plugin_id = ?"
            params.append(plugin_id)
        if status:
            where += " AND status = ?"
            params.append(status)
        total = conn.execute(
            f"SELECT COUNT(*) FROM plugin_audit_logs {where}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM plugin_audit_logs {where} "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
    logs = []
    for r in rows:
        logs.append({
            "id": r["id"],
            "pluginId": r["plugin_id"],
            "toolName": r["tool_name"],
            "jobId": r["job_id"],
            "status": r["status"],
            "durationMs": r["duration_ms"],
            "inputSummary": r["input_summary"] or None,
            "errorMessage": r["error_message"] or None,
            "createdAt": r["created_at"],
        })
    return {"logs": logs, "total": total}
