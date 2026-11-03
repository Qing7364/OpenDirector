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
    ('ProjectCreateCommand', 'project.create', ProjectCreate, 'Create a project.'),
    ('ProjectRenameCommand', 'project.rename', ProjectRename, 'Rename the project.'),
    ('ProjectTrashCommand', 'project.trash', EmptyPayload, 'Move the project to trash.'),
    ('ProjectRestoreCommand', 'project.restore', EmptyPayload, 'Restore a trashed project.'),
    ('AssetImportCommand', 'asset.import', AssetImport, 'Register an uploaded file as a project asset.'),
    ('ArtifactPublishCommand', 'artifact.publish', ArtifactPublish, 'Register an execution file as a project asset.'),
    ('AssetWriteTextCommand', 'asset.writeText', AssetWriteText, 'Write a text asset or a new version of an existing text asset.'),
    ('AssetMetadataCommand', 'asset.updateMetadata', AssetMetadataUpdate, 'Rename an asset.'),
    ('AssetDeleteCommand', 'asset.delete', AssetDelete, 'Delete assets after an impact preview.'),
    ('CanvasShowCommand', 'canvas.show', CanvasShow, 'Create or restore a canvas display item.'),
    ('CanvasMoveCommand', 'canvas.move', CanvasMove, 'Move one or more canvas items.'),
    ('CanvasUpdateCommand', 'canvas.update', CanvasPresentationUpdate, 'Update canvas presentation, grouping or lock state.'),
    ('CanvasHideCommand', 'canvas.hide', CanvasHide, 'Remove a canvas item; preserves project contents. Remove all visible items to clear the canvas.'),
    ('CanvasMaterializeCommand', 'canvas.materialize', CanvasMaterialize, 'Bind an asset to an empty or material canvas item.'),
    ('CanvasApplyEditCommand', 'canvas.applyEdit', CanvasApplyEdit, 'Apply an editor result to a canvas item.'),
    ('CanvasPublishMediaCommand', 'canvas.publishMedia', CanvasPublishMedia, 'Publish edited media outputs with their editor snapshot.'),
    ('TimelinePublishRenderCommand', 'timeline.publishRender', TimelinePublishRender, 'Publish a rendered timeline result.'),
    ('NodeVersionApplyCommand', 'canvas.applyVersion', NodeVersionApply, 'Apply a historical asset version and its reference policy to a canvas item.'),
    ('CanvasConfigureCommand', 'canvas.configure', CanvasConfigure, 'Bind a generation configuration to a canvas item.'),
    ('CanvasEditorAttachCommand', 'canvas.attachEditor', CanvasEditorAttach, 'Attach an editor document to a canvas item.'),
    ('CanvasEditorDetachCommand', 'canvas.detachEditor', CanvasEditorAttach, 'Detach an editor document from a canvas item.'),
    ('SpecCreateCommand', 'generationSpec.create', SpecWrite, 'Create a generation configuration without submitting a job.'),
    ('SpecUpdateCommand', 'generationSpec.update', SpecWrite, 'Update a generation configuration without changing accepted jobs.'),
    ('SpecRestoreCommand', 'generationSpec.restore', SpecRestore, 'Restore generation settings from a historical command.'),
    ('SpecPromptCommand', 'generationSpec.setPrompt', SpecPromptWrite, 'Update prompt text and structured references.'),
    ('ReferenceAddCommand', 'reference.add', ReferenceWrite, 'Add a generation reference.'),
    ('ReferenceUpdateCommand', 'reference.update', ReferenceWrite, 'Update a generation reference.'),
    ('ReferenceRestoreCommand', 'reference.restore', ReferenceWrite, 'Restore a generation reference.'),
    ('ReferenceRemoveCommand', 'reference.remove', ReferenceRemove, 'Deactivate a generation reference.'),
    ('GenerationSubmitCommand', 'generation.submit', GenerationSubmit, 'Submit a generation job with fixed inputs and an adoption policy.'),
    ('JobCancelCommand', 'job.cancel', JobControl, 'Request cancellation of an existing job.'),
    ('JobRecoverCommand', 'job.recover', JobControl, 'Recover an existing job without creating a new attempt.'),
    ('JobCheckpointCommand', 'job.checkpoint', JobCheckpoint, 'Persist a job execution checkpoint.'),
    ('ResultSelectCommand', 'result.select', ResultSelect, 'Adopt an existing generation result.'),
    ('EditorCreateCommand', 'editor.create', EditorWrite, 'Create an editable document.'),
    ('EditorSaveCommand', 'editor.save', EditorWrite, 'Save an editable document.'),
    ('HistoryUndoCommand', 'history.undo', HistoryReplay, 'Undo a recorded reversible command.'),
    ('HistoryRedoCommand', 'history.redo', HistoryReplay, 'Reapply an undone command.'),
)
COMMAND_MODELS = {}
for _name, _type, _payload, _description in _COMMANDS:
    _model = create_model(_name, __base__=CommandBase, __doc__=_description, type=(Literal[_type], ...), payload=(_payload, ...))
    COMMAND_MODELS[_type] = _model
    globals()[_name] = _model

_BATCH_TYPES = {'canvas.show', 'canvas.move', 'canvas.update', 'canvas.hide', 'canvas.materialize', 'canvas.applyEdit',
                'canvas.configure', 'canvas.attachEditor', 'canvas.detachEditor', 'generationSpec.create', 'generationSpec.update',
                'reference.add', 'reference.update', 'reference.restore', 'reference.remove', 'editor.create', 'editor.save', 'result.select', 'generationSpec.setPrompt'}
_OPERATIONS = tuple(create_model(name + 'Operation', __base__=Contract,
                    __doc__=description, type=(Literal[kind], ...), payload=(payload, ...))
                    for name, kind, payload, description in _COMMANDS if kind in _BATCH_TYPES)
Operation = Annotated[Union[_OPERATIONS], Field(discriminator='type')]


class BatchPayload(Contract):
    operations: tuple[Operation, ...] = Field(min_length=1, max_length=500)


BatchCommand = create_model('BatchCommand', __base__=CommandBase,
                            __doc__='Apply multiple operations atomically; all succeed or none are committed.',
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
