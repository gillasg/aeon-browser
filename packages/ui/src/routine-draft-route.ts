// A routine draft passed in the page URL (`?view=routines&routineDraft={...}`), so other surfaces
// (the orb's Watch) can open the routine editor prefilled. The user still reviews and saves it.

export interface RoutineDraftSeed {
  chatId: string;
  title: string;
  instruction: string;
  everyMinutes: number;
}

const PARAM = "routineDraft";

export function readRoutineDraft(
  search = globalThis.location?.search ?? "",
): RoutineDraftSeed | undefined {
  const raw = new URLSearchParams(search).get(PARAM);
  if (!raw) return undefined;
  try {
    return parseSeed(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/** Drops the draft from the address bar so a reload doesn't reopen the editor. */
export function forgetRoutineDraft(): void {
  const location = globalThis.location;
  if (!location || !new URLSearchParams(location.search).has(PARAM)) return;
  const url = new URL(location.href);
  url.searchParams.delete(PARAM);
  globalThis.history?.replaceState(globalThis.history.state, "", url.href);
}

function parseSeed(value: unknown): RoutineDraftSeed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { chatId, title, instruction, everyMinutes } = value as Record<string, unknown>;
  if (!text(chatId, 200) || !text(title, 120) || !text(instruction, 20_000)) return undefined;
  const minutes = Number.isInteger(everyMinutes) ? (everyMinutes as number) : 15;
  return { chatId, title, instruction, everyMinutes: Math.min(10_080, Math.max(5, minutes)) };
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
