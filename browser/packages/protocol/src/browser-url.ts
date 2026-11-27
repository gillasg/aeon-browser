import { z } from "zod";

// A URL a step may open or navigate to. The schema lets extension and chrome:// URLs through so
// the engine can answer each one: Graft's own pages open, and any other extension's or Chrome's
// page is refused there with PROTECTED_UI (not a schema error).
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "chrome-extension:", "chrome:"]);

export const OpenUrlSchema = z
  .string()
  .url()
  .max(8192)
  .refine((value) => value === "about:blank" || OPENABLE_PROTOCOLS.has(new URL(value).protocol));
