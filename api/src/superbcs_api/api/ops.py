"""Health/readiness endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.api.deps import SessionDep
from superbcs_api.core.settings import get_settings

router = APIRouter(prefix="/api/superbcs", tags=["ops"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(session: Annotated[AsyncSession, SessionDep]) -> Response:
    settings = get_settings()
    try:
        await session.execute(text("SELECT 1"))
    except Exception:
        return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    if not settings.media_dir.exists():
        return Response(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    return Response(content='{"status":"ready"}', media_type="application/json")
