"""FastAPI app factory: single worker, one asyncio queue consumer
processing events serially in arrival order, drained on shutdown."""
import asyncio
import logging
import re
import sys
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from loguru import logger

from .db import Store
from .handler import Ctx
from .line_client import LineClient
from .settings import Settings
from .webhook import consumer, make_routes


class AppState:
    def __init__(self, settings=None):
        self.settings = settings or Settings()
        self.store = Store(self.settings.DATABASE_URL)
        self.http = httpx.Client(timeout=10.0)
        self.bots = {}
        self.queue: asyncio.Queue = asyncio.Queue()
        self.ctx = Ctx(
            store=self.store,
            settings=self.settings,
            http=self.http,
            bots=self.bots,
            line_client_factory=self.make_line_client,
        )

    def make_line_client(self, token):
        return LineClient(
            token,
            api_base=self.settings.LINE_API_BASE_URL,
            data_api_base=self.settings.LINE_DATA_API_BASE_URL,
        )


class _CallbackRedactFilter(logging.Filter):
    """Never log the webhook path: it carries channel secret + token."""

    def filter(self, record):
        args = record.args
        if isinstance(args, tuple) and len(args) == 5 \
                and isinstance(args[2], str) \
                and "/callback/" in args[2]:
            record.args = (args[0], args[1], re.sub(
                r"/callback/\S*", "/callback/***", args[2]),
                args[3], args[4])
        return True


def configure_logging(level):
    logger.remove()
    logger.add(sys.stderr, level=level.upper())
    logging.getLogger("uvicorn.access").addFilter(_CallbackRedactFilter())
    logging.getLogger().setLevel(level.upper())


def create_app(settings=None, state=None):
    app_state = state or AppState(settings)
    configure_logging(app_state.settings.LOG_LEVEL)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(consumer(app_state))
        yield
        await app_state.queue.join()
        await app_state.queue.put(None)
        await task

    app = FastAPI(lifespan=lifespan)
    app.state.app_state = app_state
    app.include_router(make_routes(app_state))
    return app
