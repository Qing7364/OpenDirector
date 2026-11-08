"""Real Windows ACL, handle, cross-process and initialization regressions."""
from contextlib import contextmanager
from contextlib import asynccontextmanager
import asyncio
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from opendirector.agent import owner_rights as rights

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='requires native Windows ACL and oplock APIs')
WORLD = bytes.fromhex('010100000000000100000000')


def security(path):
    state = rights._Projection(path if path.is_dir() else path.parent, tree=False)
    child = None
    try:
        handle = state.nodes[-1][0]
        if path.is_file():
            child = state.api.open(handle, path.name)
            handle = child
        return state.api.security(handle)
    finally:
        if child is not None: state.api.kernel.CloseHandle(child)
        state.close()


def handle_count(api):
    api.kernel.GetProcessHandleCount.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
    count = w.DWORD()
    assert api.kernel.GetProcessHandleCount(api.kernel.GetCurrentProcess(), c.byref(count))
    return count.value


def writer_handle(api, parent, name):
    f = api.files
    length = f._validate_component(name)
    text_buffer = c.create_unicode_buffer(name)
    text = f.UnicodeString(length, length + 2, c.cast(text_buffer, w.LPWSTR))
    attrs = f.ObjectAttributes(c.sizeof(f.ObjectAttributes), parent, c.pointer(text), 0x40, None, None)
    handle, status = w.HANDLE(), f.IoStatus()
    # READ_CONTROL | WRITE_DAC, with no data access and its own FILE_OBJECT.
    code = f.native.NtCreateFile(c.byref(handle), 0x60000, c.byref(attrs), c.byref(status),
        None, 0, 7, 1, f.OPEN_REPARSE_POINT, None, 0)
    if code < 0: raise c.WinError(f.native.RtlNtStatusToDosError(code))
    return handle.value


def test_first_root_check_failure_closes_the_actual_created_handle(tmp_path, monkeypatch):
    api = rights._Windows()
    before = handle_count(api)
    failures = []
    def failed(self, handle):
        failures.append(handle)
        raise OSError('first root attribute query failed')
    monkeypatch.setattr(rights._Windows, 'checked', failed)
    for _ in range(32):
        with pytest.raises(OSError, match='first root'):
            rights._Projection(tmp_path)
    assert len(failures) == 32
    assert handle_count(api) == before


@pytest.mark.parametrize('kind', ['ordinary', 'hardlink_after_walk', 'late_file_after_walk'])
def test_initialization_never_changes_an_existing_files_shared_acl(tmp_path, monkeypatch, kind):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    source = work / 'input.txt'
    if kind != 'late_file_after_walk': source.write_bytes(b'KEEP')
    state = rights._Projection(work)
    writes = []
    setter = rights._Windows.set_acl
    def record(self, handle, value):
        writes.append(self.identity(handle))
        return setter(self, handle, value)
    monkeypatch.setattr(rights._Windows, 'set_acl', record)
    if kind == 'late_file_after_walk': source.write_bytes(b'KEEP')
    outside = tmp_path / 'outside.txt'
    if kind == 'hardlink_after_walk': os.link(source, outside)
    before = {path: security(path) for path in (tmp_path, work, source)}
    try:
        with pytest.raises(OSError): state.apply()
        assert writes == []
        assert {path: security(path) for path in before} == before
        assert source.read_bytes() == b'KEEP'
        if outside.exists():
            assert outside.samefile(source) and outside.read_bytes() == b'KEEP'
            assert security(outside) == before[source]
    finally: state.close()


