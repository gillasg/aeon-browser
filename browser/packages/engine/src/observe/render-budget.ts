import { DROP_ORDER, RANK, cost, quote, tableText, type Line } from "./render-model.js";

export function prepareLines(lines: Line[], focus: string | undefined, delta: Set<number> | undefined): {
  lines: Line[];
  hidden: number;
} {
  const folded = redepth(foldSingles(lines));
  const collapsed = collapseRepeats(folded);
  const focused = prune(applyFocus(collapsed, focus));
  const changed = applyDelta(focused, delta);
  return { lines: prune(changed.lines), hidden: changed.hidden };
}

export function fitBudget(lines: Line[], budget: number, hidden: number): Line[] {
  const body = lines.filter((line) => line.kind !== "note");
  let kept = greedy(body, budget);
  let guard = body.length + 4;
  let result = finish(lines, kept, hidden);
  while (cost(result) > budget && kept.length > 1 && guard-- > 0) {
    const line = victim(kept);
    if (!line) break;
    kept = prune(kept.filter((item) => item.key !== line.key));
    result = finish(lines, kept, hidden);
  }
  if (cost(result) <= budget) return result;
  const bare = result.filter((line) => line.kind !== "note");
  return cost(bare) <= budget ? bare : bare.filter((line) => line.section === "header");
}

export function arrange(lines: Line[]): Line[] {
  const head = lines.filter((line) => line.section === "header" || line.section === "notice");
  const dialogs = lines.filter((line) => line.section === "dialog");
  const notes = lines.filter((line) => line.kind === "note");
  const body = lines.filter(
    (line) =>
      line.section !== "header" &&
      line.section !== "notice" &&
      line.section !== "dialog" &&
      line.kind !== "note",
  );
  return [...head, ...dialogs, ...body, ...notes];
}

function foldSingles(lines: Line[]): Line[] {
  let current = lines;
  let guard = 0;
  while (guard++ < 12) {
    const counts = childCounts(current);
    const folded = current.filter((line) => canFold(line, counts.get(line.key) ?? 0));
    if (!folded.length) break;
    const lift = new Map(folded.map((line) => [line.key, line.parentKey]));
    current = current
      .filter((line) => !lift.has(line.key))
      .map((line) => reparent(line, lift));
  }
  return current;
}

function canFold(line: Line, children: number): boolean {
  if (line.kind !== "container" || children !== 1 || line.bareName) return false;
  if (line.section === "dialog" || line.section === "chrome") return false;
  return line.role !== "table" && line.role !== "dialog" && line.role !== "alertdialog";
}

function reparent(line: Line, lift: Map<string, string | undefined>): Line {
  if (!line.parentKey || !lift.has(line.parentKey)) return line;
  const parent = resolveParent(line.parentKey, lift);
  if (!parent) {
    const { parentKey: _dropped, ...rest } = line;
    return rest;
  }
  return { ...line, parentKey: parent };
}

function resolveParent(key: string, lift: Map<string, string | undefined>): string | undefined {
  let current: string | undefined = key;
  let guard = 0;
  while (current && lift.has(current) && guard++ < 12) current = lift.get(current);
  return current;
}

function collapseRepeats(lines: Line[]): Line[] {
  const drop = new Set<string>();
  const replace = new Map<string, Line>();
  for (const group of groupsOf(lines)) {
    if (group.length <= 4) continue;
    const labels = new Set(group.map((line) => rowLabel(line, lines)));
    if (labels.size > 1) continue;
    const first = group[0];
    if (!first) continue;
    const tokens = group.flatMap((line) => (line.token ? [line.token] : []));
    for (const line of group) if (line.key !== first.key) drop.add(line.key);
    replace.set(first.key, {
      ...first,
      token: tokens.join(","),
      text: `[${tokens.join(",")}] ${first.role} ${quote(first.bareName)} x${group.length}`,
    });
  }
  return lines.flatMap((line) => (drop.has(line.key) ? [] : [replace.get(line.key) ?? line]));
}

