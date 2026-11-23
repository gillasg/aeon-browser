import { useMessageSendMode } from "./message-send-mode.js";
import {
  agentInFrontKey,
  hideAgentCursorKey,
  humanLikeInputKey,
  piSlashCommandsKey,
  recordAgentTabsKey,
  showThinkingKey,
  useAgentFlag,
} from "./agent-tab-view.js";
import type { ReactElement } from "react";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { ORB_REDUCE_MOTION_KEY, ORB_SOUNDS_KEY } from "./orb-prefs.js";
import { resetWelcome } from "./new-user-welcome.js";
import { PrivacySettings } from "./privacy-settings.js";
import { ActionRow, MenuRow, SettingsGroup, SwitchRow, ValueRow } from "./settings-list.js";

// General settings. Sign-in and Blocked sites have their own sections in the Settings menu.

type Theme = "dark" | "midnight" | "light" | "system";

export function SettingsPanel(props: ManagementSurfaceProps): ReactElement {
  return (
    <div className="settings-groups">
      <AppearanceSettings {...props} />
      <ChatSettings />
      <AgentTabSettings />
      {props.privacy && <PrivacySettings {...props.privacy} />}
      <OutsideAgentsSettings
        {...(props.outsideContext !== undefined ? { outsideContext: props.outsideContext } : {})}
        {...(props.onOutsideContext ? { onOutsideContext: props.onOutsideContext } : {})}
      />
      <HelperSettings connectionLabel={props.connectionLabel} />
      <DeveloperOptions />
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
        detail="Animations hold still and nothing slides."
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
        label="Welcome"
        detail="The one-line introduction and example tasks from your first day."
        action="Show again"
        onClick={() => {
          resetWelcome();
          location.assign("home.html");
        }}
      />
    </SettingsGroup>
  );
}

function ChatSettings(): ReactElement {
  const [mode, setMode] = useMessageSendMode();
  const [thinking, setThinking] = useAgentFlag(showThinkingKey, true);
  return (
    <SettingsGroup title="Chats">
      <SwitchRow
        label="Show thinking between steps"
        detail="Aeon's reasoning sits between its tool calls in a finished answer's work."
        checked={thinking}
        onChange={setThinking}
      />
      <MenuRow<"followUp" | "steer">
        label="Messages sent while Aeon answers"
        value={mode}
        options={[
          ["followUp", "Wait their turn"],
          ["steer", "Steer the answer"],
        ]}
        onChange={setMode}
      />
    </SettingsGroup>
  );
}

function AgentTabSettings(): ReactElement {
  // These three switches are relied on by screen recorders (Aeon Recorder); keep them.
  const [inFront, setInFront] = useAgentFlag(agentInFrontKey);
  const [hideCursor, setHideCursor] = useAgentFlag(hideAgentCursorKey);
  const [record, setRecord] = useAgentFlag(recordAgentTabsKey);
  const [humanLike, setHumanLike] = useAgentFlag(humanLikeInputKey);
  return (
    <SettingsGroup title="Agent tabs">
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
      <SwitchRow
        label="Record agent tabs"
        detail="Keeps a recording of every tab a chat works in, for screen recorders."
        checked={record}
        onChange={setRecord}
      />
      <SwitchRow
        label="Human-like mouse and typing"
        detail="Curved pointer and real keystrokes. Off keeps every action fast."
        checked={humanLike}
        onChange={setHumanLike}
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

/** For builders: Pi's `/` slash commands in the composer. Off by default. */
function DeveloperOptions(): ReactElement {
  const [slash, setSlash] = useAgentFlag(piSlashCommandsKey);
  return (
    <SettingsGroup title="Developer options">
      <SwitchRow
        label="Enable Pi slash commands (/)"
        detail="Adds Pi's tools and its / commands to the side panel's composer."
        checked={slash}
        onChange={setSlash}
      />
    </SettingsGroup>
  );
}
