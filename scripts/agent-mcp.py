"""Stdio MCP transport; the parent process owns authorization and business effects."""

import json
import os
import socket
import sys


def main() -> None:
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(os.environ["OPENDIRECTOR_AGENT_SOCKET"])
            payload = {
                "token": os.environ["OPENDIRECTOR_AGENT_TOKEN"],
                "request": request,
            }
            connection.sendall((json.dumps(payload) + "\n").encode())
            with connection.makefile("rb") as reader:
                response = reader.readline(64 * 1024 * 1024)
        sys.stdout.write(response.decode())
        sys.stdout.flush()


if __name__ == "__main__":
    main()
