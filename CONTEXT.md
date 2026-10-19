# Merix - Project Context

> Read this file first to get up to speed on Merix without reading the entire codebase. Updated at the end of every task.

---

## What is Merix?

Merix is an AI-powered resume-to-job-description matching platform for Indian recruiters and campus placement teams. It helps recruiters rank candidates against job descriptions with explainable, evidence-grounded match scores.

---

## ⚠️ Product Stage (read before writing any user-facing copy)

Merix is **pre-launch / prototype stage with zero real users**. The product is real and works end-to-end, but there is no production traffic and no customers yet.

Rules for all user-facing copy (landing page, in-app text, docs, outreach):

- Frame performance figures ("<8 min per 100 resumes") as **design targets / built-for capabilities**, never as measured or observed results.
- **No fabricated social proof**: no invented testimonials, customer names, adopter institutions, or fake "live activity" stats. Illustrative examples must be labelled as such.
- **No unearned compliance claims**: say "built for DPDP Act 2023 compliance", never "certified".
- Stage indicators (e.g. "Prototype · building with early users") should be honest but confident — early-stage-startup register, not apologetic.

---

## Who is it for?

- **Primary**: Indian campus placement cells and staffing agencies processing hundreds of resumes per job opening
- **Secondary**: Individual recruiters at Indian companies hiring for technical and non-technical roles

---

## What problem does it solve?

Traditional ATS systems are black boxes: they reject resumes with no explanation, reward keyword-stuffing, and punish strong candidates who phrase things differently. Merix provides:

- **Batch matching**: Upload 100 resumes + 1 JD, get ranked shortlist
- **Explainability**: Every match score shows which skills matched, with verbatim evidence from the resume
- **DPDP compliance**: Consent tracking, data retention, PII handling for Indian data protection law

---

## Current Architecture

**Backend**: FastAPI (async) + PostgreSQL/pgvector (Supabase) + SQLAlchemy 2.0 (async, **env-gated pooling** — `QueuePool` in production, NullPool in dev/test) + Alembic (migrations applied)

**Frontend**: Next.js 16 (App Router) + TypeScript + Tailwind CSS + Framer Motion (in `frontend/`)

**Status**: Tasks 1–11 complete. **Task 12 (link parsing) complete** — see below. Tasks 1–9 (full production frontend wired to real FastAPI backend, unified design, all 9 screens verified live with 73 passing backend tests) plus **Task 11: Backend performance pass** — async engine connection pooling (env-gated QueuePool in production, NullPool retained in dev/test to avoid pytest-asyncio cross-event-loop issues), async single-resume upload via BatchJob infrastructure (202 + poll), and worker/health-check configuration review.

### Task 12: Links + Timeline + JD-from-URL + UI (Evidence Graph — Phases A–D)

- `services/links.py` extracts LinkedIn/GitHub/portfolio links from resume PDFs (annotations + text layer), normalises and classifies them, and they persist in `Resume.parsed["links"]` — extracted **before** `scrub_pii`, so the LLM never sees URLs but recruiters get structured identity anchors.
- `services/timeline.py` deterministically analyses the LLM-extracted work history (`parsed["timeline"]`) into tenure spans, union-based total experience, overlaps, and gaps (`parsed["timeline_analysis"]`) — experience facts no longer rest on the LLM's arithmetic.
- `services/jd_fetch.py` + `POST /api/jobs/from-url`: create a job by pasting a career-board URL (greenhouse/lever/ashby always allowed; other domains behind `JD_FETCH_ALLOW_ANY_DOMAIN`). SSRF-guarded: public IPs only, manual redirect re-validation, size/time caps.
- Candidate detail page renders an Evidence Graph card (career timeline + profile-link chips) via the new `GET /api/jobs/{job_id}/resumes/{resume_id}` endpoint.
### Task 13: Link Verification (Evidence Graph — authenticity layer)

- `services/verify.py` runs post-upload: liveness probes + GitHub existence checks on resume links → `parsed["link_verification"]` advisory flags (`ok / dead / fabricated / unknown / error / skipped`). Allowlist-only probing with the shared SSRF DNS guard; toggle via `LINK_VERIFY_ENABLED`. Recruiters see status dots on link chips. Flag-don't-reject throughout.
- Remaining evidence-graph roadmap: corroboration scoring & evidence-weighted matching v2.

