from __future__ import annotations

from ... import config
from .base import GenResult, Provider, ProviderError  # noqa: F401

_instance: Provider | None = None


def reset_provider() -> None:
    """Drop the cached provider so the next call picks up new settings."""
    global _instance
    _instance = None


def get_provider() -> Provider:
    """Build the provider from the runtime settings, falling back to the
    environment. Settings come first so a deployed copy can be configured
    entirely from its own UI, with nothing typed into a hosting dashboard."""
    global _instance
    if _instance is None:
        from ... import settings as S
        which = S.load().effective_provider()
        if which == "freepik":
            from .freepik import FreepikProvider
            _instance = FreepikProvider()
        else:
            from .mock import MockProvider
            _instance = MockProvider()
    return _instance
