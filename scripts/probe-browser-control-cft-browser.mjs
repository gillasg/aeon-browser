export async function attachPage(send, url) {
  const { targetId } = await send("Target.createTarget", { url });
  await delay(250);
  return { targetId, ...(await send("Target.attachToTarget", { targetId, flatten: true })) };
}

export async function installPageCommand(send, sessionId) {
  const expression = `(() => { window.__pippinCommand = async (scope, operation, payload) => { const pageInstanceId = crypto.randomUUID(); const grant = await chrome.runtime.sendMessage({ kind: "pippin.native.page-grant", pageInstanceId, scope }); if (!grant?.ok) throw new Error("PAGE_GRANT_FAILED"); const socket = new WebSocket(grant.endpoint); try { await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("AUTH_TIMEOUT")), 6000); socket.addEventListener("open", () => socket.send(JSON.stringify({ kind: "auth.hello", protocolVersion: grant.protocolVersion, role: "ui", clientInstanceId: grant.clientInstanceId, browserRunId: grant.browserRunId, pageInstanceId, connectionGrant: grant.connectionGrant })), { once: true }); socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.kind === "auth.ready") { clearTimeout(timer); resolve(message); } else if (message.kind === "auth.rejected") { clearTimeout(timer); reject(new Error("AUTH_REJECTED")); } }, { once: true }); socket.addEventListener("error", () => reject(new Error("AUTH_FAILED")), { once: true }); }); const requestId = crypto.randomUUID(); const done = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), 240000); socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.requestId !== requestId) return; if (message.kind === "command.completed") { clearTimeout(timer); resolve(message); } else if (["command.settled", "command.submit-failed", "command.failed"].includes(message.kind)) { clearTimeout(timer); resolve(message); } }); }); socket.send(JSON.stringify({ kind: "command", requestId, operation, payload })); return await done; } finally { socket.close(); } }; return true; })()`;
  await evaluate(send, sessionId, expression, 30_000, "install page command");
}

export async function pageValue(
  send,
  sessionId,
  expression,
  timeoutMs = 30_000,
  stage = "page evaluation",
  sensitiveValues = [],
) {
  if (typeof expression !== "string" || !expression.trim())
    throw new TypeError(`CDP expression must be a nonempty string during ${stage}`);
  return evaluate(send, sessionId, expression, timeoutMs, stage, sensitiveValues);
}

async function evaluate(
  send,
  sessionId,
  expression,
  timeoutMs = 30_000,
  stage = "page evaluation",
  sensitiveValues = [],
) {
  let response;
  try {
    response = await send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: timeoutMs,
      },
      sessionId,
    );
  } catch (error) {
    throw new Error(
      `Runtime.evaluate failed during ${stage}: ${safeDiagnosticText(error, sensitiveValues)}`,
      { cause: error },
    );
  }
  if (response.exceptionDetails)
    throw runtimeExceptionError(response.exceptionDetails, stage, sensitiveValues);
  return response.result.value;
}

function runtimeExceptionError(details, stage, sensitiveValues) {
  const exception = details.exception;
  const className = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(exception?.className ?? "")
    ? exception.className
    : "Error";
  const description =
    exception?.description?.split(/\r?\n/, 1)[0] ?? details.text ?? "page exception";
  const message = description.replace(/^[A-Za-z][A-Za-z0-9_]{0,39}:\s*/, "");
  return new Error(
    `Runtime.evaluate failed during ${stage} (${className}: ${safeDiagnosticText(message, sensitiveValues)})`,
  );
}

export async function waitUntil(read, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await read())) return;
    await delay(250);
  }
  throw new Error(message);
}

export function syntheticPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pippin synthetic browser probe</title><style>body{min-height:2400px;font:18px sans-serif;padding:32px}#bottom{margin-top:1200px;height:500px}</style></head><body><h1>Synthetic local page</h1><button id="mark" onclick="document.documentElement.dataset.marked='yes';document.getElementById('status').textContent='Marked'">Mark inspected</button><div id="status" role="status" aria-label="Inspection status">Not marked</div><label>Result <input id="result" aria-label="Result"></label><button>Ambiguous target</button><button>Ambiguous target</button><p>Safe synthetic test content.</p><div id="bottom">SCROLLED_OK</div></body></html>`;
}

export function safeFailureMessage(error) {
  return safeDiagnosticText(error instanceof Error ? error.message : "CFT browser probe failed");
}

function safeDiagnosticText(value, sensitiveValues = []) {
  let message = String(value ?? "").split(/\r?\n/, 1)[0];
  for (const sensitiveValue of sensitiveValues) {
    if (typeof sensitiveValue !== "string" || !sensitiveValue) continue;
    message = message.replaceAll(sensitiveValue, "[redacted]");
  }
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|api[_ -]?key|token|secret|password|credential)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/Reply with the exact words:[^\r\n]*/gi, "[redacted prompt]")
    .replace(/(?:https?|chrome-extension):\/\/[^\s)]+/gi, "[url]")
    .replace(/\b[A-Za-z0-9_+/-]{24,}={0,2}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export async function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