### Task 15: Landing-page honesty pass (copy/framing only)

The landing page presented prototype-stage claims as proven, live product usage. Fixed without touching design/layout/interactions:
- Hero subheadline + trust chips reframed as designed-for capability; added "Prototype · Building with Early Users" badge; fabricated adopter-institution marquee replaced with target-audience segments.
- Stats band's fabricated live activity (142 screened today / 116 shortlisted) relabelled as explicit design targets.
- Hero demo "Purge" button relabelled "Pass"; pipeline-story copy aligned.
- Six fabricated testimonials (fictional named people + measured metrics) replaced with first-party designed-outcome cards under an illustrative kicker; new "What stage is Merix at?" FAQ.
- Removed false "DPDP Certified" banner claim and fake "All systems operational" footer status.

### Task 16: Early-access design-partner signup (landing page)

One-field interest capture for the prototype's "building with early users" story:
- **Backend**: `POST /api/interest` (public, pre-auth) — email-only schema with an invisible honeypot field (non-empty ⇒ silently discarded), slowapi rate limit `5/hour` per IP (`INTEREST_RATE_LIMIT`), service upserts by lowercased email so repeats never duplicate or 409.
- **Storage**: new `interest_signups` table (id, email case-insensitive unique via `lower(email)` index, source, timestamps). Deliberately INSERT-only for `merix_app`: RLS insert-only policy and **no SELECT grant**, so leads are never readable through the API — only via Supabase service role/dashboard.
- **Frontend**: `EarlyAccessSection` between FAQ and final CTA — single email input + submit button (zero friction by design), success/error states, wired via `api.submitInterest()`.
- **Storage**: submissions use PostgreSQL `INSERT ... ON CONFLICT DO NOTHING` so the INSERT-only app role never needs a forbidden SELECT.
- ⚠️ **Deploy note**: migration `c41f9a7de208` applies automatically on next Render deploy (`alembic upgrade head` in start command); verify `alembic current == heads` against production after deploying.

### Task 19: Reliability, security, and reproducibility pass

- Fixed the staged CI workflow indentation so GitHub Actions parses the two-tier pipeline correctly.
- Fixed early-access signup against the INSERT-only database grant by using a functional-index conflict-safe insert.
- Fixed three frontend/backend contract bugs: audit-log path, batch result status (`completed`), and CSV export now uses an authenticated fetch instead of leaking a JWT in the URL.
- Hardened production startup: missing database/provider/auth/admin settings, short JWT secrets, and wildcard CORS now fail closed; retention sweep cannot be triggered without an admin token in production.
- Hardened resume-link verification by re-validating every redirect destination against the SSRF public-host guard.
- Added `.python-version`, `.nvmrc`, root `Makefile`, backend `Dockerfile`, and `.dockerignore`; refreshed setup/CI documentation for reproducible local and container workflows.

### Task 20: Truthful score explainability + recruiter UI polish

- `MatchComputation` now produces a versioned deterministic `score_breakdown` with required/preferred/experience coverage, exact match counts, adjacent semantic credit, and weighted point contributions.
- `match_results.score_breakdown` is persisted through a nullable JSONB migration (`8c2a4f6d91b7`), so legacy rows remain readable without fabricated component values. Newly matched rows expose the breakdown through shortlist and dossier responses.
- Candidate dossier renders the backend values directly with accessible contribution bars and an explicit legacy-row warning when re-matching is needed.
- Ranked shortlist improvements include clearer empty/error/retry states, exact-vs-adjacent-vs-gap legend, keyboard-accessible expandable evidence rows, stronger focus states, responsive overflow handling, and clearer adjacent-match percentages.
- Completed batch result entries now include candidate name and score for the processing stream.








### Project Structure

```
backend/
├── src/merix/        # FastAPI app
│   ├── api/          # Routes (v1)
│   ├── core/         # Security, logging, exceptions
│   ├── models/       # SQLAlchemy models
│   ├── schemas/      # Pydantic schemas
│   ├── services/     # Business logic
│   ├── repositories/ # Data access
│   └── clients/      # LLM/embedding/storage abstractions
├── tests/
└── scripts/
```

---

## What's Been Built

