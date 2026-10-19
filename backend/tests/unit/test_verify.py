"""Unit tests for link verification (liveness + GitHub existence)."""

import httpx
import pytest

from merix.core.exceptions import ValidationError
from merix.services import verify


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _public_ok(host: str) -> None:
    """DNS stub: pretend every host resolves to a public IP."""


async def _private_blocked(host: str) -> None:
    raise Exception(f"non-public host {host}")


@pytest.fixture(autouse=True)
def _stub_dns(monkeypatch):
    monkeypatch.setattr(verify, "_assert_public_host", _public_ok)


# --- helpers ---


def test_github_username_extraction():
    assert verify._github_username("https://github.com/jane-doe") == "jane-doe"
    assert verify._github_username("https://github.com/jane/repo") is None  # repo, not profile
    assert verify._github_username("https://github.com/orgs/merix") is None  # reserved path


def test_non_verifiable_hosts_are_skipped():
    # Directly exercise the policy helper.
    assert verify._host_verifiable("https://www.linkedin.com/in/x") is True
    assert verify._host_verifiable("https://evil.example.com/x") is False


# --- liveness ---


async def test_liveness_ok(monkeypatch):
    handler = lambda request: httpx.Response(200)  # noqa: E731
    got = await verify.check_liveness(_client(handler), "https://www.linkedin.com/in/jane")
    assert got["status"] == "ok"
    assert got["http_status"] == 200
    assert got["checked_at"]


async def test_liveness_dead_404():
    got = await verify.check_liveness(_client(lambda request: httpx.Response(404)), "https://github.com/ghost")
    assert got["status"] == "dead"


async def test_liveness_head_405_falls_back_to_get():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(200 if request.method == "GET" else 405)

    got = await verify.check_liveness(_client(handler), "https://dev.to/jane")
    assert got["status"] == "ok"
    assert calls == ["HEAD", "GET"]


async def test_liveness_bot_wall_is_unknown_not_dead():
    got = await verify.check_liveness(_client(lambda request: httpx.Response(403)), "https://www.linkedin.com/in/gated")
    assert got["status"] == "unknown"


async def test_liveness_network_error_stays_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    got = await verify.check_liveness(_client(handler), "https://github.com/nx")
    assert got["status"] == "error"


async def test_liveness_revalidates_redirect_destinations(monkeypatch):
    checked_hosts = []

    async def assert_public(host: str) -> None:
        checked_hosts.append(host)
        if host == "127.0.0.1":
            raise ValidationError("private host")

    monkeypatch.setattr(verify, "_assert_public_host", assert_public)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://127.0.0.1/internal"})

    got = await verify.check_liveness(_client(handler), "https://github.com/jane-doe")

    assert got["status"] == "skipped"
    assert checked_hosts == ["github.com", "127.0.0.1"]


# --- full resume verification flow ---


async def test_verify_resume_links_skips_unknown_domains():
    got = await verify.verify_resume_links(
        [{"url": "https://random.site/me", "type": "other"}],
        client=_client(lambda request: httpx.Response(200)),
    )
    assert got[0]["status"] == "skipped"


async def test_github_profile_dead_marks_fabricated(monkeypatch):
    monkeypatch.setattr(verify, "_assert_public_host", _public_ok)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.github.com":
            return httpx.Response(404)
        return httpx.Response(200)

    got = await verify.verify_resume_links([{"url": "https://github.com/fake-user", "type": "github"}], client=_client(handler))
    assert got[0]["status"] == "fabricated"
    assert got[0]["github_profile"] == "dead"


async def test_github_rate_limit_does_not_mark_fabricated(monkeypatch):
    monkeypatch.setattr(verify, "_assert_public_host", _public_ok)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.github.com":
            return httpx.Response(403)  # rate limited
        return httpx.Response(200)

    got = await verify.verify_resume_links([{"url": "https://github.com/realuser", "type": "github"}], client=_client(handler))
    assert got[0]["status"] == "ok"
    assert got[0]["github_profile"] == "unknown"
