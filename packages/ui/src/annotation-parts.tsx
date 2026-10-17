import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

// Building blocks of response annotations: the comment editor, and the "N annotations" chip whose
// hover list shows each selection with its comment (editable while pending, read-only once sent).
export interface AnnotationItem {
  id?: string;
  quote: string;
  comment: string;
}

/** Enter saves, Shift+Enter breaks the line, Escape cancels. */
function commentKeys(save: () => void, cancel: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };
}

export function AnnotationEditor({
  left,
  top,
  initial = "",
  onSave,
  onCancel,
  onDelete,
}: {
  left: number;
  top: number;
  initial?: string;
  onSave(comment: string): void;
  onCancel(): void;
  onDelete?: () => void;
}): ReactElement {
  const [comment, setComment] = useState(initial);
  const save = () => onSave(comment.trim());
  return (
    <div
      className="annotation-editor"
      data-selected-text-annotation-editor="true"
      style={{ left, top }}
      role="dialog"
      aria-label="Annotation comment"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        autoFocus
        value={comment}
        aria-label="Annotation comment"
        placeholder="Add a comment…"
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={commentKeys(save, onCancel)}
      />
      <EditorActions onSave={save} onCancel={onCancel} onDelete={onDelete} />
    </div>
  );
}

function EditorActions({
  onSave,
  onCancel,
  onDelete,
}: {
  onSave(): void;
  onCancel(): void;
  onDelete: (() => void) | undefined;
}): ReactElement {
  return (
    <div className="annotation-editor-actions">
      {onDelete && (
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Delete annotation"
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      )}
      <span />
      <button type="button" className="annotation-cancel" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="annotation-save" onClick={onSave}>
        Save
      </button>
    </div>
  );
}

/** Open while hovered or focused, with a short grace period to move the pointer into the list. */
function useHoverOpen() {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  const show = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), 160);
  };
  return { open, show, hide, toggle: () => setOpen(!open) };
}

export function AnnotationSummary({
  items,
  onUpdate,
  onRemove,
  onClear,
}: {
  items: readonly AnnotationItem[];
  onUpdate?: (id: string, comment: string) => void;
  onRemove?: (id: string) => void;
  onClear?: () => void;
}): ReactElement {
  const hover = useHoverOpen();
  return (
    <div
      className="annotation-summary"
      onMouseEnter={hover.show}
      onMouseLeave={hover.hide}
      onFocus={hover.show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.hide();
      }}
    >
      <button
        type="button"
        className="annotation-summary-chip"
        aria-expanded={hover.open}
        onClick={hover.toggle}
      >
        <CommentIcon />
        {`${items.length} annotation${items.length === 1 ? "" : "s"}`}
      </button>
      {onClear && (
        <button
          type="button"
          className="annotation-summary-clear"
          aria-label="Remove all annotations"
          onClick={onClear}
        >
          ×
        </button>
      )}
      {hover.open && <AnnotationList items={items} onUpdate={onUpdate} onRemove={onRemove} />}
    </div>
  );
}

function AnnotationList({
  items,
  onUpdate,
  onRemove,
}: {
  items: readonly AnnotationItem[];
  onUpdate: ((id: string, comment: string) => void) | undefined;
  onRemove: ((id: string) => void) | undefined;
}): ReactElement {
  return (
    <ol className="annotation-list" aria-label="Annotations">
      {items.map((item, index) => {
        const id = item.id;
        return (
          <AnnotationRow
            key={id ?? index}
            item={item}
            number={index + 1}
            onUpdate={onUpdate && id ? (comment) => onUpdate(id, comment) : undefined}
            onRemove={onRemove && id ? () => onRemove(id) : undefined}
          />
        );
      })}
    </ol>
  );
}

function AnnotationRow({
  item,
  number,
  onUpdate,
  onRemove,
}: {
  item: AnnotationItem;
  number: number;
  onUpdate: ((comment: string) => void) | undefined;
  onRemove: (() => void) | undefined;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  return (
    <li>
      <span className="annotation-list-number">{number}.</span>
      <div className="annotation-list-body">
        <small>Selected text:</small>
        <q>{item.quote}</q>
        <small>User comment:</small>
        {editing ? (
          <CommentField
            initial={item.comment}
            label={`Edit annotation ${number}`}
            onDone={(comment) => {
              if (comment !== undefined) onUpdate?.(comment);
              setEditing(false);
            }}
          />
        ) : (
          <p>{item.comment || "—"}</p>
        )}
      </div>
      {(onUpdate || onRemove) && (
        <div className="annotation-list-actions">
          {onUpdate && (
            <button
              type="button"
              className="annotation-icon-button"
              aria-label={`Edit annotation ${number}`}
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="annotation-icon-button"
              aria-label={`Remove annotation ${number}`}
              onClick={onRemove}
            >
              <TrashIcon />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** An inline comment edit: done with the new text, or undefined when cancelled. */
function CommentField({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone(comment: string | undefined): void;
}): ReactElement {
  const [comment, setComment] = useState(initial);
  const save = () => onDone(comment.trim());
  return (
    <textarea
      autoFocus
      value={comment}
      aria-label={label}
      onChange={(event) => setComment(event.target.value)}
      onBlur={save}
      onKeyDown={commentKeys(save, () => onDone(undefined))}
    />
  );
}

export function CommentIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6.5A1.5 1.5 0 0 1 13 12H7l-3.5 2.5V12H3A1.5 1.5 0 0 1 1.5 10.5V4A1.5 1.5 0 0 1 3 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 6h7M4.5 8.5h4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
function PencilIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function TrashIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
