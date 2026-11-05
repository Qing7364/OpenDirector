import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ChatTool } from "../src/backend/chat.ts";
import { activityProgress, replyParts, replySections } from "../src/canvas/assistantActivity.ts";

const tool = (id: string, offset: number, status: ChatTool["status"] = "complete"): ChatTool => ({
  id, textOffset: offset, name: "web_fetch", status,
});
const message = (tools: ChatTool[], text = ""): ChatMessage => ({
  id: "reply", role: "assistant", status: "streaming", text, tools,
});

test("groups adjacent calls while preserving public messages and Unicode boundaries", () => {
  const parts = replyParts(message([
    tool("a", 0), tool("b", 0), tool("c", 2), tool("d", 2),
  ], "🌊查结果"));
  assert.deepEqual(parts, [
    { type: "tools", id: "a", tools: [tool("a", 0), tool("b", 0)] },
    { type: "text", id: "text-c", text: "🌊查" },
    { type: "tools", id: "c", tools: [tool("c", 2), tool("d", 2)] },
    { type: "text", id: "tail", text: "结果" },
  ]);
});

test("keeps one stable group identity as a large call sequence grows", () => {
  const tools = Array.from({ length: 1000 }, (_, index) => tool(String(index), 0));
  const before = replyParts(message(tools.slice(0, 1)));
  const after = replyParts(message(tools));
  assert.equal(before[0].id, after[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].type, "tools");
  if (after[0].type === "tools") assert.equal(after[0].tools.length, 1000);
  assert.equal(tools.length, 1000);
});

test("renders text-only and empty messages without synthetic activities", () => {
  assert.deepEqual(replyParts(message([], "完成")), [{ type: "text", id: "tail", text: "完成" }]);
  assert.deepEqual(replyParts(message([])), []);
});

test("clamps historical tool offsets without losing or repeating text", () => {
  const parts = replyParts(message([tool("a", -1), tool("b", 20), tool("c", 1)], "结果"));
  assert.deepEqual(parts.filter((part) => part.type === "text").map((part) => part.text), ["结果"]);
  assert.deepEqual(parts.filter((part) => part.type === "tools").flatMap((part) => part.tools.map((call) => call.id)), ["a", "b", "c"]);
});

test("activity progress follows running calls, thinking and plan state", () => {
  const reply = message([tool("a", 0, "running"), tool("b", 0, "running")]);
  assert.equal(activityProgress(reply, true), "正在执行：读取网页（2 项进行中）");
  reply.tools = [tool("a", 0, "complete")];
  assert.equal(activityProgress(reply, true), "正在思考…");
  assert.equal(activityProgress(reply, false), "思考中…");
  assert.equal(activityProgress({ ...reply, plan: [{ content: "检查结果", status: "in_progress" }] }, false), "正在执行计划：检查结果");
});


test("folds intermediate narration and calls while keeping final reply outside", () => {
  const input = message([tool("a", 3), tool("b", 6)], "准备中处理中完成");
  const live = replySections(input);
  assert.equal(live.reply.length, 0);
  assert.equal(live.activity.length, 5);
  const done = replySections({ ...input, status: "complete" });
  assert.deepEqual(done.reply, [{ type: "text", id: "tail", text: "完成" }]);
  assert.equal(done.activity.length, 4);
  assert.equal(replySections({ ...message([], "直接回复"), status: "complete" }).activity.length, 0);
});
