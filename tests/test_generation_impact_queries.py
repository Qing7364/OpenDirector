"""Shared query entry points against committed projects and real small image files."""
import asyncio
import hashlib
from io import BytesIO
import json
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest
from typer.testing import CliRunner

from generation_helpers import command, new_project, settled
from opendirector import cli
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_canvas import CreationCanvas
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.creation.commands import GenerationImpactQuery, parse_command
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector_api.main import create_app
from test_creation_canvas_service import send, ver
from test_generation_impact import graph, report, replace, uid

pytestmark = pytest.mark.cpu


class ImageProvider:
    """Only model execution is replaced; acceptance, files and adoption are real."""
    def __init__(self):
        self.calls = 0

    def validate(self, kind, config):
        assert kind == 'image'

    async def generate(self, config, task, submitted):
        self.calls += 1
        stream = BytesIO()
        Image.new('RGB', (16, 16), (self.calls * 20, 100, 120)).save(stream, 'PNG')
        return 'png', stream.getvalue()


@pytest.fixture
def saved(tmp_path):
    project = new_project(tmp_path, 'Dependency case')
    store, pid, session = project
    configs = ModelConfigs(tmp_path)
    config = configs.save('image', 'http://127.0.0.1:12345/v1', 'fixture-image', '',
        connection_type='self_hosted', auth_mode='none', protocol='openai')
    provider = ImageProvider()
    runner = CreationGeneration(store, configs, provider)
    specs, items = [], []

    async def build():
        for index in range(4):
            request = command(project, config, prompt=f'Frame {index}')
            state = store.snapshot(pid)
            spec, item = state.generationSpecs[-1], state.canvasItems[-1]
            if index in (1, 2):
                receipt = send(store, pid, 'reference.add', session=session,
                    versions=[ver('generation_spec', spec), ver('canvas_item', item)], reference=dict(
                        id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current',
                        source=dict(id=items[-1])))
                assert receipt.status == 'applied', receipt
                state = store.snapshot(pid)
                spec = next(s for s in state.generationSpecs if s.id == spec.id)
                item = next(i for i in state.canvasItems if i.id == item.id)
                request = parse_command(dict(commandId=request.commandId, projectId=pid, type='generation.submit',
                    expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
                    payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
            receipt = await runner.execute(request, session=session)
            assert receipt.status == 'accepted', receipt
            await settled(runner)
            state = store.snapshot(pid)
            assert state.jobs[-1].status == 'succeeded'
            assert next(s for s in state.generationSpecs if s.id == spec.id).currentResultId is not None
            specs.append(spec.id)
            items.append(item.id)
        await runner.close()

    asyncio.run(build())
    return project, configs, runner, provider, specs, items


def impact_query(pid, roots, **kwargs):
    return GenerationImpactQuery(type='generation.impact', queryId=uuid4(), projectId=pid,
        rootSpecIds=tuple(roots), **kwargs)


def test_http_agent_and_cli_share_impact_report(saved, tmp_path, monkeypatch):
    (store, pid, session), configs, runner, provider, specs, _ = saved
    query = impact_query(pid, [specs[1]])
    api = TestClient(create_app(store.local, generation_provider=provider), headers={'X-OpenDirector-Request': '1'})
    response = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
    assert response.status_code == 200, response.text
    expected = response.json()
    agent = asyncio.run(AgentTools(store, runner, configs).execute(pid, uuid4(), session, 'impact',
        'query', dict(type='generation.impact', rootSpecIds=[str(specs[1])]), [], None))
    assert agent == expected
    params = tmp_path / 'impact-query.json'
    params.write_text(json.dumps(dict(rootSpecIds=[str(specs[1])])), encoding='utf-8')
    for key in ('OPENDIRECTOR_AGENT_SOCKET', 'OPENDIRECTOR_AGENT_HOST', 'OPENDIRECTOR_PROJECT'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: api)
    result = CliRunner().invoke(cli.app, ['--project', str(pid), 'query', 'generation.impact', '--file', str(params)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected
    assert [i['reuseState'] for i in expected['items']] == ['reusable'] * 4


def files_under(path):
    return {str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in path.rglob('*') if p.is_file() and not p.name.endswith('.lock')}


def test_impact_query_is_read_only(saved, monkeypatch):
    (store, pid, session), _, _, provider, specs, _ = saved
    before = store.snapshot(pid).model_dump_json()
    files = files_under(store.local.repository)
    calls = provider.calls

    def forbidden(*args, **kwargs):
        raise AssertionError('Read-only query attempted a mutation or remote capability probe')

    monkeypatch.setattr(store, 'open', forbidden)
    monkeypatch.setattr(store, 'commit', forbidden)
    monkeypatch.setattr(CapabilityProbe, 'query', forbidden)
    canvas = CreationCanvas(store)
    first = canvas.query_snapshot(impact_query(pid, [specs[1]]))
    assert first == canvas.query_snapshot(impact_query(pid, [specs[1]]))
    assert store.snapshot(pid).model_dump_json() == before
    assert files_under(store.local.repository) == files
    assert provider.calls == calls


def test_snapshot_version_and_scope_limits(saved, monkeypatch):
    (store, pid, _), _, _, _, specs, _ = saved
    original = store.snapshot
    state = original(pid)
    reads = []

    def one_snapshot(key):
        reads.append(key)
        assert len(reads) == 1
        return state

    catalog = ModelConfigs.catalog_snapshot
    catalogs = []

    def one_catalog(self):
        catalogs.append(True)
        assert len(catalogs) == 1
        return catalog(self)

    monkeypatch.setattr(store, 'snapshot', one_snapshot)
    monkeypatch.setattr(ModelConfigs, 'catalog_snapshot', one_catalog)
    value = CreationCanvas(store).query_snapshot(impact_query(pid, [specs[1]]))
    assert value.projectVersion.revision == state.project.revision and value.eventCursor == state.eventCursor
    assert len(reads) == len(catalogs) == 1


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
def test_impact_errors_and_codes_are_locale_safe(saved, locale):
    (store, pid, _), _, _, provider, specs, _ = saved
    api = TestClient(create_app(store.local, generation_provider=provider),
        headers={'Accept-Language': locale, 'X-OpenDirector-Request': '1'})
    query = impact_query(pid, [specs[1]], maxNodes=3)
    response = api.post(f'/api/creation/projects/{pid}/queries', json=query.model_dump(mode='json'))
    assert response.status_code == 422 and response.json()['code'] == 'impact_scope_exceeded'
    message = response.json()['detail']
    assert ('上限' in message) if locale == 'zh-CN' else ('limit' in message and not any('\u4e00' <= c <= '\u9fff' for c in message))
    for roots in ([uuid4()], [pid]):  # foreign and wrong-kind identity
        response = api.post(f'/api/creation/projects/{pid}/queries', json=impact_query(pid, roots).model_dump(mode='json'))
        assert response.status_code == 404 and response.json()['code'] == 'missing_object'
    valid = impact_query(pid, [specs[1]]).model_dump(mode='json')
    english = api.post(f'/api/creation/projects/{pid}/queries', json=valid, headers={'Accept-Language': 'en-US'}).json()
    chinese = api.post(f'/api/creation/projects/{pid}/queries', json=valid, headers={'Accept-Language': 'zh-CN'}).json()
    assert english == chinese
    assert all(secret not in json.dumps(english) for secret in ('12345', str(store.local.repository), 'apiKey', 'Frame 0'))


def test_long_chain_cycles_and_scope_are_bounded():
    from opendirector.domain.creation.project import ProjectSnapshot
    from opendirector.domain.creation.validation import ContractError
    from test_creation_contracts import entity, PROJECT
    data = dict(project=dict(id=PROJECT, name='Long chain'), generationSpecs=[
        entity(10000+i, kind='image', purpose='generation', modelConfigId=uid(20)) for i in range(1200)],
        canvasItems=[entity(20000+i, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(10000+i)))) for i in range(1200)],
        references=[entity(30000+i, binding='follow_current', targetSpecId=uid(10000+i), source=dict(id=uid(19999+i))) for i in range(1,1200)])
    state = ProjectSnapshot.model_validate(data)
    value = report(state, roots=(uid(10000),))
    assert len(value.items) == 1200 and value.items[-1].relation == 'downstream'
    assert value.items[-1].reuseState == 'no_result'
    with pytest.raises(ContractError) as error:
        report(state, roots=(uid(10000),), max_nodes=1199)
    assert error.value.issue.code == 'impact_scope_exceeded'
    cyclic = replace(graph(), 'references', 0, source=dict(id=uid(202)))
    value = report(cyclic)
    assert all(value.items[i].reuseState == 'unknown' for i in (1, 2))
    assert any(r.code == 'dependency_cycle' for r in value.items[1].reasons)
