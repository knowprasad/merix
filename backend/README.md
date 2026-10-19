# Merix Backend

FastAPI backend for Merix - AI-powered resume-to-job-description matching platform.

## Prerequisites

- Python 3.11+
- [uv](https://github.com/astral-sh/uv) (package manager)
- PostgreSQL 14+ with pgvector extension (or Supabase)

## Setup

1. **Install dependencies**:
   ```bash
   uv sync
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. **Run the development server**:
   ```bash
   uv run uvicorn merix.main:app --reload --app-dir src
   ```

4. **Access the API**:
   - API docs: http://localhost:8000/docs
   - Health check: http://localhost:8000/health

## Project Structure

```
src/merix/
├── api/          # FastAPI routes (versioned)
├── core/         # Security, logging, exceptions
├── models/       # SQLAlchemy models
├── schemas/      # Pydantic schemas
├── services/     # Business logic
├── repositories/ # Data access
└── clients/      # External provider abstractions
```

## Development

### Run tests

```bash
uv run pytest
```

### Lint and format

```bash
uv run ruff check .
uv run ruff format .
```

### Database migrations

Apply migrations to Supabase Postgres:
```bash
uv run alembic upgrade head
```

## Deployment (Render)

The backend is configured for deployment on [Render](https://render.com) using `render.yaml` Blueprint or as a Web Service:

- **Runtime**: Python 3.11
- **Root Directory**: `backend`
- **Build Command**: `pip install uv && uv sync --frozen`
- **Start Command**: `uv run alembic upgrade head && uv run uvicorn merix.main:app --host 0.0.0.0 --port $PORT`
- **Health Check Path**: `/health`

> **Note on Free Tier**: Render's free instances spin down after 15 minutes of inactivity (~30-60s cold-start). For live demos, send a `GET /health` request 1 minute prior to demo start to warm up the instance.

## Environment Variables

See `.env.example` for all required environment variables.

## API Documentation

Once the server is running, visit `http://localhost:8000/docs` (or your deployed Render URL `/docs`) for interactive API documentation (Swagger UI).
