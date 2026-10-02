import type { ReactElement } from "react";
import type { ComposerModel } from "./chat-composer.js";
import { ProviderIcon } from "./provider-icon.js";
import { modelKey } from "./pi-model-key.js";
export function ModelOptions({
  models,
  query,
  selectedKey,
  onQuery,
  onSelect,
}: {
  models: readonly ComposerModel[];
  query: string;
  selectedKey: string;
  onQuery(value: string): void;
  onSelect(model: ComposerModel): void;
}): ReactElement {
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  return (
    <div className="pi-picker-menu" role="dialog" aria-label="Choose model">
      <label className="pi-picker-search">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m12.5 12.5 4 4" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder="Search models"
          aria-label="Search models"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="pi-picker-options" role="listbox" aria-label="Available Pi models">
        {providers.map((provider) => (
          <section key={provider} className="pi-picker-group" aria-label={provider}>
            <h3>{provider}</h3>
            {models
              .filter((model) => model.provider === provider)
              .map((model) => (
                <ModelOption
                  key={modelKey(model)}
                  model={model}
                  selected={modelKey(model) === selectedKey}
                  onSelect={onSelect}
                />
              ))}
          </section>
        ))}
        {!models.length && <p className="pi-picker-empty">No models match that search.</p>}
      </div>
    </div>
  );
}

function ModelOption({
  model,
  selected,
  onSelect,
}: {
  model: ComposerModel;
  selected: boolean;
  onSelect(model: ComposerModel): void;
}): ReactElement {
  return (
    <button
      type="button"
      role="option"
      data-model-id={model.id}
      aria-selected={selected}
      onClick={() => onSelect(model)}
    >
      <span className="pi-picker-option-label">
        <ProviderIcon provider={model.provider} modelId={model.id} />
        {model.name}
      </span>
      {selected && (
        <span className="pi-picker-option-check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );
}
