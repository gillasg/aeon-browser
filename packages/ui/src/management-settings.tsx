import { useMessageSendMode } from "./message-send-mode.js";
import type { ReactElement } from "react";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { WallpaperSettings } from "./wallpaper-settings.js";

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
      <WallpaperSettings />
    </section>
  );
}
