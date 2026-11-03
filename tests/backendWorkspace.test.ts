import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { creationClient } from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { releaseBackendProject } from "../src/backend/projects.ts";
import { invalidateCached } from "../src/backend/requestCache.ts";
import {
  cleanupUnreadableWorkspaceProjects,
  createWorkspaceProject,
  initializeWorkspace,
  openExampleWorkspaceProject,
  saveWorkspaceDocument,
  type WorkspaceProject,
} from "../src/backend/workspace.ts";
import {
  createDocument,
  createNode,
  type CanvasDocument,
} from "../src/canvas/model.ts";
import { EXAMPLE_PROJECT_TITLE } from "../src/canvas/assets.ts";

/** Entry/session orchestration; projection round-trips are exercised separately. */
function fixture(t: TestContext) {
  // Each test stands for a fresh page, whose list cache starts empty.
  invalidateCached();
  const oldFetch = globalThis.fetch;
  const descriptors = ["window", "localStorage"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const oldOpen = CreationProjection.prototype.open,
    oldSave = CreationProjection.prototype.save;
  const projects = new Map<string, WorkspaceProject>();
  const documents = new Map<string, CanvasDocument>();
  const storage = new Map<string, string>();
  const location = { pathname: "/", search: "" };
  const calls: { path: string; method: string; body?: any }[] = [];
  let occupied = false,
    offline = false,
    lease: string | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location, setInterval: () => 1, addEventListener() {} },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  CreationProjection.prototype.open = async function () {
    const doc = documents.get(this.client.id)!;
    this.baseline = structuredClone(doc);
    return structuredClone(doc);
  };
  CreationProjection.prototype.save = async function (doc) {
    assert.equal(lease, doc.id);
    documents.set(doc.id, structuredClone(doc));
    return false;
  };
  globalThis.fetch = async (url, options) => {
    const path = String(url),
      method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    assert.ok(path.startsWith("/api/creation/"), `Legacy request: ${path}`);
    if (path === "/api/creation/projects")
      return Response.json({
        projects: [...projects.values()],
        unreadable: occupied
          ? [
              {
                id: null,
                name: "Legacy",
                path: "/projects/Legacy",
                reason: "旧格式工程已保留",
              },
            ]
          : [],
        warnings: occupied ? ["旧格式工程已保留"] : [],
      });
    if (path === "/api/creation/projects/cleanup" && method === "POST") {
      occupied = false;
      return Response.json({ removed: ["Legacy"], failed: [] });
    }
    if (path.includes("/sessions/")) {
      lease = null;
      return Response.json({ ok: true });
    }
    const id = path.split("/")[4]!;
    if (method === "GET" && path === `/api/creation/projects/${id}` && documents.has(id))
      return Response.json({canvasItems: [
        ...(documents.get(id)?.nodes ?? []).map(node => ({...node, visible: true})),
        ...(documents.get(id)?.hiddenNodes ?? []).map(node => ({...node, visible: false})),
      ]});
    if (path.endsWith("/commands")) {
      if (offline) throw new TypeError("offline");
      if (
        (occupied && body.payload.name === "未命名画布") ||
        [...projects.values()].some((p) => p.name === body.payload.name)
      )
        return Response.json({ detail: "已有同名项目" }, { status: 409 });
      projects.set(id, {
        id,
        name: body.payload.name,
        path: `/projects/${body.payload.name}`,
      });
      documents.set(id, { ...createDocument(body.payload.name), id });
      return Response.json({ status: "applied", issues: [], jobIds: [] });
    }
    if (path.includes("/receipts/"))
      return Response.json({ detail: "无回执" }, { status: 404 });
    if (path.endsWith("/canvas"))
      return Response.json({
        snapshot: { project: { id }, eventCursor: 1 },
        edges: [],
      });
    if (path.endsWith("/open")) {
      lease = id;
      return Response.json({ ok: true });
    }
    return Response.json(
      {
        detail: "不支持该工程格式；旧文件不会自动转换。",
        code: "unsupported_format",
      },
      { status: 409 },
    );
  };
  t.after(async () => {
    try {
      await releaseBackendProject();
    } finally {
      for (const id of projects.keys()) creationClient(id).close();
      globalThis.fetch = oldFetch;
      CreationProjection.prototype.open = oldOpen;
      CreationProjection.prototype.save = oldSave;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    projects,
    documents,
    storage,
    location,
    calls,
    occupy: () => {
      occupied = true;
    },
    offline: () => {
      offline = true;
    },
  };
}

test("unreadable project cleanup uses the dedicated command", async (t) => {
  const f = fixture(t);
  f.occupy();
  assert.deepEqual(await cleanupUnreadableWorkspaceProjects(), {
    removed: ["Legacy"],
    failed: [],
  });
  assert.ok(
    f.calls.some(
      (call) =>
        call.path === "/api/creation/projects/cleanup" &&
        call.method === "POST",
    ),
  );
});

test("plain entry shares concurrent initialization, then rereads the saved project", async (t) => {
  const f = fixture(t);
  const first = initializeWorkspace();
  assert.equal(initializeWorkspace(), first);
  const initial = await first;
  const updated = {
    ...initial,
    nodes: [createNode("image", { x: 20, y: 40 }, { title: "保存节点" })],
  };
  await saveWorkspaceDocument(updated);
  assert.deepEqual((await initializeWorkspace()).nodes, updated.nodes);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.storage.get("opendirector.lastUnifiedFilesystemProject"),
    initial.id,
  );
});

test("explicit unsupported project links reject instead of creating or opening another project", async (t) => {
  const f = fixture(t);
  await initializeWorkspace();
  f.calls.length = 0;
  f.location.pathname = `/ai-tool/ai-canvas/${crypto.randomUUID()}`;
  await assert.rejects(initializeWorkspace(), /不支持该工程格式/);
  assert.ok(f.calls.every((call) => call.method === "GET"));
  assert.equal(f.projects.size, 1);
});

test("plain entry ignores the legacy last-project hint and preserves occupied directories", async (t) => {
  const f = fixture(t);
  f.storage.set("opendirector.lastFilesystemProject", crypto.randomUUID());
  f.occupy();
  const doc = await initializeWorkspace();
  assert.equal(doc.title, "未命名画布 (2)");
  assert.equal(f.projects.size, 1);
});

test("failed project creation leaves the existing project writable", async (t) => {
  const f = fixture(t);
  const original = await initializeWorkspace();
  await assert.rejects(
    createWorkspaceProject(original.title, crypto.randomUUID()),
    /已有同名项目/,
  );
  await saveWorkspaceDocument({ ...original, title: "仍可保存" });
  assert.equal(f.documents.get(original.id)?.title, "仍可保存");
});

test("unknown creation outcome is not retried with another project identity", async (t) => {
  const f = fixture(t);
  f.offline();
  await assert.rejects(initializeWorkspace(), /无法连接/);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
  assert.equal(f.projects.size, 0);
});

test("example opens share creation and reopen saved edits without rebuilding media", async (t) => {
  const f = fixture(t);
  let prepared = 0;
  const prepare = async () => {
    prepared++;
    return createDocument(EXAMPLE_PROJECT_TITLE);
  };
  const first = openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  assert.equal(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare),
    first,
  );
  const initial = await first;
  const edited = {
    ...initial,
    nodes: [
      createNode("text", undefined, { title: "我的修改", text: "保留内容" }),
    ],
  };
  await saveWorkspaceDocument(edited);
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.deepEqual(reopened, edited);
  assert.equal(prepared, 1);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
});

