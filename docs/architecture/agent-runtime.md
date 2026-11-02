# Agent runtime

Default runs the pinned bundled OpenCode process. OpenDirector supplies its configured chat model, declared input modalities and a turn-scoped MCP gateway. OpenCode owns its loop, native file and shell tools, and Skill loading.

Each turn writes intermediate files into `agent-runs/<turn-id>/work`; source assets remain at their original absolute paths. The process inherits the server PATH, so installed FFmpeg and ffprobe can be discovered with `command -v`. These programs must be installed before starting the server.

Project changes go through `read_project`, `command_schema` and `execute_command`, sharing validation and receipts with the UI. Publish each newly created file with `artifact.publish`, then use `canvas.show` to display it. A timeline of source ranges does not create independent clips.

Conversation drafts and messages persist separately from project objects. Only one reply per project is admitted; stop and stream disconnect terminate the process group, drain accepted business operations and save the partial reply. Native events and business-tool events are recorded in `agent-runs/<turn-id>.opencode.jsonl`.

Image reading requires both a compatible model/API and enabled image input in model settings. Native tool availability is not proof that a model can understand a video; inspect actual output. ComfyUI execution and character-replacement quality are outside this change. The richer Skill and preview UI follow separately.

Validation covers the real bundled OpenCode process with a simulated model transport, shared MCP calls, cancellation, persisted conversation state, and actual FFmpeg outputs published through business commands. Simulated model tests do not establish real model planning or visual quality.

## External CLI selection

The assistant picker separates installed OpenCode CLI, Codex and Claude Code from Default. Default continues to use bundled OpenCode and OpenDirector model settings; external harnesses use their installed binary, native authentication and model catalog. Unavailable harnesses provide setup guidance. Model and effort choices persist with each conversation, with a browser preference used while the draft is saving.

OpenCode CLI reads its configured model, recent selection or native provider default. Codex reads its native model catalog and configured default before an isolated execution; Claude Code reads its native initialization catalog. The server inherits authentication environment variables, including third-party API configuration, so launch it from the configured shell environment.

All harnesses receive the same turn-scoped business gateway and execution directory. Codex runs with workspace-write sandboxing; Claude Code receives the explicit Skill, Bash, Read and OpenDirector tool allowlist. Native events are recorded under the corresponding runtime name. Automated CLI fixtures validate routing and process behavior; each installed CLI and real model still require separate acceptance testing.
