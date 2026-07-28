"""Nexus Server — multi-tenant HTTP frontend for the Nexus DigitalTwin.

A FastAPI application that serves three concerns:

* **Auth** — username + password (bcrypt) + JWT (``nexus_server.auth``).
* **Chat** — ``/api/v1/llm/chat`` routes through a per-user
  :class:`nexus.DigitalTwin`; attachments are distilled via
  :mod:`nexus_core.distiller` (``nexus_server.llm_gateway`` +
  ``nexus_server.attachment_distiller``).
* **Views** — ``/api/v1/agent/{state,timeline,memories,messages}``
  read directly from each twin's per-user EventLog SQLite
  (``nexus_server.agent_state`` + ``nexus_server.twin_event_log``).

Phase B retired the standalone ``sync_hub`` event-sync router, the
``sync_events`` mirror table, and all BSC/chain integration
(``chain_proxy`` / ``sync_anchor``). The desktop is a thin client now
and the twin's own EventLog is authoritative.
"""

__version__ = "0.1.0"
__author__ = "Nexus Team"
__all__ = [
    "__version__",
    "app",
]

from nexus_server.main import create_app

app = create_app()
