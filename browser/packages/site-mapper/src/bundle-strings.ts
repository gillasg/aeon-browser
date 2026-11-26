// Helpers for reading a parsed bundle without running it: a node walker, string collapsing
// ("/u/" + id + "/posts" and `/u/${id}` become "/u/EXPR/posts"), the cheap URL gate, and the
// conversion of a collapsed string into a route template.

export type Node = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
} & Record<string, unknown>;

export const EXPR = "EXPR";

/** Visits every node depth first; the callback sees each node with its parent. */
export function walk(root: Node, visit: (node: Node, parent: Node | undefined) => void): void {
  const stack: [Node, Node | undefined][] = [[root, undefined]];
  while (stack.length) {
    const [node, parent] = stack.pop() as [Node, Node | undefined];
    visit(node, parent);
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--)
          if (isNode(value[i])) stack.push([value[i], node]);
      } else if (isNode(value)) stack.push([value, node]);
    }
  }
}

export function isNode(value: unknown): value is Node {
  return Boolean(value && typeof value === "object" && typeof (value as Node).type === "string");
}

/** Constant strings bound once in the file: `const API = "/api"`. */
export function constants(root: Node): Map<string, string> {
  const found = new Map<string, string>();
  walk(root, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = node.id as Node | undefined;
    const init = node.init as Node | undefined;
    if (id?.type === "Identifier" && init?.type === "Literal" && typeof init.value === "string")
      found.set(String(id.name), init.value);
  });
  return found;
}

/** A string-ish expression as text with EXPR for every unknown part, or undefined. */
export function collapse(
  node: unknown,
  names: Map<string, string> = new Map(),
): string | undefined {
  const parts = collapseParts(node, names);
  return parts && parts.replaceAll(EXPR, "").length > 0 ? parts : undefined;
}

function collapseParts(node: unknown, names: Map<string, string>): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
  if (node.type === "TemplateLiteral") {
    const quasis = (node.quasis as Node[]).map((quasi) =>
      String((quasi.value as { cooked?: string }).cooked ?? ""),
    );
    return quasis.join(EXPR);
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = collapseParts(node.left, names);
    const right = collapseParts(node.right, names);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? EXPR) + (right ?? EXPR);
  }
  if (node.type === "Identifier") return names.get(String(node.name));
  return undefined;
}

const BAD = /[ ()!<>'"`{}^$,\\]/;

/** The cheap gate: does a collapsed string look like a URL or a path at all? */
export function maybeUrl(value: string): boolean {
  if (value.length < 2 || value.length > 2_000 || BAD.test(value)) return false;
  if (!/[/?.]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("/*") && /[a-z]/i.test(value);
  try {
    const url = new URL(value.replaceAll(EXPR, "x"));
    return /^https?:$/.test(url.protocol) && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/** "/u/EXPR/posts?page=EXPR" → { template: "/u/{param}/posts", query: ["page"] }. */
export function toTemplate(value: string): { template: string; query: string[] } {
  const [path = "", search = ""] = value.split("?", 2);
  let index = 0;
  const template = path
    .replace(/:([A-Za-z_][\w]*)/g, "{$1}")
    .replace(/\[(?:\.\.\.)?([A-Za-z_]\w*)\]/g, "{$1}")
    .replace(new RegExp(EXPR, "g"), () => (index++ ? `{param${index}}` : "{param}"));
  const query = search
    .split("&")
    .map((pair) => pair.split("=")[0] ?? "")
    .filter((key) => key && key !== EXPR && /^[\w.[\]-]+$/.test(key));
  return { template, query };
}

/** The property keys of an object literal, quoted or not. */
export function objectKeys(node: unknown): string[] {
  if (!isNode(node) || node.type !== "ObjectExpression") return [];
  return (node.properties as Node[])
    .map((prop) => propertyName(prop))
    .filter((key): key is string => Boolean(key));
}

export function propertyName(prop: Node): string | undefined {
  if (prop.type !== "Property") return undefined;
  const key = prop.key as Node;
  if (key.type === "Identifier" && !prop.computed) return String(key.name);
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

/** One property's value node in an object literal. */
export function property(node: unknown, name: string): Node | undefined {
  if (!isNode(node) || node.type !== "ObjectExpression") return undefined;
  const found = (node.properties as Node[]).find((prop) => propertyName(prop) === name);
  return found?.value as Node | undefined;
}

/** `a.b.c` as "a.b.c" for identifiers and static members; undefined for anything dynamic. */
export function memberPath(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "ThisExpression") return "this";
  if (node.type !== "MemberExpression") return undefined;
  const object = memberPath(node.object);
  const prop = node.property as Node;
  const name =
    !node.computed && prop.type === "Identifier"
      ? String(prop.name)
      : prop.type === "Literal"
        ? String(prop.value)
        : undefined;
  return object && name ? `${object}.${name}` : undefined;
}
