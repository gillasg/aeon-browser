import { summarize, type OrbRun } from "./orb-run.js";

// Renders the bubble from plain state. No framework: the bubble is small and loads in every
// page it's summoned on.

export interface OrbViewModel {
  host: string;
  prompt: string;
  run: OrbRun | undefined;
  notice: string;
  busy: boolean;
}

export interface OrbViewActions {
  submit(text: string): void;
  close(): void;
  stop(): void;
  again(): void;
  watch(): void;
  openChat(): void;
}

export function renderView(root: HTMLElement, model: OrbViewModel, actions: OrbViewActions): void {
  root.replaceChildren(header(model.host, actions), body(model, actions));
}

function header(host: string, actions: OrbViewActions): HTMLElement {
  const bar = element("div", "bar");
  const title = element("span", "title");
  title.append(element("b", "", "Aeon"), document.createTextNode(host ? " · " + host : ""));
  const close = button("✕", "icon", actions.close);
  close.title = "Close (Esc)";
  bar.append(title, close);
  return bar;
}

function body(model: OrbViewModel, actions: OrbViewActions): HTMLElement {
  const run = model.run;
  if (!run) return compose(model, actions);
  if (run.status === "done") return card(model, actions);
  if (run.status === "error") return failure(run.error ?? "The run failed.", actions);
  if (run.status === "needs") return needs(run, actions);
  return progress(model.prompt, run, actions);
}

function compose(model: OrbViewModel, actions: OrbViewActions): HTMLElement {
  const box = element("div", "compose");
  const input = document.createElement("textarea");
  input.id = "prompt";
  input.rows = 2;
  input.placeholder = "Ask Aeon to do something on this page…";
  input.disabled = model.busy;
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (input.value.trim()) actions.submit(input.value.trim());
  });
  const hint = element("div", "hint");
  hint.append(
    element("span", "", model.notice || "Enter to send · Esc to close"),
    element("span", "chip", "This page"),
  );
  if (model.notice) hint.classList.add("warn");
  box.append(input, hint);
  return box;
}

function progress(prompt: string, run: OrbRun, actions: OrbViewActions): HTMLElement {
  const box = element("div", "progress");
  const steps = run.steps.length;
  box.append(
    element("div", "asked", prompt),
    element("div", "status shimmer", run.label),
    element("div", "meta", steps ? `${steps} step${steps === 1 ? "" : "s"} so far` : ""),
    row(button("Stop", "ghost", actions.stop), button("Open chat", "ghost", actions.openChat)),
  );
  return box;
}

function needs(run: OrbRun, actions: OrbViewActions): HTMLElement {
  const box = element("div", "needs");
  box.append(
    element("div", "status", run.dialog?.title || "Aeon needs you"),
    element(
      "div",
      "meta",
      run.dialog?.message ?? "Take a look at the highlighted part of the page.",
    ),
    row(button("Answer in chat", "primary", actions.openChat)),
  );
  return box;
}

function card(model: OrbViewModel, actions: OrbViewActions): HTMLElement {
  const run = model.run as OrbRun;
  const box = element("div", "card");
  box.append(
    element("div", "done", "✓ Done"),
    element("div", "answer", run.answer || "Finished."),
    element("div", "meta", summarize(run)),
    row(
      button("Run again", "primary", actions.again),
      button("Watch", "ghost", actions.watch),
      button("Open chat", "ghost", actions.openChat),
    ),
  );
  return box;
}

function failure(message: string, actions: OrbViewActions): HTMLElement {
  const box = element("div", "card");
  box.append(
    element("div", "failed", "Something went wrong"),
    element("div", "answer", message),
    row(
      button("Try again", "primary", actions.again),
      button("Open chat", "ghost", actions.openChat),
    ),
  );
  return box;
}

function row(...buttons: HTMLElement[]): HTMLElement {
  const actions = element("div", "actions");
  actions.append(...buttons);
  return actions;
}

function button(label: string, kind: string, onClick: () => void): HTMLButtonElement {
  const node = element("button", kind, label) as HTMLButtonElement;
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
