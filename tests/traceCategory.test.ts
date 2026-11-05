import assert from "node:assert/strict";
import test from "node:test";
import { traceCategory, isThinkingTokenEstimate, readableTraceValue } from "../src/canvas/traceCategory.ts";

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


test("Claude thinking token estimates are hidden without hiding real trace content", () => {
  assert.equal(isThinkingTokenEstimate({ type: "system", subtype: "thinking_tokens" }), true);
  for (const event of [undefined, { type: "system", subtype: "init" },
    { type: "system", subtype: "task_notification" }, { type: "reasoning" },
    { type: "assistant" }, { type: "tool" }])
    assert.equal(isThinkingTokenEstimate(event), false);
});


test("trace display removes signatures and encrypted blocks while retaining readable reasoning and tools", () => {
  const original = { message: { content: [
    { type: "thinking", thinking: "Readable thought", signature: "opaque" },
    { type: "redacted_thinking", data: "ciphertext" },
    { type: "encrypted_thinking", data: "ciphertext" },
    { type: "tool_use", name: "shell", input: { command: "pwd" } },
    { type: "text", text: "Reply" },
  ] }, encrypted_content: "ciphertext" };
  const before = structuredClone(original);
  assert.deepEqual(readableTraceValue(original), { message: { content: [
    { type: "thinking", thinking: "Readable thought" },
    { type: "tool_use", name: "shell", input: { command: "pwd" } },
    { type: "text", text: "Reply" },
  ] } });
  assert.deepEqual(original, before);
});
