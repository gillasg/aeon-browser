import { useEffect, useState, type ReactElement } from "react";
import { ProviderIcon } from "./provider-icon.js";
import {
  POPULAR_PROVIDERS,
  connectionBadge,
  defaultModelName,
  type ModelAccountsProps,
  type ModelAccountsState,
  type ModelProvider,
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
    <section className="graft-page model-accounts" aria-labelledby="models-heading">
      <header className="graft-page-head">
        <h2 id="models-heading">Models</h2>
        <p>
          Sign in once. Graft, the Pi CLI and other Pi apps on this computer share the same logins.
        </p>
      </header>
      {props.error && (
        <p className="graft-page-error" role="status">
          {props.error}
        </p>
      )}
      {props.flow ? (
        <ModelSignInPanel {...props} flow={props.flow} />
      ) : props.state ? (
        <AccountLists {...props} state={props.state} />
      ) : (
        <p className="graft-page-empty">Loading providers…</p>
      )}
    </section>
  );
}

function AccountLists(props: ModelAccountsProps & { state: ModelAccountsState }): ReactElement {
  const connected = props.state.providers.filter((provider) => provider.connected);
  return (
    <>
      {props.state.models.length > 0 && props.onStartChat && (
        <ReadyBanner
          state={props.state}
          onStartChat={props.onStartChat}
          label={props.startChatLabel}
        />
      )}
      {connected.length > 0 && (
        <section className="graft-page-section" aria-labelledby="models-connected">
          <h2 id="models-connected">Connected</h2>
          <ul className="graft-rows">
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

/** Once any model works, the way back to work stays one click away. */
function ReadyBanner({
  state,
  onStartChat,
  label,
}: {
  state: ModelAccountsState;
  onStartChat(): void;
  label?: string | undefined;
}): ReactElement {
  const model = defaultModelName(state);
  return (
    <div className="model-ready" role="status">
      <span>
        <strong>You're ready.</strong>{" "}
        {model ? `Graft uses ${model} by default.` : "Pick a model in any chat."}
      </span>
      <button type="button" className="graft-primary-button" onClick={onStartChat}>
        {label ?? "Start chatting"}
      </button>
    </div>
  );
}

function Badge({ text }: { text: string | undefined }): ReactElement | null {
  return text ? <span className="model-badge">{text}</span> : null;
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
    <li className="graft-row">
      <ProviderIcon provider={provider.id} />
      <span className="graft-row-main">
        <strong>
          {provider.name} <Badge text={connectionBadge(provider)} />
        </strong>
        <span>{connectionText(provider)}</span>
      </span>
      {provider.connection?.stored && (
        <button type="button" className="graft-quiet-button" onClick={() => onSignOut(provider)}>
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
    <section className="graft-page-section" aria-labelledby="models-default">
      <h2 id="models-default">Default model</h2>
      <label className="graft-field-row">
        <span>Used when nothing else is chosen: other extensions, the CLI and helpers.</span>
        <select
          className="graft-select"
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
}): ReactElement | null {
  // A connected provider already sits in Connected; listing it again here is noise.
  const oauth = providers
    .filter((provider) => !provider.connected)
    .flatMap((provider) =>
      provider.methods
        .filter((method) => method.type === "oauth")
        .map((method) => ({ provider, method })),
    );
  if (!oauth.length) return null;
  return (
    <section className="graft-page-section" aria-labelledby="models-subscriptions">
      <h2 id="models-subscriptions">Sign in with an account</h2>
      <div className="model-tiles">
        {oauth.map(({ provider, method }) => (
          <button
            key={provider.id}
            type="button"
            className="model-tile"
            title={method.label}
            onClick={() => onStart(provider, "oauth")}
          >
            <ProviderIcon provider={provider.id} />
            <span className="model-tile-text">
              <strong>{provider.name}</strong>
              <span>{method.label}</span>
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
  const [popularOnly, setPopularOnly] = useState(true);
  const withKeys = providers.filter((provider) =>
    provider.methods.some((method) => method.type === "api_key"),
  );
  const shown = filterKeyProviders(withKeys, query, popularOnly);
  return (
    <section className="graft-page-section" aria-labelledby="models-keys">
      <h2 id="models-keys">API keys</h2>
      <div className="model-key-tools">
        <input
          type="search"
          className="graft-search"
          placeholder={`Search ${withKeys.length} providers`}
          aria-label="Search providers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="model-filter" role="group" aria-label="Show providers">
          <button type="button" aria-pressed={popularOnly} onClick={() => setPopularOnly(true)}>
            Popular
          </button>
          <button type="button" aria-pressed={!popularOnly} onClick={() => setPopularOnly(false)}>
            All
          </button>
        </div>
      </div>
      <ul className="graft-rows">
        {shown.map((provider) => (
          <KeyRow key={provider.id} provider={provider} onStart={onStart} />
        ))}
        {!shown.length && <li className="graft-page-empty">No provider matches that search.</li>}
      </ul>
      {popularOnly && !query.trim() && (
        <button type="button" className="graft-link-button" onClick={() => setPopularOnly(false)}>
          Show all {withKeys.length} providers
        </button>
      )}
    </section>
  );
}

/**
 * The API-key rows to show: a search looks through every provider (name or id), otherwise the
 * popular ones, plus any provider that already has a key, so nothing connected is hidden.
 */
export function filterKeyProviders(
  providers: readonly ModelProvider[],
  query: string,
  popularOnly: boolean,
): ModelProvider[] {
  const text = query.trim().toLowerCase();
  if (text)
    return providers.filter((provider) =>
      `${provider.name} ${provider.id}`.toLowerCase().includes(text),
    );
  if (!popularOnly) return [...providers];
  return providers.filter(
    (provider) => POPULAR_PROVIDERS.includes(provider.id) || provider.connected,
  );
}

function KeyRow({
  provider,
  onStart,
}: {
  provider: ModelProvider;
  onStart: ModelAccountsProps["onStart"];
}): ReactElement {
  const saved = provider.connection?.type === "api_key" && provider.connection.stored;
  return (
    <li className="graft-row">
      <ProviderIcon provider={provider.id} />
      <span className="graft-row-main">
        <strong>
          {provider.name}{" "}
          <Badge text={POPULAR_PROVIDERS.includes(provider.id) ? "Popular" : undefined} />
        </strong>
        {saved ? (
          <span>Key saved</span>
        ) : (
          provider.connection &&
          !provider.connection.stored && (
            <span>Already set by {provider.connection.source ?? "your environment"}</span>
          )
        )}
      </span>
      <button
        type="button"
        className="graft-quiet-button"
        onClick={() => onStart(provider, "api_key")}
      >
        {saved ? "Replace key" : "Add key"}
      </button>
    </li>
  );
}
