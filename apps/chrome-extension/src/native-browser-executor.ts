import { browserErrorDetail } from "./native-browser-errors.js";
import { handleScriptSync } from "./site-script-runtime.js";
import { performExtra } from "./native-browser-extra.js";
import { navigateReady } from "./native-browser-navigation.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import {
  BrowserExecutorRequestSchema,
  BrowserExecutorResultSchema,
  BrowserOperationResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserStep,
  type BrowserTargetKey,
} from "@pippin/protocol";
import { currentInventoryTabs, refreshInventoryTab } from "./native-inventory-client.js";
import {
  errorCode,
  safePage,
  sameIdentity,
  sameTarget,
  targetIdentity,
} from "./native-browser-common.js";
import { performAction } from "./native-browser-actions.js";
import { captureScreenshot, observeSemantic } from "./native-browser-observation.js";
import type { BrowserIdentity } from "./native-worker-identity.js";
import { bindBrowserSession } from "./native-browser-session.js";
import {
  handleBrowserRelease,
  registerBrowserRequest,
  assertRequestActive,
  completeBrowserRequest,
} from "./native-browser-request-lifecycle.js";
export { releaseBrowserExecutor } from "./native-browser-request-lifecycle.js";

const claimGenerations = new Map<string, number>();
const usedClaims = new Set<string>();
const targetChains = new Map<string, Promise<BrowserExecutorResult>>();

export function handleBrowserExecutorMessage(
  identity: BrowserIdentity,
  socket: WebSocket,
  candidate: unknown,
): boolean {
  if (handleScriptSync(candidate) || handleBrowserRelease(candidate)) return true;
  const request = BrowserExecutorRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  registerBrowserRequest(request.data);
  if (needsClaim(request.data.step) && !claimIsFresh(request.data))
    return respondFailure(socket, request.data, "CLAIM_CONFLICT");
  const work = isTargetStep(request.data.step)
    ? enqueueTarget(request.data.step.target, () => executeStep(identity, request.data))
    : executeStep(identity, request.data);
  void work.then(
    (result) => sendResult(socket, request.data, result),
    (error: unknown) =>
      sendFailure(socket, request.data, errorCode(error), browserErrorDetail(error)),
  );
  return true;
}

function needsClaim(step: BrowserStep): boolean {
  return step.op !== "listTabs" && step.op !== "openTab";
}

function claimIsFresh(request: BrowserExecutorRequest): boolean {
  if (
    !request.claimId ||
    !request.claimGeneration ||
    request.step.op === "listTabs" ||
    request.step.op === "openTab" ||
    request.step.op === "attachTab"
  )
    return false;
  const key = targetIdentity(request.step.target);
  const previous = claimGenerations.get(key) ?? 0;
  if (request.claimGeneration <= previous || usedClaims.has(request.claimId)) return false;
  usedClaims.add(request.claimId);
  if (usedClaims.size > 2048) usedClaims.delete(usedClaims.values().next().value as string);
  return true;
}

async function executeStep(
  identity: BrowserIdentity,
  request: BrowserExecutorRequest,
): Promise<BrowserExecutorResult> {
  const step = request.step;
  assertRequestActive(request);
  if (step.op === "listTabs") return listTabs(step.query);
  if (step.op === "openTab") return openTab(identity, request);
  if (step.op === "attachTab") throw new Error("UNSUPPORTED");
  activateClaim(request);
  const tab = await assertTarget(request);
  bindBrowserSession(step.target.tabId, request.chatId);
  if (step.op === "observe")
    return step.kind === "semantic"
      ? observeSemantic(request, tab, revalidateTarget)
      : captureScreenshot(request, tab, revalidateTarget);
  if (step.op === "click" || step.op === "fill" || step.op === "scroll")
    return performAction({ ...request, step }, revalidateTarget);
  if (isExtraStep(step)) return performExtra({ ...request, step }, revalidateTarget);
  throw new Error("UNSUPPORTED");
}

