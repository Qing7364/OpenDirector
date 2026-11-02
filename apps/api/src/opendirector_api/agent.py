"""Project-scoped assistant persistence and native runtime streaming."""
import asyncio
from contextlib import suppress
import json
import logging
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid5

from anyio import CancelScope
from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from opendirector.agent.catalog import model_choices
from opendirector.agent.context import RunContext, RuntimeId
from opendirector.agent.runtime import AgentRuntimes, runtime_available, configured_runtimes, runtime_spec
from opendirector.agent.skills import skills
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import durable_json
from opendirector.infrastructure.local_projects import child, read_json

logger = logging.getLogger(__name__)


Runtime = RuntimeId


class Draft(BaseModel):
    conversationId: UUID | None = None
    model_config = ConfigDict(extra='forbid')
    draft: str = Field(default='', max_length=20000)
    draftContent: list[dict[str, JsonValue]] | None = None
    assets: list[dict[str, JsonValue]] = Field(default_factory=list, max_length=64)
    runtime: Runtime = 'default'
    runtimeModel: str | None = Field(default=None, max_length=200)
    harnessModels: dict[Literal["opencode", "codex", "claude"], Annotated[str, Field(max_length=200)] | None] = Field(default_factory=dict)
    thinking: Literal['auto', 'low', 'medium', 'high'] = 'auto'
    modelSelections: dict[str, str | None] = Field(default_factory=dict)
    skills: list[str] = Field(default_factory=list, max_length=1)


class Turn(BaseModel):
    conversationId: UUID | None = None
    model_config = ConfigDict(extra='forbid')
    id: UUID
    modelId: UUID | None = None
    text: str = Field(min_length=1, max_length=20000)
    content: list[dict[str, JsonValue]] | None = None
    assets: list[UUID] = Field(default_factory=list, max_length=64)
    runtime: Runtime = 'default'
    runtimeModel: str | None = Field(default=None, max_length=200)
    thinking: Literal['auto', 'low', 'medium', 'high'] = 'auto'
    modelSelections: dict[str, str | None] = Field(default_factory=dict)
    skills: list[str] = Field(default_factory=list, max_length=1)


class Conversations:
    def __init__(self, projects):
        self.projects = projects

    def path(self, project_id: UUID, session: str | None = None) -> Path:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            return directory

    def update(self, project_id: UUID, session: str | None = None, *, draft: Draft | None = None,
               begin: dict | None = None, finish: dict | None = None, conversation_id: UUID | None = None) -> dict:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            value = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            supplied = draft.conversationId if draft is not None else conversation_id
            if (draft is not None or begin is not None or finish is not None) and str(supplied) != value['conversationId'] and (supplied is not None or value.get('archivedConversations')):
                raise ProjectError('当前对话已切换，请重新加载后重试；原对话未覆盖。', 409)
            changed = False
            if draft is not None:
                value.update(draft.model_dump(mode="json", exclude={"conversationId"}))
                changed = True
            if begin is not None:
                if any(message['id'] == begin['id'] for message in value['messages']):
                    raise ProjectError('这条消息已接受，请读取对话，不要重复发送。', 409)
                value['messages'].append(begin)
                value['messages'].append({'id': str(uuid5(UUID(begin['id']), 'assistant')),
                    'role': 'assistant', 'text': '', 'status': 'streaming',
                    **{key: begin[key] for key in ('model', 'runtime') if key in begin}})
                value.update(draft='', draftContent=None, assets=[], skills=[])
                changed = True
            if finish is not None:
                value['messages'] = [finish if message['id'] == finish['id'] else message for message in value['messages']]
                changed = True
            if changed:
                durable_json(file, value)
            return {key: item for key, item in value.items() if key != 'archivedConversations'}

    def list(self, project_id: UUID) -> dict:
        directory = self.path(project_id)
        file = child(child(directory, 'agent-runs'), 'conversation.json')
        with self.projects.local.transaction():
            current = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
            return {'activeId': current['conversationId'], 'items': [
                {'id': item['conversationId'],
                 'title': next((message['text'].strip().split('\n')[0][:48] or '素材对话'
                                for message in item['messages'] if message['role'] == 'user'), '新对话'),
                 'messageCount': len(item['messages'])}
                for item in [current, *current.get('archivedConversations', [])]]}

    def activate(self, project_id: UUID, conversation_id: UUID, session: str, *, create=False) -> dict:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            self.projects._lease(db, project_id, directory, session)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            current = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump(mode='json')}
            current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
            archives = current.pop('archivedConversations', [])
            if current['conversationId'] == str(conversation_id):
                return current
            target = next((item for item in archives if item['conversationId'] == str(conversation_id)), None)
            if target is None:
                if not create:
                    raise ProjectError('对话不存在。', 404)
                if len(archives) >= 99:
                    raise ProjectError('项目对话已达 100 个，暂不能继续新建。', 409)
                target = {'messages': [], **Draft().model_dump(mode='json'),
                          **{key: current[key] for key in ('runtime', 'runtimeModel', 'harnessModels', 'thinking', 'modelSelections') if key in current},
                          'conversationId': str(conversation_id)}
            archives = [item for item in archives if item['conversationId'] != str(conversation_id)]
            durable_json(file, {**target, 'archivedConversations': [current, *archives]})
            return target


