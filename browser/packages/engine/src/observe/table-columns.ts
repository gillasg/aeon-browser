// Tables print their column names once, on the table line, and each data row prints its cell
// values in column order. The header row itself is not printed again, and an empty cell stays
// empty: no invented name stands in for it.
import type { AxNode } from "../native-browser-common.js";
import { textValue } from "../native-browser-common.js";
import { clip } from "./types.js";

const MAX_COLUMNS = 12;
const ROW_TEXT = 160;
const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader", "layouttablecell"]);
const GROUPS = new Set(["rowgroup", "generic", "none", "presentation"]);
const TABLES = new Set(["table", "grid", "layouttable", "treegrid"]);
const ROWS = new Set(["row", "layouttablerow"]);

type Kids = Map<string, AxNode[]>;

function roleOf(node: AxNode): string {
  return textValue(node.role?.value).toLowerCase();
}

function cellText(node: AxNode): string {
  return clip(textValue(node.name?.value), 40).replace(/\|/g, "/");
}

/** The rows of a table, through row groups (thead, tbody), at most a few levels deep. */
function rowsOf(table: AxNode, kids: Kids, depth = 0, out: AxNode[] = []): AxNode[] {
  if (depth > 3) return out;
  for (const child of kids.get(table.nodeId ?? "") ?? []) {
    if (out.length >= 3) break;
    const role = roleOf(child);
    if (ROWS.has(role)) out.push(child);
    else if (GROUPS.has(role)) rowsOf(child, kids, depth + 1, out);
  }
  return out;
}

function cellsOf(row: AxNode, kids: Kids): AxNode[] {
  return (kids.get(row.nodeId ?? "") ?? []).filter((child) => CELLS.has(roleOf(child)));
}

/** A row whose cells are all column headers. */
export function isHeaderRow(row: AxNode, kids: Kids): boolean {
  const cells = cellsOf(row, kids);
  return cells.length > 0 && cells.every((cell) => roleOf(cell) === "columnheader");
}

/** The column names of a table with a header row, or undefined when it has none. */
export function tableColumns(table: AxNode, kids: Kids): string[] | undefined {
  if (!TABLES.has(roleOf(table))) return undefined;
  const cache = memo.get(kids) ?? new Map<string, string[] | null>();
  memo.set(kids, cache);
  const known = cache.get(table.nodeId ?? "");
  if (known !== undefined) return known ?? undefined;
  const found = readColumns(table, kids);
  cache.set(table.nodeId ?? "", found ?? null);
  return found;
}

// One lookup per table per snapshot, not one per row.
const memo = new WeakMap<Kids, Map<string, string[] | null>>();

function readColumns(table: AxNode, kids: Kids): string[] | undefined {
  const header = rowsOf(table, kids).find((row) => isHeaderRow(row, kids));
  if (!header) return undefined;
  const names = cellsOf(header, kids).slice(0, MAX_COLUMNS).map(cellText);
  return names.some(Boolean) ? names : undefined;
}

function tableOf(row: AxNode, byId: Map<string, AxNode>): AxNode | undefined {
  let current = row.parentId ? byId.get(row.parentId) : undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    if (TABLES.has(roleOf(current))) return current;
    if (!GROUPS.has(roleOf(current))) return undefined;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/** A data row of a headed table: its cell values in column order, joined with " | ". */
export function headedRowText(
  row: AxNode,
  byId: Map<string, AxNode>,
  kids: Kids,
): string | undefined {
  if (!ROWS.has(roleOf(row))) return undefined;
  const table = tableOf(row, byId);
  const columns = table ? tableColumns(table, kids) : undefined;
  if (!columns) return undefined;
  // A cell past the last column (an actions cell) prints as its own controls, with their refs.
  const values = cellsOf(row, kids).slice(0, columns.length).map(cellText);
  while (values.length && !values[values.length - 1]) values.pop();
  return values.length ? clip(values.join(" | "), ROW_TEXT) : undefined;
}

export function columnsText(columns: readonly string[] | undefined): string {
  return columns?.length ? ` columns: ${columns.join(" | ")}` : "";
}
