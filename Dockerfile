# Builder resolves deps with a pinned uv; final stage keeps only venv + app.
FROM python:3.15.0-slim-bookworm@sha256:45a67c38107c44863d8f1a1994857b20e2f27014c50a84b096d1d8a71667e21a AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 /uv /uvx /bin/

ENV UV_NO_CACHE=1 \
    UV_PYTHON=/usr/local/bin/python \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.15.0-slim-bookworm@sha256:45a67c38107c44863d8f1a1994857b20e2f27014c50a84b096d1d8a71667e21a

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////data/line.db \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY main.py text.yaml ./
COPY app/ ./app/
RUN mkdir -p /data && chown 1026:100 /data

USER 1026:100
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/ping').read()"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
