// The build the running extension was loaded from. The daemon sends its own installed build in
// every heartbeat acknowledgement; when they differ, the extension reloads itself so a rebuilt
// engine never sits behind a stale service worker.
//
// The build is compiled into the bundle, not read from build-info.json at run time: Chrome can
// keep running a cached service worker after the folder was rebuilt, and that worker would read
// the new file, match the daemon and never reload.

const embedded = typeof __GRAFT_BUILD_INFO__ === "string" ? __GRAFT_BUILD_INFO__.trim() : undefined;

export function extensionBuild(): string | undefined {
  return embedded || undefined;
}
