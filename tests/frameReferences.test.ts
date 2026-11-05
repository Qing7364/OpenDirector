import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDocument,
  createNode,
  type CanvasDocument,
} from "../src/canvas/model.ts";
import {
  generationDefaults,
  generationActiveReferences,
  generationBlocker,
} from "../src/canvas/generationCatalog.ts";
import { createHistory, recordChange, undo } from "../src/canvas/history.ts";
import { parseDocument, serializeDocument } from "../src/canvas/storage.ts";
import { referenceIssue } from "../src/canvas/connectionPolicy.ts";
import {
  initializeConnectedFrames,
  modelFrameCapabilities,
} from "../src/canvas/frameReferences.ts";

const image = () =>
  createNode("image", undefined, {
    src: "data:image/png;base64,fixture",
    assetState: "ready",
  });
const video = (backend = false) =>
  createNode("video", undefined, {
    settings: {
      ...generationDefaults("video"),
      videoMode: "first-last",
      ...(backend ? { modelConfigId: crypto.randomUUID() } : {}),
    },
  });
const connect = (doc: CanvasDocument, source: string, target: string) =>
  applyCommand(doc, {
    type: "add-edge",
    edge: { id: crypto.randomUUID(), source, target },
  });

test("image connections fill first/last slots atomically, reject a third input and undo together", () => {
  const a = image(),
    b = image(),
    c = image(),
    target = video();
  const initial = { ...createDocument(), nodes: [a, b, c, target] };
  const first = connect(initial, a.id, target.id),
    second = connect(first, b.id, target.id);
  const settings = second.nodes.at(-1)!.data.settings!;
  assert.equal(settings.firstFrameNodeId, a.id);
  assert.equal(settings.lastFrameNodeId, b.id);
  assert.deepEqual(
    generationActiveReferences(settings, [a, b]).map((ref) => [
      ref.node.id,
      ref.role,
    ]),
    [
      [a.id, "firstFrame"],
      [b.id, "lastFrame"],
    ],
  );
  assert.equal(
    referenceIssue(second, c.id, target.id),
    "frame_capacity_exceeded",
  );
  assert.equal(connect(second, c.id, target.id), second);
  assert.deepEqual(
    undo(recordChange(createHistory(first), second)).present,
    first,
  );
  assert.equal(
    referenceIssue(
      {
        ...second,
        edges: [
          ...second.edges,
          {
            id: "result",
            source: c.id,
            target: target.id,
            intent: "post_edit_result",
          },
        ],
      },
      c.id,
      target.id,
    ),
    "frame_capacity_exceeded",
  );
  const saved = serializeDocument(second);
  assert.ok(saved.ok);
  if (saved.ok) {
    const parsed = parseDocument(saved.value);
    assert.ok(parsed.ok);
    if (parsed.ok)
      assert.deepEqual(parsed.value.nodes.at(-1)!.data.settings, settings);
  }
});

test("switching mode fills connected images while explicit selection and clearing stay intact", () => {
  const a = image(),
    b = image(),
    target = video();
  target.data.settings!.videoMode = "reference";
  let doc = connect(
    connect({ ...createDocument(), nodes: [a, b, target] }, a.id, target.id),
    b.id,
    target.id,
  );
  doc = applyCommand(doc, {
    type: "update-node",
    id: target.id,
    patch: {
      data: {
        settings: {
          ...target.data.settings!,
          videoMode: "first-last",
          firstFrameNodeId: b.id,
        },
      },
    },
  });
  let current = doc.nodes.at(-1)!;
  assert.equal(current.data.settings!.firstFrameNodeId, b.id);
  assert.equal(current.data.settings!.lastFrameNodeId, a.id);
  doc = applyCommand(doc, {
    type: "update-node",
    id: target.id,
    patch: {
      data: {
        settings: { ...current.data.settings!, firstFrameNodeId: undefined },
      },
    },
  });
  current = doc.nodes.at(-1)!;
  assert.equal(current.data.settings!.firstFrameNodeId, undefined);
  const edited = applyCommand(doc, {
    type: "update-node",
    id: target.id,
    patch: { data: { prompt: "more instructions" } },
  });
  assert.equal(edited.nodes.at(-1)!.data.settings!.firstFrameNodeId, undefined);
  const removed = applyCommand(edited, {
    type: "remove-edges",
    ids: [edited.edges[0]!.id],
  });
  assert.equal(removed.nodes.at(-1)!.data.settings!.lastFrameNodeId, undefined);
});

