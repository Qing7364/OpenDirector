"""Bounded subprocess shutdown shared by runtime transports."""
import asyncio
from contextlib import suppress
import os
import signal
import subprocess
import sys

WINDOWS = sys.platform == 'win32'


def _signal_tree(process: asyncio.subprocess.Process, *, force: bool) -> None:
    """Stop the child together with anything it spawned.

    POSIX exposes process groups; Windows has no equivalent, so its process
    tree is walked by taskkill instead of a single group signal.
    """
    if WINDOWS:
        command = ['taskkill', '/PID', str(process.pid), '/T']
        if force:
            command.append('/F')
        with suppress(OSError, subprocess.SubprocessError):
            subprocess.run(command, capture_output=True, check=False, timeout=5)
        return
    os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)


async def terminate(process: asyncio.subprocess.Process, *, group: bool = False) -> None:
    if process.returncode is not None:
        return
    with suppress(ProcessLookupError):
        if group:
            _signal_tree(process, force=False)
        else:
            process.terminate()
    try:
        await asyncio.wait_for(process.wait(), 5)
    except TimeoutError:
        with suppress(ProcessLookupError):
            if group:
                _signal_tree(process, force=True)
            else:
                process.kill()
        await process.wait()
