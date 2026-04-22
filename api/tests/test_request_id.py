"""Request ID charset + 422 masker integration test via ASGI TestClient.

Uses a stripped-down FastAPI app that wires in the same middleware and
validation handler from main.py, without touching the DB / full router
(public and worker routers depend on the DB engine).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI, Form
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException

from superbcs_api.core.settings import get_settings

_RID_SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _build_app() -> FastAPI:
    """Rebuild the same middleware + handlers main.create_app() uses,
    over a minimal app. Mirrors production behavior for request_id + 422.
    """
    app = FastAPI()
    settings = get_settings()

    @app.middleware("http")
    async def request_id_middleware(request, call_next):  # type: ignore[no-untyped-def]
        incoming = request.headers.get(settings.request_id_header, "")
        if 0 < len(incoming) <= 64 and all(c in _RID_SAFE for c in incoming):
            rid = incoming
        else:
            rid = uuid.uuid4().hex
        request.state.request_id = rid
        response = await call_next(request)
        response.headers[settings.request_id_header] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    def _rid(request):  # type: ignore[no-untyped-def]
        return (
            getattr(request.state, "request_id", None)
            or request.headers.get(settings.request_id_header)
            or uuid.uuid4().hex
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request, exc):  # type: ignore[no-untyped-def]
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": str(exc.detail), "request_id": _rid(request)},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request, exc):  # type: ignore[no-untyped-def]
        fields: list[str] = []
        seen: set[str] = set()
        for err in exc.errors():
            loc = err.get("loc", ())
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

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.post("/submit")
    async def submit(
        prompt: str = Form(min_length=3, max_length=10),
        token: str = Form(pattern=r"^[A-Z]{2,5}$"),
    ):
        return {"prompt": prompt, "token": token}

    return app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(_build_app())


def test_supplied_rid_echoed(client: TestClient) -> None:
    resp = client.get("/ping", headers={"X-Request-ID": "abc-123_XYZ"})
    assert resp.headers["x-request-id"] == "abc-123_XYZ"


def test_generated_rid_when_missing(client: TestClient) -> None:
    resp = client.get("/ping")
    rid = resp.headers["x-request-id"]
    assert len(rid) == 32
    assert all(c in "0123456789abcdef" for c in rid)


def test_rid_overlong_is_replaced(client: TestClient) -> None:
    overlong = "a" * 65
    resp = client.get("/ping", headers={"X-Request-ID": overlong})
    assert resp.headers["x-request-id"] != overlong


def test_rid_unsafe_chars_replaced(client: TestClient) -> None:
    # CRLF-injection attempt and < > chars must be rejected.
    for bad in ["bad\r\ninject", "bad<script>", "with space"]:
        resp = client.get("/ping", headers={"X-Request-ID": bad})
        assert resp.headers["x-request-id"] != bad


def test_rid_empty_header_is_replaced(client: TestClient) -> None:
    resp = client.get("/ping", headers={"X-Request-ID": ""})
    assert len(resp.headers["x-request-id"]) == 32


def test_422_masker_returns_field_names_only(client: TestClient) -> None:
    resp = client.post(
        "/submit",
        data={"prompt": "", "token": "lowercase"},
        headers={"X-Request-ID": "rid-test-1"},
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"] == "validation_failed"
    assert body["request_id"] == "rid-test-1"
    assert set(body["fields"]) == {"prompt", "token"}
    # No raw pydantic tree leaked.
    assert "type" not in body
    assert "msg" not in body
    assert "loc" not in body
    assert "ctx" not in body


def test_422_missing_fields(client: TestClient) -> None:
    resp = client.post("/submit", data={})
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"] == "validation_failed"
    assert set(body["fields"]) == {"prompt", "token"}


def test_security_headers_present(client: TestClient) -> None:
    resp = client.get("/ping")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"
