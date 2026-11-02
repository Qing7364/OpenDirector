import asyncio
import sys

import pytest

from opendirector.agent import runtime


@pytest.mark.parametrize(('engine', 'output', 'exit_code', 'expected'), [
    ('codex', '', 0, 'ready'),
    ('codex', '', 1, 'needs_login'),
    ('claude', '{"loggedIn":true}', 0, 'ready'),
    ('claude', '{"loggedIn":false}', 1, 'needs_login'),
    ('claude', 'invalid output', 0, 'unknown'),
])
def test_login_readiness(tmp_path, monkeypatch, engine, output, exit_code, expected):
    cli = tmp_path / 'cli'
    cli.write_text(f'#!{sys.executable}\nprint({output!r})\nraise SystemExit({exit_code})\n')
    cli.chmod(0o755)
    monkeypatch.setattr(runtime.native, 'executable', lambda _: cli)
    assert asyncio.run(runtime.runtime_readiness(engine)) == expected


def test_missing_install(monkeypatch):
    monkeypatch.setattr(runtime.native, 'executable', lambda _: None)
    assert asyncio.run(runtime.runtime_readiness('codex')) == 'not_installed'


def test_catalog_probes_cli_and_bundled_separately(monkeypatch):
    calls = []

    async def probe(engine):
        calls.append(engine)
        return 'needs_login' if engine == 'claude' else 'ready'

    monkeypatch.setattr(runtime, 'runtime_readiness', probe)
    result = asyncio.run(runtime.configured_runtimes())
    assert calls == ['default', 'opencode', 'codex', 'claude']
    assert [item['status'] for item in result] == ['ready', 'ready', 'ready', 'needs_login']


def test_opencode_binary_sources(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime.native, 'ROOT', tmp_path)
    monkeypatch.setattr(runtime.native.shutil, 'which', lambda name: '/local/bin/' + name)
    assert runtime.native.executable('default') is None
    binary = tmp_path / 'node_modules/opencode-ai/bin/opencode.exe'
    binary.parent.mkdir(parents=True)
    binary.touch()
    assert runtime.native.executable('default') == str(binary)
    assert runtime.native.executable('opencode') == '/local/bin/opencode'


def test_opencode_cli_and_default_use_separate_model_paths(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(runtime.native, 'executable', lambda name: '/bin/' + name)
    monkeypatch.setenv('XDG_CONFIG_HOME', '/existing/config')
    cli_args, cli_env = runtime.native.command('opencode', tmp_path, '/tmp/socket', 'turn-token', 'local/my-model', '', [])
    cli_config = json.loads(cli_env['OPENCODE_CONFIG_CONTENT'])
    assert cli_args[0] == '/bin/opencode'
    assert cli_args[-1] == 'local/my-model'
    assert cli_env['XDG_CONFIG_HOME'] == '/existing/config'
    assert 'provider' not in cli_config
    assert 'OPENDIRECTOR_MODEL_KEY' not in cli_env
    args, env = runtime.native.command('default', tmp_path, '/tmp/socket', 'turn-token', 'project-model', 'http://loopback', [])
    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
    assert args[0] == '/bin/default'
    assert args[-1] == 'opendirector/project-model'
    assert env['XDG_CONFIG_HOME'] == str(tmp_path)
    assert config['provider']['opendirector']['options']['baseURL'] == 'http://loopback'
    assert runtime.runtime_spec('opencode').modelSource == 'cli'
    assert runtime.runtime_spec('default').modelSource == 'settings'
