/** Remote creation changes only the viewport; no paid generation. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
const projectId = crypto.randomUUID();
try {
  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: "project.create", payload: { name: `Viewport focus ${projectId.slice(0, 8)}` } });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.locator(".cw-chat-button").click();
  await page.locator(".cw-assistant-panel:not([hidden])").waitFor();
  headers["X-OpenDirector-Session"] = await page.evaluate(async () => (await import("/src/backend/api.ts")).sessionId);
  const create = async (x, y) => {
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
      type: "canvas.show", payload: { item: { id, projectId, kind: "image", position: { x, y },
        width: 352, height: 528, title: "Remote node", binding: { role: "empty" } } } });
    await page.locator(`.react-flow__node[data-id="${id}"]`).waitFor({ state: "attached" });
    return id;
  };
  const transform = () => page.locator(".react-flow__viewport").getAttribute("style");
  const checkCentered = async (id) => {
    await page.waitForFunction((id) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect();
      const panel = document.querySelector(".cw-assistant-panel").getBoundingClientRect();
      return node.left > 75 && node.right < panel.left - 10 && node.top > 72 && node.bottom < innerHeight - 65 &&
        Math.abs((node.left + node.right) / 2 - (80 + panel.left - 16) / 2) < 50;
    }, id);
  };
  const editor = page.locator(".cw-assistant-panel [contenteditable=true]").first();
  await editor.fill("继续创作");
  const first = await create(0, 0);
  await checkCentered(first);
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  assert.equal(await page.locator(".react-flow__node.selected").count(), 0);
  await page.screenshot({ path: "/tmp/created-node-focus.png" });
  await page.waitForTimeout(250);
  await page.mouse.move(100, 800);
  await page.mouse.down();
  const before = await transform();
  await create(5000, 5000);
  await page.waitForTimeout(300);
  assert.equal(await transform(), before, "creation must not move the viewport during a pointer gesture");
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.equal(await transform(), before, "blocked creation must not steal the view after the gesture");
  const third = await create(7000, 3000);
  await checkCentered(third);
  await page.waitForTimeout(250);
  await page.mouse.move(1000, 800);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(1100, 830, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(250);
  const navigated = await transform();
  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: 'canvas.update', payload: { itemId: third, title: 'Updated title' },
    expectedVersions: [{ objectType: 'canvas_item', id: third, revision: 1 }] });
  await page.getByText('Updated title', { exact: true }).waitFor({ state: 'attached' });
  await page.waitForTimeout(250);
  assert.equal(await transform(), navigated, 'updates to existing nodes must not undo manual navigation');
  await page.locator('.cw-workspace').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.selected').length === 3);
  const multiViewport = await transform();
  await create(9000, 9000);
  await page.waitForTimeout(300);
  assert.equal(await transform(), multiViewport, 'multi-selection must retain its view');
  assert.equal(await page.locator('.react-flow__node.selected').count(), 3);
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.deepEqual(snapshot.canvasItems.map((item) => item.position), [{ x: 0, y: 0 }, { x: 5000, y: 5000 }, { x: 7000, y: 3000 }, { x: 9000, y: 9000 }]);
  assert.equal(snapshot.jobs.length, 0);
  console.log(JSON.stringify({ passed: true, checks: ["assistant occlusion", "center origin and distant nodes", "preserve focus and selection", "respect pointer gesture and multi-selection", "unchanged authored positions"] }));
} finally {
  await browser.close();
}
