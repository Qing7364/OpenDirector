import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage, ChatTool } from "../backend/chat";
import { CanvasIcon } from "./CanvasIcon";
import { activityProgress, replyParts, toolLabel } from "./assistantActivity.ts";

const STATUS = {
  running: "进行中",
  complete: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function ToolActivity({ tool }: { tool: ChatTool }) {
  return (
    <details className={`cw-chat-activity is-${tool.status}`}>
      <summary>
        <CanvasIcon
          name="sparkle"
          size={15}
        />
        <span>{toolLabel(tool)}</span>
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

function ToolGroup({ tools }: { tools: ChatTool[] }) {
  const [open, setOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState<number | null>(null);
  const hidden = hiddenCount ?? Math.max(0, tools.length - 50);
  const completed = tools.filter((tool) => tool.status === "complete").length;
  const failed = tools.filter((tool) => tool.status === "failed");
  const interrupted = tools.filter((tool) => tool.status === "interrupted");
  const running = tools.filter((tool) => tool.status === "running");
  return (
    <div className="cw-chat-tool-group">
      <details
        className={`cw-chat-activity${running.length ? " is-running" : ""}`}
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (next) setHiddenCount((count) => count ?? Math.max(0, tools.length - 50));
          setOpen(next);
        }}
      >
        <summary>
          <CanvasIcon name="sparkle" size={15} />
          <span>执行记录 · {tools.length} 次调用</span>
          <small>{completed}/{tools.length} 已完成{failed.length > 0 && ` · ${failed.length} 失败`}{interrupted.length > 0 && ` · ${interrupted.length} 中断`}</small>
          <CanvasIcon name="chevronRight" size={14} />
        </summary>
        {open && <div className="cw-chat-tool-group-items">
          {hidden > 0 && <button
            type="button"
            className="cw-chat-show-earlier"
            onClick={() => setHiddenCount(Math.max(0, hidden - 50))}
          >显示更早的 {Math.min(50, hidden)} 次调用</button>}
          {tools.slice(hidden).map((tool) => <ToolActivity key={tool.id} tool={tool} />)}
        </div>}
      </details>
    </div>
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
  return (
    <>
      {!!message.plan?.length && <details className="cw-chat-plan cw-chat-activity">
        <summary>
          <CanvasIcon name="sparkle" size={15} />
          <span>执行计划</span>
          <small>{message.plan.filter((step) => step.status === "completed").length}/{message.plan.length} 已完成</small>
          <CanvasIcon name="chevronRight" size={14} />
        </summary>
        <ol>{message.plan.map((step, index) => <li key={index} data-status={step.status}>
          {step.content}
        </li>)}</ol>
      </details>}
      {replyParts(message).map((part) => part.type === "text"
        ? markdown(part.text, part.id)
        : <ToolGroup key={part.id} tools={part.tools} />)}
      {message.status === "streaming" && (
        <div className="cw-chat-progress" role="status" aria-live="polite">
          <span className="cw-chat-waiting" aria-hidden="true"><i /><i /><i /></span>
          {activityProgress(message, thinking)}
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
