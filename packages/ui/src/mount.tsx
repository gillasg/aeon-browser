import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const roots = new WeakMap<Element, Root>();

export function mountAeonUi(rootElement: Element, view: ReactNode): (next: ReactNode) => void {
  if (roots.has(rootElement)) throw new Error("This Aeon UI host already has a React root.");
  const root = createRoot(rootElement);
  roots.set(rootElement, root);
  root.render(createElement(HostRoot, { children: view }));
  return (next) => root.render(createElement(HostRoot, { children: next }));
}

function HostRoot({ children }: { children: ReactNode }) {
  return <div data-aeon-root="true">{children}</div>;
}
