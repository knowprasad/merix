"""Pipeline orchestrator: ties extraction, embedding, matching, and persistence.

This is the single place that wires the vertical slice together. Routes call
these functions; they take DB session + clients as arguments so tests can inject
fakes.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from merix.clients.base import EmbeddingClient, LLMClient
from merix.core.exceptions import NotFoundError
from merix.models.job import JobDescription
from merix.models.match import MatchResult
from merix.models.organisation import Organisation
from merix.models.resume import Resume
from merix.services import consent, matching, timeline

logger = logging.getLogger("merix.services.pipeline")


async def create_job(
    db: AsyncSession,
    llm: LLMClient,
    embedder: EmbeddingClient,
    org_id: uuid.UUID,
    title: str,
    raw_text: str,
) -> JobDescription:
    """Create a job: extract requirements, embed the text, persist."""
    parsed = await matching.extract_jd(llm, raw_text)
    embedding = await embedder.embed(raw_text)
    job = JobDescription(org_id=org_id, title=title, raw_text=raw_text, parsed=parsed, embedding=embedding)
    db.add(job)
    await db.commit()
    await db.refresh(job)
    logger.info("job_created id=%s title=%s", job.id, title)
    return job


async def add_resume(
    db: AsyncSession,
    llm: LLMClient,
    embedder: EmbeddingClient,
    job: JobDescription,
    raw_text: str,
    original_filename: str,
    candidate_name: str | None = None,
    consent_given: bool = False,
    links: list[dict[str, str]] | None = None,
) -> Resume:
    """Add a resume to a job: validate consent, extract info, embed, persist.

    ``links`` are extracted pre-scrub by the upload endpoint (see
    services.links) and stored inside ``parsed`` — the LLM never sees them.
    """
    consent.require_consent(consent_given)
    # Extraction (LLM) and embedding (provider API) are independent calls over
    # the same text: run them concurrently so a resume upload pays one
    # provider round-trip of latency instead of two back-to-back ones.
    parsed, embedding = await asyncio.gather(
        matching.extract_resume(llm, raw_text),
        embedder.embed(raw_text),
    )
    if links:
        parsed["links"] = links
    # Deterministic timeline analysis: never trust the LLM's arithmetic for
    # tenure totals, overlaps, or gaps.
    parsed["timeline_analysis"] = timeline.analyse_timeline(parsed.get("timeline"))

    if not candidate_name:
        candidate_name = parsed.get("candidate_name")
    resume = Resume(
        org_id=job.org_id,
        job_id=job.id,
        raw_text=raw_text,
        parsed=parsed,
        embedding=embedding,
        original_filename=original_filename,
        candidate_name=candidate_name,
    )
    # Server-side consent timestamp + retention expiry; never trust client clocks.
    org = await db.get(Organisation, job.org_id)
    consent.record_consent(resume, org or Organisation(retention_days=90))
    db.add(resume)
    await db.commit()
    await db.refresh(resume)
    logger.info("resume_added id=%s job_id=%s consent=%s", resume.id, job.id, True)
    return resume


async def run_match_for_resume(
    db: AsyncSession,
    llm: LLMClient,
    embedder: EmbeddingClient,
    job: JobDescription,
    resume: Resume,
) -> MatchResult:
    """Compute and persist an explainable match for one (job, resume) pair.

    Idempotent: updates the existing MatchResult for the pair if present.
    """
    if job.parsed is None:
        job.parsed = await matching.extract_jd(llm, job.raw_text)
    if resume.parsed is None:
        resume.parsed = await matching.extract_resume(llm, resume.raw_text)

    comp = await matching.compute_match(job.parsed, resume.parsed, embedder)
    rationale = await matching.generate_rationale(llm, job.parsed, resume.parsed, comp)

    existing = await db.scalar(select(MatchResult).where(MatchResult.job_id == job.id, MatchResult.resume_id == resume.id))
    if existing is None:
        existing = MatchResult(org_id=job.org_id, job_id=job.id, resume_id=resume.id)
        db.add(existing)
    existing.score = comp.score
    existing.matched_skills = comp.matched_skills
    existing.missing_skills = comp.missing_skills
    existing.score_breakdown = comp.score_breakdown
    existing.rationale = rationale
    await db.commit()
    await db.refresh(existing)
    return existing


async def run_match_for_job(
    db: AsyncSession,
    llm: LLMClient,
    embedder: EmbeddingClient,
    job: JobDescription,
) -> list[MatchResult]:
    """Run the batch match: every resume for the job, ranked by score desc."""
    resumes = (await db.scalars(select(Resume).where(Resume.job_id == job.id))).all()
    results: list[MatchResult] = []
    for resume in resumes:
        results.append(await run_match_for_resume(db, llm, embedder, job, resume))
    results.sort(key=lambda r: r.score, reverse=True)
    logger.info("match_run job_id=%s resumes=%d", job.id, len(results))
    return results


async def get_job_or_404(db: AsyncSession, job_id, org_id: uuid.UUID) -> JobDescription:
    """Fetch a job owned by the caller's org (404 otherwise — no existence leak)."""
    job = await db.scalar(select(JobDescription).where(JobDescription.id == job_id, JobDescription.org_id == org_id))
    if job is None:
        raise NotFoundError(f"job {job_id} not found")
    return job


async def list_matches_for_job(db: AsyncSession, job: JobDescription, min_score: float | None = None) -> list[MatchResult]:
    """List persisted match results for a job, ranked by score desc."""
    stmt = select(MatchResult).where(MatchResult.job_id == job.id)
    if min_score is not None:
        stmt = stmt.where(MatchResult.score >= min_score)
    stmt = stmt.order_by(MatchResult.score.desc())
    return list((await db.scalars(stmt)).all())


async def get_match_or_404(db: AsyncSession, match_id, org_id: uuid.UUID) -> MatchResult:
    """Fetch a match owned by the caller's org (404 otherwise — no existence leak)."""
    match = await db.scalar(select(MatchResult).where(MatchResult.id == match_id, MatchResult.org_id == org_id))
    if match is None:
        raise NotFoundError(f"match {match_id} not found")
    return match


def to_match_response(match: MatchResult, candidate_name: str | None) -> dict:
    """Serialise a MatchResult (+ candidate name) to a dict."""
    from merix.schemas.match import MatchResponse

    return MatchResponse.model_validate(
        {
            "id": match.id,
            "job_id": match.job_id,
            "resume_id": match.resume_id,
            "candidate_name": candidate_name,
            "score": match.score,
            "matched_skills": match.matched_skills,
            "missing_skills": match.missing_skills,
            "score_breakdown": match.score_breakdown,
            "rationale": match.rationale,
            "status": match.status,
            "created_at": match.created_at,
        }
    ).model_dump(mode="json")
