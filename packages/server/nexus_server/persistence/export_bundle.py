"""Tier 4 sovereign export bundle (ADR-002 Rev-7 / design v3 §16.4).

Writes a self-contained directory the medic can take to any tool, with
no Nexus code required to read it:

::

    nexus-export-<date>/
    ├── README.md                       human-readable format spec
    ├── MANIFEST.json                   schema versions, counts, SHA-256
    ├── checksums.sha256                sha256sum-compatible
    ├── layer1_patients/<hash>/
    │   ├── graph.json                  nodes + edges
    │   ├── provenance.jsonl            one row per node
    │   ├── summary.md                  human-readable
    │   └── fhir-r5.json                EHR-interop Bundle (lossy)
    ├── layer1_event_log/events.jsonl   full append-only ledger
    ├── layer2_practitioner/
    │   ├── facts.jsonl
    │   └── observations.jsonl
    ├── layer3_reference/versions.json  version pointers only (re-downloadable)
    ├── meta_layer/configs/             snapshot of agent configs (deferred)
    └── _sql_dump.sql                   full sqlite3 .dump

Privacy
=======

Per R20: the export wizard MUST surface PHI-in-transit warning before
calling this function. The bundle itself is PHI-bearing by default;
caller can request age-encrypted output (deferred to D3).
"""

from __future__ import annotations

import hashlib
import json
import logging
import pathlib
import sqlite3
import time
from dataclasses import dataclass

from nexus_server.event_sourcing.schema import SCHEMA_VERSION

logger = logging.getLogger(__name__)


BUNDLE_FORMAT_VERSION = "1.0.0"


@dataclass(frozen=True)
class ExportBundleResult:
    bundle_path: pathlib.Path
    event_count: int
    patient_count: int
    practitioner_fact_count: int
    bundle_sha256: str
    size_bytes: int


def create_export_bundle(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    output_dir: pathlib.Path,
) -> ExportBundleResult:
    """Build a complete sovereign bundle for one medic. Returns a result
    descriptor; caller can then tarball / encrypt / upload as needed.

    All filesystem writes happen under ``output_dir``; the function never
    touches paths outside it.
    """
    output_dir = pathlib.Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Manifest scaffolding
    manifest: dict = {
        "bundle_format_version": BUNDLE_FORMAT_VERSION,
        "schema_version":        SCHEMA_VERSION,
        "exported_at_utc":       int(time.time()),
        "exporter":              "nexus.persistence.export_bundle@1.0",
        "user_id":                user_id,
        "counts":                {},
        "files":                 {},  # filled per write
    }

    # ── README
    readme_text = _README_TEMPLATE.format(
        version=BUNDLE_FORMAT_VERSION,
        schema=SCHEMA_VERSION,
        exported_at=time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    )
    _write(output_dir / "README.md", readme_text, manifest)

    # ── Layer 1: patients
    patient_hashes = [
        r[0] for r in conn.execute(
            "SELECT DISTINCT patient_hash FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash IS NOT NULL "
            "ORDER BY patient_hash",
            (user_id,),
        ).fetchall()
    ]
    for ph in patient_hashes:
        _export_patient(conn, user_id, ph, output_dir, manifest)
    manifest["counts"]["patient_count"] = len(patient_hashes)

    # ── Event log
    event_log_path = output_dir / "layer1_event_log" / "events.jsonl"
    event_count = _export_event_log(conn, user_id, event_log_path, manifest)
    manifest["counts"]["event_count"] = event_count

    # ── Layer 2 practitioner
    pract_count = _export_practitioner(conn, user_id, output_dir, manifest)
    manifest["counts"]["practitioner_fact_count"] = pract_count

    # ── Layer 3 reference (version pointers only)
    _export_reference_versions(conn, output_dir, manifest)

    # ── SQL dump (format-independence fallback)
    _export_sql_dump(conn, output_dir, manifest)

    # ── Manifest + checksums
    manifest_path = output_dir / "MANIFEST.json"
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True)
    manifest_path.write_text(manifest_text, encoding="utf-8")

    checksums_path = output_dir / "checksums.sha256"
    _write_checksums(output_dir, checksums_path)

    bundle_sha256 = _hash_dir(output_dir)
    size_bytes = sum(
        f.stat().st_size for f in output_dir.rglob("*") if f.is_file()
    )

    logger.info(
        "export_bundle: user=%s output=%s patients=%d events=%d "
        "facts=%d sha=%s",
        user_id, output_dir, len(patient_hashes), event_count,
        pract_count, bundle_sha256[:12],
    )
    return ExportBundleResult(
        bundle_path=output_dir,
        event_count=event_count,
        patient_count=len(patient_hashes),
        practitioner_fact_count=pract_count,
        bundle_sha256=bundle_sha256,
        size_bytes=size_bytes,
    )


