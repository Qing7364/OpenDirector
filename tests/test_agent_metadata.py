"""CI gate for discoverable tool and command descriptions."""
import pytest

from opendirector.agent.tools import COMMANDS, tool_schema, tools
from opendirector.domain.creation.commands import COMMAND_MODELS


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