@pytest.mark.parametrize('stage', ['after_read', 'inside_setter'])
@pytest.mark.parametrize('preopened', [False, True])
def test_concurrent_real_deny_is_preserved_across_descriptor_update(tmp_path, monkeypatch, stage, preopened):
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    state = rights._Projection(work, tree=False)
    handle = state.nodes[-1][0]
    parent, name = state.locations[handle]
    original_acl = state.api.security(handle)[1]
    denial = rights._ace(1, 0, 2, WORLD)
    other = writer_handle(state.api, parent, name) if preopened else None
    checks, worker_errors, worker_done = [], [], threading.Event()
    actual_guard, actual_set = guard.descriptor_guard, rights._Windows.set_acl
    @contextmanager
    def observed(api, target):
        with actual_guard(api, target) as unchanged:
            checks.append(unchanged)
            yield unchanged
    monkeypatch.setattr(guard, 'descriptor_guard', observed)
    def competing_editor():
        target = other
        try:
            if target is None: target = writer_handle(state.api, parent, name)
            actual_set(state.api, target, rights._acl(original_acl, [denial] + rights._entries(original_acl)))
        except BaseException as error: worker_errors.append(error)
        finally:
            if target is not None: state.api.kernel.CloseHandle(target)
            worker_done.set()
    worker = threading.Thread(target=competing_editor)
    raced = []
    def start_conflict():
        if raced: return
        raced.append(True); worker.start()
        deadline = time.monotonic() + 3
        while True:
            try: checks[-1]()
            except OSError as error:
                assert error.winerror == 995
                break
            assert time.monotonic() < deadline, 'Actual ACL writer did not break the oplock'
            time.sleep(.005)
        assert not worker_done.is_set()  # SET_SECURITY must wait for acknowledgment.
        assert state.api.security(handle)[1] == original_acl
    def transform(owner, acl):
        if stage == 'after_read': start_conflict()
        return rights.owner_entries(acl, owner, writable=True)[0]
    def writing(self, target, acl):
        if stage == 'inside_setter': start_conflict()
        return actual_set(self, target, acl)
    monkeypatch.setattr(rights._Windows, 'set_acl', writing)
    try:
        state.edit(handle, transform)
        worker.join(timeout=3)
        assert not worker.is_alive() and worker_done.is_set() and worker_errors == []
        current = state.api.security(handle)[1]
        assert denial in rights._entries(current)
        assert all(not int.from_bytes(item[4:8], 'little') & 2 for item in rights._entries(current)
                   if item[0] == 0 and item[8:] == state.api.owner)
    finally:
        state.close()
        if worker.ident is not None: worker.join(timeout=3)
        elif other is not None: state.api.kernel.CloseHandle(other)


def test_oplock_request_failure_closes_each_edit_handle(tmp_path, monkeypatch):
    from opendirector.agent import windows_acl_guard as guard
    state = rights._Projection(tmp_path, tree=False)
    before = handle_count(state.api)
    def rejected(*args):
        c.set_last_error(300)
        return 0
    # Preserve the actual kernel handle creation/close and actual event close.
    monkeypatch.setattr(state.api.kernel, 'DeviceIoControl', rejected)
    try:
        for _ in range(8):
            with pytest.raises(OSError) as error:
                state.edit(state.nodes[-1][0], lambda owner, acl: acl)
            assert error.value.winerror == 300
        assert handle_count(state.api) == before
    finally: state.close()


@pytest.mark.parametrize('failure', [RuntimeError, asyncio.CancelledError])
def test_failed_or_cancelled_body_rolls_back_all_initialization_aces(tmp_path, failure):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    before = {path: security(path) for path in (tmp_path, work)}
    async def check():
        with pytest.raises(failure):
            async with rights.native_owner_access(work):
                raise failure('initialization did not finish')
    asyncio.run(check())
    assert {path: security(path) for path in before} == before


def test_native_setup_failure_initializes_before_files_and_closes_permissions(tmp_path, monkeypatch):
    from uuid import uuid4
    from opendirector.agent import native
    from opendirector.agent.context import RunContext
    original = rights.native_owner_access
    observations = []
    @asynccontextmanager
    async def observing(work):
        assert list(work.iterdir()) == []
        observations.append(('enter', work))
        async with original(work):
            try: yield
            finally: observations.append(('exit', work))
    def fail(work, catalog):
        assert observations == [('enter', work)]
        raise RuntimeError('skill copy failed before spawn')
    class Gateway:
        async def close(self): observations.append(('gateway-close', None))
    monkeypatch.setattr(native, 'native_owner_access', observing)
    monkeypatch.setattr(native, 'prepare_skills', fail)
    run = RunContext(runtime='deepseek', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[])
    before = security(tmp_path)
    async def check():
        with pytest.raises(RuntimeError, match='skill copy failed'):
            async for _ in native.NativeRuntime().stream(run, Gateway()): pytest.fail('must not spawn')
    asyncio.run(check())
    assert [item[0] for item in observations] == ['enter', 'gateway-close', 'exit']
    assert security(tmp_path) == before
    work = observations[0][1]
    # The failed fresh root retains its original OWNER RIGHTS policy only.
    _, acl = security(work)
    assert not any(item[8:] == rights.CREATOR for item in rights._entries(acl))


