"""Production configuration must fail closed when security settings are absent."""

import pytest
from pydantic import ValidationError

from merix.config import Settings


def _production_settings(**overrides: str) -> dict[str, str]:
    values = {
        "ENVIRONMENT": "production",
        "DATABASE_URL": "postgresql+asyncpg://db.example/merix",
        "LLM_API_KEY": "llm-key",
        "EMBEDDING_API_KEY": "embedding-key",
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_SERVICE_KEY": "service-key",
        "SUPABASE_JWT_SECRET": "j" * 64,
        "ADMIN_API_TOKEN": "admin-token",
        "ALLOWED_ORIGINS": "https://merix.example",
    }
    values.update(overrides)
    return values


def test_production_settings_accept_complete_secure_configuration():
    settings = Settings(**_production_settings())

    assert settings.ENVIRONMENT == "production"


@pytest.mark.parametrize("missing", ["DATABASE_URL", "SUPABASE_JWT_SECRET", "ADMIN_API_TOKEN"])
def test_production_settings_reject_missing_security_configuration(missing: str):
    values = _production_settings(**{missing: ""})

    with pytest.raises(ValidationError, match="Missing production settings"):
        Settings(**values)


def test_production_settings_rejects_wildcard_cors():
    with pytest.raises(ValidationError, match="ALLOWED_ORIGINS"):
        Settings(**_production_settings(ALLOWED_ORIGINS="*"))


def test_production_settings_rejects_short_jwt_secret():
    with pytest.raises(ValidationError, match="32 characters"):
        Settings(**_production_settings(SUPABASE_JWT_SECRET="short"))
