"""Deterministic journaling checks; native races live in lifecycle tests."""
from contextlib import contextmanager
from types import SimpleNamespace
import sys

import pytest

from opendirector.agent import owner_rights as rights


def failure(code):
    error = OSError('controlled native failure')
    error.winerror = code
    return error


def projection(monkeypatch, stage):
    owner = bytes.fromhex('010100000000000515000000')
    ancestor = rights._acl(b'\x02\0', [rights._ace(1, 0, 2, rights.OWNER),
        rights._ace(0, 3, 0x1F01FF, rights.OWNER)])
    work = rights._acl(b'\x02\0', [rights._ace(0, 3, 0x1F01FF, rights.OWNER)])
    external = rights._ace(1, 0, 2, owner)
    acls, writes, closed, races = {1: ancestor, 2: work}, [], [], []
    def write(handle, acl, *, on_write=None):
        if stage == 'setter_failure': raise failure(5)
        acls[handle % 100] = acl
        writes.append((handle % 100, acl))
        if on_write is not None: on_write()
    api = SimpleNamespace(owner=owner, c=SimpleNamespace(WinError=failure),
        kernel=SimpleNamespace(CloseHandle=closed.append),
        checked=lambda handle: True, children=lambda handle: (),
        identity=lambda handle: bytes([handle % 100]),
        security=lambda handle: (owner, acls[handle % 100]),
        open=lambda parent, name, **options: name + 100,
        set_acl=write)
    @contextmanager
    def guard(api, handle):
        checks = 0
        def unchanged():
            nonlocal checks
            checks += 1
            if (handle % 100 == 1 and not races
                    and checks == (1 if stage == 'before_write' else 2)
                    and stage != 'setter_failure'):
                races.append({'writesBeforeConflict': len(writes)})
                current = acls[1]
                acls[1] = rights._acl(current, [external] + rights._entries(current))
                raise failure(995)
        try: yield unchanged
        finally: closed.append(handle)
    monkeypatch.setitem(sys.modules, 'opendirector.agent.windows_acl_guard',
        SimpleNamespace(descriptor_guard=guard))
    state = object.__new__(rights._Projection)
    state.api, state.nodes, state.changes = api, [(1, False), (2, True)], []
    state.locations, state.applied = {1: (0, 1), 2: (0, 2)}, False
    state.initialized = False
    return state, acls, ancestor, work, external, races, closed


@pytest.mark.parametrize('stage', ['before_write', 'after_write'])
@pytest.mark.parametrize('completed', [False, True])
def test_journal_owns_only_installed_entries_across_a_retry_and_close(monkeypatch, stage, completed):
    state, acls, ancestor, work, external, races, closed = projection(monkeypatch, stage)
    state.apply()
    assert races == [{'writesBeforeConflict': 0 if stage == 'before_write' else 1}]
    recorded = [entry for handle, writable, added in state.changes if not writable for entry in added]
    assert recorded.count(external) == (0 if stage == 'before_write' else 1)
    state.applied = completed
    state.close()
    assert rights._entries(acls[1]) == [external] + rights._entries(ancestor)
    if completed: assert acls[2] != work
    else: assert acls[2] == work
    assert closed.count(1) == closed.count(2) == 1
    assert not state.changes and not state.nodes


def test_failed_setter_does_not_commit_a_proposed_change(monkeypatch):
    state, acls, ancestor, work, _, _, _ = projection(monkeypatch, 'setter_failure')
    try:
        with pytest.raises(OSError) as error: state.apply()
        assert error.value.winerror == 5
        assert state.changes == []
    finally: state.close()
    assert acls == {1: ancestor, 2: work}
