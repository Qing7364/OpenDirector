"""Shared HTTP/Agent command and query schemas. No operation is executed here."""
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import Field, TypeAdapter, create_model, model_validator

from .assets import AssetRef, MediaMetadata
from .base import Contract, Digest, GenerationKind, MediaKind, ObjectVersion, Point, Positive, Revision, digest, unique
from .canvas import CanvasItem
from .editors import EditorDocument
from .generation import GenerationSpec, Job, PromptPart, Reference


class ProjectCreate(Contract):
    name: str = Field(min_length=1, max_length=100, pattern=r'\S')


class ProjectRename(ProjectCreate):
    pass


class AssetImport(Contract):
    uploadHandle: UUID  # File bytes are transferred separately; no arbitrary path.
    name: str = Field(min_length=1, max_length=255)
    expectedKind: MediaKind


class ArtifactPublish(Contract):
    """Publish a file from a server-owned execution context without generating media."""
    path: str = Field(min_length=1, max_length=4096)
    name: str = Field(min_length=1, max_length=255)
    expectedKind: MediaKind | None = None
    sources: tuple[AssetRef, ...] = Field(default=(), max_length=100)


class AssetWriteText(Contract):
    name: str = Field(min_length=1, max_length=255)
    text: str = Field(max_length=1024 * 1024)
    previousAsset: AssetRef | None = None
    # Manual/Agent provenance is supplied by the trusted application context.


class AssetMetadataUpdate(Contract):
    assetId: UUID
    name: str = Field(min_length=1, max_length=255)


class AssetDelete(Contract):
    assetIds: tuple[UUID, ...] = Field(min_length=1, max_length=100)
    clearHistory: bool = False

    @model_validator(mode='after')
    def assets(self):
        unique(self.assetIds, 'delete asset IDs')
        return self


class CanvasShow(Contract):
    item: CanvasItem


class CanvasMoveItem(Contract):
    itemId: UUID
    position: Point


class CanvasMove(Contract):
    items: tuple[CanvasMoveItem, ...] = Field(min_length=1, max_length=500)

    @model_validator(mode='after')
    def items_unique(self):
        unique([item.itemId for item in self.items], 'moved canvas IDs')
        return self


class CanvasPresentationUpdate(Contract):
    itemId: UUID
    title: str | None = Field(default=None, max_length=255)
    width: Positive | None = None
    height: Positive | None = None
    zIndex: int | None = Field(default=None, strict=True)
    locked: bool | None = None
    parentId: UUID | None = None
    # Presence of parentId distinguishes retaining a group from ungrouping.


class CanvasHide(Contract):
    itemId: UUID


class CanvasMaterialize(Contract):
    itemId: UUID
    asset: AssetRef
    discardGenerationDraft: bool = False


class CanvasApplyEdit(Contract):
    itemId: UUID
    source: AssetRef
    asset: AssetRef
    editorId: UUID


class TimelinePublishRender(Contract):
    itemId: UUID
    editorId: UUID
    asset: AssetRef
    outputId: UUID
    title: str = Field(default='合成视频', max_length=255)
    position: Point = Field(default_factory=Point)


class MediaPublicationOutput(Contract):
    itemId: UUID
    asset: AssetRef
    title: str = Field(min_length=1, max_length=255)
    position: Point = Field(default_factory=Point)
    width: float = Field(default=352, gt=0, le=10000)
    height: float = Field(default=198, gt=0, le=10000)


class CanvasPublishMedia(Contract):
    itemId: UUID
    source: AssetRef | None = None
    sourceEditorId: UUID | None = None
    document: EditorDocument
    outputs: tuple[MediaPublicationOutput, ...] = Field(min_length=1, max_length=50)

    @model_validator(mode='after')
    def distinct_outputs(self):
        unique([output.itemId for output in self.outputs], 'output item IDs')
        unique([output.asset.assetId for output in self.outputs], 'output asset IDs')
        if self.document.kind not in {'media_edit', 'director'}:
            raise ValueError('Local publication requires a media edit or director snapshot')
        return self


class CanvasConfigure(Contract):
    itemId: UUID
    specId: UUID
    # Explicit conversion keeps the immutable handwritten asset in the catalog.
    preserveMaterial: bool = False


