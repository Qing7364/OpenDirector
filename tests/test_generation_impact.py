"""Impact reports follow saved business bindings, never display or historical guesses."""
from uuid import UUID

import pytest
from pydantic import TypeAdapter, ValidationError

from opendirector.application.creation_canvas import current_generation_inputs
from opendirector.application.creation_impact import build_generation_dependencies
from opendirector.domain.creation.commands import Query
from opendirector.domain.creation.generation import InputSnapshot, Job, ResultVersion
from opendirector.domain.creation.models import ModelSnapshot
from opendirector.domain.creation.project import ProjectSnapshot
from test_creation_contracts import asset, asset_ref, entity, model, PROJECT, uid

pytestmark = pytest.mark.cpu


def impact_model():
    public = model()
    return ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
        **{key: getattr(public, key) for key in
           ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'proxyMode', 'videoAdapter')})


def graph():
    """Four adopted image specs: A -> B -> C, with independent D."""
    data = dict(project=dict(id=PROJECT, name='Impact'), generationSpecs=[
        entity(100+i, kind='image', purpose='generation', modelConfigId=uid(20), prompt=f'Shot {i}')
        for i in range(4)], canvasItems=[
        entity(200+i, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(100+i))))
        for i in range(4)], assets=[], jobs=[], results=[], references=[])
    for i in range(4):
        if i in (1, 2):
            data['references'].append(entity(600+i, binding='follow_current',
                targetSpecId=uid(100+i), source=dict(id=uid(199+i))))
        state = ProjectSnapshot.model_validate(data)
        spec, refs = current_generation_inputs(state, state.generationSpecs[i], impact_model().inputRules)
        frozen = InputSnapshot(spec=spec, model=impact_model(), references=refs)
        output = asset(300+i, 'image')
        job = Job(**entity(400+i, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(),
            execution=dict(kind='image', size='2K'), status='succeeded', recovery='done',
            phase='complete', asset=asset_ref(output)))
        result = ResultVersion(**entity(500+i, specId=spec.id, jobId=job.id,
            asset=job.asset, inputFingerprint=job.inputFingerprint))
        data['assets'].append(output)
        data['jobs'].append(job)
        data['results'].append(result)
        data['generationSpecs'][i]['currentResultId'] = result.id
    return ProjectSnapshot.model_validate(data)


def resolved(state):
    return {s.id: current_generation_inputs(state, s, impact_model().inputRules)[1]
            for s in state.generationSpecs}


def replace(state, collection, index, **updates):
    data = state.model_dump()
    data[collection] = list(data[collection])
    data[collection][index].update(updates)
    return ProjectSnapshot.model_validate(data)


def test_dependency_edges_use_active_business_bindings():
    state = graph()
    edges = build_generation_dependencies(state, resolved(state))
    assert [(e.sourceSpecId, e.targetSpecId, e.referenceId, e.inputConfirmed) for e in edges] == [
        (uid(100), uid(101), uid(601), True), (uid(101), uid(102), uid(602), True)]
    moved = replace(state, 'canvasItems', 3, position=dict(x=-999, y=-999))
    assert build_generation_dependencies(moved, resolved(moved)) == edges
    inactive = replace(state, 'references', 1, active=False)
    assert len(build_generation_dependencies(inactive, resolved(inactive))) == 1


