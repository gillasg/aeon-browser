import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

// ⌘K / Ctrl+K: one box for everything Aeon can do, in plain verbs. Pages, recent chats, and
// what each site can do. Picking a site action puts it in the ask box so the user sees what runs.

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run(): void;
}

/** Simple ranking: every word of the query must appear; earlier matches rank higher. */
export function rankPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, 12);
  return items
    .map((item) => {
      const text = `${item.label} ${item.hint}`.toLowerCase();
      const at = words.map((word) => text.indexOf(word));
      return { item, score: at.some((index) => index < 0) ? -1 : at.reduce((a, b) => a + b, 0) };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map((entry) => entry.item);
}

export function CommandPalette({ items }: { items: readonly PaletteItem[] }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((value) => !value);
      setQuery("");
      setActive(0);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const shown = useMemo(() => rankPalette(items, query), [items, query]);
  if (!open) return null;
  const pick = (item: PaletteItem | undefined): void => {
    if (!item) return;
    setOpen(false);
    item.run();
  };
  return (
    <div className="palette-scrim" onMouseDown={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-label="Do anything"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={field}
          value={query}
          placeholder="What do you want to do?"
          aria-label="What do you want to do?"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            else if (event.key === "ArrowDown") setActive((i) => Math.min(i + 1, shown.length - 1));
            else if (event.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
            else if (event.key === "Enter") pick(shown[active]);
            else return;
            event.preventDefault();
          }}
        />
        <PaletteList items={shown} active={active} onActive={setActive} onPick={pick} />
      </div>
    </div>
  );
}

function PaletteList({
  items,
  active,
  onActive,
  onPick,
}: {
  items: readonly PaletteItem[];
  active: number;
  onActive(index: number): void;
  onPick(item: PaletteItem): void;
}): ReactElement {
  return (
    <ul role="listbox">
      {items.map((item, index) => (
        <li key={item.id} role="option" aria-selected={index === active}>
          <button type="button" onMouseEnter={() => onActive(index)} onClick={() => onPick(item)}>
            <span>{item.label}</span>
            <span className="palette-hint">{item.hint}</span>
          </button>
        </li>
      ))}
      {!items.length && <li className="palette-hint">Nothing matches. Ask Aeon instead.</li>}
    </ul>
  );
}
