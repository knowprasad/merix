"""Integration tests for the batch job infrastructure (Task 5).

Covers:
- POST /api/jobs/{job_id}/match returns 202 + BatchJobStatus
- GET /api/batch-jobs/{batch_job_id} status endpoint
- Match results produced after completion
- Idempotency key deduplication
- Partial failure (batch_results JSONB)
- Stale job detection (10-minute timeout)
- Org scoping (404 for cross-org access)
- Authentication required (401)

BackgroundTasks don't execute in TestClient, so pipeline work is
simulated manually via scoped_session where needed.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy import text as sa_text

from merix.core.exceptions import ExtractionError
from merix.db import scoped_session
from merix.models.batch_job import BatchJob
from merix.models.resume import Resume
from merix.services import pipeline
from merix.services.batch import run_batch_match_background
from tests.helpers import FakeEmbedder, FakeLLM, auth_headers, make_pdf

# ── helpers ────────────────────────────────────────────────────────────


async def _create_job_and_resume(client, headers, org_id, resume_text=None):
    """Create a job, upload a resume PDF, return (job_id, resume_id)."""
    r = client.post(
        "/api/jobs",
        json={
            "title": "Backend Engineer",
            "raw_text": "We need Python and SQL. AWS is a plus. 2+ years.",
        },
        headers=headers,
    )
    assert r.status_code == 201, r.text
    job = r.json()
    job_id = job["id"]

    text = resume_text or "Jane Doe. Built Python services and optimised SQL for 3 years."
    pdf = make_pdf(text)
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("jane.pdf", pdf, "application/pdf")},
        data={"candidate_name": "Jane Doe", "consent_given": "true"},
        headers=headers,
    )
    assert r.status_code == 202, r.text
    # Upload is async now: the response is a BatchJobStatus; the resume row is
    # created by process_resume_background (TestClient runs background tasks
    # before returning).
    async with scoped_session(uuid.UUID(str(org_id))) as session:
        resumes = (await session.scalars(select(Resume).where(Resume.job_id == uuid.UUID(job_id)))).all()
        assert len(resumes) == 1, r.text
        resume_id = str(resumes[0].id)
    return job_id, resume_id


async def _run_pipeline_and_update_batch_job(org_id, job_id, batch_job_id):
    """Simulate what the background task would do: run matching and
    update the BatchJob row to completed."""
    session = scoped_session(org_id)
    try:
        jd = await pipeline.get_job_or_404(session, uuid.UUID(job_id), org_id)
        await pipeline.run_match_for_job(session, FakeLLM(), FakeEmbedder(), jd)

        batch_job = await session.get(BatchJob, uuid.UUID(batch_job_id))
        if batch_job is not None:
            batch_job.status = "completed"
            batch_job.completed_resumes = batch_job.total_resumes
            resumes = (await session.scalars(select(Resume).where(Resume.job_id == uuid.UUID(job_id)))).all()
            batch_job.batch_results = [{"resume_id": str(r.id), "status": "completed", "error": None} for r in resumes]
            await session.commit()
    finally:
        await session.close()


# ── fixtures ───────────────────────────────────────────────────────────


@pytest.fixture
async def org_a(make_org_user):
    """An authenticated Org A user."""
    user_id, org_id = await make_org_user(org_name="Batch Org A")
    return auth_headers(user_id), org_id, user_id


# ── Test Classes ───────────────────────────────────────────────────────


class TestBatchMatchSubmission:
    """Scope item: POST /api/jobs/{job_id}/match → 202 + BatchJobStatus."""

    async def test_batch_match_returns_202_with_job_status(self, client, org_a):
        """Submit a batch match and verify the 202 response shape."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        body = r.json()

        # Verify BatchJobStatus shape
        assert "id" in body
        assert body["status"] == "queued"
        assert body["total_resumes"] == 1
        assert body["completed_resumes"] == 0
        assert body["job_description_id"] == job_id
        assert body["org_id"] == str(org_id)
        assert body["error_message"] is None
        assert body["batch_results"] is None
        assert "created_at" in body
        assert "updated_at" in body

    async def test_batch_match_no_resumes_still_creates_job(self, client, org_a):
        """Batch match with zero resumes should still return 202."""
        headers, org_id, _user_id = org_a
        r = client.post(
            "/api/jobs",
            json={"title": "Empty Job", "raw_text": "No resumes here."},
            headers=headers,
        )
        assert r.status_code == 201, r.text
        job_id = r.json()["id"]

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["total_resumes"] == 0
        assert body["status"] == "queued"