class CanvasEditorAttach(Contract):
    itemId: UUID
    editorId: UUID


class SpecRestore(Contract):
    specId: UUID
    commandId: UUID
    referencePolicy: Literal['follow_current', 'pinned'] = 'follow_current'


class NodeVersionApply(Contract):
    itemId: UUID
    asset: AssetRef
    referencePolicy: Literal['follow_current', 'pinned'] = 'follow_current'


class SpecPromptWrite(Contract):
    specId: UUID
    prompt: str = Field(max_length=20000)
    promptContent: tuple[PromptPart, ...] | None = None


class SpecWrite(Contract):
    spec: GenerationSpec


class ReferenceWrite(Contract):
    reference: Reference


class ReferenceRemove(Contract):
    referenceId: UUID


class GenerationSubmit(Contract):
    specId: UUID
    expectedSpecRevision: Revision
    originItemId: UUID | None = None
    previousJobId: UUID | None = None
    adoptionPolicy: Literal['if_current', 'candidate_only'] = 'if_current'
    batchId: UUID | None = None
    showAdditionalResult: bool = False

    @model_validator(mode='after')
    def presentation(self):
        if self.showAdditionalResult and (self.originItemId is None or self.adoptionPolicy != 'candidate_only'):
            raise ValueError('Additional result display requires an origin and candidate-only adoption')
        return self


class JobControl(Contract):
    jobId: UUID


class JobCheckpoint(Contract):
    job: Job


class ResultSelect(Contract):
    specId: UUID
    resultId: UUID


class EditorWrite(Contract):
    document: EditorDocument


class HistoryReplay(Contract):
    targetCommandId: UUID


class EmptyPayload(Contract):
    pass


class CommandBase(Contract):
    commandId: UUID
    projectId: UUID
    type: str
    expectedVersions: tuple[ObjectVersion, ...] = ()
    expectedPreview: Digest | None = None

    @model_validator(mode='after')
    def scope_and_versions(self):
        unique([(version.objectType, version.id) for version in self.expectedVersions], 'expected object versions')
        payload = self.payload
        owned = getattr(payload, 'item', None) or getattr(payload, 'spec', None) or getattr(payload, 'reference', None) or getattr(payload, 'document', None)
        if owned and owned.projectId != self.projectId:
            raise ValueError('Command payload belongs to a different project')
        required = []
        if self.type in {'project.rename', 'project.trash', 'project.restore'}:
            required = [('project', self.projectId)]
        elif self.type == 'canvas.publishMedia':
            required = [('canvas_item', payload.itemId), *[('asset', o.asset.assetId) for o in payload.outputs]]
            if payload.sourceEditorId:
                required.append(('editor_document', payload.sourceEditorId))
        elif self.type in {'canvas.applyEdit', 'timeline.publishRender'}:
            required = [('canvas_item', payload.itemId), ('asset', payload.asset.assetId), ('editor_document', payload.editorId)]
        elif self.type in {'canvas.update', 'canvas.hide', 'canvas.materialize', 'canvas.applyEdit', 'canvas.configure', 'canvas.attachEditor', 'canvas.detachEditor', 'canvas.applyVersion'}:
            required = [('canvas_item', payload.itemId)]
        elif self.type == 'canvas.move':
            required = [('canvas_item', item.itemId) for item in payload.items]
        elif self.type == 'asset.updateMetadata':
            required = [('asset', payload.assetId)]
        elif self.type == 'asset.writeText' and payload.previousAsset:
            required = [('asset', payload.previousAsset.assetId)]
        elif self.type == 'asset.delete':
            required = [('asset', asset_id) for asset_id in payload.assetIds]
            if self.expectedPreview is None:
                raise ValueError('Asset deletion requires an impact preview fingerprint')
        elif self.type == 'generationSpec.update':
            required = [('generation_spec', payload.spec.id)]
        elif self.type in {'reference.update', 'reference.restore', 'reference.remove'}:
            required = [('reference', payload.referenceId if self.type == 'reference.remove' else payload.reference.id)]
        elif self.type == 'reference.add':
            required = [('generation_spec', payload.reference.targetSpecId)]
        elif self.type == 'generation.submit':
            required = [('generation_spec', payload.specId)]
        elif self.type == 'result.select':
            required = [('generation_spec', payload.specId)]
        elif self.type == 'editor.save':
            required = [('editor_document', payload.document.id)]
        versions = {(version.objectType, version.id): version.revision for version in self.expectedVersions}
        if any(key not in versions for key in required):
            raise ValueError('Mutation requires the current versions of all target objects')
        if self.type == 'generation.submit' and versions[('generation_spec', payload.specId)] != payload.expectedSpecRevision:
            raise ValueError('Submission version differs from expected spec version')
        if self.type in {'generationSpec.update', 'editor.save', 'reference.update', 'reference.restore'}:
            obj = (payload.spec if self.type == 'generationSpec.update' else
                   payload.document if self.type == 'editor.save' else payload.reference)
            if versions[required[0]] != obj.revision:
                raise ValueError('Payload version differs from its expected version')
        return self


