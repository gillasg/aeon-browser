// Store builds declare history, bookmarks, clipboardRead, contentSettings, privacy and
// tabCapture as optional permissions. A call that needs one asks for it here, on demand.

export type OptionalPermission =
  "history" | "bookmarks" | "clipboardRead" | "contentSettings" | "privacy" | "tabCapture";

/** Resolves once the permission is held; asks Chrome for it first when it is not. */
export async function needPermission(permission: OptionalPermission): Promise<void> {
  const api = globalThis.chrome?.permissions;
  if (!api) return;
  const wanted = { permissions: [permission] as chrome.runtime.ManifestPermission[] };
  if (await api.contains(wanted).catch(() => true)) return;
  if (await api.request(wanted).catch(() => false)) return;
  throw new Error(
    `PERMISSION_NEEDED: allow "${permission}" for Graft in chrome://extensions → Details → Permissions`,
  );
}
