import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .handlers import HANDLERS

logger = logging.getLogger("plugin-server")
logging.basicConfig(level=os.environ.get("PLUGIN_LOG_LEVEL", "INFO").upper())


class InvokeRequest(BaseModel):
    tool: str
    arguments: dict[str, Any]
    context: dict[str, Any] | None = None


class InvokeResponse(BaseModel):
    success: bool
    output: dict[str, Any] | None = None
    error: str = ""


@asynccontextmanager
async def lifespan(app: FastifyInstance):  # type: ignore[name-defined]
    logger.info("Plugin server starting. Available tools: %s", list(HANDLERS.keys()))
    yield


app = FastAPI(title="Heurion Plugin Server", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/tools/invoke", response_model=InvokeResponse)
async def invoke(req: InvokeRequest) -> InvokeResponse:
    allowed = os.environ.get("PLUGIN_TOOLS", "")
    if allowed:
        allowed_set = {t.strip() for t in allowed.split(",")}
        if req.tool not in allowed_set:
            raise HTTPException(status_code=400, detail=f"tool '{req.tool}' not supported by this plugin")

    handler = HANDLERS.get(req.tool)
    if not handler:
        raise HTTPException(status_code=404, detail=f"unknown tool: {req.tool}")

    logger.info("Invoking tool %s", req.tool)
    try:
        result = handler(req.arguments)
        return InvokeResponse(success=True, output=result)
    except Exception as exc:
        logger.exception("Tool %s failed", req.tool)
        return InvokeResponse(success=False, error=str(exc))
