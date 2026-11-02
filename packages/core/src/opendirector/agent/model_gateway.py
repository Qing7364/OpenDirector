import asyncio
import json
import logging
import secrets

import httpx

from opendirector.integrations.chat_completions import chat_payload
from opendirector.integrations.http_settings import (
    MODEL_HTTP_HOOKS,
    MODEL_JOB_CONTEXT,
    auth_headers,
    trust_environment,
)

logger = logging.getLogger(__name__)


class ModelGateway:
    """Loopback-only OpenAI transport for the bundled runtime's configured model."""

    def __init__(self, config: dict, thinking: str, token: str, project_id: str,
                 turn_id: str, transport: httpx.AsyncBaseTransport | None = None):
        self.config, self.thinking, self.token = config, thinking, token
        self.project_id, self.turn_id, self.transport = project_id, turn_id, transport
        self.active: set[asyncio.Task] = set()
        self.closed = False

    def connect(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.create_task(self.request(reader, writer))
        self.active.add(task)
        task.add_done_callback(self.active.discard)

    async def request(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        status_sent = False
        context = MODEL_JOB_CONTEXT.set((self.project_id, self.turn_id))
        try:
            async with asyncio.timeout(180):
                request = await reader.readuntil(b"\r\n\r\n")
                lines = request.decode("ascii").split("\r\n")
                headers = {
                    key.lower(): value
                    for key, value in (
                        line.split(":", 1) for line in lines[1:] if ":" in line
                    )
                }
                method, path, _ = lines[0].split(" ")
                authorized = secrets.compare_digest(
                    headers.get("authorization", "").strip(), f"Bearer {self.token}"
                )
                length = int(headers.get("content-length", "0"))
                if (
                    method != "POST"
                    or path != "/chat/completions"
                    or not authorized
                    or self.closed
                    or not 0 < length <= 48 * 1024 * 1024
                ):
                    writer.write(
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    await writer.drain()
                    return
                payload = json.loads(await reader.readexactly(length))
                payload.update(
                    chat_payload(
                        self.config, payload["messages"], self.thinking
                    )
                )
                payload["model"] = self.config["modelId"]
                url = self.config["url"].rstrip("/") + "/chat/completions"
                async with httpx.AsyncClient(
                    transport=self.transport,
                    event_hooks=MODEL_HTTP_HOOKS,
                    trust_env=trust_environment(url, config=self.config),
                    timeout=httpx.Timeout(120, connect=15),
                ) as client:
                    async with client.stream(
                        "POST",
                        url,
                        headers=auth_headers(self.config),
                        json=payload,
                    ) as response:
                        content_type = response.headers.get(
                            "content-type", "application/json"
                        )
                        writer.write(
                            f"HTTP/1.1 {response.status_code} Response\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n".encode()
                        )
                        status_sent = True
                        await writer.drain()
                        async for chunk in response.aiter_bytes():
                            writer.write(chunk)
                            await writer.drain()
        except (
            httpx.HTTPError,
            OSError,
            ValueError,
            KeyError,
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            TimeoutError,
        ) as failure:
            logger.error(
                f"agent.model.error turn_id={self.turn_id} failure={type(failure).__name__}"
            )
            if not status_sent:
                writer.write(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                await writer.drain()
        finally:
            MODEL_JOB_CONTEXT.reset(context)
            writer.close()
            await writer.wait_closed()