def test_pinned_hidden_override_and_subject_bindings():
    state = graph()
    hidden = replace(state, 'canvasItems', 1, visible=False)
    assert build_generation_dependencies(hidden, resolved(hidden)) == build_generation_dependencies(state, resolved(state))
    pinned = replace(state, 'references', 1, binding='pinned', source=asset_ref(state.assets[1]).model_dump(),
        sourceVersion=dict(objectType='canvas_item', id=uid(201), revision=1))
    assert [e.targetSpecId for e in build_generation_dependencies(pinned, resolved(pinned))] == [uid(101)]
    # An explicit override wins even when it is the same bytes as a generated result.
    data = state.model_dump()
    override = asset(310, 'image').model_copy(update={'provenance': state.assets[0].provenance.model_copy(update={'source': 'imported'})})
    data['assets'] = [*state.assets, override]
    data['canvasItems'][1]['binding']['materialOverride'] = asset_ref(override).model_dump()
    overridden = ProjectSnapshot.model_validate(data)
    edge = build_generation_dependencies(overridden, resolved(overridden))[1]
    assert edge.sourceSpecId is None and edge.assetId == override.id
    data = state.model_dump()
    data['editorDocuments'] = [entity(700, kind='subject', data=dict(main=asset_ref(state.assets[0]),
        auxiliaries=[asset_ref(state.assets[3])]))]
    data['canvasItems'] = [*state.canvasItems, entity(701, kind='subject',
        binding=dict(role='editor', objectRef=dict(id=uid(700), kind='subject')))]
    data['references'][1]['source']['id'] = uid(701)
    subject = ProjectSnapshot.model_validate(data)
    edges = [e for e in build_generation_dependencies(subject, resolved(subject)) if e.targetSpecId == uid(102)]
    assert {(e.assetId, e.sourceItemId, e.sourceSpecId) for e in edges} == {
        (uid(300), uid(701), None), (uid(303), uid(701), None)}


def test_historical_usage_does_not_create_live_dependencies():
    state = replace(graph(), 'references', 1, source=dict(id=uid(203)))
    assert state.jobs[2].inputSnapshot.references[0].sourceVersion.id == uid(201)
    edges = build_generation_dependencies(state, resolved(state))
    assert edges[1].sourceSpecId == uid(103)
    inputs = resolved(state)
    inputs[uid(102)] = None
    uncertain = build_generation_dependencies(state, inputs)[1]
    assert uncertain.sourceSpecId == uid(103) and not uncertain.inputConfirmed
    assert uncertain.assetId is None


def query(**fields):
    return TypeAdapter(Query).validate_python(dict(type='generation.impact', queryId=uid(900),
        projectId=PROJECT, rootSpecIds=[uid(101)], **fields))


def test_impact_query_is_registered_without_changing_ordinary_queries():
    parsed = query()
    assert parsed.rootSpecIds == (uid(101),) and parsed.maxNodes == 2000
    ordinary = TypeAdapter(Query).validate_python(dict(type='project.get', queryId=uid(900), projectId=PROJECT))
    assert ordinary.type == 'project.get'


def test_dependency_budget_rejects_partial_reports():
    from opendirector.domain.creation.validation import ContractError
    state = graph()
    # Construct a trusted in-memory stress fixture without a huge persisted document.
    state = state.model_copy(update={'references': tuple(
        state.references[0].model_copy(update={'id': uid(10000+i), 'order': i}) for i in range(20001))})
    with pytest.raises(ContractError) as error:
        build_generation_dependencies(state, {uid(101): None})
    assert error.value.issue.code == 'impact_scope_exceeded'


def test_report_rejects_unknown_states_and_reason_codes():
    from opendirector.domain.creation.impact import GenerationImpactItem, ImpactReason
    with pytest.raises(ValidationError):
        GenerationImpactItem(specId=uid(100), specRevision=1, inputState='equal',
            reuseState='auto_retry', relation='root')
    with pytest.raises(ValidationError):
        ImpactReason(code='auto_submit')


@pytest.mark.parametrize('updates', [
    {'rootSpecIds': []}, {'rootSpecIds': [uid(101), uid(101)]}, {'rootSpecIds': ['invalid']},
    {'rootSpecIds': [UUID(int=i+1000) for i in range(101)]},
    {'maxNodes': 0}, {'maxNodes': 10001}, {'maxNodes': True}, {'maxNodes': '5'}, {'unexpected': True},
])
def test_impact_query_rejects_unbounded_or_ambiguous_inputs(updates):
    data = dict(type='generation.impact', queryId=uid(900), projectId=PROJECT, rootSpecIds=[uid(101)])
    with pytest.raises(ValidationError):
        TypeAdapter(Query).validate_python(data | updates)
