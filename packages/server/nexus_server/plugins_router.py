"""Plugin management API — catalog, install, enable/disable, audit logs.

Tables are created on first use via _ensure_tables(). The catalog
is shared across users; audit logs and installation prefs are
per-user.
"""

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from nexus_server.auth.routes import get_current_user
from nexus_server.database import get_db_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/plugins", tags=["plugins"])


MANIFEST_FILE = Path(__file__).resolve().parent.parent / "heurion_worker" / "plugin_manifests.json"


def _load_builtin_manifests() -> list[dict[str, Any]]:
    if not MANIFEST_FILE.exists():
        return []
    try:
        with MANIFEST_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("Failed to load built-in plugin manifests: %s", exc)
        return []


def _migrate_plugin_catalog(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(plugin_catalog)").fetchall()}
    for col, col_type, default in [
        ("category", "TEXT NOT NULL DEFAULT ''", ""),
        ("tags", "TEXT NOT NULL DEFAULT '[]'", "'[]'"),
        ("runtime_type", "TEXT NOT NULL DEFAULT 'container'", "'container'"),
        ("manifest", "TEXT NOT NULL DEFAULT '{}'", "'{}'"),
        ("source", "TEXT NOT NULL DEFAULT 'community'", "'community'"),
        ("created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"),
    ]:
        if col not in existing:
            try:
                conn.execute(f"ALTER TABLE plugin_catalog ADD COLUMN {col} {col_type}")
            except sqlite3.OperationalError:
                pass


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
    _migrate_plugin_catalog(conn)
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


def _catalog_installed_plugins(conn: sqlite3.Connection, user_id: str) -> set[str]:
    return {
        row["plugin_id"]
        for row in conn.execute(
            "SELECT plugin_id FROM plugin_installations WHERE user_id = ?", (user_id,)
        ).fetchall()
    }


def _build_catalog_entry(manifest: dict[str, Any], installed_set: set[str] | None = None) -> dict[str, Any]:
    p = manifest.get("plugin", {})
    runtime = manifest.get("runtime", {})
    tags = p.get("tags", [])
    return {
        "id": p.get("id", ""),
        "name": p.get("name", ""),
        "version": p.get("version", ""),
        "description": p.get("description", ""),
        "category": p.get("category", ""),
        "author": p.get("author", {"name": ""}) if isinstance(p.get("author"), dict) else {"name": str(p.get("author", ""))},
        "tags": tags if isinstance(tags, list) else [],
        "runtime": runtime.get("type", "container"),
        "source": manifest.get("source", "official"),
        "installed": installed_set is not None and p.get("id", "") in installed_set,
    }


def _validate_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        errors.append("Manifest must be a JSON object")
        return errors
    if manifest.get("manifest_version") != "1.0.0":
        errors.append("manifest_version must be '1.0.0'")
    plugin = manifest.get("plugin")
    if not isinstance(plugin, dict):
        errors.append("manifest.plugin is required")
        return errors
    if not plugin.get("id"):
        errors.append("manifest.plugin.id is required")
    if not plugin.get("name"):
        errors.append("manifest.plugin.name is required")
    if not plugin.get("version"):
        errors.append("manifest.plugin.version is required")
    return errors


# ──────────────────────────────────────────────
#  Catalog
# ──────────────────────────────────────────────


@router.get("/catalog")
async def list_plugin_catalog(
    query: str | None = None,
    source: str | None = None,
    current_user: str = Depends(get_current_user),
):
    """List available plugins (built-in + community from DB)."""
    manifests = _load_builtin_manifests()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        installed_set = _catalog_installed_plugins(conn, current_user)
        rows = conn.execute("SELECT * FROM plugin_catalog").fetchall()

    results = [_build_catalog_entry(m, installed_set) for m in manifests]

    for r in rows:
        if r["plugin_id"] in {e["id"] for e in results}:
            continue
        tags = json.loads(r["tags"]) if isinstance(r["tags"], str) else (r["tags"] or [])
        results.append({
            "id": r["plugin_id"],
            "name": r["name"],
            "version": r["version"],
            "description": r["description"],
            "category": r["category"],
            "author": {"name": r["author"]},
            "tags": tags if isinstance(tags, list) else [],
            "runtime": r["runtime_type"],
            "source": r["source"],
            "installed": r["plugin_id"] in installed_set,
        })

    if source:
        results = [r for r in results if r["source"] == source]
    if query:
        q = query.lower()
        results = [
            r for r in results
            if q in r["name"].lower()
            or q in r["description"].lower()
            or q in r["id"].lower()
            or any(q in t.lower() for t in r["tags"])
        ]

    return {"plugins": results}


@router.get("/catalog/{plugin_id:path}")
async def get_plugin_catalog_item(
    plugin_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get a single catalog plugin with full manifest."""
    manifests = _load_builtin_manifests()
    for m in manifests:
        if m.get("plugin", {}).get("id") == plugin_id:
            with get_db_connection() as conn:
                _ensure_tables(conn)
                installed_set = _catalog_installed_plugins(conn, current_user)
            entry = _build_catalog_entry(m, installed_set)
            entry["manifest"] = m
            entry["enabled"] = entry["installed"]
            return entry
    with get_db_connection() as conn:
        _ensure_tables(conn)
        row = conn.execute(
            "SELECT * FROM plugin_catalog WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Plugin not found in catalog")
        installed_set = _catalog_installed_plugins(conn, current_user)
        manifest = json.loads(row["manifest"]) if row["manifest"] else {}
        tags = json.loads(row["tags"]) if isinstance(row["tags"], str) else (row["tags"] or [])
    installed = plugin_id in installed_set
    return {
        "id": row["plugin_id"],
        "name": row["name"],
        "version": row["version"],
        "description": row["description"],
        "category": row["category"],
        "author": {"name": row["author"]},
        "tags": tags if isinstance(tags, list) else [],
        "runtime": row["runtime_type"],
        "source": row["source"],
        "installed": installed,
        "enabled": installed,
        "manifest": manifest,
    }


# ──────────────────────────────────────────────
#  Install / Uninstall / Enable / Disable
# ──────────────────────────────────────────────


class InstallRequest(BaseModel):
    pluginId: str
    version: str | None = None


@router.post("/install")
async def install_plugin(
    body: InstallRequest,
    current_user: str = Depends(get_current_user),
):
    """Install a plugin for the current user."""
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        existing = conn.execute(
            "SELECT * FROM plugin_installations WHERE user_id = ? AND plugin_id = ?",
            (current_user, body.pluginId),
        ).fetchone()
        if existing:
            return {
                "pluginId": body.pluginId,
                "name": existing["plugin_id"],
                "version": existing["version"] or body.version or "",
                "description": "",
                "author": "",
                "enabled": bool(existing["enabled"]),
                "installedAt": existing["installed_at"],
            }
        conn.execute(
            "INSERT INTO plugin_installations (user_id, plugin_id, version, enabled, config, installed_at, updated_at) "
            "VALUES (?, ?, ?, 1, '{}', ?, ?)",
            (current_user, body.pluginId, body.version or "", now, now),
        )
        conn.commit()
    return {
        "pluginId": body.pluginId,
        "name": body.pluginId,
        "version": body.version or "",
        "description": "",
        "author": "",
        "enabled": True,
        "installedAt": now,
    }


@router.delete("/{plugin_id:path}")
async def uninstall_plugin(
    plugin_id: str,
    current_user: str = Depends(get_current_user),
):
    """Uninstall a plugin."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "DELETE FROM plugin_installations WHERE user_id = ? AND plugin_id = ?",
            (current_user, plugin_id),
        )
        conn.commit()
    return {"uninstalled": True}


@router.post("/{plugin_id:path}/enable")
async def enable_plugin(
    plugin_id: str,
    current_user: str = Depends(get_current_user),
):
    """Enable a plugin."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "UPDATE plugin_installations SET enabled = 1, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
            (datetime.now(timezone.utc).isoformat(), current_user, plugin_id),
        )
        conn.commit()
    return {"enabled": True}


@router.post("/{plugin_id:path}/disable")
async def disable_plugin(
    plugin_id: str,
    current_user: str = Depends(get_current_user),
):
    """Disable a plugin."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "UPDATE plugin_installations SET enabled = 0, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
            (datetime.now(timezone.utc).isoformat(), current_user, plugin_id),
        )
        conn.commit()
    return {"enabled": False}


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


