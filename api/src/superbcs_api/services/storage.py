"""Local media storage. Layout: <media_dir>/<yyyy>/<mm>/<dd>/<uuid>.<ext>."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from superbcs_api.core.settings import get_settings

_FORMAT_EXT = {
    "JPEG": "jpg",
    "PNG": "png",
    "WEBP": "webp",
    "MP4": "mp4",
    "WEBM": "webm",
}


def _date_dir(now: datetime) -> Path:
    return Path(f"{now.year:04d}/{now.month:02d}/{now.day:02d}")


def write_media(
    data: bytes,
    *,
    image_format: str,
    media_id: UUID | None = None,
) -> tuple[UUID, str, str]:
    """Persist bytes. Returns (id, relative_path, sha256).

    ``image_format`` is a misnomer kept for backward compatibility; it accepts
    any key of ``_FORMAT_EXT`` (image or video).
    """
    settings = get_settings()
    mid = media_id or uuid4()
    ext = _FORMAT_EXT.get(image_format.upper(), "bin")
    rel = _date_dir(datetime.now(UTC)) / f"{mid}.{ext}"
    abs_path = settings.media_dir / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(data)
    sha = hashlib.sha256(data).hexdigest()
    return mid, str(rel), sha


def read_media(relative_path: str) -> bytes:
    settings = get_settings()
    abs_path = (settings.media_dir / relative_path).resolve()
    media_root = settings.media_dir.resolve()
    # Path-traversal guard. `is_relative_to` does proper path algebra so a
    # sibling directory that shares a prefix (e.g. `<root>-other`) cannot
    # slip past a naive string startswith check.
    if not abs_path.is_relative_to(media_root):
        raise PermissionError("path traversal blocked")
    return abs_path.read_bytes()