- **Task 0**: Project scaffolding
  - Clean FastAPI backend structure with modular separation (api/services/repositories/clients)
  - Provider-agnostic LLM/embedding/storage client protocols
  - AGENT.md with house style and conventions
  - CONTEXT.md (this file)
  - PRD.md with v1 product requirements
  - Git workflow setup (Conventional Commits, branch naming, CHANGELOG)
  - GitHub templates (PR, issue templates)

- **Task 1**: Core matching pipeline (vertical slice, end-to-end)
  - **Models + schema** (`models/`): JobDescription, Resume, MatchResult. MatchResult carries explainability (matched_skills, missing_skills, rationale). Resume has DPDP fields (consent_given, consent_timestamp, retention_expires_at). pgvector embedding columns (dim 1536). Alembic migrations applied to live Supabase DB.
  - **Text extraction** (`services/extraction.py`): PyMuPDF PDF extraction with input validation (5MB limit, magic bytes, corrupt/encrypted/scanned rejection) and PII scrubbing.
  - **Clients** (`clients/`): GroqLLMClient + embedding clients behind provider-agnostic protocols (LLMClient/EmbeddingClient). Default embedding provider is **Google Gemini** (gemini-embedding-001, dim 768); OpenAI also implemented. Provider factory `get_embedding_client(provider=...)` -> swap providers via `.env` only. Token-usage logging for cost tracking.
  - **Matching** (`services/matching.py`): LLM structured extraction (temp=0) -> deterministic Python skill comparison -> weighted score (required 70% / preferred 20% / experience 10%) -> LLM rationale. Explainable by construction.
  - **Pipeline** (`services/pipeline.py`): orchestrates create_job / add_resume / run_match_for_job / list_matches.
  - **API** (`api/v1/`): POST /api/jobs, GET /api/jobs/{id}, POST /api/jobs/{id}/resumes, POST /api/jobs/{id}/match, GET /api/jobs/{id}/matches, GET /api/matches/{id}. Pydantic validation, domain-exception-to-HTTP mapping (404/413/415/422/409/400).
  - **Tests**: 17 passing (10 unit: matching + extraction; 3 integration: full vertical slice against live DB with fake LLM/embedding clients).