def test_cleanup_retry_preserves_a_deny_added_during_its_actual_setter(tmp_path, monkeypatch):
    from opendirector.agent import windows_acl_guard as guard
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    before = security(tmp_path)
    actual_guard, actual_set = guard.descriptor_guard, rights._Windows.set_acl
    checks, failures = [], []
    denial = rights._ace(1, 0, 2, WORLD)
    @contextmanager
    def observed(api, target):
        with actual_guard(api, target) as unchanged:
            checks.append(unchanged)
            yield unchanged
    async def check():
        async with rights.native_owner_access(work):
            state = rights._Projection(tmp_path, tree=False)
            try:
                target = state.nodes[-1][0]
                identity = state.api.identity(target)
                active_acl = state.api.security(target)[1]
                parent, name = state.locations[target]
                other = writer_handle(state.api, parent, name)
                done = threading.Event()
                def external():
                    try:
                        actual_set(state.api, other, rights._acl(active_acl, [denial] + rights._entries(active_acl)))
                    except BaseException as error: failures.append(error)
                    finally: state.api.kernel.CloseHandle(other); done.set()
                worker = threading.Thread(target=external)
                raced = []
                def setter(self, handle, value):
                    if self.identity(handle) == identity and not raced:
                        raced.append(True); worker.start()
                        deadline = time.monotonic() + 3
                        while True:
                            try: checks[-1]()
                            except OSError as error:
                                assert error.winerror == 995
                                break
                            assert time.monotonic() < deadline
                            time.sleep(.005)
                        assert not done.is_set()
                    return actual_set(self, handle, value)
                monkeypatch.setattr(guard, 'descriptor_guard', observed)
                monkeypatch.setattr(rights._Windows, 'set_acl', setter)
            finally: state.close()
        worker.join(timeout=3)
        assert raced and done.is_set() and not worker.is_alive() and failures == []
        owner, current = security(tmp_path)
        assert owner == before[0]
        assert rights._entries(current) == [denial] + rights._entries(before[1])
        # No leaked lease prevents another normal initialization.
        async with asyncio.timeout(3):
            async with rights.native_owner_access(work): pass
    asyncio.run(check())


@pytest.mark.parametrize('different_temp', [False, True])
def test_real_processes_share_one_coordinator_across_environment_overrides(tmp_path, different_temp):
    work = tmp_path / 'work'; work.mkdir(mode=0o700)
    one_temp = tmp_path / 'temp-one'; one_temp.mkdir(mode=0o700)
    two_temp = tmp_path / 'temp-two' if different_temp else one_temp
    two_temp.mkdir(mode=0o700, exist_ok=True)
    states = [tmp_path / 'first.json', tmp_path / 'second.json']
    processes = []
    script = Path(__file__).parent / 'fixtures/owner_rights_worker.py'
    def wait(path):
        deadline = time.monotonic() + 8
        while not path.exists():
            assert time.monotonic() < deadline, (path, [p.poll() for p in processes])
            time.sleep(.025)
    try:
        for index, temporary in enumerate((one_temp, two_temp)):
            env = {**os.environ, 'TEMP': str(temporary), 'TMP': str(temporary),
                   'USERPROFILE': str(temporary), 'HOME': str(temporary), 'LOCALAPPDATA': str(temporary)}
            processes.append(subprocess.Popen([sys.executable, str(script), str(work), str(states[index])],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            if index == 0: wait(states[0])
        time.sleep(.25)
        assert not states[1].exists(), 'Second process bypassed the original work lease'
        active = security(tmp_path)
        states[0].with_suffix('.release').write_text('release')
        wait(states[0].with_suffix('.closed')); wait(states[1])
        assert security(tmp_path) == active
        states[1].with_suffix('.release').write_text('release')
        outputs = [process.communicate(timeout=5) for process in processes]
        assert all(process.returncode == 0 for process in processes), outputs
        assert all(value == (b'', b'') for value in outputs), outputs
        a, b = [json.loads(path.read_text()) for path in states]
        assert a['coordinator'] == b['coordinator'] == str(rights._coordination_directory(rights._Windows()))
        assert (a['temp'] != b['temp']) is different_temp
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill(); process.communicate(timeout=5)
