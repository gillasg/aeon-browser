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
import { BlockedSitesSettings } from "./blocked-sites-settings.js";
import { PasswordManagerSettings } from "./password-manager-settings.js";

export function SettingsPanel(props: ManagementSurfaceProps): ReactElement {
  const [mode, setMode] = useMessageSendMode();
  return (
    <div className="settings-groups">
      <AppearanceSettings {...props} />
      <section className="settings-group">
        <h2>Chat navigation</h2>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={props.sidebarDefaultOpen}
            onChange={(event) => props.onSidebarDefault(event.target.checked)}
          />{" "}
          Open the Chat list by default in full-tab Chats
        </label>
        <p>The default is closed. Chrome tabs and the side panel keep their own navigation.</p>
      </section>
      <section className="settings-group">
        <h2>Messages during a response</h2>
        <label>
          Send behavior{" "}
          <select
            aria-label="Messages during a response"
            value={mode}
            onChange={(event) => setMode(event.target.value as "followUp" | "steer")}
          >
            <option value="followUp">Queue after the current response</option>
            <option value="steer">Steer at the next interruption point</option>
          </select>
        </label>
      </section>
      <OrbSettings />
      <AgentTabSettings />
      <BlockedSitesSettings
        {...(props.blockedSites ? { sites: props.blockedSites } : {})}
        {...(props.onBlockedSiteAdd ? { onAdd: props.onBlockedSiteAdd } : {})}
        {...(props.onBlockedSiteRemove ? { onRemove: props.onBlockedSiteRemove } : {})}
      />
      <OutsideAgentsSettings
        {...(props.outsideContext !== undefined ? { outsideContext: props.outsideContext } : {})}
        {...(props.onOutsideContext ? { onOutsideContext: props.onOutsideContext } : {})}
      />
      <PasswordManagerSettings signIn={props.snapshot?.signIn ?? null} loading={props.loading} />
      <section className="settings-group">
        <h2>Connected Chrome</h2>
        <p>
          <a href="site-scripts.html" target="_blank" rel="noreferrer">
            Site customizations and permissions
          </a>
        </p>
        <p>
          Aeon bridge: <strong>{props.connectionLabel}</strong>
        </p>
        <p>Chrome profiles are managed by Chrome; Aeon does not enumerate or switch profiles.</p>
      </section>
    </div>
  );
}

function AppearanceSettings(props: ManagementSurfaceProps): ReactElement {
  return (
    <section className="settings-group">
      <h2>Appearance</h2>
      <label>
        Theme{" "}
        <select
          value={props.theme}
          onChange={(event) =>
            props.onTheme(event.target.value as "dark" | "midnight" | "light" | "system")
          }
        >
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </label>
      <p>System follows your operating system appearance.</p>
    </section>
  );
}

function OrbSettings(): ReactElement {
  const [reduceMotion, setReduceMotion] = useAgentFlag(ORB_REDUCE_MOTION_KEY);
  const [sounds, setSounds] = useAgentFlag(ORB_SOUNDS_KEY);
  return (
    <section className="settings-group">
      <h2>Orb</h2>
      <p>Press Ctrl+Shift+Space on any page to call Aeon there.</p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={reduceMotion}
          onChange={(event) => setReduceMotion(event.target.checked)}
        />{" "}
        Reduce motion
      </label>
      <p>
        The swarm holds still and the island stops animating. On already when your system asks for
        less motion.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={sounds}
          onChange={(event) => setSounds(event.target.checked)}
        />{" "}
        Sounds
      </label>
      <p>A soft tone when a run starts, when it needs you, and when it&rsquo;s done.</p>
      <p>
        <button
          type="button"
          onClick={() => {
            resetTour();
            location.assign("home.html");
          }}
        >
          Show the tour again
        </button>
      </p>
    </section>
  );
}

function AgentTabSettings(): ReactElement {
  const [tabView, setTabView] = useAgentTabView();
  // Both switches are relied on by screen recorders (Aperture); keep them.
  const [inFront, setInFront] = useAgentFlag(agentInFrontKey);
  const [hideCursor, setHideCursor] = useAgentFlag(hideAgentCursorKey);
  return (
    <section className="settings-group">
      <h2>Agent tabs</h2>
      <label>
        While the agent works{" "}
        <select
          aria-label="Agent tabs view"
          value={tabView}
          onChange={(event) => setTabView(event.target.value as AgentTabView)}
        >
          <option value="split">Split screen beside the Chat</option>
          <option value="thumbnails">Live thumbnails beside the Chat</option>
        </select>
      </label>
      <p>
        Split screen shows the tab the agent touched last. Thumbnails stack every tab it is working
        in; click one to open it in split screen.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={inFront}
          onChange={(event) => setInFront(event.target.checked)}
        />{" "}
        Agent works in front
      </label>
      <p>
        Its tabs open in front and it switches to whichever tab it works in, so you can watch (or
        record) every step. Off: it works in background tabs and leaves yours alone.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={hideCursor}
          onChange={(event) => setHideCursor(event.target.checked)}
        />{" "}
        Hide agent cursor
      </label>
      <p>
        Hides the agent's cursor and its captions on pages, e.g. while a screen recorder draws its
        own.
      </p>
    </section>
  );
}

function OutsideAgentsSettings(props: {
  outsideContext?: boolean;
  onOutsideContext?(enabled: boolean): void;
}) {
  return (
    <section className="settings-group">
      <h2>Outside agents</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={props.outsideContext === true}
          onChange={(event) => props.onOutsideContext?.(event.target.checked)}
        />{" "}
        Let outside agents see my open tabs
      </label>
      <p>
        Only tab titles and URLs, never page contents. Off by default. The CLI and MCP expose it as{" "}
        <code>aeon context</code> / <code>aeon_context</code>.
      </p>
    </section>
  );
}
