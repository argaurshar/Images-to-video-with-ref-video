from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class GenResult:
    path: Path
    provider_id: str = ""
    cost: float = 0.0
    note: str = ""


class Provider:
    name = "base"

    def generate_still(self, source: Path, prompt: str, negative: str, aspect: str, out: Path) -> GenResult:
        raise NotImplementedError

    def generate_clip(self, still: Path, prompt: str, negative: str, seconds: float, aspect: str, out: Path) -> GenResult:
        raise NotImplementedError


class ProviderError(RuntimeError):
    pass
