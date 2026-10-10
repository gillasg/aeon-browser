export function openNewChat(projectId?: string): void {
  const panel = document.body.dataset.host === "panel";
  if (panel) {
    window.parent.postMessage({ kind: "aeon.new-chat", projectId }, location.origin);
    return;
  }
  const url = new URL(chrome.runtime.getURL("home.html"));
  if (projectId) url.searchParams.set("projectId", projectId);
  location.assign(url.href);
}
