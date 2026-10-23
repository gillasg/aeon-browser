import type { DaemonUiResponse } from "@aeon/protocol";
import type {
  ModelAccountsProps,
  ModelAccountsState,
  ModelProvider,
  ModelSignInFlow,
} from "@aeon/ui";

// The Models tab. Core runs the sign-in service on 127.0.0.1 (the same one Pi apps use) and hands
// this page its address and token; the page talks to it directly and follows its live updates.

type Command = (request: Record<string, unknown>) => Promise<DaemonUiResponse>;
interface Endpoint {
  origin: string;
  token: string;
}
type LoginEvent = { type: string } & Record<string, unknown>;

export class HomeModelAccounts {
  private state: ModelAccountsState | null = null;
  private flow: ModelSignInFlow | null = null;
  private error = "";
  private endpoint: Endpoint | undefined;
  private changes: EventSource | undefined;
  private login: { id: string; source: EventSource } | undefined;
  private shown = false;

  constructor(
    private readonly command: Command,
    private readonly onChange: () => void,
    /** Runs after a sign-in, sign-out or default change, so the model pickers catch up. */
    private readonly onModelsChanged: () => void,
  ) {}

  viewProps(): ModelAccountsProps {
    return {
      state: this.state,
      flow: this.flow,
      error: this.error,
      onShow: () => void this.show(),
      onHide: () => this.hide(),
      onStart: (provider, method) => void this.start(provider, method),
      onAnswer: (promptId, value) =>
        void this.call(`logins/${this.login?.id ?? ""}/answer`, { promptId, value }),
      onCancel: () => void this.call(`logins/${this.login?.id ?? ""}/cancel`, {}),
      onCloseFlow: () => this.closeFlow(),
      onSignOut: (provider) => void this.signOut(provider),
      onDefaultModel: (choice) => void this.call("default-model", choice ?? {}),
      onOpenUrl: (url) => void chrome.tabs.create({ url }),
    };
  }

  /** After the page (re)connects to core: the page may have opened before it could ask. */
  refresh(): void {
    if (this.shown) void this.reload();
  }

  private async show(): Promise<void> {
    this.shown = true;
    await this.reload();
  }

  private hide(): void {
    this.shown = false;
    this.changes?.close();
    this.changes = undefined;
  }

  /** Reads the providers and keeps a live stream open, which also keeps the service running. */
  private async reload(): Promise<void> {
    try {
      this.state = toState(await this.api("state"));
      this.error = "";
      if (this.shown && !this.changes) this.follow();
    } catch (error) {
      this.error = message(error);
    }
    this.onChange();
  }

