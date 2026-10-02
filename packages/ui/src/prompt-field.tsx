import { useEffect, useRef, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";

export interface PromptFieldProps {
  id?: string;
  multiline: boolean;
  value: string;
  placeholder: string;
  ariaLabel: string;
  maxLength?: number;
  rows?: number;
  onChange(value: string): void;
  onEnter?(): void;
}

export function PromptField(props: PromptFieldProps): ReactElement {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!props.multiline || !textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
  }, [props.value, props.multiline]);
  const change = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    props.onChange(event.currentTarget.value);
    if (props.multiline && textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (!props.multiline || !event.shiftKey) && props.onEnter) {
      event.preventDefault();
      props.onEnter();
    }
  };
  if (props.multiline)
    return (
      <textarea
        id={props.id ?? "prompt"}
        ref={textarea}
        autoFocus
        rows={props.rows ?? 1}
        maxLength={props.maxLength ?? 50000}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={change}
        onKeyDown={keyDown}
      />
    );
  return (
    <input
      id={props.id}
      autoFocus
      type="text"
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      autoComplete="off"
      value={props.value}
      onChange={change}
      onKeyDown={keyDown}
    />
  );
}
