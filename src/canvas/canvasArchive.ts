import { dataUrlToBlob, downloadFilename } from "./downloadAssets.ts";
import type { CanvasDocument } from "./model.ts";
import { parseDocument } from "./storage.ts";
import { createZip, readZip, type ZipEntry } from "./zipArchive.ts";

/** A `.canvas` file is a ZIP archive: `manifest.json` describes the export,
 * `canvas.json` is the document and `assets/` holds the media bytes. Keeps the
 * document readable and stops embedded base64 from bloating a single file. */
export const CANVAS_ARCHIVE_MAGIC = "opendirector-canvas";
export const CANVAS_ARCHIVE_VERSION = 1;
export const CANVAS_DOCUMENT_ENTRY = "canvas.json";
export const CANVAS_ASSET_DIRECTORY = "assets";

const UNSAFE_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** Field names that hold media: node sources, palettes and adopted outputs. */
export const MEDIA_FIELDS = new Set(["src", "sourceImageUri", "output"]);

export interface CanvasArchive {
  blob: Blob;
  filename: string;
  /** Archive-relative paths, in the order they were written. */
  assets: readonly string[];
}

export interface CanvasArchiveOptions {
  /** Reads media bytes. Injectable so exports can be verified off-browser. */
  read?: (src: string) => Promise<Blob>;
  now?: Date;
}

async function readMedia(src: string): Promise<Blob> {
  if (/^data:/i.test(src)) return dataUrlToBlob(src);
  const response = await fetch(src);
  if (!response.ok) throw new Error("无法读取画布素材，未导出不完整的副本。");
  return response.blob();
}

