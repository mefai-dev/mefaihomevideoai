"""Lightweight prompt + image/video safety checks.

Heavy ML moderation lives on the worker side (Diffusers safety_checker on the
generated image). The API does cheap fast checks: blocklist substrings, length
bounds, image header sniff, video container probe via ffprobe.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile

from PIL import Image, UnidentifiedImageError

# Conservative blocklist; expand as needed. Case-insensitive substring match.
_BLOCKLIST = frozenset(
    {
        "child",
        "minor",
        "underage",
        "loli",
        "shota",
        "csam",
        "rape",
        "bestiality",
    }
)

_ALLOWED_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})
_ALLOWED_VIDEO_FORMATS = frozenset({"MP4", "WEBM"})
_ALLOWED_VIDEO_CODECS = frozenset({"h264", "hevc", "vp9", "av1"})
_VIDEO_MAX_DURATION_SEC = 12.0
_VIDEO_MAX_WIDTH = 1920
_VIDEO_MAX_HEIGHT = 1920
_VIDEO_MAX_BYTES = 50 * 1024 * 1024  # 50 MB cap per variant
_VIDEO_MAX_FPS = 120.0


def is_prompt_safe(prompt: str) -> bool:
    lowered = prompt.lower()
    return not any(term in lowered for term in _BLOCKLIST)


def normalize_prompt(prompt: str) -> str:
    return re.sub(r"\s+", " ", prompt).strip()


def validate_image_bytes(data: bytes) -> tuple[str, int, int]:
    """Return (format, width, height). Raises ValueError on invalid/unsupported."""
    from io import BytesIO

    try:
        with Image.open(BytesIO(data)) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("invalid image data") from exc

    with Image.open(BytesIO(data)) as img:
        fmt = img.format or ""
        if fmt not in _ALLOWED_IMAGE_FORMATS:
            raise ValueError(f"unsupported image format: {fmt}")
        return fmt, img.width, img.height


def validate_video_bytes(data: bytes) -> tuple[str, int, int, float, float]:
    """Return (format, width, height, duration_sec, fps).

    Uses ffprobe to parse the container. Rejects anything with:
      - size > _VIDEO_MAX_BYTES
      - container not in _ALLOWED_VIDEO_FORMATS (mp4/webm)
      - video codec not in _ALLOWED_VIDEO_CODECS
      - duration > _VIDEO_MAX_DURATION_SEC
      - resolution > _VIDEO_MAX_WIDTH/_VIDEO_MAX_HEIGHT
      - no video stream present
    Raises ValueError on any failure.
    """
    if len(data) > _VIDEO_MAX_BYTES:
        raise ValueError(f"video too large: {len(data)} bytes")

    if shutil.which("ffprobe") is None:
        raise ValueError("ffprobe not installed on server")

    with tempfile.NamedTemporaryFile(suffix=".bin", delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    tmp.name,
                ],
                capture_output=True,
                timeout=10,
                check=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ValueError("invalid video data") from exc

    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ffprobe output unparseable") from exc

    fmt_name = (info.get("format", {}).get("format_name") or "").lower()
    # format_name can be "mov,mp4,m4a,3gp,3g2,mj2" — tokenize
    fmt_tokens = {t.strip() for t in fmt_name.split(",")}
    if "mp4" in fmt_tokens or "mov" in fmt_tokens:
        container = "MP4"
    elif "webm" in fmt_tokens or "matroska" in fmt_tokens:
        container = "WEBM"
    else:
        raise ValueError(f"unsupported container: {fmt_name}")

    if container not in _ALLOWED_VIDEO_FORMATS:
        raise ValueError(f"unsupported container: {container}")

    streams = info.get("streams") or []
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    if not video_streams:
        raise ValueError("no video stream")

    vs = video_streams[0]
    codec = (vs.get("codec_name") or "").lower()
    if codec not in _ALLOWED_VIDEO_CODECS:
        raise ValueError(f"unsupported video codec: {codec}")

    width = int(vs.get("width") or 0)
    height = int(vs.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError("invalid resolution")
    if width > _VIDEO_MAX_WIDTH or height > _VIDEO_MAX_HEIGHT:
        raise ValueError(f"resolution too large: {width}x{height}")

    duration = 0.0
    try:
        duration = float(info.get("format", {}).get("duration") or vs.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0 or duration > _VIDEO_MAX_DURATION_SEC:
        raise ValueError(f"duration out of range: {duration:.2f}s")

    # fps from "r_frame_rate": "24/1" -> 24.0
    fps = 0.0
    rate = vs.get("r_frame_rate") or ""
    if "/" in rate:
        try:
            num, den = rate.split("/", 1)
            fps = float(num) / float(den) if float(den) else 0.0
        except ValueError:
            fps = 0.0
    if fps <= 0 or fps > _VIDEO_MAX_FPS:
        raise ValueError(f"invalid fps: {fps}")

    return container, width, height, duration, fps
