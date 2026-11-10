// The only place a step becomes words. A value typed into a field is never included; the field's
// name is. Password and one-time-code fields are marked.

const VERBS: Readonly<Record<string, string>> = {
  click: "Click",
  fill: "Fill",
  press: "Press",
  select: "Select",
  upload: "Upload",
  navigate: "Open",
  open: "Open",
  close: "Close",
  read: "Read",
  api: "Call",
  ability: "Run",
  handoff: "Hand off",
  dialog: "Dialog",
  download: "Download",
  scroll: "Scroll",
};

const SENSITIVE =
  /password|passcode|one[- ]?time|\botp\b|verification code|security code|pin code/i;

export interface LabelTarget {
  role?: string;
  name?: string;
}

export interface LabelStep {
  kind: string;
  target?: LabelTarget;
  key?: string;
  url?: string;
  sensitive?: boolean;
}

export function isSensitive(target: LabelTarget | undefined): boolean {
  if (!target) return false;
  return SENSITIVE.test(`${target.role ?? ""} ${target.name ?? ""}`);
}

/** `Click “Place order”`, `Fill “Password” (sensitive)`, `Press Enter`. Never the typed value. */
export function labelFor(step: LabelStep): string {
  const verb = VERBS[step.kind] ?? "Do";
  if (step.kind === "press" && step.key) return pressLabel(step.key, step.target);
  const named = clean(step.target?.name);
  if (
    !named &&
    step.url &&
    (step.kind === "navigate" || step.kind === "open" || step.kind === "read")
  )
    return `${verb} ${hostOf(step.url)}`;
  if (!named) return verb;
  const text = `${verb} ${quote(named)}`;
  return step.sensitive || isSensitive(step.target) ? `${text} (sensitive)` : text;
}

export function labelForAction(step: {
  op: string;
  element?: unknown;
  key?: string;
  url?: string;
}): string {
  const target = targetOf(step.element);
  return labelFor({
    kind: kindOf(step.op),
    ...(target ? { target } : {}),
    ...(step.key ? { key: step.key } : {}),
    ...(typeof step.url === "string" ? { url: step.url } : {}),
  });
}

export function targetOf(element: unknown): LabelTarget | undefined {
  if (!element || typeof element !== "object") return undefined;
  const record = element as { role?: unknown; name?: unknown; value?: unknown; by?: unknown };
  const role = typeof record.role === "string" ? record.role : undefined;
  const fromName = typeof record.name === "string" ? record.name : undefined;
  const fromQuery =
    typeof record.value === "string" && (record.by === "label" || record.by === "placeholder")
      ? record.value
      : undefined;
  const name = fromName || fromQuery;
  if (!role && !name) return undefined;
  return { ...(role ? { role } : {}), ...(name ? { name } : {}) };
}

function pressLabel(key: string, target: LabelTarget | undefined): string {
  const name = clean(target?.name);
  const where = name ? ` in ${quote(name)}` : "";
  const marked = isSensitive(target) ? " (sensitive)" : "";
  return `Press ${key}${where}${marked}`;
}

function kindOf(op: string): string {
  if (op === "paste") return "fill";
  if (op === "keys" || op === "pointer") return "press";
  if (op === "openTab") return "open";
  if (op === "closeTab") return "close";
  if (op === "observe" || op === "snapshot" || op === "markdown" || op === "evaluate")
    return "read";
  return op;
}

function clean(name: string | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function quote(name: string): string {
  return `“${name.replace(/[“”"]/g, "")}”`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}
