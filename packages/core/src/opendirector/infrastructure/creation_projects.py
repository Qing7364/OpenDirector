"""File-authoritative creation projects, using LocalProjects coordination.

An immutable commit contains the snapshot, command receipt and outbox event.
A durable intent precedes every filesystem mutation. Publishing project.json
is the commit point; reads first finish pending intents under the catalog lock.
SQLite coordinates leases only and is never used to roll back file writes.
"""
from collections.abc import Callable
from collections import OrderedDict
from pathlib import Path
from typing import Literal
from uuid import UUID
from hashlib import sha256
import os
import threading
import time

from pydantic import Field, ValidationError, model_validator

from opendirector.domain.creation.base import Contract, Digest, ObjectVersion, digest
from opendirector.domain.creation.commands import Command, CommandReceipt, ProjectEvent, command_fingerprint
from opendirector.domain.creation.project import Project, ProjectSnapshot, ViewState
from opendirector.domain.creation.validation import ContractError, validate_command
from opendirector.domain.projects import ProjectError, identifier, project_name
from opendirector.infrastructure.local_projects import LocalProjects, child, read_json, write_json
from opendirector.infrastructure import recycle
from opendirector.infrastructure.rename import rename_path
from opendirector.infrastructure.creation_files import AssetFileDelete, AssetFileWrite, cleanup_staging, delete_files, install_files


class Manifest(Contract):
    format: Literal['opendirector-project'] = Field(default='opendirector-project', description='Serialized format identifier.')
    formatVersion: Literal[2] = Field(default=2, description='Project format version.')
    id: UUID = Field(description='Stable object ID.')
    name: str = Field(description='User-visible name.')
    head: UUID = Field(description='Current committed command ID.')


class CommitRecord(Contract):
    schemaVersion: Literal[1] = Field(default=1, description='Record schema version.')
    command: Command = Field(description='Immutable command recorded in this commit.')
    previousHead: UUID | None = Field(description='Previous commit ID, or null for project creation.')
    snapshot: ProjectSnapshot = Field(description='Authoritative project snapshot.')
    receipt: CommandReceipt = Field(description='Immutable command execution receipt.')
    event: ProjectEvent | None = Field(description='Project change event, if emitted.')

    @model_validator(mode='after')
    def consistent(self):
        if (self.command.projectId != self.snapshot.project.id
                or self.receipt.projectId != self.command.projectId
                or self.receipt.commandId != self.command.commandId
                or self.receipt.inputFingerprint != command_fingerprint(self.command)
                or self.receipt.eventCursor != self.snapshot.eventCursor):
            raise ValueError('Commit identity is inconsistent')
        applied = self.receipt.status in {'applied', 'accepted'}
        if applied != (self.event is not None):
            raise ValueError('Only applied commits have outbox events')
        if self.event is not None:
            if (self.event.projectId != self.command.projectId or self.event.commandId != self.command.commandId
                    or self.event.cursor != self.snapshot.eventCursor or self.event.jobIds != self.receipt.jobIds
                    or tuple(change.version for change in self.event.changed) != self.receipt.changed):
                raise ValueError('Outbox event differs from the committed receipt')
        return self


class CommitIntent(Contract):
    schemaVersion: Literal[1] = Field(default=1, description='Record schema version.')
    fromName: str | None = Field(description='Original project directory name.')
    toName: str = Field(description='Destination project directory name.')
    beforeFingerprint: Digest | None = Field(description='Fingerprint of the project before this commit.')
    record: CommitRecord = Field(description='Immutable commit awaiting publication.')
    files: tuple[AssetFileWrite, ...] = Field(default=(), description='Staged asset files installed before commit publication.')
    deletes: tuple[AssetFileDelete, ...] = Field(default=(), description='Asset file removals performed after publication.')

    @model_validator(mode='after')
    def consistent(self):
        project_name(self.toName)
        if self.fromName is not None:
            project_name(self.fromName)
        creating = self.fromName is None
        if creating != (self.record.previousHead is None) or creating != (self.beforeFingerprint is None):
            raise ValueError('Creation intent has no prior project')
        if creating and self.record.command.type != 'project.create':
            raise ValueError('First commit must create a project')
        ids = [write.assetId for write in self.files]
        if len(ids) != len(set(ids)):
            raise ValueError('File destinations must be unique')
        assets = {asset.id: asset for asset in self.record.snapshot.assets}
        created = {version.id for version in self.record.receipt.changed if version.objectType == 'asset'}
        for write in self.files:
            asset = assets.get(write.assetId)
            if (asset is None or asset.id not in created or asset.fingerprint != write.fingerprint
                    or asset.metadata.size != write.size):
                raise ValueError('File write must match its committed asset')
        deleted = {change.version.id for change in self.record.event.changed if change.change == 'deleted' and change.version.objectType == 'asset'} if self.record.event else set()
        if any(value.assetId not in deleted or value.assetId in assets for value in self.deletes):
            raise ValueError('Deleted files must have committed asset deletions')
        return self


