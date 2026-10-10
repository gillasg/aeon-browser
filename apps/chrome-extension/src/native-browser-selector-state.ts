export function selectorState(selector: string, state: string): boolean {
  const elements = [...document.querySelectorAll(selector)];
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      (box.width > 0 &&
        box.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none") ||
      ((el === document.body || style.display === "contents") &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        [...el.children].some((child) => {
          const rect = child.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }))
    );
  };
  if (state === "attached") return elements.length > 0;
  if (state === "hidden") return elements.every((el) => !visible(el));
  return elements.some(
    (el) =>
      visible(el) &&
      (state !== "editable" ||
        (!el.matches(":disabled,[aria-disabled='true']") &&
          (el.matches("input:not([readonly]),textarea:not([readonly])") ||
            (el as HTMLElement).isContentEditable))),
  );
}
