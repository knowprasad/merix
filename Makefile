.PHONY: test lint frontend-lint frontend-build build

test:
	cd backend && uv run pytest tests/unit -q

lint:
	cd backend && uv run ruff check src/ tests/ && uv run ruff format --check src/ tests/

frontend-lint:
	cd frontend && npm run lint

frontend-build:
	cd frontend && npm run build

build:
	docker build -t merix-backend .
