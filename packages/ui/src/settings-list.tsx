import { useState, type FormEvent, type ReactElement, type ReactNode } from "react";

// Settings as grouped lists, the way iOS and macOS lay them out: a small heading, one rounded
// surface of rows (a switch, a menu, an action), and an optional footnote under the group.

export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="settings-group">
      <h2>{title}</h2>
      <ul className="aeon-list settings-list">{children}</ul>
      {footer && <p className="settings-footnote">{footer}</p>}
    </section>
  );
}

function RowText({ label, detail }: { label: ReactNode; detail?: ReactNode }): ReactElement {
  return (
    <span className="settings-row-text">
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </span>
  );
}

export function SwitchRow({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
}): ReactElement {
  return (
    <li className="settings-row">
      <label>
        <RowText label={label} detail={detail} />
        <input
          type="checkbox"
          role="switch"
          className="aeon-switch"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    </li>
  );
}

export function MenuRow<Value extends string>({
  label,
  detail,
  value,
  options,
  onChange,
}: {
  label: string;
  detail?: ReactNode;
  value: Value;
  options: ReadonlyArray<readonly [Value, string]>;
  onChange(value: Value): void;
}): ReactElement {
  return (
    <li className="settings-row">
      <label>
        <RowText label={label} detail={detail} />
        <span className="aeon-menu">
          <select value={value} onChange={(event) => onChange(event.target.value as Value)}>
            {options.map(([option, text]) => (
              <option key={option} value={option}>
                {text}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </span>
      </label>
    </li>
  );
}

/** A row that does something: "Show the tour again", "Repair", "Remove". */
export function ActionRow({
  label,
  detail,
  action,
  onClick,
  tone,
}: {
  label: ReactNode;
  detail?: ReactNode;
  action: string;
  onClick(): void;
  tone?: "needs";
}): ReactElement {
  return (
    <li className="settings-row" data-tone={tone}>
      <div>
        <RowText label={label} detail={detail} />
        <button type="button" className="aeon-button" onClick={onClick}>
          {action}
        </button>
      </div>
    </li>
  );
}

/** A row that only reports: a label and its current value. */
export function ValueRow({
  label,
  value,
  detail,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "needs" | "ok";
}): ReactElement {
  return (
    <li className="settings-row" data-tone={tone}>
      <div>
        <RowText label={label} detail={detail} />
        <span className="settings-row-value">{value}</span>
      </div>
    </li>
  );
}

/** A row with a field and a button that adds what was typed (a site, a port). */
export function AddRow({
  label,
  placeholder,
  action,
  valid,
  inputMode,
  onAdd,
}: {
  label: string;
  placeholder: string;
  action: string;
  valid(value: string): boolean;
  inputMode?: "numeric";
  onAdd(value: string): void;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid(draft)) return;
    onAdd(draft);
    setDraft("");
  };
  return (
    <li className="settings-row">
      <form onSubmit={submit}>
        <input
          className="settings-row-input"
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          {...(inputMode ? { inputMode } : {})}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="aeon-button" disabled={!valid(draft)}>
          {action}
        </button>
      </form>
    </li>
  );
}
