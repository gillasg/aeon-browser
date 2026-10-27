import type { PrivacySettingsProps, PrivacyState } from "@aeon/ui";

// Settings → Privacy. The engine reads these keys from the extension's own storage on every
// check, so the page reads and writes them directly.

const PRIVATE_NETWORK = "private-network";
const PORTS = "private-network-ports";
const NEVER_SAVE = "vault-never-save";
const DEFAULT_PORTS = [3000, 5173, 8080];

function toState(saved: Record<string, unknown>): PrivacyState {
  const ports = saved[PORTS];
  const neverSave = saved[NEVER_SAVE];
  return {
    privateNetwork: saved[PRIVATE_NETWORK] === true,
    ports: Array.isArray(ports) ? ports.map(Number).filter((port) => port > 0) : DEFAULT_PORTS,
    neverSave: Array.isArray(neverSave) ? neverSave.map(String).filter(Boolean) : [],
  };
}

export function followPrivacy(onChange: () => void): () => PrivacySettingsProps {
  let state: PrivacyState = { privateNetwork: false, ports: DEFAULT_PORTS, neverSave: [] };
  const read = () =>
    void chrome.storage.local
      .get([PRIVATE_NETWORK, PORTS, NEVER_SAVE])
      .then((saved) => {
        state = toState(saved);
        onChange();
      })
      .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (PRIVATE_NETWORK in changes || PORTS in changes || NEVER_SAVE in changes)
    )
      read();
  });
  read();
  return () => ({
    state,
    onPrivateNetwork: (enabled) => void chrome.storage.local.set({ [PRIVATE_NETWORK]: enabled }),
    onPorts: (ports) => void chrome.storage.local.set({ [PORTS]: ports }),
    onNeverSaveRemove: (site) =>
      void chrome.storage.local.set({
        [NEVER_SAVE]: state.neverSave.filter((item) => item !== site),
      }),
  });
}
