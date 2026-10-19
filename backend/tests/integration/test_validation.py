"""Input-validation hardening tests (Task 4).

Each test pins one validation gap found during the security sweep:
unbounded upload reads, unbounded form/body fields, and the admin-only
retention-sweep trigger.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from merix.config import settings
from tests.helpers import auth_headers, make_pdf


@pytest.fixture
async def org_a(make_org_user):
    user_id, _org_id = await make_org_user(org_name="Validation Org")
    return auth_headers(user_id)


def _create_job(client: TestClient, headers: dict) -> str:
    r = client.post("/api/jobs", json={"title": "T", "raw_text": "Python and SQL"}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_upload_oversized_file_returns_413(client, org_a):
    job_id = _create_job(client, org_a)
    oversized = b"%PDF-1.4\n" + b"0" * (5 * 1024 * 1024)  # just over the 5 MB cap
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("big.pdf", oversized, "application/pdf")},
        data={"consent_given": "true"},
        headers=org_a,
    )
    assert r.status_code == 413, r.text


async def test_upload_candidate_name_over_255_chars_returns_422(client, org_a):
    job_id = _create_job(client, org_a)
    pdf = make_pdf("Jane Doe. Built Python services for three years.")
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("jane.pdf", pdf, "application/pdf")},
        data={"candidate_name": "x" * 256, "consent_given": "true"},
        headers=org_a,
    )
    assert r.status_code == 422, r.text


async def test_create_job_raw_text_over_limit_returns_422(client, org_a):
    r = client.post(
        "/api/jobs",
        json={"title": "T", "raw_text": "x" * 50_001},
        headers=org_a,
    )
    assert r.status_code == 422, r.text


async def test_login_password_over_128_chars_returns_422(client):
    r = client.post(
        "/api/auth/login",
        json={
            "email": f"{uuid.uuid4().hex[:12]}@example.com",
            "password": "p" * 129,
        },
    )
    assert r.status_code == 422, r.text


async def test_many_page_pdf_is_rejected(client, org_a):
    """A pathological multi-hundred-page PDF must be rejected before parsing burns CPU."""
    from tests.helpers import make_multi_page_pdf

    job_id = _create_job(client, org_a)
    pdf = make_multi_page_pdf(150)
    r = client.post(
        f"/api/jobs/{job_id}/resumes",
        files={"file": ("pages.pdf", pdf, "application/pdf")},
        data={"consent_given": "true"},
        headers=org_a,
    )
    assert r.status_code == 422, r.text


async def test_retention_sweep_requires_admin_token_when_configured(client, org_a, monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_API_TOKEN", "secret-admin-token")
    r = client.post("/api/admin/retention-sweep", headers=org_a)
    assert r.status_code == 403, r.text
    r = client.post(
        "/api/admin/retention-sweep",
        headers={**org_a, "X-Admin-Token": "secret-admin-token"},
    )
    assert r.status_code == 200, r.text


async def test_retention_sweep_fails_closed_in_production_without_token(client, org_a, monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "ADMIN_API_TOKEN", "")

    r = client.post("/api/admin/retention-sweep", headers=org_a)

    assert r.status_code == 403, r.text
