import { useState, type FormEvent, type ReactElement } from "react";
import { SettingsGroup } from "./settings-list.js";

// Settings → Forms: the form profile Aeon fills forms from. The agent never reads these values;
// it fills them into pages through the engine, and when a form asks for something new it asks
// the user and adds the answer here. Fields fall into sections by name, so the profile grows
// into Name, Contact, Address, Work and Other as the agent meets new forms.

export interface FormField {
  name: string;
  value: string;
}

const SECTIONS: ReadonlyArray<[string, RegExp]> = [
  ["Name", /name|^title$|pronoun|^dob$|birth/i],
  ["Contact", /email|phone|mobile|telegram|whatsapp/i],
  ["Address", /address|street|city|state|zip|postal|pin|country|region/i],
  ["Work", /company|job|role|employer|website|linkedin|github|portfolio|school|college|degree/i],
];

/** "middleName" → "Middle name". */
export function fieldLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sectionOf(name: string): string {
  return SECTIONS.find(([, pattern]) => pattern.test(name))?.[0] ?? "Other";
}

export function FormsSettings({
  fields,
  refused,
  onSave,
  onRemove,
}: {
  fields: readonly FormField[];
  refused?: string | undefined;
  onSave(field: string, value: string): void;
  onRemove(field: string): void;
}): ReactElement {
  const groups = [...SECTIONS.map(([title]) => title), "Other"]
    .map((title) => ({ title, items: fields.filter((field) => sectionOf(field.name) === title) }))
    .filter((group) => group.items.length);
  return (
    <div className="settings-groups">
      {groups.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.items.map((field) => (
            <FieldRow key={field.name} field={field} onSave={onSave} onRemove={onRemove} />
          ))}
        </SettingsGroup>
      ))}
      <SettingsGroup
        title={groups.length ? "Add a field" : "Your form profile"}
        footer={
          refused
            ? `Not kept: ${refused}.`
            : "Aeon fills forms from these without the model ever seeing them. When a form asks for something new, Aeon asks you and adds it here. Passwords and card numbers belong in your password manager."
        }
      >
        <NewFieldRow onSave={onSave} />
      </SettingsGroup>
    </div>
  );
}

function FieldRow({
  field,
  onSave,
  onRemove,
}: {
  field: FormField;
  onSave(field: string, value: string): void;
  onRemove(field: string): void;
}): ReactElement {
  const [draft, setDraft] = useState(field.value);
  const save = (): void => {
    if (draft.trim() && draft !== field.value) onSave(field.name, draft.trim());
  };
  return (
    <li className="settings-row">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="settings-row-text" htmlFor={"form-field-" + field.name}>
          <span>{fieldLabel(field.name)}</span>
        </label>
        <input
          id={"form-field-" + field.name}
          className="settings-row-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
        />
        <button type="button" className="aeon-button" onClick={() => onRemove(field.name)}>
          Remove
        </button>
      </form>
    </li>
  );
}

function NewFieldRow({ onSave }: { onSave(field: string, value: string): void }): ReactElement {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const ready = Boolean(name.trim() && value.trim());
  return (
    <li className="settings-row">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!ready) return;
          onSave(name.trim(), value.trim());
          setName("");
          setValue("");
        }}
      >
        <input
          id="form-field-new-name"
          className="settings-row-input"
          aria-label="Field"
          placeholder="Field, e.g. Middle name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          id="form-field-new-value"
          className="settings-row-input"
          aria-label="Value"
          placeholder="Value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="aeon-button" disabled={!ready}>
          Add
        </button>
      </form>
    </li>
  );
}
