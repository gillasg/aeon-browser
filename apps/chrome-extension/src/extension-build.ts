// The build the running extension was loaded from. The daemon sends its own installed build in
// every heartbeat acknowledgement; when they differ, the extension reloads itself so a rebuilt
// engine never sits behind a stale service worker.

let build: string | undefined;
let loading: Promise<string | undefined> | undefined;

export function extensionBuild(): string | undefined {
  return build;
}

export function loadExtensionBuild(): Promise<string | undefined> {
  loading ??= fetch(chrome.runtime.getURL("build-info.json"))
    .then((response) => (response.ok ? response.text() : undefined))
    .then((text) => (build = text?.trim() || undefined))
    .catch(() => undefined);
  return loading;
}
