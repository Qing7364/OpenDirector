import { saveChatDraft, type Conversation } from "./chat.ts";

// Only unsaved UI drafts live here; the backend owns persisted conversation state.
const latest = new Map<string, Conversation>();
const pending = new Map<string, Promise<void>>();
export function rememberChat(projectId: string, value: Conversation) {
  latest.set(projectId, value);
}
export function currentChat(projectId: string) {
  return latest.get(projectId);
}
export function flushChatDraft(projectId: string): Promise<void> {
  const value = latest.get(projectId);
  if (!value) return pending.get(projectId) ?? Promise.resolve();
  const { messages: _messages, ...draft } = value;
  const next = (pending.get(projectId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await saveChatDraft(projectId, draft);
    });
  pending.set(projectId, next);
  void next
    .finally(() => {
      if (pending.get(projectId) === next) pending.delete(projectId);
    })
    .catch(() => {});
  return next;
}
