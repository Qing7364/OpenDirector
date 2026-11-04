import { ProviderPicker } from "./ProviderPicker";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../backend/api.ts";
import {
  MODEL_KINDS,
  discoverModels,
  testAgentModel,
  type BackendModels,
  type ModelConfigInput,
  type ModelOptions,
} from "../backend/models.ts";
import {
  isSegmentationModel,
  type ModelConfig,
  type ModelKind,
} from "../backend/rules.ts";
import { ModelCapabilityCard } from "./ModelCapabilityCard";
import {
  PROVIDER_PRESETS,
  matchingConnections,
  providerPresetFor,
} from "./providerPresets";
import { CanvasIcon } from "./CanvasIcon";
import { ModelPicker, type ModelTestResult } from "./ModelPicker";

export type SettingsModelKind = Exclude<ModelKind, "vision">;
const PROTOCOLS: Record<
  SettingsModelKind,
  readonly [ModelConfigInput["protocol"], string][]
> = {
  agent: [["openai", "OpenAI 兼容接口（含 vLLM）"]],
  image: [
    ["openai", "OpenAI 兼容接口（含 vLLM-Omni Z-Image-Turbo）"],
    ["volcengine", "火山方舟 / Agent Plan"],
    ["vllm_omni_segmentation", "vLLM-Omni 分割接口（SAM 3）"],
  ],
  video: [
    ["vllm_omni", "异步 /videos 接口（含 vLLM-Omni）"],
    ["minimax_video_v2", "MiniMax 官方视频 V2"],
    ["volcengine", "火山方舟 / Agent Plan"],
    ["vllm_omni_segmentation", "vLLM-Omni 分割接口（SAM 3）"],
    ["vllm_omni_depth", "vLLM-Omni 深度接口（Video Depth Anything）"],
  ],
  audio: [
    ["openai", "OpenAI 兼容语音合成（含 vLLM-Omni TTS）"],
    ["volcengine", "火山引擎语音 / Agent Plan"],
    ["vllm_omni_music", "vLLM-Omni 音乐生成（MiniMax Music 3、YuE2）"],
    ["vllm_omni_score", "vLLM-Omni 扒谱接口（SheetSage2）"],
  ],
};

const PLACEHOLDERS: Record<ModelKind, [string, string]> = {
  agent: ["http://127.0.0.1:8100/v1", "Qwen/Qwen3-30B-A3B"],
  image: ["http://127.0.0.1:8200/v1", "Tongyi-MAI/Z-Image-Turbo"],
  video: ["http://127.0.0.1:8010/v1", "MiniMaxAI/MiniMax-H3"],
  audio: ["http://127.0.0.1:8220/v1", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"],
  vision: ["http://127.0.0.1:8230/v1", "facebook/sam3"],
};
const MUSIC_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8240/v1",
  "m-a-p/YuE2-3B",
];
const SCORE_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8260/v1",
  "m-a-p/SheetSage2",
];
const DEPTH_PLACEHOLDERS: [string, string] = [
  "http://127.0.0.1:8250/v1",
  "depth-anything/Video-Depth-Anything-Small",
];

