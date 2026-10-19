"""MatchResult model."""

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from merix.models.base import Base, TimestampMixin, uuid_pk

if TYPE_CHECKING:
    from merix.models.job import JobDescription
    from merix.models.resume import Resume


class MatchResult(Base, TimestampMixin):
    """The result of matching one resume against one job description.

    Explainability is first-class: not just a score, but which skills matched
    (with strength + verbatim evidence), which are missing, and a rationale.
    """

    __tablename__ = "match_results"
    __table_args__ = (
        # Idempotent re-matching: one result per (job, resume) pair.
        UniqueConstraint("job_id", "resume_id", name="uq_match_job_resume"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    # Denormalised tenant key so RLS policies need no joins.
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organisations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("job_descriptions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    resume_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("resumes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # 0-100 weighted match score.
    score: Mapped[float] = mapped_column(Float, nullable=False)

    # Explainability payloads (JSONB lists):
    #   matched_skills: [{skill, strength, evidence}]
    #   missing_skills: [{skill, required}]
    matched_skills: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    missing_skills: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)

    # Deterministic score components used by the recruiter-facing breakdown.
    # Nullable so rows created before this field was introduced remain readable.
    score_breakdown: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    # Short human-readable explanation of the score.
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Recruiter disposition: pending | shortlisted | rejected.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending")

    job: Mapped["JobDescription"] = relationship(back_populates="matches")
    resume: Mapped["Resume"] = relationship(back_populates="matches")