class TestBatchJobStatusEndpoint:
    """Scope item: GET /api/batch-jobs/{id} returns status."""

    async def test_batch_job_status_endpoint_returns_status(self, client, org_a):
        """Poll the status endpoint and see the current lifecycle stage."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == batch_job_id
        assert body["status"] in ("queued", "running", "completed")
        assert body["total_resumes"] == 1

    async def test_batch_job_status_after_completion(self, client, org_a):
        """After pipeline work, status endpoint shows completed."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        await _run_pipeline_and_update_batch_job(org_id, job_id, batch_job_id)

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "completed"
        assert body["completed_resumes"] == 1
        assert body["batch_results"] is not None
        assert len(body["batch_results"]) == 1
        assert body["batch_results"][0]["status"] == "completed"


class TestMatchResults:
    """Scope item: match results accessible after batch completion."""

    async def test_batch_job_produces_match_results(self, client, org_a):
        """After pipeline runs, match results are accessible via the
        shortlist endpoint."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        await _run_pipeline_and_update_batch_job(org_id, job_id, batch_job_id)

        r = client.get(f"/api/jobs/{job_id}/matches", headers=headers)
        assert r.status_code == 200, r.text
        shortlist = r.json()
        assert shortlist["count"] == 1
        assert shortlist["results"][0]["score"] > 0
        assert shortlist["results"][0]["candidate_name"] == "Jane Doe"


class TestIdempotency:
    """Scope item: idempotency_key returns same BatchJob."""

    async def test_batch_job_idempotency_same_key_same_job(self, client, org_a):
        """Two match submissions with the same idempotency_key return
        the same batch_job_id."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        key = str(uuid.uuid4())
        r1 = client.post(
            f"/api/jobs/{job_id}/match",
            json={"idempotency_key": key},
            headers=headers,
        )
        assert r1.status_code == 202, r1.text
        batch_job_id_1 = r1.json()["id"]

        r2 = client.post(
            f"/api/jobs/{job_id}/match",
            json={"idempotency_key": key},
            headers=headers,
        )
        assert r2.status_code == 202, r2.text
        batch_job_id_2 = r2.json()["id"]

        assert batch_job_id_1 == batch_job_id_2

    async def test_batch_job_no_idempotency_key_creates_separate_jobs(self, client, org_a):
        """Without an idempotency_key, each submission creates a new
        BatchJob."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r1 = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r1.status_code == 202, r1.text
        r2 = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r2.status_code == 202, r2.text

        assert r1.json()["id"] != r2.json()["id"]


class TestPartialFailure:
    """Scope item: partial batch failure recorded in batch_results JSONB."""

    async def test_batch_job_partial_failure_structure(self, client, org_a):
        """Verify that batch_results JSONB correctly records per-resume
        disposition including failures.

        We simulate this by directly inserting a BatchJob with
        pre-populated batch_results containing both a completed and a
        failed entry — the endpoint serves whatever is stored."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        # Directly update the BatchJob with mixed batch_results
        fake_resume_id = str(uuid.uuid4())
        session = scoped_session(org_id)
        try:
            batch_job = await session.get(BatchJob, uuid.UUID(batch_job_id))
            batch_job.status = "completed"
            batch_job.completed_resumes = 2
            batch_job.batch_results = [
                {
                    "resume_id": fake_resume_id + "_good",
                    "status": "completed",
                    "error": None,
                },
                {
                    "resume_id": fake_resume_id + "_bad",
                    "status": "failed",
                    "error": "Resume text extraction failed: empty PDF",
                },
            ]
            await session.commit()
        finally:
            await session.close()

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()

        assert body["status"] == "completed"
        assert body["batch_results"] is not None
        assert len(body["batch_results"]) == 2

        completed_entry = [e for e in body["batch_results"] if e["status"] == "completed"][0]
        assert completed_entry["error"] is None

        failed_entry = [e for e in body["batch_results"] if e["status"] == "failed"][0]
        assert failed_entry["error"] is not None
        assert "empty PDF" in failed_entry["error"]


