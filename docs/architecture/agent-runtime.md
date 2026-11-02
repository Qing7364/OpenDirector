# Agent runtime

Default runs the pinned bundled OpenCode process. OpenDirector supplies its configured chat model, declared input modalities and a turn-scoped MCP gateway. OpenCode owns its loop, native file and shell tools, and Skill loading.

Each turn writes intermediate files into `agent-runs/<turn-id>/work`; source assets remain at their original absolute paths. The process inherits the server PATH, so installed FFmpeg and ffprobe can be discovered with `command -v`. These programs must be installed before starting the server.

Project changes go through `read_project`, `command_schema` and `execute_command`, sharing validation and receipts with the UI. Publish each newly created file with `artifact.publish`, then use `canvas.show` to display it. A timeline of source ranges does not create independent clips.

Conversation drafts and messages persist separately from project objects. Only one reply per project is admitted; stop and stream disconnect terminate the process group, drain accepted business operations and save the partial reply. Native events and business-tool events are recorded in `agent-runs/<turn-id>.opencode.jsonl`.

Image reading requires both a compatible model/API and enabled image input in model settings. Native tool availability is not proof that a model can understand a video; inspect actual output. ComfyUI execution and character-replacement quality are outside this change. External CLI selection and the richer Skill and preview UI follow separately.

Validation covers the real bundled OpenCode process with a simulated model transport, shared MCP calls, cancellation, persisted conversation state, and actual FFmpeg outputs published through business commands. Simulated model tests do not establish real model planning or visual quality.
