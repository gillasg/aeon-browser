// Callers wire this straight to buttons, so the first argument can be a click event: only a
// string is a project id.
export function openNewChat(projectId?: unknown): void {
  const project = typeof projectId === "string" && projectId ? projectId : undefined;
  const panel = document.body.dataset.host === "panel";
  if (panel) {
    window.parent.postMessage({ kind: "aeon.new-chat", projectId: project }, location.origin);
    return;
  }
  const url = new URL(chrome.runtime.getURL("home.html"));
  if (project) url.searchParams.set("projectId", project);
  location.assign(url.href);
}
