import assert from "node:assert/strict";
import test from "node:test";
import {chatRuntimes, type RuntimeInfo} from "../src/backend/chat.ts";

test("a slow Jiuwen probe does not hold back other harnesses", async (t) => {
  let release!: (response: Response) => void;
  let ready!: () => void;
  const slow = new Promise<Response>((resolve) => {release = resolve;});
  const codexReady = new Promise<void>((resolve) => {ready = resolve;});
  const row = (id: RuntimeInfo["id"], status: RuntimeInfo["status"]): RuntimeInfo => ({
    id, label: id, status, available: true, group: "harness", modelSource: "cli", modelOverride: true,
  });
  const initial = [row("opencode", "ready"), row("jiuwenswarm", "checking"), row("codex", "checking"), row("claude", "checking")];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("?probe=false")) return Response.json(initial);
    if (url.endsWith("/jiuwenswarm/status")) return slow;
    if (url.endsWith("/claude/status")) throw new Error("unavailable");
    assert.ok(url.endsWith("/codex/status"));
    return Response.json(row("codex", "ready"));
  });
  let latest: RuntimeInfo[] = [];
  let finished = false;
  const pending = chatRuntimes("project", (items) => {
    latest = items;
    if (items.some((item) => item.id === "codex" && item.status === "ready")) ready();
  }).then(() => {finished = true;});
  await codexReady;
  assert.equal(finished, false);
  assert.equal(latest.find((item) => item.id === "opencode")?.status, "ready");
  assert.equal(latest.find((item) => item.id === "jiuwenswarm")?.status, "checking");
  assert.equal(latest.find((item) => item.id === "codex")?.status, "ready");
  release(Response.json(row("jiuwenswarm", "ready")));
  await pending;
  assert.equal(latest.find((item) => item.id === "claude")?.status, "unknown");
});
