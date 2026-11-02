"""Stable file identities and frozen content references, without browser URLs."""
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .base import Contract, Fingerprint, MediaKind, NonNegative, Positive, PositiveInt, ProjectEntity, Revision
from .models import ModelSnapshot


class AssetRef(Contract):
    assetId: UUID
    revision: Revision
    fingerprint: Fingerprint
    kind: MediaKind


class MediaMetadata(Contract):
    mimeType: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, strict=True)
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    durationSeconds: Positive | None = None
    frameRate: Positive | None = None
    hasAudio: bool | None = None
    sampleRate: PositiveInt | None = None
    channels: PositiveInt | None = None

    @model_validator(mode='after')
    def dimensions(self):
        if (self.width is None) != (self.height is None):
            raise ValueError('Media dimensions must be supplied together')
        return self


class UploadInfo(Contract):
    id: UUID
    projectId: UUID
    name: str
    status: Literal['uploading', 'ready', 'registered', 'cancelled']
    kind: MediaKind | None = None
    fingerprint: Fingerprint | None = None
    metadata: MediaMetadata | None = None
    assetId: UUID | None = None

    @model_validator(mode='after')
    def complete(self):
        if self.status in {'ready', 'registered'} and (self.kind is None or self.fingerprint is None or self.metadata is None):
            raise ValueError('Completed uploads require verified media facts')
        if (self.status == 'registered') != (self.assetId is not None):
            raise ValueError('Registered uploads identify their committed asset')
        return self


class AssetProvenance(Contract):
    source: Literal['upload', 'manual', 'agent_written', 'generated', 'edited', 'rendered']
    jobId: UUID | None = None
    toolTaskId: UUID | None = None
    sourceItemId: UUID | None = None
    editorDocumentId: UUID | None = None
    editorRevision: Revision | None = None
    sources: tuple[AssetRef, ...] = ()
    inputFingerprint: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')
    agentRunId: UUID | None = None
    agentRuntime: Literal['opencode', 'codex', 'claude'] | None = None
    modelSnapshot: ModelSnapshot | None = None
    prompt: str | None = Field(default=None, max_length=20000)

    @model_validator(mode='after')
    def evidence(self):
        if self.source == 'generated' and (self.jobId is None or self.inputFingerprint is None):
            raise ValueError('Generated assets require job and input identity')
        if self.source == 'agent_written' and (self.agentRunId is None or
                not ((self.modelSnapshot is not None and self.modelSnapshot.kind == 'agent') or self.agentRuntime is not None)):
            raise ValueError('Agent-written documents require a run and an agent model or native runtime')
        if self.source in {'edited', 'rendered'} and (self.editorDocumentId is None or self.editorRevision is None):
            raise ValueError('Edited outputs require their source document version')
        if (self.editorDocumentId is None) != (self.editorRevision is None):
            raise ValueError('Editor identity and version must be supplied together')
        return self


class Asset(ProjectEntity):
    kind: MediaKind
    name: str = Field(min_length=1, max_length=255)
    fingerprint: Fingerprint
    path: str
    metadata: MediaMetadata
    provenance: AssetProvenance

    @model_validator(mode='after')
    def content_identity(self):
        if self.path != f'assets/{self.id}':
            raise ValueError('Asset path must use its stable project-relative ID')
        if any(source.assetId == self.id for source in self.provenance.sources):
            raise ValueError('An asset cannot be its own source')
        return self
