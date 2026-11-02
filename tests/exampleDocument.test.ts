import assert from "node:assert/strict";
import test from "node:test";
import { exampleDocument } from "../src/canvas/assets.ts";

test("example prepares raster images and distinguishes generation from assembly references", async () => {
  const previousImage = globalThis.Image;
  const previousDocument = globalThis.document;
  const sources: string[] = [];
  globalThis.Image = class {
    naturalWidth = 1200;
    naturalHeight = 1000;
    onload?: () => void;
    set src(value: string) {
      sources.push(value);
      this.onload?.();
    }
  } as unknown as typeof Image;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: (mime: string) => `data:${mime};base64,example`,
    }),
  } as unknown as Document;
  try {
    const document = await exampleDocument();
    assert.equal(sources.length, 2);
    const images = document.nodes.filter((node) => node.type === "image");
    assert.equal(images.length, 2);
    for (const image of images) {
      assert.equal(image.data.mimeType, "image/png");
      assert.match(image.data.src!, /^data:image\/png;/);
      assert.notEqual(image.data.mediaRole, "generation");
    }
    for (const edge of document.edges) {
      const target = document.nodes.find((node) => node.id === edge.target)!;
      if (["timeline", "subject"].includes(target.type))
        assert.equal(edge.intent, "assembly_input");
      else {
        const source = document.nodes.find((node) => node.id === edge.source)!;
        assert.ok(["text", "image", "video", "audio"].includes(source.type));
        assert.equal(target.data.mediaRole, "generation");
      }
    }
    const timeline = document.nodes.find((node) => node.type === "timeline")!;
    assert.deepEqual(
      timeline.data.timeline!.tracks[0]!.clips.map((clip) => clip.resource.src),
      images.map((node) => node.data.src),
    );
    const subject = document.nodes.find((node) => node.type === "subject")!;
    assert.equal(subject.data.subject!.main!.src, images[0]!.data.src);
  } finally {
    globalThis.Image = previousImage;
    globalThis.document = previousDocument;
  }
});
