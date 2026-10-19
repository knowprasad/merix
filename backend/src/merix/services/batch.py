"""Batch job service: background task for async match processing.

Creates its own DB session and LLM client so it is fully independent
of the request lifecycle. Updates the BatchJob row with progress and
per-resume disposition entries as it works.

Retry policy: failed jobs surface their failure to the client. No
auto-retry. The client must resubmit (POST the match again).
run_match_for_resume is idempotent (upserts), so re-running a
completed job is safe.
"""

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from merix.clients.base import EmbeddingClient, LLMClient
from merix.clients.embeddings import get_embedding_client
from merix.clients.llm import get_llm_client
from merix.config import settings
from merix.db import scoped_session
from merix.models.batch_job import BatchJob
from merix.models.job import JobDescription
from merix.models.match import MatchResult
from merix.models.resume import Resume
from merix.services import matching, pipeline
from merix.services.verify import verify_resume_links

logger = logging.getLogger("merix.services.batch")


async def run_batch_match_background(
    org_id: uuid.UUID,
    job_id: uuid.UUID,
    batch_job_id: uuid.UUID,
    llm: LLMClient | None = None,
    embedder: EmbeddingClient | None = None,
) -> None:
    """Run match for every resume on a job and record results on the BatchJob.

    Creates a fresh scoped session (RLS-pinned to *org_id*). Uses provided
    clients or creates new ones.

    Concurrency model: resumes are processed in chunks of
    ``settings.MATCH_CONCURRENCY``. Within a chunk the LLM-bound work
    (first-sight extraction + rationale generation) runs in parallel — these
    are independent network round-trips. DB reads/writes stay strictly
    sequential on this single scoped session (AsyncSession is not safe for
    concurrent use), so each chunk commits its MatchResults and progress
    update together.
    """

    session = scoped_session(org_id)
    if llm is None:
        llm = get_llm_client(api_key=settings.LLM_API_KEY, model=settings.LLM_MODEL)
    if embedder is None:
        embedder = get_embedding_client(
            provider=settings.EMBEDDING_PROVIDER,
            api_key=settings.EMBEDDING_API_KEY,
            model=settings.EMBEDDING_MODEL,
        )

    async def match_llm_work(resume: Resume):
        """LLM+embedding-only portion for one resume. No DB access — safe in parallel."""
        parsed = resume.parsed
        if parsed is None:
            parsed = await matching.extract_resume(llm, resume.raw_text)
        comp = await matching.compute_match(job.parsed, parsed, embedder)
        rationale = await matching.generate_rationale(llm, job.parsed, parsed, comp)
        return parsed, comp, rationale

    try:
        batch_job = await session.get(BatchJob, batch_job_id)
        if batch_job is None:
            logger.error("batch_job_not_found id=%s", batch_job_id)
            return

        batch_job.status = "running"
        await session.commit()

        job = await session.get(JobDescription, job_id)
        if job is None:
            raise ValueError(f"Job {job_id} not found")

        # JD parse once up front (was previously re-checked per resume).
        if job.parsed is None:
            job.parsed = await matching.extract_jd(llm, job.raw_text)

        resumes = (await session.scalars(select(Resume).where(Resume.job_id == job_id))).all()

        batch_results: list[dict] = []
        completed = 0
        succeeded = 0
        chunk_size = max(1, settings.MATCH_CONCURRENCY)

        for start in range(0, len(resumes), chunk_size):
            chunk = resumes[start : start + chunk_size]
            outcomes = await asyncio.gather(
                *(match_llm_work(resume) for resume in chunk),
                return_exceptions=True,
            )

            for resume, outcome in zip(chunk, outcomes):
                completed += 1
                if isinstance(outcome, BaseException):
                    logger.error("match_failed resume_id=%s error=%r", resume.id, outcome)
                    batch_results.append(
                        {
                            "resume_id": str(resume.id),
                            "status": "failed",
                            "error": str(outcome),
                        }
                    )
                    continue

                parsed, comp, rationale = outcome
                # Persist first-sight extraction alongside the match result
                # (same effect as run_match_for_resume's in-place mutation).
                resume.parsed = parsed
                existing = await session.scalar(
                    select(MatchResult).where(MatchResult.job_id == job.id, MatchResult.resume_id == resume.id)
                )
                if existing is None:
                    existing = MatchResult(org_id=job.org_id, job_id=job.id, resume_id=resume.id)
                    session.add(existing)
                existing.score = comp.score
                existing.matched_skills = comp.matched_skills
                existing.missing_skills = comp.missing_skills
                existing.score_breakdown = comp.score_breakdown
                existing.rationale = rationale
                succeeded += 1
                batch_results.append(
                    {
                        "resume_id": str(resume.id),
                        "candidate_name": resume.candidate_name,
                        "status": "completed",
                        "score": comp.score,
                        "error": None,
                    }
                )

            # Persist the chunk + publish incremental progress in one commit
            # (was two commits per resume).
            await session.commit()
            # Re-fetch because the commit above expires nothing (expire_on_commit=False),
            # but keep the same re-fetch discipline as before so a concurrent
            # retention sweep can't resurrect stale column values.
            batch_job = await session.get(BatchJob, batch_job_id)
            batch_job.completed_resumes = completed
            batch_job.batch_results = batch_results
            await session.commit()

        batch_job = await session.get(BatchJob, batch_job_id)
        if resumes and succeeded == 0:
            # Every resume failed: reporting "completed" with an empty shortlist
            # hides the outage behind a success state. Surface it as failed so
            # the frontend stops showing a green path to zero results.
            batch_job.status = "failed"
            batch_job.error_message = f"All {len(resumes)} resume(s) failed processing — see batch_results for per-resume errors"
            logger.error("batch_match_all_failed job_id=%s resumes=%d", job_id, len(resumes))
        else:
            batch_job.status = "completed"
        await session.commit()

        logger.info("batch_match_completed job_id=%s resumes=%d succeeded=%d", job_id, completed, succeeded)

    except Exception as exc:
        logger.exception("batch_match_failed job_id=%s", job_id)
        try:
            # The session may be sitting in a failed transaction (e.g. the
            # exception came out of a commit); roll back before reusing it to
            # mark the failure, otherwise the marking itself fails silently
            # and the job stays "running" until the stale timeout.
            await session.rollback()
            batch_job = await session.get(BatchJob, batch_job_id)
            if batch_job is not None:
                batch_job.status = "failed"
                batch_job.error_message = str(exc)
                await session.commit()
        except Exception:
            logger.exception("failed_to_mark_batch_failed")
    finally:
        await session.close()


