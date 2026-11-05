"""Installed resources and writable project storage have distinct roots."""
from opendirector import installation


def test_wheel_defaults_to_user_workspace_not_package(monkeypatch, tmp_path):
    monkeypatch.delenv('OPENDIRECTOR_ROOT', raising=False)
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None)
    monkeypatch.setattr(installation.Path, 'home', lambda: tmp_path)
    assert installation.data_root() == tmp_path / '.opendirector'
    assert installation.web_root() == installation.BUNDLED / 'web'
    assert installation.builtin_skills() == installation.BUNDLED / 'skills'


def test_explicit_workspace_does_not_replace_application_resources(monkeypatch, tmp_path):
    source = tmp_path / 'source'
    monkeypatch.setattr(installation, 'SOURCE_ROOT', source)
    monkeypatch.setenv('OPENDIRECTOR_ROOT', str(tmp_path / 'data'))
    assert installation.data_root() == tmp_path / 'data'
    assert installation.web_root() == source / 'dist'
    assert installation.builtin_skills() == source / 'packages/agent/skills'
