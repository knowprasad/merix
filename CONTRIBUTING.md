# Contributing to Merix

## What runs automatically (CI)

Every push and pull request against `main` triggers the [CI workflow](.github/workflows/ci.yml). The fast tier runs on every branch; the slower database-backed tier runs on pushes to `main` and nightly:

| Job | What it runs | When it blocks merge |
|-----|-------------|----------------------|
| **Lint** | `ruff check src/ tests/` + `ruff format --check src/ tests/` | Required (must pass) |
| **Unit tests** | `pytest tests/unit -v --tb=short` | Required (must pass) |
| **Migration drift** | Fresh pgvector database + `alembic upgrade head` + `alembic check` | Required (must pass) |
| **Integration tests** | `pytest tests/integration -v --tb=short` against ephemeral pgvector | Main/nightly gate |

The unit-test and migration-drift jobs run after **Lint** passes. The
integration job additionally waits for the unit tests.

### Why the full integration test suite in CI?

Integration tests run against a disposable pgvector PostgreSQL container in CI.
This is intentional: org-isolation (RLS) tests and scoped-session tests still
exercise real PostgreSQL behaviour without sharing a development database.

---

## What still needs manual verification

- **LLM quality**: the suite uses `FakeLLM`/`FakeEmbedder` — real provider calls (Groq, Gemini) are not tested in CI.
- **Alembic migrations**: CI validates a clean migration and runs `alembic check`; production migration application still happens during the Render start command.
- **Frontend**: run `make frontend-lint` and `make frontend-build` locally.
- **GoTrue ES256 tokens**: production Supabase tokens use ES256; our verifier is HS256-only. This is a known gap (tracked in CONTEXT.md).

---

## Running CI checks locally

```bash
cd backend

# Lint
uv run ruff check src/ tests/
uv run ruff format --check src/ tests/

# Auto-fix lint issues
uv run ruff check --fix src/ tests/
uv run ruff format src/ tests/

# Offline unit-test gate (no database or provider credentials required)
make test

# Integration tests (requires PostgreSQL + pgvector)
cd backend && uv run pytest tests/integration -v --tb=short
```

---

## GitHub secrets required for CI

The fast CI tier needs no repository secrets. The containerized integration
tier also uses local test credentials and needs no Supabase secrets. Live
deployments still require these values in Render:

| Secret | Where to find it |
|--------|-----------------|
| `DATABASE_URL` | Supabase project → Settings → Database → Connection string (asyncpg format) |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase project → Settings → API → `service_role` key |
| `SUPABASE_JWT_SECRET` | Supabase project → Settings → API → JWT Secret |

---

## Branch protection (recommended — must be set manually)

Tests blocking merge requires a **Branch Protection Rule** on `main`:

1. Go to **Repository Settings → Branches → Add rule**
2. Branch name pattern: `main`
3. Enable **Require status checks to pass before merging**
4. Add `Lint (ruff)`, `Unit tests (pytest)`, and `Migration drift (alembic check)` as required checks
5. Enable **Require branches to be up to date before merging**
6. Enable **Do not allow bypassing the above settings** (optional but recommended)

This cannot be done by code — it requires repo admin access in the GitHub UI.

---

## Commit and branch conventions

See [AGENT.md](AGENT.md) for the full Git workflow (branch naming, Conventional Commits, PR rules).
