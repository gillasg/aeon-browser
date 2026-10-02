import type { ReactElement, ReactNode } from "react";
export interface FileOpenDetail {
  path: string;
  original?: string;
  modified?: string;
  label?: string;
  line?: number;
}
export function openFile(detail: FileOpenDetail): void {
  window.dispatchEvent(new CustomEvent("pippin.open-file", { detail }));
}
export function localFilePath(value: string): string | null {
  if (/^(?:https?:|mailto:|data:|javascript:|#)/i.test(value)) return null;
  let path = value;
  try {
    path = decodeURIComponent(path.replace(/^file:\/\/\//i, ""));
  } catch {
    return null;
  }
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  return /^(?:[a-z]:[\\/]|\/|\.\.?[\\/])/i.test(path) ||
    /^[\w@. -]+(?:[\\/][\w@. -]+)*\.[a-z0-9]{1,12}(?::\d+)?$/i.test(path)
    ? path
    : null;
}
export function FileLink({ path, children }: { path: string; children?: ReactNode }): ReactElement {
  const match = path.match(/^(.*):(\d+)$/);
  return (
    <button
      type="button"
      className="file-link"
      title={path}
      onClick={(event) => {
        event.stopPropagation();
        openFile({ path: match?.[1] ?? path, ...(match?.[2] ? { line: Number(match[2]) } : {}) });
      }}
    >
      {children ?? path}
    </button>
  );
}
