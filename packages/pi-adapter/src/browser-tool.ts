export type BrowserCodeCell = {
  code: string;
  timeoutMs: number;
  ownerTitle?: string;
  challengeAssist?: boolean;
  onCall: (request: unknown) => Promise<unknown>;
  onProgress: (steps: Record<string, unknown>[]) => void;
};
type BrowserInput =
  | { steps: unknown[] }
  | { release: true; reset?: boolean; tidy?: boolean }
  | { siteScript: unknown }
  | { browserInfo: true }
  | { codeCell: BrowserCodeCell };
export type BrowserToolRunner = (
  chatId: string,
  toolCallId: string,
  input: BrowserInput,
  signal?: AbortSignal,
) => Promise<string>;

export function browserContent(
  output: string,
): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [{ type: "text", text: output }];
  }
  const images = new Map<string, { data: string; mimeType: string }>();
  stripScreenshots(parsed, images);
  return [
    { type: "text", text: JSON.stringify(parsed) },
    ...[...images.values()].slice(-3).map((image) => ({ type: "image" as const, ...image })),
  ];
}

function stripScreenshots(
  value: unknown,
  images: Map<string, { data: string; mimeType: string }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) stripScreenshots(item, images);
    return;
  }
  if (!isRecord(value)) return;
  if (
    value.kind === "screenshot" &&
    typeof value.dataBase64 === "string" &&
    typeof value.mimeType === "string"
  ) {
    images.set(String(value.screenshotId ?? images.size), {
      data: value.dataBase64,
      mimeType: value.mimeType,
    });
    delete value.dataBase64;
    return;
  }
  for (const item of Object.values(value)) stripScreenshots(item, images);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
