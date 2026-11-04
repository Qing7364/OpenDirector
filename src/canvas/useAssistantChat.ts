import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { rememberAgentSelection, restoreAgentSelection } from "./agentPreferences";
import { errorMessage } from "../backend/api";
import {
  conversation,
  conversations,
  activateConversation,
  type ConversationSummary,
  chatRuntimes,
  chatRuntimeStatus,
  type AgentRuntime,
  type RuntimeInfo,
  streamChat,
  stopChat,
  type ChatAsset,
  type Conversation,
} from "../backend/chat";
import { flushChatDraft, rememberChat } from "../backend/chatDrafts";
import { creationClient } from "../backend/creationClient.ts";
import { fingerprint } from "../backend/generation";
import type { BackendModels } from "../backend/models";
import { loadReferenceCatalog } from "../backend/referenceCatalog.ts";
import { isGenerationModel } from "../backend/rules";
import {
  contentText,
  referenceContent,
  referenceIds,
  type ReferenceAsset,
  type ReferenceContent,
} from "./chatReferenceContent.ts";
import type { CanvasNode } from "./model";
import { pendingCanvasReferences } from "./pendingCanvasReferences.ts";

export interface ProjectChatAsset extends ReferenceAsset {
  kind: string;
}
export const attachment = ({
  id,
  name,
  type,
  size,
  fingerprint,
}: ChatAsset): ChatAsset => ({ id, name, type, size, fingerprint });
const empty = (): Conversation => ({
  messages: [],
  draft: "",
  assets: [],
  thinking: "auto",
  modelSelections: {},
});

