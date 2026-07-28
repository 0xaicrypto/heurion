"""Plugin execution runner.

Supports two backends:
- local: run the handler function in-process (dev / test fallback)
- docker: run the plugin container image (production)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("heurion-worker.plugin_runner")

# Backwards-compatible mapping from old job types to new plugin job types.
OLD_TYPE_MAP = {
    "sidecar.generate_docx": "sidecar.heurion/docx.generate_docx",
    "sidecar.generate_pptx": "sidecar.heurion/pptx.generate_pptx",
    "sidecar.render_table": "sidecar.heurion/table.render_table",
    "sidecar.render_plot": "sidecar.heurion/plot.render_plot",
    "sidecar.convert_to_pdf": "sidecar.heurion/pdf.convert_to_pdf",
}

RUNNER_BACKEND = os.environ.get("PLUGIN_RUNNER", "auto").lower()

try:
    import docker as docker_sdk
except Exception:  # pragma: no cover - docker SDK is optional in local dev
    docker_sdk = None


def _load_manifests() -> dict[str, dict[str, Any]]:
    manifest_path = Path(__file__).with_name("plugin_manifests.json")
    if not manifest_path.exists():
        return {}
    with manifest_path.open("r", encoding="utf-8") as f:
        manifests = json.load(f)
    return {m["plugin"]["id"]: m for m in manifests}


MANIFESTS = _load_manifests()


def _resolve_job_type(job_type: str) -> str:
    return OLD_TYPE_MAP.get(job_type, job_type)


def _parse_job_type(job_type: str) -> tuple[str, str] | None:
    """Parse 'sidecar.<plugin_id>.<tool_name>' -> (plugin_id, tool_name)."""
    job_type = _resolve_job_type(job_type)
    if not job_type.startswith("sidecar."):
        return None
    parts = job_type.split(".")
    if len(parts) != 3:
        return None
    _, plugin_id, tool_name = parts
    return plugin_id, tool_name


def run(job_type: str, payload: dict[str, Any], tenant: dict[str, Any] | None = None) -> dict[str, Any]:
    parsed = _parse_job_type(job_type)
    if not parsed:
        return {"acknowledged": True, "type": job_type}

    plugin_id, tool_name = parsed
    manifest = MANIFESTS.get(plugin_id)
    if not manifest:
        raise RuntimeError(f"Plugin manifest not found: {plugin_id}")

    tool = next((t for t in manifest.get("tools", []) if t["name"] == tool_name), None)
    if not tool:
        raise RuntimeError(f"Tool {tool_name} not found in plugin {plugin_id}")

    backend = _choose_backend(manifest)
    tenant_prefix = _tenant_prefix(tenant)

    if backend == "docker":
        return _run_docker(manifest, tool_name, payload, tenant_prefix)
    return _run_local(manifest, tool_name, payload, tenant_prefix)


def _choose_backend(manifest: dict[str, Any]) -> str:
    if RUNNER_BACKEND == "local":
        return "local"
    if RUNNER_BACKEND == "docker":
        return "docker"

    # auto: prefer docker if available and configured, otherwise local
    if os.environ.get("EXECUTION_PLANE_URL"):
        # If we are proxying to a remote execution plane, let the remote handle it.
        return "docker"
    if docker_sdk is not None:
        try:
            docker_sdk.from_env().ping()
            return "docker"
        except Exception:
            logger.warning("Docker not available, falling back to local plugin runner")
    return "local"


def _run_local(manifest: dict[str, Any], tool_name: str, payload: dict[str, Any], tenant_prefix: str) -> dict[str, Any]:
    # Add the local plugin source tree to PYTHONPATH so handlers can be imported.
    base_dir = Path(__file__).resolve().parent.parent / "plugins" / "base"
    if str(base_dir) not in sys.path:
        sys.path.insert(0, str(base_dir))

    from plugin_server.handlers import HANDLERS

    handler = HANDLERS.get(tool_name)
    if not handler:
        raise RuntimeError(f"Local handler not found for tool: {tool_name}")

    old_prefix = os.environ.get("TENANT_PREFIX")
    old_template_dir = os.environ.get("PLUGIN_TEMPLATE_DIR")
    template_dir = str(base_dir / "templates" / "docx")
    try:
        os.environ["TENANT_PREFIX"] = tenant_prefix
        if not old_template_dir and Path(template_dir).is_dir():
            os.environ["PLUGIN_TEMPLATE_DIR"] = template_dir
        return handler(payload)
    finally:
        if old_prefix is None:
            os.environ.pop("TENANT_PREFIX", None)
        else:
            os.environ["TENANT_PREFIX"] = old_prefix
        if old_template_dir is None:
            os.environ.pop("PLUGIN_TEMPLATE_DIR", None)
        else:
            os.environ["PLUGIN_TEMPLATE_DIR"] = old_template_dir


def _ensure_docker_network(client, network: str, internal: bool) -> None:
    try:
        client.networks.get(network)
    except Exception:
        logger.info("Creating Docker network %s (internal=%s)", network, internal)
        client.networks.create(
            network,
            driver="bridge",
            internal=internal,
            labels={"heurion-managed": "true"},
        )


def _run_docker(manifest: dict[str, Any], tool_name: str, payload: dict[str, Any], tenant_prefix: str) -> dict[str, Any]:
    if docker_sdk is None:
        raise RuntimeError("docker SDK is not available; set PLUGIN_RUNNER=local to use the in-process fallback")

    client = docker_sdk.from_env()
    runtime = manifest.get("runtime", {})
    image = runtime.get("image")
    if not image:
        raise RuntimeError(f"Plugin {manifest['plugin']['id']} has no container image")

    resources = runtime.get("resources", {})
    timeout = resources.get("max_execution_seconds", 60)
    mem_limit = resources.get("memory", "512Mi")

    permissions = manifest.get("permissions", {})
    network_egress = permissions.get("network_egress", {}) or {}
    egress_enabled = bool(network_egress.get("enabled", False))
    egress_allowlist = network_egress.get("allowlist", []) or []

    environment = {
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT", ""),
        "S3_BUCKET": os.environ.get("S3_BUCKET", ""),
        "S3_REGION": os.environ.get("S3_REGION", "us-east-1"),
        "S3_ACCESS_KEY_ID": os.environ.get("S3_ACCESS_KEY_ID", ""),
        "S3_SECRET_ACCESS_KEY": os.environ.get("S3_SECRET_ACCESS_KEY", ""),
        "TENANT_PREFIX": tenant_prefix,
        "PLUGIN_TOOLS": tool_name,
        "PLUGIN_NETWORK_EGRESS_ENABLED": "1" if egress_enabled else "0",
        "PLUGIN_NETWORK_EGRESS_ALLOWLIST": ",".join(egress_allowlist),
    }
    environment.update(runtime.get("env", {}))

    network = os.environ.get("PLUGIN_NETWORK", "heurion-plugins")
    # Disable external egress unless the plugin explicitly requests it.
    # Per-domain allowlists require an external firewall/proxy; the runner
    # alone cannot enforce DNS-level egress filtering.
    _ensure_docker_network(client, network, internal=not egress_enabled)

    template_dir = Path(__file__).resolve().parent.parent / "plugins" / "base" / "templates"

    container = None
    start = time.time()
    try:
        container = client.containers.run(
            image,
            network=network,
            environment=environment,
            volumes={str(template_dir): {"bind": "/templates", "mode": "ro"}},
            mem_limit=mem_limit,
            detach=True,
        )

        # Wait for container to be ready, then invoke.
        _wait_for_health(container, timeout)
        port = runtime.get("port", 8080)
        ip = container.attrs["NetworkSettings"]["Networks"][network]["IPAddress"]
        url = f"http://{ip}:{port}/v1/tools/invoke"

        import urllib.request
        req = urllib.request.Request(
            url,
            data=json.dumps({"tool": tool_name, "arguments": payload, "context": {"tenant_prefix": tenant_prefix}}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        if not body.get("success"):
            raise RuntimeError(body.get("error") or "plugin invocation failed")
        return body["output"]
    finally:
        if container:
            try:
                container.stop(timeout=5)
                container.remove(force=True)
            except Exception:
                pass


def _wait_for_health(container, timeout: int) -> None:
    import urllib.request
    deadline = time.time() + min(timeout, 30)
    port = 8080
    while time.time() < deadline:
        container.reload()
        networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
        ip = None
        for net in networks.values():
            ip = net.get("IPAddress")
            if ip:
                break
        if ip:
            url = f"http://{ip}:{port}/health"
            try:
                with urllib.request.urlopen(url, timeout=2) as resp:
                    if resp.status == 200:
                        return
            except Exception:
                pass
        time.sleep(0.5)
    raise RuntimeError("plugin container health check failed")


def _tenant_prefix(tenant: dict[str, Any] | None) -> str:
    tenant = tenant or {}
    workspace_id = tenant.get("workspace_id") or tenant.get("workspaceId") or "default"
    user_id = tenant.get("user_id") or tenant.get("userId") or "anonymous"
    return f"{workspace_id}/{user_id}"
