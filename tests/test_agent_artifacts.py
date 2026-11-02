import asyncio
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4, uuid5

from PIL import Image
import pytest

from opendirector.application.creation_artifacts import publish_artifact
from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs


@pytest.fixture
def publication(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, turn, session = uuid4(), uuid4(), str(uuid4())
    projects.execute(parse_command({'type': 'project.create', 'projectId': pid,
        'commandId': uuid4(), 'payload': {'name': 'Artifact tests'}}))
    directory = projects.open(pid, session)
    with projects.local.transaction() as db:
        directory, _, _ = projects._load(db, pid)
    work = directory / 'agent-runs' / str(turn) / 'work'
    work.mkdir(parents=True)
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(runtime='codex', project_id=pid, turn_id=turn, session=session,
        directory=directory, config=None, messages=[], selected_skills=[])
    return business, run, work


def publish(publication, path, *, identity=None, name=None, sources=()):
    business, run, _ = publication
    command = parse_command({'type': 'artifact.publish', 'projectId': run.project_id,
        'commandId': uuid5(run.turn_id, str(identity)) if identity is not None else uuid4(),
        'payload': {'path': path, 'name': name or Path(path).name, 'sources': list(sources)}})
    receipt = publish_artifact(business.assets, command, execution_directory=run.directory / 'agent-runs' / str(run.turn_id) / 'work', session=run.session,
        provenance=AssetProvenance(source='agent_written', agentRunId=run.turn_id, agentRuntime='codex',
            sources=command.payload.sources))
    assert receipt.status == 'applied'
    asset = business.assets.get(run.project_id, receipt.changed[0].id)
    return {**receipt.model_dump(mode='json'), 'asset': asset.model_dump(mode='json'),
        'reference': asset_ref(asset).model_dump(mode='json')}



def test_text_image_publication_replay_and_content_conflict(publication):
    business, run, work = publication
    original = work / 'plan.md'
    original.write_text('A plan')
    identity = 'segment-01'
    result = publish(publication, 'plan.md', identity=identity)
    assert result['status'] == 'applied'
    assert result['asset']['provenance']['agentRunId'] == str(run.turn_id)
    assert result['asset']['metadata']['mimeType'] == 'text/markdown'
    assert publish(publication, 'plan.md', identity=identity)['asset']['id'] == result['asset']['id']
    with pytest.raises(ProjectError, match='不同输入'):
        publish(publication, 'plan.md', identity=identity, name='other.md')
    original.write_text('Changed')
    assert publish(publication, 'plan.md', identity=identity)['asset']['fingerprint'] == result['asset']['fingerprint']
    assert len(business.projects.snapshot(run.project_id).assets) == 1
    assert original.read_text() == 'Changed'
    Image.new('RGB', (13, 7), 'purple').save(work / 'frame.png')
    image = publish(publication, str(work / 'frame.png'), sources=[result['reference']])
    assert image['asset']['metadata']['width'] == 13
    assert image['asset']['provenance']['sources'] == [result['reference']]


def test_file_scope_links_empty_and_other_turn_are_rejected(publication, tmp_path):
    _, _, work = publication
    outside = tmp_path / 'outside.md'
    outside.write_text('outside')
    for path in [str(outside), '../outside.md']:
        with pytest.raises(ProjectError, match='本轮执行目录'):
            publish(publication, path)
    (work / 'link.md').symlink_to(outside)
    (work / 'directory').symlink_to(tmp_path, target_is_directory=True)
    for path in ['link.md', 'directory/outside.md']:
        with pytest.raises(OSError):
            publish(publication, path)
    (work / 'empty.md').touch()
    with pytest.raises(ProjectError, match='非空普通文件'):
        publish(publication, 'empty.md')
    (work / 'folder').mkdir()
    with pytest.raises(ProjectError, match='非空普通文件'):
        publish(publication, 'folder', name='directory.md')


def test_retry_after_lost_commit_response_does_not_duplicate(publication, monkeypatch):
    business, run, work = publication
    (work / 'plan.md').write_text('plan')
    execute = business.assets.register
    def lost(*args, **kwargs):
        execute(*args, **kwargs)
        raise OSError('lost response')
    identity = uuid4()
    monkeypatch.setattr(business.assets, 'register', lost)
    with pytest.raises(OSError, match='lost response'):
        publish(publication, 'plan.md', identity=identity)
    monkeypatch.setattr(business.assets, 'register', execute)
    assert publish(publication, 'plan.md', identity=identity)['status'] == 'applied'
    assert len(business.projects.snapshot(run.project_id).assets) == 1


def test_five_video_artifacts_become_independent_assets(publication):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('requires ffmpeg and ffprobe')
    business, run, work = publication
    source = work / 'source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=24',
        '-frames:v', '12', '-pix_fmt', 'yuv420p', str(source)], check=True)
    original = publish(publication, 'source.mp4')
    gateway = ToolGateway(business, run)
    async def publish_segments():
        for index in range(5):
            name = f'segment-{index}.mp4'
            shutil.copyfile(source, work / name)
            response = await gateway.call(str(index), 'execute_command', {'type': 'artifact.publish',
                'payload': {'path': name, 'name': name, 'sources': [original['reference']]}})
            assert response.error is None, response
            asset = business.assets.get(run.project_id, response.value['changed'][0]['id'])
            assert asset.metadata.frameRate == 24
            shown = await gateway.call(f'canvas-{index}', 'execute_command', {
                'type': 'canvas.show', 'payload': {'item': {'id': str(uuid4()),
                    'projectId': str(run.project_id), 'kind': 'video', 'title': name,
                    'position': {'x': index * 360, 'y': 0},
                    'binding': {'role': 'material', 'objectRef': asset_ref(asset).model_dump(mode='json')}}}})
            assert shown.error is None, shown
        await gateway.close()
    asyncio.run(publish_segments())
    assets = business.projects.snapshot(run.project_id).assets
    assert len(assets) == 6
    assert len({asset.id for asset in assets}) == 6
    assert all(asset.kind == 'video' for asset in assets)
    assert len(business.projects.snapshot(run.project_id).canvasItems) == 5


