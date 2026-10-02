import { useEffect, useState, type ReactElement, type RefObject } from "react";
import { copyTextToClipboard } from "./clipboard.js";
import { createPortal } from "react-dom";
import { useAnnotations } from "./transcript-annotations.js";
interface SelectedQuote {
  text: string;
  range: Range;
  left: number;
  top: number;
}
function selectedQuote(root: HTMLElement): SelectedQuote | null {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const element = range.startContainer.parentElement?.closest(
    ".message-row.assistant .message-content > .message-markdown",
  );
  if (!element || !root.contains(element) || !element.contains(range.endContainer)) return null;
  if (
    range.startContainer.parentElement?.closest("details,button") ||
    range.endContainer.parentElement?.closest("details,button")
  )
    return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  return {
    text,
    range: range.cloneRange(),
    left: Math.max(8, Math.min(rect.left, innerWidth - 310)),
    top: Math.max(8, Math.min(rect.bottom + 8, innerHeight - 150)),
  };
}
export function AnnotationSelection({
  root,
}: {
  root: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const annotations = useAnnotations();
  const [quote, setQuote] = useState<SelectedQuote | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  useSelectionAnchor(quote, setQuote);
  useSelectionEvents(root, Boolean(annotations), editing, quote, setQuote, setEditing, setComment);
  if (!quote || !annotations) return null;
  const save = () => {
    if (!quote.range.startContainer.isConnected || quote.range.toString().trim() !== quote.text) {
      setQuote(null);
      setEditing(false);
      return;
    }
    annotations.add(quote.text, comment.trim(), quote.range);
    setQuote(null);
    setEditing(false);
    setComment("");
    window.getSelection()?.removeAllRanges();
    document.querySelector<HTMLTextAreaElement>("#composer textarea")?.focus();
  };
  return (
    <SelectionOverlay
      quote={quote}
      editing={editing}
      comment={comment}
      setEditing={setEditing}
      setComment={setComment}
      save={save}
    />
  );
}

function SelectionOverlay({
  quote,
  editing,
  comment,
  setEditing,
  setComment,
  save,
}: {
  quote: SelectedQuote;
  editing: boolean;
  comment: string;
  setEditing(value: boolean): void;
  setComment(value: string): void;
  save(): void;
}): ReactElement {
  return createPortal(
    <div
      className="annotation-editor"
      data-selected-text-annotation-editor="true"
      style={{ left: quote.left, top: quote.top }}
      role="dialog"
      aria-label="Annotate selection"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!editing) event.preventDefault();
      }}
    >
      {!editing ? (
        <SelectionToolbar text={quote.text} onAnnotate={() => setEditing(true)} />
      ) : (
        <>
          <span className="annotation-label">1 selection</span>
          <textarea
            autoFocus
            value={comment}
            aria-label="Annotation comment"
            placeholder="Ask about this…"
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                save();
              }
            }}
          />
          <button type="button" onClick={save}>
            Add
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

function useSelectionEvents(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  editing: boolean,
  quote: SelectedQuote | null,
  setQuote: (quote: SelectedQuote | null) => void,
  setEditing: (editing: boolean) => void,
  setComment: (comment: string) => void,
): void {
  useEffect(() => {
    const element = root.current;
    if (!element || !enabled) return;
    const capture = () => {
      if (!editing) setQuote(selectedQuote(element));
    };
    element.addEventListener("pointerup", capture);
    element.addEventListener("keyup", capture);
    return () => {
      element.removeEventListener("pointerup", capture);
      element.removeEventListener("keyup", capture);
    };
  }, [root, editing, enabled]);
  useEffect(() => {
    if (!quote) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-selected-text-annotation-editor]")
      )
        return;
      setQuote(null);
      setEditing(false);
      setComment("");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuote(null);
        setEditing(false);
        setComment("");
        root.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [quote, root]);
}

function useSelectionAnchor(
  quote: SelectedQuote | null,
  setQuote: (quote: SelectedQuote | null) => void,
): void {
  useEffect(() => {
    if (!quote) return;
    const browser = globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
      CSS: typeof CSS & { highlights?: Map<string, unknown> };
    };
    if (browser.Highlight)
      browser.CSS.highlights?.set("pippin-selection", new browser.Highlight(quote.range));
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          !quote.range.startContainer.isConnected ||
          quote.range.toString().trim() !== quote.text
        ) {
          setQuote(null);
          return;
        }
        const rect = quote.range.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.left, innerWidth - 310));
        const top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - 150));
        if (left !== quote.left || top !== quote.top) setQuote({ ...quote, left, top });
      });
    };
    const observer = new MutationObserver(reposition);
    const response = quote.range.startContainer.parentElement?.closest(".message-markdown");
    if (response)
      observer.observe(response, { childList: true, subtree: true, characterData: true });
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      browser.CSS.highlights?.delete("pippin-selection");
    };
  }, [quote, setQuote]);
}

function SelectionToolbar({
  text,
  onAnnotate,
}: {
  text: string;
  onAnnotate(): void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <button type="button" onClick={onAnnotate}>
        Annotate
      </button>
      <button type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}