class ConversationCreate(BaseModel):
    id: UUID


def agent_routes(projects, generation, configs, provider=None) -> APIRouter:
    router = APIRouter(prefix='/api/creation/projects/{project_id}/assistant')
    conversations = Conversations(projects)
    runtimes = AgentRuntimes(projects, generation, configs, provider)
    active: dict[UUID, tuple[UUID, asyncio.Task]] = {}
    admission: dict[UUID, asyncio.Lock] = {}

    @router.get('')
    async def conversation(project_id: UUID):
        return await asyncio.to_thread(conversations.update, project_id)

    @router.get('/conversations')
    async def list_conversations(project_id: UUID):
        return await asyncio.to_thread(conversations.list, project_id)

    async def change_conversation(project_id: UUID, conversation_id: UUID, session: UUID, *, create=False):
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('请先停止或等待当前回复结束，再切换对话。', 409)
            return await asyncio.to_thread(conversations.activate, project_id, conversation_id, str(session), create=create)

    @router.post('/conversations')
    async def new_conversation(project_id: UUID, value: ConversationCreate, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, value.id, x_opendirector_session, create=True)

    @router.post('/conversations/{conversation_id}/activate')
    async def activate_conversation(project_id: UUID, conversation_id: UUID, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, conversation_id, x_opendirector_session)

    @router.put('/draft')
    async def draft(project_id: UUID, value: Draft, x_opendirector_session: UUID = Header()):
        return await asyncio.to_thread(conversations.update, project_id, str(x_opendirector_session), draft=value)

    @router.get('/runtimes')
    async def available_runtimes(project_id: UUID):
        await asyncio.to_thread(conversations.path, project_id)
        return await configured_runtimes()

    @router.get('/runtimes/{runtime}/models')
    async def runtime_models(project_id: UUID, runtime: Literal['opencode', 'codex', 'claude']):
        await asyncio.to_thread(conversations.path, project_id)
        return await model_choices(runtime)

    @router.get('/skills')
    async def catalog(project_id: UUID):
        directory = await asyncio.to_thread(conversations.path, project_id)
        found = await skills(projects.local.repository, directory)
        return [{key: item[key] for key in ('name', 'description', 'source')} for item in found]

    @router.post('/turns/{turn_id}/stop')
    async def stop(project_id: UUID, turn_id: UUID, x_opendirector_session: UUID = Header()):
        await asyncio.to_thread(conversations.path, project_id, str(x_opendirector_session))
        running = active.get(project_id)
        if running and running[0] == turn_id:
            with CancelScope(shield=True):
                if not running[1].cancelling():
                    running[1].cancel()
                with suppress(asyncio.CancelledError):
                    await running[1]
        return {'ok': True}

    @router.post('/turns')
    async def turn(project_id: UUID, value: Turn, x_opendirector_session: UUID = Header()):
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('当前工程已有回复正在执行。', 409)
            session = str(x_opendirector_session)
            directory = await asyncio.to_thread(conversations.path, project_id, session)
            if not runtime_available(value.runtime):
                raise ProjectError(f'{value.runtime} 未安装，请安装 CLI 并登录。', 503)
            spec = runtime_spec(value.runtime)
            config = await asyncio.to_thread(configs.resolve, str(value.modelId), 'agent') if spec.modelSource == 'settings' else None
            available = await skills(projects.local.repository, directory)
            if set(value.skills) - {item['name'] for item in available}:
                raise ProjectError('技能已失效，请重新选择。', 409)
            snapshot = await asyncio.to_thread(projects.snapshot, project_id)
            assets = {asset.id: asset for asset in snapshot.assets}
            for asset_id in value.assets:
                if asset_id not in assets:
                    raise ProjectError('引用素材不属于当前工程。', 409)
            model = config['modelId'] if config else (value.runtimeModel or 'CLI 默认模型')
            queue: asyncio.Queue = asyncio.Queue(maxsize=128)
            async def produce() -> None:
                text, status, error, accepted = '', 'complete', None, False
                activities = []
                try:
                    user = {'id': str(value.id), 'role': 'user', 'text': value.text, 'content': value.content,
                        'assets': [{'id': str(assets[key].id), 'name': assets[key].name, 'type': assets[key].metadata.mimeType,
                            'size': assets[key].metadata.size, 'fingerprint': assets[key].fingerprint} for key in value.assets],
                        'skills': value.skills, 'runtime': value.runtime, 'runtimeModel': value.runtimeModel,
                        'model': model, 'status': 'complete'}
                    saved = await asyncio.to_thread(conversations.update, project_id, session, begin=user, conversation_id=value.conversationId)
                    accepted = True
                    await queue.put({'type': 'start', 'conversation': saved})
                    context = [{'role': message['role'], 'content': message['text'] or '(empty reply)'} for message in saved['messages'][:-1]]
                    if value.assets:
                        references = [{'id': str(assets[key].id), 'name': assets[key].name,
                            'kind': assets[key].kind, 'path': str((directory / assets[key].path).resolve()),
                            'metadata': assets[key].metadata.model_dump(mode='json', exclude_none=True)}
                            for key in value.assets]
                        context[-1]['content'] += '\nReferenced project assets: ' + json.dumps(references, ensure_ascii=False)
                        context[-1]['content'] += '\nThese are asset references, not visual observations. Inspect media with available tools before describing its contents.'
                    run = RunContext(runtime=value.runtime, project_id=project_id, turn_id=value.id,
                        session=session, directory=directory, config=config, messages=context,
                        selected_skills=value.skills, thinking=value.thinking,
                        runtime_model=value.runtimeModel, skills=available)
                    async for event in runtimes.stream(run):
                        if event['type'] == 'delta':
                            text += event['text']
                        if event['type'] == 'tool':
                            previous = next((item for item in activities if item['id'] == event['id']), None)
                            activity = {**{key: item for key, item in event.items() if key != 'type'},
                                        'textOffset': previous['textOffset'] if previous else len(text)}
                            if previous is None:
                                activities.append(activity)
                            else:
                                activities[activities.index(previous)] = activity
                            event = {'type': 'tool', **activity}
                        await queue.put(event)
                except asyncio.CancelledError:
                    status = 'stopped'
                    raise
                except Exception as failure:
                    # Persist partial output even when an integration fails unexpectedly.
                    status = 'interrupted'
                    error = str(failure) if isinstance(failure, ProjectError) else 'Agent 执行失败，请检查后端日志。'
                    logger.exception(f'agent.turn.failed project_id={project_id} turn_id={value.id}')
                finally:
                    if accepted:
                        for activity in activities:
                            if activity['status'] == 'running':
                                activity['status'] = 'interrupted'
                        saved = await asyncio.to_thread(conversations.update, project_id, finish={
                            'id': str(uuid5(value.id, 'assistant')), 'role': 'assistant', 'text': text, 'status': status,
                            'model': model,
                            'runtime': value.runtime, 'thinking': value.thinking, 'tools': activities}, conversation_id=value.conversationId)
                    else:
                        saved = None
                    if asyncio.current_task().cancelling():
                        while not queue.empty():
                            queue.get_nowait()
                    await queue.put({'type': 'end', 'conversation': saved, 'error': error})

            if project_id in active:
                raise ProjectError('当前工程已有回复正在执行。', 409)
            task = asyncio.create_task(produce())
            active[project_id] = (value.id, task)
            def release(completed: asyncio.Task) -> None:
                if active.get(project_id) == (value.id, completed):
                    active.pop(project_id)
            task.add_done_callback(release)
            async def events():
                try:
                    while True:
                        event = await queue.get()
                        yield 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
                        if event['type'] == 'end':
                            break
                finally:
                    # A disconnected SSE request must not cancel persistence during cleanup.
                    with CancelScope(shield=True):
                        if not task.done() and not task.cancelling():
                            task.cancel()
                        with suppress(asyncio.CancelledError):
                            await task
            return StreamingResponse(events(), media_type='text/event-stream')

    return router
