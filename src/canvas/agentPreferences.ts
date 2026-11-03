import type { Conversation } from "../backend/chat.ts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Selection = Pick<Conversation, "runtime" | "runtimeModel" | "harnessModels"> & { agent: string | null };
const prefix = "opendirector.agent-selection";
const scope = (projectId: string, conversationId?: string) => `${prefix}:${projectId}:${conversationId ?? "default"}`;

function parse(value: string | null): Selection | null {
  if (!value) return null;
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== "object" || !("runtime" in data) ||
      !(data.runtime === "default" || data.runtime === "codex" || data.runtime === "claude" || data.runtime === "opencode" || data.runtime === "jiuwenswarm" || data.runtime === "deepseek") ||
      !("runtimeModel" in data) || !(data.runtimeModel === null || typeof data.runtimeModel === "string") ||
      !("agent" in data) || !(data.agent === null || typeof data.agent === "string")) return null;
  const harnessModels: Selection["harnessModels"] = {};
  if ("harnessModels" in data && data.harnessModels && typeof data.harnessModels === "object") {
    for (const [key, model] of Object.entries(data.harnessModels)) {
      if ((key === "codex" || key === "claude" || key === "opencode" || key === "jiuwenswarm" || key === "deepseek") && (model === null || typeof model === "string")) {
        harnessModels[key] = model;
      }
    }
  }
  return {runtime: data.runtime, runtimeModel: data.runtimeModel, agent: data.agent, harnessModels};
}

export function rememberAgentSelection(projectId: string, value: Conversation, storage?: Storage) {
  try {
    const target = storage ?? window.localStorage;
    const selection: Selection = {runtime: value.runtime ?? "default", runtimeModel: value.runtimeModel ?? null,
      harnessModels: value.harnessModels ?? {}, agent: value.modelSelections.agent ?? null};
    const encoded = JSON.stringify(selection);
    target.setItem(scope(projectId, value.conversationId), encoded);
    target.setItem(prefix, encoded);
  } catch {
    // Browser preference storage is optional; the conversation draft still saves on the server.
  }
}

export function restoreAgentSelection(projectId: string, saved: Conversation, storage?: Storage): Conversation {
  try {
    const target = storage ?? window.localStorage;
    let selected = parse(target.getItem(scope(projectId, saved.conversationId)));
    if (!selected && (!saved.runtime || saved.runtime === "default") &&
        !saved.modelSelections.agent && !Object.keys(saved.harnessModels ?? {}).length) {
      selected = parse(target.getItem(prefix));
    }
    if (!selected) return saved;
    const {agent, ...runtime} = selected;
    return {...saved, ...runtime, modelSelections: {...saved.modelSelections, agent}};
  } catch {
    return saved;
  }
}
