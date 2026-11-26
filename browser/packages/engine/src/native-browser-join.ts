// browser.join and site.pipe, pure: relational joins over rows from compiled site APIs or any
// dataset, snapshot deltas, and a declarative step runner that never calls a model. The sandbox
// embeds these by source (code-api-demo-claws.ts), so tests run the same code.

type Row = Record<string, unknown>;
type KeyOf = (row: Row) => unknown;
export type JoinOn = string | [string, string] | ((row: Row, side: "left" | "right") => unknown);
export interface JoinOptions {
  on: JoinOn;
  type?: "inner" | "left" | "right" | "full";
  select?: string[] | ((left: Row | null, right: Row | null) => Row);
  delta?: boolean;
}

export function joinKeys(on: JoinOn): [KeyOf, KeyOf] {
  const pick =
    (name: string): KeyOf =>
    (row) =>
      name
        .split(".")
        .reduce<unknown>((value, part) => (value == null ? value : (value as Row)[part]), row);
  if (typeof on === "function") return [(row) => on(row, "left"), (row) => on(row, "right")];
  if (Array.isArray(on) && on.length === 2 && on.every((part) => typeof part === "string"))
    return [pick(on[0]), pick(on[1])];
  if (typeof on === "string" && on) return [pick(on), pick(on)];
  throw new Error("INVALID_INPUT: join needs on: a key name, [leftKey, rightKey] or a function");
}

export function joinKeyText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "object" ? JSON.stringify(value) : typeof value + ":" + String(value);
}