- **Task 2**: Auth + multi-tenancy (Supabase Auth + Postgres RLS)
  - **Auth provider**: Supabase Auth (GoTrue) - passwords never touch our DB; clients/auth.py is a minimal httpx GoTrue client (admin create/delete + password grant). Signup = org + auth identity + profile in one flow; orphan GoTrue users cleaned up on DB rollback.
  - **Token verification**: local HS256 verify of GoTrue access tokens (core/security.py), aud=authenticated, sub=user UUID -> profile lookup in public.users.
  - **Models/migration**: Organisation + User (id = auth.users UUID, single role per user, single org per user); org_id NOT NULL FK on job_descriptions/resumes/match_results. Task 1 NULL-org test data discarded in the migration (confirmed disposable).
  - **Row-level security**: FORCE RLS + org_isolation policy on all three tenant tables; app connections SET ROLE merix_app (non-superuser, so RLS binds) and pin app.current_org_id per transaction via scoped_session(org_id). Unset context fails closed (NULLIF '' -> NULL). Cross-org access returns 404 (no existence leak), enforced in the pipeline's org filter AND at the DB layer.
  - **API**: POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me. All Task 1 routes now require auth and auto-scope to the caller's org. 401s: missing/invalid/expired token, unknown user.
  - **Tests**: 32 passing (14 unit + 18 integration). New: six 401 auth failure paths, signup/login via in-memory GoTrue fake, Org-B-cannot-access-Org-A via API (all five endpoints), direct RLS proof (scoped session can't SELECT/forge foreign-org rows; unscoped fails closed).
  - **Verified live**: two real GoTrue signups -> real sessions -> Org A full pipeline (score 80.0) -> Org B 404 on job/match/matches; 401 on missing/garbage token. Proof data cleaned up.

- **Task 3**: DPDP consent / retention / erasure / audit
  - **Consent gate** (`services/consent.py`): resume upload requires `consent_given=true` (Form field, 400 ValidationError otherwise). `record_consent` stamps `consent_given`, `consent_timestamp`, and `retention_expires_at` server-side (never trusts client clocks) using the org's retention policy.
  - **Org retention policy** (`models/organisation.py`): `retention_days` per org (default 90, DB column via migration; the old global `DATA_RETENTION_DAYS` env setting was removed - retention is org-level now). GET/PATCH `/api/orgs/me` reads/updates it (PATCH validates 1-3650 days).
  - **Audit log** (`models/audit.py`): append-only `audit_events` table (org_id, nullable resume_id with SET NULL so the trail survives deletion, event_type, actor_type user/system, actor_user_id, JSONB metadata). FORCE RLS + org_isolation policy + grants to merix_app, same pattern as the tenant tables.
  - **Retention/erasure service** (`services/retention.py`): `delete_resume` (hard-delete + audit event), `sweep_expired_for_org` (deletes expired resumes in one org-scoped session so RLS binds), `sweep_all_orgs` (per-org sessions). DELETE `/api/candidates/{resume_id}` = data-principal erasure right (cascades match results, writes `deletion_requested` audit event). POST `/api/admin/retention-sweep` triggers the sweep as a background task.
  - **Migration** `2072dab8609b` (applied to live DB): audit_events table + RLS, organisations.retention_days.
  - **Tests**: 5 new integration tests (consent rejection, consent stamping + 90-day expiry, manual deletion removes resume+matches+audits, retention sweep deletes expired, org retention-policy update). Pre-existing org-isolation and vertical-slice tests updated for the consent field. 37 total passing.

- **Task 4**: Security hardening pass
  - **Dependency audit**: pip-audit across all backend deps — 0 known vulnerabilities. Frontend npm audit — 0 vulnerabilities (Vite CVEs already fixed in chore a4002cf).
  - **Secrets review**: no hardcoded keys/tokens/credentials in git history or current codebase. `.env` is gitignored (confirmed). `.env.example` lists every config var with placeholders only (including ADMIN_API_TOKEN, ALLOWED_ORIGINS). InsecureKeyLengthWarning resolved (test HMAC key ≥ 32 bytes; real JWT_SECRET length is user decision).
  - **Input validation hardening**: capped upload reads (MAX_FILE_BYTES+1 cap), Field max_length on all schemas (title, org_name, password, candidate_name, raw_text, email), PDF page cap (100 pages), admin-token sweep gate. 6 validation tests. No SQL injection surfaces found — all queries use SQLAlchemy parameterized API.
  - **Rate limiting**: slowapi on signup (5/hour) and login (10/minute) per client IP. 2 tests with in-memory GoTrue fake.
  - **CORS**: ALLOWED_ORIGINS env var (comma-separated, defaults to "*" in dev). CORSMiddleware with allow_credentials=True.
  - **Logging review**: all 8 logger calls audited across auth, pipeline, retention, llm, and embeddings modules. No PII (emails, tokens, resume content) logged. Only UUIDs, token counts, and model names.
  - **RLS re-verification**: rapid sequential alternation test (Org A/B sessions interleaved 2× — no cross-org leak); SESSION-scoped GUC variant test documents where a real connection-pool regression would surface. Both pass under NullPool.
  - **RLS policy fix**: Migration `26f49b7b8456` grants merix_app full access to organisations/users tables (RLS was enabled but no app policy existed, breaking signup under the app role).
  - 39 tests total (14 unit + 25 integration): +2 rate-limit tests, +2 RLS bleed-through tests.

- **Task 5**: Background job robustness (async batch matching with status tracking) — reused by single-resume async upload (Task 11).
  - **BatchJob model** (`models/batch_job.py`): status lifecycle (queued→running→completed/failed), org_id, job_description_id, idempotency_key (optional UUID for deduplication), total_resumes, completed_resumes (progress tracking), batch_results (JSONB array of per-resume disposition), error_message (for failed jobs)
  - **Migration** `13aafa45b687` (applied to live DB): batch_jobs table with RLS policies, grants merix_app full access
  - **Async batch matching**: POST `/api/jobs/{job_id}/match` returns 202 Accepted immediately, creates BatchJob with status="queued", enqueues `run_batch_match_background` via BackgroundTasks
  - **Status endpoint**: GET `/api/batch-jobs/{batch_job_id}` returns current status and progress; stale detection marks jobs failed if running > 10 minutes without update
  - **Background task** (`services/batch.py`): creates own DB session (independent of request), updates status queued→running→completed/failed, processes each resume independently with try/except, tracks progress after each resume, records per-resume results in batch_results JSONB
  - **Partial failure handling**: one bad resume doesn't fail the whole batch; failures recorded in batch_results with specific error; job status is "completed" even if some resumes failed
  - **Stale job detection**: on startup (marks any "running" jobs as failed for server crash recovery); on polling (marks failed if updated_at > 10 minutes ago)
  - **Idempotency**: optional idempotency_key prevents duplicate jobs for the same submission
  - **Retry strategy**: "surface-and-let-client-resubmit" (no auto-retry); client must resubmit failed jobs; `run_match_for_resume` is idempotent (upserts), so re-running is safe
  - **BackgroundTasks evaluation**: still sufficient for current requirements (jobs are short-lived, no distributed workers needed, no job scheduling needed); no Celery/Redis required
  - 14 new integration tests covering submission, status polling, completion, idempotency, partial failure, stale detection, org scoping, authentication - 53 tests total

- **Task 6**: CI pipeline (GitHub Actions)
  - **Workflow** (`.github/workflows/ci.yml`): two-job pipeline on every push and PR
    - `Lint (ruff)`: `ruff check src/ tests/` + `ruff format --check src/ tests/` — no secrets needed
    - `Test (pytest)`: `pytest -v --tb=short` — full 53-test suite (unit + integration) against real Supabase DB; runs only after lint passes
  - **Ruff config**: line-length bumped 88→130 to match actual code style; 35 auto-fixable violations cleared (trailing newlines, unused import)
  - **Status badge**: CI badge in README.md showing main branch state
  - **CONTRIBUTING.md**: documents CI jobs, required secrets, branch protection steps, and local dev commands
  - **Why real Supabase (not local pgvector container)**: RLS correctness tests (org isolation, scoped_session) require real Postgres row-level security; faking the DB defeats the purpose of those tests
  - Required secrets: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`
  - Branch protection (required status checks) must be configured manually in GitHub repo settings by a repo admin

- **Task 7**: Live deployment configuration (Render free tier)
  - **Render configuration** (`render.yaml`): Web service blueprint deploying FastAPI backend via `uv sync --frozen` and `uvicorn merix.main:app --host 0.0.0.0 --port $PORT`.
  - **Workers**: single uvicorn worker retained — Render free tier is 512MB / 0.1 CPU; 2+ workers risk OOM with no throughput gain. Latency was diagnosed as connection-pool, not worker-starvation.

  - **Health check** (`/health` and `/ready`): `GET /health` verifies app liveness and database connectivity (`SELECT 1`). Also mounted at `/api/health`.
  - **Render free tier cold-start behavior**: Render free tier instances spin down after 15 minutes of inactivity, requiring ~30-60 seconds on initial cold-start. For live demo pitches, hit `GET /health` 1 minute prior to demo start to warm the container.
  - **Dev/prod shared Supabase tradeoff & Demo Org convention**: We intentionally use a shared Supabase project for dev and demo to conserve cost and infrastructure complexity pre-launch. To ensure messy dev test runs do not pollute pitch demos, all demo data is quarantined under a dedicated tagged demo organisation (e.g. `Demo Placement Cell`), cleanly isolated by PostgreSQL Row-Level Security (`org_isolation` policy). Full project-level Supabase separation is scheduled before onboarding live candidate PII.
  - **Environment configuration**: All secrets (`DATABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `LLM_API_KEY`, `EMBEDDING_API_KEY`, `ADMIN_API_TOKEN`) are configured in Render environment variables (never committed). CORS `ALLOWED_ORIGINS` is configurable per environment.
  - **Domain**: Render default subdomain (`*.onrender.com`); custom domain (`merix.in` or similar) deferred until domain purchase.
  - 3 new health check integration tests (56 tests total passing).

