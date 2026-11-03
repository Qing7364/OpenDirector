import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage, ChatTool } from "../backend/chat";
import { CanvasIcon } from "./CanvasIcon";

const TOOL_NAMES: Record<string, string> = {
  query: "查看工程",
  read: "读取素材或技能",
  command_schema: "查看操作说明",
  execute_command: "执行工程操作",
  read_project: "读取工程",
  read_text_asset: "读取文本",
  save_text_asset: "保存文本",
  generate_asset: "生成素材",
  get_generation_task: "查看生成进度",
  read_skill: "读取技能",
};
const STATUS = {
  running: "进行中",
  complete: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function ToolActivity({ tool }: { tool: ChatTool }) {
  const operation = tool.arguments?.type;
  return (
    <details className={`cw-chat-activity is-${tool.status}`}>
      <summary>
        <CanvasIcon
          name={tool.status === "failed" ? "close" : "sparkle"}
          size={15}
        />
        <span>{TOOL_NAMES[tool.name] ?? tool.name}{typeof operation === "string" && <code>{operation}</code>}</span>
        <small>{STATUS[tool.status]}</small>
        <CanvasIcon name="chevronRight" size={14} />
      </summary>
      <div className="cw-chat-activity-detail">
        {(tool.error || tool.message) && <p>{tool.error || tool.message}</p>}
        {tool.arguments && <details className="cw-chat-tool-data">
          <summary><CanvasIcon name="chevronRight" size={12} />调用参数</summary>
          <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
        </details>}
        {tool.result !== undefined && <details className="cw-chat-tool-data">
          <summary><CanvasIcon name="chevronRight" size={12} />返回结果{tool.resultTruncated ? "（已截断）" : ""}</summary>
          <pre>{tool.result}</pre>
          {tool.resultTruncated && <p>此处仅展示前 65,536 个字符，完整结果见本轮轨迹。</p>}
        </details>}
        {tool.taskId && (
          <p>
            任务：<code>{tool.taskId}</code>
          </p>
        )}
      </div>
    </details>
  );
}

export const AssistantReply = memo(function AssistantReply({
  message,
  thinking,
}: {
  message: ChatMessage;
  thinking: boolean;
}) {
  const [copyState, setCopyState] = useState("复制回复");
  const parts = [];
  let offset = 0;
  const markdown = (text: string, key: string) =>
    text && (
      <Streamdown
        key={key}
        className="cw-chat-markdown"
        controls={false}
        mode={message.status === "streaming" ? "streaming" : "static"}
        isAnimating={message.status === "streaming"}
      >
        {text}
      </Streamdown>
    );
  for (const tool of message.tools ?? []) {
    const end = Math.max(
      offset,
      Math.min(tool.textOffset, message.text.length),
    );
    parts.push(markdown(message.text.slice(offset, end), `text-${tool.id}`));
    parts.push(<ToolActivity key={tool.id} tool={tool} />);
    offset = end;
  }
  parts.push(markdown(message.text.slice(offset), "tail"));
  return (
    <>
      {parts}
      {message.status === "streaming" && (
        <div className="cw-chat-progress" role="status" aria-live="polite">
          <span className="cw-chat-waiting" aria-hidden="true"><i /><i /><i /></span>
          {thinking ? "正在思考…" : "正在回复…"}
        </div>
      )}
      {!message.text &&
        !message.tools?.length &&
        message.status !== "streaming" && (
          <p className="cw-chat-progress">本次回复未生成内容。</p>
        )}
      {!!message.text && message.status !== "streaming" && (
        <div className="cw-chat-message-actions">
          <button
            type="button"
            aria-label={copyState}
            title={copyState}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(message.text);
                setCopyState("已复制");
              } catch {
                setCopyState("复制失败，请选择正文复制");
              }
            }}
          >
            <CanvasIcon name="copy" size={15} />
            <span>{copyState === "已复制" ? "已复制" : "复制"}</span>
          </button>
        </div>
      )}
    </>
  );
});
