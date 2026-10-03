import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type { ComposerModel, EffectiveComposerModel } from "./chat-composer.js";
import { ModelOptions } from "./pi-model-options.js";
import { modelKey } from "./pi-model-key.js";
export { modelKey } from "./pi-model-key.js";
import { ProviderIcon } from "./provider-icon.js";

export function PiModelPicker({
  id,
  models,
  selected,
  disabled = false,
  onSelect,
}: {
  id: string;
  models: readonly ComposerModel[];
  selected: EffectiveComposerModel | null;
  disabled?: boolean;
  onSelect(model: ComposerModel): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  usePickerDismiss(details, open);
  const selectedKey = selected ? modelKey(selected) : "";
  const filtered = filterModels(models, query);
  return (
    <details
      ref={details}
      className="pi-picker"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event: FocusEvent<HTMLDetailsElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.open = false;
      }}
    >
      <PickerSummary
        id={id}
        label="Choose Pi model"
        hint="Model"
        open={open}
        disabled={disabled}
        value={selected ? selected.name : "Loading model…"}
        provider={selected?.provider}
        modelId={selected?.id}
      />
      <ModelOptions
        models={filtered}
        query={query}
        selectedKey={selectedKey}
        onQuery={setQuery}
        onSelect={(model) => {
          onSelect(model);
          setQuery("");
          if (details.current) {
            details.current.open = false;
            details.current.querySelector("summary")?.focus();
            details.current.dataset.hintDismissed = "true";
          }
        }}
      />
    </details>
  );
}

export function PiThinkingPicker({
  id,
  levels,
  selected,
  disabled = false,
  onSelect,
}: {
  id: string;
  levels: readonly string[];
  selected: string;
  disabled?: boolean;
  onSelect(level: string): void;
}): ReactElement {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  usePickerDismiss(details, open);
  return (
    <details
      ref={details}
      className="pi-picker pi-picker-effort"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event: FocusEvent<HTMLDetailsElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.open = false;
      }}
    >
      <PickerSummary
        id={id}
        label="Choose thinking effort"
        hint="Thinking effort"
        open={open}
        disabled={disabled}
        value={selected ? effortLabel(selected) : "Not supported"}
      />
      <ThinkingOptions levels={levels} selected={selected} onSelect={onSelect} details={details} />
    </details>
  );
}

function effortLabel(value: string): string {
  if (value.toLowerCase() === "xhigh") return "Extra High";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function usePickerDismiss(
  details: RefObject<HTMLDetailsElement | null>,
  open: boolean,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        details.current &&
        !details.current.contains(event.target)
      )
        details.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !details.current) return;
      event.preventDefault();
      details.current.open = false;
      details.current.querySelector("summary")?.focus();
    };
    const closeOnBlur = () => {
      if (details.current) details.current.open = false;
    };
    window.addEventListener("blur", closeOnBlur);
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("blur", closeOnBlur);
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [details, open]);
}

function PickerSummary({
  id,
  label,
  hint,
  open,
  disabled,
  value,
  provider,
  modelId,
}: {
  id: string;
  label: string;
  hint: string;
  open: boolean;
  disabled: boolean;
  value: string;
  provider?: string | undefined;
  modelId?: string | undefined;
}): ReactElement {
  return (
    <summary
      id={id}
      onPointerLeave={(event) => {
        delete event.currentTarget.parentElement?.dataset.hintDismissed;
      }}
      aria-label={label}
      aria-expanded={open}
      aria-describedby={`${id}-hover-hint`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
    >
      <span className="pi-picker-value">
        {provider && <ProviderIcon provider={provider} modelId={modelId} />}
        {value}
      </span>
      <span id={`${id}-hover-hint`} className="pi-picker-hover-card" role="tooltip">
        <strong>{hint}</strong>
      </span>
    </summary>
  );
}

function ThinkingOptions({
  levels,
  selected,
  onSelect,
  details,
}: {
  levels: readonly string[];
  selected: string;
  onSelect(level: string): void;
  details: RefObject<HTMLDetailsElement | null>;
}): ReactElement {
  return (
    <div className="pi-picker-menu" role="dialog" aria-label="Choose thinking effort">
      <div className="pi-picker-options" role="listbox" aria-label="Supported effort levels">
        {levels.map((level) => (
          <button
            key={level}
            type="button"
            role="option"
            aria-selected={level === selected}
            onClick={() => {
              onSelect(level);
              if (details.current) {
                details.current.open = false;
                details.current.querySelector("summary")?.focus();
                details.current.dataset.hintDismissed = "true";
              }
            }}
          >
            <span className="pi-picker-option-label">{effortLabel(level)}</span>
            {level === selected && (
              <span className="pi-picker-option-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
        {!levels.length && <p className="pi-picker-empty">This model has no effort controls.</p>}
      </div>
    </div>
  );
}

function filterModels(models: readonly ComposerModel[], query: string): ComposerModel[] {
  return models.filter((model) =>
    `${model.provider} ${model.name} ${model.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
}
