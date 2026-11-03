"""Shared input contract for SDK, CLI and service-backed runtimes."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import JsonValue

RuntimeId = Literal['default', 'opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek']
AgentEvent = dict[str, JsonValue]


@dataclass(kw_only=True)
class RunContext:
    runtime: RuntimeId
    project_id: UUID
    turn_id: UUID
    session: str
    directory: Path
    config: dict[str, JsonValue] | None
    messages: list[dict[str, JsonValue]]
    selected_skills: list[str]
    model_selections: dict[str, str | None] = field(default_factory=dict)
    thinking: str = 'auto'
    runtime_model: str | None = None
    skills: list[dict[str, str]] = field(default_factory=list)
