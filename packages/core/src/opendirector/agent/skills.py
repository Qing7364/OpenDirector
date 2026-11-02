"""Discover approved skills with OpenCode's native loader."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from opendirector.agent.native import executable
from opendirector.agent.process import terminate
from opendirector.agent.tools import ROOT
from opendirector.domain.projects import ProjectError


async def skills(repository: Path, directory: Path) -> list[dict[str, str]]:
    binary = executable('default')
    if binary is None:
        raise ProjectError('技能发现需要内置 OpenCode，请执行 npm ci。', 503)
    roots = [path.resolve() for path in [directory / '.opendirector/skills',
        repository / '.opendirector/skills', ROOT / 'packages/agent/skills'] if path.is_dir()]
    with TemporaryDirectory(prefix='od-skills-', dir='/tmp') as temporary:
        env = {**os.environ, 'XDG_CONFIG_HOME': temporary,
               'OPENCODE_DISABLE_EXTERNAL_SKILLS': '1', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS': '1',
               'OPENCODE_CONFIG_CONTENT': json.dumps({'skills': {'paths': list(map(str, roots))}})}
        process = await asyncio.create_subprocess_exec(binary, 'debug', 'skill', '--pure',
            cwd=temporary, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            data, _ = await asyncio.wait_for(process.communicate(), 20)
            if process.returncode:
                raise ProjectError('OpenCode 技能发现失败，请检查 npm 依赖。', 503)
            try:
                catalog = json.loads(data)
            except json.JSONDecodeError:
                raise ProjectError("OpenCode 返回了无效的技能目录，请检查 CLI 版本。", 503) from None
            found = []
            for item in catalog:
                path = Path(item['location']).resolve()
                if any(path.is_relative_to(root) for root in roots) and path.is_file() and path.stat().st_size <= 65536:
                    source = 'builtin' if path.is_relative_to(ROOT / 'packages/agent/skills') else 'project' if path.is_relative_to(directory / '.opendirector/skills') else 'workspace'
                    found.append({'name': item['name'], 'description': item['description'], 'filePath': str(path), 'source': source})
            return found
        finally:
            await terminate(process)
