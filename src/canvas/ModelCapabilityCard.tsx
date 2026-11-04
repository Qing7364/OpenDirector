import { useState } from "react";
import { errorMessage } from "../backend/api.ts";
import {
  readModelCapabilities,
  type ModelConfigInput,
  type ModelOptions,
} from "../backend/models.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { createVideoCapabilities } from "../backend/videoCapabilities.ts";
import {
  VideoCapabilitiesEditor,
  capabilityDraft,
  type VideoCapabilityDraft,
} from "./VideoCapabilitiesEditor";

export function ModelCapabilityCard({
  modelId,
  connection,
  configId,
  saved,
  options,
  disabled,
  onChange,
  onValidity,
}: {
  modelId: string;
  connection: ModelConfigInput;
  configId?: string;
  saved?: ModelConfig;
  options: ModelOptions;
  disabled: boolean;
  onChange: (patch: ModelOptions) => void;
  onValidity: (error: string) => void;
}) {
  const [draft, setDraft] = useState(() =>
    capabilityDraft(
      saved?.videoCapabilities ?? saved?.inputRules.videoCapabilities,
      Boolean(saved?.videoCapabilities),
    ),
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const adapter =
    options.videoAdapter ??
    saved?.videoAdapter ??
    connection.videoAdapter ??
    "auto";
  const official = connection.protocol === "minimax_video_v2";
  const video =
    connection.kind === "video" &&
    !["vllm_omni_segmentation", "vllm_omni_depth"].includes(
      connection.protocol,
    );
  const updateDraft = (next: VideoCapabilityDraft, nextAdapter = adapter) => {
    setDraft(next);
    try {
      const capabilities = next.custom
        ? createVideoCapabilities(
            next.outputs,
            next.defaultResolution,
            Number(next.defaultDuration),
            next.dimensionStep,
            nextAdapter,
          )
        : null;
      onChange({ videoCapabilities: capabilities, videoAdapter: nextAdapter });
      setError("");
      onValidity("");
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message);
      onValidity(message);
    }
  };
  const load = async (source: "preset" | "service") => {
    setLoading(true);
    try {
      const result = await readModelCapabilities(
        { ...connection, modelId, videoAdapter: adapter },
        configId,
        source,
      );
      if (!result.videoCapabilities)
        throw new Error("没有可用的输出规格，请手动填写。");
      updateDraft(
        capabilityDraft(result.videoCapabilities, source === "service"),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  if (connection.kind !== "agent" && !video) return null;
  return (
    <details
      className="cw-model-capability-card"
      open={official ? true : undefined}
    >
      <summary>
        {connection.kind === "agent" ? "输入能力" : "参考与输出能力"}
      </summary>
      <fieldset disabled={disabled || loading}>
        {connection.kind === "agent" ? (
          <>
            <div className="cw-model-modalities">
              <label>
                <input type="checkbox" checked disabled />
                文本
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={
                    (
                      options.inputModalities ?? saved?.inputModalities
                    )?.includes("image") ?? false
                  }
                  onChange={(event) =>
                    onChange({
                      inputModalities: event.target.checked
                        ? ["text", "image"]
                        : ["text"],
                    })
                  }
                />
                图片理解
              </label>
            </div>
            <p className="cw-model-note">仅在该模型原生支持图片输入时启用。</p>
          </>
        ) : official ? (
          <div className="cw-model-capability-facts">
            <span>文生视频 / 首尾帧 / 多模态参考</span>
            <span>{modelId === "MiniMax-H3" ? "768P / 2K" : "480P / 768P"}</span>
            <span>{modelId === "MiniMax-H3-Max" ? "5—15 秒" : "4—15 秒"}</span>
            <small>参考：图片、视频、音频。输出包含音频。</small>
          </div>
        ) : (
          <>
            {connection.protocol === "vllm_omni" && (
              <label className="cw-domain-field">
                视频适配方式
                <select
                  value={adapter}
                  onChange={(event) =>
                    updateDraft(
                      { ...draft, custom: false },
                      event.target.value as NonNullable<
                        ModelOptions["videoAdapter"]
                      >,
                    )
                  }
                >
                  <option value="auto">自动识别</option>
                  <option value="minimax_h3">
                    MiniMax-H3（首帧、参考、接续）
                  </option>
                  <option value="fasth3">FastH3（多模态参考）</option>
                  <option value="standard">通用 /videos（单张首帧）</option>
                </select>
              </label>
            )}
            <div className="cw-capability-actions">
              <button
                type="button"
                className="cw-settings-button"
                onClick={() => void load("preset")}
              >
                载入预设
              </button>
              <button
                type="button"
                className="cw-settings-button"
                onClick={() => void load("service")}
              >
                读取服务声明
              </button>
            </div>
            <VideoCapabilitiesEditor
              value={draft}
              adapter={adapter}
              onChange={(next) => updateDraft(next)}
            />
          </>
        )}
        {error && (
          <p role="alert" className="cw-model-feedback">
            {error}
          </p>
        )}
      </fieldset>
    </details>
  );
}