# HTTP/application contracts; Agent tool registration is a separate boundary.
_COMMANDS = (
    ('ProjectCreateCommand', 'project.create', ProjectCreate),
    ('ProjectRenameCommand', 'project.rename', ProjectRename),
    ('ProjectTrashCommand', 'project.trash', EmptyPayload),
    ('ProjectRestoreCommand', 'project.restore', EmptyPayload),
    ('AssetImportCommand', 'asset.import', AssetImport),
    ('ArtifactPublishCommand', 'artifact.publish', ArtifactPublish),
    ('AssetWriteTextCommand', 'asset.writeText', AssetWriteText),
    ('AssetMetadataCommand', 'asset.updateMetadata', AssetMetadataUpdate),
    ('AssetDeleteCommand', 'asset.delete', AssetDelete),
    ('CanvasShowCommand', 'canvas.show', CanvasShow),
    ('CanvasMoveCommand', 'canvas.move', CanvasMove),
    ('CanvasUpdateCommand', 'canvas.update', CanvasPresentationUpdate),
    ('CanvasHideCommand', 'canvas.hide', CanvasHide),
    ('CanvasMaterializeCommand', 'canvas.materialize', CanvasMaterialize),
    ('CanvasApplyEditCommand', 'canvas.applyEdit', CanvasApplyEdit),
    ('CanvasPublishMediaCommand', 'canvas.publishMedia', CanvasPublishMedia),
    ('TimelinePublishRenderCommand', 'timeline.publishRender', TimelinePublishRender),
    ('NodeVersionApplyCommand', 'canvas.applyVersion', NodeVersionApply),
    ('CanvasConfigureCommand', 'canvas.configure', CanvasConfigure),
    ('CanvasEditorAttachCommand', 'canvas.attachEditor', CanvasEditorAttach),
    ('CanvasEditorDetachCommand', 'canvas.detachEditor', CanvasEditorAttach),
    ('SpecCreateCommand', 'generationSpec.create', SpecWrite),
    ('SpecUpdateCommand', 'generationSpec.update', SpecWrite),
    ('SpecRestoreCommand', 'generationSpec.restore', SpecRestore),
    ('SpecPromptCommand', 'generationSpec.setPrompt', SpecPromptWrite),
    ('ReferenceAddCommand', 'reference.add', ReferenceWrite),
    ('ReferenceUpdateCommand', 'reference.update', ReferenceWrite),
    ('ReferenceRestoreCommand', 'reference.restore', ReferenceWrite),
    ('ReferenceRemoveCommand', 'reference.remove', ReferenceRemove),
    ('GenerationSubmitCommand', 'generation.submit', GenerationSubmit),
    ('JobCancelCommand', 'job.cancel', JobControl),
    ('JobRecoverCommand', 'job.recover', JobControl),
    ('JobCheckpointCommand', 'job.checkpoint', JobCheckpoint),
    ('ResultSelectCommand', 'result.select', ResultSelect),
    ('EditorCreateCommand', 'editor.create', EditorWrite),
    ('EditorSaveCommand', 'editor.save', EditorWrite),
    ('HistoryUndoCommand', 'history.undo', HistoryReplay),
    ('HistoryRedoCommand', 'history.redo', HistoryReplay),
)
COMMAND_MODELS = {}
for _name, _type, _payload in _COMMANDS:
    _model = create_model(_name, __base__=CommandBase, type=(Literal[_type], ...), payload=(_payload, ...))
    COMMAND_MODELS[_type] = _model
    globals()[_name] = _model

