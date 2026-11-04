"""CLI runtimes use native skills and one turn-scoped MCP business gateway."""
import asyncio
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
from tempfile import TemporaryDirectory

from opendirector.agent.model_gateway import ModelGateway
from opendirector.agent import deepseek
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.process import terminate
from opendirector.agent.tools import ROOT, SYSTEM, tools
from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.domain.projects import ProjectError
from opendirector.integrations.chat_completions import ChatCompletions


BUNDLED_INSTALL_ERROR = ('内置 Agent 依赖安装不完整或无法运行，请在仓库根目录执行 npm ci，并确保允许 opencode-ai 的安装脚本运行。')


def executable(runtime: str) -> str | None:
    if runtime == 'default':
        for name in ('opencode.exe', 'opencode'):
            path = ROOT / 'node_modules/opencode-ai/bin' / name
            if path.is_file():
                return str(path)
        return None
    return shutil.which('dsh' if runtime == 'deepseek' else runtime)


def command(runtime: str, work: Path, socket: str, token: str, model: str | None,
            model_url: str, catalog: list[dict], *, input_modalities: list[str] | None = None,
            bridge_env: dict[str, str] | None = None) -> tuple[list[str], dict[str, str]]:
    binary = executable(runtime)
    if binary is None:
        raise ProjectError(BUNDLED_INSTALL_ERROR if runtime == 'default' else f'{runtime} CLI 未安装，请先安装。', 503)
    bundled = runtime == 'default'
    if bundled:
        runtime = 'opencode'
    # Windows CPython has no AF_UNIX support, so the caller may pass a loopback address instead.
    bridge = {'command': sys.executable, 'args': [str(ROOT / 'scripts/agent-mcp.py')],
              'env': {**(bridge_env or {'OPENDIRECTOR_AGENT_SOCKET': socket}), 'OPENDIRECTOR_AGENT_TOKEN': token}}
    env = dict(os.environ)
    if runtime == 'opencode':
        config = {'autoupdate': False, 'default_agent': 'opendirector',
            'agent': {'opendirector': {'mode': 'primary', 'prompt': SYSTEM}},
            'skills': {'paths': [str(work / '.agents/skills')]},
            'permission': {'*': 'deny', 'opendirector_*': 'allow', 'bash': 'allow', 'read': 'allow',
                'external_directory': 'allow',
                'skill': {'*': 'deny', **{item['name']: 'allow' for item in catalog}}},
            'mcp': {'opendirector': {'type': 'local', 'command': [bridge['command'], *bridge['args']], 'environment': bridge['env']}}}
        if bundled:
            config['provider'] = {'opendirector': {'npm': '@ai-sdk/openai-compatible', 'name': 'OpenDirector',
                'options': {'baseURL': model_url, 'apiKey': '{env:OPENDIRECTOR_MODEL_KEY}'},
                'models': {model: {'name': model, 'modalities': {'input': input_modalities or ['text'], 'output': ['text']}}}}}
            env.update(XDG_CONFIG_HOME=str(work), OPENDIRECTOR_MODEL_KEY=token)
        env.update(OPENCODE_DISABLE_EXTERNAL_SKILLS='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1', OPENCODE_CONFIG_CONTENT=json.dumps(config))
        args = [binary, 'run', '--pure', '--format', 'json', '--agent', 'opendirector']
        if model:
            args += ['--model', f'opendirector/{model}' if bundled else model]
        return args, env
    if runtime == 'codex':
        settings = [f'mcp_servers.opendirector.command={json.dumps(bridge["command"])}',
            f'mcp_servers.opendirector.args={json.dumps(bridge["args"])}', 'mcp_servers.opendirector.required=true',
            'mcp_servers.opendirector.default_tools_approval_mode="approve"',
            'features.shell_tool=true', 'features.apply_patch_freeform=false', 'web_search="disabled"',
            'skills.bundled.enabled=false', f'developer_instructions={json.dumps(SYSTEM)}']
        settings += [f'mcp_servers.opendirector.env.{key}={json.dumps(value)}' for key, value in bridge['env'].items()]
        args = [binary, 'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write']
        for setting in settings:
            args += ['-c', setting]
    else:
        plugin = work / 'plugin'
        (plugin / '.claude-plugin').mkdir(parents=True)
        (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({'name': 'opendirector', 'version': '0.1.0'}))
        (plugin / 'skills').symlink_to(work / '.agents/skills', target_is_directory=True)
        args = [binary, '-p', '--verbose', '--system-prompt', SYSTEM,
            '--output-format', 'stream-json', '--plugin-dir', str(plugin), '--tools', 'Skill,Bash,Read',
            '--strict-mcp-config', '--mcp-config', json.dumps({'mcpServers': {'opendirector': bridge}}),
            '--allowedTools', 'mcp__opendirector__*', 'Skill(opendirector:*)', 'Bash', 'Read',
            '--permission-mode', 'dontAsk', '--setting-sources', '']
    if model:
        args += ['--model', model]
    return args, env