# ─────────────────────────────────────────────────────────────────────
# Per-section exporters
# ─────────────────────────────────────────────────────────────────────

def _export_patient(
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: str,
    output_dir: pathlib.Path,
    manifest: dict,
) -> None:
    pdir = output_dir / "layer1_patients" / patient_hash
    pdir.mkdir(parents=True, exist_ok=True)

    # graph.json
    nodes = [
        _row_to_dict(r, ("node_id", "node_type", "content_json",
                         "embedding_ref", "weight", "encounter_id",
                         "created_at", "updated_at", "originating_event_idx"))
        for r in conn.execute(
            "SELECT node_id, node_type, content_json, embedding_ref, weight, "
            "       encounter_id, created_at, updated_at, originating_event_idx "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? "
            "ORDER BY node_id",
            (user_id, patient_hash),
        )
    ]
    edges = [
        _row_to_dict(r, ("src_node", "dst_node", "kind", "weight",
                         "created_at", "originating_event_idx"))
        for r in conn.execute(
            "SELECT src_node, dst_node, kind, weight, created_at, "
            "       originating_event_idx "
            "FROM clinical_graph_edges "
            "WHERE user_id = ? AND patient_hash = ? "
            "ORDER BY src_node, dst_node, kind",
            (user_id, patient_hash),
        )
    ]
    # Inline-decode content_json for human readability
    for n in nodes:
        try:
            n["content"] = json.loads(n.pop("content_json"))
        except (json.JSONDecodeError, KeyError) as e:
            logger.debug("decoding node content_json failed: %s", e)

    graph = {
        "_meta": {
            "schema": "nexus.layer1.graph",
            "version": SCHEMA_VERSION,
            "patient_hash": patient_hash,
        },
        "nodes": nodes,
        "edges": edges,
    }
    _write(pdir / "graph.json", json.dumps(graph, indent=2), manifest)

    # provenance.jsonl
    prov_path = pdir / "provenance.jsonl"
    with prov_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({
            "_meta": {"schema": "nexus.layer1.provenance", "version": SCHEMA_VERSION}
        }) + "\n")
        for r in conn.execute(
            "SELECT node_id, source_kind, source_ref, source_locator_json, "
            "       evidence_quote, extracted_by_user, extracted_at, "
            "       extraction_model, extraction_prompt_id, confidence, "
            "       redaction_version, superseded_by_node, retracted_at, "
            "       retracted_by_user, retracted_reason "
            "FROM node_provenance "
            "WHERE user_id = ? AND patient_hash = ? "
            "ORDER BY node_id",
            (user_id, patient_hash),
        ):
            row_dict = _row_to_dict(r, (
                "node_id", "source_kind", "source_ref", "source_locator",
                "evidence_quote", "extracted_by_user", "extracted_at",
                "extraction_model", "extraction_prompt_id", "confidence",
                "redaction_version", "superseded_by_node", "retracted_at",
                "retracted_by_user", "retracted_reason",
            ))
            if isinstance(row_dict["source_locator"], str):
                try:
                    row_dict["source_locator"] = json.loads(row_dict["source_locator"])
                except json.JSONDecodeError as e:
                    logger.debug("decoding source_locator failed: %s", e)
            f.write(json.dumps(row_dict, ensure_ascii=False) + "\n")
    _record_file(prov_path, manifest)

    # summary.md
    _write(pdir / "summary.md", _make_patient_summary(patient_hash, nodes), manifest)

    # fhir-r5.json (lossy; minimum-viable Bundle)
    fhir = _to_fhir_bundle(patient_hash, nodes)
    _write(pdir / "fhir-r5.json", json.dumps(fhir, indent=2), manifest)


def _export_event_log(
    conn: sqlite3.Connection,
    user_id: str,
    out_path: pathlib.Path,
    manifest: dict,
) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({
            "_meta": {
                "schema": "nexus.event_log",
                "version": SCHEMA_VERSION,
                "exported_at": int(time.time()),
                "field_defs_url": "https://docs.nexus.dev/schema/v3.1",
            }
        }) + "\n")
        for row in conn.execute(
            "SELECT event_idx, event_kind, event_kind_version, user_id, "
            "       patient_hash, ts, payload_json, caused_by "
            "FROM twin_event_log "
            "WHERE user_id = ? "
            "ORDER BY event_idx",
            (user_id,),
        ):
            event = _row_to_dict(row, (
                "event_idx", "event_kind", "event_kind_version", "user_id",
                "patient_hash", "ts", "payload", "caused_by",
            ))
            if isinstance(event["payload"], str):
                try:
                    event["payload"] = json.loads(event["payload"])
                except json.JSONDecodeError as e:
                    logger.debug("decoding event payload failed: %s", e)
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
            count += 1
    _record_file(out_path, manifest)
    return count


