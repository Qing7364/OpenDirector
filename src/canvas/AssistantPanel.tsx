import { useEffect, useRef, useState } from "react";
import openDirectorLogo from "../assets/open_director_logo.png";
import type { ChatAsset, ModelSelections, Thinking } from "../backend/chat";
import { creationClient } from "../backend/creationClient.ts";
import { fingerprint } from "../backend/generation.ts";
import type { BackendModels } from "../backend/models";
import { loadReferenceCatalog } from "../backend/referenceCatalog.ts";
import "./assistant-panel.css";
import "./assistant-experience.css";
import { AttachmentStrip, AttachmentHover } from "./AssistantMedia";
import { AssistantReply } from "./AssistantReply";
import { AgentPicker } from "./AgentPicker";
import { ChoicePicker, ModelPicker } from "./AssistantPickers";
import { SkillPicker } from "./SkillPicker";
import { CanvasIcon } from "./CanvasIcon";
import {
  currentReferences,
  fingerprintMatches,
  referenceContent,
  type ReferenceAsset,
} from "./chatReferenceContent.ts";
import {
  ChatReferenceEditor,
  type ChatReferenceEditorHandle,
} from "./ChatReferenceEditor";
import { nodeReferenceAsset } from "./generationReferenceContent.ts";
import type { CanvasNode } from "./model";
import {
  pendingCanvasReferences,
  pendingReferenceInsertion,
  samePendingReferences,
} from "./pendingCanvasReferences.ts";
import { assetOptionId, referenceCandidates } from "./referenceCandidates.ts";
import { type MentionOption } from "./referenceMentions";
import { useAssistantChat } from "./useAssistantChat";
import type { AssistantLayout } from "./useAssistantLayout";
import { usePendingCanvasReferences } from "./usePendingCanvasReferences.ts";
import { useProjectMentionAssets } from "./useProjectMentionAssets";
import { useReferenceUploads } from "./useReferenceUploads.tsx";

const THINKING = [
  { id: "auto", label: "自动", description: "使用模型服务的默认思考程度" },
  { id: "low", label: "快速", description: "适合简单调整和快速问答" },
  { id: "medium", label: "标准", description: "兼顾速度与分析深度" },
  { id: "high", label: "深入", description: "适合剧本规划和复杂分析" },
];

function kindOf(asset: ChatAsset) {
  return asset.type.startsWith("image/")
    ? "image"
    : asset.type.startsWith("video/")
      ? "video"
      : asset.type.startsWith("audio/")
        ? "audio"
        : "text";
}

