import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeTrace } from "../src/canvas/claudeTrace.ts";
const parse = (records: unknown[]) => normalizeClaudeTrace(records.map(record => JSON.stringify(record)).join("\n")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const message = (type: string, content: unknown[]) => ({ native: { type, message: { role: type, content } } });
test("assistant tool_use is a tool and user tool_result updates the same call", () => {
  const rows = parse([message("assistant", [{ type: "tool_use", id: "call1", name: "Bash", input: { command: "pwd && ls -la" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "call1", content: "/work", is_error: false }])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].native.type, "tool_use");
  assert.equal(rows[0].native.part.tool, "Bash");
  assert.deepEqual(rows[0].native.part.state, { status: "completed", input: { command: "pwd && ls -la" }, output: "/work" });
});
test("mixed Claude content retains text, reasoning and separate parallel tool identities", () => {
  const rows = parse([message("assistant", [{ type: "text", text: "Working" }, { type: "thinking", thinking: "Plan", signature: "opaque" },
    { type: "tool_use", id: "a", name: "Bash", input: {} }, { type: "tool_use", id: "b", name: "Bash", input: {} }]),
    message("user", [{ type: "tool_result", tool_use_id: "b", content: "Error", is_error: true }])]);
  assert.deepEqual(rows.map(row => row.native.type), ["text", "reasoning", "tool_use", "tool_use"]);
  assert.equal(rows[2].native.part.state.status, "in_progress");
  assert.equal(rows[3].native.part.state.status, "failed");
  assert.ok(!JSON.stringify(rows).includes("opaque"));
  assert.equal(normalizeClaudeTrace('{"native":'), "");
});
