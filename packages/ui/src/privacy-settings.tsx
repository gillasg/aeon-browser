import { useState, type FormEvent, type ReactElement } from "react";

// Privacy: whether the agent may reach this computer and the local network, and the sites the
// password manager was told never to save logins for.

export interface PrivacyState {
  /** True when the agent is kept off local and private-network addresses (opt-in). */
  privateNetwork: boolean;
  /** Ports on this computer the agent may still reach while it is kept off the network. */
  ports: readonly number[];
  /** Sites the password manager never offers to save a login for. */
  neverSave: readonly string[];
}

export interface PrivacySettingsProps {
  state: PrivacyState;
  onPrivateNetwork(enabled: boolean): void;
  onPorts(ports: number[]): void;
  onNeverSaveRemove(site: string): void;
}

function parsePort(value: string): number | undefined {
  const port = Number(value.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export function PrivacySettings(props: PrivacySettingsProps): ReactElement {
  return (
    <section className="settings-group">
      <h2>Privacy</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={props.state.privateNetwork}
          onChange={(event) => props.onPrivateNetwork(event.target.checked)}
        />{" "}
        Keep the agent off this computer and your local network
      </label>
      <p>
        Blocks localhost, router pages and other private addresses, so a web page cannot steer the
        agent into them. Allow the ports you use for local development below.
      </p>
      <PortList {...props} />
      <NeverSaveList {...props} />
    </section>
  );
}

function PortList({ state, onPorts }: PrivacySettingsProps): ReactElement {
  const [draft, setDraft] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    const port = parsePort(draft);
    if (port !== undefined && !state.ports.includes(port))
      onPorts([...state.ports, port].sort((left, right) => left - right));
    setDraft("");
  };
  return (
    <>
      <form className="settings-inline-form" onSubmit={add}>
        <input
          aria-label="Allowed local port"
          placeholder="3000"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={parsePort(draft) === undefined}>
          Allow port
        </button>
      </form>
      {state.ports.length > 0 && (
        <ul className="settings-site-list">
          {state.ports.map((port) => (
            <li key={port}>
              <span>localhost:{port}</span>
              <button
                type="button"
                aria-label={`Remove port ${port}`}
                onClick={() => onPorts(state.ports.filter((item) => item !== port))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NeverSaveList({ state, onNeverSaveRemove }: PrivacySettingsProps): ReactElement | null {
  if (!state.neverSave.length) return null;
  return (
    <>
      <p>The password manager never offers to save logins for:</p>
      <ul className="settings-site-list">
        {state.neverSave.map((site) => (
          <li key={site}>
            <span>{site}</span>
            <button
              type="button"
              aria-label={`Allow saving logins for ${site}`}
              onClick={() => onNeverSaveRemove(site)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
