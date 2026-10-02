import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/basic-languages/monaco.contribution.js";

type Host = typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } };
(globalThis as Host).MonacoEnvironment = {
  getWorker: () => new Worker(chrome.runtime.getURL("viewer-worker.js")),
};
export function createCodeView(
  container: HTMLElement,
  content: string,
  language: string,
  original?: string,
  line = 1,
): () => void {
  const model = monaco.editor.createModel(content, language);
  const options = {
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    scrollBeyondLastLine: false,
    wordWrap: "on" as const,
  };
  const editor =
    original === undefined
      ? monaco.editor.create(container, { ...options, model })
      : monaco.editor.createDiffEditor(container, {
          ...options,
          renderSideBySide: false,
          stickyScroll: { enabled: true },
          hideUnchangedRegions: { enabled: true },
        });
  const base = original === undefined ? undefined : monaco.editor.createModel(original, language);
  if (base && "getModifiedEditor" in editor) editor.setModel({ original: base, modified: model });
  else if ("revealLineInCenter" in editor) editor.revealLineInCenter(line);
  const theme = () =>
    monaco.editor.setTheme(
      getComputedStyle(document.documentElement).colorScheme === "light" ||
        (document.documentElement.dataset.theme === "system" &&
          matchMedia("(prefers-color-scheme: light)").matches)
        ? "vs"
        : "vs-dark",
    );
  theme();
  const observer = new MutationObserver(theme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", theme);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", theme);
    editor.dispose();
    model.dispose();
    base?.dispose();
  };
}

export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    monaco.languages
      .getLanguages()
      .find(
        (language) =>
          language.filenames?.some((file) => file.toLowerCase() === name) ||
          language.extensions?.some((extension) => name.endsWith(extension.toLowerCase())),
      )?.id ?? "plaintext"
  );
}
