"""Reusable dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.db.session import get_session
from superbcs_api.services.auth import WalletSession, verify_panel_token


async def db_session() -> AsyncIterator[AsyncSession]:
    async for session in get_session():
        yield session


SessionDep = Depends(db_session)

# "Bearer <token>" splits into exactly two whitespace-delimited parts.
_BEARER_PARTS = 2


def _strip_bearer(value: str | None) -> str | None:
    if not value:
        return None
    parts = value.split(None, 1)
    if len(parts) == _BEARER_PARTS and parts[0].lower() == "bearer":
        return parts[1].strip() or None
    return None


async def optional_wallet(
    authorization: str | None = Header(default=None),
) -> WalletSession | None:
    """Resolve the caller's panel session if a valid Bearer is supplied.

    Anonymous traffic (no header) returns None — the caller decides
    whether to allow anonymous use or 401.
    """
    token = _strip_bearer(authorization)
    if token is None:
        return None
    return await verify_panel_token(token)


async def required_wallet(
    authorization: str | None = Header(default=None),
) -> WalletSession:
    from fastapi import HTTPException, status

    session = await optional_wallet(authorization)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wallet authentication required")
    return session


OptionalWalletDep = Depends(optional_wallet)
RequiredWalletDep = Depends(required_wallet)
