from __future__ import annotations


class RuntimeConfigurationError(RuntimeError):
    """A configuration failure with a safe, actionable public message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
