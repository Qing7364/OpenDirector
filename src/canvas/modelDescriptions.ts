const MINIMAX_DESCRIPTIONS: Record<string, string> = {
  "MiniMax-H3": "高品质视频创作",
  "MiniMax-H3-Highspeed": "兼顾生成质量与速度",
  "MiniMax-H3-Lite": "轻量版本",
  "MiniMax-H3-Max": "极速生成",
};

export function modelDescription(model: { protocol?: string | null; modelId: string }) {
  return model.protocol === "minimax_video_v2" ? MINIMAX_DESCRIPTIONS[model.modelId] : undefined;
}
