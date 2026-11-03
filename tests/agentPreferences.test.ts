import assert from "node:assert/strict";
import test from "node:test";
import {rememberAgentSelection, restoreAgentSelection} from "../src/canvas/agentPreferences.ts";
import type {Conversation} from "../src/backend/chat.ts";

function storage() {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {values.set(key, value);}};
}
function draft(conversationId = "one"): Conversation {
  return {conversationId, messages: [], draft: "保留输入", assets: [], thinking: "auto",
    modelSelections: {agent: null, image: "image-model", video: null, audio: null}};
}

test("refresh restores the selected harness and each harness's model before server autosave", () => {
  const saved = draft();
  const local = storage();
  rememberAgentSelection("project", {...saved, runtime: "codex", runtimeModel: "gpt-model",
    harnessModels: {codex: "gpt-model", claude: "sonnet"}}, local);
  const restored = restoreAgentSelection("project", saved, local);
  assert.equal(restored.runtime, "codex");
  assert.equal(restored.runtimeModel, "gpt-model");
  assert.deepEqual(restored.harnessModels, {codex: "gpt-model", claude: "sonnet"});
  assert.equal(restored.draft, saved.draft);
  assert.equal(restored.modelSelections.image, "image-model");
});

test("new projects inherit the last choice while configured conversations retain theirs", () => {
  const local = storage();
  rememberAgentSelection("old", {...draft(), runtime: "claude", runtimeModel: "sonnet"}, local);
  assert.equal(restoreAgentSelection("new", draft(), local).runtime, "claude");
  const configured = {...draft(), runtime: "codex" as const, runtimeModel: "gpt-model"};
  assert.deepEqual(restoreAgentSelection("configured", configured, local), configured);
});

test("conversation-specific choices and default service model are preserved", () => {
  const local = storage();
  rememberAgentSelection("project", {...draft("one"), runtime: "default",
    modelSelections: {...draft().modelSelections, agent: "minimax"}}, local);
  rememberAgentSelection("project", {...draft("two"), runtime: "codex", runtimeModel: "gpt-model"}, local);
  const restored = restoreAgentSelection("project", draft("one"), local);
  assert.equal(restored.runtime, "default");
  assert.equal(restored.modelSelections.agent, "minimax");
  assert.equal(restoreAgentSelection("project", draft("two"), local).runtimeModel, "gpt-model");
});

test("invalid or unavailable preference storage leaves the server conversation intact", () => {
  const saved = draft();
  assert.equal(restoreAgentSelection("project", saved, {getItem: () => "broken", setItem() {}}), saved);
  const blocked = {getItem(): string | null {throw new Error("blocked");}, setItem() {throw new Error("blocked");}};
  assert.equal(restoreAgentSelection("project", saved, blocked), saved);
  assert.doesNotThrow(() => rememberAgentSelection("project", saved, blocked));
});

test("JiuwenSwarm model selection survives refresh without changing other harness choices", () => {
  const local = storage();
  const value: Conversation = {...draft(), runtime: "jiuwenswarm", runtimeModel: "local-model#0",
    harnessModels: {jiuwenswarm: "local-model#0", codex: "gpt-model"}};
  rememberAgentSelection("project", value, local);
  const restored = restoreAgentSelection("project", draft(), local);
  assert.equal(restored.runtime, "jiuwenswarm");
  assert.equal(restored.runtimeModel, "local-model#0");
  assert.deepEqual(restored.harnessModels, value.harnessModels);
});


test("DeepSeek Harness selection and native model survive refresh", () => {
  const local = storage();
  const value: Conversation = {...draft(), runtime: "deepseek", runtimeModel: "route/model",
    harnessModels: {deepseek: "route/model", codex: "gpt-model"}};
  rememberAgentSelection("project", value, local);
  assert.deepEqual(restoreAgentSelection("project", draft(), local).harnessModels, value.harnessModels);
  assert.equal(restoreAgentSelection("project", draft(), local).runtime, "deepseek");
});
