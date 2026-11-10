/** A top-level Aeon page, or one framed by another page of this extension. */
export function framedByExtension(): boolean {
  if (window.parent === window) return true;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** The orb stays inside the frame the content script opened. A top-level load stays blank. */
export function framedInPage(): boolean {
  return window.parent !== window;
}

/** /orb.html, and the per-session use_dynamic_url path /<token>/orb.html. */
export function isOrbPath(pathname: string): boolean {
  return pathname === "/orb.html" || /^\/[^/]+\/orb\.html$/.test(pathname);
}