export function useAssistantChat(
  projectId: string,
  catalog: BackendModels,
  onTurnEnd: () => void,
) {
  const [value, setValue] = useState<Conversation>(empty);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [runtimesLoading, setRuntimesLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const [started, setStarted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [thinkingNow, setThinkingNow] = useState(false);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const switching = useRef(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const uploading = useRef(false);
  const turnId = useRef<string | null>(null);
  const retryId = useRef<string | null>(null);
  const current = useRef(value);
  current.current = value;
  // Retain metadata for editor undo after a reference is removed from the draft.
  const knownAssets = useRef(new Map<string, ReferenceAsset>());
  value.assets.forEach((asset) =>
    knownAssets.current.set(asset.id, {
      ...knownAssets.current.get(asset.id),
      ...asset,
    }),
  );
  const setContent = (
    content: ReferenceContent,
    added: ReferenceAsset[] = [],
  ) => {
    added.forEach((asset) => knownAssets.current.set(asset.id, asset));
    const assets = referenceIds(content).map((id) => {
      const asset = knownAssets.current.get(id);
      if (!asset) throw new Error("引用素材不存在，未插入。");
      return attachment(asset);
    });
    setValue((previous) => ({
      ...previous,
      draft: contentText(content),
      draftContent: content,
      skills: content.flatMap(part => part.type === "skill" ? [part.name] : []),
      assets,
    }));
  };
  const onEnd = useRef(onTurnEnd);
  onEnd.current = onTurnEnd;

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setLoaded(false);
    setRuntimes([]);
    setRuntimesLoading(true);
    setError("");
    void chatRuntimes(projectId, (available) => {
        if (!cancelled) setRuntimes(available);
      })
      .catch((reason) => {
        if (!cancelled) setError(`读取引擎失败：${errorMessage(reason)}`);
      })
      .finally(() => {
        if (!cancelled) setRuntimesLoading(false);
      });
    void Promise.all([conversation(projectId), conversations(projectId)])
      .then(([saved, list]) => {
        if (cancelled) return;
        setThreads(list.items);
        const restored = restoreAgentSelection(projectId, saved);
        setValue({
          ...restored,
          messages: saved.messages.map((message) =>
            message.status === "streaming"
              ? { ...message, status: "interrupted" }
              : message,
          ),
        });
        setLoaded(true);
      })
      .catch((reason) => {
        if (!cancelled) setError(`读取对话失败：${errorMessage(reason)}`);
      });
    return () => {
      cancelled = true;
      alive.current = false;
      controller.current?.abort();
      uploadController.current?.abort();
    };
  }, [projectId, loadAttempt]);

  useEffect(() => {
    if (loaded && !runtimesLoading && runtimes.length && value.runtime &&
        !runtimes.some((item) => item.id === value.runtime)) {
      setError("原 Agent 引擎已移除，请重新选择模型后继续。");
    }
  }, [loaded, runtimesLoading, runtimes, value.runtime]);

  useLayoutEffect(() => {
    if (loaded) rememberChat(projectId, value);
  }, [projectId, loaded, value]);
  useEffect(() => {
    if (
      !loaded ||
      !runtimes.some((item) => item.id === (value.runtime ?? "default"))
    )
      return;
    const timer = window.setTimeout(() => {
      void flushChatDraft(projectId).catch((reason) => {
        if (alive.current)
          setError(`保存草稿失败，当前内容已保留：${errorMessage(reason)}`);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [
    projectId,
    loaded,
    value.conversationId,
    value.draft,
    value.draftContent,
    value.assets,
    value.thinking,
    value.modelSelections,
    value.skills,
    value.runtime,
    value.runtimeModel,
    value.harnessModels,
    runtimes,
  ]);

  useEffect(() => {
    if (!loaded || !catalog.connected) return;
    setValue((previous) => {
      const selections = { ...previous.modelSelections };
      let changed = false;
      for (const kind of ["agent", "image", "video", "audio"] as const) {
        const options = catalog.models.filter(
          (model) => model.kind === kind && isGenerationModel(model),
        );
        if (!options.some((model) => model.id === selections[kind])) {
          const next = options[0]?.id ?? null;
          if (selections[kind] !== next) {
            selections[kind] = next;
            changed = true;
          }
        }
      }
      return changed ? { ...previous, modelSelections: selections } : previous;
    });
  }, [loaded, catalog.connected, catalog.models]);

  const agent = catalog.models.find(
    (model) =>
      model.kind === "agent" && model.id === value.modelSelections.agent,
  );
  const currentRuntime = runtimes.find(
    (item) => item.id === (value.runtime ?? "default"),
  );
  const canSend =
    currentRuntime?.status === "ready" &&
    !!currentRuntime.available &&
    (currentRuntime.modelSource === "cli" || !!agent);
  const addAssets = (assets: ChatAsset[]) => {
    assets.forEach((asset) =>
      knownAssets.current.set(asset.id, attachment(asset)),
    );
    setValue((previous) => {
      const merged = [
        ...new Map(
          [...previous.assets, ...assets.map(attachment)].map((asset) => [
            asset.id,
            asset,
          ]),
        ).values(),
      ];
      const content = referenceContent(
        previous.draft,
        merged.map((asset) => asset.id),
        merged,
        previous.draftContent,
      );
      return {
        ...previous,
        draft: contentText(content),
        draftContent: content,
        assets: referenceIds(content).map((id) => knownAssets.current.get(id)!),
      };
    });
  };
  const add = async (
    read: (signal: AbortSignal) => Promise<ReferenceAsset[]>,
    externalSignal?: AbortSignal,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) => {
    if (
      !loaded ||
      uploading.current ||
      submitting.current ||
      externalSignal?.aborted
    )
      return false;
    uploading.current = true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    externalSignal?.addEventListener("abort", cancel, { once: true });
    uploadController.current = abort;
    setAdding(true);
    setError("");
    try {
      const assets = await read(abort.signal);
      abort.signal.throwIfAborted();
      if (!alive.current) return false;
      if (
        new Set([...current.current.assets, ...assets].map((asset) => asset.id))
          .size > 64
      )
        throw new Error("每次最多添加 64 份参考素材。");
      if (commit) {
        setAdding(false);
        return await commit(assets);
      }
      addAssets(assets);
      return true;
    } catch (reason) {
      if (alive.current && !abort.signal.aborted)
        setError(errorMessage(reason));
      return false;
    } finally {
      externalSignal?.removeEventListener("abort", cancel);
      uploading.current = false;
      if (uploadController.current === abort) uploadController.current = null;
      if (alive.current) setAdding(false);
    }
  };
  const upload = (
    files: File[],
    prepare: (files: File[], signal: AbortSignal) => Promise<ReferenceAsset[]>,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) => add((signal) => prepare(files, signal), undefined, commit);
  const addNodes = (
    nodes: CanvasNode[],
    signal?: AbortSignal,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) =>
    add(
      async (signal) => {
        const invalid = pendingCanvasReferences(nodes).filter(
          (item) => item.error,
        );
        if (invalid.length)
          throw new Error(
            invalid.map((item) => `${item.title}：${item.error}`).join(" ") +
              " 整批未插入。",
          );
        {
          const client = creationClient(projectId);
          await client.refresh();
          const catalog = await loadReferenceCatalog(projectId, signal);
          const selected = nodes.flatMap((node) => {
            const assets = catalog.filter(
              (asset) => asset.nodeId === node.id && asset.available,
            );
            if (!assets.length)
              throw new Error("所选节点尚无可用素材，整批未插入。");
            return assets;
          });
          for (const asset of selected) {
            signal.throwIfAborted();
            if (
              (await fingerprint(await client.blob(asset.id))) !==
              asset.fingerprint
            )
              throw new Error("参考内容已变化，整批未插入。");
          }
          return selected;
        }
      },
      signal,
      commit,
    );

  const send = async () => {
    if (
      !loaded ||
      submitting.current ||
      uploading.current ||
      !canSend ||
      !current.current.draft.trim()
    )
      return;
    submitting.current = true;
    setSending(true);
    setStarted(false);
    setError("");
    setThinkingNow(false);
    const abort = new AbortController();
    controller.current = abort;
    const id = crypto.randomUUID();
    turnId.current = id;
    const input = current.current;
    const assistantId = crypto.randomUUID();
    try {
      await flushChatDraft(projectId);
      await streamChat(
        projectId,
        {
          id,
          conversationId: input.conversationId,
          modelId: agent?.id,
          runtime: input.runtime ?? "default",
          runtimeModel: input.runtimeModel,
          text: input.draft,
          content: input.draftContent,
          assets: input.assets.map((asset) => asset.id),
          thinking: input.thinking,
          modelSelections: input.modelSelections,
          skills: input.skills ?? [],
        },
        abort.signal,
        (event) => {
          if (!alive.current) return;
          if (event.type === "start") {
            setStarted(true);
            setValue({
              ...event.conversation,
              messages: event.conversation.messages.map((message) =>
                message.status === "streaming"
                  ? {
                      ...message,
                      id: assistantId,
                    }
                  : message,
              ),
            });
          } else if (event.type === "delta") {
            setThinkingNow(false);
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + event.text }
                  : message,
              ),
            }));
          } else if (event.type === "thinking") setThinkingNow(true);
          else if (event.type === "plan") {
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) => message.id === assistantId
                ? { ...message, plan: event.entries } : message),
            }));
          } else if (event.type === "tool") {
            setThinkingNow(false);
            const { type, ...tool } = event;
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) => {
                if (message.id !== assistantId) return message;
                const tools = [...(message.tools ?? [])];
                const index = tools.findIndex((item) => item.id === tool.id);
                if (index < 0) tools.push(tool);
                else tools[index] = tool;
                return { ...message, tools };
              }),
            }));
            if (event.status !== "running") onEnd.current();
          } else if (event.type === "end") {
            if (event.conversation) setValue(event.conversation);
            if (event.error) setError(event.error);
          }
        },
      );
    } catch (reason) {
      if (alive.current && !abort.signal.aborted)
        setError(errorMessage(reason));
    } finally {
      submitting.current = false;
      turnId.current = null;
      controller.current = null;
      if (alive.current) {
        setSending(false);
        setStarted(false);
        setStopping(false);
        setThinkingNow(false);
        onEnd.current();
      }
    }
  };
  const changeConversation = async (
    id: string = crypto.randomUUID(),
    create = false,
  ) => {
    if (!loaded || submitting.current || uploading.current || switching.current)
      return;
    switching.current = true;
    setLoaded(false);
    setError("");
    try {
      rememberChat(projectId, current.current);
      await flushChatDraft(projectId);
      const saved = restoreAgentSelection(projectId, await activateConversation(projectId, id, create));
      if (!alive.current) return;
      current.current = saved;
      rememberChat(projectId, saved);
      setValue(saved);
      retryId.current = null;
      setThinkingNow(false);
      setThreads((await conversations(projectId)).items);
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
    } finally {
      switching.current = false;
      if (alive.current) setLoaded(true);
    }
  };
  const stop = async () => {
    if (!turnId.current || stopping) return;
    setStopping(true);
    try {
      await stopChat(projectId, turnId.current);
    } catch (reason) {
      if (alive.current) {
        setError(`停止回复失败：${errorMessage(reason)}`);
        setStopping(false);
      }
    }
  };
  return {
    value,
    runtimes,
    runtimesLoading,
    refreshRuntimes: async (runtime?: AgentRuntime) => {
      if (runtime) {
        setRuntimes((items) => items.map((item) => item.id === runtime ? {...item, status: "checking"} : item));
        try {
          const status = await chatRuntimeStatus(projectId, runtime);
          if (alive.current) setRuntimes((items) => items.map((item) => item.id === runtime ? status : item));
        } catch (reason) {
          if (alive.current) setRuntimes((items) => items.map((item) => item.id === runtime ? {...item, status: "unknown"} : item));
          throw reason;
        }
        return;
      }
      await chatRuntimes(projectId, (available) => {
        if (alive.current) setRuntimes(available);
      });
    },
    setValue,
    selectAgent: (patch: Partial<Conversation>) => {
      const next = {...current.current, ...patch};
      rememberAgentSelection(projectId, next);
      current.current = next;
      rememberChat(projectId, next);
      setValue(next);
      setError("");
    },
    setContent,
    referenceAssets: [...knownAssets.current.values()],
    loaded,
    sending,
    started,
    stopping,
    thinkingNow,
    threads,
    changeConversation,
    error,
    setError,
    agent,
    canSend,
    adding,
    upload,
    addNodes,
    addAssets,
    send,
    stop,
    reload: () => setLoadAttempt((n) => n + 1),
  };
}
