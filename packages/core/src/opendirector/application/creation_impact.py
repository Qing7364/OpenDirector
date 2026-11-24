"""Read current business bindings and adopted execution evidence without mutations."""
from collections.abc import Mapping
from uuid import UUID

from opendirector.domain.creation.generation import ResolvedReference
from opendirector.domain.creation.impact import ImpactDependency
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError

MAX_IMPACT_EDGES = 20000


def build_generation_dependencies(
    snapshot: ProjectSnapshot,
    resolved_by_spec: Mapping[UUID, tuple[ResolvedReference, ...] | None],
) -> tuple[ImpactDependency, ...]:
    """Only current follow bindings propagate; content identity is not source identity."""
    items = {item.id: item for item in snapshot.canvasItems}
    resolved = {spec_id: None if values is None else _by_reference(values)
                for spec_id, values in resolved_by_spec.items()}
    edges = []
    for reference in snapshot.references:
        if not reference.active or reference.binding != 'follow_current':
            continue
        source = items.get(reference.source.id)
        source_spec = (source.binding.objectRef.id if source is not None
            and source.binding.role == 'generation' and source.binding.materialOverride is None else None)
        by_ref = resolved.get(reference.targetSpecId)
        values = by_ref.get(reference.id) if by_ref is not None else None
        # A missing resolution is explicit uncertainty, never "no dependencies".
        for value in values or (None,):
            if value is not None and value.transmission == 'context_only':
                continue
            edges.append(ImpactDependency(sourceSpecId=source_spec, sourceItemId=reference.source.id,
                targetSpecId=reference.targetSpecId, referenceId=reference.id,
                role=value.role if value else reference.role, assetId=value.asset.assetId if value else None,
                documentId=value.documentVersion.id if value and value.documentVersion else None,
                inputConfirmed=value is not None))
            if len(edges) > MAX_IMPACT_EDGES:
                raise ContractError('impact_scope_exceeded', '依赖分析超出节点或参考数量上限。')
    return tuple(edges)


def _by_reference(values):
    grouped = {}
    for value in values:
        grouped.setdefault(value.referenceId, []).append(value)
    return grouped
