import type { ReactElement } from "react";
import type { ComposerControls } from "./chat-composer.js";
// Pi remains authoritative for queue order and lifecycle, as in PiStudio.
export function PiQueue({ controls }: { controls: ComposerControls | null }): ReactElement | null {
  const items = [
    ...(controls?.steeringQueue ?? []).map((text) => ({ text, mode: "Steer" })),
    ...(controls?.followUpQueue ?? []).map((text) => ({ text, mode: "Queued" })),
  ];
  if (!items.length) return null;
  return (
    <section className="composer-queue-list" aria-label="Queued messages" aria-live="polite">
      {items.map((item, index) => (
        <div className="composer-queue-item" key={index}>
          <span className="composer-queue-copy">
            <span aria-hidden="true">↳</span>
            <span>{item.text}</span>
          </span>
          <span className="composer-queue-mode">{item.mode}</span>
        </div>
      ))}
    </section>
  );
}
