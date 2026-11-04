import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS, matchingConnections, providerPresetFor } from "../src/canvas/providerPresets.ts";
import type { ModelConfig } from "../src/backend/rules.ts";

test("provider presets separate official protocol from self-hosted model names", () => {
  const official = PROVIDER_PRESETS.find((item) => item.id === "minimax-video")!;
  assert.equal(official.url, "https://api.minimax.cn/v2");
  assert.equal(official.protocol, "minimax_video_v2");
  assert.equal(official.authMode, "bearer");
  const model: ModelConfig = { ...official, id: "one", kind: "video", modelId: "MiniMax-H3", inputRules: { profile: "", allowedKinds: [], maxImages: 0, maxVideos: 0, maxAudios: 0, videoModes: [] } };
  assert.equal(providerPresetFor(model), "minimax-video");
  assert.equal(providerPresetFor({ ...model, connectionType: "self_hosted", protocol: "vllm_omni" }), "vllm-omni-video");
  assert.deepEqual(matchingConnections([{ ...model, providerId: "shared" }, { ...model, id: "two", providerId: "shared" }, { ...model, id: "three", providerId: "other" }], "video", { ...model, protocol: "minimax_video_v2", authMode: "bearer", apiKey: "" }).map((item) => item.id), ["one", "three"]);
});
