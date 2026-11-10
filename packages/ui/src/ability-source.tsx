import type { ReactElement } from "react";

type Source = { runtime: "node" | "page"; code: string };
type Note = { kind: string; key: string; value: string };

export function wayLabel(way: string): string {
  return way === "script" ? "code" : way;
}

/** Marks a way whose body is code, in the abilities list. */
export function CodeBadge({ ways }: { ways: readonly string[] }): ReactElement | null {
  if (!ways.includes("script")) return null;
  return (
    <span className="ability-code" data-code="true">
      code
    </span>
  );
}

/** The saved source of each code way. Shown, never gated. */
export function AbilitySource({
  sources,
}: {
  sources?: readonly Source[] | undefined;
}): ReactElement | null {
  if (!sources?.length) return null;
  return (
    <div className="ability-source">
      {sources.map((source, index) => (
        <pre key={source.runtime + String(index)}>
          <span>{source.runtime === "page" ? "Page code" : "Node code"}</span>
          {"\n"}
          {source.code}
        </pre>
      ))}
    </div>
  );
}

/** Structured site notes, one fact per row. */
export function SiteFacts({ notes }: { notes?: readonly Note[] | undefined }): ReactElement | null {
  if (!notes?.length) return null;
  return (
    <section className="site-facts" aria-label="Site notes">
      <h3 className="management-subheading">Notes</h3>
      <ul className="management-inputs">
        {notes.map((note) => (
          <li key={note.kind + note.key}>
            <span className="ability-code">{note.kind}</span> {note.key}: {note.value}
          </li>
        ))}
      </ul>
    </section>
  );
}
