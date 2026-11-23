import { Fragment, type ReactElement, type ReactNode } from "react";

// A short answer shows whole in the cursor box: up to 8 rendered lines (about 460 characters), or
// a table of at most 4 rows by 3 columns with up to 2 lines of text. Longer answers keep the
// eight-line clamp and `⌘↵ Continue in panel`. Only bold, links, inline code and simple tables render;
// an answer with headings, images or code blocks is not shown in place at all.

/** Characters per rendered line at 13 px in the 412 px a 440 px answer leaves for text. */
const LINE_CHARS = 58;
const MAX_LINES = 8;
const MAX_CHARS = 460;

export interface AnswerBlock {
  kind: "text" | "table";
  lines: string[];
  rows: string[][];
}

const UNSUPPORTED = /```|^\s{0,3}#{1,6}\s|!\[[^\]]*\]\(/m;
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Text lines and pipe tables, in order. */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trimEnd();
    const last = blocks.at(-1);
    if (line.trim().startsWith("|")) {
      if (TABLE_RULE.test(line.trim())) continue;
      if (last?.kind === "table") last.rows.push(cells(line));
      else blocks.push({ kind: "table", lines: [], rows: [cells(line)] });
      continue;
    }
    if (!line.trim()) continue;
    if (last?.kind === "text") last.lines.push(line);
    else blocks.push({ kind: "text", lines: [line], rows: [] });
  }
  return blocks;
}

function renderedLines(lines: readonly string[]): number {
  return lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(plain(line).length / LINE_CHARS)),
    0,
  );
}

function plain(line: string): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "");
}

/** Whether the whole answer fits in the box without an inner scroll. */
export function answerFits(text: string): boolean {
  if (!text.trim() || UNSUPPORTED.test(text)) return false;
  const blocks = answerBlocks(text);
  const tables = blocks.filter((block) => block.kind === "table");
  const lines = blocks.flatMap((block) => block.lines);
  if (tables.length > 1) return false;
  const table = tables[0];
  if (!table) return plain(text).length <= MAX_CHARS && renderedLines(lines) <= MAX_LINES;
  const body = table.rows.length - 1;
  const columns = Math.max(...table.rows.map((row) => row.length));
  return body <= 4 && columns <= 3 && renderedLines(lines) <= 2;
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`/g;

export function inlineParts(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > at) parts.push(text.slice(at, index));
    const key = `${index}`;
    if (match[1] !== undefined) parts.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2] !== undefined)
      parts.push(
        <a key={key} href={match[3]} target="_blank" rel="noopener noreferrer">
          {match[2]}
        </a>,
      );
    else parts.push(<code key={key}>{match[4]}</code>);
    at = index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const NUMERIC = /^[-+]?[^\d\s]{0,3}\s?[\d.,]+\s?%?[^\d\s]{0,3}$/;

function AnswerTable({ rows }: { rows: string[][] }): ReactElement {
  const [head = [], ...body] = rows;
  return (
    <table className="isl-table">
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th key={index}>{inlineParts(cell)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, index) => (
              <td key={index} data-numeric={String(NUMERIC.test(cell))}>
                {inlineParts(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;

interface TextRun {
  kind: "p" | "ul" | "ol";
  items: string[];
}

/** Paragraphs and list runs: `- a` / `1. a` lines become real lists, never raw dashes. */
export function textRuns(lines: readonly string[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const line of lines) {
    const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : "p";
    const item = line.replace(kind === "ul" ? BULLET : kind === "ol" ? NUMBERED : HEADING, "");
    const last = runs.at(-1);
    if (kind !== "p" && last?.kind === kind) last.items.push(item);
    else runs.push({ kind, items: [kind === "p" ? item.trim() : item] });
  }
  return runs;
}

function TextBlock({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <>
      {textRuns(lines).map((run, index) => {
        if (run.kind === "p") return <p key={index}>{inlineParts(run.items[0] ?? "")}</p>;
        const items = run.items.map((item, itemIndex) => (
          <li key={itemIndex}>{inlineParts(item)}</li>
        ));
        return run.kind === "ul" ? <ul key={index}>{items}</ul> : <ol key={index}>{items}</ol>;
      })}
    </>
  );
}

/** The answer as formatted text: paragraphs, lists, bold, links, inline code and small tables. */
export function AnswerInPlace({ text, clamp }: { text: string; clamp?: boolean }): ReactElement {
  return (
    <div className="isl-answer" data-clamp={clamp ? "8" : undefined}>
      {answerBlocks(text.replace(/```[a-z]*\n?/gi, "")).map((block, index) =>
        block.kind === "table" ? (
          <AnswerTable key={index} rows={block.rows} />
        ) : (
          <Fragment key={index}>
            <TextBlock lines={block.lines} />
          </Fragment>
        ),
      )}
    </div>
  );
}
