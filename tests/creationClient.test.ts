import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProjectSnapshot,
  ObjectVersion,
  CanvasItem,
  TextGenerationSpec,
  Asset,
  Reference,
} from "../src/contracts/generated.ts";
import {
  CreationClient,
  assetReference,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";

function empty(): ProjectSnapshot {
  return {
    format: "opendirector-project",
    formatVersion: 2,
    project: { id: crypto.randomUUID(), name: "Test", revision: 1 },
    assets: [],
    generationSpecs: [],
    references: [],
    canvasItems: [],
    editorDocuments: [],
    jobs: [],
    results: [],
    eventCursor: 1,
    undoClearedThrough: 0,
  };
}

test("a lost command response resolves its original receipt without issuing another command", async () => {
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const seen: string[] = [];
  let receipt: unknown;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    seen.push(path);
    if (path.endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      receipt = {
        commandId: body.commandId,
        projectId: body.projectId,
        inputFingerprint: "a".repeat(64),
        status: "noop",
        changed: [],
        jobIds: [],
        issues: [],
        eventCursor: 1,
      };
      throw new TypeError("response lost after server commit");
    }
    if (path.includes("/receipts/")) return Response.json(receipt);
    return Response.json({ snapshot, edges: [] });
  };
  try {
    const result = await client.command("canvas.move", {
      items: [{ itemId: crypto.randomUUID(), position: { x: 1, y: 2 } }],
    });
    assert.equal(result.status, "noop");
    assert.equal(seen.filter((path) => path.endsWith("/commands")).length, 1);
    assert.equal(seen.filter((path) => path.includes("/receipts/")).length, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("out of order refresh responses cannot roll back a newer snapshot or edge evidence", async () => {
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install({ ...snapshot, eventCursor: 5 });
  client.referenceStates.set("edge", "used");
  globalThis.fetch = async () =>
    Response.json({
      snapshot: { ...snapshot, eventCursor: 3 },
      edges: [{ referenceId: "edge", state: "pending" }],
    });
  try {
    await client.refresh();
    assert.equal(client.snapshot.eventCursor, 5);
    assert.equal(client.referenceStates.get("edge"), "used");
    assert.throws(
      () =>
        client.install({
          ...snapshot,
          project: { ...snapshot.project, id: crypto.randomUUID() },
        }),
      /身份/,
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("an unresolved generation delivery survives reload and replays its original body before another attempt", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const submitted: Record<string, any>[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      submitted.push(body);
      if (submitted.length === 1)
        throw new TypeError("response and receipt not yet available");
      return Response.json({
        commandId: body.commandId,
        projectId: body.projectId,
        inputFingerprint: "a".repeat(64),
        status: "accepted",
        changed: [],
        jobIds: [crypto.randomUUID()],
        issues: [],
        eventCursor: 1,
      });
    }
    if (path.includes("/receipts/"))
      return Response.json({ detail: "not committed yet" }, { status: 404 });
    return Response.json({ snapshot, edges: [] });
  };
  const specId = crypto.randomUUID();
  try {
    await assert.rejects(
      client.command("generation.submit", { specId, expectedSpecRevision: 1 }),
    );
    const reopened = new CreationClient(snapshot.project.id);
    reopened.install(snapshot);
    await reopened.command("generation.submit", {
      specId,
      expectedSpecRevision: 2,
    });
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(submitted[1]!.payload.expectedSpecRevision, 1);
    assert.equal(saved.size, 0);
  } finally {
    globalThis.fetch = fetch;
    if (previousStorage)
      Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("an accepted command whose snapshot refresh fails retains its original delivery", async () => {
  const previousFetch = globalThis.fetch;
  const snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const submitted: Record<string, any>[] = [];
  let refreshes = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      submitted.push(body);
      return Response.json({
        commandId: body.commandId,
        projectId: body.projectId,
        status: "accepted",
        inputFingerprint: "a".repeat(64),
        changed: [],
        jobIds: [crypto.randomUUID()],
        issues: [],
        eventCursor: 1,
      });
    }
    if (++refreshes === 1)
      throw new TypeError("connection lost after accepted reply");
    return Response.json({ snapshot, edges: [] });
  };
  const specId = crypto.randomUUID();
  try {
    await assert.rejects(
      client.command("generation.submit", { specId, expectedSpecRevision: 1 }),
    );
    await client.command("generation.submit", {
      specId,
      expectedSpecRevision: 2,
    });
    assert.deepEqual(submitted[0], submitted[1]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

class CommandCapture extends CreationClient {
  override async textContent() {
    return "Actual source";
  }
  batches: {
    operations: CreationOperation[];
    versions: readonly ObjectVersion[];
  }[] = [];
  override async batch(
    operations: CreationOperation[],
    versions: readonly ObjectVersion[],
  ) {
    this.batches.push({ operations, versions });
    return undefined;
  }
  override async view() {
    return {
      projectId: this.id,
      clientId: crypto.randomUUID(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedItemIds: [],
      activeEditorId: null,
      playheads: [],
      generationCounts: {},
    };
  }
}

test("edited projections retain their original revision basis and emit semantic operations only", async () => {
  const snapshot = empty(),
    node = createNode("text");
  const spec: TextGenerationSpec = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    purpose: "draft",
    prompt: "",
    promptContent: null,
    modelConfigId: null,
    currentResultId: null,
    parameters: { thinking: "auto", maxTokens: 8192 },
  };
  const item: CanvasItem = {
    id: node.id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    title: node.data.title,
    position: node.position,
    width: node.width,
    height: node.height,
    locked: false,
    visible: true,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: {
      role: "empty",
      draftSpec: { objectType: "generation_spec", id: spec.id },
      manualText: null,
    },
  };
  const basis = { ...snapshot, canvasItems: [item], generationSpecs: [spec] };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const projection = new CreationProjection(client);
  const document = { ...createDocument(), id: client.id, nodes: [node] };
  projection.baseline = document;
  projection.basis = basis;
  client.install({
    ...basis,
    eventCursor: 2,
    canvasItems: [{ ...item, revision: 2, title: "Another actor changed it" }],
  });
  await projection.save({
    ...document,
    nodes: [{ ...node, position: { x: 100, y: 25 } }],
  });
  const batch = client.batches[0]!;
  assert.deepEqual(
    batch.operations.map((op) => op.type),
    ["canvas.move"],
  );
  assert.equal(batch.versions[0]!.revision, 1); // A stale form never acquires revision 2 silently.
  assert.ok(!JSON.stringify(batch).includes("Another actor changed it"));
});

test("reference replacement and hiding preserve the intended project relationships", async () => {
  const snapshot = empty(),
    source = createNode("text", undefined, { text: "Actual source" }),
    target = createNode("text");
  const asset: Asset = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    name: "A.md",
    fingerprint: `sha256:${"a".repeat(64)}`,
    path: "",
    metadata: {
      mimeType: "text/markdown",
      size: 13,
      width: null,
      height: null,
      durationSeconds: null,
      frameRate: null,
      hasAudio: null,
      sampleRate: null,
      channels: null,
    },
    provenance: {
      source: "manual",
      jobId: null,
      editorDocumentId: null,
      editorRevision: null,
      sources: [],
      inputFingerprint: null,
      agentRunId: null,
      modelSnapshot: null,
      prompt: null,
    },
  };
  const spec: TextGenerationSpec = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    purpose: "generation",
    prompt: "",
    promptContent: null,
    modelConfigId: null,
    currentResultId: null,
    parameters: { thinking: "auto", maxTokens: 8192 },
  };
  const makeItem = (
    node: typeof source,
    binding: CanvasItem["binding"],
  ): CanvasItem =>
    ({
      id: node.id,
      projectId: snapshot.project.id,
      revision: 1,
      kind: "text",
      title: node.data.title,
      position: node.position,
      width: node.width,
      height: node.height,
      zIndex: 0,
      locked: false,
      visible: true,
      parentId: null,
      tags: [],
      editors: [],
      binding,
    }) as CanvasItem;
  const ref: Reference = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    active: true,
    order: 0,
    role: "reference",
    binding: "follow_current",
    source: { objectType: "canvas_item", id: source.id },
    targetSpecId: spec.id,
  };
  const basis = {
    ...snapshot,
    assets: [asset],
    generationSpecs: [spec],
    references: [ref],
    canvasItems: [
      makeItem(source, { role: "material", objectRef: assetReference(asset) }),
      makeItem(target, {
        role: "generation",
        objectRef: { objectType: "generation_spec", id: spec.id },
        materialOverride: null,
      }),
    ],
  };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const projection = new CreationProjection(client),
    document = {
      ...createDocument(),
      id: client.id,
      nodes: [source, target],
      edges: [{ id: ref.id, source: source.id, target: target.id }],
    };
  projection.baseline = document;
  projection.basis = basis;
  // Removing a mention and re-adding the same source before autosave creates a
  // new local relation. The server must remove the old one before accepting it.
  const replacementId = crypto.randomUUID();
  const { generationContentPatch } =
    await import("../src/canvas/generationReferenceContent.ts");
  const replacement = generationContentPatch([
    { type: "text", text: "Based on " },
    {
      type: "reference",
      assetId: `node:${source.id}`,
      nodeId: source.id,
      referenceId: replacementId,
      name: source.data.title,
      fingerprint: null,
    },
  ]);
  await projection.save({
    ...document,
    nodes: [source, { ...target, data: { ...target.data, ...replacement } }],
    edges: [{ id: replacementId, source: source.id, target: target.id }],
  });
  const operations = client.batches[0]!.operations;
  const removeIndex = operations.findIndex(
    (op) => op.type === "reference.remove" && op.payload.referenceId === ref.id,
  );
  const addIndex = operations.findIndex(
    (op) =>
      op.type === "reference.add" && op.payload.reference.id === replacementId,
  );
  assert.ok(removeIndex >= 0 && addIndex > removeIndex);
  const update = operations.find(
    (op) => op.type === "generationSpec.setPrompt",
  );
  assert.ok(update?.type === "generationSpec.setPrompt");
  assert.deepEqual(update.payload.promptContent, [
    { type: "text", text: "Based on " },
    { type: "reference", referenceId: replacementId },
  ]);
  assert.ok(
    client.batches[0]!.versions.some(
      (version) => version.objectType === "reference" && version.id === ref.id,
    ),
  );
  projection.baseline = document;
  projection.basis = basis;
  client.batches = [];
  await projection.save({ ...document, nodes: [target], edges: [] });
  assert.deepEqual(
    client.batches[0]!.operations.map((op) => op.type),
    ["canvas.hide"],
  );
  assert.equal(client.snapshot.references[0]!.id, ref.id);
  // Hidden following sources and pinned history references have no rendered
  // edge. Editing the surrounding text must retain their business identity.
  for (const binding of ["follow_current", "pinned"] as const) {
    const reference: Reference =
      binding === "follow_current"
        ? ref
        : { ...ref, binding: "pinned", source: assetReference(asset) };
    const hidden = {
      ...basis,
      eventCursor: 2,
      canvasItems: basis.canvasItems.map((item) =>
        item.id === source.id ? { ...item, visible: false } : item,
      ),
      generationSpecs: [
        {
          ...spec,
          prompt: "",
          promptContent: [{ type: "reference" as const, referenceId: ref.id }],
        },
      ],
      references: [reference],
    };
    client.install(hidden);
    const rendered = await projection.read();
    assert.equal(rendered.edges.length, binding === "follow_current" ? 1 : 0);
    assert.equal(rendered.hiddenNodes?.[0]?.id, source.id);
    const current = rendered.nodes[0]!;
    assert.equal(current.data.promptMentions?.[0]?.referenceId, ref.id);
    projection.baseline = rendered;
    projection.basis = hidden;
    client.batches = [];
    if (binding === "pinned") {
      const replacementId = crypto.randomUUID();
      const replacement = generationContentPatch([
        { type: "text", text: "Keep " },
        {
          type: "reference",
          binding: "asset",
          assetId: asset.id,
          referenceId: replacementId,
          name: asset.name,
          fingerprint: asset.fingerprint,
        },
      ]);
      await projection.save({
        ...rendered,
        nodes: [{ ...current, data: { ...current.data, ...replacement } }],
      });
      const operations = client.batches[0]!.operations;
      const removeIndex = operations.findIndex(
        (op) =>
          op.type === "reference.remove" && op.payload.referenceId === ref.id,
      );
      const addIndex = operations.findIndex(
        (op) =>
          op.type === "reference.add" &&
          op.payload.reference.id === replacementId,
      );
      assert.ok(removeIndex >= 0 && addIndex > removeIndex);
      const prompt = operations.find(
        (op) => op.type === "generationSpec.setPrompt",
      );
      assert.ok(prompt?.type === "generationSpec.setPrompt");
      assert.deepEqual(prompt.payload.promptContent, [
        { type: "text", text: "Keep " },
        { type: "reference", referenceId: replacementId },
      ]);
      projection.baseline = rendered;
      projection.basis = hidden;
      client.batches = [];
    }
    await projection.save({
      ...rendered,
      nodes: [
        {
          ...current,
          data: {
            ...current.data,
            prompt: current.data.prompt + " with extra instructions",
          },
        },
      ],
    });
    const update = client.batches[0]!.operations.find(
      (op) => op.type === "generationSpec.setPrompt",
    );
    assert.equal(update?.type, "generationSpec.setPrompt");
    if (update?.type === "generationSpec.setPrompt")
      assert.deepEqual(update.payload.promptContent?.[0], {
        type: "reference",
        referenceId: ref.id,
      });
    const inactive = { ...reference, active: false, revision: 2 };
    const removed = {
      ...hidden,
      references: [inactive],
      generationSpecs: [{ ...spec, promptContent: [], prompt: "" }],
    };
    client.install(removed);
    const blank = await projection.read();
    projection.baseline = blank;
    projection.basis = removed;
    client.batches = [];
    await projection.save({
      ...blank,
      nodes: rendered.nodes,
      edges: rendered.edges,
    });
    const restored = client.batches[0]!;
    const restore = restored.operations.find(
      (op) => op.type === "reference.restore",
    );
    assert.equal(restore?.type, "reference.restore");
    if (restore?.type === "reference.restore") {
      assert.equal(restore.payload.reference.id, ref.id);
      assert.equal(restore.payload.reference.revision, 2);
      assert.equal(restore.payload.reference.active, true);
    }
    assert.ok(
      restored.versions.some(
        (version) =>
          version.objectType === "reference" &&
          version.id === ref.id &&
          version.revision === 2,
      ),
    );
    const prompt = restored.operations.find(
      (op) => op.type === "generationSpec.setPrompt",
    );
    assert.ok(
      prompt?.type === "generationSpec.setPrompt" &&
        prompt.payload.promptContent?.some(
          (part) => part.type === "reference" && part.referenceId === ref.id,
        ),
    );
    if (binding === "pinned") {
      const unpositioned = {
        ...hidden,
        generationSpecs: [
          { ...spec, prompt: "Plain instructions", promptContent: null },
        ],
      };
      client.install(unpositioned);
      const document = await projection.read();
      const targetNode = document.nodes[0]!;
      assert.equal(
        targetNode.data.promptContent?.find((part) => part.type === "reference")
          ?.referenceId,
        ref.id,
      );
      projection.baseline = document;
      projection.basis = unpositioned;
      client.batches = [];
      const { generationContentPatch } =
        await import("../src/canvas/generationReferenceContent.ts");
      await projection.save({
        ...document,
        nodes: [
          {
            ...targetNode,
            data: {
              ...targetNode.data,
              ...generationContentPatch([
                { type: "text", text: "Retained instructions" },
              ]),
            },
          },
        ],
      });
      assert.ok(
        client.batches[0]!.operations.some(
          (op) =>
            op.type === "reference.remove" && op.payload.referenceId === ref.id,
        ),
      );
    }
  }
});