def _export_practitioner(
    conn: sqlite3.Connection,
    user_id: str,
    output_dir: pathlib.Path,
    manifest: dict,
) -> int:
    pdir = output_dir / "layer2_practitioner"
    pdir.mkdir(parents=True, exist_ok=True)

    facts_path = pdir / "facts.jsonl"
    fact_count = 0
    with facts_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({
            "_meta": {"schema": "nexus.layer2.practitioner_facts", "version": SCHEMA_VERSION}
        }) + "\n")
        for r in conn.execute(
            "SELECT fact_kind, pattern_key, pattern_value_json, observed_count, "
            "       distinct_patient_count, confidence, first_observed_at, "
            "       last_reinforced_at, medic_confirmed_at, medic_rejected_at, "
            "       extraction_model, extraction_prompt_id "
            "FROM practitioner_facts WHERE user_id = ?",
            (user_id,),
        ):
            row_dict = _row_to_dict(r, (
                "fact_kind", "pattern_key", "pattern_value", "observed_count",
                "distinct_patient_count", "confidence", "first_observed_at",
                "last_reinforced_at", "medic_confirmed_at", "medic_rejected_at",
                "extraction_model", "extraction_prompt_id",
            ))
            if isinstance(row_dict["pattern_value"], str):
                try:
                    row_dict["pattern_value"] = json.loads(row_dict["pattern_value"])
                except json.JSONDecodeError as e:
                    logger.debug("decoding pattern_value failed: %s", e)
            f.write(json.dumps(row_dict, ensure_ascii=False) + "\n")
            fact_count += 1
    _record_file(facts_path, manifest)

    obs_path = pdir / "observations.jsonl"
    with obs_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({
            "_meta": {"schema": "nexus.layer2.practitioner_observations", "version": SCHEMA_VERSION}
        }) + "\n")
        for r in conn.execute(
            "SELECT patient_hash, fact_kind, pattern_key, observed_at, "
            "       source_encounter_id, evidence_quote, extraction_model, "
            "       extraction_prompt_id "
            "FROM practitioner_observations WHERE user_id = ?",
            (user_id,),
        ):
            row_dict = _row_to_dict(r, (
                "patient_hash", "fact_kind", "pattern_key", "observed_at",
                "source_encounter_id", "evidence_quote", "extraction_model",
                "extraction_prompt_id",
            ))
            f.write(json.dumps(row_dict, ensure_ascii=False) + "\n")
    _record_file(obs_path, manifest)
    return fact_count


def _export_reference_versions(
    conn: sqlite3.Connection,
    output_dir: pathlib.Path,
    manifest: dict,
) -> None:
    versions = [
        {"kind": k, "key": key, "version": v}
        for (k, key, v) in conn.execute(
            "SELECT kind, key, version FROM reference_knowledge ORDER BY kind, key"
        )
    ]
    out_path = output_dir / "layer3_reference" / "versions.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _write(out_path, json.dumps({
        "_meta": {"schema": "nexus.layer3.reference_versions", "version": SCHEMA_VERSION},
        "versions": versions,
        "note": "payload not bundled — re-downloadable from authoritative source per Rev-7",
    }, indent=2), manifest)


def _export_sql_dump(
    conn: sqlite3.Connection,
    output_dir: pathlib.Path,
    manifest: dict,
) -> None:
    out_path = output_dir / "_sql_dump.sql"
    with out_path.open("w", encoding="utf-8") as f:
        f.write(
            "-- nexus event-sourcing SQL dump · format-independence fallback\n"
            "-- Read with: sqlite3 my.db < _sql_dump.sql\n"
        )
        for line in conn.iterdump():
            f.write(line + "\n")
    _record_file(out_path, manifest)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _row_to_dict(row, fields: tuple[str, ...]) -> dict:
    return {fields[i]: row[i] for i in range(len(fields))}


def _make_patient_summary(patient_hash: str, nodes: list[dict]) -> str:
    findings = [n for n in nodes if n.get("node_type") == "finding"]
    meds = [n for n in nodes if n.get("node_type") == "med"]
    studies = [n for n in nodes if n.get("node_type") == "study"]
    lines = [f"# Patient {patient_hash[:12]}…", ""]
    if studies:
        lines.append(f"**Studies**: {len(studies)}")
    if findings:
        lines.append(f"**Active findings**: {len(findings)}")
    if meds:
        lines.append(f"**Medications**: {len(meds)}")
    lines.append("")
    if findings:
        lines.append("## Findings\n")
        for n in findings[:30]:
            label = (n.get("content") or {}).get("label", "(unlabeled)")
            lines.append(f"- {label}")
    return "\n".join(lines) + "\n"


