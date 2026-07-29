"""Standalone local embedding HTTP service for Brain 2.0 / GraphRAG.

Loads a sentence-transformers compatible model (default ``BAAI/bge-m3``) and
exposes a minimal REST API:

  GET  /health
  POST /embed  { "texts": ["..."], "model?": "...", "normalize?": true }

Configuration is read from environment variables:

  EMBEDDING_MODEL           default BAAI/bge-m3
  EMBEDDING_DEVICE          cpu | cuda | mps   (default cpu)
  EMBEDDING_BATCH_SIZE      int (default 32)
  EMBEDDING_QUANTIZATION    none | int8 | onnx (default none)
  EMBEDDING_DIMENSIONS      int | unset        (verified at startup)
  EMBEDDING_NORMALIZE       true | false       (default true)
  EMBEDDING_SERVER_HOST     default 0.0.0.0
  EMBEDDING_SERVER_PORT     int default 8003

Run directly:

  python -m nexus_server.embedding_server

Or via the installed console script:

  nexus-embedding-server
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("nexus.embedding_server")

DEFAULT_MODEL = "BAAI/bge-m3"
DEFAULT_DEVICE = "cpu"
DEFAULT_BATCH_SIZE = 32
DEFAULT_QUANTIZATION = "none"
DEFAULT_NORMALIZE = True
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8003

SUPPORTED_QUANTIZATIONS = {"none", "int8", "onnx"}


def _env_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _load_config() -> dict[str, Any]:
    quantization = os.environ.get("EMBEDDING_QUANTIZATION", DEFAULT_QUANTIZATION).lower()
    if quantization not in SUPPORTED_QUANTIZATIONS:
        raise ValueError(
            f"Unsupported EMBEDDING_QUANTIZATION={quantization}. "
            f"Choose one of: {', '.join(sorted(SUPPORTED_QUANTIZATIONS))}."
        )

    raw_dims = os.environ.get("EMBEDDING_DIMENSIONS")
    return {
        "model": os.environ.get("EMBEDDING_MODEL", DEFAULT_MODEL),
        "device": os.environ.get("EMBEDDING_DEVICE", DEFAULT_DEVICE),
        "batch_size": int(os.environ.get("EMBEDDING_BATCH_SIZE", DEFAULT_BATCH_SIZE)),
        "quantization": quantization,
        "dimensions": int(raw_dims) if raw_dims else None,
        "normalize": _env_bool(os.environ.get("EMBEDDING_NORMALIZE"), DEFAULT_NORMALIZE),
        "host": os.environ.get("EMBEDDING_SERVER_HOST", DEFAULT_HOST),
        "port": int(os.environ.get("EMBEDDING_SERVER_PORT", DEFAULT_PORT)),
    }


def _load_model(config: dict[str, Any]) -> Any:
    """Load the embedding model according to config.

    The ``sentence_transformers`` import is deferred so that this module can be
    imported for config inspection without requiring the heavy dependency.
    """
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "sentence-transformers is not installed. "
            "Install it with: uv pip install 'sentence-transformers>=3.0'"
        ) from exc

    model_name = config["model"]
    device = config["device"]
    quantization = config["quantization"]

    if device == "mps":
        import torch

        if not torch.backends.mps.is_available():
            logger.warning("MPS requested but not available; falling back to cpu")
            device = "cpu"

    kwargs: dict[str, Any] = {"device": device}
    if quantization == "onnx":
        kwargs["backend"] = "onnx"

    try:
        model = SentenceTransformer(model_name, **kwargs)
    except Exception as exc:  # pragma: no cover
        backend_msg = " with ONNX backend" if quantization == "onnx" else ""
        raise RuntimeError(
            f"Failed to load embedding model '{model_name}'{backend_msg}. "
            f"Ensure the model name is correct and dependencies are installed."
        ) from exc

    actual_dim = model.get_sentence_embedding_dimension()
    expected_dim = config.get("dimensions")
    if expected_dim is not None and actual_dim != expected_dim:
        raise ValueError(
            f"EMBEDDING_DIMENSIONS={expected_dim} does not match model dimension {actual_dim}. "
            "Update EMBEDDING_DIMENSIONS or choose a model with matching output size."
        )

    return model


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = _load_config()
    app.state.config = config
    app.state.model = _load_model(config)
    logger.info(
        "Embedding server ready: model=%s device=%s quantization=%s dimensions=%s",
        config["model"],
        config["device"],
        config["quantization"],
        app.state.model.get_sentence_embedding_dimension(),
    )
    yield
    app.state.model = None


app = FastAPI(title="Nexus Local Embedding Service", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)
    model: str | None = None
    normalize: bool | None = None


class EmbedResponse(BaseModel):
    embeddings: list[list[float]] | list[list[int]]
    model: str
    dimensions: int


class HealthResponse(BaseModel):
    status: str
    model: str
    dimensions: int
    device: str
    quantization: str


def _quantize(embeddings: np.ndarray, precision: str) -> np.ndarray:
    from sentence_transformers.quantization import quantize_embeddings

    return quantize_embeddings(embeddings, precision=precision)


def _encode_texts(model: Any, texts: list[str], normalize: bool, batch_size: int) -> np.ndarray:
    return model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=normalize,
        convert_to_numpy=True,
        show_progress_bar=False,
    )


@app.get("/health", response_model=HealthResponse)
def health() -> dict[str, Any]:
    model = app.state.model
    config = app.state.config
    return {
        "status": "ok" if model is not None else "not_ready",
        "model": config["model"],
        "dimensions": model.get_sentence_embedding_dimension() if model else 0,
        "device": config["device"],
        "quantization": config["quantization"],
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> dict[str, Any]:
    model = app.state.model
    if model is None:
        raise HTTPException(status_code=503, detail="Embedding model not loaded")

    config = app.state.config
    normalize = req.normalize if req.normalize is not None else config["normalize"]
    batch_size = config["batch_size"]

    embeddings = _encode_texts(model, req.texts, normalize, batch_size)
    if config["quantization"] == "int8":
        embeddings = _quantize(embeddings, precision="int8")

    # Return plain JSON-serializable lists. For int8, numpy dtype is int8.
    return {
        "embeddings": embeddings.tolist(),
        "model": config["model"],
        "dimensions": embeddings.shape[1],
    }


def main() -> None:
    import uvicorn

    # Load config early so port/host are known before uvicorn starts.
    config = _load_config()
    host = config["host"]
    port = config["port"]

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