@router.get("/installed-ui")
async def list_installed_ui_plugins(current_user: str = Depends(get_current_user)):
    """Return installed plugins that have UI extensions."""
    with get_db_connection() as conn:
        _ensure_tables(conn)
        rows = conn.execute(
            "SELECT pi.*, pc.ui FROM plugin_installations pi "
            "LEFT JOIN plugin_catalog pc ON pc.plugin_id = pi.plugin_id "
            "WHERE pi.user_id = ? AND pc.ui IS NOT NULL AND pc.ui != '' "
            "ORDER BY pi.installed_at DESC",
            (current_user,),
        ).fetchall()
    plugins = []
    for r in rows:
        ui = json.loads(r["ui"]) if isinstance(r.get("ui"), str) else r.get("ui")
        if not ui:
            continue
        plugins.append({
            "pluginId": r["plugin_id"],
            "name": r["plugin_id"],
            "ui": ui if isinstance(ui, dict) else {},
        })
    return {"plugins": plugins}


# ──────────────────────────────────────────────
#  Settings
# ──────────────────────────────────────────────


@router.get("/{plugin_id:path}/settings")
async def get_plugin_settings(
    plugin_id: str,
    current_user: str = Depends(get_current_user),
):
    """Return plugin settings schema + current values."""
    manifests = _load_builtin_manifests()
    schema: dict[str, Any] = {}
    for m in manifests:
        if m.get("plugin", {}).get("id") == plugin_id:
            tools = m.get("tools", [])
            schema = {
                "type": "object",
                "properties": {t["name"]: t.get("parameters", {}) for t in tools if isinstance(t, dict)},
            }
            break
    with get_db_connection() as conn:
        _ensure_tables(conn)
        row = conn.execute(
            "SELECT config FROM plugin_installations WHERE user_id = ? AND plugin_id = ?",
            (current_user, plugin_id),
        ).fetchone()
    values = json.loads(row["config"]) if row and row["config"] else {}
    return {"schema": schema, "values": values}


