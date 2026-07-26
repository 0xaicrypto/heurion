"""Heurion Execution Plane worker package.

This package runs inside the sandbox worker image and must not import
``nexus_server`` at the top level, because importing ``nexus_server`` triggers
FastAPI app creation and other Control Plane side effects that break the
consumer's Redis connection.
"""

__version__ = "0.1.0"
