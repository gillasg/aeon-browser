import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnnotationEditor, AnnotationSummary } from "./annotation-parts.js";
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
  return (
    <AnnotationContext.Provider value={value}>
      {children}
      <AnnotationBadges />
    </AnnotationContext.Provider>
  );
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
// Pending annotations: one chip in the attachment row; hovering lists them, each editable.
export function AnnotationChips(): ReactElement | null {
  const annotations = useAnnotations();
  if (!annotations?.records.length) return null;
  return (
    <AnnotationSummary
      items={annotations.records}
      onUpdate={(id, comment) => annotations.update(id, comment)}
      onRemove={(id) => annotations.remove(id)}
      onClear={() => annotations.clear(annotations.records.map((record) => record.id))}
    />
  );
}

interface Badge {
  id: string;
  number: number;
  left: number;
  top: number;
}
// A numbered marker at the end of each annotated passage; clicking it edits that annotation.
function AnnotationBadges(): ReactElement | null {
  const annotations = useAnnotations();
  const records = annotations?.records ?? [];
  const badges = useBadgePositions(records);
  const [editing, setEditing] = useState<Badge | null>(null);
  const record = editing && records.find((item) => item.id === editing.id);
  if (!annotations || !records.length) return null;
  return createPortal(
    <>
      {badges.map((badge) => (
        <button
          key={badge.id}
          type="button"
          className="annotation-badge"
          style={{ left: badge.left, top: badge.top }}
          aria-label={`Edit annotation ${badge.number}`}
          onClick={() => setEditing(badge)}
        >
          {badge.number}
        </button>
      ))}
      {editing && record && (
        <AnnotationEditor
          left={Math.max(8, Math.min(editing.left - 280, innerWidth - 348))}
          top={Math.max(8, Math.min(editing.top + 26, innerHeight - 170))}
          initial={record.comment}
          onSave={(comment) => {
            annotations.update(record.id, comment);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            annotations.remove(record.id);
            setEditing(null);
          }}
        />
      )}
    </>,
    document.body,
  );
}

function useBadgePositions(records: readonly ResponseAnnotation[]): Badge[] {
  const [badges, setBadges] = useState<Badge[]>([]);
  useEffect(() => {
    if (!records.length) {
      setBadges([]);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBadges(badgePositions(records)));
    };
    measure();
    // Text above can stream in or re-wrap, so re-measure now and then besides scroll and resize.
    const timer = setInterval(measure, 400);
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [records]);
  return badges;
}

function badgePositions(records: readonly ResponseAnnotation[]): Badge[] {
  return records.flatMap((record, index) => {
    const range = record.range;
    if (!range || !range.startContainer.isConnected) return [];
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const last = rects.at(-1);
    if (!last || last.bottom < 0 || last.top > innerHeight) return [];
    return [{ id: record.id, number: index + 1, left: last.right - 4, top: last.top - 12 }];
  });
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
