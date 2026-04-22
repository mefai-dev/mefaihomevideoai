"""ASGI entrypoint."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from superbcs_api import __version__
from superbcs_api.api import ops, public, worker
from superbcs_api.core.logging import configure_logging, get_logger
from superbcs_api.core.settings import get_settings
from superbcs_api.db.session import dispose_engine

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(debug=settings.debug)
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    log.info("api_startup", version=__version__, env=settings.env, port=settings.bind_port)
    try:
        yield
    finally:
        await dispose_engine()
        log.info("api_shutdown")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="SUPER BCS Image Generation API",
        version=__version__,
        docs_url="/api/superbcs/docs" if settings.debug else None,
        redoc_url=None,
        openapi_url="/api/superbcs/openapi.json" if settings.debug else None,
        lifespan=lifespan,
    )

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-Worker-Id"],
            max_age=600,
        )

    _RID_SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    # Upper bound on caller-supplied request id length. Chosen generously
    # (covers UUID hex + dashes + a short prefix) while still rejecting
    # header-injection floods.
    _RID_MAX_LEN = 64

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Accept caller-supplied request id only if it's short and safe;
        # otherwise mint our own. Prevents header-injection (CRLF, overlong
        # values) from landing in our logs.
        incoming = request.headers.get(settings.request_id_header, "")
        if 0 < len(incoming) <= _RID_MAX_LEN and all(c in _RID_SAFE for c in incoming):
            rid = incoming
        else:
            rid = uuid.uuid4().hex
        # Attach to request.state so exception handlers can read the rid back
        # even when the caller never sent the header. This fixes the
        # "request_id: unknown" issue on validation / HTTP error responses.
        request.state.request_id = rid
        structlog.contextvars.bind_contextvars(request_id=rid, path=request.url.path)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers[settings.request_id_header] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    def _rid(request: Request) -> str:
        return (
            getattr(request.state, "request_id", None)
            or request.headers.get(settings.request_id_header)
            or uuid.uuid4().hex
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Use FastAPI-standard "detail" key so clients can parse errors
        # uniformly across 4xx/5xx responses.
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": str(exc.detail), "request_id": _rid(request)},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Return only failing field names. No raw pydantic error tree, no
        # types, no locations — avoids leaking schema internals.
        fields: list[str] = []
        seen: set[str] = set()
        for err in exc.errors():
            loc = err.get("loc", ())
            # e.g. ('body', 'prompt') → 'prompt'; ('query', 'sig') → 'sig'
            name = ".".join(str(p) for p in loc[1:]) if len(loc) > 1 else str(loc[0] if loc else "")
            if name and name not in seen:
                seen.add(name)
                fields.append(name)
        return JSONResponse(
            status_code=422,
            content={
                "detail": "validation_failed",
                "fields": fields,
                "request_id": _rid(request),
            },
        )

    @app.exception_handler(Exception)
    async def fallback_handler(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_exception")
        return JSONResponse(
            status_code=500,
            content={"detail": "internal_error", "request_id": _rid(request)},
        )

    app.include_router(ops.router)
    app.include_router(public.router)
    app.include_router(worker.router)
    return app


app = create_app()
