import { useEffect, useRef, useState, type ReactElement } from "react";
import { PiBrowserContextRecordSchema } from "@pippin/protocol";
interface Tab {
  tabId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  current: boolean;
}
function request(kind: string, tabId?: number): Promise<unknown> {
  return new Promise((resolve, reject) =>
    window.dispatchEvent(
      new CustomEvent("aeon.context-picker", { detail: { kind, tabId, resolve, reject } }),
    ),
  );
}
export function ComposerAddMenu({
  onFiles,
  contextId = "draft",
}: {
  onFiles(): void;
  contextId?: string | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false),
    [tabs, setTabs] = useState<Tab[] | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  const listTabs = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const value = await request("list");
      setTabs(Array.isArray(value) ? (value as Tab[]) : []);
    } catch {
      setError("Could not load tabs.");
    } finally {
      setLoading(false);
    }
  };
  const choose = async (tabId: number): Promise<void> => {
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
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach tab.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="composer-add-wrap" ref={root}>
      <button
        className="attach-button"
        type="button"
        title="Add files or tabs"
        aria-label="Add files or tabs"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(!open);
          setTabs(null);
          setError("");
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && (
        <div className="composer-add-menu" role="dialog" aria-label="Add context">
          {tabs === null ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onFiles();
                }}
              >
                <span aria-hidden="true">＋</span> Add files
              </button>
              <button type="button" disabled={loading} onClick={() => void listTabs()}>
                <span aria-hidden="true">▣</span> Add tabs
              </button>
            </>
          ) : (
            <>
              <button
                className="tab-picker-back"
                type="button"
                onClick={() => {
                  setTabs(null);
                  setError("");
                }}
              >
                <span aria-hidden="true">‹</span> Back
              </button>
              <div className="tab-picker-list">
                {tabs.map((tab) => (
                  <button
                    type="button"
                    disabled={loading}
                    key={tab.tabId}
                    title={tab.url}
                    onClick={() => void choose(tab.tabId)}
                  >
                    <span className="tab-picker-icon">
                      {tab.favIconUrl && /^https?:/.test(tab.favIconUrl) ? (
                        <img src={tab.favIconUrl} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        "◎"
                      )}
                    </span>
                    <span className="tab-picker-title">{tab.title || tab.url}</span>
                    {tab.current && <span className="tab-picker-current">· Current tab</span>}
                  </button>
                ))}
                {!tabs.length && <p>No supported tabs open.</p>}
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