test("existing default example is opened without a stored hint or saving over it", async (t) => {
  const f = fixture(t);
  const project = await createWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    crypto.randomUUID(),
  );
  const saved = {
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    id: project.id,
    nodes: [createNode("text", undefined, { text: "现有示例的修改" })],
  };
  f.documents.set(project.id, saved);
  f.calls.length = 0;
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    async () => {
      throw new Error("不应重新生成示例");
    },
  );
  assert.deepEqual(reopened, saved);
  assert.ok(f.calls.every((call) => !call.path.endsWith("/commands")));
  assert.equal(f.projects.size, 1);
});

test("renamed examples reopen by project identity and deleted examples are recreated", async (t) => {
  const f = fixture(t);
  const prepare = async () => ({...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "保留的示例"})]});
  const initial = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  const renamed = { ...f.projects.get(initial.id)!, name: "我改过的示例" };
  f.projects.set(initial.id, renamed);
  f.documents.set(initial.id, { ...initial, title: renamed.name });
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.equal(reopened.id, initial.id);
  assert.equal(reopened.title, renamed.name);
  // The list cache still contains this row: reopening must consult the server.
  f.projects.delete(initial.id);
  f.documents.delete(initial.id);
  const replacement = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.notEqual(replacement.id, initial.id);
  assert.equal(replacement.title, EXAMPLE_PROJECT_TITLE);
  assert.equal(f.projects.size, 1);
});