export function joinRows(left: unknown, right: unknown, options: JoinOptions): unknown {
  if (!Array.isArray(left) || !Array.isArray(right))
    throw new Error("INVALID_INPUT: browser.join takes two arrays of rows");
  if (!options || typeof options !== "object")
    throw new Error("INVALID_INPUT: browser.join needs {on}");
  const [leftKey, rightKey] = joinKeys(options.on);
  if (options.delta === true) return joinDelta(left as Row[], right as Row[], leftKey, rightKey);
  const type = options.type ?? "inner";
  if (!["inner", "left", "right", "full"].includes(type))
    throw new Error("INVALID_INPUT: join type is inner, left, right or full, not " + String(type));
  const index = new Map<string, Row[]>();
  for (const row of right as Row[]) {
    const key = joinKeyText(rightKey(row));
    if (key === undefined) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  const used = new Set<Row>();
  const out: Row[] = [];
  const emit = (a: Row | null, b: Row | null): void => {
    out.push(joinSelect(a, b, options.select));
  };
  for (const row of left as Row[]) {
    const key = joinKeyText(leftKey(row));
    const matches = key === undefined ? undefined : index.get(key);
    if (matches && matches.length) {
      for (const match of matches) {
        used.add(match);
        emit(row, match);
      }
    } else if (type === "left" || type === "full") emit(row, null);
  }
  if (type === "right" || type === "full")
    for (const row of right as Row[]) if (!used.has(row)) emit(null, row);
  return out;
}

export function joinSelect(
  left: Row | null,
  right: Row | null,
  select?: JoinOptions["select"],
): Row {
  if (typeof select === "function") return select(left, right);
  const merged: Row = { ...(right ?? {}), ...(left ?? {}) };
  if (left && right)
    for (const [name, value] of Object.entries(right))
      if (name in left && left[name] !== value) merged["right_" + name] = value;
  if (!Array.isArray(select)) return merged;
  const picked: Row = {};
  for (const name of select) if (name in merged) picked[name] = merged[name];
  return picked;
}

// The rows in `before` (left) against `after` (right) by key: what a re-run of a source added,
// removed or changed. Deep-equal by JSON, so key order inside objects is part of identity.
export function joinDelta(before: Row[], after: Row[], beforeKey: KeyOf, afterKey: KeyOf): unknown {
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner as Row).sort(([a], [b]) => (a < b ? -1 : 1)))
        : inner,
    );
  const old = new Map<string, Row>();
  for (const row of before) {
    const key = joinKeyText(beforeKey(row));
    if (key !== undefined) old.set(key, row);
  }
  const added: Row[] = [];
  const changed: { key: unknown; before: Row; after: Row; fields: string[] }[] = [];
  const unchanged: Row[] = [];
  const seen = new Set<string>();
  for (const row of after) {
    const raw = afterKey(row);
    const key = joinKeyText(raw);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const prior = old.get(key);
    if (!prior) added.push(row);
    else if (stable(prior) === stable(row)) unchanged.push(row);
    else {
      const fields = [...new Set([...Object.keys(prior), ...Object.keys(row)])].filter(
        (name) => stable(prior[name]) !== stable(row[name]),
      );
      changed.push({ key: raw, before: prior, after: row, fields });
    }
  }
  const removed = [...old.entries()].filter(([key]) => !seen.has(key)).map(([, row]) => row);
  return {
    added,
    removed,
    changed,
    unchanged,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

// One transform step of site.pipe over the current rows. Source and sink steps are async and
// live in the sandbox glue; everything here is synchronous and model-free.
export function pipeTransform(rows: unknown, step: Row, join: typeof joinRows): unknown {
  const list = Array.isArray(rows) ? (rows as Row[]) : rows == null ? [] : [rows as Row];
  const kind = Object.keys(step).find((name) =>
    ["map", "filter", "dedupe", "sort", "limit", "pick", "flat"].includes(name),
  );
  const fn = (value: unknown, label: string): ((row: Row, index: number) => unknown) => {
    if (typeof value === "function") return value as (row: Row, index: number) => unknown;
    if (typeof value === "string" && label !== "map") return (row) => joinKeys(value)[0](row);
    if (value && typeof value === "object" && label === "filter")
      return (row) =>
        Object.entries(value as Row).every(([name, want]) => joinKeys(name)[0](row) === want);
    throw new Error("INVALID_INPUT: site.pipe " + label + " needs a function");
  };
  if (kind === "map") return list.map(fn(step.map, "map"));
  if (kind === "filter")
    return list.filter((row, index) => Boolean(fn(step.filter, "filter")(row, index)));
  if (kind === "pick") return list.map((row) => joinSelect(row, null, step.pick as string[]));
  if (kind === "flat") return list.flat(Number(step.flat) || 1);
  if (kind === "limit") return list.slice(0, Math.max(0, Number(step.limit) || 0));
  if (kind === "dedupe") {
    const key =
      step.dedupe === true ? (row: Row) => JSON.stringify(row) : fn(step.dedupe, "dedupe");
    const seen = new Set<string>();
    return list.filter((row, index) => {
      const text = joinKeyText(key(row, index)) ?? JSON.stringify(row);
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }
  if (kind === "sort") {
    const spec = typeof step.sort === "string" ? { by: step.sort } : (step.sort as Row);
    const key = fn(spec.by, "sort");
    const sign = spec.desc === true || spec.order === "desc" ? -1 : 1;
    return list
      .map((row, index) => ({ row, index, key: key(row, index) as number | string }))
      .sort((a, b) => (a.key < b.key ? -sign : a.key > b.key ? sign : a.index - b.index))
      .map((entry) => entry.row);
  }
  if (step.join && typeof step.join === "object") {
    const spec = step.join as Row & JoinOptions;
    return join(list, spec.with as unknown, spec);
  }
  throw new Error(
    "INVALID_INPUT: site.pipe step must be one of call, from, map, filter, join, dedupe, sort, limit, pick, flat, to; got " +
      JSON.stringify(Object.keys(step)),
  );
}

// The live viewer sink of site.pipe ({to: {view}}): only a loopback push URL, so a pipe can never
// send rows to another machine.
export function pipeViewTarget(view: unknown): {
  url: string;
  token: string | undefined;
  title: string | undefined;
} {
  const spec = (typeof view === "string" ? { url: view } : (view ?? {})) as Row;
  let parsed: URL;
  try {
    parsed = new URL(String(spec.url ?? ""));
  } catch {
    throw new Error(
      "INVALID_INPUT: site.pipe {to: {view}} needs a push URL like http://127.0.0.1:<port>/push",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "http:" || !loopback || parsed.username || parsed.password)
    throw new Error(
      "INVALID_INPUT: site.pipe views must be http://127.0.0.1 or http://localhost, not " +
        parsed.origin,
    );
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/push";
  return {
    url: parsed.href,
    token: typeof spec.token === "string" ? spec.token : undefined,
    title: typeof spec.title === "string" ? spec.title : undefined,
  };
}
