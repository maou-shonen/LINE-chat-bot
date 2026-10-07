"""App settings from environment. App-level secrets only; per-bot
credentials come from the webhook URL path by design."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "sqlite:///./line.db"
    GOOGLE_SAFE_BROWSING_KEY: str = ""
    IMGUR_CLIENT_ID: str = ""
    DEVELOPER_USER_ID: str = ""
    DEVELOPER_BOT_TOKEN: str = ""
    LINE_API_BASE_URL: str = "https://api.line.me"
    LINE_DATA_API_BASE_URL: str = "https://api-data.line.me"
    LOG_LEVEL: str = "INFO"
