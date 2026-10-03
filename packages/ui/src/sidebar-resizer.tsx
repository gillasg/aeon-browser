import { useEffect, useState, type ReactElement } from "react";

export function SidebarResizer(props: { open: boolean; onCollapse(): void }): ReactElement | null {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("aeon-sidebar-width"));
    return saved >= 180 && saved <= 480 ? saved : 264;
  });
  useEffect(() => {
    document.documentElement.style.setProperty("--aeon-sidebar-width", width + "px");
    localStorage.setItem("aeon-sidebar-width", String(width));
  }, [width]);
  if (!props.open) return null;
  const resize = (value: number): void => {
    if (value < 180) { props.onCollapse(); return; }
    setWidth(Math.max(180, Math.min(value, 480, window.innerWidth - 100)));
  };
  return <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar"
    aria-orientation="vertical" aria-valuemin={180} aria-valuemax={480} aria-valuenow={width}
    tabIndex={0} style={{ left: width - 4 }}
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? -16 : 16));
      }
    }} />;
}
