// A steps way keeps, per step, a role and name, a CSS path and the visible text. Replay tries
// them in that order and never acts when the match is a different control.

export interface FallbackTarget {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface PageControl {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export function matchControl(
  target: FallbackTarget,
  controls: readonly PageControl[],
): PageControl | undefined {
  if (target.role && target.name) {
    const byRole = controls.filter(
      (control) => same(control.role, target.role) && same(control.name, target.name),
    );
    if (byRole.length === 1) return byRole[0];
  }
  if (target.css) {
    const byCss = controls.filter((control) => control.css === target.css);
    const hit = byCss.length === 1 ? byCss[0] : undefined;
    if (hit && nameAgrees(target, hit)) return hit;
  }
  if (target.text) {
    const byText = controls.filter(
      (control) => same(control.text, target.text) || same(control.name, target.text),
    );
    if (byText.length === 1) return byText[0];
  }
  return undefined;
}

function nameAgrees(target: FallbackTarget, control: PageControl): boolean {
  if (!target.name) return true;
  return same(control.name, target.name) || same(control.text, target.name);
}

function same(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
