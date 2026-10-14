"""Load env and paths for ApiLens Platform runtime."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

_RUNTIME = Path(__file__).resolve().parent.parent
try:
    from dotenv import load_dotenv

    load_dotenv(_RUNTIME / ".env")
except ImportError:
    pass


@lru_cache
def repo_root() -> Path:
    return Path(os.getenv("REPO_ROOT", _RUNTIME.parent)).resolve()


def mock_llm() -> bool:
    flag = os.getenv("MOCK_LLM", "true").lower()
    return flag in {"1", "true", "yes"}