- **Task 8**: Frontend design exploration
  - 10 distinct runnable design directions created and evaluated.
  - Direction chosen: **v5 conversion structure** (high-converting B2B SaaS layout with centered hero, social proof, feature zigzag, ROI metrics) + **v7 Apple Liquid Glass aesthetic & palette** (deep `#050505` dark mode, ambient glowing orbs, frosted glass cards `bg-white/[0.03] backdrop-blur-2xl border border-white/10`, violet/blue data accents).

- **Task 9**: Full production frontend implementation & design upgrade (Next.js 15 App Router)
  - **Design Read & Palette (Editorial Authority Direction)**:
    - High-contrast `#070709` ink background, `#E8E6E1` warm parchment text, `#00D4AA` teal-cyan precision data accent, `#22C55E` emerald DPDP compliance indicators, and amber-to-emerald score spectrum.
    - Typography: `@fontsource/dm-serif-display` for authoritative headlines, `@fontsource/jetbrains-mono` for verbatim evidence citations and audit log records, and Inter for crisp UI controls.
  - **Core Interactive Components**:
    - `ScoreRing`: Animated radial SVG progress ring with glow filter, JetBrains Mono readout, and score color thresholds (80+ emerald, 60-79 amber, <60 orange).
    - `CountUp`: Viewport-triggered animated metric counters utilizing Framer Motion for high-impact trust metrics.
    - `DPDPBadge`: 5 standardized compliance markers (pill, subtle, banner, row, stamp) threaded through every candidate touchpoint.
  - **All 9 Production Screens (Fully Integrated to Backend API)**:
    1. **Landing page (`/`)**: Asymmetric hero with live interactive deterministic match sandbox simulator, trust band with tier-1 Indian academic institutions, proof strip with animated counters, 3-pillar architectural zigzag, 5-dimension comparison table vs legacy keyword ATS, ROI efficiency calculator, testimonials with Indian campus placement roles, DPDP compliance FAQ, and closing CTA.
    2. **Sign up & Login (`/signup`, `/login`)**: Two-pane trust-forward layout with organization creation, Supabase GoTrue JWT session management, row-level security isolation context, and form validation.
    3. **Dashboard (`/dashboard`)**: Active pipeline metrics with animated counters, search filter, job cards with DPDP row badges, resume/match counts, per-job delete button (confirmation-gated `DELETE /api/jobs/{id}`), and 3-step guided empty state.
    4. **Post a Job (`/jobs/new`)**: Semantic JD parser form with live sample technical JD generator calling `POST /api/jobs` and live structured extraction preview.
    5. **Batch Resume Upload (`/jobs/[jobId]/upload`)**: Drag-and-drop batch PDF ingestion with prominent **DPDP Consent Gate Card** (explicit legal consent affirmation required before upload) calling `POST /api/jobs/{id}/resumes`.
    6. **Job Processing Status (`/jobs/[jobId]/status/[batchJobId]`)**: Real-time progress bar polling `GET /api/batch-jobs/{id}` (every 1.5s) with partial failure breakdown and itemized candidate stream.
    7. **Ranked Shortlist (`/jobs/[jobId]/results`)**: Flagship candidate data table with radial `ScoreRing` centerpieces, verified skill tags, missing gap chips, score threshold filters (All, 80+, 70+, 60+), search across candidate name / matched skills / missing skills, bulk row selection with select-all and scoped "Export Selected" CSV, and direct full-shortlist CSV export via `GET /api/jobs/{id}/matches/export`. Score-filter and search state persist in URL query params (`?min_score=&q=`) so navigating to a dossier and back preserves them.
    8. **Candidate Detail Drill-down (`/jobs/[jobId]/candidates/[matchId]`)**: 70/20/10 weighted score breakdown bar chart, verbatim AI rationale, skill matrix with resume quotes, DPDP compliance stamp, and DPDP Candidate Right to Erasure modal (`DELETE /api/candidates/{id}`).
    9. **Settings & Compliance (`/settings`)**: Org profile, DPDP Retention Policy editor (GET/PATCH `/api/orgs/me`), live immutable audit log view (`GET /api/orgs/audit-logs`), and ATS Integration placeholders.
  - **Backend API additions**: `GET /api/jobs` (list all org jobs with resume/match counts) and `GET /api/orgs/audit-logs` (list audit events).
  - **Verification**: Next.js 15 production build passes with exit code 0 across all 9 static and dynamic routes. Backend test suite passing cleanly.

