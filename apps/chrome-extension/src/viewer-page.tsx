import { ViewerControls } from "./viewer-controls.js";
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { ChatMarkdown, mountAeonUi } from "@aeon/ui";
import { ChatIdSchema } from "@aeon/protocol";
import { z } from "zod";
import { connectPage, connectionErrorMessage } from "./ui-connection.js";
import { applyStoredTheme } from "./theme-preferences.js";
import { createCodeView, languageForPath } from "./viewer-monaco.js";
import { installFileViewerLinks, rememberRecent } from "./file-viewer-launch.js";
import {
  fileName,
  parseDelimited,
  parseViewerHref,
  previewKind,
  readRecent,
  RECENT_KEY,
  viewerHref,
  type PreviewKind,
  type RecentFile,
} from "./viewer-files.js";

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
// A deep link opened directly (not through a chat click) still joins the recent strip.
const opened = parseViewerHref(location.href);
if (opened) void rememberRecent(opened).catch(() => undefined);
const update = mountAeonUi(root, createElement(Viewer, { data: null, error: "" }));
void load()
  .then((data) => {
    displayedPath = data.path;
    document.title = fileName(data.path) + " · Aeon";
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
    const key = "aeon-viewer-" + diffId;
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
    __AEON_NATIVE_TRANSPORT__ ? { kind: "chat", chatId } : { kind: "catalog" },
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

type Mode = "preview" | "source" | "diff";
function Viewer({ data, error }: { data: FileData | null; error: string }): ReactElement {
  const kind: PreviewKind = data ? previewKind(data.path, data.language) : "none";
  const [mode, setMode] = useState<Mode>(params.has("diff") ? "diff" : "preview");
  const shown: Mode = mode === "preview" && kind === "none" ? "source" : mode;
  if (!data)
    return (
      <main className="file-viewer">
        <RecentStrip current="" />
        <p className="viewer-status" role="status">
          {error || "Opening local file…"}
        </p>
      </main>
    );
  return (
    <main className="file-viewer">
      <RecentStrip current={data.path} />
      <ViewerControls
        mode={shown}
        onMode={setMode}
        preview={kind !== "none"}
        hasDiff={data.original !== undefined}
        path={data.path}
        chatId={chatId}
      />
      <footer className="viewer-path" title={data.path}>
        {data.path}
      </footer>
      <section className="viewer-body">
        {shown === "preview" ? (
          <Preview data={data} kind={kind} />
        ) : (
          <>
            {shown === "diff" && (
              <div className="viewer-diff-heading">
                <span>{fileName(data.path)}</span>
                {data.label && <small>{data.label} · excerpt</small>}
              </div>
            )}
            <CodeView data={data} diff={shown === "diff"} />
          </>
        )}
      </section>
    </main>
  );
}

function Preview({ data, kind }: { data: FileData; kind: PreviewKind }): ReactElement {
  if (kind === "markdown")
    return (
      <div className="viewer-preview">
        <ChatMarkdown text={data.content} />
      </div>
    );
  if (kind === "csv") {
    const [head = [], ...rows] = parseDelimited(
      data.content,
      /\.tsv$/i.test(data.path) ? "\t" : ",",
    );
    return (
      <div className="viewer-preview">
        <table>
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 2000).map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 2000 && <p className="viewer-note">First 2000 of {rows.length} rows.</p>}
      </div>
    );
  }
  // HTML and SVG render in a sandboxed frame with scripts off: a preview, never a live page.
  return (
    <iframe
      className="viewer-frame"
      title={fileName(data.path)}
      sandbox=""
      srcDoc={
        kind === "image"
          ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh">${data.content}</body>`
          : data.content
      }
    />
  );
}

/** Files opened this browser session, newest first. One click switches the file in this tab. */
function RecentStrip({ current }: { current: string }): ReactElement | null {
  const [recent, setRecent] = useState<RecentFile[]>([]);
  useEffect(() => {
    const read = () =>
      void chrome.storage.session
        .get(RECENT_KEY)
        .then((values) => setRecent(readRecent(values[RECENT_KEY])))
        .catch(() => undefined);
    read();
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === "session" && RECENT_KEY in changes) read();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  if (recent.length < 2) return null;
  const base = chrome.runtime.getURL("viewer.html");
  return (
    <nav className="viewer-recent" aria-label="Recent files">
      {recent.map((item) => {
        const active = item.path === current && item.chatId === chatId;
        return (
          <a
            key={item.chatId + item.path + (item.diff ?? "")}
            href={viewerHref(base, item)}
            aria-current={active ? "page" : undefined}
            title={item.path}
          >
            {fileName(item.path)}
            {item.diff ? <small> diff</small> : null}
          </a>
        );
      })}
    </nav>
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
