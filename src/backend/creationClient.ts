import type {
  Asset,
  AssetRef,
  BatchPayloadInput,
  CanvasItem,
  CommandInput,
  CommandReceipt,
  GenerationSpec,
  Job,
  ObjectVersion,
  ProjectEvent,
  ProjectSnapshot,
  ViewState,
} from "../contracts/generated.ts";
import {
  ApiError,
  headers,
  json,
  request,
  responseError,
  storageRequest,
} from "./api.ts";
import { abortable, resilientRead, type ReadOptions } from "./resilientRead.ts";

export type CreationOperation = BatchPayloadInput["operations"][number];
export const objectVersion = (
  objectType: ObjectVersion["objectType"],
  object: { id: string; revision: number },
): ObjectVersion => ({ objectType, id: object.id, revision: object.revision });
export const assetReference = (asset: Asset): AssetRef => ({
  assetId: asset.id,
  revision: asset.revision,
  fingerprint: asset.fingerprint,
  kind: asset.kind,
});
export const creationPath = (id: string) => `/creation/projects/${id}`;
const viewClientId = (() => {
  try {
    const key = "opendirector.creation.viewClientId";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

/** A confirmed rejection is distinct from an unknown delivery outcome. */
export class CreationCommandError extends Error {
  readonly receipt: CommandReceipt;
  constructor(receipt: CommandReceipt) {
    super(receipt.issues.map((issue) => issue.message).join("\n"));
    this.name = "CreationCommandError";
    this.receipt = receipt;
  }
}

/** One server snapshot and one command queue per open project. No writable
 * business graph, browser result ownership or generation history is persisted. */
export class CreationClient {
  snapshot!: ProjectSnapshot;
  referenceStates = new Map<
    string,
    "used" | "pending" | "unknown" | "unavailable"
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private historyRead?: {
    cursor: number;
    promise: Promise<{ commandId: string; state: "applied" | "undone" }[]>;
  };
  private listeners = new Set<(snapshot: ProjectSnapshot) => void>();
  private subscription: AbortController | undefined;
  private media = new Map<string, Promise<string>>();
  private sourceAssets = new Map<string, string>();
  private text = new Map<string, Promise<string>>();
  private submissions: Promise<unknown> = Promise.resolve();
  private deliveries = new Map<string, Record<string, unknown>>();
  private viewState: ViewState | undefined;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
    // This is a transport outbox, not a second job store. A page reload must
    // retain the original command ID when a paid submission's reply is lost.
    try {
      const pending: [string, Record<string, unknown>][] = JSON.parse(
        sessionStorage.getItem(this.deliveryKey()) ?? "[]",
      );
      for (const [intent, body] of pending)
        if (
          body.type === "generation.submit" &&
          body.projectId === id &&
          typeof body.commandId === "string"
        )
          this.deliveries.set(intent, body);
    } catch {
      /* Memory still handles retries when session storage is unavailable. */
    }
  }
  private deliveryKey() {
    return `opendirector.creation.deliveries:${this.id}`;
  }
  private saveDeliveries() {
    try {
      const pending = [...this.deliveries].filter(
        ([, body]) => body.type === "generation.submit",
      );
      if (pending.length)
        sessionStorage.setItem(this.deliveryKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(this.deliveryKey());
    } catch {
      /* Transport state is never required for reading project facts. */
    }
  }
  async open() {
    this.viewState = undefined;
    this.historyRead = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        this.install(
          await request<ProjectSnapshot>(`${creationPath(this.id)}/open`, {
            method: "POST",
          }),
        );
        break;
      } catch (error) {
        // The old page's keepalive release can arrive just after a reload's
        // first open. Genuine concurrent windows retain their lease protection.
        if (
          attempt >= 7 ||
          !(error instanceof ApiError) ||
          error.status !== 409 ||
          !error.message.includes("其他窗口")
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * (attempt + 1)),
        );
      }
    }
    await this.refresh();
    this.subscribe();
    return this.snapshot;
  }
  install(snapshot: ProjectSnapshot) {
    if (snapshot.project.id !== this.id)
      throw new Error("工程快照身份不匹配。");
    if (this.snapshot && snapshot.eventCursor < this.snapshot.eventCursor)
      return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
  async refresh() {
    const projection = await storageRequest<{
      snapshot: ProjectSnapshot;
      edges: {
        referenceId: string;
        state: "used" | "pending" | "unknown" | "unavailable";
      }[];
    }>(`${creationPath(this.id)}/canvas`);
    if (
      !this.snapshot ||
      projection.snapshot.eventCursor >= this.snapshot.eventCursor
    ) {
      this.referenceStates = new Map(
        projection.edges.map((edge) => [edge.referenceId, edge.state]),
      );
      this.install(projection.snapshot);
    }
    return this.snapshot;
  }
  listen(listener: (snapshot: ProjectSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async command<T extends CommandInput["type"]>(
    type: T,
    payload: Extract<CommandInput, { type: T }>["payload"],
    versions: readonly ObjectVersion[] = [],
    expectedPreview?: string,
    commandId?: string,
  ) {
    return this.enqueue(
      this.prepareCommand(type, payload, versions, expectedPreview, commandId),
    );
  }
  private enqueue<T>(perform: () => Promise<T>) {
    const pending = this.queue.then(perform, perform);
    this.queue = pending;
    return pending;
  }
  private prepareCommand(
    type: CommandInput["type"],
    payload: CommandInput["payload"],
    versions: readonly ObjectVersion[] = [],
    expectedPreview?: string,
    commandId?: string,
  ) {
    const intent =
      type === "generation.submit"
        ? `${type}:${(payload as { specId: string }).specId}`
        : JSON.stringify({ type, payload });
    const body = (!commandId && this.deliveries.get(intent)) || {
      commandId: commandId ?? crypto.randomUUID(),
      projectId: this.id,
      type,
      payload,
      expectedVersions: versions,
      ...(expectedPreview ? { expectedPreview } : {}),
    };
    this.deliveries.set(intent, body);
    this.saveDeliveries();
    const perform = async () => {
      let receipt: CommandReceipt;
      try {
        receipt = await storageRequest<CommandReceipt>(
          `${creationPath(this.id)}/commands`,
          json("POST", body),
        );
      } catch (error) {
        // A lost HTTP response is not permission to mint another paid request.
        try {
          receipt = await storageRequest<CommandReceipt>(
            `${creationPath(this.id)}/receipts/${body.commandId}`,
          );
        } catch {
          if (
            error instanceof ApiError &&
            [400, 401, 403, 413, 422].includes(error.status ?? 0)
          ) {
            if (this.deliveries.get(intent) === body)
              this.deliveries.delete(intent);
            this.saveDeliveries();
          }
          throw error;
        }
      }
      await this.refresh();
      if (this.deliveries.get(intent) === body) this.deliveries.delete(intent);
      this.saveDeliveries();
      if (receipt.status === "rejected")
        throw new CreationCommandError(receipt);
      return receipt;
    };
    return perform;
  }
  batch(operations: CreationOperation[], versions: readonly ObjectVersion[]) {
    return operations.length
      ? this.command("creation.batch", { operations }, versions)
      : Promise.resolve(undefined);
  }
  private subscribe() {
    this.subscription?.abort();
    const controller = new AbortController();
    this.subscription = controller;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(
            `/api${creationPath(this.id)}/subscribe?after=${this.snapshot.eventCursor}`,
            { headers, signal: controller.signal },
          );
          if (!response.ok || !response.body) throw new Error("变更订阅失败。");
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.trim()) continue;
              const event = JSON.parse(line) as ProjectEvent;
              if (event.projectId !== this.id)
                throw new Error("工程事件身份不匹配。");
              // A snapshot may already contain this or later events. Cursor
              // comparison makes repeated delivery and response races harmless.
              if (event.cursor > this.snapshot.eventCursor)
                await this.refresh();
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          // Cursor rejection/server replacement falls back to an authoritative
          // snapshot; an interrupted stream resumes from that snapshot's cursor.
          await this.refresh().catch(() => {});
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    })();
  }
  async blob(assetId: string, options: ReadOptions = {}) {
    return resilientRead(
      async (signal) => {
        const response = await fetch(
          `/api${creationPath(this.id)}/assets/${assetId}/content`,
          { headers, signal },
        );
        if (!response.ok) throw await responseError(response);
        return response.blob();
      },
      { timeoutMs: 120_000, attempts: 3, ...options },
    );
  }
  mediaUrl(assetId: string, options: ReadOptions = {}) {
    options.signal?.throwIfAborted();
    let pending = this.media.get(assetId);
    if (!pending) {
      // Cached reads have their own bounded lifetime. Cancelling one history
      // consumer must not abort the same media read used by the visible node.
      pending = this.blob(assetId, { ...options, signal: undefined })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          this.sourceAssets.set(url, assetId);
          return url;
        })
        .catch((error) => {
          this.media.delete(assetId);
          throw error;
        });
      this.media.set(assetId, pending);
    }
    return abortable(pending, options.signal);
  }
  thumbnailUrl(assetId: string) {
    const key = `thumbnail:${assetId}`;
    let pending = this.media.get(key);
    if (!pending) {
      pending = resilientRead(
        async (signal) => {
          const response = await fetch(
            `/api${creationPath(this.id)}/assets/${assetId}/thumbnail`,
            { headers, signal },
          );
          if (!response.ok) throw await responseError(response);
          return URL.createObjectURL(await response.blob());
        },
        { timeoutMs: 120_000, attempts: 3 },
      ).catch((error) => {
        this.media.delete(key);
        throw error;
      });
      this.media.set(key, pending);
    }
    return pending;
  }
  textContent(assetId: string) {
    let pending = this.text.get(assetId);
    if (!pending) {
      pending = this.blob(assetId)
        .then((blob) => blob.text())
        .catch((error) => {
          this.text.delete(assetId);
          throw error;
        });
      this.text.set(assetId, pending);
    }
    return pending;
  }
  rememberSource(src: string, assetId: string) {
    this.sourceAssets.set(src, assetId);
  }
  assetForSource(src: string) {
    const id = this.sourceAssets.get(src);
    return this.snapshot.assets.find((asset) => asset.id === id);
  }
  async importBlob(
    blob: Blob,
    name: string,
    kind: Asset["kind"],
    handle: string = crypto.randomUUID(),
  ) {
    const response = await fetch(
      `/api${creationPath(this.id)}/uploads/${handle}`,
      {
        method: "PUT",
        headers: {
          ...headers,
          "X-Asset-Name": encodeURIComponent(name),
          "X-Asset-Kind": kind,
        },
        body: blob,
      },
    );
    if (!response.ok) throw new Error("上传素材失败，请检查文件格式和大小。");
    return this.registerUpload(handle, name, kind);
  }
  /** Copies another project's asset on the server; no bytes pass through the page. */
  async copyAsset(
    source: { projectId: string; assetId: string; fingerprint?: string },
    handle: string = crypto.randomUUID(),
  ) {
    const info = await storageRequest<{ name: string; kind: Asset["kind"] }>(
      `${creationPath(this.id)}/uploads/${handle}/copy`,
      json("PUT", source),
    );
    return this.registerUpload(handle, info.name, info.kind);
  }
  private async registerUpload(
    handle: string,
    name: string,
    kind: Asset["kind"],
  ) {
    const receipt = await this.command("asset.import", {
      uploadHandle: handle,
      name,
      expectedKind: kind,
    });
    const asset = this.snapshot.assets.find((asset) =>
      receipt.changed.some(
        (v) => v.objectType === "asset" && v.id === asset.id,
      ),
    );
    if (!asset) throw new Error("素材登记未返回稳定身份。");
    return assetReference(asset);
  }
  /** Previews an asset from bytes the page already holds instead of reading them back. */
  adoptMedia(assetId: string, blob: Blob) {
    let pending = this.media.get(assetId);
    if (!pending) {
      const url = URL.createObjectURL(blob);
      this.sourceAssets.set(url, assetId);
      pending = Promise.resolve(url);
      this.media.set(assetId, pending);
    }
    return pending;
  }
  async writeText(name: string, text: string, previous?: AssetRef) {
    const receipt = await this.command(
      "asset.writeText",
      {
        name: name.replace(/\.(?:md|txt)$/i, "") + ".md",
        text,
        previousAsset: previous,
      },
      previous
        ? [
            objectVersion(
              "asset",
              this.snapshot.assets.find((a) => a.id === previous.assetId)!,
            ),
          ]
        : [],
    );
    return assetReference(
      this.snapshot.assets.find((a) =>
        receipt.changed.some((v) => v.objectType === "asset" && v.id === a.id),
      )!,
    );
  }
  async control(jobId: string, action: "cancel" | "recover") {
    await this.refresh();
    const original = this.snapshot.jobs.find((j) => j.id === jobId);
    if (!original) throw new Error("任务不存在。");
    for (let attempt = 0; ; attempt++) {
      const job = this.snapshot.jobs.find((j) => j.id === jobId);
      if (!job || job.inputFingerprint !== original.inputFingerprint)
        throw new Error("任务执行依据已变化，请重新核对任务。");
      try {
        return await this.command(
          action === "cancel" ? "job.cancel" : "job.recover",
          { jobId },
          [objectVersion("job", job)],
        );
      } catch (error) {
        // Only a confirmed stale-version rejection may be reconsidered.
        // Cancellation is monotonic intent for this SAME immutable execution;
        // checkpoint progress must not make an immediate cancel unreliable.
        // Unknown deliveries, recovery and changes to inputs never auto-retry.
        if (
          action !== "cancel" ||
          attempt >= 2 ||
          !(error instanceof CreationCommandError) ||
          !error.receipt.issues.length ||
          error.receipt.issues.some(
            (issue) => issue.code !== "revision_conflict",
          )
        )
          throw error;
        await this.refresh();
      }
    }
  }
  async selectResult(specId: string, resultId: string) {
    const spec = this.snapshot.generationSpecs.find((s) => s.id === specId)!;
    return this.command("result.select", { specId, resultId }, [
      objectVersion("generation_spec", spec),
      ...this.snapshot.canvasItems
        .filter((item) => itemSpec(this.snapshot, item)?.id === specId)
        .map((item) => objectVersion("canvas_item", item)),
    ]);
  }
  async submit(
    itemId: string,
    policy: "if_current" | "candidate_only" = "if_current",
    batchId?: string,
    signal?: AbortSignal,
  ) {
    const run = () => {
      signal?.throwIfAborted();
      return this.submitCurrent(itemId, policy, batchId, signal);
    };
    const pending = this.submissions.then(run, run);
    this.submissions = pending;
    return pending;
  }
  private async submitCurrent(
    itemId: string,
    policy: "if_current" | "candidate_only",
    batchId?: string,
    signal?: AbortSignal,
  ) {
    await this.refresh();
    signal?.throwIfAborted();
    const item = this.snapshot.canvasItems.find((i) => i.id === itemId);
    if (
      !item ||
      !("draftSpec" in item.binding || item.binding.role === "generation")
    )
      throw new Error("节点没有生成配置。");
    const specId =
      item.binding.role === "generation"
        ? item.binding.objectRef.id
        : item.binding.draftSpec?.id;
    const spec = this.snapshot.generationSpecs.find((s) => s.id === specId);
    if (!spec) throw new Error("节点没有生成配置。");
    return this.command(
      "generation.submit",
      {
        specId: spec.id,
        expectedSpecRevision: spec.revision,
        originItemId: item.id,
        adoptionPolicy: policy,
        batchId,
        showAdditionalResult: policy === "candidate_only",
      },
      [
        objectVersion("generation_spec", spec),
        objectVersion("canvas_item", item),
      ],
    );
  }
  history() {
    const cursor = this.snapshot.eventCursor;
    if (this.historyRead?.cursor === cursor) return this.historyRead.promise;
    const promise = storageRequest<
      { commandId: string; state: "applied" | "undone" }[]
    >(`${creationPath(this.id)}/history`).catch((error) => {
      if (this.historyRead?.promise === promise) this.historyRead = undefined;
      throw error;
    });
    this.historyRead = { cursor, promise };
    return promise;
  }
  undo(redo = false) {
    // Resolve the target and versions inside the same queue as writes. Two
    // rapid undo gestures must not both choose the same pre-write history.
    return this.enqueue(async () => {
      await this.refresh();
      const entries = await this.history();
      const entry = entries.find(
        (item) => item.state === (redo ? "undone" : "applied"),
      );
      if (!entry) return;
      const snapshot = this.snapshot;
      const versions = [
        ...snapshot.canvasItems.map((o) => objectVersion("canvas_item", o)),
        ...snapshot.generationSpecs.map((o) =>
          objectVersion("generation_spec", o),
        ),
        ...snapshot.references.map((o) => objectVersion("reference", o)),
        ...snapshot.editorDocuments.map((o) =>
          objectVersion("editor_document", o),
        ),
      ];
      await this.prepareCommand(
        redo ? "history.redo" : "history.undo",
        { targetCommandId: entry.commandId },
        versions,
      )();
    });
  }
  async view(value?: Partial<ViewState>) {
    const path = `${creationPath(this.id)}/views/${viewClientId}`;
    if (!this.viewState) this.viewState = await storageRequest<ViewState>(path);
    if (value)
      this.viewState = await storageRequest<ViewState>(
        path,
        json("PUT", {
          ...this.viewState,
          ...value,
          projectId: this.id,
          clientId: viewClientId,
        }),
      );
    return this.viewState;
  }
  close() {
    this.subscription?.abort();
    for (const pending of this.media.values())
      void pending.then(URL.revokeObjectURL, () => {});
    this.media.clear();
    this.sourceAssets.clear();
    this.text.clear();
  }
}

