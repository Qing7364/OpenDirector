import "./agent-picker.css";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  runtimeModels,
  type RuntimeModel,
  type AgentRuntime,
  type Conversation,
  type RuntimeInfo,
} from "../backend/chat";
import { isGenerationModel, type ModelConfig } from "../backend/rules";
import { CanvasIcon } from "./CanvasIcon";

type Harness = Exclude<AgentRuntime, "default">;

export function AgentPicker({
  projectId,
  value,
  models,
  runtimes,
  disabled,
  initializing = false,
  onChange,
  onConfigure,
  onRefresh,
}: {
  projectId: string;
  value: Conversation;
  models: ModelConfig[];
  runtimes: RuntimeInfo[];
  disabled: boolean;
  initializing?: boolean;
  onChange: (patch: Partial<Conversation>) => void;
  onConfigure: () => void;
  onRefresh: (runtime?: AgentRuntime) => Promise<void>;
}) {
  const harnesses = runtimes.filter(
    (item): item is RuntimeInfo & { id: Harness } =>
      item.group === "harness" && item.id !== "default",
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Harness | null>(null);
  const [setup, setSetup] = useState<Harness | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [commandCopied, setCommandCopied] = useState(false);
  const [catalogs, setCatalogs] = useState<
    Partial<Record<Harness, RuntimeModel[]>>
  >({});
  const [choices, setChoices] = useState<RuntimeModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const submenu = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = models.filter(
    (item) => item.kind === "agent" && isGenerationModel(item),
  );
  const agent = options.find((item) => item.id === value.modelSelections.agent);
  function configuredModel(id: Harness) {
    return (
      options.find((item) => item.id === value.harnessModels?.[id]) ??
      agent ??
      options[0]
    );
  }
  const ready = (item: RuntimeInfo) =>
    item.status === "ready" &&
    (item.modelSource !== "settings" || options.length > 0);
  const setupSpec = harnesses.find((item) => item.id === setup);
  const reason = (item: RuntimeInfo) =>
    item.status === "checking"
      ? "检查中…"
      : item.status === "not_installed"
      ? "尚未安装"
      : item.status === "needs_login"
        ? "尚未登录"
        : item.status === "needs_configuration"
          ? "尚未配置模型"
          : item.status === "unsupported_version"
            ? "版本不支持所需协议"
            : item.status === "unknown"
              ? item.id === "jiuwenswarm"
                ? "无法读取模型目录，请检查配置"
                : "无法确认配置状态"
              : "尚未配置模型";
  const harnessDetail = (item: RuntimeInfo & { id: Harness }) =>
    !ready(item)
      ? reason(item)
      : item.modelSource === "settings"
        ? (configuredModel(item.id)?.modelId ?? "选择模型")
        : modelLabel(item.id);
  const setupCommand =
    setup === "deepseek"
      ? "dsh --profile acp"
      : setup === "jiuwenswarm"
      ? "jiuwenswarm-init"
      : setup === "codex"
        ? "codex login"
        : setup === "claude"
          ? "claude auth login"
          : "opencode";
  const setupLink =
    setup === "deepseek"
      ? "https://github.com/deepseek-ai/deepseek-harness"
      : setup === "jiuwenswarm"
      ? "https://github.com/openJiuwen-ai/jiuwenswarm"
      : setup === "codex"
        ? "https://developers.openai.com/codex/cli/"
        : setup === "claude"
          ? "https://code.claude.com/docs/en/setup"
          : "https://opencode.ai/docs/";
  const editingSpec = harnesses.find((item) => item.id === editing);
  const runtime = value.runtime ?? "default";
  const harness = harnesses.find((item) => item.id === runtime);
  const title = initializing
    ? "正在加载引擎…"
    : !runtimes.some((item) => item.id === runtime)
      ? "重新选择模型"
    : runtime === "default"
      ? (agent?.modelId ?? "选择模型")
      : harness?.modelSource === "settings"
        ? (configuredModel(harness.id)?.modelId ?? harness.label)
        : harness
          ? modelLabel(harness.id)
          : "默认模型";

  function selectedModel(id: Harness) {
    return id in (value.harnessModels ?? {})
      ? value.harnessModels?.[id]
      : id === runtime
        ? value.runtimeModel
        : null;
  }
  function modelLabel(id: Harness) {
    const selected = selectedModel(id);
    const rows = catalogs[id] ?? [];
    return selected
      ? (rows.find((item) => item.id === selected)?.label ?? selected)
      : (rows.find((item) => item.isDefault)?.label ?? "CLI 默认模型");
  }
  useEffect(() => {
    let active = true;
    for (const item of runtimes) {
      if (
        item.id === "default" ||
        item.modelSource !== "cli" ||
        item.status !== "ready" ||
        !!catalogs[item.id]
      )
        continue;
      const id = item.id;
      void runtimeModels(projectId, id)
        .then((rows) => {
          if (active) setCatalogs((previous) => ({ ...previous, [id]: rows }));
        })
        .catch(() => {
          // Discovery is optional for selection; opening the editor exposes errors and retry.
        });
    }
    return () => {
      active = false;
    };
  }, [projectId, runtimes]);
  function close() {
    setOpen(false);
    setEditing(null);
    setSetup(null);
    trigger.current?.focus();
  }
  function chooseHarness(id: Harness, override?: string | null) {
    const spec = harnesses.find((item) => item.id === id)!;
    const fromSettings = spec.modelSource === "settings";
    const modelId = configuredModel(id)?.id;
    if (fromSettings && !modelId) {
      onConfigure();
      close();
      return;
    }
    const configured = fromSettings
      ? (modelId ?? null)
      : override === undefined
        ? selectedModel(id)
        : override;
    onChange({
      runtime: id,
      ...(id === "jiuwenswarm" ? { thinking: "auto" } : {}),
      runtimeModel: fromSettings ? null : configured,
      harnessModels: { ...value.harnessModels, [id]: configured },
      ...(fromSettings
        ? { modelSelections: { ...value.modelSelections, agent: modelId } }
        : {}),
    });
    close();
  }
  function edit(id: Harness) {
    setSetup(null);
    setEditing(id);
  }
  useEffect(() => {
    if (!editing || editingSpec?.modelSource !== "cli") return;
    let active = true;
    setLoading(true);
    setChoices([]);
    setModelError("");
    runtimeModels(projectId, editing, editing === "deepseek" ? selectedModel(editing) : null)
      .then((items) => {
        if (active) {
          setChoices(items);
          setCatalogs((previous) => ({ ...previous, [editing]: items }));
        }
      })
      .catch(() => {
        if (active) setModelError("无法读取模型列表，请检查 CLI 配置后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editing, editingSpec?.modelSource, projectId, checking, value.harnessModels]);
  useEffect(() => {
    if (!open || disabled) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditing(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    if (editing)
      submenu.current
        ?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"], button:not(:disabled)',
        )
        ?.focus();
    else
      (
        menu.current?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"]',
        ) ??
        menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      )?.focus();
  }, [open, editing, setup]);
  useLayoutEffect(() => {
    if (!editing || !submenu.current || !menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    const layer = submenu.current;
    layer.style.left = `${Math.max(8, bounds.left - 310)}px`;
    layer.style.bottom = `${window.innerHeight - bounds.bottom}px`;
    layer.showPopover();
    const reposition = () => setEditing(null);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
    };
  }, [editing]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (setup) setSetup(null);
      else if (editing) setEditing(null);
      else close();
      return;
    }
    if (event.key === "ArrowLeft" && editing) {
      event.preventDefault();
      setEditing(null);
      return;
    }
    const scope = editing ? submenu.current : menu.current;
    const rows = [
      ...(scope?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
        []),
    ];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % rows.length;
    else if (event.key === "ArrowUp")
      next = (current - 1 + rows.length) % rows.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else return;
    event.preventDefault();
    rows[next]?.focus();
  }
  return (
    <div className="chat-picker cw-agent-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="chat-picker-trigger"
        disabled={disabled}
        aria-label={`Agent：${harness?.label ?? "Default"} · ${title}`}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        onClick={() => {
          setOpen(!open);
          setEditing(null);
          setSetup(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <CanvasIcon name="cube" />
        <span>{title}</span>
        <CanvasIcon name="chevron" />
      </button>
      {open && !disabled && (
        <div
          className="cw-agent-menu"
          tabIndex={-1}
          role="menu"
          aria-label="选择 Agent"
          ref={menu}
          onKeyDown={keys}
        >
          {setupSpec ? (
            <>
              <button
                type="button"
                className="cw-agent-back"
                onClick={() => setSetup(null)}
              >
                ← 返回
              </button>
              <h3>配置 {setupSpec.label}</h3>
              <p>{ready(setupSpec) ? "已就绪" : reason(setupSpec)}</p>
              <p>在启动 OpenDirector 的机器上完成配置，再重新检查。</p>
              {setupSpec.id === "jiuwenswarm" && (
                <p>配置 JiuwenSwarm 的对话模型，然后重新检查模型目录。</p>
              )}
              {setupSpec.modelSource === "settings" && setupSpec.available ? (
                <button
                  type="button"
                  className="cw-agent-configure"
                  onClick={() => {
                    close();
                    onConfigure();
                  }}
                >
                  配置对话模型
                </button>
              ) : (
                <>
                  {setupSpec.status === "not_installed" ? (
                    <a
                      className="cw-agent-guide"
                      href={setupLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看安装指南 ↗
                    </a>
                  ) : (
                    <>
                      <p>在终端执行：</p>
                      <div className="cw-agent-command">
                        <code>{setupCommand}</code>
                        <button
                          type="button"
                          className="cw-agent-command-copy"
                          aria-label={commandCopied ? "已复制" : "复制命令"}
                          title={commandCopied ? "已复制" : "复制命令"}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(setupCommand);
                              setCommandCopied(true);
                            } catch {
                              setCheckError("复制失败，请选中命令手动复制。");
                            }
                          }}
                        >
                          <CanvasIcon name={commandCopied ? "check" : "copy"} size={14} />
                          {commandCopied && <span role="status">已复制</span>}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="cw-agent-edit-actions">
                <button
                  type="button"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    setCheckError("");
                    try {
                      await onRefresh(setupSpec.id);
                    } catch {
                      setCheckError("检查失败，请确认本地服务正在运行。");
                    } finally {
                      setChecking(false);
                    }
                  }}
                >
                  {checking ? "检查中…" : "重新检查"}
                </button>
                {ready(setupSpec) && (
                  <button
                    type="button"
                    onClick={() => chooseHarness(setupSpec.id)}
                  >
                    使用 {setupSpec.label}
                  </button>
                )}
              </div>
              {checkError && <p role="alert">{checkError}</p>}
            </>
          ) : (
            <>
              <h3>Harnesses</h3>
              {harnesses.map((item) => (
                <div className="cw-agent-row" key={item.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={runtime === item.id}
                    title={
                      item.id === "jiuwenswarm"
                        ? harnessDetail(item)
                        : undefined
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" && ready(item)) {
                        event.preventDefault();
                        edit(item.id);
                      }
                    }}
                    onClick={() => {
                      if (ready(item)) chooseHarness(item.id);
                      else {
                        setEditing(null);
                        setCommandCopied(false);
                        setSetup(item.id);
                      }
                    }}
                  >
                    <CanvasIcon name="cube" />
                    <strong>{item.label}</strong>
                    <small>{harnessDetail(item)}</small>
                    {runtime === item.id && <CanvasIcon name="check" />}
                  </button>
                  {ready(item) &&
                    (item.modelSource === "settings" || item.modelOverride) && (
                      <button
                        type="button"
                        className="cw-agent-edit"
                        aria-label={`编辑 ${item.label} 模型`}
                        aria-haspopup="menu"
                        aria-expanded={editing === item.id}
                        onClick={() => edit(item.id)}
                      >
                        Edit
                      </button>
                    )}
                </div>
              ))}
              <div className="cw-agent-default">
                <h3>
                  Default <span>· OpenCode bundled</span>
                </h3>
                {options.map((item) => (
                  <div className="cw-agent-row" key={item.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        runtime === "default" && agent?.id === item.id
                      }
                      onClick={() => {
                        onChange({
                          runtime: "default",
                          runtimeModel: null,
                          modelSelections: {
                            ...value.modelSelections,
                            agent: item.id,
                          },
                        });
                        close();
                      }}
                    >
                      <CanvasIcon name="model" />
                      <strong>{item.modelId}</strong>
                      {options.some(
                        (other) =>
                          other.id !== item.id &&
                          other.modelId === item.modelId,
                      ) && <small>{new URL(item.url).host}</small>}
                      {runtime === "default" && agent?.id === item.id && (
                        <CanvasIcon name="check" />
                      )}
                    </button>
                  </div>
                ))}
                {!options.length && <p>尚未配置对话模型</p>}
                <button
                  type="button"
                  className="cw-agent-configure"
                  onClick={() => {
                    close();
                    onConfigure();
                  }}
                >
                  管理模型
                </button>
              </div>
            </>
          )}
          {editingSpec && (
            <div
              className="cw-agent-submenu"
              popover="manual"
              role="menu"
              aria-label={`${editingSpec.label} 模型`}
              ref={submenu}
            >
              <button
                type="button"
                className="cw-agent-back"
                onClick={() => setEditing(null)}
              >
                ← {editingSpec.label}
              </button>
              <h3>Models</h3>
              {editingSpec.modelSource === "settings" ? (
                options.map((item) => (
                  <div className="cw-agent-row" key={item.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        runtime === editing &&
                        configuredModel(editingSpec.id)?.id === item.id
                      }
                      onClick={() => {
                        onChange({
                          runtime: editingSpec.id,
                          runtimeModel: null,
                          harnessModels: {
                            ...value.harnessModels,
                            [editingSpec.id]: item.id,
                          },
                          modelSelections: {
                            ...value.modelSelections,
                            agent: item.id,
                          },
                        });
                        close();
                      }}
                    >
                      <strong>{item.modelId}</strong>
                      {configuredModel(editingSpec.id)?.id === item.id && (
                        <CanvasIcon name="check" />
                      )}
                    </button>
                  </div>
                ))
              ) : (
                <>
                  <div className="cw-agent-row">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={!selectedModel(editingSpec.id)}
                      onClick={() => chooseHarness(editingSpec.id, null)}
                    >
                      <strong>
                        {choices.find((item) => item.isDefault)
                          ? `跟随默认 · ${choices.find((item) => item.isDefault)!.label}`
                          : "跟随 CLI 默认模型"}
                      </strong>
                    </button>
                  </div>
                  {loading && <p role="status">正在读取模型…</p>}
                  {choices
                    .filter((item) => item.id !== "default")
                    .map((item) => (
                      <div className="cw-agent-row" key={item.id}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={
                            selectedModel(editingSpec.id) === item.id
                          }
                          onClick={() => chooseHarness(editingSpec.id, item.id)}
                        >
                          <strong>{item.label}</strong>
                          {value.harnessModels?.[editingSpec.id] ===
                            item.id && <CanvasIcon name="check" />}
                        </button>
                      </div>
                    ))}
                  {modelError && (
                    <>
                      <p role="alert">{modelError}</p>
                      <button
                        type="button"
                        className="cw-agent-configure"
                        onClick={() => setChecking((value) => !value)}
                      >
                        重试
                      </button>
                    </>
                  )}
                  {!loading && !modelError && !choices.length && (
                    <p>CLI 未提供可选模型</p>
                  )}
                </>
              )}
              <div className="cw-agent-default">
                <h3>Effort</h3>
                {(["auto", "low", "medium", "high"] as const)
                  .filter((effort) => {
                    const selected = choices.find(
                      (item) =>
                        item.id ===
                        (selectedModel(editingSpec.id) ??
                          choices.find((item) => item.isDefault)?.id),
                    );
                    return (
                      effort === "auto" ||
                      editingSpec.modelSource === "settings" ||
                      editingSpec.id === "claude" ||
                      !!selected?.efforts.includes(effort)
                    );
                  })
                  .map((effort) => (
                    <div className="cw-agent-row" key={effort}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={value.thinking === effort}
                        onClick={() => onChange({ thinking: effort })}
                      >
                        <strong>
                          {
                            {
                              auto: "Default",
                              low: "Low",
                              medium: "Medium",
                              high: "High",
                            }[effort]
                          }
                        </strong>
                        {value.thinking === effort && (
                          <CanvasIcon name="check" />
                        )}
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