def sync_directory(path: Path):
    # Windows does not expose directory fsync through os.open.
    if os.name == 'nt':
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_json(path: Path, value):
    write_json(path, value)
    sync_directory(path.parent)


def directory(path: Path):
    if path.is_symlink() or path.resolve() != path:
        raise ProjectError('工程存储目录不能是符号链接。', 409, code='storage_unavailable')
    if path.exists() and not path.is_dir():
        raise ProjectError('工程存储目录被文件占用。', 409, code='storage_unavailable')
    return path


def object_index(snapshot):
    result = {('project', snapshot.project.id): snapshot.project}
    for kind, collection in [('asset', snapshot.assets), ('generation_spec', snapshot.generationSpecs),
            ('reference', snapshot.references), ('canvas_item', snapshot.canvasItems),
            ('editor_document', snapshot.editorDocuments), ('job', snapshot.jobs), ('result', snapshot.results)]:
        result.update({(kind, item.id): item for item in collection})
    return result


def object_changes(before, after, command):
    """The storage boundary also checks revisions on trusted service writes."""
    old = object_index(before) if before else {}
    new = object_index(after)
    expected = {(item.objectType, item.id): item.revision for item in command.expectedVersions}
    changed = []
    for key in sorted(old.keys() | new.keys(), key=lambda item: (item[0], str(item[1]))):
        previous, current = old.get(key), new.get(key)
        if previous == current:
            continue
        kind, object_id = key
        if previous is not None and expected.get(key) != previous.revision:
            raise ContractError('revision_conflict', 'Every changed object requires its current version', object_id)
        if current is not None and current.revision != (previous.revision + 1 if previous else 1):
            raise ContractError('revision_conflict', 'Object revisions must advance exactly once', object_id)
        change = 'created' if previous is None else 'deleted' if current is None else 'updated'
        if kind == 'canvas_item' and previous and current and previous.visible and not current.visible:
            change = 'hidden'
        changed.append(dict(version=ObjectVersion(objectType=kind, id=object_id,
                            revision=current.revision if current else previous.revision), change=change))
    return changed


# Every read validates the whole commit chain, and each record holds a full
# project snapshot. The cache must fit a long project's history: below that,
# each read reparses every record from disk and holds the catalog lock long
# enough to expire sessions and interrupt running jobs.
RECORD_CACHE_ENTRIES = 4096
RECORD_CACHE_BYTES = 512 * 1024 * 1024
# Only the validated head of each open project is kept, so this stays small.
CURRENT_CACHE_ENTRIES = 16


def _file_signature(file):
    stat = file.stat(follow_symlinks=False)
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _head_signature(path, head, verify_bytes=False):
    """Cheap identity of a commit file, or None when it cannot be read."""
    file = child(directory(child(path, 'commits')), f'{head}.json')
    try:
        signature = _file_signature(file)
        if verify_bytes:
            content = sha256(file.read_bytes()).digest()
            if _file_signature(file) != signature:
                return None
            return (*signature, content)
        return signature
    except OSError:
        return None


