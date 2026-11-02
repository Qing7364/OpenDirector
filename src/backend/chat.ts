import type { ReferenceContent } from "../canvas/chatReferenceContent.ts";
import { headers, json, request, responseError } from "./api.ts";

export type AgentRuntime = "default" | "opencode" | "codex" | "claude";
export interface RuntimeInfo {
  id: AgentRuntime;
  label: string;
  group: "default" | "harness";
  modelSource: "settings" | "cli";
  modelOverride: boolean;
  available: boolean;
  status: "ready" | "not_installed" | "needs_login" | "unknown";
}
export interface ChatSkill {
  source?: "builtin" | "workspace" | "project";
  name: string;
  description: string;
}

export interface ChatTool {
  id: string;
  name: string;
  status: "running" | "complete" | "failed" | "interrupted";
  textOffset: number;
  error?: string | null;
  message?: string | null;
  taskId?: string | null;
  arguments?: Record<string, unknown>;
  result?: string;
  resultTruncated?: boolean;
}
export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
}
export interface ChatMessage {
  tools?: ChatTool[];
  id: string;
  role: "user" | "assistant";
  text: string;
  content?: ReferenceContent | null;
  status: "complete" | "streaming" | "stopped" | "interrupted";
  assets?: ChatAsset[];
  model?: string;
  thinking?: Thinking;
  source?: "preview" | "model";
}

export type Thinking = "auto" | "low" | "medium" | "high";
export type ModelSelections = Partial<
  Record<"agent" | "image" | "video" | "audio", string | null>
>;
export interface ChatAsset {
  id: string;
  name: string;
  type: string;
  size: number;
  fingerprint: string;
}
export interface ChatDraft {
  conversationId?: string;
  draft: string;
  draftContent?: ReferenceContent | null;
  assets: ChatAsset[];
  thinking: Thinking;
  modelSelections: ModelSelections;
  runtime?: AgentRuntime;
  runtimeModel?: string | null;
  harnessModels?: Partial<
    Record<"opencode" | "codex" | "claude", string | null>
  >;
  skills?: string[];
}
export interface Conversation extends ChatDraft {
  messages: ChatMessage[];
}

export type ChatEvent =
  | { type: "start"; conversation: Conversation }
  | { type: "thinking" }
  | ({ type: "tool" } & ChatTool)
  | { type: "delta"; text: string }
  | { type: "end"; conversation: Conversation | null; error: string | null };

export interface ChatRequest {
  conversationId?: string;
  id: string;
  modelId?: string;
  text: string;
  content?: ReferenceContent | null;
  assets: string[];
  thinking: Thinking;
  modelSelections: ModelSelections;
  runtime?: AgentRuntime;
  runtimeModel?: string | null;
  skills?: string[];
}

const path = (id: string) => `/creation/projects/${id}/assistant`;
export const conversations = (id: string) =>
  request<{ activeId: string; items: ConversationSummary[] }>(
    path(id) + "/conversations",
  );
export const activateConversation = (
  projectId: string,
  id: string,
  create = false,
) =>
  request<Conversation>(
    path(projectId) +
      (create ? "/conversations" : `/conversations/${id}/activate`),
    create ? json("POST", { id }) : json("POST", {}),
  );
export const chatRuntimes = (id: string) =>
  request<RuntimeInfo[]>(path(id) + "/runtimes");
export const conversation = (id: string) => request<Conversation>(path(id));
export const saveChatDraft = (id: string, draft: ChatDraft) =>
  request(path(id) + "/draft", json("PUT", draft));
export const chatSkills = (id: string, signal?: AbortSignal) =>
  request<ChatSkill[]>(path(id) + "/skills", { signal });
export const stopChat = (id: string, turn: string) =>
  request(path(id) + `/turns/${turn}/stop`, json("POST", {}));
export async function streamChat(
  id: string,
  value: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
) {
  const response = await fetch("/api" + path(id) + "/turns", {
    ...json("POST", value),
    headers: { ...headers, "Content-Type": "application/json" },
    signal,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("回复流不可用。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          const event = JSON.parse(frame.slice(6)) as ChatEvent;
          ended ||= event.type === "end";
          onEvent(event);
        }
      }
    }
    if (!ended) throw new Error("回复流中断，请重新读取对话。");
  } finally {
    reader.releaseLock();
  }
}

export interface RuntimeModel {
  isDefault?: boolean;
  id: string;
  label: string;
  efforts: string[];
}
export const runtimeModels = (projectId: string, runtime: AgentRuntime) =>
  request<RuntimeModel[]>(path(projectId) + `/runtimes/${runtime}/models`);