function groupsOf(lines: readonly Line[]): Line[][] {
  const groups = new Map<string, Line[]>();
  for (const line of lines) {
    if (line.kind !== "control" || !line.token) continue;
    const key = `${line.role}|${line.bareName}|${line.value ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function rowLabel(line: Line, lines: readonly Line[]): string {
  const byKey = new Map(lines.map((item) => [item.key, item]));
  const labels: string[] = [];
  let parent = line.parentKey ? byKey.get(line.parentKey) : undefined;
  let guard = 0;
  while (parent && guard++ < 8) {
    if (parent.row) labels.push(parent.bareName);
    parent = parent.parentKey ? byKey.get(parent.parentKey) : undefined;
  }
  return labels.join("/");
}

function applyFocus(lines: Line[], focus: string | undefined): Line[] {
  if (!focus) return lines;
  const query = focus.toLowerCase();
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const keep = new Set<string>();
  for (const line of lines) {
    if (line.section === "header" || line.section === "notice" || line.hay.includes(query)) {
      let current: Line | undefined = line;
      let guard = 0;
      while (current && guard++ < 40) {
        keep.add(current.key);
        current = current.parentKey ? byKey.get(current.parentKey) : undefined;
      }
    }
  }
  return lines.filter((line) => keep.has(line.key));
}

function applyDelta(lines: Line[], delta: Set<number> | undefined): { lines: Line[]; hidden: number } {
  if (!delta) return { lines, hidden: 0 };
  let hidden = 0;
  const next = lines.flatMap((line) => {
    if (keepInDelta(line, delta)) return [markChanged(line, delta)];
    hidden += 1;
    return [];
  });
  return { lines: next, hidden };
}

function keepInDelta(line: Line, delta: Set<number>): boolean {
  if (line.kind === "container" || line.section === "header" || line.section === "notice") return true;
  return line.id === undefined || delta.has(line.id);
}

function markChanged(line: Line, delta: Set<number>): Line {
  if (line.id === undefined || !delta.has(line.id)) return line;
  const section = RANK[line.section] <= RANK.delta ? line.section : "delta";
  const text = line.text.startsWith("* ") ? line.text : `* ${line.text}`;
  return { ...line, section, text };
}

function greedy(lines: Line[], budget: number): Line[] {
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const chosen = new Set<string>();
  const ranked = [...lines].sort((a, b) => RANK[a.section] - RANK[b.section] || a.order - b.order);
  for (const line of ranked) {
    if (chosen.has(line.key)) continue;
    const chain = ancestorChain(line, byKey).filter((item) => !chosen.has(item.key));
    const next = [...lines.filter((item) => chosen.has(item.key)), ...chain];
    if (cost(next) > budget && chosen.size > 0) continue;
    for (const item of chain) chosen.add(item.key);
  }
  return lines.filter((line) => chosen.has(line.key));
}

function ancestorChain(line: Line, byKey: Map<string, Line>): Line[] {
  const chain: Line[] = [];
  let current: Line | undefined = line;
  let guard = 0;
  while (current && guard++ < 40) {
    chain.push(current);
    current = current.parentKey ? byKey.get(current.parentKey) : undefined;
  }
  return chain;
}

function finish(all: Line[], kept: Line[], hidden: number): Line[] {
  const keys = new Set(kept.map((line) => line.key));
  const body = kept.map((line) => recount(line, all, keys));
  return arrange([...body, ...cutNotes(all, keys), ...(hidden ? [noteLine(hiddenText(hidden), 90)] : [])]);
}

function recount(line: Line, all: readonly Line[], keys: Set<string>): Line {
  if (!line.table) return line;
  const rows = all.filter((item) => item.row && item.parentKey === line.key);
  const shown = rows.filter((item) => keys.has(item.key)).length;
  return { ...line, text: tableText(line.bareName, rows.length, shown) };
}

function cutNotes(all: readonly Line[], keys: Set<string>): Line[] {
  const rows = all.filter((line) => line.row && !keys.has(line.key)).length;
  const controls = all.filter((line) => line.kind === "control" && !keys.has(line.key)).length;
  const headings = all.filter((line) => line.kind === "heading" && !keys.has(line.key)).length;
  const texts = all.filter((line) => line.kind === "text" && !keys.has(line.key)).length;
  const chrome = all.filter((line) => line.section === "chrome" && !keys.has(line.key)).length;
  const notes: Line[] = [];
  if (rows) notes.push(noteLine(cutNote(rows, "row", "page.state({query}) or page.table()"), notes.length));
  if (controls) notes.push(noteLine(cutNote(controls, "control", "page.state({query})"), notes.length));
  if (headings) notes.push(noteLine(cutNote(headings, "heading", "page.state({query})"), notes.length));
  if (texts) notes.push(noteLine(cutNote(texts, "text line", "page.state({query})"), notes.length));
  if (chrome) notes.push(noteLine(`(+${chrome} nav or footer; page.state({query}))`, notes.length));
  return notes;
}

function cutNote(count: number, noun: string, hint: string): string {
  const label = count === 1 ? noun : `${noun}s`;
  return `(+${count} ${label}; ${hint})`;
}

function hiddenText(count: number): string {
  return `[${count} unchanged lines hidden; bu.state() shows the whole page]`;
}

function noteLine(text: string, index: number): Line {
  return {
    key: `note-${index}-${text.length}`,
    order: 10_000 + index,
    depth: 0,
    section: "note",
    kind: "note",
    role: "",
    bareName: "",
    text,
    hay: text.toLowerCase(),
    row: false,
    table: false,
  };
}

function victim(lines: readonly Line[]): Line | undefined {
  const parents = new Set(lines.flatMap((line) => (line.parentKey ? [line.parentKey] : [])));
  const leaves = lines.filter((line) => line.section !== "header" && !parents.has(line.key));
  const ranked = [...leaves].sort(
    (a, b) => DROP_ORDER.indexOf(a.section) - DROP_ORDER.indexOf(b.section) || b.order - a.order,
  );
  return ranked[0];
}

function prune(lines: Line[]): Line[] {
  let current = lines;
  let guard = 0;
  while (guard++ < 12) {
    const parents = new Set(current.flatMap((line) => (line.parentKey ? [line.parentKey] : [])));
    const next = current.filter((line) => keepContainer(line, parents));
    if (next.length === current.length) break;
    current = next;
  }
  return current;
}

function keepContainer(line: Line, parents: Set<string>): boolean {
  if (line.kind !== "container") return true;
  if (line.section === "chrome" || line.section === "dialog") return true;
  return parents.has(line.key);
}

function redepth(lines: Line[]): Line[] {
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const memo = new Map<string, number>();
  const depthOf = (key: string | undefined): number => {
    if (!key) return 0;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const line = byKey.get(key);
    const depth = !line?.parentKey ? 0 : Math.min(3, 1 + depthOf(line.parentKey));
    memo.set(key, depth);
    return depth;
  };
  return lines.map((line) => ({ ...line, depth: depthOf(line.key) }));
}

function childCounts(lines: readonly Line[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!line.parentKey) continue;
    counts.set(line.parentKey, (counts.get(line.parentKey) ?? 0) + 1);
  }
  return counts;
}
