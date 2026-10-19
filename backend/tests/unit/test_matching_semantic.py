"""Unit tests for the semantic adjacent-match fallback in compute_match.

The exact-normalized path must stay untouched (first, fastest, transparent);
these tests pin the additive fallback: per-skill embedding cosine similarity,
the 0.80 threshold, one-to-one greedy assignment, cache behaviour, and
graceful degradation when the embedding provider fails.
"""

import logging

import pytest

from merix.services import matching


class ScriptedEmbedder:
    """EmbeddingClient fake with explicit per-string vectors.

    Vectors are looked up by normalised string; an unexpected request fails
    the test. Records batch-call count and requested strings for cache
    assertions.
    """

    def __init__(self, vectors: dict[str, list[float]]):
        self._vectors = {matching._normalise(k): v for k, v in vectors.items()}
        self.batch_calls = 0
        self.embedded: list[str] = []

    async def embed(self, text: str):
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts):
        self.batch_calls += 1
        self.embedded.extend(texts)
        out = []
        for t in texts:
            key = matching._normalise(t)
            if key not in self._vectors:
                raise AssertionError(f"unexpected embed request: {t!r}")
            out.append(list(self._vectors[key]))
        return out


class ExplodingEmbedder(ScriptedEmbedder):
    """Simulates a provider outage."""

    async def embed_batch(self, texts):
        raise RuntimeError("embedding provider down")


def unit_2d(x: float, y: float) -> list[float]:
    norm = (x * x + y * y) ** 0.5
    return [x / norm, y / norm]


@pytest.fixture(autouse=True)
def _clear_cache():
    """Isolate the process-local skill-embedding cache per test."""
    matching._SKILL_EMBEDDING_CACHE.clear()
    yield
    matching._SKILL_EMBEDDING_CACHE.clear()


# --- adjacent match surfaces ---


async def test_adjacent_skill_surfaces_instead_of_missing():
    # cos([1,0],[3,1]) = 3/sqrt(10) ≈ 0.949 — clearly above threshold.
    embedder = ScriptedEmbedder({"postgres": [1.0, 0.0], "postgresql": unit_2d(3, 1)})
    jd = {"required_skills": ["Postgres"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "PostgreSQL", "evidence": "built Postgres schemas"}], "experience_years": 2}

    mc = await matching.compute_match(jd, res, embedder)

    assert mc.missing_skills == []
    assert len(mc.matched_skills) == 1
    entry = mc.matched_skills[0]
    assert entry["match_type"] == "adjacent"
    assert entry["skill"] == "PostgreSQL"  # resume's evidenced skill wins
    assert entry["similar_to"] == "postgres"  # JD requirement it satisfies
    assert entry["evidence"] == "built Postgres schemas"
    assert 0.80 <= entry["similarity"] <= 1.0
    # Fractional credit: required coverage is the similarity, not 1.0.
    expected_score = round(
        100.0 * (matching.W_REQUIRED * entry["similarity"] + matching.W_PREFERRED * 1.0 + matching.W_EXPERIENCE * 1.0), 1
    )
    assert mc.score == expected_score
    assert mc.score_breakdown["required_adjacent_credit"] == entry["similarity"]
    assert mc.score_breakdown["required_coverage"] == entry["similarity"]
    assert mc.score_breakdown["required_contribution"] == round(70 * entry["similarity"], 1)


async def test_unrelated_skills_stay_missing():
    # Orthogonal vectors -> cosine 0, far below threshold.
    embedder = ScriptedEmbedder({"matlab": [1.0, 0.0], "flamenco dancing": [0.0, 1.0]})
    jd = {"required_skills": ["MATLAB"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "Flamenco Dancing", "evidence": "taught workshops"}], "experience_years": 1}

    mc = await matching.compute_match(jd, res, embedder)

    assert {m["skill"] for m in mc.missing_skills} == {"matlab"}
    assert mc.matched_skills == []
    expected = round(100.0 * (matching.W_REQUIRED * 0.0 + matching.W_PREFERRED * 1.0 + matching.W_EXPERIENCE * 1.0), 1)
    assert mc.score == expected


async def test_below_threshold_pair_stays_missing():
    # cos([1,0],[1,1]) ≈ 0.707 — related-ish but below the 0.80 threshold.
    embedder = ScriptedEmbedder({"hadoop": [1.0, 0.0], "hive": unit_2d(1, 1)})
    jd = {"required_skills": ["Hadoop"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "Hive", "evidence": "etl jobs"}], "experience_years": 3}

    mc = await matching.compute_match(jd, res, embedder)

    assert {m["skill"] for m in mc.missing_skills} == {"hadoop"}
    assert all(m.get("match_type") != "adjacent" for m in mc.matched_skills)


# --- exact path untouched ---