def test_generic_file_and_audio_follow_shared_import_rules(publication):
    import wave
    _, _, work = publication
    (work / 'report.html').write_text('<html>Report</html>')
    report = publish(publication, 'report.html')
    assert report['asset']['kind'] == 'file'
    with wave.open(str(work / 'sound.wav'), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 800)
    assert publish(publication, 'sound.wav')['asset']['kind'] == 'audio'


def test_publication_is_a_command_not_a_separate_tool():
    from opendirector.agent.tools import tools, COMMANDS
    assert 'publish_artifact' not in {tool['function']['name'] for tool in tools()}
    schema = COMMANDS['artifact.publish'].model_json_schema()
    assert 'commandId' in schema['properties']
    payload = schema['$defs']['ArtifactPublish']['properties']
    assert set(payload) == {'path', 'name', 'expectedKind', 'sources'}


def test_publication_replay_does_not_require_original_output_file(publication):
    business, run, work = publication
    (work / 'plan.md').write_text('plan')
    first = publish(publication, 'plan.md', identity='same-command')
    (work / 'plan.md').unlink()
    replay = publish(publication, 'plan.md', identity='same-command')
    assert first == replay
    with business.projects.local.transaction() as db:
        _, _, records = business.projects._load(db, run.project_id)
    record = next(record for record in records if str(record.command.commandId) == first['commandId'])
    assert record.command.type == 'artifact.publish'
    assert not list(business.projects.state_dir.glob('agent-publication-*.json'))


def test_http_cannot_supply_its_own_execution_context(publication):
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    business, run, _ = publication
    with TestClient(create_app(business.projects.local), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': run.session}) as client:
        response = client.post(f'/api/creation/projects/{run.project_id}/commands', json={
            'type': 'artifact.publish', 'projectId': str(run.project_id), 'commandId': str(uuid4()),
            'payload': {'path': '/etc/passwd', 'name': 'outside.txt'}})
        assert response.status_code == 403
        assert business.projects.snapshot(run.project_id).assets == ()