/** OpenDirector conversation tools in an OpenDirector floating canvas window. */
export function AssistantPanel({
  documentId,
  documentTitle,
  catalog,
  nodes,
  visibleNodes,
  selectedNodes,
  open,
  layout,
  selectionRequest,
  onClose,
  onTurnEnd,
  onModelSelections,
  onOpenSettings,
  onPrepareReferences,
}: {
  documentId: string;
  documentTitle: string;
  catalog: BackendModels;
  nodes: CanvasNode[];
  visibleNodes: CanvasNode[];
  selectedNodes: CanvasNode[];
  open: boolean;
  layout: AssistantLayout;
  selectionRequest: number;
  onClose: () => void;
  onTurnEnd: () => void;
  /** Lets the canvas default new nodes to the model this dialog is using. */
  onModelSelections?: (selections: ModelSelections) => void;
  onOpenSettings: () => void;
  onPrepareReferences: () => Promise<boolean>;
}) {
  const chat = useAssistantChat(documentId, catalog, onTurnEnd);
  const { value, setValue } = chat;
  const uploads = useReferenceUploads(documentId);
  const projectReferences = useProjectMentionAssets(documentId);
  const editor = useRef<ChatReferenceEditorHandle>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<{assetId: string; anchor: DOMRect} | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string>>(
    {},
  );
  const nearBottom = useRef(true);
  const pendingReferences = usePendingCanvasReferences(
    documentId,
    open,
    selectedNodes,
    selectionRequest,
  );
  const pending = pendingReferences.pending;
  const [checkingReferences, setCheckingReferences] = useState(false);
  const confirming = useRef<AbortController | null>(null);
  const latest = useRef({ value, selectedNodes, open });
  latest.current = { value, selectedNodes, open };
  // Keep the canvas defaulting new nodes to the model this dialog is using.
  const report = useRef(onModelSelections);
  report.current = onModelSelections;
  useEffect(() => {
    report.current?.(value.modelSelections);
  }, [value.modelSelections]);
  const locked =
    !chat.loaded ||
    chat.adding ||
    checkingReferences ||
    (chat.sending && !chat.started);
  const referenceDisabled =
    !chat.loaded || chat.adding || checkingReferences || chat.sending;
  useEffect(() => {
    if (!open || chat.sending || !value.draftContent) return;
    const content = currentReferences(
      value.draftContent,
      projectReferences.assets,
    );
    if (JSON.stringify(content) !== JSON.stringify(value.draftContent))
      chat.setContent(content, projectReferences.assets);
  }, [projectReferences.assets]);

  useEffect(() => {
    if (open && chat.loaded) editor.current?.focus();
  }, [open, chat.loaded]);
  const displayedAssets = [
    ...new Map(
      [
        ...value.assets,
        ...value.messages.flatMap((message) => message.assets ?? []),
      ].map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const previewKey = displayedAssets
    .filter((asset) => asset.type.startsWith("image/"))
    .map((asset) => `${asset.id}:${asset.fingerprint}`)
    .join("|");
  useEffect(() => {
    let active = true;
    const owned: string[] = [];
    void Promise.all(
      displayedAssets
        .filter((asset) => asset.type.startsWith("image/"))
        .map(async (asset) => {
          let url = "";
          try {
            url = await creationClient(documentId).mediaUrl(asset.id);
          } catch {
            /* The attachment remains available for removal/retry. */
          }
          return [asset.id, url] as const;
        }),
    ).then((entries) => {
      if (active) setAssetPreviews(Object.fromEntries(entries));
    });
    return () => {
      active = false;
      owned.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [documentId, previewKey]);
  useEffect(() => {
    if (nearBottom.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [value.messages, open]);
  useEffect(() => () => confirming.current?.abort(), [pending?.id]);
  const confirmPending = async (end: number) => {
    if (!pending || referenceDisabled || confirming.current) return;
    const batch = pending,
      before = latest.current.value;
    const abort = new AbortController();
    confirming.current = abort;
    const unchanged = () =>
      !abort.signal.aborted &&
      latest.current.open &&
      pendingReferences.isCurrent(batch.id) &&
      latest.current.value.draft === before.draft &&
      latest.current.value.draftContent === before.draftContent &&
      samePendingReferences(
        pendingCanvasReferences(latest.current.selectedNodes),
        batch.items,
      );
    try {
      pendingReferenceInsertion("", 0, batch.items);
      setCheckingReferences(true);
      chat.setError("");
      if (!(await onPrepareReferences()) || !unchanged()) return;
      await chat.addNodes(
        batch.items.map((item) => item.node),
        abort.signal,
        (assets) => {
          if (!unchanged()) return false;
          if (!editor.current?.insert(assets, { start: end, end }, true))
            return false;
          pendingReferences.consume(batch.id);
          return true;
        },
      );
    } catch (error) {
      if (!abort.signal.aborted && pendingReferences.isCurrent(batch.id))
        chat.setError(
          error instanceof Error ? error.message : "参考插入失败，请重试。",
        );
    } finally {
      if (confirming.current === abort) {
        confirming.current = null;
        setCheckingReferences(false);
      }
    }
  };

  const mentionOptions = open
    ? referenceCandidates(visibleNodes, []).map((option) => ({
        ...option,
        disabledReason:
          option.disabledReason ||
          (value.assets.length >= 64 &&
          !value.assets.some((asset) => option.id === assetOptionId(asset))
            ? "已达数量限制"
            : null),
      }))
    : [];
  const chooseMention = async (option: MentionOption, signal: AbortSignal) => {
    if (option.id.startsWith("node:")) {
      const node = nodes.find((item) => `node:${item.id}` === option.id);
      if (!node || !(await onPrepareReferences()) || signal.aborted)
        return null;
      let prepared: ReferenceAsset[] | null = null;
      await chat.addNodes([node], signal, (assets) => {
        prepared = assets;
        return true;
      });
      return prepared;
    }
    const asset = projectReferences.assets.find(
      (item) => assetOptionId(item) === option.id,
    );
    return asset ? [{ ...asset }] : null;
  };

  const upload = (files: File[]) =>
    chat.upload(
      files,
      uploads.prepare,
      (assets) => editor.current?.insert(assets) ?? false,
    );

  useEffect(() => {setMediaPreview(null);}, [documentId, value.conversationId, open]);
  useEffect(() => {
    const closePreview = () => setMediaPreview(null);
    window.addEventListener("resize", closePreview);
    return () => window.removeEventListener("resize", closePreview);
  }, []);
  const resolveAsset = (asset: ChatAsset) => projectReferences.assets.find(item => item.id === asset.id) ?? asset;
  function previewTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>("[data-preview-asset], [data-reference]");
    if (!element) return null;
    const assetId = element.dataset.previewAsset ?? JSON.parse(element.dataset.reference!).assetId;
    return {assetId, anchor: element.getBoundingClientRect()};
  }
  const hoveredAsset = mediaPreview && displayedAssets.find(item => item.id === mediaPreview.assetId);

  return (
    <aside
      id="canvas-assistant"
      className={`cw-assistant-panel${dragOver ? " is-drag-over" : ""}`}
      aria-label="AI 对话"
      hidden={!open}
      onScrollCapture={() => setMediaPreview(null)}
      onMouseOver={event => {const target = previewTarget(event.target); if (target) setMediaPreview(previous => previous?.assetId === target.assetId ? previous : target);}}
      onMouseOut={event => {const next = previewTarget(event.relatedTarget); if (!next) setMediaPreview(null);}}
      onFocusCapture={event => {const target = previewTarget(event.target); if (target) setMediaPreview(target);}}
      onBlurCapture={event => {if (!previewTarget(event.relatedTarget)) setMediaPreview(null);}}
      onClickCapture={event => {const target = previewTarget(event.target); if (target) setMediaPreview(target);}}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          if (mediaPreview) setMediaPreview(null);
          else onClose();
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragOver(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          void upload([...event.dataTransfer.files]);
        }
      }}
    >
      {open && mediaPreview && hoveredAsset && <AttachmentHover key={hoveredAsset.id} projectId={documentId} asset={resolveAsset(hoveredAsset)} anchor={mediaPreview.anchor} />}
      <header className="cw-assistant-header">
        <h2 title={documentTitle}>
          {value.messages.length ? "AI 对话" : "新会话"}
        </h2>
        <button
          type="button"
          className="cw-assistant-collapse"
          aria-label="收起 AI 对话"
          title="收起 AI 对话"
          aria-controls="canvas-assistant"
          aria-expanded="true"
          onClick={onClose}
        >
          <CanvasIcon name="collapse" size={18} />
        </button>
      </header>
      <div
        className="cw-assistant-log"
        role="log"
        aria-label="对话消息"
        aria-live="polite"
        ref={log}
        onScroll={(event) => {
          const el = event.currentTarget;
          nearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!value.messages.length && (
          <div className="cw-assistant-welcome">
            <div className="cw-assistant-avatar">
              <img src={openDirectorLogo} alt="" />
            </div>
            <h1>从一个想法开始</h1>
            <p>
              和 OpenDirector 一起构思你的下一部作品。
              <br />
              描述故事，或输入 @ 添加图片、视频、音频与文本参考。
            </p>
          </div>
        )}
        {value.messages.map((message) => (
          <article
            key={message.id}
            className={`cw-assistant-message is-${message.role}`}
          >
            {message.role === "assistant" && (
              <div className="cw-assistant-message-heading">
                OpenDirector
                {message.model && <small>{message.model}</small>}
              </div>
            )}
            <div className="cw-assistant-message-text">
              {message.role === "assistant" ? (
                <AssistantReply message={message} thinking={chat.thinkingNow} />
              ) : message.role === "user" &&
                (message.content || message.assets?.length) ? (
                referenceContent(
                  message.text,
                  (message.assets ?? []).map((asset) => asset.id),
                  message.assets ?? [],
                  message.content,
                ).map((part, index) =>
                  part.type === "text" ? (
                    part.text
                  ) : part.type === "skill" ? (
                    <span key={index} className="cw-chat-skill-token">/{part.name}</span>
                  ) : (
                    <span
                      key={index}
                      className="cw-chat-reference"
                      data-preview-asset={part.assetId}
                    >
                      {assetPreviews[part.assetId] ? (
                        <img src={assetPreviews[part.assetId]} alt="" />
                      ) : (
                        <CanvasIcon
                          name={kindOf(
                            message.assets?.find(
                              (asset) => asset.id === part.assetId,
                            ) ?? ({ type: "text/plain" } as ChatAsset),
                          )}
                          size={18}
                        />
                      )}
                      <span>{part.name}</span>
                    </span>
                  ),
                )
              ) : (
                message.text ||
                (message.status === "streaming"
                  ? chat.thinkingNow
                    ? "正在思考…"
                    : "正在回复…"
                  : "本次回复未生成内容。")
              )}
            </div>
            {message.role === "user" && !!message.assets?.length && <AttachmentStrip projectId={documentId} assets={message.assets.map(resolveAsset)} />}
            {(message.status === "stopped" ||
              message.status === "interrupted") && (
              <small className="cw-assistant-message-status">
                {message.status === "stopped" ? "已停止回复" : "回复已中断"}
              </small>
            )}
          </article>
        ))}
      </div>
      <div className="cw-assistant-composer-area">
        {chat.error && (
          <div className="cw-assistant-error" role="alert">
            <span>{chat.error}</span>
            {!chat.loaded && (
              <button type="button" onClick={chat.reload}>
                重新加载
              </button>
            )}
            <button
              type="button"
              aria-label="关闭助手提示"
              onClick={() => chat.setError("")}
            >
              <CanvasIcon name="close" size={14} />
            </button>
          </div>
        )}
        {!catalog.connected && (
          <div className="cw-assistant-error" role="alert">
            <span>{catalog.error || "正在连接对话服务…"}</span>
            <button type="button" onClick={() => void catalog.refresh()}>
              重新读取
            </button>
          </div>
        )}
        <form
          className="cw-assistant-composer"
          aria-label="聊天输入框"
          onSubmit={(event) => {
            event.preventDefault();
            pendingReferences.cancel();
            nearBottom.current = true;
            void chat.send();
          }}
        >
          {pending && (
            <div
              className="cw-pending-references"
              data-pending-references
              aria-label="待插入参考"
              aria-busy={checkingReferences || chat.adding}
            >
              <div className="cw-pending-reference-heading">
                <span role="status">
                  待插入 {pending.items.length} 项 ·{" "}
                  {referenceDisabled
                    ? "输入框暂不可用，请稍候"
                    : "点击正文插入，点击外部或 Esc 取消"}
                </span>
                <button
                  type="button"
                  aria-label="取消待插入参考"
                  onClick={pendingReferences.cancel}
                >
                  <CanvasIcon name="close" size={16} />
                </button>
              </div>
              <div className="cw-pending-reference-list">
                {pending.items.map((item) => (
                  <div
                    key={item.nodeId}
                    className={`cw-pending-reference${item.error ? " is-invalid" : ""}`}
                    title={item.error ?? item.title}
                  >
                    {item.thumbnail && !item.error ? (
                      <img src={item.thumbnail} alt="" />
                    ) : (
                      <CanvasIcon name={item.kind} size={20} />
                    )}
                    <span>{item.title}</span>
                    {item.error && (
                      <small className="cw-pending-reference-error">
                        {item.error}
                      </small>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <ChatReferenceEditor
            key={documentId}
            ref={editor}
            onSlashChange={setSlashQuery}
            skillsEnabled={chat.runtimes.find((item) => item.id === value.runtime)?.supportsSkills !== false}
            scope={documentId}
            value={(() => {
              const content = referenceContent(value.draft, value.assets.map(asset => asset.id), value.assets, value.draftContent);
              return value.skills?.length && !content.some(part => part.type === "skill") ? [...content, ...value.skills.map(name => ({type: "skill" as const, name}))] : content;
            })()}
            assets={chat.referenceAssets}
            previews={assetPreviews}
            options={mentionOptions}
            referencesDisabled={!open || referenceDisabled}
            disabled={locked}
            onChoose={chooseMention}
            onPasteReference={async (part, signal) => {
              if (part.binding === "asset") {
                const asset =
                  projectReferences.assets.find(
                    (asset) => asset.id === part.assetId,
                  ) ??
                  (await loadReferenceCatalog(documentId, signal)).find(
                    (asset) => asset.id === part.assetId,
                  );
                if (
                  !asset ||
                  !part.fingerprint ||
                  !fingerprintMatches(asset, part.fingerprint)
                )
                  throw new Error("固定参考素材缺失或内容已改变。");
                const blob = await creationClient(documentId).blob(asset.id);
                if (!fingerprintMatches(asset, await fingerprint(blob)))
                  throw new Error("固定参考文件已改变。");
                return [{ ...asset, binding: "asset" }];
              }
              const source = nodes.find((node) => node.id === part.nodeId);
              if (
                source &&
                part.fingerprint?.startsWith("source:") &&
                part.fingerprint !== nodeReferenceAsset(source).fingerprint
              )
                throw new Error("参考内容已变化，请重新复制。");
              const option = mentionOptions.find(
                (option) =>
                  option.id === `node:${part.nodeId}` ||
                  option.id ===
                    assetOptionId({
                      id: part.assetId,
                      nodeId: part.nodeId ?? undefined,
                      sourceRole: part.sourceRole,
                    }),
              );
              if (!option && !part.assetId.startsWith("node:")) {
                const inventory = await loadReferenceCatalog(
                  documentId,
                  signal,
                );
                const asset = inventory.find(
                  (asset) =>
                    asset.available &&
                    (part.nodeId
                      ? asset.nodeId === part.nodeId &&
                        asset.sourceRole === part.sourceRole
                      : asset.id === part.assetId),
                );
                if (asset) {
                  const bytes = await creationClient(documentId).blob(asset.id);
                  if (!fingerprintMatches(asset, await fingerprint(bytes)))
                    throw new Error("参考文件已改变。");
                  return [asset];
                }
              }
              if (!option || option.disabledReason)
                throw new Error(
                  option?.disabledReason ||
                    "当前输入不支持此参考版本，整批未插入。",
                );
              return (await chooseMention(option, signal)) ?? [];
            }}
            onOpen={projectReferences.load}
            loading={projectReferences.loading}
            loadError={projectReferences.error}
            onConfirmPending={
              pending ? (at) => void confirmPending(at.end) : undefined
            }
            onChange={chat.setContent}
            onPasteFiles={(files) => void upload(files)}
            onSubmit={() => {
              nearBottom.current = true;
              pendingReferences.cancel();
              void chat.send();
            }}
          />
          <AttachmentStrip projectId={documentId} assets={value.assets.map(resolveAsset)} />
          <div className="cw-assistant-toolbar">
            <button
              type="button"
              className="cw-assistant-icon-button"
              aria-label="上传参考"
              title="上传图片、视频、音频或文本"
              disabled={referenceDisabled || value.assets.length >= 64}
              onClick={() => fileInput.current?.click()}
            >
              <span className="cw-assistant-symbol cw-assistant-symbol-plus" aria-hidden="true">+</span>
            </button>
            <button
              type="button"
              className="cw-assistant-icon-button"
              aria-label="引用项目素材"
              title="引用项目素材（@）"
              disabled={referenceDisabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor.current?.openPicker()}
            >
              <span className="cw-assistant-symbol cw-assistant-symbol-at" aria-hidden="true">@</span>
            </button>
            <AgentPicker
              projectId={documentId}
              value={value}
              models={catalog.models}
              runtimes={chat.runtimes}
              onRefresh={chat.refreshRuntimes}
              disabled={!chat.loaded || chat.sending}
              initializing={!chat.loaded || !chat.runtimes.length}
              onChange={chat.selectAgent}
              onConfigure={onOpenSettings}
            />
            <SkillPicker
              projectId={documentId}
              selected={value.skills ?? []}
              slashQuery={slashQuery}
              disabled={referenceDisabled || chat.sending || chat.runtimes.find((item) => item.id === value.runtime)?.supportsSkills === false}
              onChange={(skills, fromSlash) => editor.current?.setSkill(skills[0] ?? null, fromSlash)}
            />
            <ModelPicker
              includeAgent={false}
              models={catalog.models}
              selections={value.modelSelections}
              disabled={!chat.loaded || !catalog.connected || chat.sending}
              onChange={(kind, id) =>
                setValue((previous) => ({
                  ...previous,
                  modelSelections: { ...previous.modelSelections, [kind]: id },
                }))
              }
              onConfigure={onOpenSettings}
            />
            <div className="cw-assistant-toolbar-spacer" />
            <ChoicePicker
              label="思考程度"
              icon="thinking"
              options={THINKING}
              value={value.thinking}
              disabled={!chat.loaded || chat.sending}
              onChange={(thinking) =>
                setValue((previous) => ({
                  ...previous,
                  thinking: thinking as Thinking,
                }))
              }
            />
            {chat.sending ? (
              <button
                type="button"
                className="cw-assistant-send"
                aria-label="停止回复"
                title="停止回复"
                disabled={!chat.started || chat.stopping}
                onClick={() => void chat.stop()}
              >
                <CanvasIcon name="stop" size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className="cw-assistant-send"
                aria-label="发送消息"
                title="发送消息"
                disabled={!chat.canSend || locked || !value.draft.trim()}
              >
                <CanvasIcon name="arrow" size={19} />
              </button>
            )}
          </div>
        </form>
        <p className="cw-assistant-footnote">
          {!chat.loaded ? (
            chat.error ? "对话加载失败" : "正在加载对话…"
          ) : chat.runtimes.find((item) => item.id === (value.runtime ?? "default"))?.status === "checking" ? (
            "正在检查当前引擎…"
          ) : chat.adding ? (
            "正在添加参考素材…"
          ) : (
            `${chat.runtimes.find((item) => item.id === (value.runtime ?? "default"))?.label ?? "请选择 Agent"}`
          )}
        </p>
      </div>
      {!layout.mobile && (
        <div
          className="cw-assistant-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整 AI 对话宽度"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={layout.maxWidth}
          aria-valuenow={layout.width}
          aria-valuetext={`${Math.round(layout.width)} 像素；缩至 200 像素收起`}
          title="拖动调整宽度，双击恢复默认宽度"
          {...layout.resizer}
        />
      )}
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        multiple
        accept="image/*,video/*,audio/*,text/*,.md,.markdown,.txt"
        aria-label="选择对话参考文件"
        onChange={(event) => {
          if (event.target.files?.length) void upload([...event.target.files]);
          event.target.value = "";
        }}
      />
      {dragOver && (
        <div className="cw-assistant-drop">
          <CanvasIcon name="upload" size={28} />
          <span>松开以添加参考素材</span>
        </div>
      )}
      {uploads.dialog}
    </aside>
  );
}