class CreationProjects:
    """Authoritative repository for lifecycle and shared creation commands.

    commit() is an internal application-service boundary;
    untrusted clients cannot supply a callback or replace an entire snapshot.
    """
    def __init__(self, local: LocalProjects):
        self.local = local
        self.root = local.root
        self.state_dir = directory(local.state_dir)
        self.intents = directory(child(self.state_dir, 'creation-commits'))
        self._blocked = {}
        self._warnings = []
        self._invalid = []
        self._records_cache = OrderedDict()
        self._records_cache_bytes = 0
        # Windows ctime is creation time. Verify bytes there before reusing a
        # parsed record, including when an external writer restores its mtime.
        self._verify_record_bytes = os.name == 'nt'
        self._current_cache: "OrderedDict[tuple, CommitRecord]" = OrderedDict()
        # Reads arrive on several threads; the dict is only ever touched here.
        self._cache_lock = threading.Lock()
        with local.transaction():
            self._recover()

    def _checkpoint(self, stage):
        """Fault-injection boundary. Never participates in production decisions."""

    @staticmethod
    def _manifest(path):
        directory(path)
        raw = read_json(child(path, 'project.json'))
        if not isinstance(raw, dict) or raw.get('format') != 'opendirector-project' or raw.get('formatVersion') != 2:
            raise ProjectError('不支持该工程格式；请创建新工程，旧文件不会自动转换。', 409, code='unsupported_format')
        try:
            value = Manifest.model_validate(raw)
            project_name(value.name)
            return value
        except (ValueError, TypeError):
            raise ProjectError('工程清单无效，原文件已保留。', 409, code='storage_unavailable') from None

    def _scan(self):
        self.local._check_root()
        grouped, unsupported, warnings = {}, set(), list(self._warnings)
        self._invalid = []
        if self.root.is_dir():
            for path in sorted(self.root.iterdir()):
                if path.is_symlink() or not path.is_dir() or path.name.startswith('.opendirector-'):
                    continue
                manifest_path = path / 'project.json'
                if not manifest_path.exists() and not manifest_path.is_symlink():
                    continue
                try:
                    project_name(path.name)
                    raw = read_json(child(path, 'project.json'))
                    project_id = identifier(raw['id'])
                    grouped.setdefault(project_id, []).append(path)
                    if raw.get('format') != 'opendirector-project' or raw.get('formatVersion') != 2:
                        unsupported.add(project_id)
                except (OSError, ValueError, TypeError, KeyError, ProjectError):
                    warning = f'工程“{path.name}”的清单无法读取，原文件已保留。'
                    warnings.append(warning)
                    self._invalid.append((path, warning))
        conflicts = {key for key, paths in grouped.items() if len(paths) > 1}
        for key in sorted(conflicts):
            warnings.append(f'工程标识重复：{key}；请移走重复目录后重试。')
        return grouped, unsupported, conflicts, warnings

    def _find(self, db, project_id):
        project_id = identifier(str(project_id))
        if project_id in self._blocked:
            raise ProjectError('工程提交需要恢复；请检查磁盘及工程文件后重试。', 409, code='storage_unavailable')
        grouped, unsupported, conflicts, _ = self._scan()
        if project_id in conflicts:
            raise ProjectError('projects 中存在同标识工程，请移走重复目录后重试。', 409)
        if project_id in unsupported:
            raise ProjectError('不支持该工程格式；请创建新工程，旧文件不会自动转换。', 409, code='unsupported_format')
        if project_id not in grouped:
            raise ProjectError('工程不在 projects 中或清单无法读取，请刷新工程列表。', 404)
        path = grouped[project_id][0]
        return path, self._manifest(path)

    def _record(self, path, head):
        file = child(directory(child(path, 'commits')), f'{head}.json')
        try:
            before = _file_signature(file)
            cached = self._records_cache.get(file)
            # On platforms with reliable change times, a rewrite changes the
            # signature (ctime/mtime/size/inode). Re-reading and re-hashing every
            # historical commit on each read cost ~13 s per history query for a
            # project with hundreds of commits, holding the catalog lock past the
            # 15 s contention budget of unrelated saves. On Windows, verify bytes
            # because the file signature can remain unchanged after a rewrite.
            if cached and cached[0] == before and not self._verify_record_bytes:
                self._records_cache.move_to_end(file)
                # Private repository records are read-only. Public query
                # boundaries copy returned values, not every historical snapshot.
                return cached[1]
            raw = file.read_bytes() if self._verify_record_bytes else None
            content = sha256(raw).digest() if raw is not None else None
            if raw is not None and _file_signature(file) != before:
                raise ValueError('Commit changed during read')
            if cached and cached[0] == before and cached[2] == content:
                self._records_cache.move_to_end(file)
                return cached[1]
            if cached:
                self._records_cache_bytes -= self._records_cache.pop(file)[0][2]
            record = CommitRecord.model_validate_json(raw) if raw is not None else CommitRecord.model_validate(read_json(file))
            if _file_signature(file) != before:
                raise ValueError('Commit changed during read')
            if before[2] <= 8 * 1024 * 1024:
                self._records_cache[file] = (before, record, content)
                self._records_cache_bytes += before[2]
                while len(self._records_cache) > RECORD_CACHE_ENTRIES or self._records_cache_bytes > RECORD_CACHE_BYTES:
                    _, removed = self._records_cache.popitem(last=False)
                    self._records_cache_bytes -= removed[0][2]
            return record
        except (ValueError, TypeError, KeyError, FileNotFoundError):
            raise ProjectError('工程提交记录缺失或损坏，已阻止自动覆盖。', 409, code='storage_unavailable') from None

    def _history(self, path, manifest):
        records, seen, head = [], set(), manifest.head
        while head is not None:
            if head in seen:
                raise ProjectError('工程提交历史存在循环，原文件已保留。', 409, code='storage_unavailable')
            seen.add(head)
            record = self._record(path, head)
            if record.command.commandId != head or record.snapshot.project.id != manifest.id:
                raise ProjectError('工程提交身份不一致，原文件已保留。', 409, code='storage_unavailable')
            if records:
                newer = records[-1]
                if newer.snapshot.eventCursor != record.snapshot.eventCursor + (1 if newer.event else 0):
                    raise ProjectError('工程变更游标不连续，原文件已保留。', 409, code='storage_unavailable')
            records.append(record)
            head = record.previousHead
        if (not records or records[-1].command.type != 'project.create' or records[-1].snapshot.eventCursor != 1
                or records[0].snapshot.project.name != manifest.name):
            raise ProjectError('工程提交历史与清单不一致，原文件已保留。', 409, code='storage_unavailable')
        return records

    def _load(self, db, project_id):
        path, manifest = self._find(db, project_id)
        records = self._history(path, manifest)
        return path, manifest, records

    def _remember_current(self, path, record):
        signature = _head_signature(path, record.command.commandId, self._verify_record_bytes)
        if signature is None:
            return
        key = (str(path), str(record.command.commandId), signature)
        with self._cache_lock:
            self._current_cache[key] = record
            self._current_cache.move_to_end(key)
            while len(self._current_cache) > CURRENT_CACHE_ENTRIES:
                self._current_cache.popitem(last=False)

    def _current(self, db, project_id, path, manifest):
        """The head commit, reused while its file is untouched.

        Replaying and re-validating the whole chain for every read made opening
        a canvas take about a second. A commit leaves the old files alone and
        moves the head, and an outside rewrite changes the head file's
        signature, so both are noticed without trusting a bare timestamp.
        """
        signature = _head_signature(path, manifest.head, self._verify_record_bytes)
        key = (str(path), str(manifest.head), signature)
        if signature is not None:
            with self._cache_lock:
                cached = self._current_cache.get(key)
                if cached is not None:
                    self._current_cache.move_to_end(key)
                    return cached
        record = self._load(db, project_id)[2][0]
        if signature is not None:
            with self._cache_lock:
                self._current_cache[key] = record
                self._current_cache.move_to_end(key)
                while len(self._current_cache) > CURRENT_CACHE_ENTRIES:
                    self._current_cache.popitem(last=False)
        return record

    def _lease(self, db, project_id, path, session):
        if session is None:
            raise ProjectError('修改工程需要已打开的会话。', 409)
        identifier(session)
        lease = db.execute('SELECT path FROM sessions WHERE id=? AND project_id=? AND expires>?',
                           (session, str(project_id), time.time())).fetchone()
        if lease is None:
            raise ProjectError('工程已关闭或会话已过期，请重新打开后保存。', 409)
        if lease['path'] != str(path):
            raise ProjectError('工程目录已在应用外改名或移动，请复制未保存内容并重新打开。', 409)

    def _closed(self, db, project_id, snapshot, verb='重命名'):
        if db.execute('SELECT 1 FROM sessions WHERE project_id=? AND expires>?', (str(project_id), time.time())).fetchone():
            raise ProjectError(f'请先保存并关闭工程后再{verb}。', 409)
        if any(job.status in {'queued', 'running'} for job in snapshot.jobs):
            raise ProjectError(f'工程仍在生成素材，请等待或取消任务后再{verb}。', 409)
        path, _ = self._find(db, project_id)
        tools = child(path, 'tool-tasks')
        if tools.exists() and any(read_json(child(tools, item.name)).get('status') in {'queued', 'running'} for item in tools.glob('*.json')):
            raise ProjectError(f'工程仍有工具任务，请等待或取消任务后再{verb}。', 409)

    @staticmethod
    def _unreadable_item(path, reason, project_id=None):
        return dict(id=project_id, name=path.name, path=str(path), reason=reason)

    def _catalog(self, db):
        grouped, unsupported, conflicts, warnings = self._scan()
        invalid = list(self._invalid)
        projects = []
        unreadable = [self._unreadable_item(path, reason) for path, reason in invalid]
        for project_id in sorted(grouped):
            paths = grouped[project_id]
            if project_id in unsupported:
                reason = f'工程 {project_id} 使用旧格式，统一工程接口不支持读取或转换。'
                warnings.append(reason)
                unreadable.extend(self._unreadable_item(path, reason, project_id) for path in paths)
                continue
            if project_id in conflicts:
                reason = f'工程标识重复：{project_id}；请移走重复目录后重试。'
                unreadable.extend(self._unreadable_item(path, reason, project_id) for path in paths)
                continue
            try:
                path, manifest = self._find(db, project_id)
                # Parsing the head alone proves the project still opens, and the
                # manifest already carries the name it must agree with; a full
                # chain replay just to list a name cost about a second.
                record = self._record(path, manifest.head)
                if record.snapshot.project.name != manifest.name:
                    raise ProjectError('工程提交历史与清单不一致，原文件已保留。', 409, code='storage_unavailable')
                projects.append(dict(id=project_id, name=manifest.name, path=str(path)))
            except (ProjectError, OSError):
                reason = f'工程 {project_id} 需要恢复，原文件已保留。'
                warnings.append(reason)
                unreadable.append(self._unreadable_item(paths[0], reason, project_id))
        projects.sort(key=lambda item: (item['name'].casefold(), item['name']))
        unreadable.sort(key=lambda item: (item['name'].casefold(), item['name']))
        return dict(projects=projects, unreadable=unreadable, warnings=warnings)

    def list_projects(self):
        with self.local.transaction() as db:
            self._recover()
            return self._catalog(db)

    @staticmethod
    def _cleanup_blocker(db, project_id, path):
        active = db.execute('SELECT 1 FROM sessions WHERE expires>? AND (path=? OR project_id=?)',
                            (time.time(), str(path), project_id or '')).fetchone()
        if active:
            return '工程仍在其他窗口中打开，请关闭后再清理。'
        tools = path / 'tool-tasks'
        if tools.exists() or tools.is_symlink():
            try:
                directory(tools)
                tasks = [read_json(child(tools, item.name)) for item in tools.glob('*.json')]
                if any(not isinstance(task, dict) for task in tasks):
                    raise ValueError('Invalid tool task')
            except (OSError, ValueError, TypeError, KeyError, ProjectError):
                return '无法确认工具任务状态，请检查工程文件后再清理。'
            if any(task.get('status') in {'queued', 'running'} for task in tasks):
                return '工程仍有工具任务，请等待或取消任务后再清理。'
        return None

    def cleanup_unreadable(self):
        """Remove only directories that a fresh catalog read still cannot open."""
        with self.local.transaction() as db:
            self._recover()
            candidates = self._catalog(db)['unreadable']
        removed, failed = [], []
        for candidate in candidates:
            with self.local.transaction() as db:
                self._recover()
                current = next((item for item in self._catalog(db)['unreadable']
                                if item['path'] == candidate['path']), None)
                if current is None:
                    continue
                path = Path(current['path'])
                blocker = self._cleanup_blocker(db, current['id'], path)
            if blocker:
                failed.append(dict(name=current['name'], message=blocker))
                continue
            if not path.exists() and not path.is_symlink():
                continue
            try:
                directory(path)
                recycle.remove(path, recoverable=self.delete_mode == 'recycle_bin')
            except (OSError, ProjectError) as error:
                failed.append(dict(name=current['name'], message=str(error)))
                continue
            removed.append(current['name'])
            if current['id']:
                journal = self._journal(current['id'])
                if journal.exists():
                    # The project is gone; its pending recovery must not recreate
                    # a permanent catalog warning on the next read.
                    journal.unlink()
                    sync_directory(self.intents)
            with self.local.transaction() as db:
                db.execute('DELETE FROM sessions WHERE path=?', (str(path),))
                if current['id']:
                    db.execute('DELETE FROM sessions WHERE project_id=?', (current['id'],))
        if removed:
            sync_directory(self.root)
        return dict(removed=removed, failed=failed)

    def snapshot(self, project_id):
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            return self._current(db, project_id, path, manifest).snapshot.model_copy(deep=True)

    def head(self, project_id):
        """The current head commit, cheap enough to gate content-addressed caches.

        It skips the journal recovery that snapshot() runs: a caller only uses
        this to notice that a cached read is stale.
        """
        with self.local.transaction() as db:
            return self._find(db, project_id)[1].head

    def _read_manifest(self, project_id):
        """Resolve the current head under the catalog lock.

        Commit files are immutable once published, so the chain behind this head
        can be walked without holding the lock: a slow read only delays itself,
        not the saves and status polls that share the catalog.
        """
        with self.local.transaction() as db:
            self._recover()
            return self._find(db, project_id)

    def records(self, project_id):
        """Private commit records for read-only scans; callers must not mutate them.

        history() deep-copies every snapshot for callers that keep the records
        around. Scans that only count versions or owners would copy hundreds of
        megabytes for long histories, so they read the shared records directly.
        """
        path, manifest = self._read_manifest(project_id)
        return tuple(self._history(path, manifest))

    def history(self, project_id):
        records = self.records(project_id)
        # Private records are never mutated. Copy for the public caller after
        # releasing the global lock so large history reads do not block saves.
        return tuple(record.model_copy(deep=True) for record in records)

    def history_index(self, project_id):
        """Small detached event metadata; toolbar queries need no snapshots."""
        path, manifest = self._read_manifest(project_id)
        records = self._history(path, manifest)
        return records[0].snapshot.undoClearedThrough, tuple(dict(
            commandId=r.command.commandId, type=r.command.type,
            cursor=r.event.cursor, source=r.event.source,
            targetCommandId=getattr(r.command.payload, 'targetCommandId', None),
        ) for r in records if r.event is not None)

    def view(self, project_id, client_id, value=None, *, session=None, missing_ok=False):
        with self.local.transaction() as db:
            self._recover()
            path, _ = self._find(db, project_id)
            folder = directory(child(path, 'views'))
            file = child(folder, f'{UUID(str(client_id))}.json')
            if value is not None:
                self._lease(db, project_id, path, session)
                value = ViewState.model_validate(value)
                if str(value.projectId) != str(project_id) or str(value.clientId) != str(client_id):
                    raise ProjectError('视图不属于当前工程或客户端。')
                folder.mkdir(exist_ok=True)
                durable_json(file, value.model_dump(mode='json'))
                return value
            if file.exists():
                return ViewState.model_validate(read_json(file))
            return None if missing_ok else ViewState(projectId=project_id, clientId=client_id)

    def open(self, project_id, session):
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            self.local._open(db, dict(id=str(project_id), path=str(path)), session)
            return self._current(db, project_id, path, manifest).snapshot.model_copy(deep=True)

    def heartbeat(self, session, project_id):
        self.open(project_id, session)

    def receipt(self, project_id, command_id):
        with self.local.transaction() as db:
            self._recover()
            records = self._load(db, project_id)[2]
            found = next((record.receipt for record in records if str(record.command.commandId) == str(command_id)), None)
            if found is None:
                raise ProjectError('没有该命令的已提交回执。', 404)
            return found.model_copy(deep=True)

    def changes(self, project_id, *, after=0, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ProjectError('变更游标或分页大小无效。')
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            # A subscriber that is already caught up is the common polling
            # path. Replaying the commit chain here held the catalog lock for
            # about a second per poll on Windows and starved saves/heartbeats.
            head = self._current(db, project_id, path, manifest)
            cursor = head.snapshot.eventCursor
            if after > cursor:
                raise ProjectError('变更游标超出当前工程，请重新读取快照。', 409)
            if after == cursor:
                return dict(events=[], nextCursor=after, currentCursor=cursor, hasMore=False)
            records = self._load(db, project_id)[2]
            events = [record.event for record in reversed(records) if record.event and record.event.cursor > after][:limit]
            events = [event.model_copy(deep=True) for event in events]
            return dict(events=events, nextCursor=events[-1].cursor if events else after,
                        currentCursor=cursor, hasMore=bool(events and events[-1].cursor < cursor))

    def execute(self, command: Command, *, session=None, source='ui', imported_from=None):
        if command.type == 'project.trash':
            return self._trash(command, source)
        if command.type == 'project.restore':
            raise ProjectError('回收目录中的工程暂不支持在应用内恢复。', 501, code='capability_unsupported')
        if command.type in {'asset.import', 'asset.writeText', 'asset.updateMetadata'}:
            from opendirector.application.creation_assets import CreationAssets
            return CreationAssets(self).execute(command, session=session, source=source, imported_from=imported_from)
        if imported_from is not None:
            raise ProjectError('只有素材导入可以声明归档来源。', 400, code='invalid_input')
        if command.type == 'project.create':
            return self._create(command, source)
        if command.type in {'history.undo', 'history.redo', 'generationSpec.restore', 'canvas.applyVersion', 'asset.delete'}:
            from opendirector.application.creation_history import CreationHistory
            return CreationHistory(self).execute(command, session=session, source=source)
        if command.type != 'project.rename':
            from opendirector.application.creation_canvas import CreationCanvas
            return CreationCanvas(self).execute(command, session=session, source=source)
        def rename(snapshot):
            name = project_name(command.payload.name)
            if snapshot.project.name == name:
                return snapshot
            data = snapshot.model_dump()
            data['project'] = dict(id=snapshot.project.id, name=name, revision=snapshot.project.revision + 1)
            return ProjectSnapshot.model_validate(data)
        return self.commit(command, rename, session=session, source=source)

    @staticmethod
    def _replay(records, command):
        record = next((item for item in records if item.command.commandId == command.commandId), None)
        if record is None:
            return None
        if record.receipt.inputFingerprint != command_fingerprint(command):
            raise ProjectError('该 commandId 已用于不同输入，请使用新的命令标识。', 409, code='command_conflict')
        return record.receipt.model_copy(deep=True)

    def replay(self, command):
        """Resolve an already committed command before reading upload handles."""
        with self.local.transaction() as db:
            self._recover()
            return self._replay(self._load(db, command.projectId)[2], command)

    def _create(self, command, source):
        name = project_name(command.payload.name)
        with self.local.transaction() as db:
            self._recover()
            grouped, _, _, _ = self._scan()
            if str(command.projectId) in self._blocked:
                self._find(db, command.projectId)
            if str(command.projectId) in grouped:
                records = self._load(db, command.projectId)[2]
                replay = self._replay(records, command)
                if replay:
                    return replay
                raise ProjectError('该工程标识已经使用。', 409, code='command_conflict')
            if command.expectedVersions:
                raise ProjectError('新工程不能声明已有对象版本。')
            self.root.mkdir(exist_ok=True)
            sync_directory(self.root.parent)
            self.local._conflict(self.root, name)
            snapshot = ProjectSnapshot(project=Project(id=command.projectId, name=name), eventCursor=1)
            changed = object_changes(None, snapshot, command)
            record = self._make_record(command, None, snapshot, changed, source)
            return self._publish(CommitIntent(fromName=None, toName=name, beforeFingerprint=None, record=record))

    @property
    def delete_mode(self) -> str:
        """How a removed project leaves the disk, for the confirmation prompt."""
        return 'recycle_bin' if recycle.recyclable(self.root) else 'permanent'

    def _trash(self, command, source):
        """Commit the removal, then delete the directory.

        The directory is recycled when the platform supports it and removed
        permanently otherwise; `delete_mode` tells the client which one the user
        is agreeing to.
        """
        receipt = self.commit(command, lambda snapshot: snapshot, session=None, source=source)
        with self.local.transaction() as db:
            self._recover()
            path, _ = self._find(db, command.projectId)
            db.execute('DELETE FROM sessions WHERE project_id=?', (str(command.projectId),))
        try:
            recycle.remove(path, recoverable=self.delete_mode == 'recycle_bin')
        except OSError as error:
            raise ProjectError(str(error), 409, code='storage_unavailable') from error
        sync_directory(self.root)
        return receipt

    def commit(self, command: Command,
               apply: Callable[[ProjectSnapshot], ProjectSnapshot] | Callable[[ProjectSnapshot, tuple[CommitRecord, ...]], ProjectSnapshot], *,
               session=None, source='ui', files=(), deletes=(), with_history=False):
        if source not in {'ui', 'agent', 'background', 'external'}:
            raise ProjectError('无效的命令来源。')
        with self.local.transaction() as db:
            self._recover()
            path, manifest, records = self._load(db, command.projectId)
            replay = self._replay(records, command)
            if replay:
                return replay
            before = records[0].snapshot
            if command.type == 'project.rename':
                self._closed(db, command.projectId, before)
            elif command.type == 'project.trash':
                self._closed(db, command.projectId, before, '删除')
            elif source not in {'background', 'external'}:
                # Only trusted server entrypoints select these sources. A
                # completed job must be able to save after its window closes.
                self._lease(db, command.projectId, path, session)
            issue, changed, snapshot = None, [], before
            try:
                validate_command(command, before)
                # Revalidate the whole graph, even if an internal caller used model_copy.
                draft = ProjectSnapshot.model_validate(before.model_dump(mode='json'))
                edited = apply(draft, tuple(records)) if with_history else apply(draft)
                snapshot = ProjectSnapshot.model_validate(edited.model_dump(mode='json'))
                if snapshot.project.id != before.project.id or snapshot.eventCursor != before.eventCursor:
                    raise ContractError('invalid_input', 'Services cannot replace project identity or event cursors')
                if snapshot.project.name != before.project.name and command.type != 'project.rename':
                    raise ContractError('invalid_input', 'Only the rename command can rename a project')
                changed = object_changes(before, snapshot, command)
                if command.type == 'project.rename':
                    self.local._conflict(self.root, snapshot.project.name, path)
            except ContractError as error:
                issue = error.issue
            except ValidationError as error:
                failures = error.errors(include_input=False, include_url=False, include_context=False)
                paths = ['.'.join(str(part) for part in failure['loc']) for failure in failures]
                issue = dict(code='invalid_input', field=paths[0][:200] or None,
                             message='; '.join(f"{path}: {failure['msg']}" if path else failure['msg']
                                               for path, failure in zip(paths, failures))[:500])
            except (ValueError, ProjectError) as error:
                issue = dict(code='invalid_input', message=str(error)[:500])
            if issue is not None:
                snapshot, changed = before, []
            elif changed:
                snapshot = ProjectSnapshot.model_validate({**snapshot.model_dump(), 'eventCursor': before.eventCursor + 1})
            record = self._make_record(command, manifest.head, snapshot, changed, source, issue)
            to_name = snapshot.project.name if command.type == 'project.rename' and changed else path.name
            return self._publish(CommitIntent(fromName=path.name, toName=to_name,
                                beforeFingerprint=digest(before), record=record, files=files if changed and issue is None else (),
                                deletes=deletes if changed and issue is None else ()), validated_history=True)

    @staticmethod
    def _make_record(command, head, snapshot, changed, source, issue=None):
        job_ids = tuple(item['version'].id for item in changed if item['version'].objectType == 'job' and item['change'] == 'created'
                        and next(job for job in snapshot.jobs if job.id == item['version'].id).status == 'queued')
        event = ProjectEvent(projectId=command.projectId, cursor=snapshot.eventCursor, commandId=command.commandId,
                             source=source, changed=changed, jobIds=job_ids) if changed else None
        receipt = CommandReceipt(commandId=command.commandId, projectId=command.projectId,
            inputFingerprint=command_fingerprint(command), status='rejected' if issue else 'accepted' if job_ids else 'applied' if changed else 'noop',
            changed=[item['version'] for item in changed], jobIds=job_ids, issues=[issue] if issue else [], eventCursor=snapshot.eventCursor)
        return CommitRecord(command=command, previousHead=head, snapshot=snapshot, receipt=receipt, event=event)

    def _journal(self, project_id):
        return child(directory(self.intents), f'{project_id}.json')

    def _temporary(self, intent):
        # Compact UUIDs retain both identities while keeping Windows staging
        # paths short enough for the longer application name.
        return child(self.root, f'.opendirector-creation-{intent.record.command.projectId.hex}-{intent.record.command.commandId.hex}')

    def _publish(self, intent, *, validated_history=False):
        self.intents.mkdir(exist_ok=True)
        sync_directory(self.state_dir)
        temporary = self._temporary(intent)
        if temporary.exists():
            raise ProjectError('提交临时目录已被占用，原目录未修改。', 409, code='storage_unavailable')
        journal = self._journal(intent.record.command.projectId)
        if journal.exists():
            raise ProjectError('工程已有待恢复的提交。', 409, code='storage_unavailable')
        durable_json(journal, intent.model_dump(mode='json'))
        self._checkpoint('journaled')
        self._finish(intent, validated_history=validated_history)
        return intent.record.receipt

    def _location(self, intent):
        target = child(self.root, intent.toName)
        temporary = self._temporary(intent)
        candidates = [temporary, target]
        if intent.fromName:
            candidates.append(child(self.root, intent.fromName))
        # Path.exists also accepts aliases on case-insensitive filesystems.
        existing_names = {entry.name for entry in self.root.iterdir()}
        locations = []
        for path in candidates:
            if path.name not in existing_names or not path.exists():
                continue
            directory(path)
            if any(path.samefile(other) for other in locations):
                continue
            manifest_path = child(path, 'project.json')
            if manifest_path.exists():
                manifest = self._manifest(path)
                if manifest.id == intent.record.command.projectId and manifest.head in {intent.record.previousHead, intent.record.command.commandId}:
                    locations.append(path)
            elif path == temporary and intent.fromName is None:
                # A new directory can be interrupted before its first file is
                # installed. The durable intent owns only this reserved name.
                if any(item.name not in {'commits'} and not item.name.startswith('.opendirector-') for item in path.iterdir()):
                    raise ProjectError('工程临时目录包含未知文件，已保留待检查。', 409)
                locations.append(path)
        if not locations and intent.fromName is None and not target.exists():
            temporary.mkdir()
            sync_directory(self.root)
            return temporary
        if len(locations) != 1:
            raise ProjectError('无法唯一定位待提交工程，原文件已保留。', 409, code='storage_unavailable')
        return locations[0]

    def _finish(self, intent, *, validated_history=False):
        self.local._check_root()
        path = self._location(intent)
        record = intent.record
        manifest_path = child(path, 'project.json')
        if manifest_path.exists():
            manifest = self._manifest(path)
            if manifest.head == record.previousHead:
                # Normal commits already verified ancestry under this lock.
                # Recovery still checks the full chain before publishing.
                previous = (self._record(path, manifest.head) if validated_history
                            else self._history(path, manifest)[0])
                current = previous.snapshot
                if (previous.command.commandId != manifest.head or current.project.id != manifest.id
                        or current.project.name != manifest.name or digest(current) != intent.beforeFingerprint):
                    raise ProjectError('工程在提交期间被外部修改，已阻止覆盖。', 409, code='storage_unavailable')
            elif manifest.name != record.snapshot.project.name:
                raise ProjectError('已发布清单被外部修改，已阻止覆盖。', 409, code='storage_unavailable')
        self._checkpoint('directory_ready')
        install_files(path, record.command.projectId, intent.files, self.state_dir, self._checkpoint)
        if intent.files:
            self._checkpoint('files_installed')
        commits = directory(child(path, 'commits'))
        commits.mkdir(exist_ok=True)
        sync_directory(path)
        file = child(commits, f'{record.command.commandId}.json')
        if file.exists():
            if self._record(path, record.command.commandId) != record:
                raise ProjectError('已存在不同内容的提交记录，未覆盖。', 409, code='storage_unavailable')
        else:
            durable_json(file, record.model_dump(mode='json'))
        self._checkpoint('bundle_written')
        if intent.fromName is None:
            # Install identity before exposing a newly built directory. A crash
            # immediately after the move can then locate it unambiguously.
            manifest = Manifest(id=record.command.projectId, name=record.snapshot.project.name, head=record.command.commandId)
            durable_json(child(path, 'project.json'), manifest.model_dump(mode='json'))
        target, temporary = child(self.root, intent.toName), self._temporary(intent)
        if path.name != target.name:
            self.local._conflict(self.root, target.name, path)
            if path != temporary:
                rename_path(path, temporary)
                sync_directory(self.root)
                self._checkpoint('directory_staged')
                path = temporary
            self.local._conflict(self.root, target.name, path)
            rename_path(path, target)
            sync_directory(self.root)
            path = target
        self._checkpoint('directory_moved')
        manifest = Manifest(id=record.command.projectId, name=record.snapshot.project.name, head=record.command.commandId)
        durable_json(child(path, 'project.json'), manifest.model_dump(mode='json'))
        self._checkpoint('published')
        delete_files(path, intent.deletes)
        if intent.deletes:
            self._checkpoint('files_deleted')
        self._journal(record.command.projectId).unlink()
        sync_directory(self.intents)
        self._checkpoint('finished')
        # The record just published is the new head, so the read that follows a
        # save does not need to replay and re-parse the whole chain.
        self._remember_current(path, record)
        try:
            cleanup_staging(record.command.projectId, intent.files, self.state_dir)
        except (OSError, ProjectError):
            # Publication is already durable. Retained staging can be cleaned
            # by explicit upload cancellation without resubmitting the command.
            pass

    def _recover(self):
        self._blocked, self._warnings = {}, []
        directory(self.intents)
        if not self.intents.exists():
            return
        for file in sorted(self.intents.glob('*.json')):
            try:
                project_id = identifier(file.stem)
            except ProjectError:
                self._warnings.append('发现无法识别的提交日志，文件已保留。')
                continue
            try:
                intent = CommitIntent.model_validate(read_json(child(self.intents, file.name)))
                if str(intent.record.command.projectId) != project_id:
                    raise ValueError('Journal filename differs from its project')
                self._finish(intent)
            except (OSError, ValueError, TypeError, KeyError, ProjectError):
                self._blocked[project_id] = True
                self._warnings.append(f'工程 {project_id} 的提交需要恢复，相关文件已保留。')
