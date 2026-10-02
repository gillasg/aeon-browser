import { ViewerControls } from "./viewer-controls.js";
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { ChatMarkdown, mountPippinUi } from "@pippin/ui";
import { ChatIdSchema } from "@pippin/protocol";
import { z } from "zod";
import { connectPage, connectionErrorMessage } from "./ui-connection.js";
import { applyStoredTheme } from "./theme-preferences.js";
import { createCodeView, languageForPath } from "./viewer-monaco.js";
import { installFileViewerLinks } from "./file-viewer-launch.js";

interface FileData {
  path: string;
  content: string;
  language: string;
  original?: string;
  label?: string;
}
const params = new URL(location.href).searchParams;
const chatId = params.get("chatId") ?? "";
const root = document.getElementById("root");
if (!root) throw new Error("Viewer root is missing.");
void applyStoredTheme();
let displayedPath = "";
installFileViewerLinks(chatId, () => displayedPath);
const update = mountPippinUi(root, createElement(Viewer, { data: null, error: "" }));
void load()
  .then((data) => {
    displayedPath = data.path;
    document.title = data.path.split(/[\\/]/).pop() + " · Aeon";
    update(createElement(Viewer, { data, error: "" }));
  })
  .catch((error: unknown) =>
    update(
      createElement(Viewer, {
        data: null,
        error: error instanceof Error ? error.message : "Could not read the file.",
      }),
    ),
  );

async function load(): Promise<FileData> {
  ChatIdSchema.parse(chatId);
  const diffId = params.get("diff");
  if (diffId) {
    const key = "pippin-viewer-" + diffId;
    const values = await chrome.storage.session.get(key);
    const diff = z
      .object({
        chatId: z.literal(chatId),
        path: z.string(),
        original: z.string(),
        modified: z.string(),
        label: z.string().optional(),
      })
      .passthrough()
      .parse(values[key]);
    return {
      path: diff.path,
      content: diff.modified,
      original: diff.original,
      language: languageForPath(diff.path),
      ...(diff.label ? { label: diff.label } : {}),
    };
  }
  const connection = await connectPage(
    __PIPPIN_NATIVE_TRANSPORT__ ? { kind: "chat", chatId } : { kind: "catalog" },
  );
  if (connection.kind !== "connected") throw new Error(connectionErrorMessage(connection.code));
  const client = connection.client;
  try {
    const requestId = crypto.randomUUID();
    const after = client.send({
      kind: "command",
      requestId,
      operation: "workspace.file",
      payload: { chatId, path: params.get("path") ?? "" },
    });
    const response = await client.waitFor(
      (message) =>
        (message.kind === "command.completed" || message.kind === "command.failed") &&
        message.requestId === requestId,
      after,
    );
    if (response.kind === "command.failed") throw new Error(response.message);
    if (response.kind !== "command.completed" || response.result.kind !== "workspace.file")
      throw new Error("Invalid file response.");
    const file = response.result;
    return {
      path: file.path,
      content: file.content,
      language: file.language,
      ...(file.original !== null ? { original: file.original } : {}),
    };
  } finally {
    client.close();
  }
}

function Viewer({ data, error }: { data: FileData | null; error: string }): ReactElement {
  const [mode, setMode] = useState<"preview" | "source" | "diff">(
    params.has("diff") ? "diff" : "preview",
  );
  if (!data)
    return (
      <main className="file-viewer">
        <p className="viewer-status" role="status">
          {error || "Opening local file…"}
        </p>
      </main>
    );
  const markdown = data.language === "markdown";
  return (
    <main className="file-viewer">
      <ViewerControls
        mode={mode}
        onMode={setMode}
        markdown={markdown}
        hasDiff={data.original !== undefined}
      />
      <footer className="viewer-path" title={data.path}>
        {data.path}
      </footer>
      <section className="viewer-body">
        {markdown && mode === "preview" ? (
          <div className="viewer-preview">
            <ChatMarkdown text={data.content} />
          </div>
        ) : (
          <>
            {mode === "diff" && (
              <div className="viewer-diff-heading">
                <span>{data.path.split(/[\\/]/).pop()}</span>
                {data.label && <small>{data.label} · excerpt</small>}
              </div>
            )}
            <CodeView data={data} diff={mode === "diff"} />
          </>
        )}
      </section>
    </main>
  );
}
function CodeView({ data, diff }: { data: FileData; diff: boolean }): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    return createCodeView(
      container.current,
      data.content,
      data.language,
      diff ? data.original : undefined,
      Number(params.get("line")) || 1,
    );
  }, [data, diff]);
  return <div className="viewer-editor" ref={container} />;
}