function listTabs(query: string | undefined): BrowserExecutorResult {
  const tabs = currentInventoryTabs().filter((tab) => safePage(tab.url));
  const filtered = query
    ? tabs.filter((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(query.toLowerCase()))
    : tabs;
  return BrowserExecutorResultSchema.parse({ kind: "tabs", tabs: filtered.slice(0, 256) });
}

async function openTab(
  identity: BrowserIdentity,
  request: BrowserExecutorRequest,
): Promise<BrowserExecutorResult> {
  const step = validOpenTab(request, identity);
  const created = await chrome.tabs.create({ url: "about:blank", active: step.foreground });
  if (created.id === undefined) throw new Error("TARGET_LOST");
  bindBrowserSession(created.id, request.chatId);
  await withBrowserDebugger(created.id, () => navigateReady(created.id as number, step.url));
  assertRequestActive(request);
  const tab = await refreshInventoryTab(created.id);
  if (!tab || !sameIdentity(tab.target, identity)) throw new Error("TARGET_LOST");
  return BrowserExecutorResultSchema.parse({ kind: "tab", tab });
}

function validOpenTab(
  request: BrowserExecutorRequest,
  identity: BrowserIdentity,
): Extract<BrowserStep, { op: "openTab" }> {
  if (
    request.step.op !== "openTab" ||
    request.step.clientInstanceId !== identity.clientInstanceId ||
    !safePage(request.step.url)
  )
    throw new Error("INVALID_TARGET");
  return request.step;
}

async function assertTarget(request: BrowserExecutorRequest): Promise<chrome.tabs.Tab> {
  if (!isTargetStep(request.step)) throw new Error("INVALID_TARGET");
  const target = request.step.target;
  const known = currentInventoryTabs().find((tab) => sameTarget(tab.target, target));
  if (!inventoryMatchesRequest(known, request)) throw new Error("TARGET_LOST");
  const live = await chrome.tabs.get(target.tabId).catch(() => undefined);
  if (!live?.url || !safePage(live.url)) throw new Error("TARGET_LOST");
  const refreshed = await refreshInventoryTab(target.tabId);
  if (!inventoryMatchesRequest(refreshed, request)) throw new Error("TARGET_LOST");
  return live;
}

function inventoryMatchesRequest(
  tab: ReturnType<typeof currentInventoryTabs>[number] | undefined,
  request: BrowserExecutorRequest,
): boolean {
  return Boolean(
    tab &&
    isTargetStep(request.step) &&
    sameTarget(tab.target, request.step.target) &&
    tab.documentEpoch === request.expectedDocumentEpoch &&
    safePage(tab.url),
  );
}

async function isLivePage(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(tab?.url && safePage(tab.url));
}

async function revalidateTarget(request: BrowserExecutorRequest, tabId: number): Promise<void> {
  assertClaimActive(request);
  if (!isTargetStep(request.step) || request.step.target.tabId !== tabId)
    throw new Error("INVALID_TARGET");
  const current = await refreshInventoryTab(tabId);
  if (!inventoryMatchesRequest(current, request)) throw new Error("TARGET_LOST");
  if (!(await isLivePage(tabId))) throw new Error("TARGET_LOST");
}

function activateClaim(request: BrowserExecutorRequest): void {
  if (!isTargetStep(request.step) || !request.claimGeneration || !request.claimId)
    throw new Error("CLAIM_CONFLICT");
  const key = targetIdentity(request.step.target);
  if (request.claimGeneration <= (claimGenerations.get(key) ?? 0))
    throw new Error("CLAIM_CONFLICT");
  claimGenerations.set(key, request.claimGeneration);
}

function assertClaimActive(request: BrowserExecutorRequest): void {
  assertRequestActive(request);
  if (!isTargetStep(request.step) || !request.claimGeneration) throw new Error("CLAIM_CONFLICT");
  if (claimGenerations.get(targetIdentity(request.step.target)) !== request.claimGeneration)
    throw new Error("CLAIM_CONFLICT");
}

function enqueueTarget(
  target: BrowserTargetKey,
  action: () => Promise<BrowserExecutorResult>,
): Promise<BrowserExecutorResult> {
  const key = targetIdentity(target);
  const previous = targetChains.get(key) ?? Promise.resolve(undefined);
  const current = previous.catch(() => undefined).then(action);
  targetChains.set(key, current);
  const cleanup = () => {
    if (targetChains.get(key) === current) targetChains.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}

type TargetStep = Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>;
function isTargetStep(step: BrowserStep): step is TargetStep {
  return !["listTabs", "openTab", "attachTab"].includes(step.op);
}
function isExtraStep(
  step: BrowserStep,
): step is Extract<
  BrowserStep,
  { op: "press" | "read" | "wait" | "navigate" | "diagnostics" | "siteScript" | "popups" }
> {
  return ["press", "read", "wait", "navigate", "diagnostics", "siteScript", "popups"].includes(
    step.op,
  );
}

function sendResult(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  result: BrowserExecutorResult,
): void {
  completeBrowserRequest(request);
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        ok: true,
        result,
      }),
    ),
  );
}

function sendFailure(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  code: string,
  detail?: string,
): void {
  completeBrowserRequest(request);
  if (socket.readyState !== WebSocket.OPEN) return;
  const safe = [
    "TARGET_LOST",
    "AMBIGUOUS_TARGET",
    "TARGET_NOT_FOUND",
    "TARGET_HIDDEN",
    "TARGET_DISABLED",
    "TARGET_BLOCKED",
    "NOT_EDITABLE",
    "INPUT_FAILED",
    "STALE_REF",
    "CLAIM_CONFLICT",
    "UNSUPPORTED",
    "INVALID_TARGET",
    "TIMEOUT",
    "BROWSER_OFFLINE",
    "DAEMON_OFFLINE",
    "OPERATION_FAILED",
  ].includes(code)
    ? code
    : "OPERATION_FAILED";
  socket.send(
    JSON.stringify(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        ok: false,
        code: safe,
        ...(detail ? { detail } : {}),
      }),
    ),
  );
}

function respondFailure(socket: WebSocket, request: BrowserExecutorRequest, code: string): true {
  sendFailure(socket, request, code);
  return true;
}
