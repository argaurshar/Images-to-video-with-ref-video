from __future__ import annotations

from ... import config
from .base import GenResult, Provider, ProviderError  # noqa: F401

_instance: Provider | None = None


def get_provider() -> Provider:
    global _instance
    if _instance is None:
        if config.PROVIDER == "freepik":
            from .freepik import FreepikProvider
            _instance = FreepikProvider()
        else:
            from .mock import MockProvider
            _instance = MockProvider()
    return _instance
