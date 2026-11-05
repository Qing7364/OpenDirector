import assert from "node:assert/strict";
import test from "node:test";
import { traceCategory } from "../src/canvas/traceCategory.ts";

test("harness roles share semantic trace colors", () => {
  for (const type of ["message", "assistant", "event", undefined]) {
    assert.equal(traceCategory(type, "user"), "user");
    assert.equal(traceCategory(type, "developer"), "system");
    assert.equal(traceCategory(type, "system"), "system");
  }
  for (const type of ["plan", "context", "turn_context", "session_meta"]) assert.equal(traceCategory(type), "context");
  for (const type of ["tool_use", "tool_result", "command_execution", "chat.tool_call", "chat.tool_result"]) assert.equal(traceCategory(type), "tool");
  for (const type of ["agent_message", "chat.delta", "text"]) assert.equal(traceCategory(type), "assistant");
});
