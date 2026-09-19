"""AeroShield - typed application settings.

Loaded once at import and reused. Everything comes from the environment or
backend/.env (see .env.example), so nothing here needs editing to deploy.

Why pydantic-settings rather than os.getenv: a mistyped AEROSHIELD_MAX_IMAGE_MB
fails loudly at startup instead of becoming the string "12" and blowing up inside
a size comparison during a flight.
"""

from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/core/config.py -> backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    """Application configuration, read from the AEROSHIELD_* environment."""

    model_config = SettingsConfigDict(
        env_prefix="AEROSHIELD_",
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- database ---------------------------------------------------------
    database_url: str = Field(
        default="postgresql+asyncpg://aeroshield:aeroshield_dev@localhost:5432/aeroshield"
    )
    test_database_url: str = Field(
        default="postgresql+asyncpg://aeroshield:aeroshield_dev@localhost:5432/aeroshield_test"
    )
    db_echo: bool = False

    # --- app --------------------------------------------------------------
    env: str = "development"
    debug: bool = True
    storage_dir: str = "storage"
    max_image_mb: int = 12

    # --- cors -------------------------------------------------------------
    # Typed as a plain string, NOT List[str], on purpose. pydantic-settings
    # JSON-decodes any complex-typed field before field validators run, so a
    # comma-separated .env value would raise a SettingsError at import time and no
    # `mode="before"` validator could rescue it. Splitting is done in the
    # cors_origin_list property instead.
    cors_origins: str = (
        "http://localhost:3000,http://localhost:5173,"
        "http://127.0.0.1:3000,http://127.0.0.1:5173"
    )

    # --- pagination -------------------------------------------------------
    default_page_size: int = 50
    max_page_size: int = 500

    # --- api keys ---------------------------------------------------------
    bootstrap_admin_key: str = ""

    @field_validator("database_url", "test_database_url")
    @classmethod
    def _require_async_driver(cls, value: str) -> str:
        """Fail at startup on a sync URL rather than at first query.

        `postgresql://` picks psycopg2, which cannot run under an async engine.
        The resulting error surfaces deep inside SQLAlchemy and reads like a
        driver-install problem, so catch it here where the message can be useful.
        """
        if value.startswith("postgresql://") or value.startswith("postgres://"):
            raise ValueError(
                "Database URL must use the asyncpg driver: "
                "postgresql+asyncpg://... (got '{0}...'). "
                "Fix AEROSHIELD_DATABASE_URL in backend/.env".format(value.split("://")[0])
            )
        return value

    @property
    def cors_origin_list(self) -> List[str]:
        """Allowed origins, split from the comma-separated setting.

        Never returns ["*"]: a wildcard origin combined with a browser-held API key
        leaks the key to any site the operator happens to visit. If someone puts "*"
        in the env, it is dropped rather than honoured.
        """
        origins = [origin.strip() for origin in self.cors_origins.split(",")]
        return [origin for origin in origins if origin and origin != "*"]

    @property
    def storage_path(self) -> Path:
        """Absolute storage directory, created on demand by the storage service."""
        path = Path(self.storage_dir)
        return path if path.is_absolute() else (BACKEND_ROOT / path)

    @property
    def max_image_bytes(self) -> int:
        return self.max_image_mb * 1024 * 1024

    @property
    def is_production(self) -> bool:
        return self.env.lower() in ("production", "prod")


@lru_cache
def get_settings() -> Settings:
    """Cached accessor. Use this rather than instantiating Settings directly.

    Also usable as a FastAPI dependency, and the cache is what lets tests swap
    configuration with get_settings.cache_clear().
    """
    return Settings()


settings = get_settings()