function fileName(value: string, fallback: string): string {
  const cleaned = value
    .replace(UNSAFE_FILE_NAME, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

function uniquePath(
  title: string,
  mimeType: string,
  taken: Set<string>,
): string {
  const name = fileName(downloadFilename(title, mimeType), "素材");
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; ; index++) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

async function sha256(data: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface Asset {
  path: string;
  data: Uint8Array;
  mimeType: string;
  byteSize: number;
  sha256?: string;
}

/** Media lives in `assets/`; the document keeps a relative reference to it. */
export async function buildCanvasArchive(
  document: CanvasDocument,
  options: CanvasArchiveOptions = {},
): Promise<CanvasArchive> {
  const read = options.read ?? readMedia;
  const copy = structuredClone(document);
  const paths = new Map<string, Promise<string>>();
  const byDigest = new Map<string, string>();
  const taken = new Set<string>();
  const assets: Asset[] = [];

  const register = async (
    src: string,
    title: string,
    mimeType: string,
  ): Promise<string> => {
    const known = paths.get(src);
    if (known) return known;
    const pending = (async () => {
      const blob = await read(src);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const type = blob.type || mimeType;
      const digest = await sha256(bytes);
      const shared = digest ? byDigest.get(digest) : undefined;
      if (shared) return shared;
      const path = `${CANVAS_ASSET_DIRECTORY}/${uniquePath(title, type, taken)}`;
      assets.push({
        path,
        data: bytes,
        mimeType: type,
        byteSize: bytes.length,
        sha256: digest,
      });
      if (digest) byDigest.set(digest, path);
      return path;
    })();
    paths.set(src, pending);
    return pending;
  };

  const visit = async (
    value: unknown,
    title: string,
    mimeType: string,
  ): Promise<void> => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const ownTitle = typeof record.title === "string" ? record.title : title;
    const ownType =
      typeof record.mimeType === "string" ? record.mimeType : mimeType;
    for (const [key, entry] of Object.entries(record)) {
      if (
        MEDIA_FIELDS.has(key) &&
        typeof entry === "string" &&
        /^(data|blob):/i.test(entry)
      )
        record[key] = await register(entry, ownTitle, ownType);
      else if (typeof entry === "object") await visit(entry, ownTitle, ownType);
    }
  };

  await visit(copy, document.title, "");

  const canvasJson = `${JSON.stringify(copy, null, 2)}\n`;
  if (/:\s*"blob:/i.test(canvasJson))
    throw new Error("画布素材仍使用临时地址，未导出不完整的副本。");

  const manifest = {
    magic: CANVAS_ARCHIVE_MAGIC,
    formatVersion: CANVAS_ARCHIVE_VERSION,
    name: document.title,
    exportedAt: (options.now ?? new Date()).toISOString(),
    document: CANVAS_DOCUMENT_ENTRY,
    assets: assets.map((asset) => ({
      path: asset.path,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    })),
  };
  const entries: ZipEntry[] = [
    {
      path: "manifest.json",
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
      compress: true,
    },
    {
      path: CANVAS_DOCUMENT_ENTRY,
      data: new TextEncoder().encode(canvasJson),
      compress: true,
    },
    ...assets.map((asset) => ({ path: asset.path, data: asset.data })),
  ];
  return {
    blob: await createZip(entries, options.now ?? new Date()),
    filename: `${fileName(document.title, "画布")}.canvas`,
    assets: assets.map((asset) => asset.path),
  };
}

export interface CanvasArchiveContents {
  document: CanvasDocument;
  /** Number of media files restored from `assets/`. */
  assets: number;
}

interface ArchiveManifest {
  magic?: unknown;
  formatVersion?: unknown;
  document?: unknown;
  assets?: { path?: unknown; mimeType?: unknown }[];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

/** Reads a `.canvas` archive back into a document whose media is inline again.
 * The exporter stores relative paths, so importing needs no project history. */
export async function readCanvasArchive(
  file: Blob,
): Promise<CanvasArchiveContents> {
  const files = await readZip(file);
  const manifestEntry = files.get("manifest.json");
  if (!manifestEntry)
    throw new Error("这不是 OpenDirector 画布压缩包：缺少 manifest.json。");
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry));
  } catch {
    throw new Error("画布压缩包的 manifest.json 无法解析。");
  }
  if (manifest.magic !== CANVAS_ARCHIVE_MAGIC)
    throw new Error("这不是 OpenDirector 画布压缩包，未导入任何内容。");
  const version = manifest.formatVersion;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error("画布压缩包的格式版本无效。");
  if (version > CANVAS_ARCHIVE_VERSION)
    throw new Error(
      `该画布由更新版本的 OpenDirector 导出（格式 v${version}），当前版本无法读取。`,
    );
  const documentPath =
    typeof manifest.document === "string" && manifest.document
      ? manifest.document
      : CANVAS_DOCUMENT_ENTRY;
  const documentEntry = files.get(documentPath);
  if (!documentEntry) throw new Error(`压缩包缺少画布文件：${documentPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(documentEntry));
  } catch {
    throw new Error("画布 JSON 无法解析，未导入任何内容。");
  }
  const parsed = parseDocument(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const document = parsed.value;
  const mimeTypes = new Map<string, string>();
  for (const asset of manifest.assets ?? [])
    if (typeof asset?.path === "string" && typeof asset.mimeType === "string")
      mimeTypes.set(asset.path, asset.mimeType);
  const restored = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "object") {
        visit(entry);
        continue;
      }
      if (!MEDIA_FIELDS.has(key) || typeof entry !== "string") continue;
      if (/^data:/i.test(entry)) continue;
      if (/^blob:/i.test(entry))
        throw new Error("画布引用了临时素材地址，压缩包已损坏，未导入。");
      const bytes = files.get(entry);
      if (!bytes) throw new Error(`画布引用的素材缺失：${entry}，未导入。`);
      const type = mimeTypes.get(entry) || "application/octet-stream";
      record[key] = `data:${type};base64,${base64(bytes)}`;
      restored.add(entry);
    }
  };
  visit(document);
  return { document, assets: restored.size };
}
