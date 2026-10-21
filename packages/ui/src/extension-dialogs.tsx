import { useState, type FormEvent, type ReactElement } from "react";
import type { PiUiSnapshotDto } from "@aeon/protocol";
import { ApprovalCard } from "./run-cards.js";

type ExtensionDialog = PiUiSnapshotDto["extensionDialogs"][number];
type Answer = (requestId: string, value: string | boolean | null) => void;

export function ExtensionDialogs({
  dialog,
  onAnswer,
}: {
  dialog: ExtensionDialog;
  onAnswer: Answer;
}): ReactElement {
  const [value, setValue] = useState(dialog.prefill ?? "");
  return (
    <div className="extension-dialog">
      <ApprovalCard title={dialog.title} message={dialog.message}>
        <DialogFields dialog={dialog} value={value} setValue={setValue} onAnswer={onAnswer} />
        <small>Expires {new Date(dialog.expiresAt).toLocaleTimeString()}</small>
      </ApprovalCard>
    </div>
  );
}

function DialogFields({
  dialog,
  value,
  setValue,
  onAnswer,
}: {
  dialog: ExtensionDialog;
  value: string;
  setValue(value: string): void;
  onAnswer: Answer;
}): ReactElement {
  if (dialog.kind === "select") return <OptionList dialog={dialog} onAnswer={onAnswer} />;
  if (dialog.kind === "confirm") return <ConfirmActions dialog={dialog} onAnswer={onAnswer} />;
  return <TextAnswer dialog={dialog} value={value} setValue={setValue} onAnswer={onAnswer} />;
}

function OptionList({
  dialog,
  onAnswer,
}: {
  dialog: ExtensionDialog;
  onAnswer: Answer;
}): ReactElement {
  return (
    <div className="extension-dialog-options">
      {dialog.options.map((option) => (
        <button key={option} type="button" onClick={() => onAnswer(dialog.requestId, option)}>
          {option}
        </button>
      ))}
      <button
        type="button"
        className="quiet-button"
        onClick={() => onAnswer(dialog.requestId, null)}
      >
        Cancel
      </button>
    </div>
  );
}

function ConfirmActions({
  dialog,
  onAnswer,
}: {
  dialog: ExtensionDialog;
  onAnswer: Answer;
}): ReactElement {
  return (
    <div className="extension-dialog-options">
      <button type="button" onClick={() => onAnswer(dialog.requestId, true)}>
        Confirm
      </button>
      <button
        type="button"
        className="quiet-button"
        onClick={() => onAnswer(dialog.requestId, false)}
      >
        Cancel
      </button>
    </div>
  );
}

function TextAnswer({
  dialog,
  value,
  setValue,
  onAnswer,
}: {
  dialog: ExtensionDialog;
  value: string;
  setValue(value: string): void;
  onAnswer: Answer;
}): ReactElement {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onAnswer(dialog.requestId, value);
  };
  return (
    <form onSubmit={submit}>
      {dialog.kind === "editor" ? (
        <textarea
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          maxLength={20_000}
          rows={8}
        />
      ) : (
        <input
          autoFocus
          value={value}
          placeholder={dialog.placeholder ?? ""}
          maxLength={20_000}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      )}
      <div className="extension-dialog-options">
        <button type="submit">Submit</button>
        <button
          type="button"
          className="quiet-button"
          onClick={() => onAnswer(dialog.requestId, null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
