"""Pydantic schemas for resume + match API."""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class ResumeResponse(BaseModel):
    """A resume as returned by the API (PII-minimal)."""

    id: uuid.UUID
    job_id: uuid.UUID
    candidate_name: str | None = None
    original_filename: str
    parsed: dict | None = None
    consent_given: bool
    consent_timestamp: datetime | None = None
    retention_expires_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class MatchedSkill(BaseModel):
    """One JD requirement satisfied by the candidate's resume.

    match_type distinguishes the three states recruiters see:
      - "exact": normalised string equality (verbatim evidence).
      - "adjacent": semantic fallback via embedding cosine similarity;
        ``similar_to`` is the JD skill it satisfies and ``similarity`` is
        the cosine score (0-1). Absent/None on legacy rows -> exact.
    """

    skill: str
    required: bool
    evidence: str = ""
    match_type: Literal["exact", "adjacent"] = "exact"
    similar_to: str | None = None
    similarity: float | None = None


class MissingSkill(BaseModel):
    skill: str
    required: bool = True


class ScoreBreakdown(BaseModel):
    """Exact deterministic score components shown to recruiters."""

    version: int = 1
    required_coverage: float = Field(ge=0, le=1)
    preferred_coverage: float = Field(ge=0, le=1)
    experience_score: float = Field(ge=0, le=1)
    required_contribution: float = Field(ge=0, le=70)
    preferred_contribution: float = Field(ge=0, le=20)
    experience_contribution: float = Field(ge=0, le=10)
    required_exact_matches: int = Field(ge=0)
    preferred_exact_matches: int = Field(ge=0)
    required_adjacent_credit: float = Field(ge=0)
    preferred_adjacent_credit: float = Field(ge=0)
    required_total: int = Field(ge=0)
    preferred_total: int = Field(ge=0)
    experience_years: float = Field(ge=0)
    minimum_experience_years: float = Field(ge=0)


class MatchResponse(BaseModel):
    """An explainable match result."""

    id: uuid.UUID
    job_id: uuid.UUID
    resume_id: uuid.UUID
    candidate_name: str | None = None
    score: float
    score_breakdown: ScoreBreakdown | None = None
    matched_skills: list[MatchedSkill]
    missing_skills: list[MissingSkill]
    rationale: str | None = None
    status: str = "pending"
    created_at: datetime

    model_config = {"from_attributes": True}


class MatchStatus(StrEnum):
    """Recruiter disposition for a match result."""

    PENDING = "pending"
    SHORTLISTED = "shortlisted"
    REJECTED = "rejected"


class BulkMatchStatusUpdate(BaseModel):
    """Bulk recruiter disposition update for a job's match results."""

    match_ids: list[uuid.UUID] = Field(min_length=1)
    status: MatchStatus


class MatchNoteCreate(BaseModel):
    """Request body for adding a recruiter note to a match."""

    body: str = Field(min_length=1, max_length=5000)


class MatchNoteResponse(BaseModel):
    """A timestamped, author-attributed recruiter note on a match."""

    id: uuid.UUID
    match_id: uuid.UUID
    author_id: uuid.UUID | None = None
    author_email: str | None = None
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
