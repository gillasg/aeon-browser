// Role and name, then a CSS path, then visible text. A CSS path that lands on a different
// name is the wrong control and is not used.

import type { PageControl, TargetWithFallbacks } from "./types.js";

export function matchControl(
  target: TargetWithFallbacks,
  controls: readonly PageControl[],
): PageControl | undefined {
  if (target.role && target.name) {
    const byRole = controls.filter(
      (control) => same(control.role, target.role) && same(control.name, target.name),
    );
    if (byRole.length === 1) return byRole[0];
  }
  const byCss = cssHit(target, controls);
  if (byCss) return byCss;
  if (!target.text) return undefined;
  const byText = controls.filter(
    (control) => same(control.text, target.text) || same(control.name, target.text),
  );
  return byText.length === 1 ? byText[0] : undefined;
}

function cssHit(
  target: TargetWithFallbacks,
  controls: readonly PageControl[],
): PageControl | undefined {
  if (!target.css) return undefined;
  const hits = controls.filter((control) => control.css === target.css);
  const hit = hits.length === 1 ? hits[0] : undefined;
  if (!hit || !nameAgrees(target, hit)) return undefined;
  return hit;
}

function nameAgrees(target: TargetWithFallbacks, control: PageControl): boolean {
  if (!target.name) return true;
  return same(control.name, target.name) || same(control.text, target.name);
}

function same(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
