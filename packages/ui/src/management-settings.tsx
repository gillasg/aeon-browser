import { useMessageSendMode } from "./message-send-mode.js";
import {
  agentInFrontKey,
  hideAgentCursorKey,
  useAgentFlag,
  useAgentTabView,
  type AgentTabView,
} from "./agent-tab-view.js";
import type { ReactElement } from "react";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { ORB_REDUCE_MOTION_KEY, ORB_SOUNDS_KEY } from "./orb-prefs.js";
import { resetTour } from "./first-run-tour.js";
import { PrivacySettings } from "./privacy-settings.js";
import { ActionRow, MenuRow, SettingsGroup, SwitchRow, ValueRow } from "./settings-list.js";

// General settings. Sign-in and Blocked sites have their own sections in the Settings menu.

type Theme = "dark" | "midnight" | "light" | "system";

export function SettingsPanel(props: ManagementSurfaceProps): ReactElement {
  return (
    <div className="settings-groups">
      <AppearanceSettings {...props} />
      <ChatSettings {...props} />
      <AgentTabSettings />
      {props.privacy && <PrivacySettings {...props.privacy} />}
      <OutsideAgentsSettings
        {...(props.outsideContext !== undefined ? { outsideContext: props.outsideContext } : {})}
        {...(props.onOutsideContext ? { onOutsideContext: props.onOutsideContext } : {})}
      />
      <HelperSettings connectionLabel={props.connectionLabel} />
    </div>
  );
}

function AppearanceSettings(props: ManagementSurfaceProps): ReactElement {
  const [reduceMotion, setReduceMotion] = useAgentFlag(ORB_REDUCE_MOTION_KEY);
  const [sounds, setSounds] = useAgentFlag(ORB_SOUNDS_KEY);
  return (
    <SettingsGroup
      title="Appearance"
      footer="Reduce motion is already on when your system asks for less motion."
    >
      <MenuRow<Theme>
        label="Theme"
        value={props.theme}
        options={[
          ["system", "Match system"],
          ["light", "Light"],
          ["dark", "Dark"],
          ["midnight", "Midnight"],
        ]}
        onChange={props.onTheme}
      />
      <SwitchRow
        label="Reduce motion"
        detail="The swarm holds still and nothing slides."
        checked={reduceMotion}
        onChange={setReduceMotion}
      />
      <SwitchRow
        label="Sounds"
        detail="A soft tone when a run starts, needs you, and finishes."
        checked={sounds}
        onChange={setSounds}
      />
      <ActionRow
        label="Tour"
        detail="The four-step introduction from your first day."
        action="Show again"
        onClick={() => {
          resetTour();
          location.assign("home.html");
        }}
      />
    </SettingsGroup>
  );
}

function ChatSettings(props: ManagementSurfaceProps): ReactElement {
  const [mode, setMode] = useMessageSendMode();
  return (
    <SettingsGroup title="Chats">
      <MenuRow<"followUp" | "steer">
        label="Messages sent while Aeon answers"
        value={mode}
        options={[
          ["followUp", "Wait their turn"],
          ["steer", "Steer the answer"],
        ]}
        onChange={setMode}
      />
      <SwitchRow
        label="Show the chat list in full-tab chats"
        detail="Tabs and the side panel keep their own switcher."
        checked={props.sidebarDefaultOpen}
        onChange={props.onSidebarDefault}
      />
    </SettingsGroup>
  );
}

function AgentTabSettings(): ReactElement {
  const [tabView, setTabView] = useAgentTabView();
  // Both switches are relied on by screen recorders (Aperture); keep them.
  const [inFront, setInFront] = useAgentFlag(agentInFrontKey);
  const [hideCursor, setHideCursor] = useAgentFlag(hideAgentCursorKey);
  return (
    <SettingsGroup title="Agent tabs">
      <MenuRow<AgentTabView>
        label="While Aeon works"
        detail="Split shows the tab it touched last; thumbnails show every tab it works in."
        value={tabView}
        options={[
          ["auto", "Automatic"],
          ["split", "Split screen"],
          ["thumbnails", "Thumbnails"],
        ]}
        onChange={setTabView}
      />
      <SwitchRow
        label="Work in front"
        detail="Its tabs open in front so you can watch or record each step. Off: background tabs."
        checked={inFront}
        onChange={setInFront}
      />
      <SwitchRow
        label="Hide Aeon's cursor"
        detail="For screen recorders that draw their own."
        checked={hideCursor}
        onChange={setHideCursor}
      />
    </SettingsGroup>
  );
}

function OutsideAgentsSettings(props: {
  outsideContext?: boolean;
  onOutsideContext?(enabled: boolean): void;
}) {
  return (
    <SettingsGroup
      title="Other agents"
      footer={
        <>
          Titles and addresses only, never page contents. Coding agents read them with{" "}
          <code>aeon context</code>.
        </>
      }
    >
      <SwitchRow
        label="Let other agents see my open tabs"
        checked={props.outsideContext === true}
        onChange={(enabled) => props.onOutsideContext?.(enabled)}
      />
    </SettingsGroup>
  );
}

function HelperSettings({ connectionLabel }: { connectionLabel: string }): ReactElement {
  const connected = /^connected/i.test(connectionLabel);
  return (
    <SettingsGroup
      title="This computer"
      footer="Aeon's helper app runs its agent and keeps your chats on this computer."
    >
      <ValueRow
        label="Helper app"
        value={connected ? "Connected" : "Not connected"}
        tone={connected ? "ok" : "needs"}
        {...(connected ? {} : { detail: "Run Aeon's setup again to repair it." })}
      />
      <ActionRow
        label="Site customizations"
        detail="Scripts and styles Aeon adds to sites, and their permissions."
        action="Open"
        onClick={() => window.open("site-scripts.html", "_blank", "noopener")}
      />
    </SettingsGroup>
  );
}