async def process_resume_background(
    org_id: uuid.UUID,
    job_id: uuid.UUID,
    batch_job_id: uuid.UUID,
    *,
    raw_text: str,
    original_filename: str,
    candidate_name: str | None = None,
    llm: LLMClient | None = None,
    embedder: EmbeddingClient | None = None,
    resume_links: list[dict[str, str]] | None = None,
) -> None:
    """Process one uploaded resume (LLM extraction + embedding) in the background.

    Same pattern as run_batch_match_background: creates its own scoped
    session (RLS-pinned to *org_id*) independent of the request lifecycle,
    and updates the BatchJob row so the client can poll status. The upload
    endpoint performs consent + PDF validation synchronously, so this
    function only does the slow work; add_resume's require_consent re-check
    passes trivially with consent_given=True.
    """
    session = scoped_session(org_id)
    if llm is None:
        llm = get_llm_client(api_key=settings.LLM_API_KEY, model=settings.LLM_MODEL)
    if embedder is None:
        embedder = get_embedding_client(
            provider=settings.EMBEDDING_PROVIDER,
            api_key=settings.EMBEDDING_API_KEY,
            model=settings.EMBEDDING_MODEL,
        )

    try:
        batch_job = await session.get(BatchJob, batch_job_id)
        if batch_job is None:
            logger.error("batch_job_not_found id=%s", batch_job_id)
            return

        batch_job.status = "running"
        await session.commit()

        job = await session.get(JobDescription, job_id)
        if job is None:
            raise ValueError(f"Job {job_id} not found")

        resume = await pipeline.add_resume(
            session,
            llm,
            embedder,
            job,
            raw_text=raw_text,
            original_filename=original_filename,
            candidate_name=candidate_name,
            consent_given=True,  # validated synchronously by the endpoint
            links=resume_links,
        )

        # Re-fetch inside this session because add_resume commits.
        # Link verification is advisory: failures here must never fail the job.
        if settings.LINK_VERIFY_ENABLED and resume.parsed and resume.parsed.get("links"):
            try:
                resume.parsed["link_verification"] = await verify_resume_links(resume.parsed["links"])
                # In-place JSONB mutation: mark the column dirty explicitly.
                flag_modified(resume, "parsed")
            except Exception:
                await session.rollback()
                logger.exception("link_verification_failed job_id=%s", job_id)

        batch_job = await session.get(BatchJob, batch_job_id)

        batch_job.status = "completed"
        batch_job.completed_resumes = 1
        batch_job.batch_results = [{"resume_id": str(resume.id), "status": "completed", "error": None}]
        await session.commit()

        logger.info("resume_processed job_id=%s resume_id=%s", job_id, resume.id)

    except Exception as exc:
        logger.exception("resume_processing_failed job_id=%s", job_id)
        try:
            # Roll back a possibly-failed transaction before reusing the
            # session to mark the failure (same reasoning as above).
            await session.rollback()
            batch_job = await session.get(BatchJob, batch_job_id)
            if batch_job is not None:
                batch_job.status = "failed"
                batch_job.error_message = str(exc)
                await session.commit()
        except Exception:
            logger.exception("failed_to_mark_upload_failed")
    finally:
        await session.close()