- **Task 13**: Ranked Results bulk actions, search & URL-persisted filters; job deletion for HR
  - **Bulk selection & scoped export** (`results/page.tsx`): checkbox per candidate row + header select-all (indeterminate when partial); bulk action bar with client-side "Export Selected" CSV (mirrors server export columns) and Clear Selection.
  - **Search** extended to missing-skill text; composes with the min-score threshold filter.
  - **URL state**: `min_score` + `q` query params via `useSearchParams()` + debounced `router.replace`; `<Suspense>` boundary added (Next 16 requirement).
  - **Job deletion**: org-scoped `DELETE /api/jobs/{job_id}` (DB-level cascade to resumes/match_results/batch_jobs, DPDP audit event `job_deleted`) + confirmation-gated delete button on dashboard job cards.
  - **Verification**: production builds pass (`next build` exit 0) after each step; `ruff check src/ tests/` clean. Integration tests require live Supabase credentials not present in this workspace — failures verified identical on the unmodified tree (baseline check); all unit tests pass.

- **Task 15**: Semantic adjacent-skill matching (exact-first, additive fallback)
  - `matching.compute_match()` keeps its exact normalized comparison as the first, fastest path — unchanged and pinned by the original unit tests. When an embedder is provided, JD skills that missed exactly fall back to **per-skill embedding cosine similarity** against unconsumed resume skills; ≥ `ADJACENT_SIMILARITY_THRESHOLD` (**0.80**) classifies as "adjacent" instead of missing. One-to-one greedy assignment; adjacent credit = cosine (fractional coverage, never > exact).
  - **Cost**: ≤1 `embed_batch` call per match computation + bounded process-local cache keyed by normalized skill string (`_SKILL_EMBEDDING_CACHE`). Embedder failures degrade to exact-only (`semantic_fallback_embed_failed` log).
  - **Data**: no migration — JSONB `matched_skills` entries gain `match_type`/`similar_to`/`similarity`; absent keys read as exact (legacy-safe). Production verified `alembic current == heads` (`c41f9a7de208`). Both call sites (`pipeline.run_match_for_resume`, `batch.run_batch_match_background`) thread the embedder through.
  - **UI**: blue `.tag-adjacent` pill (new `--accent-adjacent*` tokens) renders `≈ skill (N% similar)` on results rows/drawer; candidate-detail cards show an Adjacent badge + "not a verbatim keyword match" note; rationale labels adjacent skills; both CSV exports annotate. Exact=green, adjacent=blue, gap=gold.
  - **Verification**: 82 unit tests pass (9 new semantic-path tests in `tests/unit/test_matching_semantic.py` incl. threshold boundaries via scripted vectors, batching/dedupe, cache hits, graceful degradation); `FakeEmbedder` rewritten to hash-seeded dissimilar vectors (constant vectors would make every pair cosine 1.0). Live check vs `gemini-embedding-001`: Postgres↔PostgreSQL 0.840 and Kubernetes↔K8s 0.876 surface as adjacent; unrelated pairs stay missing. `next build` exit 0.

