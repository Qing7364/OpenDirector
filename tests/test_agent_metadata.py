"""CI gate for discoverable tool and command descriptions."""
import json
from uuid import uuid4

from pydantic import Field, JsonValue, create_model
import pytest

from opendirector.agent.tools import AgentTools, COMMANDS, tool_schema, tools
from opendirector.domain.creation.base import Contract
from opendirector.domain.creation.commands import COMMAND_MODELS
from opendirector.domain.creation.schema import CreationContracts
from opendirector.infrastructure.model_configs import ModelConfigs


def test_all_registered_commands_have_explicit_metadata():
    for name, model in COMMAND_MODELS.items():
        description = model.__dict__.get('__doc__')
        assert description and description.strip(), name
        assert model.model_json_schema()['description'] == description, name
    assert set(COMMANDS) <= set(COMMAND_MODELS)


def test_all_exposed_tools_have_metadata():
    for tool in tools():
        function = tool['function']
        assert function['description'].strip(), function['name']


@pytest.mark.parametrize('description', ['', ' \n\t'])
def test_tool_registration_rejects_empty_metadata(description):
    with pytest.raises(AssertionError, match='Missing tool metadata: example'):
        tool_schema('example', description, {'type': 'object'})


def test_contract_class_rejects_an_undocumented_field():
    with pytest.raises(TypeError, match='Missing field metadata: Undocumented.value'):
        class Undocumented(Contract):
            value: str


@pytest.mark.parametrize('description', [None, '', ' \n\t'])
def test_contract_definition_rejects_missing_field_metadata(description):
    with pytest.raises(TypeError, match='Missing field metadata: Undocumented.value'):
        create_model('Undocumented', __base__=Contract,
            value=(str, Field(description=description)))


def test_contract_metadata_survives_inheritance_and_rejects_undocumented_overrides():
    parent = create_model('Documented', __base__=Contract,
        value=(int, Field(default=1, description='Current value.')))
    child = create_model('Inherited', __base__=parent)
    assert child.model_json_schema()['properties']['value']['description'] == 'Current value.'
    assert child().model_dump() == {'value': 1}
    with pytest.raises(TypeError, match='Missing field metadata: Override.value'):
        create_model('Override', __base__=parent, value=(int, 2))


def test_exported_contract_fields_have_metadata():
    for mode in ('validation', 'serialization'):
        schema = CreationContracts.model_json_schema(mode=mode)
        for name, definition in {'CreationContracts': schema, **schema['$defs']}.items():
            for field, value in definition.get('properties', {}).items():
                assert value.get('description', '').strip(), f'{name}.{field}'


@pytest.mark.anyio
async def test_model_schema_exposes_supported_video_inputs_without_changing_contract(tmp_path):
    configs = ModelConfigs(tmp_path)
    config = configs.save('video', 'http://fixture.invalid/v1', 'FastVideo-FastH3-Omni-8-Step-V1', '',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='none', video_adapter='fasth3')
    business = AgentTools(None, None, configs)
    async def schema(arguments):
        return await business.execute(uuid4(), uuid4(), '', 'schema', 'command_schema', arguments, [], None)
    full = await schema({'type': 'canvas.createGeneration'})
    compact = await schema({'type': 'canvas.createGeneration', 'modelConfigId': config['id']})
    assert len(json.dumps(compact)) < len(json.dumps(full)) * .65
    defs = compact['$defs']
    assert 'ImageCanvasItem' not in defs and 'AudioGenerationSpec' not in defs
    fields = defs['VideoParameters']['properties']
    assert fields['videoMode']['enum'] == ['reference']
    assert 'default' not in fields['videoMode']
    assert 'videoMode' in defs['VideoParameters']['required']
    assert 'parameters' in defs['VideoGenerationSpec']['required']
    assert fields['generateAudio']['enum'] == [True]
    assert 'PinnedReference' in defs and 'FollowingReference' in defs
    assert full['$defs']['VideoParameters']['properties']['videoMode']['default'] == 'first_frame'
    assert COMMANDS['canvas.createGeneration'].model_json_schema()['$defs']['VideoParameters'] == full['$defs']['VideoParameters']


@pytest.mark.anyio
async def test_command_schemas_keep_every_reference_resolvable():
    business = AgentTools(None, None, None)
    for kind in COMMANDS:
        schema = await business.execute(uuid4(), uuid4(), '', kind, 'command_schema', {'type': kind}, [], None)
        def check(value: JsonValue) -> None:
            if isinstance(value, dict):
                if '$ref' in value:
                    assert value['$ref'].rsplit('/', 1)[1] in schema['$defs'], kind
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(schema)
