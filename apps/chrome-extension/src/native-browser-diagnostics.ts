interface Diagnostics {
  console: { level: string; text: string }[];
  network: { url: string; status?: number; error?: string }[];
}
const buffers = new Map<number, Diagnostics>();
const requests = new Map<string, { url: string; status?: number; error?: string }>();
const enabled = new Set<number>();
export async function enableDiagnostics(tabId: number): Promise<void> {
  if (enabled.has(tabId)) return;
  enabled.add(tabId);
  buffers.set(tabId, { console: [], network: [] });
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
    chrome.debugger.sendCommand({ tabId }, "Network.enable"),
  ]);
}
export function readDiagnostics(tabId: number, clear = false): Diagnostics {
  const buffer = buffers.get(tabId) ?? { console: [], network: [] };
  const result = structuredClone(buffer);
  if (clear) {
    buffer.console.length = 0;
    buffer.network.length = 0;
  }
  return result;
}
export function forgetDiagnostics(tabId: number): void {
  buffers.delete(tabId);
  enabled.delete(tabId);
  for (const key of requests.keys()) if (key.startsWith(tabId + ":")) requests.delete(key);
}
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  const buffer = buffers.get(source.tabId);
  if (!buffer) return;
  const params = (raw ?? {}) as Record<string, unknown>;
  if (method === "Page.javascriptDialogOpening") {
    buffer.console.push({
      level: "info",
      text: `[dialog ${String(params.type)}] ${String(params.message).slice(0, 300)} (accepted)`,
    });
    if (buffer.console.length > 80) buffer.console.shift();
    return;
  }
  if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown")
    captureConsole(buffer, method, params);
  else captureNetwork(source.tabId, buffer, method, params);
});
function captureConsole(
  buffer: Diagnostics,
  method: string,
  params: Record<string, unknown>,
): void {
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails as
      { text?: string; exception?: { description?: string } } | undefined;
    buffer.console.push({
      level: "error",
      text: String(details?.exception?.description ?? details?.text).slice(0, 1000),
    });
  } else {
    const args = params.args as { value?: unknown; description?: string }[] | undefined;
    buffer.console.push({
      level: String(params.type),
      text: (args ?? [])
        .map((arg) => String(arg.value ?? arg.description ?? ""))
        .join(" ")
        .slice(0, 1000),
    });
  }
  if (buffer.console.length > 80) buffer.console.shift();
}
function captureNetwork(
  tabId: number,
  buffer: Diagnostics,
  method: string,
  params: Record<string, unknown>,
): void {
  const key = tabId + ":" + String(params.requestId);
  if (method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string } | undefined;
    const entry = { url: String(request?.url ?? "").slice(0, 2048) };
    requests.set(key, entry);
    buffer.network.push(entry);
    if (requests.size > 800) requests.delete(requests.keys().next().value ?? "");
    if (buffer.network.length > 80) buffer.network.shift();
  } else {
    const entry = requests.get(key);
    if (!entry) return;
    if (method === "Network.responseReceived") {
      const status = (params.response as { status?: number }).status;
      if (typeof status === "number") entry.status = status;
    }
    if (method === "Network.loadingFailed") entry.error = String(params.errorText).slice(0, 300);
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(method)) requests.delete(key);
  }
}
