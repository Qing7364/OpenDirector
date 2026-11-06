import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationFailure } from "../src/contracts/generated.ts";
import { generationFailureMessage } from "../src/canvas/generationFailureText.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

function failure(patch: Partial<GenerationFailure>): GenerationFailure {
  return {
    category: "input",
    stage: "submit",
    message: "生成服务拒绝了输入内容或参数。",
    suggestion: "请检查生成要求、参数和模型支持范围。",
    providerCode: null,
    requestId: null,
    httpStatus: 400,
    providerStatus: null,
    ...patch,
  };
}

test("known persisted failures are translated without showing backend Chinese", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(failure({})),
    "The generation service rejected the input or parameters.",
  );
  assert.equal(
    generationFailureMessage(failure({ message: "供应商任务已取消。" })),
    "The provider task was cancelled.",
  );
  setActiveLocale("zh-CN");
  assert.equal(
    generationFailureMessage(failure({})),
    "生成服务拒绝了输入内容或参数。",
  );
});

test("new provider messages fall back to category, stage and status", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(
      failure({ category: "authentication", message: "provider-defined text" }),
    ),
    "Generation service authentication failed. Check the API key in settings.",
  );
  assert.equal(
    generationFailureMessage(
      failure({
        category: "temporary",
        stage: "download",
        message: "new provider text",
      }),
    ),
    "The generated result could not be downloaded.",
  );
  assert.equal(
    generationFailureMessage(
      failure({
        category: "provider",
        stage: "cancel",
        httpStatus: 404,
        message: "new provider text",
      }),
    ),
    "The provider could not find this task.",
  );
  setActiveLocale("zh-CN");
});

test("submission unknown failures remain explicit", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(
      failure({
        category: "submission_unknown",
        stage: "submit",
        httpStatus: null,
        message: "生成请求的提交结果不明。",
      }),
    ),
    "The submission result is unknown. Check with the provider before retrying.",
  );
  setActiveLocale("zh-CN");
});

test("provider moderation verdicts are explained in both languages", () => {
  const moderated = (message: string) =>
    failure({ stage: "poll", httpStatus: 200, providerStatus: "failed", providerCode: "1027", message });
  setActiveLocale("en-US");
  assert.match(
    generationFailureMessage(moderated("供应商判定输入内容涉及敏感信息，已拒绝生成。")),
    /flagged the input as sensitive/,
  );
  assert.match(
    generationFailureMessage(moderated("供应商判定生成内容涉及敏感信息，已拒绝交付。")),
    /flagged the generated content as sensitive/,
  );
  setActiveLocale("zh-CN");
  assert.match(
    generationFailureMessage(moderated("供应商判定生成内容涉及敏感信息，已拒绝交付。")),
    /生成内容涉及敏感信息/,
  );
});
