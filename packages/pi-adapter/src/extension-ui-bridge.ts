import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiExtensionUiNotice, PiExtensionUiRequest, PiSessionEvent } from "@aeon/domain";

type DialogValue = string | boolean | null;
interface PendingDialog {
  request: PiExtensionUiRequest;
  resolve(value: string | boolean | undefined): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

export class ExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly notices: PiExtensionUiNotice[] = [];
  private readonly listeners = new Set<(event: PiSessionEvent) => void>();
  readonly context: ExtensionUIContext;

  constructor(session: AgentSession) {
    const base = session.extensionRunner.getUIContext();
    this.context = {
      ...base,
      select: (title, options, opts) =>
        this.request(
          {
            kind: "select",
            title,
            message: null,
            options: options.slice(0, 64).map((item) => item.slice(0, 200)),
            placeholder: null,
            prefill: null,
          },
          opts?.timeout,
          opts?.signal,
        ) as Promise<string | undefined>,
      confirm: (title, message, opts) =>
        this.request(
          {
            kind: "confirm",
            title,
            message: message.slice(0, 1000),
            options: [],
            placeholder: null,
            prefill: null,
          },
          opts?.timeout,
          opts?.signal,
        ) as Promise<boolean>,
      input: (title, placeholder, opts) =>
        this.request(
          {
            kind: "input",
            title,
            message: null,
            options: [],
            placeholder: placeholder?.slice(0, 200) ?? null,
            prefill: null,
          },
          opts?.timeout,
          opts?.signal,
        ) as Promise<string | undefined>,
      editor: (title, prefill) =>
        this.request({
          kind: "editor",
          title,
          message: null,
          options: [],
          placeholder: null,
          prefill: prefill?.slice(0, 20_000) ?? null,
        }) as Promise<string | undefined>,
      notify: (message, type = "info") => this.notify(message, type),
      custom: async <T>() => {
        this.unsupported();
        return undefined as T;
      },
    };
    session.extensionRunner.setUIContext(this.context, "rpc");
  }

  snapshot(): { dialogs: PiExtensionUiRequest[]; notices: PiExtensionUiNotice[] } {
    return {
      dialogs: [...this.pending.values()].map(({ request }) => request),
      notices: [...this.notices],
    };
  }

  respond(requestId: string, value: DialogValue): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || !isValidAnswer(pending.request, value)) return false;
    this.finish(pending, value ?? undefined);
    return true;
  }

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const pending of [...this.pending.values()])
      this.finish(pending, defaultAnswer(pending.request));
    this.listeners.clear();
  }

  private request(
    candidate: Omit<PiExtensionUiRequest, "requestId" | "expiresAt">,
    requestedTimeout?: number,
    signal?: AbortSignal,
  ): Promise<string | boolean | undefined> {
    if (signal?.aborted || this.pending.size >= 8) return Promise.resolve(defaultAnswer(candidate));
    const timeout = Math.max(1000, Math.min(requestedTimeout ?? 120_000, 900_000));
    const request: PiExtensionUiRequest = {
      ...candidate,
      requestId: randomUUID(),
      title: candidate.title.slice(0, 200),
      expiresAt: new Date(Date.now() + timeout).toISOString(),
    };
    return new Promise((resolve) => {
      const pending: PendingDialog = {
        request,
        resolve,
        timer: setTimeout(() => this.finish(pending, defaultAnswer(request)), timeout),
        ...(signal ? { signal } : {}),
      };
      pending.abort = () => this.finish(pending, defaultAnswer(request));
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.pending.set(request.requestId, pending);
      this.emit({ kind: "extension-ui-request", request });
    });
  }

  private finish(pending: PendingDialog, value: string | boolean | undefined): void {
    if (!this.pending.delete(pending.request.requestId)) return;
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(value);
    this.emit({ kind: "extension-ui-resolved", requestId: pending.request.requestId });
  }

  private notify(message: string, type: "info" | "warning" | "error"): void {
    const notice: PiExtensionUiNotice = {
      noticeId: randomUUID(),
      message: message.slice(0, 300),
      type,
      createdAt: new Date().toISOString(),
    };
    this.notices.push(notice);
    this.notices.splice(0, Math.max(0, this.notices.length - 10));
    this.emit({ kind: "extension-ui-notice", notice });
  }

  private unsupported(): undefined {
    this.notify(
      "This extension requested custom terminal UI. Aeon supports select, confirm, input, and editor dialogs.",
      "warning",
    );
    return undefined;
  }

  private emit(event: PiSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function defaultAnswer(request: Pick<PiExtensionUiRequest, "kind">): string | boolean | undefined {
  return request.kind === "confirm" ? false : undefined;
}

function isValidAnswer(request: PiExtensionUiRequest, value: DialogValue): boolean {
  if (value === null) return true;
  if (request.kind === "confirm") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return request.kind === "input" || request.kind === "editor" || request.options.includes(value);
}
