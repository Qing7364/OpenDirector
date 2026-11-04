import type { ModelConfigInput } from "../backend/models.ts";
import type { ModelConfig, ModelKind } from "../backend/rules.ts";

export interface ProviderPreset {
  id: string;
  name: string;
  logoOrganization?: string;
  group?: string;
  optionLabel?: string;
  kinds: ModelKind[];
  url: string;
  protocol: ModelConfigInput["protocol"];
  connectionType: ModelConfigInput["connectionType"];
  authMode: ModelConfigInput["authMode"];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "custom",
    name: "OpenAI 兼容",
    logoOrganization: "openai",
    kinds: ["agent", "image", "audio"],
    url: "https://api.openai.com/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },

  {
    id: "minimax-agent",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax (minimax.cn)",
    kinds: ["agent"],
    url: "https://api.minimax.cn/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "minimax-video",
    logoOrganization: "MiniMaxAI",
    name: "MiniMax 官方视频",
    kinds: ["video"],
    url: "https://api.minimax.cn/v2",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
  },
  {
    id: "deepseek",
    logoOrganization: "deepseek-ai",
    name: "DeepSeek",
    kinds: ["agent"],
    url: "https://api.deepseek.com/v1",
    protocol: "openai",
    connectionType: "api",
    authMode: "bearer",
  },

  {
    id: "ark",
    logoOrganization: "ByteDance-Seed",
    name: "火山方舟 / Agent Plan",
    kinds: ["image", "video", "audio"],
    url: "https://ark.cn-beijing.volces.com/api/plan/v3",
    protocol: "volcengine",
    connectionType: "api",
    authMode: "bearer",
  },
  ...(
    [
      ["vllm-omni-image", "vLLM-Omni 图片接口", "openai", ["image"]],
      ["vllm-omni-speech", "vLLM-Omni 语音合成接口", "openai", ["audio"]],
      [
        "vllm-omni-music",
        "vLLM-Omni 音乐生成接口",
        "vllm_omni_music",
        ["audio"],
      ],
      ["vllm-omni-score", "vLLM-Omni 扒谱接口", "vllm_omni_score", ["audio"]],
      ["vllm-omni-video", "vLLM-Omni 视频接口", "vllm_omni", ["video"]],
      [
        "vllm-omni-segmentation",
        "vLLM-Omni 分割接口",
        "vllm_omni_segmentation",
        ["image", "video", "vision"],
      ],
      ["vllm-omni-depth", "vLLM-Omni 深度接口", "vllm_omni_depth", ["video"]],
    ] as const
  ).map(([id, name, protocol, kinds]) => ({
    id,
    name,
    group: "vLLM-Omni",
    optionLabel: name.replace("vLLM-Omni ", ""),
    protocol,
    kinds: [...kinds],
    url: "",
    connectionType: "self_hosted" as const,
    authMode: "none" as const,
  })),
];

export function providerPresetFor(model: ModelConfig): string {
  const explicit = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "api" &&
      preset.protocol !== "openai" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (explicit) return explicit.id;
  const deployed = PROVIDER_PRESETS.find(
    (preset) =>
      preset.connectionType === "self_hosted" &&
      preset.protocol === model.protocol &&
      preset.kinds.includes(model.kind),
  );
  if (deployed && model.connectionType === "self_hosted") return deployed.id;
  if (model.connectionType === "self_hosted") return "custom";
  return (
    PROVIDER_PRESETS.find(
      (preset) =>
        preset.kinds.includes(model.kind) &&
        preset.protocol === model.protocol &&
        preset.url === model.url.replace(/\/+$/, ""),
    )?.id ?? "custom"
  );
}

export function providerOptions(
  kind: ModelKind,
): Pick<
  ProviderPreset,
  "id" | "name" | "logoOrganization" | "group" | "optionLabel"
>[] {
  return PROVIDER_PRESETS.filter((preset) => preset.kinds.includes(kind)).map(
    (preset) => ({
      ...preset,
      group: preset.group === "vLLM-Omni" ? "vLLM-Omni 兼容" : "自定义 API",
    }),
  );
}

export function providerLabel(model: ModelConfig) {
  return (
    providerOptions(model.kind).find(
      (item) => item.id === providerPresetFor(model),
    )?.name ?? "未预设服务"
  );
}

export function matchingConnections(
  models: ModelConfig[],
  kind: ModelKind,
  value: ModelConfigInput,
): ModelConfig[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const id = model.providerId ?? model.id;
    if (
      model.kind !== kind ||
      model.protocol !== value.protocol ||
      model.url.replace(/\/+$/, "") !== value.url.replace(/\/+$/, "") ||
      seen.has(id)
    )
      return false;
    seen.add(id);
    return true;
  });
}
