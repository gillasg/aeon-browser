import { CompanionResultSchema, type CompanionRequest } from "@aeon/protocol";

// Site Boosts (and other extensions the user allows) can use Aeon: write boosts with the user's
// model, or hand Aeon a task such as watching a price. Each extension is allowed once by the user;
// requests go to core over the executor connection.

const ALLOWED_KEY = "companionExtensions";
/** Site Boosts in development builds; store builds ask like any other extension. */
const TRUSTED = new Set(["kcfodpkdfapojnbhkgdlpkikipneejpf"]);
const APPROVAL_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 180_000;
const FORWARDED = new Set(["model.complete", "watch", "task"]);

interface CompanionMessage {
  type?: string;
  kind?: string;
  data?: Record<string, unknown>;
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };
type Socket = Pick<WebSocket, "send" | "readyState">;

const waiting = new Map<string, (reply: Reply) => void>();

/** Results from core; returns whether the message was one. */
export function handleCompanionResult(candidate: unknown): boolean {
  const result = CompanionResultSchema.safeParse(candidate);
  if (!result.success) return false;
  const done = waiting.get(result.data.requestId);
  waiting.delete(result.data.requestId);
  done?.(
    result.data.ok
      ? { ok: true, value: result.data.value }
      : { ok: false, error: result.data.error ?? "Aeon could not do that" },
  );
  return true;
}

function askUser(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const notificationId = `companion-${id}-${Date.now()}`;
    const done = (allowed: boolean): void => {
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      void chrome.notifications.clear(notificationId);
      resolve(allowed);
    };
    const onButton = (clicked: string, index: number): void => {
      if (clicked === notificationId) done(index === 0);
    };
    const onClosed = (closed: string): void => {
      if (closed === notificationId) done(false);
    };
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
    chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("aeon-icon-128.png"),
      title: "Let another extension use Aeon?",
      message: "An extension wants to use your AI model and ask Aeon to do tasks for you.",
      buttons: [{ title: "Allow" }, { title: "Don't allow" }],
      requireInteraction: true,
    });
    setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
  });
}

async function permitted(id: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(ALLOWED_KEY);
  const allowed = new Set((stored[ALLOWED_KEY] as string[] | undefined) ?? []);
  if (TRUSTED.has(id) || allowed.has(id)) return true;
  if (!(await askUser(id))) return false;
  allowed.add(id);
  await chrome.storage.local.set({ [ALLOWED_KEY]: [...allowed] });
  return true;
}

function forward(socket: Socket, request: CompanionRequest): Promise<Reply> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(request.requestId);
      resolve({ ok: false, error: "Aeon did not answer in time" });
    }, REQUEST_TIMEOUT_MS);
    waiting.set(request.requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    socket.send(JSON.stringify(request));
  });
}

async function handle(
  message: CompanionMessage,
  senderId: string,
  connect: () => Promise<Socket>,
): Promise<Reply> {
  if (message.kind === "ping")
    return { ok: true, value: { name: "Aeon", features: ["model", "watch", "task"] } };
  if (!FORWARDED.has(String(message.kind)))
    return { ok: false, error: `Unsupported request: ${String(message.kind)}` };
  if (!(await permitted(senderId)))
    return { ok: false, error: "The user did not allow this extension to use Aeon" };
  const socket = await connect();
  return forward(socket, {
    kind: "companion.request",
    requestId: crypto.randomUUID(),
    from: senderId,
    request: message.kind as CompanionRequest["request"],
    data: message.data ?? {},
  });
}

export function listenToCompanions(connect: () => Promise<Socket>): void {
  chrome.runtime.onMessageExternal.addListener((message: CompanionMessage, sender, reply) => {
    if (message?.type !== "site-boosts" || !sender.id || !/^[a-p]{32}$/.test(sender.id))
      return false;
    void handle(message, sender.id, connect).then(reply, (error: unknown) =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
