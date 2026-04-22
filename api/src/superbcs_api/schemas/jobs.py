"""Pydantic schemas mirrored to docs/openapi.yaml."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

MOTION_PRESETS = frozenset(
    {
        "PUMP_IT",
        "DUMP_IT",
        "BULL_RUN",
        "BEAR_MARKET",
        "RUGPULL",
        "DIAMOND_HANDS",
        "MOON_SHOT",
        "WHALE_ALERT",
        "FOMO",
        "LIQUIDATION",
        "HODL",
        "TO_THE_MOON",
        "HYPE_TRAIN",
        "FIRE_SALE",
        "BLOCKCHAIN",
        "GOLDEN_CROSS",
    }
)

JobStatusLiteral = Literal["queued", "claimed", "running", "done", "error", "cancelled"]


class JobCreated(BaseModel):
    job_id: UUID
    status: Literal["queued"] = "queued"
    queue_position: int = Field(ge=1)
    poll_after_seconds: int = 3
    tier: str | None = None
    quota_used: int | None = None
    quota_limit: int | None = None


class JobStatusOut(BaseModel):
    job_id: UUID
    status: JobStatusLiteral
    media_url: str | None = None
    media_id: UUID | None = None
    media_urls: list[str] = Field(default_factory=list)
    error_text: str | None = None
    duration_ms: int | None = None
    created_at: datetime
    completed_at: datetime | None = None


class HistoryItem(BaseModel):
    job_id: UUID
    status: JobStatusLiteral
    prompt_text: str
    motion_preset: str
    token_symbol: str
    media_url: str | None = None
    media_urls: list[str] = Field(default_factory=list)
    duration_ms: int | None = None
    created_at: datetime
    completed_at: datetime | None = None


class HistoryOut(BaseModel):
    items: list[HistoryItem]
    next_cursor: str | None = None
    quota_used: int
    quota_limit: int
    tier: str


class TierStatusOut(BaseModel):
    wallet: str
    tier: str
    source: str
    quota_used: int
    quota_limit: int


class WorkerJobOut(BaseModel):
    job_id: UUID
    prompt: str
    motion_preset: str
    token_symbol: str
    seed: int | None = None
    input_image_url: str | None = None
    deadline_at: datetime
    # Video-era fields. Workers generating still images can ignore these.
    duration_sec: int = 3
    num_variants: int = 2
    aspect_ratio: str = "9:16"
    width: int = 480
    height: int = 832
    fps: int = 24


class HeartbeatIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=64)
    vram_free_mb: int = Field(ge=0)
    queue_capacity: int = Field(ge=0)
    version: str | None = Field(default=None, max_length=64)


class ErrorOut(BaseModel):
    error: str
    detail: str | None = None
    request_id: str