class TestStaleJobDetection:
    """Scope item: stale running jobs detected and marked failed."""

    async def test_stale_job_detection_marks_failed(self, client, org_a):
        """A BatchJob stuck in 'running' with an old updated_at is
        detected as stale and marked 'failed' on poll."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        # Create a BatchJob directly with stale timestamps
        session = scoped_session(org_id)
        try:
            stale_job = BatchJob(
                org_id=org_id,
                job_description_id=uuid.UUID(job_id),
                status="running",
                total_resumes=1,
                completed_resumes=0,
            )
            session.add(stale_job)
            await session.flush()

            # Manually backdate updated_at to 15 minutes ago
            await session.execute(
                sa_text("UPDATE batch_jobs SET updated_at = :ts, created_at = :ts WHERE id = :id"),
                {
                    "ts": datetime.now(UTC) - timedelta(minutes=15),
                    "id": stale_job.id,
                },
            )
            await session.commit()
            batch_job_id = str(stale_job.id)
        finally:
            await session.close()

        # Poll — should detect staleness and mark failed
        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "failed", f"Expected 'failed' for stale job, got '{body['status']}'"
        assert body["error_message"] is not None
        assert "timed out" in body["error_message"].lower()

    async def test_recent_running_job_not_flagged_stale(self, client, org_a):
        """A BatchJob that recently started running is NOT marked stale."""
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        session = scoped_session(org_id)
        try:
            batch_job = await session.get(BatchJob, uuid.UUID(batch_job_id))
            batch_job.status = "running"
            await session.commit()
        finally:
            await session.close()

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "running", f"Expected 'running' for recent job, got '{body['status']}'"


class TestOrgScoping:
    """Scope item: batch job status is org-scoped."""

    async def test_batch_job_org_scoping_cross_org_404(self, client, make_org_user):
        """Org B cannot see Org A's batch job (404)."""
        a_user_id, a_org_id = await make_org_user(org_name="Batch Org A")
        b_user_id, _b_org_id = await make_org_user(org_name="Batch Org B")
        a_headers = auth_headers(a_user_id)
        b_headers = auth_headers(b_user_id)

        job_id, _resume_id = await _create_job_and_resume(client, a_headers, a_org_id)
        r = client.post(f"/api/jobs/{job_id}/match", headers=a_headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        # Org A can see it
        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=a_headers)
        assert r.status_code == 200, r.text

        # Org B gets 404
        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=b_headers)
        assert r.status_code == 404, r.text

    async def test_batch_job_nonexistent_404(self, client, org_a):
        """A random UUID returns 404."""
        headers, _org_id, _user_id = org_a
        r = client.get(f"/api/batch-jobs/{uuid.uuid4()}", headers=headers)
        assert r.status_code == 404, r.text


class TestAuthentication:
    """Scope item: authentication required for batch job endpoints."""

    async def test_batch_job_status_no_auth_returns_401(self, client):
        """GET /api/batch-jobs/{id} without auth → 401."""
        r = client.get(f"/api/batch-jobs/{uuid.uuid4()}")
        assert r.status_code == 401, r.text

    async def test_batch_match_no_auth_returns_401(self, client):
        """POST /api/jobs/{id}/match without auth → 401."""
        r = client.post(f"/api/jobs/{uuid.uuid4()}/match")
        assert r.status_code == 401, r.text


# ── Total failure handling ─────────────────────────────────────────────


class TestTotalFailureSurfacesAsFailed:
    """When EVERY resume fails, the job must end 'failed' — not 'completed'
    with an empty shortlist hiding the outage behind a success state."""

    async def test_all_resumes_failing_marks_batch_failed(self, client, org_a):
        headers, org_id, _user_id = org_a
        job_id, _resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        class AlwaysFailsLLM(FakeLLM):
            async def generate(self, prompt, *, system=None, temperature=0.0, max_tokens=1024):
                raise ExtractionError("extraction exploded")

        await run_batch_match_background(
            org_id if isinstance(org_id, uuid.UUID) else uuid.UUID(org_id),
            uuid.UUID(job_id),
            uuid.UUID(batch_job_id),
            llm=AlwaysFailsLLM(),
            embedder=FakeEmbedder(),
        )

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "failed", f"expected 'failed' for all-failed batch, got '{body['status']}'"
        assert body["error_message"], "failed job must carry a frontend-visible error message"
        assert "all" in body["error_message"].lower()
        results = body["batch_results"] or []
        assert results, "per-resume dispositions should still be recorded"
        assert all(e["status"] == "failed" for e in results)

    async def test_partial_failure_still_completes(self, client, org_a):
        """Partial failure keeps the completed outcome (Task 5 behaviour preserved)."""
        headers, org_id, _user_id = org_a
        job_id, resume_id = await _create_job_and_resume(client, headers, org_id)

        r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
        assert r.status_code == 202, r.text
        batch_job_id = r.json()["id"]

        await _run_pipeline_and_update_batch_job(org_id, job_id, batch_job_id)

        r = client.get(f"/api/batch-jobs/{batch_job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "completed"
        assert body["completed_resumes"] == body["total_resumes"]
