# Verification and delivery

## Installed-state checks

Run with the selected Python, referring to the helper wherever the skill is
installed (not necessarily inside the target checkout):

```sh
python3 /path/to/install-opendirector/scripts/check_environment.py --root /path/to/OpenDirector --installed
```

Require all required checks to pass. This checks the project venv, pip integrity,
runtime imports, CLI loading, Vite installation, and `dist/index.html`, as well
as prerequisite versions and FFmpeg. It does not prove HTTP readiness or that
the build is current; only a successful build in this run establishes that.

## Temporary real startup

1. Choose a free local port, preferring 8000. If occupied, use another port and
   preserve the existing listener. Start the real launcher in an owned terminal
   session: `.venv/bin/opendirector serve --port PORT` (Windows:
   `& .\.venv\Scripts\opendirector.exe serve --port PORT`).
2. Wait for this process's startup URL, while monitoring its exit and logs.
   Allow up to 90 seconds and poll in short intervals. An exited launcher or a
   bind error is failure even if some other service answers on the port.
3. Request `/api/health` with `X-OpenDirector-Request: 1`; require HTTP 200 and
   JSON `{"status":"ok"}`. Also request `/` and confirm it serves the built
   application's HTML, not a Vite development page or only an API response.
   POSIX example (use `curl.exe` in Windows PowerShell):

   ```sh
   curl --fail --max-time 5 -H 'X-OpenDirector-Request: 1' http://127.0.0.1:8000/api/health
   curl --fail --max-time 5 http://127.0.0.1:8000/
   ```

   Substitute the chosen port. If curl is absent, use the venv Python's
   `urllib.request` with the same header and a bounded timeout. Avoid proxying
   loopback requests through a configured network proxy.
4. In a finally/cleanup path, send Ctrl+C to the owned terminal session, wait
   for the launcher and API child to exit, and check that the port is released.
   If terminal control is unavailable, arrange process-tree ownership before
   launching: a POSIX process group or a Windows process-tree mechanism. Merely
   terminating the parent may leave its API child alive. Escalate cleanup only
   for processes belonging to this test; do not kill unrelated Python services.

If the environment prevents socket binding or service execution, report build
and static checks separately and mark HTTP startup unverified with the exact
restriction. Do not describe it as successful startup.

## Final response

Follow the user's language. Give platform/architecture, source directory and
revision (or ZIP provenance), reused/installed dependencies, build/check results,
and any unverified stage. Include `cd` with the actual quoted path, prerequisite
PATH setup when necessary, the exact `serve` command, URL, stop/restart steps,
and `--port 8001` for conflicts. No need to rebuild for each ordinary restart.

Suggested wording, completed with actual findings:

- zh-CN: “OpenDirector 已安装并构建完成，启动与健康检查已通过。再次启动请在
  下列目录执行对应命令；使用期间保持终端打开，按 Ctrl+C 停止。AI 功能需在
  设置 → 模型接入中配置模型服务。”
- en-US: “OpenDirector is installed and built; startup and health checks passed.
  To start it again, run the command below from the installation directory.
  Keep the terminal open and press Ctrl+C to stop. Configure model services in
  Settings → Model access to use AI features.”

Use those success statements only when supported. A startup smoke test does
not establish browser editing, media export, real model calls, or cross-platform
acceptance. Do not claim those results without actually exercising them.
