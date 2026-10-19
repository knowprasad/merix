"""Unit tests for the matching service (deterministic logic + fake LLM)."""

import json
import logging

import pytest

from merix.clients.base import LLMResult
from merix.core.exceptions import ExtractionError
from merix.services import matching


class FakeLLM:
    """Fake LLMClient that returns canned JSON based on the prompt."""

    def __init__(self, jd_json: str = "", resume_json: str = "", rationale: str = "ok"):
        self._jd = jd_json
        self._resume = resume_json
        self._rationale = rationale

    async def generate(self, prompt, *, system=None, temperature=0.0, max_tokens=1024):
        if "job description" in prompt.lower():
            return LLMResult(text=self._jd, prompt_tokens=10, completion_tokens=5)
        if "resume" in prompt.lower() and "rationale" not in prompt.lower():
            return LLMResult(text=self._resume, prompt_tokens=10, completion_tokens=5)
        return LLMResult(text=self._rationale, prompt_tokens=5, completion_tokens=5)


# --- compute_match (deterministic) ---


async def test_compute_match_full_match():
    jd = {"required_skills": ["Python", "SQL"], "preferred_skills": ["AWS"], "min_experience_years": 3}
    res = {
        "skills": [
            {"skill": "Python", "evidence": "built APIs"},
            {"skill": "SQL", "evidence": "queries"},
            {"skill": "AWS", "evidence": "deployed on AWS"},
        ],
        "experience_years": 4,
    }
    mc = await matching.compute_match(jd, res)
    assert mc.score == 100.0
    assert len(mc.matched_skills) == 3
    assert mc.missing_skills == []
    assert mc.score_breakdown == {
        "version": 1,
        "required_coverage": 1.0,
        "preferred_coverage": 1.0,
        "experience_score": 1.0,
        "required_contribution": 70.0,
        "preferred_contribution": 20.0,
        "experience_contribution": 10.0,
        "required_exact_matches": 2,
        "preferred_exact_matches": 1,
        "required_adjacent_credit": 0.0,
        "preferred_adjacent_credit": 0.0,
        "required_total": 2,
        "preferred_total": 1,
        "experience_years": 4.0,
        "minimum_experience_years": 3.0,
    }


async def test_compute_match_partial():
    jd = {"required_skills": ["Python", "SQL", "Docker"], "preferred_skills": [], "min_experience_years": 5}
    res = {"skills": [{"skill": "Python", "evidence": "x"}], "experience_years": 2}
    mc = await matching.compute_match(jd, res)
    # required coverage 1/3, preferred 1.0 (none), experience 2/5
    expected = round(100 * (0.70 * (1 / 3) + 0.20 * 1.0 + 0.10 * 0.4), 1)
    assert mc.score == expected
    assert {m["skill"] for m in mc.missing_skills} == {"sql", "docker"}
    assert mc.score_breakdown["required_coverage"] == round(1 / 3, 4)
    assert mc.score_breakdown["required_contribution"] == round(70 * (1 / 3), 1)
    assert mc.score_breakdown["experience_contribution"] == 4.0


async def test_compute_match_case_insensitive_and_evidence():
    jd = {"required_skills": ["python"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "PYTHON", "evidence": "10 yrs Python"}], "experience_years": 10}
    mc = await matching.compute_match(jd, res)
    assert mc.score == 100.0
    assert mc.matched_skills[0]["evidence"] == "10 yrs Python"


async def test_compute_match_no_required_skills_is_full_coverage():
    jd = {"required_skills": [], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [], "experience_years": 0}
    assert (await matching.compute_match(jd, res)).score == 100.0


# --- JSON parsing tolerance ---


# (_parse_json fence-stripping is now pinned in tests/unit/test_llm_guard.py,
# where the parsing lives since all calls route through core.llm_guard.)


# --- LLM extraction (fake) ---


@pytest.mark.asyncio
async def test_extract_jd_uses_fake_llm():
    llm = FakeLLM(jd_json='{"required_skills": ["Go"], "preferred_skills": [], "min_experience_years": 2, "education": ""}')
    out = await matching.extract_jd(llm, "We need a Go engineer")
    assert out["required_skills"] == ["Go"]


@pytest.mark.asyncio
async def test_generate_rationale_returns_text():
    llm = FakeLLM(rationale="Strong match on Python.")
    mc = matching.MatchComputation(score=90.0, matched_skills=[{"skill": "Python", "required": True}], missing_skills=[])
    text = await matching.generate_rationale(llm, {"min_experience_years": 1}, {"experience_years": 2}, mc)
    assert text == "Strong match on Python."


# --- extraction robustness (regression: production truncation bug) ---
#
# Production incident: resume extraction ran with max_tokens=1024. Long
# resumes produced >1024-token responses, Groq truncated the JSON
# mid-string, and the raw JSONDecodeError surfaced as an unhandled 500.
# These tests pin both halves of the fix: an adequate token budget for
# long resumes, and a clean domain error when output is still malformed.