test("existing frame-mode documents pick up connected images once and preserve explicit clearing on reopen", () => {
  const a = image(),
    b = image(),
    target = video();
  const original = {
    ...createDocument(),
    nodes: [a, b, target],
    edges: [
      { id: "a", source: a.id, target: target.id },
      { id: "b", source: b.id, target: target.id },
    ],
  };
  const opened = initializeConnectedFrames(original);
  assert.equal(opened.nodes.at(-1)!.data.settings!.firstFrameNodeId, a.id);
  assert.equal(opened.nodes.at(-1)!.data.settings!.lastFrameNodeId, b.id);
  const current = opened.nodes.at(-1)!;
  const cleared = applyCommand(opened, {
    type: "update-node",
    id: target.id,
    patch: {
      data: {
        settings: { ...current.data.settings!, firstFrameNodeId: undefined },
      },
    },
  });
  const saved = serializeDocument(cleared);
  assert.ok(saved.ok);
  if (saved.ok) {
    const parsed = parseDocument(saved.value);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      const reopened = initializeConnectedFrames(parsed.value);
      assert.equal(
        reopened.nodes.at(-1)!.data.settings!.firstFrameNodeId,
        undefined,
      );
      assert.equal(reopened.nodes.at(-1)!.data.settings!.lastFrameNodeId, b.id);
    }
  }
  assert.equal(
    original.nodes.at(-1)!.data.settings!.firstFrameNodeId,
    undefined,
  );
});

test("first-frame-only adapters fill the first slot without creating an unsupported tail", () => {
  const a = image(),
    b = image(),
    target = video(true);
  const doc = connect(
    connect({ ...createDocument(), nodes: [a, b, target] }, a.id, target.id),
    b.id,
    target.id,
  );
  assert.equal(doc.nodes.at(-1)!.data.settings!.firstFrameNodeId, a.id);
  assert.equal(doc.nodes.at(-1)!.data.settings!.lastFrameNodeId, undefined);
});

test("configured models that declare a last frame fill both slots in edge order", () => {
  const a = image(),
    b = image(),
    target = video(true);
  const configId = target.data.settings!.modelConfigId!;
  const frames = modelFrameCapabilities([
    {
      id: configId,
      inputRules: { frameRoles: ["first_frame", "last_frame"] },
    } as never,
  ]);
  let doc: CanvasDocument = { ...createDocument(), nodes: [a, b, target] };
  for (const source of [a, b])
    doc = applyCommand(
      doc,
      {
        type: "add-edge",
        edge: { id: crypto.randomUUID(), source: source.id, target: target.id },
      },
      frames,
    );
  const settings = doc.nodes.at(-1)!.data.settings!;
  assert.equal(settings.firstFrameNodeId, a.id);
  assert.equal(settings.lastFrameNodeId, b.id);
});

test("frame capabilities reach slots filled by a batch or a switch to first-last mode", () => {
  const a = image(),
    b = image(),
    target = video(true);
  target.data.settings!.videoMode = "reference";
  const configId = target.data.settings!.modelConfigId!;
  const frames = modelFrameCapabilities([
    {
      id: configId,
      inputRules: { frameRoles: ["first_frame", "last_frame"] },
    } as never,
  ]);
  const edges = [a, b].map((source) => ({
    type: "add-edge" as const,
    edge: { id: crypto.randomUUID(), source: source.id, target: target.id },
  }));
  let doc = applyCommand(
    { ...createDocument(), nodes: [a, b, target] },
    { type: "batch", commands: edges },
    frames,
  );
  doc = applyCommand(
    doc,
    {
      type: "update-node",
      id: target.id,
      patch: {
        data: {
          settings: { ...target.data.settings!, videoMode: "first-last" },
        },
      },
    },
    frames,
  );
  const settings = doc.nodes.at(-1)!.data.settings!;
  assert.equal(settings.firstFrameNodeId, a.id);
  assert.equal(settings.lastFrameNodeId, b.id);
});

test("unknown or first-frame-only configured models never receive a last frame", () => {
  const target = video(true);
  const settings = target.data.settings!;
  assert.equal(modelFrameCapabilities([]).supportsLastFrame(settings), false);
  assert.equal(
    modelFrameCapabilities([
      {
        id: settings.modelConfigId!,
        inputRules: { frameRoles: ["first_frame"] },
      } as never,
    ]).supportsLastFrame(settings),
    false,
  );
  assert.equal(
    modelFrameCapabilities([]).supportsLastFrame({
      ...settings,
      modelConfigId: undefined,
    }),
    true,
  );
});

test("over-limit reference mode cannot switch to frames or submit a legacy over-limit draft", () => {
  const images = [image(), image(), image()],
    target = video();
  target.data.settings!.videoMode = "reference";
  let doc = { ...createDocument(), nodes: [...images, target] };
  for (const source of images) doc = connect(doc, source.id, target.id);
  const settings = {
    ...target.data.settings!,
    videoMode: "first-last" as const,
  };
  assert.equal(
    applyCommand(doc, {
      type: "update-node",
      id: target.id,
      patch: { data: { settings } },
    }),
    doc,
  );
  assert.match(generationBlocker(settings, images)!, /最多连接 2/);
  const removed = applyCommand(doc, {
    type: "remove-edges",
    ids: [doc.edges.at(-1)!.id],
  });
  const switched = applyCommand(removed, {
    type: "update-node",
    id: target.id,
    patch: { data: { settings } },
  });
  assert.equal(
    switched.nodes.at(-1)!.data.settings!.firstFrameNodeId,
    images[0]!.id,
  );
  assert.equal(
    switched.nodes.at(-1)!.data.settings!.lastFrameNodeId,
    images[1]!.id,
  );
});
