import type { ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
import { FileLink } from "./file-links.js";
export function ToolReadFile({ step, text }: { step: ToolStep; text: string }): ReactElement {
  const path = [step.arguments.path, step.arguments.filePath, step.arguments.file_path].find(
    (value) => typeof value === "string",
  );
  return (
    <section className="inline-read-file" aria-label="Read file">
      <header className="inline-edit-header">
        {typeof path === "string" ? <FileLink path={path} /> : <span>File contents</span>}
      </header>
      <pre className="inline-read-content">{text}</pre>
    </section>
  );
}
