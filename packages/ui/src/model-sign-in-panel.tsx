import { useState, type ReactElement } from "react";
import { ProviderIcon } from "./provider-icon.js";
import type { ModelAccountsProps, ModelSignInFlow } from "./model-accounts-types.js";

type PanelProps = ModelAccountsProps & { flow: ModelSignInFlow };

/** One sign-in, step by step: the provider's page, a device code, a question, then the result. */
export function ModelSignInPanel(props: PanelProps): ReactElement {
  const { flow } = props;
  const title =
    flow.method === "oauth" ? `Sign in to ${flow.provider.name}` : `${flow.provider.name} API key`;
  return (
    <section className="model-flow" aria-label={title} aria-live="polite">
      <header className="model-flow-head">
        <ProviderIcon provider={flow.provider.id} />
        <h2>{title}</h2>
      </header>
      {flow.notes.map((note, index) => (
        <div key={index} className="model-flow-step">
          <p>{note.message}</p>
          {note.links?.map((link) => (
            <button
              key={link.url}
              type="button"
              className="aeon-link-button"
              onClick={() => props.onOpenUrl(link.url)}
            >
              {link.label ?? link.url}
            </button>
          ))}
        </div>
      ))}
      {flow.authUrl && <AuthUrlStep {...props} authUrl={flow.authUrl} />}
      {flow.deviceCode && <DeviceCodeStep {...props} deviceCode={flow.deviceCode} />}
      {flow.prompt && (
        <PromptStep key={flow.prompt.promptId} prompt={flow.prompt} onAnswer={props.onAnswer} />
      )}
      <FlowFooter {...props} />
    </section>
  );
}

function AuthUrlStep({
  flow,
  authUrl,
  onOpenUrl,
}: PanelProps & { authUrl: NonNullable<ModelSignInFlow["authUrl"]> }): ReactElement {
  return (
    <div className="model-flow-step">
      <p>
        {authUrl.instructions ??
          `Finish signing in on ${flow.provider.name}'s page. It opened in a new tab.`}
      </p>
      <div className="model-flow-actions">
        <button
          type="button"
          className="aeon-primary-button"
          onClick={() => onOpenUrl(authUrl.url)}
        >
          Open sign-in page
        </button>
        <CopyButton text={authUrl.url} label="Copy link" />
      </div>
    </div>
  );
}

function DeviceCodeStep({
  deviceCode,
  onOpenUrl,
}: PanelProps & { deviceCode: NonNullable<ModelSignInFlow["deviceCode"]> }): ReactElement {
  return (
    <div className="model-flow-step">
      <p>Enter this code on the sign-in page:</p>
      <div className="model-flow-code">{deviceCode.userCode}</div>
      <div className="model-flow-actions">
        <button
          type="button"
          className="aeon-primary-button"
          onClick={() => onOpenUrl(deviceCode.verificationUri)}
        >
          Open the page
        </button>
        <CopyButton text={deviceCode.userCode} label="Copy code" />
      </div>
    </div>
  );
}

function PromptStep({
  prompt,
  onAnswer,
}: {
  prompt: NonNullable<ModelSignInFlow["prompt"]>;
  onAnswer(promptId: string, value: string): void;
}): ReactElement {
  const [value, setValue] = useState("");
  if (prompt.kind === "select" && prompt.options)
    return (
      <div className="model-flow-step">
        <p>{prompt.message}</p>
        <div className="model-flow-options">
          {prompt.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onAnswer(prompt.promptId, option.id)}
            >
              <strong>{option.label}</strong>
              {option.description && <span>{option.description}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <form
      className="model-flow-step"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onAnswer(prompt.promptId, value.trim());
      }}
    >
      <label>
        <p>{prompt.message}</p>
        <input
          className="aeon-input"
          type={prompt.kind === "secret" ? "password" : "text"}
          placeholder={
            prompt.placeholder ??
            (prompt.kind === "manual_code" ? "Paste the code or the full address" : "")
          }
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <div className="model-flow-actions">
        <button type="submit" className="aeon-primary-button" disabled={!value.trim()}>
          Continue
        </button>
      </div>
    </form>
  );
}

function FlowFooter({ flow, onCancel, onCloseFlow }: PanelProps): ReactElement {
  const result = flow.result;
  if (!result)
    return (
      <footer className="model-flow-foot">
        {flow.prompt ? (
          <span />
        ) : (
          <span className="model-flow-progress">
            {flow.progress ?? "Waiting for the provider…"}
          </span>
        )}
        <button type="button" className="aeon-quiet-button" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    );
  const message =
    result.kind === "done"
      ? `Connected to ${flow.provider.name}.`
      : result.kind === "error"
        ? result.message
        : "Sign-in cancelled.";
  return (
    <footer className="model-flow-foot" data-result={result.kind}>
      <span className="model-flow-result">{message}</span>
      <button type="button" className="aeon-quiet-button" onClick={onCloseFlow}>
        {result.kind === "done" ? "Done" : "Back"}
      </button>
    </footer>
  );
}

function CopyButton({ text, label }: { text: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="aeon-quiet-button"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}
