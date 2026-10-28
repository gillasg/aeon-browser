import type { ReactElement } from "react";

/** A segmented control: two to five choices that switch what a page shows. */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<readonly [Value, string]>;
  onChange(value: Value): void;
}): ReactElement {
  return (
    <div className="aeon-segmented" role="tablist" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={value === option}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
