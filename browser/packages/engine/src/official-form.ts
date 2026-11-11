// Official forms fill, then stop before the last submit unless the task asked to send it.
// A shop, a search box, or any other form is not gated.

const NOT_FINAL = /^(continue|next|save draft|save|back|cancel|close)$/i;
const FINAL =
  /^(submit|declare|file|lodge|pay|pay now|send application|place order|delete|send|apply|apply now)$/i;
const REFUSAL =
  /\b(?:don't|do not|never)\b[\s\S]{0,48}\b(?:submit|send|file|pay|post|apply|declare|lodge)\b/i;
const ASK =
  /\b(?:submit|file|lodge|send|apply|pay)\b(?!\s+without\b)(?!\s+(?:stub|stubs|slip|slips|check|cheque|history|period|wall|grade|scale|roll)\b)/i;
const MULTI_SUFFIX = new Set(["co", "ac", "gov", "nic", "org", "net", "sch", "k12"]);
const PORTAL_LABEL = new Set([
  "court",
  "courts",
  "judiciary",
  "tribunal",
  "tax",
  "irs",
  "hmrc",
  "uscis",
  "visa",
  "immigration",
  "workday",
  "adp",
  "bamboohr",
  "payroll",
  "university",
  "college",
  "school",
]);
const PORTAL_DOMAIN = new Set(["myworkday.com"]);

export const OFFICIAL_FORM_STOP =
  "OFFICIAL_FORM: the form is filled and ready; the final submit was not sent. Tell the user it is ready and what was filled.";
export const IRREVERSIBLE_STOP =
  "IRREVERSIBLE: the task said not to take that step. Do not submit, send, pay or post.";

export interface OfficialFormInput {
  host: string;
  label: string;
  task: string;
  pageText?: string;
  extraHosts?: string[];
  /** Enter pressed in a form field. That sends the form even when the field is not labelled Submit. */
  fieldEnter?: boolean;
}

export function isOfficialHost(host: string, extra: readonly string[] = []): boolean {
  const name = hostName(host);
  if (!name) return false;
  if (extra.some((item) => sameHost(name, item))) return true;
  const site = registrable(name);
  return officialSuffix(site.domain) || PORTAL_DOMAIN.has(site.domain) || portalLabel(site.label);
}

export function officialHostsFromNotes(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^official\s+\S+:\s*(\S+)/i.exec(line.trim());
    if (match?.[1]) hosts.push(match[1].toLowerCase());
  }
  return hosts;
}

/** Page words that mark a form. "application" alone does not: a shop uses that word. */
export function pageSignalsOfficial(text: string): boolean {
  return /\bi hereby declare\b|\bapplication form\b|\bvisa application\b|\btax return\b|\bcourt (?:filing|form)\b|\bimmigration (?:form|application)\b|\bemployee self[- ]service\b|\binsurance (?:claim|application|form)\b|\b(?:university|school|college) (?:application|enrollment|enrolment)\b|\bpayroll (?:form|portal)\b/i.test(
    text,
  );
}

/** An ask verb (submit, file, send, apply, pay) used as the ask. A noun, or "without", is not one. */
export function taskAsksSubmit(task: string): boolean {
  if (REFUSAL.test(task)) return false;
  const text = task.replace(/\bapply\s+(?:the|this|a|an|my|these|those)\b/gi, " ");
  if (/\bplace(?:\s+an|\s+the)?\s+order\b/i.test(text)) return true;
  return ASK.test(text);
}

export function isFinalSubmit(label: string): boolean {
  const text = label.trim().replace(/\s+/g, " ");
  if (!text || NOT_FINAL.test(text)) return false;
  if (FINAL.test(text)) return true;
  return /\b(submit|i hereby declare|place order|pay now|send application)\b/i.test(text);
}

export function officialSubmitStop(input: OfficialFormInput): string | undefined {
  if (!input.fieldEnter && !isFinalSubmit(input.label)) return undefined;
  if (REFUSAL.test(input.task)) return IRREVERSIBLE_STOP;
  const official =
    isOfficialHost(input.host, input.extraHosts ?? []) || pageSignalsOfficial(input.pageText ?? "");
  if (official && !taskAsksSubmit(input.task)) return OFFICIAL_FORM_STOP;
  return undefined;
}

export function unaskedIrreversible(task: string, text: string): string | undefined {
  if (taskAsksSubmit(task)) return undefined;
  if (
    /\b(i'll|i will|now i'll|let me|i am going to|i'm going to)\b[\s\S]{0,48}\b(submit|send|pay|post|file|declare|place order)\b/i.test(
      text,
    )
  )
    return "the task did not ask for that irreversible step; do not announce or perform it";
  return undefined;
}

function hostName(host: string): string {
  return (
    host
      .toLowerCase()
      .replace(/^www\./, "")
      .split("/")[0]
      ?.split(":")[0] ?? ""
  );
}

function registrable(host: string): { domain: string; label: string } {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return { domain: labels.join("."), label: labels[0] ?? "" };
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const multi = tld.length === 2 && MULTI_SUFFIX.has(second) && labels.length >= 3;
  const size = multi ? 3 : 2;
  const domainLabels = labels.slice(-size);
  return { domain: domainLabels.join("."), label: domainLabels[0] ?? "" };
}

function officialSuffix(domain: string): boolean {
  return /(?:^|\.)(?:gov(?:\.[a-z]{2})?|nic\.in|edu(?:\.[a-z]{2})?|ac\.in|ac\.uk|mil|k12\.[a-z]{2}|sch\.[a-z]{2})$/i.test(
    domain,
  );
}

function portalLabel(label: string): boolean {
  if (PORTAL_LABEL.has(label)) return true;
  return label.split("-").some((part) => part === "bank" || part === "insurance");
}

function sameHost(name: string, extra: string): boolean {
  const item = extra.toLowerCase().replace(/^www\./, "");
  return Boolean(item) && (name === item || name.endsWith(`.${item}`));
}