- **Task 16**: LLM response guard — pattern-level fix for the truncation → JSONDecodeError bug class
  - **The bug class closed**: max_tokens truncation → malformed JSON → unhandled 500 was patched twice at separate call sites (`extract_resume`, `extract_jd`) with duplicated parse/log/raise logic. All LLM calls now route through a single shared wrapper so a third call site can't reintroduce it.
  - **`core/llm_guard.py`** (new): `generate_json()` — calls the client, validates the response is complete *and* well-formed JSON (markdown-fence tolerant; capped-but-parseable responses are treated as untrusted too), retries **once** at a doubled token budget, then raises the typed `ExtractionError`. Raw `JSONDecodeError` can never escape. `generate_text()` — same policy for plain text: truncation detected via provider `finish_reason == "length"` plus a mid-sentence heuristic (cap-hit + no terminal punctuation), one retry, typed error — silently clipped rationales are gone.
  - **Routing**: `matching.extract_jd`, `matching.extract_resume`, `matching.generate_rationale` are now thin wrappers over the guard (audited: these are the only LLM call sites in the codebase; budgets unchanged — JD 2048 / resume 4096 / rationale 512). Prompts and extraction/matching logic untouched.
  - **Observability**: every failed attempt logs structured context for Render logs: `llm_response_invalid call=<name> attempt=N/2 reason=malformed_json|truncated completion_tokens=… finish_reason=… raw_head=…`.
  - **Tests**: 11 new tests in `tests/unit/test_llm_guard.py` pin the pattern (truncated→retry-doubled→success, persistent truncation→typed error ≠ JSONDecodeError, rationale recovery/failure, heuristic path, logging). Budget-pinning and regression tests in `test_matching.py` updated to the shared behavior. Full suite: **148/148** after also fixing 4 stale integration call sites that still called `run_match_for_job(session, llm, jd)` without the Task-15 `embedder` argument (pre-existing breakage, verified identical on the unmodified tree via baseline run before fixing).