class SaveSettingsRequest(BaseModel):
    values: dict[str, Any] = {}


@router.put("/{plugin_id:path}/settings")
async def save_plugin_settings(
    plugin_id: str,
    body: SaveSettingsRequest,
    current_user: str = Depends(get_current_user),
):
    """Save plugin settings."""
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "UPDATE plugin_installations SET config = ?, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
            (json.dumps(body.values), now, current_user, plugin_id),
        )
        conn.commit()
    return {"saved": True}


# ──────────────────────────────────────────────
#  Audit logs
# ──────────────────────────────────────────────


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


# ──────────────────────────────────────────────
#  Manifest validation & community install
# ──────────────────────────────────────────────


@router.post("/validate-manifest")
async def validate_manifest_endpoint(manifest: dict[str, Any]):
    """Validate a plugin manifest JSON structure."""
    errors = _validate_manifest(manifest)
    return {"valid": len(errors) == 0, "errors": errors}


class InstallFromUrlRequest(BaseModel):
    url: str


@router.post("/install-from-url")
async def install_plugin_from_url(
    body: InstallFromUrlRequest,
    current_user: str = Depends(get_current_user),
):
    """Fetch a manifest from a URL, validate it, and add to catalog."""
    if not body.url:
        return {"valid": False, "error": "url is required"}
    import urllib.request
    try:
        req = urllib.request.Request(body.url, headers={"User-Agent": "HeurionPlugin/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            manifest = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"valid": False, "error": f"Failed to fetch manifest: {exc}"}
    errors = _validate_manifest(manifest)
    if errors:
        return {"valid": False, "errors": errors}
    plugin_id = manifest["plugin"]["id"]
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        existing = conn.execute(
            "SELECT plugin_id FROM plugin_catalog WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not existing:
            p = manifest["plugin"]
            tags = p.get("tags", [])
            runtime = manifest.get("runtime", {})
            conn.execute(
                "INSERT INTO plugin_catalog (plugin_id, name, description, author, version, category, tags, runtime_type, manifest, source, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'community', ?)",
                (
                    plugin_id,
                    p.get("name", ""),
                    p.get("description", ""),
                    p.get("author", {}).get("name", "") if isinstance(p.get("author"), dict) else str(p.get("author"), ""),
                    p.get("version", ""),
                    p.get("category", ""),
                    json.dumps(tags if isinstance(tags, list) else []),
                    runtime.get("type", "container"),
                    json.dumps(manifest),
                    now,
                ),
            )
            conn.commit()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "INSERT OR REPLACE INTO plugin_installations (user_id, plugin_id, version, enabled, config, installed_at, updated_at) "
            "VALUES (?, ?, ?, 1, '{}', ?, ?)",
            (current_user, plugin_id, manifest["plugin"].get("version", ""), now, now),
        )
        conn.commit()
    return {"valid": True, "pluginId": plugin_id, "installed": {}}


@router.post("/install-upload")
async def install_plugin_upload(
    manifest: UploadFile = File(...),
    current_user: str = Depends(get_current_user),
):
    """Validate an uploaded manifest file and add to catalog."""
    try:
        raw = await manifest.read()
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {"valid": False, "error": f"Failed to parse manifest: {exc}"}
    errors = _validate_manifest(data)
    if errors:
        return {"valid": False, "errors": errors}
    plugin_id = data["plugin"]["id"]
    now = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        existing = conn.execute(
            "SELECT plugin_id FROM plugin_catalog WHERE plugin_id = ?", (plugin_id,)
        ).fetchone()
        if not existing:
            p = data["plugin"]
            tags = p.get("tags", [])
            runtime = data.get("runtime", {})
            conn.execute(
                "INSERT INTO plugin_catalog (plugin_id, name, description, author, version, category, tags, runtime_type, manifest, source, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'community', ?)",
                (
                    plugin_id,
                    p.get("name", ""),
                    p.get("description", ""),
                    p.get("author", {}).get("name", "") if isinstance(p.get("author"), dict) else str(p.get("author", "")),
                    p.get("version", ""),
                    p.get("category", ""),
                    json.dumps(tags if isinstance(tags, list) else []),
                    runtime.get("type", "container"),
                    json.dumps(data),
                    now,
                ),
            )
            conn.commit()
    with get_db_connection() as conn:
        _ensure_tables(conn)
        conn.execute(
            "INSERT OR REPLACE INTO plugin_installations (user_id, plugin_id, version, enabled, config, installed_at, updated_at) "
            "VALUES (?, ?, ?, 1, '{}', ?, ?)",
            (current_user, plugin_id, data["plugin"].get("version", ""), now, now),
        )
        conn.commit()
    return {"valid": True, "pluginId": plugin_id, "installed": {}}