export function ModelServiceForm({
  kind,
  existing,
  catalog,
  onClose,
}: {
  kind: SettingsModelKind;
  existing?: ModelConfig;
  catalog: BackendModels;
  onClose: () => void;
}) {
  const [connection, setConnection] = useState(existing);
  const [presetId, setPresetId] = useState(
    existing
      ? providerPresetFor(existing)
      : kind === "video"
        ? "vllm-omni-video"
        : kind === "image"
          ? "vllm-omni-image"
          : kind === "audio"
            ? "vllm-omni-speech"
            : "custom",
  );
  const [modelOptions, setModelOptions] = useState<
    Record<string, ModelOptions>
  >({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [value, setValue] = useState<ModelConfigInput>({
    kind,
    url: existing?.url ?? "",
    modelId: existing?.modelId ?? "",
    apiKey: "",
    connectionType: existing?.connectionType ?? "self_hosted",
    protocol:
      existing && isSegmentationModel(existing)
        ? "vllm_omni_segmentation"
        : (existing?.protocol ?? PROTOCOLS[kind][0][0]),
    authMode: existing?.authMode ?? "none",
    videoAdapter: existing?.videoAdapter ?? "auto",
    inputModalities:
      kind === "agent" ? (existing?.inputModalities ?? ["text"]) : undefined,
  });
  const [selectedModels, setSelectedModels] = useState<string[]>(() =>
    existing
      ? catalog.models
          .filter(
            (model) =>
              model.kind === existing.kind &&
              (existing.providerId
                ? model.providerId === existing.providerId
                : model.id === existing.id),
          )
          .map((model) => model.modelId)
      : [],
  );
  const [modelIds, setModelIds] = useState<string[]>(selectedModels);
  const [loaded, setLoaded] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(!existing);
  const locked = busy || discovering || testing;
  const segmentation = value.protocol === "vllm_omni_segmentation";
  const depth = value.protocol === "vllm_omni_depth";
  const score = value.protocol === "vllm_omni_score";
  const placeholders =
    value.protocol === "minimax_video_v2"
      ? ["https://api.minimax.cn/v2", "MiniMax-H3"]
      : value.protocol === "vllm_omni_music"
        ? MUSIC_PLACEHOLDERS
        : score
          ? SCORE_PLACEHOLDERS
          : depth
            ? DEPTH_PLACEHOLDERS
            : PLACEHOLDERS[segmentation ? "vision" : kind];
  const hasSavedKey = Boolean(
    connection &&
    connection.authMode === "bearer" &&
    connection.url === value.url.trim(),
  );
  const canFetch = Boolean(
    value.url.trim() &&
    (value.authMode === "none" || value.apiKey.trim() || hasSavedKey),
  );
  const update = (patch: Partial<ModelConfigInput>) => {
    setValue((current) => ({
      ...current,
      ...patch,
      ...(patch.protocol === "minimax_video_v2"
        ? ({
            connectionType: "api",
            authMode: "bearer",
            videoAdapter: "auto",
          } as const)
        : {}),
    }));
    if (
      patch.url !== undefined ||
      patch.apiKey !== undefined ||
      patch.protocol !== undefined ||
      patch.connectionType !== undefined ||
      patch.authMode !== undefined
    ) {
      setModelIds(selectedModels);
      setLoaded(false);
      setDiscoveryError("");
      setResults({});
    }
    if (patch.protocol !== undefined && patch.protocol !== value.protocol) {
      setModelOptions(
        Object.fromEntries(
          selectedModels.map((id) => [
            id,
            { videoAdapter: "auto", videoCapabilities: null },
          ]),
        ),
      );
      setModelErrors({});
    }
    setError("");
  };
  const loadModels = async () => {
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const result = await discoverModels(value, connection?.id);
      setModelIds(result.models);
      if (value.protocol === "minimax_video_v2" && !connection) setSelectedModels(result.models);
      setLoaded(true);
      setConnectionOpen(false);
    } catch (failure) {
      setDiscoveryError(errorMessage(failure));
    } finally {
      setDiscovering(false);
    }
  };
  const test = async (id: string) => {
    setTesting(true);
    setResults((current) => ({
      ...current,
      [id]: { status: "running", message: "测试中…" },
    }));
    try {
      const result = await testAgentModel(
        { ...value, ...modelOptions[id], modelId: id },
        connection?.id,
      );
      setResults((current) => ({
        ...current,
        [id]: {
          status: "passed",
          message: `通过 ${(result.elapsedMs / 1000).toFixed(2)} s`,
        },
      }));
    } catch (failure) {
      setResults((current) => ({
        ...current,
        [id]: { status: "failed", message: errorMessage(failure) },
      }));
    } finally {
      setTesting(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !selectedModels.length ||
      locked ||
      selectedModels.some((id) => modelErrors[id])
    )
      return;
    setBusy(true);
    setError("");
    try {
      const { inputModalities, videoAdapter, videoCapabilities, ...shared } =
        value;
      await catalog.saveMany(
        shared,
        selectedModels,
        connection?.id,
        Object.fromEntries(
          selectedModels
            .filter((id) => modelOptions[id])
            .map((id) => [id, modelOptions[id]!]),
        ),
      );
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const chooseProvider = (id: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    setPresetId(id);
    setConnection(undefined);
    const officialModels = ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"];
    setSelectedModels(id === "minimax-video" ? officialModels : []);
    setModelIds(id === "minimax-video" ? officialModels : []);
    setModelOptions({});
    setModelErrors({});
    setLoaded(false);
    setResults({});
    setDiscoveryError("");
    setError("");
    setConnectionOpen(id === "custom" || !preset || preset.connectionType === "self_hosted");
    setValue({
      kind,
      modelId: "",
      apiKey: "",
      videoAdapter: "auto",
      url: preset?.url ?? "",
      protocol: preset?.protocol ?? PROTOCOLS[kind][0][0],
      connectionType: preset?.connectionType ?? "self_hosted",
      authMode: preset?.authMode ?? "none",
    });
  };
  const reuseConnection = (model: ModelConfig) => {
    setConnection(model);
    setValue({
      kind,
      url: model.url,
      modelId: model.modelId,
      connectionType: model.connectionType,
      inputModalities: model.inputModalities,
      videoAdapter: model.videoAdapter,
      videoCapabilities: model.videoCapabilities,
      protocol: model.protocol ?? PROTOCOLS[kind][0][0],
      authMode: model.authMode ?? "bearer",
      apiKey: "",
    });
    const peers = catalog.models.filter(
      (item) =>
        item.kind === kind &&
        (model.providerId
          ? item.providerId === model.providerId
          : item.id === model.id),
    );
    setSelectedModels(peers.map((item) => item.modelId));
    setModelIds(peers.map((item) => item.modelId));
    setModelOptions({});
    setModelErrors({});
    setResults({});
    setConnectionOpen(false);
  };
  const connections = matchingConnections(catalog.models, kind, value);
  const savedModel = (id: string) =>
    catalog.models.find(
      (model) =>
        model.modelId === id &&
        connection &&
        (connection.providerId
          ? model.providerId === connection.providerId
          : model.id === connection.id),
    );
  return (
    <form
      className="cw-model-editor"
      aria-label={existing ? "编辑服务" : "添加服务"}
      autoComplete="off"
      onSubmit={(event) => void submit(event)}
      onInvalid={() => setConnectionOpen(true)}
    >
      <header className="cw-model-editor-header">
        <button
          type="button"
          className="cw-settings-button cw-settings-button-icon"
          aria-label="返回服务列表"
          onClick={onClose}
          disabled={locked}
        >
          <CanvasIcon name="back" size={18} />
        </button>
        <div>
          <h3>{existing ? "编辑服务" : "添加服务"}</h3>
          <p>{MODEL_KINDS.find((item) => item.id === kind)?.label}</p>
        </div>
      </header>
      <div className="cw-model-editor-scroll">
        <ProviderPicker
          kind={kind}
          value={presetId}
          disabled={locked}
          onChange={chooseProvider}
        />
        {!connection && connections.length > 0 && (
          <div className="cw-provider-reuse">
            <span>已有相同地址的连接</span>
            {connections.map((model) => (
              <button
                key={model.id}
                type="button"
                className="cw-settings-button"
                onClick={() => reuseConnection(model)}
              >
                复用已保存连接 · {model.modelId}
              </button>
            ))}
            <small>不复用则保存为独立连接。</small>
          </div>
        )}
        <details
          className="cw-model-connection-details"
          open={connectionOpen}
          onToggle={(event) => setConnectionOpen(event.currentTarget.open)}
        >
          <summary>
            <span>高级连接设置</span>
            <span title={value.url}>
              {connectionOpen ? "地址与鉴权" : value.url || "尚未配置"}
            </span>
            <CanvasIcon name="chevron" size={16} />
          </summary>
          <fieldset
            className="cw-model-connection"
            aria-label="连接信息"
            disabled={locked}
          >
            <label>
              服务地址（Base URL）
              <input
                type="url"
                required
                maxLength={2048}
                value={value.url}
                placeholder={placeholders[0]}
                onChange={(event) => update({ url: event.target.value })}
              />
            </label>
            <p className="cw-model-note">
              自部署服务通常填写 /v1 地址；通过 SSH 隧道连接时填写本地转发地址。
            </p>
          </fieldset>
        </details>
        <fieldset
          className="cw-model-connection cw-provider-key"
          disabled={locked}
        >
          <div className="cw-model-key-heading">
            <label htmlFor="service-api-key">API Key</label>
            <label className="cw-model-no-auth">
              <input
                type="checkbox"
                checked={value.authMode === "none"}
                onChange={(event) =>
                  update({
                    authMode: event.target.checked ? "none" : "bearer",
                  })
                }
              />
              无需密钥
            </label>
          </div>
          <div className="cw-model-key-input">
            <input
              id="service-api-key"
              type={showKey ? "text" : "password"}
              disabled={value.authMode === "none"}
              required={value.authMode === "bearer" && !hasSavedKey}
              maxLength={8192}
              value={value.authMode === "none" ? "" : value.apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                value.authMode === "none"
                  ? "此服务无需鉴权"
                  : hasSavedKey
                    ? "已保存密钥，留空保持不变"
                    : "输入服务提供的 API Key"
              }
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <button
              type="button"
              disabled={value.authMode === "none"}
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </fieldset>
        {value.protocol === "minimax_video_v2" && (
          <p className="cw-model-note">
            模型列表来自内置声明，载入不验证密钥，也不创建视频任务。
          </p>
        )}
        <ModelPicker
          modelPlaceholder={placeholders[1]}
          available={modelIds}
          selected={selectedModels}
          loaded={loaded}
          loading={discovering}
          error={discoveryError}
          disabled={locked}
          canFetch={canFetch}
          onFetch={() => void loadModels()}
          onChange={(ids) => {
            setSelectedModels(ids);
            setError("");
          }}
          onTest={kind === "agent" ? (id) => void test(id) : undefined}
          results={results}
          fetchLabel={
            value.protocol === "minimax_video_v2" ? "载入支持的模型" : undefined
          }
          renderDetails={(id) => (
            <ModelCapabilityCard
              key={`${connection?.id ?? "new"}:${value.protocol}:${id}`}
              modelId={id}
              connection={value}
              configId={connection?.id}
              saved={savedModel(id)}
              options={modelOptions[id] ?? {}}
              disabled={locked}
              onChange={(patch) =>
                setModelOptions((current) => ({
                  ...current,
                  [id]: { ...current[id], ...patch },
                }))
              }
              onValidity={(message) =>
                setModelErrors((current) => ({ ...current, [id]: message }))
              }
            />
          )}
        />
        {segmentation && (
          <p className="cw-model-note">
            分割模型用于选区、图层拆分和抠像，不参与图片或视频生成。
          </p>
        )}
        {depth && (
          <p className="cw-model-note">
            深度模型用于深度动作捕捉，不参与视频生成。
          </p>
        )}
        {score && (
          <p className="cw-model-note">
            扒谱模型把参照音乐转成乐谱，供 YuE2 参照生成，本身不生成音频。
          </p>
        )}
      </div>
      <footer className="cw-model-editor-footer">
        <div className="cw-model-save-status" role={error ? "alert" : "status"}>
          {error ||
            selectedModels.map((id) => modelErrors[id]).find(Boolean) ||
            (selectedModels.length > 200
              ? "每个服务最多启用 200 个模型"
              : selectedModels.length
                ? `将启用 ${selectedModels.length} 个模型`
                : "请选择至少一个模型")}
        </div>
        <button
          className="cw-settings-button"
          type="button"
          disabled={locked}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="cw-settings-button cw-settings-button-primary"
          type="submit"
          disabled={
            locked ||
            !canFetch ||
            !selectedModels.length ||
            selectedModels.length > 200 ||
            selectedModels.some((id) => modelErrors[id])
          }
        >
          {busy ? "保存中…" : "保存服务"}
        </button>
      </footer>
    </form>
  );
}
