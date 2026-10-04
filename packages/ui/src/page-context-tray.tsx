import { useEffect, useState, type ReactElement } from "react";
import { PiBrowserContextRecordSchema, type PiBrowserContextRecord } from "@pippin/protocol";
import { BrowserContextChip } from "./browser-context-view.js";
export function PageContextTray(props: {
  chatId?: string | undefined;
  primary?: PiBrowserContextRecord | null | undefined;
  onRemove?: (() => void) | undefined;
}): ReactElement | null {
  const id = props.chatId ?? "draft";
  const [pages, setPages] = useState<PiBrowserContextRecord[]>(() => readPages(id));
  useEffect(() => {
    setPages(readPages(id));
    const update = (event: Event): void => {
      if ((event as CustomEvent).detail.id === id) setPages(readPages(id));
    };
    window.addEventListener("aeon.context-added", update);
    return () => window.removeEventListener("aeon.context-added", update);
  }, [id]);
  const visible = pages.filter((page) => page.target.tabId !== props.primary?.target.tabId);
  if (!props.primary && !visible.length) return null;
  const remove = (contextId: string): void => {
    const next = pages.filter((page) => page.contextId !== contextId);
    setPages(next);
    sessionStorage.setItem("aeon-context-pages:" + id, JSON.stringify(next));
  };
  return (
    <div className="composer-context-slot page-context-tray">
      {props.primary && (
        <BrowserContextChip
          record={props.primary}
          {...(props.onRemove ? { onRemove: props.onRemove } : {})}
        />
      )}
      {visible.map((page) => (
        <BrowserContextChip
          key={page.contextId}
          record={page}
          onRemove={() => remove(page.contextId)}
        />
      ))}
    </div>
  );
}
function readPages(id: string): PiBrowserContextRecord[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem("aeon-context-pages:" + id) ?? "[]");
    return Array.isArray(value)
      ? value
          .flatMap((item) => {
            const parsed = PiBrowserContextRecordSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
}
