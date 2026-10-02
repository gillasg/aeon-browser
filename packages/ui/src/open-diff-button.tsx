import type { ReactElement } from "react";
import { openFile } from "./file-links.js";
export function OpenDiffButton({
  diff,
}: {
  diff: { path: string; confirmed: boolean; rows: readonly { kind: string; text: string }[] };
}): ReactElement {
  const text = (kind: string): string =>
    diff.rows
      .filter((row) => row.kind === "context" || row.kind === kind)
      .map((row) => row.text)
      .join("\n");
  return (
    <button
      type="button"
      className="inline-edit-open"
      aria-label="Open diff"
      title="Open diff"
      onClick={() =>
        openFile({
          path: diff.path,
          original: text("removed"),
          modified: text("added"),
          label: diff.confirmed ? "Pi change excerpt" : "Proposed change excerpt",
        })
      }
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      </svg>
    </button>
  );
}
