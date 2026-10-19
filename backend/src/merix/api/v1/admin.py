"""Admin/system endpoints (v1: retention sweep only)."""

from fastapi import APIRouter, BackgroundTasks, Depends, Header
from sqlalchemy import select

from merix.config import settings
from merix.core.exceptions import PermissionError
from merix.db import AsyncSessionLocal
from merix.dependencies import get_current_user
from merix.models.organisation import Organisation
from merix.models.user import User
from merix.services import retention

router = APIRouter()


async def _run_retention_sweep() -> None:
    """Background task: enumerate orgs and hard-delete expired resumes."""
    async with AsyncSessionLocal() as db:
        org_ids = list((await db.scalars(select(Organisation.id))).all())
    await retention.sweep_all_orgs(org_ids)


@router.post("/retention-sweep")
async def retention_sweep(
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    x_admin_token: str | None = Header(default=None),
) -> dict:
    """Trigger the DPDP retention sweep (runs asynchronously).

    Production always requires a configured operator token. Development and
    test environments may omit it for local convenience, but once a token is
    configured callers must present it in the X-Admin-Token header.
    """
    if settings.ENVIRONMENT.lower() == "production" and not settings.ADMIN_API_TOKEN:
        raise PermissionError("admin token is not configured")
    if settings.ADMIN_API_TOKEN and x_admin_token != settings.ADMIN_API_TOKEN:
        raise PermissionError("admin token required for retention sweep")
    background_tasks.add_task(_run_retention_sweep)
    return {"detail": "retention sweep started"}