  private follow(): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    const source = new EventSource(`${endpoint.origin}/api/events?token=${endpoint.token}`);
    source.addEventListener("state", () => {
      void this.reload();
      this.onModelsChanged();
    });
    // The service stops when idle; the next action asks core to start it again.
    source.onerror = () => {
      source.close();
      if (this.changes === source) this.changes = undefined;
      this.endpoint = undefined;
    };
    this.changes = source;
  }

  private async start(provider: ModelProvider, method: "oauth" | "api_key"): Promise<void> {
    this.login?.source.close();
    this.flow = { provider, method, notes: [] };
    this.onChange();
    try {
      const { id } = (await this.api("logins", { provider: provider.id, method })) as {
        id: string;
      };
      const endpoint = await this.connect();
      const source = new EventSource(
        `${endpoint.origin}/api/logins/${id}/events?token=${endpoint.token}`,
      );
      source.addEventListener("login", (event) =>
        this.onLoginEvent(JSON.parse((event as MessageEvent<string>).data) as LoginEvent),
      );
      this.login = { id, source };
    } catch (error) {
      this.onLoginEvent({ type: "error", message: message(error) });
    }
  }

  private onLoginEvent(event: LoginEvent): void {
    if (!this.flow) return;
    if (event.type === "auth_url" && typeof event.url === "string")
      void chrome.tabs.create({ url: event.url });
    this.flow = applyLoginEvent(this.flow, event);
    if (this.flow.result) {
      this.login?.source.close();
      this.login = undefined;
      if (this.flow.result.kind === "done") this.onModelsChanged();
    }
    this.onChange();
  }

  private closeFlow(): void {
    this.login?.source.close();
    this.login = undefined;
    this.flow = null;
    this.onChange();
    void this.reload();
  }

  private async signOut(provider: ModelProvider): Promise<void> {
    if (!confirm(`Sign out of ${provider.name}? Aeon and other Pi apps will stop using it.`))
      return;
    await this.call("logout", { provider: provider.id });
  }

  private async call(path: string, body: unknown): Promise<void> {
    try {
      await this.api(path, body);
      this.error = "";
    } catch (error) {
      this.error = message(error);
    }
    this.onChange();
  }

  /** One request; when the service went idle in between, start it again and retry once. */
  private async api(path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.request(await this.connect(), path, body);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      this.endpoint = undefined;
      return this.request(await this.connect(), path, body);
    }
  }

  private async request(endpoint: Endpoint, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${endpoint.origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-aeon-login-token": endpoint.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
  }

  private async connect(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint;
    const response = await this.command({ operation: "chat.model-login", payload: {} });
    if (response.kind !== "command.completed" || response.result.kind !== "chat.model-login")
      throw new Error("Aeon could not start sign-in. Is Aeon running?");
    this.endpoint = endpointFrom(response.result.url);
    return this.endpoint;
  }
}

export function endpointFrom(url: string): Endpoint {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  if (!token) throw new Error("Aeon's sign-in service sent no token.");
  return { origin: parsed.origin, token };
}

function toState(data: unknown): ModelAccountsState {
  const value = data as {
    providers?: ModelProvider[];
    models?: ModelAccountsState["models"];
    defaultModel?: ModelAccountsState["defaultModel"];
  };
  return {
    providers: value.providers ?? [],
    models: value.models ?? [],
    ...(value.defaultModel ? { defaultModel: value.defaultModel } : {}),
  };
}

/** Folds one event from the sign-in stream into what the page shows. */
export function applyLoginEvent(flow: ModelSignInFlow, event: LoginEvent): ModelSignInFlow {
  const text = (key: string): string => (typeof event[key] === "string" ? event[key] : "");
  switch (event.type) {
    case "info": {
      const links = Array.isArray(event.links)
        ? (event.links as { url: string; label?: string }[])
        : undefined;
      return {
        ...flow,
        notes: [...flow.notes, { message: text("message"), ...(links ? { links } : {}) }],
      };
    }
    case "auth_url":
      return {
        ...flow,
        authUrl: {
          url: text("url"),
          ...(text("instructions") ? { instructions: text("instructions") } : {}),
        },
      };
    case "device_code":
      return {
        ...flow,
        deviceCode: { userCode: text("userCode"), verificationUri: text("verificationUri") },
      };
    case "progress":
      return { ...flow, progress: text("message") };
    case "prompt":
      return { ...flow, prompt: event as unknown as NonNullable<ModelSignInFlow["prompt"]> };
    case "prompt_closed":
      return flow.prompt?.promptId === text("promptId") ? withoutPrompt(flow) : flow;
    default:
      return finished(flow, event);
  }
}

function finished(flow: ModelSignInFlow, event: LoginEvent): ModelSignInFlow {
  const message = typeof event.message === "string" ? event.message : "Sign-in failed";
  if (event.type === "done") return { ...withoutPrompt(flow), result: { kind: "done" } };
  if (event.type === "cancelled") return { ...withoutPrompt(flow), result: { kind: "cancelled" } };
  if (event.type === "error") return { ...withoutPrompt(flow), result: { kind: "error", message } };
  return flow;
}

function withoutPrompt(flow: ModelSignInFlow): ModelSignInFlow {
  const rest = { ...flow };
  delete rest.prompt;
  return rest;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
