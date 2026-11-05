type ContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};
type RecordValue = {
  native?: { type?: string; timestamp?: string | number; message?: { role?: string; content?: ContentBlock[] | string } };
  [key: string]: unknown;
};
type ToolRow = { native: { type: "tool_use"; part: { tool: string; state: { status: string; input?: unknown; output?: unknown } } }; callId: string };

/** Claude's outer role describes the envelope; each block supplies its display semantics. */
export function normalizeClaudeTrace(trace: string): string {
  const rows: unknown[] = [];
  const tools = new Map<string, ToolRow>();
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    let record: RecordValue;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object") continue;
    const native = record.native;
    const blocks = native?.message?.content;
    if (!Array.isArray(blocks) || !["assistant", "user"].includes(native?.type ?? "")) {
      rows.push(record);
      continue;
    }
    for (const block of blocks) {
      if (block.type === "tool_use" || block.type === "tool_result") {
        const id = block.type === "tool_use" ? block.id : block.tool_use_id;
        if (!id) { rows.push({ ...record, native: { ...native, message: { ...native?.message, content: [block] } } }); continue; }
        let row = tools.get(id);
        if (!row) {
          row = { native: { type: "tool_use", part: { tool: block.name ?? id, state: { status: "in_progress" } } }, callId: id };
          rows.push(row);
          tools.set(id, row);
        }
        if (block.type === "tool_use") {
          row.native.part.tool = block.name ?? id;
          row.native.part.state.input = block.input;
        } else {
          row.native.part.state.status = block.is_error ? "failed" : "completed";
          row.native.part.state.output = block.content;
        }
      } else if (block.type === "text" && block.text) {
        rows.push({ native: { type: "text", role: native?.message?.role ?? native?.type, part: { text: block.text } } });
      } else if (block.type === "thinking" && block.thinking) {
        rows.push({ native: { type: "reasoning", part: { text: block.thinking } } });
      } else if (block.type !== "redacted_thinking" && block.type !== "encrypted_thinking") {
        rows.push({ ...record, native: { ...native, message: { ...native?.message, content: [block] } } });
      }
    }
  }
  return rows.map(row => JSON.stringify(row)).join("\n");
}
