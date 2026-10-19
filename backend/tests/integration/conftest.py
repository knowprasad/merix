"""Integration-test database provisioning.

Integration tests need real Postgres with pgvector and the full schema
(all tables + the `merix_app` role + RLS policies). When DATABASE_URL points
at a local, disposable database (host is localhost/127.0.0.1 — the pgvector
service container used in CI, or a local container), this file provisions it
once per session:

  1. CREATE EXTENSION IF NOT EXISTS vector   (no migration does this)
  2. alembic upgrade head                     (schema + role + RLS from scratch)

When DATABASE_URL points at a hosted database (e.g. the shared dev Supabase),
provisioning is skipped and tests use it as-is (previous behaviour).
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine

from merix.config import settings

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1"}


async def _enable_vector_extension() -> None:
    """CREATE EXTENSION vector — the one thing migrations don't own."""
    engine = create_async_engine(settings.DATABASE_URL)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.commit()
    finally:
        await engine.dispose()


def _migrate_to_head() -> None:
    """Bring the (empty/fresh) database to the latest migration head."""
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=_BACKEND_ROOT,
        check=True,
    )


@pytest.fixture(scope="session", autouse=True)
def _provision_local_database():
    """Provision the local database once per test session (idempotent)."""
    host = (make_url(settings.DATABASE_URL).host or "").lower()
    if host not in _LOCAL_DB_HOSTS:
        yield
        return

    asyncio.run(_enable_vector_extension())
    _migrate_to_head()
    yield