_BATCH_TYPES = {'canvas.show', 'canvas.move', 'canvas.update', 'canvas.hide', 'canvas.materialize', 'canvas.applyEdit',
                'canvas.configure', 'canvas.attachEditor', 'canvas.detachEditor', 'generationSpec.create', 'generationSpec.update',
                'reference.add', 'reference.update', 'reference.restore', 'reference.remove', 'editor.create', 'editor.save', 'result.select', 'generationSpec.setPrompt'}
_OPERATIONS = tuple(create_model(name + 'Operation', __base__=Contract,
                    type=(Literal[kind], ...), payload=(payload, ...))
                    for name, kind, payload in _COMMANDS if kind in _BATCH_TYPES)
Operation = Annotated[Union[_OPERATIONS], Field(discriminator='type')]


class BatchPayload(Contract):
    operations: tuple[Operation, ...] = Field(min_length=1, max_length=500)


BatchCommand = create_model('BatchCommand', __base__=CommandBase,
                            type=(Literal['creation.batch'], ...), payload=(BatchPayload, ...))
COMMAND_MODELS['creation.batch'] = BatchCommand
Command = Annotated[Union[tuple(COMMAND_MODELS.values())], Field(discriminator='type')]
COMMAND_ADAPTER = TypeAdapter(Command)


def parse_command(value) -> Command:
    """The same input validator can be used by HTTP and Agent adapters."""
    return COMMAND_ADAPTER.validate_python(value)


def command_fingerprint(command: Command) -> str:
    return digest(command)


class ContractIssue(Contract):
    code: Literal['invalid_input', 'revision_conflict', 'role_restricted', 'missing_object', 'reference_invalid',
                  'capability_unsupported', 'preview_expired', 'storage_unavailable', 'submission_unknown', 'provider_error']
    message: str = Field(min_length=1, max_length=500)
    objectId: UUID | None = None
    field: str | None = Field(default=None, max_length=200)


class CommandReceipt(Contract):
    commandId: UUID
    projectId: UUID
    inputFingerprint: Digest
    status: Literal['applied', 'accepted', 'noop', 'rejected']
    changed: tuple[ObjectVersion, ...] = ()
    jobIds: tuple[UUID, ...] = ()
    issues: tuple[ContractIssue, ...] = ()
    eventCursor: int | None = Field(default=None, strict=True, ge=0)

    @model_validator(mode='after')
    def outcome(self):
        unique(self.jobIds, 'receipt job IDs')
        if self.status == 'rejected' and (self.changed or self.jobIds or not self.issues):
            raise ValueError('Rejected commands need issues and cannot claim changes')
        if self.status == 'accepted' and not self.jobIds:
            raise ValueError('Accepted background work needs a task receipt')
        if self.status == 'noop' and (self.changed or self.jobIds):
            raise ValueError('A noop cannot create objects or tasks')
        return self


class Query(Contract):
    queryId: UUID
    projectId: UUID
    type: Literal['project.get', 'object.get', 'asset.search', 'asset.usage', 'generationSpec.versions', 'canvas.versions', 'job.get']
    objectId: UUID | None = None
    revision: Revision | None = None
    text: str = Field(default='', max_length=1000)
    offset: int = Field(default=0, strict=True, ge=0)
    limit: int = Field(default=50, strict=True, ge=1, le=200)

    @model_validator(mode='after')
    def target(self):
        if self.type in {'object.get', 'generationSpec.versions', 'canvas.versions', 'job.get'} and self.objectId is None:
            raise ValueError('Object query needs a stable object ID')
        return self


class ChangedObject(Contract):
    version: ObjectVersion
    change: Literal['created', 'updated', 'hidden', 'deleted']


class ProjectEvent(Contract):
    schemaVersion: Literal[1] = 1
    projectId: UUID
    cursor: int = Field(strict=True, ge=1)
    commandId: UUID | None = None
    source: Literal['ui', 'agent', 'background', 'external']
    changed: tuple[ChangedObject, ...] = ()
    jobIds: tuple[UUID, ...] = ()
