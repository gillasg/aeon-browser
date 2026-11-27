import type { AnswerFooter, AnswerReceipt } from "@graft/ui";
import { siteFacts } from "../site-facts.js";
import { ORB_SUMMON_INFO, type OrbToContent } from "./orb-messages.js";
import type { OrbSession } from "./orb-session.js";
import type { SummonInfo } from "./orb-target.js";
import type { OrbViewModel } from "./orb-view.js";
import { learnedLine } from "./orb-view-parts.js";

// The cursor box's site side: the X-Ray strip, Teach and its live count, the pointed-at target,
// and the receipt's short form on the minimised pill. Every number comes from the registry, the
// recorder or the run card.

export interface SiteUx {
  tabId: number;
  model: OrbViewModel;
  session: OrbSession;
  render(): void;
  notice(text: string): void;
  toContent(message: OrbToContent): void;
}

const LEARNED_MS = 4000;
const POLL_MS = 2500;
let poll = 0;
let learnedTimer = 0;

export async function loadXray(ux: SiteUx): Promise<void> {
  const tab = await chrome.tabs.get(ux.tabId).catch(() => undefined);
  if (!tab?.url) return;
  const facts = await siteFacts(tab.url, () => ux.session.sites()).catch(() => undefined);
  if (!facts) return;
  ux.model.xray = facts.counts;
  ux.render();
}

type LearnReply = { ok?: boolean; on?: boolean; found?: number; site?: string; error?: string };

function learnMessage(message: Record<string, unknown>): Promise<LearnReply | null> {
  return chrome.runtime.sendMessage(message).catch(() => null) as Promise<LearnReply | null>;
}

function followLearning(ux: SiteUx): void {
  clearInterval(poll);
  if (!ux.model.learning) return;
  poll = window.setInterval(() => {
    void learnMessage({ kind: "graft.learn.get", tabId: ux.tabId }).then((reply) => {
      if (!reply) return clearInterval(poll);
      if (!reply.on) {
        // Learning ended outside the orb (Chrome's debugger bar was closed): still say what
        // was learned, as Stop does.
        clearInterval(poll);
        ux.model.learning = false;
        ux.model.learnFound = 0;
        if ((reply.found ?? 0) > 0)
          showLearned(ux, learnedLine(reply.found ?? 0, reply.site || ux.model.host));
        ux.render();
        return;
      }
      if (reply.found === ux.model.learnFound) return;
      ux.model.learnFound = reply.found ?? 0;
      ux.render();
    });
  }, POLL_MS);
}

export async function loadLearning(ux: SiteUx): Promise<void> {
  const reply = await learnMessage({ kind: "graft.learn.get", tabId: ux.tabId });
  ux.model.learning = reply?.on === true;
  ux.model.learnFound = reply?.found ?? 0;
  ux.render();
  followLearning(ux);
}

/** Teach starts recording; Stop or Done ends it, says what was learned, and refreshes X-Ray. */
export async function toggleLearning(ux: SiteUx): Promise<void> {
  const on = !ux.model.learning;
  const reply = await learnMessage({ kind: "graft.learn.set", tabId: ux.tabId, on });
  if (!reply?.ok) {
    ux.notice("Couldn't start teaching this site" + (reply?.error ? " · " + reply.error : ""));
    return;
  }
  ux.model.learning = reply.on === true;
  ux.model.learnFound = 0;
  followLearning(ux);
  if (!on && (reply.found ?? 0) > 0)
    showLearned(ux, learnedLine(reply.found ?? 0, reply.site || ux.model.host));
  ux.render();
  if (!on) void loadXray(ux);
}

function showLearned(ux: SiteUx, text: string): void {
  clearTimeout(learnedTimer);
  ux.model.learned = text;
  learnedTimer = window.setTimeout(() => {
    delete ux.model.learned;
    ux.render();
  }, LEARNED_MS);
}

/** The last summon's target and form check, from the content script. */
export async function askSummon(ux: SiteUx): Promise<void> {
  const info = (await chrome.tabs
    .sendMessage(ux.tabId, { kind: ORB_SUMMON_INFO }, { frameId: 0 })
    .catch(() => null)) as SummonInfo | null;
  applySummon(ux, info ?? undefined);
}

export function applySummon(ux: SiteUx, info: SummonInfo | undefined): void {
  if (!info) return;
  ux.model.fillForm = info.fillForm === true;
  ux.session.target = info.target;
  if (info.target) ux.model.target = { label: info.target.label, title: info.target.title };
  else delete ux.model.target;
  ux.render();
}

export function removeTarget(ux: SiteUx): void {
  ux.session.target = undefined;
  delete ux.model.target;
  ux.toContent({ kind: "graft.orb.target", action: "drop" });
  ux.render();
}

export function receiptOf(footer: AnswerFooter | undefined): AnswerReceipt | undefined {
  return footer?.lines.find((line): line is AnswerReceipt => line.kind === "receipt");
}
