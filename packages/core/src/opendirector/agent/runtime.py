"""Runtime catalog and shared per-turn execution boundary."""
import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, replace
from typing import Literal

from opendirector.agent.context import AgentEvent, RunContext, RuntimeId
from opendirector.agent.gateway import ToolGateway
import opendirector.agent.native as native
from opendirector.agent.tools import AgentTools
from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


@dataclass(frozen=True, kw_only=True)
class RuntimeSpec:
    id: RuntimeId
    label: str
    group: Literal['default', 'harness']
    modelSource: Literal['settings', 'cli']
    modelOverride: bool
    engine: RuntimeId


RUNTIMES = {
    'default': RuntimeSpec(id='default', label='Default', group='default', modelSource='settings', modelOverride=False, engine='default'),
}


def runtime_spec(name: str) -> RuntimeSpec:
    try:
        return RUNTIMES[name]
    except KeyError:
        raise ProjectError('未知 Agent 引擎。') from None


def runtime_available(name: str) -> bool:
    spec = runtime_spec(name)
    return native.executable(spec.engine) is not None


def runtime_catalog() -> list[dict]:
    return [{**asdict(spec), 'available': runtime_available(spec.id)}
            for spec in RUNTIMES.values()]


async def runtime_readiness(engine: str) -> str:
    executable = native.executable(engine)
    if executable is None:
        return 'not_installed'
    if engine in {'default', 'opencode'}:
        return 'ready'
    args = ['login', 'status'] if engine == 'codex' else ['auth', 'status', '--json']
    try:
        process = await asyncio.create_subprocess_exec(
            str(executable), *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return 'unknown'
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 5)
        if engine == 'claude':
            try:
                logged_in = json.loads(output)['loggedIn']
            except (ValueError, KeyError, TypeError):
                return 'unknown'
            return 'ready' if logged_in is True else 'needs_login'
        return 'ready' if process.returncode == 0 else 'needs_login'
    except TimeoutError:
        return 'unknown'
    finally:
        await terminate(process, group=True)


async def configured_runtimes() -> list[dict]:
    engines = tuple(RUNTIMES)
    states = dict(zip(engines, await asyncio.gather(*(runtime_readiness(engine) for engine in engines))))
    return [{**item, 'status': states[item['engine']]} for item in runtime_catalog()]


class AgentRuntimes:
    def __init__(self, projects, generation, configs, provider=None):
        self.business = AgentTools(projects, generation, configs)
        self.adapter = native.NativeRuntime(provider)

    async def stream(self, run: RunContext) -> AsyncIterator[AgentEvent]:
        runtime_spec(run.runtime)
        gateway = ToolGateway(self.business, run)
        try:
            async for event in self.adapter.stream(run, gateway):
                yield event
        finally:
            await gateway.close()
