import asyncio
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.agent import native
from opendirector.agent.skills import skills
from opendirector.agent.runtime import AgentRuntimes
from opendirector.agent.context import RunContext
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.chat_completions import ChatCompletions
from opendirector_api.main import create_app

FAKE = '''import json, os, subprocess, sys
from pathlib import Path
prompt = sys.stdin.read()
assert 'Segment plan' not in prompt
assert list(Path('.agents/skills').glob('*/SKILL.md'))
assert str(Path.cwd()) in prompt
subprocess.run(['sh', '-c', 'printf \"native execution works\" > environment-check.txt'], check=True)
bridge = subprocess.Popen([sys.executable, os.environ['BRIDGE']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def rpc(value):
 bridge.stdin.write(json.dumps(value)+'\\n'); bridge.stdin.flush()
 response = json.loads(bridge.stdout.readline())
 assert 'error' not in response, response
 return response['result']
rpc({'id':1, 'method':'initialize'})
assert len(rpc({'id':2, 'method':'tools/list'})['tools']) == 4
result = rpc({'id':3, 'method':'tools/call', 'params':{'name':'execute_command', 'arguments':{'type':'asset.writeText','payload':{'name':'native.md','text':'Native plan'}}}})
assert not result['isError'], result
assert rpc({'id':3, 'method':'tools/call', 'params':{'name':'execute_command', 'arguments':{'type':'asset.writeText','payload':{'name':'native.md','text':'Native plan'}}}}) == result
bridge.stdin.close(); bridge.wait()
runtime = os.environ['TEST_RUNTIME']
if runtime == 'codex':
 print(json.dumps({'type':'thread.started','thread_id':'test-native'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Native saved.'}}))
elif runtime == 'claude':
 print(json.dumps({'type':'assistant','session_id':'test-native','message':{'content':[{'type':'text','text':'Native saved.'}]}}))
else:
 print(json.dumps({'type':'text','sessionID':'test-native','part':{'text':'Native saved.'}}))
'''


@pytest.fixture(autouse=True)
def example_skill(tmp_path):
    directory = tmp_path / '.opendirector/skills/character-replacement'
    directory.mkdir(parents=True)
    (directory / 'SKILL.md').write_text('---\nname: character-replacement\ndescription: Test replacement planning\n---\nCreate a 24-FPS constant-frame-rate working copy')


def project(client):
    pid = str(uuid4())
    path = f'/api/creation/projects/{pid}'
    assert client.post(path + '/commands', json={'type':'project.create', 'projectId':pid,
        'commandId':str(uuid4()), 'payload':{'name':'Native runtime'}}).status_code == 200
    assert client.post(path + '/open').status_code == 200
    return path


@pytest.mark.parametrize('runtime', ['default'])
def test_native_events_real_mcp_and_shared_write(tmp_path, monkeypatch, runtime):
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://localhost:9999/v1','test','',auth_mode='none')
    script = tmp_path / 'fake_cli.py'
    script.write_text(FAKE)
    def command(kind, work, socket, token, model, model_url, catalog, **kwargs):
        return [sys.executable, str(script)], {**os.environ, 'TEST_RUNTIME':kind,
            'OPENDIRECTOR_AGENT_SOCKET':socket,'OPENDIRECTOR_AGENT_TOKEN':token,
            'BRIDGE':str(native.ROOT / 'scripts/agent-mcp.py')}
    monkeypatch.setattr(native, 'command', command)
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        turn = {'id':str(uuid4()),'runtime':runtime,'text':'Save a plan','skills':['character-replacement']}
        if runtime == 'default':
            turn['modelId'] = config['id']
        response = client.post(path + '/assistant/turns', json=turn)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert events[-1]['conversation']['messages'][-1]['text'] == 'Native saved.'
        snapshot = client.get(path).json()
        assert len(snapshot['assets']) == 1
        activity = events[-1]['conversation']['messages'][-1]['tools'][0]
        assert activity['arguments']['type'] == 'asset.writeText'
        assert json.loads(activity['result'])['status'] == 'applied'
        assert activity['resultTruncated'] is False
        provenance = snapshot['assets'][0]['provenance']
        assert provenance['agentRunId'] == turn['id']
        if runtime != 'default':
            assert provenance['agentRuntime'] == runtime
            assert provenance['modelSnapshot'] is None
        assert client.get(path + '/changes').json()['events'][-1]['source'] == 'agent'
        trace = next(local.root.rglob('*.opencode.jsonl')).read_text()
        assert 'test-native' in trace
        assert 'Native saved.' in trace
        work = next(local.root.rglob(f'agent-runs/{turn["id"]}/work'))
        assert work.is_dir()
        assert (work / 'environment-check.txt').read_text() == 'native execution works'


def test_native_commands_keep_auth_and_restrict_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(native, "executable", lambda _: sys.executable)
    for runtime in ('default',):
        work = tmp_path / runtime
        work.mkdir()
        args, env = native.command(runtime, work, '/tmp/test.sock', 'private-token', 'test-model', 'http://localhost:1', [])
        assert 'private-token' not in ' '.join(args) if runtime == 'opencode' else True
        if runtime == 'codex':
            assert '--ignore-user-config' in args
            assert 'features.shell_tool=true' in args
            assert args[args.index('--sandbox') + 1] == 'workspace-write'
            assert 'mcp_servers.opendirector.default_tools_approval_mode="approve"' in args
            assert '--dangerously-bypass-approvals-and-sandbox' not in args
        elif runtime == 'claude':
            assert '--max-turns' not in args
            assert args[args.index('--tools') + 1] == 'Skill,Bash,Read'
            assert '--dangerously-skip-permissions' not in args
        else:
            config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
            assert 'steps' not in config['agent']['opendirector']
            assert config['permission']['*'] == 'deny'
            assert config['skills']['paths'] == [str(work / '.agents/skills')]