def text_events(runtime: str, raw: dict) -> list[dict]:
    if runtime == 'claude' and raw.get('error') == 'authentication_failed':
        raise ProjectError('Claude Code 登录已过期，请在终端执行 claude auth login 后重试。', 401)
    if raw['type'] in {'error', 'turn.failed'} or raw['type'] == 'result' and raw.get('is_error'):
        raise ProjectError(f'{runtime} 运行失败，请检查登录、模型或原生轨迹。', 502)
    if runtime == 'opencode' and raw['type'] == 'text':
        return [{'type': 'delta', 'text': raw['part']['text']}]
    if runtime == 'codex' and raw['type'] == 'item.completed' and raw['item']['type'] == 'agent_message':
        return [{'type': 'delta', 'text': raw['item']['text']}]
    if runtime == 'claude' and raw['type'] == 'assistant':
        return [{'type': 'delta', 'text': part['text']} for part in raw['message']['content'] if part['type'] == 'text']
    return []


class NativeRuntime:
    def __init__(self, provider=None):
        self.transport = provider.transport if isinstance(provider, ChatCompletions) else None

    async def stream(self, run: RunContext, gateway: ToolGateway):
        project_id, turn_id = run.project_id, run.turn_id
        directory, config, context = run.directory, run.config, run.messages
        selected, thinking = run.selected_skills, run.thinking
        runtime, runtime_model, catalog = ('opencode' if run.runtime == 'default' else run.runtime), run.runtime_model, run.skills
        queue = asyncio.Queue(maxsize=128)
        pending = set()
        closed = False
        token = secrets.token_urlsafe(32)
        process = pump = stderr_task = None
        with TemporaryDirectory(prefix='od-agent-', dir=None if os.name == 'nt' else '/tmp') as temporary:
            work = (directory / 'agent-runs' / str(turn_id) / 'work').resolve()
            work.mkdir(parents=True, exist_ok=False)
            roots = prepare_skills(work, catalog)
            roots += [Path(item['filePath']).resolve().parent for item in catalog]
            gateway.roots = roots
            async def connection(reader, writer):
                task = asyncio.current_task()
                pending.add(task)
                request = {}
                try:
                    envelope = json.loads(await asyncio.wait_for(reader.readline(), 15))
                    request = envelope['request']
                    if not secrets.compare_digest(envelope['token'], token):
                        raise ProjectError('Invalid gateway token', 403)
                    if closed:
                        raise ProjectError('Agent run is closed', 409)
                    method = request['method']
                    if method == 'initialize':
                        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'opendirector', 'version': '0.1.0'}}
                    elif method == 'tools/list':
                        result = {'tools': [{'name': item['function']['name'], 'description': item['function']['description'],
                            'inputSchema': item['function']['parameters'],
                            'annotations': {'readOnlyHint': item['function']['name'] != 'execute_command'}} for item in tools()]}
                    elif method == 'tools/call':
                        params = request['params']
                        key = str(request['id'])
                        await queue.put({'type': 'tool', 'id': 'mcp:' + key, 'name': params['name'], 'status': 'running',
                            'arguments': params.get('arguments', {})})
                        outcome = await gateway.call('mcp:' + key, params['name'], params.get('arguments', {}))
                        result = {'content': [{'type': 'text', 'text': json.dumps(outcome.value, ensure_ascii=False)}],
                                  'isError': bool(outcome.error)}
                        if params['name'] == 'query' and params.get('arguments', {}).get('type') == 'asset.preview' and not outcome.error:
                            preview = outcome.value.get('preview')
                            if preview:
                                content = base64.b64encode(await asyncio.to_thread(Path(preview['path']).read_bytes)).decode()
                                media_type = 'image' if preview['mimeType'].startswith('image/') else 'audio'
                                result['content'].append({'type': media_type, 'data': content, 'mimeType': preview['mimeType']})
                        detail = json.dumps(outcome.value, ensure_ascii=False, indent=2)
                        await queue.put({**outcome.event(params['name']), 'id': 'mcp:' + key,
                            'arguments': params.get('arguments', {}), 'result': detail[:65536],
                            'resultTruncated': len(detail) > 65536})
                    elif method == 'ping':
                        result = {}
                    else:
                        raise ProjectError('Unsupported MCP method')
                    response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
                except (ProjectError, ValueError, KeyError, OSError, TimeoutError) as failure:
                    response = {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32000, 'message': str(failure)}}
                try:
                    writer.write(json.dumps(response, ensure_ascii=False).encode() + b'\n')
                    await writer.drain()
                finally:
                    writer.close()
                    await writer.wait_closed()
                    pending.discard(task)
            endpoint = str(Path(temporary) / 'mcp.sock')
            bridge_env = None
            if hasattr(asyncio, 'start_unix_server'):
                server = await asyncio.start_unix_server(connection, endpoint, limit=4 * 1024 * 1024)
            else:
                server = await asyncio.start_server(connection, '127.0.0.1', 0, limit=4 * 1024 * 1024)
                host, port = server.sockets[0].getsockname()[:2]
                bridge_env = {'OPENDIRECTOR_AGENT_HOST': str(host), 'OPENDIRECTOR_AGENT_PORT': str(port)}
            model = ModelGateway(config, thinking, token, str(project_id), str(turn_id), self.transport) if run.runtime == 'default' else None
            model_server = await asyncio.start_server(model.connect, '127.0.0.1', 0) if model else None
            try:
                model_url = f'http://127.0.0.1:{model_server.sockets[0].getsockname()[1]}' if model_server else ''
                deepseek_server = None
                if runtime == 'deepseek':
                    args, env, deepseek_server = deepseek.command(work, endpoint, token, bridge_env)
                else:
                    args, env = command(run.runtime, work, endpoint, token,
                        config['modelId'] if config else runtime_model, model_url, catalog, bridge_env=bridge_env,
                        **({'input_modalities': config.get('inputModalities', ['text'])} if run.runtime == 'default' else {}))
                if thinking != 'auto' and runtime == 'codex':
                    args += ['-c', f'model_reasoning_effort={json.dumps(thinking)}']
                elif thinking != 'auto' and runtime == 'claude':
                    args += ['--effort', thinking]
                prompt = (f'Execution directory: {work}\n'
                    'Use inherited PATH to discover installed programs with command -v. '
                    'Read source assets at their supplied absolute paths; do not move or modify them. '
                    'Write all intermediate files and outputs into the execution directory. '
                    'Use OpenDirector business tools for project changes.\n'
                    + json.dumps(context, ensure_ascii=False))
                if selected:
                    name = selected[0]
                    if runtime == 'codex':
                        prompt = f'${name}\n' + prompt
                    elif runtime == 'claude':
                        prompt = f'/opendirector:{name}\n' + prompt
                    elif runtime == 'deepseek':
                        prompt = f'Use the native skill tool to load {name} from {work / ".agents/skills"} before proceeding.\n' + prompt
                    else:
                        prompt = f'Use the native skill tool to load {name} before proceeding.\n' + prompt
                try:
                    process = await asyncio.create_subprocess_exec(*args, cwd=work, env=env,
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE, start_new_session=True, limit=64 * 1024 * 1024)
                except OSError as error:
                    if run.runtime == 'default':
                        raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable') from error
                    raise
                stderr_tail = bytearray()
                async def drain_stderr():
                    while chunk := await process.stderr.read(4096):
                        stderr_tail.extend(chunk)
                        del stderr_tail[:-8192]
                stderr_task = asyncio.create_task(drain_stderr())
                if runtime != 'deepseek':
                    process.stdin.write(prompt.encode() + b'\n')
                    await process.stdin.drain()
                    process.stdin.close()
                async def output():
                    try:
                        if runtime == 'deepseek':
                            async def observe(raw):
                                await queue.put({'native': raw})
                            await deepseek.run(process, work, SYSTEM + '\n' + prompt, runtime_model, thinking, deepseek_server, observe)
                        else:
                            while line := await process.stdout.readline():
                                raw = json.loads(line)
                                await queue.put({'native': raw})
                        if await process.wait():
                            await stderr_task
                            diagnostic = stderr_tail.decode('utf-8', errors='replace').replace(token, '[redacted]')
                            if config and config.get('apiKey'):
                                diagnostic = diagnostic.replace(config['apiKey'], '[redacted]')
                            await queue.put({'native': {'type': 'diagnostic', 'stderr': diagnostic}})
                            raise ProjectError(f'{runtime} 进程退出（{process.returncode}），请检查 CLI 登录和配置。', 502)
                    finally:
                        await queue.put(None)
                pump = asyncio.create_task(output())
                run_dir = directory / 'agent-runs'
                run_dir.mkdir(exist_ok=True)
                native_calls = {}
                with (run_dir / f'{turn_id}.{runtime}.jsonl').open('a', encoding='utf-8') as trace:
                    while (event := await queue.get()) is not None:
                        trace.write(json.dumps(event, ensure_ascii=False) + '\n')
                        trace.flush()
                        if 'native' in event:
                            for item in (deepseek.events(event['native'], native_calls) if runtime == 'deepseek' else text_events(runtime, event['native'])):
                                yield item
                        else:
                            yield event
                    await pump
            finally:
                closed = True
                await gateway.close()
                server.close()
                await server.wait_closed()
                if model_server:
                    model.closed = True
                    model_server.close()
                    await model_server.wait_closed()
                    for task in model.active:
                        task.cancel()
                    await asyncio.gather(*model.active, return_exceptions=True)
                if runtime == 'deepseek' and pump and not pump.done():
                    while not queue.empty():
                        queue.get_nowait()
                    pump.cancel()
                    await asyncio.gather(pump, return_exceptions=True)
                if process is not None:
                    await terminate(process, group=True)
                while not queue.empty():
                    queue.get_nowait()
                if pump:
                    pump.cancel()
                    await asyncio.gather(pump, return_exceptions=True)
                while not queue.empty():
                    queue.get_nowait()
                if stderr_task:
                    stderr_task.cancel()
                    await asyncio.gather(stderr_task, return_exceptions=True)
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
