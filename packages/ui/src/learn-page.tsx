import { useState, type ReactElement } from "react";
import { LEARN_ITEMS, LEARN_TOPICS, type LearnItem, type LearnTopic } from "./learn-catalog.js";
import { Segmented } from "./segmented.js";

// Learn: everything Aeon can do, as grouped lists by topic, each row with an example. "Try it"
// puts the example in Home's ask box, so nothing runs until the user sends it.

export function LearnPage({ onTry }: { onTry(example: string): void }): ReactElement {
  const [topic, setTopic] = useState<LearnTopic | "all">("all");
  const groups = LEARN_TOPICS.flatMap(([id, label]) =>
    id !== "all" && (topic === "all" || topic === id)
      ? [{ id, label, items: LEARN_ITEMS.filter((item) => item.topic === id) }]
      : [],
  );
  return (
    <div className="aeon-page learn-page">
      <header className="aeon-page-head">
        <h1 id="learn-heading">Learn</h1>
        <Segmented<LearnTopic | "all">
          label="Topics"
          value={topic}
          options={LEARN_TOPICS}
          onChange={setTopic}
        />
      </header>
      {groups.map((group) => (
        <section key={group.id} className="settings-group learn-group">
          <h2>{group.label}</h2>
          <ul className="aeon-list">
            {group.items.map((item) => (
              <LearnRow key={item.title} item={item} onTry={onTry} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LearnRow({
  item,
  onTry,
}: {
  item: LearnItem;
  onTry(example: string): void;
}): ReactElement {
  return (
    <li className="learn-row">
      <span className="learn-text">
        <strong>{item.title}</strong>
        <span>{item.body}</span>
        <small>“{item.example.trim()}”</small>
      </span>
      <button type="button" className="aeon-button" onClick={() => onTry(item.example)}>
        Try it
      </button>
    </li>
  );
}

/** Home's ask box listens for this event once it is on screen. */
export function seedHomeQuery(text: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("aeon.home.seed", { detail: text })),
    ),
  );
}
