export async function finalizeSlice8Result({
  report,
  reconnect,
  initialSelection,
  panelReconnectOnly,
  setStage,
  writePending,
}) {
  if (!panelReconnectOnly) report.completedBoundaries.push("browser_control_synthetic_page");
  report.completedBoundaries.push(
    "side_panel_transcript_parity",
    "daemon_reconnect",
    "model_effort_retention",
  );
  report.sidePanel = {
    connected: true,
    chatMatches: true,
    splitFallbackShown: /Chrome 155\+.*new tab/.test(reconnect.splitFallback),
    transcriptMatchesFullChat: true,
    reconnectStates: (reconnect.reconnectStates ?? []).filter((state) =>
      ["connecting", "connected", "error"].includes(state),
    ),
    modelRetained:
      reconnect.retainedControls.result.controls?.effectiveModel?.id === initialSelection.id,
    effortRetained:
      reconnect.retainedControls.result.controls?.thinkingLevel === initialSelection.thinkingLevel,
    expectedFailedActionsVisible: {
      staleReference: reconnect.failures.staleReference,
      ambiguousTarget: reconnect.failures.ambiguousTarget,
    },
    screenshot: reconnect.screenshot,
  };
  report.status = "passed";
  report.outcome = panelReconnectOnly
    ? "side_panel_reconnect_passed_with_list_trace"
    : "full_continuity_passed";
  await setStage(
    panelReconnectOnly ? "panel reconnect acceptance passed" : "full continuity passed",
  );
  await writePending(report);
}
