import { NativeFilmRequestSchema, type FilmAction } from "@aeon/protocol";
import { FILM_ARMED_KEY, FILM_BEATS_KEY } from "./orb/orb-film.js";

// `aeon record`'s beat bus, answered from the worker: only extension contexts can reach
// chrome.storage.session, where the orb writes its story beats while a take is armed.
type SessionStore = Pick<chrome.storage.StorageArea, "get" | "set">;

export function handleFilmMessage(
  candidate: unknown,
  socket: Pick<WebSocket, "send">,
  store: SessionStore = chrome.storage.session,
): boolean {
  const request = NativeFilmRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, action } = request.data;
  void applyFilm(store, action)
    .catch(() => ({ ok: false, beats: [] }))
    .then((reply) =>
      socket.send(JSON.stringify({ kind: "native.film.result", requestId, ...reply })),
    );
  return true;
}

export async function applyFilm(
  store: SessionStore,
  action: FilmAction,
): Promise<{ ok: boolean; beats: Record<string, unknown>[] }> {
  if (action === "arm") await store.set({ [FILM_ARMED_KEY]: true, [FILM_BEATS_KEY]: [] });
  if (action === "disarm") await store.set({ [FILM_ARMED_KEY]: false });
  if (action === "clear") await store.set({ [FILM_BEATS_KEY]: [] });
  if (action !== "read") return { ok: true, beats: [] };
  const value = await store.get(FILM_BEATS_KEY);
  const rows = value[FILM_BEATS_KEY];
  return { ok: true, beats: Array.isArray(rows) ? rows.filter(isRow).slice(-5000) : [] };
}

const isRow = (row: unknown): row is Record<string, unknown> =>
  typeof row === "object" && row !== null && !Array.isArray(row);