async def test_exact_match_short_circuits_and_skips_embedding():
    embedder = ScriptedEmbedder({})  # any embed request would fail the test
    jd = {"required_skills": ["Python", "SQL"], "preferred_skills": ["AWS"], "min_experience_years": 3}
    res = {
        "skills": [
            {"skill": "Python", "evidence": "built APIs"},
            {"skill": "SQL", "evidence": "queries"},
            {"skill": "AWS", "evidence": "deployed"},
        ],
        "experience_years": 4,
    }

    mc = await matching.compute_match(jd, res, embedder)

    assert embedder.batch_calls == 0
    assert mc.score == 100.0
    assert mc.missing_skills == []
    assert all(m["match_type"] == "exact" for m in mc.matched_skills)
    # Exact entries carry no similarity payload.
    assert all("similarity" not in m and "similar_to" not in m for m in mc.matched_skills)


async def test_no_embedder_behaves_exactly_like_before():
    jd = {"required_skills": ["Python", "Docker"], "preferred_skills": [], "min_experience_years": 5}
    res = {"skills": [{"skill": "Python", "evidence": "x"}], "experience_years": 2}

    mc = await matching.compute_match(jd, res, None)

    assert {m["skill"] for m in mc.missing_skills} == {"docker"}
    assert all(m["match_type"] == "exact" for m in mc.matched_skills)
    assert mc.score == round(100 * (0.70 * (1 / 2) + 0.20 * 1.0 + 0.10 * 0.4), 1)


# --- assignment & batching semantics ---


async def test_one_resume_skill_satisfies_at_most_one_jd_skill():
    # Both JD skills are closest to the same resume skill; only the best pair
    # is promoted, the other stays missing.
    # cos(postgres, postgresql)  = 20/sqrt(401) ≈ 0.999  <- winner
    # cos(mysql,    postgresql) ≈ 0.859                  <- also adjacent, loses
    embedder = ScriptedEmbedder(
        {
            "postgres": [1.0, 0.0],
            "mysql": unit_2d(3, 2),
            "postgresql": unit_2d(20, 1),
        }
    )
    jd = {"required_skills": ["Postgres", "MySQL"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "PostgreSQL", "evidence": "rds"}], "experience_years": 1}

    mc = await matching.compute_match(jd, res, embedder)

    adjacent = [m for m in mc.matched_skills if m["match_type"] == "adjacent"]
    assert len(adjacent) == 1
    assert adjacent[0]["similar_to"] == "postgres"
    assert {m["skill"] for m in mc.missing_skills} == {"mysql"}


async def test_embed_calls_are_batched_and_deduped():
    embedder = ScriptedEmbedder(
        {
            "docker": unit_2d(3, 1),
            "kubernetes": unit_2d(3, 1),
            "container tools": unit_2d(3, 1),
        }
    )
    jd = {"required_skills": ["Docker", "Kubernetes"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "Container Tools", "evidence": "orchestration"}], "experience_years": 2}

    await matching.compute_match(jd, res, embedder)

    # One provider call for all three distinct strings — not one per skill,
    # and no duplicate requests for strings appearing on both sides.
    assert embedder.batch_calls == 1
    assert sorted(s.lower() for s in embedder.embedded) == ["container tools", "docker", "kubernetes"]


async def test_cache_prevents_repeat_embed_calls():
    vectors = {"python": [1.0, 0.0], "pyhton": unit_2d(3, 1)}
    first = ScriptedEmbedder(vectors)
    second = ScriptedEmbedder(vectors)  # separate instance, shared process-local cache
    jd = {"required_skills": ["Pyhton"], "preferred_skills": [], "min_experience_years": 0}
    res = {"skills": [{"skill": "Python", "evidence": "x"}], "experience_years": 1}

    await matching.compute_match(jd, res, first)
    await matching.compute_match(jd, res, second)

    assert first.batch_calls == 1
    assert second.batch_calls == 0  # fully served from the process-local cache


# --- graceful degradation ---


async def test_embedder_failure_degrades_to_exact_only(caplog):
    embedder = ExplodingEmbedder({})
    # A leftover resume skill keeps the fallback path alive long enough to hit
    # the provider outage; the result must still be the exact-only answer.
    jd = {"required_skills": ["Python", "ObscureTool"], "preferred_skills": [], "min_experience_years": 0}
    res = {
        "skills": [
            {"skill": "Python", "evidence": "x"},
            {"skill": "Knitting", "evidence": "weekend hobby"},
        ],
        "experience_years": 5,
    }

    with caplog.at_level(logging.ERROR, logger="merix.services.matching"):
        mc = await matching.compute_match(jd, res, embedder)  # must not raise

    assert {m["skill"] for m in mc.missing_skills} == {"obscuretool"}
    assert [m["skill"] for m in mc.matched_skills] == ["Python"]
    assert any("semantic_fallback_embed_failed" in r.getMessage() for r in caplog.records)
