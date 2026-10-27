import { NativeSettingsRequestSchema, type AgentSettings } from "@aeon/protocol";
import {
  AGENT_IN_FRONT_KEY,
  AGENT_TAB_VIEW_KEY,
  readAgentTabViewSetting,
  HIDE_AGENT_CURSOR_KEY,
  readAgentFlag,
} from "./agent-tab-view.js";

// `aeon settings` from the CLI: Core asks for the agent settings, changing them first if asked.
// Open settings and chat pages follow through chrome.storage. Screen recorders (Aperture) rely
// on this to switch settings for a recording; keep it.
export function handleSettingsMessage(candidate: unknown, socket: WebSocket): boolean {
  const request = NativeSettingsRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, set } = request.data;
  void applySettings(set ?? {})
    .then((settings) =>
      socket.send(JSON.stringify({ kind: "native.settings.result", requestId, settings })),
    )
    .catch(() => undefined);
  return true;
}

async function applySettings(set: {
  [K in keyof AgentSettings]?: AgentSettings[K] | undefined;
}): Promise<AgentSettings> {
  const changes: Record<string, unknown> = {};
  if (set.agentInFront !== undefined) changes[AGENT_IN_FRONT_KEY] = set.agentInFront;
  if (set.hideAgentCursor !== undefined) changes[HIDE_AGENT_CURSOR_KEY] = set.hideAgentCursor;
  if (set.agentTabView !== undefined) changes[AGENT_TAB_VIEW_KEY] = set.agentTabView;
  if (Object.keys(changes).length) await chrome.storage.local.set(changes);
  return {
    agentInFront: await readAgentFlag(AGENT_IN_FRONT_KEY),
    hideAgentCursor: await readAgentFlag(HIDE_AGENT_CURSOR_KEY),
    agentTabView: await readAgentTabViewSetting(),
  };
}
