"""Bounded subprocess shutdown shared by runtime transports."""
import asyncio
from contextlib import suppress
import os
import signal


async def terminate(process: asyncio.subprocess.Process, *, group: bool = False) -> None:
    if process.returncode is not None:
        return
    with suppress(ProcessLookupError):
        if group:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    try:
        await asyncio.wait_for(process.wait(), 5)
    except TimeoutError:
        with suppress(ProcessLookupError):
            if group:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        await process.wait()
