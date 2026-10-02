import { pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";

export async function openExtensionHome(send, extensionId) {
  const homeUrl = `chrome-extension://${extensionId}/home.html`;
  const { targetId } = await send("Target.createTarget", { url: homeUrl });
  const session = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Runtime.enable", {}, session.sessionId);
  await send("Page.enable", {}, session.sessionId);
  await waitUntil(
    () => pageValue(send, session.sessionId, "globalThis.location?.href", 3000, "home URL check"),
    (url) => url === homeUrl,
    15_000,
    "Chrome did not load the Pippin home tab",
  );
  const tabId = await pageValue(
    send,
    session.sessionId,
    "globalThis.chrome?.tabs?.getCurrent?.().then((tab) => tab?.id)",
    3000,
    "extension tab identity check",
  );
  if (!Number.isInteger(tabId)) throw new Error("Pippin home has no Chrome tab identity.");
  return { targetId, sessionId: session.sessionId, tabId };
}

export async function installHandoffTelemetry(send, sessionId) {
  await send("Runtime.addBinding", { name: "__pippinHandoffProbe" }, sessionId);
  const source = HANDOFF_TELEMETRY_SOURCE;
  await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  const installed = await send(
    "Runtime.evaluate",
    { expression: source, returnByValue: true },
    sessionId,
  );
  if (installed.exceptionDetails) throw new Error("Handoff telemetry could not be installed.");
}

const HANDOFF_TELEMETRY_SOURCE = `(() => {
    if (globalThis.__pippinHandoffProbeInstalled) return;
    globalThis.__pippinHandoffProbeInstalled = true;
    globalThis.addEventListener("error", (event)=>globalThis.__pippinHandoffProbe(JSON.stringify({source:"probe",kind:"page-error",message:event.message.slice(0,300)})));
    const report = (event) => { try { globalThis.__pippinHandoffProbe(JSON.stringify(event)); } catch {} };
    const runtime = globalThis.chrome?.runtime;
    if (runtime?.sendMessage) {
      try {
        const original = runtime.sendMessage.bind(runtime);
        Object.defineProperty(runtime, "sendMessage", { configurable: true, writable: true, value: function (...args) {
          const request = args[0];
          const tracked = ["pippin.native.open-chat", "pippin.native.take-initial-submit"].includes(request?.kind);
          if (!tracked) return original(...args);
          report({source:"extension",direction:"send",kind:request.kind,hasInitialSubmit:Boolean(request.initialSubmit),reuseCurrentTab:Boolean(request.reuseCurrentTab)});
          let result;
          try { result = original(...args); } catch (error) { report({source:"extension",direction:"error",kind:request.kind}); throw error; }
          if (!result || typeof result.then !== "function") return result;
          return result.then((response) => {
            report({source:"extension",direction:"receive",kind:request.kind,ok:Boolean(response?.ok),code:response?.code,hasRequestId:typeof response?.requestId==="string",textLength:typeof response?.text==="string"?response.text.length:0,model:response?.model&&typeof response.model.provider==="string"&&typeof response.model.id==="string"?{provider:response.model.provider,id:response.model.id}:undefined,thinkingLevel:typeof response?.thinkingLevel==="string"?response.thinkingLevel:undefined});
            return response;
          }, (error) => { report({source:"extension",direction:"error",kind:request.kind}); throw error; });
        }});
        report({source:"probe",kind:"runtime-hook-ready"});
      } catch { report({source:"probe",kind:"runtime-hook-failed"}); }
    }
    const Socket = globalThis.WebSocket;
    const send = Socket.prototype.send;
    Socket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const request = JSON.parse(data);
          if (request.kind === "chat.subscribe") report({source:"daemon",direction:"send",kind:request.kind});
          if (request.kind === "command" && ["chat.model","chat.thinking","chat.submit"].includes(request.operation)) {
            const event={source:"daemon",direction:"send",kind:request.kind,operation:request.operation};
            if (request.operation === "chat.model") event.model={provider:request.payload?.provider,id:request.payload?.id};
            if (request.operation === "chat.thinking") event.thinkingLevel=request.payload?.level;
            if (request.operation === "chat.submit") {
              const text=typeof request.payload?.text==="string"?request.payload.text:"";
              event.promptLength=text.length;
              event.promptClass=text.startsWith("Focused browser-control check:")?"browser_control_ambiguous_focused":text.startsWith("Reply with the exact words:")?"slice8_initial":text.startsWith("Call browser_control exactly once")?"browser_control_list":text.startsWith("Continue with browser_control using")?"browser_control_actions":text.length<=8?"short_unclassified":"unclassified";
            }
            report(event);
          }
        } catch {}
      }
      return send.call(this, data);
    };
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (!(this instanceof Socket) || type !== "message" || typeof listener !== "function")
        return add.call(this, type, listener, options);
      const wrapped = function (event) {
        try {
          const response = JSON.parse(String(event.data));
          if (["chat.snapshot", "chat.resumed", "chat.subscription-failed"].includes(response.kind))
            report({source:"daemon",direction:"receive",kind:response.kind,code:response.code});
          const tracked = ["chat.model","chat.thinking","chat.submit"].includes(response.operation);
          const kinds = response.operation === "chat.submit"
            ? ["command.started","command.settled","command.failed"]
            : ["command.completed","command.failed"];
          if (tracked && kinds.includes(response.kind))
            report({source:"daemon",direction:"receive",kind:response.kind,operation:response.operation,state:response.state,runState:response.runState,code:response.code,resultKind:response.result?.kind});
        } catch {}
        return listener.call(this, event);
      };
      return add.call(this, type, wrapped, options);
    };
  })();`;

export async function readAskUiCheckpoint(send, sessionId) {
  return pageValue(
    send,
    sessionId,
    `(() => {
      const classify=(value)=>{const text=String(value??"").toLowerCase();if(!text)return null;const code=text.match(/\\b(?:PI_PROMPT_FAILED|PI_UNAVAILABLE|CHAT_NOT_FOUND|INVALID_COMMAND|HOST_MISSING|HOST_CONFIG_INVALID|DAEMON_OFFLINE|UPDATE_REQUIRED|INITIAL_SUBMIT_UNAVAILABLE|CHAT_ALREADY_OPEN)\\b/);if(code)return code[0];if(/\\b(401|403)\\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication/.test(text))return "authentication";if(/\\b429\\b|rate.?limit|too many requests|quota/.test(text))return "rate_limit";if(/timeout|timed out|etimedout|econnreset|socket hang up/.test(text))return "timeout";if(/enotfound|eai_again|dns|network|fetch failed|connection refused/.test(text))return "network";if(/\\b(400|404)\\b|unsupported|invalid request|unknown model|context length/.test(text))return "request_rejected";if(/\\b5\\d\\d\\b|unavailable|internal server error|bad gateway/.test(text))return "provider_unavailable";return "other"};
      const notices=[...document.querySelectorAll(".sync-notice,#home-error")].filter((node)=>Boolean(node.textContent?.trim()));
      const errors=[...document.querySelectorAll(".message-error")];
      const texts=[...document.querySelectorAll(".message-row.assistant .message-markdown")];
      const run=document.getElementById("stop");
      return {route:location.pathname.endsWith("/chat.html")?"chat":location.pathname.endsWith("/home.html")?"home":"other",connection:document.getElementById("connection-state")?.dataset.state??document.getElementById("home-connection")?.textContent?.trim()??"missing",userRows:document.querySelectorAll(".message-row.user").length,assistantRows:document.querySelectorAll(".message-row.assistant").length,assistantTextPresent:texts.some((node)=>Boolean(node.innerText?.trim())),answerMatched:(texts.at(-1)?.innerText??"").includes("Slice 8 Pi is ready"),messageErrorPresent:errors.length>0,messageErrorClasses:errors.map((node)=>classify(node.textContent)),noticePresent:notices.length>0,noticeClasses:notices.map((node)=>classify(node.textContent)),running:Boolean(run&&!run.hidden)};
    })()`,
    10_000,
    "Ask UI checkpoint",
  );
}

export async function readPageCheckpoint(send, sessionId) {
  return pageValue(
    send,
    sessionId,
    `(() => { const notice=[...document.querySelectorAll(".sync-notice,#home-error")].find((node)=>node.textContent?.trim()); const assistant=[...document.querySelectorAll(".message-row.assistant .message-markdown")].at(-1)?.innerText?.trim()??""; const run=document.getElementById("stop"); return {route:location.pathname.endsWith("/chat.html")?"chat":location.pathname.endsWith("/home.html")?"home":"other",chatId:new URL(location.href).searchParams.get("chatId"),connection:document.getElementById("connection-state")?.dataset.state??document.getElementById("home-connection")?.textContent?.trim()??"missing",userRows:document.querySelectorAll(".message-row.user").length,assistantRows:document.querySelectorAll(".message-row.assistant").length,assistantTextPresent:Boolean(assistant),answerMatched:assistant.includes("Slice 8 Pi is ready"),running:Boolean(run&&!run.hidden),notice:notice?.textContent?.trim().slice(0,240)??""}; })()`,
    3000,
  ).catch(() => ({ route: "unavailable", connection: "unavailable" }));
}

export async function readHandoffStorage(send, workerSessionId, chatId) {
  const expectedChat = JSON.stringify(chatId ?? "");
  return pageValue(
    send,
    workerSessionId,
    `chrome.storage.session.get(null).then((values)=>{const records=Object.entries(values).filter(([key])=>key.startsWith("pippin.initial-submit."));const record=records.map(([,value])=>value).find((value)=>!${expectedChat}||value.chatId===${expectedChat});return {recordCount:records.length,matchingChat:Boolean(record),textPresent:typeof record?.text==="string",textLength:typeof record?.text==="string"?record.text.length:0,expired:typeof record?.expiresAt==="number"&&record.expiresAt<=Date.now()}})`,
    3000,
  ).catch(() => ({ available: false }));
}

export async function readPiState(send, sessionId, chatId) {
  const scope = JSON.stringify({ kind: "chat", chatId });
  const payload = JSON.stringify({ chatId });
  return pageValue(send, sessionId, piStateExpression(scope, payload), 10_000, "Pi state read");
}

function piStateExpression(scope, payload) {
  return `(async () => {
      const classify=(value)=>{const text=String(value??"").toLowerCase();if(!text)return null;if(/\\b(401|403)\\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication/.test(text))return "authentication";if(/\\b429\\b|rate.?limit|too many requests|quota/.test(text))return "rate_limit";if(/timeout|timed out|etimedout|econnreset|socket hang up/.test(text))return "timeout";if(/enotfound|eai_again|dns|network|fetch failed|connection refused/.test(text))return "network";if(/\\b(400|404)\\b|unsupported|invalid request|unknown model|context length/.test(text))return "request_rejected";if(/\\b5\\d\\d\\b|unavailable|internal server error|bad gateway/.test(text))return "provider_unavailable";return "other"};
      const controls = await window.__pippinCommand(${scope}, "chat.controls", ${payload});
      const view = await window.__pippinCommand(${scope}, "chat.get", ${payload});
      const items = view.result?.snapshot?.entries ?? [];
      return {
        controlsResult: controls.kind,
        effectiveModel: controls.result?.controls?.effectiveModel ?? null,
        availableModelCount: controls.result?.controls?.availableModels?.length ?? 0,
        thinkingLevel: controls.result?.controls?.thinkingLevel ?? null,
        active: controls.result?.controls?.active ?? null,
        viewResult: view.kind,
        runState: view.result?.snapshot?.runState ?? null,
        entries: items.map((entry) => ({
          role: entry.message?.role ?? null,
          stopReason: entry.message?.stopReason ?? null,
          contentTypes: entry.message?.content?.map((block) => block.type) ?? [],
          toolResultHasStaleReference: entry.message?.role === "tool" && (entry.message?.content ?? []).some((block) => block.type === "text" && block.text.includes("STALE_REF")),
          toolResultHasAmbiguousTarget: entry.message?.role === "tool" && (entry.message?.content ?? []).some((block) => block.type === "text" && block.text.includes("AMBIGUOUS_TARGET")),
          toolResultErrorCodes: entry.message?.role === "tool" ? [...new Set((entry.message?.content ?? []).flatMap((block) => typeof block.text === "string" ? block.text.match(/\\b(?:TARGET_LOST|AMBIGUOUS_TARGET|STALE_REF|CLAIM_CONFLICT|UNSUPPORTED|INVALID_TARGET|TIMEOUT|BROWSER_OFFLINE|DAEMON_OFFLINE|OPERATION_FAILED)\\b/g) ?? [] : []))] : [],
          contentTextLength: (entry.message?.content ?? []).reduce((length, block) =>
            length + (typeof block.text === "string" ? block.text.length : 0), 0),
          hasErrorMessage: Boolean(entry.message?.errorMessage),
          errorSummary: String(entry.message?.errorMessage ?? "").replace(/Bearer\\s+\\S+/gi,"Bearer [redacted]").replace(/sk-[A-Za-z0-9_-]+/g,"[redacted]").slice(0,400),
          errorClass: classify(entry.message?.errorMessage ?? "")
        }))
      };
    })()`;
}

export function summarizeEvents(events) {
  return events.map(summarizeEvent);
}

function summarizeEvent(event) {
  const { source, direction, kind, ...fields } = event;
  return Object.fromEntries(
    [
      ["source", source],
      ["direction", direction],
      ["kind", kind],
      ...Object.entries(fields),
    ].filter(([, value]) => value !== undefined && value !== null),
  );
}

export function redactNotice(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
}
