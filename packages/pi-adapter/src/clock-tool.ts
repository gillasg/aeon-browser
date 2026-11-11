import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

// Models do not know today's date and guess from their training data; search results for "today's
// date" are cached pages and just as wrong. Core runs on the user's machine, so its clock and time
// zone are the user's. One cheap tool call answers "tomorrow", "this week" and "next Friday".
export function createClockTool(now: () => Date = () => new Date()): ReturnType<typeof defineTool> {
  return defineTool({
    name: "current_time",
    label: "Current time",
    description:
      "The user's local date, weekday, time and time zone. The first turn and each cell footer already include them; call this only when a later turn needs a fresh clock.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: () => {
      const date = now();
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = -date.getTimezoneOffset();
      const sign = offset >= 0 ? "+" : "-";
      const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
      const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
      const local = date.toLocaleString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: zone,
      });
      const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(date);
      const text = `${local} (${zone}, UTC${sign}${hours}:${minutes}). ISO date: ${isoDate}.`;
      return Promise.resolve({ content: [{ type: "text", text }], details: undefined });
    },
  });
}
