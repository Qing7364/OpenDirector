import { createDocument, createNode } from "./model.ts";
import type { CanvasDocument } from "./model.ts";
import { createLocalStage } from "./stageDocument.ts";
import { loadLayerImage } from "./layerRenderer.ts";
import { dataUrlToBlob } from "./downloadAssets.ts";
export { downloadFilename } from "./downloadAssets.ts";

/** Original vector study assets; these are illustrations, not AI results or remote media. */
export function studyImage(seed = 0, title = "光与山之间"): string {
  const palettes = [
    ["#b0c8be", "#446e64", "#1b413e", "#e5cdb0"],
    ["#c7b5ab", "#876d78", "#393545", "#edb497"],
    ["#b7c6ce", "#607d90", "#253c53", "#eee7c8"],
  ];
  const p =
    palettes[((seed % palettes.length) + palettes.length) % palettes.length]!;
  const escaped = title.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000" viewBox="0 0 1200 1000"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${p[0]}"/><stop offset="1" stop-color="${p[3]}"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="${p[1]}"/><stop offset="1" stop-color="${p[2]}"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="24"/></filter></defs><rect width="1200" height="1000" fill="url(#sky)"/><circle cx="840" cy="245" r="78" fill="${p[3]}" opacity=".9"/><path d="M0 640 240 230 430 500 675 170 1080 620 1200 470V1000H0" fill="${p[1]}" opacity=".44"/><path d="m0 560 170-170 260 300 260-210 240 190 270-290v620H0" fill="${p[1]}"/><path d="M0 720Q260 660 600 705T1200 690V1000H0" fill="url(#lake)"/><ellipse cx="650" cy="706" rx="500" ry="22" fill="${p[3]}" opacity=".65" filter="url(#soft)"/><g fill="${p[2]}"><path d="m0 710 180-25 115 315H0"/><path d="m1200 640-220 110-65 250h285"/></g><g stroke="${p[3]}" opacity=".2"><path d="M480 785h290M370 845h420M570 904h180"/></g><path d="m670 795 90 0-18 13h-52z" fill="${p[2]}"/><path d="M712 795v-47" stroke="${p[2]}" stroke-width="5"/><text x="56" y="900" fill="${p[3]}" font-family="sans-serif" font-size="28" letter-spacing="6">${escaped.slice(0, 32)}</text><text x="56" y="946" fill="${p[3]}" opacity=".6" font-family="sans-serif" font-size="12" letter-spacing="4">OPENDIRECTOR / ORIGINAL VECTOR STUDY</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function exampleDocument(): Promise<CanvasDocument> {
  const images = await Promise.all(
    [studyImage(0), studyImage(1, "暮色抵达之前")].map(async (src) => {
      const image = await loadLayerImage(src);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建示例图片。");
      context.drawImage(image, 0, 0);
      return canvas.toDataURL("image/png");
    }),
  );
  const doc = createDocument("光与山之间 · 镜头研究");
  const notes = createNode(
    "text",
    { x: 80, y: 150 },
    {
      title: "创作方向",
      text: "光与山之间\n\n清晨的薄雾，远山与一叶小舟。\n克制的色彩，留白的构图。\n\n① 环境与情绪\n② 角色进入画面\n③ 镜头缓慢推进",
      prompt: "",
    },
  );
  notes.width = 260;
  notes.height = 310;
  const a = createNode(
    "image",
    { x: 460, y: 130 },
    {
      title: "场景 · 清晨",
      src: images[0]!,
      assetState: "ready",
      mimeType: "image/png",
      media: { width: 1200, height: 1000 },
      prompt: "清晨，远山与湖泊，薄雾，低饱和青绿色，电影感广角构图",
    },
  );
  const b = createNode(
    "image",
    { x: 930, y: 130 },
    {
      title: "色彩 · 暖调",
      src: images[1]!,
      assetState: "ready",
      mimeType: "image/png",
      media: { width: 1200, height: 1000 },
      prompt: "参考场景结构，转为暮色暖调，保留静谧的氛围",
    },
  );
  const video = createNode(
    "video",
    { x: 1400, y: 130 },
    {
      title: "镜头 01 · 缓慢推进",
      prompt: "以参考图为首帧，镜头缓慢向前推进，小船轻轻划过湖面。",
      settings: {
        mode: "video",
        model: "Seedance 2.0 mini",
        aspectRatio: "16:9",
        durationSeconds: 4,
        resolution: "720P",
        videoMode: "reference",
        prompt: "",
      },
    },
  );
  const timeline = createNode(
    "timeline",
    { x: 80, y: 600 },
    {
      title: "两幕 · 时间线",
      timeline: {
        fps: 24,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "visual",
            kind: "visual",
            title: "画面轨",
            muted: false,
            clips: [a, b].map((node) => ({
              id: crypto.randomUUID(),
              resource: {
                id: crypto.randomUUID(),
                nodeId: node.id,
                kind: "image",
                title: node.data.title,
                src: node.data.src,
                mimeType: node.data.mimeType,
                width: 1200,
                height: 1000,
              },
              inPoint: 0,
              outPoint: 3,
              speed: 1,
              volume: 1,
              muted: false,
            })),
          },
        ],
      },
    },
  );
  const subject = createNode(
    "subject",
    { x: 810, y: 600 },
    {
      title: "场景参考 · 山与湖",
      subject: {
        description: "远山、薄雾和一叶小舟。示例素材为本工程原创矢量插画。",
        category: "scene",
        auxiliaries: [],
        main: {
          id: crypto.randomUUID(),
          nodeId: a.id,
          kind: "image",
          title: a.data.title,
          src: a.data.src,
          mimeType: a.data.mimeType,
          width: 1200,
          height: 1000,
        },
      },
    },
  );
  const camera = createNode(
    "tool",
    { x: 1230, y: 600 },
    {
      title: "镜头参数",
      tool: {
        kind: "camera",
        fields: [
          { name: "景别", values: ["远景"] },
          { name: "机位", values: ["平视"] },
          { name: "焦距", values: ["35mm"] },
        ],
      },
    },
  );
  const director = createNode(
    "external",
    { x: 1230, y: 890 },
    {
      title: "导演预演 · 机位研究",
      localStage: createLocalStage(),
    },
  );
  doc.nodes = [notes, a, b, video, timeline, subject, camera, director];
  doc.edges = [
    { id: crypto.randomUUID(), source: b.id, target: video.id },
    {
      id: crypto.randomUUID(),
      source: a.id,
      target: timeline.id,
      intent: "assembly_input",
      assemblySlotId: timeline.data.timeline!.tracks[0]!.clips[0]!.id,
    },
    {
      id: crypto.randomUUID(),
      source: b.id,
      target: timeline.id,
      intent: "assembly_input",
      assemblySlotId: timeline.data.timeline!.tracks[0]!.clips[1]!.id,
    },
    {
      id: crypto.randomUUID(),
      source: a.id,
      target: subject.id,
      intent: "assembly_input",
      assemblySlotId: "main",
    },
  ];
  return doc;
}

export function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function downloadFile(contents: Blob | string, filename: string): void {
  const downloadable =
    typeof contents === "string" && /^data:/i.test(contents)
      ? dataUrlToBlob(contents)
      : contents;
  const ownsUrl = downloadable instanceof Blob;
  const url = ownsUrl ? URL.createObjectURL(downloadable) : downloadable;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  try {
    a.click();
  } catch (error) {
    if (ownsUrl) URL.revokeObjectURL(url);
    throw error;
  } finally {
    a.remove();
  }
  if (ownsUrl) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
