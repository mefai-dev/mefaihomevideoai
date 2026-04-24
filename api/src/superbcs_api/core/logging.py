"""Structured JSON logging. Never logs secrets or full bearer tokens."""

from __future__ import annotations

import logging
import sys

import structlog
from structlog.typing import EventDict, WrappedLogger

_REDACT_KEYS = frozenset(
    {"authorization", "auth", "token", "secret", "password", "cookie", "set-cookie"}
)


def _redact_processor(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if key.lower() in _REDACT_KEYS:
            event_dict[key] = "<redacted>"
    return event_dict


_WALLET_MIN_LEN_FOR_REDACTION = 12  # 0x + 6 prefix + 4 suffix minimum


def redact_wallet(wallet: str | None) -> str | None:
    """Shorten a 0x… wallet for log output: `0x1234…cdef`.

    Full wallet addresses are on-chain public, but correlating them with
    submission timestamps in logs is a deanonymisation vector. Logs keep
    a prefix/suffix that is enough to cross-reference against an explorer
    when debugging without broadcasting the whole identifier.
    """
    if wallet is None:
        return None
    if len(wallet) < _WALLET_MIN_LEN_FOR_REDACTION or not wallet.startswith("0x"):
        return wallet
    return f"{wallet[:6]}…{wallet[-4:]}"


def configure_logging(*, debug: bool = False) -> None:
    level = logging.DEBUG if debug else logging.INFO
    logging.basicConfig(stream=sys.stdout, format="%(message)s", level=level)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact_processor,
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)  # type: ignore[no-any-return]