@pytest.mark.parametrize("runtime", ["default"])
def test_real_opencode_native_skill_and_gateway_write(tmp_path, runtime):
    if native.executable('default') is None:
        pytest.skip('Bundled OpenCode is not installed')
    requests = []
    def model(request):
        payload = json.loads(request.content)
        if payload.get('tools'):
            requests.append(payload)
        assert request.headers['authorization'] == 'Bearer server-only-key'
        count = len(requests)
        if not payload.get('tools'):
            call = None
        elif count == 1:
            assert any(tool['function']['name'] == 'skill' for tool in payload['tools'])
            call = {'name':'skill','arguments':json.dumps({'name':'character-replacement'})}
        elif count == 2:
            assert 'Create a 24-FPS constant-frame-rate working copy' in json.dumps(payload['messages'])
            name = next(tool['function']['name'] for tool in payload['tools'] if tool['function']['name'].endswith('execute_command'))
            call = {'name':name,'arguments':json.dumps({'type':'asset.writeText','payload':{'name':'real-native.md','text':'Real OpenCode plan'}})}
        else:
            call = None
        delta = {'tool_calls':[{'index':0,'id':f'call-{count}','type':'function','function':call}]} if call else {'content':'OpenCode ready.'}
        chunk = {'id':f'completion-{count}','object':'chat.completion.chunk','created':1,'model':'test-model',
            'choices':[{'index':0,'delta':delta,'finish_reason':None}]}
        finish = {**chunk,'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if call else 'stop'}]}
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=(
            'data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(finish)+'\n\ndata: [DONE]\n\n').encode())
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://test.invalid/v1','test-model','server-only-key')
    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        catalog = client.get(path + '/assistant/skills').json()
        assert {item['name'] for item in catalog} == {'character-replacement'}
        assert all(set(item) == {'name', 'description', 'source'} for item in catalog)
        assert client.put(path + '/assistant/draft', json={'draft': 'Save a plan', 'skills': ['character-replacement'],
            'harnessModels': {'codex': 'test-model'}}).status_code == 200
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'runtime':runtime,
            'text':'Use the skill and save a plan.', 'skills':['character-replacement']}
        response = client.post(path + '/assistant/turns', json=turn)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]['error'] is None, events
        assert events[-1]['conversation']['messages'][-1]['text'] == 'OpenCode ready.'
        assert client.get(path).json()['assets'][0]['name'] == 'real-native.md'
        assert len(requests) == 3
        saved = client.get(path + '/assistant').json()
        assert saved['skills'] == []
        assert saved['harnessModels'] == {'codex': 'test-model'}
        assert len(saved['messages']) == 2
        assert '已接受' in client.post(path + '/assistant/turns', json=turn).text
        assert len(client.get(path).json()['assets']) == 1
        assert len(requests) == 3
        assert 'server-only-key' not in next(local.root.rglob('*.opencode.jsonl')).read_text()


@pytest.mark.parametrize('runtime', ['default'])
def test_cancel_native_process_group(tmp_path, monkeypatch, runtime):
    import signal
    async def check():
        script = tmp_path / 'wait.py'
        marker = tmp_path / 'pid.txt'
        script.write_text('import os,sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(str(os.getpid()))\nsys.stdin.read()\ntime.sleep(60)\n')
        def command(*args, **kwargs):
            return [sys.executable, str(script), str(marker)], dict(os.environ)
        monkeypatch.setattr(native, 'command', command)
        local = LocalProjects(tmp_path)
        from opendirector.infrastructure.creation_projects import CreationProjects
        instance = AgentRuntimes(CreationProjects(local), None, ModelConfigs(tmp_path))
        async def consume():
            async for _ in instance.stream(RunContext(runtime=runtime, project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
                    directory=tmp_path, config={'modelId':'test', 'apiKey':'', 'url':'http://localhost/v1', 'protocol':'openai'}, messages=[{'role':'user','content':'wait'}], selected_skills=[])):
                pass
        task = asyncio.create_task(consume())
        async with asyncio.timeout(10):
            while not marker.exists():
                await asyncio.sleep(.02)
        pid = int(marker.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    asyncio.run(check())


def test_rejects_removed_runtime_and_invalid_selection_before_acceptance(tmp_path):
    local = LocalProjects(tmp_path)
    config = ModelConfigs(tmp_path).save('agent','http://127.0.0.1:1/v1','test','',auth_mode='none')
    with TestClient(create_app(local), headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
        path = project(client)
        turn = {'id':str(uuid4()), 'modelId':config['id'], 'text':'hello', 'runtime':'pi'}
        assert client.post(path + '/assistant/turns', json=turn).status_code == 422
        turn.update(runtime='default', skills=['missing'])
        assert client.post(path + '/assistant/turns', json=turn).status_code == 409
        turn.update(skills=[], assets=[str(uuid4())])
        assert client.post(path + '/assistant/turns', json=turn).status_code == 409
        assert client.get(path + '/assistant').json()['messages'] == []
        assert 'pi' not in [item['id'] for item in client.get(path + '/assistant/runtimes').json()]


def test_bundled_model_declares_configured_inputs_without_changing_cli_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    _, env = native.command('default', tmp_path, '/tmp/socket', 'token', 'vision-agent',
        'http://127.0.0.1:1/v1', [], input_modalities=['text', 'image'])
    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
    assert config['provider']['opendirector']['models']['vision-agent']['modalities'] == {
        'input': ['text', 'image'], 'output': ['text']}
