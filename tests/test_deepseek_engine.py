"""Opt-in installed dsh CLI with a local simulated model, never a paid endpoint."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


@pytest.mark.skipif(os.getenv('DEEPSEEK_ENGINE_TEST') != '1', reason='requires installed dsh CLI')
def test_real_cli_native_skill_and_shared_project_write(tmp_path, monkeypatch):
    calls, failures = [], []
    steps = [('skill', {'name': 'example'}),
        ('bash', {'command': "printf 'native bash' > native-check.txt", 'description':'Write a native execution marker'}),
        ('mcp__opendirector__read_project', {}),
        ('mcp__opendirector__execute_command', {'type':'asset.writeText','payload':{'name':'deepseek.md','text':'Real CLI, local model'}})]
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index=len(calls)
            calls.append(request)
            if index < len(steps):
                name, arguments=steps[index]
                names={tool['name'] for tool in request.get('tools',[])}
                if name not in names:
                    failures.append((name,sorted(names)))
                block={'type':'tool_use','id':f'fixture-{index}','name':name,'input':{}}
                delta={'type':'input_json_delta','partial_json':json.dumps(arguments)}
                reason='tool_use'
            else:
                block={'type':'text','text':''}
                delta={'type':'text_delta','text':'Real CLI finished.'}
                reason='end_turn'
            events=[
                {'type':'message_start','message':{'id':f'message-{index}','type':'message','role':'assistant',
                    'model':'deepseek-v4-flash','content':[],'usage':{'input_tokens':10,'output_tokens':0}}},
                {'type':'content_block_start','index':0,'content_block':block},
                {'type':'content_block_delta','index':0,'delta':delta},
                {'type':'content_block_stop','index':0},
                {'type':'message_delta','delta':{'stop_reason':reason,'stop_sequence':None},'usage':{'output_tokens':5}},
                {'type':'message_stop'},
            ]
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream');self.end_headers()
            for event in events:
                self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
            self.wfile.flush()
    server=ThreadingHTTPServer(('127.0.0.1',0),Model)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setenv('DSH_HOME',str(tmp_path/'dsh-home'))
    monkeypatch.setenv('DEEPSEEK_API_KEY','fixture-not-a-secret')
    monkeypatch.setenv('DEEPSEEK_BASE_URL',f'http://127.0.0.1:{server.server_port}')
    monkeypatch.setenv('NO_PROXY','localhost,127.0.0.1,::1')
    monkeypatch.setenv('no_proxy','localhost,127.0.0.1,::1')
    skill=tmp_path/'.opendirector/skills/example'
    skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text('---\nname: example\ndescription: Fixture skill\n---\nNATIVE_DEEPSEEK_SKILL_MARKER')
    foreign=tmp_path/'dsh-home/skills/unapproved'
    foreign.mkdir(parents=True)
    (foreign/'SKILL.md').write_text('---\nname: unapproved\ndescription: UNAPPROVED_SKILL_MARKER\n---\nNot part of the project')
    local=LocalProjects(tmp_path)
    try:
        with TestClient(create_app(local),headers={'X-OpenDirector-Request':'1','X-OpenDirector-Session':str(uuid4())}) as client:
            pid,turn=str(uuid4()),str(uuid4())
            path='/api/creation/projects/'+pid
            assert client.post(path+'/commands',json=dict(type='project.create',projectId=pid,commandId=str(uuid4()),payload={'name':'DeepSeek real CLI'})).status_code==200
            assert client.post(path+'/open').status_code==200
            response=client.post(path+'/assistant/turns',json=dict(id=turn,runtime='deepseek',text='Load the example skill and save a text asset.',skills=['example']))
            events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            assert not failures, failures
            assert events[-1]['error'] is None, events[-1]
            assert events[-1]['conversation']['messages'][-1]['text']=='Real CLI finished.'
            assets=client.get(path).json()['assets']
            assert assets[0]['provenance']['agentRuntime']=='deepseek'
            assert (local.root/'DeepSeek real CLI/agent-runs'/turn/'work/native-check.txt').read_text()=='native bash'
            assert 'NATIVE_DEEPSEEK_SKILL_MARKER' in json.dumps(calls[1]['messages'])
            assert 'UNAPPROVED_SKILL_MARKER' not in json.dumps(calls)
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)
