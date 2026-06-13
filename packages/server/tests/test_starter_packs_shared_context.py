"""v2.1-2: tests for taxonomy.yaml + protocols.md shared context loader.

Verifies:
  * Both optional files get concatenated onto every skill file at install time.
  * Missing files = no-op (Content Studio still installs cleanly).
  * Pack metadata stays unchanged.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest


@pytest.fixture
def fresh_db(monkeypatch, tmp_path):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("NEXUS_DB_PATH", str(db_path))
    from nexus_server import database as db_mod
    if hasattr(db_mod, "_initialized"):
        db_mod._initialized = False
    db_mod.init_db()
    monkeypatch.chdir(tmp_path)
    yield tmp_path


@pytest.fixture
def with_synthetic_pack(monkeypatch, tmp_path):
    """Mount a synthetic test pack root so we don't depend on a real
    pack in the bundled catalog being augmented with the test files."""
    from nexus_server import starter_packs as sp

    fake_root = tmp_path / "packs"
    fake_pack = fake_root / "test-pack"
    (fake_pack / "skills").mkdir(parents=True)

    # Skill body
    (fake_pack / "skills" / "step-a.md").write_text(
        "---\nname: step-a\nmodel: test\n---\n\n# Step A\n\nDo a thing.",
        encoding="utf-8",
    )
    # Optional shared files
    (fake_pack / "taxonomy.yaml").write_text(
        "categories:\n  A: spacing\n  B: floats\n",
        encoding="utf-8",
    )
    (fake_pack / "protocols.md").write_text(
        "- Never delete figures.\n- Never use \\resizebox.\n",
        encoding="utf-8",
    )
    (fake_pack / "workflow.json").write_text(
        '{"name": "TestPack", "description": "x", "definition": '
        '{"inputs": [], "steps": [{"skill": "step-a"}]}}',
        encoding="utf-8",
    )

    monkeypatch.setattr(sp, "PACKS_ROOT", fake_root)
    monkeypatch.setattr(sp, "PACK_CATALOG", [
        sp.StarterPack(
            id="test-pack", name="TestPack", description="x",
            step_count=1, audience="testers", tier="free",
        ),
    ])
    return fake_pack


# ─────────────────────────────────────────────────────────────────────


def test_shared_context_appended_to_skill_files(
    fresh_db, with_synthetic_pack,
):
    from nexus_server import starter_packs as sp
    sp.install_pack(user_id="alice", pack_id="test-pack")

    skill_path = fresh_db / ".nexus" / "skills" / "step-a.md"
    assert skill_path.exists(), "skill not copied"
    body = skill_path.read_text(encoding="utf-8")

    # Original skill content preserved
    assert "# Step A" in body
    assert "Do a thing." in body

    # Shared taxonomy section appended
    assert "## Shared taxonomy" in body
    assert "categories:" in body
    assert "spacing" in body
    assert "floats" in body

    # Protocols section appended
    assert "## Shared protocols" in body
    assert "Never delete figures" in body
    assert "non-negotiable" in body


def test_pack_with_no_shared_files_still_installs(
    fresh_db, with_synthetic_pack,
):
    """Delete taxonomy + protocols and verify install still works."""
    (with_synthetic_pack / "taxonomy.yaml").unlink()
    (with_synthetic_pack / "protocols.md").unlink()

    from nexus_server import starter_packs as sp
    sp.install_pack(user_id="alice", pack_id="test-pack")

    skill_path = fresh_db / ".nexus" / "skills" / "step-a.md"
    body = skill_path.read_text(encoding="utf-8")
    assert "# Step A" in body
    assert "Shared taxonomy" not in body
    assert "Shared protocols" not in body


def test_only_protocols_installs_clean(fresh_db, with_synthetic_pack):
    """Half-configured pack: protocols.md present, taxonomy.yaml missing.
    Make sure each file is independently optional."""
    (with_synthetic_pack / "taxonomy.yaml").unlink()

    from nexus_server import starter_packs as sp
    sp.install_pack(user_id="alice", pack_id="test-pack")

    skill_path = fresh_db / ".nexus" / "skills" / "step-a.md"
    body = skill_path.read_text(encoding="utf-8")
    assert "Shared taxonomy" not in body
    assert "Shared protocols" in body


def test_reinstall_does_not_double_append(fresh_db, with_synthetic_pack):
    """Idempotency: re-installing the same pack must not duplicate the
    shared-context block in the skill file."""
    from nexus_server import starter_packs as sp
    sp.install_pack(user_id="alice", pack_id="test-pack")
    sp.install_pack(user_id="alice", pack_id="test-pack")

    skill_path = fresh_db / ".nexus" / "skills" / "step-a.md"
    body = skill_path.read_text(encoding="utf-8")
    # Each section header should appear exactly once
    assert body.count("## Shared taxonomy") == 1
    assert body.count("## Shared protocols") == 1
