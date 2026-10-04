import { useEffect, useRef, useState, type RefObject } from "react";
import { PiBrowserContextRecordSchema } from "@pippin/protocol";
export interface ContextTab {
  tabId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  current: boolean;
}
interface AddState {
  open: boolean;
  tabs: ContextTab[] | null;
  error: string;
  loading: boolean;
  root: RefObject<HTMLDivElement | null>;
  setOpen(value: boolean): void;
  setTabs(value: ContextTab[] | null): void;
  setError(value: string): void;
  listTabs(): Promise<void>;
  choose(id: number): Promise<void>;
}
function request(kind: string, tabId?: number): Promise<unknown> {
  return new Promise((resolve, reject) =>
    window.dispatchEvent(
      new CustomEvent("aeon.context-picker", { detail: { kind, tabId, resolve, reject } }),
    ),
  );
}
export function useComposerAddMenu(contextId: string): AddState {
  const [open, setOpen] = useState(false),
    [tabs, setTabs] = useState<ContextTab[] | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useOutsideDismiss(root, open, () => setOpen(false));
  const listTabs = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const value = await request("list");
      setTabs(Array.isArray(value) ? (value as ContextTab[]) : []);
    } catch {
      setError("Could not load tabs.");
    } finally {
      setLoading(false);
    }
  };
  const choose = (id: number): Promise<void> =>
    chooseContextTab(id, contextId, setLoading, setError, () => setOpen(false));
  return { open, tabs, error, loading, root, setOpen, setTabs, setError, listTabs, choose };
}
function useOutsideDismiss(
  root: RefObject<HTMLDivElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open, close, root]);
}
async function chooseContextTab(
  tabId: number,
  contextId: string,
  setLoading: (value: boolean) => void,
  setError: (value: string) => void,
  close: () => void,
): Promise<void> {
  setLoading(true);
  setError("");
  try {
    const record = PiBrowserContextRecordSchema.parse(await request("capture", tabId));
    const key = "aeon-context-pages:" + contextId;
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    const pages = Array.isArray(value)
      ? value.flatMap((item) => {
          const parsed = PiBrowserContextRecordSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    if (!pages.some((page) => page.target.tabId === tabId)) {
      if (pages.length >= 8) throw new Error("Attach up to eight tabs.");
      sessionStorage.setItem(key, JSON.stringify([...pages, record]));
      window.dispatchEvent(new CustomEvent("aeon.context-added", { detail: { id: contextId } }));
    }
    close();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Could not attach tab.");
  } finally {
    setLoading(false);
  }
}
