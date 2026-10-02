export function isSidePanelTarget(target, extensionId) {
  try {
    const url = new URL(target.url);
    return (
      url.protocol === "chrome-extension:" &&
      url.hostname === extensionId &&
      url.pathname === "/sidepanel.html"
    );
  } catch {
    return false;
  }
}

export function summarizeExtensionTargets(targets, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const extensionTargets = targets.filter((target) => target.url.startsWith(prefix));
  return {
    targetCount: targets.length,
    extensionTargetCount: extensionTargets.length,
    extensionTargetTypes: [...new Set(extensionTargets.map((target) => target.type))].sort(),
    extensionPagePaths: [
      ...new Set(
        extensionTargets.map((target) => {
          try {
            return new URL(target.url).pathname;
          } catch {
            return "unknown";
          }
        }),
      ),
    ].sort(),
    sidePanelTargetCount: extensionTargets.filter((target) =>
      isSidePanelTarget(target, extensionId),
    ).length,
  };
}
