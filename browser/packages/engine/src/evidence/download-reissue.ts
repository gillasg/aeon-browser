import { CAUSAL_MS } from "./receipt.js";

// Chrome can drop the first renderer download in a document: the navigate event
// fires with downloadRequest set, then no request is sent and no download event
// follows. A later download in that same document is sent. Reissuing the dropped
// attempt through chrome.downloads makes that first action observable. An attempt
// that already produced a download is left alone, so it is not saved twice.

export interface DownloadAttempt {
  href: string;
  name: string;
  at: number;
}

export interface ReissueReceipt {
  startedAt: number;
  hasDownload: boolean;
}

/** The attempt to send again, when this action tried to download and nothing arrived. */
export function shouldReissueDownload(
  attempt: DownloadAttempt | undefined,
  receipt: ReissueReceipt,
  now: number,
): DownloadAttempt | undefined {
  if (!attempt || receipt.hasDownload) return undefined;
  if (!isDownloadUrl(attempt.href)) return undefined;
  if (attempt.at < receipt.startedAt || now - attempt.at > CAUSAL_MS) return undefined;
  return attempt;
}

/** A download attribute used as a file name, without a path. */
export function reissueFilename(name: string): string | undefined {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  if (!base || base === "." || base === "..") return undefined;
  return base.slice(0, 180);
}

function isDownloadUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "blob:";
  } catch {
    return false;
  }
}
