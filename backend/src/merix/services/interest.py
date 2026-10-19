"""Landing-page interest signups (design-partner leads)."""

import logging

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from merix.models.interest import InterestSignup
from merix.schemas.interest import InterestRequest

logger = logging.getLogger("merix.services.interest")


async def submit(db: AsyncSession, body: InterestRequest) -> dict:
    """Upsert a lead by lowercased email; honeypot hits are swallowed.

    Returns the same response shape either way so bots learn nothing.
    """
    if body.website:
        logger.warning("interest_signup: honeypot triggered, discarding")
        return {"status": "received"}

    normalized = body.email.strip().lower()
    # The app role is intentionally INSERT-only for this pre-auth table. Use
    # the functional unique index as the conflict target instead of probing
    # first (which would require SELECT and defeat the privacy boundary).
    statement = insert(InterestSignup).values(email=normalized).on_conflict_do_nothing(index_elements=[text("lower(email)")])
    await db.execute(statement)
    await db.commit()
    return {"status": "received"}
