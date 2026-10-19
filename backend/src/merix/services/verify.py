"""Link verification: liveness + GitHub existence checks for resume links.

Authenticity layer of the evidence graph. Links extracted from resumes point
to third-party profiles; this module checks they actually resolve and that
GitHub usernames exist. Results are ADVISORY FLAGS for recruiters, never
rejection signals ("flag, don't reject").

SSRF posture (link URLs come from untrusted resumes):
  - only allowlisted profile hosts are checked; everything else is "skipped"
  - every check DNS-resolves the host and requires all-public IPs
    (guard reused from services.jd_fetch)
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlparse

import httpx

from merix.core.exceptions import ValidationError
from merix.services.jd_fetch import _assert_public_host

logger = logging.getLogger("merix.services.verify")

VERIFY_TIMEOUT_SECONDS = 5.0
# Bound concurrent probes: profile hosts (LinkedIn especially) throttle
# aggressive probing from one IP. Order of results still follows input order.
VERIFY_PROBE_CONCURRENCY = 4
MAX_REDIRECTS = 3

# Hosts eligible for liveness checking (boundary-aware suffix match).
VERIFIABLE_HOST_SUFFIXES = (
    "linkedin.com",
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "dribbble.com",
    "behance.net",
    "medium.com",
    "dev.to",
    "substack.com",
)

_GITHUB_USER_RE = re.compile(r"^github\.com/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})/?$")


def _host_verifiable(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == s or host.endswith("." + s) for s in VERIFIABLE_HOST_SUFFIXES)


def _github_username(url: str) -> str | None:
    """Extract the username from a bare github.com/profile URL (no repo path)."""
    host_and_path = url.replace("https://", "").replace("http://", "").rstrip("/")
    match = _GITHUB_USER_RE.match(host_and_path)
    if not match:
        return None
    user = match.group(1)
    # Reserved paths that are not profiles.
    return None if user.lower() in {"orgs", "topics", "features", "about", "pricing", "settings"} else user


async def check_liveness(client: httpx.AsyncClient, url: str) -> dict:
    """One liveness probe: HEAD first, GET fallback. Never raises."""
    result: dict = {"url": url, "status": "error", "http_status": None, "checked_at": None}
    try:
        response = await _safe_request(client, "HEAD", url)
        if response.status_code == 405:  # many sites reject HEAD
            response = await _safe_request(client, "GET", url)
        result["http_status"] = response.status_code
        if response.status_code < 400:
            result["status"] = "ok"
        elif response.status_code in (404, 410):
            result["status"] = "dead"
        else:
            # 403 bot-walls etc. are inconclusive, not dead.
            result["status"] = "unknown"
    except httpx.HTTPError as exc:
        logger.info("link_check_failed host=%s error=%s", urlparse(url).hostname, exc)
    except ValidationError as exc:
        logger.info("link_check_blocked host=%s error=%s", urlparse(url).hostname, exc)
        result["status"] = "skipped"
    result["checked_at"] = datetime.now(tz=UTC).isoformat()
    return result


async def _safe_request(client: httpx.AsyncClient, method: str, url: str) -> httpx.Response:
    """Follow redirects only after re-validating every destination host."""
    current_url = url
    for _ in range(MAX_REDIRECTS + 1):
        await _assert_public_host(urlparse(current_url).hostname or "")
        response = await client.request(method, current_url, follow_redirects=False)
        if not response.is_redirect:
            return response
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(current_url, location)
    raise httpx.TooManyRedirects("too many redirects while verifying resume link")


async def check_github_user(client: httpx.AsyncClient, username: str) -> str | None:
    """Check a GitHub profile exists via the public API.

    Returns 'ok' | 'dead' | 'unknown' (rate-limited or network trouble).
    """
    try:
        response = await _safe_request(client, "GET", f"https://api.github.com/users/{username}")
    except httpx.HTTPError:
        return "unknown"
    if response.status_code == 200:
        return "ok"
    if response.status_code == 404:
        return "dead"
    return "unknown"  # 403 rate limit etc.


async def verify_resume_links(links: list[dict[str, str]], client: httpx.AsyncClient | None = None) -> list[dict]:
    """Verify all links on a resume. Returns results safe for parsed JSONB.

    Probes run with bounded concurrency (httpx.AsyncClient is safe for
    concurrent requests); results keep input order regardless of completion
    order. Inject ``client`` (MockTransport) in tests; a fresh real client
    otherwise.
    """
    if client is not None:
        owned = False
    else:
        client = httpx.AsyncClient(timeout=VERIFY_TIMEOUT_SECONDS)
        owned = True

    semaphore = asyncio.Semaphore(VERIFY_PROBE_CONCURRENCY)

    async def verify_one(link: dict[str, str]) -> dict:
        url = link.get("url", "")
        if not url or not _host_verifiable(url):
            return {"url": url, "status": "skipped", "http_status": None, "checked_at": None}
        async with semaphore:
            result = await check_liveness(client, url)
            username = _github_username(url)
            if username is not None:
                result["github_profile"] = await check_github_user(client, username)
                # A live api.github.com/user 200 corroborates the page probe;
                # a 404 is strong evidence of a fabricated profile.
                if result["github_profile"] == "dead":
                    result["status"] = "fabricated"
                    result.pop("http_status", None)  # page probe status is noise now
            return result

    try:
        return list(await asyncio.gather(*(verify_one(link) for link in links)))
    finally:
        if owned:
            await client.aclose()
