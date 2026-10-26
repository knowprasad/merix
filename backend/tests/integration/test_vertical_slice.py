"""End-to-end integration test of the vertical slice.

Overrides the LLM + embedding clients with fakes (no external API keys needed)
but uses the REAL database, exercising: create job -> upload resume -> batch
match (async) -> ranked results, with full explainability persisted — all under
an authenticated, org-scoped session, as in production.
"""

import uuid

import pytest

from merix.db import scoped_session
from merix.services import pipeline
from tests.helpers import FakeEmbedder, FakeLLM, auth_headers, make_pdf


@pytest.fixture
async def org_a(make_org_user):
    """An authenticated Org A user (headers carry a valid access token)."""
    user_id, _org_id = await make_org_user(org_name="Slice Org")
    return auth_headers(user_id), _org_id


async def test_vertical_slice_end_to_end(client, org_a):
    headers, org_id = org_a

    # 1. create job
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
    assert job["parsed"]["required_skills"] == ["python", "sql"]

    # 2. upload a resume PDF (now async: 202 Accepted with BatchJobStatus;
    #    extraction/embedding run in process_resume_background, which
    #    TestClient executes before returning)
    pdf = make_pdf("Jane Doe. Built Python services and optimised SQL for 3 years.")
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("jane.pdf", pdf, "application/pdf")},
        data={"candidate_name": "Jane Doe", "consent_given": "true"},
        headers=headers,
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] in ("queued", "running", "completed")
    assert body["total_resumes"] == 1

    # Consent fields live on the persisted resume row now.
    from sqlalchemy import select as sa_select

    from merix.models.resume import Resume

    async with scoped_session(org_id) as session:
        resume_row = (await session.scalars(sa_select(Resume).where(Resume.job_id == uuid.UUID(job_id)))).one()
        assert resume_row.candidate_name == "Jane Doe"
        assert resume_row.consent_given is True
        assert resume_row.consent_timestamp is not None
        assert resume_row.retention_expires_at is not None

    # 3. submit batch match (now async — returns 202 with BatchJobStatus)
    r = client.post(f"/api/jobs/{job_id}/match", headers=headers)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "queued"
    assert body["total_resumes"] == 1
    assert body["completed_resumes"] == 0
    assert body["job_description_id"] == job_id

    # BackgroundTasks don't execute in TestClient; simulate the work so the
    # persisted shortlist endpoints have data to serve.
    session = scoped_session(org_id)
    try:
        jd = await pipeline.get_job_or_404(session, uuid.UUID(job_id), org_id)
        await pipeline.run_match_for_job(session, FakeLLM(), FakeEmbedder(), jd)
    finally:
        await session.close()

    # 4. get ranked shortlist (persisted)
    r = client.get(f"/api/jobs/{job_id}/matches", headers=headers)
    assert r.status_code == 200, r.text
    shortlist = r.json()
    assert shortlist["count"] == 1
    assert shortlist["results"][0]["candidate_name"] == "Jane Doe"
    assert shortlist["results"][0]["score_breakdown"]["version"] == 1
    assert shortlist["results"][0]["score_breakdown"]["required_contribution"] == 70.0
    assert shortlist["results"][0]["score_breakdown"]["experience_years"] == 3.0

    # 5. get single match by id
    match_id = shortlist["results"][0]["id"]
    r = client.get(f"/api/matches/{match_id}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == match_id
    assert r.json()["score_breakdown"]["required_coverage"] == 1.0
    assert r.json()["score_breakdown"]["preferred_coverage"] == 0.0


async def test_upload_rejects_non_pdf(client, org_a):
    headers, _org_id = org_a
    r = client.post("/api/jobs", json={"title": "T", "raw_text": "x"}, headers=headers)
    job_id = r.json()["id"]
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("evil.txt", b"not a pdf", "text/plain")},
        data={"consent_given": "true"},
        headers=headers,
    )
    assert r.status_code in (400, 415, 422), r.text


async def test_match_unknown_job_404(client, org_a):
    headers, _org_id = org_a
    r = client.post(f"/api/jobs/{uuid.uuid4()}/match", headers=headers)
    assert r.status_code == 404, r.text
