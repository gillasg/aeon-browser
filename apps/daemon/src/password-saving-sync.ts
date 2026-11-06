import { activeProvider } from "@browserkit/credentials";
import { bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { WebSocket } from "ws";
import { BrowserControlService } from "./browser-control-service.js";
import { readBrowserNames } from "./core-browsers.js";

// Chrome offers its own "Save password?" on every submitted password, whatever saved it. A profile
// whose password manager is Bitwarden or Proton Pass already keeps the logins Aeon makes, so the
// moment that profile connects Aeon tells it to switch Chrome's offer off (as those managers'
// extensions do); a profile with none gets the user's own Chrome setting back, since Chrome's
// prompt is then the only way to keep a login. Only the manager's name is used, never a secret.

/** Tells one connected browser whether its profile saves logins to a password manager. */
export async function syncPasswordSaving(
  dataRoot: string,
  browserId: string,
  socket: WebSocket,
): Promise<void> {
  const name = (await readBrowserNames(dataRoot))[browserId];
  const provider = await activeProvider(bridgeDataDirectory(), name).catch(() => undefined);
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ kind: "native.password-saving", managed: Boolean(provider) }));
}

/** The daemon's browser control: tidies on startup and syncs password saving on each connect. */
export function browserControlFor(dataRoot: string): BrowserControlService {
  const browserControl = new BrowserControlService();
  browserControl.enableStartupTidy();
  browserControl.onBrowserConnected(
    (id, socket) => void syncPasswordSaving(dataRoot, id, socket).catch(() => undefined),
  );
  return browserControl;
}