class RecordingLLM(FakeLLM):
    """FakeLLM that records every generate() call's keyword arguments."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.calls: list[dict] = []

    async def generate(self, prompt, *, system=None, temperature=0.0, max_tokens=1024):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens})
        return await super().generate(prompt, system=system, temperature=temperature, max_tokens=max_tokens)


def _long_resume_text(n_skills: int = 80) -> str:
    """Synthetic dense resume whose extraction reliably exceeds 1024 tokens."""
    lines = ["ARJUN SHARMA", "Senior Software Engineer - Bengaluru, India", ""]
    lines.append("SKILLS")
    for i in range(n_skills):
        lines.append(f"- Skill {i}: used across multiple production services with measurable impact")
    lines += [
        "",
        "EXPERIENCE",
        "Principal Engineer, BigCo (2018-present)",
        "Led platform team, cut p99 latency 40%, mentored 12 engineers.",
    ]
    return "\n".join(lines)


def _resume_json_with(n_skills: int) -> str:
    """Valid extraction JSON at a realistic size for a dense resume."""
    skills = [{"skill": f"Skill {i}", "evidence": f"used Skill {i} across production services"} for i in range(n_skills)]
    return json.dumps({"skills": skills, "experience_years": 7, "education": "B.Tech"})


@pytest.mark.asyncio
async def test_long_resume_gets_full_token_budget():
    """A dense resume's extraction call must request >= 4096 completion tokens."""
    llm = RecordingLLM(resume_json=_resume_json_with(80))
    out = await matching.extract_resume(llm, _long_resume_text())
    assert len(out["skills"]) == 80
    resume_calls = [c for c in llm.calls if "resume" in c["prompt"].lower()]
    assert resume_calls, "extract_resume did not issue an LLM call"
    assert all(c["max_tokens"] >= matching._RESUME_EXTRACT_MAX_TOKENS for c in resume_calls)


@pytest.mark.asyncio
async def test_extract_resume_truncated_json_raises_domain_error():
    """Truncated LLM output must raise ExtractionError, not leak JSONDecodeError."""
    llm = FakeLLM(resume_json='{"skills": [{"skill": "Python", "evidence": "built serv')
    with pytest.raises(ExtractionError, match="resume_extraction"):
        await matching.extract_resume(llm, "Arjun Sharma - Python developer")


@pytest.mark.asyncio
async def test_extract_resume_truncated_json_is_retryable_not_jsondecode():
    """ExtractionError must not be a JSONDecodeError subclass alias — callers catch it explicitly."""
    llm = FakeLLM(resume_json='{"skills": ["pyth')
    with pytest.raises(json.JSONDecodeError):
        # sanity: raw parsing of truncated text really does fail
        json.loads('{"skills": ["pyth')
    with pytest.raises(ExtractionError):
        await matching.extract_resume(llm, "some resume text")


@pytest.mark.asyncio
async def test_extract_jd_malformed_json_raises_domain_error():
    llm = FakeLLM(jd_json='{"required_skills": ["Go", ')
    with pytest.raises(ExtractionError, match="jd_extraction"):
        await matching.extract_jd(llm, "We need a Go engineer")


# --- rationale budget & truncation handling ---
# generate_rationale returns plain text, so a too-small max_tokens never
# crashes anything — it silently clips the explanation mid-sentence. These
# tests pin the budget and the guard behaviour: a capped rationale retries
# once at a doubled budget and only surfaces as ExtractionError if still
# truncated (never served silently).


@pytest.mark.asyncio
async def test_generate_rationale_gets_full_token_budget():
    """Rationale calls must request >= 512 completion tokens."""
    llm = RecordingLLM(rationale="Strong match.")
    await matching.generate_rationale(
        llm,
        {"required_skills": ["go"], "min_experience_years": 2},
        {"experience_years": 3},
        matching.MatchComputation(score=90.0),
    )
    rationale_calls = [c for c in llm.calls if "matched a job" in c["prompt"].lower()]
    assert rationale_calls, "generate_rationale did not issue an LLM call"
    assert all(c["max_tokens"] >= matching._RATIONALE_MAX_TOKENS for c in rationale_calls)


@pytest.mark.asyncio
async def test_generate_rationale_retries_then_raises_when_still_truncated(caplog):
    """A length-capped rationale must never be served silently: the guard
    retries at a doubled budget and raises the typed error if still capped."""

    class TruncatingLLM(FakeLLM):
        async def generate(self, prompt, *, system=None, temperature=0.0, max_tokens=1024):
            return LLMResult(
                text="Strong match on most required skil",
                prompt_tokens=10,
                completion_tokens=max_tokens,
                finish_reason="length",
            )

    with caplog.at_level(logging.ERROR, logger="merix.core.llm_guard"):
        with pytest.raises(ExtractionError, match="rationale_generation"):
            await matching.generate_rationale(
                TruncatingLLM(),
                {},
                {},
                matching.MatchComputation(score=50.0),
            )
    assert any("llm_response_invalid" in r.getMessage() and "call=rationale_generation" in r.getMessage() for r in caplog.records)


def test_llmresult_truncated_flag():
    """truncated is True only for finish_reason == length."""
    assert LLMResult(text="x", finish_reason="length").truncated
    assert not LLMResult(text="x", finish_reason="stop").truncated
    assert not LLMResult(text="x").truncated
