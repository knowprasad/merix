FROM python:3.11.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app/backend

# PyMuPDF's Linux wheel needs the font/rendering runtime libraries at import
# time. Keep the image lean while making the documented PDF path runnable.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates libglib2.0-0 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.8.17

COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY backend/src ./src

EXPOSE 8000

CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn merix.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
