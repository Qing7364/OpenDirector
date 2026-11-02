import asyncio
from uuid import uuid4

import pytest

from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def gateway(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(runtime='codex', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[])
    return ToolGateway(business, run)


@pytest.mark.anyio
async def test_concurrent_replay_executes_once_and_conflicting_input_is_rejected(gateway, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    effects = []
    async def execute(*args):
        entered.set()
        await release.wait()
        effects.append(args[3])
        return {'status': 'applied', 'commandId': args[3]}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    first = asyncio.create_task(gateway.call('same-id', 'read_project', {}))
    await entered.wait()
    replay = asyncio.create_task(gateway.call('same-id', 'read_project', {}))
    conflict = await gateway.call('same-id', 'read', {'path': 'different'})
    assert conflict.error == '工具调用标识被用于不同输入。'
    release.set()
    left, right = await asyncio.gather(first, replay)
    assert left.value == right.value == {'status': 'applied', 'commandId': 'same-id'}
    assert effects == ['same-id']
    await gateway.close()


@pytest.mark.anyio
async def test_failed_calls_replay_without_limiting_subsequent_calls(gateway, monkeypatch):
    attempts = []
    async def execute(*args):
        attempts.append(args[3])
        raise ProjectError('Invalid reference')
    monkeypatch.setattr(gateway.business, 'execute', execute)
    first = await gateway.call('0', 'read_project', {})
    assert first.error == 'Invalid reference'
    assert (await gateway.call('0', 'read_project', {})).value == first.value
    for number in range(1, 32):
        assert (await gateway.call(str(number), 'read_project', {})).error == 'Invalid reference'
    assert len(attempts) == 32
    await gateway.close()


@pytest.mark.anyio
async def test_disconnect_keeps_accepted_operation_and_close_blocks_new_calls(gateway, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    committed = []
    async def execute(*args):
        entered.set()
        await release.wait()
        committed.append('receipt')
        return {'status': 'accepted', 'jobIds': ['job-1']}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    waiter = asyncio.create_task(gateway.call('submit', 'read_project', {}))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    close = asyncio.create_task(gateway.close())
    await asyncio.sleep(0)
    assert (await gateway.call('another', 'read_project', {})).error == '本轮工具入口已关闭。'
    assert not close.done()
    release.set()
    await close
    assert committed == ['receipt']


@pytest.mark.anyio
async def test_rejected_receipt_and_forged_scope_are_consistent(gateway, monkeypatch):
    async def execute(*args):
        return {'status': 'rejected', 'issues': [{'message': 'Revision conflict'}]}
    monkeypatch.setattr(gateway.business, 'execute', execute)
    outcome = await gateway.call('reject', 'read_project', {})
    assert outcome.value['status'] == 'rejected'
    assert outcome.event('read_project') == {'type': 'tool', 'name': 'read_project', 'status': 'failed', 'error': 'Revision conflict'}
    forged = await gateway.call('forged', 'read_project', {'projectId': str(uuid4())})
    assert forged.error == '工具参数缺失或包含未定义字段。'
    await gateway.close()


@pytest.mark.anyio
async def test_skill_read_resolves_directory_alias_and_preserves_boundary(gateway, tmp_path):
    skill = tmp_path / 'skills' / 'character-replacement'
    skill.mkdir(parents=True)
    resource = skill / 'SKILL.md'
    resource.write_text('character replacement skill')
    alias = tmp_path / 'skill-alias'
    alias.symlink_to(skill, target_is_directory=True)
    gateway.roots = [alias]

    canonical = await gateway.call('canonical', 'read', {'path': str(resource.resolve())})
    aliased = await gateway.call('alias', 'read', {'path': str(alias / 'SKILL.md')})
    assert canonical.error is None and aliased.error is None
    assert canonical.value == aliased.value == 'character replacement skill'

    outside = tmp_path / 'outside.md'
    outside.write_text('outside skill boundary')
    (skill / 'escape.md').symlink_to(outside)
    for call_id, path in [('traversal', alias / '..' / '..' / 'outside.md'),
                          ('symlink', skill / 'escape.md')]:
        rejected = await gateway.call(call_id, 'read', {'path': str(path)})
        assert rejected.error == '只能读取已发现技能目录内的文本资源。'
    await gateway.close()
