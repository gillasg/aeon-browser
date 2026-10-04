import { useEffect, useState } from "react";
import { PiBrowserContextRecordSchema, type PiBrowserContextRecord } from "@pippin/protocol";
export function usePanelPage(): { record: PiBrowserContextRecord | null; remove(): void } {
  const [record, setRecord] = useState<PiBrowserContextRecord | null>(null);
  useEffect(() => {
    if (document.body.dataset.host !== "panel") return;
    let active = true;
    const load = async () => {
      try {
        const response = await new Promise<unknown>((resolve, reject) =>
          window.dispatchEvent(
            new CustomEvent("pippin.panel-current-page", { detail: { resolve, reject } }),
          ),
        );
        const parsed = PiBrowserContextRecordSchema.safeParse(response);
        if (!active || !parsed.success) return;
        setRecord(parsed.data);
        sessionStorage.setItem("aeon-panel-page", JSON.stringify(parsed.data));
      } catch {
        /* The page may be restricted or the extension may be reloading. */
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);
  return {
    record,
    remove: () => {
      setRecord(null);
      sessionStorage.removeItem("aeon-panel-page");
    },
  };
}