const clients = new Map<string, CreationClient>();
export const creationClient = (id: string) => {
  let client = clients.get(id);
  if (!client) {
    client = new CreationClient(id);
    clients.set(id, client);
  }
  return client;
};

export function currentAsset(
  snapshot: ProjectSnapshot,
  item: CanvasItem,
): Asset | undefined {
  if (item.binding.role === "material") {
    const binding = item.binding;
    return snapshot.assets.find((a) => a.id === binding.objectRef.assetId);
  }
  if (item.binding.role === "generation") {
    const binding = item.binding;
    if (binding.materialOverride)
      return snapshot.assets.find(
        (a) => a.id === binding.materialOverride!.assetId,
      );
    const spec = snapshot.generationSpecs.find(
      (s) => s.id === binding.objectRef.id,
    );
    const result = snapshot.results.find((r) => r.id === spec?.currentResultId);
    return snapshot.assets.find((a) => a.id === result?.asset.assetId);
  }
}
export function visibleItems(snapshot: ProjectSnapshot) {
  const items = new Map(snapshot.canvasItems.map((item) => [item.id, item]));
  const states = new Map<string, boolean>();
  for (const item of snapshot.canvasItems) {
    const chain: CanvasItem[] = [];
    let current: CanvasItem | undefined = item;
    while (current && !states.has(current.id)) {
      chain.push(current);
      current = current.parentId ? items.get(current.parentId) : undefined;
    }
    let visible = current ? states.get(current.id)! : true;
    for (const member of chain.reverse()) {
      visible = visible && member.visible;
      states.set(member.id, visible);
    }
  }
  return new Set(
    [...states].filter(([, visible]) => visible).map(([id]) => id),
  );
}
export function itemSpec(
  snapshot: ProjectSnapshot,
  item: CanvasItem,
): GenerationSpec | undefined {
  const binding = item.binding;
  const id =
    binding.role === "generation"
      ? binding.objectRef.id
      : binding.role === "empty"
        ? binding.draftSpec?.id
        : undefined;
  return snapshot.generationSpecs.find((s) => s.id === id);
}
export function jobItem(snapshot: ProjectSnapshot, job: Job) {
  return snapshot.canvasItems.find((i) => i.id === job.originItemId);
}
