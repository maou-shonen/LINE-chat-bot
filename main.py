"""Uvicorn entrypoint: `uv run uvicorn main:app`."""
from app.app import create_app

app = create_app()
