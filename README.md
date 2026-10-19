<div align="center">

# Merix

**Explainable, evidence-grounded resume matching — built for recruiters and campus placement teams**

[![Live Demo](https://img.shields.io/badge/Live_Demo-merix--cyan.vercel.app-2563eb?style=for-the-badge&logo=vercel)](https://merix-cyan.vercel.app)
[![CI](https://github.com/prsdx/merix/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/prsdx/merix/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## 📋 Table of Contents

- [About](#about)
- [Features](#features)
- [Live Demo](#live-demo)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
- [Environment Variables](#environment-variables)
- [Testing & Linting](#testing--linting)
- [Deployment](#deployment)
- [API Overview](#api-overview)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## 🧠 About

**Merix** is an AI-powered resume-to-job-description matching platform designed for modern recruiters and campus placement teams.

Unlike traditional ATS systems that act as "black boxes" — rewarding keyword-stuffing and rejecting strong candidates who use different terminology — Merix provides **explainable, evidence-grounded match scores** by carefully comparing candidates' actual skills against job requirements, with verbatim rationale extracted directly from each resume.

Built from day one to comply with India's **Digital Personal Data Protection (DPDP) Act**, Merix handles consent tracking, retention policies, PII scrubbing, and candidate right-to-erasure as first-class features.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Batch Matching** | Upload one Job Description (JD) and up to 100 resumes (PDF) in a single batch. Receive an asynchronously ranked shortlist of candidates. |
| **Explainable AI** | Every match score shows exactly which skills matched (required vs preferred), which are missing, and verbatim evidence quoted directly from the candidate's resume. |
| **Weighted Score Breakdown** | Transparent 70/20/10 weighted scoring with per-candidate drill-down, score threshold filters (All / 80+ / 70+ / 60+), and CSV export. |
| **DPDP Compliance** | Explicit consent gates before upload, configurable retention policies with automatic sweepers, PII scrubbing before LLM calls, immutable audit logging, and candidate right-to-erasure endpoints. |
| **Multi-Tenancy** | Fully isolated organizations via PostgreSQL Row-Level Security (RLS) on Supabase. |
| **Provider-Agnostic AI** | Swappable LLM/embedding clients (Groq, OpenAI, Google Gemini) behind clean abstractions — no business logic changes required. |
| **Real-Time Batch Status** | Live progress polling with partial-failure breakdowns and itemized candidate streams during processing. |
| **Production-Ready Backend** | Async FastAPI server, layered architecture (routes → services → repositories → models), robust background task management, and rate limiting. |

---

## 🌐 Live Demo

> **The application is deployed and available at:** **[https://merix-cyan.vercel.app](https://merix-cyan.vercel.app)**

The frontend is hosted on Vercel and talks to the FastAPI backend deployed on Render.

> ⚠️ **Note:** The Render free tier spins the backend down after 15 minutes of inactivity. The first request may take 30–60 seconds while the instance cold-starts.

---

## 🛠 Tech Stack

### Backend
- **Framework**: FastAPI (fully async), Python 3.11+
- **Database**: PostgreSQL + pgvector (Supabase)
- **ORM / Migrations**: SQLAlchemy 2.0 (async, NullPool) + Alembic
- **AI Providers**: Groq (LLM inference), Google Gemini (embeddings) — provider-agnostic client layer
- **Document Parsing**: PyMuPDF with strict input validation (size limits, magic bytes, corrupt/encrypted/scanned rejection)
- **Auth**: Supabase Auth (GoTrue) JWT verification
- **Observability**: structlog structured logging

### Frontend
- **Framework**: Next.js 16 (App Router) + TypeScript + React 19
- **Styling**: Tailwind CSS ("Apple Liquid Glass" deep `#050505` palette with frosted glass cards)
- **Animation**: Framer Motion
- **Charts**: Recharts
- **Icons**: Lucide React

### Infrastructure
- **Hosting**: Vercel (frontend) · Render (backend)
- **Data Platform**: Supabase (Postgres, Auth, Storage, RLS)

---

## 🏗 Architecture

Merix follows a clean layered architecture with strict separation of concerns:

```text
┌─────────────────────┐        ┌──────────────────────────────────┐
│   Next.js Frontend  │  HTTP  │         FastAPI Backend          │
│   (Vercel, SPA)     │◄──────►│           (Render)               │
└─────────────────────┘        └──────────────┬───────────────────┘
                                              │
                     ┌────────────────────────┼─────────────────────┐
                     ▼                        ▼                     ▼
              ┌────────────┐          ┌──────────────┐      ┌──────────────┐
              │ Supabase   │          │ LLM Provider │      │  Embeddings  │
              │ Postgres + │          │ (Groq / etc.)│      │   (Gemini)   │
              │ pgvector + │          └──────────────┘      └──────────────┘
              │ Auth + RLS │
              └────────────┘
```

Request flow inside the backend:

```text
Routes (api/v1) → Services (business logic) → Repositories (data access) → Models (SQLAlchemy)
                                        ↘ Clients (LLM / embeddings / storage abstractions)
```

Key architectural decisions:

- **Layered architecture**: routes → services → repositories → models, with external providers isolated behind client protocols.
- **Async-first**: async SQLAlchemy with NullPool, background task management for batch processing, idempotent and retry-safe batches.
- **Privacy by design**: PII is scrubbed *before* any text reaches an LLM provider.
- **Cost-conscious LLM usage**: caching, batching, and token tracking built into the pipeline.

---

## 📁 Project Structure

```text
merix/
├── backend/                  # FastAPI backend application
│   ├── src/merix/
│   │   ├── api/              # Routes (versioned v1)
│   │   ├── core/             # Security, logging, exceptions
│   │   ├── models/           # SQLAlchemy models
│   │   ├── schemas/          # Pydantic schemas
│   │   ├── services/         # Business logic (extraction, matching, DPDP)
│   │   ├── repositories/     # Data access layer
│   │   └── clients/          # LLM / embedding / storage abstractions
│   ├── migrations/           # Alembic migrations
│   ├── tests/                # Pytest unit & integration tests
│   └── README.md             # Backend-specific setup guide
├── frontend/                 # Next.js 15 frontend application
├── docs/                     # Documentation assets
├── render.yaml               # Render Blueprint for backend deployment
├── PRD.md                    # Product requirements and v1 scope
├── CONTEXT.md                # Detailed project context and current state
├── AGENT.md                  # Conventions for AI-assisted development
├── CONTRIBUTING.md           # Contribution guidelines
└── CHANGELOG.md              # Per-task feature history
```

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.11.10** (see `.python-version`)
- **Node.js 22.14.0** and npm (see `.nvmrc`)
- **[uv](https://github.com/astral-sh/uv)** — fast Python package manager
- A **Supabase** project (PostgreSQL + pgvector + Auth + Storage)
- API keys for an LLM provider (**Groq**) and an embeddings provider (**Google Gemini**)

### Backend Setup

1. **Clone the repository and enter the backend directory:**

   ```bash
   git clone https://github.com/prsdx/merix.git
   cd merix/backend
   ```

2. **Install dependencies:**

   ```bash
   uv sync
   ```

3. **Configure environment variables:**

   ```bash
   cp .env.example .env
   # Edit .env with your Supabase connection string and API keys
   ```

4. **Apply database migrations:**

   ```bash
   uv run alembic upgrade head
   ```

5. **Start the development server:**

   ```bash
   uv run uvicorn merix.main:app --reload --app-dir src
   ```

6. **Verify it's running:**
   - Interactive API docs: <http://localhost:8000/docs>
   - Health check: <http://localhost:8000/health>

### Frontend Setup

1. **Enter the frontend directory and install dependencies:**

   ```bash
   cd ../frontend
   npm install
   ```

2. **Configure the backend URL:**

   Create a `.env.local` file in `frontend/` pointing at your backend instance:

   ```bash
   NEXT_PUBLIC_API_URL=http://localhost:8000
   ```

3. **Start the development server:**

   ```bash
   npm run dev
   ```

4. Open **<http://localhost:3000>** in your browser.

---

## 🔐 Environment Variables

Backend configuration lives in `backend/.env` (see `backend/.env.example`):

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (`postgresql+asyncpg://...`) — Supabase Postgres + pgvector |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` | LLM provider config (e.g., Groq, `openai/gpt-oss-120b`) |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | Embeddings provider config (e.g., Google, `gemini-embedding-001`) |
| `STORAGE_PROVIDER` / `STORAGE_BUCKET` | Resume file storage (Supabase Storage) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase project URL and service key |
| `SUPABASE_JWT_SECRET` | Secret used to verify Supabase GoTrue JWTs locally |
| `ADMIN_API_TOKEN` | Shared token (via `X-Admin-Token`) required to trigger the retention sweep in production. Leave empty in development. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Use `"*"` only in development. |

Frontend configuration lives in `frontend/.env.local`:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the Merix backend API |

> 🔒 **Security note:** Retention is configured per organization (default 90 days) via `PATCH /api/orgs/me`. All PII is scrubbed before being sent to any LLM provider.

---

## 🧪 Testing & Linting

Run the offline unit-test gate from the repository root:

```bash
make test
```

The integration suite needs PostgreSQL + pgvector; CI provisions an ephemeral
container for it and runs it on pushes to `main` and nightly. Run it locally
with `cd backend && uv run pytest tests/integration -v` when a test database is
available.

Lint and format with Ruff:

```bash
make lint
make frontend-lint
```

The CI pipeline runs lint, unit tests, and migration-drift checks on every
push/PR. The containerized integration suite runs on `main` and nightly.

---

## ☁️ Deployment

### Backend (Render)

The backend deploys to [Render](https://render.com) via the included `render.yaml` Blueprint:

1. Connect this repository to your Render account.
2. Select **New Blueprint** and let Render sync the configuration.
3. Provide values for secure environment variables marked `sync: false`:
   - `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`
   - `LLM_API_KEY`, `EMBEDDING_API_KEY`
4. Render builds (`pip install uv && uv sync --frozen`) and runs migrations before starting the service.
5. Verify with a `GET /health` request.

> ⚠️ On Render's free tier, the service sleeps after 15 minutes of inactivity (~30–60s cold start). Warm it up with a health-check ping before demos.

### Frontend (Vercel)

The frontend is deployed on [Vercel](https://vercel.com) at **[https://merix-cyan.vercel.app](https://merix-cyan.vercel.app)**:

1. Import the repository into Vercel and set the root directory to `frontend/`.
2. Set `NEXT_PUBLIC_API_URL` to the live Render backend URL.
3. Add the Vercel domain to the backend's `ALLOWED_ORIGINS`.

---

## 🔌 API Overview

Application endpoints are mounted under `/api` (the module layout remains
`api/v1`). Full interactive docs are served at `/docs` (Swagger UI).

| Area | Endpoint | Purpose |
|---|---|---|
| Health | `GET /health` | Service liveness probe |
| Jobs | `POST /api/jobs` | Create JD with semantic extraction preview |
| Jobs | `GET /api/jobs` | List org jobs with resume/match counts |
| Resumes | `POST /api/jobs/{id}/resumes` | Batch PDF upload (behind DPDP consent gate) |
| Batch | `GET /api/batch-jobs/{id}` | Poll batch processing status/progress |
| Matching | `GET /api/jobs/{id}/matches/export` | Export ranked shortlist as CSV |
| Candidates | `DELETE /api/candidates/{id}` | DPDP right-to-erasure hard delete |
| Orgs | `GET/PATCH /api/orgs/me` | Org profile + DPDP retention policy |
| Audit | `GET /api/orgs/audit-logs` | Immutable compliance audit log |
| Admin | `POST /api/admin/retention-sweep` | Trigger retention sweeper (`X-Admin-Token`) |

---

## 🗺 Roadmap

- [x] Core matching pipeline (extraction → embedding → scoring → explanation)
- [x] Auth, organizations, and multi-tenancy (Supabase RLS)
- [x] DPDP consent gate, retention policy, audit log, erasure
- [x] Security hardening (input validation, rate limiting, JWT verification)
- [x] Production frontend (9 core screens, end-to-end integration)
- [x] Vercel deployment ([live demo](https://merix-cyan.vercel.app))
- [ ] Match-score calibration evaluation set
- [ ] Multi-tenant billing/subscriptions (v2)
- [ ] Candidate self-service portal (v2)
- [ ] External ATS integrations (v2+)

See [`PRD.md`](PRD.md) for the complete product scope and [`CHANGELOG.md`](CHANGELOG.md) for per-task history.

---

## 🤝 Contributing

Contributions are welcome! Please see [`CONTRIBUTING.md`](CONTRIBUTING.md) for guidelines on code style (Ruff), Conventional Commits, branch naming, and the CI/CD pipeline.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**[🌐 Try the live app →](https://merix-cyan.vercel.app)**

</div>
