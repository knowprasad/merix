"""Unit tests for the interest-signup service (honeypot + insert-only logic)."""

from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy.dialects.postgresql import dialect

from merix.schemas.interest import InterestRequest
from merix.services import interest


def _body(email: str = "Priya@Example.COM ", website: str = "") -> InterestRequest:
    return InterestRequest(email=email, website=website)


async def test_email_is_normalised_and_inserted_when_new():
    db = AsyncMock()

    result = await interest.submit(db, _body("Priya@Example.COM "))

    assert result == {"status": "received"}
    statement = db.execute.call_args.args[0]
    sql = str(statement.compile(dialect=dialect()))
    assert "lower(email)" in sql
    assert "ON CONFLICT" in sql
    assert statement.compile(dialect=dialect()).params["email"] == "priya@example.com"
    db.scalar.assert_not_called()
    db.commit.assert_awaited_once()


async def test_repeat_submission_uses_database_conflict_handling():
    db = AsyncMock()

    result = await interest.submit(db, _body("priya@example.com"))

    assert result == {"status": "received"}
    db.execute.assert_awaited_once()
    db.scalar.assert_not_called()
    db.commit.assert_awaited_once()


async def test_honeypot_hit_is_swallowed_without_touching_db():
    db = AsyncMock()

    result = await interest.submit(db, _body(website="http://spam.example"))

    assert result == {"status": "received"}
    db.scalar.assert_not_called()
    db.execute.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    ("bad_email", "reason"),
    [
        ("not-an-email", "missing @"),
        ("", "empty string"),
        ("a@b", "no TLD"),
        ("x" * 250 + "@example.com", "over 255 chars"),
    ],
)
def test_invalid_emails_rejected(bad_email: str, reason: str):
    with pytest.raises(ValidationError):
        InterestRequest(email=bad_email)


def test_honeypot_field_defaults_to_empty():
    body = InterestRequest(email="a@b.co")
    assert body.website == ""
