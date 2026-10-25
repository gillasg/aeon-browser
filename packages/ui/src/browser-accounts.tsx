import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementActionName } from "./management-types.js";

// Browser accounts, on the Models page: the chat products the user is signed in to in Chrome,
// separate from the models Pi talks to. Signed-in state is a cookie count (never values); a test
// query goes through the provider's direct transport with the page fallback.

type Provider = NonNullable<ManagementSnapshotDto["providers"]>[number];

export function BrowserAccounts({
  snapshot,
  chatId,
  onAction,
}: {
  snapshot: ManagementSnapshotDto | null;
  chatId: string;
  onAction(chatId: string, action: ManagementActionName, input: Record<string, unknown>): void;
}): ReactElement {
  const providers = snapshot?.providers ?? [];
  return (
    <section className="browser-accounts" aria-label="Browser accounts">
      <header className="browser-accounts-heading">
        <div>
          <h2>Browser accounts</h2>
          <p className="management-hint">
            Chat products the user is signed in to in Chrome. They are used from the session already
            there; nothing is signed in from this page.
          </p>
        </div>
        <button type="button" onClick={() => onAction(chatId, "check_providers", {})}>
          Check accounts
        </button>
      </header>
      {providers.length === 0 ? (
        <p className="management-empty">Check accounts to see which providers are signed in.</p>
      ) : (
        <table className="management-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Signed in</th>
              <th scope="col">Account</th>
              <th scope="col">Transport</th>
              <th scope="col">Test query</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                chatId={chatId}
                onAction={onAction}
              />
            ))}
          </tbody>
        </table>
      )}
      {snapshot?.lastAction && (
        <p className={`management-note ${snapshot.lastAction.ok ? "management-run-ok" : ""}`}>
          {snapshot.lastAction.message}
        </p>
      )}
    </section>
  );
}

function ProviderRow({
  provider,
  chatId,
  onAction,
}: {
  provider: Provider;
  chatId: string;
  onAction(chatId: string, action: ManagementActionName, input: Record<string, unknown>): void;
}): ReactElement {
  const [prompt, setPrompt] = useState("");
  return (
    <tr>
      <td>
        <strong>{provider.name}</strong>
        <p className="management-subtle">{provider.host}</p>
      </td>
      <td>
        {provider.signedIn ? (
          <span className="management-run-ok">Signed in</span>
        ) : (
          <span className="management-subtle">Signed out</span>
        )}
        {provider.cookies > 0 && <p className="management-subtle">{provider.cookies} cookie(s)</p>}
      </td>
      <td>{provider.account ?? <span className="management-subtle">unknown</span>}</td>
      <td>{provider.transport}</td>
      <td>
        <div className="management-form">
          <input
            value={prompt}
            placeholder="Reply with the single word: ok"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button
            type="button"
            onClick={() => onAction(chatId, "test_provider", { provider: provider.id, prompt })}
          >
            Test
          </button>
          {provider.lastTest && <p className="management-subtle">{provider.lastTest}</p>}
        </div>
      </td>
    </tr>
  );
}
