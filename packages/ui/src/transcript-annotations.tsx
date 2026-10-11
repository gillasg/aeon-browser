import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
export interface ResponseAnnotation {
  id: string;
  quote: string;
  comment: string;
  range?: Range;
}
interface AnnotationState {
  records: readonly ResponseAnnotation[];
  add(quote: string, comment: string, range: Range): void;
  remove(id: string): void;
  update(id: string, comment: string): void;
  clear(ids: readonly string[]): void;
}
const AnnotationContext = createContext<AnnotationState | null>(null);
export function AnnotationProvider({ children }: { children: ReactNode }): ReactElement {
  const [records, setRecords] = useState<ResponseAnnotation[]>([]);
  useAnnotationHighlights(records);
  const value: AnnotationState = {
    records,
    add: (quote, comment, range) =>
      setRecords((items) => [...items, { id: crypto.randomUUID(), quote, comment, range }]),
    update: (id, comment) =>
      setRecords((items) => items.map((item) => (item.id === id ? { ...item, comment } : item))),
    remove: (id) => setRecords((items) => items.filter((item) => item.id !== id)),
    clear: (ids) => setRecords((items) => items.filter((item) => !ids.includes(item.id))),
  };
  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>;
}
export function useAnnotations(): AnnotationState | null {
  return useContext(AnnotationContext);
}
// Annotations remain pending attachments until the message is sent.
export function serializeAnnotations(records: readonly ResponseAnnotation[]): string {
  if (!records.length) return "";
  const body = records
    .map((record, index) =>
      [`Annotation ${index + 1}:`, `> ${record.quote.replace(/\r?\n/g, "\n> ")}`, record.comment]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
  return `[Aeon annotations v1]\n\n${body}\n\n[/Aeon annotations v1]`;
}
// Pending annotations render as chips beside pasted images, in the same attachment row.
export function AnnotationChips(): ReactElement | null {
  const annotations = useAnnotations();
  if (!annotations?.records.length) return null;
  return (
    <>
      {annotations.records.map((record, index) => (
        <AnnotationChip
          key={record.id}
          record={record}
          index={index}
          onUpdate={(comment) => annotations.update(record.id, comment)}
          onRemove={() => annotations.remove(record.id)}
        />
      ))}
    </>
  );
}
function AnnotationChip({
  record,
  index,
  onUpdate,
  onRemove,
}: {
  record: ResponseAnnotation;
  index: number;
  onUpdate(comment: string): void;
  onRemove(): void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState(record.comment);
  const save = () => {
    onUpdate(comment.trim());
    setEditing(false);
  };
  return (
    <div className="annotation-chip" title={record.quote}>
      <q>{record.quote}</q>
      {editing ? (
        <textarea
          value={comment}
          autoFocus
          aria-label={`Edit annotation ${index + 1}`}
          onChange={(event) => setComment(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="annotation-chip-comment"
          aria-label={`Edit annotation ${index + 1}`}
          onClick={() => {
            setComment(record.comment);
            setEditing(true);
          }}
        >
          {record.comment || "Add comment"}
        </button>
      )}
      <button
        type="button"
        className="annotation-chip-remove"
        aria-label={`Remove annotation ${index + 1}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

function useAnnotationHighlights(records: readonly ResponseAnnotation[]): void {
  useEffect(() => {
    const browser = globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
      CSS: typeof CSS & { highlights?: Map<string, unknown> };
    };
    if (!browser.Highlight || !browser.CSS.highlights) return;
    const ranges = records.flatMap((record) => (record.range ? [record.range] : []));
    browser.CSS.highlights.set("aeon-annotations", new browser.Highlight(...ranges));
    return () => {
      browser.CSS.highlights?.delete("aeon-annotations");
    };
  }, [records]);
}