def _to_fhir_bundle(patient_hash: str, nodes: list[dict]) -> dict:
    """Lossy FHIR R5 representation. Best-effort; production version
    would use ``fhir.resources`` for spec validation."""
    entries: list[dict] = [{
        "resource": {
            "resourceType": "Patient",
            "id": patient_hash,
            "active": True,
            "meta": {"profile": ["nexus.layer1.patient"]},
        }
    }]
    for n in nodes:
        if n.get("node_type") == "finding":
            entries.append({
                "resource": {
                    "resourceType": "Condition",
                    "id": str(n["node_id"]),
                    "subject": {"reference": f"Patient/{patient_hash}"},
                    "code": {"text": (n.get("content") or {}).get("label", "")},
                }
            })
        elif n.get("node_type") == "med":
            entries.append({
                "resource": {
                    "resourceType": "MedicationStatement",
                    "id": str(n["node_id"]),
                    "subject": {"reference": f"Patient/{patient_hash}"},
                    "medication": {"concept": {"text": (n.get("content") or {}).get("label", "")}},
                }
            })
        elif n.get("node_type") == "study":
            entries.append({
                "resource": {
                    "resourceType": "ImagingStudy",
                    "id": str(n["node_id"]),
                    "subject": {"reference": f"Patient/{patient_hash}"},
                    "modality": [{"code": (n.get("content") or {}).get("modality", "")}],
                }
            })
    return {
        "resourceType": "Bundle",
        "type": "collection",
        "id": f"nexus-export-{patient_hash}",
        "entry": entries,
    }


def _write(path: pathlib.Path, content: str, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    _record_file(path, manifest)


def _record_file(path: pathlib.Path, manifest: dict) -> None:
    bundle_root = _find_bundle_root(path, manifest)
    rel = path.relative_to(bundle_root).as_posix()
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest["files"][rel] = {"sha256": sha, "size": path.stat().st_size}


def _find_bundle_root(path: pathlib.Path, manifest: dict) -> pathlib.Path:
    # Walk up until parent has README.md or manifest is the marker
    for ancestor in path.parents:
        if (ancestor / "README.md").exists():
            return ancestor
    return path.parent


def _write_checksums(bundle_root: pathlib.Path, out_path: pathlib.Path) -> None:
    with out_path.open("w", encoding="utf-8") as f:
        for p in sorted(bundle_root.rglob("*")):
            if not p.is_file() or p == out_path:
                continue
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            rel = p.relative_to(bundle_root).as_posix()
            f.write(f"{sha}  {rel}\n")


def _hash_dir(bundle_root: pathlib.Path) -> str:
    h = hashlib.sha256()
    for p in sorted(bundle_root.rglob("*")):
        if not p.is_file():
            continue
        h.update(p.relative_to(bundle_root).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()


_README_TEMPLATE = """\
# Nexus Sovereign Export Bundle

Bundle format version: {version}
Memory schema version: {schema}
Exported at: {exported_at}

## What's in this bundle

Per ADR-002 Rev-7 (the data-sovereignty contract): this directory is
**self-contained**. No Nexus code is required to read it. Standard
JSON / JSONL / Markdown tooling works on every file.

### Top-level layout

* `MANIFEST.json` — schema versions, file inventory, per-file SHA-256.
* `checksums.sha256` — sha256sum-compatible integrity manifest.
* `layer1_patients/<hash>/` — one directory per patient:
  * `graph.json` — Layer 1 graph nodes + edges
  * `provenance.jsonl` — one row per clinical-fact node
  * `summary.md` — human-readable patient summary
  * `fhir-r5.json` — FHIR R5 Bundle for EHR interop (lossy)
* `layer1_event_log/events.jsonl` — append-only event log (the canonical
  source of truth per Rev-8; all other files are projections)
* `layer2_practitioner/` — your learned practice patterns (PHI-stripped)
  * `facts.jsonl` — active facts
  * `observations.jsonl` — raw observations (with patient_hash for audit)
* `layer3_reference/versions.json` — which reference KB versions were
  in use (payload not bundled — re-downloadable from authoritative
  sources like RxNorm / RadLex / ACR-AC)
* `meta_layer/` — versioned prompts + configs (deferred to D2 finalisation)
* `_sql_dump.sql` — format-independence fallback. `sqlite3 < _sql_dump.sql`
  reconstitutes the database in any standard sqlite3.

## Your data is yours

Per Contract A: Nexus going away does not take your records. This bundle
is open, documented, and self-describing. Any competent engineer with
no prior Nexus context can reconstruct what these records contained.

## Re-importing

The complementary `import_bundle` tool (D2) reads this directory back
into a fresh Nexus installation. The schema version pinned above is the
key — newer Nexus versions auto-migrate on import per the additive
schema-evolution invariant.
"""
