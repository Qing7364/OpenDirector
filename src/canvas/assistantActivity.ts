import type { ChatMessage, ChatTool } from "../backend/chat.ts";

const TOOL_NAMES: Record<string, string> = {
  query: "查询工程",
  read: "读取素材或技能",
  command_schema: "查看操作说明",
  execute_command: "执行工程操作",
  read_project: "读取工程",
  read_canvas_item: "查看画布状态",
  preview_asset: "预览素材",
  read_text_asset: "读取文本",
  save_text_asset: "保存文本",
  generate_asset: "生成素材",
  get_generation_task: "查看生成进度",
  read_skill: "读取技能",
  bash: "运行命令",
  web_search: "搜索网页",
  web_fetch: "读取网页",
};

export function toolLabel(tool: ChatTool): string {
  const operation = tool.arguments?.type;
  const name = TOOL_NAMES[tool.name] ?? tool.name;
  return typeof operation === "string" ? `${name} ${operation}` : name;
}

export type ReplyPart =
  | { type: "text"; id: string; text: string }
  | { type: "tools"; id: string; tools: ChatTool[] };

export function replyParts(message: Pick<ChatMessage, "text" | "tools">): ReplyPart[] {
  // The backend records textOffset in Unicode code points, as Python len does.
  const text = Array.from(message.text);
  const parts: ReplyPart[] = [];
  let offset = 0;
  for (const tool of message.tools ?? []) {
    const end = Math.max(offset, Math.min(tool.textOffset, text.length));
    if (end > offset) {
      parts.push({ type: "text", id: `text-${tool.id}`, text: text.slice(offset, end).join("") });
    }
    const previous = parts.at(-1);
    if (previous?.type === "tools") previous.tools.push(tool);
    else parts.push({ type: "tools", id: tool.id, tools: [tool] });
    offset = end;
  }
  if (offset < text.length) parts.push({ type: "text", id: "tail", text: text.slice(offset).join("") });
  return parts;
}

export function activityProgress(message: ChatMessage, thinking: boolean): string {
  const running = message.tools?.filter((tool) => tool.status === "running") ?? [];
  if (running.length) {
    return `正在执行：${toolLabel(running.at(-1)!)}${running.length > 1 ? `（${running.length} 项进行中）` : ""}`;
  }
  if (thinking) return "正在思考…";
  const step = message.plan?.find((entry) => entry.status === "in_progress");
  return step ? `正在执行计划：${step.content}` : "正在回复…";
}
