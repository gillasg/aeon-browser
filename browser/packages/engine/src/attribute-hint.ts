// A locator that misses should name the control that almost matched, by the attribute it
// actually has. The scan runs in the page; the message is built here so a test can pin it.

export interface AttributeHit {
  tag: string;
  role: string;
  placeholder: string;
  label: string;
  text: string;
}

export interface AttributeQuery {
  by: string;
  value: string;
}

/** Page function. Self-contained: Runtime.evaluate runs its source in the page. */
export function collectAttributeHits(): AttributeHit[] {
  const roots: (Document | ShadowRoot | Element)[] = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) continue;
    for (const element of root.querySelectorAll("input, textarea, select, button, a, [role]")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const hits: AttributeHit[] = [];
  for (const el of elements) {
    const control = el as HTMLInputElement;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const labelled = ids
      .map((id) =>
        el.getRootNode() instanceof Document
          ? (document.getElementById(id)?.textContent ?? "")
          : "",
      )
      .join(" ");
    const label = (
      el.getAttribute("aria-label") ||
      labelled ||
      [...(control.labels ?? [])].map((item) => item.textContent ?? "").join(" ")
    )
      .replace(/\s+/g, " ")
      .trim();
    const text = ((el as HTMLElement).innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const placeholder = (el.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim();
    const role = (el.getAttribute("role") || el.tagName || "").toLowerCase();
    if (!label && !placeholder && !text) continue;
    hits.push({
      tag: el.tagName.toLowerCase(),
      role,
      placeholder,
      label,
      text,
    });
    if (hits.length >= 40) break;
  }
  return hits;
}

export function missMessage(query: AttributeQuery, hits: readonly AttributeHit[]): string {
  const wanted = wantedText(query);
  const sought = soughtOf(query, wanted);
  const head = `no ${sought} ${JSON.stringify(wanted)}`;
  const hit = nearest(wanted, hits);
  return hit ? `${head}; ${hit.where}: use ${hit.use}` : head;
}

function wantedText(query: AttributeQuery): string {
  if (query.by !== "css") return query.value;
  const match = /\[(?:placeholder|aria-label|name)\s*=\s*['"]?([^'"\]]+)['"]?\]/i.exec(query.value);
  return (match?.[1] ?? query.value).trim();
}

function soughtOf(query: AttributeQuery, wanted: string): string {
  if (
    query.by === "placeholder" ||
    query.by === "label" ||
    query.by === "text" ||
    query.by === "role"
  )
    return query.by;
  if (query.by === "css") {
    const attr = /\[(placeholder|aria-label)\s*=/i.exec(query.value);
    if (attr?.[1]?.toLowerCase() === "placeholder") return "placeholder";
    if (attr?.[1]?.toLowerCase() === "aria-label") return "label";
  }
  return wanted === query.value ? `element matching` : "element matching";
}

function nearest(
  wanted: string,
  hits: readonly AttributeHit[],
): { where: string; use: string } | undefined {
  const needle = wanted.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return undefined;
  let best: { score: number; where: string; use: string } | undefined;
  for (const hit of hits) {
    const options = [
      hint(hit, "label", hit.label, needle),
      hint(hit, "placeholder", hit.placeholder, needle),
      hint(hit, "text", hit.text, needle),
    ];
    for (const option of options) {
      if (!option) continue;
      if (!best || option.score > best.score) best = option;
    }
  }
  return best ? { where: best.where, use: best.use } : undefined;
}

function hint(
  hit: AttributeHit,
  kind: "label" | "placeholder" | "text",
  value: string,
  needle: string,
): { score: number; where: string; use: string } | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const score = lower === needle ? 3 : lower.includes(needle) || needle.includes(lower) ? 2 : 0;
  if (!score) return undefined;
  const noun =
    hit.tag === "input" || hit.tag === "textarea" || hit.tag === "select"
      ? "an input"
      : `a ${hit.tag || "element"}`;
  if (kind === "label") {
    return {
      score: score + 1,
      where: `${noun} has aria-label ${JSON.stringify(text)}`,
      use: `getByLabel(${JSON.stringify(text)})`,
    };
  }
  if (kind === "placeholder") {
    return {
      score,
      where: `${noun} has placeholder ${JSON.stringify(text)}`,
      use: `getByPlaceholder(${JSON.stringify(text)})`,
    };
  }
  const role =
    hit.role === "button" || hit.tag === "button"
      ? "button"
      : hit.role === "a" || hit.tag === "a"
        ? "link"
        : hit.role || noun;
  return {
    score: score - 1,
    where: `a ${role} has text ${JSON.stringify(text)}`,
    use: `getByRole(${JSON.stringify(role)}, {name: ${JSON.stringify(text)}})`,
  };
}
