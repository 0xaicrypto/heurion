"""Tests for the plugin management API.

Covers:
  * GET /api/v1/plugins/catalog — returns built-in manifests
  * GET /api/v1/plugins/installed — empty before install
  * POST /api/v1/plugins/install — install a plugin
  * POST /api/v1/plugins/{id}/enable / disable — toggle
  * DELETE /api/v1/plugins/{id} — uninstall
  * GET /api/v1/plugins/catalog/{id} — single catalog item
  * POST /api/v1/plugins/validate-manifest — validation
  * POST /api/v1/plugins/install-upload — file upload install
  * GET /api/v1/plugins/audit-logs — audit trail
  * GET /api/v1/plugins/{id}/settings / PUT — settings CRUD
  * GET /api/v1/plugins/installed-ui — UI extension list
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

PW = "Plug1n-Test-!"


def _register(client, name):
    r = client.post("/api/v1/auth/register",
                    json={"username": name, "password": PW})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(user):
    return {"Authorization": f"Bearer {user['jwt_token']}"}


class TestPluginCatalog:

    def test_catalog_returns_builtin_plugins(self, client):
        user = _register(client, "catalog-test")
        r = client.get("/api/v1/plugins/catalog", headers=_auth(user))
        assert r.status_code == 200, r.text
        data = r.json()
        assert "plugins" in data
        ids = {p["id"] for p in data["plugins"]}
        assert "heurion/docx" in ids
        assert "heurion/pptx" in ids
        assert "heurion/pdf" in ids
        assert all(p["source"] == "official" for p in data["plugins"])
        assert all(not p["installed"] for p in data["plugins"])

    def test_catalog_query_filter(self, client):
        user = _register(client, "catalog-query")
        r = client.get("/api/v1/plugins/catalog?query=pdf", headers=_auth(user))
        assert r.status_code == 200
        ids = {p["id"] for p in r.json()["plugins"]}
        assert "heurion/pdf" in ids
        assert "heurion/docx" not in ids

    def test_catalog_source_filter(self, client):
        user = _register(client, "catalog-source")
        r = client.get("/api/v1/plugins/catalog?source=official", headers=_auth(user))
        assert r.status_code == 200
        ids = {p["id"] for p in r.json()["plugins"]}
        assert len(ids) == 5  # all 5 built-in plugins

    def test_catalog_item_detail(self, client):
        user = _register(client, "catalog-item")
        r = client.get("/api/v1/plugins/catalog/heurion%2Fdocx", headers=_auth(user))
        assert r.status_code == 200, r.text
        assert r.json()["id"] == "heurion/docx"
        assert "manifest" in r.json()

    def test_catalog_item_404(self, client):
        user = _register(client, "catalog-404")
        r = client.get("/api/v1/plugins/catalog/nonexistent", headers=_auth(user))
        assert r.status_code == 404


class TestPluginLifecycle:

    def test_install_and_list_installed(self, client):
        user = _register(client, "lifecycle-install")
        r = client.post("/api/v1/plugins/install", json={"pluginId": "heurion/docx"},
                        headers=_auth(user))
        assert r.status_code == 200, r.text
        assert r.json()["pluginId"] == "heurion/docx"
        assert r.json()["enabled"] is True

        r = client.get("/api/v1/plugins/installed", headers=_auth(user))
        assert r.status_code == 200
        ids = [p["pluginId"] for p in r.json()["plugins"]]
        assert "heurion/docx" in ids

    def test_enable_disable(self, client):
        user = _register(client, "lifecycle-toggle")
        client.post("/api/v1/plugins/install", json={"pluginId": "heurion/docx"},
                    headers=_auth(user))

        r = client.post("/api/v1/plugins/heurion%2Fdocx/disable", headers=_auth(user))
        assert r.status_code == 200
        assert r.json()["enabled"] is False

        r = client.post("/api/v1/plugins/heurion%2Fdocx/enable", headers=_auth(user))
        assert r.status_code == 200
        assert r.json()["enabled"] is True

    def test_uninstall(self, client):
        user = _register(client, "lifecycle-uninstall")
        client.post("/api/v1/plugins/install", json={"pluginId": "heurion/docx"},
                    headers=_auth(user))
        r = client.delete("/api/v1/plugins/heurion%2Fdocx", headers=_auth(user))
        assert r.status_code == 200
        assert r.json()["uninstalled"] is True

        r = client.get("/api/v1/plugins/installed", headers=_auth(user))
        assert "heurion/docx" not in {p["pluginId"] for p in r.json()["plugins"]}

    def test_catalog_shows_installed(self, client):
        user = _register(client, "lifecycle-catalog-installed")
        client.post("/api/v1/plugins/install", json={"pluginId": "heurion/docx"},
                    headers=_auth(user))
        r = client.get("/api/v1/plugins/catalog", headers=_auth(user))
        plugins = {p["id"]: p["installed"] for p in r.json()["plugins"]}
        assert plugins["heurion/docx"] is True
        assert plugins["heurion/pptx"] is False


class TestManifestValidation:

    def test_valid_manifest(self, client):
        payload = {
            "manifest_version": "1.0.0",
            "plugin": {"id": "test/foo", "name": "Foo", "version": "1.0.0"},
            "runtime": {"type": "container"},
        }
        r = client.post("/api/v1/plugins/validate-manifest", json=payload)
        assert r.status_code == 200
        assert r.json()["valid"] is True

    def test_invalid_manifest(self, client):
        payload = {"manifest_version": "0.9.0", "plugin": {}}
        r = client.post("/api/v1/plugins/validate-manifest", json=payload)
        assert r.status_code == 200
        assert r.json()["valid"] is False
        assert len(r.json()["errors"]) >= 3

    def test_install_upload(self, client):
        user = _register(client, "manifest-upload")
        manifest = {
            "manifest_version": "1.0.0",
            "plugin": {"id": "test/uploaded", "name": "Uploaded", "version": "0.1.0"},
            "runtime": {"type": "container"},
        }
        r = client.post(
            "/api/v1/plugins/install-upload",
            files={"manifest": ("manifest.json", json.dumps(manifest), "application/json")},
            headers=_auth(user),
        )
        assert r.status_code == 200, r.text
        assert r.json()["valid"] is True
        assert r.json()["pluginId"] == "test/uploaded"

        # should show up in catalog
        r = client.get("/api/v1/plugins/catalog", headers=_auth(user))
        ids = {p["id"] for p in r.json()["plugins"]}
        assert "test/uploaded" in ids


class TestPluginSettings:

    def test_settings_round_trip(self, client):
        user = _register(client, "settings-test")
        client.post("/api/v1/plugins/install", json={"pluginId": "heurion/docx"},
                    headers=_auth(user))
        r = client.get("/api/v1/plugins/heurion%2Fdocx/settings", headers=_auth(user))
        assert r.status_code == 200
        assert "schema" in r.json()
        assert "values" in r.json()

        r = client.put("/api/v1/plugins/heurion%2Fdocx/settings",
                       json={"values": {"lang": "zh"}}, headers=_auth(user))
        assert r.status_code == 200
        assert r.json()["saved"] is True

        r = client.get("/api/v1/plugins/heurion%2Fdocx/settings", headers=_auth(user))
        assert r.json()["values"].get("lang") == "zh"


class TestInstalledUI:

    def test_installed_ui_empty(self, client):
        user = _register(client, "ui-empty")
        r = client.get("/api/v1/plugins/installed-ui", headers=_auth(user))
        assert r.status_code == 200
        assert r.json()["plugins"] == []
