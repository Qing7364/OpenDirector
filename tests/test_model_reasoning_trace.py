"""Record streamed reasoning while preserving upstream bytes."""
import asyncio
import json

import httpx

from opendirector.agent.model_gateway import ModelGateway


def test_reasoning_trace_handles_fragmented_sse_without_changing_response(tmp_path):
    chunks = [
        {"choices": [{"index": 0, "delta": {"reasoning_content": "先检查"}}]},
        {"choices": [{"index": 0, "delta": {"reasoning_content": "工程状态。"}}]},
        {"choices": [{"index": 0, "delta": {"content": "已完成"}}]},
    ]
    body = b"".join(
        ("data: " + json.dumps(chunk, ensure_ascii=False) + "\r\n\r\n").encode()
        for chunk in chunks
    ) + b"data: [DONE]\r\n\r\n"

    class FragmentedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for index in range(0, len(body), 7):
                yield body[index:index + 7]

    async def run():
        trace = tmp_path / "model.jsonl"
        gateway = ModelGateway(
            {"modelId": "fixture", "url": "http://model.test/v1", "authMode": "none"},
            "auto", "local-token", "project", "turn",
            httpx.MockTransport(lambda request: httpx.Response(
                200, headers={"Content-Type": "text/event-stream"}, stream=FragmentedStream())),
            trace_path=trace,
        )
        server = await asyncio.start_server(gateway.connect, "127.0.0.1", 0)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
            payload = json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode()
            writer.write(
                b"POST /chat/completions HTTP/1.1\r\nAuthorization: Bearer local-token\r\n"
                + f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload
            )
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 5)
            writer.close()
            await writer.wait_closed()
            assert response.split(b"\r\n\r\n", 1)[1] == body
            records = [json.loads(line) for line in trace.read_text().splitlines()]
            reasoning = [record for record in records if record["event"] == "model.reasoning"]
            assert "".join(record["text"] for record in reasoning) == "先检查工程状态。"
            assert len({record["requestId"] for record in reasoning}) == 1
            assert all(record["choiceIndex"] == 0 for record in reasoning)
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.gather(*gateway.active)
    asyncio.run(run())
