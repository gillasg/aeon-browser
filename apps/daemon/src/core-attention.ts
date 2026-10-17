import { rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CoreAttentionSnapshotSchema,
  type CoreAttentionAlert,
  type CoreAttentionRequest,
} from "@aeon/protocol";
import type { ChatId, PiSessionEvent } from "@aeon/domain";
import type { ChatService } from "./chat-service.js";

interface AttentionRecord {
  chatId: string;
  working: boolean;
  completionId: string | null;
  unread: boolean;
  notified: boolean;
}
export class CoreAttention {
  private readonly records = new Map<string, AttentionRecord>();
  private readonly views = new Map<object, Map<string, { chatId: string; until: number }>>();
  private readonly listeners = new Set<() => void>();
  private readonly alertListeners = new Set<(alert: CoreAttentionAlert) => void>();
  private pending = Promise.resolve();
  private readonly path: string;
  private readonly unsubscribe: () => void;

  constructor(directory: string, service: ChatService) {
    this.path = join(directory, "core-attention.json");
    if (existsSync(this.path)) this.restore(service);
    this.unsubscribe = service.subscribeAllEvents((chatId, event) => this.observe(chatId, event));
  }
  private restore(service: ChatService): void {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(saved)) throw new Error("Invalid attention data");
      const chats = saved.map((item) => ({
        chatId: item.chatId,
        working: item.working,
        completionId: item.completionId,
        unread: item.unread,
      }));
      const parsed = CoreAttentionSnapshotSchema.parse({ kind: "core.attention.snapshot", chats });
      for (const [index, item] of parsed.chats.entries())
        if (service.getChat(item.chatId as ChatId))
          this.records.set(item.chatId, {
            ...item,
            working: false,
            notified: saved[index].notified === true,
          });
    } catch {
      process.stderr.write("Core ignored invalid completion metadata; chats are preserved.\n");
    }
  }
  snapshot(): unknown {
    return {
      kind: "core.attention.snapshot",
      chats: [...this.records.values()].map(({ chatId, working, completionId, unread }) => ({
        chatId,
        working,
        completionId,
        unread,
      })),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Alerts go to every connected browser as they happen; they are not kept. */
  onAlert(listener: (alert: CoreAttentionAlert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }
  alert(chatId: string, title: string, message: string): void {
    const alert: CoreAttentionAlert = {
      kind: "core.attention.alert",
      alertId: randomUUID(),
      chatId,
      title: title.slice(0, 120),
      message: message.slice(0, 300),
    };
    for (const listener of this.alertListeners) {
      try {
        listener(alert);
      } catch {
        process.stderr.write("Core attention alert listener failed.\n");
      }
    }
  }
  disconnect(owner: object): void {
    this.views.delete(owner);
  }
  async close(): Promise<void> {
    this.unsubscribe();
    this.listeners.clear();
    this.alertListeners.clear();
    await this.pending;
  }
  handle(owner: object, request: CoreAttentionRequest): unknown {
    if (request.kind === "core.attention.watch") return this.snapshot();
    const record = this.records.get(request.chatId);
    if (request.kind === "core.attention.read") {
      const views = this.views.get(owner) ?? new Map<string, { chatId: string; until: number }>();
      this.views.set(owner, views);
      if (request.visible)
        views.set(request.viewId, { chatId: request.chatId, until: Date.now() + 15000 });
      else views.delete(request.viewId);
      if (
        record &&
        request.visible &&
        record.completionId === request.completionId &&
        record.unread
      ) {
        record.unread = false;
        this.changed();
      }
      return this.snapshot();
    }
    return this.claim(record, request);
  }
  private claim(
    record: AttentionRecord | undefined,
    request: Extract<CoreAttentionRequest, { kind: "core.attention.claim" }>,
  ): unknown {
    const granted = Boolean(
      record?.unread && !record.notified && record.completionId === request.completionId,
    );
    if (record && granted) {
      record.notified = true;
      this.changed();
    }
    return {
      kind: "core.attention.claimed",
      chatId: request.chatId,
      completionId: request.completionId,
      granted,
    };
  }

  private observe(chatId: string, event: PiSessionEvent): void {
    if (event.kind !== "run-state") return;
    const previous = this.records.get(chatId) ?? {
      chatId,
      working: false,
      completionId: null,
      unread: false,
      notified: false,
    };
    const working = event.state === "running-unconfirmed" || event.state === "needs_attention";
    if (previous.working && event.state === "idle") {
      previous.completionId = randomUUID();
      previous.unread = ![...this.views.values()]
        .flatMap((views) => [...views.values()])
        .some((view) => view.chatId === chatId && view.until > Date.now());
      previous.notified = false;
    }
    previous.working = working;
    this.records.set(chatId, previous);
    this.changed();
  }
  private changed(): void {
    const saved = JSON.stringify([...this.records.values()]);
    this.pending = this.pending
      .then(async () => {
        await writeFile(this.path + ".tmp", saved, { mode: 0o600 });
        await rename(this.path + ".tmp", this.path);
      })
      .catch(() => {
        process.stderr.write("Core attention persistence failed.\n");
      });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        process.stderr.write("Core attention listener disconnected.\n");
      }
    }
  }
}