### Task 17: Deploy-migration safety (the `match_results.status` outage class)

- **What happened**: migration `b4e8f2a19c73` (`match_results.status`) existed in the repo but was never applied to production; deployed code assumed the column → outage. Root cause: deploys didn't run migrations automatically and nothing failed when models drifted from the DB schema.
- **Deploy-time migration (mechanism confirmed)**: the service runs on Render's **free plan**, where Pre-Deploy Commands are unavailable — so the correct mechanism is the chained start command, already fixed post-incident in `render.yaml`: `uv run alembic upgrade head && uv run uvicorn …`. It is fail-closed (failed migration → container never boots → health check fails → no bad deploy serves traffic). On upgrade to a paid plan, move to `preDeployCommand: uv run alembic upgrade head` (documented inline in render.yaml).
- **CI drift gate**: new `migration-drift` GitHub Actions job — spins up an ephemeral `pgvector/pgvector:pg16` service container, enables the `vector` extension (no migration creates it; it was provisioned manually on Supabase), runs `alembic upgrade head` against the empty DB (proves migrations build the full schema from scratch), then `alembic check` (fails the build if model changes lack a migration). Limitation (inherent to autogenerate comparison): cannot catch what autogenerate can't see — enum value changes, data-only migrations, permission changes.
- **Drift fix found en route**: `alembic check` immediately caught real drift — migration `c41f9a7de208` creates a functional unique index on `lower(email)`, but `InterestSignup` never declared it, so autogenerate wanted to remove it. Fixed on the model side (`__table_args__` functional index), migration history untouched.
- **Verification**: production `alembic current == heads == c41f9a7de208` (no further drift); `alembic upgrade head` re-run against up-to-date production = idempotent no-op (exit 0); full CI sequence rehearsed on an ephemeral scratch database (empty DB -> pgvector -> 10 migrations -> check, all exit 0); negative test confirms the gate fails on an unmigrated model change; 92 unit tests pass, ruff clean.

### Task 18: Two-tier CI pipeline

- **Problem**: every push ran the full suite; the integration half is network-bound to shared Supabase (~25–30 min/run on GitHub runners), so branch feedback was slow and concurrent runs contended on the same dev DB.
- **Split** (`ci.yml`): fast tier — Lint + Unit tests + Migration drift, ~1 minute total — runs on every push/PR. Full tier — `integration-tests` (the old DB-backed job) — gates only pushes to `main` plus a nightly schedule (`0 3 * * *`), so slow-suite regressions still block deploys.
- First run verified: lint 12s / unit 13s / drift 33s green; drift-job failure from its first attempt diagnosed via job logs (`docker ps -qf name=postgres` matched nothing because Actions names service containers after the image slug — "postgres" is only the network alias) and fixed with an `ancestor=` image filter.

---

## What's Next - Task 10: Vercel Deployment & Final Pitch-Readiness Pass

With the full production frontend and backend complete and verified end-to-end:
- **Task 10 (Next)**:
  - Deploy Next.js frontend to **Vercel** with environment variables (`NEXT_PUBLIC_API_URL` pointing to Render live backend).
  - Configure production domain / routing.
  - Final pitch-readiness polish and smoke testing on live URLs.

---

## Key Decisions

- **No backward compatibility** with old hackathon code (removed in Task 0)
- **Provider-agnostic LLM/embedding clients** so we can swap Groq/OpenAI/etc. without touching business logic
- **DPDP-aware from day one**: consent, retention, PII scrubbing
- **Cost-conscious LLM usage**: cache, batch, track tokens
- **Layered architecture**: routes → services → repositories → models

---

## Important Files

- `AGENT.md` — House style and conventions for AI-assisted development
- `PRD.md` — Product requirements and v1 scope
- `CHANGELOG.md` — Per-task history
- `backend/README.md` — Backend setup and dev guide

---

## Historical Context

This project evolved from a TechKriti 2025 hackathon prototype (Glass-Box Recruiter / PRISM). The old code has been removed; only the extraction prompt design (evidence grounding, no hallucination) and matching heuristics (weighted scoring) were preserved as design input for the new implementation.
