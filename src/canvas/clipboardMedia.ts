import { MEDIA_FIELDS } from "./canvasArchive.ts";
import type { CanvasResource } from "./model.ts";
import type { CanvasFragment } from "./operations.ts";

const KINDS = new Set<CanvasResource["kind"]>([
  "image",
  "video",
  "audio",
  "text",
  "file",
]);

/** Media copied with a fragment. Switching projects revokes the source's object
 * URLs, so the bytes are read while the copy is made. */
export interface ClipboardMedia {
  projectId: string;
  blobs: Map<string, Promise<Blob>>;
  /** Registered copies per target project, so repeated pastes and retries reuse them. */
  registered: Map<string, Promise<RegisteredMedia>>;
}

export interface RegisteredMedia {
  assetId: string;
  src: string;
}

export type RegisterMedia = (
  blob: Blob,
  title: string,
  kind: CanvasResource["kind"],
) => Promise<RegisteredMedia>;

const isTemporary = (value: unknown): value is string =>
  typeof value === "string" && /^(blob|data):/i.test(value);

function visitMedia(
  value: unknown,
  found: (record: Record<string, unknown>, key: string, src: string) => void,
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (MEDIA_FIELDS.has(key) && isTemporary(entry)) found(record, key, entry);
    else if (typeof entry === "object") visitMedia(entry, found);
  }
}

async function readBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("素材读取失败。");
  return response.blob();
}

/** Starts reading every inline media field before the source project can close. */
export function captureClipboardMedia(
  projectId: string,
  fragment: CanvasFragment,
  read: (src: string) => Promise<Blob> = readBlob,
): ClipboardMedia {
  const blobs = new Map<string, Promise<Blob>>();
  visitMedia(fragment.nodes, (_record, _key, src) => {
    if (blobs.has(src)) return;
    const pending = read(src);
    // A failed read is reported by the paste that needs it.
    pending.catch(() => {});
    blobs.set(src, pending);
  });
  return { projectId, blobs, registered: new Map() };
}

/**
 * Re-homes a fragment copied from another project: each media field is
 * registered in the target project before any node appears, and source-project
 * identities are dropped. A generated image's task stays in its own project, so
 * its copy becomes a plain material image instead of claiming that provenance.
 */
export async function transferClipboardMedia(
  fragment: CanvasFragment,
  media: ClipboardMedia,
  targetProjectId: string,
  register: RegisterMedia,
): Promise<CanvasFragment> {
  const copy = structuredClone(fragment);
  const registrations: Promise<void>[] = [];
  for (const node of copy.nodes) {
    delete node.data.backendAssetId;
    delete node.data.copiedSourceId;
    const nodeKind = KINDS.has(node.type as CanvasResource["kind"])
      ? (node.type as CanvasResource["kind"])
      : undefined;
    visitMedia(node, (record, key, src) => {
      const blob = media.blobs.get(src);
      if (!blob) throw new Error("复制的素材已失效，请重新复制。");
      const title =
        typeof record.title === "string" ? record.title : node.data.title;
      const kind =
        typeof record.kind === "string" &&
        KINDS.has(record.kind as CanvasResource["kind"])
          ? (record.kind as CanvasResource["kind"])
          : record === node.data
            ? nodeKind
            : undefined;
      const cacheKey = `${targetProjectId}\n${src}`;
      let pending = media.registered.get(cacheKey);
      if (!pending) {
        pending = blob
          .then((bytes) =>
            register(bytes, title, kind ?? mediaKind(bytes.type)),
          )
          .catch((error) => {
            media.registered.delete(cacheKey);
            throw error;
          });
        media.registered.set(cacheKey, pending);
      }
      registrations.push(
        pending.then((registered) => {
          record[key] = registered.src;
          if (record === node.data && key === "src")
            node.data.backendAssetId = registered.assetId;
          else if (key === "src" && "assetId" in record)
            record.assetId = registered.assetId;
        }),
      );
    });
  }
  // Settle every upload before failing, so a retry finds the successful ones.
  const failed = (await Promise.allSettled(registrations)).find(
    (result) => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  const materialized = new Set<string>();
  for (const node of copy.nodes)
    if (
      node.type === "image" &&
      node.data.mediaRole === "generation" &&
      node.data.src
    ) {
      node.data.mediaRole = "asset";
      node.data.prompt = "";
      delete node.data.promptContent;
      delete node.data.promptMentions;
      delete node.data.settings;
      delete node.data.taskDraft;
      materialized.add(node.id);
    }
  // A material image has no generation spec to receive references.
  copy.edges = copy.edges.filter((edge) => !materialized.has(edge.target));
  return copy;
}

function mediaKind(mimeType: string): CanvasResource["kind"] {
  const family = mimeType.split("/")[0] as CanvasResource["kind"];
  return ["image", "video", "audio"].includes(family) ? family : "file";
}
