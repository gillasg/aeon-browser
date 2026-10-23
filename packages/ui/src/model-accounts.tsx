import { useEffect, useState, type ReactElement } from "react";
import { ProviderIcon } from "./provider-icon.js";
import type {
  ModelAccountsProps,
  ModelAccountsState,
  ModelProvider,
} from "./model-accounts-types.js";
import { ModelSignInPanel } from "./model-sign-in-panel.js";

/**
 * The Models page: sign in with a subscription or save an API key for any provider Pi supports,
 * sign out, and choose the default model. A sign-in in progress replaces the lists until it ends.
 */
export function ModelAccounts(props: ModelAccountsProps): ReactElement {
  useEffect(() => {
    props.onShow();
    return () => props.onHide();
  }, []);
  return (
    <section className="aeon-page model-accounts" aria-labelledby="models-heading">
      <header className="aeon-page-head">
        <h1 id="models-heading">Models</h1>
        <p>
          Sign in once. Aeon, the Pi CLI and other Pi apps on this computer share the same logins.
        </p>
      </header>
      {props.error && (
        <p className="aeon-page-error" role="status">
          {props.error}
        </p>
      )}
      {props.flow ? (
        <ModelSignInPanel {...props} flow={props.flow} />
      ) : props.state ? (
        <AccountLists {...props} state={props.state} />
      ) : (
        <p className="aeon-page-empty">Loading providers…</p>
      )}
    </section>
  );
}

function AccountLists(props: ModelAccountsProps & { state: ModelAccountsState }): ReactElement {
  const connected = props.state.providers.filter((provider) => provider.connected);
  return (
    <>
      {connected.length > 0 && (
        <section className="aeon-page-section" aria-labelledby="models-connected">
          <h2 id="models-connected">Connected</h2>
          <ul className="aeon-rows">
            {connected.map((provider) => (
              <ConnectedRow key={provider.id} provider={provider} onSignOut={props.onSignOut} />
            ))}
          </ul>
        </section>
      )}
      {props.state.models.length > 0 && (
        <DefaultModel state={props.state} onDefaultModel={props.onDefaultModel} />
      )}
      <Subscriptions providers={props.state.providers} onStart={props.onStart} />
      <ApiKeys providers={props.state.providers} onStart={props.onStart} />
    </>
  );
}

function connectionText(provider: ModelProvider): string {
  const connection = provider.connection;
  if (!connection) return "";
  if (!connection.stored) return `From ${connection.source ?? "your environment"}`;
  return connection.type === "oauth" ? "Signed in · renews by itself" : "API key saved";
}

function ConnectedRow({
  provider,
  onSignOut,
}: {
  provider: ModelProvider;
  onSignOut(provider: ModelProvider): void;
}): ReactElement {
  return (
    <li className="aeon-row">
      <ProviderIcon provider={provider.id} />
      <span className="aeon-row-main">
        <strong>{provider.name}</strong>
        <span>{connectionText(provider)}</span>
      </span>
      {provider.connection?.stored && (
        <button type="button" className="aeon-quiet-button" onClick={() => onSignOut(provider)}>
          Sign out
        </button>
      )}
    </li>
  );
}

function DefaultModel({
  state,
  onDefaultModel,
}: {
  state: ModelAccountsState;
  onDefaultModel: ModelAccountsProps["onDefaultModel"];
}): ReactElement {
  const names = new Map(state.providers.map((provider) => [provider.id, provider.name]));
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const model of state.models)
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  const chosen = state.defaultModel
    ? `${state.defaultModel.provider}/${state.defaultModel.model}`
    : "";
  return (
    <section className="aeon-page-section" aria-labelledby="models-default">
      <h2 id="models-default">Default model</h2>
      <label className="aeon-field-row">
        <span>Used when nothing else is chosen: other extensions, the CLI and helpers.</span>
        <select
          className="aeon-select"
          value={chosen}
          onChange={(event) => {
            const value = event.target.value;
            const slash = value.indexOf("/");
            onDefaultModel(
              value
                ? { provider: value.slice(0, slash), model: value.slice(slash + 1) }
                : undefined,
            );
          }}
        >
          <option value="">Let each app choose</option>
          {[...groups].map(([provider, models]) => (
            <optgroup key={provider} label={names.get(provider) ?? provider}>
              {models.map((model) => (
                <option key={model.id} value={`${provider}/${model.id}`}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </section>
  );
}

function Subscriptions({
  providers,
  onStart,
}: {
  providers: readonly ModelProvider[];
  onStart: ModelAccountsProps["onStart"];
}): ReactElement {
  const oauth = providers.flatMap((provider) =>
    provider.methods
      .filter((method) => method.type === "oauth")
      .map((method) => ({ provider, method })),
  );
  return (
    <section className="aeon-page-section" aria-labelledby="models-subscriptions">
      <h2 id="models-subscriptions">Sign in with an account</h2>
      <div className="model-tiles">
        {oauth.map(({ provider, method }) => (
          <button
            key={provider.id}
            type="button"
            className="model-tile"
            data-connected={provider.connection?.type === "oauth" && provider.connection.stored}
            onClick={() => onStart(provider, "oauth")}
          >
            <ProviderIcon provider={provider.id} />
            <span className="model-tile-text">
              <strong>{provider.name}</strong>
              <span>
                {provider.connection?.type === "oauth" && provider.connection.stored
                  ? "Connected · sign in again"
                  : method.label}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ApiKeys({
  providers,
  onStart,
}: {
  providers: readonly ModelProvider[];
  onStart: ModelAccountsProps["onStart"];
}): ReactElement {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const shown = providers
    .filter((provider) => provider.methods.some((method) => method.type === "api_key"))
    .filter((provider) => !text || `${provider.name} ${provider.id}`.toLowerCase().includes(text));
  return (
    <section className="aeon-page-section" aria-labelledby="models-keys">
      <h2 id="models-keys">API keys</h2>
      <input
        type="search"
        className="aeon-search"
        placeholder="Search providers"
        aria-label="Search providers"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="aeon-rows">
        {shown.map((provider) => {
          const saved = provider.connection?.type === "api_key" && provider.connection.stored;
          return (
            <li key={provider.id} className="aeon-row">
              <ProviderIcon provider={provider.id} />
              <span className="aeon-row-main">
                <strong>{provider.name}</strong>
                {saved && <span>Key saved</span>}
              </span>
              <button
                type="button"
                className="aeon-quiet-button"
                onClick={() => onStart(provider, "api_key")}
              >
                {saved ? "Replace key" : "Add key"}
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="aeon-page-empty">No provider matches that search.</li>}
      </ul>
    </section>
  );
}