test("an example created in another window is reopened after a definite name conflict", async (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  const saved = {
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    id,
    nodes: [createNode("text", undefined, { text: "另一窗口已保存" })],
  };
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    async () => {
      f.projects.set(id, {
        id,
        name: saved.title,
        path: `/projects/${saved.title}`,
      });
      f.documents.set(id, saved);
      return createDocument(EXAMPLE_PROJECT_TITLE);
    },
  );
  assert.deepEqual(reopened, saved);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
});

test("an unreadable existing example fails without creating a replacement", async (t) => {
  const f = fixture(t);
  const prepare = async () => createDocument(EXAMPLE_PROJECT_TITLE);
  await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  f.calls.length = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/creation/projects/") && !options?.method)
      return Response.json({detail: "示例无法读取"}, {status: 503});
    return fetch(url, options);
  };
  await assert.rejects(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare),
    /示例无法读取/,
  );
  assert.equal(f.projects.size, 1);
  assert.ok(f.calls.every((call) => !call.path.endsWith("/commands")));
});

test("unknown example creation is not retried with another project identity", async (t) => {
  const f = fixture(t);
  f.offline();
  await assert.rejects(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, async () =>
      createDocument(EXAMPLE_PROJECT_TITLE),
    ),
    /无法连接/,
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
  assert.equal(f.projects.size, 0);
});


test("an empty saved example creates a separate usable example without overwriting it", async (t) => {
  const f = fixture(t);
  const old = await createWorkspaceProject(EXAMPLE_PROJECT_TITLE, crypto.randomUUID());
  const original = structuredClone(f.documents.get(old.id));
  const reopened = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, async () => ({
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "示例内容"})],
  }));
  assert.notEqual(reopened.id, old.id);
  assert.equal(reopened.nodes.length, 1);
  assert.equal(reopened.title, EXAMPLE_PROJECT_TITLE + " (2)");
  assert.deepEqual(f.documents.get(old.id), original);
  assert.equal(f.projects.size, 2);
});


test("a numbered example with only hidden nodes creates a fresh example and preserves hidden content", async (t) => {
  const f = fixture(t);
  const prepare = async () => ({...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "示例"})]});
  const initial = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  const name = EXAMPLE_PROJECT_TITLE + " (9)";
  f.projects.set(initial.id, {...f.projects.get(initial.id)!, name});
  const hidden = {...initial, title: name, nodes: [], hiddenNodes: initial.nodes};
  f.documents.set(initial.id, hidden);
  const reopened = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  assert.notEqual(reopened.id, initial.id);
  assert.equal(reopened.nodes.length, 1);
  assert.deepEqual(f.documents.get(initial.id), hidden);
});
