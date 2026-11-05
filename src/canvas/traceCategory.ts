/** Semantic colors are shared by every harness, independent of its event names. */
export function traceCategory(type?: string, role?: string): string {
  if (role === "system" || role === "developer" || type === "system") return "system";
  if (role === "user" || type === "user" || type === "user_message") return "user";
  if (type === "plan" || type === "context" || type === "session_meta" || type === "turn_context") return "context";
  if (type === "reasoning" || type === "model.reasoning" || type === "reasoning_summary") return "reasoning";
  if (role === "tool" || ["tool", "tool_use", "tool_result", "command_execution", "function_call", "function_call_output", "chat.tool_call", "chat.tool_result"].includes(type ?? "")) return "tool";
  if (role === "assistant" || ["assistant", "text", "agent_message", "chat.delta"].includes(type ?? "")) return "assistant";
  if (type?.startsWith("model.") || type?.startsWith("step_")) return "model";
  return "event";
}

/** Claude Code estimates expose counts, not inspectable reasoning content. */
export function isThinkingTokenEstimate(event?: { type?: string; subtype?: string }) {
  return event?.type === "system" && event.subtype === "thinking_tokens";
}

/** Remove opaque reasoning data from display copies, leaving persisted traces intact. */
export function readableTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableTraceValue).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "redacted_thinking" || record.type === "encrypted_thinking") return undefined;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(key === "signature" && record.type === "thinking") && !["encrypted_content", "encrypted_data"].includes(key))
    .map(([key, child]) => [key, readableTraceValue(child)])
    .filter(([, child]) => child !== undefined));
}
