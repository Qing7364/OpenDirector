type AcpUpdate = {
  sessionUpdate: string;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  entries?: { content: string; status: string }[];
};

type AcpRecord = {
  timestamp?: number;
  native?: {
    jsonrpc?: string;
    error?: unknown;
    result?: { stopReason?: string };
    params?: { update?: AcpUpdate };
  };
};

type DisplayRecord = {
  timestamp?: number;
  native: {
    type: string;
    part: {
      text?: string;
      tool?: string;
      reason?: string;
      state?: { status: string; input?: unknown; output?: unknown };
    };
  };
  raw: AcpRecord[];
};

function textContent(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as { type?: string; text?: string };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** Project ACP updates into trace rows while retaining their original records. */
export function normalizeDeepseekTrace(trace: string): string {
  const rows: (DisplayRecord | AcpRecord)[] = [];
  const messages = new Map<string, DisplayRecord>();
  const calls = new Map<string, DisplayRecord>();
  let plan: DisplayRecord | undefined;
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    let record: AcpRecord;
    try {
      record = JSON.parse(line) as AcpRecord;
    } catch {
      // A live snapshot may end midway through a JSONL record.
      continue;
    }
    if (!record.native?.jsonrpc) {
      rows.push(record);
      continue;
    }
    const update = record.native.params?.update;
    if (!update) {
      if (record.native.error) {
        rows.push({ timestamp: record.timestamp, native: { type: "error",
          part: { text: JSON.stringify(record.native.error) } }, raw: [record] });
      } else if (record.native.result?.stopReason) {
        rows.push({ timestamp: record.timestamp, native: { type: "step_finish",
          part: { reason: record.native.result.stopReason } }, raw: [record] });
      }
      continue;
    }
    const kind = update.sessionUpdate;
    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
      const text = textContent(update.content);
      if (!text) continue;
      const type = kind === "agent_thought_chunk" ? "reasoning" : "text";
      const identity = update.messageId ? type + ":" + update.messageId : undefined;
      const last = rows.at(-1);
      let row = identity ? messages.get(identity) :
        last && "raw" in last && last.native.type === type ? last : undefined;
      if (!row) {
        row = { timestamp: record.timestamp, native: { type, part: { text: "" } }, raw: [] };
        rows.push(row);
        if (identity) messages.set(identity, row);
      }
      row.native.part.text += text;
      row.raw.push(record);
    } else if ((kind === "tool_call" || kind === "tool_call_update") && update.toolCallId) {
      let row = calls.get(update.toolCallId);
      if (!row) {
        row = { timestamp: record.timestamp, native: { type: "tool_use",
          part: { tool: update.title ?? update.toolCallId, state: { status: "in_progress" } } }, raw: [] };
        rows.push(row);
        calls.set(update.toolCallId, row);
      }
      if (update.title !== undefined) row.native.part.tool = update.title;
      row.native.part.state = {
        ...row.native.part.state,
        status: update.status ?? row.native.part.state!.status,
        ...(update.rawInput === undefined ? {} : { input: update.rawInput }),
        ...(update.content === undefined ? {} : { output: update.content }),
        ...(update.rawOutput === undefined ? {} : { output: update.rawOutput }),
      };
      row.raw.push(record);
    } else if (kind === "plan") {
      if (!plan) {
        plan = { timestamp: record.timestamp, native: { type: "plan", part: {} }, raw: [] };
        rows.push(plan);
      }
      plan.native.part.text = (update.entries ?? []).map((entry) => entry.content + " · " + entry.status).join("\n");
      plan.raw.push(record);
    }
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}
